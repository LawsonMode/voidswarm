// Pure-logic tests for the composer toolkit (songs/lib.ts) and the shared leitmotif (songs/themes.ts).
import { describe, expect, it } from 'vitest';
import { parseSteps, resolvePitch, tokenize, type PitchContext } from './compile';
import {
  bassArp, bassGallop, bassOctaves, bassPedal, bassQuarters, bassRiff, eight, firstThen, held, perBar, roll, rollUp, stab, times, tr, transpose,
} from './songs/lib';
import { HOOK_BRASS, HOOK_CHORDS, HOOK_LEAD, HOOK_PAD, HOOK_PICKUP, hookCell, hookCellWide } from './songs/themes';

const D_MINOR: PitchContext = { tonicPc: 2, mode: 'aeolian', octave: 4, voicing: 'fold', transpose: 0 };
const midis = (steps: string, c: PitchContext = D_MINOR): number[] =>
  parseSteps(steps).events.flatMap((e) => resolvePitch(e.p, c));

describe('tr / transpose', () => {
  it('moves note names by semitones (flats for black keys)', () => {
    expect(tr('D2', 12)).toBe('D3');
    expect(tr('A1', 7)).toBe('E2');
    expect(tr('C4', 1)).toBe('Db4');
    expect(tr('Bb1', -5)).toBe('F1');
    expect(() => tr('H2', 1)).toThrow();
  });
  it('transposes notes and chord symbols, keeps rests / holds / flags / bar lines / degrees', () => {
    expect(transpose('@Bb! - . @C/E - | D5~ . 5 b3 C4+E4?', 2)).toBe('@C! - . @D/Gb - | E5~ . 5 b3 D4+Gb4?');
    expect(transpose('@Dm7 @Asus4 @F#m', -5)).toBe('@Am7 @Esus4 @Dbm');
    expect(transpose('A4 - C#5 -', 0)).toBe('A4 - C#5 -');
  });
  it('is pitch-exact: every note moves by exactly the interval, and it round-trips', () => {
    for (const k of [-7, -5, -1, 1, 2, 3, 5, 7]) {
      const moved = midis(transpose(HOOK_LEAD, k));
      expect(moved).toEqual(midis(HOOK_LEAD).map((m) => m + k));
      expect(midis(transpose(transpose(HOOK_LEAD, k), -k))).toEqual(midis(HOOK_LEAD));
    }
    const ch = (s: string): number[] => resolvePitch(s, D_MINOR).map((m) => ((m % 12) + 12) % 12).sort((a, b) => a - b);
    expect(ch(transpose('@F/A', 3))).toEqual(ch('@Ab/C'));
  });
  it('keeps the token count (and so the timing) of any step string', () => {
    for (const s of [HOOK_LEAD, HOOK_BRASS, HOOK_PAD]) expect(tokenize(transpose(s, 5)).length).toBe(tokenize(s).length);
  });
});

describe('bar builders', () => {
  const len = (s: string): number => tokenize(s).length;
  it('every one-bar figure is exactly 16 steps', () => {
    for (const s of [
      bassArp('D2'), bassGallop('A1'), bassOctaves('E1'), bassQuarters('G1'), bassRiff('E1', 'F2', 'G2', 'F2'),
      bassPedal('A1', 'A2 C3 E3 C3 A2 C3 E3 G3'), roll('D4', 'A4', 'D5', 'F5'), rollUp('A4', 'C5', 'E5', 'A5'),
      stab('@Am'), hookCell('D5', 'F5', 'G5'),
    ]) expect(len(s)).toBe(16);
    expect(len(hookCellWide('F5', 'A5', 'B5'))).toBe(32);
    expect(len(perBar('@Am', '@F', '@G'))).toBe(48);
    expect(len(held(['@Asus4', 8], ['@A', 8]))).toBe(16);
  });
  it('bass figures put the named root on the downbeat, accented, and stay on root / octave / fifth', () => {
    const arp = parseSteps(bassArp('D2')).events;
    expect(arp[0]).toMatchObject({ at: 0, p: 'D2', vel: 1 });
    expect(new Set(arp.map((e) => e.p))).toEqual(new Set(['D2', 'D3', 'A2']));
    expect(new Set(parseSteps(bassGallop('A1')).events.map((e) => e.p))).toEqual(new Set(['A1', 'A2']));
    const ped = parseSteps(bassPedal('E1', 'G#2 B2 E3 B2 G#2 B2 D3 B2')).events;
    expect(ped.filter((e) => e.at % 2 === 0).every((e) => e.p === 'E1')).toBe(true);
    expect(() => bassPedal('E1', 'E2 E3')).toThrow();
  });
  it('the hook cell is 3rd-5th-6th-5th-3rd on a tresillo (3+3+4+2+4)', () => {
    const ev = parseSteps(hookCell('D5', 'F5', 'G5')).events;
    expect(ev.map((e) => e.p)).toEqual(['D5', 'F5', 'G5', 'F5', 'D5']);
    expect(ev.map((e) => e.len)).toEqual([3, 3, 4, 2, 4]);
    // augmentation: exactly twice as long, same pitches
    const wide = parseSteps(hookCellWide('D5', 'F5', 'G5')).events;
    expect(wide.map((e) => e.p)).toEqual(['D5', 'F5', 'G5', 'F5', 'D5']);
    expect(wide.map((e) => e.len)).toEqual([6, 6, 8, 4, 8]);
  });
  it('chains', () => {
    expect(times('K', 3)).toEqual(['K', 'K', 'K']);
    expect(eight('G', 'F')).toEqual(['G', 'G', 'G', 'G', 'G', 'G', 'G', 'F']);
    expect(firstThen('CR', 'R', 4)).toEqual(['CR', 'R', 'R', 'R']);
  });
});

describe('the hook (themes.ts)', () => {
  it('is 8 bars over VI – VII – i – V | VI – VII – V – i and every bar opens on a chord tone', () => {
    expect(tokenize(HOOK_LEAD).length).toBe(128);
    expect(HOOK_CHORDS).toEqual(['@Bb', '@C', '@Dm', '@A', '@Bb', '@C', '@A', '@Dm']);
    const ev = parseSteps(HOOK_LEAD).events;
    HOOK_CHORDS.forEach((ch, bar) => {
      const first = ev.find((e) => e.at === bar * 16)!;
      const tones = new Set(resolvePitch(ch, D_MINOR).map((m) => m % 12));
      expect(tones.has(resolvePitch(first.p, D_MINOR)[0]! % 12), `bar ${bar + 1}`).toBe(true);
    });
  });
  it('the pickup ends on the leading tone, a semitone under the hook\'s first note', () => {
    const pick = midis(HOOK_PICKUP);
    expect(midis(HOOK_LEAD)[0]! - pick[pick.length - 1]!).toBe(1);
  });
});
