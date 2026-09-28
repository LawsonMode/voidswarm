// LOOT: MemoryProfileStore (tests + smoke backend) honours the frozen ProfileStore contract (§7.2, §8.6).
import { describe, expect, it } from 'vitest';
import type { LootGrant } from '../protocol';
import { defaultProfile } from './profile';
import { MemoryProfileStore, type GrantCommit } from './store';

const NOW = 1_700_000_000_000;
const grant = (grantKey: string): LootGrant => ({
  grantKey, gameType: 'arena', items: [], shards: 5, cachesSecured: 0, cachesLost: 0, epicIn: 12, legendaryIn: 60,
});
const commit = (key: string, grantKey: string, shards: number): GrantCommit => ({
  key, grantKey, grant: grant(grantKey), profile: { ...defaultProfile(NOW), shards },
});

describe('MemoryProfileStore', () => {
  it('load is null until saved; saved data is a copy', () => {
    const s = new MemoryProfileStore();
    expect(s.load('a')).toBeNull();
    const p = defaultProfile(NOW);
    s.save('a', p);
    const back = s.load('a') as typeof p;
    expect(back).toEqual(p);
    expect(back).not.toBe(p);
    p.shards = 99;
    expect((s.load('a') as typeof p).shards).toBe(0);
  });

  it('commitGrants records each key once (idempotent), including duplicates inside one batch', () => {
    const s = new MemoryProfileStore();
    expect(s.commitGrants([commit('a', 'm1#a#0', 5), commit('b', 'm1#b#0', 6)])).toEqual([true, true]);
    expect(s.hasGrant('a', 'm1#a#0')).toBe(true);
    expect(s.recordedGrant('b', 'm1#b#0')?.grantKey).toBe('m1#b#0');
    expect(s.commitGrants([commit('a', 'm1#a#0', 500), commit('a', 'm1#a#1', 7), commit('a', 'm1#a#1', 800)])).toEqual([false, true, false]);
    expect((s.load('a') as { shards: number }).shards).toBe(7);
    expect(s.hasGrant('b', 'm1#a#0')).toBe(false); // per-profile ledger
    expect(s.writes).toBe(3);
  });

  it('a failing commit writes nothing (one transaction)', () => {
    const s = new MemoryProfileStore();
    s.failNext = 1;
    expect(() => s.commitGrants([commit('a', 'k', 1)])).toThrow();
    expect(s.hasGrant('a', 'k')).toBe(false);
    expect(s.load('a')).toBeNull();
    expect(s.commitGrants([commit('a', 'k', 1)])).toEqual([true]);
    s.failNext = 1;
    expect(() => s.save('a', defaultProfile(NOW))).toThrow();
    expect((s.load('a') as { shards: number }).shards).toBe(1);
  });

  it('corrupted JSON loads as null; failLoads throws', () => {
    const s = new MemoryProfileStore();
    s.setRaw('a', '{not json');
    expect(s.load('a')).toBeNull();
    s.failLoads = true;
    expect(() => s.load('a')).toThrow();
    s.close();
  });
});
