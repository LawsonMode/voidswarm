// v0.5 capital ships on the client netcode side: the capital skill replaces mobility in the movement model (no
// Ram Charge / Repair boost predicted for a host), the capital hull radius for local wall collision, and turret
// placement read back off the server's new hardpoint layout (hostRadii).
import { describe, expect, it } from 'vitest';
import { DT, MAX_HARDPOINTS, TICK_RATE } from '../../shared/constants';
import { SHIP_CLASS_IDS, SHIP_CLASSES } from '../../shared/data/ships';
import { stepShipMovement } from '../../shared/sim/movement';
import { Sim } from '../../shared/sim/Sim';
import { capitalScale, turretOffset } from '../../shared/sim/world';
import { emptyInput, TILE_EMPTY, TILE_WALL, type InputState, type ShipStats, type ShipView, type YouState } from '../../shared/types';
import { hostRadii } from './attach';
import { capitalRadius, moveSkillsFor, normalHullRadius, predictStats, Predictor, type PredictCtx } from './prediction';

const statsOf = (cls: keyof typeof SHIP_CLASSES): ShipStats => ({ ...SHIP_CLASSES[cls].base, skill: { ...SHIP_CLASSES[cls].base.skill } });
function youOf(cls: keyof typeof SHIP_CLASSES, turrets: number[], o: Partial<YouState> = {}): YouState {
  return {
    shipId: 1, alive: true, energy: 5000, stats: statsOf(cls), attachedTo: 0, turrets, talents: [], path: null,
    cdSec: { secondary: 0, mobility: 0, utility: 0 }, ...o,
  } as unknown as YouState;
}
const viewOf = (cls: keyof typeof SHIP_CLASSES): ShipView => ({ id: 1, shipClass: cls, flags: 0 }) as ShipView;

describe('moveSkillsFor: the capital skill holds Space while hosting', () => {
  it('each class swaps its mobility skill for its capital skill, with capCost / capCooldown', () => {
    for (const id of SHIP_CLASS_IDS) {
      const d = SHIP_CLASSES[id], sk = d.base.skill;
      const plain = moveSkillsFor(youOf(id, []), viewOf(id));
      expect(plain.mobility).toBe(d.skills.mobility.id);
      expect(plain.mobilityCost).toBe(d.base.mobilityCost);
      expect(plain.cooldownTicks).toBe(Math.round(d.base.mobilityCooldown * TICK_RATE));
      const cap = moveSkillsFor(youOf(id, [9]), viewOf(id));
      expect(cap.mobility).toBe(d.capital.skill.id);
      expect(cap.mobilityCost).toBe(sk.capCost);
      expect(cap.cooldownTicks).toBe(Math.round(sk.capCooldown * TICK_RATE));
    }
    // a turret (attached) is not a host, whatever its own list says
    expect(moveSkillsFor(youOf('brute', [9], { attachedTo: 4 }), viewOf('brute')).mobility).toBe('ram');
  });

  it('a Dreadnought pressing Space does not predict a Ram Charge (it would rubber-band every Broadside)', () => {
    const sim = new Sim({ mapSeed: 5, mode: 'ffa', teamCount: 0, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
    const map = sim.world.map;
    map.tiles.fill(TILE_EMPTY);
    const drive = (you: YouState) => {
      const pred = new Predictor(stepShipMovement, DT);
      const ctx: PredictCtx = { stats: you.stats, map, energy: you.energy, speedMult: 1, skills: moveSkillsFor(you, viewOf('brute')) };
      pred.reconcile({ x: 2000, y: 2000, vx: 0, vy: 0, angle: 0 }, 0, ctx);
      for (let k = 1; k <= 60; k++) {
        const inp: InputState = { ...emptyInput(), moveX: 0.4, aim: 1.2, aimDist: 300, mobility: k === 10, seq: k };
        pred.applyLocal(inp, ctx);
      }
      return pred.body!;
    };
    const host = drive(youOf('brute', [9]));
    const plain = drive(youOf('brute', []));
    // the plain Juggernaut charged (1500 px/s toward aim 1.2): far off the thrust line; the Dreadnought only thrusted
    expect(Math.hypot(plain.x - host.x, plain.y - host.y)).toBeGreaterThan(200);
    expect(Math.abs(host.y - 2000)).toBeLessThan(1);
    expect(host.x).toBeGreaterThan(2000);
  });
});

describe('capital hull radius for local wall collision', () => {
  it('normalHullRadius is the class hull with its path talents (Bulwark Titan ×1.15)', () => {
    expect(normalHullRadius('brute', null, [])).toBe(SHIP_CLASSES.brute.base.radius);
    expect(normalHullRadius('tech', null, undefined)).toBe(SHIP_CLASSES.tech.base.radius);
    expect(normalHullRadius('brute', 'bulwark', ['bul_titan'])).toBeCloseTo(SHIP_CLASSES.brute.base.radius * 1.15);
    expect(normalHullRadius('brute', null, ['bul_titan'])).toBe(SHIP_CLASSES.brute.base.radius); // talents need their path
  });

  it('scales an unscaled radius once, keeps an already-scaled one, and does nothing while hosting nobody', () => {
    const R = 22;
    for (let n = 1; n <= MAX_HARDPOINTS; n++) {
      const k = capitalScale(n);
      expect(capitalRadius(R, R, n)).toBeCloseTo(R * k); // the Sim's stats.radius still reads as the normal hull
      expect(capitalRadius(R * k, R, n)).toBe(R * k); // the Sim already applied it: never twice
      expect(capitalRadius(R * 1.15, R * 1.15, n)).toBeCloseTo(R * 1.15 * k); // Titan, unscaled
      expect(capitalRadius(R * 1.15 * k, R * 1.15, n)).toBe(R * 1.15 * k); // Titan, scaled
    }
    expect(capitalRadius(R, R, 0)).toBe(R);
    expect(capitalRadius(R * 1.4, R, 0)).toBe(R * 1.4); // server truth wins when not hosting
  });

  it('predictStats returns the same stats object unless the hull has to grow', () => {
    const idle = youOf('brute', []);
    expect(predictStats(idle, 'brute')).toBe(idle.stats);
    const host = youOf('brute', [9, 10]);
    const p = predictStats(host, 'brute');
    expect(p).not.toBe(host.stats);
    expect(p.radius).toBeCloseTo(host.stats.radius * capitalScale(2));
    expect(host.stats.radius).toBe(SHIP_CLASSES.brute.base.radius); // the snapshot's stats are never mutated
    const scaled = youOf('brute', [9, 10]);
    scaled.stats.radius *= capitalScale(2);
    expect(predictStats(scaled, 'brute')).toBe(scaled.stats);
  });

  it('a predicted Dreadnought stops a capital hull short of a wall, like the server', () => {
    const sim = new Sim({ mapSeed: 5, mode: 'ffa', teamCount: 0, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
    const map = sim.world.map;
    map.tiles.fill(TILE_EMPTY);
    const col = Math.floor(2600 / map.tileSize);
    for (let r = 0; r < map.rows; r++) map.tiles[r * map.cols + col] = TILE_WALL;
    const wallX = col * map.tileSize;
    const rest = (you: YouState) => {
      const pred = new Predictor(stepShipMovement, DT);
      const ctx: PredictCtx = { stats: predictStats(you, 'brute'), map, energy: you.energy, speedMult: 1, skills: null };
      pred.reconcile({ x: 2000, y: 2000, vx: 0, vy: 0, angle: 0 }, 0, ctx);
      for (let k = 1; k <= 240; k++) pred.applyLocal({ ...emptyInput(), moveX: 1, aim: 0, aimDist: 300, seq: k }, ctx);
      return pred.body!.x;
    };
    const R = SHIP_CLASSES.brute.base.radius;
    const n = 3;
    expect(wallX - rest(youOf('brute', []))).toBeCloseTo(R, 0);
    expect(wallX - rest(youOf('brute', [7, 8, 9]))).toBeCloseTo(R * capitalScale(n), 0);
  });
});

describe('hostRadii reads the effective host radius off the v0.5 hardpoints', () => {
  const ship = (id: number, x: number, y: number, o: Partial<ShipView> = {}): ShipView => ({
    id, playerId: id, team: 0, shipClass: 'brute', x, y, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true, attachedTo: 0,
    turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1, ...o,
  });
  const q8 = (v: number) => Math.round(v * 8) / 8;

  it('for every mount of every count (capital scale and Titan included), exact and after 1/8 px quantization', () => {
    for (let n = 1; n <= MAX_HARDPOINTS; n++) {
      for (const titan of [1, 1.15]) {
        const R = SHIP_CLASSES.brute.base.radius * titan * capitalScale(n);
        for (let slot = 0; slot < n; slot++) {
          const angle = 0.37 + slot * 1.3;
          const host = ship(1, 3000.3, 2000.7, { angle, turretCount: n });
          const o = turretOffset(angle, slot, n, R);
          const t = ship(2, host.x + o.dx, host.y + o.dy, { attachedTo: 1, turretSlot: slot, turretCount: n });
          expect(hostRadii([host, t]).get(1), `n ${n} slot ${slot}`).toBeCloseTo(R, 6);
          const qh = { ...host, x: q8(host.x), y: q8(host.y) }, qt = { ...t, x: q8(t.x), y: q8(t.y) };
          expect(Math.abs(hostRadii([qh, qt]).get(1)! - R)).toBeLessThan(0.3);
        }
      }
    }
  });

  it('placing turrets from the recovered radius lands them back on the server hardpoints', () => {
    const n = 5, R = SHIP_CLASSES.engineer.base.radius * capitalScale(n);
    const host = ship(1, 1000, 1000, { shipClass: 'engineer', angle: -0.8, turretCount: n });
    const turrets = Array.from({ length: n }, (_, i) => {
      const o = turretOffset(host.angle, i, n, R);
      return ship(10 + i, host.x + o.dx, host.y + o.dy, { attachedTo: 1, turretSlot: i, turretCount: n });
    });
    const r = hostRadii([host, ...turrets]).get(1)!;
    for (const t of turrets) {
      const o = turretOffset(host.angle, t.turretSlot, n, r);
      expect(Math.hypot(host.x + o.dx - t.x, host.y + o.dy - t.y)).toBeLessThan(1e-6);
    }
  });

  it('ignores implausible offsets (a knock between placement and snapshot) and dead turrets', () => {
    const host = ship(1, 1000, 1000, { turretCount: 1 });
    expect(hostRadii([host, ship(2, 1400, 1000, { attachedTo: 1, turretSlot: 0, turretCount: 1 })]).has(1)).toBe(false);
    expect(hostRadii([host, ship(2, 1001, 1000, { attachedTo: 1, turretSlot: 0, turretCount: 1 })]).has(1)).toBe(false);
    const o = turretOffset(0, 0, 1, 30);
    expect(hostRadii([host, ship(2, 1000 + o.dx, 1000 + o.dy, { attachedTo: 1, turretSlot: 0, turretCount: 1, alive: false })]).has(1)).toBe(false);
  });
});
