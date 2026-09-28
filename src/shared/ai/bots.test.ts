import { beforeEach, describe, expect, it, vi } from 'vitest';

// Count A* searches (PERF-2 regressions) while keeping the real implementation.
const navSpy = vi.hoisted(() => ({ findPathCalls: 0 }));
vi.mock('./nav', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./nav')>();
  return {
    ...mod,
    findPath: (...args: Parameters<typeof mod.findPath>) => { navSpy.findPathCalls++; return mod.findPath(...args); },
  };
});

// Fake map module: reads map.tiles directly (open map + border walls + optional wall blocks).
vi.mock('../sim/map', () => {
  const solid = (map: any, x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
    const c = Math.floor(x / map.tileSize), r = Math.floor(y / map.tileSize);
    const v = map.tiles[r * map.cols + c];
    return v === 1 || v === 2;
  };
  return {
    generateMap: () => { throw new Error('not used'); },
    tileAt: (map: any, c: number, r: number) =>
      c < 0 || r < 0 || c >= map.cols || r >= map.rows ? 1 : map.tiles[r * map.cols + c],
    isSolidAt: solid,
    collideCircle: (_m: any, x: number, y: number) => ({ x, y, hit: false, nx: 0, ny: 0 }),
    lineOfSight: (map: any, x0: number, y0: number, x1: number, y1: number) => {
      const d = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(d / 8));
      for (let i = 0; i <= n; i++) {
        if (solid(map, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)) return false;
      }
      return true;
    },
  };
});

import { SHIP_CLASSES } from '../data/ships';
import { createWorld, rebuildGrid } from '../sim/world';
import { isSolidAt, lineOfSight } from '../sim/map';
import {
  SHIPFLAG_AFTERBURNER,
  emptyInput, type Enemy, type FlagObjective, type GameMap, type InputState, type MapFeature, type ObjectiveState,
  type ObjectiveSubMode, type PathId, type Ship, type ShipClassId, type SimConfig, type UpgradeChoice, type World,
  type ZoneObjective,
} from '../types';
import { createBotBrain } from './bots';
import {
  ATTACK_DIVE_R, DEFEND_HOLD_R, HOT_CONVERGE_FFA, HOT_FFA_PAD_FIGHT_MULT, OBJ_SCORE, amongNearest, carriedFlagOf, hostSeats,
  objectiveGoal, objectiveRank,
} from './objectiveGoals';
import { CTF_CARRIER_BLINK_MULT } from '../sim/objectives/rules';
import { DamageMeter } from './damageMeter';
import { findPath, getNavGrid } from './nav';
import { NAV_PER_TICK, navBudget } from './navBudget';
import { pickUpgrade } from './upgradePick';
import { Rng } from '../util/rng';

const TS = 32, COLS = 200, ROWS = 200;

function makeMap(walls: [number, number, number, number][] = []): GameMap {
  const tiles = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1) tiles[r * COLS + c] = 1;
  }
  for (const [c0, r0, c1, r1] of walls) {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) tiles[r * COLS + c] = 1;
  }
  return {
    seed: 1, teamCount: 2, width: COLS * TS, height: ROWS * TS, tileSize: TS, cols: COLS, rows: ROWS, tiles,
    spawns: [{ team: 0, x: 400, y: 400 }, { team: 1, x: 6000, y: 6000 }],
  };
}

function makeWorld(map: GameMap, mode: 'ffa' | 'teams' = 'ffa'): World {
  const cfg: SimConfig = {
    mapSeed: 1, mode, teamCount: mode === 'teams' ? 2 : 0, pveIntensity: 0, matchSeconds: 600,
    scoreLimit: 0, friendlyFire: false,
  };
  return createWorld(cfg, map);
}

let nextId = 1;
function makeShip(
  world: World, cls: ShipClassId, x: number, y: number, team = -1, isBot = true, path: PathId | null = null,
): Ship {
  const b = SHIP_CLASSES[cls].base;
  const stats = { ...b, skill: { ...b.skill } };
  const id = nextId++;
  const s: Ship = {
    id, playerId: id, name: 'b' + id, team, shipClass: cls, isBot,
    x, y, vx: 0, vy: 0, angle: 0, alive: true, respawnTick: 0, invulnUntilTick: 0,
    energy: stats.maxEnergy, stats, input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0,
    path,
    gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
    utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0, skillState: {},
    attachedTo: 0, turrets: [], xp: 0, level: 1, xpToNext: 10, offers: [], offerSerial: 0,
    upgrades: path ? { ['path:' + path]: 1 } : {}, autoState: {},
    kills: 0, deaths: 0, score: 0, bounty: 10, killStreak: 0, enemyKills: 0,
    lastDamagedBy: 0, lastDamagedTick: 0, flags: 0,
  };
  world.ships.set(id, s);
  world.shipsByPlayer.set(s.playerId, id);
  world.nextId = Math.max(world.nextId, id + 1);
  return s;
}

function makeEnemy(world: World, x: number, y: number, kind: Enemy['kind'] = 'drone'): Enemy {
  const id = nextId++;
  const e: Enemy = {
    id, kind, x, y, vx: 0, vy: 0, angle: 0, hp: 100, maxHp: 100, radius: 14, elite: false, targetId: 0,
    spawnTick: 0, aiState: 0, aiTimer: 0, mem: {}, contactDamage: 10, scoreValue: 1, xpValue: 1,
  };
  world.enemies.set(id, e);
  world.nextId = Math.max(world.nextId, id + 1);
  return e;
}

/** Crude integrator: ship turns instantly to aim, moves at input*speed, stops at walls. */
function applyInput(world: World, s: Ship, inp: InputState, speed = 400, pinned = false): void {
  s.prevInput = s.input;
  s.input = inp;
  s.angle = inp.aim;
  if (s.attachedTo || pinned) { s.vx = s.vy = 0; return; }
  s.vx = inp.moveX * speed; s.vy = inp.moveY * speed;
  const nx = s.x + s.vx / 60, ny = s.y + s.vy / 60;
  if (!isSolidAt(world.map, nx, ny)) { s.x = nx; s.y = ny; } else { s.vx = 0; s.vy = 0; }
}

/** Run a brain for n ticks, calling `each` with every input. */
function run(
  w: World, s: Ship, brain: ReturnType<typeof createBotBrain>, n: number,
  each: (inp: InputState, tick: number) => void, opts: { pinned?: boolean; before?: (tick: number) => void } = {},
): void {
  const t0 = w.tick;
  for (let i = 0; i < n; i++) {
    w.tick = t0 + i;
    opts.before?.(w.tick);
    rebuildGrid(w);
    const inp = brain.think(w, s);
    each(inp, w.tick);
    applyInput(w, s, inp, 400, opts.pinned);
  }
  w.tick = t0 + n;
}

interface EconLog { shots: number; salvos: number; burns: number }

/**
 * Minimal energy economy in Sim.step order (tick++ → afterburner → capped recharge → skills), so the
 * brain sees the same energy/cooldown/flag traces as in the real sim. Optional extra damage per tick.
 */
function econStep(s: Ship, inp: InputState, tick: number, log: EconLog): void {
  const st = s.stats;
  s.flags = 0;
  const moving = Math.hypot(inp.moveX, inp.moveY) > 0.1;
  const abCost = st.afterburnerCostPerSec / 60;
  if (inp.afterburner && moving && !s.attachedTo && s.energy > abCost) {
    s.energy -= abCost; s.flags |= SHIPFLAG_AFTERBURNER; log.burns++;
  } else {
    s.energy = Math.min(st.maxEnergy, s.energy + st.rechargePerSec / 60);
  }
  if (s.attachedTo) return;
  if (inp.primary && tick >= s.gunReadyTick && s.energy >= st.gunCost) {
    s.energy -= st.gunCost; s.gunReadyTick = tick + Math.max(1, Math.round(st.gunCooldown * 60)); log.shots++;
  }
  if (inp.secondary && tick >= s.secondaryReadyTick && s.energy >= st.secondaryCost) {
    s.energy -= st.secondaryCost; s.secondaryReadyTick = tick + Math.round(st.secondaryCooldown * 60); log.salvos++;
  }
  if (inp.mobility && !s.prevInput.mobility && tick >= s.mobilityReadyTick && s.energy >= st.mobilityCost) {
    s.energy -= st.mobilityCost; s.mobilityReadyTick = tick + Math.round(st.mobilityCooldown * 60);
  }
  if (inp.utility && !s.prevInput.utility && tick >= s.utilityReadyTick && s.energy >= st.utilityCost) {
    s.energy -= st.utilityCost; s.utilityReadyTick = tick + Math.round(st.utilityCooldown * 60);
    s.utilityActiveUntilTick = tick + 180;
  }
}

/** Like run(), but steps the energy economy after every think (think at tick T, step processes T+1). */
function runEcon(
  w: World, s: Ship, brain: ReturnType<typeof createBotBrain>, n: number,
  each: (inp: InputState, tick: number) => void,
  opts: { pinned?: boolean; before?: (tick: number) => void; damage?: (tick: number) => number } = {},
): EconLog {
  const log: EconLog = { shots: 0, salvos: 0, burns: 0 };
  for (let i = 0; i < n; i++) {
    opts.before?.(w.tick);
    rebuildGrid(w);
    const inp = brain.think(w, s);
    each(inp, w.tick);
    w.tick++;
    applyInput(w, s, inp, 400, opts.pinned);
    econStep(s, inp, w.tick, log);
    const dmg = opts.damage?.(w.tick) ?? 0;
    if (dmg > 0) s.energy -= dmg;
  }
  return log;
}

const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const card = (id: string, category: UpgradeChoice['category']): UpgradeChoice =>
  ({ id, name: id, description: '', level: 1, maxLevel: 5, category, icon: '?' });

describe('bot brain (v0.2 kits)', () => {
  it('returns an empty input when dead', () => {
    const w = makeWorld(makeMap());
    const s = makeShip(w, 'brute', 1000, 1000);
    s.alive = false;
    expect(createBotBrain('normal', 1).think(w, s)).toEqual(emptyInput());
  });

  it('faces and leads a moving target, and fires primary', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 2000, 2000);
    const tgt = makeShip(w, 'brute', 2550, 2000);
    const brain = createBotBrain('hard', 7);
    let fired = 0, lastAim = 0, distErr = 0;
    run(w, bot, brain, 60, (inp) => {
      lastAim = inp.aim;
      if (inp.primary) { // plain shooting ticks: aimDist = distance to the target
        fired++;
        distErr = Math.max(distErr, Math.abs(inp.aimDist - Math.hypot(tgt.x - bot.x, tgt.y - bot.y)));
      }
    }, {
      pinned: true, before: () => { tgt.vy = 300; tgt.y += 300 / 60; },
    });
    const lead = angDiff(Math.atan2(tgt.y - bot.y, tgt.x - bot.x), lastAim);
    expect(lead).toBeGreaterThan(0.1); // aiming ahead (+y) of the target
    expect(lead).toBeLessThan(0.6);
    expect(fired).toBeGreaterThan(0);
    expect(distErr).toBeLessThan(1);
  });

  it('never fires primary/secondary without line of sight', () => {
    const w = makeWorld(makeMap([[68, 40, 72, 90]])); // wall between x=2176..2336
    const bot = makeShip(w, 'brute', 2000, 2000);
    makeShip(w, 'tech', 2500, 2000);
    run(w, bot, createBotBrain('hard', 3), 120, (inp) => {
      expect(inp.primary).toBe(false);
      expect(inp.secondary).toBe(false);
    }, { pinned: true });
  });

  it('retreats (moves away, holds fire) at low energy', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'brute', 3000, 3000);
    makeShip(w, 'brute', 3450, 3000);
    bot.energy = bot.stats.maxEnergy * 0.2;
    let away = 0, fired = 0;
    run(w, bot, createBotBrain('normal', 11), 60, (inp) => {
      if (inp.moveX < -0.3) away++;
      if (inp.primary) fired++;
    });
    expect(away).toBeGreaterThan(40);
    expect(fired).toBe(0);
    expect(bot.x).toBeLessThan(3000);
  });

  it('brute rams a lined-up swarm (Ram path)', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'brute', 2000, 2000, -1, true, 'ram');
    for (let i = 0; i < 4; i++) makeEnemy(w, 2150 + i * 90, 2000);
    let rams = 0, prev = false, ramAim = NaN;
    run(w, bot, createBotBrain('hard', 13), 90, (inp) => {
      if (inp.mobility) { expect(prev).toBe(false); rams++; if (Number.isNaN(ramAim)) ramAim = inp.aim; }
      prev = inp.mobility;
    }, { pinned: true });
    expect(rams).toBeGreaterThan(0);
    expect(Math.abs(angDiff(0, ramAim))).toBeLessThan(0.3); // straight down the line
  });

  it('tech blinks away when low and swarmed', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 3000, 3000);
    bot.energy = bot.stats.maxEnergy * 0.25;
    for (let i = 0; i < 4; i++) makeEnemy(w, 3160, 2940 + i * 40);
    let blinkAim = NaN, blinkDist = 0;
    run(w, bot, createBotBrain('hard', 17), 90, (inp) => {
      if (inp.mobility && Number.isNaN(blinkAim)) { blinkAim = inp.aim; blinkDist = inp.aimDist; }
    }, { pinned: true });
    expect(Number.isNaN(blinkAim)).toBe(false);
    expect(blinkDist).toBeCloseTo(bot.stats.skill.blinkRange, 0); // full-range escape
    expect(Math.abs(angDiff(Math.PI, blinkAim))).toBeLessThan(0.6); // away from the swarm (west)
  });

  it('tech throws Singularity at the densest clump with aimDist to it', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 2000, 2000);
    for (let i = 0; i < 6; i++) makeEnemy(w, 2400 + (i % 3) * 25, 1975 + Math.floor(i / 3) * 50);
    let aim = NaN, dist = 0;
    run(w, bot, createBotBrain('hard', 37), 90, (inp) => {
      if (inp.utility && Number.isNaN(aim)) { aim = inp.aim; dist = inp.aimDist; }
    }, { pinned: true });
    expect(Number.isNaN(aim)).toBe(false);
    expect(Math.abs(angDiff(0, aim))).toBeLessThan(0.2);
    expect(Math.abs(dist - 425)).toBeLessThan(60);
  });

  it('engineer raises a Shield Wall ~120 px ahead toward a swarm', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'engineer', 2000, 2000, -1, true, 'architect');
    for (let i = 0; i < 5; i++) makeEnemy(w, 2200, 1900 + i * 50);
    let dist = NaN, aim = NaN;
    run(w, bot, createBotBrain('hard', 41), 90, (inp) => {
      if (inp.utility && Number.isNaN(dist)) { dist = inp.aimDist; aim = inp.aim; }
    }, { pinned: true });
    expect(dist).toBe(120);
    expect(Math.abs(angDiff(0, aim))).toBeLessThan(0.5);
  });

  it('engineer heals a hurt ally with Repair Pulse', () => {
    const w = makeWorld(makeMap(), 'teams');
    const bot = makeShip(w, 'engineer', 2000, 2000, 0, true, 'medic');
    const ally = makeShip(w, 'brute', 2200, 2000, 0, false);
    ally.energy = ally.stats.maxEnergy * 0.3;
    let pulses = 0, prev = false;
    run(w, bot, createBotBrain('hard', 19), 90, (inp) => {
      if (inp.mobility) { expect(prev).toBe(false); pulses++; }
      prev = inp.mobility;
    }, { pinned: true });
    expect(pulses).toBeGreaterThan(0);
  });

  it('engineer deploys a sentry at a fight, respecting sentryMax', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'engineer', 2000, 2000);
    makeEnemy(w, 2400, 2000);
    let wanted = 0;
    run(w, bot, createBotBrain('hard', 23), 60, (inp) => { if (inp.secondary) wanted++; }, { pinned: true });
    expect(wanted).toBeGreaterThan(0);

    // at the cap: no more sentries
    const w2 = makeWorld(makeMap());
    const bot2 = makeShip(w2, 'engineer', 2000, 2000);
    makeEnemy(w2, 2400, 2000);
    for (let i = 0; i < 2; i++) {
      const id = w2.nextId++;
      w2.deployables.set(id, {
        id, kind: 'sentry', ownerId: bot2.id, ownerPlayerId: bot2.playerId, team: bot2.team, x: 2000, y: 2000,
        vx: 0, vy: 0, angle: 0, hp: 600, maxHp: 600, radius: 12, length: 0, spawnTick: 0, expireTick: 99999,
        power: 90, mem: {},
      });
    }
    run(w2, bot2, createBotBrain('hard', 23), 60, (inp) => expect(inp.secondary).toBe(false), { pinned: true });
  });

  it('emits single-tick attach edges toward a valid host (teams)', () => {
    const w = makeWorld(makeMap(), 'teams');
    const bot = makeShip(w, 'tech', 1000, 1000, 0);
    const host = makeShip(w, 'brute', 2500, 2500, 0, false, 'bulwark');
    host.stats.maxTurrets = 5;
    makeShip(w, 'brute', 5000, 5000, 1);
    let prev = false, presses = 0;
    run(w, bot, createBotBrain('normal', 5), 1200, (inp) => {
      if (inp.attach) {
        expect(prev).toBe(false);
        expect(inp.attachTarget).toBe(host.id);
        presses++;
      }
      prev = inp.attach;
    });
    expect(presses).toBeGreaterThan(0);
  });

  it('turret holds offense only while the host is above the energy threshold', () => {
    const setup = (hostFrac: number) => {
      const w = makeWorld(makeMap(), 'teams');
      const host = makeShip(w, 'brute', 2000, 2000, 0, false);
      const bot = makeShip(w, 'tech', 2000, 2030, 0);
      bot.attachedTo = host.id; host.turrets.push(bot.id);
      host.energy = host.stats.maxEnergy * hostFrac;
      makeEnemy(w, 2350, 2030);
      return { w, bot };
    };
    const hi = setup(0.8);
    let offense = 0;
    run(hi.w, hi.bot, createBotBrain('hard', 29), 60, (inp) => {
      if (inp.primary) offense++;
      expect(inp.attach).toBe(false);
    });
    expect(offense).toBeGreaterThan(0);

    const lo = setup(0.3);
    run(lo.w, lo.bot, createBotBrain('hard', 29), 60, (inp) => expect(inp.primary).toBe(false));
  });

  it('turret defense: engineer welds a hurt host; detaches with an edge when the host is dying', () => {
    const w = makeWorld(makeMap(), 'teams');
    const host = makeShip(w, 'brute', 2000, 2000, 0, false);
    const bot = makeShip(w, 'engineer', 2000, 2030, 0);
    bot.attachedTo = host.id; host.turrets.push(bot.id);
    host.energy = host.stats.maxEnergy * 0.5;
    let weld = 0;
    run(w, bot, createBotBrain('hard', 31), 30, (inp) => { if (inp.secondary) weld++; });
    expect(weld).toBeGreaterThan(20);

    const w2 = makeWorld(makeMap(), 'teams');
    const host2 = makeShip(w2, 'brute', 2000, 2000, 0, false);
    const bot2 = makeShip(w2, 'brute', 2000, 2030, 0);
    bot2.attachedTo = host2.id; host2.turrets.push(bot2.id);
    host2.energy = host2.stats.maxEnergy * 0.05;
    let detaches = 0, prev = false;
    run(w2, bot2, createBotBrain('hard', 9), 30, (inp) => {
      if (inp.detach) { expect(prev).toBe(false); detaches++; }
      prev = inp.detach;
    });
    expect(detaches).toBeGreaterThan(0);
  });

  it('pathfinding routes around a wall', () => {
    const map = makeMap([[60, 20, 64, 150]]);
    const path = findPath(getNavGrid(map), 1500, 2500, 2600, 2500)!;
    expect(path).not.toBeNull();
    expect(lineOfSight(map, 1500, 2500, 2600, 2500)).toBe(false);
    let px = 1500, py = 2500;
    for (let i = 0; i < path.length; i += 2) {
      expect(isSolidAt(map, path[i], path[i + 1])).toBe(false);
      expect(lineOfSight(map, px, py, path[i], path[i + 1])).toBe(true);
      px = path[i]; py = path[i + 1];
    }
  });

  it('bot navigates around a wall to reach a farm target', () => {
    const map = makeMap([[60, 60, 64, 100]]);
    const w = makeWorld(map);
    const bot = makeShip(w, 'tech', 1500, 2500);
    const e = makeEnemy(w, 2500, 2500);
    const brain = createBotBrain('hard', 21);
    let reached = false;
    for (let i = 0; i < 1500 && !reached; i++) {
      w.tick = i;
      rebuildGrid(w);
      applyInput(w, bot, brain.think(w, bot));
      if (lineOfSight(map, bot.x, bot.y, e.x, e.y) && Math.hypot(bot.x - e.x, bot.y - e.y) < 800) reached = true;
    }
    expect(reached).toBe(true);
  });

  it('path pick is valid, weighted and varied; talents follow path preference', () => {
    const w = makeWorld(makeMap(), 'teams');
    const brute = makeShip(w, 'brute', 100, 100);
    const offer = [card('path:ram', 'path'), card('path:barrage', 'path'), card('path:bulwark', 'path')];
    const counts = [0, 0, 0];
    for (let seed = 1; seed <= 300; seed++) {
      const i = createBotBrain('normal', seed).chooseUpgrade(w, brute, offer);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(3);
      counts[i]++;
    }
    expect(Math.min(...counts)).toBeGreaterThan(30); // variety
    expect(counts[0]).toBeGreaterThan(counts[2]); // ram (40%) > bulwark (25%)

    const ram = makeShip(w, 'brute', 100, 100, 0, true, 'ram');
    const talents = [card('ram_quake', 'talent'), card('ram_unstoppable', 'talent'), card('ram_plating', 'talent')];
    expect(pickUpgrade('hard', new Rng(1), ram, talents)).toBe(1);
    const easyPick = createBotBrain('easy', 3).chooseUpgrade(w, ram, talents);
    expect(easyPick).toBeGreaterThanOrEqual(0);
    expect(easyPick).toBeLessThan(3);
  });

  it('general cards are class/path-aware and robust to unknown ids', () => {
    const w = makeWorld(makeMap(), 'teams');
    const medic = makeShip(w, 'engineer', 100, 100, 0, true, 'medic');
    const lance = makeShip(w, 'tech', 100, 100, 0, true, 'lance');
    const offer = [card('heavy', 'weapon'), card('medkit', 'passive'), card('thrusters', 'passive')];
    expect(pickUpgrade('hard', new Rng(1), medic, offer)).toBe(1);
    expect(pickUpgrade('hard', new Rng(1), lance, offer)).toBe(0);
    const idx = createBotBrain('easy', 2).chooseUpgrade(w, medic, [card('???', 'auto'), card('zzz_unknown', 'passive')]);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });

  it('32 brains x 600 ticks stays within budget', () => {
    const map = makeMap([[40, 40, 45, 120], [100, 30, 140, 34], [120, 90, 125, 170], [60, 150, 110, 154]]);
    const w = makeWorld(map, 'teams');
    const rng = new Rng(42);
    const classes: ShipClassId[] = ['brute', 'tech', 'engineer'];
    const paths: Record<ShipClassId, PathId[]> = {
      brute: ['ram', 'barrage', 'bulwark'], tech: ['storm', 'void', 'lance'], engineer: ['summoner', 'medic', 'architect'],
    };
    const bots: { s: Ship; b: ReturnType<typeof createBotBrain> }[] = [];
    const place = () => {
      for (;;) {
        const x = rng.range(200, 6200), y = rng.range(200, 6200);
        if (!isSolidAt(map, x, y)) return [x, y];
      }
    };
    for (let i = 0; i < 32; i++) {
      const [x, y] = place();
      const cls = classes[i % 3];
      const s = makeShip(w, cls, x, y, i % 2, true, i % 4 === 0 ? null : paths[cls][i % 3]);
      bots.push({ s, b: createBotBrain((['easy', 'normal', 'hard'] as const)[i % 3], 1000 + i) });
    }
    for (let i = 0; i < 250; i++) { const [x, y] = place(); makeEnemy(w, x, y, i % 25 === 0 ? 'dart' : 'drone'); }
    for (let i = 0; i < 400; i++) {
      const [x, y] = place();
      const a = rng.range(0, 6.28);
      const id = w.nextId++;
      w.projectiles.set(id, {
        id, kind: 'bullet', ownerId: 999999, ownerPlayerId: 0, ownerTeam: 100, x, y,
        vx: Math.cos(a) * 600, vy: Math.sin(a) * 600, damage: 10, radius: 4, splash: 0, bouncesLeft: 0, level: 1,
        spawnTick: 0, expireTick: 9999, homingRange: 0, homingTurn: 0, pierce: 0, armTick: 0,
      });
    }
    for (let i = 0; i < 150; i++) {
      const [x, y] = place();
      const id = w.nextId++;
      w.gems.set(id, { id, x, y, vx: 0, vy: 0, value: 3, spawnTick: 0, expireTick: 99999, magnetTo: 0 });
    }
    getNavGrid(map); // one-off lazy build per map
    const t0 = performance.now();
    for (let tick = 0; tick < 600; tick++) {
      w.tick = tick;
      rebuildGrid(w);
      for (const { s, b } of bots) applyInput(w, s, b.think(w, s));
      for (const p of w.projectiles.values()) {
        p.x += p.vx / 60; p.y += p.vy / 60;
        if (p.x < 0 || p.x > 6400) p.vx = -p.vx;
        if (p.y < 0 || p.y > 6400) p.vy = -p.vy;
      }
    }
    const perTick = (performance.now() - t0) / 600;
    console.log(`AI perf: ${perTick.toFixed(3)} ms/tick for 32 bots`);
    expect(perTick).toBeLessThan(1.5);
  });
});

describe('bot brain v0.2 fixes (regressions)', () => {
  beforeEach(() => { navSpy.findPathCalls = 0; });

  // BOT-1 -------------------------------------------------------------------------------------
  it('BOT-1: a retreating bot does not afterburn its energy away; it recharges with a hostile shadowing it', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 3000, 3000);
    const foe = makeShip(w, 'brute', 3500, 3000);
    bot.energy = bot.stats.maxEnergy * 0.3; // normal retreatFrac 0.33
    let peak = 0;
    const log = runEcon(w, bot, createBotBrain('normal', 11), 240, () => {
      peak = Math.max(peak, bot.energy / bot.stats.maxEnergy);
    }, {
      // a hostile that keeps pace 500 px away (inside 700 px, not closing)
      before: () => { foe.x = bot.x + 500; foe.y = bot.y; foe.vx = bot.vx; foe.vy = bot.vy; },
    });
    expect(log.burns).toBe(0);
    expect(peak).toBeGreaterThan(0.7); // reached recoverFrac instead of hovering near 15%
  });

  it('BOT-1: retreat afterburns only away from a ship running it down, and never below its floor', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 3000, 3000);
    const foe = makeShip(w, 'brute', 3400, 3000);
    const brain = createBotBrain('normal', 11);
    bot.energy = bot.stats.maxEnergy * 0.3;
    run(w, bot, brain, 12, () => {}); // enter retreat (stays retreating until 0.7)
    const chase = () => { foe.x = bot.x + 400; foe.y = bot.y; foe.vx = -800; foe.vy = 0; };
    let burns = 0;
    run(w, bot, brain, 60, (inp) => { if (inp.afterburner) burns++; }, {
      before: () => { chase(); bot.energy = bot.stats.maxEnergy * 0.55; },
    });
    expect(burns).toBeGreaterThan(0);
    burns = 0;
    const t1 = w.tick + 6; // the previous decision's flag lives until the next 10 Hz decision
    run(w, bot, brain, 60, (inp, tick) => { if (inp.afterburner && tick >= t1) burns++; }, {
      before: () => { chase(); bot.energy = bot.stats.maxEnergy * 0.4; }, // below retreatFrac + margin
    });
    expect(burns).toBe(0);
  });

  it('BOT-1: fleeing a black hole still uses the afterburner', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 3000, 3000);
    makeEnemy(w, 3250, 3000, 'blackhole');
    let burns = 0;
    run(w, bot, createBotBrain('normal', 11), 30, (inp) => { if (inp.afterburner) burns++; });
    expect(burns).toBeGreaterThan(20);
  });

  // BOT-2 -------------------------------------------------------------------------------------
  it('BOT-2: Blink and Singularity never share a tick or an aim; the well goes at the clump', () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'tech', 3000, 3000);
    bot.energy = bot.stats.maxEnergy * 0.5; // swarmed Blink (< 0.6) and Singularity (> 300) both allowed
    for (let i = 0; i < 5; i++) makeEnemy(w, 3180 + (i % 2) * 30, 2960 + i * 20);
    const clumpA = Math.atan2(3000 - 3000, 3195 - 3000);
    let blinks = 0, wells = 0;
    run(w, bot, createBotBrain('hard', 17), 150, (inp, tick) => {
      expect(inp.mobility && inp.utility).toBe(false);
      if (inp.mobility) {
        blinks++;
        expect(Math.abs(angDiff(Math.PI, inp.aim))).toBeLessThan(0.6); // away (west)
        bot.mobilityReadyTick = tick + 300;
      }
      if (inp.utility) {
        wells++;
        expect(Math.abs(angDiff(clumpA, inp.aim))).toBeLessThan(0.3); // at the clump (east)
        expect(inp.aimDist).toBeLessThan(260);
        bot.utilityReadyTick = tick + 600;
      }
    }, { pinned: true, before: () => { bot.energy = bot.stats.maxEnergy * 0.5; } });
    expect(blinks).toBeGreaterThan(0);
    expect(wells).toBeGreaterThan(0);
  });

  // BOT-3 -------------------------------------------------------------------------------------
  const bruteAtSwarm = () => {
    const w = makeWorld(makeMap());
    const bot = makeShip(w, 'brute', 2000, 2000);
    for (let i = 0; i < 4; i++) makeEnemy(w, 2450 + (i % 2) * 30, 1980 + Math.floor(i / 2) * 40);
    return { w, bot };
  };

  it('BOT-3: own rockets / gun / capped recharge are not counted as damage (no phantom Iron Hide)', () => {
    const { w, bot } = bruteAtSwarm();
    let hides = 0;
    const log = runEcon(w, bot, createBotBrain('hard', 43), 480, (inp) => { if (inp.utility) hides++; }, { pinned: true });
    expect(log.salvos).toBeGreaterThanOrEqual(3);
    expect(log.shots).toBeGreaterThanOrEqual(20);
    expect(hides).toBe(0);
  });

  it('BOT-3: a real damage spike still triggers Iron Hide', () => {
    const { w, bot } = bruteAtSwarm();
    let firstHide = -1;
    runEcon(w, bot, createBotBrain('hard', 43), 300, (inp, tick) => {
      if (inp.utility && firstHide < 0) firstHide = tick;
    }, { pinned: true, damage: (tick) => (tick >= 120 && tick < 180 && tick % 3 === 0 ? 100 : 0) });
    expect(firstHide).toBeGreaterThanOrEqual(120);
    expect(firstHide).toBeLessThan(200);
  });

  it('BOT-3: DamageMeter separates damage from own spending, capped recharge and turret drains', () => {
    const w = makeWorld(makeMap(), 'teams');
    const host = makeShip(w, 'brute', 2000, 2000, 0, false);
    const flak = makeShip(w, 'brute', 2000, 2030, 0);
    const pod = makeShip(w, 'engineer', 2000, 1970, 0);
    const las1 = makeShip(w, 'tech', 1970, 2000, 0);
    const las2 = makeShip(w, 'tech', 2030, 2000, 0);
    flak.attachedTo = host.id; host.turrets.push(flak.id);
    const st = host.stats, max = st.maxEnergy, rc = st.rechargePerSec / 60;
    const m = new DamageMeter();
    const step = (fn: (t: number) => void) => { w.tick++; fn(w.tick); m.sample(w, host); return m.take(); };
    m.sample(w, host);
    // full energy: recharge is capped, gun + salvo spend is ours, not damage
    expect(step((t) => { host.energy -= st.gunCost + st.secondaryCost; host.gunReadyTick = t + 11; host.secondaryReadyTick = t + 84; })).toBeCloseTo(0, 6);
    // a refused secondary (ready = t + 6) costs nothing: the whole drop is damage
    expect(step((t) => { host.energy += rc - 50; host.secondaryReadyTick = t + 6; })).toBeCloseTo(50, 6);
    // afterburner tick: no recharge, burner cost is ours
    expect(step(() => { host.energy -= st.afterburnerCostPerSec / 60; host.flags = SHIPFLAG_AFTERBURNER; })).toBeCloseTo(0, 6);
    host.flags = 0;
    // flak burst (seated turret) + a pod seated and fired in the same step drain the host: not damage
    expect(step((t) => {
      host.energy += rc - 40 - 45;
      flak.gunReadyTick = t + 27;
      pod.attachedTo = host.id; host.turrets.push(pod.id); pod.gunReadyTick = t + 60;
    })).toBeCloseTo(0, 6);
    // two resonating lasers: each draws 90/s × 1.5
    las1.attachedTo = las2.attachedTo = host.id; host.turrets.push(las1.id, las2.id);
    expect(step((t) => { host.energy += rc - 2 * 90 / 60 * 1.5; host.skillState.laserTick = t; host.skillState.laserN = 2; })).toBeCloseTo(0, 6);
    // real damage mixed with spending is still measured exactly
    expect(step((t) => { host.energy += rc - st.gunCost - 120; host.gunReadyTick = t + 11; })).toBeCloseTo(120, 6);
    expect(host.energy).toBeLessThan(max);
  });

  it('BOT-3: a Brute turret does not hold Brace for its host\'s own firing / full-energy recharge', () => {
    const setup = () => {
      const w = makeWorld(makeMap(), 'teams');
      const host = makeShip(w, 'tech', 2000, 2000, 0, false);
      const bot = makeShip(w, 'brute', 2000, 2030, 0);
      bot.attachedTo = host.id; host.turrets.push(bot.id);
      return { w, host, bot };
    };
    // host at full energy, firing its gun every 9 ticks, never hit
    const hostStep = (host: Ship, tick: number, dmg: number) => {
      host.energy = Math.min(host.stats.maxEnergy, host.energy + host.stats.rechargePerSec / 60);
      if (tick >= host.gunReadyTick) { host.energy -= host.stats.gunCost; host.gunReadyTick = tick + 9; }
      host.energy -= dmg;
    };
    const drive = (w: World, host: Ship, bot: Ship, n: number, dmg: (tick: number) => number) => {
      let braced = 0;
      const brain = createBotBrain('hard', 9);
      for (let i = 0; i < n; i++) {
        rebuildGrid(w);
        const inp = brain.think(w, bot);
        if (inp.secondary && w.tick > 24) braced++;
        w.tick++;
        applyInput(w, bot, inp);
        hostStep(host, w.tick, dmg(w.tick));
      }
      return braced;
    };
    const calm = setup();
    expect(drive(calm.w, calm.host, calm.bot, 240, () => 0)).toBe(0);
    const hit = setup();
    expect(drive(hit.w, hit.host, hit.bot, 240, (tick) => (tick % 6 === 0 ? 90 : 0))).toBeGreaterThan(100);
  });

  // BOT-4 -------------------------------------------------------------------------------------
  it('BOT-4: findHost skips a host it would leave at once (non-engineers), engineers still seat to weld', () => {
    const w = makeWorld(makeMap(), 'teams');
    const bot = makeShip(w, 'tech', 1000, 1000, 0);
    const weak = makeShip(w, 'brute', 1200, 1000, 0, false); // nearby human host, nearly dead
    weak.energy = weak.stats.maxEnergy * 0.1;
    const far = makeShip(w, 'engineer', 5000, 5000, 0, true); // healthy bot across the map
    makeShip(w, 'brute', 6000, 1000, 1);
    const targets: number[] = [];
    run(w, bot, createBotBrain('normal', 5), 1200, (inp) => { if (inp.attach) targets.push(inp.attachTarget); },
      { before: () => { weak.energy = weak.stats.maxEnergy * 0.1; } });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((id) => id === far.id)).toBe(true);

    const w2 = makeWorld(makeMap(), 'teams');
    const eng = makeShip(w2, 'engineer', 1000, 1000, 0);
    const weak2 = makeShip(w2, 'brute', 1200, 1000, 0, false);
    makeShip(w2, 'brute', 6000, 1000, 1);
    const t2: number[] = [];
    // (v0.3 M3: Deathmatch seat rolls are x0.3, so give the engineer a longer window to roll a seat)
    run(w2, eng, createBotBrain('normal', 5), 4800, (inp) => { if (inp.attach) t2.push(inp.attachTarget); },
      { before: () => { weak2.energy = weak2.stats.maxEnergy * 0.1; } });
    expect(t2.length).toBeGreaterThan(0);
    expect(t2.every((id) => id === weak2.id)).toBe(true);
  });

  it('BOT-4: after leaving a host for low energy the bot does not re-seat on it right away', () => {
    const w = makeWorld(makeMap(), 'teams');
    // not an Arena DM opening (whose first 20 s send every bot hunting across the map, away from its host)
    w.config.pveIntensity = 1;
    const host = makeShip(w, 'brute', 2000, 2000, 0, false);
    const bot = makeShip(w, 'tech', 2000, 2030, 0);
    makeShip(w, 'brute', 6000, 6000, 1);
    bot.attachedTo = host.id; host.turrets.push(bot.id);
    host.energy = host.stats.maxEnergy * 0.05;
    const brain = createBotBrain('hard', 9);
    let detached = false;
    run(w, bot, brain, 30, (inp) => { if (inp.detach) detached = true; });
    expect(detached).toBe(true);
    bot.attachedTo = 0; host.turrets.length = 0;
    host.energy = host.stats.maxEnergy * 0.5; // recovered, but we just left it
    let early = 0, later = 0;
    run(w, bot, brain, 480, (inp) => { if (inp.attach) early++; });
    run(w, bot, brain, 1500, (inp) => { if (inp.attach && inp.attachTarget === host.id) later++; });
    expect(early).toBe(0);
    expect(later).toBeGreaterThan(0);
  });

  // BOT-5 -------------------------------------------------------------------------------------
  it('BOT-5: finishing Blink is planned for its fixed range (never lands on the target)', () => {
    const blinkAt = (d: number) => {
      const w = makeWorld(makeMap());
      const bot = makeShip(w, 'tech', 2000, 2000, -1, true, 'lance');
      const tgt = makeShip(w, 'brute', 2000 + d, 2000);
      tgt.energy = tgt.stats.maxEnergy * 0.2;
      const aims: number[] = [];
      let dist = 0;
      run(w, bot, createBotBrain('hard', 53), 120, (inp, tick) => {
        if (inp.mobility) { aims.push(inp.aim); dist = inp.aimDist; bot.mobilityReadyTick = tick + 300; }
      }, { pinned: true });
      return { aims, dist, blinkR: bot.stats.skill.blinkRange };
    };
    expect(blinkAt(520).aims.length).toBe(0); // would land ~40 px from the target
    const ok = blinkAt(760); // lands ~280 px short
    expect(ok.aims.length).toBeGreaterThan(0);
    expect(Math.abs(angDiff(0, ok.aims[0]))).toBeLessThan(0.2);
    expect(ok.dist).toBe(ok.blinkR);
    expect(blinkAt(1000).aims.length).toBe(0); // would land 520 px away: not a finishing blink
  });

  // PERF-2 ------------------------------------------------------------------------------------
  it('PERF-2: the A* budget is per world, and starved requesters get the reserved slot', () => {
    const a = {}, b = {};
    for (let i = 0; i < NAV_PER_TICK; i++) expect(navBudget(a, 50, 50)).toBe(true);
    expect(navBudget(a, 50, 50)).toBe(false);
    expect(navBudget(b, 50, 50)).toBe(true); // another room's world is unaffected

    // Same order every tick (Room.players order); the last requester must still be served soon.
    const k = {};
    const waiting = new Map<string, number>();
    const served = new Map<string, number>();
    for (let tick = 0; tick < 12; tick++) {
      // three fresh requesters per tick always ask first, then everyone still waiting
      const order = ['f' + tick + 'a', 'f' + tick + 'b', 'f' + tick + 'c'];
      for (const id of order) waiting.set(id, tick);
      const ask = [...order, ...[...waiting.keys()].filter((id) => !order.includes(id))];
      for (const id of ask) {
        if (navBudget(k, tick, waiting.get(id)!)) { served.set(id, tick); waiting.delete(id); }
      }
    }
    // every requester from the first 8 ticks got a slot within a few ticks of asking
    for (let tick = 0; tick < 8; tick++) {
      for (const s of ['a', 'b', 'c']) {
        const id = 'f' + tick + s;
        expect(served.has(id)).toBe(true);
        expect(served.get(id)! - tick).toBeLessThanOrEqual(3);
      }
    }
  });

  it('PERF-2: a refused bot re-asks next tick instead of waiting for its next decision', () => {
    const w = makeWorld(makeMap([[60, 20, 64, 150]]), 'teams');
    const pairs: { s: Ship; b: ReturnType<typeof createBotBrain> }[] = [];
    for (let i = 0; i < 6; i++) {
      const s = makeShip(w, 'tech', 1500, 1000 + i * 300, 0); // one team: they farm, not fight each other
      makeEnemy(w, 2500, 1000 + i * 300); // behind the wall
      pairs.push({ s, b: createBotBrain('hard', 6 * (i + 1)) }); // same decision phase
    }
    getNavGrid(w.map);
    navSpy.findPathCalls = 0;
    for (let tick = 0; tick < 3; tick++) {
      w.tick = tick;
      rebuildGrid(w);
      for (const { s, b } of pairs) applyInput(w, s, b.think(w, s), 400, true);
    }
    expect(navSpy.findPathCalls).toBe(6); // 3 at tick 0, the 3 refused ones at tick 1
  });

  it('PERF-2: an unreachable goal is not re-searched every decision', () => {
    // a closed box with the farm target inside
    const map = makeMap([[100, 100, 120, 100], [100, 120, 120, 120], [100, 100, 100, 120], [120, 100, 120, 120]]);
    const w = makeWorld(map);
    const cx = 110.5 * TS;
    const bot = makeShip(w, 'tech', cx - 800, cx);
    makeEnemy(w, cx, cx);
    getNavGrid(map);
    navSpy.findPathCalls = 0;
    run(w, bot, createBotBrain('hard', 21), 180, () => {}, { pinned: true });
    expect(navSpy.findPathCalls).toBeGreaterThan(0);
    expect(navSpy.findPathCalls).toBeLessThanOrEqual(3); // was ~one per decision (30+)
  });
});

// =============================================================================================
// v0.3 M3: objective bots (§5.7) — the AI ready gates, against fake objective state (§10: "AI works in
// parallel against fake views"). The real-Sim AI-parity runs live in objectiveParity.test.ts.
// =============================================================================================

function makeObjective(mode: ObjectiveSubMode, extra: Partial<ObjectiveState> = {}): ObjectiveState {
  return {
    mode, limit: 3, teamPoints: [0, 0], playerPoints: new Map(), flags: [], zones: [], hot: null,
    overtime: false, overtimeCapTick: 0, suddenDeath: false, extensions: 0, stats: new Map(), mem: {}, ...extra,
  };
}
function makeFlag(team: number, sx: number, sy: number, extra: Partial<FlagObjective> = {}): FlagObjective {
  return {
    team, state: 'home', x: sx, y: sy, standX: sx, standY: sy, carrierId: 0, carrierPlayerId: 0,
    droppedAtTick: 0, pickedAtTick: 0, runners: [], ...extra,
  };
}
function makeZone(index: number, x: number, y: number, radius = 200, extra: Partial<ZoneObjective> = {}): ZoneObjective {
  return {
    index, x, y, radius, owner: -1, ownerPlayerId: 0, capTeam: -1, capPlayerId: 0, progress: 0, contested: false,
    swarm: 0, active: true, lastPresenceTick: 0, heldSinceTick: 0, ...extra,
  };
}
/** Make `s` carry flag `f` (state + position follow the carrier). */
function carry(f: FlagObjective, s: Ship): void {
  f.state = 'carried'; f.carrierId = s.id; f.carrierPlayerId = s.playerId; f.x = s.x; f.y = s.y;
}

type Pilot = { s: Ship; b: ReturnType<typeof createBotBrain> };
/** Step several brains together (all think on the same world state, then all move). */
function runAll(w: World, pilots: Pilot[], n: number, each?: (tick: number) => void): void {
  for (let i = 0; i < n; i++) {
    rebuildGrid(w);
    const inputs = pilots.map(({ s, b }) => b.think(w, s));
    pilots.forEach(({ s }, k) => applyInput(w, s, inputs[k]));
    w.tick++;
    each?.(w.tick);
  }
}
const distTo = (s: { x: number; y: number }, x: number, y: number): number => Math.hypot(s.x - x, s.y - y);

describe('v0.3 M3 objective goals (pure)', () => {
  it('rank = index among alive teammates by ship id; FFA ranks over every alive ship', () => {
    const w = makeWorld(makeMap(), 'teams');
    const a = makeShip(w, 'tech', 500, 500, 0), b = makeShip(w, 'tech', 600, 500, 1);
    const c = makeShip(w, 'brute', 700, 500, 0), d = makeShip(w, 'engineer', 800, 500, 0);
    expect([objectiveRank(w, a), objectiveRank(w, c), objectiveRank(w, d), objectiveRank(w, b)]).toEqual([0, 1, 2, 0]);
    c.alive = false;
    expect(objectiveRank(w, d)).toBe(1);
    const f = makeWorld(makeMap(), 'ffa');
    const ships = [0, 1, 2].map((i) => makeShip(f, 'tech', 500 + i * 100, 500, -1));
    expect(ships.map((s) => objectiveRank(f, s))).toEqual([0, 1, 2]);
  });

  it('CTF roles follow rank % 5 (attack 0/1, defend 2/4, flex 3) and the §5.7 scores', () => {
    const w = makeWorld(makeMap(), 'teams');
    w.objective = makeObjective('ctf', { flags: [makeFlag(0, 800, 3200), makeFlag(1, 5600, 3200)] });
    const bots = [0, 1, 2, 3, 4].map((i) => makeShip(w, 'tech', 2000 + i * 40, 3200, 0));
    const g = bots.map((s) => objectiveGoal(w, s, objectiveRank(w, s))!);
    expect(g.map((x) => x.kind)).toEqual(['attack', 'attack', 'defend', 'attack', 'defend']);
    expect(g[0].score).toBeCloseTo(0.85 + 0.3); // enemy stand unguarded: +0.3
    expect(g[2].score).toBeCloseTo(0.9);
    expect(g[3].score).toBeCloseTo(0.8); // flex with no carrier to escort: a plain run at the stand
    expect([g[0].x, g[0].y]).toEqual([5600, 3200]);
    // defenders travel when > 600 px out, and hold within 400 px of the stand once there
    expect(g[2].hold).toBe(false);
    bots[2].x = 1100;
    const near = objectiveGoal(w, bots[2], 2)!;
    expect([near.kind, near.hold, near.holdR]).toEqual(['defend', true, DEFEND_HOLD_R]);
    // guarded enemy stand: no +0.3
    makeShip(w, 'brute', 5500, 3200, 1); makeShip(w, 'brute', 5650, 3300, 1);
    expect(objectiveGoal(w, bots[0], 0)!.score).toBeCloseTo(0.85);
    // flex escorts our carrier 150 px behind it
    const cr = makeShip(w, 'brute', 4000, 3200, 0, false);
    cr.vx = 300; carry(w.objective.flags[1], cr);
    const e = objectiveGoal(w, bots[3], 3)!;
    expect(e.kind).toBe('escort');
    expect(e.x).toBeCloseTo(3850); expect(e.y).toBeCloseTo(3200);
  });

  it('carrier heads home (1.9, carrier flag) and waits on the stand while its own flag is out', () => {
    const w = makeWorld(makeMap(), 'teams');
    const own = makeFlag(0, 800, 3200), enemy = makeFlag(1, 5600, 3200);
    w.objective = makeObjective('ctf', { flags: [own, enemy] });
    const me = makeShip(w, 'tech', 4000, 3000, 0);
    carry(enemy, me);
    expect(carriedFlagOf(w, me)).toBe(enemy);
    let g = objectiveGoal(w, me, 0)!;
    expect([g.kind, g.score, g.carrier, g.hold, g.x, g.y]).toEqual(['carry', 1.9, true, false, 800, 3200]);
    own.state = 'carried'; own.carrierId = 999;
    g = objectiveGoal(w, me, 0)!;
    expect([g.kind, g.hold, g.x, g.y]).toEqual(['carry', true, 800, 3200]);
    // our flag dropped close by: touch-return it first
    own.state = 'dropped'; own.carrierId = 0; own.x = 4300; own.y = 3000;
    g = objectiveGoal(w, me, 0)!;
    expect([g.kind, g.x, g.y]).toEqual(['carry', 4300, 3000]);
    // a carrier host offers the gunner seat only
    me.stats.maxTurrets = 3;
    expect(hostSeats(w, me)).toBe(1);
  });

  it('own flag carried: the nearest 3 hunt the thief; dropped: the nearest 2 return it; enemy flag dropped: nearest 3 grab', () => {
    const w = makeWorld(makeMap(), 'teams');
    const own = makeFlag(0, 800, 3200), enemy = makeFlag(1, 5600, 3200);
    w.objective = makeObjective('ctf', { flags: [own, enemy] });
    const thief = makeShip(w, 'brute', 3000, 3000, 1);
    carry(own, thief);
    const team = [200, 500, 900, 1400, 2200].map((d) => makeShip(w, 'tech', 3000 + d, 3000, 0));
    const kinds = () => team.map((s) => objectiveGoal(w, s, objectiveRank(w, s))!);
    let g = kinds();
    expect(g.map((x) => x.kind === 'hunt')).toEqual([true, true, true, false, false]);
    expect(g.map((x) => x.kind)).toEqual(['hunt', 'hunt', 'hunt', 'attack', 'defend']); // ranks 3 / 4 keep roles
    expect(g[0].targetShipId).toBe(thief.id);
    expect(g[0].score).toBe(1.5);
    // a turret teammate doesn't count as a responder
    team[1].attachedTo = 12345;
    expect(amongNearest(w, team[3], thief.x, thief.y, 3)).toBe(true);
    team[1].attachedTo = 0;
    // dropped → nearest 2 return
    own.state = 'dropped'; own.carrierId = 0; own.x = 3000; own.y = 3000;
    g = kinds();
    expect(g.map((x) => x.kind === 'return')).toEqual([true, true, false, false, false]);
    expect(g[0].score).toBe(1.4);
    // enemy flag dropped near us → nearest 3 grab
    own.state = 'home'; own.x = own.standX; own.y = own.standY;
    enemy.state = 'dropped'; enemy.x = 3000; enemy.y = 3000;
    g = kinds();
    expect(g.map((x) => x.kind === 'grab')).toEqual([true, true, true, false, false]);
    expect(g[0].score).toBe(1.3);
    // with no enemy flag at home, the runner role heads for the dropped one anyway (where the fight is)
    expect([g[3].kind, g[3].x, g[3].y]).toEqual(['attack', 3000, 3000]);
  });

  it('zones: preferred zone = (rank + team) % n; hold 0.6 on an owned safe zone; +0.3 contested', () => {
    const w = makeWorld(makeMap(), 'teams');
    const zs = [makeZone(0, 3200, 3200), makeZone(1, 3200, 1900), makeZone(2, 3200, 4500)];
    w.objective = makeObjective('zones', { zones: zs, limit: 300 });
    const a = makeShip(w, 'tech', 1000, 3200, 1), b = makeShip(w, 'tech', 1000, 3300, 1);
    const ga = objectiveGoal(w, a, 0)!, gb = objectiveGoal(w, b, 1)!;
    expect([ga.x, ga.y]).toEqual([3200, 1900]); // (0 + 1) % 3 = 1
    expect([gb.x, gb.y]).toEqual([3200, 4500]); // (1 + 1) % 3 = 2
    expect(ga.kind).toBe('zone');
    expect(ga.hold).toBe(true);
    expect(ga.score).toBeCloseTo(0.95 * (1 - Math.hypot(2200, 1300) / 5000));
    zs[1].contested = true;
    expect(objectiveGoal(w, a, 0)!.score).toBeCloseTo(0.95 * (1 - Math.hypot(2200, 1300) / 5000) + 0.3);
    zs[1].contested = false;
    zs[1].owner = 1;
    a.x = 3200; a.y = 1900;
    const hold = objectiveGoal(w, a, 0)!;
    expect([hold.kind, hold.score, hold.hold]).toEqual(['zoneHold', 0.6, true]);
    // owned zone under threat → back to the full zone score
    makeShip(w, 'brute', 3200, 2150, 0);
    expect(objectiveGoal(w, a, 0)!.kind).toBe('zone');
  });

  it('hot point: rank % 10 < 7 converge; ≤ 10 s before a move rank % 5 < 2 pre-rotate to the next site', () => {
    const w = makeWorld(makeMap(), 'teams');
    const sites: MapFeature[] = [
      { kind: 'hotSite', team: -1, index: 0, x: 3200, y: 3200, radius: 240 },
      { kind: 'hotSite', team: -1, index: 1, x: 3200, y: 1200, radius: 240 },
    ];
    w.map.features = sites;
    w.objective = makeObjective('hotpoint', {
      zones: [makeZone(0, 3200, 3200, 240)],
      hot: { site: 0, nextSite: -1, moveTick: 3600, warnTick: 3000, armTick: 0, moves: 0, recent: [] },
    });
    const me = makeShip(w, 'tech', 1000, 1000, 0);
    const kinds = () => Array.from({ length: 10 }, (_, r) => objectiveGoal(w, me, r)?.kind ?? null);
    expect(kinds()).toEqual(['hot', 'hot', 'hot', 'hot', 'hot', 'hot', 'hot', null, null, null]);
    expect(objectiveGoal(w, me, 0)!.score).toBe(1.0);
    w.tick = 3050; w.objective.hot!.nextSite = 1;
    expect(kinds()).toEqual(['hotNext', 'hotNext', 'hot', 'hot', 'hot', 'hotNext', 'hotNext', null, null, null]);
    const g = objectiveGoal(w, me, 0)!;
    expect([g.x, g.y]).toEqual([3200, 1200]);
  });

  it('no objective (deathmatch / dungeon / not set) → no goal', () => {
    const w = makeWorld(makeMap(), 'teams');
    const me = makeShip(w, 'tech', 1000, 1000, 0);
    expect(objectiveGoal(w, me, 0)).toBeNull();
    w.objective = null;
    expect(objectiveGoal(w, me, 0)).toBeNull();
  });
});

describe('v0.3 M3 objective bots (ready gates)', () => {
  it('GATE: a carrier paths home around a wall, and never attaches (even with a free host beside it)', () => {
    // a wall between the carrier and its own stand
    const map = makeMap([[60, 40, 63, 160]]);
    const w = makeWorld(map, 'teams');
    const own = makeFlag(0, 800, 3200), enemy = makeFlag(1, 5600, 3200);
    w.objective = makeObjective('ctf', { flags: [own, enemy] });
    const me = makeShip(w, 'tech', 4000, 3200, 0);
    const host = makeShip(w, 'brute', 4050, 3200, 0, false, 'bulwark'); // a tempting battle station
    host.stats.maxTurrets = 5;
    makeShip(w, 'brute', 6200, 6200, 1);
    carry(enemy, me);
    const brain = createBotBrain('normal', 77);
    let attaches = 0, best = Infinity, arrivedAt = -1;
    run(w, me, brain, 60 * 30, (inp, tick) => {
      if (inp.attach) attaches++;
      enemy.x = me.x; enemy.y = me.y;
      const d = distTo(me, own.standX, own.standY);
      best = Math.min(best, d);
      if (d < 90 && arrivedAt < 0) arrivedAt = tick;
    });
    expect(attaches).toBe(0);
    expect(best).toBeLessThan(90); // CTF_CAPTURE_RADIUS
    expect(arrivedAt).toBeGreaterThan(0);
    expect(arrivedAt).toBeLessThan(60 * 25);
  });

  it('GATE: the nearest 2 return a dropped flag; the others keep their roles', () => {
    const w = makeWorld(makeMap(), 'teams');
    const own = makeFlag(0, 800, 800, { state: 'dropped', x: 3200, y: 5000 });
    const enemy = makeFlag(1, 5600, 800);
    w.objective = makeObjective('ctf', { flags: [own, enemy] });
    makeShip(w, 'brute', 6200, 6200, 1);
    const spots: [number, number][] = [[3200, 4400], [3900, 5500], [1000, 1200], [5000, 1000]];
    const pilots: Pilot[] = spots.map(([x, y], i) => ({ s: makeShip(w, 'tech', x, y, 0), b: createBotBrain('normal', 300 + i) }));
    const closest = pilots.map(() => Infinity);
    runAll(w, pilots, 60 * 12, () => {
      pilots.forEach(({ s }, i) => { closest[i] = Math.min(closest[i], distTo(s, own.x, own.y)); });
    });
    expect(closest[0]).toBeLessThan(60); // touch
    expect(closest[1]).toBeLessThan(60);
    expect(closest[2]).toBeGreaterThan(2500); // defender stays home
    expect(closest[3]).toBeGreaterThan(2500); // runner goes for the enemy stand
    expect(distTo(pilots[3].s, enemy.standX, enemy.standY)).toBeLessThan(400);
  });

  it('GATE: bots occupy zones (every pad manned, and they stay on them)', () => {
    const w = makeWorld(makeMap(), 'teams');
    const zs = [makeZone(0, 3200, 3200), makeZone(1, 3200, 1900), makeZone(2, 3200, 4500)];
    w.objective = makeObjective('zones', { zones: zs, limit: 300 });
    makeShip(w, 'brute', 6200, 6200, 1);
    const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
    const pilots: Pilot[] = Array.from({ length: 6 }, (_, i) =>
      ({ s: makeShip(w, cls[i % 3], 900 + (i % 2) * 120, 2900 + i * 110, 0), b: createBotBrain('normal', 400 + i) }));
    const inside = (z: ZoneObjective) => pilots.filter(({ s }) => distTo(s, z.x, z.y) < z.radius).length;
    let samples = 0, manned = 0, bodies = 0;
    runAll(w, pilots, 60 * 30, (tick) => {
      if (tick < 60 * 20 || tick % 10) return;
      samples++;
      if (zs.every((z) => inside(z) >= 1)) manned++;
      bodies += zs.reduce((n, z) => n + inside(z), 0);
    });
    expect(manned / samples).toBeGreaterThan(0.9);
    expect(bodies / samples).toBeGreaterThanOrEqual(5); // of 6 pilots
  });

  it('GATE: bots converge on the hot point, and pre-rotate to the next site before a move', () => {
    const w = makeWorld(makeMap(), 'teams');
    w.map.features = [
      { kind: 'hotSite', team: -1, index: 0, x: 3200, y: 3200, radius: 240 },
      { kind: 'hotSite', team: -1, index: 1, x: 3200, y: 1300, radius: 240 },
    ];
    const hz = makeZone(0, 3200, 3200, 240);
    w.objective = makeObjective('hotpoint', {
      zones: [hz], limit: 200,
      hot: { site: 0, nextSite: -1, moveTick: 60 * 40, warnTick: 60 * 30, armTick: 0, moves: 0, recent: [] },
    });
    makeShip(w, 'brute', 6200, 6200, 1);
    const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
    const pilots: Pilot[] = Array.from({ length: 10 }, (_, i) =>
      ({ s: makeShip(w, cls[i % 3], 900 + (i % 2) * 150, 2500 + i * 140, 0), b: createBotBrain('normal', 500 + i) }));
    const onPoint = (x: number, y: number) => pilots.filter(({ s }) => distTo(s, x, y) < 240).length;
    runAll(w, pilots, 60 * 25);
    expect(onPoint(3200, 3200)).toBeGreaterThanOrEqual(7);
    // T - 10 s: the next site is announced; ranks 0, 1, 5, 6 rotate there, the rest keep the point
    w.tick = 60 * 31; w.objective.hot!.nextSite = 1;
    runAll(w, pilots, 60 * 8);
    expect(onPoint(3200, 1300)).toBeGreaterThanOrEqual(3);
    expect(onPoint(3200, 3200)).toBeGreaterThanOrEqual(2);
  });

  it('turret rolls prefer our carrier (the gunner seat), and a carrier with its seat taken is skipped', () => {
    const w = makeWorld(makeMap(), 'teams');
    const own = makeFlag(0, 800, 3200), enemy = makeFlag(1, 5600, 3200);
    w.objective = makeObjective('ctf', { flags: [own, enemy] });
    makeShip(w, 'brute', 6200, 6200, 1);
    const station = makeShip(w, 'brute', 1500, 3200, 0, false, 'bulwark'); // closer, roomier host
    station.stats.maxTurrets = 5;
    const runner = makeShip(w, 'brute', 4500, 3200, 0, false);
    carry(enemy, runner);
    const bot = makeShip(w, 'tech', 1300, 3200, 0);
    const targets: number[] = [];
    run(w, bot, createBotBrain('normal', 11), 60 * 60, (inp) => {
      if (inp.attach) targets.push(inp.attachTarget);
      enemy.x = runner.x; enemy.y = runner.y;
    }, { pinned: true });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((id) => id === runner.id)).toBe(true);
    // seat taken: the carrier is no longer offered (hostSeats = 1)
    runner.turrets.push(4242);
    const t2: number[] = [];
    run(w, bot, createBotBrain('normal', 12), 60 * 60, (inp) => { if (inp.attach) t2.push(inp.attachTarget); }, { pinned: true });
    expect(t2.includes(runner.id)).toBe(false);
  });

  it('fight damping: a defender keeps its stand instead of chasing a ship 1000 px away', () => {
    const mk = (withObjective: boolean) => {
      const w = makeWorld(makeMap(), 'teams');
      if (withObjective) w.objective = makeObjective('ctf', { flags: [makeFlag(0, 1600, 3200), makeFlag(1, 5600, 3200)] });
      makeShip(w, 'tech', 6000, 6000, 0); makeShip(w, 'tech', 6000, 6100, 0); // ranks 0, 1 (far away)
      const me = makeShip(w, 'tech', 1650, 3200, 0); // rank 2 = defender
      const foe = makeShip(w, 'brute', 2650, 3200, 1, false);
      let far = 0;
      run(w, me, createBotBrain('normal', 21), 60 * 8, () => {
        foe.x = 2650; foe.y = 3200; foe.energy = foe.stats.maxEnergy;
        far = Math.max(far, distTo(me, 1600, 3200));
      });
      return far;
    };
    expect(mk(true)).toBeLessThan(DEFEND_HOLD_R + 60);
    expect(mk(false)).toBeGreaterThan(DEFEND_HOLD_R + 60); // control: without the objective it goes to fight
  });

  it('bots ignore in-world loot caches (identical inputs with and without them)', () => {
    const trace = (withLoot: boolean) => {
      nextId = 5000;
      const w = makeWorld(makeMap(), 'ffa');
      const me = makeShip(w, 'tech', 2000, 2000);
      makeShip(w, 'brute', 3200, 2400);
      if (withLoot) {
        w.loot ??= new Map();
        for (let i = 0; i < 6; i++) {
          w.loot.set(90000 + i, {
            id: 90000 + i, x: 2100 + i * 30, y: 2050, vx: 0, vy: 0, token: { rarity: 4, set: 'common', source: 'elite' },
            spawnTick: 0, expireTick: 1e9, reservedFor: 0, reservedUntilTick: 0, droppedBy: 0,
          });
        }
      }
      const out: string[] = [];
      run(w, me, createBotBrain('hard', 31), 600, (inp) => out.push(JSON.stringify(inp)));
      return out;
    };
    expect(trace(true)).toEqual(trace(false));
  });

  it('+20% target weight on a hostile loot carrier (≥ 3 caches or an epic+ one)', () => {
    const pick = (carriedOn: 'a' | 'b' | 'none') => {
      const w = makeWorld(makeMap(), 'ffa');
      const me = makeShip(w, 'tech', 2000, 2000);
      const a = makeShip(w, 'brute', 2000, 1500, -1, false), b = makeShip(w, 'brute', 2000, 2510, -1, false);
      const cache = { rarity: 0 as const, set: 'common' as const, source: 'elite' as const };
      if (carriedOn !== 'none') (carriedOn === 'a' ? a : b).carried = [cache, cache, cache];
      let aimA = 0, aimB = 0;
      run(w, me, createBotBrain('hard', 41), 60, (inp, tick) => {
        if (tick < 30) return;
        if (Math.abs(angDiff(inp.aim, -Math.PI / 2)) < 0.3) aimA++;
        if (Math.abs(angDiff(inp.aim, Math.PI / 2)) < 0.3) aimB++;
      }, { pinned: true });
      return aimA > aimB ? 'a' : 'b';
    };
    expect(pick('none')).toBe('a'); // control: the nearer one
    expect(pick('b')).toBe('b');    // the loot carrier wins despite being a little farther
  });
});

describe('v0.3 M3 objective bots (tuning: dives, pad holds, carrier escapes)', () => {
  it('attackers dive for a flag they are close to (+0.4 x (1 - d/600)); far away the §5.7 score stands', () => {
    const w = makeWorld(makeMap(), 'teams');
    w.objective = makeObjective('ctf', { flags: [makeFlag(0, 800, 3200), makeFlag(1, 5600, 3200)] });
    const me = makeShip(w, 'tech', 2000, 3200, 0); // rank 0 = attacker
    expect(objectiveGoal(w, me, 0)!.score).toBeCloseTo(OBJ_SCORE.attack + OBJ_SCORE.attackOpen);
    me.x = 5600 - 300;
    const near = objectiveGoal(w, me, 0)!;
    expect(near.kind).toBe('attack');
    expect(near.score).toBeCloseTo(OBJ_SCORE.attack + OBJ_SCORE.attackOpen + OBJ_SCORE.attackDive * (1 - 300 / ATTACK_DIVE_R));
    expect(near.padR).toBe(0); // a flag stand is not a capture pad
  });

  it('hot point: a pilot whose side is capping alone keeps capping (bonus + stay), whatever its rank', () => {
    const w = makeWorld(makeMap(), 'teams');
    const hz = makeZone(0, 3200, 3200, 240);
    w.objective = makeObjective('hotpoint', {
      zones: [hz], limit: 200, hot: { site: 0, nextSite: -1, moveTick: 60 * 60, warnTick: 60 * 50, armTick: 0, moves: 0, recent: [] },
    });
    const me = makeShip(w, 'tech', 3600, 3200, 0);
    expect(objectiveGoal(w, me, 8)).toBeNull(); // rank 8, off the pad: not in the converge set
    me.x = 3250; // alone on the armed neutral pad: its presence caps it, so it works the pad
    const g0 = objectiveGoal(w, me, 8)!;
    expect([g0.kind, g0.stay]).toEqual(['hot', true]);
    hz.capTeam = 0; hz.progress = 0.4;
    const g = objectiveGoal(w, me, 8)!;
    expect([g.kind, g.stay, g.padR]).toEqual(['hot', true, 240]);
    expect(g.score).toBeCloseTo(OBJ_SCORE.hot + OBJ_SCORE.hotCapping);
    // rolling back another side's partial progress first (capTeam is still theirs): still working it
    hz.capTeam = 1; hz.progress = 0.3;
    expect(objectiveGoal(w, me, 8)!.stay).toBe(true);
    // our own pad, secure: a plain hold (teams) — rank 8 goes back to its role
    hz.capTeam = -1; hz.progress = 0; hz.owner = 0;
    expect(objectiveGoal(w, me, 8)).toBeNull();
    expect(objectiveGoal(w, me, 0)!.stay).toBeUndefined();
    hz.owner = -1; hz.capTeam = 0; hz.progress = 0.4;
    hz.contested = true; // contested: no progress to protect, back to the plain role
    expect(objectiveGoal(w, me, 8)).toBeNull();
    expect(objectiveGoal(w, me, 0)!.stay).toBeUndefined();
    // FFA: the capper is a pilot
    const f = makeWorld(makeMap(), 'ffa');
    const fz = makeZone(0, 3200, 3200, 240, { capPlayerId: 0, progress: 0.5 });
    f.objective = makeObjective('hotpoint', { zones: [fz], teamPoints: [], hot: { ...w.objective.hot! } });
    const p = makeShip(f, 'tech', 3200, 3150, -1);
    fz.capPlayerId = p.playerId;
    expect(objectiveGoal(f, p, 9)!.stay).toBe(true);
    // FFA owner alone on the point: it scores only while it stays, so it holds (stay) and damps off-pad fights
    fz.capPlayerId = 0; fz.progress = 0; fz.ownerPlayerId = p.playerId;
    const h = objectiveGoal(f, p, 9)!;
    expect([h.stay, h.padFightMult]).toEqual([true, HOT_FFA_PAD_FIGHT_MULT]);
    // FFA converge set is smaller than the teams one (rank % 10 < 5)
    p.x = 3700;
    expect(objectiveGoal(f, p, HOT_CONVERGE_FFA)).toBeNull();
    expect(objectiveGoal(f, p, HOT_CONVERGE_FFA - 1)).not.toBeNull();
  });

  it('on a capture pad a pilot shoots from it instead of chasing a ship off it (control: no pad → it chases)', () => {
    const far = (withObjective: boolean) => {
      const w = makeWorld(makeMap(), 'teams');
      if (withObjective) {
        w.objective = makeObjective('hotpoint', {
          zones: [makeZone(0, 3200, 3200, 240)], limit: 200,
          hot: { site: 0, nextSite: -1, moveTick: 60 * 60, warnTick: 60 * 50, armTick: 0, moves: 0, recent: [] },
        });
      }
      const me = makeShip(w, 'tech', 3200, 3200, 0);
      const foe = makeShip(w, 'brute', 3200 + 560, 3200, 1, false);
      foe.bounty = 120; // a juicy, weak target just off the pad
      let maxD = 0;
      run(w, me, createBotBrain('normal', 61), 60 * 8, () => {
        foe.x = 3200 + 560; foe.y = 3200; foe.energy = foe.stats.maxEnergy * 0.25;
        maxD = Math.max(maxD, distTo(me, 3200, 3200));
      });
      return maxD;
    };
    expect(far(true)).toBeLessThan(240);
    expect(far(false)).toBeGreaterThan(240);
  });

  it('a chased tech carrier blinks home along its route, planned at the halved carrier range', () => {
    const w = makeWorld(makeMap(), 'teams');
    const own = makeFlag(0, 800, 3200), enemy = makeFlag(1, 5600, 3200);
    w.objective = makeObjective('ctf', { flags: [own, enemy] });
    const me = makeShip(w, 'tech', 4000, 3200, 0);
    carry(enemy, me);
    const chaser = makeShip(w, 'brute', 4450, 3200, 1, false);
    const blinks: { aim: number; dist: number }[] = [];
    runEcon(w, me, createBotBrain('hard', 71), 60 * 6, (inp) => {
      if (inp.mobility) blinks.push({ aim: inp.aim, dist: inp.aimDist });
      enemy.x = me.x; enemy.y = me.y;
      chaser.x = me.x + 450; chaser.y = me.y; // stays on its tail
    });
    expect(blinks.length).toBeGreaterThan(0);
    for (const b of blinks) {
      expect(Math.abs(angDiff(b.aim, Math.PI))).toBeLessThan(0.35); // toward the home stand (−x)
      expect(b.dist).toBeCloseTo((me.stats.skill.blinkRange ?? 480) * CTF_CARRIER_BLINK_MULT, 0);
    }
  });
});
