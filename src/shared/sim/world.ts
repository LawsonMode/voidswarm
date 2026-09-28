// FROZEN CONTRACT — world storage + shared helpers used by every sim system (core, pve, ai).
// Owned by the architect. Module owners may ADD helpers at the bottom (marked with their module),
// but must not change existing signatures.

import { ENEMY_TEAM, MAX_GEMS, MAX_PROJECTILES, NO_TEAM, TICK_RATE } from '../constants';
import { Rng } from '../util/rng';
import { segPointDist2 } from '../util/math';
import type {
  CacheToken, Deployable, Enemy, EntityId, GameEvent, GameMap, GameType, Gem, Projectile, Ship, SimConfig,
  SpatialHash, SubMode, TeamId, World,
} from '../types';

const GRID_CELL = 256;

export function createWorld(config: SimConfig, map: GameMap): World {
  const cols = Math.ceil(map.width / GRID_CELL);
  const rows = Math.ceil(map.height / GRID_CELL);
  const n = cols * rows;
  const grid: SpatialHash = {
    cell: GRID_CELL, cols, rows,
    ships: Array.from({ length: n }, () => []),
    enemies: Array.from({ length: n }, () => []),
  };
  return {
    tick: 0,
    config,
    map,
    rng: new Rng(config.mapSeed ^ 0x5eed),
    nextId: 1,
    ships: new Map(),
    shipsByPlayer: new Map(),
    enemies: new Map(),
    projectiles: new Map(),
    gems: new Map(),
    deployables: new Map(),
    loot: new Map(),
    events: [],
    match: {
      phase: 'playing',
      startTick: 0,
      endTick: Math.round(config.matchSeconds * TICK_RATE),
      teamScores: config.mode === 'teams' ? new Array(config.teamCount).fill(0) : [],
      winnerTeam: -1,
      winnerPlayerId: 0,
    },
    pve: { wave: 0, nextWaveTick: 0, bossAlive: false, mem: {} },
    grid,
  };
}

export function allocId(world: World): EntityId {
  return world.nextId++;
}

export function emit(world: World, ev: GameEvent): void {
  world.events.push(ev);
}

export function secToTicks(sec: number): number {
  return Math.round(sec * TICK_RATE);
}

// ---------------------------------------------------------------------------------------------
// Team logic
// ---------------------------------------------------------------------------------------------

/** True if a and b are allies (same real team). FFA ships and enemies have no allies. */
export function sameTeam(a: TeamId, b: TeamId): boolean {
  return a >= 0 && a !== ENEMY_TEAM && a === b;
}

/**
 * Can something owned by (attackerTeam, attackerShipId) damage a ship on targetTeam with id targetShipId?
 * Never damages yourself. Allies only with friendlyFire. Enemies (PvE) always damage ships.
 */
export function canDamageShip(
  world: World, attackerTeam: TeamId, attackerShipId: EntityId, targetTeam: TeamId, targetShipId: EntityId,
): boolean {
  if (attackerTeam === ENEMY_TEAM) return true;
  if (attackerShipId === targetShipId) return false;
  if (sameTeam(attackerTeam, targetTeam)) return world.config.friendlyFire;
  return true;
}

/** Ships always damage enemies; enemies never damage enemies. */
export function canDamageEnemy(attackerTeam: TeamId): boolean {
  return attackerTeam !== ENEMY_TEAM;
}

/** The team value a player's ship should carry given mode. */
export function effectiveTeam(world: World, team: TeamId): TeamId {
  return world.config.mode === 'ffa' ? NO_TEAM : team;
}

// ---------------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------------

/** Spawn a projectile (returns null if the global cap is hit). Caller has already applied damage multipliers. */
export function spawnProjectile(world: World, p: Omit<Projectile, 'id'>): Projectile | null {
  if (world.projectiles.size >= MAX_PROJECTILES) return null;
  const proj: Projectile = { ...p, id: allocId(world) };
  world.projectiles.set(proj.id, proj);
  return proj;
}

/** Defaults for the optional-ish projectile fields; spread this then override. */
export function projectileDefaults(world: World): Pick<
  Projectile, 'bouncesLeft' | 'level' | 'spawnTick' | 'homingRange' | 'homingTurn' | 'pierce' | 'armTick' | 'splash'
> {
  return {
    bouncesLeft: 0, level: 1, spawnTick: world.tick, homingRange: 0, homingTurn: 0, pierce: 0,
    armTick: world.tick, splash: 0,
  };
}

/**
 * Drop XP gems totalling `total` XP around (x,y), split into a few gems (bigger values = fewer gems).
 * Gems scatter outward with a little velocity and expire after `lifeSec`.
 */
export function dropGems(world: World, x: number, y: number, total: number, lifeSec = 30): void {
  total = Math.floor(total);
  if (total <= 0) return;
  const pieces = Math.min(12, Math.max(1, Math.round(Math.sqrt(total / 3))));
  const per = Math.max(1, Math.floor(total / pieces));
  let left = total;
  for (let i = 0; i < pieces && left > 0; i++) {
    if (world.gems.size >= MAX_GEMS) {
      // merge into the oldest gem instead of losing the XP
      const oldest = world.gems.values().next().value as Gem | undefined;
      if (oldest) oldest.value += left;
      return;
    }
    const v = i === pieces - 1 ? left : per;
    left -= v;
    const a = world.rng.next() * Math.PI * 2;
    const sp = pieces === 1 ? 0 : world.rng.range(40, 160);
    const g: Gem = {
      id: allocId(world), x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, value: v,
      spawnTick: world.tick, expireTick: world.tick + secToTicks(lifeSec), magnetTo: 0,
    };
    world.gems.set(g.id, g);
  }
}

// ---------------------------------------------------------------------------------------------
// Turrets (shared by sim and client so attached ships render exactly where the server puts them)
// ---------------------------------------------------------------------------------------------

/** World-space offset of turret `slot` (0-based) of `count` turrets on a host facing hostAngle. */
export function turretOffset(hostAngle: number, slot: number, count: number, hostRadius: number): { dx: number; dy: number } {
  const a = hostAngle + Math.PI + (slot - (count - 1) / 2) * 0.8;
  const r = hostRadius + 12;
  return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
}

// ---------------------------------------------------------------------------------------------
// Spatial hash — Sim.step() calls rebuildGrid() once per tick BEFORE running systems.
// All alive ships (turrets included) and all enemies are indexed.
// ---------------------------------------------------------------------------------------------

export function rebuildGrid(world: World): void {
  const g = world.grid;
  for (const c of g.ships) c.length = 0;
  for (const c of g.enemies) c.length = 0;
  for (const s of world.ships.values()) {
    if (!s.alive) continue;
    g.ships[cellIndex(g, s.x, s.y)].push(s.id);
  }
  for (const e of world.enemies.values()) {
    g.enemies[cellIndex(g, e.x, e.y)].push(e.id);
  }
}

function cellIndex(g: SpatialHash, x: number, y: number): number {
  let cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 0) cx = 0; else if (cx >= g.cols) cx = g.cols - 1;
  if (cy < 0) cy = 0; else if (cy >= g.rows) cy = g.rows - 1;
  return cy * g.cols + cx;
}

/** Visit alive ships whose centers are within r (+ their radius if padByRadius) of (x,y). Grid reflects start-of-tick positions. */
export function forEachShipNear(world: World, x: number, y: number, r: number, fn: (s: Ship) => void): void {
  const g = world.grid;
  const reach = r + 32;
  const x0 = Math.max(0, Math.floor((x - reach) / g.cell)), x1 = Math.min(g.cols - 1, Math.floor((x + reach) / g.cell));
  const y0 = Math.max(0, Math.floor((y - reach) / g.cell)), y1 = Math.min(g.rows - 1, Math.floor((y + reach) / g.cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const id of g.ships[cy * g.cols + cx]) {
        const s = world.ships.get(id);
        if (!s || !s.alive) continue;
        const dx = s.x - x, dy = s.y - y, rr = r + s.stats.radius;
        if (dx * dx + dy * dy <= rr * rr) fn(s);
      }
    }
  }
}

/** Visit enemies whose bodies intersect the circle (x,y,r). */
export function forEachEnemyNear(world: World, x: number, y: number, r: number, fn: (e: Enemy) => void): void {
  const g = world.grid;
  const reach = r + 96; // largest enemy radius headroom
  const x0 = Math.max(0, Math.floor((x - reach) / g.cell)), x1 = Math.min(g.cols - 1, Math.floor((x + reach) / g.cell));
  const y0 = Math.max(0, Math.floor((y - reach) / g.cell)), y1 = Math.min(g.rows - 1, Math.floor((y + reach) / g.cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const id of g.enemies[cy * g.cols + cx]) {
        const e = world.enemies.get(id);
        if (!e) continue; // killed earlier this tick
        const dx = e.x - x, dy = e.y - y, rr = r + e.radius;
        if (dx * dx + dy * dy <= rr * rr) fn(e);
      }
    }
  }
}

/** Nearest alive ship to (x,y) within maxDist matching filter, or null. */
export function nearestShip(
  world: World, x: number, y: number, maxDist: number, filter?: (s: Ship) => boolean,
): Ship | null {
  let best: Ship | null = null, bestD = maxDist * maxDist;
  forEachShipNear(world, x, y, maxDist, (s) => {
    if (filter && !filter(s)) return;
    const dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = s; }
  });
  return best;
}

/** Nearest enemy to (x,y) within maxDist, or null. */
export function nearestEnemy(world: World, x: number, y: number, maxDist: number): Enemy | null {
  let best: Enemy | null = null, bestD = maxDist * maxDist;
  forEachEnemyNear(world, x, y, maxDist, (e) => {
    const dx = e.x - x, dy = e.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = e; }
  });
  return best;
}

// ---------------------------------------------------------------------------------------------
// Deployables (v0.2) — sentries, walls, wells, drones, napalm, nanite clouds. Few (< ~200), so
// linear scans are fine; no grid.
// ---------------------------------------------------------------------------------------------

export const MAX_DEPLOYABLES = 400;

export function spawnDeployable(world: World, d: Omit<Deployable, 'id'>): Deployable | null {
  if (world.deployables.size >= MAX_DEPLOYABLES) return null;
  const dep: Deployable = { ...d, id: allocId(world) };
  world.deployables.set(dep.id, dep);
  return dep;
}

/** Visit deployables whose body intersects circle (x,y,r). Walls are tested as segments. */
export function forEachDeployableNear(world: World, x: number, y: number, r: number, fn: (d: Deployable) => void): void {
  for (const d of world.deployables.values()) {
    if (d.kind === 'wall') {
      const hx = Math.cos(d.angle) * d.length * 0.5, hy = Math.sin(d.angle) * d.length * 0.5;
      const rr = r + d.radius;
      if (segPointDist2(d.x - hx, d.y - hy, d.x + hx, d.y + hy, x, y) <= rr * rr) fn(d);
    } else {
      const dx = d.x - x, dy = d.y - y, rr = r + d.radius;
      if (dx * dx + dy * dy <= rr * rr) fn(d);
    }
  }
}

/** Count deployables of `kind` owned by ship `ownerId`. */
export function countDeployables(world: World, ownerId: EntityId, kind: Deployable['kind']): number {
  let n = 0;
  for (const d of world.deployables.values()) if (d.ownerId === ownerId && d.kind === kind) n++;
  return n;
}

// --- ARCHITECT v0.3 helpers (bottom of file) ---
// (createWorld's endTick stays Math.round(config.matchSeconds * TICK_RATE): matchSeconds 0 → 0 = untimed.)

/** Effective game type (Room always sets config.gameType; the fallback keeps v0.2 tests meaningful). */
export function gameTypeOf(config: SimConfig): GameType {
  return config.gameType ?? (config.pveIntensity > 0 ? 'warzone' : 'arena');
}
export function subModeOf(config: SimConfig): SubMode {
  return config.subMode ?? (gameTypeOf(config) === 'dungeon' ? 'coop' : 'deathmatch');
}
export function isDungeon(world: World): boolean {
  return !!world.dungeon;
}
/** The ship's carried-cache array (created on first use). */
export function carriedOf(ship: Ship): CacheToken[] {
  return (ship.carried ??= []);
}

// --- module additions below this line ---
