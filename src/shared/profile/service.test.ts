// LOOT: ProfileService (docs/v0.3-proposal.md §7.3 grant flow, §7.4 rate limit / double grants / read-only).
import { describe, expect, it } from 'vitest';
import { PROFILE_VERSION, type Profile, type ServerMsg } from '../protocol';
import type { CacheToken, GameType } from '../types';
import { PROFILE_OPS_BURST, PROFILE_OPS_WINDOW_MS, SALVAGE_VALUE } from '../data/loot';
import { defaultProfile } from './profile';
import { grantRng, rollGrant, type GrantInput } from './rolls';
import { GRANT_RETRY_PASSES, LOOT_NOT_SAVED_MSG, PROFILE_OPS_SLOW_MSG, ProfileService, type ProfileGrantEntry, type ProfileUser } from './service';
import { MemoryProfileStore, ProfileConflict, type GrantCommit } from './store';

const NOW = 1_700_000_000_000;

class CountingStore extends MemoryProfileStore {
  commits = 0;
  override commitGrants(batch: readonly GrantCommit[]): boolean[] { this.commits++; return super.commitGrants(batch); }
}

interface TestUser extends ProfileUser { msgs: ServerMsg[] }
function mkUser(playerId: number): TestUser {
  const msgs: ServerMsg[] = [];
  return { playerId, msgs, sink: { sendMsg: (m) => { msgs.push(m); } }, profile: null, profileKey: null, profileWritable: false, opTimes: [] };
}
const profileMsgs = (u: TestUser) => u.msgs.filter((m): m is Extract<ServerMsg, { type: 'profile' }> => m.type === 'profile');
const errors = (u: TestUser) => u.msgs.filter((m): m is Extract<ServerMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);
const owned = (p: Profile | null | undefined): string[] => Object.keys(p?.owned ?? {}).sort();

function setup(store: MemoryProfileStore | null = new CountingStore(), seeded = false) {
  let t = NOW;
  const logs: string[] = [];
  // seeded: the reproducible §6.6 stream (rolls.grantRng) instead of the default server-salted one.
  const svc = new ProfileService(store, { now: () => t, log: (l) => logs.push(l), ...(seeded ? { rollRng: grantRng } : {}) });
  return { svc, store, logs, advance: (ms: number) => { t += ms; }, now: () => t };
}
const input = (grantKey: string, o: Partial<GrantInput> = {}): GrantInput => ({
  grantKey, gameType: 'dungeon', tokens: [], crateRolls: 0, shards: 10, won: false, cachesLost: 0, ...o,
});
const riftTokens: CacheToken[] = [
  { rarity: 3, set: 'rift', source: 'bossCache' }, { rarity: 2, set: 'rift', source: 'bossCache' }, { rarity: 1, set: 'common', source: 'keyChest' },
];
const withItem = (id: string, extra: Partial<Profile> = {}): Profile => ({ ...defaultProfile(NOW), owned: { [id]: { at: 1, src: 'dungeon' } }, ...extra });

describe('attach', () => {
  it('account: loads + normalizes, sets the user fields, sends profile {persisted: true}, writes nothing', () => {
    const { svc, store } = setup();
    const u = mkUser(1);
    svc.attach(u, 'acct-1');
    expect(u.profileKey).toBe('acct-1');
    expect(u.profileWritable).toBe(true);
    expect(u.profile).toEqual(defaultProfile(NOW));
    expect(profileMsgs(u)).toEqual([{ type: 'profile', profile: u.profile, persisted: true }]);
    expect(store!.writes).toBe(0);
    expect(store!.load('acct-1')).toBeNull(); // profile_json stays NULL until the first change
  });

  it("offline 'local' uses the injected store like an account", () => {
    const store = new MemoryProfileStore();
    store.save('local', withItem('rift.hull.brute', { shards: 42 }));
    const { svc } = setup(store);
    const u = mkUser(1);
    svc.attach(u, 'local');
    expect(u.profile?.shards).toBe(42);
    expect(owned(u.profile)).toEqual(['rift.hull.brute']);
    expect(profileMsgs(u)[0].persisted).toBe(true);
  });

  it('online guests never get a profile message', () => {
    const { svc } = setup();
    for (const key of [null, 'guest:7']) {
      const u = mkUser(7);
      svc.attach(u, key);
      expect(u.profile).toBeNull();
      expect(u.profileKey).toBeNull();
      expect(u.msgs).toEqual([]);
      expect(svc.handle(u, { type: 'equip', slot: 'engine', itemId: '' })).toBe(false);
      expect(u.msgs).toEqual([]);
    }
  });

  it('a newer-version profile is read-only for the session: never written', () => {
    const store = new CountingStore();
    store.save('acct-2', { ...withItem('com.engine.aurora'), v: PROFILE_VERSION + 1 } as Profile);
    const w0 = store.writes;
    const { svc } = setup(store);
    const u = mkUser(2);
    svc.attach(u, 'acct-2');
    expect(u.profileWritable).toBe(false);
    expect(profileMsgs(u)[0].persisted).toBe(false);
    expect(svc.handle(u, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' })).toBe(true);
    expect(u.profile?.loadout.shared.engine).toBe('com.engine.aurora'); // session only
    const [out] = svc.grantBatch([{ user: u, profileKey: 'acct-2', input: input('m:1#acct-2#0', { tokens: riftTokens }) }]);
    expect(out.persisted).toBe(false);
    expect(out.grant.items.length).toBe(3);
    expect(u.profile?.loadout.shared.engine).toBe('com.engine.aurora'); // grant built on the session copy
    expect(owned(u.profile).length).toBeGreaterThan(1);
    expect(store.writes).toBe(w0);
    expect(store.commits).toBe(0);
    expect((store.load('acct-2') as Profile).v).toBe(PROFILE_VERSION + 1);
  });

  it('a failed load never leads to a blind write; a later grant heals the session from a fresh read', () => {
    const store = new CountingStore();
    store.save('acct-3', withItem('com.engine.aurora', { shards: 3 }));
    const w0 = store.writes;
    store.failLoads = true;
    const { svc, logs } = setup(store);
    const u = mkUser(3);
    svc.attach(u, 'acct-3');
    expect(u.profileWritable).toBe(false);
    expect(u.profile).toEqual(defaultProfile(NOW));
    expect(profileMsgs(u)[0].persisted).toBe(false);
    expect(logs.some((l) => l.includes('load failed'))).toBe(true);
    svc.handle(u, { type: 'equip', slot: 'engine', itemId: '' });
    store.failLoads = false;
    expect(store.writes).toBe(w0);
    expect(owned(store.load('acct-3') as Profile)).toEqual(['com.engine.aurora']);
    const [o] = svc.grantBatch([{ user: u, profileKey: 'acct-3', input: input('m:1#acct-3#0', { shards: 10 }) }]);
    expect(o.persisted).toBe(true);
    expect(u.profileWritable).toBe(true);
    expect(owned(u.profile)).toEqual(['com.engine.aurora']);
    expect(u.profile?.shards).toBe(13);
  });

  it('no store (server profile DB unavailable): session-only profile, persisted false', () => {
    const { svc } = setup(null);
    const u = mkUser(4);
    svc.attach(u, 'acct-4');
    expect(u.profile).toEqual(defaultProfile(NOW));
    expect(profileMsgs(u)[0].persisted).toBe(false);
    const [out] = svc.grantBatch([{ user: u, profileKey: 'acct-4', input: input('m:1#acct-4#0', { tokens: riftTokens }) }]);
    expect(out.persisted).toBe(false);
    expect(owned(u.profile).length).toBe(3); // kept in memory for the session
    expect(profileMsgs(u).at(-1)?.persisted).toBe(false);
  });
});

describe('equip / seenItems', () => {
  function attached(p: Profile) {
    const ctx = setup();
    ctx.store!.save('acct-1', p);
    const u = mkUser(1);
    ctx.svc.attach(u, 'acct-1');
    u.msgs.length = 0;
    return { ...ctx, u };
  }

  it('equip: pure op → save → push; returns true when the look changed', () => {
    const { svc, store, u, now } = attached(withItem('rift.hull.brute'));
    const w0 = store!.writes;
    expect(svc.handle(u, { type: 'equip', slot: 'hull', itemId: 'rift.hull.brute', shipClass: 'brute' })).toBe(true);
    expect(store!.writes).toBe(w0 + 1);
    const saved = store!.load('acct-1') as Profile;
    expect(saved.loadout.byClass.brute?.hull).toBe('rift.hull.brute');
    expect(saved.updatedAt).toBe(now());
    expect(profileMsgs(u)).toEqual([{ type: 'profile', profile: u.profile, persisted: true }]);
    // Same equip again: no write, no push.
    expect(svc.handle(u, { type: 'equip', slot: 'hull', itemId: 'rift.hull.brute', shipClass: 'brute' })).toBe(false);
    expect(store!.writes).toBe(w0 + 1);
    // Back to the starter.
    expect(svc.handle(u, { type: 'equip', slot: 'hull', itemId: '', shipClass: 'brute' })).toBe(true);
    expect((store!.load('acct-1') as Profile).loadout.byClass.brute).toBeUndefined();
  });

  it('equip errors are reported and change nothing', () => {
    const { svc, store, u } = attached(withItem('rift.hull.brute'));
    const w0 = store!.writes;
    const bad = [
      { type: 'equip', slot: 'hull', itemId: 'swarm.hull.brute', shipClass: 'brute' },
      { type: 'equip', slot: 'hull', itemId: 'rift.hull.brute', shipClass: 'tech' },
      { type: 'equip', slot: 'hull', itemId: 'rift.hull.brute' },
      { type: 'equip', slot: 'hull', itemId: 'x'.repeat(200), shipClass: 'brute' },
      { type: 'equip', slot: 'hull', itemId: 42, shipClass: 'brute' },
      { type: 'equip', slot: 'wings', itemId: 'rift.hull.brute', shipClass: 'brute' },
    ] as const;
    for (const m of bad) expect(svc.handle(u, m as never)).toBe(false);
    expect(errors(u).length).toBe(bad.length);
    expect(store!.writes).toBe(w0);
    expect(u.profile?.loadout).toEqual({ shared: {}, byClass: {} });
  });

  it('seenItems clears NEW badges and saves (look unchanged → false)', () => {
    const { svc, store, u } = attached(withItem('rift.hull.brute', { fresh: ['rift.hull.brute'] }));
    const w0 = store!.writes;
    expect(svc.handle(u, { type: 'seenItems', ids: ['rift.hull.brute', 'junk id', 5 as never] })).toBe(false);
    expect(u.profile?.fresh).toEqual([]);
    expect((store!.load('acct-1') as Profile).fresh).toEqual([]);
    expect(store!.writes).toBe(w0 + 1);
    svc.handle(u, { type: 'seenItems', ids: ['rift.hull.brute'] });
    svc.handle(u, { type: 'seenItems', ids: 'nope' as never });
    expect(store!.writes).toBe(w0 + 1);
  });

  it(`rate limit: ${PROFILE_OPS_BURST} ops per ${PROFILE_OPS_WINDOW_MS} ms per user`, () => {
    const { svc, u, advance } = attached(withItem('com.engine.aurora'));
    let ok = 0;
    for (let i = 0; i < PROFILE_OPS_BURST; i++) {
      const id = i % 2 ? '' : 'com.engine.aurora';
      if (svc.handle(u, { type: 'equip', slot: 'engine', itemId: id })) ok++;
      advance(10);
    }
    expect(ok).toBe(PROFILE_OPS_BURST);
    expect(svc.handle(u, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' })).toBe(false);
    expect(errors(u)).toEqual([PROFILE_OPS_SLOW_MSG]);
    svc.handle(u, { type: 'seenItems', ids: ['com.engine.aurora'] }); // also counted, silently dropped
    expect(errors(u)).toEqual([PROFILE_OPS_SLOW_MSG]);
    advance(PROFILE_OPS_WINDOW_MS + 1);
    expect(svc.handle(u, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' })).toBe(true);
  });

  it('a failed save keeps the change for the session and pushes persisted:false; the next save recovers', () => {
    const { svc, store, u, logs } = attached(withItem('com.engine.aurora'));
    store!.failNext = 1;
    expect(svc.handle(u, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' })).toBe(true);
    expect(u.profile?.loadout.shared.engine).toBe('com.engine.aurora');
    expect(profileMsgs(u).at(-1)?.persisted).toBe(false);
    expect(logs.some((l) => l.includes('save failed'))).toBe(true);
    expect(svc.handle(u, { type: 'seenItems', ids: [] })).toBe(false);
    expect(svc.handle(u, { type: 'equip', slot: 'engine', itemId: '' })).toBe(true);
    expect(profileMsgs(u).at(-1)?.persisted).toBe(true);
  });

  it('a ProfileConflict reloads the stored profile and asks the user to retry', () => {
    class ConflictStore extends MemoryProfileStore {
      conflicts = 0;
      override save(key: string, p: Profile): void {
        if (this.conflicts-- > 0) { super.save(key, { ...withItem('glad.title.champion'), shards: 77 }); throw new ProfileConflict('rev'); }
        super.save(key, p);
      }
    }
    const store = new ConflictStore();
    store.save('acct-1', withItem('com.engine.aurora'));
    store.conflicts = 1;
    const { svc } = setup(store);
    const u = mkUser(1);
    svc.attach(u, 'acct-1');
    svc.handle(u, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' });
    expect(u.profile?.shards).toBe(77);
    expect(owned(u.profile)).toEqual(['glad.title.champion']);
    expect(errors(u).length).toBe(1);
  });
});

describe('grantBatch', () => {
  function party(seeded = false) {
    const ctx = setup(undefined, seeded);
    const store = ctx.store as CountingStore;
    const a = mkUser(1), b = mkUser(2), g = mkUser(3);
    store.save('acct-b', withItem('rift.hull.brute', { shards: 100 }));
    ctx.svc.attach(a, 'acct-a');
    ctx.svc.attach(b, 'acct-b');
    ctx.svc.attach(g, null);
    const entries: ProfileGrantEntry[] = [
      { user: a, profileKey: 'acct-a', input: input('boot:1#acct-a#0', { tokens: riftTokens, crateRolls: 3, won: true }) },
      { user: b, profileKey: 'acct-b', input: input('boot:1#acct-b#0', { tokens: riftTokens, crateRolls: 3 }) },
      { user: g, profileKey: 'guest:3', input: input('boot:1#guest:3#0', { tokens: riftTokens, crateRolls: 3 }) },
    ];
    return { ...ctx, store, a, b, g, entries };
  }

  it('one commitGrants for the whole batch; accounts persisted, guests rolled but never stored', () => {
    const { svc, store, a, b, g, entries } = party();
    const out = svc.grantBatch(entries);
    expect(store.commits).toBe(1);
    expect(out.map((o) => o.persisted)).toEqual([true, true, false]);
    expect(out.every((o) => !o.duplicate && !o.queued)).toBe(true);
    for (const o of out) expect(o.grant.items.length).toBe(6);
    expect(out[0].grant.grantKey).toBe('boot:1#acct-a#0');
    expect(store.hasGrant('acct-a', 'boot:1#acct-a#0')).toBe(true);
    expect(store.hasGrant('acct-b', 'boot:1#acct-b#0')).toBe(true);
    expect(store.keys().some((k) => k.startsWith('guest'))).toBe(false);
    expect(g.profile).toBeNull();
    expect(g.msgs).toEqual([]);
    // Live profiles replaced + pushed, and equal to what was stored.
    expect(a.profile).toEqual(store.load('acct-a'));
    expect(b.profile).toEqual(store.load('acct-b'));
    expect(profileMsgs(a).at(-1)).toEqual({ type: 'profile', profile: a.profile, persisted: true });
    expect(a.profile?.stats.wins).toBe(1);
    expect(b.profile?.stats.wins).toBe(0);
    // b already owned the rift epic: that cache is a duplicate → shards.
    const bEpic = out[1].grant.items[0];
    expect(bEpic).toMatchObject({ itemId: 'rift.hull.brute', dupe: true, shards: SALVAGE_VALUE[3] });
    expect(b.profile!.shards).toBe(100 + out[1].grant.shards);
  });

  it('with rollRng = grantRng: rolls with Rng(fnv1a(grantKey|profileKey)) against the live profile', () => {
    const { svc, entries } = party(true);
    const expected = rollGrant(defaultProfile(NOW), entries[0].input, grantRng('boot:1#acct-a#0', 'acct-a'), NOW).grant;
    const guestExpected = rollGrant(defaultProfile(NOW), entries[2].input, grantRng('boot:1#guest:3#0', 'guest:3'), NOW).grant;
    const out = svc.grantBatch(entries);
    expect(out[0].grant).toEqual(expected);
    expect(out[2].grant).toEqual(guestExpected);
  });

  it('re-granting the same keys is idempotent (duplicate, nothing changes)', () => {
    const { svc, store, a, b, entries } = party();
    svc.grantBatch(entries);
    const aBefore = JSON.parse(JSON.stringify(a.profile)), bBefore = JSON.parse(JSON.stringify(b.profile));
    const again = svc.grantBatch(entries);
    expect(store.commits).toBe(2);
    expect(again.map((o) => o.duplicate ?? false)).toEqual([true, true, false]);
    expect(again.map((o) => o.persisted)).toEqual([true, true, false]);
    expect(a.profile).toEqual(aBefore);
    expect(b.profile).toEqual(bBefore);
    expect(store.load('acct-a')).toEqual(aBefore);
  });

  it('a rejoin (new seq) gets a new grant', () => {
    const { svc, a, entries } = party();
    svc.grantBatch([entries[0]]);
    const n0 = a.profile!.stats.matches;
    const [o] = svc.grantBatch([{ ...entries[0], input: { ...entries[0].input, grantKey: 'boot:1#acct-a#1', crateRolls: 0 } }]);
    expect(o.persisted).toBe(true);
    expect(o.duplicate).toBeFalsy();
    expect(a.profile!.stats.matches).toBe(n0 + 1);
  });

  it('grants a disconnected user (user: null) against the stored profile', () => {
    const { svc, store } = party();
    store.save('acct-z', withItem('com.title.wingman', { shards: 9 }));
    const [o] = svc.grantBatch([{ user: null, profileKey: 'acct-z', input: input('boot:1#acct-z#0', { shards: 20 }) }]);
    expect(o.persisted).toBe(true);
    const p = store.load('acct-z') as Profile;
    expect(p.shards).toBe(29);
    expect(owned(p)).toEqual(['com.title.wingman']);
  });

  it('same key twice in one batch: the second builds on the first', () => {
    const { svc, store, a } = party();
    const out = svc.grantBatch([
      { user: a, profileKey: 'acct-a', input: input('boot:1#acct-a#0', { shards: 10 }) },
      { user: a, profileKey: 'acct-a', input: input('boot:1#acct-a#1', { shards: 5 }) },
    ]);
    expect(out.map((o) => o.persisted)).toEqual([true, true]);
    expect(a.profile!.shards).toBe(15);
    expect((store.load('acct-a') as Profile).shards).toBe(15);
    expect(a.profile!.stats.matches).toBe(2);
  });

  it('never throws on garbage entries', () => {
    const { svc, logs } = party();
    const out = svc.grantBatch([
      null as never,
      { user: null, profileKey: 5 as never, input: input('k') },
      { user: null, profileKey: 'acct-q', input: null as never },
      { user: null, profileKey: 'acct-q', input: { ...input(''), grantKey: '' } },
      { user: null, profileKey: 'acct-q', input: { grantKey: 'boot:9#acct-q#0', gameType: 'moon', tokens: 'x', crateRolls: -1 } as never },
    ]);
    expect(out.length).toBe(5);
    expect(out.slice(0, 4).every((o) => !o.persisted && o.grant.items.length === 0)).toBe(true);
    expect(out[4].persisted).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    expect(svc.grantBatch(undefined as never)).toEqual([]);
  });
});

describe('failure + retry queue (fix #18)', () => {
  function failing() {
    const ctx = setup();
    const store = ctx.store as CountingStore;
    const a = mkUser(1);
    store.save('acct-a', withItem('com.engine.aurora'));
    ctx.svc.attach(a, 'acct-a');
    return { ...ctx, store, a };
  }
  const gt: GameType = 'warzone';
  const entry = (a: TestUser, seq = 0): ProfileGrantEntry => ({ user: a, profileKey: 'acct-a', input: input(`boot:2#acct-a#${seq}`, { gameType: gt, tokens: riftTokens, crateRolls: 2 }) });

  it('a failed commit queues the grants (outcome queued, profile untouched) and the next pass lands them', () => {
    const { svc, store, a, logs } = failing();
    store.failNext = 1;
    const before = JSON.stringify(a.profile);
    const [o] = svc.grantBatch([entry(a)]);
    expect(o).toMatchObject({ persisted: false, queued: true });
    expect(o.grant.items.length).toBe(5);
    expect(JSON.stringify(a.profile)).toBe(before);
    expect(svc.queued).toBe(1);
    expect(logs.some((l) => l.includes('commitGrants failed'))).toBe(true);
    svc.retryQueued();
    expect(svc.queued).toBe(0);
    expect(store.hasGrant('acct-a', 'boot:2#acct-a#0')).toBe(true);
    for (const it of o.grant.items.filter((x) => !x.dupe)) expect(a.profile!.owned[it.itemId]).toBeDefined();
    expect(a.profile).toEqual(store.load('acct-a'));
    expect(profileMsgs(a).at(-1)?.persisted).toBe(true);
  });

  it('the retry re-applies onto the CURRENT profile, so an equip made meanwhile is kept', () => {
    const { svc, store, a } = failing();
    store.failNext = 1;
    const [o] = svc.grantBatch([entry(a)]);
    expect(svc.handle(a, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' })).toBe(true);
    svc.retryQueued();
    const p = store.load('acct-a') as Profile;
    expect(p.loadout.shared.engine).toBe('com.engine.aurora');
    expect(p.shards).toBe(o.grant.shards);
  });

  it(`gives up after ${GRANT_RETRY_PASSES} failed passes and tells the user`, () => {
    const { svc, store, a } = failing();
    store.failNext = Infinity;
    svc.grantBatch([entry(a)]);
    for (let i = 1; i < GRANT_RETRY_PASSES; i++) { svc.retryQueued(); expect(svc.queued).toBe(1); expect(errors(a)).toEqual([]); }
    svc.retryQueued();
    expect(svc.queued).toBe(0);
    expect(errors(a)).toEqual([LOOT_NOT_SAVED_MSG]);
    expect(store.hasGrant('acct-a', 'boot:2#acct-a#0')).toBe(false);
    svc.retryQueued(); // empty queue: no-op
    expect(errors(a)).toEqual([LOOT_NOT_SAVED_MSG]);
  });

  it('a retry whose earlier attempt actually landed is treated as done (idempotent by key)', () => {
    const { svc, store, a } = failing();
    store.failNext = 1;
    const [o] = svc.grantBatch([entry(a)]);
    // Simulate "the first attempt committed after all" by committing it directly.
    store.commitGrants([{ key: 'acct-a', grantKey: o.grant.grantKey, grant: o.grant, profile: { ...a.profile!, shards: 4242 } }]);
    svc.retryQueued();
    expect(svc.queued).toBe(0);
    expect(a.profile!.shards).toBe(4242); // reloaded from the store, not applied twice
  });

  it('a store that cannot be read for a detached key queues the grant; it lands once the store recovers', () => {
    const { svc, store } = failing();
    store.save('acct-d', withItem('rift.hull.brute', { shards: 1 }));
    store.failLoads = true;
    const [o] = svc.grantBatch([{ user: null, profileKey: 'acct-d', input: input('boot:3#acct-d#0', { tokens: [{ rarity: 0, set: 'common', source: 'elite' }] }) }]);
    expect(o).toMatchObject({ persisted: false, queued: true });
    store.failLoads = false;
    svc.retryQueued();
    const p = store.load('acct-d') as Profile;
    expect(owned(p)).toContain('rift.hull.brute'); // not clobbered by a blank base
    expect(p.shards).toBeGreaterThanOrEqual(11);
    expect(store.hasGrant('acct-d', 'boot:3#acct-d#0')).toBe(true);
  });

  it('a bad commitGrants result is treated as a failure', () => {
    class BadStore extends MemoryProfileStore { override commitGrants(): boolean[] { return []; } }
    const { svc } = setup(new BadStore());
    const a = mkUser(1);
    svc.attach(a, 'acct-a');
    const [o] = svc.grantBatch([{ user: a, profileKey: 'acct-a', input: input('boot:4#acct-a#0') }]);
    expect(o.queued).toBe(true);
  });

  it('a reconnect during the retry window receives the landed grant on its new connection', () => {
    const { svc, store, a } = failing();
    store.failNext = 1;
    svc.grantBatch([entry(a)]);
    svc.detach(a);
    const a2 = mkUser(9);
    svc.attach(a2, 'acct-a');
    svc.retryQueued();
    expect(a2.profile).toEqual(store.load('acct-a'));
    expect(a2.profile!.stats.matches).toBe(1);
    expect(profileMsgs(a2).at(-1)?.persisted).toBe(true);
  });
});

describe('M2 integration fixes', () => {
  /**
   * A store with the SQLite store's rev rule: a write of a key must match what this "process" last loaded or wrote
   * for it, else ProfileConflict (for the whole commitGrants batch, like one rolled-back transaction).
   */
  class RevStore extends MemoryProfileStore {
    private seen = new Map<string, string>();
    commits = 0;
    override load(key: string): unknown | null {
      const v = super.load(key);
      this.seen.set(key, JSON.stringify(v));
      return v;
    }
    private check(key: string): void {
      if (this.seen.has(key) && this.seen.get(key) !== JSON.stringify(super.load(key))) throw new ProfileConflict(`rev moved: ${key}`);
    }
    override save(key: string, p: Profile): void {
      this.check(key);
      super.save(key, p);
      this.seen.set(key, JSON.stringify(p));
    }
    override commitGrants(batch: readonly GrantCommit[]): boolean[] {
      this.commits++;
      for (const c of batch) this.check(c.key);
      const r = super.commitGrants(batch);
      batch.forEach((c, i) => { if (r[i]) this.seen.set(c.key, JSON.stringify(c.profile)); });
      return r;
    }
    /** Another process (or a hand edit) writes this key. */
    external(key: string, p: Profile): void { super.save(key, p); }
  }

  function two() {
    const store = new RevStore();
    store.save('acct-a', withItem('com.engine.aurora', { shards: 1 }));
    store.save('acct-b', withItem('rift.hull.brute', { shards: 2 }));
    const { svc, logs } = setup(store);
    const a = mkUser(1), b = mkUser(2);
    svc.attach(a, 'acct-a');
    svc.attach(b, 'acct-b');
    const entries = (seq = 0): ProfileGrantEntry[] => [
      { user: a, profileKey: 'acct-a', input: input(`boot:7#acct-a#${seq}`, { gameType: 'warzone', crateRolls: 2, shards: 10 }) },
      { user: b, profileKey: 'acct-b', input: input(`boot:7#acct-b#${seq}`, { gameType: 'warzone', crateRolls: 2, shards: 20 }) },
    ];
    return { store, svc, logs, a, b, entries };
  }

  it('a ProfileConflict on one account never costs the others their grant; the conflicting one is rebased on a fresh read', () => {
    const { store, svc, logs, a, b, entries } = two();
    // B's row changes outside this process mid-match (a second server, a sqlite hand edit).
    store.external('acct-b', withItem('rift.hull.brute', { shards: 500, owned: { 'rift.hull.brute': { at: 1, src: 'dungeon' }, 'glad.title.champion': { at: 2, src: 'arena' } } }));
    const out = svc.grantBatch(entries());
    expect(out.map((o) => o.persisted)).toEqual([true, true]);
    expect(out.every((o) => !o.queued && !o.duplicate)).toBe(true);
    expect(store.hasGrant('acct-a', 'boot:7#acct-a#0')).toBe(true);
    expect(store.hasGrant('acct-b', 'boot:7#acct-b#0')).toBe(true);
    const pb = store.load('acct-b') as Profile;
    expect(pb.owned['glad.title.champion']).toBeDefined(); // the outside write is kept, not clobbered
    expect(pb.shards).toBe(500 + out[1].grant.shards);
    expect(b.profile).toEqual(pb); // the live session adopted the rebased profile
    expect((store.load('acct-a') as Profile).shards).toBe(1 + out[0].grant.shards);
    expect(logs.some((l) => l.includes('changed underneath'))).toBe(true);
    svc.retryQueued();
    expect(svc.queued).toBe(0);
  });

  it('a key that keeps conflicting is queued stale and the retry builds on a fresh store read', () => {
    const { store, svc, a, b, entries } = two();
    let storms = 3; // conflicting writes keep landing: the batch, B's own commit and B's rebased commit all lose
    const orig = store.commitGrants.bind(store);
    store.commitGrants = (batch) => {
      if (storms > 0 && batch.some((c) => c.key === 'acct-b')) { storms--; store.external('acct-b', { ...(store.load('acct-b') as Profile), shards: 900 }); throw new ProfileConflict('rev moved: acct-b'); }
      return orig(batch);
    };
    const out = svc.grantBatch(entries());
    expect(out[0]).toMatchObject({ persisted: true });
    expect(out[1]).toMatchObject({ persisted: false, queued: true });
    expect(store.hasGrant('acct-a', 'boot:7#acct-a#0')).toBe(true);
    svc.retryQueued();
    expect(svc.queued).toBe(0);
    expect(store.hasGrant('acct-b', 'boot:7#acct-b#0')).toBe(true);
    expect((store.load('acct-b') as Profile).shards).toBe(900 + out[1].grant.shards);
    expect(b.profile).toEqual(store.load('acct-b'));
    expect(errors(a)).toEqual([]);
    expect(errors(b)).toEqual([]);
  });

  it('a replayed grantKey returns the grant that was recorded, never a fresh re-roll', () => {
    const { svc, store, a, entries } = two();
    const [first] = svc.grantBatch([entries()[0]]);
    expect(first.persisted).toBe(true);
    const before = JSON.stringify(store.load('acct-a'));
    const [again] = svc.grantBatch([entries()[0]]);
    expect(again).toMatchObject({ persisted: true, duplicate: true });
    expect(again.grant).toEqual(first.grant);
    expect(JSON.stringify(store.load('acct-a'))).toBe(before);
    expect(a.profile).toEqual(store.load('acct-a'));
    // recorded by an earlier process (not in this one's memo): an empty grant, still a duplicate
    const other = new ProfileService(store, { now: () => NOW, log: () => {} });
    const [replay] = other.grantBatch([{ user: null, profileKey: 'acct-a', input: entries()[0].input }]);
    expect(replay).toMatchObject({ persisted: true, duplicate: true });
    expect(replay.grant.items).toEqual([]);
    expect(replay.grant.shards).toBe(0);
  });

  it('default rolls are salted server-side: the client cannot reproduce them from grantKey + profileKey', () => {
    const crates = (svc: ProfileService, k: number) => svc.grantBatch([{ user: null, profileKey: 'guest:1', input: input(`boot:9#guest:1#${k}`, { gameType: 'warzone', crateRolls: 5 }) }])[0].grant.items.map((i) => i.itemId).join(',');
    const s1 = new ProfileService(null, { now: () => NOW, log: () => {} });
    const s2 = new ProfileService(null, { now: () => NOW, log: () => {} });
    let differsFromSpec = 0, differsBetweenRuns = 0;
    for (let k = 0; k < 40; k++) {
      const predicted = rollGrant(defaultProfile(NOW), input(`boot:9#guest:1#${k}`, { gameType: 'warzone', crateRolls: 5 }), grantRng(`boot:9#guest:1#${k}`, 'guest:1'), NOW).grant.items.map((i) => i.itemId).join(',');
      const got = crates(s1, k);
      if (got !== predicted) differsFromSpec++;
      if (got !== crates(s2, k)) differsBetweenRuns++;
    }
    expect(differsFromSpec).toBeGreaterThan(30);
    expect(differsBetweenRuns).toBeGreaterThan(30);
  });
});
