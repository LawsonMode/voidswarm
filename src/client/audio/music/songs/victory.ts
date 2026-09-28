/**
 * "VICTORY" (one-shot stinger, plays once). ORIGINAL composition for Voidswarm.
 * A · 132 bpm · 5 bars ≈ 9 s. The aeolian lift bVI – bVII – I: the match's A minor turns into
 * A MAJOR (a picardy-style resolution), then a plagal IV – I "amen" under a held major 3rd.
 * The lead states the hook cell (themes.ts) three times, rising by step; the third time, over A
 * major, its 6th is the bright F#: the minor-key theme has won.
 *
 *   bar 1  F     hook cell on A (brass doubles the tresillo)
 *   bar 2  G     hook cell on B
 *   bar 3  A     hook cell on C#, major 6th F# on top; tom run
 *   bar 4  D/A   F# – E – D over the plagal IV (A pedal)
 *   bar 5  A     the major 3rd C# held; crash, kick, the brass rings out
 */
import type { Song } from '../format';
import { bassGallop, held, perBar, rest, rollUp, seq } from './lib';
import { hookCell } from './themes';

export const VICTORY: Song = {
  title: 'Victory',
  bpm: 132,
  timeSig: '4/4',
  key: 'A',
  mode: 'aeolian',
  loop: false,
  transition: 'fill',
  intensity: { min: 1, max: 1 },
  delay: { time: '8d', feedback: 0.3 },
  reverb: { decay: 2.8 },
  tracks: [
    { id: 'pad', inst: 'pad', octave: 4, layer: 'base' },
    { id: 'bass', inst: 'bass', layer: 'base' },
    { id: 'brass', inst: 'brass', octave: 4, layer: 'base' },
    { id: 'lead', inst: 'lead', layer: 'base', tone: { vibrato: 20, vibratoDelay: 0.2 } },
    { id: 'arp', inst: 'arp', layer: 'base', pan: 0.3, gain: 0.85 },
    { id: 'kick', inst: 'kick', layer: 'base' },
    { id: 'snare', inst: 'snare', layer: 'base' },
    { id: 'tom', inst: 'tom', layer: 'base' },
    { id: 'crash', inst: 'crash', layer: 'base' },
  ],
  patterns: {
    pad: perBar('@F', '@G', '@A', '@D/A', '@A'),
    bass: seq(bassGallop('F1'), bassGallop('G1'), bassGallop('A1'), 'A1! - - A1 - - A1 - A1 - - - A1 - - -', held(['A1!', 16])),
    brass: seq(
      '@F! - - @F - - @F - - - @F - @F - - -',
      '@G! - - @G - - @G - - - @G - @G - - -',
      '@A! - - @A - - @A - - - @A - @A - - -',
      '@D/A! - - - - - - - @D/A - - - - - - -',
      '@A! - - - - - - - - - - - - - - -',
    ),
    lead: seq(
      hookCell('A5', 'C6', 'D6'), //   F
      hookCell('B5', 'D6', 'E6'), //   G
      hookCell('C#6', 'E6', 'F#6'), // A (major: the bright 6th)
      'F#6 - - - - - - - E6 - - - D6 - - -', // D/A
      'C#6 - - - - - - - - - - - - - - -', //   A
    ),
    arp: seq(rollUp('F4', 'A4', 'C5', 'F5'), rollUp('G4', 'B4', 'D5', 'G5'), rollUp('A4', 'C#5', 'E5', 'A5'), rollUp('A4', 'D5', 'F#5', 'A5'), rest(16)),
    kick: seq('x . . x . . x . x . . . x . . .', 'x . . x . . x . x . . . x . . .', 'x . . x . . x . x . . . x . . .', 'x . . . x . . . x . . . x . . .', 'X . . . . . . . . . . . . . . .'),
    snare: seq('. . . . X . . . . . . . X . . .', '. . . . X . . . . . . . X . . .', '. . . . X . . . . . . . X . . .', 'x x x x x x x x X X X X . . . .', 'X . . . . . . . . . . . . . . .'),
    tom: seq(rest(32), '. . . . . . . . . . . . h m l f', '. . . . . . . . . . . . h h m f', rest(16)),
    crash: seq('X . . . . . . . . . . . . . . .', rest(48), 'X . . . . . . . . . . . . . . .'),
  },
  sections: {
    fanfare: {
      bars: 5, kind: 'outro',
      play: { pad: 'pad', bass: 'bass', brass: 'brass', lead: 'lead', arp: 'arp', kick: 'kick', snare: 'snare', tom: 'tom', crash: 'crash' },
    },
  },
  form: ['fanfare'],
};
