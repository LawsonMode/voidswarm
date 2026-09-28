// Offline render of a song through the real engine (OfflineAudioContext). The demo uses it to
// measure CPU (render wall time / audio time) and output levels without real-time audio.
// Scheduling is driven exactly like real time: pump() every 0.25 s via offline suspend points.
// CPU is timed over the steady-state window [warmup, end], after the first bar, the idle-track
// detaching and the one-off chord/drum-bank rendering.
import { compileSong } from './compile';
import type { Song } from './format';
import { Sequencer } from './sequencer';
import { MUSIC_SAMPLE_RATE, SynthCore } from './synth';

export interface OfflineReport {
  seconds: number;
  /** Wall time of the measured window. */
  wallMs: number;
  /** Measured-window wall time / audio time: the fraction of one core used (audio thread + JS pumps). */
  cpu: number;
  /** Main-thread scheduling share of `cpu` (JS in pump()). */
  jsCpu: number;
  /** Audio-thread share (cpu - jsCpu). */
  audioCpu: number;
  peak: number;
  rms: number;
  /** Fraction of samples with |x| ≥ 0.98. */
  clipped: number;
  /** Loudest and quietest 400 ms window (RMS, dBFS), after the first 0.5 s. */
  shortTermMaxDb: number;
  shortTermMinDb: number;
  /** Longest run of near-silence (50 ms windows under -54 dBFS RMS), seconds. */
  longestGap: number;
  /** The rendered audio (only with `keepBuffer`). */
  buffer?: AudioBuffer;
}

export interface OfflineOptions {
  seconds: number;
  intensity: number;
  volume?: number;
  sampleRate?: number;
  /** Section to jump to on the second bar. */
  jumpTo?: string;
  /** Seconds excluded from the CPU timing (default 2.5, capped at half the render). */
  warmup?: number;
  /** Return the rendered AudioBuffer in the report. */
  keepBuffer?: boolean;
  /** Called after every scheduling pump (every 0.25 s of audio) with the engine objects: probes. */
  onPump?: (now: number, seq: Sequencer, core: SynthCore) => void;
}

export async function renderOffline(song: Song, opts: OfflineOptions): Promise<OfflineReport> {
  const sr = opts.sampleRate ?? MUSIC_SAMPLE_RATE;
  const seconds = opts.seconds;
  const step = 0.25;
  const warm = Math.max(step, Math.round(Math.min(opts.warmup ?? 2.5, seconds / 2) / step) * step);
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  const core = new SynthCore(ctx);
  core.fx.setVolume(opts.volume ?? 1, 0, 0.001);
  const seq = new Sequencer(core);
  await seq.bank.done;
  seq.lookahead = 0.3;
  seq.setIntensity(opts.intensity, true);
  const r = compileSong(song);
  if (!r.compiled) throw new Error(`song errors: ${r.errors.join('; ')}`);
  seq.play(r.compiled, 0);
  if (opts.jumpTo) seq.jumpToSection(opts.jumpTo);
  core.assets.work(1e9); // one-off per session in real use: keep it out of the timing
  let jsMs = 0;
  let measuring = false;
  let tWarm = 0;
  const pump = (now: number): void => {
    const a = performance.now();
    seq.pump(now);
    if (measuring) jsMs += performance.now() - a;
    opts.onPump?.(now, seq, core);
  };
  pump(0);
  for (let t = step; t < seconds - 0.01; t += step) {
    const at = t;
    void ctx.suspend(at).then(() => {
      if (Math.abs(at - warm) < 1e-6) { measuring = true; tWarm = performance.now(); }
      pump(ctx.currentTime);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const wallMs = performance.now() - tWarm;
  const span = seconds - warm;
  let peak = 0;
  let sum = 0;
  let clip = 0;
  let n = 0;
  const skip = Math.min(buf.length - 1, Math.round(sr * 0.5));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = skip; i < d.length; i++) {
      const a = Math.abs(d[i]!);
      if (a > peak) peak = a;
      if (a >= 0.98) clip++;
      sum += d[i]! * d[i]!;
      n++;
    }
  }
  seq.dispose();
  core.dispose();
  const cpu = wallMs / 1000 / span;
  const jsCpu = jsMs / 1000 / span;
  const st = windowStats(buf, skip);
  return {
    seconds, wallMs, cpu, jsCpu, audioCpu: cpu - jsCpu, peak, rms: Math.sqrt(sum / Math.max(1, n)), clipped: clip / Math.max(1, n),
    ...st, ...(opts.keepBuffer ? { buffer: buf } : {}),
  };
}

const dbfs = (x: number): number => (x > 1e-9 ? 20 * Math.log10(x) : -180);

/** Short-term loudness range and the longest near-silent stretch of a render (both channels summed). */
export function windowStats(buf: AudioBuffer, skip = 0): { shortTermMaxDb: number; shortTermMinDb: number; longestGap: number } {
  const sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const w = Math.max(1, Math.round(sr * 0.05));
  const ms: number[] = [];
  for (let a = skip; a + w <= buf.length; a += w) {
    let e = 0;
    for (const d of chans) for (let i = a; i < a + w; i++) e += d[i]! * d[i]!;
    ms.push(e / (w * chans.length));
  }
  let maxDb = -180;
  let minDb = 0;
  for (let i = 0; i + 8 <= ms.length; i++) {
    let e = 0;
    for (let k = i; k < i + 8; k++) e += ms[k]!;
    const db = dbfs(Math.sqrt(e / 8));
    maxDb = Math.max(maxDb, db);
    minDb = Math.min(minDb, db);
  }
  let run = 0;
  let gap = 0;
  const floor = Math.pow(10, -54 / 10); // mean square of -54 dBFS
  for (const m of ms) {
    run = m < floor ? run + 1 : 0;
    gap = Math.max(gap, run);
  }
  return { shortTermMaxDb: maxDb, shortTermMinDb: ms.length >= 8 ? minDb : maxDb, longestGap: gap * 0.05 };
}
