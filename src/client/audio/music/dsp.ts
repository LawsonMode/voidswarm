// Pure DSP generators (Float32Array math, no WebAudio) for the music engine's shared buffers.
// Everything here is computed once per AudioContext and reused by every note.

/** PolyBLEP residual for band-limited saw/square edges. t = phase 0..1, dt = phase increment. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export interface SawComponent {
  /** Whole cycles per loop (integer → the loop is seamless). */
  cycles: number;
  amp: number;
  /** -1..1 equal-power pan. */
  pan: number;
}

/**
 * Render a seamless stereo loop of summed band-limited saws. Each component completes an integer
 * number of cycles in `n` samples, so the last sample flows into the first with no click.
 * The phase is computed exactly from the sample index (no accumulated rounding).
 */
export function renderSawLoop(n: number, comps: readonly SawComponent[], phases?: readonly number[]): [Float32Array, Float32Array] {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  comps.forEach((c, ci) => {
    const gl = c.amp * Math.cos(((c.pan + 1) * Math.PI) / 4);
    const gr = c.amp * Math.sin(((c.pan + 1) * Math.PI) / 4);
    const dt = c.cycles / n;
    const ph0 = phases?.[ci] ?? 0;
    for (let i = 0; i < n; i++) {
      let t = ((i * c.cycles) % n) / n + ph0;
      if (t >= 1) t -= 1;
      const v = 2 * t - 1 - polyBlep(t, dt);
      L[i]! += v * gl;
      R[i]! += v * gr;
    }
  });
  return [L, R];
}

/** Mono version of renderSawLoop (pans ignored): the summed saws, seamless over n samples. */
export function renderSawLoopMono(n: number, comps: readonly SawComponent[], phases?: readonly number[]): Float32Array {
  const out = new Float32Array(n);
  comps.forEach((c, ci) => {
    const dt = c.cycles / n;
    const ph0 = phases?.[ci] ?? 0;
    for (let i = 0; i < n; i++) {
      let t = ((i * c.cycles) % n) / n + ph0;
      if (t >= 1) t -= 1;
      out[i]! += (2 * t - 1 - polyBlep(t, dt)) * c.amp;
    }
  });
  return out;
}

/**
 * Sum equal-length seamless loops into one chord loop. Each note is rotated by its own offset
 * (so chord tones are not phase-locked), and the result is still seamless.
 */
export function mixLoops(loops: readonly Float32Array[], offsets: readonly number[]): Float32Array {
  const n = loops[0]?.length ?? 0;
  const out = new Float32Array(n);
  loops.forEach((src, j) => {
    const off = ((Math.floor(offsets[j] ?? 0) % n) + n) % n;
    const head = n - off;
    for (let i = 0; i < head; i++) out[i]! += src[i + off]!;
    for (let i = head; i < n; i++) out[i]! += src[i - head]!;
  });
  return out;
}

/** Detuned-stack spec for a reference MIDI note. Returns components + the true center frequency. */
export function stackSpec(
  refMidi: number, loopSec: number, cents: readonly number[], amps: readonly number[], pans: readonly number[],
): { comps: SawComponent[]; fCenter: number } {
  const f = 440 * Math.pow(2, (refMidi - 69) / 12);
  const kc = Math.max(1, Math.round(f * loopSec));
  const used = new Set<number>();
  const comps: SawComponent[] = cents.map((c, i) => {
    let k = Math.round(kc * Math.pow(2, c / 1200));
    // keep components distinct so every pair actually beats
    while (used.has(k)) k += c >= 0 ? 1 : -1;
    used.add(k);
    return { cycles: k, amp: amps[i] ?? 1, pan: pans[i] ?? 0 };
  });
  return { comps, fCenter: kc / loopSec };
}

/** Scale both channels so the louder one peaks at `peak`. Returns the gain applied. */
export function normalizePeak(chs: readonly Float32Array[], peak: number): number {
  let m = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]!); if (a > m) m = a; }
  if (m <= 0) return 1;
  const g = peak / m;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i]! *= g;
  return g;
}

/** Deterministic xorshift noise in -1..1 (so tests and every session get the same buffers). */
export function makeNoise(n: number, seed = 0x9e3779b9): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}

/**
 * The 80s GATED REVERB impulse: a dense noise burst that stays loud and then stops abruptly at
 * `gateSec` (the "non-linear" preset sound). Lightly low-passed so it is bright but not fizzy.
 */
export function gatedImpulse(sr: number, gateSec = 0.24, fallSec = 0.02, seed = 7): [Float32Array, Float32Array] {
  const n = Math.ceil((gateSec + fallSec) * sr) + 1;
  const out: [Float32Array, Float32Array] = [makeNoise(n, seed), makeNoise(n, seed * 7919 + 13)];
  const a = Math.exp((-2 * Math.PI * 6500) / sr); // one-pole LP ~6.5 kHz
  for (const ch of out) {
    let y = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env: number;
      if (t < 0.004) env = t / 0.004;
      else if (t < gateSec) env = 1 - 0.45 * ((t - 0.004) / gateSec); // slow sag, still dense
      else if (t < gateSec + fallSec) env = 0.55 * 0.5 * (1 + Math.cos((Math.PI * (t - gateSec)) / fallSec));
      else env = 0;
      y = (1 - a) * ch[i]! + a * y;
      ch[i] = y * env;
    }
    ch[n - 1] = 0;
  }
  return out;
}

/** Six detuned squares (808-style hat ratios) + noise: the metallic source for hats and crash. */
export function metalBuffer(sr: number, seconds: number, seed = 3): Float32Array {
  const n = Math.max(1, Math.round(sr * seconds));
  const freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].map((f) => f * 1.72);
  const noise = makeNoise(n, seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += ((i * f) / sr) % 1 < 0.5 ? 1 : -1;
    out[i] = (v / freqs.length) * 0.7 + noise[i]! * 0.45;
  }
  return out;
}

/** PeriodicWave cosine coefficients for a pulse of the given duty (0..1). real[0] = 0 (no DC). */
export function pulseCoeffs(duty: number, harmonics: number): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return { real, imag };
}

/**
 * PeriodicWave coefficients with the instrument mix baked in (so no mix GainNodes are needed):
 *  'bass'      the oscillator runs at f/2. Odd harmonics are a square at f/2 (level 0.5, the
 *              sub-octave) and even harmonics are a saw at f (level 0.72). ONE oscillator = saw + sub.
 *  'leadSaw'   saw, level 0.62.      'leadPulse'  30% pulse, level 0.5.
 * Use with { disableNormalization: true }.
 */
export function waveCoeffs(kind: 'bass' | 'leadSaw' | 'leadPulse', harmonics: number): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    if (kind === 'bass') {
      if (k % 2 === 1) imag[k] = (0.5 * 4) / (Math.PI * k);
      else { const n = k / 2; imag[k] = ((0.72 * 2) / (Math.PI * n)) * (n % 2 ? 1 : -1); }
    } else if (kind === 'leadSaw') {
      imag[k] = ((0.62 * 2) / (Math.PI * k)) * (k % 2 ? 1 : -1);
    } else {
      real[k] = 0.5 * (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.3);
    }
  }
  return { real, imag };
}

/**
 * Soft-clip transfer curve for a WaveShaperNode: linear up to `knee`, then tanh-shaped into an
 * asymptote at `ceiling` (so |out| < ceiling for ANY input: the curve clamps beyond ±1).
 */
export function softClipCurve(n = 2048, knee = 0.8, ceiling = 0.97): Float32Array {
  const c = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    c[i] = Math.sign(x) * Math.min(y, ceiling - 1e-4);
  }
  return c;
}

/** Feedback gain for a delay line of `delaySec` so the loop decays 60 dB in `rt60` seconds. */
export function fdnGain(delaySec: number, rt60: number): number {
  return Math.pow(10, (-3 * delaySec) / Math.max(0.05, rt60));
}

/** One-pole lowpass IIR coefficients (feedforward, feedback) for IIRFilterNode. */
export function onePoleLowpass(cutoff: number, sr: number): { ff: number[]; fb: number[] } {
  const a = Math.exp((-2 * Math.PI * cutoff) / sr);
  return { ff: [1 - a], fb: [1, -a] };
}
