// Music synth engine: shared FX bus, per-song and per-track routing, voice budget, shared assets,
// melodic voices.
//
// CPU budget (< 3% of a laptop core at full intensity). Measured in Chrome with OfflineAudioContext,
// per node, 48 kHz:
//   stereo AudioBuffer at rate 1 ≈ 0.013%    the same at rate ≠ 1 (resampled) ≈ 0.12%
//   saw oscillator ≈ 0.03%                   biquad with a-rate automation ≈ 0.11%, k-rate ≈ 0.043%
//   DynamicsCompressor ≈ 0.25%               idle GainNode ≈ 0.006% (still pulled while connected)
// The design follows from those numbers:
//  - PAD / BRASS notes are ONE rate-1 stereo buffer each. The buffer is a pre-rendered, loopable
//    detuned saw stack (5 or 3 band-limited saws) at that note's exact pitch. It is rendered once
//    per note, cached (LRU), and prewarmed in small time slices when a song is queued.
//  - Poly instruments are PARAPHONIC: one k-rate filter per track (its envelope retriggers per
//    chord/note event) and only a VCA per voice. Voice VCAs are pooled, and idle ones are detached
//    from the graph.
//  - MONO voices (bass, lead) keep one persistent oscillator chain. Notes only automate params,
//    and the oscillators stop after 2.5 s idle and are recreated on demand.
//  - One global VoiceBudget caps transient voices at 24 and steals the voice that ends soonest.
//  - FX are shared: a 6-line FDN hall (no convolution), a ping-pong delay, one glue compressor,
//    and a soft-clip ceiling. The gated snare room is baked into the drum samples (drums.ts).
//  - Envelopes use setTargetAtTime chains, which start from the param's current value, so mono
//    retriggers and voice reuse are click-free without cancelAndHoldAtTime (not in Firefox).
import type { DelayTime, MelodicInstrument, ToneParams } from './format';
import { fdnGain, gatedImpulse, makeNoise, metalBuffer, mixLoops, normalizePeak, onePoleLowpass, renderSawLoopMono, softClipCurve, stackSpec, waveCoeffs } from './dsp';
import { midiToFreq } from './theory';
import { delaySeconds } from './timing';

export const MAX_VOICES = 24;

/**
 * The music engine's own AudioContext rate. Every node's cost scales with the sample rate, and
 * 32 kHz (16 kHz bandwidth, broadcast-FM quality) is plenty for synthwave on game speakers. It
 * takes about a third off the CPU. The browser resamples to the device rate.
 */
export const MUSIC_SAMPLE_RATE = 32000;

/** Make a GainNode downmix to mono (used for FX sends: everything behind it runs single-channel). */
export function monoGain(n: GainNode): GainNode {
  n.channelCount = 1;
  n.channelCountMode = 'explicit';
  n.channelInterpretation = 'speakers';
  return n;
}

// ---------------------------------------------------------------------------------------------
// Instrument interface (drums.ts implements it too)
// ---------------------------------------------------------------------------------------------

export interface Instrument {
  /** Play at time t: MIDI notes (melodic), dur seconds, velocity 0..1, glide flag, drum variant. */
  trigger(t: number, midi: readonly number[], dur: number, vel: number, glide: boolean, variant: string): void;
  /** Release everything sounding at t (layer switched off / song stopped). */
  releaseAll(t: number): void;
  /** Periodic housekeeping (idle mono oscillators are stopped, idle voices detached). */
  maintain(now: number): void;
  /** 0..1 tone brightness hint from intensity (pads open up). */
  setBrightness?(x: number, t: number): void;
  /** Hi-hat choke. */
  choke?(t: number): void;
  dispose(): void;
}

/** Use control-rate automation where supported (cheap filter envelopes); a no-op elsewhere. */
export function kRate(p: AudioParam): void {
  try { (p as AudioParam & { automationRate: string }).automationRate = 'k-rate'; } catch { /* fixed-rate param or unsupported */ }
}

// ---------------------------------------------------------------------------------------------
// Voice budget
// ---------------------------------------------------------------------------------------------

export interface BudgetEntry {
  end: number;
  kill: (t: number) => void;
}

/** Global cap on transient voices. When full, the voice ending soonest is stolen. */
export class VoiceBudget {
  private entries: BudgetEntry[] = [];
  steals = 0;
  constructor(readonly cap = MAX_VOICES) {}

  acquire(t: number, end: number, kill: (t: number) => void): BudgetEntry {
    let w = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.end > t) this.entries[w++] = e;
    }
    this.entries.length = w;
    while (this.entries.length >= this.cap) {
      let bi = 0;
      for (let i = 1; i < this.entries.length; i++) if (this.entries[i]!.end < this.entries[bi]!.end) bi = i;
      const victim = this.entries[bi]!;
      this.entries.splice(bi, 1);
      this.steals++;
      victim.kill(t);
    }
    const e: BudgetEntry = { end, kill };
    this.entries.push(e);
    return e;
  }

  release(e: BudgetEntry | null | undefined): void {
    if (!e) return;
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /** Voices still sounding at time t. */
  active(t: number): number {
    let n = 0;
    for (const e of this.entries) if (e.end > t) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared assets (per context)
// ---------------------------------------------------------------------------------------------

export type StackKind = 'pad' | 'brass';
const STACK_SPEC: Record<StackKind, { loop: number; cents: number[]; amps: number[]; phases: number[] }> = {
  pad: { loop: 1.5, cents: [-19, -9, 0, 8, 17], amps: [0.75, 0.9, 1, 0.9, 0.75], phases: [0, 0.37, 0.71, 0.13, 0.55] },
  brass: { loop: 1, cents: [-8, 0, 7], amps: [0.85, 1, 0.85], phases: [0, 0.5, 0.25] },
};
/** Cached mono note loops (only needed while building chords). */
const NOTE_CACHE = 32;
/** Cached mono chord loops (pad 1.5 s ≈ 290 KB, brass 1 s ≈ 190 KB at 48 kHz). */
const CHORD_CACHE = 48;

export class Assets {
  readonly noise: AudioBuffer;
  readonly metal: AudioBuffer;
  readonly gatedTail: AudioBuffer;
  private readonly waves = new Map<string, PeriodicWave>();
  private readonly notes = new Map<string, Float32Array>();
  private readonly chords = new Map<string, AudioBuffer>();
  private readonly warmQueue: { kind: StackKind; midis: readonly number[] }[] = [];

  constructor(private readonly ctx: BaseAudioContext) {
    const sr = ctx.sampleRate;
    this.noise = this.mono(makeNoise(Math.round(sr * 2), 0x1234567));
    this.metal = this.mono(metalBuffer(sr, 2));
    const [l, r] = gatedImpulse(sr);
    normalizePeak([l, r], 0.5);
    this.gatedTail = ctx.createBuffer(2, l.length, sr);
    this.gatedTail.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    this.gatedTail.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
  }

  private mono(data: Float32Array): AudioBuffer {
    const b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    return b;
  }

  /**
   * Oscillator waves with the instrument mix baked in (no per-voice mix gains):
   *  bass      played at f/2: odd harmonics = square(f/2) (the sub), even harmonics = saw(f)
   *  leadSaw   saw at level 0.62      leadPulse  30% pulse at level 0.5
   * Built with disableNormalization, so the amplitudes are exactly as written.
   */
  wave(kind: 'bass' | 'leadSaw' | 'leadPulse'): PeriodicWave {
    let w = this.waves.get(kind);
    if (!w) {
      const { real, imag } = waveCoeffs(kind, 96);
      w = this.ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      this.waves.set(kind, w);
    }
    return w;
  }

  /** One note's seamless detuned-stack loop at its exact pitch (mono, peak 0.9). */
  private noteLoop(kind: StackKind, midi: number): Float32Array {
    const key = `${kind}:${midi}`;
    let d = this.notes.get(key);
    if (d) return d;
    const sp = STACK_SPEC[kind];
    const sr = this.ctx.sampleRate;
    const n = Math.round(sp.loop * sr);
    const { comps } = stackSpec(midi, n / sr, sp.cents, sp.amps, sp.cents.map(() => 0));
    d = renderSawLoopMono(n, comps, sp.phases);
    normalizePeak([d], 0.9);
    this.notes.set(key, d);
    while (this.notes.size > NOTE_CACHE) this.notes.delete(this.notes.keys().next().value!);
    return d;
  }

  /**
   * A whole chord as ONE loopable mono buffer, played at rate 1 (the cheap path): one source per
   * chord event instead of one (or five) per note. Built by summing the note loops, each rotated
   * by its own offset, so chord tones are not phase-locked.
   */
  chord(kind: StackKind, midis: readonly number[]): AudioBuffer {
    const key = `${kind}:${midis.join(',')}`;
    let b = this.chords.get(key);
    if (b) {
      this.chords.delete(key); // LRU touch
      this.chords.set(key, b);
      return b;
    }
    const loops = midis.map((m) => this.noteLoop(kind, m));
    const n = loops[0]!.length;
    const data = midis.length === 1 ? loops[0]! : mixLoops(loops, midis.map((m, j) => n * (((j * 0.618 + m * 0.137) % 1 + 1) % 1)));
    b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    this.chords.set(key, b);
    while (this.chords.size > CHORD_CACHE) this.chords.delete(this.chords.keys().next().value!);
    return b;
  }

  /** Queue chord loops to build ahead of use (see work()). */
  prewarm(kind: StackKind, chords: Iterable<readonly number[]>): void {
    for (const midis of chords) if (!this.chords.has(`${kind}:${midis.join(',')}`)) this.warmQueue.push({ kind, midis });
  }

  /** Build queued chord loops for up to `budgetMs` of main-thread time. Returns how many remain. */
  work(budgetMs: number): number {
    const t0 = performance.now();
    while (this.warmQueue.length > 0 && performance.now() - t0 < budgetMs) {
      const j = this.warmQueue.shift()!;
      this.chord(j.kind, j.midis);
    }
    return this.warmQueue.length;
  }
}

// ---------------------------------------------------------------------------------------------
// FX bus + master chain
// ---------------------------------------------------------------------------------------------

const FDN_MS = [31.3, 37.9, 43.1, 51.7, 61.3, 71.9];
/** Post-compressor trim, folded into the volume stage (saves a node). */
const MASTER_TRIM = 0.5;

/**
 * Shared FX, built for low node count (every WebAudio node has a fixed per-block cost):
 *  - sends are summed to MONO, so the delay lines and feedback gains process one channel
 *  - wet levels are folded into the send-input gains (the FX are linear)
 *  - reverb: 6-line FDN with a Householder feedback matrix, one-pole damping on alternate lines,
 *    and a slow delay-time wobble on two lines. No convolution.
 *  - ping-pong: L → R → L … at a tempo-synced note value, damped once per round trip
 *  - master: glue compressor → volume (× trim) → soft clip (hard ceiling < 0.97, so the output
 *    can never clip, whatever the mix does)
 */
export class FxBus {
  /** Straight to the mix (this IS the mix sum). */
  readonly dryIn: GainNode;
  /** Sidechain-ducked on every kick (pads, bass). */
  readonly duckIn: GainNode;
  readonly delayIn: GainNode;
  readonly reverbIn: GainNode;
  /** Final output node (after volume and the soft-clip ceiling). */
  readonly out: AudioNode;
  private readonly volume: GainNode;
  private readonly ppL: DelayNode;
  private readonly ppR: DelayNode;
  private readonly ppFb: GainNode;
  private readonly ppFb2: GainNode;
  private readonly fdnGains: GainNode[] = [];
  private readonly lfo: OscillatorNode;
  private readonly nodes: AudioNode[] = [];

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    const g = (v: number): GainNode => { const n = ctx.createGain(); n.gain.value = v; this.nodes.push(n); return n; };
    const sum = g(1);
    this.dryIn = sum;
    this.duckIn = g(1);
    this.duckIn.connect(sum);
    const monoIn = (v: number): GainNode => monoGain(g(v));
    this.delayIn = monoIn(0.5); // = delay wet level
    this.reverbIn = monoIn(0.21); // = input scale × wet level

    // --- ping-pong delay ---
    const ppHp = ctx.createBiquadFilter(); ppHp.type = 'highpass'; ppHp.frequency.value = 280; this.nodes.push(ppHp);
    this.ppL = ctx.createDelay(2); this.ppR = ctx.createDelay(2);
    this.ppL.delayTime.value = 0.3; this.ppR.delayTime.value = 0.3;
    const lp = onePoleLowpass(3400, ctx.sampleRate);
    const ppDamp = ctx.createIIRFilter(lp.ff, lp.fb);
    this.ppFb = g(0.35);
    this.ppFb2 = g(0.35);
    const ppMerge = ctx.createChannelMerger(2);
    this.nodes.push(this.ppL, this.ppR, ppDamp, ppMerge);
    this.delayIn.connect(ppHp).connect(this.ppL);
    this.ppL.connect(ppDamp).connect(this.ppFb).connect(this.ppR);
    this.ppR.connect(this.ppFb2).connect(this.ppL);
    this.ppL.connect(ppMerge, 0, 0);
    this.ppR.connect(ppMerge, 0, 1);
    ppMerge.connect(sum);
    const ppToVerb = g(0.18);
    ppMerge.connect(ppToVerb).connect(this.reverbIn);

    // --- FDN hall reverb ---
    const inHp = ctx.createBiquadFilter(); inHp.type = 'highpass'; inHp.frequency.value = 240; this.nodes.push(inHp);
    const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.02; this.nodes.push(pre);
    this.reverbIn.connect(inHp).connect(pre);
    const house = g(-2 / FDN_MS.length);
    const merge = ctx.createChannelMerger(2); this.nodes.push(merge);
    const damp = onePoleLowpass(3600, ctx.sampleRate);
    const delays: DelayNode[] = [];
    FDN_MS.forEach((ms, i) => {
      const d = ctx.createDelay(0.2); d.delayTime.value = ms / 1000;
      const fg = g(fdnGain(ms / 1000, 2.2));
      this.nodes.push(d);
      pre.connect(d);
      let tap: AudioNode = d;
      if (i % 2 === 0) {
        const f = ctx.createIIRFilter(damp.ff, damp.fb);
        this.nodes.push(f);
        d.connect(f);
        tap = f;
      }
      tap.connect(fg);
      fg.connect(d);
      fg.connect(house);
      house.connect(d);
      tap.connect(merge, 0, i % 2);
      delays.push(d);
      this.fdnGains.push(fg);
    });
    merge.connect(sum);
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.27; this.nodes.push(this.lfo);
    const mod = g(0.00045);
    this.lfo.connect(mod);
    mod.connect(delays[1]!.delayTime);
    mod.connect(delays[4]!.delayTime);
    this.lfo.start();

    // --- master ---
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -14; glue.knee.value = 6; glue.ratio.value = 3; glue.attack.value = 0.006; glue.release.value = 0.16;
    this.volume = g(0.8 * MASTER_TRIM);
    const clip = ctx.createWaveShaper(); clip.curve = softClipCurve() as Float32Array<ArrayBuffer>; clip.oversample = 'none';
    this.nodes.push(glue, clip);
    sum.connect(glue).connect(this.volume).connect(clip).connect(destination);
    this.out = clip;
  }

  /** Sidechain pump: dip the ducked bus at t and recover. */
  duck(t: number, depth: number): void {
    if (depth <= 0) return;
    const p = this.duckIn.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(1 - Math.min(0.9, depth), t, 0.004);
    p.setTargetAtTime(1, t + 0.04, 0.075);
  }

  setDelay(bpm: number, time: DelayTime, feedback: number, t: number): void {
    const d = delaySeconds(time, bpm);
    this.ppL.delayTime.setTargetAtTime(d, t, 0.02);
    this.ppR.delayTime.setTargetAtTime(d, t, 0.02);
    // every bounce (L→R and R→L) drops the echo by `feedback`
    this.ppFb.gain.setTargetAtTime(feedback, t, 0.05);
    this.ppFb2.gain.setTargetAtTime(feedback, t, 0.05);
  }

  setReverbDecay(rt60: number, t: number): void {
    FDN_MS.forEach((ms, i) => this.fdnGains[i]!.gain.setTargetAtTime(fdnGain(ms / 1000, rt60), t, 0.3));
  }

  /** Master music volume 0..1 (linear). */
  setVolume(v: number, t: number, tc = 0.05): void {
    this.volume.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * MASTER_TRIM, t, tc);
  }

  dispose(): void {
    try { this.lfo.stop(); } catch { /* already stopped */ }
    for (const n of this.nodes) n.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// Core (one per AudioContext)
// ---------------------------------------------------------------------------------------------

export class SynthCore {
  readonly assets: Assets;
  readonly fx: FxBus;
  readonly budget = new VoiceBudget(MAX_VOICES);

  constructor(readonly ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.assets = new Assets(ctx);
    this.fx = new FxBus(ctx, destination);
  }

  dispose(): void {
    this.fx.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Per-song bus (crossfades, stinger dips) and per-track routing
// ---------------------------------------------------------------------------------------------

/** One per playing song: its tracks feed these four gains, which feed the shared FX bus. */
export class SongBus {
  readonly dry: GainNode;
  readonly duck: GainNode;
  readonly delay: GainNode;
  readonly reverb: GainNode;
  private readonly all: GainNode[];

  constructor(core: SynthCore) {
    const ctx = core.ctx;
    const fx = core.fx;
    this.dry = ctx.createGain();
    this.duck = ctx.createGain();
    this.delay = ctx.createGain();
    this.reverb = ctx.createGain();
    monoGain(this.delay);
    monoGain(this.reverb);
    this.dry.connect(fx.dryIn);
    this.duck.connect(fx.duckIn);
    this.delay.connect(fx.delayIn);
    this.reverb.connect(fx.reverbIn);
    this.all = [this.dry, this.duck, this.delay, this.reverb];
  }

  /** Ramp the whole song to `target` from t over dur (0 = jump). */
  fade(target: number, t: number, dur: number): void {
    for (const n of this.all) {
      const p = n.gain;
      p.cancelScheduledValues(t);
      if (dur <= 0.005) p.setValueAtTime(target, t);
      else { p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(target, t + dur); }
    }
  }

  fadeIn(t: number, dur: number): void {
    for (const n of this.all) {
      const p = n.gain;
      p.value = 0;
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(1, t + dur);
    }
  }

  /** A short dip (under a stinger): down to 1-depth at t, back to 1 after dur. */
  dent(t: number, depth: number, dur: number): void {
    for (const n of this.all) {
      const p = n.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(1, t);
      p.linearRampToValueAtTime(1 - depth, t + 0.03);
      p.setValueAtTime(1 - depth, t + 0.03 + dur);
      p.linearRampToValueAtTime(1, t + 0.18 + dur);
    }
  }

  dispose(): void {
    for (const n of this.all) n.disconnect();
  }
}

export interface TrackOutOpts {
  gain: number;
  pan: number;
  duck: boolean;
  delay: number;
  reverb: number;
  /** Start with the layer closed (opened later by setLayer). */
  startClosed?: boolean;
}

/**
 * input (layer × track gain) → [pan, only when ≠ 0] → song bus dry|duck, plus delay/reverb sends.
 * A layer that has been closed for a while is DETACHED from the graph (zero idle CPU).
 */
export class TrackOut {
  readonly input: GainNode;
  private readonly last: AudioNode;
  private readonly dest: AudioNode;
  private readonly sends: GainNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private open: boolean;
  private attached = true;
  private closedAt = -Infinity;
  private lastUse: number;

  constructor(core: SynthCore, bus: SongBus, private readonly o: TrackOutOpts) {
    const ctx = core.ctx;
    this.lastUse = ctx.currentTime;
    this.open = !o.startClosed;
    this.input = ctx.createGain();
    this.input.gain.value = this.open ? o.gain : 0;
    this.nodes.push(this.input);
    let last: AudioNode = this.input;
    if (Math.abs(o.pan) > 0.001) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      this.input.connect(p);
      this.nodes.push(p);
      last = p;
    }
    this.last = last;
    this.dest = o.duck ? bus.duck : bus.dry;
    for (const [amt, to] of [[o.delay, bus.delay], [o.reverb, bus.reverb]] as const) {
      if (amt <= 0) continue;
      const s = monoGain(ctx.createGain());
      s.gain.value = amt;
      s.connect(to);
      this.sends.push(s);
      this.nodes.push(s);
    }
    this.link();
  }

  private link(): void {
    this.last.connect(this.dest);
    for (const s of this.sends) this.last.connect(s);
    this.attached = true;
  }

  get isOpen(): boolean { return this.open; }

  /** Mark activity up to time t (a note's end). Re-attaches a detached track. */
  touch(t: number): void {
    this.lastUse = Math.max(this.lastUse, t);
    if (!this.attached) this.link();
  }

  /** Intensity layer on/off (applied on bar lines by the sequencer). */
  setLayer(on: boolean, t: number): void {
    if (on === this.open) return;
    this.open = on;
    if (on && !this.attached) this.link();
    if (!on) this.closedAt = t;
    const p = this.input.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(on ? this.o.gain : 0, t, on ? 0.004 : 0.12);
  }

  /**
   * Detach a closed layer, or an open track with no notes for a while, once its tails have died
   * away. The whole instrument subgraph behind it then costs nothing.
   */
  maintain(now: number): void {
    if (!this.attached) return;
    const idle = this.open ? now > this.lastUse + 4 : now > this.closedAt + 3;
    if (idle) {
      this.last.disconnect();
      this.attached = false;
    }
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// Tone presets (melodic). `level` is the pre-balanced instrument gain.
// ---------------------------------------------------------------------------------------------

export type ResolvedTone = Required<ToneParams> & { level: number };

export const TONE_DEFAULTS: Readonly<Record<MelodicInstrument, ResolvedTone>> = {
  bass: { cutoff: 170, resonance: 9, envAmount: 2600, attack: 0.002, decay: 0.16, sustain: 0.5, release: 0.035, glide: 0.07, vibrato: 0, vibratoDelay: 0, gate: 0.82, level: 0.45 },
  pad: { cutoff: 2300, resonance: 0.5, envAmount: 0, attack: 0.4, decay: 0.6, sustain: 0.9, release: 1.1, glide: 0, vibrato: 0, vibratoDelay: 0, gate: 1, level: 0.2 },
  brass: { cutoff: 420, resonance: 2, envAmount: 3400, attack: 0.012, decay: 0.32, sustain: 0.72, release: 0.16, glide: 0, vibrato: 0, vibratoDelay: 0, gate: 0.92, level: 0.3 },
  lead: { cutoff: 2400, resonance: 3, envAmount: 2600, attack: 0.008, decay: 0.35, sustain: 0.78, release: 0.2, glide: 0.11, vibrato: 16, vibratoDelay: 0.26, gate: 1, level: 0.3 },
  pluck: { cutoff: 650, resonance: 4, envAmount: 4600, attack: 0.002, decay: 0.2, sustain: 0, release: 0.08, glide: 0, vibrato: 0, vibratoDelay: 0, gate: 1, level: 0.19 },
  arp: { cutoff: 900, resonance: 9, envAmount: 3800, attack: 0.001, decay: 0.1, sustain: 0, release: 0.05, glide: 0, vibrato: 0, vibratoDelay: 0, gate: 0.6, level: 0.22 },
  bell: { cutoff: 0, resonance: 0, envAmount: 0, attack: 0.002, decay: 1.4, sustain: 0, release: 0.5, glide: 0, vibrato: 0, vibratoDelay: 0, gate: 1, level: 0.15 },
};

export function resolveTone(inst: MelodicInstrument, t: ToneParams | undefined): ResolvedTone {
  const d = TONE_DEFAULTS[inst];
  return { ...d, ...(t ?? {}), level: d.level };
}

const tc = (sec: number, div: number): number => Math.max(0.0005, sec / div);

/** ADSR on a gain param with setTargetAtTime (continuous from the current value). */
function adsr(p: AudioParam, t: number, off: number, peak: number, tn: ResolvedTone): void {
  p.cancelScheduledValues(t);
  p.setTargetAtTime(peak, t, tc(tn.attack, 3));
  p.setTargetAtTime(peak * tn.sustain, t + tn.attack, tc(tn.decay, 3));
  p.setTargetAtTime(0, Math.max(off, t + tn.attack * 0.5), tc(tn.release, 4));
}

function stopAt(src: AudioScheduledSourceNode, t: number): void {
  try { src.stop(t); } catch { /* not started / already stopped */ }
}

function oneShot(src: AudioScheduledSourceNode, ...extra: AudioNode[]): void {
  src.onended = (): void => {
    src.disconnect();
    for (const n of extra) n.disconnect();
  };
}

// ---------------------------------------------------------------------------------------------
// Mono voices: bass, lead
// ---------------------------------------------------------------------------------------------

export class MonoSynth implements Instrument {
  /** Bass: ONE oscillator at f/2 whose wave is saw(f) + square(f/2). Lead: saw + detuned pulse. */
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private lfo: OscillatorNode | null = null;
  private readonly filt: BiquadFilterNode;
  private readonly vca: GainNode;
  private readonly vib: GainNode;
  private lastOff = -1;
  private lastEnd = -1;
  /** Oscillator frequency = note frequency x ratio (the bass oscillator runs an octave down). */
  private readonly ratio: number;

  constructor(private readonly core: SynthCore, out: AudioNode, private readonly kind: 'bass' | 'lead', private readonly tone: ResolvedTone) {
    const ctx = core.ctx;
    this.ratio = kind === 'bass' ? 0.5 : 1;
    this.filt = ctx.createBiquadFilter();
    this.filt.type = 'lowpass';
    this.filt.frequency.value = tone.cutoff;
    this.filt.Q.value = tone.resonance;
    if (kind === 'lead') kRate(this.filt.frequency); // lead filter moves slowly; bass keeps sample-accurate snap
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.vib = ctx.createGain();
    this.vib.gain.value = 0;
    this.filt.connect(this.vca).connect(out);
  }

  private ensure(t: number, f: number): void {
    if (this.oscA) return;
    const ctx = this.core.ctx;
    const at = Math.max(ctx.currentTime, t - 0.01);
    const assets = this.core.assets;
    const mk = (wave: PeriodicWave): OscillatorNode => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = f * this.ratio;
      // pitch moves (glide, vibrato) at control rate: much cheaper, inaudible at 375 Hz updates
      kRate(o.frequency);
      kRate(o.detune);
      o.connect(this.filt);
      o.start(at);
      return o;
    };
    if (this.kind === 'bass') {
      this.oscA = mk(assets.wave('bass'));
    } else {
      const a = mk(assets.wave('leadSaw'));
      const b = mk(assets.wave('leadPulse'));
      b.detune.value = 6;
      const l = ctx.createOscillator();
      l.frequency.value = 5.4;
      l.connect(this.vib);
      this.vib.connect(a.detune);
      this.vib.connect(b.detune);
      l.start(at);
      this.lfo = l;
      this.oscA = a;
      this.oscB = b;
    }
  }

  trigger(t: number, midi: readonly number[], dur: number, vel: number, glide = false): void {
    const m = midi[0];
    if (m === undefined) return;
    const tn = this.tone;
    const f = midiToFreq(m);
    this.ensure(t, f);
    const held = this.lastOff > t - 0.004;
    const legato = glide && held;
    const connected = t - this.lastOff < 0.03;
    const freqTc = glide ? tc(tn.glide, 3) : this.kind === 'lead' && connected ? 0.012 : 0;
    const setF = (p: AudioParam, v: number): void => {
      p.cancelScheduledValues(t);
      if (freqTc > 0) p.setTargetAtTime(v, t, freqTc);
      else p.setValueAtTime(v, t);
    };
    setF(this.oscA!.frequency, f * this.ratio);
    if (this.oscB) setF(this.oscB.frequency, f * this.ratio);

    const off = t + dur * tn.gate;
    const peak = tn.level * (0.35 + 0.65 * vel);
    const fp = this.filt.frequency;
    const env = tn.envAmount * (0.4 + 0.6 * vel);
    if (legato) {
      const g = this.vca.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(peak * tn.sustain, t, 0.03);
      g.setTargetAtTime(0, off, tc(tn.release, 4));
      fp.cancelScheduledValues(t);
      fp.setTargetAtTime(tn.cutoff + env * 0.45, t, 0.04);
    } else {
      adsr(this.vca.gain, t, off, peak, tn);
      fp.cancelScheduledValues(t);
      if (this.kind === 'bass') {
        fp.setTargetAtTime(tn.cutoff + env, t, 0.0015);
        fp.setTargetAtTime(tn.cutoff, t + 0.004, tc(tn.decay * 0.7, 3));
      } else {
        fp.setTargetAtTime(tn.cutoff + env, t, 0.018);
        fp.setTargetAtTime(tn.cutoff + env * 0.35, t + 0.07, 0.25);
      }
      if (this.kind === 'lead' && tn.vibrato > 0) {
        const v = this.vib.gain;
        v.cancelScheduledValues(t);
        v.setTargetAtTime(0, t, 0.01);
        v.setTargetAtTime(tn.vibrato, t + tn.vibratoDelay, 0.12);
      }
    }
    this.lastOff = off;
    this.lastEnd = Math.max(this.lastEnd, off + tn.release * 3);
  }

  releaseAll(t: number): void {
    if (this.lastOff <= t) return;
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.02);
    this.lastOff = t;
    this.lastEnd = t + 0.1;
  }

  maintain(now: number): void {
    if (this.oscA && now > this.lastEnd + 2.5) this.stopOscs(now);
  }

  private stopOscs(t: number): void {
    for (const o of [this.oscA, this.oscB, this.lfo]) {
      if (!o) continue;
      stopAt(o, t + 0.01);
      oneShot(o);
    }
    this.oscA = this.oscB = this.lfo = null;
  }

  dispose(): void {
    this.stopOscs(this.core.ctx.currentTime);
    for (const n of [this.filt, this.vca, this.vib]) n.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// Poly (paraphonic) voices: pad, brass, pluck, arp, bell
//  pad / brass: ONE voice per chord event (a pre-mixed chord loop, see Assets.chord)
//  pluck / arp / bell: one voice per note (oscillators)
// All share one track filter (k-rate); pads add a Juno-style stereo chorus.
// ---------------------------------------------------------------------------------------------

interface PolyVoice {
  vca: GainNode;
  srcs: AudioScheduledSourceNode[];
  busyUntil: number;
  entry: BudgetEntry | null;
  linked: boolean;
}

type PolyKind = 'pad' | 'brass' | 'pluck' | 'arp' | 'bell';
const POLY_MAX: Record<PolyKind, number> = { pad: 4, brass: 4, pluck: 5, arp: 4, bell: 6 };

export class PolySynth implements Instrument {
  private readonly voices: PolyVoice[] = [];
  /** Track filter every voice feeds (k-rate: pad brightness, brass/pluck/arp envelopes). null for bell. */
  private readonly filt: BiquadFilterNode | null = null;
  private readonly bus: AudioNode;
  private readonly extra: AudioNode[] = [];
  private lfo: OscillatorNode | null = null;
  /** Filter envelope re-arm guard: one envelope per chord event, not per chord tone. */
  private lastEnvAt = -1;

  constructor(private readonly core: SynthCore, out: AudioNode, private readonly kind: PolyKind, private readonly tone: ResolvedTone) {
    const ctx = core.ctx;
    if (kind !== 'bell') {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = tone.cutoff;
      f.Q.value = tone.resonance;
      kRate(f.frequency);
      this.filt = f;
      this.bus = f;
      this.extra.push(f);
      if (kind === 'pad') this.chorus(f, out);
      else f.connect(out);
    } else this.bus = out;
  }

  /**
   * Juno-style stereo chorus: dry to both sides plus two short delays swept in opposite directions
   * by one slow triangle LFO. This is where the pad's stereo width comes from (the chord loops are mono).
   */
  private chorus(from: AudioNode, out: AudioNode): void {
    const ctx = this.core.ctx;
    const pre = ctx.createGain();
    pre.gain.value = 0.62;
    const merge = ctx.createChannelMerger(2);
    const dL = ctx.createDelay(0.02);
    const dR = ctx.createDelay(0.02);
    dL.delayTime.value = 0.0036;
    dR.delayTime.value = 0.0036;
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 0.48;
    const mL = ctx.createGain();
    const mR = ctx.createGain();
    mL.gain.value = 0.0017;
    mR.gain.value = -0.0017;
    lfo.connect(mL).connect(dL.delayTime);
    lfo.connect(mR).connect(dR.delayTime);
    from.connect(pre);
    pre.connect(merge, 0, 0);
    pre.connect(merge, 0, 1);
    pre.connect(dL).connect(merge, 0, 0);
    pre.connect(dR).connect(merge, 0, 1);
    merge.connect(out);
    lfo.start();
    this.lfo = lfo;
    this.extra.push(pre, merge, dL, dR, mL, mR, lfo);
  }

  private kill(v: PolyVoice, t: number): void {
    v.vca.gain.cancelScheduledValues(t);
    v.vca.gain.setTargetAtTime(0, t, 0.005);
    for (const s of v.srcs) stopAt(s, t + 0.04);
    v.busyUntil = Math.min(v.busyUntil, t + 0.04);
    v.entry = null;
  }

  private alloc(t: number): PolyVoice {
    let v: PolyVoice | null = null;
    for (const x of this.voices) if (x.busyUntil <= t) { v = x; break; }
    if (!v && this.voices.length < POLY_MAX[this.kind]) {
      const vca = this.core.ctx.createGain();
      vca.gain.value = 0;
      if (this.kind === 'pad') kRate(vca.gain); // 0.4 s attack / 1.1 s release: control rate is plenty
      v = { vca, srcs: [], busyUntil: -1, entry: null, linked: false };
      this.voices.push(v);
    }
    if (!v) {
      v = this.voices[0]!;
      for (const x of this.voices) if (x.busyUntil < v.busyUntil) v = x;
      this.core.budget.release(v.entry);
      this.core.budget.steals++;
      this.kill(v, t);
    }
    if (!v.linked) { v.vca.connect(this.bus); v.linked = true; }
    return v;
  }

  /** Paraphonic filter envelope: once per event (all chord tones share it). */
  private filterEnv(t: number, off: number, vel: number): void {
    const f = this.filt;
    if (!f || this.kind === 'pad' || t === this.lastEnvAt) return;
    this.lastEnvAt = t;
    const tn = this.tone;
    const fp = f.frequency;
    fp.cancelScheduledValues(t);
    if (this.kind === 'brass') {
      // the synth-brass "swell": the filter opens just behind the amp, overshoots a little, settles
      const env = tn.envAmount * (0.45 + 0.55 * vel);
      fp.setTargetAtTime(tn.cutoff, t, 0.002);
      fp.setTargetAtTime(tn.cutoff + env, t + 0.004, 0.028);
      fp.setTargetAtTime(tn.cutoff + env * 0.42, t + 0.11, tc(tn.decay, 3));
      fp.setTargetAtTime(tn.cutoff * 0.9, off, tc(tn.release, 3));
    } else {
      const env = tn.envAmount * (0.35 + 0.65 * vel);
      fp.setTargetAtTime(tn.cutoff + env, t, 0.0008);
      fp.setTargetAtTime(tn.cutoff, t + 0.002, tc(tn.decay * 0.8, 3));
    }
  }

  trigger(t: number, midi: readonly number[], dur: number, vel: number): void {
    if (midi.length === 0) return;
    const off = t + Math.max(0.02, dur * this.tone.gate);
    this.filterEnv(t, off, vel);
    if (this.kind === 'pad' || this.kind === 'brass') this.chordVoice(t, midi, off, vel);
    else for (const m of midi) this.note(t, m, off, vel);
  }

  /** Voice end: the release is a setTargetAtTime with tc = release/4, so 1.6 x release is below -50 dB. */
  private endOf(off: number): number {
    return off + this.tone.release * 1.6 + 0.02;
  }

  private chordVoice(t: number, midi: readonly number[], off: number, vel: number): void {
    const ctx = this.core.ctx;
    const tn = this.tone;
    const end = this.endOf(off);
    const v = this.alloc(t);
    v.entry = this.core.budget.acquire(t, end, (kt) => this.kill(v, kt));
    v.busyUntil = end;
    const buf = this.core.assets.chord(this.kind as StackKind, midi);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(v.vca);
    src.start(t, Math.random() * buf.duration);
    stopAt(src, end + 0.02);
    oneShot(src);
    v.srcs = [src];
    adsr(v.vca.gain, t, off, tn.level * (0.3 + 0.7 * vel), tn);
  }

  private note(t: number, m: number, off: number, vel: number): void {
    const ctx = this.core.ctx;
    const tn = this.tone;
    const end = this.kind === 'bell' ? t + tn.decay * 1.25 + 0.05 : this.endOf(off);
    const v = this.alloc(t);
    v.entry = this.core.budget.acquire(t, end, (kt) => this.kill(v, kt));
    v.busyUntil = end;
    const peak = tn.level * (0.3 + 0.7 * vel);
    const srcs: AudioScheduledSourceNode[] = [];
    if (this.kind === 'bell') {
      const f = midiToFreq(m);
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      car.frequency.value = f;
      mod.frequency.value = f * 3.5;
      const idx = f * 3.5 * (1.4 + 1.2 * vel);
      modGain.gain.setValueAtTime(idx, t);
      modGain.gain.setTargetAtTime(idx * 0.08, t + 0.003, 0.22);
      mod.connect(modGain).connect(car.frequency);
      car.connect(v.vca);
      car.start(t);
      mod.start(t);
      srcs.push(car, mod);
      oneShot(mod, modGain);
      const g = v.vca.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(peak, t, 0.0008);
      g.setTargetAtTime(0, t + 0.004, tc(tn.decay, 4));
    } else {
      const o = ctx.createOscillator();
      o.type = this.kind === 'pluck' ? 'sawtooth' : 'square';
      o.frequency.value = midiToFreq(m);
      if (this.kind === 'pluck') o.detune.value = (Math.random() - 0.5) * 8;
      o.connect(v.vca);
      o.start(t);
      srcs.push(o);
      adsr(v.vca.gain, t, off, peak, tn);
    }
    for (const s of srcs) {
      stopAt(s, end + 0.02);
      if (!s.onended) oneShot(s);
    }
    v.srcs = srcs;
  }

  setBrightness(x: number, t: number): void {
    if (this.kind !== 'pad' || !this.filt) return;
    this.filt.frequency.setTargetAtTime(this.tone.cutoff * (0.5 + 0.9 * x), t, 0.8);
  }

  releaseAll(t: number): void {
    for (const v of this.voices) {
      if (v.busyUntil <= t) continue;
      const g = v.vca.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, tc(this.tone.release, 4));
      const end = t + this.tone.release * 1.6 + 0.05;
      for (const s of v.srcs) stopAt(s, end);
      v.busyUntil = end;
      if (v.entry) v.entry.end = Math.min(v.entry.end, end);
    }
  }

  /** Detach voices that have been idle for a moment (no CPU for idle pool members). */
  maintain(now: number): void {
    for (const v of this.voices) {
      if (v.linked && v.busyUntil + 0.25 < now) {
        v.vca.disconnect();
        v.linked = false;
        v.srcs = [];
      }
    }
  }

  dispose(): void {
    const now = this.core.ctx.currentTime;
    for (const v of this.voices) {
      for (const s of v.srcs) stopAt(s, now);
      this.core.budget.release(v.entry);
      v.vca.disconnect();
    }
    this.voices.length = 0;
    if (this.lfo) stopAt(this.lfo, now);
    for (const n of this.extra) n.disconnect();
  }
}
