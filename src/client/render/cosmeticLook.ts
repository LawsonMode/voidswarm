// Cosmetic look resolution + readability math (RENDER agent, v0.3 M2). Pure: no Pixi, no DOM, so the
// readability test (render/cosmetics.readability.test.ts) can run it under node.
//
// `LookTable.update(frame.players)` resolves every player's `PlayerInfo.cosmetics` into a ResolvedLook
// once (when the Map identity or a player's loadout object changes). Unknown / wrong-slot ids fall back
// to the starter. Every visual number is clamped to the readability bounds here, and every accent that
// fails the ΔE/saturation rule is desaturated, so the renderer never has to re-check anything per frame.
import type { PlayerInfo } from '../../shared/protocol';
import type { CosmeticId, CosmeticLoadout, PlayerId, ShipClassId, TurretKitId } from '../../shared/types';
import {
  COSMETICS, TITLE_FRAMES,
  type DeathParams, type EngineParams, type HullParams, type TitleParams, type TurretParams, type WeaponParams,
  type WeaponShape,
} from '../../shared/data/cosmetics';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { ENEMY_COLOR, TEAM_COLORS } from '../../shared/data/teams';
import { ENEMY_COLORS, mix } from './palette';

// =============================================================================================
// Readability contract (ARCHITECTURE.md §3c, proposal §6.8)
// =============================================================================================

export const READABILITY = {
  /** CIE76 ΔE an accent needs from every team / enemy colour ... */
  minDeltaE: 20,
  /** ... unless its HSV saturation is at most this. */
  maxSaturation: 0.30,
  lengthMulMin: 0.8,
  lengthMulMax: 1.6,
  /** Projectile visual width vs the class's standard shot. */
  widthMax: 1.3,
  deathParticlesMax: 70,
  deathLingerMax: 1.5,
  deathRingsMax: 3,
  engineRateMulMax: 1.5,
  engineMixMax: 0.5,
  engineLifeMulMin: 0.6,
  engineLifeMulMax: 2,
  /** Hull silhouette extent vs the base hull. */
  silhouetteMax: 1.12,
  /** Hull shape displacement per unit radius at amount 1. */
  hullDisplaceMax: 0.18,
} as const;

/** Every colour an accent must stay distinguishable from. */
export const READABILITY_REFS: readonly number[] = [...TEAM_COLORS, ...Object.values(ENEMY_COLORS), ENEMY_COLOR];

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const labF = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** CIE L*a*b* (D65) of a 0xRRGGBB colour. */
export function labOf(hex: number): [number, number, number] {
  const r = srgbToLinear((hex >> 16) & 255), g = srgbToLinear((hex >> 8) & 255), b = srgbToLinear(hex & 255);
  const x = labF((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = labF(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = labF((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 colour difference. */
export function deltaE76(a: number, b: number): number {
  const A = labOf(a), B = labOf(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/** HSV saturation 0..1. */
export function hsvSaturation(c: number): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

/** Smallest ΔE from `c` to any readability reference colour. */
export function minDeltaE(c: number): number {
  let m = Infinity;
  for (const r of READABILITY_REFS) m = Math.min(m, deltaE76(c, r));
  return m;
}

export function isReadableAccent(c: number): boolean {
  return hsvSaturation(c) <= READABILITY.maxSaturation || minDeltaE(c) >= READABILITY.minDeltaE;
}

const safeCache = new Map<number, number>();
/** `c` if it passes the readability rule, else the nearest paler version that does (always terminates at white). */
export function safeAccent(c: number): number {
  const hit = safeCache.get(c);
  if (hit !== undefined) return hit;
  let out = c;
  for (let t = 0.1; !isReadableAccent(out) && t <= 1.0001; t += 0.1) out = mix(c, 0xffffff, t);
  safeCache.set(c, out);
  return out;
}

const clamp = (v: number, a: number, b: number): number => (Number.isFinite(v) ? (v < a ? a : v > b ? b : v) : a);

// =============================================================================================
// Weapon projectile metrics (atlas cells; see textures.ts). Visual length/width of each shape's cell
// content relative to the class's standard shot at lengthMul 1. The renderer scales length by lengthMul.
// =============================================================================================

export interface WeaponShapeMetric { len: number; wid: number }
export const WEAPON_SHAPE_METRICS: Readonly<Record<WeaponShape, WeaponShapeMetric>> = {
  std: { len: 1, wid: 1 },
  shard: { len: 1, wid: 1.1 },
  needle: { len: 1.05, wid: 0.55 },
  orb: { len: 0.85, wid: 1 },
  droplet: { len: 1, wid: 1.15 },
};

/** Visual length / width ratio of a weapon look vs the standard shot (readability bound: 0.8–1.6 × length, ≤ 1.3 × width). */
export function weaponVisualRatio(p: WeaponParams): WeaponShapeMetric {
  const m = WEAPON_SHAPE_METRICS[p.shape] ?? WEAPON_SHAPE_METRICS.std;
  const lm = clamp(p.lengthMul, READABILITY.lengthMulMin, READABILITY.lengthMulMax);
  return { len: clamp(m.len * lm, READABILITY.lengthMulMin, READABILITY.lengthMulMax), wid: Math.min(READABILITY.widthMax, m.wid) };
}

// =============================================================================================
// Resolved looks
// =============================================================================================

export interface HullLook { id: CosmeticId; shipClass: ShipClassId; p: HullParams }
export interface WeaponLook { id: CosmeticId; shipClass: ShipClassId; p: WeaponParams; /** weaponVisualRatio(p) */ len: number; wid: number }
export interface TurretLook { id: CosmeticId; kit: TurretKitId; p: TurretParams }

export interface ResolvedLook {
  /** Stable identity of the loadout (slot ids joined). */
  key: string;
  /** null = starter (class slots also fall back when the item is for another class). */
  hull: HullLook | null;
  weapon: WeaponLook | null;
  turret: TurretLook | null;
  engineId: CosmeticId;
  engine: EngineParams;
  /** Accent for engine particles (the tint, or a pale team-neutral white). */
  engineAccent: number;
  deathId: CosmeticId;
  death: DeathParams;
  /** null = no title. */
  title: TitleParams | null;
  /** Framed title string ('' = none). */
  titleText: string;
  killicon: string;
}

function defOf(id: CosmeticId | undefined): (typeof COSMETICS)[string] | undefined {
  return id && Object.prototype.hasOwnProperty.call(COSMETICS, id) ? COSMETICS[id] : undefined;
}

export function clampEngine(p: EngineParams): EngineParams {
  return {
    flame: p.flame === 'twin' || p.flame === 'wide' ? p.flame : 'std',
    particle: p.particle,
    tint: typeof p.tint === 'number' ? safeAccent(p.tint) : 'team',
    mix: clamp(p.mix, 0, READABILITY.engineMixMax),
    rateMul: clamp(p.rateMul, 0, READABILITY.engineRateMulMax),
    lifeMul: clamp(p.lifeMul, READABILITY.engineLifeMulMin, READABILITY.engineLifeMulMax),
  };
}

export function clampDeath(p: DeathParams): DeathParams {
  return {
    preset: p.preset,
    accent: safeAccent(p.accent),
    particles: Math.round(clamp(p.particles, 0, READABILITY.deathParticlesMax)),
    rings: Math.round(clamp(p.rings, 0, READABILITY.deathRingsMax)),
    linger: clamp(p.linger, 0.2, READABILITY.deathLingerMax),
  };
}

const STD_ENGINE: EngineParams = { flame: 'std', particle: 'spark', tint: 'team', mix: 0, rateMul: 1, lifeMul: 1 };
const STD_DEATH: DeathParams = { preset: 'std', accent: 0xf0f6ff, particles: 69, rings: 2, linger: 0.9 };
const TITLE_RE = /^[A-Za-z' ]{1,14}$/;

function build(lo: CosmeticLoadout | undefined, key: string): ResolvedLook {
  const hd = defOf(lo?.hull), wd = defOf(lo?.weapon), td = defOf(lo?.turret);
  const ed = defOf(lo?.engine), dd = defOf(lo?.death), tl = defOf(lo?.title), kd = defOf(lo?.killicon);
  const hull: HullLook | null = hd && hd.slot === 'hull' && hd.set !== 'starter'
    ? { id: hd.id, shipClass: hd.shipClass, p: { ...hd.p, accent: safeAccent(hd.p.accent), amount: clamp(hd.p.amount, 0, 1) } }
    : null;
  let weapon: WeaponLook | null = null;
  if (wd && wd.slot === 'weapon' && wd.set !== 'starter') {
    const p: WeaponParams = { ...wd.p, accent: safeAccent(wd.p.accent), lengthMul: clamp(wd.p.lengthMul, READABILITY.lengthMulMin, READABILITY.lengthMulMax) };
    const r = weaponVisualRatio(p);
    weapon = { id: wd.id, shipClass: wd.shipClass, p, len: r.len, wid: r.wid };
  }
  const turret: TurretLook | null = td && td.slot === 'turret' && td.set !== 'starter'
    ? { id: td.id, kit: td.kit, p: { ...td.p, accent: safeAccent(td.p.accent) } }
    : null;
  const engine = ed && ed.slot === 'engine' ? clampEngine(ed.p) : STD_ENGINE;
  const death = dd && dd.slot === 'death' ? clampDeath(dd.p) : STD_DEATH;
  let title: TitleParams | null = null, titleText = '';
  if (tl && tl.slot === 'title' && TITLE_RE.test(tl.p.text)) {
    title = { ...tl.p, color: safeAccent(tl.p.color) };
    const fr = TITLE_FRAMES[tl.p.frame] ?? TITLE_FRAMES.none;
    titleText = `${fr[0]}${tl.p.text}${fr[1]}`;
  }
  const glyph = kd && kd.slot === 'killicon' && [...kd.p.glyph].length === 1 ? kd.p.glyph : '✦';
  return {
    key, hull, weapon, turret,
    engineId: ed && ed.slot === 'engine' ? ed.id : 'std.engine', engine,
    engineAccent: typeof engine.tint === 'number' ? engine.tint : 0xe8f0ff,
    deathId: dd && dd.slot === 'death' ? dd.id : 'std.death', death,
    title, titleText, killicon: glyph,
  };
}

const lookCache = new Map<string, ResolvedLook>();
export const STARTER_LOOK: ResolvedLook = build(undefined, '');

const loadoutKey = (lo: CosmeticLoadout): string =>
  `${lo.hull ?? ''}|${lo.weapon ?? ''}|${lo.turret ?? ''}|${lo.engine ?? ''}|${lo.death ?? ''}|${lo.title ?? ''}|${lo.killicon ?? ''}`;

/** Resolve a loadout (memoized by its ids; missing / unknown / starter slots → starter). */
export function resolveLook(lo: CosmeticLoadout | undefined | null): ResolvedLook {
  if (!lo) return STARTER_LOOK;
  const key = loadoutKey(lo);
  if (key === '||||||') return STARTER_LOOK;
  let l = lookCache.get(key);
  if (!l) {
    if (lookCache.size > 512) lookCache.clear();
    l = build(lo, key);
    lookCache.set(key, l);
  }
  return l;
}

/** Hull look for a ship of `cls` (null = starter, including an item made for another class). */
export function hullFor(look: ResolvedLook, cls: ShipClassId): HullLook | null {
  const h = look.hull;
  return h && h.shipClass === cls && (h.p.shape !== 'std' || h.p.pattern !== 'none') ? h : null;
}
export function weaponFor(look: ResolvedLook, cls: ShipClassId): WeaponLook | null {
  const w = look.weapon;
  return w && w.shipClass === cls ? w : null;
}
/** Turret-kit look for a ship of `cls` (the kit is 1:1 with the class). */
export function turretFor(look: ResolvedLook, cls: ShipClassId): TurretLook | null {
  const t = look.turret;
  return t && t.kit === SHIP_CLASSES[cls].turret.id ? t : null;
}

/** Kill-feed glyph for a player (the killer): their killicon, or ✦. For the CLIENT kill feed. */
export function killIconFor(info: PlayerInfo | undefined): string {
  return resolveLook(info?.cosmetics).killicon;
}
/** Framed title string for lobby rows / scoreboard ('' = none). */
export function titleFor(info: PlayerInfo | undefined): string {
  return resolveLook(info?.cosmetics).titleText;
}

/**
 * playerId → ResolvedLook for one frame. Rebuilt when the `frame.players` Map identity changes, or when a
 * player's `cosmetics` object is swapped in place (guest self-patch), so equips mid-match apply at once.
 */
export class LookTable {
  private src: Map<PlayerId, PlayerInfo> | null = null;
  private srcLo = new Map<PlayerId, CosmeticLoadout | undefined>();
  readonly looks = new Map<PlayerId, ResolvedLook>();
  /** Bumped on every rebuild (cheap change detector for callers). */
  rev = 0;

  update(players: Map<PlayerId, PlayerInfo>): boolean {
    let dirty = players !== this.src || players.size !== this.srcLo.size;
    if (!dirty) {
      for (const [pid, info] of players) { if (this.srcLo.get(pid) !== info.cosmetics) { dirty = true; break; } }
    }
    if (!dirty) return false;
    this.src = players;
    this.looks.clear();
    this.srcLo.clear();
    for (const [pid, info] of players) {
      this.srcLo.set(pid, info.cosmetics);
      this.looks.set(pid, resolveLook(info.cosmetics));
    }
    this.rev++;
    return true;
  }

  get(pid: PlayerId): ResolvedLook {
    return this.looks.get(pid) ?? STARTER_LOOK;
  }
}
