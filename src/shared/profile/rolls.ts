// OWNER: LOOT agent. Pure grant rolls: crates, pity, identity rolls, duplicates → shards (docs/v0.3-proposal.md §6.6).
// Signatures of GrantInput / rollGrant / applyGrant / botWardrobe are frozen by §8.8; the extra exports below
// (rollRarity, rollSet, grantRng, crateCount, baseShards, …) are pure helpers for ROOM / SIM / CLIENT.
//
// Determinism: every function takes its randomness from the caller's `rnd` (or a seed) — never Math.random.
// grantRng(grantKey, profileKey) = Rng(fnv1a(grantKey + '|' + profileKey)) is the reproducible §6.6 stream (tests).
// The server does NOT roll with it: ProfileService salts grantSeed with fresh CSPRNG bits per roll (saltedGrantRng,
// M2 amendment), because every input of grantRng is known to the client, which could then predict and steer crates.
import type { CacheToken, CosmeticId, CosmeticLoadout, CosmeticSlot, GameType, LootSet, LootSource, Rarity, ShipClassId } from '../types';
import { LOOT_SETS } from '../types';
import type { GrantItem, LootGrant, Profile } from '../protocol';
import { COSMETIC_LIST, COSMETIC_SLOTS, fitsSlot, lootPool, type CosmeticDef } from '../data/cosmetics';
import { GAME_TYPE_IDS, isGameType } from '../data/gameTypes';
import { SHIP_CLASS_IDS } from '../data/ships';
import {
  BOT_MAX_RARITY, BOT_SLOT_CHANCE, CRATE_FLOOR_BONUS_MAX, CRATE_FULL_CLEAR_BONUS, CRATE_MIN_MATCH_SEC,
  CRATE_MIN_PLAYED_SEC, CRATE_RARITY_W, CRATE_WIN_BONUS, FRESH_MAX, MODE_SET_SHARE, OWNED_REROLLS, PITY_EPIC,
  PITY_LEGENDARY, RECENT_MAX, SALVAGE_VALUE, SET_FOR_TYPE, SHARDS_BASE, SHARDS_MAX, SHARDS_MVP, SHARDS_PER_MIN,
  SHARDS_TIME_CAP, SHARDS_WIN,
} from '../data/loot';
import { fnv1a, hash32 } from '../util/hash';
import { Rng } from '../util/rng';
import { cosmeticDef } from './profile';

export interface GrantInput {
  /** `${matchId}#${profileKey}#${seq}` (ledger key; also seeds the roll RNG). */
  grantKey: string;
  gameType: GameType;
  /** Secured bank ∪ sim.takeCarried(pid). */
  tokens: CacheToken[];
  /** Debrief crates to roll (0 on a mid-match leave). */
  crateRolls: number;
  /** Base shards (time / win / MVP); duplicates add on top. */
  shards: number;
  won: boolean;
  cachesLost: number;
}

/** Hard bounds on one grant (garbage-input guard; real grants are ≤ 5 crates and a few dozen tokens). */
export const MAX_GRANT_CRATES = 100;
export const MAX_GRANT_TOKENS = 256;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const nat = (v: unknown, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0;
const asRarity = (v: unknown): Rarity => nat(v, 4) as Rarity;

// ---------------------------------------------------------------------------------------------
// Seeds + primitive rolls
// ---------------------------------------------------------------------------------------------

/** The grant RNG seed (§6.6 step 5). */
export function grantSeed(grantKey: string, profileKey: string): number {
  return fnv1a(`${grantKey}|${profileKey}`);
}
/** Reproducible `rnd` stream for rollGrant: Rng(fnv1a(grantKey + '|' + profileKey)). Server grants use the salted one. */
export function grantRng(grantKey: string, profileKey: string): () => number {
  const r = new Rng(grantSeed(grantKey, profileKey));
  return () => r.next();
}

/**
 * Weighted rarity pick restricted to rarities ≥ `floor`; weights of rare+ (≥ 2) are multiplied by `rareBoost`
 * (dungeon: riftRarityBoost(floor, pve)), then renormalized. Consumes exactly one `rnd()`.
 * SIM's sim/loot.ts can call this with CACHE_RARITY_W and `() => lootRng.next()`.
 */
export function rollRarity(weights: readonly number[], floor: number, rnd: () => number, rareBoost = 1): Rarity {
  const f = nat(floor, 4);
  const boost = Number.isFinite(rareBoost) && rareBoost > 0 ? rareBoost : 1;
  const w = [0, 0, 0, 0, 0];
  let total = 0;
  for (let r = f; r < 5; r++) {
    const base = weights[r];
    const x = typeof base === 'number' && base > 0 ? base * (r >= 2 ? boost : 1) : 0;
    w[r] = x;
    total += x;
  }
  const u0 = rnd();
  if (!(total > 0)) return f as Rarity;
  let u = u0 * total;
  for (let r = f; r < 5; r++) {
    u -= w[r];
    if (u < 0 && w[r] > 0) return r as Rarity;
  }
  for (let r = 4; r >= f; r--) if (w[r] > 0) return r as Rarity; // float fall-through
  return f as Rarity;
}

/** MODE_SET_SHARE → the game type's exclusive set, else Salvage ('common'). Consumes exactly one `rnd()`. */
export function rollSet(gameType: GameType, rnd: () => number): LootSet {
  const u = rnd();
  return u < MODE_SET_SHARE ? SET_FOR_TYPE[gameType] : 'common';
}

const pickIn = <T>(arr: readonly T[], rnd: () => number): T => arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))];

/**
 * Identity roll (§6.6): pool = lootPool(set, rarity), stepping down a rarity while empty; pick uniformly; if owned,
 * reroll OWNED_REROLLS time(s). The caller decides "still owned → duplicate". null only if the catalog is broken.
 */
export function rollIdentity(owns: (id: CosmeticId) => boolean, set: LootSet, rarity: Rarity, rnd: () => number): CosmeticDef | null {
  for (const s of set === 'common' ? ['common' as const] : [set, 'common' as const]) {
    let r = rarity as number;
    let pool = lootPool(s, r as Rarity);
    while (!pool.length && r > 0) pool = lootPool(s, --r as Rarity);
    if (!pool.length) continue;
    let def = pickIn(pool, rnd);
    for (let k = 0; k < OWNED_REROLLS && owns(def.id); k++) def = pickIn(pool, rnd);
    return def;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------

function cleanToken(t: unknown): CacheToken | null {
  if (typeof t !== 'object' || t === null) return null;
  const o = t as Record<string, unknown>;
  const set = (LOOT_SETS as readonly unknown[]).includes(o.set) ? (o.set as LootSet) : null;
  if (!set) return null;
  return { rarity: asRarity(o.rarity), set, source: (typeof o.source === 'string' ? o.source : 'elite') as LootSource };
}

/** Pity bookkeeping for one crate reveal (shared by rollGrant and applyGrant so both always agree). */
function stepPity(epic: number, legendary: number, revealed: Rarity): [number, number] {
  return [
    revealed >= 3 ? 0 : Math.min(PITY_EPIC - 1, epic + 1),
    revealed >= 4 ? 0 : Math.min(PITY_LEGENDARY - 1, legendary + 1),
  ];
}

/**
 * Deterministic for a given rnd stream. Applies items sequentially (no double-new within one grant).
 * Order: every token (cache) first, in the given order, then each debrief crate:
 *   - pityLegendary + 1 ≥ PITY_LEGENDARY → forced legendary from the mode set (from 'pity');
 *   - else pity[gameType] + 1 ≥ PITY_EPIC → forced epic from the mode set (from 'pity');
 *   - else rarity from CRATE_RARITY_W and set from MODE_SET_SHARE (from 'crate').
 * Pity counts crates only (caches never move or reset it). The profile is `applyGrant(p, grant, now, won)`.
 */
export function rollGrant(p: Profile, input: GrantInput, rnd: () => number, now: number): { grant: LootGrant; profile: Profile } {
  const gameType: GameType = isGameType(input?.gameType) ? input.gameType : 'arena';
  const modeSet = SET_FOR_TYPE[gameType];
  const owned = new Set(Object.keys(p.owned ?? {}));
  const items: GrantItem[] = [];
  let dupeShards = 0;

  const reveal = (set: LootSet, rarity: Rarity, from: GrantItem['from'], source?: LootSource): GrantItem | null => {
    const def = rollIdentity((id) => owned.has(id), set, rarity, rnd);
    if (!def) return null;
    const dupe = owned.has(def.id);
    const shards = dupe ? SALVAGE_VALUE[def.rarity] ?? 0 : 0;
    if (dupe) dupeShards += shards; else owned.add(def.id);
    const it: GrantItem = { itemId: def.id, rarity: def.rarity, from, dupe, shards };
    if (source) it.source = source;
    items.push(it);
    return it;
  };

  const tokens = (Array.isArray(input?.tokens) ? input.tokens : []).slice(0, MAX_GRANT_TOKENS);
  let secured = 0;
  for (const raw of tokens) {
    const t = cleanToken(raw);
    if (!t) continue;
    secured++;
    reveal(t.set, t.rarity, 'cache', t.source);
  }

  let pe = nat(p.pity?.[gameType], PITY_EPIC - 1);
  let pl = nat(p.pityLegendary, PITY_LEGENDARY - 1);
  const crates = nat(input?.crateRolls, MAX_GRANT_CRATES);
  for (let i = 0; i < crates; i++) {
    let it: GrantItem | null;
    if (pl + 1 >= PITY_LEGENDARY) it = reveal(modeSet, 4, 'pity');
    else if (pe + 1 >= PITY_EPIC) it = reveal(modeSet, 3, 'pity');
    else {
      const rarity = rollRarity(CRATE_RARITY_W, 0, rnd);
      it = reveal(rollSet(gameType, rnd), rarity, 'crate');
    }
    if (it) [pe, pl] = stepPity(pe, pl, it.rarity);
  }

  const base = nat(input?.shards, SHARDS_MAX);
  const grant: LootGrant = {
    grantKey: typeof input?.grantKey === 'string' ? input.grantKey : '',
    gameType,
    items,
    shards: Math.min(SHARDS_MAX, base + dupeShards),
    cachesSecured: secured,
    cachesLost: nat(input?.cachesLost),
    epicIn: PITY_EPIC - pe,
    legendaryIn: PITY_LEGENDARY - pl,
  };
  return { grant, profile: applyGrant(p, grant, now, !!input?.won) };
}

/**
 * Apply an already-rolled grant (guests: device profile; also the retry path server-side).
 * - A non-dupe item already owned here (guests roll against an empty profile) converts to SALVAGE_VALUE shards.
 * - Unknown / starter item ids are ignored (still counted for pity if they came from a crate).
 * - Pity is recomputed from the crate / pity items in order (same rule as rollGrant).
 * - `won` (optional, LootGrant has no win flag) bumps stats.wins; rollGrant passes it.
 * Never mutates `p`. applyGrant(p, rollGrant(p, …).grant, now, won) deep-equals rollGrant(p, …).profile.
 */
export function applyGrant(p: Profile, grant: LootGrant, now: number, won = false): Profile {
  const gameType: GameType = isGameType(grant?.gameType) ? grant.gameType : 'arena';
  const owned: Profile['owned'] = { ...(p.owned ?? {}) };
  let shards = nat(p.shards, SHARDS_MAX) + nat(grant?.shards, SHARDS_MAX);
  const newIds: CosmeticId[] = [];
  let pe = nat(p.pity?.[gameType], PITY_EPIC - 1);
  let pl = nat(p.pityLegendary, PITY_LEGENDARY - 1);

  for (const it of Array.isArray(grant?.items) ? grant.items : []) {
    if (typeof it !== 'object' || it === null) continue;
    const def = cosmeticDef(it.itemId);
    if (def && def.set !== 'starter' && !it.dupe) {
      if (hasOwn(owned, def.id)) shards += SALVAGE_VALUE[def.rarity] ?? 0; // device duplicate
      else { owned[def.id] = { at: now, src: gameType }; newIds.push(def.id); }
    }
    if (it.from === 'crate' || it.from === 'pity') [pe, pl] = stepPity(pe, pl, def ? def.rarity : asRarity(it.rarity));
  }

  const newSet = new Set(newIds);
  const fresh = [...newIds.slice().reverse(), ...(p.fresh ?? []).filter((id) => !newSet.has(id))].slice(0, FRESH_MAX);
  const pity: Profile['pity'] = { ...(p.pity ?? {}) };
  if (pe > 0) pity[gameType] = pe; else delete pity[gameType];

  const st = p.stats ?? { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} };
  const bt = st.byType?.[gameType] ?? { matches: 0, wins: 0 };
  const stats: Profile['stats'] = {
    matches: st.matches + 1,
    wins: st.wins + (won ? 1 : 0),
    cachesSecured: st.cachesSecured + nat(grant?.cachesSecured),
    cachesLost: st.cachesLost + nat(grant?.cachesLost),
    byType: { ...(st.byType ?? {}), [gameType]: { matches: bt.matches + 1, wins: bt.wins + (won ? 1 : 0) } },
  };

  const gShards = nat(grant?.shards, SHARDS_MAX);
  const recent = newIds.length || gShards
    ? [{ at: now, gameType, itemIds: newIds, shards: gShards }, ...(p.recent ?? [])].slice(0, RECENT_MAX)
    : (p.recent ?? []).slice(0, RECENT_MAX);

  return {
    ...p,
    owned,
    shards: Math.min(SHARDS_MAX, shards),
    fresh,
    pity,
    pityLegendary: pl,
    stats,
    recent,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------------------------
// Economy helpers for the Room (numbers from data/loot.ts, §6.6)
// ---------------------------------------------------------------------------------------------

export interface CrateContext {
  gameType: GameType;
  /** Seconds this human played in the match (from matchJoinTick). */
  playedSec: number;
  /** Seconds the match lasted. */
  matchSec: number;
  /** Arena / Warzone: team win, or top 3 in FFA. */
  won: boolean;
  /** Dungeon only. */
  floorsCleared?: number;
  /** Dungeon only: outcome 'cleared'. */
  fullClear?: boolean;
}

/** ≥ CRATE_MIN_PLAYED_SEC played in a match of ≥ CRATE_MIN_MATCH_SEC; dungeon: or ≥ 1 floor cleared. */
export function crateEligible(c: CrateContext): boolean {
  if (c.gameType === 'dungeon' && nat(c.floorsCleared) >= 1) return true;
  return c.playedSec >= CRATE_MIN_PLAYED_SEC && c.matchSec >= CRATE_MIN_MATCH_SEC;
}

/** Debrief crates: base 1; Arena/Warzone +1 on a win; dungeon +1 per floor cleared (max +3), +1 full clear. */
export function crateCount(c: CrateContext): number {
  if (!crateEligible(c)) return 0;
  let n = 1;
  if (c.gameType === 'dungeon') {
    n += Math.min(CRATE_FLOOR_BONUS_MAX, nat(c.floorsCleared));
    if (c.fullClear) n += CRATE_FULL_CLEAR_BONUS;
  } else if (c.won) n += CRATE_WIN_BONUS;
  return n;
}

/** Base shards (GrantInput.shards): 5 + 1 per full minute (cap +25) + 10 win + 10 MVP (top scorer, if human). */
export function baseShards(o: { playedSec: number; won: boolean; mvp: boolean }): number {
  const mins = nat(o.playedSec / 60);
  return SHARDS_BASE + Math.min(SHARDS_TIME_CAP, mins * SHARDS_PER_MIN) + (o.won ? SHARDS_WIN : 0) + (o.mvp ? SHARDS_MVP : 0);
}

// ---------------------------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------------------------

/** Share of bot slot picks drawn from the game type's exclusive set (rest: Salvage Line). */
const BOT_MODE_SET_SHARE = 0.65;
const botPools = new Map<string, readonly CosmeticDef[]>();
function botPool(set: LootSet, slot: CosmeticSlot, cls: ShipClassId): readonly CosmeticDef[] {
  const k = `${set}|${slot}|${cls}`;
  let p = botPools.get(k);
  if (!p) {
    p = COSMETIC_LIST.filter((d) => d.set === set && !d.retired && d.rarity <= BOT_MAX_RARITY && fitsSlot(d, slot, cls));
    botPools.set(k, p);
  }
  return p;
}

/**
 * Seeded bot look from the mode set + Salvage (≤ BOT_MAX_RARITY). Same (seed, gameType, shipClass) → same look.
 * Each slot consumes exactly 3 draws, so slot results are independent of which other slots hit.
 */
export function botWardrobe(seed: number, gameType: GameType, shipClass: ShipClassId): CosmeticLoadout {
  const out: CosmeticLoadout = {};
  const t = isGameType(gameType) ? gameType : 'arena';
  const cls = (SHIP_CLASS_IDS as readonly string[]).includes(shipClass) ? shipClass : SHIP_CLASS_IDS[0];
  const rng = new Rng(hash32(seed | 0, GAME_TYPE_IDS.indexOf(t), SHIP_CLASS_IDS.indexOf(cls), 0x0b07));
  const modeSet = SET_FOR_TYPE[t];
  for (const slot of COSMETIC_SLOTS) {
    const hit = rng.next(), setRoll = rng.next(), itemRoll = rng.next();
    if (hit >= (BOT_SLOT_CHANCE[slot] ?? 0)) continue;
    const first: LootSet = setRoll < BOT_MODE_SET_SHARE ? modeSet : 'common';
    let pool = botPool(first, slot, cls);
    if (!pool.length) pool = botPool(first === 'common' ? modeSet : 'common', slot, cls);
    if (!pool.length) continue;
    out[slot] = pool[Math.min(pool.length - 1, Math.floor(itemRoll * pool.length))].id;
  }
  return out;
}
