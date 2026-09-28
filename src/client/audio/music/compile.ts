// Song compiler + validator (pure: no WebAudio, no DOM).
// Song (authoring format, format.ts) → CompiledSong (flat per-step event tables the sequencer walks).
import {
  isDrum, LAYER_THRESHOLD, MONO_INSTRUMENTS,
  type DrumInstrument, type InstrumentId, type LayerTag, type Mode, type Pattern, type Pitch, type SectionKind,
  type Song, type ToneParams, type TrackDef,
} from './format';
import { degreeToMidi, isMode, parseChordSymbol, parseNoteName, parsePitchClass, scalePcs, voiceChord } from './theory';

// ---------------------------------------------------------------------------------------------
// Per-instrument authoring defaults (engine-independent)
// ---------------------------------------------------------------------------------------------

export interface InstrumentDefaults {
  octave: number;
  layer: LayerTag;
  delay: number;
  reverb: number;
  /** Send into the gated-reverb (drums). */
  gated: number;
  duck: boolean;
  /** Sensible MIDI range; notes outside produce a warning. */
  range: readonly [number, number];
}

export const INSTRUMENT_DEFAULTS: Readonly<Record<InstrumentId, InstrumentDefaults>> = {
  bass: { octave: 2, layer: 'base', delay: 0, reverb: 0.04, gated: 0, duck: true, range: [23, 67] },
  pad: { octave: 4, layer: 'base', delay: 0.08, reverb: 0.35, gated: 0, duck: true, range: [36, 96] },
  brass: { octave: 4, layer: 'hero', delay: 0.12, reverb: 0.28, gated: 0, duck: false, range: [36, 96] },
  lead: { octave: 5, layer: 'hero', delay: 0.26, reverb: 0.3, gated: 0, duck: false, range: [48, 100] },
  pluck: { octave: 5, layer: 'groove', delay: 0.28, reverb: 0.18, gated: 0, duck: false, range: [36, 108] },
  arp: { octave: 5, layer: 'groove', delay: 0.34, reverb: 0.14, gated: 0, duck: false, range: [36, 108] },
  bell: { octave: 6, layer: 'color', delay: 0.3, reverb: 0.4, gated: 0, duck: false, range: [48, 108] },
  kick: { octave: 0, layer: 'drums', delay: 0, reverb: 0, gated: 0, duck: false, range: [0, 127] },
  snare: { octave: 0, layer: 'drums', delay: 0, reverb: 0.08, gated: 0.9, duck: false, range: [0, 127] },
  clap: { octave: 0, layer: 'groove', delay: 0, reverb: 0.12, gated: 0.7, duck: false, range: [0, 127] },
  hat: { octave: 0, layer: 'pulse', delay: 0, reverb: 0, gated: 0, duck: false, range: [0, 127] },
  ohat: { octave: 0, layer: 'groove', delay: 0, reverb: 0.06, gated: 0, duck: false, range: [0, 127] },
  tom: { octave: 0, layer: 'groove', delay: 0, reverb: 0.1, gated: 0.75, duck: false, range: [0, 127] },
  crash: { octave: 0, layer: 'peak', delay: 0, reverb: 0.22, gated: 0, duck: false, range: [0, 127] },
};

/** Drum-lane tokens (pitch part, after the !/? flags are stripped) allowed per drum instrument. */
export const DRUM_TOKENS: Readonly<Record<DrumInstrument, string>> = {
  kick: 'xX', snare: 'xX', clap: 'xX', crash: 'xX',
  hat: 'xXoO', ohat: 'xXoO', tom: 'xXhmlfHMLF',
};

export const VEL_DEFAULT = 0.8;
export const VEL_ACCENT = 1;
export const VEL_GHOST = 0.5;
/** Poly-voice count above which the polyphony analysis warns (the engine cap is 24 incl. drums). */
export const POLY_WARN = 20;

// ---------------------------------------------------------------------------------------------
// Step-string parsing
// ---------------------------------------------------------------------------------------------

export interface RawEvent {
  at: number;
  /** Pitch part of the token (flags stripped), or an explicit Pitch / Pitch[]. */
  p: Pitch | readonly Pitch[];
  len: number;
  vel: number;
  glide: boolean;
}

export interface ParsedPattern {
  events: RawEvent[];
  length: number;
  errors: string[];
  warnings: string[];
}

/** Split a token into its pitch part and !?~ flags. */
export function splitFlags(tok: string): { pitch: string; vel: number; glide: boolean } {
  const m = /^(.*?)([!?~]*)$/.exec(tok)!;
  const flags = m[2]!;
  let vel = VEL_DEFAULT;
  if (flags.includes('!')) vel = VEL_ACCENT;
  else if (flags.includes('?')) vel = VEL_GHOST;
  return { pitch: m[1]!, vel, glide: flags.includes('~') };
}

export function tokenize(steps: string): string[] {
  return steps.replace(/\|/g, ' ').split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Parse a step string. Each token is one 16th; '.' rest; '-' hold. On drum lanes '-' is a rest.
 * Pitch validity is checked later, per track (it depends on octave/key/instrument).
 */
export function parseSteps(steps: string, drumLane = false): ParsedPattern {
  const toks = tokenize(steps);
  const events: RawEvent[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let last: RawEvent | null = null; // the note a '-' would extend (null after a rest)
  toks.forEach((tok, i) => {
    if (tok === '.') { last = null; return; }
    if (tok === '-') {
      if (drumLane) return;
      if (last) last.len += 1;
      else warnings.push(`step ${i}: hold '-' after a rest (ignored)`);
      return;
    }
    const f = splitFlags(tok);
    if (f.pitch.length === 0) { errors.push(`step ${i}: token "${tok}" has flags but no pitch`); last = null; return; }
    let vel = f.vel;
    if (drumLane && (f.pitch === 'X' || f.pitch === 'O' || /^[HMLF]$/.test(f.pitch)) && vel === VEL_DEFAULT) vel = VEL_ACCENT;
    const ev: RawEvent = { at: i, p: f.pitch, len: 1, vel, glide: f.glide };
    events.push(ev);
    last = ev;
  });
  return { events, length: toks.length, errors, warnings };
}

/** Parse any Pattern (string or PatternDef) into raw events + length. */
export function parsePattern(pat: Pattern, drumLane = false): ParsedPattern {
  if (typeof pat === 'string') return parseSteps(pat, drumLane);
  const out: ParsedPattern = { events: [], length: 0, errors: [], warnings: [] };
  let len = 0;
  if (pat.steps !== undefined) {
    const s = parseSteps(pat.steps, drumLane);
    out.events.push(...s.events);
    out.errors.push(...s.errors);
    out.warnings.push(...s.warnings);
    len = s.length;
  }
  let end = 0;
  for (const [i, n] of (pat.notes ?? []).entries()) {
    const l = n.len ?? 1;
    if (!Number.isFinite(n.at) || n.at < 0) { out.errors.push(`note ${i}: bad 'at' ${String(n.at)}`); continue; }
    if (!(l > 0)) { out.errors.push(`note ${i}: bad 'len' ${String(n.len)}`); continue; }
    const v = n.v ?? VEL_DEFAULT;
    if (!(v >= 0 && v <= 1)) out.warnings.push(`note ${i}: velocity ${v} clamped to 0..1`);
    out.events.push({ at: n.at, p: n.p, len: l, vel: Math.max(0, Math.min(1, v)), glide: !!n.glide });
    end = Math.max(end, n.at + l);
  }
  if (pat.length !== undefined) {
    if (!(Number.isInteger(pat.length) && pat.length > 0)) out.errors.push(`bad length ${String(pat.length)} (whole 16ths ≥ 1)`);
    else len = pat.length;
  } else if (pat.steps === undefined) {
    len = Math.max(16, Math.ceil(end / 16) * 16);
  }
  for (const e of out.events) if (e.at >= len && len > 0) out.warnings.push(`event at ${e.at} is past the pattern length ${len} (never plays)`);
  out.events.sort((a, b) => a.at - b.at);
  out.length = len;
  if (len <= 0) out.errors.push('pattern is empty (length 0)');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pitch resolution
// ---------------------------------------------------------------------------------------------

export interface PitchContext {
  tonicPc: number;
  mode: Mode;
  octave: number;
  voicing: 'fold' | 'root';
  transpose: number;
}

/**
 * Resolve one pitch token (or explicit Pitch) to MIDI notes (sorted). Throws Error with a message
 * describing the problem when the token is malformed.
 */
export function resolvePitch(p: Pitch | readonly Pitch[], c: PitchContext): number[] {
  if (Array.isArray(p)) {
    const all = (p as readonly Pitch[]).flatMap((q) => resolvePitch(q, c));
    return [...new Set(all)].sort((a, b) => a - b);
  }
  if (typeof p === 'number') {
    if (!Number.isInteger(p)) throw new Error(`MIDI pitch ${p} is not an integer`);
    return [p + c.transpose];
  }
  const s = p as string;
  if (s.startsWith('@')) {
    const ch = parseChordSymbol(s);
    if (!ch) throw new Error(`bad chord symbol "${s}"`);
    return voiceChord(ch, c.octave, c.voicing).map((m) => m + c.transpose);
  }
  const parts = s.split('+');
  if (parts.length > 1 && parts.every((x) => x.length > 0)) {
    return resolvePitch(parts, c);
  }
  // note name?
  if (/^[A-G]/.test(s)) {
    const m = parseNoteName(s, c.octave);
    if (m === null) throw new Error(`bad note name "${s}" (use e.g. C4, Eb3, F#2 or an octave-less A)`);
    return [m + c.transpose];
  }
  // scale degree?
  const dm = /^([b#]?)(\d+)([\^_]*)$/.exec(s);
  if (dm) {
    const deg = Number(dm[2]);
    if (deg < 1) throw new Error(`scale degree "${s}" must be ≥ 1`);
    const acc = dm[1] === 'b' ? -1 : dm[1] === '#' ? 1 : 0;
    let shift = 0;
    for (const ch of dm[3]!) shift += ch === '^' ? 1 : -1;
    return [degreeToMidi(deg, acc, shift, c.tonicPc, c.mode, c.octave) + c.transpose];
  }
  throw new Error(`bad pitch token "${s}"`);
}

/** Resolve a drum-lane token to its variant ('x' | 'o' | 'h' | 'm' | 'l' | 'f'). Throws on a bad token. */
export function resolveDrum(p: Pitch | readonly Pitch[], inst: DrumInstrument): string {
  if (typeof p === 'number' || Array.isArray(p)) {
    if (inst === 'tom' && typeof p === 'number') return p >= 50 ? 'h' : p >= 45 ? 'm' : p >= 41 ? 'l' : 'f';
    return 'x';
  }
  const s = p as string;
  if (s.length !== 1 || !DRUM_TOKENS[inst].includes(s)) {
    throw new Error(`bad ${inst} token "${s}" (allowed: ${[...new Set(DRUM_TOKENS[inst].toLowerCase())].join(' ')} + ! ?)`);
  }
  const v = s.toLowerCase();
  if (inst === 'tom') return v === 'x' ? 'm' : v;
  if (inst === 'hat' || inst === 'ohat') return inst === 'ohat' ? 'o' : v;
  return 'x';
}

// ---------------------------------------------------------------------------------------------
// Compiled structures
// ---------------------------------------------------------------------------------------------

export interface CEvent {
  /** Offset inside the step, as a fraction of a step (0 ≤ frac < 1). */
  frac: number;
  /** MIDI notes (empty for drums). */
  midi: readonly number[];
  /** Length in steps. */
  len: number;
  vel: number;
  glide: boolean;
  /** Drum variant ('' for melodic). */
  drum: string;
}

export interface CTrack {
  id: string;
  inst: InstrumentId;
  isDrum: boolean;
  mono: boolean;
  octave: number;
  threshold: number;
  gain: number;
  pan: number;
  delay: number;
  reverb: number;
  gated: number;
  duck: boolean;
  voicing: 'fold' | 'root';
  tone: ToneParams;
}

export interface CSection {
  name: string;
  kind: SectionKind | string;
  bars: number;
  steps: number;
  transpose: number;
  intensity: number;
  /** events[trackIndex][step] → events starting in that step (null = none). */
  events: (CEvent[] | null)[][];
}

export interface CompiledSong {
  song: Song;
  bpm: number;
  tonicPc: number;
  mode: Mode;
  tracks: CTrack[];
  sections: CSection[];
  /** Section index per timeline slot (form with repeats expanded). */
  timeline: number[];
  /** Form index → first timeline slot. */
  formSlot: number[];
  loop: boolean;
  loopToSlot: number;
  intensityMin: number;
  intensityMax: number;
}

export interface CompileResult {
  compiled: CompiledSong | null;
  errors: string[];
  warnings: string[];
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function layerValue(l: LayerTag | number | undefined, inst: InstrumentId): number {
  if (l === undefined) return LAYER_THRESHOLD[INSTRUMENT_DEFAULTS[inst].layer];
  if (typeof l === 'number') return clamp(l, 0, 1);
  return LAYER_THRESHOLD[l];
}

export function compileTrack(t: TrackDef): CTrack {
  const d = INSTRUMENT_DEFAULTS[t.inst];
  return {
    id: t.id,
    inst: t.inst,
    isDrum: isDrum(t.inst),
    mono: MONO_INSTRUMENTS.includes(t.inst),
    octave: t.octave ?? d.octave,
    threshold: layerValue(t.layer, t.inst),
    gain: t.gain ?? 1,
    pan: clamp(t.pan ?? 0, -1, 1),
    delay: clamp(t.delay ?? d.delay, 0, 1),
    reverb: clamp(t.reverb ?? d.reverb, 0, 1),
    gated: d.gated,
    duck: t.duck ?? d.duck,
    voicing: t.voicing ?? 'fold',
    tone: t.tone ?? {},
  };
}

const KNOWN_KINDS = new Set<string>(['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'breakdown', 'final', 'outro']);

// ---------------------------------------------------------------------------------------------
// compileSong
// ---------------------------------------------------------------------------------------------

/** Compile + validate. `compiled` is null when there are errors. */
export function compileSong(song: Song): CompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const E = (m: string): void => { errors.push(m); };
  const W = (m: string): void => { warnings.push(m); };

  if (!(song.bpm >= 40 && song.bpm <= 240)) E(`bpm ${song.bpm} out of range 40..240`);
  if (song.timeSig !== undefined && song.timeSig !== '4/4') E(`timeSig ${String(song.timeSig)}: only 4/4 is supported`);
  const tonicPc = parsePitchClass(song.key);
  if (tonicPc === null) E(`bad key "${song.key}" (use e.g. 'A', 'C#', 'Eb')`);
  if (!isMode(song.mode)) E(`unknown mode "${String(song.mode)}"`);

  // tracks
  const tracks: CTrack[] = [];
  const trackIdx = new Map<string, number>();
  for (const t of song.tracks) {
    if (!t.id) { E('track without id'); continue; }
    if (trackIdx.has(t.id)) { E(`duplicate track id "${t.id}"`); continue; }
    if (!(t.inst in INSTRUMENT_DEFAULTS)) { E(`track "${t.id}": unknown instrument "${String(t.inst)}"`); continue; }
    if (typeof t.layer === 'number' && !(t.layer >= 0 && t.layer <= 1)) W(`track "${t.id}": layer ${t.layer} clamped to 0..1`);
    if (typeof t.layer === 'string' && !(t.layer in LAYER_THRESHOLD)) E(`track "${t.id}": unknown layer tag "${t.layer}"`);
    if (t.octave !== undefined && !(Number.isInteger(t.octave) && t.octave >= 0 && t.octave <= 8)) E(`track "${t.id}": octave ${t.octave} must be an integer 0..8`);
    if (t.gain !== undefined && !(t.gain >= 0 && t.gain <= 4)) E(`track "${t.id}": gain ${t.gain} out of range 0..4`);
    trackIdx.set(t.id, tracks.length);
    tracks.push(compileTrack(t));
  }
  if (tracks.length === 0) E('song has no tracks');

  // patterns (parsed once per drum/melodic flavour, on demand)
  const parsedCache = new Map<string, ParsedPattern>();
  const reported = new Set<string>();
  const getParsed = (id: string, drum: boolean): ParsedPattern | null => {
    const pat = song.patterns[id];
    if (pat === undefined) return null;
    const key = `${drum ? 'd' : 'm'}:${id}`;
    let pp = parsedCache.get(key);
    if (!pp) {
      pp = parsePattern(pat, drum);
      parsedCache.set(key, pp);
      if (!reported.has(key)) {
        reported.add(key);
        for (const e of pp.errors) E(`pattern "${id}": ${e}`);
        for (const w of pp.warnings) W(`pattern "${id}": ${w}`);
      }
    }
    return pp;
  };
  const usedPatterns = new Set<string>();

  // sections
  const sectionNames = Object.keys(song.sections);
  const sections: CSection[] = [];
  const sectionIdx = new Map<string, number>();
  if (sectionNames.length === 0) E('song has no sections');
  for (const name of sectionNames) {
    const sec = song.sections[name]!;
    if (!(Number.isInteger(sec.bars) && sec.bars >= 1 && sec.bars <= 256)) { E(`section "${name}": bars ${sec.bars} must be an integer 1..256`); continue; }
    const transpose = sec.transpose ?? 0;
    if (!Number.isInteger(transpose) || Math.abs(transpose) > 24) E(`section "${name}": transpose ${transpose} must be an integer -24..24`);
    if (sec.intensity !== undefined && !(sec.intensity >= -1 && sec.intensity <= 1)) E(`section "${name}": intensity ${sec.intensity} must be -1..1`);
    const steps = sec.bars * 16;
    const events: (CEvent[] | null)[][] = tracks.map(() => new Array<CEvent[] | null>(steps).fill(null));
    for (const [tid, ref] of Object.entries(sec.play)) {
      const ti = trackIdx.get(tid);
      if (ti === undefined) { E(`section "${name}": unknown track "${tid}"`); continue; }
      const tr = tracks[ti]!;
      const chain = typeof ref === 'string' ? [ref] : [...ref];
      if (chain.length === 0) { W(`section "${name}" track "${tid}": empty chain`); continue; }
      const pctx: PitchContext = { tonicPc: tonicPc ?? 0, mode: isMode(song.mode) ? song.mode : 'aeolian', octave: tr.octave, voicing: tr.voicing, transpose: tr.isDrum ? 0 : transpose };
      // flatten the chain into (offset, parsed) pieces
      const pieces: { off: number; pp: ParsedPattern; id: string }[] = [];
      let chainLen = 0;
      let ok = true;
      for (const pid of chain) {
        const pp = getParsed(pid, tr.isDrum);
        if (!pp) { E(`section "${name}" track "${tid}": unknown pattern "${pid}"`); ok = false; continue; }
        usedPatterns.add(pid);
        if (pp.length <= 0) { ok = false; continue; }
        pieces.push({ off: chainLen, pp, id: pid });
        chainLen += pp.length;
      }
      if (!ok || chainLen <= 0) continue;
      if (steps % chainLen !== 0 && chainLen < steps) W(`section "${name}" track "${tid}": chain length ${chainLen} steps doesn't divide the section (${steps} steps); the last loop is cut`);
      if (chainLen > steps) W(`section "${name}" track "${tid}": chain length ${chainLen} steps is longer than the section (${steps}); it is cut`);
      const [lo, hi] = INSTRUMENT_DEFAULTS[tr.inst].range;
      let rangeWarned = false;
      let chordWarned = false;
      // resolve each piece's events once, then tile
      const resolved: { at: number; ev: CEvent }[] = [];
      for (const piece of pieces) {
        for (const re of piece.pp.events) {
          if (re.at >= piece.pp.length) continue;
          try {
            let midi: number[] = [];
            let drum = '';
            if (tr.isDrum) drum = resolveDrum(re.p, tr.inst as DrumInstrument);
            else {
              midi = resolvePitch(re.p, pctx);
              for (const m of midi) {
                if (m < 0 || m > 127) throw new Error(`pitch ${m} outside MIDI 0..127`);
                if ((m < lo || m > hi) && !rangeWarned) { rangeWarned = true; W(`section "${name}" track "${tid}" (${tr.inst}): note ${m} outside the sensible range ${lo}..${hi}`); }
              }
              if (tr.mono && midi.length > 1 && !chordWarned) { chordWarned = true; W(`section "${name}" track "${tid}": chord on mono ${tr.inst}, only the lowest note plays`); }
              if (tr.mono && midi.length > 1) midi = [midi[0]!];
            }
            resolved.push({ at: piece.off + re.at, ev: { frac: 0, midi, len: re.len, vel: re.vel, glide: re.glide, drum } });
          } catch (err) {
            E(`pattern "${piece.id}" on track "${tid}" (section "${name}"): ${(err as Error).message}`);
          }
        }
      }
      for (let base = 0; base < steps; base += chainLen) {
        for (const r of resolved) {
          const at = base + r.at;
          if (at >= steps) continue;
          const st = Math.floor(at + 1e-9);
          const ev: CEvent = { ...r.ev, frac: at - st < 1e-9 ? 0 : at - st };
          const row = events[ti]!;
          (row[st] ??= []).push(ev);
        }
      }
    }
    if (sec.kind !== undefined && !KNOWN_KINDS.has(sec.kind)) W(`section "${name}": unknown kind "${sec.kind}"`);
    const kind = sec.kind ?? name;
    sectionIdx.set(name, sections.length);
    sections.push({ name, kind, bars: sec.bars, steps, transpose, intensity: sec.intensity ?? 0, events });
  }

  for (const pid of Object.keys(song.patterns)) if (!usedPatterns.has(pid)) W(`pattern "${pid}" is never used`);

  // form
  const timeline: number[] = [];
  const formSlot: number[] = [];
  if (song.form.length === 0) E('form is empty');
  for (const [i, fe] of song.form.entries()) {
    const name = typeof fe === 'string' ? fe : fe.section;
    const repeat = typeof fe === 'string' ? 1 : (fe.repeat ?? 1);
    if (!(Number.isInteger(repeat) && repeat >= 1 && repeat <= 64)) E(`form[${i}]: repeat ${repeat} must be an integer 1..64`);
    const si = sectionIdx.get(name);
    formSlot.push(timeline.length);
    if (si === undefined) { if (!(name in song.sections)) E(`form[${i}]: unknown section "${name}"`); continue; }
    for (let r = 0; r < Math.max(1, repeat); r++) timeline.push(si);
  }
  const loop = song.loop ?? true;
  const loopTo = song.loopTo ?? 0;
  if (!(Number.isInteger(loopTo) && loopTo >= 0 && loopTo < Math.max(1, song.form.length))) E(`loopTo ${loopTo} must be a form index 0..${song.form.length - 1}`);

  const iMin = song.intensity?.min ?? 0;
  const iMax = song.intensity?.max ?? 1;
  if (!(iMin >= 0 && iMin <= 1 && iMax >= 0 && iMax <= 1 && iMin <= iMax)) E(`intensity {min: ${iMin}, max: ${iMax}} must satisfy 0 ≤ min ≤ max ≤ 1`);
  if (song.pump !== undefined && !(song.pump >= 0 && song.pump <= 1)) E(`pump ${song.pump} must be 0..1`);
  if (song.delay?.feedback !== undefined && !(song.delay.feedback >= 0 && song.delay.feedback <= 0.9)) E(`delay.feedback ${song.delay.feedback} must be 0..0.9`);
  if (song.reverb?.decay !== undefined && !(song.reverb.decay >= 0.3 && song.reverb.decay <= 8)) E(`reverb.decay ${song.reverb.decay} must be 0.3..8 s`);
  if (song.fill) {
    for (const [lane, str] of Object.entries(song.fill)) {
      if (!['kick', 'snare', 'clap', 'tom'].includes(lane)) { E(`fill: unknown lane "${lane}"`); continue; }
      const pp = parseSteps(str ?? '', true);
      for (const e of pp.errors) E(`fill.${lane}: ${e}`);
      if (pp.length > 16) E(`fill.${lane}: ${pp.length} steps (max 16)`);
      for (const ev of pp.events) {
        try { resolveDrum(ev.p, lane as DrumInstrument); } catch (err) { E(`fill.${lane}: ${(err as Error).message}`); }
      }
    }
  }
  for (const [sid, st] of Object.entries(song.stingers ?? {})) {
    if (!st) continue;
    for (const e of validateStinger(st.parts)) E(`stinger "${sid}": ${e}`);
    if (st.follow !== undefined && st.follow !== 'key' && st.follow !== 'chord') E(`stinger "${sid}": follow "${String(st.follow)}" must be 'key' or 'chord'`);
    if (st.quantize !== undefined && !['step', 'beat', 'bar'].includes(st.quantize)) E(`stinger "${sid}": quantize "${String(st.quantize)}" must be 'step', 'beat' or 'bar'`);
  }

  if (errors.length > 0) return { compiled: null, errors, warnings };
  const compiled: CompiledSong = {
    song,
    bpm: song.bpm,
    tonicPc: tonicPc!,
    mode: song.mode,
    tracks,
    sections,
    timeline,
    formSlot,
    loop,
    loopToSlot: formSlot[loopTo] ?? 0,
    intensityMin: iMin,
    intensityMax: iMax,
  };
  for (const w of analyzePolyphony(compiled)) warnings.push(w);
  return { compiled, errors, warnings };
}

/** Format-check stinger parts (pitch syntax is checked against a neutral A-minor context). */
export function validateStinger(parts: readonly { inst: InstrumentId; steps: string; octave?: number }[]): string[] {
  const errs: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (!(part.inst in INSTRUMENT_DEFAULTS)) { errs.push(`part ${i}: unknown instrument "${String(part.inst)}"`); continue; }
    const drum = isDrum(part.inst);
    const pp = parseSteps(part.steps, drum);
    for (const e of pp.errors) errs.push(`part ${i}: ${e}`);
    const c: PitchContext = { tonicPc: 9, mode: 'aeolian', octave: part.octave ?? INSTRUMENT_DEFAULTS[part.inst].octave, voicing: 'fold', transpose: 0 };
    for (const ev of pp.events) {
      try {
        if (drum) resolveDrum(ev.p, part.inst as DrumInstrument);
        else resolvePitch(ev.p, c);
      } catch (err) { errs.push(`part ${i}: ${(err as Error).message}`); }
    }
  }
  return errs;
}

/** Validate only (errors + warnings). */
export function validateSong(song: Song): { errors: string[]; warnings: string[] } {
  const r = compileSong(song);
  return { errors: r.errors, warnings: r.warnings };
}

// ---------------------------------------------------------------------------------------------
// Analysis (theory + polyphony) — used by tests and the composer
// ---------------------------------------------------------------------------------------------

/** Max simultaneous melodic poly notes per section (note length only, release tails ignored). */
export function maxPolyphony(cs: CompiledSong, sec: CSection): number {
  const counts = new Array<number>(sec.steps).fill(0);
  cs.tracks.forEach((tr, ti) => {
    if (tr.isDrum) return;
    const row = sec.events[ti]!;
    row.forEach((evs, s) => {
      if (!evs) return;
      for (const ev of evs) {
        const n = tr.mono ? 1 : ev.midi.length;
        const end = Math.min(sec.steps, Math.ceil(s + ev.frac + ev.len));
        for (let k = s; k < end; k++) counts[k]! += n;
      }
    });
  });
  return counts.reduce((a, b) => Math.max(a, b), 0);
}

export function analyzePolyphony(cs: CompiledSong): string[] {
  const out: string[] = [];
  for (const sec of cs.sections) {
    const p = maxPolyphony(cs, sec);
    if (p > POLY_WARN) out.push(`section "${sec.name}": up to ${p} simultaneous notes (cap 24 incl. drums; voices will be stolen)`);
  }
  return out;
}

export interface ChromaticNote {
  section: string;
  track: string;
  step: number;
  midi: number;
}

/**
 * Notes whose pitch class is outside the song's key/mode (after the section transpose).
 * Not an error: a harmonic-minor V chord in an aeolian song shows up here on purpose.
 */
export function chromaticNotes(cs: CompiledSong): ChromaticNote[] {
  const out: ChromaticNote[] = [];
  for (const sec of cs.sections) {
    const pcs = scalePcs((cs.tonicPc + sec.transpose + 1200) % 12, cs.mode);
    cs.tracks.forEach((tr, ti) => {
      if (tr.isDrum) return;
      sec.events[ti]!.forEach((evs, step) => {
        for (const ev of evs ?? []) for (const m of ev.midi) if (!pcs.has(((m % 12) + 12) % 12)) out.push({ section: sec.name, track: tr.id, step, midi: m });
      });
    });
  }
  return out;
}

/** Total steps of one pass through the timeline (no loop). */
export function timelineSteps(cs: CompiledSong): number {
  return cs.timeline.reduce((a, si) => a + cs.sections[si]!.steps, 0);
}
