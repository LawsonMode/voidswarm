// OWNER: AI agent. Coarse navigation grid + A* for bots.
//
// The 200x200-tile map is folded into 4x4-tile cells (128 px). Each cell gets a passability flag and
// an "anchor" (the open tile nearest the cell center). Edges between neighbouring cells are resolved
// lazily with lineOfSight(anchorA, anchorB) and cached, so building the grid is cheap and the first
// paths pay only for the edges they touch. One grid per GameMap (WeakMap cache).
// Hull clearance (v0.3 M3): a thin line of sight slips through 1-tile gaps no hull fits (the Juggernaut is 44 px
// wide, a tile 32), and bots routed through one stuck there for good. So an edge must also stay on "wide" tiles
// (tiles inside some fully open 2×2 block), and anchors prefer wide tiles.
// v0.3 M4: rift doors seal / unseal at runtime (applyRoomSeals writes TILE_WALL / TILE_DOOR and bumps map.rev), so
// the grid is rebuilt whenever grid.rev !== (map.rev ?? 0) (§8.8). A rebuild is < 1 ms (edges stay lazy), and seals
// change a few times a floor; brains drop their cached paths on the same rev change (bots.ts).
import { isSolidAt, lineOfSight } from '../sim/map';
import type { GameMap } from '../types';
import { TILE_ROCK, TILE_WALL } from '../types';

export const NAV_CELL_TILES = 4;
/** Minimum open tiles (of 16) for a coarse cell to be walkable. */
const MIN_FREE_TILES = 6;
const MAX_EXPANSIONS = 3000;

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
/** Index of the opposite direction for symmetric edge caching. */
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];

export interface NavGrid {
  map: GameMap;
  /** map.rev (absent = 0) this grid was built for. */
  rev: number;
  /** Cell size in px. */
  cell: number;
  cols: number;
  rows: number;
  pass: Uint8Array;
  ax: Float32Array;
  ay: Float32Array;
  /** cols*rows*8; -1 unknown, 0 blocked, 1 open. */
  edge: Int8Array;
  /** Per map TILE: 1 = open and inside a fully open 2×2 block (room for any hull). */
  wide: Uint8Array;
  // A* scratch
  g: Float32Array;
  parent: Int32Array;
  seen: Int32Array;
  closed: Int32Array;
  gen: number;
  heapN: Int32Array;
  heapF: Float32Array;
}

const cache = new WeakMap<GameMap, NavGrid>();

/** The map's nav grid, rebuilt when the map's tiles changed at runtime (map.rev, rift seals). */
export function getNavGrid(map: GameMap): NavGrid {
  let g = cache.get(map);
  if (!g || g.rev !== (map.rev ?? 0)) {
    g = buildNavGrid(map);
    cache.set(map, g);
  }
  return g;
}

function buildNavGrid(map: GameMap): NavGrid {
  const ts = map.tileSize;
  const cell = ts * NAV_CELL_TILES;
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const n = cols * rows;
  const pass = new Uint8Array(n);
  const ax = new Float32Array(n);
  const ay = new Float32Array(n);
  const wide = wideTiles(map);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const ccx = (cx + 0.5) * cell, ccy = (cy + 0.5) * cell;
      let free = 0, bestD = Infinity, bx = ccx, by = ccy, bestW = Infinity, wx = ccx, wy = ccy;
      for (let ty = 0; ty < NAV_CELL_TILES; ty++) {
        for (let tx = 0; tx < NAV_CELL_TILES; tx++) {
          const px = cx * cell + (tx + 0.5) * ts, py = cy * cell + (ty + 0.5) * ts;
          if (px >= map.width || py >= map.height) continue;
          if (isSolidAt(map, px, py)) continue;
          free++;
          const d = (px - ccx) ** 2 + (py - ccy) ** 2;
          if (d < bestD) { bestD = d; bx = px; by = py; }
          if (d < bestW && wide[Math.floor(py / ts) * map.cols + Math.floor(px / ts)]) { bestW = d; wx = px; wy = py; }
        }
      }
      pass[i] = free >= MIN_FREE_TILES ? 1 : 0;
      // anchor: the wide open tile nearest the cell centre (else the nearest open one)
      if (bestW < Infinity) { ax[i] = wx; ay[i] = wy; } else { ax[i] = bx; ay[i] = by; }
    }
  }
  return {
    map, rev: map.rev ?? 0, cell, cols, rows, pass, ax, ay,
    edge: new Int8Array(n * 8).fill(-1), wide,
    g: new Float32Array(n), parent: new Int32Array(n), seen: new Int32Array(n), closed: new Int32Array(n),
    gen: 0,
    heapN: new Int32Array(n * 8), heapF: new Float32Array(n * 8),
  };
}

export function cellIndexOf(g: NavGrid, x: number, y: number): number {
  let cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 0) cx = 0; else if (cx >= g.cols) cx = g.cols - 1;
  if (cy < 0) cy = 0; else if (cy >= g.rows) cy = g.rows - 1;
  return cy * g.cols + cx;
}

/** Tiles that are open and inside at least one fully open 2×2 block (a 1-tile gap / pocket is not). */
function wideTiles(map: GameMap): Uint8Array {
  const { cols, rows, tiles } = map;
  const open = (c: number, r: number) => {
    const t = tiles[r * cols + c];
    return t !== TILE_WALL && t !== TILE_ROCK;
  };
  const w = new Uint8Array(cols * rows);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      if (!open(c, r) || !open(c + 1, r) || !open(c, r + 1) || !open(c + 1, r + 1)) continue;
      w[r * cols + c] = 1; w[r * cols + c + 1] = 1; w[(r + 1) * cols + c] = 1; w[(r + 1) * cols + c + 1] = 1;
    }
  }
  return w;
}

/** Every tile the segment crosses (sampled every quarter tile) is wide. */
function wideSegment(g: NavGrid, x0: number, y0: number, x1: number, y1: number): boolean {
  const m = g.map, ts = m.tileSize;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / (ts * 0.25)));
  for (let k = 0; k <= n; k++) {
    const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
    const c = Math.floor(x / ts), r = Math.floor(y / ts);
    if (c < 0 || r < 0 || c >= m.cols || r >= m.rows || !g.wide[r * m.cols + c]) return false;
  }
  return true;
}

function edgeOpen(g: NavGrid, i: number, d: number): boolean {
  const k = i * 8 + d;
  const cached = g.edge[k];
  if (cached >= 0) return cached === 1;
  const cx = i % g.cols, cy = (i / g.cols) | 0;
  const nx = cx + DX[d], ny = cy + DY[d];
  let open = false;
  if (nx >= 0 && ny >= 0 && nx < g.cols && ny < g.rows) {
    const j = ny * g.cols + nx;
    if (g.pass[j]) {
      // diagonals: don't squeeze between two blocked orthogonal cells
      const diagOk = d < 4 || g.pass[cy * g.cols + nx] || g.pass[ny * g.cols + cx];
      open = !!diagOk && lineOfSight(g.map, g.ax[i], g.ay[i], g.ax[j], g.ay[j]) &&
        wideSegment(g, g.ax[i], g.ay[i], g.ax[j], g.ay[j]);
    }
    g.edge[j * 8 + OPP[d]] = open ? 1 : 0;
  }
  g.edge[k] = open ? 1 : 0;
  return open;
}

/** Nearest walkable cell to i within a few rings, or -1. */
function nearestPassable(g: NavGrid, i: number, maxRing = 3): number {
  if (g.pass[i]) return i;
  const cx = i % g.cols, cy = (i / g.cols) | 0;
  for (let r = 1; r <= maxRing; r++) {
    let best = -1, bestD = Infinity;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
        const j = y * g.cols + x;
        if (!g.pass[j]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * A* from (sx,sy) to (gx,gy). Returns flat waypoint coords [x0,y0,x1,y1,...] ending at the goal
 * point itself (or the goal cell's anchor if the goal point is solid), or null if unreachable.
 * The first waypoint is the first cell after the start cell.
 */
export function findPath(g: NavGrid, sx: number, sy: number, gx: number, gy: number): number[] | null {
  const s = nearestPassable(g, cellIndexOf(g, sx, sy));
  const t = nearestPassable(g, cellIndexOf(g, gx, gy));
  if (s < 0 || t < 0) return null;
  const goalSolid = isSolidAt(g.map, gx, gy);
  const endX = goalSolid ? g.ax[t] : gx, endY = goalSolid ? g.ay[t] : gy;
  if (s === t) return [endX, endY];

  const gen = ++g.gen;
  const cols = g.cols;
  const tx = t % cols, ty = (t / cols) | 0;
  const h = (i: number): number => {
    const dx = Math.abs((i % cols) - tx), dy = Math.abs(((i / cols) | 0) - ty);
    return dx > dy ? dx + 0.41421356 * dy : dy + 0.41421356 * dx;
  };
  const heapN = g.heapN, heapF = g.heapF;
  let size = 0;
  const push = (n: number, f: number): void => {
    if (size >= heapN.length) return;
    let k = size++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapF[p] <= f) break;
      heapN[k] = heapN[p]; heapF[k] = heapF[p]; k = p;
    }
    heapN[k] = n; heapF[k] = f;
  };
  const pop = (): number => {
    const top = heapN[0];
    const lastN = heapN[--size], lastF = heapF[size];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= size) break;
      if (c + 1 < size && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lastF) break;
      heapN[k] = heapN[c]; heapF[k] = heapF[c]; k = c;
    }
    heapN[k] = lastN; heapF[k] = lastF;
    return top;
  };

  g.seen[s] = gen; g.g[s] = 0; g.parent[s] = -1;
  push(s, h(s));
  let expansions = 0, found = false;
  while (size > 0) {
    const cur = pop();
    if (g.closed[cur] === gen) continue;
    g.closed[cur] = gen;
    if (cur === t) { found = true; break; }
    if (++expansions > MAX_EXPANSIONS) break;
    const cx = cur % cols, cy = (cur / cols) | 0;
    const gc = g.g[cur];
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= g.rows) continue;
      const j = ny * cols + nx;
      if (!g.pass[j] || g.closed[j] === gen) continue;
      const ng = gc + COST[d];
      if (g.seen[j] === gen && g.g[j] <= ng) continue;
      if (!edgeOpen(g, cur, d)) continue;
      g.seen[j] = gen; g.g[j] = ng; g.parent[j] = cur;
      push(j, ng + h(j));
    }
  }
  if (!found) return null;

  const cells: number[] = [];
  for (let c = t; c !== s && c >= 0; c = g.parent[c]) cells.push(c);
  cells.reverse();
  const out: number[] = [];
  for (let k = 0; k < cells.length - 1; k++) out.push(g.ax[cells[k]], g.ay[cells[k]]);
  out.push(endX, endY);
  return out;
}
