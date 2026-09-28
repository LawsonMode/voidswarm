// RENDER v0.3 M3 acceptance: the objective layer against the REAL sim/objectives module and real bots.
// Each objective combo runs a seeded bot match (Sim + ai/bots, no Room), and every few ticks the layer renders
// the genuine MatchView.objective (sim/objectives/view.ts) plus the ship flags into fake Graphics. Checks the
// render seams: map.features → stands / pads / sites, every ObjectiveView entry resolves to a feature, carried
// flags sit on a SHIPFLAG_CARRIER ship and get the glow + trailing pennant, dropped flags get the return ring,
// every objective event's index names a feature of the right kind, and nothing the layer emits is NaN.
// Everything here is deterministic (seeded sim, seeded bots), so coverage expectations are stable.
import { describe, expect, it } from 'vitest';
import type { RenderFrame } from '../contracts';
import { TICK_RATE } from '../../shared/constants';
import { createBotBrain, type BotBrain } from '../../shared/ai/bots';
import { buildObjectiveView } from '../../shared/sim/objectives/index';
import { zoneCount } from '../../shared/sim/objectives/rules';
import { Sim } from '../../shared/sim/Sim';
import {
  SHIPFLAG_CARRIER,
  type GameEvent, type MapFeatureKind, type ShipClassId, type ShipView, type SimConfig,
} from '../../shared/types';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import { ObjectiveLayer, RETURN_R, teamColor, type ObjShip, type ObjectiveHost } from './objectives';

type Combo = Pick<SimConfig, 'gameType' | 'subMode' | 'mode' | 'teamCount' | 'pveIntensity'> & { name: string };
const COMBOS: Combo[] = [
  { name: 'Arena CTF 2 teams', gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, pveIntensity: 0 },
  { name: 'Arena Zones 3 teams', gameType: 'arena', subMode: 'zones', mode: 'teams', teamCount: 3, pveIntensity: 0 },
  { name: 'Arena Hot Point 2 teams', gameType: 'arena', subMode: 'hotpoint', mode: 'teams', teamCount: 2, pveIntensity: 0 },
  { name: 'Arena Hot Point FFA', gameType: 'arena', subMode: 'hotpoint', mode: 'ffa', teamCount: 0, pveIntensity: 0 },
  { name: 'Warzone Zones 2 teams', gameType: 'warzone', subMode: 'zones', mode: 'teams', teamCount: 2, pveIntensity: 2 },
];
const BOTS = 10;
/** Sim seconds per combo: past the first Hot Point relocation (warn at 50 s, move at 60 s, armed at 63 s). */
const SECONDS = 75;
const RENDER_EVERY = 6;

// ---------- fakes (recording, NaN-checking)
type Call = { op: string; args: unknown[] };
function fakeGraphics(bad: string[]) {
  const calls: Call[] = [];
  const g: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ['circle', 'poly', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill', 'rect', 'closePath']) {
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

function shipViews(sim: Sim): ShipView[] {
  const out: ShipView[] = [];
  for (const s of sim.world.ships.values()) {
    out.push({
      id: s.id, playerId: s.playerId, team: s.team, shipClass: s.shipClass, x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle,
      energyFrac: 1, alive: s.alive, attachedTo: s.attachedTo, turretSlot: -1, turretCount: 0, flags: s.flags, level: 1,
      orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1,
    });
  }
  return out;
}

interface Seen {
  frames: number; flagStates: Set<number>; carrierGlow: number; returnRings: number; pointers: number;
  zoneLabels: Set<string>; hotLabels: Set<string>; events: Map<string, number>; bad: string[];
}

function play(c: Combo): { seen: Seen; layer: ObjectiveLayer; sim: Sim } {
  const cfg: SimConfig = { mapSeed: 1357, matchSeconds: 600, scoreLimit: 0, friendlyFire: false, ...c };
  const sim = new Sim(cfg);
  const w = sim.world;
  const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
  const teams = c.mode === 'teams' ? c.teamCount : 1;
  const brains = new Map<number, BotBrain>();
  for (let i = 1; i <= BOTS; i++) {
    sim.addPlayer({ playerId: i, name: 'bot' + i, team: c.mode === 'teams' ? i % teams : -1, shipClass: cls[i % 3], isBot: true });
    brains.set(i, createBotBrain('normal', 1000 + i));
  }
  const batch = fakeBatch();
  const layer = new ObjectiveLayer(A, batch.b);
  layer.setMap(w.map);
  const seen: Seen = {
    frames: 0, flagStates: new Set(), carrierGlow: 0, returnRings: 0, pointers: 0,
    zoneLabels: new Set(), hotLabels: new Set(), events: new Map(), bad: [],
  };
  const featureOk = (kind: MapFeatureKind, index: number) => (w.map.features ?? []).some((f) => f.kind === kind && f.index === index);
  const shipsNow = new Map<number, ObjShip>();
  /** Camera: follows bot 1 (the viewer) at 0.6 zoom on a 1280×720 screen, like a pilot's view. */
  const cam = { x: w.map.width / 2, y: w.map.height / 2 };
  const labels: { key: string; text: string }[] = [];
  const host: ObjectiveHost = {
    inView: () => true,
    ship: (id) => shipsNow.get(id) ?? null,
    toScreen: (x, y, out) => { out.x = (x - cam.x) * 0.6 + 640; out.y = (y - cam.y) * 0.6 + 360; },
    screenW: () => 1280, screenH: () => 720,
    avoidRect: () => ({ x: 1050, y: 490, w: 220, h: 220 }),
    label: (key, _space, text) => { labels.push({ key, text }); },
    ring: () => {}, burst: () => {}, flash: () => {}, impulse: () => {}, tint: () => {},
  };

  for (let k = 0; k < TICK_RATE * SECONDS; k++) {
    for (const [pid, brain] of brains) {
      const sid = w.shipsByPlayer.get(pid);
      const ship = sid ? w.ships.get(sid) : undefined;
      if (!ship) continue;
      sim.setInput(pid, brain.think(w, ship));
      if (ship.offers.length && k % 30 === pid % 30) sim.chooseUpgrade(pid, Math.max(0, brain.chooseUpgrade(w, ship, ship.offers[0]) | 0), undefined);
    }
    sim.step();
    const evs: GameEvent[] = sim.drainEvents();
    for (const ev of evs) {
      if (ev.t !== 'objective') continue;
      seen.events.set(ev.kind, (seen.events.get(ev.kind) ?? 0) + 1);
      // the layer places event FX by ev.index: it must name a feature of the right kind
      const ok = ev.kind.startsWith('flag') ? featureOk('flagStand', ev.index)
        : ev.kind.startsWith('zone') ? featureOk(c.subMode === 'hotpoint' ? 'hotSite' : 'zone', ev.index)
        : ev.kind.startsWith('hot') ? featureOk('hotSite', ev.index) : true;
      if (!ok && seen.bad.length < 10) seen.bad.push(`event ${ev.kind} index ${ev.index} names no feature`);
    }
    if (k % RENDER_EVERY !== 0) continue;

    const view = buildObjectiveView(w);
    const ships = shipViews(sim);
    shipsNow.clear();
    for (const s of ships) if (s.alive) shipsNow.set(s.id, { x: s.x, y: s.y, r: 20, vx: s.vx, vy: s.vy, alpha: 1, ally: false, cloaked: false });
    const localShipId = w.shipsByPlayer.get(1) ?? 0;
    const me = shipsNow.get(localShipId);
    if (me) { cam.x = me.x; cam.y = me.y; }
    const frame: RenderFrame = {
      time: k / TICK_RATE, dt: RENDER_EVERY / TICK_RATE, renderTick: k, localPlayerId: 1, localShipId, focusX: 0, focusY: 0, ships,
      enemies: [], projectiles: [], gems: [], deployables: [], events: evs, you: null, players: new Map(), aimX: 0, aimY: 0, attachCandidateId: 0,
      match: {
        phase: w.match.phase, mode: cfg.mode, teamCount: cfg.teamCount, timeLeftSec: 0, teamScores: [...w.match.teamScores], wave: 0,
        winnerTeam: -1, winnerPlayerId: 0, objective: view,
      },
    };
    const pad = fakeGraphics(seen.bad), add = fakeGraphics(seen.bad), car = fakeGraphics(seen.bad), edge = fakeGraphics(seen.bad), radar = fakeGraphics(seen.bad);
    labels.length = 0;
    layer.begin(frame);
    layer.drawWorld(frame, frame.time, pad.g, add.g, host);
    layer.drawCarriers(frame, frame.time, car.g, host);
    layer.end();
    seen.pointers += layer.drawPointers(frame, frame.time, edge.g, host);
    layer.drawRadar(frame, radar.g, 10, 10, 200 / w.map.width, 200 / w.map.height, false, frame.time, host);
    for (const ev of evs) layer.event(ev, host);
    seen.frames++;
    for (const p of batch.puts) if (!Number.isFinite(p.x + p.y + p.alpha) && seen.bad.length < 10) seen.bad.push(`glow put ${JSON.stringify(p)}`);

    if (view?.flags) {
      for (const fv of view.flags) {
        seen.flagStates.add(fv.s);
        if (fv.s === 1) {
          const carrier = ships.find((s) => s.id === fv.carrierId);
          if (!carrier || !(carrier.flags & SHIPFLAG_CARRIER)) seen.bad.push(`flag ${fv.team} carried by ${fv.carrierId} without SHIPFLAG_CARRIER`);
          else if (batch.puts.some((p) => p.tex === 'soft' && p.x === carrier.x && p.y === carrier.y && p.color === teamColor(fv.team))) seen.carrierGlow++;
          else seen.bad.push(`no carrier glow for flag ${fv.team} on ship ${carrier.id}`);
        } else if (fv.s === 2) {
          if (add.calls.some((q) => q.op === 'arc' && q.args[0] === fv.x && q.args[1] === fv.y && q.args[2] === RETURN_R)) seen.returnRings++;
          else if (fv.returnIn > 0) seen.bad.push(`dropped flag ${fv.team} (returnIn ${fv.returnIn}) has no return ring`);
        }
      }
    }
    if (view?.zones && view.mode === 'zones') {
      for (const z of view.zones) {
        if (!featureOk('zone', z.i)) seen.bad.push(`zone view ${z.i} has no feature`);
        const l = labels.find((q) => q.key === 'z:' + z.i);
        if (!l) seen.bad.push(`zone ${z.i} drew no label`); else seen.zoneLabels.add(l.text);
      }
    }
    if (view?.hot) {
      if (!featureOk('hotSite', view.hot.site)) seen.bad.push(`hot site ${view.hot.site} has no feature`);
      const l = labels.find((q) => q.key === 'hot');
      if (!l) seen.bad.push('hot point drew no label'); else seen.hotLabels.add(l.text.replace(/\d+/g, 'n'));
      if (view.hot.next >= 0 && view.hot.next !== view.hot.site && !labels.some((q) => q.key === 'hotNext')) seen.bad.push('picked next site has no ghost label');
    }
  }
  return { seen, layer, sim };
}

describe('objective layer × real sim (bots, every combo)', () => {
  for (const c of COMBOS) {
    it(`${c.name}: features resolve, states render, events land on features, nothing NaN`, () => {
      const { seen, layer, sim } = play(c);
      expect(seen.bad).toEqual([]);
      expect(seen.frames).toBe(Math.ceil((TICK_RATE * SECONDS) / RENDER_EVERY));
      const fc = layer.featureCounts;
      if (c.subMode === 'ctf') {
        expect(fc).toEqual({ stands: c.teamCount, zones: 0, sites: 0 });
        expect(seen.flagStates.has(0)).toBe(true);
        // bots steal within 75 s at this seed: the carried look (glow + pennant) was exercised on real data
        expect(seen.events.get('flagTaken') ?? 0).toBeGreaterThan(0);
        expect(seen.flagStates.has(1)).toBe(true);
        expect(seen.carrierGlow).toBeGreaterThan(0);
        expect(seen.flagStates.has(2)).toBe(true); // ... and a carrier kill left a dropped flag with its return ring
        expect(seen.returnRings).toBeGreaterThan(0);
      } else if (c.subMode === 'zones') {
        const n = zoneCount(c.teamCount);
        expect(fc).toEqual({ stands: 0, zones: n, sites: 0 });
        expect([...seen.zoneLabels].sort()).toEqual(['CORE', 'A', 'B', 'C', 'D'].slice(0, n).sort());
        expect(seen.events.get('zoneCaptured') ?? 0).toBeGreaterThan(0); // owner fills rendered on real captures
      } else {
        expect(fc).toEqual({ stands: 0, zones: 0, sites: 8 });
        // the timers alone guarantee one warn + one move in 75 s: the telegraph states all rendered
        expect(seen.events.get('hotWarn')).toBe(1);
        expect(seen.events.get('hotMoved')).toBe(1);
        expect(seen.hotLabels.has('ARMING')).toBe(true);
        expect(seen.hotLabels.has('MOVE n')).toBe(true);
      }
      // a pilot's camera leaves objectives off-screen at some point → edge pointers drew
      expect(seen.pointers).toBeGreaterThan(0);
      expect(sim.world.objective).toBeTruthy();
    }, 60_000);
  }
});
