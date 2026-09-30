// OWNER: SERVER MODERATION (LAN task B5). Encrypted backups of the data folder (docs/LAN-EDITION-proposal.md §6.1):
// voidswarm.db (a node:sqlite backup() snapshot), voidswarm.config.json and deletions.jsonl, in one
// data\backups\<stamp>_<reason>.vsbak (format.ts). Never secrets\, tls\, logs\ or exports\.
//
// These functions are plain async code with no worker assumptions: the maintenance worker runs them for the live
// server (worker.ts), and the launcher and the tools (restore, update) call them directly while no server runs.
// The retention rules (retention.ts) run on the folder before and after each backup, whether or not it is made (a
// skipped or failed backup never keeps old ones past 35 days, and removing them is what frees the space), and on
// their own every hour (MaintService). A backup is skipped, with a banner, when the data drive is low (disk.ts).
// copyBackups() is the parent's off-PC copy (the sandboxed child can't write there), into a folder of this install's
// own in the target, touching only files made with this install's backup key.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { protectConnection } from '../db/guard';
import { backupSpace, checkDisk, type Banner, type DiskStatus, type StatfsFn } from './disk';
import { BackupError, keyIdOf, readBackupFile, readBackupHeader, writeBackupFile, type ExtractResult, type SourceFile } from './format';
import { openFileSecrets } from '../secrets';
import { ERASE_MIN_SCHEMA } from './erase';
import { dbLineage, ensureLineage, LEDGER_FILE, nativeLineage } from './ledger';
import { BACKUP_EXT, BACKUPS_DIR, backupFileName, compareNewestFirst, isBackupReason, parseBackupName, type BackupClass, type BackupReason } from './names';
import { readPendingRestore } from './restoreStage';
import { planRetention, retentionPolicy, DAY_MS } from './retention';

/** node:sqlite backup rate meaning "every page in one step" (a positive int32; -1 is refused on Node 24.21+). */
const ALL_PAGES_AT_ONCE = 0x7fffffff;

export const DB_FILE = 'voidswarm.db';
export const CONFIG_FILE = 'voidswarm.config.json';
/** A start backup runs when the last one is older than this (§6.1). */
export const START_BACKUP_AFTER_MS = 6 * 60 * 60_000;
/** The off-PC copy banner (§6.1). */
export const OFFPC_BANNER_AFTER_MS = 30 * DAY_MS;
export const OFFPC_STATE_FILE = 'offpc.json';
/** Leftover snapshot / temp files (a crash mid-backup) older than this are removed. */
export const STALE_TEMP_MS = 60 * 60_000;

export const backupsDir = (dataDir: string): string => path.join(dataDir, BACKUPS_DIR);
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

export interface BackupInfo {
  name: string;
  file: string;
  cls: BackupClass;
  detail: string | null;
  /** from the name (local-time stamp); the file's mtime for a name that isn't ours; never later than now for `future` */
  createdAt: number;
  seq: number;
  size: number;
  encrypted: true;
  /** the header's key id (null: unreadable header) */
  keyId: string | null;
  /** made with this install's backup.key (null when no key was given to compare) */
  ownKey: boolean | null;
  /** named by Voidswarm: only these are rotated by the retention rules */
  managed: boolean;
  /**
   * The name's stamp is more than an hour ahead of now: it never counts as "the last backup" for the schedule, and
   * the retention rules leave it alone. When the file's own mtime is sane (a file copied in under a wrong name), the
   * retention pass renames it to its mtime so it ages out like any other; when the mtime is ahead too, the clock is
   * behind now (a flat CMOS battery before NTP syncs) or was ahead when it was made, which can't be told apart: it is
   * kept as it is, with the "dated later than this PC's clock" banner (clockBanner), never deleted on that guess.
   */
  future: boolean;
  /** the name's stamp (the file's mtime for a name that isn't ours), as it is, even when it is ahead of now */
  stampAt: number;
  /** the file's last-modified time */
  mtimeMs: number;
}

/** A stamp this far ahead of now is a clock problem, not a backup made "later today" (DST shifts are 1 h). */
export const FUTURE_STAMP_SLACK_MS = 60 * 60_000;

/**
 * The header key ids listBackups has read, by file (and its inode, size and mtime, so a replaced or rewritten file is
 * read again): the panel polls the list on the game thread, and re-opening every .vsbak for its header each time is
 * the costly part. Bounded; a miss only costs the read.
 */
const headerCache = new Map<string, { sig: string; keyId: string | null }>();
const HEADER_CACHE_MAX = 4096;

function cachedKeyId(file: string, st: fs.Stats): string | null {
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = headerCache.get(file);
  if (hit && hit.sig === sig) return hit.keyId;
  let keyId: string | null = null;
  try { keyId = readBackupHeader(file).keyId; } catch { keyId = null; }
  if (headerCache.size >= HEADER_CACHE_MAX) headerCache.clear();
  headerCache.set(file, { sig, keyId });
  return keyId;
}

/** The backups in data\backups, newest first. Never throws for one bad file. */
export function listBackups(dataDir: string, opts: { key?: Uint8Array | null; now?: number } = {}): BackupInfo[] {
  const dir = backupsDir(dataDir);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const own = opts.key ? keyIdOf(opts.key) : null;
  const now = opts.now ?? Date.now();
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(BACKUP_EXT) || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const keyId = cachedKeyId(file, st);
    const p = parseBackupName(name);
    const stamped = p?.at ?? st.mtimeMs;
    const future = stamped > now + FUTURE_STAMP_SLACK_MS;
    out.push({
      name, file, cls: p?.cls ?? 'other', detail: p?.detail ?? null, createdAt: future ? Math.min(st.mtimeMs, now) : stamped, seq: p?.seq ?? 1, size: st.size,
      encrypted: true, keyId, ownKey: own && keyId ? own === keyId : null, managed: !!p && keyId !== null, future, stampAt: stamped, mtimeMs: st.mtimeMs,
    });
  }
  return out.sort((a, b) => compareNewestFirst({ at: a.createdAt, seq: a.seq }, { at: b.createdAt, seq: b.seq }));
}

/** The newest backup's time (any class), or null. Future-stamped files don't count (they would stop every backup). */
export const lastBackupAt = (list: readonly BackupInfo[]): number | null => {
  const ok = list.filter((b) => !b.future);
  return ok.length ? Math.max(...ok.map((b) => b.createdAt)) : null;
};

/** The newest daily or weekly backup's time (the daily schedule), or null. */
export const lastDailyAt = (list: readonly BackupInfo[]): number | null =>
  lastBackupAt(list.filter((b) => b.cls === 'daily' || b.cls === 'weekly'));

/** §6.1 "at start, when a migration is pending or the last backup is more than 6 h old". */
export function startBackupReason(o: { migrationPending: boolean; lastBackupAt: number | null; now: number; dbExists: boolean }): BackupReason | null {
  if (!o.dbExists) return null;
  if (o.migrationPending) return 'pre-migration';
  if (o.lastBackupAt === null || o.now - o.lastBackupAt > START_BACKUP_AFTER_MS) return 'start';
  return null;
}

/** The process id in a temp file's name: `.snapshot-<pid>-<hex>.db[-wal…]` or `.<name>.<pid>.<hex>.tmp`; else null. */
export function tempFilePid(name: string): number | null {
  const m = /^\.snapshot-(\d{1,10})-[0-9a-f]+\.db(?:-wal|-shm|-journal)?$/.exec(name) ?? /\.(\d{1,10})\.[0-9a-f]+\.tmp$/.exec(name);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a process with this id may be running: only ESRCH ("no such process") says it is gone. */
export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

/**
 * Remove leftover snapshot and temp files of interrupted backups. Returns how many. A snapshot is a PLAINTEXT copy of
 * the whole database, so one whose process is gone (a crash or power cut mid-backup) goes at once; any other goes once
 * it is an hour old (`alive` is for tests).
 */
export function cleanupBackupTemp(dataDir: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): number {
  const dir = backupsDir(dataDir);
  let n = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!(name.startsWith('.snapshot-') || (name.startsWith('.') && name.endsWith('.tmp')))) continue;
    const f = path.join(dir, name);
    try {
      const pid = tempFilePid(name);
      const orphan = pid !== null && !alive(pid);
      if (!orphan && now - fs.statSync(f).mtimeMs < STALE_TEMP_MS) continue;
      fs.rmSync(f, { force: true });
      n++;
    } catch { /* in use */ }
  }
  return n;
}

export interface CreateBackupOptions {
  dataDir: string;
  /** default <dataDir>\voidswarm.db */
  dbPath?: string;
  /** data\secrets\backup.key */
  key: Uint8Array;
  reason: BackupReason;
  detail?: string | null;
  now?: number;
  appVersion?: string;
  installId?: string;
  /** pepperIdOf(data\secrets\pepper.key): recorded in the manifest so a restore puts the matching pepper back */
  pepperId?: string | null;
  /** settings.backups.sizeCapMB */
  sizeCapMB?: number | null;
  /** a fresh disk status, else one is measured with `statfs` */
  disk?: DiskStatus | null;
  statfs?: StatfsFn;
  /** skip the disk rule (tests of the file format) */
  ignoreDisk?: boolean;
  /** an open connection to snapshot (the worker's); else a read-only protected one is opened and closed */
  source?: DatabaseSync;
  /**
   * backup() pages per step. Default -1: the whole file in one step. A stepped backup() restarts from the first page
   * whenever ANOTHER connection writes between two steps (SQLite's rule), so under a live server's chat writes it
   * never finishes (measured: 200k rows at 100 pages a step with a write every 1 ms ran past 2 minutes). One step
   * runs off the JS thread (1M rows, 110 MB: 341 ms with the event loop's worst gap 7 ms) and in WAL mode it blocks
   * no writer; it copies a consistent snapshot as of its start.
   */
  pagesPerStep?: number;
  /** run the retention rules before and after (default true) */
  retention?: boolean;
  /**
   * Stamp the live database's data lineage (ledger.ts) first when it has none (default true; stampLineage). A
   * restore's safety backup passes false: a refused restore leaves the current database exactly as it was, and the
   * restore attributes an unstamped current database to this install's native lineage anyway.
   */
  stampLineage?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: { stage: 'snapshot' | 'encrypt' | 'retention'; done?: number; total?: number }) => void;
}

export type CreateBackupResult =
  | { ok: true; name: string; file: string; size: number; ms: number; schemaVersion: number | null; removed: string[] }
  | { ok: false; skipped: 'disk'; text: string; disk: DiskStatus | null }
  | { ok: false; skipped: 'no-db'; text: string }
  | { ok: false; error: string; code?: string };

/**
 * Give the live database its data lineage (the deletion ledger's: ledger.ts) when it has none yet: nativeLineage of
 * the backup key it is backed up with, the same value an unstamped database would count as. From then on the data
 * keeps it, in this backup and every later one, even when data\secretsackup.key is lost and made again (a new
 * key would otherwise give the same data a second lineage, and the old key's backups would take this install's later
 * purges for another copy's). Only at the current schema (a pre-migration backup never changes the database), and
 * best effort: a database that can't be written now is stamped at a later backup (or by a deletion). Returns whether
 * it stamped.
 */
export function stampLineage(src: DatabaseSync, dbPath: string, key: Uint8Array, schemaVersion: number): boolean {
  if (!(schemaVersion >= ERASE_MIN_SCHEMA) || dbLineage(src) !== null) return false;
  let w: DatabaseSync | null = null;
  try {
    w = new DatabaseSync(dbPath);
    protectConnection(w);
    w.exec('PRAGMA busy_timeout = 5000');
    if (dbLineage(w) !== null) return false;
    ensureLineage(w, nativeLineage(key));
    return true;
  } catch {
    return false;
  } finally {
    try { w?.close(); } catch { /* closed */ }
  }
}

function readSmall(file: string, max: number): Buffer | null {
  try {
    const st = fs.statSync(file);
    if (st.size > max) throw new Error(`${path.basename(file)} is larger than ${max} bytes`);
    return fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

const dbBytes = (dbPath: string): number => {
  let n = 0;
  for (const f of [dbPath, `${dbPath}-wal`]) { try { n += fs.statSync(f).size; } catch { /* none */ } }
  return n;
};

/** Make one encrypted backup (see the file header). Never throws: failures come back as `{ ok: false, error }`. */
export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const dbPath = opts.dbPath ?? path.join(opts.dataDir, DB_FILE);
  const dir = backupsDir(opts.dataDir);
  // The caps apply whether or not this backup gets made (and removing old ones is what frees space on a low disk).
  const removedBefore = opts.retention !== false ? applyRetention(opts.dataDir, { now, sizeCapMB: opts.sizeCapMB, key: opts.key }) : [];
  if (!opts.source && !fs.existsSync(dbPath)) return { ok: false, skipped: 'no-db', text: 'There is no database to back up yet.' };
  if (!opts.ignoreDisk) {
    const disk = opts.disk ?? await checkDisk(opts.dataDir, { statfs: opts.statfs, now });
    const space = backupSpace(disk, dbBytes(dbPath));
    if (!space.ok) return { ok: false, skipped: 'disk', text: space.text, disk };
  }
  let snapshot: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    cleanupBackupTemp(opts.dataDir, now);
    snapshot = path.join(dir, `.snapshot-${process.pid}-${randomBytes(4).toString('hex')}.db`);
    let src = opts.source ?? null;
    let opened = false;
    if (!src) {
      src = new DatabaseSync(dbPath, { readOnly: true });
      opened = true;
    }
    let schemaVersion: number | null;
    try {
      if (opened) {
        protectConnection(src);
        src.exec('PRAGMA busy_timeout = 5000');
      }
      schemaVersion = Number((src.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (opened && opts.stampLineage !== false) stampLineage(src, dbPath, opts.key, schemaVersion);
      await sqliteBackup(src, snapshot, {
        // Node 24.21+ rejects rate -1 ("all at once"); a huge positive step copies everything in one step on every 24.x.
        rate: opts.pagesPerStep && opts.pagesPerStep > 0 ? Math.floor(opts.pagesPerStep) : ALL_PAGES_AT_ONCE,
        progress: ({ totalPages, remainingPages }) => opts.onProgress?.({ stage: 'snapshot', done: totalPages - remainingPages, total: totalPages }),
      });
    } finally {
      if (opened) { try { src.close(); } catch { /* closed */ } }
    }
    if (opts.signal?.aborted) throw new Error('cancelled');
    const files: SourceFile[] = [{ name: 'voidswarm.db', path: snapshot }];
    const config = readSmall(path.join(opts.dataDir, CONFIG_FILE), 1024 * 1024);
    if (config) files.push({ name: 'voidswarm.config.json', data: config });
    const ledger = readSmall(path.join(opts.dataDir, LEDGER_FILE), 256 * 1024 * 1024);
    if (ledger) files.push({ name: 'deletions.jsonl', data: ledger });
    const name = backupFileName(opts.reason, now, { detail: opts.detail, taken: (n) => fs.existsSync(path.join(dir, n)) });
    const file = path.join(dir, name);
    opts.onProgress?.({ stage: 'encrypt' });
    const size = await writeBackupFile(file, opts.key, {
      createdAt: now, reason: opts.reason, detail: opts.detail ?? null, appVersion: opts.appVersion ?? '', schemaVersion,
      installId: opts.installId ?? '', pepperId: opts.pepperId ?? null,
    }, files, { signal: opts.signal });
    let removed: string[] = removedBefore;
    if (opts.retention !== false) {
      opts.onProgress?.({ stage: 'retention' });
      removed = [...removedBefore, ...applyRetention(opts.dataDir, { now, sizeCapMB: opts.sizeCapMB, keep: name, key: opts.key })];
    }
    return { ok: true, name, file, size, ms: Date.now() - started, schemaVersion, removed };
  } catch (e) {
    const code = e instanceof BackupError ? e.code : (e as NodeJS.ErrnoException)?.code;
    return { ok: false, error: `The backup failed: ${errMsg(e)}`, code: typeof code === 'string' ? code : undefined };
  } finally {
    if (snapshot) for (const f of [snapshot, `${snapshot}-wal`, `${snapshot}-shm`, `${snapshot}-journal`]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  }
}

/** A future-stamped backup whose file is ahead of now too: the clock is wrong now, or was when it was made. */
export const aheadOfClock = (b: BackupInfo, now: number): boolean => b.future && b.mtimeMs > now + FUTURE_STAMP_SLACK_MS;

/**
 * Give a future-stamped backup (FUTURE_STAMP_SLACK_MS ahead) whose file has a sane mtime the stamp of that mtime, so
 * it ages out like the others instead of never. Never a stamp earlier than the mtime, and never when the mtime is
 * ahead of now as well (aheadOfClock): with a clock that is behind now, "now" is the wrong time, and renaming every
 * backup to it would have them all deleted as soon as the clock is right. Returns the new name (null: left as it was).
 */
function restampFuture(dataDir: string, b: BackupInfo, now: number): string | null {
  if (!b.future || !b.managed || !isBackupReason(b.cls) || aheadOfClock(b, now)) return null;
  const dir = backupsDir(dataDir);
  try {
    const name = backupFileName(b.cls, b.mtimeMs, { detail: b.detail, taken: (n) => fs.existsSync(path.join(dir, n)) });
    fs.renameSync(b.file, path.join(dir, name));
    return name;
  } catch {
    return null;
  }
}

/**
 * The banner for backups dated later than this PC's clock (kept untouched: see BackupInfo.future), or null. Both
 * causes are named, since they can't be told apart from here.
 */
export function clockBanner(list: readonly BackupInfo[], now: number): Banner | null {
  const ahead = list.filter((b) => b.managed && aheadOfClock(b, now));
  if (!ahead.length) return null;
  const newest = new Date(Math.max(...ahead.map((b) => b.stampAt)));
  const when = newest.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return {
    code: 'clock-behind', level: 'warn',
    text: `${ahead.length} backup(s) are dated later than this PC's clock (up to ${when}). If the clock is wrong, set it `
      + '(Windows Settings → Time & language → Date & time → Sync now): until then those backups are kept as they are. '
      + 'If the clock is right, they were made while it was wrong: they are kept until you delete them from data\\backups.',
  };
}

/**
 * Apply the age and size caps to data\backups. Returns the names deleted. Never deleted: `keep`, and the backup a
 * staged restore is waiting for (data\restore.pending.json), and any future-stamped file (restampFuture renames the
 * ones whose mtime is sane first; the others are kept as they are: see BackupInfo.future).
 *
 * The caps count the backups of each backup key apart: another install's backups, copied in to bring its data across
 * (§6.3), never push this install's own out, nor are they pushed out by them before the restore tool runs. With
 * `key` (this install's backup.key) the others keep the age and per-class caps but not the size cap, which is this
 * install's budget; without it every key gets the whole policy.
 */
export function applyRetention(dataDir: string, o: { now?: number; sizeCapMB?: number | null; keep?: string; key?: Uint8Array | null } = {}): string[] {
  const now = o.now ?? Date.now();
  const pending = readPendingRestore(dataDir)?.backup ?? null;
  let list = listBackups(dataDir, { now });
  if (list.some((b) => b.future && b.managed)) {
    for (const b of list) restampFuture(dataDir, b, now);
    list = listBackups(dataDir, { now });
  }
  const own = o.key && o.key.length === 32 ? keyIdOf(o.key) : null;
  const groups = new Map<string, (BackupInfo & { at: number })[]>();
  for (const b of list) {
    if (!b.managed || b.future || !b.keyId) continue;
    const g = groups.get(b.keyId) ?? [];
    g.push({ ...b, at: b.createdAt });
    groups.set(b.keyId, g);
  }
  const policy = retentionPolicy(o.sizeCapMB);
  const removed: string[] = [];
  for (const [keyId, items] of groups) {
    const foreign = own !== null && keyId !== own;
    const plan = planRetention(items, now, foreign ? { ...policy, sizeCapBytes: Number.MAX_SAFE_INTEGER } : policy);
    for (const { item } of plan.remove) {
      if (item.name === o.keep || item.name === pending) continue;
      try { fs.rmSync(item.file, { force: true }); removed.push(item.name); } catch { /* next time */ }
    }
  }
  return removed;
}

/** Decrypt a backup into `destDir` (format.ts readBackupFile). */
export function extractBackup(file: string, key: Uint8Array, destDir: string): Promise<ExtractResult> {
  return readBackupFile(file, key, destDir);
}

/** The total size of the backups, and the cap (the Server panel's "total against the cap"). */
export function backupTotals(list: readonly BackupInfo[], sizeCapMB?: number | null): { totalBytes: number; capBytes: number } {
  return { totalBytes: list.reduce((s, b) => s + b.size, 0), capBytes: retentionPolicy(sizeCapMB).sizeCapBytes };
}

// ------------------------------------------------------------------------------------------
// Off-PC copy (the launcher runs it after each backup; §6.1 "Also copy backups to")
// ------------------------------------------------------------------------------------------

export interface OffPcState {
  /** the last successful copy (0: none yet) */
  at: number;
  target: string;
  copied: number;
  error: string | null;
  /**
   * When this install started counting (MaintService.start writes it the first time; 0 = unknown, an older file):
   * the 30 days before the banner count from here until the first copy.
   */
  since: number;
}

export const offPcStatePath = (dataDir: string): string => path.join(backupsDir(dataDir), OFFPC_STATE_FILE);

export function readOffPcState(dataDir: string): OffPcState | null {
  try {
    const o = JSON.parse(fs.readFileSync(offPcStatePath(dataDir), 'utf8')) as Record<string, unknown>;
    if (typeof o.at !== 'number') return null;
    return {
      at: o.at, target: typeof o.target === 'string' ? o.target : '', copied: typeof o.copied === 'number' ? o.copied : 0,
      error: typeof o.error === 'string' ? o.error : null, since: typeof o.since === 'number' && Number.isFinite(o.since) ? o.since : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Start the off-PC clock the first time (MaintService.start): the "no off-PC copy for 30 days" banner then counts
 * from this install's first start until a copy is made. The age of the oldest backup can't serve: the retention caps
 * keep it under 30 days for most hosts (4 weekly ones reach back 28 days), so the banner would never show.
 */
export function ensureOffPcState(dataDir: string, now = Date.now()): OffPcState {
  const cur = readOffPcState(dataDir);
  if (cur && cur.since > 0) return cur;
  const next: OffPcState = cur ? { ...cur, since: cur.at > 0 ? cur.at : now } : { at: 0, target: '', copied: 0, error: null, since: now };
  writeOffPcState(dataDir, next);
  return next;
}

function writeOffPcState(dataDir: string, s: OffPcState): void {
  const file = offPcStatePath(dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* the banner just stays */ }
}

export interface CopyBackupsResult {
  ok: boolean;
  /** the folder the copies are in: <target>\Voidswarm backups <key id> */
  folder: string;
  copied: string[];
  removed: string[];
  /** names left alone because a file made by another copy of Voidswarm (another key) holds that name there */
  conflicts: string[];
  error: string | null;
  at: number;
}

/** The copy folder's prefix; its name ends with the first 8 hex of this install's backup key id. */
export const OFFPC_FOLDER_PREFIX = 'Voidswarm backups ';
/**
 * The folder in `target` that holds this install's copies. One per backup key, so several hosts can share one
 * district folder without their same-minute backups colliding or their retention passes deleting each other's.
 */
export const offPcFolder = (target: string, keyId: string): string => path.join(target, `${OFFPC_FOLDER_PREFIX}${keyId.slice(0, 8)}`);

/** The header key id of a file, or null (missing, or not a backup). */
function headerKeyId(file: string): string | null {
  try { return readBackupHeader(file).keyId; } catch { return null; }
}

/**
 * Copy this install's encrypted backups (made with its backup key) that are missing, or of another size, into its
 * own folder in `target` (offPcFolder), then apply the same age and size caps there to the files of its own key (so
 * the copy never keeps more than 35 days either). Files of another key, and everything outside that folder, are never
 * touched. Records the result for the off-PC banner: a success only when every local backup is there with this key.
 * `key` is data\secrets\backup.key (default: read from dataDir).
 */
export async function copyBackups(dataDir: string, target: string, o: { now?: number; sizeCapMB?: number | null; key?: Uint8Array | null } = {}): Promise<CopyBackupsResult> {
  const now = o.now ?? Date.now();
  const copied: string[] = [];
  const conflicts: string[] = [];
  let removed: string[] = [];
  let folder = '';
  try {
    if (!target) throw new Error('No copy folder is set (Settings → Backups → Also copy backups to).');
    let key = o.key ?? null;
    if (!key) { try { key = openFileSecrets(dataDir).read('backup.key'); } catch { key = null; } }
    if (!key) throw new Error('There is no backup key (data\\secrets\\backup.key).');
    const own = keyIdOf(key);
    folder = offPcFolder(target, own);
    fs.mkdirSync(folder, { recursive: true });
    const local = listBackups(dataDir, { key, now }).filter((b) => b.managed && b.ownKey === true && !b.future);
    for (const b of local) {
      const dest = path.join(folder, b.name);
      let size = -1;
      try { size = fs.statSync(dest).size; } catch { /* missing */ }
      if (size >= 0) {
        const there = headerKeyId(dest);
        if (there !== own) { conflicts.push(b.name); continue; } // someone else's file: never overwritten
        if (size === b.size) continue;
      }
      const tmp = path.join(folder, `.${b.name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await fs.promises.copyFile(b.file, tmp);
        fs.renameSync(tmp, dest);
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
        throw e;
      }
      copied.push(b.name);
    }
    // The same caps on the copy: only our own names, made with our key.
    const there = fs.readdirSync(folder).flatMap((name) => {
      const p = parseBackupName(name);
      if (!p) return [];
      const file = path.join(folder, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || headerKeyId(file) !== own) return [];
        // Future-stamped: aged from a sane mtime, else left alone (the clock is wrong now, or was: BackupInfo.future).
        const future = p.at > now + FUTURE_STAMP_SLACK_MS;
        if (future && st.mtimeMs > now + FUTURE_STAMP_SLACK_MS) return [];
        return [{ name, cls: p.cls, at: future ? st.mtimeMs : p.at, seq: p.seq, size: st.size }];
      } catch { return []; }
    });
    const plan = planRetention(there, now, retentionPolicy(o.sizeCapMB));
    removed = [];
    for (const { item } of plan.remove) {
      try { fs.rmSync(path.join(folder, item.name), { force: true }); removed.push(item.name); } catch { /* next time */ }
    }
    if (conflicts.length) {
      throw new Error(`${conflicts.length} backup(s) could not be copied: files made by another copy of Voidswarm have the same names in ${folder}`);
    }
    const had = readOffPcState(dataDir);
    writeOffPcState(dataDir, { at: now, target, copied: copied.length, error: null, since: had?.since || now });
    return { ok: true, folder, copied, removed, conflicts, error: null, at: now };
  } catch (e) {
    const error = `Copying the backups to ${target || '(not set)'} failed: ${errMsg(e)}`;
    const prev = readOffPcState(dataDir);
    writeOffPcState(dataDir, { at: prev?.at ?? 0, target, copied: 0, error, since: prev?.since || now });
    return { ok: false, folder, copied, removed, conflicts, error, at: now };
  }
}

/**
 * The Home banner when there has been no off-PC copy for 30 days (§6.1), or the last copy failed. The 30 days count
 * from the last copy, or before the first one from `state.since` (ensureOffPcState: a new install gets 30 days).
 * Without that (an older state file, or none) the oldest backup's age stands in. Nothing to copy: no banner.
 */
export function offPcBanner(o: { state: OffPcState | null; copyTo: string; now: number; oldestBackupAt: number | null }): Banner | null {
  if (o.state?.error && o.copyTo) return { code: 'offpc-failed', level: 'warn', text: o.state.error };
  if (o.oldestBackupAt === null) return null;
  const since = o.state?.since ?? 0;
  const last = Math.max(o.state?.at ?? 0, since);
  if (o.now - last < OFFPC_BANNER_AFTER_MS) return null;
  if (!since && !(o.state?.at) && o.now - o.oldestBackupAt < OFFPC_BANNER_AFTER_MS) return null;
  return {
    code: 'offpc-none', level: 'warn',
    text: o.copyTo
      ? 'No off-PC copy of the backups for 30 days: plug in the backup drive or reconnect the share, then use Server → Backups → Copy now.'
      : 'The backups are only on this PC. Set Settings → Backups → "Also copy backups to" (a USB stick or a district share).',
  };
}
