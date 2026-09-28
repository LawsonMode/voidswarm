// OWNER: SIM agent. Turret kits (used instead of class skills while ship.attachedTo !== 0).
//   LMB offense draws HOST energy (blocked below TURRET_HOST_FLOOR_FRAC × host max):
//     flak (brute) · laser (tech, hitscan + resonance) · seekerpod (engineer)
//   RMB defense (held) spends the turret's OWN energy: brace · deflector · hull weld.
// Laser pierce choice: the beam stops at (and damages) the FIRST hostile it touches — no pierce.
import { DT, ENEMY_TEAM, LASER_RESONANCE, TURRET_HOST_FLOOR_FRAC } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import type { Ship, World } from '../types';
import { BEAM_LASER, BEAM_WELD } from '../types';
import { overchargeBonus } from './capital';
import { damageEnemy, damageShip, healShip } from './combat';
import { found, firstHitOnSegment, has, hostileTo, isHostileShip, onPath, raycastWall } from './targeting';
import { emit, projectileDefaults, secToTicks, spawnProjectile } from './world';

// Tuning knobs
export const BULWARK_TURRET_MULT = 1.25;
export const TURRETBAY_TURRET_MULT = 1.3;
export const FLAK_SPREAD = 0.55; // rad total
export const FLAK_SPEED = 820;
export const FLAK_LIFE = 0.32;
export const POD_SPEED = 560;
export const POD_LIFE = 1.8;
export const POD_HOMING_RANGE = 500;
/** Laser damage is accumulated per tick and applied every N ticks (limits 'hit' event spam). */
export const LASER_APPLY_TICKS = 6;
export const DEFLECT_MAX_PER_TICK = 4;

/** Outgoing damage multiplier for a turret on `host`: class turretDamageMult × damageMult × host bonuses. */
export function turretDamageMultFor(turret: Ship, host: Ship): number {
  let m = SHIP_CLASSES[turret.shipClass].turretDamageMult * turret.stats.damageMult;
  if (onPath(host, 'bulwark')) m *= BULWARK_TURRET_MULT;
  if (has(host, 'arc_turretbay')) m *= TURRETBAY_TURRET_MULT;
  return m;
}

export function hostAboveFloor(host: Ship): boolean {
  return host.alive && host.energy >= TURRET_HOST_FLOOR_FRAC * host.stats.maxEnergy;
}

/**
 * Number of Laser Lances on `host` firing this tick (cached per tick on host.skillState).
 * 0 when the host is below the energy floor.
 */
export function firingLasers(world: World, host: Ship): number {
  const ss = host.skillState;
  if (ss.laserTick === world.tick) return ss.laserN ?? 0;
  let n = 0;
  if (hostAboveFloor(host)) {
    for (const id of host.turrets) {
      const t = world.ships.get(id);
      if (t && t.alive && t.attachedTo === host.id && t.shipClass === 'tech' && t.input.primary) n++;
    }
  }
  ss.laserTick = world.tick;
  ss.laserN = n;
  return n;
}

/** Resonance factor for n lasers firing together: LASER_RESONANCE^(n−1). */
export function resonanceFactor(n: number): number {
  return n <= 1 ? 1 : Math.pow(LASER_RESONANCE, n - 1);
}

function flak(world: World, t: Ship, host: Ship, mult: number): void {
  const sk = t.stats.skill, tick = world.tick;
  if (tick < t.gunReadyTick || !hostAboveFloor(host)) return;
  const n = Math.max(1, Math.round(sk.flakPellets ?? 7));
  const dmg = (sk.flakDamage ?? 55) * mult;
  let spawned = 0;
  for (let i = 0; i < n; i++) {
    const a = t.angle + (n > 1 ? (i / (n - 1) - 0.5) * FLAK_SPREAD : 0);
    const sp = FLAK_SPEED * (0.85 + 0.3 * world.rng.next());
    if (spawnProjectile(world, {
      ...projectileDefaults(world), kind: 'shrapnel', ownerId: t.id, ownerPlayerId: t.playerId, ownerTeam: t.team,
      x: t.x + Math.cos(a) * (t.stats.radius + 2), y: t.y + Math.sin(a) * (t.stats.radius + 2),
      vx: host.vx + Math.cos(a) * sp, vy: host.vy + Math.sin(a) * sp, damage: dmg, radius: 3,
      expireTick: tick + Math.max(1, secToTicks(FLAK_LIFE)),
    })) spawned++;
  }
  if (spawned === 0) return; // projectile cap: nothing fired, the host pays nothing
  host.energy -= sk.flakHostCost ?? 40;
  t.gunReadyTick = tick + Math.max(1, secToTicks(sk.flakCd ?? 0.45));
  emit(world, { t: 'fire', shipId: t.id, skill: SHIP_CLASSES[t.shipClass].skills.primary.id, x: t.x, y: t.y });
}

function seekerPod(world: World, t: Ship, host: Ship, mult: number): void {
  const sk = t.stats.skill, tick = world.tick;
  if (tick < t.gunReadyTick || !hostAboveFloor(host)) return;
  const n = Math.max(1, Math.round(sk.podCount ?? 2));
  const dmg = (sk.podDamage ?? 85) * mult;
  let spawned = 0;
  for (let i = 0; i < n; i++) {
    const a = t.angle + (n > 1 ? (i / (n - 1) - 0.5) * 0.6 : 0);
    if (spawnProjectile(world, {
      ...projectileDefaults(world), kind: 'seeker', ownerId: t.id, ownerPlayerId: t.playerId, ownerTeam: t.team,
      x: t.x + Math.cos(a) * (t.stats.radius + 2), y: t.y + Math.sin(a) * (t.stats.radius + 2),
      vx: host.vx * 0.5 + Math.cos(a) * POD_SPEED, vy: host.vy * 0.5 + Math.sin(a) * POD_SPEED, damage: dmg, radius: 4,
      expireTick: tick + secToTicks(POD_LIFE), homingRange: POD_HOMING_RANGE, homingTurn: 4,
    })) spawned++;
  }
  if (spawned === 0) return; // projectile cap: nothing fired, the host pays nothing
  host.energy -= sk.podHostCost ?? 45;
  t.gunReadyTick = tick + Math.max(1, secToTicks(sk.podCd ?? 1));
  emit(world, { t: 'fire', shipId: t.id, skill: SHIP_CLASSES[t.shipClass].skills.primary.id, x: t.x, y: t.y });
}

/**
 * Pay out the laser damage banked on ss.laserTarget (the body the beam was on) and clear the bank.
 * Only a bank built up through the previous tick is paid; an older one (beam was off, turret detached)
 * is discarded, so stale damage can never land later or on something else.
 */
export function flushLaser(world: World, t: Ship): void {
  const ss = t.skillState;
  const amt = ss.laserAcc ?? 0, id = ss.laserTarget ?? 0;
  const fresh = (ss.laserAccTick ?? -10) >= world.tick - 1;
  ss.laserAcc = 0;
  ss.laserTarget = 0;
  if (!(amt > 0) || !id || !fresh) return;
  const e = world.enemies.get(id);
  if (e) { damageEnemy(world, e, amt, t.id); return; }
  const s = world.ships.get(id);
  if (s && isHostileShip(world, t.team, t.id, s)) damageShip(world, s, amt, t.id, 'player');
}

/**
 * Lasers counted for resonance on `host` this tick: the firing lasers, plus the v0.5 Resonance Overcharge bonus
 * while the host's overcharge runs (capital.ts). 0 when none fire (an overcharge alone never fires a beam).
 */
export function resonantLasers(world: World, host: Ship): number {
  const n = firingLasers(world, host);
  return n > 0 ? n + overchargeBonus(world, host) : 0;
}

function laser(world: World, t: Ship, host: Ship, mult: number): void {
  const n = resonantLasers(world, host);
  if (n <= 0) { flushLaser(world, t); return; }
  const sk = t.stats.skill, ss = t.skillState;
  const f = resonanceFactor(n);
  host.energy -= (sk.laserHostCostPerSec ?? 90) * DT * f;
  const range = sk.laserRange ?? 620;
  const dx = Math.cos(t.angle), dy = Math.sin(t.angle);
  const x0 = t.x + dx * t.stats.radius, y0 = t.y + dy * t.stats.radius;
  const len = raycastWall(world.map, x0, y0, dx, dy, range);
  let beam = len;
  if (firstHitOnSegment(world, t.team, t.id, x0, y0, x0 + dx * len, y0 + dy * len, 3, host.id)) {
    const e = found.e, s = found.s;
    beam = Math.max(0, Math.sqrt(found.d2) - found.r * 0.5);
    const id = e ? e.id : s ? s.id : 0;
    // The bank belongs to one target: pay it out to the old one when the beam moves on (or drop it if stale).
    if ((ss.laserTarget ?? 0) !== id || (ss.laserAccTick ?? -10) < world.tick - 1) flushLaser(world, t);
    ss.laserTarget = id;
    ss.laserAcc = (ss.laserAcc ?? 0) + (sk.laserDps ?? 260) * DT * f * mult;
    ss.laserAccTick = world.tick;
    if (world.tick % LASER_APPLY_TICKS === 0 && ss.laserAcc > 0) {
      const amt = ss.laserAcc;
      ss.laserAcc = 0;
      if (e) damageEnemy(world, e, amt, t.id);
      else if (s) damageShip(world, s, amt, t.id, 'player');
    }
  } else {
    flushLaser(world, t);
  }
  ss.beamLen = beam + t.stats.radius;
  ss.beamKind = BEAM_LASER;
  ss.resonance = n;
  if ((ss.laserFireTick ?? -100) < world.tick - 30) {
    emit(world, { t: 'fire', shipId: t.id, skill: SHIP_CLASSES[t.shipClass].skills.primary.id, x: t.x, y: t.y });
    ss.laserFireTick = world.tick;
  }
}

function brace(world: World, t: Ship, host: Ship): void {
  const sk = t.stats.skill;
  const cost = (sk.braceCostPerSec ?? 220) * DT;
  if (t.energy < cost) return;
  t.energy -= cost;
  const hs = host.skillState;
  const absorb = sk.braceAbsorb ?? 0.5;
  hs.braceAbsorb = hs.braceTick === world.tick ? Math.max(hs.braceAbsorb ?? 0, absorb) : absorb;
  hs.braceTick = world.tick;
}

function deflect(world: World, t: Ship, host: Ship): void {
  const sk = t.stats.skill;
  const cost = sk.deflectCostPerShot ?? 35;
  const r = sk.deflectRadius ?? 170, r2 = r * r;
  let n = 0;
  for (const p of world.projectiles.values()) {
    if (t.energy < cost || n >= DEFLECT_MAX_PER_TICK) break;
    if (p.kind === 'mine') continue;
    if (!hostileTo(p.ownerTeam, p.ownerId, host.team, host.id) || p.ownerId === t.id) continue;
    if (p.ownerTeam !== ENEMY_TEAM && p.ownerTeam >= 0 && p.ownerTeam === host.team) continue;
    const dx = p.x - host.x, dy = p.y - host.y;
    if (dx * dx + dy * dy > r2) continue;
    world.projectiles.delete(p.id);
    t.energy -= cost;
    n++;
    emit(world, { t: 'explode', x: p.x, y: p.y, radius: 0, kind: p.kind, team: t.team });
  }
}

function weld(world: World, t: Ship, host: Ship): void {
  const sk = t.stats.skill, ss = t.skillState;
  const costRate = sk.weldCostPerSec ?? 240, gainRate = sk.weldPerSec ?? 220;
  const room = host.stats.maxEnergy - host.energy;
  if (room <= 0 || costRate <= 0) return;
  let spend = Math.min(costRate * DT, t.energy - 1);
  if (spend <= 0) return;
  let gain = spend * (gainRate / costRate);
  if (gain > room) { gain = room; spend = gain * (costRate / gainRate); }
  t.energy -= spend;
  healShip(world, host, gain, t.id);
  const dx = host.x - t.x, dy = host.y - t.y;
  ss.beamLen = Math.sqrt(dx * dx + dy * dy);
  ss.beamKind = BEAM_WELD;
  ss.resonance = 1;
}

/** Run the turret kit for an attached, alive turret (after turrets were placed this tick). */
export function stepTurretKit(world: World, t: Ship): void {
  const host = world.ships.get(t.attachedTo);
  if (!host || !host.alive) return;
  const kit = SHIP_CLASSES[t.shipClass].turret.id;
  if (t.input.primary) {
    const mult = turretDamageMultFor(t, host);
    if (kit === 'flak') flak(world, t, host, mult);
    else if (kit === 'laser') laser(world, t, host, mult);
    else seekerPod(world, t, host, mult);
  } else if (kit === 'laser' && (t.skillState.laserAcc ?? 0) > 0) {
    flushLaser(world, t); // trigger released: pay out what the beam already dealt
  }
  if (t.input.secondary) {
    if (kit === 'flak') brace(world, t, host);
    else if (kit === 'laser') deflect(world, t, host);
    else weld(world, t, host);
  }
}
