// OWNER: AI agent. v0.3 M4 rift bots (docs/v0.3-proposal.md §4.9): pure riftGoal() rules and brain behaviour on a
// hand-built rift floor (real map module, no Sim), plus nav's map.rev rebuild and the fill-bot class complement.
// The real-Sim ready gate ("4 normal bots clear floor 1 of seed 1234 within 6 sim-minutes") is riftParity.test.ts.
import { describe, expect, it } from 'vitest';
import { SHIP_CLASSES } from '../data/ships';
import { isSolidAt } from '../sim/map';
import { createWorld, rebuildGrid } from '../sim/world';
import {
  RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL,
  emptyInput, type Enemy, type GameMap, type InputState, type RiftDoor, type RiftLayout, type RiftRoom,
  type RiftRoomKind, type RiftState, type Ship, type ShipClassId, type SimConfig, type World,
} from '../types';
import { createBotBrain } from './bots';
import { findPath, getNavGrid } from './nav';
import {
  FOLLOW_FAR_PX, FOLLOW_NEAR_PX, RIFT_BURN_PX, RIFT_CHEST_GIVEUP_SEC, RIFT_GROUP_R, RIFT_PORTAL_R, RIFT_SCORE, RIFT_WAIT_MAX_SEC,
  doorOutside, inRoomRect, newRiftMem, riftAnchor, riftCanEngage, riftFillClass, riftForbiddenRoom, riftFrontier,
  riftGoal, riftRetreatPoint, riftRoomIndexAt,
} from './riftGoals';

const TS = 32, COLS = 200, ROWS = 200;

interface Spec { kind: RiftRoomKind; cx: number; cy: number; size: number; main: boolean; depth: number }

/**
 * A hand-built floor on the real 200×200 grid, laid out like floorgen (§4.2): ROCK fill, rooms in 50-tile macro
 * cells with a 2-tile WALL rim, 5-wide straight corridors, TILE_DOOR where a corridor crosses a sealable rim.
 *   entrance (0,0) — hall (1,0) — arena (2,0) — key (3,0);  treasure (2,1) branches off the arena.
 */
function makeRiftMap(): GameMap {
  const specs: Spec[] = [
    { kind: 'entrance', cx: 0, cy: 0, size: 24, main: true, depth: 0 },
    { kind: 'hall', cx: 1, cy: 0, size: 28, main: true, depth: 1 },
    { kind: 'arena', cx: 2, cy: 0, size: 38, main: true, depth: 2 },
    { kind: 'key', cx: 3, cy: 0, size: 40, main: true, depth: 3 },
    { kind: 'treasure', cx: 2, cy: 1, size: 18, main: false, depth: 3 },
  ];
  const links: [number, number][] = [[0, 1], [1, 2], [2, 3], [2, 4]];
  const tiles = new Uint8Array(COLS * ROWS).fill(TILE_ROCK);
  const set = (c: number, r: number, v: number) => { tiles[r * COLS + c] = v; };
  const rooms: RiftRoom[] = specs.map((s, idx) => {
    const cc = s.cx * 50 + 25, cr = s.cy * 50 + 25;
    const c0 = cc - Math.floor(s.size / 2), r0 = cr - Math.floor(s.size / 2);
    const c1 = c0 + s.size, r1 = r0 + s.size;
    for (let r = r0 - 2; r < r1 + 2; r++) for (let c = c0 - 2; c < c1 + 2; c++) set(c, r, TILE_WALL);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) set(c, r, s.kind === 'entrance' ? TILE_BASE : TILE_EMPTY);
    const x = ((c0 + c1) / 2) * TS, y = ((r0 + r1) / 2) * TS;
    const sealable = s.kind === 'arena' || s.kind === 'key';
    const chests = sealable ? [x, y + 128] : s.kind === 'treasure' ? [x - 0.4 * s.size * 16, y, x + 0.4 * s.size * 16, y] : [];
    const half = s.size * 16;
    const spawns = [x + half * 0.72, y, x - half * 0.72, y, x, y + half * 0.72, x, y - half * 0.72];
    return {
      idx, kind: s.kind, c0, r0, c1, r1, x, y, doors: [], spawns, chests, links: [], depth: s.depth, mainPath: s.main,
      party: s.kind === 'entrance' ? 0 : -1,
    };
  });
  for (const [a, b] of links) {
    const A = rooms[a], B = rooms[b];
    A.links.push(b); B.links.push(a);
    const horiz = specs[a].cy === specs[b].cy;
    const doorOf = (R: RiftRoom, rimTiles: number[], inX: number, inY: number) => {
      if (R.kind !== 'arena' && R.kind !== 'key' && R.kind !== 'boss') return;
      const door: RiftDoor = { tiles: rimTiles, inX, inY };
      for (const t of rimTiles) tiles[t] = TILE_DOOR;
      R.doors.push(door);
    };
    if (horiz) {
      const cr = specs[a].cy * 50 + 25;
      const L = A.c1 < B.c0 ? A : B, R = L === A ? B : A;
      for (let r = cr - 2; r <= cr + 2; r++) for (let c = L.c1; c < R.c0; c++) set(c, r, TILE_EMPTY);
      const rimL: number[] = [], rimR: number[] = [];
      for (let r = cr - 2; r <= cr + 2; r++) { rimL.push(r * COLS + L.c1, r * COLS + L.c1 + 1); rimR.push(r * COLS + R.c0 - 2, r * COLS + R.c0 - 1); }
      doorOf(L, rimL, (L.c1 - 3) * TS, (cr + 0.5) * TS);
      doorOf(R, rimR, (R.c0 + 3) * TS, (cr + 0.5) * TS);
    } else {
      const cc = specs[a].cx * 50 + 25;
      const T = A.r1 < B.r0 ? A : B, Bo = T === A ? B : A;
      for (let c = cc - 2; c <= cc + 2; c++) for (let r = T.r1; r < Bo.r0; r++) set(c, r, TILE_EMPTY);
      const rimT: number[] = [], rimB: number[] = [];
      for (let c = cc - 2; c <= cc + 2; c++) { rimT.push(T.r1 * COLS + c, (T.r1 + 1) * COLS + c); rimB.push((Bo.r0 - 2) * COLS + c, (Bo.r0 - 1) * COLS + c); }
      doorOf(T, rimT, (cc + 0.5) * TS, (T.r1 - 3) * TS);
      doorOf(Bo, rimB, (cc + 0.5) * TS, (Bo.r0 + 3) * TS);
    }
  }
  const key = rooms[3];
  const layout: RiftLayout = {
    floor: 1, biome: 'hive', bossFloor: false, rooms, entrances: [0], keyRoom: 3,
    portalX: key.x, portalY: key.y, extractX: -1, extractY: -1,
  };
  const e = rooms[0];
  return {
    seed: 1234, teamCount: 1, width: COLS * TS, height: ROWS * TS, tileSize: TS, cols: COLS, rows: ROWS, tiles,
    spawns: [0, 1, 2, 3].map((i) => ({ team: 0, x: e.x + Math.cos(i * 1.57) * 110, y: e.y + Math.sin(i * 1.57) * 110 })),
    dungeon: layout, rev: 0,
  };
}

function makeRiftState(L: RiftLayout): RiftState {
  const e = L.rooms[L.entrances[0]];
  return {
    floor: 1, floorsTotal: 3, floorStartTick: 0,
    rooms: L.rooms.map((r) => ({ state: r.kind === 'entrance' ? RIFT_CLEARED : RIFT_DORMANT, until: 0, sealedBy: -1, chests: 0, vacantTicks: 0 })),
    parties: [{ team: 0, lives: 10, status: 'active', anchorX: e.x, anchorY: e.y - 120, seen: 1, roomsCleared: 0, bossesKilled: 0, deepestFloor: 1 }],
    portal: 0, departTick: 0, extractOpen: false, victoryTick: 0, bossId: 0, bossPhase: 0, pendingFloor: 0,
    outcome: 'running', extracted: [], instabilityTick: 0,
  };
}

function makeRiftWorld(): World {
  const map = makeRiftMap();
  const cfg: SimConfig = {
    mapSeed: 1234, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
    gameType: 'dungeon', subMode: 'coop', floors: 3, lootMult: 0,
  };
  const w = createWorld(cfg, map);
  w.dungeon = makeRiftState(map.dungeon!);
  return w;
}

/** Seal / unseal like floorgen.applyRoomSeals (test stand-in): WALL over SEALED doors, DOOR otherwise; bumps rev. */
function applySeals(map: GameMap, st: RiftState): void {
  let changed = false;
  for (const r of map.dungeon!.rooms) {
    const v = st.rooms[r.idx].state === RIFT_SEALED ? TILE_WALL : TILE_DOOR;
    for (const d of r.doors) for (const t of d.tiles) if (map.tiles[t] !== v) { map.tiles[t] = v; changed = true; }
  }
  if (changed) map.rev = (map.rev ?? 0) + 1;
}

let nextId = 1;
function makeShip(w: World, cls: ShipClassId, x: number, y: number, isBot = true, playerId?: number): Ship {
  const b = SHIP_CLASSES[cls].base;
  const stats = { ...b, skill: { ...b.skill } };
  const id = nextId++;
  const s: Ship = {
    id, playerId: playerId ?? id, name: 'p' + id, team: 0, shipClass: cls, isBot,
    x, y, vx: 0, vy: 0, angle: 0, alive: true, respawnTick: 0, invulnUntilTick: 0,
    energy: stats.maxEnergy, stats, input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0, path: null,
    gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
    utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0, skillState: {},
    attachedTo: 0, turrets: [], xp: 0, level: 1, xpToNext: 10, offers: [], offerSerial: 0, upgrades: {}, autoState: {},
    kills: 0, deaths: 0, score: 0, bounty: 10, killStreak: 0, enemyKills: 0, lastDamagedBy: 0, lastDamagedTick: 0,
    flags: 0,
  };
  w.ships.set(id, s);
  w.shipsByPlayer.set(s.playerId, id);
  w.nextId = Math.max(w.nextId, id + 1);
  return s;
}

function makeEnemy(w: World, x: number, y: number, mem: Record<string, number> = {}): Enemy {
  const id = nextId++;
  const e: Enemy = {
    id, kind: 'drone', x, y, vx: 0, vy: 0, angle: 0, hp: 100, maxHp: 100, radius: 14, elite: false, targetId: 0,
    spawnTick: 0, aiState: 0, aiTimer: 0, mem, contactDamage: 10, scoreValue: 1, xpValue: 1,
  };
  w.enemies.set(id, e);
  w.nextId = Math.max(w.nextId, id + 1);
  return e;
}

/** Crude integrator (turn to aim, move at input × speed, stop at walls). */
function applyInput(w: World, s: Ship, inp: InputState, speed = 420): void {
  s.prevInput = s.input;
  s.input = inp;
  s.angle = inp.aim;
  if (s.attachedTo) { s.vx = s.vy = 0; return; }
  s.vx = inp.moveX * speed * (inp.afterburner ? 1.5 : 1); s.vy = inp.moveY * speed * (inp.afterburner ? 1.5 : 1);
  const nx = s.x + s.vx / 60, ny = s.y + s.vy / 60;
  if (!isSolidAt(w.map, nx, ny)) { s.x = nx; s.y = ny; } else if (!isSolidAt(w.map, nx, s.y)) s.x = nx;
  else if (!isSolidAt(w.map, s.x, ny)) s.y = ny;
  else { s.vx = 0; s.vy = 0; }
}

type Brain = ReturnType<typeof createBotBrain>;
function step(w: World, pilots: [Ship, Brain | null][], each?: () => void): void {
  rebuildGrid(w);
  const ins = pilots.map(([s, b]) => (b ? b.think(w, s) : null));
  pilots.forEach(([s], i) => { const inp = ins[i]; if (inp) applyInput(w, s, inp); });
  w.tick++;
  each?.();
}

const dist = (a: { x: number; y: number }, x: number, y: number): number => Math.hypot(a.x - x, a.y - y);

describe('v0.3 M4 rift goals (pure, §4.9)', () => {
  it('fixture: rooms, doors and the frontier read like a real floor', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    expect(L.rooms[2].doors.length).toBe(3); // arena: hall, key and treasure sides
    expect(L.rooms[3].doors.length).toBe(1);
    expect(L.rooms[1].doors.length).toBe(0); // halls never seal
    for (const r of L.rooms) {
      expect(riftRoomIndexAt(L, TS, r.x, r.y)).toBe(r.idx);
      expect(isSolidAt(w.map, r.x, r.y)).toBe(false);
    }
    expect(riftRoomIndexAt(L, TS, (L.rooms[0].c1 + 5) * TS, L.rooms[0].y)).toBe(-1); // corridor
    // entrance is CLEARED → frontier is the hall; the treasure branch is never a frontier
    expect(riftFrontier(L, w.dungeon!)).toBe(1);
    w.dungeon!.rooms[1].state = RIFT_CLEARED;
    w.dungeon!.rooms[2].state = RIFT_CLEARED;
    expect(riftFrontier(L, w.dungeon!)).toBe(3);
    w.dungeon!.rooms[3].state = RIFT_CLEARED;
    expect(riftFrontier(L, w.dungeon!)).toBe(-1);
    // the door's outside point is open, outside the room, and reaches the in-point in a straight line
    const d = L.rooms[2].doors[0];
    const o = doorOutside(w, d);
    expect(isSolidAt(w.map, o.x, o.y)).toBe(false);
    expect(inRoomRect(L.rooms[2], TS, o.x, o.y)).toBe(false);
  });

  it('1. inside an ARMING or SEALED room: fight there (hold near the centre), whatever else is going on', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const arena = L.rooms[2];
    const human = makeShip(w, 'brute', L.rooms[0].x, L.rooms[0].y, false, 1);
    const bot = makeShip(w, 'tech', arena.x + 200, arena.y + 100);
    for (const s of [RIFT_ARMING, RIFT_SEALED] as const) {
      st.rooms[2].state = s;
      const g = riftGoal(w, bot, newRiftMem())!;
      expect(g.kind).toBe('fight');
      expect(g.sealedRoom).toBe(2);
      expect([g.x, g.y]).toEqual([arena.x, arena.y]);
      expect(g.hold).toBe(true);
      expect(g.score).toBe(RIFT_SCORE.fight);
    }
    // the human is far away in the entrance — the sealed room still wins (rule 1 before rule 2)
    expect(human.alive).toBe(true);
  });

  it('2. follows the lowest-pid free human: 200–450 px behind, spread, farther = more urgent, afterburn past 1000 px', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const hall = L.rooms[1];
    const h2 = makeShip(w, 'brute', hall.x - 200, hall.y, false, 50);
    const h1 = makeShip(w, 'tech', hall.x, hall.y, false, 40); // lower pid → leader
    h1.vx = 300; h1.vy = 0; // heading +x
    const bot = makeShip(w, 'engineer', hall.x - 350, hall.y + 20);
    const g = riftGoal(w, bot, newRiftMem())!;
    expect(g.kind).toBe('follow');
    // behind the LEADER (h1, pid 40), i.e. on its -x side, inside the band
    const dFromLeader = dist(g, h1.x, h1.y);
    expect(dFromLeader).toBeGreaterThanOrEqual(FOLLOW_NEAR_PX - 1);
    expect(dFromLeader).toBeLessThanOrEqual(FOLLOW_FAR_PX + 1);
    expect(g.x).toBeLessThan(h1.x);
    expect(g.hold).toBe(true);
    expect(g.score).toBe(RIFT_SCORE.followNear);
    expect(h2.alive).toBe(true);
    // far away: travel, more urgent with distance, afterburn past RIFT_BURN_PX
    bot.x = hall.x - 700; bot.y = hall.y;
    const mid = riftGoal(w, bot, newRiftMem())!;
    expect(mid.hold).toBe(false);
    expect(mid.score).toBeGreaterThan(RIFT_SCORE.followFar);
    expect(mid.burn).toBe(false);
    bot.x = L.rooms[0].x; bot.y = L.rooms[0].y; // ≈ 1600 px back
    const far = riftGoal(w, bot, newRiftMem())!;
    expect(dist(bot, h1.x, h1.y)).toBeGreaterThan(RIFT_BURN_PX);
    expect(far.score).toBeGreaterThan(mid.score);
    expect(far.score).toBeGreaterThan(0.9); // beats farming (≤ 0.78) so bots don't get left behind
    expect(far.burn).toBe(true);
    // two followers get different spots
    const bot2 = makeShip(w, 'brute', hall.x - 350, hall.y - 20);
    bot.x = hall.x - 350; bot.y = hall.y + 20;
    const a = riftGoal(w, bot, newRiftMem())!, b = riftGoal(w, bot2, newRiftMem())!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(100);
  });

  it('2. a follow point never lies inside a dormant sealable room (a bot never trips a seal the human did not)', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const arena = L.rooms[2];
    // the human stands in the corridor just outside the arena, backing out of it (heading -x = "behind" is +x, inside)
    const hx = (arena.c0 - 5) * TS, hy = arena.y;
    const human = makeShip(w, 'brute', hx, hy, false, 1);
    human.vx = -250;
    const bot = makeShip(w, 'tech', hx - 500, hy);
    const g = riftGoal(w, bot, newRiftMem())!;
    expect(g.kind).toBe('follow');
    expect(inRoomRect(arena, TS, g.x, g.y, -1)).toBe(false);
    expect(g.x).toBeLessThan(hx); // on our side
  });

  it('2. with a human leader elsewhere, bots neither chase into nor linger in a dormant sealable room (integrator fix)', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const hall = L.rooms[1], arena = L.rooms[2];
    const human = makeShip(w, 'brute', hall.x, hall.y, false, 1);
    const bot = makeShip(w, 'tech', (arena.c0 - 4) * TS, arena.y);
    const inside = makeEnemy(w, arena.x, arena.y);
    // an awake enemy inside the dormant arena: not engaged while the leader is in the hall
    expect(riftForbiddenRoom(w, bot, arena.x, arena.y)).toBe(2);
    expect(riftCanEngage(w, bot, -1, inside, dist(bot, inside.x, inside.y))).toBe(false);
    // the leader walks into the arena: it's the party's fight now
    human.x = arena.x - 100; human.y = arena.y;
    expect(riftForbiddenRoom(w, bot, arena.x, arena.y)).toBe(-1);
    expect(riftCanEngage(w, bot, -1, inside, dist(bot, inside.x, inside.y))).toBe(true);
    human.x = hall.x; human.y = hall.y;
    // no human alive (bot-only progression) or the room no longer dormant: no restriction
    human.alive = false;
    expect(riftForbiddenRoom(w, bot, arena.x, arena.y)).toBe(-1);
    human.alive = true;
    st.rooms[2].state = RIFT_CLEARED;
    expect(riftForbiddenRoom(w, bot, arena.x, arena.y)).toBe(-1);
    st.rooms[2].state = RIFT_DORMANT;
    // a brain that drifted 2 tiles inside the arena backs out through the door instead of going deeper
    w.enemies.clear();
    bot.x = (arena.c0 + 2) * TS; bot.y = arena.y;
    const brain = createBotBrain('normal', 7);
    let deepest = 0;
    for (let i = 0; i < 90; i++) {
      step(w, [[bot, brain]]);
      if (inRoomRect(arena, TS, bot.x, bot.y)) deepest = Math.max(deepest, bot.x - arena.c0 * TS);
    }
    expect(deepest).toBeLessThan(3 * TS); // never reached the 3-tile trigger inset
    expect(st.rooms[2].state).toBe(RIFT_DORMANT);
  });

  it('2. while a human is alive, bots keep out of the open Descend zone; the leader behind sealed doors → wait at a door', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const key = L.rooms[3];
    st.rooms[1].state = st.rooms[2].state = st.rooms[3].state = RIFT_CLEARED;
    st.portal = 1;
    const human = makeShip(w, 'brute', key.x + 60, key.y, false, 1);
    human.vx = 200; // "behind" = toward the portal centre
    const bot = makeShip(w, 'tech', key.x - 300, key.y);
    const g = riftGoal(w, bot, newRiftMem())!;
    expect(g.avoidR).toBe(RIFT_PORTAL_R + 60);
    expect(dist(g, L.portalX, L.portalY)).toBeGreaterThan(RIFT_PORTAL_R + 60);
    // brain: a bot parked on the portal steers out of the zone
    const brain = createBotBrain('normal', 3);
    bot.x = L.portalX + 20; bot.y = L.portalY;
    for (let i = 0; i < 90; i++) step(w, [[bot, brain]]);
    expect(dist(bot, L.portalX, L.portalY)).toBeGreaterThan(RIFT_PORTAL_R);

    // the human fights in a SEALED arena, the bot is outside (it was a turret at seal time): stage by a door
    const w2 = makeRiftWorld();
    const L2 = w2.map.dungeon!, st2 = w2.dungeon!;
    const arena = L2.rooms[2];
    st2.rooms[1].state = RIFT_CLEARED;
    st2.rooms[2].state = RIFT_SEALED;
    applySeals(w2.map, st2);
    makeShip(w2, 'brute', arena.x, arena.y, false, 1);
    const out = makeShip(w2, 'tech', L2.rooms[1].x, L2.rooms[1].y);
    const s = riftGoal(w2, out, newRiftMem())!;
    expect(s.kind).toBe('stage');
    expect(inRoomRect(arena, TS, s.x, s.y)).toBe(false);
    expect(dist(s, arena.doors[0].inX, arena.doors[0].inY)).toBeLessThan(260);
  });

  it('3. a human is down but respawning: regroup at the party anchor', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const human = makeShip(w, 'brute', L.rooms[1].x, L.rooms[1].y, false, 1);
    human.alive = false; human.respawnTick = 300;
    const bot = makeShip(w, 'tech', L.rooms[1].x + 100, L.rooms[1].y);
    const g = riftGoal(w, bot, newRiftMem())!;
    expect(g.kind).toBe('regroup');
    const a = riftAnchor(w, 0);
    expect([g.x, g.y]).toEqual([a.x, a.y]);
    // out of lives (rWait) is not "respawning": the bots press on (the next floor revives the pilot)
    human.skillState.rWait = 1; human.respawnTick = Number.MAX_SAFE_INTEGER;
    expect(riftGoal(w, bot, newRiftMem())!.kind).toBe('advance');
  });

  it('4. bot-only: the lowest-pid bot leads to the frontier room, the others follow it (150–350 px)', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const e = L.rooms[0];
    const lead = makeShip(w, 'engineer', e.x, e.y);
    const f1 = makeShip(w, 'brute', e.x - 100, e.y);
    const f2 = makeShip(w, 'tech', e.x, e.y + 100);
    const g = riftGoal(w, lead, newRiftMem())!;
    expect(g.kind).toBe('advance');
    expect([g.x, g.y]).toEqual([L.rooms[1].x, L.rooms[1].y]);
    for (const f of [f1, f2]) {
      const gf = riftGoal(w, f, newRiftMem())!;
      expect(gf.kind).toBe('follow');
      expect(dist(gf, lead.x, lead.y)).toBeLessThanOrEqual(351);
    }
    // the leader dies → the next-lowest pid leads
    lead.alive = false; lead.respawnTick = 300;
    expect(riftGoal(w, f1, newRiftMem())!.kind).toBe('advance');
    // a turret never leads (not free) and gets no rift goal
    lead.alive = true; lead.attachedTo = f1.id; f1.turrets.push(lead.id);
    expect(riftGoal(w, lead, newRiftMem())).toBeNull();
    expect(riftGoal(w, f1, newRiftMem())!.kind).toBe('advance');
  });

  it('4. the leader waits (≤ 5 s, once per room) at the frontier until the group is within 650 px', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    st.rooms[1].state = RIFT_CLEARED; // frontier = the arena
    const arena = L.rooms[2];
    const lead = makeShip(w, 'engineer', (arena.c0 - 8) * TS, arena.y); // ~250 px from the arena rim
    const lag = makeShip(w, 'brute', L.rooms[1].x - 300, L.rooms[1].y); // well behind
    const mem = newRiftMem();
    expect(dist(lag, lead.x, lead.y)).toBeGreaterThan(RIFT_GROUP_R);
    const g0 = riftGoal(w, lead, mem)!;
    expect(g0.kind).toBe('wait');
    w.tick += RIFT_WAIT_MAX_SEC * 60 - 1;
    expect(riftGoal(w, lead, mem)!.kind).toBe('wait');
    w.tick += 2;
    expect(riftGoal(w, lead, mem)!.kind).toBe('advance'); // timed out: go
    expect(riftGoal(w, lead, mem)!.kind).toBe('advance'); // and never waits twice for this room
    // a together group doesn't wait at all
    const mem2 = newRiftMem();
    lag.x = lead.x - 200; lag.y = lead.y;
    expect(riftGoal(w, lead, mem2)!.kind).toBe('advance');
  });

  it('4. chests: the nearest bot opens an openable chest in its room; opened / not-yet-openable chests are left', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const arena = L.rooms[2];
    st.rooms[1].state = RIFT_CLEARED;
    st.rooms[2].state = RIFT_CLEARED;
    const a = makeShip(w, 'engineer', arena.x + 300, arena.y); // leader (lowest pid), farther from the chest
    const b = makeShip(w, 'brute', arena.x + 40, arena.y + 60); // nearest
    const gb = riftGoal(w, b, newRiftMem())!;
    expect(gb.kind).toBe('chest');
    expect([gb.x, gb.y]).toEqual([arena.chests[0], arena.chests[1]]);
    expect(riftGoal(w, a, newRiftMem())!.kind).not.toBe('chest');
    // a chest the bot can't reach within RIFT_CHEST_GIVEUP_SEC is given up (for this floor)
    const mem = newRiftMem();
    expect(riftGoal(w, b, mem)!.kind).toBe('chest');
    w.tick += RIFT_CHEST_GIVEUP_SEC * 60 + 1;
    expect(riftGoal(w, b, mem)!.kind).not.toBe('chest');
    expect(riftGoal(w, b, mem)!.kind).not.toBe('chest');
    st.rooms[2].chests = 1; // opened
    expect(riftGoal(w, b, newRiftMem())!.kind).not.toBe('chest');
    // a reward chest of a DORMANT (uncleared, unsealed) room is not openable yet
    st.rooms[2].chests = 0; st.rooms[2].state = RIFT_DORMANT;
    expect(riftGoal(w, b, newRiftMem())!.kind).not.toBe('chest');
    // with a human alive the chests are theirs
    st.rooms[2].state = RIFT_CLEARED;
    makeShip(w, 'tech', arena.x, arena.y - 200, false, 999);
    expect(riftGoal(w, b, newRiftMem())!.kind).toBe('follow');
  });

  it('4. an open portal (no human alive): every bot heads into the Descend zone', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    for (const i of [1, 2, 3]) st.rooms[i].state = RIFT_CLEARED;
    st.rooms[2].chests = st.rooms[3].chests = 1; // chests come first (they're in the room); opened here
    st.portal = 1;
    const bots = [makeShip(w, 'engineer', L.rooms[2].x, L.rooms[2].y), makeShip(w, 'brute', L.rooms[3].x + 300, L.rooms[3].y)];
    for (const b of bots) {
      const g = riftGoal(w, b, newRiftMem())!;
      expect(g.kind).toBe('portal');
      expect([g.x, g.y]).toEqual([L.portalX, L.portalY]);
      expect(g.holdR).toBeLessThan(RIFT_PORTAL_R);
      expect(g.score).toBeGreaterThan(RIFT_SCORE.advance);
    }
  });

  it('no goal while dead, attached, extracted, out of lives, or once the run is over', () => {
    const w = makeRiftWorld();
    const s = makeShip(w, 'brute', w.map.dungeon!.rooms[0].x, w.map.dungeon!.rooms[0].y);
    expect(riftGoal(w, s, newRiftMem())).not.toBeNull();
    s.skillState.rOut = 1;
    expect(riftGoal(w, s, newRiftMem())).toBeNull();
    s.skillState = { rWait: 1 };
    expect(riftGoal(w, s, newRiftMem())).toBeNull();
    s.skillState = {};
    s.alive = false;
    expect(riftGoal(w, s, newRiftMem())).toBeNull();
    s.alive = true;
    w.dungeon!.outcome = 'wiped';
    expect(riftGoal(w, s, newRiftMem())).toBeNull();
    w.dungeon = undefined;
    expect(riftGoal(w, s, newRiftMem())).toBeNull();
  });

  it('retreat: inside a sealed room a kite point inside it, elsewhere the party anchor', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const arena = L.rooms[2];
    const s = makeShip(w, 'tech', arena.x - 300, arena.y);
    const threat = { x: arena.x - 150, y: arena.y };
    const p = riftRetreatPoint(w, s, threat, 2);
    expect(inRoomRect(arena, TS, p.x, p.y, 2)).toBe(true);
    expect(isSolidAt(w.map, p.x, p.y)).toBe(false);
    expect(p.x).toBeLessThan(s.x); // away from the threat
    // pressed against the room edge, it slides along it instead of into the wall
    s.x = (arena.c0 + 3) * TS; threat.x = s.x + 150;
    const q = riftRetreatPoint(w, s, threat, 2);
    expect(inRoomRect(arena, TS, q.x, q.y, 2)).toBe(true);
    // outside a sealed room: home is the party anchor
    s.x = L.rooms[1].x; s.y = L.rooms[1].y;
    const a = riftAnchor(w, 0);
    expect(riftRetreatPoint(w, s, null, -1)).toEqual(a);
  });

  it('engage filter: own room or line of sight; dormant packs only in our own room (or point blank)', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const hall = L.rooms[1], arena = L.rooms[2];
    const s = makeShip(w, 'tech', hall.x, hall.y);
    const my = riftRoomIndexAt(L, TS, s.x, s.y);
    const inRoom = makeEnemy(w, hall.x + 300, hall.y + 200);
    const behindWall = makeEnemy(w, hall.x, (hall.r1 + 6) * TS); // in the rock below the hall — no LOS
    const sleeper = makeEnemy(w, hall.x + 200, hall.y, { sleep: 1 });
    const farSleeper = makeEnemy(w, arena.x - 400, arena.y, { sleep: 1 }); // next room, seen through the corridor
    const d = (e: Enemy) => dist(e, s.x, s.y);
    expect(riftCanEngage(w, s, my, inRoom, d(inRoom))).toBe(true);
    expect(riftCanEngage(w, s, my, behindWall, d(behindWall))).toBe(false);
    expect(riftCanEngage(w, s, my, sleeper, d(sleeper))).toBe(true);
    expect(riftCanEngage(w, s, my, farSleeper, d(farSleeper))).toBe(false);
    delete farSleeper.mem.sleep; // awake and chasing, in line of sight: fair game
    if (d(farSleeper) <= 900) expect(riftCanEngage(w, s, my, farSleeper, d(farSleeper))).toBe(true);
  });

  it('fill-bot class complement: an Artificer if the party has none, else the least-used class', () => {
    expect(riftFillClass([])).toBe('engineer');
    expect(riftFillClass(['brute', 'tech'])).toBe('engineer');
    expect(riftFillClass(['engineer'])).toBe('brute'); // brute / tech tie → first
    expect(riftFillClass(['engineer'], () => 0.99)).toBe('tech');
    expect(riftFillClass(['engineer', 'brute'])).toBe('tech');
    expect(riftFillClass(['engineer', 'brute', 'tech'])).toBe('brute');
    expect(riftFillClass(['engineer', 'engineer', 'tech'])).toBe('brute');
    // a full 4-bot party built one seat at a time
    const party: ShipClassId[] = [];
    for (let i = 0; i < 4; i++) party.push(riftFillClass(party));
    expect(party).toEqual(['engineer', 'brute', 'tech', 'brute']);
  });
});

describe('v0.3 M4 nav + brain in a rift', () => {
  it('nav rebuilds on map.rev: a sealed door blocks paths, unsealing reopens them', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const hall = L.rooms[1], arena = L.rooms[2];
    const g0 = getNavGrid(w.map);
    expect(getNavGrid(w.map)).toBe(g0); // cached while rev is unchanged
    expect(findPath(g0, hall.x, hall.y, arena.x, arena.y)).not.toBeNull();
    st.rooms[2].state = RIFT_SEALED;
    applySeals(w.map, st);
    expect(w.map.rev).toBe(1);
    const g1 = getNavGrid(w.map);
    expect(g1).not.toBe(g0);
    expect(g1.rev).toBe(1);
    expect(findPath(g1, hall.x, hall.y, arena.x, arena.y)).toBeNull();
    st.rooms[2].state = RIFT_CLEARED;
    applySeals(w.map, st);
    expect(findPath(getNavGrid(w.map), hall.x, hall.y, arena.x, arena.y)).not.toBeNull();
  });

  it('a bot in a sealed room fights the room\'s enemies and never leaves the room', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const arena = L.rooms[2];
    st.rooms[1].state = RIFT_CLEARED;
    st.rooms[2].state = RIFT_SEALED;
    applySeals(w.map, st);
    const bot = makeShip(w, 'tech', arena.x, arena.y);
    const brain = createBotBrain('normal', 11);
    const foes = [makeEnemy(w, arena.x + 350, arena.y - 200), makeEnemy(w, arena.x - 380, arena.y + 250)];
    let fired = 0;
    for (let i = 0; i < 600; i++) {
      step(w, [[bot, brain]], () => {
        // enemies drift around the room (stay inside)
        for (const e of foes) { e.x = arena.x + Math.cos(i / 40 + e.id) * 380; e.y = arena.y + Math.sin(i / 40 + e.id) * 300; }
      });
      if (bot.input.primary) fired++;
      expect(inRoomRect(arena, TS, bot.x, bot.y)).toBe(true);
    }
    expect(fired).toBeGreaterThan(30);
  });

  it('a bot follows a moving human through the floor (and never drifts far behind)', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const e = L.rooms[0], hall = L.rooms[1];
    const human = makeShip(w, 'brute', e.x, e.y, false, 1);
    const bot = makeShip(w, 'engineer', e.x - 150, e.y + 80);
    const brain = createBotBrain('normal', 5);
    // the human flies entrance → corridor → hall centre and back, at bot speed
    const route = [[e.x, e.y], [(e.c1 + 8) * TS, e.y], [hall.x, hall.y], [(e.c1 + 8) * TS, e.y], [e.x, e.y]];
    let leg = 1, worst = 0;
    for (let i = 0; i < 60 * 30 && leg < route.length; i++) {
      step(w, [[bot, brain]], () => {
        const [tx, ty] = route[leg];
        const dx = tx - human.x, dy = ty - human.y, d = Math.hypot(dx, dy);
        if (d < 8) { leg++; human.vx = human.vy = 0; return; }
        human.vx = (dx / d) * 380; human.vy = (dy / d) * 380;
        human.x += human.vx / 60; human.y += human.vy / 60;
        human.angle = Math.atan2(dy, dx);
      });
      if (i > 120) worst = Math.max(worst, dist(bot, human.x, human.y));
      if (riftRoomIndexAt(L, TS, human.x, human.y) === 1) st.rooms[1].state = RIFT_CLEARED;
    }
    expect(leg).toBe(route.length);
    expect(worst).toBeLessThan(900);
    expect(dist(bot, human.x, human.y)).toBeLessThan(FOLLOW_FAR_PX + 150);
  });

  it('a bot-only party advances: the leader walks into the hall, then waits for the laggard at the arena', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const e = L.rooms[0];
    const lead = makeShip(w, 'engineer', e.x + 100, e.y);
    const b2 = makeShip(w, 'brute', e.x, e.y + 100);
    const brains: [Ship, Brain | null][] = [[lead, createBotBrain('normal', 1)], [b2, createBotBrain('normal', 2)]];
    let enteredHall = -1;
    for (let i = 0; i < 60 * 25; i++) {
      step(w, brains);
      // the sim's room trigger: a non-sealable room is CLEARED the first time a ship enters it
      if (st.rooms[1].state !== RIFT_CLEARED && inRoomRect(L.rooms[1], TS, lead.x, lead.y, 3)) { st.rooms[1].state = RIFT_CLEARED; enteredHall = i; }
      if (inRoomRect(L.rooms[2], TS, lead.x, lead.y, 3)) break;
    }
    expect(enteredHall).toBeGreaterThan(0);
    // the leader reaches the arena with its follower close behind (the group arrives together)
    expect(inRoomRect(L.rooms[2], TS, lead.x, lead.y, 3)).toBe(true);
    expect(dist(b2, lead.x, lead.y)).toBeLessThan(RIFT_GROUP_R + 200);
  });

  it('a battle-station leader still leads (no "seek teammates" roaming in a rift: that deadlocked the party)', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const e = L.rooms[0];
    const lead = makeShip(w, 'brute', e.x + 60, e.y);
    lead.path = 'bulwark'; lead.upgrades['path:bulwark'] = 1; // a battle station
    const f = makeShip(w, 'tech', e.x - 60, e.y);
    const bl = createBotBrain('normal', 21) as unknown as Brain & { mode: string };
    const bf = createBotBrain('normal', 22);
    const d0 = dist(lead, L.rooms[1].x, L.rooms[1].y);
    for (let i = 0; i < 240; i++) step(w, [[lead, bl], [f, bf]]);
    expect(bl.mode).toBe('rift');
    expect(dist(lead, L.rooms[1].x, L.rooms[1].y)).toBeLessThan(d0 - 600);
  });

  it('boss focus: in a sealed room the bot shoots the Matriarch over a nearer add', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!, st = w.dungeon!;
    const arena = L.rooms[2];
    st.rooms[1].state = RIFT_CLEARED;
    st.rooms[2].state = RIFT_SEALED;
    applySeals(w.map, st);
    const bot = makeShip(w, 'engineer', arena.x - 300, arena.y);
    const add = makeEnemy(w, arena.x - 300, arena.y - 320);
    const boss = makeEnemy(w, arena.x + 300, arena.y);
    boss.kind = 'matriarch'; boss.radius = 88; boss.hp = boss.maxHp = 30000;
    const brain = createBotBrain('normal', 31) as unknown as Brain & { targetKind: string | null; targetId: number };
    for (let i = 0; i < 30; i++) step(w, [[bot, brain]]);
    expect(brain.targetKind).toBe('enemy');
    expect(brain.targetId).toBe(boss.id);
    // an add right in its face still gets shot first
    add.x = bot.x + 120; add.y = bot.y;
    for (let i = 0; i < 12; i++) step(w, [[bot, brain]], () => { add.x = bot.x + 120; add.y = bot.y; });
    expect(brain.targetId).toBe(add.id);
  });

  it('onFloorChange clears path, goal and target; a swapped map is noticed without it', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const bot = makeShip(w, 'brute', L.rooms[0].x, L.rooms[0].y);
    const brain = createBotBrain('normal', 7) as unknown as {
      think: (w: World, s: Ship) => InputState; onFloorChange: () => void;
      path: number[] | null; targetKind: string | null; goalX: number; mode: string;
    };
    makeEnemy(w, L.rooms[0].x + 200, L.rooms[0].y);
    for (let i = 0; i < 30; i++) step(w, [[bot, brain as never]]);
    expect(brain.targetKind).toBe('enemy');
    brain.onFloorChange();
    expect(brain.path).toBeNull();
    expect(brain.targetKind).toBeNull();
    expect(brain.goalX).toBe(0);
    expect(brain.mode).toBe('roam');
    // floor swap without the Room's call: a new map object resets the same way
    for (let i = 0; i < 30; i++) step(w, [[bot, brain as never]]);
    expect(brain.targetKind).toBe('enemy');
    w.map = makeRiftMap();
    w.enemies.clear();
    rebuildGrid(w);
    const spy = { n: 0 };
    const orig = brain.onFloorChange.bind(brain);
    brain.onFloorChange = () => { spy.n++; orig(); };
    brain.think(w, bot);
    expect(spy.n).toBe(1);
    expect(brain.targetKind).toBeNull();
  });

  it('a seal recall (teleport) drops the stale path at once', () => {
    const w = makeRiftWorld();
    const L = w.map.dungeon!;
    const bot = makeShip(w, 'brute', L.rooms[0].x, L.rooms[0].y);
    const brain = createBotBrain('normal', 9) as unknown as { path: number[] | null };
    for (let i = 0; i < 40; i++) step(w, [[bot, brain as never]]);
    // teleport into the arena (recall to a door in-point)
    w.dungeon!.rooms[1].state = RIFT_CLEARED;
    w.dungeon!.rooms[2].state = RIFT_SEALED;
    applySeals(w.map, w.dungeon!);
    const d = L.rooms[2].doors[0];
    bot.x = d.inX; bot.y = d.inY;
    step(w, [[bot, brain as never]]);
    expect(inRoomRect(L.rooms[2], TS, bot.x, bot.y)).toBe(true);
    for (let i = 0; i < 120; i++) {
      step(w, [[bot, brain as never]]);
      expect(inRoomRect(L.rooms[2], TS, bot.x, bot.y)).toBe(true);
    }
    // it went for the room centre (the fight fallback), not back along the old route
    expect(dist(bot, L.rooms[2].x, L.rooms[2].y)).toBeLessThan(dist({ x: d.inX, y: d.inY }, L.rooms[2].x, L.rooms[2].y));
  });
});
