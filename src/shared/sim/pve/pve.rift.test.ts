// OWNER: PVE agent. v0.3 M4 rift director + Matriarch (docs/v0.3-proposal.md §4.4–4.5, §9 PVE M4 acceptance):
// pulse size by floor and party; leash (room A ignores room B without line of sight); dormancy wakes; Matriarch
// phase thresholds; intro invulnerability; instability cadence. Plus the rest of the M4 PVE surface (director off in
// rifts, pulse cadence, encounter done / reset, key mini-bosses, kind weights, bossCache, recomputeShipStats).
//
// Real map / world / combat / loot (rollLoot wrapped in a spy). The rift is a hand-built layout on the fixed
// 200×200-tile grid and world.dungeon is set by hand, so these tests exercise PVE's side of the §8.8 contract
// without SIM's floorgen / dungeon.ts (the SIM calls are made directly: riftEncounterStart / Done / Reset).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../loot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../loot')>();
  return { ...actual, rollLoot: vi.fn(actual.rollLoot) };
});

import { DT, RIFT_SOFT_LIMIT_SEC, TICK_RATE } from '../../constants';
import type {
  Enemy, EnemyKind, GameEvent, GameMap, RiftLayout, RiftRoom, RiftRoomKind, RiftState, Ship, ShipClassId, SimConfig,
  World,
} from '../../types';
import { emptyInput, RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../../types';
import { damageEnemy } from '../combat';
import { generateFloor } from '../floorgen';
import { rollLoot } from '../loot';
import { isSolidAt } from '../map';
import { createWorld, rebuildGrid } from '../world';
import {
  MATRIARCH_DOUBLE_RING_SEC, MATRIARCH_DRONE_BASE, MATRIARCH_INTRO_SEC, matriarchPhaseFor,
} from './bosses';
import { ENEMY_DEFS, MAX_RADIUS, sleepKey, spawnEnemy } from './enemies';
import {
  pveInit, pveStep, recomputeShipStats, riftEncounterDone, riftEncounterReset, riftEncounterStart, riftFloorInit,
} from './index';
import * as R from './riftRules';
import { computeStats } from './upgrades';
import { stepDirector } from './waves';
import { xpToNextFor } from './xp';

const roll = vi.mocked(rollLoot);
beforeEach(() => { roll.mockClear(); });

const TS = 32;
const COLS = 200;

interface RoomSpec { kind: RiftRoomKind; c0: number; r0: number; size: number }

function markerCount(kind: RiftRoomKind): number {
  if (kind === 'hall') return 4;
  if (kind === 'treasure') return 3;
  if (kind === 'arena' || kind === 'key' || kind === 'boss') return 8;
  return 0;
}

/** Rock everywhere, each room a 2-tile WALL rim around an EMPTY interior, optional extra open rects (corridors). */
function buildRift(specs: RoomSpec[], floor: number, open: [number, number, number, number][] = []): GameMap {
  const tiles = new Uint8Array(COLS * COLS).fill(TILE_ROCK);
  const set = (c: number, r: number, v: number) => { if (c >= 0 && r >= 0 && c < COLS && r < COLS) tiles[r * COLS + c] = v; };
  const rooms: RiftRoom[] = specs.map((sp, idx) => {
    const c0 = sp.c0, r0 = sp.r0, c1 = c0 + sp.size, r1 = r0 + sp.size;
    for (let r = r0 - 2; r < r1 + 2; r++) for (let c = c0 - 2; c < c1 + 2; c++) set(c, r, TILE_WALL);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) set(c, r, TILE_EMPTY);
    const x = ((c0 + c1) / 2) * TS, y = ((r0 + r1) / 2) * TS, half = (sp.size / 2) * TS;
    const spawns: number[] = [];
    const m = markerCount(sp.kind);
    for (let i = 0; i < m; i++) {
      const a = (i * Math.PI * 2) / m;
      spawns.push(x + Math.cos(a) * half * 0.72, y + Math.sin(a) * half * 0.72);
    }
    return {
      idx, kind: sp.kind, c0, r0, c1, r1, x, y, doors: [], spawns, chests: [], links: [], depth: idx, mainPath: true,
      party: sp.kind === 'entrance' ? 0 : -1,
    };
  });
  for (const [c0, r0, c1, r1] of open) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) set(c, r, TILE_EMPTY);
  const layout: RiftLayout = {
    floor, biome: floor <= 3 ? 'hive' : 'prism', bossFloor: floor % 3 === 0, rooms,
    entrances: [Math.max(0, rooms.findIndex((r) => r.kind === 'entrance'))], keyRoom: rooms.length - 1,
    portalX: rooms[rooms.length - 1].x, portalY: rooms[rooms.length - 1].y, extractX: -1, extractY: -1,
  };
  return {
    seed: 1234, teamCount: 1, width: COLS * TS, height: COLS * TS, tileSize: TS, cols: COLS, rows: COLS, tiles,
    spawns: [], dungeon: layout, rev: 0,
  };
}

function riftState(map: GameMap, floor: number): RiftState {
  return {
    floor, floorsTotal: 6, floorStartTick: 0,
    rooms: map.dungeon!.rooms.map(() => ({ state: RIFT_DORMANT, until: 0, sealedBy: -1, chests: 0, vacantTicks: 0 })),
    parties: [{
      team: 0, lives: 10, status: 'active', anchorX: 0, anchorY: 0, seen: 0, roomsCleared: 0, bossesKilled: 0,
      deepestFloor: floor,
    }],
    portal: 0, departTick: 0, extractOpen: false, victoryTick: 0, bossId: 0, bossPhase: 0, pendingFloor: 0,
    outcome: 'running', extracted: [], instabilityTick: 0,
  };
}

interface RiftOpts { floor?: number; pve?: 1 | 2 | 3; seed?: number; lootMult?: number; open?: [number, number, number, number][] }

function makeRift(specs: RoomSpec[], o: RiftOpts = {}): World {
  const floor = o.floor ?? 1;
  const map = buildRift(specs, floor, o.open);
  const cfg: SimConfig = {
    mapSeed: o.seed ?? 1234, mode: 'teams', teamCount: 1, pveIntensity: o.pve ?? 2, matchSeconds: 0, scoreLimit: 0,
    friendlyFire: false, gameType: 'dungeon', subMode: 'coop', floors: 6, lootMult: o.lootMult ?? 0, lootSeed: 99,
  };
  const world = createWorld(cfg, map);
  world.dungeon = riftState(map, floor);
  pveInit(world);
  return world;
}

let nextPid = 1;
function makeShip(world: World, x: number, y: number, o: { human?: boolean; cls?: ShipClassId; vulnerable?: boolean } = {}): Ship {
  const id = world.nextId++;
  const cls = o.cls ?? 'brute';
  const stats = computeStats(cls, {});
  const s: Ship = {
    id, playerId: nextPid++, name: 'p' + id, team: 0, shipClass: cls, isBot: !o.human,
    x, y, vx: 0, vy: 0, angle: 0, alive: true, respawnTick: 0, invulnUntilTick: o.vulnerable ? 0 : 1e12,
    energy: stats.maxEnergy, stats, input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0, path: null,
    gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
    utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0, skillState: {},
    attachedTo: 0, turrets: [], xp: 0, level: 1, xpToNext: xpToNextFor(1), offers: [], offerSerial: 0, upgrades: {}, autoState: {},
    kills: 0, deaths: 0, score: 0, bounty: 10, killStreak: 0, enemyKills: 0, lastDamagedBy: 0, lastDamagedTick: 0, flags: 0,
  };
  world.ships.set(id, s);
  world.shipsByPlayer.set(s.playerId, id);
  return s;
}

/** Step n ticks (pve only; enemy shots just expire). Returns the events emitted. */
function run(world: World, n: number, perTick?: () => void): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    world.tick++;
    rebuildGrid(world);
    perTick?.();
    pveStep(world, DT);
    for (const p of world.projectiles.values()) if (world.tick >= p.expireTick) world.projectiles.delete(p.id);
    out.push(...world.events);
    world.events.length = 0;
  }
  return out;
}

function seal(world: World, room: number, partySize: number): GameEvent[] {
  const run0 = world.dungeon!.rooms[room];
  run0.state = RIFT_SEALED;
  run0.sealedBy = 0;
  riftEncounterStart(world, room, partySize);
  const ev = world.events.slice();
  world.events.length = 0;
  return ev;
}

function clearEnemies(world: World): void {
  world.enemies.clear();
  world.pve.bossAlive = false;
}

function inRoom(world: World, e: { x: number; y: number }, room: number): boolean {
  return R.inRoomRect(world.map.dungeon!.rooms[room], TS, e.x, e.y);
}

function warns(ev: GameEvent[]): Extract<GameEvent, { t: 'spawnWarn' }>[] {
  return ev.filter((e): e is Extract<GameEvent, { t: 'spawnWarn' }> => e.t === 'spawnWarn');
}

const center = (room: RiftRoom) => ({ x: room.x, y: room.y });

// Standard layouts (tiles). Rim = 2 tiles; interiors never overlap.
const ENTRANCE: RoomSpec = { kind: 'entrance', c0: 10, r0: 10, size: 24 };
const ARENA: RoomSpec = { kind: 'arena', c0: 60, r0: 60, size: 38 };

// ---------------------------------------------------------------------------------------------

describe('rift director basics', () => {
  it('stepDirector is a no-op in a rift: no waveStart, and pve.wave is the floor tier', () => {
    const w = makeRift([ENTRANCE], { floor: 3, pve: 3 });
    expect(w.pve.wave).toBe(5);
    makeShip(w, 700, 700);
    const next = w.pve.nextWaveTick;
    stepDirector(w);
    expect(w.pve.nextWaveTick).toBe(next);
    const ev = run(w, 60 * TICK_RATE);
    expect(ev.some((e) => e.t === 'waveStart')).toBe(false);
    expect(w.enemies.size).toBe(0);
    expect(w.pve.wave).toBe(5);
  });

  it('tier per floor is 1 + 2(f − 1); pulses per room 3 on floors 1–3 and 4 after', () => {
    expect([1, 2, 3, 4, 5, 6].map(R.riftTierOf)).toEqual([1, 3, 5, 7, 9, 11]);
    expect([1, 2, 3, 4, 5, 6].map(R.riftPulsesPerRoom)).toEqual([3, 3, 3, 4, 4, 4]);
    expect([1, 2, 3, 4, 5, 6].map((f) => R.tierHpScale(R.riftTierOf(f)))).toEqual([1, 1.24, 1.48, 1.72, 1.96, 2.2].map((v) => expect.closeTo(v, 9)));
  });

  it('riftFloorInit is idempotent per floor map; a new floor map re-initialises (tier, instability, boss pointer)', () => {
    const w = makeRift([ENTRANCE, { kind: 'hall', c0: 40, r0: 10, size: 28 }], { floor: 1 });
    makeShip(w, 700, 700);
    riftFloorInit(w); // already initialised by pveInit (packs deferred): no-op
    run(w, 1); // deferred packs placed now
    const n = w.enemies.size;
    expect(n).toBeGreaterThan(0);
    riftFloorInit(w);
    run(w, 1);
    expect(w.enemies.size).toBe(n);

    // floor swap as Sim.enterFloor does it: new map, entities cleared, pve reset, then riftFloorInit
    const map2 = buildRift([ENTRANCE, { kind: 'hall', c0: 40, r0: 10, size: 28 }], 2);
    w.map = map2;
    w.enemies.clear();
    w.pve.mem = {};
    w.dungeon!.floor = 2;
    w.dungeon!.instabilityTick = 12345;
    w.dungeon!.bossId = 77;
    riftFloorInit(w);
    expect(w.pve.wave).toBe(3);
    expect(w.dungeon!.instabilityTick).toBe(0);
    expect(w.dungeon!.bossId).toBe(0);
    expect(w.enemies.size).toBeGreaterThan(0); // a ship exists: packs placed at once
    for (const e of w.enemies.values()) expect(e.mem.sleep).toBe(1);
  });
});

describe('pulses (§4.4)', () => {
  it('pulse size = (8 + 2f) × (1 + 0.3(n − 1)) × difficulty count', () => {
    expect([1, 2, 3, 4, 5, 6].map((f) => R.riftPulseSize(f, 1, 2))).toEqual([10, 12, 14, 16, 18, 20]);
    expect(R.riftPulseSize(1, 4, 2)).toBe(19);
    expect(R.riftPulseSize(1, 2, 2)).toBe(13);
    expect(R.riftPulseSize(1, 1, 1)).toBe(8); // Story ×0.8
    expect(R.riftPulseSize(2, 1, 3)).toBe(15); // Nightmare ×1.25
    for (let f = 1; f <= 6; f++) {
      for (let n = 1; n <= 4; n++) {
        for (const pve of [1, 2, 3] as const) {
          const want = Math.max(1, Math.round((8 + 2 * f) * (1 + 0.3 * (n - 1)) * R.RIFT_DIFFICULTY[pve].count));
          expect(R.riftPulseSize(f, n, pve)).toBe(want);
        }
      }
    }
  });

  it('a sealed arena warns ⌈count/6⌉ markers (r 90, 0.8 s) away from ships, then spawns the pulse 48 ticks later', () => {
    for (const n of [1, 2, 4]) {
      const w = makeRift([ENTRANCE, ARENA], { floor: 1, seed: 1000 + n });
      const room = w.map.dungeon!.rooms[1];
      const ship = makeShip(w, room.x, room.y);
      run(w, 1);
      const ev = seal(w, 1, n);
      const size = R.riftPulseSize(1, n, 2);
      const ws = warns(ev);
      expect(ws.length).toBe(Math.ceil(size / 6));
      for (const wv of ws) {
        expect(wv.radius).toBe(90);
        expect(wv.sec).toBeCloseTo(0.8, 9);
        expect(Math.hypot(wv.x - ship.x, wv.y - ship.y)).toBeGreaterThanOrEqual(R.RIFT_MARKER_CLEAR_PX);
      }
      run(w, R.RIFT_PULSE_WARN_TICKS - 1);
      expect(w.enemies.size).toBe(0);
      run(w, 1);
      // floor 1 kinds (drone / dart / weaver) cost 1: the pulse is exactly `size` bodies, all inside the room
      expect(w.enemies.size).toBe(size);
      for (const e of w.enemies.values()) {
        expect(['drone', 'dart', 'weaver']).toContain(e.kind);
        expect(inRoom(w, e, 1)).toBe(true);
      }
    }
  });

  it('pulse budgets scale by party on later floors (heavier kinds get fewer bodies)', () => {
    for (const n of [1, 3]) {
      const w = makeRift([ENTRANCE, { ...ARENA, size: 44 }], { floor: 5, seed: 77 + n });
      const room = w.map.dungeon!.rooms[1];
      makeShip(w, room.x, room.y);
      run(w, 1);
      const ev = seal(w, 1, n);
      const size = R.riftPulseSize(5, n, 2);
      const markers = Math.ceil(size / 6);
      expect(warns(ev).length).toBe(markers);
      run(w, R.RIFT_PULSE_WARN_TICKS);
      let budget = 0;
      for (const e of w.enemies.values()) budget += R.RIFT_KIND_COST[e.kind];
      // each formation's share is rounded to whole bodies of its kind: within half a heavy body per marker
      expect(Math.abs(budget - size)).toBeLessThanOrEqual(markers * 3);
    }
  });

  it('the next pulse fires at 3 s once the room is down to 30% of the last pulse, otherwise after 14 s', () => {
    /** A floor-1 arena right after its first pulse (10 bodies) spawned; keep `keep` of them. */
    const afterFirstPulse = (keep: number): World => {
      const w = makeRift([ENTRANCE, ARENA], { floor: 1 });
      const room = w.map.dungeon!.rooms[1];
      makeShip(w, room.x, room.y);
      run(w, 1);
      seal(w, 1, 1);
      run(w, R.RIFT_PULSE_WARN_TICKS);
      expect(w.enemies.size).toBe(10);
      const kept = [...w.enemies.values()].slice(0, keep);
      w.enemies.clear();
      for (const e of kept) w.enemies.set(e.id, e);
      return w;
    };
    const ticksToNextWarn = (w: World): number => {
      const t0 = w.tick;
      for (let i = 0; i < 20 * TICK_RATE; i++) if (warns(run(w, 1)).length) return w.tick - t0;
      return -1;
    };
    expect(ticksToNextWarn(afterFirstPulse(0))).toBe(3 * TICK_RATE); // empty at once: the 3 s minimum gap
    expect(ticksToNextWarn(afterFirstPulse(3))).toBe(3 * TICK_RATE); // exactly 30% left: as soon as the gap allows
    const busy = afterFirstPulse(10); // nobody kills anything: the 14 s time-out
    expect(ticksToNextWarn(busy)).toBe(14 * TICK_RATE);
    expect([...busy.enemies.values()].filter((e) => inRoom(busy, e, 1)).length).toBeGreaterThan(3);
  });

  it('riftEncounterDone only after every pulse spawned and the room is empty; reset starts over from pulse 1', () => {
    const w = makeRift([ENTRANCE, ARENA], { floor: 1 });
    const room = w.map.dungeon!.rooms[1];
    makeShip(w, room.x, room.y);
    run(w, 1);
    seal(w, 1, 1);
    let pulses = 0;
    for (let i = 0; i < 60 * TICK_RATE; i++) {
      const before = w.enemies.size;
      run(w, 1);
      if (w.enemies.size > before) {
        pulses++;
        if (pulses < 3) expect(riftEncounterDone(w, 1)).toBe(false);
        clearEnemies(w);
      } else if (pulses < 3) expect(riftEncounterDone(w, 1)).toBe(false);
      if (riftEncounterDone(w, 1)) break;
    }
    expect(pulses).toBe(3);
    expect(riftEncounterDone(w, 1)).toBe(true);
    // an enemy outside the room rect doesn't hold the clear; one inside does
    const out = spawnEnemy(w, 'drone', 700, 700)!;
    expect(riftEncounterDone(w, 1)).toBe(true);
    const inside = spawnEnemy(w, 'drone', room.x, room.y)!;
    expect(riftEncounterDone(w, 1)).toBe(false);
    w.enemies.delete(inside.id);
    w.dungeon!.rooms[1].state = RIFT_CLEARED;
    run(w, 1);
    expect(w.enemies.has(out.id)).toBe(true);

    // regroup: re-seal, first pulse spawns, then a reset removes the room's enemies (not the one outside)
    w.dungeon!.rooms[1].state = RIFT_DORMANT;
    seal(w, 1, 1);
    run(w, R.RIFT_PULSE_WARN_TICKS);
    expect([...w.enemies.values()].filter((e) => inRoom(w, e, 1)).length).toBe(10);
    expect(riftEncounterDone(w, 1)).toBe(false);
    riftEncounterReset(w, 1);
    w.dungeon!.rooms[1].state = RIFT_DORMANT;
    expect([...w.enemies.values()].filter((e) => inRoom(w, e, 1)).length).toBe(0);
    expect(w.enemies.has(out.id)).toBe(true);
    const ev = run(w, 5 * TICK_RATE);
    expect(warns(ev).length).toBe(0); // no encounter on record: nothing fires into an unsealed room
    const ev2 = seal(w, 1, 1);
    expect(warns(ev2).length).toBe(Math.ceil(10 / 6)); // pulse 1 again
  });

  it('a key room ends with a mini-boss pulse: an elite brute on floor 1, a Hive at HP ×0.8 on floor 4', () => {
    for (const floor of [1, 4]) {
      const w = makeRift([ENTRANCE, { kind: 'key', c0: 60, r0: 60, size: 42 }], { floor });
      const room = w.map.dungeon!.rooms[1];
      makeShip(w, room.x, room.y);
      run(w, 1);
      seal(w, 1, 1);
      const spawned: Enemy[][] = [];
      for (let i = 0; i < 120 * TICK_RATE && !riftEncounterDone(w, 1); i++) {
        const before = new Set(w.enemies.keys());
        run(w, 1);
        const fresh = [...w.enemies.values()].filter((e) => !before.has(e.id) && e.kind !== 'splitling');
        if (fresh.length) { spawned.push(fresh); clearEnemies(w); }
      }
      expect(spawned.length).toBe(R.riftPulsesPerRoom(floor) + 1);
      const mini = spawned[spawned.length - 1];
      expect(mini.length).toBe(1);
      const tier = R.riftTierOf(floor);
      if (floor === 1) {
        expect(mini[0].kind).toBe('brute');
        expect(mini[0].elite).toBe(true);
        expect(mini[0].maxHp).toBe(Math.round(ENEMY_DEFS.brute.hp * R.tierHpScale(tier) * 3));
      } else {
        expect(mini[0].kind).toBe('hive');
        expect(mini[0].maxHp).toBe(Math.round(ENEMY_DEFS.hive.hp * R.tierHpScale(tier) * R.RIFT_KEY_HIVE_HP));
      }
    }
  });

  it('kind weights by floor and biome; at most one blackhole per room', () => {
    const kinds = (f: number, b: 'hive' | 'prism', bh = true) => Object.fromEntries(R.riftKindWeights(f, b, bh));
    expect(kinds(1, 'hive')).toEqual({ drone: 15, dart: 4, weaver: 3 });
    expect(kinds(2, 'hive')).toEqual({ drone: 15, dart: 4, weaver: 3, splitter: 4.5, spinner: 2 });
    expect(kinds(3, 'hive')).toEqual({ drone: 15, dart: 4, weaver: 3, splitter: 4.5, spinner: 2, brute: 1.2 });
    expect(kinds(4, 'prism')).toEqual({ drone: 10, dart: 4, weaver: 4.5, splitter: 3, spinner: 3, brute: 1.2 });
    expect(kinds(5, 'prism')).toEqual({ drone: 10, dart: 4, weaver: 4.5, splitter: 3, spinner: 3, brute: 1.2, blackhole: 0.3 });
    expect(kinds(5, 'prism', false)).not.toHaveProperty('blackhole');

    // a room that already holds a blackhole never gets a second one from its pulses
    for (let seed = 1; seed <= 12; seed++) {
      const w = makeRift([ENTRANCE, { ...ARENA, size: 44 }], { floor: 6, seed });
      const room = w.map.dungeon!.rooms[1];
      makeShip(w, room.x, room.y);
      run(w, 1);
      const bh = spawnEnemy(w, 'blackhole', room.x + 200, room.y)!;
      for (let k = 0; k < 4; k++) {
        w.dungeon!.rooms[1].state = RIFT_DORMANT;
        riftEncounterReset(w, 1);
        w.enemies.set(bh.id, bh);
        seal(w, 1, 4);
        run(w, R.RIFT_PULSE_WARN_TICKS);
        const n = [...w.enemies.values()].filter((e) => e.kind === 'blackhole').length;
        expect(n).toBe(1);
      }
    }
  });
});

describe('leash (§4.4)', () => {
  // Room A interior cols/rows [20, 56), room B [60, 96): four wall columns (56..59) between them.
  const A: RoomSpec = { kind: 'arena', c0: 20, r0: 20, size: 36 };
  const B: RoomSpec = { kind: 'arena', c0: 60, r0: 20, size: 36 };

  function retargetNow(w: World, e: Enemy): void {
    e.aiTimer = 0;
    run(w, 1);
  }

  it('an enemy in room A ignores a ship in room B behind the wall, even 240 px away', () => {
    const w = makeRift([A, B]);
    const ship = makeShip(w, 61.5 * TS, 38 * TS);
    const e = spawnEnemy(w, 'drone', 54 * TS, 38 * TS)!;
    retargetNow(w, e);
    expect(Math.hypot(ship.x - e.x, ship.y - e.y)).toBeLessThan(R.RIFT_LEASH_PX);
    expect(e.targetId).toBe(0);
    run(w, 3 * TICK_RATE);
    expect(e.targetId).toBe(0);
    expect(Math.hypot(e.x - e.mem.hx, e.y - e.mem.hy)).toBeLessThan(40); // stayed home
  });

  it('... but chases a ship anywhere in its own room, beyond 900 px', () => {
    const w = makeRift([A, B]);
    const ship = makeShip(w, 21 * TS, 21 * TS);
    const e = spawnEnemy(w, 'drone', 54 * TS, 54 * TS)!;
    expect(Math.hypot(ship.x - e.x, ship.y - e.y)).toBeGreaterThan(R.RIFT_LEASH_PX);
    retargetNow(w, e);
    expect(e.targetId).toBe(ship.id);
  });

  it('... and a ship outside any room within 900 px with line of sight, not beyond 900 px', () => {
    // a 5-tile doorway gap through both rims joins the rooms
    const w = makeRift([A, B], { open: [[56, 36, 60, 41]] });
    const ship = makeShip(w, 58 * TS, 38.5 * TS);
    expect(R.roomIndexAt(w.map, ship.x, ship.y)).toBe(-1);
    const near = spawnEnemy(w, 'drone', 50 * TS, 38.5 * TS)!;
    const far = spawnEnemy(w, 'drone', 22 * TS, 38.5 * TS)!;
    expect(Math.hypot(ship.x - far.x, ship.y - far.y)).toBeGreaterThan(R.RIFT_LEASH_PX);
    near.aiTimer = 0; far.aiTimer = 0;
    run(w, 1);
    expect(near.targetId).toBe(ship.id);
    expect(far.targetId).toBe(0);
  });

  it('with no target a rift enemy steers home instead of wandering', () => {
    const w = makeRift([A, B]);
    const e = spawnEnemy(w, 'dart', 38 * TS, 38 * TS)!;
    const hx = e.mem.hx, hy = e.mem.hy;
    expect(hx).toBe(38 * TS);
    e.x += 400; e.y -= 250;
    run(w, 8 * TICK_RATE);
    expect(Math.hypot(e.x - hx, e.y - hy)).toBeLessThan(40);
  });

  it('instability hunters ignore the leash', () => {
    const w = makeRift([A, B]);
    const ship = makeShip(w, 61.5 * TS, 38 * TS);
    const e = spawnEnemy(w, 'dart', 54 * TS, 38 * TS)!;
    e.mem.hunt = 1;
    retargetNow(w, e);
    expect(e.targetId).toBe(ship.id);
  });
});

describe('dormancy (§4.4)', () => {
  const HALL: RoomSpec = { kind: 'hall', c0: 40, r0: 10, size: 28 };

  it('hall packs of (4 + f) are placed asleep once a ship exists; sleepers never move or retarget', () => {
    for (const n of [1, 3]) {
      const w = makeRift([ENTRANCE, HALL], { floor: 1, seed: 40 + n });
      expect(w.enemies.size).toBe(0); // pveInit ran before any ship: deferred
      for (let i = 0; i < n; i++) makeShip(w, 600 + i * 40, 600);
      run(w, 1);
      const sleepers = [...w.enemies.values()];
      expect(sleepers.length).toBe(Math.round(R.riftHallPackSize(1) * R.partyCountMult(n))); // floor 1: cost-1 kinds
      for (const e of sleepers) {
        expect(e.mem.sleep).toBe(1);
        expect(e.mem.room).toBe(1);
        expect(inRoom(w, e, 1)).toBe(true);
        expect(e.maxHp).toBe(Math.round(ENEMY_DEFS[e.kind].hp * R.partyHpMult(n) * (e.elite ? 3 : 1)));
      }
      expect(w.pve.mem[sleepKey(1)]).toBe(1);
      const pos = sleepers.map((e) => [e.x, e.y]);
      run(w, 5 * TICK_RATE);
      expect(sleepers.map((e) => [e.x, e.y])).toEqual(pos);
      for (const e of sleepers) { expect(e.mem.sleep).toBe(1); expect(e.targetId).toBe(0); }
    }
  });

  it('floor ≥ 4 halls hold two packs plus a spinner', () => {
    const w = makeRift([ENTRANCE, HALL], { floor: 4, seed: 5 });
    makeShip(w, 600, 600);
    run(w, 1);
    const sleepers = [...w.enemies.values()];
    let budget = 0;
    for (const e of sleepers) { expect(e.mem.sleep).toBe(1); budget += R.RIFT_KIND_COST[e.kind]; }
    expect(sleepers.some((e) => e.kind === 'spinner')).toBe(true);
    // two packs of (4 + 4) drone-equivalents + one spinner (2), per-pack rounding aside
    expect(budget).toBeGreaterThanOrEqual(2 * 8 - 4 + 2);
    expect(budget).toBeLessThanOrEqual(2 * 8 + 4 + 2);
  });

  it('a pack wakes when a ship enters its room', () => {
    const w = makeRift([ENTRANCE, HALL], { floor: 1 });
    const ship = makeShip(w, 600, 600);
    run(w, 1);
    const sleepers = [...w.enemies.values()];
    expect(sleepers.length).toBeGreaterThan(0);
    const hall = w.map.dungeon!.rooms[1];
    ship.x = hall.c0 * TS + 20; ship.y = hall.r0 * TS + 20; // corner, far from the markers
    run(w, 1);
    for (const e of sleepers) expect(e.mem.sleep).toBeUndefined();
    expect(w.pve.mem[sleepKey(1)]).toBeUndefined();
  });

  it('a pack wakes when one member is damaged', () => {
    const w = makeRift([ENTRANCE, HALL], { floor: 1 });
    const ship = makeShip(w, 600, 600);
    run(w, 1);
    const sleepers = [...w.enemies.values()];
    damageEnemy(w, sleepers[0], 1, ship.id);
    run(w, 1);
    for (const e of sleepers) if (w.enemies.has(e.id)) expect(e.mem.sleep).toBeUndefined();
  });

  it('a pack wakes on a ship within 600 px with line of sight, never through a wall; sleepers deal no contact damage', () => {
    // room A [20,48) and a doorway-less room B to its right [52,80): walls between. (Arena kinds: no floor packs, so
    // the only sleeper is the hand-placed one.)
    const w = makeRift([{ kind: 'arena', c0: 20, r0: 20, size: 28 }, { kind: 'arena', c0: 52, r0: 20, size: 28 }]);
    const sl = spawnEnemy(w, 'drone', 46 * TS, 34 * TS)!;
    sl.mem.sleep = 1; sl.mem.room = 0;
    w.pve.mem[sleepKey(0)] = 1;
    const ship = makeShip(w, 54 * TS, 34 * TS); // room B, 256 px away through the wall
    run(w, 2 * TICK_RATE);
    expect(sl.mem.sleep).toBe(1);

    // overlapping but on a tick with no proximity check: still asleep and harmless
    ship.invulnUntilTick = 0;
    const e0 = ship.energy;
    let t = w.tick;
    while ((t + 1 + sl.id) % 6 === 0) t++;
    w.tick = t;
    ship.x = sl.x + 4; ship.y = sl.y; // (the room-entry wake would fire: move the pack's room flag out of the way)
    delete w.pve.mem[sleepKey(0)];
    run(w, 1);
    expect(sl.mem.sleep).toBe(1);
    expect(ship.energy).toBe(e0);
    expect(w.enemies.has(sl.id)).toBe(true);

    // open corridor, 480 px, line of sight: wakes within the 6-tick check cadence
    const w2 = makeRift([{ kind: 'arena', c0: 20, r0: 20, size: 28 }], { open: [[48, 32, 70, 37]] });
    const s2 = spawnEnemy(w2, 'drone', 46 * TS, 34.5 * TS)!;
    s2.mem.sleep = 1; s2.mem.room = 0;
    makeShip(w2, 61 * TS, 34.5 * TS);
    run(w2, 6);
    expect(s2.mem.sleep).toBeUndefined();
  });

  it('treasure rooms: half get a guard pack of (3 + ⌊f/2⌋) weavers + a spinner at tier + 1', () => {
    let guarded = 0;
    const floor = 2, tier1 = R.riftTierOf(floor) + 1;
    for (let seed = 1; seed <= 40; seed++) {
      const w = makeRift([ENTRANCE, { kind: 'treasure', c0: 40, r0: 10, size: 20 }], { floor, seed });
      makeShip(w, 600, 600);
      run(w, 1);
      const es = [...w.enemies.values()];
      if (es.length === 0) continue;
      guarded++;
      expect(es.filter((e) => e.kind === 'weaver').length).toBe(3 + Math.floor(floor / 2));
      expect(es.filter((e) => e.kind === 'spinner').length).toBe(1);
      for (const e of es) {
        expect(e.mem.sleep).toBe(1);
        expect(e.maxHp).toBe(Math.round(ENEMY_DEFS[e.kind].hp * R.tierHpScale(tier1) * (e.elite ? 3 : 1)));
      }
    }
    expect(guarded).toBeGreaterThanOrEqual(10);
    expect(guarded).toBeLessThanOrEqual(30);
  });
});

describe('the Matriarch (§4.5)', () => {
  const BOSS: RoomSpec = { kind: 'boss', c0: 60, r0: 60, size: 46 };

  function bossWorld(o: RiftOpts & { n?: number; humans?: number } = {}) {
    const w = makeRift([ENTRANCE, BOSS], { floor: 3, ...o });
    const room = w.map.dungeon!.rooms[1];
    const ships: Ship[] = [];
    for (let i = 0; i < (o.n ?? 1); i++) ships.push(makeShip(w, room.x - 400 + i * 60, room.y + 400, { human: i < (o.humans ?? 0) }));
    run(w, 1);
    const ev = seal(w, 1, o.n ?? 1);
    const m = [...w.enemies.values()].find((e) => e.kind === 'matriarch')!;
    return { w, room, ships, m, ev };
  }

  function pastIntro(w: World): GameEvent[] {
    return run(w, Math.round(MATRIARCH_INTRO_SEC * TICK_RATE));
  }

  it('ENEMY_DEFS.matriarch is the real boss: radius 88 (≤ MAX_RADIUS 90), 30000 HP, speed 60, contact 320, XP / score 150', () => {
    expect(ENEMY_DEFS.matriarch).toMatchObject({ radius: 88, hp: 30000, speed: 60, contact: 320, xp: 150, score: 150 });
    expect(ENEMY_DEFS.matriarch.radius).toBeLessThanOrEqual(MAX_RADIUS);
  });

  it('a sealed boss room spawns her at the centre: bossIntro, bossId / bossPhase, HP × tier × party boss × difficulty', () => {
    const { w, room, m, ev } = bossWorld({ n: 2 });
    expect(m).toBeDefined();
    expect([m.x, m.y]).toEqual([room.x, room.y]);
    expect(ev).toContainEqual({ t: 'bossIntro', id: m.id, kind: 'matriarch', x: room.x, y: room.y });
    expect(w.dungeon!.bossId).toBe(m.id);
    expect(w.dungeon!.bossPhase).toBe(1);
    expect(w.pve.bossAlive).toBe(true);
    expect(m.maxHp).toBe(Math.round(30000 * R.tierHpScale(5) * R.partyBossHpMult(2)));
    expect(riftEncounterDone(w, 1)).toBe(false);

    const b = bossWorld({ floor: 6, pve: 3, n: 4 }).m;
    expect(b.maxHp).toBe(Math.round(30000 * R.tierHpScale(11) * R.partyBossHpMult(4) * 1.4));
    const s = bossWorld({ floor: 3, pve: 1, n: 1 }).m;
    expect(s.maxHp).toBe(Math.round(30000 * R.tierHpScale(5) * 0.7));
  });

  it('intro: 3 s with dmgTaken 0 (no HP lost, no attacks), then damage lands', () => {
    const { w, ships, m } = bossWorld({ n: 2 });
    expect(m.mem.dmgTaken).toBe(0);
    damageEnemy(w, m, 5000, ships[0].id);
    run(w, 1);
    expect(m.hp).toBe(m.maxHp);
    run(w, Math.round(MATRIARCH_INTRO_SEC * TICK_RATE) - 3);
    expect(w.enemies.size).toBe(1); // no drones yet
    expect(w.projectiles.size).toBe(0); // no rings yet
    expect(m.mem.dmgTaken).toBe(0);
    run(w, 2);
    expect(m.mem.dmgTaken).toBe(1);
    damageEnemy(w, m, 5000, ships[0].id);
    run(w, 1);
    expect(m.hp).toBe(m.maxHp - 5000);
  });

  it('phase thresholds: < 66% → 2, < 33% → 3, one bossPhase event per threshold crossed', () => {
    expect([1, 0.67, 0.66, 0.659, 0.34, 0.33, 0.329, 0].map(matriarchPhaseFor)).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
    const { w, m } = bossWorld();
    pastIntro(w);
    const phaseEvents = (ev: GameEvent[]) => ev.filter((e) => e.t === 'bossPhase');
    m.hp = m.maxHp * 0.67;
    expect(phaseEvents(run(w, 2))).toEqual([]);
    expect(m.mem.phase).toBe(1);
    m.hp = m.maxHp * 0.65;
    const e2 = phaseEvents(run(w, 1));
    expect(e2).toEqual([{ t: 'bossPhase', id: m.id, kind: 'matriarch', phase: 2, x: expect.any(Number), y: expect.any(Number) }]);
    expect(m.mem.phase).toBe(2);
    expect(w.dungeon!.bossPhase).toBe(2);
    m.hp = m.maxHp * 0.34;
    expect(phaseEvents(run(w, 1))).toEqual([]);
    m.hp = m.maxHp * 0.32;
    expect(phaseEvents(run(w, 1)).map((e) => (e as { phase: number }).phase)).toEqual([3]);
    expect(w.dungeon!.bossPhase).toBe(3);

    // a single big hit from P1 to P3 still announces both transitions, in order
    const b = bossWorld();
    pastIntro(b.w);
    b.m.hp = b.m.maxHp * 0.1;
    expect(phaseEvents(run(b.w, 1)).map((e) => (e as { phase: number }).phase)).toEqual([2, 3]);
  });

  it('P1: (4 + party) drones every 3 s and a 20-shot ring every 4.5 s', () => {
    const { w, m } = bossWorld({ n: 2 });
    pastIntro(w);
    const drones = () => [...w.enemies.values()].filter((e) => e.kind === 'drone').length;
    const shots = () => [...w.projectiles.values()].filter((p) => p.ownerId === m.id).length;
    run(w, TICK_RATE - 1);
    expect(drones()).toBe(0);
    run(w, 1);
    expect(drones()).toBe(MATRIARCH_DRONE_BASE + 2);
    run(w, TICK_RATE / 2);
    expect(shots()).toBe(20);
    clearEnemies(w); w.enemies.set(m.id, m); w.projectiles.clear();
    run(w, 3 * TICK_RATE);
    expect(drones()).toBe(MATRIARCH_DRONE_BASE + 2);
    run(w, 1.5 * TICK_RATE);
    expect(shots()).toBe(20);
  });

  it('P2: double rings 0.35 s apart share one 60° gap; Brood Burst warns, then drops 3 splitters', () => {
    const { w, m } = bossWorld();
    pastIntro(w);
    m.hp = m.maxHp * 0.6;
    const ringTicks: { tick: number; angles: number[] }[] = [];
    let broodWarn = -1, broodTick = -1;
    const seen = new Set<number>();
    for (let i = 0; i < 12 * TICK_RATE; i++) {
      const splittersBefore = [...w.enemies.values()].filter((e) => e.kind === 'splitter').length;
      const ev = run(w, 1);
      if (broodWarn < 0 && warns(ev).length) broodWarn = w.tick;
      const splitters = [...w.enemies.values()].filter((e) => e.kind === 'splitter').length;
      if (broodTick < 0 && splitters === splittersBefore + 3) broodTick = w.tick;
      const fresh = [...w.projectiles.values()].filter((p) => p.ownerId === m.id && !seen.has(p.id));
      for (const p of fresh) seen.add(p.id);
      if (fresh.length) ringTicks.push({ tick: w.tick, angles: fresh.map((p) => Math.atan2(p.vy, p.vx)) });
      m.hp = Math.min(m.hp, m.maxHp * 0.6);
    }
    expect(ringTicks.length).toBeGreaterThanOrEqual(2);
    const [r1, r2] = ringTicks;
    expect(r2.tick - r1.tick).toBe(Math.round(MATRIARCH_DOUBLE_RING_SEC * TICK_RATE));
    for (const r of [r1, r2]) {
      expect(r.angles.length).toBeGreaterThanOrEqual(16);
      expect(r.angles.length).toBeLessThanOrEqual(17);
      // the widest angular hole between consecutive shots is the ≥ 60° lane
      const a = r.angles.map((x) => (x + Math.PI * 2) % (Math.PI * 2)).sort((p, q) => p - q);
      let gap = a[0] + Math.PI * 2 - a[a.length - 1];
      for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
      expect(gap).toBeGreaterThanOrEqual(Math.PI / 3);
    }
    expect(m.mem.phase).toBe(2);
    expect(broodWarn).toBeGreaterThan(0);
    expect(broodTick - broodWarn).toBe(R.RIFT_PULSE_WARN_TICKS);
  });

  it('P3: a 0.8 s line telegraph, then a 900 px/s dash; hitting a wall ends it with 4 splitlings', () => {
    const { w, room, ships, m } = bossWorld();
    pastIntro(w);
    // park her and the ship near the east wall so the dash runs into it
    const east = room.c1 * TS;
    m.x = east - 420; m.y = room.y;
    ships[0].x = east - 30; ships[0].y = room.y;
    m.hp = m.maxHp * 0.3;
    let tele: Extract<GameEvent, { t: 'telegraph' }> | null = null;
    let teleTick = -1;
    for (let i = 0; i < 4 * TICK_RATE && !tele; i++) {
      const ev = run(w, 1);
      const t = ev.find((e): e is Extract<GameEvent, { t: 'telegraph' }> => e.t === 'telegraph');
      if (t) { tele = t; teleTick = w.tick; }
    }
    expect(tele).not.toBeNull();
    expect(tele!.shape).toBe('line');
    expect(tele!.sec).toBeCloseTo(0.8, 9);
    expect(tele!.r).toBe(m.radius);
    expect(tele!.x2).toBeGreaterThan(tele!.x);
    const splitlings = () => [...w.enemies.values()].filter((e) => e.kind === 'splitling').length;
    const before = splitlings();
    run(w, Math.round(0.8 * TICK_RATE) + 1);
    expect(Math.hypot(m.vx, m.vy)).toBeGreaterThan(800); // dashing (or it already hit the wall this tick)
    let hit = false;
    for (let i = 0; i < TICK_RATE && !hit; i++) { run(w, 1); hit = splitlings() >= before + 4; }
    expect(hit).toBe(true);
    expect(m.aiState).toBe(0);
    expect(w.tick - teleTick).toBeLessThanOrEqual(Math.round((0.8 + 0.6) * TICK_RATE) + 1);
  });

  it('floor 6: one Hive add (HP ×0.6) at each threshold, never past MAX_HIVES', () => {
    const { w, m } = bossWorld({ floor: 6 });
    pastIntro(w);
    const hives = () => [...w.enemies.values()].filter((e) => e.kind === 'hive');
    m.hp = m.maxHp * 0.65;
    run(w, 1);
    expect(hives().length).toBe(1);
    expect(hives()[0].maxHp).toBe(Math.round(ENEMY_DEFS.hive.hp * R.tierHpScale(11) * 0.6));
    expect(inRoom(w, hives()[0], 1)).toBe(true);
    m.hp = m.maxHp * 0.32;
    run(w, 1);
    expect(hives().length).toBe(2);

    // floor 3: no adds; floor 6 with two Hives already up: no third
    const f3 = bossWorld({ floor: 3 });
    pastIntro(f3.w);
    f3.m.hp = f3.m.maxHp * 0.2;
    run(f3.w, 1);
    expect([...f3.w.enemies.values()].some((e) => e.kind === 'hive')).toBe(false);
    const full = bossWorld({ floor: 6 });
    pastIntro(full.w);
    spawnEnemy(full.w, 'hive', full.room.x - 300, full.room.y - 300);
    spawnEnemy(full.w, 'hive', full.room.x + 300, full.room.y - 300);
    full.m.hp = full.m.maxHp * 0.2;
    run(full.w, 1);
    expect([...full.w.enemies.values()].filter((e) => e.kind === 'hive').length).toBe(2);
  });

  it('death: Hive-style splash, boss pointer cleared, room done, and a personal bossCache for every human', () => {
    const { w, ships, m } = bossWorld({ n: 3, humans: 2, lootMult: 1 });
    pastIntro(w);
    clearEnemies(w); w.enemies.set(m.id, m); w.pve.bossAlive = true;
    roll.mockClear();
    damageEnemy(w, m, 1e9, ships[1].id);
    expect(w.enemies.has(m.id)).toBe(false);
    expect(w.dungeon!.bossId).toBe(0);
    expect(w.pve.bossAlive).toBe(false);
    expect(riftEncounterDone(w, 1)).toBe(true);
    const calls = roll.mock.calls.filter((c) => c[1] === 'bossCache');
    expect(calls.length).toBe(1);
    expect(calls[0][4]).toEqual({ priorityPid: ships[1].playerId, personalFor: [ships[0].playerId, ships[1].playerId] });
    expect(roll.mock.calls.some((c) => c[1] === 'boss' || c[1] === 'elite')).toBe(false);
    const caches = [...(w.loot?.values() ?? [])];
    expect(caches.length).toBe(4); // [rare+, common+] per human
    expect(caches.filter((c) => c.reservedFor === ships[0].playerId).length).toBe(2);
    expect(caches.filter((c) => c.reservedFor === ships[1].playerId).length).toBe(2);
    expect(caches.every((c) => c.token.source === 'bossCache')).toBe(true);
  });

  it('a regroup reset removes her; the next seal brings a fresh Matriarch', () => {
    const { w, m } = bossWorld();
    pastIntro(w);
    m.hp = m.maxHp * 0.5;
    riftEncounterReset(w, 1);
    w.dungeon!.rooms[1].state = RIFT_DORMANT;
    expect(w.enemies.has(m.id)).toBe(false);
    expect(w.dungeon!.bossId).toBe(0);
    expect(w.pve.bossAlive).toBe(false);
    const ev = seal(w, 1, 1);
    const m2 = [...w.enemies.values()].find((e) => e.kind === 'matriarch')!;
    expect(m2.hp).toBe(m2.maxHp);
    expect(ev.some((e) => e.t === 'bossIntro')).toBe(true);
  });

  it('once she died, a regroup reset of her room (adds still inside) never brings her back nor re-rolls the bossCache (integrator fix)', () => {
    const { w, room, ships, m } = bossWorld({ n: 2, humans: 2, lootMult: 1 });
    pastIntro(w);
    roll.mockClear();
    const add = spawnEnemy(w, 'splitter', room.x + 200, room.y)!; // an add keeps the room sealed after her death
    damageEnemy(w, m, 1e9, ships[0].id);
    expect(w.enemies.has(m.id)).toBe(false);
    expect(w.enemies.has(add.id)).toBe(true);
    expect(riftEncounterDone(w, 1)).toBe(false);
    const caches = () => roll.mock.calls.filter((c) => c[1] === 'bossCache').length;
    expect(caches()).toBe(1);
    // the party goes down: SIM's regroup reset, then a re-seal
    riftEncounterReset(w, 1);
    w.dungeon!.rooms[1].state = RIFT_DORMANT;
    const ev = seal(w, 1, 2);
    expect([...w.enemies.values()].some((e) => e.kind === 'matriarch')).toBe(false);
    expect(ev.some((e) => e.t === 'bossIntro')).toBe(false);
    expect(riftEncounterDone(w, 1)).toBe(true); // an empty encounter: the room clears as soon as it is empty
    run(w, 5 * TICK_RATE);
    expect([...w.enemies.values()].some((e) => e.kind === 'matriarch')).toBe(false);
    expect(caches()).toBe(1);
  });
});

describe('instability (§4.4)', () => {
  const BIG: RoomSpec = { kind: 'arena', c0: 50, r0: 50, size: 100 };

  function atFloorSec(w: World, sec: number): void {
    w.tick = w.dungeon!.floorStartTick + Math.round(sec * TICK_RATE);
  }

  it('onset at 420 s (no event before: the 360 s warning is the HUD\'s), then a hunter pack every 25 s', () => {
    const w = makeRift([ENTRANCE, BIG], { floor: 1 });
    const room = w.map.dungeon!.rooms[1];
    const ship = makeShip(w, room.x, room.y);
    atFloorSec(w, 300);
    expect(run(w, 5).filter((e) => e.t === 'instability')).toEqual([]);
    atFloorSec(w, 360 - 2 / TICK_RATE);
    expect(run(w, 3 * TICK_RATE).filter((e) => e.t === 'instability')).toEqual([]);
    expect(w.enemies.size).toBe(0);
    expect(w.dungeon!.instabilityTick).toBe(0);

    atFloorSec(w, RIFT_SOFT_LIMIT_SEC - 1 / TICK_RATE);
    const onset = run(w, 1);
    expect(onset.filter((e) => e.t === 'instability')).toEqual([{ t: 'instability', sec: R.RIFT_HUNTER_EVERY_SEC }]);
    const t0 = w.tick;
    expect(w.dungeon!.instabilityTick).toBe(t0 + 25 * TICK_RATE);
    const hunters = [...w.enemies.values()];
    expect(hunters.length).toBe(4 + 1);
    const kind = hunters[0].kind;
    expect(['dart', 'weaver']).toContain(kind);
    for (const e of hunters) {
      expect(e.kind).toBe(kind);
      expect(e.mem.hunt).toBe(1);
      const d = Math.hypot(e.x - ship.x, e.y - ship.y);
      expect(d).toBeGreaterThanOrEqual(R.RIFT_HUNTER_MIN_PX - 170);
      expect(d).toBeLessThanOrEqual(R.RIFT_HUNTER_MAX_PX + 170);
      // tier + 2 (floor 1 → tier 3), instability HP ≈ 1 at the onset
      expect(e.maxHp).toBe(Math.round(ENEMY_DEFS[e.kind].hp * R.tierHpScale(3) * R.riftInstabilityHpMult(RIFT_SOFT_LIMIT_SEC, RIFT_SOFT_LIMIT_SEC) * (e.elite ? 3 : 1)));
    }
    // cadence: nothing more until +25 s, then the next pack (announced again)
    clearEnemies(w);
    const between = run(w, 25 * TICK_RATE - 1);
    expect(w.enemies.size).toBe(0);
    expect(between.filter((e) => e.t === 'instability')).toEqual([]);
    const second = run(w, 1);
    expect(w.enemies.size).toBe(5);
    expect(second.filter((e) => e.t === 'instability')).toEqual([{ t: 'instability', sec: R.RIFT_HUNTER_EVERY_SEC }]);
    expect(w.dungeon!.instabilityTick).toBe(t0 + 50 * TICK_RATE);

    // every active ship inside a sealed (or arming) room: that pack is skipped silently (the clock still advances)
    clearEnemies(w);
    w.dungeon!.rooms[1].state = RIFT_SEALED;
    const skipped = run(w, 25 * TICK_RATE);
    expect(w.enemies.size).toBe(0);
    expect(skipped.filter((e) => e.t === 'instability')).toEqual([]);
    expect(w.dungeon!.instabilityTick).toBe(t0 + 75 * TICK_RATE);
    w.dungeon!.rooms[1].state = RIFT_ARMING;
    run(w, 25 * TICK_RATE);
    expect(w.enemies.size).toBe(0);
  });

  it('on real generated floors a hunter pack lands every 25 s with the party parked in any room kind (integrator fix)', () => {
    let packs = 0, expected = 0;
    for (const seed of [1, 5, 1234, 777, 99999, 31337]) {
      for (const floor of [1, 3, 4, 6]) {
        const probe = generateFloor(seed, floor, 1);
        for (const kind of ['entrance', 'treasure', 'hall', 'arena'] as RiftRoomKind[]) {
          const target = probe.dungeon!.rooms.find((r) => r.kind === kind);
          if (!target) continue;
          const map = generateFloor(seed, floor, 1);
          const w = createWorld({
            mapSeed: seed, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0,
            friendlyFire: false, gameType: 'dungeon', subMode: 'coop', floors: 6, lootMult: 0, lootSeed: 1,
          }, map);
          w.dungeon = riftState(map, floor);
          pveInit(w);
          const room = map.dungeon!.rooms[target.idx];
          if (kind !== 'entrance') w.dungeon.rooms[room.idx].state = RIFT_CLEARED; // visited, not a sealed fight
          for (let i = 0; i < 2; i++) makeShip(w, room.x + i * 40, room.y);
          atFloorSec(w, RIFT_SOFT_LIMIT_SEC - 1 / TICK_RATE);
          for (let p = 0; p < 3; p++) {
            if (p > 0) w.tick = w.dungeon.instabilityTick - 1;
            for (const e of [...w.enemies.values()]) if (e.mem.hunt) w.enemies.delete(e.id);
            run(w, 1);
            expected++;
            const hunters = [...w.enemies.values()].filter((e) => e.mem.hunt === 1);
            if (hunters.length > 0) packs++;
            for (const e of hunters) {
              expect(isSolidAt(map, e.x, e.y)).toBe(false);
              expect(Math.hypot(e.x - room.x, e.y - room.y)).toBeGreaterThanOrEqual(R.RIFT_HUNTER_MIN_PX - 200);
            }
          }
        }
      }
    }
    expect(expected).toBeGreaterThan(200);
    expect(packs).toBe(expected);
  });

  it('the onset is announced even when its first pack has nowhere to go', () => {
    const w = makeRift([ENTRANCE, BIG], { floor: 2 });
    const room = w.map.dungeon!.rooms[1];
    makeShip(w, room.x, room.y);
    w.dungeon!.rooms[1].state = RIFT_SEALED;
    atFloorSec(w, RIFT_SOFT_LIMIT_SEC - 1 / TICK_RATE);
    expect(run(w, 1).filter((e) => e.t === 'instability')).toHaveLength(1);
    expect(w.enemies.size).toBe(0);
  });

  it('enemy HP +10% per minute past the soft limit, on rift spawns from then on', () => {
    expect(R.riftInstabilityHpMult(300, 420)).toBe(1);
    expect(R.riftInstabilityHpMult(420, 420)).toBe(1);
    expect(R.riftInstabilityHpMult(480, 420)).toBeCloseTo(1.1, 9);
    expect(R.riftInstabilityHpMult(540, 420)).toBeCloseTo(1.2, 9);

    const w = makeRift([ENTRANCE, ARENA], { floor: 1 });
    const room = w.map.dungeon!.rooms[1];
    makeShip(w, room.x, room.y);
    w.dungeon!.instabilityTick = 1e12; // keep hunters out of this check
    atFloorSec(w, 540 - R.RIFT_PULSE_WARN_TICKS / TICK_RATE);
    seal(w, 1, 1);
    run(w, R.RIFT_PULSE_WARN_TICKS);
    const pulse = [...w.enemies.values()];
    expect(pulse.length).toBe(10);
    const mult = R.riftInstabilityHpMult(540, RIFT_SOFT_LIMIT_SEC);
    for (const e of pulse) expect(e.maxHp).toBe(Math.round(ENEMY_DEFS[e.kind].hp * mult * (e.elite ? 3 : 1)));
  });
});

describe('determinism + misc', () => {
  it('two identical rifts produce identical encounters (world.rng only)', () => {
    const snap = () => {
      const w = makeRift([ENTRANCE, { kind: 'hall', c0: 40, r0: 10, size: 28 }, ARENA], { floor: 5, seed: 4321 });
      const room = w.map.dungeon!.rooms[2];
      makeShip(w, room.x, room.y);
      makeShip(w, room.x + 50, room.y);
      run(w, 1);
      seal(w, 2, 2);
      const ev = run(w, 20 * TICK_RATE);
      return JSON.stringify({
        ev: ev.filter((e) => e.t === 'spawnWarn'),
        en: [...w.enemies.values()].map((e) => [e.id, e.kind, Math.round(e.x), Math.round(e.y), e.hp, e.elite]),
      });
    };
    expect(snap()).toBe(snap());
  });

  it('recomputeShipStats rebuilds stats from class + upgrades and keeps the energy fraction', () => {
    const w = makeRift([ENTRANCE]);
    const s = makeShip(w, 600, 600, { cls: 'brute' });
    s.energy = s.stats.maxEnergy * 0.25;
    s.shipClass = 'tech';
    recomputeShipStats(s);
    expect(s.stats).toEqual(computeStats('tech', {}));
    expect(s.energy / s.stats.maxEnergy).toBeCloseTo(0.25, 9);
  });

  it('roomIndexAt reads the layout interiors (−1 in corridors / rims / off-layout maps)', () => {
    const w = makeRift([ENTRANCE, ARENA]);
    const [ent, arena] = w.map.dungeon!.rooms;
    expect(R.roomIndexAt(w.map, center(ent).x, center(ent).y)).toBe(0);
    expect(R.roomIndexAt(w.map, center(arena).x, center(arena).y)).toBe(1);
    expect(R.roomIndexAt(w.map, arena.c0 * TS - 1, arena.y)).toBe(-1);
    expect(R.roomIndexAt({ ...w.map, dungeon: undefined }, arena.x, arena.y)).toBe(-1);
  });

  it('outside a rift nothing changes: no home / sleep bookkeeping on spawned enemies', () => {
    const w = createWorld({ mapSeed: 5, mode: 'teams', teamCount: 2, pveIntensity: 2, matchSeconds: 600, scoreLimit: 0, friendlyFire: false }, buildRift([ENTRANCE], 1));
    pveInit(w);
    const e = spawnEnemy(w, 'drone', 700, 700)!;
    expect(e.mem).toEqual({});
  });
});
