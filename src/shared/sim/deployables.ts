// OWNER: SIM agent. Deployables: sentry, wall, well, drone, fire, nanite — spawn, update, death.
import { DT, ENEMY_TEAM } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import type { Deployable, DeployableKind, EntityId, PlayerId, Ship, TeamId, World } from '../types';
import { segPointDist2 } from '../util/math';
import { damageEnemy, damageShip, flatAreaDamage, healShip, splashDamage } from './combat';
import { isSolidAt } from './map';
import { found, has, isHostileShip, nearestHostile } from './targeting';
import {
  canDamageEnemy, countDeployables, emit, projectileDefaults, sameTeam, secToTicks, spawnDeployable, spawnProjectile,
} from './world';

// Tuning knobs
export const SENTRY_RADIUS = 14;
export const SENTRY_SEEKER_SPEED = 620;
export const SENTRY_SEEKER_LIFE = 1.6;
export const WALL_HALF_THICKNESS = 8;
/** Shield Wall is centered min(aimDist, WALL_MAX_AHEAD) ahead of the ship. */
export const WALL_MAX_AHEAD = 160;
export const WALL_MIN_AHEAD = 40;
export const DRONE_COUNT = 2;
export const DRONE_HP = 400;
export const DRONE_RADIUS = 10;
export const DRONE_ORBIT = 56;
export const DRONE_DAMAGE = 60;
export const DRONE_FIRE_CD = 0.5;
export const DRONE_RANGE = 450;
export const DRONE_RESPAWN_SEC = 5;
export const FIRE_RADIUS = 60;
export const FIRE_DPS = 80;
export const FIRE_LIFE = 2;
export const NANITE_RADIUS = 180;
export const NANITE_HPS = 80;
export const NANITE_LIFE = 4;
export const TESLA_RANGE = 60;
export const TESLA_DPS = 100;
export const WELL_CORE_FRAC = 0.4;
export const COLLAPSE_DAMAGE = 500;
export const COLLAPSE_RADIUS = 200;
export const SALVAGE_DAMAGE = 300;
export const SALVAGE_RADIUS = 160;
export const SALVAGE_REFUND = 0.3;
export const MINEFIELD_MINES = 4;
export const MINEFIELD_DAMAGE = 350;
export const MINEFIELD_SPLASH = 90;
/** Damage-over-time zones (fire, well core, tesla) and nanite heals apply every N ticks. */
export const DOT_TICKS = 10;

interface OwnerInfo { ownerId: EntityId; ownerPlayerId: PlayerId; team: TeamId }

function base(world: World, o: OwnerInfo, kind: DeployableKind, x: number, y: number, lifeSec: number): Omit<Deployable, 'id'> {
  return {
    kind, ownerId: o.ownerId, ownerPlayerId: o.ownerPlayerId, team: o.team, x, y, vx: 0, vy: 0, angle: 0,
    hp: 1, maxHp: 1, radius: 10, length: 0, spawnTick: world.tick, expireTick: world.tick + Math.max(1, secToTicks(lifeSec)),
    power: 0, mem: {},
  };
}
const ownerOfShip = (s: Ship): OwnerInfo => ({ ownerId: s.id, ownerPlayerId: s.playerId, team: s.team });

// ---------------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------------

export function deploySentry(world: World, ship: Ship): Deployable | null {
  const sk = ship.stats.skill;
  const max = Math.max(1, Math.round(sk.sentryMax ?? 2));
  // replace oldest beyond the cap
  while (countDeployables(world, ship.id, 'sentry') >= max) {
    let oldest: Deployable | null = null;
    for (const d of world.deployables.values()) {
      if (d.ownerId === ship.id && d.kind === 'sentry' && (!oldest || d.spawnTick < oldest.spawnTick)) oldest = d;
    }
    if (!oldest) break;
    killDeployable(world, oldest);
  }
  const b = base(world, ownerOfShip(ship), 'sentry', ship.x, ship.y, sk.sentryLife ?? 15);
  const hp = (sk.sentryHp ?? 600) * ship.stats.secondaryPower;
  b.hp = b.maxHp = hp;
  b.radius = SENTRY_RADIUS;
  b.angle = ship.angle;
  b.power = (sk.sentryDamage ?? 90) * ship.stats.secondaryPower * ship.stats.damageMult;
  b.mem.fireCd = Math.max(1, secToTicks(sk.sentryFireCd ?? 1.2));
  b.mem.nextFire = world.tick + 20;
  b.mem.range = sk.sentryRange ?? 550;
  b.mem.volley = has(ship, 'sum_overclock') ? 2 : 1;
  if (has(ship, 'sum_salvage')) {
    b.mem.salvage = SALVAGE_DAMAGE * ship.stats.damageMult;
    b.mem.refund = SALVAGE_REFUND * ship.stats.secondaryCost;
  }
  return spawnDeployable(world, b);
}

export function deployWall(world: World, ship: Ship): Deployable | null {
  const sk = ship.stats.skill;
  const aim = ship.input.aim;
  const dx = Math.cos(aim), dy = Math.sin(aim);
  const ad = Number.isFinite(ship.input.aimDist) ? ship.input.aimDist : 300;
  let dist = Math.max(WALL_MIN_AHEAD, Math.min(WALL_MAX_AHEAD, ad));
  let x = ship.x + dx * dist, y = ship.y + dy * dist;
  while (dist > 0 && isSolidAt(world.map, x, y)) { dist -= 16; x = ship.x + dx * dist; y = ship.y + dy * dist; }
  const b = base(world, ownerOfShip(ship), 'wall', x, y, sk.wallLife ?? 6);
  b.hp = b.maxHp = (sk.wallHp ?? 1500) * ship.stats.utilityPower;
  b.angle = aim + Math.PI / 2;
  b.length = sk.wallLength ?? 220;
  b.radius = WALL_HALF_THICKNESS;
  if (has(ship, 'arc_tesla')) b.mem.tesla = TESLA_DPS * ship.stats.damageMult;
  if (has(ship, 'arc_reinforced')) b.mem.reflect = 1;
  const wall = spawnDeployable(world, b);
  if (wall && has(ship, 'arc_minefield')) {
    const ux = Math.cos(b.angle), uy = Math.sin(b.angle);
    for (let i = 0; i < MINEFIELD_MINES; i++) {
      const t = ((i + 0.5) / MINEFIELD_MINES - 0.5) * b.length;
      const mx = x + ux * t + dx * 26, my = y + uy * t + dy * 26;
      if (isSolidAt(world.map, mx, my)) continue;
      spawnProjectile(world, {
        ...projectileDefaults(world), kind: 'mine', ownerId: ship.id, ownerPlayerId: ship.playerId, ownerTeam: ship.team,
        x: mx, y: my, vx: 0, vy: 0, damage: MINEFIELD_DAMAGE * ship.stats.damageMult, radius: 8,
        splash: MINEFIELD_SPLASH, armTick: world.tick + secToTicks(0.5), expireTick: world.tick + secToTicks(30),
      });
    }
  }
  return wall;
}

/** Singularity well at (x,y). `scale` = size/duration scale (Rift Step = 0.5 size, 1.5 s). */
export function deployWell(
  world: World, o: OwnerInfo, x: number, y: number, dps: number, small: boolean,
): Deployable | null {
  const owner = world.ships.get(o.ownerId);
  const sk = owner ? owner.stats.skill : SHIP_CLASSES.tech.base.skill;
  const radius = (sk.wellRadius ?? 280) * (small ? 0.5 : 1);
  const life = small ? 1.5 : (sk.wellDuration ?? 3);
  const b = base(world, o, 'well', x, y, life);
  b.hp = b.maxHp = 1;
  b.radius = radius;
  b.power = dps;
  b.mem.pull = sk.wellPull ?? 900;
  if (owner && has(owner, 'voi_entropy')) b.mem.entropy = 1;
  if (owner && has(owner, 'voi_collapse')) {
    b.mem.collapse = COLLAPSE_DAMAGE * owner.stats.damageMult * (small ? 0.5 : 1);
    b.mem.collapseR = COLLAPSE_RADIUS * (small ? 0.6 : 1);
  }
  return spawnDeployable(world, b);
}

export function deployFire(world: World, o: OwnerInfo, x: number, y: number, damageMult: number): Deployable | null {
  const b = base(world, o, 'fire', x, y, FIRE_LIFE);
  b.radius = FIRE_RADIUS;
  b.power = FIRE_DPS * damageMult;
  return spawnDeployable(world, b);
}

export function deployNanite(world: World, ship: Ship): Deployable | null {
  const b = base(world, ownerOfShip(ship), 'nanite', ship.x, ship.y, NANITE_LIFE);
  b.radius = NANITE_RADIUS;
  b.power = NANITE_HPS * ship.stats.healMult;
  return spawnDeployable(world, b);
}

export function deployDrone(world: World, ship: Ship, slot: number): Deployable | null {
  const b = base(world, ownerOfShip(ship), 'drone', ship.x, ship.y, 1e6);
  b.hp = b.maxHp = DRONE_HP;
  b.radius = DRONE_RADIUS;
  b.power = DRONE_DAMAGE * ship.stats.damageMult;
  b.mem.slot = slot;
  b.mem.nextFire = world.tick + secToTicks(DRONE_FIRE_CD);
  return spawnDeployable(world, b);
}

// ---------------------------------------------------------------------------------------------
// Damage / death
// ---------------------------------------------------------------------------------------------

/** Damage a deployable (walls/sentries/drones take hits from hostile projectiles and PvE contact). */
export function damageDeployable(world: World, d: Deployable, amount: number): void {
  if (!(amount > 0) || world.deployables.get(d.id) !== d) return;
  d.hp -= amount;
  if (d.hp <= 0) killDeployable(world, d);
}

/**
 * Remove a deployable: emits 'deployDeath' and — when `effects` (destroyed, expired or replaced by the
 * sentry cap) — runs death effects (Salvage blast + refund, Collapse nova). Pass effects=false for
 * administrative removal (owner left, switched team or class).
 */
export function killDeployable(world: World, d: Deployable, effects = true): void {
  if (!world.deployables.delete(d.id)) return;
  emit(world, { t: 'deployDeath', id: d.id, kind: d.kind, x: d.x, y: d.y });
  if (!effects) return;
  const m = d.mem;
  if (d.kind === 'sentry' && (m.salvage ?? 0) > 0) {
    splashDamage(world, d.x, d.y, SALVAGE_RADIUS, m.salvage, d.team, d.ownerId);
    emit(world, { t: 'explode', x: d.x, y: d.y, radius: SALVAGE_RADIUS, kind: 'rocket', team: d.team });
    const owner = world.ships.get(d.ownerId);
    if (owner && owner.alive) owner.energy = Math.min(owner.stats.maxEnergy, owner.energy + (m.refund ?? 0));
  } else if (d.kind === 'well' && (m.collapse ?? 0) > 0) {
    const r = m.collapseR ?? COLLAPSE_RADIUS;
    splashDamage(world, d.x, d.y, r, m.collapse, d.team, d.ownerId);
    emit(world, { t: 'nova', x: d.x, y: d.y, radius: r, team: d.team });
  }
}

// ---------------------------------------------------------------------------------------------
// Per-tick update (Sim.step, after pveStep, before projectiles)
// ---------------------------------------------------------------------------------------------

/**
 * DoT / heal-pulse cadence: fires on the deployable's FIRST stepped tick, then every DOT_TICKS.
 * Keyed to the first step rather than spawnTick, so zones spawned after stepDeployables (napalm and
 * singularity wells come from stepProjectiles) get the same pulse count as ones spawned before it.
 */
function dotDue(world: World, d: Deployable): boolean {
  const at = d.mem.dotAt;
  if (at !== undefined && world.tick < at) return false;
  d.mem.dotAt = world.tick + DOT_TICKS;
  return true;
}

function fireSeeker(world: World, d: Deployable, a: number, speed: number, dmg: number, homing: number, life: number): void {
  spawnProjectile(world, {
    ...projectileDefaults(world), kind: 'seeker', ownerId: d.ownerId, ownerPlayerId: d.ownerPlayerId, ownerTeam: d.team,
    x: d.x + Math.cos(a) * (d.radius + 4), y: d.y + Math.sin(a) * (d.radius + 4),
    vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, damage: dmg, radius: 4,
    expireTick: world.tick + secToTicks(life), homingRange: homing, homingTurn: 5,
  });
}

function stepSentry(world: World, d: Deployable): void {
  const tick = world.tick;
  const range = d.mem.range ?? 550;
  if (tick < (d.mem.nextFire ?? 0)) return;
  if (!nearestHostile(world, d.team, d.ownerId, d.x, d.y, range, d.x, d.y, true)) { d.mem.nextFire = tick + 6; return; }
  d.angle = Math.atan2(found.y - d.y, found.x - d.x);
  const n = Math.max(1, d.mem.volley ?? 1);
  for (let i = 0; i < n; i++) {
    const a = d.angle + (n > 1 ? (i / (n - 1) - 0.5) * 0.3 : 0);
    fireSeeker(world, d, a, SENTRY_SEEKER_SPEED, d.power, range, SENTRY_SEEKER_LIFE);
  }
  d.mem.nextFire = tick + (d.mem.fireCd ?? 72);
}

function stepDrone(world: World, d: Deployable): void {
  const owner = world.ships.get(d.ownerId);
  if (!owner || !owner.alive) { killDeployable(world, d); return; }
  const a = world.tick * 0.035 + (d.mem.slot ?? 0) * Math.PI;
  const tx = owner.x + Math.cos(a) * DRONE_ORBIT, ty = owner.y + Math.sin(a) * DRONE_ORBIT;
  const k = Math.min(1, 12 * DT);
  const nx = d.x + (tx - d.x) * k, ny = d.y + (ty - d.y) * k;
  d.vx = (nx - d.x) / DT; d.vy = (ny - d.y) / DT;
  d.x = nx; d.y = ny;
  if (world.tick < (d.mem.nextFire ?? 0)) return;
  if (!nearestHostile(world, d.team, d.ownerId, d.x, d.y, DRONE_RANGE, d.x, d.y, true)) { d.mem.nextFire = world.tick + 6; return; }
  d.angle = Math.atan2(found.y - d.y, found.x - d.x);
  spawnProjectile(world, {
    ...projectileDefaults(world), kind: 'bullet', ownerId: d.ownerId, ownerPlayerId: d.ownerPlayerId, ownerTeam: d.team,
    x: d.x, y: d.y, vx: Math.cos(d.angle) * 900, vy: Math.sin(d.angle) * 900, damage: d.power, radius: 3,
    expireTick: world.tick + secToTicks(0.6),
  });
  d.mem.nextFire = world.tick + secToTicks(DRONE_FIRE_CD);
}

function stepWell(world: World, d: Deployable): void {
  const tick = world.tick, r = d.radius, r2 = r * r, pull = d.mem.pull ?? 900;
  const entropy = (d.mem.entropy ?? 0) > 0;
  const core = r * WELL_CORE_FRAC, core2 = core * core;
  const dot = dotDue(world, d);
  const dotAmt = d.power * DOT_TICKS * DT;
  // enemies
  if (canDamageEnemy(d.team)) {
    const g = world.grid, pad = r + 96;
    const cx0 = Math.max(0, Math.floor((d.x - pad) / g.cell)), cx1 = Math.min(g.cols - 1, Math.floor((d.x + pad) / g.cell));
    const cy0 = Math.max(0, Math.floor((d.y - pad) / g.cell)), cy1 = Math.min(g.rows - 1, Math.floor((d.y + pad) / g.cell));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const cell = g.enemies[cy * g.cols + cx];
      for (let i = 0; i < cell.length; i++) {
        const e = world.enemies.get(cell[i]);
        if (!e || e.hp <= 0 || e.kind === 'hive') continue;
        const dx = d.x - e.x, dy = d.y - e.y, dd = dx * dx + dy * dy;
        if (dd > r2) continue;
        const dist = Math.sqrt(dd) || 1;
        const f = 0.3 + 0.7 * (1 - dist / r);
        e.vx += (dx / dist) * pull * DT; e.vy += (dy / dist) * pull * DT;
        const step = Math.min(dist, pull * 0.25 * f * DT);
        e.x += (dx / dist) * step; e.y += (dy / dist) * step;
        if (entropy) e.mem.entropyTick = tick;
        if (dot && dd <= core2) damageEnemyFromDeploy(world, e.id, dotAmt, d.ownerId);
      }
    }
  }
  // hostile ships
  for (const s of world.ships.values()) {
    if (!isHostileShip(world, d.team, d.ownerId, s)) continue;
    const dx = d.x - s.x, dy = d.y - s.y, dd = dx * dx + dy * dy;
    if (dd > r2) continue;
    const dist = Math.sqrt(dd) || 1;
    if (!s.attachedTo) { s.vx += (dx / dist) * pull * DT; s.vy += (dy / dist) * pull * DT; }
    if (entropy) s.skillState.entropyTick = tick;
    if (dot && dd <= core2) shipDotDamage(world, s, dotAmt, d);
  }
}

function damageEnemyFromDeploy(world: World, id: EntityId, amt: number, ownerId: EntityId): void {
  const e = world.enemies.get(id);
  if (e) damageEnemy(world, e, amt, ownerId);
}
function shipDotDamage(world: World, s: Ship, amt: number, d: Deployable): void {
  const enemy = d.team === ENEMY_TEAM;
  damageShip(world, s, amt, enemy ? 0 : d.ownerId, enemy ? 'enemy' : 'player');
}

function stepTesla(world: World, d: Deployable): void {
  if (!dotDue(world, d)) return;
  const amt = (d.mem.tesla ?? 0) * DOT_TICKS * DT;
  const hx = Math.cos(d.angle) * d.length * 0.5, hy = Math.sin(d.angle) * d.length * 0.5;
  const ax = d.x - hx, ay = d.y - hy, bx = d.x + hx, by = d.y + hy;
  const reach = d.length * 0.5 + TESLA_RANGE;
  const pts: number[] = [];
  if (canDamageEnemy(d.team)) {
    const g = world.grid, pad = reach + 96;
    const cx0 = Math.max(0, Math.floor((d.x - pad) / g.cell)), cx1 = Math.min(g.cols - 1, Math.floor((d.x + pad) / g.cell));
    const cy0 = Math.max(0, Math.floor((d.y - pad) / g.cell)), cy1 = Math.min(g.rows - 1, Math.floor((d.y + pad) / g.cell));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const cell = g.enemies[cy * g.cols + cx];
      for (let i = 0; i < cell.length; i++) {
        const e = world.enemies.get(cell[i]);
        if (!e || e.hp <= 0) continue;
        const rr = TESLA_RANGE + e.radius;
        if (segPointDist2(ax, ay, bx, by, e.x, e.y) > rr * rr) continue;
        if (pts.length < 16) pts.push(d.x, d.y, e.x, e.y);
        damageEnemy(world, e, amt, d.ownerId);
      }
    }
  }
  for (const s of world.ships.values()) {
    if (!isHostileShip(world, d.team, d.ownerId, s)) continue;
    const rr = TESLA_RANGE + s.stats.radius;
    if (segPointDist2(ax, ay, bx, by, s.x, s.y) > rr * rr) continue;
    if (pts.length < 16) pts.push(d.x, d.y, s.x, s.y);
    shipDotDamage(world, s, amt, d);
  }
  if (pts.length) emit(world, { t: 'arc', points: pts, team: d.team });
}

function stepNanite(world: World, d: Deployable): void {
  if (!dotDue(world, d)) return;
  const amt = d.power * DOT_TICKS * DT;
  for (const s of world.ships.values()) {
    if (!s.alive || !(s.id === d.ownerId || sameTeam(s.team, d.team))) continue;
    const dx = s.x - d.x, dy = s.y - d.y, rr = d.radius + s.stats.radius;
    if (dx * dx + dy * dy <= rr * rr) healShip(world, s, amt, d.ownerId);
  }
}

export function stepDeployables(world: World): void {
  const tick = world.tick;
  for (const d of world.deployables.values()) {
    if (world.deployables.get(d.id) !== d) continue;
    // expiry, or hp ≤ 0 (PVE contact damage subtracts hp from walls/sentries/drones directly)
    if (tick >= d.expireTick || ((d.kind === 'wall' || d.kind === 'sentry' || d.kind === 'drone') && d.hp <= 0)) {
      killDeployable(world, d);
      continue;
    }
    switch (d.kind) {
      case 'sentry': stepSentry(world, d); break;
      case 'drone': stepDrone(world, d); break;
      case 'well': stepWell(world, d); break;
      case 'wall': if ((d.mem.tesla ?? 0) > 0) stepTesla(world, d); break;
      case 'fire':
        if (dotDue(world, d)) flatAreaDamage(world, d.x, d.y, d.radius, d.power * DOT_TICKS * DT, d.team, d.ownerId);
        break;
      case 'nanite': stepNanite(world, d); break;
    }
  }
}
