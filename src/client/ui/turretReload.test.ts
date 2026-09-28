import { describe, expect, it } from 'vitest';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { turretOffenseCooldown, TurretReload } from './turretReload';

describe('turret offense reload sweep (F8)', () => {
  it('knows each kit reload', () => {
    expect(turretOffenseCooldown('flak', { flakCd: 0.45 })).toBe(0.45);
    expect(turretOffenseCooldown('seekerpod', {})).toBe(1);
    expect(turretOffenseCooldown('laser', { laserDps: 1 })).toBe(0); // continuous
    const eng = SHIP_CLASSES.engineer;
    expect(turretOffenseCooldown(eng.turret.id, eng.base.skill)).toBeGreaterThan(eng.base.gunCooldown);
  });

  it('sweeps down over the kit reload even while the class-normalized cd.primary sits clamped at 1', () => {
    // Artificer: gunCooldown 0.1 s, Seeker Volley 1 s -> cd.primary is 1 for the first 0.9 s.
    const r = new TurretReload();
    const gun = 0.1, kit = 1;
    expect(r.frac(0, gun, kit, 0)).toBe(0);
    expect(r.frac(1, gun, kit, 0)).toBeCloseTo(1);
    expect(r.frac(1, gun, kit, 500)).toBeCloseTo(0.5);
    expect(r.frac(1, gun, kit, 850)).toBeCloseTo(0.15);
    expect(r.frac(1, gun, kit, 950)).toBeCloseTo(0.1); // never below what the server guarantees (>= gunCooldown left)
    expect(r.frac(0.5, gun, kit, 950)).toBeCloseTo(0.05); // exact once unclamped
    expect(r.frac(0, gun, kit, 1000)).toBe(0);
  });

  it('restarts on back-to-back volleys (no ready snapshot in between)', () => {
    const r = new TurretReload();
    r.frac(1, 0.1, 1, 0);
    r.frac(0.3, 0.1, 1, 970);
    expect(r.frac(1, 0.1, 1, 1000)).toBeCloseTo(1); // new volley
  });

  it('shows nothing for the continuous laser', () => {
    expect(new TurretReload().frac(1, 0.2, 0, 0)).toBe(0);
  });
});
