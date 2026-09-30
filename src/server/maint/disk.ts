// OWNER: SERVER MODERATION (LAN task B5). Disk checks (docs/LAN-EDITION-proposal.md §5.16 "Disk", §6.1):
// free space on the data drive is checked at start and hourly.
//  - below 2 GB: backups are skipped, with a banner;
//  - below 500 MB: the red banner "Chat may stop being logged" (level 'urgent', the admin API's red).
// A backup is also skipped when its own copy would not fit (the snapshot plus the encrypted file, pessimistically)
// while leaving 500 MB; Compact needs twice the database size free. The thresholds match src/lan/preflight.ts
// (DISK_LOW_BYTES / DISK_CRITICAL_BYTES), which reports the same at launch.
import * as fs from 'node:fs';

export const BACKUP_MIN_FREE_BYTES = 2 * 1024 ** 3;
export const CHAT_MIN_FREE_BYTES = 500 * 1024 ** 2;
export const DISK_CHECK_INTERVAL_MS = 60 * 60_000;

export type DiskLevel = 'ok' | 'low' | 'critical' | 'unknown';

export interface DiskStatus {
  path: string;
  /** -1 when unknown */
  freeBytes: number;
  totalBytes: number;
  level: DiskLevel;
  checkedAt: number;
  error?: string;
}

/** A Home / Server banner: the same shape as the admin API's (moderation/http.ts Banner). */
export interface Banner {
  code: string;
  level: 'info' | 'warn' | 'urgent';
  text: string;
}

export type StatfsFn = (p: string) => Promise<{ bavail: number; bsize: number; blocks: number }> | { bavail: number; bsize: number; blocks: number };

export const defaultStatfs: StatfsFn = (p) => fs.promises.statfs(p);

export function diskLevel(freeBytes: number): DiskLevel {
  if (!(freeBytes >= 0)) return 'unknown';
  if (freeBytes < CHAT_MIN_FREE_BYTES) return 'critical';
  if (freeBytes < BACKUP_MIN_FREE_BYTES) return 'low';
  return 'ok';
}

/** "1.4 GB" / "380 MB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Free space on the drive that holds `dir`. Never throws (level 'unknown' with the error). */
export async function checkDisk(dir: string, opts: { statfs?: StatfsFn; now?: number } = {}): Promise<DiskStatus> {
  const checkedAt = opts.now ?? Date.now();
  try {
    const s = await (opts.statfs ?? defaultStatfs)(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    return { path: dir, freeBytes, totalBytes, level: diskLevel(freeBytes), checkedAt };
  } catch (e) {
    return { path: dir, freeBytes: -1, totalBytes: -1, level: 'unknown', checkedAt, error: String((e as Error)?.message ?? e) };
  }
}

export const DISK_LOW_TEXT = (free: number): string => `Only ${sizeText(free)} free on the data drive: backups are skipped below 2 GB. Free some space.`;
export const DISK_CRITICAL_TEXT = (free: number): string => `Only ${sizeText(free)} free on the data drive: chat may stop being logged. Free some space now.`;

/** The Home / Server banners for a disk status (none when fine or unknown). */
export function diskBanners(d: DiskStatus | null): Banner[] {
  if (!d || d.freeBytes < 0) return [];
  if (d.level === 'critical') return [{ code: 'disk-critical', level: 'urgent', text: DISK_CRITICAL_TEXT(d.freeBytes) }];
  if (d.level === 'low') return [{ code: 'disk-low', level: 'warn', text: DISK_LOW_TEXT(d.freeBytes) }];
  return [];
}

/** SQLite's primary result codes for a full drive and an I/O error (extended codes keep them in the low byte). */
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;

/**
 * Is this error from a chat-log write a full drive or an I/O failure (§5.16: `SQLITE_FULL` or I/O errors on the chat
 * write)? node:sqlite errors carry `errcode`; ENOSPC / EIO come from fs.
 */
export function isStorageFailure(e: unknown): boolean {
  const x = e as { errcode?: unknown; code?: unknown; message?: unknown } | null;
  if (!x || typeof x !== 'object') return false;
  if (typeof x.errcode === 'number') {
    const primary = x.errcode & 0xff;
    if (primary === SQLITE_FULL || primary === SQLITE_IOERR) return true;
  }
  if (x.code === 'ENOSPC' || x.code === 'EIO' || x.code === 'EDQUOT') return true;
  return /database or disk is full|disk I\/O error/i.test(String(x.message ?? ''));
}

export const CHAT_NOT_LOGGED_TEXT = 'Chat is NOT being logged: the data drive is full or failing. Free some space on it (or check the drive), then restart the host.';

/**
 * The red "Chat is NOT being logged" banner for a failed chat-log write (null when the error is something else). The
 * moderation store's flush calls it with the error it caught (B8b), and the banner stays until a write succeeds.
 */
export function chatWriteBanner(e: unknown): Banner | null {
  return isStorageFailure(e) ? { code: 'chat-not-logged', level: 'urgent', text: CHAT_NOT_LOGGED_TEXT } : null;
}

/** The "DB over 1 GB" banner (§5.1 banners; §8.3 "When to archive"): the database plus its WAL. */
export const DB_LARGE_BYTES = 1024 ** 3;
export const DB_LARGE_TEXT = (bytes: number): string =>
  `The database is ${sizeText(bytes)} (over 1 GB): archive the chat log at the term end (export it to district storage, then purge the old lines), or shorten the retention.`;

/** The banner for a database of `dbBytes` (the file plus its -wal), or null below 1 GB. */
export function dbSizeBanner(dbBytes: number): Banner | null {
  return dbBytes > DB_LARGE_BYTES ? { code: 'db-large', level: 'info', text: DB_LARGE_TEXT(dbBytes) } : null;
}

/** The size of a database file and its -wal (0 for a missing file). */
export function dbFileBytes(dbPath: string): { dbBytes: number; walBytes: number } {
  const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
  return { dbBytes: size(dbPath), walBytes: size(`${dbPath}-wal`) };
}

/** The estimated peak extra space a backup needs: the snapshot, plus the encrypted file (at most ~half the snapshot). */
export const backupEstimateBytes = (dbBytes: number): number => Math.ceil(Math.max(0, dbBytes) * 1.5) + 16 * 1024 * 1024;

export type BackupSpace = { ok: true } | { ok: false; why: 'low' | 'fit'; text: string };

/** May a backup of a `dbBytes` database run with this much free space? (Unknown free space: yes.) */
export function backupSpace(d: DiskStatus | null, dbBytes: number): BackupSpace {
  if (!d || d.freeBytes < 0) return { ok: true };
  if (d.freeBytes < BACKUP_MIN_FREE_BYTES) return { ok: false, why: 'low', text: DISK_LOW_TEXT(d.freeBytes) };
  const need = backupEstimateBytes(dbBytes);
  if (d.freeBytes - need < CHAT_MIN_FREE_BYTES) {
    return { ok: false, why: 'fit', text: `A backup needs about ${sizeText(need)} and only ${sizeText(d.freeBytes)} is free on the data drive: it was skipped. Free some space.` };
  }
  return { ok: true };
}

/** Compact (VACUUM) needs twice the database size free (§5.16). */
export function compactSpace(d: DiskStatus | null, dbBytes: number): BackupSpace {
  if (!d || d.freeBytes < 0) return { ok: true };
  if (d.freeBytes < 2 * dbBytes + CHAT_MIN_FREE_BYTES) {
    return { ok: false, why: 'fit', text: `Compact needs ${sizeText(2 * dbBytes)} free on the data drive (twice the database); only ${sizeText(d.freeBytes)} is free.` };
  }
  return { ok: true };
}

/**
 * The hourly check (§5.16): `start()` checks now and then every hour; `onChange` fires when the level changes.
 * The timer is unref'd (it never keeps the process alive).
 */
export class DiskMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cur: DiskStatus | null = null;
  constructor(private readonly opts: {
    dir: string;
    statfs?: StatfsFn;
    now?: () => number;
    intervalMs?: number;
    onChange?: (next: DiskStatus, prev: DiskStatus | null) => void;
  }) {}

  get status(): DiskStatus | null { return this.cur; }

  async check(): Promise<DiskStatus> {
    const next = await checkDisk(this.opts.dir, { statfs: this.opts.statfs, now: (this.opts.now ?? Date.now)() });
    const prev = this.cur;
    this.cur = next;
    if (!prev || prev.level !== next.level) {
      try { this.opts.onChange?.(next, prev); } catch { /* a listener's problem */ }
    }
    return next;
  }

  async start(): Promise<DiskStatus> {
    const first = await this.check();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.check(); }, this.opts.intervalMs ?? DISK_CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }
    return first;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
