// OWNER: SIM agent. v0.3 Dungeon Runner floor generation (docs/v0.3-proposal.md §4.2).
//
// generateFloor(seed, floor, parties) is deterministic: it uses only Rng, hash32 and IEEE basic arithmetic
// (no Math.sin / cos / sqrt anywhere a tile or an attempt's acceptance depends on it), so the client and the
// server build byte-identical tiles from (seed, floor) on every floorStart. Every floor fills the full
// 200 × 200-tile grid (MAP_SIZE), so world.grid and the sim side-state cells stay valid across floor swaps.
//
// Layout: a 4 × 4 macro grid of 50 × 50-tile cells, one room per used cell. The main path (entrance first,
// key / boss last) is a randomized self-avoiding walk; treasure branches are single dead-end cells beside it,
// never next to the key / boss cell. Rooms are linked only along the path and to their branch, by 5-wide
// straight or Z-shaped corridors; where a corridor crosses a sealable room's rim, the 5 × 2 gap is TILE_DOOR.
import { MAP_SIZE, MAP_TILE, MAX_PARTIES, RIFT_BOSS_EVERY } from '../constants';
import type { GameMap, RiftBiome, RiftDoor, RiftLayout, RiftRoom, RiftRoomKind, SpawnPoint } from '../types';
import { RIFT_SEALED, TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../types';
import { hash32 } from '../util/hash';
import { Rng } from '../util/rng';
import {
  isSealableKind, RIFT_CELL_TILES, RIFT_CELLS, RIFT_CHEST_OFFSET_PX, RIFT_CORRIDOR_TILES, RIFT_DOOR_CORNER_TILES,
  RIFT_DOOR_IN_TILES, RIFT_EXTRACT_OFFSET_PX, RIFT_PARTY_SPAWN_R, RIFT_RIM_TILES, RIFT_TREASURE_CHEST_FRAC,
} from './dungeonRules';

// ---- generation tuning (SIM, not contract) ----
/** Layout attempts before the hard-coded snake fallback. */
export const FLOOR_ATTEMPTS = 8;
/** Interior size range per kind, tiles (entrance and boss are square). */
const SIZE: Readonly<Record<RiftRoomKind, readonly [number, number]>> = {
  entrance: [22, 24], hall: [24, 32], arena: [34, 42], treasure: [16, 20], key: [40, 44], boss: [46, 46],
};
/** Enemy spawn markers per kind. */
export const RIFT_SPAWN_MARKERS: Readonly<Record<RiftRoomKind, number>> = {
  entrance: 0, hall: 4, arena: 8, treasure: 3, key: 8, boss: 8,
};
/** Pillar count range per kind (boss rooms get exactly 4 symmetric ones). */
const PILLARS: Readonly<Record<RiftRoomKind, readonly [number, number]>> = {
  entrance: [0, 0], hall: [1, 3], arena: [3, 6], treasure: [0, 0], key: [0, 0], boss: [4, 4],
};
/** Hive pillar radius range (tiles); prism pillars are 3 × 3 squares (this is their spacing radius). */
const HIVE_PILLAR_R: readonly [number, number] = [1.5, 2.8];
const PRISM_PILLAR_R = 2.2;
/** Pillars: ≥ this far from any doorway / in-point (+ own radius) and from the room centre; boss at this share. */
const PILLAR_DOOR_CLEAR = 6;
const PILLAR_CENTRE_CLEAR = 7;
/** Hull passage (tiles) kept between a pillar and the rim, and between two pillars. */
const PILLAR_PASSAGE = 3;
const BOSS_PILLAR_FRAC = 0.3;
/** Spawn markers: ring radius (share of the half-size), tried in this order; ≥ 7 tiles from any doorway. */
const MARKER_RINGS: readonly number[] = [0.72, 0.6, 0.84, 0.5];
const MARKER_DOOR_CLEAR = 7;
const MARKER_SPACING = 3;
/** Chance that a link whose door bands overlap is carved straight instead of Z-shaped. */
const STRAIGHT_CHANCE = 0.35;

// Unit vectors with literal components (no trig): 16 directions for marker rings, 6 (+6 rotated 30°) for spawns.
const I5 = 0.4472135954999579; // 1/√5
const J5 = 0.8944271909999159; // 2/√5
const S2 = 0.7071067811865476; // 1/√2
const DIRS16: readonly (readonly [number, number])[] = [
  [1, 0], [J5, I5], [S2, S2], [I5, J5], [0, 1], [-I5, J5], [-S2, S2], [-J5, I5],
  [-1, 0], [-J5, -I5], [-S2, -S2], [-I5, -J5], [0, -1], [I5, -J5], [S2, -S2], [J5, -I5],
];
/** Bit-reversed visiting order: the first k picks are spread evenly around the ring. */
const SPREAD16: readonly number[] = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const H3 = 0.8660254037844386; // √3/2
const RING6: readonly (readonly (readonly [number, number])[])[] = [
  [[1, 0], [0.5, H3], [-0.5, H3], [-1, 0], [-0.5, -H3], [0.5, -H3]],
  [[H3, 0.5], [0, 1], [-H3, 0.5], [-H3, -0.5], [0, -1], [H3, -0.5]],
];
const EDGE_CELLS: readonly number[] = [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15];
/** Fallback path: a boustrophedon snake from cell 0. */
const SNAKE: readonly number[] = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12];

// ---------------------------------------------------------------------------------------------
// Floor table (§4.2)
// ---------------------------------------------------------------------------------------------

export interface FloorPlan {
  /** Main path in order: entrance first, key (or boss on boss floors) last. */
  main: RiftRoomKind[];
  /** Treasure dead-ends beside the main path. */
  branches: number;
}

const E: RiftRoomKind = 'entrance', H: RiftRoomKind = 'hall', A: RiftRoomKind = 'arena';
const PLANS: readonly { main: readonly RiftRoomKind[]; branches: number }[] = [
  { main: [E, H, A, H, A, 'key'], branches: 1 }, // floor 1
  { main: [E, H, A, H, A, 'key'], branches: 1 }, // 2
  { main: [E, H, A, H, A, H, 'boss'], branches: 1 }, // 3
  { main: [E, H, A, H, A, A, 'key'], branches: 2 }, // 4
  { main: [E, H, A, A, H, A, 'key'], branches: 2 }, // 5
  { main: [E, H, A, H, A, H, A, 'boss'], branches: 2 }, // 6
];

function normFloor(floor: number): number {
  return Number.isFinite(floor) && floor >= 1 ? Math.floor(floor) : 1;
}

/** Rooms of a floor (§4.2 table). Floors past 6 (v0.4) repeat the 1–6 cycle, so every 3rd floor is a boss floor. */
export function floorPlan(floor: number): FloorPlan {
  const p = PLANS[(normFloor(floor) - 1) % PLANS.length];
  return { main: p.main.slice(), branches: p.branches };
}

/** Floors 1–3 'hive', 4+ 'prism' (palette and pillar style only). */
export function floorBiome(floor: number): RiftBiome {
  return normFloor(floor) <= 3 ? 'hive' : 'prism';
}

/** Enemy tier of a floor: 1 + 2·(floor − 1). */
export function riftTier(floor: number): number {
  return 1 + 2 * (normFloor(floor) - 1);
}

// ---------------------------------------------------------------------------------------------
// Room graph
// ---------------------------------------------------------------------------------------------

interface Graph {
  /** Macro cell per room (room idx order: main path, then branches). */
  cells: number[];
  kinds: RiftRoomKind[];
  /** Parent room idx (entrance −1; main room i → i − 1; branch → its main-path room). */
  parent: number[];
  /** Main path length. */
  main: number;
}

function neighbours(cell: number): number[] {
  const cx = cell % RIFT_CELLS, cy = (cell / RIFT_CELLS) | 0, out: number[] = [];
  if (cx > 0) out.push(cell - 1);
  if (cx < RIFT_CELLS - 1) out.push(cell + 1);
  if (cy > 0) out.push(cell - RIFT_CELLS);
  if (cy < RIFT_CELLS - 1) out.push(cell + RIFT_CELLS);
  return out;
}

function shuffle<T>(rng: Rng, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** Randomized self-avoiding walk of exactly `len` cells from `start` (backtracking), or null. */
function walk(rng: Rng, start: number, len: number): number[] | null {
  const path = [start];
  const on = new Uint8Array(RIFT_CELLS * RIFT_CELLS);
  on[start] = 1;
  const opts: number[][] = [shuffle(rng, neighbours(start))];
  for (let guard = 0; path.length < len; guard++) {
    if (guard > 50_000) return null;
    const top = opts[opts.length - 1];
    if (top.length === 0) {
      opts.pop();
      on[path.pop()!] = 0;
      if (path.length === 0) return null;
      continue;
    }
    const n = top.pop()!;
    if (on[n]) continue;
    path.push(n); on[n] = 1;
    opts.push(shuffle(rng, neighbours(n)));
  }
  return path;
}

/** Branch candidates: free cells beside the main path (not beside the key / boss cell), best parents first. */
function branchCandidates(path: readonly number[]): { cell: number; parents: number[] }[] {
  const key = path[path.length - 1];
  const nearKey = new Set(neighbours(key));
  const out: { cell: number; parents: number[] }[] = [];
  for (let c = 0; c < RIFT_CELLS * RIFT_CELLS; c++) {
    if (path.includes(c) || nearKey.has(c)) continue;
    const parents = neighbours(c).filter((p) => path.includes(p) && p !== key);
    if (parents.length) out.push({ cell: c, parents });
  }
  return out;
}

function buildGraph(plan: FloorPlan, path: number[], branches: { cell: number; parent: number }[]): Graph {
  const cells = path.slice(), kinds = plan.main.slice(), parent = path.map((_, i) => i - 1);
  for (const b of branches) { cells.push(b.cell); kinds.push('treasure'); parent.push(path.indexOf(b.parent)); }
  return { cells, kinds, parent, main: path.length };
}

function randomGraph(rng: Rng, plan: FloorPlan): Graph | null {
  const start = EDGE_CELLS[rng.int(0, EDGE_CELLS.length - 1)];
  const path = walk(rng, start, plan.main.length);
  if (!path) return null;
  const cand = shuffle(rng, branchCandidates(path));
  if (cand.length < plan.branches) return null;
  const branches: { cell: number; parent: number }[] = [];
  for (let b = 0; b < plan.branches; b++) {
    const { cell, parents } = cand[b];
    const pref = parents.filter((p) => p !== start); // a treasure room off the entrance is too cheap
    branches.push({ cell, parent: rng.pick(pref.length ? pref : parents) });
  }
  return buildGraph(plan, path, branches);
}

/** The guaranteed fallback: the snake path from cell 0, branches in cell order (non-entrance parents first). */
function snakeGraph(plan: FloorPlan): Graph {
  const path = SNAKE.slice(0, plan.main.length);
  const cand = branchCandidates(path);
  cand.sort((a, b) => Number(a.parents.every((p) => p === path[0])) - Number(b.parents.every((p) => p === path[0])) || a.cell - b.cell);
  const branches = cand.slice(0, plan.branches).map(({ cell, parents }) => ({
    cell, parent: parents.find((p) => p !== path[0]) ?? parents[0],
  }));
  return buildGraph(plan, path, branches);
}

// ---------------------------------------------------------------------------------------------
// Carving
// ---------------------------------------------------------------------------------------------

interface Pt { x: number; y: number }

interface Proto {
  idx: number;
  kind: RiftRoomKind;
  cell: number;
  c0: number; r0: number; c1: number; r1: number;
  links: number[];
  doors: RiftDoor[];
  /** Rim-gap centre of every corridor into the room (tile units): pillar + marker clearance. */
  gaps: Pt[];
  /** In-point of every corridor (tile units). */
  ins: Pt[];
  chests: number[];
  spawns: number[];
}

const openTile = (t: number): boolean => t === TILE_EMPTY || t === TILE_BASE || t === TILE_DOOR;
const d2 = (ax: number, ay: number, bx: number, by: number): number => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

function fillRect(tiles: Uint8Array, cols: number, c0: number, r0: number, c1: number, r1: number, v: number): void {
  for (let r = r0; r < r1; r++) tiles.fill(v, r * cols + c0, r * cols + c1);
}

function placeRoom(rng: Rng, idx: number, kind: RiftRoomKind, cell: number, safe: boolean): Proto {
  const [lo, hi] = SIZE[kind];
  const w = safe ? lo : rng.int(lo, hi);
  const h = kind === 'entrance' || kind === 'boss' ? w : safe ? lo : rng.int(lo, hi);
  // Jitter inside the cell by ±⌊(50 − 4 − size)/2⌋, rim included: the room never leaves its cell.
  const off = (size: number): number => {
    const half = (RIFT_CELL_TILES - 2 * RIFT_RIM_TILES - size) >> 1;
    return half + (safe ? 0 : rng.int(-half, half)) + RIFT_RIM_TILES;
  };
  const c0 = (cell % RIFT_CELLS) * RIFT_CELL_TILES + off(w);
  const r0 = ((cell / RIFT_CELLS) | 0) * RIFT_CELL_TILES + off(h);
  return { idx, kind, cell, c0, r0, c1: c0 + w, r1: r0 + h, links: [], doors: [], gaps: [], ins: [], chests: [], spawns: [] };
}

/**
 * Carve the 5-wide corridor between two rooms in adjacent cells: straight when their door bands overlap
 * (always when the rock gap between the rims is too thin for a bend), else Z-shaped with the cross leg in the
 * gap. Each rim gap becomes TILE_DOOR (sealable room, recorded as a RiftDoor) or TILE_EMPTY. False = impossible.
 */
function carveLink(rng: Rng, tiles: Uint8Array, cols: number, ts: number, a: Proto, b: Proto, safe: boolean): boolean {
  const W = RIFT_CORRIDOR_TILES, K = RIFT_DOOR_CORNER_TILES, RIM = RIFT_RIM_TILES;
  const ax = a.cell % RIFT_CELLS, ay = (a.cell / RIFT_CELLS) | 0;
  const bx = b.cell % RIFT_CELLS, by = (b.cell / RIFT_CELLS) | 0;
  if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) return false;
  const horiz = ay === by;
  // P = left / top room, Q = right / bottom. "along" crosses the cell boundary; "across" is the band axis.
  const [P, Q] = (horiz ? ax < bx : ay < by) ? [a, b] : [b, a];
  const pHi = horiz ? P.c1 : P.r1, qLo = horiz ? Q.c0 : Q.r0;
  const pLo = (horiz ? P.r0 : P.c0) + K, pTop = (horiz ? P.r1 : P.c1) - K - W;
  const qLow = (horiz ? Q.r0 : Q.c0) + K, qTop = (horiz ? Q.r1 : Q.c1) - K - W;
  if (pLo > pTop || qLow > qTop) return false;
  const gap0 = pHi + RIM, gap1 = qLo - RIM; // rock between the two rims: [gap0, gap1)
  const lo = Math.max(pLo, qLow), hi = Math.min(pTop, qTop);
  let bp: number, bq: number, mid = -1;
  if (lo <= hi && (safe || gap1 - gap0 < W || rng.chance(STRAIGHT_CHANCE))) {
    bp = bq = safe ? (lo + hi) >> 1 : rng.int(lo, hi);
  } else if (gap1 - gap0 >= W) {
    bp = rng.int(pLo, pTop);
    bq = rng.int(qLow, qTop);
    if (bp !== bq) mid = rng.int(gap0, gap1 - W);
  } else return false;

  const at = (al: number, ac: number): number => (horiz ? ac * cols + al : al * cols + ac);
  const rect = (al0: number, al1: number, ac0: number, ac1: number): void => {
    for (let al = al0; al < al1; al++) for (let ac = ac0; ac < ac1; ac++) tiles[at(al, ac)] = TILE_EMPTY;
  };
  if (mid < 0) rect(pHi, qLo, bp, bp + W);
  else {
    rect(pHi, mid + W, bp, bp + W);
    rect(mid, mid + W, Math.min(bp, bq), Math.max(bp, bq) + W);
    rect(mid, qLo, bq, bq + W);
  }
  const doorway = (R: Proto, al0: number, band: number, inAl: number): void => {
    const sealable = isSealableKind(R.kind);
    const idx: number[] = [];
    for (let al = al0; al < al0 + RIM; al++) {
      for (let ac = band; ac < band + W; ac++) {
        const i = at(al, ac);
        tiles[i] = sealable ? TILE_DOOR : TILE_EMPTY;
        idx.push(i);
      }
    }
    idx.sort((x, y) => x - y);
    const inAc = band + W / 2, gapAl = al0 + RIM / 2;
    const inPt: Pt = horiz ? { x: inAl, y: inAc } : { x: inAc, y: inAl };
    R.ins.push(inPt);
    R.gaps.push(horiz ? { x: gapAl, y: inAc } : { x: inAc, y: gapAl });
    if (sealable) R.doors.push({ tiles: idx, inX: inPt.x * ts, inY: inPt.y * ts });
  };
  const IN = RIFT_DOOR_IN_TILES - 0.5; // centre of the 3rd interior tile behind the rim
  doorway(P, pHi, bp, pHi - IN);
  doorway(Q, qLo - RIM, bq, qLo + IN);
  return true;
}

/** Rock 8-adjacent to open ground (corridors; room interiors are already rimmed) becomes TILE_WALL. */
function wallCorridors(tiles: Uint8Array, cols: number, rows: number): void {
  const src = tiles.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (src[i] !== TILE_ROCK) continue;
      let open = false;
      for (let dr = -1; dr <= 1 && !open; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc >= 0 && cc < cols && openTile(src[rr * cols + cc])) { open = true; break; }
        }
      }
      if (open) tiles[i] = TILE_WALL;
    }
  }
}

function placeChests(R: Proto, ts: number): void {
  const cx = ((R.c0 + R.c1) / 2) * ts, cy = ((R.r0 + R.r1) / 2) * ts;
  if (R.kind === 'arena' || R.kind === 'key') { R.chests = [cx, cy + RIFT_CHEST_OFFSET_PX]; return; }
  if (R.kind !== 'treasure') return;
  // Two chests at 0.4 × half-size, across the doorway axis (both equally far from the way in).
  const g = R.gaps[0];
  const side = !g || Math.abs(g.x * ts - cx) >= Math.abs(g.y * ts - cy); // doorway on a left / right wall
  const ox = ((R.c1 - R.c0) / 2) * ts * RIFT_TREASURE_CHEST_FRAC, oy = ((R.r1 - R.r0) / 2) * ts * RIFT_TREASURE_CHEST_FRAC;
  R.chests = side ? [cx, cy - oy, cx, cy + oy] : [cx - ox, cy, cx + ox, cy];
}

function drawPillar(tiles: Uint8Array, cols: number, biome: RiftBiome, x: number, y: number, r: number): void {
  if (biome === 'prism') {
    const pc = Math.floor(x), pr = Math.floor(y);
    for (let rr = pr - 1; rr <= pr + 1; rr++) for (let cc = pc - 1; cc <= pc + 1; cc++) tiles[rr * cols + cc] = TILE_WALL;
    return;
  }
  const r2 = r * r;
  for (let rr = Math.floor(y - r); rr <= Math.ceil(y + r); rr++) {
    for (let cc = Math.floor(x - r); cc <= Math.ceil(x + r); cc++) {
      if (d2(cc + 0.5, rr + 0.5, x, y) <= r2) tiles[rr * cols + cc] = TILE_ROCK;
    }
  }
}

/** hive: round ROCK pillars (r 1.5–2.8 tiles); prism: 3 × 3 WALL squares. Boss rooms: 4 symmetric ones. */
function placePillars(rng: Rng, tiles: Uint8Array, cols: number, ts: number, R: Proto, biome: RiftBiome): void {
  const [lo, hi] = PILLARS[R.kind];
  if (hi === 0) return;
  const cx = (R.c0 + R.c1) / 2, cy = (R.r0 + R.r1) / 2;
  const hive = biome === 'hive';
  if (R.kind === 'boss') {
    const r = hive ? rng.range(HIVE_PILLAR_R[0], HIVE_PILLAR_R[1]) : PRISM_PILLAR_R;
    const ox = BOSS_PILLAR_FRAC * (R.c1 - R.c0) / 2, oy = BOSS_PILLAR_FRAC * (R.r1 - R.r0) / 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) drawPillar(tiles, cols, biome, cx + sx * ox, cy + sy * oy, r);
    return;
  }
  const avoid = R.gaps.concat(R.ins);
  const chests: Pt[] = [];
  for (let i = 0; i < R.chests.length; i += 2) chests.push({ x: R.chests[i] / ts, y: R.chests[i + 1] / ts });
  const placed: { x: number; y: number; r: number }[] = [];
  const n = rng.int(lo, hi);
  for (let p = 0; p < n; p++) {
    for (let tries = 0; tries < 40; tries++) {
      const r = hive ? rng.range(HIVE_PILLAR_R[0], HIVE_PILLAR_R[1]) : PRISM_PILLAR_R;
      const m = r + PILLAR_PASSAGE;
      if (R.c1 - R.c0 <= 2 * m || R.r1 - R.r0 <= 2 * m) break;
      let x = rng.range(R.c0 + m, R.c1 - m), y = rng.range(R.r0 + m, R.r1 - m);
      if (!hive) { x = Math.floor(x) + 0.5; y = Math.floor(y) + 0.5; }
      if (d2(x, y, cx, cy) < PILLAR_CENTRE_CLEAR * PILLAR_CENTRE_CLEAR) continue;
      const dc = PILLAR_DOOR_CLEAR + r;
      if (avoid.some((q) => d2(x, y, q.x, q.y) < dc * dc)) continue;
      if (chests.some((q) => d2(x, y, q.x, q.y) < (r + 2) * (r + 2))) continue;
      if (placed.some((q) => d2(x, y, q.x, q.y) < (r + q.r + PILLAR_PASSAGE) * (r + q.r + PILLAR_PASSAGE))) continue;
      placed.push({ x, y, r });
      drawPillar(tiles, cols, biome, x, y, r);
      break;
    }
  }
}

/**
 * Enemy spawn markers on a ring at 0.72 × half-size (then 0.6 / 0.84 / 0.5): open 3 × 3 ground, ≥ 7 tiles from
 * every doorway, ≥ 3 tiles apart, clear of chests. `safe` (the fallback) may scan the interior as a last resort.
 */
function placeSpawns(rng: Rng, tiles: Uint8Array, cols: number, ts: number, R: Proto, safe: boolean): boolean {
  const need = RIFT_SPAWN_MARKERS[R.kind];
  if (need === 0) return true;
  const cx = (R.c0 + R.c1) / 2, cy = (R.r0 + R.r1) / 2, hw = (R.c1 - R.c0) / 2, hh = (R.r1 - R.r0) / 2;
  const chests: Pt[] = [];
  for (let i = 0; i < R.chests.length; i += 2) chests.push({ x: R.chests[i] / ts, y: R.chests[i + 1] / ts });
  const got: { c: number; r: number }[] = [];
  const ok = (c: number, r: number): boolean => {
    if (c < R.c0 + 1 || c >= R.c1 - 1 || r < R.r0 + 1 || r >= R.r1 - 1) return false;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (!openTile(tiles[(r + dr) * cols + c + dc])) return false;
    const x = c + 0.5, y = r + 0.5;
    if (R.gaps.some((g) => d2(x, y, g.x, g.y) < MARKER_DOOR_CLEAR * MARKER_DOOR_CLEAR)) return false;
    if (chests.some((q) => d2(x, y, q.x, q.y) < 4)) return false;
    return !got.some((q) => d2(q.c, q.r, c, r) < MARKER_SPACING * MARKER_SPACING);
  };
  const rot = rng.int(0, 15);
  for (const f of MARKER_RINGS) {
    for (const k of SPREAD16) {
      if (got.length >= need) break;
      const [ux, uy] = DIRS16[(k + rot) & 15];
      const c = Math.floor(cx + ux * f * hw), r = Math.floor(cy + uy * f * hh);
      if (ok(c, r)) got.push({ c, r });
    }
    if (got.length >= need) break;
  }
  if (got.length < need && safe) {
    for (let r = R.r0 + 1; r < R.r1 - 1 && got.length < need; r += 2) {
      for (let c = R.c0 + 1; c < R.c1 - 1 && got.length < need; c += 2) if (ok(c, r)) got.push({ c, r });
    }
  }
  if (got.length < need) return false;
  R.spawns = [];
  for (const p of got) R.spawns.push((p.c + 0.5) * ts, (p.r + 0.5) * ts);
  return true;
}

function buildFloor(rng: Rng, seed: number, floor: number, parties: number, g: Graph, safe: boolean): GameMap | null {
  const ts = MAP_TILE, cols = Math.floor(MAP_SIZE / ts), rows = cols;
  if (cols !== RIFT_CELLS * RIFT_CELL_TILES) throw new Error(`floorgen: the macro grid needs a ${RIFT_CELLS * RIFT_CELL_TILES}-tile map`);
  const tiles = new Uint8Array(cols * rows).fill(TILE_ROCK);
  const biome = floorBiome(floor);
  const rooms = g.cells.map((cell, i) => placeRoom(rng, i, g.kinds[i], cell, safe));
  for (let i = 0; i < rooms.length; i++) {
    const p = g.parent[i];
    if (p >= 0) { rooms[i].links.push(p); rooms[p].links.push(i); }
  }
  for (const R of rooms) {
    fillRect(tiles, cols, R.c0 - RIFT_RIM_TILES, R.r0 - RIFT_RIM_TILES, R.c1 + RIFT_RIM_TILES, R.r1 + RIFT_RIM_TILES, TILE_WALL);
    fillRect(tiles, cols, R.c0, R.r0, R.c1, R.r1, R.kind === 'entrance' ? TILE_BASE : TILE_EMPTY);
  }
  // Main-path links first (in path order), then branches: doors[0] of a main-path room is its way in.
  for (let i = 1; i < rooms.length; i++) if (!carveLink(rng, tiles, cols, ts, rooms[g.parent[i]], rooms[i], safe)) return null;
  wallCorridors(tiles, cols, rows);
  for (const R of rooms) placeChests(R, ts);
  if (!safe) for (const R of rooms) placePillars(rng, tiles, cols, ts, R, biome);
  for (const R of rooms) if (!placeSpawns(rng, tiles, cols, ts, R, safe)) return null;

  const depth = rooms.map((_, i) => (i < g.main ? i : g.parent[i] + 1));
  const key = rooms[g.main - 1];
  const bossFloor = key.kind === 'boss';
  const portalX = ((key.c0 + key.c1) / 2) * ts, portalY = ((key.r0 + key.r1) / 2) * ts;
  let extractX = -1, extractY = -1;
  if (bossFloor) {
    // Beside Descend, on the side away from the boss room's (only) door.
    const d0 = key.doors[0];
    const dx = d0 ? portalX - d0.inX : 0, dy = d0 ? portalY - d0.inY : 1;
    const alongX = Math.abs(dx) >= Math.abs(dy);
    extractX = portalX + (alongX ? Math.sign(dx) * RIFT_EXTRACT_OFFSET_PX : 0);
    extractY = portalY + (alongX ? 0 : Math.sign(dy) * RIFT_EXTRACT_OFFSET_PX);
  }
  const ent = rooms[0];
  const ex = ((ent.c0 + ent.c1) / 2) * ts, ey = ((ent.r0 + ent.r1) / 2) * ts;
  const spawns: SpawnPoint[] = [];
  const entrances: number[] = [];
  // v0.3 has one party; a v0.4 second party shares the entrance (rotated ring) until Rival Rift designs its own.
  for (let p = 0; p < parties; p++) {
    entrances.push(ent.idx);
    for (const [ux, uy] of RING6[p % 2]) spawns.push({ team: p, x: ex + ux * RIFT_PARTY_SPAWN_R, y: ey + uy * RIFT_PARTY_SPAWN_R });
  }
  const out: RiftRoom[] = rooms.map((R, i) => ({
    idx: R.idx, kind: R.kind, c0: R.c0, r0: R.r0, c1: R.c1, r1: R.r1,
    x: ((R.c0 + R.c1) / 2) * ts, y: ((R.r0 + R.r1) / 2) * ts,
    doors: R.doors, spawns: R.spawns, chests: R.chests, links: R.links.slice(), depth: depth[i],
    mainPath: i < g.main, party: R.kind === 'entrance' ? 0 : -1,
  }));
  const dungeon: RiftLayout = {
    floor, biome, bossFloor, rooms: out, entrances, keyRoom: key.idx, portalX, portalY, extractX, extractY,
  };
  return { seed, teamCount: parties, width: cols * ts, height: rows * ts, tileSize: ts, cols, rows, tiles, spawns, dungeon, rev: 0 };
}

// ---------------------------------------------------------------------------------------------
// Public API (§8.8)
// ---------------------------------------------------------------------------------------------

export interface FloorGenInfo {
  map: GameMap;
  /** Accepted attempt (0-based); FLOOR_ATTEMPTS = the snake fallback. */
  attempt: number;
  fallback: boolean;
}

function normParties(parties: number): number {
  return Math.max(1, Math.min(MAX_PARTIES, Math.floor(Number.isFinite(parties) ? parties : 1) || 1));
}

/** generateFloor plus which attempt was accepted (tests / diagnostics). */
export function generateFloorInfo(seed: number, floor: number, parties: number): FloorGenInfo {
  const f = normFloor(floor), np = normParties(parties);
  const plan = floorPlan(f);
  const s = hash32(seed, f, np);
  for (let k = 0; k < FLOOR_ATTEMPTS; k++) {
    const rng = new Rng((s + k * 0x9e3779b9) >>> 0);
    const g = randomGraph(rng, plan);
    if (!g) continue;
    const map = buildFloor(rng, seed, f, np, g, false);
    if (map && validateFloor(map) === null) return { map, attempt: k, fallback: false };
  }
  return { map: fallbackFloor(seed, f, np), attempt: FLOOR_ATTEMPTS, fallback: true };
}

/**
 * The guaranteed fallback generateFloor uses when no attempt validates: the snake path from cell 0, smallest room
 * sizes, no jitter, straight centred corridors, no pillars. Exported for tests / diagnostics.
 */
export function fallbackFloor(seed: number, floor: number, parties: number): GameMap {
  const f = normFloor(floor), np = normParties(parties);
  const plan = floorPlan(f);
  const map = buildFloor(new Rng(hash32(seed, f, np)), seed, f, np, snakeGraph(plan), true);
  if (!map) throw new Error(`generateFloor: the fallback layout failed (seed ${seed}, floor ${f})`);
  return map;
}

/** Deterministic floor map (Rng + hash32 only). Fixed 200×200-tile grid; unused space is TILE_ROCK. */
export function generateFloor(seed: number, floor: number, parties: number): GameMap {
  return generateFloorInfo(seed, floor, parties).map;
}

/**
 * Structural check of a freshly generated floor (doors open): rooms don't overlap, sealable rooms have ≥ 1 door
 * (others none), every door tile is TILE_DOOR, and every room centre, spawn marker, chest, door in-point, portal,
 * extract point and party spawn is on an open tile reachable from the entrance. Returns null when valid.
 */
export function validateFloor(map: GameMap): string | null {
  const lay = map.dungeon;
  if (!lay) return 'no rift layout';
  const { tiles, cols, rows, tileSize: ts } = map;
  if (tiles.length !== cols * rows) return 'tile count';
  const rooms = lay.rooms;
  if (rooms.length === 0) return 'no rooms';
  const RIM = RIFT_RIM_TILES;
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i];
    if (a.idx !== i) return `room ${i}: idx ${a.idx}`;
    if (a.c0 - RIM < 0 || a.r0 - RIM < 0 || a.c1 + RIM > cols || a.r1 + RIM > rows) return `room ${i} out of bounds`;
    for (let j = i + 1; j < rooms.length; j++) {
      const b = rooms[j];
      if (a.c0 - RIM < b.c1 + RIM && b.c0 - RIM < a.c1 + RIM && a.r0 - RIM < b.r1 + RIM && b.r0 - RIM < a.r1 + RIM) return `rooms ${i} and ${j} overlap`;
    }
    if (isSealableKind(a.kind) ? a.doors.length === 0 : a.doors.length !== 0) return `room ${i} (${a.kind}): ${a.doors.length} doors`;
    for (const d of a.doors) for (const t of d.tiles) if (tiles[t] !== TILE_DOOR) return `room ${i}: door tile ${t} is ${tiles[t]}`;
    for (const l of a.links) if (!rooms[l] || !rooms[l].links.includes(i)) return `room ${i}: bad link ${l}`;
  }
  // Flood fill from the entrance centre with the doors open.
  const ent = rooms[lay.entrances[0] ?? 0];
  if (!ent || ent.kind !== 'entrance') return 'no entrance';
  const reach = new Uint8Array(tiles.length);
  const q = new Int32Array(tiles.length);
  const start = Math.floor(ent.y / ts) * cols + Math.floor(ent.x / ts);
  if (!openTile(tiles[start])) return 'entrance centre is solid';
  let head = 0, tail = 0;
  q[tail++] = start; reach[start] = 1;
  while (head < tail) {
    const i = q[head++], c = i % cols, r = (i - c) / cols;
    const visit = (j: number): void => { if (!reach[j] && openTile(tiles[j])) { reach[j] = 1; q[tail++] = j; } };
    if (c > 0) visit(i - 1);
    if (c < cols - 1) visit(i + 1);
    if (r > 0) visit(i - cols);
    if (r < rows - 1) visit(i + cols);
  }
  const check = (x: number, y: number, what: string): string | null => {
    const c = Math.floor(x / ts), r = Math.floor(y / ts);
    if (!(c >= 0 && r >= 0 && c < cols && r < rows)) return `${what} out of bounds`;
    const i = r * cols + c;
    if (!openTile(tiles[i])) return `${what} on a solid tile`;
    return reach[i] ? null : `${what} unreachable`;
  };
  for (const room of rooms) {
    const tag = `room ${room.idx} (${room.kind})`;
    const errs = [check(room.x, room.y, `${tag} centre`)];
    for (let i = 0; i < room.spawns.length; i += 2) errs.push(check(room.spawns[i], room.spawns[i + 1], `${tag} spawn ${i / 2}`));
    for (let i = 0; i < room.chests.length; i += 2) errs.push(check(room.chests[i], room.chests[i + 1], `${tag} chest ${i / 2}`));
    for (const d of room.doors) errs.push(check(d.inX, d.inY, `${tag} door in-point`));
    const e = errs.find((x) => x !== null);
    if (e) return e;
  }
  const key = rooms[lay.keyRoom];
  if (!key || key.kind !== (lay.bossFloor ? 'boss' : 'key')) return 'key room kind';
  const p = check(lay.portalX, lay.portalY, 'portal');
  if (p) return p;
  if (lay.bossFloor) {
    const x = check(lay.extractX, lay.extractY, 'extract');
    if (x) return x;
  } else if (lay.extractX !== -1 || lay.extractY !== -1) return 'extract on a non-boss floor';
  for (const s of map.spawns) {
    const e = check(s.x, s.y, `party ${s.team} spawn`);
    if (e) return e;
  }
  return null;
}

/**
 * Writes TILE_WALL into the door tiles of SEALED rooms and TILE_DOOR otherwise (ARMING doors stay open).
 * Pure + idempotent; the only runtime tile mutation; bumps map.rev when changed. Returns `changed`.
 * A missing state (a short array) reads as DORMANT.
 */
export function applyRoomSeals(map: GameMap, roomStates: ArrayLike<number>): boolean {
  const lay = map.dungeon;
  if (!lay) return false;
  const tiles = map.tiles;
  let changed = false;
  for (const room of lay.rooms) {
    if (room.doors.length === 0) continue;
    const v = roomStates[room.idx] === RIFT_SEALED ? TILE_WALL : TILE_DOOR;
    for (const door of room.doors) {
      for (const i of door.tiles) if (tiles[i] !== v) { tiles[i] = v; changed = true; }
    }
  }
  if (changed) map.rev = (map.rev ?? 0) + 1;
  return changed;
}

/** Room index at (x, y) (its walkable interior), or -1 for corridors / rims / outside any room. */
export function roomAt(map: GameMap, x: number, y: number): number {
  const rooms = map.dungeon?.rooms;
  if (!rooms) return -1;
  const c = Math.floor(x / map.tileSize), r = Math.floor(y / map.tileSize);
  for (const room of rooms) if (c >= room.c0 && c < room.c1 && r >= room.r0 && r < room.r1) return room.idx;
  return -1;
}

/** Check that a floor number is a boss / extraction floor (every RIFT_BOSS_EVERY-th). */
export function isBossFloor(floor: number): boolean {
  return normFloor(floor) % RIFT_BOSS_EVERY === 0;
}
