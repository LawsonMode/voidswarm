// OWNER: SERVER MODERATION (LAN task B5). The panel side of a restore (docs/LAN-EDITION-proposal.md §6.2, §5.14):
// Server → Backups → Restore… (host PC) only STAGES it, in data\restore.pending.json; the host then stops and starts
// the server, and the launcher applies it before the server starts (src/lan/restore.ts, §2.2 step 8). The server
// never replaces the database it is running on. The launcher leaves the outcome in data\restore.last.json for the
// panel.
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { openFileSecrets, type SecretStore } from '../secrets';
import type { Banner } from './disk';
import { keyIdOf, pepperIdOf, readBackupHeader } from './format';
import { BACKUP_EXT, BACKUPS_DIR, parseBackupName } from './names';
import { findPreviousPepper } from './peppers';
import { fsyncBestEffort } from '../durable';

export const PENDING_RESTORE_FILE = 'restore.pending.json';
export const LAST_RESTORE_FILE = 'restore.last.json';
/** Where a restore decrypts the backup (src/lan/restore.ts); a plaintext copy of the database while it runs. */
export const RESTORE_STAGING_DIR = 'restore.staging';
/** A restore's swap moves the current database aside under this suffix until the restored one is in place. */
export const REPLACED_SUFFIX = '.replaced';
/**
 * The swap journal: written (fsynced) before a restore replaces data\secrets\pepper.key, removed once the restored
 * database is in place. It names the pepper replaced and fingerprints the restored database, so a crash between the
 * two is undone at the next start (recoverInterruptedRestore). Ids and sizes only, never a key.
 */
export const SWAP_JOURNAL_FILE = 'restore.swap.json';
const RESTORE_DB = 'voidswarm.db';
const DB_SIDECARS = ['-wal', '-shm', '-journal'] as const;

/**
 * Is there a pre-restore safety backup in data\backups made at or after `changedAt` (the replaced file's last change;
 * the names carry minute stamps, so one minute of slack)?
 */
function safetyBackupSince(dataDir: string, changedAt: number): boolean {
  let names: string[];
  try { names = fs.readdirSync(path.join(dataDir, BACKUPS_DIR)); } catch { return false; }
  const floor = Math.floor(changedAt / 60_000) * 60_000 - 60_000;
  for (const n of names) {
    const p = parseBackupName(n);
    if (!p || p.cls !== 'pre-restore' || p.at < floor) continue;
    try { readBackupHeader(path.join(dataDir, BACKUPS_DIR, n)); return true; } catch { /* not a backup */ }
  }
  return false;
}

/**
 * Finish or undo a restore's swap that a crash interrupted (src/lan/restore.ts moves voidswarm.db aside as
 * voidswarm.db.replaced, puts the restored one in, then removes the old one). Run at every start before the database
 * opens (the launcher's staged work, the restore tool, MaintService.start):
 *  - the restored database never arrived: the old one (and its -wal / -shm) is put back;
 *  - both are there (a crash just before the removal): the old one is a PLAINTEXT copy of the data from before the
 *    restore, which the restore's pre-restore safety backup holds encrypted. It is removed once such a backup, made
 *    after the file's last change, is in data\backups; otherwise it is the only copy of that data, so it moves into a
 *    data\unreadable-db-<stamp>\ folder (moveDbAside): kept 35 days with the 'unreadable-db' banner, and out of the
 *    way of the next restore's swap (which would otherwise replace it);
 *  - a swap journal is left (the restore had replaced pepper.key): when the database in place is not the restored
 *    one, the pepper it was made with goes back into pepper.key (data\secrets\pepper.previous.json keeps it), so the
 *    database and its pepper never disagree. `secrets` is data\secrets (default: the file store of dataDir).
 * Returns a note for the log and the banners, or null when there was nothing to do. Never throws.
 */
export function recoverInterruptedRestore(dataDir: string, opts: { secrets?: SecretStore; now?: number } = {}): string | null {
  const notes = [recoverReplacedDb(dataDir, opts.now ?? Date.now()), recoverSwapJournal(dataDir, opts.secrets)].filter((n): n is string => !!n);
  return notes.length ? notes.join(' ') : null;
}

function recoverReplacedDb(dataDir: string, now: number): string | null {
  const db = path.join(dataDir, RESTORE_DB);
  const replaced = db + REPLACED_SUFFIX;
  if (!fs.existsSync(replaced)) return null;
  const msg = (e: unknown): string => String((e as Error)?.message ?? e);
  if (!fs.existsSync(db)) {
    try {
      fs.renameSync(replaced, db);
      for (const x of DB_SIDECARS) if (fs.existsSync(replaced + x) && !fs.existsSync(db + x)) fs.renameSync(replaced + x, db + x);
      return 'A restore was interrupted last time: the database from before it was put back.';
    } catch (e) {
      return `A restore was interrupted last time, and the database from before it could not be put back (${msg(e)}): it is data\\${RESTORE_DB}${REPLACED_SUFFIX}.`;
    }
  }
  // The data's last change: the file and its WAL (the -shm is only an index, which the safety backup's own read touches).
  let changedAt = 0;
  for (const f of [replaced, `${replaced}-wal`, `${replaced}-journal`]) {
    try { changedAt = Math.max(changedAt, fs.statSync(f).mtimeMs); } catch { /* none */ }
  }
  if (!safetyBackupSince(dataDir, changedAt)) {
    // The only copy of that data: never deleted here, and never left where the next restore's swap replaces it.
    try {
      const dir = moveDbAside(dataDir, replaced, now);
      if (!dir) return null; // gone meanwhile: nothing to keep
      return `A restore was interrupted just before it finished. No safety backup of the database from before it was found, so it is kept in data\\${path.basename(dir)} `
        + 'for 35 days: delete that folder sooner once you are sure you no longer need it.';
    } catch (e) {
      return `A restore was interrupted just before it finished. The database from before it is kept as data\\${RESTORE_DB}${REPLACED_SUFFIX} `
        + `(no safety backup of it was found, and it could not be moved aside: ${msg(e)}): delete that file once you are sure you no longer need it.`;
    }
  }
  let left = 0;
  for (const f of [replaced, ...DB_SIDECARS.map((x) => replaced + x)]) {
    try { fs.rmSync(f, { force: true }); } catch { left++; }
  }
  return left
    ? `A restore was interrupted just before it finished; the copy of the database from before it (data\\${RESTORE_DB}${REPLACED_SUFFIX}) could not be removed yet: it is tried again at the next start.`
    : 'A restore was interrupted just before it finished: the leftover copy of the database from before it was removed (the pre-restore backup holds it).';
}

// ------------------------------------------------------------------------------------------
// The swap journal (a restore that replaces pepper.key)
// ------------------------------------------------------------------------------------------

/** Which database file this is, cheaply: its size and hashes of its first 4 MB and last 1 MB. */
export interface DbFingerprint { size: number; head: string; tail: string }

export function dbFingerprint(file: string): DbFingerprint | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const hashOf = (from: number, len: number): string => {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - from)));
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      return createHash('sha256').update(buf.subarray(0, got)).digest('hex');
    };
    return { size, head: hashOf(0, 4 * 1024 * 1024), tail: hashOf(Math.max(0, size - 1024 * 1024), 1024 * 1024) };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface SwapJournal {
  v: 1;
  at: number;
  /** the backup being restored (for the note) */
  backup: string;
  /** pepperIdOf the pepper.key replaced (null: there was none) */
  prevPepperId: string | null;
  newPepperId: string;
  /** the restored database, as it is swapped in */
  newDb: DbFingerprint;
}

export const swapJournalPath = (dataDir: string): string => path.join(dataDir, SWAP_JOURNAL_FILE);

/** Write the journal (fsynced) before pepper.key is replaced. Throws when it can't be saved. */
export function writeSwapJournal(dataDir: string, j: SwapJournal): void {
  const file = swapJournalPath(dataDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(j)}\n`);
    fsyncBestEffort(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
}

export function clearSwapJournal(dataDir: string): void {
  try { fs.rmSync(swapJournalPath(dataDir), { force: true }); } catch { /* the next start looks again */ }
}

function readSwapJournal(dataDir: string): SwapJournal | 'damaged' | null {
  let raw: string;
  try { raw = fs.readFileSync(swapJournalPath(dataDir), 'utf8'); } catch { return null; }
  try {
    const o = JSON.parse(raw) as Partial<SwapJournal>;
    const id = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
    const fp = o.newDb as Partial<DbFingerprint> | undefined;
    if (!(o.prevPepperId === null || id(o.prevPepperId)) || !id(o.newPepperId) || !fp || typeof fp.size !== 'number'
      || typeof fp.head !== 'string' || typeof fp.tail !== 'string') return 'damaged';
    return {
      v: 1, at: typeof o.at === 'number' ? o.at : 0, backup: typeof o.backup === 'string' ? o.backup.slice(0, 120) : '',
      prevPepperId: o.prevPepperId, newPepperId: o.newPepperId, newDb: { size: fp.size, head: fp.head, tail: fp.tail },
    };
  } catch {
    return 'damaged';
  }
}

function recoverSwapJournal(dataDir: string, secrets?: SecretStore): string | null {
  const j = readSwapJournal(dataDir);
  if (!j) return null;
  if (j === 'damaged') {
    clearSwapJournal(dataDir);
    return 'A restore was interrupted last time and its journal could not be read: if email look-ups or address tags stop matching, restore the latest pre-restore backup again.';
  }
  const db = path.join(dataDir, RESTORE_DB);
  const fp = fs.existsSync(db) ? dbFingerprint(db) : null;
  if (fp && fp.size === j.newDb.size && fp.head === j.newDb.head && fp.tail === j.newDb.tail) {
    // The restored database is in place (with its pepper, saved before the swap): the restore finished.
    clearSwapJournal(dataDir);
    return null;
  }
  // The database that stayed (or none) was made with the pepper the restore replaced: it goes back.
  const msg = (e: unknown): string => String((e as Error)?.message ?? e);
  const what = `A restore${j.backup ? ` of ${j.backup}` : ''} was interrupted before its database was swapped in`;
  try {
    const store = secrets ?? openFileSecrets(dataDir);
    const cur = store.read('pepper.key');
    const curId = cur ? pepperIdOf(cur) : null;
    if (curId !== j.prevPepperId) {
      if (j.prevPepperId === null) store.remove('pepper.key');
      else {
        const prev = findPreviousPepper(store.dir, j.prevPepperId);
        if (!prev) {
          clearSwapJournal(dataDir);
          return `${what}, and the pepper of the data that stayed could not be found: email look-ups and address tags may not match until you restore with this PC's recovery file.`;
        }
        store.write('pepper.key', prev);
      }
    }
    clearSwapJournal(dataDir);
    return `${what}: the data from before it stayed, with its own pepper.`;
  } catch (e) {
    // The journal stays: the next start tries again.
    return `${what}, and the pepper of the data that stayed could not be put back yet (${msg(e)}): it is tried again at the next start.`;
  }
}

/**
 * Remove a restore's leftover staging folder (a restore killed after decrypting leaves the whole database there in
 * plain text). Safe whenever no restore runs: at every start, before the server opens the database (a restore only
 * runs while no host runs). True when there was one.
 */
export function cleanupRestoreStaging(dataDir: string): boolean {
  const dir = path.join(dataDir, RESTORE_STAGING_DIR);
  if (!fs.existsSync(dir)) return false;
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

// ------------------------------------------------------------------------------------------
// Database files a restore moved aside (data\unreadable-db-<stamp>\)
// ------------------------------------------------------------------------------------------

/**
 * A restore never deletes what it could not back up. An unreadable current database goes into a folder of its own,
 * data\unreadable-db-<stamp>\ (src/lan/restore.ts). So does a -wal or -journal left in data\ with no database beside
 * it, which SQLite would otherwise replay onto the restored file, and the voidswarm.db.replaced of an interrupted
 * restore when no safety backup of it was found (recoverReplacedDb). These are PLAINTEXT copies of old data that the
 * deletion ledger can't reach, so, like the backups (§4.13 "at most 35 days", §8.1), they are kept for 35 days
 * with a banner and then removed (pruneAsideDbs: at every start and hourly, MaintService).
 */
export const UNREADABLE_DB_PREFIX = 'unreadable-db-';
export const ASIDE_KEEP_DAYS = 35;
const ASIDE_RE = /^unreadable-db-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:_\d{1,2})?$/;
/** A stamp this far ahead of now is a clock problem (as for backups): such a folder is never removed on that guess. */
const ASIDE_FUTURE_SLACK_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

export interface AsideDb {
  name: string;
  dir: string;
  /** when the restore moved it aside (the folder name's stamp, else the folder's mtime) */
  at: number;
  bytes: number;
  /** when pruneAsideDbs removes it */
  removeAt: number;
  /** dated more than an hour ahead of now: kept as it is */
  future: boolean;
}

const localStamp = (at: number): string => {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

/** A new, unused data\unreadable-db-<stamp>[_n] path (not created). */
export function asideDbDir(dataDir: string, now = Date.now()): string {
  const base = `${UNREADABLE_DB_PREFIX}${localStamp(now)}`;
  for (let n = 1; n < 100; n++) {
    const dir = path.join(dataDir, n === 1 ? base : `${base}_${n}`);
    if (!fs.existsSync(dir)) return dir;
  }
  return path.join(dataDir, `${base}_${randomBytes(3).toString('hex')}`);
}

/**
 * Move a database file and its -wal / -journal (those with content) into a new aside folder (asideDbDir), as
 * voidswarm.db.<tag>[-wal|-journal]: one tag, so they still pair up. What is left beside `file` (an empty -wal or
 * journal, a -shm: only an index) is removed. Returns the folder, or null when there was nothing to keep (no folder
 * is left then). Throws when a file can't be moved; the moves made are undone and the folder removed.
 */
export function moveDbAside(dataDir: string, file: string, now = Date.now()): string | null {
  const dir = asideDbDir(dataDir, now);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${RESTORE_DB}.${randomBytes(2).toString('hex')}`);
  const moved: [string, string][] = [];
  const bytes = (f: string): number => { try { return fs.statSync(f).size; } catch { return -1; } };
  try {
    if (fs.existsSync(file)) { fs.renameSync(file, base); moved.push([file, base]); }
    for (const x of ['-wal', '-journal'] as const) {
      if (bytes(file + x) > 0) { fs.renameSync(file + x, base + x); moved.push([file + x, base + x]); }
    }
  } catch (e) {
    for (const [from, to] of moved.reverse()) { try { fs.renameSync(to, from); } catch { /* left in the folder: kept 35 days */ } }
    try { fs.rmdirSync(dir); } catch { /* not empty (a move could not be undone) */ }
    throw e;
  }
  for (const x of DB_SIDECARS) { try { fs.rmSync(file + x, { force: true }); } catch { /* the next swap removes it */ } }
  if (!moved.length) { try { fs.rmdirSync(dir); } catch { /* not empty */ } return null; }
  return dir;
}

/** The folders a restore moved database files into, oldest first. Never throws. */
export function listAsideDbs(dataDir: string, now = Date.now()): AsideDb[] {
  let names: string[];
  try { names = fs.readdirSync(dataDir); } catch { return []; }
  const out: AsideDb[] = [];
  for (const name of names) {
    if (!name.startsWith(UNREADABLE_DB_PREFIX)) continue;
    const dir = path.join(dataDir, name);
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const m = ASIDE_RE.exec(name);
    let at = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime() : NaN;
    if (!Number.isFinite(at)) at = st.mtimeMs;
    let bytes = 0;
    try { for (const f of fs.readdirSync(dir)) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* gone */ } } } catch { /* unreadable */ }
    out.push({ name, dir, at, bytes, removeAt: at + ASIDE_KEEP_DAYS * DAY_MS, future: at > now + ASIDE_FUTURE_SLACK_MS });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Remove the aside folders older than 35 days. Returns the names removed. Never throws. */
export function pruneAsideDbs(dataDir: string, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const a of listAsideDbs(dataDir, now)) {
    if (a.future || now < a.removeAt) continue;
    try { fs.rmSync(a.dir, { recursive: true, force: true }); removed.push(a.name); } catch { /* held open: the next pass */ }
  }
  return removed;
}

/** The Home banner while such a folder is kept (it is a plain copy of old accounts and chat), or null. */
export function asideDbBanner(list: readonly AsideDb[], now = Date.now()): Banner | null {
  if (!list.length) return null;
  const size = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
  const day = (t: number): string => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const first = list.find((a) => !a.future) ?? null;
  const one = list.length === 1;
  const it = one ? 'it' : 'them';
  const where = one
    ? `data\\${list[0]!.name} (${size(list[0]!.bytes)})`
    : `${list.length} folders named data\\${UNREADABLE_DB_PREFIX}… (${size(list.reduce((s, a) => s + a.bytes, 0))})`;
  const when = first
    ? `${one ? 'It is' : 'The oldest is'} deleted on ${day(Math.max(now, first.removeAt))} (35 days after its restore)`
    : `${one ? 'It is' : 'They are'} dated later than this PC's clock, so ${one ? 'it is' : 'they are'} kept until you delete ${it}`;
  return {
    code: 'unreadable-db', level: 'warn',
    text: `A restore kept database files it could not back up in ${where}: a plain, unencrypted copy of old accounts and chat. `
      + `${when}; delete ${it} sooner once you are sure you don't need ${it}.`,
  };
}

export interface PendingRestore {
  v: number;
  /** a file name in data\backups */
  backup: string;
  /** also restore the settings saved in the backup (§6.2 step 7) */
  restoreConfig: boolean;
  requestedAt: number;
  /** who asked ('host:<name>') */
  by: string;
}

export interface LastRestore {
  v: number;
  at: number;
  ok: boolean;
  backup: string;
  message: string;
  safetyBackup: string | null;
}

export const pendingRestorePath = (dataDir: string): string => path.join(dataDir, PENDING_RESTORE_FILE);
export const lastRestorePath = (dataDir: string): string => path.join(dataDir, LAST_RESTORE_FILE);

/** A plain backup file name (no folders, no ..). */
export function isPlainBackupName(n: unknown): n is string {
  return typeof n === 'string' && n.length <= 120 && n.endsWith(BACKUP_EXT) && !n.startsWith('.') && path.basename(n) === n
    && !/[\\/:*?"<>|\u0000-\u001f]/.test(n);
}

function writeJsonAtomic(file: string, v: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
}

export type StageResult =
  | { ok: true; pending: PendingRestore; message: string }
  | { ok: false; status: number; error: string };

/**
 * Stage a restore of one of this install's backups. Checks the name, that the file is a backup, and that this
 * install's backup.key made it (another install's backup needs its recovery file: the tool, not the panel).
 */
export function stageRestore(dataDir: string, req: { backup: unknown; restoreConfig?: unknown; by: string; now?: number }, opts: { key?: Uint8Array | null } = {}): StageResult {
  if (!isPlainBackupName(req.backup)) return { ok: false, status: 400, error: 'Choose a backup from the list.' };
  const file = path.join(dataDir, BACKUPS_DIR, req.backup);
  let keyId: string;
  try { keyId = readBackupHeader(file).keyId; } catch (e) {
    return { ok: false, status: 404, error: fs.existsSync(file) ? String((e as Error)?.message ?? e) : 'That backup is no longer there.' };
  }
  if (opts.key && keyIdOf(opts.key) !== keyId) {
    return { ok: false, status: 409, error: 'This backup was made by another copy of Voidswarm: restore it on the host PC with "Restore a backup.cmd --recovery <file>" and that copy\'s recovery file.' };
  }
  const pending: PendingRestore = {
    v: 1, backup: req.backup, restoreConfig: req.restoreConfig === true, requestedAt: Math.floor(req.now ?? Date.now()), by: String(req.by ?? '').slice(0, 64),
  };
  writeJsonAtomic(pendingRestorePath(dataDir), pending);
  return {
    ok: true, pending,
    message: `The restore of ${req.backup} is ready. Stop the host and start it again to restore it: the current data is backed up first.`,
  };
}

/** The staged restore, or null (a damaged file counts as none). */
export function readPendingRestore(dataDir: string): PendingRestore | null {
  try {
    const o = JSON.parse(fs.readFileSync(pendingRestorePath(dataDir), 'utf8')) as Record<string, unknown>;
    if (!isPlainBackupName(o.backup)) return null;
    return {
      v: 1, backup: o.backup, restoreConfig: o.restoreConfig === true,
      requestedAt: typeof o.requestedAt === 'number' ? o.requestedAt : 0, by: typeof o.by === 'string' ? o.by.slice(0, 64) : '',
    };
  } catch {
    return null;
  }
}

/** Cancel a staged restore. True when one was there. */
export function cancelPendingRestore(dataDir: string): boolean {
  try { fs.rmSync(pendingRestorePath(dataDir)); return true; } catch { return false; }
}

export function readLastRestore(dataDir: string): LastRestore | null {
  try {
    const o = JSON.parse(fs.readFileSync(lastRestorePath(dataDir), 'utf8')) as Record<string, unknown>;
    if (typeof o.at !== 'number' || typeof o.ok !== 'boolean') return null;
    return {
      v: 1, at: o.at, ok: o.ok, backup: typeof o.backup === 'string' ? o.backup.slice(0, 200) : '',
      message: typeof o.message === 'string' ? o.message.slice(0, 1000) : '', safetyBackup: typeof o.safetyBackup === 'string' ? o.safetyBackup : null,
    };
  } catch {
    return null;
  }
}

export function writeLastRestore(dataDir: string, r: Omit<LastRestore, 'v'>): void {
  try { writeJsonAtomic(lastRestorePath(dataDir), { v: 1, ...r }); } catch { /* the notes carry it anyway */ }
}
