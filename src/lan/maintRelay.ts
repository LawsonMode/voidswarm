// LAN edition: the launcher's side of the maintenance process (architect ruling HA; docs/LAN-EDITION-proposal.md
// §5.16 as amended, src/server/maint/ipcTransport.ts).
//
// The server child may start no worker thread (its sandbox has no --allow-worker), so when it asks
// ({type:'maint:spawn', gen, init}) the launcher starts app\maint.mjs --maint as a second sandboxed child with the
// SAME flags (sandboxExecArgv: read the install, write only data\; no child processes, no workers) and the same
// filtered environment, then relays messages both ways, tagged with the spawn's generation:
//   server → maint: {type:'maint:msg', gen, m}   (m is passed through as is)
//   maint → server: {type:'maint:msg', gen, m}, and {type:'maint:exit', gen, code} when it ends.
// {type:'maint:kill', gen} ends it. The launcher never interprets `m`; it only overrides the init's dataDir and
// dbPath with its own paths, so the network-facing server can't point the maint process at another folder. At most
// one maint process runs; spawns are rate-limited (MaintClient itself restarts at most 3 times in 10 minutes).
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { childEnv, sandboxExecArgv } from './child';
import type { Env, Platform } from './paths';

/** Spawns allowed per window (a crash-looping maint process can't make the launcher fork for ever). */
export const MAINT_SPAWNS_PER_WINDOW = 6;
export const MAINT_SPAWN_WINDOW_MS = 10 * 60_000;
/** A killed maint process gets this long to exit before it is killed hard. */
export const MAINT_KILL_GRACE_MS = 2000;

export interface MaintRelayOptions {
  /** app\maint.mjs */
  entry: string;
  root: string;
  dataDir: string;
  dbPath: string;
  /** Default process.execPath (runtime\node.exe). */
  execPath?: string;
  env?: Env;
  platform?: Platform;
  /** false = no --permission (tests of the relay only). Default true. */
  sandbox?: boolean;
  /** Extra Node flags before the sandbox flags (tests: the tsx loader). */
  execArgv?: string[];
  /** Default ['--maint']. */
  args?: string[];
  /** To the server child (ServerChild.send / Supervisor.send). */
  send: (m: Record<string, unknown>) => void;
  /** A line of the maint process's output (goes to the host log, like the server's). */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  log?: (line: string) => void;
  now?: () => number;
}

const isObj = (m: unknown): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m);

export class MaintRelay {
  private proc: ChildProcess | null = null;
  private gen: number | null = null;
  private readonly spawns: number[] = [];
  private stopped = false;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: MaintRelayOptions) {
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
  }

  /** The running maint process (tests). */
  get process(): ChildProcess | null { return this.proc; }

  /** A message from the server child: true when it was a maint message (handled here). */
  handle(m: Record<string, unknown>): boolean {
    if (typeof m.type !== 'string' || !m.type.startsWith('maint:')) return false;
    const gen = typeof m.gen === 'number' && Number.isSafeInteger(m.gen) ? m.gen : null;
    if (gen === null) return true;
    if (m.type === 'maint:spawn') this.spawn(gen, m.init);
    else if (m.type === 'maint:msg') {
      if (gen === this.gen && this.proc?.connected) { try { this.proc.send(m.m as never); } catch { /* it is exiting */ } }
    } else if (m.type === 'maint:kill') {
      if (gen === this.gen) this.kill();
    }
    return true;
  }

  private spawn(gen: number, init: unknown): void {
    if (this.stopped) { this.opts.send({ type: 'maint:exit', gen, code: 1 }); return; }
    this.kill();
    const t = this.now();
    while (this.spawns.length && t - this.spawns[0]! > MAINT_SPAWN_WINDOW_MS) this.spawns.shift();
    if (this.spawns.length >= MAINT_SPAWNS_PER_WINDOW) {
      this.log(`maint: not started again (more than ${MAINT_SPAWNS_PER_WINDOW} starts in ${MAINT_SPAWN_WINDOW_MS / 60_000} minutes)`);
      this.opts.send({ type: 'maint:error', gen, message: 'The maintenance process kept stopping.' });
      this.opts.send({ type: 'maint:exit', gen, code: 1 });
      return;
    }
    this.spawns.push(t);
    let proc: ChildProcess;
    try {
      const platform = this.opts.platform ?? process.platform;
      proc = fork(this.opts.entry, this.opts.args ?? ['--maint'], {
        execPath: this.opts.execPath ?? process.execPath,
        execArgv: [
          ...(this.opts.execArgv ?? []),
          ...(this.opts.sandbox === false ? [] : sandboxExecArgv({ root: this.opts.root, dataDir: this.opts.dataDir, platform })),
        ],
        cwd: this.opts.root,
        env: childEnv(this.opts.env ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        serialization: 'json',
      });
    } catch (e) {
      this.opts.send({ type: 'maint:error', gen, message: `The maintenance process could not start: ${(e as Error)?.message ?? e}` });
      this.opts.send({ type: 'maint:exit', gen, code: 1 });
      return;
    }
    this.proc = proc;
    this.gen = gen;
    for (const [stream, name] of [[proc.stdout, 'stdout'], [proc.stderr, 'stderr']] as const) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => { if (line) { try { this.opts.onOutput?.(line, name); } catch { /* the sink's problem */ } } });
      stream.on('error', () => { /* gone */ });
    }
    proc.on('message', (m: unknown) => {
      if (this.proc !== proc || !isObj(m)) return;
      this.opts.send({ type: 'maint:msg', gen, m });
    });
    let ended = false;
    const end = (code: number | null): void => {
      if (ended) return;
      ended = true;
      if (this.proc === proc) { this.proc = null; this.gen = null; }
      this.opts.send({ type: 'maint:exit', gen, code: code ?? 1 });
    };
    proc.once('exit', (code) => end(code));
    proc.once('error', (e) => {
      this.opts.send({ type: 'maint:error', gen, message: `The maintenance process failed: ${e?.message ?? e}` });
      setTimeout(() => end(proc.exitCode ?? 1), 50).unref?.();
    });
    // The init: the server's runtime settings (keys, caps), this launcher's own folders.
    const safeInit = isObj(init) ? { ...init } : {};
    safeInit.dataDir = this.opts.dataDir;
    safeInit.dbPath = this.opts.dbPath;
    try { proc.send({ t: 'init', init: safeInit } as never); } catch { /* 'exit' follows */ }
    this.log(`maint: started (pid ${proc.pid ?? '?'})`);
  }

  /** End the maint process (the server asked, or it exited). Its 'exit' tells the server. */
  kill(): void {
    const p = this.proc;
    if (!p) return;
    if (p.exitCode !== null || p.signalCode !== null) return;
    try { if (p.connected) p.send({ t: 'close' } as never); } catch { /* exiting */ }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, MAINT_KILL_GRACE_MS);
    t.unref?.();
    p.once('exit', () => clearTimeout(t));
  }

  /** The server child is gone: its maint process goes too (a new server child asks for its own). */
  serverGone(): void { this.kill(); }

  /** The launcher is stopping. Resolves when the maint process has exited. */
  async stop(): Promise<void> {
    this.stopped = true;
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const exited = new Promise<void>((r) => { p.once('exit', () => r()); });
    this.kill();
    await Promise.race([exited, new Promise<void>((r) => { setTimeout(r, MAINT_KILL_GRACE_MS + 500).unref?.(); })]);
  }
}

/** The maint process's entry beside the server's (app\server.mjs → app\maint.mjs). */
export const maintEntryBeside = (serverEntry: string): string => path.join(path.dirname(serverEntry), 'maint.mjs');
