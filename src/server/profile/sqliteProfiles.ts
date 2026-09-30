// OWNER: AUTH agent. SQLite ProfileStore (docs/v0.3-proposal.md §7.2): accounts.profile_json + loot_ledger.
//
// It opens its own DatabaseSync on the auth DB file. AuthService (AuthStore) must be constructed first: it
// creates the file and runs MIGRATIONS (user_version ≥ 2 adds accounts.profile_rev + loot_ledger).
//
// Concurrency model (single server process, ARCHITECTURE.md §3c):
// - Every profile write is `UPDATE … profile_rev = profile_rev + 1 WHERE id = ? AND profile_rev = <rev>`.
//   <rev> is the rev this store last read (load) or wrote for that key, so a write that lands on a row
//   changed by anything else (another process, a hand edit) throws ProfileConflict instead of clobbering it.
//   The caller reloads (load) before writing that key again.
// - A key this store has never loaded may only be written while its stored profile is still NULL
//   (nothing to clobber). Otherwise the write throws ProfileConflict: load first.
// - commitGrants is one BEGIN IMMEDIATE transaction. The loot_ledger primary key (account_id, grant_key)
//   makes it idempotent: a grantKey already recorded returns false and writes nothing.
// - Unknown accounts: load → null; save → Error; commitGrants → false for that entry (logged).
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ProfileConflict, type GrantCommit, type ProfileStore } from '../../shared/profile/store';
import type { Profile } from '../../shared/protocol';
import { SCHEMA_VERSION } from '../auth/store';
import { protectConnection } from '../db/guard';

/** First auth schema version with the loot tables (MIGRATIONS[1]). */
export const PROFILE_SCHEMA_MIN = 2;
/** Ledger rows older than this are pruned (a grantKey is only ever retried within minutes). */
export const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LEDGER_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Sanity cap on one stored profile (a fully collected v1 profile is ~2–4 KB). */
export const MAX_PROFILE_JSON_BYTES = 256 * 1024;
/** Sanity cap on key / grantKey length (server-generated: accountId, `${matchId}#${profileKey}#${seq}`). */
const MAX_KEY_LEN = 256;

export interface SqliteProfileOptions {
  /** Default: console.log. Lines carry a "[profiles]" prefix. */
  log?: (line: string) => void;
  /** Clock for ledger created_at + pruning. Default Date.now. */
  now?: () => number;
}

export interface SqliteProfileDiagnostics {
  journalMode: string;
  foreignKeys: number;
  busyTimeout: number;
  userVersion: number;
}

export interface SqliteProfileStore extends ProfileStore {
  /** Delete ledger rows created before `now - LEDGER_TTL_MS`. Returns the rows removed. Also runs at startup and every 24 h. */
  pruneLedger(now?: number): number;
  /** Connection settings, for tests and startup logging. */
  diagnostics(): SqliteProfileDiagnostics;
  /** Idempotent. Stops the prune timer and closes this store's connection (not the AuthService's). */
  close(): void;
}

interface RevRow { profile_rev: number | bigint; empty: number | bigint }
interface LoadRow { profile_json: unknown; profile_rev: number | bigint }

function checkKey(what: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_KEY_LEN) {
    throw new TypeError(`[profiles] invalid ${what}`);
  }
  return v;
}

function encodeProfile(profile: Profile): string {
  const json = JSON.stringify(profile);
  if (typeof json !== 'string') throw new TypeError('[profiles] profile is not JSON-serializable');
  if (Buffer.byteLength(json, 'utf8') > MAX_PROFILE_JSON_BYTES) {
    throw new RangeError(`[profiles] profile exceeds ${MAX_PROFILE_JSON_BYTES} bytes`);
  }
  return json;
}

/**
 * Open the SQLite profile store on the auth DB at `dbPath`. Throws if the file does not exist, is not at
 * auth schema ≥ 2, or is newer than this server understands. Callers treat a throw as "profiles are not
 * persisted this session" (server/index.ts).
 */
export function createSqliteProfileStore(dbPath: string, opts: SqliteProfileOptions = {}): SqliteProfileStore {
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  // Never create a stray empty DB: the AuthService creates and migrates the file first.
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) {
    throw new Error(`[profiles] no auth database at ${dbPath || '(empty path)'}: construct the AuthService first`);
  }

  const db = new DatabaseSync(dbPath);
  let st: Record<'load' | 'rev' | 'update' | 'ledger' | 'prune', StatementSync>;
  try {
    // The §6.5 protections (authorizer, trusted_schema OFF) before any other statement (T-LAN-13).
    protectConnection(db);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0);
    if (version < PROFILE_SCHEMA_MIN) {
      throw new Error(`[profiles] auth DB schema v${version} has no loot tables (need v${PROFILE_SCHEMA_MIN}+): construct the AuthService first`);
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(`[profiles] auth DB schema v${version} is newer than this server understands (v${SCHEMA_VERSION})`);
    }
    st = {
      load: db.prepare('SELECT profile_json, profile_rev FROM accounts WHERE id = ?'),
      rev: db.prepare('SELECT profile_rev, profile_json IS NULL AS empty FROM accounts WHERE id = ?'),
      update: db.prepare('UPDATE accounts SET profile_json = ?, profile_rev = profile_rev + 1 WHERE id = ? AND profile_rev = ?'),
      ledger: db.prepare('INSERT OR IGNORE INTO loot_ledger (account_id, grant_key, created_at, grant_json) VALUES (?, ?, ?, ?)'),
      prune: db.prepare('DELETE FROM loot_ledger WHERE created_at < ?'),
    };
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }

  /** key → the profile_rev this store last read or wrote. */
  const revs = new Map<string, number>();
  let closed = false;

  /**
   * The rev a write of `key` must match, from a fresh row read (`row`). undefined row = unknown account.
   * Throws ProfileConflict for a key never loaded whose stored profile is not NULL.
   */
  const expectedRev = (key: string, row: RevRow): number => {
    const cached = revs.get(key);
    if (cached !== undefined) return cached;
    if (Number(row.empty) === 1) return Number(row.profile_rev);
    throw new ProfileConflict(`[profiles] account ${key} has a stored profile this store has not loaded: load it first`);
  };

  /** A write matched zero rows: the account vanished (Error) or its rev moved (ProfileConflict). */
  const writeMissed = (key: string): Error => {
    if (!st.rev.get(key)) {
      revs.delete(key);
      return new Error(`[profiles] unknown account ${key}`);
    }
    return new ProfileConflict(`[profiles] profile of account ${key} changed underneath this store: reload it`);
  };

  const pruneLedger = (at: number = now()): number => {
    const res = st.prune.run(at - LEDGER_TTL_MS);
    return Number(res.changes);
  };

  const runPrune = (when: string): void => {
    try {
      const n = pruneLedger();
      if (n > 0) log(`[profiles] pruned ${n} loot ledger row(s) older than 30 days (${when})`);
    } catch (e) {
      log(`[profiles] ledger prune failed (${when}): ${(e as Error)?.message ?? e}`);
    }
  };
  runPrune('startup');
  const pruneTimer = setInterval(() => runPrune('daily'), LEDGER_PRUNE_EVERY_MS);
  pruneTimer.unref?.();

  return {
    load(key: string): unknown | null {
      if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN) return null;
      // DB errors propagate: a failed read must never look like "no profile yet" (a later save would clobber it).
      const row = st.load.get(key) as LoadRow | undefined;
      if (!row) {
        revs.delete(key);
        return null;
      }
      revs.set(key, Number(row.profile_rev));
      const raw: unknown = row.profile_json;
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as unknown;
        } catch { /* logged below */ }
      }
      log(`[profiles] unreadable profile_json for account ${key}: treated as no profile (the next save replaces it)`);
      return null;
    },

    save(key: string, profile: Profile): void {
      checkKey('key', key);
      const json = encodeProfile(profile);
      const row = st.rev.get(key) as RevRow | undefined;
      if (!row) {
        revs.delete(key);
        throw new Error(`[profiles] unknown account ${key}`);
      }
      const rev = expectedRev(key, row);
      const res = st.update.run(json, key, rev);
      if (Number(res.changes) !== 1) throw writeMissed(key);
      revs.set(key, rev + 1);
    },

    commitGrants(batch: readonly GrantCommit[]): boolean[] {
      if (batch.length === 0) return [];
      // Validate + encode everything before taking the write lock.
      const enc = batch.map((c) => {
        checkKey('key', c.key);
        checkKey('grantKey', c.grantKey);
        const grantJson = JSON.stringify(c.grant);
        if (typeof grantJson !== 'string') throw new TypeError('[profiles] grant is not JSON-serializable');
        return { json: encodeProfile(c.profile), grantJson };
      });
      const at = now();
      const out: boolean[] = [];
      /** Revs written by this transaction; published to `revs` only after COMMIT. */
      const written = new Map<string, number>();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i]!;
          const row = st.rev.get(c.key) as RevRow | undefined;
          if (!row) {
            log(`[profiles] grant ${c.grantKey} skipped: unknown account ${c.key}`);
            out.push(false);
            continue;
          }
          const ins = st.ledger.run(c.key, c.grantKey, at, enc[i]!.grantJson);
          if (Number(ins.changes) === 0) { out.push(false); continue; } // already granted: no write
          const rev = written.get(c.key) ?? expectedRev(c.key, row);
          const upd = st.update.run(enc[i]!.json, c.key, rev);
          if (Number(upd.changes) !== 1) throw writeMissed(c.key);
          written.set(c.key, rev + 1);
          out.push(true);
        }
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
      for (const [key, rev] of written) revs.set(key, rev);
      return out;
    },

    pruneLedger,

    diagnostics(): SqliteProfileDiagnostics {
      const one = <T>(sql: string): T => db.prepare(sql).get() as T;
      return {
        journalMode: String(one<{ journal_mode: string }>('PRAGMA journal_mode').journal_mode),
        foreignKeys: Number(one<{ foreign_keys: number }>('PRAGMA foreign_keys').foreign_keys),
        busyTimeout: Number(one<{ timeout: number }>('PRAGMA busy_timeout').timeout),
        userVersion: Number(one<{ user_version: number }>('PRAGMA user_version').user_version),
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      revs.clear();
      db.close();
    },
  };
}
