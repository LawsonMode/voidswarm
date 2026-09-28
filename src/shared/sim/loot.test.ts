// SIM v0.3 M2 acceptance (docs/v0.3-proposal.md §9 SIM loot.test, §6.3–6.5): rolls (chance × lootMult,
// rarity floors, dungeon boost, set share), caps and world-cap eviction, pickup (radius, humans only, not
// turrets, carry cap, reservation, nearest), physics + expiry, spill on death / leave / team change with
// non-ally killer priority, the killShip shutdown roll, personal reservations and extraction securing.
// Real Sim, real PVE, no mocks; loot randomness only ever comes from side(world).lootRng.
import { describe, expect, it } from 'vitest';
import {
  DT, LOOT_LIFE_SEC, LOOT_PICKUP_PAD, LOOT_SPILL_LIFE_SEC, LOOT_SPILL_RESERVE_SEC, MAX_CARRIED, MAX_CARRIED_DUNGEON,
  MAX_LOOT, SPAWN_INVULN_SEC, TICK_RATE,
} from '../constants';
import { CACHE_RARITY_W, DROP_RULES, MODE_SET_SHARE, riftRarityBoost } from '../data/loot';
import type { CacheToken, GameEvent, InputState, LootDrop, Rarity, RiftState, Ship, ShipClassId, SimConfig, World } from '../types';
import { emptyInput } from '../types';
import { Rng } from '../util/rng';
import { damageShip } from './combat';
import {
  carryCap, LOOT_NO_EXPIRY, LOOT_RADIUS, LOOT_SPILL_SPEED_MAX, LOOT_SPILL_SPEED_MIN, lootCap, lootCapUsed, rollLoot,
  rollRarity, rollSet, secureCarried, spillCarried, stepLoot,
} from './loot';
import { isSolidAt } from './map';
import { Sim } from './Sim';
import { side } from './state';
import { rebuildGrid } from './world';

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 1234, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0,
  friendlyFire: false, gameType: 'arena', subMode: 'deathmatch', lootMult: 1, lootSeed: 0x51ab, ...o,
});
function add(sim: Sim, pid: number, cls: ShipClassId = 'brute', team = 0, isBot = false): Ship {
  return sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot }))!;
}
const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), ...o });
function steps(sim: Sim, n: number): void { for (let i = 0; i < n; i++) sim.step(); }
function settle(sim: Sim): void { steps(sim, SPAWN_INVULN_SEC * TICK_RATE + 5); }
/** An open area: a 480×320 px box around (x, y) with no solid tiles. */
function openArea(w: World): { x: number; y: number } {
  const m = w.map;
  for (let y = 600; y < m.height - 600; y += 32) {
    for (let x = 600; x < m.width - 600; x += 32) {
      let ok = true;
      for (let dy = -160; dy <= 160 && ok; dy += 16) for (let dx = -240; dx <= 240 && ok; dx += 16) if (isSolidAt(m, x + dx, y + dy)) ok = false;
      if (ok) return { x, y };
    }
  }
  throw new Error('no open area');
}
function place(s: Ship, x: number, y: number): void { s.x = x; s.y = y; s.vx = 0; s.vy = 0; }
const tok = (rarity: Rarity, set: CacheToken['set'] = 'common', source: CacheToken['source'] = 'elite'): CacheToken => ({ rarity, set, source });
/** A resting cache inserted directly (ids from the world's id space, like the real ones). */
function putDrop(w: World, x: number, y: number, o: Partial<LootDrop> = {}): LootDrop {
  const d: LootDrop = {
    id: w.nextId++, x, y, vx: 0, vy: 0, token: tok(0), spawnTick: w.tick, expireTick: w.tick + LOOT_LIFE_SEC * TICK_RATE,
    reservedFor: 0, reservedUntilTick: 0, droppedBy: 0, ...o,
  };
  w.loot!.set(d.id, d);
  return d;
}
const drops = (w: World): LootDrop[] => [...w.loot!.values()];
const ofType = <T extends GameEvent['t']>(ev: GameEvent[], t: T) => ev.filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);
/** A settled arena match: humans 1 (team 0) and 2 (team 1) parked in an open area, 200 px apart. */
function arena(o: Partial<SimConfig> = {}) {
  const sim = new Sim(cfg(o));
  const a = add(sim, 1, 'brute', 0), b = add(sim, 2, 'tech', 1);
  settle(sim);
  const c = openArea(sim.world);
  place(a, c.x - 100, c.y); place(b, c.x + 100, c.y);
  sim.drainEvents();
  return { sim, w: sim.world, a, b, c };
}
/** Put a dead ship back in play at once (repeat-kill tests), without a spawn (no world.rng draw). */
function revive(s: Ship): void { s.alive = true; s.energy = s.stats.maxEnergy; s.invulnUntilTick = 0; }

// ---------------------------------------------------------------------------------------------
describe('rollLoot: chance, gates and the rolled cache', () => {
  it('a rolled cache: rarity floor, mode set or Salvage, killer priority for reserveSec, 90 s life, lootDrop event', () => {
    const { w, c } = arena();
    const t0 = w.tick;
    expect(rollLoot(w, 'flagCapture', c.x, c.y, { priorityPid: 2 })).toBe(1); // arena 100%, floor [U]
    const [d] = drops(w);
    expect(d.token.source).toBe('flagCapture');
    expect(d.token.rarity).toBeGreaterThanOrEqual(1);
    expect(['gladiator', 'common']).toContain(d.token.set);
    expect([d.x, d.y]).toEqual([c.x, c.y]);
    expect(d.reservedFor).toBe(2);
    expect(d.reservedUntilTick).toBe(t0 + DROP_RULES.flagCapture.reserveSec * TICK_RATE);
    expect(d.expireTick).toBe(t0 + LOOT_LIFE_SEC * TICK_RATE);
    expect([d.spawnTick, d.droppedBy]).toEqual([t0, 0]);
    expect(ofType(w.events, 'lootDrop')).toEqual([
      { t: 'lootDrop', id: d.id, x: c.x, y: c.y, rarity: d.token.rarity, set: d.token.set, source: 'flagCapture' },
    ]);
  });

  it('no-op with lootMult 0 / absent, outside the rule\'s game types, after the match, or at a bad position', () => {
    for (const lootMult of [0, undefined]) {
      const sim = new Sim(cfg({ lootMult }));
      const w = sim.world, id0 = w.nextId;
      expect(rollLoot(w, 'flagCapture', 500, 500, { priorityPid: 1 })).toBe(0);
      expect([w.loot!.size, w.events.length, w.nextId]).toEqual([0, 0, id0]);
    }
    const { w, c } = arena();
    expect(rollLoot(w, 'boss', c.x, c.y, { priorityPid: 1 })).toBe(0); // warzone only
    expect(rollLoot(w, 'keyChest', c.x, c.y, { priorityPid: 1 })).toBe(0); // dungeon only
    expect(rollLoot(w, 'flagCapture', NaN, c.y, { priorityPid: 1 })).toBe(0);
    w.match.phase = 'ended';
    expect(rollLoot(w, 'flagCapture', c.x, c.y, { priorityPid: 1 })).toBe(0);
    expect(w.loot!.size).toBe(0);
  });

  it('p = min(1, chance × lootMult): one draw per trigger', () => {
    const rate = (gameType: SimConfig['gameType'], source: CacheToken['source'], lootMult: number, n = 4000): number => {
      const sim = new Sim(cfg({ gameType, lootMult, pveIntensity: 1 }));
      add(sim, 1);
      let hits = 0;
      for (let i = 0; i < n; i++) {
        hits += rollLoot(sim.world, source, 500, 500, { priorityPid: 1 }) > 0 ? 1 : 0;
        sim.world.loot!.clear(); // personal rules: no cap; keep the world cap out of it
      }
      return hits / n;
    };
    expect(rate('dungeon', 'keyChest', 0.5)).toBeCloseTo(0.5, 1); // 100% × 0.5
    expect(Math.abs(rate('dungeon', 'roomChest', 1) - 0.25)).toBeLessThan(0.03);
    expect(Math.abs(rate('dungeon', 'roomChest', 3) - 0.75)).toBeLessThan(0.03);
    expect(rate('dungeon', 'roomChest', 10, 500)).toBe(1); // clamped at 1
  });

  it('rarity weights (100k rolls within ±1%), floors honoured, dungeon boost on rare+', () => {
    const N = 100_000, sum = CACHE_RARITY_W.reduce((a, b) => a + b, 0);
    const hist = (floorR: Rarity, boost = 1): number[] => {
      const rng = new Rng(99), h = [0, 0, 0, 0, 0];
      for (let i = 0; i < N; i++) h[rollRarity(rng, floorR, boost)]++;
      return h.map((v) => v / N);
    };
    const h0 = hist(0);
    CACHE_RARITY_W.forEach((wt, r) => expect(Math.abs(h0[r] - wt / sum)).toBeLessThan(0.01));
    const h1 = hist(1), s1 = sum - CACHE_RARITY_W[0];
    expect(h1[0]).toBe(0);
    for (let r = 1; r < 5; r++) expect(Math.abs(h1[r] - CACHE_RARITY_W[r] / s1)).toBeLessThan(0.01);
    const h2 = hist(2);
    expect(h2[0] + h2[1]).toBe(0);
    expect(hist(4)[4]).toBe(1);
    // Nightmare floor 6: rare+ × (1 + 0.75) × 1.5
    const boost = riftRarityBoost(6, 3);
    expect(boost).toBeCloseTo(2.625, 10);
    const hb = hist(0, boost);
    const wb = CACHE_RARITY_W.map((wt, r) => wt * (r >= 2 ? boost : 1)), sb = wb.reduce((a, b) => a + b, 0);
    wb.forEach((wt, r) => expect(Math.abs(hb[r] - wt / sb)).toBeLessThan(0.01));
  });

  it('set: the game type\'s exclusive set MODE_SET_SHARE of the time, else Salvage Line', () => {
    const rng = new Rng(5);
    for (const [gt, set] of [['arena', 'gladiator'], ['warzone', 'swarm'], ['dungeon', 'rift']] as const) {
      let mode = 0;
      for (let i = 0; i < 100_000; i++) {
        const s = rollSet(rng, gt);
        expect(s === set || s === 'common').toBe(true);
        if (s === set) mode++;
      }
      expect(Math.abs(mode / 100_000 - MODE_SET_SHARE)).toBeLessThan(0.01);
    }
  });

  it('rollLoot applies the rift boost by floor and difficulty', () => {
    const rarePlus = (floor: number, pveIntensity: 1 | 2 | 3): number => {
      const sim = new Sim(cfg({ gameType: 'dungeon', subMode: 'coop', pveIntensity }));
      add(sim, 1);
      sim.world.dungeon = { floor } as RiftState;
      let n = 0, hi = 0;
      for (let i = 0; i < 3000; i++) {
        rollLoot(sim.world, 'keyChest', 500, 500, { priorityPid: 1 }); // 100%, floor [U], personal
        for (const d of sim.world.loot!.values()) { n++; if (d.token.rarity >= 2) hi++; expect(d.token.set === 'rift' || d.token.set === 'common').toBe(true); }
        sim.world.loot!.clear();
      }
      return hi / n;
    };
    expect(Math.abs(rarePlus(1, 1) - 15 / 40)).toBeLessThan(0.03);
    expect(Math.abs(rarePlus(6, 3) - (15 * 2.625) / (25 + 15 * 2.625))).toBeLessThan(0.03);
  });

  it('is deterministic per lootSeed and never draws from world.rng', () => {
    const run = (lootSeed: number, lootMult: number) => {
      const sim = new Sim(cfg({ lootSeed, lootMult }));
      add(sim, 1); add(sim, 2, 'tech', 1);
      for (let i = 0; i < 12; i++) rollLoot(sim.world, 'flagCapture', 800 + i, 900, { priorityPid: 1 });
      return { sim, loot: JSON.stringify(drops(sim.world).map((d) => [d.token, d.vx, d.vy])) };
    };
    const a = run(77, 1), b = run(77, 1), c = run(78, 1), off = run(77, 0);
    expect(a.loot).toBe(b.loot);
    expect(c.loot).not.toBe(a.loot);
    expect(off.sim.world.loot!.size).toBe(0);
    const draws = (s: Sim) => Array.from({ length: 8 }, () => s.world.rng.next());
    expect(draws(a.sim)).toEqual(draws(off.sim));
  });
});

// ---------------------------------------------------------------------------------------------
describe('caps and world-cap eviction', () => {
  it('arena / warzone: min(72, 8 + 4·humans) non-personal caches per match (bots never count)', () => {
    const sim = new Sim(cfg());
    add(sim, 1); add(sim, 2, 'tech', 1); add(sim, 3, 'brute', 0, true); add(sim, 4, 'tech', 1, true);
    const w = sim.world;
    expect(lootCap(w)).toBe(16);
    let got = 0;
    for (let i = 0; i < 40; i++) { got += rollLoot(w, 'flagCapture', 700, 700, { priorityPid: 1 }); w.loot!.clear(); }
    expect(got).toBe(16);
    expect(lootCapUsed(w)).toBe(16);
    expect(rollLoot(w, 'flagCapture', 700, 700, { priorityPid: 1 })).toBe(0);
    add(sim, 5, 'engineer', 0); // a human joins: the cap rises with them
    expect(lootCap(w)).toBe(20);
    for (let i = 0; i < 10; i++) got += rollLoot(w, 'flagCapture', 700, 700, { priorityPid: 1 });
    expect(got).toBe(20);
    for (let p = 6; p <= 25; p++) add(sim, p, 'brute', p % 2);
    expect(lootCap(w)).toBe(72); // 8 + 4·22 = 96 → 72
    const wz = new Sim(cfg({ gameType: 'warzone', pveIntensity: 1 })).world;
    expect(lootCap(wz)).toBe(8);
  });

  it('dungeon: 4 + 2·humans per floor (resets on a new floor); personal drops are exempt', () => {
    const sim = new Sim(cfg({ gameType: 'dungeon', subMode: 'coop', pveIntensity: 1, lootMult: 100 })); // elite 6% × 100 → 100%
    add(sim, 1); add(sim, 2, 'brute', 0, true);
    const w = sim.world;
    expect(lootCap(w)).toBe(6);
    let got = 0;
    for (let i = 0; i < 20; i++) got += rollLoot(w, 'elite', 700, 700, { priorityPid: 1 });
    expect(got).toBe(6);
    expect(rollLoot(w, 'keyChest', 700, 700, { priorityPid: 1 })).toBe(1); // personal: exempt
    expect(lootCapUsed(w)).toBe(6);
    w.dungeon = { floor: 2 } as RiftState;
    expect(lootCapUsed(w)).toBe(0);
    for (let i = 0; i < 20; i++) got += rollLoot(w, 'elite', 700, 700, { priorityPid: 1 });
    expect(got).toBe(12);
  });

  it(`at MAX_LOOT (${MAX_LOOT}) the oldest lowest-rarity cache below epic is evicted; epic+ never`, () => {
    const { w, c } = arena();
    const rar: Rarity[] = [3, 1, 0, 2, 0, 4];
    const first = rar.map((r) => putDrop(w, c.x, c.y + 200, { token: tok(r) }));
    while (w.loot!.size < MAX_LOOT) putDrop(w, c.x, c.y + 200, { token: tok(2) });
    const has = (d: LootDrop) => w.loot!.has(d.id);
    expect(rollLoot(w, 'flagCapture', c.x, c.y, { priorityPid: 1 })).toBe(1); // rarity ≥ 1
    expect(w.loot!.size).toBe(MAX_LOOT);
    expect(has(first[2])).toBe(false); // oldest common
    expect(has(first[4])).toBe(true);
    rollLoot(w, 'flagCapture', c.x, c.y, { priorityPid: 1 });
    expect(has(first[4])).toBe(false); // next common
    rollLoot(w, 'flagCapture', c.x, c.y, { priorityPid: 1 });
    expect(has(first[1])).toBe(false); // then the uncommon
    expect(has(first[0]) && has(first[5])).toBe(true); // epic / legendary stay
    // a lower-rarity newcomer never pushes out a better cache: a spilled common is refused against rares
    const s = w.ships.get(w.shipsByPlayer.get(1)!)!;
    const before = drops(w).map((d) => d.id);
    s.carried = [tok(0)];
    spillCarried(w, s, 0);
    expect(drops(w).map((d) => d.id)).toEqual(before);
    expect(ofType(w.events, 'lootSpill').at(-1)).toMatchObject({ count: 1, best: 0 });
  });

  it('a world full of epic+ caches refuses new ones', () => {
    const { w, c } = arena();
    while (w.loot!.size < MAX_LOOT) putDrop(w, c.x, c.y + 200, { token: tok(3) });
    const ids = drops(w).map((d) => d.id);
    w.events.length = 0;
    expect(rollLoot(w, 'flagCapture', c.x, c.y, { priorityPid: 1 })).toBe(0);
    expect(drops(w).map((d) => d.id)).toEqual(ids);
    expect(ofType(w.events, 'lootDrop')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('pickup', () => {
  it(`touch distance is ship radius + ${LOOT_PICKUP_PAD} px; emits lootPickup with the carried count`, () => {
    const { sim, w, a } = arena();
    const reach = a.stats.radius + LOOT_PICKUP_PAD;
    const out = putDrop(w, a.x, a.y - reach - 0.5, { token: tok(1, 'gladiator', 'shutdown') });
    const inn = putDrop(w, a.x + reach - 0.5, a.y, { token: tok(2, 'common', 'flagCapture') });
    sim.step();
    expect(w.loot!.has(inn.id)).toBe(false);
    expect(w.loot!.has(out.id)).toBe(true);
    expect(a.carried).toEqual([tok(2, 'common', 'flagCapture')]);
    expect(ofType(sim.drainEvents(), 'lootPickup')).toEqual([
      { t: 'lootPickup', playerId: 1, shipId: a.id, x: inn.x, y: inn.y, rarity: 2, set: 'common', carried: 1 },
    ]);
    place(a, a.x, a.y - 1); // one px closer
    sim.step();
    expect(a.carried!.map((t) => t.rarity)).toEqual([2, 1]); // carried stays rarity-descending
    expect(w.loot!.size).toBe(0);
    expect(sim.takeCarried(1)).toEqual([tok(2, 'common', 'flagCapture'), tok(1, 'gladiator', 'shutdown')]);
  });

  it('bots never pick up; dead ships never pick up', () => {
    const sim = new Sim(cfg());
    const bot = add(sim, 1, 'brute', 0, true), dead = add(sim, 2, 'tech', 1);
    settle(sim);
    const c = openArea(sim.world);
    place(bot, c.x, c.y); place(dead, c.x + 200, c.y);
    dead.alive = false; dead.respawnTick = Number.MAX_SAFE_INTEGER;
    const d1 = putDrop(sim.world, c.x, c.y), d2 = putDrop(sim.world, c.x + 200, c.y);
    steps(sim, 30);
    expect(sim.world.loot!.has(d1.id) && sim.world.loot!.has(d2.id)).toBe(true);
    expect(bot.carried ?? []).toEqual([]);
  });

  it('an attached turret never picks up (its human host does)', () => {
    const sim = new Sim(cfg());
    const host = add(sim, 1, 'brute', 0, true), t = add(sim, 2, 'tech', 0), host2 = add(sim, 3, 'brute', 0);
    settle(sim);
    const c = openArea(sim.world);
    place(host, c.x - 150, c.y); place(t, c.x - 70, c.y); place(host2, c.x + 200, c.y);
    sim.step();
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    sim.setInput(2, inp());
    sim.step();
    expect(t.attachedTo).toBe(host.id);
    const d = putDrop(sim.world, t.x, t.y);
    steps(sim, 10);
    expect(sim.world.loot!.has(d.id)).toBe(true); // bot host + attached human turret: nobody
    expect(t.carried ?? []).toEqual([]);
    const d2 = putDrop(sim.world, host2.x, host2.y);
    sim.step();
    expect(sim.world.loot!.has(d2.id)).toBe(false);
    expect(host2.carried).toHaveLength(1);
  });

  it('the nearest eligible ship wins', () => {
    const { sim, w, a, b } = arena();
    const c = openArea(w);
    place(a, c.x, c.y); place(b, c.x + 30, c.y);
    const d = putDrop(w, c.x + 18, c.y); // 18 px from a, 12 px from b
    sim.step();
    expect(w.loot!.has(d.id)).toBe(false);
    expect(b.carried).toHaveLength(1);
    expect(a.carried ?? []).toEqual([]);
  });

  it('a reservation is respected until it lapses', () => {
    const { sim, w, a, b } = arena();
    const c = openArea(w);
    place(a, c.x, c.y); place(b, c.x + 400, c.y);
    const d = putDrop(w, c.x + 5, c.y, { reservedFor: 2, reservedUntilTick: w.tick + 30 });
    steps(sim, 20);
    expect(w.loot!.has(d.id)).toBe(true); // a sits on it, but it is b's
    place(b, c.x + 30, c.y);
    sim.step();
    expect(w.loot!.has(d.id)).toBe(false); // b (farther) takes it: a is not eligible
    expect(b.carried).toHaveLength(1);
    const e = putDrop(w, c.x - 5, c.y, { reservedFor: 2, reservedUntilTick: w.tick + 30 });
    place(b, c.x + 400, c.y);
    steps(sim, 29);
    expect(w.loot!.has(e.id)).toBe(true);
    expect(e.reservedFor).toBe(2);
    steps(sim, 2);
    expect(w.loot!.has(e.id)).toBe(false); // lapsed → free → a takes it
    expect(a.carried).toHaveLength(1);
  });

  it(`carryCap: ${MAX_CARRIED} in arena / warzone, ${MAX_CARRIED_DUNGEON} in a rift; a full hold skips the cache`, () => {
    expect(carryCap(new Sim(cfg()).world)).toBe(MAX_CARRIED);
    expect(carryCap(new Sim(cfg({ gameType: 'warzone', pveIntensity: 2 })).world)).toBe(MAX_CARRIED);
    expect(carryCap(new Sim(cfg({ gameType: 'dungeon', subMode: 'coop', pveIntensity: 1 })).world)).toBe(MAX_CARRIED_DUNGEON);
    const { sim, w, a, b } = arena();
    const c = openArea(w);
    place(a, c.x, c.y); place(b, c.x + 30, c.y);
    a.carried = Array.from({ length: MAX_CARRIED }, () => tok(0));
    const d = putDrop(w, c.x + 2, c.y);
    sim.step();
    expect(a.carried).toHaveLength(MAX_CARRIED);
    expect(b.carried).toHaveLength(1); // the next eligible ship takes it
    expect(w.loot!.has(d.id)).toBe(false);

    // a rift hold goes to 24 (stepLoot directly: no floor loop needed)
    const ds = new Sim(cfg({ gameType: 'dungeon', subMode: 'coop', pveIntensity: 1 }));
    const p = add(ds, 1); // at its spawn point (no open-area search: rift floors have their own layout)
    p.carried = Array.from({ length: MAX_CARRIED }, () => tok(0));
    rebuildGrid(ds.world);
    putDrop(ds.world, p.x, p.y);
    stepLoot(ds.world, DT);
    expect(p.carried).toHaveLength(MAX_CARRIED + 1);
    p.carried = Array.from({ length: MAX_CARRIED_DUNGEON }, () => tok(0));
    putDrop(ds.world, p.x, p.y);
    stepLoot(ds.world, DT);
    expect(p.carried).toHaveLength(MAX_CARRIED_DUNGEON);
    expect(ds.world.loot!.size).toBe(1);
  });

  it('no pickups once the match is over', () => {
    const { w, a } = arena();
    putDrop(w, a.x, a.y);
    w.match.phase = 'ended';
    rebuildGrid(w);
    stepLoot(w, DT);
    expect(w.loot!.size).toBe(1);
    expect(a.carried ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('physics and expiry', () => {
  it('friction 0.08^dt, and a slow cache comes to rest', () => {
    const { w, c } = arena();
    const d = putDrop(w, c.x, c.y + 120, { vx: 100, vy: 0 });
    const f = Math.pow(0.08, DT);
    stepLoot(w, DT);
    expect(d.vx).toBeCloseTo(100 * f, 9);
    expect(d.x).toBeCloseTo(c.x + 100 * f * DT, 9);
    for (let i = 0; i < 600; i++) stepLoot(w, DT);
    expect([d.vx, d.vy]).toEqual([0, 0]);
    expect(d.x - c.x).toBeLessThan(100 / Math.log(1 / 0.08) + 1); // v / ln(1/0.08) total travel
  });

  it('a cache stops at walls (never inside a solid tile)', () => {
    const { w, c } = arena();
    let wx = c.x;
    while (!isSolidAt(w.map, wx, c.y)) wx += 4;
    const d = putDrop(w, wx - 60, c.y, { vx: 900, vy: 0 });
    for (let i = 0; i < 120; i++) stepLoot(w, DT);
    expect([d.vx, d.vy]).toEqual([0, 0]);
    expect(isSolidAt(w.map, d.x, d.y)).toBe(false);
    expect(d.x).toBeLessThanOrEqual(wx - LOOT_RADIUS + 4.01); // touching, not overlapping
    expect(d.x).toBeGreaterThan(wx - 60);
  });

  it('rolled caches live 90 s, spills 45 s, personal caches never expire', () => {
    const { w, c, a } = arena({ gameType: 'arena' });
    rollLoot(w, 'flagCapture', c.x, c.y + 150, { priorityPid: 0 });
    const [rolled] = drops(w);
    expect(rolled.expireTick - rolled.spawnTick).toBe(LOOT_LIFE_SEC * TICK_RATE);
    a.carried = [tok(1)];
    spillCarried(w, a, 0);
    const spilled = drops(w).find((d) => d !== rolled)!;
    expect(spilled.expireTick - spilled.spawnTick).toBe(LOOT_SPILL_LIFE_SEC * TICK_RATE);
    // walk the clock (stepLoot only; no ship is near either cache after the scatter settles)
    const at = (tick: number) => { w.tick = tick; rebuildGrid(w); for (const s of w.ships.values()) s.alive = false; stepLoot(w, DT); };
    at(spilled.expireTick - 1);
    expect(w.loot!.has(spilled.id)).toBe(true);
    at(spilled.expireTick);
    expect(w.loot!.has(spilled.id)).toBe(false);
    at(rolled.expireTick - 1);
    expect(w.loot!.has(rolled.id)).toBe(true);
    at(rolled.expireTick);
    expect(w.loot!.size).toBe(0);

    const ds = new Sim(cfg({ gameType: 'dungeon', subMode: 'coop', pveIntensity: 1 }));
    add(ds, 1);
    rollLoot(ds.world, 'keyChest', 500, 500, { priorityPid: 1 });
    const [personal] = drops(ds.world);
    expect(personal.expireTick).toBe(LOOT_NO_EXPIRY);
    ds.world.tick = 10_000_000;
    for (const s of ds.world.ships.values()) s.alive = false;
    stepLoot(ds.world, DT);
    expect(ds.world.loot!.has(personal.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('spill: death, leave, team change; killer priority only for non-allies', () => {
  const hold = (): CacheToken[] => [tok(0, 'common', 'elite'), tok(3, 'gladiator', 'shutdown'), tok(1, 'common', 'flagCapture')];

  it('a non-ally kill scatters the hold at the death spot, highest rarity first, 45 s, 2 s killer priority', () => {
    const { w, a, b } = arena();
    a.carried = hold();
    const x = a.x, y = a.y, t0 = w.tick;
    damageShip(w, a, 1e6, b.id, 'player');
    expect(a.alive).toBe(false);
    expect(a.carried).toEqual([]);
    const ds = drops(w);
    expect(ds.map((d) => d.token)).toEqual([tok(3, 'gladiator', 'shutdown'), tok(1, 'common', 'flagCapture'), tok(0, 'common', 'elite')]);
    for (const d of ds) {
      expect([d.x, d.y, d.droppedBy, d.spawnTick]).toEqual([x, y, 1, t0]);
      expect(d.expireTick).toBe(t0 + LOOT_SPILL_LIFE_SEC * TICK_RATE);
      expect([d.reservedFor, d.reservedUntilTick]).toEqual([2, t0 + LOOT_SPILL_RESERVE_SEC * TICK_RATE]);
      const sp = Math.hypot(d.vx, d.vy);
      expect(sp).toBeGreaterThanOrEqual(LOOT_SPILL_SPEED_MIN - 1e-9);
      expect(sp).toBeLessThanOrEqual(LOOT_SPILL_SPEED_MAX + 1e-9);
    }
    const ev = w.events;
    const iDeath = ev.findIndex((e) => e.t === 'shipDeath'), iSpill = ev.findIndex((e) => e.t === 'lootSpill');
    expect(iDeath).toBeGreaterThanOrEqual(0);
    expect(iSpill).toBeGreaterThan(iDeath);
    expect(ev[iSpill]).toEqual({ t: 'lootSpill', playerId: 1, x, y, count: 3, best: 3 });
    expect(ofType(ev, 'lootDrop')).toEqual([]); // a spill is not a new drop
  });

  it('FFA killers get priority; allies, the swarm and self-kills get none', () => {
    const ffa = arena({ mode: 'ffa' });
    ffa.a.carried = hold();
    damageShip(ffa.w, ffa.a, 1e6, ffa.b.id, 'player');
    expect(drops(ffa.w).every((d) => d.reservedFor === 2)).toBe(true);

    const ally = arena({ friendlyFire: true });
    const mate = add(ally.sim, 3, 'engineer', 0);
    mate.invulnUntilTick = 0;
    ally.a.carried = hold();
    damageShip(ally.w, ally.a, 1e6, mate.id, 'player');
    expect(ally.a.alive).toBe(false);
    expect(drops(ally.w)).toHaveLength(3);
    expect(drops(ally.w).every((d) => d.reservedFor === 0 && d.reservedUntilTick === 0)).toBe(true);

    const swarm = arena();
    swarm.a.carried = hold();
    damageShip(swarm.w, swarm.a, 1e6, 0, 'enemy');
    expect(drops(swarm.w).every((d) => d.reservedFor === 0)).toBe(true);

    const self = arena();
    self.a.carried = hold();
    damageShip(self.w, self.a, 1e6, self.a.id, 'self');
    expect(drops(self.w)).toHaveLength(3);
    expect(drops(self.w).every((d) => d.reservedFor === 0)).toBe(true);
  });

  it('the killer priority is enforced: an ally of the victim waits 2 s, the killer does not', () => {
    const { sim, w, a, b } = arena();
    const mate = add(sim, 3, 'engineer', 0); // a's teammate
    a.carried = [tok(2)];
    damageShip(w, a, 1e6, b.id, 'player');
    const [d] = drops(w);
    d.vx = 0; d.vy = 0;
    place(mate, d.x, d.y); place(b, d.x + 400, d.y);
    steps(sim, LOOT_SPILL_RESERVE_SEC * TICK_RATE - 2);
    expect(w.loot!.has(d.id)).toBe(true);
    steps(sim, 3);
    expect(w.loot!.has(d.id)).toBe(false);
    expect(mate.carried).toHaveLength(1);
  });

  it('leaving spills (no priority) and frees caches reserved for the leaver', () => {
    const { sim, w, a, b } = arena();
    const mine = putDrop(w, b.x, b.y + 300, { reservedFor: 1, reservedUntilTick: LOOT_NO_EXPIRY, expireTick: LOOT_NO_EXPIRY });
    a.carried = hold();
    const x = a.x, y = a.y;
    sim.removePlayer(1);
    expect(w.ships.has(a.id)).toBe(false);
    const spilled = drops(w).filter((d) => d !== mine);
    expect(spilled).toHaveLength(3);
    expect(spilled.every((d) => d.x === x && d.y === y && d.reservedFor === 0 && d.droppedBy === 1)).toBe(true);
    expect(ofType(w.events, 'lootSpill')).toEqual([{ t: 'lootSpill', playerId: 1, x, y, count: 3, best: 3 }]);
    expect([mine.reservedFor, mine.reservedUntilTick, mine.expireTick]).toEqual([0, 0, LOOT_NO_EXPIRY]);
  });

  it('a team change spills at the old position (no priority) before respawning', () => {
    const { sim, w, a } = arena();
    a.carried = hold();
    const x = a.x, y = a.y;
    sim.setPlayerTeam(1, 1);
    expect(a.team).toBe(1);
    expect(a.carried).toEqual([]);
    expect(Math.hypot(a.x - x, a.y - y)).toBeGreaterThan(0); // respawned elsewhere
    const ds = drops(w);
    expect(ds).toHaveLength(3);
    expect(ds.every((d) => d.x === x && d.y === y && d.reservedFor === 0 && d.droppedBy === 1)).toBe(true);
    const ev = w.events;
    expect(ev.findIndex((e) => e.t === 'lootSpill')).toBeLessThan(ev.findIndex((e) => e.t === 'shipSpawn'));
  });

  it('an in-place class swap keeps the hold', () => {
    const { sim, w, a } = arena();
    a.carried = hold();
    sim.setShipClass(1, 'tech');
    expect(a.carried).toHaveLength(3);
    expect(w.loot!.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('killShip shutdown roll', () => {
  function kills(o: Partial<SimConfig>, streak: number, killer: 'enemy' | 'ally' | 'foe', n = 40) {
    const r = arena({ friendlyFire: killer === 'ally', ...o });
    const mate = add(r.sim, 3, 'engineer', 0);
    mate.invulnUntilTick = 0;
    r.sim.drainEvents();
    for (let i = 0; i < n; i++) {
      r.a.killStreak = streak;
      if (killer === 'enemy') damageShip(r.w, r.a, 1e6, 0, 'enemy');
      else damageShip(r.w, r.a, 1e6, killer === 'ally' ? mate.id : r.b.id, 'player');
      expect(r.a.killStreak).toBe(0);
      revive(r.a);
    }
    return { ...r, ev: r.w.events };
  }

  it(`a non-ally kill of a pilot on a ${3}+ streak rolls 'shutdown' at the victim, killer priority 3 s`, () => {
    const { w, a, ev } = kills({}, 3, 'foe');
    const dropsEv = ofType(ev, 'lootDrop');
    expect(dropsEv.length).toBeGreaterThan(3); // 30% × 40 kills
    expect(dropsEv.length).toBeLessThanOrEqual(lootCap(w));
    for (const e of dropsEv) {
      expect(e.source).toBe('shutdown');
      expect([e.x, e.y]).toEqual([a.x, a.y]);
      const d = w.loot!.get(e.id)!;
      expect(d.reservedFor).toBe(2);
      expect(d.reservedUntilTick - d.spawnTick).toBe(DROP_RULES.shutdown.reserveSec * TICK_RATE);
    }
    // each roll lands right after its shipDeath
    const first = ev.findIndex((e) => e.t === 'lootDrop');
    expect(ev[first - 1].t).toBe('shipDeath');
  });

  it('no shutdown below the streak, for allies, for the swarm, with lootMult 0, or in a rift', () => {
    expect(ofType(kills({}, 2, 'foe').ev, 'lootDrop')).toEqual([]);
    expect(ofType(kills({}, 6, 'ally').ev, 'lootDrop')).toEqual([]);
    expect(ofType(kills({}, 6, 'enemy').ev, 'lootDrop')).toEqual([]);
    expect(ofType(kills({ lootMult: 0 }, 6, 'foe').ev, 'lootDrop')).toEqual([]);
    expect(ofType(kills({ gameType: 'warzone', pveIntensity: 1 }, 6, 'foe').ev, 'lootDrop').length).toBeGreaterThan(0);
  });

  it('the roll never touches world.rng (twin match without loot draws the same)', () => {
    const on = kills({}, 4, 'foe', 20), off = kills({ lootMult: 0 }, 4, 'foe', 20);
    expect(on.w.loot!.size).toBeGreaterThan(0);
    const draws = (w: World) => Array.from({ length: 8 }, () => w.rng.next());
    expect(draws(on.w)).toEqual(draws(off.w));
  });
});

// ---------------------------------------------------------------------------------------------
describe('personal caches and extraction', () => {
  function rift() {
    const sim = new Sim(cfg({ gameType: 'dungeon', subMode: 'coop', pveIntensity: 1 }));
    const a = add(sim, 1), b = add(sim, 2, 'tech');
    return { sim, w: sim.world, a, b };
  }

  it('one set per recipient (deduped), reserved for them with no expiry; absent personalFor = the priority pid', () => {
    const { w } = rift();
    expect(rollLoot(w, 'bossCache', 640, 640, { priorityPid: 1, personalFor: [1, 2, 2, 0] })).toBe(4); // floors [R, C]
    const ds = drops(w);
    for (const pid of [1, 2]) {
      const mine = ds.filter((d) => d.reservedFor === pid);
      expect(mine).toHaveLength(2);
      expect(mine[0].token.rarity).toBeGreaterThanOrEqual(2);
      for (const d of mine) {
        expect([d.reservedUntilTick, d.expireTick, d.droppedBy]).toEqual([LOOT_NO_EXPIRY, LOOT_NO_EXPIRY, 0]);
        expect(d.token.source).toBe('bossCache');
        expect(['rift', 'common']).toContain(d.token.set);
      }
    }
    expect(ofType(w.events, 'lootDrop')).toHaveLength(4);
    w.loot!.clear();
    expect(rollLoot(w, 'keyChest', 640, 640, { priorityPid: 2 })).toBe(1);
    expect(drops(w)[0].reservedFor).toBe(2);
    expect(rollLoot(w, 'keyChest', 640, 640, { priorityPid: 0 })).toBe(0);
    expect(rollLoot(w, 'keyChest', 640, 640, { priorityPid: 1, personalFor: [] })).toBe(0);
  });

  it('only the owner can take a personal cache', () => {
    const { w, a, b } = rift();
    const c = { x: a.x, y: a.y }; // stepLoot only: positions need not be open floor
    place(b, c.x + 200, c.y);
    const d = putDrop(w, c.x + 4, c.y, { reservedFor: 2, reservedUntilTick: LOOT_NO_EXPIRY, expireTick: LOOT_NO_EXPIRY });
    rebuildGrid(w);
    stepLoot(w, DT);
    expect(w.loot!.has(d.id)).toBe(true);
    place(b, c.x + 40, c.y);
    rebuildGrid(w);
    stepLoot(w, DT);
    expect(w.loot!.has(d.id)).toBe(false);
    expect(b.carried).toHaveLength(1);
  });

  it('secureCarried emits lootSecured with the tokens and clears the hold; an empty hold emits nothing', () => {
    const { w, a, b } = rift();
    const tokens = [tok(4, 'rift', 'bossCache'), tok(1, 'common', 'keyChest')];
    a.carried = tokens.slice();
    secureCarried(w, a);
    expect(a.carried).toEqual([]);
    expect(ofType(w.events, 'lootSecured')).toEqual([{ t: 'lootSecured', playerId: 1, how: 'extract', tokens }]);
    const ev = ofType(w.events, 'lootSecured')[0];
    expect(ev.tokens[0]).not.toBe(tokens[0]); // copies: nothing aliases the (cleared) hold
    w.events.length = 0;
    secureCarried(w, a);
    secureCarried(w, b);
    expect(w.events).toEqual([]);
    expect(b.carried).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
describe('integration', () => {
  /** 30 s scripted warzone brawl, 4 humans + 4 bots; every 5 s a pilot on a 3-streak is shot down. */
  function brawl(lootSeed: number): { sim: Sim; trace: string[] } {
    // lootMult 7: shutdown 15% × 7 → 100%, so the scripted kills always drop (the rest of the economy scales too)
    const sim = new Sim(cfg({ gameType: 'warzone', mapSeed: 4242, pveIntensity: 3, matchSeconds: 120, lootMult: 7, lootSeed }));
    const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
    for (let i = 1; i <= 8; i++) add(sim, i, cls[i % 3], i % 2, i > 4);
    const trace: string[] = [];
    for (let k = 0; k < 60 * 30; k++) {
      for (let i = 1; i <= 8; i++) {
        const a = (k * 0.011 + i * 1.3) % 6.283;
        sim.setInput(i, inp({ seq: k, moveX: Math.cos(a), moveY: Math.sin(a), aim: a, aimDist: 300, primary: true, secondary: k % 40 < 12 }));
      }
      if (k % 300 === 150) {
        const w = sim.world, v = w.ships.get(w.shipsByPlayer.get(1 + ((k / 300) | 0) % 8)!)!;
        const killer = [...w.ships.values()].find((s) => s.alive && s.team !== v.team);
        if (v.alive && killer) { v.killStreak = 3; damageShip(w, v, 1e6, killer.id, 'player'); }
      }
      sim.step();
      const ev = sim.drainEvents().filter((e) => e.t.startsWith('loot'));
      for (const e of ev) if (e.t === 'lootPickup') expect(sim.world.ships.get(e.shipId)!.isBot).toBe(false);
      if (ev.length) trace.push(k + ':' + JSON.stringify(ev));
      expect(sim.world.loot!.size).toBeLessThanOrEqual(MAX_LOOT);
    }
    return { sim, trace };
  }

  it('a 30 s warzone brawl with loot on: deterministic per lootSeed, bounded, humans-only holds within the cap', () => {
    const a = brawl(0xabc), b = brawl(0xabc);
    expect(a.trace.some((l) => l.includes('"lootDrop"'))).toBe(true);
    expect(b.trace).toEqual(a.trace);
    expect(JSON.stringify(drops(b.sim.world))).toBe(JSON.stringify(drops(a.sim.world)));
    for (const s of a.sim.world.ships.values()) {
      if (s.isBot) expect(s.carried ?? []).toEqual([]);
      expect((s.carried ?? []).length).toBeLessThanOrEqual(MAX_CARRIED);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('M2 integration: lootRng stays private, caches never embed in walls', () => {
  it('a roll draws only chance + rarity + set from lootRng: the pop direction comes from public data', () => {
    const A = arena(), B = arena(); // twins: same config, same lootSeed
    expect(rollLoot(A.w, 'flagCapture', A.c.x, A.c.y, { priorityPid: 1 })).toBe(1); // 100%, one floor
    for (let i = 0; i < 3; i++) side(B.w).lootRng.next(); // chance + rarity + set
    expect(side(A.w).lootRng.next()).toBe(side(B.w).lootRng.next()); // the scatter drew nothing from lootRng
    const [d] = drops(A.w);
    expect(Math.hypot(d.vx, d.vy)).toBeGreaterThan(0); // it still pops
  });

  it('a cache rolled inside a wall is moved to the nearest open tile and can be picked up', () => {
    const { sim, w, a } = arena();
    const m = w.map;
    let sx = -1, sy = -1;
    for (let y = 400; y < m.height - 400 && sx < 0; y += m.tileSize) {
      for (let x = 400; x < m.width - 400; x += m.tileSize) {
        const cx = Math.floor(x / m.tileSize) * m.tileSize + m.tileSize / 2, cy = Math.floor(y / m.tileSize) * m.tileSize + m.tileSize / 2;
        // a solid tile whose 3×3 block is solid too (deep inside rock), with an open tile within 3 rings
        let deep = true;
        for (let dy = -1; dy <= 1 && deep; dy++) for (let dx = -1; dx <= 1 && deep; dx++) if (!isSolidAt(m, cx + dx * m.tileSize, cy + dy * m.tileSize)) deep = false;
        if (!deep) continue;
        let near = false;
        for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3 && !near; dx++) if (!isSolidAt(m, cx + dx * m.tileSize, cy + dy * m.tileSize)) near = true;
        if (near) { sx = cx; sy = cy; break; }
      }
    }
    expect(sx).toBeGreaterThan(0);
    expect(rollLoot(w, 'flagCapture', sx, sy, { priorityPid: 0 })).toBe(1);
    const [d] = drops(w);
    expect(isSolidAt(m, d.x, d.y)).toBe(false);
    expect(Math.hypot(d.x - sx, d.y - sy)).toBeLessThanOrEqual(3 * Math.SQRT2 * m.tileSize + 1);
    steps(sim, 2 * TICK_RATE); // settles, still on open ground
    expect(isSolidAt(m, d.x, d.y)).toBe(false);
    place(a, d.x, d.y);
    steps(sim, 2);
    expect(a.carried?.length).toBe(1);
  });
});
