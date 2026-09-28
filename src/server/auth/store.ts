// OWNER: AUTH agent. SQLite persistence for accounts, sessions and password resets (node:sqlite).
// It also owns the schema migrations, including the v0.3 loot tables that server/profile/sqliteProfiles.ts
// reads and writes over its own connection (AuthStore is constructed first and migrates).
// Only sha256(token) is ever stored for session/reset tokens; passwords only as scrypt hashes.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

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
];

export const SCHEMA_VERSION = MIGRATIONS.length;
/** Newest sessions kept per account; older ones are dropped when a new one is created. */
export const MAX_SESSIONS_PER_ACCOUNT = 20;

const ACCOUNT_COLS = 'id, username, username_lower, email, email_lower, pass_hash, created_at, last_login';

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    try {
      this.migrate();
    } catch (e) {
      // Refused (newer schema) or a failed migration (rolled back whole): don't leak the file handle.
      try { this.db.close(); } catch { /* already closed */ }
      throw e;
    }
    const p = (sql: string): StatementSync => this.db.prepare(sql);
    this.st = {
      allUsernames: p('SELECT username_lower FROM accounts'),
      byId: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`),
      byUsername: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE username_lower = ?`),
      byEmail: p(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE email_lower = ?`),
      insertAccount: p(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, last_login)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
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

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current > MIGRATIONS.length) {
      throw new Error(`auth DB schema v${current} is newer than this server understands (v${MIGRATIONS.length})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
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

  /** Throws on a UNIQUE violation (caller maps it to the generic "Username or email unavailable"). */
  insertAccount(a: AccountRow): void {
    this.st.insertAccount!.run(a.id, a.username, a.username_lower, a.email, a.email_lower, a.pass_hash, a.created_at, a.last_login);
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
