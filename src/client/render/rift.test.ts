// RENDER v0.3 M4 acceptance: the rift layer rules — floor-checked view + tile fallback, door geometry, door field
// looks per room state (DORMANT / ARMING / SEALED / CLEARED), the sealed-room vignette, chests, portals (Descend /
// Extract / EXIT on the final floor), minimap fog owners + levels, Matriarch phases, telegraph / crack lifetimes,
// transition FX (silent first observation, slam, clear, regroup reset), channel arcs (root-alpha rule), radar fog,
// beamBus portals, and the re-entrant setMap (floorStart).
import { beforeEach, describe, expect, it } from 'vitest';
import type { RenderFrame } from '../contracts';
import { RARITY_COLORS } from '../../shared/data/loot';
import {
  RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_DOOR, TILE_EMPTY, TILE_WALL,
  type GameEvent, type GameMap, type RiftView, type ShipView,
} from '../../shared/types';
import { beamBus } from './beamBus';
import { buildDemoFloor } from './demoRift';
import type { ObjShip } from './objectives';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import {
  ARM_COLOR, CHEST_REACH, CLEAR_COLOR, EXTRACT_COLOR, MAX_CRACKS, MAX_TELEGRAPHS, RIFT_ARM_SEC, RiftLayer, SEAL_COLOR,
  TELEGRAPH_STRIKE_SEC, chestRarity, chestState, clockText, crackPoints, doorGeoms, doorLook, doorTileIndices, fogLevels,
  fogOwners, matriarchPhase, portalLook, roomIndexAt, roomStates, viewFor, viewerParty, vignetteFor, warnFrac,
  type RiftHost,
} from './rift';

// ---------- fakes
type Call = { op: string; args: unknown[] };
function fakeGraphics(bad: string[] = []) {
  const calls: Call[] = [];
  const g: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ['circle', 'poly', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill', 'rect', 'closePath', 'ellipse']) {
    g[op] = (...args: unknown[]) => {
      for (const a of args) {
        const nums = typeof a === 'number' ? [a] : a && typeof a === 'object' ? Object.values(a).filter((v) => typeof v === 'number') : [];
        for (const n of nums as number[]) if (!Number.isFinite(n) && bad.length < 10) bad.push(`${op}(${JSON.stringify(args)})`);
      }
      calls.push({ op, args });
      return g;
    };
  }
  return { g: g as never, calls };
}
const styles = (calls: Call[], op: 'stroke' | 'fill') => calls.filter((c) => c.op === op).map((c) => c.args[0] as { color: number; alpha: number });
function fakeBatch() {
  const puts: { tex: unknown; x: number; y: number; color: number; alpha: number }[] = [];
  const b = {
    begin: () => { puts.length = 0; },
    put: (tex: unknown, x: number, y: number, _r: number, _sx: number, _sy: number, color: number, alpha: number) => { puts.push({ tex, x, y, color, alpha }); },
    end: () => {},
    pc: {},
  };
  return { b: b as unknown as SpriteBatch, puts };
}
const A = { soft: 'soft', beam: 'beam', ring: 'ring', dot: 'dot' } as unknown as Atlas;

interface Fx { op: string; args: unknown[] }
function mkHost(ships: Record<number, ObjShip> = {}, byPlayer: Record<number, number> = {}) {
  const fx: Fx[] = [];
  const labels: { key: string; text: string; x: number; y: number }[] = [];
  const rec = (op: string) => (...args: unknown[]) => { fx.push({ op, args }); };
  const host: RiftHost = {
    inView: () => true,
    ship: (id) => ships[id] ?? null,
    shipOfPlayer: (pid) => byPlayer[pid] ?? 0,
    label: (key, _space, text, x, y) => { labels.push({ key, text, x, y }); },
    ring: rec('ring'), burst: rec('burst'), flash: rec('flash'), impulse: rec('impulse'), tint: rec('tint'),
    shake: rec('shake'), shock: rec('shock'), spark: rec('spark'),
  };
  return { host, fx, labels };
}
const shipV = (o: Partial<ShipView>): ShipView => ({
  id: 1, playerId: 1, team: 0, shipClass: 'brute', x: 0, y: 0, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true, attachedTo: 0,
  turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1, ...o,
});

/** A RiftView for `map` (states / chests / seen default to the fresh floor). */
function viewOf(map: GameMap, o: Partial<RiftView> = {}): RiftView {
  const L = map.dungeon!;
  return {
    floor: L.floor, floorsTotal: 6, biome: L.biome, rooms: L.rooms.map(() => RIFT_DORMANT), chests: L.rooms.map(() => 0),
    lives: [6], seen: [1], anchors: [L.rooms[0].x, L.rooms[0].y], portal: 0, departIn: 0, extractOpen: false, boss: null,
    waiting: [], extracting: [], floorSec: 0, ...o,
  };
}
function frameOf(dungeon: RiftView | undefined, ships: ShipView[] = [shipV({})], localShipId = 1, events: GameEvent[] = []): RenderFrame {
  return {
    time: 0, dt: 1 / 60, renderTick: 0, localPlayerId: 1, localShipId, focusX: 0, focusY: 0, ships, enemies: [], projectiles: [],
    gems: [], deployables: [], events, you: null, players: new Map(), aimX: 0, aimY: 0, attachCandidateId: 0,
    match: dungeon ? {
      phase: 'playing', mode: 'teams', teamCount: 1, timeLeftSec: 0, teamScores: [0], wave: 1, winnerTeam: -1, winnerPlayerId: 0,
      timed: false, gameType: 'dungeon', subMode: 'coop', dungeon,
    } : null,
  };
}

/** One full frame of the layer (begin → events → world → ship fx → end). */
function run(layer: RiftLayer, f: RenderFrame, t: number, host: RiftHost, bad: string[] = []) {
  const pad = fakeGraphics(bad), add = fakeGraphics(bad), shipFx = fakeGraphics(bad);
  layer.begin(f, t, host);
  for (const ev of f.events) layer.event(ev, t, host);
  layer.drawWorld(f, t, pad.g, add.g, host);
  layer.drawShipFx(f, t, shipFx.g, host);
  layer.end();
  return { pad: pad.calls, add: add.calls, shipFx: shipFx.calls };
}

const F1 = buildDemoFloor(1, 'hive');
const F3 = buildDemoFloor(3, 'hive');
const F6 = buildDemoFloor(6, 'prism');
const ARENA = 1, TREASURE = 2, KEY = 4;

// =============================================================================================

describe('rift rules', () => {
  it('a view only counts for its own floor (the floorStart race)', () => {
    const v = viewOf(F1);
    expect(viewFor(v, F1.dungeon)).toBe(v);
    expect(viewFor({ ...v, floor: 2 }, F1.dungeon)).toBeNull();
    expect(viewFor(undefined, F1.dungeon)).toBeNull();
    expect(viewFor(v, undefined)).toBeNull();
  });

  it('room states come from the view, else from the door tiles (TILE_WALL on a door = SEALED)', () => {
    const v = viewOf(F1, { rooms: [3, 2, 0, 3, 1, 0] });
    expect(roomStates(F1, v)).toEqual([3, 2, 0, 3, 1, 0]);
    const m: GameMap = { ...F1, tiles: new Uint8Array(F1.tiles) };
    expect(roomStates(m, null)).toEqual([0, 0, 0, 0, 0, 0]);
    for (const i of m.dungeon!.rooms[ARENA].doors[0].tiles) m.tiles[i] = TILE_WALL; // applyRoomSeals' write
    expect(roomStates(m, null)[ARENA]).toBe(RIFT_SEALED);
    expect(roomStates(m, null)[KEY]).toBe(RIFT_DORMANT);
    expect(roomStates({ ...F1, dungeon: undefined }, null)).toEqual([]);
  });

  it('roomIndexAt finds interiors only (rims / corridors are -1)', () => {
    const L = F1.dungeon!;
    for (const r of L.rooms) expect(roomIndexAt(L, 32, r.x, r.y)).toBe(r.idx);
    const a = L.rooms[ARENA];
    expect(roomIndexAt(L, 32, (a.c0 - 1) * 32, a.y)).toBe(-1); // rim
    expect(roomIndexAt(L, 32, 65 * 32, 100 * 32)).toBe(-1); // corridor entrance → arena
    expect(roomIndexAt(undefined, 32, 0, 0)).toBe(-1);
  });

  it('door geometry: one rect per door, the gap axis, and the normal points into its room', () => {
    const g = doorGeoms(F1);
    const L = F1.dungeon!;
    expect(g.length).toBe(L.rooms.reduce((n, r) => n + r.doors.length, 0));
    expect(doorTileIndices(F1).length).toBe(g.reduce((n, d) => n + d.tiles.length, 0));
    for (const d of g) {
      const room = L.rooms[d.room];
      expect(d.tiles.length).toBe(10); // 5 × 2
      expect((d.c1 - d.c0) * (d.r1 - d.r0)).toBe(10);
      expect(d.alongX).toBe(d.c1 - d.c0 === 5);
      // stepping along the normal from the door centre moves toward the room centre
      const before = Math.hypot(room.x - d.cx, room.y - d.cy), after = Math.hypot(room.x - (d.cx + d.nx * 64), room.y - (d.cy + d.ny * 64));
      expect(after).toBeLessThan(before);
      for (const i of d.tiles) expect(F1.tiles[i]).toBe(TILE_DOOR);
    }
    expect(doorGeoms({ ...F1, dungeon: undefined })).toEqual([]);
  });

  it('fog owners: every tile has a room, interiors own themselves, a corridor splits between its ends', () => {
    const own = fogOwners(F1)!;
    const L = F1.dungeon!;
    expect(own.length).toBe(F1.cols * F1.rows);
    expect(Math.min(...own)).toBeGreaterThanOrEqual(0);
    for (const r of L.rooms) expect(own[Math.floor(r.y / 32) * F1.cols + Math.floor(r.x / 32)]).toBe(r.idx);
    // corridor entrance (c 51..80) → arena: the west half is the entrance's, the east half the arena's
    expect(own[100 * F1.cols + 55]).toBe(0);
    expect(own[100 * F1.cols + 76]).toBe(ARENA);
    expect(fogOwners({ ...F1, dungeon: undefined })).toBeNull();
  });

  it('fog levels: seen rooms 2, rooms linked to a seen room 1 (glimpsed), the rest 0', () => {
    const L = F1.dungeon!;
    expect([...fogLevels(L, 0b1)]).toEqual([2, 1, 0, 0, 0, 1]); // entrance seen → arena + south arena glimpsed
    expect([...fogLevels(L, 0b11)]).toEqual([2, 2, 1, 1, 0, 1]);
    expect([...fogLevels(L, 0)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('chests: treasure any time, reward / key only once CLEARED, opened by the mask bit', () => {
    const L = F1.dungeon!;
    expect(chestState(L.rooms[TREASURE], 0, RIFT_DORMANT, 0)).toBe('ready');
    expect(chestState(L.rooms[TREASURE], 1, RIFT_DORMANT, 0b01)).toBe('ready');
    expect(chestState(L.rooms[TREASURE], 0, RIFT_DORMANT, 0b01)).toBe('opened');
    expect(chestState(L.rooms[ARENA], 0, RIFT_SEALED, 0)).toBe('locked');
    expect(chestState(L.rooms[ARENA], 0, RIFT_CLEARED, 0)).toBe('ready');
    expect(chestState(L.rooms[KEY], 0, RIFT_ARMING, 0)).toBe('locked');
    expect(chestRarity('arena')).toBe(0);
    expect(chestRarity('treasure')).toBe(1);
    expect(chestRarity('key')).toBe(1);
  });

  it('door looks: open → arming closes over RIFT_ARM_SEC → sealed shut → cleared retracts and settles', () => {
    const idle = 0x123456;
    const open = doorLook(RIFT_DORMANT, 0, Infinity, 0, idle);
    expect(open).toMatchObject({ mode: 'open', close: 0, alpha: 0, jamb: idle });
    const a0 = doorLook(RIFT_ARMING, 0, Infinity, 0, idle), a1 = doorLook(RIFT_ARMING, RIFT_ARM_SEC / 2, Infinity, 0, idle);
    const a2 = doorLook(RIFT_ARMING, RIFT_ARM_SEC * 3, Infinity, 0, idle);
    expect(a0.close).toBe(0); expect(a1.close).toBeCloseTo(0.5, 6); expect(a2.close).toBe(1);
    expect(a1.color).toBe(ARM_COLOR);
    const s = doorLook(RIFT_SEALED, 99, Infinity, 1, idle);
    expect(s).toMatchObject({ mode: 'sealed', close: 1, color: SEAL_COLOR });
    expect(s.alpha).toBeGreaterThan(0.6);
    const c0 = doorLook(RIFT_CLEARED, 99, 0, 0, idle), c1 = doorLook(RIFT_CLEARED, 99, 0.5, 0, idle), c2 = doorLook(RIFT_CLEARED, 99, Infinity, 0, idle);
    expect(c0.close).toBe(1); expect(c0.color).toBe(CLEAR_COLOR);
    expect(c1.close).toBe(0); expect(c1.alpha).toBe(0);
    expect(c2.close).toBe(0); expect(c2.jamb).not.toBe(CLEAR_COLOR); // settled toward the idle colour
  });

  it('vignette: sealed strongest, arming a warning, nothing otherwise', () => {
    const s = vignetteFor(RIFT_SEALED, 0), a = vignetteFor(RIFT_ARMING, 0);
    expect(s.alpha).toBeGreaterThan(a.alpha);
    expect(a.alpha).toBeGreaterThan(0);
    for (const st of [RIFT_DORMANT, RIFT_CLEARED, -1]) expect(vignetteFor(st, 0).alpha).toBe(0);
  });

  it('portals: closed / open / departing; extract only when open on a boss floor; the final floor has only EXIT', () => {
    const L1 = F1.dungeon!, L3 = F3.dungeon!, L6 = F6.dungeon!;
    expect(portalLook(L1, null)).toMatchObject({ descend: 'closed', extract: 'none', exitLabel: 'EXTRACT' });
    expect(portalLook(L1, viewOf(F1, { portal: 1 })).descend).toBe('open');
    expect(portalLook(L1, viewOf(F1, { portal: 2 })).descend).toBe('departing');
    expect(portalLook(L1, viewOf(F1, { extractOpen: true })).extract).toBe('none'); // no extract on a non-boss floor
    expect(portalLook(L3, viewOf(F3, { extractOpen: true, portal: 1 }))).toMatchObject({ descend: 'open', extract: 'open', exitLabel: 'EXTRACT' });
    expect(portalLook(L6, viewOf(F6, { extractOpen: true, portal: 0 }))).toMatchObject({ descend: 'none', extract: 'open', exitLabel: 'EXIT', final: true });
    // a 3-floor run ends on floor 3
    expect(portalLook(L3, viewOf(F3, { floorsTotal: 3, extractOpen: true }))).toMatchObject({ descend: 'none', exitLabel: 'EXIT' });
  });

  it('Matriarch phase: the view boss entry wins, else the HP thresholds (66% / 33%)', () => {
    const v = viewOf(F3, { boss: { id: 9, kind: 'matriarch', hpFrac: 0.9, phase: 3 } });
    expect(matriarchPhase(v, 9, 0.9)).toBe(3);
    expect(matriarchPhase(v, 10, 0.9)).toBe(1);
    expect(matriarchPhase(null, 1, 0.5)).toBe(2);
    expect(matriarchPhase(null, 1, 0.2)).toBe(3);
  });

  it('viewer party: you.rift.party, else the local ship / roster team, else 0 (spectators)', () => {
    const f = frameOf(viewOf(F1), [shipV({ team: 1 })]);
    expect(viewerParty(f)).toBe(1);
    expect(viewerParty({ ...f, localShipId: 0 })).toBe(0);
    expect(viewerParty({ ...f, you: { rift: { party: 0, lives: 3, waiting: false, extracted: false, extract: 0, followId: 0 } } as never })).toBe(0);
  });

  it('helpers: warning fraction, clock text, deterministic cracks', () => {
    expect(warnFrac(0.4, 0.8)).toBeCloseTo(0.5, 6);
    expect(warnFrac(2, 0.8)).toBe(1);
    expect(warnFrac(0, 0)).toBe(1);
    expect(clockText(45)).toBe('0:45');
    expect(clockText(61.2)).toBe('1:02');
    const a = crackPoints(100, 200, 90), b = crackPoints(100, 200, 90);
    expect(a).toEqual(b);
    expect(a.length).toBe(7 * 5 * 2);
    for (let k = 0; k < 7; k++) expect(a[k * 10]).toBe(100); // every crack starts at the centre
  });
});

// =============================================================================================

describe('rift layer', () => {
  let layer: RiftLayer, batch: ReturnType<typeof fakeBatch>;
  beforeEach(() => { batch = fakeBatch(); layer = new RiftLayer(A, batch.b); beamBus.portalCount = 0; });

  it('inactive on arena maps: nothing drawn, no fog, everything revealed', () => {
    layer.setMap({ ...F1, dungeon: undefined });
    const { host, fx } = mkHost();
    const out = run(layer, frameOf(undefined), 0, host);
    expect(layer.active).toBe(false);
    expect(layer.fogKey).toBe(-1);
    expect(layer.fog()).toBeNull();
    expect(layer.revealedAt(100, 100)).toBe(true);
    expect(out.pad.length + out.add.length + batch.puts.length + fx.length).toBe(0);
  });

  it('the first observation is silent (a drop-in never replays a slam); transitions then play their FX', () => {
    layer.setMap(F1);
    const { host, fx } = mkHost();
    run(layer, frameOf(viewOf(F1, { rooms: [3, RIFT_SEALED, 0, 0, 0, 0] })), 0, host);
    expect(fx.filter((q) => q.op === 'shake')).toHaveLength(0);
    // arming → sealed on the key room: a flash per door, then the slam (flash + burst + impulse + shake)
    run(layer, frameOf(viewOf(F1, { rooms: [3, 2, 0, 0, RIFT_ARMING, 0] })), 1, host);
    expect(fx.filter((q) => q.op === 'flash' && (q.args[3] as number) === ARM_COLOR).length).toBeGreaterThan(0);
    fx.length = 0;
    run(layer, frameOf(viewOf(F1, { rooms: [3, 2, 0, 0, RIFT_SEALED, 0] })), 2.5, host);
    expect(fx.some((q) => q.op === 'shake')).toBe(true);
    expect(fx.some((q) => q.op === 'burst' && (q.args[3] as number) !== CLEAR_COLOR)).toBe(true);
    // sealed → cleared: green bursts at the doors
    fx.length = 0;
    run(layer, frameOf(viewOf(F1, { rooms: [3, 2, 0, 0, RIFT_CLEARED, 0] })), 10, host);
    expect(fx.some((q) => q.op === 'burst' && q.args[3] === CLEAR_COLOR)).toBe(true);
    // sealed → dormant (regroup reset): a grey fizzle, no slam
    fx.length = 0;
    run(layer, frameOf(viewOf(F1, { rooms: [3, RIFT_DORMANT, 0, 0, 3, 0] })), 11, host);
    expect(fx.some((q) => q.op === 'burst')).toBe(true);
    expect(fx.some((q) => q.op === 'shake')).toBe(false);
  });

  it('door fields: nothing across an open door, closing panels while arming, a full field when sealed', () => {
    layer.setMap(F1);
    const { host } = mkHost();
    const fieldFills = (o: ReturnType<typeof run>) => styles(o.pad, 'fill').filter((s) => s.color === ARM_COLOR || s.color === SEAL_COLOR).length;
    const open = run(layer, frameOf(viewOf(F1)), 0, host);
    expect(fieldFills(open)).toBe(0);
    const arm = run(layer, frameOf(viewOf(F1, { rooms: [3, RIFT_ARMING, 0, 0, 0, 0] })), 1, host);
    // first observation at t=1 → close 0 → no panel yet; half a second later the panels are in
    expect(fieldFills(arm)).toBe(0);
    const arm2 = run(layer, frameOf(viewOf(F1, { rooms: [3, RIFT_ARMING, 0, 0, 0, 0] })), 1.75, host);
    expect(fieldFills(arm2)).toBeGreaterThan(0);
    const sealed = run(layer, frameOf(viewOf(F1, { rooms: [3, RIFT_SEALED, 0, 0, 0, 0] })), 3, host);
    const nArenaDoors = F1.dungeon!.rooms[ARENA].doors.length;
    expect(styles(sealed.pad, 'fill').filter((s) => s.color === SEAL_COLOR).length).toBe(nArenaDoors * 2); // 2 panels per door
  });

  it('a view for another floor is ignored: seals are read from the tiles instead', () => {
    const m: GameMap = { ...F1, tiles: new Uint8Array(F1.tiles) };
    for (const i of m.dungeon!.rooms[ARENA].doors[0].tiles) m.tiles[i] = TILE_WALL;
    layer.setMap(m);
    const { host } = mkHost();
    run(layer, frameOf(viewOf(F3, { rooms: [0, 0, 0, 0, 0, 0] })), 0, host); // floor 3 view on a floor 1 map
    expect(layer.roomStateList[ARENA]).toBe(RIFT_SEALED);
  });

  it('chests: a newly opened bit plays the FX once (the chestOpen event does not repeat it)', () => {
    layer.setMap(F1);
    const { host, fx } = mkHost();
    run(layer, frameOf(viewOf(F1)), 0, host);
    const L = F1.dungeon!, tr = L.rooms[TREASURE];
    const ev: GameEvent = { t: 'chestOpen', room: TREASURE, chest: 0, playerId: 1, team: 0, x: tr.chests[0], y: tr.chests[1] };
    const v = viewOf(F1, { chests: [0, 0, 0b01, 0, 0, 0] });
    run(layer, frameOf(v, undefined, 1, [ev]), 1, host);
    const rings = fx.filter((q) => q.op === 'ring' && q.args[5] === RARITY_COLORS[1]).length;
    expect(rings).toBe(1);
    run(layer, frameOf(v, undefined, 1, [ev]), 1.1, host);
    expect(fx.filter((q) => q.op === 'ring' && q.args[5] === RARITY_COLORS[1]).length).toBe(1);
  });

  it('ready chests show their 48 px reach ring; locked ones a padlock; opened ones neither', () => {
    layer.setMap(F1);
    const { host } = mkHost();
    const reachArcs = (o: ReturnType<typeof run>) => o.add.filter((c) => c.op === 'arc' && (c.args[2] as number) === CHEST_REACH).length;
    const locked = run(layer, frameOf(viewOf(F1, { rooms: [3, 2, 0, 0, 0, 0] })), 0, host);
    // only the treasure room's 2 chests are ready (10 dashes each)
    expect(reachArcs(locked)).toBe(20);
    const cleared = run(layer, frameOf(viewOf(F1, { rooms: [3, 3, 0, 0, 0, 0] })), 1, host);
    expect(reachArcs(cleared)).toBe(30); // + the arena reward chest
    const opened = run(layer, frameOf(viewOf(F1, { rooms: [3, 3, 0, 0, 0, 0], chests: [0, 1, 3, 0, 0, 0] })), 2, host);
    expect(reachArcs(opened)).toBe(0);
  });

  it('portals publish to beamBus only while open, with labels; the final floor draws no Descend', () => {
    layer.setMap(F3);
    const { host, labels } = mkHost();
    run(layer, frameOf(viewOf(F3)), 0, host);
    expect(beamBus.portalCount).toBe(0);
    expect(labels.some((l) => l.key === 'rift:descend')).toBe(false);
    run(layer, frameOf(viewOf(F3, { portal: 1, extractOpen: true })), 1, host);
    expect(beamBus.portalCount).toBe(2);
    expect(labels.find((l) => l.key === 'rift:descend')?.text).toBe('DESCEND');
    expect(labels.find((l) => l.key === 'rift:extract')?.text).toBe('EXTRACT');
    labels.length = 0;
    run(layer, frameOf(viewOf(F3, { portal: 2, departIn: 18 })), 2, host);
    expect(labels.find((l) => l.key === 'rift:descend')?.text).toBe('DESCENDING 18');
    expect(beamBus.portals[0].level).toBe(2);
    // F6 (final): EXIT with the victory-lap clock, no Descend at all
    layer.setMap(F6);
    labels.length = 0;
    run(layer, frameOf(viewOf(F6, { extractOpen: true, departIn: 45 })), 3, host);
    expect(labels.some((l) => l.key === 'rift:descend')).toBe(false);
    expect(labels.find((l) => l.key === 'rift:extract')?.text).toBe('EXIT 0:45');
    expect(beamBus.portalCount).toBe(1);
  });

  it('channel arcs follow every extracting ship, but never reveal a faint non-ally (root-alpha rule)', () => {
    layer.setMap(F3);
    const L = F3.dungeon!;
    const ships: Record<number, ObjShip> = {
      11: { x: L.extractX + 60, y: L.extractY, r: 20, vx: 0, vy: 0, alpha: 1, ally: true, cloaked: false },
      12: { x: L.extractX - 60, y: L.extractY, r: 20, vx: 0, vy: 0, alpha: 0.1, ally: false, cloaked: true },
    };
    const { host } = mkHost(ships, { 1: 11, 2: 12 });
    const v = viewOf(F3, { extractOpen: true, extracting: [{ playerId: 1, frac: 0.5 }, { playerId: 2, frac: 0.7 }] });
    const out = run(layer, frameOf(v), 0, host);
    const gold = styles(out.shipFx, 'stroke').filter((s) => s.color === EXTRACT_COLOR);
    expect(gold.length).toBeGreaterThanOrEqual(2); // track + progress arc for the ally
    const arcs = out.shipFx.filter((c) => c.op === 'arc');
    expect(arcs.every((c) => Math.abs((c.args[0] as number) - ships[11].x) < 1e-6)).toBe(true);
  });

  it('telegraphs and spawn cracks live for their warning (+ strike / fade), capped, then go', () => {
    layer.setMap(F3);
    const { host, fx } = mkHost();
    const tel: GameEvent = { t: 'telegraph', shape: 'line', x: 100, y: 100, x2: 700, y2: 100, r: 60, sec: 0.8 };
    const ring: GameEvent = { t: 'telegraph', shape: 'ring', x: 900, y: 900, x2: 900, y2: 900, r: 300, sec: 1 };
    const warn: GameEvent = { t: 'spawnWarn', x: 400, y: 400, radius: 90, sec: 0.8 };
    run(layer, frameOf(viewOf(F3), undefined, 1, [tel, ring, warn]), 0, host);
    expect(layer.counts).toMatchObject({ telegraphs: 2, cracks: 1 });
    run(layer, frameOf(viewOf(F3)), 0.9, host); // the line struck, the crack burst
    expect(fx.some((q) => q.op === 'burst')).toBe(true);
    run(layer, frameOf(viewOf(F3)), 0.8 + TELEGRAPH_STRIKE_SEC + 0.05, host);
    expect(layer.counts.telegraphs).toBe(1); // the ring (1 s) is still up
    run(layer, frameOf(viewOf(F3)), 2, host);
    expect(layer.counts).toMatchObject({ telegraphs: 0, cracks: 0 });
    const many: GameEvent[] = [];
    for (let i = 0; i < 40; i++) many.push({ ...tel, x: i }, { ...warn, x: i });
    run(layer, frameOf(viewOf(F3), undefined, 1, many), 3, host);
    expect(layer.counts.telegraphs).toBe(MAX_TELEGRAPHS);
    expect(layer.counts.cracks).toBe(MAX_CRACKS);
  });

  it('boss intro: shake + shock + the 3 s intro age; phase from the view', () => {
    layer.setMap(F3);
    const { host, fx } = mkHost();
    const v = viewOf(F3, { boss: { id: 77, kind: 'matriarch', hpFrac: 0.5, phase: 2 } });
    run(layer, frameOf(v, undefined, 1, [{ t: 'bossIntro', id: 77, kind: 'matriarch', x: 10, y: 10 }]), 5, host);
    expect(fx.some((q) => q.op === 'shake')).toBe(true);
    expect(fx.some((q) => q.op === 'shock')).toBe(true);
    expect(layer.introAge(77, 6)).toBeCloseTo(1, 6);
    expect(layer.introAge(78, 6)).toBe(Infinity);
    expect(layer.bossPhase(77, 0.9)).toBe(2);
  });

  it('fog: the key follows the viewer party seen mask (+ entrance), radar hides doors / enemies in fogged rooms', () => {
    layer.setMap(F1);
    const { host } = mkHost();
    expect(layer.fogKey).toBe(0b1); // entrance before any view
    run(layer, frameOf(viewOf(F1, { seen: [0b10] })), 0, host);
    expect(layer.fogKey).toBe(0b11); // the entrance is always revealed
    const L = F1.dungeon!;
    expect(layer.revealedAt(L.rooms[ARENA].x, L.rooms[ARENA].y)).toBe(true);
    expect(layer.revealedAt(L.rooms[KEY].x, L.rooms[KEY].y)).toBe(false);
    expect(layer.revealedAt(L.rooms[TREASURE].x, L.rooms[TREASURE].y)).toBe(false); // glimpsed only
    const radar = fakeGraphics();
    layer.drawRadar(frameOf(viewOf(F1)), radar.g, 0, 0, 0.05, 0.05, false, 0);
    const doorRects = radar.calls.filter((c) => c.op === 'rect').length;
    const visibleDoors = doorGeoms(F1).filter((d) => d.room !== KEY).length; // the key room is neither seen nor linked
    expect(doorRects).toBeGreaterThanOrEqual(visibleDoors);
    const fog = layer.fog()!;
    expect(fog.levels[KEY]).toBe(0);
    expect(fog.levels[TREASURE]).toBe(1);
  });

  it('setMap is re-entrant: a floorStart drops every transient and re-indexes the new floor', () => {
    layer.setMap(F1);
    const { host } = mkHost();
    run(layer, frameOf(viewOf(F1, { rooms: [3, 2, 0, 0, 0, 0] }), undefined, 1, [
      { t: 'telegraph', shape: 'ring', x: 0, y: 0, x2: 0, y2: 0, r: 100, sec: 5 },
      { t: 'spawnWarn', x: 0, y: 0, radius: 90, sec: 5 },
    ]), 0, host);
    expect(layer.counts.telegraphs + layer.counts.cracks).toBe(2);
    layer.setMap(F3);
    expect(layer.counts).toMatchObject({ rooms: F3.dungeon!.rooms.length, telegraphs: 0, cracks: 0 });
    expect(layer.roomStateList.length).toBe(0);
    // the new floor's first view is observed silently again
    const fx2 = mkHost();
    run(layer, frameOf(viewOf(F3, { rooms: [3, 2, 0, 0, 2, 0] })), 1, fx2.host);
    expect(fx2.fx.filter((q) => q.op === 'shake')).toHaveLength(0);
  });

  it('never emits NaN over a scripted floor (every state, portals, telegraphs, cracks, channels)', () => {
    const bad: string[] = [];
    layer.setMap(F3);
    const L = F3.dungeon!;
    const ships: Record<number, ObjShip> = { 11: { x: L.extractX, y: L.extractY + 30, r: 22, vx: 0, vy: 0, alpha: 1, ally: true, cloaked: false } };
    const { host } = mkHost(ships, { 1: 11 });
    for (let k = 0; k < 40; k++) {
      const s = k % 4;
      const v = viewOf(F3, {
        rooms: L.rooms.map((_, i) => (i === 0 ? 3 : (s + i) % 4)), chests: L.rooms.map(() => k % 3), seen: [(1 << (k % 6)) | 1],
        portal: (k % 3) as 0 | 1 | 2, departIn: k % 3 === 2 ? 20 - (k % 20) : 0, extractOpen: k > 10,
        extracting: k > 10 ? [{ playerId: 1, frac: (k % 10) / 10 }] : [],
        boss: k > 5 ? { id: 5, kind: 'matriarch', hpFrac: 1 - k / 40, phase: 1 + (k % 3) } : null,
      });
      const evs: GameEvent[] = k % 5 === 0 ? [
        { t: 'telegraph', shape: k % 10 ? 'line' : 'ring', x: 100, y: 100, x2: k % 10 ? 100 : 100, y2: 100, r: 60, sec: 0.8 }, // zero-length line too
        { t: 'spawnWarn', x: 300, y: 300, radius: 90, sec: 0.8 },
        { t: 'portalOpen', x: L.portalX, y: L.portalY, extract: false },
        { t: 'extract', playerId: 1, x: 1, y: 1 },
        { t: 'roomClear', room: 1, team: 0, x: 5, y: 5 },
      ] : [];
      run(layer, frameOf(v, undefined, 1, evs), k * 0.1, host, bad);
      const radar = fakeGraphics(bad);
      layer.drawRadar(frameOf(v), radar.g, 10, 10, 0.03, 0.03, k % 2 === 0, k * 0.1);
    }
    expect(bad).toEqual([]);
    expect(batch.puts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.alpha))).toBe(true);
  });

  it('the demo floor itself is a valid rift layout (doors only on sealable rooms, markers / chests on open floor)', () => {
    for (const m of [F1, F3, F6]) {
      const L = m.dungeon!;
      for (const r of L.rooms) {
        const sealable = r.kind === 'arena' || r.kind === 'key' || r.kind === 'boss';
        expect(r.doors.length > 0).toBe(sealable);
        for (let k = 0; k + 1 < r.spawns.length; k += 2) {
          const t = m.tiles[Math.floor(r.spawns[k + 1] / 32) * m.cols + Math.floor(r.spawns[k] / 32)];
          expect(t === TILE_EMPTY || t === 3).toBe(true);
        }
        for (let k = 0; k + 1 < r.chests.length; k += 2) expect(roomIndexAt(L, 32, r.chests[k], r.chests[k + 1])).toBe(r.idx);
      }
      expect(roomIndexAt(L, 32, L.portalX, L.portalY)).toBe(L.keyRoom);
      if (L.bossFloor) expect(roomIndexAt(L, 32, L.extractX, L.extractY)).toBe(L.keyRoom);
      else expect(L.extractX).toBe(-1);
    }
  });
});
