// Static SVG art for the Hangar (docs/v0.3-proposal.md §2.4): the class hull with its hull cosmetic (shape
// modifier + accent pattern) in a team colour, plus weapon shots, engine flame and turret mount, and small
// per-item glyphs for the grid. Procedural, no asset files. Geometry is pure (unit-tested); the SVG builders
// need a DOM. Readability rule mirrors the renderer: team colour is the outline and the shots' main colour,
// accents stay secondary (≤ 35% alpha fills, 1–1.4 px strokes), silhouettes stay within 1.12× the base hull.
import type {
  CosmeticDef, DeathParams, EngineParams, HullParams, TurretParams, WeaponParams,
} from '../../shared/data/cosmetics';
import { hexToCss } from '../../shared/data/teams';
import type { ShipClassId } from '../../shared/types';

export type Pt = [number, number];

/** Unit hulls (radius ≈ 1, nose pointing up = −y), matching the lobby silhouettes in icons.ts. */
const BASE_HULLS: Record<ShipClassId, readonly Pt[]> = {
  // Juggernaut: broad armoured wedge with a ram prow
  brute: [[0, -1], [0.533, -0.467], [0.933, -0.067], [0.8, 0.867], [0, 0.533], [-0.8, 0.867], [-0.933, -0.067], [-0.533, -0.467]],
  // Arcanist: slim dart
  tech: [[0, -1], [0.333, 0.067], [0.8, 0.867], [0, 0.467], [-0.8, 0.867], [-0.333, 0.067]],
  // Artificer: hex body
  engineer: [[0, -0.867], [0.6, -0.533], [0.6, 0.267], [0, 0.6], [-0.6, 0.267], [-0.6, -0.533]],
};

/** Max displacement of a shape modifier at amount 1 (× hull radius), and the silhouette bound. */
export const HULL_DISP_MAX = 0.18;
export const HULL_EXTENT_MAX = 1.12;

export function baseHull(cls: ShipClassId): Pt[] {
  return (BASE_HULLS[cls] ?? BASE_HULLS.brute).map(([x, y]) => [x, y]);
}

/** Largest distance of any vertex from the ship centre. */
export function hullExtent(pts: readonly Pt[]): number {
  let m = 0;
  for (const [x, y] of pts) m = Math.max(m, Math.hypot(x, y));
  return m;
}

/**
 * The hull outline with a cosmetic shape modifier: 'spiked' adds a spike on every edge, 'swept' pulls the
 * wings back, 'crest' raises a dorsal crest at the nose. Displacement ≤ 0.18 × amount; any vertex that would
 * leave 1.12× the base extent is pulled back in.
 */
export function hullPoints(cls: ShipClassId, p?: Pick<HullParams, 'shape' | 'amount'>): Pt[] {
  const base = baseHull(cls);
  const amount = Math.max(0, Math.min(1, p?.amount ?? 0));
  const d = HULL_DISP_MAX * amount;
  let pts: Pt[] = base;
  if (p && d > 0) {
    if (p.shape === 'spiked') {
      pts = [];
      for (let i = 0; i < base.length; i++) {
        const a = base[i], b = base[(i + 1) % base.length];
        pts.push(a);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const len = Math.hypot(mx, my) || 1;
        pts.push([mx + (mx / len) * d, my + (my / len) * d]);
      }
    } else if (p.shape === 'swept') {
      pts = base.map(([x, y]) => (y > 0.1 ? [x * (1 + d * 0.4), y + d] as Pt : [x, y] as Pt));
    } else if (p.shape === 'crest') {
      const nose = base[0];
      pts = [[nose[0], nose[1] - d], [0.14, nose[1] + 0.22 - d * 0.5], ...base.slice(1), [-0.14, nose[1] + 0.22 - d * 0.5]];
    }
  }
  const limit = hullExtent(base) * HULL_EXTENT_MAX;
  return pts.map(([x, y]) => {
    const r = Math.hypot(x, y);
    return r > limit ? [(x / r) * limit, (y / r) * limit] as Pt : [x, y] as Pt;
  });
}

/** Projectile length × width in unit terms (lengthMul clamped to the readability range 0.8–1.6). */
export function shotSize(p?: Pick<WeaponParams, 'shape' | 'lengthMul'>): { len: number; wid: number } {
  const mul = Math.max(0.8, Math.min(1.6, p?.lengthMul ?? 1));
  const shape = p?.shape ?? 'std';
  const base = shape === 'needle' ? { len: 0.42, wid: 0.08 } : shape === 'orb' ? { len: 0.22, wid: 0.22 }
    : shape === 'shard' ? { len: 0.34, wid: 0.16 } : shape === 'droplet' ? { len: 0.3, wid: 0.16 } : { len: 0.3, wid: 0.12 };
  return { len: base.len * mul, wid: base.wid };
}

// ------------------------------------------------------------------ SVG (DOM)

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function svgRoot(size: number, viewBox: string, cls: string): SVGSVGElement {
  const s = el('svg', { viewBox, width: size, height: size, class: cls, 'aria-hidden': 'true' });
  return s;
}

const toPath = (pts: readonly Pt[], sc: number, ox = 0, oy = 0): string =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + x * sc).toFixed(2)} ${(oy + y * sc).toFixed(2)}`).join(' ') + ' Z';

const css = (c: number | 'team' | undefined, team: string): string => (typeof c === 'number' ? hexToCss(c) : team);

/** Accent pattern lines inside the hull (clipped), 35% alpha, 1–1.4 px. */
function patternLayer(pattern: HullParams['pattern'], accent: string, sc: number, clipId: string): SVGGElement | null {
  if (pattern === 'none') return null;
  const g = el('g', { 'clip-path': `url(#${clipId})`, stroke: accent, 'stroke-opacity': 0.4, fill: 'none', 'stroke-width': 1.2 });
  if (pattern === 'stripes') {
    for (let i = -2; i <= 2; i++) {
      const y = i * 0.34 * sc;
      g.appendChild(el('path', { d: `M${-sc} ${y + 0.25 * sc} L0 ${y - 0.1 * sc} L${sc} ${y + 0.25 * sc}` }));
    }
  } else if (pattern === 'hex') {
    const r = 0.18 * sc;
    for (let row = -3; row <= 3; row++) {
      for (let col = -3; col <= 3; col++) {
        const cx = col * r * 1.75 + (row % 2 ? r * 0.875 : 0), cy = row * r * 1.5;
        const pts: Pt[] = [];
        for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; pts.push([cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9]); }
        g.appendChild(el('path', { d: toPath(pts, 1) }));
      }
    }
  } else if (pattern === 'rune') {
    const marks = ['M-0.25 -0.35 L-0.1 -0.15 L-0.25 0.05', 'M0.25 -0.35 L0.1 -0.15 L0.25 0.05', 'M-0.12 0.2 L0 0.36 L0.12 0.2', 'M0 -0.55 L0 -0.3'];
    for (const m of marks) {
      const d = m.replace(/-?\d*\.?\d+/g, (n) => (Number(n) * sc).toFixed(2));
      g.appendChild(el('path', { d, 'stroke-width': 1.4 }));
    }
  }
  return g;
}

function hullGroup(cls: ShipClassId, hull: HullParams | undefined, team: string, sc: number, ox: number, oy: number): SVGGElement {
  const g = el('g', { transform: `translate(${ox} ${oy})` });
  const pts = hullPoints(cls, hull);
  const clipId = `hull-clip-${++uid}`;
  const defs = el('defs', {});
  const clip = el('clipPath', { id: clipId });
  clip.appendChild(el('path', { d: toPath(pts, sc) }));
  defs.appendChild(clip);
  g.appendChild(defs);
  g.appendChild(el('path', { d: toPath(pts, sc), fill: team, 'fill-opacity': 0.12, stroke: 'none' }));
  const pat = hull ? patternLayer(hull.pattern, hexToCss(hull.accent), sc, clipId) : null;
  if (pat) g.appendChild(pat);
  if (cls === 'engineer') {
    // tool arms (as in the lobby silhouette)
    g.appendChild(el('path', {
      d: `M${-0.6 * sc} 0 L${-0.9 * sc} ${0.27 * sc} L${-0.9 * sc} ${0.75 * sc} M${0.6 * sc} 0 L${0.9 * sc} ${0.27 * sc} L${0.9 * sc} ${0.75 * sc}`,
      stroke: team, 'stroke-width': 1.6, fill: 'none', 'stroke-linejoin': 'round',
    }));
  }
  g.appendChild(el('path', { d: toPath(pts, sc), fill: 'none', stroke: team, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  return g;
}

function shotPath(p: WeaponParams | undefined, sc: number): string {
  const { len, wid } = shotSize(p);
  const L = len * sc, W = wid * sc;
  switch (p?.shape) {
    case 'shard': return `M0 ${-L / 2} L${W / 2} 0 L0 ${L / 2} L${-W / 2} 0 Z`;
    case 'needle': return `M0 ${-L / 2} L${W / 2} ${L / 2} L${-W / 2} ${L / 2} Z`;
    case 'orb': return `M${W / 2} 0 A${W / 2} ${W / 2} 0 1 0 ${-W / 2} 0 A${W / 2} ${W / 2} 0 1 0 ${W / 2} 0 Z`;
    case 'droplet': return `M0 ${-L / 2} Q${W * 0.8} ${L * 0.2} 0 ${L / 2} Q${-W * 0.8} ${L * 0.2} 0 ${-L / 2} Z`;
    default: return `M${-W / 2} ${-L / 2} L${W / 2} ${-L / 2} L${W / 2} ${L / 2} L${-W / 2} ${L / 2} Z`;
  }
}

function shotGroup(p: WeaponParams | undefined, team: string, sc: number, x: number, y: number): SVGGElement {
  const g = el('g', { transform: `translate(${x} ${y})` });
  g.appendChild(el('path', { d: shotPath(p, sc), fill: team, stroke: team, 'stroke-width': 0.8 }));
  const core = p?.core === 'dark' ? '#0a0614' : p?.core === 'accent' ? hexToCss(p.accent) : '#ffffff';
  const { wid } = shotSize(p);
  g.appendChild(el('circle', { cx: 0, cy: 0, r: Math.max(0.8, wid * sc * 0.22), fill: core }));
  if (p?.muzzle === 'ring') g.appendChild(el('circle', { cx: 0, cy: 0, r: wid * sc * 0.9 + 1.5, fill: 'none', stroke: hexToCss(p.accent), 'stroke-width': 1, opacity: 0.6 }));
  return g;
}

function flameGroup(p: EngineParams | undefined, team: string, sc: number, x: number, y: number): SVGGElement {
  const g = el('g', { transform: `translate(${x} ${y})` });
  const tint = css(p?.tint ?? 'team', team);
  const flame = (dx: number, w: number, l: number) =>
    el('path', { d: `M${dx - w} 0 Q${dx} ${l * 1.1} ${dx + w} 0 Z`, fill: tint, 'fill-opacity': 0.75, stroke: team, 'stroke-width': 0.8 });
  const L = 0.9 * sc * Math.min(2, Math.max(0.6, p?.lifeMul ?? 1)) ** 0.5;
  if (p?.flame === 'twin') { g.appendChild(flame(-0.18 * sc, 0.1 * sc, L)); g.appendChild(flame(0.18 * sc, 0.1 * sc, L)); }
  else if (p?.flame === 'wide') g.appendChild(flame(0, 0.3 * sc, L * 0.9));
  else g.appendChild(flame(0, 0.16 * sc, L));
  // particle hint
  const n = Math.round(3 * Math.min(1.5, Math.max(0.5, p?.rateMul ?? 1)));
  for (let i = 0; i < n; i++) {
    const accentShare = i < Math.round(n * Math.min(0.5, p?.mix ?? 0));
    g.appendChild(el('circle', {
      cx: ((i % 2 ? 1 : -1) * (0.08 + 0.07 * i)) * sc, cy: L * (1.1 + 0.28 * i), r: Math.max(0.8, 0.05 * sc),
      fill: accentShare ? tint : team, opacity: 0.7 - i * 0.15,
    }));
  }
  return g;
}

function mountGroup(p: TurretParams | undefined, team: string, sc: number, x: number, y: number): SVGGElement {
  const g = el('g', { transform: `translate(${x} ${y})`, fill: 'none', stroke: team, 'stroke-width': 1.4, 'stroke-linejoin': 'round' });
  const r = 0.22 * sc;
  const accent = p ? hexToCss(p.accent) : team;
  switch (p?.mount) {
    case 'jaw':
      g.appendChild(el('path', { d: `M${-r} ${-r * 0.2} L0 ${-r} L${r} ${-r * 0.2} M${-r} ${r * 0.2} L0 ${r} L${r} ${r * 0.2}` }));
      break;
    case 'crown':
      g.appendChild(el('path', { d: `M${-r} ${r * 0.6} L${-r} ${-r * 0.4} L${-r * 0.5} ${r * 0.1} L0 ${-r} L${r * 0.5} ${r * 0.1} L${r} ${-r * 0.4} L${r} ${r * 0.6} Z` }));
      break;
    case 'hive': {
      const pts: Pt[] = [];
      for (let k = 0; k < 6; k++) { const a = (k * Math.PI) / 3; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      g.appendChild(el('path', { d: toPath(pts, 1) }));
      break;
    }
    case 'lens':
      g.appendChild(el('circle', { cx: 0, cy: 0, r }));
      g.appendChild(el('circle', { cx: 0, cy: 0, r: r * 0.45, stroke: accent }));
      break;
    default:
      g.appendChild(el('circle', { cx: 0, cy: 0, r: r * 0.8 }));
  }
  if (p && p.mount !== 'std') g.appendChild(el('circle', { cx: 0, cy: 0, r: Math.max(0.8, r * 0.18), fill: accent, stroke: 'none' }));
  return g;
}

function burstGroup(p: DeathParams | undefined, team: string, sc: number, x: number, y: number): SVGGElement {
  const g = el('g', { transform: `translate(${x} ${y})`, fill: 'none' });
  const accent = p ? hexToCss(p.accent) : team;
  const rings = Math.max(1, Math.min(3, p?.rings ?? 2));
  for (let i = 0; i < rings; i++) g.appendChild(el('circle', { cx: 0, cy: 0, r: (0.35 + i * 0.28) * sc, stroke: i ? accent : team, 'stroke-width': 1.3, opacity: 0.9 - i * 0.25 }));
  const spokes = p?.preset === 'implode' ? 6 : p?.preset === 'shatter' ? 9 : p?.preset === 'hatch' ? 5 : 8;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    const r0 = (p?.preset === 'implode' ? 0.95 : 0.2) * sc, r1 = (p?.preset === 'implode' ? 0.55 : 0.9) * sc;
    g.appendChild(el('path', { d: `M${Math.cos(a) * r0} ${Math.sin(a) * r0} L${Math.cos(a) * r1} ${Math.sin(a) * r1}`, stroke: k % 2 ? accent : team, 'stroke-width': 1.2 }));
  }
  g.appendChild(el('circle', { cx: 0, cy: 0, r: 0.12 * sc, fill: team }));
  return g;
}

export interface PreviewLook {
  hull?: HullParams;
  weapon?: WeaponParams;
  turret?: TurretParams;
  engine?: EngineParams;
}

/** The Hangar centre preview: hull + pattern, a volley of primary shots, the engine flame and the turret mount. */
export function hangarPreview(cls: ShipClassId, look: PreviewLook, teamColor: string, size = 220): SVGSVGElement {
  const s = svgRoot(size, '-100 -130 200 260', 'hangar-preview');
  const sc = 56;
  // The flame starts at the hull's rear centre (the tail notch / aft edge).
  const tail = baseHull(cls).reduce((m, [x, y]) => (Math.abs(x) < 0.05 ? Math.max(m, y) : m), 0.5);
  s.appendChild(flameGroup(look.engine, teamColor, sc, 0, tail * sc));
  s.appendChild(hullGroup(cls, look.hull, teamColor, sc, 0, 0));
  s.appendChild(mountGroup(look.turret, teamColor, sc, 0, 0.15 * sc));
  for (let i = 0; i < 3; i++) s.appendChild(shotGroup(look.weapon, teamColor, sc * 0.9, 0, -1.35 * sc - i * 0.42 * sc));
  return s;
}

/** A grid-tile glyph for one catalog item, drawn in `teamColor` (outline / main colour). */
export function itemIcon(def: CosmeticDef, cls: ShipClassId, teamColor: string, size = 40): SVGSVGElement {
  const s = svgRoot(size, '-32 -32 64 64', 'item-icon');
  const sc = 24;
  switch (def.slot) {
    case 'hull': s.appendChild(hullGroup(def.shipClass ?? cls, def.p, teamColor, sc, 0, 0)); break;
    case 'weapon': {
      s.appendChild(shotGroup(def.p, teamColor, sc * 1.8, -8, 4));
      s.appendChild(shotGroup(def.p, teamColor, sc * 1.8, 9, -4));
      break;
    }
    case 'turret': s.appendChild(mountGroup(def.p, teamColor, sc * 2.2, 0, 0)); break;
    case 'engine': s.appendChild(flameGroup(def.p, teamColor, sc * 0.9, 0, -18)); break;
    case 'death': s.appendChild(burstGroup(def.p, teamColor, sc, 0, 0)); break;
    case 'title': {
      const t = el('text', { x: 0, y: 7, 'text-anchor': 'middle', 'font-size': 22, fill: hexToCss(def.p.color), 'font-weight': 700 });
      t.textContent = def.p.text ? def.p.text.slice(0, 2) : '—';
      s.appendChild(t);
      break;
    }
    case 'killicon': {
      const t = el('text', { x: 0, y: 11, 'text-anchor': 'middle', 'font-size': 32, fill: teamColor });
      t.textContent = def.p.glyph || '✦';
      s.appendChild(t);
      break;
    }
  }
  return s;
}

/** Slot-row glyphs (text, so they scale with the row font). */
export const SLOT_GLYPHS: Readonly<Record<CosmeticDef['slot'], string>> = {
  hull: '⬠', weapon: '➹', turret: '◎', engine: '≋', death: '✺', title: '❝', killicon: '✦',
};
