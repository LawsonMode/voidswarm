// OWNER: PVE agent. v0.3 M3 swarm pressure (docs/v0.3-proposal.md §5.6, §9 PVE acceptance):
// findSpawnCenter anchors on objectiveAnchors (active Control Zones, weight 2) only when pveIntensity > 0.
// sim/objectives is the real module with objectiveAnchors wrapped in a spy, so the director's side of the
// contract is checked independently of how OBJECTIVES tracks zones. Real map / world. The last block runs
// the real Control Zones implementation end to end through Sim (the spy passes through by default).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../objectives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../objectives')>();
  return { ...actual, objectiveAnchors: vi.fn(actual.objectiveAnchors) };
});

import type { GameMap, Ship, SimConfig, World } from '../../types';
import { emptyInput } from '../../types';
import { objectiveAnchors } from '../objectives';
import { Sim } from '../Sim';
import { createWorld, rebuildGrid } from '../world';
import { pveInit } from './index';
import { computeStats } from './upgrades';
import { findSpawnCenter, SPAWN_MAX_DIST, SPAWN_MIN_DIST, SPAWN_SAFE_DIST, stepDirector } from './waves';
import { xpToNextFor } from './xp';

const anchorsSpy = vi.mocked(objectiveAnchors);
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../objectives')>('../objectives');
  anchorsSpy.mockReset();
  anchorsSpy.mockImplementation(actual.objectiveAnchors);
});

type Anchor = { x: number; y: number; weight: number };
const FORMATION_EXTENT = 160; // waves.ts default margin; formation members sit ≤ 160 px from their center
const MAP_SIZE_PX = 8000;
// Ship and zone 4000 px apart and ≥ 2000 px from every edge: the two 1000–1500 px rings never overlap and
// never leave the map, so the anchor share is exactly the weighted pick (no bounds/safe-distance rejections).
const SHIP_AT = { x: 2000, y: 4000 };
const ZONE = { x: 6000, y: 4000 };
const ZONE_ANCHOR: Anchor = { x: ZONE.x, y: ZONE.y, weight: 2 };

function makeMap(size = MAP_SIZE_PX): GameMap {
  const tileSize = 32, cols = size / tileSize, rows = size / tileSize;
  return { seed: 1, teamCount: 2, width: size, height: size, tileSize, cols, rows, tiles: new Uint8Array(cols * rows), spawns: [] };
}

/** Warzone Control Zones as the Room configures it (objectivesInit is not run: the anchors are spied). */
function makeConfig(o: Partial<SimConfig> = {}): SimConfig {
  return {
    mapSeed: 42, mode: 'teams', teamCount: 2, pveIntensity: 2, matchSeconds: 600, scoreLimit: 0, friendlyFire: false,
    gameType: 'warzone', subMode: 'zones', lootMult: 0, ...o,
  };
}

function makeWorld(o: Partial<SimConfig> = {}): World {
  const world = createWorld(makeConfig(o), makeMap());
  pveInit(world);
  world.tick = 100;
  return world;
}

let nextPid = 1;
function makeShip(world: World, x: number, y: number, team = 0): Ship {
  const id = world.nextId++;
  const stats = computeStats('brute', {});
  const s: Ship = {
    id, playerId: nextPid++, name: 'p' + id, team, shipClass: 'brute', isBot: true,
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

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const onRing = (c: { x: number; y: number }, o: { x: number; y: number }, pad = 0): boolean => {
  const d = dist(c, o);
  return d >= SPAWN_MIN_DIST - pad - 1e-6 && d <= SPAWN_MAX_DIST + pad + 1e-6;
};

function shipAndZoneWorld(o: Partial<SimConfig> = {}): { world: World; ship: Ship } {
  const world = makeWorld(o);
  const ship = makeShip(world, SHIP_AT.x, SHIP_AT.y);
  rebuildGrid(world);
  return { world, ship };
}

/** n findSpawnCenter calls → how many landed on the zone ring vs the ship ring (every hit is on exactly one). */
function classify(world: World, ship: Ship, n: number): { zone: number; ship: number; none: number } {
  const out = { zone: 0, ship: 0, none: 0 };
  for (let i = 0; i < n; i++) {
    const c = findSpawnCenter(world);
    if (!c) { out.none++; continue; }
    const z = onRing(c, ZONE), s = onRing(c, ship);
    expect(z !== s).toBe(true);
    if (z) out.zone++; else out.ship++;
  }
  return out;
}

function centerTrace(world: World, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = findSpawnCenter(world);
    out.push(c ? `${c.x.toFixed(4)},${c.y.toFixed(4)}` : 'null');
  }
  out.push(world.rng.next().toFixed(12)); // the stream position after the calls
  return out.join('|');
}

describe('PVE swarm anchors: findSpawnCenter (§5.6)', () => {
  it('the real objectiveAnchors is [] without objective state, so centers stay on the ship ring', () => {
    const { world, ship } = shipAndZoneWorld({ subMode: 'deathmatch' });
    const r = classify(world, ship, 60);
    expect(r.zone).toBe(0);
    expect(r.ship).toBe(60);
  });

  it('one active zone (weight 2) and 1 ship: ≈ 2/3 of centers anchor on the zone ring', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const { world, ship } = shipAndZoneWorld();
    const r = classify(world, ship, 600);
    expect(r.none).toBe(0);
    const frac = r.zone / 600;
    expect(frac).toBeGreaterThan(0.58);
    expect(frac).toBeLessThan(0.75);
  });

  it('the share follows anchorWeight / (ships + anchorWeight): 6 ships, one zone → ≈ 1/4', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const world = makeWorld();
    const ships = [0, 1, 2, 3, 4, 5].map((i) => makeShip(world, SHIP_AT.x + i * 4, SHIP_AT.y, i % 2));
    rebuildGrid(world);
    let zone = 0;
    for (let i = 0; i < 800; i++) {
      const c = findSpawnCenter(world)!;
      expect(c).not.toBeNull();
      if (onRing(c, ZONE)) zone++;
      else expect(ships.some((s) => onRing(c, s))).toBe(true);
    }
    const frac = zone / 800;
    expect(frac).toBeGreaterThan(0.17);
    expect(frac).toBeLessThan(0.33);
  });

  it('two zones split the anchored share by weight', () => {
    const zoneB = { x: 4000, y: 6500 }; // 3200 px from the ship and zone A: no ring overlaps
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR, { ...zoneB, weight: 6 }]);
    const { world, ship } = shipAndZoneWorld();
    let a = 0, b = 0, s = 0;
    for (let i = 0; i < 900; i++) {
      const c = findSpawnCenter(world);
      if (!c) continue;
      if (onRing(c, ship)) s++;
      else if (onRing(c, ZONE)) a++;
      else if (onRing(c, zoneB)) b++;
    }
    // weights ship 1 : A 2 : B 6 (zone B's ring barely clips the bottom edge)
    expect(s).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(s);
    expect(b).toBeGreaterThan(a * 1.8);
  });

  it('no anchoring when pveIntensity is 0: objectiveAnchors is never consulted', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const { world, ship } = shipAndZoneWorld({ pveIntensity: 0 });
    const r = classify(world, ship, 200);
    expect(r.zone).toBe(0);
    expect(r.ship).toBe(200);
    expect(anchorsSpy).not.toHaveBeenCalled();
  });

  it('no anchors (deathmatch / CTF) leaves the world.rng stream identical to the pve-0 path', () => {
    anchorsSpy.mockImplementation(() => []);
    const trace = (pve: 0 | 2): string => {
      const { world } = shipAndZoneWorld({ pveIntensity: pve });
      makeShip(world, 3000, 5000, 1);
      rebuildGrid(world);
      return centerTrace(world, 50);
    };
    expect(trace(2)).toBe(trace(0));
    expect(anchorsSpy).toHaveBeenCalled();
  });

  it('non-positive / non-finite anchor weights are ignored (same stream as no anchors)', () => {
    const run = (anchors: Anchor[]): string => {
      anchorsSpy.mockImplementation(() => anchors);
      return centerTrace(shipAndZoneWorld().world, 30);
    };
    const junk: Anchor[] = [{ ...ZONE_ANCHOR, weight: 0 }, { ...ZONE_ANCHOR, weight: -2 }, { ...ZONE_ANCHOR, weight: NaN }];
    expect(run(junk)).toBe(run([]));
  });

  it('anchored centers keep spawnPointOk: never within the safe distance of a ship camped near the zone', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const world = makeWorld();
    // 1200 px from the zone: part of the zone's 1000–1500 ring falls inside this ship's safe radius
    const camper = makeShip(world, ZONE.x - 1200, ZONE.y);
    rebuildGrid(world);
    let anchored = 0;
    for (let i = 0; i < 400; i++) {
      const c = findSpawnCenter(world);
      if (!c) continue;
      expect(dist(c, camper)).toBeGreaterThan(SPAWN_SAFE_DIST + FORMATION_EXTENT);
      if (onRing(c, ZONE) && !onRing(c, camper)) anchored++;
    }
    expect(anchored).toBeGreaterThan(0);
  });

  it('with no alive ships there is no center even with anchors', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const world = makeWorld();
    makeShip(world, SHIP_AT.x, SHIP_AT.y).alive = false;
    rebuildGrid(world);
    expect(findSpawnCenter(world)).toBeNull();
  });
});

describe('PVE acceptance (§9 M3): the director anchors on zones only when pve > 0', () => {
  /**
   * Run the real wave director (wave-opening + trickle formations) for 10 s with one ship; classify each fresh
   * enemy at its spawn position, then clear the field so the trickle keeps spawning.
   */
  const runDirector = (pve: 0 | 2): { nearZone: number; nearShip: number; total: number } => {
    const { world, ship } = shipAndZoneWorld({ pveIntensity: pve });
    world.pve.nextWaveTick = world.tick + 1;
    world.pve.mem.nextTrickle = world.tick + 1;
    let nearZone = 0, nearShip = 0, total = 0;
    for (let i = 0; i < 600; i++) {
      world.tick++; rebuildGrid(world);
      stepDirector(world);
      for (const e of world.enemies.values()) {
        total++;
        const z = onRing(e, ZONE, FORMATION_EXTENT), s = onRing(e, ship, FORMATION_EXTENT);
        expect(z !== s).toBe(true);
        if (z) nearZone++; else nearShip++;
        expect(dist(e, ship)).toBeGreaterThan(SPAWN_SAFE_DIST);
      }
      world.enemies.clear();
      world.events.length = 0;
    }
    return { nearZone, nearShip, total };
  };

  it('pve 2 + an active zone: wave and trickle formations spawn around the zone as well as the ship', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const r = runDirector(2);
    expect(r.total).toBeGreaterThan(50);
    // weight 2 vs 1 ship over ~25 formations (seed 42: 108 zone / 71 ship enemies); both rings must see spawns
    expect(r.nearZone).toBeGreaterThan(0);
    expect(r.nearShip).toBeGreaterThan(0);
    expect(anchorsSpy).toHaveBeenCalled();
  });

  it('pve 0 + an active zone: the director spawns nothing and never asks for anchors', () => {
    anchorsSpy.mockImplementation(() => [ZONE_ANCHOR]);
    const r = runDirector(0);
    expect(r.total).toBe(0);
    expect(anchorsSpy).not.toHaveBeenCalled();
  });

  it('pve 2 without anchors: every formation stays on the ship ring', () => {
    anchorsSpy.mockImplementation(() => []);
    const r = runDirector(2);
    expect(r.total).toBeGreaterThan(50);
    expect(r.nearZone).toBe(0);
    expect(r.nearShip).toBe(r.total);
  });
});

describe('PVE × the real Control Zones (Warzone zones through Sim, §5.2 order, §5.6)', () => {
  // Seed 1234, 2 teams: a 6400 px map, 3 zones (the centre pad + 2 flank pads), every zone ≥ 2240 px from the
  // base spawns, so a center > SPAWN_MAX_DIST from every ship can only have been drawn on a zone ring.
  const wzConfig = (pve: 0 | 2): SimConfig => ({
    mapSeed: 1234, mode: 'teams', teamCount: 2, pveIntensity: pve, matchSeconds: 600, scoreLimit: 0,
    friendlyFire: false, gameType: 'warzone', subMode: 'zones', lootMult: 0,
  });
  /** 4 ships parked on their team bases (bots with no AI: empty input, so they stay put). */
  function wzSim(pve: 0 | 2): Sim {
    const sim = new Sim(wzConfig(pve));
    for (const pid of [1, 2, 3, 4]) sim.addPlayer({ playerId: pid, name: 'p' + pid, team: pid % 2, shipClass: 'brute', isBot: true });
    rebuildGrid(sim.world); // Sim.step does this first; direct findSpawnCenter calls need it too (spawnPointOk)
    return sim;
  }
  const poolShips = (w: World): Ship[] => [...w.ships.values()].filter((s) => s.alive && !s.attachedTo);

  it('objectivesInit hands the director every active zone at weight 2, and ≈ half the centers anchor on one', () => {
    const w = wzSim(2).world;
    const zones = w.objective!.zones;
    expect(w.objective!.mode).toBe('zones');
    expect(zones.length).toBe(3);
    expect(objectiveAnchors(w)).toEqual(zones.map((z) => ({ x: z.x, y: z.y, weight: 2 })));
    const ships = poolShips(w);
    expect(ships.length).toBe(4);
    for (const z of zones) for (const s of ships) expect(dist(z, s)).toBeGreaterThan(SPAWN_MAX_DIST + 500); // measured ≥ 2240
    anchorsSpy.mockClear();
    let zoneOnly = 0, found = 0;
    for (let i = 0; i < 600; i++) {
      const c = findSpawnCenter(w);
      if (!c) continue;
      found++;
      for (const s of ships) expect(dist(c, s)).toBeGreaterThan(SPAWN_SAFE_DIST + FORMATION_EXTENT); // spawnPointOk
      const nearShip = ships.some((s) => onRing(c, s)), nearZone = zones.some((z) => onRing(c, z));
      expect(nearShip || nearZone).toBe(true);
      if (nearZone && !nearShip) zoneOnly++;
    }
    expect(anchorsSpy).toHaveBeenCalledTimes(600);
    // weights: 4 ships × 1 vs 3 zones × 2 → 6/10 of the picks are a zone, minus ring rejections (measured 318/600)
    expect(found).toBeGreaterThan(560);
    expect(zoneOnly / found).toBeGreaterThan(0.4);
    expect(zoneOnly / found).toBeLessThan(0.7);
  });

  /** 20 s of the real Sim; each new enemy classified against the pool ships alive at that tick. */
  function runSim(pve: 0 | 2): { total: number; farFromShips: number; trace: string } {
    const sim = wzSim(pve), w = sim.world;
    const seen = new Set<number>();
    const out: string[] = [];
    let total = 0, farFromShips = 0;
    for (let i = 0; i < 20 * 60; i++) {
      sim.step();
      const ships = poolShips(w);
      for (const e of w.enemies.values()) {
        if (seen.has(e.id)) continue;
        seen.add(e.id); total++;
        out.push(`${w.tick}:${e.kind}:${e.x.toFixed(3)},${e.y.toFixed(3)}`);
        // 60 px slack: the enemy may already have moved a tick
        if (ships.every((s) => dist(e, s) > SPAWN_MAX_DIST + FORMATION_EXTENT + 60)) {
          farFromShips++;
          expect(w.objective!.zones.some((z) => onRing(e, z, FORMATION_EXTENT + 60))).toBe(true);
        }
      }
    }
    expect(w.match.phase).toBe('playing');
    out.push(w.rng.next().toFixed(12));
    return { total, farFromShips, trace: out.join('|') };
  }

  it('pve 2: the real director puts formations around the zones, away from every ship — deterministically', () => {
    const r = runSim(2);
    expect(anchorsSpy).toHaveBeenCalled();
    expect(r.total).toBeGreaterThan(40); // measured 67
    expect(r.farFromShips).toBeGreaterThan(5); // measured 28
    expect(r.farFromShips).toBeLessThan(r.total);
    expect(runSim(2).trace).toBe(r.trace); // same seed → same spawns and the same world.rng position
  });

  it('pve 0: zones still run, but the director spawns nothing and never asks for anchors', () => {
    const r = runSim(0);
    expect(r.total).toBe(0);
    expect(anchorsSpy).not.toHaveBeenCalled();
  });

  it('deactivated zones are no anchors: the world.rng stream is the no-anchor (v0.2) path', () => {
    const trace = (deactivate: boolean): string => {
      const w = wzSim(2).world;
      if (deactivate) for (const z of w.objective!.zones) z.active = false;
      else anchorsSpy.mockImplementation(() => []);
      const ships = poolShips(w);
      for (let i = 0; i < 40; i++) {
        const c = findSpawnCenter(w);
        if (c) expect(ships.some((s) => onRing(c, s))).toBe(true);
      }
      return centerTrace(w, 20);
    };
    expect(trace(true)).toBe(trace(false));
  });
});
