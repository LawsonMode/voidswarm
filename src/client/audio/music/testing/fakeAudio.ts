// Minimal fake BaseAudioContext for unit tests (node has no WebAudio). It records every
// scheduled source start, so the sequencer's timing can be checked exactly. It also keeps a live
// count of nodes that have outgoing connections (`connected`) and, when the test calls
// endSources(t), fires `onended` for sources that have finished by t, like a real context does.
// Together they let tests check that the engine's audio graph does not grow over time.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StartRecord {
  kind: 'osc' | 'buffer';
  t: number;
  /** First value given to frequency.setValueAtTime (or the initial .value), to tell drums apart. */
  freq0: number;
  node: FakeNode;
}

class FakeParam {
  value: number;
  automationRate = 'a-rate';
  first: number | null = null;
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v: number): this { this.first ??= v; return this; }
  setTargetAtTime(): this { return this; }
  linearRampToValueAtTime(): this { return this; }
  exponentialRampToValueAtTime(): this { return this; }
  cancelScheduledValues(): this { return this; }
}

export class FakeNode {
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  onended: (() => void) | null = null;
  started: number | null = null;
  stopped: number | null = null;
  connections = 0;
  [k: string]: any;
  constructor(readonly ctx: FakeContext, readonly nodeType: string, params: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(params)) this[k] = new FakeParam(v);
  }
  connect(dest: any): any {
    if (this.connections++ === 0) this.ctx.connected++;
    return dest;
  }
  disconnect(): void {
    if (this.connections > 0) this.ctx.connected--;
    this.connections = 0;
  }
  setPeriodicWave(): void { /* no-op */ }
  start(t = 0): void {
    this.started = t;
    const f = this.frequency as FakeParam | undefined;
    this.ctx.starts.push({ kind: this.nodeType === 'osc' ? 'osc' : 'buffer', t, freq0: f ? (f.first ?? f.value) : 0, node: this });
    this.ctx.live.add(this);
  }
  stop(t = 0): void { this.stopped = t; }
  /** When this source finishes: its stop time, or the end of a non-looping buffer. */
  endTime(): number {
    let end = this.stopped ?? Infinity;
    const buf = this.buffer as FakeBuffer | undefined;
    if (this.nodeType === 'buffer' && buf && !this.loop && this.started !== null) end = Math.min(end, this.started + buf.duration);
    return end;
  }
}

class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i: number): Float32Array { return this.data[i]!; }
  copyToChannel(src: Float32Array, i: number): void { this.data[i]!.set(src.subarray(0, this.length)); }
}

export class FakeContext {
  currentTime = 0;
  readonly sampleRate: number;
  readonly starts: StartRecord[] = [];
  readonly destination: FakeNode;
  state = 'running';
  /** Nodes that currently have at least one outgoing connection. */
  connected = 0;
  /** Started sources that have not ended yet. */
  readonly live = new Set<FakeNode>();
  constructor(sampleRate = 32000) {
    this.sampleRate = sampleRate;
    this.destination = new FakeNode(this, 'destination');
  }
  /** Fire onended for every started source that has finished by time t. Returns how many ended. */
  endSources(t: number): number {
    let n = 0;
    for (const node of this.live) {
      if (node.endTime() > t) continue;
      this.live.delete(node);
      node.onended?.();
      n++;
    }
    return n;
  }
  resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
  suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
  createGain(): FakeNode { return new FakeNode(this, 'gain', { gain: 1 }); }
  createBiquadFilter(): FakeNode { return new FakeNode(this, 'biquad', { frequency: 350, Q: 1, gain: 0 }); }
  createIIRFilter(): FakeNode { return new FakeNode(this, 'iir'); }
  createDelay(): FakeNode { return new FakeNode(this, 'delay', { delayTime: 0 }); }
  createChannelMerger(): FakeNode { return new FakeNode(this, 'merger'); }
  createStereoPanner(): FakeNode { return new FakeNode(this, 'panner', { pan: 0 }); }
  createDynamicsCompressor(): FakeNode { return new FakeNode(this, 'comp', { threshold: 0, knee: 0, ratio: 1, attack: 0, release: 0 }); }
  createWaveShaper(): FakeNode { return new FakeNode(this, 'shaper'); }
  createConvolver(): FakeNode { return new FakeNode(this, 'convolver'); }
  createAnalyser(): FakeNode { return new FakeNode(this, 'analyser'); }
  createOscillator(): FakeNode { return new FakeNode(this, 'osc', { frequency: 440, detune: 0 }); }
  createBufferSource(): FakeNode { return new FakeNode(this, 'buffer', { playbackRate: 1, detune: 0 }); }
  createPeriodicWave(): object { return {}; }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { return new FakeBuffer(ch, len, sr); }
}

/** The fake as the type the engine expects. */
export function fakeCtx(sampleRate = 32000): { fake: FakeContext; ctx: BaseAudioContext } {
  const fake = new FakeContext(sampleRate);
  return { fake, ctx: fake as unknown as BaseAudioContext };
}
