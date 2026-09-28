// LOOT: catalog invariants (docs/v0.3-proposal.md §6.1–6.2, §9 LOOT acceptance).
import { describe, expect, it } from 'vitest';
import { LOOT_SETS, type CosmeticSlot, type LootSet, type Rarity, type ShipClassId, type TurretKitId } from '../types';
import {
  CLASS_SLOTS, COSMETICS, COSMETIC_LIST, COSMETIC_SLOTS, SHARED_SLOTS, fitsSlot, isStarter, lootPool, starterId,
  type CosmeticDef,
} from './cosmetics';
import { GAME_TYPE_IDS } from './gameTypes';
import {
  CACHE_RARITY_W, CRATE_RARITY_W, DROP_RULES, MODE_SET_SHARE, PITY_EPIC, PITY_LEGENDARY, RARITY_COLORS, RARITY_NAMES,
  SALVAGE_VALUE, SET_FOR_TYPE, SET_INFO,
} from './loot';
import { SHIP_CLASSES, SHIP_CLASS_IDS } from './ships';
import { isCosmeticIdLike } from '../profile/profile';

const RARITIES: Rarity[] = [0, 1, 2, 3, 4];
const KITS = SHIP_CLASS_IDS.map((c) => SHIP_CLASSES[c].turret.id) as TurretKitId[];
const SET_PREFIX: Record<LootSet | 'starter', string> = { starter: 'std', common: 'com', rift: 'rift', gladiator: 'glad', swarm: 'swarm' };
const bySet = (s: LootSet | 'starter'): CosmeticDef[] => COSMETIC_LIST.filter((d) => d.set === s);
/** The award names from the results screen (titles must never collide with them). */
const AWARD_NAMES = ['Top Gun', 'Exterminator', 'Big Game Hunter', 'Field Medic', 'Battle Station', 'Most Stacked', 'Gem Hoarder', 'Ascended'];

describe('catalog ids', () => {
  it('has 65 entries with unique ids, all indexed in COSMETICS', () => {
    expect(COSMETIC_LIST.length).toBe(65);
    const ids = COSMETIC_LIST.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(COSMETICS).sort()).toEqual([...ids].sort());
    for (const d of COSMETIC_LIST) expect(COSMETICS[d.id]).toBe(d);
  });

  it('ids follow <set>.<slot>[.<class|kit|name>] and survive profile validation (≤ 40 chars)', () => {
    for (const d of COSMETIC_LIST) {
      const parts = d.id.split('.');
      expect(parts[0], d.id).toBe(SET_PREFIX[d.set]);
      expect(parts[1], d.id).toBe(d.slot);
      expect(isCosmeticIdLike(d.id), d.id).toBe(true);
      if (d.slot === 'hull' || d.slot === 'weapon') expect(parts[2], d.id).toBe(d.shipClass);
      if (d.slot === 'turret') expect(parts[2], d.id).toBe(d.kit);
    }
  });

  it('every item has flavor text of at most 60 chars', () => {
    for (const d of COSMETIC_LIST) {
      expect(d.flavor.trim().length, d.id).toBeGreaterThan(0);
      expect(d.flavor.length, d.id).toBeLessThanOrEqual(60);
    }
  });

  it('names are non-empty and unique; nothing is retired in v0.3', () => {
    const names = COSMETIC_LIST.map((d) => d.name);
    for (const n of names) expect(n.trim().length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(COSMETIC_LIST.some((d) => d.retired)).toBe(false);
  });
});

describe('starters', () => {
  it('13 starters: one per class slot per class, one per shared slot, all common', () => {
    const st = bySet('starter');
    expect(st.length).toBe(13);
    for (const c of SHIP_CLASS_IDS) {
      for (const slot of CLASS_SLOTS) {
        const id = starterId(slot, c);
        const def = COSMETICS[id];
        expect(def, id).toBeDefined();
        expect(def.set).toBe('starter');
        expect(fitsSlot(def, slot, c)).toBe(true);
      }
    }
    for (const slot of SHARED_SLOTS) {
      const id = starterId(slot, 'brute');
      expect(COSMETICS[id]?.set, id).toBe('starter');
      expect(starterId(slot, 'tech')).toBe(id);
    }
    for (const d of st) { expect(d.rarity).toBe(0); expect(isStarter(d.id)).toBe(true); }
    expect(isStarter('constructor')).toBe(false);
  });
});

describe('sets', () => {
  it.each(LOOT_SETS)('%s: 13 items, rarity mix C4 / U4 / R3 / E1 / L1', (s) => {
    const items = bySet(s);
    expect(items.length).toBe(13);
    const mix = RARITIES.map((r) => items.filter((d) => d.rarity === r).length);
    expect(mix).toEqual([4, 4, 3, 1, 1]);
  });

  it.each(LOOT_SETS)('%s: exactly one hull + weapon per class, one turret per kit, one per shared slot', (s) => {
    const items = bySet(s);
    for (const c of SHIP_CLASS_IDS) {
      expect(items.filter((d) => d.slot === 'hull' && d.shipClass === c).length, `${s} hull ${c}`).toBe(1);
      expect(items.filter((d) => d.slot === 'weapon' && d.shipClass === c).length, `${s} weapon ${c}`).toBe(1);
    }
    for (const k of KITS) expect(items.filter((d) => d.slot === 'turret' && d.kit === k).length, `${s} turret ${k}`).toBe(1);
    for (const slot of SHARED_SLOTS) expect(items.filter((d) => d.slot === slot).length, `${s} ${slot}`).toBe(1);
  });

  it('no (set, rarity) loot pool is empty; pools exclude starters', () => {
    for (const s of LOOT_SETS) {
      for (const r of RARITIES) {
        const pool = lootPool(s, r);
        expect(pool.length, `${s}|${r}`).toBeGreaterThan(0);
        for (const d of pool) { expect(d.set).toBe(s); expect(d.rarity).toBe(r); }
      }
    }
    const pooled = LOOT_SETS.flatMap((s) => RARITIES.flatMap((r) => lootPool(s, r)));
    expect(pooled.length).toBe(52);
  });

  it('every SET_INFO.featured id exists and belongs to its set', () => {
    for (const s of LOOT_SETS) {
      expect(SET_INFO[s].featured.length).toBeGreaterThan(0);
      for (const id of SET_INFO[s].featured) {
        expect(COSMETICS[id], id).toBeDefined();
        expect(COSMETICS[id].set).toBe(s);
      }
    }
  });

  it('each game type has its own exclusive set, and SET_INFO.mode agrees', () => {
    const sets = GAME_TYPE_IDS.map((t) => SET_FOR_TYPE[t]);
    expect(new Set(sets).size).toBe(GAME_TYPE_IDS.length);
    for (const t of GAME_TYPE_IDS) {
      expect(sets).not.toContain('common');
      expect(SET_INFO[SET_FOR_TYPE[t]].mode).toBe(t);
    }
    expect(SET_INFO.common.mode).toBeNull();
  });
});

describe('slot params', () => {
  it("titles are ≤ 14 chars of [A-Za-z' ] (lootable titles non-empty) and never an award name", () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'title') continue;
      expect(d.p.text, d.id).toMatch(/^[A-Za-z' ]{0,14}$/);
      if (d.set !== 'starter') expect(d.p.text.trim().length, d.id).toBeGreaterThan(0);
      expect(AWARD_NAMES.map((a) => a.toLowerCase())).not.toContain(d.p.text.toLowerCase());
    }
  });

  it('killicons are exactly one code point', () => {
    const glyphs = new Set<string>();
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'killicon') continue;
      expect([...d.p.glyph].length, d.id).toBe(1);
      glyphs.add(d.p.glyph);
    }
    expect(glyphs.size).toBe(5); // starter + 4 sets, all distinct
  });

  it('visual params stay within the documented bounds', () => {
    for (const d of COSMETIC_LIST) {
      switch (d.slot) {
        case 'hull': expect(d.p.amount).toBeGreaterThanOrEqual(0); expect(d.p.amount).toBeLessThanOrEqual(1); break;
        case 'weapon': expect(d.p.lengthMul).toBeGreaterThanOrEqual(0.8); expect(d.p.lengthMul).toBeLessThanOrEqual(1.6); break;
        case 'engine':
          expect(d.p.rateMul).toBeLessThanOrEqual(1.5);
          expect(d.p.mix).toBeGreaterThanOrEqual(0); expect(d.p.mix).toBeLessThanOrEqual(0.5);
          expect(d.p.lifeMul).toBeGreaterThanOrEqual(0.6); expect(d.p.lifeMul).toBeLessThanOrEqual(2);
          break;
        case 'death': expect(d.p.particles).toBeLessThanOrEqual(70); expect(d.p.linger).toBeLessThanOrEqual(1.5); break;
        default: break;
      }
    }
  });

  it('fitsSlot: class items fit only their class, turrets only their kit, shared items any class', () => {
    for (const d of COSMETIC_LIST) {
      for (const c of SHIP_CLASS_IDS) {
        for (const slot of COSMETIC_SLOTS as readonly CosmeticSlot[]) {
          let want = d.slot === slot;
          if (want && (d.slot === 'hull' || d.slot === 'weapon')) want = d.shipClass === c;
          if (want && d.slot === 'turret') want = d.kit === SHIP_CLASSES[c as ShipClassId].turret.id;
          expect(fitsSlot(d, slot, c), `${d.id} ${slot} ${c}`).toBe(want);
        }
      }
    }
  });
});

describe('economy tables (data/loot.ts)', () => {
  it('5 rarities everywhere, weights positive and ordered', () => {
    for (const t of [RARITY_NAMES, RARITY_COLORS, CACHE_RARITY_W, CRATE_RARITY_W, SALVAGE_VALUE]) expect(t.length).toBe(5);
    for (const w of [CACHE_RARITY_W, CRATE_RARITY_W]) {
      for (let r = 1; r < 5; r++) { expect(w[r]).toBeGreaterThan(0); expect(w[r]).toBeLessThan(w[r - 1]); }
      expect(w.reduce((a, b) => a + b, 0)).toBe(100);
    }
    for (let r = 1; r < 5; r++) expect(SALVAGE_VALUE[r]).toBeGreaterThan(SALVAGE_VALUE[r - 1]);
    expect(MODE_SET_SHARE).toBe(0.4);
    expect(PITY_EPIC).toBe(12);
    expect(PITY_LEGENDARY).toBe(60);
  });

  it('drop rules: chances in (0, 1] for known game types, valid floors', () => {
    for (const [src, rule] of Object.entries(DROP_RULES)) {
      expect(rule.floors.length, src).toBeGreaterThan(0);
      for (const f of rule.floors) expect(RARITIES).toContain(f);
      for (const [t, c] of Object.entries(rule.chance)) {
        expect(GAME_TYPE_IDS as readonly string[]).toContain(t);
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      if (rule.personal) { expect(rule.reserveSec).toBe(0); expect(Object.keys(rule.chance)).toEqual(['dungeon']); }
    }
  });
});
