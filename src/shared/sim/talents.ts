// OWNER: SIM agent. Per-tick talent procs that aren't tied to a skill press:
//   bar_autolauncher · sto_static · med_beam · sum_drones (drone upkeep). Field Revive lives in Sim.ts
//   (needs the spawn routine). Skill-bound talents are in skills.ts / projectiles.ts / deployables.ts.
import { DT } from '../constants';
import type { Ship, World } from '../types';
import { damageEnemy, damageShip, healShip } from './combat';
import { DRONE_COUNT, DRONE_RESPAWN_SEC, deployDrone } from './deployables';
import { fireRockets } from './skills';
import { found, has, nearestHostile } from './targeting';
import { emit, sameTeam, secToTicks } from './world';

// Tuning knobs
export const AUTOLAUNCH_EVERY_SEC = 2;
export const AUTOLAUNCH_RANGE = 700;
export const AUTOLAUNCH_COUNT = 2;
export const AUTOLAUNCH_DAMAGE = 0.5;
export const STATIC_EVERY_SEC = 0.8;
export const STATIC_RADIUS = 220;
export const STATIC_TARGETS = 3;
export const STATIC_DAMAGE = 60;
export const BEAM_RANGE = 320;
export const BEAM_HPS = 120;
export const BEAM_EVENT_TICKS = 9; // ~0.15 s

const seen = new Set<number>();

function autolauncher(world: World, ship: Ship): void {
  const ss = ship.skillState, tick = world.tick;
  if (tick < (ss.autoLaunchAt ?? 0)) return;
  if (!nearestHostile(world, ship.team, ship.id, ship.x, ship.y, AUTOLAUNCH_RANGE, ship.x, ship.y, true)) {
    ss.autoLaunchAt = tick + 10;
    return;
  }
  const a = Math.atan2(found.y - ship.y, found.x - ship.x);
  if (fireRockets(world, ship, a, AUTOLAUNCH_COUNT, AUTOLAUNCH_DAMAGE) === 0) { ss.autoLaunchAt = tick + 10; return; } // projectile cap
  ss.autoLaunchAt = tick + secToTicks(AUTOLAUNCH_EVERY_SEC);
  emit(world, { t: 'ability', shipId: ship.id, skill: 'rockets', x: ship.x, y: ship.y, talent: 'bar_autolauncher' });
}

function staticField(world: World, ship: Ship): void {
  const ss = ship.skillState, tick = world.tick;
  if (tick < (ss.staticAt ?? 0)) return;
  ss.staticAt = tick + secToTicks(STATIC_EVERY_SEC);
  seen.clear();
  const pts: number[] = [];
  const dmg = STATIC_DAMAGE * ship.stats.damageMult;
  for (let i = 0; i < STATIC_TARGETS; i++) {
    if (!nearestHostile(world, ship.team, ship.id, ship.x, ship.y, STATIC_RADIUS, ship.x, ship.y, true, seen)) break;
    pts.push(ship.x, ship.y, found.x, found.y);
    if (found.e) { seen.add(found.e.id); damageEnemy(world, found.e, dmg, ship.id); }
    else if (found.s) { seen.add(found.s.id); damageShip(world, found.s, dmg, ship.id, 'player'); }
  }
  if (pts.length) emit(world, { t: 'arc', points: pts, team: ship.team });
}

function repairBeam(world: World, ship: Ship): void {
  const r2 = BEAM_RANGE * BEAM_RANGE;
  let best: Ship | null = null, bestFrac = 1;
  for (const s of world.ships.values()) {
    if (!s.alive || s.id === ship.id || !sameTeam(s.team, ship.team)) continue;
    const frac = s.energy / s.stats.maxEnergy;
    if (frac >= bestFrac) continue;
    const dx = s.x - ship.x, dy = s.y - ship.y;
    if (dx * dx + dy * dy > r2) continue;
    best = s; bestFrac = frac;
  }
  if (!best) return;
  healShip(world, best, BEAM_HPS * ship.stats.healMult * DT, ship.id);
  const ss = ship.skillState;
  if (world.tick - (ss.beamEvtTick ?? -100) >= BEAM_EVENT_TICKS || ss.beamTarget !== best.id) {
    emit(world, { t: 'beam', fromId: ship.id, toId: best.id, kind: 'heal' });
    ss.beamEvtTick = world.tick;
    ss.beamTarget = best.id;
  }
}

function droneUpkeep(world: World, ship: Ship): void {
  const ss = ship.skillState, tick = world.tick;
  let have = 0, slotMask = 0;
  for (const d of world.deployables.values()) {
    if (d.kind === 'drone' && d.ownerId === ship.id) { have++; slotMask |= 1 << (d.mem.slot ?? 0); }
  }
  if (have >= DRONE_COUNT) { ss.droneWait = 0; return; }
  if (!(ss.droneWait ?? 0)) ss.droneWait = tick + ((ss.dronesInit ?? 0) ? secToTicks(DRONE_RESPAWN_SEC) : 0);
  if (tick < ss.droneWait) return;
  for (let slot = 0; slot < DRONE_COUNT; slot++) if (!(slotMask & (1 << slot))) deployDrone(world, ship, slot);
  ss.dronesInit = 1;
  ss.droneWait = 0;
}

/** Talent procs for one alive ship (turret or not — these are passives). */
export function stepTalents(world: World, ship: Ship): void {
  switch (ship.shipClass) {
    case 'brute':
      if (has(ship, 'bar_autolauncher') && !ship.attachedTo) autolauncher(world, ship);
      break;
    case 'tech':
      if (has(ship, 'sto_static')) staticField(world, ship);
      break;
    case 'engineer':
      if (has(ship, 'med_beam')) repairBeam(world, ship);
      if (has(ship, 'sum_drones')) droneUpkeep(world, ship);
      break;
  }
}
