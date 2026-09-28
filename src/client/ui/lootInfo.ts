// Pure (DOM-free) presentation logic for v0.3 cosmetic loot: Command draws counts, the Hangar grid and drawer,
// the HUD unsecured tray and loot banners, the kill-feed icon, the Tab carried column and the results Debrief.
// docs/v0.3-proposal.md §2.3–§2.5 and §6. data/cosmetics.ts + data/loot.ts are canon for ids and numbers.
import {
  CLASS_SLOTS, COSMETIC_LIST, COSMETICS, fitsSlot, isStarter, starterId, TITLE_FRAMES, type CosmeticDef,
} from '../../shared/data/cosmetics';
import { GAME_TYPES, isGameType } from '../../shared/data/gameTypes';
import { PITY_EPIC, PITY_LEGENDARY, RARITY_NAMES, SALVAGE_VALUE, SET_INFO, SHARDS_MAX } from '../../shared/data/loot';
import type { GrantItem, LootGrant, MatchResult, Profile } from '../../shared/protocol';
import { resolveLoadout } from '../../shared/profile/profile';
import {
  LOOT_SETS,
  type CarryView, type CosmeticId, type CosmeticLoadout, type CosmeticSlot, type EntityId, type GameEvent, type GameType,
  type LootSet, type LootView, type PlayerId, type Rarity, type ShipClassId, type ShipView, type YouState,
} from '../../shared/types';

// ------------------------------------------------------------------ names

export const SLOT_LABELS: Readonly<Record<CosmeticSlot, string>> = {
  hull: 'Hull', weapon: 'Weapon', turret: 'Turret', engine: 'Engine', death: 'Death FX', title: 'Title', killicon: 'Kill icon',
};
/** Hangar slot-row order: the class slots first (they follow the selected class), then the shared ones. */
export const HANGAR_SLOTS: readonly CosmeticSlot[] = ['hull', 'weapon', 'turret', 'engine', 'death', 'title', 'killicon'];
export const SET_SHORT: Readonly<Record<LootSet, string>> = { common: 'Salvage', rift: 'Rift', gladiator: 'Gladiator', swarm: 'Swarm' };

export function rarityName(r: number): string {
  return RARITY_NAMES[r] ?? RARITY_NAMES[0];
}

export function clampRarity(r: unknown): Rarity {
  const n = typeof r === 'number' && Number.isFinite(r) ? Math.round(r) : 0;
  return Math.max(0, Math.min(4, n)) as Rarity;
}

export function isLootSet(v: unknown): v is LootSet {
  return typeof v === 'string' && (LOOT_SETS as readonly string[]).includes(v);
}

export function setDisplayName(set: LootSet | 'starter'): string {
  return set === 'starter' ? 'Starter' : SET_INFO[set]?.name ?? String(set);
}

/** "Rare Swarm Cache". */
export function cacheLabel(rarity: Rarity, set: LootSet): string {
  return `${rarityName(rarity)} ${SET_INFO[set]?.cacheName ?? 'Cache'}`;
}

export function itemName(id: CosmeticId): string {
  return COSMETICS[id]?.name ?? id;
}

/** A title item's framed text ('' for none / not a title). */
export function framedTitle(def: CosmeticDef | undefined): string {
  if (!def || def.slot !== 'title' || !def.p.text) return '';
  const [l, r] = TITLE_FRAMES[def.p.frame] ?? ['', ''];
  return `${l}${def.p.text}${r}`;
}

// ------------------------------------------------------------------ profile reads (defensive: server JSON)

const isClassSlot = (slot: CosmeticSlot): boolean => (CLASS_SLOTS as readonly string[]).includes(slot);

export function ownsItem(p: Profile | null | undefined, id: CosmeticId): boolean {
  if (isStarter(id)) return true;
  const owned = p?.owned;
  return !!owned && typeof owned === 'object' && Object.prototype.hasOwnProperty.call(owned, id) && !!COSMETICS[id];
}

/**
 * An online guest's grant as the device will apply it. The server rolled it against an empty profile, so an item
 * the device profile already owns is really a duplicate (applyGrant turns it into SALVAGE_VALUE shards): mark those
 * rows DUPLICATE (+shards) so the Debrief shows what is actually applied. Returns `grant` itself when nothing changes.
 */
export function asDeviceGrant(grant: LootGrant, p: Profile | null | undefined): LootGrant {
  if (!p || !grant || !Array.isArray(grant.items)) return grant;
  let extra = 0;
  const items = grant.items.map((it) => {
    if (!it || typeof it !== 'object' || it.dupe || typeof it.itemId !== 'string' || isStarter(it.itemId) || !ownsItem(p, it.itemId)) return it;
    const shards = SALVAGE_VALUE[COSMETICS[it.itemId]?.rarity ?? it.rarity] ?? 0;
    extra += shards;
    return { ...it, dupe: true, shards };
  });
  if (items.every((it, i) => it === grant.items[i])) return grant;
  const base = typeof grant.shards === 'number' && Number.isFinite(grant.shards) ? Math.max(0, Math.floor(grant.shards)) : 0;
  return { ...grant, items, shards: Math.min(SHARDS_MAX, base + extra) };
}

/** Catalog size of each set (Salvage / Rift / Gladiator / Swarm: 13 each). */
export function setTotal(set: LootSet): number {
  let n = 0;
  for (const d of COSMETIC_LIST) if (d.set === set) n++;
  return n;
}

/** "Collected x/13" for one set. */
export function collection(p: Profile | null | undefined, set: LootSet): { have: number; total: number } {
  let have = 0, total = 0;
  for (const d of COSMETIC_LIST) {
    if (d.set !== set) continue;
    total++;
    if (ownsItem(p, d.id)) have++;
  }
  return { have, total };
}

/** Crates until the epic pity guarantee in this game type (the n-th crate is forced epic). */
export function epicWithin(p: Profile | null | undefined, t: GameType): number {
  const raw = p?.pity?.[t];
  const pity = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return Math.max(1, PITY_EPIC - pity);
}

export function legendaryWithin(p: Profile | null | undefined): number {
  const raw = p?.pityLegendary;
  const pity = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return Math.max(1, PITY_LEGENDARY - pity);
}

/**
 * The Command card line under the draws strip, once a profile is loaded. `withPity` false for online guests: the
 * server rolls their crates against an empty profile, so the device's pity counters are never honoured.
 */
export function drawsProgressLine(p: Profile | null | undefined, t: GameType, withPity = true): string {
  if (!p) return '';
  const set = GAME_TYPES[t].lootSet;
  const c = collection(p, set);
  if (!withPity) return `Collected ${c.have}/${c.total}`;
  const n = epicWithin(p, t);
  return `Collected ${c.have}/${c.total} · Epic within ${n} ${n === 1 ? 'crate' : 'crates'}`;
}

/** NEW-badge ids that are real, owned catalog items. */
export function freshIds(p: Profile | null | undefined): CosmeticId[] {
  const fresh = Array.isArray(p?.fresh) ? p!.fresh : [];
  return fresh.filter((id) => typeof id === 'string' && !!COSMETICS[id] && ownsItem(p, id));
}

export function shardsOf(p: Profile | null | undefined): number {
  const s = p?.shards;
  return typeof s === 'number' && Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0;
}

/** Hangar button: "Hangar ◆120 •2 NEW" (just "Hangar" before a profile arrives). */
export function hangarButtonText(p: Profile | null | undefined): string {
  if (!p) return 'Hangar';
  const n = freshIds(p).length;
  return `Hangar ◆${shardsOf(p)}${n > 0 ? ` •${n} NEW` : ''}`;
}

function validFor(p: Profile | null | undefined, id: unknown, slot: CosmeticSlot, cls: ShipClassId): id is CosmeticId {
  if (typeof id !== 'string' || !id) return false;
  const def = COSMETICS[id];
  return !!def && fitsSlot(def, slot, cls) && ownsItem(p, id);
}

/** The item a slot shows for a ship of `cls` (the starter when unset, unknown, wrong slot or not owned). */
export function equippedId(p: Profile | null | undefined, slot: CosmeticSlot, cls: ShipClassId): CosmeticId {
  const sel = isClassSlot(slot)
    ? (p?.loadout?.byClass?.[cls] as Record<string, unknown> | undefined)?.[slot]
    : (p?.loadout?.shared as Record<string, unknown> | undefined)?.[slot];
  return validFor(p, sel, slot, cls) ? sel : starterId(slot, cls);
}

/** The look of a ship of `cls` from a profile (starters omitted), with the same rules as resolveLoadout. */
export function localLook(p: Profile | null | undefined, cls: ShipClassId): CosmeticLoadout {
  const out: CosmeticLoadout = {};
  for (const slot of HANGAR_SLOTS) {
    const id = equippedId(p, slot, cls);
    if (!isStarter(id)) out[slot] = id;
  }
  return out;
}

/** profile.resolveLoadout (LOOT, canon) when it works, else the local mirror. Never throws. */
export function lookFor(p: Profile, cls: ShipClassId): CosmeticLoadout {
  try {
    const look = resolveLoadout(p, cls);
    if (look && typeof look === 'object') return look;
  } catch { /* LOOT not landed / bad data: fall through */ }
  return localLook(p, cls);
}

export function sameLook(a: CosmeticLoadout | undefined, b: CosmeticLoadout | undefined): boolean {
  for (const slot of HANGAR_SLOTS) if ((a?.[slot] ?? '') !== (b?.[slot] ?? '')) return false;
  return true;
}

// ------------------------------------------------------------------ Hangar grid

export type HangarFilter = 'all' | 'owned' | LootSet;
export const HANGAR_FILTERS: readonly HangarFilter[] = ['all', 'owned', 'common', 'rift', 'gladiator', 'swarm'];

export function filterLabel(f: HangarFilter): string {
  return f === 'all' ? 'All' : f === 'owned' ? 'Owned' : SET_SHORT[f];
}

const SET_ORDER: Record<LootSet | 'starter', number> = { starter: 0, common: 1, rift: 2, gladiator: 3, swarm: 4 };

/** Items for one slot on one class: the starter first, then by set, rarity and name. Retired items only if owned. */
export function hangarItems(slot: CosmeticSlot, cls: ShipClassId, filter: HangarFilter, p: Profile | null | undefined): CosmeticDef[] {
  return COSMETIC_LIST
    .filter((d) => fitsSlot(d, slot, cls))
    .filter((d) => !d.retired || ownsItem(p, d.id))
    .filter((d) => {
      if (filter === 'all') return true;
      if (filter === 'owned') return ownsItem(p, d.id);
      return d.set === filter;
    })
    .sort((a, b) => SET_ORDER[a.set] - SET_ORDER[b.set] || a.rarity - b.rarity || a.name.localeCompare(b.name));
}

export interface TileState { equipped: boolean; owned: boolean; locked: boolean; fresh: boolean }

export function tileState(p: Profile | null | undefined, def: CosmeticDef, slot: CosmeticSlot, cls: ShipClassId): TileState {
  const owned = ownsItem(p, def.id);
  return {
    equipped: equippedId(p, slot, cls) === def.id,
    owned,
    locked: !owned,
    fresh: owned && Array.isArray(p?.fresh) && p!.fresh.includes(def.id),
  };
}

/** Locked-tile caption: "Drops in: Dungeon Runner" / "Drops in: any mode". */
export function dropsInText(def: CosmeticDef): string {
  if (def.set === 'starter') return 'Starter';
  const mode = SET_INFO[def.set]?.mode;
  return `Drops in: ${mode ? GAME_TYPES[mode].name : 'any mode'}`;
}

/** Detail drawer lines: where it drops, and the pity guarantee that can force it. */
export function dropSourceLines(def: CosmeticDef): string[] {
  if (def.set === 'starter') return ['Starter: every pilot owns it. It never drops.'];
  const mode = SET_INFO[def.set]?.mode;
  const where = mode
    ? `${GAME_TYPES[mode].name} only: in-world caches and debrief crates.`
    : 'Every game type: in-world caches and debrief crates.';
  const out = [where];
  if (def.rarity === 3) {
    out.push(mode
      ? `Epic pity: the ${PITY_EPIC}th ${GAME_TYPES[mode].name} crate without an epic is a ${SET_INFO[def.set].name} epic.`
      : 'Epic: rolls from any crate or cache.');
  } else if (def.rarity === 4) {
    out.push(mode
      ? `Legendary pity: every ${PITY_LEGENDARY}th crate is a legendary from the mode you are playing.`
      : 'Legendary: the rarest roll, mostly from world caches.');
  }
  if (def.retired) out.push('Retired: it no longer drops.');
  return out;
}

// ------------------------------------------------------------------ in-match

/** Per-mode tray hint: caches are banked at extraction in a rift, at match end elsewhere. */
export function trayHint(t: GameType | undefined): string {
  return t === 'dungeon' ? 'Extract to bank' : 'Survive to the end';
}

export interface TrayModel {
  n: number;
  cap: number;
  full: boolean;
  /** Rarity of each carried cache, highest first. */
  pips: Rarity[];
  hint: string;
  /** Best rarity carried. */
  best: Rarity;
}

/** The HUD unsecured tray, or null when you carry nothing. */
export function trayModel(you: Pick<YouState, 'carried' | 'carryCap'> | null | undefined, t: GameType | undefined): TrayModel | null {
  const carried = Array.isArray(you?.carried) ? you!.carried : [];
  if (!carried.length) return null;
  const pips = carried.map((c) => clampRarity(c?.rarity)).sort((a, b) => b - a);
  const cap = typeof you?.carryCap === 'number' && you.carryCap > 0 ? you.carryCap : 0;
  return { n: pips.length, cap, full: cap > 0 && pips.length >= cap, pips, hint: trayHint(t), best: pips[0] ?? 0 };
}

/** The killer's kill icon glyph for the kill feed (the starter ✦ by default). */
export function killiconGlyph(look: CosmeticLoadout | undefined): string {
  const id = look?.killicon;
  const def = id ? COSMETICS[id] : undefined;
  return def && def.slot === 'killicon' && def.p.glyph ? def.p.glyph : '✦';
}

export interface LootBanner { text: string; rarity: Rarity; priority: number; ms: number }

/** A banner for a loot event that concerns the local player (null = none). */
export function lootBannerFor(ev: GameEvent, me: PlayerId): LootBanner | null {
  switch (ev.t) {
    case 'lootPickup': {
      if (ev.playerId !== me) return null;
      const r = clampRarity(ev.rarity);
      const set = isLootSet(ev.set) ? ev.set : 'common';
      return { text: `+ ${cacheLabel(r, set).toUpperCase()}`, rarity: r, priority: r >= 3 ? 2 : 1, ms: r >= 3 ? 2200 : 1400 };
    }
    case 'lootSpill': {
      if (ev.playerId !== me || !(ev.count > 0)) return null;
      return { text: `${ev.count} ${ev.count === 1 ? 'CACHE' : 'CACHES'} SPILLED`, rarity: clampRarity(ev.best), priority: 2, ms: 2400 };
    }
    case 'lootSecured': {
      if (ev.playerId !== me) return null;
      const n = Array.isArray(ev.tokens) ? ev.tokens.length : 0;
      if (!n) return null;
      const best = clampRarity(ev.tokens.reduce<number>((m, t) => Math.max(m, clampRarity(t?.rarity)), 0));
      return { text: `${n} ${n === 1 ? 'CACHE' : 'CACHES'} SECURED`, rarity: best, priority: 2, ms: 2600 };
    }
    case 'lootDrop': {
      const r = clampRarity(ev.rarity);
      if (r < 3) return null;
      return { text: `${rarityName(r).toUpperCase()} CACHE DROPPED`, rarity: r, priority: 1, ms: 1800 };
    }
    default:
      return null;
  }
}

/** A cache you could take right now lies within `reach` of (x, y) (used for the HOLD FULL toast). */
export function cacheInReach(loot: readonly LootView[] | undefined, x: number, y: number, reach: number, me: PlayerId): boolean {
  if (!loot) return false;
  const r2 = reach * reach;
  for (const l of loot) {
    if (l.reservedFor && l.reservedFor !== me) continue;
    const dx = l.x - x, dy = l.y - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/** Tab scoreboard carried column: playerId → caches carried (and the best rarity). */
export function carriedByPlayer(ships: readonly Pick<ShipView, 'id' | 'playerId'>[] | undefined, carry: readonly CarryView[] | undefined): Map<PlayerId, { n: number; best: Rarity }> {
  const out = new Map<PlayerId, { n: number; best: Rarity }>();
  if (!ships || !carry?.length) return out;
  const pidOf = new Map<EntityId, PlayerId>();
  for (const s of ships) pidOf.set(s.id, s.playerId);
  for (const c of carry) {
    const pid = pidOf.get(c.shipId);
    if (!pid || !(c.n > 0)) continue;
    out.set(pid, { n: c.n, best: clampRarity(c.best) });
  }
  return out;
}

// ------------------------------------------------------------------ Debrief (results)

/** Milliseconds between two item reveals. */
export const REVEAL_STEP_MS = 350;

/** How many of `total` items are revealed `elapsedMs` after the grant arrived (first one after one step). */
export function revealCount(elapsedMs: number, total: number, stepMs = REVEAL_STEP_MS): number {
  if (!(elapsedMs > 0) || total <= 0) return 0;
  return Math.min(total, Math.floor(elapsedMs / stepMs));
}

export interface DebriefRow {
  itemId: CosmeticId;
  name: string;
  rarity: Rarity;
  rarityName: string;
  /** "Hull · Rift Set" */
  detail: string;
  from: GrantItem['from'];
  fromLabel: string;
  dupe: boolean;
  /** "DUPLICATE → +40 shards", or "NEW". */
  tag: string;
}

const FROM_LABEL: Record<GrantItem['from'], string> = { cache: 'Cache', crate: 'Crate', pity: 'Pity crate' };

export function debriefRows(grant: LootGrant | null | undefined): DebriefRow[] {
  const items = Array.isArray(grant?.items) ? grant!.items : [];
  return items.map((it) => {
    const def = COSMETICS[it.itemId];
    const r = clampRarity(it.rarity);
    const from = it.from === 'crate' || it.from === 'pity' ? it.from : 'cache';
    return {
      itemId: it.itemId,
      name: def?.name ?? it.itemId,
      rarity: r,
      rarityName: rarityName(r),
      detail: def ? `${SLOT_LABELS[def.slot]} · ${setDisplayName(def.set)}` : '',
      from,
      fromLabel: FROM_LABEL[from],
      dupe: !!it.dupe,
      tag: it.dupe ? `DUPLICATE → +${Math.max(0, Math.round(it.shards || 0))} shards` : 'NEW',
    };
  });
}

/** "Epic within 7 crates · Legendary within 41". */
export function pityLine(grant: Pick<LootGrant, 'epicIn' | 'legendaryIn'>): string {
  const e = Math.max(1, Math.round(grant.epicIn || 0) || 1);
  const l = Math.max(1, Math.round(grant.legendaryIn || 0) || 1);
  return `Epic within ${e} ${e === 1 ? 'crate' : 'crates'} · Legendary within ${l}`;
}

/**
 * "Caches secured 3 · spilled 1" (empty when both are 0). LootGrant.cachesLost counts every token that spilled out
 * of the hold (death, leave, team swap), including ones the pilot picked back up, so the Debrief says "spilled".
 */
export function cachesLine(grant: Pick<LootGrant, 'cachesSecured' | 'cachesLost'>): string {
  const s = Math.max(0, grant.cachesSecured | 0), l = Math.max(0, grant.cachesLost | 0);
  if (!s && !l) return '';
  return `Caches secured ${s} · spilled ${l}`;
}

/** Toast text for a grant that arrives outside the results screen (a mid-match leave): "2 items (1 new) · ◆ +15". */
export function grantSummary(grant: LootGrant): string {
  const items = Array.isArray(grant.items) ? grant.items : [];
  const fresh = items.filter((i) => !i.dupe).length;
  const parts: string[] = [];
  if (items.length) parts.push(`${items.length} ${items.length === 1 ? 'item' : 'items'}${fresh ? ` (${fresh} new)` : ''}`);
  if (grant.shards > 0) parts.push(`◆ +${Math.round(grant.shards)}`);
  return parts.length ? `Loot banked: ${parts.join(' · ')}` : '';
}

export interface Highlight { playerId: PlayerId; itemName: string; rarity: Rarity }

/** Other pilots' epic-or-better reveals (MatchResult.lootHighlights), strongest first. */
export function othersHighlights(result: Pick<MatchResult, 'lootHighlights'> | null | undefined, me: PlayerId): Highlight[] {
  const list = Array.isArray(result?.lootHighlights) ? result!.lootHighlights : [];
  return list
    .filter((h) => h && h.playerId !== me && clampRarity(h.rarity) >= 3)
    .map((h) => ({ playerId: h.playerId, itemName: itemName(h.itemId), rarity: clampRarity(h.rarity) }))
    .sort((a, b) => b.rarity - a.rarity)
    .slice(0, 8);
}

/**
 * Did the local pilot "win" the match a grant belongs to (device-profile stats for guests)? The Room's rule:
 * team matches → your team won; FFA → you finished in the top 3. No result (a mid-match leave) → false.
 */
export function wonMatch(result: Pick<MatchResult, 'winnerTeam' | 'scores'> | null | undefined, me: PlayerId, myTeam: number | undefined, ffa: boolean): boolean {
  if (!result) return false;
  if (!ffa) return result.winnerTeam >= 0 && myTeam === result.winnerTeam;
  const top3 = [...(Array.isArray(result.scores) ? result.scores : [])].sort((a, b) => b.score - a.score).slice(0, 3);
  return top3.some((s) => s.playerId === me);
}

/** Is this a valid gameType for loot purposes (the lootGrant field comes off the wire). */
export function grantGameType(grant: Pick<LootGrant, 'gameType'>): GameType {
  return isGameType(grant.gameType) ? grant.gameType : 'warzone';
}
