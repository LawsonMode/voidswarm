// OWNER: SIM agent. Projectile system: movement, homing, walls, deployable blocking, swept hits,
// mines, singularity → well, rocket talents (cluster/napalm), plasma talents (forked/sniper), expiry.
import { DT, ENEMY_TEAM } from '../constants';
import type { Deployable, Enemy, Projectile, Ship, World } from '../types';
import { segPointDist2 } from '../util/math';
import { damageEnemy, damageShip, splashDamage } from './combat';
import { damageDeployable, deployFire, deployWell } from './deployables';
import { isSolidAt } from './map';
import { side } from './state';
import { firstHitOnSegment, found, has, hostileTo, isHostileShip, nearestHostile } from './targeting';
import { canDamageEnemy, emit, projectileDefaults, secToTicks, spawnProjectile } from './world';

// Tuning knobs
export const MINE_TRIGGER_RADIUS = 40;
export const CLUSTER_BOMBLETS = 3;
export const CLUSTER_DAMAGE = 0.4;
export const CLUSTER_SPLASH = 0.6;
export const CLUSTER_SPEED = 280;
export const CLUSTER_LIFE = 0.35;
export const FORK_RANGE = 140;
export const FORK_DAMAGE = 0.6;
export const SNIPER_PER_PX = 0.01 / 20;
export const SNIPER_MAX = 0.6;
/** Safety cap on bodies one projectile can hit within a single step (piercing through a dense clump). */
export const MAX_HITS_PER_STEP = 16;

const detonatesOnContact = (p: Projectile) =>
  p.kind === 'bomb' || p.kind === 'rocket' || (p.kind === 'shrapnel' && p.splash > 0);

function ownerShip(world: World, p: Projectile): Ship | undefined {
  return p.ownerTeam === ENEMY_TEAM ? undefined : world.ships.get(p.ownerId);
}

/** Remove + (if splash) blast. Rockets trigger Cluster Rockets / Napalm from their owner's talents. */
function detonate(world: World, p: Projectile): void {
  world.projectiles.delete(p.id);
  side(world).pierceMem.delete(p.id);
  const src = p.ownerTeam === ENEMY_TEAM ? 0 : p.ownerId;
  if (p.splash > 0) {
    splashDamage(world, p.x, p.y, p.splash, p.damage, p.ownerTeam, src);
    emit(world, { t: 'explode', x: p.x, y: p.y, radius: p.splash, kind: p.kind, team: p.ownerTeam });
  } else {
    emit(world, { t: 'explode', x: p.x, y: p.y, radius: 0, kind: p.kind, team: p.ownerTeam });
  }
  if (p.kind === 'rocket') {
    const o = ownerShip(world, p);
    if (!o || o.shipClass !== 'brute') return;
    if (has(o, 'bar_cluster')) {
      const rot = world.rng.next() * Math.PI * 2;
      for (let i = 0; i < CLUSTER_BOMBLETS; i++) {
        const a = rot + (i * Math.PI * 2) / CLUSTER_BOMBLETS;
        spawnProjectile(world, {
          ...projectileDefaults(world), kind: 'shrapnel', ownerId: p.ownerId, ownerPlayerId: p.ownerPlayerId, ownerTeam: p.ownerTeam,
          x: p.x, y: p.y, vx: Math.cos(a) * CLUSTER_SPEED, vy: Math.sin(a) * CLUSTER_SPEED,
          damage: p.damage * CLUSTER_DAMAGE, radius: 3, splash: Math.max(20, p.splash * CLUSTER_SPLASH),
          expireTick: world.tick + secToTicks(CLUSTER_LIFE), level: p.level,
        });
      }
    }
    if (has(o, 'bar_napalm') && !isSolidAt(world.map, p.x, p.y)) {
      deployFire(world, { ownerId: o.id, ownerPlayerId: o.playerId, team: o.team }, p.x, p.y, o.stats.damageMult);
    }
  }
}

function toWell(world: World, p: Projectile): void {
  world.projectiles.delete(p.id);
  deployWell(world, { ownerId: p.ownerId, ownerPlayerId: p.ownerPlayerId, team: p.ownerTeam }, p.x, p.y, p.damage, false);
}

function mineTriggered(world: World, p: Projectile): boolean {
  const r = MINE_TRIGGER_RADIUS;
  const g = world.grid, pad = r + 128;
  const cx0 = Math.max(0, Math.floor((p.x - pad) / g.cell)), cx1 = Math.min(g.cols - 1, Math.floor((p.x + pad) / g.cell));
  const cy0 = Math.max(0, Math.floor((p.y - pad) / g.cell)), cy1 = Math.min(g.rows - 1, Math.floor((p.y + pad) / g.cell));
  const enemiesToo = canDamageEnemy(p.ownerTeam);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * g.cols + cx;
      for (const id of g.ships[ci]) {
        const s = world.ships.get(id);
        if (!s || !isHostileShip(world, p.ownerTeam, p.ownerId, s)) continue;
        const rr = r + s.stats.radius, dx = s.x - p.x, dy = s.y - p.y;
        if (dx * dx + dy * dy <= rr * rr) return true;
      }
      if (!enemiesToo) continue;
      for (const id of g.enemies[ci]) {
        const e = world.enemies.get(id);
        if (!e) continue;
        const rr = r + e.radius, dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy <= rr * rr) return true;
      }
    }
  }
  return false;
}

function steer(world: World, p: Projectile): void {
  if (!nearestHostile(world, p.ownerTeam, p.ownerId, p.x, p.y, p.homingRange, p.x, p.y, false)) return;
  const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (sp < 1e-6) return;
  const cur = Math.atan2(p.vy, p.vx);
  let d = Math.atan2(found.y - p.y, found.x - p.x) - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const maxT = p.homingTurn * DT;
  const a = cur + (d > maxT ? maxT : d < -maxT ? -maxT : d);
  p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
}

/** Blocker bboxes are padded by this so a single-cell lookup at the projectile's step midpoint is enough. */
const BLOCK_PAD = 48;

function buildBlockers(world: World): number {
  const sd = side(world), g = world.grid;
  for (const ci of sd.blockerUsed) sd.blockerCells[ci].length = 0;
  sd.blockerUsed.length = 0;
  let n = 0;
  for (const d of world.deployables.values()) {
    if (d.kind !== 'wall' && d.kind !== 'sentry' && d.kind !== 'drone') continue;
    let b = sd.blockers[n];
    if (!b) { b = { d, wall: false, ax: 0, ay: 0, bx: 0, by: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 }; sd.blockers[n] = b; }
    b.d = d;
    b.wall = d.kind === 'wall';
    if (b.wall) {
      const hx = Math.cos(d.angle) * d.length * 0.5, hy = Math.sin(d.angle) * d.length * 0.5;
      b.ax = d.x - hx; b.ay = d.y - hy; b.bx = d.x + hx; b.by = d.y + hy;
    } else { b.ax = b.bx = d.x; b.ay = b.by = d.y; }
    const pad = d.radius + BLOCK_PAD;
    b.minX = Math.min(b.ax, b.bx) - pad; b.maxX = Math.max(b.ax, b.bx) + pad;
    b.minY = Math.min(b.ay, b.by) - pad; b.maxY = Math.max(b.ay, b.by) + pad;
    const cx0 = Math.max(0, Math.floor(b.minX / g.cell)), cx1 = Math.min(g.cols - 1, Math.floor(b.maxX / g.cell));
    const cy0 = Math.max(0, Math.floor(b.minY / g.cell)), cy1 = Math.min(g.rows - 1, Math.floor(b.maxY / g.cell));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * g.cols + cx, cell = sd.blockerCells[ci];
      if (cell.length === 0) sd.blockerUsed.push(ci);
      cell.push(n);
    }
    n++;
  }
  sd.blockerCount = n;
  return n;
}

/** First hostile blocker touched by the projectile's step, or null. */
function hitBlocker(world: World, p: Projectile, x0: number, y0: number, x1: number, y1: number): Deployable | null {
  const sd = side(world), g = world.grid;
  const mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5;
  let cx = Math.floor(mx / g.cell), cy = Math.floor(my / g.cell);
  if (cx < 0) cx = 0; else if (cx >= g.cols) cx = g.cols - 1;
  if (cy < 0) cy = 0; else if (cy >= g.rows) cy = g.rows - 1;
  const cell = sd.blockerCells[cy * g.cols + cx];
  for (let i = 0; i < cell.length; i++) {
    const b = sd.blockers[cell[i]];
    if (mx < b.minX || mx > b.maxX || my < b.minY || my > b.maxY) continue;
    const d = b.d;
    if (world.deployables.get(d.id) !== d) continue;
    if (!hostileTo(p.ownerTeam, p.ownerId, d.team, d.ownerId)) continue;
    const rr = d.radius + p.radius;
    if (b.wall) {
      if (segPointDist2(b.ax, b.ay, b.bx, b.by, x1, y1) <= rr * rr || segPointDist2(b.ax, b.ay, b.bx, b.by, mx, my) <= rr * rr) return d;
    } else if (segPointDist2(x0, y0, x1, y1, d.x, d.y) <= rr * rr) return d;
  }
  return null;
}

/** Reinforced wall: reflect across the wall line and hand the projectile to the wall's owner. */
function reflectOff(p: Projectile, d: Deployable, x0: number, y0: number): void {
  const nx = -Math.sin(d.angle), ny = Math.cos(d.angle);
  const vn = p.vx * nx + p.vy * ny;
  p.vx -= 2 * vn * nx; p.vy -= 2 * vn * ny;
  p.ownerId = d.ownerId; p.ownerPlayerId = d.ownerPlayerId; p.ownerTeam = d.team;
  p.x = x0; p.y = y0;
}

const forkEx = new Set<number>();
/** Direct hit on a body (bullets/plasma/shrapnel/seekers/enemyShot). */
function directHit(world: World, p: Projectile, e: Enemy | null, s: Ship | null): void {
  const src = p.ownerTeam === ENEMY_TEAM ? 0 : p.ownerId;
  let dmg = p.damage;
  const o = p.kind === 'plasma' ? ownerShip(world, p) : undefined;
  if (o && o.shipClass === 'tech' && has(o, 'lan_sniper')) {
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const travelled = sp * (world.tick - p.spawnTick) * DT;
    dmg *= 1 + Math.min(SNIPER_MAX, travelled * SNIPER_PER_PX);
  }
  const hx = e ? e.x : s ? s.x : p.x, hy = e ? e.y : s ? s.y : p.y;
  const hitId = e ? e.id : s ? s.id : 0;
  if (e) damageEnemy(world, e, dmg, src);
  else if (s) damageShip(world, s, dmg, src, src ? 'player' : 'enemy');
  if (o && o.shipClass === 'tech' && has(o, 'sto_forked')) {
    forkEx.clear(); forkEx.add(hitId);
    if (nearestHostile(world, p.ownerTeam, p.ownerId, hx, hy, FORK_RANGE, hx, hy, true, forkEx)) {
      const fx = found.x, fy = found.y;
      if (found.e) damageEnemy(world, found.e, dmg * FORK_DAMAGE, src);
      else if (found.s) damageShip(world, found.s, dmg * FORK_DAMAGE, src, 'player');
      emit(world, { t: 'arc', points: [hx, hy, fx, fy], team: p.ownerTeam });
    }
  }
}

export function stepProjectiles(world: World): void {
  const map = world.map, tick = world.tick;
  const mem = side(world).pierceMem;
  const nBlockers = buildBlockers(world);

  for (const p of world.projectiles.values()) {
    if (world.projectiles.get(p.id) !== p) continue; // removed earlier this tick (e.g. by a blast)

    if (tick >= p.expireTick) {
      if (p.kind === 'singularity') toWell(world, p);
      else if (p.splash > 0) detonate(world, p);
      else { world.projectiles.delete(p.id); mem.delete(p.id); }
      continue;
    }

    if (p.kind === 'mine') {
      if (p.vx !== 0 || p.vy !== 0) { // mines may be nudged (e.g. by pve gravity); keep them out of walls
        const nx = p.x + p.vx * DT, ny = p.y + p.vy * DT;
        if (!isSolidAt(map, nx, ny)) { p.x = nx; p.y = ny; }
        p.vx *= 0.9; p.vy *= 0.9;
      }
      if (tick >= p.armTick && mineTriggered(world, p)) detonate(world, p);
      continue;
    }

    if (p.homingRange > 0 && p.homingTurn > 0) steer(world, p);

    const x0 = p.x, y0 = p.y;
    let x1 = x0 + p.vx * DT, y1 = y0 + p.vy * DT;

    if (isSolidAt(map, x1, y1)) {
      if (p.kind === 'singularity') { toWell(world, p); continue; }
      if (p.bouncesLeft > 0) {
        p.bouncesLeft--;
        const hx = isSolidAt(map, x1, y0), hy = isSolidAt(map, x0, y1);
        if (hx) p.vx = -p.vx;
        if (hy) p.vy = -p.vy;
        if (!hx && !hy) { p.vx = -p.vx; p.vy = -p.vy; }
        x1 = x0; y1 = y0;
      } else {
        detonate(world, p); // at the last free position
        continue;
      }
    }

    // hostile deployables (walls block; sentries/drones absorb)
    if (nBlockers) {
      const d = hitBlocker(world, p, x0, y0, x1, y1);
      if (d) {
        if (d.kind === 'wall' && (d.mem.reflect ?? 0) > 0) { reflectOff(p, d, x0, y0); mem.delete(p.id); continue; }
        p.x = x0; p.y = y0;
        if (p.kind === 'singularity') { toWell(world, p); continue; }
        damageDeployable(world, d, p.damage);
        if (p.splash > 0) detonate(world, p);
        else { world.projectiles.delete(p.id); mem.delete(p.id); emit(world, { t: 'explode', x: x0, y: y0, radius: 0, kind: p.kind, team: p.ownerTeam }); }
        continue;
      }
    }

    p.x = x1; p.y = y1;
    if (p.kind === 'singularity') continue; // flies over bodies to its destination

    // swept collision vs bodies, nearest first. A piercing projectile keeps the set of bodies it has hit
    // (never hits one twice, even while overlapping several) and may hit several bodies in one step.
    let hitSet = mem.get(p.id) ?? null;
    for (let n = 0; n < MAX_HITS_PER_STEP; n++) {
      if (!firstHitOnSegment(world, p.ownerTeam, p.ownerId, x0, y0, x1, y1, p.radius, 0, false, hitSet)) break;
      const e = found.e, s = found.s;

      if (detonatesOnContact(p)) { detonate(world, p); break; }
      directHit(world, p, e, s);
      if (world.projectiles.get(p.id) !== p) { mem.delete(p.id); break; } // removed by a kill side effect
      if (p.pierce > 0) {
        p.pierce--;
        if (!hitSet) { hitSet = new Set(); mem.set(p.id, hitSet); }
        hitSet.add(e ? e.id : s ? s.id : 0);
      } else {
        world.projectiles.delete(p.id);
        mem.delete(p.id);
        if (p.splash > 0) {
          const src = p.ownerTeam === ENEMY_TEAM ? 0 : p.ownerId;
          splashDamage(world, p.x, p.y, p.splash, p.damage * 0.5, p.ownerTeam, src);
          emit(world, { t: 'explode', x: p.x, y: p.y, radius: p.splash, kind: p.kind, team: p.ownerTeam });
        }
        break;
      }
    }
  }
  if (mem.size > 0 && (tick & 63) === 0) {
    for (const id of mem.keys()) if (!world.projectiles.has(id)) mem.delete(id);
  }
}
