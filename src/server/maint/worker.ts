// OWNER: SERVER MODERATION (LAN task B5). The DB worker, app\maint.mjs (docs/LAN-EDITION-proposal.md §5.16,
// §2.3 entry `src/server/maint/worker.ts → app/maint.mjs`), one per server, with its own connections, so a 3 s panel
// query or a backup never holds the game thread. Two ways to run it:
//  - a worker_threads worker of the server (npm / VPS, tests);
//  - the LAN edition: a separate PROCESS (`app\maint.mjs --maint`) the launcher starts with the same --permission
//    sandbox as the server child (which has no --allow-worker: a worker's permissions are not pinned to the
//    process's on Node 24.16), relayed over IPC (ipcTransport.ts, src/lan/maintRelay.ts).
// Every connection is protected by db/guard.ts (the authorizer, trusted_schema OFF).
//
// Protocol: protocol.ts. 'read' ops run at once; 'write' and 'backup' ops run one at a time in a queue. Streams
// send one page and wait for the caller's 'more' (backpressure), and stop on 'cancel'. A thrown error goes back to
// the caller as { code, message }; the worker itself keeps running.
import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { runMaintProcess } from './ipcTransport';
import type { DatabaseSync } from 'node:sqlite';
import { openProtectedDb } from '../db/guard';
import { isStreamOp, type AnyOp, type OpContext, type OpTable } from './ops';
import { MAINT_PROTOCOL, MaintError, toErrorShape, type FromWorker, type MaintInit, type MaintRuntime, type StreamToMain, type StreamToWorker, type ToWorker } from './protocol';
import { MAINT_OPS } from './registry';

export interface WorkerHostPort {
  postMessage(m: FromWorker): void;
  on(ev: 'message', cb: (m: ToWorker) => void): void;
  off?(ev: 'message', cb: (m: ToWorker) => void): void;
}

const peppersOf = (list: unknown): Uint8Array[] =>
  (Array.isArray(list) ? list : []).filter((p): p is Uint8Array => p instanceof Uint8Array && p.length > 0).map((p) => new Uint8Array(p));

/**
 * The worker's logic, apart from worker_threads (so a test can run it in-process with a fake port). Returns a
 * close function.
 */
export function runMaintWorker(port: WorkerHostPort, init: MaintInit, ops: OpTable = MAINT_OPS): { close(): void } {
  const config: MaintRuntime = {
    backupKey: init.backupKey ? new Uint8Array(init.backupKey) : null,
    sizeCapMB: init.sizeCapMB ?? null,
    installId: init.installId ?? '',
    appVersion: init.appVersion ?? '',
    pepper: init.pepper ? new Uint8Array(init.pepper) : null,
    previousPeppers: peppersOf(init.previousPeppers),
  };
  let readDb: DatabaseSync | null = null;
  let writeDb: DatabaseSync | null = null;
  let closed = false;
  const jobs = new Map<number, AbortController>();
  let queue: Promise<unknown> = Promise.resolve();

  const post = (m: FromWorker): void => { if (!closed || m.t === 'closed') port.postMessage(m); };
  const log = (line: string): void => post({ t: 'log', line: `[maint] ${line}` });

  const read = (): DatabaseSync => {
    if (closed) throw new MaintError('EWORKER', 'The maintenance worker is closing.');
    if (!readDb) readDb = openProtectedDb(init.dbPath, { readOnly: true, busyTimeoutMs: 5000 });
    return readDb;
  };
  const write = (): DatabaseSync => {
    if (closed) throw new MaintError('EWORKER', 'The maintenance worker is closing.');
    if (!writeDb) writeDb = openProtectedDb(init.dbPath, { busyTimeoutMs: 5000 });
    return writeDb;
  };
  const pause = (): Promise<void> => new Promise((r) => setImmediate(r));

  const ctxFor = (id: number, ac: AbortController): OpContext => ({
    dataDir: init.dataDir, dbPath: init.dbPath, config, read, write, signal: ac.signal, log, pause,
    progress: (p) => post({ t: 'progress', id, progress: p }),
  });

  const lookup = (name: string): AnyOp => {
    const op = Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
    if (!op) throw new MaintError('EOP', `The maintenance worker has no op "${String(name).slice(0, 60)}".`);
    return op;
  };

  /** Run `fn` now (reads) or after the queued writes (write / backup). */
  const schedule = <T>(kind: AnyOp['kind'], fn: () => Promise<T>): Promise<T> => {
    if (kind === 'read') return fn();
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const onCall = (m: Extract<ToWorker, { t: 'call' }>): void => {
    const ac = new AbortController();
    jobs.set(m.id, ac);
    let op: AnyOp;
    try {
      op = lookup(m.op);
      if (isStreamOp(op)) throw new MaintError('EOP', `"${m.op}" is a stream: use stream().`);
    } catch (e) {
      jobs.delete(m.id);
      post({ t: 'result', id: m.id, ok: false, error: toErrorShape(e) });
      return;
    }
    const call = op;
    schedule(call.kind, async () => {
      if (ac.signal.aborted) throw new MaintError('ECANCEL', 'The job was cancelled.');
      return (call as Extract<AnyOp, { run: unknown }>).run(m.args as never, ctxFor(m.id, ac));
    }).then(
      (value) => post({ t: 'result', id: m.id, ok: true, value }),
      (e) => post({ t: 'result', id: m.id, ok: false, error: toErrorShape(e) }),
    ).finally(() => jobs.delete(m.id));
  };

  const onStream = (m: Extract<ToWorker, { t: 'stream' }>): void => {
    const sp: MessagePort = m.port;
    const ac = new AbortController();
    jobs.set(m.id, ac);
    let credit = 0;
    let wake: (() => void) | null = null;
    const onPort = (x: StreamToWorker): void => {
      if (x?.t === 'more') { credit++; wake?.(); } else if (x?.t === 'cancel') { ac.abort(); wake?.(); }
    };
    sp.on('message', onPort);
    const send = (x: StreamToMain): void => { try { sp.postMessage(x); } catch { /* the caller went away */ } };
    const finish = (x: StreamToMain): void => {
      send(x);
      sp.off('message', onPort);
      try { sp.close(); } catch { /* closed */ }
      jobs.delete(m.id);
    };
    // The first page is sent unasked; every later one waits for a 'more'.
    credit = 1;
    const emit = async (rows: unknown[]): Promise<void> => {
      while (credit <= 0 && !ac.signal.aborted) await new Promise<void>((r) => { wake = r; });
      wake = null;
      if (ac.signal.aborted) throw new MaintError('ECANCEL', 'The stream was cancelled.');
      credit--;
      send({ t: 'page', rows });
    };
    let op: AnyOp;
    try {
      op = lookup(m.op);
      if (!isStreamOp(op)) throw new MaintError('EOP', `"${m.op}" is not a stream: use call().`);
    } catch (e) {
      finish({ t: 'error', error: toErrorShape(e) });
      return;
    }
    const st = op;
    schedule(st.kind, async () => st.stream(m.args as never, ctxFor(m.id, ac), emit)).then(
      (value) => finish({ t: 'end', value }),
      (e) => finish({ t: 'error', error: toErrorShape(e) }),
    );
  };

  const onMessage = (m: ToWorker): void => {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'call': onCall(m); break;
      case 'stream': onStream(m); break;
      case 'cancel': jobs.get(m.id)?.abort(); break;
      case 'config': {
        const c = m.config ?? {};
        if ('backupKey' in c) config.backupKey = c.backupKey ? new Uint8Array(c.backupKey) : null;
        if ('sizeCapMB' in c) config.sizeCapMB = c.sizeCapMB ?? null;
        if (typeof c.installId === 'string') config.installId = c.installId;
        if (typeof c.appVersion === 'string') config.appVersion = c.appVersion;
        if ('pepper' in c) config.pepper = c.pepper ? new Uint8Array(c.pepper) : null;
        if ('previousPeppers' in c) config.previousPeppers = peppersOf(c.previousPeppers);
        break;
      }
      case 'close': {
        void close();
        break;
      }
      default: break;
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    for (const ac of jobs.values()) ac.abort();
    await queue.catch(() => undefined);
    closed = true;
    for (const db of [readDb, writeDb]) { try { db?.close(); } catch { /* closed */ } }
    readDb = null;
    writeDb = null;
    port.off?.('message', onMessage);
    post({ t: 'closed' });
  };

  port.on('message', onMessage);
  post({ t: 'ready', v: MAINT_PROTOCOL, ops: Object.keys(ops).sort() });
  return { close: () => { void close(); } };
}

// The maint-process entry (app\maint.mjs --maint, started by the LAN launcher with an IPC channel).
if (isMainThread && process.argv.includes('--maint') && typeof process.send === 'function') {
  runMaintProcess({
    send: (m) => { if (process.connected) process.send!(m); },
    on: (ev: 'message' | 'disconnect', cb: (m: unknown) => void) => { process.on(ev, cb); },
    exit: (code) => { process.exit(code); },
  } as Parameters<typeof runMaintProcess>[0], runMaintWorker);
}

// The worker_threads entry (app\maint.mjs).
if (!isMainThread && parentPort && (workerData as { maint?: MaintInit } | null)?.maint) {
  const init = (workerData as { maint: MaintInit }).maint;
  const p = parentPort;
  runMaintWorker({
    postMessage: (m) => p.postMessage(m),
    on: (ev, cb) => { p.on(ev, cb); },
    off: (ev, cb) => { p.off(ev, cb); },
  }, init);
}
