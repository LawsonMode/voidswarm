// The server must stay bootable (guests only) when the auth service fails to start.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/version';

vi.mock('../shared/sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim'); } } }));
vi.mock('../shared/ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));
vi.mock('./auth/index', () => ({ createAuthService: () => { throw new Error('createAuthService: not implemented'); } }));

const port = 17000 + Math.floor(Math.random() * 20000);
const logs: string[] = [];

beforeAll(async () => {
  process.env.PORT = String(port);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  await import('./index');
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
});
afterAll(() => { vi.restoreAllMocks(); });

describe('server without accounts', () => {
  it('logs a warning, answers /api with 503, and lets a token-bearing hello in as a guest', async () => {
    expect(logs.some((l) => l.includes('accounts disabled'))).toBe(true);
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(503);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs: ServerMsg[] = [];
    await new Promise<void>((res) => ws.on('open', () => res()));
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'hello', name: 'Solo', protocol: PROTOCOL_VERSION, version: 't', token: 'whatever' }));
    for (let i = 0; i < 60 && !msgs.some((m) => m.type === 'welcome'); i++) await new Promise((r) => setTimeout(r, 25));
    const w = msgs.find((m) => m.type === 'welcome') as Extract<ServerMsg, { type: 'welcome' }>;
    expect(w.name).toBe('Solo');
    expect(w.account).toBeNull();
    ws.close();
  });
});
