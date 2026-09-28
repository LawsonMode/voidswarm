// RENDER v0.5: capital ships + bubble turrets — hardpoint sockets, the host-radius estimate, the capital morph, turret
// fire presets (every catalog item mapped, kit-compatible, bounded), the capital hull / dome geometry (sockets on the
// hull, team colour on the outline) and the per-frame cost of the pure capital path at 32 ships.
import { describe, expect, it } from 'vitest';
import type { GraphicsContext } from 'pixi.js';
import { HARDPOINT_SEAT, MAX_HARDPOINTS } from '../../shared/constants';
import { COSMETIC_LIST, COSMETICS } from '../../shared/data/cosmetics';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { HARDPOINT_LAYOUT, capitalScale, turretOffset } from '../../shared/sim/world';
import type { ShipClassId, TurretKitId } from '../../shared/types';
import {
  BARREL_LEN, CAP_REF, DOME_R, FIRE_BOUNDS, FIRE_CODE, FIRE_PRESETS, HARDPOINT_SOCKETS, KIT_DEFAULT_FIRE, MORPH_SEC, REFLOW_SEC,
  TAG_NEAR, TURRET_FIRE, estimateHostRadius, firePresetFor, mountNorm, mountOf, mountOffset, newMorph, socketOf, stepMorph,
  turretTagAlpha, unmappedTurretItems, type FireStyle,
  LASER_SPARKS_MAX, OC_HALO_MAX_W, domeScale, laserBeamLook, laserSparks,
} from './capital';
import { resolveLook, turretFor } from './cosmeticLook';
import {
  CAPITAL_GEOM, SOCKET_UNIT, capitalAux, capitalHull, domeBarrel, domeBase, hullPolys, modCapitalPolys, pointInPoly, polyExtent,
} from './shapes';

const CLASSES: ShipClassId[] = ['brute', 'tech', 'engineer'];

describe('hardpoints', () => {
  it('sockets = every distinct HARDPOINT_LAYOUT mount (layout[5] + the 3-turret centre aft)', () => {
    expect(HARDPOINT_SOCKETS.length).toBe(6);
    for (const m of HARDPOINT_LAYOUT[5]) expect(HARDPOINT_SOCKETS).toContainEqual(m);
    for (let n = 1; n <= MAX_HARDPOINTS; n++) {
      for (let slot = 0; slot < n; slot++) {
        expect(socketOf(n, slot), `${n}/${slot}`).toBeGreaterThanOrEqual(0);
        expect(mountOf(n, slot)).toEqual(HARDPOINT_LAYOUT[n][slot]);
      }
    }
    // clamped like turretOffset: count 0 / 9 and out-of-range slots still resolve
    expect(mountOf(0, 0)).toEqual(HARDPOINT_LAYOUT[1][0]);
    expect(mountOf(9, 7)).toEqual(HARDPOINT_LAYOUT[5][4]);
  });

  it('the host radius is recovered exactly from any turret separation, and mountOffset is turretOffset', () => {
    for (const cls of CLASSES) {
      for (let n = 1; n <= MAX_HARDPOINTS; n++) {
        const R = SHIP_CLASSES[cls].base.radius * capitalScale(n) * 1.1; // talents may grow it further
        for (let slot = 0; slot < n; slot++) {
          for (const ang of [0, 1, -2.5]) {
            const o = turretOffset(ang, slot, n, R);
            const est = estimateHostRadius(Math.hypot(o.dx, o.dy), n, slot, 1, 999, -1);
            expect(est).toBeCloseTo(R, 6);
            const out = { x: 0, y: 0 };
            const [a, s] = mountOf(n, slot);
            mountOffset(ang, a, s, R, out);
            expect(out.x).toBeCloseTo(o.dx, 9);
            expect(out.y).toBeCloseTo(o.dy, 9);
          }
        }
      }
    }
    expect(estimateHostRadius(1e6, 2, 0, 20, 40, 30)).toBe(40);
    expect(estimateHostRadius(0, 2, 0, 20, 40, 30)).toBe(20);
    expect(estimateHostRadius(Number.NaN, 2, 0, 20, 40, 30)).toBe(30);
    expect(mountNorm(1, 0)).toBeCloseTo(0.95, 9);
  });

  it('the dome and its barrel stay compact (the dome is the turret hitbox)', () => {
    expect(DOME_R).toBe(9);
    expect(BARREL_LEN).toBeGreaterThan(DOME_R);
    expect(BARREL_LEN).toBeLessThanOrEqual(DOME_R * 1.6);
  });
});

describe('capital morph', () => {
  const run = (m: ReturnType<typeof newMorph>, cap: boolean, scale: number, sec: number, dt = 1 / 60) => {
    const evs: string[] = [];
    let peak = 0;
    for (let t = 0; t < sec - 1e-9; t += dt) { const e = stepMorph(m, cap, scale, dt); if (e) evs.push(e); peak = Math.max(peak, m.vis); }
    return { evs, peak };
  };

  it('a first step snaps silently (a ship first seen as a capital does not flash)', () => {
    const m = newMorph();
    expect(stepMorph(m, true, capitalScale(3), 1 / 60)).toBeNull();
    expect(m.vis).toBeCloseTo(capitalScale(3), 9);
    expect(m.capA).toBe(1);
    expect(m.flash).toBe(0);
  });

  it('first turret: "up" once, 0.35 s scale-up with a small overshoot, crossfade and a flash that fades', () => {
    const m = newMorph();
    stepMorph(m, false, 1, 1 / 60);
    const target = capitalScale(1);
    const r = run(m, true, target, MORPH_SEC + 0.02);
    expect(r.evs).toEqual(['up']);
    expect(m.vis).toBeCloseTo(target, 9);
    expect(m.capA).toBe(1);
    expect(m.flash).toBe(0);
    expect(r.peak).toBeGreaterThan(target); // a punchy scale-up …
    expect(r.peak).toBeLessThan(target + 0.2 * (target - 1)); // … that settles
  });

  it('turret count changes re-flow the scale without a transform; the last turret leaving folds back', () => {
    const m = newMorph();
    stepMorph(m, true, capitalScale(1), 1 / 60);
    const a = run(m, true, capitalScale(4), REFLOW_SEC + 0.02);
    expect(a.evs).toEqual([]);
    expect(m.vis).toBeCloseTo(capitalScale(4), 9);
    const b = run(m, false, 1, MORPH_SEC + 0.02);
    expect(b.evs).toEqual(['down']);
    expect(m.vis).toBe(1);
    expect(m.capA).toBe(0);
    expect(b.peak).toBeLessThanOrEqual(capitalScale(4) + 1e-9); // shrinking never overshoots up
  });

  it('garbage input never produces NaN', () => {
    const m = newMorph();
    stepMorph(m, false, 1, 1 / 60);
    stepMorph(m, true, Number.NaN, Number.NaN);
    stepMorph(m, true, Number.POSITIVE_INFINITY, 1 / 60);
    for (const v of [m.vis, m.capA, m.flash]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('turret fire presets', () => {
  it('every catalog turret item maps to a preset of its own kit', () => {
    expect(unmappedTurretItems()).toEqual([]);
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'turret') continue;
      const p = FIRE_PRESETS[TURRET_FIRE[d.id]];
      expect(p, d.id).toBeDefined();
      expect(p.kit, d.id).toBe(d.kit);
      // and the resolved look reaches it
      const cls = CLASSES.find((c) => SHIP_CLASSES[c].turret.id === d.kit)!;
      expect(firePresetFor(turretFor(resolveLook({ turret: d.id }), cls), d.kit).id, d.id).toBe(p.id);
    }
    for (const id of Object.keys(TURRET_FIRE)) expect(COSMETICS[id], id).toBeDefined();
  });

  it('the catalog shows every fire style: tracer, laser, mass driver, flak burst, seeker exhaust', () => {
    const styles = new Set<FireStyle>();
    for (const d of COSMETIC_LIST) if (d.slot === 'turret') styles.add(FIRE_PRESETS[TURRET_FIRE[d.id]].style);
    expect([...styles].sort()).toEqual(['flak', 'laser', 'massdriver', 'seeker', 'tracer']);
    const beams = new Set(Object.values(FIRE_PRESETS).filter((p) => p.style === 'laser').map((p) => p.beam));
    expect(beams.size).toBeGreaterThanOrEqual(4);
  });

  it('starter, unknown and wrong-kit looks fall back to the kit default', () => {
    for (const kit of ['flak', 'laser', 'seekerpod'] as TurretKitId[]) {
      expect(firePresetFor(null, kit).id).toBe(KIT_DEFAULT_FIRE[kit]);
      expect(FIRE_PRESETS[KIT_DEFAULT_FIRE[kit]].kit).toBe(kit);
    }
    const laserLook = turretFor(resolveLook({ turret: 'glad.turret.laser' }), 'tech');
    expect(firePresetFor(laserLook, 'flak').id).toBe('flak');
    expect(firePresetFor({ id: 'nope', kit: 'flak', p: laserLook!.p }, 'flak').id).toBe('flak');
  });

  it('presets are bounded and carry no colours (team colour + the ΔE-checked item accent only)', () => {
    for (const p of Object.values(FIRE_PRESETS)) {
      expect(p.tail, p.id).toBeLessThanOrEqual(FIRE_BOUNDS.tailMax);
      expect(p.muzzle, p.id).toBeLessThanOrEqual(FIRE_BOUNDS.muzzleMax);
      expect(p.recoil, p.id).toBeLessThanOrEqual(FIRE_BOUNDS.recoilMax);
      expect(p.shock, p.id).toBeLessThanOrEqual(FIRE_BOUNDS.shockMax);
      expect(p.slug, p.id).toBeLessThanOrEqual(FIRE_BOUNDS.slugMax);
      expect(p.puffs, p.id).toBeLessThanOrEqual(FIRE_BOUNDS.puffsMax);
      for (const k of Object.keys(p)) expect(/colou?r|tint|accent/i.test(k), `${p.id}.${k}`).toBe(false);
      if (p.style === 'massdriver') { expect(p.shock).toBeGreaterThan(0); expect(p.slug).toBeGreaterThan(0); expect(p.recoil).toBeGreaterThan(3); }
    }
    expect(new Set(Object.values(FIRE_CODE)).size).toBe(Object.keys(FIRE_CODE).length);
  });

  it('turret tags only show under the reticle', () => {
    expect(turretTagAlpha(0)).toBe(1);
    expect(turretTagAlpha(TAG_NEAR)).toBe(0);
    expect(turretTagAlpha(500)).toBe(0);
    expect(turretTagAlpha(Number.NaN)).toBe(0);
    expect(turretTagAlpha(TAG_NEAR * 0.75)).toBeGreaterThan(0);
  });
});

/** Stroke instructions of a context: [color, alpha, width]. */
function strokes(ctx: GraphicsContext): { color: number; alpha: number; width: number }[] {
  const out: { color: number; alpha: number; width: number }[] = [];
  for (const ins of ctx.instructions) {
    if (ins.action !== 'stroke') continue;
    const st = (ins as unknown as { data: { style: { color: number; alpha: number; width: number } } }).data.style;
    out.push({ color: st.color, alpha: st.alpha, width: st.width });
  }
  return out;
}

describe('capital hulls + domes', () => {
  it('every hardpoint socket lies on the capital hull (all classes, every cosmetic shape)', () => {
    for (const cls of CLASSES) {
      for (const polys of [CAPITAL_GEOM[cls].polys, modCapitalPolys(cls, 'spiked', 1), modCapitalPolys(cls, 'swept', 1), modCapitalPolys(cls, 'crest', 1)]) {
        for (const [x, y] of SOCKET_UNIT) expect(polys.some((p) => pointInPoly(x, y, p)), `${cls} socket ${x.toFixed(2)},${y.toFixed(2)}`).toBe(true);
      }
    }
    expect(SOCKET_UNIT[0][0]).toBeCloseTo(HARDPOINT_SOCKETS[0][0] * HARDPOINT_SEAT, 9);
  });

  it('capital silhouettes stay close to their hitbox (≤ 1.2× the base hull extent; cosmetic shapes ≤ 1.12× the capital)', () => {
    for (const cls of CLASSES) {
      const cap = polyExtent(CAPITAL_GEOM[cls].polys);
      expect(cap / polyExtent(hullPolys(cls)), cls).toBeLessThanOrEqual(1.2);
      for (const shape of ['spiked', 'swept', 'crest'] as const) {
        for (const a of [0.5, 1, 7]) expect(polyExtent(modCapitalPolys(cls, shape, a)) / cap, `${cls} ${shape} ${a}`).toBeLessThanOrEqual(1.12 + 1e-9);
      }
    }
  });

  it('team identity: the capital outline and the dome ring are the team colour (accents stay secondary)', () => {
    const team = 0xff3b5c, accent = 0xd8b35a;
    for (const cls of CLASSES) {
      for (const path of [-1, 0, 1, 2]) {
        const ctx = capitalHull(cls, team, 22 * CAP_REF, path, accent);
        const full = strokes(ctx).filter((s) => s.alpha >= 0.99);
        const widest = full.reduce((a, b) => (b.width > a.width ? b : a));
        expect(widest.color, `${cls}/${path}`).toBe(team);
        expect(capitalHull(cls, team, 22 * CAP_REF, path, accent)).toBe(ctx); // cached
      }
      const aux = capitalAux(cls, team, 22 * CAP_REF, team);
      if (cls === 'brute') expect(aux).toBeNull(); else expect(aux).not.toBeNull();
    }
    const dome = domeBase(team, 0xd6ccff);
    const ring = strokes(dome).filter((s) => s.alpha >= 0.99).reduce((a, b) => (b.width > a.width ? b : a));
    expect(ring.color).toBe(team);
    const b = dome.bounds;
    for (const v of [b.minX, b.maxX, b.minY, b.maxY]) expect(Math.abs(v)).toBeLessThanOrEqual(DOME_R + 6);
  });

  it('the turret paths\' trim (Bulwark plating, Architect scaffold) stays inside the capital outline', () => {
    const team = 0xff3b5c, accent = 0x5bd0ff, R = 22 * CAP_REF;
    for (const cls of ['brute', 'engineer'] as const) {
      const plain = capitalHull(cls, team, R, -1, accent).bounds, trim = capitalHull(cls, team, R, 2, accent).bounds;
      expect(trim.maxX, cls).toBeLessThanOrEqual(plain.maxX + 0.5);
      expect(trim.maxY, cls).toBeLessThanOrEqual(plain.maxY + 0.5);
      expect(trim.minX, cls).toBeGreaterThanOrEqual(plain.minX - 0.5);
      expect(trim.minY, cls).toBeGreaterThanOrEqual(plain.minY - 0.5);
    }
  });

  it('domes shrink on a small hull: at 5 turrets they cover at most 45 % of any capital (the hitbox stays DOME_R)', () => {
    for (const cls of CLASSES) {
      const hostR = SHIP_CLASSES[cls].base.radius * capitalScale(MAX_HARDPOINTS);
      const r = DOME_R * domeScale(hostR);
      expect(r).toBeLessThanOrEqual(DOME_R);
      expect((MAX_HARDPOINTS * r * r) / (hostR * hostR), cls).toBeLessThanOrEqual(0.45);
    }
    expect(domeScale(40)).toBe(1); // a big Dreadnought keeps full-size domes
    expect(domeScale(0)).toBe(1);
    expect(domeScale(Number.NaN)).toBe(1);
  });

  it('laser beams: v0.2 widths up to resonance 4, then capped (resonance 6 = a 5-laser Spire + Overcharge)', () => {
    const r4 = laserBeamLook(4), r6 = laserBeamLook(6);
    expect(laserBeamLook(1).outerW).toBeCloseTo(4, 9);
    expect(r4.outerW).toBeCloseTo(4 * Math.pow(1.5 ** 3, 1.15), 9); // the v0.2 formula, untouched
    expect(r6.outerW).toBe(r4.outerW);
    expect(r6.glowW).toBeLessThanOrEqual(28);
    expect(laserBeamLook(6, 1.12).glowW).toBeLessThanOrEqual(31);
    expect(r6.haloW).toBeLessThanOrEqual(OC_HALO_MAX_W);
    expect(r6.over).toBe(2);
    expect(r6.strands).toBeLessThanOrEqual(4);
    expect(r6.stack).toBeLessThan(r4.stack); // stacked beams on one target thin their glow
    expect(laserBeamLook(2).stack).toBe(1);
    for (const res of [1, 3, 6, 9]) expect(laserSparks(res, 1)).toBeLessThanOrEqual(LASER_SPARKS_MAX);
    expect(laserSparks(1, 1)).toBe(1);
    expect(laserSparks(6, 0)).toBe(0);
  });

  it('dome barrels differ per kit and per cosmetic mount, and are cached', () => {
    const c = 0x3b8bff;
    const flak = domeBarrel('flak', c), laser = domeBarrel('laser', c), pod = domeBarrel('seekerpod', c);
    expect(new Set([flak, laser, pod]).size).toBe(3);
    expect(domeBarrel('flak', c)).toBe(flak);
    const maw = turretFor(resolveLook({ turret: 'rift.turret.flak' }), 'brute'); // jaw mount
    expect(domeBarrel('flak', c, maw)).not.toBe(flak);
    const scrap = turretFor(resolveLook({ turret: 'com.turret.flak' }), 'brute'); // std mount → the kit barrel
    expect(domeBarrel('flak', c, scrap)).toBe(flak);
    for (const ctx of [flak, laser, pod]) expect(ctx.bounds.maxX).toBeLessThanOrEqual(BARREL_LEN + 2);
  });
});

describe('perf', () => {
  it('the pure per-frame capital path at 32 ships (8 capitals × 3 domes) costs well under 0.3 ms', () => {
    const hosts = Array.from({ length: 8 }, () => newMorph());
    const mounts = Array.from({ length: 24 }, () => ({ a: 0, s: 0 }));
    const looks = ['com.turret.flak', 'glad.turret.laser', 'swarm.turret.seekerpod'].map((id, i) => turretFor(resolveLook({ turret: id }), CLASSES[i]));
    const kits: TurretKitId[] = ['flak', 'laser', 'seekerpod'];
    const out = { x: 0, y: 0 };
    const frames = 3000;
    let sink = 0;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      const n = 1 + (Math.floor(f / 90) % 5);
      for (let h = 0; h < 8; h++) {
        const m = hosts[h];
        stepMorph(m, n > 0, capitalScale(n), 1 / 60);
        for (let k = 0; k < 3; k++) {
          const slot = k % n;
          const est = estimateHostRadius(30 + k, n, slot, 20, 60, 30);
          const [ta, ts] = mountOf(n, slot);
          const q = mounts[h * 3 + k];
          q.a += (ta - q.a) * 0.2; q.s += (ts - q.s) * 0.2;
          mountOffset(f * 0.01, q.a, q.s, est, out);
          const fp = firePresetFor(looks[k], kits[k]);
          sink += out.x + FIRE_CODE[fp.style] + turretTagAlpha(Math.abs(out.y));
        }
        sink += m.vis;
      }
    }
    const perFrame = (performance.now() - t0) / frames;
    expect(Number.isFinite(sink)).toBe(true);
    expect(perFrame).toBeLessThan(0.3);
  });
});
