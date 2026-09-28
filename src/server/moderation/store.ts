// OWNER: SERVER MODERATION. SQLite persistence for moderation: the chat log, the moderation audit trail (mod_actions),
// bans / mutes, player reports and moderator accounts. The tables live in the auth DB file (MIGRATIONS[2] in
// ../auth/store.ts); this store opens its OWN connection on that file, after AuthStore has migrated it. The CLI
// (./cli.ts) opens one too, while the server runs (WAL: readers and one writer at a time).
//
// Chat lines are buffered in memory (logChat is O(1) and never touches the disk) and written in small transactions
// by flush(), which the ModerationService calls from a timer — never from inside a game tick.
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChatAction, ChatLogEntry, LogChannel } from '../../shared/room/moderation';
import { nameKey } from '../../shared/room/util';
import { SCHEMA_VERSION } from '../auth/store';

/** First auth schema version with the moderation tables (MIGRATIONS[2]). */
export const MOD_SCHEMA_MIN = 3;
/** Rows per chat-log insert transaction. */
export const DEFAULT_BATCH_ROWS = 50;
/** Chat lines held in memory while the DB is busy; beyond this the oldest are dropped (and counted). */
export const DEFAULT_MAX_BUFFERED = 20_000;
/** Rows deleted per prune statement (pruning runs in steps so no single step holds the thread for long). */
export const PRUNE_CHUNK = 2000;
/** Text columns are clamped to this many characters (chat lines are ≤ 200 already). */
const MAX_TEXT = 1000;

export type BanKind = 'ban' | 'mute';
export type BanScope = 'account' | 'address' | 'guest';
export type ReportStatus = 'open' | 'reviewed' | 'dismissed';
export type ModActionKind = 'ban' | 'unban' | 'mute' | 'unmute' | 'kick' | 'warn' | 'note' | 'promote' | 'demote';

export const CHAT_ACTIONS: readonly ChatAction[] = ['pass', 'mask', 'block', 'spam', 'muted'];
export const REPORT_STATUSES: readonly ReportStatus[] = ['open', 'reviewed', 'dismissed'];

export interface ChatLogRow {
  id: number; ts: number;
  roomId: string | null; roomName: string;
  channel: LogChannel; team: number;
  playerId: number; name: string;
  accountId: string | null; address: string | null;
  original: string; shown: string;
  action: ChatAction; hits: string[];
}

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
  recentChat: ChatLogRow[];
  reviewedBy: string | null; reviewedAt: number | null; note: string | null;
}

export interface NewReport { ts: number; reporter: Party; target: Party; reason: string; room: string; recentChat: ChatLogRow[] }

export interface LogQuery {
  /** callsign (name key) or account username */
  player?: string;
  accountId?: string;
  address?: string;
  /** case-insensitive substring of original or shown */
  grep?: string;
  action?: ChatAction | 'flagged';
  roomId?: string;
  since?: number;
  until?: number;
  limit?: number;
  /** paging cursor: rows with id < before */
  before?: number;
}

export interface AccountLite { id: string; username: string; createdAt: number; lastLogin: number | null }

/** Who a chat-log lookup is about (at least one field). */
export interface ChatIdent { accountId?: string | null; nameKey?: string | null; address?: string | null }

export interface PruneCutoffs {
  /** chat_log rows older than this go */
  chatBefore: number;
  /** mod_actions / reports older than this go; bans that ended before it go */
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
  batchRows?: number;
  maxBuffered?: number;
}

type Row = Record<string, unknown>;

const n = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));
const sOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const clampText = (s: unknown, max = MAX_TEXT): string => String(s ?? '').slice(0, max);

function parseHits(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? '[]')) as unknown;
    return Array.isArray(a) ? a.map(String) : [];
  } catch { return []; }
}

export function chatRowOf(r: Row): ChatLogRow {
  return {
    id: n(r.id), ts: n(r.ts), roomId: sOrNull(r.room_id), roomName: String(r.room_name ?? ''),
    channel: String(r.channel) as LogChannel, team: n(r.team), playerId: n(r.player_id), name: String(r.name ?? ''),
    accountId: sOrNull(r.account_id), address: sOrNull(r.address), original: String(r.original ?? ''),
    shown: String(r.shown ?? ''), action: String(r.action) as ChatAction, hits: parseHits(r.hits),
  };
}

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

function reportRowOf(r: Row): ReportRow {
  let recentChat: ChatLogRow[] = [];
  try {
    const a = JSON.parse(String(r.recent_chat_json ?? '[]')) as unknown;
    if (Array.isArray(a)) recentChat = a as ChatLogRow[];
  } catch { recentChat = []; }
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
    recentChat, reviewedBy: sOrNull(r.reviewed_by), reviewedAt: nOrNull(r.reviewed_at), note: sOrNull(r.note),
  };
}

const clampLimit = (v: unknown, dflt: number, max: number): number => {
  const x = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(1, Math.min(max, x));
};

/** LIKE pattern for a case-insensitive substring (escape char '\'). */
const likeOf = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class ModStore {
  private readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private readonly log: (line: string) => void;
  private readonly batchRows: number;
  private readonly maxBuffered: number;
  private readonly busyTimeoutMs: number;
  private buf: ChatLogEntry[] = [];
  private closed = false;
  /** Chat lines dropped because the buffer overflowed (DB unavailable for a long time). */
  dropped = 0;

  constructor(dbPath: string, opts: ModStoreOptions = {}) {
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.batchRows = Math.max(1, Math.floor(opts.batchRows ?? DEFAULT_BATCH_ROWS));
    this.maxBuffered = Math.max(this.batchRows, Math.floor(opts.maxBuffered ?? DEFAULT_MAX_BUFFERED));
    this.busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
    if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) {
      throw new Error(`[mod] no database at ${dbPath || '(none)'} — construct the AuthService first (it creates and migrates the file)`);
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      const version = n((db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version);
      if (version < MOD_SCHEMA_MIN) throw new Error(`[mod] auth DB schema v${version} has no moderation tables (need v${MOD_SCHEMA_MIN}) — construct the AuthService first`);
      if (version > SCHEMA_VERSION) throw new Error(`[mod] auth DB schema v${version} is newer than this server understands (v${SCHEMA_VERSION})`);
    } catch (e) {
      try { db.close(); } catch { /* already closed */ }
      throw e;
    }
    this.db = db;
    const p = (sql: string): StatementSync => db.prepare(sql);
    this.st = {
      insertChat: p(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address,
                       original, shown, action, hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      chatByAccount: p('SELECT * FROM chat_log WHERE account_id = ? ORDER BY id DESC LIMIT ?'),
      chatByName: p('SELECT * FROM chat_log WHERE name_key = ? ORDER BY id DESC LIMIT ?'),
      chatByNameAddr: p('SELECT * FROM chat_log WHERE name_key = ? AND address = ? ORDER BY id DESC LIMIT ?'),
      chatByAddress: p('SELECT * FROM chat_log WHERE address = ? ORDER BY id DESC LIMIT ?'),
      lastByName: p('SELECT * FROM chat_log WHERE name_key = ? ORDER BY id DESC LIMIT 1'),
      addrsByAccount: p(`SELECT address, MAX(ts) AS t FROM chat_log WHERE account_id = ? AND address IS NOT NULL
                          GROUP BY address ORDER BY t DESC LIMIT 10`),
      addrsByName: p(`SELECT address, MAX(ts) AS t FROM chat_log WHERE name_key = ? AND account_id IS NULL AND address IS NOT NULL
                       GROUP BY address ORDER BY t DESC LIMIT 10`),
      flaggedByAccount: p("SELECT COUNT(*) AS n FROM chat_log WHERE account_id = ? AND action <> 'pass' AND ts >= ?"),
      flaggedByName: p("SELECT COUNT(*) AS n FROM chat_log WHERE name_key = ? AND account_id IS NULL AND action <> 'pass' AND ts >= ?"),
      insertAction: p(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name,
                         target_address, duration_sec, expires_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertBan: p(`INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, expires_at, reason, by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getBan: p('SELECT * FROM bans WHERE id = ?'),
      revokeBan: p('UPDATE bans SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
      liveBans: p('SELECT * FROM bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id'),
      insertReport: p(`INSERT INTO reports (ts, reporter_player_id, reporter_name, reporter_account_id, reporter_address,
                         target_player_id, target_name, target_account_id, target_address, reason, room, recent_chat_json, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`),
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
    };
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

  /** Buffered entries not yet written. */
  get pending(): number { return this.buf.length; }

  /**
   * Write buffered entries: at most `maxRows` (default: one batch), `batchRows` per transaction. Returns the rows
   * written. On a DB error (e.g. SQLITE_BUSY while the CLI writes) the unwritten rows stay buffered and it rethrows.
   */
  flush(maxRows = this.batchRows): number {
    if (this.closed || !this.buf.length) return 0;
    let written = 0;
    // Never wait for a lock another process (the CLI) holds: the rows just stay buffered until the next flush.
    this.db.exec('PRAGMA busy_timeout = 0');
    try {
      while (this.buf.length && written < maxRows) {
        const take = Math.min(this.batchRows, this.buf.length, maxRows - written);
        const batch = this.buf.slice(0, take);
        this.tx(() => {
          for (const e of batch) {
            this.st.insertChat!.run(
              Math.floor(e.time), e.roomId, clampText(e.roomName, 64), e.channel, Math.floor(e.team) || 0, Math.floor(e.playerId) || 0,
              clampText(e.name, 64), nameKey(String(e.name ?? '')), e.accountId, e.address, clampText(e.original), clampText(e.shown),
              e.action, JSON.stringify((e.hits ?? []).slice(0, 20).map((h) => String(h).slice(0, 64))),
            );
          }
        });
        this.buf.splice(0, take);
        written += take;
      }
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
    return written;
  }

  /** Flush everything buffered (shutdown, before a report snapshot / a moderator's log query). */
  flushAll(): number {
    return this.flush(Number.MAX_SAFE_INTEGER);
  }

  searchLog(q: LogQuery): { lines: ChatLogRow[]; nextBefore: number | null } {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (q.player) {
      const key = nameKey(q.player);
      const acc = this.accountByUsername(q.player);
      if (acc) { where.push('(name_key = ? OR account_id = ?)'); args.push(key, acc.id); }
      else { where.push('name_key = ?'); args.push(key); }
    }
    if (q.accountId) { where.push('account_id = ?'); args.push(q.accountId); }
    if (q.address) { where.push('address = ?'); args.push(q.address); }
    if (q.grep) {
      where.push("(original LIKE ? ESCAPE '\\' OR shown LIKE ? ESCAPE '\\')");
      const like = likeOf(q.grep.slice(0, 100));
      args.push(like, like);
    }
    if (q.action === 'flagged') where.push("action <> 'pass'");
    else if (q.action) { where.push('action = ?'); args.push(q.action); }
    if (q.roomId) { where.push('room_id = ?'); args.push(q.roomId); }
    if (typeof q.since === 'number' && Number.isFinite(q.since)) { where.push('ts >= ?'); args.push(Math.floor(q.since)); }
    if (typeof q.until === 'number' && Number.isFinite(q.until)) { where.push('ts <= ?'); args.push(Math.floor(q.until)); }
    if (typeof q.before === 'number' && Number.isFinite(q.before)) { where.push('id < ?'); args.push(Math.floor(q.before)); }
    const limit = clampLimit(q.limit, 100, 1000);
    const sql = `SELECT * FROM chat_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = (this.db.prepare(sql).all(...args, limit + 1) as Row[]).map(chatRowOf);
    const more = rows.length > limit;
    if (more) rows.length = limit;
    return { lines: rows, nextBefore: more && rows.length ? rows[rows.length - 1]!.id : null };
  }

  /**
   * Every line matching `q` (its limit / before are ignored), OLDEST first, handed to `each` in pages of `page` rows
   * (CSV export). Returns the number of rows.
   */
  exportLog(q: LogQuery, each: (rows: ChatLogRow[]) => void, page = 1000): number {
    let after = 0;
    let total = 0;
    for (;;) {
      const where: string[] = ['id > ?'];
      const args: (string | number)[] = [after];
      if (q.player) {
        const acc = this.accountByUsername(q.player);
        if (acc) { where.push('(name_key = ? OR account_id = ?)'); args.push(nameKey(q.player), acc.id); }
        else { where.push('name_key = ?'); args.push(nameKey(q.player)); }
      }
      if (q.accountId) { where.push('account_id = ?'); args.push(q.accountId); }
      if (q.address) { where.push('address = ?'); args.push(q.address); }
      if (q.grep) { where.push("(original LIKE ? ESCAPE '\\' OR shown LIKE ? ESCAPE '\\')"); const l = likeOf(q.grep.slice(0, 100)); args.push(l, l); }
      if (q.action === 'flagged') where.push("action <> 'pass'");
      else if (q.action) { where.push('action = ?'); args.push(q.action); }
      if (typeof q.since === 'number') { where.push('ts >= ?'); args.push(Math.floor(q.since)); }
      if (typeof q.until === 'number') { where.push('ts <= ?'); args.push(Math.floor(q.until)); }
      const rows = (this.db.prepare(`SELECT * FROM chat_log WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...args, page) as Row[]).map(chatRowOf);
      if (!rows.length) return total;
      each(rows);
      total += rows.length;
      after = rows[rows.length - 1]!.id;
      if (rows.length < page) return total;
    }
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

  /** Addresses seen in a pilot's chat log, most recent first (≤ 10). */
  addressesOf(who: ChatIdent): string[] {
    let rows: Row[] = [];
    if (who.accountId) rows = this.st.addrsByAccount!.all(who.accountId) as Row[];
    else if (who.nameKey) rows = this.st.addrsByName!.all(who.nameKey) as Row[];
    return rows.map((r) => String(r.address));
  }

  /** Non-'pass' lines of a pilot since `since`. */
  flaggedCount(who: ChatIdent, since: number): number {
    if (who.accountId) return n((this.st.flaggedByAccount!.get(who.accountId, since) as Row).n);
    if (who.nameKey) return n((this.st.flaggedByName!.get(who.nameKey, since) as Row).n);
    return 0;
  }

  // ------------------------------------------------------------------------------------------
  // Audit trail
  // ------------------------------------------------------------------------------------------

  addAction(a: NewAction): number {
    const r = this.st.insertAction!.run(
      Math.floor(a.ts), clampText(a.actorAccountId, 64), clampText(a.actorName, 64), a.action,
      a.targetAccountId ?? null, a.targetName != null ? clampText(a.targetName, 64) : null, a.targetAddress ?? null,
      a.durationSec ?? null, a.expiresAt ?? null, clampText(a.reason, 500),
    );
    return n(r.lastInsertRowid);
  }

  listActions(q: { limit?: number; before?: number; targetAccountId?: string | null; targetName?: string | null; targetAddress?: string | null }): { actions: ActionRow[]; nextBefore: number | null } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const or: string[] = [];
    if (q.targetAccountId) { or.push('target_account_id = ?'); args.push(q.targetAccountId); }
    if (q.targetName) { or.push('lower(target_name) = ?'); args.push(q.targetName.toLowerCase()); }
    if (q.targetAddress) { or.push('target_address = ?'); args.push(q.targetAddress); }
    if (or.length) where.push(`(${or.join(' OR ')})`);
    if (typeof q.before === 'number' && Number.isFinite(q.before)) { where.push('id < ?'); args.push(Math.floor(q.before)); }
    const limit = clampLimit(q.limit, 100, 1000);
    const sql = `SELECT * FROM mod_actions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = (this.db.prepare(sql).all(...args, limit + 1) as Row[]).map(actionRowOf);
    const more = rows.length > limit;
    if (more) rows.length = limit;
    return { actions: rows, nextBefore: more && rows.length ? rows[rows.length - 1]!.id : null };
  }

  // ------------------------------------------------------------------------------------------
  // Bans / mutes (every change bumps mod_meta.rev in the same transaction)
  // ------------------------------------------------------------------------------------------

  /** opts.noWait: fail at once (SQLITE_BUSY) instead of waiting busy_timeout for another writer (game-thread callers). */
  addBan(b: NewBan, now = b.createdAt, opts: { noWait?: boolean } = {}): BanRow {
    if (opts.noWait) this.db.exec('PRAGMA busy_timeout = 0');
    try {
      return this.tx(() => {
        const r = this.st.insertBan!.run(
          b.kind, b.scope, b.accountId, b.username != null ? clampText(b.username, 64) : null, b.address,
          Math.floor(b.createdAt), b.expiresAt === null ? null : Math.floor(b.expiresAt), clampText(b.reason, 200), clampText(b.by, 64),
        );
        this.st.bumpRev!.run();
        return banRowOf(this.st.getBan!.get(n(r.lastInsertRowid)) as Row, now);
      });
    } finally {
      if (opts.noWait) this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
  }

  getBan(id: number, now: number): BanRow | null {
    const r = this.st.getBan!.get(Math.floor(id)) as Row | undefined;
    return r ? banRowOf(r, now) : null;
  }

  /** Revoke one ban / mute (no-op if already revoked). True = revoked now. */
  revokeBan(id: number, now: number): boolean {
    return this.tx(() => {
      const changed = n(this.st.revokeBan!.run(Math.floor(now), Math.floor(id)).changes) === 1;
      if (changed) this.st.bumpRev!.run();
      return changed;
    });
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

  addReport(r: NewReport): ReportRow {
    const res = this.st.insertReport!.run(
      Math.floor(r.ts), r.reporter.playerId, clampText(r.reporter.name, 64), r.reporter.accountId, r.reporter.address,
      r.target.playerId, clampText(r.target.name, 64), r.target.accountId, r.target.address,
      clampText(r.reason, 200), clampText(r.room, 64), JSON.stringify(r.recentChat.slice(-20)),
    );
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

  /** Set a report's status. Null = no such report. */
  reviewReport(id: number, status: ReportStatus, by: string, now: number, note?: string | null): ReportRow | null {
    const changed = n(this.st.reviewReport!.run(status, status === 'open' ? null : clampText(by, 64), status === 'open' ? null : Math.floor(now),
      note != null ? clampText(note, 500) : null, Math.floor(id)).changes);
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

  /** True = newly added. */
  addAdmin(accountId: string, by: string, now: number): boolean {
    return this.tx(() => {
      const added = n(this.st.addAdmin!.run(accountId, Math.floor(now), clampText(by, 64)).changes) === 1;
      if (added) this.st.bumpRev!.run();
      return added;
    });
  }

  /** True = removed. */
  removeAdmin(accountId: string): boolean {
    return this.tx(() => {
      const removed = n(this.st.removeAdmin!.run(accountId).changes) === 1;
      if (removed) this.st.bumpRev!.run();
      return removed;
    });
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
   * One prune step: deletes up to PRUNE_CHUNK rows per table past the cutoffs. Returns the rows removed; call again
   * (on a later turn of the event loop) until it returns 0.
   */
  pruneStep(c: PruneCutoffs, chunk = PRUNE_CHUNK): number {
    const chat = n(this.st.pruneChat!.run(Math.floor(c.chatBefore), chunk).changes);
    const actions = n(this.st.pruneActions!.run(Math.floor(c.keepBefore), chunk).changes);
    const reports = n(this.st.pruneReports!.run(Math.floor(c.keepBefore), chunk).changes);
    const bans = n(this.st.pruneBans!.run(Math.floor(c.keepBefore), Math.floor(c.keepBefore), chunk).changes);
    return chat + actions + reports + bans;
  }

  /**
   * Delete chat-log lines older than `before` (epoch ms) — everything when `before` is in the future — optionally
   * only one player's (callsign or account username, like searchLog's `player`). The deleted rows are overwritten
   * in the file (secure_delete) and the WAL is checkpointed when possible. Reports keep their own saved lines.
   * Returns the lines deleted. (CLI: `npm run mod -- purge-log`.)
   */
  purgeChat(q: { before: number; player?: string }): number {
    this.flushAll();
    const where = ['ts < ?'];
    const args: (string | number)[] = [Math.floor(q.before)];
    if (q.player) {
      const key = nameKey(q.player);
      const acc = this.accountByUsername(q.player);
      if (acc) { where.push('(name_key = ? OR account_id = ?)'); args.push(key, acc.id); }
      else { where.push('name_key = ?'); args.push(key); }
    }
    this.db.exec('PRAGMA secure_delete = ON');
    let removed: number;
    try {
      removed = n(this.db.prepare(`DELETE FROM chat_log WHERE ${where.join(' AND ')}`).run(...args).changes);
    } finally {
      this.db.exec('PRAGMA secure_delete = OFF');
    }
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a running server holds a reader: next checkpoint */ }
    return removed;
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

  close(): void {
    if (this.closed) return;
    try { this.flushAll(); } catch (e) { this.log(`[mod] final chat-log flush failed (${this.buf.length} lines lost): ${(e as Error)?.message ?? e}`); }
    this.closed = true;
    this.buf = [];
    this.db.close();
  }
}
