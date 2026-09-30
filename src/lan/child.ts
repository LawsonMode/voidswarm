// LAN edition: the server child and its supervisor (docs/LAN-EDITION-proposal.md §2.2 steps 12 and 14, §5.1, P-M9).
//
// One node.exe, two processes. The launcher (parent) runs every OS integration and opens no network port; the
// server (child, app\server.mjs --lan) does everything network-facing, inside Node's permission model:
//
//   node --permission --allow-fs-read=<root> --allow-fs-write=<root>\data app\server.mjs --lan
//
//  - no child processes, no worker threads, no native addons, no WASI, and file writes only inside data\
//    (T-LAN-13). node:sqlite and listen() are not covered by the permission model (§0 fact 12): the SQLite authorizer
//    (src/server/db/guard.ts) closes that gap for ATTACH / VACUUM INTO.
//  - NO --allow-worker (a deviation from §2.2, measured on Node 24.16): a worker thread's permissions are not pinned
//    to its parent's. A worker created with explicit `execArgv` (even `[]`), or with an `env` object carrying
//    NODE_OPTIONS, can run with a weaker or no permission model, and Node 24 has no flag that pins them. With
//    --allow-worker the sandbox would therefore be only as strong as every `new Worker` call site in the child (and
//    the module.register hooks thread, which also needs it). Without it Node itself refuses both (ERR_ACCESS_DENIED).
//    The maintenance worker of §5.16 has to live elsewhere (a second process the launcher starts with these same
//    flags): an architect decision, reported as a handoff.
//  - Grants name both the path as given and its real path (junctions and symlinks resolved): the permission model
//    checks the path Node resolves, so a root reached through a junction would otherwise be unreadable.
//  - stdio: stdin is the null device, stdout / stderr are pipes the launcher drains (into the host log), plus the IPC
//    channel. The child never writes to the console window (§5.1): a QuickEdit selection there can only pause the
//    launcher, never the game (T-LAN-10). Its own log lines go to data\logs through console.ts installChildLogging.
//  - Secrets arrive over IPC in the first message (`lan:start`), never through argv or the environment. The child's
//    environment is an allowlist: nothing from SMTP_*, *_PASS, NODE_OPTIONS, TRUST_PROXY, … reaches it. (On Windows
//    libuv always adds the variables a process needs to the block it passes, so the child also sees PATH, SYSTEMROOT
//    and LOGONSERVER even though childEnv() leaves them out. None of them is a secret.)
//  - Known and accepted (§2.2 grants read on <root> and write on data\): the child CAN read and replace
//    data\secrets\pipe.key, which is not sent to it. That gives it nothing it lacks: the pipe's commands are `status`,
//    `stop` (the child can already end itself) and `reload-admin` (forwarded to the child itself), and the panel URL
//    a second launch opens is built by the launcher and checked as a loopback URL (pipe.ts validatePanelUrl). Node's
//    permission model has no deny list, so keeping it unreadable would mean moving it out of data\ (a spec change).
//  - Windows: `windowsHide` keeps the child off the launcher's console (CREATE_NO_WINDOW), so Ctrl+C and the
//    window's close button reach only the launcher, which stops the child over IPC (flush-first). libuv also puts
//    the child in the launcher's kill-on-close job object (measured: a launcher killed with Stop-Process -Force takes
//    the child with it within ~0.2 s): the child can never outlive its launcher as an orphan holding the port or the
//    data folder, and a hard kill loses at most the tick in flight (chat is written at the end of every tick). So on
//    the window's close button the launcher waits for the child's stop inside Windows' ~5 s grace. Elsewhere the
//    child gets its own process group (terminal signals reach only the launcher) and stops itself when the IPC
//    channel closes (src/server/index.ts: 'disconnect' → stop).
//
// The supervisor restarts a child that exits without being asked (a crash, exit code 1, or killed): at most
// MAX_RESTARTS times in RESTART_WINDOW_MS. Exit codes 2 (port), 3 (data folder) and 4 (usage) are not retried: they
// would only fail again. Exit 0 without being asked, after 'ready', is the panel's Stop: the host stops (exit 0
// before 'ready' is a failed start, so a crash). respawn() is a planned replacement (a new start message, e.g. on
// loopback only while first-run setup is pending), outside the restart budget.

import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Env, Platform } from './paths';

// Exit codes of the server child. They MUST match src/server/app.ts (child.test.ts checks); they are repeated here
// so the launcher bundle doesn't pull in the whole server.
export const CHILD_EXIT_OK = 0;
export const CHILD_EXIT_CRASH = 1;
export const CHILD_EXIT_LISTEN = 2;
export const CHILD_EXIT_DATA = 3;
export const CHILD_EXIT_USAGE = 4;

/** Restarts allowed within RESTART_WINDOW_MS (§2.2 step 14: "at most 3 times in 10 minutes"). */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** Wait before a restart (the old process has released the port by then). */
export const RESTART_DELAY_MS = 1000;
/**
 * A child that has not said 'ready' by then is killed and counts as a crash. The limit is re-armed by every
 * READY_HEARTBEATS message: the pre-listen work (the encrypted backup, the v3 → v4 migration, the FTS tidy; §2.2 step
 * 10) can take minutes on a big chat log, and a child that says it is still working is never killed for it.
 */
export const READY_TIMEOUT_MS = 120_000;
/** Child messages that prove it is still starting (they re-arm the ready limit): `{type:'progress'}`, a 'notice'. */
export const READY_HEARTBEATS: ReadonlySet<string> = new Set(['progress', 'notice']);
/** stop(): the child's own stop takes the 3 s notice plus at most its 4 s watchdog; after this it is killed. */
export const STOP_GRACE_MS = 10_000;
/** Lines of child output kept in memory for a crash message. */
export const TAIL_LINES = 40;

// ------------------------------------------------------------------------------------------
// The sandbox
// ------------------------------------------------------------------------------------------

export interface SandboxOptions {
  root: string;
  dataDir: string;
  platform?: Platform;
  /** More folders the child may read (a --data folder outside the root is added automatically). */
  extraRead?: string[];
  /** The Node version that runs the child (default this one: the child is spawned with process.execPath). */
  nodeVersion?: string;
}

/**
 * The permission model's switch for a Node version: `--permission` from Node 22.13 / 23.5 on (the packaged runtime
 * is 24), `--experimental-permission` before (a Mac / Linux host on an older Node 22 or 20 through npm, §10).
 */
export function permissionFlag(version: string = process.versions.node): string {
  const [maj, min] = version.split('.').map((x) => Number(x));
  const stable = maj >= 24 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13);
  return stable ? '--permission' : '--experimental-permission';
}

/** `c` is `p` or below it (case-insensitive on Windows). */
function isInside(api: path.PlatformPath, platform: Platform, c: string, p: string): boolean {
  const a = platform === 'win32' ? c.toLowerCase() : c;
  const b = platform === 'win32' ? p.toLowerCase() : p;
  return a === b || a.startsWith(b.endsWith(api.sep) ? b : b + api.sep);
}

/** The real path (junctions and symlinks resolved) of `p`, or of its nearest existing parent plus the rest. */
function realOrResolved(api: path.PlatformPath, platform: Platform, p: string): string {
  const abs = api.resolve(p);
  if (platform !== process.platform) return abs;
  const rest: string[] = [];
  for (let cur = abs; ; ) {
    try { return api.join(fs.realpathSync.native(cur), ...[...rest].reverse()); } catch { /* not there (yet) */ }
    const up = api.dirname(cur);
    if (up === cur) return abs;
    rest.push(api.basename(cur));
    cur = up;
  }
}

/** The install folders the child must never be able to write to (the unsandboxed launcher runs what is in them). */
export const PROGRAM_DIRS: readonly string[] = ['app', 'runtime', 'web', 'previous'];

/**
 * A data folder the sandbox can't be given (§2.2: the child may write to data\ only): the install root itself, a
 * folder that contains the root, or one inside app\, runtime\, web\ or previous\. The child could then replace the
 * programs and stubs the unsandboxed launcher runs. Returns why, or null.
 */
export function dataDirConflict(root: string, dataDir: string, platform: Platform = process.platform): string | null {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const r = realOrResolved(api, platform, root);
  const d = realOrResolved(api, platform, dataDir);
  if (isInside(api, platform, r, d)) {
    return isInside(api, platform, d, r) ? 'it is the Voidswarm folder itself' : 'it contains the Voidswarm folder';
  }
  for (const sub of PROGRAM_DIRS) {
    if (isInside(api, platform, d, api.join(r, sub))) return `it is inside Voidswarm's own ${sub}${api.sep} folder`;
  }
  return null;
}

/**
 * The child's Node flags. Folders grant everything below them. Values are separate argv entries (spawn never uses a
 * shell), so spaces, quotes, parentheses and ampersands in the path are safe. Throws for a data folder that would
 * give the child write access to the programs (dataDirConflict).
 */
export function sandboxExecArgv(opts: SandboxOptions): string[] {
  const platform = opts.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = api.resolve(opts.root);
  const data = api.resolve(opts.dataDir);
  const conflict = dataDirConflict(root, data, platform);
  if (conflict) throw new Error(`The data folder ${data} can't be used: ${conflict}.`);
  const inside = (c: string, p: string): boolean => isInside(api, platform, c, p);
  // Each path as given plus its real path (a no-op when they are the same, or when planning for another platform).
  const both = (p: string): string[] => {
    const real = realOrResolved(api, platform, p);
    return real === p || (platform === 'win32' && real.toLowerCase() === p.toLowerCase()) ? [p] : [p, real];
  };
  const reads: string[] = [];
  const addRead = (p: string): void => { for (const x of both(p)) if (!reads.some((r) => inside(x, r))) reads.push(x); };
  addRead(root);
  addRead(data);
  for (const r of opts.extraRead ?? []) addRead(api.resolve(r));
  const writes = both(data);
  return [
    permissionFlag(opts.nodeVersion),
    ...reads.map((r) => `--allow-fs-read=${r}`),
    ...writes.map((w) => `--allow-fs-write=${w}`),
    // NO --allow-worker: see the header (a worker's permissions are not pinned to the child's).
    // Node's own notice about the node:sqlite API would land in the host log at every start.
    '--disable-warning=ExperimentalWarning',
    // Node 24 warns at every start when a granted path contains a comma (the old list syntax), though the grant is
    // right (one path per flag). That warning has no code, only the generic type: silenced for such paths only.
    ...([...reads, ...writes].some((p) => p.includes(',')) ? ['--disable-warning=Warning'] : []),
  ];
}

/** Variables the child may see (case-insensitive). Everything else, secrets and Node flags included, is dropped. */
export const CHILD_ENV_ALLOW: readonly string[] = [
  // Windows
  'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  // POSIX
  'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
];

export function childEnv(env: Env = process.env): Record<string, string> {
  const allow = new Map(CHILD_ENV_ALLOW.map((k) => [k.toLowerCase(), k]));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !allow.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------------------------------

/** What the child reports once it listens (src/server/app.ts ServerToParent 'ready', plus optional later fields). */
export interface ChildReady {
  type: 'ready';
  port: number;
  bind: string;
  version?: string;
  accounts?: boolean;
  chatLog?: boolean;
  profiles?: boolean;
  /** B6: no usable host admin password yet (setup pending). */
  setupPending?: boolean;
  /** B6: 'first' (never set up: players wait, §3.1) or 'reset' (after Reset admin password.cmd: players keep playing). */
  setupKind?: 'first' | 'reset' | null;
  /** B6: the admin listener's port, once it listens. */
  adminPort?: number;
  [k: string]: unknown;
}

export interface ChildFatal {
  type: 'fatal';
  code: string;
  exitCode: number;
  message: string;
}

export interface ChildStatus {
  type: 'status';
  online?: number;
  rooms?: number;
  playing?: number;
  /** As in ChildReady (B6): the launcher opens the game to the LAN when this turns false. */
  setupPending?: boolean;
  setupKind?: 'first' | 'reset' | null;
  [k: string]: unknown;
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The launcher asked for this exit (stop()). */
  requested: boolean;
  /** The last 'fatal' the child sent before exiting. */
  fatal: ChildFatal | null;
  /** The child never said 'ready' in time and was killed. */
  readyTimeout: boolean;
  /** It had said 'ready' (an exit 0 before that is a failed start, not the panel's Stop). */
  wasReady: boolean;
}

const isObj = (m: unknown): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m);

// ------------------------------------------------------------------------------------------
// One child process
// ------------------------------------------------------------------------------------------

export interface ServerChildOptions {
  /** app\server.mjs */
  entry: string;
  /** Default ['--lan']. */
  args?: string[];
  root: string;
  dataDir: string;
  /** The first message (lan:start, with the secrets). Sent right after the spawn. */
  start: Record<string, unknown>;
  /** Default process.execPath (runtime\node.exe when started by the stub). */
  execPath?: string;
  /** The launcher's environment (filtered by childEnv). */
  env?: Env;
  /** false = no --permission (tests of the supervisor only). Default true. */
  sandbox?: boolean;
  /** Extra Node flags before the sandbox flags (tests). */
  execArgv?: string[];
  cwd?: string;
  platform?: Platform;
  readyTimeoutMs?: number;
  /** A line of child output (stdout / stderr), already split. */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Any other message from the child (notice, open-folder, …). */
  onMessage?: (msg: Record<string, unknown>) => void;
}

/**
 * One server child: spawned, fed its start message, watched. Emits 'ready' (ChildReady), 'fatal' (ChildFatal),
 * 'message' (other messages) and 'exit' (ChildExit).
 */
export class ServerChild extends EventEmitter {
  readonly process: ChildProcess;
  readonly ready: Promise<ChildReady>;
  readonly exited: Promise<ChildExit>;
  readonly tail: string[] = [];
  private readyMsg: ChildReady | null = null;
  private fatalMsg: ChildFatal | null = null;
  private stopRequested = false;
  private stopReason = 'launcher';
  /** The stop is a planned restart (players' sockets get 1012 and reconnect on their own). */
  private stopRestart = false;
  private readyTimedOut = false;
  private readonly readyMs: number;
  private exitInfo: ChildExit | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private statusWaiters: ((s: ChildStatus | null) => void)[] = [];

  constructor(opts: ServerChildOptions) {
    super();
    const platform = opts.platform ?? process.platform;
    const execArgv = [
      ...(opts.execArgv ?? []),
      ...(opts.sandbox === false ? [] : sandboxExecArgv({ root: opts.root, dataDir: opts.dataDir, platform })),
    ];
    this.process = fork(opts.entry, opts.args ?? ['--lan'], {
      execPath: opts.execPath ?? process.execPath,
      execArgv,
      cwd: opts.cwd ?? opts.root,
      env: childEnv(opts.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      detached: platform !== 'win32',
      serialization: 'json',
    });
    const proc = this.process;

    for (const [stream, name] of [[proc.stdout, 'stdout'], [proc.stderr, 'stderr']] as const) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line) return;
        this.tail.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
        if (this.tail.length > TAIL_LINES) this.tail.shift();
        try { opts.onOutput?.(line, name); } catch { /* a sink error must not break the drain */ }
      });
      stream.on('error', () => { /* the child is gone */ });
    }

    this.readyMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    let resolveReady!: (r: ChildReady) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<ChildReady>((res, rej) => { resolveReady = res; rejectReady = rej; });
    this.ready.catch(() => undefined); // a caller that never awaits it must not see an unhandled rejection
    let resolveExit!: (e: ChildExit) => void;
    this.exited = new Promise<ChildExit>((res) => { resolveExit = res; });

    proc.on('message', (m: unknown) => {
      if (!isObj(m) || typeof m.type !== 'string') return;
      if (m.type === 'ready' && !this.readyMsg) {
        this.readyMsg = m as ChildReady;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        // A stop asked for while it was starting may have arrived before the child listened for it (the server installs
        // its 'stop' handler only once it listens): ask again now that it certainly does.
        if (this.stopRequested && !this.exitInfo) this.send(this.stopMessage());
        resolveReady(this.readyMsg);
        this.emit('ready', this.readyMsg);
        return;
      }
      if (!this.readyMsg && !this.exitInfo && !this.readyTimedOut && READY_HEARTBEATS.has(m.type)) this.armReadyTimer();
      if (m.type === 'fatal') {
        this.fatalMsg = {
          type: 'fatal',
          code: typeof m.code === 'string' ? m.code.slice(0, 40) : 'EUNKNOWN',
          exitCode: typeof m.exitCode === 'number' ? m.exitCode : CHILD_EXIT_CRASH,
          message: typeof m.message === 'string' ? m.message.slice(0, 2000) : 'The server stopped after an error.',
        };
        this.emit('fatal', this.fatalMsg);
        return;
      }
      if (m.type === 'status') {
        const waiters = this.statusWaiters.splice(0);
        for (const w of waiters) w(m as ChildStatus);
        return;
      }
      try { opts.onMessage?.(m); } catch { /* the handler's problem */ }
      this.emit('message', m);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.exitInfo) return;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.exitInfo = { code, signal, requested: this.stopRequested, fatal: this.fatalMsg, readyTimeout: this.readyTimedOut, wasReady: !!this.readyMsg };
      for (const w of this.statusWaiters.splice(0)) w(null);
      if (!this.readyMsg) {
        rejectReady(Object.assign(new Error(this.fatalMsg?.message ?? `The server exited before it was ready (exit code ${code ?? signal}).`), { exit: this.exitInfo }));
      }
      resolveExit(this.exitInfo);
      this.emit('exit', this.exitInfo);
    };
    proc.once('exit', (code, signal) => finish(code, signal));
    proc.once('error', () => {
      // A spawn failure (ENOENT, EACCES, blocked by policy): no 'exit' may follow.
      setTimeout(() => finish(proc.exitCode ?? CHILD_EXIT_CRASH, null), 50).unref?.();
    });

    this.armReadyTimer();
    this.send(opts.start);
  }

  /** (Re)starts the ready limit: a child still silent after readyMs is killed (a crash). */
  private armReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.readyMsg || this.exitInfo) return;
      this.readyTimedOut = true;
      this.kill();
    }, this.readyMs);
    this.readyTimer.unref?.();
  }

  get pid(): number | undefined { return this.process.pid; }
  get isReady(): boolean { return !!this.readyMsg; }
  get readyInfo(): ChildReady | null { return this.readyMsg; }
  get lastFatal(): ChildFatal | null { return this.fatalMsg; }
  get exit(): ChildExit | null { return this.exitInfo; }
  get stopping(): boolean { return this.stopRequested; }

  /** Never throws (a gone child is ignored). */
  send(msg: Record<string, unknown>): boolean {
    try {
      if (!this.process.connected) return false;
      this.process.send(msg, (err) => { if (err) { /* the channel closed meanwhile */ } });
      return true;
    } catch {
      return false;
    }
  }

  /** The child's status (null when it doesn't answer in time or is gone). */
  status(timeoutMs = 2000): Promise<ChildStatus | null> {
    if (this.exitInfo || !this.process.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const w = (s: ChildStatus | null): void => { if (!done) { done = true; clearTimeout(t); resolve(s); } };
      const t = setTimeout(() => {
        const i = this.statusWaiters.indexOf(w);
        if (i >= 0) this.statusWaiters.splice(i, 1);
        w(null);
      }, timeoutMs);
      t.unref?.();
      this.statusWaiters.push(w);
      if (!this.send({ type: 'status' })) w(null);
    });
  }

  /**
   * Ask the child to stop (its flush-first shutdown), then wait for it to exit; kill it after `graceMs`. Resolves
   * with the exit. Idempotent.
   */
  stop(reason = 'launcher', graceMs = STOP_GRACE_MS, opts: { restart?: boolean } = {}): Promise<ChildExit> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.stopReason = reason.slice(0, 40);
      this.stopRestart = opts.restart === true;
      if (!this.exitInfo) {
        if (!this.send(this.stopMessage())) this.kill();
        const t = setTimeout(() => { if (!this.exitInfo) this.kill(); }, graceMs);
        t.unref?.();
        void this.exited.then(() => clearTimeout(t));
      }
    }
    return this.exited;
  }

  private stopMessage(): Record<string, unknown> {
    return { type: 'stop', reason: this.stopReason, ...(this.stopRestart ? { restart: true } : {}) };
  }

  /** Hard kill (TerminateProcess on Windows). The chat buffer is written at the end of every tick anyway. */
  kill(): void {
    try { if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL'); } catch { /* gone */ }
  }
}

// ------------------------------------------------------------------------------------------
// The supervisor
// ------------------------------------------------------------------------------------------

/** What the next child is told about the previous one (lan:start `restart`; the panel's banner). */
export interface RestartInfo {
  /** Restarts so far in this launcher run. */
  count: number;
  /** When the previous child stopped (ms since epoch). */
  at: number;
  exitCode: number | null;
  signal: string | null;
}

export type SupervisorEvent =
  | { type: 'ready'; ready: ChildReady; restart: RestartInfo | null; child: ServerChild }
  | { type: 'crashed'; exit: ChildExit; willRestart: boolean; restartsInWindow: number }
  | { type: 'restarting'; restart: RestartInfo }
  | { type: 'respawning'; reason: string }
  | { type: 'finished'; result: SupervisorResult };

export interface SupervisorResult {
  /** The launcher's exit code. */
  exitCode: number;
  /** requested: stop(); server-stopped: the child exited 0 by itself (the panel's Stop); fatal: 2/3/4;
   *  gave-up: too many crashes. */
  reason: 'requested' | 'server-stopped' | 'fatal' | 'gave-up';
  /** For the console (the child's own startup message for 2/3/4). */
  message: string | null;
  exit: ChildExit | null;
}

export interface SupervisorOptions {
  /** Makes the child for an attempt (the launcher builds lan:start with `restart`). */
  spawn: (restart: RestartInfo | null) => ServerChild;
  maxRestarts?: number;
  windowMs?: number;
  restartDelayMs?: number;
  now?: () => number;
  onEvent?: (e: SupervisorEvent) => void;
}

/**
 * Keeps one server child running. start() resolves with the first 'ready' (or rejects when the first child fails
 * for good); `finished` resolves when the host is done, with the launcher's exit code.
 */
export class Supervisor {
  private child: ServerChild | null = null;
  private readonly crashes: number[] = [];
  private restarts = 0;
  private stopping = false;
  private stopReason = 'launcher';
  private result: SupervisorResult | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveFinished!: (r: SupervisorResult) => void;
  readonly finished: Promise<SupervisorResult>;
  private readonly now: () => number;
  private started = false;
  private readyOnce = false;
  private resolveFirstReady!: (r: ChildReady) => void;
  private rejectFirstReady!: (e: Error) => void;
  private readonly firstReady: Promise<ChildReady>;
  /** Children spawned so far (a respawn waits for a child newer than the one it replaced). */
  private generation = 0;
  /** The child a respawn() is replacing (its exit starts the fresh one). */
  private respawnFrom: ServerChild | null = null;
  private respawnWait: { after: number; promise: Promise<ChildReady>; resolve: (r: ChildReady) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly opts: SupervisorOptions) {
    this.now = opts.now ?? Date.now;
    this.finished = new Promise((r) => { this.resolveFinished = r; });
    this.firstReady = new Promise((res, rej) => { this.resolveFirstReady = res; this.rejectFirstReady = rej; });
    this.firstReady.catch(() => undefined);
  }

  get current(): ServerChild | null { return this.child; }
  get restartCount(): number { return this.restarts; }
  get isStopping(): boolean { return this.stopping; }

  /** The first child's 'ready'. Rejects with the reason when it fails for good (port busy, data folder, …). */
  start(): Promise<ChildReady> {
    if (!this.started) {
      this.started = true;
      this.launch(null);
    }
    return this.firstReady;
  }

  private emit(e: SupervisorEvent): void {
    try { this.opts.onEvent?.(e); } catch { /* the listener's problem */ }
  }

  private finish(result: SupervisorResult): void {
    if (this.result) return;
    this.result = result;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.emit({ type: 'finished', result });
    const failed = Object.assign(new Error(result.message ?? 'The server did not start.'), { result });
    if (!this.readyOnce) this.rejectFirstReady(failed);
    if (this.respawnWait) { this.respawnWait.reject(failed); this.respawnWait = null; }
    this.resolveFinished(result);
  }

  private launch(restart: RestartInfo | null): void {
    if (this.result) return;
    let child: ServerChild;
    try {
      child = this.opts.spawn(restart);
    } catch (e) {
      // The start message could not be built (a damaged secret: its own exit code, 3), or the spawn itself failed.
      const own = (e as { exitCode?: unknown })?.exitCode;
      const exitCode = typeof own === 'number' && Number.isInteger(own) && own > 0 && own < 256 ? own : CHILD_EXIT_CRASH;
      this.finish({ exitCode, reason: 'fatal', message: `The server could not be started: ${(e as Error)?.message ?? e}`, exit: null });
      return;
    }
    this.child = child;
    const generation = ++this.generation;
    child.on('ready', (ready: ChildReady) => {
      if (this.stopping || this.result) return;
      if (!this.readyOnce) { this.readyOnce = true; this.resolveFirstReady(ready); }
      if (this.respawnWait && generation > this.respawnWait.after) {
        const w = this.respawnWait;
        this.respawnWait = null;
        w.resolve(ready);
      }
      this.emit({ type: 'ready', ready, restart, child });
    });
    void child.exited.then((exit) => this.onExit(child, exit));
  }

  private onExit(child: ServerChild, exit: ChildExit): void {
    if (child !== this.child || this.result) return;
    if (this.stopping) {
      this.finish({ exitCode: CHILD_EXIT_OK, reason: 'requested', message: null, exit });
      return;
    }
    if (child === this.respawnFrom) {
      // A planned replacement (respawn): start the fresh child; no restart budget is used.
      this.respawnFrom = null;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopping) { this.finish({ exitCode: CHILD_EXIT_OK, reason: 'requested', message: null, exit }); return; }
        this.launch(null);
      }, this.opts.restartDelayMs ?? RESTART_DELAY_MS);
      return;
    }
    if (exit.requested) {
      this.finish({ exitCode: CHILD_EXIT_OK, reason: 'requested', message: null, exit });
      return;
    }
    const code = exit.code;
    // Exit 0 after 'ready' is the panel's Stop. Exit 0 BEFORE 'ready' is a failed start: a crash (below).
    if (code === CHILD_EXIT_OK && exit.wasReady && !exit.readyTimeout) {
      this.finish({ exitCode: CHILD_EXIT_OK, reason: 'server-stopped', message: 'The server was stopped from the control panel.', exit });
      return;
    }
    if (code === CHILD_EXIT_LISTEN || code === CHILD_EXIT_DATA || code === CHILD_EXIT_USAGE) {
      this.finish({ exitCode: code, reason: 'fatal', message: exit.fatal?.message ?? `The server could not start (exit code ${code}).`, exit });
      return;
    }
    // A crash: exit 1, another code, killed by a signal, or no 'ready' in time.
    const t = this.now();
    const windowMs = this.opts.windowMs ?? RESTART_WINDOW_MS;
    while (this.crashes.length && t - this.crashes[0] > windowMs) this.crashes.shift();
    const max = this.opts.maxRestarts ?? MAX_RESTARTS;
    const willRestart = this.crashes.length < max;
    this.emit({ type: 'crashed', exit, willRestart, restartsInWindow: this.crashes.length });
    if (!willRestart) {
      this.finish({
        exitCode: CHILD_EXIT_CRASH,
        reason: 'gave-up',
        message: `The server stopped after an error ${max + 1} times within ${Math.round(windowMs / 60_000)} minutes, so Voidswarm gave up. `
          + 'The details are in data\\logs. Start it again; if this keeps happening, restore a backup ("Restore a backup.cmd").',
        exit,
      });
      return;
    }
    this.crashes.push(t);
    this.restarts++;
    const restart: RestartInfo = { count: this.restarts, at: t, exitCode: code, signal: exit.signal };
    this.emit({ type: 'restarting', restart });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) { this.finish({ exitCode: CHILD_EXIT_OK, reason: 'requested', message: null, exit }); return; }
      this.launch(restart);
    }, this.opts.restartDelayMs ?? RESTART_DELAY_MS);
  }

  /** The current child's status (null while restarting). */
  status(timeoutMs?: number): Promise<ChildStatus | null> {
    return this.child && !this.child.exit ? this.child.status(timeoutMs) : Promise.resolve(null);
  }

  send(msg: Record<string, unknown>): boolean {
    return this.child ? this.child.send(msg) : false;
  }

  /**
   * Replace the running child with a fresh one (a planned restart, e.g. on loopback only while first-run setup is
   * pending): the old one gets its flush-first stop, then `spawn(null)` runs again. Not a crash: no restart budget
   * is used and there is no "restarted after an error" notice. Resolves with the new child's 'ready' (rejects when
   * the host stops or gives up first). While a crash restart is already waiting, that next child is the fresh one.
   */
  respawn(reason = 'respawn', graceMs?: number): Promise<ChildReady> {
    if (this.stopping || this.result) {
      return Promise.reject(Object.assign(new Error('The host is stopping.'), { result: this.result }));
    }
    if (this.respawnWait) return this.respawnWait.promise;
    let resolve!: (r: ChildReady) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<ChildReady>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => undefined);
    this.respawnWait = { after: this.generation, promise, resolve, reject };
    const old = this.child;
    if (old && !old.exit && !this.restartTimer) {
      this.respawnFrom = old;
      this.emit({ type: 'respawning', reason });
      void old.stop(reason, graceMs, { restart: true });
    }
    return promise;
  }

  /** Stop the host: the child's flush-first stop, then 'finished' (exit code 0). Idempotent. */
  stop(reason = 'launcher', graceMs?: number): Promise<SupervisorResult> {
    if (!this.stopping) {
      this.stopping = true;
      this.stopReason = reason;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.finish({ exitCode: CHILD_EXIT_OK, reason: 'requested', message: null, exit: this.child?.exit ?? null });
      } else if (this.child && !this.child.exit) {
        void this.child.stop(this.stopReason, graceMs);
      } else {
        this.finish({ exitCode: CHILD_EXIT_OK, reason: 'requested', message: null, exit: this.child?.exit ?? null });
      }
    }
    return this.finished;
  }

  /** Kill the child now (a second Ctrl+C). */
  kill(): void {
    this.stopping = true;
    this.child?.kill();
  }
}
