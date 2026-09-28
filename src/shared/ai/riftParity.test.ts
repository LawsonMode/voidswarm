// OWNER: AI agent. v0.3 M4 rift READY GATE on the REAL Sim (docs/v0.3-proposal.md §4.9, §9 AI):
//   "4 normal bots clear floor 1 of seed 1234 within 6 sim-minutes" — SUB_MODES.coop.ready flips only when this
//   passes (the INTEGRATOR flips it). Also: a 3-floor run reaches the floor-3 boss (the Matriarch's room seals).
// Same loop the Room runs (think → setInput → step, bots answer offers, brain.onFloorChange() on floorStart), minus
// the network; fixed seeds, no mocks, deterministic. The fill bots use the Room's class complement (riftFillClass).
// Unconditional: a rift that fails to start (no world.dungeon / layout) fails the gate instead of skipping it.
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../constants';
import { inRoomInterior } from '../sim/dungeonRules';
import { Sim } from '../sim/Sim';
import { RIFT_ARMING, RIFT_SEALED, type BotSkill, type GameEvent, type PveIntensity, type ShipClassId, type SimConfig } from '../types';
import { createBotBrain, type BotBrain } from './bots';
import { riftFillClass } from './riftGoals';

interface RiftOpts {
  seed: number; floors: 3 | 6; bots?: number; skill?: BotSkill; pve?: PveIntensity;
  /** Stop after this many sim-seconds... */
  maxSec: number;
  /** ...or as soon as this returns true (after each step). */
  until?: (t: RiftTally, sim: Sim) => boolean;
}
interface RiftTally {
  events: Record<string, number>;
  /** Tick each floor started (index = floor; floor 1 = 0). */
  floorStartTick: number[];
  /** Tick the boss room of `floor` first armed (0 = never). */
  bossArmTick: number;
  bossFloor: number;
  seconds: number;
  outcome: string;
  floor: number;
  lives: number;
  enemyKills: number;
  classes: ShipClassId[];
}

function riftConfig(seed: number, floors: 3 | 6, pve: PveIntensity): SimConfig {
  return {
    mapSeed: seed, mode: 'teams', teamCount: 1, pveIntensity: pve, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
    gameType: 'dungeon', subMode: 'coop', floors, lootMult: 0, objectiveLimit: 0,
  };
}

function riftRun(o: RiftOpts): RiftTally {
  const n = o.bots ?? 4;
  const sim = new Sim(riftConfig(o.seed, o.floors, o.pve ?? 2));
  const w = sim.world;
  const brains = new Map<number, BotBrain>();
  const classes: ShipClassId[] = [];
  for (let i = 1; i <= n; i++) {
    const cls = riftFillClass(classes);
    classes.push(cls);
    sim.addPlayer({ playerId: i, name: 'bot' + i, team: 0, shipClass: cls, isBot: true });
    brains.set(i, createBotBrain(o.skill ?? 'normal', (o.seed * 1000 + i * 7919) >>> 0));
  }
  const tally: RiftTally = {
    events: {}, floorStartTick: [0, 0], bossArmTick: 0, bossFloor: 0, seconds: 0, outcome: 'running', floor: 1,
    lives: 0, enemyKills: 0, classes,
  };
  const ticks = Math.round(o.maxSec * TICK_RATE);
  for (let k = 0; k < ticks; k++) {
    for (let i = 1; i <= n; i++) {
      const sid = w.shipsByPlayer.get(i);
      const ship = sid ? w.ships.get(sid) : undefined;
      if (!ship) continue;
      const b = brains.get(i)!;
      sim.setInput(i, b.think(w, ship));
      if (ship.offers.length && (k + i * 7) % 30 === 0) sim.chooseUpgrade(i, b.chooseUpgrade(w, ship, ship.offers[0]), undefined);
    }
    sim.step();
    for (const e of sim.drainEvents() as GameEvent[]) {
      tally.events[e.t] = (tally.events[e.t] ?? 0) + 1;
      if (e.t === 'enemyDeath') tally.enemyKills++;
      if (e.t === 'floorStart') {
        tally.floorStartTick[e.floor] = w.tick;
        for (const b of brains.values()) b.onFloorChange?.(); // the Room does this when it drains floorStart
      }
    }
    const d = w.dungeon;
    if (d) {
      tally.floor = d.floor;
      tally.outcome = d.outcome;
      tally.lives = d.parties[0]?.lives ?? 0;
      const L = w.map.dungeon;
      if (L && L.bossFloor && !tally.bossArmTick) {
        const s = d.rooms[L.keyRoom]?.state ?? 0;
        if (s === RIFT_ARMING || s === RIFT_SEALED) { tally.bossArmTick = w.tick; tally.bossFloor = d.floor; }
      }
    }
    tally.seconds = (k + 1) / TICK_RATE;
    if (w.match.phase !== 'playing') break;
    if (o.until?.(tally, sim)) break;
  }
  return tally;
}

const SLOW = 240_000;
const GATE_SEC = 6 * 60;
const fmt = (t: RiftTally): string =>
  `floor ${t.floor} outcome ${t.outcome} lives ${t.lives} kills ${t.enemyKills} t ${t.seconds.toFixed(0)} s ` +
  `floors@ ${t.floorStartTick.map((x) => (x / TICK_RATE).toFixed(0)).join('/')} classes ${t.classes.join(',')} ` +
  `events ${JSON.stringify(t.events)}`;

describe('v0.3 M4 rift READY GATE on the real Sim (4 normal bots, Veteran)', () => {
  it('a dungeon Sim starts a real rift (world.dungeon + a floor layout, party on the entrance)', () => {
    const sim = new Sim(riftConfig(1234, 6, 2));
    for (let i = 1; i <= 4; i++) sim.addPlayer({ playerId: i, name: 'bot' + i, team: 0, shipClass: 'brute', isBot: true });
    const w = sim.world, L = w.map.dungeon;
    expect(w.dungeon).toBeTruthy();
    expect(L && L.rooms.length).toBeGreaterThan(0);
    const e = L!.rooms[L!.entrances[0]];
    for (const s of w.ships.values()) expect(inRoomInterior(e, w.map.tileSize, s.x, s.y)).toBe(true);
  });

  it('GATE: 4 normal bots clear floor 1 of seed 1234 within 6 sim-minutes', () => {
    const t = riftRun({ seed: 1234, floors: 6, maxSec: GATE_SEC, until: (x) => x.floor >= 2 });
    console.log(`rift gate seed 1234: ${fmt(t)}`);
    expect(t.outcome).toBe('running'); // no wipe
    expect(t.floor).toBeGreaterThanOrEqual(2);
    expect(t.floorStartTick[2]).toBeGreaterThan(0);
    expect(t.floorStartTick[2]).toBeLessThanOrEqual(GATE_SEC * TICK_RATE);
    expect(t.events.roomClear ?? 0).toBeGreaterThanOrEqual(3); // 2 arenas + the key room
    expect(t.events.extract ?? 0).toBe(0); // bots never extract
  }, SLOW);

  it('a 3-floor run reaches the floor-3 boss (its room arms) without wiping', () => {
    const t = riftRun({ seed: 1234, floors: 3, maxSec: 3 * GATE_SEC, until: (x) => x.bossArmTick > 0 });
    console.log(`rift 3-floor seed 1234: ${fmt(t)} bossArm ${(t.bossArmTick / TICK_RATE).toFixed(0)} s (floor ${t.bossFloor})`);
    expect(t.outcome).toBe('running');
    expect(t.bossFloor).toBe(3);
    expect(t.bossArmTick).toBeGreaterThan(0);
  }, SLOW);

  it.each([1, 2, 3, 777, 99999])('robustness: seed %i clears floor 1 within 6 sim-minutes too', (seed) => {
    const t = riftRun({ seed, floors: 6, maxSec: GATE_SEC, until: (x) => x.floor >= 2 });
    console.log(`rift seed ${seed}: ${fmt(t)}`);
    expect(t.outcome).toBe('running');
    expect(t.floor).toBeGreaterThanOrEqual(2);
  }, SLOW);

  it('is deterministic: the same seed replays the same run', () => {
    const a = riftRun({ seed: 1234, floors: 3, maxSec: 90 });
    const b = riftRun({ seed: 1234, floors: 3, maxSec: 90 });
    expect(b).toEqual(a);
  }, SLOW);
});
