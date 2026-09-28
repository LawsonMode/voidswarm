// Placeholder songs: short and ORIGINAL, written only to exercise the engine (layers, the
// section transpose key change, fills, stingers, non-looping stingers-as-songs). The composer's
// songs replace these in songs/index.ts.
import { hold, rep, rest, seq, type Song, type TrackDef, type TransitionKind } from '../format';

const TRACKS: readonly TrackDef[] = [
  { id: 'pad', inst: 'pad', octave: 4 },
  { id: 'bass', inst: 'bass', octave: 1 },
  { id: 'kick', inst: 'kick' },
  { id: 'snare', inst: 'snare' },
  { id: 'hat', inst: 'hat' },
  { id: 'tom', inst: 'tom' },
  { id: 'arp', inst: 'arp', octave: 5, pan: 0.2 },
  { id: 'bell', inst: 'bell', octave: 5, pan: -0.25 },
  { id: 'brass', inst: 'brass', octave: 4 },
  { id: 'lead', inst: 'lead', octave: 5 },
  { id: 'crash', inst: 'crash' },
];

// i – bVI – bVII – V (harmonic-minor V for tension), one chord per bar.
const PAD_VERSE = seq(hold('@Am', 16), hold('@F', 16), hold('@G', 16), hold('@E', 16));
const PAD_CHORUS = seq(hold('@F', 16), hold('@G', 16), hold('@Am', 32), hold('@F', 16), hold('@G', 16), hold('@E', 32));

const bassBar = (lo: string, hi: string, tail?: string): string =>
  seq(rep(`${lo} ${lo} ${hi} ${lo}`, 3), tail ?? `${lo} ${lo} ${hi} ${lo}`);

const BASS_VERSE = seq(bassBar('A1', 'A2'), bassBar('F1', 'F2'), bassBar('G1', 'G2'), bassBar('E1', 'E2', 'E1 E2 G#1 B1'));
const BASS_CHORUS = seq(
  bassBar('F1', 'F2'), bassBar('G1', 'G2'), bassBar('A1', 'A2'), bassBar('A1', 'A2', 'A1 A2 C2 E2'),
  bassBar('F1', 'F2'), bassBar('G1', 'G2'), bassBar('E1', 'E2'), bassBar('E1', 'E2', 'E1 G#1 B1 D2'),
);

const ARP_VERSE = seq(rep('A4 C5 E5 C5', 4), rep('F4 A4 C5 A4', 4), rep('G4 B4 D5 B4', 4), rep('E4 G#4 B4 G#4', 4));
const ARP_CHORUS = seq(
  rep('F4 A4 C5 A4', 4), rep('G4 B4 D5 B4', 4), rep('A4 C5 E5 C5', 8),
  rep('F4 A4 C5 A4', 4), rep('G4 B4 D5 B4', 4), rep('E4 G#4 B4 G#4', 8),
);

// Heroic lead: a rising two-bar sequence, a held top note with a glide, then an answer.
const LEAD_CHORUS = seq(
  'A4 - - - C5 - - - F5 - - - E5 - D5 -',
  'D5 - - - B4 - - - G5 - - - F5 - E5 -',
  'E5 - - - - - - - A5~ - - - - - G5 -',
  'E5 - - - - - - - - - - - . . . .',
  'A4 - - - C5 - - - F5 - - - A5 - G5 -',
  'G5 - - - D5 - - - B5 - - - A5 - G5 -',
  'G#5 - - - - - - - B5~ - - - G#5 - E5 -',
  'E5 - - - - - - - - - - - . . . .',
);

const BRASS_STABS = seq(
  '@F . . . . . @F . . . @F - . . . .', '@G . . . . . @G . . . @G - . . . .',
  '@Am . . . . . @Am . . . @Am - . . . .', '@Am . . . . . @Am . . . @C - @E - . .',
);

function placeholder(title: string, bpm: number, opts: { min?: number; max?: number; transition?: TransitionKind } = {}): Song {
  return {
    title,
    bpm,
    timeSig: '4/4',
    key: 'A',
    mode: 'aeolian',
    intensity: { min: opts.min ?? 0, max: opts.max ?? 1 },
    transition: opts.transition ?? 'fill',
    delay: { time: '8d', feedback: 0.34 },
    tracks: TRACKS,
    patterns: {
      padVerse: PAD_VERSE,
      padChorus: PAD_CHORUS,
      bassVerse: BASS_VERSE,
      bassChorus: BASS_CHORUS,
      kick: 'x . . . x . . . x . . . x . x .',
      snare: '. . . . x . . . . . . . x . . .',
      hat: 'x . x . x . x . x . x . x . o .',
      tomFill: seq(rest(16 * 7), '. . . . . . . . h h m m l l f f'),
      arpVerse: ARP_VERSE,
      arpChorus: ARP_CHORUS,
      bellIntro: seq('A5 . . E6 . . C6 . . . . . . . . .', rest(16), 'G5 . . D6 . . B5 . . . . . . . . .', rest(16)),
      brass: BRASS_STABS,
      lead: LEAD_CHORUS,
      crash4: seq('X', rest(63)),
    },
    sections: {
      intro: { bars: 4, play: { pad: 'padVerse', bass: 'bassVerse', bell: 'bellIntro' }, intensity: -0.15 },
      verse: { bars: 8, play: { pad: 'padVerse', bass: 'bassVerse', kick: 'kick', snare: 'snare', hat: 'hat', tom: 'tomFill', arp: 'arpVerse', bell: 'bellIntro' } },
      chorus: { bars: 8, play: { pad: 'padChorus', bass: 'bassChorus', kick: 'kick', snare: 'snare', hat: 'hat', tom: 'tomFill', arp: 'arpChorus', brass: 'brass', lead: 'lead', crash: 'crash4' } },
      final: { bars: 8, transpose: 2, intensity: 0.1, play: { pad: 'padChorus', bass: 'bassChorus', kick: 'kick', snare: 'snare', hat: 'hat', tom: 'tomFill', arp: 'arpChorus', brass: 'brass', lead: 'lead', crash: 'crash4' } },
    },
    form: ['intro', 'verse', 'chorus', 'verse', 'final'],
    loopTo: 1,
  };
}

export const PLACEHOLDER: Song = placeholder('Placeholder Drive', 148);
export const PLACEHOLDER_TITLE: Song = placeholder('Placeholder Title', 148, { min: 0.55 });
export const PLACEHOLDER_MENU: Song = placeholder('Placeholder Menu', 120, { max: 0.55, transition: 'fade' });
export const PLACEHOLDER_BOSS: Song = placeholder('Placeholder Boss', 160, { min: 0.5, transition: 'both' });

/** A two-bar fanfare that plays once (victory). */
export const PLACEHOLDER_VICTORY: Song = {
  title: 'Placeholder Victory',
  bpm: 140,
  key: 'A',
  mode: 'ionian',
  loop: false,
  transition: 'fill',
  intensity: { min: 1, max: 1 },
  tracks: [
    { id: 'brass', inst: 'brass', octave: 4, layer: 'base' },
    { id: 'pad', inst: 'pad', octave: 4 },
    { id: 'bass', inst: 'bass', octave: 1 },
    { id: 'kick', inst: 'kick', layer: 'base' },
    { id: 'snare', inst: 'snare', layer: 'base' },
    { id: 'crash', inst: 'crash', layer: 'base' },
  ],
  patterns: {
    brass: seq('@A . . @A . . @D - - - @E - - - . .', hold('@A', 16)),
    pad: seq(hold('@A', 8), hold('@D', 4), hold('@E', 4), hold('@A', 16)),
    bass: seq('A1 . . A1 . . D2 - - - E2 - - - . .', hold('A1', 16)),
    kick: seq('x . . x . . x . . . x . . . . .', 'x . . . . . . . . . . . . . . .'),
    snare: seq('. . . . . . . . . . . . x x x x', 'X . . . . . . . . . . . . . . .'),
    crash: seq(rest(16), 'X', rest(15)),
  },
  sections: { outro: { bars: 2, kind: 'outro', play: { brass: 'brass', pad: 'pad', bass: 'bass', kick: 'kick', snare: 'snare', crash: 'crash' } } },
  form: ['outro'],
};

/** A slow two-chord lament that plays once (defeat). */
export const PLACEHOLDER_DEFEAT: Song = {
  title: 'Placeholder Defeat',
  bpm: 84,
  key: 'A',
  mode: 'aeolian',
  loop: false,
  transition: 'fade',
  tracks: [
    { id: 'pad', inst: 'pad', octave: 4 },
    { id: 'bell', inst: 'bell', octave: 5, layer: 'base' },
    { id: 'bass', inst: 'bass', octave: 1, tone: { decay: 0.8, sustain: 0.7, cutoff: 120, envAmount: 600 } },
  ],
  patterns: {
    pad: seq(hold('@Am', 16), hold('@F/A', 16), hold('@Dm', 16), hold('@Esus4', 8), hold('@E', 8)),
    bell: seq('E6 . . . C6 . . . A5 . . . . . . .', rest(48)),
    bass: seq(hold('A1', 16), hold('A1', 16), hold('D2', 16), hold('E1', 16)),
  },
  sections: { outro: { bars: 4, kind: 'outro', play: { pad: 'pad', bell: 'bell', bass: 'bass' } } },
  form: ['outro'],
};
