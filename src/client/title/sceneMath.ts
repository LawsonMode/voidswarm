// Pure helpers for the Title attract scene (no DOM): seeded RNG, easing, the perspective floor, the
// beat clock. Kept pure so they can be unit-tested in node.

export type Rand = () => number;

/** Small, fast seeded PRNG (mulberry32). The title scene is cosmetic, but a seed keeps the poster frame stable. */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const range = (r: Rand, lo: number, hi: number): number => lo + (hi - lo) * r();
export const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(r() * list.length))];

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 0 → 1 → 0 bump over [0, 1] with soft edges (fade in over `edge`, out over `edge`). */
export function fadeInOut(t: number, edge: number): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.min(1, t / edge, (1 - t) / edge);
}

/** Frame-rate independent exponential approach: move `cur` toward `target` with time constant `tau` seconds. */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (cur - target) * Math.exp(-dt / tau);
}

// ---------------------------------------------------------------------------------------------
// Perspective floor. The camera looks at the horizon; a floor point at depth z (z = 1 at the bottom
// edge of the screen) and lateral position X projects to
//   x = cx + (X − camX) · f / z,   y = horizonY + floorH / z
// where floorH = bottomY − horizonY and f is "px per floor unit at z = 1". Rows scroll toward the viewer.
// ---------------------------------------------------------------------------------------------

export interface FloorCam {
  cx: number;
  horizonY: number;
  floorH: number;
  /** px per floor unit at z = 1 */
  f: number;
  /** lateral camera offset (floor units) */
  camX: number;
}

export interface Pt { x: number; y: number }

export function projectFloor(cam: FloorCam, X: number, z: number, out: Pt): Pt {
  const iz = 1 / Math.max(1e-3, z);
  out.x = cam.cx + (X - cam.camX) * cam.f * iz;
  out.y = cam.horizonY + cam.floorH * iz;
  return out;
}

/** Depth z at which the floor reaches screen row y (inverse of projectFloor's y). */
export function floorDepthAt(cam: FloorCam, y: number): number {
  const dy = y - cam.horizonY;
  return dy <= 0 ? Infinity : cam.floorH / dy;
}

/** Floor X under screen x at depth z (inverse of projectFloor's x). */
export function floorXAt(cam: FloorCam, x: number, z: number): number {
  return cam.camX + ((x - cam.cx) * z) / cam.f;
}

/**
 * Depths of the grid rows, nearest first, for a floor that has scrolled `scroll` rows toward the viewer.
 * Rows sit every `dz` from z = 1 (bottom edge) out to `zMax`. Writes into `out` (reused, no allocation
 * once it has grown) and returns the row count.
 */
export function gridRowDepths(scroll: number, dz: number, zMax: number, out: number[]): number {
  const f = scroll - Math.floor(scroll);
  let n = 0;
  for (let k = 0; ; k++) {
    const z = 1 + (k - f) * dz;
    if (z > zMax) break;
    if (z >= 0.92) out[n++] = z; // one row just past the bottom edge keeps the edge filled while scrolling
    if (k > 4096) break;
  }
  out.length = n;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Beat clock (the title song is 122 bpm, 4/4).
// ---------------------------------------------------------------------------------------------

export const TITLE_BPM = 122;

export const beatMs = (bpm: number): number => 60000 / Math.max(1, bpm);

/** Beats elapsed since `originMs` (fractional; negative before the origin). */
export function beatsSince(nowMs: number, originMs: number, bpm: number): number {
  return (nowMs - originMs) / beatMs(bpm);
}

/** Position inside the current beat, in [0, 1). */
export function beatPhase(nowMs: number, originMs: number, bpm: number): number {
  const b = beatsSince(nowMs, originMs, bpm);
  return b - Math.floor(b);
}

/** Glow pulse for a beat phase: instant attack, exponential decay; the downbeat of a bar hits harder. */
export function beatPulse(phase: number, downbeat: boolean): number {
  const p = clamp(phase, 0, 1);
  return (downbeat ? 1 : 0.6) * Math.exp(-p * 5.5);
}

/** Periodic ridge heights in [0, 1] (a sum of integer-frequency sines, so the strip tiles seamlessly). */
export function ridgeHeights(n: number, rand: Rand, octaves: number, sharp: number): Float32Array {
  const out = new Float32Array(n);
  const waves: { k: number; a: number; p: number }[] = [];
  for (let o = 0; o < octaves; o++) {
    const k = Math.max(1, Math.round((o + 1) * (1.6 + rand() * 1.4)));
    waves.push({ k, a: 1 / (o + 1) ** 0.9, p: rand() * Math.PI * 2 });
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const u = (i / n) * Math.PI * 2;
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(u * w.k + w.p);
    out[i] = v;
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    const t = (out[i] - lo) / span;
    out[i] = sharp > 0 ? t ** (1 + sharp) : t; // sharper peaks, broader valleys
  }
  return out;
}
