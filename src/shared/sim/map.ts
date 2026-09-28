// OWNER: SIM agent. Frozen signatures below.
import { MAP_SIZE, MAP_TILE, MAX_TEAMS } from '../constants';
import { TILE_BASE, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../types';
import type { GameMap, SpawnPoint } from '../types';
import { Rng } from '../util/rng';

// ---------------------------------------------------------------------------------------------
// Generation tuning knobs (tile units unless noted)
// ---------------------------------------------------------------------------------------------
const BORDER = 2;
const ARENA_CLEAR_R = 22; // open central arena
const BASE_RING_PX = 2300; // team bases sit on this ring around the center
const BASE_CLEAR_R = 13;
const BASE_PAD = 8; // TILE_BASE pad size (tiles)
const CLUSTERS = 62; // asteroid clusters
const SEGMENTS = 22; // long wall segments
const FFA_SPAWNS = 20;
const POCKET_KEEP = 350; // unreachable open pockets at least this big get a tunnel instead of being filled

/** Deterministic map from seed. teamCount 0 = FFA layout. Client and server must produce identical maps. */
export function generateMap(seed: number, teamCount: number): GameMap {
  const rng = new Rng(((seed | 0) ^ 0x3c6ef372) >>> 0);
  const tileSize = MAP_TILE;
  const cols = Math.floor(MAP_SIZE / tileSize);
  const rows = cols;
  const tiles = new Uint8Array(cols * rows);
  teamCount = Math.max(0, Math.min(MAX_TEAMS, Math.floor(teamCount) || 0));
  if (teamCount === 1) teamCount = 2;
  const cx = cols / 2, cy = rows / 2;

  const inside = (c: number, r: number) => c >= BORDER && r >= BORDER && c < cols - BORDER && r < rows - BORDER;
  const set = (c: number, r: number, v: number) => { if (inside(c, r)) tiles[r * cols + c] = v; };
  const solid = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return true;
    const t = tiles[r * cols + c];
    return t === TILE_WALL || t === TILE_ROCK;
  };
  const disc = (fx: number, fy: number, rad: number, v: number) => {
    const r2 = rad * rad;
    for (let r = Math.floor(fy - rad); r <= Math.ceil(fy + rad); r++) {
      for (let c = Math.floor(fx - rad); c <= Math.ceil(fx + rad); c++) {
        const dx = c + 0.5 - fx, dy = r + 0.5 - fy;
        if (dx * dx + dy * dy <= r2) set(c, r, v);
      }
    }
  };

  // Team base centers (tile coords)
  const rot = rng.next() * Math.PI * 2;
  const bases: { x: number; y: number; a: number }[] = [];
  const ringT = BASE_RING_PX / tileSize;
  for (let t = 0; t < teamCount; t++) {
    const a = rot + (t * Math.PI * 2) / teamCount;
    bases.push({ x: Math.round(cx + Math.cos(a) * ringT), y: Math.round(cy + Math.sin(a) * ringT), a });
  }

  // 1. Organic asteroid clusters (overlapping jittered discs)
  for (let i = 0; i < CLUSTERS; i++) {
    const kx = rng.range(BORDER + 4, cols - BORDER - 4);
    const ky = rng.range(BORDER + 4, rows - BORDER - 4);
    const size = rng.range(2.5, 7.5);
    const mat = rng.chance(0.3) ? TILE_ROCK : TILE_WALL;
    const blobs = rng.int(3, 7);
    for (let b = 0; b < blobs; b++) {
      disc(kx + rng.range(-size, size), ky + rng.range(-size, size), rng.range(1.2, size * 0.75 + 1), mat);
    }
  }

  // 2. Cellular-automata smoothing for organic edges
  const tmp = new Uint8Array(tiles.length);
  for (let it = 0; it < 2; it++) {
    tmp.set(tiles);
    for (let r = BORDER; r < rows - BORDER; r++) {
      for (let c = BORDER; c < cols - BORDER; c++) {
        let n = 0, rocks = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const t = tmp[(r + dy) * cols + c + dx];
            if (t === TILE_WALL || t === TILE_ROCK) { n++; if (t === TILE_ROCK) rocks++; }
          }
        }
        const i = r * cols + c;
        const was = tmp[i] === TILE_WALL || tmp[i] === TILE_ROCK;
        if (!was && n >= 5) tiles[i] = rocks * 2 > n ? TILE_ROCK : TILE_WALL;
        else if (was && n <= 2) tiles[i] = TILE_EMPTY;
      }
    }
  }

  // 3. Long wall segments / corridors (mostly axis-aligned, some diagonal, some L-shaped)
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let i = 0; i < SEGMENTS; i++) {
    let x = rng.int(BORDER + 6, cols - BORDER - 7);
    let y = rng.int(BORDER + 6, rows - BORDER - 7);
    let d = DIRS[rng.chance(0.75) ? rng.int(0, 3) : rng.int(4, 7)];
    const legs = rng.chance(0.4) ? 2 : 1;
    for (let leg = 0; leg < legs; leg++) {
      const length = rng.int(8, 26);
      for (let s = 0; s < length; s++) {
        set(x, y, TILE_WALL); set(x + 1, y, TILE_WALL); set(x, y + 1, TILE_WALL); set(x + 1, y + 1, TILE_WALL);
        x += d[0]; y += d[1];
      }
      d = [-d[1], d[0]]; // turn 90°
      if (rng.chance(0.5)) d = [-d[0], -d[1]];
    }
  }

  // 4. Clear the central arena and team base areas
  disc(cx, cy, ARENA_CLEAR_R, TILE_EMPTY);
  for (const b of bases) disc(b.x, b.y, BASE_CLEAR_R, TILE_EMPTY);

  // 5. Symmetric central structure: n arcs + inner pillars
  const n = teamCount >= 3 ? teamCount : 4;
  const off = teamCount >= 2 ? rot + Math.PI / n : rot;
  for (let k = 0; k < n; k++) {
    const a = off + (k * Math.PI * 2) / n;
    for (let s = -6; s <= 6; s++) {
      const aa = a + s * 0.045;
      disc(cx + Math.cos(aa) * 14, cy + Math.sin(aa) * 14, 1.1, TILE_WALL);
    }
    const pa = a + Math.PI / n;
    disc(cx + Math.cos(pa) * 7, cy + Math.sin(pa) * 7, 1.6, TILE_ROCK);
  }

  // 6. Team base pads + spawns; a couple of cover walls facing the center
  const spawns: SpawnPoint[] = [];
  const half = BASE_PAD / 2;
  bases.forEach((b, team) => {
    for (let r = b.y - half; r < b.y + half; r++) for (let c = b.x - half; c < b.x + half; c++) set(c, r, TILE_BASE);
    const offs = [[-2, -2], [2, -2], [-2, 2], [2, 2], [0, -2.5], [0, 2.5]];
    for (const [ox, oy] of offs) spawns.push({ team, x: (b.x + ox) * tileSize, y: (b.y + oy) * tileSize });
    // cover: short wall on the center-facing side, off-axis so the base isn't sealed
    const ux = Math.cos(b.a + Math.PI), uy = Math.sin(b.a + Math.PI);
    const px = -uy, py = ux;
    for (const side of [-1, 1]) {
      for (let s = 0; s < 4; s++) {
        disc(b.x + ux * 10 + px * (side * (4 + s)), b.y + uy * 10 + py * (side * (4 + s)), 0.9, TILE_WALL);
      }
    }
  });

  // 7. Solid border
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c < BORDER || r < BORDER || c >= cols - BORDER || r >= rows - BORDER) tiles[r * cols + c] = TILE_WALL;
    }
  }

  // 8. FFA spawns in clear space
  if (teamCount === 0) {
    const clear = (c: number, r: number, rad: number) => {
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) if (solid(c + dx, r + dy)) return false;
      return true;
    };
    let minD = 26;
    const pts: { c: number; r: number }[] = [];
    for (let attempt = 0; attempt < 6000 && pts.length < FFA_SPAWNS; attempt++) {
      if (attempt > 0 && attempt % 1500 === 0) minD *= 0.75;
      const c = rng.int(BORDER + 6, cols - BORDER - 7);
      const r = rng.int(BORDER + 6, rows - BORDER - 7);
      const dcx = c - cx, dcy = r - cy;
      if (dcx * dcx + dcy * dcy < 16 * 16) continue; // keep the very middle for fighting
      if (!clear(c, r, 3)) continue;
      let ok = true;
      for (const p of pts) { const dx = p.c - c, dy = p.r - r; if (dx * dx + dy * dy < minD * minD) { ok = false; break; } }
      if (ok) pts.push({ c, r });
    }
    for (const p of pts) spawns.push({ team: -1, x: (p.c + 0.5) * tileSize, y: (p.r + 0.5) * tileSize });
    if (spawns.length === 0) spawns.push({ team: -1, x: cx * tileSize, y: cy * tileSize });
  }

  // 9. Connectivity: everything reachable from the center; tunnel to spawns/big pockets, fill the rest.
  ensureConnected(tiles, cols, rows, Math.floor(cx), Math.floor(cy), spawns, tileSize, set, solid);

  return { seed, teamCount, width: cols * tileSize, height: rows * tileSize, tileSize, cols, rows, tiles, spawns };
}

function ensureConnected(
  tiles: Uint8Array, cols: number, rows: number, sc: number, sr: number, spawns: SpawnPoint[], ts: number,
  set: (c: number, r: number, v: number) => void, solid: (c: number, r: number) => boolean,
): void {
  const label = new Int32Array(tiles.length);
  const queue = new Int32Array(tiles.length);
  const flood = (start: number, id: number): number => {
    let head = 0, tail = 0, count = 0;
    queue[tail++] = start; label[start] = id;
    while (head < tail) {
      const i = queue[head++]; count++;
      const c = i % cols, r = (i - c) / cols;
      if (c > 0) push(i - 1); if (c < cols - 1) push(i + 1);
      if (r > 0) push(i - cols); if (r < rows - 1) push(i + cols);
    }
    return count;
    function push(j: number) {
      if (label[j] !== 0) return;
      const t = tiles[j];
      if (t === TILE_WALL || t === TILE_ROCK) return;
      label[j] = id; queue[tail++] = j;
    }
  };
  const carveToCenter = (c0: number, r0: number) => {
    const dx = sc - c0, dy = sr - r0;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2) || 1;
    for (let s = 0; s <= steps; s++) {
      const fx = c0 + (dx * s) / steps + 0.5, fy = r0 + (dy * s) / steps + 0.5;
      const cc = Math.floor(fx), rr = Math.floor(fy);
      if (label[rr * cols + cc] === 1 && s > 2) break; // reached the main region
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (solid(cc + ox, rr + oy)) set(cc + ox, rr + oy, TILE_EMPTY);
      }
    }
  };

  const start = sr * cols + sc;
  if (solid(sc, sr)) set(sc, sr, TILE_EMPTY);
  for (let pass = 0; pass < 12; pass++) {
    label.fill(0);
    flood(start, 1);
    let changed = false;
    // spawns first
    for (const sp of spawns) {
      const c = Math.floor(sp.x / ts), r = Math.floor(sp.y / ts);
      if (label[r * cols + c] !== 1) { carveToCenter(c, r); changed = true; }
    }
    if (changed) continue;
    // label other pockets
    let nextId = 2;
    for (let i = 0; i < tiles.length; i++) {
      if (label[i] !== 0) continue;
      const t = tiles[i];
      if (t === TILE_WALL || t === TILE_ROCK) continue;
      const id = nextId++;
      const size = flood(i, id);
      if (size >= POCKET_KEEP) {
        const c = i % cols;
        carveToCenter(c, (i - c) / cols);
        changed = true;
      }
    }
    if (changed) continue;
    // fill every remaining unreachable open tile
    for (let i = 0; i < tiles.length; i++) {
      if (label[i] > 1) tiles[i] = TILE_ROCK;
    }
    return;
  }
  // Fallback (should not happen): fill whatever is still disconnected.
  label.fill(0);
  flood(start, 1);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (label[i] !== 1 && t !== TILE_WALL && t !== TILE_ROCK) tiles[i] = TILE_ROCK;
  }
}

/**
 * v0.3 (§8.8): make every point (world px) reachable from the map centre, keeping every spawn reachable too.
 * Wraps the generator's ensureConnected pass: a disconnected point gets a 3-tile tunnel toward the centre,
 * large unreachable open pockets get tunnels, and small ones are filled with TILE_ROCK. Only solid tiles
 * are carved, so TILE_BASE pads are never touched, and the BORDER ring stays solid (points are clamped
 * inside it). No randomness: the same map + points give the same tiles on both hosts. Generation-time
 * only (placeObjectiveFeatures), so it does not bump map.rev.
 */
export function connectPoints(map: GameMap, points: { x: number; y: number }[]): void {
  const { tiles, cols, rows, tileSize } = map;
  const inside = (c: number, r: number) => c >= BORDER && r >= BORDER && c < cols - BORDER && r < rows - BORDER;
  const set = (c: number, r: number, v: number) => { if (inside(c, r)) tiles[r * cols + c] = v; };
  const solid = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return true;
    const t = tiles[r * cols + c];
    return t === TILE_WALL || t === TILE_ROCK;
  };
  const lo = (BORDER + 1) * tileSize, hiX = (cols - BORDER - 1) * tileSize - 1, hiY = (rows - BORDER - 1) * tileSize - 1;
  const targets: SpawnPoint[] = map.spawns.slice();
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    targets.push({ team: -1, x: Math.max(lo, Math.min(hiX, p.x)), y: Math.max(lo, Math.min(hiY, p.y)) });
  }
  ensureConnected(tiles, cols, rows, Math.floor(cols / 2), Math.floor(rows / 2), targets, tileSize, set, solid);
}

/** Tile value at (col,row); out of bounds = TILE_WALL. */
export function tileAt(map: GameMap, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return TILE_WALL;
  return map.tiles[row * map.cols + col];
}

function solidTile(map: GameMap, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
  const t = map.tiles[row * map.cols + col];
  return t === TILE_WALL || t === TILE_ROCK;
}

/** True if world point (x,y) is inside a solid tile (TILE_WALL or TILE_ROCK) or outside the map. */
export function isSolidAt(map: GameMap, x: number, y: number): boolean {
  if (!(x >= 0 && y >= 0 && x < map.width && y < map.height)) return true;
  return solidTile(map, Math.floor(x / map.tileSize), Math.floor(y / map.tileSize));
}

/** Deep-embed rescue search radius (tiles) for collideCircle. */
const EMBED_SEARCH_TILES = 12;

/** Nearest non-solid in-map tile to (col, row) by square rings (fixed scan order: deterministic), or null. */
function nearestOpenTile(map: GameMap, col: number, row: number, maxRing: number): { col: number; row: number } | null {
  for (let k = 1; k <= maxRing; k++) {
    let best: { col: number; row: number } | null = null, bestD = Infinity;
    for (let r = row - k; r <= row + k; r++) {
      for (let c = col - k; c <= col + k; c++) {
        if (Math.max(Math.abs(c - col), Math.abs(r - row)) !== k) continue;
        if (c < 0 || r < 0 || c >= map.cols || r >= map.rows || solidTile(map, c, r)) continue;
        const d = (c - col) * (c - col) + (r - row) * (r - row);
        if (d < bestD) { bestD = d; best = { col: c, row: r }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Resolve a circle against solid tiles. Returns the corrected position and, if a collision happened,
 * the collision normal (unit vector pointing out of the wall). Pure function.
 */
export function collideCircle(
  map: GameMap, x: number, y: number, r: number,
): { x: number; y: number; hit: boolean; nx: number; ny: number } {
  const ts = map.tileSize;
  let hit = false, nx = 0, ny = 0;
  // Deep embed (the centre inside a solid tile whose four neighbours are solid too, e.g. a body shoved into rift
  // rock): pushing out face by face would chain across the solid mass every call and march the body off the map.
  // Rescue it once to the nearest open tile instead (deterministic ring search), then resolve normally there.
  const cc = Math.floor(x / ts), cr = Math.floor(y / ts);
  if (solidTile(map, cc, cr) && solidTile(map, cc - 1, cr) && solidTile(map, cc + 1, cr) &&
    solidTile(map, cc, cr - 1) && solidTile(map, cc, cr + 1)) {
    const open = nearestOpenTile(map, cc, cr, EMBED_SEARCH_TILES);
    if (open) {
      x = (open.col + 0.5) * ts; y = (open.row + 0.5) * ts;
      hit = true;
    } else {
      x = Math.max(r, Math.min(map.width - r, x));
      y = Math.max(r, Math.min(map.height - r, y));
    }
  }
  const c0 = Math.floor((x - r) / ts), c1 = Math.floor((x + r) / ts);
  const r0 = Math.floor((y - r) / ts), r1 = Math.floor((y + r) / ts);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (!solidTile(map, col, row)) continue;
      const tx0 = col * ts, ty0 = row * ts, tx1 = tx0 + ts, ty1 = ty0 + ts;
      const px = x < tx0 ? tx0 : x > tx1 ? tx1 : x;
      const py = y < ty0 ? ty0 : y > ty1 ? ty1 : y;
      const dx = x - px, dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      let ux: number, uy: number;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        ux = dx / d; uy = dy / d;
        x = px + ux * r; y = py + uy * r;
      } else {
        // center inside the tile: exit through the nearest open face
        let best = Infinity; ux = 0; uy = -1;
        const cand = [
          [x - tx0, -1, 0, col - 1, row], [tx1 - x, 1, 0, col + 1, row],
          [y - ty0, 0, -1, col, row - 1], [ty1 - y, 0, 1, col, row + 1],
        ];
        for (const [pen, cx, cy, nc, nr] of cand) {
          const p = pen + (solidTile(map, nc, nr) ? ts * 4 : 0);
          if (p < best) { best = p; ux = cx; uy = cy; }
        }
        if (ux < 0) x = tx0 - r; else if (ux > 0) x = tx1 + r;
        else if (uy < 0) y = ty0 - r; else y = ty1 + r;
      }
      nx += ux; ny += uy; hit = true;
    }
  }
  if (hit) {
    const l = Math.sqrt(nx * nx + ny * ny);
    if (l > 1e-9) { nx /= l; ny /= l; } else { nx = 0; ny = 0; }
  }
  return { x, y, hit, nx, ny };
}

/** True if the straight segment (x0,y0)->(x1,y1) crosses no solid tile (line of sight). */
export function lineOfSight(map: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const ts = map.tileSize;
  let col = Math.floor(x0 / ts), row = Math.floor(y0 / ts);
  const endCol = Math.floor(x1 / ts), endRow = Math.floor(y1 / ts);
  const dx = x1 - x0, dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? ts / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? ts / Math.abs(dy) : Infinity;
  let tMaxX = dx > 0 ? ((col + 1) * ts - x0) / dx : dx < 0 ? (x0 - col * ts) / -dx : Infinity;
  let tMaxY = dy > 0 ? ((row + 1) * ts - y0) / dy : dy < 0 ? (y0 - row * ts) / -dy : Infinity;
  const maxIter = map.cols + map.rows + 4;
  for (let i = 0; i < maxIter; i++) {
    if (solidTile(map, col, row)) return false;
    if (col === endCol && row === endRow) return true;
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) return true;
      col += stepX; tMaxX += tDeltaX;
    } else {
      if (tMaxY > 1) return true;
      row += stepY; tMaxY += tDeltaY;
    }
  }
  return true;
}
