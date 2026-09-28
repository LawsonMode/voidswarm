// Composer toolkit for the Voidswarm songs: pure step-string builders (no engine code, no audio).
// Everything here returns plain step strings in the format.ts grammar, so the songs stay data.
import { hold, rep, rest, seq } from '../format';
import { midiToName, parseChordSymbol, parseNoteName, pcName } from '../theory';

export { hold, rep, rest, seq };

// ---------------------------------------------------------------------------------------------
// Pitch arithmetic and transposition
// ---------------------------------------------------------------------------------------------

/** A note name moved by `semis` semitones: tr('D2', 12) → 'D3', tr('A1', 7) → 'E2'. Flats for black keys. */
export function tr(note: string, semis: number): string {
  const m = parseNoteName(note);
  if (m === null) throw new Error(`lib.tr: bad note name "${note}"`);
  return midiToName(m + semis, true);
}

const NOTE_RE = /^([A-G][#b]?)(\d)$/;

/** Transpose ONE pitch token (flags stripped). Degrees and octave-less names are key-relative, so they stay. */
function transposePitch(p: string, semis: number): string {
  if (p.startsWith('@')) {
    const m = /^@([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(p);
    const ch = parseChordSymbol(p);
    if (!m || !ch) throw new Error(`lib.transpose: bad chord symbol "${p}"`);
    const root = pcName(ch.rootPc + semis, true);
    const bass = ch.bassPc === null ? '' : `/${pcName(ch.bassPc + semis, true)}`;
    return `@${root}${m[2]}${bass}`;
  }
  if (p.includes('+')) return p.split('+').map((q) => transposePitch(q, semis)).join('+');
  if (NOTE_RE.test(p)) return tr(p, semis);
  return p;
}

/**
 * Transpose a whole step string by `semis` semitones: note names ('Bb4') and chord symbols ('@Dm',
 * '@F/A') move, rests / holds / flags / bar lines are kept, and degree tokens are left alone (they
 * already follow the key). This is how the Voidswarm hook, written once in D minor, is re-keyed
 * for other songs at authoring time.
 */
export function transpose(steps: string, semis: number): string {
  if (semis === 0) return steps;
  return steps.split(/(\s+)/).map((tok) => {
    if (tok.trim() === '' || tok === '.' || tok === '-' || tok === '|') return tok;
    const m = /^(.*?)([!?~]*)$/.exec(tok)!;
    return transposePitch(m[1]!, semis) + m[2]!;
  }).join('');
}

// ---------------------------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------------------------

/** One chord (or note) per bar: perBar('@Am', '@F') → two bars of held chords. */
export function perBar(...toks: readonly string[]): string {
  return seq(...toks.map((t) => hold(t, 16)));
}

/** Held tokens with explicit lengths in steps: held(['@Asus4', 8], ['@A', 8]) → one bar. */
export function held(...parts: readonly (readonly [string, number])[]): string {
  return seq(...parts.map(([t, n]) => hold(t, n)));
}

/** A brass/pluck hit on beat 1 held a dotted 8th+, and an answer on the "and" of 3. One bar. */
export function stab(chord: string): string {
  return `${chord}! - - - - . . . . . ${chord} - . . . .`;
}

// ---------------------------------------------------------------------------------------------
// Bass figures (one bar = 16 steps each)
// ---------------------------------------------------------------------------------------------

/** Root, octave, fifth, octave on 16ths: the arpeggiated synth-rock bass. */
export function bassArp(root: string): string {
  const o = tr(root, 12);
  const f = tr(root, 7);
  return seq(`${root}! ${o} ${f} ${o}`, rep(`${root} ${o} ${f} ${o}`, 3));
}

/** 3+3+2 gallop on the root and its octave, accents on the 3+3+2 pulses. */
export function bassGallop(root: string): string {
  const o = tr(root, 12);
  return rep(`${root}! ${root}? ${o} ${root}! ${root}? ${o} ${root}! ${o}`, 2);
}

/** Straight 16th octaves (accent on the downbeat). */
export function bassOctaves(root: string): string {
  const o = tr(root, 12);
  return seq(`${root}! ${o}`, rep(`${root} ${o}`, 7));
}

/** A pedal note on every 8th and a melodic upper line (8 notes) on the off-16ths. */
export function bassPedal(pedal: string, upper: string): string {
  const u = upper.trim().split(/\s+/);
  if (u.length !== 8) throw new Error(`lib.bassPedal: need 8 upper notes, got ${u.length}`);
  return u.map((x, i) => `${pedal}${i === 0 ? '!' : ''} ${x}`).join(' ');
}

/**
 * The boss's 16th-note menace riff: pedal root with its octave, three passing notes (a, b, c)
 * on the weak 16ths of beats 2, 4 and 4-and.
 */
export function bassRiff(root: string, a: string, b: string, c: string): string {
  const o = tr(root, 12);
  return `${root}! ${root} ${o} ${root} ${root} ${o} ${root} ${a} ${root}! ${root} ${o} ${root} ${b} ${root} ${c} ${root}`;
}

/** Quarter-note roots with an octave pickup (half-time sections). */
export function bassQuarters(root: string): string {
  const o = tr(root, 12);
  return `${root}! - - - ${root} - - - ${root} - - - ${root} - ${o} -`;
}

// ---------------------------------------------------------------------------------------------
// Arps (one bar each)
// ---------------------------------------------------------------------------------------------

/** 16th up/down roll over four chord tones: a b c d c b | a b c d c b | a b c d. */
export function roll(a: string, b: string, c: string, d: string): string {
  return seq(rep(`${a} ${b} ${c} ${d} ${c} ${b}`, 2), `${a} ${b} ${c} ${d}`);
}

/** Straight 16th up-roll: a b c d ×4. */
export function rollUp(a: string, b: string, c: string, d: string): string {
  return rep(`${a} ${b} ${c} ${d}`, 4);
}

// ---------------------------------------------------------------------------------------------
// Chains (section.play arrays of 1-bar pattern ids)
// ---------------------------------------------------------------------------------------------

/** ['id', 'id', …] n times. */
export function times(id: string, n: number): string[] {
  return Array.from({ length: n }, () => id);
}

/** An 8-bar drum lane: 7 bars of `groove` and `fill` in the 8th bar. */
export function eight(groove: string, fill: string): string[] {
  return [...times(groove, 7), fill];
}

/** One `first` bar (e.g. a crash) followed by n-1 bars of `then`. */
export function firstThen(first: string, then: string, n: number): string[] {
  return [first, ...times(then, n - 1)];
}
