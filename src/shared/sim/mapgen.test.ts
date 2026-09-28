// SIM v0.3 M1: buildMatchMap (arena / warzone path) and map.connectPoints.
import { describe, expect, it } from 'vitest';
import { MAP_TILE } from '../constants';
import type { GameMap, SubMode } from '../types';
import { TILE_BASE, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../types';
import { connectPoints, generateMap, tileAt } from './map';
import { buildMatchMap } from './mapgen';

const BORDER = 2;

/** Open tiles reachable (4-neighbour) from the map centre. */
function reachable(map: GameMap): Uint8Array {
  const seen = new Uint8Array(map.tiles.length);
  const start = Math.floor(map.rows / 2) * map.cols + Math.floor(map.cols / 2);
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop()!;
    const c = i % map.cols, r = (i - c) / map.cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      const t = tileAt(map, nc, nr);
      const j = nr * map.cols + nc;
      if (t === TILE_WALL || t === TILE_ROCK || seen[j]) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return seen;
}
const idx = (m: GameMap, x: number, y: number) => Math.floor(y / m.tileSize) * m.cols + Math.floor(x / m.tileSize);
const countTiles = (m: GameMap, v: number) => m.tiles.reduce((n, t) => n + (t === v ? 1 : 0), 0);
function borderIntact(m: GameMap): boolean {
  for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
    if ((c < BORDER || r < BORDER || c >= m.cols - BORDER || r >= m.rows - BORDER) && m.tiles[r * m.cols + c] !== TILE_WALL) return false;
  }
  return true;
}
const cloneMap = (m: GameMap): GameMap => ({ ...m, tiles: m.tiles.slice(), spawns: m.spawns.map((s) => ({ ...s })) });

describe('buildMatchMap (arena / warzone)', () => {
  it('deathmatch maps are byte-identical to v0.2 generateMap (FFA and 2/4/8 teams)', () => {
    for (const gameType of ['arena', 'warzone'] as const) {
      for (const teamCount of [0, 2, 4, 8]) {
        const seed = 9000 + teamCount;
        const a = buildMatchMap({ seed, gameType, subMode: 'deathmatch', teamCount, floor: 0 });
        const b = generateMap(seed, teamCount);
        expect(a.tiles).toEqual(b.tiles);
        expect(a.spawns).toEqual(b.spawns);
        expect([a.width, a.height, a.cols, a.rows, a.tileSize, a.teamCount, a.seed])
          .toEqual([b.width, b.height, b.cols, b.rows, b.tileSize, b.teamCount, b.seed]);
        expect(a.features).toBeUndefined();
        expect(a.dungeon).toBeUndefined();
      }
    }
  });

  it('is deterministic (same params → same tiles), and the seed matters', () => {
    const p = { seed: 31337, gameType: 'warzone' as const, subMode: 'deathmatch' as SubMode, teamCount: 3, floor: 0 };
    const a = buildMatchMap(p), b = buildMatchMap({ ...p });
    expect(a.tiles).toEqual(b.tiles);
    expect(a.spawns).toEqual(b.spawns);
    expect(buildMatchMap({ ...p, seed: 31338 }).tiles).not.toEqual(a.tiles);
  });

  it('sanitizes a junk teamCount like generateMap (NaN / negative → FFA layout)', () => {
    const ffa = generateMap(5, 0);
    for (const teamCount of [NaN, -3]) {
      expect(buildMatchMap({ seed: 5, gameType: 'arena', subMode: 'deathmatch', teamCount, floor: 0 }).tiles).toEqual(ffa.tiles);
    }
  });

  it('dungeon maps keep the fixed full-size grid (rift floors must not resize world.grid)', () => {
    const ref = generateMap(1, 2);
    const d = buildMatchMap({ seed: 1234, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 1 });
    expect([d.cols, d.rows, d.tileSize, d.width, d.height]).toEqual([ref.cols, ref.rows, ref.tileSize, ref.width, ref.height]);
  });
});

describe('connectPoints', () => {
  it('is a no-op on a generated map whose points are already reachable', () => {
    const m = generateMap(42, 2);
    const before = m.tiles.slice();
    const seen = reachable(m);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < m.tiles.length && pts.length < 6; i += 997) {
      if (seen[i]) pts.push({ x: ((i % m.cols) + 0.5) * m.tileSize, y: (Math.floor(i / m.cols) + 0.5) * m.tileSize });
    }
    expect(pts.length).toBe(6);
    connectPoints(m, pts);
    expect(m.tiles).toEqual(before);
  });

  it('tunnels a sealed pocket that holds a point, fills a small one that does not; base + border untouched', () => {
    const m = generateMap(7, 2);
    const ts = m.tileSize;
    const bases0 = countTiles(m, TILE_BASE);
    // Two sealed pockets: rock blocks with an open 3×3 core, near opposite corners.
    const pocket = (c0: number, r0: number) => {
      for (let r = r0 - 3; r <= r0 + 3; r++) for (let c = c0 - 3; c <= c0 + 3; c++) m.tiles[r * m.cols + c] = TILE_ROCK;
      for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) m.tiles[r * m.cols + c] = TILE_EMPTY;
    };
    const A = { c: 12, r: 12 }, B = { c: m.cols - 13, r: m.rows - 13 };
    pocket(A.c, A.r); pocket(B.c, B.r);
    const pa = { x: (A.c + 0.5) * ts, y: (A.r + 0.5) * ts };
    const pb = { x: (B.c + 0.5) * ts, y: (B.r + 0.5) * ts };
    expect(reachable(m)[idx(m, pa.x, pa.y)]).toBe(0);

    const copy = cloneMap(m);
    connectPoints(m, [pa]);
    const seen = reachable(m);
    expect(seen[idx(m, pa.x, pa.y)]).toBe(1); // tunnelled to the centre
    expect(m.tiles[idx(m, pb.x, pb.y)]).toBe(TILE_ROCK); // small unreachable pocket filled
    for (const s of m.spawns) expect(seen[idx(m, s.x, s.y)]).toBe(1);
    expect(countTiles(m, TILE_BASE)).toBe(bases0);
    expect(borderIntact(m)).toBe(true);
    // no unreachable open tile remains anywhere
    for (let i = 0; i < m.tiles.length; i++) {
      if (m.tiles[i] !== TILE_WALL && m.tiles[i] !== TILE_ROCK) expect(seen[i]).toBe(1);
    }
    // deterministic: the same map + points carve the same tiles
    connectPoints(copy, [pa]);
    expect(copy.tiles).toEqual(m.tiles);
  });

  it('clamps points inside the border and ignores non-finite ones', () => {
    const m = generateMap(3, 4);
    expect(() => connectPoints(m, [{ x: -500, y: 10 }, { x: 1e9, y: 1e9 }, { x: NaN, y: 4 }, { x: 0, y: Infinity }])).not.toThrow();
    expect(borderIntact(m)).toBe(true);
    const seen = reachable(m);
    const lo = (BORDER + 1) * MAP_TILE, hi = (m.cols - BORDER - 1) * MAP_TILE - 1;
    expect(seen[idx(m, lo, lo)]).toBe(1);
    expect(seen[idx(m, hi, hi)]).toBe(1);
  });
});
