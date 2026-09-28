// CLIENT M4 netcode (docs/v0.3-proposal.md §9 CLIENT acceptance): `floorStart` rebuilds the map and resets
// interpolation / prediction; room-seal mirroring (floor-checked) makes the predictor collide with sealed doors; the
// out-of-lives camera follows RiftYou.followId; rift drop-in / extraction bookkeeping.
// buildMatchMap is mocked (a small hand-made rift floor per floor number) and applyRoomSeals runs a reference
// implementation of the §4.2 rule, so these tests pin the client's wiring independent of SIM's generator.
// rift.e2e.test.ts runs the same paths against the real floorgen once it lands.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGameRenderer } from '../contracts';
import { DEFAULT_SETTINGS_BY_TYPE, type RoomSummary, type ServerMsg } from '../../shared/protocol';
import { computeStats } from '../../shared/sim/pve/upgrades';
import { collideCircle } from '../../shared/sim/map';
import {
  BEAM_NONE, emptyInput, TILE_DOOR, TILE_WALL,
  type GameEvent, type GameMap, type RiftLayout, type RiftView, type RiftYou, type ShipView, type Snapshot, type YouState,
} from '../../shared/types';
import { GameClient, MAX_RIFT_FLOOR, riftFollowTarget } from './GameClient';
import type { Transport } from './transport';

const T = 32; // tile size
const COLS = 40, ROWS = 20;
const DOOR_COL = 20;
const DOOR_ROWS = [8, 9, 10, 11, 12];

const gen = vi.hoisted(() => ({ calls: [] as { floor: number }[], seals: 0 }));

vi.mock('../../shared/sim/mapgen', () => ({
  buildMatchMap: (p: { floor: number }) => {
    gen.calls.push({ floor: p.floor });
    return fakeFloor(p.floor);
  },
}));

// §4.2 applyRoomSeals: TILE_WALL into the door tiles of SEALED (2) rooms, TILE_DOOR otherwise; pure + idempotent;
// bumps map.rev and returns true only on a change.
vi.mock('../../shared/sim/floorgen', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared/sim/floorgen')>();
  return {
    ...real,
    applyRoomSeals: (map: GameMap, states: ArrayLike<number>): boolean => {
      gen.seals++;
      let changed = false;
      for (const r of map.dungeon?.rooms ?? []) {
        const want = states[r.idx] === 2 ? 1 /* TILE_WALL */ : 4 /* TILE_DOOR */;
        for (const d of r.doors) for (const i of d.tiles) if (map.tiles[i] !== want) { map.tiles[i] = want; changed = true; }
      }
      if (changed) map.rev = (map.rev ?? 0) + 1;
      return changed;
    },
  };
});

/**
 * A 40×20-tile floor: two rooms split by a wall at column 20 with a 5-tile door (rows 8–12). Room 0 (entrance, left)
 * and room 1 (arena, right; sealable). `floor` tags the layout so the floor check can be exercised.
 */
function fakeFloor(floor: number): GameMap {
  const tiles = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const border = r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1;
      tiles[r * COLS + c] = border || c === DOOR_COL ? TILE_WALL : 0;
    }
  }
  const doorTiles = DOOR_ROWS.map((r) => r * COLS + DOOR_COL);
  for (const i of doorTiles) tiles[i] = TILE_DOOR;
  const dungeon: RiftLayout = {
    floor, biome: floor >= 4 ? 'prism' : 'hive', bossFloor: floor % 3 === 0,
    rooms: [
      { idx: 0, kind: 'entrance', c0: 1, r0: 1, c1: 20, r1: 19, x: 10 * T, y: 10 * T, doors: [], spawns: [], chests: [], links: [1], depth: 0, mainPath: true, party: 0 },
      {
        idx: 1, kind: 'arena', c0: 21, r0: 1, c1: 39, r1: 19, x: 30 * T, y: 10 * T,
        doors: [{ tiles: doorTiles, inX: 23.5 * T, inY: 10.5 * T }], spawns: [], chests: [30 * T, 14 * T], links: [0], depth: 1, mainPath: true, party: -1,
      },
    ],
    entrances: [0], keyRoom: 1, portalX: 30 * T, portalY: 10 * T, extractX: -1, extractY: -1,
  };
  return { seed: 1234, teamCount: 1, width: COLS * T, height: ROWS * T, tileSize: T, cols: COLS, rows: ROWS, tiles, spawns: [], dungeon };
}

type MatchStart = Extract<ServerMsg, { type: 'matchStart' }>;
const start = (p: Partial<MatchStart> = {}): MatchStart => ({
  type: 'matchStart', mapSeed: 1234, mode: 'teams', teamCount: 1, gameType: 'dungeon', subMode: 'coop', floor: 1,
  yourShipId: 7, tick: 100, snapshotEvery: 3, ...p,
});

function riftView(p: Partial<RiftView> = {}): RiftView {
  return {
    floor: 1, floorsTotal: 6, biome: 'hive', rooms: [3, 0], chests: [0, 0], lives: [10], seen: [1], anchors: [320, 320],
    portal: 0, departIn: 0, extractOpen: false, boss: null, waiting: [], extracting: [], floorSec: 0, ...p,
  };
}

function ship(id: number, x: number, y: number, extra: Partial<ShipView> = {}): ShipView {
  return {
    id, playerId: id, team: 0, shipClass: 'brute', x, y, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true,
    attachedTo: 0, turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: BEAM_NONE, resonance: 1, ...extra,
  };
}

const stats = computeStats('brute', {});

function youState(p: Partial<YouState> = {}): YouState {
  return {
    playerId: 7, shipId: 7, alive: true, respawnIn: 0, energy: stats.maxEnergy, stats, xp: 0, xpToNext: 10, level: 1,
    offer: null, offerId: 0, queuedOffers: 0, upgrades: [], cd: { primary: 0, secondary: 0, mobility: 0, utility: 0, attach: 0 },
    cdSec: { secondary: 0, mobility: 0, utility: 0 }, deployables: {}, path: null, talents: [], bounty: 10, attachedTo: 0, turrets: [],
    skillActive: false, ...p,
  };
}

function snap(tick: number, p: Partial<Snapshot> = {}, dungeon: Partial<RiftView> = {}): Snapshot {
  return {
    tick, ackSeq: 0, you: null, ships: [], enemies: [], projectiles: [], gems: [], deployables: [], events: [],
    match: {
      phase: 'playing', mode: 'teams', teamCount: 1, timeLeftSec: 0, teamScores: [0], wave: 1, winnerTeam: -1, winnerPlayerId: 0,
      timed: false, gameType: 'dungeon', subMode: 'coop', dungeon: riftView(dungeon),
    },
    ...p,
  };
}

class NullTransport implements Transport {
  readonly kind = 'online' as const;
  onMessage: ((msg: ServerMsg) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onClose: ((reason: string, code?: number) => void) | null = null;
  sent: unknown[] = [];
  connect(): Promise<void> { return Promise.resolve(); }
  send(msg: unknown): void { this.sent.push(msg); }
  close(): void { /* nothing */ }
}

interface Inner {
  handleMsg(m: ServerMsg): void;
  handleSnapshot(s: Snapshot): void;
  buffer: Snapshot[];
  predictor: { pendingCount: number; body: unknown };
  events: { size: number };
}

function client(): { c: GameClient; inner: Inner; maps: GameMap[] } {
  const maps: GameMap[] = [];
  const renderer = { setMap: (m: GameMap) => maps.push(m) } as unknown as IGameRenderer;
  const c = new GameClient(renderer);
  c.transport = new NullTransport();
  c.playerId = 7;
  return { c, inner: c as unknown as Inner, maps };
}

const frame = (c: GameClient, now = performance.now()) => c.buildFrame(now, now / 1000, 1 / 60, 0, 0, 0);

beforeEach(() => { gen.calls.length = 0; gen.seals = 0; });

describe('floorStart: rebuild the map, reset interpolation + prediction (§9 CLIENT M4)', () => {
  it('rebuilds with buildMatchMap for the new floor, re-runs setMap and starts netcode afresh', () => {
    const { c, inner, maps } = client();
    let floors: number[] = [];
    c.on('floorStart', (f) => floors.push(f));
    inner.handleMsg(start());
    expect(gen.calls).toEqual([{ floor: 1 }]);
    inner.handleSnapshot(snap(200, { you: youState(), ships: [ship(7, 300, 320)] }));
    inner.handleSnapshot(snap(203, { you: youState(), ships: [ship(7, 310, 320)] }));
    for (let s = 1; s <= 3; s++) c.sendInput({ ...emptyInput(), moveX: 1 });
    expect(inner.buffer.length).toBe(2);
    expect(inner.predictor.pendingCount).toBe(3);
    expect(frame(c)).not.toBeNull();

    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 300 });
    expect(gen.calls).toEqual([{ floor: 1 }, { floor: 2 }]);
    expect(c.floor).toBe(2);
    expect(c.mapParams).toMatchObject({ gameType: 'dungeon', subMode: 'coop', floor: 2, seed: 1234 });
    expect(c.map?.dungeon?.floor).toBe(2);
    expect(maps).toHaveLength(2);
    expect(maps[1]).toBe(c.map);
    expect(floors).toEqual([2]);
    expect(inner.buffer.length).toBe(0);
    expect(c.latest).toBeNull();
    expect(c.lastFrame).toBeNull();
    expect(inner.predictor.pendingCount).toBe(0);
    expect(inner.predictor.body).toBeNull();
    expect(frame(c)).toBeNull(); // nothing to draw until the new floor's first snapshot

    // A late old-floor snapshot is dropped; the new floor's first snapshot draws at once (no slide from the old spot).
    inner.handleSnapshot(snap(299, { you: youState(), ships: [ship(7, 310, 320)] }));
    expect(c.latest).toBeNull();
    inner.handleSnapshot(snap(300, { you: youState(), ships: [ship(7, 1000, 400)] }, { floor: 2, rooms: [3, 0] }));
    expect(c.latest?.tick).toBe(300);
    const f = frame(c)!;
    expect(f.ships.find((s) => s.id === 7)).toMatchObject({ x: 1000, y: 400 });

    // A repeated / older floorStart changes nothing.
    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 300 });
    inner.handleMsg({ type: 'floorStart', floor: 1, tick: 310 });
    expect(gen.calls).toHaveLength(2);
    expect(floors).toEqual([2]);
    expect(c.latest?.tick).toBe(300);
  });

  it('old-floor rift events (rooms, chests, portals, boss) are dropped at the swap; floor-free globals stay (integrator fix)', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    const events: GameEvent[] = [
      { t: 'chestOpen', room: 1, chest: 0, playerId: 7, team: 0, x: 30 * T, y: 14 * T },
      { t: 'roomClear', room: 1, team: 0, x: 30 * T, y: 10 * T },
      { t: 'portalOpen', x: 30 * T, y: 10 * T, extract: false },
      { t: 'lifeLost', team: 0, playerId: 3, lives: 4 },
      { t: 'extract', playerId: 3, x: 1, y: 1 },
    ];
    inner.handleSnapshot(snap(200, { events }));
    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 300 });
    inner.handleSnapshot(snap(300, {}, { floor: 2 }));
    const f = frame(c, performance.now() + 5)!;
    expect(f.events.map((e) => e.t)).toEqual(['lifeLost', 'extract']);
  });

  it('old-floor events still queued keep only the global ones', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    const events: GameEvent[] = [
      { t: 'spawnWarn', x: 100, y: 100, radius: 90, sec: 0.8 },
      { t: 'shipDeath', playerId: 3, killerPlayerId: 0, x: 10, y: 10, cause: 'enemy', bounty: 0 } as GameEvent,
      { t: 'hit', x: 1, y: 1 } as unknown as GameEvent,
    ];
    inner.handleSnapshot(snap(200, { events }));
    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 300 });
    inner.handleSnapshot(snap(300, {}, { floor: 2 }));
    const f = frame(c, performance.now() + 5)!;
    expect(f.events.map((e) => e.t)).toEqual(['shipDeath']);
  });

  it('ignored outside a running dungeon match, and for nonsense floors', () => {
    const { c, inner } = client();
    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 1 }); // no match
    expect(gen.calls).toHaveLength(0);
    inner.handleMsg(start({ gameType: 'arena', subMode: 'deathmatch', teamCount: 2, floor: 0 }));
    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 1 });
    expect(gen.calls).toHaveLength(1);
    expect(c.floor).toBe(0);
    inner.handleMsg(start());
    for (const bad of [0, -1, 2.5, Number.NaN, MAX_RIFT_FLOOR + 1]) inner.handleMsg({ type: 'floorStart', floor: bad, tick: 1 });
    expect(c.floor).toBe(1);
  });

  it('a snapshot already on a later floor (its floorStart never came) swaps first; an older floor is dropped', () => {
    const { c, inner } = client();
    inner.handleMsg(start({ floor: 2 }));
    inner.handleSnapshot(snap(200, {}, { floor: 2 }));
    inner.handleSnapshot(snap(260, {}, { floor: 3 }));
    expect(c.floor).toBe(3);
    expect(c.map?.dungeon?.floor).toBe(3);
    expect(c.latest?.tick).toBe(260);
    inner.handleSnapshot(snap(270, {}, { floor: 2 }));
    expect(c.latest?.tick).toBe(260);
  });
});

describe('seal mirroring (floor-checked) makes the predictor collide with sealed doors', () => {
  const doorX = DOOR_COL * T;
  const y = 10.5 * T; // door centre row

  /** Fly right at the door for 3 s of inputs; returns the predicted x. */
  function flyAtDoor(rooms: number[], viewFloor = 1): { x: number; c: GameClient } {
    const { c, inner } = client();
    inner.handleMsg(start());
    inner.handleSnapshot(snap(200, { you: youState(), ships: [ship(7, doorX - 160, y)] }, { floor: viewFloor, rooms }));
    for (let k = 0; k < 180; k++) c.sendInput({ ...emptyInput(), moveX: 1, aim: 0 });
    const f = frame(c)!;
    return { x: f.ships.find((s) => s.id === 7)!.x, c };
  }

  it('an open door lets the predicted ship through; a sealed one stops it at the wall', () => {
    const open = flyAtDoor([3, 0]);
    expect(open.x).toBeGreaterThan(doorX + T);
    const sealed = flyAtDoor([3, 2]);
    expect(sealed.x).toBeLessThan(doorX);
    expect(sealed.x).toBeLessThanOrEqual(doorX - stats.radius + 1);
    const map = sealed.c.map!;
    for (const r of DOOR_ROWS) expect(map.tiles[r * COLS + DOOR_COL]).toBe(TILE_WALL);
    expect(map.rev).toBe(1);
    expect(collideCircle(map, doorX + T / 2, y, stats.radius).hit).toBe(true);
  });

  it('a seal recall (blink on the own ship) snaps the drawn ship: no slide through the sealed door (integrator fix)', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    inner.handleSnapshot(snap(200, { you: youState(), ships: [ship(7, doorX - 100, y)] }, { rooms: [3, 1] }));
    frame(c);
    // the server recalled the ship to the arena's door in-point (≈ 190 px, under SNAP_DIST) and sealed the room
    const inX = 23.5 * T, inY = 10.5 * T;
    inner.handleSnapshot(snap(203, {
      you: youState(), ships: [ship(7, inX, inY)],
      events: [{ t: 'blink', shipId: 7, fromX: doorX - 100, fromY: y, x: inX, y: inY } as GameEvent],
    }, { rooms: [3, 2] }));
    const f = frame(c, performance.now() + 1)!;
    const me = f.ships.find((s) => s.id === 7)!;
    expect(me.x).toBeCloseTo(inX, 0);
    expect(me.y).toBeCloseTo(inY, 0);
  });

  it('unsealing writes the doors back; unchanged room states are not re-applied', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    inner.handleSnapshot(snap(200, {}, { rooms: [3, 1] })); // arming: still open
    const map = c.map!;
    expect(map.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_DOOR);
    inner.handleSnapshot(snap(203, {}, { rooms: [3, 2] }));
    expect(map.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_WALL);
    const calls = gen.seals;
    inner.handleSnapshot(snap(206, {}, { rooms: [3, 2] }));
    inner.handleSnapshot(snap(209, {}, { rooms: [3, 2] }));
    expect(gen.seals).toBe(calls);
    inner.handleSnapshot(snap(212, {}, { rooms: [3, 3] })); // cleared
    for (const r of DOOR_ROWS) expect(map.tiles[r * COLS + DOOR_COL]).toBe(TILE_DOOR);
    expect(map.rev).toBe(2);
    // an older snapshot never re-seals
    inner.handleSnapshot(snap(208, {}, { rooms: [3, 2] }));
    expect(map.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_DOOR);
  });

  it('a view for another layout (room count) or a map without a layout never touches the tiles', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    inner.handleSnapshot(snap(200, {}, { rooms: [3, 2, 2] }));
    expect(c.map!.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_DOOR);
    expect(gen.seals).toBe(0);
  });

  it('the floor swap starts from the new map\'s open doors (seals of the old floor do not carry over)', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    inner.handleSnapshot(snap(200, {}, { rooms: [3, 2] }));
    const old = c.map!;
    expect(old.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_WALL);
    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 300 });
    expect(c.map).not.toBe(old);
    expect(c.map!.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_DOOR);
    inner.handleSnapshot(snap(300, {}, { floor: 2, rooms: [3, 2] }));
    expect(c.map!.tiles[DOOR_ROWS[0] * COLS + DOOR_COL]).toBe(TILE_WALL); // same states, new floor: applied again
  });
});

describe('out of lives: the camera follows RiftYou.followId', () => {
  const rift = (p: Partial<RiftYou> = {}): RiftYou => ({ party: 0, lives: 0, waiting: true, extracted: false, extract: 0, followId: 9, ...p });

  it('follows the named alive teammate while waiting; back to the own ship once alive', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    const ships = [ship(7, 100, 100, { alive: false }), ship(9, 900, 500)];
    inner.handleSnapshot(snap(200, { you: youState({ alive: false, respawnIn: 1e9, rift: rift() }), ships }, { waiting: [7] }));
    let f = frame(c)!;
    expect([f.focusX, f.focusY]).toEqual([900, 500]);
    inner.handleSnapshot(snap(203, { you: youState({ rift: rift({ waiting: false }) }), ships: [ship(7, 120, 100), ship(9, 900, 500)] }));
    f = frame(c, performance.now() + 100)!;
    expect(f.focusX).toBeCloseTo(120, 0);
  });

  it('extracted (spectator snapshots, no you): the camera follows and cycles the party, not the wreck at the exit (integrator fix)', () => {
    const { c, inner } = client();
    inner.handleMsg(start());
    // the own extracted ship (7) stays in world.ships, dead, for the scoreboard; 8 and 9 still fly
    const ships = () => [ship(7, 100, 100, { alive: false }), ship(8, 600, 300), ship(9, 900, 500)];
    inner.handleSnapshot(snap(200, { you: null, ships: ships(), events: [{ t: 'extract', playerId: 7, x: 100, y: 100 }] }));
    inner.handleSnapshot(snap(203, { you: null, ships: ships() }));
    expect(c.riftExtracted).toBe(true);
    expect(c.localShipId).toBe(0);
    let f = frame(c, performance.now() + 100)!;
    expect(f.localShipId).toBe(0);
    expect([f.focusX, f.focusY]).not.toEqual([100, 100]);
    const first = c.spectateId;
    expect([8, 9]).toContain(first);
    c.cycleSpectate();
    const next = c.spectateId;
    expect(next).not.toBe(first);
    f = frame(c, performance.now() + 120)!;
    expect(c.spectateId).toBe(next); // not undone by the next frame
    const t = f.ships.find((s) => s.id === next)!;
    expect([f.focusX, f.focusY]).toEqual([t.x, t.y]);
  });

  it('riftFollowTarget: only while waiting / extracted, dead, and the target is shown alive', () => {
    const m = new Map([[9, ship(9, 1, 2)], [8, ship(8, 3, 4, { alive: false })]]);
    expect(riftFollowTarget(youState({ alive: false, rift: rift() }), m)?.id).toBe(9);
    expect(riftFollowTarget(youState({ alive: false, rift: rift({ waiting: false, extracted: true }) }), m)?.id).toBe(9);
    expect(riftFollowTarget(youState({ alive: false, rift: rift({ waiting: false }) }), m)).toBeUndefined();
    expect(riftFollowTarget(youState({ alive: true, rift: rift() }), m)).toBeUndefined();
    expect(riftFollowTarget(youState({ alive: false, rift: rift({ followId: 8 }) }), m)).toBeUndefined();
    expect(riftFollowTarget(youState({ alive: false, rift: rift({ followId: 0 }) }), m)).toBeUndefined();
    expect(riftFollowTarget(null, m)).toBeUndefined();
  });
});

describe('rift drop-in ("Join · next floor") and extraction bookkeeping', () => {
  const summary = (p: Partial<RoomSummary> = {}): RoomSummary => ({
    id: 'd1', name: 'Dungeon Run', mode: 'teams', teamCount: 1, phase: 'playing', humans: 1, bots: 3, maxPlayers: 4,
    gameType: 'dungeon', subMode: 'coop', pveIntensity: 2, floors: 6, house: true, hostName: '', spectators: 0,
    joinable: true, watchable: true, startsInSec: 0, live: null, ...p,
  });
  const roomState = (roomId: string | null, phase: 'lobby' | 'playing' | 'results', gameType: 'dungeon' | 'arena' = 'dungeon', inMatch = false): ServerMsg => ({
    type: 'roomState', roomId, phase, settings: { ...DEFAULT_SETTINGS_BY_TYPE[gameType] }, hostPlayerId: 0, countdown: 0,
    players: [{ playerId: 7, name: 'Me', team: -2, shipClass: 'brute', isBot: false, isHost: false, ready: false, ping: 0, inMatch }],
  });

  it('Command Join on a running rift waits for the next floor; a ship (or leaving) ends the wait', () => {
    const { c, inner } = client();
    inner.handleMsg({ type: 'roomList', rooms: [summary()], online: 1 });
    c.joinRoom('d1', 'play');
    expect((c.transport as NullTransport).sent.at(-1)).toEqual({ type: 'joinRoom', roomId: 'd1', intent: 'play' });
    inner.handleMsg(roomState('d1', 'playing'));
    expect(c.riftDropInPending).toBe(true);
    inner.handleMsg(start({ yourShipId: 0, floor: 2 })); // spectating until the floor start
    inner.handleSnapshot(snap(200, {}, { floor: 2 }));
    expect(c.riftDropInPending).toBe(true);
    inner.handleMsg({ type: 'floorStart', floor: 3, tick: 300 });
    inner.handleMsg(start({ yourShipId: 7, floor: 3 })); // added at the floor start
    inner.handleSnapshot(snap(300, { you: youState() }, { floor: 3 }));
    expect(c.riftDropInPending).toBe(false);
    // Watch never waits; a lobby-phase join neither
    c.joinRoom('d1', 'watch');
    inner.handleMsg(roomState('d1', 'playing'));
    expect(c.riftDropInPending).toBe(false);
    inner.handleMsg({ type: 'roomList', rooms: [summary({ phase: 'lobby' })], online: 1 });
    c.joinRoom('d1', 'play');
    expect(c.riftDropInPending).toBe(false);
  });

  it('a Dungeon Quick Play that lands in a running run waits; one that lands in a lobby does not', () => {
    const { c, inner } = client();
    c.quickPlay('dungeon');
    inner.handleMsg(roomState('d1', 'playing'));
    expect(c.riftDropInPending).toBe(true);
    inner.handleMsg(roomState('d1', 'results'));
    expect(c.riftDropInPending).toBe(false);
    c.quickPlay('dungeon');
    inner.handleMsg(roomState('d2', 'lobby'));
    expect(c.riftDropInPending).toBe(false);
    c.quickPlay('arena');
    inner.handleMsg(roomState('a1', 'playing', 'arena'));
    expect(c.riftDropInPending).toBe(false);
  });

  it('the room lobby Join marks the wait only in a running dungeon', () => {
    const { c, inner } = client();
    inner.handleMsg(roomState('d1', 'lobby'));
    c.noteRiftDropIn();
    expect(c.riftDropInPending).toBe(false);
    inner.handleMsg(roomState('d1', 'playing'));
    c.noteRiftDropIn();
    expect(c.riftDropInPending).toBe(true);
    inner.handleMsg(roomState('d1', 'playing', 'dungeon', true)); // in the match now
    expect(c.riftDropInPending).toBe(false);
  });

  it('your extraction is remembered for the run (across the spectator matchStart), not the next one', () => {
    const { c, inner } = client();
    inner.handleMsg(roomState('d1', 'playing'));
    inner.handleMsg(start());
    inner.handleSnapshot(snap(200, { you: youState() }));
    expect(c.riftExtracted).toBe(false);
    inner.handleSnapshot(snap(203, { you: youState(), events: [{ t: 'extract', playerId: 7, x: 0, y: 0 }] }));
    expect(c.riftExtracted).toBe(true);
    inner.handleMsg(start({ yourShipId: 0 })); // now a spectator of the same run
    expect(c.riftExtracted).toBe(true);
    inner.handleMsg(start({ mapSeed: 99 })); // another run
    expect(c.riftExtracted).toBe(false);
    // RiftYou.extracted counts too; the room going back to its lobby forgets it
    inner.handleSnapshot(snap(210, { you: youState({ alive: false, rift: { party: 0, lives: 3, waiting: false, extracted: true, extract: 1, followId: 0 } }) }));
    expect(c.riftExtracted).toBe(true);
    inner.handleMsg(roomState('d1', 'lobby'));
    expect(c.riftExtracted).toBe(false);
  });
});
