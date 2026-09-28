// LOOT: pure grant rolls (docs/v0.3-proposal.md §6.4 rarity/set, §6.6 crates/pity/shards, §9 LOOT acceptance).
import { describe, expect, it } from 'vitest';
import type { CacheToken, GameType, LootSet, Rarity } from '../types';
import { LOOT_SETS } from '../types';
import type { Profile } from '../protocol';
import { COSMETICS, COSMETIC_SLOTS, fitsSlot, lootPool } from '../data/cosmetics';
import { GAME_TYPE_IDS } from '../data/gameTypes';
import { SHIP_CLASS_IDS } from '../data/ships';
import {
  BOT_MAX_RARITY, BOT_SLOT_CHANCE, CACHE_RARITY_W, CRATE_RARITY_W, FRESH_MAX, MODE_SET_SHARE, PITY_EPIC, PITY_LEGENDARY,
  SALVAGE_VALUE, SET_FOR_TYPE, SHARDS_MAX, riftRarityBoost,
} from '../data/loot';
import { Rng } from '../util/rng';
import { defaultProfile, normalizeProfile } from './profile';
import {
  applyGrant, baseShards, botWardrobe, crateCount, crateEligible, grantRng, grantSeed, rollGrant, rollIdentity, rollRarity,
  rollSet, type GrantInput,
} from './rolls';

const NOW = 1_700_000_000_000;
const N = 100_000;
const TOL = 0.01; // ±1 percentage point of share

const rngFn = (seed: number): (() => number) => { const r = new Rng(seed); return () => r.next(); };
/** Scripted stream: the given values in order, then `rest` forever. */
const script = (vals: number[], rest = 0): (() => number) => { let i = 0; return () => (i < vals.length ? vals[i++] : rest); };
const input = (o: Partial<GrantInput> = {}): GrantInput => ({
  grantKey: 'boot:1#acct#0', gameType: 'arena', tokens: [], crateRolls: 0, shards: 0, won: false, cachesLost: 0, ...o,
});
const own = (p: Profile, ...ids: string[]): Profile => {
  const owned = { ...p.owned };
  for (const id of ids) owned[id] = { at: 1, src: 'arena' };
  return { ...p, owned };
};
const shares = (counts: number[], n: number): number[] => counts.map((c) => c / n);
const expected = (w: readonly number[], floor: number, boost = 1): number[] => {
  const x = w.map((v, r) => (r < floor ? 0 : v * (r >= 2 ? boost : 1)));
  const t = x.reduce((a, b) => a + b, 0);
  return x.map((v) => v / t);
};
const expectShares = (got: number[], want: number[]): void => {
  for (let r = 0; r < want.length; r++) expect(Math.abs(got[r] - want[r]), `rarity ${r}: ${got[r]} vs ${want[r]}`).toBeLessThanOrEqual(TOL);
};

describe('rollRarity (100k seeded rolls)', () => {
  const run = (w: readonly number[], floor: number, boost = 1, seed = 1): number[] => {
    const rnd = rngFn(seed);
    const c = [0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) c[rollRarity(w, floor, rnd, boost)]++;
    return shares(c, N);
  };

  it('cache weights within ±1%', () => expectShares(run(CACHE_RARITY_W, 0), expected(CACHE_RARITY_W, 0)));
  it('crate weights within ±1%', () => expectShares(run(CRATE_RARITY_W, 0, 1, 2), expected(CRATE_RARITY_W, 0)));

  it('floors are honoured (nothing below the floor) and the rest renormalizes', () => {
    for (const floor of [1, 2, 3, 4]) {
      const got = run(CACHE_RARITY_W, floor, 1, 10 + floor);
      for (let r = 0; r < floor; r++) expect(got[r]).toBe(0);
      expectShares(got, expected(CACHE_RARITY_W, floor));
    }
  });

  it('dungeon rare+ boost (floor 6, Nightmare) renormalizes within ±1%', () => {
    const boost = riftRarityBoost(6, 3);
    expect(boost).toBeCloseTo((1 + 0.15 * 5) * 1.5);
    expectShares(run(CACHE_RARITY_W, 0, boost, 7), expected(CACHE_RARITY_W, 0, boost));
    expectShares(run(CACHE_RARITY_W, 1, boost, 8), expected(CACHE_RARITY_W, 1, boost));
  });

  it('consumes exactly one draw and is deterministic', () => {
    let calls = 0;
    const rnd = (): number => { calls++; return 0.5; };
    rollRarity(CACHE_RARITY_W, 0, rnd); rollRarity(CACHE_RARITY_W, 3, rnd); rollRarity([0, 0, 0, 0, 0], 0, rnd);
    expect(calls).toBe(3);
    const a = rngFn(99), b = rngFn(99);
    for (let i = 0; i < 100; i++) expect(rollRarity(CRATE_RARITY_W, 0, a)).toBe(rollRarity(CRATE_RARITY_W, 0, b));
    expect(rollRarity(CACHE_RARITY_W, 0, () => 0.999999999)).toBe(4);
    expect(rollRarity(CACHE_RARITY_W, 0, () => 0)).toBe(0);
  });
});

describe('rollSet', () => {
  it.each(GAME_TYPE_IDS)('%s: MODE_SET_SHARE of rolls are the mode set, the rest Salvage', (t) => {
    const rnd = rngFn(3);
    let mode = 0, common = 0;
    for (let i = 0; i < N; i++) { const s = rollSet(t, rnd); if (s === SET_FOR_TYPE[t]) mode++; else if (s === 'common') common++; }
    expect(mode + common).toBe(N);
    expect(Math.abs(mode / N - MODE_SET_SHARE)).toBeLessThanOrEqual(TOL);
  });
});

describe('crates through rollGrant (100k single-crate grants, no pity in play)', () => {
  it('rarity follows CRATE_RARITY_W and set follows MODE_SET_SHARE, within ±1%', () => {
    const p = defaultProfile(NOW);
    const c = [0, 0, 0, 0, 0];
    let modeSet = 0;
    for (let i = 0; i < N; i++) {
      const { grant } = rollGrant(p, input({ grantKey: `m:${i}#a#0`, gameType: 'warzone', crateRolls: 1 }), grantRng(`m:${i}#a#0`, 'a'), NOW);
      expect(grant.items.length).toBe(1);
      const it = grant.items[0];
      expect(it.from).toBe('crate');
      c[it.rarity]++;
      if (COSMETICS[it.itemId].set === 'swarm') modeSet++;
    }
    expectShares(shares(c, N), expected(CRATE_RARITY_W, 0));
    expect(Math.abs(modeSet / N - MODE_SET_SHARE)).toBeLessThanOrEqual(TOL);
  });
});

describe('identity roll', () => {
  it('picks uniformly within the pool', () => {
    const pool = lootPool('common', 0);
    const rnd = rngFn(5);
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) { const d = rollIdentity(() => false, 'common', 0, rnd)!; counts.set(d.id, (counts.get(d.id) ?? 0) + 1); }
    expect(counts.size).toBe(pool.length);
    for (const d of pool) expect(Math.abs((counts.get(d.id) ?? 0) / N - 1 / pool.length)).toBeLessThanOrEqual(TOL);
  });

  it('rerolls an owned pick once: new on the reroll, duplicate when both picks are owned', () => {
    const pool = lootPool('common', 2); // 3 items
    expect(pool.length).toBe(3);
    const p = own(defaultProfile(NOW), pool[0].id);
    const tok: CacheToken = { rarity: 2, set: 'common', source: 'elite' };
    const g1 = rollGrant(p, input({ tokens: [tok] }), script([0, 0.5]), NOW).grant;
    expect(g1.items[0]).toMatchObject({ itemId: pool[1].id, dupe: false, shards: 0 });
    const g2 = rollGrant(p, input({ tokens: [tok] }), script([0, 0]), NOW).grant;
    expect(g2.items[0]).toMatchObject({ itemId: pool[0].id, dupe: true, shards: SALVAGE_VALUE[2] });
  });
});

describe('duplicates → shards', () => {
  it('an owned single-item pool always converts to SALVAGE_VALUE shards', () => {
    const p = { ...own(defaultProfile(NOW), 'rift.hull.brute'), shards: 7 };
    const { grant, profile } = rollGrant(p, input({ gameType: 'dungeon', tokens: [{ rarity: 3, set: 'rift', source: 'bossCache' }], shards: 12 }), rngFn(1), NOW);
    expect(grant.items).toEqual([{ itemId: 'rift.hull.brute', rarity: 3, from: 'cache', source: 'bossCache', dupe: true, shards: SALVAGE_VALUE[3] }]);
    expect(grant.shards).toBe(12 + SALVAGE_VALUE[3]);
    expect(profile.shards).toBe(7 + 12 + SALVAGE_VALUE[3]);
    expect(Object.keys(profile.owned)).toEqual(['rift.hull.brute']);
    expect(profile.fresh).toEqual([]);
  });

  it('shards cap at SHARDS_MAX', () => {
    const p = { ...defaultProfile(NOW), shards: SHARDS_MAX - 3 };
    expect(rollGrant(p, input({ shards: 50 }), rngFn(1), NOW).profile.shards).toBe(SHARDS_MAX);
  });
});

describe('sequential application', () => {
  it('never reveals the same item as new twice in one grant', () => {
    // Salvage epic pool is one item: the first reveal is new, the rest are duplicates.
    const tokens: CacheToken[] = Array.from({ length: 6 }, () => ({ rarity: 3, set: 'common', source: 'boss' }));
    const { grant, profile } = rollGrant(defaultProfile(NOW), input({ tokens }), rngFn(4), NOW);
    expect(grant.items.map((i) => i.dupe)).toEqual([false, true, true, true, true, true]);
    expect(grant.shards).toBe(5 * SALVAGE_VALUE[3]);
    expect(profile.owned['com.death.glass']).toEqual({ at: NOW, src: 'arena' });
    expect(profile.fresh).toEqual(['com.death.glass']);
  });

  it('fuzz: new items are unique and unowned before; duplicates were owned before or earlier in the grant', () => {
    const r = new Rng(77);
    for (let n = 0; n < 300; n++) {
      const t = GAME_TYPE_IDS[r.int(0, 2)];
      let p = defaultProfile(NOW);
      const pre = Object.keys(COSMETICS).filter((id) => COSMETICS[id].set !== 'starter' && r.chance(0.3));
      p = own(p, ...pre);
      p = { ...p, pity: { [t]: r.int(0, PITY_EPIC - 1) }, pityLegendary: r.int(0, PITY_LEGENDARY - 1) };
      const tokens: CacheToken[] = Array.from({ length: r.int(0, 12) }, () => ({
        rarity: r.int(0, 4) as Rarity, set: LOOT_SETS[r.int(0, 3)], source: 'elite',
      }));
      const inp = input({ grantKey: `f:${n}#k#0`, gameType: t, tokens, crateRolls: r.int(0, 5), shards: r.int(0, 60), won: r.chance(0.5), cachesLost: r.int(0, 3) });
      const { grant, profile } = rollGrant(p, inp, grantRng(inp.grantKey, 'k'), NOW);
      const seen = new Set(pre);
      let dupeShards = 0;
      for (const it of grant.items) {
        if (it.dupe) { expect(seen.has(it.itemId)).toBe(true); dupeShards += it.shards; expect(it.shards).toBe(SALVAGE_VALUE[it.rarity]); }
        else { expect(seen.has(it.itemId)).toBe(false); seen.add(it.itemId); expect(it.shards).toBe(0); }
        expect(COSMETICS[it.itemId].rarity).toBe(it.rarity);
      }
      expect(grant.items.length).toBe(tokens.length + inp.crateRolls);
      expect(grant.shards).toBe(inp.shards + dupeShards);
      expect(grant.cachesSecured).toBe(tokens.length);
      expect(new Set(Object.keys(profile.owned))).toEqual(seen);
      // rollGrant's profile is exactly applyGrant of its grant.
      expect(applyGrant(p, grant, NOW, inp.won)).toEqual(profile);
      // The result is already normalized.
      expect(normalizeProfile(JSON.parse(JSON.stringify(profile)), NOW).profile).toEqual(profile);
    }
  });

  it('tokens keep their set, rarity and source; unknown token shapes are ignored', () => {
    const tokens = [
      { rarity: 1, set: 'gladiator', source: 'flagCapture' },
      { rarity: 9, set: 'swarm', source: 'boss' },     // rarity clamped to legendary
      { rarity: 0, set: 'moon', source: 'elite' },      // unknown set: ignored
      null,
    ] as unknown as CacheToken[];
    const { grant } = rollGrant(defaultProfile(NOW), input({ tokens }), rngFn(2), NOW);
    expect(grant.items.length).toBe(2);
    expect(grant.items[0]).toMatchObject({ rarity: 1, from: 'cache', source: 'flagCapture' });
    expect(COSMETICS[grant.items[0].itemId].set).toBe('gladiator');
    expect(grant.items[1]).toMatchObject({ rarity: 4, itemId: 'swarm.turret.laser' });
    expect(grant.cachesSecured).toBe(2);
  });
});

describe('pity', () => {
  /** Roll `count` single-crate grants with an all-zero stream (every natural crate is a mode-set common). */
  const crates = (p: Profile, t: GameType, count: number) => {
    const out: { grant: ReturnType<typeof rollGrant>['grant']; profile: Profile }[] = [];
    for (let i = 0; i < count; i++) { const r = rollGrant(p, input({ gameType: t, crateRolls: 1 }), () => 0, NOW); out.push(r); p = r.profile; }
    return out;
  };

  it('the 12th crate without an epic+ reveal is a forced epic from the mode set', () => {
    const rs = crates(defaultProfile(NOW), 'arena', 12);
    for (let i = 0; i < 11; i++) {
      expect(rs[i].grant.items[0]).toMatchObject({ rarity: 0, from: 'crate' });
      expect(rs[i].grant.epicIn).toBe(PITY_EPIC - (i + 1));
      expect(rs[i].profile.pity.arena).toBe(i + 1);
    }
    expect(rs[11].grant.items[0]).toMatchObject({ rarity: 3, from: 'pity', itemId: 'glad.hull.tech' });
    expect(rs[11].grant.epicIn).toBe(PITY_EPIC);
    expect(rs[11].profile.pity.arena).toBeUndefined(); // reset
    expect(rs[11].profile.pityLegendary).toBe(12);
  });

  it('epic pity is per game type; a single grant with 12 crates forces the 12th', () => {
    let p = crates(defaultProfile(NOW), 'arena', 11).at(-1)!.profile;
    p = crates(p, 'dungeon', 1)[0].profile;
    expect(p.pity).toEqual({ arena: 11, dungeon: 1 });
    const { grant } = rollGrant(defaultProfile(NOW), input({ gameType: 'dungeon', crateRolls: 12 }), () => 0, NOW);
    expect(grant.items.map((i) => i.from)).toEqual([...Array(11).fill('crate'), 'pity']);
    expect(grant.items[11]).toMatchObject({ rarity: 3, itemId: 'rift.hull.brute' });
  });

  it('a natural epic+ crate resets epic pity; caches never touch pity', () => {
    const p = { ...defaultProfile(NOW), pity: { warzone: 10 }, pityLegendary: 30 };
    // rarity draw 0.97 → epic (95..99.5 of 100); set draw 0 → mode set; pick 0.
    const nat = rollGrant(p, input({ gameType: 'warzone', crateRolls: 1 }), script([0.97, 0, 0]), NOW);
    expect(nat.grant.items[0]).toMatchObject({ rarity: 3, from: 'crate', itemId: 'swarm.hull.tech' });
    expect(nat.profile.pity.warzone).toBeUndefined();
    expect(nat.profile.pityLegendary).toBe(31);
    const caches = rollGrant(p, input({ gameType: 'warzone', tokens: [{ rarity: 4, set: 'swarm', source: 'boss' }] }), rngFn(1), NOW);
    expect(caches.profile.pity).toEqual({ warzone: 10 });
    expect(caches.profile.pityLegendary).toBe(30);
    expect(caches.grant.epicIn).toBe(2);
    expect(caches.grant.legendaryIn).toBe(30);
  });

  it('the 60th crate in any mode is a forced legendary from the current mode set (and resets both counters)', () => {
    let p = defaultProfile(NOW);
    const seen: { t: GameType; from: string; rarity: number; id: string }[] = [];
    for (let i = 0; i < PITY_LEGENDARY; i++) {
      const t = GAME_TYPE_IDS[i % 3];
      const r = rollGrant(p, input({ gameType: t, crateRolls: 1 }), () => 0, NOW);
      seen.push({ t, from: r.grant.items[0].from, rarity: r.grant.items[0].rarity, id: r.grant.items[0].itemId });
      p = r.profile;
    }
    const last = seen[PITY_LEGENDARY - 1];
    expect(last.from).toBe('pity');
    expect(last.rarity).toBe(4);
    expect(COSMETICS[last.id].set).toBe(SET_FOR_TYPE[last.t]);
    expect(seen.slice(0, -1).some((s) => s.rarity === 4)).toBe(false);
    expect(p.pityLegendary).toBe(0);
    expect(p.pity[last.t]).toBeUndefined();
    // 60 crates split over 3 types = 20 each → one forced epic per type along the way (at that type's 12th crate).
    expect(seen.filter((s) => s.from === 'pity' && s.rarity === 3).length).toBe(3);
  });

  it('legendary pity also fires inside one big grant', () => {
    const p = { ...defaultProfile(NOW), pityLegendary: PITY_LEGENDARY - 2 };
    const { grant, profile } = rollGrant(p, input({ gameType: 'arena', crateRolls: 3 }), () => 0, NOW);
    expect(grant.items.map((i) => [i.from, i.rarity])).toEqual([['crate', 0], ['pity', 4], ['crate', 0]]);
    expect(grant.items[1].itemId).toBe('glad.hull.brute');
    expect(profile.pityLegendary).toBe(1);
    expect(grant.legendaryIn).toBe(PITY_LEGENDARY - 1);
  });
});

describe('grant RNG', () => {
  it('same grantKey + profileKey → same items (retry-safe)', () => {
    const p = own(defaultProfile(NOW), 'com.title.wingman');
    const inp = input({ grantKey: 'boot7:3#acct-9#0', gameType: 'dungeon', crateRolls: 4, tokens: [
      { rarity: 1, set: 'rift', source: 'keyChest' }, { rarity: 2, set: 'rift', source: 'bossCache' }, { rarity: 0, set: 'common', source: 'roomChest' },
    ] });
    const a = rollGrant(p, inp, grantRng(inp.grantKey, 'acct-9'), NOW);
    const b = rollGrant(p, inp, grantRng(inp.grantKey, 'acct-9'), NOW);
    expect(b).toEqual(a);
    expect(grantSeed(inp.grantKey, 'acct-9')).toBe(grantSeed('boot7:3#acct-9#0', 'acct-9'));
    expect(grantSeed(inp.grantKey, 'acct-9')).not.toBe(grantSeed('boot7:3#acct-9#1', 'acct-9'));
  });

  it('never mutates the input profile', () => {
    const p = own(defaultProfile(NOW), 'rift.hull.brute');
    const before = JSON.stringify(p);
    rollGrant(p, input({ gameType: 'dungeon', crateRolls: 5, tokens: [{ rarity: 3, set: 'rift', source: 'boss' }] }), rngFn(1), NOW);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('garbage inputs are bounded and safe', () => {
    const bad = { grantKey: 5, gameType: 'moon', tokens: 'x', crateRolls: 1e9, shards: -5, won: 'yes', cachesLost: NaN } as unknown as GrantInput;
    const { grant } = rollGrant(defaultProfile(NOW), bad, rngFn(1), NOW);
    expect(grant.gameType).toBe('arena');
    expect(grant.grantKey).toBe('');
    expect(grant.items.length).toBe(100);
    expect(grant.shards).toBeGreaterThanOrEqual(0);
    expect(grant.cachesLost).toBe(0);
  });
});

describe('applyGrant', () => {
  it('guest device: a non-dupe already owned on the device converts to shards; stats and recent update', () => {
    const server = rollGrant(defaultProfile(NOW), input({ gameType: 'arena', tokens: [{ rarity: 3, set: 'common', source: 'shutdown' }], shards: 20, cachesLost: 1 }), rngFn(1), NOW);
    expect(server.grant.items[0]).toMatchObject({ itemId: 'com.death.glass', dupe: false });
    const device = { ...own(defaultProfile(NOW), 'com.death.glass'), shards: 3 };
    const next = applyGrant(device, server.grant, NOW + 1);
    expect(next.shards).toBe(3 + 20 + SALVAGE_VALUE[3]);
    expect(next.owned['com.death.glass']).toEqual({ at: 1, src: 'arena' });
    expect(next.stats).toMatchObject({ matches: 1, wins: 0, cachesSecured: 1, cachesLost: 1 });
    expect(next.stats.byType.arena).toEqual({ matches: 1, wins: 0 });
    expect(next.recent[0]).toEqual({ at: NOW + 1, gameType: 'arena', itemIds: [], shards: 20 });
    expect(next.updatedAt).toBe(NOW + 1);
    // Fresh device: the item is new.
    const fresh = applyGrant(defaultProfile(NOW), server.grant, NOW + 1, true);
    expect(fresh.owned['com.death.glass']).toEqual({ at: NOW + 1, src: 'arena' });
    expect(fresh.fresh).toEqual(['com.death.glass']);
    expect(fresh.stats.wins).toBe(1);
  });

  it('fresh is newest first and capped; recent is capped', () => {
    let p = defaultProfile(NOW);
    for (let i = 0; i < 30; i++) {
      const r = rollGrant(p, input({ grantKey: `g${i}`, gameType: GAME_TYPE_IDS[i % 3], crateRolls: 3, tokens: [{ rarity: 0, set: 'common', source: 'elite' }] }), grantRng(`g${i}`, 'k'), NOW + i);
      p = r.profile;
      const newIds = r.grant.items.filter((x) => !x.dupe).map((x) => x.itemId);
      if (newIds.length) expect(p.fresh[0]).toBe(newIds[newIds.length - 1]);
    }
    expect(p.fresh.length).toBeLessThanOrEqual(FRESH_MAX);
    expect(p.recent.length).toBeLessThanOrEqual(20);
    expect(p.stats.matches).toBe(30);
    expect(p.recent[0].at).toBe(NOW + 29);
  });

  it('ignores unknown and starter item ids', () => {
    const g = { grantKey: 'k', gameType: 'arena' as const, items: [
      { itemId: 'nope.hull.x', rarity: 1 as Rarity, from: 'cache' as const, dupe: false, shards: 0 },
      { itemId: 'std.hull.brute', rarity: 0 as Rarity, from: 'cache' as const, dupe: false, shards: 0 },
    ], shards: 0, cachesSecured: 2, cachesLost: 0, epicIn: 12, legendaryIn: 60 };
    expect(applyGrant(defaultProfile(NOW), g, NOW).owned).toEqual({});
  });
});

describe('botWardrobe', () => {
  it('is deterministic per (seed, gameType, class) and only uses mode-set / Salvage items ≤ BOT_MAX_RARITY that fit', () => {
    for (const t of GAME_TYPE_IDS) {
      for (const c of SHIP_CLASS_IDS) {
        for (let seed = 0; seed < 200; seed++) {
          const w = botWardrobe(seed, t, c);
          expect(botWardrobe(seed, t, c)).toEqual(w);
          for (const [slot, id] of Object.entries(w)) {
            const d = COSMETICS[id!];
            expect(d, id).toBeDefined();
            expect(['common', SET_FOR_TYPE[t]] as (LootSet | 'starter')[]).toContain(d.set);
            expect(d.rarity).toBeLessThanOrEqual(BOT_MAX_RARITY);
            expect(fitsSlot(d, slot as (typeof COSMETIC_SLOTS)[number], c)).toBe(true);
          }
        }
      }
    }
  });

  it('slot hit rates track BOT_SLOT_CHANCE and looks vary by seed', () => {
    const n = 6000;
    const hits: Record<string, number> = {};
    const looks = new Set<string>();
    for (let seed = 0; seed < n; seed++) {
      const w = botWardrobe(seed * 7919 + 13, 'warzone', 'brute');
      looks.add(JSON.stringify(w));
      for (const s of Object.keys(w)) hits[s] = (hits[s] ?? 0) + 1;
    }
    for (const s of COSMETIC_SLOTS) expect(Math.abs((hits[s] ?? 0) / n - BOT_SLOT_CHANCE[s]), s).toBeLessThanOrEqual(0.03);
    expect(looks.size).toBeGreaterThan(100);
  });
});

describe('economy helpers', () => {
  it('crate eligibility: 120 s played in a 180 s match; dungeon also after ≥ 1 floor', () => {
    expect(crateEligible({ gameType: 'arena', playedSec: 120, matchSec: 180, won: false })).toBe(true);
    expect(crateEligible({ gameType: 'arena', playedSec: 119, matchSec: 600, won: true })).toBe(false);
    expect(crateEligible({ gameType: 'warzone', playedSec: 170, matchSec: 179, won: true })).toBe(false);
    expect(crateEligible({ gameType: 'dungeon', playedSec: 30, matchSec: 60, won: false, floorsCleared: 1 })).toBe(true);
    expect(crateEligible({ gameType: 'dungeon', playedSec: 30, matchSec: 60, won: false, floorsCleared: 0 })).toBe(false);
  });

  it('crate counts: base 1, +1 win (arena/warzone); dungeon +1/floor (max +3) +1 full clear', () => {
    const ok = { playedSec: 600, matchSec: 600 };
    expect(crateCount({ gameType: 'arena', ...ok, won: false })).toBe(1);
    expect(crateCount({ gameType: 'warzone', ...ok, won: true })).toBe(2);
    expect(crateCount({ gameType: 'arena', playedSec: 10, matchSec: 600, won: true })).toBe(0);
    expect(crateCount({ gameType: 'dungeon', ...ok, won: true, floorsCleared: 2 })).toBe(3);
    expect(crateCount({ gameType: 'dungeon', ...ok, won: true, floorsCleared: 6, fullClear: true })).toBe(5);
    expect(crateCount({ gameType: 'dungeon', ...ok, won: false, floorsCleared: 0 })).toBe(1);
  });

  it('base shards: 5 + 1/min (cap +25) + 10 win + 10 MVP', () => {
    expect(baseShards({ playedSec: 59, won: false, mvp: false })).toBe(5);
    expect(baseShards({ playedSec: 600, won: true, mvp: false })).toBe(25);
    expect(baseShards({ playedSec: 3600, won: true, mvp: true })).toBe(50);
    expect(baseShards({ playedSec: -5, won: false, mvp: true })).toBe(15);
  });
});
