import { describe, expect, it } from 'vitest';
import { chromaticNotes, compileSong, maxPolyphony, parsePattern, parseSteps, resolveDrum, resolvePitch, timelineSteps, type PitchContext } from './compile';
import { hold, rep, rest, seq, type Song } from './format';

const A_MINOR: PitchContext = { tonicPc: 9, mode: 'aeolian', octave: 4, voicing: 'fold', transpose: 0 };

describe('step strings', () => {
  it('one token per 16th; holds extend; rests and bar lines', () => {
    const p = parseSteps('C4 - - . | E4! . G4? -');
    expect(p.length).toBe(8);
    expect(p.events).toEqual([
      { at: 0, p: 'C4', len: 3, vel: 0.8, glide: false },
      { at: 4, p: 'E4', len: 1, vel: 1, glide: false },
      { at: 6, p: 'G4', len: 2, vel: 0.5, glide: false },
    ]);
    expect(p.errors).toEqual([]);
  });
  it('glide flag and combined flags', () => {
    const p = parseSteps('A4 B4~ C5!~');
    expect(p.events.map((e) => e.glide)).toEqual([false, true, true]);
    expect(p.events[2]!.vel).toBe(1);
  });
  it('a hold after a rest warns; flags without a pitch error', () => {
    expect(parseSteps('. - C4').warnings.length).toBe(1);
    expect(parseSteps('! C4').errors.length).toBe(1);
  });
  it("drum lanes: '-' is a rest, X/O accent", () => {
    const p = parseSteps('x - X . o O', true);
    expect(p.events.map((e) => [e.at, e.p, e.vel])).toEqual([[0, 'x', 0.8], [2, 'X', 1], [4, 'o', 0.8], [5, 'O', 1]]);
  });
  it('PatternDef: explicit notes, fractional starts, default length rounds to a bar', () => {
    const p = parsePattern({ notes: [{ at: 0, p: 'A4', len: 2 }, { at: 16.5, p: 69 }] });
    expect(p.length).toBe(32);
    expect(p.events[1]!.at).toBe(16.5);
    expect(parsePattern({ notes: [{ at: 1, p: 'A4' }], length: 0 }).errors.length).toBeGreaterThan(0);
  });
  it('helpers', () => {
    expect(rep('A1 A2', 2)).toBe('A1 A2 A1 A2');
    expect(hold('@Am', 4)).toBe('@Am - - -');
    expect(rest(3)).toBe('. . .');
    expect(seq(' a ', 'b')).toBe('a b');
  });
});

describe('pitch resolution', () => {
  it('note names, octave-less names, MIDI numbers, transpose', () => {
    expect(resolvePitch('C4', A_MINOR)).toEqual([60]);
    expect(resolvePitch('Bb', A_MINOR)).toEqual([70]);
    expect(resolvePitch(64, { ...A_MINOR, transpose: 2 })).toEqual([66]);
    expect(resolvePitch('C4', { ...A_MINOR, transpose: -1 })).toEqual([59]);
  });
  it('degrees in key + mode from the track octave', () => {
    expect(resolvePitch('1', A_MINOR)).toEqual([69]);
    expect(resolvePitch('5_', A_MINOR)).toEqual([64]);
    expect(resolvePitch('#7', A_MINOR)).toEqual([80]);
    expect(resolvePitch('b3', { ...A_MINOR, mode: 'ionian' })).toEqual([72]);
    expect(resolvePitch('1^^', A_MINOR)).toEqual([93]);
  });
  it("chords: '+' joins and '@' symbols", () => {
    expect(resolvePitch('1+3+5', A_MINOR)).toEqual([69, 72, 76]);
    expect(resolvePitch('A3+C4+E4', A_MINOR)).toEqual([57, 60, 64]);
    expect(resolvePitch('@Am', A_MINOR)).toEqual([60, 64, 69]);
    expect(resolvePitch('@Am', { ...A_MINOR, transpose: 2 })).toEqual([62, 66, 71]);
    expect(resolvePitch(['C4', 'E4', 'C4'], A_MINOR)).toEqual([60, 64]);
  });
  it('rejects bad tokens with a message', () => {
    for (const s of ['Q4', 'c4', '0', '@Xm', 'C4+', 'x', '1~^']) expect(() => resolvePitch(s, A_MINOR)).toThrow();
  });
  it('drum tokens per instrument', () => {
    expect(resolveDrum('x', 'kick')).toBe('x');
    expect(resolveDrum('o', 'hat')).toBe('o');
    expect(resolveDrum('x', 'ohat')).toBe('o');
    expect(resolveDrum('h', 'tom')).toBe('h');
    expect(resolveDrum('x', 'tom')).toBe('m');
    expect(() => resolveDrum('o', 'kick')).toThrow();
    expect(() => resolveDrum('C4', 'snare')).toThrow();
  });
});

function tiny(over: Partial<Song> = {}): Song {
  return {
    title: 'Tiny',
    bpm: 120,
    key: 'A',
    mode: 'aeolian',
    tracks: [
      { id: 'bass', inst: 'bass', octave: 1 },
      { id: 'pad', inst: 'pad' },
      { id: 'kick', inst: 'kick' },
    ],
    patterns: {
      b1: 'A1 . A2 .',
      b2: 'F1 . F2 .',
      pad: hold('@Am', 16),
      kick: 'x . . . x . . . x . . . x . . .',
    },
    sections: {
      verse: { bars: 2, play: { bass: ['b1', 'b2'], pad: 'pad', kick: 'kick' } },
      final: { bars: 1, transpose: 2, play: { bass: 'b1', pad: 'pad' } },
    },
    form: [{ section: 'verse', repeat: 2 }, 'final'],
    loopTo: 0,
    ...over,
  };
}

describe('compileSong', () => {
  it('tiles chains to fill the section and expands the form', () => {
    const r = compileSong(tiny());
    expect(r.errors).toEqual([]);
    const cs = r.compiled!;
    expect(cs.timeline).toEqual([0, 0, 1]);
    expect(timelineSteps(cs)).toBe(16 * 5);
    const verse = cs.sections[0]!;
    const bass = verse.events[0]!;
    // chain b1 (4 steps) + b2 (4 steps) looped over 32 steps
    const starts = bass.map((e, i) => (e ? `${i}:${e[0]!.midi[0]}` : null)).filter(Boolean);
    expect(starts.slice(0, 4)).toEqual(['0:33', '2:45', '4:29', '6:41']);
    expect(starts.length).toBe(16);
    expect(verse.events[2]!.filter(Boolean).length).toBe(8); // 8 kicks in 2 bars
  });
  it('applies section transpose to pitched tracks only', () => {
    const cs = compileSong(tiny()).compiled!;
    const fin = cs.sections[1]!;
    expect(fin.events[0]![0]![0]!.midi).toEqual([35]); // A1 + 2 = B1
    expect(fin.events[1]![0]![0]!.midi).toEqual([62, 66, 71]); // Am + 2 = Bm (fold)
  });
  it('reports structural errors', () => {
    const bad = compileSong(tiny({
      sections: { verse: { bars: 2, play: { bass: 'nope', ghost: 'b1', kick: 'b1' } } },
      form: ['verse', 'missing'],
    }));
    expect(bad.compiled).toBeNull();
    const all = bad.errors.join('\n');
    expect(all).toMatch(/unknown pattern "nope"/);
    expect(all).toMatch(/unknown track "ghost"/);
    expect(all).toMatch(/bad kick token "A1"/);
    expect(all).toMatch(/unknown section "missing"/);
  });
  it('rejects bad song-level values', () => {
    expect(compileSong(tiny({ bpm: 400 })).errors.join()).toMatch(/bpm/);
    expect(compileSong(tiny({ key: 'H' })).errors.join()).toMatch(/key/);
    expect(compileSong(tiny({ loopTo: 5 })).errors.join()).toMatch(/loopTo/);
    expect(compileSong(tiny({ intensity: { min: 0.8, max: 0.2 } })).errors.join()).toMatch(/intensity/);
    expect(compileSong(tiny({ fill: { tom: 'q q' } })).errors.join()).toMatch(/fill\.tom/);
  });
  it('warns on mono chords, ranges and chain-length mismatches', () => {
    const r = compileSong(tiny({
      patterns: { b1: '@Am . . .', b2: 'C7 . .', pad: hold('@Am', 16), kick: 'x' },
      sections: { verse: { bars: 1, play: { bass: ['b1', 'b2'], pad: 'pad', kick: 'kick' } } },
      form: ['verse'],
    }));
    expect(r.errors).toEqual([]);
    const w = r.warnings.join('\n');
    expect(w).toMatch(/chord on mono bass/);
    expect(w).toMatch(/outside the sensible range/);
    expect(w).toMatch(/doesn't divide/);
    // only the lowest chord tone survives on a mono track
    expect(r.compiled!.sections[0]!.events[0]![0]![0]!.midi.length).toBe(1);
  });
  it('theory check: chromatic notes are listed (harmonic-minor V in aeolian)', () => {
    const cs = compileSong(tiny({
      patterns: { b1: 'A1', b2: 'E1', pad: seq(hold('@Am', 8), hold('@E', 8)), kick: 'x' },
    })).compiled!;
    const chrom = chromaticNotes(cs);
    expect(chrom.length).toBeGreaterThan(0);
    expect(chrom.every((c) => c.midi % 12 === 8 || c.midi % 12 === 10)).toBe(true); // G# (and A#=G#+2 in the transposed final)
  });
  it('polyphony analysis counts simultaneous chord tones', () => {
    const cs = compileSong(tiny()).compiled!;
    expect(maxPolyphony(cs, cs.sections[0]!)).toBe(4); // 3 pad + 1 mono bass
    const heavy = compileSong(tiny({
      tracks: [{ id: 'p1', inst: 'pad' }, { id: 'p2', inst: 'pad', octave: 5 }, { id: 'p3', inst: 'brass' }, { id: 'p4', inst: 'bell' }, { id: 'p5', inst: 'pluck' }, { id: 'p6', inst: 'arp' }, { id: 'p7', inst: 'pad', octave: 3 }],
      patterns: { c: hold('@Am9', 16) },
      sections: { s: { bars: 1, play: { p1: 'c', p2: 'c', p3: 'c', p4: 'c', p5: 'c', p6: 'c', p7: 'c' } } },
      form: ['s'],
    }));
    expect(heavy.warnings.join()).toMatch(/simultaneous notes/);
  });
});
