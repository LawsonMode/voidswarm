// RENDER v0.3 M4: wall + minimap seams for rift floors — biome palettes (arena maps unchanged), rift door tiles are
// always doorways for the wall builder (a sealed door's TILE_WALL never becomes wall geometry), the void between
// rooms, and the minimap: door colour, transparent void, faint floor, and room fog (hidden / glimpsed / seen).
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL, type GameMap } from '../../shared/types';
import { buildDemoFloor } from './demoRift';
import { doorTileIndices, fogLevels, fogOwners } from './rift';
import { ARENA_PALETTE, BIOME_PALETTES, buildWalls, minimapPixels, paletteFor, voidMask, wallTiles } from './walls';

function arenaMap(): GameMap {
  const cols = 20, rows = 20;
  const tiles = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c++) { tiles[c] = TILE_WALL; tiles[(rows - 1) * cols + c] = TILE_WALL; }
  tiles[5 * cols + 5] = TILE_ROCK; tiles[5 * cols + 6] = TILE_ROCK;
  tiles[10 * cols + 10] = TILE_BASE;
  return { seed: 1, teamCount: 2, width: cols * 32, height: rows * 32, tileSize: 32, cols, rows, tiles, spawns: [{ team: 0, x: 330, y: 330 }] };
}
const px = (p: Uint8ClampedArray, i: number) => [p[i * 4], p[i * 4 + 1], p[i * 4 + 2], p[i * 4 + 3]];

describe('walls: palettes and door tiles', () => {
  it('arena maps keep the v0.2 palette; rift floors take their biome', () => {
    expect(paletteFor(arenaMap())).toBe(ARENA_PALETTE);
    expect(paletteFor(buildDemoFloor(1, 'hive'))).toBe(BIOME_PALETTES.hive);
    expect(paletteFor(buildDemoFloor(4, 'prism'))).toBe(BIOME_PALETTES.prism);
    expect(ARENA_PALETTE.voidFill).toBeNull();
    expect(BIOME_PALETTES.hive.wallEdge).not.toBe(BIOME_PALETTES.prism.wallEdge);
  });

  it('every rift door tile reads as a doorway, open or sealed', () => {
    const m = buildDemoFloor(1, 'hive');
    const doors = doorTileIndices(m);
    expect(doors.length).toBeGreaterThan(0);
    const sealed: GameMap = { ...m, tiles: new Uint8Array(m.tiles) };
    for (const i of doors) sealed.tiles[i] = TILE_WALL;
    const t = wallTiles(sealed);
    for (const i of doors) expect(t[i]).toBe(TILE_DOOR);
    expect(sealed.tiles[doors[0]]).toBe(TILE_WALL); // the map itself is never touched
    const a = arenaMap();
    expect(wallTiles(a)).toBe(a.tiles); // no doors: the same array
  });

  it('the void: the big rock masses; a room pillar (a small rock island) is never void, not even its core', () => {
    const m = buildDemoFloor(1, 'hive');
    const t = wallTiles(m);
    const v = voidMask(m, t, BIOME_PALETTES.hive)!;
    expect(v[0]).toBe(1); // the top-left corner is deep rock
    // the hive pillar at arena (89, 89): every one of its rock tiles, the core included, keeps the rock look
    let pillarTiles = 0;
    for (let r = 86; r <= 92; r++) for (let c = 86; c <= 92; c++) {
      const i = r * m.cols + c;
      if (m.tiles[i] !== TILE_ROCK) continue;
      pillarTiles++;
      expect(v[i]).toBe(0);
    }
    expect(pillarTiles).toBeGreaterThan(8);
    expect(m.tiles[89 * m.cols + 89]).toBe(TILE_ROCK);
    expect(m.tiles[89 * m.cols + 93]).toBe(TILE_EMPTY);
    expect(voidMask(arenaMap(), arenaMap().tiles, ARENA_PALETTE)).toBeNull();
  });

  it('buildWalls builds chunks for a rift floor and an arena map (node, no renderer)', () => {
    const parent = new Container();
    const chunks = buildWalls(buildDemoFloor(3, 'hive'), parent);
    expect(chunks.length).toBeGreaterThan(0);
    expect(parent.children.length).toBe(chunks.length);
    const a = buildWalls(arenaMap(), new Container());
    expect(a.length).toBeGreaterThan(0);
    for (const c of [...chunks, ...a]) c.g.destroy();
  });
});

describe('minimap pixels', () => {
  it('arena maps: the v0.2 colours, byte for byte', () => {
    const m = arenaMap();
    const p = minimapPixels(m);
    expect(px(p, 0)).toEqual([70, 190, 255, 230]); // wall
    expect(px(p, 5 * 20 + 5)).toEqual([180, 120, 255, 200]); // rock
    expect(px(p, 3 * 20 + 3)).toEqual([0, 0, 0, 0]); // empty
    expect(px(p, 10 * 20 + 10)).toEqual([0xff, 0x3b, 0x5c, 90]); // base: team 0 crimson
  });

  it('rift floors: doors in the door colour (sealed too), a faint floor, the void transparent', () => {
    const m = buildDemoFloor(1, 'hive');
    const pal = BIOME_PALETTES.hive;
    const door = doorTileIndices(m)[0];
    const sealed: GameMap = { ...m, tiles: new Uint8Array(m.tiles) };
    sealed.tiles[door] = TILE_WALL;
    const p = minimapPixels(sealed);
    expect(px(p, door)).toEqual([...pal.mini.door]);
    expect(px(p, 0)[3]).toBe(0); // deep rock
    const arenaCentre = 100 * m.cols + 100;
    expect(px(p, arenaCentre)).toEqual([...pal.mini.floor]);
    const rimWall = 78 * m.cols + 90; // arena north rim
    expect(m.tiles[rimWall]).toBe(TILE_WALL);
    expect(px(p, rimWall)).toEqual([...pal.mini.wall]);
  });

  it('fog: unseen rooms are hidden, glimpsed rooms dimmed to 30%, seen rooms full', () => {
    const m = buildDemoFloor(1, 'hive');
    const L = m.dungeon!;
    const owners = fogOwners(m)!;
    const levels = fogLevels(L, 0b1); // entrance seen; arena + south arena glimpsed; the rest hidden
    const p = minimapPixels(m, { owners, levels });
    const full = minimapPixels(m);
    const tileOf = (x: number, y: number) => Math.floor(y / 32) * m.cols + Math.floor(x / 32);
    const rimOf = (r: typeof L.rooms[number]) => (r.r0 - 1) * m.cols + Math.floor((r.c0 + r.c1) / 2); // a wall tile
    const seenRim = rimOf(L.rooms[0]), glimpsedRim = rimOf(L.rooms[1]), hiddenRim = rimOf(L.rooms[4]);
    expect(px(p, seenRim)[3]).toBe(px(full, seenRim)[3]);
    expect(px(p, glimpsedRim)[3]).toBe(Math.round(px(full, glimpsedRim)[3] * 0.3));
    expect(px(p, hiddenRim)[3]).toBe(0);
    expect(px(p, tileOf(L.rooms[2].x, L.rooms[2].y))[3]).toBe(0); // treasure floor: hidden
  });
});
