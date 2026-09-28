/**
 * "HIVE MOTHER" (dungeon boss). ORIGINAL composition for Voidswarm.
 * E phrygian (the flat 2nd, F, is the menace) · 150 bpm · chromatic accents: the major V (B, with
 * D#), a tritone Bb in the tension build, a chromatic glide in the lead. The payoff is the
 * Voidswarm hook (themes.ts) re-keyed to E minor (the light breaks in: F# replaces F), then lifted
 * a semitone to F minor, and a phrygian cadence (F → E) drops it back into the menace.
 *
 * FORM (78 bars on the first pass, then a 74-bar loop ≈ 1:58)
 *   intro     4  pounding floor toms, low brass, 8th pedal                 Em | F/E | Em | B
 *   A        16  THE RIFF: 16th E-pedal bass with phrygian passing notes, low brass swells,
 *                a lead that climbs by semitones (E-B-C-B → F-C-D-C)       Em | F/E Em | F/E | Em G | Em | F/E Em | C | B  ×2
 *   B        16  half-time: war-drum floor toms, snare on 3, wailing lead with glides,
 *                tresillo brass hits                                        Am | F | Am | F | Dm | C | B | B  ×2
 *   A2       16  the riff again, tritone bell pings (B–F), crashes
 *   tension   8  (−0.15) Em ↔ Bb (tritone), the lead rises E–G–A–B–D#, toms accelerate
 *   payoff    8  THE HOOK in E minor with full brass            C | D | Em | B | C | D | B | Em
 *   payoff2   8  (+1) the hook again, a semitone higher (F minor)
 *   turn      2  F | E: the phrygian cadence, back into the riff
 * INTENSITY {0.55 .. 1}: the low brass, bass, pads, drums and toms always play; the arp and
 * clap join at 0.5, the tritone bell at 0.65, the lead and hero brass at 0.8, crashes at 0.9.
 */
import type { Song, TrackDef } from '../format';
import { bassGallop, bassOctaves, bassRiff, eight, firstThen, held, perBar, rest, roll, seq, stab, times, transpose } from './lib';
import { HOOK_BRASS, HOOK_CHORDS, HOOK_LEAD, HOOK_PAD, HOOK_ROOTS } from './themes';
import { PHRYGIAN_STINGERS } from './stingers';

const TRACKS: readonly TrackDef[] = [
  { id: 'pad', inst: 'pad', octave: 4, layer: 'base', gain: 0.9 },
  { id: 'bass', inst: 'bass', layer: 'base', tone: { resonance: 11, envAmount: 3000 } },
  { id: 'brassLow', inst: 'brass', octave: 3, layer: 'base', gain: 0.9, tone: { attack: 0.03, cutoff: 320 } },
  { id: 'tom', inst: 'tom', layer: 'drums' },
  { id: 'kick', inst: 'kick', layer: 'drums' },
  { id: 'snare', inst: 'snare', layer: 'drums' },
  { id: 'hat', inst: 'hat', layer: 'pulse', gain: 0.85 },
  { id: 'clap', inst: 'clap', layer: 'groove', gain: 0.7 },
  { id: 'arp', inst: 'arp', layer: 'groove', pan: 0.3, gain: 0.8 },
  { id: 'bell', inst: 'bell', layer: 'color', pan: -0.3, gain: 0.8 },
  { id: 'brass', inst: 'brass', octave: 4, layer: 'hero' },
  { id: 'lead', inst: 'lead', layer: 'hero', tone: { vibrato: 24, vibratoDelay: 0.2, glide: 0.09 } },
  { id: 'crash', inst: 'crash', layer: 'peak' },
];

/** Half-bar up/down roll: a b c d c b a b. */
function half(a: string, b: string, c: string, d: string): string {
  return `${a} ${b} ${c} ${d} ${c} ${b} ${a} ${b}`;
}
const AR = {
  Em: half('E4', 'G4', 'B4', 'E5'), FE: half('F4', 'A4', 'C5', 'F5'), G: half('G4', 'B4', 'D5', 'G5'),
};

// ---- the riff (bass) and harmony of A
const RIFF = {
  E1: bassRiff('E1', 'F2', 'G2', 'F2'),
  E2: bassRiff('E1', 'F2', 'D2', 'B1'),
  C: bassRiff('C2', 'D3', 'E3', 'D3'),
  B: bassRiff('B1', 'C3', 'D#3', 'C3'),
  Am: bassRiff('A1', 'B2', 'C3', 'B2'),
  F: bassRiff('F1', 'G2', 'A2', 'G2'),
  Dm: bassRiff('D2', 'E3', 'F3', 'E3'),
  /** B that runs up into the riff's E. */
  Brun: 'B1! B1 B2 B1 B1 B2 B1 C3 B1! B1 D#2 F#2 A2 B2 C3 D#3',
};
const PAD_A = seq(
  '@Em - - - - - - - - - - - - - - -', held(['@F/E', 8], ['@Em', 8]), '@F/E - - - - - - - - - - - - - - -', held(['@Em', 8], ['@G', 8]),
  '@Em - - - - - - - - - - - - - - -', held(['@F/E', 8], ['@Em', 8]), '@C - - - - - - - - - - - - - - -', '@B - - - - - - - - - - - - - - -',
);
const BRASS_LOW_A = seq(
  '@Em! - - - - - - - - - - - . . . .', '@F! - - - - - - - @Em - - - - - - -',
  '@F! - - - - - - - - - - - . . . .', '@Em! - - - - - - - @G - - - - - - -',
  '@Em! - - - - - - - - - - - . . . .', '@F! - - - - - - - @Em - - - - - - -',
  '@C! - - - - - - - - - - - @C - - -', '@B! - - - - - - - @B - - - @B - @B -',
);
const ARP_A = seq(
  AR.Em, AR.Em, AR.FE, AR.Em, AR.FE, AR.FE, AR.Em, AR.G,
  AR.Em, AR.Em, AR.FE, AR.Em, roll('E4', 'G4', 'C5', 'E5'), roll('D#4', 'F#4', 'B4', 'D#5'),
);
const LEAD_A_BARS = [
  'E5 - - B5 - - - - C6 - - - B5 - - -', //         Em   (the b6, C, leans on the 5th)
  'F5 - - C6 - - - - D6 - - - C6 - B5 -', //        F/E → Em  (the same shape a semitone up)
  'F5 - - C6 - - - - D6 - - - C6 - - -', //         F/E
  'B5 - - - - - - - D6 - - - - - - -', //           Em → G
  'E5 - - B5 - - - - C6 - - - B5 - - -', //         Em
  'G5 - - - A5 - - - Bb5~ - - - B5~ - - -', //      F/E → Em  (a chromatic glide through the b5)
  'C6 - - - - - - - E6 - - - D6 - C6 -', //         C
  'B5 - - - - - - - A5 - - - F#5 - D#5 -', //       B    (down B7 to the leading tone)
];
const BRASS_A = seq(rest(96), '@C! - - @C - - @C - - - @C - @C - - -', '@B! - - @B - - @B - @B - @B - @B - @B -');

// ---- B (half-time)
const B_CHORDS = ['@Am', '@F', '@Am', '@F', '@Dm', '@C', '@B', '@B'] as const;
const LEAD_B = seq(
  'E6 - - - - - - - - - - - - - - -', //            Am
  '- - - - - - - - F6~ - - - E6~ - - -', //          F   (the held E becomes F's major 7th)
  'C6 - - - - - - - - - - - B5 - A5 -', //          Am
  'A5 - - - - - - - - - - - . . . .', //            F
  'D6 - - - - - - - F6 - - - E6 - D6 -', //         Dm
  'C6 - - - - - - - D6 - - - E6 - - -', //          C
  'D#6 - - - - - - - - - - - - - - -', //           B   (the leading tone, screaming)
  '- - - - - - - - C6 - - - B5 - - -', //           B   (C: the phrygian b9 of B)
);

// ---- tension
const TENSION_PAD = perBar('@Em', '@Bb', '@Em', '@Bb', '@Am', '@Am', '@B', '@B');

// ---- payoff: the hook, re-keyed from D minor to E minor
const UP = 2;
const PR = {
  C: roll('C4', 'G4', 'C5', 'E5'), D: roll('D4', 'A4', 'D5', 'F#5'), Em: roll('E4', 'B4', 'E5', 'G5'), B: roll('B3', 'F#4', 'B4', 'D#5'),
};
const PAYOFF_ARP = seq(PR.C, PR.D, PR.Em, PR.B, PR.C, PR.D, PR.B, PR.Em);

const DR = {
  KA: 'x . . . x . . x x . . . x . . .',
  K4: 'x . . . x . . . x . . . x . . .',
  KH: 'x . . . . . . . . . x . . . . .',
  K1: 'x . . . . . . . . . . . . . . .',
  S24: '. . . . X . . . . . . . X . . .',
  SF2: '. . . . X . . . x x? x x? . . . .',
  SH: '. . . . . . . . X . . . . . . .',
  SROLL: 'x x x x x x x x X X X X X X X X',
  CL: '. . . . x . . . . . . . x . . .',
  CLH: '. . . . . . . . x . . . . . . .',
  H16: 'x x? x x? x x? x x? x x? x x? x x? x x?',
  H8: 'x . x . x . x . x . x . x . x .',
  TI: 'f! . . f . . f . f! . . f . . f .',
  TA: 'f! . . f . . f . . . . . . . . .',
  TB: 'f! . . . f . . . f . . . f . f f',
  TT1: 'f . . . . . . . f . . . . . . .',
  TT2: 'f . . . f . . . f . . . f . . .',
  TT3: 'f . f . f . f . f . f . f . f .',
  TRISE: 'f f f f l l l l m m m m h h h h',
  TFILL: '. . . . . . . . h h m m l l f f',
  TF1: '. . . . . . . . . . . . h m l f',
  CR: 'X . . . . . . . . . . . . . . .',
  R: rest(16),
};

export const BOSS: Song = {
  title: 'Hive Mother',
  bpm: 150,
  timeSig: '4/4',
  key: 'E',
  mode: 'phrygian',
  intensity: { min: 0.55, max: 1 },
  transition: 'both',
  fill: { snare: 'X . x x', tom: '. h l f' },
  delay: { time: '8', feedback: 0.26 },
  reverb: { decay: 2.0 },
  pump: 0.5,
  // loudness match: the floor toms and resonant bass made this the loudest scene (≈1 dB over the
  // match; the master glue compressor absorbs about half of a gain change, hence -2 dB here)
  gain: 0.8,
  stingers: PHRYGIAN_STINGERS,
  tracks: TRACKS,
  patterns: {
    ...DR,
    // intro
    padIntro: perBar('@Em', '@F/E', '@Em', '@B'),
    brassLowIntro: seq('@Em! - - - - - - - - - - - - - - -', '@F! - - - - - - - - - - - - - - -', '@Em! - - - - - - - - - - - - - - -', '@B! - - - - - - - - - - - - - - -'),
    bassIntro: seq('E1! . E1 . E1 . E1 . E1 . E1 . E1 . E1 .', 'E1! . E1 . E1 . E1 . E1 . E1 . E1 . E1 .', 'E1! . E1 . E1 . E1 . E1 . E1 . E1 . E1 .', 'B1! . B1 . B1 . B1 . B1 B1 B1 B1 B1 B1 B1 B1'),
    bellIntro: seq('B6 . . . . . . . F6 . . . . . . .', rest(16), 'B6 . . . . . . . F6 . . . . . . .', rest(16)),
    // A
    padA: PAD_A,
    bassA: seq(RIFF.E1, RIFF.E2, RIFF.E1, RIFF.E2, RIFF.E1, RIFF.E2, RIFF.C, RIFF.B),
    brassLowA: BRASS_LOW_A,
    arpA: ARP_A,
    leadA: seq(...LEAD_A_BARS),
    leadAEnd: seq(...LEAD_A_BARS.slice(0, 7), 'B5 - - - - - - - - - - - . . . .'),
    brassA: BRASS_A,
    bellA: seq(rest(48), '. . . . . . . . B6 . . . F6 . . .', rest(48), '. . . . . . . . B6 . . . F6 . . .'),
    // B
    padB: perBar(...B_CHORDS),
    bassB: seq(RIFF.Am, RIFF.F, RIFF.Am, RIFF.F, RIFF.Dm, RIFF.C, RIFF.B, RIFF.Brun),
    brassLowB: seq(...B_CHORDS.map((c) => `${c}! - - - - - - - ${c} - - - - - - -`)),
    brassB: seq(...B_CHORDS.map((c) => `${c}! - - ${c} - - ${c} - . . . . . . . .`)),
    arpB: seq(roll('E4', 'A4', 'C5', 'E5'), roll('F4', 'A4', 'C5', 'F5'), roll('E4', 'A4', 'C5', 'E5'), roll('F4', 'A4', 'C5', 'F5'),
      roll('F4', 'A4', 'D5', 'F5'), roll('E4', 'G4', 'C5', 'E5'), roll('D#4', 'F#4', 'B4', 'D#5'), roll('D#4', 'F#4', 'B4', 'D#5')),
    leadB: LEAD_B,
    // tension
    padT: TENSION_PAD,
    bassT: seq(
      'E1 - - - - - - - E1 - - - - - - -', 'Bb1 - - - - - - - Bb1 - - - - - - -', 'E1 - - - - - - - E1 - - - - - - -', 'Bb1 - - - - - - - Bb1 - - - - - - -',
      'A1! . A2 . A1 . A2 . A1 . A2 . A1 . A2 .', 'A1! . A2 . A1 . A2 . A1 . A2 . A1 . A2 .', bassOctaves('B1'), bassOctaves('B1'),
    ),
    brassLowT: seq(
      '@Em! - - - - - . . . . . . . . . .', '@Bb! - - - - - . . . . . . . . . .', '@Em! - - - - - . . . . . . . . . .', '@Bb! - - - - - . . . . . . . . . .',
      '@Am! - - - @Am - - - @Am - - - @Am - - -', '@Am! - - - @Am - - - @Am - - - @Am - - -',
      '@B! - @B - @B - @B - @B - @B - @B - @B -', '@B! - - - - - - - - - - - - - - -',
    ),
    leadT: seq('E5 - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - -',
      'G5~ - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - -',
      'A5~ - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - -',
      'B5~ - - - - - - - - - - - - - - -', 'D#6~ - - - - - - - - - - - . . . .'),
    bellT: seq('B5 . . . . . . . E6 . . . . . . .', 'F6 . . . . . . . Bb5 . . . . . . .', 'B5 . . . . . . . E6 . . . . . . .', 'F6 . . . . . . . Bb5 . . . . . . .', rest(64)),
    arpT: seq(rest(64), roll('E4', 'A4', 'C5', 'E5'), roll('E4', 'A4', 'C5', 'E5'), roll('D#4', 'F#4', 'B4', 'D#5'), roll('F#4', 'B4', 'D#5', 'F#5')),
    // payoff (the hook in E minor)
    padP: transpose(HOOK_PAD, UP),
    // chord symbols (not HOOK_PAD's explicit bar-3 voicing), so the low brass stays in its octave-3 register
    brassLowP: transpose(perBar(...HOOK_CHORDS), UP),
    bassP: seq(...HOOK_ROOTS.map((r) => bassGallop(transpose(r, UP)))),
    brassP: transpose(HOOK_BRASS, UP),
    leadP: transpose(HOOK_LEAD, UP),
    arpP: PAYOFF_ARP,
    // turn: the phrygian cadence F → E
    padTurn: perBar('@F', '@E'),
    bassTurn: seq(RIFF.F, bassGallop('E1')),
    brassLowTurn: seq('@F! - - - - - - - - - - - - - - -', '@E! - - - - - - - @E - - @E - @E - .'),
    brassTurn: seq(stab('@F'), '@E! - - @E - - @E - @E - @E - @E - . .'),
    leadTurn: seq('C6 - - - - - - - - - - - - - - -', 'B5 - - - - - - - G#5 - - - E5 - - -'),
  },
  sections: {
    intro: {
      bars: 4,
      play: {
        pad: 'padIntro', brassLow: 'brassLowIntro', bass: 'bassIntro', bell: 'bellIntro',
        tom: ['TI', 'TI', 'TI', 'TRISE'], kick: ['R', 'R', 'R', 'K4'], snare: ['R', 'R', 'R', 'SROLL'],
      },
    },
    A: {
      bars: 16, kind: 'verse',
      play: {
        pad: 'padA', bass: 'bassA', brassLow: 'brassLowA', arp: 'arpA', lead: ['leadA', 'leadAEnd'], brass: 'brassA',
        kick: times('KA', 16), snare: [...eight('S24', 'SF2'), ...eight('S24', 'SF2')], clap: times('CL', 16),
        tom: [...eight('TA', 'TF1'), ...eight('TA', 'TF1')], hat: times('H16', 16), crash: [...firstThen('CR', 'R', 8), ...firstThen('CR', 'R', 8)],
      },
    },
    B: {
      bars: 16, kind: 'chorus',
      play: {
        pad: 'padB', bass: 'bassB', brassLow: 'brassLowB', brass: 'brassB', arp: 'arpB', lead: 'leadB',
        kick: times('KH', 16), snare: times('SH', 16), clap: times('CLH', 16),
        tom: [...eight('TB', 'TFILL'), ...eight('TB', 'TFILL')], hat: times('H8', 16), crash: [...firstThen('CR', 'R', 8), ...firstThen('CR', 'R', 8)],
      },
    },
    A2: {
      bars: 16, kind: 'verse',
      play: {
        pad: 'padA', bass: 'bassA', brassLow: 'brassLowA', arp: 'arpA', lead: ['leadA', 'leadAEnd'], brass: 'brassA', bell: 'bellA',
        kick: times('KA', 16), snare: [...eight('S24', 'SF2'), ...eight('S24', 'SF2')], clap: times('CL', 16),
        tom: [...eight('TA', 'TF1'), ...eight('TA', 'TF1')], hat: times('H16', 16),
        crash: ['CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R'],
      },
    },
    tension: {
      bars: 8, kind: 'breakdown', intensity: -0.15,
      play: {
        pad: 'padT', bass: 'bassT', brassLow: 'brassLowT', lead: 'leadT', bell: 'bellT', arp: 'arpT',
        tom: ['TT1', 'TT1', 'TT1', 'TT1', 'TT2', 'TT2', 'TT3', 'TRISE'],
        kick: [...times('K1', 6), 'K4', 'K4'], snare: [...times('R', 6), 'S24', 'SROLL'], hat: [...times('R', 4), ...times('H8', 4)],
      },
    },
    payoff: {
      bars: 8, kind: 'chorus',
      play: {
        pad: 'padP', brassLow: 'brassLowP', bass: 'bassP', brass: 'brassP', lead: 'leadP', arp: 'arpP',
        kick: times('K4', 8), snare: eight('S24', 'SF2'), clap: times('CL', 8), tom: eight('R', 'TF1'),
        hat: times('H16', 8), crash: ['CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R'],
      },
    },
    payoff2: {
      bars: 8, kind: 'final', transpose: 1, intensity: 0.05,
      // (no low brass here: it keeps the song's distinct chord loops well inside the engine's cache)
      play: {
        pad: 'padP', bass: 'bassP', brass: 'brassP', lead: 'leadP', arp: 'arpP',
        kick: times('K4', 8), snare: eight('S24', 'SF2'), clap: times('CL', 8), tom: eight('R', 'TF1'),
        hat: times('H16', 8), crash: ['CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R'],
      },
    },
    turn: {
      bars: 2, kind: 'bridge',
      play: {
        pad: 'padTurn', bass: 'bassTurn', brassLow: 'brassLowTurn', brass: 'brassTurn', lead: 'leadTurn',
        kick: times('K4', 2), snare: ['S24', 'SF2'], tom: ['R', 'TF1'], hat: times('H16', 2),
      },
    },
  },
  form: ['intro', 'A', 'B', 'A2', 'tension', 'payoff', 'payoff2', 'turn'],
  loopTo: 1,
};
