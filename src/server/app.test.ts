// Acceptance tests for the server entry (docs/LAN-EDITION-proposal.md §11.3 and §11.2): T-SRV-3 (a busy port exits 2),
// T-SRV-4 (LAN + a database that can't open: the data-folder message) and T-LAN-4 (SIGHUP: every line typed before
// it is in the DB within one tick; the host is gone, and its lock released, within 4 s). Also the process handling
// around them: SIGBREAK, a second signal, an uncaught exception, the launcher's IPC and the `--lan` child boot.
// Ephemeral ports only (listen(0)); never 7777, 7778, 5173 or 5621.
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TICK_RATE } from '../shared/constants';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/version';
import {
  EXIT_CRASH, EXIT_DATA, EXIT_LISTEN, EXIT_OK, EXIT_USAGE, STOP_NOTICE, StartupError, installProcessHandlers, parseLanStart,
  startServer, waitForLanStart, type RunningServer, type ServerIpc, type ServerToParent, type StartServerOptions,
} from './app';

vi.mock('../shared/sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in app.test'); } } }));
vi.mock('../shared/ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const indexTs = path.join(projectRoot, 'src', 'server', 'index.ts');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const root = mkdtempSync(path.join(tmpdir(), 'voidswarm-app-'));
let seq = 0;
const scratch = (): string => { const d = path.join(root, `t${++seq}`); mkdirSync(d); return d; };
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* a DB handle may linger on Windows */ } });

/** No SMTP, CORS or moderation knobs from the developer's shell. */
const quietEnv: NodeJS.ProcessEnv = {};

function listenOn(s: net.Server, where: number | string, host?: string): Promise<void> {
  return new Promise((res, rej) => {
    s.once('error', rej);
    const done = (): void => { s.off('error', rej); res(); };
    if (typeof where === 'string') s.listen(where, done); else s.listen(where, host, done);
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await listenOn(s, 0, '127.0.0.1');
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
function accepts(port: number): Promise<boolean> {
  return new Promise((res) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); res(true); });
    c.once('error', () => res(false));
  });
}

interface Client {
  ws: WebSocket;
  msgs: ServerMsg[];
  closeCode: number | null;
  closed: Promise<number>;
  send(m: ClientMsg): void;
  wait(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
}

function client(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let onClose!: (code: number) => void;
    const c: Client = {
      ws, msgs: [], closeCode: null,
      closed: new Promise((r) => { onClose = r; }),
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (pred, ms = 3000) => new Promise((res, rej) => {
        const found = c.msgs.find(pred);
        if (found) { res(found); return; }
        const t = setTimeout(() => { ws.off('message', on); rej(new Error(`timeout; got ${c.msgs.map((m) => m.type).join(',')}`)); }, ms);
        const on = (): void => { const f = c.msgs.find(pred); if (f) { clearTimeout(t); ws.off('message', on); res(f); } };
        ws.on('message', on);
      }),
    };
    ws.on('message', (d, bin) => { if (!bin) c.msgs.push(JSON.parse(d.toString()) as ServerMsg); });
    ws.on('close', (code) => { c.closeCode = code; onClose(code); });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const hello = (name: string): ClientMsg => ({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test' });
const chat = (text: string): ClientMsg => ({ type: 'chat', channel: 'all', text });
const echoOf = (text: string) => (m: ServerMsg): boolean => m.type === 'chat' && m.line.channel !== 'system' && m.line.text === text;
const isStopNotice = (m: ServerMsg): boolean => m.type === 'chat' && m.line.channel === 'system' && m.line.text === STOP_NOTICE;

async function pilot(port: number, name: string): Promise<Client> {
  const c = await client(port);
  c.send(hello(name));
  await c.wait((m) => m.type === 'chatHistory');
  return c;
}

/** Is this chat line in chat_log? (a fresh read-only connection each time, closed at once) */
function inDb(dbPath: string, text: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return !!db.prepare('SELECT 1 AS ok FROM chat_log WHERE original = ?').get(text); } finally { db.close(); }
}

/** Hold the DB's write lock from another connection: the server's noWait chat writes fail and keep lines buffered. */
function holdWriteLock(dbPath: string): { release(): void } {
  const db = new DatabaseSync(dbPath);
  db.exec('BEGIN IMMEDIATE');
  return { release: () => { db.exec('ROLLBACK'); db.close(); } };
}

function fakeIpc(): ServerIpc & { sent: ServerToParent[]; deliver(m: unknown): void } {
  const subs = new Set<(m: unknown) => void>();
  return {
    sent: [],
    send(m) { this.sent.push(m); },
    onMessage(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    deliver(m) { for (const cb of [...subs]) cb(m); },
  };
}

async function start(extra: StartServerOptions = {}): Promise<{ server: RunningServer; logs: string[]; dbPath: string; dir: string }> {
  const dir = extra.dataDir ?? scratch();
  const logs: string[] = [];
  const server = await startServer({
    port: 0, bind: '127.0.0.1', dataDir: dir, env: quietEnv, publicUrl: 'http://127.0.0.1', logSink: (l) => logs.push(l), ...extra,
  });
  return { server, logs, dbPath: path.join(dir, 'voidswarm.db'), dir };
}

async function rejection(p: Promise<unknown>): Promise<StartupError> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(StartupError);
  return e as StartupError;
}

/** The child env: the developer's shell minus vitest (so index.ts takes the process) and the server knobs. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VITEST|TINYPOOL|SMTP_|CORS_ORIGINS|TRUST_PROX|MOD_|CHAT_|PORT$|BIND$|DB_PATH$|PUBLIC_URL$|NODE_OPTIONS$)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((r) => child.once('exit', (code) => r(code)));
}

// ------------------------------------------------------------------------------------------

describe('T-SRV-3: a busy port', () => {
  it('rejects with exit code 2 and a friendly message, sends it over IPC, and closes everything it opened', async () => {
    const blocker = net.createServer();
    await listenOn(blocker, 0, '127.0.0.1');
    const port = (blocker.address() as AddressInfo).port;
    const dir = scratch();
    const logs: string[] = [];
    const ipc = fakeIpc();
    try {
      const err = await rejection(startServer({ port, bind: '127.0.0.1', dataDir: dir, env: quietEnv, logSink: (l) => logs.push(l), ipc }));
      expect(err.code).toBe('EADDRINUSE');
      expect(err.exitCode).toBe(EXIT_LISTEN);
      expect(err.message).toContain(`Port ${port} is already in use`);
      expect(err.message).toContain('set PORT to a free port');
      expect(logs.some((l) => l.startsWith('ERROR: ') && l.includes(`Port ${port} is already in use`))).toBe(true);
      expect(ipc.sent).toEqual([expect.objectContaining({ type: 'fatal', code: 'EADDRINUSE', exitCode: EXIT_LISTEN })]);
      // Every DB connection it opened is closed again: the data folder can go at once (Windows refuses otherwise).
      expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
      expect(existsSync(dir)).toBe(false);
    } finally {
      blocker.close();
    }
  });

  it('in LAN mode the message points at Settings instead of PORT', async () => {
    const blocker = net.createServer();
    await listenOn(blocker, 0, '127.0.0.1');
    const port = (blocker.address() as AddressInfo).port;
    try {
      const err = await rejection(startServer({ port, bind: '127.0.0.1', dataDir: scratch(), lan: true, env: quietEnv, logSink: () => {} }));
      expect(err.exitCode).toBe(EXIT_LISTEN);
      expect(err.message).toContain('change the port in the Host Control Panel (Settings)');
    } finally {
      blocker.close();
    }
  });

  it('the process (`tsx src/server/index.ts`) exits with code 2 and prints the message', async () => {
    const blocker = net.createServer();
    await listenOn(blocker, 0, '127.0.0.1');
    const port = (blocker.address() as AddressInfo).port;
    const dir = scratch();
    try {
      const child = spawn(process.execPath, [tsxCli, indexTs], {
        cwd: projectRoot,
        env: childEnv({ PORT: String(port), BIND: '127.0.0.1', DB_PATH: path.join(dir, 'voidswarm.db'), PUBLIC_URL: 'http://127.0.0.1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
      const code = await exitOf(child);
      expect(code).toBe(EXIT_LISTEN);
      expect(out).toContain(`Port ${port} is already in use`);
    } finally {
      blocker.close();
    }
  }, 60_000);
});

describe('T-SRV-4: LAN + a database that cannot open', () => {
  it('a voidswarm.db that is not a database: rejects with the data-folder message (exit 3) and never listens', async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'voidswarm.db'), Buffer.alloc(8192, 0x5a));
    const port = await freePort();
    const logs: string[] = [];
    const ipc = fakeIpc();
    const err = await rejection(startServer({ lan: true, dataDir: dir, port, bind: '127.0.0.1', env: quietEnv, logSink: (l) => logs.push(l), ipc }));
    expect(err.code).toBe('EDB');
    expect(err.exitCode).toBe(EXIT_DATA);
    expect(err.message).toContain('could not open its database in the data folder');
    expect(err.message).toContain(dir);
    expect(err.message).toContain('the host did not start');
    expect(logs.some((l) => l.startsWith('ERROR: ') && l.includes('data folder'))).toBe(true);
    expect(ipc.sent).toEqual([expect.objectContaining({ type: 'fatal', code: 'EDB', exitCode: EXIT_DATA })]);
    expect(await accepts(port)).toBe(false);
  });

  it('a voidswarm.db that is a folder (the file cannot be opened at all): the same', async () => {
    const dir = scratch();
    mkdirSync(path.join(dir, 'voidswarm.db'));
    const err = await rejection(startServer({ lan: true, dataDir: dir, port: 0, bind: '127.0.0.1', env: quietEnv, logSink: () => {} }));
    expect(err.code).toBe('EDB');
    expect(err.exitCode).toBe(EXIT_DATA);
    expect(err.message).toContain(dir);
  });

  it('without `lan` the same database keeps the VPS behaviour: guests only, chat not logged, a warning', async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'voidswarm.db'), Buffer.alloc(8192, 0x5a));
    const { server, logs } = await start({ dataDir: dir });
    try {
      expect(server.status()).toMatchObject({ lan: false, accounts: false, chatLog: false, profiles: false });
      expect(server.dbPath).toBeNull();
      expect(logs.some((l) => l.includes('accounts disabled'))).toBe(true);
      expect(logs.some((l) => l.includes('NOT logged'))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('a good data folder in LAN mode starts, with accounts, the chat log and profiles on', async () => {
    const { server } = await start({ lan: true });
    try {
      expect(server.status()).toMatchObject({ lan: true, accounts: true, chatLog: true, profiles: true, stopping: false });
    } finally {
      await server.stop();
    }
  });
});

describe('T-LAN-4: SIGHUP to an in-process host', () => {
  it('every line typed before it is in the DB within 1 tick of arrival; stopped, and the lock released, within 4 s', async () => {
    const { server, dbPath, dir } = await start({ lan: true });
    // The launcher's single-instance lock (§2.2: a named pipe). In the real host the parent holds it and releases it
    // when the child exits; here the test stands in for the parent.
    const pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\voidswarm-lan-test-${process.pid}-${Date.now().toString(36)}`
      : path.join(dir, 'lock.sock');
    const lock = net.createServer();
    await listenOn(lock, pipePath);
    let exitCode: number | null = null;
    let exitAt = 0;
    const handlers = installProcessHandlers(server, {
      exit: (code) => { exitCode = code; exitAt = performance.now(); lock.close(); },
      signals: ['SIGHUP'],
    });
    try {
      const c = await pilot(server.port, 'NovaPilot');

      // 1. Each line is written at the end of the turn it arrived in: it is in the DB when its echo comes back
      //    (same process), and certainly within one tick.
      for (const text of ['form up on me', 'bogey at twelve', 'nice shot']) {
        c.send(chat(text));
        await c.wait(echoOf(text));
        const t0 = performance.now();
        while (!inDb(dbPath, text) && performance.now() - t0 < 1000 / TICK_RATE) await new Promise((r) => setImmediate(r));
        expect(inDb(dbPath, text), text).toBe(true);
      }

      // 2. While the DB is busy a line stays buffered (noWait) — and SIGHUP writes it FIRST, before anything else.
      const held = 'held while the database is busy';
      const lk = holdWriteLock(dbPath);
      c.send(chat(held));
      await c.wait(echoOf(held));
      expect(server.status().chatPending).toBe(1);
      expect(inDb(dbPath, held)).toBe(false);
      lk.release();
      const t0 = performance.now();
      process.emit('SIGHUP', 'SIGHUP'); // synchronously: nothing else ran between the lock's release and this
      expect(server.stopping).toBe(true);
      expect(inDb(dbPath, held)).toBe(true);
      expect(server.status().chatPending).toBe(0);

      // 3. Players get the notice, then the socket closes; the host is gone and the lock free within 4 s.
      await c.wait(isStopNotice, 4000);
      expect(await c.closed).toBe(1001);
      await server.closed;
      expect(exitCode).toBe(EXIT_OK);
      expect(exitAt - t0).toBeLessThan(4000);
      const next = net.createServer();
      await listenOn(next, pipePath); // the next start acquires the lock
      await new Promise<void>((r) => next.close(() => r()));
      expect(await accepts(server.port)).toBe(false);
      // Every connection closed: one checkpointed DB file remains (no WAL left behind).
      expect(!existsSync(`${dbPath}-wal`) || statSync(`${dbPath}-wal`).size === 0).toBe(true);
      expect(inDb(dbPath, 'form up on me')).toBe(true);
    } finally {
      handlers.uninstall();
      lock.close();
      await server.stop();
    }
  }, 20_000);
});

describe('process handling', () => {
  it('SIGBREAK (Ctrl+Break) stops the same way; a second signal while stopping exits at once with code 1', async () => {
    const { server } = await start({ stopNoticeMs: 1000 });
    const exits: number[] = [];
    const handlers = installProcessHandlers(server, { exit: (code) => exits.push(code), signals: ['SIGBREAK'] });
    try {
      const c = await pilot(server.port, 'NovaPilot');
      process.emit('SIGBREAK', 'SIGBREAK');
      expect(server.stopping).toBe(true);
      await c.wait(isStopNotice);
      expect(exits).toEqual([]);
      process.emit('SIGBREAK', 'SIGBREAK');
      expect(exits).toEqual([EXIT_CRASH]);
      await server.closed;
      expect(exits).toEqual([EXIT_CRASH]); // exited once
    } finally {
      handlers.uninstall();
      await server.stop();
    }
  }, 15_000);

  it('an uncaught exception flushes the chat buffer, checkpoints, reports over IPC and exits 1', async () => {
    const ipc = fakeIpc();
    const { server, dbPath, logs } = await start({ ipc, stopNoticeMs: 0 });
    const exits: number[] = [];
    const handlers = installProcessHandlers(server, { exit: (code) => exits.push(code), signals: [] });
    try {
      const c = await pilot(server.port, 'NovaPilot');
      const line = 'buffered when it crashed';
      const lk = holdWriteLock(dbPath);
      c.send(chat(line));
      await c.wait(echoOf(line));
      expect(server.status().chatPending).toBe(1);
      lk.release();
      handlers.onUncaught(new Error('boom'), 'uncaughtException');
      expect(inDb(dbPath, line)).toBe(true);
      expect(exits).toEqual([EXIT_CRASH]);
      expect(ipc.sent).toContainEqual(expect.objectContaining({ type: 'fatal', code: 'EUNCAUGHT', exitCode: EXIT_CRASH, message: 'boom' }));
      expect(logs.some((l) => l.startsWith('FATAL (uncaughtException)'))).toBe(true);
      c.ws.close();
    } finally {
      handlers.uninstall();
      await server.stop();
    }
  });

  it('IPC: "ready" after listening, "status" on request, "stop" → closed → exit 0 (no watchdog)', async () => {
    const ipc = fakeIpc();
    const { server } = await start({ ipc, lan: true });
    const exits: number[] = [];
    const handlers = installProcessHandlers(server, { exit: (code) => exits.push(code), signals: [], watchdogMs: 4000 });
    try {
      expect(ipc.sent[0]).toMatchObject({ type: 'ready', port: server.port, accounts: true, chatLog: true, profiles: true });
      ipc.deliver({ type: 'status' });
      expect(ipc.sent.at(-1)).toMatchObject({ type: 'status', port: server.port, lan: true, online: 0, chatPending: 0, stopping: false });
      ipc.deliver({ type: 'bogus' });
      ipc.deliver(null);
      ipc.deliver({ type: 'stop', reason: 'panel' });
      await server.closed;
      expect(exits).toEqual([EXIT_OK]);
      expect(ipc.sent).toContainEqual({ type: 'stopping', reason: 'panel' });
      ipc.deliver({ type: 'stop' }); // late or repeated stops are harmless
      expect(exits).toEqual([EXIT_OK]);
    } finally {
      handlers.uninstall();
      await server.stop();
    }
  });

  it('stop() is idempotent, refuses new sockets while stopping, and nothing listens afterwards', async () => {
    const { server } = await start({ stopNoticeMs: 0 });
    const a = server.stop('test');
    const b = server.stop('again');
    expect(a).toBe(b);
    await a;
    expect(await accepts(server.port)).toBe(false);
  });

  it('parseLanStart accepts only a well-formed start message', () => {
    expect(parseLanStart({ type: 'lan:start', dataDir: 'C:\\Users\\x\\Voidswarm LAN\\data', port: 7777 }))
      .toMatchObject({ lan: { maint: false }, dataDir: 'C:\\Users\\x\\Voidswarm LAN\\data', port: 7777, secretBundle: null });
    expect(parseLanStart({ type: 'lan:start', dataDir: 'd', preset: 'school' })).toMatchObject({ lan: { preset: 'school' } });
    // The M1 fields: the control panel's port and setup code, the maint relay, the secrets, the launcher's banners.
    const full = parseLanStart({
      type: 'lan:start', dataDir: 'd', port: 0, adminPort: 17_778, setupCode: 'K7QP4MXD', maint: true, displayDir: 'app/display',
      secrets: { v: 1, secrets: { 'pepper.key': Buffer.alloc(32, 1).toString('base64') } }, serveLan: false, notServing: 'setup',
      banners: [{ code: 'elevated', level: 'error', text: 'Run as administrator' }, { nope: 1 }],
    });
    expect(full).toMatchObject({
      lan: { admin: { port: 17_778, setupCode: 'K7QP4MXD', displayDir: 'app/display' }, maint: 'ipc', serveLan: false, notServing: 'setup', banners: [{ code: 'elevated', level: 'urgent' }] },
      secretBundle: { v: 1 },
    });
    expect((full!.lan as { banners: unknown[] }).banners).toHaveLength(1);
    expect(parseLanStart({ type: 'lan:start', dataDir: 'd', adminPort: 1, setupCode: 'not a code' })).toMatchObject({ lan: { admin: { setupCode: null } } });
    expect(parseLanStart({ type: 'lan:start', dataDir: 'd', adminPort: 99_999 })).toBeNull();
    expect(parseLanStart({ type: 'lan:start', dataDir: 'd', secrets: { v: 1, secrets: { 'evil.key': 'AA==' } } })).toBeNull();
    expect(parseLanStart({ type: 'lan:start' })).toBeNull();
    expect(parseLanStart({ type: 'lan:start', dataDir: 'd', port: 70000 })).toBeNull();
    expect(parseLanStart({ type: 'stop' })).toBeNull();
    expect(parseLanStart('lan:start')).toBeNull();
  });

  it('waitForLanStart ignores other messages, resolves on a good start and rejects a malformed one at once', async () => {
    const ok = fakeIpc();
    const p = waitForLanStart(ok, 5000);
    ok.deliver({ type: 'status' });
    ok.deliver({ type: 'lan:start', dataDir: 'data', port: 0 });
    await expect(p).resolves.toMatchObject({ lan: { maint: false }, dataDir: 'data', port: 0 });
    const bad = fakeIpc();
    const q = waitForLanStart(bad, 5000);
    bad.deliver({ type: 'lan:start', port: 1 });
    await expect(q).rejects.toMatchObject({ code: 'EUSAGE', exitCode: EXIT_USAGE });
    await expect(waitForLanStart(fakeIpc(), 20)).rejects.toMatchObject({ code: 'EUSAGE' });
  });
});

describe('the LAN child process (index.ts --lan)', () => {
  const forkChild = (): { child: ChildProcess; out: () => string; msgs: unknown[]; next(type: string, ms?: number): Promise<Record<string, unknown>> } => {
    const child = fork(indexTs, ['--lan'], {
      cwd: projectRoot,
      execArgv: ['--import', 'tsx'],
      env: childEnv({}),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
    const msgs: unknown[] = [];
    child.on('message', (m) => msgs.push(m));
    const next = (type: string, ms = 30_000): Promise<Record<string, unknown>> => new Promise((res, rej) => {
      const hit = (): Record<string, unknown> | undefined => msgs.find((m) => (m as { type?: unknown }).type === type) as Record<string, unknown> | undefined;
      const found = hit();
      if (found) { res(found); return; }
      const t = setTimeout(() => { child.off('message', on); rej(new Error(`no ${type}; output:\n${out}`)); }, ms);
      const on = (): void => { const f = hit(); if (f) { clearTimeout(t); child.off('message', on); res(f); } };
      child.on('message', on);
      child.once('exit', () => { const f = hit(); if (!f) { clearTimeout(t); rej(new Error(`exited without ${type}; output:\n${out}`)); } });
    });
    return { child, out: () => out, msgs, next };
  };

  it('boots from the launcher\'s start message, serves, and exits 0 within 4 s of "stop"', async () => {
    const dir = scratch();
    const { child, next } = forkChild();
    const exited = exitOf(child);
    try {
      child.send({ type: 'lan:start', dataDir: dir, port: 0, bind: '127.0.0.1', publicUrl: 'http://127.0.0.1' });
      const ready = await next('ready');
      expect(ready).toMatchObject({ accounts: true, chatLog: true, profiles: true });
      const port = Number(ready.port);
      const r = await fetch(`http://127.0.0.1:${port}/`);
      expect(await r.text()).toContain('Voidswarm server');
      const t0 = performance.now();
      child.send({ type: 'stop', reason: 'test' });
      expect(await exited).toBe(EXIT_OK);
      expect(performance.now() - t0).toBeLessThan(4000);
      expect(await accepts(port)).toBe(false);
      expect(existsSync(path.join(dir, 'voidswarm.db'))).toBe(true);
      expect(existsSync(path.join(dir, 'voidswarm.db-wal'))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 60_000);

  it('with a database that cannot open it reports "fatal" (EDB) and exits 3', async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'voidswarm.db'), Buffer.alloc(8192, 0x5a));
    const { child, next } = forkChild();
    const exited = exitOf(child);
    try {
      child.send({ type: 'lan:start', dataDir: dir, port: 0, bind: '127.0.0.1' });
      const fatal = await next('fatal');
      expect(fatal).toMatchObject({ code: 'EDB', exitCode: EXIT_DATA });
      expect(String(fatal.message)).toContain('data folder');
      expect(await exited).toBe(EXIT_DATA);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 60_000);
});
