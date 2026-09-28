// SIM v0.3 M3 acceptance (docs/v0.3-proposal.md §5.2, §5.3, §9 SIM M3): the objective hooks as the SIM
// wires them — pass 1 × objSpeedMult, pass 3 × objRechargeMult, objectiveRelease first in spawnShip (and
// in team swap / in-place class swap / leave), the objectiveSpawnPoint override, stepMatch mirroring
// teamPoints and delegating to objectiveEndCheck, turrets (carrier never attaches; objMaxTurrets gunner
// cap), Blink × CTF_CARRIER_BLINK_MULT, and buildMatchMap's objective branch.
//
// The OBJECTIVES module is replaced by a controllable fake (vi.mock), so these tests pin the SIM side of
// the seam only; the real rules are OBJECTIVES' tests (objectives.test.ts) and objhooks.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DT, HOST_SPEED_PENALTY_PER_TURRET, SPAWN_INVULN_SEC, TICK_RATE } from '../constants';
import type { GameEvent, GameMap, InputState, ObjectiveState, Ship, ShipClassId, SimConfig, SubMode, World } from '../types';
import { emptyInput } from '../types';
import { collideCircle, generateMap, isSolidAt } from './map';
import { buildMatchMap } from './mapgen';
import { CTF_CARRIER_BLINK_MULT, CTF_CARRIER_MAX_TURRETS } from './objectives/rules';
import { Sim } from './Sim';
import { isValidHost, tryAttach } from './turrets';

interface Released { id: number; x: number; y: number; team: number; alive: boolean; cls: string }

const fake = vi.hoisted(() => ({
  /** objectivesInit installs a fake ObjectiveState (else world.objective = null). */
  on: true,
  carriers: new Set<number>(),
  speed: 1,
  recharge: 1,
  spawnAt: null as null | { x: number; y: number },
  released: [] as Released[],
  end: null as null | ((w: World) => 'continue' | 'ended'),
  endCalls: 0,
  features: [] as { subMode: string; seed: number; tilesHash: string; cols: number; teamCount: number }[],
}));

vi.mock('./objectives/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('./objectives/index')>();
  const hashTiles = (m: GameMap) => Array.from(m.tiles).join('').length + ':' + Array.from(m.tiles).reduce((h, t, i) => (h * 31 + t * (i + 1)) >>> 0, 7);
  const carrier = (w: World, s: Ship) => !!w.objective && fake.carriers.has(s.id);
  return {
    ...real,
    placeObjectiveFeatures: (map: GameMap, subMode: SubMode, seed: number) => {
      fake.features.push({ subMode, seed, tilesHash: hashTiles(map), cols: map.cols, teamCount: map.teamCount });
      map.features = [{ kind: 'zone', team: -1, index: 0, x: map.width / 2, y: map.height / 2, radius: 200 }];
    },
    objectivesInit: (w: World) => {
      const sub = w.config.subMode!;
      if (!fake.on || !(sub === 'ctf' || sub === 'zones' || sub === 'hotpoint')) { w.objective = null; return; }
      const st: ObjectiveState = {
        mode: sub, limit: 3, teamPoints: new Array(w.config.mode === 'teams' ? w.config.teamCount : 0).fill(0),
        playerPoints: new Map(), flags: [], zones: [], hot: null, overtime: false, overtimeCapTick: 0,
        suddenDeath: false, extensions: 0, stats: new Map(), mem: {},
      };
      w.objective = st;
    },
    stepObjectives: () => {},
    objectiveEndCheck: (w: World) => { fake.endCalls++; return fake.end ? fake.end(w) : 'continue'; },
    objectiveSpawnPoint: (w: World) => (w.objective ? fake.spawnAt : null),
    objectiveRelease: (w: World, s: Ship) => {
      if (w.objective) fake.released.push({ id: s.id, x: s.x, y: s.y, team: s.team, alive: s.alive, cls: s.shipClass });
    },
    isCarrier: carrier,
    objSpeedMult: (w: World, s: Ship) => (carrier(w, s) ? fake.speed : 1),
    objRechargeMult: (w: World, s: Ship) => (carrier(w, s) ? fake.recharge : 1),
    objMaxTurrets: (w: World, h: Ship) => (carrier(w, h) ? Math.min(h.stats.maxTurrets, 1) : h.stats.maxTurrets),
  };
});

beforeEach(() => {
  fake.on = true;
  fake.carriers.clear();
  fake.speed = 1; fake.recharge = 1;
  fake.spawnAt = null;
  fake.released.length = 0;
  fake.end = null; fake.endCalls = 0;
  fake.features.length = 0;
});

const ctf = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 777, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false,
  gameType: 'arena', subMode: 'ctf', ...o,
});
function add(sim: Sim, pid: number, cls: ShipClassId, team = 0): Ship {
  return sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot: false }))!;
}
const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), ...o });
function steps(sim: Sim, n: number): void { for (let i = 0; i < n; i++) sim.step(); }
function settle(sim: Sim): void { steps(sim, SPAWN_INVULN_SEC * TICK_RATE + 5); }
function place(s: Ship, x: number, y: number): void { s.x = x; s.y = y; s.vx = 0; s.vy = 0; }
/** A spot with `len` px of open space along +x for a hull of radius r (and a 480×320 open box around it). */
function openLane(sim: Sim, len: number, r = 24): { x: number; y: number } {
  const m = sim.world.map;
  for (let y = 600; y < m.height - 600; y += 32) {
    for (let x = 600; x < m.width - 600 - len; x += 32) {
      let ok = true;
      for (let t = 0; t <= len + 16 && ok; t += 8) if (collideCircle(m, x + t, y, r).hit) ok = false;
      for (let dy = -160; dy <= 160 && ok; dy += 16) for (let dx = -240; dx <= 240 && ok; dx += 16) if (isSolidAt(m, x + dx, y + dy)) ok = false;
      if (ok) return { x, y };
    }
  }
  throw new Error('no open lane');
}
function attach(sim: Sim, t: Ship, host: Ship): boolean {
  sim.setInput(t.playerId, inp({ attach: true, attachTarget: host.id }));
  sim.step();
  sim.setInput(t.playerId, inp());
  sim.step();
  return t.attachedTo === host.id;
}

// ---------------------------------------------------------------------------------------------
describe('buildMatchMap objective branch (§5.1)', () => {
  it('objective sub-modes add features to the unchanged generateMap layout; deathmatch / dungeon never do', () => {
    const cases: [SubMode, 'arena' | 'warzone', number][] = [['ctf', 'arena', 2], ['ctf', 'arena', 4], ['zones', 'arena', 3], ['zones', 'warzone', 8], ['hotpoint', 'arena', 0], ['hotpoint', 'arena', 2]];
    for (const [subMode, gameType, teamCount] of cases) {
      fake.features.length = 0;
      const seed = 4100 + teamCount;
      const m = buildMatchMap({ seed, gameType, subMode, teamCount, floor: 0 });
      const ref = generateMap(seed, teamCount);
      expect(fake.features.length, subMode).toBe(1);
      const call = fake.features[0];
      expect([call.subMode, call.seed, call.cols, call.teamCount]).toEqual([subMode, seed, ref.cols, ref.teamCount]);
      // the features pass got the byte-identical v0.2 map (fake carves nothing, so it is still identical)
      expect(m.tiles).toEqual(ref.tiles);
      expect(m.spawns).toEqual(ref.spawns);
      expect(m.features?.length).toBe(1);
    }
    fake.features.length = 0;
    for (const gameType of ['arena', 'warzone'] as const) {
      expect(buildMatchMap({ seed: 5, gameType, subMode: 'deathmatch', teamCount: 2, floor: 0 }).features).toBeUndefined();
    }
    expect(buildMatchMap({ seed: 5, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 1 }).features).toBeUndefined();
    expect(fake.features.length).toBe(0);
  });

  it('the Sim builds its map through it with the NORMALIZED combo (a fallen-back combo gets no features)', () => {
    const sim = new Sim(ctf({ teamCount: 4, mapSeed: 99 }));
    expect(fake.features.map((f) => [f.subMode, f.seed, f.teamCount])).toEqual([['ctf', 99, 4]]);
    expect(sim.world.map.features?.length).toBe(1);
    expect(sim.world.objective?.mode).toBe('ctf');

    fake.features.length = 0;
    const hot = new Sim(ctf({ subMode: 'hotpoint', mode: 'ffa', teamCount: 5 }));
    expect(fake.features.map((f) => [f.subMode, f.teamCount])).toEqual([['hotpoint', 0]]);
    expect(hot.world.match.teamScores).toEqual([]);

    fake.features.length = 0;
    const fell = new Sim(ctf({ mode: 'ffa' })); // FFA CTF is illegal → deathmatch
    expect(fell.world.config.subMode).toBe('deathmatch');
    expect(fake.features.length).toBe(0);
    expect(fell.world.map.features).toBeUndefined();
    expect(fell.world.objective).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('stepMatch in objective sub-modes (§5.2)', () => {
  it('teamScores mirror objective.teamPoints every tick and are never rebuilt from ship.score', () => {
    const sim = new Sim(ctf());
    const w = sim.world;
    const a = add(sim, 1, 'brute', 0), b = add(sim, 2, 'tech', 1);
    a.score = 5000; b.score = 12;
    sim.step();
    expect(w.match.teamScores).toEqual([0, 0]);
    w.objective!.teamPoints[0] = 1; w.objective!.teamPoints[1] = 2;
    sim.step();
    expect(w.match.teamScores).toEqual([1, 2]);
    a.score += 777; // kills and personal score never leak into the team scoreline
    w.objective!.teamPoints[1] = 3;
    sim.step();
    expect(w.match.teamScores).toEqual([1, 3]);
    // junk points never poison the scoreline
    w.objective!.teamPoints[0] = NaN;
    w.objective!.teamPoints.length = 1;
    sim.step();
    expect(w.match.teamScores).toEqual([0, 0]);
  });

  it('time-up and scoreLimit do not end the match by themselves: objectiveEndCheck decides, every tick', () => {
    const sim = new Sim(ctf({ matchSeconds: 1 }));
    const w = sim.world;
    const a = add(sim, 1, 'brute', 0);
    w.config.scoreLimit = 10; // normalizeSimConfig already zeroes it for objective sub-modes; forced here
    a.score = 1e6;
    steps(sim, TICK_RATE * 3); // well past endTick
    expect(w.tick).toBeGreaterThan(w.match.endTick);
    expect(w.match.phase).toBe('playing');
    expect(fake.endCalls).toBe(TICK_RATE * 3);
    expect(sim.drainEvents().some((e) => e.t === 'matchEnd')).toBe(false);
  });

  it("'ended' closes the match with the hook's winner, emits matchEnd once, and stops calling the hook", () => {
    const sim = new Sim(ctf({ teamCount: 3 }));
    const w = sim.world;
    add(sim, 1, 'brute', 0); add(sim, 2, 'tech', 1); add(sim, 3, 'engineer', 2);
    steps(sim, 10);
    sim.drainEvents();
    fake.end = (world) => {
      world.objective!.teamPoints[2] = 3; // e.g. the capture that settles it, counted this tick
      world.match.winnerTeam = 2;
      world.match.winnerPlayerId = 0;
      return 'ended';
    };
    sim.step();
    expect(w.match.phase).toBe('ended');
    expect(w.match.teamScores).toEqual([0, 0, 3]);
    const ends = sim.drainEvents().filter((e): e is Extract<GameEvent, { t: 'matchEnd' }> => e.t === 'matchEnd');
    expect(ends).toEqual([{ t: 'matchEnd', winnerTeam: 2, winnerPlayerId: 0 }]);
    const calls = fake.endCalls;
    steps(sim, 30);
    expect(fake.endCalls).toBe(calls);
    expect(sim.drainEvents().some((e) => e.t === 'matchEnd')).toBe(false);
  });

  it('a hook that emits its own matchEnd is not doubled; a draw (-1 / 0) passes through', () => {
    const sim = new Sim(ctf());
    add(sim, 1, 'brute', 0);
    sim.drainEvents();
    fake.end = (world) => {
      world.match.winnerTeam = -1; world.match.winnerPlayerId = 0;
      world.events.push({ t: 'matchEnd', winnerTeam: -1, winnerPlayerId: 0 });
      return 'ended';
    };
    sim.step();
    expect(sim.drainEvents().filter((e) => e.t === 'matchEnd')).toEqual([{ t: 'matchEnd', winnerTeam: -1, winnerPlayerId: 0 }]);
    expect(sim.world.match.phase).toBe('ended');
  });

  it('FFA Hot Point: teamScores stay [], the hook\'s winnerPlayerId is used (not the top ship.score)', () => {
    const sim = new Sim(ctf({ subMode: 'hotpoint', mode: 'ffa', teamCount: 0 }));
    const a = add(sim, 1, 'brute'), b = add(sim, 2, 'tech');
    a.score = 900; b.score = 10;
    fake.end = (world) => { world.match.winnerPlayerId = 2; world.match.winnerTeam = -1; return 'ended'; };
    sim.step();
    expect(sim.world.match.teamScores).toEqual([]);
    expect(sim.drainEvents().filter((e) => e.t === 'matchEnd')).toEqual([{ t: 'matchEnd', winnerTeam: -1, winnerPlayerId: 2 }]);
  });

  it('deathmatch (world.objective null) never consults objectiveEndCheck and keeps the v0.2 rules', () => {
    const sim = new Sim(ctf({ subMode: 'deathmatch', matchSeconds: 1 }));
    expect(sim.world.objective).toBeNull();
    const a = add(sim, 1, 'brute', 0);
    a.score = 40;
    steps(sim, TICK_RATE + 2);
    expect(fake.endCalls).toBe(0);
    expect(sim.world.match.phase).toBe('ended');
    expect(sim.world.match.teamScores).toEqual([40, 0]); // DM: rebuilt from ship.score
  });
});

// ---------------------------------------------------------------------------------------------
describe('pass 1 speed × objSpeedMult, pass 3 recharge × objRechargeMult', () => {
  function rig() {
    const sim = new Sim(ctf());
    const c = add(sim, 1, 'brute', 0), n = add(sim, 2, 'brute', 0);
    settle(sim);
    const p = openLane(sim, 0);
    place(c, p.x - 150, p.y); place(n, p.x + 150, p.y);
    return { sim, c, n };
  }

  it('a carrier accelerates / tops out at × objSpeedMult (0.88 → 0.82 with one gunner, as §5.3)', () => {
    const { sim, c, n } = rig();
    fake.carriers.add(c.id);
    fake.speed = 0.88;
    sim.setInput(1, inp({ moveX: 1 })); sim.setInput(2, inp({ moveX: 1 }));
    sim.step();
    expect(n.vx).toBeCloseTo(n.stats.thrust * DT, 9);
    expect(c.vx / n.vx).toBeCloseTo(0.88, 9);
    // with one gunner the host turret penalty multiplies in: 0.93 × 0.88 ≈ 0.82
    const g = add(sim, 3, 'tech', 0);
    settle(sim);
    place(c, n.x - 300, n.y); place(n, n.x, n.y);
    expect(attach(sim, g, c)).toBe(true);
    c.vx = c.vy = n.vx = n.vy = 0;
    sim.setInput(1, inp({ moveX: 1 })); sim.setInput(2, inp({ moveX: 1 }));
    sim.step();
    expect(c.vx / n.vx).toBeCloseTo((1 - HOST_SPEED_PENALTY_PER_TURRET) * 0.88, 9);
    expect(c.vx / n.vx).toBeCloseTo(0.82, 2);
  });

  it('Flag Overload: recharge × 0.5 then × 0; non-carriers recharge normally', () => {
    const { sim, c, n } = rig();
    fake.carriers.add(c.id);
    for (const mult of [0.5, 0]) {
      fake.recharge = mult;
      c.energy = c.stats.maxEnergy * 0.5; n.energy = n.stats.maxEnergy * 0.5;
      const c0 = c.energy, n0 = n.energy;
      sim.step();
      expect(n.energy - n0).toBeCloseTo(n.stats.rechargePerSec * DT, 9);
      expect(c.energy - c0).toBeCloseTo(c.stats.rechargePerSec * mult * DT, 9);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('spawnShip: objectiveRelease first, then objectiveSpawnPoint (§5.2)', () => {
  it('a respawn releases at the pre-teleport position, then lands on the objective override', () => {
    const sim = new Sim(ctf());
    const s = add(sim, 1, 'brute', 0);
    settle(sim);
    const p = openLane(sim, 0);
    place(s, p.x, p.y);
    s.alive = false; s.respawnTick = sim.world.tick + 1;
    fake.released.length = 0;
    fake.spawnAt = { x: p.x + 64, y: p.y - 32 };
    sim.step();
    expect(fake.released).toEqual([{ id: s.id, x: p.x, y: p.y, team: 0, alive: false, cls: 'brute' }]);
    expect([s.alive, s.x, s.y]).toEqual([true, p.x + 64, p.y - 32]);
  });

  it('a null override uses a team spawn; Field Revive\'s explicit spot beats the override', () => {
    const sim = new Sim(ctf());
    const w = sim.world;
    const s = add(sim, 1, 'brute', 1);
    expect(w.map.spawns.some((q) => q.team === 1 && q.x === s.x && q.y === s.y)).toBe(true);

    const medic = add(sim, 2, 'engineer', 1);
    settle(sim);
    medic.upgrades['path:medic'] = 1; medic.upgrades.med_revive = 1; medic.path = 'medic';
    const p = openLane(sim, 0);
    place(medic, p.x, p.y); place(s, p.x + 120, p.y);
    s.alive = false; s.respawnTick = w.tick + 60 * 60;
    fake.spawnAt = { x: 100, y: 100 };
    sim.step();
    expect(s.alive).toBe(true);
    expect(Math.hypot(s.x - medic.x, s.y - medic.y)).toBeLessThan(1);
  });

  it('team swap releases on the OLD team; in-place class swap and leave release where the ship is', () => {
    const sim = new Sim(ctf());
    const s = add(sim, 1, 'brute', 0);
    settle(sim);
    const p = openLane(sim, 0);
    place(s, p.x, p.y);
    fake.released.length = 0;
    sim.setPlayerTeam(1, 1);
    expect(fake.released[0]).toEqual({ id: s.id, x: p.x, y: p.y, team: 0, alive: true, cls: 'brute' });
    expect(s.team).toBe(1);

    place(s, p.x, p.y);
    fake.released.length = 0;
    sim.setShipClass(1, 'tech');
    expect(fake.released).toEqual([{ id: s.id, x: p.x, y: p.y, team: 1, alive: true, cls: 'brute' }]);
    expect([s.alive, s.x, s.y, s.shipClass]).toEqual([true, p.x, p.y, 'tech']);

    fake.released.length = 0;
    sim.removePlayer(1);
    expect(fake.released).toEqual([{ id: s.id, x: p.x, y: p.y, team: 1, alive: true, cls: 'tech' }]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('turrets: carriers never attach; objMaxTurrets caps a carrier host at the gunner seat (§5.3)', () => {
  function rig() {
    const sim = new Sim(ctf());
    const host = add(sim, 1, 'engineer', 0); // 3 turret slots
    const t1 = add(sim, 2, 'tech', 0), t2 = add(sim, 3, 'brute', 0), other = add(sim, 4, 'engineer', 0);
    settle(sim);
    const p = openLane(sim, 0);
    place(host, p.x, p.y); place(t1, p.x + 80, p.y); place(t2, p.x - 80, p.y); place(other, p.x, p.y + 120);
    sim.step();
    return { sim, host, t1, t2, other };
  }

  it('a carrier cannot attach as a turret (control: the same ship attaches once it is not carrying)', () => {
    const { sim, host, t1 } = rig();
    fake.carriers.add(t1.id);
    expect(attach(sim, t1, host)).toBe(false);
    expect(t1.attachedTo).toBe(0);
    expect(host.turrets).toEqual([]);
    expect(tryAttach(sim.world, t1)).toBe(false);
    fake.carriers.delete(t1.id);
    t1.attachReadyTick = 0;
    expect(attach(sim, t1, host)).toBe(true);
  });

  it(`a carrier host takes ${CTF_CARRIER_MAX_TURRETS} gunner; an extra attacher warps to another host instead`, () => {
    const { sim, host, t1, t2, other } = rig();
    fake.carriers.add(host.id);
    expect(host.stats.maxTurrets).toBeGreaterThan(CTF_CARRIER_MAX_TURRETS);
    expect(attach(sim, t1, host)).toBe(true);
    expect(isValidHost(sim.world, t2, host)).toBe(false);
    expect(isValidHost(sim.world, t2, other)).toBe(true);
    expect(attach(sim, t2, host)).toBe(false);
    expect(t2.attachedTo).toBe(other.id); // explicit target refused → nearest valid host to the aim point
    expect(host.turrets).toEqual([t1.id]);
  });

  it('a non-carrier host keeps its full maxTurrets', () => {
    const { sim, host, t1, t2 } = rig();
    expect(attach(sim, t1, host)).toBe(true);
    expect(attach(sim, t2, host)).toBe(true);
    expect(host.turrets).toEqual([t1.id, t2.id]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Blink × CTF_CARRIER_BLINK_MULT for a carrier (§5.3)', () => {
  function blinkDist(carrier: boolean): number {
    const sim = new Sim(ctf());
    const s = add(sim, 1, 'tech', 0);
    settle(sim);
    const range = s.stats.skill.blinkRange ?? 480;
    const p = openLane(sim, range + 40, s.stats.radius + 2);
    place(s, p.x, p.y);
    s.angle = 0;
    if (carrier) fake.carriers.add(s.id); else fake.carriers.delete(s.id);
    s.energy = s.stats.maxEnergy; s.mobilityReadyTick = 0;
    sim.drainEvents();
    sim.setInput(1, inp({ aim: 0, mobility: true }));
    sim.step();
    const ev = sim.drainEvents().find((e): e is Extract<GameEvent, { t: 'blink' }> => e.t === 'blink');
    expect(ev).toBeDefined();
    return Math.hypot(ev!.x - ev!.fromX, ev!.y - ev!.fromY);
  }

  it('halves the teleport distance (walls / edges still stop it as before)', () => {
    const full = blinkDist(false), half = blinkDist(true);
    expect(full).toBeCloseTo(480, 6);
    expect(half).toBeCloseTo(480 * CTF_CARRIER_BLINK_MULT, 6);
  });
});
