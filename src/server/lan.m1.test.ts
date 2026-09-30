// The LAN edition's M1 gate, in process (docs/LAN-EDITION-proposal.md §14 M1): startServer in LAN mode with the
// Host Control Panel on an ephemeral admin port and the maintenance worker, then everything the owner does by hand:
// first-run setup with the launcher's code, sign-in, a custom term added through the API, a player account and a
// guest chatting (a normal line, a line with the custom term, a normal line), Live showing them with times and tags,
// the other client seeing a friendly stand-in under the sender's name, the sender's generic private warning, the Chat
// log in the worker, the original only on Reveal (audited), and a clean stop. All names and passwords are generated
// test values; the custom term is a made-up neutral word.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { DEFAULT_POSITIVE_LINES, MSG_WARN_FIRST } from '../shared/room/moderation';
import { PROTOCOL_VERSION } from '../shared/version';
import { startServer, type RunningServer } from './app';
import { formatSetupCode, newSetupCode } from './moderation/hostAdmin';

vi.mock('../shared/sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in lan.m1.test'); } } }));
vi.mock('../shared/ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

const dir = mkdtempSync(path.join(tmpdir(), 'voidswarm-lanm1-'));
const dataDir = path.join(dir, 'data');
const HOST_USER = `Host${randomBytes(3).toString('hex')}`;
const HOST_PASS = `T3st-${randomBytes(12).toString('base64url')}`;
const PLAYER = `Pilot${randomBytes(2).toString('hex')}`;
const PLAYER_PASS = `P1lot-${randomBytes(12).toString('base64url')}`;
const TERM = 'zorblaxian'; // made up, neutral
const code = newSetupCode();
let server: RunningServer;
let adminPort = 0;
let token = '';

interface Reply { status: number; json: Record<string, unknown>; text: string }
function admin(name: string, body: unknown = {}, auth = token): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port: adminPort, path: `/api/admin/${name}`, method: 'POST', agent: false,
      headers: {
        Host: `localhost:${adminPort}`, Origin: `http://localhost:${adminPort}`, 'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)), ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

interface Client { ws: WebSocket; msgs: ServerMsg[]; send(m: ClientMsg): void; until(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg> }
function client(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const c: Client = {
      ws, msgs: [], send: (m) => ws.send(JSON.stringify(m)),
      until: async (pred, ms = 6000) => {
        const end = Date.now() + ms;
        for (;;) {
          const f = c.msgs.find(pred);
          if (f) return f;
          if (Date.now() > end) throw new Error(`timeout; got ${c.msgs.map((m) => (m.type === 'chat' ? `chat:${m.line.text}` : m.type)).join(' | ')}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
    };
    ws.on('message', (d, bin) => { if (!bin) c.msgs.push(JSON.parse(d.toString()) as ServerMsg); });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
const chats = (c: Client): Extract<ServerMsg, { type: 'chat' }>[] => c.msgs.filter((m): m is Extract<ServerMsg, { type: 'chat' }> => m.type === 'chat');

beforeAll(async () => {
  server = await startServer({
    port: 0, bind: '127.0.0.1', dataDir, env: {}, logSink: () => undefined, stopNoticeMs: 0,
    lan: { preset: 'home', admin: { port: 0, setupCode: code }, maint: 'thread', serveLan: false, notServing: 'setup' },
  });
  adminPort = server.admin!.port;
}, 60_000);

afterAll(async () => {
  await server?.stop('test');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a file briefly */ }
});

describe('LAN M1 gate (in process): setup, Live, the Chat log and Reveal', () => {
  let player: Client;
  let guest: Client;
  let termId = 0;

  it('serves no admin API on the game port; the panel is on the admin port; setup is pending', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/admin`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('The control panel is on the host PC');
    expect((await fetch(`http://127.0.0.1:${server.port}/api/admin/me`, { method: 'POST' })).status).toBe(404);
    expect(server.status()).toMatchObject({ lan: true, chatLog: true, setupPending: true, setupKind: 'first', maint: true });
    const st = await admin('setup/status', {}, '');
    expect(st.json).toMatchObject({ ok: true, needsSetup: true });
    expect(server.settings).not.toBeNull();
    expect(server.maint).not.toBeNull();
  });

  it('first-run setup with the launcher code, then sign-in', async () => {
    const bad = await admin('setup', { setupCode: 'ZZZZ-ZZZZ', username: HOST_USER, password: HOST_PASS, preset: 'home', serverName: 'Test Den', accountsMode: 'email' }, '');
    expect(bad.status).toBe(400);
    const r = await admin('setup', { setupCode: formatSetupCode(code), username: HOST_USER, password: HOST_PASS, preset: 'home', serverName: 'Test Den', accountsMode: 'email' }, '');
    expect(r.status, r.text).toBe(200);
    expect(server.status().setupPending).toBe(false);
    const login = await admin('login', { role: 'host', username: HOST_USER, password: HOST_PASS }, '');
    expect(login.status, login.text).toBe(200);
    token = String(login.json.token);
    const me = await admin('me');
    expect(me.status).toBe(200);
    const home = await admin('home');
    expect(home.json).toMatchObject({ ok: true, serverName: 'Test Den' });
    // The host admin's name is reserved for players now.
    const reg = await fetch(`http://127.0.0.1:${server.port}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HOST_USER, email: `${HOST_USER.toLowerCase()}@example.org`, password: PLAYER_PASS }),
    });
    expect(reg.status).toBe(400);
  });

  it('a custom term added through the API applies at once (the term never lands in the audit trail)', async () => {
    const t = await admin('customTerms/add', { term: TERM, category: 'local', action: 'mask', scope: 'both' });
    expect(t.status, t.text).toBe(200);
    termId = Number((t.json.term as { id: number }).id);
    const test = await admin('customTerms/test', { text: `the ${TERM} fleet` });
    expect(test.json).toMatchObject({ ok: true, action: 'mask', customHits: [`custom:local:${TERM}`] });
    expect((await admin('customTerms/list')).json.terms).toHaveLength(1);
    const acts = await admin('actions', { limit: 50 });
    expect(JSON.stringify(acts.json)).not.toContain(TERM);
  });

  it('players chat: the others see a stand-in under the sender\'s name; the sender gets the generic warning', async () => {
    const reg = await fetch(`http://127.0.0.1:${server.port}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: PLAYER, email: `${PLAYER.toLowerCase()}@example.org`, password: PLAYER_PASS }),
    });
    expect(reg.status).toBe(200);
    const ptoken = String(((await reg.json()) as { token: string }).token);
    player = await client();
    player.send({ type: 'hello', name: '', protocol: PROTOCOL_VERSION, version: 'test', token: ptoken });
    await player.until((m) => m.type === 'chatHistory');
    guest = await client();
    guest.send({ type: 'hello', name: 'Wingmate', protocol: PROTOCOL_VERSION, version: 'test' });
    await guest.until((m) => m.type === 'chatHistory');
    player.send({ type: 'chat', channel: 'all', text: 'hello pilots' });
    await guest.until((m) => m.type === 'chat' && m.line.text === 'hello pilots');
    player.send({ type: 'chat', channel: 'all', text: `the ${TERM} fleet attacks` });
    expect(((await player.until((m) => m.type === 'chat' && m.line.channel === 'system' && m.line.text === MSG_WARN_FIRST)) as Extract<ServerMsg, { type: 'chat' }>).line.text).toBe(MSG_WARN_FIRST);
    const stand = await guest.until((m) => m.type === 'chat' && m.line.fromName === PLAYER && m.line.text !== 'hello pilots') as Extract<ServerMsg, { type: 'chat' }>;
    expect(DEFAULT_POSITIVE_LINES).toContain(stand.line.text);
    player.send({ type: 'chat', channel: 'all', text: 'good game' });
    await guest.until((m) => m.type === 'chat' && m.line.text === 'good game');
    expect(chats(guest).some((m) => m.line.text.includes(TERM))).toBe(false);
    expect(chats(player).filter((m) => m.line.channel === 'system').some((m) => m.line.text.includes(TERM))).toBe(false);
  }, 20_000);

  it('Live shows the lines with times and tags; the Chat log (worker) the shown text; Reveal the original, audited', async () => {
    let lines: { ts: number; name: string; shown: string; display: string; tags: string[]; chatId: number | null }[] = [];
    for (let i = 0; i < 50; i++) {
      const live = await admin('chat/live', { after: 0, wait: 0 });
      expect(live.status, live.text).toBe(200);
      lines = (live.json.lines as typeof lines).filter((l) => l.name === PLAYER);
      if (lines.length >= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(lines.map((l) => l.display)).toEqual(['as-typed', 'substituted', 'as-typed']);
    for (const l of lines) expect(l.ts).toBeGreaterThan(Date.now() - 60_000);
    expect(lines[1]!.tags).toEqual(['LOCAL']);
    expect(JSON.stringify(lines)).not.toContain(TERM);
    let rows: { id: number; name: string; shown: string; display: string; tags: string[]; original?: string }[] = [];
    for (let i = 0; i < 50 && rows.length < 3; i++) {
      const log = await admin('log', { player: PLAYER, limit: 50 });
      expect(log.status, log.text).toBe(200);
      rows = (log.json.lines as typeof rows).filter((r) => r.name === PLAYER);
      if (rows.length < 3) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows.map((r) => r.display)).toEqual(['as-typed', 'substituted', 'as-typed']); // newest first
    expect(JSON.stringify(rows)).not.toContain(TERM);
    const masked = rows[1]!;
    const rev = await admin('log/reveal', { ids: [masked.id] });
    expect(rev.status, rev.text).toBe(200);
    expect(rev.json.originals).toEqual([{ id: masked.id, original: `the ${TERM} fleet attacks` }]);
    const acts = await admin('actions', { limit: 50 });
    const list = acts.json.actions as { action: string; reason: string }[];
    expect(list.some((a) => a.action === 'reveal' && a.reason.includes(`#${masked.id}`))).toBe(true);
  }, 20_000);

  it('the term can be removed; the server stops cleanly with the chat flushed and the WAL checkpointed', async () => {
    expect((await admin('customTerms/remove', { id: termId })).json).toEqual({ ok: true, removed: 1 });
    player.ws.close();
    guest.ws.close();
    await server.stop('test');
    const db = new DatabaseSync(path.join(dataDir, 'voidswarm.db'), { readOnly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM chat_log WHERE name = ?').get(PLAYER) as { n: number }).n).toBe(3);
      expect((db.prepare('SELECT COUNT(*) AS n FROM custom_terms').get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
    const wal = path.join(dataDir, 'voidswarm.db-wal');
    expect(!existsSync(wal) || (await import('node:fs')).statSync(wal).size === 0).toBe(true);
    // The settings file and the start-up backup live in the data folder.
    expect(existsSync(path.join(dataDir, 'voidswarm.config.json'))).toBe(true);
  }, 20_000);
});
