// OWNER: SIM agent. Turret attach/detach helpers shared by Sim and combat.
import { ATTACH_COOLDOWN_SEC, ATTACH_MIN_ENERGY_FRAC, MAX_HARDPOINTS } from '../constants';
import { SHIP_CLASSES, hasUpgrade } from '../data/ships';
import type { Ship, World } from '../types';
import { seatTurret, syncHull } from './hull';
import { isCarrier, objMaxTurrets } from './objectives/index';
import { emit, sameTeam, secToTicks } from './world';

/** Outward push speed (px/s) given to a turret when it detaches. */
export const DETACH_PUSH = 160;

/**
 * Detach `turret` from its host (if any). Gives host velocity + outward push; emits 'detach'.
 * v0.5: the turret gets its own hull back (bubble → base radius) and the host re-sizes its capital hull and
 * re-flows its remaining turrets onto the new hardpoint layout at once.
 */
export function detachTurret(world: World, turret: Ship, push = DETACH_PUSH): void {
  const hostId = turret.attachedTo;
  if (!hostId) return;
  turret.attachedTo = 0;
  // Laser Lance bank belongs to this attachment: drop it (never carried into a later re-attach).
  turret.skillState.laserAcc = 0;
  turret.skillState.laserTarget = 0;
  const host = world.ships.get(hostId);
  let hvx = 0, hvy = 0, ax = Math.cos(turret.angle), ay = Math.sin(turret.angle);
  if (host) {
    const idx = host.turrets.indexOf(turret.id);
    if (idx >= 0) host.turrets.splice(idx, 1);
    hvx = host.vx; hvy = host.vy;
    const dx = turret.x - host.x, dy = turret.y - host.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-6) { ax = dx / d; ay = dy / d; }
  }
  turret.vx = hvx + ax * push;
  turret.vy = hvy + ay * push;
  syncHull(world, turret);
  if (host) syncHull(world, host);
  emit(world, { t: 'detach', turretShipId: turret.id, hostShipId: hostId });
}

/** Host shakes off all its turrets. */
export function shakeOffTurrets(world: World, host: Ship, push = DETACH_PUSH): void {
  while (host.turrets.length) {
    const t = world.ships.get(host.turrets[host.turrets.length - 1]);
    if (!t || t.attachedTo !== host.id) { host.turrets.pop(); continue; }
    detachTurret(world, t, push);
  }
}

/** Detach everything related to this ship (as turret and as host). */
export function detachAll(world: World, ship: Ship, push = DETACH_PUSH): void {
  if (ship.attachedTo) detachTurret(world, ship, push);
  shakeOffTurrets(world, ship, push);
}

/**
 * A host `ship` may warp onto: alive, free, an ally, and with a free slot. v0.3: the slot count is
 * objMaxTurrets (a CTF flag carrier keeps only the gunner seat, CTF_CARRIER_MAX_TURRETS; outside an
 * objective match it is host.stats.maxTurrets). v0.5: never more than MAX_HARDPOINTS (the hull's mounts).
 */
export function isValidHost(world: World, ship: Ship, host: Ship | undefined): host is Ship {
  return !!host && host.id !== ship.id && host.alive && host.attachedTo === 0 &&
    sameTeam(host.team, ship.team) && host.turrets.length < Math.min(MAX_HARDPOINTS, objMaxTurrets(world, host));
}

/**
 * Place a turret at its host's slot position (no-op if not attached): the v0.5 hardpoint of its slot, at the
 * host's effective (capital-scaled) radius (hull.ts seatTurret).
 */
export function placeTurret(world: World, turret: Ship): void {
  seatTurret(world, turret);
}

/** bul_clamp host: teammates attach with no energy minimum / cooldown. */
export function hostHasClamp(host: Ship): boolean {
  return host.shipClass === 'brute' && hasUpgrade(host.upgrades, 'bul_clamp');
}

/**
 * Try to attach `ship` as a turret (teams mode). Returns true on success.
 * v0.3: a flag carrier never becomes a turret (it must fly the flag home itself).
 */
export function tryAttach(world: World, ship: Ship): boolean {
  if (world.config.mode !== 'teams') return false;
  if (!ship.alive || ship.attachedTo || ship.turrets.length) return false;
  if (!SHIP_CLASSES[ship.shipClass].canTurret) return false;
  if (isCarrier(world, ship)) return false;
  const meetsReq = ship.energy >= ATTACH_MIN_ENERGY_FRAC * ship.stats.maxEnergy && world.tick >= ship.attachReadyTick;
  const ok = (h: Ship | undefined): h is Ship => isValidHost(world, ship, h) && (meetsReq || hostHasClamp(h));

  let host: Ship | undefined = world.ships.get(ship.input.attachTarget);
  if (!ok(host)) {
    host = undefined;
    const ax = ship.x + Math.cos(ship.input.aim) * 300, ay = ship.y + Math.sin(ship.input.aim) * 300;
    let bestD = Infinity;
    for (const h of world.ships.values()) {
      if (!ok(h)) continue;
      const dx = h.x - ax, dy = h.y - ay, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; host = h; }
    }
  }
  if (!host) return false;
  host.turrets.push(ship.id);
  ship.attachedTo = host.id;
  syncHull(world, ship); // bubble dome
  syncHull(world, host); // capital hull grows (wall push-out) and its turrets re-flow
  placeTurret(world, ship);
  ship.attachReadyTick = world.tick + secToTicks(ATTACH_COOLDOWN_SEC);
  emit(world, { t: 'attach', turretShipId: ship.id, hostShipId: host.id });
  return true;
}
