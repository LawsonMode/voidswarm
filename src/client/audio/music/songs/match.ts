/**
 * "SWARM PROTOCOL" (the match / combat track). ORIGINAL composition for Voidswarm.
 * A minor (aeolian) · 136 bpm · harmonic-minor V (E major, G#) for tension · section C and the
 * last A go up a whole step to B minor. Built for a ~10-minute match: 102 bars on the first pass,
 * then a 98-bar loop (≈ 2:53) whose texture keeps changing with the game's intensity.
 *
 * FORM
 *   intro      4  pedal bass + pads, drums enter, snare roll             Am | Am | F | E
 *   A         16  THE RIFF: pedal-arp bass, main theme (tresillo call, descending answer),
 *                 brass answers the lead's long notes                    Am | Am/G | F | G | Am | Am/G | Dm | E  ×2
 *   B         16  anthem: gallop bass, long soaring lead, busy brass riff,
 *                 off-beat open hats                                     F | C | G | Am | F | C | Dm | E  ×2
 *   A2        16  the riff again with a syncopated pluck counter and an up-roll arp
 *   breakdown  8  (−0.35) pads, half-note bass, the hook cell on a bell, tom heartbeat   Fmaj7 | Dm7 | Am | Esus4 E
 *   build      8  (−0.1) rising lead with glides, brass and snare accelerate, tom roll  Dm | F | G | E
 *   C         16  (+2) THE VOIDSWARM HOOK (themes.ts) re-keyed to A minor, then up to B minor
 *   A3        16  (+2) the riff in B minor: the peak (the bell's hook answers return)
 *   turn       2  (0)  F | E: the key slides back down (F# → F → E → Am) with a tom fill
 * INTENSITY LAYERS (song.intensity {0.25 .. 1}, so a calm match still has a pulse)
 *   low  (eff < 0.35)  pads + bass + hats              mid (0.35 – 0.8)  + kick/snare, then arp, clap,
 *   toms (0.5), bell/pluck colour (0.65)               high (≥ 0.8)  + lead + brass, crashes at 0.9
 * The breakdown and build carry negative section bias, so they thin out on their own.
 */
import type { Song, TrackDef } from '../format';
import {
  bassGallop, bassOctaves, bassPedal, eight, firstThen, held, perBar, rest, roll, rollUp, seq, times, transpose,
} from './lib';
import { HOOK_BRASS, HOOK_LEAD, HOOK_PAD, HOOK_ROOTS, hookCell } from './themes';

const TRACKS: readonly TrackDef[] = [
  { id: 'pad', inst: 'pad', octave: 4, layer: 'base' },
  { id: 'bass', inst: 'bass', layer: 'base' },
  { id: 'bellBd', inst: 'bell', layer: 'base', pan: -0.25, gain: 0.9 },
  { id: 'hat', inst: 'hat', layer: 'pulse' },
  { id: 'kick', inst: 'kick', layer: 'drums' },
  { id: 'snare', inst: 'snare', layer: 'drums' },
  { id: 'clap', inst: 'clap', layer: 'groove', gain: 0.7 },
  { id: 'tom', inst: 'tom', layer: 'groove' },
  { id: 'arp', inst: 'arp', layer: 'groove', pan: 0.3, gain: 0.85 },
  { id: 'bell', inst: 'bell', layer: 'color', pan: -0.3, gain: 0.8 },
  { id: 'pluck', inst: 'pluck', octave: 4, layer: 'color', pan: -0.2, gain: 0.8 },
  { id: 'brass', inst: 'brass', octave: 4, layer: 'hero' },
  { id: 'lead', inst: 'lead', layer: 'hero', tone: { vibrato: 17 } },
  { id: 'crash', inst: 'crash', layer: 'peak' },
];

// ---- bass: pedal arps (A, A2, A3) and gallops (B, C)
const P = {
  Am: bassPedal('A1', 'A2 C3 E3 C3 A2 C3 E3 G3'),
  AmG: bassPedal('G1', 'A2 C3 E3 C3 A2 C3 E3 C3'),
  F: bassPedal('F1', 'A2 C3 F3 C3 A2 C3 F3 G3'),
  G: bassPedal('G1', 'B2 D3 G3 D3 B2 D3 G3 D3'),
  Dm: bassPedal('D2', 'A2 D3 F3 D3 A2 D3 F3 D3'),
  E: bassPedal('E1', 'G#2 B2 E3 B2 G#2 B2 D3 B2'),
};
const BASS_A = seq(P.Am, P.AmG, P.F, P.G, P.Am, P.AmG, P.Dm, P.E);

// ---- arp rolls (16ths) and up-rolls for A2
const R = {
  Am: roll('E4', 'A4', 'C5', 'E5'), F: roll('F4', 'A4', 'C5', 'F5'), G: roll('G4', 'B4', 'D5', 'G5'),
  Dm: roll('F4', 'A4', 'D5', 'F5'), E: roll('E4', 'G#4', 'B4', 'E5'), C: roll('E4', 'G4', 'C5', 'E5'),
};
const U = {
  Am: rollUp('A4', 'C5', 'E5', 'A5'), F: rollUp('A4', 'C5', 'F5', 'A5'), G: rollUp('B4', 'D5', 'G5', 'B5'),
  Dm: rollUp('A4', 'D5', 'F5', 'A5'), E: rollUp('G#4', 'B4', 'E5', 'G#5'),
};

/** Upper-3rd dyads for the pluck skank (under the lead: ≤ C5). Dyads, not triads: a third of the voices. */
const DYAD: Readonly<Record<string, string>> = {
  '@Am': 'A4+C5', '@F': 'F4+A4', '@G': 'G4+B4', '@Dm': 'F4+A4', '@E': 'G#4+B4', '@C': 'E4+G4',
};
/** Syncopated pluck skank (steps 2, 5, 10, 13) on the chord's upper dyad. */
function skank(ch: string): string {
  const d = DYAD[ch]!;
  return `. . ${d} . . ${d} . . . . ${d} . . ${d} . .`;
}
/** The B-section brass riff: 1, 1-and-a, 2-and, 4. */
function riffB(ch: string): string {
  return `${ch}! - . ${ch} - . ${ch} - - - . . ${ch} - . .`;
}

// ---- the main theme (A): tresillo call, long answer; brass answers where the lead holds.
//      The call vaults up from the 5th (5 1 2 b3, then turns back); an earlier draft opened on a
//      repeated root with a b7 neighbour (1 1 b7 1), too close to a famous 80s rock riff.
const LEAD_A_BARS = [
  'E5 - - A5 - - B5 - C6 - - - B5 - A5 -', //   Am
  'A5 - - - - - - - E5 - - - - - - -', //       Am/G
  'C5 - - F5 - - G5 - A5 - - - G5 - F5 -', //   F   (the call a third lower)
  'G5 - - - - - - - D5 - - - - - - -', //       G
  'E5 - - A5 - - B5 - C6 - - - B5 - D6 -', //   Am  (climbs on)
  'E6 - - - - - - - D6 - C6 - B5 - A5 -', //    Am/G (the high E, then a scale down)
  'D6 - - - - - - - C6 - - - A5 - - -', //      Dm
  'B5 - - - - - - - G#5 - - - E5 - - -', //     E   (down the V triad through the leading tone)
];
const LEAD_A = seq(...LEAD_A_BARS);
/** Second time: bar 8 holds the 5th of the V and leaves the last beat to the brass and the fill. */
const LEAD_A_END = seq(...LEAD_A_BARS.slice(0, 7), 'B5 - - - - - - - - - - - . . . .');

const BRASS_A = seq(
  '@Am! - - . . . @Am - . . . . . . . .',
  '. . . . . . . . @Am! - - . @Am - . .',
  '@F! - - . . . @F - . . . . . . . .',
  '. . . . . . . . @G! - - . @G - . .',
  '@Am! - - . . . @Am - . . . . . . . .',
  '. . . . . . . . @Am! - - . @Am - . .',
  '@Dm! - - . . . @Dm - . . . . . . . .',
  '@E! - - - - - - - @E! - - . @E - @E -',
);

// ---- B: the anthem
const LEAD_B_BARS = [
  'C6 - - - - - - - - - - - - - - -', //        F
  '- - - - - - - - D6 - - - E6 - - -', //       C
  'D6 - - - - - - - - - - - B5 - - -', //       G
  'C6 - - - - - - - - - - - . . . .', //        Am
  'A5 - - - - - - - - - - - - - - -', //        F
  '- - - - - - - - G5 - - - C6 - - -', //       C
  'D6 - - - - - - - E6 - - - F6 - - -', //      Dm
  'E6 - - - - - - - - - - - . . . .', //        E
];
const LEAD_B = seq(...LEAD_B_BARS);
/** Second time: bar 8 walks down the V (E D B G#) into the riff's first A. */
const LEAD_B_END = seq(...LEAD_B_BARS.slice(0, 7), 'E6 - - - - - - - D6 - - - B5 - G#5 -');
const B_CHORDS = ['@F', '@C', '@G', '@Am', '@F', '@C', '@Dm', '@E'] as const;
const BRASS_B = seq(...B_CHORDS.slice(0, 7).map(riffB), '@E! - . @E - . @E - . @E - . @E - @E -');

// ---- C: the Voidswarm hook, written in D minor (themes.ts), re-keyed down a fourth to A minor
//      (F | G | Am | E | F | G | E | Am). Pads and brass use low root-position voicings (≤ E4),
//      so the hook, whose lowest note is the 3rd of F (A4), keeps the octave above to itself.
const DOWN = -5;
const C_VOICING: Readonly<Record<string, string>> = { '@F': 'F3+A3+C4', '@G': 'G3+B3+D4', '@Am': 'A3+C4+E4', '@E': 'G#3+B3+E4' };
const voiced = (steps: string): string => steps.replace(/@(?:F|G|Am|E)(?=[!?~]|\s|$)/g, (c) => C_VOICING[c]!);
const C_LEAD = transpose(HOOK_LEAD, DOWN);
const C_BRASS = voiced(transpose(HOOK_BRASS, DOWN));
const C_PAD = voiced(transpose(HOOK_PAD, DOWN));
const C_BASS = seq(...HOOK_ROOTS.map((r) => bassGallop(transpose(r, DOWN))));

// ---- drums
const DR = {
  K4: 'x . . . x . . . x . . . x . . .',
  K8: 'x . x . x . x . x . x . x . x .',
  K1: 'x . . . . . . . . . . . . . . .',
  S24: '. . . . X . . . . . . . X . . .',
  SFILL: '. . . . X . . . x x? x x? . . . .',
  SROLL: 'x? x? x? x? x x? x x? x x x x X x X X',
  S8: 'x . x . x . x . x . x . x . x .',
  S16: 'x x x x x x x x X x X x X X X X',
  SBIG: 'X . . . X . . . X . . . . . . .',
  CL: '. . . . x . . . . . . . x . . .',
  CLF: '. . . . x . . . . . . . . . . .',
  H16: 'x x? x x? x x? x x? x x? x x? x x? x x?',
  H16O: 'x x? x x? x x? x x? x x? x x? x x? o .',
  HOP: 'x . o . x . o . x . o . x . o .',
  H8: 'x . x . x . x . x . x . x . x .',
  HG: 'x? . x? . x? . x? . x? . x? . x? . x? .',
  TFILL: '. . . . . . . . . . . . h m l f',
  THEART: 'f . . . . . . . f? . . . . . . .',
  TROLL: '. . . . . . . . h h m m l l f f',
  CR: 'X . . . . . . . . . . . . . . .',
  R: rest(16),
};

export const MATCH: Song = {
  title: 'Swarm Protocol',
  bpm: 136,
  timeSig: '4/4',
  key: 'A',
  mode: 'aeolian',
  intensity: { min: 0.25, max: 1 },
  transition: 'riser',
  delay: { time: '8d', feedback: 0.3 },
  reverb: { decay: 2.2 },
  pump: 0.5,
  tracks: TRACKS,
  patterns: {
    ...DR,
    // pads
    padIntro: perBar('@Am', '@Am', '@F', '@E'),
    padA: perBar('@Am', '@Am/G', '@F', '@G', '@Am', '@Am/G', '@Dm', '@E'),
    padB: perBar(...B_CHORDS),
    padBd: held(['F3+A3+C4+E4', 32], ['F3+A3+C4+D4', 32], ['@Am', 32], ['@Esus4', 16], ['@E', 16]),
    padBuild: perBar('@Dm', '@Dm', '@F', '@F', '@G', '@G', '@E', '@E'),
    padC: C_PAD,
    padTurn: perBar('@F', '@E'),
    // bass
    bassIntro: seq(P.Am, P.Am, P.F, P.E),
    bassA: BASS_A,
    bassB: seq(...['F1', 'C2', 'G1', 'A1', 'F1', 'C2', 'D2', 'E1'].map(bassGallop)),
    bassBd: seq(...['F1', 'F1', 'D2', 'D2', 'A1', 'A1', 'E1', 'E1'].map((r) => `${r} - - - - - - - ${r} - - - - - - -`)),
    bassBuild: seq(
      bassOctaves('D2'), bassOctaves('D2'), bassOctaves('F1'), bassOctaves('F1'),
      bassOctaves('G1'), bassOctaves('G1'), bassGallop('E1'), 'E1! E2 E1 E2 E1 E2 E1 E2 G#1 B1 D2 E2 G#2 B2 D3 E3',
    ),
    bassC: C_BASS,
    bassTurn: seq(bassGallop('F1'), 'E1! E1 E2 E1 E1 E2 E1 E2 E1 E2 G#1 B1 D2 E2 G#2 B2'),
    // arps
    arpIntro: seq(rest(32), R.F, R.E),
    arpA: seq(R.Am, R.Am, R.F, R.G, R.Am, R.Am, R.Dm, R.E),
    arpA2: seq(U.Am, U.Am, U.F, U.G, U.Am, U.Am, U.Dm, U.E),
    arpB: seq(R.F, R.C, R.G, R.Am, R.F, R.C, R.Dm, R.E),
    arpBd: seq(roll('F4', 'A4', 'C5', 'E5'), roll('F4', 'A4', 'C5', 'E5'), roll('F4', 'A4', 'D5', 'F5'), roll('F4', 'A4', 'D5', 'F5'), R.Am, R.Am, roll('E4', 'A4', 'B4', 'E5'), R.E),
    arpBuild: seq(R.Dm, R.Dm, R.F, R.F, R.G, R.G, R.E, U.E),
    arpC: seq(R.F, R.G, R.Am, R.E, R.F, R.G, R.E, R.Am),
    // colour: the hook cell answers the lead's long notes (bars 2, 4) and closes on the V. Over Am/G
    // the cell starts on the 5th (E G A, all chord tones): from C its top note would be F6, ringing
    // a minor 9th over the lead's E5 on beat 3.
    bellA: seq(rest(16), hookCell('E6', 'G6', 'A6'), rest(16), hookCell('B5', 'D6', 'E6'), rest(48), 'G#5 . . B5 . . E6 . . . . . . . . .'),
    bellB: seq(rest(16), '. . . . . . . . G6 . . . E6 . . .', rest(32), rest(16), '. . . . . . . . G6 . . . E6 . . .', rest(32)),
    bellBd: seq(
      hookCell('A5', 'C6', 'D6'), rest(16), //      Fmaj7
      hookCell('F5', 'A5', 'B5'), rest(16), //      Dm7 (B natural: the dorian 6th of D)
      hookCell('C6', 'E6', 'F6'), rest(16), //      Am
      'B5 . . . . . . . A5 . . . E5 . . .', 'G#5 . . . . . . . B5 . . . E6 . . .', // Esus4 → E
    ),
    bellC: seq(rest(48), '. . . . . . . . B5 . . . E6 . . .', rest(64)),
    pluckA2: seq(...['@Am', '@Am', '@F', '@G', '@Am', '@Am', '@Dm', '@E'].map(skank)),
    pluckB: seq(...B_CHORDS.map(skank)),
    // brass
    brassA: BRASS_A,
    brassB: BRASS_B,
    brassBuild: seq(
      '@Dm! - - - - - - - @Dm - - - - - - -', '@Dm! - - - - - - - @Dm - - - - - - -',
      '@F! - - - @F - - - @F - - - @F - - -', '@F! - - - @F - - - @F - - - @F - - -',
      '@G! - @G - @G - @G - @G - @G - @G - @G -', '@G! - @G - @G - @G - @G - @G - @G - @G -',
      '@E! - @E - @E - @E - @E - @E - @E - @E -', '@E! - - - - - - - - - - - . . . .',
    ),
    brassC: C_BRASS,
    brassTurn: seq('@F! - - - - - - - - - - - - - - -', '@E! - - - - - - - @E - - @E - @E - .'),
    // lead
    leadA: LEAD_A,
    leadAEnd: LEAD_A_END,
    leadB: LEAD_B,
    leadBEnd: LEAD_B_END,
    leadBuild: seq(
      'A5 - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - -',
      'C6~ - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - -',
      'D6~ - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - -',
      'E6~ - - - - - - - - - - - - - - - | - - - - - - - - - - - - . . . .',
    ),
    leadC: C_LEAD,
    leadTurn: seq('A5 - - - - - - - - - - - - - - -', 'G#5 - - - - - - - - - - - . . . .'),
  },
  sections: {
    intro: {
      bars: 4,
      play: {
        pad: 'padIntro', bass: 'bassIntro', arp: 'arpIntro',
        kick: ['R', 'R', 'K4', 'K4'], snare: ['R', 'R', 'R', 'SROLL'], hat: times('H16', 4),
      },
    },
    A: {
      bars: 16, kind: 'verse',
      play: {
        pad: 'padA', bass: 'bassA', arp: 'arpA', bell: 'bellA', brass: 'brassA', lead: ['leadA', 'leadAEnd'],
        kick: times('K4', 16), snare: [...eight('S24', 'SFILL'), ...eight('S24', 'SFILL')],
        clap: [...eight('CL', 'CLF'), ...eight('CL', 'CLF')], tom: [...eight('R', 'TFILL'), ...eight('R', 'TFILL')],
        hat: [...eight('H16', 'H16O'), ...eight('H16', 'H16O')], crash: [...firstThen('CR', 'R', 8), ...firstThen('CR', 'R', 8)],
      },
    },
    B: {
      bars: 16, kind: 'chorus',
      play: {
        pad: 'padB', bass: 'bassB', arp: 'arpB', bell: 'bellB', pluck: 'pluckB', brass: 'brassB', lead: ['leadB', 'leadBEnd'],
        kick: times('K4', 16), snare: [...eight('S24', 'SFILL'), ...eight('S24', 'SFILL')],
        clap: [...eight('CL', 'CLF'), ...eight('CL', 'CLF')], tom: [...eight('R', 'TFILL'), ...eight('R', 'TFILL')],
        hat: [...eight('HOP', 'H16O'), ...eight('HOP', 'H16O')], crash: [...firstThen('CR', 'R', 8), ...firstThen('CR', 'R', 8)],
      },
    },
    A2: {
      bars: 16, kind: 'verse',
      play: {
        pad: 'padA', bass: 'bassA', arp: 'arpA2', pluck: 'pluckA2', brass: 'brassA', lead: ['leadA', 'leadAEnd'],
        kick: times('K4', 16), snare: [...eight('S24', 'SFILL'), ...eight('S24', 'SFILL')],
        clap: [...eight('CL', 'CLF'), ...eight('CL', 'CLF')], tom: [...eight('R', 'TFILL'), ...eight('R', 'TFILL')],
        hat: [...eight('H16', 'H16O'), ...eight('H16', 'H16O')], crash: [...firstThen('CR', 'R', 8), ...firstThen('CR', 'R', 8)],
      },
    },
    breakdown: {
      bars: 8, intensity: -0.35,
      play: {
        pad: 'padBd', bass: 'bassBd', arp: 'arpBd', bellBd: 'bellBd',
        kick: firstThen('K1', 'R', 8), tom: times('THEART', 8), hat: times('HG', 8),
      },
    },
    build: {
      bars: 8, kind: 'prechorus', intensity: -0.1,
      play: {
        pad: 'padBuild', bass: 'bassBuild', arp: 'arpBuild', brass: 'brassBuild', lead: 'leadBuild',
        kick: [...times('K4', 6), 'K8', 'K8'], snare: ['S24', 'S24', 'S24', 'S24', 'S8', 'S8', 'S16', 'SBIG'],
        tom: [...times('R', 7), 'TROLL'], hat: [...times('H8', 4), ...times('H16', 4)], crash: ['CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R'],
      },
    },
    C: {
      bars: 16, kind: 'chorus', transpose: 2, intensity: 0.05,
      play: {
        pad: 'padC', bass: 'bassC', arp: 'arpC', bell: 'bellC', brass: 'brassC', lead: 'leadC',
        kick: times('K4', 16), snare: [...eight('S24', 'SFILL'), ...eight('S24', 'SFILL')],
        clap: [...eight('CL', 'CLF'), ...eight('CL', 'CLF')], tom: [...eight('R', 'TFILL'), ...eight('R', 'TFILL')],
        hat: [...eight('H16', 'H16O'), ...eight('H16', 'H16O')], crash: ['CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R'],
      },
    },
    A3: {
      bars: 16, kind: 'final', transpose: 2, intensity: 0.05,
      play: {
        pad: 'padA', bass: 'bassA', arp: 'arpA', bell: 'bellA', brass: 'brassA', lead: ['leadA', 'leadAEnd'],
        kick: times('K4', 16), snare: [...eight('S24', 'SFILL'), ...eight('S24', 'SFILL')],
        clap: [...eight('CL', 'CLF'), ...eight('CL', 'CLF')], tom: [...eight('R', 'TFILL'), ...eight('R', 'TFILL')],
        hat: [...eight('H16', 'H16O'), ...eight('H16', 'H16O')], crash: [...firstThen('CR', 'R', 8), ...firstThen('CR', 'R', 8)],
      },
    },
    turn: {
      bars: 2, kind: 'bridge',
      play: {
        pad: 'padTurn', bass: 'bassTurn', brass: 'brassTurn', lead: 'leadTurn',
        kick: times('K4', 2), snare: ['S24', 'SFILL'], tom: ['R', 'TFILL'], hat: times('H16', 2),
      },
    },
  },
  form: ['intro', 'A', 'B', 'A2', 'breakdown', 'build', 'C', 'A3', 'turn'],
  loopTo: 1,
};
