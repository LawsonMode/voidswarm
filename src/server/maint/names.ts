// OWNER: SERVER MODERATION (LAN task B5). Backup file names (docs/LAN-EDITION-proposal.md §6.1):
//   data\backups\2026-09-28_0712_start.vsbak
//   data\backups\2026-09-28_0712_pre-update-0.6.1.vsbak      (a detail after the class)
//   data\backups\2026-09-28_0712_manual_2.vsbak              (a second one in the same minute)
// The stamp is the host PC's local time (the host reads these names in Explorer and on the Server panel). The name
// carries the class, which the age and count caps work from (retention.ts), so a listing needs no decryption.

export const BACKUP_EXT = '.vsbak';
export const BACKUPS_DIR = 'backups';

/**
 * The classes (§6.1 "When"): at start, daily (and the weekly one a daily run is promoted to), on demand, and before
 * a migration, an update, a restore, a term purge, a New certificate or an import.
 */
export const BACKUP_REASONS = [
  'start', 'daily', 'weekly', 'manual', 'pre-migration', 'pre-update', 'pre-restore', 'pre-purge', 'pre-cert', 'pre-import',
] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];
export type BackupClass = BackupReason | 'other';

export const isBackupReason = (v: unknown): v is BackupReason => typeof v === 'string' && (BACKUP_REASONS as readonly string[]).includes(v);

const DETAIL_RE = /^[0-9A-Za-z.]{1,24}$/;
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** A detail (a version, a schema number) cleaned for a file name, or null. */
export function cleanDetail(detail: unknown): string | null {
  if (typeof detail !== 'string') return null;
  const s = detail.replace(/[^0-9A-Za-z.]+/g, '').replace(/^\.+|\.+$/g, '').slice(0, 24);
  return DETAIL_RE.test(s) ? s : null;
}

/** "2026-09-28_0712" in local time. */
export function backupStamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * The file name for a new backup. `taken(name)` says whether a name is already used (two in one minute get _2, _3…).
 */
export function backupFileName(reason: BackupReason, at: number, opts: { detail?: string | null; taken?: (name: string) => boolean } = {}): string {
  const detail = cleanDetail(opts.detail);
  const base = `${backupStamp(at)}_${reason}${detail ? `-${detail}` : ''}`;
  const taken = opts.taken ?? (() => false);
  if (!taken(`${base}${BACKUP_EXT}`)) return `${base}${BACKUP_EXT}`;
  for (let i = 2; i < 100; i++) {
    const n = `${base}_${i}${BACKUP_EXT}`;
    if (!taken(n)) return n;
  }
  throw new Error('backupFileName: too many backups in one minute');
}

export interface ParsedBackupName {
  name: string;
  cls: BackupClass;
  detail: string | null;
  /** epoch ms of the local-time stamp */
  at: number;
  /** 1 for the first in its minute, 2 for "_2", … */
  seq: number;
}

const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_(.+?)(?:_(\d{1,2}))?\.vsbak$/;
const BY_LENGTH = [...BACKUP_REASONS].sort((a, b) => b.length - a.length);

/** Parse a backup file name (null when it is not one of ours). */
export function parseBackupName(name: string): ParsedBackupName | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const at = new Date(y, mo - 1, d, h, mi).getTime();
  if (!Number.isFinite(at)) return null;
  const rest = m[6]!;
  let cls: BackupClass = 'other';
  let detail: string | null = null;
  for (const r of BY_LENGTH) {
    if (rest === r) { cls = r; break; }
    if (rest.startsWith(`${r}-`) && DETAIL_RE.test(rest.slice(r.length + 1))) { cls = r; detail = rest.slice(r.length + 1); break; }
  }
  if (cls === 'other') {
    if (!/^[a-z][a-z0-9.-]{0,40}$/.test(rest)) return null;
    detail = rest;
  }
  return { name, cls, detail, at, seq: m[7] ? Number(m[7]) : 1 };
}

/** Newest first (stamp, then the same-minute counter). */
export function compareNewestFirst(a: { at: number; seq?: number }, b: { at: number; seq?: number }): number {
  return b.at - a.at || (b.seq ?? 1) - (a.seq ?? 1);
}
