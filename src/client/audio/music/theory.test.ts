import { describe, expect, it } from 'vitest';
import {
  chordTriad, degreeToMidi, midiToFreq, midiToName, parseChordSymbol, parseNoteName, parsePitchClass, scalePcs, snapToPcs, voiceChord,
} from './theory';

describe('note names', () => {
  it('parses scientific pitch (C4 = 60)', () => {
    expect(parseNoteName('C4')).toBe(60);
    expect(parseNoteName('A4')).toBe(69);
    expect(parseNoteName('Eb3')).toBe(51);
    expect(parseNoteName('F#2')).toBe(42);
    expect(parseNoteName('B#3')).toBe(60);
    expect(parseNoteName('Cb4')).toBe(59);
    expect(parseNoteName('A0')).toBe(21);
  });
  it('uses the default octave when none is given', () => {
    expect(parseNoteName('Bb', 3)).toBe(58);
    expect(parseNoteName('Bb')).toBeNull();
  });
  it('rejects malformed names', () => {
    for (const s of ['H4', 'c4', 'C##4', 'C-1', '', 'Cx']) expect(parseNoteName(s, 4)).toBeNull();
  });
  it('pitch classes', () => {
    expect(parsePitchClass('A')).toBe(9);
    expect(parsePitchClass('C#')).toBe(1);
    expect(parsePitchClass('Db')).toBe(1);
    expect(parsePitchClass('Cb')).toBe(11);
    expect(parsePitchClass('a')).toBeNull();
  });
  it('frequency + names', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(midiToFreq(81)).toBeCloseTo(880, 6);
    expect(midiToName(61)).toBe('C#4');
    expect(midiToName(61, true)).toBe('Db4');
  });
});

describe('scale degrees', () => {
  it('degree 1 at the base octave is the tonic in that octave', () => {
    expect(degreeToMidi(1, 0, 0, 9, 'aeolian', 2)).toBe(45); // A2
    expect(degreeToMidi(1, 0, 0, 0, 'ionian', 4)).toBe(60); // C4
  });
  it('walks the mode and wraps past 7', () => {
    const aMinor = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => degreeToMidi(d, 0, 0, 9, 'aeolian', 4));
    expect(aMinor).toEqual([69, 71, 72, 74, 76, 77, 79, 81]);
    expect(degreeToMidi(10, 0, 0, 9, 'aeolian', 4)).toBe(84); // 3rd an octave up = C6
  });
  it('harmonic minor raises the 7th; accidentals and octave shifts apply', () => {
    expect(degreeToMidi(7, 0, 0, 9, 'harmonicMinor', 4)).toBe(80); // G#5
    expect(degreeToMidi(7, 1, 0, 9, 'aeolian', 4)).toBe(80); // #7 in aeolian = G#5
    expect(degreeToMidi(3, -1, 0, 0, 'ionian', 4)).toBe(63); // b3 in C = Eb4
    expect(degreeToMidi(5, 0, -1, 9, 'aeolian', 4)).toBe(64); // 5_ = E4
    expect(degreeToMidi(3, 0, 0, 2, 'dorian', 3)).toBe(53); // D dorian: 3rd = F3
  });
  it('scalePcs', () => {
    expect([...scalePcs(9, 'aeolian')].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePcs(9, 'harmonicMinor').has(8)).toBe(true);
    expect(scalePcs(9, 'harmonicMinor').has(7)).toBe(false);
  });
});

describe('chord symbols', () => {
  it('parses roots, qualities and slash basses', () => {
    expect(parseChordSymbol('@Am')).toEqual({ rootPc: 9, intervals: [0, 3, 7], bassPc: null });
    expect(parseChordSymbol('Bbmaj7')?.rootPc).toBe(10);
    expect(parseChordSymbol('Bbmaj7')?.intervals).toEqual([0, 4, 7, 11]);
    expect(parseChordSymbol('@Bm')?.rootPc).toBe(11);
    expect(parseChordSymbol('@F/A')?.bassPc).toBe(9);
    expect(parseChordSymbol('@Esus4')?.intervals).toEqual([0, 5, 7]);
    expect(parseChordSymbol('@G5')?.intervals).toEqual([0, 7]);
  });
  it('rejects unknown qualities', () => {
    expect(parseChordSymbol('@Amfoo')).toBeNull();
    expect(parseChordSymbol('@H')).toBeNull();
    expect(parseChordSymbol('@F/Q')).toBeNull();
  });
  it('fold voicing keeps every tone in one octave window (smooth voice-leading)', () => {
    expect(voiceChord(parseChordSymbol('Am')!, 4)).toEqual([60, 64, 69]); // C4 E4 A4
    expect(voiceChord(parseChordSymbol('F')!, 4)).toEqual([60, 65, 69]); // C4 F4 A4
    expect(voiceChord(parseChordSymbol('G')!, 4)).toEqual([62, 67, 71]); // D4 G4 B4
    expect(voiceChord(parseChordSymbol('E')!, 4)).toEqual([64, 68, 71]); // E4 G#4 B4
    for (const c of ['Am', 'F', 'G', 'E', 'Dm7', 'Cmaj7']) {
      for (const m of voiceChord(parseChordSymbol(c)!, 4)) { expect(m).toBeGreaterThanOrEqual(60); expect(m).toBeLessThan(72); }
    }
  });
  it('root voicing stacks from the root; slash bass goes below', () => {
    expect(voiceChord(parseChordSymbol('Am')!, 4, 'root')).toEqual([69, 72, 76]);
    expect(voiceChord(parseChordSymbol('F/A')!, 4)).toEqual([57, 60, 65, 69]);
  });
});

describe('fitting stingers to a chord', () => {
  const n = (...names: string[]): number[] => names.map((x) => parseNoteName(x)!);
  it('chordTriad finds the triad of plain, inverted, rootless and slash voicings', () => {
    expect(chordTriad(n('D4', 'F4', 'Bb4'))).toEqual({ root: 10, minor: false }); // Bb/D (folded)
    expect(chordTriad(n('A3', 'D4', 'F4'))).toEqual({ root: 2, minor: true }); // Dm, 2nd inversion
    expect(chordTriad(n('C#4', 'E4', 'A4'))).toEqual({ root: 9, minor: false }); // A major
    // rootless Dm9 (F A C E) over a D bass is D minor; without the bass it reads as F major (a subset)
    expect(chordTriad(n('F3', 'A3', 'C4', 'E4'), parseNoteName('D2'))).toEqual({ root: 2, minor: true });
    expect(chordTriad(n('F3', 'A3', 'C4', 'E4'))).toEqual({ root: 5, minor: false });
    // the boss's bitonal F/E (E3 C4 F4 A4): F major sits in it
    expect(chordTriad(n('E3', 'C4', 'F4', 'A4'), parseNoteName('E1'))).toEqual({ root: 5, minor: false });
  });
  it('chordTriad returns null when there is no plain triad', () => {
    expect(chordTriad(n('D4', 'E4', 'A4'))).toBeNull(); // Asus4
    expect(chordTriad(n('A3', 'D4', 'E4', 'G4'))).toBeNull(); // A7sus4
    expect(chordTriad(n('C4', 'Eb4', 'Gb4'))).toBeNull(); // dim
    expect(chordTriad([])).toBeNull();
  });
  it('snapToPcs moves a non-chord tone to the nearest chord tone (down first), else leaves it', () => {
    const asus = new Set([9, 2, 4]); // A D E
    expect(snapToPcs(parseNoteName('F5')!, asus)).toBe(parseNoteName('E5')); // the minor 3rd → the sus 2nd/9th below
    expect(snapToPcs(parseNoteName('A5')!, asus)).toBe(parseNoteName('A5'));
    expect(snapToPcs(parseNoteName('C#5')!, asus)).toBe(parseNoteName('D5'));
    expect(snapToPcs(60, new Set([6]))).toBe(60); // nothing within a whole step
    expect(snapToPcs(60, new Set())).toBe(60);
  });
});
