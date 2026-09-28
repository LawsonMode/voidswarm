// OWNER: LOOT agent. Pure profile operations (docs/v0.3-proposal.md §7.1). Signatures frozen by §8.8.
//
// Rules shared by every op here:
// - Pure: inputs are never mutated; a changed profile is a fresh object (unchanged parts may be shared).
// - An op that changes nothing returns the SAME profile reference, so callers can skip a store write.
// - Starters are implicit: never stored in `owned`, and never stored in `loadout` (absent = starter).
// - Every id lookup is own-property only (`hasOwn`), so ids like 'constructor' / '__proto__' never resolve.
import type { ClassSlot, CosmeticId, CosmeticLoadout, CosmeticSlot, GameType, ShipClassId, SharedSlot } from '../types';
import { PROFILE_VERSION, type LoadoutSel, type OwnedItem, type Profile } from '../protocol';
import { CLASS_SLOTS, COSMETICS, COSMETIC_SLOTS, SHARED_SLOTS, fitsSlot, starterId, type CosmeticDef } from '../data/cosmetics';
import { GAME_TYPE_IDS } from '../data/gameTypes';
import { SHIP_CLASS_IDS } from '../data/ships';
import { FRESH_MAX, PITY_EPIC, PITY_LEGENDARY, RECENT_MAX, SHARDS_MAX } from '../data/loot';

export type OpResult = { ok: true; profile: Profile } | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// Small shared helpers (also used by rolls.ts / service.ts)
// ---------------------------------------------------------------------------------------------

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Catalog entry for `id` (own properties only), or undefined. */
export function cosmeticDef(id: unknown): CosmeticDef | undefined {
  return typeof id === 'string' && hasOwn(COSMETICS, id) ? COSMETICS[id] : undefined;
}

/**
 * Well-formed cosmetic id (catalog ids and any future append-only ids): starts alphanumeric, then
 * [A-Za-z0-9_.-], at most MAX_ID_LEN chars. Rejects '__proto__' and other junk keys.
 */
export const MAX_ID_LEN = 40;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function isCosmeticIdLike(v: unknown): v is CosmeticId {
  return typeof v === 'string' && v.length <= MAX_ID_LEN && ID_RE.test(v) && v !== 'constructor' && v !== 'prototype';
}

/** Owned (explicitly, or implicitly as a starter). Unknown ids are never "owned" for equip purposes. */
export function ownsItem(p: Profile, id: CosmeticId): boolean {
  const def = cosmeticDef(id);
  if (!def) return false;
  if (def.set === 'starter') return true;
  return !!p.owned && hasOwn(p.owned, id);
}

const isShipClass = (v: unknown): v is ShipClassId => typeof v === 'string' && (SHIP_CLASS_IDS as readonly string[]).includes(v);
const isSlot = (v: unknown): v is CosmeticSlot => typeof v === 'string' && (COSMETIC_SLOTS as readonly string[]).includes(v);
const isClassSlot = (s: CosmeticSlot): s is ClassSlot => (CLASS_SLOTS as readonly string[]).includes(s);
const isGameTypeId = (v: unknown): v is GameType => typeof v === 'string' && (GAME_TYPE_IDS as readonly string[]).includes(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Non-negative integer, clamped to [0, max]; anything else → fallback. */
function nat(v: unknown, max = Number.MAX_SAFE_INTEGER, fallback = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(v)));
}
const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ---------------------------------------------------------------------------------------------
// defaultProfile / normalizeProfile
// ---------------------------------------------------------------------------------------------

/** A fresh PROFILE_VERSION profile (starters are implicit, never stored). */
export function defaultProfile(now: number): Profile {
  return {
    v: PROFILE_VERSION,
    owned: {},
    shards: 0,
    loadout: { shared: {}, byClass: {} },
    fresh: [],
    pity: {},
    pityLegendary: 0,
    stats: { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} },
    recent: [],
    updatedAt: finiteOr(now, 0),
  };
}

/** Owned entries beyond this are dropped (the v0.3 catalog has 52 lootable items; ids are append-only). */
const OWNED_MAX = 1024;
const OWNED_SRC: readonly string[] = [...GAME_TYPE_IDS, 'craft'];

/** A loadout entry survives only if it is a known item, fits the slot (+ class / kit), and is owned (non-starter). */
function loadoutEntryOk(p: Profile, slot: CosmeticSlot, id: unknown, shipClass: ShipClassId | null): id is CosmeticId {
  const def = cosmeticDef(id);
  if (!def || def.set === 'starter') return false;
  if (shipClass) { if (!fitsSlot(def, slot, shipClass)) return false; }
  else if (def.slot !== slot) return false;
  return hasOwn(p.owned, def.id);
}

/**
 * Never throws. Non-objects → defaultProfile. Malformed entries are dropped, shards clamped to [0, SHARDS_MAX],
 * bad loadout entries fall back to the starter (absent). Unknown owned ids are preserved (but never equippable).
 * writable = false when raw.v > PROFILE_VERSION (read-only for the session: an older server never clobbers it).
 * Deliberately not loadJSON's shallow merge: every field is rebuilt from scratch.
 */
export function normalizeProfile(raw: unknown, now: number): { profile: Profile; writable: boolean } {
  try {
    return normalizeUnsafe(raw, now);
  } catch {
    // Defensive only (e.g. a hostile getter / Proxy): the rebuild below never throws on JSON data.
    return { profile: defaultProfile(now), writable: true };
  }
}

function normalizeUnsafe(raw: unknown, now: number): { profile: Profile; writable: boolean } {
  if (!isObj(raw)) return { profile: defaultProfile(now), writable: true };
  const writable = !(typeof raw.v === 'number' && raw.v > PROFILE_VERSION);
  const p = defaultProfile(now);

  // owned
  if (isObj(raw.owned)) {
    let n = 0;
    for (const [id, e] of Object.entries(raw.owned)) {
      if (n >= OWNED_MAX) break;
      if (!isCosmeticIdLike(id) || !isObj(e)) continue;
      if (cosmeticDef(id)?.set === 'starter') continue; // implicit
      if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0) continue;
      if (typeof e.src !== 'string' || !OWNED_SRC.includes(e.src)) continue;
      p.owned[id] = { at: e.at, src: e.src as OwnedItem['src'] };
      n++;
    }
  }

  p.shards = nat(raw.shards, SHARDS_MAX);

  // loadout (validated against the owned set built above)
  const lo = isObj(raw.loadout) ? raw.loadout : {};
  if (isObj(lo.shared)) {
    for (const slot of SHARED_SLOTS) {
      const id = lo.shared[slot];
      if (loadoutEntryOk(p, slot, id, null)) p.loadout.shared[slot] = id;
    }
  }
  if (isObj(lo.byClass)) {
    for (const cls of SHIP_CLASS_IDS) {
      const row = lo.byClass[cls];
      if (!isObj(row)) continue;
      const out: Partial<Record<ClassSlot, CosmeticId>> = {};
      let any = false;
      for (const slot of CLASS_SLOTS) {
        const id = row[slot];
        if (loadoutEntryOk(p, slot, id, cls)) { out[slot] = id; any = true; }
      }
      if (any) p.loadout.byClass[cls] = out;
    }
  }

  // fresh: owned ids only, deduped, ≤ FRESH_MAX (newest first, as stored)
  if (Array.isArray(raw.fresh)) {
    const seen = new Set<string>();
    for (const id of raw.fresh) {
      if (p.fresh.length >= FRESH_MAX) break;
      if (!isCosmeticIdLike(id) || seen.has(id) || !hasOwn(p.owned, id)) continue;
      seen.add(id);
      p.fresh.push(id);
    }
  }

  // pity counters (a counter at the threshold would already have forced its reveal)
  if (isObj(raw.pity)) {
    for (const t of GAME_TYPE_IDS) {
      const c = nat(raw.pity[t], PITY_EPIC - 1);
      if (c > 0) p.pity[t] = c;
    }
  }
  p.pityLegendary = nat(raw.pityLegendary, PITY_LEGENDARY - 1);

  // stats
  if (isObj(raw.stats)) {
    const s = raw.stats;
    p.stats.matches = nat(s.matches);
    p.stats.wins = nat(s.wins);
    p.stats.cachesSecured = nat(s.cachesSecured);
    p.stats.cachesLost = nat(s.cachesLost);
    if (isObj(s.byType)) {
      for (const t of GAME_TYPE_IDS) {
        const b = s.byType[t];
        if (!isObj(b)) continue;
        p.stats.byType[t] = { matches: nat(b.matches), wins: nat(b.wins) };
      }
    }
  }

  // recent: newest first, ≤ RECENT_MAX
  if (Array.isArray(raw.recent)) {
    for (const r of raw.recent) {
      if (p.recent.length >= RECENT_MAX) break;
      if (!isObj(r) || typeof r.at !== 'number' || !Number.isFinite(r.at) || !isGameTypeId(r.gameType)) continue;
      const itemIds = Array.isArray(r.itemIds) ? r.itemIds.filter(isCosmeticIdLike).slice(0, 64) : [];
      p.recent.push({ at: r.at, gameType: r.gameType, itemIds, shards: nat(r.shards, SHARDS_MAX) });
    }
  }

  p.updatedAt = finiteOr(raw.updatedAt, finiteOr(now, 0));
  return { profile: p, writable };
}

// ---------------------------------------------------------------------------------------------
// Loadout ops
// ---------------------------------------------------------------------------------------------

/** The look for a ship of `shipClass` (starters omitted). Re-validates, so a stale profile never shows unowned items. */
export function resolveLoadout(p: Profile, shipClass: ShipClassId): CosmeticLoadout {
  const out: CosmeticLoadout = {};
  if (!p || !isShipClass(shipClass)) return out;
  const lo = p.loadout ?? { shared: {}, byClass: {} };
  for (const slot of SHARED_SLOTS) {
    const id = lo.shared?.[slot];
    if (loadoutEntryOk(p, slot, id, shipClass)) out[slot] = id;
  }
  const row = lo.byClass?.[shipClass];
  if (row) {
    for (const slot of CLASS_SLOTS) {
      const id = row[slot];
      if (loadoutEntryOk(p, slot, id, shipClass)) out[slot] = id;
    }
  }
  return out;
}

/**
 * itemId '' = starter. The item must be owned, fit the slot, and match the class / kit.
 * Class slots (hull / weapon / turret) need `shipClass`; shared slots ignore it.
 * Equipping the item already equipped (or the starter when already on the starter) returns the same profile.
 * Does not touch updatedAt (no clock here): the ProfileService stamps it.
 */
export function equip(p: Profile, slot: CosmeticSlot, itemId: CosmeticId, shipClass?: ShipClassId): OpResult {
  if (!isSlot(slot)) return { ok: false, error: 'Unknown slot.' };
  if (typeof itemId !== 'string') return { ok: false, error: 'Unknown item.' };
  const classSlot = isClassSlot(slot);
  if (classSlot && !isShipClass(shipClass)) return { ok: false, error: 'Pick a class for that slot.' };
  const cls = classSlot ? (shipClass as ShipClassId) : null;

  let next: CosmeticId | undefined; // undefined = starter
  if (itemId !== '') {
    const def = cosmeticDef(itemId);
    if (!def) return { ok: false, error: 'Unknown item.' };
    if (cls ? !fitsSlot(def, slot, cls) : def.slot !== slot) return { ok: false, error: "That item doesn't fit this slot." };
    if (def.set !== 'starter') {
      if (!hasOwn(p.owned, def.id)) return { ok: false, error: "You don't own that item yet." };
      next = def.id;
    }
    // A fitting starter (e.g. starterId(slot, cls)) is the same as ''.
  }

  if (slot === 'hull' || slot === 'weapon' || slot === 'turret') {
    const c = cls as ShipClassId;
    const row = p.loadout.byClass[c] ?? {};
    if (row[slot] === next) return { ok: true, profile: p };
    const nextRow: Partial<Record<ClassSlot, CosmeticId>> = { ...row };
    if (next === undefined) delete nextRow[slot]; else nextRow[slot] = next;
    const byClass = { ...p.loadout.byClass };
    if (Object.keys(nextRow).length) byClass[c] = nextRow; else delete byClass[c];
    return { ok: true, profile: { ...p, loadout: { ...p.loadout, byClass } } };
  }
  const s = slot as SharedSlot;
  if (p.loadout.shared[s] === next) return { ok: true, profile: p };
  const shared: LoadoutSel['shared'] = { ...p.loadout.shared };
  if (next === undefined) delete shared[s]; else shared[s] = next;
  return { ok: true, profile: { ...p, loadout: { ...p.loadout, shared } } };
}

/** Clear NEW badges. Returns the same profile when none of `ids` was fresh. */
export function markSeen(p: Profile, ids: readonly CosmeticId[]): Profile {
  if (!Array.isArray(ids) || !ids.length || !p.fresh.length) return p;
  const drop = new Set(ids.filter((x) => typeof x === 'string'));
  const fresh = p.fresh.filter((id) => !drop.has(id));
  return fresh.length === p.fresh.length ? p : { ...p, fresh };
}

/** Starter id for `slot` on `shipClass` when the loadout leaves it empty (convenience for UI / render). */
export function equippedId(p: Profile, slot: CosmeticSlot, shipClass: ShipClassId): CosmeticId {
  return resolveLoadout(p, shipClass)[slot] ?? starterId(slot, shipClass);
}
