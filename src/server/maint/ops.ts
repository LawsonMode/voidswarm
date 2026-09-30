// OWNER: SERVER MODERATION (LAN task B5). What the maintenance worker can do (docs/LAN-EDITION-proposal.md §5.16):
// the op types and the core ops (backups, disk, index upkeep, compaction, integrity, the ledger, a stream self-test).
// The panel's queries (B8a: maint/queries.ts) and chunked writes (B8b: maint/writes.ts) are more op tables of the
// same shape, added to registry.ts. An op never touches the game thread's connections: it gets the worker's own
// (ctx.read(): read-only; ctx.write(): read-write, busy_timeout 5000), both protected by db/guard.ts.
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { applyRetention, createBackup, listBackups, type CreateBackupResult } from './backups';
import { checkDisk, compactSpace } from './disk';
import { clearIndexDirty, indexDirtyRows } from './erase';
import { pepperIdOf } from './format';
import { applicableEntries, applyLedger, ledgerPath, nativeLineage, readLedger, recordingLineage } from './ledger';
import { isBackupReason } from './names';
import { MaintError, type MaintRuntime, type OpKind } from './protocol';

export interface OpContext {
  readonly dataDir: string;
  readonly dbPath: string;
  /** the current runtime settings (backup key, size cap, …) */
  readonly config: Readonly<MaintRuntime>;
  /** the worker's read-only connection (opened on first use) */
  read(): DatabaseSync;
  /** the worker's read-write connection (opened on first use) */
  write(): DatabaseSync;
  /** aborted when the caller cancels (or the worker closes) */
  readonly signal: AbortSignal;
  /** progress for the caller's onProgress */
  progress(p: unknown): void;
  log(line: string): void;
  /** yield to the worker's event loop between chunks */
  pause(): Promise<void>;
}

export interface CallOp<A = never, R = unknown> {
  kind: OpKind;
  run(args: A, ctx: OpContext): Promise<R> | R;
}

export interface StreamOp<A = never, T = unknown> {
  kind: 'read';
  /** emit(rows) resolves when the caller asked for the next page (or rejects when it cancelled) */
  stream(args: A, ctx: OpContext, emit: (rows: T[]) => Promise<void>): Promise<unknown> | unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOp = CallOp<any, unknown> | StreamOp<any, unknown>;
export type OpTable = Readonly<Record<string, AnyOp>>;

export const isStreamOp = (op: AnyOp): op is StreamOp<unknown, unknown> => typeof (op as StreamOp).stream === 'function';

const obj = (a: unknown): Record<string, unknown> => (a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {});
const fileSize = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };

/** FTS optimize cost (§5.16: about 1 s per 250k rows). */
export const OPTIMIZE_MS_PER_ROW = 1000 / 250_000;
/** VACUUM cost estimate (the "this takes about N s" line): ~50 MB/s. */
export const COMPACT_BYTES_PER_MS = 50 * 1024;

export const CORE_OPS: OpTable = {
  /** Liveness. */
  ping: { kind: 'read', run: () => ({ pong: true, at: Date.now() }) },

  /** Sizes, schema, rows, the index-tidy flag (log/stats and the Server panel's DB line). */
  'db.stats': {
    kind: 'read',
    run: (_a: unknown, ctx) => {
      const db = ctx.read();
      const userVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      let chatRows = 0;
      try { chatRows = Number((db.prepare('SELECT COUNT(*) AS n FROM chat_log').get() as { n: number }).n); } catch { /* no chat log */ }
      const dirty = indexDirtyRows(db);
      return {
        dbBytes: fileSize(ctx.dbPath), walBytes: fileSize(`${ctx.dbPath}-wal`), userVersion, chatRows,
        indexTidyPending: dirty > 0, indexDirtyRows: dirty, optimizeEstimateMs: Math.ceil(chatRows * OPTIMIZE_MS_PER_ROW),
      };
    },
  },

  /** Lines removed since the last FTS optimize (mod_meta.fts_dirty; cheap: no row count). MaintService polls it hourly. */
  'fts.pending': { kind: 'read', run: (_a: unknown, ctx) => ({ rows: indexDirtyRows(ctx.read()) }) },

  /** Free space on the data drive. */
  'disk.check': { kind: 'read', run: (_a: unknown, ctx) => checkDisk(ctx.dataDir) },

  /** The backups list (newest first). */
  'backup.list': { kind: 'read', run: (_a: unknown, ctx) => listBackups(ctx.dataDir, { key: ctx.config.backupKey }) },

  /** One backup: { reason, detail?, now?, ignoreDisk? }. Queued with the writes (a purge would make it restart). */
  'backup.create': {
    kind: 'backup',
    run: async (a: unknown, ctx): Promise<CreateBackupResult> => {
      const o = obj(a);
      if (!isBackupReason(o.reason)) throw new MaintError('EARGS', 'backup.create needs a reason.');
      if (!ctx.config.backupKey) return { ok: false, error: 'There is no backup key (data\\secrets\\backup.key): the backup was not made.', code: 'ENOKEY' };
      return createBackup({
        dataDir: ctx.dataDir, dbPath: ctx.dbPath, key: ctx.config.backupKey, reason: o.reason,
        detail: typeof o.detail === 'string' ? o.detail : null, appVersion: ctx.config.appVersion, installId: ctx.config.installId,
        pepperId: ctx.config.pepper ? pepperIdOf(ctx.config.pepper) : null,
        sizeCapMB: ctx.config.sizeCapMB, ignoreDisk: o.ignoreDisk === true, signal: ctx.signal,
        now: typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : undefined,
        onProgress: (p) => ctx.progress(p),
      });
    },
  },

  /** Apply the age and size caps now: { now? }. */
  'backup.retention': {
    kind: 'backup',
    run: (a: unknown, ctx) => {
      const now = obj(a).now;
      return { removed: applyRetention(ctx.dataDir, { sizeCapMB: ctx.config.sizeCapMB, key: ctx.config.backupKey, now: typeof now === 'number' && Number.isFinite(now) ? now : undefined }) };
    },
  },

  /** FTS optimize: drops the deleted rows' index entries (§0 fact 4). Holds the write lock ~1 s per 250k rows. */
  'fts.optimize': {
    kind: 'write',
    run: (_a: unknown, ctx) => {
      const db = ctx.write();
      const t = Date.now();
      const had = indexDirtyRows(db);
      db.exec("INSERT INTO chat_fts(chat_fts) VALUES('optimize')");
      clearIndexDirty(db);
      return { ms: Date.now() - t, tidied: had };
    },
  },

  /** Compact (VACUUM): needs twice the database size free (§5.16). The caller checks the quiet window. */
  'db.compact': {
    kind: 'write',
    run: async (_a: unknown, ctx) => {
      const before = fileSize(ctx.dbPath) + fileSize(`${ctx.dbPath}-wal`);
      const space = compactSpace(await checkDisk(ctx.dataDir), before);
      if (!space.ok) throw new MaintError('EDISK', space.text);
      const db = ctx.write();
      const t = Date.now();
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a reader holds it: next time */ }
      return { ms: Date.now() - t, beforeBytes: before, afterBytes: fileSize(ctx.dbPath) + fileSize(`${ctx.dbPath}-wal`) };
    },
  },

  /** PRAGMA quick_check (or integrity_check with { full: true }). */
  'db.integrity': {
    kind: 'read',
    run: (a: unknown, ctx) => {
      const rows = ctx.read().prepare(obj(a).full === true ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all() as Record<string, unknown>[];
      const messages = rows.map((r) => String(Object.values(r)[0] ?? ''));
      return { ok: messages.length === 1 && messages[0] === 'ok', messages: messages.slice(0, 20) };
    },
  },

  /**
   * Re-apply data\deletions.jsonl (after an import, or on demand). Idempotent. The live data's entries (its
   * lineage, stamped first when it has none: ledger.ts), those that carry none (recorded on it since the last
   * restore), and another data's account deletions whose account is here (applicableEntries); another data's purges
   * stay in the file, unapplied. Every pepper a username hash may be keyed with: this PC's and the ones a restore
   * replaced (pepper.previous.json).
   */
  'ledger.apply': {
    kind: 'write',
    run: async (_a: unknown, ctx) => {
      const { entries, bad } = readLedger(ledgerPath(ctx.dataDir));
      const db = ctx.write();
      const lineage = recordingLineage(db, ctx.config.backupKey ? nativeLineage(ctx.config.backupKey) : null);
      const scoped = applicableEntries(db, entries, lineage, { unscoped: true });
      const r = await applyLedger(db, scoped.entries, {
        pause: () => ctx.pause(), signal: ctx.signal, peppers: [ctx.config.pepper, ...(ctx.config.previousPeppers ?? [])],
      });
      return { ...r, badLines: bad, otherData: scoped.otherData, crossData: scoped.crossData, lineage };
    },
  },

  /** Diagnostics: wait { ms } (at most 60 s; cancellable); diag.sleepQueued waits in the write queue (≤ 5 s). */
  'diag.sleep': {
    kind: 'read',
    run: (a: unknown, ctx) => new Promise((resolve, reject) => {
      const ms = Math.min(60_000, Math.max(0, Math.floor(Number(obj(a).ms) || 0)));
      const t = setTimeout(() => resolve({ slept: ms }), ms);
      ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new MaintError('ECANCEL', 'The job was cancelled.')); }, { once: true });
    }),
  },
  'diag.sleepQueued': {
    kind: 'write',
    run: (a: unknown, ctx) => new Promise((resolve) => { setTimeout(() => resolve({ slept: true, at: Date.now() }), Math.min(5000, Math.max(0, Number(obj(a).ms) || 0))); void ctx; }),
  },

  /** A stream self-test: { n, pageSize } rows of { i }. */
  'diag.range': {
    kind: 'read',
    stream: async (a: unknown, ctx, emit: (rows: { i: number }[]) => Promise<void>) => {
      const o = obj(a);
      const n = Math.min(1_000_000, Math.max(0, Math.floor(Number(o.n) || 0)));
      const size = Math.min(10_000, Math.max(1, Math.floor(Number(o.pageSize) || 100)));
      let sent = 0;
      for (let i = 0; i < n; i += size) {
        if (ctx.signal.aborted) break;
        const rows: { i: number }[] = [];
        for (let j = i; j < Math.min(n, i + size); j++) rows.push({ i: j });
        await emit(rows);
        sent += rows.length;
      }
      return { sent };
    },
  },
};
