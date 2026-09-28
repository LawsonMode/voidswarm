// NET-3 / NET-11 regression: drive the REAL server Sim through a latency model and check the own-ship
// predictor agrees with it through Ram Charge, Repair Pulse and Blink (and coasting on afterburner).
import { describe, expect, it } from 'vitest';
import { DT, TICK_RATE } from '../../shared/constants';
import { stepShipMovement } from '../../shared/sim/movement';
import { Sim } from '../../shared/sim/Sim';
import { CTF_CARRIER_SPEED_MULT, CTF_OVERLOAD_FULL_SEC, CTF_OVERLOAD_SEC } from '../../shared/sim/objectives/rules';
import { THRUST_DEADZONE } from '../../shared/sim/movement';
import {
  emptyInput, SHIPFLAG_BOT, SHIPFLAG_CARRIER, TILE_EMPTY, TILE_WALL, type InputState, type Ship, type ShipClassId, type ShipView,
  type YouState,
} from '../../shared/types';
import { hostSpeedMult } from './attach';
import { moveSkillsFor, predictRechargeMult, predictSpeedMult, Predictor, type PredictCtx } from './prediction';

interface Snap { at: number; ack: number; body: { x: number; y: number; vx: number; vy: number; angle: number }; you: YouState; view: ShipView }

interface RunOpts {
  shipClass: ShipClassId;
  ticks: number;
  /** One-way latency in ticks (3 = 50 ms each way, 100 ms RTT). */
  lat: number;
  input(k: number): Partial<InputState>;
  /** Mutate the server world before tick k (walls, energy drain...). */
  server?(k: number, ship: Ship, sim: Sim): void;
}

interface RunResult { corrections: { tick: number; dist: number; snapped: boolean }[]; finalGap: number; ship: Ship }

const q8 = (v: number) => Math.round(v * 8) / 8; // codec: positions in 1/8 px
const qa = (a: number) => (Math.round((a / (Math.PI * 2)) * 256) / 256) * Math.PI * 2; // uint8 angles

function run(o: RunOpts): RunResult {
  const sim = new Sim({ mapSeed: 5, mode: 'ffa', teamCount: 0, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
  const map = sim.world.map;
  map.tiles.fill(TILE_EMPTY);
  sim.addPlayer({ playerId: 1, name: 'p', team: -1, shipClass: o.shipClass, isBot: false });
  const ship = [...sim.world.ships.values()][0];
  ship.x = map.width / 2; ship.y = map.height / 2; ship.vx = ship.vy = 0; ship.angle = 0;

  const pred = new Predictor(stepShipMovement, DT);
  const toServer: { at: number; inp: InputState }[] = [];
  const toClient: Snap[] = [];
  let latest: Snap | null = null;
  const corrections: RunResult['corrections'] = [];
  const ctxOf = (s: Snap): PredictCtx => ({
    stats: s.you.stats, map, energy: s.you.energy, speedMult: 1, skills: moveSkillsFor(s.you, s.view),
  });

  for (let k = 1; k <= o.ticks; k++) {
    // client: sample + predict input k
    const inp: InputState = { ...emptyInput(), aim: 0, aimDist: 300, ...o.input(k), seq: k };
    toServer.push({ at: k + o.lat, inp });
    pred.applyLocal(inp, latest && pred.body ? ctxOf(latest) : null);
    pred.decay(1 / 60);

    // server tick k
    o.server?.(k, ship, sim);
    for (const m of toServer.filter((m) => m.at === k)) sim.setInput(1, m.inp);
    sim.step();
    sim.drainEvents();
    if (k % 3 === 0) {
      const t = sim.world.tick;
      const cdSec = ship.mobilityReadyTick > t ? Math.round(((ship.mobilityReadyTick - t) / TICK_RATE) * 1000) / 1000 : 0;
      const you = {
        shipId: ship.id, alive: ship.alive, energy: ship.energy, stats: ship.stats, attachedTo: 0, turrets: [],
        talents: Object.keys(ship.upgrades), cdSec: { secondary: 0, mobility: cdSec, utility: 0 },
      } as unknown as YouState;
      const view = { id: ship.id, shipClass: ship.shipClass, flags: ship.flags } as ShipView;
      toClient.push({
        at: k + o.lat, ack: ship.lastInputSeq, you, view,
        body: { x: q8(ship.x), y: q8(ship.y), vx: Math.round(ship.vx), vy: Math.round(ship.vy), angle: qa(ship.angle) },
      });
    }

    // client: deliver snapshots
    for (const s of toClient.filter((s) => s.at === k)) {
      latest = s;
      const before = pred.body ? { ...pred.body } : null;
      pred.reconcile(s.body, s.ack, ctxOf(s));
      if (before) {
        const dist = Math.hypot(before.x - pred.body!.x, before.y - pred.body!.y);
        corrections.push({ tick: k, dist, snapped: pred.errX === 0 && pred.errY === 0 && dist > 1 });
      }
    }
  }
  // After the pipeline drains, the server's latest state vs what the client predicted for the same input.
  const last = toClient[toClient.length - 1];
  const gap = Math.hypot(last.body.x - ship.x, last.body.y - ship.y);
  return { corrections, finalGap: gap, ship };
}

const max = (r: RunResult, from = 0) => Math.max(0, ...r.corrections.filter((c) => c.tick >= from).map((c) => c.dist));

describe('prediction vs the real server sim', () => {
  const thrustRight = (k: number) => ({ moveX: k < 400 ? 1 : 0 });

  it('Ram Charge: no rubber-band on the first charging snapshot or after the charge ends', () => {
    for (const lat of [3, 6, 12]) { // 100 / 200 / 400 ms RTT
      const r = run({ shipClass: 'brute', ticks: 240, lat, input: (k) => ({ ...thrustRight(k), mobility: k >= 90 && k < 96, aim: 0.6 }) });
      expect(max(r), `lat ${lat}`).toBeLessThan(6);
      expect(r.corrections.some((c) => c.snapped)).toBe(false);
    }
  });

  it('Ram Charge into a wall: the slide / dead stop is predicted too', () => {
    const r = run({
      shipClass: 'brute', ticks: 240, lat: 4,
      input: (k) => ({ moveX: 1, mobility: k >= 90 && k < 94, aim: k < 90 ? 0 : 0.35 }),
      server: (k, ship, sim) => {
        if (k !== 1) return;
        const m = sim.world.map;
        const col = Math.floor((ship.x + 700) / m.tileSize); // a vertical wall ahead of the charge
        for (let r2 = 0; r2 < m.rows; r2++) m.tiles[r2 * m.cols + col] = TILE_WALL;
      },
    });
    expect(max(r)).toBeLessThan(8);
  });

  it('a charge the server refuses (energy spent meanwhile) is dropped on the next snapshot', () => {
    const r = run({
      shipClass: 'brute', ticks: 200, lat: 4, input: (k) => ({ moveX: 1, mobility: k >= 90 && k < 95 }),
      server: (k, ship) => { if (k >= 80 && k <= 100) ship.energy = 10; }, // client still sees full energy
    });
    // one correction when the refusal becomes visible, then back in agreement
    expect(max(r, 110)).toBeLessThan(2);
  });

  it('Repair Pulse speed boost is predicted (no steady under-prediction while boosted)', () => {
    const r = run({ shipClass: 'engineer', ticks: 220, lat: 4, input: (k) => ({ moveX: 1, moveY: 0.3, mobility: k >= 90 && k < 93 }) });
    expect(max(r, 60)).toBeLessThan(3);
  });

  it('Blink snaps once instead of sliding, then agrees', () => {
    const r = run({ shipClass: 'tech', ticks: 200, lat: 4, input: (k) => ({ moveX: 0.5, mobility: k === 90, aim: 1.1 }) });
    const big = r.corrections.filter((c) => c.dist > 50);
    expect(big.length).toBe(1);
    expect(big[0].snapped).toBe(true);
    expect(big[0].dist).toBeGreaterThan(300);
    expect(max(r, big[0].tick + 1)).toBeLessThan(2);
  });

  it('a short Blink (stopped by a wall, well under the snap distance) also snaps instead of sliding', () => {
    const r = run({
      shipClass: 'tech', ticks: 200, lat: 4, input: (k) => ({ mobility: k === 90, aim: 0 }),
      server: (k, ship, sim) => {
        if (k !== 1) return;
        const m = sim.world.map;
        const col = Math.floor((ship.x + 160) / m.tileSize);
        for (let r2 = 0; r2 < m.rows; r2++) m.tiles[r2 * m.cols + col] = TILE_WALL;
      },
    });
    const big = r.corrections.filter((c) => c.dist > 30);
    expect(big.length).toBe(1);
    expect(big[0].dist).toBeLessThan(220);
    expect(big[0].snapped).toBe(true);
  });

  it('coasting with the afterburner held bleeds speed like the server (NET-11)', () => {
    const r = run({
      shipClass: 'brute', ticks: 240, lat: 4,
      input: (k) => ({ moveX: k < 120 ? 1 : 0, afterburner: k >= 40 }),
    });
    expect(max(r, 60)).toBeLessThan(1);
  });
});

// v0.3 M3 (§5.2): a CTF flag carrier moves at × carrierSpeedMult (and × the host slow-down with its gunner). The
// server side is modelled with the same movement step at the carrier multiplier (the objective sim computes that
// multiplier from the same SHIPFLAG_CARRIER flag the snapshot carries).
describe('prediction: CTF carrier speed', () => {
  it('predictSpeedMult = host slow-down × carrierSpeedMult(flags)', () => {
    expect(predictSpeedMult(0, 0)).toBe(1);
    expect(predictSpeedMult(0, SHIPFLAG_BOT)).toBe(1);
    expect(predictSpeedMult(0, SHIPFLAG_CARRIER)).toBeCloseTo(CTF_CARRIER_SPEED_MULT);
    expect(predictSpeedMult(0, SHIPFLAG_CARRIER | SHIPFLAG_BOT)).toBeCloseTo(CTF_CARRIER_SPEED_MULT);
    // the gunner seat: ≈ ×0.82 (§5.3)
    expect(predictSpeedMult(1, SHIPFLAG_CARRIER)).toBeCloseTo(hostSpeedMult(1) * CTF_CARRIER_SPEED_MULT);
    expect(predictSpeedMult(1, SHIPFLAG_CARRIER)).toBeCloseTo(0.82, 2);
    expect(predictSpeedMult(3, 0)).toBeCloseTo(hostSpeedMult(3));
  });

  /** Server steps the ship at `serverMult`; the client predicts with `clientMult`. Returns the largest correction. */
  function carrierRun(serverMult: number, clientMult: number, lat = 4): number {
    const sim = new Sim({ mapSeed: 5, mode: 'ffa', teamCount: 0, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
    const map = sim.world.map;
    map.tiles.fill(TILE_EMPTY);
    sim.addPlayer({ playerId: 1, name: 'p', team: -1, shipClass: 'brute', isBot: false });
    const stats = [...sim.world.ships.values()][0].stats;
    const server = { x: map.width / 2, y: map.height / 2, vx: 0, vy: 0, angle: 0 };
    const pred = new Predictor(stepShipMovement, DT);
    const ctx: PredictCtx = { stats, map, energy: stats.maxEnergy, speedMult: clientMult, skills: null };
    const toServer: { at: number; inp: InputState }[] = [];
    const toClient: { at: number; ack: number; body: typeof server }[] = [];
    let worst = 0;
    for (let k = 1; k <= 240; k++) {
      const inp: InputState = { ...emptyInput(), moveX: 1, moveY: k < 120 ? 0.4 : -0.4, aim: 0, aimDist: 300, seq: k };
      toServer.push({ at: k + lat, inp });
      pred.applyLocal(inp, pred.body ? ctx : null);
      for (const m of toServer.filter((m) => m.at === k)) {
        stepShipMovement(server, m.inp, stats, map, DT, false, serverMult);
        if (k % 3 === 0) toClient.push({ at: k + lat, ack: m.inp.seq, body: { ...server } });
      }
      for (const s of toClient.filter((s) => s.at === k)) {
        const before = pred.body ? { ...pred.body } : null;
        pred.reconcile(s.body, s.ack, ctx);
        if (before) worst = Math.max(worst, Math.hypot(before.x - pred.body!.x, before.y - pred.body!.y));
      }
    }
    return worst;
  }

  it('a carrier predicted with the carrier multiplier stays on the server path; without it, it rubber-bands', () => {
    const m = predictSpeedMult(0, SHIPFLAG_CARRIER);
    expect(carrierRun(m, m)).toBeLessThan(0.01);
    expect(carrierRun(m, 1)).toBeGreaterThan(2); // the v0.2 predictor (no carrier mult) overshoots every snapshot
    const g = predictSpeedMult(1, SHIPFLAG_CARRIER); // with the gunner
    expect(carrierRun(g, g)).toBeLessThan(0.01);
  });
});

// Flag Overload (§5.3): sim pass 3 recharges a long-carry flag runner at ×0.5 / ×0. The predictor must too, or its
// predicted energy runs ahead and it keeps the afterburner on after the server cut it (rubber-banding).
describe('prediction: CTF Flag Overload recharge', () => {
  it('predictRechargeMult follows flagOverloadMult from the carry clock (negative = not carrying)', () => {
    expect(predictRechargeMult(-1)).toBe(1);
    expect(predictRechargeMult(0)).toBe(1);
    expect(predictRechargeMult(CTF_OVERLOAD_SEC - 0.1)).toBe(1);
    expect(predictRechargeMult(CTF_OVERLOAD_SEC)).toBe(0.5);
    expect(predictRechargeMult(CTF_OVERLOAD_FULL_SEC)).toBe(0);
  });

  /** Server: carrier holding afterburner at low energy with recharge × serverMult; client predicts with clientMult. */
  function overloadRun(serverMult: number, clientMult: number | undefined, lat = 5): { worst: number; mean: number } {
    const sim = new Sim({ mapSeed: 5, mode: 'ffa', teamCount: 0, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
    const map = sim.world.map;
    map.tiles.fill(TILE_EMPTY);
    sim.addPlayer({ playerId: 1, name: 'p', team: -1, shipClass: 'brute', isBot: false });
    const stats = [...sim.world.ships.values()][0].stats;
    const mult = predictSpeedMult(0, SHIPFLAG_CARRIER);
    const server = { x: map.width / 2, y: map.height / 2, vx: 0, vy: 0, angle: 0 };
    let sEnergy = 200;
    const pred = new Predictor(stepShipMovement, DT);
    const ctxAt = (energy: number): PredictCtx => ({ stats, map, energy, speedMult: mult, rechargeMult: clientMult, skills: null });
    const toServer: { at: number; inp: InputState }[] = [];
    const toClient: { at: number; ack: number; body: typeof server; energy: number }[] = [];
    let worst = 0, sum = 0, n = 0, lastEnergy = sEnergy;
    for (let k = 1; k <= 600; k++) {
      const inp: InputState = { ...emptyInput(), moveX: 1, moveY: k < 300 ? 0.3 : -0.3, afterburner: true, aim: 0, aimDist: 300, seq: k };
      toServer.push({ at: k + lat, inp });
      pred.applyLocal(inp, pred.body ? ctxAt(lastEnergy) : null);
      for (const m of toServer.filter((x) => x.at === k)) {
        const moving = Math.hypot(m.inp.moveX, m.inp.moveY) > THRUST_DEADZONE;
        const cost = stats.afterburnerCostPerSec * DT;
        const ab = m.inp.afterburner && moving && sEnergy > cost;
        stepShipMovement(server, m.inp, stats, map, DT, ab, mult);
        if (ab) sEnergy -= cost; else sEnergy = Math.min(stats.maxEnergy, sEnergy + stats.rechargePerSec * serverMult * DT);
        if (k % 3 === 0) toClient.push({ at: k + lat, ack: m.inp.seq, body: { ...server }, energy: sEnergy });
      }
      for (const s of toClient.filter((x) => x.at === k)) {
        lastEnergy = s.energy;
        const before = pred.body ? { ...pred.body } : null;
        pred.reconcile(s.body, s.ack, ctxAt(s.energy));
        if (before) {
          const d = Math.hypot(before.x - pred.body!.x, before.y - pred.body!.y);
          worst = Math.max(worst, d);
          if (k > 2 * TICK_RATE) { sum += d; n++; }
        }
      }
    }
    return { worst, mean: sum / Math.max(1, n) };
  }

  it('an overloaded carrier on afterburner at low energy stays on the server path when the mult is predicted', () => {
    for (const m of [0.5, 0]) {
      const ok = overloadRun(m, m);
      expect(ok.worst, `×${m} predicted`).toBeLessThan(0.05);
      const v02 = overloadRun(m, undefined); // the old predictor: full recharge
      expect(v02.worst, `×${m} unpredicted`).toBeGreaterThan(1);
    }
    expect(overloadRun(1, undefined).worst).toBeLessThan(0.05);
  });

  it('moveSkillsFor: a carrier Ram Charges at × CTF_CARRIER_SPEED_MULT (skills.ts stepCharge × objSpeedMult)', () => {
    const sim = new Sim({ mapSeed: 5, mode: 'ffa', teamCount: 0, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
    sim.addPlayer({ playerId: 1, name: 'p', team: -1, shipClass: 'brute', isBot: false });
    const ship = [...sim.world.ships.values()][0];
    const you = { stats: ship.stats, cdSec: { mobility: 0 }, talents: [] } as unknown as YouState;
    const view = { shipClass: 'brute', flags: 0 } as unknown as ShipView;
    const base = moveSkillsFor(you, view).chargeSpeed;
    expect(moveSkillsFor(you, { ...view, flags: SHIPFLAG_CARRIER }).chargeSpeed).toBeCloseTo(base * CTF_CARRIER_SPEED_MULT);
  });
});
