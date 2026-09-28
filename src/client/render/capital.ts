// v0.5 capital ships + bubble turrets (RENDER agent). Pure: no Pixi, no DOM, so tests run it under node.
//  - hardpoint sockets (every distinct HARDPOINT_LAYOUT mount) + the host-radius estimate from a turret's separation
//  - the capital morph (0.35 s scale-up + crossfade + flash when a host takes its first turret, and back)
//  - turret FIRE presets: every catalog turret item maps to one (tracer / laser / mass driver / flak burst / seeker
//    exhaust); the kit's own projectile kind stays the sim's, the preset only changes how it is drawn and heard.
// Readability: presets carry no colours. Main shot colour is always the team colour; cores use the item's accent
// (already ΔE-checked in cosmeticLook), so team identity is never weakened.
import { HARDPOINT_SEAT, LASER_RESONANCE, MAX_HARDPOINTS, TURRET_BUBBLE_RADIUS } from '../../shared/constants';
import { COSMETIC_LIST } from '../../shared/data/cosmetics';
import { HARDPOINT_LAYOUT, capitalScale } from '../../shared/sim/world';
import type { CosmeticId, TurretKitId } from '../../shared/types';
import type { TurretLook } from './cosmeticLook';

// =============================================================================================
// Hardpoints
// =============================================================================================

/** Capital hull contexts are drawn at base radius × CAP_REF (the 3-turret scale) and scaled by vis / CAP_REF. */
export const CAP_REF = capitalScale(3);
/** Bubble dome radius (px): the docked turret's hitbox. */
export const DOME_R = TURRET_BUBBLE_RADIUS;
/** Muzzle distance from the dome centre (px): the barrel tip. */
export const BARREL_LEN = DOME_R * 1.5;

const clampInt = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, Math.floor(Number.isFinite(v) ? v : a)));

/** Mount [along, side] (hull radii) of turret `slot` of `count` (same clamping as world.turretOffset). */
export function mountOf(count: number, slot: number): readonly [number, number] {
  const L = HARDPOINT_LAYOUT[clampInt(count, 1, MAX_HARDPOINTS)];
  return L[clampInt(slot, 0, L.length - 1)];
}

/** |mount| in hull radii (the turret sits at hostRadius × HARDPOINT_SEAT × this from the host centre). */
export function mountNorm(count: number, slot: number): number {
  const [a, s] = mountOf(count, slot);
  return Math.hypot(a, s);
}

/**
 * Every distinct mount of HARDPOINT_LAYOUT (layout[5]'s five plus the 3-turret centre aft), in [along, side] hull
 * radii. The capital hulls draw a socket at each one (× HARDPOINT_SEAT).
 */
export const HARDPOINT_SOCKETS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let n = 1; n < HARDPOINT_LAYOUT.length; n++) {
    for (const [a, s] of HARDPOINT_LAYOUT[n]) {
      if (!out.some(([x, y]) => Math.abs(x - a) < 1e-6 && Math.abs(y - s) < 1e-6)) out.push([a, s]);
    }
  }
  return out;
})();

/** Socket index of turret `slot` of `count` (-1 never happens: every mount is a socket). */
export function socketOf(count: number, slot: number): number {
  const [a, s] = mountOf(count, slot);
  return HARDPOINT_SOCKETS.findIndex(([x, y]) => Math.abs(x - a) < 1e-6 && Math.abs(y - s) < 1e-6);
}

/**
 * The host's effective (capital-scaled, talents included) radius, recovered from one turret's separation: the client
 * places turrets at host + turretOffset(angle, slot, count, radius), so |sep| = radius × SEAT × mountNorm. Clamped to
 * [lo, hi] (a stale snapshot must not blow the hull up); `fallback` when the mount is degenerate.
 */
export function estimateHostRadius(sep: number, count: number, slot: number, lo: number, hi: number, fallback: number): number {
  const n = mountNorm(count, slot) * HARDPOINT_SEAT;
  if (!(n > 1e-6) || !Number.isFinite(sep)) return fallback;
  const r = sep / n;
  return r < lo ? lo : r > hi ? hi : r;
}

/** World offset of a local [along, side] mount on a host facing `angle` (the turretOffset formula, unclamped mount). */
export function mountOffset(angle: number, along: number, side: number, hostRadius: number, out: { x: number; y: number }): void {
  const r = hostRadius * HARDPOINT_SEAT, c = Math.cos(angle), s = Math.sin(angle);
  out.x = c * along * r - s * side * r;
  out.y = s * along * r + c * side * r;
}

// =============================================================================================
// Capital morph
// =============================================================================================

/** Transform (first turret docks / last one leaves): scale-up + crossfade + flash. */
export const MORPH_SEC = 0.35;
/** Re-flow (turret count changes while capital): scale eases to the new capitalScale. */
export const REFLOW_SEC = 0.25;

export interface CapitalMorph {
  /** Target state: drawn as the capital variant. */
  capital: boolean;
  /** Displayed hull scale vs the base radius (1 = normal hull). */
  vis: number;
  /** Capital hull crossfade 0 (base hull) .. 1 (capital hull). */
  capA: number;
  /** White flash 1 → 0 over MORPH_SEC after a transform. */
  flash: number;
  from: number; to: number; fromA: number; t: number; dur: number;
  /** false until the first step (a ship first seen as a capital snaps, with no transform FX). */
  init: boolean;
}

export function newMorph(): CapitalMorph {
  return { capital: false, vis: 1, capA: 0, flash: 0, from: 1, to: 1, fromA: 0, t: 0, dur: MORPH_SEC, init: false };
}

export function resetMorph(m: CapitalMorph): void {
  m.capital = false; m.vis = 1; m.capA = 0; m.flash = 0; m.from = 1; m.to = 1; m.fromA = 0; m.t = 0; m.dur = MORPH_SEC; m.init = false;
}

const easeOutBack = (p: number): number => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2; };
const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const smooth = (p: number): number => p * p * (3 - 2 * p);

/**
 * Advance one ship's morph toward (`wantCapital`, `wantScale`). Returns 'up' / 'down' on the frame a transform starts
 * (the caller plays the flash / ring / audio cue), else null. A first step snaps to the target silently.
 */
export function stepMorph(m: CapitalMorph, wantCapital: boolean, wantScale: number, dt: number): 'up' | 'down' | null {
  const target = wantCapital && Number.isFinite(wantScale) ? Math.max(1, Math.min(3, wantScale)) : 1;
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
  if (!m.init) {
    m.init = true; m.capital = wantCapital; m.vis = m.from = m.to = target; m.capA = m.fromA = wantCapital ? 1 : 0;
    m.t = m.dur = MORPH_SEC; m.flash = 0;
    return null;
  }
  let ev: 'up' | 'down' | null = null;
  if (wantCapital !== m.capital) {
    m.capital = wantCapital; m.from = m.vis; m.fromA = m.capA; m.to = target; m.t = 0; m.dur = MORPH_SEC; m.flash = 1;
    ev = wantCapital ? 'up' : 'down';
  } else if (Math.abs(target - m.to) > 1e-4) {
    m.from = m.vis; m.fromA = m.capA; m.to = target; m.t = 0; m.dur = REFLOW_SEC;
  }
  m.t = Math.min(m.dur, m.t + step);
  const p = m.dur > 0 ? m.t / m.dur : 1;
  const e = m.to >= m.from ? easeOutBack(p) : easeInOut(p);
  m.vis = m.from + (m.to - m.from) * e;
  const aT = m.capital ? 1 : 0;
  m.capA = m.fromA + (aT - m.fromA) * smooth(p);
  if (p >= 1) { m.vis = m.to; m.capA = aT; }
  m.flash = Math.max(0, m.flash - step / MORPH_SEC);
  return ev;
}

// =============================================================================================
// Turret fire presets
// =============================================================================================

export type FireStyle = 'tracer' | 'laser' | 'massdriver' | 'flak' | 'seeker';
/** Laser core overlay (the resonance-scaled core strokes are never changed). */
export type BeamTex = 'solid' | 'pulse' | 'helix' | 'lance';
export type Exhaust = 'smoke' | 'ion' | 'sparks';

export interface FirePreset {
  id: string;
  name: string;
  style: FireStyle;
  /** The kit whose projectiles this preset draws (flak → shrapnel, laser → beam, seekerpod → seeker). */
  kit: TurretKitId;
  /** Shot tail length in px (tracer / mass driver / flak; 0 = none). Visual only. */
  tail: number;
  /** Muzzle flash size (atlas soft scale). */
  muzzle: number;
  /** Barrel / dome recoil kick (px). */
  recoil: number;
  /** Muzzle shockwave ring radius (px, 0 = none). */
  shock: number;
  /** Laser core overlay. */
  beam: BeamTex;
  /** Seeker exhaust. */
  exhaust: Exhaust;
  /** Mass driver: the leading slug is drawn this big (atlas orb scale, 0 = none). */
  slug: number;
  /** Flak burst puffs at the muzzle (count at density 1). */
  puffs: number;
}

/** Readability bounds for fire presets (tested). */
export const FIRE_BOUNDS = { tailMax: 64, muzzleMax: 1.3, recoilMax: 5, shockMax: 40, slugMax: 0.9, puffsMax: 8 } as const;

const P = (id: string, name: string, style: FireStyle, kit: TurretKitId, o: Partial<FirePreset> = {}): FirePreset =>
  ({ id, name, style, kit, tail: 0, muzzle: 0.5, recoil: 1, shock: 0, beam: 'solid', exhaust: 'smoke', slug: 0, puffs: 0, ...o });

export const FIRE_PRESETS: Readonly<Record<string, FirePreset>> = {
  // flak kit (shrapnel pellets)
  flak: P('flak', 'Flak burst', 'flak', 'flak', { tail: 10, muzzle: 0.7, recoil: 1.5, puffs: 4 }),
  'flak.spore': P('flak.spore', 'Spore burst', 'flak', 'flak', { tail: 8, muzzle: 0.6, recoil: 1.2, puffs: 7 }),
  tracer: P('tracer', 'Tracer rounds', 'tracer', 'flak', { tail: 46, muzzle: 0.55, recoil: 1.2 }),
  massdriver: P('massdriver', 'Mass driver', 'massdriver', 'flak', { tail: 22, muzzle: 1.15, recoil: 4.5, shock: 34, slug: 0.75, puffs: 3 }),
  // laser kit (hitscan beam)
  laser: P('laser', 'Laser beam', 'laser', 'laser', { muzzle: 0.45, recoil: 0.5 }),
  'laser.pulse': P('laser.pulse', 'Pulse laser', 'laser', 'laser', { muzzle: 0.5, recoil: 0.6, beam: 'pulse' }),
  'laser.helix': P('laser.helix', 'Helix laser', 'laser', 'laser', { muzzle: 0.5, recoil: 0.6, beam: 'helix' }),
  'laser.lance': P('laser.lance', 'Sun lance', 'laser', 'laser', { muzzle: 0.8, recoil: 0.8, beam: 'lance' }),
  // seeker pod (homing seekers)
  seeker: P('seeker', 'Seeker smoke', 'seeker', 'seekerpod', { muzzle: 0.5, recoil: 1.5, exhaust: 'smoke' }),
  'seeker.ion': P('seeker.ion', 'Ion seekers', 'seeker', 'seekerpod', { muzzle: 0.5, recoil: 1.2, exhaust: 'ion' }),
  'seeker.hornet': P('seeker.hornet', 'Hornet seekers', 'seeker', 'seekerpod', { muzzle: 0.55, recoil: 1.8, exhaust: 'sparks', tail: 14 }),
};

/** The starter (and fallback) preset of each kit. */
export const KIT_DEFAULT_FIRE: Readonly<Record<TurretKitId, string>> = { flak: 'flak', laser: 'laser', seekerpod: 'seeker' };

/** Every catalog turret item → its fire preset (the cosmetics catalog shape is frozen, so the map lives here). */
export const TURRET_FIRE: Readonly<Record<CosmeticId, string>> = {
  'std.turret.flak': 'flak', 'std.turret.laser': 'laser', 'std.turret.seekerpod': 'seeker',
  // Salvage Line
  'com.turret.flak': 'tracer', 'com.turret.laser': 'laser.pulse', 'com.turret.seekerpod': 'seeker',
  // Rift
  'rift.turret.flak': 'massdriver', 'rift.turret.laser': 'laser.helix', 'rift.turret.seekerpod': 'seeker.ion',
  // Gladiator
  'glad.turret.flak': 'massdriver', 'glad.turret.laser': 'laser.lance', 'glad.turret.seekerpod': 'seeker.hornet',
  // Swarm
  'swarm.turret.flak': 'flak.spore', 'swarm.turret.laser': 'laser.helix', 'swarm.turret.seekerpod': 'seeker.hornet',
};

/** Fire preset of a turret look on `kit` (starter look, unknown id or a preset for another kit → the kit default). */
export function firePresetFor(look: TurretLook | null, kit: TurretKitId): FirePreset {
  const id = look ? TURRET_FIRE[look.id] : undefined;
  const p = id !== undefined && Object.prototype.hasOwnProperty.call(FIRE_PRESETS, id) ? FIRE_PRESETS[id] : undefined;
  return p && p.kit === kit ? p : FIRE_PRESETS[KIT_DEFAULT_FIRE[kit]];
}

/** Compact code for render/beamBus.turretFire (AudioFx swaps the mass-driver thump in). */
export const FIRE_CODE: Readonly<Record<FireStyle, number>> = { flak: 0, tracer: 1, massdriver: 2, laser: 3, seeker: 4 };

/** Catalog turret items without a TURRET_FIRE entry (tests: must be empty). */
export function unmappedTurretItems(): string[] {
  return COSMETIC_LIST.filter((d) => d.slot === 'turret' && !Object.prototype.hasOwnProperty.call(TURRET_FIRE, d.id)).map((d) => d.id);
}

// =============================================================================================
// Turret tag (name + level): only when the reticle hovers the dome, so a stack never clutters
// =============================================================================================

/**
 * The reticle must be on the dome itself (2 dome radii): a capital's domes sit 17-27 px from its centre, so a wider
 * reach lit every tag on the hull whenever you aimed at it. The renderer also shows only the one nearest dome per
 * host (GameRenderer tag pick).
 */
export const TAG_NEAR = 2 * DOME_R;
/** Tag alpha for a dome `d` px from the aim point (1 inside TAG_NEAR / 2, 0 beyond TAG_NEAR). */
export function turretTagAlpha(d: number): number {
  if (!(d < TAG_NEAR)) return 0;
  return Math.min(1, (TAG_NEAR - d) / (TAG_NEAR * 0.5));
}

// =============================================================================================
// Dome size per host (the hitbox stays TURRET_BUBBLE_RADIUS; only the drawing shrinks on a small hull)
// =============================================================================================

/**
 * A dome is drawn at most this fraction of its host's drawn radius. On the Spire (≈ 25 px at 5 turrets) five
 * full-size 9 px domes covered two thirds of the hull and hid its silhouette; at 0.29 five domes cover ≤ 45 % of
 * any class's hull (capital.test.ts). The Dreadnought (≈ 34 px) keeps full-size domes.
 */
export const DOME_VIS_FRAC = 0.29;

/** Draw scale of a dome on a host of drawn radius `hostR` (1 = DOME_R). */
export function domeScale(hostR: number): number {
  return hostR > 0 && Number.isFinite(hostR) ? Math.min(1, (DOME_VIS_FRAC * hostR) / DOME_R) : 1;
}

// =============================================================================================
// Laser beam widths (resonance-scaled, with a visual cap)
// =============================================================================================

/**
 * Beams are drawn at most this resonance's width / glow. v0.5 lets a Spire carry 5 lasers and Overcharge adds one,
 * so resonance reaches 6; the v0.2 formula then drew a 40-70 px slab that whited out the Spire, its domes and the
 * target. Past the cap the extra shows as heat (crackle strands, a throbbing white core), not width. Gameplay
 * (damage, draw) is untouched.
 */
export const LASER_VIS_RES_CAP = 4;
/** The Overcharge halo on each laser is at most this wide (px). */
export const OC_HALO_MAX_W = 18;
/** End-point sparks per beam per frame, at most. */
export const LASER_SPARKS_MAX = 6;
/** Crackle strands per beam, at most. */
export const LASER_STRANDS_MAX = 4;

export interface LaserBeamLook {
  /** Width scale LASER_RESONANCE^(res − 1) of the capped resonance. */
  p: number;
  /** Outer beam width (px); the faint glow is 1.7 × this. */
  outerW: number;
  glowW: number;
  midW: number;
  coreW: number;
  /** Overcharge halo width (px). */
  haloW: number;
  /** Glow / outer alpha multiplier: several beams on one target stack, so each one's glow thins out. */
  stack: number;
  /** Resonance past the visual cap (0 at ≤ LASER_VIS_RES_CAP). */
  over: number;
  /** Crackle strands (≥ resonance 3). */
  strands: number;
}

/** Laser beam widths for resonance `res` (flick = the per-frame shimmer, 0.88…1.12). ≤ res 4 = the v0.2 look. */
export function laserBeamLook(res: number, flick = 1): LaserBeamLook {
  const r = Math.max(1, Number.isFinite(res) ? res : 1);
  const vres = Math.min(r, LASER_VIS_RES_CAP);
  const p = Math.pow(LASER_RESONANCE, vres - 1);
  const outerW = 4 * Math.pow(p, 1.15) * flick;
  return {
    p, outerW, glowW: outerW * 1.7, midW: 1.8 * p * flick, coreW: Math.max(0.8, 0.7 * Math.pow(p, 0.9)),
    haloW: Math.min(OC_HALO_MAX_W, outerW * 2.1),
    stack: r <= 2 ? 1 : Math.sqrt(2 / r),
    over: r - vres,
    strands: r >= 3 ? Math.min(LASER_STRANDS_MAX, Math.floor(r - 2)) : 0,
  };
}

/** End-point sparks per frame for one beam at resonance `res` and particle density `density` (0…1). */
export function laserSparks(res: number, density: number): number {
  const vres = Math.min(Math.max(1, res || 1), LASER_VIS_RES_CAP);
  return Math.min(LASER_SPARKS_MAX, Math.ceil(vres * vres * 0.5 * Math.max(0, density)));
}
