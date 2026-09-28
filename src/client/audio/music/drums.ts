// Synthesized 80s drum kit + transition FX. Each drum piece keeps a persistent VCA chain; only
// source nodes (one oscillator and/or one noise/metal buffer source) are created per hit.
//
// GATED REVERB (the signature 80s snare): convolving a hit with a gated room impulse is the same
// as playing that impulse, a dense stereo noise burst that stays loud for ~240 ms and then stops
// dead, filtered by the drum's own spectrum. So each snare, clap or tom hit fires the shared
// gated-room buffer (assets.gatedTail, a rate-1 stereo source, very cheap) through that drum's
// persistent room filter. You get the classic sound without a ConvolverNode on the bus.
import type { DrumInstrument } from './format';
import { kRate, SynthCore, type Instrument } from './synth';

function stopAt(src: AudioScheduledSourceNode, t: number): void {
  try { src.stop(t); } catch { /* not started / already stopped */ }
}

function oneShot(src: AudioScheduledSourceNode): void {
  src.onended = (): void => src.disconnect();
}

function noiseSrc(core: SynthCore, buf: AudioBuffer, loop = false): AudioBufferSourceNode {
  const s = core.ctx.createBufferSource();
  s.buffer = buf;
  s.loop = loop;
  return s;
}

function filter(core: SynthCore, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = core.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function vcaNode(core: SynthCore): GainNode {
  const g = core.ctx.createGain();
  g.gain.value = 0;
  return g;
}

/** Per-drum gated room: shared gated-noise tail → this drum's band filter → level → out. */
class GatedRoom {
  private readonly filt: BiquadFilterNode;
  private readonly vca: GainNode;
  constructor(private readonly core: SynthCore, out: AudioNode, readonly level: number, freq: number, q: number) {
    this.filt = filter(core, 'bandpass', freq, q);
    kRate(this.filt.frequency);
    this.vca = core.ctx.createGain();
    this.vca.gain.value = 0;
    this.filt.connect(this.vca).connect(out);
  }
  hit(t: number, vel: number, freq?: number): void {
    if (this.level <= 0) return;
    const s = noiseSrc(this.core, this.core.assets.gatedTail);
    s.connect(this.filt);
    s.start(t + 0.006);
    oneShot(s);
    if (freq !== undefined) this.filt.frequency.setValueAtTime(freq, t);
    this.vca.gain.setValueAtTime(this.level * vel, t);
  }
  nodes(): AudioNode[] { return [this.filt, this.vca]; }
}

/** Fast-attack exponential decay hit on a gain param (continuous from its current value). */
function hit(p: AudioParam, t: number, peak: number, decayTc: number, hold = 0.003): void {
  p.cancelScheduledValues(t);
  p.setTargetAtTime(peak, t, 0.0005);
  p.setTargetAtTime(0, t + hold, decayTc);
}

const NOOP = (): void => { /* short drum voice: nothing to steal */ };

abstract class Drum implements Instrument {
  protected readonly nodes: AudioNode[] = [];
  constructor(protected readonly core: SynthCore, protected readonly out: AudioNode) {}
  abstract trigger(t: number, midi: readonly number[], dur: number, vel: number, glide: boolean, variant: string): void;
  releaseAll(): void { /* drums always ring out */ }
  maintain(): void { /* persistent chains */ }
  protected claim(t: number, len: number): void {
    this.core.budget.acquire(t, t + len, NOOP);
  }
  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------

export class Kick extends Drum {
  private readonly vca: GainNode;
  private last: OscillatorNode | null = null;
  /** Sidechain pump depth (from Song.pump). */
  pump = 0.5;

  constructor(core: SynthCore, out: AudioNode) {
    super(core, out);
    const ctx = core.ctx;
    this.vca = vcaNode(core);
    const drive = ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
    drive.curve = curve;
    this.vca.connect(drive).connect(out);
    this.nodes.push(this.vca, drive);
  }

  trigger(t: number, _m: readonly number[], _d: number, vel: number): void {
    const ctx = this.core.ctx;
    // the beater click is the first few ms of the sweep (420 Hz → 160 Hz), then the body drops to ~43 Hz
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.007);
    o.frequency.exponentialRampToValueAtTime(56, t + 0.07);
    o.frequency.setTargetAtTime(43, t + 0.07, 0.16);
    o.connect(this.vca);
    o.start(t);
    stopAt(o, t + 0.5);
    oneShot(o);
    if (this.last) stopAt(this.last, t + 0.004);
    this.last = o;
    hit(this.vca.gain, t, 0.62 * (0.45 + 0.55 * vel), 0.09, 0.012);
    this.core.fx.duck(t, this.pump * (0.6 + 0.4 * vel));
    this.claim(t, 0.45);
  }
}

export class Snare extends Drum {
  private readonly toneVca: GainNode;
  private readonly noiseVca: GainNode;
  private readonly noiseIn: AudioNode;
  private readonly room: GatedRoom;

  constructor(core: SynthCore, out: AudioNode, room = 0.9) {
    super(core, out);
    this.room = new GatedRoom(core, out, room * 1.6, 1700, 0.45);
    this.nodes.push(...this.room.nodes());
    this.toneVca = vcaNode(core);
    this.noiseVca = vcaNode(core);
    const hp = filter(core, 'highpass', 950, 0.7);
    hp.connect(this.noiseVca).connect(out);
    this.toneVca.connect(out);
    this.noiseIn = hp;
    this.nodes.push(this.toneVca, this.noiseVca, hp);
  }

  trigger(t: number, _m: readonly number[], _d: number, vel: number): void {
    const ctx = this.core.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    kRate(o.frequency);
    o.frequency.setValueAtTime(215, t);
    o.frequency.exponentialRampToValueAtTime(168, t + 0.05);
    o.connect(this.toneVca);
    o.start(t);
    stopAt(o, t + 0.3);
    oneShot(o);
    hit(this.toneVca.gain, t, 0.62 * vel, 0.03, 0.004);
    const n = noiseSrc(this.core, this.core.assets.noise);
    n.connect(this.noiseIn);
    n.start(t, Math.random() * 1.4, 0.45);
    oneShot(n);
    hit(this.noiseVca.gain, t, 0.9 * vel, 0.055, 0.006);
    this.room.hit(t, vel);
    this.claim(t, 0.35);
  }
}

export class Clap extends Drum {
  private readonly vca: GainNode;
  private readonly inNode: AudioNode;
  private readonly room: GatedRoom;

  constructor(core: SynthCore, out: AudioNode, room = 0.7) {
    super(core, out);
    this.room = new GatedRoom(core, out, room * 0.9, 1400, 0.7);
    this.nodes.push(...this.room.nodes());
    this.vca = vcaNode(core);
    const bp = filter(core, 'bandpass', 1200, 1.1);
    bp.connect(this.vca).connect(out);
    this.inNode = bp;
    this.nodes.push(this.vca, bp);
  }

  trigger(t: number, _m: readonly number[], _d: number, vel: number): void {
    const n = noiseSrc(this.core, this.core.assets.noise);
    n.connect(this.inNode);
    n.start(t, Math.random() * 1.4, 0.4);
    oneShot(n);
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    for (const k of [0, 0.0105, 0.0215]) {
      g.setValueAtTime(0.95 * vel, t + k);
      g.setTargetAtTime(0.07 * vel, t + k + 0.0005, 0.0035);
    }
    g.setValueAtTime(0.8 * vel, t + 0.031);
    g.setTargetAtTime(0, t + 0.0315, 0.06);
    this.room.hit(t, vel);
    this.claim(t, 0.35);
  }
}

/** Closed/open hat on one chain: a closed hit chokes a ringing open one. */
export class Hat extends Drum {
  private readonly vca: GainNode;
  private readonly inNode: AudioNode;
  private last: AudioBufferSourceNode | null = null;

  constructor(core: SynthCore, out: AudioNode) {
    super(core, out);
    this.vca = vcaNode(core);
    const hp = filter(core, 'highpass', 7200, 0.8);
    hp.connect(this.vca).connect(out);
    this.inNode = hp;
    this.nodes.push(this.vca, hp);
  }

  trigger(t: number, _m: readonly number[], _d: number, vel: number, _g: boolean, variant: string): void {
    const open = variant === 'o';
    const s = noiseSrc(this.core, this.core.assets.metal);
    s.connect(this.inNode);
    s.start(t, Math.random() * 1.2);
    stopAt(s, t + (open ? 0.9 : 0.16));
    oneShot(s);
    if (this.last) stopAt(this.last, t + 0.01);
    this.last = s;
    if (open) hit(this.vca.gain, t, 0.58 * vel, 0.11, 0.01);
    else hit(this.vca.gain, t, 0.66 * vel, 0.014, 0.002);
    this.claim(t, open ? 0.8 : 0.12);
  }

  choke(t: number): void {
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.006);
    if (this.last) stopAt(this.last, t + 0.05);
  }
}

const TOM_HZ: Record<string, number> = { h: 205, m: 152, l: 113, f: 84 };

/** Simmons-style toms: sine with a dramatic downward sweep + a noise stick. Two alternating chains. */
export class Tom extends Drum {
  private readonly chains: { vca: GainNode; nvca: GainNode; bp: BiquadFilterNode }[] = [];
  private next = 0;
  private readonly room: GatedRoom;

  constructor(core: SynthCore, out: AudioNode, room = 0.75) {
    super(core, out);
    this.room = new GatedRoom(core, out, room * 0.8, 600, 0.9);
    this.nodes.push(...this.room.nodes());
    for (let i = 0; i < 2; i++) {
      const vca = vcaNode(core);
      const nvca = vcaNode(core);
      const bp = filter(core, 'bandpass', 800, 0.8);
      vca.connect(out);
      bp.connect(nvca).connect(out);
      this.chains.push({ vca, nvca, bp });
      this.nodes.push(vca, nvca, bp);
    }
  }

  trigger(t: number, _m: readonly number[], _d: number, vel: number, _g: boolean, variant: string): void {
    const c = this.chains[this.next]!;
    this.next ^= 1;
    const f0 = TOM_HZ[variant] ?? TOM_HZ.m!;
    const ctx = this.core.ctx;
    const o = ctx.createOscillator();
    kRate(o.frequency);
    o.frequency.setValueAtTime(f0 * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.055);
    o.frequency.setTargetAtTime(f0 * 0.76, t + 0.055, 0.22);
    o.connect(c.vca);
    o.start(t);
    stopAt(o, t + 0.75);
    oneShot(o);
    hit(c.vca.gain, t, 0.72 * vel, 0.17, 0.01);
    c.bp.frequency.setValueAtTime(f0 * 5, t);
    const n = noiseSrc(this.core, this.core.assets.noise);
    n.connect(c.bp);
    n.start(t, Math.random() * 1.4, 0.08);
    oneShot(n);
    hit(c.nvca.gain, t, 0.28 * vel, 0.02, 0.002);
    this.room.hit(t, vel, f0 * 3);
    this.claim(t, 0.7);
  }
}

export class Crash extends Drum {
  private readonly chains: { vca: GainNode; inNode: AudioNode }[] = [];
  private next = 0;

  constructor(core: SynthCore, out: AudioNode) {
    super(core, out);
    for (let i = 0; i < 2; i++) {
      const vca = vcaNode(core);
      const hp = filter(core, 'highpass', 4800, 0.6);
      hp.connect(vca).connect(out);
      this.chains.push({ vca, inNode: hp });
      this.nodes.push(vca, hp);
    }
  }

  trigger(t: number, _m: readonly number[], _d: number, vel: number): void {
    const c = this.chains[this.next]!;
    this.next ^= 1;
    const a = noiseSrc(this.core, this.core.assets.metal, true);
    const b = noiseSrc(this.core, this.core.assets.noise, true);
    a.connect(c.inNode);
    b.connect(c.inNode);
    a.start(t, Math.random() * 1.5);
    b.start(t, Math.random() * 1.5);
    stopAt(a, t + 3);
    stopAt(b, t + 3);
    oneShot(a);
    oneShot(b);
    const g = c.vca.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.3 * vel, t, 0.0008);
    g.setTargetAtTime(0.17 * vel, t + 0.004, 0.05);
    g.setTargetAtTime(0, t + 0.07, 0.62);
    this.claim(t, 2.6);
  }
}

// ---------------------------------------------------------------------------------------------
// Drum bank: the synthesized kit above, rendered ONCE per session into velocity-layered buffers
// (like the sample-playback drum machines of the era: every hit is identical). A hit then costs a
// single rate-1 buffer source and no persistent chains. The gated room is baked into the snare,
// clap and tom samples. Until the bank is ready (~0.1-0.3 s after unlock) hits fall back to the
// live synth.
// ---------------------------------------------------------------------------------------------

export type LiveDrum = Kick | Snare | Clap | Hat | Tom | Crash;

export function createLiveDrum(core: SynthCore, inst: DrumInstrument, out: AudioNode, room?: number): LiveDrum {
  switch (inst) {
    case 'kick': return new Kick(core, out);
    case 'snare': return new Snare(core, out, room);
    case 'clap': return new Clap(core, out, room);
    case 'hat':
    case 'ohat': return new Hat(core, out);
    case 'tom': return new Tom(core, out, room);
    case 'crash': return new Crash(core, out);
  }
}

interface BankSpec {
  inst: DrumInstrument;
  variant: string;
  layers: readonly number[];
  /** Slot length in seconds (longer than the sound). */
  len: number;
  /** Store as mono (no stereo room): everything downstream then runs single-channel. */
  mono?: boolean;
}

const BANK_SPEC: readonly BankSpec[] = [
  { inst: 'kick', variant: 'x', layers: [0.5, 0.8, 1], len: 0.6, mono: true },
  { inst: 'snare', variant: 'x', layers: [0.5, 0.8, 1], len: 0.55 },
  { inst: 'clap', variant: 'x', layers: [0.5, 0.8, 1], len: 0.5 },
  { inst: 'hat', variant: 'x', layers: [0.5, 0.8, 1], len: 0.2, mono: true },
  { inst: 'hat', variant: 'o', layers: [0.5, 0.8, 1], len: 0.95, mono: true },
  ...['h', 'm', 'l', 'f'].map((v) => ({ inst: 'tom' as const, variant: v, layers: [0.6, 1], len: 0.85 })),
  { inst: 'crash', variant: 'x', layers: [0.7, 1], len: 3.1, mono: true },
];

/** Pick the velocity layer nearest to vel. Returns the layer index. */
export function nearestLayer(layers: readonly number[], vel: number): number {
  let bi = 0;
  for (let i = 1; i < layers.length; i++) if (Math.abs(layers[i]! - vel) < Math.abs(layers[bi]! - vel)) bi = i;
  return bi;
}

export class DrumBank {
  private readonly bufs = new Map<string, AudioBuffer>();
  private readonly layers = new Map<string, readonly number[]>();
  /** Resolves when every sample is ready (never rejects; on failure the live synth is used). */
  readonly done: Promise<void>;
  ready = false;

  constructor(sampleRate: number, rooms: Readonly<Record<'snare' | 'clap' | 'tom', number>>) {
    for (const sp of BANK_SPEC) this.layers.set(`${sp.inst}:${sp.variant}`, sp.layers);
    this.done = this.render(sampleRate, rooms).catch((e: unknown) => { console.warn('[music] drum bank render failed; using live drums', e); });
  }

  private async render(sr: number, rooms: Readonly<Record<'snare' | 'clap' | 'tom', number>>): Promise<void> {
    const OAC = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OAC) return;
    let total = 0.05;
    for (const sp of BANK_SPEC) total += sp.len * sp.layers.length;
    const ctx = new OAC(2, Math.ceil(total * sr), sr);
    const core = new SynthCore(ctx);
    const kits = new Map<DrumInstrument, LiveDrum>();
    const slots: { key: string; t: number; len: number; mono: boolean }[] = [];
    let t = 0.02;
    for (const sp of BANK_SPEC) {
      let d = kits.get(sp.inst);
      if (!d) {
        d = createLiveDrum(core, sp.inst, ctx.destination, sp.inst === 'snare' || sp.inst === 'clap' || sp.inst === 'tom' ? rooms[sp.inst] : undefined);
        kits.set(sp.inst, d);
      }
      sp.layers.forEach((vel, li) => {
        d.trigger(t, [], 0.1, vel, false, sp.variant);
        slots.push({ key: `${sp.inst}:${sp.variant}:${li}`, t, len: sp.len, mono: !!sp.mono });
        t += sp.len;
      });
    }
    const out = await ctx.startRendering();
    const L = out.getChannelData(0);
    const R = out.getChannelData(1);
    for (const s of slots) {
      const a = Math.round(s.t * sr);
      let n = Math.min(Math.round(s.len * sr), L.length - a);
      // trim the silent tail, then a 2 ms fade so a trimmed sample never ends on a step
      while (n > 1 && Math.abs(L[a + n - 1]!) < 2e-4 && Math.abs(R[a + n - 1]!) < 2e-4) n--;
      const buf = new AudioBuffer({ numberOfChannels: s.mono ? 1 : 2, length: Math.max(1, n), sampleRate: sr });
      const chans: Float32Array[] = [];
      if (s.mono) {
        const m = buf.getChannelData(0);
        for (let i = 0; i < n; i++) m[i] = 0.5 * (L[a + i]! + R[a + i]!);
        chans.push(m);
      } else {
        const bl = buf.getChannelData(0);
        const br = buf.getChannelData(1);
        bl.set(L.subarray(a, a + n));
        br.set(R.subarray(a, a + n));
        chans.push(bl, br);
      }
      const fade = Math.min(n, Math.round(0.002 * sr));
      for (const ch of chans) for (let i = 0; i < fade; i++) ch[n - 1 - i]! *= i / fade;
      this.bufs.set(s.key, buf);
    }
    for (const d of kits.values()) d.dispose();
    core.dispose();
    this.ready = true;
  }

  /** The sample for a hit, or null while the bank is still rendering. */
  get(inst: DrumInstrument, variant: string, vel: number): AudioBuffer | null {
    if (!this.ready) return null;
    const i = inst === 'ohat' ? 'hat' : inst;
    const v = inst === 'ohat' ? 'o' : variant;
    const layers = this.layers.get(`${i}:${v}`);
    if (!layers) return null;
    return this.bufs.get(`${i}:${v}:${nearestLayer(layers, vel)}`) ?? null;
  }
}

/** A drum track voice that plays bank samples (falls back to the live synth until ready). */
export class SampledDrum implements Instrument {
  private live: LiveDrum | null = null;
  private lastOpen: AudioBufferSourceNode | null = null;
  /** Sidechain pump depth for kicks (from Song.pump). */
  pump = 0.5;

  constructor(
    private readonly core: SynthCore, private readonly out: AudioNode, private readonly inst: DrumInstrument,
    private readonly bank: DrumBank, private readonly room?: number,
  ) {}

  trigger(t: number, midi: readonly number[], dur: number, vel: number, glide: boolean, variant: string): void {
    const buf = this.bank.get(this.inst, variant, vel);
    if (!buf) {
      this.live ??= createLiveDrum(this.core, this.inst, this.out, this.room);
      if (this.live instanceof Kick) this.live.pump = this.pump;
      this.live.trigger(t, midi, dur, vel, glide, variant);
      return;
    }
    const s = this.core.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.out);
    s.start(t);
    oneShot(s);
    if (this.inst === 'kick') this.core.fx.duck(t, this.pump * (0.6 + 0.4 * vel));
    if (this.inst === 'hat' || this.inst === 'ohat') {
      if (this.lastOpen) { stopAt(this.lastOpen, t); this.lastOpen = null; }
      if (this.inst === 'ohat' || variant === 'o') this.lastOpen = s;
    }
    this.core.budget.acquire(t, t + buf.duration, NOOP);
  }

  choke(t: number): void {
    if (this.lastOpen) { stopAt(this.lastOpen, t); this.lastOpen = null; }
    if (this.live instanceof Hat) this.live.choke(t);
  }

  releaseAll(): void { /* drums ring out */ }

  maintain(): void { /* no persistent chains */ }

  dispose(): void {
    this.live?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Transition riser: band-passed noise sweep + reverse-cymbal swell that lands on t1.
// ---------------------------------------------------------------------------------------------

export interface RiserHandle {
  cancel(t: number): void;
}

export function playRiser(core: SynthCore, t0: number, t1: number, level = 0.16): RiserHandle {
  const ctx = core.ctx;
  const fx = core.fx;
  const span = Math.max(0.05, t1 - t0);
  const bp = filter(core, 'bandpass', 350, 1.6);
  const g = ctx.createGain();
  const hp = filter(core, 'highpass', 6000, 0.7);
  const g2 = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = 0.5;
  const nodes: AudioNode[] = [bp, g, hp, g2, send];
  const n = noiseSrc(core, core.assets.noise, true);
  const m = noiseSrc(core, core.assets.metal, true);
  n.connect(bp).connect(g);
  m.connect(hp).connect(g2);
  for (const x of [g, g2]) { x.connect(fx.dryIn); x.connect(send); }
  send.connect(fx.reverbIn);
  bp.frequency.setValueAtTime(350, t0);
  bp.frequency.exponentialRampToValueAtTime(8500, t0 + span);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(level, t0 + span - 0.01);
  g.gain.linearRampToValueAtTime(0, t0 + span + 0.015);
  g2.gain.setValueAtTime(0.0001, t0);
  g2.gain.exponentialRampToValueAtTime(level * 0.9, t0 + span - 0.005);
  g2.gain.linearRampToValueAtTime(0, t0 + span + 0.01);
  n.start(t0);
  m.start(t0, 0.3);
  stopAt(n, t0 + span + 0.05);
  stopAt(m, t0 + span + 0.05);
  n.onended = (): void => { n.disconnect(); m.disconnect(); for (const x of nodes) x.disconnect(); };
  core.budget.acquire(t0, t0 + span + 0.05, NOOP);
  return {
    cancel(t: number): void {
      for (const x of [g, g2]) {
        x.gain.cancelScheduledValues(t);
        x.gain.setTargetAtTime(0, t, 0.04);
      }
      stopAt(n, t + 0.3);
      stopAt(m, t + 0.3);
    },
  };
}
