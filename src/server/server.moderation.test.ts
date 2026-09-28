// Integration (moderation): the real server (real AuthService, real word filter, SQLite moderation store, ws) with the
// Sim / AI mocked, on a spare port + temp DB. Chat filtering online, the chat log, moderator commands (denied without
// a leak for everyone else), live kicks on a ban, bans at hello / login / register, strikes → auto-mute, reports,
// CLI changes picked up by the running server, and the admin HTTP API. Every client here is 127.0.0.1 (one
// "network"), like a classroom behind one NAT.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TERM_GROUPS, rot13 } from '../shared/moderation/lists';
import { MSG_BLOCKED } from '../shared/room/moderation';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/version';
import { runCli } from './moderation/cliCore';

vi.mock('../shared/sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in server.moderation.test'); } } }));
vi.mock('../shared/ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

// Test words come from the filter's own lists (stored ROT13 there), so this file holds no slurs in clear text.
const BLOCK = rot13(TERM_GROUPS.find((g) => g.tier === 'block' && g.mode === 'strong')!.terms[0]!);
const MASK = rot13(TERM_GROUPS.find((g) => g.tier === 'mask' && g.mode === 'strong')!.terms[0]!);

const port = 17000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'voidswarm-modsrv-'));
const dbPath = path.join(dir, 'mod.db');

async function post(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown>, headers: r.headers };
}
const admin = (p: string, token: string, body: unknown = {}): ReturnType<typeof post> => post(`/api/admin/${p}`, body, { Authorization: `Bearer ${token}` });

interface Client {
  ws: WebSocket; msgs: ServerMsg[]; closeCode: number | null; closeReason: string;
  send(m: ClientMsg): void;
  wait(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
  system(): string[];
  waitSystem(re: RegExp, ms?: number): Promise<string>;
}

function client(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c: Client = {
      ws, msgs: [], closeCode: null, closeReason: '',
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (pred, ms = 4000) => new Promise((res, rej) => {
        const found = c.msgs.find(pred);
        if (found) { res(found); return; }
        const t = setTimeout(() => { ws.off('message', on); rej(new Error('timeout; got ' + c.msgs.map((m) => m.type === 'chat' ? `chat:${m.line.text}` : m.type).join(' | '))); }, ms);
        const on = (): void => { const f = c.msgs.find(pred); if (f) { clearTimeout(t); ws.off('message', on); res(f); } };
        ws.on('message', on);
      }),
      system: () => c.msgs.filter((m): m is Extract<ServerMsg, { type: 'chat' }> => m.type === 'chat' && m.line.channel === 'system').map((m) => m.line.text),
      waitSystem: async (re, ms) => {
        const m = await c.wait((x) => x.type === 'chat' && x.line.channel === 'system' && re.test(x.line.text), ms) as Extract<ServerMsg, { type: 'chat' }>;
        return m.line.text;
      },
    };
    ws.on('message', (d, bin) => { if (!bin) c.msgs.push(JSON.parse(d.toString())); });
    ws.on('close', (code, reason) => { c.closeCode = code; c.closeReason = reason.toString(); });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const hello = (name: string, token?: string): ClientMsg => ({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token });
const say = (c: Client, text: string): void => c.send({ type: 'chat', channel: 'all', text });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function closed(c: Client, ms = 6000): Promise<number | null> {
  for (let i = 0; i < ms / 25 && c.closeCode === null; i++) await sleep(25);
  return c.closeCode;
}

async function connect(name: string, token?: string): Promise<Client> {
  const c = await client();
  c.send(hello(name, token));
  await c.wait((m) => m.type === 'chatHistory');
  return c;
}

const cli = (args: string[]): Promise<number> => runCli(args, { out: () => {}, err: () => {}, env: { DB_PATH: dbPath } });

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
}

const tokens: Record<string, string> = {};

beforeAll(async () => {
  process.env.PORT = String(port);
  process.env.DB_PATH = dbPath;
  process.env.PUBLIC_URL = base;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('./index');
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(50);
  }
  for (const u of ['Teach', 'Kiddo', 'Pal']) {
    const r = await post('/api/register', { username: u, email: `${u.toLowerCase()}@example.com`, password: 'correct-horse-9' });
    expect(r.status).toBe(200);
    tokens[u] = String(r.json.token);
  }
  expect(await cli(['promote', 'Teach'])).toBe(0);
}, 30_000);

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* db may still be open on Windows */ }
});

let teach: Client;
let kiddo: Client;
let pal: Client;

/** The server picks up the CLI promote within its poll interval (2 s). */
async function waitModerator(c: Client): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const n = c.msgs.length;
    say(c, '/modhelp');
    const m = await c.wait((x) => c.msgs.indexOf(x) >= n && x.type === 'chat' && x.line.channel === 'system'
      && /Moderator commands|Unknown command \/modhelp/.test(x.line.text)) as Extract<ServerMsg, { type: 'chat' }>;
    if (/Moderator commands/.test(m.line.text)) return;
    await sleep(1100); // the chat budget is 5 lines / 5 s
  }
  throw new Error('never became a moderator');
}

describe('moderation on the real server', () => {
  it('the filter runs online: blocked lines reach nobody, masked lines are starred, everything is logged', async () => {
    teach = await connect('', tokens.Teach);
    kiddo = await connect('', tokens.Kiddo);
    pal = await connect('', tokens.Pal);
    say(kiddo, `you ${BLOCK}`);
    await kiddo.waitSystem(new RegExp(MSG_BLOCKED.replace(/[.()]/g, '\\$&')));
    say(kiddo, `oh ${MASK} it`);
    const masked = await teach.wait((m) => m.type === 'chat' && m.line.fromName === 'Kiddo') as Extract<ServerMsg, { type: 'chat' }>;
    expect(masked.line.text).toContain('*');
    expect(masked.line.text.toLowerCase()).not.toContain(MASK);
    expect(teach.msgs.some((m) => m.type === 'chat' && m.line.text.toLowerCase().includes(BLOCK))).toBe(false);
    say(kiddo, 'good game everyone');
    await teach.wait((m) => m.type === 'chat' && m.line.text === 'good game everyone');
    await sleep(1300); // the chat log is flushed every second
    const log = rows<{ name: string; action: string; account_id: string | null; address: string; room_id: string | null }>(
      "SELECT name, action, account_id, address, room_id FROM chat_log WHERE name = 'Kiddo' ORDER BY id");
    expect(log.map((r) => r.action)).toEqual(['block', 'mask', 'pass']);
    expect(log[0]).toMatchObject({ address: '127.0.0.1', room_id: null });
    expect(log[0]!.account_id).toBeTruthy();
    // account usernames go through the name filter at registration
    const reg = await post('/api/register', { username: `${MASK}Pilot`.slice(0, 16), email: 'bad@example.com', password: 'correct-horse-9' });
    expect(reg.status).toBe(400);
    expect(reg.json.error).toBe("That username isn't allowed — pick another.");
  }, 20_000);

  it('moderator commands: unknown to everyone else; a /ban kicks at once and is enforced at hello and login', async () => {
    await waitModerator(teach);
    say(kiddo, '/ban Teach 1d nope');
    expect(await kiddo.waitSystem(/Unknown command \/ban/)).toBe('Unknown command /ban — try /help');
    say(teach, '/ban Kiddo 1h being rude');
    const err = await kiddo.wait((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>;
    expect(err.message).toMatch(/^You are banned until .+: being rude$/);
    expect(await closed(kiddo)).toBe(4001);
    expect(await teach.waitSystem(/^Banned Kiddo until/)).toMatch(/disconnected 1 connection/);
    // reconnecting with the session: refused before the zone greets it
    const again = await client();
    again.send(hello('', tokens.Kiddo));
    const e2 = await again.wait((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>;
    expect(e2.message).toMatch(/^You are banned until .+: being rude$/);
    expect(await closed(again)).toBe(4001);
    expect(again.msgs.some((m) => m.type === 'welcome')).toBe(false);
    // login refused with one generic answer (only after the password is proven)
    const bad = await post('/api/login', { login: 'kiddo', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    const login = await post('/api/login', { login: 'kiddo', password: 'correct-horse-9' });
    expect(login.status).toBe(403);
    expect(login.json.error).toBe("This account can't sign in right now.");
    say(teach, '/unban Kiddo');
    await teach.waitSystem(/^Lifted 1 ban for Kiddo/);
    const ok = await post('/api/login', { login: 'kiddo', password: 'correct-horse-9' });
    expect(ok.status).toBe(200);
    tokens.Kiddo = String(ok.json.token);
    kiddo = await connect('', tokens.Kiddo);
    expect(kiddo.msgs.find((m) => m.type === 'welcome')).toMatchObject({ name: 'Kiddo' });
  }, 30_000);

  it('three blocked lines auto-mute a pilot for 10 minutes; moderators are told', async () => {
    say(pal, `${BLOCK} one`);
    say(pal, `two ${BLOCK}`);
    say(pal, `three ${BLOCK} three`);
    expect(await pal.waitSystem(/^You are muted for 10 minutes/)).toBe('You are muted for 10 minutes (repeated blocked language).');
    await teach.waitSystem(/Auto-muted Pal for 10 minutes/);
    say(pal, 'can I talk now');
    expect(await pal.waitSystem(/^You are muted until /)).toMatch(/Automatic: repeated blocked language\.$/);
    expect(teach.msgs.some((m) => m.type === 'chat' && m.line.text === 'can I talk now')).toBe(false);
    const mutes = rows<{ by: string; scope: string }>("SELECT by, scope FROM bans WHERE kind = 'mute'");
    expect(mutes).toEqual([{ by: 'system', scope: 'account' }]);
  }, 20_000);

  it('/report files the target\'s recent chat and pings moderators', async () => {
    const guest = await connect('Wanderer');
    say(guest, '/report Pal saying awful things');
    expect(await guest.waitSystem(/Report sent/)).toBe('Report sent — thank you.');
    const note = await teach.waitSystem(/New report #\d+: Wanderer reported Pal/);
    const id = Number(/#(\d+)/.exec(note)![1]);
    const [rep] = rows<{ target_account_id: string; recent_chat_json: string; reporter_account_id: string | null }>('SELECT * FROM reports WHERE id = ?', id);
    expect(rep!.reporter_account_id).toBeNull();
    expect(rep!.target_account_id).toBeTruthy();
    const recent = JSON.parse(rep!.recent_chat_json) as { original: string; action: string }[];
    expect(recent.map((r) => r.action)).toEqual(['block', 'block', 'block', 'muted']);
    await sleep(1100);
    say(teach, '/reports');
    await teach.waitSystem(new RegExp(`^#${id} .*Wanderer → Pal: saying awful things`));
    guest.ws.close();
  }, 20_000);

  it('a ban from the CLI reaches the running server within seconds and disconnects the pilot', async () => {
    expect(await cli(['ban', 'Pal', '1h', 'banned from the console'])).toBe(0);
    const err = await pal.wait((m) => m.type === 'error', 8000) as Extract<ServerMsg, { type: 'error' }>;
    expect(err.message).toMatch(/banned from the console$/);
    expect(await closed(pal)).toBe(4001);
    expect(await cli(['unban', 'Pal'])).toBe(0);
    const actions = rows<{ actor_account_id: string; action: string }>("SELECT actor_account_id, action FROM mod_actions WHERE actor_account_id = 'cli' ORDER BY id");
    expect(actions.map((a) => a.action)).toEqual(['promote', 'ban', 'unban']);
  }, 20_000);

  it('/ipban bans the whole address after /confirm, spares the moderator, and blocks registration from it', async () => {
    const gremlin = await connect('Gremlin');
    const buddy = await connect('Buddy');
    await sleep(1100);
    say(teach, '/ipban Gremlin 10m trolling');
    await teach.waitSystem(/share that network address|shares that network address/);
    await teach.waitSystem(/Type \/confirm within 60 s/);
    expect(gremlin.closeCode).toBeNull();
    say(teach, '/confirm');
    await teach.waitSystem(/^Banned the network of Gremlin until/);
    expect(await closed(gremlin)).toBe(4001);
    expect(await closed(buddy)).toBe(4001);
    expect(await closed(kiddo)).toBe(4001); // Kiddo (an account) shares 127.0.0.1 too
    expect(teach.closeCode).toBeNull();
    teach.send({ type: 'ping', t: 7 });
    await teach.wait((m) => m.type === 'pong' && m.t === 7);
    const reg = await post('/api/register', { username: 'Sneaky', email: 'sneaky@example.com', password: 'correct-horse-9' });
    expect(reg.status).toBe(403);
    expect(reg.json.error).toBe("Accounts can't be created from your network right now.");
    const g2 = await client();
    g2.send(hello('Gremlin2'));
    expect(((await g2.wait((m) => m.type === 'error')) as Extract<ServerMsg, { type: 'error' }>).message).toMatch(/^You are banned until .+: trolling$/);
    await sleep(1100);
    say(teach, '/unban 127.0.0.1');
    await teach.waitSystem(/^Lifted 1 ban for 127\.0\.0\.1/);
  }, 30_000);

  it('admin HTTP API: moderators only, audited, CORS preflight allows Authorization; the dashboard is served', async () => {
    const pre = await fetch(`${base}/api/admin/me`, { method: 'OPTIONS', headers: { Origin: base, 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect((await post('/api/admin/me', {})).status).toBe(401);
    expect((await admin('me', tokens.Pal!)).status).toBe(403);
    expect((await admin('me', tokens.Pal!)).json.error).toBe('Not a moderator');
    const me = await admin('me', tokens.Teach!);
    expect(me.status).toBe(200);
    expect(me.json.admin).toMatchObject({ username: 'Teach' });
    const log = await admin('log', tokens.Teach!, { player: 'kiddo', action: 'flagged' });
    expect(log.status).toBe(200);
    expect((log.json.lines as { action: string }[]).map((l) => l.action)).toEqual(['mask', 'block']);
    const online = await admin('online', tokens.Teach!);
    expect((online.json.players as { name: string; admin: boolean }[]).find((p) => p.name === 'Teach')?.admin).toBe(true);
    const mute = await admin('bans/create', tokens.Teach!, { kind: 'mute', target: 'Kiddo', duration: '10m', reason: 'api test' });
    expect(mute.status).toBe(200);
    const banId = (mute.json.ban as { id: number; scope: string }).id;
    expect((mute.json.ban as { scope: string }).scope).toBe('account');
    const list = await admin('bans', tokens.Teach!, { kind: 'mute' });
    expect((list.json.bans as { id: number }[]).some((b) => b.id === banId)).toBe(true);
    expect((await admin('bans/revoke', tokens.Teach!, { id: banId })).json).toEqual({ ok: true, revoked: 1 });
    const who = await admin('whois', tokens.Teach!, { target: 'Kiddo' });
    expect(who.status).toBe(200);
    expect((who.json.whois as { account: { username: string } }).account.username).toBe('Kiddo');
    expect((await admin('whois', tokens.Teach!, { target: 'NobodyAtAll' })).status).toBe(404);
    const reports = await admin('reports', tokens.Teach!, { status: 'open' });
    const rep = (reports.json.reports as { id: number; target: { name: string } }[])[0]!;
    expect(rep.target.name).toBe('Pal');
    const rv = await admin('reports/review', tokens.Teach!, { id: rep.id, status: 'reviewed', note: 'handled' });
    expect((rv.json.report as { status: string }).status).toBe('reviewed');
    const acts = await admin('actions', tokens.Teach!, { limit: 200 });
    const kinds = (acts.json.actions as { action: string; reason: string }[]);
    expect(kinds.some((a) => a.action === 'note' && a.reason.startsWith('api log'))).toBe(true);
    expect(kinds.some((a) => a.action === 'mute' && a.reason === 'api test')).toBe(true);
    expect(kinds.some((a) => a.action === 'unmute')).toBe(true);
    // same rules as the accounts API
    const txt = await fetch(`${base}/api/admin/me`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${tokens.Teach}` }, body: '{}' });
    expect(txt.status).toBe(415);
    expect((await fetch(`${base}/api/admin/me`)).status).toBe(405);
    expect((await admin('nope', tokens.Teach!)).status).toBe(404);
    const evil = await post('/api/admin/me', {}, { Authorization: `Bearer ${tokens.Teach}`, Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    // dashboard: served by this Node server only, strict CSP (no inline script / style), never cached or framed
    for (const p of ['/admin', '/admin/', '/admin/admin.js', '/admin/admin.css']) {
      const page = await fetch(`${base}${p}`);
      expect(page.status, p).toBe(200);
      const csp = page.headers.get('content-security-policy') ?? '';
      for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'"]) expect(csp, p).toContain(d);
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      await page.arrayBuffer();
    }
    expect((await fetch(`${base}/admin`)).headers.get('content-type')).toMatch(/text\/html/);
    expect((await fetch(`${base}/admin/admin.test.ts`)).status).toBe(404);
    expect((await fetch(`${base}/admin/..%2f..%2findex.ts`)).status).toBe(404);
    expect((await fetch(`${base}/admin`, { method: 'POST' })).status).toBe(405);
  }, 30_000);
});
