// Music theory helpers (pure: no WebAudio, no DOM) — note names, modes, degrees, chord symbols.
import type { Mode } from './format';

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Semitone offsets of each seven-note mode, degree 1..7. */
export const MODES: Readonly<Record<Mode, readonly number[]>> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
};

/** Chord-symbol qualities → intervals above the root (semitones). */
export const CHORD_QUALITIES: Readonly<Record<string, readonly number[]>> = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  '5': [0, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sus: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '+': [0, 4, 8],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  '7sus4': [0, 5, 7, 10],
};

export function isMode(m: string): m is Mode {
  return Object.prototype.hasOwnProperty.call(MODES, m);
}

/** 'A' → 9, 'C#' → 1, 'Eb' → 3, 'Cb' → 11, 'E#' → 5. null when malformed. */
export function parsePitchClass(s: string): number | null {
  const m = /^([A-G])([#b]?)$/.exec(s);
  if (!m) return null;
  const base = LETTER_PC[m[1]!]!;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (base + acc + 12) % 12;
}

/**
 * Note name → MIDI. 'C4' = 60, 'A4' = 69, 'Eb3' = 51, 'B#3' = 60, 'Cb4' = 59.
 * An octave-less name ('Bb') uses `defaultOctave` (C-based octave window). null when malformed.
 */
export function parseNoteName(s: string, defaultOctave?: number): number | null {
  const m = /^([A-G])([#b]?)(\d)?$/.exec(s);
  if (!m) return null;
  const oct = m[3] !== undefined ? Number(m[3]) : defaultOctave;
  if (oct === undefined) return null;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (oct + 1) + LETTER_PC[m[1]!]! + acc;
}

/**
 * Scale degree → MIDI. `degree` is 1-based and may exceed 7 (8 = tonic up an octave).
 * `acc` = -1 flat / +1 sharp, `octShift` = whole octaves. Degree 1 at `baseOctave` in key A = A<baseOctave>.
 */
export function degreeToMidi(degree: number, acc: number, octShift: number, tonicPc: number, mode: Mode, baseOctave: number): number {
  const scale = MODES[mode];
  const d = degree - 1;
  const oct = Math.floor(d / 7);
  const idx = ((d % 7) + 7) % 7;
  return 12 * (baseOctave + 1) + tonicPc + scale[idx]! + 12 * oct + acc + 12 * octShift;
}

export interface ChordSymbol {
  rootPc: number;
  intervals: readonly number[];
  bassPc: number | null;
}

/** '@Am', 'Am', 'F/A', 'Esus4', 'Bbmaj7' → parsed chord (the leading '@' is optional). null when malformed. */
export function parseChordSymbol(sym: string): ChordSymbol | null {
  const s = sym.startsWith('@') ? sym.slice(1) : sym;
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(s);
  if (!m) return null;
  // 'Bb' root vs 'b' in quality: the root regex is greedy on [#b], so 'Bbm' → root 'Bb', quality 'm'.
  const rootPc = parsePitchClass(m[1]!);
  if (rootPc === null) return null;
  const intervals = CHORD_QUALITIES[m[2]!];
  if (!intervals) return null;
  let bassPc: number | null = null;
  if (m[3] !== undefined) {
    bassPc = parsePitchClass(m[3]);
    if (bassPc === null) return null;
  }
  return { rootPc, intervals, bassPc };
}

/**
 * Voice a chord at a base octave.
 *  'fold': every tone folded into [C(baseOctave), C(baseOctave+1)) — smooth voice-leading.
 *  'root': root placed in that window, the other tones stacked above it.
 * A slash bass is added one octave below the window. Output is sorted and de-duplicated.
 */
export function voiceChord(ch: ChordSymbol, baseOctave: number, voicing: 'fold' | 'root' = 'fold'): number[] {
  const lo = 12 * (baseOctave + 1);
  const out: number[] = [];
  const rootMidi = lo + ch.rootPc;
  for (const iv of ch.intervals) {
    if (voicing === 'root') out.push(rootMidi + iv);
    else out.push(lo + ((ch.rootPc + iv) % 12));
  }
  if (ch.bassPc !== null) out.push(lo - 12 + ch.bassPc);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The triad a chord (MIDI notes, any voicing) is built on, for fitting a stinger to it: the first
 * candidate root (the bass note, then the chord notes from the bottom up) whose perfect 5th and
 * exactly one 3rd (major or minor) are in the chord. Rootless voicings work when the bass is given
 * (Dm9 = F A C E over a D bass → D minor). null when there is no plain triad (sus, dim, 5, …).
 */
export function chordTriad(notes: readonly number[], bass: number | null = null): { root: number; minor: boolean } | null {
  const pc = (m: number): number => ((m % 12) + 12) % 12;
  const pcs = new Set(notes.map(pc));
  if (bass !== null) pcs.add(pc(bass));
  const cands = [...(bass !== null ? [bass] : []), ...[...notes].sort((a, b) => a - b)];
  for (const m of cands) {
    const r = pc(m);
    if (!pcs.has((r + 7) % 12)) continue;
    const minor = pcs.has((r + 3) % 12);
    const major = pcs.has((r + 4) % 12);
    if (minor !== major) return { root: r, minor };
  }
  return null;
}

/** Move a note to the nearest pitch class in `pcs` within a whole step (down first); unchanged otherwise. */
export function snapToPcs(m: number, pcs: ReadonlySet<number>): number {
  const pc = (x: number): number => ((x % 12) + 12) % 12;
  if (pcs.size === 0 || pcs.has(pc(m))) return m;
  for (const d of [-1, 1, -2, 2]) if (pcs.has(pc(m + d))) return m + d;
  return m;
}

/** Pitch classes (0..11) of a key + mode. */
export function scalePcs(tonicPc: number, mode: Mode): Set<number> {
  return new Set(MODES[mode].map((s) => (tonicPc + s) % 12));
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function pcName(pc: number, flats = false): string {
  const i = ((pc % 12) + 12) % 12;
  return (flats ? NAMES_FLAT : NAMES_SHARP)[i]!;
}

export function midiToName(m: number, flats = false): string {
  return `${pcName(m, flats)}${Math.floor(m / 12) - 1}`;
}
