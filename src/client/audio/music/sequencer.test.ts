// Drives the REAL SongPlayer / Sequencer against a fake AudioContext and checks when notes are
// scheduled: grid accuracy over a long run, the lookahead window, intensity layers, bar-quantized
// song transitions and stinger quantization. (In node there is no OfflineAudioContext, so the
// drum bank never becomes ready and the live drum synths are used, which is also what we want here.)
import { describe, expect, it } from 'vitest';
import { compileSong, type CompiledSong } from './compile';
import { hold, rep, type Song } from './format';
import { Sequencer } from './sequencer';
import { DEFAULT_STINGERS } from './songs/stingers';
import { SynthCore } from './synth';
import { fakeCtx, type FakeContext } from './testing/fakeAudio';
import { stepDur } from './timing';

const KICK_F0 = 420; // Kick's first sweep frequency identifies kick oscillators

function kickSong(bpm: number, extra: Partial<Song> = {}): Song {
  return {
    title: `kick ${bpm}`,
    bpm,
    key: 'A',
    mode: 'aeolian',
    tracks: [{ id: 'kick', inst: 'kick' }, { id: 'pad', inst: 'pad' }],
    patterns: { k: 'x . . . x . . . x . . . x . . .', p: hold('@Am', 16) },
    sections: { a: { bars: 2, play: { kick: 'k', pad: 'p' } } },
    form: ['a'],
    ...extra,
  };
}

function compiled(s: Song): CompiledSong {
  const r = compileSong(s);
  expect(r.errors).toEqual([]);
  return r.compiled!;
}

/** Run the clock like the director does: pump every `tick` seconds of audio time. */
function run(fake: FakeContext, seq: Sequencer, from: number, to: number, tick = 0.025, onTick?: (t: number) => void): void {
  for (let t = from; t <= to + 1e-9; t += tick) {
    fake.currentTime = t;
    onTick?.(t);
    seq.pump(t);
  }
}

function kicks(fake: FakeContext): number[] {
  return fake.starts.filter((s) => s.kind === 'osc' && s.freq0 === KICK_F0).map((s) => s.t);
}

function setup(): { fake: FakeContext; seq: Sequencer } {
  const { fake, ctx } = fakeCtx();
  const core = new SynthCore(ctx);
  return { fake, seq: new Sequencer(core) };
}

describe('sequencer timing', () => {
  it('kicks land exactly on the beat grid for 3 minutes (no drift, no gaps, no duplicates)', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    seq.play(compiled(kickSong(150)), 0);
    const origin = 0.08;
    run(fake, seq, 0, 180);
    const ks = kicks(fake);
    const beat = 60 / 150;
    expect(ks.length).toBeGreaterThan(440);
    ks.forEach((t, i) => expect(Math.abs(t - (origin + i * beat))).toBeLessThan(1e-9));
  });

  it('never schedules more than the lookahead ahead of the clock', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    seq.play(compiled(kickSong(137)), 0);
    let worst = 0;
    run(fake, seq, 0, 30, 0.025, (now) => {
      for (const s of fake.starts) worst = Math.max(worst, s.t - now);
    });
    expect(worst).toBeLessThanOrEqual(seq.lookahead + 0.025 + stepDur(137) + 1e-9);
  });

  it('intensity layers: 0 plays pads only, 1 adds the drums (switching on bar lines)', () => {
    const { fake, seq } = setup();
    seq.setIntensity(0, true);
    seq.play(compiled(kickSong(120)), 0);
    run(fake, seq, 0, 6);
    expect(kicks(fake)).toEqual([]);
    expect(fake.starts.filter((s) => s.kind === 'buffer').length).toBeGreaterThan(0); // pad chord loops
    seq.setIntensity(1, true);
    run(fake, seq, 6.025, 14);
    const ks = kicks(fake);
    expect(ks.length).toBeGreaterThan(8);
    // the first kick after the change is on a bar line (bar = 2 s at 120 bpm, origin 0.08)
    const bar = (ks[0]! - 0.08) / 2;
    expect(Math.abs(bar - Math.round(bar))).toBeLessThan(1e-9);
  });

  it('a song change lands on a bar line of the old song, at least one beat ahead', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    const a = compiled(kickSong(150));
    const b = compiled(kickSong(100, { title: 'B' }));
    seq.play(a, 0);
    run(fake, seq, 0, 2.1);
    seq.play(b, 2.1);
    run(fake, seq, 2.125, 9);
    const ks = kicks(fake);
    const barA = 1.6;
    const beatA = 0.4;
    // earliest allowed: now + 1 beat + lookahead margin → first A bar line after that
    const minT = 2.1 + beatA + seq.lookahead + 0.06;
    const T = 0.08 + Math.ceil((minT - 0.08) / barA) * barA;
    expect(T).toBeCloseTo(3.28, 9);
    const before = ks.filter((t) => t < T - 1e-9);
    const after = ks.filter((t) => t >= T - 1e-9);
    // old song: on its own grid, and silent during the fill beat before T
    for (const t of before) expect(Math.abs((t - 0.08) / beatA - Math.round((t - 0.08) / beatA))).toBeLessThan(1e-9);
    expect(Math.max(...before)).toBeLessThanOrEqual(T - beatA + 1e-9);
    // new song: starts exactly at T on its own grid (100 bpm → 0.6 s beats)
    expect(after[0]).toBeCloseTo(T, 9);
    after.forEach((t, i) => expect(Math.abs(t - (T + i * 0.6))).toBeLessThan(1e-9));
    expect(seq.currentSong?.song.title).toBe('B');
  });

  it('re-requesting the playing song cancels a pending transition', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    const a = compiled(kickSong(150));
    const b = compiled(kickSong(100, { title: 'B' }));
    seq.play(a, 0);
    run(fake, seq, 0, 2.1);
    seq.play(b, 2.1);
    expect(seq.pendingSong?.song.title).toBe('B');
    seq.play(a, 2.12);
    expect(seq.pendingSong).toBeNull();
    run(fake, seq, 2.125, 8);
    const ks = kicks(fake);
    ks.forEach((t, i) => expect(Math.abs(t - (0.08 + i * 0.4))).toBeLessThan(1e-9)); // A never stopped
    expect(seq.currentSong?.song.title).toBe(a.song.title);
  });

  it('non-looping songs end, and the next request starts immediately', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    const once = compiled(kickSong(120, { loop: false, title: 'once' }));
    seq.play(once, 0);
    run(fake, seq, 0, 7);
    expect(kicks(fake).length).toBe(8); // 2 bars
    expect(seq.isPlaying(7)).toBe(false);
    seq.play(compiled(kickSong(150, { title: 'next' })), 7);
    run(fake, seq, 7.025, 8);
    expect(kicks(fake)[8]).toBeCloseTo(7.08, 9);
  });

  it('stingers wait for the next 16th of the playing song', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    const song = compiled({ ...kickSong(128), patterns: { k: rep('x . . .', 4), p: hold('@Am', 16) } });
    seq.play(song, 0);
    run(fake, seq, 0, 3.013);
    const n0 = fake.starts.length;
    seq.stinger(DEFAULT_STINGERS.levelUp, 3.013);
    const added = fake.starts.slice(n0).filter((s) => s.kind === 'osc' && s.freq0 !== KICK_F0);
    expect(added.length).toBeGreaterThan(0);
    const sd = stepDur(128);
    const first = Math.min(...added.map((s) => s.t));
    const k = (first - 0.08) / sd;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    expect(first).toBeGreaterThanOrEqual(3.013);
  });

  it('muted (silent) keeps time but creates no notes', () => {
    const { fake, seq } = setup();
    seq.setIntensity(1, true);
    seq.silent = true;
    seq.play(compiled(kickSong(150)), 0);
    run(fake, seq, 0, 4);
    // only the always-running modulation LFOs (reverb wobble, pad chorus: < 1 Hz) have started
    expect(fake.starts.filter((s) => s.kind === 'buffer' || s.freq0 > 1).length).toBe(0);
    seq.silent = false;
    run(fake, seq, 4.025, 6);
    const ks = kicks(fake);
    expect(ks.length).toBeGreaterThan(0);
    ks.forEach((t) => expect(Math.abs((t - 0.08) / 0.4 - Math.round((t - 0.08) / 0.4))).toBeLessThan(1e-9));
  });
});
