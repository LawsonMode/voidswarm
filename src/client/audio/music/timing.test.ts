import { describe, expect, it } from 'vitest';
import {
  advanceCursor, barDur, beatDur, delaySeconds, dueUntil, effectiveIntensity, layerActive, locateStep, nextBarStep,
  nextGridStep, smoothToward, stepDur, stepTime,
} from './timing';

describe('step clock', () => {
  it('16th = quarter / 4', () => {
    expect(stepDur(120)).toBeCloseTo(0.125, 12);
    expect(beatDur(150)).toBeCloseTo(0.4, 12);
    expect(barDur(150)).toBeCloseTo(1.6, 12);
  });
  it('absolute step times never drift (vs accumulating increments)', () => {
    const origin = 3.25;
    const n = 1_000_000;
    let acc = origin;
    for (let i = 0; i < n; i++) acc += stepDur(147);
    const exact = origin + (n * 60) / 147 / 4;
    expect(Math.abs(stepTime(origin, 147, n) - exact)).toBeLessThan(1e-9);
    // the naive accumulation drifts measurably; the engine never does it
    expect(Math.abs(acc - exact)).toBeGreaterThan(Math.abs(stepTime(origin, 147, n) - exact));
  });
  it('dueUntil: steps strictly before the horizon', () => {
    // bpm 120 → 0.125 s steps from origin 1.0
    expect(dueUntil(1, 120, 0, 1)).toBe(0);
    expect(dueUntil(1, 120, 0, 1.0001)).toBe(1);
    expect(dueUntil(1, 120, 0, 1.125)).toBe(1);
    expect(dueUntil(1, 120, 0, 1.126)).toBe(2);
    expect(dueUntil(1, 120, 5, 1.2)).toBe(5); // nothing new due
    expect(dueUntil(1, 120, 0, 0.5)).toBe(0);
  });
  it('lookahead windows tile without gaps or duplicates', () => {
    const origin = 0.1;
    let from = 0;
    const seen: number[] = [];
    for (let now = 0; now < 5; now += 0.025 + Math.random() * 0.01) {
      const to = dueUntil(origin, 133, from, now + 0.12);
      for (let s = from; s < to; s++) seen.push(s);
      from = to;
    }
    expect(seen).toEqual(seen.map((_, i) => i));
    expect(seen.length).toBeGreaterThan(40); // ~5.1 s of 16ths at 133 bpm
    expect(seen.length).toBeLessThan(50);
  });
  it('nextBarStep: bar-quantized and at least minTime', () => {
    // bpm 120 → bar = 2 s
    expect(nextBarStep(0, 120, 0, 0)).toBe(0);
    expect(nextBarStep(0, 120, 1, 0)).toBe(16);
    expect(nextBarStep(0, 120, 3, 2.0)).toBe(16);
    expect(nextBarStep(0, 120, 3, 2.01)).toBe(32);
    expect(nextBarStep(10, 120, 20, 15.5)).toBe(48); // 15.5 s needs step 44 → bar at 48
    for (let k = 0; k < 50; k++) {
      const from = Math.floor(Math.random() * 200);
      const min = Math.random() * 30;
      const s = nextBarStep(0, 137, from, min);
      expect(s % 16).toBe(0);
      expect(s).toBeGreaterThanOrEqual(from);
      expect(stepTime(0, 137, s)).toBeGreaterThanOrEqual(min - 1e-9);
      expect(s - 16 < from || stepTime(0, 137, s - 16) < min).toBe(true); // it is the FIRST such bar
    }
  });
  it('grid + delay note values', () => {
    expect(nextGridStep(5, 4)).toBe(8);
    expect(nextGridStep(8, 4)).toBe(8);
    expect(nextGridStep(5, 1)).toBe(5);
    expect(delaySeconds('8d', 120)).toBeCloseTo(0.375, 12);
    expect(delaySeconds('8', 120)).toBeCloseTo(0.25, 12);
    expect(delaySeconds('8t', 120)).toBeCloseTo(1 / 6, 12);
    expect(delaySeconds('4', 100)).toBeCloseTo(0.6, 12);
  });
});

describe('intensity', () => {
  it('smoothing converges and never overshoots', () => {
    let x = 0;
    for (let i = 0; i < 400; i++) { x = smoothToward(x, 1, 0.025, 1.2); expect(x).toBeLessThanOrEqual(1); }
    expect(x).toBeGreaterThan(0.99);
    expect(smoothToward(0.3, 0.9, 0, 1)).toBe(0.3);
    expect(smoothToward(0.3, 0.9, 1.2, 1.2)).toBeCloseTo(0.3 + 0.6 * (1 - Math.exp(-1)), 12);
  });
  it('maps the game value into the song range plus the section bias', () => {
    expect(effectiveIntensity(0, 0.6, 1, 0)).toBeCloseTo(0.6);
    expect(effectiveIntensity(1, 0.6, 1, 0)).toBeCloseTo(1);
    expect(effectiveIntensity(0.5, 0, 1, -0.4)).toBeCloseTo(0.1);
    expect(effectiveIntensity(1, 0, 1, 0.3)).toBe(1);
    expect(effectiveIntensity(-3, 0, 1, 0)).toBe(0);
  });
  it('layers: threshold 0 is always on; hysteresis prevents flicker', () => {
    expect(layerActive(false, 0, 0)).toBe(true);
    expect(layerActive(false, 0.49, 0.5)).toBe(false);
    expect(layerActive(false, 0.5, 0.5)).toBe(true);
    expect(layerActive(true, 0.47, 0.5)).toBe(true);
    expect(layerActive(true, 0.45, 0.5)).toBe(false);
  });
});

describe('song cursor', () => {
  const slots = [16, 32, 16]; // intro, verse, final
  it('advances through slots and loops to loopTo', () => {
    expect(advanceCursor(0, 14, slots, true, 1)).toEqual({ slot: 0, step: 15 });
    expect(advanceCursor(0, 15, slots, true, 1)).toEqual({ slot: 1, step: 0 });
    expect(advanceCursor(2, 15, slots, true, 1)).toEqual({ slot: 1, step: 0 });
    expect(advanceCursor(2, 15, slots, false, 0)).toBeNull();
  });
  it('locateStep agrees with repeated advanceCursor', () => {
    let c: { slot: number; step: number } | null = { slot: 0, step: 0 };
    for (let n = 0; n < 300; n++) {
      expect(locateStep(n, slots, true, 1)).toEqual(c);
      c = advanceCursor(c!.slot, c!.step, slots, true, 1);
    }
    expect(locateStep(64, slots, false, 0)).toBeNull();
    expect(locateStep(63, slots, false, 0)).toEqual({ slot: 2, step: 15 });
  });
});
