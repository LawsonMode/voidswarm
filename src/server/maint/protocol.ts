// OWNER: SERVER MODERATION (LAN task B5). The maintenance worker's message protocol (docs/LAN-EDITION-proposal.md
// §5.16): the game thread (client.ts) ↔ the DB worker (worker.ts, bundled as app\maint.mjs). Structured-clone
// messages over the worker's parentPort; streamed results over a MessagePort per stream, with credit-based
// backpressure (the worker sends one page, then waits for 'more').
//
// Kinds of work (ops.ts): 'read' runs at once on the worker's read-only connection (panel reads, streams);
// 'write' (chunked writes: purges, deletions, optimize, compact) and 'backup' run one at a time in a queue, so a
// purge never makes a backup restart and two writers never fight for the lock.

import type { MessagePort } from 'node:worker_threads';

export const MAINT_PROTOCOL = 1;

export type OpKind = 'read' | 'write' | 'backup';

/** The settings the worker needs (workerData, then 'config' messages when they change). */
export interface MaintRuntime {
  /** data\secrets\backup.key (32 bytes), null when there is none (backups then refuse) */
  backupKey: Uint8Array | null;
  /** settings.backups.sizeCapMB */
  sizeCapMB: number | null;
  installId: string;
  appVersion: string;
  /** data\secrets\pepper.key: the ledger's username hashes are keyed with it (ledger.apply) */
  pepper?: Uint8Array | null;
  /** the peppers a restore replaced (data\secrets\pepper.previous.json): older ledger entries may be keyed with one */
  previousPeppers?: Uint8Array[];
}

export interface MaintInit extends MaintRuntime {
  v: number;
  dataDir: string;
  dbPath: string;
}

export interface MaintErrorShape { code: string; message: string }

export type ToWorker =
  | { t: 'call'; id: number; op: string; args?: unknown }
  | { t: 'stream'; id: number; op: string; args?: unknown; port: MessagePort }
  | { t: 'cancel'; id: number }
  | { t: 'config'; config: Partial<MaintRuntime> }
  | { t: 'close' };

export type FromWorker =
  | { t: 'ready'; v: number; ops: string[] }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: MaintErrorShape }
  | { t: 'progress'; id: number; progress: unknown }
  | { t: 'log'; line: string }
  | { t: 'closed' };

/** Over a stream's MessagePort. */
export type StreamToMain = { t: 'page'; rows: unknown[] } | { t: 'end'; value?: unknown } | { t: 'error'; error: MaintErrorShape };
export type StreamToWorker = { t: 'more' } | { t: 'cancel' };

export type MaintErrorCode =
  /** no such op in this worker */
  | 'EOP'
  /** the op's own failure (message says why) */
  | 'EFAIL'
  /** the worker died or was closed while the call was pending */
  | 'EWORKER'
  /** the call took longer than its timeout */
  | 'ETIMEOUT'
  /** cancelled (AbortSignal / stream cancel) */
  | 'ECANCEL'
  /** bad arguments */
  | 'EARGS'
  | (string & {});

export class MaintError extends Error {
  readonly code: MaintErrorCode;
  constructor(code: MaintErrorCode, message: string) {
    super(message);
    this.name = 'MaintError';
    this.code = code;
  }
}

export function toErrorShape(e: unknown): MaintErrorShape {
  if (e instanceof MaintError) return { code: e.code, message: e.message };
  if ((e as Error)?.name === 'AbortError') return { code: 'ECANCEL', message: 'The job was cancelled.' };
  const code = (e as { code?: unknown })?.code;
  return { code: typeof code === 'string' ? code : 'EFAIL', message: String((e as Error)?.message ?? e) };
}

export const fromErrorShape = (s: MaintErrorShape): MaintError => new MaintError(s.code, s.message);
