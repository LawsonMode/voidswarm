// OWNER: SERVER MODERATION (LAN task B8a). The chat log's READ side (docs/LAN-EDITION-proposal.md §5.5, §5.11,
// §5.16, §8.3): the row shape, the log search (FTS5 trigram for text of 3+ characters, LIKE for 1-2 over at most 7
// days), the context drawer (same room_uid, with the zone-wide announcements the room saw; legacy rows: room_id ± 10
// minutes), rooms in a date range (closed ones
// too), log stats (cached 5 minutes), the conduct_daily tally, reveals and the streamed export, as maintenance-worker
// ops (QUERY_OPS, spread into MAINT_OPS by registry.ts) and as plain functions over a connection. ModStore
// (../moderation/store.ts) uses the same row mapping and search for the CLI and its game-thread point queries, and
// conductTagsOf() for the counters it writes, so the worker and the store never disagree.
//
// Paging is newest first; `before` / `nextBefore` are line ids. Date filters are exact per row.
//  - Person and tag searches (one student's, callsign's or address's lines; one tag's) page in (ts, id) order, the
//    order of their (x, ts) indexes, so a page never sorts a long history: `before` names the last line shown (its
//    ts is looked up, or the caller passes `beforeTs` = the page's `nextBeforeTs`). A callsign that is also an
//    account username reads both indexes and merges them.
//  - Text, room and whole-log searches page in log order (chat_log.id).
// In the worker (SearchOptions.maxMs > 0) every search stops on its time budget:
//  - person and tag searches scan in windows of that person's / tag's index entries;
//  - room and whole-log searches in id windows;
//  - text searches (FTS5) walk their matches in ONE stepped query, checking the clock every 256 matches (a phrase
//    query's cost is mostly loading its doclists, so windows would pay it again and again).
// Windows start small and grow while the budget allows (each predicted from the last one's rate), so no single window
// overruns. A date-bounded id-ordered scan reads the id range that holds every line of the dates (idRangeOf): the log
// is written in id order, and mod_meta.ts_disorder records how far the host clock ever jumped BACK between two lines
// (ModStore keeps it; 0 for a clock that never went back), so the range is widened by exactly that much and a line
// stamped while the clock was wrong is never missed. A search that runs out of time returns a PARTIAL page (`partial:
// true`, possibly empty) whose cursor continues it, so a search never holds the worker for long whatever the filters,
// and paging on returns exactly the exact search's rows (date filters stay exact per row).
//
// A text longer than FTS_MATCH_CHARS (12) is matched on its first 12 characters (a phrase query costs ~0.6 ms per
// character at 1M lines) and checked whole on each candidate, folded as the index folds (foldText).
//
// Text matched outside the index (a person's, room's or tag's lines, and 1-2 character texts) is folded exactly as the
// index folds too (textMatchSql: LIKE for ASCII, plus the FOLD_FN SQL function on rows with other characters), so
// "éclair" finds "ÉCLAIR" in one student's lines as it does in the whole log.
//
// A 1-2 character text (any plan: the whole log, one person's, room's or tag's lines) looks at most 7 days back from
// the search's own end (`until`, else now): §5.5 "LIKE over at most 7 days" (LogPage.shortTextSince says where it
// stopped).
//
// SELF-HARM (wellbeing) lines are left out unless `includeSelfHarm` (the worker ops default to leaving them out; the
// caller passes true only for a principal with `wellbeing`). A line counts as one when display = 'withheld', a
// chat_tags row says SELF-HARM, or (rows from before 0.6.0, which have no tags) a hit label names 'selfharm'.
// `searchIn: 'shown'` matches the shown text only (moderators, and host sessions without `reveal`, §5.5). The worker
// ops fail closed: shown text only, no originals / hit labels, no SELF-HARM lines unless the caller opts in.
//
// No FTS secure-delete (§0 fact 4, §6.6): deleted rows' index entries go at the next 'optimize' (ops.ts).
//
// FTS merges (the index's b-trees combined as the log grows) run HERE, in the worker ('fts.merge', and every
// 'wal.checkpoint' of the per-second upkeep), in small steps: with the game connection's automerge off
// (ModStore ftsMerge 'worker', GAME_THREAD_STORE_OPTIONS) a game-thread chat commit never does merge work. Measured on
// an organically grown index (250k-1M lines, no optimize): FTS5's automerge inside 1-line game commits took 20-45 ms
// (up to ~300 ms) every few dozen commits; with the merges here every second, 1-line commits stay at max ~2 ms.
import * as fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  enforcedTagsOf, TAG_PROFANITY, TAG_SELF_HARM, tagsOf, type ChatAction, type ChatDisplay, type ChatTag, type LogChannel,
} from '../../shared/room/moderation';
import { nameKey } from '../../shared/room/util';
import { dayOf, indexDirtyRows } from './erase';
import type { OpContext, OpTable, StreamOp } from './ops';
import { MaintError } from './protocol';

const DAY = 86_400_000;
const MIN = 60_000;

// ------------------------------------------------------------------------------------------
// Rows
// ------------------------------------------------------------------------------------------

export const CHAT_ACTIONS: readonly ChatAction[] = ['pass', 'flag', 'mask', 'block', 'spam', 'muted'];
export const CHAT_DISPLAYS: readonly ChatDisplay[] = ['as-typed', 'masked', 'substituted', 'system', 'hidden', 'withheld'];
export const LOG_CHANNELS: readonly LogChannel[] = ['all', 'team', 'name', 'room', 'announce'];

/** One chat_log row as the store, the worker and the admin API hand it on (§5.15 ChatLogRow). */
export interface ChatLogRow {
  id: number; ts: number;
  roomId: string | null;
  /** `<bootId>:<roomId>`, `<bootId>:zone` for the lobby; null for a zone-wide announcement and rows from before 0.6.0 */
  roomUid: string | null;
  roomName: string;
  channel: LogChannel; team: number;
  playerId: number; name: string;
  accountId: string | null; address: string | null;
  /** what they typed ('' when the caller asked without originals, and in report copies) */
  original: string;
  /** what the others saw (for a substituted line: the positive line — never the student's words) */
  shown: string;
  action: ChatAction;
  /** hit labels ([] without originals: they name the words) */
  hits: string[];
  display: ChatDisplay;
  /** one per category the line hit (§5.8), from the hit labels */
  tags: ChatTag[];
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function parseHits(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? '[]')) as unknown;
    return Array.isArray(a) ? a.map(String) : [];
  } catch { return []; }
}

export const displayOf = (v: unknown): ChatDisplay => ((CHAT_DISPLAYS as readonly unknown[]).includes(v) ? v as ChatDisplay : 'as-typed');

/** A chat_log row (SELECT *) as a ChatLogRow. */
export function chatRowOf(r: Row): ChatLogRow {
  const hits = parseHits(r.hits);
  return {
    id: num(r.id), ts: num(r.ts), roomId: strOrNull(r.room_id), roomUid: strOrNull(r.room_uid), roomName: String(r.room_name ?? ''),
    channel: String(r.channel) as LogChannel, team: num(r.team), playerId: num(r.player_id), name: String(r.name ?? ''),
    accountId: strOrNull(r.account_id), address: strOrNull(r.address), original: String(r.original ?? ''),
    shown: String(r.shown ?? ''), action: String(r.action) as ChatAction, hits, display: displayOf(r.display), tags: tagsOf(hits),
  };
}

/** The row without what they typed: original '' and no hit labels (the tags stay). */
export const withoutOriginal = (r: ChatLogRow): ChatLogRow => ({ ...r, original: '', hits: [] });

/** A self-harm (wellbeing) line, by the same rules as the SQL (display, tags, legacy hit labels). */
export function isWellbeingRow(r: Pick<ChatLogRow, 'display' | 'tags' | 'hits'>): boolean {
  return r.display === 'withheld' || r.tags.includes(TAG_SELF_HARM) || tagsOf(r.hits).includes(TAG_SELF_HARM);
}

// ------------------------------------------------------------------------------------------
// Tags and conduct counters (written by ModStore.flush; the worker and rebuilds read the same rules)
// ------------------------------------------------------------------------------------------

/** conduct_daily.tag of a review-only (unconfirmed / flag-tier) hit: "review:GANG" (§5.8 "for review", never ranked). */
export const CONDUCT_REVIEW_PREFIX = 'review:';

/** conduct_daily.account_key: the account id, or 'g:<name key>' for a guest (§6.6; erase.ts uses the same). */
export const conductKeyOf = (accountId: string | null | undefined, name: string): string => (accountId ? accountId : `g:${nameKey(String(name ?? ''))}`);

/**
 * The conduct_daily tags one logged entry adds to (each once per line):
 *  - the enforced (block / mask tier) tags of its hits, and `review:<TAG>` for tags only review-only hits carry;
 *  - NOTHING for a wellbeing line, an enforced SELF-HARM hit or `display` 'withheld' (a muted / flood line or a name
 *    read as a self-harm statement too), not even for the other words in it: wellbeing is never an offence and never
 *    counted (§5.11), and the Zone gives such a line no strike ("never punished, not even for other words in the
 *    line", Zone.chatVerdict / nameRefused). chat_tags still keeps all of its tags: they are filters, and SELF-HARM
 *    lines are left out of every read unless the caller has `wellbeing`;
 *  - never SELF-HARM itself (a review-only self-harm hit on a line shown as typed), never a host announcement;
 *  - for a callsign or room name ('name' / 'room'), not PROFANITY: a name refused only for profanity is not an
 *    offence (real names collide with the list; Zone.nameRefused gives no strike for it either).
 */
export function conductTagsOf(e: { channel: string; hits: readonly unknown[]; display?: unknown }): string[] {
  if (e.channel === 'announce' || !Array.isArray(e.hits) || !e.hits.length) return [];
  if (e.display === 'withheld') return [];
  const hits = e.hits as unknown[];
  const enforced = enforcedTagsOf(hits);
  if (enforced.includes(TAG_SELF_HARM)) return [];
  const name = e.channel === 'name' || e.channel === 'room';
  const counted = (t: ChatTag): boolean => t !== TAG_SELF_HARM && !(name && t === TAG_PROFANITY);
  const review = tagsOf(hits).filter((t) => !enforced.includes(t) && counted(t)).map((t) => `${CONDUCT_REVIEW_PREFIX}${t}`);
  return [...enforced.filter(counted), ...review];
}

// ------------------------------------------------------------------------------------------
// The log search
// ------------------------------------------------------------------------------------------

/** One time range (epoch ms, both ends inclusive): a class period on one day, say. */
export interface TimeRange { since: number; until: number }

export interface LogQuery {
  /** callsign (name key) or account username */
  player?: string;
  accountId?: string;
  address?: string;
  /** text: a case-insensitive substring (FTS5 trigram for 3+ characters, LIKE for 1-2); `grep` is the older name */
  q?: string;
  grep?: string;
  /** 'shown': match the shown text only (moderators; hosts without `reveal`). Default 'both'. */
  searchIn?: 'both' | 'shown';
  /** one action; 'flagged' = the lines the filter acted on (not 'pass' / 'flag'); 'flag' = lines for review */
  action?: ChatAction | 'flagged';
  /** what the others saw (§5.8): one value or a list */
  display?: ChatDisplay | readonly ChatDisplay[];
  /** a tag (chat_tags; rows from before 0.6.0 have none) */
  tag?: string;
  /** a log channel, or 'lobby' (zone lobby chat: no room) */
  channel?: LogChannel | 'lobby';
  /** legacy room filter (room ids restart at r1 every boot: prefer roomUid) */
  roomId?: string;
  roomUid?: string;
  since?: number;
  until?: number;
  /** several time ranges (class periods): a line must fall in one of them (and inside since / until) */
  ranges?: readonly TimeRange[];
  /** keep SELF-HARM lines (a principal with `wellbeing`). ModStore default true; the worker ops default false. */
  includeSelfHarm?: boolean;
  limit?: number;
  /**
   * paging cursor: the lines after this one, newest first (log order: id < before; person / tag searches: (ts, id)
   * below this line's)
   */
  before?: number;
  /** person / tag searches: the ts of the `before` line (LogPage.nextBeforeTs), so the cursor needs no lookup */
  beforeTs?: number;
}

export type LogPlan = 'person' | 'room' | 'tag' | 'fts' | 'scan';

export interface LogPage {
  lines: ChatLogRow[];
  /** continue with `before: nextBefore`; null = nothing more */
  nextBefore: number | null;
  /** person / tag searches: the ts that goes with nextBefore (pass it back as `beforeTs`); null otherwise */
  nextBeforeTs: number | null;
  /** the scan stopped on its time budget before the page filled (the worker only): `nextBefore` continues it */
  partial: boolean;
  plan: LogPlan;
  /**
   * a 1-2 character search looks back only to here (whatever else it filters on): 7 days before its end (`until`,
   * else now; §5.5 "LIKE over at most 7 days"), so an older range can still be searched a week at a time
   */
  shortTextSince: number | null;
}

export interface SearchOptions {
  /**
   * The worker's budget: > 0 = scan in windows and stop after about this many ms with a partial page (every plan).
   * 0 (default) = exact and unbounded (ModStore: the CLI, the older API).
   */
  maxMs?: number;
  /**
   * A fixed window (tests): ids per window for room / whole-log searches, index entries per window for person and tag
   * searches, matches per clock check for text searches. Default: adaptive (small first, grown while the budget allows).
   */
  windowIds?: number;
  /** Stop with a partial page after this many windows (tests: deterministic partial pages). */
  maxWindows?: number;
  now?: number;
  /** without originals: original '' and no hit labels */
  withOriginal?: boolean;
  /** the default of LogQuery.includeSelfHarm (ModStore true, the worker false) */
  includeSelfHarmDefault?: boolean;
}

/** Text shorter than this uses LIKE (the trigram index needs 3 characters). */
export const FTS_MIN_CHARS = 3;
/** A 1-2 character search looks back this far from its end (`until`, else now). */
export const SHORT_TEXT_WINDOW_MS = 7 * DAY;
export const LOG_MAX_LIMIT = 1000;
/** The worker's default budget for one log call (T-ADM-7: a search returns within 50 ms at 1M rows). */
export const WORKER_SEARCH_MAX_MS = 35;
/**
 * Adaptive windows (the worker): the first window is small (a costly filter over a dense range must not overrun the
 * budget before the first check), each next one doubles while its time — predicted from the last window's rate —
 * fits in LOOKAHEAD of the budget left; below the minimum the search stops with a partial page.
 */
const ID_WINDOW_FIRST = 2048;
const ID_WINDOW_MIN = 256;
const ID_WINDOW_MAX = 1 << 20;
const KEY_WINDOW_FIRST = 512;
const KEY_WINDOW_MIN = 64;
const KEY_WINDOW_MAX = 1 << 17;
const LOOKAHEAD = 0.6;
const MAX_TEXT = 100;
const MAX_RANGES = 400;

/** LIKE pattern for a case-insensitive substring (escape char '\'). */
export const likeOf = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** An FTS5 phrase: the text as one quoted string (a trigram phrase = a substring), optionally on one column. */
export function ftsPhrase(text: string, column?: 'shown' | 'original'): string {
  const phrase = `"${String(text).replace(/"/g, '""')}"`;
  return column ? `${column} : ${phrase}` : phrase;
}

const clampLimit = (v: unknown, dflt: number, max: number): number => {
  const x = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(1, Math.min(max, x));
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Control characters (C0, DEL) never reach the SQL: a NUL ends an FTS5 string ("unterminated string"). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const cleanText = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL_CHARS, '');
  return s.trim() ? s : null;
};

/** The text a query searches for (null = none): `q`, else `grep`, without control characters, at most 100 characters. */
export function textOf(q: Pick<LogQuery, 'q' | 'grep'>): string | null {
  const t = cleanText(q.q) ?? cleanText(q.grep);
  return t === null ? null : [...t].slice(0, MAX_TEXT).join('');
}

const charLen = (s: string): number => [...s].length;

/** Which index a query is driven by: a person's lines, a room's, a tag's, the text index, or the whole log. */
export function planOf(q: LogQuery, text: string | null = textOf(q)): LogPlan {
  if (q.player || q.accountId || q.address) return 'person';
  if (q.roomUid) return 'room';
  if (q.tag) return 'tag';
  if (text !== null && charLen(text) >= FTS_MIN_CHARS) return 'fts';
  return 'scan';
}

/** Account id of a username (case-insensitive; look-alike letters folded), or null. */
export function accountIdByUsername(db: DatabaseSync, name: string): string | null {
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw || raw.length > 64) return null;
  const st = db.prepare('SELECT id FROM accounts WHERE username_lower = ?');
  let r = st.get(raw) as Row | undefined;
  if (!r) {
    const key = nameKey(raw);
    if (key !== raw) r = st.get(key) as Row | undefined;
  }
  return r ? String(r.id) : null;
}

/** SQL: the row `c` is a SELF-HARM line (see the file header). */
export const SELF_HARM_SQL = `(c.display = 'withheld' OR c.hits LIKE '%"selfharm:%' OR c.hits LIKE '%:selfharm:%'
  OR EXISTS (SELECT 1 FROM chat_tags sh WHERE sh.chat_id = c.id AND sh.tag = '${TAG_SELF_HARM}'))`;

interface Filter { sql: string[]; args: SQLInputValue[] }

function validRanges(q: LogQuery): TimeRange[] | null {
  if (!Array.isArray(q.ranges)) return null;
  return q.ranges.slice(0, MAX_RANGES).filter((r) => r && finite(r.since) && finite(r.until) && r.until >= r.since)
    .map((r) => ({ since: Math.floor(r.since), until: Math.floor(r.until) }));
}

/** since / until tightened by the ranges (a range list narrows the scan too). */
function timeBounds(q: LogQuery, ranges: TimeRange[] | null): { since: number | null; until: number | null } {
  let since = finite(q.since) ? Math.floor(q.since) : null;
  let until = finite(q.until) ? Math.floor(q.until) : null;
  if (ranges && ranges.length) {
    const lo = Math.min(...ranges.map((r) => r.since));
    const hi = Math.max(...ranges.map((r) => r.until));
    since = since === null ? lo : Math.max(since, lo);
    until = until === null ? hi : Math.min(until, hi);
  }
  return { since, until };
}

/**
 * The 7-day floor of a 1-2 character search, on every plan (null for any other search): SHORT_TEXT_WINDOW_MS
 * before the search's own end (its `until`, or its ranges' last end, capped at now), so an older class period can
 * be searched too.
 */
function shortSinceOf(q: LogQuery, text: string | null, now: number): number | null {
  if (text === null || charLen(text) >= FTS_MIN_CHARS) return null;
  const { until } = timeBounds(q, validRanges(q));
  return (until === null ? now : Math.min(until, now)) - SHORT_TEXT_WINDOW_MS;
}

/** The search's lowest ts: `since` (tightened by the ranges) or the short-text floor, whichever is later; null = open. */
function lowerBoundOf(q: LogQuery, shortSince: number | null): number | null {
  const { since } = timeBounds(q, validRanges(q));
  if (since === null) return shortSince;
  return shortSince === null ? since : Math.max(since, shortSince);
}

/**
 * The WHERE conditions of a log query on `chat_log c` (and `chat_fts f` for the fts plan), without the id cursor /
 * window. `shortSince` = the 7-day floor of a short text search (shortSinceOf).
 */
function filterOf(db: DatabaseSync, q: LogQuery, plan: LogPlan, text: string | null, includeSelfHarm: boolean, shortSince: number | null,
  tsIndex = plan === 'person'): Filter {
  const sql: string[] = [];
  const args: SQLInputValue[] = [];
  // A ts range may use a ts index on the person plan (its indexes are (x, ts)) and on an exact one-page whole-log
  // search (the ts index, then a sort); elsewhere the id order drives (windows, rooms, tags, FTS, streamed pages).
  const ts = tsIndex ? 'c.ts' : '+c.ts';
  if (q.player) {
    const key = nameKey(q.player);
    const acc = accountIdByUsername(db, q.player);
    if (acc) { sql.push('(c.name_key = ? OR c.account_id = ?)'); args.push(key, acc); }
    else { sql.push('c.name_key = ?'); args.push(key); }
  }
  if (q.accountId) { sql.push('c.account_id = ?'); args.push(String(q.accountId)); }
  if (q.address) { sql.push('c.address = ?'); args.push(String(q.address)); }
  if (q.roomUid) { sql.push('c.room_uid = ?'); args.push(String(q.roomUid)); }
  if (q.roomId) { sql.push('c.room_id = ?'); args.push(String(q.roomId)); }
  if (q.channel === 'lobby') sql.push("(c.room_id IS NULL AND c.channel IN ('all', 'team'))");
  else if (q.channel) { sql.push('c.channel = ?'); args.push(String(q.channel)); }
  if (q.action === 'flagged') sql.push("c.action NOT IN ('pass', 'flag')");
  else if (q.action === 'flag') sql.push(`(c.action = 'flag' OR c.hits LIKE '%"flag:%')`);
  else if (q.action) { sql.push('c.action = ?'); args.push(String(q.action)); }
  if (q.display !== undefined) {
    const list = (Array.isArray(q.display) ? q.display : [q.display]).filter((d) => (CHAT_DISPLAYS as readonly unknown[]).includes(d)).slice(0, 6);
    if (list.length) { sql.push(`c.display IN (${list.map(() => '?').join(', ')})`); args.push(...list); }
    else sql.push('0');
  }
  const ranges = validRanges(q);
  const { since, until } = timeBounds(q, null);
  // The tag plan is driven by chat_tags itself (keySidesOf joins it); elsewhere a tag is a per-row filter.
  if (q.tag && plan !== 'tag') {
    sql.push('EXISTS (SELECT 1 FROM chat_tags tg WHERE tg.chat_id = c.id AND tg.tag = ?)');
    args.push(String(q.tag));
  }
  if (since !== null) { sql.push(`${ts} >= ?`); args.push(since); }
  if (until !== null) { sql.push(`${ts} <= ?`); args.push(until); }
  if (shortSince !== null) { sql.push(`${ts} >= ?`); args.push(shortSince); }
  if (ranges) {
    if (!ranges.length) sql.push('0');
    else {
      sql.push(`(${ranges.map(() => `(${ts} >= ? AND ${ts} <= ?)`).join(' OR ')})`);
      for (const r of ranges) args.push(r.since, r.until);
    }
  }
  if (!includeSelfHarm) sql.push(`NOT ${SELF_HARM_SQL}`);
  if (text !== null && plan !== 'fts') {
    // folded as the index folds (textMatchSql), so a person / room / tag / short search finds what the FTS plan finds
    if (q.searchIn === 'shown') sql.push(textMatchSql(db, 'c.shown', text, args));
    else sql.push(`(${textMatchSql(db, 'c.original', text, args)} OR ${textMatchSql(db, 'c.shown', text, args)})`);
  }
  return { sql, args };
}

const scalar = (db: DatabaseSync, sql: string, ...args: SQLInputValue[]): number | null => {
  const r = db.prepare(sql).get(...args) as Row | undefined;
  if (!r) return null;
  const v = Object.values(r)[0];
  return v === null || v === undefined ? null : num(v);
};

/** The id of the last line at or before `until` (the log is in time order), or null. */
export const lastIdAtOrBefore = (db: DatabaseSync, until: number): number | null =>
  scalar(db, 'SELECT id FROM chat_log WHERE ts <= ? ORDER BY ts DESC, id DESC LIMIT 1', Math.floor(until));
/** The id of the first line at or after `since`, or null. */
export const firstIdAtOrAfter = (db: DatabaseSync, since: number): number | null =>
  scalar(db, 'SELECT id FROM chat_log WHERE ts >= ? ORDER BY ts ASC, id ASC LIMIT 1', Math.floor(since));

// ------------------------------------------------------------------------------------------
// Clock disorder: the log is in id (write) order, and its ts in time order only while the host clock never went back
// ------------------------------------------------------------------------------------------

/**
 * mod_meta key: how far the host clock ever jumped BACK between two logged lines, in ms (the largest ts_i − ts_j over
 * lines i written before j; 0 when it never did). ModStore measures it when a database has none (measureTsDisorder)
 * and raises it in the same transaction as a line stamped before an earlier one. Deleting lines never raises it (a
 * value higher than the lines left need only widens a date search's id range a little).
 */
export const TS_DISORDER_KEY = 'ts_disorder';

/** mod_meta.ts_disorder (ms, ≥ 0), or null when this database was never measured. */
export function tsDisorderOf(db: DatabaseSync): number | null {
  try {
    const v = scalar(db, 'SELECT v FROM mod_meta WHERE k = ?', TS_DISORDER_KEY);
    return v === null ? null : Math.max(0, v);
  } catch {
    return null;
  }
}

/** The log's clock disorder, measured: one pass in id order (~0.35 s at 1M lines). */
export function measureTsDisorder(db: DatabaseSync): number {
  const d = scalar(db, `SELECT max(m - ts) FROM (SELECT ts, max(ts) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS m
                          FROM chat_log)`);
  return Math.max(0, d ?? 0);
}

/**
 * The id range [lo, hi) that holds every line with since ≤ ts ≤ until (either end null = open), or null when no line
 * can match. With D = the clock disorder: a line M with ts > until + D was written after every line with ts ≤ until
 * (any later line has ts ≥ ts_M − D > until), so hi = the id of the first such line in ts order; likewise lo = 1 + the
 * id of the last line with ts < since − D. D = 0 gives the plain time-order bounds; an unmeasured database (no
 * mod_meta.ts_disorder) takes the whole log. Rows inside the range are still checked per row, so a caller's result is
 * exact either way.
 */
export function idRangeOf(db: DatabaseSync, since: number | null, until: number | null): { lo: number; hi: number } | null {
  const maxId = scalar(db, 'SELECT max(id) FROM chat_log');
  const minId = scalar(db, 'SELECT min(id) FROM chat_log');
  if (maxId === null || minId === null) return null;
  if (until !== null && scalar(db, 'SELECT 1 FROM chat_log WHERE ts <= ? LIMIT 1', Math.floor(until)) === null) return null;
  if (since !== null && scalar(db, 'SELECT 1 FROM chat_log WHERE ts >= ? LIMIT 1', Math.floor(since)) === null) return null;
  const d = tsDisorderOf(db);
  if (d === null) return { lo: minId, hi: maxId + 1 };
  let hi = maxId + 1;
  let lo = minId;
  if (until !== null) {
    const m = scalar(db, 'SELECT id FROM chat_log WHERE ts > ? ORDER BY ts ASC, id ASC LIMIT 1', Math.floor(until) + d);
    if (m !== null) hi = m;
  }
  if (since !== null) {
    const m = scalar(db, 'SELECT id FROM chat_log WHERE ts < ? ORDER BY ts DESC, id DESC LIMIT 1', Math.floor(since) - d);
    if (m !== null) lo = m + 1;
  }
  return { lo, hi };
}

interface Runner {
  /** rows with lo <= id < hi (either end null = open), newest first (or oldest first), at most `limit` */
  run(hi: number | null, lo: number | null, limit: number, order?: 'desc' | 'asc', after?: number | null): Row[];
}

/** Text, room and whole-log searches: log (id) order. */
function runnerOf(db: DatabaseSync, q: LogQuery, plan: LogPlan, text: string | null, f: Filter): Runner {
  const idCol = plan === 'fts' ? 'f.rowid' : 'c.id';
  const head = plan === 'fts'
    ? 'SELECT c.* FROM chat_fts f JOIN chat_log c ON c.id = f.rowid WHERE f.chat_fts MATCH ?'
    : 'SELECT c.* FROM chat_log c WHERE 1';
  const headArgs: SQLInputValue[] = plan === 'fts' && text !== null ? [ftsPhrase(text, q.searchIn === 'shown' ? 'shown' : undefined)] : [];
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  return {
    run(hi, lo, limit, order = 'desc', after = null) {
      const conds = [...f.sql];
      const args: SQLInputValue[] = [...headArgs, ...f.args];
      if (hi !== null) { conds.push(`${idCol} < ?`); args.push(hi); }
      if (lo !== null) { conds.push(`${idCol} >= ?`); args.push(lo); }
      if (after !== null) { conds.push(`${idCol} > ?`); args.push(after); }
      const sql = `${head}${conds.map((s) => ` AND ${s}`).join('')} ORDER BY ${idCol} ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`;
      let st = cache.get(sql);
      if (!st) { st = db.prepare(sql); cache.set(sql, st); }
      return st.all(...args, limit) as Row[];
    },
  };
}

// ------------------------------------------------------------------------------------------
// Person and tag searches: (ts, id) keysets in their (x, ts) indexes' own order
// ------------------------------------------------------------------------------------------

/** A position in a person's or a tag's lines: (ts, id), their index order. */
type Key = readonly [ts: number, id: number];
const KEY_TOP = Number.MAX_SAFE_INTEGER;
const KEY_BOTTOM = Number.MIN_SAFE_INTEGER;
const keyCmp = (a: Key, b: Key): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
/** Every keyset query selects its index's (ts, id) as k_ts / k_id (for a tag: chat_tags' own copy of the ts). */
const keyOfRow = (r: Row): Key => [num(r.k_ts), num(r.k_id)];

/** One index a person / tag search reads. */
interface KeySide {
  /** the k-th entry (k ≥ 1) below `cur`, newest first, with ts ≥ floorTs; null = fewer remain */
  kth(cur: Key, floorTs: number, k: number): Key | null;
  /** matching rows with end ≤ (ts, id) < cur, newest first, at most `limit` */
  down(cur: Key, end: Key, limit: number): Row[];
  /** matching rows with cur < (ts, id) ≤ end, oldest first, at most `limit` */
  up(cur: Key, end: Key, limit: number): Row[];
}

type Stmt = ReturnType<DatabaseSync['prepare']>;

/**
 * The indexes a person / tag search reads, each forced (INDEXED BY) so the planner never trades it for the ts index:
 * an account's lines (chat_log_account), a callsign's (chat_log_name; plus the account's when the callsign is also an
 * account username: the two are merged), an address's (chat_log_address), or a tag's (chat_tags_tag, joined to the
 * line by its id). The other filters apply per row.
 */
function keySidesOf(db: DatabaseSync, q: LogQuery, plan: LogPlan, f: Filter): KeySide[] {
  const specs: { from: string; eq: string; val: string; ts: string; id: string; kth: string }[] = [];
  const onLog = (idx: string, col: string, val: string): void => {
    specs.push({
      from: `chat_log c INDEXED BY ${idx}`, eq: `c.${col} = ?`, val, ts: 'c.ts', id: 'c.id',
      kth: `SELECT ts, id FROM chat_log INDEXED BY ${idx} WHERE ${col} = ? AND (ts, id) < (?, ?) AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?`,
    });
  };
  if (plan === 'tag') {
    specs.push({
      from: 'chat_tags t INDEXED BY chat_tags_tag CROSS JOIN chat_log c ON c.id = t.chat_id', eq: 't.tag = ?', val: String(q.tag), ts: 't.ts', id: 't.chat_id',
      kth: 'SELECT ts, chat_id AS id FROM chat_tags INDEXED BY chat_tags_tag WHERE tag = ? AND (ts, chat_id) < (?, ?) AND ts >= ? ORDER BY ts DESC, chat_id DESC LIMIT 1 OFFSET ?',
    });
  } else if (q.accountId) onLog('chat_log_account', 'account_id', String(q.accountId));
  else if (q.player) {
    onLog('chat_log_name', 'name_key', nameKey(q.player));
    const acc = accountIdByUsername(db, q.player);
    if (acc) onLog('chat_log_account', 'account_id', acc);
  } else onLog('chat_log_address', 'address', String(q.address));
  const where = f.sql.map((s) => ` AND ${s}`).join('');
  const lazy = (sql: string): (() => Stmt) => {
    let st: Stmt | null = null;
    return () => (st ??= db.prepare(sql));
  };
  return specs.map((s): KeySide => {
    const kth = lazy(s.kth);
    const sel = `SELECT c.*, ${s.ts} AS k_ts, ${s.id} AS k_id FROM ${s.from} WHERE ${s.eq}`;
    const down = lazy(`${sel} AND (${s.ts}, ${s.id}) < (?, ?) AND (${s.ts}, ${s.id}) >= (?, ?)${where} ORDER BY ${s.ts} DESC, ${s.id} DESC LIMIT ?`);
    const up = lazy(`${sel} AND (${s.ts}, ${s.id}) > (?, ?) AND (${s.ts}, ${s.id}) <= (?, ?)${where} ORDER BY ${s.ts} ASC, ${s.id} ASC LIMIT ?`);
    return {
      kth(cur, floorTs, k) {
        const r = kth().get(s.val, cur[0], cur[1], floorTs, Math.max(0, Math.floor(k) - 1)) as Row | undefined;
        return r ? [num(r.ts), num(r.id)] : null;
      },
      down: (cur, end, limit) => down().all(s.val, cur[0], cur[1], end[0], end[1], ...f.args, limit) as Row[],
      up: (cur, end, limit) => up().all(s.val, cur[0], cur[1], end[0], end[1], ...f.args, limit) as Row[],
    };
  });
}

/** The sides' rows as one list in key order (newest first: dir -1), without duplicates, at most `limit`. */
function mergeKeyed(lists: Row[][], limit: number, dir: 1 | -1): Row[] {
  if (lists.length === 1) return lists[0]!.slice(0, limit);
  const seen = new Set<number>();
  const all: Row[] = [];
  for (const list of lists) {
    for (const r of list) {
      const id = num(r.id);
      if (!seen.has(id)) { seen.add(id); all.push(r); }
    }
  }
  all.sort((a, b) => dir * keyCmp(keyOfRow(a), keyOfRow(b)));
  return all.slice(0, limit);
}

/** The key of the `before` line: `beforeTs` when given, else its ts (a tag's own copy), else the nearest older line's. */
function beforeKeyOf(db: DatabaseSync, q: LogQuery, plan: LogPlan): Key | null {
  const id = Math.floor(q.before!);
  if (finite(q.beforeTs)) return [Math.floor(q.beforeTs), id];
  const ts = (plan === 'tag' ? scalar(db, 'SELECT ts FROM chat_tags WHERE chat_id = ? AND tag = ?', id, String(q.tag)) : null)
    ?? scalar(db, 'SELECT ts FROM chat_log WHERE id = ?', id)
    // the line went (a purge between two calls): continue from the nearest older line's time
    ?? scalar(db, 'SELECT ts FROM chat_log WHERE id < ? ORDER BY id DESC LIMIT 1', id);
  return ts === null ? null : [ts, id];
}

/** The next window: double, or shrink so its predicted time fits LOOKAHEAD of the budget left; 0 = stop. */
function nextWindow(size: number, msPerUnit: number, leftMs: number, min: number, max: number): number {
  let n = Math.min(max, size * 2);
  if (msPerUnit > 0 && msPerUnit * n > leftMs * LOOKAHEAD) n = Math.floor((leftMs * LOOKAHEAD) / msPerUnit);
  return n >= min ? n : 0;
}

interface KeyPage { rows: Row[]; next: Key | null; partial: boolean }

/**
 * A partial page's cursor must never be a line the caller may not see (a SELF-HARM line without includeSelfHarm):
 * comparing cursors with the visible ids would tell a moderator that a named student wrote a hidden line, and when.
 * This many hidden entries at most are stepped past (they are rare); beyond it the page ends without a cursor.
 */
const HIDDEN_CURSOR_STEPS = 10_000;

/** A person / tag page: exact (one keyset query per side), or windowed on the worker's budget. */
function keysetPage(db: DatabaseSync, q: LogQuery, plan: LogPlan, f: Filter, limit: number, opts: SearchOptions, shortSince: number | null,
  hidden: ((id: number) => boolean) | null = null): KeyPage {
  const sides = keySidesOf(db, q, plan, f);
  const { until } = timeBounds(q, validRanges(q));
  const since = lowerBoundOf(q, shortSince);
  let cur: Key = [until ?? KEY_TOP, KEY_TOP];
  if (finite(q.before)) {
    const b = beforeKeyOf(db, q, plan);
    if (!b) return { rows: [], next: null, partial: false };
    if (keyCmp(b, cur) < 0) cur = b;
  }
  const floor: Key = [since ?? KEY_BOTTOM, KEY_BOTTOM];
  const out: Row[] = [];
  if (keyCmp(cur, floor) <= 0) return { rows: out, next: null, partial: false };
  const take = (end: Key): boolean => {
    const need = limit + 1 - out.length;
    out.push(...mergeKeyed(sides.map((s) => s.down(cur, end, need)), need, -1));
    if (out.length <= limit) return false;
    out.length = limit;
    return true;
  };
  const full = (): KeyPage => ({ rows: out, next: keyOfRow(out[limit - 1]!), partial: false });
  /**
   * A partial page's cursor (the page covers every entry down to it, inclusive). When it is a hidden entry, the page
   * reaches one entry further down (collecting what matches there) until the cursor is one the caller may see.
   */
  const partialAt = (): KeyPage => {
    for (let i = 0; hidden?.(cur[1]); i++) {
      if (i >= HIDDEN_CURSOR_STEPS) return { rows: out, next: null, partial: false };
      let low: Key | null = null;
      for (const s of sides) {
        const b = s.kth(cur, floor[0], 1);
        if (b && (!low || keyCmp(b, low) > 0)) low = b;
      }
      if (take(low ?? floor)) return full();
      if (!low) return { rows: out, next: null, partial: false };
      cur = low;
    }
    return { rows: out, next: cur, partial: true };
  };
  if (!((opts.maxMs ?? 0) > 0)) return take(floor) ? full() : { rows: out, next: null, partial: false };
  // Windowed: each window reaches the k-th entry of every side below the cursor (the highest of those), so every
  // side contributes at most k index entries; the last window reaches the floor.
  const fixed = finite(opts.windowIds) ? Math.max(1, Math.floor(opts.windowIds)) : null;
  let k = fixed ?? KEY_WINDOW_FIRST;
  const t0 = performance.now();
  for (let w = 1; ; w++) {
    const w0 = performance.now();
    let low: Key | null = null;
    for (const s of sides) {
      const b = s.kth(cur, floor[0], k);
      if (b && (!low || keyCmp(b, low) > 0)) low = b;
    }
    if (take(low ?? floor)) return full();
    if (!low) return { rows: out, next: null, partial: false };
    cur = low;
    const now = performance.now();
    const left = opts.maxMs! - (now - t0);
    if (left <= 0 || (opts.maxWindows !== undefined && w >= opts.maxWindows)) return partialAt();
    if (fixed === null) {
      k = nextWindow(k, (now - w0) / k, left, KEY_WINDOW_MIN, KEY_WINDOW_MAX);
      if (!k) return partialAt();
    }
  }
}

// ------------------------------------------------------------------------------------------
// Text searches in the worker: one stepped FTS query per call
// ------------------------------------------------------------------------------------------

/** A text search in the worker checks its time budget after this many FTS matches. */
const FTS_CHECK_EVERY = 256;
/**
 * A phrase query costs about 0.6 ms per character at 1M rows of common words (measured: 12 characters 5-9 ms, 100
 * characters 53-64 ms; FTS5 loads each trigram's whole doclist, whatever the rowid range). A longer text is matched on
 * its first FTS_MATCH_CHARS characters, and every candidate is checked for the whole text (foldText, below).
 */
export const FTS_MATCH_CHARS = 12;

const NON_ASCII = /[^\u0000-\u007f]/;
/** A private in-memory trigram index whose vocabulary says how FTS5 folds one code point (null = FTS5 unavailable). */
let foldProbe: { put: Stmt; term: Stmt; clear: Stmt } | null | undefined;
const foldCache = new Map<number, string>();
const FOLD_CACHE_MAX = 65_536;

/**
 * FTS5's own case folding of one non-ASCII character (its trigram tokenizer, case_sensitive 0: Unicode simple case
 * folding from SQLite's tables, which differ from JavaScript's toLowerCase for ~460 code points: µ → μ, ſ → s, ς → σ;
 * Cherokee and a few newer capitals not folded at all). Asked once per code point of the bundled SQLite (a 3-character
 * row on a private index, ~15 µs) and cached.
 */
function ftsFoldChar(ch: string): string {
  const cp = ch.codePointAt(0)!;
  const hit = foldCache.get(cp);
  if (hit !== undefined) return hit;
  let out = ch.toLowerCase();
  if (out.length !== ch.length) out = String.fromCodePoint(out.codePointAt(0)!);
  if (foldProbe === undefined) {
    try {
      const mem = new DatabaseSync(':memory:');
      mem.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram', detail='none'); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')");
      foldProbe = { put: mem.prepare('INSERT INTO t(rowid, x) VALUES (1, ?)'), term: mem.prepare('SELECT term FROM v LIMIT 1'), clear: mem.prepare('DELETE FROM t') };
    } catch {
      foldProbe = null;
    }
  }
  if (foldProbe) {
    try {
      foldProbe.put.run(ch + ch + ch);
      const term = (foldProbe.term.get() as Row | undefined)?.term;
      const first = typeof term === 'string' ? [...term][0] : undefined;
      if (first) out = first;
    } catch { /* keep JavaScript's lowercase */ } finally {
      try { foldProbe.clear.run(); } catch { /* next call */ }
    }
  }
  if (foldCache.size < FOLD_CACHE_MAX) foldCache.set(cp, out);
  return out;
}

/**
 * Case folding exactly as the trigram index folds (FTS5, case_sensitive 0): ASCII to lowercase, every other code point
 * as FTS5 folds it (ftsFoldChar). Every text match outside the index uses it — the whole-text check of a long search on
 * its candidates, and the per-row text filter of person, room, tag and 1-2 character searches (FOLD_FN) — so a search
 * finds the same lines whichever plan runs it.
 */
export function foldText(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  let out = '';
  for (const ch of s) out += ch.charCodeAt(0) < 0x80 ? ch.toLowerCase() : ftsFoldChar(ch);
  return out;
}

/**
 * The SQL function foldText registers on a connection that runs a text filter (directOnly: never callable from a
 * view, a trigger or any other part of a database's own schema, whatever that schema says; deterministic).
 */
export const FOLD_FN = 'vs_fold';
const foldReady = new WeakSet<DatabaseSync>();
function ensureFoldFn(db: DatabaseSync): void {
  if (foldReady.has(db)) return;
  db.function(FOLD_FN, { deterministic: true, directOnly: true }, (v) => (typeof v === 'string' ? foldText(v) : v));
  foldReady.add(db);
}

/**
 * SQL: column `col` holds `text` as the index would match it (a case-insensitive substring, folded like foldText).
 * An ASCII pattern: SQLite's LIKE (it folds ASCII only) for every row, and foldText (FOLD_FN) on the rows with other
 * characters only (length ≠ octet_length), where a non-ASCII letter may fold onto the pattern. A pattern with other
 * characters can only be in such a row. Pushes its arguments to `args` in order.
 */
function textMatchSql(db: DatabaseSync, col: string, text: string, args: SQLInputValue[]): string {
  ensureFoldFn(db);
  const folded = foldText(text);
  const other = `(length(${col}) <> octet_length(${col}) AND instr(${FOLD_FN}(${col}), ?) > 0)`;
  if (NON_ASCII.test(folded)) { args.push(folded); return other; }
  args.push(likeOf(folded), folded);
  return `(${col} LIKE ? ESCAPE '\\' OR ${other})`;
}

/**
 * A text search on the worker's budget. An FTS5 phrase query costs mostly the loading of its trigrams' doclists
 * (measured at 1M rows: ~11 ms for "the the the" whatever the rowid range), so id windows would pay that once per
 * window. Instead ONE query walks the matches newest first with the other filters evaluated per match (`ok`), and
 * the loop stops once the page fills, the matches end, or the budget is spent (checked every `group` matches): the
 * cursor is then the last match looked at. The page's rows are read before the statement is reset (one snapshot).
 */
function ftsStepped(db: DatabaseSync, q: LogQuery, text: string, f: Filter,
  a: { hi: number; floor: number; limit: number; maxMs: number; t0: number; group: number; maxGroups?: number; hideSelfHarm?: boolean },
  done: (rows: Row[], nextBefore: number | null, partial: boolean) => LogPage): LogPage {
  const ok = f.sql.length ? f.sql.join(' AND ') : '1';
  const cps = [...text];
  const shownOnly = q.searchIn === 'shown';
  // A long text: match its first characters, check the whole text on each candidate (both as the index folds them).
  const whole = cps.length > FTS_MATCH_CHARS ? foldText(text) : null;
  const probe = whole === null ? text : cps.slice(0, FTS_MATCH_CHARS).join('');
  const cols = (whole === null ? '' : shownOnly ? ', c.shown AS s' : ', c.original AS o, c.shown AS s')
    + (a.hideSelfHarm ? `, ${SELF_HARM_SQL} AS sh` : '');
  const st = db.prepare(`SELECT f.rowid AS id, (${ok}) AS ok${cols} FROM chat_fts f JOIN chat_log c ON c.id = f.rowid
                          WHERE f.chat_fts MATCH ? AND f.rowid < ? AND f.rowid >= ? ORDER BY f.rowid DESC`);
  const has = (r: Row): boolean => whole === null
    || foldText(String(r.s ?? '')).includes(whole) || (!shownOnly && foldText(String(r.o ?? '')).includes(whole));
  const it = st.iterate(...f.args, ftsPhrase(probe, shownOnly ? 'shown' : undefined), a.hi, a.floor);
  const found: number[] = [];
  let last = a.hi;
  let seen = 0;
  let groups = 0;
  let end = false;
  let rows: Row[] = [];
  /** The budget ran out, but the last match looked at is a hidden line: the cursor must not be it (keep going). */
  let over = false;
  let extra = 0;
  try {
    for (;;) {
      const r = it.next();
      if (r.done) { end = true; break; }
      const row = r.value as Row;
      last = num(row.id);
      if (num(row.ok) !== 0 && has(row)) {
        found.push(last);
        if (found.length > a.limit) break;
      }
      const lastHidden = a.hideSelfHarm === true && num(row.sh) !== 0;
      if (over) {
        if (!lastHidden) break;
        if (++extra >= HIDDEN_CURSOR_STEPS) { end = true; break; }
        continue;
      }
      if (++seen % a.group === 0) {
        groups++;
        if (performance.now() - a.t0 >= a.maxMs || (a.maxGroups !== undefined && groups >= a.maxGroups)) {
          if (!lastHidden) break;
          over = true;
        }
      }
    }
    if (found.length) {
      rows = db.prepare('SELECT * FROM chat_log WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id DESC').all(JSON.stringify(found)) as Row[];
    }
  } finally {
    it.return?.();
  }
  if (found.length > a.limit) {
    rows.length = Math.min(rows.length, a.limit);
    return done(rows, rows.length ? num(rows[rows.length - 1]!.id) : null, false);
  }
  return end || last <= a.floor ? done(rows, null, false) : done(rows, last, true);
}

// ------------------------------------------------------------------------------------------
// The search
// ------------------------------------------------------------------------------------------

/**
 * One page of the chat log (newest first). Exact and unbounded by default; with opts.maxMs (the worker) every search
 * scans in windows and may return a partial page (see the file header).
 */
export function searchChatLog(db: DatabaseSync, q: LogQuery, opts: SearchOptions = {}): LogPage {
  const limit = clampLimit(q.limit, 100, LOG_MAX_LIMIT);
  const text = textOf(q);
  const plan = planOf(q, text);
  const now = opts.now ?? Date.now();
  const includeSelfHarm = q.includeSelfHarm ?? opts.includeSelfHarmDefault ?? true;
  const shortSince = shortSinceOf(q, text, now);
  const bounded = (opts.maxMs ?? 0) > 0;
  const f = filterOf(db, q, plan, text, includeSelfHarm, shortSince, plan === 'person' || (plan === 'scan' && !bounded));
  const lines = (rows: Row[]): ChatLogRow[] => {
    const out = rows.map(chatRowOf);
    return opts.withOriginal === false ? out.map(withoutOriginal) : out;
  };
  if (plan === 'person' || plan === 'tag') {
    const hiddenSt = includeSelfHarm ? null : db.prepare(`SELECT 1 AS x FROM chat_log c WHERE c.id = ? AND ${SELF_HARM_SQL}`);
    const p = keysetPage(db, q, plan, f, limit, opts, shortSince, hiddenSt ? (id) => !!hiddenSt.get(id) : null);
    return { lines: lines(p.rows), nextBefore: p.next ? p.next[1] : null, nextBeforeTs: p.next ? p.next[0] : null, partial: p.partial, plan, shortTextSince: shortSince };
  }
  const r = runnerOf(db, q, plan, text, f);
  const before = finite(q.before) ? Math.floor(q.before) : null;
  const done = (rows: Row[], nextBefore: number | null, partial: boolean): LogPage =>
    ({ lines: lines(rows), nextBefore, nextBeforeTs: null, partial, plan, shortTextSince: shortSince });
  if (!bounded) {
    if (plan === 'fts' && charLen(text!) > FTS_MATCH_CHARS) {
      return ftsStepped(db, q, text!, f, { hi: before ?? KEY_TOP, floor: KEY_BOTTOM, limit, maxMs: Infinity, t0: performance.now(), group: FTS_CHECK_EVERY }, done);
    }
    const rows = r.run(before, null, limit + 1);
    const more = rows.length > limit;
    if (more) rows.length = limit;
    return done(rows, more && rows.length ? num(rows[rows.length - 1]!.id) : null, false);
  }
  // Windowed (the worker): from the cursor down through the id range of the dates (idRangeOf: `until`, and `since` or
  // the 7-day floor of a short search), one id window at a time, until the page fills or time runs out.
  const { until } = timeBounds(q, validRanges(q));
  const range = idRangeOf(db, lowerBoundOf(q, shortSince), until);
  if (!range) return done([], null, false);
  let hi = Math.min(before ?? Number.MAX_SAFE_INTEGER, range.hi);
  const floor = range.lo;
  const fixed = finite(opts.windowIds) ? Math.max(1, Math.floor(opts.windowIds)) : null;
  const t0 = performance.now();
  if (plan === 'fts') {
    return ftsStepped(db, q, text!, f, {
      hi, floor, limit, maxMs: opts.maxMs!, t0, group: fixed ?? FTS_CHECK_EVERY, maxGroups: opts.maxWindows, hideSelfHarm: !includeSelfHarm,
    }, done);
  }
  let win = fixed ?? ID_WINDOW_FIRST;
  const out: Row[] = [];
  for (let w = 1; hi > floor; w++) {
    const w0 = performance.now();
    const lo = Math.max(floor, hi - win);
    out.push(...r.run(hi, lo, limit + 1 - out.length));
    if (out.length > limit) {
      out.length = limit;
      return done(out, num(out[limit - 1]!.id), false);
    }
    const span = hi - lo;
    hi = lo;
    if (hi <= floor) break;
    const t = performance.now();
    const left = opts.maxMs! - (t - t0);
    if (left <= 0 || (opts.maxWindows !== undefined && w >= opts.maxWindows)) return done(out, hi, true);
    if (fixed === null) {
      win = nextWindow(win, (t - w0) / span, left, ID_WINDOW_MIN, ID_WINDOW_MAX);
      if (!win) return done(out, hi, true);
    }
  }
  return done(out, null, false);
}

/**
 * Every line matching `q`, oldest first, one page per call (an empty page at the end). Exact (no windows): person and
 * tag searches walk their indexes in (ts, id) order, the others the log in id order.
 */
function pagerOf(db: DatabaseSync, q: LogQuery, page: number, includeSelfHarm: boolean, now: number): () => Row[] {
  const text = textOf(q);
  const plan = planOf(q, text);
  const shortSince = shortSinceOf(q, text, now);
  const f = filterOf(db, q, plan, text, includeSelfHarm, shortSince);
  let finished = false;
  if (plan === 'person' || plan === 'tag') {
    const sides = keySidesOf(db, q, plan, f);
    const { until } = timeBounds(q, validRanges(q));
    const since = lowerBoundOf(q, shortSince);
    let cur: Key = [since ?? KEY_BOTTOM, KEY_BOTTOM];
    const end: Key = [until ?? KEY_TOP, KEY_TOP];
    return () => {
      if (finished) return [];
      const rows = mergeKeyed(sides.map((s) => s.up(cur, end, page)), page, 1);
      if (rows.length < page) finished = true;
      if (rows.length) cur = keyOfRow(rows[rows.length - 1]!);
      return rows;
    };
  }
  const r = runnerOf(db, q, plan, text, f);
  let after = 0;
  return () => {
    if (finished) return [];
    const rows = r.run(null, null, page, 'asc', after);
    if (rows.length < page) finished = true;
    if (rows.length) after = num(rows[rows.length - 1]!.id);
    return rows;
  };
}

/**
 * Every line matching `q` (its limit / before are ignored), OLDEST first, in pages of `page` rows: `each` may be
 * async (a stream waiting for its reader). Exact (no windows). Returns the number of rows.
 */
export async function eachChatLogPage(db: DatabaseSync, q: LogQuery, each: (rows: ChatLogRow[]) => void | Promise<void>,
  opts: { page?: number; withOriginal?: boolean; includeSelfHarmDefault?: boolean; signal?: AbortSignal; now?: number } = {}): Promise<number> {
  const next = pagerOf(db, q, clampLimit(opts.page, 1000, 10_000), q.includeSelfHarm ?? opts.includeSelfHarmDefault ?? true, opts.now ?? Date.now());
  let total = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new MaintError('ECANCEL', 'The export was cancelled.');
    const rows = next();
    if (!rows.length) return total;
    let lines = rows.map(chatRowOf);
    if (opts.withOriginal === false) lines = lines.map(withoutOriginal);
    total += lines.length;
    await each(lines);
  }
}

/** eachChatLogPage for synchronous callers (ModStore.exportLog, the CLI). */
export function eachChatLogPageSync(db: DatabaseSync, q: LogQuery, each: (rows: ChatLogRow[]) => void, page = 1000): number {
  const next = pagerOf(db, q, clampLimit(page, 1000, 10_000), q.includeSelfHarm ?? true, Date.now());
  let total = 0;
  for (;;) {
    const rows = next();
    if (!rows.length) return total;
    total += rows.length;
    each(rows.map(chatRowOf));
  }
}

// ------------------------------------------------------------------------------------------
// Context drawer (§5.5): 10 lines before and after in the same room
// ------------------------------------------------------------------------------------------

/** Rows from before 0.6.0 (no room_uid) take their context from the same room_id within this many ms. */
export const LEGACY_CONTEXT_MS = 10 * MIN;
export const CONTEXT_DEFAULT = 10;
export const CONTEXT_MAX = 50;
const LEGACY_CONTEXT_ROWS = 5000;

export type ContextScope = 'room' | 'lobby' | 'zone' | 'legacy';

export interface ContextArgs {
  id: number;
  before?: number;
  after?: number;
  includeSelfHarm?: boolean;
  withOriginal?: boolean;
}

export interface ContextResult {
  /** null = no such line (or one the caller may not see) */
  anchor: ChatLogRow | null;
  /**
   * oldest first, ending just before the anchor. Room and lobby context also hold the zone-wide host announcements
   * (channel 'announce', roomUid null) posted between the lines shown, which that room saw; they come on top of the
   * `before` / `after` line counts.
   */
  before: ChatLogRow[];
  /** oldest first, starting just after the anchor (with the announcements in its span, as `before`) */
  after: ChatLogRow[];
  scope: ContextScope | null;
  moreBefore: boolean;
  moreAfter: boolean;
}

/**
 * The lines around one line: the same room_uid (a room in one server run, or that run's zone lobby), plus the
 * zone-wide announcements posted between the oldest and the newest line shown (everyone in the room or lobby saw them:
 * Zone.announce sends to the lobby and every room); a zone-wide announcement (no room) gets the lobby lines within
 * ±10 minutes; a row from before 0.6.0 (no room_uid) gets the same room_id (or the lobby) within ±10 minutes, among
 * the other pre-0.6.0 rows.
 */
export function chatContext(db: DatabaseSync, a: ContextArgs): ContextResult {
  const nb = Math.max(0, Math.min(CONTEXT_MAX, Math.floor(finite(a.before) ? a.before : CONTEXT_DEFAULT)));
  const na = Math.max(0, Math.min(CONTEXT_MAX, Math.floor(finite(a.after) ? a.after : CONTEXT_DEFAULT)));
  const none: ContextResult = { anchor: null, before: [], after: [], scope: null, moreBefore: false, moreAfter: false };
  if (!finite(a.id)) return none;
  const raw = db.prepare('SELECT * FROM chat_log WHERE id = ?').get(Math.floor(a.id)) as Row | undefined;
  if (!raw) return none;
  const anchor = chatRowOf(raw);
  const keepSelfHarm = a.includeSelfHarm === true;
  if (!keepSelfHarm && isWellbeingRow(anchor)) return none;
  const sh = keepSelfHarm ? '' : ` AND NOT ${SELF_HARM_SQL}`;
  const map = (rows: Row[]): ChatLogRow[] => {
    const out = rows.map(chatRowOf);
    return a.withOriginal === false ? out.map(withoutOriginal) : out;
  };
  let scope: ContextScope;
  let beforeRows: Row[];
  let afterRows: Row[];
  if (anchor.roomUid !== null) {
    scope = anchor.roomUid.endsWith(':zone') ? 'lobby' : 'room';
    beforeRows = db.prepare(`SELECT c.* FROM chat_log c WHERE c.room_uid = ? AND c.id < ?${sh} ORDER BY c.id DESC LIMIT ?`).all(anchor.roomUid, anchor.id, nb + 1) as Row[];
    afterRows = db.prepare(`SELECT c.* FROM chat_log c WHERE c.room_uid = ? AND c.id > ?${sh} ORDER BY c.id ASC LIMIT ?`).all(anchor.roomUid, anchor.id, na + 1) as Row[];
  } else {
    // ±10 minutes on the ts index, then the room rule (a bounded window, so no scan past it).
    const zone = anchor.channel === 'announce' && anchor.roomId === null;
    scope = zone ? 'zone' : 'legacy';
    const room = zone ? 'c.room_id IS NULL' : `c.room_uid IS NULL AND ${anchor.roomId === null ? 'c.room_id IS NULL' : 'c.room_id = ?'}`;
    const roomArgs: SQLInputValue[] = !zone && anchor.roomId !== null ? [anchor.roomId] : [];
    const win = `SELECT c.* FROM chat_log c INDEXED BY chat_log_ts WHERE c.ts >= ? AND c.ts <= ? AND ${room}${sh}`;
    beforeRows = db.prepare(`SELECT * FROM (${win} AND c.id < ? ORDER BY c.ts DESC, c.id DESC LIMIT ?) ORDER BY id DESC LIMIT ?`)
      .all(anchor.ts - LEGACY_CONTEXT_MS, anchor.ts, ...roomArgs, anchor.id, LEGACY_CONTEXT_ROWS, nb + 1) as Row[];
    afterRows = db.prepare(`SELECT * FROM (${win} AND c.id > ? ORDER BY c.ts ASC, c.id ASC LIMIT ?) ORDER BY id ASC LIMIT ?`)
      .all(anchor.ts, anchor.ts + LEGACY_CONTEXT_MS, ...roomArgs, anchor.id, LEGACY_CONTEXT_ROWS, na + 1) as Row[];
  }
  const moreBefore = beforeRows.length > nb;
  const moreAfter = afterRows.length > na;
  let beforeShown = beforeRows.slice(0, nb); // newest first
  let afterShown = afterRows.slice(0, na); // oldest first
  if (anchor.roomUid !== null) {
    // The zone-wide announcements inside the span shown (the room_uid IS NULL entries of chat_log_room in that id
    // range: 0.6 rows have a room_uid unless they are one), at most CONTEXT_MAX a side, the nearest first.
    const lo = beforeShown.length ? num(beforeShown[beforeShown.length - 1]!.id) : anchor.id;
    const hi = afterShown.length ? num(afterShown[afterShown.length - 1]!.id) : anchor.id;
    const ann = `SELECT c.* FROM chat_log c INDEXED BY chat_log_room WHERE c.room_uid IS NULL AND c.id > ? AND c.id < ?
                   AND c.channel = 'announce' AND c.room_id IS NULL`;
    const byId = (dir: 1 | -1) => (x: Row, y: Row): number => dir * (num(x.id) - num(y.id));
    if (lo < anchor.id) {
      const rows = db.prepare(`${ann} ORDER BY c.id DESC LIMIT ?`).all(lo, anchor.id, CONTEXT_MAX) as Row[];
      if (rows.length) beforeShown = [...beforeShown, ...rows].sort(byId(-1));
    }
    if (hi > anchor.id) {
      const rows = db.prepare(`${ann} ORDER BY c.id ASC LIMIT ?`).all(anchor.id, hi, CONTEXT_MAX) as Row[];
      if (rows.length) afterShown = [...afterShown, ...rows].sort(byId(1));
    }
  }
  return {
    anchor: a.withOriginal === false ? withoutOriginal(anchor) : anchor,
    before: map(beforeShown).reverse(),
    after: map(afterShown),
    scope, moreBefore, moreAfter,
  };
}

// ------------------------------------------------------------------------------------------
// Rooms in a range (§5.5 "room, listed from the range including closed rooms")
// ------------------------------------------------------------------------------------------

export interface LogRoom {
  /** null for rows from before 0.6.0 (grouped by roomId) */
  roomUid: string | null;
  roomId: string | null;
  /** the room's name on its last line (a rename shows the latest) */
  name: string;
  firstTs: number;
  lastTs: number;
  lines: number;
  /** the zone lobby of one server run (or, legacy, the lobby) */
  lobby: boolean;
  legacy: boolean;
}

export const ROOMS_DEFAULT_LIMIT = 200;
export const ROOMS_MAX_LIMIT = 1000;

/** Every room (and lobby) with lines in [since, until], most recently active first. */
export function roomsInRange(db: DatabaseSync, a: { since?: number; until?: number; limit?: number } = {}): LogRoom[] {
  const limit = clampLimit(a.limit, ROOMS_DEFAULT_LIMIT, ROOMS_MAX_LIMIT);
  const since = finite(a.since) ? Math.floor(a.since) : null;
  const until = finite(a.until) ? Math.floor(a.until) : null;
  // The id range that holds the dates' lines (idRangeOf: widened by the clock disorder), then exact dates per row.
  const range = idRangeOf(db, since, until);
  if (!range || range.hi <= range.lo) return [];
  const conds = ['id >= ?', 'id < ?', "NOT (room_uid IS NULL AND channel = 'announce' AND room_id IS NULL)"];
  const args: SQLInputValue[] = [range.lo, range.hi];
  if (since !== null) { conds.push('+ts >= ?'); args.push(since); }
  if (until !== null) { conds.push('+ts <= ?'); args.push(until); }
  const rows = db.prepare(`SELECT g.room_uid, g.room_id, g.first_ts, g.last_ts, g.n, c.room_name FROM (
      SELECT room_uid, CASE WHEN room_uid IS NULL THEN room_id END AS legacy_room, max(room_id) AS room_id,
             min(ts) AS first_ts, max(ts) AS last_ts, count(*) AS n, max(id) AS last_id
      FROM chat_log NOT INDEXED WHERE ${conds.join(' AND ')} GROUP BY room_uid, legacy_room) g
    JOIN chat_log c ON c.id = g.last_id ORDER BY g.last_ts DESC LIMIT ?`).all(...args, limit) as Row[];
  return rows.map((r) => {
    const roomUid = strOrNull(r.room_uid);
    const roomId = strOrNull(r.room_id);
    return {
      roomUid, roomId, name: String(r.room_name ?? ''), firstTs: num(r.first_ts), lastTs: num(r.last_ts), lines: num(r.n),
      lobby: roomUid !== null ? roomUid.endsWith(':zone') : roomId === null, legacy: roomUid === null,
    };
  });
}

// ------------------------------------------------------------------------------------------
// Stats (§5.5 header, §5.15 log/stats; cached 5 minutes)
// ------------------------------------------------------------------------------------------

export interface LogStats {
  rows: number;
  oldest: number | null;
  newest: number | null;
  dbBytes: number;
  walBytes: number;
  /** lines per local day, oldest first, for the last `days` days (`start` = that day's local midnight) */
  perDay: { day: number; start: number; n: number }[];
  /** lines removed since the last FTS optimize: the index tidies at the next quiet window (§5.5 purge dialog) */
  indexTidyPending: boolean;
  indexDirtyRows: number;
  /** when these numbers were read (a cached answer is up to STATS_CACHE_MS old) */
  at: number;
  cached: boolean;
}

export const STATS_CACHE_MS = 5 * MIN;
export const STATS_DEFAULT_DAYS = 90;
export const STATS_MAX_DAYS = 400;
const statsCache = new Map<string, { at: number; key: string; value: LogStats }>();

const fileSize = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };

/**
 * The log's size and shape. `tzOffsetMin` = the host's offset from UTC in minutes (Date#getTimezoneOffset sign:
 * minutes WEST of UTC are positive), for local days; default the worker's own.
 */
export function logStats(db: DatabaseSync, dbPath: string, a: { days?: number; tzOffsetMin?: number; now?: number; fresh?: boolean } = {}): LogStats {
  const now = finite(a.now) ? a.now : Date.now();
  const days = Math.max(1, Math.min(STATS_MAX_DAYS, Math.floor(finite(a.days) ? a.days : STATS_DEFAULT_DAYS)));
  const off = (finite(a.tzOffsetMin) ? a.tzOffsetMin : new Date(now).getTimezoneOffset()) * MIN;
  const key = `${days}:${off}`;
  const hit = statsCache.get(dbPath);
  if (!a.fresh && hit && hit.key === key && now - hit.at >= 0 && now - hit.at < STATS_CACHE_MS) return { ...hit.value, cached: true };
  const rows = scalar(db, 'SELECT count(*) FROM chat_log') ?? 0;
  const oldest = scalar(db, 'SELECT min(ts) FROM chat_log');
  const newest = scalar(db, 'SELECT max(ts) FROM chat_log');
  // Local day d covers [d * DAY + off, (d + 1) * DAY + off): shift by the offset, then whole days.
  const today = Math.floor((now - off) / DAY);
  const firstDay = today - days + 1;
  // The offset is inlined as an integer literal: a bound JS number is a REAL, and REAL division would not floor.
  const perDay = (db.prepare(`SELECT (ts - (${Math.round(off)})) / ${DAY} AS d, count(*) AS n FROM chat_log WHERE ts >= ? GROUP BY d ORDER BY d`)
    .all(firstDay * DAY + off) as Row[])
    .map((r) => ({ day: num(r.d), start: num(r.d) * DAY + off, n: num(r.n) }));
  const dirty = indexDirtyRows(db);
  const value: LogStats = {
    rows, oldest, newest, dbBytes: fileSize(dbPath), walBytes: fileSize(`${dbPath}-wal`), perDay,
    indexTidyPending: dirty > 0, indexDirtyRows: dirty, at: now, cached: false,
  };
  statsCache.set(dbPath, { at: now, key, value });
  return value;
}

/** Forget cached stats (after a purge; tests). */
export function clearStatsCache(dbPath?: string): void {
  if (dbPath === undefined) statsCache.clear(); else statsCache.delete(dbPath);
}

// ------------------------------------------------------------------------------------------
// Conduct counters (§5.8, §5.11: the Conduct view reads conduct_daily, never a scan)
// ------------------------------------------------------------------------------------------

/**
 * One named range of conduct days, both ends inclusive; a missing end is open. The day numbers are the counters' own
 * rule, erase.ts dayOf (the store, the purges and the deletions share it; today a UTC day, so on a US host "today"
 * turns at 17:00-18:00 local): callers compute them with conductDayOf, never from local midnights.
 */
export interface DayRange { sinceDay?: number; untilDay?: number }

export interface ConductTallyArgs {
  /** e.g. { today: {...}, week: {...}, term: {...}, all: {} } (at most 8) */
  ranges: Record<string, DayRange>;
  accountKeys?: readonly string[];
  tags?: readonly string[];
  /** rows (account × tag), most recent first (default 5000, at most 20000) */
  limit?: number;
}

export interface ConductTallyRow { accountKey: string; tag: string; counts: Record<string, number>; lastDay: number }

/** The conduct_daily day of an epoch-ms time (erase.ts dayOf: the one rule the counters, purges and deletions use). */
export const conductDayOf = dayOf;

/** Account keys / tags one tally may name (more is refused, never cut silently). */
export const CONDUCT_MAX_KEYS = 5000;
export const CONDUCT_MAX_TAGS = 200;

/** One tally: its rows, and whether the row cap (`limit`) cut any (the caller narrows the keys / tags, or warns). */
export interface ConductTallyPage { rows: ConductTallyRow[]; truncated: boolean }

/** The rows of conductTallyPage (use that one to learn whether the row cap cut any). */
export function conductTally(db: DatabaseSync, a: ConductTallyArgs): ConductTallyRow[] {
  return conductTallyPage(db, a).rows;
}

/**
 * Sum conduct_daily per student and tag over the named day ranges, most recent first. At most `limit` rows (default
 * 5000, at most 20000): `truncated` says the cap cut some (an all-time class summary of a large school, say), so a
 * summary never loses its least-recent students without a sign.
 */
export function conductTallyPage(db: DatabaseSync, a: ConductTallyArgs): ConductTallyPage {
  const names = Object.keys(a.ranges ?? {}).filter((k) => /^[A-Za-z0-9_-]{1,24}$/.test(k)).slice(0, 8);
  if (!names.length) throw new MaintError('EARGS', 'conduct.tally needs at least one range.');
  const sums: string[] = [];
  const sumArgs: SQLInputValue[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of names) {
    const r = a.ranges[k] ?? {};
    const s = finite(r.sinceDay) ? Math.floor(r.sinceDay) : -1e9;
    const u = finite(r.untilDay) ? Math.floor(r.untilDay) : 1e9;
    lo = Math.min(lo, s);
    hi = Math.max(hi, u);
    sums.push('SUM(CASE WHEN day >= ? AND day <= ? THEN n ELSE 0 END)');
    sumArgs.push(s, u);
  }
  const where = ['day >= ?', 'day <= ?'];
  const args: SQLInputValue[] = [lo, hi];
  if (a.accountKeys) {
    if (a.accountKeys.length > CONDUCT_MAX_KEYS) throw new MaintError('EARGS', `conduct.tally takes at most ${CONDUCT_MAX_KEYS} account keys.`);
    where.push('account_key IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(a.accountKeys.map(String)));
  }
  if (a.tags) {
    if (a.tags.length > CONDUCT_MAX_TAGS) throw new MaintError('EARGS', `conduct.tally takes at most ${CONDUCT_MAX_TAGS} tags.`);
    where.push('tag IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(a.tags.map(String)));
  }
  const limit = clampLimit(a.limit, 5000, 20_000);
  const rows = db.prepare(`SELECT account_key, tag, max(day) AS last_day, ${sums.map((s, i) => `${s} AS r${i}`).join(', ')}
    FROM conduct_daily WHERE ${where.join(' AND ')} GROUP BY account_key, tag ORDER BY last_day DESC, account_key, tag LIMIT ?`)
    .all(...sumArgs, ...args, limit + 1) as Row[];
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  return {
    rows: rows.map((r) => {
      const counts: Record<string, number> = {};
      names.forEach((k, i) => { counts[k] = num(r[`r${i}`]); });
      return { accountKey: String(r.account_key), tag: String(r.tag), counts, lastDay: num(r.last_day) };
    }),
    truncated,
  };
}

// ------------------------------------------------------------------------------------------
// Reveal (§5.15 log/reveal ★): originals by id, or one account's in a range
// ------------------------------------------------------------------------------------------

export const REVEAL_MAX_IDS = 100;
export const REVEAL_MAX_ROWS = 500;

export interface RevealArgs {
  ids?: readonly number[];
  accountId?: string;
  since?: number;
  until?: number;
  before?: number;
  limit?: number;
  includeSelfHarm?: boolean;
}

export function revealOriginals(db: DatabaseSync, a: RevealArgs): { originals: { id: number; original: string }[]; nextBefore: number | null } {
  const sh = a.includeSelfHarm === true ? '' : ` AND NOT ${SELF_HARM_SQL}`;
  if (Array.isArray(a.ids)) {
    const ids = [...new Set(a.ids.filter((x) => Number.isInteger(x)))].slice(0, REVEAL_MAX_IDS);
    if (!ids.length) return { originals: [], nextBefore: null };
    const rows = db.prepare(`SELECT c.id, c.original FROM chat_log c WHERE c.id IN (SELECT value FROM json_each(?))${sh} ORDER BY c.id DESC`)
      .all(JSON.stringify(ids)) as Row[];
    return { originals: rows.map((r) => ({ id: num(r.id), original: String(r.original ?? '') })), nextBefore: null };
  }
  if (!a.accountId) throw new MaintError('EARGS', 'log.reveal needs ids or an accountId.');
  const limit = clampLimit(a.limit, REVEAL_MAX_ROWS, REVEAL_MAX_ROWS);
  const conds = ['c.account_id = ?'];
  const args: SQLInputValue[] = [String(a.accountId)];
  if (finite(a.since)) { conds.push('c.ts >= ?'); args.push(Math.floor(a.since)); }
  if (finite(a.until)) { conds.push('c.ts <= ?'); args.push(Math.floor(a.until)); }
  if (finite(a.before)) { conds.push('c.id < ?'); args.push(Math.floor(a.before)); }
  const rows = db.prepare(`SELECT c.id, c.original FROM chat_log c WHERE ${conds.join(' AND ')}${sh} ORDER BY c.id DESC LIMIT ?`)
    .all(...args, limit + 1) as Row[];
  const more = rows.length > limit;
  if (more) rows.length = limit;
  return {
    originals: rows.map((r) => ({ id: num(r.id), original: String(r.original ?? '') })),
    nextBefore: more && rows.length ? num(rows[rows.length - 1]!.id) : null,
  };
}

// ------------------------------------------------------------------------------------------
// FTS merges in the worker (§5.16: the game thread's chat commits do no merge work)
// ------------------------------------------------------------------------------------------

/**
 * Pages one merge step writes (`INSERT INTO chat_fts(chat_fts, rank) VALUES('merge', N)`): measured on an
 * organically grown index, 16 pages take p50 ~0.7 ms and at most ~5 ms (64 pages: up to ~17 ms, 30 ms at 1M lines),
 * so the game thread's auth writes wait at most a few ms for the lock between two steps.
 */
export const FTS_MERGE_PAGES = 16;
/**
 * One upkeep call merges in steps for at most about this long (the write lock is free between steps). At one call a
 * second that is ~150 pages a second: measured, 0.4 pages per logged line keeps the index from growing segments.
 */
export const FTS_MERGE_BUDGET_MS = 8;

export interface FtsMergeResult {
  /** merge steps run */
  steps: number;
  /** false = the last step found nothing to merge (the index is tidy until the next lines) */
  pending: boolean;
  ms: number;
}

/**
 * Merge the FTS index's b-trees in small steps (each its own transaction) until nothing is left to merge or `maxMs`
 * is spent. A positive 'merge' merges a level once it holds `usermerge` (4) segments, as FTS5's automerge would inside
 * the writer's commit; a step that changes fewer than 2 rows found nothing (FTS5 docs). Null = no chat_fts (pre-v4).
 */
export function ftsMergeSteps(db: DatabaseSync, o: { pages?: number; maxMs?: number; maxSteps?: number } = {}): FtsMergeResult | null {
  const pages = Math.max(1, Math.min(4096, Math.floor(finite(o.pages) ? o.pages : FTS_MERGE_PAGES)));
  const maxMs = Math.max(0, finite(o.maxMs) ? o.maxMs : FTS_MERGE_BUDGET_MS);
  const maxSteps = Math.max(1, Math.floor(finite(o.maxSteps) ? o.maxSteps : 10_000));
  if (scalar(db, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'chat_fts'") === null) return null;
  const total = db.prepare('SELECT total_changes() AS n');
  const merge = db.prepare("INSERT INTO chat_fts(chat_fts, rank) VALUES('merge', ?)");
  const t0 = performance.now();
  let steps = 0;
  let pending = true;
  while (steps < maxSteps) {
    const before = num((total.get() as Row).n);
    merge.run(pages);
    steps++;
    if (num((total.get() as Row).n) - before < 2) { pending = false; break; }
    if (performance.now() - t0 >= maxMs) break;
  }
  return { steps, pending, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------------------------------
// The worker ops (registry.ts: MAINT_OPS = { ...CORE_OPS, ...QUERY_OPS })
// ------------------------------------------------------------------------------------------

const obj = (a: unknown): Record<string, unknown> => (a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {});
const optStr = (v: unknown, max: number, what: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new MaintError('EARGS', `${what} must be text.`);
  return v.slice(0, max);
};
const optNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new MaintError('EARGS', `${what} must be a number.`);
  return v;
};

/** A LogQuery from worker-op arguments (validated; unknown keys ignored). */
export function logQueryFrom(a: unknown): LogQuery {
  const o = obj(a);
  const q: LogQuery = {
    player: optStr(o.player, 64, 'player'), accountId: optStr(o.accountId, 64, 'accountId'), address: optStr(o.address, 64, 'address'),
    q: optStr(o.q, 200, 'q'), grep: optStr(o.grep, 200, 'grep'), tag: optStr(o.tag, 40, 'tag'),
    roomId: optStr(o.roomId, 32, 'roomId'), roomUid: optStr(o.roomUid, 80, 'roomUid'),
    since: optNum(o.since, 'since'), until: optNum(o.until, 'until'), before: optNum(o.before, 'before'), beforeTs: optNum(o.beforeTs, 'beforeTs'),
    limit: optNum(o.limit, 'limit'),
  };
  if (o.searchIn !== undefined) {
    if (o.searchIn !== 'both' && o.searchIn !== 'shown') throw new MaintError('EARGS', "searchIn must be 'both' or 'shown'.");
    q.searchIn = o.searchIn;
  }
  if (o.action !== undefined) {
    if (o.action !== 'flagged' && !(CHAT_ACTIONS as readonly unknown[]).includes(o.action)) throw new MaintError('EARGS', 'action must be pass, flag, mask, block, spam, muted or flagged.');
    q.action = o.action as LogQuery['action'];
  }
  if (o.display !== undefined) {
    const list = Array.isArray(o.display) ? o.display : [o.display];
    if (!list.length || list.some((d) => !(CHAT_DISPLAYS as readonly unknown[]).includes(d))) throw new MaintError('EARGS', `display must be one of ${CHAT_DISPLAYS.join(', ')}.`);
    q.display = list as ChatDisplay[];
  }
  if (o.channel !== undefined) {
    if (o.channel !== 'lobby' && !(LOG_CHANNELS as readonly unknown[]).includes(o.channel)) throw new MaintError('EARGS', 'channel must be all, team, name, room, announce or lobby.');
    q.channel = o.channel as LogQuery['channel'];
  }
  if (o.ranges !== undefined) {
    if (!Array.isArray(o.ranges) || o.ranges.length > MAX_RANGES) throw new MaintError('EARGS', `ranges must be a list of at most ${MAX_RANGES} { since, until }.`);
    q.ranges = o.ranges.map((r, i) => {
      const x = obj(r);
      const since = optNum(x.since, `ranges[${i}].since`);
      const until = optNum(x.until, `ranges[${i}].until`);
      if (since === undefined || until === undefined) throw new MaintError('EARGS', `ranges[${i}] needs since and until.`);
      return { since, until };
    });
  }
  if (o.includeSelfHarm !== undefined) q.includeSelfHarm = o.includeSelfHarm === true;
  return q;
}

/**
 * The worker ops fail CLOSED on the privacy fields (§5.5, §5.15): no original text or hit labels unless
 * `withOriginal: true`, a text search matches the shown text unless `searchIn: 'both'`, and no SELF-HARM line unless
 * `includeSelfHarm: true`. The caller opts in only for a principal with `reveal` (resp. `wellbeing`).
 */
const withOriginalOf = (a: unknown): boolean => obj(a).withOriginal === true;
/** logQueryFrom with the worker's closed default: searchIn 'shown'. */
export function workerQueryFrom(a: unknown): LogQuery {
  const q = logQueryFrom(a);
  if (q.searchIn === undefined) q.searchIn = 'shown';
  return q;
}

/** log.export: pages of this many rows (§5.5 "streamed by the worker in pages of 1,000"). */
export const EXPORT_PAGE = 1000;

const exportStream: StreamOp<unknown, ChatLogRow> = {
  kind: 'read',
  stream: async (a: unknown, ctx: OpContext, emit: (rows: ChatLogRow[]) => Promise<void>) => {
    const o = obj(a);
    const q = workerQueryFrom(a);
    const rows = await eachChatLogPage(ctx.read(), q, (lines) => emit(lines), {
      page: typeof o.pageSize === 'number' ? o.pageSize : EXPORT_PAGE,
      // What they typed only when "include unfiltered text" is ticked; wellbeing lines only when ticked (§5.5).
      withOriginal: o.includeOriginal === true,
      includeSelfHarmDefault: false,
      signal: ctx.signal,
    });
    return { rows };
  },
};

/**
 * The panel's reads (§5.16 "every panel read … in the worker"). Each runs on the worker's read-only connection:
 *   log.search   LogQuery + { withOriginal?, maxMs? }   → LogPage (partial pages continue with nextBefore / nextBeforeTs)
 *   log.context  { id, before?, after?, includeSelfHarm?, withOriginal? } → ContextResult
 *   log.rooms    { since?, until?, limit? }            → { rooms: LogRoom[] }
 *   log.stats    { days?, tzOffsetMin?, fresh? }        → LogStats (cached 5 minutes)
 *   log.reveal   { ids } | { accountId, since?, until?, before?, limit? } (+ includeSelfHarm?) → { originals, nextBefore }
 *   log.export   (stream) LogQuery + { includeOriginal?, pageSize? } → pages of ChatLogRow, oldest first; { rows }
 *   conduct.tally ConductTallyArgs                       → { rows: ConductTallyRow[], truncated } (the row cap cut some)
 * They fail closed (withOriginalOf): no originals / hit labels unless withOriginal: true (log.export: includeOriginal),
 * text matched in the shown text unless searchIn: 'both', no SELF-HARM line unless includeSelfHarm: true.
 * And the upkeep writes (queued with the other writes), so the game thread neither checkpoints nor merges:
 *   wal.checkpoint { mode?: 'passive' | 'truncate', merge?: boolean, mergeMs? }
 *                → { mode, busy, walFrames, checkpointed, ms, walBytes, merge: FtsMergeResult | null }
 *   fts.merge    { pages?, maxMs? }                    → FtsMergeResult | null
 * Call 'wal.checkpoint' about once a second (it merges first, FTS_MERGE_BUDGET_MS, unless merge: false). Measured at
 * 1M rows (Windows): a WAL autocheckpoint inside a game-thread chat commit took 100-145 ms (the fsync of the whole
 * file), and FTS5's automerge inside one 20-45 ms on a grown index; with the game connection at wal_autocheckpoint 0
 * and automerge off (GAME_THREAD_STORE_OPTIONS) and this op every second, 1-row commits stay at p99 < 1 ms, max ~2 ms.
 * 'truncate' also shrinks the file (quiet windows).
 */
export const QUERY_OPS: OpTable = {
  'log.search': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext): LogPage => {
      const o = obj(a);
      const maxMs = typeof o.maxMs === 'number' && Number.isFinite(o.maxMs) ? Math.max(1, Math.min(1000, o.maxMs)) : WORKER_SEARCH_MAX_MS;
      return searchChatLog(ctx.read(), workerQueryFrom(a), { maxMs, withOriginal: withOriginalOf(a), includeSelfHarmDefault: false });
    },
  },
  'log.context': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext): ContextResult => {
      const o = obj(a);
      const id = optNum(o.id, 'id');
      if (id === undefined) throw new MaintError('EARGS', 'log.context needs the line id.');
      return chatContext(ctx.read(), {
        id, before: optNum(o.before, 'before'), after: optNum(o.after, 'after'),
        includeSelfHarm: o.includeSelfHarm === true, withOriginal: withOriginalOf(a),
      });
    },
  },
  'log.rooms': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      return { rooms: roomsInRange(ctx.read(), { since: optNum(o.since, 'since'), until: optNum(o.until, 'until'), limit: optNum(o.limit, 'limit') }) };
    },
  },
  'log.stats': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext): LogStats => {
      const o = obj(a);
      return logStats(ctx.read(), ctx.dbPath, { days: optNum(o.days, 'days'), tzOffsetMin: optNum(o.tzOffsetMin, 'tzOffsetMin'), fresh: o.fresh === true });
    },
  },
  'log.reveal': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      if (o.ids !== undefined && !Array.isArray(o.ids)) throw new MaintError('EARGS', 'ids must be a list of line ids.');
      if (Array.isArray(o.ids) && o.ids.length > REVEAL_MAX_IDS) throw new MaintError('EARGS', `At most ${REVEAL_MAX_IDS} ids at a time.`);
      return revealOriginals(ctx.read(), {
        ids: Array.isArray(o.ids) ? o.ids as number[] : undefined, accountId: optStr(o.accountId, 64, 'accountId'),
        since: optNum(o.since, 'since'), until: optNum(o.until, 'until'), before: optNum(o.before, 'before'), limit: optNum(o.limit, 'limit'),
        includeSelfHarm: o.includeSelfHarm === true,
      });
    },
  },
  'log.export': exportStream,
  'conduct.tally': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      const ranges = obj(o.ranges) as Record<string, DayRange>;
      return conductTallyPage(ctx.read(), {
        ranges,
        accountKeys: Array.isArray(o.accountKeys) ? o.accountKeys.map(String) : undefined,
        tags: Array.isArray(o.tags) ? o.tags.map(String) : undefined,
        limit: optNum(o.limit, 'limit'),
      });
    },
  },
  'wal.checkpoint': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      const mode = o.mode === 'truncate' ? 'TRUNCATE' : 'PASSIVE';
      const db = ctx.write();
      // the merges first: their pages then go into the main file with this checkpoint
      const merge = o.merge === false ? null : ftsMergeSteps(db, { maxMs: optNum(o.mergeMs, 'mergeMs') });
      const t = performance.now();
      const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as Row | undefined;
      return {
        mode: mode.toLowerCase(), busy: num(r?.busy) !== 0, walFrames: num(r?.log), checkpointed: num(r?.checkpointed),
        ms: performance.now() - t, walBytes: fileSize(`${ctx.dbPath}-wal`), merge,
      };
    },
  },
  'fts.merge': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext): FtsMergeResult | null => {
      const o = obj(a);
      return ftsMergeSteps(ctx.write(), { pages: optNum(o.pages, 'pages'), maxMs: optNum(o.maxMs, 'maxMs') });
    },
  },
};
