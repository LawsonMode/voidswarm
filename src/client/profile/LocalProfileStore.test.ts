// LocalProfileStore (docs/v0.3-proposal.md §7.2): blob shape, commitGrants idempotence + ledger cap, and the
// try/catch contract (storage unavailable → session memory, newer blob → never overwritten).
import { describe, expect, it } from 'vitest';
import type { LootGrant, Profile, ServerMsg } from '../../shared/protocol';
import { ProfileService, type ProfileUser } from '../../shared/profile/service';
import { ProfileConflict } from '../../shared/profile/store';
import {
  DEVICE_LEDGER_MAX, DEVICE_PROFILE_KEY, LOCAL_PROFILE_KEY, LocalProfileStore, parseDeviceBlob, type StorageLike,
} from './LocalProfileStore';

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  failGet = false;
  failSet = false;
  sets = 0;
  getItem(k: string): string | null {
    if (this.failGet) throw new Error('SecurityError');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet) throw new Error('QuotaExceededError');
    this.sets++;
    this.data.set(k, v);
  }
}

function profile(shards = 0): Profile {
  return {
    v: 1, owned: {}, shards, loadout: { shared: {}, byClass: {} }, fresh: [], pity: {}, pityLegendary: 0,
    stats: { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} }, recent: [], updatedAt: 1,
  };
}

function grant(key: string): LootGrant {
  return { grantKey: key, gameType: 'warzone', items: [], shards: 5, cachesSecured: 0, cachesLost: 0, epicIn: 12, legendaryIn: 60 };
}

describe('LocalProfileStore', () => {
  it('stores { v: 1, profiles: { local }, ledger } under voidswarm.profile.device', () => {
    const st = new MemStorage();
    const store = new LocalProfileStore(() => st);
    expect(store.load(LOCAL_PROFILE_KEY)).toBeNull();
    store.save(LOCAL_PROFILE_KEY, profile(7));
    const blob = JSON.parse(st.data.get(DEVICE_PROFILE_KEY)!);
    expect(blob.v).toBe(1);
    expect(blob.profiles.local.shards).toBe(7);
    expect(blob.ledger).toEqual([]);
    expect((store.load(LOCAL_PROFILE_KEY) as Profile).shards).toBe(7);
    expect(store.persistent).toBe(true);
  });

  it('load returns a copy (callers may mutate it)', () => {
    const st = new MemStorage();
    const store = new LocalProfileStore(() => st);
    store.save('local', profile(3));
    const a = store.load('local') as Profile;
    a.shards = 999;
    expect((store.load('local') as Profile).shards).toBe(3);
  });

  it('commitGrants records each grantKey once (idempotent) and saves the profile', () => {
    const st = new MemStorage();
    const store = new LocalProfileStore(() => st);
    expect(store.commitGrants([{ key: 'local', grantKey: 'm1#local#0', grant: grant('m1#local#0'), profile: profile(5) }])).toEqual([true]);
    const writes = st.sets;
    expect(store.commitGrants([{ key: 'local', grantKey: 'm1#local#0', grant: grant('m1#local#0'), profile: profile(10) }])).toEqual([false]);
    expect(st.sets).toBe(writes); // a duplicate writes nothing
    expect((store.load('local') as Profile).shards).toBe(5);
    expect(store.hasGrant('m1#local#0')).toBe(true);
    // a batch with a new key and a repeated one inside the same batch
    expect(store.commitGrants([
      { key: 'local', grantKey: 'm2#local#0', grant: grant('m2#local#0'), profile: profile(15) },
      { key: 'local', grantKey: 'm2#local#0', grant: grant('m2#local#0'), profile: profile(20) },
    ])).toEqual([true, false]);
    expect((store.load('local') as Profile).shards).toBe(15);
  });

  it('keeps at most 100 ledger entries (oldest dropped)', () => {
    const st = new MemStorage();
    const store = new LocalProfileStore(() => st);
    for (let i = 0; i < DEVICE_LEDGER_MAX + 20; i++) store.commitGrants([{ key: 'local', grantKey: `g${i}`, grant: grant(`g${i}`), profile: profile(i) }]);
    const blob = JSON.parse(st.data.get(DEVICE_PROFILE_KEY)!);
    expect(blob.ledger.length).toBe(DEVICE_LEDGER_MAX);
    expect(blob.ledger[0]).toBe('g20');
    expect(store.hasGrant('g0')).toBe(false);
  });

  it('works from memory for the session when storage throws (and says so)', () => {
    const st = new MemStorage();
    st.failGet = true;
    st.failSet = true;
    const store = new LocalProfileStore(() => st);
    expect(store.load('local')).toBeNull();
    store.save('local', profile(4));
    expect(store.persistent).toBe(false);
    expect((store.load('local') as Profile).shards).toBe(4);
    expect(store.commitGrants([{ key: 'local', grantKey: 'k', grant: grant('k'), profile: profile(9) }])).toEqual([true]);
    expect(store.commitGrants([{ key: 'local', grantKey: 'k', grant: grant('k'), profile: profile(9) }])).toEqual([false]);
  });

  it('a failed write keeps the newer in-memory data ahead of the stale stored copy', () => {
    const st = new MemStorage();
    const store = new LocalProfileStore(() => st);
    store.save('local', profile(1));
    st.failSet = true;
    store.save('local', profile(2));
    expect((store.load('local') as Profile).shards).toBe(2);
    expect(store.persistent).toBe(false);
  });

  it('no storage at all (SSR / blocked) → memory only', () => {
    const store = new LocalProfileStore(() => null);
    store.save('local', profile(8));
    expect((store.load('local') as Profile).shards).toBe(8);
    expect(store.persistent).toBe(false);
  });

  it('corrupted JSON reads as empty and is replaced by the next write', () => {
    const st = new MemStorage();
    st.data.set(DEVICE_PROFILE_KEY, '{not json');
    const store = new LocalProfileStore(() => st);
    expect(store.load('local')).toBeNull();
    store.save('local', profile(6));
    expect(JSON.parse(st.data.get(DEVICE_PROFILE_KEY)!).profiles.local.shards).toBe(6);
  });

  it('a blob from a newer client (v > 1) is read but never overwritten', () => {
    const st = new MemStorage();
    const raw = JSON.stringify({ v: 2, profiles: { local: { ...profile(50), v: 2 } }, ledger: ['x'] });
    st.data.set(DEVICE_PROFILE_KEY, raw);
    const store = new LocalProfileStore(() => st);
    expect((store.load('local') as Profile).shards).toBe(50);
    expect(store.readOnly).toBe(true);
    store.save('local', profile(1));
    expect(st.data.get(DEVICE_PROFILE_KEY)).toBe(raw);
  });

  it('parseDeviceBlob drops garbage fields', () => {
    expect(parseDeviceBlob(null)).toBeNull();
    expect(parseDeviceBlob('[]')).toBeNull();
    const b = parseDeviceBlob(JSON.stringify({ v: 1, profiles: 5, ledger: ['a', 3, '', 'b'] }))!;
    expect(b.profiles).toEqual({});
    expect(b.ledger).toEqual(['a', 'b']);
  });
});

describe('LocalProfileStore: two tabs on one device (stale-write detection)', () => {
  it('a save built on a stale read throws ProfileConflict and writes nothing; a fresh load clears it', () => {
    const st = new MemStorage();
    const tabA = new LocalProfileStore(() => st), tabB = new LocalProfileStore(() => st);
    tabA.save('local', profile(1));
    tabA.load('local');
    tabB.load('local');
    tabB.save('local', profile(2)); // B equips
    const before = st.data.get(DEVICE_PROFILE_KEY);
    expect(() => tabA.save('local', profile(3))).toThrow(ProfileConflict);
    expect(st.data.get(DEVICE_PROFILE_KEY)).toBe(before);
    expect((tabA.load('local') as Profile).shards).toBe(2);
    tabA.save('local', profile(4));
    expect((tabB.load('local') as Profile).shards).toBe(4);
  });

  it('commitGrants on a stale key throws before recording anything; a duplicate key never checks', () => {
    const st = new MemStorage();
    const tabA = new LocalProfileStore(() => st), tabB = new LocalProfileStore(() => st);
    tabA.load('local');
    tabB.load('local');
    expect(tabB.commitGrants([{ key: 'local', grantKey: 'm1#local#0', grant: grant('m1#local#0'), profile: profile(5) }])).toEqual([true]);
    expect(() => tabA.commitGrants([{ key: 'local', grantKey: 'm2#local#0', grant: grant('m2#local#0'), profile: profile(9) }])).toThrow(ProfileConflict);
    expect(tabA.hasGrant('m2#local#0')).toBe(false);
    // replaying a key B already recorded is a plain duplicate (false), even from the stale tab
    expect(tabA.commitGrants([{ key: 'local', grantKey: 'm1#local#0', grant: grant('m1#local#0'), profile: profile(9) }])).toEqual([false]);
    expect((tabB.load('local') as Profile).shards).toBe(5);
  });

  it('a key this tab never loaded may be written only while nothing is stored for it', () => {
    const st = new MemStorage();
    const tabA = new LocalProfileStore(() => st), tabB = new LocalProfileStore(() => st);
    tabA.save('local', profile(1)); // nothing stored yet: fine
    expect(() => tabB.save('local', profile(2))).toThrow(ProfileConflict);
    expect((tabB.load('local') as Profile).shards).toBe(1);
  });

  it('end to end: an older offline tab can no longer wipe the loot a newer tab banked', () => {
    const st = new MemStorage();
    const NOW = 1_700_000_000_000;
    const mk = (): ProfileUser & { msgs: ServerMsg[] } => {
      const msgs: ServerMsg[] = [];
      return { playerId: 1, msgs, sink: { sendMsg: (m) => { msgs.push(m); } }, profile: null, profileKey: null, profileWritable: false, opTimes: [] };
    };
    const svcA = new ProfileService(new LocalProfileStore(() => st), { now: () => NOW, log: () => {} });
    const svcB = new ProfileService(new LocalProfileStore(() => st), { now: () => NOW, log: () => {} });
    const a = mk(), b = mk();
    new LocalProfileStore(() => st).save('local', { ...profile(0), owned: { 'com.engine.aurora': { at: 1, src: 'warzone' } } });
    svcB.attach(b, 'local'); // tab B opened first
    svcA.attach(a, 'local');
    const banked = [
      { rarity: 4 as const, set: 'swarm' as const, source: 'boss' as const },
      { rarity: 3 as const, set: 'rift' as const, source: 'bossCache' as const },
    ];
    const [ga] = svcA.grantBatch([{ user: a, profileKey: 'local', input: { grantKey: 'z:1#local#0', gameType: 'warzone', tokens: banked, crateRolls: 0, shards: 0, won: false, cachesLost: 0 } }]);
    expect(ga.persisted).toBe(true);
    const bankedIds = ga.grant.items.map((i) => i.itemId);
    expect(bankedIds.length).toBe(2);
    // tab B (stale) equips an item it owns: refused, reloaded (B now sees A's loot), and the banked items survive
    svcB.handle(b, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' });
    expect(b.msgs.some((m) => m.type === 'error' && /changed elsewhere/.test(m.message))).toBe(true);
    const stored = () => new LocalProfileStore(() => st).load('local') as Profile;
    for (const id of bankedIds) { expect(stored().owned[id]).toBeDefined(); expect(b.profile?.owned[id]).toBeDefined(); }
    expect(stored().loadout.shared.engine).toBeUndefined();
    // retrying the equip on the fresh copy works
    svcB.handle(b, { type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' });
    expect(stored().loadout.shared.engine).toBe('com.engine.aurora');
    for (const id of bankedIds) expect(stored().owned[id]).toBeDefined();
    // tab A is stale now: its next grant must be rebased instead of wiping B's equip
    const [ga2] = svcA.grantBatch([{ user: a, profileKey: 'local', input: { grantKey: 'z:1#local#1', gameType: 'warzone', tokens: [], crateRolls: 0, shards: 7, won: false, cachesLost: 0 } }]);
    expect(ga2.persisted).toBe(true);
    expect(stored().loadout.shared.engine).toBe('com.engine.aurora');
    // tab B's own grant lands on top of tab A's (rebased on a fresh read), never over it
    const [gb] = svcB.grantBatch([{ user: b, profileKey: 'local', input: { grantKey: 'z:2#local#0', gameType: 'warzone', tokens: [], crateRolls: 0, shards: 30, won: false, cachesLost: 0 } }]);
    expect(gb.persisted).toBe(true);
    for (const id of bankedIds) expect(stored().owned[id]).toBeDefined();
    expect(stored().shards).toBe(ga.grant.shards + 7 + 30);
    expect(stored().loadout.shared.engine).toBe('com.engine.aurora');
  });
});
