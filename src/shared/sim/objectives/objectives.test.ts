// OBJECTIVES v0.3 M3 acceptance (docs/v0.3-proposal.md §9 OBJECTIVES): map features (deterministic, reachable,
// stands off TILE_BASE), CTF (§5.3), Control Zones (§5.4, incl. the Warzone swarm block), Hot Point (§5.5, incl.
// FFA and overtime), per-player stats, personal score, objective loot rolls, the view, and teamScores that are
// never rebuilt from ship.score. Real Sim + PVE, no mocks.
import { describe, expect, it } from 'vitest';
import { SPAWN_INVULN_SEC, TICK_RATE } from '../../constants';
import type { GameEvent, GameMap, ObjectiveGameEvent, Ship, ShipClassId, SimConfig, SubMode } from '../../types';
import { emptyInput, SHIPFLAG_CARRIER, SHIPFLAG_CLOAKED, TILE_BASE, TILE_ROCK, TILE_WALL } from '../../types';
import { Rng } from '../../util/rng';
import { damageShip } from '../combat';
import { SHIP_CLASSES } from '../../data/ships';
import { collideCircle, generateMap, tileAt } from '../map';
import { buildMatchMap } from '../mapgen';
import { spawnEnemy } from '../pve/enemies';
import { Sim } from '../Sim';
import { baseCentres, placeObjectiveFeatures } from './features';
import {
  buildObjectiveView, isCarrier, objectiveAnchors, objectiveSpawnPoint, objMaxTurrets, objRechargeMult, objSpeedMult,
} from './index';
import {
  CTF_CARRIER_SPEED_MULT, CTF_REPICK_SEC, CTF_RETURN_SEC, CTF_SCORE, CTF_SUDDEN_DEATH_SEC, HOT_ARM_SEC, HOT_CAP_SEC,
  HOT_FFA_MAX_CENTRE_DIST, HOT_FFA_SPAWN_AVOID, HOT_MIN_BASE_DIST, HOT_MIN_MOVE_DIST, HOT_MOVE_SEC, HOT_OT_CAP_SEC,
  HOT_SITES, HOT_WARN_SEC, ZONE_CAP_SEC, ZONE_DECAY_DELAY_SEC, ZONE_POINT_SEC, ZONE_RADIUS, ZONE_RING_PX, ZONE_SCORE,
  ZONE_TIE_EXTEND_SEC, zoneCount,
} from './rules';
import { pickNextSite } from './zones';

const T = TICK_RATE;
const BORDER = 2;

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 1234, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0,
  friendlyFire: false, gameType: 'arena', subMode: 'ctf', ...o,
});
function add(sim: Sim, pid: number, cls: ShipClassId, team: number, isBot = true): Ship {
  return sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot }))!;
}
function steps(sim: Sim, n: number, before?: () => void): void {
  for (let i = 0; i < n; i++) { before?.(); sim.step(); }
}
function place(s: Ship, x: number, y: number): void { s.x = x; s.y = y; s.vx = 0; s.vy = 0; }
function settle(sim: Sim): void { steps(sim, SPAWN_INVULN_SEC * T + 5); }
/** Move a ship back onto one of its team's spawn points (far from every objective). */
function park(sim: Sim, s: Ship): void {
  const sp = sim.world.map.spawns.find((p) => p.team === s.team) ?? sim.world.map.spawns[0];
  place(s, sp.x, sp.y);
}
function objEvents(ev: GameEvent[], kind?: ObjectiveGameEvent['kind']): ObjectiveGameEvent[] {
  return ev.filter((e): e is ObjectiveGameEvent => e.t === 'objective' && (!kind || e.kind === kind));
}
function kill(sim: Sim, victim: Ship, killer: Ship): void {
  victim.invulnUntilTick = 0;
  damageShip(sim.world, victim, 1e6, killer.id, 'player');
}

/** Open tiles reachable (4-neighbour) from the map centre. */
function reachable(map: GameMap): Uint8Array {
  const seen = new Uint8Array(map.tiles.length);
  const start = Math.floor(map.rows / 2) * map.cols + Math.floor(map.cols / 2);
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop()!;
    const c = i % map.cols, r = (i - c) / map.cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      const t = tileAt(map, nc, nr);
      const j = nr * map.cols + nc;
      if (t === TILE_WALL || t === TILE_ROCK || seen[j]) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return seen;
}
const tIdx = (m: GameMap, x: number, y: number) => Math.floor(y / m.tileSize) * m.cols + Math.floor(x / m.tileSize);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// =============================================================================================
describe('map features (§5.1) via buildMatchMap', () => {
  const combos: { gameType: 'arena' | 'warzone'; subMode: SubMode; teamCount: number }[] = [
    { gameType: 'arena', subMode: 'ctf', teamCount: 2 },
    { gameType: 'arena', subMode: 'ctf', teamCount: 3 },
    { gameType: 'arena', subMode: 'ctf', teamCount: 4 },
    { gameType: 'arena', subMode: 'zones', teamCount: 2 },
    { gameType: 'warzone', subMode: 'zones', teamCount: 3 },
    { gameType: 'arena', subMode: 'zones', teamCount: 4 },
    { gameType: 'warzone', subMode: 'zones', teamCount: 5 },
    { gameType: 'arena', subMode: 'zones', teamCount: 8 },
    { gameType: 'arena', subMode: 'hotpoint', teamCount: 0 },
    { gameType: 'arena', subMode: 'hotpoint', teamCount: 2 },
    { gameType: 'arena', subMode: 'hotpoint', teamCount: 5 },
    { gameType: 'arena', subMode: 'hotpoint', teamCount: 8 },
  ];
  const seeds = [1, 1234, 4242, 31337, 900001];
  const cache = new Map<string, GameMap>();
  const built = (seed: number, c: (typeof combos)[number]): GameMap => {
    const k = `${seed}|${c.gameType}|${c.subMode}|${c.teamCount}`;
    let m = cache.get(k);
    if (!m) { m = buildMatchMap({ seed, floor: 0, ...c }); cache.set(k, m); }
    return m;
  };
  /** Fast byte compare (deep-equal on 40k-entry typed arrays is slow). */
  const sameBytes = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);

  it('is deterministic including features; every feature and spawn is reachable; stands are off TILE_BASE', () => {
    for (const seed of seeds) {
      for (const c of combos) {
        const p = { seed, floor: 0, ...c };
        const tag = JSON.stringify(p);
        const a = built(seed, c), b = buildMatchMap({ ...p });
        expect(a.features, tag).toBeDefined();
        expect(sameBytes(a.tiles, b.tiles), tag).toBe(true);
        expect(a.features, tag).toEqual(b.features);
        const v02 = generateMap(seed, c.teamCount);
        // TILE_BASE pads are never touched, and none are added.
        for (let i = 0; i < a.tiles.length; i++) {
          if ((v02.tiles[i] === TILE_BASE) !== (a.tiles[i] === TILE_BASE)) throw new Error(`${tag}: base tile ${i} changed`);
        }
        // Border ring intact.
        for (let r = 0; r < a.rows; r++) for (let col = 0; col < a.cols; col++) {
          if ((col < BORDER || r < BORDER || col >= a.cols - BORDER || r >= a.rows - BORDER) && a.tiles[r * a.cols + col] !== TILE_WALL) {
            throw new Error(`${tag}: border tile ${col},${r} opened`);
          }
        }
        const seen = reachable(a);
        for (const f of a.features!) {
          const t = tileAt(a, Math.floor(f.x / a.tileSize), Math.floor(f.y / a.tileSize));
          expect(t === TILE_WALL || t === TILE_ROCK, `${tag} ${f.kind}#${f.index} solid`).toBe(false);
          expect(seen[tIdx(a, f.x, f.y)], `${tag} ${f.kind}#${f.index} reachable`).toBe(1);
          if (f.kind === 'flagStand') expect(t, `${tag} stand ${f.team} on TILE_BASE`).not.toBe(TILE_BASE);
        }
        for (const s of a.spawns) {
          const t = tileAt(a, Math.floor(s.x / a.tileSize), Math.floor(s.y / a.tileSize));
          expect(t === TILE_WALL || t === TILE_ROCK, `${tag} spawn solid`).toBe(false);
          expect(seen[tIdx(a, s.x, s.y)], `${tag} spawn reachable`).toBe(1);
        }
        expect(a.spawns).toEqual(v02.spawns);
      }
    }
  }, 60_000);

  it('every feature is reachable by the largest hull (collideCircle r 22) from the spawns, incl. 8-team Core / site 0', () => {
    const R = Math.max(...Object.values(SHIP_CLASSES).map((c) => c.base.radius));
    expect(R).toBe(22); // the Juggernaut
    const STEP = 6;
    for (const seed of seeds) {
      for (const c of combos) {
        const m = built(seed, c);
        const tag = `${seed} ${c.gameType}/${c.subMode}/${c.teamCount}`;
        const W = Math.floor(m.width / STEP), H = Math.floor(m.height / STEP);
        const free = new Int8Array(W * H).fill(-1);
        const isFree = (i: number) => {
          if (free[i] < 0) free[i] = collideCircle(m, (i % W) * STEP, Math.floor(i / W) * STEP, R).hit ? 0 : 1;
          return free[i] === 1;
        };
        const seen = new Uint8Array(W * H);
        const q: number[] = [];
        const start = m.spawns.filter((s) => c.teamCount === 0 || s.team === 0);
        for (const s of start) {
          const i = Math.round(s.y / STEP) * W + Math.round(s.x / STEP);
          if (isFree(i) && !seen[i]) { seen[i] = 1; q.push(i); }
        }
        expect(q.length, `${tag} start`).toBeGreaterThan(0);
        while (q.length) {
          const i = q.pop()!, col = i % W, row = (i - col) / W;
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nc = col + dc, nr = row + dr;
            if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
            const j = nr * W + nc;
            if (!seen[j] && isFree(j)) { seen[j] = 1; q.push(j); }
          }
        }
        const near = (x: number, y: number, rad: number) => {
          for (let yy = Math.floor((y - rad) / STEP); yy <= Math.ceil((y + rad) / STEP); yy++) {
            for (let xx = Math.floor((x - rad) / STEP); xx <= Math.ceil((x + rad) / STEP); xx++) {
              if (xx < 0 || yy < 0 || xx >= W || yy >= H || (xx * STEP - x) ** 2 + (yy * STEP - y) ** 2 > rad * rad) continue;
              if (seen[yy * W + xx]) return true;
            }
          }
          return false;
        };
        // A pad / stand counts when the hull can reach a spot 40 px from its centre (inside every radius).
        for (const f of m.features!) expect(near(f.x, f.y, 40), `${tag} ${f.kind}#${f.index} hull-reachable`).toBe(true);
        for (const s of m.spawns) expect(near(s.x, s.y, 12), `${tag} spawn ${s.team} hull-reachable`).toBe(true);
      }
    }
  }, 120_000);

  it('feature counts and placement follow §5.1', () => {
    for (const seed of seeds) {
      for (const c of combos) {
        const m = built(seed, c);
        const tag = `${seed} ${c.subMode} ${c.teamCount}`;
        const fs = m.features!;
        const bases = baseCentres(m);
        const cx = m.width / 2, cy = m.height / 2;
        if (c.subMode === 'ctf') {
          expect(fs.map((f) => [f.kind, f.team, f.index]), tag).toEqual(bases.map((b) => ['flagStand', b.team, b.team]));
          for (const f of fs) {
            const b = bases[f.team];
            expect(f.radius).toBe(90);
            expect(dist(f, b), tag).toBeGreaterThanOrEqual(191);
            expect(dist(f, { x: cx, y: cy }), tag).toBeLessThan(dist(b, { x: cx, y: cy }));
          }
        } else if (c.subMode === 'zones') {
          const n = zoneCount(c.teamCount);
          expect(fs.length, tag).toBe(n);
          expect(fs.map((f) => f.index)).toEqual([...Array(n).keys()]);
          expect([fs[0].x, fs[0].y]).toEqual([cx, cy]);
          for (const f of fs) { expect(f.kind).toBe('zone'); expect(f.radius).toBe(ZONE_RADIUS); expect(f.team).toBe(-1); }
          for (const f of fs.slice(1)) expect(Math.abs(dist(f, { x: cx, y: cy }) - ZONE_RING_PX), tag).toBeLessThan(1.5);
          if (c.teamCount === 2) {
            // base0 angle ± π/2
            const a0 = bases[0].a;
            const angs = fs.slice(1).map((f) => Math.atan2(f.y - cy, f.x - cx));
            for (const a of angs) expect(Math.abs(Math.cos(a - a0)), tag).toBeLessThan(0.01);
          }
          // Flanks sit between bases: never closer to a base than the zone ring allows.
          for (const f of fs.slice(1)) for (const b of bases) expect(dist(f, b), tag).toBeGreaterThan(900);
        } else {
          expect(fs.length, tag).toBe(HOT_SITES);
          expect(fs.map((f) => f.index)).toEqual([...Array(HOT_SITES).keys()]);
          expect([fs[0].x, fs[0].y]).toEqual([cx, cy]);
          for (const f of fs.slice(1)) {
            expect(f.x).toBeGreaterThanOrEqual(400); expect(f.y).toBeGreaterThanOrEqual(400);
            expect(f.x).toBeLessThanOrEqual(m.width - 400); expect(f.y).toBeLessThanOrEqual(m.height - 400);
            if (c.teamCount === 0) expect(dist(f, { x: cx, y: cy }), tag).toBeLessThanOrEqual(HOT_FFA_MAX_CENTRE_DIST + 1);
            else for (const b of bases) expect(dist(f, b), tag).toBeGreaterThanOrEqual(HOT_MIN_BASE_DIST - 1);
          }
          let minGap = Infinity;
          for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) minGap = Math.min(minGap, dist(fs[i], fs[j]));
          expect(minGap, tag).toBeGreaterThan(400); // 700 px, relaxed ×0.85 only when the map is crowded
        }
      }
    }
  }, 60_000);

  it('deathmatch, escort and rift maps get no features; the same seed + sub-mode never depends on world.rng', () => {
    const dm = buildMatchMap({ seed: 55, gameType: 'arena', subMode: 'deathmatch', teamCount: 2, floor: 0 });
    expect(dm.features).toBeUndefined();
    const esc = generateMap(55, 2), before = esc.tiles.slice();
    placeObjectiveFeatures(esc, 'escort', 55);
    expect(esc.features).toBeUndefined();
    expect(esc.tiles).toEqual(before);
    // A different seed gives a different layout (the feature Rng is seeded from the map seed).
    const h1 = buildMatchMap({ seed: 1, gameType: 'arena', subMode: 'hotpoint', teamCount: 2, floor: 0 });
    const h2 = buildMatchMap({ seed: 2, gameType: 'arena', subMode: 'hotpoint', teamCount: 2, floor: 0 });
    expect(h1.features!.slice(1)).not.toEqual(h2.features!.slice(1));
  });
});

// =============================================================================================
describe('Capture the Flag (§5.3)', () => {
  function rig(o: Partial<SimConfig> = {}) {
    const sim = new Sim(cfg({ subMode: 'ctf', ...o }));
    const w = sim.world, obj = w.objective!;
    const a = add(sim, 1, 'brute', 0), b = add(sim, 2, 'brute', 1);
    const a2 = add(sim, 3, 'tech', 0), b2 = add(sim, 4, 'engineer', 1);
    settle(sim);
    sim.drainEvents();
    const flag = (t: number) => obj.flags.find((f) => f.team === t)!;
    return { sim, w, obj, a, b, a2, b2, flag };
  }

  it('initializes one home flag per team at its stand', () => {
    const { w, obj } = rig({ teamCount: 3 });
    expect(obj.mode).toBe('ctf');
    expect(obj.limit).toBe(3);
    expect(obj.teamPoints).toEqual([0, 0, 0]);
    const stands = w.map.features!.filter((f) => f.kind === 'flagStand');
    expect(obj.flags.map((f) => [f.team, f.state, f.x, f.y])).toEqual(stands.map((s) => [s.team, 'home', s.x, s.y]));
  });

  it('pickup: an enemy touching the flag takes it (steal +15, invuln cancelled, carrier flag bit, slower)', () => {
    const { sim, w, obj, b, flag } = rig();
    const f0 = flag(0);
    b.invulnUntilTick = w.tick + 500;
    place(b, f0.standX, f0.standY);
    sim.step();
    expect(f0.state).toBe('carried');
    expect(f0.carrierId).toBe(b.id);
    expect(f0.runners).toEqual([2]);
    expect(isCarrier(w, b)).toBe(true);
    expect(b.flags & SHIPFLAG_CARRIER).toBe(SHIPFLAG_CARRIER);
    expect(b.invulnUntilTick).toBeLessThanOrEqual(w.tick);
    expect(b.score).toBe(CTF_SCORE.steal);
    expect(obj.stats.get(2)!.steals).toBe(1);
    expect(objSpeedMult(w, b)).toBe(CTF_CARRIER_SPEED_MULT);
    const ev = objEvents(sim.drainEvents(), 'flagTaken');
    expect(ev).toEqual([{ t: 'objective', kind: 'flagTaken', team: 1, playerId: 2, index: 0, x: Math.round(b.x), y: Math.round(b.y), value: 1 }]);
    // it follows the carrier, and the bit is re-applied every tick after pass 3
    place(b, f0.standX + 60, f0.standY);
    sim.step();
    expect([f0.x, f0.y]).toEqual([b.x, b.y]);
    expect(b.flags & SHIPFLAG_CARRIER).toBe(SHIPFLAG_CARRIER);
    // a team's own flag at home can't be taken by its own team
    const { sim: s2, a: a0, flag: fl2 } = rig();
    place(a0, fl2(0).standX, fl2(0).standY);
    s2.step();
    expect(fl2(0).state).toBe('home');
  });

  it('capture only while your own flag is home; captured flag returns; +100, assists, flagCapture loot', () => {
    const { sim, w, obj, a, b, b2, flag } = rig({ lootMult: 1 });
    const f0 = flag(0), f1 = flag(1);
    place(b, f0.standX, f0.standY); sim.step(); // b steals f0
    place(a, f1.standX, f1.standY); sim.step(); // a steals f1
    expect([f0.state, f1.state]).toEqual(['carried', 'carried']);
    // a parks near its own stand (its own flag is away) → no capture either way
    place(a, f0.standX + 40, f0.standY);
    place(b, f1.standX, f1.standY);
    steps(sim, 30, () => { place(b, f1.standX, f1.standY); place(a, f0.standX + 40, f0.standY); });
    expect(obj.teamPoints).toEqual([0, 0]);
    expect([f0.state, f1.state]).toEqual(['carried', 'carried']);
    // kill a → f1 drops by stand 0; b still can't capture (f1 not home)
    kill(sim, a, b2);
    sim.step();
    expect(f1.state).toBe('dropped');
    steps(sim, 10, () => place(b, f1.standX, f1.standY));
    expect(obj.teamPoints).toEqual([0, 0]);
    // b2 returns f1 by touch (+20), then b captures on the next tick
    sim.drainEvents();
    const b2Score = b2.score, bScore = b.score;
    place(b2, f1.x, f1.y);
    sim.step();
    expect(f1.state).toBe('home');
    expect(b2.score - b2Score).toBe(CTF_SCORE.returned);
    expect(obj.stats.get(4)!.returns).toBe(1);
    park(sim, b2); // (left by stand 0 it would steal f0 again the moment it goes home)
    place(b, f1.standX, f1.standY);
    sim.step();
    expect(obj.teamPoints).toEqual([0, 1]);
    expect(f0.state).toBe('home');
    expect([f0.x, f0.y]).toEqual([f0.standX, f0.standY]);
    expect(b.flags & SHIPFLAG_CARRIER).toBe(0);
    expect(b.score - bScore).toBe(CTF_SCORE.capture);
    expect(obj.stats.get(2)!.caps).toBe(1);
    const ev = sim.drainEvents();
    const cap = objEvents(ev, 'flagCaptured');
    expect(cap.map((e) => [e.team, e.playerId, e.index, e.value])).toEqual([[1, 2, 0, 1]]);
    expect(objEvents(ev, 'flagReturned').map((e) => [e.team, e.playerId, e.value])).toEqual([[1, 4, 0]]);
    const drops = ev.filter((e) => e.t === 'lootDrop' && e.source === 'flagCapture');
    expect(drops.length).toBe(1);
    // teamScores mirror objective points (Sim.stepMatch), never ship scores
    expect(w.match.teamScores).toEqual([0, 1]);
  });

  it('assist credit: earlier runners and teammates within 900 px get +30', () => {
    const { sim, obj, a, b, b2, flag } = rig();
    const f0 = flag(0), f1 = flag(1);
    place(b2, f0.standX, f0.standY); sim.step(); // b2 steals
    kill(sim, b2, a);
    sim.step(); // dropped by stand 0
    expect(f0.state).toBe('dropped');
    place(b, f0.x, f0.y); sim.step(); // b re-picks the dropped flag (not a steal)
    expect(f0.carrierId).toBe(b.id);
    expect(f0.runners).toEqual([4, 2]);
    expect(obj.stats.get(2)?.steals ?? 0).toBe(0);
    const b2Before = b2.score;
    steps(sim, 3 * T); // b2 respawns at its base
    expect(b2.alive).toBe(true);
    place(b, f1.standX, f1.standY);
    sim.step();
    expect(obj.teamPoints[1]).toBe(1);
    expect(b2.score - b2Before).toBe(CTF_SCORE.assist); // runner of this steal (and near the stand)
  });

  it('dropped flags: touch return (+20) and the 20 s auto-return; view returnIn counts down', () => {
    const { sim, w, a, b, flag } = rig();
    const f0 = flag(0);
    place(b, f0.standX, f0.standY); sim.step();
    kill(sim, b, a);
    sim.step();
    expect(f0.state).toBe('dropped');
    const v = buildObjectiveView(w)!;
    expect(v.flags!.find((f) => f.team === 0)).toEqual({ team: 0, s: 2, x: Math.round(f0.x), y: Math.round(f0.y), carrierId: 0, returnIn: CTF_RETURN_SEC });
    sim.drainEvents();
    steps(sim, CTF_RETURN_SEC * T - 2);
    expect(f0.state).toBe('dropped');
    steps(sim, 2);
    expect(f0.state).toBe('home');
    expect(objEvents(sim.drainEvents(), 'flagReturned').map((e) => [e.team, e.playerId, e.value])).toEqual([[0, 0, 1]]);
  });

  it('carrier kill (+25, carrierKill loot) and defend kill (+5)', () => {
    const { sim, obj, a, b, b2, flag } = rig({ lootMult: 4 }); // 0.25 × 4 → the carrierKill roll always hits
    const f0 = flag(0);
    place(b, f0.standX, f0.standY); sim.step();
    sim.drainEvents();
    let before = a.score;
    const bounty = b.bounty;
    kill(sim, b, a);
    sim.step();
    expect(a.score - before).toBe(10 + bounty + CTF_SCORE.carrierKill);
    expect(obj.stats.get(1)!.carrierKills).toBe(1);
    expect(sim.drainEvents().filter((e) => e.t === 'lootDrop' && e.source === 'carrierKill').length).toBe(1);
    // defend kill: a non-carrier victim within 700 px of the killer's own stand
    place(b2, f0.standX + 300, f0.standY);
    before = a.score;
    const bounty2 = b2.bounty;
    kill(sim, b2, a);
    sim.step();
    expect(a.score - before).toBe(10 + bounty2 + CTF_SCORE.defendKill);
  });

  it('a carrier cannot attach, and keeps only the gunner seat (slot 0)', () => {
    const sim = new Sim(cfg({ subMode: 'ctf' }));
    const w = sim.world, obj = w.objective!;
    const host = add(sim, 1, 'engineer', 1), t1 = add(sim, 2, 'brute', 1), t2 = add(sim, 3, 'tech', 1), t3 = add(sim, 4, 'brute', 1);
    add(sim, 5, 'brute', 0);
    settle(sim);
    expect(host.stats.maxTurrets).toBeGreaterThanOrEqual(2);
    const f0 = obj.flags.find((f) => f.team === 0)!;
    const attach = (s: Ship, target: Ship) => { s.input = { ...emptyInput(), attach: true, attachTarget: target.id }; };
    place(host, f0.standX + 200, f0.standY + 200);
    attach(t1, host); sim.step(); t1.input = emptyInput(); sim.step();
    attach(t2, host); sim.step(); t2.input = emptyInput(); sim.step();
    expect(host.turrets).toEqual([t1.id, t2.id]);
    place(host, f0.standX, f0.standY);
    sim.step();
    expect(f0.carrierId).toBe(host.id);
    expect(host.turrets).toEqual([t1.id]); // the gunner seat (slot 0) stays
    expect(t2.attachedTo).toBe(0);
    expect(objMaxTurrets(w, host)).toBe(1);
    steps(sim, 4 * T); // attach cooldown
    attach(t2, host); sim.step();
    expect(t2.attachedTo).not.toBe(host.id); // (tryAttach may fall back to another teammate, t3)
    expect(host.turrets).toEqual([t1.id]);
    // a (turret-free) carrier never attaches
    const { sim: s2, flag } = ((): { sim: Sim; flag: (t: number) => typeof f0 } => {
      const s = new Sim(cfg({ subMode: 'ctf' }));
      return { sim: s, flag: (t: number) => s.world.objective!.flags.find((f) => f.team === t)! };
    })();
    const c = add(s2, 1, 'brute', 1), mate = add(s2, 2, 'brute', 1);
    add(s2, 3, 'brute', 0);
    settle(s2);
    place(c, flag(0).standX, flag(0).standY);
    s2.step();
    expect(isCarrier(s2.world, c)).toBe(true);
    steps(s2, 4 * T);
    c.input = { ...emptyInput(), attach: true, attachTarget: mate.id };
    s2.step();
    expect(c.attachedTo).toBe(0);
    expect(mate.turrets).toEqual([]);
    void t3;
  });

  it('drops on leave, team swap and in-place class swap (no instant re-pick), and on death at the death spot', () => {
    // leave
    let r = rig();
    place(r.b, r.flag(0).standX, r.flag(0).standY); r.sim.step();
    place(r.b, r.flag(0).standX + 50, r.flag(0).standY + 10);
    r.sim.step();
    const at = { x: r.b.x, y: r.b.y };
    r.sim.drainEvents();
    r.sim.removePlayer(2);
    expect(r.flag(0).state).toBe('dropped');
    expect([r.flag(0).x, r.flag(0).y]).toEqual([at.x, at.y]);
    expect(objEvents(r.sim.drainEvents(), 'flagDropped').map((e) => [e.team, e.playerId, e.index])).toEqual([[1, 2, 0]]);
    // team swap: dropped while still on the old team
    r = rig();
    place(r.b, r.flag(0).standX, r.flag(0).standY); r.sim.step();
    r.sim.drainEvents();
    r.sim.setPlayerTeam(2, 0);
    expect(r.flag(0).state).toBe('dropped');
    expect(objEvents(r.sim.drainEvents(), 'flagDropped')[0].team).toBe(1);
    // in-place class swap: dropped where it stands, re-pick only after CTF_REPICK_SEC
    r = rig();
    const f0 = r.flag(0);
    place(r.b, f0.standX, f0.standY); r.sim.step();
    r.sim.setShipClass(2, 'tech');
    expect(r.b.alive).toBe(true);
    expect(f0.state).toBe('dropped');
    expect(r.b.flags & SHIPFLAG_CARRIER).toBe(0);
    steps(r.sim, CTF_REPICK_SEC * T - 2, () => place(r.b, f0.x, f0.y));
    expect(f0.state).toBe('dropped');
    steps(r.sim, 3, () => place(r.b, f0.x, f0.y));
    expect(f0.state).toBe('carried');
    // death: dropped at the death position; the respawn later doesn't move it
    r = rig();
    place(r.b, r.flag(0).standX + 30, r.flag(0).standY); r.sim.step();
    const deathAt = { x: r.b.x, y: r.b.y };
    kill(r.sim, r.b, r.a);
    r.sim.step();
    expect(r.flag(0).state).toBe('dropped');
    expect([r.flag(0).x, r.flag(0).y]).toEqual([deathAt.x, deathAt.y]);
    steps(r.sim, 3 * T + 2);
    expect(r.b.alive).toBe(true);
    expect([r.flag(0).x, r.flag(0).y]).toEqual([deathAt.x, deathAt.y]);
    // respawn while carrying (Sim.spawnShip's first line is objectiveRelease): dropped at the pre-teleport spot
    r = rig();
    place(r.b, r.flag(0).standX, r.flag(0).standY); r.sim.step();
    place(r.b, r.flag(0).standX + 50, r.flag(0).standY + 10); r.sim.step();
    expect(r.flag(0).state).toBe('carried');
    const pre = { x: r.b.x, y: r.b.y };
    r.sim.drainEvents();
    (r.sim as unknown as { spawnShip(s: Ship): void }).spawnShip(r.b);
    expect(r.flag(0).state).toBe('dropped');
    expect([r.flag(0).x, r.flag(0).y]).toEqual([pre.x, pre.y]);
    expect(isCarrier(r.w, r.b)).toBe(false);
    expect(dist(r.b, pre)).toBeGreaterThan(100); // the ship itself teleported to a spawn point
    expect(objEvents(r.sim.drainEvents(), 'flagDropped').map((e) => [e.team, e.playerId, e.index])).toEqual([[1, 2, 0]]);
  });

  it('Flag Overload: recharge ×0.5 after 60 s of continuous carry, ×0 after 90 s', () => {
    const { sim, w, a, b, flag } = rig();
    const f0 = flag(0);
    place(b, f0.standX, f0.standY); sim.step();
    expect(objRechargeMult(w, b)).toBe(1);
    f0.pickedAtTick = w.tick - 59 * T;
    expect(objRechargeMult(w, b)).toBe(1);
    f0.pickedAtTick = w.tick - 60 * T;
    expect(objRechargeMult(w, b)).toBe(0.5);
    f0.pickedAtTick = w.tick - 90 * T;
    expect(objRechargeMult(w, b)).toBe(0);
    b.energy = b.stats.maxEnergy * 0.5;
    const e0 = b.energy;
    steps(sim, 30, () => place(b, f0.standX + 40, f0.standY));
    expect(b.energy).toBe(e0);
    // not a carrier → 1
    expect(objRechargeMult(w, a)).toBe(1);
  });

  it('Flag Overload survives a class-swap hand-off to a teammate (and the swapper re-picking); a death drop resets it', () => {
    const { sim, w, a, b, b2, flag } = rig();
    const f0 = flag(0);
    place(b, f0.standX, f0.standY); sim.step();
    expect(f0.state).toBe('carried');
    f0.pickedAtTick = w.tick - 88 * T; // 88 s into the carry
    expect(objRechargeMult(w, b)).toBe(0.5);
    const clock = f0.pickedAtTick;
    // swap in place with a teammate right beside: the teammate takes it next tick but keeps the old clock
    sim.setShipClass(2, 'tech');
    place(b2, b.x + 4, b.y);
    sim.step();
    expect(f0.state).toBe('carried');
    expect(f0.carrierId).toBe(b2.id);
    expect(f0.pickedAtTick).toBe(clock);
    steps(sim, 3 * T, () => place(b2, b.x + 4, b.y));
    expect(objRechargeMult(w, b2)).toBe(0);
    // the same trick by the swapper itself (after its re-pick lock) keeps the clock too
    sim.setShipClass(4, 'brute');
    const at = { x: b2.x, y: b2.y };
    steps(sim, CTF_REPICK_SEC * T + 2, () => { place(b2, at.x, at.y); park(sim, b); });
    expect(f0.carrierId).toBe(b2.id);
    expect(f0.pickedAtTick).toBe(clock);
    // a death drop: the next carry starts fresh
    kill(sim, b2, a);
    sim.step();
    expect(f0.state).toBe('dropped');
    place(b, f0.x, f0.y);
    sim.step();
    expect(f0.carrierId).toBe(b.id);
    expect(f0.pickedAtTick).toBe(w.tick);
    expect(objRechargeMult(w, b)).toBe(1);
  });

  it('a carrier Juggernaut Ram Charges at × CTF_CARRIER_SPEED_MULT (no full-speed escape)', () => {
    const chargeSpeed = (carry: boolean): number => {
      const { sim, b, flag } = rig();
      const f0 = flag(0);
      if (carry) { place(b, f0.standX, f0.standY); sim.step(); expect(f0.state).toBe('carried'); }
      else { park(sim, b); sim.step(); }
      b.energy = b.stats.maxEnergy;
      let top = 0;
      for (let k = 0; k < 10; k++) {
        b.input = { ...emptyInput(), mobility: k === 0, aim: 0, aimDist: 400 };
        sim.step();
        if (b.flags & 16 /* SHIPFLAG_CHARGING */) top = Math.max(top, Math.hypot(b.vx, b.vy));
      }
      return top;
    };
    const free = chargeSpeed(false), carrier = chargeSpeed(true);
    expect(free).toBeGreaterThan(1000);
    expect(carrier / free).toBeCloseTo(CTF_CARRIER_SPEED_MULT, 3);
  });

  it('a carrier is never cloaked (its position is public in the objective view)', () => {
    const { sim, b, flag } = rig();
    const f0 = flag(0);
    place(b, f0.standX, f0.standY); sim.step();
    expect(f0.state).toBe('carried');
    b.flags |= SHIPFLAG_CLOAKED;
    sim.step();
    expect(b.flags & SHIPFLAG_CLOAKED).toBe(0);
    expect(b.flags & SHIPFLAG_CARRIER).toBe(SHIPFLAG_CARRIER);
  });

  it('time-out tie → sudden death (+180 s), the next capture wins', () => {
    const { sim, w, obj, b, flag } = rig({ matchSeconds: 20 });
    steps(sim, 20 * T - w.tick - 1);
    sim.drainEvents();
    sim.step(); // tick 20 s: time-out at 0–0
    expect(w.match.phase).toBe('playing');
    expect(obj.suddenDeath).toBe(true);
    expect(w.match.endTick).toBe(w.tick + CTF_SUDDEN_DEATH_SEC * T);
    expect(objEvents(sim.drainEvents(), 'suddenDeath').length).toBe(1);
    expect(buildObjectiveView(w)!.suddenDeath).toBe(true);
    const f0 = flag(0), f1 = flag(1);
    place(b, f0.standX, f0.standY); sim.step();
    place(b, f1.standX, f1.standY); sim.step();
    expect(w.match.phase).toBe('ended');
    expect(w.match.winnerTeam).toBe(1);
    expect(sim.drainEvents().filter((e) => e.t === 'matchEnd').length).toBe(1);
  });

  it('a sudden-death time-out is a draw; the limit ends the match early', () => {
    const r = rig({ matchSeconds: 10 });
    steps(r.sim, (10 + CTF_SUDDEN_DEATH_SEC) * T + 5);
    expect(r.w.match.phase).toBe('ended');
    expect(r.w.match.winnerTeam).toBe(-1);
    const q = rig({ objectiveLimit: 1 });
    place(q.b, q.flag(0).standX, q.flag(0).standY); q.sim.step();
    place(q.b, q.flag(1).standX, q.flag(1).standY); q.sim.step();
    expect(q.w.match.phase).toBe('ended');
    expect(q.w.match.winnerTeam).toBe(1);
    expect(q.w.match.teamScores).toEqual([0, 1]);
  });

  it('teamScores are never rebuilt from ship.score', () => {
    const { sim, w, a, b } = rig();
    a.score = 5000; b.score = 1;
    steps(sim, 5);
    expect(w.match.teamScores).toEqual([0, 0]);
    expect(w.match.phase).toBe('playing');
  });
});

// =============================================================================================
describe('Control Zones (§5.4)', () => {
  function rig(o: Partial<SimConfig> = {}) {
    const sim = new Sim(cfg({ subMode: 'zones', ...o }));
    const w = sim.world, obj = w.objective!;
    const a = add(sim, 1, 'brute', 0), a2 = add(sim, 2, 'tech', 0), a3 = add(sim, 3, 'engineer', 0);
    const b = add(sim, 4, 'brute', 1);
    w.pve.nextWaveTick = Number.MAX_SAFE_INTEGER; // no director spawns in the Warzone rigs
    settle(sim);
    sim.drainEvents();
    return { sim, w, obj, a, a2, a3, b };
  }
  /** Ticks until zone k is owned by `team` while `ships` sit on it. */
  function capTicks(sim: Sim, k: number, team: number, ships: Ship[], limit = 2000): number {
    const z = sim.world.objective!.zones[k];
    for (let n = 1; n <= limit; n++) {
      for (const s of ships) place(s, z.x, z.y);
      sim.step();
      if (z.owner === team) return n;
    }
    return -1;
  }

  it('initializes clamp(teams + 1, 3, 5) neutral zones from the features', () => {
    const { obj, w } = rig({ teamCount: 4 });
    expect(obj.zones.length).toBe(5);
    expect(obj.zones.map((z) => [z.index, z.owner, z.progress, z.active])).toEqual([0, 1, 2, 3, 4].map((i) => [i, -1, 0, true]));
    expect(obj.limit).toBe(300);
    expect(objectiveAnchors(w).length).toBe(5);
    expect(objectiveAnchors(w)[0]).toEqual({ x: obj.zones[0].x, y: obj.zones[0].y, weight: 2 });
  });

  it('captures in 8 s solo, 6 s with 2, 4 s with 3; contributors +15, zoneCaps stat, zoneCaptured event', () => {
    let r = rig();
    expect(capTicks(r.sim, 1, 0, [r.a])).toBe(ZONE_CAP_SEC * T);
    const ev = objEvents(r.sim.drainEvents(), 'zoneCaptured');
    expect(ev.map((e) => [e.team, e.playerId, e.index, e.value])).toEqual([[0, 1, 1, -1]]);
    expect(r.obj.stats.get(1)!.zoneCaps).toBe(1);
    expect(r.obj.zones[1].ownerPlayerId).toBe(1);
    r = rig();
    expect(capTicks(r.sim, 2, 0, [r.a, r.a2])).toBe((ZONE_CAP_SEC / 1.5) * T);
    r = rig();
    const s0 = [r.a.score, r.a2.score, r.a3.score];
    expect(capTicks(r.sim, 0, 0, [r.a, r.a2, r.a3])).toBe((ZONE_CAP_SEC / 2) * T);
    // +15 each, +1 per 2 s of work each (4 s inside → 2)
    expect([r.a.score - s0[0], r.a2.score - s0[1], r.a3.score - s0[2]]).toEqual([17, 17, 17]);
    expect(r.obj.stats.get(2)!.objTicks).toBe(4 * T);
  });

  it('contested zones freeze; a decap takes an enemy zone to neutral first (+10) at the same rate', () => {
    const r = rig();
    const z = r.obj.zones[1];
    steps(r.sim, 4 * T, () => place(r.a, z.x, z.y));
    expect(z.progress).toBeCloseTo(0.5, 6);
    steps(r.sim, 2 * T, () => { place(r.a, z.x, z.y); place(r.b, z.x + 40, z.y); });
    expect(z.contested).toBe(true);
    expect(z.progress).toBeCloseTo(0.5, 6);
    expect(buildObjectiveView(r.w)!.zones![1]).toMatchObject({ i: 1, cap: 0, p: 50, contested: true, owner: -1 });
    // b alone on the zone rolls a's partial progress back first, then caps it for team 1
    park(r.sim, r.a);
    const n = capTicks(r.sim, 1, 1, [r.b]);
    expect(n).toBe(4 * T + ZONE_CAP_SEC * T);
    // a decaps (8 s → neutral), then caps (8 s)
    park(r.sim, r.b);
    r.sim.drainEvents();
    const before = r.a.score;
    steps(r.sim, ZONE_CAP_SEC * T, () => place(r.a, z.x, z.y));
    expect(z.owner).toBe(-1);
    const ev = objEvents(r.sim.drainEvents());
    expect(ev.map((e) => [e.kind, e.team, e.value])).toEqual([['zoneNeutralized', 0, 1]]);
    expect(r.obj.stats.get(1)!.neutralizes).toBe(1);
    expect(r.a.score - before).toBe(ZONE_SCORE.neutralize + 4);
    expect(capTicks(r.sim, 1, 0, [r.a])).toBe(ZONE_CAP_SEC * T);
    expect(objEvents(r.sim.drainEvents(), 'zoneCaptured').map((e) => [e.team, e.value])).toEqual([[0, 1]]);
  });

  it('partial progress decays at 0.125/s after 3 s empty', () => {
    const r = rig();
    const z = r.obj.zones[1];
    steps(r.sim, 4 * T, () => place(r.a, z.x, z.y));
    expect(z.progress).toBeCloseTo(0.5, 6);
    place(r.a, z.x + 1000, z.y); // off the pad (base area is clear)
    r.a.x = r.w.map.spawns.find((s) => s.team === 0)!.x; r.a.y = r.w.map.spawns.find((s) => s.team === 0)!.y;
    steps(r.sim, ZONE_DECAY_DELAY_SEC * T - 1);
    expect(z.progress).toBeCloseTo(0.5, 6);
    steps(r.sim, 2 * T + 1);
    expect(z.progress).toBeCloseTo(0.25, 2);
    steps(r.sim, 3 * T);
    expect(z.progress).toBe(0);
    expect(z.capTeam).toBe(-1);
  });

  it('each owned zone ticks +1 point every 2 s, even while contested; teamScores mirror points', () => {
    const r = rig();
    const z = r.obj.zones[1];
    capTicks(r.sim, 1, 0, [r.a]);
    expect(r.obj.teamPoints).toEqual([0, 0]);
    steps(r.sim, ZONE_POINT_SEC * T - 1);
    expect(r.obj.teamPoints[0]).toBe(0);
    r.sim.step();
    expect(r.obj.teamPoints[0]).toBe(1);
    steps(r.sim, ZONE_POINT_SEC * T, () => { place(r.a, z.x, z.y); place(r.b, z.x, z.y + 30); });
    expect(z.contested).toBe(true);
    expect(r.obj.teamPoints[0]).toBe(2);
    r.a.score = 99999;
    r.sim.step();
    expect(r.w.match.teamScores).toEqual(r.obj.teamPoints);
  });

  it('Warzone: ≥ 3 enemies on a pad block capture progress (points still tick)', () => {
    const r = rig({ gameType: 'warzone', pveIntensity: 1 });
    const z = r.obj.zones[1];
    const drones = [0, 1, 2].map((i) => spawnEnemy(r.w, 'drone', z.x + 60 + i * 20, z.y + 60)!);
    for (const d of drones) d.contactDamage = 0;
    const hold = (n: number) => () => {
      place(r.a, z.x, z.y);
      drones.forEach((d, i) => { d.x = z.x + 60 + i * 20; d.y = z.y + 60; d.vx = 0; d.vy = 0; if (i >= n) { d.x = z.x + 900; } });
    };
    steps(r.sim, 2 * T, hold(3));
    expect(z.swarm).toBe(3);
    expect(z.progress).toBe(0);
    expect(buildObjectiveView(r.w)!.zones![1].swarm).toBe(true);
    steps(r.sim, 2 * T, hold(2));
    expect(z.swarm).toBe(2);
    expect(z.progress).toBeCloseTo(0.25, 6);
    // an owned pad keeps scoring under the swarm
    z.owner = 0; z.heldSinceTick = r.w.tick; z.progress = 0; z.capTeam = -1;
    const p0 = r.obj.teamPoints[0];
    steps(r.sim, ZONE_POINT_SEC * T, hold(3));
    expect(r.obj.teamPoints[0]).toBe(p0 + 1);
  });

  it('zoneCapture loot only for a pad flipped from an enemy; zoneHold every 60 s', () => {
    const r = rig({ lootMult: 4 });
    const z = r.obj.zones[1];
    capTicks(r.sim, 1, 0, [r.a]); // from neutral: no zoneCapture roll
    expect(r.sim.drainEvents().some((e) => e.t === 'lootDrop' && e.source === 'zoneCapture')).toBe(false);
    steps(r.sim, 60 * T - (r.w.tick - z.heldSinceTick));
    expect(r.sim.drainEvents().filter((e) => e.t === 'lootDrop' && e.source === 'zoneHold').length).toBe(1);
    park(r.sim, r.a);
    expect(capTicks(r.sim, 1, -1, [r.b])).toBe(ZONE_CAP_SEC * T); // neutralize
    expect(capTicks(r.sim, 1, 1, [r.b])).toBe(ZONE_CAP_SEC * T); // capture from team 0
    expect(r.sim.drainEvents().filter((e) => e.t === 'lootDrop' && e.source === 'zoneCapture').length).toBe(1);
  });

  it('the limit ends the match; a time-out tie extends +60 s up to 3 times, then a draw', () => {
    const r = rig({ objectiveLimit: 100 });
    capTicks(r.sim, 1, 0, [r.a]);
    r.obj.teamPoints[0] = 99;
    steps(r.sim, ZONE_POINT_SEC * T);
    expect(r.w.match.phase).toBe('ended');
    expect(r.w.match.winnerTeam).toBe(0);
    const q = rig({ matchSeconds: 10 });
    steps(q.sim, 10 * T - q.w.tick - 1);
    q.sim.drainEvents();
    q.sim.step(); // time-out at 0–0
    expect(q.w.match.phase).toBe('playing');
    expect(q.obj.extensions).toBe(1);
    expect(q.obj.overtime).toBe(true);
    expect(q.w.match.endTick).toBe(q.w.tick + ZONE_TIE_EXTEND_SEC * T);
    expect(objEvents(q.sim.drainEvents(), 'overtime').map((e) => [e.index, e.value])).toEqual([[1, ZONE_TIE_EXTEND_SEC]]);
    steps(q.sim, 3 * ZONE_TIE_EXTEND_SEC * T + 2);
    expect(q.obj.extensions).toBe(3);
    expect(q.w.match.phase).toBe('ended');
    expect(q.w.match.winnerTeam).toBe(-1);
  });
});

// =============================================================================================
describe('Hot Point (§5.5)', () => {
  function rig(o: Partial<SimConfig> = {}, n = 2) {
    const sim = new Sim(cfg({ subMode: 'hotpoint', ...o }));
    const w = sim.world, obj = w.objective!;
    const ffa = w.config.mode === 'ffa';
    const ships = Array.from({ length: n }, (_, i) => add(sim, i + 1, 'brute', ffa ? 0 : i % 2));
    settle(sim);
    sim.drainEvents();
    return { sim, w, obj, ships, z: () => obj.zones[0] };
  }

  it('starts on the centre site, warns 10 s before moving, moves every 60 s and arms after 3 s', () => {
    const r = rig();
    const h = r.obj.hot!;
    expect(h.site).toBe(0);
    expect(r.z().active).toBe(true);
    expect([r.z().x, r.z().y]).toEqual([r.w.map.width / 2, r.w.map.height / 2]);
    expect(objectiveAnchors(r.w)).toEqual([]); // swarm anchors are Control Zones only (§5.6)
    steps(r.sim, (HOT_MOVE_SEC - HOT_WARN_SEC) * T - r.w.tick - 1);
    expect(h.nextSite).toBe(-1);
    r.sim.step();
    expect(h.nextSite).toBeGreaterThan(0);
    const warn = objEvents(r.sim.drainEvents(), 'hotWarn');
    expect(warn.map((e) => [e.index, e.value])).toEqual([[h.nextSite, HOT_WARN_SEC]]);
    expect(buildObjectiveView(r.w)!.hot).toEqual({ site: 0, next: h.nextSite, moveIn: HOT_WARN_SEC, armIn: 0 });
    const next = h.nextSite;
    steps(r.sim, HOT_WARN_SEC * T);
    expect(h.site).toBe(next);
    expect(h.moves).toBe(1);
    expect(h.recent).toEqual([0]);
    expect(objEvents(r.sim.drainEvents(), 'hotMoved').map((e) => [e.index, e.value])).toEqual([[next, 1]]);
    const site = r.w.map.features!.find((f) => f.kind === 'hotSite' && f.index === next)!;
    expect([r.z().x, r.z().y, r.z().index, r.z().active]).toEqual([site.x, site.y, next, false]);
    expect(dist(site, { x: r.w.map.width / 2, y: r.w.map.height / 2 })).toBeGreaterThanOrEqual(HOT_MIN_MOVE_DIST);
    // arm delay: a pilot on the new site makes no progress until it arms, then caps in 5 s
    const [a] = r.ships;
    const n = ((): number => {
      for (let k = 1; k < 2000; k++) { place(a, site.x, site.y); r.sim.step(); if (r.z().owner === 0) return k; }
      return -1;
    })();
    expect(n).toBe(HOT_ARM_SEC * T + HOT_CAP_SEC * T - 1);
    expect(r.obj.stats.get(1)!.zoneCaps).toBe(1);
  });

  it('relocation spacing: ≥ 1400 px when possible, never the current or the last 2 sites; deterministic, no world.rng', () => {
    for (const seed of [3, 1234, 8080]) {
      for (const [mode, teamCount] of [['teams', 2], ['teams', 6], ['ffa', 0]] as const) {
        const r = rig({ mapSeed: seed, mode, teamCount }, 0);
        const h = r.obj.hot!;
        const sites = r.w.map.features!.filter((f) => f.kind === 'hotSite');
        const seq: number[] = [];
        for (let m = 0; m < 20; m++) {
          const cur = sites.find((s) => s.index === h.site)!;
          const next = pickNextSite(r.w, r.obj);
          const nf = sites.find((s) => s.index === next)!;
          expect(next).not.toBe(h.site);
          expect(h.recent).not.toContain(next);
          const possible = sites.some((s) => s.index !== h.site && !h.recent.includes(s.index) && dist(s, cur) >= HOT_MIN_MOVE_DIST);
          if (possible) expect(dist(nf, cur)).toBeGreaterThanOrEqual(HOT_MIN_MOVE_DIST);
          seq.push(next);
          h.recent = [h.site, ...h.recent].slice(0, 2);
          h.site = next;
          h.moves++;
        }
        // same seed → same sequence
        const r2 = rig({ mapSeed: seed, mode, teamCount }, 0);
        const h2 = r2.obj.hot!;
        const seq2: number[] = [];
        for (let m = 0; m < 20; m++) {
          const next = pickNextSite(r2.w, r2.obj);
          seq2.push(next);
          h2.recent = [h2.site, ...h2.recent].slice(0, 2); h2.site = next; h2.moves++;
        }
        expect(seq2).toEqual(seq);
      }
    }
    // A full relocation cycle in a real Sim never draws from world.rng.
    const sim = new Sim(cfg({ subMode: 'hotpoint', mapSeed: 777 }));
    steps(sim, 2 * HOT_MOVE_SEC * T + 5);
    expect(sim.world.objective!.hot!.moves).toBe(2);
    const fresh = new Rng(777 ^ 0x5eed);
    expect(sim.world.rng.next()).toBe(fresh.next());
  });

  it('teams: an uncontested holder scores +1/s; contested earns nothing but keeps ownership', () => {
    const r = rig();
    const [a, b] = r.ships;
    const z = r.z();
    steps(r.sim, HOT_CAP_SEC * T, () => place(a, z.x, z.y));
    expect(z.owner).toBe(0);
    steps(r.sim, 3 * T, () => place(a, z.x, z.y));
    expect(r.obj.teamPoints).toEqual([3, 0]);
    steps(r.sim, 3 * T, () => { place(a, z.x, z.y); place(b, z.x + 30, z.y); });
    expect(z.contested).toBe(true);
    expect(z.owner).toBe(0);
    expect(r.obj.teamPoints).toEqual([3, 0]);
    // the holder must be on the point to score
    steps(r.sim, 2 * T, () => { a.x = r.w.map.spawns[0].x; a.y = r.w.map.spawns[0].y; b.x = r.w.map.spawns[6].x; b.y = r.w.map.spawns[6].y; });
    expect(r.obj.teamPoints).toEqual([3, 0]);
    expect(r.w.match.teamScores).toEqual([3, 0]);
    expect(r.obj.stats.get(1)!.hotHoldTicks).toBeGreaterThanOrEqual(6 * T);
  });

  it('FFA: the owner is a player; 2+ players inside is contested; points go to playerPoints', () => {
    const r = rig({ mode: 'ffa', teamCount: 0 }, 3);
    const [p1, p2] = r.ships;
    const z = r.z();
    expect(r.obj.teamPoints).toEqual([]);
    r.sim.drainEvents();
    steps(r.sim, HOT_CAP_SEC * T, () => place(p1, z.x, z.y));
    expect([z.owner, z.ownerPlayerId]).toEqual([-1, 1]);
    expect(objEvents(r.sim.drainEvents(), 'zoneCaptured').map((e) => [e.team, e.playerId])).toEqual([[-1, 1]]);
    steps(r.sim, 2 * T, () => place(p1, z.x, z.y));
    expect(r.obj.playerPoints.get(1)).toBe(2);
    steps(r.sim, 2 * T, () => { place(p1, z.x, z.y); place(p2, z.x, z.y + 20); });
    expect(z.contested).toBe(true);
    expect(r.obj.playerPoints.get(1)).toBe(2);
    expect(r.obj.playerPoints.get(2) ?? 0).toBe(0);
    const v = buildObjectiveView(r.w)!;
    expect(v.playerPoints).toEqual([[1, 2]]);
    expect(v.zones![0]).toMatchObject({ owner: -1, ownerPid: 1, contested: true });
    expect(r.w.match.teamScores).toEqual([]);
  });

  it('FFA respawns avoid spawn points within 800 px of the active site', () => {
    const r = rig({ mode: 'ffa', teamCount: 0 }, 4);
    const z = r.z();
    // the map does have FFA spawns inside the avoid radius (so the rule is exercised)
    expect(r.w.map.spawns.some((s) => dist(s, z) <= HOT_FFA_SPAWN_AVOID)).toBe(true);
    for (let i = 0; i < 40; i++) {
      const p = objectiveSpawnPoint(r.w, r.ships[i % 4])!;
      expect(p).not.toBeNull();
      expect(dist(p, z)).toBeGreaterThan(HOT_FFA_SPAWN_AVOID);
      r.sim.step();
    }
    const victim = r.ships[1];
    kill(r.sim, victim, r.ships[0]);
    steps(r.sim, 3 * T + 2);
    expect(victim.alive).toBe(true);
    expect(dist(victim, z)).toBeGreaterThan(HOT_FFA_SPAWN_AVOID);
    // teams mode keeps the default team spawns
    const t = rig();
    expect(objectiveSpawnPoint(t.w, t.ships[0])).toBeNull();
  });

  it('overtime at time-out while contested runs until 1 s after it stops', () => {
    const r = rig({ matchSeconds: 20 });
    const [a, b] = r.ships;
    const z = r.z();
    steps(r.sim, 8 * T, () => place(a, z.x, z.y)); // a caps (5 s) and holds
    expect(z.owner).toBe(0);
    steps(r.sim, 20 * T - r.w.tick - 1, () => { place(a, z.x, z.y); place(b, z.x + 30, z.y); });
    r.sim.drainEvents();
    place(a, z.x, z.y); place(b, z.x + 30, z.y);
    r.sim.step(); // time-out tick: contested → overtime
    expect(r.w.match.phase).toBe('playing');
    expect(r.obj.overtime).toBe(true);
    expect(objEvents(r.sim.drainEvents(), 'overtime').map((e) => e.value)).toEqual([HOT_OT_CAP_SEC]);
    expect(buildObjectiveView(r.w)!.overtime).toBe(true);
    steps(r.sim, 5 * T, () => { place(a, z.x, z.y); place(b, z.x + 30, z.y); });
    expect(r.w.match.phase).toBe('playing');
    // b leaves: 1 s later the match ends, team 0 on top
    const bs = r.w.map.spawns.find((s) => s.team === 1)!;
    let n = 0;
    while (r.w.match.phase === 'playing' && n < 500) { place(a, z.x, z.y); place(b, bs.x, bs.y); r.sim.step(); n++; }
    expect(n).toBe(T);
    expect(r.w.match.winnerTeam).toBe(0);
    // capped at 60 s while it stays contested
    const q = rig({ matchSeconds: 10 });
    const [qa, qb] = q.ships;
    const qz = q.z();
    let ticks = 0;
    while (q.w.match.phase === 'playing' && ticks < 200 * T) { place(qa, qz.x, qz.y); place(qb, qz.x + 20, qz.y); q.sim.step(); ticks++; }
    expect(q.w.match.phase).toBe('ended');
    expect(q.w.tick).toBeGreaterThanOrEqual(10 * T + HOT_OT_CAP_SEC * T);
    expect(q.w.tick).toBeLessThanOrEqual(10 * T + HOT_OT_CAP_SEC * T + 1);
    expect(q.w.match.winnerTeam).toBe(-1); // 0–0 → draw
  });

  it('a minute-multiple match (180 s) keeps its last point: no warn or move at the time-out, so overtime can trigger', () => {
    const r = rig({ matchSeconds: 180, lootMult: 4 });
    const [a, b] = r.ships;
    const h = r.obj.hot!;
    const all: GameEvent[] = [];
    // Park both until 150 s (two regular moves, at 60 s and 120 s).
    steps(r.sim, 150 * T - r.w.tick, () => { park(r.sim, a); park(r.sim, b); });
    all.push(...r.sim.drainEvents());
    expect(h.moves).toBe(2);
    const z = r.z();
    // a caps and holds the final point; b contests from 172 s.
    steps(r.sim, 172 * T - r.w.tick, () => { place(a, z.x, z.y); park(r.sim, b); });
    expect(z.owner).toBe(0);
    steps(r.sim, 180 * T - r.w.tick - 1, () => { place(a, z.x, z.y); place(b, z.x + 30, z.y); });
    all.push(...r.sim.drainEvents());
    expect(objEvents(all, 'hotWarn').length).toBe(2); // 50 s and 110 s only — never "moves in 10 s" at 170 s
    expect(h.nextSite).toBe(-1);
    place(a, z.x, z.y); place(b, z.x + 30, z.y);
    r.sim.step(); // the time-out tick
    const ev = r.sim.drainEvents();
    expect(r.w.match.phase).toBe('playing');
    expect(r.obj.overtime).toBe(true);
    expect(objEvents(ev, 'overtime').length).toBe(1);
    expect(objEvents(ev, 'hotMoved').length).toBe(0);
    expect(ev.filter((e) => e.t === 'lootDrop' && e.source === 'hotHold').length).toBe(0);
    expect([h.moves, r.z().owner, r.z().active]).toEqual([2, 0, true]);
    // b leaves: overtime ends 1 s later and a's team wins on points.
    let n = 0;
    while (r.w.match.phase === 'playing' && n < 500) { place(a, z.x, z.y); park(r.sim, b); r.sim.step(); n++; }
    expect(n).toBe(T);
    expect(r.w.match.winnerTeam).toBe(0);
    // An untimed match (endTick 0) keeps relocating.
    const u = rig({ matchSeconds: 0, objectiveLimit: 500 });
    steps(u.sim, 3 * HOT_MOVE_SEC * T + 5);
    expect(u.obj.hot!.moves).toBe(3);
  }, 30_000);

  it('the relocation order mixes the server-only lootSeed (a client with mapSeed alone cannot precompute it)', () => {
    const order = (lootSeed: number) => {
      const r = rig({ mapSeed: 4242, lootSeed }, 0);
      const h = r.obj.hot!, seq: number[] = [];
      for (let m = 0; m < 8; m++) {
        const next = pickNextSite(r.w, r.obj);
        seq.push(next);
        h.recent = [h.site, ...h.recent].slice(0, 2); h.site = next; h.moves++;
      }
      return seq.join(',');
    };
    expect(order(11)).toBe(order(11));
    const seqs = new Set([1, 2, 3, 4, 5, 6].map(order));
    expect(seqs.size).toBeGreaterThan(1);
  });

  it('hotFirstCap and hotHold loot rolls (first capture of each site; the holder at relocation)', () => {
    const r = rig({ lootMult: 4 });
    const [a] = r.ships;
    const z = r.z();
    steps(r.sim, HOT_CAP_SEC * T + 2, () => place(a, z.x, z.y));
    expect(r.sim.drainEvents().filter((e) => e.t === 'lootDrop' && e.source === 'hotFirstCap').length).toBe(1);
    steps(r.sim, HOT_MOVE_SEC * T - r.w.tick + 1);
    expect(r.obj.hot!.moves).toBe(1);
    expect(r.sim.drainEvents().filter((e) => e.t === 'lootDrop' && e.source === 'hotHold').length).toBe(1);
  });
});

// =============================================================================================
describe('neutral hooks outside objective sub-modes', () => {
  it('deathmatch and escort have no objective and neutral hooks', () => {
    for (const o of [{ subMode: 'deathmatch' as SubMode }, { subMode: 'escort' as SubMode, teamCount: 2 }]) {
      const sim = new Sim(cfg(o));
      const w = sim.world;
      const s = add(sim, 1, 'brute', 0);
      expect(w.objective).toBeNull();
      expect(isCarrier(w, s)).toBe(false);
      expect(objSpeedMult(w, s)).toBe(1);
      expect(objRechargeMult(w, s)).toBe(1);
      expect(objMaxTurrets(w, s)).toBe(s.stats.maxTurrets);
      expect(objectiveAnchors(w)).toEqual([]);
      expect(objectiveSpawnPoint(w, s)).toBeNull();
      expect(buildObjectiveView(w)).toBeUndefined();
    }
  });
});
