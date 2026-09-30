// OWNER: SERVER MODERATION (LAN task B5). Backup retention, by age and then size (docs/LAN-EDITION-proposal.md §6.1):
//  - every class is capped at 35 days: start (at most 5), daily (at most 7), weekly (at most 4);
//  - pre-migration and pre-update backups at 30 days (the other "before …" safety backups are a class like any other: 35);
//  - a size cap (settings.backups.sizeCapMB, 2 GB by default) drops the oldest first; the newest 3 are exempt only
//    while they are within 35 days.
// So a host that runs once a week never keeps anything older than 35 days (T-BAK-2). Pure: backups.ts applies it.
import type { BackupClass } from './names';
import { compareNewestFirst } from './names';

export const DAY_MS = 86_400_000;

export interface RetentionPolicy {
  /** every class but pre-migration and pre-update (start, daily, weekly, manual, the other pre-* safety backups, …) */
  maxAgeDays: number;
  /** pre-migration and pre-update (§6.1) */
  preAgeDays: number;
  /** newest kept per class */
  perClass: Readonly<Record<BackupClass, number>>;
  /** total bytes; the oldest go first above it */
  sizeCapBytes: number;
  /** the newest N (of all classes) are never dropped for size while they are within maxAgeDays */
  keepNewest: number;
}

export const MB = 1024 * 1024;

export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({
  maxAgeDays: 35,
  preAgeDays: 30,
  perClass: Object.freeze({
    start: 5, daily: 7, weekly: 4,
    // Not in the spec's table (its age cap bounds it anyway): a burst of "Back up now" clicks.
    manual: 10, other: 5,
    // The "before …" safety backups are capped by age (and the size cap) only, as §6.1 says: each is the one copy of
    // the data from before its restore / purge / update, so a count cap would lose the first of a series (a host
    // trying several backups in a row would lose the data from before the FIRST restore).
    'pre-migration': Infinity, 'pre-update': Infinity, 'pre-restore': Infinity, 'pre-purge': Infinity, 'pre-cert': Infinity, 'pre-import': Infinity,
  }),
  sizeCapBytes: 2048 * MB,
  keepNewest: 3,
});

/** The policy with the host's size cap (settings.backups.sizeCapMB). */
export function retentionPolicy(sizeCapMB?: number | null): RetentionPolicy {
  if (typeof sizeCapMB !== 'number' || !Number.isFinite(sizeCapMB) || sizeCapMB <= 0) return DEFAULT_RETENTION;
  return { ...DEFAULT_RETENTION, sizeCapBytes: Math.floor(sizeCapMB * MB) };
}

export const ageCapDays = (cls: BackupClass, p: RetentionPolicy = DEFAULT_RETENTION): number =>
  cls === 'pre-migration' || cls === 'pre-update' ? p.preAgeDays : p.maxAgeDays;

export interface RetentionItem {
  name: string;
  cls: BackupClass;
  at: number;
  seq?: number;
  size: number;
}

export type RemoveWhy = 'age' | 'count' | 'size';

export interface RetentionPlan<T extends RetentionItem = RetentionItem> {
  /** newest first */
  keep: T[];
  remove: { item: T; why: RemoveWhy }[];
  /** bytes of `keep` */
  keptBytes: number;
}

/** Which backups to keep and which to delete, at `now`. */
export function planRetention<T extends RetentionItem>(items: readonly T[], now: number, p: RetentionPolicy = DEFAULT_RETENTION): RetentionPlan<T> {
  const sorted = [...items].sort(compareNewestFirst);
  const remove: { item: T; why: RemoveWhy }[] = [];
  const counts = new Map<BackupClass, number>();
  let keep: T[] = [];
  for (const it of sorted) {
    if (now - it.at > ageCapDays(it.cls, p) * DAY_MS) { remove.push({ item: it, why: 'age' }); continue; }
    const n = (counts.get(it.cls) ?? 0) + 1;
    counts.set(it.cls, n);
    if (n > (p.perClass[it.cls] ?? p.perClass.other)) { remove.push({ item: it, why: 'count' }); continue; }
    keep.push(it);
  }
  let total = keep.reduce((s, it) => s + Math.max(0, it.size), 0);
  if (total > p.sizeCapBytes) {
    const exempt = new Set(keep.slice(0, p.keepNewest).filter((it) => now - it.at <= p.maxAgeDays * DAY_MS));
    // Oldest first, skipping the exempt newest ones.
    for (let i = keep.length - 1; i >= 0 && total > p.sizeCapBytes; i--) {
      const it = keep[i]!;
      if (exempt.has(it)) continue;
      remove.push({ item: it, why: 'size' });
      total -= Math.max(0, it.size);
      keep[i] = null as unknown as T;
    }
    keep = keep.filter(Boolean);
  }
  return { keep, remove, keptBytes: total };
}

/**
 * The class a scheduled daily backup gets: 'weekly' when the newest weekly one is 7 days old or more (or there is
 * none), else 'daily' (a grandfather-father-son rotation: the weekly ones outlive the dailies).
 */
export function dailyClass(items: readonly { cls: BackupClass; at: number }[], now: number): 'daily' | 'weekly' {
  let newestWeekly = -Infinity;
  for (const it of items) if (it.cls === 'weekly' && it.at > newestWeekly) newestWeekly = it.at;
  return now - newestWeekly >= 7 * DAY_MS - 60 * 60_000 ? 'weekly' : 'daily';
}
