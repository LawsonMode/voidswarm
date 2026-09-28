// THE VOIDSWARM LEITMOTIF: shared thematic material, written once and quoted by several songs.
// All ORIGINAL (written for Voidswarm). Nothing here quotes or paraphrases an existing tune.
//
// The hook CELL is one bar on a tresillo (3 + 3 + 4 + 2 + 4 sixteenths): the 3rd, 5th and 6th of
// the chord underneath, then back down (x y z y x). Stated three times in a rising sequence over
// VI – VII – i, it is the chorus of the title theme. Other songs quote it:
//   command  the cell in augmentation (twice as slow), dorian colour: the lobby's "thinking" motif
//   match    the full chorus hook in section C (re-keyed to A minor, then up a whole step)
//   boss     the full chorus hook as the payoff (E minor, then a semitone lift to F minor)
//   victory  the cell over bVI – bVII – I in major: the hook "wins"
//   defeat   the cell's falling tail (6th → 5th → 3rd) slowed right down
import { perBar, rest, seq, stab } from './lib';

/** The hook cell: x - - y - - z - - - y - x - - -  (x = chord 3rd, y = 5th, z = 6th). */
export function hookCell(x: string, y: string, z: string): string {
  return `${x} - - ${y} - - ${z} - - - ${y} - ${x} - - -`;
}

/** The hook cell in augmentation: the same shape over two bars (6 + 6 + 8 + 4 + 8). */
export function hookCellWide(x: string, y: string, z: string): string {
  return `${x} - - - - - ${y} - - - - - ${z} - - - | - - - - ${y} - - - ${x} - - - - - - -`;
}

// ---------------------------------------------------------------------------------------------
// The chorus hook in D minor (the title key): 8 bars, call (bars 1–4) and answer (bars 5–8).
//   Bb | C | Dm | A || Bb | C | A | Dm
//   call:   the cell rises by step three times, then a half cadence on the V (leading tone C#)
//   answer: the same opening, then the sequence breaks: an A-major run up to the top E and a
//           long resolution on the tonic D
// ---------------------------------------------------------------------------------------------

/** Chords, one per bar (pad / brass). */
export const HOOK_CHORDS = ['@Bb', '@C', '@Dm', '@A', '@Bb', '@C', '@A', '@Dm'] as const;

/**
 * Dm with its 5th dropped below the 3rd (A3 D4 F4). In bar 3 the hook leans on the b6 (Bb5) for a
 * quarter note before it falls to the 5th (A5), the classic minor appoggiatura. Over the folded
 * voicing (D4 F4 A4) that Bb sits a MINOR 9TH above the pad's A4 and grinds. With the A two octaves
 * below the lead, the appoggiatura keeps its ache without the rub. Also used by the title's intro
 * and outro, where the bell states the same cell.
 */
export const DM_LOW5 = 'A3+D4+F4';

export const HOOK_LEAD = seq(
  hookCell('D5', 'F5', 'G5'), // Bb
  hookCell('E5', 'G5', 'A5'), // C
  hookCell('F5', 'A5', 'Bb5'), // Dm
  'E5 - - - - - D5 - C#5 - - - - - - -', // A   (half cadence: the leading tone)
  hookCell('D5', 'F5', 'G5'), // Bb
  hookCell('E5', 'G5', 'A5'), // C
  'E5 - - A5 - - C#6 - - - D6 - E6 - - -', // A   (the run up: the climax)
  'D6 - - - - - - - - - - - - - . .', // Dm  (home)
);

/** The pad under the hook: HOOK_CHORDS, with bar 3 voiced DM_LOW5 (see above). */
export const HOOK_PAD = perBar(...HOOK_CHORDS.map((c, i) => (i === 2 ? DM_LOW5 : c)));

/**
 * Brass: a hit on 1 and an answer on the "and" of 3; a rhythmic fill under the half cadence. The
 * fill's second hit waits for beat 3 (the lead's leading tone C#): struck on the "and" of 2 it
 * would land together with the lead's passing D5, a minor 9th above the stab's C#4.
 */
export const HOOK_BRASS = seq(
  stab('@Bb'), stab('@C'), stab('@Dm'),
  '@A! - - . . . . . @A - @A - @A - . .',
  stab('@Bb'), stab('@C'), stab('@A'),
  '@Dm! - - - - - - - - - - - . . . .',
);

/** A pickup into the hook (last bar of whatever precedes it, over the V chord). */
export const HOOK_PICKUP = seq(rest(12), 'A4 - C#5 -');

/** Hook bass roots, low octave, one per bar. */
export const HOOK_ROOTS = ['Bb1', 'C2', 'D2', 'A1', 'Bb1', 'C2', 'A1', 'D2'] as const;
