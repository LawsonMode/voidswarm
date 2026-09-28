// LOOT: pure profile ops (docs/v0.3-proposal.md §7.1, §9 LOOT acceptance: normalizeProfile + equip rules).
import { describe, expect, it } from 'vitest';
import { PROFILE_VERSION, type Profile } from '../protocol';
import { FRESH_MAX, PITY_EPIC, PITY_LEGENDARY, RECENT_MAX, SHARDS_MAX } from '../data/loot';
import { starterId } from '../data/cosmetics';
import { cosmeticDef, defaultProfile, equip, equippedId, isCosmeticIdLike, markSeen, normalizeProfile, ownsItem, resolveLoadout } from './profile';

const NOW = 1_700_000_000_000;
const own = (p: Profile, ...ids: string[]): Profile => {
  const owned = { ...p.owned };
  for (const id of ids) owned[id] = { at: NOW, src: 'arena' };
  return { ...p, owned };
};
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};

describe('defaultProfile', () => {
  it('is an empty v1 profile (starters implicit)', () => {
    const p = defaultProfile(NOW);
    expect(p.v).toBe(PROFILE_VERSION);
    expect(p.owned).toEqual({});
    expect(p.shards).toBe(0);
    expect(p.loadout).toEqual({ shared: {}, byClass: {} });
    expect(p.fresh).toEqual([]);
    expect(p.pity).toEqual({});
    expect(p.pityLegendary).toBe(0);
    expect(p.stats).toEqual({ matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} });
    expect(p.recent).toEqual([]);
    expect(p.updatedAt).toBe(NOW);
    expect(ownsItem(p, 'std.hull.brute')).toBe(true);
    expect(ownsItem(p, 'rift.hull.brute')).toBe(false);
  });
});

describe('normalizeProfile', () => {
  it('garbage input → default, writable; never throws', () => {
    const junk: unknown[] = [
      null, undefined, 0, 42, NaN, '', 'profile', true, [], [1, 2], () => 1, Symbol('x'),
      { v: 'x' }, { owned: 5 }, { owned: [], loadout: 'x', fresh: 'x', pity: [], stats: 3, recent: {} },
    ];
    for (const j of junk) {
      const r = normalizeProfile(j, NOW);
      expect(r.writable).toBe(true);
      expect(r.profile.v).toBe(PROFILE_VERSION);
      expect(r.profile.owned).toEqual({});
      expect(r.profile.shards).toBe(0);
    }
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
    expect(() => normalizeProfile(hostile, NOW)).not.toThrow();
  });

  it('round-trips a valid profile unchanged (through JSON)', () => {
    let p = own(defaultProfile(NOW), 'rift.hull.brute', 'com.engine.aurora', 'glad.title.champion');
    p = { ...p, shards: 1234, fresh: ['rift.hull.brute'], pity: { dungeon: 5 }, pityLegendary: 17 };
    p = (equip(p, 'hull', 'rift.hull.brute', 'brute') as { ok: true; profile: Profile }).profile;
    p = (equip(p, 'engine', 'com.engine.aurora') as { ok: true; profile: Profile }).profile;
    p = { ...p, stats: { matches: 3, wins: 1, cachesSecured: 4, cachesLost: 2, byType: { dungeon: { matches: 3, wins: 1 } } } };
    p = { ...p, recent: [{ at: NOW, gameType: 'dungeon', itemIds: ['rift.hull.brute'], shards: 40 }] };
    const r = normalizeProfile(JSON.parse(JSON.stringify(p)), NOW + 5);
    expect(r.writable).toBe(true);
    expect(r.profile).toEqual(p);
  });

  it('preserves unknown (future / removed) owned ids but never equips them', () => {
    const raw = { v: 1, owned: { 'rift.tracer.void': { at: NOW, src: 'dungeon' }, 'rift.hull.brute': { at: NOW, src: 'dungeon' } },
      loadout: { shared: { engine: 'rift.tracer.void' }, byClass: { brute: { hull: 'rift.tracer.void' } } } };
    const { profile } = normalizeProfile(raw, NOW);
    expect(profile.owned['rift.tracer.void']).toEqual({ at: NOW, src: 'dungeon' });
    expect(profile.owned['rift.hull.brute']).toBeDefined();
    expect(profile.loadout).toEqual({ shared: {}, byClass: {} });
    expect(equip(profile, 'engine', 'rift.tracer.void').ok).toBe(false);
  });

  it('drops malformed owned entries, starters and junk keys (no prototype pollution)', () => {
    const owned = JSON.parse(`{
      "__proto__": { "at": 1, "src": "arena" },
      "constructor": { "at": 1, "src": "arena" },
      "std.hull.brute": { "at": 1, "src": "arena" },
      "com.hull.tech": { "at": "yesterday", "src": "arena" },
      "com.hull.brute": { "at": 1, "src": "nowhere" },
      "com.weapon.tech": 7,
      "has space": { "at": 1, "src": "arena" },
      "${'x'.repeat(41)}": { "at": 1, "src": "arena" },
      "com.title.wingman": { "at": 5, "src": "warzone" },
      "com.death.glass": { "at": 6, "src": "craft" }
    }`);
    const { profile } = normalizeProfile({ v: 1, owned }, NOW);
    expect(Object.keys(profile.owned).sort()).toEqual(['com.death.glass', 'com.title.wingman']);
    expect(Object.getPrototypeOf(profile.owned)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).at).toBeUndefined();
  });

  it('clamps shards to [0, SHARDS_MAX] and counters to non-negative integers', () => {
    expect(normalizeProfile({ shards: -50 }, NOW).profile.shards).toBe(0);
    expect(normalizeProfile({ shards: 12.9 }, NOW).profile.shards).toBe(12);
    expect(normalizeProfile({ shards: 1e12 }, NOW).profile.shards).toBe(SHARDS_MAX);
    expect(normalizeProfile({ shards: Infinity }, NOW).profile.shards).toBe(0);
    expect(normalizeProfile({ shards: '500' }, NOW).profile.shards).toBe(0);
    const p = normalizeProfile({ pity: { arena: 99, dungeon: -3, warzone: 'x', moon: 5 }, pityLegendary: 500,
      stats: { matches: -1, wins: 2.5, cachesSecured: 'x', byType: { arena: { matches: 3 }, moon: { matches: 1 } } } }, NOW).profile;
    expect(p.pity).toEqual({ arena: PITY_EPIC - 1 });
    expect(p.pityLegendary).toBe(PITY_LEGENDARY - 1);
    expect(p.stats).toEqual({ matches: 0, wins: 2, cachesSecured: 0, cachesLost: 0, byType: { arena: { matches: 3, wins: 0 } } });
  });

  it('bad loadout entries fall back to the starter (unknown, wrong slot, wrong class, unowned, starter ids)', () => {
    const raw = {
      v: 1,
      owned: { 'rift.hull.brute': { at: 1, src: 'dungeon' }, 'com.engine.aurora': { at: 1, src: 'arena' }, 'glad.hull.tech': { at: 1, src: 'arena' } },
      loadout: {
        shared: { engine: 'com.engine.aurora', death: 'rift.hull.brute', title: 'glad.title.champion', killicon: 'std.killicon', hull: 'rift.hull.brute' },
        byClass: {
          brute: { hull: 'rift.hull.brute', weapon: 'nope', turret: 'rift.hull.brute' },
          tech: { hull: 'rift.hull.brute' },          // wrong class
          engineer: { hull: 'glad.hull.tech' },       // wrong class
          striker: { hull: 'rift.hull.brute' },       // unknown class
        },
      },
    };
    const { profile } = normalizeProfile(raw, NOW);
    expect(profile.loadout).toEqual({ shared: { engine: 'com.engine.aurora' }, byClass: { brute: { hull: 'rift.hull.brute' } } });
  });

  it('fresh keeps owned ids only, deduped, ≤ FRESH_MAX; recent ≤ RECENT_MAX with valid entries', () => {
    const owned: Record<string, unknown> = {};
    const ids = ['com.killicon.crosshair', 'com.title.wingman', 'com.weapon.engineer'];
    for (const id of ids) owned[id] = { at: 1, src: 'arena' };
    const fresh = [...ids, ids[0], 'rift.hull.brute', 5, ...Array.from({ length: 100 }, () => ids[1])];
    const recent = [
      ...Array.from({ length: 30 }, (_, i) => ({ at: i, gameType: 'arena', itemIds: ['com.title.wingman', 7], shards: 5 })),
    ];
    const p = normalizeProfile({ owned, fresh, recent: [{ at: 'x' }, { at: 1, gameType: 'moon' }, ...recent] }, NOW).profile;
    expect(p.fresh).toEqual(ids);
    expect(p.fresh.length).toBeLessThanOrEqual(FRESH_MAX);
    expect(p.recent.length).toBe(RECENT_MAX);
    expect(p.recent[0]).toEqual({ at: 0, gameType: 'arena', itemIds: ['com.title.wingman'], shards: 5 });
  });

  it('v > PROFILE_VERSION is read-only for the session (still readable)', () => {
    const raw = { v: PROFILE_VERSION + 1, owned: { 'rift.hull.brute': { at: 1, src: 'dungeon' } }, shards: 10, newField: { x: 1 } };
    const r = normalizeProfile(raw, NOW);
    expect(r.writable).toBe(false);
    expect(r.profile.owned['rift.hull.brute']).toBeDefined();
    expect(r.profile.shards).toBe(10);
    expect(normalizeProfile({ v: PROFILE_VERSION }, NOW).writable).toBe(true);
    expect(normalizeProfile({ v: 0 }, NOW).writable).toBe(true);
  });

  it('does not mutate its input', () => {
    const raw = deepFreeze({ v: 1, owned: { 'rift.hull.brute': { at: 1, src: 'dungeon' } }, fresh: ['rift.hull.brute', 'x'], shards: -4 });
    expect(() => normalizeProfile(raw, NOW)).not.toThrow();
  });
});

describe('equip', () => {
  const base = own(defaultProfile(NOW), 'rift.hull.brute', 'glad.hull.tech', 'rift.turret.flak', 'com.engine.aurora', 'glad.title.champion');

  it('equips an owned item that fits the slot and class, and resolveLoadout shows it', () => {
    const r = equip(base, 'hull', 'rift.hull.brute', 'brute');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.loadout.byClass.brute?.hull).toBe('rift.hull.brute');
    expect(resolveLoadout(r.profile, 'brute')).toEqual({ hull: 'rift.hull.brute' });
    expect(resolveLoadout(r.profile, 'tech')).toEqual({});
    expect(equippedId(r.profile, 'hull', 'brute')).toBe('rift.hull.brute');
    expect(equippedId(r.profile, 'hull', 'tech')).toBe('std.hull.tech');
  });

  it('turret items fit only the class whose kit they are for', () => {
    // brute's kit is flak
    expect(equip(base, 'turret', 'rift.turret.flak', 'brute').ok).toBe(true);
    expect(equip(base, 'turret', 'rift.turret.flak', 'tech').ok).toBe(false);
  });

  it('shared slots ignore shipClass and apply to every class', () => {
    const r = equip(base, 'engine', 'com.engine.aurora', 'tech');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.loadout.shared.engine).toBe('com.engine.aurora');
    for (const c of ['brute', 'tech', 'engineer'] as const) expect(resolveLoadout(r.profile, c).engine).toBe('com.engine.aurora');
  });

  it("'' or the fitting starter id resets to the starter", () => {
    const on = equip(base, 'hull', 'rift.hull.brute', 'brute');
    if (!on.ok) throw new Error('setup');
    const off = equip(on.profile, 'hull', '', 'brute');
    expect(off.ok && off.profile.loadout.byClass.brute).toBeUndefined();
    const off2 = equip(on.profile, 'hull', starterId('hull', 'brute'), 'brute');
    expect(off2.ok && off2.profile.loadout.byClass).toEqual({});
    const t = equip(base, 'title', 'glad.title.champion');
    if (!t.ok) throw new Error('setup');
    const t0 = equip(t.profile, 'title', 'std.title');
    expect(t0.ok && t0.profile.loadout.shared).toEqual({});
  });

  it('rejects unowned, unknown, wrong-slot, wrong-class items and missing class for class slots', () => {
    const cases: [Parameters<typeof equip>[1], string, Parameters<typeof equip>[3]][] = [
      ['hull', 'swarm.hull.brute', 'brute'],      // not owned
      ['hull', 'nope.hull.brute', 'brute'],       // unknown
      ['hull', 'constructor', 'brute'],           // prototype key
      ['weapon', 'rift.hull.brute', 'brute'],     // wrong slot
      ['hull', 'rift.hull.brute', 'tech'],        // wrong class
      ['hull', 'std.hull.tech', 'brute'],         // starter of another class
      ['hull', 'rift.hull.brute', undefined],     // class slot without class
      ['engine', 'glad.title.champion', undefined], // wrong shared slot
    ];
    for (const [slot, id, cls] of cases) {
      const r = equip(base, slot, id, cls);
      expect(r.ok, `${slot} ${id} ${cls}`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
    expect(equip(base, 'tracer' as never, 'rift.hull.brute', 'brute').ok).toBe(false);
    expect(equip(base, 'hull', 'rift.hull.brute', 'striker' as never).ok).toBe(false);
  });

  it('is pure: no mutation, and an unchanged equip returns the same profile', () => {
    const frozen = deepFreeze(own(defaultProfile(NOW), 'rift.hull.brute'));
    const r = equip(frozen, 'hull', 'rift.hull.brute', 'brute');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(frozen.loadout.byClass).toEqual({});
    const again = equip(r.profile, 'hull', 'rift.hull.brute', 'brute');
    expect(again.ok && again.profile).toBe(r.profile);
    const noop = equip(frozen, 'hull', '', 'brute');
    expect(noop.ok && noop.profile).toBe(frozen);
  });

  it('resolveLoadout re-validates a stale loadout (item no longer owned)', () => {
    const r = equip(base, 'hull', 'rift.hull.brute', 'brute');
    if (!r.ok) throw new Error('setup');
    const stale = { ...r.profile, owned: {} };
    expect(resolveLoadout(stale, 'brute')).toEqual({});
  });
});

describe('markSeen', () => {
  it('clears only the given NEW badges; unchanged → same object', () => {
    const p = { ...own(defaultProfile(NOW), 'a.b', 'com.title.wingman'), fresh: ['com.title.wingman', 'rift.hull.brute'] };
    const q = markSeen(p, ['com.title.wingman', 'zzz']);
    expect(q.fresh).toEqual(['rift.hull.brute']);
    expect(p.fresh).toEqual(['com.title.wingman', 'rift.hull.brute']);
    expect(markSeen(q, ['zzz'])).toBe(q);
    expect(markSeen(q, [])).toBe(q);
  });
});

describe('id helpers', () => {
  it('cosmeticDef / isCosmeticIdLike are own-property safe', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype']) expect(cosmeticDef(k), k).toBeUndefined();
    expect(isCosmeticIdLike('__proto__')).toBe(false);
    expect(isCosmeticIdLike('constructor')).toBe(false);
    expect(isCosmeticIdLike('rift.hull.brute')).toBe(true);
    expect(isCosmeticIdLike('x'.repeat(41))).toBe(false);
    expect(ownsItem(defaultProfile(NOW), 'toString')).toBe(false);
  });
});
