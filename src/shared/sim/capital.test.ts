// SIM v0.5 acceptance: hardpoints + capital ships (ARCHITECTURE.md "Hardpoints + capital ships (v0.5)").
// Hardpoint layout per turret count and its re-flow, the capital hull (radius × capitalScale, armor per turret) and
// its exact reversal, hits on the bigger hull, the bubble-dome hitbox of a docked turret, the three capital skills,
// Space = capital skill only while hosting, the MAX_HARDPOINTS cap, and friendly-fire crew safety. Real PVE, no mocks.
import { describe, expect, it } from 'vitest';
import {
  CAPITAL_ARMOR_PER_TURRET, DT, HARDPOINT_SEAT, LASER_RESONANCE, MAX_HARDPOINTS, TICK_RATE, TURRET_BUBBLE_RADIUS,
} from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import { SnapshotBuilder } from '../room/snapshot';
import type { GameEvent, InputState, Ship, ShipClassId, SimConfig } from '../types';
import { BEAM_LASER, emptyInput, SHIPFLAG_SHIELD } from '../types';
import {
  BROADSIDE_FOCUS_MAX, BROADSIDE_FOCUS_MIN, BROADSIDE_FOCUS_SPREAD, BROADSIDE_RADIUS, OVERCHARGE_END, overchargeBonus,
} from './capital';
import { damageShip, splashDamage } from './combat';
import { baseRadiusOf, isCapital } from './hull';
import { collideCircle, isSolidAt } from './map';
import { spawnEnemy } from './pve/enemies';
import { recomputeShipStats } from './pve/index';
import { buildOffer } from './pve/xp';
import { computeStats } from './pve/upgrades';
import { Sim } from './Sim';
import { firstHitOnSegment, found } from './targeting';
import { resonanceFactor } from './turretkits';
import { detachTurret, tryAttach } from './turrets';
import { capitalScale, HARDPOINT_LAYOUT, projectileDefaults, rebuildGrid, spawnProjectile, turretOffset } from './world';

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 1234, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0,
  friendlyFire: false, ...o,
});
const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), ...o });
function add(sim: Sim, pid: number, cls: ShipClassId, team = 0): Ship {
  const s = sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team, shipClass: cls, isBot: false }))!;
  s.invulnUntilTick = 0;
  return s;
}
function steps(sim: Sim, n: number): void { for (let i = 0; i < n; i++) sim.step(); }
function place(s: Ship, x: number, y: number, angle = 0): void { s.x = x; s.y = y; s.vx = 0; s.vy = 0; s.angle = angle; }
/** A point with no solid tile within ±hw × ±hh px. */
function openArea(sim: Sim, hw = 480, hh = 400): { x: number; y: number } {
  const m = sim.world.map;
  for (let y = hh + 200; y < m.height - hh - 200; y += 32) {
    for (let x = hw + 200; x < m.width - hw - 200; x += 32) {
      let ok = true;
      for (let dy = -hh; dy <= hh && ok; dy += 16) for (let dx = -hw; dx <= hw && ok; dx += 16) if (isSolidAt(m, x + dx, y + dy)) ok = false;
      if (ok) return { x, y };
    }
  }
  throw new Error('no open area');
}
/** Dock each turret on `host` through the real attach press (one tick each), then release the button. */
function dock(sim: Sim, host: Ship, ...ts: Ship[]): void {
  for (const t of ts) {
    sim.setInput(t.playerId, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(t.attachedTo).toBe(host.id);
    sim.setInput(t.playerId, inp());
  }
  sim.step();
}
/** Press Space (a rising edge on the next tick), then release it (one more tick). Returns both ticks' events. */
function space(sim: Sim, s: Ship, o: Partial<InputState> = {}): GameEvent[] {
  sim.drainEvents();
  sim.setInput(s.playerId, inp({ ...o, mobility: true }));
  sim.step();
  sim.setInput(s.playerId, inp(o));
  sim.step();
  return sim.drainEvents();
}
const abilities = (ev: GameEvent[], shipId: number) =>
  ev.filter((e): e is Extract<GameEvent, { t: 'ability' }> => e.t === 'ability' && e.shipId === shipId);

/** A brute host (Bulwark path: 5 slots) in the open, facing east, with rigged turrets. */
function hostRig(turretClasses: ShipClassId[] = ['tech', 'engineer', 'brute', 'tech', 'engineer']) {
  const sim = new Sim(cfg());
  const { x, y } = openArea(sim);
  const host = add(sim, 1, 'brute');
  host.upgrades['path:bulwark'] = 1;
  host.path = 'bulwark';
  host.stats = computeStats('brute', host.upgrades);
  host.energy = host.stats.maxEnergy;
  place(host, x, y, 0);
  const ts = turretClasses.map((c, i) => add(sim, 10 + i, c));
  sim.step();
  place(host, x, y, 0);
  return { sim, host, ts, x, y };
}

// ---------------------------------------------------------------------------------------------
describe('hardpoints: layout per turret count and re-flow', () => {
  it('slot i of n sits at HARDPOINT_LAYOUT[n][i] on the capital-scaled hull; hull and armor grow per turret', () => {
    const { sim, host, ts } = hostRig();
    const base = computeStats('brute', host.upgrades);
    expect(host.stats.maxTurrets).toBe(MAX_HARDPOINTS);
    for (let n = 1; n <= MAX_HARDPOINTS; n++) {
      dock(sim, host, ts[n - 1]);
      expect(host.turrets).toEqual(ts.slice(0, n).map((t) => t.id));
      expect(isCapital(host)).toBe(true);
      const R = base.radius * capitalScale(n);
      expect(host.stats.radius).toBeCloseTo(R, 9);
      expect(baseRadiusOf(host)).toBe(base.radius);
      expect(host.stats.armor).toBeCloseTo(Math.min(0.6, base.armor + CAPITAL_ARMOR_PER_TURRET * n), 9);
      for (let i = 0; i < n; i++) {
        const t = ts[i];
        const o = turretOffset(host.angle, i, n, host.stats.radius);
        expect(t.x - host.x).toBeCloseTo(o.dx, 6);
        expect(t.y - host.y).toBeCloseTo(o.dy, 6);
        // facing east: along = +x, starboard = +y, at HARDPOINT_SEAT of the effective radius
        const [along, side] = HARDPOINT_LAYOUT[n][i];
        expect(host.angle).toBeCloseTo(0, 9);
        expect(t.x - host.x).toBeCloseTo(along * HARDPOINT_SEAT * R, 6);
        expect(t.y - host.y).toBeCloseTo(side * HARDPOINT_SEAT * R, 6);
        expect(t.stats.radius).toBe(TURRET_BUBBLE_RADIUS);
      }
    }
    // 1 → bow, 5 → bow + fore P/S + aft P/S: three mounts ahead of the beam, two behind (the owner's "3 front, 2 back")
    expect(HARDPOINT_LAYOUT[5].filter(([a]) => a > 0).length).toBe(3);
    expect(HARDPOINT_LAYOUT[5].filter(([a]) => a < 0).length).toBe(2);
  });

  it('mounts re-flow at once when a turret leaves or joins, and the hull shrinks back exactly', () => {
    const { sim, host, ts } = hostRig(['tech', 'engineer', 'brute']);
    const w = sim.world;
    const base = computeStats('brute', host.upgrades);
    dock(sim, host, ...ts);
    const [a, b, c] = ts;
    // the middle turret leaves (no step): the other two jump to the 2-turret mounts now, the hull shrinks now
    detachTurret(w, b);
    expect(host.turrets).toEqual([a.id, c.id]);
    expect(host.stats.radius).toBeCloseTo(base.radius * capitalScale(2), 9);
    expect(b.stats.radius).toBe(SHIP_CLASSES.engineer.base.radius);
    for (const [i, t] of [a, c].entries()) {
      const o = turretOffset(host.angle, i, 2, host.stats.radius);
      expect(t.x - host.x).toBeCloseTo(o.dx, 6);
      expect(t.y - host.y).toBeCloseTo(o.dy, 6);
    }
    // it re-joins (a tryAttach, no step): three mounts again, c keeps slot 1, b takes the aft mount
    b.input.attachTarget = host.id;
    b.attachReadyTick = 0;
    expect(tryAttach(w, b)).toBe(true);
    expect(host.turrets).toEqual([a.id, c.id, b.id]);
    expect(host.stats.radius).toBeCloseTo(base.radius * capitalScale(3), 9);
    const o = turretOffset(host.angle, 2, 3, host.stats.radius);
    expect(b.x - host.x).toBeCloseTo(o.dx, 6);
    expect(b.y - host.y).toBeCloseTo(o.dy, 6);
    expect(b.stats.radius).toBe(TURRET_BUBBLE_RADIUS);
    // a turret dies: the host shrinks and the survivors re-flow
    damageShip(w, c, 1e9, 0, 'enemy');
    expect(c.alive).toBe(false);
    expect(host.turrets).toEqual([a.id, b.id]);
    expect(host.stats.radius).toBeCloseTo(base.radius * capitalScale(2), 9);
    expect(c.stats.radius).toBe(SHIP_CLASSES.brute.base.radius);
    // the host dies: every turret is shed, all hulls are plain again, bit for bit
    damageShip(w, host, 1e9, 0, 'enemy');
    expect(host.turrets).toEqual([]);
    expect(host.stats).toEqual(base);
    for (const t of ts) expect(t.stats).toEqual(computeStats(t.shipClass, t.upgrades));
  });

  it('a stats rebuild while hosting keeps the capital hull; the rebuilt stats are the new base', () => {
    const { sim, host, ts } = hostRig(['tech', 'tech']);
    dock(sim, host, ts[0], ts[1]);
    host.upgrades.bul_titan = 1; // hull +15%
    recomputeShipStats(host);
    const base = computeStats('brute', host.upgrades);
    expect(host.stats.radius).toBeCloseTo(base.radius * capitalScale(2), 9);
    expect(host.stats.armor).toBeCloseTo(base.armor + 2 * CAPITAL_ARMOR_PER_TURRET, 9);
    recomputeShipStats(ts[0]); // a docked turret's rebuild keeps its dome
    expect(ts[0].stats.radius).toBe(TURRET_BUBBLE_RADIUS);
    // a plain copy of an adjusted stats object keeps the cached base (it is not mistaken for a rebuild)
    ts[1].stats = { ...ts[1].stats, magnetRadius: 0 };
    sim.step();
    expect(ts[1].stats.radius).toBe(TURRET_BUBBLE_RADIUS);
    sim.setInput(1, inp({ detach: true }));
    sim.step();
    expect(host.turrets).toEqual([]);
    expect(host.stats).toEqual(base);
    expect(ts[0].stats).toEqual(computeStats('tech', ts[0].upgrades));
    expect(ts[1].stats).toEqual({ ...computeStats('tech', ts[1].upgrades), magnetRadius: 0 });
  });

  it('an in-place class swap sheds the turrets: the new class\'s plain hull; a running Overcharge ends with its event', () => {
    const sim = new Sim(cfg({ gameType: 'arena' }));
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'tech'), t = add(sim, 2, 'engineer');
    place(host, x, y, 0);
    dock(sim, host, t);
    space(sim, host);
    expect(host.skillState.overchargeUntil).toBeGreaterThan(sim.world.tick);
    sim.drainEvents();
    sim.setShipClass(1, 'brute');
    expect(host.alive).toBe(true);
    expect(host.turrets).toEqual([]);
    expect(host.stats).toEqual(computeStats('brute', host.upgrades));
    expect(t.stats).toEqual(computeStats('engineer', t.upgrades));
    expect(host.skillState.overchargeUntil).toBeUndefined();
    expect(abilities(sim.drainEvents(), host.id).filter((e) => e.talent === OVERCHARGE_END).length).toBe(1);
  });

  it('death ends the capital effects (Repair Bay stops, Overcharge emits its end)', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const fo = add(sim, 1, 'engineer'), sp = add(sim, 2, 'tech'), a = add(sim, 3, 'brute'), b = add(sim, 4, 'tech');
    place(fo, x, y, 0);
    place(sp, x + 300, y, 0);
    dock(sim, fo, a);
    dock(sim, sp, b);
    space(sim, fo);
    space(sim, sp);
    expect(fo.skillState.bayUntil).toBeGreaterThan(w.tick);
    expect(sp.skillState.overchargeUntil).toBeGreaterThan(w.tick);
    sim.drainEvents();
    damageShip(w, fo, 1e9, 0, 'enemy');
    damageShip(w, sp, 1e9, 0, 'enemy');
    sim.step();
    expect(fo.skillState.bayUntil).toBeUndefined();
    expect(sp.skillState.overchargeUntil).toBeUndefined();
    expect(abilities(sim.drainEvents(), sp.id).filter((e) => e.talent === OVERCHARGE_END).length).toBe(1);
  });

  it('safety net: a direct change of host.turrets (CTF gunner seat, tests) is synced on the next step', () => {
    const { sim, host, ts } = hostRig(['tech']);
    const t = ts[0];
    t.attachedTo = host.id;
    host.turrets.push(t.id);
    sim.step();
    expect(host.stats.radius).toBeCloseTo(computeStats('brute', host.upgrades).radius * capitalScale(1), 9);
    expect(t.stats.radius).toBe(TURRET_BUBBLE_RADIUS);
  });

  it('a hull that grows beside a wall is pushed out of it once', () => {
    const sim = new Sim(cfg());
    const w = sim.world, m = w.map;
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    const R0 = host.stats.radius, R1 = R0 * capitalScale(1);
    let spot: { x: number; y: number } | null = null;
    for (let y = 600; y < m.height - 600 && !spot; y += 8) {
      for (let x = 600; x < m.width - 600 && !spot; x += 8) {
        if (!collideCircle(m, x, y, R0 + 0.5).hit && collideCircle(m, x, y, R1 - 1).hit) spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();
    place(host, spot!.x, spot!.y, 0);
    rebuildGrid(w);
    t.input.attachTarget = host.id;
    expect(tryAttach(w, t)).toBe(true);
    expect(host.stats.radius).toBeCloseTo(R1, 9);
    expect(Math.hypot(host.x - spot!.x, host.y - spot!.y)).toBeGreaterThan(0);
    expect(collideCircle(m, host.x, host.y, host.stats.radius - 0.01).hit).toBe(false);
  });

  it('never more than MAX_HARDPOINTS turrets: computeStats caps maxTurrets, and a 6th attach is refused', () => {
    expect(computeStats('brute', {}).maxTurrets).toBe(SHIP_CLASSES.brute.base.maxTurrets);
    expect(computeStats('brute', { 'path:bulwark': 1, turretmount: 2 }).maxTurrets).toBe(MAX_HARDPOINTS);
    expect(computeStats('engineer', { 'path:architect': 1, arc_turretbay: 1, turretmount: 2 }).maxTurrets).toBe(MAX_HARDPOINTS);
    const { sim, host, ts } = hostRig(['tech', 'engineer', 'brute', 'tech', 'engineer', 'brute']);
    host.stats.maxTurrets = 9; // even a forced slot count stops at the hull's mounts
    for (const t of ts) sim.setInput(t.playerId, inp({ attach: true, attachTarget: host.id }));
    sim.step();
    expect(host.turrets.length).toBe(MAX_HARDPOINTS);
    expect(ts[5].attachedTo).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('hitboxes: the capital hull is easier to hit, a docked turret is a small dome', () => {
  it('a hostile slug passing just outside the plain hull misses it, and hits the capital hull', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech'), foe = add(sim, 3, 'tech', 1);
    place(foe, x - 1200, y + 300);
    const R0 = host.stats.radius, R1 = R0 * capitalScale(1), rad = 4;
    const lane = (R0 + rad + R1 + rad) / 2; // between the two hulls (and clear of the bow dome)
    const shoot = (): number => {
      place(host, x, y, 0);
      sim.drainEvents();
      spawnProjectile(w, {
        ...projectileDefaults(w), kind: 'bullet', ownerId: foe.id, ownerPlayerId: foe.playerId, ownerTeam: foe.team,
        x: x - 150, y: y + lane, vx: 900, vy: 0, damage: 50, radius: rad, expireTick: w.tick + 40,
      });
      let hits = 0;
      for (let k = 0; k < 25; k++) {
        place(host, x, y, 0);
        sim.step();
        hits += sim.drainEvents().filter((e) => e.t === 'hit' && e.targetId === host.id).length;
      }
      return hits;
    };
    expect(shoot()).toBe(0);
    dock(sim, host, t);
    expect(host.stats.radius).toBeCloseTo(R1, 9);
    expect(shoot()).toBe(1);
  });

  it('a docked turret\'s hitbox is TURRET_BUBBLE_RADIUS (its own radius back on detach)', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech'), foe = add(sim, 3, 'tech', 1);
    place(host, x, y, 0);
    dock(sim, host, t);
    place(host, x, y, 0);
    sim.step();
    rebuildGrid(w);
    const R = host.stats.radius, rad = 4;
    const domeX = host.x + HARDPOINT_LAYOUT[1][0][0] * HARDPOINT_SEAT * R;
    expect(t.x).toBeCloseTo(domeX, 6);
    expect(t.stats.radius).toBe(TURRET_BUBBLE_RADIUS);
    // a vertical lane `d` px ahead of the dome centre, clear of the host hull
    const ray = (d: number) => firstHitOnSegment(w, foe.team, foe.id, domeX + d, y - 200, domeX + d, y + 200, rad, 0);
    const dHit = TURRET_BUBBLE_RADIUS + rad - 1.5, dMiss = TURRET_BUBBLE_RADIUS + rad + 3;
    expect(domeX + dHit - host.x).toBeGreaterThan(R + rad); // the host itself is never in these lanes
    expect(ray(dHit)).toBe(true);
    expect(found.s).toBe(t);
    // the tech hull (16 px) would be hit in this lane; the dome is not
    expect(dMiss).toBeLessThan(SHIP_CLASSES.tech.base.radius + rad);
    expect(ray(dMiss)).toBe(false);
    detachTurret(w, t);
    expect(t.stats.radius).toBe(SHIP_CLASSES.tech.base.radius);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Space: the capital skill only while hosting (own cost + cooldown knobs, the Space slot\'s ready tick)', () => {
  it('Juggernaut: Ram Charge alone, Broadside while hosting', () => {
    const sim = new Sim(cfg());
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    place(host, x, y, 0);
    sim.step();
    let ev = space(sim, host);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['ram']);
    expect(host.skillState.charging).toBe(1);
    steps(sim, host.stats.mobilityCooldown * TICK_RATE + 5);
    place(host, x, y, 0);
    dock(sim, host, t);
    place(host, x, y, 0);
    const tick = sim.world.tick + 1;
    ev = space(sim, host);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['broadside']);
    expect(host.skillState.charging ?? 0).toBe(0);
    expect(host.mobilityReadyTick).toBe(tick + Math.round(host.stats.skill.capCooldown * TICK_RATE));
  });

  it('Arcanist: Blink alone, Resonance Overcharge while hosting (no teleport)', () => {
    const sim = new Sim(cfg());
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'tech'), t = add(sim, 2, 'tech');
    place(host, x, y, 0);
    sim.step();
    let ev = space(sim, host, { aim: 0, aimDist: 400 });
    expect(ev.some((e) => e.t === 'blink' && e.shipId === host.id)).toBe(true);
    steps(sim, host.stats.mobilityCooldown * TICK_RATE + 5);
    place(host, x, y, 0);
    dock(sim, host, t);
    place(host, x, y, 0);
    ev = space(sim, host, { aim: 0, aimDist: 400 });
    expect(ev.some((e) => e.t === 'blink')).toBe(false);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['overcharge']);
    expect(host.x).toBeCloseTo(x, 0);
  });

  it('Artificer: Repair Pulse alone, Repair Bay while hosting; the capital cost and cooldown are its own knobs', () => {
    const sim = new Sim(cfg());
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'engineer'), t = add(sim, 2, 'brute');
    place(host, x, y, 0);
    sim.step();
    let tick = sim.world.tick + 1;
    let ev = space(sim, host);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['repair']);
    expect(host.mobilityReadyTick).toBe(tick + Math.round(host.stats.mobilityCooldown * TICK_RATE));
    steps(sim, host.stats.mobilityCooldown * TICK_RATE + 5);
    dock(sim, host, t);
    tick = sim.world.tick + 1;
    ev = space(sim, host);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['repairbay']);
    expect(host.mobilityReadyTick).toBe(tick + Math.round(host.stats.skill.capCooldown * TICK_RATE));
    // on cooldown: a second press does nothing
    ev = space(sim, host);
    expect(abilities(ev, host.id)).toEqual([]);
    // a docked turret's own Space press is not a capital skill (turret kits have no mobility)
    ev = space(sim, t);
    expect(abilities(ev, t.id)).toEqual([]);
  });

  it('a capital skill costs capCost (not mobilityCost) and is refused without the energy', () => {
    const sim = new Sim(cfg());
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    place(host, x, y, 0);
    dock(sim, host, t);
    place(host, x, y, 0);
    const cost = host.stats.skill.capCost;
    expect(cost).not.toBe(host.stats.mobilityCost);
    host.stats.rechargePerSec = 0;
    host.energy = cost - 1;
    let ev = space(sim, host);
    expect(abilities(ev, host.id)).toEqual([]);
    expect(host.energy).toBe(cost - 1);
    host.energy = host.stats.maxEnergy;
    ev = space(sim, host);
    expect(abilities(ev, host.id).length).toBe(1);
    expect(host.energy).toBeCloseTo(host.stats.maxEnergy - cost, 6);
  });
});

// ---------------------------------------------------------------------------------------------
describe('capital skills', () => {
  it('Broadside: broadsideSlugs heavy slugs from EACH flank, converging on the aim point, bullet level 3', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech'), foe = add(sim, 3, 'brute', 1), side = add(sim, 4, 'brute', 1);
    place(host, x, y, 0);
    dock(sim, host, t);
    place(host, x, y, 0);
    place(foe, x + 300, y); // dead ahead, where the pilot aims
    place(side, x, y + 260); // abeam: a perpendicular volley would hit it, the aimed one does not
    for (const s of [foe, side]) s.stats.rechargePerSec = 0;
    const foe0 = foe.energy, side0 = side.energy;
    const sk = host.stats.skill;
    const aim = { aim: 0, aimDist: 300 };
    const ev = space(sim, host, aim);
    const slugs = [...w.projectiles.values()].filter((p) => p.ownerId === host.id);
    expect(slugs.length).toBe(2 * sk.broadsideSlugs);
    const dmg = sk.broadsideDamage * host.stats.mobilityPower * host.stats.damageMult;
    let port = 0, star = 0;
    for (const p of slugs) {
      expect(p.kind).toBe('bullet');
      expect(p.level).toBe(3);
      expect(p.radius).toBe(BROADSIDE_RADIUS);
      expect(p.damage).toBeCloseTo(dmg, 9);
      expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(sk.broadsideSpeed, 0);
      // from a flank gunport, outside the hull
      expect(Math.hypot(p.x - host.x, p.y - host.y)).toBeGreaterThan(host.stats.radius);
      if (p.y > host.y) star++; else port++;
      // its line crosses the aim line within BROADSIDE_FOCUS_SPREAD / 2 of the aim point (x + 300, y)
      const k = (x + 300 - p.x) / p.vx;
      expect(k).toBeGreaterThan(0);
      expect(Math.abs(p.y + p.vy * k - y)).toBeLessThanOrEqual(BROADSIDE_FOCUS_SPREAD / 2 + 1e-6);
    }
    expect([port, star]).toEqual([sk.broadsideSlugs, sk.broadsideSlugs]);
    expect(ev.some((e) => e.t === 'fire' && e.shipId === host.id && e.skill === 'broadside')).toBe(true);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['broadside']);
    // the crossfire lands on the ship the pilot aimed at (the inner half of each flank), not on the one abeam
    for (let k = 0; k < 30; k++) { place(host, x, y, 0); place(foe, x + 300, y); sim.step(); }
    expect(foe0 - foe.energy).toBeGreaterThanOrEqual(dmg * 4 * (1 - foe.stats.armor) - 1e-6);
    expect(side.energy).toBe(side0);
  });

  it('Broadside focus: aimDist is clamped to the focus range, and the hull heading does not steer the volley', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), t = add(sim, 2, 'tech');
    place(host, x, y, 0);
    dock(sim, host, t);
    /** Fire with this aim; each slug line's offset across the aim line where it crosses `fd` px out along it. */
    const offsetsAt = (aim: number, aimDist: number, angle: number, fd: number) => {
      for (const id of [...w.projectiles.keys()]) w.projectiles.delete(id);
      host.mobilityReadyTick = 0;
      host.energy = host.stats.maxEnergy;
      host.stats.turnRate = 0; // the hull keeps `angle` whatever the aim
      place(host, x, y, angle);
      space(sim, host, { aim, aimDist });
      const ux = Math.cos(aim), uy = Math.sin(aim);
      return [...w.projectiles.values()].filter((p) => p.ownerId === host.id).map((p) => {
        const s = (fd - ((p.x - host.x) * ux + (p.y - host.y) * uy)) / (p.vx * ux + p.vy * uy);
        const cx = p.x + p.vx * s - host.x, cy = p.y + p.vy * s - host.y;
        return Math.round(-cx * uy + cy * ux);
      }).sort((a, b) => a - b);
    };
    // each flank's slugs land at −50 … +50 across the aim line at the focus (both flanks: every point twice)
    const S = BROADSIDE_FOCUS_SPREAD, pts = [-S / 2, -S / 2, -S / 6, -S / 6, S / 6, S / 6, S / 2, S / 2].map(Math.round);
    expect(offsetsAt(0, 300, 0, 300)).toEqual(pts);
    expect(offsetsAt(0, 20, 0, BROADSIDE_FOCUS_MIN)).toEqual(pts); // clamped up
    expect(offsetsAt(0, 2000, 0, BROADSIDE_FOCUS_MAX)).toEqual(pts); // clamped down
    // the hull turned 60° off the aim (turn rate 0): the slugs still converge on the aim point
    expect(offsetsAt(0.5, 300, 0.5 + Math.PI / 3, 300)).toEqual(pts);
  });

  it('Resonance Overcharge: lasers on the host count +overchargeBonus for resonance (damage and draw), then end', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'tech'), t = add(sim, 2, 'tech'), foe = add(sim, 3, 'brute', 1);
    place(host, x, y, 0);
    dock(sim, host, t);
    host.stats.rechargePerSec = 0;
    foe.stats.rechargePerSec = 0;
    const aim = () => Math.atan2(foe.y - t.y, foe.x - t.x);
    const hold = () => { place(host, x, y, 0); place(foe, x + 320, y); };
    hold();
    sim.step();
    t.angle = aim();
    sim.setInput(t.playerId, inp({ primary: true, aim: aim() }));
    const sk = t.stats.skill;
    const burn = (n: number) => {
      host.energy = host.stats.maxEnergy;
      const h0 = host.energy;
      for (let k = 0; k < n; k++) { hold(); sim.step(); }
      return h0 - host.energy;
    };
    // alone: resonance 1
    expect(burn(30)).toBeCloseTo(sk.laserHostCostPerSec * DT * 30, 6);
    expect(t.skillState.resonance).toBe(1);
    expect(t.skillState.beamKind).toBe(BEAM_LASER);
    // overcharged: counts 1 + overchargeBonus → × LASER_RESONANCE on damage and host draw
    const bonus = host.stats.skill.overchargeBonus;
    const ev = space(sim, host);
    expect(abilities(ev, host.id).map((e) => [e.skill, e.talent])).toEqual([['overcharge', undefined]]);
    expect(overchargeBonus(w, host)).toBe(bonus);
    expect(host.mobilityActiveUntilTick).toBeGreaterThan(w.tick);
    const f = resonanceFactor(1 + bonus);
    expect(f).toBeCloseTo(LASER_RESONANCE, 9);
    expect(burn(30)).toBeCloseTo(sk.laserHostCostPerSec * DT * f * 30, 6);
    expect(t.skillState.resonance).toBe(1 + bonus);
    const acc0 = t.skillState.laserAcc ?? 0;
    sim.step();
    const perTick = (t.skillState.laserAcc ?? 0) - acc0;
    if (perTick > 0) expect(perTick).toBeCloseTo(sk.laserDps * DT * f, 6); // (0 on a pay-out tick)
    // it ends on time with an end event, and the resonance drops back
    const end = w.tick + host.stats.skill.overchargeTime * TICK_RATE + 2;
    let ended: GameEvent | undefined;
    while (w.tick < end && !ended) {
      hold();
      sim.step();
      ended = abilities(sim.drainEvents(), host.id).find((e) => e.talent === OVERCHARGE_END);
    }
    expect(ended).toBeDefined();
    expect(overchargeBonus(w, host)).toBe(0);
    hold();
    sim.step();
    expect(t.skillState.resonance).toBe(1);
  });

  it('Resonance Overcharge stacks on real resonance (2 lasers → 3), and ends early when the last turret leaves', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'tech'), t1 = add(sim, 2, 'tech'), t2 = add(sim, 3, 'tech'), foe = add(sim, 4, 'brute', 1);
    host.stats.maxTurrets = 2;
    place(host, x, y, 0);
    dock(sim, host, t1, t2);
    host.stats.rechargePerSec = 0;
    const hold = () => { place(host, x, y, 0); place(foe, x + 320, y); };
    hold();
    sim.step();
    for (const t of [t1, t2]) {
      const a = Math.atan2(foe.y - t.y, foe.x - t.x);
      t.angle = a;
      sim.setInput(t.playerId, inp({ primary: true, aim: a }));
    }
    space(sim, host);
    host.energy = host.stats.maxEnergy;
    const h0 = host.energy;
    for (let k = 0; k < 20; k++) { hold(); sim.step(); }
    const sk = t1.stats.skill;
    expect(h0 - host.energy).toBeCloseTo(2 * sk.laserHostCostPerSec * DT * resonanceFactor(3) * 20, 6);
    expect(t1.skillState.resonance).toBe(3);
    expect(resonanceFactor(3)).toBeCloseTo(LASER_RESONANCE * LASER_RESONANCE, 9);
    // the host sheds both turrets: no capital, the overcharge ends at once (event), the Space slot is free again
    sim.drainEvents();
    sim.setInput(host.playerId, inp({ detach: true }));
    sim.step();
    expect(isCapital(host)).toBe(false);
    expect(abilities(sim.drainEvents(), host.id).some((e) => e.skill === 'overcharge' && e.talent === OVERCHARGE_END)).toBe(true);
    expect(host.skillState.overchargeUntil).toBeUndefined();
    expect(host.mobilityActiveUntilTick).toBeLessThanOrEqual(w.tick);
  });

  it('Repair Bay: heals its turrets + allies in range over bayTime, shields them by bayShield; never foes or itself', () => {
    const sim = new Sim(cfg());
    const w = sim.world;
    const { x, y } = openArea(sim, 700, 400);
    const host = add(sim, 1, 'engineer'), t = add(sim, 2, 'brute');
    const near = add(sim, 3, 'tech'), far = add(sim, 4, 'tech'), foe = add(sim, 5, 'tech', 1);
    place(host, x, y, 0);
    dock(sim, host, t);
    const sk = host.stats.skill;
    const hold = () => {
      place(host, x, y, 0); place(near, x + 200, y); place(far, x + sk.bayRadius + 150, y); place(foe, x - 150, y);
    };
    hold();
    for (const s of [host, t, near, far, foe]) { s.stats.rechargePerSec = 0; s.energy = 300; s.invulnUntilTick = 0; }
    const ev = space(sim, host);
    expect(abilities(ev, host.id).map((e) => e.skill)).toEqual(['repairbay']);
    expect(host.energy).toBe(300 - sk.capCost); // capCost 0 for the Foundry: nothing else touches the host
    // covered ships are shielded: bayShield of a hit is absorbed (armor 0 on a tech hull)
    hold();
    sim.step();
    expect(near.flags & SHIPFLAG_SHIELD).toBeTruthy();
    expect(far.flags & SHIPFLAG_SHIELD).toBeFalsy();
    const n0 = near.energy, f0 = far.energy;
    damageShip(w, near, 100, foe.id, 'player');
    damageShip(w, far, 100, foe.id, 'player');
    expect(n0 - near.energy).toBeCloseTo(100 * (1 - sk.bayShield), 6);
    expect(f0 - far.energy).toBeCloseTo(100, 6);
    near.energy += 100 * (1 - sk.bayShield); far.energy += 100; // undo the probe hits
    let heals = 0;
    for (let k = 0; k < sk.bayTime * TICK_RATE + 5; k++) {
      hold();
      sim.step();
      heals += sim.drainEvents().filter((e) => e.t === 'heal' && (e.targetId === t.id || e.targetId === near.id)).length;
    }
    const tol = 2;
    expect(t.energy).toBeGreaterThan(300 + sk.bayHealFrac * t.stats.maxEnergy * host.stats.healMult - tol);
    expect(t.energy).toBeLessThanOrEqual(300 + sk.bayHealFrac * t.stats.maxEnergy * host.stats.healMult + 1e-6);
    expect(near.energy).toBeGreaterThan(300 + sk.bayHealFrac * near.stats.maxEnergy * host.stats.healMult - tol);
    expect(far.energy).toBe(300);
    expect(foe.energy).toBe(300);
    expect(host.energy).toBe(300);
    expect(heals).toBeGreaterThanOrEqual(4); // periodic (batched) heal events
    // over: no shield any more
    steps(sim, 3);
    expect(host.skillState.bayUntil).toBeUndefined();
    const n1 = near.energy;
    damageShip(w, near, 100, foe.id, 'player');
    expect(n1 - near.energy).toBeCloseTo(100, 6);
  });
});

// ---------------------------------------------------------------------------------------------
describe('friendly fire: a turret crew never hits itself (domes sit in the line of fire)', () => {
  it('the host\'s own guns pass its bow dome, and flak from a dome passes its host', () => {
    const sim = new Sim(cfg({ friendlyFire: true }));
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), gun = add(sim, 2, 'tech'), flak = add(sim, 3, 'brute');
    place(host, x, y, 0);
    dock(sim, host, gun, flak);
    sim.drainEvents();
    sim.setInput(host.playerId, inp({ primary: true, aim: 0 }));
    sim.setInput(flak.playerId, inp({ primary: true, aim: Math.PI }));
    let crewHits = 0;
    for (let k = 0; k < 90; k++) {
      place(host, x, y, 0);
      sim.step();
      crewHits += sim.drainEvents().filter((e) => e.t === 'hit' && [host.id, gun.id, flak.id].includes(e.targetId)).length;
    }
    expect(crewHits).toBe(0);
  });

  it('splash, auto-weapons and Ram spare the crew too (friendly fire on), and still hit a teammate outside it', () => {
    const sim = new Sim(cfg({ friendlyFire: true }));
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), a = add(sim, 2, 'tech'), b = add(sim, 3, 'engineer'), mate = add(sim, 4, 'tech');
    place(host, x, y, 0);
    dock(sim, host, a, b);
    place(host, x, y, 0);
    sim.step();
    place(mate, x + 60, y + 70);
    rebuildGrid(w);
    const e0 = [host, a, b].map((s) => s.energy), m0 = mate.energy;
    // a rocket-sized blast of the host's right on its own bow dome: the crew takes nothing, the teammate beside it does
    splashDamage(w, x + 30, y, 90, 500, host.team, host.id);
    expect([host, a, b].map((s) => s.energy)).toEqual(e0);
    expect(mate.energy).toBeLessThan(m0);
    // a dome's own blast on its host: nothing either
    splashDamage(w, x, y, 60, 500, a.team, a.id);
    expect([host, a, b].map((s) => s.energy)).toEqual(e0);
    // without friendly fire the teammate is safe as before
    w.config.friendlyFire = false;
    const m1 = mate.energy;
    splashDamage(w, x + 30, y, 90, 500, host.team, host.id);
    expect(mate.energy).toBe(m1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('domes stay on their hardpoints when the host is pushed', () => {
  it('a PvE body pushing the host (after the turrets were seated) re-seats its domes the same tick', () => {
    const sim = new Sim(cfg({ pveIntensity: 1 }));
    const w = sim.world;
    const { x, y } = openArea(sim);
    const host = add(sim, 1, 'brute'), a = add(sim, 2, 'tech'), b = add(sim, 3, 'engineer');
    place(host, x, y, 0);
    dock(sim, host, a, b);
    let pushed = 0;
    for (let k = 0; k < 40; k++) {
      // a brute enemy (knockback > 0) overlapping the hull every tick
      for (const id of [...w.enemies.keys()]) w.enemies.delete(id);
      const e = spawnEnemy(w, 'brute', host.x + host.stats.radius + 20, host.y);
      expect(e).not.toBeNull();
      const hx = host.x;
      sim.step();
      if (Math.abs(host.x - hx) > 1) pushed++;
      for (const t of [a, b]) {
        const o = turretOffset(host.angle, host.turrets.indexOf(t.id), host.turrets.length, host.stats.radius);
        expect(Math.hypot(t.x - host.x - o.dx, t.y - host.y - o.dy)).toBeLessThan(1e-6);
      }
    }
    expect(pushed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Turret Mount at the hardpoint cap', () => {
  it('a host already at MAX_HARDPOINTS slots is never offered Turret Mount; the rng draws are unchanged', () => {
    const run = (capped: boolean) => {
      const sim = new Sim(cfg({ mapSeed: 77 }));
      const host = add(sim, 1, 'brute');
      host.upgrades['path:bulwark'] = 1;
      host.path = 'bulwark';
      host.stats = computeStats('brute', host.upgrades);
      expect(host.stats.maxTurrets).toBe(MAX_HARDPOINTS);
      if (!capped) host.stats.maxTurrets = MAX_HARDPOINTS - 1;
      const offers: string[][] = [];
      for (let i = 0; i < 400; i++) offers.push(buildOffer(sim.world, host, 4).map((c) => c.id));
      return { offers, next: sim.world.rng.next() };
    };
    const capped = run(true), open = run(false);
    expect(open.offers.some((o) => o.includes('turretmount'))).toBe(true); // Bulwark affinity: it comes up often
    expect(capped.offers.some((o) => o.includes('turretmount'))).toBe(false);
    expect(capped.next).toBe(open.next); // same draws: dropping a drawn dead card never touches the rng
    for (let i = 0; i < capped.offers.length; i++) {
      expect(capped.offers[i].length).toBe(3);
      const want = open.offers[i].filter((id) => id !== 'turretmount');
      expect(capped.offers[i].slice(0, want.length)).toEqual(want);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('snapshot', () => {
  it('you.stats.radius is the capital radius for a host and the dome radius for a docked turret', () => {
    const { sim, host, ts } = hostRig(['tech', 'engineer']);
    dock(sim, host, ts[0], ts[1]);
    const b = new SnapshotBuilder();
    b.prepare(sim.world, []);
    const you = b.build({ playerId: 1, spectator: false }).you!;
    expect(you.stats.radius).toBeCloseTo(computeStats('brute', host.upgrades).radius * capitalScale(2), 9);
    const tv = b.build({ playerId: ts[0].playerId, spectator: false }).you!;
    expect(tv.stats.radius).toBe(TURRET_BUBBLE_RADIUS);
  });
});
