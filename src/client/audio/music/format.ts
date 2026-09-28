/**
 * Voidswarm music: the SONG DATA FORMAT.
 * =======================================
 *
 * This file describes everything a composer needs. You do not have to read the engine. A song is
 * a plain typed object (`Song`), exported from `songs/<name>.ts` and registered in `songs/index.ts`.
 * All sound is synthesized at runtime, so a song contains no audio files. Run
 * `npx vitest run src/client/audio/music` to validate every registered song. The song test fails
 * on any format error and prints warnings (range, polyphony, pattern-length mismatches).
 *
 * COPYRIGHT: write ORIGINAL music only. Style, instrumentation, tempo and harmonic vocabulary are
 * fine. Existing melodies, riffs and basslines are not.
 *
 * ----------------------------------------------------------------------------------------------
 * 1. TIME
 * ----------------------------------------------------------------------------------------------
 *  - Always 4/4 with straight 16ths (no swing). One STEP = one 16th note, 4 steps = 1 beat,
 *    16 steps = 1 bar.
 *  - `bpm` is quarter notes per minute. The engine clock is sample-accurate. The whole song
 *    keeps one tempo, and a transition to another song may change it.
 *
 * ----------------------------------------------------------------------------------------------
 * 2. STRUCTURE:  Song → form → Sections → (per track) Patterns
 * ----------------------------------------------------------------------------------------------
 *  - `tracks`: the band. Each track has an `id`, an instrument (`inst`), a base `octave`, and an
 *    intensity `layer`, among other settings.
 *  - `patterns`: a library of named musical phrases. A pattern is not tied to a track, so the same
 *    pattern can be reused by several tracks. Each track resolves the pitches with its own octave.
 *  - `sections`: named blocks that are a whole number of bars long (`bars`). `play` maps
 *    trackId → pattern id, or an array of pattern ids (a CHAIN played in order). The pattern or
 *    chain LOOPS to fill the section and is cut at the section end. A track missing from `play`
 *    is silent in that section.
 *  - `form`: the order of sections, e.g. `['intro', 'verse', {section: 'chorus', repeat: 2}, 'final']`.
 *    With `loop` (default true), the song jumps back to form index `loopTo` (default 0) after the
 *    last entry. Set `loopTo: 1` to skip the intro on repeats. When `loop: false` (stingers-as-songs
 *    like victory/defeat), the song plays once and then stops.
 *  - `transpose` on a section shifts every pitched note by N semitones. Use it for the key change,
 *    e.g. a final chorus with `transpose: 2`, a whole step up. Drums are unaffected.
 *
 * ----------------------------------------------------------------------------------------------
 * 3. STEP STRINGS: the fast way to write patterns
 * ----------------------------------------------------------------------------------------------
 *  A pattern is usually a string. There is ONE whitespace-separated token per 16th step. Bar
 *  lines `|` are ignored, so use them freely for readability. The pattern length is the token
 *  count.
 *
 *    .        rest
 *    -        hold: extend the previous note (or chord) by one more step
 *    C4 Eb3 F#2 Bb1   note name + octave (scientific pitch: C4 = MIDI 60 = middle C)
 *    A  Eb    note name with NO octave: uses the track's `octave`
 *    1 .. 14  SCALE DEGREE in the song's key + mode, counted from the track's `octave`
 *             (1 = tonic, 8 = tonic an octave up, 10 = the 3rd an octave up)
 *    b3 #4 b7 degree with an accidental. Lowercase `b` = flat, `#` = sharp.
 *             (Note names are always UPPERCASE: `B3` is the note B3, `b3` is the flat-3rd degree.)
 *    5_ 1^ 3__  degree octave shift: each `^` = one octave up, each `_` = one octave down
 *    A3+C4+E4   several pitches at once (a chord) joined with `+`. Degrees work too: `1+3+5`
 *    @Am @F/A @Esus4 @G5 @Dm7   CHORD SYMBOL (prefix `@`, see §4), voiced from the track octave
 *
 *  Per-note suffix flags (after the pitch, combinable):
 *    !   accent (velocity 1.0)       ?   ghost (velocity 0.5)       default velocity 0.8
 *    ~   glide INTO this note (portamento). On mono instruments (bass, lead) it is also LEGATO:
 *        if the previous note is still held, the envelope is not retriggered.
 *
 *  Example, one bar of 16th pumping bass in A minor (track octave 2):
 *    'A1 A2 A1 A2  A1 A2 A1 A2 | F1 F2 F1 F2  G1 G2 G1 G2'
 *  The same bar with degrees (octave 1): '1 8 1 8 1 8 1 8 | 6 13 6 13 7 14 7 14'
 *
 *  JS helpers are fine; a song is TypeScript. For example `rep('A1 A2 ', 8)` from `format.ts`
 *  gives 16 steps.
 *
 * ----------------------------------------------------------------------------------------------
 * 4. CHORD SYMBOLS  (`@` + root + quality + optional `/bass`)
 * ----------------------------------------------------------------------------------------------
 *  root: A-G with an optional # or b.   qualities: (none)=major  m  5  sus2  sus4 (or sus)
 *  dim  aug (or +)  6  m6  7  maj7  m7  m7b5  dim7  add9  madd9  9  m9  7sus4
 *  `/X` adds bass note X below the chord (e.g. @F/A, @G/B).
 *  Voicing (track `voicing`):
 *    'fold' (default): every chord tone is folded into ONE octave window starting at C of the
 *                      track octave. You get smooth voice-leading for free (pads, brass).
 *    'root': root position, stacked upward from the root inside that octave.
 *  Chord symbols are absolute pitch classes, and section `transpose` still applies.
 *  Mode matters only for DEGREE tokens.
 *
 * ----------------------------------------------------------------------------------------------
 * 5. DRUM TRACKS  (inst = kick | snare | clap | hat | ohat | tom | crash)
 * ----------------------------------------------------------------------------------------------
 *  Tokens:  x = hit   X = accented hit   . or - = rest.  `!` / `?` suffixes work as above.
 *    hat:  x = closed hat, o / O = open hat (a following closed hat chokes it, like a real hi-hat)
 *    tom:  h m l f = high / mid / low / floor tom   (x = mid)
 *  The snare, clap and toms are sent into the signature 80s GATED REVERB automatically.
 *  Kicks make the pads and bass "pump" (sidechain ducking); `Song.pump` sets the depth.
 *  Example:   kick 'x . . . x . . . x . . . x . . .'   snare '. . . . x . . . . . . . x . . .'
 *
 * ----------------------------------------------------------------------------------------------
 * 6. INSTRUMENTS  (all are synthesized; defaults are pre-balanced, so `gain: 1` is the norm)
 * ----------------------------------------------------------------------------------------------
 *   bass   mono saw + sub-square, resonant lowpass with a fast "plucky" filter envelope.
 *          Built for 16th-note pumping arp bass. Default octave 2.
 *   pad    5-voice detuned supersaw per note, slow attack, lowpass that opens with intensity,
 *          and a Juno-style stereo chorus. Default octave 4.
 *   brass  detuned 3-saw stack with a filter swell: synth-brass stabs and fanfares. Default octave 4.
 *          (Pad and brass chords are pre-mixed into one loop per chord, so a 4-note chord costs the
 *          same as one note. A chord event shares one filter envelope, like a paraphonic synth.)
 *   lead   mono saw + pulse with portamento and delayed vibrato: the heroic lead. Default octave 5.
 *   pluck  bright saw pluck, short envelope (counter-lines, 8th/16th figures). Default octave 5.
 *   arp    resonant square arp blip, very short; lives in the ping-pong delay. Default octave 5.
 *   bell   FM sine-pair bell / glass (sparkle, intros). Default octave 6.
 *   kick snare clap hat ohat tom crash: the synthesized 80s kit. It is rendered once per session
 *          into velocity-layered samples (ghost ≈ 0.5 / normal 0.8 / accent 1.0), like the drum
 *          machines of the era: every hit sounds identical.
 *  Mono instruments (bass, lead) play only the LOWEST note of a chord.
 *  The pluck, arp and bell instruments also share one filter per track.
 *  Polyphony is capped at 24 transient voices overall, and the voice ending soonest is stolen
 *  past that. A pad/brass chord counts as one voice. Keep pad chords at 3 to 4 notes.
 *
 * ----------------------------------------------------------------------------------------------
 * 7. INTENSITY LAYERS  (the game drives intensity 0..1)
 * ----------------------------------------------------------------------------------------------
 *  Each track has a `layer` threshold. A track plays only while the effective intensity is at or
 *  above it. Layers switch on bar lines, so music never cuts mid-bar.
 *    'base'  0     always on (pads, bass)             'groove' 0.5   arps, plucks, open hats, toms
 *    'pulse' 0.25  hats / light percussion            'color'  0.65  bells, counter-melodies
 *    'drums' 0.35  kick + snare                       'hero'   0.8   lead, brass
 *                                                     'peak'   0.9   crash accents, extra doublings
 *  or any number 0..1. The effective intensity is computed as:
 *    eff = song.intensity.min + x * (song.intensity.max - song.intensity.min) + section.intensity
 *  where x is the game value. So a title song with `intensity: {min: 0.8}` is always big, and a
 *  breakdown section with `intensity: -0.4` thins out on its own.
 *
 * ----------------------------------------------------------------------------------------------
 * 8. TRANSITIONS and STINGERS
 * ----------------------------------------------------------------------------------------------
 *  A scene change switches songs on the next bar line of the playing song, at least one beat
 *  away. The INCOMING song's `transition` sets how:
 *    'fill'  (default) the outgoing song's drums play a fill in the last beat, then a crash on the downbeat
 *    'riser' a reverse-cymbal / noise swell up to the downbeat, then a crash
 *    'both'  fill + riser     'fade'  a one-bar crossfade, no drums     'cut'  a hard switch on the bar
 *  `fill` (optional) customises THIS song's fill when leaving it: drum lanes ending on the downbeat.
 *  `stingers.levelUp` is a one-shot phrase played over the music on the next 16th. Write it with
 *  DEGREES so it fits whatever key and section transpose is playing. A default exists
 *  (songs/stingers.ts). The same goes for `stingers.waveStart` (a PvE wave begins, next beat) and
 *  `stingers.bossIncoming` (a boss is about to spawn, next bar). Degree accidentals are relative
 *  to the mode, so a phrygian song overrides the defaults that spell a minor 2nd as 'b2'.
 *  A stinger can fire over ANY chord of the song, so a tonic triad would clash over the V or the
 *  VI. `follow: 'chord'` makes its degrees relative to the chord playing at that moment instead
 *  (levelUp and waveStart use it). The key-relative default suits deliberate dissonance.
 *
 * ----------------------------------------------------------------------------------------------
 * 9. EXPLICIT EVENTS  (when strings are not enough)
 * ----------------------------------------------------------------------------------------------
 *  A pattern can instead be `{ notes: NoteEvent[], length }`. `at` and `len` are in 16ths and
 *  may be fractional (at: 0.5 = a 32nd late, handy for flams, triplets, and 32nd-note fills).
 *  `p` is a MIDI number or any single pitch token from §3 (or an array for a chord). You can
 *  combine `steps` and `notes` in one pattern.
 */

// ---------------------------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------------------------

export type MelodicInstrument = 'bass' | 'pad' | 'brass' | 'lead' | 'pluck' | 'arp' | 'bell';
export type DrumInstrument = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'tom' | 'crash';
export type InstrumentId = MelodicInstrument | DrumInstrument;

export const MELODIC_INSTRUMENTS: readonly MelodicInstrument[] = ['bass', 'pad', 'brass', 'lead', 'pluck', 'arp', 'bell'];
export const DRUM_INSTRUMENTS: readonly DrumInstrument[] = ['kick', 'snare', 'clap', 'hat', 'ohat', 'tom', 'crash'];
/** Instruments that play one note at a time (portamento/legato capable). */
export const MONO_INSTRUMENTS: readonly InstrumentId[] = ['bass', 'lead'];

export function isDrum(inst: InstrumentId): inst is DrumInstrument {
  return (DRUM_INSTRUMENTS as readonly string[]).includes(inst);
}

// ---------------------------------------------------------------------------------------------
// Harmony
// ---------------------------------------------------------------------------------------------

/** Seven-note modes used to resolve scale-degree tokens. 'minor' = aeolian, 'major' = ionian. */
export type Mode =
  | 'ionian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'aeolian' | 'locrian'
  | 'harmonicMinor' | 'melodicMinor' | 'major' | 'minor';

/** Tonic pitch class: 'C', 'C#', 'Db', 'D', ... 'B' (uppercase letter, optional # or b). */
export type KeyName = string;

// ---------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------

/**
 * A pitch in an explicit NoteEvent: a MIDI number (60 = C4), or ANY single pitch token from the
 * step-string grammar ('C4', 'Bb', '5_', '#7', '1+3+5', '@Am'). Drum tracks: 'x', or 'h'/'m'/'l'/'f'
 * for toms, 'o' for an open hat.
 */
export type Pitch = number | string;

export interface NoteEvent {
  /** Start, in 16ths from the pattern start. Fractions are allowed (0.5 = a 32nd late). */
  at: number;
  /** Pitch, or several pitches (a chord). */
  p: Pitch | readonly Pitch[];
  /** Length in 16ths (default 1). */
  len?: number;
  /** Velocity 0..1 (default 0.8). */
  v?: number;
  /** Glide into this note (portamento; legato on mono instruments). */
  glide?: boolean;
}

export interface PatternDef {
  /** Step string (see the grammar in §3 at the top of this file). */
  steps?: string;
  /** Explicit events (in addition to, or instead of, `steps`). */
  notes?: readonly NoteEvent[];
  /**
   * Length in 16ths. Defaults to the number of step tokens, or, when only `notes` is given,
   * the end of the last note rounded up to a whole bar.
   */
  length?: number;
}

/** A pattern is a step string (the common case) or a PatternDef. */
export type Pattern = string | PatternDef;

// ---------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------

/** Named intensity layers (see §7). A number 0..1 works as well. */
export type LayerTag = 'base' | 'pulse' | 'drums' | 'groove' | 'color' | 'hero' | 'peak';

export const LAYER_THRESHOLD: Readonly<Record<LayerTag, number>> = {
  base: 0, pulse: 0.25, drums: 0.35, groove: 0.5, color: 0.65, hero: 0.8, peak: 0.9,
};

/** Optional sound tweaks. Each instrument uses the fields that apply to it and ignores the rest. */
export interface ToneParams {
  /** Base lowpass cutoff, Hz. */
  cutoff?: number;
  /** Filter resonance (WebAudio Q, dB-ish for lowpass: 0 = none, 12 = squelchy). */
  resonance?: number;
  /** Extra cutoff (Hz) added at the peak of the filter envelope. */
  envAmount?: number;
  /** Amp envelope, seconds / level 0..1. */
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  /** Mono instruments: portamento time (s) for `~` glides. */
  glide?: number;
  /** Lead: vibrato depth in cents (0 = off) and the delay before it fades in (s). */
  vibrato?: number;
  vibratoDelay?: number;
  /** Fraction of the note length that is held before release (0.1..1). Default is per instrument. */
  gate?: number;
}

export interface TrackDef {
  /** Unique within the song; referenced by `Section.play`. */
  id: string;
  inst: InstrumentId;
  /** Base octave for degree tokens, octave-less note names, and chord symbols. Default is per instrument (§6). */
  octave?: number;
  /** Intensity threshold (§7). Default is per instrument (bass/pad base, drums 'drums', lead/brass 'hero'...). */
  layer?: LayerTag | number;
  /** Linear gain multiplier on the pre-balanced instrument level (default 1). */
  gain?: number;
  /** Stereo position -1..1 (default 0; the pad is stereo already). */
  pan?: number;
  /** Send amounts 0..1 to the tempo-synced ping-pong delay and the hall reverb (defaults per instrument). */
  delay?: number;
  reverb?: number;
  /** Pump (sidechain duck) on each kick. Default: true for pad and bass. */
  duck?: boolean;
  /** Chord-symbol voicing (default 'fold'). */
  voicing?: 'fold' | 'root';
  tone?: ToneParams;
}

// ---------------------------------------------------------------------------------------------
// Sections & form
// ---------------------------------------------------------------------------------------------

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'breakdown' | 'final' | 'outro';

export interface Section {
  /** Length in bars (whole number ≥ 1). */
  bars: number;
  /** Display label / role (defaults to the section's name when that is a SectionKind). */
  kind?: SectionKind;
  /** trackId → pattern id, or a chain of pattern ids played in order. Patterns loop to fill the section. */
  play: Readonly<Record<string, string | readonly string[]>>;
  /** Semitones added to every pitched note in this section (the key change). Default 0. */
  transpose?: number;
  /** Added to the effective intensity while this section plays (-1..1). Default 0. */
  intensity?: number;
}

export type FormEntry = string | { section: string; repeat?: number };

// ---------------------------------------------------------------------------------------------
// Stingers
// ---------------------------------------------------------------------------------------------

export interface StingerPart {
  inst: InstrumentId;
  /** Step string (degrees recommended: they follow the current key and transpose). */
  steps: string;
  octave?: number;
  gain?: number;
  delay?: number;
  reverb?: number;
}

export interface Stinger {
  /** Grid it waits for before playing (default 'step' = the next 16th). */
  quantize?: 'step' | 'beat' | 'bar';
  /**
   * What the degrees are relative to (default 'key'):
   *  'key'    the song's key, mode and section transpose where the stinger lands (for deliberately
   *           dissonant stingers, e.g. bossIncoming's semitone cluster)
   *  'chord'  the chord the song is playing at that moment (pad, else brass, over the bass): degree
   *           1 = its root, in major or minor to match its 3rd, so '1 3 5 8' arpeggiates the
   *           current chord. Notes that are still not chord tones (a sus or 7th chord) snap to the
   *           nearest chord tone. Use it for consonant, fire-anywhere stingers (levelUp).
   */
  follow?: 'key' | 'chord';
  parts: readonly StingerPart[];
  /** How much the song ducks under the stinger, 0..1 (default 0.25). */
  duck?: number;
}

/**
 * One-shot stingers the game can fire over any song (MusicDirector.playStinger):
 *   levelUp       the local player levelled up (next 16th)
 *   waveStart     a PvE wave begins (next beat)
 *   bossIncoming  a boss is about to spawn (next bar, 2 bars long)
 */
export type StingerId = 'levelUp' | 'waveStart' | 'bossIncoming';

// ---------------------------------------------------------------------------------------------
// Song
// ---------------------------------------------------------------------------------------------

/** Ping-pong delay time as a note value: '16' '8' '8d' (dotted 8th, the classic) '4' '8t' (8th triplet). */
export type DelayTime = '16' | '8' | '8d' | '8t' | '4';

export type TransitionKind = 'fill' | 'riser' | 'both' | 'fade' | 'cut';

export interface Song {
  title: string;
  bpm: number;
  /** Only 4/4 is supported; the field exists so the file says so. */
  timeSig?: '4/4';
  key: KeyName;
  mode: Mode;
  tracks: readonly TrackDef[];
  patterns: Readonly<Record<string, Pattern>>;
  sections: Readonly<Record<string, Section>>;
  form: readonly FormEntry[];
  /** Loop the form (default true). */
  loop?: boolean;
  /** Form index to jump back to when looping (default 0). */
  loopTo?: number;
  /** Maps the game's 0..1 intensity into [min, max] (defaults 0 and 1). */
  intensity?: { min?: number; max?: number };
  /** How this song is entered from another one (default 'fill'). */
  transition?: TransitionKind;
  /** This song's drum fill when it is left: lanes ending on the downbeat (≤ 16 steps each). */
  fill?: Partial<Record<'kick' | 'snare' | 'clap' | 'tom', string>>;
  /** Ping-pong delay settings (defaults: '8d', feedback 0.35). */
  delay?: { time?: DelayTime; feedback?: number };
  /** Hall reverb decay in seconds (default 2.2). */
  reverb?: { decay?: number };
  /** Sidechain pump depth on kicks, 0..1 (default 0.5). */
  pump?: number;
  /** Overall song gain multiplier (default 1). */
  gain?: number;
  stingers?: Partial<Record<StingerId, Stinger>>;
}

// ---------------------------------------------------------------------------------------------
// Scenes (what the game asks for)
// ---------------------------------------------------------------------------------------------

export type MusicScene = 'title' | 'command' | 'lobby' | 'match' | 'boss' | 'victory' | 'defeat';
export const MUSIC_SCENES: readonly MusicScene[] = ['title', 'command', 'lobby', 'match', 'boss', 'victory', 'defeat'];

// ---------------------------------------------------------------------------------------------
// Composer helpers
// ---------------------------------------------------------------------------------------------

/** Repeat a step-string fragment n times: rep('A1 A2 ', 8) → 16 steps. */
export function rep(fragment: string, n: number): string {
  return Array.from({ length: Math.max(0, n) }, () => fragment.trim()).join(' ');
}

/** Join fragments into one step string (readability helper). */
export function seq(...parts: readonly string[]): string {
  return parts.map((p) => p.trim()).join(' ');
}

/** A token held for `steps` 16ths: hold('@Am', 16) → '@Am - - - … -' (one bar). */
export function hold(token: string, steps: number): string {
  return steps <= 1 ? token : `${token}${' -'.repeat(steps - 1)}`;
}

/** `steps` rests: rest(16) → one empty bar. */
export function rest(steps: number): string {
  return Array.from({ length: Math.max(0, steps) }, () => '.').join(' ');
}
