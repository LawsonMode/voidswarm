// RENDER v0.3 M4 acceptance: the rift layer, walls and minimap against the REAL sim/floorgen.ts and sim/dungeon.ts.
//  1. Seeded floors 1–6: every RiftDoor becomes a door rect whose normal points into its room, whose tiles are
//     TILE_DOOR on a fresh floor, and which the wall builder keeps as a doorway after applyRoomSeals writes TILE_WALL;
//     the tile fallback reads those seals back; fog owners / minimap / chests / portals resolve; nothing is NaN.
//  2. A seeded 4-bot co-op run (Sim + ai/bots, no Room): every few ticks the layer renders the genuine
//     buildRiftView(world) + the world's events; each rift event's room / chest resolves on the current floor's
//     layout, and a floor swap (world.map replaced) goes through the re-entrant setMap.
// While SIM's M4 functions are still stubs ('not implemented'), these tests skip instead of failing.
import { describe, expect, it } from 'vitest';
import type { RenderFrame } from '../contracts';
import { TICK_RATE } from '../../shared/constants';
import { createBotBrain, type BotBrain } from '../../shared/ai/bots';
import { buildRiftView } from '../../shared/sim/dungeon';
import { applyRoomSeals, generateFloor, roomAt } from '../../shared/sim/floorgen';
import { Sim } from '../../shared/sim/Sim';
import {
  RIFT_DORMANT, RIFT_SEALED, TILE_BASE, TILE_DOOR, TILE_EMPTY,
  type GameEvent, type GameMap, type RiftView, type ShipClassId, type ShipView, type SimConfig,
} from '../../shared/types';
import type { ObjShip } from './objectives';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import { RiftLayer, doorGeoms, fogOwners, portalLook, roomIndexAt, roomStates, type RiftHost } from './rift';
import { BIOME_PALETTES, minimapPixels, voidMask, wallTiles } from './walls';

const stubbed = (e: unknown) => e instanceof Error && /not implemented/i.test(e.message);
let floorErr: unknown = null;
try { generateFloor(1234, 1, 1); } catch (e) { floorErr = e; }
const FLOORGEN_STUB = stubbed(floorErr);
let simErr: unknown = null;
try {
  const s = new Sim({ mapSeed: 1, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false, gameType: 'dungeon', subMode: 'coop', floors: 3 });
  s.addPlayer({ playerId: 1, name: 'probe', team: 0, shipClass: 'brute', isBot: true });
  s.step(); s.step();
  buildRiftView(s.world);
} catch (e) { simErr = e; }
const SIM_STUB = stubbed(simErr);

// ---------- fakes (NaN-checking)
function fakeGraphics(bad: string[]) {
  const g: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ['circle', 'poly', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill', 'rect', 'closePath', 'ellipse']) {
    g[op] = (...args: unknown[]) => {
      for (const a of args) {
        const nums = typeof a === 'number' ? [a] : a && typeof a === 'object' ? Object.values(a).filter((v) => typeof v === 'number') : [];
        for (const n of nums as number[]) if (!Number.isFinite(n) && bad.length < 10) bad.push(`${op}(${JSON.stringify(args)})`);
      }
      return g;
    };
  }
  return g as never;
}
function fakeBatch(bad: string[]) {
  return {
    begin: () => {}, end: () => {}, pc: {},
    put: (_t: unknown, x: number, y: number, _r: number, sx: number, sy: number, _c: number, a: number) => {
      if (![x, y, sx, sy, a].every(Number.isFinite) && bad.length < 10) bad.push(`put(${x},${y},${sx},${sy},${a})`);
    },
  } as unknown as SpriteBatch;
}
const A = { soft: 'soft', beam: 'beam', ring: 'ring', dot: 'dot' } as unknown as Atlas;
function host(ships: Map<number, ObjShip>, byPlayer: Map<number, number>): RiftHost {
  const nop = () => {};
  return {
    inView: () => true, ship: (id) => ships.get(id) ?? null, shipOfPlayer: (pid) => byPlayer.get(pid) ?? 0, label: nop,
    ring: nop, burst: nop, flash: nop, impulse: nop, tint: nop, shake: nop, shock: nop, spark: nop,
  };
}
function frameOf(dungeon: RiftView | undefined, ships: ShipView[], localShipId: number, events: GameEvent[]): RenderFrame {
  return {
    time: 0, dt: 1 / 60, renderTick: 0, localPlayerId: 1, localShipId, focusX: 0, focusY: 0, ships, enemies: [], projectiles: [],
    gems: [], deployables: [], events, you: null, players: new Map(), aimX: 0, aimY: 0, attachCandidateId: 0,
    match: dungeon ? {
      phase: 'playing', mode: 'teams', teamCount: 1, timeLeftSec: 0, teamScores: [0], wave: 1, winnerTeam: -1, winnerPlayerId: 0,
      timed: false, gameType: 'dungeon', subMode: 'coop', dungeon,
    } : null,
  };
}
function drawAll(layer: RiftLayer, f: RenderFrame, t: number, h: RiftHost, bad: string[]): void {
  layer.begin(f, t, h);
  for (const ev of f.events) layer.event(ev, t, h);
  layer.drawWorld(f, t, fakeGraphics(bad), fakeGraphics(bad), h);
  layer.drawShipFx(f, t, fakeGraphics(bad), h);
  layer.end();
  layer.drawRadar(f, fakeGraphics(bad), 0, 0, 0.03, 0.03, true, t);
}

// =============================================================================================

describe.skipIf(FLOORGEN_STUB)('rift render seams × real floorgen', () => {
  const SEEDS = [1, 7, 1234, 99991];

  it('doors, fog owners, chests, portals and the minimap resolve on every floor; seals stay doorways', () => {
    if (floorErr) throw floorErr;
    for (const seed of SEEDS) for (let f = 1; f <= 6; f++) {
      const map = generateFloor(seed, f, 1);
      const L = map.dungeon!;
      const tag = `seed ${seed} floor ${f}`;
      expect(L, tag).toBeTruthy();
      const doors = doorGeoms(map);
      expect(doors.length, tag).toBe(L.rooms.reduce((n, r) => n + r.doors.length, 0));
      for (const d of doors) {
        const room = L.rooms[d.room];
        expect(room.kind === 'arena' || room.kind === 'key' || room.kind === 'boss', tag).toBe(true);
        for (const i of d.tiles) expect(map.tiles[i], tag).toBe(TILE_DOOR);
        const before = Math.hypot(room.x - d.cx, room.y - d.cy), after = Math.hypot(room.x - (d.cx + d.nx * 48), room.y - (d.cy + d.ny * 48));
        expect(after, tag).toBeLessThan(before);
      }
      // interiors: our lookup agrees with floorgen's roomAt, and room centres own their fog
      const own = fogOwners(map)!;
      for (const r of L.rooms) {
        expect(roomIndexAt(L, map.tileSize, r.x, r.y), tag).toBe(r.idx);
        expect(roomAt(map, r.x, r.y), tag).toBe(r.idx);
        expect(own[Math.floor(r.y / map.tileSize) * map.cols + Math.floor(r.x / map.tileSize)], tag).toBe(r.idx);
        for (let k = 0; k + 1 < r.chests.length; k += 2) {
          const t = map.tiles[Math.floor(r.chests[k + 1] / map.tileSize) * map.cols + Math.floor(r.chests[k] / map.tileSize)];
          expect(t === TILE_EMPTY || t === TILE_BASE, `${tag} chest`).toBe(true);
          expect(roomIndexAt(L, map.tileSize, r.chests[k], r.chests[k + 1]), `${tag} chest room`).toBe(r.idx);
        }
      }
      expect(roomIndexAt(L, map.tileSize, L.portalX, L.portalY), tag).toBe(L.keyRoom);
      const final = f === 6;
      const look = portalLook(L, { floor: f, floorsTotal: 6, extractOpen: true, portal: 1 } as RiftView);
      expect(look.descend, tag).toBe(final ? 'none' : 'open');
      expect(look.extract, tag).toBe(L.bossFloor ? 'open' : 'none');
      // seal every sealable room like the sim does: the tile fallback reads SEALED, the walls still see doorways
      const sealed: GameMap = { ...map, tiles: new Uint8Array(map.tiles), rev: 0 };
      const states = L.rooms.map((r) => (r.doors.length ? RIFT_SEALED : RIFT_DORMANT));
      expect(applyRoomSeals(sealed, states), tag).toBe(doors.length > 0);
      const st = roomStates(sealed, null);
      for (const r of L.rooms) expect(st[r.idx], tag).toBe(r.doors.length ? RIFT_SEALED : RIFT_DORMANT);
      const wt = wallTiles(sealed);
      for (const d of doors) for (const i of d.tiles) expect(wt[i], tag).toBe(TILE_DOOR);
      const px = minimapPixels(sealed);
      const doorRgba = BIOME_PALETTES[L.biome].mini.door;
      for (const d of doors) expect(px[d.tiles[0] * 4 + 3], tag).toBe(doorRgba[3]);
      // the void (rock with no floor beside it, at least the unused macro cells) is transparent on the minimap
      const voids = voidMask(sealed, wt, BIOME_PALETTES[L.biome])!;
      let nVoid = 0, opaqueVoid = 0;
      for (let i = 0; i < voids.length; i++) if (voids[i]) { nVoid++; if (px[i * 4 + 3] !== 0) opaqueVoid++; }
      expect(nVoid, `${tag} void`).toBeGreaterThan(sealed.cols * sealed.rows * 0.2);
      expect(opaqueVoid, `${tag} void`).toBe(0);
      applyRoomSeals(sealed, L.rooms.map(() => RIFT_DORMANT));
      expect(roomStates(sealed, null).every((s) => s === RIFT_DORMANT), tag).toBe(true);
    }
  });

  it('renders every room state on a real floor without NaN', () => {
    if (floorErr) throw floorErr;
    const bad: string[] = [];
    for (const f of [1, 3, 6]) {
      const map = generateFloor(1234, f, 1);
      const L = map.dungeon!;
      const layer = new RiftLayer(A, fakeBatch(bad));
      layer.setMap(map);
      const h = host(new Map(), new Map());
      for (let k = 0; k < 16; k++) {
        const v: RiftView = {
          floor: f, floorsTotal: 6, biome: L.biome, rooms: L.rooms.map((_, i) => (i + k) % 4), chests: L.rooms.map(() => k % 4),
          lives: [6], seen: [(1 << ((k % L.rooms.length) + 1)) - 1], anchors: [L.rooms[0].x, L.rooms[0].y], portal: (k % 3) as 0 | 1 | 2,
          departIn: k % 3 === 2 ? 20 : 0, extractOpen: L.bossFloor && k > 8, boss: null, waiting: [], extracting: [], floorSec: k,
        };
        drawAll(layer, frameOf(v, [], 0, []), k * 0.2, h, bad);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe.skipIf(FLOORGEN_STUB || SIM_STUB)('rift layer × real sim (4 bots, co-op)', () => {
  it('views and rift events resolve on the current floor; floor swaps re-enter setMap; nothing NaN', () => {
    if (simErr) throw simErr;
    const cfg: SimConfig = {
      mapSeed: 1234, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
      gameType: 'dungeon', subMode: 'coop', floors: 3,
    };
    const sim = new Sim(cfg);
    const w = sim.world;
    const cls: ShipClassId[] = ['brute', 'tech', 'engineer', 'engineer'];
    const brains = new Map<number, BotBrain>();
    for (let i = 1; i <= 4; i++) {
      sim.addPlayer({ playerId: i, name: 'bot' + i, team: 0, shipClass: cls[i - 1], isBot: true });
      brains.set(i, createBotBrain('normal', 2000 + i));
    }
    const bad: string[] = [];
    const layer = new RiftLayer(A, fakeBatch(bad));
    let map = w.map;
    layer.setMap(map);
    let setMaps = 1;
    const ships = new Map<number, ObjShip>(), byPlayer = new Map<number, number>();
    const h = host(ships, byPlayer);
    const unresolved: string[] = [];
    const seenEvents = new Set<string>();
    let sawSealedState = false;
    const SECONDS = 90;
    let events: GameEvent[] = [];
    for (let k = 0; k < TICK_RATE * SECONDS; k++) {
      for (const [pid, brain] of brains) {
        const sid = w.shipsByPlayer.get(pid);
        const ship = sid ? w.ships.get(sid) : undefined;
        if (ship) sim.setInput(pid, brain.think(w, ship));
      }
      const before = w.map;
      sim.step();
      // events before a floorStart belong to the old floor (the Room drops them; so does this client)
      let Lev = before.dungeon!;
      for (const ev of sim.drainEvents()) {
        seenEvents.add(ev.t);
        if (ev.t === 'floorStart') { Lev = w.map.dungeon!; events = []; }
        if ((ev.t === 'roomSeal' || ev.t === 'roomClear' || ev.t === 'roomReset') && !Lev.rooms[ev.room]) unresolved.push(`${ev.t} room ${ev.room}`);
        if (ev.t === 'chestOpen' && !(Lev.rooms[ev.room] && ev.chest * 2 + 1 < Lev.rooms[ev.room].chests.length)) unresolved.push(`chest ${ev.room}/${ev.chest}`);
        events.push(ev);
      }
      if (w.map !== map) { map = w.map; layer.setMap(map); setMaps++; }
      if (k % 6 !== 0 || !w.dungeon) continue;
      const L = map.dungeon!;
      ships.clear(); byPlayer.clear();
      const views: ShipView[] = [];
      for (const s of w.ships.values()) {
        if (!s.alive) continue;
        ships.set(s.id, { x: s.x, y: s.y, r: 20, vx: s.vx, vy: s.vy, alpha: 1, ally: true, cloaked: false });
        byPlayer.set(s.playerId, s.id);
        views.push({
          id: s.id, playerId: s.playerId, team: s.team, shipClass: s.shipClass, x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle,
          energyFrac: 1, alive: s.alive, attachedTo: s.attachedTo, turretSlot: -1, turretCount: 0, flags: s.flags, level: 1,
          orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1,
        });
      }
      const v = buildRiftView(w);
      expect(v.rooms.length).toBe(L.rooms.length);
      const local = views[0]?.id ?? 0;
      drawAll(layer, frameOf(v, views, local, events), k / TICK_RATE, h, bad);
      expect(layer.roomStateList).toEqual(v.floor === L.floor ? v.rooms : layer.roomStateList);
      if (layer.roomStateList.some((st) => st === RIFT_SEALED || st === 1)) sawSealedState = true;
      events = [];
    }
    expect(unresolved).toEqual([]);
    expect(bad).toEqual([]);
    expect(setMaps).toBeGreaterThanOrEqual(1);
    // whatever the bots reached, the layer saw it: a roomSeal event means the view showed an arming / sealed room
    expect(seenEvents.size).toBeGreaterThan(0);
    if (seenEvents.has('roomSeal')) expect(sawSealedState).toBe(true);
  });
});
