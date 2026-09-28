// Wall geometry: merges solid tiles into edge runs (no per-tile sprites), chunked for culling.
// Also builds the 1-px-per-tile minimap canvas.
// v0.3 M4 (rift floors): biome palettes (hive / prism; arena maps keep the v0.2 palette byte-for-byte), rift door
// tiles always read as doorways (a sealed door holds TILE_WALL, but its force field is the rift layer's job, so the
// wall chunks never rebuild mid-floor), deep "void" rock (no open tile beside it) as a flat dark fill without hatch
// or edges, a static door plate, and a minimap with a door colour, transparent void and room fog.
import { Container, Graphics } from 'pixi.js';
import { TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL, type GameMap, type RiftBiome } from '../../shared/types';
import { TEAM_COLORS } from '../../shared/data/teams';
import {
  GRID_COLOR, GRID_HOT, GRID_MAJOR, ROCK_EDGE, ROCK_HALO, WALL_EDGE, WALL_FILL, WALL_HALO, brighten, darken,
} from './palette';
import { doorGeoms, doorTileIndices } from './rift';

export const CHUNK = 1024;

export interface WallChunk { g: Graphics; x: number; y: number; w: number; h: number }

type RGBA = readonly [number, number, number, number];

/** Wall / rock / door / minimap / spring-grid colours of one map look. */
export interface WallPalette {
  wallEdge: number; wallHalo: number; wallFill: number;
  rockEdge: number; rockHalo: number; rockFill: number;
  /** Deep rock (no open tile 8-adjacent) fill; null = every rock is drawn alike (arena maps). */
  voidFill: number | null;
  /** Idle door jamb / plate colour (the rift layer tints it by room state). */
  door: number;
  mini: { wall: RGBA; rock: RGBA; door: RGBA; floor: RGBA };
  grid: { minor: number; major: number; hot: number };
}

/** v0.2 arena look (unchanged). */
export const ARENA_PALETTE: WallPalette = {
  wallEdge: WALL_EDGE, wallHalo: WALL_HALO, wallFill: WALL_FILL,
  rockEdge: ROCK_EDGE, rockHalo: ROCK_HALO, rockFill: darken(0x2a1030, 0.2),
  voidFill: null,
  door: 0xffe27a,
  mini: { wall: [70, 190, 255, 230], rock: [180, 120, 255, 200], door: [255, 226, 122, 255], floor: [0, 0, 0, 0] },
  grid: { minor: GRID_COLOR, major: GRID_MAJOR, hot: GRID_HOT },
};

/** Rift biomes (§4.1: palette and pillar style only). hive = amber chitin, prism = ice crystal. */
export const BIOME_PALETTES: Readonly<Record<RiftBiome, WallPalette>> = {
  hive: {
    wallEdge: 0xffa94d, wallHalo: 0xff4f7a, wallFill: 0x120806,
    rockEdge: 0xe0784a, rockHalo: 0xff5a8a, rockFill: 0x1c0c0a,
    voidFill: 0x0a0504,
    door: 0xffe27a,
    mini: { wall: [255, 169, 77, 230], rock: [224, 120, 74, 210], door: [255, 240, 170, 255], floor: [255, 169, 77, 22] },
    grid: { minor: 0x3a1f18, major: 0x6e3424, hot: 0xffa94d },
  },
  prism: {
    wallEdge: 0x9ff4ff, wallHalo: 0x8f6bff, wallFill: 0x060a1c,
    rockEdge: 0xdfe8ff, rockHalo: 0x7fe3ff, rockFill: 0x0a1026,
    voidFill: 0x04050d,
    door: 0xfff0a0,
    mini: { wall: [159, 244, 255, 230], rock: [223, 232, 255, 210], door: [255, 240, 170, 255], floor: [159, 244, 255, 20] },
    grid: { minor: 0x1a2250, major: 0x2f4a9a, hot: 0x9ff4ff },
  },
};

export function paletteFor(map: GameMap): WallPalette {
  const b = map.dungeon?.biome;
  return (b && BIOME_PALETTES[b]) || ARENA_PALETTE;
}

const isSolid = (t: number) => t === TILE_WALL || t === TILE_ROCK;

/**
 * Tiles as the wall builder sees them: every rift door tile reads as TILE_DOOR (open or sealed), so a sealed door's
 * TILE_WALL never becomes wall geometry. Returns map.tiles itself when the map has no doors.
 */
export function wallTiles(map: GameMap): Uint8Array {
  const doors = doorTileIndices(map);
  if (!doors.length) return map.tiles;
  const t = new Uint8Array(map.tiles);
  for (const i of doors) if (i >= 0 && i < t.length) t[i] = TILE_DOOR;
  return t;
}

/** Rock masses at least this big (tiles, 4-connected) are the rift void; smaller ones are pillars. */
export const VOID_MIN_TILES = 64;

/**
 * Rift maps only: 1 = rock of a large 4-connected rock mass (the void between rooms and outside them), else 0, so
 * room pillars (hive: rock discs of r ≤ 2.8 tiles) keep their rock look. Null on maps without a void fill (arena
 * maps draw all rock alike).
 */
export function voidMask(map: GameMap, tiles: Uint8Array, pal: WallPalette): Uint8Array | null {
  if (pal.voidFill === null) return null;
  const { cols, rows } = map;
  const n = cols * rows;
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || tiles[s] !== TILE_ROCK) continue;
    comp.length = 0;
    let sp = 0;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const i = stack[--sp];
      comp.push(i);
      const c = i % cols;
      if (c > 0 && !seen[i - 1] && tiles[i - 1] === TILE_ROCK) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (c < cols - 1 && !seen[i + 1] && tiles[i + 1] === TILE_ROCK) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= cols && !seen[i - cols] && tiles[i - cols] === TILE_ROCK) { seen[i - cols] = 1; stack[sp++] = i - cols; }
      if (i + cols < n && !seen[i + cols] && tiles[i + cols] === TILE_ROCK) { seen[i + cols] = 1; stack[sp++] = i + cols; }
    }
    if (comp.length >= VOID_MIN_TILES) for (const i of comp) out[i] = 1;
  }
  return out;
}

/** team color (or neutral) per TILE_BASE tile, nearest spawn with team >= 0. */
function baseColors(map: GameMap): Map<number, number> {
  const out = new Map<number, number>();
  const sp = map.spawns.filter((s) => s.team >= 0);
  const ts = map.tileSize;
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i] !== TILE_BASE) continue;
    const x = (i % map.cols + 0.5) * ts, y = (Math.floor(i / map.cols) + 0.5) * ts;
    let best = -1, bd = Infinity;
    for (const s of sp) { const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = s.team; } }
    out.set(i, best >= 0 ? TEAM_COLORS[best % TEAM_COLORS.length] : 0xc8d0ff);
  }
  return out;
}

export function buildWalls(map: GameMap, parent: Container): WallChunk[] {
  const { cols, rows } = map;
  const tiles = wallTiles(map);
  const pal = paletteFor(map);
  const voids = voidMask(map, tiles, pal);
  const ts = map.tileSize;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? TILE_WALL : tiles[r * cols + c]);
  const isVoid = (c: number, r: number) => !!voids && c >= 0 && r >= 0 && c < cols && r < rows && voids[r * cols + c] === 1;
  const tilesPerChunk = Math.max(1, Math.floor(CHUNK / ts));
  const ccols = Math.ceil(cols / tilesPerChunk), crows = Math.ceil(rows / tilesPerChunk);
  const bases = baseColors(map);
  const doors = doorGeoms(map);
  const chunks: WallChunk[] = [];

  for (let cr = 0; cr < crows; cr++) {
    for (let cc = 0; cc < ccols; cc++) {
      const tc0 = cc * tilesPerChunk, tc1 = Math.min(cols, tc0 + tilesPerChunk);
      const tr0 = cr * tilesPerChunk, tr1 = Math.min(rows, tr0 + tilesPerChunk);
      const g = new Graphics();
      let has = false;

      // --- base pads: tinted fill + dots, grouped by color
      const byColor = new Map<number, number[]>();
      for (let r = tr0; r < tr1; r++) for (let c = tc0; c < tc1; c++) {
        const i = r * cols + c;
        const col = bases.get(i);
        if (col === undefined) continue;
        let arr = byColor.get(col); if (!arr) byColor.set(col, (arr = []));
        arr.push(c, r);
      }
      for (const [col, arr] of byColor) {
        for (let k = 0; k < arr.length; k += 2) g.rect(arr[k] * ts, arr[k + 1] * ts, ts, ts);
        g.fill({ color: col, alpha: 0.07 });
        for (let k = 0; k < arr.length; k += 2) {
          if ((arr[k] + arr[k + 1]) % 2) continue;
          g.rect(arr[k] * ts + ts / 2 - 1.5, arr[k + 1] * ts + ts / 2 - 1.5, 3, 3);
        }
        g.fill({ color: col, alpha: 0.35 });
        // base region outline
        for (let k = 0; k < arr.length; k += 2) {
          const c = arr[k], r = arr[k + 1];
          if (at(c, r - 1) !== TILE_BASE && !isSolid(at(c, r - 1))) { g.moveTo(c * ts, r * ts); g.lineTo((c + 1) * ts, r * ts); }
          if (at(c, r + 1) !== TILE_BASE && !isSolid(at(c, r + 1))) { g.moveTo(c * ts, (r + 1) * ts); g.lineTo((c + 1) * ts, (r + 1) * ts); }
          if (at(c - 1, r) !== TILE_BASE && !isSolid(at(c - 1, r))) { g.moveTo(c * ts, r * ts); g.lineTo(c * ts, (r + 1) * ts); }
          if (at(c + 1, r) !== TILE_BASE && !isSolid(at(c + 1, r))) { g.moveTo((c + 1) * ts, r * ts); g.lineTo((c + 1) * ts, (r + 1) * ts); }
        }
        g.stroke({ width: 1.5, color: col, alpha: 0.55 });
        has = true;
      }

      // --- rift void: a flat dark fill (row runs), no hatch, never an edge (it only ever borders other solids)
      if (voids && pal.voidFill !== null) {
        let any = false;
        for (let r = tr0; r < tr1; r++) {
          let c = tc0;
          while (c < tc1) {
            if (!isVoid(c, r)) { c++; continue; }
            const s = c;
            while (c < tc1 && isVoid(c, r)) c++;
            g.rect(s * ts, r * ts, (c - s) * ts, ts);
            any = true;
          }
        }
        if (any) { g.fill({ color: pal.voidFill, alpha: 0.96 }); has = true; }
      }

      // --- solid fill (row runs) + hatch
      for (const kind of [TILE_WALL, TILE_ROCK]) {
        const here = (c: number, r: number) => at(c, r) === kind && !isVoid(c, r);
        let any = false;
        for (let r = tr0; r < tr1; r++) {
          let c = tc0;
          while (c < tc1) {
            if (!here(c, r)) { c++; continue; }
            const s = c;
            while (c < tc1 && here(c, r)) c++;
            g.rect(s * ts, r * ts, (c - s) * ts, ts);
            any = true;
          }
        }
        if (any) {
          g.fill({ color: kind === TILE_ROCK ? pal.rockFill : pal.wallFill, alpha: 0.92 });
          has = true;
          let hatch = false;
          for (let r = tr0; r < tr1; r++) for (let c = tc0; c < tc1; c++) {
            if (!here(c, r) || (c + r) % 3 !== 0) continue;
            g.moveTo(c * ts, (r + 1) * ts); g.lineTo((c + 1) * ts, r * ts); hatch = true;
          }
          if (hatch) g.stroke({ width: 1, color: kind === TILE_ROCK ? pal.rockEdge : pal.wallEdge, alpha: 0.09 });
        }
      }

      // --- rift door plates (static): a faint floor plate across each doorway owned by this chunk
      for (const d of doors) {
        if (d.c0 < tc0 || d.c0 >= tc1 || d.r0 < tr0 || d.r0 >= tr1) continue;
        g.rect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0).fill({ color: pal.door, alpha: 0.05 });
        const inset = 6;
        if (d.alongX) { g.moveTo(d.x0 + inset, d.cy).lineTo(d.x1 - inset, d.cy); }
        else { g.moveTo(d.cx, d.y0 + inset).lineTo(d.cx, d.y1 - inset); }
        g.stroke({ width: 1, color: pal.door, alpha: 0.12 });
        has = true;
      }

      // --- edges: horizontal & vertical merged runs, per kind of the solid side
      for (const kind of [TILE_WALL, TILE_ROCK]) {
        const path = () => {
          let any = false;
          // horizontal boundaries at y = r*ts, between rows r-1 and r
          for (let r = tr0; r <= tr1; r++) {
            if (r === tr1 && tr1 !== rows) continue; // owned by next chunk
            let c = tc0;
            while (c < tc1) {
              const edgeHere = (cc2: number) => {
                const a = at(cc2, r - 1), b = at(cc2, r);
                return isSolid(a) !== isSolid(b) && (isSolid(a) ? a : b) === kind && inMap(cc2, r - 1, r);
              };
              if (!edgeHere(c)) { c++; continue; }
              const s = c;
              while (c < tc1 && edgeHere(c)) c++;
              g.moveTo(s * ts, r * ts); g.lineTo(c * ts, r * ts); any = true;
            }
          }
          for (let c = tc0; c <= tc1; c++) {
            if (c === tc1 && tc1 !== cols) continue;
            let r = tr0;
            while (r < tr1) {
              const edgeHere = (rr: number) => {
                const a = at(c - 1, rr), b = at(c, rr);
                return isSolid(a) !== isSolid(b) && (isSolid(a) ? a : b) === kind;
              };
              if (!edgeHere(r)) { r++; continue; }
              const s = r;
              while (r < tr1 && edgeHere(r)) r++;
              g.moveTo(c * ts, s * ts); g.lineTo(c * ts, r * ts); any = true;
            }
          }
          return any;
        };
        const inMap = (_c: number, _r0: number, _r1: number) => true;
        const edge = kind === TILE_ROCK ? pal.rockEdge : pal.wallEdge;
        const halo = kind === TILE_ROCK ? pal.rockHalo : pal.wallHalo;
        if (path()) {
          g.stroke({ width: 9, color: halo, alpha: 0.13, cap: 'round', join: 'round' });
          path(); g.stroke({ width: 4, color: edge, alpha: 0.35, cap: 'round' });
          path(); g.stroke({ width: 1.6, color: brighten(edge, 0.55), alpha: 1, cap: 'round' });
          has = true;
        }
      }

      if (!has) { g.destroy(); continue; }
      parent.addChild(g);
      chunks.push({ g, x: tc0 * ts, y: tr0 * ts, w: (tc1 - tc0) * ts, h: (tr1 - tr0) * ts });
    }
  }
  return chunks;
}

/** Minimap fog (rift floors): per-tile owner room + per-room level (2 seen, 1 glimpsed at 30%, 0 hidden). */
export interface MinimapFog { owners: Int8Array; levels: ArrayLike<number> }

/**
 * RGBA pixels (1 per tile) for the radar / big map. Arena maps are unchanged from v0.2. Rift maps: biome colours,
 * doors (open or sealed) in the door colour, a faint floor, the void transparent, and fog applied per owner room.
 */
export function minimapPixels(map: GameMap, fog?: MinimapFog | null): Uint8ClampedArray {
  const tiles = wallTiles(map);
  const pal = paletteFor(map);
  const voids = voidMask(map, tiles, pal);
  const bases = baseColors(map);
  const px = new Uint8ClampedArray(map.cols * map.rows * 4);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    let rgba: RGBA = pal.mini.floor;
    if (t === TILE_WALL) rgba = pal.mini.wall;
    else if (t === TILE_ROCK) rgba = voids && voids[i] ? [0, 0, 0, 0] : pal.mini.rock;
    else if (t === TILE_DOOR) rgba = pal.mini.door;
    else if (t === TILE_BASE) { const col = bases.get(i) ?? 0xffffff; rgba = [(col >> 16) & 255, (col >> 8) & 255, col & 255, 90]; }
    else if (t === TILE_EMPTY) rgba = pal.mini.floor;
    let a = rgba[3];
    if (fog && a > 0) {
      const o = fog.owners[i];
      const lev = o >= 0 ? (fog.levels[o] ?? 0) : 2;
      a = lev >= 2 ? a : lev === 1 ? Math.round(a * 0.3) : 0;
    }
    const o = i * 4;
    px[o] = rgba[0]; px[o + 1] = rgba[1]; px[o + 2] = rgba[2]; px[o + 3] = a;
  }
  return px;
}

/** 1 px per tile canvas for the radar / big map. */
export function buildMinimapCanvas(map: GameMap, fog?: MinimapFog | null): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = map.cols; cv.height = map.rows;
  const c = cv.getContext('2d')!;
  const img = c.createImageData(map.cols, map.rows);
  img.data.set(minimapPixels(map, fog));
  c.putImageData(img, 0, 0);
  return cv;
}
