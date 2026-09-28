// Procedural neon vector shapes: ship hulls per class (+ path trim, turret-kit glyph), deployables,
// and enemy bodies per kind, as shared cached GraphicsContexts.
// v0.3 M2: cosmetic hull shape modifiers (spiked / swept / crest) + patterns (stripes / hex / rune) and
// turret mount glyphs (jaw / crown / hive / lens). The ship caches are mark-and-swept in setMap.
// v0.3 M4: the Hive Matriarch body + animation layers (halo, wings, brood), replacing the M1 placeholder.
// v0.5: capital hull variants (Dreadnought / Spire / Foundry) with hardpoint sockets, capital aux layers, and the
// bubble-turret dome (fixed base + a kit barrel that rotates to the turret's aim).
import { GraphicsContext } from 'pixi.js';
import type { DeployableKind, EnemyKind, ShipClassId, TurretKitId } from '../../shared/types';
import type { HullParams, HullPattern, HullShape, TurretMount } from '../../shared/data/cosmetics';
import { HARDPOINT_SEAT } from '../../shared/constants';
import { ENEMY_COLORS, MATRIARCH_GOLD, MATRIARCH_WING, brighten, darken } from './palette';
import { READABILITY, type HullLook, type TurretLook } from './cosmeticLook';
import { DOME_R, HARDPOINT_SOCKETS } from './capital';

export type Poly = number[]; // flat unit-space points (facing +x)

function hex(r: number, rot: number): Poly {
  const out: Poly = [];
  for (let i = 0; i < 6; i++) { const a = rot + (i * Math.PI) / 3; out.push(Math.cos(a) * r, Math.sin(a) * r); }
  return out;
}
function ngon(n: number, r: number, rot = 0): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) { const a = rot + (i * Math.PI * 2) / n; out.push(Math.cos(a) * r, Math.sin(a) * r); }
  return out;
}
const scaled = (p: Poly, s: number) => p.map((v) => v * s);
const mirrorY = (p: Poly) => p.map((v, i) => (i % 2 ? -v : v));
const diamond = (cx: number, cy: number, s: number): Poly => [cx + s, cy, cx, cy + s * 0.7, cx - s, cy, cx, cy - s * 0.7];
const rect = (x0: number, y0: number, x1: number, y1: number): Poly => [x0, y0, x1, y0, x1, y1, x0, y1];

// ---------------------------------------------------------------------------------------------
// Hull geometry per class (unit radius, facing +x)
// ---------------------------------------------------------------------------------------------

interface HullDef { polys: Poly[]; plates?: Poly[]; lines?: Poly[]; nodes?: Poly[] }

const BRUTE_HULL = [1.2, 0, 0.62, 0.52, -0.1, 0.92, -0.85, 0.86, -1.02, 0.42, -0.9, 0, -1.02, -0.42, -0.85, -0.86, -0.1, -0.92, 0.62, -0.52];
const BRUTE_PLATE = [0.3, 0.5, -0.15, 0.74, -0.7, 0.68, -0.55, 0.34];
const BRUTE_NOZZLE = [-0.98, 0.62, -1.14, 0.56, -1.14, 0.3, -0.98, 0.26];

const HULLS: Record<ShipClassId, HullDef> = {
  // Juggernaut: massive armored wedge with a battering-ram prow and chunky side plates.
  brute: {
    polys: [BRUTE_HULL, BRUTE_NOZZLE, mirrorY(BRUTE_NOZZLE)],
    plates: [[1.2, 0, 0.72, 0.34, 0.5, 0, 0.72, -0.34], BRUTE_PLATE, mirrorY(BRUTE_PLATE)],
    lines: [[0.5, 0, -0.9, 0], [0.62, 0.52, 0.3, 0.5], [0.62, -0.52, 0.3, -0.5]],
  },
  // Arcanist: slender crystalline caster; emitter nodes float free of the hull (drawn in the aux layer).
  tech: {
    polys: [[1.45, 0, 0.25, 0.3, -0.85, 0.2, -1.1, 0, -0.85, -0.2, 0.25, -0.3]],
    lines: [[1.45, 0, -1.1, 0], [0.25, 0.3, -0.2, 0], [-0.2, 0, 0.25, -0.3], [-0.85, 0.2, -0.5, 0], [-0.5, 0, -0.85, -0.2]],
    nodes: [diamond(0.1, 0.8, 0.17), diamond(0.1, -0.8, 0.17), diamond(-0.75, 0.62, 0.12), diamond(-0.75, -0.62, 0.12)],
  },
  // Artificer: modular utility frame — central module, two side pods on struts, antenna.
  engineer: {
    polys: [
      [0.95, 0.18, 0.95, -0.18, 0.55, -0.36, -0.75, -0.36, -0.9, -0.2, -0.9, 0.2, -0.75, 0.36, 0.55, 0.36],
      rect(0.45, 0.62, -0.55, 0.98), rect(0.45, -0.62, -0.55, -0.98),
    ],
    lines: [
      [0.15, 0.36, 0.15, 0.62], [-0.3, 0.36, -0.3, 0.62], [0.15, -0.36, 0.15, -0.62], [-0.3, -0.36, -0.3, -0.62],
      [-0.55, 0.1, -1.15, 0.55], [0.45, 0.8, 0.62, 0.8], [0.45, -0.8, 0.62, -0.8],
    ],
  },
};

/** Local (unit) positions of the Arcanist's emitter nodes — used for Storm crackle sparks. */
export const TECH_NODES: readonly [number, number][] = [[0.1, 0.8], [0.1, -0.8], [-0.75, 0.62], [-0.75, -0.62]];
/** Engineer antenna tip (unit). */
export const ENGINEER_ANTENNA: readonly [number, number] = [-1.15, 0.55];

// ---------------------------------------------------------------------------------------------
// v0.3 cosmetic hull geometry (pure; unit radius). Team colour stays the outline: shapes only move the
// outline, patterns are accent strokes at 35% alpha inside the main hull poly.
// ---------------------------------------------------------------------------------------------

/** The base outline polys of a class hull (unit radius). */
export function hullPolys(cls: ShipClassId): readonly Poly[] { return HULLS[cls].polys; }

/** Farthest outline vertex from the ship origin (unit radius). */
export function polyExtent(polys: readonly Poly[]): number {
  let m = 0;
  for (const p of polys) for (let i = 0; i < p.length; i += 2) m = Math.max(m, Math.hypot(p[i], p[i + 1]));
  return m;
}

function signedArea(p: Poly): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

/** One poly with its outer edges displaced by `d` (unit) in the style of `shape`. */
function shapePoly(p: Poly, shape: HullShape, d: number): Poly {
  if (shape === 'std' || d <= 0) return p.slice();
  const n = p.length / 2;
  const ccw = signedArea(p) > 0;
  let maxAbsY = 0;
  for (let i = 1; i < p.length; i += 2) maxAbsY = Math.max(maxAbsY, Math.abs(p[i]));
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const ax = p[i * 2], ay = p[i * 2 + 1];
    if (shape === 'swept') {
      // wings sweep back: aft vertices move back + out, scaled by how far off-axis / aft they sit
      const w = ax < 0.25 && maxAbsY > 0 ? Math.min(1, Math.abs(ay) / maxAbsY) * Math.min(1, (0.25 - ax) / 0.9) : 0;
      out.push(ax - d * 0.9 * w, ay + Math.sign(ay) * d * 0.43 * w);
      continue;
    }
    out.push(ax, ay);
    const bx = p[((i + 1) % n) * 2], by = p[((i + 1) % n) * 2 + 1];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    if (len < 0.3) continue;
    // outward normal (away from the poly interior)
    let nx = ey / len, ny = -ex / len;
    if (!ccw) { nx = -nx; ny = -ny; }
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (nx * mx + ny * my <= 0.05) continue; // only edges facing away from the ship origin
    if (shape === 'spiked') out.push(mx + nx * d, my + ny * d);
    else for (const f of [0.3, 0.7]) out.push(ax + ex * f + nx * d * 0.9, ay + ey * f + ny * d * 0.9); // crest: flat-topped fin
  }
  return out;
}

const modCache = new Map<string, Poly[]>();
/**
 * Class hull outline with a cosmetic shape modifier. Displacement ≤ READABILITY.hullDisplaceMax × amount
 * (unit radius), shrunk until the silhouette is ≤ READABILITY.silhouetteMax × the base extent. Pure.
 */
export function modHullPolys(cls: ShipClassId, shape: HullShape, amount: number): Poly[] {
  const a = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  const key = `${cls}|${shape}|${a}`;
  const hit = modCache.get(key);
  if (hit) return hit;
  const base = HULLS[cls].polys;
  const limit = polyExtent(base) * READABILITY.silhouetteMax;
  let d = READABILITY.hullDisplaceMax * a;
  let polys = base.map((p) => shapePoly(p, shape, d));
  for (let k = 0; k < 16 && polyExtent(polys) > limit; k++) { d *= 0.85; polys = base.map((p) => shapePoly(p, shape, d)); }
  if (polyExtent(polys) > limit) polys = base.map((p) => p.slice());
  modCache.set(key, polys);
  return polys;
}

/** Even-odd point-in-polygon. */
export function pointInPoly(x: number, y: number, p: Poly): boolean {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Segments of the line through (ox,oy) along (dx,dy) that lie inside `p` (flat [x0,y0,x1,y1,...]). */
function clipLine(ox: number, oy: number, dx: number, dy: number, p: Poly): number[] {
  const ts: number[] = [];
  for (let i = 0, n = p.length; i < n; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[(i + 2) % n], by = p[(i + 3) % n];
    const ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
    const u = ((ax - ox) * dy - (ay - oy) * dx) / den;
    if (u >= 0 && u < 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) out.push(ox + dx * ts[i], oy + dy * ts[i], ox + dx * ts[i + 1], oy + dy * ts[i + 1]);
  return out;
}

/** Clip segment to the half-plane x ≤ xMax (and optionally y ≥ 0); pushes the kept part into `out`. */
function keepSeg(out: number[], x0: number, y0: number, x1: number, y1: number, xMax: number, topOnly: boolean): void {
  if (topOnly) {
    if (y0 < 0 && y1 < 0) return;
    if (y0 < 0) { const f = y1 / (y1 - y0); x0 = x1 + (x0 - x1) * f; y0 = 0; }
    else if (y1 < 0) { const f = y0 / (y0 - y1); x1 = x0 + (x1 - x0) * f; y1 = 0; }
  }
  if (x0 > xMax && x1 > xMax) return;
  if (x0 > xMax) { const f = (xMax - x1) / (x0 - x1); y0 = y1 + (y0 - y1) * f; x0 = xMax; }
  else if (x1 > xMax) { const f = (xMax - x0) / (x1 - x0); y1 = y0 + (y1 - y0) * f; x1 = xMax; }
  if (Math.hypot(x1 - x0, y1 - y0) > 0.02) out.push(x0, y0, x1, y1);
}

/**
 * Pattern strokes (unit radius) inside the main hull poly, as flat segments [x0,y0,x1,y1,...]. Coverage
 * grows with `amount` from the stern forward. The class hulls are mirror-symmetric, so stripes are built
 * on the top half and mirrored. Pure — exported for tests.
 */
export function hullPatternSegments(main: Poly, pattern: HullPattern, amount: number): number[] {
  const segs: number[] = [];
  if (pattern === 'none') return segs;
  const a = Math.max(0.2, Math.min(1, amount));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < main.length; i += 2) {
    minX = Math.min(minX, main[i]); maxX = Math.max(maxX, main[i]);
    minY = Math.min(minY, main[i + 1]); maxY = Math.max(maxY, main[i + 1]);
  }
  const xCut = minX + (maxX - minX) * (0.35 + 0.65 * a);
  if (pattern === 'stripes') { // forward-pointing chevrons
    const top: number[] = [];
    for (let c = minX + 0.12; c < maxX + maxY; c += 0.27) {
      const s = clipLine(c, 0, -0.7071, 0.7071, main);
      for (let i = 0; i < s.length; i += 4) keepSeg(top, s[i], s[i + 1], s[i + 2], s[i + 3], xCut, true);
    }
    for (let i = 0; i < top.length; i += 4) segs.push(top[i], top[i + 1], top[i + 2], top[i + 3], top[i], -top[i + 1], top[i + 2], -top[i + 3]);
  } else if (pattern === 'hex') {
    const hr = 0.12, dx = hr * 1.75, dy = hr * 1.52;
    for (let row = 0, y = minY; y <= maxY; row++, y += dy) {
      for (let x = minX + (row % 2 ? dx / 2 : 0); x <= xCut; x += dx) {
        const pts: number[] = [];
        let ok = true;
        for (let k = 0; k < 6 && ok; k++) {
          const an = Math.PI / 6 + (k * Math.PI) / 3;
          const px = x + Math.cos(an) * hr * 0.82, py = y + Math.sin(an) * hr * 0.82;
          ok = pointInPoly(px, py, main);
          pts.push(px, py);
        }
        if (!ok) continue;
        for (let k = 0; k < 6; k++) segs.push(pts[k * 2], pts[k * 2 + 1], pts[((k + 1) % 6) * 2], pts[((k + 1) % 6) * 2 + 1]);
      }
    }
  } else { // rune: an inset engraving line + runic marks along the spine
    for (let i = 0, n = main.length; i < n; i += 2) {
      const x0 = main[i] * 0.72, y0 = main[i + 1] * 0.72, x1 = main[(i + 2) % n] * 0.72, y1 = main[(i + 3) % n] * 0.72;
      if (pointInPoly(x0, y0, main) && pointInPoly(x1, y1, main)) keepSeg(segs, x0, y0, x1, y1, xCut, false);
    }
    const marks = [[0, -0.13, 0, 0.13, -0.07, -0.05, 0.07, 0.05], [-0.07, -0.11, 0.07, 0.11, 0.07, -0.11, -0.07, 0.11], [0, -0.13, 0, 0.13, 0, -0.02, 0.09, -0.11]];
    let k = 0;
    for (let x = minX + 0.28; x < xCut - 0.08; x += 0.32, k++) {
      const m = marks[k % marks.length];
      let ok = true;
      for (let j = 0; j < m.length && ok; j += 2) ok = pointInPoly(x + m[j], m[j + 1], main);
      if (!ok) continue;
      for (let j = 0; j < m.length; j += 4) segs.push(x + m[j], m[j + 1], x + m[j + 2], m[j + 3]);
    }
  }
  return segs;
}

/** Accent pattern (35% alpha, 1.2 px strokes) scaled to radius r. */
function drawPattern(ctx: GraphicsContext, main: Poly, p: HullParams, r: number): void {
  const s = hullPatternSegments(main, p.pattern, p.amount);
  if (!s.length) return;
  for (let i = 0; i < s.length; i += 4) ctx.moveTo(s[i] * r, s[i + 1] * r).lineTo(s[i + 2] * r, s[i + 3] * r);
  ctx.stroke({ width: 1.2, color: p.accent, alpha: 0.35, cap: 'round' });
}

function neonPolys(ctx: GraphicsContext, polys: Poly[], color: number, fill: number, fillA: number, w: number): void {
  for (const p of polys) ctx.poly(p, true).fill({ color: fill, alpha: fillA });
  for (const p of polys) ctx.poly(p, true);
  ctx.stroke({ width: w * 3, color, alpha: 0.18, join: 'round' });
  for (const p of polys) ctx.poly(p, true);
  ctx.stroke({ width: w, color, alpha: 1, join: 'round' });
  for (const p of polys) ctx.poly(p, true);
  ctx.stroke({ width: w * 0.38, color: brighten(color, 0.75), alpha: 0.9, join: 'round' });
}
function segs(ctx: GraphicsContext, lines: Poly[], color: number, w: number, alpha = 0.85): void {
  for (const l of lines) { ctx.moveTo(l[0], l[1]); for (let i = 2; i < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]); }
  ctx.stroke({ width: w, color, alpha, cap: 'round', join: 'round' });
}

/** Path trim geometry (accent colored), per class, per path index. */
function drawTrim(ctx: GraphicsContext, cls: ShipClassId, pathIdx: number, r: number, accent: number): void {
  const S = (p: Poly) => scaled(p, r);
  if (cls === 'brute') {
    if (pathIdx === 0) { // Ram: prow spikes
      const spikes = [[1.18, 0.09, 1.7, 0, 1.18, -0.09], [0.86, 0.3, 1.32, 0.44, 0.78, 0.42], [0.86, -0.3, 1.32, -0.44, 0.78, -0.42]].map(S);
      neonPolys(ctx, spikes, accent, brighten(accent, 0.2), 0.7, 1.6);
    } else if (pathIdx === 1) { // Barrage: flank rocket pods
      const pods = [rect(0.28, 0.98, -0.58, 1.24), rect(0.28, -0.98, -0.58, -1.24)].map(S);
      neonPolys(ctx, pods, accent, darken(accent, 0.6), 0.8, 1.6);
      for (const sy of [1, -1]) for (const y of [1.05, 1.17]) ctx.circle(0.3 * r, y * sy * r, 0.055 * r);
      ctx.fill({ color: brighten(accent, 0.6), alpha: 1 });
    } else if (pathIdx === 2) { // Bulwark: extra outer plating + docking ring
      ctx.poly(S(scaled(BRUTE_HULL, 1.15)), true).stroke({ width: 2.2, color: accent, alpha: 0.9, join: 'round' });
      ctx.poly(S(scaled(BRUTE_HULL, 1.15)), true).stroke({ width: 6, color: accent, alpha: 0.15, join: 'round' });
      ctx.circle(-0.35 * r, 0, 0.32 * r).stroke({ width: 1.8, color: accent, alpha: 1 });
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        ctx.moveTo(-0.35 * r + Math.cos(a) * 0.32 * r, Math.sin(a) * 0.32 * r).lineTo(-0.35 * r + Math.cos(a) * 0.46 * r, Math.sin(a) * 0.46 * r);
      }
      ctx.stroke({ width: 1.6, color: brighten(accent, 0.4), alpha: 1 });
    }
  } else if (cls === 'tech') {
    if (pathIdx === 0) { // Storm: zig-zag conduits toward the floating nodes
      segs(ctx, [[0.1, 0.25, 0.18, 0.42, 0.04, 0.55, 0.12, 0.66], [0.1, -0.25, 0.18, -0.42, 0.04, -0.55, 0.12, -0.66]].map(S), accent, 1.3, 0.9);
    } else if (pathIdx === 1) { // Void: dark core
      ctx.circle(0.05 * r, 0, 0.3 * r).fill({ color: 0x000000, alpha: 1 });
      ctx.circle(0.05 * r, 0, 0.3 * r).stroke({ width: 1.8, color: accent, alpha: 1 });
      ctx.circle(0.05 * r, 0, 0.42 * r).stroke({ width: 4, color: accent, alpha: 0.2 });
    } else if (pathIdx === 2) { // Lance: long spine with a tip diamond
      segs(ctx, [[1.45, 0, 2.15, 0], [1.62, 0.16, 1.62, -0.16]].map(S), accent, 2, 1);
      neonPolys(ctx, [S(diamond(2.2, 0, 0.14))], accent, brighten(accent, 0.3), 0.8, 1.4);
    }
  } else {
    if (pathIdx === 0) { // Summoner: rear drone bay with a docked drone
      ctx.poly(S(rect(-0.45, 0.24, -0.92, -0.24)), true).stroke({ width: 1.8, color: accent, alpha: 1 });
      neonPolys(ctx, [S([-0.52, 0, -0.78, 0.13, -0.7, 0, -0.78, -0.13])], accent, darken(accent, 0.4), 0.8, 1.2);
    } else if (pathIdx === 1) { // Medic: cross emblem
      ctx.poly(S([0.02, 0.07, 0.3, 0.07, 0.3, -0.07, 0.02, -0.07]), true).poly(S([0.09, 0.2, 0.23, 0.2, 0.23, -0.2, 0.09, -0.2]), true)
        .fill({ color: accent, alpha: 1 });
      ctx.circle(0.16 * r, 0, 0.3 * r).stroke({ width: 3.5, color: accent, alpha: 0.22 });
    } else if (pathIdx === 2) { // Architect: scaffold frame with cross bracing
      const f = S(rect(1.12, 1.12, -1.02, -1.12));
      ctx.poly(f, true).stroke({ width: 1.3, color: accent, alpha: 0.85 });
      segs(ctx, [
        [1.12, 1.12, 0.45, 0.98], [1.12, -1.12, 0.45, -0.98], [-1.02, 1.12, -0.55, 0.98], [-1.02, -1.12, -0.55, -0.98],
        [1.12, 1.12, 1.12, -1.12, 0.95, 0], [-1.02, 0.6, -0.9, 0.2], [-1.02, -0.6, -0.9, -0.2],
      ].map(S), accent, 1, 0.7);
    }
  }
}

/** Kit mount glyph drawn on an attached turret. */
function drawKitGlyph(ctx: GraphicsContext, cls: ShipClassId, r: number, color: number): void {
  const c = brighten(color, 0.6);
  if (cls === 'brute') { // flak barrels
    segs(ctx, [[0.55, 0.2, 1.4, 0.2], [0.55, 0, 1.5, 0], [0.55, -0.2, 1.4, -0.2]].map((p) => scaled(p, r)), c, 2.6, 1);
    ctx.poly(scaled(rect(0.35, 0.32, 0.7, -0.32), r), true).stroke({ width: 1.4, color: c, alpha: 1 });
  } else if (cls === 'tech') { // laser emitter lens + prongs
    ctx.circle(0.95 * r, 0, 0.2 * r).fill({ color: 0xffffff, alpha: 0.9 }).stroke({ width: 1.4, color: c, alpha: 1 });
    segs(ctx, [[0.95, 0.22, 1.35, 0.1], [0.95, -0.22, 1.35, -0.1]].map((p) => scaled(p, r)), c, 1.6, 1);
  } else { // seeker pod box
    ctx.poly(scaled(rect(0.2, 0.32, 0.95, -0.32), r), true).fill({ color: darken(color, 0.5), alpha: 0.9 }).stroke({ width: 1.4, color: c, alpha: 1 });
    for (const [x, y] of [[0.42, 0.14], [0.42, -0.14], [0.72, 0.14], [0.72, -0.14]]) ctx.circle(x * r, y * r, 0.07 * r);
    ctx.fill({ color: 0xffffff, alpha: 0.95 });
  }
}

/** v0.3 cosmetic turret mount glyph (replaces drawKitGlyph). Team-colour body, accent details ≤ 1.4 px / ≤ 35% fills. */
function drawMount(ctx: GraphicsContext, mount: TurretMount, r: number, color: number, accent: number): void {
  const c = brighten(color, 0.6);
  const S = (p: Poly) => scaled(p, r);
  if (mount === 'jaw') { // two mandibles closing on the muzzle
    for (const sy of [1, -1]) {
      const jaw = S([0.35, 0.34 * sy, 1.35, 0.3 * sy, 1.5, 0.08 * sy, 1.18, 0.12 * sy, 0.6, 0.14 * sy]);
      ctx.poly(jaw, true).fill({ color: accent, alpha: 0.3 }).stroke({ width: 1.6, color: c, alpha: 1, join: 'round' });
    }
    segs(ctx, [[0.62, 0.2, 0.62, -0.2], [0.9, 0.16, 0.9, -0.16]].map(S), accent, 1.2, 0.9);
  } else if (mount === 'crown') { // ring of short barrels
    ctx.circle(0.62 * r, 0, 0.36 * r).stroke({ width: 1.6, color: c, alpha: 1 });
    for (let i = 0; i < 5; i++) {
      const an = -0.9 + (i * 1.8) / 4;
      ctx.moveTo((0.62 + Math.cos(an) * 0.36) * r, Math.sin(an) * 0.36 * r).lineTo((0.62 + Math.cos(an) * 0.8) * r, Math.sin(an) * 0.8 * r);
    }
    ctx.stroke({ width: 2.2, color: c, alpha: 1, cap: 'round' });
    ctx.circle(0.62 * r, 0, 0.2 * r).fill({ color: accent, alpha: 0.3 }).stroke({ width: 1.2, color: accent, alpha: 0.95 });
  } else if (mount === 'hive') { // honeycomb pod
    const cells: [number, number][] = [[0.55, 0], [0.84, 0.17], [0.84, -0.17], [1.13, 0]];
    const cell = (x: number, y: number) => S(hex(0.15, 0).map((v, i) => v + (i % 2 ? y : x)));
    for (const [x, y] of cells) ctx.poly(cell(x, y), true);
    ctx.fill({ color: accent, alpha: 0.28 });
    for (const [x, y] of cells) ctx.poly(cell(x, y), true);
    ctx.stroke({ width: 1.4, color: c, alpha: 1, join: 'round' });
    for (const [x, y] of cells) ctx.circle(x * r, y * r, 0.05 * r);
    ctx.fill({ color: 0xffffff, alpha: 0.9 });
  } else { // lens: a big eye with an iris ring
    ctx.circle(0.95 * r, 0, 0.3 * r).fill({ color: accent, alpha: 0.3 }).stroke({ width: 1.6, color: c, alpha: 1 });
    ctx.circle(0.95 * r, 0, 0.44 * r).stroke({ width: 1.2, color: accent, alpha: 0.9 });
    ctx.circle(1.02 * r, 0, 0.11 * r).fill({ color: 0xffffff, alpha: 0.95 });
    segs(ctx, [[0.52, 0.3, 0.72, 0.22], [0.52, -0.3, 0.72, -0.22]].map(S), c, 1.4, 1);
  }
}

const shipCache = new Map<string, GraphicsContext>();
const auxCache = new Map<string, GraphicsContext>();
/** Shared empty context for pooled Graphics, so a sweep never destroys a context still assigned. Never destroyed. */
export const EMPTY_CTX = new GraphicsContext();

/**
 * Mark-and-sweep of the ship caches (GameRenderer.setMap): destroys every cached hull / aux context that is
 * not in `keep` (the contexts assigned to live ship displays and afterimages). Returns the number destroyed.
 */
export function sweepShipCaches(keep: ReadonlySet<GraphicsContext>): number {
  let n = 0;
  for (const cache of [shipCache, auxCache]) {
    for (const [k, ctx] of cache) {
      if (keep.has(ctx)) continue;
      cache.delete(k);
      ctx.destroy();
      n++;
    }
  }
  return n;
}
/** Cached ship + aux context count (debug overlay / tests). */
export function shipCacheSize(): number { return shipCache.size + auxCache.size; }

/**
 * Hull drawn at actual radius (px). `accent` = path trim color (pathIdx ≥ 0). `turret` adds the kit glyph
 * (or the cosmetic mount). `hull` = cosmetic hull look (shape + pattern; null = starter). The cache key
 * includes both cosmetic ids.
 */
export function shipHull(
  cls: ShipClassId, color: number, radius: number, pathIdx: number, accent: number, turret: boolean,
  hull: HullLook | null = null, mount: TurretLook | null = null,
): GraphicsContext {
  const mountId = turret && mount && mount.p.mount !== 'std' ? mount.id : '';
  const key = `${cls}|${color}|${radius}|${pathIdx}|${turret ? 1 : 0}|${hull ? hull.id : ''}|${mountId}`;
  let ctx = shipCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  const def = HULLS[cls];
  const r = radius;
  const unit = hull && hull.p.shape !== 'std' ? modHullPolys(cls, hull.p.shape, hull.p.amount) : def.polys;
  const polys = unit.map((p) => scaled(p, r));
  neonPolys(ctx, polys, color, darken(color, 0.74), 0.8, 2.4);
  if (def.plates) {
    for (const p of def.plates) ctx.poly(scaled(p, r), true).fill({ color: darken(color, 0.45), alpha: 0.85 });
    for (const p of def.plates) ctx.poly(scaled(p, r), true);
    ctx.stroke({ width: 1.3, color: brighten(color, 0.35), alpha: 0.9, join: 'round' });
  }
  if (def.lines) segs(ctx, def.lines.map((l) => scaled(l, r)), brighten(color, 0.4), 1.3);
  if (hull && hull.p.pattern !== 'none') drawPattern(ctx, unit[0], hull.p, r);
  if (pathIdx >= 0) drawTrim(ctx, cls, pathIdx, r, accent);
  if (turret) {
    if (mountId && mount) drawMount(ctx, mount.p.mount, r, color, mount.p.accent);
    else drawKitGlyph(ctx, cls, r, color);
  }
  // cockpit spark
  if (!(cls === 'tech' && pathIdx === 1)) ctx.circle(r * (cls === 'brute' ? 0.2 : 0.4), 0, Math.max(1.5, r * 0.09)).fill({ color: 0xffffff, alpha: 0.95 });
  shipCache.set(key, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// v0.5 capital hull variants (unit radius, facing +x). Every HARDPOINT_SOCKETS mount (× HARDPOINT_SEAT) lies inside
// the hull polys (tested), so docked domes sit on the hull. Team colour stays the outline; path trim is accent.
// ---------------------------------------------------------------------------------------------

/** Top half (y ≥ 0, bow → stern) mirrored into a closed outline. */
function sym(top: Poly): Poly {
  const out = top.slice();
  for (let i = top.length - 2; i >= 0; i -= 2) if (Math.abs(top[i + 1]) > 1e-9) out.push(top[i], -top[i + 1]);
  return out;
}

export interface CapitalGeom {
  /** Outline polys (main hull first). */
  polys: Poly[];
  plates: Poly[];
  lines: Poly[];
  /** Dreadnought: gunport stubs [x, y] (both flanks, unit), fore → aft; broadside flashes at their tips. */
  ports: [number, number][];
  /** Foundry: bay lights [x, y] (unit); Repair Bay turns them green. */
  lights: [number, number][];
  /** Spire: focusing lens centre + radius (unit); ring radius around the ship origin. */
  lens: [number, number, number] | null;
  ring: number;
}

const DREAD_MAIN = sym([1.28, 0, 1.0, 0.2, 0.78, 0.36, 0.62, 0.72, 0.52, 0.86, -0.5, 0.86, -0.7, 0.72, -1.06, 0.58, -1.06, 0]);
const SPIRE_MAIN = sym([1.62, 0, 0.9, 0.2, 0.3, 0.3, -0.5, 0.3, -1.05, 0.14, -1.2, 0]);
const SPIRE_FIN_F: Poly = [0.44, 0.22, 0.62, 0.6, 0.34, 0.9, 0.08, 0.28];
const SPIRE_FIN_A: Poly = [-0.26, 0.26, -0.34, 0.62, -0.72, 0.8, -0.66, 0.26];
const FOUNDRY_KEEL = sym([1.0, 0, 1.0, 0.2, 0.62, 0.3, -0.86, 0.3, -1.0, 0.16, -1.0, 0]);
const FOUNDRY_BEAM = rect(0.86, 0.7, -0.86, 0.9);
const FOUNDRY_GANTRIES: Poly[] = [rect(0.46, 0.3, 0.2, 0.7), rect(-0.36, 0.3, -0.62, 0.7)].flatMap((p) => [p, mirrorY(p)]);

export const CAPITAL_GEOM: Readonly<Record<ShipClassId, CapitalGeom>> = {
  // Dreadnought: armored gun-deck, heavy prow, broadside gunports along both flanks, triple engine block.
  brute: {
    polys: [DREAD_MAIN, rect(-1.06, 0.5, -1.2, 0.3), rect(-1.06, 0.12, -1.22, -0.12), rect(-1.06, -0.3, -1.2, -0.5)],
    plates: [
      [1.28, 0, 0.96, 0.25, 0.7, 0.2, 0.6, 0, 0.7, -0.2, 0.96, -0.25], // heavy prow
      [0.46, 0.64, -0.46, 0.66, -0.46, 0.8, 0.46, 0.8], [0.46, -0.64, -0.46, -0.66, -0.46, -0.8, 0.46, -0.8], // side armour
      rect(0.2, 0.2, -0.34, -0.2), // bridge superstructure
    ],
    lines: [[0.6, 0, -0.95, 0], [0.62, 0.72, 0.3, 0.3], [0.62, -0.72, 0.3, -0.3], [-0.34, 0.2, -0.7, 0.5], [-0.34, -0.2, -0.7, -0.5]],
    ports: [[0.4, 0.9], [0.15, 0.9], [-0.1, 0.9], [-0.35, 0.9], [0.4, -0.9], [0.15, -0.9], [-0.1, -0.9], [-0.35, -0.9]],
    lights: [],
    lens: null,
    ring: 0,
  },
  // Spire: a tall crystal spire with outrigger crystals, a focusing ring through every mount and a lens at the bow.
  tech: {
    polys: [SPIRE_MAIN, SPIRE_FIN_F, mirrorY(SPIRE_FIN_F), SPIRE_FIN_A, mirrorY(SPIRE_FIN_A)],
    plates: [[1.62, 0, 1.12, 0.12, 0.9, 0, 1.12, -0.12]],
    lines: [[1.62, 0, -1.2, 0], [0.9, 0.2, 0.3, 0], [0.3, 0, 0.9, -0.2], [-0.5, 0.3, -0.1, 0], [-0.1, 0, -0.5, -0.3],
      [0.3, 0.3, 0.44, 0.22], [0.3, -0.3, 0.44, -0.22], [0.34, 0.9, 0.62, 0.6], [0.34, -0.9, 0.62, -0.6]],
    ports: [],
    lights: [],
    lens: [1.3, 0, 0.15],
    ring: 0.72,
  },
  // Foundry: a wide shipyard frame: central keel, two gantry beams, open bays with cranes and bay lights.
  engineer: {
    // keel, two gantry beams, and four cross-gantries across the bays that carry the flank mounts
    polys: [FOUNDRY_KEEL, FOUNDRY_BEAM, mirrorY(FOUNDRY_BEAM), ...FOUNDRY_GANTRIES],
    plates: [rect(0.8, 0.32, -0.8, 0.7), rect(0.8, -0.32, -0.8, -0.7), rect(0.3, 0.16, -0.3, -0.16)],
    lines: [
      [-0.02, 0.3, -0.02, 0.7], [-0.02, -0.3, -0.02, -0.7],
      [0.7, 0.9, 0.7, 0.46, 0.56, 0.46], [-0.2, 0.9, -0.2, 0.5, -0.3, 0.5], [0.7, -0.9, 0.7, -0.46, 0.56, -0.46], [-0.2, -0.9, -0.2, -0.5, -0.3, -0.5],
    ],
    ports: [],
    lights: [[0.76, 0.64], [0.1, 0.64], [-0.13, 0.64], [-0.78, 0.64], [0.76, -0.64], [0.1, -0.64], [-0.13, -0.64], [-0.78, -0.64]],
    lens: null,
    ring: 0,
  },
};

/** Socket centres (unit radius): every HARDPOINT_SOCKETS mount × HARDPOINT_SEAT. */
export const SOCKET_UNIT: readonly [number, number][] = HARDPOINT_SOCKETS.map(([a, s]) => [a * HARDPOINT_SEAT, s * HARDPOINT_SEAT]);

const capModCache = new Map<string, Poly[]>();
/** Capital outline with a cosmetic shape modifier (same bounds as modHullPolys, relative to the capital hull). Pure. */
export function modCapitalPolys(cls: ShipClassId, shape: HullShape, amount: number): Poly[] {
  const a = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  const key = `${cls}|${shape}|${a}`;
  const hit = capModCache.get(key);
  if (hit) return hit;
  const base = CAPITAL_GEOM[cls].polys;
  const limit = polyExtent(base) * READABILITY.silhouetteMax;
  let d = READABILITY.hullDisplaceMax * a;
  let polys = base.map((p) => shapePoly(p, shape, d));
  for (let k = 0; k < 16 && polyExtent(polys) > limit; k++) { d *= 0.85; polys = base.map((p) => shapePoly(p, shape, d)); }
  if (polyExtent(polys) > limit) polys = base.map((p) => p.slice());
  capModCache.set(key, polys);
  return polys;
}

/** Capital path trim (accent), per class and path: the base trims re-seated on the bigger hulls. */
function drawCapitalTrim(ctx: GraphicsContext, cls: ShipClassId, pathIdx: number, r: number, accent: number): void {
  const S = (p: Poly) => scaled(p, r);
  if (cls === 'brute') {
    if (pathIdx === 0) { // Ram: prow spikes on the heavy prow
      neonPolys(ctx, [[1.26, 0.09, 1.72, 0, 1.26, -0.09], [0.98, 0.25, 1.36, 0.4, 0.9, 0.36], [0.98, -0.25, 1.36, -0.4, 0.9, -0.36]].map(S), accent, brighten(accent, 0.2), 0.7, 1.6);
    } else if (pathIdx === 1) { // Barrage: stern rocket pods
      neonPolys(ctx, [rect(-0.56, 0.86, -1.02, 1.06), rect(-0.56, -0.86, -1.02, -1.06)].map(S), accent, darken(accent, 0.6), 0.8, 1.6);
      for (const sy of [1, -1]) for (const x of [-0.66, -0.82]) ctx.circle(x * r, 0.96 * sy * r, 0.05 * r);
      ctx.fill({ color: brighten(accent, 0.6), alpha: 1 });
    } else if (pathIdx === 2) { // Bulwark: armour plating, inside the hull (the team outline stays outermost)
      ctx.poly(S(scaled(DREAD_MAIN, 0.84)), true).stroke({ width: 2, color: accent, alpha: 0.85, join: 'round' });
      ctx.poly(S(scaled(DREAD_MAIN, 0.84)), true).stroke({ width: 5, color: accent, alpha: 0.13, join: 'round' });
    }
  } else if (cls === 'tech') {
    if (pathIdx === 0) { // Storm: conduits from the spine to the outriggers
      segs(ctx, [[0.3, 0.3, 0.38, 0.44, 0.3, 0.54, 0.4, 0.62], [0.3, -0.3, 0.38, -0.44, 0.3, -0.54, 0.4, -0.62],
        [-0.4, 0.3, -0.36, 0.44, -0.46, 0.52], [-0.4, -0.3, -0.36, -0.44, -0.46, -0.52]].map(S), accent, 1.3, 0.9);
    } else if (pathIdx === 1) { // Void: dark core
      ctx.circle(0.1 * r, 0, 0.24 * r).fill({ color: 0x000000, alpha: 1 });
      ctx.circle(0.1 * r, 0, 0.24 * r).stroke({ width: 1.8, color: accent, alpha: 1 });
      ctx.circle(0.1 * r, 0, 0.36 * r).stroke({ width: 4, color: accent, alpha: 0.2 });
    } else if (pathIdx === 2) { // Lance: spine past the lens with a tip diamond
      segs(ctx, [[1.62, 0, 2.2, 0], [1.8, 0.14, 1.8, -0.14]].map(S), accent, 2, 1);
      neonPolys(ctx, [S(diamond(2.25, 0, 0.13))], accent, brighten(accent, 0.3), 0.8, 1.4);
    }
  } else {
    if (pathIdx === 0) { // Summoner: forward drone bay with a docked drone
      ctx.poly(S(rect(0.52, 0.2, 0.08, -0.2)), true).stroke({ width: 1.8, color: accent, alpha: 1 });
      neonPolys(ctx, [S([0.44, 0, 0.2, 0.12, 0.27, 0, 0.2, -0.12])], accent, darken(accent, 0.4), 0.8, 1.2);
    } else if (pathIdx === 1) { // Medic: cross emblem on the keel
      ctx.poly(S([0.16, 0.07, 0.44, 0.07, 0.44, -0.07, 0.16, -0.07]), true).poly(S([0.23, 0.2, 0.37, 0.2, 0.37, -0.2, 0.23, -0.2]), true)
        .fill({ color: accent, alpha: 1 });
      ctx.circle(0.3 * r, 0, 0.28 * r).stroke({ width: 3.5, color: accent, alpha: 0.22 });
    } else if (pathIdx === 2) { // Architect: scaffold over the yard, inside the hull (the team outline stays outermost)
      const k = 0.8;
      ctx.poly(S(scaled(rect(1.08, 1.02, -1.0, -1.02), k)), true).stroke({ width: 1.3, color: accent, alpha: 0.85 });
      segs(ctx, [[1.08, 1.02, 0.86, 0.9], [1.08, -1.02, 0.86, -0.9], [-1.0, 1.02, -0.86, 0.9], [-1.0, -1.02, -0.86, -0.9], [1.08, 1.02, 1.08, -1.02, 1.0, 0]]
        .map((p) => S(scaled(p, k))), accent, 1, 0.7);
    }
  }
}

/**
 * v0.5 capital hull at radius px (the renderer draws it at base × CAP_REF and scales by vis / CAP_REF). Sockets are
 * drawn dim at every HARDPOINT_SOCKETS mount; docked domes cover (and light) the occupied ones. Cached in the ship
 * cache (swept by sweepShipCaches).
 */
export function capitalHull(cls: ShipClassId, color: number, radius: number, pathIdx: number, accent: number, hull: HullLook | null = null): GraphicsContext {
  const r = Math.round(radius * 100) / 100;
  const key = `cap|${cls}|${color}|${r}|${pathIdx}|${hull ? hull.id : ''}`;
  let ctx = shipCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  const G = CAPITAL_GEOM[cls];
  const unit = hull && hull.p.shape !== 'std' ? modCapitalPolys(cls, hull.p.shape, hull.p.amount) : G.polys;
  // Spire focusing ring (under the crystals)
  if (G.ring > 0) {
    ctx.circle(0, 0, G.ring * r).stroke({ width: 5, color, alpha: 0.14 });
    ctx.circle(0, 0, G.ring * r).stroke({ width: 1.4, color: brighten(color, 0.45), alpha: 0.8 });
  }
  // Dreadnought gunport stubs (outside the flank edge, under the outline)
  if (G.ports.length) {
    for (const [x, y] of G.ports) ctx.poly(scaled(rect(x + 0.055, y - Math.sign(y) * 0.07, x - 0.055, y + Math.sign(y) * 0.07), r), true);
    ctx.fill({ color: darken(color, 0.5), alpha: 0.95 });
    for (const [x, y] of G.ports) ctx.poly(scaled(rect(x + 0.055, y - Math.sign(y) * 0.07, x - 0.055, y + Math.sign(y) * 0.07), r), true);
    ctx.stroke({ width: 1.2, color: brighten(color, 0.35), alpha: 1 });
  }
  const polys = unit.map((p) => scaled(p, r));
  neonPolys(ctx, polys, color, darken(color, 0.74), 0.8, 2.6);
  for (const p of G.plates) ctx.poly(scaled(p, r), true).fill({ color: darken(color, 0.45), alpha: cls === 'engineer' ? 0.35 : 0.85 });
  for (const p of G.plates) ctx.poly(scaled(p, r), true);
  ctx.stroke({ width: 1.3, color: brighten(color, 0.35), alpha: 0.9, join: 'round' });
  segs(ctx, G.lines.map((l) => scaled(l, r)), brighten(color, 0.4), 1.3);
  if (G.ports.length) { // gun muzzles
    for (const [x, y] of G.ports) ctx.circle(x * r, (y + Math.sign(y) * 0.06) * r, Math.max(1, 0.035 * r));
    ctx.fill({ color: 0xffffff, alpha: 0.8 });
  }
  if (G.lens) {
    const [lx, ly, lr] = G.lens;
    ctx.circle(lx * r, ly * r, lr * r).fill({ color: 0xffffff, alpha: 0.9 }).stroke({ width: 1.6, color: brighten(color, 0.5), alpha: 1 });
    ctx.circle(lx * r, ly * r, lr * 1.7 * r).stroke({ width: 1.1, color: brighten(color, 0.3), alpha: 0.75 });
  }
  if (G.lights.length) {
    for (const [x, y] of G.lights) ctx.circle(x * r, y * r, Math.max(1.1, 0.04 * r));
    ctx.fill({ color: brighten(color, 0.3), alpha: 0.7 });
  }
  if (hull && hull.p.pattern !== 'none') drawPattern(ctx, unit[0], hull.p, r);
  if (pathIdx >= 0) drawCapitalTrim(ctx, cls, pathIdx, r, accent);
  // hardpoint sockets (dim): a dark pad, a team ring and a cross-hair; domes cover the occupied ones
  const sr = DOME_R * 0.78;
  for (const [x, y] of SOCKET_UNIT) ctx.circle(x * r, y * r, sr);
  ctx.fill({ color: 0x000000, alpha: 0.45 });
  for (const [x, y] of SOCKET_UNIT) ctx.circle(x * r, y * r, sr);
  ctx.stroke({ width: 1.1, color, alpha: 0.55 });
  for (const [x, y] of SOCKET_UNIT) {
    ctx.moveTo(x * r - sr * 0.45, y * r).lineTo(x * r + sr * 0.45, y * r).moveTo(x * r, y * r - sr * 0.45).lineTo(x * r, y * r + sr * 0.45);
  }
  ctx.stroke({ width: 0.8, color: brighten(color, 0.3), alpha: 0.4 });
  // bridge spark
  if (!(cls === 'tech' && pathIdx === 1)) ctx.circle(r * (cls === 'brute' ? -0.07 : cls === 'tech' ? 0.55 : 0.0), 0, Math.max(1.6, r * 0.075)).fill({ color: 0xffffff, alpha: 0.95 });
  shipCache.set(key, ctx);
  return ctx;
}

/** Spire outrigger shards (pulsing, like the Arcanist's nodes) / Foundry crane beacons (blinking). Null for the Dreadnought. */
export function capitalAux(cls: ShipClassId, color: number, radius: number, nodeColor: number): GraphicsContext | null {
  if (cls === 'brute') return null;
  const r = Math.round(radius * 100) / 100;
  const key = `cap|${cls}|${color}|${r}|${nodeColor}`;
  let ctx = auxCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  if (cls === 'tech') {
    const shards = [diamond(0.22, 1.02, 0.12), diamond(0.22, -1.02, 0.12), diamond(-0.86, 0.9, 0.1), diamond(-0.86, -0.9, 0.1), diamond(1.9, 0, 0.1)];
    neonPolys(ctx, shards.map((p) => scaled(p, r)), nodeColor, brighten(nodeColor, 0.4), 0.7, 1.3);
  } else {
    for (const [x, y] of [[0.56, 0.46], [-0.34, 0.5], [0.56, -0.46], [-0.34, -0.5]]) ctx.circle(x * r, y * r, Math.max(1.4, 0.05 * r));
    ctx.fill({ color: nodeColor, alpha: 1 });
  }
  auxCache.set(key, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// v0.5 bubble-turret domes (px, DOME_R). The base never rotates (glass highlight from the top-left); the barrel
// context rotates to the turret's own aim (+x). Team ring on every dome; accent only in ≤ 35% fills / thin strokes.
// ---------------------------------------------------------------------------------------------

/** Fixed dome base: occupied-socket glow, team ring, glass + highlight, bolts. `accent` (cosmetic) adds an inner ring. */
export function domeBase(color: number, accent: number | null = null): GraphicsContext {
  const key = `dome|${color}|${accent ?? ''}`;
  let ctx = shipCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  const R = DOME_R;
  ctx.circle(0, 0, R + 2.5).stroke({ width: 5, color, alpha: 0.2 }); // the occupied socket glows
  ctx.circle(0, 0, R).fill({ color: darken(color, 0.72), alpha: 0.42 }); // glassy: the hull and its outline show through
  ctx.circle(0, 0, R * 0.74).fill({ color, alpha: 0.16 });
  ctx.circle(0, 0, R).stroke({ width: 1.9, color, alpha: 1 });
  ctx.circle(0, 0, R).stroke({ width: 0.7, color: brighten(color, 0.75), alpha: 0.9 });
  if (accent !== null) ctx.circle(0, 0, R * 0.62).stroke({ width: 1, color: accent, alpha: 0.6 });
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    ctx.circle(Math.cos(a) * R * 0.84, Math.sin(a) * R * 0.84, 0.9);
  }
  ctx.fill({ color: brighten(color, 0.5), alpha: 0.9 });
  ctx.moveTo(Math.cos(-2.5) * R * 0.62, Math.sin(-2.5) * R * 0.62).arc(0, 0, R * 0.62, -2.5, -1.35)
    .stroke({ width: 1.5, color: 0xffffff, alpha: 0.35, cap: 'round' });
  shipCache.set(key, ctx);
  return ctx;
}

/** Rotating dome barrel by kit (flak twin barrels / laser emitter lens / seeker pod with tubes), or the cosmetic mount. */
export function domeBarrel(kit: TurretKitId, color: number, look: TurretLook | null = null): GraphicsContext {
  const mount = look && look.p.mount !== 'std' ? look.p.mount : 'std';
  const key = `barrel|${kit}|${color}|${mount}|${mount !== 'std' && look ? look.p.accent : ''}`;
  let ctx = shipCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  const R = DOME_R, c = brighten(color, 0.6), body = darken(color, 0.4);
  if (mount !== 'std' && look) {
    drawMount(ctx, mount, R * 0.95, color, look.p.accent);
  } else if (kit === 'flak') { // twin short barrels on a breech block
    for (const sy of [1, -1]) {
      ctx.poly([R * 0.2, sy * R * 0.16, R * 1.3, sy * R * 0.16, R * 1.3, sy * R * 0.4, R * 0.2, sy * R * 0.4], true)
        .fill({ color: body, alpha: 0.95 }).stroke({ width: 1.3, color: c, alpha: 1, join: 'round' });
      ctx.poly([R * 1.22, sy * R * 0.1, R * 1.5, sy * R * 0.1, R * 1.5, sy * R * 0.46, R * 1.22, sy * R * 0.46], true)
        .stroke({ width: 1.2, color: c, alpha: 1, join: 'round' });
    }
    ctx.poly([R * -0.1, R * 0.5, R * 0.55, R * 0.5, R * 0.55, R * -0.5, R * -0.1, R * -0.5], true)
      .fill({ color: body, alpha: 0.9 }).stroke({ width: 1.3, color: c, alpha: 1 });
  } else if (kit === 'laser') { // emitter prongs + lens
    ctx.moveTo(R * 0.25, R * 0.36).lineTo(R * 1.35, R * 0.14).moveTo(R * 0.25, -R * 0.36).lineTo(R * 1.35, -R * 0.14)
      .stroke({ width: 1.8, color: c, alpha: 1, cap: 'round' });
    ctx.circle(R * 1.02, 0, R * 0.3).fill({ color: body, alpha: 0.9 }).stroke({ width: 1.3, color: c, alpha: 1 });
    ctx.circle(R * 1.02, 0, R * 0.17).fill({ color: 0xffffff, alpha: 0.95 });
  } else { // seeker pod with four tubes
    ctx.roundRect(R * 0.02, -R * 0.52, R * 1.3, R * 1.04, R * 0.22).fill({ color: body, alpha: 0.95 }).stroke({ width: 1.3, color: c, alpha: 1 });
    for (const [x, y] of [[1.08, 0.24], [1.08, -0.24], [0.72, 0.24], [0.72, -0.24]]) ctx.circle(x * R, y * R, R * 0.12);
    ctx.fill({ color: 0xffffff, alpha: 0.95 });
  }
  // hub + gunner spark
  ctx.circle(0, 0, R * 0.36).fill({ color: brighten(color, 0.2), alpha: 0.9 }).stroke({ width: 1, color: c, alpha: 1 });
  ctx.circle(R * 0.08, 0, R * 0.14).fill({ color: 0xffffff, alpha: 0.95 });
  shipCache.set(key, ctx);
  return ctx;
}

/** Animated auxiliary parts (tech floating nodes; engineer antenna tip). Null when the class has none. */
export function shipAux(cls: ShipClassId, color: number, radius: number, nodeColor: number): GraphicsContext | null {
  if (cls === 'brute') return null;
  const key = `${cls}|${color}|${radius}|${nodeColor}`;
  let ctx = auxCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  if (cls === 'tech') {
    neonPolys(ctx, HULLS.tech.nodes!.map((p) => scaled(p, radius)), nodeColor, brighten(nodeColor, 0.4), 0.7, 1.4);
  } else {
    ctx.circle(ENGINEER_ANTENNA[0] * radius, ENGINEER_ANTENNA[1] * radius, Math.max(1.6, radius * 0.08)).fill({ color: nodeColor, alpha: 1 });
  }
  auxCache.set(key, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Deployables (drawn at unit-ish px sizes; scaled by the renderer)
// ---------------------------------------------------------------------------------------------

const deployCache = new Map<string, GraphicsContext>();

/** Static body for sentry / drone at radius px. part: 'base' | 'head'. */
export function deployBody(kind: DeployableKind, part: 'base' | 'head', color: number, r: number): GraphicsContext {
  const key = `${kind}|${part}|${color}|${r}`;
  let ctx = deployCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  if (kind === 'sentry') {
    if (part === 'base') {
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
        ctx.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35).lineTo(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25);
      }
      ctx.stroke({ width: 5, color, alpha: 0.18 });
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
        ctx.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35).lineTo(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25);
      }
      ctx.stroke({ width: 2, color, alpha: 1, cap: 'round' });
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
        ctx.circle(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25, Math.max(1.5, r * 0.12));
      }
      ctx.fill({ color: brighten(color, 0.5), alpha: 1 });
      neonPolys(ctx, [hex(r * 0.62, 0)], color, darken(color, 0.7), 0.85, 1.8);
    } else {
      neonPolys(ctx, [rect(r * 0.2, r * 0.16, r * 1.15, -r * 0.16)], color, darken(color, 0.5), 0.9, 1.5);
      ctx.circle(0, 0, r * 0.42).fill({ color: darken(color, 0.6), alpha: 0.95 }).stroke({ width: 1.8, color: brighten(color, 0.3), alpha: 1 });
      ctx.circle(r * 0.12, 0, r * 0.12).fill({ color: 0xffffff, alpha: 0.95 });
    }
  } else if (kind === 'drone') {
    neonPolys(ctx, [scaled([1.1, 0, -0.6, 0.75, -0.25, 0, -0.6, -0.75], r)], color, darken(color, 0.6), 0.8, 1.6);
    ctx.circle(r * 0.25, 0, Math.max(1.2, r * 0.14)).fill({ color: 0xffffff, alpha: 1 });
  }
  deployCache.set(key, ctx);
  return ctx;
}

/** Shield wall body along +x, centered, `length` long, `half` half-thickness. */
export function wallBody(color: number, length: number, half: number): GraphicsContext {
  const L = Math.round(length), h = Math.max(4, Math.round(half));
  const key = `wall|${color}|${L}|${h}`;
  let ctx = deployCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  const x0 = -L / 2, x1 = L / 2;
  ctx.roundRect(x0, -h, L, h * 2, h).fill({ color, alpha: 0.1 });
  ctx.roundRect(x0 - 2, -h - 2, L + 4, h * 2 + 4, h + 2).stroke({ width: 7, color, alpha: 0.16 });
  ctx.roundRect(x0, -h, L, h * 2, h).stroke({ width: 1.8, color, alpha: 0.95 });
  ctx.moveTo(x0 + h, 0).lineTo(x1 - h, 0).stroke({ width: 1.4, color: brighten(color, 0.7), alpha: 0.9 });
  // hex lattice
  const hr = h * 0.62;
  for (let x = x0 + h * 1.3; x < x1 - h * 0.8; x += hr * 1.9) ctx.poly(hex(hr, Math.PI / 6).map((v, i) => (i % 2 ? v : v + x)), true);
  ctx.stroke({ width: 1, color: brighten(color, 0.4), alpha: 0.4 });
  // end emitters
  for (const x of [x0, x1]) ctx.circle(x, 0, h * 0.75).fill({ color: brighten(color, 0.6), alpha: 0.9 });
  deployCache.set(key, ctx);
  return ctx;
}

/** Enemies are drawn at this nominal radius, then scaled by view.radius / ENEMY_BASE_R. */
export const ENEMY_BASE_R = 20;

const enemyCache = new Map<string, GraphicsContext>();

function neon(ctx: GraphicsContext, polys: Poly[], color: number, fillA = 0.18, w = 2.6): void {
  for (const p of polys) ctx.poly(p, true).fill({ color: darken(color, 0.6), alpha: fillA });
  for (const p of polys) ctx.poly(p, true);
  ctx.stroke({ width: w * 3, color, alpha: 0.16, join: 'round' });
  for (const p of polys) ctx.poly(p, true);
  ctx.stroke({ width: w, color, alpha: 1, join: 'round' });
  for (const p of polys) ctx.poly(p, true);
  ctx.stroke({ width: w * 0.35, color: brighten(color, 0.7), alpha: 0.9, join: 'round' });
}

export function enemyBody(kind: EnemyKind, elite: boolean): GraphicsContext {
  const key = `${kind}|${elite ? 1 : 0}`;
  let ctx = enemyCache.get(key);
  if (ctx) return ctx;
  ctx = new GraphicsContext();
  const R = ENEMY_BASE_R;
  const col = elite ? brighten(ENEMY_COLORS[kind], 0.25) : ENEMY_COLORS[kind];
  switch (kind) {
    case 'drone':
      neon(ctx, [[R, 0, 0, R * 0.62, -R, 0, 0, -R * 0.62], [R * 0.45, 0, 0, R * 0.28, -R * 0.45, 0, 0, -R * 0.28]], col);
      break;
    case 'dart':
      neon(ctx, [[R * 1.25, 0, -R * 0.9, R * 0.6, -R * 0.45, 0, -R * 0.9, -R * 0.6]], col, 0.3);
      break;
    case 'weaver':
      neon(ctx, [ngon(4, R, Math.PI / 4), ngon(4, R * 0.62, 0)], col);
      break;
    case 'splitter':
      neon(ctx, [ngon(4, R * 1.1, Math.PI / 4)], col);
      ctx.moveTo(-R * 0.78, 0).lineTo(R * 0.78, 0).moveTo(0, -R * 0.78).lineTo(0, R * 0.78)
        .stroke({ width: 1.6, color: col, alpha: 0.8 });
      break;
    case 'splitling':
      neon(ctx, [ngon(4, R, Math.PI / 4)], col, 0.25, 3);
      break;
    case 'spinner': {
      const blades: Poly[] = [];
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const p = (ang: number, r: number) => [Math.cos(a + ang) * r, Math.sin(a + ang) * r];
        blades.push([...p(0, R * 0.15), ...p(0, R * 1.1), ...p(0.9, R * 0.75)]);
      }
      neon(ctx, blades, col, 0.3);
      ctx.circle(0, 0, R * 0.22).fill({ color: brighten(col, 0.6), alpha: 1 });
      break;
    }
    case 'brute':
      neon(ctx, [hex(R, 0), hex(R * 0.66, Math.PI / 6)], col, 0.25, 3.2);
      ctx.circle(0, 0, R * 0.2).fill({ color: brighten(col, 0.5), alpha: 0.9 });
      break;
    case 'hive':
      // core only; rotating rings are separate children (hiveRing)
      neon(ctx, [ngon(8, R * 0.55, 0), ngon(8, R * 0.3, Math.PI / 8)], col, 0.35, 3);
      ctx.circle(0, 0, R * 0.14).fill({ color: 0xffffff, alpha: 1 });
      break;
    case 'blackhole':
      ctx.circle(0, 0, R).fill({ color: 0x000000, alpha: 0.95 });
      ctx.circle(0, 0, R).stroke({ width: 7, color: col, alpha: 0.2 });
      ctx.circle(0, 0, R).stroke({ width: 2.2, color: brighten(col, 0.3), alpha: 1 });
      ctx.circle(0, 0, R * 0.6).stroke({ width: 1.2, color: col, alpha: 0.5 });
      break;
    case 'matriarch':
      // body only; halo / wings / brood are separate children (matriarchPart) so they can animate per phase
      drawMatriarchBody(ctx, col);
      break;
  }
  enemyCache.set(key, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// v0.3 M4 — the Hive Matriarch (EnemyKind 'matriarch', radius 88: drawn at ENEMY_BASE_R, scaled ×4.4).
// A queen seen from above, facing +x: segmented abdomen behind, hex thorax with a core gem, crowned head with
// mandibles, three leg pairs; separate layers for the royal halo (behind, rotating), two wing pairs (fluttering)
// and the magenta brood sacs on the abdomen (pulsing in Brood Burst). Strokes are thin (the root scale is ×4.4).
// ---------------------------------------------------------------------------------------------

/** Matriarch layer ids: 0 halo (behind), 1 wings (behind the body), 2 brood (over the abdomen). */
export type MatriarchPart = 0 | 1 | 2;

function ellipsePoly(cx: number, cy: number, rx: number, ry: number, n: number): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) { const a = (i * Math.PI * 2) / n; out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }
  return out;
}

/** Matriarch body geometry (unit R = ENEMY_BASE_R), exported for the bounds test. */
export const MATRIARCH_GEOM = (() => {
  const R = ENEMY_BASE_R;
  const abdomen = ellipsePoly(-0.56 * R, 0, 0.5 * R, 0.44 * R, 18);
  const thorax = hex(0.34 * R, 0);
  const head: Poly = [0.8 * R, 0, 0.62 * R, 0.2 * R, 0.38 * R, 0.17 * R, 0.38 * R, -0.17 * R, 0.62 * R, -0.2 * R];
  const legs: Poly[] = [];
  for (const [bx, kx, ky, fx, fy] of [[0.14, 0.36, 0.6, 0.56, 0.84], [0, 0.04, 0.7, 0.1, 0.97], [-0.14, -0.3, 0.6, -0.46, 0.88]]) {
    legs.push([bx * R, 0.28 * R, kx * R, ky * R, fx * R, fy * R], [bx * R, -0.28 * R, kx * R, -ky * R, fx * R, -fy * R]);
  }
  const mandibles: Poly[] = [
    [0.7 * R, 0.13 * R, 0.94 * R, 0.21 * R, 1.02 * R, 0.07 * R],
    [0.7 * R, -0.13 * R, 0.94 * R, -0.21 * R, 1.02 * R, -0.07 * R],
  ];
  const crown: Poly[] = [];
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * (0.62 + (i / 6) * 0.76); // the back half of the head
    const hx = 0.56 * R, c = Math.cos(a), s = Math.sin(a), w = 0.12;
    crown.push([hx + Math.cos(a - w) * 0.19 * R, Math.sin(a - w) * 0.19 * R, hx + c * 0.34 * R, s * 0.34 * R, hx + Math.cos(a + w) * 0.19 * R, Math.sin(a + w) * 0.19 * R]);
  }
  const wings: Poly[] = [];
  const upper = [0.05, 0.2, -0.2, 0.72, -0.55, 1.0, -0.9, 0.92, -0.72, 0.58, -0.3, 0.3];
  const lower = [0, 0.22, -0.36, 0.55, -0.8, 0.7, -1.05, 0.55, -0.86, 0.38, -0.4, 0.25];
  for (const w of [upper, lower]) { wings.push(scaled(w, R), scaled(mirrorY(w), R)); }
  const brood: [number, number][] = [[-0.38, 0.2], [-0.62, 0.24], [-0.85, 0.13], [-0.38, -0.2], [-0.62, -0.24], [-0.85, -0.13]];
  return { abdomen, thorax, head, legs, mandibles, crown, wings, brood: brood.map(([x, y]) => [x * R, y * R] as [number, number]) };
})();

function drawMatriarchBody(ctx: GraphicsContext, col: number): void {
  const R = ENEMY_BASE_R, G = MATRIARCH_GEOM;
  // legs under the carapace
  for (const l of G.legs) ctx.moveTo(l[0], l[1]).lineTo(l[2], l[3]).lineTo(l[4], l[5]);
  ctx.stroke({ width: 1.6, color: darken(col, 0.15), alpha: 0.35, join: 'round' });
  for (const l of G.legs) ctx.moveTo(l[0], l[1]).lineTo(l[2], l[3]).lineTo(l[4], l[5]);
  ctx.stroke({ width: 0.7, color: brighten(col, 0.3), alpha: 0.95, join: 'round' });
  // abdomen + bands
  ctx.poly(G.abdomen, true).fill({ color: darken(col, 0.72), alpha: 0.55 });
  ctx.poly(G.abdomen, true).stroke({ width: 3, color: col, alpha: 0.16, join: 'round' });
  ctx.poly(G.abdomen, true).stroke({ width: 1.1, color: col, alpha: 1, join: 'round' });
  for (const bx of [-0.3, -0.55, -0.8]) {
    const u = (bx * R + 0.56 * R) / (0.5 * R), hy = 0.44 * R * Math.sqrt(Math.max(0, 1 - u * u)) * 0.88;
    ctx.moveTo(bx * R + 0.05 * R, -hy).quadraticCurveTo(bx * R - 0.06 * R, 0, bx * R + 0.05 * R, hy);
  }
  ctx.stroke({ width: 0.8, color: brighten(col, 0.4), alpha: 0.6 });
  // thorax + core gem
  ctx.poly(G.thorax, true).fill({ color: darken(col, 0.6), alpha: 0.7 });
  ctx.poly(G.thorax, true).stroke({ width: 3, color: col, alpha: 0.16, join: 'round' });
  ctx.poly(G.thorax, true).stroke({ width: 1.2, color: brighten(col, 0.15), alpha: 1, join: 'round' });
  ctx.poly(hex(0.17 * R, Math.PI / 6), true).stroke({ width: 0.8, color: brighten(col, 0.5), alpha: 0.8 });
  ctx.circle(0, 0, 0.09 * R).fill({ color: 0xffffff, alpha: 1 });
  // head, mandibles, eyes
  ctx.poly(G.head, true).fill({ color: darken(col, 0.55), alpha: 0.8 }).stroke({ width: 1.1, color: brighten(col, 0.2), alpha: 1, join: 'round' });
  for (const m of G.mandibles) ctx.moveTo(m[0], m[1]).quadraticCurveTo(m[2], m[3], m[4], m[5]);
  ctx.stroke({ width: 1, color: brighten(col, 0.5), alpha: 1, cap: 'round' });
  ctx.circle(0.64 * R, 0.08 * R, 0.035 * R).fill({ color: 0xffffff, alpha: 1 });
  ctx.circle(0.64 * R, -0.08 * R, 0.035 * R).fill({ color: 0xffffff, alpha: 1 });
  // crown (royal gold)
  for (const c of G.crown) ctx.poly(c, true);
  ctx.fill({ color: MATRIARCH_GOLD, alpha: 0.85 });
  for (const c of G.crown) ctx.poly(c, true);
  ctx.stroke({ width: 0.6, color: brighten(MATRIARCH_GOLD, 0.5), alpha: 1, join: 'round' });
}

const matParts: GraphicsContext[] = [];
/** Matriarch animation layers (cached): 0 halo, 1 wings, 2 brood sacs. */
export function matriarchPart(part: MatriarchPart): GraphicsContext {
  if (matParts[part]) return matParts[part];
  const R = ENEMY_BASE_R, G = MATRIARCH_GEOM;
  const ctx = new GraphicsContext();
  if (part === 0) {
    const n = 12, rr = 1.1 * R;
    for (let i = 0; i < n; i++) {
      const a0 = (i * Math.PI * 2) / n;
      ctx.moveTo(Math.cos(a0) * rr, Math.sin(a0) * rr).arc(0, 0, rr, a0, a0 + (Math.PI * 2) / n * 0.55);
    }
    ctx.stroke({ width: 0.8, color: MATRIARCH_GOLD, alpha: 0.45 });
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) * Math.PI * 2) / n;
      ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr).lineTo(Math.cos(a) * rr * 1.12, Math.sin(a) * rr * 1.12);
    }
    ctx.stroke({ width: 1, color: brighten(MATRIARCH_GOLD, 0.3), alpha: 0.85, cap: 'round' });
  } else if (part === 1) {
    for (const w of G.wings) ctx.poly(w, true);
    ctx.fill({ color: MATRIARCH_WING, alpha: 0.07 });
    for (const w of G.wings) ctx.poly(w, true);
    ctx.stroke({ width: 0.7, color: MATRIARCH_WING, alpha: 0.6, join: 'round' });
    for (const w of G.wings) ctx.moveTo(w[0], w[1]).lineTo(w[6], w[7]); // a vein per wing
    ctx.stroke({ width: 0.5, color: MATRIARCH_WING, alpha: 0.4 });
  } else {
    const c = ENEMY_COLORS.hive;
    for (const [x, y] of G.brood) ctx.ellipse(x, y, 0.1 * R, 0.075 * R);
    ctx.fill({ color: c, alpha: 0.45 });
    for (const [x, y] of G.brood) ctx.ellipse(x, y, 0.1 * R, 0.075 * R);
    ctx.stroke({ width: 0.8, color: brighten(c, 0.3), alpha: 1 });
    for (const [x, y] of G.brood) ctx.circle(x, y, 0.025 * R);
    ctx.fill({ color: 0xffffff, alpha: 0.9 });
  }
  matParts[part] = ctx;
  return ctx;
}

let eliteRingCtx: GraphicsContext | null = null;
export function eliteRing(): GraphicsContext {
  if (eliteRingCtx) return eliteRingCtx;
  const R = ENEMY_BASE_R * 1.45;
  const ctx = new GraphicsContext();
  for (let i = 0; i < 6; i++) {
    const a0 = (i * Math.PI) / 3, a1 = a0 + Math.PI / 5;
    ctx.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1);
  }
  ctx.stroke({ width: 5, color: 0xffffff, alpha: 0.18 });
  for (let i = 0; i < 6; i++) {
    const a0 = (i * Math.PI) / 3, a1 = a0 + Math.PI / 5;
    ctx.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1);
  }
  ctx.stroke({ width: 1.8, color: 0xffffff, alpha: 0.95 });
  eliteRingCtx = ctx;
  return ctx;
}

const hiveRings: GraphicsContext[] = [];
/** Hive boss rotating ring layers (i = 0 outer, 1 middle). */
export function hiveRing(i: number): GraphicsContext {
  if (hiveRings[i]) return hiveRings[i];
  const R = ENEMY_BASE_R;
  const col = i === 0 ? ENEMY_COLORS.hive : 0xff8ae8;
  const ctx = new GraphicsContext();
  if (i === 0) {
    neon(ctx, [ngon(12, R, 0)], col, 0.08, 3);
    for (let k = 0; k < 12; k += 2) {
      const a = (k * Math.PI) / 6;
      ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R).lineTo(Math.cos(a) * R * 1.18, Math.sin(a) * R * 1.18);
    }
    ctx.stroke({ width: 2.5, color: brighten(col, 0.4), alpha: 1 });
  } else {
    const tri: Poly[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI * 2) / 3;
      tri.push([Math.cos(a) * R * 0.8, Math.sin(a) * R * 0.8, Math.cos(a + 0.5) * R * 0.62, Math.sin(a + 0.5) * R * 0.62,
        Math.cos(a - 0.5) * R * 0.62, Math.sin(a - 0.5) * R * 0.62]);
    }
    neon(ctx, tri, col, 0.2, 2.2);
  }
  hiveRings[i] = ctx;
  return ctx;
}
