// Integration: boots the real server (real AuthService + ws) with the Sim/AI mocked, on a spare port + temp DB.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/version';

vi.mock('../shared/sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in server.test'); } } }));
vi.mock('../shared/ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

const port = 17000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'voidswarm-srv-'));

async function post(p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

interface Client { ws: WebSocket; msgs: ServerMsg[]; closeCode: number | null; send(m: ClientMsg): void; wait(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg> }

function client(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c: Client = {
      ws, msgs: [], closeCode: null,
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (pred, ms = 3000) => new Promise((res, rej) => {
        const found = c.msgs.find(pred);
        if (found) { res(found); return; }
        const t = setTimeout(() => { ws.off('message', on); rej(new Error('timeout; got ' + c.msgs.map((m) => m.type).join(','))); }, ms);
        const on = (): void => { const f = c.msgs.find(pred); if (f) { clearTimeout(t); ws.off('message', on); res(f); } };
        ws.on('message', on);
      }),
    };
    ws.on('message', (d, bin) => { if (!bin) c.msgs.push(JSON.parse(d.toString())); });
    ws.on('close', (code) => { c.closeCode = code; });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const hello = (name: string, token?: string): ClientMsg => ({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token });

beforeAll(async () => {
  process.env.PORT = String(port);
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.PUBLIC_URL = base;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('./index');
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* db may still be open on Windows */ }
});

describe('server + accounts', () => {
  let token = '';

  it('serves plain HTTP and routes /api to auth', async () => {
    const r = await fetch(base + '/');
    expect(await r.text()).toContain('Voidswarm server');
    const reg = await post('/api/register', { username: 'Maverick', email: 'mav@example.com', password: 'correct-horse-9' });
    expect(reg.status).toBe(200);
    token = String(reg.json.token);
    expect(token.length).toBeGreaterThan(10);
  });

  it('a valid token logs in as the account; messages sent during verification keep their order', async () => {
    const c = await client();
    c.send(hello('ignored', token));
    c.send({ type: 'chat', channel: 'all', text: 'first!' });
    c.send({ type: 'listRooms' });
    const w = await c.wait((m) => m.type === 'welcome') as Extract<ServerMsg, { type: 'welcome' }>;
    expect(w.name).toBe('Maverick');
    expect(w.account?.username).toBe('Maverick');
    expect(c.msgs[0].type).toBe('welcome');
    await c.wait((m) => m.type === 'chat' && m.line.text === 'first!');
    const types = c.msgs.map((m) => m.type);
    expect(types.lastIndexOf('roomList')).toBeGreaterThan(types.indexOf('chatHistory'));
    c.ws.close();
  });

  it('v0.3 M2: an account pilot gets its SQLite-backed profile right after welcome; guests never get one', async () => {
    const c = await client();
    c.send(hello('', token));
    await c.wait((m) => m.type === 'chatHistory');
    expect(c.msgs.slice(0, 2).map((m) => m.type)).toEqual(['welcome', 'profile']);
    const p = c.msgs[1] as Extract<ServerMsg, { type: 'profile' }>;
    expect(p.persisted).toBe(true); // the profile store opened on the auth DB
    expect(p.profile.v).toBe(1);
    c.ws.close();
    const g = await client();
    g.send(hello('Wanderer'));
    await g.wait((m) => m.type === 'chatHistory');
    expect(g.msgs.some((m) => m.type === 'profile')).toBe(false);
    g.ws.close();
  });

  it('an invalid token gets an error and plays as a guest; guests cannot use registered names', async () => {
    const c = await client();
    c.send(hello('maverick', 'bogus-token'));
    const e = await c.wait((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>;
    expect(e.message).toBe('Session expired — please log in again');
    const w = await c.wait((m) => m.type === 'welcome') as Extract<ServerMsg, { type: 'welcome' }>;
    expect(w.account).toBeNull();
    expect(w.name.toLowerCase()).not.toBe('maverick');
    c.ws.close();
  });

  it('logging in elsewhere kicks the older connection', async () => {
    const a = await client();
    a.send(hello('', token));
    await a.wait((m) => m.type === 'welcome');
    const b = await client();
    b.send(hello('', token));
    await b.wait((m) => m.type === 'welcome');
    await a.wait((m) => m.type === 'error' && m.message === 'Logged in elsewhere');
    for (let i = 0; i < 40 && a.closeCode === null; i++) await new Promise((r) => setTimeout(r, 25));
    expect(a.closeCode).toBe(4001);
    b.ws.close();
  });

  it('drops garbage and oversize frames without disconnecting', async () => {
    const c = await client();
    c.ws.send('{not json');
    c.ws.send(JSON.stringify({ type: 'nuke' }));
    c.ws.send('x'.repeat(5000));
    c.send(hello('Guest'));
    const w = await c.wait((m) => m.type === 'welcome') as Extract<ServerMsg, { type: 'welcome' }>;
    expect(w.name).toBe('Guest');
    c.send({ type: 'ping', t: 42 });
    await c.wait((m) => m.type === 'pong');
    c.ws.close();
  });
});
