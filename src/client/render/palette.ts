// Color helpers + fixed neon palette for the renderer (RENDER agent).
import type { EnemyKind } from '../../shared/types';

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
export const brighten = (c: number, t: number): number => mix(c, 0xffffff, t);
export const darken = (c: number, t: number): number => mix(c, 0x000000, t);

export const BG_COLOR = 0x05030d;
export const GRID_COLOR = 0x2a1f6e;
export const GRID_MAJOR = 0x4a34b8;
export const GRID_HOT = 0x9d7bff;
export const WALL_EDGE = 0x37e6ff;
export const WALL_HALO = 0x8a4bff;
export const WALL_FILL = 0x0a0620;
export const ROCK_EDGE = 0xc78bff;
export const ROCK_HALO = 0xff4fa0;
export const SHIELD_COLOR = 0x7fe3ff;
export const GOLD = 0xffd43b;

export const ENEMY_COLORS: Record<EnemyKind, number> = {
  drone: 0xff4fd8,
  dart: 0xffe03b,
  weaver: 0x4bff6e,
  splitter: 0xb04bff,
  splitling: 0xc77bff,
  spinner: 0xff8a2b,
  blackhole: 0x7a5bff,
  brute: 0xff3b3b,
  hive: 0xff2bd1,
  // v0.3 M4 Hive Matriarch: pearl rose (the queen reads apart from her magenta Hive brood and from the party's
  // crimson: ΔE76 ≥ 39 from every other enemy colour, ≥ 33 from every team colour). Picked so no catalog accent
  // gets closer than the BRASS minimum (≈ 28.6) the readability test pins.
  matriarch: 0xff8fc8,
};
/** Matriarch secondary colours (body parts only; not readability references). */
export const MATRIARCH_GOLD = 0xffd27a;
export const MATRIARCH_WING = 0xeadcff;

/** Gem color ramp by XP value: green → cyan → purple → gold. */
export function gemColor(value: number): number {
  if (value >= 25) return 0xffd43b;
  if (value >= 10) return 0xc05bff;
  if (value >= 4) return 0x3bf2ff;
  return 0x5bff8a;
}
export function gemScale(value: number): number {
  return 0.55 + Math.min(1, Math.log2(1 + value) / 5) * 0.75;
}

/** Energy bar color: green → yellow → red. */
export function energyColor(f: number): number {
  return f > 0.5 ? mix(0xffe03b, 0x4bff6e, (f - 0.5) * 2) : mix(0xff3b3b, 0xffe03b, f * 2);
}
