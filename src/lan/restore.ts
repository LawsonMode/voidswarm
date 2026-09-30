// LAN edition: restoring a backup (docs/LAN-EDITION-proposal.md §6.2, §6.3, §6.4, §6.5; T-BAK-1, T-BAK-3).
// Always with no server running on the data folder:
//  - a restore staged from the panel (Server → Backups → Restore…, data\restore.pending.json) is applied by the
//    launcher before the server starts (§2.2 step 8): applyStagedRestore is launch.ts's `stagedWork` hook;
//  - `Restore a backup.cmd` (tool restore) takes the host lock itself (a running host refuses it), lists the backups
//    and asks for a number and a confirmation; `--recovery <file>` brings a backup from another install.
// Either way (restoreBackup), once the backup's header names a key this install has (its own, or the recovery file's):
//   1. a safety backup of the current database ('pre-restore'), before anything is unpacked (§6.2's order);
//   2. decrypt (backup.key, or the recovery file's key for another install's backup) and un-gzip into
//      data\restore.staging\;
//   3. integrity_check and the untrusted-data checks (schema identical to what this version builds, §6.5) — for
//      every backup, not only another install's — then its planner statistics (sqlite_stat1 / sqlite_stat4, which the
//      check lets through) are dropped before anything queries it: crafted ones steer SQLite into full scans;
//   4. migrate the staged copy to this version's schema (not for Update's --rollback: RestoreOptions.migrate), re-apply
//      the deletion ledger (the current one plus the backup's: of that union, the entries recorded on the data being
//      restored, its lineage, plus every account deletion whose account is in it, whichever data it was recorded on —
//      see maint/ledger.ts applicableEntries; the whole union is kept on disk), keep the CURRENT host_admins (and
//      setup state) and clear admin_sessions — a restore never brings back an old admin password; with an unreadable
//      current database, first-run setup runs again;
//   5. swap it in. No stale -wal / -shm / -journal is ever left beside it (SQLite would replay an old WAL, or roll
//      back an old journal, onto the restored file): with a readable current database they move aside with it; an
//      unreadable current database, or a -wal / -journal with no database beside it, goes into
//      data\unreadable-db-<stamp>\, kept 35 days with a banner (restoreStage.ts pruneAsideDbs);
//   6. the pepper the backup's database was made with (the manifest's pepperId: this PC's, the recovery file's, or one
//      a restore replaced here before, data\secrets\pepper.previous.json) goes in before the swap, journaled
//      (restore.swap.json) so a crash can't leave a database with the wrong pepper; the merged ledger is saved before
//      the swap too (when it can't be, nothing is swapped: ELEDGER); after it, from another install, its SMTP
//      password, only with its settings (--settings) or when this PC has none of its own (it belongs with that
//      install's mail server, and this PC's is never lost);
//   7. optionally restore the config (validated field by field by SettingsService.restore).
// Every change is made on the staged copy first; the swap is the last step, and an interrupted swap is rolled back or finished
// at the next start (recoverInterruptedSwap). Free space is checked against the backup's size before it is unpacked,
// and a full drive is reported as such (EDISK), never as a damaged backup. A staging folder left by a restore that
// was killed (the database in plain text) is removed at the next start (applyStagedRestore, MaintService.start).
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { AuthStore, checkUntrustedAuthDb } from '../server/auth/store';
import { DbGuardError, dropPlannerStats, openProtectedDb, protectConnection } from '../server/db/guard';
import {
  applicableEntries, applyLedger, asideDbDir, BackupError, backupsDir, CHAT_MIN_FREE_BYTES, checkDisk, cleanupRestoreStaging, clearSwapJournal, createBackup, dbFingerprint,
  dbLineage, ensureLineage, ERASE_MIN_SCHEMA, keyIdOf, ledgerPath, listBackups, mergeUnknownLines, moveDbAside, nativeLineage, parseLedger,
  pepperIdOf, readBackupFile, readBackupHeader, readLedger, readPendingRestore, readPreviousPeppers, cancelPendingRestore, recoverInterruptedRestore,
  rememberPepper, REPLACED_SUFFIX as REPLACED, RESTORE_STAGING_DIR, scopeLedgers, UNREADABLE_DB_PREFIX, writeLastRestore, writeLedger, writeSwapJournal,
  decryptRecovery, recoverySecrets, RecoveryError, sizeText, type BackupInfo, type LedgerEntry, type RecoveryContents, type StatfsFn,
} from '../server/maint';
import { openFileSecrets, prepareSecretsDir, secretsDir, type SecretStore } from '../server/secrets';
import { configPath, readConfigFile, SettingsService, type SettingsActor } from '../server/settings';
import { GAME_VERSION } from '../shared/version';
import type { HostLog } from './console';
import { lanPaths, rootFromLauncher, type LanPaths, type Platform } from './paths';
import { protectDir } from './acl';
import { readToken } from './elevation';
import { acquireLock } from './pipe';

export const STAGING_DIR = RESTORE_STAGING_DIR;
export const REPLACED_SUFFIX = REPLACED;
/**
 * An unreadable current database (or a -wal / -journal with no database beside it) is kept in
 * data\unreadable-db-<stamp>\: one folder per restore, removed after 35 days (MaintService: restoreStage.ts
 * pruneAsideDbs), with the 'unreadable-db' banner until then.
 */
export const UNREADABLE_PREFIX = UNREADABLE_DB_PREFIX;
/** Room the unpacked database needs above its size (the migration's and the ledger's WAL), plus the 500 MB floor. */
const UNPACK_HEADROOM = 1.1;
const DB_FILE = 'voidswarm.db';
const CONFIG_FILE = 'voidswarm.config.json';
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

export type RestoreErrorCode =
  /** the backup can't be opened with this install's key or the recovery file given */
  | 'EKEY'
  /** not a backup, damaged, or changed */
  | 'EFORMAT'
  /** the database inside failed the checks (changed outside Voidswarm, newer, unreadable) */
  | 'ECHECK'
  /** the safety backup could not be made */
  | 'ESAFETY'
  /** not enough free space on the data drive to unpack or prepare the backup */
  | 'EDISK'
  /** replacing the files failed (rolled back) */
  | 'ESWAP'
  /** the backup's pepper / SMTP password could not be saved in data\secrets (nothing changed) */
  | 'ESECRET'
  /** the merged deletion ledger (data\deletions.jsonl) could not be saved (nothing changed) */
  | 'ELEDGER'
  /** a host is running on this data folder */
  | 'ERUNNING'
  | 'EFAIL';

export type RestoreResult =
  | {
    ok: true;
    backup: string;
    safetyBackup: string | null;
    fromOtherInstall: boolean;
    schemaFrom: number;
    schemaTo: number;
    ledger: { entries: number; changed: number };
    adminsKept: number;
    configRestored: boolean;
    secretsInstalled: string[];
    notes: string[];
    message: string;
  }
  | { ok: false; code: RestoreErrorCode; message: string; safetyBackup?: string | null };

export interface RestoreOptions {
  dataDir: string;
  /** the .vsbak (in data\backups, or anywhere) */
  backupFile: string;
  /** this install's data\secrets (default openFileSecrets(dataDir)) */
  secrets?: SecretStore;
  /** a decrypted recovery file: for a backup from another install (§6.3) */
  recovery?: RecoveryContents | null;
  /** also restore the settings saved in the backup (§6.2 step 7) */
  restoreConfig?: boolean;
  /** who restored ('host:<name>' from the panel, 'cli' from the tool) */
  by: string;
  /** for the config restore (default: one opened on dataDir for the call) */
  settings?: SettingsService | null;
  now?: () => number;
  log?: (line: string) => void;
  appVersion?: string;
  /** the safety backup's disk check (tests) */
  statfs?: StatfsFn;
  /**
   * Migrate the backup's database to this version's schema (default true). `Update Voidswarm.cmd --rollback` passes
   * false: it restores the pre-update backup for the OLDER version it puts back, which refuses a newer schema. The
   * backup must then be at schema v4 or later (the deletion ledger's steps need it), else it is refused (ECHECK).
   */
  migrate?: boolean;
}

/**
 * A swap that a crash interrupted: the old database renamed aside and the new one not yet in (the old one is put
 * back), or both there (the leftover plaintext copy goes once the pre-restore safety backup is found), and a pepper
 * replaced for a database that never arrived (put back, from the swap journal). See recoverInterruptedRestore
 * (src/server/maint/restoreStage.ts, which MaintService.start runs too).
 */
export function recoverInterruptedSwap(dataDir: string, secrets?: SecretStore): string | null {
  return recoverInterruptedRestore(dataDir, { secrets });
}

/** The files SQLite pairs with a database: a -wal is replayed onto it, a hot -journal rolled back onto it. */
const DB_SIDECARS = ['-wal', '-shm', '-journal'] as const;

function rmDbFiles(p: string): void {
  for (const f of [p, ...DB_SIDECARS.map((x) => p + x)]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
}

/** A file's size, or -1 when it isn't there. */
function fileBytes(f: string): number {
  try { return fs.statSync(f).size; } catch { return -1; }
}

interface CurrentState {
  exists: boolean;
  readable: boolean;
  version: number;
  hostAdmins: Record<string, unknown>[];
  hostSetup: Record<string, unknown>[];
  /** its data lineage (mod_meta), null when never stamped (then this install's native one) */
  lineage: string | null;
  why?: string;
}

/**
 * What the current database holds that a restore keeps (host admin credential, setup state), and which data it is
 * (the deletion ledger's lineage). Read-only.
 */
function readCurrent(dbPath: string): CurrentState {
  if (!fs.existsSync(dbPath)) return { exists: false, readable: false, version: 0, hostAdmins: [], hostSetup: [], lineage: null };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    protectConnection(db);
    db.exec('PRAGMA busy_timeout = 5000');
    const q = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
    if (q.length !== 1 || String(Object.values(q[0]!)[0]) !== 'ok') throw new Error('it failed its integrity check');
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const has = (t: string): boolean => !!db!.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(t);
    const hostAdmins = has('host_admins') ? db.prepare('SELECT * FROM host_admins').all() as Record<string, unknown>[] : [];
    const hostSetup = has('host_setup') ? db.prepare('SELECT * FROM host_setup').all() as Record<string, unknown>[] : [];
    return { exists: true, readable: true, version, hostAdmins, hostSetup, lineage: dbLineage(db) };
  } catch (e) {
    return { exists: true, readable: false, version: 0, hostAdmins: [], hostSetup: [], lineage: null, why: errMsg(e) };
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/** This install's settings.installId (for the safety backup's manifest), '' when it can't be read. */
function currentInstallId(dataDir: string, settings?: SettingsService | null): string {
  try {
    const id = settings ? settings.get().installId : (readConfigFile(configPath(dataDir)).raw as { installId?: unknown } | null)?.installId;
    return typeof id === 'string' ? id.slice(0, 64) : '';
  } catch {
    return '';
  }
}

function copyRows(db: DatabaseSync, table: string, rows: readonly Record<string, unknown>[]): number {
  if (!rows.length) return 0;
  const cols = new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name));
  let n = 0;
  for (const r of rows) {
    const keys = Object.keys(r).filter((k) => cols.has(k));
    if (!keys.length) continue;
    db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => r[k] as never));
    n++;
  }
  return n;
}

/**
 * Restore one backup into the data folder (see the file header). The caller makes sure no server runs. Never
 * throws: every failure is a `{ ok: false, code, message }` (and data/restore.last.json).
 */
export async function restoreBackup(o: RestoreOptions): Promise<RestoreResult> {
  try {
    return await restoreInner(o);
  } catch (e) {
    const name = path.basename(o.backupFile);
    const message = `The restore failed unexpectedly: ${errMsg(e)}`;
    try { fs.rmSync(path.join(path.resolve(o.dataDir), STAGING_DIR), { recursive: true, force: true }); } catch { /* next time */ }
    writeLastRestore(path.resolve(o.dataDir), { at: (o.now ?? Date.now)(), ok: false, backup: name, message, safetyBackup: null });
    (o.log ?? (() => undefined))(`[restore] ${name}: ${message}`);
    return { ok: false, code: 'EFAIL', message };
  }
}

async function restoreInner(o: RestoreOptions): Promise<RestoreResult> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const dataDir = path.resolve(o.dataDir);
  const dbPath = path.join(dataDir, DB_FILE);
  const name = path.basename(o.backupFile);
  const secrets = o.secrets ?? openFileSecrets(dataDir);
  const notes: string[] = [];
  const fail = (code: RestoreErrorCode, message: string, safetyBackup: string | null = null): RestoreResult => {
    log(`[restore] ${name}: ${message}`);
    writeLastRestore(dataDir, { at: now(), ok: false, backup: name, message: `The restore of ${name} did not happen: ${message}`, safetyBackup });
    return { ok: false, code, message, safetyBackup };
  };

  const interrupted = recoverInterruptedRestore(dataDir, { secrets, now: now() });
  if (interrupted) notes.push(interrupted);
  // A voidswarm.db.replaced still here could be neither removed nor moved aside (something holds it open). It may be
  // the only copy of the data from before an interrupted restore: this restore would make a safety backup of the
  // CURRENT data, which the next start would take for one of that file, so nothing is done until it is free.
  if (fs.existsSync(dbPath + REPLACED_SUFFIX)) {
    return fail('ESWAP', `data\\${DB_FILE}${REPLACED_SUFFIX}, left by an interrupted restore, could not be moved aside (is something holding it open?). Nothing was changed: close what holds it, then restore again.`);
  }

  // Which key opens it: this install's backup.key, or the recovery file's (another install).
  let header;
  try { header = readBackupHeader(o.backupFile); } catch (e) { return fail('EFORMAT', errMsg(e)); }
  const ownKey = secrets.ensureKey('backup.key');
  const rec = o.recovery ? recoverySecrets(o.recovery) : null;
  let key: Buffer;
  let fromOtherInstall = false;
  if (keyIdOf(ownKey) === header.keyId) key = ownKey;
  else if (rec?.backupKey && keyIdOf(rec.backupKey) === header.keyId) { key = rec.backupKey; fromOtherInstall = true; }
  else if (rec) return fail('EKEY', 'This recovery file belongs to another copy of Voidswarm than the one that made this backup.');
  else return fail('EKEY', 'This backup was made by another copy of Voidswarm. Restore it with that copy\'s recovery file: "Restore a backup.cmd --recovery <file>".');

  // 1. The safety backup of the current database, before anything is unpacked or changed (§6.2 step 1: the space
  // it needs is judged on the drive as it is, not after the backup's copy has been unpacked beside it).
  let curPepper: Buffer | null = null;
  try { curPepper = secrets.read('pepper.key'); } catch { curPepper = null; }
  const current = readCurrent(dbPath);
  let safetyBackup: string | null = null;
  if (current.readable) {
    // No retention here: a restore never deletes another backup the host may want to try next. No lineage stamp
    // either: a refused restore leaves the current database exactly as it was (currentLineage below is what an
    // unstamped one counts as).
    const r = await createBackup({
      dataDir, dbPath, key: ownKey, reason: 'pre-restore', now: now(), appVersion: o.appVersion ?? GAME_VERSION, statfs: o.statfs, retention: false, stampLineage: false,
      pepperId: curPepper ? pepperIdOf(curPepper) : null, installId: currentInstallId(dataDir, o.settings),
    });
    if (!r.ok) return fail('ESAFETY', `The safety backup of the current data could not be made (${'skipped' in r ? r.text : r.error}), so nothing was changed.`);
    safetyBackup = r.name;
    log(`[restore] safety backup ${r.name}`);
  }
  // Never delete what could not be backed up: it goes to a folder of its own (one per restore, removed after 35 days
  // with a banner until then). That is an unreadable current database, or a -wal / -journal left in data\ with no
  // database beside it (the database deleted by hand after a crash), whose pages SQLite would otherwise replay (or
  // roll back) onto the restored file.
  const strays = current.exists ? [] : DB_SIDECARS.filter((x) => x !== '-shm').map((x) => dbPath + x).filter((f) => fileBytes(f) > 0);
  let aside: string | null = null;
  if (current.exists && !current.readable) {
    aside = asideDbDir(dataDir, now());
    notes.push(`The current database could not be read (${current.why}); it is kept in data\\${path.basename(aside)} for 35 days, and first-run setup runs again.`);
  } else if (strays.length) {
    aside = asideDbDir(dataDir, now());
    const what = strays.map((f) => path.basename(f)).join(' and ');
    notes.push(`data\\ held ${what} with no ${DB_FILE} beside it (left by a crash). SQLite would have replayed it onto the restored database, so it is kept in data\\${path.basename(aside)} for 35 days instead.`);
  }

  // 2. Decrypt into the staging folder, once the manifest says there is room for it.
  const staging = path.join(dataDir, STAGING_DIR);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const cleanup = (): void => { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* next time */ } };
  let extracted;
  try {
    extracted = await readBackupFile(o.backupFile, key, staging, {
      onManifest: async (m) => {
        const need = Math.ceil(m.files.reduce((s, f) => s + f.size, 0) * UNPACK_HEADROOM);
        const d = await checkDisk(dataDir, { statfs: o.statfs, now: now() });
        if (d.freeBytes >= 0 && d.freeBytes - need < CHAT_MIN_FREE_BYTES) {
          throw new BackupError('ENOSPC', `Unpacking this backup needs about ${sizeText(need)} and only ${sizeText(d.freeBytes)} is free on the data drive (500 MB must stay free). Free some space, then restore again: nothing was changed.`);
        }
      },
    });
  } catch (e) {
    cleanup();
    const code: RestoreErrorCode = e instanceof BackupError ? (e.code === 'EKEY' ? 'EKEY' : e.code === 'ENOSPC' ? 'EDISK' : 'EFORMAT') : 'EFORMAT';
    return fail(code, errMsg(e), safetyBackup);
  }
  const stagedDb = path.join(staging, DB_FILE);
  if (!fs.existsSync(stagedDb)) { cleanup(); return fail('EFORMAT', 'The backup holds no database.', safetyBackup); }

  // 3. The checks (integrity, known schema, nothing planted).
  let checked: { version: number };
  try {
    checked = checkUntrustedAuthDb(stagedDb, { integrity: 'full' });
  } catch (e) {
    cleanup();
    return fail('ECHECK', e instanceof DbGuardError ? e.message : `The database in the backup could not be checked: ${errMsg(e)}`, safetyBackup);
  }
  // The planner statistics (sqlite_stat1 / sqlite_stat4) are the one extra the check lets through (guard.ts
  // ALLOWED_EXTRA), and they can be crafted: rows that make SQLite ignore the chat_log and bans indexes would turn the
  // game thread's point look-ups (/log, /whois, ban checks) into full scans (§0 fact 3, §5.16). Dropped before anything
  // queries the copy (the migration, the ledger), for every backup; SQLite plans without them.
  try {
    const sdb = openProtectedDb(stagedDb);
    try { dropPlannerStats(sdb); } finally { sdb.close(); }
  } catch (e) {
    cleanup();
    if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC' || /SQLITE_FULL|database or disk is full/i.test(errMsg(e))) {
      return fail('EDISK', 'The data drive filled up while the backup was prepared: free some space, then restore again. Nothing was changed.', safetyBackup);
    }
    return fail('ECHECK', `The backup's database could not be prepared: ${errMsg(e)}`, safetyBackup);
  }
  const migrate = o.migrate !== false;
  if (!migrate && checked.version < ERASE_MIN_SCHEMA) {
    cleanup();
    return fail('ECHECK', `The database in this backup is at schema v${checked.version}: restoring it unchanged would bring deleted students back (the deletion ledger needs v${ERASE_MIN_SCHEMA}). Nothing was changed.`, safetyBackup);
  }

  // Which pepper the backup's database was made with (its email hashes, address tags): the manifest names it. This
  // PC's own, the recovery file's (another install's), or one a restore replaced here before (pepper.previous.json:
  // undoing a restore from another install needs no recovery file).
  const recPepper = rec?.pepper ?? null;
  const previousPeppers = readPreviousPeppers(secrets.dir);
  const wantPepper = extracted.manifest.pepperId ?? null;
  let pepper: Buffer | null;
  let installPepper = false;
  if (wantPepper) {
    const kept = previousPeppers.find((p) => pepperIdOf(p) === wantPepper) ?? null;
    if (curPepper && pepperIdOf(curPepper) === wantPepper) pepper = curPepper;
    else if (recPepper && pepperIdOf(recPepper) === wantPepper) { pepper = recPepper; installPepper = true; }
    else if (kept) { pepper = kept; installPepper = true; }
    else {
      pepper = curPepper;
      notes.push('The email look-ups and address tags in this backup were made with a pepper this PC does not have: they will not match until you restore it with the recovery file of the copy that made it (--recovery).');
    }
  } else {
    pepper = fromOtherInstall && recPepper ? recPepper : curPepper;
    installPepper = fromOtherInstall && !!recPepper;
  }
  if (installPepper && curPepper && pepper && curPepper.equals(pepper)) installPepper = false;

  // 4. Prepare the staged copy: migrate + backfill (with the pepper it will run with), the ledger, the host rows.
  const backupLedger = extracted.files.some((f) => f.name === 'deletions.jsonl')
    ? parseLedger(fs.readFileSync(path.join(staging, 'deletions.jsonl'), 'utf8')) : { entries: [], unknown: [] };
  const currentLedger = readLedger(ledgerPath(dataDir));
  // Lines this version can't read (a newer version's deletions): never dropped, but they can't be applied here.
  const unknownLines = mergeUnknownLines(currentLedger.unknown, backupLedger.unknown);
  if (unknownLines.length) {
    notes.push(`${unknownLines.length} line(s) of the deletion ledger were written by a newer version of Voidswarm: they were kept, but this version can't apply them. Restore with that version to be sure every deletion holds.`);
  }
  // Which data the current database is (the lineage its ledger entries without one are attributed to): its stamp,
  // or, never stamped, this install's native lineage.
  const currentLineage = current.lineage ?? nativeLineage(ownKey);
  let merged: LedgerEntry[] = [];
  let schemaTo = checked.version;
  let ledger = { entries: 0, changed: 0 };
  let otherData = 0;
  let adminsKept = 0;
  try {
    if (migrate) {
      const store = new AuthStore(stagedDb, { pepper, schemaCheck: 'refuse', log: (l) => log(`[restore] ${l}`) });
      store.close();
    }
    const db = openProtectedDb(stagedDb);
    try {
      schemaTo = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      // Which data this is: its own stamp, or (never stamped) the native lineage of the install whose key made the
      // backup. Stamped now, so it travels with the data from here on (in every later backup of it too).
      const lineage = ensureLineage(db, nativeLineage(key));
      // Both ledgers, every entry with its data's lineage; this data's deletions are applied to it, and every account
      // deletion whose account is in it (the same random id is the same student: it stays deleted even when its
      // data's lineage changed, a lost backup.key). Another copy's purges and name scrubs never run here (moving
      // PCs, or undoing a restore from another PC), and the union is kept, so restoring either data later still
      // re-applies its own.
      merged = scopeLedgers({ current: currentLedger.entries, currentLineage, backup: backupLedger.entries, backupLineage: lineage });
      const scoped = applicableEntries(db, merged, lineage);
      otherData = scoped.otherData;
      if (scoped.crossData) log(`[restore] ${scoped.crossData} account deletion(s) recorded on other data applied: their accounts are in this backup`);
      // Every pepper a deletion's username hash may have been made with (LedgerEntry.hashKey picks the one).
      const applied = await applyLedger(db, scoped.entries, { peppers: [curPepper, recPepper, pepper, ...previousPeppers] });
      ledger = { entries: applied.entries, changed: applied.changed };
      if (otherData) log(`[restore] ${otherData} deletion ledger entr${otherData === 1 ? 'y belongs' : 'ies belong'} to other data (another copy's, or from before a move): kept, not applied`);
      if (applied.unmatchedHashKeys) {
        notes.push(`${applied.unmatchedHashKeys} deletion(s) in the ledger were recorded with a pepper this PC does not have: their accounts were removed again, but their guest-era lines and their name in audit and report text could not be matched. Restore with the recovery file of the copy that recorded them (--recovery) to apply them fully.`);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM admin_sessions');
        db.exec('DELETE FROM host_admins');
        db.exec('DELETE FROM host_setup');
        adminsKept = copyRows(db, 'host_admins', current.hostAdmins);
        copyRows(db, 'host_setup', current.hostSetup);
        const actor = o.by.split(':')[0] || 'host';
        db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, reason) VALUES (?, ?, ?, 'restore', ?)`)
          .run(now(), actor.slice(0, 64), o.by.slice(0, 64), `Restored ${name}${safetyBackup ? ` (the data before it: ${safetyBackup})` : ''}${fromOtherInstall ? ' from another copy' : ''}`.slice(0, 500));
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* rolled back */ }
        throw e;
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA journal_mode = DELETE');
    } finally {
      db.close();
    }
  } catch (e) {
    cleanup();
    if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC' || /SQLITE_FULL|database or disk is full/i.test(errMsg(e))) {
      return fail('EDISK', `The data drive filled up while the backup was prepared: free some space, then restore again. Nothing was changed.`, safetyBackup);
    }
    return fail('ECHECK', `The backup's database could not be prepared: ${errMsg(e)}`, safetyBackup);
  }

  // The merged ledger (every entry with the lineage of its data) is saved before the swap, so no entry is ever left
  // without one beside data it doesn't belong to (the worker's ledger.apply takes those for the live data's). It only
  // grows: saved for a restore that then fails, it changes nothing a later restore applies wrongly. When it can't be
  // saved (a read-only or locked data\deletions.jsonl), nothing is swapped: the old ledger's entries that carry no
  // lineage would otherwise sit beside the restored data and be applied to it.
  try {
    writeLedger(ledgerPath(dataDir), merged, { keep: unknownLines });
  } catch (e) {
    cleanup();
    return fail('ELEDGER', `The deletion ledger (data\\deletions.jsonl) could not be saved (${errMsg(e)}), so nothing was changed. Make sure the file is not read-only or open in another program, then restore again.`, safetyBackup);
  }

  // The pepper the restored data needs goes in BEFORE the swap, so the database and its pepper never disagree:
  //  - the one it replaces is kept first (pepper.previous.json), and the swap journal names both and fingerprints the
  //    restored database, so a crash before the swap completes is undone at the next start
  //    (recoverInterruptedRestore puts the old pepper back unless the restored database is in place);
  //  - a failure here changes nothing, and a failed swap puts the old one back.
  const secretsInstalled: string[] = [];
  let undoPepper: (() => void) | null = null;
  let journal = false;
  let previousKept = false;
  const rollbackPepper = (): void => {
    let undone = true;
    try { undoPepper?.(); } catch { undone = false; /* the journal stays: the next start puts the old pepper back */ }
    undoPepper = null;
    secretsInstalled.length = 0;
    if (journal && undone) clearSwapJournal(dataDir);
    journal = false;
  };
  if (installPepper && pepper) {
    try {
      if (curPepper) previousKept = rememberPepper(secrets.dir, curPepper, now());
      const fp = secrets.dir ? dbFingerprint(stagedDb) : null;
      if (fp) {
        writeSwapJournal(dataDir, { v: 1, at: now(), backup: name, prevPepperId: curPepper ? pepperIdOf(curPepper) : null, newPepperId: pepperIdOf(pepper), newDb: fp });
        journal = true;
      }
      const old = curPepper;
      secrets.write('pepper.key', pepper);
      secretsInstalled.push('pepper.key');
      undoPepper = () => { if (old === null) secrets.remove('pepper.key'); else secrets.write('pepper.key', old); };
    } catch (e) {
      rollbackPepper();
      cleanup();
      return fail('ESECRET', `The keys this backup needs could not be saved in data\\secrets (${errMsg(e)}), so nothing was changed.`, safetyBackup);
    }
  }

  // 5. Swap it in.
  const replaced = dbPath + REPLACED_SUFFIX;
  // The current file and its -wal / -shm / -journal move aside together, and move back if the swap fails. Nothing is
  // left beside the new file: SQLite would replay an old WAL (or roll back an old journal) onto it, whether or not the
  // database it belonged to is still there.
  const moved: [string, string][] = [];
  const move = (from: string, to: string): void => { fs.renameSync(from, to); moved.push([from, to]); };
  try {
    if (current.exists && current.readable) {
      // A voidswarm.db.replaced still here is one recoverInterruptedRestore kept (the only copy of the data from
      // before an interrupted restore, with no safety backup) and could not move aside then: never replaced here.
      if ([replaced, ...DB_SIDECARS.map((x) => replaced + x)].some((f) => fs.existsSync(f))) {
        const kept = moveDbAside(dataDir, replaced, now());
        if (kept) notes.push(`The database kept from an interrupted restore (data\\${DB_FILE}${REPLACED_SUFFIX}) is now in data\\${path.basename(kept)}, for 35 days.`);
      }
      move(dbPath, replaced);
      for (const x of DB_SIDECARS) if (fs.existsSync(dbPath + x)) move(dbPath + x, replaced + x);
    } else if (aside) {
      // Never delete what could not be backed up: an unreadable database, or a -wal / -journal with no database,
      // goes into its own folder. One tag per restore, so the files there still pair up (voidswarm.db.<tag>-wal).
      fs.mkdirSync(aside, { recursive: true });
      const tag = randomBytes(2).toString('hex');
      const base = path.join(aside, `${DB_FILE}.${tag}`);
      if (fs.existsSync(dbPath)) move(dbPath, base);
      for (const x of DB_SIDECARS) if (fileBytes(dbPath + x) > 0 && x !== '-shm') move(dbPath + x, base + x);
    }
    // What is left (an empty -wal or journal, a -shm: an index of a WAL that is gone) holds nothing.
    for (const x of DB_SIDECARS) fs.rmSync(dbPath + x, { force: true });
    for (const x of DB_SIDECARS) fs.rmSync(stagedDb + x, { force: true });
    fs.renameSync(stagedDb, dbPath);
  } catch (e) {
    for (const [from, to] of moved.reverse()) {
      try { if (!fs.existsSync(from) && fs.existsSync(to)) fs.renameSync(to, from); } catch { /* recoverInterruptedRestore does the main file next time */ }
    }
    if (aside) { try { fs.rmdirSync(aside); } catch { /* not empty (a move could not be undone) or never made */ } }
    rollbackPepper();
    cleanup();
    return fail('ESWAP', `The database could not be replaced (${errMsg(e)}); the current data was left as it was.`, safetyBackup);
  }
  rmDbFiles(replaced);
  if (journal) clearSwapJournal(dataDir);

  // 6. Another install's SMTP password (not tied to the database: after the swap), and what the pepper installed
  // above means for the host.
  // The SMTP password belongs with the other install's mail server: it goes in with its settings (--settings; before
  // them, so they see it), or when this PC has none of its own. This PC's own is never lost (backups never hold
  // secrets, §6.1): kept aside here, it goes back if the settings then don't come.
  const cfg = path.join(staging, CONFIG_FILE);
  const withConfig = !!o.restoreConfig && fs.existsSync(cfg);
  let ownSmtp: string | null = null;
  let smtpInstalled = false;
  if (fromOtherInstall && rec?.smtpPassword) {
    let hasOwn = true;
    try { hasOwn = secrets.has('smtp.secret'); } catch { hasOwn = true; }
    let readable = true;
    if (hasOwn) { try { ownSmtp = secrets.readText('smtp.secret'); } catch { readable = false; } }
    if (hasOwn && (!withConfig || !readable || ownSmtp === null)) {
      notes.push(withConfig
        ? 'The SMTP password in the recovery file was not installed: this PC\'s own could not be read to keep it, so it was left as it is. Enter the other copy\'s in Settings → Mail if you use its mail server.'
        : 'The SMTP password in the recovery file was not installed: it goes with the other copy\'s mail settings, which were not restored, so this PC keeps its own (restore with --settings to take both).');
    } else {
      try {
        secrets.write('smtp.secret', rec.smtpPassword);
        secretsInstalled.push('smtp.secret');
        smtpInstalled = true;
      } catch (e) {
        notes.push(`The SMTP password from the recovery file could not be saved (${errMsg(e)}): enter it again in Settings → Mail.`);
      }
    }
  }
  if (secretsInstalled.includes('pepper.key') && pepper && curPepper && !curPepper.equals(pepper) && safetyBackup) {
    notes.push(previousKept
      // The data from before the restore was made with the pepper just replaced: it is kept, so restoring the safety
      // backup puts it back (backups never hold secrets, §6.1).
      ? `This PC's previous pepper was replaced by the one this backup needs. It is kept in data\\secrets, so restoring ${safetyBackup} (the data from before this restore) puts it back.`
      : `This PC's previous pepper was replaced by the one this backup needs. The data from before the restore (${safetyBackup}) was made with the old one: to go back to it, restore ${safetyBackup} with this PC's previous recovery file ("Restore a backup.cmd --recovery <that file>"). Without that file, email look-ups and address tags in that older data stop working.`);
  }
  if (fromOtherInstall && rec) {
    notes.push('This PC has its own backup key: create a new recovery file for it (Server → Backups) and keep it apart from this PC.');
  }

  // 7. The settings, when asked (validated field by field).
  let configRestored = false;
  if (o.restoreConfig) {
    if (!withConfig) notes.push('The backup holds no settings: the current settings were kept.');
    else {
      let own: SettingsService | null = null;
      try {
        const raw = JSON.parse(fs.readFileSync(cfg, 'utf8')) as unknown;
        const svc = o.settings ?? (own = SettingsService.open({ dataDir, env: {}, lan: true, envWarnings: false, secrets, log: (l) => log(l) }));
        const actor: SettingsActor = { accountId: o.by.split(':')[0] || 'host', name: o.by.slice(0, 64) || 'host' };
        const r = await svc.restore(raw, actor, { keepInstallId: !fromOtherInstall, context: `restore ${name}` });
        if (r.ok) {
          configRestored = true;
          for (const w of r.warnings ?? []) notes.push(`Settings: ${w}`);
        } else notes.push(`The settings in the backup could not be restored (${r.error}): the current settings were kept.`);
      } catch (e) {
        notes.push(`The settings in the backup could not be read (${errMsg(e)}): the current settings were kept.`);
      } finally {
        if (own) await own.close();
      }
    }
  }
  if (smtpInstalled && !configRestored && ownSmtp !== null) {
    // The other copy's mail settings did not come after all: this PC's own password goes back with its own.
    try {
      secrets.write('smtp.secret', ownSmtp);
      secretsInstalled.splice(secretsInstalled.indexOf('smtp.secret'), 1);
      notes.push('The SMTP password in the recovery file was not kept: the settings did not come with it, so this PC keeps its own.');
    } catch (e) {
      notes.push(`This PC's own SMTP password could not be put back (${errMsg(e)}): enter it again in Settings → Mail.`);
    }
  }
  cleanup();
  // A restore staged in the panel and not yet applied would undo this one at the next start.
  if (readPendingRestore(dataDir)?.backup && cancelPendingRestore(dataDir)) {
    notes.push('The restore that was staged in the Host Control Panel was cancelled: this restore replaced it.');
  }

  const when = new Date(extracted.manifest.createdAt || now()).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const message = `Restored the backup from ${when} (${name})${fromOtherInstall ? ' from another copy of Voidswarm' : ''}.`
    + (safetyBackup ? ` The data from before the restore is in ${safetyBackup}.` : '')
    + (ledger.changed ? ` ${ledger.changed} deletion(s) made since that backup were applied again.` : '')
    + (adminsKept ? ' The host admin login is unchanged.' : ' Set up the host admin login again (first-run setup).');
  log(`[restore] ${message}`);
  writeLastRestore(dataDir, { at: now(), ok: true, backup: name, message, safetyBackup });
  return {
    ok: true, backup: name, safetyBackup, fromOtherInstall, schemaFrom: checked.version, schemaTo, ledger, adminsKept, configRestored,
    secretsInstalled, notes, message,
  };
}

// ------------------------------------------------------------------------------------------
// The launcher's hook (§2.2 step 8)
// ------------------------------------------------------------------------------------------

/**
 * launch.ts `stagedWork`: apply a restore staged from the panel, before the server starts. The pending file is
 * removed first (a failing restore never loops); the outcome goes to data\restore.last.json and the returned notes
 * (the launcher shows them as banners). After it, the launcher should re-read its settings (a restore may have
 * replaced them).
 */
export async function applyStagedRestore(ctx: { paths: LanPaths; log: Pick<HostLog, 'write'>; settings?: unknown }, deps: { now?: () => number; statfs?: StatfsFn } = {}): Promise<string[]> {
  const dataDir = ctx.paths.data;
  const notes: string[] = [];
  const interrupted = recoverInterruptedSwap(dataDir);
  if (interrupted) notes.push(interrupted);
  // A restore killed after decrypting left the database in plain text in data\restore.staging: no restore runs now.
  if (cleanupRestoreStaging(dataDir)) ctx.log.write('removed the leftover data\\restore.staging of an interrupted restore');
  const pending = readPendingRestore(dataDir);
  if (!pending) {
    if (fs.existsSync(path.join(dataDir, 'restore.pending.json'))) {
      cancelPendingRestore(dataDir);
      notes.push('A staged restore could not be read and was dropped: stage it again in Server → Backups.');
    }
    return notes;
  }
  if (!cancelPendingRestore(dataDir)) {
    notes.push('The staged restore could not be taken (its file is locked): nothing was restored.');
    return notes;
  }
  ctx.log.write(`restoring the staged backup ${pending.backup}`);
  const r = await restoreBackup({
    dataDir, backupFile: path.join(backupsDir(dataDir), pending.backup), restoreConfig: pending.restoreConfig, by: pending.by || 'host',
    log: (l) => ctx.log.write(l), now: deps.now, statfs: deps.statfs,
  });
  if (r.ok) notes.push(r.message, ...r.notes);
  else notes.push(`The staged restore of ${pending.backup} did not happen: ${r.message}`);
  return notes;
}

// ------------------------------------------------------------------------------------------
// Restore a backup.cmd (tool restore)
// ------------------------------------------------------------------------------------------

export interface ToolIo {
  write(line: string): void;
  /** One answer (null at end of input). `secret` hides what is typed. */
  ask(question: string, opts?: { secret?: boolean }): Promise<string | null>;
  close?(): void;
}

/** The console (tool stubs read it normally; they don't use `call <nul`). */
export function consoleIo(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): ToolIo {
  const rl = readline.createInterface({ input, output, terminal: (input as { isTTY?: boolean }).isTTY === true });
  let muted = false;
  const r = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
  const orig = r._writeToOutput?.bind(rl);
  r._writeToOutput = (s: string): void => {
    if (!muted) { orig?.(s); return; }
    if (s.includes('\n') || s.includes('\r')) output.write('\n');
  };
  let ended = false;
  rl.on('close', () => { ended = true; });
  return {
    write: (line) => { output.write(`${line}\n`); },
    ask: (question, opts = {}) => new Promise((resolve) => {
      if (ended) { resolve(null); return; }
      const onClose = (): void => resolve(null);
      rl.once('close', onClose);
      rl.question(question, (a) => { rl.off('close', onClose); muted = false; resolve(a); });
      muted = opts.secret === true;
    }),
    close: () => rl.close(),
  };
}

export const RESTORE_USAGE = [
  'Usage: Restore a backup.cmd [--recovery <file.vsrec>] [--backup <file.vsbak>] [--settings] [--yes] [--data <folder>]',
  '  --recovery <file>   the recovery file of the copy that made the backup (a backup from another PC)',
  '  --backup <file>     restore this .vsbak file (default: choose from data\\backups)',
  '  --settings          also restore the settings saved in the backup',
  '  --yes               don\'t ask for the confirmation',
  '  --data <folder>     (advanced) the data folder',
].join('\n');

export interface RestoreToolFlags { recovery: string | null; backup: string | null; settings: boolean; yes: boolean; data: string | null }

export function parseRestoreArgs(argv: readonly string[], cwd = process.cwd()): RestoreToolFlags | { error: string } {
  const f: RestoreToolFlags = { recovery: null, backup: null, settings: false, yes: false, data: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (flag: string): string | null => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1) || null;
      const v = argv[++i];
      return v && !v.startsWith('--') ? v : null;
    };
    if (a === '--settings') f.settings = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--recovery' || a.startsWith('--recovery=')) { const v = value('--recovery'); if (!v) return { error: '--recovery needs a .vsrec file.' }; f.recovery = path.resolve(cwd, v); }
    else if (a === '--backup' || a.startsWith('--backup=')) { const v = value('--backup'); if (!v) return { error: '--backup needs a .vsbak file.' }; f.backup = path.resolve(cwd, v); }
    else if (a === '--data' || a.startsWith('--data=')) { const v = value('--data'); if (!v) return { error: '--data needs a folder.' }; f.data = path.resolve(cwd, v); }
    else if (a === 'restore') continue; // tool.ts may pass its subcommand through
    else return { error: `Unknown option: ${a.slice(0, 60)}` };
  }
  return f;
}

export interface RestoreToolDeps {
  io?: ToolIo;
  /** the install root (default: from the tool's own file, app\tool.mjs) */
  root?: string;
  toolFile?: string;
  cwd?: string;
  platform?: Platform;
  /** the pipe path (tests) */
  pipe?: string;
  now?: () => number;
  statfs?: StatfsFn;
  /**
   * Creates and protects data\secrets (and tls\) BEFORE the restore writes a secret into it, when it isn't there yet
   * (a fresh unzip; the launcher does the same at first start). Default: prepareSecretsDir with acl.ts protectDir for
   * the current user. Returns problem texts.
   */
  protectSecrets?: (dataDir: string) => Promise<string[]>;
}

export const RESTORE_EXIT = { OK: 0, FAILED: 1, USAGE: 4 } as const;

/** data\secrets for a fresh data folder: created and given the owner / SYSTEM / Administrators ACL first (§2.2 step 3). */
async function protectNewSecrets(dataDir: string, platform?: Platform): Promise<string[]> {
  let sid: string | null = null;
  try { sid = (await readToken({ platform })).userSid; } catch { sid = null; }
  const r = await prepareSecretsDir(dataDir, { platform, protectDir: sid ? (d: string) => protectDir(d, sid!, { platform }) : undefined });
  return r.errors;
}

const fmtWhen = (t: number): string => {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** `Restore a backup.cmd`: returns the exit code. */
export async function runRestoreTool(argv: readonly string[], deps: RestoreToolDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo();
  try {
    const flags = parseRestoreArgs(argv, deps.cwd);
    if ('error' in flags) { io.write(flags.error); io.write(RESTORE_USAGE); return RESTORE_EXIT.USAGE; }
    const root = deps.root ?? rootFromLauncher(deps.toolFile ?? process.argv[1] ?? process.cwd(), deps.platform);
    const paths = lanPaths(root, { data: flags.data ?? undefined, platform: deps.platform });
    const dataDir = paths.data;
    // A fresh unzip on a new PC (§6.3 "Moving to another PC: a backup plus the recovery file … or tool restore
    // --recovery"): the data folder is made here, before the host ever ran.
    let madeDataDir = false;
    if (!fs.existsSync(dataDir)) {
      if (!flags.backup) {
        io.write(`There is no data folder at ${dataDir} yet (the host has never run from this folder).`);
        io.write('To bring in a backup from another PC: Restore a backup.cmd --backup <file.vsbak> --recovery <file.vsrec>');
        return RESTORE_EXIT.FAILED;
      }
      if (!fs.existsSync(flags.backup)) { io.write(`There is no backup at ${flags.backup}.`); return RESTORE_EXIT.FAILED; }
      fs.mkdirSync(dataDir, { recursive: true });
      madeDataDir = true;
    }
    /** A data folder this run made, still empty (a cancel): removed again. */
    const dropMadeDataDir = (): void => { if (madeDataDir) { try { fs.rmdirSync(dataDir); } catch { /* not empty: keep it */ } } };

    // The host lock: a running host refuses the restore, and no host can start while it runs.
    const secrets = openFileSecrets(dataDir, { platform: deps.platform });
    let pipeKey: Buffer | null = null;
    try { pipeKey = secrets.read('pipe.key'); } catch { pipeKey = null; }
    const got = await acquireLock({
      dataDir, key: pipeKey && pipeKey.length >= 16 ? pipeKey : null, platform: deps.platform, pipe: deps.pipe, unref: true,
      handlers: { panelUrl: () => '', status: () => ({ restoring: true }), version: GAME_VERSION },
    });
    if (!got.ok) {
      io.write('Voidswarm is running on this data folder. Stop the host first (Stop in the Host Control Panel, or close the Voidswarm Host window), then run Restore a backup.cmd again.');
      return RESTORE_EXIT.FAILED;
    }
    let restored = false;
    try {
      // A recovery file (a backup from another PC).
      let recovery: RecoveryContents | null = null;
      if (flags.recovery) {
        let buf: Buffer;
        try { buf = fs.readFileSync(flags.recovery); } catch (e) { io.write(`Can't read ${flags.recovery}: ${errMsg(e)}`); return RESTORE_EXIT.FAILED; }
        for (let attempt = 0; attempt < 3 && !recovery; attempt++) {
          const pass = await io.ask('Passphrase of the recovery file (the 4 words, or your own): ', { secret: true });
          if (pass === null || !pass.trim()) { io.write('Cancelled: nothing was changed.'); return RESTORE_EXIT.FAILED; }
          try {
            recovery = await decryptRecovery(buf, pass);
          } catch (e) {
            if (e instanceof RecoveryError && e.code === 'EPASS' && attempt < 2) { io.write('That passphrase does not open the recovery file. Try again.'); continue; }
            io.write(errMsg(e));
            return RESTORE_EXIT.FAILED;
          }
        }
        if (!recovery) return RESTORE_EXIT.FAILED;
        io.write(`Recovery file of "${recovery.serverName || 'Voidswarm'}" opened.`);
      }

      // The backup.
      const ownKey = secrets.has('backup.key') ? secrets.read('backup.key') : null;
      const recKey = recovery ? recoverySecrets(recovery).backupKey : null;
      const opens = (keyId: string | null): 'own' | 'recovery' | null => {
        if (!keyId) return null;
        if (ownKey && keyIdOf(ownKey) === keyId) return 'own';
        if (recKey && keyIdOf(recKey) === keyId) return 'recovery';
        return null;
      };
      let chosen: { file: string; name: string } | null = null;
      if (flags.backup) {
        if (!fs.existsSync(flags.backup)) { io.write(`There is no backup at ${flags.backup}.`); return RESTORE_EXIT.FAILED; }
        chosen = { file: flags.backup, name: path.basename(flags.backup) };
      } else {
        const list: BackupInfo[] = listBackups(dataDir, { key: ownKey });
        if (!list.length) {
          io.write(`There are no backups in ${backupsDir(dataDir)}.`);
          if (flags.recovery) io.write('Give the backup from the other PC with --backup <file.vsbak>.');
          return RESTORE_EXIT.FAILED;
        }
        io.write(`Backups in ${backupsDir(dataDir)} (newest first):`);
        list.forEach((b, i) => {
          const o = opens(b.keyId);
          const tag = (o === 'recovery' ? '  (another copy: opened with the recovery file)' : o === null ? '  (another copy: needs its recovery file, --recovery)' : '')
            + (b.future ? '  (dated later than this PC\'s clock)' : '');
          io.write(`  ${String(i + 1).padStart(2)}  ${fmtWhen(b.future ? b.stampAt : b.createdAt)}  ${(b.cls + (b.detail ? ` ${b.detail}` : '')).padEnd(22)} ${sizeText(b.size).padStart(8)}${tag}`);
        });
        const a = await io.ask(`Which backup? Type its number (1-${list.length}), or press Enter to cancel: `);
        const n = a === null ? NaN : Number(a.trim());
        if (!a || !Number.isInteger(n) || n < 1 || n > list.length) { io.write('Cancelled: nothing was changed.'); return RESTORE_EXIT.FAILED; }
        chosen = { file: list[n - 1]!.file, name: list[n - 1]!.name };
      }
      let keyId: string | null = null;
      try { keyId = readBackupHeader(chosen.file).keyId; } catch (e) { io.write(errMsg(e)); return RESTORE_EXIT.FAILED; }
      if (!opens(keyId)) {
        io.write(recovery
          ? 'This recovery file belongs to another copy of Voidswarm than the one that made this backup: nothing was changed.'
          : 'This backup was made by another copy of Voidswarm. Run "Restore a backup.cmd --recovery <file.vsrec>" with that copy\'s recovery file.');
        return RESTORE_EXIT.FAILED;
      }

      let restoreConfig = flags.settings;
      if (!flags.settings && !flags.yes) {
        const a = await io.ask('Also restore the settings saved in this backup? [y/N]: ');
        restoreConfig = !!a && /^y(es)?$/i.test(a.trim());
      }
      if (!flags.yes) {
        io.write(`This replaces the accounts, the chat log and the records with the ones in ${chosen.name}.`);
        io.write('The current data is backed up first, and the host admin login stays as it is now.');
        const a = await io.ask('Type YES to restore: ');
        if (!a || a.trim().toUpperCase() !== 'YES') { io.write('Cancelled: nothing was changed.'); return RESTORE_EXIT.FAILED; }
      }
      io.write('Restoring…');
      if (!fs.existsSync(secretsDir(dataDir))) {
        for (const p of await (deps.protectSecrets ?? ((d: string) => protectNewSecrets(d, deps.platform)))(dataDir)) io.write(`  - ${p}`);
      }
      const r = await restoreBackup({
        dataDir, backupFile: chosen.file, secrets, recovery, restoreConfig, by: 'cli', now: deps.now, statfs: deps.statfs,
      });
      if (!r.ok) { io.write(`The restore did not happen: ${r.message}`); return RESTORE_EXIT.FAILED; }
      restored = true;
      io.write(r.message);
      for (const n of r.notes) io.write(`  - ${n}`);
      io.write('Start Voidswarm Host.cmd to run it.');
      return RESTORE_EXIT.OK;
    } finally {
      await got.lock.close();
      if (!restored) dropMadeDataDir();
    }
  } catch (e) {
    io.write(`The restore failed: ${errMsg(e)}`);
    return RESTORE_EXIT.FAILED;
  } finally {
    io.close?.();
  }
}
