// OWNER: SIM agent. Class skills (primary/secondary/mobility/utility) for all 12 SkillIds + Ram Charge.
import { DT } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import type { Enemy, Ship, SkillId, SkillSlot, UpgradeId, World } from '../types';
import { angleDiff, wrapAngle } from '../util/math';
import { SPACE_CD_TICKS, useCapital } from './capital';
import { damageEnemy, damageShip, healShip, splashDamage } from './combat';
import { deployNanite, deploySentry, deployWall, deployWell } from './deployables';
import { isCapital } from './hull';
import { collideCircle } from './map';
import { THRUST_DEADZONE } from './movement';
import { isCarrier, objSpeedMult } from './objectives/index';
import { CTF_CARRIER_BLINK_MULT } from './objectives/rules';
import { side } from './state';
import { crewSafe, found, has, isHostileShip, nearestHostile } from './targeting';
import {
  canDamageShip, emit, forEachEnemyNear, forEachShipNear, projectileDefaults, sameTeam, secToTicks, spawnProjectile,
} from './world';

// Tuning knobs
export const PRIMARY_INHERIT = 0.3; // fraction of ship velocity primaries/rockets inherit
export const BULLET_RADIUS = 4;
export const PLASMA_RADIUS = 5;
export const ROCKET_RADIUS = 6;
export const ROCKET_LIFE = 1.8;
export const ROCKET_FAN_STEP = 0.14; // rad between rockets
export const ROCKET_HOMING_RANGE = 320;
export const ROCKET_HOMING_TURN = 2.2;
export const RAM_HIT_PAD = 8;
export const RAM_KNOCK_ENEMY = 700;
export const RAM_KNOCK_SHIP = 600;
export const UNSTOPPABLE_DIST_MULT = 1.6;
export const QUAKE_RADIUS = 220;
export const QUAKE_DAMAGE = 300;
export const QUAKE_KNOCK = 500;
export const MOMENTUM_RAM_MULT = 2;
export const MOMENTUM_PRIMARY_MULT = 1.15;
export const MOMENTUM_SPEED_FRAC = 0.8;
export const FORTRESS_RADIUS = 250;
export const BLINK_STEP = 8;
export const BLINK_INVULN_SEC = 0.3;
export const THUNDER_RADIUS = 200;
export const THUNDER_DAMAGE = 260;
export const SINGULARITY_SPEED = 750;
export const SINGULARITY_MAX_DIST = 600;
export const ARC_FALLOFF = 0.85;
export const RAIL_EVERY = 5;
export const RAIL_MULT = 4;
export const RAIL_PIERCE = 999;
export const FOCUS_MULT = 1.3;
export const REPAIR_BOOST_SEC = 1;
export const REPAIR_BOOST_MULT = 1.3;

/** Distance to the aim point (InputState.aimDist, sanitized by Sim.setInput). */
export function aimDistOf(ship: Ship): number {
  const d = ship.input.aimDist;
  return Number.isFinite(d) ? Math.max(0, Math.min(2000, d)) : 300;
}

export function skillId(ship: Ship, slot: SkillSlot): SkillId {
  return SHIP_CLASSES[ship.shipClass].skills[slot].id;
}

function tier(val: number, base: number): number {
  if (!(base > 0)) return 1;
  const r = val / base;
  return r >= 1.6 ? 3 : r >= 1.2 ? 2 : 1;
}

function ability(world: World, ship: Ship, skill: SkillId, x = ship.x, y = ship.y, talent?: UpgradeId): void {
  if (talent) emit(world, { t: 'ability', shipId: ship.id, skill, x, y, talent });
  else emit(world, { t: 'ability', shipId: ship.id, skill, x, y });
}

// ---------------------------------------------------------------------------------------------
// Primary (held, auto-repeat at gunCooldown)
// ---------------------------------------------------------------------------------------------

function isThrusting(ship: Ship): boolean {
  const i = ship.input;
  return Math.sqrt(i.moveX * i.moveX + i.moveY * i.moveY) > THRUST_DEADZONE;
}

export function firePrimary(world: World, ship: Ship): void {
  const st = ship.stats, tick = world.tick;
  if (tick < ship.gunReadyTick || ship.energy < st.gunCost) return;
  const id = skillId(ship, 'primary');
  const base = SHIP_CLASSES[ship.shipClass].base;
  const ss = ship.skillState;
  let dmg = st.gunDamage * st.damageMult;
  let rail = false, shot = 0;
  if (ship.shipClass === 'brute' && has(ship, 'ram_momentum')) {
    if (Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy) > MOMENTUM_SPEED_FRAC * st.maxSpeed) dmg *= MOMENTUM_PRIMARY_MULT;
  }
  if (ship.shipClass === 'tech') {
    if (has(ship, 'lan_focus') && !isThrusting(ship)) dmg *= FOCUS_MULT;
    if (has(ship, 'lan_rail')) {
      shot = (ss.shotCount ?? 0) + 1;
      if (shot % RAIL_EVERY === 0) { rail = true; dmg *= RAIL_MULT; }
    }
  }
  const kind = id === 'plasma' ? 'plasma' : 'bullet';
  const radius = kind === 'plasma' ? PLASMA_RADIUS : BULLET_RADIUS;
  const dirX = Math.cos(ship.angle), dirY = Math.sin(ship.angle);
  const n = Math.max(1, Math.round(st.gunCount));
  const nose = st.radius + 4;
  const lvl = rail ? 3 : tier(st.gunDamage * st.damageMult, base.gunDamage);
  let spawned = 0;
  for (let i = 0; i < n; i++) {
    let a = ship.angle, ox = 0, oy = 0;
    if (n > 1) {
      if (st.gunSpread > 0) a += (i / (n - 1) - 0.5) * st.gunSpread;
      else { const off = (i - (n - 1) / 2) * 8; ox = -dirY * off; oy = dirX * off; }
    }
    const cx = Math.cos(a), cy = Math.sin(a);
    if (spawnProjectile(world, {
      ...projectileDefaults(world), kind, ownerId: ship.id, ownerPlayerId: ship.playerId, ownerTeam: ship.team,
      x: ship.x + dirX * nose + ox, y: ship.y + dirY * nose + oy,
      vx: ship.vx * PRIMARY_INHERIT + cx * st.gunSpeed, vy: ship.vy * PRIMARY_INHERIT + cy * st.gunSpeed,
      damage: dmg, radius: rail ? radius + 2 : radius, expireTick: tick + Math.max(1, secToTicks(st.gunLife)),
      pierce: rail ? RAIL_PIERCE : Math.max(0, Math.round(st.gunPierce)), level: lvl,
    })) spawned++;
  }
  // The projectile cap (MAX_PROJECTILES) refused every barrel: nothing fired, nothing spent (retry next tick).
  if (spawned === 0) return;
  if (shot) ss.shotCount = shot;
  ship.energy -= st.gunCost;
  ship.gunReadyTick = tick + Math.max(1, Math.round(st.gunCooldown * 60));
  emit(world, { t: 'fire', shipId: ship.id, skill: id, x: ship.x, y: ship.y });
}

// ---------------------------------------------------------------------------------------------
// Secondary (held, repeats at secondaryCooldown)
// ---------------------------------------------------------------------------------------------

/**
 * Fire `count` rockets in a fan along `angle` (Rocket Salvo; Auto-Launcher uses damageScale 0.5).
 * Returns how many actually spawned (0 when the projectile cap refused them all).
 */
export function fireRockets(world: World, ship: Ship, angle: number, count: number, damageScale: number): number {
  const st = ship.stats, sk = st.skill;
  const n = Math.max(1, Math.round(count));
  const spread = Math.min(0.9, ROCKET_FAN_STEP * (n - 1));
  const speed = sk.rocketSpeed ?? 700;
  const base = SHIP_CLASSES.brute.base.skill.rocketDamage ?? 180;
  const dmg = (sk.rocketDamage ?? 180) * st.secondaryPower * st.damageMult * damageScale;
  let spawned = 0;
  for (let i = 0; i < n; i++) {
    const a = angle + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0);
    const cx = Math.cos(a), cy = Math.sin(a);
    if (spawnProjectile(world, {
      ...projectileDefaults(world), kind: 'rocket', ownerId: ship.id, ownerPlayerId: ship.playerId, ownerTeam: ship.team,
      x: ship.x + cx * (st.radius + 6), y: ship.y + cy * (st.radius + 6),
      vx: ship.vx * PRIMARY_INHERIT + cx * speed, vy: ship.vy * PRIMARY_INHERIT + cy * speed,
      damage: dmg, radius: ROCKET_RADIUS, splash: sk.rocketSplash ?? 70,
      expireTick: world.tick + secToTicks(ROCKET_LIFE), homingRange: ROCKET_HOMING_RANGE, homingTurn: ROCKET_HOMING_TURN,
      level: tier(dmg / damageScale, base),
    })) spawned++;
  }
  return spawned;
}

const arcSeen = new Set<number>();
/** Arc Lightning. Returns false (nothing spent) when there is no target. */
function castArc(world: World, ship: Ship): boolean {
  const sk = ship.stats.skill;
  const range = sk.arcRange ?? 600, hop = sk.arcHopRange ?? 260;
  const hops = Math.max(1, Math.round(sk.arcHops ?? 4));
  const aim = ship.input.aim;
  const ad = aimDistOf(ship);
  const px = ship.x + Math.cos(aim) * ad, py = ship.y + Math.sin(aim) * ad;
  arcSeen.clear();
  if (!nearestHostile(world, ship.team, ship.id, ship.x, ship.y, range, px, py, true, arcSeen)) return false;
  let dmg = (sk.arcDamage ?? 220) * ship.stats.secondaryPower * ship.stats.damageMult;
  const pts: number[] = [ship.x, ship.y];
  for (let i = 0; i < hops; i++) {
    const e = found.e, s = found.s, x = found.x, y = found.y;
    pts.push(x, y);
    if (e) { arcSeen.add(e.id); damageEnemy(world, e, dmg, ship.id); }
    else if (s) { arcSeen.add(s.id); damageShip(world, s, dmg, ship.id, 'player'); }
    dmg *= ARC_FALLOFF;
    if (i === hops - 1) break;
    if (!nearestHostile(world, ship.team, ship.id, x, y, hop, x, y, true, arcSeen)) break;
  }
  emit(world, { t: 'arc', points: pts, team: ship.team });
  return true;
}

function useSecondary(world: World, ship: Ship): void {
  const st = ship.stats, tick = world.tick;
  if (tick < ship.secondaryReadyTick || ship.energy < st.secondaryCost) return;
  const id = skillId(ship, 'secondary');
  let ok = true;
  switch (id) {
    case 'rockets': ok = fireRockets(world, ship, ship.angle, st.skill.rocketCount ?? 3, 1) > 0; break;
    case 'arc': ok = castArc(world, ship); break;
    case 'sentry': ok = deploySentry(world, ship) !== null; break;
    default: ok = false;
  }
  if (!ok) { ship.secondaryReadyTick = tick + 6; return; }
  ship.energy -= st.secondaryCost;
  ship.secondaryReadyTick = tick + Math.max(1, secToTicks(st.secondaryCooldown));
  emit(world, { t: 'fire', shipId: ship.id, skill: id, x: ship.x, y: ship.y });
}

// ---------------------------------------------------------------------------------------------
// Mobility (rising edge)
// ---------------------------------------------------------------------------------------------

function startRam(world: World, ship: Ship): void {
  const sk = ship.stats.skill;
  const ss = ship.skillState;
  const time = (sk.chargeTime ?? 0.35) * (has(ship, 'ram_unstoppable') ? UNSTOPPABLE_DIST_MULT : 1);
  ss.charging = 1;
  ss.chargeDirX = Math.cos(ship.input.aim);
  ss.chargeDirY = Math.sin(ship.input.aim);
  ship.angle = wrapAngle(ship.input.aim);
  ship.mobilityActiveUntilTick = world.tick + Math.max(1, secToTicks(time));
  side(world).ramHits.set(ship.id, new Set());
}

let rW: World, rS: Ship, rDmg = 0, rHits: Set<number>;
function ramEnemy(e: Enemy): void {
  if (rHits.has(e.id) || e.hp <= 0) return;
  rHits.add(e.id);
  const dx = e.x - rS.x, dy = e.y - rS.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  if (e.kind !== 'hive') { e.vx = (dx / d) * RAM_KNOCK_ENEMY; e.vy = (dy / d) * RAM_KNOCK_ENEMY; }
  damageEnemy(rW, e, rDmg, rS.id);
}
function ramShip(s: Ship): void {
  if (s.id === rS.id || rHits.has(s.id) || !canDamageShip(rW, rS.team, rS.id, s.team, s.id) || crewSafe(rW, rS.team, rS.id, s)) return;
  rHits.add(s.id);
  const dx = s.x - rS.x, dy = s.y - rS.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  if (!s.attachedTo) { s.vx += (dx / d) * RAM_KNOCK_SHIP; s.vy += (dy / d) * RAM_KNOCK_SHIP; }
  damageShip(rW, s, rDmg, rS.id, 'player');
}
let kX = 0, kY = 0, kTeam = 0, kId = 0, kW: World;
function knockEnemy(e: Enemy): void {
  if (e.kind === 'hive') return;
  const dx = e.x - kX, dy = e.y - kY, d = Math.sqrt(dx * dx + dy * dy) || 1;
  e.vx += (dx / d) * QUAKE_KNOCK; e.vy += (dy / d) * QUAKE_KNOCK;
}
function knockShip(s: Ship): void {
  if (s.attachedTo || !canDamageShip(kW, kTeam, kId, s.team, s.id)) return;
  const dx = s.x - kX, dy = s.y - kY, d = Math.sqrt(dx * dx + dy * dy) || 1;
  s.vx += (dx / d) * QUAKE_KNOCK; s.vy += (dy / d) * QUAKE_KNOCK;
}

function endRam(world: World, ship: Ship): void {
  const ss = ship.skillState;
  ss.charging = 0;
  side(world).ramHits.delete(ship.id);
  const sp = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy), max = ship.stats.maxSpeed;
  if (sp > max) { ship.vx *= max / sp; ship.vy *= max / sp; }
  if (has(ship, 'ram_quake')) {
    splashDamage(world, ship.x, ship.y, QUAKE_RADIUS, QUAKE_DAMAGE * ship.stats.damageMult, ship.team, ship.id);
    kW = world; kX = ship.x; kY = ship.y; kTeam = ship.team; kId = ship.id;
    forEachEnemyNear(world, ship.x, ship.y, QUAKE_RADIUS, knockEnemy);
    forEachShipNear(world, ship.x, ship.y, QUAKE_RADIUS, knockShip);
    emit(world, { t: 'nova', x: ship.x, y: ship.y, radius: QUAKE_RADIUS, team: ship.team });
    ability(world, ship, 'ram', ship.x, ship.y, 'ram_quake');
  }
}

/**
 * Ram Charge movement + hits. Returns true when the charge drove movement this tick (skip normal
 * movement). Called in the movement pass for free (non-turret) ships.
 */
export function stepCharge(world: World, ship: Ship): boolean {
  const ss = ship.skillState;
  if (!(ss.charging ?? 0)) return false;
  if (world.tick >= ship.mobilityActiveUntilTick || ship.attachedTo) { endRam(world, ship); return false; }
  // v0.3 CTF: a flag carrier's charge is × CTF_CARRIER_SPEED_MULT too (§5.3 "Speed ×0.88"; client prediction mirrors
  // it via moveSkillsFor), so Ram Charge is no full-speed escape for a Juggernaut carrier. Neutral 1 elsewhere.
  const sp = (ship.stats.skill.chargeSpeed ?? 1500) * objSpeedMult(world, ship);
  ship.vx = (ss.chargeDirX ?? 1) * sp; ship.vy = (ss.chargeDirY ?? 0) * sp;
  ship.x += ship.vx * DT; ship.y += ship.vy * DT;
  const c = collideCircle(world.map, ship.x, ship.y, ship.stats.radius);
  if (c.hit) {
    ship.x = c.x; ship.y = c.y;
    // slide along the wall: drop the into-wall component of the charge direction
    const dn = (ss.chargeDirX ?? 0) * c.nx + (ss.chargeDirY ?? 0) * c.ny;
    if (dn < 0) {
      let dx = (ss.chargeDirX ?? 0) - dn * c.nx, dy = (ss.chargeDirY ?? 0) - dn * c.ny;
      const l = Math.sqrt(dx * dx + dy * dy);
      if (l < 0.2) { endRam(world, ship); ship.vx = 0; ship.vy = 0; return true; }
      dx /= l; dy /= l; ss.chargeDirX = dx; ss.chargeDirY = dy;
    }
  }
  const hits = side(world).ramHits.get(ship.id);
  if (hits) {
    const sk = ship.stats.skill;
    rW = world; rS = ship; rHits = hits;
    rDmg = (sk.ramDamage ?? 400) * ship.stats.mobilityPower * ship.stats.damageMult * (has(ship, 'ram_momentum') ? MOMENTUM_RAM_MULT : 1);
    const r = ship.stats.radius + RAM_HIT_PAD;
    forEachEnemyNear(world, ship.x, ship.y, r, ramEnemy);
    rW = world; rS = ship; rHits = hits;
    forEachShipNear(world, ship.x, ship.y, r, ramShip);
  }
  return true;
}

function blink(world: World, ship: Ship): void {
  const sk = ship.stats.skill, r = ship.stats.radius, map = world.map;
  // v0.3 CTF: a flag carrier blinks CTF_CARRIER_BLINK_MULT as far (§5.3).
  const range = (sk.blinkRange ?? 480) * (isCarrier(world, ship) ? CTF_CARRIER_BLINK_MULT : 1);
  const dx = Math.cos(ship.input.aim), dy = Math.sin(ship.input.aim);
  const fromX = ship.x, fromY = ship.y;
  let bx = ship.x, by = ship.y;
  for (let t = BLINK_STEP; t <= range; t += BLINK_STEP) {
    const x = fromX + dx * t, y = fromY + dy * t;
    if (x < r || y < r || x > map.width - r || y > map.height - r) break;
    if (collideCircle(map, x, y, r).hit) break;
    bx = x; by = y;
  }
  ship.x = bx; ship.y = by;
  ship.invulnUntilTick = Math.max(ship.invulnUntilTick, world.tick + secToTicks(BLINK_INVULN_SEC));
  emit(world, { t: 'blink', shipId: ship.id, fromX, fromY, x: bx, y: by });
  if (has(ship, 'sto_thunder')) {
    splashDamage(world, bx, by, THUNDER_RADIUS, THUNDER_DAMAGE * ship.stats.damageMult, ship.team, ship.id);
    emit(world, { t: 'nova', x: bx, y: by, radius: THUNDER_RADIUS, team: ship.team });
    ability(world, ship, 'blink', bx, by, 'sto_thunder');
  }
  if (has(ship, 'voi_riftstep')) {
    const dps = (sk.wellDps ?? 120) * ship.stats.utilityPower * ship.stats.damageMult;
    deployWell(world, { ownerId: ship.id, ownerPlayerId: ship.playerId, team: ship.team }, fromX, fromY, dps, true);
  }
}

function repair(world: World, ship: Ship): void {
  const st = ship.stats, sk = st.skill;
  const r = sk.healRadius ?? 380, r2 = r * r;
  const k = (sk.healFrac ?? 0.25) * st.mobilityPower * st.healMult;
  for (const s of world.ships.values()) {
    if (!s.alive) continue;
    if (s.id !== ship.id) {
      if (!sameTeam(s.team, ship.team)) continue;
      const dx = s.x - ship.x, dy = s.y - ship.y;
      if (dx * dx + dy * dy > r2 && s.attachedTo !== ship.id) continue;
    }
    healShip(world, s, k * s.stats.maxEnergy, ship.id);
  }
  ship.skillState.boostUntil = world.tick + secToTicks(REPAIR_BOOST_SEC);
  if (has(ship, 'med_nanites')) deployNanite(world, ship);
}

function useMobility(world: World, ship: Ship): void {
  const st = ship.stats, tick = world.tick;
  if (tick < ship.mobilityReadyTick || ship.energy < st.mobilityCost) return;
  const id = skillId(ship, 'mobility');
  switch (id) {
    case 'ram': startRam(world, ship); break;
    case 'blink': blink(world, ship); break;
    case 'repair': repair(world, ship); break;
    default: return;
  }
  ship.energy -= st.mobilityCost;
  const cd = Math.max(1, secToTicks(st.mobilityCooldown));
  ship.mobilityReadyTick = tick + cd;
  ship.skillState[SPACE_CD_TICKS] = cd; // v0.5: the HUD's Space sweep (room/snapshot.ts spaceCooldownSec)
  ability(world, ship, id);
}

// ---------------------------------------------------------------------------------------------
// Utility (rising edge)
// ---------------------------------------------------------------------------------------------

function ironHide(world: World, ship: Ship): void {
  const sk = ship.stats.skill;
  const time = sk.hideTime ?? 3, absorb = sk.hideAbsorb ?? 0.6;
  const until = world.tick + Math.max(1, secToTicks(time));
  ship.utilityActiveUntilTick = until;
  ship.skillState.hide = 1;
  if (has(ship, 'bul_fortress')) {
    const r2 = FORTRESS_RADIUS * FORTRESS_RADIUS;
    for (const s of world.ships.values()) {
      if (!s.alive || s.id === ship.id) continue;
      const mine = s.attachedTo === ship.id;
      const dx = s.x - ship.x, dy = s.y - ship.y;
      if (!mine && !(sameTeam(s.team, ship.team) && dx * dx + dy * dy <= r2)) continue;
      const ss = s.skillState;
      ss.extShieldUntil = Math.max(ss.extShieldUntil ?? 0, until);
      ss.extShieldAbsorb = Math.max((ss.extShieldUntil ?? 0) > world.tick ? (ss.extShieldAbsorb ?? 0) : 0, absorb);
    }
  }
}

/** Returns false (nothing thrown, nothing to pay) when the projectile cap refused the singularity. */
function throwSingularity(world: World, ship: Ship): boolean {
  const st = ship.stats;
  const dps = (st.skill.wellDps ?? 120) * st.utilityPower * st.damageMult;
  const a = ship.input.aim, cx = Math.cos(a), cy = Math.sin(a);
  const dist = Math.max(SINGULARITY_SPEED * DT, Math.min(SINGULARITY_MAX_DIST, aimDistOf(ship) - st.radius - 8));
  return spawnProjectile(world, {
    ...projectileDefaults(world), kind: 'singularity', ownerId: ship.id, ownerPlayerId: ship.playerId, ownerTeam: ship.team,
    x: ship.x + cx * (st.radius + 8), y: ship.y + cy * (st.radius + 8),
    vx: cx * SINGULARITY_SPEED, vy: cy * SINGULARITY_SPEED, damage: dps, radius: 10,
    expireTick: world.tick + Math.max(1, Math.round((dist / SINGULARITY_SPEED) * 60)),
  }) !== null;
}

function useUtility(world: World, ship: Ship): void {
  const st = ship.stats, tick = world.tick;
  if (tick < ship.utilityReadyTick || ship.energy < st.utilityCost) return;
  const id = skillId(ship, 'utility');
  switch (id) {
    case 'ironhide': ironHide(world, ship); break;
    case 'singularity': if (!throwSingularity(world, ship)) return; break;
    case 'wall': if (!deployWall(world, ship)) return; break;
    default: return;
  }
  ship.energy -= st.utilityCost;
  ship.utilityReadyTick = tick + Math.max(1, secToTicks(st.utilityCooldown));
  ability(world, ship, id);
}

/**
 * All class skills for one alive, non-turret ship (after movement). v0.5: while the ship hosts ≥ 1 turret (capital
 * form) Space fires its capital skill instead (capital.ts: its own capCost / capCooldown knobs, on the Space slot's
 * mobilityReadyTick).
 */
export function stepClassSkills(world: World, ship: Ship): void {
  const inp = ship.input, prev = ship.prevInput;
  if (inp.primary) firePrimary(world, ship);
  if (inp.secondary) useSecondary(world, ship);
  if (inp.mobility && !prev.mobility) {
    if (isCapital(ship)) useCapital(world, ship);
    else useMobility(world, ship);
  }
  if (inp.utility && !prev.utility) useUtility(world, ship);
}

/** Repair Pulse speed boost multiplier (1 when inactive). */
export function boostMult(world: World, ship: Ship): number {
  return (ship.skillState.boostUntil ?? 0) > world.tick ? REPAIR_BOOST_MULT : 1;
}

export { angleDiff, isHostileShip };
