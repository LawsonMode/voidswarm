// OWNER: SERVER MODERATION (LAN task B5). The game-thread side of the maintenance worker (docs/LAN-EDITION-proposal.md
// §5.16): starts app\maint.mjs (or worker.ts under tsx in development and tests), sends calls, turns streamed pages
// into an async iterator with backpressure, and restarts a worker that died (at most 3 times in 10 minutes; calls
// pending at the crash fail with EWORKER, never hang).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import {
  MAINT_PROTOCOL, MaintError, fromErrorShape, type FromWorker, type MaintInit, type MaintRuntime, type StreamToMain, type ToWorker,
} from './protocol';

export const DEFAULT_CALL_TIMEOUT_MS = 10 * 60_000;
export const READY_TIMEOUT_MS = 20_000;
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;

/**
 * Where the worker is: next to the bundle (app\server.mjs → app\maint.mjs), or worker.ts beside this file when
 * running from source (then with the tsx loader, resolved from this project's node_modules).
 */
export function defaultWorkerFile(moduleUrl: string = import.meta.url): { file: URL; execArgv: string[] | undefined } {
  if (/\.ts$/i.test(fileURLToPath(moduleUrl))) {
    const file = new URL('./worker.ts', moduleUrl);
    // Already running under tsx (npm run server): the worker inherits the parent's flags, loader included.
    if (process.execArgv.some((a) => /tsx/.test(a))) return { file, execArgv: undefined };
    let loader = 'tsx';
    try {
      const req = createRequire(moduleUrl);
      loader = pathToFileURL(path.join(path.dirname(req.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href;
    } catch { /* fall back to the bare name */ }
    return { file, execArgv: ['--import', loader] };
  }
  return { file: new URL('./maint.mjs', moduleUrl), execArgv: [] };
}

/**
 * What MaintClient talks to: a worker_threads Worker (the default), or ipcTransport.ts's relay to a maint PROCESS
 * (the LAN child, which may start no worker thread: its sandbox has no --allow-worker). A Worker has this shape.
 */
export interface MaintTransport {
  postMessage(m: ToWorker, transfer?: readonly unknown[]): void;
  on(ev: 'message', cb: (m: FromWorker) => void): unknown;
  on(ev: 'error', cb: (e: Error) => void): unknown;
  on(ev: 'exit', cb: (code: number) => void): unknown;
  once(ev: 'exit', cb: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
}

/** Makes the transport for one start (the init goes with it). */
export type MaintTransportFactory = (data: { maint: MaintInit }) => MaintTransport;

export interface MaintClientOptions extends Partial<MaintRuntime> {
  dataDir: string;
  /** default <dataDir>\voidswarm.db */
  dbPath?: string;
  workerFile?: string | URL;
  /** extra Node flags for the worker (default: the tsx loader when running from source) */
  execArgv?: string[];
  log?: (line: string) => void;
  /** restart a worker that died (default true) */
  restart?: boolean;
  /** Where the worker runs (default: a worker_threads Worker of `workerFile`). */
  transport?: MaintTransportFactory;
  now?: () => number;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: unknown) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}

export interface MaintStream<T> extends AsyncIterable<T[]> {
  /** the op's return value, once the stream ended */
  readonly result: Promise<unknown>;
  cancel(): void;
}

export class MaintClient {
  private worker: MaintTransport | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Set<() => void>();
  private nextId = 1;
  private readyOps: string[] = [];
  private closing = false;
  private restarts: number[] = [];
  private runtime: MaintRuntime;
  private readonly init: Omit<MaintInit, keyof MaintRuntime>;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private starting: Promise<void> | null = null;
  /** why the worker is down for good (too many crashes), else null */
  failed: string | null = null;

  private constructor(private readonly opts: MaintClientOptions) {
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.runtime = {
      backupKey: opts.backupKey ?? null, sizeCapMB: opts.sizeCapMB ?? null, installId: opts.installId ?? '', appVersion: opts.appVersion ?? '',
      pepper: opts.pepper ?? null, previousPeppers: opts.previousPeppers ?? [],
    };
    this.init = { v: MAINT_PROTOCOL, dataDir: opts.dataDir, dbPath: opts.dbPath ?? path.join(opts.dataDir, 'voidswarm.db') };
  }

  /** Start the worker and wait until it is ready. */
  static async start(opts: MaintClientOptions): Promise<MaintClient> {
    const c = new MaintClient(opts);
    await c.spawn();
    return c;
  }

  get ready(): boolean { return !!this.worker && !this.closing; }
  /** The ops the running worker knows. */
  get ops(): readonly string[] { return this.readyOps; }
  /** The worker thread, or the transport to the maint process (tests). */
  get thread(): MaintTransport | null { return this.worker; }

  private spawn(): Promise<void> {
    if (this.starting) return this.starting;
    const def = defaultWorkerFile();
    const file = this.opts.workerFile ?? def.file;
    const execArgv = this.opts.execArgv ?? (this.opts.workerFile ? undefined : def.execArgv);
    const data: { maint: MaintInit } = { maint: { ...this.init, ...this.runtime } };
    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const w: MaintTransport = this.opts.transport
        ? this.opts.transport(data)
        : new Worker(file, { workerData: data, execArgv, stdout: false, stderr: false });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void w.terminate();
        reject(new MaintError('EWORKER', 'The maintenance worker did not start in time.'));
      }, READY_TIMEOUT_MS);
      w.on('message', (m: FromWorker) => {
        if (m?.t === 'ready' && !settled) {
          settled = true;
          clearTimeout(timer);
          if (m.v !== MAINT_PROTOCOL) {
            void w.terminate();
            reject(new MaintError('EWORKER', `The maintenance worker speaks protocol ${m.v}, this server ${MAINT_PROTOCOL}.`));
            return;
          }
          this.readyOps = m.ops;
          this.worker = w;
          resolve();
          return;
        }
        this.onMessage(m);
      });
      w.on('error', (e) => {
        this.log(`[maint] the worker failed: ${e?.message ?? e}`);
        if (!settled) { settled = true; clearTimeout(timer); reject(new MaintError('EWORKER', `The maintenance worker could not start: ${e?.message ?? e}`)); }
      });
      w.on('exit', (code) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new MaintError('EWORKER', `The maintenance worker exited at start (code ${code}).`)); }
        if (this.worker === w) this.onExit(code);
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private onExit(code: number): void {
    this.worker = null;
    this.readyOps = [];
    const err = new MaintError('EWORKER', `The maintenance worker stopped (code ${code}).`);
    for (const [id, p] of this.pending) { this.pending.delete(id); p.cleanup(); p.reject(err); }
    for (const end of this.streams) end();
    this.streams.clear();
    if (this.closing || this.opts.restart === false) return;
    const t = this.now();
    this.restarts = this.restarts.filter((x) => t - x < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.failed = 'The maintenance worker kept stopping: panel searches, exports and backups are unavailable until the host restarts.';
      this.log(`[maint] ${this.failed}`);
      return;
    }
    this.restarts.push(t);
    this.log(`[maint] the worker stopped (code ${code}); restarting it`);
    this.spawn().catch((e) => { this.failed = String((e as Error)?.message ?? e); this.log(`[maint] restart failed: ${this.failed}`); });
  }

  private onMessage(m: FromWorker): void {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'log') { this.log(String(m.line).slice(0, 500)); return; }
    if (m.t === 'progress') { this.pending.get(m.id)?.onProgress?.(m.progress); return; }
    if (m.t === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      p.cleanup();
      if (m.ok) p.resolve(m.value); else p.reject(fromErrorShape(m.error));
    }
  }

  private async live(): Promise<MaintTransport> {
    if (this.closing) throw new MaintError('EWORKER', 'The maintenance worker is closed.');
    if (!this.worker && this.starting) await this.starting;
    if (!this.worker) throw new MaintError('EWORKER', this.failed ?? 'The maintenance worker is not running.');
    return this.worker;
  }

  private send(w: MaintTransport, m: ToWorker, transfer?: readonly unknown[]): void {
    w.postMessage(m, transfer);
  }

  /** Run one op in the worker. Rejects with MaintError (EOP, EFAIL, EWORKER, ETIMEOUT, ECANCEL, …). */
  async call<R = unknown>(op: string, args?: unknown, opts: CallOptions = {}): Promise<R> {
    const w = await this.live();
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const onAbort = (): void => {
        try { this.send(w, { t: 'cancel', id }); } catch { /* gone */ }
      };
      const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try { this.send(w, { t: 'cancel', id }); } catch { /* gone */ }
        reject(new MaintError('ETIMEOUT', `${op} took longer than ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs) : null;
      timer?.unref?.();
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress, timer, cleanup });
      if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send(w, { t: 'call', id, op, args });
      } catch (e) {
        this.pending.delete(id);
        cleanup();
        reject(new MaintError('EARGS', `${op}: the arguments can't be sent to the worker (${(e as Error)?.message ?? e}).`));
      }
    });
  }

  /**
   * Run a streaming op: pages of rows as an async iterator. The worker sends the next page only after this side
   * took the previous one (backpressure). Breaking out of the loop, cancel() or the signal stop the worker's op.
   */
  stream<T = unknown>(op: string, args?: unknown, opts: { signal?: AbortSignal } = {}): MaintStream<T> {
    const queue: T[][] = [];
    let done = false;
    let error: Error | null = null;
    let wake: (() => void) | null = null;
    let resolveResult!: (v: unknown) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<unknown>((res, rej) => { resolveResult = res; rejectResult = rej; });
    result.catch(() => undefined);
    const { port1, port2 } = new MessageChannel();
    let started = false;
    const end = (e: Error | null, value?: unknown): void => {
      if (done) return;
      done = true;
      error = e;
      try { port1.close(); } catch { /* closed */ }
      this.streams.delete(onWorkerGone);
      if (e) rejectResult(e); else resolveResult(value);
      wake?.();
    };
    const onWorkerGone = (): void => end(new MaintError('EWORKER', 'The maintenance worker stopped during the stream.'));
    port1.on('message', (m: StreamToMain) => {
      if (m?.t === 'page') { queue.push(m.rows as T[]); wake?.(); } else if (m?.t === 'end') end(null, m.value);
      else if (m?.t === 'error') end(fromErrorShape(m.error));
    });
    const cancel = (): void => {
      if (done) return;
      try { port1.postMessage({ t: 'cancel' }); } catch { /* closed */ }
      end(new MaintError('ECANCEL', 'The stream was cancelled.'));
    };
    opts.signal?.addEventListener('abort', cancel, { once: true });
    const startIt = async (): Promise<void> => {
      if (started) return;
      started = true;
      try {
        const w = await this.live();
        this.streams.add(onWorkerGone);
        w.postMessage({ t: 'stream', id: this.nextId++, op, args, port: port2 } satisfies ToWorker, [port2 as never]);
      } catch (e) {
        end(e as Error);
      }
    };
    return {
      result,
      cancel,
      [Symbol.asyncIterator](): AsyncIterator<T[]> {
        void startIt();
        return {
          async next(): Promise<IteratorResult<T[]>> {
            for (;;) {
              if (queue.length) {
                const rows = queue.shift()!;
                if (!done) { try { port1.postMessage({ t: 'more' }); } catch { /* closed */ } }
                return { value: rows, done: false };
              }
              if (done) {
                if (error && (error as MaintError).code !== 'ECANCEL') throw error;
                return { value: undefined, done: true };
              }
              await new Promise<void>((r) => { wake = r; });
              wake = null;
            }
          },
          async return(): Promise<IteratorResult<T[]>> {
            cancel();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  /** Tell the worker about changed settings (a new size cap, a restored backup key). */
  setConfig(patch: Partial<MaintRuntime>): void {
    this.runtime = { ...this.runtime, ...patch };
    const w = this.worker;
    if (w) { try { this.send(w, { t: 'config', config: patch }); } catch { /* gone: the next spawn has it */ } }
  }

  /** Stop the worker: running jobs are cancelled, the connections closed. */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const w = this.worker ?? (this.starting ? await this.starting.then(() => this.worker, () => null) : null);
    if (!w) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { void w.terminate().finally(resolve); }, timeoutMs);
      w.on('message', (m: FromWorker) => {
        if (m?.t === 'closed') { clearTimeout(t); void w.terminate().finally(resolve); }
      });
      w.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.send(w, { t: 'close' }); } catch { clearTimeout(t); void w.terminate().finally(resolve); }
    });
    this.worker = null;
    const err = new MaintError('EWORKER', 'The maintenance worker is closed.');
    for (const [id, p] of this.pending) { this.pending.delete(id); p.cleanup(); p.reject(err); }
  }
}
