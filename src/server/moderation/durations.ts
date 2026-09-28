// OWNER: SERVER MODERATION. Ban / mute durations and moderation date formatting (chat commands, HTTP API, CLI).

/** Longest timed ban / mute (longer = use perm). */
export const MAX_DURATION_SEC = 365 * 86400;

const UNIT_SEC: Readonly<Record<string, number>> = {
  s: 1, sec: 1, secs: 1,
  m: 60, min: 60, mins: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 7 * 86400, wk: 7 * 86400, week: 7 * 86400, weeks: 7 * 86400,
};

const PERM = new Set(['perm', 'permanent', 'forever', 'never']);

/**
 * `10m`, `2h`, `1d`, `7d`, `2w`, `perm` (also `30s`, `90min`, or a plain number of seconds) → seconds, null = permanent;
 * undefined = not a valid duration (0, negative, over MAX_DURATION_SEC, garbage).
 */
export function parseDuration(raw: unknown): number | null | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 1 && raw <= MAX_DURATION_SEC ? Math.floor(raw) : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (PERM.has(s)) return null;
  const m = /^(\d{1,6})\s*([a-z]*)$/.exec(s);
  if (!m) return undefined;
  const unit = m[2] ? UNIT_SEC[m[2]] : 1;
  if (!unit) return undefined;
  const sec = Number(m[1]) * unit;
  return sec >= 1 && sec <= MAX_DURATION_SEC ? sec : undefined;
}

/** "10 minutes", "2 hours", "1 day", "permanently". */
export function describeDuration(sec: number | null): string {
  if (sec === null) return 'permanently';
  const plural = (v: number, u: string): string => `${v} ${u}${v === 1 ? '' : 's'}`;
  if (sec % (7 * 86400) === 0) return plural(sec / (7 * 86400), 'week');
  if (sec % 86400 === 0) return plural(sec / 86400, 'day');
  if (sec % 3600 === 0) return plural(sec / 3600, 'hour');
  if (sec % 60 === 0) return plural(sec / 60, 'minute');
  return plural(sec, 'second');
}

/** "since" for log queries: an epoch-ms number, or a duration meaning "that long before now". undefined = invalid. */
export function parseSince(raw: unknown, now: number): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
  const d = parseDuration(raw);
  return typeof d === 'number' ? now - d * 1000 : undefined;
}

/** Local "HH:MM" for chat replies. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local "YYYY-MM-DD HH:MM" for chat replies and the CLI. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
