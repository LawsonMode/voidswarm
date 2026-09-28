/**
 * "VOIDSWARM" (main title theme). ORIGINAL composition for Voidswarm.
 * D minor (aeolian) · 122 bpm · harmonic-minor V (A major, leading tone C#) for tension ·
 * the final choruses go up a whole step to E minor. Style: mid-80s film-score synth rock
 * (arpeggiated 16th bass, detuned pads, gated snare, synth-brass stabs, a portamento lead).
 *
 * FORM (74 bars on the first pass; then it loops from the verse, 58 bars ≈ 1:54)
 *   introA  4  pads + a bell that foreshadows the hook cell          Dm | Bb | Gm | Asus4 A
 *   introB  4  + the 16th arpeggiated bass
 *   introC  4  + kick, off-beat hats, the synth arp
 *   introD  4  + gated snare, a crash, brass swell, snare-roll into the verse
 *   verse   8  full groove; lead verse melody (call bars 1–4, answer 5–8), rock beat, tom fill
 *   pre     4  iv → VI → Vsus4 → V, tresillo brass, snare 4ths → 8ths → 16ths, pickup      Gm | Bb | Asus4 | A
 *   chorus  8 ×2  THE HOOK (see themes.ts), brass stabs, 4-on-the-floor + clap        Bb | C | Dm | A | Bb | C | A | Dm
 *   bridge  8  half-time breather, a new lyrical lead line, arp re-enters at bar 5     Dm | Bb | F | C | Gm | Bb | C | A
 *   lift    2  (+2) iv → V of E minor, 16th brass, a snare/tom build, the hook pickup   Am | B
 *   final   8 ×2 (+2) the hook in E minor, crashes on bars 1 and 5
 *   outro   2  (+2) Em | C: the bell echoes the hook cell
 *   turn    2  (0)  Bb | A: back to D minor (bass E → C → Bb → A → D), tom fill → the verse
 * The layers are written into the sections (every track is 'base'), so the arrangement is fixed
 * whatever intensity the game sends; section intensity only opens the pad filter (a slow build).
 */
import type { Song, TrackDef } from '../format';
import { bassArp, bassGallop, bassOctaves, bassQuarters, eight, firstThen, held, perBar, rest, roll, seq, times } from './lib';
import { DM_LOW5, HOOK_BRASS, HOOK_LEAD, HOOK_PAD, HOOK_PICKUP, HOOK_ROOTS, hookCell } from './themes';

const TRACKS: readonly TrackDef[] = [
  { id: 'pad', inst: 'pad', octave: 4, layer: 'base' },
  { id: 'bass', inst: 'bass', layer: 'base' },
  { id: 'arp', inst: 'arp', layer: 'base', pan: 0.3, gain: 0.9 },
  { id: 'bell', inst: 'bell', layer: 'base', pan: -0.35 },
  { id: 'brass', inst: 'brass', octave: 4, layer: 'base' },
  { id: 'lead', inst: 'lead', layer: 'base', tone: { vibrato: 18, vibratoDelay: 0.24 } },
  { id: 'kick', inst: 'kick', layer: 'base' },
  { id: 'snare', inst: 'snare', layer: 'base' },
  { id: 'clap', inst: 'clap', layer: 'base', gain: 0.7 },
  { id: 'hat', inst: 'hat', layer: 'base' },
  { id: 'tom', inst: 'tom', layer: 'base' },
  { id: 'crash', inst: 'crash', layer: 'base' },
];

// Arp voicings (root, 5th, octave, 10th), 16th up/down rolls.
const A_DM = roll('D4', 'A4', 'D5', 'F5');
const A_BB = roll('Bb3', 'F4', 'Bb4', 'D5');
const A_GM = roll('G3', 'D4', 'G4', 'Bb4');
const A_A = roll('A3', 'E4', 'A4', 'C#5');
const A_ASUS = roll('A3', 'E4', 'A4', 'D5');
const A_C = roll('C4', 'G4', 'C5', 'E5');
const A_ASUS_A = 'A3 E4 A4 D5 A4 E4 A3 E4 A3 E4 A4 C#5 A4 E4 A3 E4';
/** V bar that runs up an A7 arpeggio into the tonic. */
const B_A_RUN = 'A1! A2 E2 A2 A1 A2 E2 A2 A1 A2 E2 A2 A1 C#2 E2 G2';

// Drum bars.
const DR = {
  K4: 'x . . . x . . . x . . . x . . .',
  KR: 'x . . . . . . . x . x . . . . .',
  KH: 'x . . . . . . . . . x . . . . .',
  K1: 'x . . . . . . . . . . . . . . .',
  S24: '. . . . x . . . . . . . x . . .',
  SFILL: '. . . . x . . . x x? x x? . . . .',
  SROLL: 'x? x? x? x? x x? x x? x x x x X x X X',
  SPRE2: '. . . . x . . . . . . . x . x .',
  S8: 'x . x . x . x . x . x . x . x .',
  S16: 'x x x x x x x x X x X x X X X X',
  SHALF: '. . . . . . . . X . . . . . . .',
  SLIFT1: 'x . x . x . x . x x x x x x x x',
  SLIFT2: 'X x x x X x x x X x x x . . . .',
  CL: '. . . . x . . . . . . . x . . .',
  CLF: '. . . . x . . . . . . . . . . .',
  H8: 'x . x . x . x . x . x . x . x .',
  H8O: 'x . x . x . x . x . x . x . o .',
  HOFF: '. . x . . . x . . . x . . . x .',
  H16: 'x x? x x? x x? x x? x x? x x? x x? o .',
  HG: 'x? . x? . x? . x? . x? . x? . x? . x? .',
  TFILL: '. . . . . . . . . . . . h m l f',
  TBIG: '. . . . . . . . . . h h m m l f',
  CR: 'X . . . . . . . . . . . . . . .',
  R: rest(16),
};

export const TITLE: Song = {
  title: 'Voidswarm (Main Theme)',
  bpm: 122,
  timeSig: '4/4',
  key: 'D',
  mode: 'aeolian',
  intensity: { min: 1, max: 1 },
  transition: 'fade',
  delay: { time: '8d', feedback: 0.33 },
  reverb: { decay: 2.6 },
  pump: 0.45,
  tracks: TRACKS,
  patterns: {
    ...DR,
    // ---- pads
    // Dm voiced with the 5th low (DM_LOW5): the intro bell's hook cell leans on Bb5 above it
    padI: seq(perBar(DM_LOW5, '@Bb', '@Gm'), held(['@Asus4', 8], ['@A', 8])),
    padPre: perBar('@Gm', '@Bb', '@Asus4', '@A'),
    padCh: HOOK_PAD,
    padBr: perBar('@Dm', '@Bb', '@F', '@C', '@Gm', '@Bb', '@C', '@A'),
    padLift: perBar('@Gm', '@A'),
    padOut: perBar(DM_LOW5, '@Bb'),
    padTurn: perBar('@Bb', '@A'),
    // ---- bass
    bassI: seq(bassArp('D2'), bassArp('Bb1'), bassArp('G1'), bassArp('A1')),
    bassIRun: seq(bassArp('D2'), bassArp('Bb1'), bassArp('G1'), B_A_RUN),
    bassPre: seq(bassArp('G1'), bassArp('Bb1'), bassGallop('A1'), bassOctaves('A1')),
    bassCh: seq(...HOOK_ROOTS.map(bassGallop)),
    bassBr: seq(...['D2', 'Bb1', 'F1', 'C2', 'G1', 'Bb1', 'C2', 'A1'].map(bassQuarters)),
    bassLift: seq(bassGallop('G1'), bassOctaves('A1')),
    bassOut: held(['D2', 16], ['Bb1', 16]),
    bassTurn: seq(bassArp('Bb1'), B_A_RUN),
    // ---- arp
    arpI: seq(A_DM, A_BB, A_GM, A_ASUS_A),
    arpPre: seq(A_GM, A_BB, A_ASUS, A_A),
    arpCh: seq(A_BB, A_C, A_DM, A_A, A_BB, A_C, A_A, A_DM),
    arpBr: seq(rest(64), A_GM, A_BB, A_C, A_A),
    arpTurn: seq(A_BB, A_A),
    // ---- bell: the hook cell foreshadowed (intro), sparkle (bridge), echoed (outro)
    bellI: seq(
      hookCell('F5', 'A5', 'Bb5'), rest(16),
      hookCell('Bb5', 'D6', 'E6'), 'A5 . . . . . . . E5 . . . C#6 . . .',
    ),
    bellBr: seq(rest(16), '. . . . . . . . D6 . . . F6 . . .', rest(16), '. . . . . . . . E6 . . . G6 . . .', rest(64)),
    bellOut: seq(hookCell('F5', 'A5', 'Bb5'), hookCell('D5', 'F5', 'G5')),
    // ---- lead
    leadV: seq(
      'A5 - - - - - - - G5 - F5 - E5 - F5 -', // Dm   call
      'D5 - - - - - - - - - - - . . . .', //       Bb
      'G5 - - - - - - - F5 - E5 - D5 - E5 -', //   Gm   (the call a step lower)
      'D5 - - - - - - - C#5 - - - - - . .', //     Asus4 → A: the sus 4th resolves with the chord
      'A5 - - - - - - - G5 - F5 - E5 - F5 -', //   Dm   answer
      'D5 - - - - - - - F5 - - - Bb5 - A5 -', //   Bb   (climbs)
      'G5 - - - - - - - - - D5 - E5 - F5 -', //    Gm
      'A5 - - - - - - - E5 - - - C#5 - - -', //    Asus4 → A (down the A triad to the leading tone)
    ),
    leadPre: seq(rest(48), HOOK_PICKUP),
    // the same pickup into the key change (sounds B4 – D#5 over B, the new V): the final chorus is
    // entered through its leading tone, exactly like the first one
    leadLift: seq(rest(16), HOOK_PICKUP),
    leadCh: HOOK_LEAD,
    leadBr: seq(
      'A5 - - - - - - - - - - - G5 - A5 -', //     Dm
      'Bb5 - - - - - - - - - - - A5 - F5 -', //    Bb
      'A5 - - - - - - - - - - - G5 - F5 -', //     F
      'G5 - - - - - - - - - - - . . . .', //       C
      'D5 - - - G5 - - - Bb5 - - - - - A5 -', //   Gm   (up the triad)
      'Bb5 - - - - - - - D6 - - - - - C6 -', //    Bb
      'C6 - - - - - - - - - Bb5 - A5 - G5 -', //   C
      'A5 - - - - - - - - - - - . . . .', //       A
    ),
    // ---- brass
    brassID: seq(rest(48), '@Asus4 - - - - - - - @A! - - - @A - @A -'),
    brassV: seq(rest(48), '@Asus4! - - - - - - - @A! - - - . . . .'),
    brassPre: seq(
      '@Gm! - - @Gm - - @Gm - - - . . . . . .',
      '@Bb! - - @Bb - - @Bb - - - . . . . . .',
      '@Asus4! - - @Asus4 - - @Asus4 - - - - - - - - -',
      '@A! - - @A - - @A - @A - . . . . . .',
    ),
    brassCh: HOOK_BRASS,
    brassBr: seq(rest(96), '@C! - - - - - - - @C - - - @C - - -', '@A! - - - - - - - @A - - @A - - @A -'),
    brassLift: seq('@Gm! - - @Gm - - @Gm - @Gm - @Gm - @Gm - @Gm -', '@A! - - - - - - - - - - - - - - -'),
    brassOut: seq(`${DM_LOW5}! - - - - - - - - - - - - - - -`, rest(16)),
  },
  sections: {
    introA: { bars: 4, kind: 'intro', intensity: -0.65, play: { pad: 'padI', bell: 'bellI' } },
    introB: { bars: 4, kind: 'intro', intensity: -0.5, play: { pad: 'padI', bell: 'bellI', bass: 'bassI' } },
    introC: {
      bars: 4, kind: 'intro', intensity: -0.35,
      play: { pad: 'padI', bass: 'bassI', arp: 'arpI', kick: times('K4', 4), hat: times('HOFF', 4) },
    },
    introD: {
      bars: 4, kind: 'intro', intensity: -0.2,
      play: {
        pad: 'padI', bass: 'bassIRun', arp: 'arpI', brass: 'brassID',
        kick: times('K4', 4), snare: ['S24', 'S24', 'S24', 'SROLL'], hat: times('H8', 4), crash: firstThen('CR', 'R', 4),
      },
    },
    verse: {
      bars: 8, intensity: -0.1,
      play: {
        pad: 'padI', bass: ['bassI', 'bassIRun'], arp: 'arpI', lead: 'leadV', brass: 'brassV',
        kick: times('KR', 8), snare: eight('S24', 'SFILL'), tom: eight('R', 'TFILL'), hat: eight('H8O', 'H8'), crash: firstThen('CR', 'R', 8),
      },
    },
    pre: {
      bars: 4, kind: 'prechorus', intensity: -0.05,
      play: {
        pad: 'padPre', bass: 'bassPre', arp: 'arpPre', brass: 'brassPre', lead: 'leadPre',
        kick: times('K4', 4), snare: ['S24', 'SPRE2', 'S8', 'S16'], hat: times('H8', 4),
      },
    },
    chorus: {
      bars: 8,
      play: {
        pad: 'padCh', bass: 'bassCh', arp: 'arpCh', brass: 'brassCh', lead: 'leadCh',
        kick: times('K4', 8), snare: eight('S24', 'SFILL'), clap: eight('CL', 'CLF'), tom: eight('R', 'TFILL'),
        hat: eight('H16', 'H8'), crash: firstThen('CR', 'R', 8),
      },
    },
    bridge: {
      bars: 8, intensity: -0.3,
      play: {
        pad: 'padBr', bass: 'bassBr', arp: 'arpBr', bell: 'bellBr', lead: 'leadBr', brass: 'brassBr',
        kick: times('KH', 8), snare: times('SHALF', 8), tom: eight('R', 'TBIG'), hat: times('HG', 8), crash: firstThen('CR', 'R', 8),
      },
    },
    lift: {
      bars: 2, kind: 'prechorus', transpose: 2,
      play: {
        pad: 'padLift', bass: 'bassLift', brass: 'brassLift', lead: 'leadLift',
        kick: times('K4', 2), snare: ['SLIFT1', 'SLIFT2'], tom: ['R', 'TFILL'], crash: ['CR', 'R'],
      },
    },
    final: {
      bars: 8, transpose: 2,
      play: {
        pad: 'padCh', bass: 'bassCh', arp: 'arpCh', brass: 'brassCh', lead: 'leadCh',
        kick: times('K4', 8), snare: eight('S24', 'SFILL'), clap: eight('CL', 'CLF'), tom: eight('R', 'TFILL'),
        hat: eight('H16', 'H8'), crash: ['CR', 'R', 'R', 'R', 'CR', 'R', 'R', 'R'],
      },
    },
    outro: {
      bars: 2, transpose: 2, intensity: -0.3,
      play: { pad: 'padOut', bass: 'bassOut', bell: 'bellOut', brass: 'brassOut', kick: times('K1', 2), hat: times('HOFF', 2), crash: ['CR', 'R'] },
    },
    turn: {
      bars: 2, kind: 'bridge', intensity: -0.15,
      play: {
        pad: 'padTurn', bass: 'bassTurn', arp: 'arpTurn',
        kick: times('K4', 2), snare: ['S24', 'SFILL'], tom: ['R', 'TFILL'], hat: times('H8', 2),
      },
    },
  },
  form: [
    'introA', 'introB', 'introC', 'introD', 'verse', 'pre',
    { section: 'chorus', repeat: 2 }, 'bridge', 'lift', { section: 'final', repeat: 2 }, 'outro', 'turn',
  ],
  loopTo: 4,
};

