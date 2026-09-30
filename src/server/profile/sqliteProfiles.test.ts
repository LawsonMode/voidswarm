// OWNER: AUTH agent. SQLite ProfileStore acceptance (docs/v0.3-proposal.md §7.2, §9 AUTH).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileUser } from '../../shared/profile/service';
import { ProfileConflict, type GrantCommit } from '../../shared/profile/store';
import { PROFILE_VERSION, type LootGrant, type Profile } from '../../shared/protocol';
import { AuthStore, MIGRATIONS, SCHEMA_VERSION } from '../auth/store';
import {
  createSqliteProfileStore, LEDGER_PRUNE_EVERY_MS, LEDGER_TTL_MS, type SqliteProfileOptions, type SqliteProfileStore,
} from './sqliteProfiles';

const T0 = 1_780_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'voidswarm-profiles-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function addAccount(auth: AuthStore, id: string): void {
  auth.insertAccount({
    id, username: id, username_lower: id.toLowerCase(), email: `${id}@x.io`, email_lower: `${id.toLowerCase()}@x.io`,
    pass_hash: 'x', created_at: T0, last_login: null,
  });
}

/** A migrated auth DB (AuthStore constructed first, as the server does) with accounts acc1 + acc2. */
function setup(): { dir: string; dbPath: string; auth: AuthStore } {
  const dir = tempDir();
  const dbPath = join(dir, 'auth.db');
  const auth = new AuthStore(dbPath);
  cleanups.push(() => auth.close());
  addAccount(auth, 'acc1');
  addAccount(auth, 'acc2');
  return { dir, dbPath, auth };
}

function open(dbPath: string, opts: SqliteProfileOptions = {}): SqliteProfileStore & { logs: string[] } {
  const logs: string[] = [];
  const store = createSqliteProfileStore(dbPath, { log: (l) => logs.push(l), now: () => T0, ...opts });
  cleanups.push(() => store.close());
  return Object.assign(store, { logs });
}

/** Run `fn` on a separate raw connection (foreign keys ON), then close it. */
function peek<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    return fn(db);
  } finally {
    db.close();
  }
}

function row(dbPath: string, id: string): { profile_json: string | null; profile_rev: number } | undefined {
  return peek(dbPath, (db) => db.prepare('SELECT profile_json, profile_rev FROM accounts WHERE id = ?').get(id) as
    { profile_json: string | null; profile_rev: number } | undefined);
}

function ledger(dbPath: string): { account_id: string; grant_key: string; created_at: number; grant_json: string }[] {
  return peek(dbPath, (db) => db.prepare('SELECT account_id, grant_key, created_at, grant_json FROM loot_ledger ORDER BY account_id, grant_key').all() as
    { account_id: string; grant_key: string; created_at: number; grant_json: string }[]);
}

function prof(shards: number): Profile {
  return {
    v: PROFILE_VERSION, owned: {}, shards, loadout: { shared: {}, byClass: {} }, fresh: [], pity: {}, pityLegendary: 0,
    stats: { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} }, recent: [], updatedAt: T0,
  };
}

function grant(grantKey: string, shards = 5): LootGrant {
  return { grantKey, gameType: 'arena', items: [], shards, cachesSecured: 0, cachesLost: 0, epicIn: 12, legendaryIn: 60 };
}

function gc(key: string, grantKey: string, shards: number): GrantCommit {
  return { key, grantKey, grant: grant(grantKey), profile: prof(shards) };
}

const shardsOf = (dbPath: string, id: string): number | null => {
  const json = row(dbPath, id)?.profile_json;
  return json == null ? null : (JSON.parse(json) as Profile).shards;
};

describe('createSqliteProfileStore: opening', () => {
  it('opens its own WAL connection with foreign_keys ON and busy_timeout 5000 once AuthStore has migrated', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    expect(SCHEMA_VERSION).toBe(4); // v3 added the moderation tables, v4 the LAN tables (the profile store needs ≥ 2)
    expect(store.diagnostics()).toEqual({ journalMode: 'wal', foreignKeys: 1, busyTimeout: 5000, userVersion: SCHEMA_VERSION });
  });

  it('refuses a missing file or :memory: without creating a database', () => {
    const dir = tempDir();
    const missing = join(dir, 'nope', 'auth.db');
    expect(() => createSqliteProfileStore(missing)).toThrow(/construct the AuthService first/);
    expect(existsSync(missing)).toBe(false);
    expect(() => createSqliteProfileStore(':memory:')).toThrow(/construct the AuthService first/);
    expect(() => createSqliteProfileStore('')).toThrow();
  });

  it('refuses a v1 (pre-loot) auth DB and one newer than this server', () => {
    const dir = tempDir();
    const v1 = join(dir, 'v1.db');
    peek(v1, (db) => { db.exec(MIGRATIONS[0]!); db.exec('PRAGMA user_version = 1'); });
    expect(() => createSqliteProfileStore(v1)).toThrow(/schema v1 has no loot tables/);

    const { dbPath } = setup();
    peek(dbPath, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    expect(() => createSqliteProfileStore(dbPath)).toThrow(/newer than this server/);
  });
});

describe('load / save', () => {
  it('unknown account: load is null, save throws (not a conflict), commitGrants skips it', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    expect(store.load('ghost')).toBeNull();
    expect(store.load('local')).toBeNull();
    let err: unknown;
    try { store.save('ghost', prof(1)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProfileConflict);
    expect(String((err as Error).message)).toMatch(/unknown account/);
    expect(store.commitGrants([gc('ghost', 'm:1#ghost#0', 5)])).toEqual([false]);
    expect(ledger(dbPath)).toEqual([]);
    expect(store.logs.some((l) => l.includes('unknown account ghost'))).toBe(true);
  });

  it('profile_json stays NULL until the first save; save round-trips and bumps profile_rev', () => {
    const { dbPath } = setup();
    expect(row(dbPath, 'acc1')).toEqual({ profile_json: null, profile_rev: 0 });
    const store = open(dbPath);
    expect(store.load('acc1')).toBeNull();
    store.save('acc1', prof(7));
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(1);
    expect(store.load('acc1')).toEqual(prof(7));
    store.save('acc1', prof(8));
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(2);
    expect(shardsOf(dbPath, 'acc1')).toBe(8);
    expect(row(dbPath, 'acc2')).toEqual({ profile_json: null, profile_rev: 0 }); // untouched
  });

  it('corrupted profile_json loads as null (logged) and the next save replaces it', () => {
    const { dbPath } = setup();
    peek(dbPath, (db) => db.prepare("UPDATE accounts SET profile_json = '{not json', profile_rev = 4 WHERE id = 'acc1'").run());
    const store = open(dbPath);
    expect(store.load('acc1')).toBeNull();
    expect(store.logs.some((l) => l.includes('unreadable profile_json for account acc1'))).toBe(true);
    store.save('acc1', prof(3));
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(5);
    expect(store.load('acc1')).toEqual(prof(3));
  });

  it('a rev conflict throws ProfileConflict and never clobbers; reloading clears it', () => {
    const { dbPath } = setup();
    const a = open(dbPath);
    const b = open(dbPath);
    expect(a.load('acc1')).toBeNull();
    expect(b.load('acc1')).toBeNull();
    a.save('acc1', prof(1));
    expect(() => b.save('acc1', prof(2))).toThrow(ProfileConflict);
    expect(shardsOf(dbPath, 'acc1')).toBe(1);
    expect(() => b.save('acc1', prof(2))).toThrow(ProfileConflict); // still stale until it reloads
    expect(b.load('acc1')).toEqual(prof(1));
    b.save('acc1', prof(2));
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(2);
    expect(() => a.save('acc1', prof(3))).toThrow(ProfileConflict);
    expect(shardsOf(dbPath, 'acc1')).toBe(2);
  });

  it('a store may write a never-loaded key only while its stored profile is still NULL', () => {
    const { dbPath } = setup();
    const a = open(dbPath);
    a.save('acc1', prof(1)); // NULL: nothing to clobber
    const b = open(dbPath);
    expect(() => b.save('acc1', prof(9))).toThrow(ProfileConflict); // has data b never read
    expect(() => b.commitGrants([gc('acc1', 'm:1#acc1#0', 9)])).toThrow(ProfileConflict);
    expect(shardsOf(dbPath, 'acc1')).toBe(1);
    expect(ledger(dbPath)).toEqual([]);
    b.load('acc1');
    b.save('acc1', prof(9));
    expect(shardsOf(dbPath, 'acc1')).toBe(9);
  });

  it('a save that would exceed the size cap throws before touching the row', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    const big = { ...prof(1), fresh: Array.from({ length: 20_000 }, (_, i) => `x.${i}.${'y'.repeat(10)}`) };
    expect(() => store.save('acc1', big)).toThrow(RangeError);
    expect(row(dbPath, 'acc1')).toEqual({ profile_json: null, profile_rev: 0 });
  });
});

describe('commitGrants', () => {
  it('is idempotent by (account, grantKey): a replay returns false and writes nothing', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    expect(store.commitGrants([gc('acc1', 'boot:1#acc1#0', 10)])).toEqual([true]);
    expect(shardsOf(dbPath, 'acc1')).toBe(10);
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(1);
    expect(ledger(dbPath)).toEqual([
      { account_id: 'acc1', grant_key: 'boot:1#acc1#0', created_at: T0, grant_json: JSON.stringify(grant('boot:1#acc1#0')) },
    ]);

    // Replay (e.g. the retry queue after a commit that did land): no write, even with a different profile.
    expect(store.commitGrants([gc('acc1', 'boot:1#acc1#0', 99)])).toEqual([false]);
    expect(shardsOf(dbPath, 'acc1')).toBe(10);
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(1);
    expect(ledger(dbPath)).toHaveLength(1);

    // A duplicate inside one batch: only the first lands.
    expect(store.commitGrants([gc('acc1', 'boot:2#acc1#0', 20), gc('acc1', 'boot:2#acc1#0', 21)])).toEqual([true, false]);
    expect(shardsOf(dbPath, 'acc1')).toBe(20);
    expect(ledger(dbPath)).toHaveLength(2);

    // Another store (another boot) replaying an old key also gets false.
    const other = open(dbPath);
    expect(other.commitGrants([gc('acc1', 'boot:1#acc1#0', 55)])).toEqual([false]);
    expect(shardsOf(dbPath, 'acc1')).toBe(20);
  });

  it('commits many accounts in one transaction and chains the rev for two grants to one account', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    store.load('acc2');
    // A pilot who left mid-match (seq 0) and rejoined (seq 1) has two grants in the same batch.
    expect(store.commitGrants([gc('acc1', 'm#acc1#0', 5), gc('acc2', 'm#acc2#0', 6), gc('acc1', 'm#acc1#1', 11)]))
      .toEqual([true, true, true]);
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(2);
    expect(shardsOf(dbPath, 'acc1')).toBe(11);
    expect(row(dbPath, 'acc2')!.profile_rev).toBe(1);
    expect(ledger(dbPath).map((r) => r.grant_key)).toEqual(['m#acc1#0', 'm#acc1#1', 'm#acc2#0']);
    // The store's rev cache followed the commit: plain saves still pass the rev check.
    store.save('acc1', prof(12));
    store.save('acc2', prof(7));
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(3);
  });

  it('an unknown account in the batch returns false without failing the others', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    expect(store.commitGrants([gc('ghost', 'm#ghost#0', 5), gc('acc1', 'm#acc1#0', 5)])).toEqual([false, true]);
    expect(ledger(dbPath).map((r) => r.account_id)).toEqual(['acc1']);
  });

  it('a rev conflict rolls back the whole batch and throws ProfileConflict; a reload + retry lands it', () => {
    const { dbPath } = setup();
    const a = open(dbPath);
    const b = open(dbPath);
    a.load('acc1');
    a.load('acc2');
    b.load('acc1');
    b.save('acc1', prof(50)); // a's acc1 rev is now stale
    const batch = [gc('acc2', 'm#acc2#0', 6), gc('acc1', 'm#acc1#0', 5)];
    expect(() => a.commitGrants(batch)).toThrow(ProfileConflict);
    expect(ledger(dbPath)).toEqual([]); // acc2's ledger row + profile rolled back too
    expect(row(dbPath, 'acc2')).toEqual({ profile_json: null, profile_rev: 0 });
    expect(shardsOf(dbPath, 'acc1')).toBe(50);
    // The rollback did not advance a's cached rev for acc2 either.
    a.load('acc1');
    expect(a.commitGrants(batch)).toEqual([true, true]);
    expect(row(dbPath, 'acc2')!.profile_rev).toBe(1);
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(2);
  });

  it('an empty batch is a no-op; an invalid entry throws before any write', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    expect(store.commitGrants([])).toEqual([]);
    expect(() => store.commitGrants([gc('acc1', 'm#acc1#0', 5), gc('acc1', '', 5)])).toThrow(TypeError);
    expect(() => store.commitGrants([gc('acc1', 'k'.repeat(300), 5)])).toThrow(TypeError);
    expect(ledger(dbPath)).toEqual([]);
    expect(row(dbPath, 'acc1')!.profile_rev).toBe(0);
    // The store is still usable (no transaction left open).
    expect(store.commitGrants([gc('acc1', 'm#acc1#0', 5)])).toEqual([true]);
  });
});

describe('ledger lifecycle', () => {
  it('deleting an account cascades to its ledger rows', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    store.load('acc2');
    expect(store.commitGrants([gc('acc1', 'm#acc1#0', 5), gc('acc1', 'n#acc1#0', 6), gc('acc2', 'm#acc2#0', 7)]))
      .toEqual([true, true, true]);
    peek(dbPath, (db) => db.prepare("DELETE FROM accounts WHERE id = 'acc1'").run());
    expect(ledger(dbPath).map((r) => `${r.account_id}/${r.grant_key}`)).toEqual(['acc2/m#acc2#0']);
    expect(store.load('acc1')).toBeNull();
    expect(() => store.save('acc1', prof(1))).toThrow(/unknown account/);
    expect(store.commitGrants([gc('acc1', 'o#acc1#0', 5)])).toEqual([false]);
  });

  it('foreign keys are enforced: the store connection has foreign_keys = 1 and orphan ledger rows are rejected', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    store.commitGrants([gc('acc1', 'm#acc1#0', 5)]);
    // Account rows are only ever removed through a connection with foreign_keys ON (store / AuthStore / this).
    expect(store.diagnostics().foreignKeys).toBe(1);
    expect(() => peek(dbPath, (db) => db.prepare("INSERT INTO loot_ledger VALUES ('ghost', 'x', 0, '{}')").run()))
      .toThrow(/FOREIGN KEY/);
  });

  it('prunes ledger rows older than 30 days at startup and every 24 h', () => {
    const { dbPath } = setup();
    const clock = { t: T0 };
    const s1 = open(dbPath, { now: () => clock.t });
    s1.load('acc1');
    expect(s1.commitGrants([gc('acc1', 'old#acc1#0', 1)])).toEqual([true]);
    clock.t = T0 + 20 * DAY;
    expect(s1.commitGrants([gc('acc1', 'mid#acc1#0', 2)])).toEqual([true]);
    s1.close();

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    clock.t = T0 + 31 * DAY;
    const s2 = open(dbPath, { now: () => clock.t });
    expect(ledger(dbPath).map((r) => r.grant_key)).toEqual(['mid#acc1#0']); // startup prune
    expect(s2.logs.some((l) => l.includes('pruned 1 loot ledger row(s)') && l.includes('startup'))).toBe(true);

    clock.t = T0 + 20 * DAY + LEDGER_TTL_MS + 1;
    vi.advanceTimersByTime(LEDGER_PRUNE_EVERY_MS);
    expect(ledger(dbPath)).toEqual([]); // daily prune
    expect(s2.logs.some((l) => l.includes('daily'))).toBe(true);

    expect(vi.getTimerCount()).toBe(1);
    s2.close();
    s2.close(); // idempotent
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pruneLedger keeps rows exactly at the TTL boundary and reports the count', () => {
    const { dbPath } = setup();
    const store = open(dbPath);
    store.load('acc1');
    store.commitGrants([gc('acc1', 'a#acc1#0', 1)]);
    expect(store.pruneLedger(T0 + LEDGER_TTL_MS)).toBe(0);
    expect(store.pruneLedger(T0 + LEDGER_TTL_MS + 1)).toBe(1);
    expect(ledger(dbPath)).toEqual([]);
  });

  it('close leaves the AuthStore (its own connection) usable', () => {
    const { dbPath, auth } = setup();
    const store = open(dbPath);
    store.load('acc1');
    store.save('acc1', prof(1));
    store.close();
    expect(() => store.load('acc1')).toThrow();
    expect(auth.accountById('acc1')?.username).toBe('acc1');
    addAccount(auth, 'acc3');
    expect(row(dbPath, 'acc3')).toEqual({ profile_json: null, profile_rev: 0 });
  });
});

describe('with the migration path', () => {
  it('a v1 DB upgraded by AuthStore is immediately usable by the profile store', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'nested', 'auth.db');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    peek(dbPath, (db) => {
      db.exec(MIGRATIONS[0]!);
      db.exec('PRAGMA user_version = 1');
      db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, last_login)
                  VALUES ('old1', 'Old', 'old', 'o@x.io', 'o@x.io', 'x', ?, NULL)`).run(T0);
    });
    expect(() => createSqliteProfileStore(dbPath)).toThrow(/schema v1/);
    const auth = new AuthStore(dbPath);
    cleanups.push(() => auth.close());
    const store = open(dbPath);
    expect(store.diagnostics().userVersion).toBe(SCHEMA_VERSION);
    expect(row(dbPath, 'old1')).toEqual({ profile_json: null, profile_rev: 0 });
    expect(store.load('old1')).toBeNull();
    expect(store.commitGrants([gc('old1', 'm#old1#0', 4)])).toEqual([true]);
    expect(shardsOf(dbPath, 'old1')).toBe(4);
  });
});

describe('M2 integration: ProfileService on the real SQLite store', () => {
  it('a profile changed outside the process mid-match costs nobody their grant (per-entry fallback + rebase)', async () => {
    const { ProfileService } = await import('../../shared/profile/service');
    const { dbPath } = setup();
    const store = open(dbPath);
    const logs: string[] = [];
    const svc = new ProfileService(store, { now: () => T0, log: (l) => logs.push(l) });
    const mk = (playerId: number): ProfileUser => ({ playerId, sink: { sendMsg: () => {} }, profile: null, profileKey: null, profileWritable: false, opTimes: [] });
    const a = mk(1), b = mk(2);
    svc.attach(a, 'acc1');
    svc.attach(b, 'acc2');
    // B equips once so a real row exists, then someone edits B's row with the sqlite CLI (rev moves)
    b.profile = { ...b.profile!, shards: 40 };
    store.save('acc2', b.profile);
    peek(dbPath, (db) => db.prepare("UPDATE accounts SET profile_json = json_set(profile_json, '$.shards', 400), profile_rev = profile_rev + 1 WHERE id = 'acc2'").run());
    const input = (k: string) => ({ grantKey: k, gameType: 'warzone' as const, tokens: [], crateRolls: 1, shards: 10, won: false, cachesLost: 0 });
    const out = svc.grantBatch([
      { user: a, profileKey: 'acc1', input: input('boot:1#acc1#0') },
      { user: b, profileKey: 'acc2', input: input('boot:1#acc2#0') },
    ]);
    expect(out.map((o) => o.persisted)).toEqual([true, true]);
    expect(svc.queued).toBe(0);
    const ledger = peek(dbPath, (db) => db.prepare('SELECT account_id, grant_key FROM loot_ledger ORDER BY account_id').all());
    expect(ledger).toEqual([{ account_id: 'acc1', grant_key: 'boot:1#acc1#0' }, { account_id: 'acc2', grant_key: 'boot:1#acc2#0' }]);
    const pb = JSON.parse(row(dbPath, 'acc2')!.profile_json!) as Profile;
    expect(pb.shards).toBe(400 + out[1].grant.shards); // the outside edit is kept, the grant lands on top
    expect(b.profile!.shards).toBe(pb.shards);
    expect(logs.some((l) => l.includes('changed underneath'))).toBe(true);
  });
});
