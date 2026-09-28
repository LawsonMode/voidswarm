// OWNER: PVE agent. v0.3 M2 loot hooks in killEnemy (docs/v0.3-proposal.md §6.3, §9 PVE acceptance).
// Real combat / map / world; sim/loot.ts is the real module, with rollLoot wrapped in a spy so the hook
// contract (who rolls what, with which priority) is checked separately from SIM's roll internals.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../loot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../loot')>();
  return { ...actual, rollLoot: vi.fn(actual.rollLoot) };
});

import { DT, TICK_RATE } from '../../constants';
import type { Deployable, EnemyKind, GameMap, LootDrop, Ship, ShipClassId, SimConfig, World } from '../../types';
import { emptyInput } from '../../types';
import { rollLoot } from '../loot';
import { createWorld, rebuildGrid } from '../world';
import { onEnemyKilled, pveInit, pveStep } from './index';
import { ENEMY_DEFS, enemyLootSource, killEnemy, spawnEnemy } from './enemies';
import { computeStats } from './upgrades';
import { xpToNextFor } from './xp';

const roll = vi.mocked(rollLoot);
beforeEach(() => { roll.mockClear(); }); // braces: a returned function would run as a teardown

function makeMap(size = 6400): GameMap {
  const tileSize = 32, cols = size / tileSize, rows = size / tileSize;
  return { seed: 1, teamCount: 2, width: size, height: size, tileSize, cols, rows, tiles: new Uint8Array(cols * rows), spawns: [] };
}

/** Warzone (elite 5%, boss 100%); pveIntensity 0 so the director never spawns on its own. */
function makeConfig(o: Partial<SimConfig> = {}): SimConfig {
  return {
    mapSeed: 42, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false,
    gameType: 'warzone', subMode: 'deathmatch', ...o,
  };
}

function makeWorld(o: Partial<SimConfig> = {}): World {
  const world = createWorld(makeConfig(o), makeMap());
  pveInit(world);
  world.tick = 100;
  return world;
}

let nextPid = 1;
function makeShip(world: World, x: number, y: number, o: { team?: number; cls?: ShipClassId; human?: boolean } = {}): Ship {
  const id = world.nextId++;
  const cls = o.cls ?? 'brute';
  const stats = computeStats(cls, {});
  const s: Ship = {
    id, playerId: nextPid++, name: 'p' + id, team: o.team ?? 0, shipClass: cls, isBot: !o.human,
    x, y, vx: 0, vy: 0, angle: 0, alive: true, respawnTick: 0, invulnUntilTick: 0,
    energy: stats.maxEnergy, stats, input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0, path: null,
    gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
    utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0, skillState: {},
    attachedTo: 0, turrets: [], xp: 0, level: 1, xpToNext: xpToNextFor(1), offers: [], offerSerial: 0, upgrades: {}, autoState: {},
    kills: 0, deaths: 0, score: 0, bounty: 10, killStreak: 0, enemyKills: 0, lastDamagedBy: 0, lastDamagedTick: 0, flags: 0,
  };
  world.ships.set(id, s);
  world.shipsByPlayer.set(s.playerId, id);
  return s;
}

function makeSentry(world: World, x: number, y: number): Deployable {
  const d: Deployable = {
    id: world.nextId++, kind: 'sentry', ownerId: 0, ownerPlayerId: 0, team: 0, x, y, vx: 0, vy: 0,
    angle: 0, hp: 600, maxHp: 600, radius: 14, length: 0, spawnTick: 0, expireTick: 1e9, power: 0, mem: {},
  };
  world.deployables.set(d.id, d);
  return d;
}

function tickOnce(world: World): void {
  world.tick++;
  rebuildGrid(world);
  pveStep(world, DT);
}

function drops(world: World): LootDrop[] {
  return [...(world.loot?.values() ?? [])];
}

/** Every non-hive, non-matriarch kind can be elite (waves.ts rolls elite for all but blackhole / hive). */
const ELITE_KINDS: EnemyKind[] = ['drone', 'dart', 'weaver', 'splitter', 'splitling', 'spinner', 'brute', 'blackhole'];

// ---------------------------------------------------------------------------------------------
// Hook contract (independent of how sim/loot.ts rolls)
// ---------------------------------------------------------------------------------------------

describe('PVE loot hooks: which deaths roll (§6.3)', () => {
  it('enemyLootSource: Hive → boss, elites → elite, everything else (incl. the Matriarch) → none', () => {
    for (const kind of Object.keys(ENEMY_DEFS) as EnemyKind[]) {
      const w = makeWorld();
      const plain = spawnEnemy(w, kind, 1000, 1000)!;
      const elite = spawnEnemy(w, kind, 2000, 2000, { elite: true })!;
      if (kind === 'hive') {
        expect(enemyLootSource(plain)).toBe('boss');
        expect(enemyLootSource(elite)).toBe('boss');
      } else if (kind === 'matriarch') {
        expect(enemyLootSource(plain)).toBeNull(); // M4: personal bossCache, not 'boss'
        expect(enemyLootSource(elite)).toBeNull();
      } else {
        expect(enemyLootSource(plain)).toBeNull();
        expect(enemyLootSource(elite)).toBe('elite');
      }
    }
  });

  it('an elite ship kill rolls elite once, at the death spot, with the killer as priority', () => {
    for (const kind of ELITE_KINDS) {
      roll.mockClear();
      const w = makeWorld();
      const killer = makeShip(w, 3000, 3000, { human: true });
      const e = spawnEnemy(w, kind, 1234, 2345, { elite: true })!;
      onEnemyKilled(w, e, killer.id);
      expect(w.enemies.has(e.id)).toBe(false);
      expect(roll).toHaveBeenCalledTimes(1);
      expect(roll).toHaveBeenCalledWith(w, 'elite', 1234, 2345, { priorityPid: killer.playerId });
    }
  });

  it('a bot killer gets the priority too (bots never pick up, so it lapses after 3 s)', () => {
    const w = makeWorld();
    const bot = makeShip(w, 3000, 3000);
    const e = spawnEnemy(w, 'spinner', 1500, 1500, { elite: true })!;
    onEnemyKilled(w, e, bot.id);
    expect(roll).toHaveBeenCalledWith(w, 'elite', 1500, 1500, { priorityPid: bot.playerId });
  });

  it('non-elite kills never roll; an elite with no ship killer (killerShipId 0) never rolls', () => {
    const w = makeWorld();
    const killer = makeShip(w, 3000, 3000, { human: true });
    for (const kind of ELITE_KINDS) onEnemyKilled(w, spawnEnemy(w, kind, 1000, 1000)!, killer.id);
    for (const kind of ELITE_KINDS) onEnemyKilled(w, spawnEnemy(w, kind, 1000, 1000, { elite: true })!, 0);
    expect(roll).not.toHaveBeenCalled();
  });

  it('a killer ship that already left still makes it a ship kill, with no priority', () => {
    const w = makeWorld();
    const e = spawnEnemy(w, 'brute', 900, 800, { elite: true })!;
    killEnemy(w, e, 9999); // killerShipId ≠ 0, but no such ship any more
    expect(roll).toHaveBeenCalledTimes(1);
    expect(roll).toHaveBeenCalledWith(w, 'elite', 900, 800, { priorityPid: 0 });
  });

  it('a Hive ship kill rolls boss (never elite); a killerless Hive death rolls nothing', () => {
    const w = makeWorld();
    const killer = makeShip(w, 4000, 4000, { human: true });
    const hive = spawnEnemy(w, 'hive', 2000, 2000)!;
    onEnemyKilled(w, hive, killer.id);
    expect(roll).toHaveBeenCalledTimes(1);
    expect(roll).toHaveBeenCalledWith(w, 'boss', 2000, 2000, { priorityPid: killer.playerId });
    expect(w.pve.bossAlive).toBe(false);

    roll.mockClear();
    onEnemyKilled(w, spawnEnemy(w, 'hive', 2000, 2000)!, 0);
    expect(roll).not.toHaveBeenCalled();
  });

  it('a second kill of an already-removed enemy never rolls again', () => {
    const w = makeWorld();
    const killer = makeShip(w, 3000, 3000, { human: true });
    const e = spawnEnemy(w, 'drone', 1000, 1000, { elite: true })!;
    onEnemyKilled(w, e, killer.id);
    onEnemyKilled(w, e, killer.id);
    expect(roll).toHaveBeenCalledTimes(1);
  });

  it('vanish deaths never roll: kamikaze pop on a ship, sentry suicide, black-hole consumption', () => {
    // kamikaze pop on a plain ship
    let w = makeWorld();
    const plain = makeShip(w, 1000, 1000, { human: true });
    const pop = spawnEnemy(w, 'drone', 1000 + plain.stats.radius, 1000, { elite: true })!;
    tickOnce(w);
    expect(w.enemies.has(pop.id)).toBe(false);
    expect(plain.energy).toBeLessThan(plain.stats.maxEnergy); // it really hit (and vanished)

    // sentry suicide
    w = makeWorld();
    const sentry = makeSentry(w, 2000, 2000);
    const sui = spawnEnemy(w, 'dart', 2005, 2000, { elite: true })!;
    tickOnce(w);
    expect(w.enemies.has(sui.id)).toBe(false);
    expect(sentry.hp).toBeLessThan(600);

    // consumed by a black hole
    w = makeWorld();
    const bh = spawnEnemy(w, 'blackhole', 3000, 3000)!;
    const food = spawnEnemy(w, 'weaver', 3001, 3000, { elite: true })!;
    tickOnce(w);
    expect(w.enemies.has(food.id)).toBe(false);
    expect(bh.mem.fed).toBe(1);

    expect(roll).not.toHaveBeenCalled();
  });

  it('a Spiked Prow ram kill of an elite swarmer is a ship kill: gems + credit + the elite roll for the rammer', () => {
    const w = makeWorld();
    const ram = makeShip(w, 1000, 1000, { human: true });
    ram.upgrades['path:ram'] = 1; ram.path = 'ram';
    ram.stats = computeStats('brute', ram.upgrades);
    const d = spawnEnemy(w, 'drone', 1000 + ram.stats.radius, 1000, { elite: true })!;
    tickOnce(w);
    expect(w.enemies.has(d.id)).toBe(false);
    expect(ram.enemyKills).toBe(1);
    expect(w.gems.size + ram.xp).toBeGreaterThan(0);
    expect(roll).toHaveBeenCalledTimes(1);
    expect(roll.mock.calls[0][1]).toBe('elite');
    expect(roll.mock.calls[0][4]).toEqual({ priorityPid: ram.playerId });
  });
});

// ---------------------------------------------------------------------------------------------
// §9 PVE M2 acceptance (real sim/loot.ts rolls)
// ---------------------------------------------------------------------------------------------

describe('PVE loot acceptance (§9 M2)', () => {
  it('an elite kill with lootMult 1 creates a cache reserved for the killer for 3 s', () => {
    const w = makeWorld({ lootMult: 1, lootSeed: 0x1234abcd });
    const killer = makeShip(w, 3000, 3000, { human: true });
    // p = 5% per elite kill in Warzone: kill elites until one drops (seeded, so this is deterministic).
    let kills = 0, dropTick = -1;
    for (; kills < 2000 && (w.loot?.size ?? 0) === 0; kills++) {
      w.events.length = 0;
      w.tick++;
      const e = spawnEnemy(w, 'drone', 1600, 1700, { elite: true })!;
      onEnemyKilled(w, e, killer.id);
      if ((w.loot?.size ?? 0) > 0) dropTick = w.tick;
      for (const g of [...w.gems.keys()]) w.gems.delete(g); // keep the gem cap out of the way
    }
    const all = drops(w);
    expect(all.length).toBe(1);
    const c = all[0];
    expect(c.token.source).toBe('elite');
    expect(c.token.rarity).toBeGreaterThanOrEqual(0);
    expect(c.token.rarity).toBeLessThanOrEqual(4);
    expect(['common', 'swarm']).toContain(c.token.set);
    expect(c.reservedFor).toBe(killer.playerId);
    expect(c.reservedUntilTick).toBe(dropTick + 3 * TICK_RATE);
    expect(c.droppedBy).toBe(0);
    expect(Math.hypot(c.x - 1600, c.y - 1700)).toBeLessThan(64);
    expect(w.events.some((ev) => ev.t === 'lootDrop' && ev.source === 'elite' && ev.id === c.id)).toBe(true);
    // the rate is in the right ballpark (a single seeded hit well inside ~1/p kills)
    expect(kills).toBeLessThan(400);
  });

  it('a vanish creates none, even when every roll would hit', () => {
    const w = makeWorld({ lootMult: 1000, lootSeed: 7 }); // p = min(1, 0.05 × 1000) = 1
    const plain = makeShip(w, 1000, 1000, { human: true });
    spawnEnemy(w, 'drone', 1000 + plain.stats.radius, 1000, { elite: true });
    makeSentry(w, 2000, 2000);
    spawnEnemy(w, 'dart', 2005, 2000, { elite: true });
    tickOnce(w);
    expect(w.enemies.size).toBe(0);
    expect(drops(w).length).toBe(0);
    // a Spiked Prow ram kill is a ship kill, not a vanish: it rolls
    const ram = makeShip(w, 4000, 4000, { human: true });
    ram.upgrades['path:ram'] = 1; ram.path = 'ram';
    ram.stats = computeStats('brute', ram.upgrades);
    spawnEnemy(w, 'weaver', 4000 + ram.stats.radius, 4000, { elite: true });
    tickOnce(w);
    expect(w.enemies.size).toBe(0);
    expect(drops(w).length).toBe(1);
    expect(drops(w)[0].reservedFor).toBe(ram.playerId);
    for (const id of [...w.loot!.keys()]) w.loot!.delete(id);

    // control: the same lootMult on a real ship kill does drop
    const e = spawnEnemy(w, 'spinner', 5000, 5000, { elite: true })!;
    onEnemyKilled(w, e, plain.id);
    expect(drops(w).length).toBe(1);
  });

  it('a Hive kill gives rare or better, reserved for the killer for 3 s', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = makeWorld({ lootMult: 1, lootSeed: (seed * 0x9e3779b1) >>> 0 });
      const killer = makeShip(w, 4000, 4000, { human: true });
      const hive = spawnEnemy(w, 'hive', 2000, 2000)!;
      onEnemyKilled(w, hive, killer.id);
      const all = drops(w);
      expect(all.length).toBe(1);
      const c = all[0];
      expect(c.token.source).toBe('boss');
      expect(c.token.rarity).toBeGreaterThanOrEqual(2);
      expect(['common', 'swarm']).toContain(c.token.set);
      expect(c.reservedFor).toBe(killer.playerId);
      expect(c.reservedUntilTick).toBe(w.tick + 3 * TICK_RATE);
    }
  });

  it('loot never touches world.rng: the same kills leave the core rng stream identical with loot on or off', () => {
    const run = (o: Partial<SimConfig>): number[] => {
      const w = makeWorld(o);
      const killer = makeShip(w, 4000, 4000, { human: true });
      for (let i = 0; i < 60; i++) {
        w.tick++;
        onEnemyKilled(w, spawnEnemy(w, i % 2 ? 'splitter' : 'drone', 1000 + i * 10, 1000, { elite: true })!, killer.id);
      }
      onEnemyKilled(w, spawnEnemy(w, 'hive', 2000, 2000)!, killer.id);
      return [w.rng.next(), w.rng.next(), w.rng.next(), w.enemies.size];
    };
    const off = run({});
    expect(run({ lootMult: 0, lootSeed: 99 })).toEqual(off);
    expect(run({ lootMult: 1, lootSeed: 99 })).toEqual(off);
    expect(run({ lootMult: 1000, lootSeed: 12345 })).toEqual(off);
  });
});
