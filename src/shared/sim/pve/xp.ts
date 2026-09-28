// OWNER: PVE agent. XP, levels, upgrade offers (path fork / talents / general cards).
import { MAX_HARDPOINTS, PATH_LEVEL, TALENT_LEVELS } from '../../constants';
import { PATHS, SHIP_CLASSES, pathKey } from '../../data/ships';
import type { PathDef, Ship, TalentDef, UpgradeChoice, World } from '../../types';
import { applyHull } from '../hull';
import { dropGems, emit } from '../world';
import { OVERCHARGE, PATH_AFFINITY, UPGRADES, computeStats, resolvePath, type UpgradeDef } from './upgrades';

export const MAX_AUTO_WEAPONS = 4;
/** Weight multiplier for general cards that fit the ship's path. */
const AFFINITY_WEIGHT = 2.2;

/** XP needed to go from `level` to level+1. */
export function xpToNextFor(level: number): number {
  return Math.round(10 + 8 * Math.pow(Math.max(1, level), 1.35));
}

const DEF_LIST: UpgradeDef[] = Object.values(UPGRADES);

function choiceFor(def: UpgradeDef, nextLevel: number): UpgradeChoice {
  return {
    id: def.id, name: def.name, description: def.describe(nextLevel), level: nextLevel,
    maxLevel: def.maxLevel, category: def.category, icon: def.icon,
  };
}

function pathChoice(p: PathDef): UpgradeChoice {
  return { id: pathKey(p.id), name: p.name, description: p.description, level: 1, maxLevel: 1, category: 'path', icon: p.icon };
}

function talentChoice(t: TalentDef): UpgradeChoice {
  return { id: t.id, name: t.name, description: t.description, level: 1, maxLevel: 1, category: 'talent', icon: t.icon };
}

export function autoWeaponCount(ship: Ship): number {
  let n = 0;
  for (const d of DEF_LIST) if (d.category === 'auto' && (ship.upgrades[d.id] ?? 0) > 0) n++;
  return n;
}

/** Keep ship.path in sync with the upgrades record for the ship's current class. */
export function syncPath(ship: Ship): void {
  ship.path = resolvePath(ship.shipClass, ship.upgrades);
}

/** Pick up to `n` distinct items by weight using world.rng (mutates the arrays). */
function weightedPick<T>(world: World, items: T[], weights: number[], n: number): T[] {
  const out: T[] = [];
  while (out.length < n && items.length > 0) {
    let total = 0;
    for (const w of weights) total += w;
    let r = world.rng.next() * total;
    let idx = 0;
    for (; idx < weights.length - 1; idx++) { r -= weights[idx]; if (r < 0) break; }
    out.push(items[idx]);
    items.splice(idx, 1);
    weights.splice(idx, 1);
  }
  return out;
}

function generalOffer(world: World, ship: Ship): UpgradeChoice[] {
  const autos = autoWeaponCount(ship);
  const path = resolvePath(ship.shipClass, ship.upgrades);
  const affinity = path ? PATH_AFFINITY[path] : null;
  const cands: UpgradeDef[] = [];
  const weights: number[] = [];
  for (const d of DEF_LIST) {
    const cur = ship.upgrades[d.id] ?? 0;
    if (cur >= d.maxLevel) continue;
    if (d.classes && !d.classes.includes(ship.shipClass)) continue;
    if (d.id === 'turretmount' && world.config.mode !== 'teams') continue;
    let w = 1;
    if (d.category === 'auto') {
      if (cur === 0) {
        if (autos >= MAX_AUTO_WEAPONS) continue;
        if (autos < 2) w = 3;
      } else w = 1.6;
    } else if (cur > 0) w = 1.25;
    if (affinity && affinity.includes(d.id)) w *= AFFINITY_WEIGHT;
    cands.push(d);
    weights.push(w);
  }
  // v0.5: Turret Mount does nothing at the hardpoint cap (computeStats caps maxTurrets at MAX_HARDPOINTS). It stays a
  // candidate, so the rng draws (and so every later offer, for every ship) are unchanged; a drawn dead card is
  // dropped and the Overcharge filler takes its place.
  const dead = ship.stats.maxTurrets >= MAX_HARDPOINTS;
  const offer = weightedPick(world, cands, weights, 3)
    .filter((d) => !(dead && d.id === 'turretmount'))
    .map((d) => choiceFor(d, (ship.upgrades[d.id] ?? 0) + 1));
  if (offer.length < 3) offer.push(choiceFor(OVERCHARGE, 1));
  return offer;
}

function pathOffer(ship: Ship): UpgradeChoice[] {
  return SHIP_CLASSES[ship.shipClass].paths.map(pathChoice);
}

/** Build the offer for reaching `level` (path fork / talents / general cards). Uses world.rng. */
export function buildOffer(world: World, ship: Ship, level: number = ship.level): UpgradeChoice[] {
  const path = resolvePath(ship.shipClass, ship.upgrades);
  const isTalentLevel = TALENT_LEVELS.includes(level);
  if (level === PATH_LEVEL || isTalentLevel) {
    if (!path) return pathOffer(ship);
    if (isTalentLevel) {
      const untaken = PATHS[path].talents.filter((t) => (ship.upgrades[t.id] ?? 0) === 0);
      if (untaken.length > 0) {
        const weights = untaken.map(() => 1);
        return weightedPick(world, untaken, weights, 3).map(talentChoice);
      }
    }
  }
  return generalOffer(world, ship);
}

/** Level that queued offer `i` was earned at (offers are pushed one per level and popped in order). */
function offerLevel(ship: Ship, i: number): number {
  return ship.level - (ship.offers.length - 1) + i;
}

/**
 * Rebuild every queued offer for the ship's current class/path/upgrades (same levels, fresh cards).
 * Used after a pick and after a class swap (Sim.setShipClass), so no queued offer holds cards built for
 * another class or a stale path state. Does not touch ship.offerSerial.
 */
export function rebuildOffers(world: World, ship: Ship): void {
  for (let i = 0; i < ship.offers.length; i++) ship.offers[i] = buildOffer(world, ship, offerLevel(ship, i));
}

export function grantXp(world: World, ship: Ship, amount: number): void {
  if (!(amount > 0)) return;
  ship.xp += amount * (ship.stats.xpMult || 1);
  if (!(ship.level >= 1)) ship.level = 1;
  if (!(ship.xpToNext > 0)) ship.xpToNext = xpToNextFor(ship.level);
  let guard = 0;
  while (ship.xp >= ship.xpToNext && guard++ < 50) {
    ship.xp -= ship.xpToNext;
    ship.level++;
    ship.xpToNext = xpToNextFor(ship.level);
    ship.offers.push(buildOffer(world, ship, ship.level));
    ship.bounty = 10 + 2 * ship.level + 5 * ship.killStreak;
    emit(world, { t: 'levelUp', playerId: ship.playerId, level: ship.level });
  }
}

/**
 * Recompute ship.stats from its class + upgrades, keeping the energy FRACTION (pve/index recomputeShipStats).
 * v0.5: a capital host / docked turret keeps its hull (the rebuilt stats are the new base; sim/hull.ts).
 */
export function recomputeStats(ship: Ship): void {
  const frac = ship.stats.maxEnergy > 0 ? ship.energy / ship.stats.maxEnergy : 1;
  ship.stats = computeStats(ship.shipClass, ship.upgrades);
  applyHull(ship);
  ship.energy = frac * ship.stats.maxEnergy;
}

/**
 * Apply ship.offers[0][index] and consume that offer (ship.offerSerial += 1). Invalid indices are ignored
 * (nothing consumed). A card that is no longer valid for the ship (another class's path, a second path,
 * a foreign/taken talent, a maxed or class-restricted card) grants nothing, but the level-up is NOT
 * wasted: a fresh offer for the same level takes its place.
 */
export function applyUpgradeChoice(world: World, ship: Ship, index: number): void {
  const offer = ship.offers[0];
  if (!offer || !Number.isInteger(index) || index < 0 || index >= offer.length) return;
  const choice = offer[index];
  ship.offers.shift();
  ship.offerSerial = (Number.isFinite(ship.offerSerial) ? ship.offerSerial : 0) + 1;
  let applied = false;
  if (choice.id === OVERCHARGE.id) {
    ship.energy = ship.stats.maxEnergy;
    ship.score += 5;
    applied = true;
    emit(world, { t: 'upgrade', playerId: ship.playerId, upgradeId: choice.id, level: 1 });
  } else if (choice.category === 'path') {
    const pid = choice.id.startsWith('path:') ? choice.id.slice(5) : '';
    const p = (PATHS as Record<string, PathDef | undefined>)[pid];
    // Only one path per class, ever: a second path pick is ignored.
    if (p && p.classId === ship.shipClass && !resolvePath(ship.shipClass, ship.upgrades)) {
      ship.upgrades[pathKey(p.id)] = 1;
      recomputeStats(ship);
      applied = true;
      emit(world, { t: 'upgrade', playerId: ship.playerId, upgradeId: choice.id, level: 1 });
    }
  } else if (choice.category === 'talent') {
    const path = resolvePath(ship.shipClass, ship.upgrades);
    const ok = path !== null && PATHS[path].talents.some((t) => t.id === choice.id);
    if (ok && (ship.upgrades[choice.id] ?? 0) === 0) {
      ship.upgrades[choice.id] = 1;
      recomputeStats(ship);
      applied = true;
      emit(world, { t: 'upgrade', playerId: ship.playerId, upgradeId: choice.id, level: 1 });
    }
  } else {
    const def = UPGRADES[choice.id];
    const cur = ship.upgrades[choice.id] ?? 0;
    if (def && cur < def.maxLevel && (!def.classes || def.classes.includes(ship.shipClass))) {
      ship.upgrades[choice.id] = cur + 1;
      recomputeStats(ship);
      applied = true;
      emit(world, { t: 'upgrade', playerId: ship.playerId, upgradeId: choice.id, level: cur + 1 });
    }
  }
  syncPath(ship);
  // Stale card: re-offer this level (placeholder; filled by the rebuild below at the same level).
  if (!applied) ship.offers.unshift([]);
  // Queued offers were built before this pick; rebuild them (e.g. a queued talent offer that was a path
  // offer while no path was chosen, or levels/max-outs that changed).
  rebuildOffers(world, ship);
}

export function dropShipXp(world: World, ship: Ship): void {
  const lost = Math.max(0, Math.floor(ship.xp * 0.4));
  ship.xp -= lost;
  dropGems(world, ship.x, ship.y, lost + 5 * Math.max(1, ship.level));
}
