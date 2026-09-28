// SIM v0.3 M1 acceptance (docs/v0.3-proposal.md §9 SIM): constructor normalization (isLegalCombo fallback,
// gameType / subMode kept in world.config), in-place class swap, fieldRevive skips rOut, lootMult 0 leaves
// the world.rng stream identical to v0.2, and the canonical step order's neutral hooks. Real PVE, no mocks.
import { describe, expect, it } from 'vitest';
import { SPAWN_INVULN_SEC, TICK_RATE } from '../constants';
import type { CacheToken, GameEvent, InputState, RiftState, Ship, ShipClassId, SimConfig } from '../types';
import { emptyInput, SHIPFLAG_INVULN } from '../types';
import { damageShip } from './combat';
import { collideCircle, generateMap, isSolidAt } from './map';
import { computeStats } from './pve/upgrades';
import { normalizeSimConfig, Sim } from './Sim';
import { fnv1a } from '../util/hash';

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 1234, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0,
  friendlyFire: false, ...o,
});
function add(sim: Sim, pid: number, cls: ShipClassId, team = 0, isBot = false): Ship {
  return sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot }))!;
}
const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), ...o });
function steps(sim: Sim, n: number): void { for (let i = 0; i < n; i++) sim.step(); }
/** An open area: a 480×320 px box around (x, y) with no solid tiles. */
function openArea(sim: Sim): { x: number; y: number } {
  const m = sim.world.map;
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
/** Past spawn invulnerability, with no inputs. */
function settle(sim: Sim): void { steps(sim, SPAWN_INVULN_SEC * TICK_RATE + 5); }

// ---------------------------------------------------------------------------------------------
describe('constructor normalization (isLegalCombo) — gameType / subMode kept in world.config', () => {
  it('a v0.2 config (no v0.3 fields) keeps v0.2 behaviour: inferred type, deathmatch, v0.2 map and teams', () => {
    const wz = new Sim(cfg({ pveIntensity: 2 })).world;
    expect([wz.config.gameType, wz.config.subMode, wz.config.mode, wz.config.teamCount]).toEqual(['warzone', 'deathmatch', 'teams', 2]);
    expect(wz.map.tiles).toEqual(generateMap(1234, 2).tiles);
    expect(wz.objective).toBeNull();
    expect(wz.dungeon).toBeUndefined();
    const ar = new Sim(cfg({ pveIntensity: 0, mode: 'ffa', teamCount: 5 })).world;
    expect([ar.config.gameType, ar.config.subMode, ar.config.mode, ar.config.teamCount]).toEqual(['arena', 'deathmatch', 'ffa', 0]);
    expect(ar.map.tiles).toEqual(generateMap(1234, 0).tiles);
    expect(ar.match.teamScores).toEqual([]);
    // v0.2 team clamps
    expect(new Sim(cfg({ teamCount: 1 })).world.config.teamCount).toBe(2);
    expect(new Sim(cfg({ teamCount: 12 })).world.config.teamCount).toBe(8);
    expect(new Sim(cfg({ teamCount: NaN })).world.config.teamCount).toBe(2);
    expect(new Sim(cfg({ teamCount: 3.7 })).world.config.teamCount).toBe(3);
  });

  it('does not mutate the caller\'s config object', () => {
    const c = cfg({ mode: 'ffa', teamCount: 4 });
    new Sim(c);
    expect(c.teamCount).toBe(4);
    expect(c.gameType).toBeUndefined();
  });

  it('illegal arena / warzone combos fall back to deathmatch (teamCount clamped 2..8)', () => {
    const cases: [Partial<SimConfig>, [string, string, string, number]][] = [
      [{ gameType: 'arena', subMode: 'coop' }, ['arena', 'deathmatch', 'teams', 2]],
      [{ gameType: 'warzone', subMode: 'ctf', pveIntensity: 2 }, ['warzone', 'deathmatch', 'teams', 2]],
      [{ gameType: 'warzone', subMode: 'hotpoint', pveIntensity: 1 }, ['warzone', 'deathmatch', 'teams', 2]],
      [{ gameType: 'arena', subMode: 'ctf', teamCount: 6 }, ['arena', 'deathmatch', 'teams', 6]],
      [{ gameType: 'arena', subMode: 'ctf', mode: 'ffa' }, ['arena', 'deathmatch', 'ffa', 0]],
      [{ gameType: 'arena', subMode: 'zones', mode: 'ffa' }, ['arena', 'deathmatch', 'ffa', 0]],
      [{ gameType: 'arena', subMode: 'zones', teamCount: 1 }, ['arena', 'deathmatch', 'teams', 2]],
      [{ gameType: 'arena', subMode: 'escort', teamCount: 4 }, ['arena', 'deathmatch', 'teams', 4]],
      [{ gameType: 'arena', subMode: 'rival', teamCount: 2 }, ['arena', 'deathmatch', 'teams', 2]],
      // junk values: type inferred from pve, sub-mode defaulted
      [{ gameType: 'bogus' as never, subMode: 'nope' as never, pveIntensity: 0 }, ['arena', 'deathmatch', 'teams', 2]],
      [{ gameType: 'bogus' as never, pveIntensity: 3, mode: 'weird' as never }, ['warzone', 'deathmatch', 'ffa', 0]],
    ];
    for (const [o, want] of cases) {
      const w = new Sim(cfg(o)).world;
      expect([w.config.gameType, w.config.subMode, w.config.mode, w.config.teamCount], JSON.stringify(o)).toEqual(want);
      expect(w.objective).toBeNull();
      expect(w.map.tiles).toEqual(generateMap(1234, want[3]).tiles);
    }
  });

  it('legal combos are kept as given (readiness is not the sim\'s business)', () => {
    const keep: Partial<SimConfig>[] = [
      { gameType: 'arena', subMode: 'ctf', teamCount: 4 },
      { gameType: 'arena', subMode: 'hotpoint', mode: 'ffa' },
      { gameType: 'arena', subMode: 'zones', teamCount: 8 },
      { gameType: 'warzone', subMode: 'zones', teamCount: 3, pveIntensity: 2 },
      { gameType: 'arena', subMode: 'deathmatch', mode: 'ffa' },
      { gameType: 'warzone', subMode: 'deathmatch', teamCount: 7, pveIntensity: 1 },
    ];
    for (const o of keep) {
      const n = normalizeSimConfig(cfg(o));
      expect([n.gameType, n.subMode, n.mode], JSON.stringify(o)).toEqual([o.gameType, o.subMode, o.mode ?? 'teams']);
      expect(n.teamCount).toBe(n.mode === 'ffa' ? 0 : o.teamCount);
    }
  });

  it('dungeon: always teams, teamCount 1..MAX_PARTIES, untimed; illegal → coop / teams / 1', () => {
    const cases: [Partial<SimConfig>, [string, string, number]][] = [
      [{ gameType: 'dungeon', mode: 'ffa', teamCount: 0 }, ['coop', 'teams', 1]],
      [{ gameType: 'dungeon', subMode: 'coop', teamCount: 2 }, ['coop', 'teams', 1]],
      [{ gameType: 'dungeon', subMode: 'deathmatch', teamCount: 4 }, ['coop', 'teams', 1]],
      [{ gameType: 'dungeon', subMode: 'rival', teamCount: 1 }, ['coop', 'teams', 1]],
      [{ gameType: 'dungeon', subMode: 'ctf', mode: 'ffa' }, ['coop', 'teams', 1]],
    ];
    for (const [o, want] of cases) {
      const n = normalizeSimConfig(cfg({ pveIntensity: 2, matchSeconds: 600, ...o }));
      expect([n.subMode, n.mode, n.teamCount], JSON.stringify(o)).toEqual(want);
      expect(n.gameType).toBe('dungeon');
      expect(n.matchSeconds).toBe(0);
      expect(n.floors).toBe(6);
    }
    // the reserved 2-party rival rift is a legal combo (MAX_PARTIES), not collapsed to coop
    const rival = normalizeSimConfig(cfg({ gameType: 'dungeon', subMode: 'rival', teamCount: 5 }));
    expect([rival.subMode, rival.teamCount]).toEqual(['rival', 2]);
    expect(normalizeSimConfig(cfg({ gameType: 'dungeon', floors: 3 })).floors).toBe(3);
    expect(normalizeSimConfig(cfg({ gameType: 'dungeon', floors: 7 })).floors).toBe(6);
  });

  it('a dungeon Sim is untimed, has one party, and runs on rift floor 1 (M4: floorgen + world.dungeon)', () => {
    const sim = new Sim(cfg({ gameType: 'dungeon', mode: 'ffa', teamCount: 3, pveIntensity: 2, matchSeconds: 900 }));
    const w = sim.world;
    expect(w.match.endTick).toBe(0);
    expect(w.match.teamScores).toEqual([0]);
    expect(w.map.dungeon!.floor).toBe(1);
    expect(w.dungeon).toMatchObject({ floor: 1, floorsTotal: 6, outcome: 'running' });
    expect(w.objective).toBeNull();
    const s = add(sim, 1, 'brute', 5);
    expect(s.team).toBe(0);
    steps(sim, 60 * 5);
    expect(w.match.phase).toBe('playing');
    expect(w.dungeon!.parties[0].lives).toBe(4); // 2 + 2·1 (Veteran)
  });

  it('scoreLimit is a Deathmatch rule: objective sub-modes and rifts drop it (v0.2 configs keep it)', () => {
    expect(normalizeSimConfig(cfg({ scoreLimit: 400 })).scoreLimit).toBe(400); // v0.2 shape → deathmatch
    expect(normalizeSimConfig(cfg({ gameType: 'warzone', subMode: 'deathmatch', scoreLimit: 400 })).scoreLimit).toBe(400);
    expect(normalizeSimConfig(cfg({ gameType: 'arena', subMode: 'ctf', scoreLimit: 400 })).scoreLimit).toBe(0);
    expect(normalizeSimConfig(cfg({ gameType: 'warzone', subMode: 'zones', scoreLimit: 400 })).scoreLimit).toBe(0);
    expect(normalizeSimConfig(cfg({ gameType: 'dungeon', scoreLimit: 400 })).scoreLimit).toBe(0);
    // an illegal objective combo falls back to deathmatch and so keeps its limit
    expect(normalizeSimConfig(cfg({ gameType: 'arena', subMode: 'ctf', mode: 'ffa', scoreLimit: 400 })).scoreLimit).toBe(400);
  });

  it('lootMult is sanitized (finite, ≥ 0) and setLootMult updates world.config', () => {
    expect(normalizeSimConfig(cfg()).lootMult).toBeUndefined();
    expect(normalizeSimConfig(cfg({ lootMult: -2 })).lootMult).toBe(0);
    expect(normalizeSimConfig(cfg({ lootMult: NaN })).lootMult).toBe(0);
    expect(normalizeSimConfig(cfg({ lootMult: 0.5 })).lootMult).toBe(0.5);
    const sim = new Sim(cfg());
    sim.setLootMult(0.75);
    expect(sim.world.config.lootMult).toBe(0.75);
    sim.setLootMult(Infinity);
    expect(sim.world.config.lootMult).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('setShipClass while alive in arena / warzone is in place', () => {
  function rig(o: Partial<SimConfig> = {}) {
    const sim = new Sim(cfg(o));
    const s = add(sim, 1, 'brute');
    settle(sim);
    const { x, y } = openArea(sim);
    place(s, x, y);
    s.vx = 55; s.vy = -35; s.angle = 1.25;
    return { sim, s };
  }

  for (const gameType of ['arena', 'warzone'] as const) {
    it(`${gameType}: keeps id, position, velocity, angle and energy fraction; no invulnerability`, () => {
      const { sim, s } = rig({ gameType, pveIntensity: gameType === 'warzone' ? 2 : 0 });
      const w = sim.world;
      s.energy = s.stats.maxEnergy * 0.4;
      s.mobilityReadyTick = w.tick + 500;
      s.secondaryReadyTick = w.tick + 300;
      const id = s.id, x = s.x, y = s.y, inv = s.invulnUntilTick;
      expect(inv).toBeLessThanOrEqual(w.tick);
      sim.drainEvents();

      sim.setShipClass(1, 'tech');
      expect(s.shipClass).toBe('tech');
      expect(sim.shipIdFor(1)).toBe(id);
      expect(w.ships.get(id)).toBe(s);
      expect(s.alive).toBe(true);
      expect([s.x, s.y, s.vx, s.vy, s.angle]).toEqual([x, y, 55, -35, 1.25]);
      expect(s.stats).toEqual(computeStats('tech', s.upgrades));
      expect(s.stats.maxEnergy).not.toBe(computeStats('brute', s.upgrades).maxEnergy);
      expect(s.energy / s.stats.maxEnergy).toBeCloseTo(0.4, 10);
      expect(s.invulnUntilTick).toBe(inv);
      expect(s.mobilityReadyTick).toBe(w.tick + 500); // a swap never resets cooldowns
      expect(s.secondaryReadyTick).toBe(w.tick + 300);
      const ev = sim.drainEvents();
      expect(ev.filter((e) => e.t === 'shipSpawn')).toEqual([{ t: 'shipSpawn', shipId: id, playerId: 1, x, y }]);

      sim.step();
      expect(s.flags & SHIPFLAG_INVULN).toBe(0);
    });
  }

  it('does not extend remaining spawn protection', () => {
    const sim = new Sim(cfg());
    const s = add(sim, 1, 'engineer');
    steps(sim, 10);
    const inv = s.invulnUntilTick;
    expect(inv).toBeGreaterThan(sim.world.tick);
    sim.setShipClass(1, 'brute');
    expect(s.invulnUntilTick).toBe(inv);
  });

  it('full energy stays full, and an over-cap value is clamped to the new max', () => {
    const { sim, s } = rig();
    s.energy = s.stats.maxEnergy;
    sim.setShipClass(1, 'engineer');
    expect(s.energy).toBe(s.stats.maxEnergy);
    s.energy = s.stats.maxEnergy * 3;
    sim.setShipClass(1, 'tech');
    expect(s.energy).toBe(s.stats.maxEnergy);
  });

  it('clears the old class\'s timed effects and transient state', () => {
    const { sim, s } = rig();
    const w = sim.world;
    s.utilityActiveUntilTick = w.tick + 200; // Iron Hide
    s.mobilityActiveUntilTick = w.tick + 200;
    s.skillState.charging = 30; s.skillState.chargeDirX = 1; s.skillState.hide = 1;
    s.skillState.reviveReadyTick = 77; // persistent keys survive
    sim.setShipClass(1, 'tech');
    expect(s.utilityActiveUntilTick).toBe(0);
    expect(s.mobilityActiveUntilTick).toBe(0);
    expect(s.skillState.charging).toBeUndefined();
    expect(s.skillState.hide).toBeUndefined();
    expect(s.skillState.reviveReadyTick).toBe(77);
  });

  it('a bigger hull swapped in beside a wall is pushed out of it (no embedding)', () => {
    const sim = new Sim(cfg());
    const s = add(sim, 1, 'tech');
    settle(sim);
    const m = sim.world.map;
    const rTech = computeStats('tech', s.upgrades).radius, rBrute = computeStats('brute', s.upgrades).radius;
    expect(rBrute).toBeGreaterThan(rTech);
    // a spot just right of a flat wall: the tech hull fits, the brute hull would overlap it
    let spot: { x: number; y: number } | null = null;
    for (let row = 10; row < m.rows - 10 && !spot; row++) {
      for (let col = 10; col < m.cols - 10 && !spot; col++) {
        const x = col * m.tileSize + rTech + 1, y = row * m.tileSize + m.tileSize / 2;
        if (collideCircle(m, x, y, rTech).hit || !collideCircle(m, x, y, rBrute).hit) continue;
        if (collideCircle(m, x + 2 * rBrute, y, rBrute).hit) continue; // open room to the right: not a narrow gap
        spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();
    place(s, spot!.x, spot!.y);
    sim.setShipClass(1, 'brute');
    expect(s.stats.radius).toBe(rBrute);
    // resolved: at most touching the wall (a second resolve pass doesn't move it), not embedded
    const again = collideCircle(m, s.x, s.y, s.stats.radius);
    expect(Math.hypot(again.x - s.x, again.y - s.y)).toBeLessThan(0.01);
    expect(Math.hypot(s.x - spot!.x, s.y - spot!.y)).toBeGreaterThan(rBrute - rTech - 2);
    expect(Math.hypot(s.x - spot!.x, s.y - spot!.y)).toBeLessThanOrEqual((rBrute - rTech) * Math.SQRT2 + 1); // a corner pushes on both axes
  });

  it('same class is a no-op (no detach, no deployable loss, no event)', () => {
    const { sim, s } = rig();
    const e0 = (s.energy = s.stats.maxEnergy * 0.3);
    sim.drainEvents();
    sim.setShipClass(1, 'brute');
    expect(s.energy).toBe(e0);
    expect(sim.drainEvents()).toEqual([]);
  });

  it('detaches turrets: a host swapping sheds them; a turret swapping leaves with its velocity', () => {
    const sim = new Sim(cfg());
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    settle(sim);
    const { x, y } = openArea(sim);
    place(host, x, y); place(t, x + 80, y);
    sim.step();
    const attach = () => {
      sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
      sim.step();
      sim.setInput(2, inp());
      sim.step();
      expect(t.attachedTo).toBe(host.id);
    };
    attach();
    sim.setShipClass(1, 'engineer');
    expect(t.attachedTo).toBe(0);
    expect(host.turrets).toEqual([]);
    expect(host.alive && t.alive).toBe(true);

    t.attachReadyTick = 0;
    attach();
    host.vx = 40; host.vy = 10;
    sim.step(); // pass 2 copies the host velocity onto the turret
    const tvx = t.vx, tvy = t.vy, tx = t.x, ty = t.y;
    sim.setShipClass(2, 'brute');
    expect(t.attachedTo).toBe(0);
    expect(host.turrets).toEqual([]);
    expect([t.x, t.y, t.vx, t.vy]).toEqual([tx, ty, tvx, tvy]);
  });

  it('dead → respawns with the new class as in v0.2 (full energy, spawn protection)', () => {
    const { sim, s } = rig();
    const w = sim.world;
    s.alive = false; s.respawnTick = w.tick + 1;
    sim.setShipClass(1, 'tech');
    expect(s.alive).toBe(true);
    expect(s.shipClass).toBe('tech');
    expect(s.energy).toBe(s.stats.maxEnergy);
    expect(s.invulnUntilTick).toBeGreaterThan(w.tick);
  });

  it('dungeon and ended matches keep the v0.2 respawn swap', () => {
    const d = new Sim(cfg({ gameType: 'dungeon', pveIntensity: 1 }));
    const ds = add(d, 1, 'brute');
    settle(d);
    ds.energy = ds.stats.maxEnergy * 0.2;
    d.setShipClass(1, 'tech');
    expect(ds.energy).toBe(ds.stats.maxEnergy);
    expect(ds.invulnUntilTick).toBeGreaterThan(d.world.tick);

    const { sim, s } = rig();
    sim.world.match.phase = 'ended';
    s.energy = s.stats.maxEnergy * 0.2;
    sim.setShipClass(1, 'tech');
    expect(s.energy).toBe(s.stats.maxEnergy);
  });

  it('an extracted (rOut) or out-of-lives (rWait) pilot only changes class and stays down', () => {
    for (const flag of ['rOut', 'rWait']) {
      const { sim, s } = rig();
      s.alive = false; s.respawnTick = Number.MAX_SAFE_INTEGER; s.skillState[flag] = 1;
      sim.drainEvents();
      sim.setShipClass(1, 'engineer');
      expect(s.shipClass).toBe('engineer');
      expect(s.alive).toBe(false);
      expect(sim.drainEvents().some((e) => e.t === 'shipSpawn')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('fieldRevive', () => {
  function rig() {
    const sim = new Sim(cfg());
    const medic = add(sim, 1, 'engineer'), dead = add(sim, 2, 'brute');
    settle(sim);
    medic.upgrades['path:medic'] = 1; medic.upgrades.med_revive = 1; medic.path = 'medic';
    const { x, y } = openArea(sim);
    place(medic, x, y);
    place(dead, x + 120, y);
    dead.alive = false; dead.respawnTick = sim.world.tick + 60 * 60;
    return { sim, medic, dead };
  }

  it('revives a dead teammate near the medic (control)', () => {
    const { sim, medic, dead } = rig();
    sim.step();
    expect(dead.alive).toBe(true);
    expect(Math.hypot(dead.x - medic.x, dead.y - medic.y)).toBeLessThan(1);
  });

  it('ignores extracted pilots (rOut)', () => {
    const { sim, dead } = rig();
    dead.skillState.rOut = 1; dead.respawnTick = Number.MAX_SAFE_INTEGER;
    steps(sim, 30);
    expect(dead.alive).toBe(false);
  });

  it('revives an out-of-lives pilot (rWait) and clears the flag', () => {
    const { sim, dead } = rig();
    dead.skillState.rWait = 1; dead.respawnTick = Number.MAX_SAFE_INTEGER;
    sim.step();
    expect(dead.alive).toBe(true);
    expect(dead.skillState.rWait).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
describe('lootMult 0 leaves the world.rng stream identical to v0.2', () => {
  function run(extra: Partial<SimConfig>): { sim: Sim; trace: string[] } {
    const sim = new Sim({ ...cfg({ mapSeed: 4242, pveIntensity: 3, teamCount: 2, matchSeconds: 120 }), ...extra });
    const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
    for (let i = 1; i <= 8; i++) add(sim, i, cls[i % 3], i % 2, true);
    const trace: string[] = [];
    for (let k = 0; k < 60 * 30; k++) {
      for (let i = 1; i <= 8; i++) {
        const a = (k * 0.011 + i * 1.3) % 6.283;
        sim.setInput(i, inp({
          seq: k, moveX: Math.cos(a), moveY: Math.sin(a), aim: a + Math.sin(k * 0.07), aimDist: 300,
          primary: true, secondary: k % 40 < 12, mobility: k % 180 === i, utility: k % 240 === i,
          attach: k % 300 === i * 7, detach: k % 300 === i * 7 + 90,
        }));
        if (k % 45 === 0) sim.chooseUpgrade(i, i % 3);
      }
      if (k % 400 === 200) { // a scripted PvP kill: death gems + respawn pick both draw from world.rng
        const w = sim.world, v = w.ships.get(w.shipsByPlayer.get(1 + ((k / 400) | 0) % 8)!)!;
        const killer = w.ships.get(w.shipsByPlayer.get(1 + (((k / 400) | 0) + 1) % 8)!)!;
        if (v.alive) damageShip(w, v, 1e6, killer.id, 'player');
      }
      sim.step();
      const ev: GameEvent[] = sim.drainEvents();
      if (ev.length) trace.push(k + ':' + JSON.stringify(ev));
    }
    return { sim, trace };
  }

  it('same events, entities and rng draws as a config without any v0.3 field', () => {
    const a = run({});
    const b = run({ gameType: 'warzone', subMode: 'deathmatch', lootMult: 0, lootSeed: 0x7fedcba9, objectiveLimit: 0 });
    const wa = a.sim.world, wb = b.sim.world;
    expect(wb.config.lootMult).toBe(0);
    expect(b.trace.length).toBe(a.trace.length);
    expect(b.trace).toEqual(a.trace);
    expect(wb.tick).toBe(wa.tick);
    expect(wb.nextId).toBe(wa.nextId);
    expect(wb.enemies.size).toBe(wa.enemies.size);
    expect(wb.gems.size).toBe(wa.gems.size);
    expect(wb.loot!.size).toBe(0);
    for (const [id, s] of wa.ships) {
      const t = wb.ships.get(id)!;
      expect([t.x, t.y, t.energy, t.score, t.xp, t.level]).toEqual([s.x, s.y, s.energy, s.score, s.xp, s.level]);
    }
    const draws = (w: typeof wa) => Array.from({ length: 8 }, () => w.rng.next());
    expect(draws(wb)).toEqual(draws(wa));
    // the run actually exercised world.rng: waves spawned and ships died / respawned
    expect(a.trace.some((l) => l.includes('"waveStart"'))).toBe(true);
    expect(a.trace.some((l) => l.includes('"enemyDeath"'))).toBe(true);
    expect(a.trace.filter((l) => l.includes('"shipDeath"')).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Golden digest of this exact run, captured from the pre-M1 v0.2.1 Sim (its backup, same scripted inputs,
   * no AI). The test above compares the M1 Sim with itself, so a change shared by both runs would slip through;
   * this one pins the v0.2 behaviour itself. Loot (M2), objectives (M3) and rifts (M4) must never move it
   * for a Deathmatch config with lootMult 0. Re-pin ONLY for a deliberate v0.2 gameplay change (and say so).
   */
  it('reproduces the v0.2.1 golden digest, with and without the v0.3 fields', () => {
    const V021_GOLDEN = '1404:359866:f57ee6fa';
    const digest = (r: { sim: Sim; trace: string[] }): string => {
      const w = r.sim.world;
      const parts = r.trace.slice();
      for (const s of w.ships.values()) parts.push(JSON.stringify([s.id, s.shipClass, s.team, s.alive, s.x, s.y, s.energy, s.score, s.xp, s.level, s.kills, s.deaths]));
      parts.push(JSON.stringify([w.tick, w.nextId, w.enemies.size, w.gems.size, w.projectiles.size]));
      parts.push(JSON.stringify(Array.from({ length: 8 }, () => w.rng.next())));
      const all = parts.join('\n');
      return `${parts.length}:${all.length}:${fnv1a(all).toString(16).padStart(8, '0')}`;
    };
    expect(digest(run({}))).toBe(V021_GOLDEN);
    expect(digest(run({ gameType: 'warzone', subMode: 'deathmatch', lootMult: 0, lootSeed: 0x7fedcba9, objectiveLimit: 0 }))).toBe(V021_GOLDEN);
  });
});

// ---------------------------------------------------------------------------------------------
describe('canonical step order hooks (neutral outside their mode)', () => {
  it('a deathmatch match has no objective, no rift, no loot, and steps cleanly to the end', () => {
    const sim = new Sim(cfg({ gameType: 'warzone', subMode: 'deathmatch', pveIntensity: 1, matchSeconds: 5, lootMult: 1 }));
    for (let i = 1; i <= 4; i++) add(sim, i, 'brute', i % 2, true);
    steps(sim, 5 * 60 + 2);
    expect(sim.world.objective).toBeNull();
    expect(sim.world.dungeon).toBeUndefined();
    expect(sim.world.loot!.size).toBe(0);
    expect(sim.world.match.phase).toBe('ended');
  });

  it('a stray pendingFloor outside a rift is only cleared (no floor swap); abandonRift only acts on a running rift', () => {
    const sim = new Sim(cfg());
    add(sim, 1, 'brute');
    expect(() => sim.abandonRift()).not.toThrow(); // no rift: no-op
    const map = sim.world.map;
    const rift = { pendingFloor: 2, outcome: 'running' } as unknown as RiftState;
    sim.world.dungeon = rift;
    sim.step();
    expect(rift.pendingFloor).toBe(0);
    expect(sim.world.map).toBe(map); // an arena map is never swapped for a rift floor
    expect(sim.world.match.phase).toBe('playing'); // and the deathmatch rules still run the match
    sim.abandonRift();
    expect(rift.outcome).toBe('abandoned');
    rift.outcome = 'cleared';
    sim.abandonRift();
    expect(rift.outcome).toBe('cleared');
  });

  it('takeCarried returns the carried caches once and clears them', () => {
    const sim = new Sim(cfg());
    const s = add(sim, 1, 'tech');
    expect(sim.takeCarried(1)).toEqual([]);
    expect(sim.takeCarried(99)).toEqual([]);
    const tokens: CacheToken[] = [{ rarity: 2, set: 'swarm', source: 'elite' }, { rarity: 0, set: 'common', source: 'shutdown' }];
    s.carried = tokens.slice();
    expect(sim.takeCarried(1)).toEqual(tokens);
    expect(s.carried).toEqual([]);
    expect(sim.takeCarried(1)).toEqual([]);
  });
});
