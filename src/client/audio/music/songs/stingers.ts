// Default stingers, used when the playing song defines none. They are written in DEGREES so they
// always fit the current key, mode and section transpose. ORIGINAL material.
//
// levelUp and waveStart can fire over ANY chord, so they follow the CHORD (follow: 'chord'): their
// '1 3 5' is the triad of whatever chord is playing when they land, never a tonic triad grinding
// over the V or the VI. bossIncoming stays key-relative: its semitone cluster is meant to clash.
//
// Degree accidentals are relative to the MODE ('b2' = one semitone below the mode's 2nd), so a
// minor second above the tonic is 'b2' in aeolian / dorian / ionian songs but plain '2' in
// phrygian. The phrygian boss therefore carries its own bossIncoming (PHRYGIAN_STINGERS).
import type { Stinger, StingerId, StingerPart } from '../format';

/** Two semitone-cluster stabs, then a diminished chord ringing over floor toms and a tritone bell. */
function bossIncoming(minorSecond: string): Stinger {
  const parts: StingerPart[] = [
    { inst: 'brass', octave: 3, gain: 0.95, steps: `1+${minorSecond}! - - - - - . . 1+${minorSecond}! - - - - - . . | 1+3+b5! - - - - - - - - - - - - - - -` },
    // bar 2 is the hook's tresillo on the floor tom (kept lean: the stinger must fit the voice budget over a full mix)
    { inst: 'tom', steps: 'f! . . . . . f . f! . . . . . f . | f! . . f . . f . f . . . f . . .' },
    { inst: 'bass', octave: 1, gain: 0.9, steps: '1! - - - - - - - - - - - - - - - | 1! - - - - - - - - - - - - - - -' },
    { inst: 'crash', gain: 0.8, steps: '. . . . . . . . . . . . . . . . | X . . . . . . . . . . . . . . .' },
    { inst: 'bell', octave: 6, gain: 0.7, steps: '. . . . . . . . . . . . . . . . | 1 . . . . . . . b5 . . . . . . .' },
  ];
  return { quantize: 'bar', duck: 0.45, parts };
}

export const DEFAULT_STINGERS: Readonly<Record<StingerId, Stinger>> = {
  // Level-up: a quick rising arpeggio that lands on the triad of the chord playing.
  levelUp: {
    quantize: 'step',
    follow: 'chord',
    duck: 0.3,
    parts: [
      { inst: 'bell', octave: 5, steps: '1 3 5 8 - - - -', gain: 0.9 },
      { inst: 'pluck', octave: 5, steps: '. . . 8+10+12 - - . .', gain: 0.8 },
      { inst: 'brass', octave: 4, steps: '. . . 1+3+5 - - - .', gain: 0.75 },
    ],
  },
  // Wave start: a 16th tom pickup into a brass hit on the current chord, kick + crash on the next beat,
  // and a second, shorter hit on the "and" ("here they come").
  waveStart: {
    quantize: 'beat',
    follow: 'chord',
    duck: 0.3,
    parts: [
      { inst: 'tom', steps: 'h m l f . . . . . . . .' },
      { inst: 'kick', steps: '. . . . X . . . . . . .' },
      { inst: 'crash', gain: 0.85, steps: '. . . . X . . . . . . .' },
      { inst: 'brass', octave: 4, gain: 0.9, steps: '. . . . 1+3+5! - - . . . 1+3+5 -' },
      { inst: 'pluck', octave: 5, gain: 0.7, steps: '5_ 1 3 5 8 - - - - - - -' },
    ],
  },
  // Boss incoming: see bossIncoming() above (quantized to the bar, 2 bars long).
  bossIncoming: bossIncoming('b2'),
};

/** Stinger overrides for phrygian songs (the boss), where the minor 2nd is degree '2'. */
export const PHRYGIAN_STINGERS: Partial<Record<StingerId, Stinger>> = {
  bossIncoming: bossIncoming('2'),
};
