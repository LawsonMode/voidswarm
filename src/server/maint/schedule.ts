// OWNER: SERVER MODERATION (LAN task B5). When the maintenance jobs run (docs/LAN-EDITION-proposal.md §5.16, §6.1).
// Pure: MaintService calls dueTasks() once a minute with what it knows.
//  - daily backup: at the first quiet moment after 02:00 (nobody connected for 10 minutes), or after 24 h of uptime
//    without one even if people are playing;
//  - FTS optimize (holds the write lock ~1 s per 250k rows): only when purges left index entries behind, nobody has
//    been connected for 10 minutes, and it is overnight (22:00–06:00 local); also before the listener opens at start
//    and at Stop when the estimate is under 10 s (MaintService does those two);
//  - disk check (and the retention pass on data\backups, so the 35-day cap holds with daily backups off or skipped):
//    at start and hourly;
//  - after a daily backup was skipped (low disk) or failed, it is not tried again before `dailyRetryAt`
//    (MaintService backs off: dailyRetryDelay), instead of every minute.

export const QUIET_MS = 10 * 60_000;
export const DAILY_HOUR = 2;
export const DAILY_AFTER_UPTIME_MS = 24 * 60 * 60_000;
export const OVERNIGHT_FROM_HOUR = 22;
export const OVERNIGHT_TO_HOUR = 6;
export const STOP_OPTIMIZE_MAX_MS = 10_000;
export const DISK_EVERY_MS = 60 * 60_000;
export const TICK_MS = 60_000;

export interface ScheduleInput {
  now: number;
  /** when this server started */
  startedAt: number;
  /** settings.backups.daily */
  dailyEnabled: boolean;
  /** the newest daily or weekly backup (null: none) */
  lastDailyAt: number | null;
  /** people connected right now */
  connections: number;
  /** the last moment anyone was connected (null: nobody since start) */
  lastBusyAt: number | null;
  /** purges / deletions left index entries for an optimize */
  indexDirty: boolean;
  lastDiskAt: number | null;
  /** a skipped / failed daily backup: not before this (null: no back-off) */
  dailyRetryAt?: number | null;
}

/** The back-off after the n-th skipped or failed daily backup in a row: 1 h (the next disk check), 2 h, 4 h, … 12 h. */
export function dailyRetryDelay(n: number): number {
  const k = Math.max(1, Math.floor(n));
  return Math.min(12, 2 ** (k - 1)) * 60 * 60_000;
}

export type MaintTask = 'daily-backup' | 'optimize' | 'disk';

/** 02:00 local on the day of `now`, or of the day before when it is not 02:00 yet. */
export function dailyBoundary(now: number, hour = DAILY_HOUR): number {
  const d = new Date(now);
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).getTime();
  if (b <= now) return b;
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, hour, 0, 0, 0);
  return y.getTime();
}

export function isOvernight(now: number): boolean {
  const h = new Date(now).getHours();
  return h >= OVERNIGHT_FROM_HOUR || h < OVERNIGHT_TO_HOUR;
}

/** Nobody connected now, and nobody for the last 10 minutes (counting from the start). */
export function isQuiet(s: Pick<ScheduleInput, 'now' | 'connections' | 'lastBusyAt' | 'startedAt'>, quietMs = QUIET_MS): boolean {
  return s.connections === 0 && s.now - (s.lastBusyAt ?? s.startedAt) >= quietMs;
}

export function dailyDue(s: ScheduleInput): boolean {
  if (!s.dailyEnabled) return false;
  if (typeof s.dailyRetryAt === 'number' && s.now < s.dailyRetryAt) return false;
  const since = Math.max(s.lastDailyAt ?? -Infinity, s.startedAt);
  if (s.now - since >= DAILY_AFTER_UPTIME_MS) return true;
  if ((s.lastDailyAt ?? -Infinity) >= dailyBoundary(s.now)) return false;
  // The first quiet moment after 02:00 (the boundary moved past the last daily one).
  return isQuiet(s);
}

export function dueTasks(s: ScheduleInput): MaintTask[] {
  const out: MaintTask[] = [];
  if (s.lastDiskAt === null || s.now - s.lastDiskAt >= DISK_EVERY_MS) out.push('disk');
  if (dailyDue(s)) out.push('daily-backup');
  if (s.indexDirty && isQuiet(s) && isOvernight(s.now)) out.push('optimize');
  return out;
}
