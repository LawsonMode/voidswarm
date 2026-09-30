// OWNER: AUTH agent (schema v4 + backfills: LAN task B3). SQLite persistence for accounts, sessions and password
// resets (node:sqlite). It also owns the schema migrations, including the v0.3 loot tables that
// server/profile/sqliteProfiles.ts reads and writes over its own connection, the v0.4 moderation tables and the v0.6
// LAN-edition tables (schema v4, docs/LAN-EDITION-proposal.md §6.6). AuthStore is constructed first and migrates.
// Only sha256(token) is ever stored for session/reset tokens; passwords only as scrypt hashes.
// The connection is hardened by ../db/guard.ts (trusted_schema OFF, an authorizer that denies ATTACH / VACUUM INTO)
// and the schema is compared with the one these migrations build (§6.5).
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { domainToASCII } from 'node:url';
import {
  changedOutsideError, checkUntrustedDb, DbGuardError, hasAuthorizer, newerSchemaError, protectConnection,
  schemaDifferences, stageUntrustedDb, userVersion, type UntrustedCheckOptions, type UntrustedCheckResult,
} from '../db/guard';

export interface AccountRow {
  id: string;
  username: string;
  username_lower: string;
  email: string;
  email_lower: string;
  pass_hash: string;
  created_at: number;
  last_login: number | null;
}

/**
 * Each entry migrates user_version N → N+1. Append only; never edit a shipped migration.
 * Exported (read-only) so tests can build a DB exactly as an older release left it.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    email          TEXT NOT NULL,
    email_lower    TEXT NOT NULL UNIQUE,
    pass_hash      TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_login     INTEGER,
    profile_json   TEXT            -- reserved for the future loot profile
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_account ON sessions(account_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);
  CREATE TABLE resets (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX resets_account ON resets(account_id);
  `,
  // v0.3 M2 (docs/v0.3-proposal.md §8.9): loot profiles. accounts.profile_json stays NULL until the first
  // profile change; profile_rev is the optimistic-concurrency counter (server/profile/sqliteProfiles.ts);
  // loot_ledger makes each match grant idempotent (PRIMARY KEY account_id + grant_key).
  `
  ALTER TABLE accounts ADD COLUMN profile_rev INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE loot_ledger (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    grant_key  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    grant_json TEXT NOT NULL,
    PRIMARY KEY (account_id, grant_key)
  );
  CREATE INDEX loot_ledger_time ON loot_ledger(created_at);
  `,
  // Moderation (src/server/moderation/store.ts reads and writes these over its own connection; the CLI too).
  // chat_log: every human chat line and refused name attempt (filter action + hits); mod_actions: the audit trail;
  // bans: bans and mutes (scope account | address | guest; expires_at NULL = permanent); reports: /report;
  // admins: moderator accounts; mod_meta.rev: bumped on every bans / admins change so a running server notices
  // changes made by the CLI (or another connection) within seconds.
  `
  CREATE TABLE chat_log (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    room_id     TEXT,
    room_name   TEXT NOT NULL DEFAULT '',
    channel     TEXT NOT NULL,
    team        INTEGER NOT NULL DEFAULT -1,
    player_id   INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL,
    name_key    TEXT NOT NULL,
    account_id  TEXT,
    address     TEXT,
    original    TEXT NOT NULL,
    shown       TEXT NOT NULL,
    action      TEXT NOT NULL,
    hits        TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX chat_log_ts ON chat_log(ts);
  CREATE INDEX chat_log_account ON chat_log(account_id, ts);
  CREATE INDEX chat_log_address ON chat_log(address, ts);
  CREATE INDEX chat_log_name ON chat_log(name_key, ts);
  CREATE TABLE mod_actions (
    id                INTEGER PRIMARY KEY,
    ts                INTEGER NOT NULL,
    actor_account_id  TEXT NOT NULL,
    actor_name        TEXT NOT NULL DEFAULT '',
    action            TEXT NOT NULL,
    target_account_id TEXT,
    target_name       TEXT,
    target_address    TEXT,
    duration_sec      INTEGER,
    expires_at        INTEGER,
    reason            TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX mod_actions_ts ON mod_actions(ts);
  CREATE INDEX mod_actions_target ON mod_actions(target_account_id, ts);
  CREATE INDEX mod_actions_address ON mod_actions(target_address, ts);
  CREATE TABLE bans (
    id             INTEGER PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('ban', 'mute')),
    scope          TEXT NOT NULL CHECK (scope IN ('account', 'address', 'guest')),
    account_id     TEXT,
    username       TEXT,
    address_prefix TEXT,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER,
    reason         TEXT NOT NULL DEFAULT '',
    by             TEXT NOT NULL DEFAULT '',
    revoked_at     INTEGER
  );
  CREATE INDEX bans_account ON bans(account_id);
  CREATE INDEX bans_address ON bans(address_prefix);
  CREATE INDEX bans_live ON bans(revoked_at, expires_at);
  CREATE TABLE reports (
    id                  INTEGER PRIMARY KEY,
    ts                  INTEGER NOT NULL,
    reporter_player_id  INTEGER,
    reporter_name       TEXT NOT NULL,
    reporter_account_id TEXT,
    reporter_address    TEXT,
    target_player_id    INTEGER,
    target_name         TEXT NOT NULL,
    target_account_id   TEXT,
    target_address      TEXT,
    reason              TEXT NOT NULL,
    room                TEXT NOT NULL DEFAULT '',
    recent_chat_json    TEXT NOT NULL DEFAULT '[]',
    status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
    reviewed_by         TEXT,
    reviewed_at         INTEGER,
    note                TEXT
  );
  CREATE INDEX reports_ts ON reports(ts);
  CREATE INDEX reports_status ON reports(status, ts);
  CREATE INDEX reports_target ON reports(target_account_id);
  CREATE TABLE admins (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    added_at   INTEGER NOT NULL,
    added_by   TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE mod_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  );
  INSERT INTO mod_meta (k, v) VALUES ('rev', 0);
  `,
  // v0.6 LAN edition (docs/LAN-EDITION-proposal.md §6.6), verbatim from the spec. Only ADD COLUMN / CREATE TABLE /
  // CREATE INDEX / CREATE VIRTUAL TABLE / CREATE TRIGGER, so no table is rebuilt and every child row (sessions,
  // resets, loot_ledger, admins, …) survives. Account states and email verification (email_key: the address as a
  // uniqueness key, §4.3; email_hash / email_hint for hashOnly storage, §4.9), verification and reset codes, known
  // devices, the host admin and its sessions, custom terms, the room and display of each chat line, per-line tags,
  // conduct counters, flag reviews, wellbeing acks, device checks, report ids, and the FTS5 trigram index on the chat
  // log with its triggers. The JS backfills (AuthStore.backfill) run after it, idempotently.
  `
  ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | verify | approval | disabled
  ALTER TABLE accounts ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN roster INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN email_key TEXT;
  ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER;
  ALTER TABLE accounts ADD COLUMN email_hash TEXT;
  ALTER TABLE accounts ADD COLUMN email_hint TEXT;
  ALTER TABLE accounts ADD COLUMN approved_at INTEGER;
  ALTER TABLE accounts ADD COLUMN approved_by TEXT;
  CREATE UNIQUE INDEX accounts_email_key ON accounts(email_key) WHERE email_key IS NOT NULL;
  CREATE INDEX accounts_status ON accounts(status, created_at);
  CREATE TABLE email_codes (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, purpose TEXT NOT NULL,
    email TEXT NOT NULL, email_key TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 1, last_sent_at INTEGER NOT NULL, mail_error TEXT);
  CREATE TABLE email_key_fails (email_key TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (email_key, day)) WITHOUT ROWID;
  CREATE TABLE reset_codes (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, purpose TEXT NOT NULL DEFAULT 'reset',
    code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL);
  CREATE TABLE known_devices (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_hash TEXT NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (account_id, device_hash)) WITHOUT ROWID;
  CREATE TABLE host_admins (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, pass_hash TEXT,
    created_at INTEGER NOT NULL, last_login INTEGER, pass_changed_at INTEGER);
  CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    last_action INTEGER NOT NULL, reauth_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, address TEXT, via TEXT NOT NULL);
  CREATE INDEX admin_sessions_principal ON admin_sessions(principal);
  CREATE TABLE host_setup (k TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE custom_terms (id INTEGER PRIMARY KEY, term TEXT NOT NULL, term_key TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL CHECK (action IN ('block','mask','flag')), scope TEXT NOT NULL CHECK (scope IN ('chat','names','both')),
    match TEXT NOT NULL CHECK (match IN ('word','phrase','strong')), context_json TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'typed', confirmed_at INTEGER, confirmed_by TEXT,
    hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER,
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
  CREATE UNIQUE INDEX custom_terms_key ON custom_terms(term_key, scope);
  ALTER TABLE chat_log ADD COLUMN room_uid TEXT;
  ALTER TABLE chat_log ADD COLUMN display TEXT NOT NULL DEFAULT 'as-typed';
  CREATE INDEX chat_log_room ON chat_log(room_uid, id);
  CREATE TABLE chat_tags (chat_id INTEGER NOT NULL REFERENCES chat_log(id) ON DELETE CASCADE, tag TEXT NOT NULL, ts INTEGER NOT NULL,
    account_id TEXT, PRIMARY KEY (chat_id, tag)) WITHOUT ROWID;
  CREATE INDEX chat_tags_tag ON chat_tags(tag, ts);
  CREATE INDEX chat_tags_account ON chat_tags(account_id, ts);
  CREATE TABLE conduct_daily (account_key TEXT NOT NULL, day INTEGER NOT NULL, tag TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (account_key, day, tag)) WITHOUT ROWID;                    -- account id, or 'g:<name_key>' for guests
  CREATE TABLE flag_reviews (chat_id INTEGER PRIMARY KEY REFERENCES chat_log(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('ok','followup')), by TEXT NOT NULL, at INTEGER NOT NULL, note TEXT);
  CREATE TABLE wellbeing_acks (chat_id INTEGER PRIMARY KEY REFERENCES chat_log(id) ON DELETE CASCADE, acked_at INTEGER NOT NULL,
    acked_by TEXT NOT NULL, note TEXT);
  CREATE TABLE device_checks (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, browser TEXT NOT NULL, results_json TEXT NOT NULL); -- 7 days
  ALTER TABLE reports ADD COLUMN recent_ids TEXT NOT NULL DEFAULT '[]';
  CREATE VIRTUAL TABLE chat_fts USING fts5(original, shown, content='chat_log', content_rowid='id', tokenize='trigram');
  INSERT INTO chat_fts(chat_fts) VALUES('rebuild');
  CREATE TRIGGER chat_log_ai AFTER INSERT ON chat_log BEGIN
    INSERT INTO chat_fts(rowid, original, shown) VALUES (new.id, new.original, new.shown); END;
  CREATE TRIGGER chat_log_ad AFTER DELETE ON chat_log BEGIN
    INSERT INTO chat_fts(chat_fts, rowid, original, shown) VALUES ('delete', old.id, old.original, old.shown); END;
  CREATE TRIGGER chat_log_au AFTER UPDATE OF original, shown ON chat_log BEGIN
    INSERT INTO chat_fts(chat_fts, rowid, original, shown) VALUES ('delete', old.id, old.original, old.shown);
    INSERT INTO chat_fts(rowid, original, shown) VALUES (new.id, new.original, new.shown); END;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
/** The schema version that added the LAN-edition tables, the FTS index and the columns the backfills fill. */
export const SCHEMA_V4 = 4;
/** Measured cost of the v4 FTS rebuild (§6.6): about 0.5 s per 100k existing chat lines. */
export const FTS_REBUILD_MS_PER_100K = 500;

/** accounts.status (§4.5). A roster account is 'active' with roster = 1. */
export type AccountStatus = 'active' | 'verify' | 'approval' | 'disabled';
export const ACCOUNT_STATUSES: readonly AccountStatus[] = ['active', 'verify', 'approval', 'disabled'];

/**
 * The email-less sentinel (§4.9): `email = ''` and `email_lower = '#none:<id>'`. It has no '@', so login-by-email and
 * forgot can never match it, and email_lower stays UNIQUE / NOT NULL without a table rebuild.
 */
export const NO_EMAIL_PREFIX = '#none:';
export const noEmailLower = (accountId: string): string => `${NO_EMAIL_PREFIX}${accountId}`;

/**
 * "Email conflict" (§6.6): when two accounts' addresses reduce to one email_key (jdoe+x@ and jdoe@, or dots at
 * gmail.com), the earlier account keeps the key and the later one gets `email_key = '#conflict:<id>'`. It has no '@',
 * so it never matches a real key, and it keeps the unique index satisfied. The host resolves it (Accounts → email
 * conflict); a verified email change replaces it.
 */
export const EMAIL_CONFLICT_PREFIX = '#conflict:';
export const emailConflictKey = (accountId: string): string => `${EMAIL_CONFLICT_PREFIX}${accountId}`;
export const isEmailConflictKey = (key: string | null | undefined): boolean => typeof key === 'string' && key.startsWith(EMAIL_CONFLICT_PREFIX);

/** Domains whose mailboxes ignore dots in the local part (§4.3). */
const DOTLESS_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * The uniqueness key of an address (§4.3): Unicode NFC, trimmed, split at the LAST '@'; the local part lowercased with
 * any '+tag' dropped (jdoe+x@ and jdoe@ are one email) and, at gmail.com / googlemail.com only, its dots removed; the
 * domain lowercased and IDN-encoded (domainToASCII). Lenient on purpose: it also keys legacy (v3) addresses that the
 * new policy parser would reject. null = no '@' (the email-less sentinel, '').
 * B16's emailPolicy.ts must produce the same key for every address its parser accepts.
 */
export function emailKeyOf(email: string): string | null {
  const s = String(email ?? '').normalize('NFC').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase();
  const ascii = domainToASCII(domain);
  if (ascii) domain = ascii;
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (DOTLESS_DOMAINS.has(domain)) {
    const dotless = local.replace(/\./g, '');
    if (dotless) local = dotless;
  }
  return `${local}@${domain}`;
}

/** email_hash (§4.9): HMAC-SHA256(pepper, email_key), hex. The pepper is data\secrets\pepper.key (and the recovery file). */
export function emailHashOf(pepper: Uint8Array | string, emailKey: string): string {
  return createHmac('sha256', pepper).update(emailKey, 'utf8').digest('hex');
}

/**
 * A report's saved copy of one chat line (§6.4): what the other players were shown, never the original text, the
 * address or the filter's hit labels (a hit label names the words that were typed). Built from a whitelist, so
 * anything a future ChatLogRow adds stays out unless it is listed here. `hits` is always the empty list: it carries
 * nothing, and is there only so a reader that still treats saved lines as full ChatLogRows (`r.hits.filter`, the v0.5
 * moderation CLI) doesn't crash on a migrated report. `original` and `address` are absent: readers show `shown`.
 */
export interface ReportChatCopy {
  id?: number; ts?: number;
  roomId?: string | null; roomUid?: string | null; roomName?: string;
  channel?: string; team?: number; playerId?: number;
  name?: string; accountId?: string | null;
  shown?: string; action?: string; display?: string;
  hits: readonly never[];
}
/** The fields copied from a saved line (scalars only). `hits` is not copied: every copy gets `hits: []`. */
export const REPORT_COPY_FIELDS: readonly Exclude<keyof ReportChatCopy, 'hits'>[] = [
  'id', 'ts', 'roomId', 'roomUid', 'roomName', 'channel', 'team', 'playerId', 'name', 'accountId', 'shown', 'action', 'display',
];
/** Lines a report keeps (as ModStore.addReport does). */
export const REPORT_MAX_LINES = 20;

/** The shown-only copy of one saved line (null for anything that isn't an object). */
export function reportChatCopy(line: unknown): ReportChatCopy | null {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const src = line as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of REPORT_COPY_FIELDS) {
    const v = src[k];
    if (v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  out.hits = [];
  return out as unknown as ReportChatCopy;
}

/**
 * Rewrite a report's saved lines (recent_chat_json) to shown-only copies, and list their chat ids (recent_ids).
 * Unparseable JSON gives no lines (the reader already treated it as none).
 */
export function shownOnlyReportChat(json: string): { copies: ReportChatCopy[]; ids: number[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { parsed = []; }
  const lines = Array.isArray(parsed) ? parsed.slice(-REPORT_MAX_LINES) : [];
  const copies: ReportChatCopy[] = [];
  const ids: number[] = [];
  for (const line of lines) {
    const c = reportChatCopy(line);
    if (!c) continue;
    copies.push(c);
    if (typeof c.id === 'number' && Number.isInteger(c.id)) ids.push(c.id);
  }
  return { copies, ids };
}

/** What AuthStore.backfill changed (all zero on a DB that is already backfilled). */
export interface BackfillResult {
  /** accounts given their email_key */
  emailKeys: number;
  /** accounts marked "email conflict" (their key was taken by an earlier account) */
  conflicts: number;
  /** accounts given their email_hash (only with a pepper) */
  emailHashes: number;
  /** reports whose saved lines were rewritten shown-only (+ recent_ids) */
  reports: number;
}

export interface AuthStoreOptions {
  /** Where the store's notes go (the upgrade notice with its time estimate, backfill counts, schema warnings). Default: silent. */
  log?: (line: string) => void;
  /** data\secrets\pepper.key: with it, the backfill also fills email_hash = HMAC(pepper, email_key). */
  pepper?: Uint8Array | string | null;
  /**
   * Compare the schema with the one these migrations build for its version (before migrating, and after when a
   * migration ran): 'refuse' throws DbGuardError ECHANGED ("This data folder was changed outside Voidswarm."),
   * 'warn' (default) logs the differences and carries on, 'off' skips it. Data from elsewhere goes through
   * checkUntrustedAuthDb() first either way.
   */
  schemaCheck?: 'refuse' | 'warn' | 'off';
}

export interface MigrationPlan {
  /** user_version now (0 = a new, empty file) */
  from: number;
  to: number;
  /** chat lines the v4 FTS rebuild will index (0 unless the file is at v3) */
  chatLines: number;
  /** rough time for the upgrade, from FTS_REBUILD_MS_PER_100K */
  estimateMs: number;
}

export const ftsRebuildEstimateMs = (chatLines: number): number => Math.ceil((Math.max(0, chatLines) / 100_000) * FTS_REBUILD_MS_PER_100K);

/**
 * What opening this file would migrate, read-only (null = no file, or already current). For the launcher: back up
 * first when `from > 0`, and print "Upgrading the chat log index… about N s". Throws DbGuardError ENEWER for a
 * newer file.
 */
export function migrationPlan(dbPath: string): MigrationPlan | null {
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    protectConnection(db);
    db.exec('PRAGMA busy_timeout = 2000');
    const from = userVersion(db);
    if (from > SCHEMA_VERSION) throw newerSchemaError(from, SCHEMA_VERSION);
    if (from === SCHEMA_VERSION) return null;
    const chatLines = from === SCHEMA_V4 - 1 ? Number((db.prepare('SELECT COUNT(*) AS n FROM chat_log').get() as { n: number }).n) : 0;
    return { from, to: SCHEMA_VERSION, chatLines, estimateMs: ftsRebuildEstimateMs(chatLines) };
  } finally {
    db.close();
  }
}

/**
 * §6.5 check of an auth DB file from elsewhere (an import from another copy, a backup from another install), before
 * it replaces anything: read-only, protected; integrity_check; known user_version; schema identical to what
 * MIGRATIONS build for that version. Throws DbGuardError (EUNREADABLE / ENEWER / ECHANGED). host_admins,
 * admin_sessions and host_setup rows must then be dropped from the copy (guard.ts NEVER_IMPORTED_TABLES).
 */
export function checkUntrustedAuthDb(dbPath: string, opts: Omit<UntrustedCheckOptions, 'migrations'> = {}): UntrustedCheckResult {
  return checkUntrustedDb(dbPath, { ...opts, migrations: MIGRATIONS });
}

/**
 * The import path (§2.5, §6.5, T-LAN-15): snapshot another copy's auth DB (file + any -wal) into `stagedPath` and run
 * checkUntrustedAuthDb on the snapshot (guard.ts stageUntrustedDb). A refused snapshot is deleted.
 */
export function stageUntrustedAuthDb(srcPath: string, stagedPath: string, opts: Omit<UntrustedCheckOptions, 'migrations'> = {}): Promise<UntrustedCheckResult> {
  return stageUntrustedDb(srcPath, stagedPath, { ...opts, migrations: MIGRATIONS });
}

/** Newest sessions kept per account; older ones are dropped when a new one is created. */
export const MAX_SESSIONS_PER_ACCOUNT = 20;

const ACCOUNT_COLS = 'id, username, username_lower, email, email_lower, pass_hash, created_at, last_login';

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private readonly log: (line: string) => void;
  private readonly pepper: Uint8Array | string | null;
  private closed = false;

  constructor(dbPath: string, opts: AuthStoreOptions = {}) {
    this.log = opts.log ?? (() => { /* silent by default */ });
    this.pepper = opts.pepper ?? null;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      // Protections first, before any other statement (db/guard.ts; §6.5).
      protectConnection(this.db);
      if (!hasAuthorizer(this.db)) {
        this.log(`[auth] WARNING: this Node.js (${process.version}) has no SQLite authorizer, so ATTACH / VACUUM INTO are not blocked. Use Node.js 24.`);
      }
      this.db.exec('PRAGMA busy_timeout = 5000');
      // Refuse before anything writes: switching to WAL rewrites the file header, so a newer DB (and, with 'refuse',
      // a changed one) must be turned away first to stay byte-for-byte untouched.
      const schemaCheck = opts.schemaCheck ?? 'warn';
      const current = userVersion(this.db);
      if (current > MIGRATIONS.length) throw newerSchemaError(current, MIGRATIONS.length);
      this.checkSchema(schemaCheck, current);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA secure_delete = ON');
      this.migrate(current, schemaCheck);
      this.backfill();
    } catch (e) {
      // Refused (newer or changed schema) or a failed migration (rolled back whole): don't leak the file handle.
      try { this.db.close(); } catch { /* already closed */ }
      throw e;
    }
    const p = (sql: string): StatementSync => this.db.prepare(sql);
    this.st = {
      allUsernames: p('SELECT username_lower FROM accounts'),
      byId: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`),
      byUsername: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE username_lower = ?`),
      byEmail: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE email_lower = ?`),
      byEmailKey: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE email_key = ?`),
      insertAccount: p(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, last_login, email_key)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      setLastLogin: p('UPDATE accounts SET last_login = ? WHERE id = ?'),
      setPassHash: p('UPDATE accounts SET pass_hash = ? WHERE id = ?'),
      swapPassHash: p('UPDATE accounts SET pass_hash = ? WHERE id = ? AND pass_hash = ?'),
      insertSession: p('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      trimSessions: p(`DELETE FROM sessions WHERE account_id = ? AND (expires_at <= ? OR token_hash NOT IN (
                         SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?))
                       RETURNING token_hash`),
      sessionAccount: p(`SELECT s.expires_at AS s_expires, a.id, a.username, a.username_lower, a.email, a.email_lower,
                                a.pass_hash, a.created_at, a.last_login
                           FROM sessions s JOIN accounts a ON a.id = s.account_id
                          WHERE s.token_hash = ? AND s.expires_at > ?`),
      touchSession: p('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
      deleteSession: p('DELETE FROM sessions WHERE token_hash = ? RETURNING account_id'),
      deleteAccountSessions: p('DELETE FROM sessions WHERE account_id = ?'),
      deleteAccountResets: p('DELETE FROM resets WHERE account_id = ?'),
      insertReset: p('INSERT INTO resets (token_hash, account_id, expires_at, used) VALUES (?, ?, ?, 0)'),
      liveReset: p('SELECT account_id FROM resets WHERE token_hash = ? AND used = 0 AND expires_at > ?'),
      consumeReset: p('UPDATE resets SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at > ?'),
      deleteOtherResets: p('DELETE FROM resets WHERE account_id = ? AND token_hash <> ?'),
      pruneSessions: p('DELETE FROM sessions WHERE expires_at <= ?'),
      pruneResets: p('DELETE FROM resets WHERE expires_at <= ? OR used = 1'),
    };
  }

  /** Run the migrations from `current` (already version-checked and schema-compared by the constructor). */
  private migrate(current: number, schemaCheck: 'refuse' | 'warn' | 'off'): void {
    if (current === MIGRATIONS.length) return;
    const started = Date.now();
    if (current > 0) {
      const lines = current === SCHEMA_V4 - 1 ? Number((this.db.prepare('SELECT COUNT(*) AS n FROM chat_log').get() as { n: number }).n) : 0;
      const index = lines > 0
        ? `: indexing ${lines.toLocaleString('en-US')} chat line(s) for search, about ${Math.max(1, Math.round(ftsRebuildEstimateMs(lines) / 1000))} s`
        : '';
      this.log(`[auth] upgrading the database from schema v${current} to v${MIGRATIONS.length}${index}…`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        // v4 builds chat_fts with one 'rebuild' (never optimized): count those lines as owed to the start-up FTS
        // tidy (mod_meta.fts_dirty, MaintService's quiet window), or the first 1-line commits merge inline (T-PERF-2).
        if (v + 1 === SCHEMA_V4) {
          const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM chat_log').get() as { n: number }).n);
          if (n > 0) this.db.prepare("INSERT INTO mod_meta (k, v) VALUES ('fts_dirty', ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v").run(n);
        }
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    if (current > 0) this.log(`[auth] database upgraded to schema v${MIGRATIONS.length} in ${Date.now() - started} ms`);
    this.checkSchema(schemaCheck, MIGRATIONS.length);
  }

  /** The §6.5 schema comparison on this (already protected) connection. */
  private checkSchema(mode: 'refuse' | 'warn' | 'off', version: number): void {
    if (mode === 'off') return;
    let diffs: string[];
    try {
      diffs = schemaDifferences(this.db, MIGRATIONS, version);
    } catch (e) {
      if (e instanceof DbGuardError) throw e;
      const why = `the database schema could not be read for comparison (${(e as Error)?.message ?? e})`;
      if (mode === 'refuse') throw new DbGuardError('EUNREADABLE', `This is not a readable Voidswarm database (${why}).`);
      this.log(`[auth] WARNING: ${why}`);
      return;
    }
    if (!diffs.length) return;
    if (mode === 'refuse') throw changedOutsideError(diffs);
    const more = diffs.length > 6 ? `; and ${diffs.length - 6} more` : '';
    this.log(`[auth] WARNING: the database schema differs from the v${version} schema this server builds (${diffs.slice(0, 6).join('; ')}${more}). `
      + 'If this data folder came from elsewhere or was edited by hand, restore a backup.');
  }

  /**
   * The v4 JS backfills (§6.6), idempotent (the constructor runs them at every open; a no-op once done):
   * 1. email_key for every account with an address, earliest account first; an account whose key an earlier one
   *    already holds is marked "email conflict" (emailConflictKey) instead;
   * 2. with a pepper, email_hash = HMAC(pepper, email_key of the stored address) where it is missing;
   * 3. reports' saved lines rewritten shown-only (reportChatCopy), with recent_ids listing their chat ids.
   * All in one transaction.
   */
  backfill(pepper: Uint8Array | string | null = this.pepper): BackfillResult {
    const out: BackfillResult = { emailKeys: 0, conflicts: 0, emailHashes: 0, reports: 0 };
    if (userVersion(this.db) < SCHEMA_V4) return out;
    this.tx(() => {
      // 1. email_key. The sentinel ('' / '#none:<id>') has no '@' and keeps a NULL key.
      const pending = this.db.prepare(`SELECT id, email FROM accounts WHERE email_key IS NULL AND instr(email, '@') > 0
                                        ORDER BY created_at, rowid`).all() as { id: string; email: string }[];
      if (pending.length) {
        const holder = this.db.prepare('SELECT id FROM accounts WHERE email_key = ?');
        const setKey = this.db.prepare('UPDATE accounts SET email_key = ? WHERE id = ?');
        for (const a of pending) {
          const key = emailKeyOf(a.email);
          if (!key) continue;
          const other = holder.get(key) as { id: string } | undefined;
          if (other && other.id !== a.id) {
            setKey.run(emailConflictKey(a.id), a.id);
            out.conflicts++;
          } else {
            setKey.run(key, a.id);
            out.emailKeys++;
          }
        }
      }
      // 2. email_hash (needs the pepper; the key is recomputed from the address, so conflicted accounts get one too).
      if (pepper !== null && pepper !== '' && !(pepper instanceof Uint8Array && pepper.length === 0)) {
        const rows = this.db.prepare(`SELECT id, email FROM accounts WHERE email_hash IS NULL AND instr(email, '@') > 0`)
          .all() as { id: string; email: string }[];
        if (rows.length) {
          const setHash = this.db.prepare('UPDATE accounts SET email_hash = ? WHERE id = ?');
          for (const a of rows) {
            const key = emailKeyOf(a.email);
            if (!key) continue;
            setHash.run(emailHashOf(pepper, key), a.id);
            out.emailHashes++;
          }
        }
      }
      // 3. Reports. Only rows that still carry a non-whitelisted field, a non-empty hits list (the copies' own
      // `"hits":[]` removed first; inside a JSON string a quote is always escaped, so text can't fake a key), or lines
      // without their ids, are read; each is then rewritten only if its copies actually change.
      const reports = this.db.prepare(`SELECT id, recent_chat_json, recent_ids FROM reports
                                        WHERE instr(recent_chat_json, '"original":') > 0 OR instr(recent_chat_json, '"address":') > 0
                                           OR instr(replace(recent_chat_json, '"hits":[]', ''), '"hits":') > 0
                                           OR (recent_ids = '[]' AND recent_chat_json <> '[]')`)
        .all() as { id: number; recent_chat_json: string; recent_ids: string }[];
      if (reports.length) {
        const setReport = this.db.prepare('UPDATE reports SET recent_chat_json = ?, recent_ids = ? WHERE id = ?');
        for (const r of reports) {
          const { copies, ids } = shownOnlyReportChat(String(r.recent_chat_json));
          const json = JSON.stringify(copies);
          const idsJson = JSON.stringify(ids);
          if (json === r.recent_chat_json && idsJson === r.recent_ids) continue;
          setReport.run(json, idsJson, r.id);
          out.reports++;
        }
      }
    });
    if (out.emailKeys || out.conflicts || out.emailHashes || out.reports) {
      this.log(`[auth] backfill: ${out.emailKeys} email key(s), ${out.conflicts} email conflict(s)`
        + `${out.conflicts ? ' (Accounts → email conflict)' : ''}, ${out.emailHashes} email hash(es), ${out.reports} report(s) made shown-only`);
    }
    return out;
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

  allUsernamesLower(): string[] {
    return (this.st.allUsernames!.all() as { username_lower: string }[]).map((r) => r.username_lower);
  }

  accountById(id: string): AccountRow | undefined {
    return this.st.byId!.get(id) as AccountRow | undefined;
  }

  accountByUsername(usernameLower: string): AccountRow | undefined {
    return this.st.byUsername!.get(usernameLower) as AccountRow | undefined;
  }

  accountByEmail(emailLower: string): AccountRow | undefined {
    return this.st.byEmail!.get(emailLower) as AccountRow | undefined;
  }

  /** The account holding this email_key (emailKeyOf), if any. */
  accountByEmailKey(emailKey: string): AccountRow | undefined {
    return this.st.byEmailKey!.get(emailKey) as AccountRow | undefined;
  }

  /**
   * Throws on a UNIQUE violation (caller maps it to the generic "Username or email unavailable").
   * `email_key`: pass it (a key, or null) to have a taken key throw too (UNIQUE on accounts.email_key). Left out, it
   * is derived from the address (emailKeyOf), and an address whose key an earlier account holds is stored as an
   * "email conflict" (the backfill's rule) instead of failing, which keeps v3 signup behaviour until the service
   * checks keys itself.
   */
  insertAccount(a: AccountRow & { email_key?: string | null }): void {
    const explicit = a.email_key !== undefined;
    const key = explicit ? a.email_key ?? null : emailKeyOf(a.email);
    const run = (k: string | null): void => {
      this.st.insertAccount!.run(a.id, a.username, a.username_lower, a.email, a.email_lower, a.pass_hash, a.created_at, a.last_login, k);
    };
    try {
      run(key);
    } catch (e) {
      if (explicit || key === null || !String((e as Error)?.message ?? '').includes('accounts.email_key')) throw e;
      run(emailConflictKey(a.id));
    }
  }

  setLastLogin(accountId: string, t: number): void {
    this.st.setLastLogin!.run(t, accountId);
  }

  /**
   * Compare-and-swap the password hash: only replaces it if it is still `expectedOld`, so a
   * transparent rehash (of the password that was just verified) can never overwrite a password
   * reset that committed in the meantime. Returns true if the hash was replaced.
   */
  swapPassHash(accountId: string, expectedOld: string, newHash: string): boolean {
    return Number(this.st.swapPassHash!.run(newHash, accountId, expectedOld).changes) === 1;
  }

  /**
   * Insert a session and drop that account's expired / surplus sessions (atomically). Returns the
   * token hashes of the sessions that were dropped, so the caller can revoke live connections on them.
   */
  createSession(tokenHash: string, accountId: string, now: number, expiresAt: number): string[] {
    return this.tx(() => {
      this.st.insertSession!.run(tokenHash, accountId, now, expiresAt);
      const dropped = this.st.trimSessions!.all(accountId, now, accountId, MAX_SESSIONS_PER_ACCOUNT) as { token_hash: string }[];
      return dropped.map((r) => r.token_hash);
    });
  }

  /** Live session → its account (+ the session's current expiry). */
  sessionAccount(tokenHash: string, now: number): (AccountRow & { s_expires: number }) | undefined {
    return this.st.sessionAccount!.get(tokenHash, now) as (AccountRow & { s_expires: number }) | undefined;
  }

  touchSession(tokenHash: string, expiresAt: number): void {
    this.st.touchSession!.run(expiresAt, tokenHash);
  }

  /** Delete one session. Returns its account id, or undefined if no such session existed. */
  deleteSession(tokenHash: string): string | undefined {
    const row = this.st.deleteSession!.get(tokenHash) as { account_id: string } | undefined;
    return row?.account_id;
  }

  /** Issue a reset token for an account, invalidating every older one. */
  replaceReset(tokenHash: string, accountId: string, expiresAt: number): void {
    this.tx(() => {
      this.st.deleteAccountResets!.run(accountId);
      this.st.insertReset!.run(tokenHash, accountId, expiresAt);
    });
  }

  /** Account id of an unused, unexpired reset token (read-only pre-check). */
  liveResetAccount(tokenHash: string, now: number): string | undefined {
    const row = this.st.liveReset!.get(tokenHash, now) as { account_id: string } | undefined;
    return row?.account_id;
  }

  /**
   * Atomically: consume the reset token (must still be unused + unexpired), set the new password,
   * revoke ALL of the account's sessions and other resets, then create one fresh session.
   * Returns the account id, or undefined if the token was already used/expired.
   */
  completeReset(resetHash: string, passHash: string, sessionHash: string, now: number, sessionExpires: number): string | undefined {
    return this.tx(() => {
      const row = this.st.liveReset!.get(resetHash, now) as { account_id: string } | undefined;
      if (!row) return undefined;
      const res = this.st.consumeReset!.run(resetHash, now);
      if (Number(res.changes) !== 1) return undefined;
      const accountId = row.account_id;
      this.st.setPassHash!.run(passHash, accountId);
      this.st.deleteAccountSessions!.run(accountId);
      this.st.deleteOtherResets!.run(accountId, resetHash);
      this.st.insertSession!.run(sessionHash, accountId, now, sessionExpires);
      this.st.setLastLogin!.run(now, accountId);
      return accountId;
    });
  }

  /** Delete expired sessions and expired/used reset rows. */
  prune(now: number): void {
    this.st.pruneSessions!.run(now);
    this.st.pruneResets!.run(now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    this.db.close();
  }
}
