// SIM v0.3 M3: the objective seam against the REAL sim/objectives module (no mocks). Each combo's suite
// runs only once OBJECTIVES has implemented it (its M1 stub throws "not implemented"), so this file is
// green while the module is mid-build and becomes the integration check the moment a mode lands.
// The SIM-side wiring itself is pinned with a fake in objhooks.test.ts.
import { describe, expect, it } from 'vitest';
import { SPAWN_INVULN_SEC, TICK_RATE } from '../constants';
import type { GameEvent, InputState, MapFeature, Ship, ShipClassId, SimConfig, SubMode } from '../types';
import { emptyInput, SHIPFLAG_CARRIER } from '../types';
import { buildMatchMap } from './mapgen';
import { isCarrier, objMaxTurrets, objSpeedMult } from './objectives/index';
import { CTF_CARRIER_MAX_TURRETS, CTF_CARRIER_SPEED_MULT } from './objectives/rules';
import { Sim } from './Sim';
import { tryAttach } from './turrets';

type Combo = Pick<SimConfig, 'gameType' | 'subMode' | 'mode' | 'teamCount' | 'pveIntensity'>;
const COMBOS: Combo[] = [
  { gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, pveIntensity: 0 },
  { gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 4, pveIntensity: 0 },
  { gameType: 'arena', subMode: 'zones', mode: 'teams', teamCount: 3, pveIntensity: 0 },
  { gameType: 'arena', subMode: 'hotpoint', mode: 'teams', teamCount: 2, pveIntensity: 0 },
  { gameType: 'arena', subMode: 'hotpoint', mode: 'ffa', teamCount: 0, pveIntensity: 0 },
  { gameType: 'warzone', subMode: 'zones', mode: 'teams', teamCount: 2, pveIntensity: 2 },
];
const cfg = (c: Combo, o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 2468, matchSeconds: 600, scoreLimit: 0, friendlyFire: false, ...c, ...o,
});
const label = (c: Combo) => `${c.gameType} ${c.subMode} ${c.mode === 'ffa' ? 'FFA' : c.teamCount + ' teams'}`;

/** True once OBJECTIVES implements this combo (map features + objectivesInit no longer throw). */
function implemented(c: Combo): boolean {
  try {
    new Sim(cfg(c));
    return true;
  } catch (e) {
    if (/not implemented/i.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), ...o });
function add(sim: Sim, pid: number, cls: ShipClassId, team: number): Ship {
  return sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot: true }))!;
}

/**
 * 8 scripted ships (no AI), 40 s. Collects per-tick seam-invariant violations (first 20) and an event trace.
 */
function run(c: Combo): { sim: Sim; trace: string[]; bad: string[] } {
  const sim = new Sim(cfg(c));
  const w = sim.world;
  const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
  const teams = c.mode === 'teams' ? c.teamCount : 1;
  for (let i = 1; i <= 8; i++) add(sim, i, cls[i % 3], i % teams);
  const trace: string[] = [], bad: string[] = [];
  const check = (ok: boolean, what: string) => { if (!ok && bad.length < 20) bad.push(`tick ${w.tick}: ${what}`); };
  for (let k = 0; k < TICK_RATE * 40; k++) {
    for (let i = 1; i <= 8; i++) {
      const a = (k * 0.013 + i * 1.7) % 6.283;
      sim.setInput(i, inp({
        seq: k, moveX: Math.cos(a), moveY: Math.sin(a), aim: a, aimDist: 300, primary: k % 30 < 10,
        mobility: k % 200 === i, attach: k % 300 === i * 9, detach: k % 300 === i * 9 + 120,
      }));
    }
    sim.step();
    const o = w.objective!;
    // teamScores mirror teamPoints (never ship.score)
    for (let t = 0; t < w.match.teamScores.length; t++) {
      check(w.match.teamScores[t] === (o.teamPoints[t] ?? 0), `teamScores[${t}] ${w.match.teamScores[t]} ≠ teamPoints ${o.teamPoints[t]}`);
    }
    for (const s of w.ships.values()) {
      if (!s.alive) continue;
      const carrier = isCarrier(w, s);
      // the carrier bit that client prediction reads is exactly the sim's carrier state
      check(!!(s.flags & SHIPFLAG_CARRIER) === carrier, `ship ${s.id} carrier ${carrier} but flag bit ${s.flags & SHIPFLAG_CARRIER}`);
      if (carrier) {
        check(s.attachedTo === 0, `carrier ${s.id} is attached as a turret`);
        check(s.turrets.length <= CTF_CARRIER_MAX_TURRETS, `carrier ${s.id} has ${s.turrets.length} turrets`);
      }
      check(s.turrets.length <= objMaxTurrets(w, s), `host ${s.id} has ${s.turrets.length} > objMaxTurrets`);
    }
    const ev: GameEvent[] = sim.drainEvents();
    if (ev.length) trace.push(k + ':' + JSON.stringify(ev));
    if (w.match.phase === 'ended') break;
  }
  return { sim, trace, bad };
}

for (const c of COMBOS) {
  describe.runIf(implemented(c))(`objective seam, real OBJECTIVES: ${label(c)}`, () => {
    it('buildMatchMap is deterministic including features; the Sim\'s map has them', () => {
      const p = { seed: 2468, gameType: c.gameType!, subMode: c.subMode as SubMode, teamCount: c.teamCount, floor: 0 };
      const a = buildMatchMap(p), b = buildMatchMap({ ...p });
      expect(a.tiles).toEqual(b.tiles);
      expect(a.features).toEqual(b.features);
      expect(a.features!.length).toBeGreaterThan(0);
      const sim = new Sim(cfg(c));
      expect(sim.world.map.tiles).toEqual(a.tiles);
      expect(sim.world.map.features).toEqual(a.features);
      expect(sim.world.objective?.mode).toBe(c.subMode);
    });

    it('40 s of scripted play: seam invariants hold every tick, and the run is deterministic', () => {
      const r1 = run(c), r2 = run(c);
      expect(r1.bad).toEqual([]);
      expect(r2.trace).toEqual(r1.trace);
      expect(r2.sim.world.tick).toBe(r1.sim.world.tick);
      for (const [id, s] of r1.sim.world.ships) {
        const t = r2.sim.world.ships.get(id)!;
        expect([t.x, t.y, t.energy, t.score]).toEqual([s.x, s.y, s.energy, s.score]);
      }
      expect(r2.sim.world.match.teamScores).toEqual(r1.sim.world.match.teamScores);
    });
  });
}

// CTF end to end through the SIM hooks: pickup → carrier rules → capture mirrored into teamScores.
const CTF2 = COMBOS[0];
describe.runIf(implemented(CTF2))('CTF carrier through the SIM hooks (real OBJECTIVES)', () => {
  function rig() {
    const sim = new Sim(cfg(CTF2));
    const w = sim.world;
    const runner = add(sim, 1, 'tech', 0), mate = add(sim, 2, 'brute', 0), foe = add(sim, 3, 'engineer', 1);
    for (let i = 0; i < SPAWN_INVULN_SEC * TICK_RATE + 5; i++) sim.step();
    const stand = (team: number): MapFeature => w.map.features!.find((f) => f.kind === 'flagStand' && f.team === team)!;
    return { sim, w, runner, mate, foe, own: stand(0), enemy: stand(1) };
  }
  const put = (s: Ship, x: number, y: number) => { s.x = x; s.y = y; s.vx = 0; s.vy = 0; };

  it('touching the enemy stand makes a carrier: flag bit, ×speed, no attaching, gunner cap', () => {
    const { sim, w, runner, mate, enemy } = rig();
    put(runner, enemy.x, enemy.y);
    sim.step(); sim.step();
    expect(isCarrier(w, runner)).toBe(true);
    expect(runner.flags & SHIPFLAG_CARRIER).toBe(SHIPFLAG_CARRIER);
    expect(objSpeedMult(w, runner)).toBeCloseTo(CTF_CARRIER_SPEED_MULT, 9);
    expect(objMaxTurrets(w, runner)).toBe(Math.min(runner.stats.maxTurrets, CTF_CARRIER_MAX_TURRETS));
    runner.input.attachTarget = mate.id;
    expect(tryAttach(w, runner)).toBe(false);
    expect(runner.attachedTo).toBe(0);
  });

  it('a team swap drops the flag (no longer a carrier)', () => {
    const { sim, w, runner, enemy } = rig();
    put(runner, enemy.x, enemy.y);
    sim.step(); sim.step();
    expect(isCarrier(w, runner)).toBe(true);
    sim.setPlayerTeam(1, 1);
    sim.step();
    expect(isCarrier(w, runner)).toBe(false);
    expect(w.objective!.flags[1].state).not.toBe('carried');
  });

  it('a capture scores objective points, and teamScores mirror them (not ship.score)', () => {
    const { sim, w, runner, own, enemy } = rig();
    put(runner, enemy.x, enemy.y);
    sim.step(); sim.step();
    expect(isCarrier(w, runner)).toBe(true);
    put(runner, own.x, own.y);
    for (let i = 0; i < 3 && w.objective!.teamPoints[0] === 0; i++) sim.step();
    expect(w.objective!.teamPoints[0]).toBe(1);
    expect(w.match.teamScores).toEqual([1, 0]);
    expect(runner.score).toBeGreaterThan(1); // personal score is separate from the team scoreline
  });
});

describe('objective seam status', () => {
  it('reports which combos run against the real module (informational)', () => {
    const status = COMBOS.map((c) => `${label(c)}: ${implemented(c) ? 'live' : 'stub'}`);
    expect(status.length).toBe(COMBOS.length);
  });
});
