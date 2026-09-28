// OWNER: PVE agent. Auto-firing weapons for every alive ship (turrets included). Timers live in ship.autoState.
import { ORBIT_RADIUS, ORBIT_SPEED, TICK_RATE } from '../../constants';
import { SHIP_CLASSES } from '../../data/ships';
import type { Enemy, EntityId, Ship, World } from '../../types';
import { damageEnemy, damageShip, splashDamage } from '../combat';
import { canDamageShip, emit, projectileDefaults, secToTicks, spawnProjectile } from '../world';
import { queryEnemies, queryShips } from './query';
import { AUTO } from './upgrades';

const enemyBuf: Enemy[] = [];
const shipBuf: Ship[] = [];
const visited: EntityId[] = [];

/**
 * Per-attacker Orbit Blades hit-cooldown key (stored in the victim's mem/autoState). Built inline:
 * a module-level cache would be shared by every Sim in the process and never pruned.
 */
function orbitKey(shipId: EntityId): string {
  return 'ob' + shipId;
}

function hostile(world: World, me: Ship, s: Ship): boolean {
  return s !== me && s.alive && canDamageShip(world, me.team, me.id, s.team, s.id);
}

function outMult(ship: Ship): number {
  return ship.stats.damageMult * (ship.attachedTo ? SHIP_CLASSES[ship.shipClass].turretDamageMult : 1);
}

/** Nearest target (enemies preferred) within range of (x,y), skipping `visited`. */
function nearestTarget(
  world: World, me: Ship, x: number, y: number, range: number, skip: EntityId[] | null,
): Enemy | Ship | null {
  let best: Enemy | null = null, bestD = range * range;
  queryEnemies(world, x, y, range, enemyBuf);
  for (let i = 0; i < enemyBuf.length; i++) {
    const e = enemyBuf[i];
    if (skip && skip.includes(e.id)) continue;
    const dx = e.x - x, dy = e.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best) return best;
  let bs: Ship | null = null; bestD = range * range;
  queryShips(world, x, y, range, shipBuf);
  for (let i = 0; i < shipBuf.length; i++) {
    const s = shipBuf[i];
    if (!hostile(world, me, s) || (skip && skip.includes(s.id))) continue;
    const dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; bs = s; }
  }
  return bs;
}

function isEnemy(t: Enemy | Ship): t is Enemy {
  return (t as Enemy).kind !== undefined;
}

function hit(world: World, me: Ship, t: Enemy | Ship, dmg: number): void {
  if (isEnemy(t)) damageEnemy(world, t, dmg, me.id);
  else damageShip(world, t, dmg, me.id, 'player');
}

function stepOrbit(world: World, s: Ship, lv: number, mult: number): void {
  const n = AUTO.orbit.blades(lv);
  const br = AUTO.orbit.bladeRadius;
  const base = (ORBIT_SPEED * world.tick) / TICK_RATE;
  const dmg = AUTO.orbit.damage(lv) * mult;
  const cd = secToTicks(AUTO.orbit.hitCooldownSec);
  const key = orbitKey(s.id);
  const reach = ORBIT_RADIUS + br;
  const tick = world.tick;

  queryEnemies(world, s.x, s.y, reach, enemyBuf);
  for (let i = 0; i < enemyBuf.length; i++) {
    const e = enemyBuf[i];
    if ((e.mem[key] ?? 0) > tick) continue;
    for (let b = 0; b < n; b++) {
      const a = base + (b * Math.PI * 2) / n;
      const bx = s.x + Math.cos(a) * ORBIT_RADIUS, by = s.y + Math.sin(a) * ORBIT_RADIUS;
      const dx = e.x - bx, dy = e.y - by, rr = e.radius + br;
      if (dx * dx + dy * dy <= rr * rr) {
        e.mem[key] = tick + cd;
        damageEnemy(world, e, dmg, s.id);
        break;
      }
    }
  }
  queryShips(world, s.x, s.y, reach, shipBuf);
  for (let i = 0; i < shipBuf.length; i++) {
    const o = shipBuf[i];
    if (!hostile(world, s, o) || (o.autoState[key] ?? 0) > tick) continue;
    for (let b = 0; b < n; b++) {
      const a = base + (b * Math.PI * 2) / n;
      const bx = s.x + Math.cos(a) * ORBIT_RADIUS, by = s.y + Math.sin(a) * ORBIT_RADIUS;
      const dx = o.x - bx, dy = o.y - by, rr = o.stats.radius + br;
      if (dx * dx + dy * dy <= rr * rr) {
        o.autoState[key] = tick + cd;
        damageShip(world, o, dmg, s.id, 'player');
        break;
      }
    }
  }
}

function stepSeeker(world: World, s: Ship, lv: number, mult: number): void {
  if (world.tick < (s.autoState.seekerT ?? 0)) return;
  const cfg = AUTO.seeker;
  const t = nearestTarget(world, s, s.x, s.y, cfg.range, null);
  if (!t) { s.autoState.seekerT = world.tick + 10; return; }
  s.autoState.seekerT = world.tick + secToTicks(cfg.cooldown(lv));
  const n = cfg.count(lv);
  const aim = Math.atan2(t.y - s.y, t.x - s.x);
  for (let i = 0; i < n; i++) {
    const a = aim + (n === 1 ? 0 : (i / (n - 1) - 0.5) * 1.2);
    const p = spawnProjectile(world, {
      ...projectileDefaults(world),
      kind: 'seeker', ownerId: s.id, ownerPlayerId: s.playerId, ownerTeam: s.team,
      x: s.x + Math.cos(a) * (s.stats.radius + 6), y: s.y + Math.sin(a) * (s.stats.radius + 6),
      vx: Math.cos(a) * cfg.speed + s.vx * 0.3, vy: Math.sin(a) * cfg.speed + s.vy * 0.3,
      damage: cfg.damage(lv) * mult, radius: 6, splash: cfg.splash,
      level: Math.min(3, Math.ceil(lv / 2)),
      expireTick: world.tick + secToTicks(2.6), homingRange: cfg.range, homingTurn: 5,
    });
    if (!p) break;
  }
}

function stepNova(world: World, s: Ship, lv: number, mult: number): void {
  if (world.tick < (s.autoState.novaT ?? 0)) return;
  const r = AUTO.nova.radius(lv);
  const t = nearestTarget(world, s, s.x, s.y, r, null);
  if (!t) { s.autoState.novaT = world.tick + 10; return; }
  s.autoState.novaT = world.tick + secToTicks(AUTO.nova.cooldown(lv));
  emit(world, { t: 'nova', x: s.x, y: s.y, radius: r, team: s.team });
  splashDamage(world, s.x, s.y, r, AUTO.nova.damage(lv) * mult, s.team, s.id);
}

function stepArc(world: World, s: Ship, lv: number, mult: number): void {
  if (world.tick < (s.autoState.arcT ?? 0)) return;
  const cfg = AUTO.arc;
  visited.length = 0;
  let x = s.x, y = s.y;
  const hops = cfg.hops(lv);
  const dmg = cfg.damage(lv) * mult;
  let points: number[] | null = null;
  for (let h = 0; h < hops; h++) {
    const t = nearestTarget(world, s, x, y, cfg.hopRange, visited);
    if (!t) break;
    if (!points) points = [s.x, s.y];
    visited.push(t.id);
    const tx = t.x, ty = t.y;
    points.push(tx, ty);
    hit(world, s, t, dmg);
    x = tx; y = ty;
  }
  if (!points) { s.autoState.arcT = world.tick + 10; return; }
  s.autoState.arcT = world.tick + secToTicks(cfg.cooldown(lv));
  emit(world, { t: 'arc', points, team: s.team });
}

function stepMineTrail(world: World, s: Ship, lv: number, mult: number): void {
  if (world.tick < (s.autoState.mineT ?? 0)) return;
  const cfg = AUTO.minetrail;
  const sp2 = s.vx * s.vx + s.vy * s.vy;
  if (sp2 < cfg.minSpeed * cfg.minSpeed) return;
  s.autoState.mineT = world.tick + secToTicks(cfg.cooldown(lv));
  const sp = Math.sqrt(sp2);
  const back = s.stats.radius + 10;
  spawnProjectile(world, {
    ...projectileDefaults(world),
    kind: 'mine', ownerId: s.id, ownerPlayerId: s.playerId, ownerTeam: s.team,
    x: s.x - (s.vx / sp) * back, y: s.y - (s.vy / sp) * back, vx: 0, vy: 0,
    damage: cfg.damage(lv) * mult, radius: 8, splash: cfg.splash(lv), level: 1,
    armTick: world.tick + secToTicks(0.5), expireTick: world.tick + secToTicks(cfg.lifeSec),
    // marker so the SIM can exclude trail mines from the ship's mineMax count
    pierce: TRAIL_MINE_MARK,
  });
}

/** Trail mines carry this `pierce` value so the SIM can tell them apart from hand-laid mines. */
export const TRAIL_MINE_MARK = 99;

export function stepAutoWeapons(world: World): void {
  for (const s of world.ships.values()) {
    if (!s.alive) continue;
    const u = s.upgrades;
    const orbit = u.orbit ?? 0, seeker = u.seeker ?? 0, nova = u.nova ?? 0, arc = u.arc ?? 0, trail = u.minetrail ?? 0;
    if (!(orbit || seeker || nova || arc || trail)) continue;
    const mult = outMult(s);
    if (orbit) stepOrbit(world, s, orbit, mult);
    if (!s.alive) continue;
    if (seeker) stepSeeker(world, s, seeker, mult);
    if (nova) stepNova(world, s, nova, mult);
    if (arc) stepArc(world, s, arc, mult);
    if (trail) stepMineTrail(world, s, trail, mult);
  }
}
