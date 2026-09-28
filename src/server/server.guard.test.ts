// Integration (ROOM fix pass): the real server with its network guards — default CORS allowlist, BIND,
// per-address connection cap, and live sessions ended when the session is revoked (logout / reset).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/version';
import { SESSION_ENDED_MSG } from './netguard';

vi.mock('../shared/sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in server.guard.test'); } } }));
vi.mock('../shared/ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

const port = 17000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'voidswarm-guard-'));
const logs: string[] = [];

async function post(p: string, body: unknown, origin?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> };
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

async function closedWith(c: Client, ms = 2000): Promise<number | null> {
  for (let i = 0; i < ms / 25 && c.closeCode === null; i++) await new Promise((r) => setTimeout(r, 25));
  return c.closeCode;
}

const hello = (name: string, token?: string): ClientMsg => ({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token });

beforeAll(async () => {
  process.env.PORT = String(port);
  process.env.DB_PATH = path.join(dir, 'guard.db');
  process.env.PUBLIC_URL = base;
  process.env.BIND = '127.0.0.1';
  process.env.MAX_CONN_PER_IP = '3';
  delete process.env.CORS_ORIGINS;
  delete process.env.SMTP_HOST;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  await import('./index');
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
});

afterAll(() => {
  vi.restoreAllMocks();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* db may still be open on Windows */ }
});

describe('server network guards', () => {
  it('binds to BIND (SEC-9)', () => {
    expect(logs.some((l) => l.includes(`listening on 127.0.0.1:${port}`))).toBe(true);
  });

  it('without CORS_ORIGINS, other websites are refused but the dev client origin works (SEC-7)', async () => {
    const evil = await post('/api/login', { login: 'x', password: 'y' }, 'https://evil.example');
    expect(evil.status).toBe(403);
    const dev = await post('/api/login', { login: 'nobody', password: 'wrong-password' }, 'http://localhost:5173');
    expect(dev.status).not.toBe(403);
    const none = await post('/api/login', { login: 'nobody', password: 'wrong-password' });
    expect(none.status).not.toBe(403);
  });

  it('logout ends the live game connection that used that session (SEC-10)', async () => {
    const reg = await post('/api/register', { username: 'Iceman', email: 'ice@example.com', password: 'correct-horse-9' });
    expect(reg.status).toBe(200);
    const token = String(reg.json.token);
    const other = await post('/api/login', { login: 'Iceman', password: 'correct-horse-9' });
    const otherToken = String(other.json.token);
    const c = await client();
    c.send(hello('', token));
    await c.wait((m) => m.type === 'welcome');
    // logging out a DIFFERENT session of the same account leaves this one alone
    await post('/api/logout', { token: otherToken });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.closeCode).toBeNull();
    expect(c.msgs.some((m) => m.type === 'error')).toBe(false);
    await post('/api/logout', { token });
    const e = await c.wait((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>;
    expect(e.message).toBe(SESSION_ENDED_MSG);
    expect(await closedWith(c)).toBe(4001);
  });

  it('a password reset ends every live connection of the account (SEC-10)', async () => {
    const login = await post('/api/login', { login: 'Iceman', password: 'correct-horse-9' });
    const c = await client();
    c.send(hello('', String(login.json.token)));
    await c.wait((m) => m.type === 'welcome');
    await post('/api/forgot', { email: 'ice@example.com' });
    const line = [...logs].reverse().find((l) => l.includes('DEV reset link for Iceman'));
    expect(line, 'dev-mode reset link logged').toBeTruthy();
    const resetToken = new URL(line!.slice(line!.indexOf('http'))).searchParams.get('reset')!;
    const r = await post('/api/reset', { resetToken, password: 'another-horse-7' });
    expect(r.status).toBe(200);
    const e = await c.wait((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>;
    expect(e.message).toBe(SESSION_ENDED_MSG);
    expect(await closedWith(c)).toBe(4001);
  });

  it('caps concurrent connections per address (SEC-5)', async () => {
    const open: Client[] = [];
    for (let i = 0; i < 3; i++) open.push(await client());
    const extra = await client();
    expect(await closedWith(extra)).toBe(1013);
    open[0].ws.close();
    await closedWith(open[0]);
    await new Promise((r) => setTimeout(r, 50));
    const again = await client();
    again.send(hello('Again'));
    await again.wait((m) => m.type === 'welcome');
    for (const c of [...open, again]) c.ws.close();
  });
});
