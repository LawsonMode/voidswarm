// LAN edition: the single-instance lock, a named pipe (§2.2 step 5, T-LAN-2, T-LAN-14).
//
//   \\.\pipe\voidswarm-lan-<first 16 hex of sha256(dataPath)>
//
// Windows frees a named pipe when its process dies, so a crash or power loss can never leave a
// stale lock (a PID file would). On macOS/Linux it is a Unix socket in a per-user 0700 folder
// under the temp folder (so no other account can reach it, even in the moment before a chmod); a
// stale socket file is detected (connection refused) and replaced.
//
// Known limit (Windows): \\.\pipe\ is one namespace for the whole PC and the name is derived from
// the data path, so another signed-in account could create the pipe first and keep the host from
// starting (it then says the lock is taken). That is a denial of service only: without pipe.key it
// can't pass as the host to a keyed client, and a keyless second launch only ever opens a loopback
// http URL. The IT sheet mentions it.
//
// The holder (the launcher, parent process) answers one request per connection, newline-delimited
// JSON:
//   host → client  {"v":1,"app":"voidswarm-lan","challenge":"<hex>"}
//   client → host  {"cmd":"stop","nonce":"<hex>","args":"<json>","mac":"<hmac>"}
//   host → client  {"body":"<json>","mac":"<hmac>"}
// `ping` and `panel` need no key (a second launch only learns the panel's loopback URL). `status`,
// `stop` and `reload-admin` need data\secrets\pipe.key: mac = HMAC-SHA256(key, "req|challenge|nonce|cmd|args").
// The host signs every reply with the key (HMAC over "rep|challenge|nonce|body"), so a client
// holding the key can tell the real host from a program squatting on the pipe name.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normWin, type Platform } from './paths';

export type PipeCommand = 'ping' | 'panel' | 'status' | 'stop' | 'reload-admin';
export const PIPE_COMMANDS: readonly PipeCommand[] = ['ping', 'panel', 'status', 'stop', 'reload-admin'];
/** Commands that need data\secrets\pipe.key. */
export const PRIVILEGED_COMMANDS: ReadonlySet<PipeCommand> = new Set<PipeCommand>(['status', 'stop', 'reload-admin']);

export const ALREADY_RUNNING_MESSAGE = 'Voidswarm is already running — opened the control panel.';

const MAX_LINE = 64 * 1024;
const MAX_REPLY = 1024 * 1024;

/** The data path as the lock hashes it: resolved, real (junctions/subst/case), no trailing separator, lowercase on Windows. */
export function normalizeDataPath(dataDir: string, platform: Platform = process.platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  let p = api.resolve(dataDir);
  if (platform === process.platform) {
    // The real path of the nearest existing ancestor, plus the part not created yet, so the first
    // start (before data\ exists) and later starts hash the same folder (8.3 names, junctions, subst).
    const tail: string[] = [];
    let cur = p;
    for (let i = 0; i < 64; i++) {
      try {
        p = api.join(fs.realpathSync.native(cur), ...tail);
        break;
      } catch {
        const up = api.dirname(cur);
        if (up === cur) break;
        tail.unshift(api.basename(cur));
        cur = up;
      }
    }
  }
  if (platform === 'win32') return normWin(p);
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** First 16 hex digits of sha256(normalized data path). */
export function pipeId(dataDir: string, platform: Platform = process.platform): string {
  return createHash('sha256').update(normalizeDataPath(dataDir, platform), 'utf8').digest('hex').slice(0, 16);
}

/** macOS/Linux: the per-user folder that holds the lock socket (`<tmp>/voidswarm-lan-<uid>`). */
export function socketDir(): string {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.posix.join(os.tmpdir().replace(/\\/g, '/'), `voidswarm-lan-${uid}`);
}

export function pipePath(dataDir: string, platform: Platform = process.platform): string {
  const id = pipeId(dataDir, platform);
  if (platform === 'win32') return `\\\\.\\pipe\\voidswarm-lan-${id}`;
  // Short file name: macOS limits a socket path to 104 bytes.
  return path.posix.join(socketDir(), `${id}.sock`);
}

/**
 * Creates the per-user socket folder with mode 0700, or checks an existing one: a real folder (not
 * a link), owned by us, no access for anyone else. Throws when another account controls it.
 */
export function ensureSocketDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a folder; remove it and start again`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another account; remove it and start again`);
  }
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}

function hmac(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

function safeEqualHex(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function checkKey(key: Buffer | null | undefined): Buffer | null {
  if (!key) return null;
  if (key.length < 16) throw new Error('pipe key must be at least 16 bytes');
  return key;
}

/** Only an http URL on this PC's loopback is ever opened from a pipe reply. */
export function validatePanelUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
  if (u.username || u.password) return null;
  return u.href;
}

// --- host side -------------------------------------------------------------------------------

export interface PipeHandlers {
  /** The panel URL a second launch opens, e.g. http://localhost:7778/. */
  panelUrl(): string;
  /** Anything JSON-serialisable (the parent's status summary). */
  status?(): unknown | Promise<unknown>;
  /** Called after the reply has been sent. */
  stop?(): void | Promise<void>;
  /** The admin credential changed on disk (Reset admin password.cmd). */
  reloadAdmin?(): void | Promise<void>;
  /** Reported by `ping`. */
  version?: string;
}

export interface HostLock {
  path: string;
  /**
   * Sets (or replaces) pipe.key after the lock was taken: on the first run the lock (§2.2 step 5)
   * comes before data\secrets\pipe.key exists (step 7). From then on replies are signed and the
   * privileged commands work. Throws on a key shorter than 16 bytes.
   */
  setKey(key: Buffer | null): void;
  close(): Promise<void>;
}

export type AcquireResult = { ok: true; lock: HostLock } | { ok: false; running: true; path: string; answering: boolean };

export interface AcquireOptions {
  dataDir: string;
  /**
   * data\secrets\pipe.key (≥ 16 bytes); null before it exists (privileged commands are then
   * refused and replies unsigned). Call `lock.setKey()` as soon as it is created.
   */
  key: Buffer | null;
  handlers: PipeHandlers;
  platform?: Platform;
  /** Don't keep the event loop alive just for the lock. */
  unref?: boolean;
  /** Overrides the pipe path (tests). */
  pipe?: string;
}

function readLine(sock: net.Socket, limit: number, onLine: (line: string) => void, onFail: (why: string) => void): void {
  let buf = '';
  let done = false;
  const onData = (chunk: Buffer | string) => {
    if (done) return;
    buf += chunk.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0) {
      done = true;
      sock.off('data', onData);
      onLine(buf.slice(0, nl));
      return;
    }
    if (buf.length > limit) {
      done = true;
      sock.off('data', onData);
      onFail('too-long');
    }
  };
  sock.on('data', onData);
  sock.once('end', () => {
    if (!done) {
      done = true;
      onFail('closed');
    }
  });
}

function serveConnection(sock: net.Socket, getKey: () => Buffer | null, h: PipeHandlers): void {
  // One key per connection, read when it opens (setKey can't change it mid-exchange).
  const key = getKey();
  sock.setEncoding('utf8');
  sock.setTimeout(5_000, () => sock.destroy());
  sock.on('error', () => sock.destroy());
  const challenge = randomBytes(16).toString('hex');
  sock.write(JSON.stringify({ v: 1, app: 'voidswarm-lan', challenge }) + '\n');

  readLine(sock, MAX_LINE, (line) => {
    let req: { cmd?: unknown; nonce?: unknown; args?: unknown; mac?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return sock.destroy();
    }
    const nonce = typeof req.nonce === 'string' && /^[0-9a-f]{16,64}$/i.test(req.nonce) ? req.nonce : null;
    const cmd = typeof req.cmd === 'string' && (PIPE_COMMANDS as readonly string[]).includes(req.cmd) ? (req.cmd as PipeCommand) : null;
    const argsJson = typeof req.args === 'string' ? req.args : '';
    if (!nonce) return sock.destroy();

    let after: (() => void | Promise<void>) | null = null;
    const reply = (body: Record<string, unknown>) => {
      const bodyStr = JSON.stringify(body);
      const out: { body: string; mac?: string } = { body: bodyStr };
      if (key) out.mac = hmac(key, `rep|${challenge}|${nonce}|${bodyStr}`);
      sock.end(JSON.stringify(out) + '\n', () => {
        if (after) void Promise.resolve().then(after).catch(() => undefined);
      });
    };

    if (!cmd) return reply({ ok: false, error: 'unknown command' });
    if (PRIVILEGED_COMMANDS.has(cmd)) {
      if (!key) return reply({ ok: false, error: 'no pipe key on the host' });
      if (!safeEqualHex(req.mac, hmac(key, `req|${challenge}|${nonce}|${cmd}|${argsJson}`))) return reply({ ok: false, error: 'unauthorized' });
    }
    void (async () => {
      try {
        switch (cmd) {
          case 'ping':
            return reply({ ok: true, app: 'voidswarm-lan', version: h.version ?? null, pid: process.pid });
          case 'panel':
            return reply({ ok: true, panelUrl: h.panelUrl() });
          case 'status':
            return reply({ ok: true, status: h.status ? await h.status() : null });
          case 'stop':
            if (!h.stop) return reply({ ok: false, error: 'stop is not available' });
            after = () => h.stop!();
            return reply({ ok: true, stopping: true });
          case 'reload-admin':
            if (!h.reloadAdmin) return reply({ ok: false, error: 'reload-admin is not available' });
            await h.reloadAdmin();
            return reply({ ok: true });
        }
      } catch (e) {
        return reply({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    })();
  }, () => sock.destroy());
}

function listenOn(server: net.Server, p: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      resolve(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p);
  });
}

/**
 * Takes the lock for a data folder. When another host holds it, returns `{ ok: false, running }`
 * (the caller then runs `secondLaunch`). A stale Unix socket is replaced.
 */
export async function acquireLock(opts: AcquireOptions): Promise<AcquireResult> {
  const platform = opts.platform ?? process.platform;
  let key = checkKey(opts.key);
  const p = opts.pipe ?? pipePath(opts.dataDir, platform);
  if (platform !== 'win32' && !opts.pipe) ensureSocketDir(path.posix.dirname(p));

  for (let attempt = 0; attempt < 3; attempt++) {
    const server = net.createServer((sock) => serveConnection(sock, () => key, opts.handlers));
    server.maxConnections = 16;
    const err = await listenOn(server, p);
    if (!err) {
      if (platform !== 'win32') {
        try {
          fs.chmodSync(p, 0o600); // belt and braces: the folder is already 0700
        } catch {
          /* ignore */
        }
      }
      if (opts.unref) server.unref();
      let closed = false;
      const lock: HostLock = {
        path: p,
        setKey: (next) => {
          key = checkKey(next);
        },
        close: () =>
          new Promise<void>((resolve) => {
            if (closed) return resolve();
            closed = true;
            server.close(() => resolve());
          }),
      };
      return { ok: true, lock };
    }
    server.close();
    if (err.code !== 'EADDRINUSE') throw err;
    const probe = await sendRaw(p, 'ping', null, '', 1_500);
    if (probe.kind === 'reply' || probe.kind === 'timeout' || probe.kind === 'bad') {
      return { ok: false, running: true, path: p, answering: probe.kind === 'reply' };
    }
    // Nobody answers: on Unix a stale socket file from a crash; on Windows the holder just exited.
    if (platform !== 'win32') {
      try {
        fs.unlinkSync(p);
      } catch {
        /* raced */
      }
    }
  }
  return { ok: false, running: true, path: p, answering: false };
}

// --- client side -----------------------------------------------------------------------------

type RawResult =
  | { kind: 'reply'; body: Record<string, unknown>; bodyStr: string; mac: unknown; challenge: string; nonce: string }
  | { kind: 'absent' }
  | { kind: 'timeout' }
  | { kind: 'bad'; why: string };

function sendRaw(p: string, cmd: PipeCommand, key: Buffer | null, argsJson: string, timeoutMs: number): Promise<RawResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RawResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const sock = net.connect(p);
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK') finish({ kind: 'absent' });
      else finish({ kind: 'bad', why: e.code ?? 'error' });
    });
    readLine(sock, MAX_LINE, (hello) => {
      let challenge = '';
      try {
        const h = JSON.parse(hello) as { app?: unknown; challenge?: unknown };
        if (h.app !== 'voidswarm-lan' || typeof h.challenge !== 'string' || !/^[0-9a-f]{16,64}$/i.test(h.challenge)) {
          return finish({ kind: 'bad', why: 'not a Voidswarm host' });
        }
        challenge = h.challenge;
      } catch {
        return finish({ kind: 'bad', why: 'not a Voidswarm host' });
      }
      const nonce = randomBytes(16).toString('hex');
      const req: Record<string, string> = { cmd, nonce };
      if (argsJson) req.args = argsJson;
      if (key) req.mac = hmac(key, `req|${challenge}|${nonce}|${cmd}|${argsJson}`);
      sock.write(JSON.stringify(req) + '\n');
      readLine(sock, MAX_REPLY, (line) => {
        try {
          const r = JSON.parse(line) as { body?: unknown; mac?: unknown };
          if (typeof r.body !== 'string') return finish({ kind: 'bad', why: 'bad reply' });
          const body = JSON.parse(r.body) as Record<string, unknown>;
          if (!body || typeof body !== 'object') return finish({ kind: 'bad', why: 'bad reply' });
          finish({ kind: 'reply', body, bodyStr: r.body, mac: r.mac, challenge, nonce });
        } catch {
          finish({ kind: 'bad', why: 'bad reply' });
        }
      }, (why) => finish({ kind: 'bad', why }));
    }, (why) => finish({ kind: 'bad', why }));
  });
}

export type PipeReply =
  | {
      ok: true;
      /** True when the reply's HMAC checked out with our key (false when we have no key). */
      verified: boolean;
      body: Record<string, unknown>;
    }
  | { ok: false; error: 'not-running' | 'timeout' | 'not-voidswarm' | 'unverified' | 'refused'; detail?: string; body?: Record<string, unknown> };

export interface SendOptions {
  dataDir: string;
  key: Buffer | null;
  cmd: PipeCommand;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  platform?: Platform;
  pipe?: string;
}

/** Sends one command to the running host. */
export async function sendCommand(opts: SendOptions): Promise<PipeReply> {
  const platform = opts.platform ?? process.platform;
  const key = checkKey(opts.key);
  const p = opts.pipe ?? pipePath(opts.dataDir, platform);
  const argsJson = opts.args ? JSON.stringify(opts.args) : '';
  const r = await sendRaw(p, opts.cmd, key, argsJson, opts.timeoutMs ?? 5_000);
  if (r.kind === 'absent') return { ok: false, error: 'not-running' };
  if (r.kind === 'timeout') return { ok: false, error: 'timeout' };
  if (r.kind === 'bad') return { ok: false, error: 'not-voidswarm', detail: r.why };
  let verified = false;
  if (key) {
    verified = safeEqualHex(r.mac, hmac(key, `rep|${r.challenge}|${r.nonce}|${r.bodyStr}`));
    if (!verified) return { ok: false, error: 'unverified' };
  }
  if (r.body.ok !== true) return { ok: false, error: 'refused', detail: typeof r.body.error === 'string' ? r.body.error : undefined, body: r.body };
  return { ok: true, verified, body: r.body };
}

/** True when a host holds the lock for this data folder (update/restore refuse then). */
export async function isHostRunning(dataDir: string, opts: { platform?: Platform; pipe?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const r = await sendCommand({ dataDir, key: null, cmd: 'ping', ...opts });
  return !(r.ok === false && r.error === 'not-running');
}

export interface SecondLaunchResult {
  exitCode: number;
  message: string;
  url: string | null;
}

/**
 * The second launch on a data folder: ask the running host for its panel URL, open it, exit 0
 * with "Voidswarm is already running — opened the control panel." (T-LAN-2).
 */
export async function secondLaunch(opts: {
  dataDir: string;
  key: Buffer | null;
  openBrowser: (url: string) => void | Promise<void>;
  platform?: Platform;
  pipe?: string;
  timeoutMs?: number;
}): Promise<SecondLaunchResult> {
  const r = await sendCommand({ dataDir: opts.dataDir, key: opts.key, cmd: 'panel', platform: opts.platform, pipe: opts.pipe, timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    if (r.error === 'unverified' || r.error === 'not-voidswarm') {
      return {
        exitCode: 1,
        url: null,
        message: "Another program is using Voidswarm's lock and didn't prove it is Voidswarm. Restart the PC, then start Voidswarm again.",
      };
    }
    if (r.error === 'not-running') {
      return { exitCode: 1, url: null, message: 'The running Voidswarm host just stopped. Start it again.' };
    }
    return {
      exitCode: 1,
      url: null,
      message: "Voidswarm seems to be running already but isn't answering. Close the other Voidswarm window (or end Node.js in Task Manager), then start it again.",
    };
  }
  const url = validatePanelUrl(r.body.panelUrl);
  if (!url) return { exitCode: 1, url: null, message: 'The running Voidswarm host gave an unexpected control-panel address.' };
  try {
    await opts.openBrowser(url);
  } catch {
    return { exitCode: 0, url, message: `Voidswarm is already running. Open ${url} in your browser.` };
  }
  return { exitCode: 0, url, message: ALREADY_RUNNING_MESSAGE };
}
