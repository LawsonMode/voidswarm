// SIM v0.3 M4 acceptance (docs/v0.3-proposal.md §9 SIM floorgen.test, §4.2): 200 seeds × floors 1–6 validate;
// deterministic tiles; room counts and kinds match the §4.2 table; markers on open ground; no overlaps; < 15 ms;
// applyRoomSeals is idempotent and bumps map.rev. Pure generator: no Sim, no mocks.
// The bulk sweeps collect failures into a list and assert once (an expect() per tile would take minutes).
import { describe, expect, it } from 'vitest';
import { MAP_SIZE, MAP_TILE, MAX_PARTIES, RIFT_BOSS_EVERY } from '../constants';
import type { GameMap, RiftRoom } from '../types';
import { RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../types';
import { fnv1a } from '../util/hash';
import {
  inRoomInterior, isSealableKind, RIFT_CELL_TILES, RIFT_CHEST_OFFSET_PX, RIFT_CORRIDOR_TILES, RIFT_EXTRACT_OFFSET_PX,
  RIFT_PARTY_SPAWN_R, RIFT_RIM_TILES,
} from './dungeonRules';
import {
  applyRoomSeals, fallbackFloor, FLOOR_ATTEMPTS, floorBiome, floorPlan, generateFloor, generateFloorInfo, isBossFloor,
  RIFT_SPAWN_MARKERS, riftTier, roomAt, validateFloor,
} from './floorgen';
import { buildMatchMap } from './mapgen';

const SLOW = 120_000;
const FLOORS = [1, 2, 3, 4, 5, 6];
const CHESTS: Partial<Record<RiftRoom['kind'], number>> = { arena: 1, key: 1, treasure: 2 };
const tileHash = (m: GameMap): string => {
  let s = '';
  for (let i = 0; i < m.tiles.length; i += 4096) s += String.fromCharCode(...m.tiles.subarray(i, i + 4096));
  return fnv1a(s).toString(16);
};
const tileOf = (m: GameMap, x: number, y: number): number => m.tiles[Math.floor(y / m.tileSize) * m.cols + Math.floor(x / m.tileSize)];
const open = (t: number): boolean => t === TILE_EMPTY || t === TILE_BASE || t === TILE_DOOR;
const cellOf = (r: RiftRoom): number => Math.floor(r.r0 / RIFT_CELL_TILES) * 4 + Math.floor(r.c0 / RIFT_CELL_TILES);
const gridAdjacent = (a: number, b: number): boolean => Math.abs((a % 4) - (b % 4)) + Math.abs(((a / 4) | 0) - ((b / 4) | 0)) === 1;
const doorCentre = (m: GameMap, tiles: number[]): { x: number; y: number } => {
  let x = 0, y = 0;
  for (const i of tiles) { x += (i % m.cols) + 0.5; y += Math.floor(i / m.cols) + 0.5; }
  return { x: (x / tiles.length) * m.tileSize, y: (y / tiles.length) * m.tileSize };
};
/** Failure collector: `ok(cond, msg)` records up to 20 messages; `expect(c.errs).toEqual([])` asserts once. */
function collector(): { errs: string[]; ok: (cond: boolean, msg: string) => void } {
  const errs: string[] = [];
  return { errs, ok: (cond, msg) => { if (!cond && errs.length < 20) errs.push(msg); } };
}

/**
 * Hull clearance: open tiles inside at least one fully open 2 × 2 block (room for the Juggernaut, r 22), flooded
 * 4-neighbour from the entrance centre. Every point a pilot or bot must reach has to be in it.
 */
function wideReach(m: GameMap): Uint8Array {
  const { cols, rows, tiles } = m;
  const wide = new Uint8Array(tiles.length);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const i = r * cols + c;
      if (open(tiles[i]) && open(tiles[i + 1]) && open(tiles[i + cols]) && open(tiles[i + cols + 1])) {
        wide[i] = wide[i + 1] = wide[i + cols] = wide[i + cols + 1] = 1;
      }
    }
  }
  const ent = m.dungeon!.rooms[m.dungeon!.entrances[0]];
  const start = Math.floor(ent.y / m.tileSize) * cols + Math.floor(ent.x / m.tileSize);
  const seen = new Uint8Array(tiles.length);
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop()!, c = i % cols;
    for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
      if (j < 0 || j >= tiles.length || seen[j] || !wide[j]) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return seen;
}

describe('generateFloor: validity and determinism', () => {
  it('200 seeds × floors 1–6 all validate, almost always on the first attempt (never the fallback here)', () => {
    const c = collector();
    let fallbacks = 0, retries = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const floor of FLOORS) {
        const info = generateFloorInfo(seed * 7919, floor, 1);
        const err = validateFloor(info.map);
        c.ok(err === null, `seed ${seed * 7919} floor ${floor}: ${err}`);
        if (info.fallback) fallbacks++;
        if (info.attempt > 0) retries++;
      }
    }
    expect(c.errs).toEqual([]);
    expect(fallbacks).toBe(0);
    expect(retries).toBeLessThan(1200 * 0.05);
  }, SLOW);

  it(`the snake fallback (after ${FLOOR_ATTEMPTS} failed attempts) validates on every floor and party count`, () => {
    for (let parties = 1; parties <= MAX_PARTIES; parties++) {
      for (const floor of [...FLOORS, 7, 9]) {
        const m = fallbackFloor(4242, floor, parties);
        expect(validateFloor(m), `floor ${floor} parties ${parties}`).toBeNull();
        expect(m.dungeon!.rooms.length).toBe(floorPlan(floor).main.length + floorPlan(floor).branches);
        expect(m.dungeon!.bossFloor).toBe(isBossFloor(floor));
      }
    }
  });

  it('is deterministic: identical tiles and layout across two calls; the seed, the floor and the party count matter', () => {
    for (const floor of FLOORS) {
      const a = generateFloor(1234, floor, 1), b = generateFloor(1234, floor, 1);
      expect(tileHash(b)).toBe(tileHash(a));
      expect(b.tiles).toEqual(a.tiles);
      expect(JSON.stringify(b.dungeon)).toBe(JSON.stringify(a.dungeon));
      expect(b.spawns).toEqual(a.spawns);
      expect(tileHash(generateFloor(1235, floor, 1))).not.toBe(tileHash(a));
    }
    expect(tileHash(generateFloor(1234, 2, 1))).not.toBe(tileHash(generateFloor(1234, 1, 1)));
    expect(tileHash(generateFloor(1234, 1, 2))).not.toBe(tileHash(generateFloor(1234, 1, 1)));
    // junk inputs are sanitized, never thrown on (floor → 1, parties → 1)
    expect(tileHash(generateFloor(1234, NaN, NaN))).toBe(tileHash(generateFloor(1234, 1, 1)));
    expect(tileHash(generateFloor(1234, 0, 0))).toBe(tileHash(generateFloor(1234, 1, 1)));
    // a large unsigned seed (the Room's randomSeed range) works the same way
    expect(tileHash(generateFloor(0xfedcba98, 5, 1))).toBe(tileHash(generateFloor(0xfedcba98, 5, 1)));
  });

  it('buildMatchMap routes dungeons to generateFloor(seed, floor, parties) on the fixed full-size grid', () => {
    const m = buildMatchMap({ seed: 77, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 4 });
    expect(m.tiles).toEqual(generateFloor(77, 4, 1).tiles);
    expect(m.dungeon!.floor).toBe(4);
    expect([m.width, m.height, m.tileSize, m.cols, m.rows]).toEqual([MAP_SIZE, MAP_SIZE, MAP_TILE, MAP_SIZE / MAP_TILE, MAP_SIZE / MAP_TILE]);
    expect(m.features).toBeUndefined();
    expect(m.rev).toBe(0);
    // floor 0 / junk → floor 1
    expect(buildMatchMap({ seed: 77, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 0 }).dungeon!.floor).toBe(1);
  });

  it('generation budget: < 15 ms per floor on average', () => {
    const t0 = performance.now();
    let worst = 0;
    const n = 120;
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      generateFloor(90_000 + i, (i % 6) + 1, 1);
      worst = Math.max(worst, performance.now() - s);
    }
    const mean = (performance.now() - t0) / n;
    console.log(`floorgen: mean ${mean.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
    expect(mean).toBeLessThan(15);
  }, SLOW);
});

describe('generateFloor: the §4.2 table', () => {
  it('room counts and kinds per floor; main path, branches, depths and links', () => {
    const table: Record<number, [number, string]> = {
      1: [7, 'entrance hall arena hall arena key | treasure'],
      2: [7, 'entrance hall arena hall arena key | treasure'],
      3: [8, 'entrance hall arena hall arena hall boss | treasure'],
      4: [9, 'entrance hall arena hall arena arena key | treasure treasure'],
      5: [9, 'entrance hall arena arena hall arena key | treasure treasure'],
      6: [10, 'entrance hall arena hall arena hall arena boss | treasure treasure'],
    };
    const c = collector();
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of FLOORS) {
        const m = generateFloor(seed, floor, 1), L = m.dungeon!, tag = `seed ${seed} floor ${floor}`;
        const [total, kinds] = table[floor];
        const main = L.rooms.filter((r) => r.mainPath), side = L.rooms.filter((r) => !r.mainPath);
        c.ok(L.rooms.length === total, `${tag}: ${L.rooms.length} rooms`);
        const got = `${main.map((r) => r.kind).join(' ')} | ${side.map((r) => r.kind).join(' ')}`;
        c.ok(got === kinds, `${tag}: kinds ${got}`);
        c.ok(L.floor === floor && L.bossFloor === (floor % RIFT_BOSS_EVERY === 0), `${tag}: floor / bossFloor`);
        c.ok(L.biome === (floor <= 3 ? 'hive' : 'prism'), `${tag}: biome`);
        c.ok(L.keyRoom === main[main.length - 1].idx && L.entrances.length === 1 && L.entrances[0] === 0, `${tag}: key / entrances`);
        const keyCell = cellOf(L.rooms[L.keyRoom]);
        c.ok(new Set(L.rooms.map(cellOf)).size === total, `${tag}: one room per cell`);
        main.forEach((r, i) => {
          c.ok(r.idx === i && r.depth === i, `${tag}: main room ${i} idx / depth`);
          if (i > 0) c.ok(r.links.includes(i - 1) && gridAdjacent(cellOf(r), cellOf(main[i - 1])), `${tag}: main link ${i}`);
        });
        for (const t of side) {
          const parent = L.rooms[t.links[0]];
          c.ok(t.links.length === 1, `${tag}: branch ${t.idx} is not a dead end`);
          c.ok(parent.mainPath && parent.idx !== L.keyRoom && t.depth === parent.depth + 1, `${tag}: branch ${t.idx} parent`);
          c.ok(!gridAdjacent(cellOf(t), keyCell), `${tag}: branch ${t.idx} beside the key room`);
          c.ok(gridAdjacent(cellOf(t), cellOf(parent)), `${tag}: branch ${t.idx} not beside its parent`);
        }
        c.ok(L.rooms[L.keyRoom].links.length === 1 && L.rooms[L.keyRoom].links[0] === L.keyRoom - 1, `${tag}: key room links`);
        for (const r of L.rooms) {
          const cx = (cellOf(r) % 4) * RIFT_CELL_TILES, cy = ((cellOf(r) / 4) | 0) * RIFT_CELL_TILES;
          c.ok(r.c0 - RIFT_RIM_TILES >= cx && r.r0 - RIFT_RIM_TILES >= cy && r.c1 + RIFT_RIM_TILES <= cx + RIFT_CELL_TILES &&
            r.r1 + RIFT_RIM_TILES <= cy + RIFT_CELL_TILES, `${tag}: room ${r.idx} leaves its cell`);
        }
        const e = cellOf(L.rooms[0]);
        c.ok(e % 4 === 0 || e % 4 === 3 || e < 4 || e >= 12, `${tag}: entrance not on an edge cell`);
      }
    }
    expect(c.errs).toEqual([]);
  }, SLOW);

  it('interior sizes by kind (entrance 22–24², hall 24–32, arena 34–42, treasure 16–20, key 40–44, boss 46²)', () => {
    const range: Record<string, [number, number]> = {
      entrance: [22, 24], hall: [24, 32], arena: [34, 42], treasure: [16, 20], key: [40, 44], boss: [46, 46],
    };
    const c = collector();
    for (let seed = 1; seed <= 30; seed++) {
      for (const floor of FLOORS) {
        for (const r of generateFloor(seed, floor, 1).dungeon!.rooms) {
          const [lo, hi] = range[r.kind], w = r.c1 - r.c0, h = r.r1 - r.r0;
          c.ok(w >= lo && w <= hi && h >= lo && h <= hi, `${r.kind} ${w}×${h}`);
          if (r.kind === 'entrance' || r.kind === 'boss') c.ok(w === h, `${r.kind} not square`);
          c.ok(r.x === ((r.c0 + r.c1) / 2) * MAP_TILE && r.y === ((r.r0 + r.r1) / 2) * MAP_TILE, `${r.kind} centre`);
        }
      }
    }
    expect(c.errs).toEqual([]);
  }, SLOW);

  it('floorPlan cycles past floor 6 (v0.4) so every 3rd floor stays a boss floor; tier / biome helpers', () => {
    for (let f = 1; f <= 12; f++) {
      const p = floorPlan(f);
      expect(p.main[0]).toBe('entrance');
      expect(p.main[p.main.length - 1]).toBe(isBossFloor(f) ? 'boss' : 'key');
      expect(isBossFloor(f)).toBe(f % RIFT_BOSS_EVERY === 0);
    }
    expect(FLOORS.map(riftTier)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(riftTier(0)).toBe(1);
    expect(FLOORS.map(floorBiome)).toEqual(['hive', 'hive', 'hive', 'prism', 'prism', 'prism']);
  });
});

describe('generateFloor: tiles, doors and markers', () => {
  it('markers on open 3 × 3 ground ≥ 7 tiles from doorways; chests; entrance BASE; rock never touches open ground', () => {
    const c = collector();
    for (let seed = 1; seed <= 50; seed++) {
      for (const floor of FLOORS) {
        const m = generateFloor(seed * 31, floor, 1), L = m.dungeon!, ts = m.tileSize, tag = `seed ${seed * 31} floor ${floor}`;
        c.ok(m.tiles.length === m.cols * m.rows, `${tag}: tile count`);
        for (let i = 0; i < m.cols; i++) {
          c.ok(!open(m.tiles[i]) && !open(m.tiles[(m.rows - 1) * m.cols + i]), `${tag}: open top / bottom border at ${i}`);
          c.ok(!open(m.tiles[i * m.cols]) && !open(m.tiles[i * m.cols + m.cols - 1]), `${tag}: open left / right border at ${i}`);
        }
        // Rock never touches open ground (8-neighbourhood): corridors are lined with walls. Hive pillars (inside
        // room interiors) are the exception.
        for (let r = 1; r < m.rows - 1; r++) {
          for (let col = 1; col < m.cols - 1; col++) {
            const i = r * m.cols + col;
            if (m.tiles[i] !== TILE_ROCK || roomAt(m, (col + 0.5) * ts, (r + 0.5) * ts) >= 0) continue;
            let touches = false;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (open(m.tiles[i + dr * m.cols + dc])) touches = true;
            c.ok(!touches, `${tag}: rock at ${col},${r} touches open ground`);
          }
        }
        for (const room of L.rooms) {
          const rt = `${tag} room ${room.idx} (${room.kind})`;
          c.ok(room.spawns.length / 2 === RIFT_SPAWN_MARKERS[room.kind], `${rt}: ${room.spawns.length / 2} markers`);
          c.ok(room.chests.length / 2 === (CHESTS[room.kind] ?? 0), `${rt}: ${room.chests.length / 2} chests`);
          const gaps = room.doors.map((d) => doorCentre(m, d.tiles));
          for (let i = 0; i < room.spawns.length; i += 2) {
            const x = room.spawns[i], y = room.spawns[i + 1];
            c.ok(inRoomInterior(room, ts, x, y, 1), `${rt}: marker ${i / 2} not inside`);
            let clear = true;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!open(tileOf(m, x + dx * ts, y + dy * ts))) clear = false;
            c.ok(clear, `${rt}: marker ${i / 2} not on open 3×3 ground`);
            for (const g of gaps) c.ok(Math.hypot(g.x - x, g.y - y) >= 7 * ts - 1, `${rt}: marker ${i / 2} near a door`);
          }
          for (let i = 0; i < room.chests.length; i += 2) {
            c.ok(roomAt(m, room.chests[i], room.chests[i + 1]) === room.idx, `${rt}: chest ${i / 2} outside`);
            c.ok(open(tileOf(m, room.chests[i], room.chests[i + 1])), `${rt}: chest ${i / 2} solid`);
          }
          if (room.kind === 'arena' || room.kind === 'key') {
            c.ok(room.chests[0] === room.x && room.chests[1] === room.y + RIFT_CHEST_OFFSET_PX, `${rt}: chest offset`);
          }
          let base = 0, cells = 0;
          for (let r = room.r0; r < room.r1; r++) for (let col = room.c0; col < room.c1; col++) { cells++; if (m.tiles[r * m.cols + col] === TILE_BASE) base++; }
          c.ok(room.kind === 'entrance' ? base === cells : base === 0, `${rt}: ${base}/${cells} BASE tiles`);
        }
      }
    }
    expect(c.errs).toEqual([]);
  }, SLOW);

  it('doors: sealable rooms only, 5 × 2 TILE_DOOR gaps in the rim, in-point inside the room right behind the gap', () => {
    const c = collector();
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of FLOORS) {
        const m = generateFloor(seed, floor, 1), L = m.dungeon!, ts = m.tileSize, tag = `seed ${seed} floor ${floor}`;
        let doorTiles = 0;
        for (const room of L.rooms) {
          if (!isSealableKind(room.kind)) { c.ok(room.doors.length === 0, `${tag}: ${room.kind} has doors`); continue; }
          c.ok(room.doors.length === room.links.length, `${tag}: room ${room.idx} one doorway per corridor`);
          for (const d of room.doors) {
            c.ok(d.tiles.length === RIFT_CORRIDOR_TILES * RIFT_RIM_TILES, `${tag}: door size ${d.tiles.length}`);
            doorTiles += d.tiles.length;
            for (const t of d.tiles) {
              const col = t % m.cols, r = (t - col) / m.cols;
              c.ok(m.tiles[t] === TILE_DOOR, `${tag}: door tile ${t} is ${m.tiles[t]}`);
              c.ok(roomAt(m, (col + 0.5) * ts, (r + 0.5) * ts) === -1, `${tag}: door tile ${t} inside a room`);
            }
            c.ok(roomAt(m, d.inX, d.inY) === room.idx, `${tag}: in-point outside room ${room.idx}`);
            const g = doorCentre(m, d.tiles);
            c.ok(Math.abs(Math.hypot(g.x - d.inX, g.y - d.inY) - 3.5 * ts) < 1e-6, `${tag}: in-point not 3 tiles behind the rim`);
          }
        }
        let all = 0;
        for (const t of m.tiles) if (t === TILE_DOOR) all++;
        c.ok(all === doorTiles, `${tag}: ${all - doorTiles} stray door tiles`);
      }
    }
    expect(c.errs).toEqual([]);
  }, SLOW);

  it('entrance ring (6 per party, r 110), Descend at the key / boss centre, Extract on boss floors only (352 px from the door side)', () => {
    const c = collector();
    for (let seed = 1; seed <= 30; seed++) {
      for (const floor of FLOORS) {
        for (const parties of [1, 2]) {
          const m = generateFloor(seed, floor, parties), L = m.dungeon!, tag = `seed ${seed} floor ${floor} parties ${parties}`;
          const ent = L.rooms[0];
          c.ok(ent.kind === 'entrance' && ent.party === 0 && m.teamCount === parties, `${tag}: entrance`);
          c.ok(m.spawns.length === 6 * parties, `${tag}: ${m.spawns.length} spawns`);
          for (const s of m.spawns) {
            c.ok(s.team >= 0 && s.team < parties, `${tag}: spawn team ${s.team}`);
            c.ok(Math.abs(Math.hypot(s.x - ent.x, s.y - ent.y) - RIFT_PARTY_SPAWN_R) < 1e-6, `${tag}: spawn ring radius`);
            c.ok(tileOf(m, s.x, s.y) === TILE_BASE, `${tag}: spawn off the pad`);
          }
          const key = L.rooms[L.keyRoom];
          c.ok(L.portalX === key.x && L.portalY === key.y, `${tag}: portal not at the key centre`);
          if (!L.bossFloor) { c.ok(L.extractX === -1 && L.extractY === -1, `${tag}: extract on a non-boss floor`); continue; }
          c.ok(Math.hypot(L.extractX - key.x, L.extractY - key.y) === RIFT_EXTRACT_OFFSET_PX, `${tag}: extract offset`);
          c.ok(roomAt(m, L.extractX, L.extractY) === key.idx, `${tag}: extract outside the boss room`);
          const d = key.doors[0];
          c.ok(Math.hypot(L.extractX - d.inX, L.extractY - d.inY) > Math.hypot(key.x - d.inX, key.y - d.inY), `${tag}: extract on the door side`);
        }
      }
    }
    expect(c.errs).toEqual([]);
  }, SLOW);

  it('hull clearance: every centre, marker, chest, in-point, portal and party spawn is reachable by the largest hull', () => {
    const c = collector();
    for (let seed = 1; seed <= 25; seed++) {
      for (const floor of FLOORS) {
        const m = generateFloor(seed * 101, floor, 1), L = m.dungeon!, ts = m.tileSize, tag = `seed ${seed * 101} floor ${floor}`;
        const reach = wideReach(m);
        const ok = (x: number, y: number, what: string) => c.ok(reach[Math.floor(y / ts) * m.cols + Math.floor(x / ts)] === 1, `${tag}: ${what}`);
        for (const r of L.rooms) {
          ok(r.x, r.y, `room ${r.idx} centre`);
          for (let i = 0; i < r.spawns.length; i += 2) ok(r.spawns[i], r.spawns[i + 1], `room ${r.idx} marker`);
          for (let i = 0; i < r.chests.length; i += 2) ok(r.chests[i], r.chests[i + 1], `room ${r.idx} chest`);
          for (const d of r.doors) ok(d.inX, d.inY, `room ${r.idx} in-point`);
        }
        ok(L.portalX, L.portalY, 'portal');
        if (L.bossFloor) ok(L.extractX, L.extractY, 'extract');
        for (const s of m.spawns) ok(s.x, s.y, 'party spawn');
      }
    }
    expect(c.errs).toEqual([]);
  }, SLOW);

  it('pillars: hive = round rock, prism = 3 × 3 walls; clear of room centres; none in entrance / treasure / key rooms', () => {
    const c = collector();
    let hiveRock = 0, prismWall = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const floor of FLOORS) {
        const m = generateFloor(seed, floor, 1), L = m.dungeon!, tag = `seed ${seed} floor ${floor}`;
        for (const r of L.rooms) {
          const cx = (r.c0 + r.c1) / 2, cy = (r.r0 + r.r1) / 2;
          for (let rr = r.r0; rr < r.r1; rr++) {
            for (let cc = r.c0; cc < r.c1; cc++) {
              const t = m.tiles[rr * m.cols + cc];
              if (open(t)) continue;
              c.ok(t === (L.biome === 'hive' ? TILE_ROCK : TILE_WALL), `${tag}: room ${r.idx} pillar tile ${t}`);
              if (t === TILE_ROCK) hiveRock++; else prismWall++;
              c.ok(Math.hypot(cc + 0.5 - cx, rr + 0.5 - cy) > 7 - 2.8 - 0.75, `${tag}: room ${r.idx} pillar near the centre`);
              c.ok(r.kind === 'hall' || r.kind === 'arena' || r.kind === 'boss', `${tag}: pillar in a ${r.kind} room`);
            }
          }
        }
      }
    }
    expect(c.errs).toEqual([]);
    expect(hiveRock).toBeGreaterThan(0);
    expect(prismWall).toBeGreaterThan(0);
  }, SLOW);
});

describe('applyRoomSeals / roomAt', () => {
  it('seals only SEALED rooms, is idempotent and bumps map.rev once per real change', () => {
    const m = generateFloor(1234, 1, 1), L = m.dungeon!;
    const sealable = L.rooms.filter((r) => r.doors.length > 0);
    expect(sealable.length).toBeGreaterThanOrEqual(3);
    const [a, b] = sealable;
    const states = L.rooms.map(() => RIFT_DORMANT as number);
    const doorsOf = (r: RiftRoom) => r.doors.flatMap((d) => d.tiles.map((t) => m.tiles[t]));
    expect(applyRoomSeals(m, states)).toBe(false); // everything already open
    expect(m.rev).toBe(0);
    states[a.idx] = RIFT_ARMING;
    expect(applyRoomSeals(m, states)).toBe(false); // arming doors stay open
    states[a.idx] = RIFT_SEALED;
    const before = m.tiles.slice();
    expect(applyRoomSeals(m, states)).toBe(true);
    expect(m.rev).toBe(1);
    expect(new Set(doorsOf(a))).toEqual(new Set([TILE_WALL]));
    expect(new Set(doorsOf(b))).toEqual(new Set([TILE_DOOR]));
    let changed = 0;
    for (let i = 0; i < m.tiles.length; i++) if (m.tiles[i] !== before[i]) changed++;
    expect(changed).toBe(a.doors.length * RIFT_CORRIDOR_TILES * RIFT_RIM_TILES); // only the door tiles
    expect(applyRoomSeals(m, states)).toBe(false); // idempotent
    expect(applyRoomSeals(m, Uint8Array.from(states))).toBe(false); // any ArrayLike
    expect(m.rev).toBe(1);
    states[a.idx] = RIFT_CLEARED;
    expect(applyRoomSeals(m, states)).toBe(true);
    expect(m.rev).toBe(2);
    expect(m.tiles).toEqual(generateFloor(1234, 1, 1).tiles); // back to the generated floor exactly
    // a short array reads as dormant; a map without a rift layout is never touched
    states[a.idx] = RIFT_SEALED;
    applyRoomSeals(m, states);
    expect(applyRoomSeals(m, [])).toBe(true);
    expect(new Set(doorsOf(a))).toEqual(new Set([TILE_DOOR]));
    const arena = buildMatchMap({ seed: 5, gameType: 'arena', subMode: 'deathmatch', teamCount: 2, floor: 0 });
    expect(applyRoomSeals(arena, [2, 2, 2])).toBe(false);
    expect(arena.rev).toBeUndefined();
  });

  it('roomAt: interiors only (corridors, rims and doorways are -1); junk points are -1', () => {
    const m = generateFloor(99, 3, 1), L = m.dungeon!, ts = m.tileSize;
    for (const r of L.rooms) {
      expect(roomAt(m, r.x, r.y)).toBe(r.idx);
      expect(roomAt(m, r.c0 * ts + 0.01, r.r0 * ts + 0.01)).toBe(r.idx);
      expect(roomAt(m, r.c1 * ts - 0.01, r.r1 * ts - 0.01)).toBe(r.idx);
      expect(roomAt(m, r.c0 * ts - 1, r.y)).toBe(-1); // the rim
      for (const d of r.doors) { const g = doorCentre(m, d.tiles); expect(roomAt(m, g.x, g.y)).toBe(-1); }
    }
    for (const [x, y] of [[-10, 50], [50, 1e9], [NaN, 3], [3, Infinity]]) expect(roomAt(m, x, y)).toBe(-1);
    expect(roomAt(buildMatchMap({ seed: 5, gameType: 'arena', subMode: 'deathmatch', teamCount: 2, floor: 0 }), 3000, 3000)).toBe(-1);
  });
});
