// RENDER acceptance (v0.3 M2, proposal §6.8 / §9): the cosmetic readability contract.
//  1. every catalog accent: CIE76 ΔE ≥ 20 from every TEAM_COLORS / ENEMY_COLORS / ENEMY_COLOR entry, or HSV sat ≤ 0.30
//  2. weapon lengthMul 0.8–1.6 (visual length 0.8–1.6×, width ≤ 1.3×)
//  3. death presets: ≤ 70 particles, linger ≤ 1.5 s
//  4. engine: rateMul ≤ 1.5, accent mix ≤ 0.5
//  5. hull silhouette ≤ 1.12×, patterns stay inside the hull
//  + look resolution fallbacks and the per-frame cost of the pure look path at 32 ships.
import { describe, expect, it } from 'vitest';
import { COSMETIC_LIST, COSMETICS, type DeathParams, type EngineParams } from '../../shared/data/cosmetics';
import { ENEMY_COLOR, TEAM_COLORS } from '../../shared/data/teams';
import type { PlayerInfo } from '../../shared/protocol';
import type { CosmeticLoadout, PlayerId, ShipClassId } from '../../shared/types';
import type { SpawnOpts } from './particles';
import { ENEMY_COLORS } from './palette';
import {
  LookTable, READABILITY, READABILITY_REFS, STARTER_LOOK, WEAPON_SHAPE_METRICS, deltaE76, hsvSaturation, hullFor,
  isReadableAccent, killIconFor, minDeltaE, resolveLook, safeAccent, titleFor, turretFor, weaponFor, weaponVisualRatio,
} from './cosmeticLook';
import { emitDeathPreset, emitEngine, pastel, type FxAtlas } from './cosmeticFx';
import { hullPatternSegments, hullPolys, modHullPolys, pointInPoly, polyExtent } from './shapes';

/** Every colour a catalog item uses as an accent (hull/weapon/turret/death accents, engine tints, title colours). */
function catalogAccents(): { id: string; what: string; c: number }[] {
  const out: { id: string; what: string; c: number }[] = [];
  for (const d of COSMETIC_LIST) {
    switch (d.slot) {
      case 'hull': case 'weapon': case 'turret': case 'death': out.push({ id: d.id, what: 'accent', c: d.p.accent }); break;
      case 'engine': if (typeof d.p.tint === 'number') out.push({ id: d.id, what: 'tint', c: d.p.tint }); break;
      case 'title': out.push({ id: d.id, what: 'color', c: d.p.color }); break;
      default: break;
    }
  }
  return out;
}

const tex = {} as never;
const ATLAS: FxAtlas = { soft: tex, dot: tex, streak: tex, diamond: tex, shard: tex, crystal: tex, ring: tex, wShard: tex };

function counter() {
  const got: SpawnOpts[] = [];
  return { got, spawn: (o: SpawnOpts) => { got.push(o); } };
}
const noHost = { ring: () => {}, flash: () => {} };

describe('readability: accent colours', () => {
  it('ΔE76 is a real Lab distance', () => {
    expect(deltaE76(0x123456, 0x123456)).toBe(0);
    expect(deltaE76(0xffffff, 0x000000)).toBeCloseTo(100, 0);
    expect(hsvSaturation(0xffffff)).toBe(0);
    expect(hsvSaturation(0xff0000)).toBe(1);
  });

  it('references cover every team colour, every enemy colour and the swarm projectile colour', () => {
    for (const c of TEAM_COLORS) expect(READABILITY_REFS).toContain(c);
    for (const c of Object.values(ENEMY_COLORS)) expect(READABILITY_REFS).toContain(c);
    expect(READABILITY_REFS).toContain(ENEMY_COLOR);
  });

  it('every catalog accent has ΔE ≥ 20 from all team/enemy colours or saturation ≤ 0.30', () => {
    const acc = catalogAccents();
    expect(acc.length).toBeGreaterThan(40);
    const bad = acc.filter((a) => !(minDeltaE(a.c) >= READABILITY.minDeltaE || hsvSaturation(a.c) <= READABILITY.maxSaturation))
      .map((a) => `${a.id}.${a.what} 0x${a.c.toString(16)} ΔE ${minDeltaE(a.c).toFixed(1)} sat ${hsvSaturation(a.c).toFixed(2)}`);
    expect(bad).toEqual([]);
  });

  it('the lowest-ΔE saturated catalog accent is BRASS at ≈ 28.6 (matches the proposal)', () => {
    const sat = catalogAccents().filter((a) => hsvSaturation(a.c) > READABILITY.maxSaturation);
    const worst = Math.min(...sat.map((a) => minDeltaE(a.c)));
    expect(worst).toBeGreaterThanOrEqual(20);
    expect(worst).toBeCloseTo(28.6, 0);
  });

  it('safeAccent repairs an unreadable accent (e.g. a team colour itself) and leaves good ones alone', () => {
    for (const c of TEAM_COLORS) {
      expect(isReadableAccent(c)).toBe(false);
      expect(isReadableAccent(safeAccent(c))).toBe(true);
    }
    for (const a of catalogAccents()) expect(safeAccent(a.c)).toBe(a.c);
  });

  it('prism engine particles are always low-saturation pastels', () => {
    for (let h = 0; h < 1; h += 0.01) expect(hsvSaturation(pastel(h))).toBeLessThanOrEqual(READABILITY.maxSaturation);
  });
});

describe('readability: weapons', () => {
  it('every weapon lengthMul is within 0.8–1.6 and its visual stays 0.8–1.6× long, ≤ 1.3× wide', () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'weapon') continue;
      expect(d.p.lengthMul, d.id).toBeGreaterThanOrEqual(READABILITY.lengthMulMin);
      expect(d.p.lengthMul, d.id).toBeLessThanOrEqual(READABILITY.lengthMulMax);
      const m = WEAPON_SHAPE_METRICS[d.p.shape];
      const rawLen = m.len * d.p.lengthMul; // unclamped: the catalog must not rely on the runtime clamp
      expect(rawLen, d.id).toBeGreaterThanOrEqual(READABILITY.lengthMulMin);
      expect(rawLen, d.id).toBeLessThanOrEqual(READABILITY.lengthMulMax);
      expect(m.wid, d.id).toBeLessThanOrEqual(READABILITY.widthMax);
    }
  });

  it('runtime clamps out-of-range weapon numbers', () => {
    const r = weaponVisualRatio({ shape: 'needle', lengthMul: 9, core: 'white', accent: 0xffffff, muzzle: 'std' });
    expect(r.len).toBeLessThanOrEqual(READABILITY.lengthMulMax);
    expect(r.wid).toBeLessThanOrEqual(READABILITY.widthMax);
    const l = weaponVisualRatio({ shape: 'orb', lengthMul: 0.1, core: 'white', accent: 0xffffff, muzzle: 'std' });
    expect(l.len).toBeGreaterThanOrEqual(READABILITY.lengthMulMin);
  });
});

describe('readability: death presets', () => {
  it('catalog death params: ≤ 70 particles, linger ≤ 1.5 s', () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'death') continue;
      expect(d.p.particles, d.id).toBeLessThanOrEqual(READABILITY.deathParticlesMax);
      expect(d.p.linger, d.id).toBeLessThanOrEqual(READABILITY.deathLingerMax);
      expect(d.p.rings, d.id).toBeLessThanOrEqual(READABILITY.deathRingsMax);
    }
  });

  it('every catalog preset emits ≤ 70 particles, all gone within its linger (≤ 1.5 s)', () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'death') continue;
      const p = resolveLook({ death: d.id }).death;
      for (let rep = 0; rep < 20; rep++) {
        const c = counter();
        const rings: number[] = [];
        const res = emitDeathPreset(c, ATLAS, p, 0, 0, 0xff3b5c, 1, { ring: (_x, _y, _a, _b, life) => { rings.push(life); }, flash: () => {} });
        expect(c.got.length, d.id).toBeLessThanOrEqual(READABILITY.deathParticlesMax);
        expect(res.particles).toBe(c.got.length);
        for (const o of c.got) expect(o.life, d.id).toBeLessThanOrEqual(Math.min(p.linger, READABILITY.deathLingerMax) + 1e-9);
        for (const l of rings) expect(l, d.id).toBeLessThanOrEqual(READABILITY.deathLingerMax + 1e-9);
        if (p.preset === 'std') expect(c.got.length).toBe(0);
        else expect(c.got.length).toBeGreaterThan(20);
      }
    }
  });

  it('out-of-bounds numbers are clamped (a hostile/garbage catalog edit cannot flood the screen)', () => {
    const wild: DeathParams = { preset: 'shatter', accent: 0xff3b5c, particles: 5000, rings: 40, linger: 30 };
    const c = counter();
    const res = emitDeathPreset(c, ATLAS, wild, 0, 0, 0xffffff, 1, noHost);
    expect(c.got.length).toBeLessThanOrEqual(70);
    expect(res.maxLife).toBeLessThanOrEqual(1.5);
    expect(res.rings).toBeLessThanOrEqual(READABILITY.deathRingsMax);
  });
});

describe('readability: engines', () => {
  it('catalog engine params: rateMul ≤ 1.5, mix ≤ 0.5, lifeMul 0.6–2', () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'engine') continue;
      expect(d.p.rateMul, d.id).toBeLessThanOrEqual(READABILITY.engineRateMulMax);
      expect(d.p.mix, d.id).toBeLessThanOrEqual(READABILITY.engineMixMax);
      expect(d.p.mix, d.id).toBeGreaterThanOrEqual(0);
      expect(d.p.lifeMul, d.id).toBeGreaterThanOrEqual(READABILITY.engineLifeMulMin);
      expect(d.p.lifeMul, d.id).toBeLessThanOrEqual(READABILITY.engineLifeMulMax);
    }
  });

  const emit = (e: EngineParams, accent: number, frames: number, alpha = 1) => {
    const c = counter();
    for (let i = 0; i < frames; i++) {
      emitEngine(c, ATLAS, e, accent, { x: 0, y: 0, dir: 0, vx: 0, vy: 0, r: 20, ab: true, team: 0x3b8bff, alpha, density: 1, time: i / 60 });
    }
    return c.got;
  };

  it('particle count ≤ 1.5× the standard trail and accent share ≤ 0.5, even for out-of-range params', () => {
    const frames = 3000;
    const stdCount = emit(resolveLook(undefined).engine, 0xffffff, frames).length;
    // raw catalog params (emitEngine clamps on its own) + a deliberately out-of-range set
    const cases: [string, EngineParams][] = [];
    for (const d of COSMETIC_LIST) if (d.slot === 'engine') cases.push([d.id, d.p]);
    cases.push(['wild', { flame: 'wide', particle: 'spark', tint: 'team', mix: 9, rateMul: 9, lifeMul: 99 }]);
    for (const [id, e] of cases) {
      const got = emit(e, 0x010203, frames);
      expect(got.length / stdCount, id).toBeLessThanOrEqual(READABILITY.engineRateMulMax + 0.05);
      // the trail colour is constant within a run; everything else is accent-coloured
      const freq = new Map<number, number>();
      for (const o of got) freq.set(o.color, (freq.get(o.color) ?? 0) + 1);
      const mode = Math.max(...freq.values());
      const share = 1 - mode / Math.max(1, got.length);
      expect(share, id).toBeLessThanOrEqual(READABILITY.engineMixMax + 0.04);
      for (const o of got) expect(o.life, id).toBeLessThanOrEqual(0.6 * READABILITY.engineLifeMulMax + 1e-9);
    }
  });

  it('root alpha multiplies engine particles, and alpha 0 emits nothing', () => {
    expect(emit(resolveLook(undefined).engine, 0xffffff, 200, 0).length).toBe(0);
    for (const o of emit(resolveLook(undefined).engine, 0xffffff, 200, 0.3)) expect(o.alpha!).toBeLessThanOrEqual(0.3 * 0.95 + 1e-9);
  });
});

describe('readability: hull silhouettes and patterns', () => {
  const classes: ShipClassId[] = ['brute', 'tech', 'engineer'];

  it('every shape at every amount keeps the silhouette ≤ 1.12× the base hull', () => {
    for (const cls of classes) {
      const base = polyExtent(hullPolys(cls));
      for (const shape of ['std', 'spiked', 'swept', 'crest'] as const) {
        for (const a of [0, 0.25, 0.5, 0.75, 1, 3]) {
          expect(polyExtent(modHullPolys(cls, shape, a)) / base, `${cls} ${shape} ${a}`).toBeLessThanOrEqual(READABILITY.silhouetteMax + 1e-9);
        }
      }
      expect(modHullPolys(cls, 'std', 1)).toEqual(hullPolys(cls).map((p) => [...p]));
    }
  });

  it('no outline vertex moves farther than 0.18 × amount (unit radius) from the base outline', () => {
    const distToOutline = (x: number, y: number, polys: readonly number[][]) => {
      let m = Infinity;
      for (const p of polys) {
        for (let i = 0, n = p.length; i < n; i += 2) {
          const ax = p[i], ay = p[i + 1], bx = p[(i + 2) % n], by = p[(i + 3) % n];
          const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
          m = Math.min(m, Math.hypot(x - ax - ex * t, y - ay - ey * t));
        }
      }
      return m;
    };
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'hull') continue;
      const base = hullPolys(d.shipClass);
      for (const p of modHullPolys(d.shipClass, d.p.shape, d.p.amount)) {
        for (let i = 0; i < p.length; i += 2) {
          expect(distToOutline(p[i], p[i + 1], base as number[][]), d.id).toBeLessThanOrEqual(READABILITY.hullDisplaceMax * d.p.amount + 1e-6);
        }
      }
    }
  });

  it('pattern strokes stay inside the (modified) main hull poly', () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'hull' || d.p.pattern === 'none') continue;
      const main = modHullPolys(d.shipClass, d.p.shape, d.p.amount)[0];
      const segs = hullPatternSegments(main, d.p.pattern, d.p.amount);
      expect(segs.length, d.id).toBeGreaterThan(0);
      for (let i = 0; i < segs.length; i += 4) {
        const mx = (segs[i] + segs[i + 2]) / 2, my = (segs[i + 1] + segs[i + 3]) / 2;
        expect(pointInPoly(mx, my, main), `${d.id} seg ${i / 4}`).toBe(true);
      }
    }
  });
});

describe('look resolution', () => {
  const info = (pid: PlayerId, cosmetics?: CosmeticLoadout, shipClass: ShipClassId = 'brute'): PlayerInfo =>
    ({ playerId: pid, name: `p${pid}`, team: 0, shipClass, isBot: false, isHost: false, ready: true, ping: 0, inMatch: true, cosmetics });

  it('unknown, wrong-slot and starter ids fall back to the starter look', () => {
    expect(resolveLook(undefined)).toBe(STARTER_LOOK);
    expect(resolveLook({})).toBe(STARTER_LOOK);
    const l = resolveLook({ hull: 'nope.hull', weapon: 'rift.hull.brute', death: 'std.death', killicon: 'glad.title.champion', title: 'x' });
    expect(l.hull).toBeNull();
    expect(l.weapon).toBeNull();
    expect(l.death.preset).toBe('std');
    expect(l.killicon).toBe('✦');
    expect(l.titleText).toBe('');
  });

  it('class slots only apply to the matching class / kit', () => {
    const l = resolveLook({ hull: 'rift.hull.brute', weapon: 'rift.weapon.brute', turret: 'rift.turret.flak' });
    expect(hullFor(l, 'brute')?.id).toBe('rift.hull.brute');
    expect(hullFor(l, 'tech')).toBeNull();
    expect(weaponFor(l, 'engineer')).toBeNull();
    expect(turretFor(l, 'brute')?.id).toBe('rift.turret.flak');
    expect(turretFor(l, 'tech')).toBeNull();
  });

  it('titles are framed and killicons come from the killer look', () => {
    expect(titleFor(info(1, { title: 'rift.title.riftwalker' }))).toBe('[ Riftwalker ]');
    expect(titleFor(info(1, { title: 'glad.title.champion' }))).toBe('❧ Champion ☙');
    expect(titleFor(info(1, { title: 'std.title' }))).toBe('');
    expect(killIconFor(info(1, { killicon: 'swarm.killicon.hive' }))).toBe('⬢');
    expect(killIconFor(info(1, { killicon: 'rift.killicon.tear' }))).toBe(COSMETICS['rift.killicon.tear'].slot === 'killicon' ? '⟡' : '?');
    expect(killIconFor(undefined)).toBe('✦');
  });

  it('LookTable rebuilds on a new players Map and on an in-place loadout swap, not otherwise', () => {
    const t = new LookTable();
    const m = new Map<PlayerId, PlayerInfo>([[1, info(1, { hull: 'rift.hull.brute' })], [2, info(2)]]);
    expect(t.update(m)).toBe(true);
    expect(t.get(1).hull?.id).toBe('rift.hull.brute');
    expect(t.get(2)).toBe(STARTER_LOOK);
    expect(t.get(99)).toBe(STARTER_LOOK);
    expect(t.update(m)).toBe(false);
    m.set(2, info(2, { hull: 'glad.hull.brute' })); // guest self-patch in place
    expect(t.update(m)).toBe(true);
    expect(t.get(2).hull?.id).toBe('glad.hull.brute');
    expect(t.update(new Map(m))).toBe(true);
  });

  it('the per-frame look path at 32 ships costs well under 0.3 ms', () => {
    const lo: CosmeticLoadout[] = [
      { hull: 'rift.hull.brute', weapon: 'rift.weapon.brute', turret: 'rift.turret.flak', engine: 'rift.engine.abyss', death: 'rift.death.collapse', title: 'rift.title.riftwalker', killicon: 'rift.killicon.tear' },
      { hull: 'glad.hull.tech', weapon: 'glad.weapon.tech', turret: 'glad.turret.laser', engine: 'glad.engine.torch' },
      { hull: 'swarm.hull.engineer', weapon: 'swarm.weapon.engineer', turret: 'swarm.turret.seekerpod', engine: 'swarm.engine.spore' },
    ];
    const classes: ShipClassId[] = ['brute', 'tech', 'engineer'];
    const t = new LookTable();
    const frames = 2000;
    const t0 = performance.now();
    let sink = 0;
    for (let f = 0; f < frames; f++) {
      // worst case: a fresh players Map every frame (the client only swaps it on roomState)
      const m = new Map<PlayerId, PlayerInfo>();
      for (let i = 0; i < 32; i++) m.set(i + 1, info(i + 1, lo[i % 3], classes[i % 3]));
      t.update(m);
      for (let i = 0; i < 32; i++) {
        const l = t.get(i + 1), cls = classes[i % 3];
        const h = hullFor(l, cls), w = weaponFor(l, cls), tu = turretFor(l, cls);
        const key = `${cls}|${0xff3b5c}|${i % 3}|0|${h ? h.id : ''}|${tu ? tu.id : ''}`;
        sink += key.length + (w ? 1 : 0) + l.engine.rateMul;
      }
    }
    const perFrame = (performance.now() - t0) / frames;
    expect(sink).toBeGreaterThan(0);
    expect(perFrame).toBeLessThan(0.3);
  });
});
