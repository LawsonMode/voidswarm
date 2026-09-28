// Lifecycle and harmony checks on the REAL engine, driven against the fake AudioContext:
//  - stingers that follow the chord land on the triad of the chord playing, and bar-quantized
//    stingers use the transpose of the section they land in
//  - the audio graph does not grow while a song loops or while songs keep switching (no leaks)
//  - the MusicDirector makes no AudioContext before unlock(), switches scenes on bar lines, and
//    destroy() leaves no timers and no connected nodes behind
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileSong, type CompiledSong } from './compile';
import { MusicDirector, type MusicScene } from './director';
import { hold, type Song, type Stinger } from './format';
import { Sequencer } from './sequencer';
import { SONGS } from './songs/index';
import { DEFAULT_STINGERS } from './songs/stingers';
import { SynthCore } from './synth';
import { FakeContext, fakeCtx } from './testing/fakeAudio';

function compiled(s: Song): CompiledSong {
  const r = compileSong(s);
  expect(r.errors).toEqual([]);
  return r.compiled!;
}

/** Pump like the director (25 ms ticks), ending finished sources like a real context. */
function run(fake: FakeContext, seq: Sequencer, from: number, to: number, onTick?: (t: number) => void): void {
  for (let t = from; t <= to + 1e-9; t += 0.025) {
    fake.currentTime = t;
    onTick?.(t);
    seq.pump(t);
    fake.endSources(t);
  }
}

const pc = (m: number): number => ((Math.round(m) % 12) + 12) % 12;
/** Oscillators started since index n0 whose frequency is an exact note (bell carriers, plucks): time + MIDI. */
function timedNotesSince(fake: FakeContext, n0: number): { t: number; m: number }[] {
  return fake.starts.slice(n0).filter((s) => s.kind === 'osc' && s.freq0 > 20)
    .map((s) => ({ t: s.t, m: 69 + 12 * Math.log2(s.freq0 / 440) }))
    .filter((x) => Math.abs(x.m - Math.round(x.m)) < 1e-6)
    .map((x) => ({ t: x.t, m: Math.round(x.m) }));
}
function notesSince(fake: FakeContext, n0: number): number[] {
  return timedNotesSince(fake, n0).map((x) => x.m);
}

describe('stingers fit the harmony', () => {
  /** A minor, 120 bpm (bar = 2 s, origin 0.08): pads F (bar 1) then G (bar 2), bass on the roots. */
  const twoChords: Song = {
    title: 'F G', bpm: 120, key: 'A', mode: 'aeolian',
    tracks: [{ id: 'pad', inst: 'pad' }, { id: 'bass', inst: 'bass' }],
    patterns: { p: `${hold('@F', 16)} ${hold('@G', 16)}`, b: `${hold('F1', 16)} ${hold('G1', 16)}` },
    sections: { a: { bars: 2, play: { pad: 'p', bass: 'b' } } },
    form: ['a'],
  };

  it("follow: 'chord' arpeggiates the chord playing (G major over a G bar in A minor), not the tonic", () => {
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.setIntensity(1, true);
    seq.play(compiled(twoChords), 0);
    run(fake, seq, 0, 2.5);
    const n0 = fake.starts.length;
    expect(DEFAULT_STINGERS.levelUp.follow).toBe('chord');
    seq.stinger(DEFAULT_STINGERS.levelUp, 2.5);
    const notes = notesSince(fake, n0);
    expect(notes.length).toBeGreaterThanOrEqual(4);
    for (const m of notes) expect([7, 11, 2], `note ${m}`).toContain(pc(m)); // G B D
  });

  it('a stinger that straddles a chord change follows it note by note (the pluck chord lands on G, not F)', () => {
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.setIntensity(1, true);
    seq.play(compiled(twoChords), 0);
    run(fake, seq, 0, 1.7); // scheduled up to step 13; the stinger lands on step 14 (bar 1, still F)
    const n0 = fake.starts.length;
    seq.stinger(DEFAULT_STINGERS.levelUp, 1.7);
    /** Exact-pitch notes the stinger started on song step k (origin 0.08 s, 16ths of 0.125 s). */
    const at = (k: number): number[] => timedNotesSince(fake, n0).filter((x) => Math.abs(x.t - (0.08 + k * 0.125)) < 1e-9).map((x) => x.m);
    expect(at(14).map(pc)).toEqual([5]); // the bell's first note: F (the F chord)
    const pluck = at(17); // levelUp's pluck triad, 3 steps later: the next bar's G chord
    expect(pluck.length).toBeGreaterThanOrEqual(3);
    for (const m of pluck) expect([7, 11, 2], `note ${m}`).toContain(pc(m));
  });

  it("follow: 'key' (the default) keeps the song's key: the same stinger spells the A-minor triad", () => {
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.setIntensity(1, true);
    seq.play(compiled(twoChords), 0);
    run(fake, seq, 0, 2.5);
    const n0 = fake.starts.length;
    seq.stinger({ ...DEFAULT_STINGERS.levelUp, follow: 'key' }, 2.5);
    for (const m of notesSince(fake, n0)) expect([9, 0, 4]).toContain(pc(m)); // A C E
  });

  it('a stinger over a sus chord snaps its non-chord tones to the chord (Asus4: no C or C#)', () => {
    const sus: Song = { ...twoChords, patterns: { p: hold('@Asus4', 32), b: hold('A1', 32) } };
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.setIntensity(1, true);
    seq.play(compiled(sus), 0);
    run(fake, seq, 0, 1.3);
    const n0 = fake.starts.length;
    seq.stinger(DEFAULT_STINGERS.levelUp, 1.3);
    const notes = notesSince(fake, n0);
    expect(notes.length).toBeGreaterThan(0);
    for (const m of notes) expect([9, 2, 4], `note ${m}`).toContain(pc(m)); // A D E
  });

  it('a bar-quantized stinger uses the transpose of the section it lands in (the key change)', () => {
    const song: Song = {
      title: 'lift', bpm: 120, key: 'A', mode: 'aeolian',
      tracks: [{ id: 'pad', inst: 'pad' }],
      patterns: { p: hold('@Am', 16) },
      sections: { a: { bars: 1, play: { pad: 'p' } }, b: { bars: 1, transpose: 2, play: { pad: 'p' } } },
      form: ['a', 'b'],
    };
    const bell: Stinger = { quantize: 'bar', parts: [{ inst: 'bell', octave: 5, steps: '1 - - -' }] };
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.play(compiled(song), 0);
    run(fake, seq, 0, 0.5); // the scheduling cursor is still in section a (T0)
    const n0 = fake.starts.length;
    seq.stinger(bell, 0.5);
    const hit = fake.starts.slice(n0).find((s) => s.kind === 'osc' && Math.abs(69 + 12 * Math.log2(s.freq0 / 440) - 83) < 1e-6);
    expect(hit, 'B5 (A5 + 2): section b').toBeDefined();
    expect(hit!.t).toBeCloseTo(2.08, 9); // the next bar line = section b's downbeat
  });

  it("the shipped songs' stingers compile, and only bossIncoming stays key-relative", () => {
    expect(DEFAULT_STINGERS.waveStart.follow).toBe('chord');
    expect(DEFAULT_STINGERS.bossIncoming.follow ?? 'key').toBe('key');
    expect(compileSong({ ...twoChords, stingers: { levelUp: { follow: 'nope' as 'key', parts: [] } } }).errors.join()).toMatch(/follow/);
  });
});

describe('the audio graph does not grow', () => {
  it('3 loops of the match (intensity dips, stingers): the connected-node count stays flat', () => {
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.setIntensity(1, true);
    const cs = compiled(SONGS.match);
    const sd = 60 / cs.bpm / 4;
    const passSteps = cs.timeline.reduce((a, si) => a + cs.sections[si]!.steps, 0);
    const headSteps = cs.timeline.slice(0, cs.loopToSlot).reduce((a, si) => a + cs.sections[si]!.steps, 0);
    const pass = passSteps * sd;
    const loop = (passSteps - headSteps) * sd;
    seq.play(cs, 0);
    // sample the same song positions (every 10 s of the loop) in loops 1, 2 and 3. The count swings
    // with the music (which layers and stinger voices are sounding), so compare the loops' averages
    // and peaks: a leak shows up as a steady climb from loop to loop.
    const offs = Array.from({ length: 16 }, (_, i) => 10 + i * 10);
    const at = [0, 1, 2].flatMap((k) => offs.map((o) => 0.08 + pass + k * loop + o));
    const counts: number[] = [];
    let next = 0;
    run(fake, seq, 0, at[at.length - 1]! + 0.05, (t) => {
      // every loop: a low-intensity dip (layers close and detach), then back to full
      const inLoop = (t - 0.08 - pass) % loop;
      seq.setIntensity(inLoop > 20 && inLoop < 32 ? 0 : 1);
      if (Math.abs((t % 7) - 3) < 0.0125) seq.stinger(DEFAULT_STINGERS.levelUp, t);
      while (next < at.length && t >= at[next]!) { counts.push(fake.connected); next++; }
    });
    expect(counts).toHaveLength(at.length);
    const per = [0, 1, 2].map((k) => counts.slice(k * offs.length, (k + 1) * offs.length));
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(per[1]!)).toBeLessThanOrEqual(mean(per[0]!) * 1.08 + 4);
    expect(mean(per[2]!)).toBeLessThanOrEqual(mean(per[0]!) * 1.08 + 4);
    expect(Math.max(...per[2]!)).toBeLessThanOrEqual(Math.max(...per[0]!) + 30);
    expect(fake.live.size, 'sources still running').toBeLessThan(200);
  });

  it('switching songs every 12 s for 4 minutes: retired songs are disposed and the graph stays flat', () => {
    const { fake, ctx } = fakeCtx();
    const seq = new Sequencer(new SynthCore(ctx));
    seq.setIntensity(1, true);
    const order = [SONGS.match, SONGS.boss, SONGS.title, SONGS.command].map(compiled);
    seq.play(order[0]!, 0);
    const samples: number[] = [];
    let k = 0;
    run(fake, seq, 0, 240, (t) => {
      if (t >= (k + 1) * 12) {
        k++;
        seq.play(order[k % order.length]!, t);
      }
      if (Math.abs((t % 12) - 9) < 0.0125) samples.push(fake.connected);
    });
    const third = Math.floor(samples.length / 3);
    const early = Math.max(...samples.slice(0, third));
    const late = Math.max(...samples.slice(-third));
    expect(late).toBeLessThanOrEqual(early + 20);
    // after the last switch has settled, nothing is left retiring
    run(fake, seq, 240.025, 250);
    expect((seq as unknown as { retired: unknown[] }).retired.length).toBe(0);
  });
});

describe('MusicDirector lifecycle', () => {
  const made: FakeContext[] = [];
  const g = globalThis as unknown as { AudioContext?: unknown };
  const orig = g.AudioContext;
  function installFakeAudioContext(): void {
    made.length = 0;
    g.AudioContext = class {
      constructor(opts?: { sampleRate?: number }) {
        const f = new FakeContext(opts?.sampleRate ?? 48000);
        made.push(f);
        return f as unknown as object;
      }
    };
  }
  afterEach(() => {
    g.AudioContext = orig;
    vi.useRealTimers();
  });

  /** Advance the fake audio clock and the fake timers together. */
  function advance(f: FakeContext, seconds: number): void {
    for (let i = 0; i < Math.round(seconds / 0.025); i++) {
      f.currentTime += 0.025;
      vi.advanceTimersByTime(25);
      f.endSources(f.currentTime);
    }
  }

  it('has exactly the specified API (a compile-time shape check), and a no-argument constructor', () => {
    /** The integration contract: constructor(); unlock; setScene; setIntensity; setVolume; setMuted; stingerLevelUp; destroy. */
    interface MusicApi {
      unlock(): void;
      setScene(scene: MusicScene): void;
      setIntensity(x: number): void;
      setVolume(v: number): void;
      setMuted(m: boolean): void;
      stingerLevelUp?(): void;
      destroy(): void;
    }
    const api: MusicApi = new MusicDirector();
    for (const k of ['unlock', 'setScene', 'setIntensity', 'setVolume', 'setMuted', 'stingerLevelUp', 'destroy'] as const) expect(typeof api[k]).toBe('function');
    api.destroy();
  });

  it('makes no AudioContext (and no sound) before unlock(); remembers the scene', () => {
    installFakeAudioContext();
    vi.useFakeTimers();
    const m = new MusicDirector();
    m.setScene('match');
    m.setIntensity(0.7);
    m.setVolume(0.5);
    m.setMuted(false);
    m.stingerLevelUp();
    expect(made).toHaveLength(0);
    expect(m.getAnalyser()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    m.unlock();
    expect(made).toHaveLength(1);
    expect(made[0]!.sampleRate).toBe(32000);
    advance(made[0]!, 1);
    expect(m.getState().song).toBe(SONGS.match.title);
    m.destroy();
  });

  it('a scene change is queued for a bar line of the playing song, then switches', () => {
    installFakeAudioContext();
    vi.useFakeTimers();
    const m = new MusicDirector();
    m.unlock();
    m.setScene('match');
    const f = made[0]!;
    advance(f, 3);
    m.setScene('boss');
    const st = m.getState();
    expect(st.pending).toBe(SONGS.boss.title);
    expect(st.song).toBe(SONGS.match.title);
    const bar = (60 / SONGS.match.bpm) * 4;
    advance(f, bar + 0.6);
    expect(m.getState().song).toBe(SONGS.boss.title);
    expect(m.getState().pending).toBeNull();
    m.destroy();
  });

  it('destroy() clears every timer, closes the context and disconnects the whole graph', () => {
    installFakeAudioContext();
    vi.useFakeTimers();
    const m = new MusicDirector();
    m.unlock();
    m.setScene('title');
    const f = made[0]!;
    m.getAnalyser();
    advance(f, 4);
    m.setMuted(true); // leaves a pending "suspend after the fade" timeout
    m.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.state).toBe('closed');
    f.endSources(Infinity); // sources stopped by dispose() end and disconnect themselves
    expect(f.connected).toBe(0);
    // calls after destroy are ignored
    m.unlock();
    m.setScene('boss');
    m.stingerLevelUp();
    expect(made).toHaveLength(1);
  });
});
