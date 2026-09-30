// OWNER: AUTH store (LAN task B3). Schema v4 (docs/LAN-EDITION-proposal.md §6.6) and its backfills: T-AUTH-10
// (v3 → v4 keeps the child tables; duplicate keys get flagged; report copies are rewritten shown-only; a v5 DB is
// refused) and T-LAN-13's sqlite part on the store's own connection. Test data only (caldwellschools.org / NovaPilot).
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANGED_OUTSIDE, DbGuardError, expectedSchema, isProtected, schemaDifferences, snapshotSchema, diffSchema } from '../db/guard';
import {
  AuthStore, checkUntrustedAuthDb, emailConflictKey, emailHashOf, emailKeyOf, ftsRebuildEstimateMs, isEmailConflictKey,
  migrationPlan, MIGRATIONS, noEmailLower, REPORT_COPY_FIELDS, SCHEMA_V4, SCHEMA_VERSION, shownOnlyReportChat, stageUntrustedAuthDb,
} from './store';

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const DAY = 86_400_000;
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) { try { c(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'voidswarm-store-'));
  dirs.push(d);
  return d;
};
const openStore = (path: string, opts?: ConstructorParameters<typeof AuthStore>[1]): AuthStore => {
  const s = new AuthStore(path, opts);
  cleanups.push(() => s.close());
  return s;
};
/** The store's own connection (private in TS; the guard tests need to reach it). */
const rawDb = (s: AuthStore): DatabaseSync => (s as unknown as { db: DatabaseSync }).db;
function peek<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA foreign_keys = ON'); return fn(db); } finally { db.close(); }
}
const rows = <T>(path: string, sql: string, ...args: (string | number | null)[]): T[] => peek(path, (db) => db.prepare(sql).all(...args) as T[]);
const version = (path: string): number => peek(path, (db) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version));

/** A full ChatLogRow as v0.4 / v0.5 saved it inside reports.recent_chat_json (original text, address, hit labels). */
const savedLine = (id: number, accountId: string, name: string, original: string, shown: string, action: string, hits: string[]) => ({
  id, ts: T0 - 60_000 + id, roomId: 'r1', roomName: 'Main Arena', channel: 'all', team: 0, playerId: 3, name,
  accountId, address: '192.168.1.60', original, shown, action, hits,
});

/**
 * A DB exactly as v0.5.0 left it (schema v3): accounts whose addresses collide by key (plus-addressing, gmail dots),
 * sessions, a reset, loot, a moderator, chat lines, reports with full saved lines, a ban and an audit row.
 */
function v3Db(dir: string): string {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const p = join(dir, 'data', 'voidswarm.db');
  peek(p, (db) => {
    db.exec('PRAGMA journal_mode = WAL');
    for (let v = 0; v < 3; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 3');
    const acc = db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, last_login)
                            VALUES (?, ?, ?, ?, ?, 'scrypt$test', ?, NULL)`);
    // The later plus-address account is inserted FIRST (lower rowid): "later" means created later.
    acc.run('acc-plus', 'NovaPilot2', 'novapilot2', 'NovaPilot+games@caldwellschools.org', 'novapilot+games@caldwellschools.org', T0 - 4 * DAY);
    acc.run('acc-nova', 'NovaPilot', 'novapilot', 'NovaPilot@CaldwellSchools.org', 'novapilot@caldwellschools.org', T0 - 5 * DAY);
    acc.run('acc-dots', 'DotPilot', 'dotpilot', 'nova.pilot@gmail.com', 'nova.pilot@gmail.com', T0 - 3 * DAY);
    acc.run('acc-nodots', 'DotlessPilot', 'dotlesspilot', 'novapilot@gmail.com', 'novapilot@gmail.com', T0 - 2 * DAY);
    acc.run('acc-wing1', 'Wingmate', 'wingmate', 'wing.mate@caldwellschools.org', 'wing.mate@caldwellschools.org', T0 - DAY);
    acc.run('acc-wing2', 'Wingmate2', 'wingmate2', 'wingmate@caldwellschools.org', 'wingmate@caldwellschools.org', T0 - DAY / 2);
    db.prepare("INSERT INTO sessions VALUES ('sess-nova', 'acc-nova', ?, ?)").run(T0 - DAY, T0 + 29 * DAY);
    db.prepare("INSERT INTO sessions VALUES ('sess-plus', 'acc-plus', ?, ?)").run(T0 - DAY, T0 + 29 * DAY);
    db.prepare("INSERT INTO resets VALUES ('reset-plus', 'acc-plus', ?, 0)").run(T0 + 3_600_000);
    db.prepare("INSERT INTO loot_ledger VALUES ('acc-nova', 'm#acc-nova#0', ?, '{\"shards\":4}')").run(T0 - DAY);
    db.prepare("UPDATE accounts SET profile_json = '{\"v\":1}', profile_rev = 3 WHERE id = 'acc-nova'").run();
    db.prepare("INSERT INTO admins VALUES ('acc-nova', ?, 'cli')").run(T0 - DAY);
    const chat = db.prepare(`INSERT INTO chat_log (id, ts, room_id, room_name, channel, team, player_id, name, name_key, account_id,
                               address, original, shown, action, hits) VALUES (?, ?, 'r1', 'Main Arena', 'all', 0, 3, ?, ?, ?, '192.168.1.60', ?, ?, ?, ?)`);
    chat.run(1, T0 - 59_999, 'NovaPilot', 'novapilot', 'acc-nova', 'hello there pilots', 'hello there pilots', 'pass', '[]');
    chat.run(2, T0 - 59_998, 'NovaPilot2', 'novapilot2', 'acc-plus', 'you absolute potato', 'you absolute ******', 'mask', '["test:potato"]');
    chat.run(3, T0 - 59_997, 'NovaPilot2', 'novapilot2', 'acc-plus', 'good game everyone', 'good game everyone', 'pass', '[]');
    const saved = [
      savedLine(2, 'acc-plus', 'NovaPilot2', 'you absolute potato', 'you absolute ******', 'mask', ['test:potato']),
      savedLine(3, 'acc-plus', 'NovaPilot2', 'good game everyone', 'good game everyone', 'pass', []),
    ];
    const rep = db.prepare(`INSERT INTO reports (id, ts, reporter_player_id, reporter_name, reporter_account_id, reporter_address,
                              target_player_id, target_name, target_account_id, target_address, reason, room, recent_chat_json)
                            VALUES (?, ?, 1, 'NovaPilot', 'acc-nova', '192.168.1.61', 3, 'NovaPilot2', 'acc-plus', '192.168.1.60', 'rude', 'Main Arena', ?)`);
    rep.run(1, T0 - 30_000, JSON.stringify(saved));
    rep.run(2, T0 - 20_000, '[]');
    rep.run(3, T0 - 10_000, 'not json');
    db.prepare(`INSERT INTO bans (kind, scope, account_id, username, created_at, expires_at, reason, by)
                VALUES ('mute', 'account', 'acc-plus', 'NovaPilot2', ?, ?, 'test', 'NovaPilot')`).run(T0 - 1000, T0 + DAY);
    db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, reason)
                VALUES (?, 'acc-nova', 'NovaPilot', 'mute', 'acc-plus', 'NovaPilot2', 'test')`).run(T0 - 1000);
  });
  return p;
}

const COUNTS = ['accounts', 'sessions', 'resets', 'loot_ledger', 'admins', 'chat_log', 'reports', 'bans', 'mod_actions', 'mod_meta'] as const;
const counts = (p: string): Record<string, number> =>
  Object.fromEntries(COUNTS.map((t) => [t, Number(rows<{ n: number }>(p, `SELECT COUNT(*) AS n FROM ${t}`)[0]!.n)]));

describe('T-AUTH-10: schema v3 → v4', () => {
  it('migrates in place: every child table keeps its rows, foreign keys hold, new columns take their defaults', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    const before = counts(p);
    expect(before).toEqual({ accounts: 6, sessions: 2, resets: 1, loot_ledger: 1, admins: 1, chat_log: 3, reports: 3, bans: 1, mod_actions: 1, mod_meta: 1 });
    const logs: string[] = [];
    const store = openStore(p, { log: (l) => logs.push(l) });
    expect(SCHEMA_VERSION).toBe(SCHEMA_V4);
    expect(version(p)).toBe(4);
    // One new mod_meta row: the v4 index's lines are owed to the start-up FTS tidy (T-PERF-2).
    expect(counts(p)).toEqual({ ...before, mod_meta: before.mod_meta + 1 });
    expect(rows(p, "SELECT v FROM mod_meta WHERE k = 'fts_dirty'")).toEqual([{ v: 3 }]);
    expect(rows(p, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(rows(p, "SELECT profile_json, profile_rev FROM accounts WHERE id = 'acc-nova'")).toEqual([{ profile_json: '{"v":1}', profile_rev: 3 }]);
    expect(rows(p, 'SELECT DISTINCT status, legacy, roster, email_verified_at, email_hash, email_hint, approved_at, approved_by FROM accounts'))
      .toEqual([{ status: 'active', legacy: 0, roster: 0, email_verified_at: null, email_hash: null, email_hint: null, approved_at: null, approved_by: null }]);
    expect(rows(p, 'SELECT id, room_uid, display FROM chat_log ORDER BY id')).toEqual([1, 2, 3].map((id) => ({ id, room_uid: null, display: 'as-typed' })));
    // The store still serves the old rows: sessions, lookups by address.
    expect(store.sessionAccount('sess-nova', T0)).toMatchObject({ id: 'acc-nova', username: 'NovaPilot' });
    expect(store.accountByEmail('novapilot@caldwellschools.org')?.id).toBe('acc-nova');
    expect(store.liveResetAccount('reset-plus', T0)).toBe('acc-plus');
    // Deleting an account still cascades (no table was rebuilt, the references are intact).
    peek(p, (db) => db.prepare("DELETE FROM accounts WHERE id = 'acc-wing2'").run());
    expect(logs.some((l) => l.includes('upgrading the database from schema v3 to v4: indexing 3 chat line(s) for search, about 1 s'))).toBe(true);
    expect(logs.some((l) => /database upgraded to schema v4 in \d+ ms/.test(l))).toBe(true);
  });

  it('backfills email_key; the LATER of two accounts with one key is flagged "email conflict"', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    const logs: string[] = [];
    const store = openStore(p, { log: (l) => logs.push(l) });
    expect(rows(p, 'SELECT id, email_key FROM accounts ORDER BY created_at')).toEqual([
      { id: 'acc-nova', email_key: 'novapilot@caldwellschools.org' },
      { id: 'acc-plus', email_key: emailConflictKey('acc-plus') }, // +games is the same mailbox, created later
      { id: 'acc-dots', email_key: 'novapilot@gmail.com' },
      { id: 'acc-nodots', email_key: emailConflictKey('acc-nodots') }, // gmail ignores dots
      { id: 'acc-wing1', email_key: 'wing.mate@caldwellschools.org' }, // dots are kept elsewhere
      { id: 'acc-wing2', email_key: 'wingmate@caldwellschools.org' },
    ]);
    expect(isEmailConflictKey(emailConflictKey('acc-plus'))).toBe(true);
    expect(isEmailConflictKey('novapilot@caldwellschools.org')).toBe(false);
    expect(store.accountByEmailKey('novapilot@caldwellschools.org')?.id).toBe('acc-nova');
    expect(logs).toContain('[auth] backfill: 4 email key(s), 2 email conflict(s) (Accounts → email conflict), 0 email hash(es), 2 report(s) made shown-only'); // the full copy + the unreadable one
  });

  it('rewrites report copies shown-only (no original, address or hit labels) and records their chat ids', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    openStore(p);
    const reps = rows<{ id: number; recent_chat_json: string; recent_ids: string; reporter_address: string }>(
      p, 'SELECT id, recent_chat_json, recent_ids, reporter_address FROM reports ORDER BY id');
    const copies = JSON.parse(reps[0]!.recent_chat_json) as Record<string, unknown>[];
    expect(copies).toEqual([
      { id: 2, ts: T0 - 60_000 + 2, roomId: 'r1', roomName: 'Main Arena', channel: 'all', team: 0, playerId: 3, name: 'NovaPilot2', accountId: 'acc-plus', shown: 'you absolute ******', action: 'mask', hits: [] },
      { id: 3, ts: T0 - 60_000 + 3, roomId: 'r1', roomName: 'Main Arena', channel: 'all', team: 0, playerId: 3, name: 'NovaPilot2', accountId: 'acc-plus', shown: 'good game everyone', action: 'pass', hits: [] },
    ]);
    expect(reps[0]!.recent_chat_json).not.toContain('potato'); // neither the original nor the hit label test:potato
    expect(reps[0]!.recent_chat_json).not.toContain('192.168.1.60');
    expect(JSON.parse(reps[0]!.recent_ids)).toEqual([2, 3]);
    expect(reps[1]).toMatchObject({ recent_chat_json: '[]', recent_ids: '[]' });
    expect(reps[2]).toMatchObject({ recent_chat_json: '[]', recent_ids: '[]' }); // unreadable before, so no lines
    expect(reps[0]!.reporter_address).toBe('192.168.1.61'); // the report row itself is not this migration's business
    // The chat log keeps its originals: only the report COPIES are reduced.
    expect(rows(p, 'SELECT original FROM chat_log WHERE id = 2')).toEqual([{ original: 'you absolute potato' }]);
  });

  it('builds the FTS5 trigram index over the existing lines, and its triggers follow inserts, edits and deletes', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    openStore(p);
    const match = (q: string): number[] => rows<{ rowid: number }>(p, 'SELECT rowid FROM chat_fts WHERE chat_fts MATCH ? ORDER BY rowid', q).map((r) => r.rowid);
    expect(match('potato')).toEqual([2]); // original text of an existing line
    expect(match('"******"')).toEqual([2]); // shown text too
    expect(match('game')).toEqual([3]);
    peek(p, (db) => {
      db.prepare(`INSERT INTO chat_log (id, ts, channel, name, name_key, original, shown, action, room_uid, display)
                  VALUES (4, ?, 'all', 'Wingmate', 'wingmate', 'nice flying wingmate', 'nice flying wingmate', 'pass', 'u-1', 'as-typed')`).run(T0);
      db.prepare("UPDATE chat_log SET shown = 'good match everyone' WHERE id = 3").run();
      db.prepare('UPDATE chat_log SET address = NULL WHERE id = 1').run(); // address minimisation: no FTS churn
      db.prepare('DELETE FROM chat_log WHERE id = 2').run();
      db.exec("INSERT INTO chat_fts(chat_fts) VALUES('integrity-check')");
    });
    expect(match('flying')).toEqual([4]);
    expect(match('potato')).toEqual([]);
    expect(match('match')).toEqual([3]);
    expect(match('hello')).toEqual([1]);
  });

  it('the backfills are idempotent: reopening changes nothing and logs nothing', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    openStore(p).close();
    const snap = (): unknown => [
      rows(p, 'SELECT id, email_key, email_hash FROM accounts ORDER BY id'),
      rows(p, 'SELECT id, recent_chat_json, recent_ids FROM reports ORDER BY id'),
    ];
    const first = snap();
    const logs: string[] = [];
    const again = openStore(p, { log: (l) => logs.push(l) });
    expect(again.backfill()).toEqual({ emailKeys: 0, conflicts: 0, emailHashes: 0, reports: 0 });
    expect(snap()).toEqual(first);
    expect(logs).toEqual([]);
  });

  it('with the pepper, email_hash = HMAC(pepper, email_key) for every stored address, once', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    const pepper = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
    const store = openStore(p, { pepper });
    const got = rows<{ id: string; email: string; email_hash: string }>(p, 'SELECT id, email, email_hash FROM accounts ORDER BY id');
    expect(got).toHaveLength(6);
    for (const a of got) {
      expect(a.email_hash).toBe(createHmac('sha256', pepper).update(emailKeyOf(a.email)!).digest('hex'));
      expect(a.email_hash).toBe(emailHashOf(pepper, emailKeyOf(a.email)!));
    }
    // The two addresses of one mailbox hash alike: "find by email" finds both (the conflict included).
    const hashOf = (id: string): string => got.find((a) => a.id === id)!.email_hash;
    expect(hashOf('acc-plus')).toBe(hashOf('acc-nova'));
    expect(store.backfill()).toEqual({ emailKeys: 0, conflicts: 0, emailHashes: 0, reports: 0 });
    expect(store.backfill(null)).toEqual({ emailKeys: 0, conflicts: 0, emailHashes: 0, reports: 0 });
  });

  it('refuses a v5 DB with the friendly text and never touches it (byte for byte, even in rollback-journal mode)', () => {
    const dir = tempDir();
    const p = join(dir, 'voidswarm.db');
    // A v5 file in DELETE (rollback-journal) mode: switching it to WAL would rewrite header bytes 18/19.
    peek(p, (db) => {
      db.exec('PRAGMA journal_mode = DELETE');
      for (const m of MIGRATIONS) db.exec(m);
      db.exec('PRAGMA user_version = 5');
    });
    const before = readFileSync(p);
    expect([before[18], before[19]]).toEqual([1, 1]);
    let err: unknown;
    try { new AuthStore(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DbGuardError);
    expect((err as DbGuardError).code).toBe('ENEWER');
    expect((err as DbGuardError).message).toMatch(/newer version of Voidswarm.*schema v5 is newer than this server understands \(v4\)/);
    expect(readFileSync(p).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['voidswarm.db']); // no -wal / -shm left beside it
    expect(() => migrationPlan(p)).toThrow(expect.objectContaining({ code: 'ENEWER' }));
    expect(() => checkUntrustedAuthDb(p)).toThrow(expect.objectContaining({ code: 'ENEWER' }));
    expect(readFileSync(p).equals(before)).toBe(true);
    expect(version(p)).toBe(5);
  });

  it("schemaCheck 'refuse' leaves a changed rollback-journal file byte for byte as it was", () => {
    const dir = tempDir();
    const p = join(dir, 'voidswarm.db');
    peek(p, (db) => {
      db.exec('PRAGMA journal_mode = DELETE');
      for (let v = 0; v < 3; v++) db.exec(MIGRATIONS[v]!);
      db.exec('PRAGMA user_version = 3');
      db.exec('CREATE TABLE stash (x)');
    });
    const before = readFileSync(p);
    expect(() => new AuthStore(p, { schemaCheck: 'refuse' })).toThrow(expect.objectContaining({ code: 'ECHANGED' }));
    expect(readFileSync(p).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['voidswarm.db']);
  });

  it('a v4 migration that fails part-way is rolled back whole (the DB stays a working v3)', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    peek(p, (db) => db.exec('CREATE TABLE email_codes (x INTEGER)')); // collides with the v4 CREATE TABLE
    const logs: string[] = [];
    expect(() => new AuthStore(p, { log: (l) => logs.push(l) })).toThrow(/email_codes/);
    expect(logs.some((l) => l.includes('WARNING: the database schema differs') && l.includes('extra table email_codes'))).toBe(true);
    expect(version(p)).toBe(3);
    const cols = rows<{ name: string }>(p, "SELECT name FROM pragma_table_info('accounts')").map((c) => c.name);
    expect(cols).not.toContain('status');
    expect(rows(p, "SELECT name FROM sqlite_schema WHERE name LIKE 'chat_fts%'")).toEqual([]);
    expect(counts(p).sessions).toBe(2);
  });

  it("schemaCheck 'refuse': a changed data folder is refused before any migration", () => {
    const dir = tempDir();
    const p = v3Db(dir);
    peek(p, (db) => db.exec('CREATE TRIGGER planted AFTER INSERT ON chat_log BEGIN DELETE FROM bans; END'));
    let err: unknown;
    try { new AuthStore(p, { schemaCheck: 'refuse' }); } catch (e) { err = e; }
    expect((err as DbGuardError).code).toBe('ECHANGED');
    expect((err as DbGuardError).message).toBe(`${CHANGED_OUTSIDE} (extra trigger planted)`);
    expect(version(p)).toBe(3);
    // 'off' skips the comparison entirely (the migration itself still runs).
    openStore(p, { schemaCheck: 'off' }).close();
    expect(version(p)).toBe(4);
  });
});

describe('schema v4 shape', () => {
  it('every path to v4 (new file, v1, v2, v3) ends with the same schema, which matches the reference', () => {
    const dir = tempDir();
    const reference = expectedSchema(MIGRATIONS, SCHEMA_VERSION);
    for (const from of [0, 1, 2, 3]) {
      const p = join(dir, `from-v${from}.db`);
      peek(p, (db) => { for (let v = 0; v < from; v++) db.exec(MIGRATIONS[v]!); db.exec(`PRAGMA user_version = ${from}`); });
      const logs: string[] = [];
      const s = openStore(p, { schemaCheck: 'refuse', log: (l) => logs.push(l) });
      expect(diffSchema(reference, snapshotSchema(rawDb(s)))).toEqual([]);
      expect(schemaDifferences(rawDb(s), MIGRATIONS)).toEqual([]);
      expect(logs.filter((l) => l.includes('WARNING'))).toEqual([]);
    }
    const names = [...reference.values()].map((o) => `${o.type} ${o.name}`);
    for (const t of ['email_codes', 'email_key_fails', 'reset_codes', 'known_devices', 'host_admins', 'admin_sessions', 'host_setup',
      'custom_terms', 'chat_tags', 'conduct_daily', 'flag_reviews', 'wellbeing_acks', 'device_checks', 'chat_fts']) {
      expect(names).toContain(`table ${t}`);
    }
    for (const i of ['accounts_email_key', 'accounts_status', 'admin_sessions_principal', 'custom_terms_key', 'chat_log_room', 'chat_tags_tag', 'chat_tags_account']) {
      expect(names).toContain(`index ${i}`);
    }
    for (const t of ['chat_log_ai', 'chat_log_ad', 'chat_log_au']) expect(names).toContain(`trigger ${t}`);
  });

  it('v4 is additive only (§6.6): ADD COLUMN, CREATE TABLE / INDEX / VIRTUAL TABLE / TRIGGER, and the one FTS rebuild', () => {
    /** Top-level statements of a migration (comments dropped; a CREATE TRIGGER runs to its END). */
    const statements = (sql: string): string[] => {
      const out: string[] = [];
      let cur = '';
      for (const part of sql.replace(/--[^\n]*/g, '').split(';')) {
        cur += `${part};`;
        const t = cur.trim().replace(/\s+/g, ' ');
        if (t === ';') { cur = ''; continue; }
        if (/^CREATE TRIGGER\b/i.test(t) && !/\bEND;$/i.test(t)) continue;
        out.push(t);
        cur = '';
      }
      return out;
    };
    const v4 = statements(MIGRATIONS[SCHEMA_V4 - 1]!);
    const allowed = [/^ALTER TABLE \w+ ADD COLUMN /, /^CREATE (UNIQUE )?INDEX /, /^CREATE TABLE /, /^CREATE VIRTUAL TABLE /, /^CREATE TRIGGER /];
    const rebuild = "INSERT INTO chat_fts(chat_fts) VALUES('rebuild');";
    expect(v4.filter((s) => s !== rebuild && !allowed.some((re) => re.test(s)))).toEqual([]);
    expect(v4.filter((s) => s === rebuild)).toHaveLength(1);
    expect(v4.filter((s) => /^ALTER TABLE/.test(s))).toHaveLength(12); // 9 on accounts, 2 on chat_log, 1 on reports
    expect(v4.filter((s) => /^CREATE TRIGGER/.test(s))).toHaveLength(3);
    // The draft's FTS5 secure-delete was dropped after measuring (§0 fact 4): purges would be 30–130× slower.
    expect(MIGRATIONS[SCHEMA_V4 - 1]).not.toMatch(/secure-delete/i);
  });

  it('the v4 CHECK constraints and cascades hold', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    openStore(p).close();
    peek(p, (db) => {
      const term = db.prepare(`INSERT INTO custom_terms (term, term_key, action, scope, match, created_at, created_by, updated_at, updated_by)
                               VALUES ('placeholder', 'placeholder', ?, 'chat', 'word', 1, 'host', 1, 'host')`);
      expect(() => term.run('explode')).toThrow(/CHECK/);
      term.run('flag');
      db.prepare("INSERT INTO chat_tags (chat_id, tag, ts, account_id) VALUES (2, 'PROFANITY', 1, 'acc-plus')").run();
      db.prepare("INSERT INTO flag_reviews (chat_id, status, by, at) VALUES (2, 'ok', 'host', 1)").run();
      db.prepare("INSERT INTO email_codes (account_id, purpose, email, email_key, code_hash, created_at, expires_at, last_sent_at) VALUES ('acc-plus', 'verify', 'x@caldwellschools.org', 'x@caldwellschools.org', 'h', 1, 2, 1)").run();
      db.prepare('DELETE FROM chat_log WHERE id = 2').run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_tags').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM flag_reviews').get()).toEqual({ n: 0 });
      db.prepare("DELETE FROM accounts WHERE id = 'acc-plus'").run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM email_codes').get()).toEqual({ n: 0 });
    });
  });
});

describe('T-LAN-13 (sqlite part): the store connection is protected', () => {
  it('denies ATTACH and VACUUM INTO, keeps trusted_schema OFF and secure_delete ON', () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'data', 'voidswarm.db'));
    const db = rawDb(store);
    expect(isProtected(db)).toBe(true);
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const outside = join(dir, 'outside.db').replace(/'/g, "''");
    expect(() => db.exec(`ATTACH '${outside}' AS x`)).toThrow(/not authorized/);
    expect(() => db.exec(`VACUUM INTO '${outside}'`)).toThrow(/authoriz/);
    expect(() => db.exec('PRAGMA trusted_schema = ON')).toThrow(/not authorized/);
  });

  it('the v4 FTS5 triggers run on the protected connection (trusted_schema OFF): insert, edit, delete', () => {
    const dir = tempDir();
    const store = openStore(v3Db(dir));
    const db = rawDb(store);
    expect(isProtected(db)).toBe(true);
    db.prepare(`INSERT INTO chat_log (id, ts, channel, name, name_key, original, shown, action, room_uid, display)
                VALUES (10, ?, 'all', 'Wingmate', 'wingmate', 'formation on me', 'formation on me', 'pass', 'u-1', 'as-typed')`).run(T0);
    db.prepare("UPDATE chat_log SET shown = 'Great flying, everyone!', display = 'substituted' WHERE id = 10").run();
    db.prepare('DELETE FROM chat_log WHERE id = 1').run();
    db.exec("INSERT INTO chat_fts(chat_fts) VALUES('integrity-check')");
    const match = (q: string): number[] => (db.prepare('SELECT rowid FROM chat_fts WHERE chat_fts MATCH ? ORDER BY rowid').all(q) as { rowid: number }[])
      .map((r) => r.rowid);
    expect(match('formation')).toEqual([10]); // the original stays searchable (host only)
    expect(match('flying')).toEqual([10]); // and the substituted shown text
    expect(match('hello')).toEqual([]);
    db.exec("INSERT INTO chat_fts(chat_fts) VALUES('optimize')"); // the quiet-window cleanup (§5.16) is allowed too
  });
});

describe('stageUntrustedAuthDb (T-LAN-15 building block: import from a sibling copy)', () => {
  it('refuses a sibling DB with a planted trigger; a clean one stages, keeps its rows and then opens normally', async () => {
    const dir = tempDir();
    const planted = v3Db(join(dir, 'planted'));
    peek(planted, (db) => db.exec('CREATE TRIGGER copy_out AFTER INSERT ON chat_log BEGIN UPDATE accounts SET pass_hash = new.original; END'));
    mkdirSync(join(dir, 'here', 'data'), { recursive: true });
    const staged = join(dir, 'here', 'data', 'import.staged.db');
    await expect(stageUntrustedAuthDb(planted, staged))
      .rejects.toThrow(expect.objectContaining({ code: 'ECHANGED', message: `${CHANGED_OUTSIDE} (extra trigger copy_out)` }));
    const clean = v3Db(join(dir, 'clean'));
    await expect(stageUntrustedAuthDb(clean, staged)).resolves.toEqual({ version: 3, needsMigration: true });
    const s = openStore(staged, { schemaCheck: 'refuse' });
    expect(s.accountByUsername('novapilot')?.id).toBe('acc-nova');
    expect(version(staged)).toBe(4);
  });
});

describe('§6.5 on the real v4 schema: a planted copy is refused (import and own-open refuse)', () => {
  /** A clean v4 file, then `edit` on a raw (unprotected, defensive off) connection: what an attacker's copy can hold. */
  function plantedV4(edit: (db: DatabaseSync, sqlOf: (name: string) => string) => void): string {
    const dir = tempDir();
    const p = join(dir, 'data', 'voidswarm.db');
    openStore(p).close();
    peek(p, (db) => {
      (db as unknown as { enableDefensive(on: boolean): void }).enableDefensive(false);
      edit(db, (name) => (db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name) as { sql: string }).sql);
    });
    return p;
  }
  const replaceTrigger = (db: DatabaseSync, name: string, sql: string): void => { db.exec(`DROP TRIGGER ${name}`); db.exec(sql); };
  const refusedWith = (p: string, diff: string): void => {
    let err: unknown;
    try { checkUntrustedAuthDb(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DbGuardError);
    expect(err).toMatchObject({ code: 'ECHANGED', differences: [diff] });
    expect((err as DbGuardError).message.startsWith(CHANGED_OUTSIDE)).toBe(true);
  };

  it('a no-break space in the insert trigger (every chat insert would fail) is a changed trigger', () => {
    const p = plantedV4((db, sqlOf) => replaceTrigger(db, 'chat_log_ai', sqlOf('chat_log_ai').replace('new.original, new.shown', 'new.original, new.shown')));
    refusedWith(p, 'changed trigger chat_log_ai');
    expect(() => new AuthStore(p, { schemaCheck: 'refuse' })).toThrow(expect.objectContaining({ code: 'ECHANGED' }));
  });

  it('a no-break space in UPDATE OF (edits would stop re-indexing) is a changed trigger', () => {
    const p = plantedV4((db, sqlOf) => replaceTrigger(db, 'chat_log_au', sqlOf('chat_log_au').replace('OF original, shown', 'OF original, shown')));
    refusedWith(p, 'changed trigger chat_log_au');
  });

  it.each([
    ['U+2028', ' '], ['U+FEFF', '﻿'], ['U+3000', '　'],
  ])('a %s in place of a space in the delete trigger (purges would fail) is a changed trigger', (_what, ch) => {
    const p = plantedV4((db, sqlOf) => replaceTrigger(db, 'chat_log_ad', sqlOf('chat_log_ad').replace('old.original, old.shown', `old.original,${ch}old.shown`)));
    refusedWith(p, 'changed trigger chat_log_ad');
  });

  it('a CHECK planted in an FTS5 shadow table (chat logging would stop after N lines) is a changed table', () => {
    const p = plantedV4((db, sqlOf) => {
      db.exec('PRAGMA writable_schema = ON');
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'chat_fts_docsize'").run(sqlOf('chat_fts_docsize').replace(/\)\s*$/, ', CHECK (id < 3))'));
      db.exec('PRAGMA writable_schema = OFF');
    });
    refusedWith(p, 'changed table chat_fts_docsize');
  });

  it("FTS5 secure-delete switched back on (purges 30–130× slower, §0 fact 4) is refused as changed FTS settings", () => {
    const p = plantedV4((db) => db.exec("INSERT INTO chat_fts(chat_fts, rank) VALUES('secure-delete', 1)"));
    refusedWith(p, 'changed fts settings chat_fts_config');
    const q = plantedV4((db) => db.exec("INSERT INTO chat_fts(chat_fts, rank) VALUES('automerge', 40)"));
    refusedWith(q, 'changed fts settings chat_fts_config');
  });

  it('crafted planner statistics come through the check but are dropped from the staged copy', async () => {
    const p = plantedV4((db) => {
      db.exec('ANALYZE');
      db.exec("DELETE FROM sqlite_stat1; INSERT INTO sqlite_stat1 VALUES ('chat_log', 'chat_log_ts', '1000000 1')");
    });
    expect(checkUntrustedAuthDb(p)).toEqual({ version: 4, needsMigration: false });
    const staged = join(tempDir(), 'import.staged.db');
    await expect(stageUntrustedAuthDb(p, staged)).resolves.toEqual({ version: 4, needsMigration: false });
    expect(rows(staged, "SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_stat%'")).toEqual([]);
    expect(checkUntrustedAuthDb(staged)).toEqual({ version: 4, needsMigration: false });
    expect(counts(staged).mod_meta).toBe(1); // the rest came across
  });
});

describe('insertAccount and email_key', () => {
  it('derives the key; a key an earlier account holds becomes an email conflict; an explicit key must be free', () => {
    const store = openStore(':memory:');
    const db = rawDb(store);
    const base = { pass_hash: 'scrypt$test', created_at: T0, last_login: null };
    store.insertAccount({ ...base, id: 'a1', username: 'NovaPilot', username_lower: 'novapilot', email: 'NovaPilot@caldwellschools.org', email_lower: 'novapilot@caldwellschools.org' });
    store.insertAccount({ ...base, id: 'a2', username: 'NovaPilot2', username_lower: 'novapilot2', email: 'novapilot+x@caldwellschools.org', email_lower: 'novapilot+x@caldwellschools.org' });
    expect(() => store.insertAccount({ ...base, id: 'a3', username: 'NovaPilot3', username_lower: 'novapilot3', email: 'novapilot+y@caldwellschools.org',
      email_lower: 'novapilot+y@caldwellschools.org', email_key: 'novapilot@caldwellschools.org' })).toThrow(/UNIQUE constraint failed: accounts\.email_key/);
    // Username / email_lower violations still throw (the service maps them to its generic 409).
    expect(() => store.insertAccount({ ...base, id: 'a4', username: 'novapilot', username_lower: 'novapilot', email: 'other@caldwellschools.org', email_lower: 'other@caldwellschools.org' }))
      .toThrow(/username_lower/);
    expect(() => store.insertAccount({ ...base, id: 'a5', username: 'Fresh', username_lower: 'fresh', email: 'NOVAPILOT@caldwellschools.org', email_lower: 'novapilot@caldwellschools.org' }))
      .toThrow(/email_lower/);
    // Email-less accounts (Optional mode): '' + the sentinel, NULL key, as many as needed.
    for (const id of ['n1', 'n2']) store.insertAccount({ ...base, id, username: `Nomail${id}`, username_lower: `nomail${id}`, email: '', email_lower: noEmailLower(id) });
    expect(db.prepare('SELECT id, email_key FROM accounts ORDER BY id').all()).toEqual([
      { id: 'a1', email_key: 'novapilot@caldwellschools.org' },
      { id: 'a2', email_key: emailConflictKey('a2') },
      { id: 'n1', email_key: null },
      { id: 'n2', email_key: null },
    ]);
    expect(store.accountByEmail(noEmailLower('n1'))?.id).toBe('n1');
    expect(store.accountByEmail('')).toBeUndefined();
  });

  it.each([
    ['NovaPilot@CaldwellSchools.org', 'novapilot@caldwellschools.org'],
    ['  jdoe+games@caldwellschools.org ', 'jdoe@caldwellschools.org'],
    ['j.doe@caldwellschools.org', 'j.doe@caldwellschools.org'],
    ['J.Doe+x@gmail.com', 'jdoe@gmail.com'],
    ['j.d.o.e@GoogleMail.com', 'jdoe@googlemail.com'],
    ['nova@bücher.example', 'nova@xn--bcher-kva.example'],
    ['nova@xn--bcher-kva.example', 'nova@xn--bcher-kva.example'],
    ['école@caldwellschools.org', 'école@caldwellschools.org'], // NFC
    ['odd@name@caldwellschools.org', 'odd@name@caldwellschools.org'], // split at the LAST '@'
    ['+tag@caldwellschools.org', '+tag@caldwellschools.org'], // nothing before the '+': kept
    ['...@gmail.com', '...@gmail.com'], // nothing left without the dots: kept
  ])('emailKeyOf(%j) = %j', (email, key) => {
    expect(emailKeyOf(email)).toBe(key);
  });

  it.each(['', '#none:abc', 'no-at-sign', 'x@', '@caldwellschools.org'])('emailKeyOf(%j) = null', (email) => {
    expect(emailKeyOf(email)).toBeNull();
  });
});

describe('shown-only report copies', () => {
  it('keeps only whitelisted scalar fields, the last 20 lines, and their integer ids', () => {
    const lines = Array.from({ length: 25 }, (_, i) => ({
      ...savedLine(i + 1, 'acc', 'NovaPilot', `original ${i}`, `shown ${i}`, 'pass', ['x']), extra: { nested: true }, roomUid: 'u-9', display: 'as-typed',
    }));
    const { copies, ids } = shownOnlyReportChat(JSON.stringify([...lines, 'junk', null, { id: 1.5, shown: 'odd' }]));
    expect(ids).toEqual([...Array.from({ length: 17 }, (_, i) => i + 9)]);
    expect(copies).toHaveLength(18);
    for (const c of copies) {
      for (const k of Object.keys(c)) if (k !== 'hits') expect(REPORT_COPY_FIELDS).toContain(k);
      expect(c.hits).toEqual([]); // always empty: no hit label ever comes across
    }
    expect(copies[0]).toMatchObject({ id: 9, shown: 'shown 8', roomUid: 'u-9', display: 'as-typed' });
    expect(JSON.stringify(copies)).not.toMatch(/original|address|nested|"x"/);
    expect(shownOnlyReportChat('{"not":"an array"}')).toEqual({ copies: [], ids: [] });
  });

  it('a report whose own line text looks like a hits key is rewritten once, then left alone', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    const tricky = savedLine(3, 'acc-plus', 'NovaPilot2', 'say "hits":["x"] ok', 'say "hits":["x"] ok', 'pass', []);
    peek(p, (db) => db.prepare('UPDATE reports SET recent_chat_json = ? WHERE id = 2').run(JSON.stringify([tricky])));
    openStore(p).close();
    const after = rows<{ recent_chat_json: string; recent_ids: string }>(p, 'SELECT recent_chat_json, recent_ids FROM reports WHERE id = 2')[0]!;
    expect(JSON.parse(after.recent_chat_json)).toEqual([expect.objectContaining({ id: 3, shown: 'say "hits":["x"] ok', hits: [] })]);
    expect(after.recent_chat_json).not.toContain('192.168.1.60');
    const again = openStore(p);
    expect(again.backfill()).toEqual({ emailKeys: 0, conflicts: 0, emailHashes: 0, reports: 0 });
  });

  it('the v0.5 moderation CLI still lists reports after the migration (shown-only copies, no crash, no original)', async () => {
    const dir = tempDir();
    const p = v3Db(dir);
    openStore(p).close(); // the v4 migration + backfill
    const { runCli } = await import('../moderation/cliCore');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['reports'], { out: (s) => out.push(s), err: (s) => err.push(s), env: { DB_PATH: p }, now: () => T0 });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('you absolute ******');
    expect(text).not.toContain('potato');
    expect(text).not.toContain('192.168.1.60');
  });
});

describe('migrationPlan and checkUntrustedAuthDb', () => {
  it('reports what an open would migrate, read-only', () => {
    const dir = tempDir();
    expect(migrationPlan(join(dir, 'missing.db'))).toBeNull();
    const p = v3Db(dir);
    expect(migrationPlan(p)).toEqual({ from: 3, to: 4, chatLines: 3, estimateMs: 1 });
    expect(version(p)).toBe(3);
    expect(ftsRebuildEstimateMs(100_000)).toBe(500);
    expect(ftsRebuildEstimateMs(1_000_000)).toBe(5000);
    openStore(p).close();
    expect(migrationPlan(p)).toBeNull();
    const empty = join(dir, 'empty.db');
    peek(empty, () => undefined);
    expect(migrationPlan(empty)).toEqual({ from: 0, to: 4, chatLines: 0, estimateMs: 0 });
  });

  it('accepts clean v3 and v4 files and refuses a planted one (§6.5)', () => {
    const dir = tempDir();
    const p = v3Db(dir);
    expect(checkUntrustedAuthDb(p)).toEqual({ version: 3, needsMigration: true });
    openStore(p).close();
    expect(checkUntrustedAuthDb(p)).toEqual({ version: 4, needsMigration: false });
    peek(p, (db) => db.exec("CREATE VIEW everything AS SELECT email FROM accounts"));
    expect(() => checkUntrustedAuthDb(p)).toThrow(expect.objectContaining({ code: 'ECHANGED', message: `${CHANGED_OUTSIDE} (extra view everything)` }));
  });
});
