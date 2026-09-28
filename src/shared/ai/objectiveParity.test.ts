// OWNER: AI agent. v0.3 M3 AI-parity runs against the REAL Sim (docs/v0.3-proposal.md §5.7 "Ready gate", §9 AI):
// 16 normal bots play each objective sub-mode for 5 sim-minutes and must produce ≥ 1 flagCaptured (CTF),
// ≥ 2 zoneCaptured (Control Zones, Arena and Warzone), or ≥ 1 hot capture + ≥ 2 hotMoved (Hot Point, teams and
// FFA). Plus the M3 PvP fix: a 16-bot Arena Deathmatch makes ≥ 15 PvP kills a minute (mean), and Warzone bots still farm
// the swarm while fighting each other. The Room-level gate (`npm run smoke -- --mode all`) runs the same bots
// through Zone → Room → codec; this file is the AI-side check (no Room, no mocks, fixed seeds, deterministic).
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../constants';
import { Sim } from '../sim/Sim';
import type { GameType, PveIntensity, ShipClassId, SimConfig, SubMode } from '../types';
import { createBotBrain, type BotBrain } from './bots';

interface Opts {
  gameType: GameType; subMode: SubMode; ffa?: boolean; teamCount?: number; pve?: PveIntensity;
  seconds: number; seed: number; bots?: number;
}
interface Tally {
  pvp: number; swarm: number; events: Record<string, number>; ended: boolean; seconds: number;
  /** Zones / hot: mean bots on an active pad per sampled second (turrets on a host on the pad count, as in the sim). */
  onPad: number;
  /** Zones / hot: mean bots within NEAR_PAD_PX of an active pad's edge (playing the objective, fights included). */
  nearPad: number;
}

const CLASSES: readonly ShipClassId[] = ['brute', 'tech', 'engineer'];
const NEAR_PAD_PX = 500;

/** 16 bots on a real Sim: the same loop the Room runs (think → setInput → step), minus the network. */
function play(o: Opts): Tally {
  const bots = o.bots ?? 16;
  const teams = !o.ffa;
  const cfg: SimConfig = {
    mapSeed: (o.seed * 7919 + 13) >>> 0, mode: teams ? 'teams' : 'ffa', teamCount: teams ? (o.teamCount ?? 2) : 0,
    pveIntensity: o.pve ?? 0, matchSeconds: o.seconds + 60, scoreLimit: 0, friendlyFire: false,
    gameType: o.gameType, subMode: o.subMode, lootMult: 0,
  };
  const sim = new Sim(cfg);
  const w = sim.world;
  const tc = teams ? w.config.teamCount : 1;
  const brains = new Map<number, BotBrain>();
  for (let i = 1; i <= bots; i++) {
    sim.addPlayer({
      playerId: i, name: 'bot' + i, team: teams ? (i - 1) % tc : -1,
      shipClass: CLASSES[(((i - 1) / tc) | 0) % CLASSES.length], isBot: true,
    });
    brains.set(i, createBotBrain('normal', (o.seed * 1000 + i * 7919) >>> 0));
  }
  const tally: Tally = { pvp: 0, swarm: 0, events: {}, ended: false, seconds: 0, onPad: 0, nearPad: 0 };
  let padSamples = 0, padBodies = 0, nearBodies = 0;
  const ticks = o.seconds * TICK_RATE;
  for (let k = 0; k < ticks; k++) {
    for (let i = 1; i <= bots; i++) {
      const sid = w.shipsByPlayer.get(i);
      const ship = sid ? w.ships.get(sid) : undefined;
      if (!ship) continue;
      const b = brains.get(i)!;
      sim.setInput(i, b.think(w, ship));
      if (ship.offers.length && (k + i * 7) % 30 === 0) sim.chooseUpgrade(i, b.chooseUpgrade(w, ship, ship.offers[0]), undefined);
    }
    sim.step();
    for (const e of sim.drainEvents()) {
      if (e.t === 'shipDeath' && e.cause === 'player') tally.pvp++;
      else if (e.t === 'enemyDeath') tally.swarm++;
      else if (e.t === 'objective') tally.events[e.kind] = (tally.events[e.kind] ?? 0) + 1;
    }
    const obj = w.objective;
    if (obj && obj.mode !== 'ctf' && k % TICK_RATE === 0) {
      padSamples++;
      for (const s of w.ships.values()) {
        if (!s.alive) continue;
        let on = false, near = false;
        for (const z of obj.zones) {
          if (!z.active) continue;
          const d = Math.hypot(s.x - z.x, s.y - z.y);
          if (d < z.radius) on = true;
          if (d < z.radius + NEAR_PAD_PX) near = true;
        }
        if (on) padBodies++;
        if (near) nearBodies++;
      }
    }
    tally.seconds = (k + 1) / TICK_RATE;
    if (w.match.phase !== 'playing') { tally.ended = true; break; }
  }
  tally.onPad = padSamples ? padBodies / padSamples : 0;
  tally.nearPad = padSamples ? nearBodies / padSamples : 0;
  return tally;
}

const ev = (t: Tally, k: string): number => t.events[k] ?? 0;
const GATE_SEC = 300;
const SLOW = 120_000;

describe('v0.3 M3 AI parity: objective gates on the real Sim (16 bots, 5 sim-minutes)', () => {
  it.each([1, 2])('Arena CTF (2 teams), seed %i: ≥ 1 flagCaptured', (seed) => {
    const t = play({ gameType: 'arena', subMode: 'ctf', seconds: GATE_SEC, seed });
    console.log(`CTF seed ${seed}: ${JSON.stringify(t.events)} pvp ${t.pvp} (${t.seconds} s${t.ended ? ', ended' : ''})`);
    expect(ev(t, 'flagCaptured')).toBeGreaterThanOrEqual(1);
    expect(ev(t, 'flagTaken')).toBeGreaterThanOrEqual(ev(t, 'flagCaptured'));
  }, SLOW);

  it('Arena CTF (3 teams): ≥ 1 flagCaptured', () => {
    const t = play({ gameType: 'arena', subMode: 'ctf', teamCount: 3, seconds: GATE_SEC, seed: 3 });
    console.log(`CTF 3 teams: ${JSON.stringify(t.events)} pvp ${t.pvp}`);
    expect(ev(t, 'flagCaptured')).toBeGreaterThanOrEqual(1);
  }, SLOW);

  it.each([1, 2])('Arena Control Zones (2 teams), seed %i: ≥ 2 zoneCaptured, bots on the pads', (seed) => {
    const t = play({ gameType: 'arena', subMode: 'zones', seconds: GATE_SEC, seed });
    console.log(`Zones seed ${seed}: ${JSON.stringify(t.events)} pvp ${t.pvp} onPad ${t.onPad.toFixed(1)} nearPad ${t.nearPad.toFixed(1)}`);
    expect(ev(t, 'zoneCaptured')).toBeGreaterThanOrEqual(2);
    // bots occupy zones: pilots on the pads, and most of the rest fighting around them (of 16, averaged per second)
    expect(t.onPad).toBeGreaterThanOrEqual(1.5);
    expect(t.nearPad).toBeGreaterThanOrEqual(6);
  }, SLOW);

  it('Warzone Control Zones (2 teams, swarm Normal): ≥ 2 zoneCaptured while farming the swarm', () => {
    const t = play({ gameType: 'warzone', subMode: 'zones', pve: 2, seconds: GATE_SEC, seed: 1 });
    console.log(`Warzone zones: ${JSON.stringify(t.events)} pvp ${t.pvp} swarm ${t.swarm} onPad ${t.onPad.toFixed(1)} nearPad ${t.nearPad.toFixed(1)}`);
    expect(ev(t, 'zoneCaptured')).toBeGreaterThanOrEqual(2);
    expect(t.nearPad).toBeGreaterThanOrEqual(4);
    expect(t.swarm).toBeGreaterThan(200);
  }, SLOW);

  it.each([1, 2])('Arena Hot Point (2 teams), seed %i: ≥ 1 capture and ≥ 2 hotMoved', (seed) => {
    const t = play({ gameType: 'arena', subMode: 'hotpoint', seconds: GATE_SEC, seed });
    console.log(`Hot seed ${seed}: ${JSON.stringify(t.events)} pvp ${t.pvp} onPad ${t.onPad.toFixed(1)} nearPad ${t.nearPad.toFixed(1)}`);
    expect(ev(t, 'zoneCaptured')).toBeGreaterThanOrEqual(1);
    expect(ev(t, 'hotMoved')).toBeGreaterThanOrEqual(2);
    // bots converge on the point
    expect(t.onPad).toBeGreaterThanOrEqual(1.5);
    expect(t.nearPad).toBeGreaterThanOrEqual(5);
  }, SLOW);

  it.each([1, 2])('Arena Hot Point (FFA), seed %i: ≥ 1 capture and ≥ 2 hotMoved', (seed) => {
    const t = play({ gameType: 'arena', subMode: 'hotpoint', ffa: true, seconds: GATE_SEC, seed });
    console.log(`Hot FFA seed ${seed}: ${JSON.stringify(t.events)} pvp ${t.pvp} onPad ${t.onPad.toFixed(1)} nearPad ${t.nearPad.toFixed(1)}`);
    expect(ev(t, 'zoneCaptured')).toBeGreaterThanOrEqual(1);
    expect(ev(t, 'hotMoved')).toBeGreaterThanOrEqual(2);
  }, SLOW);

  it('is deterministic: the same seed replays the same match', () => {
    const a = play({ gameType: 'arena', subMode: 'ctf', seconds: 60, seed: 5 });
    const b = play({ gameType: 'arena', subMode: 'ctf', seconds: 60, seed: 5 });
    expect(b).toEqual(a);
  }, SLOW);
});

describe('v0.3 M3 PvP fix: bots fight each other (16 bots, 60 sim-seconds)', () => {
  // The target is a rate (≥ 15 a minute), so it is asserted as the mean over 8 seeds rather than on a few hand-picked
  // ones; every seed must still clear a floor. The first minute includes the flight from the bases (the Arena DM
  // opening sends every bot hunting at once); later minutes run ≈ 20.
  it('Arena Deathmatch (8v8), seeds 1–8: ≥ 15 PvP kills a minute on average (each ≥ 10)', () => {
    const kills = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => play({ gameType: 'arena', subMode: 'deathmatch', seconds: 60, seed }).pvp);
    const mean = kills.reduce((a, b) => a + b, 0) / kills.length;
    console.log(`Arena DM 60 s pvp by seed: ${kills.join(' ')} (mean ${mean.toFixed(1)})`);
    expect(mean).toBeGreaterThanOrEqual(15);
    expect(Math.min(...kills)).toBeGreaterThanOrEqual(10);
  }, SLOW);

  it.each([1, 2])('Warzone Classic (8v8, swarm Normal), seed %i: PvP kills AND swarm farming', (seed) => {
    const t = play({ gameType: 'warzone', subMode: 'deathmatch', pve: 2, seconds: 60, seed });
    console.log(`Warzone DM seed ${seed}: pvp ${t.pvp} swarm ${t.swarm}`);
    expect(t.pvp).toBeGreaterThanOrEqual(8);
    expect(t.swarm).toBeGreaterThanOrEqual(200);
  }, SLOW);
});
