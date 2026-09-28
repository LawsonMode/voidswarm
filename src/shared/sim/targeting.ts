// OWNER: SIM agent. Allocation-free hostile queries + wall raycast shared by skills, turrets, deployables.
import { ENEMY_TEAM } from '../constants';
import { PATHS, TALENTS, hasUpgrade, pathKey } from '../data/ships';
import type { Enemy, EntityId, GameMap, PathId, Ship, TeamId, UpgradeId, World } from '../types';
import { SHIPFLAG_CLOAKED, TILE_ROCK, TILE_WALL } from '../types';
import { segPointDist2 } from '../util/math';
import { lineOfSight } from './map';
import { canDamageEnemy, canDamageShip } from './world';

/** Does the ship have this talent (gated to its current class, so stale talents after a class swap do nothing)? */
export function has(ship: Ship, id: UpgradeId): boolean {
  if (!hasUpgrade(ship.upgrades, id)) return false;
  const t = TALENTS[id];
  return !t || PATHS[t.path].classId === ship.shipClass;
}

/** Is the ship on this path (and is it a path of its current class)? */
export function onPath(ship: Ship, path: PathId): boolean {
  return hasUpgrade(ship.upgrades, pathKey(path)) && PATHS[path].classId === ship.shipClass;
}

/** Result slot for the queries below (reused; read immediately). */
export const found = { e: null as Enemy | null, s: null as Ship | null, x: 0, y: 0, r: 0, d2: 0 };

function clearFound(): void {
  found.e = null; found.s = null; found.x = 0; found.y = 0; found.r = 0; found.d2 = Infinity;
}

/**
 * Is ship `s` a valid target for something owned by (team, ownerId)? v0.5: with friendly fire on, a turret crew
 * (a host and the turrets docked on it) never targets or hits itself: bubble domes sit on the host's hull, in the
 * line of its guns and of each other's. Without friendly fire a crew is never hostile to itself anyway.
 */
export function isHostileShip(world: World, team: TeamId, ownerId: EntityId, s: Ship): boolean {
  if (!s.alive || !canDamageShip(world, team, ownerId, s.team, s.id)) return false;
  return !crewSafe(world, team, ownerId, s);
}

/**
 * v0.5 friendly-fire crew safety for area / contact damage that checks canDamageShip itself (splash, auto-weapons,
 * Ram): true = `s` is in the same turret crew as the ship `ownerId` (host + docked turrets) with friendly fire on,
 * so it takes no damage. Always false with friendly fire off (a crew is never hostile to itself there anyway).
 */
export function crewSafe(world: World, team: TeamId, ownerId: EntityId, s: Ship): boolean {
  return !!world.config.friendlyFire && team !== ENEMY_TEAM && sameCrew(world, ownerId, s);
}

/** `s` is docked on ship `ownerId`, is its host, or shares its host. */
function sameCrew(world: World, ownerId: EntityId, s: Ship): boolean {
  if (!ownerId) return false;
  if (s.attachedTo === ownerId) return true;
  const o = world.ships.get(ownerId);
  return !!o && o.attachedTo !== 0 && (o.attachedTo === s.id || o.attachedTo === s.attachedTo);
}

/**
 * Nearest hostile (enemy or ship) to (px,py), whose center is within `range` of (ox,oy).
 * Hostility is from the point of view of (team, ownerId). Skips ids in `exclude`.
 * Cloaked ships are ignored. `los` requires line of sight from (ox,oy). Returns true + fills `found`.
 */
export function nearestHostile(
  world: World, team: TeamId, ownerId: EntityId, ox: number, oy: number, range: number,
  px: number, py: number, los: boolean, exclude: Set<EntityId> | null = null,
): boolean {
  clearFound();
  const g = world.grid, r2 = range * range, pad = range + 96;
  const cx0 = Math.max(0, Math.floor((ox - pad) / g.cell)), cx1 = Math.min(g.cols - 1, Math.floor((ox + pad) / g.cell));
  const cy0 = Math.max(0, Math.floor((oy - pad) / g.cell)), cy1 = Math.min(g.rows - 1, Math.floor((oy + pad) / g.cell));
  const enemiesToo = canDamageEnemy(team);
  let best = Infinity;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * g.cols + cx;
      if (enemiesToo) {
        const cell = g.enemies[ci];
        for (let i = 0; i < cell.length; i++) {
          const e = world.enemies.get(cell[i]);
          if (!e || e.hp <= 0 || (exclude && exclude.has(e.id))) continue;
          const dx = e.x - ox, dy = e.y - oy;
          if (dx * dx + dy * dy > r2) continue;
          const qx = e.x - px, qy = e.y - py, d = qx * qx + qy * qy;
          if (d >= best) continue;
          if (los && !lineOfSight(world.map, ox, oy, e.x, e.y)) continue;
          best = d; found.e = e; found.s = null; found.x = e.x; found.y = e.y; found.r = e.radius;
        }
      }
      const sc = g.ships[ci];
      for (let i = 0; i < sc.length; i++) {
        const s = world.ships.get(sc[i]);
        if (!s || !isHostileShip(world, team, ownerId, s) || (s.flags & SHIPFLAG_CLOAKED) || (exclude && exclude.has(s.id))) continue;
        const dx = s.x - ox, dy = s.y - oy;
        if (dx * dx + dy * dy > r2) continue;
        const qx = s.x - px, qy = s.y - py, d = qx * qx + qy * qy;
        if (d >= best) continue;
        if (los && !lineOfSight(world.map, ox, oy, s.x, s.y)) continue;
        best = d; found.s = s; found.e = null; found.x = s.x; found.y = s.y; found.r = s.stats.radius;
      }
    }
  }
  found.d2 = best;
  return found.e !== null || found.s !== null;
}

/**
 * First hostile body touched by the segment (x0,y0)->(x1,y1) swept with radius `rad`
 * (closest to the start). Skips `skipId` and any id in `exclude` (e.g. bodies a piercing projectile
 * already hit). Returns true + fills `found` (d2 = squared distance from start).
 */
export function firstHitOnSegment(
  world: World, team: TeamId, ownerId: EntityId, x0: number, y0: number, x1: number, y1: number,
  rad: number, skipId: EntityId, shipsOnly = false, exclude: ReadonlySet<EntityId> | null = null,
): boolean {
  clearFound();
  const g = world.grid, pad = rad + 128;
  const cx0 = Math.max(0, Math.floor((Math.min(x0, x1) - pad) / g.cell));
  const cx1 = Math.min(g.cols - 1, Math.floor((Math.max(x0, x1) + pad) / g.cell));
  const cy0 = Math.max(0, Math.floor((Math.min(y0, y1) - pad) / g.cell));
  const cy1 = Math.min(g.rows - 1, Math.floor((Math.max(y0, y1) + pad) / g.cell));
  const enemiesToo = !shipsOnly && canDamageEnemy(team);
  let best = Infinity;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * g.cols + cx;
      if (enemiesToo) {
        const cell = g.enemies[ci];
        for (let i = 0; i < cell.length; i++) {
          const e = world.enemies.get(cell[i]);
          if (!e || e.id === skipId || e.hp <= 0 || (exclude && exclude.has(e.id))) continue;
          const rr = rad + e.radius;
          if (segPointDist2(x0, y0, x1, y1, e.x, e.y) > rr * rr) continue;
          const d = (e.x - x0) * (e.x - x0) + (e.y - y0) * (e.y - y0);
          if (d < best) { best = d; found.e = e; found.s = null; found.x = e.x; found.y = e.y; found.r = e.radius; }
        }
      }
      const sc = g.ships[ci];
      for (let i = 0; i < sc.length; i++) {
        const s = world.ships.get(sc[i]);
        if (!s || s.id === skipId || (exclude && exclude.has(s.id)) || !isHostileShip(world, team, ownerId, s)) continue;
        const rr = rad + s.stats.radius;
        if (segPointDist2(x0, y0, x1, y1, s.x, s.y) > rr * rr) continue;
        const d = (s.x - x0) * (s.x - x0) + (s.y - y0) * (s.y - y0);
        if (d < best) { best = d; found.s = s; found.e = null; found.x = s.x; found.y = s.y; found.r = s.stats.radius; }
      }
    }
  }
  found.d2 = best;
  return found.e !== null || found.s !== null;
}

/** Distance along the ray (x,y)+(dx,dy)*t (unit dir) to the first solid tile, capped at maxLen. */
export function raycastWall(map: GameMap, x: number, y: number, dx: number, dy: number, maxLen: number): number {
  const ts = map.tileSize;
  let col = Math.floor(x / ts), row = Math.floor(y / ts);
  const solid = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return true;
    const t = map.tiles[r * map.cols + c];
    return t === TILE_WALL || t === TILE_ROCK;
  };
  if (solid(col, row)) return 0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? ts / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? ts / Math.abs(dy) : Infinity;
  let tMaxX = dx > 0 ? ((col + 1) * ts - x) / dx : dx < 0 ? (x - col * ts) / -dx : Infinity;
  let tMaxY = dy > 0 ? ((row + 1) * ts - y) / dy : dy < 0 ? (y - row * ts) / -dy : Infinity;
  for (let i = 0; i < map.cols + map.rows + 4; i++) {
    let t: number;
    if (tMaxX < tMaxY) { t = tMaxX; col += stepX; tMaxX += tDeltaX; }
    else { t = tMaxY; row += stepY; tMaxY += tDeltaY; }
    if (t >= maxLen) return maxLen;
    if (solid(col, row)) return t;
  }
  return maxLen;
}

/** True if a projectile/effect owned by (team, ownerId) is hostile to something owned by (dTeam, dOwner). */
export function hostileTo(team: TeamId, ownerId: EntityId, dTeam: TeamId, dOwner: EntityId): boolean {
  if (team === ENEMY_TEAM) return dTeam !== ENEMY_TEAM;
  if (ownerId === dOwner) return false;
  return !(team >= 0 && team === dTeam);
}
