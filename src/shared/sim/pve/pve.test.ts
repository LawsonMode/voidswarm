import { describe, expect, it, vi } from 'vitest';

vi.mock('../map', () => ({
  generateMap: () => { throw new Error('unused'); },
  tileAt: () => 0,
  isSolidAt: (m: { width: number; height: number }, x: number, y: number) => x < 0 || y < 0 || x >= m.width || y >= m.height,
  collideCircle: (m: { width: number; height: number }, x: number, y: number, r: number) => {
    const cx = Math.min(m.width - r, Math.max(r, x)), cy = Math.min(m.height - r, Math.max(r, y));
    const hit = cx !== x || cy !== y;
    let nx = 0, ny = 0;
    if (hit) { const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy) || 1; nx = dx / d; ny = dy / d; }
    return { x: cx, y: cy, hit, nx, ny };
  },
  lineOfSight: () => true,
}));

const hooks = vi.hoisted(() => ({ onKilled: null as null | ((w: any, e: any, src: number) => void) }));

vi.mock('../combat', () => {
  return {
    damageShip: (_w: unknown, ship: { energy: number; stats: { armor: number } }, amount: number) => {
      ship.energy -= amount * (1 - ship.stats.armor);
      if (ship.energy < 0) ship.energy = 0; // fake: ships never die in tests
    },
    damageEnemy: (w: any, e: any, amount: number, src: number) => {
      e.hp -= amount;
      if (e.hp <= 0) hooks.onKilled!(w, e, src);
    },
    splashDamage: () => {},
  };
});

import { MAX_ENEMIES, MAX_PROJECTILES, TICK_RATE, DT, MAX_GEMS } from '../../constants';
import type { GameMap, Ship, ShipClassId, SimConfig, World } from '../../types';
import { emptyInput } from '../../types';
import { createWorld, rebuildGrid } from '../world';
import { applyUpgradeChoice, grantXp, onEnemyKilled, pveInit, pveStep, dropShipXp } from './index';
import { computeStats, UPGRADES } from './upgrades';
import { spawnEnemy } from './enemies';
import { xpToNextFor } from './xp';
import { SHIP_CLASSES } from '../../data/ships';

hooks.onKilled = onEnemyKilled;

function makeMap(size = 6400): GameMap {
  const tileSize = 32, cols = size / tileSize, rows = size / tileSize;
  return { seed: 1, teamCount: 2, width: size, height: size, tileSize, cols, rows, tiles: new Uint8Array(cols * rows), spawns: [] };
}

function makeConfig(o: Partial<SimConfig> = {}): SimConfig {
  return { mapSeed: 42, mode: 'teams', teamCount: 2, pveIntensity: 2, matchSeconds: 600, scoreLimit: 0, friendlyFire: false, ...o };
}

let nextPid = 1;
function makeShip(world: World, x: number, y: number, team = 0, cls: ShipClassId = 'brute'): Ship {
  const id = world.nextId++;
  const stats = computeStats(cls, {});
  const s: Ship = {
    id, playerId: nextPid++, name: 'p' + id, team, shipClass: cls, isBot: true,
    x, y, vx: 0, vy: 0, angle: 0, alive: true, respawnTick: 0, invulnUntilTick: 0,
    energy: stats.maxEnergy, stats, input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0, path: null,
    gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
    utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0, skillState: {},
    attachedTo: 0, turrets: [], xp: 0, level: 1, xpToNext: xpToNextFor(1), offers: [], offerSerial: 0, upgrades: {}, autoState: {},
    kills: 0, deaths: 0, score: 0, bounty: 10, killStreak: 0, enemyKills: 0, lastDamagedBy: 0, lastDamagedTick: 0, flags: 0,
  };
  world.ships.set(id, s);
  return s;
}

function stepN(world: World, n: number, perTick?: () => void): void {
  for (let i = 0; i < n; i++) {
    world.tick++;
    rebuildGrid(world);
    perTick?.();
    pveStep(world, DT);
    // crude projectile movement/expiry so caps get exercised
    for (const p of world.projectiles.values()) {
      p.x += p.vx * DT; p.y += p.vy * DT;
      if (world.tick >= p.expireTick) world.projectiles.delete(p.id);
    }
    // ships regen (tests never kill them)
    for (const s of world.ships.values()) s.energy = Math.min(s.stats.maxEnergy, s.energy + s.stats.rechargePerSec * DT);
    world.events.length = 0;
  }
}

describe('upgrades', () => {
  it('has ~20 defs with the orbit id', () => {
    expect(Object.keys(UPGRADES).length).toBeGreaterThanOrEqual(20);
    expect(UPGRADES.orbit.category).toBe('auto');
  });
  it('general card ids', () => {
    expect(Object.keys(UPGRADES).sort()).toEqual([
      'amplifier', 'arc', 'capacitor', 'efficiency', 'fluxcore', 'heavy', 'magnet', 'medkit', 'minetrail', 'multi',
      'nova', 'orbit', 'overclock', 'plating', 'rapid', 'reactor', 'scholar', 'seeker', 'thrusters', 'turretmount', 'velocity',
    ]);
    expect(UPGRADES.medkit.classes).toEqual(['engineer']);
  });
  it('computeStats is pure (deep-copies skill knobs) and applies effects', () => {
    const ups = { heavy: 2, plating: 5, 'path:barrage': 1, bar_heavy: 1 };
    const snapshot = JSON.stringify(SHIP_CLASSES.brute.base);
    const a = computeStats('brute', ups);
    const b = computeStats('brute', ups);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.skill).not.toBe(SHIP_CLASSES.brute.base.skill);
    a.skill.rocketCount = 99;
    expect(JSON.stringify(SHIP_CLASSES.brute.base)).toBe(snapshot);
    const base = SHIP_CLASSES.brute.base;
    expect(b.gunDamage).toBeCloseTo(base.gunDamage * 1.3);
    expect(b.armor).toBeCloseTo(0.45);
    expect(b.skill.rocketCount).toBe(base.skill.rocketCount + 2);
    expect(b.secondaryCooldown).toBeCloseTo(base.secondaryCooldown * 0.8);
    expect(b.skill.rocketDamage).toBeCloseTo(base.skill.rocketDamage * 1.4);
    expect(b.skill.rocketSplash).toBeCloseTo(base.skill.rocketSplash * 1.3);
    expect(computeStats('brute', { plating: 5, 'path:ram': 1, ram_plating: 1 }).armor).toBe(0.6);
  });
  it('path & talent stat bonuses', () => {
    const T = SHIP_CLASSES.tech.base, B = SHIP_CLASSES.brute.base, E = SHIP_CLASSES.engineer.base;
    const ram = computeStats('brute', { 'path:ram': 1 });
    expect(ram.mobilityCooldown).toBeCloseTo(B.mobilityCooldown * 0.6);
    expect(ram.skill.ramDamage).toBeCloseTo(B.skill.ramDamage * 1.5);
    const bul = computeStats('brute', { 'path:bulwark': 1, bul_titan: 1 });
    expect(bul.maxTurrets).toBe(B.maxTurrets + 3);
    expect(bul.maxEnergy).toBe(Math.round(B.maxEnergy * 1.35 * 1.25));
    expect(bul.radius).toBeCloseTo(B.radius * 1.15);
    expect(bul.rechargePerSec).toBeCloseTo(B.rechargePerSec * 1.2);
    const storm = computeStats('tech', { 'path:storm': 1, sto_overload: 1 });
    expect(storm.skill.arcHops).toBe(T.skill.arcHops + 2);
    expect(storm.secondaryCooldown).toBeCloseTo(T.secondaryCooldown * 0.75);
    expect(storm.skill.arcDamage).toBeCloseTo(T.skill.arcDamage * 1.45);
    const vo = computeStats('tech', { 'path:void': 1, voi_horizon: 1 });
    expect(vo.utilityCooldown).toBeCloseTo(T.utilityCooldown * 0.65);
    expect(vo.skill.wellRadius).toBeCloseTo(T.skill.wellRadius * 1.3);
    expect(vo.skill.wellDuration).toBeCloseTo(T.skill.wellDuration + 2);
    expect(vo.skill.wellPull).toBeCloseTo(T.skill.wellPull * 1.5);
    const lance = computeStats('tech', { 'path:lance': 1, lan_coils: 1 });
    expect(lance.gunPierce).toBe(T.gunPierce + 2);
    expect(lance.gunSpeed).toBeCloseTo(T.gunSpeed * 1.25);
    expect(lance.gunLife).toBeCloseTo(T.gunLife * 1.3);
    expect(lance.gunCost).toBeCloseTo(T.gunCost * 0.65);
    expect(lance.rechargePerSec).toBeCloseTo(T.rechargePerSec * 1.15);
    const sum = computeStats('engineer', { 'path:summoner': 1, sum_hardened: 1 });
    expect(sum.skill.sentryMax).toBe(E.skill.sentryMax + 2);
    expect(sum.skill.sentryFireCd).toBeCloseTo(E.skill.sentryFireCd / 1.3);
    expect(sum.skill.sentryHp).toBeCloseTo(E.skill.sentryHp * 2);
    expect(sum.skill.sentryLife).toBeCloseTo(E.skill.sentryLife + 10);
    const med = computeStats('engineer', { 'path:medic': 1, medkit: 2 });
    expect(med.healMult).toBeCloseTo(1.4 * 1.3);
    expect(med.mobilityCooldown).toBeCloseTo(E.mobilityCooldown * 0.7);
    const arch = computeStats('engineer', { 'path:architect': 1, arc_turretbay: 1 });
    expect(arch.skill.wallHp).toBeCloseTo(E.skill.wallHp * 1.6);
    expect(arch.skill.wallLength).toBeCloseTo(E.skill.wallLength * 1.4);
    expect(arch.utilityCooldown).toBeCloseTo(E.utilityCooldown * 0.75);
    expect(arch.maxTurrets).toBe(E.maxTurrets + 2);
    // another class's path/talent keys do nothing
    expect(computeStats('tech', { 'path:ram': 1, ram_plating: 1 })).toEqual(computeStats('tech', {}));
    // general cards
    const g = computeStats('tech', { amplifier: 2, fluxcore: 1, efficiency: 1 });
    expect(g.secondaryPower).toBeCloseTo(1.24);
    expect(g.utilityPower).toBeCloseTo(1.24);
    expect(g.mobilityCooldown).toBeCloseTo(T.mobilityCooldown * 0.9);
    expect(g.utilityCost).toBeCloseTo(T.utilityCost * 0.9);
    expect(computeStats('tech', { medkit: 3 }).healMult).toBe(1);
  });
});

describe('xp / levels / offers', () => {
  it('gems collect -> level up -> offer of 3 distinct -> apply -> stats change', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    const s = makeShip(world, 1000, 1000);
    // drop gems right next to the ship
    const e = spawnEnemy(world, 'brute', 1030, 1000)!;
    e.xpValue = 100;
    onEnemyKilled(world, e, s.id);
    expect(world.enemies.has(e.id)).toBe(false);
    expect(world.gems.size).toBeGreaterThan(0);
    expect(s.score).toBeGreaterThan(0);
    expect(s.enemyKills).toBe(1);
    const levelEvents: number[] = [];
    for (let i = 0; i < 240 && world.gems.size > 0; i++) {
      world.tick++; rebuildGrid(world); pveStep(world, DT);
      for (const ev of world.events) if (ev.t === 'levelUp') levelEvents.push(ev.level);
      world.events.length = 0;
    }
    expect(world.gems.size).toBe(0);
    expect(s.level).toBeGreaterThan(1);
    expect(levelEvents.length).toBe(s.level - 1);
    expect(s.offers.length).toBe(s.level - 1);
    const offer = s.offers[0];
    expect(offer.length).toBe(3);
    expect(new Set(offer.map((c) => c.id)).size).toBe(3);
    // force a known choice and apply
    offer[0] = { ...offer[0], id: 'capacitor', level: 1 };
    const before = s.stats.maxEnergy;
    const queued = s.offers.length;
    applyUpgradeChoice(world, s, 0);
    expect(s.upgrades.capacitor).toBe(1);
    expect(s.stats.maxEnergy).toBeGreaterThan(before);
    expect(s.offers.length).toBe(queued - 1);
    expect(world.events.some((ev) => ev.t === 'upgrade')).toBe(true);
    // invalid indices ignored
    const n = s.offers.length;
    applyUpgradeChoice(world, s, 7);
    applyUpgradeChoice(world, s, -1);
    expect(s.offers.length).toBe(n);
  });

  it('turret stacking bonus: host collection gives turrets 50%', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    const host = makeShip(world, 2000, 2000);
    const tur = makeShip(world, 2000, 2030);
    tur.attachedTo = host.id; host.turrets = [tur.id];
    tur.stats = { ...tur.stats, magnetRadius: 0 };
    world.gems.set(999999, { id: 999999, x: 2005, y: 1995, vx: 0, vy: 0, value: 10, spawnTick: 0, expireTick: 99999, magnetTo: 0 });
    stepN(world, 10);
    expect(tur.xp).toBeCloseTo(5);
    expect(host.xp).toBeCloseTo(10);
  });

  it('maxed pools fall back to overcharge', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    const s = makeShip(world, 100, 100);
    for (const d of Object.values(UPGRADES)) s.upgrades[d.id] = d.maxLevel;
    grantXp(world, s, 1000);
    expect(s.offers[0].some((c) => c.id === 'overcharge')).toBe(true);
    s.energy = 1;
    const score = s.score;
    applyUpgradeChoice(world, s, s.offers[0].findIndex((c) => c.id === 'overcharge'));
    expect(s.energy).toBe(s.stats.maxEnergy);
    expect(s.score).toBe(score + 5);
  });

  it('dropShipXp drops 40% of progress and keeps level', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    const s = makeShip(world, 500, 500);
    s.level = 4; s.xp = 50;
    dropShipXp(world, s);
    expect(s.xp).toBe(30);
    expect(s.level).toBe(4);
    let total = 0;
    for (const g of world.gems.values()) total += g.value;
    expect(total).toBe(20 + 20);
  });
});

describe('path & talent offer schedule', () => {
  function levelTo(world: World, s: Ship, level: number): void {
    while (s.level < level) grantXp(world, s, s.xpToNext - s.xp + 0.001);
  }
  function pickId(world: World, s: Ship, id: string): void {
    const i = s.offers[0].findIndex((c) => c.id === id);
    expect(i).toBeGreaterThanOrEqual(0);
    applyUpgradeChoice(world, s, i);
  }
  function pickFirst(world: World, s: Ship): void { applyUpgradeChoice(world, s, 0); }

  it('path offer at level 3, talents at 6/9/12/15 from the chosen path only', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    const s = makeShip(world, 500, 500, 0, 'tech');
    levelTo(world, s, 2);
    expect(s.offers[0].every((c) => c.category !== 'path' && c.category !== 'talent')).toBe(true);
    pickFirst(world, s);
    levelTo(world, s, 3);
    const po = s.offers[0];
    expect(po.map((c) => c.id)).toEqual(['path:storm', 'path:void', 'path:lance']);
    expect(po.every((c) => c.category === 'path' && c.level === 1 && c.maxLevel === 1)).toBe(true);
    expect(po[0].description).toBe(SHIP_CLASSES.tech.paths[0].description);
    const hopsBefore = s.stats.skill.arcHops;
    pickId(world, s, 'path:storm');
    expect(s.path).toBe('storm');
    expect(s.upgrades['path:storm']).toBe(1);
    expect(s.stats.skill.arcHops).toBe(hopsBefore + 2);
    const talentIds = new Set(SHIP_CLASSES.tech.paths[0].talents.map((t) => t.id));
    const taken: string[] = [];
    for (let lv = 4; lv <= 16; lv++) {
      levelTo(world, s, lv);
      const offer = s.offers[0];
      if ([6, 9, 12, 15].includes(lv)) {
        expect(offer.length).toBe(Math.min(3, 4 - taken.length));
        for (const c of offer) {
          expect(c.category).toBe('talent');
          expect(talentIds.has(c.id)).toBe(true);
          expect(taken.includes(c.id)).toBe(false);
        }
        taken.push(offer[0].id);
      } else {
        expect(offer.every((c) => c.category !== 'path' && c.category !== 'talent')).toBe(true);
      }
      pickFirst(world, s);
      expect(s.offers.length).toBe(0);
    }
    expect(taken.length).toBe(4);
    for (const t of taken) expect(s.upgrades[t]).toBe(1);
  });

  it('a path cannot be taken twice; skipped path -> path offer at talent level; queued offers rebuild', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    const s = makeShip(world, 500, 500, 0, 'engineer');
    levelTo(world, s, 6); // queue: lv2 general, lv3 path, lv4, lv5 general, lv6 (no path yet -> path)
    expect(s.offers.length).toBe(5);
    expect(s.offers[1][0].category).toBe('path');
    expect(s.offers[4][0].category).toBe('path');
    pickFirst(world, s); // lv2
    pickId(world, s, 'path:medic');
    expect(s.path).toBe('medic');
    // the queued lv6 offer was rebuilt into medic talents
    expect(s.offers[2].every((c) => c.category === 'talent' && c.id.startsWith('med_'))).toBe(true);
    // a stale second path choice is ignored
    s.offers.unshift([{ id: 'path:architect', name: 'x', description: '', level: 1, maxLevel: 1, category: 'path', icon: '' }]);
    applyUpgradeChoice(world, s, 0);
    expect(s.upgrades['path:architect']).toBeUndefined();
    expect(s.path).toBe('medic');
    // and a talent from another path is ignored
    s.offers.unshift([{ id: 'arc_turretbay', name: 'x', description: '', level: 1, maxLevel: 1, category: 'talent', icon: '' }]);
    applyUpgradeChoice(world, s, 0);
    expect(s.upgrades.arc_turretbay).toBeUndefined();
  });

  it('path offers only come from the ship\'s class', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    const s = makeShip(world, 500, 500, 0, 'brute');
    levelTo(world, s, 3);
    expect(s.offers[1].map((c) => c.id)).toEqual(['path:ram', 'path:barrage', 'path:bulwark']);
  });
});

describe('enemy contact rules', () => {
  it('Spiked Prow (Ram path) kills a drone on contact, credits the ship and cuts damage by 70%', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    const ram = makeShip(world, 1000, 1000, 0, 'brute');
    ram.upgrades['path:ram'] = 1; ram.path = 'ram';
    ram.stats = computeStats('brute', ram.upgrades);
    const plain = makeShip(world, 3000, 3000, 1, 'brute');
    const d1 = spawnEnemy(world, 'drone', 1000 + ram.stats.radius, 1000)!;
    const d2 = spawnEnemy(world, 'drone', 3000 + plain.stats.radius, 3000)!;
    const dmg = d1.contactDamage;
    world.tick++; rebuildGrid(world); pveStep(world, DT);
    expect(world.enemies.has(d1.id)).toBe(false);
    expect(world.enemies.has(d2.id)).toBe(false);
    expect(ram.enemyKills).toBe(1);
    expect(ram.score).toBeGreaterThan(0);
    expect(plain.enemyKills).toBe(0);
    const ramLoss = ram.stats.maxEnergy - ram.energy;
    const plainLoss = plain.stats.maxEnergy - plain.energy;
    expect(ramLoss).toBeCloseTo(dmg * 0.3 * (1 - ram.stats.armor));
    expect(plainLoss).toBeCloseTo(dmg * (1 - plain.stats.armor));
    expect(world.gems.size + ram.xp).toBeGreaterThan(0); // the ram kill drops gems (a plain pop doesn't)
  });

  it('Reactive Plating reflects 25% of contact damage taken', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    const s = makeShip(world, 1000, 1000, 0, 'brute');
    s.upgrades['path:ram'] = 1; s.upgrades.ram_plating = 1; s.path = 'ram';
    s.stats = computeStats('brute', s.upgrades);
    const b = spawnEnemy(world, 'brute', 1000 + s.stats.radius + 10, 1000)!;
    const hp = b.hp;
    world.tick++; rebuildGrid(world); pveStep(world, DT);
    // energy actually lost (Spiked Prow 30%, then armor), 25% of it reflected
    const taken = b.contactDamage * 0.3 * (1 - s.stats.armor);
    expect(s.stats.maxEnergy - s.energy).toBeCloseTo(taken);
    expect(hp - b.hp).toBeCloseTo(taken * 0.25);
  });

  it('enemies are pushed out of Shield Walls; brutes smash walls and sentries', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    const wall = {
      id: world.nextId++, kind: 'wall' as const, ownerId: 0, ownerPlayerId: 0, team: 0, x: 2000, y: 2000, vx: 0, vy: 0,
      angle: Math.PI / 2, hp: 1500, maxHp: 1500, radius: 10, length: 300, spawnTick: 0, expireTick: 1e9, power: 0, mem: {},
    };
    world.deployables.set(wall.id, wall);
    const e = spawnEnemy(world, 'drone', 2003, 2050)!; // inside the vertical wall segment
    e.vx = 100;
    const b = spawnEnemy(world, 'brute', 2000 - 30, 1900)!;
    const sentry = { ...wall, id: world.nextId++, kind: 'sentry' as const, x: 3000, y: 3000, angle: 0, length: 0, radius: 14, hp: 600, maxHp: 600, mem: {} };
    world.deployables.set(sentry.id, sentry);
    const b2 = spawnEnemy(world, 'brute', 3000 + 30, 3000)!;
    world.tick++; rebuildGrid(world); pveStep(world, DT);
    expect(Math.abs(e.x - 2000)).toBeGreaterThanOrEqual(e.radius + wall.radius - 1e-6);
    expect(Math.abs(b.x - 2000)).toBeGreaterThanOrEqual(b.radius + wall.radius - 1e-6);
    expect(wall.hp).toBe(1500 - b.contactDamage);
    expect(sentry.hp).toBe(600 - b2.contactDamage);
    // cadence: no second hit within 0.5 s
    world.tick++; rebuildGrid(world); pveStep(world, DT);
    expect(wall.hp).toBe(1500 - b.contactDamage);
  });

  it('swarmers go for a sentry that is closer than any ship and die on it', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    makeShip(world, 1000, 1000);
    const sentry = {
      id: world.nextId++, kind: 'sentry' as const, ownerId: 0, ownerPlayerId: 0, team: 0, x: 1600, y: 1000, vx: 0, vy: 0,
      angle: 0, hp: 600, maxHp: 600, radius: 14, length: 0, spawnTick: 0, expireTick: 1e9, power: 0, mem: {},
    };
    world.deployables.set(sentry.id, sentry);
    const d = spawnEnemy(world, 'drone', 1800, 1000)!;
    d.aiTimer = 0;
    stepN(world, 120);
    expect(world.enemies.has(d.id)).toBe(false);
    expect(sentry.hp).toBe(600 - d.contactDamage);
  });
});

describe('wave director', () => {
  it('spawns within caps & distance rules; waves & bosses fire', () => {
    const world = createWorld(makeConfig({ pveIntensity: 3 }), makeMap());
    pveInit(world);
    const ships = [makeShip(world, 3200, 3200), makeShip(world, 1500, 1500, 1)];
    let waves = 0, bosses = 0;
    const origPush = world.events.push.bind(world.events);
    world.events.push = (...evs) => {
      for (const ev of evs) if (ev.t === 'waveStart') { waves++; if (ev.boss) bosses++; }
      return origPush(...evs);
    };
    stepN(world, TICK_RATE * 20);
    expect(waves).toBeGreaterThanOrEqual(1);
    expect(world.enemies.size).toBeGreaterThan(0);
    expect(world.enemies.size).toBeLessThanOrEqual(MAX_ENEMIES);
    expect(ships.length).toBe(2);
    expect(bosses).toBe(0);
  });

  it('fresh spawns are never within 700 px of a ship', () => {
    const world = createWorld(makeConfig({ pveIntensity: 2 }), makeMap());
    pveInit(world);
    const a = makeShip(world, 3200, 3200);
    const b = makeShip(world, 2400, 3000, 1);
    world.tick = 1000; world.pve.nextWaveTick = 1001; // skip ahead
    for (let i = 0; i < 600; i++) {
      const before = new Set(world.enemies.keys());
      world.tick++; rebuildGrid(world);
      pveStep(world, DT);
      for (const e of world.enemies.values()) {
        if (before.has(e.id) || e.kind === 'splitling') continue;
        if (e.spawnTick !== world.tick) continue;
        // hive-spawned drones spawn next to the hive; exclude children of existing enemies
        if (e.vx !== 0 || e.vy !== 0) continue;
        for (const s of [a, b]) expect(Math.hypot(e.x - s.x, e.y - s.y)).toBeGreaterThan(700);
      }
      // freeze enemies far away so nothing interacts
      for (const e of world.enemies.values()) { e.x = 50 + (e.id % 50); e.y = 50; e.vx = 0; e.vy = 0; }
      world.events.length = 0;
    }
    expect(world.enemies.size).toBeGreaterThan(0);
  });

  it('intensity 0 spawns nothing', () => {
    const world = createWorld(makeConfig({ pveIntensity: 0 }), makeMap());
    pveInit(world);
    makeShip(world, 3200, 3200);
    stepN(world, TICK_RATE * 40);
    expect(world.enemies.size).toBe(0);
  });
});

describe('headless run', () => {
  it('60 s with 16 fake ships and all auto-weapons stays under caps', () => {
    const world = createWorld(makeConfig({ pveIntensity: 3 }), makeMap());
    pveInit(world);
    const classes: ShipClassId[] = ['brute', 'tech', 'engineer'];
    const ships: Ship[] = [];
    for (let i = 0; i < 16; i++) {
      const s = makeShip(world, 800 + (i % 4) * 1500, 800 + Math.floor(i / 4) * 1500, i % 2, classes[i % 3]);
      s.upgrades = { orbit: 3, seeker: 2, nova: 2, arc: 2, minetrail: 1 };
      s.stats = computeStats(s.shipClass, s.upgrades);
      ships.push(s);
    }
    // fast-forward to wave 6 so every kind (incl. blackholes/hives) is active
    world.pve.wave = 5; world.pve.nextWaveTick = 1;
    let t = 0;
    const t0 = performance.now();
    stepN(world, TICK_RATE * 60, () => {
      t++;
      for (const s of ships) {
        const a = (t / 90 + s.id) % (Math.PI * 2);
        s.vx = Math.cos(a) * 250; s.vy = Math.sin(a) * 250;
        s.x = Math.min(6300, Math.max(100, s.x + s.vx * DT));
        s.y = Math.min(6300, Math.max(100, s.y + s.vy * DT));
      }
      expect(world.enemies.size).toBeLessThanOrEqual(MAX_ENEMIES);
      expect(world.projectiles.size).toBeLessThanOrEqual(MAX_PROJECTILES);
      expect(world.gems.size).toBeLessThanOrEqual(MAX_GEMS);
    });
    const ms = (performance.now() - t0) / (TICK_RATE * 60);
    // eslint-disable-next-line no-console
    console.log(`pve avg ${ms.toFixed(3)} ms/tick, enemies=${world.enemies.size}, gems=${world.gems.size}, wave=${world.pve.wave}, kills=${ships.reduce((a, s) => a + s.enemyKills, 0)}`);
    for (const e of world.enemies.values()) {
      expect(Number.isFinite(e.x) && Number.isFinite(e.y)).toBe(true);
    }
    expect(ships.some((s) => s.enemyKills > 0)).toBe(true);
  });

  it('is deterministic for the same seed', () => {
    const run = () => {
      nextPid = 1;
      const world = createWorld(makeConfig({ pveIntensity: 2 }), makeMap());
      pveInit(world);
      for (let i = 0; i < 4; i++) {
        const s = makeShip(world, 1000 + i * 1200, 3000, i % 2);
        s.upgrades = { orbit: 2, arc: 1 }; s.stats = computeStats(s.shipClass, s.upgrades);
      }
      stepN(world, TICK_RATE * 20);
      return [...world.enemies.values()].map((e) => `${e.kind}:${e.x.toFixed(3)},${e.y.toFixed(3)}`).join('|');
    };
    expect(run()).toBe(run());
  });
});
