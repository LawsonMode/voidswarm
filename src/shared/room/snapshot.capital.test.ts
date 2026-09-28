// v0.5 capital ships in the per-client snapshot: the Space slot's cooldown is normalized by capCooldown while the
// ship hosts turrets (the capital skill replaces mobility on the same ready tick), the hardpoint slot / count reach
// every viewer through the existing ShipView fields, and the whole thing survives the binary codec (PROTOCOL 5).
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import { decodeSnapshot, encodeSnapshot } from '../net/codec';
import { Sim } from '../sim/Sim';
import type { Ship, ShipClassId, SimConfig } from '../types';
import { SPACE_CD_TICKS } from '../sim/capital';
import { SnapshotBuilder, spaceCooldownSec } from './snapshot';

const cfg: SimConfig = { mapSeed: 77, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false };

function setup(hostClass: ShipClassId, turretClasses: ShipClassId[]) {
  const sim = new Sim(cfg);
  const add = (pid: number, cls: ShipClassId) =>
    sim.world.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team: 0, shipClass: cls, isBot: false }))!;
  const host = add(1, hostClass);
  const turrets = turretClasses.map((c, i) => add(10 + i, c));
  return { sim, host, turrets };
}

/** Dock `turrets` on `host` the way the Sim's attach does (ids in slot order). */
function dock(host: Ship, turrets: Ship[]): void {
  for (const t of turrets) { t.attachedTo = host.id; host.turrets.push(t.id); }
}

function snapFor(sim: Sim, pid: number) {
  const b = new SnapshotBuilder();
  b.prepare(sim.world, []);
  return b.build({ playerId: pid, spectator: false });
}

describe('snapshot: the capital skill cooldown on the Space slot', () => {
  it('hosting: cd.mobility is normalized by capCooldown; hosting nobody: by mobilityCooldown (as before)', () => {
    const { sim, host, turrets } = setup('brute', ['tech']);
    const tick = sim.world.tick;
    const capCd = SHIP_CLASSES.brute.base.skill.capCooldown, mobCd = SHIP_CLASSES.brute.base.mobilityCooldown;
    host.mobilityReadyTick = tick + Math.round((capCd / 2) * TICK_RATE);

    let you = snapFor(sim, 1).you!;
    expect(you.cd.mobility).toBeCloseTo(Math.min(1, capCd / 2 / mobCd), 6); // unchanged v0.4 behaviour
    expect(you.cdSec.mobility).toBeCloseTo(capCd / 2, 6);

    dock(host, turrets);
    you = snapFor(sim, 1).you!;
    expect(you.turrets).toEqual([turrets[0].id]);
    expect(you.cd.mobility).toBeCloseTo(0.5, 6);
    expect(you.cdSec.mobility).toBeCloseTo(capCd / 2, 6);
    // the turret's own Space slot is not a capital slot
    expect(spaceCooldownSec(turrets[0])).toBe(turrets[0].stats.mobilityCooldown);
    expect(spaceCooldownSec(host)).toBe(capCd);
  });

  it('a running cooldown is normalized by the skill that started it, across a capital form change', () => {
    const { sim, host, turrets } = setup('brute', ['tech']);
    const mobCd = SHIP_CLASSES.brute.base.mobilityCooldown, capCd = SHIP_CLASSES.brute.base.skill.capCooldown;
    expect(mobCd).not.toBe(capCd);
    const tick = sim.world.tick;
    // Ram Charge (mobilityCooldown) just used, then a turret docks: the sweep starts full, not at mobCd / capCd
    host.mobilityReadyTick = tick + Math.round(mobCd * TICK_RATE);
    host.skillState[SPACE_CD_TICKS] = Math.round(mobCd * TICK_RATE);
    dock(host, turrets);
    expect(snapFor(sim, 1).you!.cd.mobility).toBeCloseTo(1, 6);
    // Broadside (capCooldown) just used, then the last turret leaves: it counts down from full, never clamped
    host.mobilityReadyTick = tick + Math.round((capCd / 2) * TICK_RATE);
    host.skillState[SPACE_CD_TICKS] = Math.round(capCd * TICK_RATE);
    host.turrets.length = 0; turrets[0].attachedTo = 0;
    expect(snapFor(sim, 1).you!.cd.mobility).toBeCloseTo(0.5, 6);
    // the real skills record it: a Ram press stores mobilityCooldown's ticks
    host.mobilityReadyTick = 0; delete host.skillState[SPACE_CD_TICKS];
    host.energy = host.stats.maxEnergy;
    sim.setInput(1, { ...host.input, mobility: true, seq: host.input.seq + 1 });
    sim.step();
    expect(host.skillState[SPACE_CD_TICKS]).toBe(Math.round(mobCd * TICK_RATE));
  });

  it('falls back to mobilityCooldown when the class has no capCooldown knob', () => {
    const { host, turrets } = setup('engineer', ['brute']);
    dock(host, turrets);
    host.stats = { ...host.stats, skill: { ...host.stats.skill } };
    delete host.stats.skill.capCooldown;
    expect(spaceCooldownSec(host)).toBe(host.stats.mobilityCooldown);
  });

  it('every viewer gets each turret\'s hardpoint slot + count (capital state is derived from them client-side)', () => {
    const { sim, host, turrets } = setup('engineer', ['brute', 'tech', 'engineer']);
    dock(host, turrets);
    const s = snapFor(sim, 11);
    const hv = s.ships.find((v) => v.id === host.id)!;
    expect(hv.turretCount).toBe(3);
    expect(hv.turretSlot).toBe(-1);
    turrets.forEach((t, i) => {
      const v = s.ships.find((x) => x.id === t.id)!;
      expect(v).toMatchObject({ attachedTo: host.id, turretSlot: i, turretCount: 3 });
    });
  });

  it('a hosting snapshot round-trips the codec: capital knobs exact, capital cooldown, hardpoint fields', () => {
    for (const cls of ['brute', 'tech', 'engineer'] as const) {
      const { sim, host, turrets } = setup(cls, ['tech', 'tech']);
      dock(host, turrets);
      host.mobilityReadyTick = sim.world.tick + 3 * TICK_RATE;
      const s = snapFor(sim, 1);
      const d = decodeSnapshot(encodeSnapshot(s));
      const want = SHIP_CLASSES[cls].base.skill;
      for (const k of Object.keys(want)) expect(d.you!.stats.skill[k], `${cls}.${k}`).toBe(want[k]);
      expect(d.you!.stats.skill.capCooldown).toBe(want.capCooldown);
      expect(Math.abs(d.you!.cd.mobility - 3 / want.capCooldown)).toBeLessThanOrEqual(0.0005 + 1e-9); // tail rounds to 1e-3
      expect(d.you!.turrets).toEqual(turrets.map((t) => t.id));
      for (const [i, t] of turrets.entries()) {
        expect(d.ships.find((v) => v.id === t.id)).toMatchObject({ attachedTo: host.id, turretSlot: i, turretCount: 2 });
      }
      expect(d.ships.find((v) => v.id === host.id)!.turretCount).toBe(2);
    }
  });
});
