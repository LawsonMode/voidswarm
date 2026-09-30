// OWNER: SERVER MODERATION (LAN M1 gate; architect ruling HA, docs/LAN-EDITION-proposal.md §5.16 as amended).
//
// The maintenance worker as a SEPARATE sandboxed PROCESS. The LAN child runs under Node's --permission sandbox
// WITHOUT --allow-worker: on Node 24.16 a worker thread's permissions are not pinned to the process's (a Worker with
// `execArgv: []`, or an `env` holding NODE_OPTIONS, runs unsandboxed; measured by B4b), so the child can start no
// worker at all. Instead the launcher starts app\maint.mjs as a second child with the same sandbox flags (read the
// install, write only data\) and relays messages between the two over their IPC channels:
//
//   server child ──{type:'maint:spawn'|'maint:msg'|'maint:kill', gen}──▶ launcher ──{t:…}──▶ maint process
//   server child ◀──{type:'maint:msg'|'maint:exit'|'maint:error', gen}── launcher ◀──{t:…}── maint process
//
// The protocol is protocol.ts unchanged, with two adaptations for a channel that can't carry a MessagePort or bytes:
//  - a stream's MessagePort is replaced by `{t:'sp', id, m}` envelopes (the stream id is the call id): this side keeps
//    the port MaintClient made and bridges it; the maint process gives runMaintWorker a port-shaped object;
//  - Uint8Array values (the backup key, the peppers) travel as `{ $u8: base64 }` (the IPC channel is JSON).
//
// Nothing here trusts the other side's shapes: unknown messages are dropped. The launcher overrides dataDir / dbPath
// in the init with its own paths (src/lan/maintRelay.ts).
import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import type { MaintTransport, MaintTransportFactory } from './client';
import type { FromWorker, MaintInit, StreamToMain, StreamToWorker, ToWorker } from './protocol';

// ------------------------------------------------------------------------------------------
// Encoding (JSON-safe bytes)
// ------------------------------------------------------------------------------------------

const MAX_DEPTH = 64;

/** Deep copy with every Uint8Array (Buffer included) as `{ $u8: base64 }`. */
export function encodeMaint(v: unknown, depth = 0): unknown {
  if (v instanceof Uint8Array) return { $u8: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => encodeMaint(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = encodeMaint(x, depth + 1);
  return out;
}

/** The inverse of encodeMaint (`{ $u8 }` → Buffer). */
export function decodeMaint(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => decodeMaint(x, depth + 1));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === '$u8' && typeof o.$u8 === 'string') return Buffer.from(o.$u8, 'base64');
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decodeMaint(x, depth + 1);
  return out;
}

const isObj = (m: unknown): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m);

// ------------------------------------------------------------------------------------------
// The server child's side: a MaintTransport over its IPC channel to the launcher
// ------------------------------------------------------------------------------------------

/** The server child's IPC channel (app.ts ServerIpc has this shape). */
export interface MaintRelayChannel {
  send(msg: Record<string, unknown>): void;
  onMessage(cb: (msg: unknown) => void): () => void;
}

/** How long terminate() waits for the launcher's 'maint:exit' before reporting the exit itself. */
export const TERMINATE_WAIT_MS = 3000;

/**
 * A MaintClient transport factory that asks the launcher for a maint process (MaintClientOptions.transport). Each
 * spawn is a new generation; messages of an older one are ignored.
 */
export function ipcMaintTransport(channel: MaintRelayChannel): MaintTransportFactory {
  let generation = 0;
  return (data: { maint: MaintInit }): MaintTransport => {
    const gen = ++generation;
    const ee = new EventEmitter();
    // A transport error must not be an uncaught 'error' event: MaintClient listens, but only once it has one.
    ee.on('error', () => undefined);
    const streams = new Map<number, MessagePort>();
    let exited = false;
    const send = (m: Record<string, unknown>): void => { try { channel.send({ ...m, gen }); } catch { /* the launcher is gone */ } };
    const endStream = (id: number): void => {
      const p = streams.get(id);
      if (!p) return;
      streams.delete(id);
      try { p.close(); } catch { /* closed */ }
    };
    const finish = (code: number): void => {
      if (exited) return;
      exited = true;
      off();
      for (const id of [...streams.keys()]) endStream(id);
      ee.emit('exit', code);
    };
    const off = channel.onMessage((raw) => {
      if (!isObj(raw) || raw.gen !== gen || exited) return;
      if (raw.type === 'maint:msg') {
        const m = decodeMaint(raw.m);
        if (!isObj(m) || typeof m.t !== 'string') return;
        if (m.t === 'sp') {
          const id = Number(m.id);
          const port = streams.get(id);
          const inner = m.m as StreamToMain | undefined;
          if (!port || !isObj(inner)) return;
          try { port.postMessage(inner); } catch { /* the caller went away */ }
          if (inner.t === 'end' || inner.t === 'error') endStream(id);
          return;
        }
        ee.emit('message', m as unknown as FromWorker);
      } else if (raw.type === 'maint:exit') {
        finish(typeof raw.code === 'number' ? raw.code : 1);
      } else if (raw.type === 'maint:error') {
        ee.emit('error', new Error(typeof raw.message === 'string' ? raw.message.slice(0, 300) : 'The maintenance process failed.'));
      }
    });
    send({ type: 'maint:spawn', init: encodeMaint(data.maint) });
    const t: MaintTransport = {
      postMessage(m: ToWorker) {
        if (exited) throw new Error('The maintenance process has stopped.');
        if (m.t === 'stream') {
          const { port, ...rest } = m;
          streams.set(m.id, port);
          port.on('message', (x: StreamToWorker) => send({ type: 'maint:msg', m: encodeMaint({ t: 'sp', id: m.id, m: x }) }));
          send({ type: 'maint:msg', m: encodeMaint(rest) });
          return;
        }
        send({ type: 'maint:msg', m: encodeMaint(m) });
      },
      on(ev: string, cb: (...a: never[]) => void) { ee.on(ev, cb as (...a: unknown[]) => void); return t; },
      once(ev: string, cb: (...a: never[]) => void) { ee.once(ev, cb as (...a: unknown[]) => void); return t; },
      terminate() {
        if (exited) return Promise.resolve(0);
        send({ type: 'maint:kill' });
        return new Promise<number>((resolve) => {
          const timer = setTimeout(() => { finish(1); resolve(1); }, TERMINATE_WAIT_MS);
          timer.unref?.();
          ee.once('exit', (code: number) => { clearTimeout(timer); resolve(code); });
        });
      },
    } as MaintTransport;
    return t;
  };
}

// ------------------------------------------------------------------------------------------
// The maint process's side (app\maint.mjs --maint, started by the launcher)
// ------------------------------------------------------------------------------------------

/** What runMaintProcess needs of its process (tests pass a fake). */
export interface MaintProcessIo {
  send(m: unknown): void;
  on(ev: 'message', cb: (m: unknown) => void): void;
  on(ev: 'disconnect', cb: () => void): void;
  exit(code: number): void;
}

/** A port-shaped object for runMaintWorker's streams: messages go out as `{t:'sp', id, m}`. */
class EnvelopePort extends EventEmitter {
  constructor(private readonly id: number, private readonly out: (m: unknown) => void, private readonly onClose: () => void) { super(); }
  postMessage(x: unknown): void { this.out(encodeMaint({ t: 'sp', id: this.id, m: x })); }
  close(): void { this.onClose(); this.removeAllListeners(); }
}

/**
 * Run the maintenance worker in this process: wait for the launcher's `{t:'init', init}`, then serve protocol.ts
 * messages over IPC until `close` (or the launcher going away). `run` is worker.ts runMaintWorker.
 */
export function runMaintProcess(io: MaintProcessIo, run: (port: { postMessage(m: FromWorker): void; on(ev: 'message', cb: (m: ToWorker) => void): void; off?(ev: 'message', cb: (m: ToWorker) => void): void }, init: MaintInit) => { close(): void }): void {
  let started = false;
  let worker: { close(): void } | null = null;
  const listeners = new Set<(m: ToWorker) => void>();
  const ports = new Map<number, EnvelopePort>();
  const out = (m: unknown): void => { try { io.send(m); } catch { /* the launcher is gone */ } };
  let exiting = false;
  const leave = (code: number): void => {
    if (exiting) return;
    exiting = true;
    // Let the last message (closed) leave first.
    setTimeout(() => io.exit(code), 50);
  };
  io.on('disconnect', () => { try { worker?.close(); } catch { /* closing */ } leave(0); });
  io.on('message', (raw) => {
    const m = decodeMaint(raw);
    if (!isObj(m) || typeof m.t !== 'string') return;
    if (!started) {
      if (m.t !== 'init' || !isObj(m.init)) return;
      started = true;
      const init = m.init as unknown as MaintInit;
      worker = run({
        postMessage: (x: FromWorker) => {
          out(encodeMaint(x));
          if (x.t === 'closed') leave(0);
        },
        on: (_ev, cb) => { listeners.add(cb); },
        off: (_ev, cb) => { listeners.delete(cb); },
      }, init);
      return;
    }
    if (m.t === 'sp') {
      const p = ports.get(Number(m.id));
      if (p) p.emit('message', m.m);
      return;
    }
    let msg = m as unknown as ToWorker;
    if (m.t === 'stream') {
      const id = Number(m.id);
      const port = new EnvelopePort(id, out, () => { ports.delete(id); });
      ports.set(id, port);
      msg = { ...(m as object), port: port as unknown as MessagePort } as ToWorker;
    }
    for (const l of [...listeners]) { try { l(msg); } catch { /* the worker's own handler logs */ } }
  });
}
