// Sequencer timing math (pure: no WebAudio). All times are AudioContext seconds.
// Step times are always computed from an absolute origin (origin + n * stepDur), never by
// accumulating increments, so a song never drifts no matter how long it loops.

export const STEPS_PER_BEAT = 4;
export const STEPS_PER_BAR = 16;

/** Seconds per 16th step. */
export function stepDur(bpm: number): number {
  return 60 / bpm / STEPS_PER_BEAT;
}

export function beatDur(bpm: number): number {
  return 60 / bpm;
}

export function barDur(bpm: number): number {
  return stepDur(bpm) * STEPS_PER_BAR;
}

/** Absolute time of global step `n` of a song whose step 0 is at `origin`. */
export function stepTime(origin: number, bpm: number, n: number): number {
  return origin + n * stepDur(bpm);
}

/**
 * Exclusive end of the steps that are due: every step s with fromStep ≤ s < result has
 * stepTime(s) < horizon. Returns fromStep when nothing is due.
 */
export function dueUntil(origin: number, bpm: number, fromStep: number, horizon: number): number {
  const sd = stepDur(bpm);
  // smallest integer s with origin + s*sd >= horizon
  let s = Math.ceil((horizon - origin) / sd - 1e-9);
  if (s <= fromStep) s = fromStep;
  // guard float edge cases
  while (s > fromStep && origin + (s - 1) * sd >= horizon) s--;
  while (origin + s * sd < horizon) s++;
  return s;
}

/**
 * First step index s ≥ fromStep that starts a bar (s % 16 === 0, counted from the origin)
 * and whose time is ≥ minTime. Used for bar-quantized song transitions and section jumps.
 */
export function nextBarStep(origin: number, bpm: number, fromStep: number, minTime: number): number {
  let s = Math.ceil(fromStep / STEPS_PER_BAR) * STEPS_PER_BAR;
  const sd = stepDur(bpm);
  const need = Math.ceil((minTime - origin) / sd - 1e-9);
  if (need > s) s = Math.ceil(need / STEPS_PER_BAR) * STEPS_PER_BAR;
  while (origin + s * sd < minTime - 1e-9) s += STEPS_PER_BAR;
  return s;
}

/** First step s ≥ fromStep on a grid of `grid` steps (1 = 16th, 4 = beat, 16 = bar). */
export function nextGridStep(fromStep: number, grid: number): number {
  return Math.ceil(fromStep / grid) * grid;
}

/** Ping-pong delay time in seconds for a note value at a tempo. */
export function delaySeconds(value: '16' | '8' | '8d' | '8t' | '4', bpm: number): number {
  const q = beatDur(bpm);
  switch (value) {
    case '16': return q / 4;
    case '8': return q / 2;
    case '8d': return (q / 2) * 1.5;
    case '8t': return q / 3;
    case '4': return q;
  }
}

/** Exponential smoothing step: moves cur toward target with time constant tau (s) over dt (s). */
export function smoothToward(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || dt <= 0) return dt <= 0 ? cur : target;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

/** Effective intensity: game value x mapped into the song's [min,max] plus the section bias, clamped 0..1. */
export function effectiveIntensity(x: number, min: number, max: number, bias: number): number {
  const v = min + Math.max(0, Math.min(1, x)) * (max - min) + bias;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hysteresis gate for intensity layers. Threshold 0 is always on. */
export function layerActive(wasActive: boolean, eff: number, threshold: number, hysteresis = 0.04): boolean {
  if (threshold <= 0) return true;
  return wasActive ? eff >= threshold - hysteresis : eff >= threshold;
}

/**
 * Advance a (slot, stepInSlot) cursor one step through a timeline of section lengths.
 * Returns the new cursor, or null when a non-looping song has ended.
 */
export function advanceCursor(
  slot: number, stepInSlot: number, slotSteps: readonly number[], loop: boolean, loopToSlot: number,
): { slot: number; step: number } | null {
  let st = stepInSlot + 1;
  let sl = slot;
  if (st >= slotSteps[sl]!) {
    st = 0;
    sl++;
    if (sl >= slotSteps.length) {
      if (!loop) return null;
      sl = loopToSlot;
    }
  }
  return { slot: sl, step: st };
}

/** Locate a global step inside a timeline (with looping). null when a non-looping song is past its end. */
export function locateStep(
  n: number, slotSteps: readonly number[], loop: boolean, loopToSlot: number,
): { slot: number; step: number } | null {
  let total = 0;
  for (const s of slotSteps) total += s;
  if (total <= 0) return null;
  if (n < total) {
    let acc = 0;
    for (let i = 0; i < slotSteps.length; i++) {
      if (n < acc + slotSteps[i]!) return { slot: i, step: n - acc };
      acc += slotSteps[i]!;
    }
  }
  if (!loop) return null;
  let head = 0;
  for (let i = 0; i < loopToSlot; i++) head += slotSteps[i]!;
  const loopLen = total - head;
  const k = head + ((n - total) % loopLen);
  let acc = 0;
  for (let i = 0; i < slotSteps.length; i++) {
    if (k < acc + slotSteps[i]!) return { slot: i, step: k - acc };
    acc += slotSteps[i]!;
  }
  return null;
}
