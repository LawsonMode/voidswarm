import { describe, expect, it, vi } from 'vitest';

vi.mock('./pve/index', () => ({
  pveInit: () => {},
  pveStep: () => {},
  onEnemyKilled: (world: any, enemy: any) => { world.enemies.delete(enemy.id); },
  dropShipXp: () => {},
  grantXp: () => {},
  applyUpgradeChoice: () => {},
  rebuildOffers: () => {},
  xpToNextFor: () => 10,
  TRAIL_MINE_MARK: 99,
}));
vi.mock('./pve/upgrades', async () => {
  const { SHIP_CLASSES } = await import('../data/ships');
  return {
    UPGRADES: {},
    computeStats: (cls: keyof typeof SHIP_CLASSES) => ({ ...SHIP_CLASSES[cls].base, skill: { ...SHIP_CLASSES[cls].base.skill } }),
    resolvePath: () => null,
  };
});

import { MAP_SIZE, MAP_TILE, TICK_RATE } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import type { Enemy, InputState, Ship, ShipClassId, SimConfig } from '../types';
import { BEAM_LASER, emptyInput, TILE_BASE, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../types';
import { damageEnemy, damageShip, healShip } from './combat';
import { collideCircle, generateMap, isSolidAt, lineOfSight, tileAt } from './map';
import { stepShipMovement } from './movement';
import { Sim } from './Sim';
import { projectileDefaults, rebuildGrid, spawnProjectile } from './world';
import { LASER_RESONANCE, TURRET_HOST_FLOOR_FRAC, ENEMY_TEAM } from '../constants';

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 1234, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0,
  friendlyFire: false, ...o,
});

function reachable(map: ReturnType<typeof generateMap>, sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(map.tiles.length);
  const q: number[] = [Math.floor(sy / MAP_TILE) * map.cols + Math.floor(sx / MAP_TILE)];
  seen[q[0]] = 1;
  while (q.length) {
    const i = q.pop()!;
    const c = i % map.cols, r = (i - c) / map.cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      const t = tileAt(map, nc, nr);
      const j = nr * map.cols + nc;
      if (t === TILE_WALL || t === TILE_ROCK || seen[j]) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return seen;
}

describe('map', () => {
  for (const teams of [0, 2, 4, 8]) {
    it(`deterministic + connected (teams=${teams})`, () => {
      const a = generateMap(777 + teams, teams), b = generateMap(777 + teams, teams);
      expect(a.cols).toBe(MAP_SIZE / MAP_TILE);
      expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(true);
      expect(a.spawns).toEqual(b.spawns);
      if (teams === 0) expect(a.spawns.length).toBeGreaterThanOrEqual(15);
      else for (let t = 0; t < teams; t++) expect(a.spawns.filter((s) => s.team === t).length).toBeGreaterThanOrEqual(4);

      let solid = 0, base = 0;
      for (const t of a.tiles) { if (t === TILE_WALL || t === TILE_ROCK) solid++; if (t === TILE_BASE) base++; }
      const frac = solid / a.tiles.length;
      expect(frac).toBeGreaterThan(0.12);
      expect(frac).toBeLessThan(0.35);
      if (teams) expect(base).toBe(teams * 64);

      const seen = reachable(a, a.spawns[0].x, a.spawns[0].y);
      for (const s of a.spawns) {
        expect(isSolidAt(a, s.x, s.y)).toBe(false);
        expect(seen[Math.floor(s.y / MAP_TILE) * a.cols + Math.floor(s.x / MAP_TILE)]).toBe(1);
      }
      // every open tile is reachable (pockets filled or tunneled)
      for (let i = 0; i < a.tiles.length; i++) {
        const t = a.tiles[i];
        if (t === TILE_EMPTY || t === TILE_BASE) expect(seen[i]).toBe(1);
      }
    });
  }
  it('different seeds differ', () => {
    const a = generateMap(1, 2), b = generateMap(2, 2);
    expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(false);
  });
  it('border / collide / los', () => {
    const m = generateMap(5, 0);
    expect(isSolidAt(m, 5, 5)).toBe(true);
    expect(isSolidAt(m, -1, 100)).toBe(true);
    expect(tileAt(m, -1, 0)).toBe(TILE_WALL);
    const r = collideCircle(m, 64 + 10, 3200, 16); // border wall occupies x<64
    expect(r.hit).toBe(true);
    expect(r.x).toBeCloseTo(80, 5);
    expect(r.nx).toBeCloseTo(1, 5);
    expect(lineOfSight(m, 3200, 3200, 3210, 3200)).toBe(true);
    expect(lineOfSight(m, 3200, 3200, 10, 3200)).toBe(false);
  });
});

describe('movement', () => {
  it('thrusts, clamps speed, bounces off walls', () => {
    const m = generateMap(5, 0);
    const stats = { ...SHIP_CLASSES.brute.base };
    const body = { x: 3200, y: 3200, vx: 0, vy: 0, angle: 0 };
    const inp: InputState = { ...emptyInput(), moveX: 1, aim: Math.PI / 2 };
    for (let i = 0; i < 120; i++) stepShipMovement(body, inp, stats, m, 1 / 60, false, 1);
    expect(body.angle).toBeCloseTo(Math.PI / 2, 3);
    expect(Math.hypot(body.vx, body.vy)).toBeLessThanOrEqual(stats.maxSpeed + 1e-6);
    // wall bounce: fly into left border
    const b2 = { x: 100, y: 3200, vx: -400, vy: 0, angle: 0 };
    for (let i = 0; i < 30; i++) stepShipMovement(b2, emptyInput(), stats, m, 1 / 60, false, 1);
    expect(b2.x).toBeGreaterThanOrEqual(64 + stats.radius - 1e-6);
    expect(b2.vx).toBeGreaterThan(0);
  });
});

import { turretDamageMultFor } from './turretkits';

function freshSim(o: Partial<SimConfig> = {}) {
  return new Sim(cfg(o));
}
function add(sim: Sim, pid: number, cls: ShipClassId, team = 0): Ship {
  const s = sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot: false }))!;
  s.invulnUntilTick = 0;
  return s;
}
function mkEnemy(sim: Sim, x: number, y: number, hp = 1e6, radius = 14): Enemy {
  const w = sim.world;
  const e: Enemy = {
    id: w.nextId++, kind: 'drone', x, y, vx: 0, vy: 0, angle: 0, hp, maxHp: hp, radius, elite: false,
    targetId: 0, spawnTick: 0, aiState: 0, aiTimer: 0, mem: {}, contactDamage: 0, scoreValue: 1, xpValue: 1,
  };
  w.enemies.set(e.id, e);
  return e;
}
/** An open area: [x-160, x+len] x [y-120, y+120] has no solid tiles. */
function openArea(sim: Sim, len = 560): { x: number; y: number } {
  const m = sim.world.map;
  for (let y = 400; y < m.height - 400; y += 32) {
    for (let x = 400; x < m.width - len - 400; x += 32) {
      let ok = true;
      for (let dy = -120; dy <= 120 && ok; dy += 16) for (let dx = -160; dx <= len && ok; dx += 16) if (isSolidAt(m, x + dx, y + dy)) ok = false;
      if (ok) return { x, y };
    }
  }
  throw new Error('no open area');
}
function place(s: Ship, x: number, y: number, angle = 0): void {
  s.x = x; s.y = y; s.vx = 0; s.vy = 0; s.angle = angle;
}
function steps(sim: Sim, n: number): void { for (let i = 0; i < n; i++) sim.step(); }
const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), ...o });

describe('sim core', () => {
  it('spawns ships with invuln at team spawns', () => {
    const sim = freshSim();
    const id = sim.addPlayer({ playerId: 1, name: 'a', team: 0, shipClass: 'brute', isBot: false });
    const s = sim.world.ships.get(id)!;
    expect(s.alive).toBe(true);
    expect(s.team).toBe(0);
    expect(s.path).toBe(null);
    expect(s.energy).toBe(s.stats.maxEnergy);
    expect(sim.world.map.spawns.some((p) => p.team === 0 && p.x === s.x && p.y === s.y)).toBe(true);
    sim.step();
    expect(s.flags & 4).toBeTruthy();
    expect(sim.drainEvents().some((e) => e.t === 'shipSpawn')).toBe(true);
  });

  it('primaries kill a ship and credit bounty', () => {
    const sim = freshSim({ mode: 'ffa' });
    const { x, y } = openArea(sim);
    const a = add(sim, 1, 'brute'), b = add(sim, 2, 'tech');
    const bounty = b.bounty;
    sim.setInput(1, inp({ aim: 0, primary: true }));
    let died = false;
    for (let i = 0; i < 60 * 6 && !died; i++) {
      place(a, x, y); place(b, x + 250, y);
      b.energy = Math.min(b.energy, 300);
      sim.step();
      died = sim.drainEvents().some((e) => e.t === 'shipDeath' && e.shipId === b.id && e.killerPlayerId === 1);
    }
    expect(died).toBe(true);
    expect(a.kills).toBe(1);
    expect(a.score).toBe(10 + bounty);
    sim.setInput(1, emptyInput());
    steps(sim, 3 * TICK_RATE + 2);
    expect(b.alive).toBe(true);
  });

  it('assist credit when an enemy finishes', () => {
    const sim = freshSim({ mode: 'ffa' });
    const a = add(sim, 1, 'brute'), b = add(sim, 2, 'brute');
    damageShip(sim.world, b, 100, a.id, 'player');
    damageShip(sim.world, b, 1e5, 0, 'enemy');
    const ev = sim.drainEvents().find((e) => e.t === 'shipDeath');
    expect(ev && ev.t === 'shipDeath' && ev.killerPlayerId).toBe(1);
  });

  it('damageEnemy kills exactly once', () => {
    const sim = freshSim();
    const e = mkEnemy(sim, 3200, 3200, 50);
    damageEnemy(sim.world, e, 100, 0);
    damageEnemy(sim.world, e, 100, 0);
    expect(sim.world.enemies.has(e.id)).toBe(false);
    expect(sim.drainEvents().filter((x) => x.t === 'hit').length).toBe(1);
  });

  it('attach / detach / host death', () => {
    const sim = freshSim();
    const host = add(sim, 1, 'engineer'), t = add(sim, 2, 'brute');
    sim.step();
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(t.attachedTo).toBe(host.id);
    expect(host.turrets).toEqual([t.id]);
    sim.setInput(1, inp({ moveX: 1 }));
    steps(sim, 20);
    expect(Math.hypot(t.x - host.x, t.y - host.y)).toBeCloseTo(host.stats.radius + 12, 3);
    sim.setInput(1, inp({ detach: true }));
    sim.step();
    expect(t.attachedTo).toBe(0);
    // reattach (after cooldown) then host dies
    sim.setInput(1, inp());
    sim.setInput(2, inp());
    steps(sim, 200);
    sim.setInput(2, inp({ attach: true }));
    sim.step();
    expect(t.attachedTo).toBe(host.id);
    host.invulnUntilTick = 0;
    damageShip(sim.world, host, 1e6, 0, 'enemy');
    expect(t.attachedTo).toBe(0);
    expect(host.turrets.length).toBe(0);
    // FFA: no attach
    const f = freshSim({ mode: 'ffa' });
    add(f, 1, 'engineer');
    const ft = add(f, 2, 'tech');
    f.step();
    f.setInput(2, inp({ attach: true }));
    f.step();
    expect(ft.attachedTo).toBe(0);
  });

  it('bul_clamp bypasses the attach energy minimum and cooldown', () => {
    const sim = freshSim();
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    sim.step();
    t.energy = 10;
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(t.attachedTo).toBe(0);
    host.upgrades['path:bulwark'] = 1; host.upgrades.bul_clamp = 1;
    sim.setInput(2, inp());
    sim.step();
    t.energy = 10;
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(t.attachedTo).toBe(host.id);
  });

  it('match ends on time and score limit', () => {
    const sim = freshSim({ matchSeconds: 1 });
    const s = add(sim, 1, 'brute', 1);
    s.score = 50;
    steps(sim, 61);
    expect(sim.world.match.phase).toBe('ended');
    expect(sim.world.match.winnerTeam).toBe(1);
    expect(sim.world.match.winnerPlayerId).toBe(1);
    expect(sim.drainEvents().filter((e) => e.t === 'matchEnd').length).toBe(1);
    const s2 = freshSim({ mode: 'ffa', scoreLimit: 100 });
    const p = add(s2, 7, 'tech');
    s2.step();
    p.score = 100;
    s2.step();
    expect(s2.world.match.phase).toBe('ended');
    expect(s2.world.match.winnerPlayerId).toBe(7);
  });

  it('setInput sanitizes', () => {
    const sim = freshSim();
    const s = add(sim, 1, 'brute');
    sim.setInput(1, { ...emptyInput(), seq: 5, moveX: NaN, moveY: 5, aim: Infinity, aimDist: NaN });
    sim.step(); // queued inputs are applied by step()
    expect(s.input.moveX).toBe(0);
    expect(s.input.moveY).toBe(1);
    expect(Number.isFinite(s.input.aim)).toBe(true);
    expect(s.input.aimDist).toBe(300);
    expect(s.lastInputSeq).toBe(5);
    sim.setInput(1, { ...emptyInput(), seq: 6, aimDist: 99999 });
    sim.step();
    expect(s.input.aimDist).toBe(2000);
  });
});

describe('class skills', () => {
  it('rockets, iron hide, ram hit-once + CHARGING flag', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const b = add(sim, 1, 'brute');
    place(b, x, y);
    sim.setInput(1, inp({ secondary: true }));
    sim.step();
    expect([...sim.world.projectiles.values()].filter((p) => p.kind === 'rocket' && p.ownerId === b.id).length).toBe(3);
    sim.world.projectiles.clear();
    // iron hide
    sim.setInput(1, inp({ utility: true }));
    sim.step();
    expect(b.flags & 8).toBeTruthy();
    const e0 = b.energy;
    damageShip(sim.world, b, 1000, 0, 'enemy');
    expect(e0 - b.energy).toBeCloseTo(1000 * 0.4 * 0.9, 3);
    // ram
    place(b, x, y);
    const e = mkEnemy(sim, x + 120, y);
    sim.drainEvents();
    sim.setInput(1, inp({ mobility: true, aim: 0 }));
    sim.step();
    expect(b.flags & 16).toBeTruthy();
    sim.setInput(1, inp({ aim: 0 }));
    steps(sim, 40);
    const hits = sim.drainEvents().filter((ev) => ev.t === 'hit' && ev.targetId === e.id);
    expect(hits.length).toBe(1);
    expect(1e6 - e.hp).toBeCloseTo(b.stats.skill.ramDamage, 3);
    expect(b.x).toBeGreaterThan(x + 300);
    expect(b.flags & 16).toBeFalsy();
  });

  it('arc chains with falloff; blink teleports; singularity makes a well', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const t = add(sim, 1, 'tech');
    place(t, x, y);
    const es = [mkEnemy(sim, x + 200, y), mkEnemy(sim, x + 320, y), mkEnemy(sim, x + 440, y)];
    sim.setInput(1, inp({ secondary: true, aim: 0, aimDist: 200 }));
    sim.step();
    const d = t.stats.skill.arcDamage;
    expect(1e6 - es[0].hp).toBeCloseTo(d, 3);
    expect(1e6 - es[1].hp).toBeCloseTo(d * 0.85, 3);
    expect(1e6 - es[2].hp).toBeCloseTo(d * 0.85 * 0.85, 3);
    expect(sim.drainEvents().some((ev) => ev.t === 'arc')).toBe(true);
    for (const e of es) sim.world.enemies.delete(e.id);
    // blink
    place(t, x, y);
    sim.setInput(1, inp({ mobility: true, aim: 0 }));
    sim.step();
    expect(t.x).toBeGreaterThan(x + 400);
    expect(t.flags & 4).toBeTruthy();
    expect(sim.drainEvents().some((ev) => ev.t === 'blink')).toBe(true);
    // singularity
    place(t, x, y);
    sim.setInput(1, inp({ utility: true, aim: 0, aimDist: 300 }));
    for (let i = 0; i < 40; i++) { place(t, x, y); sim.step(); }
    const well = [...sim.world.deployables.values()].find((dd) => dd.kind === 'well');
    expect(well).toBeTruthy();
    expect(Math.abs(well!.x - (x + 300))).toBeLessThan(40);
  });

  it('wall blocks hostile projectiles, friendly ones pass', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const en = add(sim, 1, 'engineer');
    place(en, x, y);
    sim.setInput(1, inp({ utility: true, aim: 0, aimDist: 150 }));
    sim.step();
    sim.setInput(1, inp({ aim: 0 }));
    const wall = [...sim.world.deployables.values()].find((d) => d.kind === 'wall')!;
    expect(wall).toBeTruthy();
    expect(wall.x).toBeCloseTo(x + 150, 0);
    const w = sim.world;
    const hostile = spawnProjectile(w, {
      ...projectileDefaults(w), kind: 'enemyShot', ownerId: 9999, ownerPlayerId: 0, ownerTeam: ENEMY_TEAM,
      x: x + 350, y, vx: -600, vy: 0, damage: 77, radius: 5, expireTick: w.tick + 600,
    })!;
    const friendly = spawnProjectile(w, {
      ...projectileDefaults(w), kind: 'bullet', ownerId: en.id, ownerPlayerId: en.playerId, ownerTeam: en.team,
      x: x + 100, y, vx: 600, vy: 0, damage: 50, radius: 4, expireTick: w.tick + 600,
    })!;
    for (let i = 0; i < 25; i++) { place(en, x, y); sim.step(); }
    expect(w.projectiles.has(hostile.id)).toBe(false);
    expect(wall.maxHp - wall.hp).toBeCloseTo(77, 5);
    expect(w.projectiles.has(friendly.id)).toBe(true);
    expect(friendly.x).toBeGreaterThan(wall.x + 50);
  });

  it('sentry deploys at the ship and fires seekers', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const en = add(sim, 1, 'engineer');
    place(en, x, y);
    const e = mkEnemy(sim, x + 300, y);
    sim.setInput(1, inp({ secondary: true }));
    sim.step();
    sim.setInput(1, inp());
    const sentry = [...sim.world.deployables.values()].find((d) => d.kind === 'sentry')!;
    expect(sentry).toBeTruthy();
    expect(sentry.x).toBe(x);
    let seekers = 0;
    for (let i = 0; i < 90; i++) {
      place(en, x - 100, y);
      sim.step();
      for (const p of sim.world.projectiles.values()) if (p.kind === 'seeker' && p.ownerId === en.id) seekers++;
    }
    expect(seekers).toBeGreaterThan(0);
    expect(e.hp).toBeLessThan(1e6);
  });

  it('healShip caps at max energy and tracks healDone', () => {
    const sim = freshSim();
    const a = add(sim, 1, 'engineer'), b = add(sim, 2, 'brute');
    sim.drainEvents();
    b.energy = b.stats.maxEnergy - 50;
    expect(healShip(sim.world, b, 1000, a.id)).toBeCloseTo(50, 6);
    expect(b.energy).toBe(b.stats.maxEnergy);
    expect(healShip(sim.world, b, 1000, a.id)).toBe(0);
    expect(a.skillState.healDone).toBeCloseTo(50, 6);
    const ev = sim.drainEvents().find((e) => e.t === 'heal');
    expect(ev && ev.t === 'heal' && ev.amount).toBe(50);
    // triage: +50% on allies below 30%
    a.upgrades['path:medic'] = 1; a.upgrades.med_triage = 1;
    b.energy = 100;
    expect(healShip(sim.world, b, 100, a.id)).toBeCloseTo(150, 6);
  });

  it('repair pulse heals self + allies, not foes', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const en = add(sim, 1, 'engineer'), ally = add(sim, 2, 'brute'), foe = add(sim, 3, 'brute', 1);
    place(en, x, y); place(ally, x + 100, y); place(foe, x + 120, y + 60);
    ally.energy = 100; foe.energy = 100; en.energy = en.stats.maxEnergy - 200;
    sim.setInput(1, inp({ mobility: true }));
    sim.step();
    const heal = en.stats.skill.healFrac * ally.stats.maxEnergy;
    expect(ally.energy).toBeGreaterThan(100 + heal - 5);
    expect(foe.energy).toBeLessThan(100 + 10);
    expect(en.energy).toBe(en.stats.maxEnergy);
  });

  it('Field Revive respawns a dead teammate at the medic (with cooldown)', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const med = add(sim, 1, 'engineer'), ally = add(sim, 2, 'brute');
    med.upgrades['path:medic'] = 1; med.upgrades.med_revive = 1;
    place(med, x, y); place(ally, x + 200, y);
    damageShip(sim.world, ally, 1e6, 0, 'enemy');
    expect(ally.alive).toBe(false);
    sim.step();
    expect(ally.alive).toBe(true);
    expect(Math.hypot(ally.x - med.x, ally.y - med.y)).toBeLessThan(40);
    ally.invulnUntilTick = 0;
    damageShip(sim.world, ally, 1e6, 0, 'enemy');
    sim.step();
    expect(ally.alive).toBe(false); // on cooldown -> normal respawn timer
  });
});

describe('turret kits', () => {
  function laserRig() {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute');
    place(host, x, y, 0);
    host.stats.rechargePerSec = 0;
    const t1 = add(sim, 2, 'tech'), t2 = add(sim, 3, 'tech');
    sim.step();
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.setInput(3, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(host.turrets.length).toBe(2);
    place(host, x, y, 0);
    sim.step();
    const e = mkEnemy(sim, x + 320, y, 1e6, 24);
    const aimOf = (t: Ship) => Math.atan2(e.y - t.y, e.x - t.x);
    return { sim, host, t1, t2, e, aimOf };
  }

  it('laser resonance: x1.5^(n-1) damage and host draw; floor blocks', () => {
    const { sim, host, t1, t2, e, aimOf } = laserRig();
    const sk = t1.stats.skill;
    const aim1 = aimOf(t1), aim2 = aimOf(t2);
    t1.angle = aim1; t2.angle = aim2;
    // one laser
    sim.setInput(2, inp({ primary: true, aim: aim1 }));
    sim.setInput(3, inp({ aim: aim2 }));
    host.energy = host.stats.maxEnergy;
    let h0 = host.energy, hp0 = e.hp;
    steps(sim, 120);
    expect(h0 - host.energy).toBeCloseTo(sk.laserHostCostPerSec * 2, 3);
    const single = hp0 - e.hp;
    expect(single).toBeGreaterThan(sk.laserDps * 1.85);
    expect(single).toBeLessThanOrEqual(sk.laserDps * 2 + 1e-6);
    expect(t1.skillState.resonance).toBe(1);
    expect(t1.skillState.beamKind).toBe(BEAM_LASER);
    expect(t1.skillState.beamLen).toBeGreaterThan(200);
    expect(t1.skillState.beamLen).toBeLessThan(340);
    // two lasers resonate
    sim.setInput(3, inp({ primary: true, aim: aim2 }));
    host.energy = host.stats.maxEnergy;
    h0 = host.energy; hp0 = e.hp;
    steps(sim, 120);
    const f = LASER_RESONANCE;
    expect(h0 - host.energy).toBeCloseTo(sk.laserHostCostPerSec * 2 * 2 * f, 3);
    const dual = hp0 - e.hp;
    expect(dual).toBeGreaterThan(sk.laserDps * 2 * 2 * f * 0.92);
    expect(dual).toBeLessThanOrEqual(sk.laserDps * 2 * 2 * f + 1e-6);
    expect(t1.skillState.resonance).toBe(2);
    expect(t2.skillState.resonance).toBe(2);
    // floor
    host.energy = TURRET_HOST_FLOOR_FRAC * host.stats.maxEnergy - 1;
    h0 = host.energy;
    steps(sim, 10);
    expect(host.energy).toBe(h0);
    expect(t1.skillState.beamLen).toBe(0);
  });

  it('flak draws host energy per burst and stops below the floor; bulwark / turret-bay bonus', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'engineer'), t = add(sim, 2, 'brute');
    place(host, x, y);
    host.stats.rechargePerSec = 0;
    sim.step();
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(t.attachedTo).toBe(host.id);
    const sk = t.stats.skill;
    const h0 = host.energy, e0 = t.energy;
    sim.setInput(2, inp({ primary: true }));
    sim.step();
    expect(h0 - host.energy).toBeCloseTo(sk.flakHostCost, 6);
    expect(t.energy).toBeGreaterThanOrEqual(e0); // own energy untouched (recharging)
    expect([...sim.world.projectiles.values()].filter((p) => p.ownerId === t.id).length).toBe(sk.flakPellets);
    host.energy = TURRET_HOST_FLOOR_FRAC * host.stats.maxEnergy - 1;
    const h1 = host.energy;
    sim.world.projectiles.clear();
    steps(sim, 60);
    expect(host.energy).toBe(h1);
    expect(sim.world.projectiles.size).toBe(0);
    // damage bonuses
    const bh = add(sim, 3, 'brute');
    expect(turretDamageMultFor(t, bh)).toBeCloseTo(1, 6);
    bh.upgrades['path:bulwark'] = 1;
    expect(turretDamageMultFor(t, bh)).toBeCloseTo(1.25, 6);
    host.upgrades['path:architect'] = 1; host.upgrades.arc_turretbay = 1;
    expect(turretDamageMultFor(t, host)).toBeCloseTo(1.3, 6);
  });

  it('brace reduces host damage; hull weld transfers energy', () => {
    const sim = freshSim();
    const host = add(sim, 1, 'tech'), br = add(sim, 2, 'brute'), wd = add(sim, 3, 'engineer');
    sim.step();
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.setInput(3, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(host.turrets.length).toBe(2);
    sim.setInput(2, inp({ secondary: true }));
    sim.step();
    host.invulnUntilTick = 0;
    const e0 = host.energy;
    damageShip(sim.world, host, 400, 0, 'enemy');
    expect(e0 - host.energy).toBeCloseTo(400 * (1 - br.stats.skill.braceAbsorb), 6);
    sim.setInput(2, inp());
    host.energy = 200; host.stats.rechargePerSec = 0;
    sim.setInput(3, inp({ secondary: true }));
    steps(sim, 60);
    expect(host.energy).toBeGreaterThan(200 + wd.stats.skill.weldPerSec * 0.9);
    expect(wd.skillState.beamKind).toBe(2);
  });
});

describe('stress', () => {
  it('32 ships (all skills/talents) + 350 enemies + ~1400 projectiles < 4 ms/tick, deterministic', () => {
    const run = () => {
      const sim = freshSim({ teamCount: 4, mapSeed: 9 });
      const w = sim.world;
      const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
      for (let i = 1; i <= 32; i++) {
        const s = add(sim, i, cls[i % 3], i % 4);
        // every path + talent of the class, to exercise all code paths at once
        for (const p of SHIP_CLASSES[s.shipClass].paths) { s.upgrades['path:' + p.id] = 1; for (const t of p.talents) s.upgrades[t.id] = 1; }
      }
      const open: [number, number][] = [];
      for (let r = 0; r < w.map.rows; r++) for (let c = 0; c < w.map.cols; c++) {
        if (w.map.tiles[r * w.map.cols + c] === TILE_EMPTY) open.push([(c + 0.5) * MAP_TILE, (r + 0.5) * MAP_TILE]);
      }
      for (let i = 0; i < 350; i++) { const [x, y] = open[w.rng.int(0, open.length - 1)]; mkEnemy(sim, x, y, 1e9, 12); }
      let total = 0, n = 0, worst = 0;
      for (let k = 0; k < 400; k++) {
        for (let i = 1; i <= 32; i++) {
          const a = (k * 0.013 + i * 1.7) % 6.283;
          sim.setInput(i, inp({ seq: k, moveX: Math.cos(a), moveY: Math.sin(a), aim: a * 1.3, aimDist: 250,
            primary: true, secondary: k % 3 === 0, mobility: k % 45 === i % 45, utility: k % 70 === i % 70,
            afterburner: k % 50 < 10, attach: k % 120 === 5, detach: k % 120 === 100 }));
        }
        while (w.projectiles.size < 1400) {
          const [x, y] = open[w.rng.int(0, open.length - 1)];
          const a = w.rng.next() * 6.283;
          spawnProjectile(w, { ...projectileDefaults(w), kind: 'enemyShot', ownerId: 0, ownerPlayerId: 0, ownerTeam: ENEMY_TEAM,
            x, y, vx: Math.cos(a) * 500, vy: Math.sin(a) * 500, damage: 1, radius: 4, expireTick: w.tick + 60 });
        }
        const t0 = performance.now();
        sim.step();
        const dt = performance.now() - t0;
        sim.drainEvents();
        if (k > 50) { total += dt; n++; worst = Math.max(worst, dt); }
      }
      const sig = [...w.ships.values()].map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.energy.toFixed(1)}`).join('|');
      return { avg: total / n, worst, sig, deps: w.deployables.size, proj: w.projectiles.size };
    };
    const a = run(), b = run();
    console.log(`stress avg ${a.avg.toFixed(3)} ms/tick, worst ${a.worst.toFixed(2)} ms, deployables ${a.deps}, proj ${a.proj}`);
    expect(a.sig).toBe(b.sig);
    expect(a.avg).toBeLessThan(4);
  });
});

describe('talents', () => {
  function give(s: Ship, path: string, ...talents: string[]): void {
    s.upgrades['path:' + path] = 1;
    for (const t of talents) s.upgrades[t] = 1;
  }

  it('lan_rail: every 5th primary is a 4x piercing rail bolt', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const t = add(sim, 1, 'tech');
    give(t, 'lance', 'lan_rail');
    place(t, x, y);
    sim.setInput(1, inp({ primary: true }));
    const shots: { dmg: number; pierce: number }[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < 60 && shots.length < 5; i++) {
      place(t, x, y); t.energy = t.stats.maxEnergy;
      sim.step();
      for (const p of sim.world.projectiles.values()) if (p.kind === 'plasma' && !seen.has(p.id)) { seen.add(p.id); shots.push({ dmg: p.damage, pierce: p.pierce }); }
    }
    expect(shots.length).toBeGreaterThanOrEqual(5);
    expect(shots[4].dmg).toBeCloseTo(shots[0].dmg * 4, 6);
    expect(shots[4].pierce).toBeGreaterThan(100);
    expect(shots[3].pierce).toBe(0);
  });

  it('voi_entropy (+30% inside wells) and voi_collapse (explodes on expiry)', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const t = add(sim, 1, 'tech');
    give(t, 'void', 'voi_entropy', 'voi_collapse');
    place(t, x, y);
    const e = mkEnemy(sim, x + 300, y + 60, 1e6);
    sim.setInput(1, inp({ utility: true, aim: 0, aimDist: 300 }));
    for (let i = 0; i < 30; i++) { place(t, x, y); sim.step(); }
    expect([...sim.world.deployables.values()].some((d) => d.kind === 'well')).toBe(true);
    const hp0 = e.hp;
    damageEnemy(sim.world, e, 100, 0);
    expect(hp0 - e.hp).toBeCloseTo(130, 6);
    sim.drainEvents();
    const hpBefore = e.hp;
    for (let i = 0; i < 60 * 4; i++) { place(t, x, y); sim.step(); }
    expect([...sim.world.deployables.values()].some((d) => d.kind === 'well')).toBe(false);
    const ev = sim.drainEvents();
    expect(ev.some((v) => v.t === 'nova')).toBe(true);
    expect(ev.some((v) => v.t === 'deployDeath' && v.kind === 'well')).toBe(true);
    expect(hpBefore - e.hp).toBeGreaterThan(300); // core dps + collapse
  });

  it('sum_salvage: destroyed sentry explodes and refunds energy', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const en = add(sim, 1, 'engineer');
    give(en, 'summoner', 'sum_salvage', 'sum_overclock');
    place(en, x, y);
    sim.setInput(1, inp({ secondary: true }));
    sim.step();
    sim.setInput(1, inp());
    const sentry = [...sim.world.deployables.values()].find((d) => d.kind === 'sentry')!;
    expect(sentry.mem.volley).toBe(2);
    const e = mkEnemy(sim, sentry.x + 60, sentry.y, 1e6);
    place(en, x - 400, y);
    en.energy = 100;
    sentry.hp = 0; // e.g. PVE contact damage
    sim.drainEvents();
    sim.step();
    expect(sim.world.deployables.has(sentry.id)).toBe(false);
    expect(en.energy).toBeGreaterThan(100 + 0.3 * en.stats.secondaryCost - 1);
    expect(1e6 - e.hp).toBeGreaterThan(100);
  });

  it('ram_unstoppable: immune while charging, travels farther', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim, 900);
    const b = add(sim, 1, 'brute');
    give(b, 'ram', 'ram_unstoppable');
    place(b, x, y);
    sim.setInput(1, inp({ mobility: true, aim: 0 }));
    sim.step();
    const e0 = b.energy;
    damageShip(sim.world, b, 500, 0, 'enemy');
    expect(b.energy).toBe(e0);
    sim.setInput(1, inp({ aim: 0 }));
    steps(sim, 60);
    const sk = b.stats.skill;
    expect(b.x - x).toBeGreaterThan(sk.chargeSpeed * sk.chargeTime * 1.4);
  });

  it('med_beam heals the lowest ally and emits beam events', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const m = add(sim, 1, 'engineer'), a = add(sim, 2, 'brute'), b = add(sim, 3, 'tech');
    give(m, 'medic', 'med_beam');
    place(m, x, y); place(a, x + 100, y); place(b, x + 150, y);
    a.energy = 900; b.energy = 200; a.stats.rechargePerSec = 0; b.stats.rechargePerSec = 0;
    sim.drainEvents();
    steps(sim, 30);
    const ev = sim.drainEvents();
    expect(ev.some((v) => v.t === 'beam' && v.fromId === m.id && v.toId === b.id)).toBe(true);
    expect(b.energy).toBeGreaterThan(200 + 120 * 0.45);
    expect(a.energy).toBe(900);
  });

  it('arc_reinforced walls reflect hostile projectiles', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const en = add(sim, 1, 'engineer');
    give(en, 'architect', 'arc_reinforced');
    place(en, x, y);
    sim.setInput(1, inp({ utility: true, aim: 0, aimDist: 150 }));
    sim.step();
    const w = sim.world;
    const shot = spawnProjectile(w, {
      ...projectileDefaults(w), kind: 'enemyShot', ownerId: 9999, ownerPlayerId: 0, ownerTeam: ENEMY_TEAM,
      x: x + 300, y, vx: -600, vy: 0, damage: 50, radius: 5, expireTick: w.tick + 600,
    })!;
    for (let i = 0; i < 25; i++) { place(en, x, y); sim.step(); }
    expect(w.projectiles.has(shot.id)).toBe(true);
    expect(shot.vx).toBeGreaterThan(0);
    expect(shot.ownerId).toBe(en.id);
  });

  it('bul_fortress shields nearby allies; sto_static shocks nearby hostiles', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const b = add(sim, 1, 'brute'), ally = add(sim, 2, 'engineer');
    give(b, 'bulwark', 'bul_fortress');
    place(b, x, y); place(ally, x + 120, y);
    sim.setInput(1, inp({ utility: true }));
    sim.step();
    expect(ally.flags & 8).toBeTruthy();
    const e0 = ally.energy;
    damageShip(sim.world, ally, 1000, 0, 'enemy');
    expect(e0 - ally.energy).toBeCloseTo(1000 * (1 - b.stats.skill.hideAbsorb), 3);

    const s2 = freshSim();
    const o = openArea(s2);
    const t = add(s2, 1, 'tech');
    give(t, 'storm', 'sto_static');
    place(t, o.x, o.y);
    const e = mkEnemy(s2, o.x + 150, o.y, 1e6);
    steps(s2, 50);
    expect(1e6 - e.hp).toBeGreaterThanOrEqual(60);
    expect(s2.drainEvents().some((v) => v.t === 'arc')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// v0.2 review fixes (regressions)
// ---------------------------------------------------------------------------------------------
import { DOT_TICKS, deployFire, deploySentry, deployWell } from './deployables';
import { INPUT_DRAIN_WINDOW, MAX_INPUT_QUEUE } from './Sim';
import { DT, MAX_PROJECTILES } from '../constants';
import type { GameEvent } from '../types';

const hitsOn = (ev: GameEvent[], id: number) => ev.filter((v) => v.t === 'hit' && v.targetId === id).length;

describe('F1: piercing projectiles hit each body at most once', () => {
  function bolt(sim: Sim, owner: Ship, x: number, y: number, pierce: number, speed = 1250) {
    const w = sim.world;
    return spawnProjectile(w, {
      ...projectileDefaults(w), kind: 'plasma', ownerId: owner.id, ownerPlayerId: owner.playerId, ownerTeam: owner.team,
      x, y, vx: speed, vy: 0, damage: 100, radius: 5, expireTick: w.tick + 120, pierce,
    })!;
  }

  it('rail-style bolt through overlapping bodies (hive+drone, brute+splitter, ship+enemy)', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const a = add(sim, 1, 'tech', 0);
    place(a, x - 150, y + 100);
    const big = mkEnemy(sim, x + 200, y, 1e6, 70); // hive-sized
    const small = mkEnemy(sim, x + 215, y, 1e6, 13); // a drone inside it
    const foe = add(sim, 2, 'brute', 1);
    const e2 = mkEnemy(sim, x + 380, y, 1e6, 34);
    sim.step();
    place(foe, x + 395, y); // a hostile ship overlapping an enemy
    sim.drainEvents();
    bolt(sim, a, x, y, 999);
    const ev: GameEvent[] = [];
    for (let i = 0; i < 40; i++) { place(a, x - 150, y + 100); place(foe, x + 395, y); sim.step(); ev.push(...sim.drainEvents()); }
    expect(hitsOn(ev, big.id)).toBe(1);
    expect(hitsOn(ev, small.id)).toBe(1);
    expect(hitsOn(ev, e2.id)).toBe(1);
    expect(hitsOn(ev, foe.id)).toBe(1);
  });

  it('pierce N hits N+1 distinct bodies (even several within one step), then stops', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const a = add(sim, 1, 'tech');
    place(a, x - 150, y + 100);
    // three drones 12 px apart: a 3000 px/s bolt (50 px/step) sweeps all three in one step
    const d = [mkEnemy(sim, x + 100, y, 1e6, 13), mkEnemy(sim, x + 112, y, 1e6, 13), mkEnemy(sim, x + 124, y, 1e6, 13)];
    const far = mkEnemy(sim, x + 300, y, 1e6, 13);
    sim.step(); sim.drainEvents();
    const p = bolt(sim, a, x + 60, y, 2, 3000);
    sim.step();
    const ev = sim.drainEvents();
    for (const e of d) expect(hitsOn(ev, e.id)).toBe(1);
    expect(sim.world.projectiles.has(p.id)).toBe(false);
    steps(sim, 10);
    expect(hitsOn(sim.drainEvents(), far.id)).toBe(0);
  });
});

describe('NET-4: queued inputs (one per tick, no lost edges)', () => {
  const blinks = (sim: Sim) => sim.drainEvents().filter((v) => v.t === 'blink').length;

  it('a burst of inputs is replayed one per tick: the tap survives and ackSeq steps by one', () => {
    const sim = freshSim();
    const t = add(sim, 1, 'tech');
    sim.step(); sim.drainEvents();
    sim.setInput(1, inp({ seq: 1, mobility: true, moveX: 1 }));
    for (let k = 2; k <= 4; k++) sim.setInput(1, inp({ seq: k, moveX: 1 }));
    expect(sim.pendingInputs(1)).toBe(4);
    let b = 0;
    for (let k = 1; k <= 4; k++) {
      sim.step();
      expect(t.lastInputSeq).toBe(k);
      b += blinks(sim);
    }
    expect(b).toBe(1);
    expect(sim.pendingInputs(1)).toBe(0);
    sim.step(); // empty queue: hold the last input
    expect(t.lastInputSeq).toBe(4);
    expect(t.input.moveX).toBe(1);
    expect(t.input.mobility).toBe(false);
  });

  it('overflow drops inputs but never a press (lossless skip, else OR-fold)', () => {
    for (const alternate of [false, true]) {
      const sim = freshSim();
      const t = add(sim, 1, 'tech');
      sim.step(); sim.drainEvents();
      // alternate=true: every neighbour differs (primary toggles) so the oldest gets OR-folded forward
      for (let k = 1; k <= 14; k++) sim.setInput(1, inp({ seq: k, mobility: k === (alternate ? 1 : 3), primary: alternate && k % 2 === 0 }));
      expect(sim.pendingInputs(1)).toBe(MAX_INPUT_QUEUE);
      let b = 0, last = 0;
      for (let i = 0; i < 12; i++) {
        sim.step();
        expect(t.lastInputSeq).toBeGreaterThanOrEqual(last);
        last = t.lastInputSeq;
        b += blinks(sim);
      }
      expect(b).toBe(1);
      expect(t.lastInputSeq).toBe(14);
    }
  });

  it('a standing surplus (after a stall) is drained without losing a tap', () => {
    const sim = freshSim();
    const t = add(sim, 1, 'tech');
    sim.step(); sim.drainEvents();
    let seq = 0;
    for (let k = 0; k < 6; k++) sim.setInput(1, inp({ seq: ++seq, moveX: 1 })); // stall: 6 arrive at once
    let b = 0, last = 0;
    for (let i = 0; i < INPUT_DRAIN_WINDOW * 4; i++) {
      seq++;
      sim.setInput(1, inp({ seq, moveX: 1, mobility: seq === INPUT_DRAIN_WINDOW + 5 }));
      sim.step();
      expect(t.lastInputSeq).toBeGreaterThanOrEqual(last);
      last = t.lastInputSeq;
      b += blinks(sim);
    }
    expect(b).toBe(1);
    expect(sim.pendingInputs(1)).toBe(0); // latency back to zero
    expect(t.lastInputSeq).toBe(seq);
  });
});

describe('F2: mutual Reflectors', () => {
  it('a victim killed by its own reflected damage dies (and scores) exactly once', () => {
    const sim = freshSim();
    const a = add(sim, 1, 'brute', 0), b = add(sim, 2, 'brute', 1);
    for (const s of [a, b]) {
      s.upgrades['path:bulwark'] = 1; s.upgrades.bul_reflect = 1;
      s.utilityActiveUntilTick = sim.world.tick + 600; s.skillState.hide = 1;
    }
    sim.drainEvents();
    a.energy = 5;
    const bounty = a.bounty;
    damageShip(sim.world, a, 300, b.id, 'player');
    expect(a.alive).toBe(false);
    expect(a.deaths).toBe(1);
    expect(b.kills).toBe(1);
    expect(b.score).toBe(10 + bounty);
    expect(sim.drainEvents().filter((e) => e.t === 'shipDeath').length).toBe(1);
  });
});

describe('F4: administrative deployable removal has no death effects', () => {
  function salvageRig() {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const en = add(sim, 1, 'engineer', 0), foe = add(sim, 2, 'brute', 1);
    en.upgrades['path:summoner'] = 1; en.upgrades.sum_salvage = 1;
    place(en, x, y);
    const sentry = deploySentry(sim.world, en)!;
    expect(sentry.mem.salvage).toBeGreaterThan(0);
    place(foe, x + 60, y);
    sim.drainEvents();
    return { sim, en, foe, sentry };
  }

  it('team switch / class switch / leaving: no Salvage blast, no credit', () => {
    for (const how of ['team', 'class', 'leave'] as const) {
      const { sim, en, foe, sentry } = salvageRig();
      const e0 = foe.energy, s0 = en.score;
      if (how === 'team') sim.setPlayerTeam(1, 1);
      else if (how === 'class') sim.setShipClass(1, 'tech');
      else sim.removePlayer(1);
      const ev = sim.drainEvents();
      expect(sim.world.deployables.has(sentry.id)).toBe(false);
      expect(ev.some((v) => v.t === 'deployDeath' && v.id === sentry.id)).toBe(true);
      expect(ev.some((v) => v.t === 'explode')).toBe(false);
      expect(foe.energy).toBe(e0);
      expect(en.score).toBe(s0);
    }
  });

  it('leaving with a Collapse well: no nova; a sentry replaced at the cap still blows (intended)', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const t = add(sim, 1, 'tech', 0), foe = add(sim, 2, 'brute', 1);
    t.upgrades['path:void'] = 1; t.upgrades.voi_collapse = 1;
    const well = deployWell(sim.world, { ownerId: t.id, ownerPlayerId: t.playerId, team: t.team }, x + 100, y, 120, false)!;
    expect(well.mem.collapse).toBeGreaterThan(0);
    place(foe, x + 100, y);
    sim.drainEvents();
    const e0 = foe.energy;
    sim.removePlayer(1);
    expect(sim.drainEvents().some((v) => v.t === 'nova')).toBe(false);
    expect(foe.energy).toBe(e0);

    const { sim: s2, en } = salvageRig();
    const max = en.stats.skill.sentryMax;
    for (let i = 1; i < max; i++) deploySentry(s2.world, en);
    s2.drainEvents();
    deploySentry(s2.world, en); // replaces the oldest
    expect(s2.drainEvents().some((v) => v.t === 'explode')).toBe(true);
  });
});

describe('F5: laser damage bank belongs to one target', () => {
  function rig() {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    place(host, x, y, 0);
    host.stats.rechargePerSec = 0;
    sim.step();
    sim.setInput(2, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(t.attachedTo).toBe(host.id);
    place(host, x, y, 0);
    sim.step();
    const A = mkEnemy(sim, t.x + 250, t.y, 1e6, 20), B = mkEnemy(sim, t.x + 400, t.y, 1e6, 20);
    const unit = t.stats.skill.laserDps * DT * turretDamageMultFor(t, host);
    const fire = (primary: boolean) => sim.setInput(2, inp({ primary, aim: 0 }));
    t.angle = 0;
    return { sim, host, t, A, B, unit, fire };
  }
  const toAfterApply = (sim: Sim) => { while (sim.world.tick % 6 !== 0) sim.step(); };

  it('beam moving from A to B pays A what it dealt, B only its own', () => {
    const { sim, host, A, B, unit, fire } = rig();
    fire(false);
    toAfterApply(sim);
    fire(true);
    const a0 = A.hp;
    steps(sim, 3); // 3 ticks on A (banked, not yet applied)
    host.energy = host.stats.maxEnergy;
    A.y += 300; // A leaves the beam; B is next on the line
    sim.step(); // tick %6 == 4: switch -> A's bank is paid to A
    expect(a0 - A.hp).toBeCloseTo(3 * unit, 6);
    const b0 = B.hp;
    steps(sim, 2); // ticks 5, 6 (apply)
    expect(b0 - B.hp).toBeCloseTo(3 * unit, 6);
  });

  it('release pays the bank out immediately; nothing stale survives a detach', () => {
    const { sim, t, A, unit, fire } = rig();
    fire(false);
    toAfterApply(sim);
    fire(true);
    const a0 = A.hp;
    steps(sim, 2);
    fire(false);
    sim.step();
    expect(a0 - A.hp).toBeCloseTo(2 * unit, 6);
    expect(t.skillState.laserAcc ?? 0).toBe(0);
    // bank some, then detach: bank dropped
    toAfterApply(sim);
    fire(true);
    steps(sim, 2);
    expect(t.skillState.laserAcc).toBeGreaterThan(0);
    sim.setInput(2, inp({ detach: true }));
    sim.step();
    expect(t.attachedTo).toBe(0);
    expect(t.skillState.laserAcc ?? 0).toBe(0);
  });
});

describe('F8: DoT zones spawned by projectiles get every pulse', () => {
  it('napalm deals its full 2 s of damage; a thrown singularity core its full duration', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const b = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    place(b, x - 150, y - 100); place(t, x - 150, y + 100);
    const e1 = mkEnemy(sim, x, y, 1e6), e2 = mkEnemy(sim, x + 450, y, 1e6); // well pull radius 280 < 450
    sim.step();
    // created between steps == created inside stepProjectiles (after stepDeployables) of that tick
    const fire = deployFire(sim.world, { ownerId: b.id, ownerPlayerId: b.playerId, team: b.team }, e1.x, e1.y, 1)!;
    const well = deployWell(sim.world, { ownerId: t.id, ownerPlayerId: t.playerId, team: t.team }, e2.x, e2.y, 120, false)!;
    for (let i = 0; i < 200; i++) { place(b, x - 150, y - 100); place(t, x - 150, y + 100); sim.step(); }
    expect(sim.world.deployables.has(fire.id)).toBe(false);
    expect(sim.world.deployables.has(well.id)).toBe(false);
    const pulses = (d: { spawnTick: number; expireTick: number }) => (d.expireTick - d.spawnTick) / DOT_TICKS;
    expect(1e6 - e1.hp).toBeCloseTo(fire.power * DOT_TICKS * DT * pulses(fire), 6); // 80 dps x 2 s = 160
    expect(1e6 - e2.hp).toBeCloseTo(120 * DOT_TICKS * DT * pulses(well), 6); // 120 dps x 3 s = 360
  });
});

describe('F9: nothing is spent when the projectile cap refuses the shot', () => {
  it('primary / singularity / rocket salvo at MAX_PROJECTILES', () => {
    const sim = freshSim();
    const { x, y } = openArea(sim);
    const w = sim.world;
    const t = add(sim, 1, 'tech'), br = add(sim, 2, 'brute');
    place(t, x, y, Math.PI); place(br, x, y + 60, Math.PI);
    t.stats.rechargePerSec = 0; br.stats.rechargePerSec = 0;
    sim.step();
    const fill = () => {
      while (w.projectiles.size < MAX_PROJECTILES) {
        spawnProjectile(w, { ...projectileDefaults(w), kind: 'enemyShot', ownerId: 0, ownerPlayerId: 0, ownerTeam: ENEMY_TEAM,
          x: x + 520, y: y + 110, vx: 0, vy: 0, damage: 1, radius: 1, expireTick: w.tick + 6000 });
      }
    };
    fill();
    const te = t.energy, be = br.energy, gun = t.gunReadyTick, util = t.utilityReadyTick;
    sim.setInput(1, inp({ primary: true, utility: true, aim: Math.PI }));
    sim.setInput(2, inp({ secondary: true, aim: Math.PI }));
    sim.drainEvents();
    sim.step();
    expect(t.energy).toBe(te);
    expect(br.energy).toBe(be);
    expect(t.gunReadyTick).toBe(gun);
    expect(t.utilityReadyTick).toBe(util);
    expect(sim.drainEvents().some((v) => v.t === 'fire' || v.t === 'ability')).toBe(false);
    // room again -> the held buttons fire and pay (the salvo retries after its short no-target delay)
    for (const p of [...w.projectiles.values()].slice(0, 50)) w.projectiles.delete(p.id);
    steps(sim, 8);
    expect(t.energy).toBeLessThan(te);
    expect(br.energy).toBeLessThan(be);
  });
});
