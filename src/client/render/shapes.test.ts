// RENDER v0.3 M2: ship GraphicsContext cache — cosmetic ids in the key, mark-and-sweep keeps live contexts.
// v0.3 M4: the Matriarch body / layers and her palette entry.
import { describe, expect, it } from 'vitest';
import { TEAM_COLORS } from '../../shared/data/teams';
import { deltaE76, resolveLook, hullFor, turretFor } from './cosmeticLook';
import { ENEMY_COLORS } from './palette';
import {
  EMPTY_CTX, ENEMY_BASE_R, MATRIARCH_GEOM, enemyBody, matriarchPart, shipCacheSize, shipHull, sweepShipCaches,
} from './shapes';

describe('ship hull cache', () => {
  const gravemaw = hullFor(resolveLook({ hull: 'rift.hull.brute' }), 'brute');
  const maw = turretFor(resolveLook({ turret: 'rift.turret.flak' }), 'brute');
  const arcWelder = turretFor(resolveLook({ turret: 'com.turret.laser' }), 'tech'); // tether/beam only, std mount

  it('the cache key includes the hull and (when attached) the mount cosmetic', () => {
    const base = shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, false);
    expect(shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, false)).toBe(base);
    const styled = shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, false, gravemaw);
    expect(styled).not.toBe(base);
    expect(shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, false, gravemaw)).toBe(styled);
    // a mount only matters on an attached turret
    expect(shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, false, null, maw)).toBe(base);
    const turret = shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, true);
    expect(shipHull('brute', 0xff3b5c, 22, -1, 0xffffff, true, null, maw)).not.toBe(turret);
    // a std-mount turret item (tether/beam only) reuses the standard turret hull
    expect(shipHull('tech', 0x3b8bff, 16, -1, 0xffffff, true, null, arcWelder)).toBe(shipHull('tech', 0x3b8bff, 16, -1, 0xffffff, true));
  });

  it('sweep destroys every unreferenced context and keeps the live ones usable', () => {
    const live = shipHull('engineer', 0x3bff7a, 18, 1, 0x7dff5b, false, hullFor(resolveLook({ hull: 'swarm.hull.engineer' }), 'engineer'));
    const dead = shipHull('engineer', 0x3bff7a, 18, 2, 0x5bd0ff, false);
    expect(shipCacheSize()).toBeGreaterThan(2);
    const n = sweepShipCaches(new Set([live]));
    expect(n).toBeGreaterThan(0);
    expect(shipCacheSize()).toBe(1);
    expect(live.destroyed).toBe(false);
    expect(dead.destroyed).toBe(true);
    expect(EMPTY_CTX.destroyed).toBe(false);
    // the live one is still the cached one; the swept key rebuilds a fresh context
    expect(shipHull('engineer', 0x3bff7a, 18, 1, 0x7dff5b, false, hullFor(resolveLook({ hull: 'swarm.hull.engineer' }), 'engineer'))).toBe(live);
    const again = shipHull('engineer', 0x3bff7a, 18, 2, 0x5bd0ff, false);
    expect(again).not.toBe(dead);
    expect(again.destroyed).toBe(false);
  });
});

// RENDER v0.3 M4: the Hive Matriarch replaces the placeholder (an empty context coloured like the Hive).
describe('Matriarch body', () => {
  it('has a real body + three animation layers, sized to her radius', () => {
    const body = enemyBody('matriarch', false);
    const b = body.bounds;
    expect(b.maxX - b.minX).toBeGreaterThan(ENEMY_BASE_R * 1.2);
    // visual extent stays within ~1.25 × the collision radius (drawn at ENEMY_BASE_R, scaled by radius / BASE_R)
    for (const v of [b.minX, b.maxX, b.minY, b.maxY]) expect(Math.abs(v)).toBeLessThanOrEqual(ENEMY_BASE_R * 1.25);
    for (const part of [0, 1, 2] as const) {
      const pb = matriarchPart(part).bounds;
      expect(pb.maxX - pb.minX, `part ${part}`).toBeGreaterThan(0);
      for (const v of [pb.minX, pb.maxX, pb.minY, pb.maxY]) expect(Math.abs(v)).toBeLessThanOrEqual(ENEMY_BASE_R * 1.3);
    }
    expect(matriarchPart(1)).toBe(matriarchPart(1)); // cached
    expect(MATRIARCH_GEOM.brood.length).toBe(6);
  });

  it('her colour is her own: apart from the Hive, every other enemy and every team colour', () => {
    expect(ENEMY_COLORS.matriarch).not.toBe(ENEMY_COLORS.hive);
    for (const [k, c] of Object.entries(ENEMY_COLORS)) if (k !== 'matriarch') expect(deltaE76(ENEMY_COLORS.matriarch, c), k).toBeGreaterThan(30);
    for (const c of TEAM_COLORS) expect(deltaE76(ENEMY_COLORS.matriarch, c)).toBeGreaterThan(30);
  });
});
