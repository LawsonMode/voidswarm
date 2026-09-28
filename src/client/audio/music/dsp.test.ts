import { describe, expect, it } from 'vitest';
import { nearestLayer } from './drums';
import {
  fdnGain, gatedImpulse, makeNoise, metalBuffer, mixLoops, normalizePeak, pulseCoeffs, renderSawLoop, renderSawLoopMono, softClipCurve,
  stackSpec, waveCoeffs,
} from './dsp';

describe('detuned saw stack loops', () => {
  it('components are distinct integer cycle counts around the reference pitch', () => {
    const { comps, fCenter } = stackSpec(48, 2, [-19, -9, 0, 8, 17], [1, 1, 1, 1, 1], [0, 0, 0, 0, 0]);
    const ks = comps.map((c) => c.cycles);
    expect(new Set(ks).size).toBe(5);
    expect(ks.every(Number.isInteger)).toBe(true);
    expect([...ks].sort((a, b) => a - b)).toEqual(ks);
    expect(Math.abs(1200 * Math.log2(fCenter / 130.8128))).toBeLessThan(5); // within 5 cents of C3
  });
  it('the loop is seamless: rendering two periods gives the first period twice', () => {
    const n = 4800;
    const comps = [{ cycles: 37, amp: 1, pan: -0.5 }, { cycles: 41, amp: 0.8, pan: 0.5 }];
    const phases = [0.2, 0.7];
    const [l, r] = renderSawLoop(n, comps, phases);
    // same frequencies over twice the length = what a looping player would output
    const [l2, r2] = renderSawLoop(2 * n, comps.map((c) => ({ ...c, cycles: c.cycles * 2 })), phases);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(l2[n + i]! - l[i]!), Math.abs(r2[n + i]! - r[i]!), Math.abs(l2[i]! - l[i]!));
    }
    expect(maxDiff).toBeLessThan(1e-5);
  });
  it('normalizes to a peak', () => {
    const [l, r] = renderSawLoop(2000, [{ cycles: 10, amp: 3, pan: 0 }]);
    normalizePeak([l, r], 0.9);
    let m = 0;
    for (const ch of [l, r]) for (const v of ch) m = Math.max(m, Math.abs(v));
    expect(m).toBeCloseTo(0.9, 6);
  });
});

describe('mono loops and chord mixing', () => {
  it('renderSawLoopMono equals the (L+R) of a centred stereo render', () => {
    const comps = [{ cycles: 20, amp: 1, pan: 0 }, { cycles: 23, amp: 0.5, pan: 0 }];
    const m = renderSawLoopMono(1000, comps, [0.1, 0.4]);
    const [l] = renderSawLoop(1000, comps, [0.1, 0.4]);
    for (let i = 0; i < 1000; i++) expect(m[i]!).toBeCloseTo(l[i]! / Math.cos(Math.PI / 4), 5);
  });
  it('mixLoops sums rotated loops and stays seamless', () => {
    const a = Float32Array.from({ length: 8 }, (_, i) => i);
    const b = Float32Array.from({ length: 8 }, (_, i) => 10 * i);
    const out = mixLoops([a, b], [0, 3]);
    // out[i] = a[i] + b[(i + 3) % 8]
    expect(Array.from(out)).toEqual(Array.from({ length: 8 }, (_, i) => i + 10 * ((i + 3) % 8)));
    expect(Array.from(mixLoops([a], [-1]))).toEqual(Array.from({ length: 8 }, (_, i) => (i + 7) % 8));
  });
});

describe('baked oscillator waves', () => {
  it('bass wave = square at f/2 (odd harmonics) + saw at f (even harmonics)', () => {
    const { real, imag } = waveCoeffs('bass', 8);
    expect(Array.from(real).every((v) => v === 0)).toBe(true);
    expect(imag[1]).toBeCloseTo(2 / Math.PI, 6); // square(f/2) level 0.5: 0.5 * 4/π
    expect(imag[3]).toBeCloseTo(2 / (3 * Math.PI), 6);
    expect(imag[2]).toBeCloseTo(1.44 / Math.PI, 6); // saw(f) fundamental, level 0.72: 0.72 * 2/π
    expect(imag[4]).toBeCloseTo(-1.44 / (2 * Math.PI), 6); // saw 2nd harmonic, alternating sign
  });
  it('lead pulse is cosine-only with the duty-cycle envelope', () => {
    const { real, imag } = waveCoeffs('leadPulse', 4);
    expect(Array.from(imag).every((v) => v === 0)).toBe(true);
    expect(real[1]).toBeCloseTo(0.5 * (2 / Math.PI) * Math.sin(0.3 * Math.PI), 6);
  });
});

describe('drum bank velocity layers', () => {
  it('picks the nearest layer', () => {
    expect(nearestLayer([0.5, 0.8, 1], 0.5)).toBe(0);
    expect(nearestLayer([0.5, 0.8, 1], 0.8)).toBe(1);
    expect(nearestLayer([0.5, 0.8, 1], 1)).toBe(2);
    expect(nearestLayer([0.5, 0.8, 1], 0.66)).toBe(1);
    expect(nearestLayer([0.6, 1], 0.3)).toBe(0);
  });
});

describe('gated reverb impulse', () => {
  it('is dense until the gate and then exactly silent', () => {
    const sr = 48000;
    const [l, r] = gatedImpulse(sr, 0.24, 0.02);
    expect(l.length).toBe(r.length);
    const rms = (a: Float32Array, from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i++) s += a[i]! * a[i]!;
      return Math.sqrt(s / (to - from));
    };
    const early = rms(l, Math.round(0.01 * sr), Math.round(0.05 * sr));
    const late = rms(l, Math.round(0.2 * sr), Math.round(0.235 * sr));
    expect(late).toBeGreaterThan(early * 0.4); // no natural exponential decay: it stays loud
    const fall = rms(l, Math.round(0.255 * sr), l.length);
    expect(fall).toBeLessThan(late * 0.25); // then it is cut off within 20 ms
    expect(l[l.length - 1]).toBe(0);
    expect(r[r.length - 1]).toBe(0);
    expect(l.length / sr).toBeLessThan(0.27);
  });
});

describe('misc generators', () => {
  it('noise is deterministic and in range', () => {
    const a = makeNoise(1000, 5);
    expect(Array.from(a)).toEqual(Array.from(makeNoise(1000, 5)));
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(-1);
  });
  it('metal buffer is bounded', () => {
    const m = metalBuffer(48000, 0.1);
    expect(Math.max(...Array.from(m, Math.abs))).toBeLessThanOrEqual(1.2);
  });
  it('pulse coefficients: no DC, 1st harmonic follows sin(πd)', () => {
    const { real, imag } = pulseCoeffs(0.3, 16);
    expect(real[0]).toBe(0);
    expect(real[1]).toBeCloseTo((2 / Math.PI) * Math.sin(Math.PI * 0.3), 6);
    expect(Array.from(imag).every((v) => v === 0)).toBe(true);
  });
  it('soft clip: identity below the knee, monotonic, always under the ceiling', () => {
    const c = softClipCurve(2048, 0.8, 0.97);
    for (let i = 1; i < c.length; i++) expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]!);
    expect(Math.max(...Array.from(c, Math.abs))).toBeLessThan(0.97);
    const mid = Math.round((0.5 + 1) / 2 * 2047); // x ≈ 0.5
    expect(c[mid]!).toBeCloseTo((mid / 2047) * 2 - 1, 6);
  });
  it('FDN gains give the requested RT60', () => {
    const g = fdnGain(0.05, 2);
    // after rt60 seconds of round trips the level is -60 dB
    expect(20 * Math.log10(Math.pow(g, 2 / 0.05))).toBeCloseTo(-60, 6);
    expect(fdnGain(0.05, 2)).toBeLessThan(1);
  });
});
