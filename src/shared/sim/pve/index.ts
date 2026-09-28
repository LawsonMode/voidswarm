// OWNER: PVE agent. Frozen signatures (called by the core sim).
import type { Enemy, EntityId, Ship, World } from '../../types';
import { stepAutoWeapons } from './autoweapons';
import { killEnemy, stepEnemies } from './enemies';
import { stepGems } from './gems';
import * as rift from './rift';
import { initDirector, stepDirector } from './waves';
import * as xp from './xp';

export { xpToNextFor } from './xp';
export { TRAIL_MINE_MARK } from './autoweapons';

/** Called once when the world is created (a rift: after createRiftState, so floor 1 is initialised here). */
export function pveInit(world: World): void {
  initDirector(world);
  if (world.dungeon) rift.riftFloorInit(world);
}

/**
 * Called every tick by Sim.step() after ship movement/firing and before the projectile system.
 * Runs: rift director (rift only, first), wave director (spawning; a no-op in a rift), enemy AI + movement + contact
 * damage, auto-weapons for every alive ship, gem magnet/collection/expiry.
 */
export function pveStep(world: World, dt: number): void {
  if (world.dungeon) rift.stepRiftDirector(world);
  stepDirector(world);
  stepEnemies(world, dt);
  stepAutoWeapons(world);
  stepGems(world, dt);
}

/**
 * Called by damageEnemy when an enemy's hp ≤ 0. Must delete it from world.enemies.
 * v0.3 M2: a ship kill (killerShipId ≠ 0) of an elite rolls rollLoot('elite'), of a Hive rollLoot('boss'),
 * with the killer's player as priority. Vanish / kamikaze deaths never drop (see enemies.killEnemy).
 * v0.3 M4: the Matriarch rolls the personal 'bossCache' for every human of the party.
 */
export function onEnemyKilled(world: World, enemy: Enemy, killerShipId: EntityId): void {
  killEnemy(world, enemy, killerShipId);
}

/** Called by damageShip when a ship dies: drops a share of its XP as gems at its position. */
export function dropShipXp(world: World, ship: Ship): void {
  xp.dropShipXp(world, ship);
}

/** Add XP (applies xpMult), handle level-ups, queue upgrade offers, emit 'levelUp'. */
export function grantXp(world: World, ship: Ship, amount: number): void {
  xp.grantXp(world, ship, amount);
}

/**
 * Apply ship.offers[0][index] (ignore invalid index), pop the offer (ship.offerSerial += 1), recompute
 * ship.stats, emit 'upgrade'. A card that is stale for the ship grants nothing and is re-offered.
 */
export function applyUpgradeChoice(world: World, ship: Ship, index: number): void {
  xp.applyUpgradeChoice(world, ship, index);
}

/** Rebuild all queued offers for the ship's current class/path (e.g. after a class swap). SIM addition. */
export function rebuildOffers(world: World, ship: Ship): void {
  xp.rebuildOffers(world, ship);
}

// ---- v0.3 M4 Dungeon Runner (§8.8 frozen signatures, called by SIM's sim/dungeon.ts + Sim.enterFloor) ----

/**
 * Floor start: tier into world.pve.wave, instability clock / boss pointer cleared, dormant hall + treasure packs
 * placed (deferred to the first tick if no ship exists yet). Idempotent per floor map.
 */
export function riftFloorInit(world: World): void {
  rift.riftFloorInit(world);
}

/** A room just SEALED with `partySize` party ships: queue its pulses (arena / key) or spawn the Matriarch (boss). */
export function riftEncounterStart(world: World, room: number, partySize: number): void {
  rift.riftEncounterStart(world, room, partySize);
}

/** All pulses spawned and no enemy inside the room rect. */
export function riftEncounterDone(world: World, room: number): boolean {
  return rift.riftEncounterDone(world, room);
}

/** Regroup reset: forget the room's encounter and remove the enemies still inside it (no events, no loot). */
export function riftEncounterReset(world: World, room: number): void {
  rift.riftEncounterReset(world, room);
}

/** Recompute ship.stats from class + upgrades, keeping the energy fraction (e.g. after a queued class swap). */
export function recomputeShipStats(ship: Ship): void {
  xp.recomputeStats(ship);
}
