// OWNER: SERVER MODERATION. SQLite persistence for moderation: the chat log, the moderation audit trail (mod_actions),
// bans / mutes, player reports and moderator accounts. The tables live in the auth DB file (MIGRATIONS[2] and, v0.6,
// MIGRATIONS[3] in ../auth/store.ts); this store opens its OWN connection on that file, after AuthStore has migrated
// it, protected like every connection (db/guard.ts: trusted_schema OFF, the authorizer, secure_delete and
// foreign_keys ON). The CLI (./cli.ts) opens one too, while the server runs (WAL: readers and one writer at a time).
//
// Chat lines are buffered in memory (logChat is O(1) and never touches the disk) and written in small transactions
// by flush(), which the ModerationService calls from a timer — never from inside a game tick. Audit rows (addAction)
// are written at once but never wait for the lock either (§5.16): while another writer holds it (a worker chunk, a
// merge step) they queue in memory, in order, and the next flush() writes them first. Ban / report / moderator writes
// take `noWait` for game-thread callers (fail fast with SQLITE_BUSY: "try again"). v0.6 (LAN edition,
// docs/LAN-EDITION-proposal.md §5.7, §5.8, §6.4, §6.6): each row also stores room_uid and display; its tags go to
// chat_tags and the per-student day counters to conduct_daily in the same transaction (the rules are
// maint/queries.ts conductTagsOf); the FTS5 trigram index follows through the chat_log triggers. Reports keep the
// chat ids plus SHOWN-ONLY copies of the lines (auth/store.ts reportChatCopy): never the original text, an address
// or the hit labels.
//
// FTS merges: FTS5 merges its index b-trees inside the commit that crosses its work threshold, and on a grown index
// (no optimize for weeks: 'forever' retention, the first 90 days) that cost 20-45 ms in a 1-line game-thread commit.
// With the maintenance worker running (GAME_THREAD_STORE_OPTIONS: ftsMerge 'worker') this connection turns FTS5's
// automerge off and the worker merges in small steps every second (maint/queries.ts ftsMergeSteps, 'wal.checkpoint');
// without it, ftsMerge 'inline' keeps FTS5's own defaults. The setting lives in the database (chat_fts_config), so it
// is written only where the §6.5 guard treats it as tunable (ftsMergeTunable): see there.
//
// On the game thread this store runs only small indexed point queries (§5.16, T-PERF-2: ban checks, /log, /whois,
// the report snapshot, each LIMITed and bounded to one person's newest lines). Every panel read (log search,
// context, rooms, stats, conduct, exports) runs in the maintenance worker (maint/queries.ts QUERY_OPS). searchLog /
// exportLog remain for the CLI (its own process) and share that module's planner.
import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { tagsOf, type ChatAction, type ChatDisplay, type ChatLogEntry } from '../../shared/room/moderation';
import { nameKey } from '../../shared/room/util';
import { REPORT_MAX_LINES, reportChatCopy, SCHEMA_V4, SCHEMA_VERSION } from '../auth/store';
import { ftsConfigSnapshot, openProtectedDb } from '../db/guard';
import { dayOf, markIndexDirty } from '../maint/erase';
import {
  CHAT_ACTIONS, chatRowOf, conductKeyOf, conductTagsOf, displayOf, eachChatLogPageSync, isWellbeingRow, measureTsDisorder, searchChatLog,
  TS_DISORDER_KEY, tsDisorderOf, type ChatLogRow, type LogQuery,
} from '../maint/queries';

export { CHAT_ACTIONS, chatRowOf, type ChatLogRow, type LogQuery };

/** First auth schema version this store works on (v0.6: room_uid, display, chat_tags, conduct_daily; MIGRATIONS[3]). */
export const MOD_SCHEMA_MIN = SCHEMA_V4;
/** Rows one flush() call writes. */
export const DEFAULT_BATCH_ROWS = 50;
/**
 * The game server's chat-log settings once the maintenance worker checkpoints and merges (QUERY_OPS
 * 'wal.checkpoint' every second or so): this connection never checkpoints, never merges the FTS index (ftsMerge
 * 'worker': automerge off, where ftsMergeTunable), one line per transaction, a flush call stops after ~3 ms (the rest
 * waits for the next call). Measured (maint/queries.perf.test.ts): at 1M lines on an optimized index, 1-line writes
 * p99 < 0.6 ms and a 50-line burst's flush call p99 ~3.9 ms; on a 250k-line index grown line by line (no optimize),
 * every flush call max ~3.3 ms, where FTS5's own automerge made p99 23 ms. Without the worker use
 * INLINE_STORE_OPTIONS (SQLite checkpoints and FTS5 merges on this connection). Where the merge settings are not
 * tunable the index should get one 'optimize' after the v4 migration's 'rebuild' (the start-up tidy): before it,
 * FTS5's merges inside these commits took up to ~110 ms at 1M lines.
 */
export const GAME_THREAD_STORE_OPTIONS: Readonly<Pick<ModStoreOptions, 'walAutoCheckpoint' | 'txRows' | 'flushBudgetMs' | 'ftsMerge'>> = Object.freeze({
  walAutoCheckpoint: 0, txRows: 1, flushBudgetMs: 3, ftsMerge: 'worker',
});
/**
 * The game server's chat-log settings WITHOUT the maintenance worker (or once it failed): SQLite checkpoints on this
 * connection and FTS5 merges inside its commits, as before 0.6 (FTS5's defaults restored if a worker run changed them).
 * A store opened with GAME_THREAD_STORE_OPTIONS whose worker stops switches over at run time:
 * `setWalAutoCheckpoint(1000)` and `setFtsMerge('inline')` (and back: 0 and 'worker').
 */
export const INLINE_STORE_OPTIONS: Readonly<Pick<ModStoreOptions, 'ftsMerge'>> = Object.freeze({ ftsMerge: 'inline' });

/**
 * Where FTS5's index merges run: 'worker' = never inside this connection's commits (automerge 0; the maintenance
 * worker merges: QUERY_OPS 'wal.checkpoint' / 'fts.merge'), 'inline' = FTS5's defaults (automerge inside the commits).
 */
export type FtsMergeMode = 'worker' | 'inline';
/**
 * The FTS5 settings of each mode. 'worker' keeps a high crisismerge as the safety valve (a level of 64 segments is
 * merged inside the commit) for a worker that falls behind; 'inline' = FTS5's documented defaults.
 */
export const FTS_MERGE_SETTINGS: Readonly<Record<FtsMergeMode, Readonly<{ automerge: number; crisismerge: number }>>> = Object.freeze({
  worker: Object.freeze({ automerge: 0, crisismerge: 64 }),
  inline: Object.freeze({ automerge: 4, crisismerge: 16 }),
});
const FTS_DEFAULTS = FTS_MERGE_SETTINGS.inline;

let tunableCache: boolean | null = null;
/**
 * Whether this build's §6.5 guard (db/guard.ts ftsConfigSnapshot, which restores and imports compare with what the
 * migrations set) leaves the FTS merge settings out of that comparison. Only then may they be changed: otherwise a
 * backup taken with automerge 0 would be refused at restore as "changed fts settings". Probed once on a private
 * in-memory FTS5 table.
 */
export function ftsMergeTunable(): boolean {
  if (tunableCache !== null) return tunableCache;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(x, tokenize='trigram')");
    db.exec(`INSERT INTO probe(probe, rank) VALUES('automerge', ${FTS_MERGE_SETTINGS.worker.automerge})`);
    db.exec(`INSERT INTO probe(probe, rank) VALUES('crisismerge', ${FTS_MERGE_SETTINGS.worker.crisismerge})`);
    const snap = ftsConfigSnapshot(db).get('probe_config');
    tunableCache = typeof snap === 'string' && !/automerge|crisismerge/.test(snap);
  } catch {
    tunableCache = false;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
  return tunableCache;
}

/** SQLITE_BUSY / SQLITE_LOCKED (another connection holds the write lock): the rows stay buffered, it is not a failure. */
export function isBusyError(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof code === 'number') return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /database is locked|database table is locked/i.test(String((e as Error)?.message ?? ''));
}
/** close() waits this long for another writer (a maintenance-worker chunk, a Stop-time optimize) before giving up. */
export const CLOSE_WAIT_MS = 10_000;
/** Chat lines held in memory while the DB is busy; beyond this the oldest are dropped (and counted). */
export const DEFAULT_MAX_BUFFERED = 20_000;
/**
 * Audit rows held in memory while the DB is busy (addAction never waits for the lock); beyond this the oldest are
 * dropped and counted (droppedActions) — only a database unavailable for hours of moderator clicks gets there.
 */
export const MAX_BUFFERED_ACTIONS = 5_000;
/**
 * Rows deleted per prune step (pruneStep's default; the size of the maintenance worker's chunked deletes). Each deleted
 * line also writes its FTS 'delete' entries and cascades to its tags, so a step costs far more than §5.16's 1.5 ms for
 * 250 plain rows. Measured at 1M lines (optimized index), 250-row steps on one connection: p50 6-39 ms and worst
 * ~170 ms with SQLite's own checkpoints; p50 ~20 ms and worst ~53 ms with walAutoCheckpoint 0; 100-row steps with
 * walAutoCheckpoint 0 worst ~16 ms. So retention pruning on the game thread cannot meet T-PERF-2 at 1M lines: it
 * belongs in the worker's chunked writes (§5.16). While it still runs here, use at most 100 rows per step with
 * GAME_THREAD_STORE_OPTIONS.
 */
export const PRUNE_CHUNK = 250;
/** Text columns are clamped to this many characters (chat lines are ≤ 200 already). */
const MAX_TEXT = 1000;
/**
 * A pilot's newest lines scanned for their addresses (whois): bounds the game-thread cost for a pilot with a huge
 * history (it is "addresses seen lately", most recent first).
 */
export const ADDRESS_SCAN_ROWS = 200;
/** A guest's lines by callsign + address come from the callsign's newest this-many lines (recentChat). */
export const RECENT_SCAN_ROWS = 200;
/**
 * Audit rows matched by NAME (a guest's whois history; there is no index on the lower-cased name) come from the
 * newest this-many audit rows only. Account and address matches use their indexes and have no such bound.
 */
export const ACTIONS_NAME_SCAN = 20_000;

export type BanKind = 'ban' | 'mute';
export type BanScope = 'account' | 'address' | 'guest';
export type ReportStatus = 'open' | 'reviewed' | 'dismissed';
export type ModActionKind = 'ban' | 'unban' | 'mute' | 'unmute' | 'kick' | 'warn' | 'note' | 'promote' | 'demote'
  // v0.6 (§6.6; mod_actions.action has no CHECK, so older servers read these as they are)
  | 'settings' | 'setup' | 'login' | 'login-fail' | 'logout' | 'reauth' | 'reveal' | 'view' | 'export' | 'purge' | 'announce'
  | 'terms' | 'wellbeing-ack' | 'backup' | 'restore' | 'recovery';

export const REPORT_STATUSES: readonly ReportStatus[] = ['open', 'reviewed', 'dismissed'];
/** Longest hit label kept in the log ("flag:<category ≤ 24>:<term ≤ 64>" fits). */
const MAX_HIT_LABEL = 128;
/** Longest room uid kept (`<bootId>:<roomId>`). */
const MAX_ROOM_UID = 80;

/**
 * The lines the filter acted on (masked, blocked, repeat flood, sent while muted): not 'pass', and not 'flag' either —
 * a review-only line was shown as typed and is never a strike, so it must not count against a pilot.
 */
const ACTED_SQL = "action NOT IN ('pass', 'flag')";

export interface BanRow {
  id: number;
  kind: BanKind; scope: BanScope;
  accountId: string | null; username: string | null; address: string | null;
  createdAt: number; expiresAt: number | null; revokedAt: number | null;
  reason: string; by: string;
  /** not revoked and not expired (as of the read) */
  active: boolean;
}

export interface NewBan {
  kind: BanKind; scope: BanScope;
  accountId: string | null; username: string | null; address: string | null;
  createdAt: number; expiresAt: number | null;
  reason: string; by: string;
}

export interface ActionRow {
  id: number; ts: number;
  actor: string; actorAccountId: string | null;
  action: ModActionKind;
  targetAccountId: string | null; targetName: string | null; targetAddress: string | null;
  durationSec: number | null; expiresAt: number | null;
  reason: string;
}

export interface NewAction {
  ts: number;
  /** account id of the moderator, or 'cli' / 'system' */
  actorAccountId: string;
  actorName: string;
  action: ModActionKind;
  targetAccountId?: string | null; targetName?: string | null; targetAddress?: string | null;
  durationSec?: number | null; expiresAt?: number | null;
  reason: string;
}

export interface Party { playerId: number | null; name: string; accountId: string | null; address: string | null }

export interface ReportRow {
  id: number; ts: number;
  status: ReportStatus;
  reason: string; room: string;
  reporter: Party; target: Party;
  /**
   * The saved lines, oldest first, as SHOWN-ONLY copies (§6.4): `original` is '', `address` null and `hits` empty;
   * `shown` and `display` say what the others saw. Rows from before 0.6.0 were rewritten so by the v4 backfill.
   */
  recentChat: ChatLogRow[];
  /** the chat_log ids of those lines (a purge or deletion removes its lines' copies) */
  recentIds: number[];
  reviewedBy: string | null; reviewedAt: number | null; note: string | null;
}

export interface NewReport { ts: number; reporter: Party; target: Party; reason: string; room: string; recentChat: ChatLogRow[] }

export interface AccountLite { id: string; username: string; createdAt: number; lastLogin: number | null }

/** Who a chat-log lookup is about (at least one field). */
export interface ChatIdent { accountId?: string | null; nameKey?: string | null; address?: string | null }

export interface PruneCutoffs {
  /** chat_log rows older than this go */
  chatBefore: number;
  /** mod_actions / reports older than this go; bans that ended before it go; conduct counters of days before it go */
  keepBefore: number;
}

export interface ModStoreOptions {
  /** Default: console.log. */
  log?: (line: string) => void;
  /**
   * busy_timeout of this connection (ms). The game server keeps it short — its flushes run on the thread the game
   * tick shares, and a busy DB just means the rows stay buffered until the next flush. The CLI can wait longer.
   */
  busyTimeoutMs?: number;
  /** Rows one flush() call writes (default DEFAULT_BATCH_ROWS). */
  batchRows?: number;
  /**
   * Rows per insert transaction inside a flush (default: batchRows, one transaction per flush call). Every commit
   * feeds the FTS index its own small segment: measured at 1M rows, 1-row commits stay at p99 ~1 ms / max ~4 ms,
   * while 20- to 50-row commits reach 50-90 ms whenever FTS5's automerge runs inside them (on the game thread). One
   * row per commit writes about 3× the WAL, so use 1 together with walAutoCheckpoint 0 (GAME_THREAD_STORE_OPTIONS).
   */
  txRows?: number;
  /**
   * A flush stops after about this many ms and leaves the rest buffered for the next call (the caller's flush loop
   * continues on a later turn). Default: no limit (one call writes its whole batch).
   */
  flushBudgetMs?: number;
  /**
   * PRAGMA wal_autocheckpoint of this connection. 0 = this connection never checkpoints: the maintenance worker's
   * 'wal.checkpoint' op does (measured at 1M rows: an autocheckpoint inside a game-thread commit costs 100-145 ms
   * on Windows, the fsync of the whole file). Default: SQLite's own (1000 pages), for a server without the worker.
   */
  walAutoCheckpoint?: number;
  maxBuffered?: number;
  /**
   * Where FTS5 merges its index (FtsMergeMode), set in the database at open when it differs (and only where
   * ftsMergeTunable()). Default: leave it as it is (the CLI, tests): the game server passes 'worker' with the
   * maintenance worker (GAME_THREAD_STORE_OPTIONS) and 'inline' without it (INLINE_STORE_OPTIONS).
   */
  ftsMerge?: FtsMergeMode;
  /** Tests only: override ftsMergeTunable() (a scratch database no restore will ever check). */
  ftsTunable?: boolean;
  /** How long close() waits for the write lock to write the last buffered lines (default CLOSE_WAIT_MS). */
  closeWaitMs?: number;
}

type Row = Record<string, unknown>;

const n = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));
const sOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const clampText = (s: unknown, max = MAX_TEXT): string => String(s ?? '').slice(0, max);

function banRowOf(r: Row, now: number): BanRow {
  const expiresAt = nOrNull(r.expires_at);
  const revokedAt = nOrNull(r.revoked_at);
  return {
    id: n(r.id), kind: String(r.kind) as BanKind, scope: String(r.scope) as BanScope,
    accountId: sOrNull(r.account_id), username: sOrNull(r.username), address: sOrNull(r.address_prefix),
    createdAt: n(r.created_at), expiresAt, revokedAt, reason: String(r.reason ?? ''), by: String(r.by ?? ''),
    active: revokedAt === null && (expiresAt === null || expiresAt > now),
  };
}

function actionRowOf(r: Row): ActionRow {
  const actorId = String(r.actor_account_id ?? '');
  const system = actorId === 'cli' || actorId === 'system';
  return {
    id: n(r.id), ts: n(r.ts), actor: String(r.actor_name || actorId), actorAccountId: system ? null : actorId,
    action: String(r.action) as ModActionKind, targetAccountId: sOrNull(r.target_account_id),
    targetName: sOrNull(r.target_name), targetAddress: sOrNull(r.target_address),
    durationSec: nOrNull(r.duration_sec), expiresAt: nOrNull(r.expires_at), reason: String(r.reason ?? ''),
  };
}

const str = (v: unknown, dflt = ''): string => (typeof v === 'string' ? v : dflt);
const int = (v: unknown, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** A saved report line (a shown-only copy) as a ChatLogRow: never an original, an address or hit labels. */
export function reportLineOf(v: unknown): ChatLogRow | null {
  const c = reportChatCopy(v) as Record<string, unknown> | null;
  if (!c) return null;
  return {
    id: int(c.id), ts: int(c.ts), roomId: typeof c.roomId === 'string' ? c.roomId : null, roomUid: typeof c.roomUid === 'string' ? c.roomUid : null,
    roomName: str(c.roomName), channel: str(c.channel, 'all') as ChatLogRow['channel'], team: int(c.team, -1), playerId: int(c.playerId),
    name: str(c.name), accountId: typeof c.accountId === 'string' ? c.accountId : null, address: null, original: '',
    shown: str(c.shown), action: ((CHAT_ACTIONS as readonly unknown[]).includes(c.action) ? c.action : 'pass') as ChatAction,
    hits: [], display: displayOf(c.display), tags: [],
  };
}

function reportRowOf(r: Row): ReportRow {
  let recentChat: ChatLogRow[] = [];
  try {
    const a = JSON.parse(String(r.recent_chat_json ?? '[]')) as unknown;
    if (Array.isArray(a)) recentChat = a.map(reportLineOf).filter((x): x is ChatLogRow => x !== null);
  } catch { recentChat = []; }
  let recentIds: number[] = [];
  try {
    const a = JSON.parse(String(r.recent_ids ?? '[]')) as unknown;
    if (Array.isArray(a)) recentIds = a.filter((x): x is number => Number.isInteger(x));
  } catch { recentIds = []; }
  return {
    id: n(r.id), ts: n(r.ts), status: String(r.status) as ReportStatus, reason: String(r.reason ?? ''),
    room: String(r.room ?? ''),
    reporter: {
      playerId: nOrNull(r.reporter_player_id), name: String(r.reporter_name ?? ''),
      accountId: sOrNull(r.reporter_account_id), address: sOrNull(r.reporter_address),
    },
    target: {
      playerId: nOrNull(r.target_player_id), name: String(r.target_name ?? ''),
      accountId: sOrNull(r.target_account_id), address: sOrNull(r.target_address),
    },
    recentChat, recentIds, reviewedBy: sOrNull(r.reviewed_by), reviewedAt: nOrNull(r.reviewed_at), note: sOrNull(r.note),
  };
}

const clampLimit = (v: unknown, dflt: number, max: number): number => {
  const x = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(1, Math.min(max, x));
};

/**
 * A SELF-HARM (wellbeing) line (as a caller hands it on: a ChatLogRow, or anything shaped like one) whose report copy
 * could not say so: every such line except a withheld one. A copy keeps `display` but no tags or hit labels, so a
 * withheld line stays recognisable (the admin API hands it to `wellbeing` principals only), while a review-only
 * self-harm line (shown as typed) or a pre-0.6 one (hit labels only) would look like any other line.
 */
function isUnmarkableWellbeingLine(l: unknown): boolean {
  if (!l || typeof l !== 'object') return false;
  const o = l as Record<string, unknown>;
  const display = displayOf(o.display);
  if (display === 'withheld') return false;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return isWellbeingRow({ display, tags: strs(o.tags) as ChatLogRow['tags'], hits: strs(o.hits) });
}

export class ModStore {
  private readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private readonly log: (line: string) => void;
  private readonly batchRows: number;
  private readonly txRows: number;
  private readonly flushBudgetMs: number;
  private readonly maxBuffered: number;
  private readonly busyTimeoutMs: number;
  private readonly closeWaitMs: number;
  private readonly ftsTunable: boolean;
  private buf: ChatLogEntry[] = [];
  /**
   * Audit rows (insertAction arguments, normalised) the lock kept out: addAction never waits for another writer
   * (§5.16), so they wait here, in order, and the next addAction / flush() / close() writes them first.
   */
  private auditBuf: SQLInputValue[][] = [];
  /** The FTS merge mode last asked for (setFtsMerge), and whether it still has to be written (the lock was busy). */
  private ftsMergeWanted: FtsMergeMode | null = null;
  private ftsMergeRetry = false;
  private closed = false;
  /** mod_meta.ts_disorder as this connection last wrote or read it (maint/queries.ts TS_DISORDER_KEY). */
  private disorder = 0;
  /**
   * The measured disorder is not in the database yet (the lock was busy at open): the next flush writes it first. Until
   * then the worker, finding no key, reads a date search's whole id range (exact, only slower).
   */
  private disorderUnsaved = false;
  /** Chat lines dropped because the buffer overflowed (DB unavailable for a long time). */
  dropped = 0;
  /** Audit rows dropped because their queue overflowed (MAX_BUFFERED_ACTIONS; the DB unavailable for a long time). */
  droppedActions = 0;
  /**
   * Since when the chat-log writes have found the database locked by another writer (null = the last flush wrote):
   * a lock held for a few ms (a worker chunk, a merge step, a checkpoint) is normal; a long one is not.
   */
  busySince: number | null = null;

  constructor(dbPath: string, opts: ModStoreOptions = {}) {
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.batchRows = Math.max(1, Math.floor(opts.batchRows ?? DEFAULT_BATCH_ROWS));
    this.txRows = Math.max(1, Math.floor(opts.txRows ?? this.batchRows));
    this.flushBudgetMs = typeof opts.flushBudgetMs === 'number' && opts.flushBudgetMs > 0 ? opts.flushBudgetMs : Infinity;
    this.maxBuffered = Math.max(this.batchRows, Math.floor(opts.maxBuffered ?? DEFAULT_MAX_BUFFERED));
    this.busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
    this.closeWaitMs = Math.max(this.busyTimeoutMs, Math.floor(opts.closeWaitMs ?? CLOSE_WAIT_MS));
    this.ftsTunable = opts.ftsTunable ?? ftsMergeTunable();
    if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) {
      throw new Error(`[mod] no database at ${dbPath || '(none)'} — construct the AuthService first (it creates and migrates the file)`);
    }
    // WAL, synchronous NORMAL, foreign_keys and secure_delete ON, busy_timeout; protected before any other statement.
    const db = openProtectedDb(dbPath, { busyTimeoutMs: this.busyTimeoutMs });
    try {
      if (typeof opts.walAutoCheckpoint === 'number' && Number.isFinite(opts.walAutoCheckpoint)) {
        db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.floor(opts.walAutoCheckpoint))}`);
      }
      const version = n((db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version);
      if (version < SCHEMA_V4 - 1) throw new Error(`[mod] auth DB schema v${version} has no moderation tables (need v${MOD_SCHEMA_MIN}) — construct the AuthService first`);
      if (version < MOD_SCHEMA_MIN) throw new Error(`[mod] auth DB schema v${version} has not been upgraded to v${MOD_SCHEMA_MIN} (the LAN-edition chat tables) — construct the AuthService first`);
      if (version > SCHEMA_VERSION) throw new Error(`[mod] auth DB schema v${version} is newer than this server understands (v${SCHEMA_VERSION})`);
      // The clock disorder date searches rely on (maint/queries.ts idRangeOf): measured once for a database that has
      // none (the lines a v0.5 server wrote; a read, ~0.35 s at 1M), then kept up to date by every insert below.
      const d = tsDisorderOf(db);
      if (d === null) {
        this.disorder = measureTsDisorder(db);
        this.disorderUnsaved = true;
      } else this.disorder = d;
    } catch (e) {
      try { db.close(); } catch { /* already closed */ }
      throw e;
    }
    this.db = db;
    const p = (sql: string): StatementSync => db.prepare(sql);
    this.st = {
      insertChat: p(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address,
                       original, shown, action, hits, room_uid, display) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertTag: p('INSERT OR IGNORE INTO chat_tags (chat_id, tag, ts, account_id) VALUES (?, ?, ?, ?)'),
      // the newest time logged so far (the ts index's last entry), for the clock disorder
      maxTs: p('SELECT max(ts) AS m FROM chat_log'),
      raiseDisorder: p('INSERT INTO mod_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = max(v, excluded.v)'),
      ftsSettings: p("SELECT k, v FROM chat_fts_config WHERE k IN ('automerge', 'crisismerge')"),
      countConduct: p(`INSERT INTO conduct_daily (account_key, day, tag, n) VALUES (?, ?, ?, 1)
                         ON CONFLICT (account_key, day, tag) DO UPDATE SET n = n + 1`),
      // Newest first in the (x, ts) index's own order (no sort of a long history), then oldest first for the reader.
      chatByAccount: p('SELECT * FROM chat_log WHERE account_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
      chatByName: p('SELECT * FROM chat_log WHERE name_key = ? ORDER BY ts DESC, id DESC LIMIT ?'),
      // A guest (callsign + address): among the callsign's newest RECENT_SCAN_ROWS lines (the address is not indexed
      // with the name, so an address the callsign never used would otherwise walk its whole history).
      chatByNameAddr: p(`SELECT * FROM (SELECT * FROM chat_log WHERE name_key = ? ORDER BY ts DESC, id DESC LIMIT ${RECENT_SCAN_ROWS})
                          WHERE address = ? ORDER BY ts DESC, id DESC LIMIT ?`),
      chatByAddress: p('SELECT * FROM chat_log WHERE address = ? ORDER BY ts DESC, id DESC LIMIT ?'),
      lastByName: p('SELECT * FROM chat_log WHERE name_key = ? ORDER BY ts DESC, id DESC LIMIT 1'),
      addrsByAccount: p(`SELECT address, MAX(ts) AS t FROM (SELECT address, ts FROM chat_log WHERE account_id = ? ORDER BY ts DESC, id DESC LIMIT ?)
                          WHERE address IS NOT NULL GROUP BY address ORDER BY t DESC LIMIT 10`),
      addrsByName: p(`SELECT address, MAX(ts) AS t FROM (SELECT address, ts, account_id FROM chat_log WHERE name_key = ? ORDER BY ts DESC, id DESC LIMIT ?)
                       WHERE account_id IS NULL AND address IS NOT NULL GROUP BY address ORDER BY t DESC LIMIT 10`),
      flaggedByAccount: p(`SELECT COUNT(*) AS n FROM chat_log WHERE account_id = ? AND ${ACTED_SQL} AND ts >= ?`),
      flaggedByName: p(`SELECT COUNT(*) AS n FROM chat_log WHERE name_key = ? AND account_id IS NULL AND ${ACTED_SQL} AND ts >= ?`),
      insertAction: p(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name,
                         target_address, duration_sec, expires_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      maxActionId: p('SELECT max(id) AS m FROM mod_actions'),
      // listActions: the whole trail in id order; a target's rows in its (x, ts) index's own order, (ts, id) keyset
      actionsAll: p('SELECT * FROM mod_actions ORDER BY id DESC LIMIT ?'),
      actionsAllBefore: p('SELECT * FROM mod_actions WHERE id < ? ORDER BY id DESC LIMIT ?'),
      actionTs: p('SELECT ts FROM mod_actions WHERE id = ?'),
      actionTsBelow: p('SELECT ts FROM mod_actions WHERE id < ? ORDER BY id DESC LIMIT 1'),
      actionsByAccount: p(`SELECT * FROM mod_actions INDEXED BY mod_actions_target WHERE target_account_id = ? AND (ts, id) < (?, ?)
                            ORDER BY ts DESC, id DESC LIMIT ?`),
      actionsByAddress: p(`SELECT * FROM mod_actions INDEXED BY mod_actions_address WHERE target_address = ? AND (ts, id) < (?, ?)
                            ORDER BY ts DESC, id DESC LIMIT ?`),
      // NOT INDEXED: the rowid range (the newest ACTIONS_NAME_SCAN rows) drives, never a walk down the ts index.
      // COLLATE NOCASE = SQLite's lower() (ASCII case folding) without a string per row: ~2.5x faster over the scan.
      actionsByName: p(`SELECT * FROM mod_actions NOT INDEXED WHERE id > ? AND target_name = ? COLLATE NOCASE AND (ts, id) < (?, ?)
                         ORDER BY ts DESC, id DESC LIMIT ?`),
      insertBan: p(`INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, expires_at, reason, by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getBan: p('SELECT * FROM bans WHERE id = ?'),
      revokeBan: p('UPDATE bans SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
      liveBans: p('SELECT * FROM bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id'),
      insertReport: p(`INSERT INTO reports (ts, reporter_player_id, reporter_name, reporter_account_id, reporter_address,
                         target_player_id, target_name, target_account_id, target_address, reason, room, recent_chat_json, recent_ids, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`),
      getReport: p('SELECT * FROM reports WHERE id = ?'),
      reviewReport: p('UPDATE reports SET status = ?, reviewed_by = ?, reviewed_at = ?, note = COALESCE(?, note) WHERE id = ?'),
      adminIds: p('SELECT account_id FROM admins'),
      listAdmins: p(`SELECT a.account_id, a.added_at, a.added_by, c.username FROM admins a
                       LEFT JOIN accounts c ON c.id = a.account_id ORDER BY c.username_lower`),
      addAdmin: p('INSERT OR IGNORE INTO admins (account_id, added_at, added_by) VALUES (?, ?, ?)'),
      removeAdmin: p('DELETE FROM admins WHERE account_id = ?'),
      accountByLower: p('SELECT id, username, created_at, last_login FROM accounts WHERE username_lower = ?'),
      accountById: p('SELECT id, username, created_at, last_login FROM accounts WHERE id = ?'),
      rev: p("SELECT v FROM mod_meta WHERE k = 'rev'"),
      bumpRev: p("UPDATE mod_meta SET v = v + 1 WHERE k = 'rev'"),
      pruneChat: p('DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE ts < ? ORDER BY id LIMIT ?)'),
      pruneActions: p('DELETE FROM mod_actions WHERE id IN (SELECT id FROM mod_actions WHERE ts < ? ORDER BY id LIMIT ?)'),
      pruneReports: p('DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE ts < ? ORDER BY id LIMIT ?)'),
      pruneBans: p(`DELETE FROM bans WHERE id IN (SELECT id FROM bans WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
                      OR (revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?) ORDER BY id LIMIT ?)`),
      // conduct_daily is WITHOUT ROWID: its key is (account_key, day, tag).
      pruneConduct: p(`DELETE FROM conduct_daily WHERE (account_key, day, tag) IN
                         (SELECT account_key, day, tag FROM conduct_daily WHERE day < ? LIMIT ?)`),
    };
    if (this.disorderUnsaved) {
      // Another writer holding the lock (the worker's start-up tidy) must not fail the open: the next flush saves it.
      try { this.st.raiseDisorder!.run(TS_DISORDER_KEY, this.disorder); this.disorderUnsaved = false; } catch { /* busy */ }
    }
    if (opts.ftsMerge) {
      const r = this.setFtsMerge(opts.ftsMerge);
      if (!r.ok) {
        this.log(r.pending
          ? `[mod] FTS index merges: '${opts.ftsMerge}' is not set yet (${r.reason}); every chat-log write tries again first`
          : `[mod] FTS index merges stay inside the chat-log commits: ${r.reason}`);
      }
    }
  }

  /** Run `fn` with this connection's busy_timeout at `ms` (0 = fail at once with SQLITE_BUSY), then restore it. */
  private withBusyTimeout<T>(ms: number, fn: () => T): T {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`);
    try {
      return fn();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
  }

  /** A write that, with `noWait`, never waits for another writer's lock (game-thread callers, §5.16). */
  private write<T>(noWait: boolean | undefined, fn: () => T): T {
    return noWait ? this.withBusyTimeout(0, fn) : fn();
  }

  /** Run `fn` inside BEGIN IMMEDIATE … COMMIT (ROLLBACK on throw). */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Chat log (buffered)
  // ------------------------------------------------------------------------------------------

  /** Queue one chat-log entry. O(1); never touches the DB. */
  logChat(e: ChatLogEntry): void {
    if (this.closed) return;
    this.buf.push(e);
    if (this.buf.length > this.maxBuffered) {
      const drop = this.buf.length - this.maxBuffered;
      this.buf.splice(0, drop);
      this.dropped += drop;
    }
  }

  /**
   * Buffered entries not yet written: chat lines plus the audit rows the lock kept out (pendingActions), so a
   * caller that flushes while this is > 0 writes both.
   */
  get pending(): number { return this.buf.length + this.auditBuf.length; }

  /** Audit rows waiting for the lock (addAction found the database busy). */
  get pendingActions(): number { return this.auditBuf.length; }

  /**
   * Write one entry with its tags and conduct counters (inside a transaction). `seen.d`: the clock disorder recorded
   * so far in this transaction (it becomes this.disorder once the transaction commits).
   */
  private insertEntry(e: ChatLogEntry, seen: { d: number }): void {
    // Every field normalised first: an ill-shaped entry (a producer bug) must never make its transaction fail, as
    // the batch would then stay buffered and block every later line ("Chat is NOT being logged").
    const ts = Number.isFinite(e.time) ? Math.floor(e.time) : Date.now();
    const hits = (Array.isArray(e.hits) ? e.hits : []).slice(0, 20).map((h) => String(h).slice(0, MAX_HIT_LABEL));
    const channel = String(e.channel ?? 'all').slice(0, 16);
    const display: ChatDisplay = displayOf(e.display);
    const roomUid = typeof e.roomUid === 'string' && e.roomUid ? e.roomUid.slice(0, MAX_ROOM_UID) : null;
    const name = clampText(e.name, 64);
    const accountId = typeof e.accountId === 'string' && e.accountId ? e.accountId.slice(0, 64) : null;
    const roomId = typeof e.roomId === 'string' && e.roomId ? e.roomId.slice(0, 32) : null;
    const address = typeof e.address === 'string' && e.address ? e.address.slice(0, 64) : null;
    const action = String(e.action ?? 'pass').slice(0, 16);
    const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt);
    // A line stamped before one already logged (the host clock went back): widen the date searches' id ranges.
    const newest = nOrNull((this.st.maxTs!.get() as Row | undefined)?.m);
    if (newest !== null && newest - ts > seen.d) {
      this.st.raiseDisorder!.run(TS_DISORDER_KEY, newest - ts);
      seen.d = newest - ts;
    }
    const r = this.st.insertChat!.run(
      ts, roomId, clampText(e.roomName, 64), channel, int(e.team, -1), int(e.playerId, 0),
      name, nameKey(String(e.name ?? '')), accountId, address, clampText(e.original), clampText(e.shown),
      action, JSON.stringify(hits), roomUid, display,
    );
    if (!hits.length) return;
    // chat_tags: every tag of the line (SELF-HARM and review-only ones too: they are filters); conduct_daily: the
    // counted ones (conductTagsOf: nothing at all for a wellbeing line, whatever else it contains).
    const id = n(r.lastInsertRowid);
    for (const tag of tagsOf(hits)) this.st.insertTag!.run(id, tag, ts, accountId);
    const counted = conductTagsOf({ channel, hits, display });
    if (counted.length) {
      const key = conductKeyOf(accountId, String(e.name ?? ''));
      const day = dayOf(ts);
      for (const tag of counted) this.st.countConduct!.run(key, day, tag);
    }
  }

  /**
   * Write buffered entries: first the audit rows the lock kept out (all of them, one transaction) and a pending FTS
   * merge mode (setFtsMerge), then at most `maxRows` chat lines (default: one batch), `txRows` per transaction,
   * stopping early after flushBudgetMs (unless `budget` is false). Returns the chat lines written. It never waits for
   * a lock another writer holds (`waitMs` 0, the game thread's rule, §5.16) unless told to (close()). On a DB error
   * (SQLITE_BUSY while the CLI or the maintenance worker writes: isBusyError; busySince says since when) the unwritten
   * rows stay buffered and it rethrows.
   */
  flush(maxRows = this.batchRows, budget = true, waitMs = 0): number {
    if (this.closed || (!this.buf.length && !this.auditBuf.length)) return 0;
    let written = 0;
    const t0 = performance.now();
    const limitMs = budget ? this.flushBudgetMs : Infinity;
    // No wait by default: the rows just stay buffered until the next flush.
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
    try {
      // The merge mode before any commit it is about (a busy lock just leaves it pending: the writes below fail too).
      if (this.ftsMergeRetry && this.buf.length) this.retryFtsMerge();
      if (this.auditBuf.length) this.writeQueuedActions();
      let slowestTx = 0;
      while (this.buf.length && written < maxRows) {
        // Within the budget, the next transaction included (estimated by the slowest one of this call, so a burst
        // stops before a transaction that would likely cross it); the first always runs.
        const start = performance.now();
        if (written > 0 && start - t0 + slowestTx > limitMs) break;
        const take = Math.min(this.txRows, this.buf.length, maxRows - written);
        const batch = this.buf.slice(0, take);
        const seen = { d: this.disorder };
        this.tx(() => {
          if (this.disorderUnsaved) this.st.raiseDisorder!.run(TS_DISORDER_KEY, seen.d);
          for (const e of batch) this.insertEntry(e, seen);
        });
        this.disorder = seen.d;
        this.disorderUnsaved = false;
        this.buf.splice(0, take);
        written += take;
        slowestTx = Math.max(slowestTx, performance.now() - start);
      }
      this.busySince = null;
    } catch (e) {
      if (isBusyError(e)) this.busySince ??= Date.now();
      throw e;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
    return written;
  }

  /**
   * Flush everything buffered, ignoring the time budget (before a report snapshot / a moderator's log query: no wait
   * for the lock, like every game-thread write). `waitMs`: wait that long for another writer's lock (shutdown).
   */
  flushAll(opts: { waitMs?: number } = {}): number {
    return this.flush(Number.MAX_SAFE_INTEGER, false, opts.waitMs ?? 0);
  }

  /**
   * Where FTS5 merges its index from now on (FtsMergeMode; FTS_MERGE_SETTINGS), written to the database only when it
   * differs. Refused (ok: false, nothing written) where the settings are not tunable (ftsMergeTunable). When another
   * writer holds the lock (the worker's start-up tidy, a chunk: this waits the connection's busy_timeout) it answers
   * ok: false, `pending: true`, and the mode stays wanted: every flush() tries again first (no wait) until it takes
   * (ftsMergePending), so a busy moment at open never leaves the game connection merging inline for the session.
   * Switch to 'inline' when the maintenance worker stops merging (it failed, or the server runs without it), and back
   * to 'worker' when it runs again.
   */
  setFtsMerge(mode: FtsMergeMode): { ok: boolean; changed: boolean; reason?: string; pending?: boolean } {
    if (!FTS_MERGE_SETTINGS[mode]) return { ok: false, changed: false, reason: `unknown FTS merge mode ${String(mode)}` };
    this.ftsMergeWanted = mode;
    const r = this.applyFtsMerge(mode);
    this.ftsMergeRetry = r.pending === true;
    return r;
  }

  /** A mode setFtsMerge could not write yet (the lock was busy): the next flush() tries again. */
  get ftsMergePending(): boolean { return this.ftsMergeRetry; }

  private applyFtsMerge(mode: FtsMergeMode): { ok: boolean; changed: boolean; reason?: string; pending?: boolean } {
    const want = FTS_MERGE_SETTINGS[mode];
    let cur: { automerge: number; crisismerge: number };
    try {
      cur = this.ftsSettings();
    } catch (e) {
      if (isBusyError(e)) return { ok: false, changed: false, pending: true, reason: `the database was busy (${(e as Error)?.message ?? e})` };
      throw e;
    }
    if (cur.automerge === want.automerge && cur.crisismerge === want.crisismerge) return { ok: true, changed: false };
    if (!this.ftsTunable) {
      return {
        ok: false, changed: false,
        reason: "this build's database guard compares the FTS merge settings with the migrations' (db/guard.ts ftsConfigSnapshot), so they are left as they are",
      };
    }
    try {
      this.tx(() => {
        if (cur.automerge !== want.automerge) this.db.exec(`INSERT INTO chat_fts(chat_fts, rank) VALUES('automerge', ${want.automerge})`);
        if (cur.crisismerge !== want.crisismerge) this.db.exec(`INSERT INTO chat_fts(chat_fts, rank) VALUES('crisismerge', ${want.crisismerge})`);
      });
      return { ok: true, changed: true };
    } catch (e) {
      if (isBusyError(e)) return { ok: false, changed: false, pending: true, reason: `the database was busy (${(e as Error)?.message ?? e})` };
      return { ok: false, changed: false, reason: `the settings could not be written (${(e as Error)?.message ?? e})` };
    }
  }

  /** flush(): the wanted FTS merge mode, once more (no wait: inside flush's busy_timeout); logged when it takes. */
  private retryFtsMerge(): void {
    const mode = this.ftsMergeWanted;
    if (!mode) { this.ftsMergeRetry = false; return; }
    const r = this.applyFtsMerge(mode);
    if (r.pending) return;
    this.ftsMergeRetry = false;
    this.log(r.ok ? `[mod] FTS index merges: '${mode}' is set now${mode === 'worker' ? ' (the maintenance worker merges)' : ''}`
      : `[mod] FTS index merges stay as they are: ${r.reason}`);
  }

  /** The FTS merge mode the database is in ('custom' = settings neither mode writes). */
  ftsMergeMode(): FtsMergeMode | 'custom' {
    const cur = this.ftsSettings();
    for (const m of ['worker', 'inline'] as const) {
      if (cur.automerge === FTS_MERGE_SETTINGS[m].automerge && cur.crisismerge === FTS_MERGE_SETTINGS[m].crisismerge) return m;
    }
    return 'custom';
  }

  /** chat_fts_config's merge settings (FTS5's defaults when a row is absent). */
  private ftsSettings(): { automerge: number; crisismerge: number } {
    const out = { automerge: FTS_DEFAULTS.automerge, crisismerge: FTS_DEFAULTS.crisismerge };
    for (const r of this.st.ftsSettings!.all() as Row[]) {
      if (r.k === 'automerge') out.automerge = n(r.v);
      else if (r.k === 'crisismerge') out.crisismerge = n(r.v);
    }
    return out;
  }

  /**
   * PRAGMA wal_autocheckpoint of this connection from now on (ModStoreOptions.walAutoCheckpoint): 0 while the
   * maintenance worker checkpoints ('wal.checkpoint' every second), SQLite's 1000 again when it stops (it failed, or
   * the server runs on without it), so the WAL never grows unchecked. Returns the value now in effect.
   */
  setWalAutoCheckpoint(pages: number): number {
    const v = Number.isFinite(pages) ? Math.max(0, Math.min(1_000_000, Math.floor(pages))) : 1000;
    this.db.exec(`PRAGMA wal_autocheckpoint = ${v}`);
    return n((this.db.prepare('PRAGMA wal_autocheckpoint').get() as Row | undefined)?.wal_autocheckpoint);
  }

  /**
   * One WAL checkpoint on this connection (a server whose maintenance worker is down: with walAutoCheckpoint 0 the
   * WAL would otherwise only grow). PASSIVE never waits for readers. Never throws.
   */
  checkpoint(mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): { ok: boolean; busy: boolean; walFrames: number; checkpointed: number } {
    try {
      const r = this.db.prepare(`PRAGMA wal_checkpoint(${mode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE'})`).get() as Row | undefined;
      const walFrames = n(r?.log);
      const checkpointed = n(r?.checkpointed);
      const busy = n(r?.busy) !== 0;
      return { ok: !busy && checkpointed >= walFrames, busy, walFrames, checkpointed };
    } catch {
      return { ok: false, busy: true, walFrames: 0, checkpointed: 0 };
    }
  }

  /**
   * One page of the log, newest first (exact, unbounded: the CLI and the older API; person and tag searches in
   * (ts, id) order, see maint/queries.ts). The panel searches in the maintenance worker instead ('log.search'), which
   * never holds a thread for long; this one can (a rare filter over a long history), so it stays off the game thread.
   * SELF-HARM lines are included unless q.includeSelfHarm is false.
   */
  searchLog(q: LogQuery): { lines: ChatLogRow[]; nextBefore: number | null } {
    const page = searchChatLog(this.db, q, { includeSelfHarmDefault: true });
    return { lines: page.lines, nextBefore: page.nextBefore };
  }

  /**
   * Every line matching `q` (its limit / before are ignored), OLDEST first, handed to `each` in pages of `page` rows
   * (CSV export). Returns the number of rows.
   */
  exportLog(q: LogQuery, each: (rows: ChatLogRow[]) => void, page = 1000): number {
    return eachChatLogPageSync(this.db, q, each, page);
  }

  /** The last `limit` lines of one pilot, oldest first (account id wins; else callsign key [+ address]). */
  recentChat(who: ChatIdent, limit: number): ChatLogRow[] {
    const lim = clampLimit(limit, 20, 500);
    let rows: Row[] = [];
    if (who.accountId) rows = this.st.chatByAccount!.all(who.accountId, lim) as Row[];
    else if (who.nameKey && who.address) rows = this.st.chatByNameAddr!.all(who.nameKey, who.address, lim) as Row[];
    else if (who.nameKey) rows = this.st.chatByName!.all(who.nameKey, lim) as Row[];
    else if (who.address) rows = this.st.chatByAddress!.all(who.address, lim) as Row[];
    return rows.map(chatRowOf).reverse();
  }

  /** The most recent log line under a callsign key (a pilot who left). */
  lastSeenByName(key: string): ChatLogRow | null {
    const r = this.st.lastByName!.get(key) as Row | undefined;
    return r ? chatRowOf(r) : null;
  }

  /** Addresses seen in a pilot's latest chat lines (ADDRESS_SCAN_ROWS of them), most recent first (≤ 10). */
  addressesOf(who: ChatIdent): string[] {
    let rows: Row[] = [];
    if (who.accountId) rows = this.st.addrsByAccount!.all(who.accountId, ADDRESS_SCAN_ROWS) as Row[];
    else if (who.nameKey) rows = this.st.addrsByName!.all(who.nameKey, ADDRESS_SCAN_ROWS) as Row[];
    return rows.map((r) => String(r.address));
  }

  /** Lines of a pilot since `since` that the filter acted on (not 'pass', not review-only 'flag'). */
  flaggedCount(who: ChatIdent, since: number): number {
    if (who.accountId) return n((this.st.flaggedByAccount!.get(who.accountId, since) as Row).n);
    if (who.nameKey) return n((this.st.flaggedByName!.get(who.nameKey, since) as Row).n);
    return 0;
  }

  // ------------------------------------------------------------------------------------------
  // Audit trail
  // ------------------------------------------------------------------------------------------

  /**
   * Write one audit row, never waiting for another writer's lock (§5.16: game-thread audit inserts, like chat, are
   * buffered only while the DB is busy). Returns its id; 0 = queued: the lock was busy (a worker chunk, a merge step)
   * and the row waits in memory, in order behind any earlier queued ones, for the next addAction / flush() / close()
   * (the service's flush timer: within a second). Any other DB error is rethrown with the row still queued (it is
   * retried, never silently lost; only MAX_BUFFERED_ACTIONS rows are kept).
   */
  addAction(a: NewAction): number {
    if (this.closed) throw new Error('[mod] the moderation store is closed');
    const ts = Number.isFinite(a.ts) ? Math.floor(a.ts) : Date.now();
    const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null);
    const textOrNull = (v: unknown, max: number): string | null => (v === null || v === undefined ? null : clampText(v, max));
    this.auditBuf.push([
      ts, clampText(a.actorAccountId, 64), clampText(a.actorName, 64), clampText(a.action, 32) || 'note',
      textOrNull(a.targetAccountId, 64), textOrNull(a.targetName, 64), textOrNull(a.targetAddress, 64),
      numOrNull(a.durationSec), numOrNull(a.expiresAt), clampText(a.reason, 500),
    ]);
    if (this.auditBuf.length > MAX_BUFFERED_ACTIONS) {
      const drop = this.auditBuf.length - MAX_BUFFERED_ACTIONS;
      this.auditBuf.splice(0, drop);
      this.droppedActions += drop;
    }
    try {
      return this.withBusyTimeout(0, () => this.writeQueuedActions());
    } catch (e) {
      if (isBusyError(e)) return 0;
      throw e;
    }
  }

  /** Write every queued audit row in one transaction (the caller sets the wait). Returns the last one's id. */
  private writeQueuedActions(): number {
    const batch = this.auditBuf.slice();
    if (!batch.length) return 0;
    let last = 0;
    this.tx(() => {
      for (const args of batch) last = n(this.st.insertAction!.run(...args).lastInsertRowid);
    });
    this.auditBuf.splice(0, batch.length);
    return last;
  }

  /**
   * The audit trail, newest first, optionally about one target. The whole trail pages in id order (the rowid: no
   * sort). A target's rows page in (ts, id) order, newest first — the order of the (target, ts) indexes, so a page
   * reads at most `limit` + 1 entries of each index however long the student's audit history is (every conduct view
   * and reveal adds a row about them, §5.11): the account's (mod_actions_target) and the address's
   * (mod_actions_address) are read in index order and merged; a name match looks at the newest ACTIONS_NAME_SCAN audit
   * rows only (see there). `before` / `nextBefore` = the id of the last row shown; for a target the cursor is (ts, id):
   * pass `beforeTs` = the page's `nextBeforeTs` (else the row's ts is looked up — the nearest older row's when it went
   * meanwhile, a retention prune).
   */
  listActions(q: {
    limit?: number; before?: number; beforeTs?: number; targetAccountId?: string | null; targetName?: string | null; targetAddress?: string | null;
  }): { actions: ActionRow[]; nextBefore: number | null; nextBeforeTs: number | null } {
    // Rows the lock kept out go in first when it is free now (no wait), so a moderator reads what they just did.
    if (this.auditBuf.length) {
      try { this.withBusyTimeout(0, () => this.writeQueuedActions()); } catch { /* still busy: the next flush */ }
    }
    const limit = clampLimit(q.limit, 100, 1000);
    const before = typeof q.before === 'number' && Number.isFinite(q.before) ? Math.floor(q.before) : null;
    const targeted = !!(q.targetAccountId || q.targetName || q.targetAddress);
    const page = (rows: Row[]): { actions: ActionRow[]; nextBefore: number | null; nextBeforeTs: number | null } => {
      const actions = rows.map(actionRowOf);
      const more = actions.length > limit;
      if (more) actions.length = limit;
      const last = more && actions.length ? actions[actions.length - 1]! : null;
      return { actions, nextBefore: last ? last.id : null, nextBeforeTs: last && targeted ? last.ts : null };
    };
    if (!targeted) {
      return page((before === null ? this.st.actionsAll!.all(limit + 1) : this.st.actionsAllBefore!.all(before, limit + 1)) as Row[]);
    }
    let curTs = Number.MAX_SAFE_INTEGER;
    let curId = Number.MAX_SAFE_INTEGER;
    if (before !== null) {
      const ts = typeof q.beforeTs === 'number' && Number.isFinite(q.beforeTs) ? Math.floor(q.beforeTs)
        : nOrNull((this.st.actionTs!.get(before) as Row | undefined)?.ts) ?? nOrNull((this.st.actionTsBelow!.get(before) as Row | undefined)?.ts);
      if (ts === null) return { actions: [], nextBefore: null, nextBeforeTs: null };
      curTs = ts;
      curId = before;
    }
    const sides: Row[][] = [];
    if (q.targetAccountId) sides.push(this.st.actionsByAccount!.all(q.targetAccountId, curTs, curId, limit + 1) as Row[]);
    if (q.targetAddress) sides.push(this.st.actionsByAddress!.all(q.targetAddress, curTs, curId, limit + 1) as Row[]);
    if (q.targetName) {
      const floor = n((this.st.maxActionId!.get() as Row | undefined)?.m) - ACTIONS_NAME_SCAN;
      sides.push(this.st.actionsByName!.all(floor, q.targetName, curTs, curId, limit + 1) as Row[]);
    }
    if (sides.length === 1) return page(sides[0]!);
    const seen = new Set<number>();
    const merged: Row[] = [];
    for (const side of sides) {
      for (const r of side) {
        const id = n(r.id);
        if (!seen.has(id)) { seen.add(id); merged.push(r); }
      }
    }
    merged.sort((a, b) => n(b.ts) - n(a.ts) || n(b.id) - n(a.id));
    return page(merged.slice(0, limit + 1));
  }

  // ------------------------------------------------------------------------------------------
  // Bans / mutes (every change bumps mod_meta.rev in the same transaction)
  // ------------------------------------------------------------------------------------------

  /**
   * opts.noWait (here and on every other ban / report / moderator write): fail at once (SQLITE_BUSY: isBusyError)
   * instead of waiting busy_timeout for another writer (game-thread callers, §5.16; the caller answers "try again").
   */
  addBan(b: NewBan, now = b.createdAt, opts: { noWait?: boolean } = {}): BanRow {
    return this.write(opts.noWait, () => this.tx(() => {
      const r = this.st.insertBan!.run(
        b.kind, b.scope, b.accountId, b.username != null ? clampText(b.username, 64) : null, b.address,
        Math.floor(b.createdAt), b.expiresAt === null ? null : Math.floor(b.expiresAt), clampText(b.reason, 200), clampText(b.by, 64),
      );
      this.st.bumpRev!.run();
      return banRowOf(this.st.getBan!.get(n(r.lastInsertRowid)) as Row, now);
    }));
  }

  getBan(id: number, now: number): BanRow | null {
    const r = this.st.getBan!.get(Math.floor(id)) as Row | undefined;
    return r ? banRowOf(r, now) : null;
  }

  /** Revoke one ban / mute (no-op if already revoked). True = revoked now. opts.noWait: see addBan. */
  revokeBan(id: number, now: number, opts: { noWait?: boolean } = {}): boolean {
    return this.write(opts.noWait, () => this.tx(() => {
      const changed = n(this.st.revokeBan!.run(Math.floor(now), Math.floor(id)).changes) === 1;
      if (changed) this.st.bumpRev!.run();
      return changed;
    }));
  }

  /** Every ban / mute that is neither revoked nor expired at `now`. */
  liveBans(now: number): BanRow[] {
    return (this.st.liveBans!.all(Math.floor(now)) as Row[]).map((r) => banRowOf(r, now));
  }

  listBans(q: { kind?: BanKind | 'all'; includeInactive?: boolean; limit?: number }, now: number): BanRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.kind === 'ban' || q.kind === 'mute') { where.push('kind = ?'); args.push(q.kind); }
    if (!q.includeInactive) { where.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)'); args.push(Math.floor(now)); }
    const limit = clampLimit(q.limit, 200, 1000);
    const sql = `SELECT * FROM bans${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, limit) as Row[]).map((r) => banRowOf(r, now));
  }

  // ------------------------------------------------------------------------------------------
  // Reports
  // ------------------------------------------------------------------------------------------

  /**
   * File a report. Its saved lines (the last REPORT_MAX_LINES of `recentChat`) are stored as shown-only copies with
   * their chat ids (§6.4): whatever the caller passes, no original text, address or hit label is kept. A SELF-HARM
   * (wellbeing) line is kept only when withheld (its copy's display says so); any other one is left out entirely, as a
   * copy carries no tags or hit labels and moderators must never receive one (§5.11, §5.15). opts.noWait: see addBan.
   */
  addReport(r: NewReport, opts: { noWait?: boolean } = {}): ReportRow {
    const copies = r.recentChat.filter((l) => !isUnmarkableWellbeingLine(l)).slice(-REPORT_MAX_LINES)
      .map((l) => reportChatCopy(l)).filter((c): c is NonNullable<typeof c> => c !== null);
    const ids = copies.map((c) => c.id).filter((x): x is number => Number.isInteger(x));
    const res = this.write(opts.noWait, () => this.st.insertReport!.run(
      Math.floor(r.ts), r.reporter.playerId, clampText(r.reporter.name, 64), r.reporter.accountId, r.reporter.address,
      r.target.playerId, clampText(r.target.name, 64), r.target.accountId, r.target.address,
      clampText(r.reason, 200), clampText(r.room, 64), JSON.stringify(copies), JSON.stringify(ids),
    ));
    return this.getReport(n(res.lastInsertRowid))!;
  }

  getReport(id: number): ReportRow | null {
    const r = this.st.getReport!.get(Math.floor(id)) as Row | undefined;
    return r ? reportRowOf(r) : null;
  }

  listReports(q: { status?: ReportStatus | 'all'; limit?: number; before?: number }): { reports: ReportRow[]; nextBefore: number | null } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const status = q.status ?? 'open';
    if (status !== 'all') { where.push('status = ?'); args.push(status); }
    if (typeof q.before === 'number' && Number.isFinite(q.before)) { where.push('id < ?'); args.push(Math.floor(q.before)); }
    const limit = clampLimit(q.limit, 50, 500);
    const sql = `SELECT * FROM reports${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = (this.db.prepare(sql).all(...args, limit + 1) as Row[]).map(reportRowOf);
    const more = rows.length > limit;
    if (more) rows.length = limit;
    return { reports: rows, nextBefore: more && rows.length ? rows[rows.length - 1]!.id : null };
  }

  /** Set a report's status. Null = no such report. opts.noWait: see addBan. */
  reviewReport(id: number, status: ReportStatus, by: string, now: number, note?: string | null, opts: { noWait?: boolean } = {}): ReportRow | null {
    const changed = n(this.write(opts.noWait, () => this.st.reviewReport!.run(status, status === 'open' ? null : clampText(by, 64),
      status === 'open' ? null : Math.floor(now), note != null ? clampText(note, 500) : null, Math.floor(id))).changes);
    return changed ? this.getReport(id) : null;
  }

  // ------------------------------------------------------------------------------------------
  // Moderators
  // ------------------------------------------------------------------------------------------

  adminIds(): Set<string> {
    return new Set((this.st.adminIds!.all() as Row[]).map((r) => String(r.account_id)));
  }

  listAdmins(): { accountId: string; username: string | null; addedAt: number; addedBy: string }[] {
    return (this.st.listAdmins!.all() as Row[]).map((r) => ({
      accountId: String(r.account_id), username: sOrNull(r.username), addedAt: n(r.added_at), addedBy: String(r.added_by ?? ''),
    }));
  }

  /** True = newly added. opts.noWait: see addBan. */
  addAdmin(accountId: string, by: string, now: number, opts: { noWait?: boolean } = {}): boolean {
    return this.write(opts.noWait, () => this.tx(() => {
      const added = n(this.st.addAdmin!.run(accountId, Math.floor(now), clampText(by, 64)).changes) === 1;
      if (added) this.st.bumpRev!.run();
      return added;
    }));
  }

  /** True = removed. opts.noWait: see addBan. */
  removeAdmin(accountId: string, opts: { noWait?: boolean } = {}): boolean {
    return this.write(opts.noWait, () => this.tx(() => {
      const removed = n(this.st.removeAdmin!.run(accountId).changes) === 1;
      if (removed) this.st.bumpRev!.run();
      return removed;
    }));
  }

  // ------------------------------------------------------------------------------------------
  // Accounts (read-only lookups on the auth table)
  // ------------------------------------------------------------------------------------------

  /** Account by username (case-insensitive; look-alike letters folded). */
  accountByUsername(name: string): AccountLite | null {
    const raw = String(name ?? '').trim().toLowerCase();
    if (!raw || raw.length > 64) return null;
    let r = this.st.accountByLower!.get(raw) as Row | undefined;
    if (!r) {
      const key = nameKey(raw);
      if (key !== raw) r = this.st.accountByLower!.get(key) as Row | undefined;
    }
    return r ? { id: String(r.id), username: String(r.username), createdAt: n(r.created_at), lastLogin: nOrNull(r.last_login) } : null;
  }

  accountById(id: string): AccountLite | null {
    const r = this.st.accountById!.get(String(id ?? '')) as Row | undefined;
    return r ? { id: String(r.id), username: String(r.username), createdAt: n(r.created_at), lastLogin: nOrNull(r.last_login) } : null;
  }

  // ------------------------------------------------------------------------------------------
  // Change counter + retention
  // ------------------------------------------------------------------------------------------

  /** mod_meta.rev: bumped by every bans / admins change (from any connection). */
  rev(): number {
    return n((this.st.rev!.get() as Row | undefined)?.v);
  }

  /**
   * One prune step: deletes up to `chunk` rows per table past the cutoffs (chat lines take their tags, reviews and
   * wellbeing acks with them; conduct counters of whole days before keepBefore go too). Returns the rows removed;
   * call again (on a later turn of the event loop) until it returns 0. The removed lines' FTS entries are tidied by
   * the next optimize (mod_meta.fts_dirty).
   */
  pruneStep(c: PruneCutoffs, chunk = PRUNE_CHUNK): number {
    const size = Math.max(1, Math.floor(chunk));
    return this.tx(() => {
      const chat = n(this.st.pruneChat!.run(Math.floor(c.chatBefore), size).changes);
      if (chat) markIndexDirty(this.db, chat);
      const actions = n(this.st.pruneActions!.run(Math.floor(c.keepBefore), size).changes);
      const reports = n(this.st.pruneReports!.run(Math.floor(c.keepBefore), size).changes);
      const bans = n(this.st.pruneBans!.run(Math.floor(c.keepBefore), Math.floor(c.keepBefore), size).changes);
      const conduct = n(this.st.pruneConduct!.run(dayOf(Math.floor(c.keepBefore)), size).changes);
      return chat + actions + reports + bans + conduct;
    });
  }

  /**
   * Delete chat-log lines older than `before` (epoch ms) — everything when `before` is in the future — optionally
   * only one player's (callsign or account username, like searchLog's `player`), with what hangs off them (§5.5
   * manual purge, §6.4): their tags / reviews / wellbeing acks (cascade), the conduct counters of the whole days
   * before the cut in that scope (the worker's rule, erase.ts purgeChatBefore) and the report copies of the deleted
   * lines. The rows are overwritten in the file (secure_delete is always on), the WAL is checkpointed when possible,
   * and the FTS index tidies at the next optimize. It writes NO deletion-ledger entry, so a restore brings the lines
   * back unless the caller records the purge (maint/ledger.ts purgeRecorded records and purges an account's lines or
   * everyone's). One transaction: for the CLI (its own process), never the game thread. Returns the lines deleted.
   */
  purgeChat(q: { before: number; player?: string }): number {
    this.flushAll({ waitMs: this.busyTimeoutMs });
    const before = Math.floor(q.before);
    const where = ['ts < ?'];
    const args: (string | number)[] = [before];
    let key: string | null = null;
    let acc: string | null = null;
    if (q.player) {
      key = nameKey(q.player);
      acc = this.accountByUsername(q.player)?.id ?? null;
      if (acc) { where.push('(name_key = ? OR account_id = ?)'); args.push(key, acc); }
      else { where.push('name_key = ?'); args.push(key); }
    }
    const removed = this.tx(() => {
      const k = n(this.db.prepare(`DELETE FROM chat_log WHERE ${where.join(' AND ')}`).run(...args).changes);
      markIndexDirty(this.db, k);
      const day = dayOf(before);
      if (key === null) this.db.prepare('DELETE FROM conduct_daily WHERE day < ?').run(day);
      else this.db.prepare('DELETE FROM conduct_daily WHERE account_key IN (?, ?) AND day < ?').run(acc ?? `g:${key}`, `g:${key}`, day);
      this.dropReportCopies(before, key, acc);
      return k;
    });
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a running server holds a reader: next checkpoint */ }
    return removed;
  }

  /**
   * After a purge (inside its transaction): drop the report copies of lines that are gone (their chat id no longer
   * exists), or, for a copy without an id, that fall in the purge's scope before its cut. Returns the reports changed.
   */
  private dropReportCopies(before: number, key: string | null, acc: string | null): number {
    const exists = this.db.prepare('SELECT 1 AS x FROM chat_log WHERE id = ?');
    const alive = (id: unknown): boolean => Number.isInteger(id) && exists.get(id as number) !== undefined;
    const inScope = (c: Record<string, unknown>): boolean => key === null
      || (acc !== null && c.accountId === acc) || nameKey(String(c.name ?? '')) === key;
    const upd = this.db.prepare('UPDATE reports SET recent_chat_json = ?, recent_ids = ? WHERE id = ?');
    let changed = 0;
    for (const r of this.db.prepare("SELECT id, recent_chat_json, recent_ids FROM reports WHERE recent_chat_json <> '[]' OR recent_ids <> '[]'").all() as Row[]) {
      const parse = (v: unknown): unknown[] => {
        try { const a = JSON.parse(String(v ?? '[]')) as unknown; return Array.isArray(a) ? a : []; } catch { return []; }
      };
      const copies = parse(r.recent_chat_json);
      const ids = parse(r.recent_ids);
      const keptCopies = copies.filter((c) => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
        const o = c as Record<string, unknown>;
        if (Number.isInteger(o.id)) return alive(o.id);
        return !(typeof o.ts === 'number' && o.ts < before && inScope(o));
      });
      const keptIds = ids.filter(alive);
      if (keptCopies.length === copies.length && keptIds.length === ids.length) continue;
      upd.run(JSON.stringify(keptCopies), JSON.stringify(keptIds), n(r.id));
      changed++;
    }
    return changed;
  }

  /** Prune to completion (CLI / tests). */
  pruneAll(c: PruneCutoffs): number {
    let total = 0;
    for (;;) {
      const k = this.pruneStep(c);
      total += k;
      if (k === 0) return total;
    }
  }

  /**
   * Write what is buffered — waiting up to closeWaitMs for another writer's lock (a worker chunk, the Stop-time FTS
   * optimize), unlike the game thread's no-wait flushes — then close. What still cannot be written is logged.
   */
  close(): void {
    if (this.closed) return;
    try { this.flushAll({ waitMs: this.closeWaitMs }); } catch (e) {
      const audit = this.auditBuf.length ? ` and ${this.auditBuf.length} audit entries` : '';
      this.log(`[mod] final chat-log flush failed (${this.buf.length} lines${audit} lost): ${(e as Error)?.message ?? e}`);
    }
    this.closed = true;
    this.buf = [];
    this.auditBuf = [];
    this.db.close();
  }
}
