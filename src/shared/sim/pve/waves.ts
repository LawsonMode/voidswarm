// OWNER: PVE agent. Wave director: wave cadence, target population, formation spawning.
import { MAX_ENEMIES, TICK_RATE } from '../../constants';
import type { Enemy, EnemyKind, Ship, World } from '../../types';
import { TILE_BASE } from '../../types';
import { isSolidAt, tileAt } from '../map';
import { objectiveAnchors } from '../objectives';
import { emit, secToTicks } from '../world';
import { spawnEnemy } from './enemies';
import { queryShips } from './query';

export const WAVE_SEC = 30;
export const FIRST_WAVE_SEC = 3;
export const SPAWN_MIN_DIST = 1000;
export const SPAWN_MAX_DIST = 1500;
export const SPAWN_SAFE_DIST = 700;
const TRICKLE_TICKS = 24; // 0.4 s
const FORMATION_EXTENT = 160; // max member offset from formation center
const MAX_BLACKHOLES = 3;
const MAX_HIVES = 2;

const INTENSITY_FACTOR: Record<number, number> = { 0: 0, 1: 0.5, 2: 1, 3: 1.8 };

const shipBuf: Ship[] = [];
const anchorBuf: Ship[] = [];

export function initDirector(world: World): void {
  world.pve.wave = 0;
  world.pve.nextWaveTick = world.tick + secToTicks(FIRST_WAVE_SEC);
  world.pve.bossAlive = false;
  world.pve.mem.nextTrickle = world.tick + secToTicks(FIRST_WAVE_SEC);
}

function aliveShips(world: World, out: Ship[]): number {
  out.length = 0;
  for (const s of world.ships.values()) if (s.alive) out.push(s);
  return out.length;
}

export function targetEnemyCount(world: World, aliveCount: number): number {
  const f = INTENSITY_FACTOR[world.config.pveIntensity] ?? 1;
  const minutes = Math.max(0, (world.tick - world.match.startTick) / (TICK_RATE * 60));
  return Math.min(MAX_ENEMIES, Math.round((20 + 7 * aliveCount) * f * (1 + 0.2 * minutes)));
}

function hpScale(world: World): number {
  return 1 + 0.12 * Math.max(0, world.pve.wave - 1);
}

function pickKind(world: World): EnemyKind {
  const w = world.pve.wave;
  let bh = 0;
  for (const e of world.enemies.values()) { if (e.kind === 'blackhole') bh++; }
  // [kind, weight]
  const table: [EnemyKind, number][] = [['drone', 10]];
  if (w >= 2) { table.push(['dart', 4], ['weaver', 4]); }
  if (w >= 3) { table.push(['splitter', 3], ['spinner', 2]); }
  if (w >= 4) table.push(['brute', 1.2]);
  if (w >= 5 && bh < MAX_BLACKHOLES) table.push(['blackhole', 0.25]);
  let total = 0;
  for (const [, x] of table) total += x;
  let r = world.rng.next() * total;
  for (const [k, x] of table) { r -= x; if (r < 0) return k; }
  return 'drone';
}

function spawnPointOk(world: World, x: number, y: number, margin: number): boolean {
  const m = world.map;
  if (x < 64 || y < 64 || x > m.width - 64 || y > m.height - 64) return false;
  if (isSolidAt(m, x, y)) return false;
  if (tileAt(m, Math.floor(x / m.tileSize), Math.floor(y / m.tileSize)) === TILE_BASE) return false;
  return queryShips(world, x, y, SPAWN_SAFE_DIST + margin, shipBuf) === 0;
}

type SpawnAnchor = { x: number; y: number; weight: number };
const NO_ANCHORS: readonly SpawnAnchor[] = [];

/**
 * Objective swarm anchors (§5.6): active Control Zones, weight 2 each, from sim/objectives. Only when the
 * match has a swarm (pveIntensity > 0); objectiveAnchors itself is [] outside objective sub-modes.
 */
function spawnAnchors(world: World): readonly SpawnAnchor[] {
  return world.config.pveIntensity > 0 ? objectiveAnchors(world) : NO_ANCHORS;
}

/** Sum of the usable (finite, > 0) anchor weights. */
function anchorWeightOf(anchors: readonly SpawnAnchor[]): number {
  let w = 0;
  for (const o of anchors) if (o.weight > 0 && Number.isFinite(o.weight)) w += o.weight;
  return w;
}

/**
 * One weighted draw over [every ship in `ships` at weight 1] + [each anchor at its weight], so an anchor wins
 * with probability anchorWeight / (ships + anchorWeight) (§5.6). Exactly one world.rng draw, like rng.pick.
 */
function pickRingCenter(world: World, ships: readonly Ship[], anchors: readonly SpawnAnchor[], anchorWeight: number): { x: number; y: number } {
  let r = world.rng.next() * (ships.length + anchorWeight);
  if (r < ships.length) return ships[Math.floor(r)];
  r -= ships.length;
  let last: SpawnAnchor | null = null;
  for (const o of anchors) {
    if (!(o.weight > 0 && Number.isFinite(o.weight))) continue;
    last = o;
    r -= o.weight;
    if (r < 0) return o;
  }
  return last ?? ships[ships.length - 1]; // float rounding at the top edge
}

/**
 * Find a formation center 1000–1500 px from a random alive ship — or, in a swarm match with objective anchors
 * (Warzone Control Zones), from an active zone with probability anchorWeight / (ships + anchorWeight). The
 * ring, spawnPointOk and the 10 attempts are the same either way. Returns null if none found.
 * No anchors (every deathmatch / CTF / pve 0 match) = the v0.2 path, identical world.rng stream.
 */
export function findSpawnCenter(world: World, margin = FORMATION_EXTENT): { x: number; y: number } | null {
  anchorBuf.length = 0;
  for (const s of world.ships.values()) if (s.alive && !s.attachedTo) anchorBuf.push(s);
  if (anchorBuf.length === 0) return null;
  const anchors = spawnAnchors(world);
  const anchorWeight = anchors.length > 0 ? anchorWeightOf(anchors) : 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const c = anchorWeight > 0 ? pickRingCenter(world, anchorBuf, anchors, anchorWeight) : world.rng.pick(anchorBuf);
    const a = world.rng.next() * Math.PI * 2;
    const d = world.rng.range(SPAWN_MIN_DIST, SPAWN_MAX_DIST);
    const x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d;
    if (spawnPointOk(world, x, y, margin)) return { x, y };
  }
  return null;
}

function memberOk(world: World, x: number, y: number): boolean {
  const m = world.map;
  if (x < 32 || y < 32 || x > m.width - 32 || y > m.height - 32) return false;
  if (isSolidAt(m, x, y)) return false;
  return tileAt(m, Math.floor(x / m.tileSize), Math.floor(y / m.tileSize)) !== TILE_BASE;
}

/**
 * Spawn a GW-style formation of `count` enemies of `kind` around (cx,cy). Returns number spawned.
 * v0.3 M4 (rift only, defaults keep the v0.2 path and rng stream): `hpMult` multiplies the tier HP scale (party /
 * difficulty / instability), `out` collects the spawned enemies, and in a rift a member that lands on a solid or base
 * tile is pulled halfway to the centre, then onto it, instead of being dropped (rooms are cramped: rims, pillars).
 */
export function spawnFormation(
  world: World, kind: EnemyKind, cx: number, cy: number, count: number, hpMult = 1, out?: Enemy[],
): number {
  const shape = world.rng.int(0, 2); // 0 ring, 1 line, 2 cluster
  const scale = hpScale(world) * hpMult;
  const rot = world.rng.next() * Math.PI * 2;
  const rift = !!world.dungeon;
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    if (world.enemies.size >= MAX_ENEMIES) break;
    let x = cx, y = cy;
    if (count > 1) {
      if (shape === 0) {
        const r = Math.min(FORMATION_EXTENT, 60 + count * 5);
        const a = rot + (i * Math.PI * 2) / count;
        x += Math.cos(a) * r; y += Math.sin(a) * r;
      } else if (shape === 1) {
        const span = Math.min(FORMATION_EXTENT * 2, count * 28);
        const t = (i / (count - 1) - 0.5) * span;
        x += Math.cos(rot) * t; y += Math.sin(rot) * t;
      } else {
        const a = world.rng.next() * Math.PI * 2, r = Math.sqrt(world.rng.next()) * FORMATION_EXTENT * 0.7;
        x += Math.cos(a) * r; y += Math.sin(a) * r;
      }
    }
    if (!memberOk(world, x, y)) {
      if (!rift) continue;
      if (memberOk(world, cx + (x - cx) * 0.5, cy + (y - cy) * 0.5)) { x = cx + (x - cx) * 0.5; y = cy + (y - cy) * 0.5; }
      else if (memberOk(world, cx, cy)) { x = cx; y = cy; }
      else continue;
    }
    const elite = kind !== 'blackhole' && kind !== 'hive' && kind !== 'matriarch' && world.rng.chance(0.05);
    const e = spawnEnemy(world, kind, x, y, { elite, hpScale: scale });
    if (e) { spawned++; out?.push(e); }
  }
  return spawned;
}

function spawnHive(world: World, aliveCount: number): void {
  let hives = 0;
  for (const e of world.enemies.values()) if (e.kind === 'hive') hives++;
  if (hives >= MAX_HIVES) return;
  const c = findSpawnCenter(world, 80);
  if (!c) return;
  const e = spawnEnemy(world, 'hive', c.x, c.y, { hpScale: hpScale(world) * (1 + 0.3 * aliveCount) });
  if (e) world.pve.bossAlive = true;
}

function formationSize(world: World, kind: EnemyKind): number {
  const w = world.pve.wave;
  switch (kind) {
    case 'brute': return world.rng.int(1, 2);
    case 'blackhole': return 1;
    case 'spinner': return world.rng.int(2, 4);
    case 'splitter': return world.rng.int(3, 5);
    default: return world.rng.int(5, 8 + Math.min(8, w));
  }
}

/** Wave director (Arena / Warzone). A no-op in a rift: the rift director (rift.ts) runs encounters per room instead. */
export function stepDirector(world: World): void {
  if (world.dungeon) return;
  if (world.config.pveIntensity === 0 || world.match.phase !== 'playing') return;
  const tick = world.tick;
  const alive = aliveShips(world, anchorBuf);
  if (alive === 0) return;

  if (tick >= world.pve.nextWaveTick) {
    world.pve.wave++;
    world.pve.nextWaveTick = tick + secToTicks(WAVE_SEC);
    const boss = world.pve.wave % 5 === 0;
    emit(world, { t: 'waveStart', wave: world.pve.wave, boss });
    if (boss) spawnHive(world, alive);
    // wave-opening formations
    const n = 1 + Math.floor(alive / 6);
    for (let i = 0; i < n; i++) {
      const c = findSpawnCenter(world);
      if (!c) continue;
      const kind = pickKind(world);
      spawnFormation(world, kind, c.x, c.y, formationSize(world, kind) + 4);
    }
  }

  if (tick >= (world.pve.mem.nextTrickle ?? 0)) {
    world.pve.mem.nextTrickle = tick + TRICKLE_TICKS;
    if (world.pve.wave === 0) return;
    const deficit = targetEnemyCount(world, alive) - world.enemies.size;
    if (deficit < 3) return;
    const c = findSpawnCenter(world);
    if (!c) return;
    const kind = pickKind(world);
    spawnFormation(world, kind, c.x, c.y, Math.min(deficit, formationSize(world, kind)));
  }
}
