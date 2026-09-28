// RENDER v0.3 M3: objective layer rules — zone look (owner / capper / decap / contested flicker / swarm), hot point
// phases + armed pulse, flag stands / carried / dropped pennants + return ring, carrier glow root-alpha rule,
// edge pointers, radar icons, event FX, re-entrant setMap.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RenderFrame } from '../contracts';
import { ENEMY_TEAM, NO_TEAM } from '../../shared/constants';
import { ENEMY_COLOR, TEAM_COLORS, colorFor } from '../../shared/data/teams';
import { CTF_RETURN_SEC, HOT_ARM_SEC, HOT_WARN_SEC } from '../../shared/sim/objectives/rules';
import { SHIPFLAG_CARRIER, type GameEvent, type GameMap, type MapFeature, type ObjectiveView, type ShipView } from '../../shared/types';
import { beamBus } from './beamBus';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import {
  Countdown, EDGE_INSETS, HOT_BEAM_H, MAX_POINTERS, NEUTRAL_COLOR, ObjectiveLayer, RETURN_R, STAND_R,
  edgePointer, hotNextIndex, hotPhase, isOurs, localSide, pointerInsets, returnFrac, sideColor, zoneLabel, zoneLook,
  type ObjShip, type ObjectiveHost, type ZoneV,
} from './objectives';

const TAU = Math.PI * 2;

// ---------- fakes
type Call = { op: string; args: unknown[] };
function fakeGraphics() {
  const calls: Call[] = [];
  const g: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ['circle', 'poly', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill', 'rect', 'closePath']) {
    g[op] = (...args: unknown[]) => { calls.push({ op, args }); return g; };
  }
  return { g: g as never, calls };
}
const styleOf = (c: Call) => c.args[0] as { color: number; alpha: number; width?: number };
const strokes = (calls: Call[]) => calls.filter((c) => c.op === 'stroke').map(styleOf);
const fills = (calls: Call[]) => calls.filter((c) => c.op === 'fill').map(styleOf);
const arcs = (calls: Call[]) => calls.filter((c) => c.op === 'arc').map((c) => c.args as number[]);

function fakeBatch() {
  const puts: { tex: unknown; x: number; y: number; sx: number; sy: number; color: number; alpha: number }[] = [];
  const b = {
    begin: () => { puts.length = 0; },
    put: (tex: unknown, x: number, y: number, _r: number, sx: number, sy: number, color: number, alpha: number) => { puts.push({ tex, x, y, sx, sy, color, alpha }); },
    end: () => {},
    pc: {},
  };
  return { b: b as unknown as SpriteBatch, puts };
}
const A = { soft: 'soft', beam: 'beam', ring: 'ring', dot: 'dot' } as unknown as Atlas;

interface Label { key: string; space: string; text: string; x: number; y: number; color: number; alpha: number; size: number }
function mkHost(ships: Record<number, ObjShip> = {}, over: Partial<ObjectiveHost> = {}) {
  const labels: Label[] = [];
  const fx: Call[] = [];
  const rec = (op: string) => (...args: unknown[]) => { fx.push({ op, args }); };
  const host: ObjectiveHost = {
    inView: () => true,
    ship: (id) => ships[id] ?? null,
    toScreen: (x, y, out) => { out.x = x; out.y = y; },
    screenW: () => 1000,
    screenH: () => 800,
    avoidRect: () => null,
    label: (key, space, text, x, y, color, alpha, size) => { labels.push({ key, space, text, x, y, color, alpha, size }); },
    ring: rec('ring'), burst: rec('burst'), flash: rec('flash'), impulse: rec('impulse'), tint: rec('tint'),
    ...over,
  };
  return { host, labels, fx };
}
const anchor = (o: Partial<ObjShip> = {}): ObjShip => ({ x: 0, y: 0, r: 20, vx: 0, vy: 0, alpha: 1, ally: false, cloaked: false, ...o });

function mapWith(features: MapFeature[] | undefined): GameMap {
  return { seed: 1, teamCount: 4, width: 6400, height: 6400, tileSize: 32, cols: 200, rows: 200, tiles: new Uint8Array(40000), spawns: [], features };
}
const ship = (o: Partial<ShipView>): ShipView => ({
  id: 1, playerId: 1, team: 0, shipClass: 'brute', x: 0, y: 0, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true, attachedTo: 0,
  turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1, ...o,
});
function frame(objective: ObjectiveView | undefined, ships: ShipView[] = [ship({})], localShipId = 1): RenderFrame {
  return {
    time: 0, dt: 1 / 60, renderTick: 0, localPlayerId: 1, localShipId, focusX: 0, focusY: 0, ships, enemies: [], projectiles: [],
    gems: [], deployables: [], events: [], you: null, players: new Map(), aimX: 0, aimY: 0, attachCandidateId: 0,
    match: objective ? { phase: 'playing', mode: 'teams', teamCount: 4, timeLeftSec: 100, teamScores: [], wave: 0, winnerTeam: -1, winnerPlayerId: 0, objective } : null,
  };
}
const zone = (o: Partial<ZoneV>): ZoneV => ({ i: 0, owner: -1, ownerPid: 0, cap: -1, capPid: 0, p: 0, contested: false, swarm: false, active: true, ...o });

/** Run one full frame of the layer; returns everything it drew. */
function run(layer: ObjectiveLayer, f: RenderFrame, t: number, host: ObjectiveHost, batch: ReturnType<typeof fakeBatch>) {
  const pad = fakeGraphics(), add = fakeGraphics(), car = fakeGraphics();
  layer.begin(f);
  layer.drawWorld(f, t, pad.g, add.g, host);
  layer.drawCarriers(f, t, car.g, host);
  layer.end();
  return { pad: pad.calls, add: add.calls, car: car.calls, puts: [...batch.puts] };
}

// Stands far apart so every one is distinct; the local ship sits near nothing.
const STANDS: MapFeature[] = [0, 1, 2, 3].map((t) => ({ kind: 'flagStand', team: t, index: t, x: 1000 + t * 1000, y: 1000, radius: 90 }));
const ZONES: MapFeature[] = [0, 1, 2, 3, 4].map((i) => ({ kind: 'zone', team: -1, index: i, x: 1000 + i * 1000, y: 3000, radius: 200 }));
const SITES: MapFeature[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ kind: 'hotSite', team: -1, index: i, x: 800 + i * 600, y: 5000, radius: 240 }));

// =============================================================================================

describe('objective rules', () => {
  it('side colours: team colour, FFA player colour, else neutral (null)', () => {
    expect(sideColor(2, 7)).toBe(TEAM_COLORS[2]);
    expect(sideColor(NO_TEAM, 7)).toBe(colorFor(NO_TEAM, 7));
    expect(sideColor(NO_TEAM, 0)).toBeNull();
    expect(sideColor(ENEMY_TEAM, 0)).toBeNull();
  });

  it('zone look: neutral dashed; owner solid; capper arc; decap; restore; contested flicker; FFA owner by player', () => {
    const n = zoneLook(zone({}), 0);
    expect(n).toMatchObject({ owner: null, cap: null, dashed: true, ring: NEUTRAL_COLOR, progress: 0 });
    expect(zoneLook(undefined, 0).dashed).toBe(true);
    const own = zoneLook(zone({ owner: 1 }), 0);
    expect(own).toMatchObject({ owner: TEAM_COLORS[1], dashed: false, ring: TEAM_COLORS[1], decap: false });
    const cap = zoneLook(zone({ cap: 2, p: 40 }), 0);
    expect(cap).toMatchObject({ owner: null, cap: TEAM_COLORS[2], decap: false });
    expect(cap.progress).toBeCloseTo(0.4, 6);
    expect(zoneLook(zone({ owner: 1, cap: 3, p: 25 }), 0)).toMatchObject({ decap: true, cap: TEAM_COLORS[3] });
    expect(zoneLook(zone({ owner: 1, cap: 1, p: 25 }), 0).decap).toBe(false); // own team restoring its hold
    expect(zoneLook(zone({ cap: 2, p: 0 }), 0).cap).toBeNull(); // no progress, no arc
    const on = zoneLook(zone({ owner: 1, contested: true }), 0), off = zoneLook(zone({ owner: 1, contested: true }), 0.13);
    expect(on.flickerOn).toBe(true); expect(on.ring).toBe(0xffffff);
    expect(off.flickerOn).toBe(false); expect(off.ring).toBe(TEAM_COLORS[1]);
    const ffa = zoneLook(zone({ owner: NO_TEAM, ownerPid: 9, cap: NO_TEAM, capPid: 4, p: 50 }), 0);
    expect(ffa).toMatchObject({ owner: colorFor(NO_TEAM, 9), cap: colorFor(NO_TEAM, 4), decap: true });
  });

  it('hot phase: arming while armIn > 0, warn once the next site is picked within HOT_WARN_SEC, else live', () => {
    expect(hotPhase({ site: 0, next: -1, moveIn: 50, armIn: 2 })).toBe('arming');
    expect(hotPhase({ site: 0, next: 3, moveIn: HOT_WARN_SEC, armIn: 0 })).toBe('warn');
    expect(hotPhase({ site: 0, next: -1, moveIn: 5, armIn: 0 })).toBe('live');
    expect(hotPhase({ site: 0, next: 0, moveIn: 5, armIn: 0 })).toBe('live');
    expect(hotPhase({ site: 0, next: 3, moveIn: HOT_WARN_SEC + 1, armIn: 0 })).toBe('live');
    // overtime: relocation is paused, so no warn phase and no next-site preview even with `next` still set
    expect(hotPhase({ site: 0, next: 3, moveIn: 4, armIn: 0 }, true)).toBe('live');
    expect(hotPhase({ site: 0, next: 3, moveIn: 4, armIn: 1 }, true)).toBe('arming');
    expect(hotNextIndex({ site: 0, next: 3, moveIn: 4, armIn: 0 })).toBe(3);
    expect(hotNextIndex({ site: 0, next: 3, moveIn: 4, armIn: 0 }, true)).toBe(-1);
    expect(hotNextIndex({ site: 3, next: 3, moveIn: 4, armIn: 0 })).toBe(-1);
    expect(hotNextIndex({ site: 0, next: -1, moveIn: 4, armIn: 0 })).toBe(-1);
  });

  it('return fraction, zone labels, sides', () => {
    expect(returnFrac(CTF_RETURN_SEC)).toBe(1);
    expect(returnFrac(CTF_RETURN_SEC / 2)).toBeCloseTo(0.5, 6);
    expect(returnFrac(-3)).toBe(0);
    expect([0, 1, 2, 3, 4].map(zoneLabel)).toEqual(['CORE', 'A', 'B', 'C', 'D']);
    expect(localSide(frame(undefined, [ship({ team: 3 })]))).toEqual({ team: 3, pid: 1 });
    expect(localSide(frame(undefined, [], 0)).team).toBe(-2); // spectator, not in the roster
    expect(isOurs({ team: 1, pid: 1 }, 1, 99)).toBe(true);
    expect(isOurs({ team: NO_TEAM, pid: 5 }, NO_TEAM, 5)).toBe(true);
    expect(isOurs({ team: NO_TEAM, pid: 5 }, NO_TEAM, 6)).toBe(false);
    expect(isOurs({ team: -2, pid: 5 }, 0, 5)).toBe(false);
  });

  it('edge pointer: null on screen; clamps to the inset rectangle along the ray; slides out of the radar', () => {
    const W = 1000, H = 800, ins = { l: 30, r: 30, t: 70, b: 100 };
    expect(edgePointer(500, 400, W, H, ins)).toBeNull();
    const cy = (70 + 700) / 2;
    const right = edgePointer(5000, cy, W, H, ins)!;
    expect(right.x).toBeCloseTo(970, 6); expect(right.y).toBeCloseTo(cy, 6); expect(right.a).toBeCloseTo(0, 6);
    const up = edgePointer(500, -4000, W, H, ins)!;
    expect(up.y).toBeCloseTo(70, 6); expect(up.a).toBeCloseTo(-Math.PI / 2, 6);
    const diag = edgePointer(-10_000, -10_000, W, H, ins)!;
    expect(diag.x >= 30 - 1e-6 && diag.x <= 970 + 1e-6 && diag.y >= 70 - 1e-6 && diag.y <= 700 + 1e-6).toBe(true);
    expect(Math.abs(diag.x - 30) < 1e-6 || Math.abs(diag.y - 70) < 1e-6).toBe(true);
    // radar box in the bottom-right: a pointer that would land inside it moves along the edge, out of it
    const radar = { x: 750, y: 500, w: 240, h: 290 };
    const hit = edgePointer(5000, 1500, W, H, ins, radar)!;
    expect(hit.x).toBeCloseTo(970, 6);
    expect(hit.y).toBeLessThanOrEqual(radar.y - 12 + 1e-6);
    const bottom = edgePointer(800, 5000, W, H, ins, radar)!;
    expect(bottom.y).toBeCloseTo(700, 6);
    expect(bottom.x).toBeLessThanOrEqual(radar.x - 12 + 1e-6);
    expect(edgePointer(5000, 400, 50, 50, ins)).toBeNull(); // degenerate screen
    expect(edgePointer(NaN, 400, W, H, ins)).toBeNull();
  });

  it('countdown: whole-second wire values drain smoothly between steps, resync on every change, never overshoot', () => {
    const c = new Countdown();
    expect(c.read(20, 10)).toBe(20); // a drop: 20 s left right now
    expect(c.read(20, 10.25)).toBeCloseTo(19.75, 6);
    expect(c.read(20, 10.9)).toBeCloseTo(19.1, 6);
    expect(c.read(20, 12)).toBe(19); // a late snapshot: held at value − 1, never below
    expect(c.read(19, 12.1)).toBe(19); // the step arrives: resync
    expect(c.read(19, 12.6)).toBeCloseTo(18.5, 6);
    expect(c.read(60, 13)).toBe(60); // jump up (a relocation) resyncs as well
    expect(c.read(0, 14)).toBe(0);
    expect(c.read(-2, 14)).toBe(0);
    expect(c.read(NaN, 14)).toBe(0);
    expect(c.read(6.4, 15)).toBe(6.4); // fractional input (render demo / finer wire) passes through
    expect(c.read(6.4, 16)).toBe(6.4);
    const d = new Countdown();
    expect(d.read(5, 10)).toBe(5);
    expect(d.read(5, 3)).toBe(5); // time going backwards (a new session) resyncs instead of growing
    expect(d.read(5, 3.5)).toBeCloseTo(4.5, 6);
  });
});

describe('objective layer: CTF', () => {
  let layer: ObjectiveLayer, batch: ReturnType<typeof fakeBatch>;
  beforeEach(() => { batch = fakeBatch(); layer = new ObjectiveLayer(A, batch.b); layer.setMap(mapWith(STANDS)); });
  const ctf = (flags: NonNullable<ObjectiveView['flags']>): ObjectiveView => ({ mode: 'ctf', limit: 3, overtime: false, suddenDeath: false, flags });
  const home = (team: number) => ({ team, s: 0 as const, x: STANDS[team].x, y: STANDS[team].y, carrierId: 0, returnIn: 0 });
  const clothFills = (calls: Call[], color: number) => fills(calls).filter((s) => s.color === color && Math.abs(s.alpha - 0.55) < 0.06);

  it('home flags wave on their stand; a dropped flag lies with a return ring = returnIn / CTF_RETURN_SEC; carried ones leave an empty socket', () => {
    const v = ctf([home(0), { team: 1, s: 1, x: 50, y: 60, carrierId: 5, returnIn: 0 }, { team: 2, s: 2, x: 500, y: 500, carrierId: 0, returnIn: 10 }, home(3)]);
    const { host } = mkHost({ 5: anchor({ x: 50, y: 60 }) });
    const out = run(layer, frame(v, [ship({}), ship({ id: 5, playerId: 5, team: 2, x: 50, y: 60, flags: SHIPFLAG_CARRIER })]), 0.5, host, batch);
    expect(clothFills(out.add, TEAM_COLORS[0]).length).toBe(1);
    expect(clothFills(out.add, TEAM_COLORS[3]).length).toBe(1);
    expect(clothFills(out.add, TEAM_COLORS[2]).length).toBe(1); // lying on the floor
    expect(clothFills(out.add, TEAM_COLORS[1]).length).toBe(0); // not at its stand ...
    expect(clothFills(out.car, TEAM_COLORS[1]).length).toBe(1); // ... it trails the carrier
    const ret = arcs(out.add).filter((a) => a[2] === RETURN_R);
    expect(ret.length).toBe(1);
    expect(ret[0][4] - ret[0][3]).toBeCloseTo(returnFrac(10) * TAU, 6);
    expect(ret[0][0]).toBe(500);
    // the empty socket at Azure's stand
    expect(out.add.some((c) => c.op === 'circle' && c.args[0] === STANDS[1].x && c.args[2] === STAND_R * 0.45)).toBe(true);
  });

  it('the return ring drains smoothly from the whole-second wire value (view.ts sends ceil seconds)', () => {
    const drop = (returnIn: number) => ctf([home(0), home(1), { team: 2, s: 2, x: 500, y: 500, carrierId: 0, returnIn }, home(3)]);
    const span = (t: number, returnIn: number) => {
      const out = run(layer, frame(drop(returnIn)), t, mkHost().host, batch);
      const a = arcs(out.add).find((q) => q[2] === RETURN_R)!;
      return a[4] - a[3];
    };
    expect(span(4, 20)).toBeCloseTo(returnFrac(20) * TAU, 6); // just dropped
    expect(span(4.5, 20)).toBeCloseTo(returnFrac(19.5) * TAU, 6); // same wire value, half a second later
    expect(span(5.02, 19)).toBeCloseTo(returnFrac(19) * TAU, 6); // the 1 s step resyncs
    layer.setMap(mapWith(STANDS)); // setMap drops the clocks
    expect(span(9, 19)).toBeCloseTo(returnFrac(19) * TAU, 6);
  });

  it('carrier glow in the carried flag colour; root-alpha rule (none for a faint non-ally) while the pennant stays', () => {
    const v = ctf([home(0), { team: 1, s: 1, x: 50, y: 60, carrierId: 5, returnIn: 0 }]);
    const ships = [ship({}), ship({ id: 5, playerId: 5, team: 2, x: 50, y: 60, flags: SHIPFLAG_CARRIER })];
    const glowAt = (o: { puts: typeof batch.puts }) => o.puts.filter((p) => p.tex === 'soft' && p.x === 50 && p.y === 60);
    const vis = run(layer, frame(v, ships), 0.2, mkHost({ 5: anchor({ x: 50, y: 60 }) }).host, batch);
    expect(glowAt(vis).length).toBe(1);
    expect(glowAt(vis)[0].color).toBe(TEAM_COLORS[1]);
    const hidden = run(layer, frame(v, ships), 0.2, mkHost({ 5: anchor({ x: 50, y: 60, alpha: 0.15, cloaked: true }) }).host, batch);
    expect(glowAt(hidden).length).toBe(0);
    expect(clothFills(hidden.car, TEAM_COLORS[1]).length).toBe(1); // objective info: the flag's position is public
    const ally = run(layer, frame(v, ships), 0.2, mkHost({ 5: anchor({ x: 50, y: 60, alpha: 0.3, ally: true }) }).host, batch);
    expect(glowAt(ally)[0].alpha).toBeLessThanOrEqual(0.3 + 1e-9);
    for (const s of strokes(ally.car).filter((q) => q.color === TEAM_COLORS[1] && q.width === 2)) expect(s.alpha).toBeLessThanOrEqual(0.3 + 1e-9);
    // a carrier bit with no flag view still glows (gold fallback)
    const orphan = run(layer, frame(ctf([home(0)]), ships), 0.2, mkHost({ 5: anchor({ x: 50, y: 60 }) }).host, batch);
    expect(glowAt(orphan).length).toBe(1);
  });

  it('your stand pulses when you carry and your flag is home (capture possible) — not while your flag is away', () => {
    const carryHome = ctf([home(0), home(1), home(2), { team: 3, s: 1, x: 0, y: 0, carrierId: 1, returnIn: 0 }]);
    const ringW = (v: ObjectiveView) => {
      const out = run(layer, frame(v, [ship({ flags: SHIPFLAG_CARRIER })]), 0, mkHost({ 1: anchor({ ally: true }) }).host, batch);
      return Math.max(...strokes(out.add).filter((s) => s.color === TEAM_COLORS[0]).map((s) => s.width ?? 0));
    };
    expect(ringW(carryHome)).toBeCloseTo(10, 6); // the wide hint halo
    const away = ctf([{ team: 0, s: 2, x: 900, y: 900, carrierId: 0, returnIn: 12 }, home(1), home(2), { team: 3, s: 1, x: 0, y: 0, carrierId: 1, returnIn: 0 }]);
    expect(ringW(away)).toBeLessThan(10);
  });

  it('a map without stand features falls back to the home flag positions', () => {
    layer.setMap(mapWith(undefined));
    const out = run(layer, frame(ctf([home(0), home(1)])), 0, mkHost().host, batch);
    expect(clothFills(out.add, TEAM_COLORS[0]).length).toBe(1);
    expect(clothFills(out.add, TEAM_COLORS[1]).length).toBe(1);
  });
});

describe('objective layer: Control Zones', () => {
  let layer: ObjectiveLayer, batch: ReturnType<typeof fakeBatch>;
  beforeEach(() => { batch = fakeBatch(); layer = new ObjectiveLayer(A, batch.b); layer.setMap(mapWith(ZONES)); });
  const zonesView = (zones: ZoneV[]): ObjectiveView => ({ mode: 'zones', limit: 300, overtime: false, suddenDeath: false, zones });

  it('letters, capper arc ∝ progress, decap shrinks the owner ring, swarm marker only where blocked, contested flicker', () => {
    const v = zonesView([
      zone({ i: 0, owner: 1, cap: 2, p: 35, contested: true }),
      zone({ i: 1, owner: 0 }),
      zone({ i: 2, cap: 2, p: 50 }),
      zone({ i: 3, owner: 1, cap: 3, p: 25 }),
      zone({ i: 4, swarm: true }),
    ]);
    const h = mkHost();
    const out = run(layer, frame(v), 0, h.host, batch);
    expect(h.labels.map((l) => [l.key, l.text])).toEqual([['z:0', 'CORE'], ['z:1', 'A'], ['z:2', 'B'], ['z:3', 'C'], ['z:4', 'D']]);
    expect(h.labels.every((l) => l.space === 'world')).toBe(true);
    const at = (i: number, r: number) => arcs(out.add).filter((a) => a[0] === ZONES[i].x && a[2] === r);
    // B: neutral capture at 50 % → half-circle capper arc at R - 12
    expect(at(2, 188).length).toBe(1);
    expect(at(2, 188)[0][4] - at(2, 188)[0][3]).toBeCloseTo(Math.PI, 6);
    // C: decap 25 % → capper arc 0.25 turn, owner ring keeps the other 0.75 turn
    expect(at(3, 188)[0][4] - at(3, 188)[0][3]).toBeCloseTo(0.25 * TAU, 6);
    expect(at(3, 200)[0][4] - at(3, 200)[0][3]).toBeCloseTo(0.75 * TAU, 6);
    // D only: hazard ticks + warning triangle in the enemy colour
    expect(strokes(out.add).filter((s) => s.color === ENEMY_COLOR).length).toBeGreaterThanOrEqual(2);
    const noSwarm = run(layer, frame(zonesView([zone({ i: 4 })])), 0, mkHost().host, batch);
    expect(strokes(noSwarm.add).some((s) => s.color === ENEMY_COLOR)).toBe(false);
    // Core contested: white ring at t = 0 (flicker on), owner colour at t = 0.13
    expect(strokes(out.add).some((s) => s.color === 0xffffff && s.width === 3)).toBe(true);
    // A: owned → fill in the owner colour, glow sprite in the owner colour
    expect(fills(out.pad).some((s) => s.color === TEAM_COLORS[0])).toBe(true);
    expect(out.puts.some((p) => p.tex === 'soft' && p.x === ZONES[1].x && p.color === TEAM_COLORS[0])).toBe(true);
  });

  it('inactive pads are dimmed; nothing is drawn (no labels) for zones outside the view', () => {
    const dim = run(layer, frame(zonesView([zone({ i: 1, owner: 0, active: false })])), 0, mkHost().host, batch);
    const bright = run(layer, frame(zonesView([zone({ i: 1, owner: 0 })])), 0, mkHost().host, batch);
    const ringA = (o: typeof dim) => strokes(o.add).filter((s) => s.color === TEAM_COLORS[0] && s.width === 3)[0].alpha;
    expect(ringA(dim)).toBeCloseTo(ringA(bright) * 0.35, 6);
    const h = mkHost({}, { inView: () => false });
    const none = run(layer, frame(zonesView([zone({ i: 1, owner: 0 })])), 0, h.host, batch);
    expect(none.add.length + none.pad.length).toBe(0);
    expect(h.labels.length).toBe(0);
  });
});

describe('objective layer: Hot Point', () => {
  let layer: ObjectiveLayer, batch: ReturnType<typeof fakeBatch>;
  beforeEach(() => { batch = fakeBatch(); layer = new ObjectiveLayer(A, batch.b); layer.setMap(mapWith(SITES)); beamBus.hotArmSeq = 0; });
  const hotView = (hot: NonNullable<ObjectiveView['hot']>, z: Partial<ZoneV> = {}): ObjectiveView =>
    ({ mode: 'hotpoint', limit: 200, overtime: false, suddenDeath: false, hot, zones: [zone({ i: hot.site, ...z })] });

  it('beam in the owner colour; faint candidates; no ghost until the next site is picked', () => {
    const h = mkHost();
    const out = run(layer, frame(hotView({ site: 0, next: -1, moveIn: 40, armIn: 0 }, { owner: 2 })), 0, h.host, batch);
    const beam = out.puts.filter((p) => p.tex === 'beam');
    expect(beam.length).toBe(1);
    expect(beam[0]).toMatchObject({ x: SITES[0].x, y: SITES[0].y - HOT_BEAM_H / 2, color: TEAM_COLORS[2] });
    expect(arcs(out.add).filter((a) => a[2] === 240 * 0.3).length).toBe(7 * 8); // 7 candidates × 8 dashes
    expect(h.labels.map((l) => l.text)).toEqual(['HOT']);
  });

  it('warn: countdown label, next-site ghost + label, guide line; arming: arm-up arc', () => {
    const h = mkHost();
    const out = run(layer, frame(hotView({ site: 0, next: 3, moveIn: 6.4, armIn: 0 })), 0, h.host, batch);
    expect(h.labels.find((l) => l.key === 'hot')!.text).toBe('MOVE 7');
    const nx = h.labels.find((l) => l.key === 'hotNext')!;
    expect(nx).toMatchObject({ text: 'NEXT 7', x: SITES[3].x, y: SITES[3].y });
    expect(out.puts.filter((p) => p.tex === 'beam').length).toBe(2); // live beam + the ghost beam
    expect(arcs(out.add).filter((a) => a[2] === 240 * 0.3).length).toBe(6 * 8); // the next site is no longer a faint candidate
    const cd = arcs(out.add).filter((a) => a[0] === SITES[0].x && a[2] === 240 + 28);
    expect(cd[0][4] - cd[0][3]).toBeCloseTo((6.4 / HOT_WARN_SEC) * TAU, 6);
    const h2 = mkHost();
    const arm = run(layer, frame(hotView({ site: 3, next: -1, moveIn: 59, armIn: 1 }, { active: false })), 0, h2.host, batch);
    expect(h2.labels.find((l) => l.key === 'hot')!.text).toBe('ARMING');
    const aa = arcs(arm.add).filter((a) => a[0] === SITES[3].x && a[2] === 240 + 14);
    expect(aa[0][4] - aa[0][3]).toBeCloseTo((1 - 1 / HOT_ARM_SEC) * TAU, 6);
  });

  it('the armed pulse fires exactly once per arming completion (same site), never at match start', () => {
    const h = mkHost();
    const step = (hot: NonNullable<ObjectiveView['hot']>) => run(layer, frame(hotView(hot)), 0, h.host, batch);
    step({ site: 0, next: -1, moveIn: 50, armIn: 0 });
    step({ site: 0, next: -1, moveIn: 49, armIn: 0 });
    expect(beamBus.hotArmSeq).toBe(0);
    step({ site: 5, next: -1, moveIn: 60, armIn: 3 });
    step({ site: 5, next: -1, moveIn: 58, armIn: 1 });
    expect(beamBus.hotArmSeq).toBe(0);
    step({ site: 5, next: -1, moveIn: 57, armIn: 0 });
    expect(beamBus.hotArmSeq).toBe(1);
    expect(h.fx.some((c) => c.op === 'ring' && c.args[0] === SITES[5].x)).toBe(true);
    step({ site: 5, next: -1, moveIn: 56, armIn: 0 });
    expect(beamBus.hotArmSeq).toBe(1);
    // setMap resets the tracker: a fresh match with the first frame already armed does not pulse
    layer.setMap(mapWith(SITES));
    step({ site: 5, next: -1, moveIn: 56, armIn: 0 });
    expect(beamBus.hotArmSeq).toBe(1);
  });

  it('whole-second wire countdowns animate: the arm arc fills and the warn ring drains between steps', () => {
    const h = mkHost();
    const armSpan = (t: number, armIn: number) => {
      const out = run(layer, frame(hotView({ site: 3, next: -1, moveIn: 60, armIn }, { active: false })), t, h.host, batch);
      const a = arcs(out.add).filter((q) => q[0] === SITES[3].x && q[2] === 240 + 14);
      return a.length ? a[0][4] - a[0][3] : 0;
    };
    expect(armSpan(1, 3)).toBe(0); // arming just began: nothing filled yet
    expect(armSpan(1.5, 3)).toBeCloseTo((0.5 / HOT_ARM_SEC) * TAU, 6);
    expect(armSpan(2.02, 2)).toBeCloseTo((1 / HOT_ARM_SEC) * TAU, 6);
    const warnSpan = (t: number, moveIn: number) => {
      const out = run(layer, frame(hotView({ site: 0, next: 3, moveIn, armIn: 0 })), t, h.host, batch);
      const a = arcs(out.add).filter((q) => q[0] === SITES[0].x && q[2] === 240 + 28);
      return a[0][4] - a[0][3];
    };
    expect(warnSpan(10, HOT_WARN_SEC)).toBeCloseTo(TAU, 6);
    expect(warnSpan(10.25, HOT_WARN_SEC)).toBeCloseTo(((HOT_WARN_SEC - 0.25) / HOT_WARN_SEC) * TAU, 6);
  });

  it('overtime pauses the move: the pad reads OVERTIME, no countdown ring, guide line or next-site ghost', () => {
    const h = mkHost();
    const v: ObjectiveView = { ...hotView({ site: 0, next: 3, moveIn: 0, armIn: 0 }, { owner: 1, cap: 2, p: 30, contested: true }), overtime: true };
    const out = run(layer, frame(v), 0, h.host, batch);
    expect(h.labels.find((l) => l.key === 'hot')!.text).toBe('OVERTIME');
    expect(h.labels.find((l) => l.key === 'hotNext')).toBeUndefined(); // no move comes: no ghost of the next site
    expect(arcs(out.add).some((a) => a[0] === SITES[0].x && a[2] === 240 + 28)).toBe(false);
    // no dashed guide segments between the live pad and the ghost (all guide strokes have alpha 0.14)
    const guide = (calls: Call[]) => strokes(calls).some((s) => s.color === 0xffffff && Math.abs(s.alpha - 0.14) < 1e-9);
    expect(guide(out.add)).toBe(false);
    const live = run(layer, frame({ ...v, overtime: false, hot: { site: 0, next: 3, moveIn: 4, armIn: 0 } }), 0, mkHost().host, batch);
    expect(guide(live.add)).toBe(true); // control: the same warn state outside overtime draws it
  });
});

describe('objective layer: edge pointers', () => {
  let layer: ObjectiveLayer, batch: ReturnType<typeof fakeBatch>;
  beforeEach(() => { batch = fakeBatch(); layer = new ObjectiveLayer(A, batch.b); });
  const draw = (v: ObjectiveView, ships: ShipView[] = [ship({})], hostShips: Record<number, ObjShip> = {}, over: Partial<ObjectiveHost> = {}) => {
    const h = mkHost(hostShips, over), g = fakeGraphics(), f = frame(v, ships);
    layer.begin(f);
    const n = layer.drawPointers(f, 0, g.g, h.host);
    return { n, targets: layer.pointerTargets(f, h.host), calls: g.calls, labels: h.labels };
  };

  it('CTF: enemy flags always, your flag only when away (urgent when carried), your stand when you carry', () => {
    layer.setMap(mapWith(STANDS)); // all stands at y = 1000: off the 1000×800 test screen
    const home = (team: number) => ({ team, s: 0 as const, x: STANDS[team].x, y: STANDS[team].y, carrierId: 0, returnIn: 0 });
    const v: ObjectiveView = { mode: 'ctf', limit: 3, overtime: false, suddenDeath: false, flags: [home(0), home(1), home(2), home(3)] };
    const a = draw(v);
    expect(a.targets.map((p) => p.color)).toEqual([TEAM_COLORS[1], TEAM_COLORS[2], TEAM_COLORS[3]]);
    expect(a.n).toBe(3);
    const stolen = draw({ ...v, flags: [{ team: 0, s: 1, x: 3000, y: 3000, carrierId: 9, returnIn: 0 }, home(1)] },
      [ship({}), ship({ id: 9, playerId: 9, team: 1 })], { 9: anchor({ x: 4000, y: 4000 }) });
    const mine = stolen.targets.find((p) => p.color === TEAM_COLORS[0])!;
    expect(mine).toMatchObject({ urgent: true, x: 4000, y: 4000 }); // follows the carrier's display position
    const carrying = draw({ ...v, flags: [home(0), { team: 1, s: 1, x: 0, y: 0, carrierId: 1, returnIn: 0 }] });
    expect(carrying.targets[0]).toMatchObject({ glyph: 'home', urgent: true, x: STANDS[0].x });
    expect(carrying.targets.some((p) => p.color === TEAM_COLORS[1])).toBe(false); // not at yourself
  });

  it('zones: every zone (quiet owned ones dimmed, threatened ones urgent); on-screen objectives get none', () => {
    layer.setMap(mapWith(ZONES));
    const v: ObjectiveView = { mode: 'zones', limit: 300, overtime: false, suddenDeath: false, zones: [zone({ i: 1, owner: 0 }), zone({ i: 2, owner: 0, cap: 1, p: 30 }), zone({ i: 3, contested: true })] };
    const d = draw(v);
    expect(d.targets.length).toBe(5);
    expect(d.targets.find((p) => p.x === ZONES[1].x)!.alpha).toBeCloseTo(0.45, 6);
    expect(d.targets.find((p) => p.x === ZONES[2].x)!.urgent).toBe(true);
    expect(d.targets.find((p) => p.x === ZONES[3].x)!.urgent).toBe(true);
    expect(d.targets[0].glyph).toBe('core');
    expect(d.labels.every((l) => l.space === 'screen')).toBe(true);
    expect(d.labels.map((l) => l.text).sort()).toEqual(['A', 'B', 'C', 'D']);
    const onScreen = draw(v, [ship({})], {}, { toScreen: (_x, _y, out) => { out.x = 500; out.y = 400; } });
    expect(onScreen.n).toBe(0);
    expect(onScreen.calls.length).toBe(0);
  });

  it('hot point: the active site and the next-site ghost; at most MAX_POINTERS', () => {
    layer.setMap(mapWith(SITES));
    const d = draw({ mode: 'hotpoint', limit: 200, overtime: false, suddenDeath: false, hot: { site: 2, next: 6, moveIn: 4, armIn: 0 }, zones: [zone({ i: 2, owner: 3 })] });
    expect(d.targets.map((p) => p.glyph)).toEqual(['hot', 'next']);
    expect(d.targets[0].color).toBe(TEAM_COLORS[3]);
    expect(d.targets[0].urgent).toBe(true); // warn phase
    const many: MapFeature[] = Array.from({ length: 14 }, (_, i) => ({ kind: 'zone', team: -1, index: i, x: -1000 - i * 100, y: 400, radius: 200 }));
    layer.setMap(mapWith(many));
    expect(draw({ mode: 'zones', limit: 300, overtime: false, suddenDeath: false, zones: [] }).n).toBe(MAX_POINTERS);
  });

  it('pointers keep clear of the HUD insets', () => {
    expect(EDGE_INSETS.t).toBeGreaterThanOrEqual(64);
    expect(EDGE_INSETS.b).toBeGreaterThanOrEqual(96);
  });
});

describe('objective layer: radar + events + setMap', () => {
  let layer: ObjectiveLayer, batch: ReturnType<typeof fakeBatch>;
  beforeEach(() => { batch = fakeBatch(); layer = new ObjectiveLayer(A, batch.b); });

  it('radar: stand icons (filled when home), carried flag diamond at the carrier, zone discs + swarm dot, hot site ring', () => {
    layer.setMap(mapWith(STANDS));
    const f = frame({ mode: 'ctf', limit: 3, overtime: false, suddenDeath: false, flags: [
      { team: 0, s: 0, x: STANDS[0].x, y: STANDS[0].y, carrierId: 0, returnIn: 0 },
      { team: 1, s: 1, x: 10, y: 10, carrierId: 9, returnIn: 0 },
    ] });
    layer.begin(f);
    const g = fakeGraphics();
    layer.drawRadar(f, g.g, 0, 0, 0.1, 0.1, false, 0, mkHost({ 9: anchor({ x: 3000, y: 2000 }) }).host);
    expect(fills(g.calls).filter((s) => s.color === TEAM_COLORS[0]).length).toBe(1); // home: filled pennant
    expect(g.calls.some((c) => c.op === 'moveTo' && c.args[0] === 300 && c.args[1] === 200 - 3.4)).toBe(true); // diamond at the carrier
    layer.setMap(mapWith(ZONES));
    const fz = frame({ mode: 'zones', limit: 300, overtime: false, suddenDeath: false, zones: [zone({ i: 0, owner: 2 }), zone({ i: 4, swarm: true })] });
    layer.begin(fz);
    const gz = fakeGraphics();
    layer.drawRadar(fz, gz.g, 0, 0, 0.1, 0.1, true, 0, mkHost().host);
    expect(gz.calls.filter((c) => c.op === 'circle' && (c.args[2] as number) >= 20).length).toBe(5 + 1); // 5 rings + Core's fill
    expect(fills(gz.calls).some((s) => s.color === ENEMY_COLOR)).toBe(true);
    expect(arcs(gz.calls).length).toBe(0); // no capper
  });

  it('events: returned at the stand, captured tints in the capturer colour, hot captures resolve the site', () => {
    layer.setMap(mapWith(STANDS));
    const ev = (kind: string, o: Partial<Extract<GameEvent, { t: 'objective' }>> = {}): GameEvent =>
      ({ t: 'objective', kind, team: 0, playerId: 1, index: 2, x: 7, y: 7, value: 0, ...o }) as GameEvent;
    const h = mkHost();
    layer.event(ev('flagReturned'), h.host);
    expect(h.fx.filter((c) => c.op === 'ring').every((c) => c.args[0] === STANDS[2].x && c.args[1] === STANDS[2].y)).toBe(true);
    const cap = mkHost();
    layer.event(ev('flagCaptured', { team: 3 }), cap.host);
    expect(cap.fx.find((c) => c.op === 'tint')!.args[0]).toBe(TEAM_COLORS[3]);
    layer.setMap(mapWith(SITES));
    const hot = mkHost();
    layer.event(ev('zoneCaptured', { index: 6, team: 1 }), hot.host);
    expect(hot.fx.find((c) => c.op === 'ring')!.args[0]).toBe(SITES[6].x);
    const none = mkHost();
    layer.event({ t: 'waveStart', wave: 1, boss: false }, none.host);
    expect(none.fx.length).toBe(0);
    for (const k of ['flagTaken', 'flagDropped', 'zoneNeutralized', 'hotWarn', 'hotMoved', 'overtime', 'suddenDeath']) {
      const q = mkHost();
      layer.event(ev(k), q.host);
      expect(q.fx.length).toBeGreaterThan(0);
    }
  });

  it('setMap is re-entrant: features are rebuilt; a deathmatch map / null objective draws nothing', () => {
    layer.setMap(mapWith([...STANDS]));
    expect(layer.featureCounts).toEqual({ stands: 4, zones: 0, sites: 0 });
    layer.setMap(mapWith([...ZONES, ...SITES]));
    expect(layer.featureCounts).toEqual({ stands: 0, zones: 5, sites: 8 });
    layer.setMap(mapWith(undefined));
    expect(layer.featureCounts).toEqual({ stands: 0, zones: 0, sites: 0 });
    const h = mkHost();
    const out = run(layer, frame(undefined), 0, h.host, batch);
    expect(out.add.length + out.pad.length + out.car.length + out.puts.length + h.labels.length).toBe(0);
    const g = fakeGraphics();
    expect(layer.drawPointers(frame(undefined), 0, g.g, h.host)).toBe(0);
    layer.drawRadar(frame(undefined), g.g, 0, 0, 1, 1, false, 0, h.host);
    expect(g.calls.length).toBe(0);
  });
});

describe('edge pointer insets follow the DOM HUD (client/hudInsets)', () => {
  it('pushes pointers past the measured top strip and bottom panel, never below the minimums; shrinks on short views', () => {
    expect(pointerInsets(1280, 720, { top: 0, bottom: 0 })).toEqual(EDGE_INSETS);
    // the verifier's 8-team Zones strip reached y 111 at 1280×720; the skill panel starts at y ≈ 584
    const ins = pointerInsets(1280, 720, { top: 111, bottom: 720 - 584 });
    expect(ins.t).toBeGreaterThanOrEqual(111 + 12); // the arrow tip (12 px outward) clears the strip
    expect(720 - ins.b).toBeLessThanOrEqual(584 - 12);
    // a top pointer now lands below the strip
    const e = edgePointer(640, -500, 1280, 720, ins)!;
    expect(e.y - 12).toBeGreaterThan(111);
    // tiny view: still a usable band
    const short = pointerInsets(640, 300, { top: 200, bottom: 200 });
    expect(300 - short.t - short.b).toBeGreaterThanOrEqual(119);
  });
});
