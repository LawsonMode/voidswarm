// v0.5 capital ships, client side × the REAL Sim (no mocks): a turret docks on a Juggernaut, which becomes a
// Dreadnought. The snapshot → codec → client path must agree with the server: the capital hull radius (never scaled
// twice), the hardpoint the turret sits on, the Broadside cooldown on the Space slot, and own-ship prediction of the
// slower, bigger hull against a wall (no rubber-band, Broadside presses included).
import { describe, expect, it } from 'vitest';
import { DT, TICK_RATE } from '../../shared/constants';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { decodeSnapshot, encodeSnapshot } from '../../shared/net/codec';
import { SnapshotBuilder } from '../../shared/room/snapshot';
import { stepShipMovement } from '../../shared/sim/movement';
import { Sim } from '../../shared/sim/Sim';
import { capitalScale } from '../../shared/sim/world';
import { emptyInput, TILE_EMPTY, TILE_WALL, type InputState, type Ship, type Snapshot } from '../../shared/types';
import { hardpointName } from '../ui/capitalInfo';
import { hostRadii } from './attach';
import { moveSkillsFor, predictSpeedMult, predictStats, Predictor, type PredictCtx } from './prediction';

const inp = (o: Partial<InputState> = {}): InputState => ({ ...emptyInput(), aim: 0, aimDist: 300, ...o });

function world() {
  const sim = new Sim({ mapSeed: 5, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false });
  const map = sim.world.map;
  map.tiles.fill(TILE_EMPTY);
  const add = (pid: number, cls: 'brute' | 'tech') =>
    sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team: 0, shipClass: cls, isBot: false }))!;
  const host = add(1, 'brute');
  const turret = add(2, 'tech');
  host.x = 2000; host.y = 2000; host.vx = host.vy = 0; host.angle = 0;
  return { sim, map, host, turret };
}

/** Dock `turret` on `host` through the Sim's own attach (one attach press aimed at the host). */
function dock(sim: Sim, host: Ship, turret: Ship): void {
  sim.setInput(turret.playerId, { ...inp({ attach: true, attachTarget: host.id }), seq: 1 });
  sim.step();
  sim.setInput(turret.playerId, { ...inp(), seq: 2 });
  sim.step();
  sim.drainEvents();
}

function wire(sim: Sim, pid: number): Snapshot {
  const b = new SnapshotBuilder();
  b.prepare(sim.world, []);
  return decodeSnapshot(encodeSnapshot(b.build({ playerId: pid, spectator: false })));
}

describe('capital host × real Sim → snapshot → codec → client', () => {
  it('the hull radius arrives scaled once; the turret sits on the bow hardpoint; hostRadii agrees', () => {
    const { sim, host, turret } = world();
    dock(sim, host, turret);
    expect(host.turrets).toEqual([turret.id]);
    const s = wire(sim, 1);
    const you = s.you!;
    const R = SHIP_CLASSES.brute.base.radius * capitalScale(1);
    expect(you.stats.radius).toBeCloseTo(R, 4); // the Sim wrote the capital hull into stats.radius
    expect(predictStats(you, 'brute')).toBe(you.stats); // ... so prediction does not scale it again
    const tv = s.ships.find((v) => v.id === turret.id)!;
    expect(tv).toMatchObject({ attachedTo: host.id, turretSlot: 0, turretCount: 1 });
    expect(hardpointName(tv.turretSlot, tv.turretCount)).toBe('bow');
    const hv = s.ships.find((v) => v.id === host.id)!;
    expect(Math.cos(hv.angle) * (tv.x - hv.x) + Math.sin(hv.angle) * (tv.y - hv.y)).toBeGreaterThan(R * 0.5); // ahead
    expect(Math.abs(hostRadii(s.ships).get(host.id)! - R)).toBeLessThan(0.3);
  });

  it('Broadside puts the Space slot on capCooldown (cd.mobility normalized by it), and the client sees broadside', () => {
    const { sim, host, turret } = world();
    dock(sim, host, turret);
    const before = wire(sim, 1).you!;
    const view = { id: host.id, shipClass: 'brute', flags: 0 } as const;
    expect(moveSkillsFor(before, view as never).mobility).toBe('broadside');
    expect(before.cd.mobility).toBe(0);
    sim.setInput(1, { ...inp({ mobility: true }), seq: 10 });
    sim.step();
    const events = sim.drainEvents();
    expect(events.some((e) => e.t === 'ability' && e.shipId === host.id && e.skill === 'broadside')).toBe(true);
    expect(events.some((e) => e.t === 'ability' && e.shipId === host.id && e.skill === 'ram')).toBe(false);
    const after = wire(sim, 1).you!;
    const cap = SHIP_CLASSES.brute.base.skill.capCooldown;
    expect(after.cdSec.mobility).toBeCloseTo(cap, 1);
    expect(after.cd.mobility).toBeGreaterThan(0.98); // full sweep of the capital cooldown, not clamped mobility
    sim.setInput(1, { ...inp(), seq: 11 });
    for (let i = 0; i < (cap / 2) * TICK_RATE; i++) sim.step();
    expect(wire(sim, 1).you!.cd.mobility).toBeCloseTo(0.5, 1);
  });

  it('own-ship prediction follows a Dreadnought into a wall (capital hull, host slow-down, Broadside presses)', () => {
    const { sim, map, host, turret } = world();
    const col = Math.floor(2700 / map.tileSize);
    for (let r = 0; r < map.rows; r++) map.tiles[r * map.cols + col] = TILE_WALL;
    dock(sim, host, turret);
    host.x = 2000; host.y = 2000; host.vx = host.vy = 0; host.angle = 0;

    const lat = 4;
    const pred = new Predictor(stepShipMovement, DT);
    const toServer: { at: number; i: InputState }[] = [];
    const toClient: { at: number; snap: Snapshot }[] = [];
    let latest: Snapshot | null = null;
    const ctxOf = (s: Snapshot): PredictCtx => {
      const you = s.you!, v = s.ships.find((x) => x.id === you.shipId)!;
      return {
        stats: predictStats(you, 'brute'), map, energy: you.energy,
        speedMult: predictSpeedMult(you.turrets.length, v.flags), skills: moveSkillsFor(you, v),
      };
    };
    let worst = 0;
    for (let k = 1; k <= 300; k++) {
      const i: InputState = { ...inp({ moveX: 1, moveY: k < 150 ? 0.2 : -0.2, mobility: k % 70 === 0 }), seq: 100 + k };
      toServer.push({ at: k + lat, i });
      pred.applyLocal(i, latest && pred.body ? ctxOf(latest) : null);
      for (const m of toServer.filter((x) => x.at === k)) sim.setInput(1, m.i);
      sim.setInput(2, { ...inp(), seq: 100 + k });
      sim.step();
      sim.drainEvents();
      if (k % 3 === 0) toClient.push({ at: k + lat, snap: wire(sim, 1) });
      for (const d of toClient.filter((x) => x.at === k)) {
        latest = d.snap;
        const v = d.snap.ships.find((x) => x.id === host.id)!;
        const before = pred.body ? { ...pred.body } : null;
        pred.reconcile(v, d.snap.ackSeq, ctxOf(d.snap));
        if (before && k > 30) worst = Math.max(worst, Math.hypot(before.x - pred.body!.x, before.y - pred.body!.y));
      }
    }
    expect(host.turrets).toEqual([turret.id]); // still a Dreadnought at the end
    const R = SHIP_CLASSES.brute.base.radius * capitalScale(1);
    expect(col * map.tileSize - host.x).toBeCloseTo(R, 0); // the server stopped the capital hull at the wall
    expect(worst).toBeLessThan(1.5); // quantization only: no rubber-band against the wall or on Broadside presses
  });
});
