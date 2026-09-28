/**
 * "COMMAND DECK" (lobby / planning loop). ORIGINAL composition for Voidswarm.
 * D dorian (the raised 6th, B natural, keeps it moody but not tragic) · 100 bpm · loops every
 * 32 bars (≈ 77 s). Lush explicit pad voicings, a dotted-8th pluck sequence in the ping-pong delay,
 * slow bell counter-melody, light drums. The lead motif is the title hook cell in AUGMENTATION
 * (twice as slow, same 3-5-6-5-3 shape, dorian colour), so the lobby quietly states the theme.
 *
 * FORM (32 bars, loops to the top)
 *   A   8  pads, sparse bass, bell, hats: the ebb                Dm9 | G6 | Fmaj9 | Em7 A7sus4
 *   B   8  + pulse bass, pluck sequence, light drums, the motif (hookCellWide)
 *   A2  8  the motif's answer: it climbs to C6/D6, then the cell lands on the 3rd of Fmaj9
 *   C   8  VI – VII – i (the title chorus harmony) with synth-brass swells, then the dominant
 *          A7 (harmonic-minor C#) pulls back to Dm9 at the top    Bbadd9 | C6 | Dm7 | A7sus4 A7
 * Under the motif (B, A2) the Dm9 bars are voiced as Dm7 (no E below the lead's F5).
 * INTENSITY {0.5 .. 0.9}: at the default game value (0.5) everything but the brass plays; at 0 the
 * motif and bell-pluck colour drop; near 1 (e.g. a match countdown) the brass swells and crash join.
 */
import type { Song, TrackDef } from '../format';
import { eight, firstThen, held, rest, seq, times, tr, transpose } from './lib';
import { hookCellWide } from './themes';

const TRACKS: readonly TrackDef[] = [
  { id: 'pad', inst: 'pad', layer: 'base', reverb: 0.42 },
  { id: 'bass', inst: 'bass', layer: 'base', tone: { cutoff: 150, envAmount: 1500, decay: 0.24, sustain: 0.55 } },
  { id: 'bell', inst: 'bell', layer: 'base', pan: -0.3, gain: 0.85 },
  { id: 'hat', inst: 'hat', layer: 'pulse', gain: 0.7 },
  { id: 'kick', inst: 'kick', layer: 'drums', gain: 0.85 },
  { id: 'clap', inst: 'clap', layer: 'drums', gain: 0.6 },
  { id: 'tom', inst: 'tom', layer: 'groove', gain: 0.7 },
  { id: 'pluck', inst: 'pluck', layer: 'groove', pan: 0.28, gain: 0.85, delay: 0.36 },
  { id: 'lead', inst: 'lead', layer: 'color', gain: 0.8, tone: { cutoff: 1700, attack: 0.03, vibrato: 22, vibratoDelay: 0.38, glide: 0.14 } },
  { id: 'brass', inst: 'brass', layer: 'hero', gain: 0.75, tone: { attack: 0.08, cutoff: 360 } },
  { id: 'crash', inst: 'crash', layer: 'peak', gain: 0.8 },
];

// Pad voicings (4 notes, voice-led, F3..A4 so the lead has the octave above to itself).
const V = {
  Dm9: 'F3+A3+C4+E4',
  G6: 'G3+B3+D4+E4',
  Fmaj9: 'A3+C4+E4+G4',
  Em7: 'B3+D4+E4+G4',
  A7sus4: 'A3+D4+E4+G4',
  C6: 'C4+E4+G4+A4',
  Dm7: 'A3+C4+D4+F4',
  A7: 'A3+C#4+E4+G4',
  // Under the lead (B, A2) Dm9 loses its 9th: the motif starts on F5, a minor 9th above the pad's E4
  Dm7F: 'F3+A3+C4+D4',
  // Section C: Bb with an added 9th instead of the major 7th, so the pluck's Bb4 (and the brass)
  // no longer sit a semitone above the pad's A4
  Bbadd9: 'Bb3+D4+F4+C5',
};

/** Moody dotted pulse: hits on 1, 1-e-and, 2-and (octave), 3, 3-e-and, 4-and (octave). */
function pulse(root: string): string {
  const o = tr(root, 12);
  return `${root}! - . ${root} . . ${o} . ${root} - . ${root} . . ${o} .`;
}
/** Sparse: a long root and an octave pickup. */
function sparse(root: string): string {
  const o = tr(root, 12);
  return `${root} - - - - - - - ${root} - - - - - ${o} -`;
}
/** Pluck sequence (8ths; the dotted-8th delay fills the gaps). */
function seqPluck(a: string, b: string, c: string, d: string): string {
  return `${a} . ${b} . ${c} . ${a} . ${b} . ${c} . ${d} . ${c} .`;
}

const ROOTS_A = ['D2', 'D2', 'G2', 'G2', 'F2', 'F2', 'E2', 'A1'] as const;
const ROOTS_C = ['Bb1', 'Bb1', 'C2', 'C2', 'D2', 'D2', 'A1', 'A1'] as const;

const PLUCK_A = seq(
  seqPluck('D5', 'F5', 'A5', 'E5'), seqPluck('D5', 'F5', 'A5', 'C6'),
  seqPluck('D5', 'G5', 'B5', 'E5'), seqPluck('D5', 'G5', 'B5', 'A5'),
  seqPluck('C5', 'G5', 'A5', 'E5'), seqPluck('C5', 'E5', 'A5', 'G5'), // (no F: the pad's Fmaj9 has E4)
  seqPluck('B4', 'E5', 'G5', 'D5'), seqPluck('A4', 'D5', 'E5', 'G5'),
);
const PLUCK_C = seq(
  seqPluck('Bb4', 'D5', 'F5', 'A5'), seqPluck('Bb4', 'D5', 'A5', 'F5'),
  seqPluck('C5', 'E5', 'G5', 'A5'), seqPluck('C5', 'G5', 'A5', 'E5'),
  seqPluck('D5', 'F5', 'A5', 'C6'), seqPluck('D5', 'A5', 'C6', 'F5'),
  seqPluck('A4', 'D5', 'E5', 'G5'), seqPluck('A4', 'C#5', 'E5', 'G5'),
);

export const COMMAND: Song = {
  title: 'Command Deck',
  bpm: 100,
  timeSig: '4/4',
  key: 'D',
  mode: 'dorian',
  intensity: { min: 0.5, max: 0.9 },
  transition: 'fade',
  delay: { time: '8d', feedback: 0.42 },
  reverb: { decay: 3.2 },
  pump: 0.3,
  // loudness match: the lobby loop is light by design, but sat ≈3 dB under the boss (the master
  // glue compressor absorbs about half of a gain change, hence +1.6 dB here)
  gain: 1.2,
  tracks: TRACKS,
  patterns: {
    padA: held([V.Dm9, 32], [V.G6, 32], [V.Fmaj9, 32], [V.Em7, 16], [V.A7sus4, 16]),
    padLead: held([V.Dm7F, 32], [V.G6, 32], [V.Fmaj9, 32], [V.Em7, 16], [V.A7sus4, 16]),
    padC: held([V.Bbadd9, 32], [V.C6, 32], [V.Dm7, 32], [V.A7sus4, 16], [V.A7, 16]),
    bassSparse: seq(...ROOTS_A.map(sparse)),
    bassA: seq(...ROOTS_A.map(pulse)),
    bassC: seq(...ROOTS_C.map(pulse)),
    // an octave down under the lead, so the motif has its register to itself
    pluckALo: transpose(PLUCK_A, -12),
    pluckC: PLUCK_C,
    // bell: a slow counter-melody in half notes (it rings ~1.4 s)
    bellA: seq(
      // bar 2's C6 waits for beat 2: on the downbeat the lead is still holding B5 (a minor 2nd)
      'E6 . . . . . . . A5 . . . . . . .', '. . . . C6 . . . . . . . . . . .',
      'D6 . . . . . . . B5 . . . . . . .', 'E6 . . . . . . . . . . . . . . .',
      'C6 . . . . . . . G5 . . . . . . .', 'E6 . . . . . . . . . . . . . . .',
      'D6 . . . . . . . B5 . . . . . . .', 'E6 . . . . . . . D6 . . . . . . .',
    ),
    bellC: seq(
      'F6 . . . . . . . D6 . . . . . . .', 'A5 . . . . . . . . . . . . . . .',
      'G6 . . . . . . . E6 . . . . . . .', 'C6 . . . . . . . . . . . . . . .',
      'F6 . . . . . . . C6 . . . . . . .', 'A5 . . . . . . . . . . . . . . .',
      'E6 . . . . . . . D6 . . . . . . .', 'C#6 . . . . . . . E6 . . . . . . .',
    ),
    // lead: the title hook cell, augmented; B states it, A2 answers it a step higher
    leadB: seq(
      hookCellWide('F5', 'A5', 'B5'), //   Dm9 (B natural: the dorian 6th)
      hookCellWide('B4', 'D5', 'E5'), //   G6
      'A5 - - - - - G5 - - - - - E5 - - - | - - - - G5 - - - C5 - - - - - - -', // Fmaj9 (G, not F: E4 is in the pad)
      'D5 - - - - - E5 - - - - - G5 - - -', // Em7
      'A5 - - - - - - - - - - - . . . .', //  A7sus4
    ),
    leadA2: seq(
      'F5 - - - - - A5 - - - - - C6 - - - | - - - - B5 - - - A5 - - - - - - -', // Dm9
      'G5 - - - - - B5 - - - - - D6 - - - | - - - - C6 - - - B5 - - - - - - -', // G6 (a step lower)
      hookCellWide('A5', 'C6', 'D6'), //   Fmaj9 (the cell on the 3rd of F)
      'B5 - - - - - A5 - - - - - G5 - - -', // Em7
      'D5 - - - - - - - - - - - . . . .', //  A7sus4 (the sus 4th, left open)
    ),
    brassC: held(['D4+F4+Bb4', 32], ['E4+G4+C5', 32], ['F4+A4+D5', 32], ['D4+G4+A4', 16], ['C#4+G4+A4', 16]),
    // drums (light): kick on 1 and 3, a soft clap on 2 and 4, shuffling 16th hats
    KC: 'x . . . . . . . x . . . . . . .',
    KC2: 'x . . . . . . . x . . x . . . .',
    CLC: '. . . . x . . . . . . . x . . .',
    HC: 'x? x? x x? x? x? x x? x? x? x x? x? x? x x?',
    HCO: 'x? x? x x? x? x? x x? x? x? x x? x? x? o .',
    TC: '. . . . . . . . . . . . . m l f',
    CR: 'X . . . . . . . . . . . . . . .',
    R: rest(16),
  },
  sections: {
    A: {
      bars: 8, kind: 'intro', intensity: -0.1,
      play: { pad: 'padA', bass: 'bassSparse', bell: 'bellA', hat: eight('HC', 'HCO') },
    },
    B: {
      bars: 8, kind: 'verse',
      play: {
        pad: 'padLead', bass: 'bassA', bell: 'bellA', pluck: 'pluckALo', lead: 'leadB',
        kick: eight('KC', 'KC2'), clap: times('CLC', 8), hat: eight('HC', 'HCO'), tom: eight('R', 'TC'), crash: firstThen('CR', 'R', 8),
      },
    },
    A2: {
      bars: 8, kind: 'verse',
      play: {
        pad: 'padLead', bass: 'bassA', pluck: 'pluckALo', lead: 'leadA2',
        kick: eight('KC', 'KC2'), clap: times('CLC', 8), hat: eight('HC', 'HCO'), tom: eight('R', 'TC'),
      },
    },
    C: {
      bars: 8, kind: 'bridge', intensity: 0.05,
      play: {
        pad: 'padC', bass: 'bassC', bell: 'bellC', pluck: 'pluckC', brass: 'brassC',
        kick: eight('KC', 'KC2'), clap: times('CLC', 8), hat: eight('HC', 'HCO'), tom: eight('R', 'TC'), crash: firstThen('CR', 'R', 8),
      },
    },
  },
  form: ['A', 'B', 'A2', 'C'],
  loopTo: 0,
};
