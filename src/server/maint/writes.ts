// OWNER: SERVER MODERATION (LAN task B8b). The maintenance worker's chunked WRITES on the chat log
// (docs/LAN-EDITION-proposal.md §5.5 retention and manual purge, §5.16 "chunked writes", §6.4, §8.1), as worker ops
// (WRITE_OPS, spread into MAINT_OPS by registry.ts: a handoff to B5) and as plain functions over a connection:
//
//   purge.count        (read)  { before, accountId? }            → { rows, before }      the 409 count of log/purge
//   purge.chat         (write) { before, accountId?, by }         → { deleted, conductRows, reportCopies, … }
//       The host's manual purge ★ (T-ADM-8): the deletion-ledger entry first (fsynced; the entry of
//       maint/ledger.ts purgeRecorded), then the lines in adaptive chunks, their tags, reviews and wellbeing acks
//       (cascade), then erase.ts purgeChatBefore for the conduct counters of the whole days before the cut and the
//       report copies: the same end state a restore's re-apply gives.
//   retention.chat     (write) { before }                         → { deleted, reportCopies }
//       The automatic retention (days / term / the 90-day fallback; the policy is ModerationService's): lines older
//       than the cut with their tags, reviews and acks (cascade) and their report copies. The conduct counters stay:
//       they are RECORDS, kept for records retention (365 days by default; §5.5, §5.11 "term, all time"), so this is
//       not a ledger purge (a ledger re-apply deletes counters) — and it needs none: the same rule prunes again
//       after a restore.
//   retention.records  (write) { keepBefore, deviceChecksBefore? } → { actions, reports, bans, conduct, deviceChecks }
//       Records retention: audit rows, reports, ended bans and conduct counters older than keepBefore; device-check
//       results older than 7 days (§8.1).
//   retention.addresses (write) { before }                        → { accountLines, guestLines }
//       Address minimisation (§6.4, School): account lines older than 7 days lose their address; guest lines keep only
//       the address tag (addressTagOf, keyed with the install's pepper). A watermark (mod_meta.addr_min_ts) keeps each
//       nightly run to the lines that crossed the 7 days since the last one.
//   wellbeing.clear    (write) { before }                         → { cleared }
//       §5.11: a wellbeing line's original text (and its shown copy) is cleared 30 days after the host acknowledged it;
//       its hit labels keep only their categories (the line stays a SELF-HARM line, the words go).
//   wellbeing.pending  (read)  { since?, limit? }                 → { lines }   unacknowledged SELF-HARM lines (ids,
//       times, rooms; never names or text): the service raises their nameless alerts again after a restart.
//   wellbeing.ack      (write) { chatId, by, note?, at? }          → { acked, already }
//   chat.locate        (read)  { lines: [{ ts, playerId, channel, accountId? | nameKey? }] } → { ids }
//       The chat_log ids of lines the game thread logged (an alert's lines, before ModStore reports their ids).
//   retention.term.get (read)  {}                                 → { owed }
//   retention.term.set (write) { owed: [{ cut, purgeAt }] }        → { owed }
//       The term purges still owed after the host set the next term's end date before the ending term was purged
//       (mod_meta term_owed_*; the service's retention run still purges those lines at purgeAt, after the backup).
//
// Pacing (§5.16, T-PERF-3): at most 250 rows per statement (erase.ts ERASE_CHUNK). The chunk size adapts so each
// statement holds the write lock about CHUNK_TARGET_MS (a deleted line also deletes its FTS entries and cascades to its
// tags, so 250 rows took ~23 ms at 260k lines on the owner's PC, and a school PC is 2-3× slower); after each chunk the
// worker sleeps about as long as the chunk took (2-25 ms). The game thread's own writes (auth, the chat log) then find
// the lock free often and never wait behind a long run of chunks (writes.perf.test.ts measures a 200k-line purge).
// Every step is idempotent; no FTS secure-delete (§0 fact 4): removed lines' index entries go at the next 'optimize'
// (mod_meta.fts_dirty, MaintService's quiet window).
import { createHmac } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { assertEraseSchema, ERASE_CHUNK, markIndexDirty, purgeChatBefore, type EraseOptions, type PurgeCounts } from './erase';
import { appendLedgerFor, effectiveCut, ledgerPath, nativeLineage, type LedgerEntry } from './ledger';
import type { OpContext, OpTable } from './ops';
import { MaintError } from './protocol';
import { clearStatsCache } from './queries';

const DAY = 86_400_000;

/** Rows per chunked statement (§5.16: 250). */
export const WRITE_CHUNK = ERASE_CHUNK;
/** Address minimisation: account lines lose their address, guest lines keep only the tag, after this many days (§6.4). */
export const ADDRESS_MINIMISE_DAYS = 7;
/** A wellbeing line's text is cleared this many days after it was acknowledged (§5.11). */
export const WELLBEING_CLEAR_DAYS = 30;
/** Device-check results are kept this many days (§8.1). */
export const DEVICE_CHECK_DAYS = 7;
/** Adaptive chunks: aim each statement at this many ms, between CHUNK_MIN and WRITE_CHUNK rows, starting at CHUNK_START. */
export const CHUNK_TARGET_MS = 8;
export const CHUNK_MIN = 20;
export const CHUNK_START = 100;
/** The pause after each chunk: about the chunk's own time, within these bounds (ms). */
export const PACE_MIN_MS = 2;
export const PACE_MAX_MS = 25;
/** A stored minimised guest address starts with this (addressTagOf). */
export const ADDRESS_TAG_PREFIX = 'tag:';
const ADDR_WATERMARK = 'addr_min_ts';

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MaintError('ECANCEL', 'The job was cancelled.');
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export interface WriteOptions {
  /** a fixed number of rows per chunk (default: adaptive, Chunker) */
  chunk?: number;
  signal?: AbortSignal;
  /** awaited after each chunk with the chunk's duration (default: pace(ms), a short sleep) */
  pause?: (chunkMs: number) => Promise<void>;
  /** after each chunk: the rows done so far */
  progress?: (done: number) => void;
}

/**
 * The chunk size: fixed when the caller gives one, else adaptive: cut to the target's share (at least halved) when a
 * chunk took more than 1.5 x CHUNK_TARGET_MS, doubled when a full chunk took less than half of it.
 */
export class Chunker {
  size: number;
  constructor(private readonly fixed?: number, private readonly targetMs = CHUNK_TARGET_MS) {
    this.size = fixed !== undefined ? Math.max(1, Math.floor(fixed)) : CHUNK_START;
  }
  took(ms: number, rows: number): void {
    if (this.fixed !== undefined || !Number.isFinite(ms)) return;
    if (ms > this.targetMs * 1.5) this.size = Math.max(CHUNK_MIN, Math.min(Math.floor(this.size / 2), Math.floor((this.size * this.targetMs) / ms)));
    else if (ms < this.targetMs / 2 && rows >= this.size) this.size = Math.min(WRITE_CHUNK, this.size * 2);
  }
}

/** The default pause after a chunk: about as long as the chunk took, within PACE_MIN_MS..PACE_MAX_MS. */
export function pace(chunkMs: number): Promise<void> {
  const ms = Math.max(PACE_MIN_MS, Math.min(PACE_MAX_MS, Math.ceil(Number.isFinite(chunkMs) ? chunkMs : PACE_MIN_MS)));
  return new Promise((r) => setTimeout(r, ms));
}

/** An EraseOptions whose pause is paced by the time since the last pause (erase.ts only says "between chunks"). */
function erasePacing(o: WriteOptions): EraseOptions {
  let last = performance.now();
  const pause = o.pause ?? pace;
  return {
    chunk: o.chunk ?? WRITE_CHUNK,
    signal: o.signal,
    pause: async () => {
      const ms = performance.now() - last;
      await pause(ms);
      last = performance.now();
    },
  };
}

// ------------------------------------------------------------------------------------------
// The manual purge (§5.5 ★; T-ADM-8)
// ------------------------------------------------------------------------------------------

export interface PurgeArgs {
  /** epoch ms: lines with ts < before go */
  before: number;
  /** only this account's lines */
  accountId?: string | null;
}

/** How many lines a purge would remove (the first log/purge call answers 409 with it). Indexed count. */
export function purgeCount(db: DatabaseSync, a: PurgeArgs): number {
  const before = Math.floor(a.before);
  const r = a.accountId
    ? db.prepare('SELECT count(*) AS n FROM chat_log WHERE account_id = ? AND ts < ?').get(a.accountId, before) as Row
    : db.prepare('SELECT count(*) AS n FROM chat_log WHERE ts < ?').get(before) as Row;
  return num(r.n);
}

export interface PurgeResult extends PurgeCounts {
  /** the deletion-ledger entry written first */
  entry: LedgerEntry;
}

/**
 * Delete lines older than `before` (one account's, or everyone's) in adaptive, paced chunks; their tags, reviews and
 * acks go by cascade. The index is marked for a tidy. Returns the lines deleted.
 */
async function deleteLines(db: DatabaseSync, before: number, accountId: string | null, o: WriteOptions): Promise<number> {
  const del = accountId
    ? db.prepare('DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE account_id = ? AND ts < ? ORDER BY ts LIMIT ?)')
    : db.prepare('DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE ts < ? ORDER BY ts LIMIT ?)');
  const args: SQLInputValue[] = accountId ? [accountId, before] : [before];
  const chunker = new Chunker(o.chunk);
  const pause = o.pause ?? pace;
  let deleted = 0;
  for (;;) {
    aborted(o.signal);
    const size = chunker.size;
    const t = performance.now();
    const n = num(del.run(...args, size).changes);
    const ms = performance.now() - t;
    if (n) markIndexDirty(db, n);
    deleted += n;
    o.progress?.(deleted);
    if (n < size) return deleted;
    chunker.took(ms, n);
    await pause(ms);
  }
}

/**
 * The recorded manual purge, as maint/ledger.ts purgeRecorded makes it (the entry first, fsynced, with the effective
 * cut), but with this module's adaptive chunks for the lines; then erase.ts purgeChatBefore, the re-apply's own step,
 * removes the conduct counters of the whole days before the cut and the report copies. Idempotent.
 */
export async function purgeChat(
  db: DatabaseSync, dataDir: string, a: PurgeArgs & { by: string; ts?: number }, o: WriteOptions & { lineage?: string | null } = {},
): Promise<PurgeResult> {
  assertEraseSchema(db);
  if (!Number.isFinite(Math.floor(a.before))) throw new MaintError('EARGS', 'purge.chat needs a time.');
  const ts = Math.floor(a.ts ?? Date.now());
  const accountId = a.accountId || null;
  // The entry carries the data's lineage (stamped from this install's backup key when the DB has none), so a restore
  // re-applies it only to this data (ledger.ts applicableEntries).
  const entry = appendLedgerFor(db, ledgerPath(dataDir), {
    ts, kind: 'purge', by: a.by, before: effectiveCut({ ts, before: a.before }), ...(accountId ? { accountId } : {}),
  }, { lineage: o.lineage });
  const lines = await deleteLines(db, entry.before!, accountId, o);
  const rest = await purgeChatBefore(db, { before: entry.before!, accountId }, erasePacing(o));
  return { ...rest, chat: lines + rest.chat, entry };
}

// ------------------------------------------------------------------------------------------
// Automatic retention (§5.5: days, term, forever; the fallback)
// ------------------------------------------------------------------------------------------

export interface RetentionChatResult { deleted: number; reportsUpdated: number; reportCopies: number }

const parseList = (v: unknown): unknown[] => {
  if (typeof v !== 'string') return [];
  try { const a = JSON.parse(v) as unknown; return Array.isArray(a) ? a : []; } catch { return []; }
};

/**
 * Drop the report copies of lines that retention removed: every copy older than `before` (retention removes ALL
 * lines older than its cut, so such a copy can only be of a removed line) and every id whose line is gone.
 */
function dropOldReportCopies(db: DatabaseSync, before: number, signal?: AbortSignal): { reportsUpdated: number; reportCopies: number } {
  const page = db.prepare(`SELECT id, recent_chat_json, recent_ids FROM reports WHERE id > ? AND (recent_chat_json <> '[]' OR recent_ids <> '[]')
                           ORDER BY id LIMIT 500`);
  const exists = db.prepare('SELECT 1 AS x FROM chat_log WHERE id = ?');
  const upd = db.prepare('UPDATE reports SET recent_chat_json = ?, recent_ids = ? WHERE id = ?');
  const out = { reportsUpdated: 0, reportCopies: 0 };
  let after = 0;
  for (;;) {
    aborted(signal);
    const rows = page.all(after) as Row[];
    if (!rows.length) return out;
    tx(db, () => {
      for (const r of rows) {
        after = num(r.id);
        const copies = parseList(r.recent_chat_json);
        const ids = parseList(r.recent_ids).filter((x): x is number => Number.isInteger(x));
        const removed = new Set<number>();
        const kept = copies.filter((c) => {
          if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
          const o = c as Record<string, unknown>;
          const old = typeof o.ts === 'number' && o.ts < before;
          if (old && typeof o.id === 'number') removed.add(o.id);
          return !old;
        });
        const keptIds = ids.filter((x) => !removed.has(x) && exists.get(x) !== undefined);
        if (kept.length === copies.length && keptIds.length === ids.length) continue;
        upd.run(JSON.stringify(kept), JSON.stringify(keptIds), r.id as SQLInputValue);
        out.reportsUpdated++;
        out.reportCopies += copies.length - kept.length;
      }
    });
  }
}

/**
 * Retention: delete lines older than `before` (chunked, paced), their tags / reviews / acks by cascade, then the
 * report copies of those lines. Conduct counters stay (records retention). Returns 0 rows when nothing is that old
 * (one indexed lookup). Idempotent.
 */
export async function retentionChat(db: DatabaseSync, a: { before: number }, o: WriteOptions = {}): Promise<RetentionChatResult> {
  assertEraseSchema(db);
  const before = Math.floor(a.before);
  if (!Number.isFinite(before)) throw new MaintError('EARGS', 'retention.chat needs a time.');
  const out: RetentionChatResult = { deleted: 0, reportsUpdated: 0, reportCopies: 0 };
  if (!db.prepare('SELECT 1 FROM chat_log WHERE ts < ? LIMIT 1').get(before)) {
    // Nothing old in the log: report copies older than the cut can still be left from an older pruner.
    Object.assign(out, dropOldReportCopies(db, before, o.signal));
    return out;
  }
  out.deleted = await deleteLines(db, before, null, o);
  Object.assign(out, dropOldReportCopies(db, before, o.signal));
  return out;
}

export interface RecordsArgs {
  /** audit rows, reports, bans that ended, and conduct counters of days before this go */
  keepBefore: number;
  /** device-check results before this go (default keepBefore) */
  deviceChecksBefore?: number;
}

export interface RecordsCounts { actions: number; reports: number; bans: number; conduct: number; deviceChecks: number }

/** Records retention (§5.5 "Records (365 days by default)"), chunked and paced. Idempotent. */
export async function pruneRecords(db: DatabaseSync, a: RecordsArgs, o: WriteOptions = {}): Promise<RecordsCounts> {
  const keep = Math.floor(a.keepBefore);
  if (!Number.isFinite(keep)) throw new MaintError('EARGS', 'retention.records needs keepBefore.');
  const checks = finite(a.deviceChecksBefore) ? Math.floor(a.deviceChecksBefore) : keep;
  const chunk = Math.max(1, Math.floor(o.chunk ?? WRITE_CHUNK));
  const day = Math.floor(keep / DAY);
  const pause = o.pause ?? pace;
  const steps: [keyof RecordsCounts, string, SQLInputValue[]][] = [
    ['actions', 'DELETE FROM mod_actions WHERE id IN (SELECT id FROM mod_actions WHERE ts < ? ORDER BY ts LIMIT ?)', [keep]],
    ['reports', 'DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE ts < ? ORDER BY ts LIMIT ?)', [keep]],
    ['bans', `DELETE FROM bans WHERE id IN (SELECT id FROM bans WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
                OR (revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?) ORDER BY id LIMIT ?)`, [keep, keep]],
    ['conduct', `DELETE FROM conduct_daily WHERE (account_key, day, tag) IN
                   (SELECT account_key, day, tag FROM conduct_daily WHERE day < ? LIMIT ?)`, [day]],
    ['deviceChecks', 'DELETE FROM device_checks WHERE id IN (SELECT id FROM device_checks WHERE ts < ? ORDER BY ts LIMIT ?)', [checks]],
  ];
  const out: RecordsCounts = { actions: 0, reports: 0, bans: 0, conduct: 0, deviceChecks: 0 };
  let done = 0;
  for (const [k, sql, args] of steps) {
    const st = db.prepare(sql);
    for (;;) {
      aborted(o.signal);
      const t = performance.now();
      const n = num(st.run(...args, chunk).changes);
      out[k] += n;
      done += n;
      if (n) o.progress?.(done);
      if (n < chunk) break;
      await pause(performance.now() - t);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Address minimisation (§6.4)
// ------------------------------------------------------------------------------------------

/**
 * The stored form of a minimised guest address: `tag:` + the first 4 hex digits of HMAC-SHA256(pepper, address) —
 * the same tag the admin API shows moderators when it is keyed with the pepper (http.ts addressTagKey). With no pepper
 * an unkeyed SHA-256 stands in (weaker: an address can then be confirmed by hashing guesses).
 */
export function addressTagOf(address: string, pepper?: Uint8Array | null): string {
  const a = String(address ?? '').toLowerCase();
  const h = pepper && pepper.length ? createHmac('sha256', Buffer.from(pepper)) : createHmac('sha256', 'voidswarm-address-tag-unkeyed-v1');
  return `${ADDRESS_TAG_PREFIX}${h.update(a, 'utf8').digest('hex').slice(0, 4)}`;
}

export const isAddressTag = (v: unknown): boolean => typeof v === 'string' && v.startsWith(ADDRESS_TAG_PREFIX);

export interface MinimiseArgs {
  /** lines older than this are minimised (now - 7 days) */
  before: number;
  pepper?: Uint8Array | null;
  /** scan from the start of the log, ignoring the watermark (tests, a repair) */
  full?: boolean;
}

function meta(db: DatabaseSync, k: string): number | null {
  const r = db.prepare('SELECT v FROM mod_meta WHERE k = ?').get(k) as Row | undefined;
  return r ? num(r.v) : null;
}
function setMeta(db: DatabaseSync, k: string, v: number): void {
  db.prepare('INSERT INTO mod_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, Math.floor(v));
}

/**
 * Minimise addresses on lines older than `before`: account lines → NULL, guest lines → their tag. Walks the lines
 * between the last run's cut (mod_meta.addr_min_ts) and this one in (ts, id) order, 250 per transaction. Bans keep
 * their own addresses. Idempotent.
 */
export async function minimiseAddresses(db: DatabaseSync, a: MinimiseArgs, o: WriteOptions = {}): Promise<{ accountLines: number; guestLines: number }> {
  const before = Math.floor(a.before);
  if (!Number.isFinite(before)) throw new MaintError('EARGS', 'retention.addresses needs a time.');
  const from = a.full ? Number.MIN_SAFE_INTEGER : (meta(db, ADDR_WATERMARK) ?? Number.MIN_SAFE_INTEGER);
  const out = { accountLines: 0, guestLines: 0 };
  if (from >= before) return out;
  const chunk = Math.max(1, Math.floor(o.chunk ?? WRITE_CHUNK));
  const page = db.prepare(`SELECT id, ts, account_id, address FROM chat_log INDEXED BY chat_log_ts
                            WHERE ts >= ? AND ts < ? AND (ts > ? OR id > ?) ORDER BY ts, id LIMIT ?`);
  const clear = db.prepare('UPDATE chat_log SET address = NULL WHERE id = ?');
  const setTag = db.prepare('UPDATE chat_log SET address = ? WHERE id = ?');
  const pause = o.pause ?? pace;
  let curTs = from;
  let curId = Number.MIN_SAFE_INTEGER;
  for (;;) {
    aborted(o.signal);
    const t = performance.now();
    const rows = page.all(curTs, before, curTs, curId, chunk) as Row[];
    if (!rows.length) break;
    tx(db, () => {
      for (const r of rows) {
        const addr = r.address;
        if (typeof addr !== 'string' || !addr) continue;
        if (r.account_id !== null && r.account_id !== undefined) { clear.run(r.id as SQLInputValue); out.accountLines++; }
        else if (!isAddressTag(addr)) { setTag.run(addressTagOf(addr, a.pepper), r.id as SQLInputValue); out.guestLines++; }
      }
    });
    const last = rows[rows.length - 1]!;
    curTs = num(last.ts);
    curId = num(last.id);
    o.progress?.(out.accountLines + out.guestLines);
    if (rows.length < chunk) break;
    await pause(performance.now() - t);
  }
  setMeta(db, ADDR_WATERMARK, before);
  return out;
}

// ------------------------------------------------------------------------------------------
// Wellbeing (§5.11): nameless alerts after a restart, acknowledgements, the 30-day clear
// ------------------------------------------------------------------------------------------

/** A hit label with its term dropped: "selfharm:x" → "selfharm:", "flag:gang:x" → "flag:gang:" (the tag survives). */
export function categoryOnlyLabel(label: string): string {
  const s = String(label);
  const parts = s.split(':');
  if ((parts[0] === 'custom' || parts[0] === 'flag') && parts.length >= 2) return `${parts[0]}:${parts[1]}:`;
  return parts.length >= 2 ? `${parts[0]}:` : s;
}

/**
 * Clear what a wellbeing line said, 30 days after its acknowledgement: `original` and `shown` become '' and the hit
 * labels keep only their categories (so the line is still a SELF-HARM line to every filter, but the words are gone).
 * Chunked; the FTS index entries go at the next optimize. Idempotent.
 */
export async function clearWellbeingOriginals(db: DatabaseSync, a: { before: number }, o: WriteOptions = {}): Promise<{ cleared: number }> {
  const before = Math.floor(a.before);
  if (!Number.isFinite(before)) throw new MaintError('EARGS', 'wellbeing.clear needs a time.');
  const chunk = Math.max(1, Math.floor(o.chunk ?? WRITE_CHUNK));
  const page = db.prepare(`SELECT c.id, c.hits FROM wellbeing_acks w JOIN chat_log c ON c.id = w.chat_id
                            WHERE w.acked_at < ? AND w.chat_id > ? AND (c.original <> '' OR c.shown <> '') ORDER BY w.chat_id LIMIT ?`);
  const upd = db.prepare("UPDATE chat_log SET original = '', shown = '', hits = ? WHERE id = ?");
  const pause = o.pause ?? pace;
  let after = Number.MIN_SAFE_INTEGER;
  let cleared = 0;
  for (;;) {
    aborted(o.signal);
    const t = performance.now();
    const rows = page.all(before, after, chunk) as Row[];
    if (!rows.length) break;
    tx(db, () => {
      for (const r of rows) {
        const hits = [...new Set(parseList(r.hits).map((h) => categoryOnlyLabel(String(h))))];
        upd.run(JSON.stringify(hits), r.id as SQLInputValue);
        cleared++;
      }
      markIndexDirty(db, rows.length);
    });
    after = num(rows[rows.length - 1]!.id);
    o.progress?.(cleared);
    if (rows.length < chunk) break;
    await pause(performance.now() - t);
  }
  return { cleared };
}

/** An unacknowledged wellbeing line (for its nameless alert): where and when, never who or what. */
export interface WellbeingPending { chatId: number; ts: number; roomName: string; roomUid: string | null; channel: string }

export const PENDING_WELLBEING_DAYS = 30;
export const PENDING_WELLBEING_MAX = 200;

/** Unacknowledged SELF-HARM lines since `since` (default 30 days), newest first (chat_tags' (tag, ts) index). */
export function pendingWellbeing(db: DatabaseSync, a: { since?: number; limit?: number; now?: number } = {}): WellbeingPending[] {
  const now = finite(a.now) ? a.now : Date.now();
  const since = finite(a.since) ? Math.floor(a.since) : now - PENDING_WELLBEING_DAYS * DAY;
  const limit = Math.max(1, Math.min(PENDING_WELLBEING_MAX, Math.floor(finite(a.limit) ? a.limit : PENDING_WELLBEING_MAX)));
  const rows = db.prepare(`SELECT c.id, c.ts, c.room_name, c.room_uid, c.channel FROM chat_tags t JOIN chat_log c ON c.id = t.chat_id
                            WHERE t.tag = 'SELF-HARM' AND t.ts >= ?
                              AND NOT EXISTS (SELECT 1 FROM wellbeing_acks w WHERE w.chat_id = t.chat_id)
                            ORDER BY t.ts DESC LIMIT ?`).all(since, limit) as Row[];
  return rows.map((r) => ({
    chatId: num(r.id), ts: num(r.ts), roomName: String(r.room_name ?? ''), roomUid: r.room_uid === null || r.room_uid === undefined ? null : String(r.room_uid),
    channel: String(r.channel ?? ''),
  }));
}

/** One logged line to find by what the game thread knew when it logged it (the alert's line, before its id is known). */
export interface LineMatch { ts: number; playerId: number; channel: string; accountId?: string | null; nameKey?: string | null }

/** At most this many lines per chat.locate call. */
export const LOCATE_MAX = 100;

/**
 * The chat_log ids of lines by (account or guest name key, ts, player, channel): one indexed point query each
 * (chat_log_account / chat_log_name are on (key, ts)). null = no such line (never written, dropped or purged).
 */
export function locateLines(db: DatabaseSync, lines: readonly LineMatch[]): (number | null)[] {
  const byAccount = db.prepare('SELECT id FROM chat_log WHERE account_id = ? AND ts = ? AND player_id = ? AND channel = ? ORDER BY id DESC LIMIT 1');
  const byName = db.prepare('SELECT id FROM chat_log WHERE name_key = ? AND ts = ? AND player_id = ? AND channel = ? AND account_id IS NULL ORDER BY id DESC LIMIT 1');
  return lines.map((l) => {
    const args: SQLInputValue[] = [Math.floor(l.ts), Math.floor(l.playerId) || 0, String(l.channel)];
    const r = l.accountId
      ? byAccount.get(l.accountId, ...args) as Row | undefined
      : typeof l.nameKey === 'string' ? byName.get(l.nameKey, ...args) as Row | undefined : undefined;
    return r ? num(r.id) : null;
  });
}

// ------------------------------------------------------------------------------------------
// Term retention: a term's purge still owed after its end date was replaced (§5.5)
// ------------------------------------------------------------------------------------------

/**
 * A term whose lines must still go: lines with ts < cut, at purgeAt (after the pre-purge backup). The service keeps
 * one when the host sets the next term's end date before the ending term was purged (the banners ask for it).
 */
export interface TermOwed { cut: number; purgeAt: number }

/** At most this many owed term purges are kept (mod_meta term_owed_cut_<i> / term_owed_at_<i>). */
export const TERM_OWED_MAX = 4;
const TERM_OWED_RE = /^term_owed_(cut|at)_(\d+)$/;

/** The owed term purges (mod_meta), oldest cut first. */
export function termOwedOf(db: DatabaseSync): TermOwed[] {
  const rows = db.prepare("SELECT k, v FROM mod_meta WHERE k GLOB 'term_owed_*'").all() as Row[];
  const slots = new Map<number, Partial<TermOwed>>();
  for (const r of rows) {
    const m = TERM_OWED_RE.exec(String(r.k));
    if (!m) continue;
    const i = Number(m[2]);
    const s = slots.get(i) ?? {};
    if (m[1] === 'cut') s.cut = num(r.v); else s.purgeAt = num(r.v);
    slots.set(i, s);
  }
  return [...slots.values()].filter((s): s is TermOwed => finite(s.cut) && finite(s.purgeAt)).sort((a, b) => a.cut - b.cut);
}

/** Replace the owed term purges (an empty list clears them). */
export function setTermOwed(db: DatabaseSync, list: readonly TermOwed[]): TermOwed[] {
  const clean = list.filter((p) => finite(p.cut) && finite(p.purgeAt)).map((p) => ({ cut: Math.floor(p.cut), purgeAt: Math.floor(p.purgeAt) }))
    .sort((a, b) => a.cut - b.cut).slice(-TERM_OWED_MAX);
  tx(db, () => {
    db.prepare("DELETE FROM mod_meta WHERE k GLOB 'term_owed_*'").run();
    clean.forEach((p, i) => {
      setMeta(db, `term_owed_cut_${i}`, p.cut);
      setMeta(db, `term_owed_at_${i}`, p.purgeAt);
    });
  });
  return clean;
}

/** Acknowledge one wellbeing line (wellbeing_acks; the first acknowledgement is kept). */
export function ackWellbeing(db: DatabaseSync, a: { chatId: number; by: string; note?: string | null; at?: number }): { acked: boolean; already: boolean; exists: boolean } {
  const id = Math.floor(a.chatId);
  if (!Number.isInteger(id)) throw new MaintError('EARGS', 'wellbeing.ack needs the line id.');
  if (!db.prepare('SELECT 1 FROM chat_log WHERE id = ?').get(id)) return { acked: false, already: false, exists: false };
  const at = finite(a.at) ? Math.floor(a.at) : Date.now();
  const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, 500) : null;
  const n = num(db.prepare('INSERT INTO wellbeing_acks (chat_id, acked_at, acked_by, note) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO NOTHING')
    .run(id, at, String(a.by ?? '').slice(0, 64) || 'host', note).changes);
  return { acked: n === 1, already: n === 0, exists: true };
}

// ------------------------------------------------------------------------------------------
// The worker ops
// ------------------------------------------------------------------------------------------

const obj = (a: unknown): Record<string, unknown> => (a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {});
const needTime = (v: unknown, what: string): number => {
  if (!finite(v)) throw new MaintError('EARGS', `${what} must be a time (epoch ms).`);
  return Math.floor(v);
};
const optAccount = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 64) throw new MaintError('EARGS', 'accountId must be an account id.');
  return v;
};
const optChunk = (v: unknown): number | undefined => (finite(v) ? Math.max(1, Math.min(5000, Math.floor(v))) : undefined);
const writeOpts = (a: Record<string, unknown>, ctx: OpContext): WriteOptions => ({
  chunk: optChunk(a.chunk), signal: ctx.signal, progress: (done) => ctx.progress({ done }),
});

export const WRITE_OPS: OpTable = {
  'purge.count': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      const before = needTime(o.before, 'before');
      const accountId = optAccount(o.accountId);
      return { rows: purgeCount(ctx.read(), { before, accountId }), before, accountId };
    },
  },
  'purge.chat': {
    kind: 'write',
    run: async (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      const before = needTime(o.before, 'before');
      const by = typeof o.by === 'string' && o.by ? o.by.slice(0, 64) : 'host';
      const lineage = ctx.config.backupKey ? nativeLineage(ctx.config.backupKey) : null;
      const r = await purgeChat(ctx.write(), ctx.dataDir, { before, accountId: optAccount(o.accountId), by, ts: finite(o.ts) ? o.ts : undefined }, { ...writeOpts(o, ctx), lineage });
      clearStatsCache(ctx.dbPath);
      return {
        deleted: r.chat, conductRows: r.conductRows, reportsUpdated: r.reportsUpdated, reportCopies: r.reportCopies,
        ledger: { ts: r.entry.ts, before: r.entry.before ?? null, accountId: r.entry.accountId ?? null },
      };
    },
  },
  'retention.chat': {
    kind: 'write',
    run: async (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      const r = await retentionChat(ctx.write(), { before: needTime(o.before, 'before') }, writeOpts(o, ctx));
      if (r.deleted) clearStatsCache(ctx.dbPath);
      return r;
    },
  },
  'retention.records': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      return pruneRecords(ctx.write(), {
        keepBefore: needTime(o.keepBefore, 'keepBefore'), deviceChecksBefore: finite(o.deviceChecksBefore) ? o.deviceChecksBefore : undefined,
      }, writeOpts(o, ctx));
    },
  },
  'retention.addresses': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      return minimiseAddresses(ctx.write(), { before: needTime(o.before, 'before'), pepper: ctx.config.pepper ?? null, full: o.full === true }, writeOpts(o, ctx));
    },
  },
  'wellbeing.clear': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      return clearWellbeingOriginals(ctx.write(), { before: needTime(o.before, 'before') }, writeOpts(o, ctx));
    },
  },
  'wellbeing.pending': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      return { lines: pendingWellbeing(ctx.read(), { since: finite(o.since) ? o.since : undefined, limit: finite(o.limit) ? o.limit : undefined }) };
    },
  },
  'wellbeing.ack': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      if (!finite(o.chatId)) throw new MaintError('EARGS', 'wellbeing.ack needs the line id (chatId).');
      return ackWellbeing(ctx.write(), {
        chatId: o.chatId, by: typeof o.by === 'string' ? o.by : 'host', note: typeof o.note === 'string' ? o.note : null, at: finite(o.at) ? o.at : undefined,
      });
    },
  },
  'chat.locate': {
    kind: 'read',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      if (!Array.isArray(o.lines) || o.lines.length > LOCATE_MAX) throw new MaintError('EARGS', `chat.locate needs 0 to ${LOCATE_MAX} lines.`);
      const lines: LineMatch[] = o.lines.map((x: unknown) => {
        const l = obj(x);
        if (!finite(l.ts) || typeof l.channel !== 'string') throw new MaintError('EARGS', 'chat.locate: each line needs ts and channel.');
        return {
          ts: l.ts, playerId: finite(l.playerId) ? l.playerId : 0, channel: l.channel.slice(0, 16),
          accountId: typeof l.accountId === 'string' && l.accountId ? l.accountId.slice(0, 64) : null,
          nameKey: typeof l.nameKey === 'string' ? l.nameKey.slice(0, 64) : null,
        };
      });
      return { ids: locateLines(ctx.read(), lines) };
    },
  },
  'retention.term.get': {
    kind: 'read',
    run: (_a: unknown, ctx: OpContext) => ({ owed: termOwedOf(ctx.read()) }),
  },
  'retention.term.set': {
    kind: 'write',
    run: (a: unknown, ctx: OpContext) => {
      const o = obj(a);
      if (!Array.isArray(o.owed) || o.owed.length > TERM_OWED_MAX) throw new MaintError('EARGS', `retention.term.set needs 0 to ${TERM_OWED_MAX} owed purges.`);
      const list = o.owed.map((x: unknown) => {
        const p = obj(x);
        return { cut: needTime(p.cut, 'cut'), purgeAt: needTime(p.purgeAt, 'purgeAt') };
      });
      return { owed: setTermOwed(ctx.write(), list) };
    },
  },
};
