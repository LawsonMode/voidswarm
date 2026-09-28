// Lookahead sequencer: walks compiled songs step by step and schedules notes ~120 ms ahead on
// the AudioContext clock. The Sequencer does not own a timer: the director's setTimeout loop,
// or an offline benchmark, calls pump(now). Step times are always origin + n * stepDur, so there
// is no drift.
//
// Transitions: a scene change starts the next song on the next bar line of the playing song that
// is at least one beat away, so the outgoing song's drums have room for a fill. The new song's
// `transition` picks fill / riser / both / fade / cut.
import type { CompiledSong, CTrack } from './compile';
import { INSTRUMENT_DEFAULTS, parseSteps, resolveDrum, resolvePitch } from './compile';
import { DrumBank, playRiser, SampledDrum, type RiserHandle } from './drums';
import { isDrum, type DrumInstrument, type InstrumentId, type Mode, type Stinger, type ToneParams, type TransitionKind } from './format';
import { MonoSynth, PolySynth, resolveTone, SongBus, TrackOut, type Instrument, type SynthCore } from './synth';
import { chordTriad, pcName, snapToPcs } from './theory';
import * as T from './timing';

export function createInstrument(core: SynthCore, inst: InstrumentId, out: AudioNode, bank: DrumBank, tone?: ToneParams, room?: number): Instrument {
  switch (inst) {
    case 'bass':
    case 'lead':
      return new MonoSynth(core, out, inst, resolveTone(inst, tone));
    case 'pad':
    case 'brass':
    case 'pluck':
    case 'arp':
    case 'bell':
      return new PolySynth(core, out, inst, resolveTone(inst, tone));
    case 'kick':
    case 'snare':
    case 'clap':
    case 'hat':
    case 'ohat':
    case 'tom':
    case 'crash':
      return new SampledDrum(core, out, inst, bank, room);
  }
}

interface TrackRt {
  ct: CTrack;
  out: TrackOut;
  inst: Instrument;
  active: boolean;
}

interface Marker {
  t: number;
  slot: number;
  bar: number;
  eff: number;
}

/** Key part of a pitch context (the tonic, mode and transpose a stinger note resolves in). */
interface PitchContextLite { tonicPc: number; mode: Mode; transpose: number }

export interface Harmony {
  /** Section transpose (semitones). */
  transpose: number;
  /** MIDI notes of the pad chord sounding (else the brass), transposed; null when none. */
  chord: readonly number[] | null;
  /** The bass note sounding, transposed; null when none. */
  bass: number | null;
}

export interface PlayerPosition {
  section: string;
  kind: string;
  /** 1-based bar inside the section. */
  bar: number;
  bars: number;
  slot: number;
  transpose: number;
  eff: number;
}

// ---------------------------------------------------------------------------------------------
// SongPlayer: one running instance of a compiled song
// ---------------------------------------------------------------------------------------------

export class SongPlayer {
  readonly sd: number;
  private n = 0;
  private slot = 0;
  private sStep = 0;
  private readonly slotSteps: number[];
  ended = false;
  endTime = Infinity;
  stopAt = Infinity;
  private stopped = false;
  private drumsMutedFrom = Infinity;
  private readonly tracks: TrackRt[] = [];
  private readonly chokers: Instrument[] = [];
  private readonly bus: SongBus;
  private markers: Marker[] = [];
  private pendingJump: number | null = null;
  private lastMaintain = 0;

  constructor(
    private readonly core: SynthCore,
    readonly cs: CompiledSong,
    readonly origin: number,
    private readonly intensity: () => number,
    private readonly silent: () => boolean,
    bank: DrumBank,
  ) {
    this.sd = T.stepDur(cs.bpm);
    this.slotSteps = cs.timeline.map((si) => cs.sections[si]!.steps);
    const gain = cs.song.gain ?? 1;
    this.bus = new SongBus(core);
    for (const ct of cs.tracks) {
      const out = new TrackOut(core, this.bus, { gain: ct.gain * gain, pan: ct.pan, duck: ct.duck, delay: ct.delay, reverb: ct.reverb, startClosed: true });
      const inst = createInstrument(core, ct.inst, out.input, bank, ct.tone, ct.gated);
      if (inst instanceof SampledDrum) inst.pump = cs.song.pump ?? 0.5;
      if (ct.inst === 'ohat') this.chokers.push(inst);
      this.tracks.push({ ct, out, inst, active: false });
    }
    if (this.slotSteps.length === 0) { this.ended = true; this.endTime = origin; }
    this.prewarm();
  }

  /** Queue every pad/brass chord loop this song can play (built in small slices by the sequencer). */
  private prewarm(): void {
    const want = { pad: new Map<string, readonly number[]>(), brass: new Map<string, readonly number[]>() };
    // the first slot first, so the downbeat is ready even if the queue is long
    const order = [...new Set([this.cs.timeline[0] ?? 0, ...this.cs.timeline])];
    for (const si of order) {
      const sec = this.cs.sections[si]!;
      this.cs.tracks.forEach((ct, ti) => {
        if (ct.inst !== 'pad' && ct.inst !== 'brass') return;
        for (const evs of sec.events[ti]!) for (const ev of evs ?? []) if (ev.midi.length) want[ct.inst].set(ev.midi.join(','), ev.midi);
      });
    }
    this.core.assets.prewarm('pad', want.pad.values());
    this.core.assets.prewarm('brass', want.brass.values());
  }

  /** Next step index that has not been scheduled yet. */
  get cursor(): number { return this.n; }

  timeOf(step: number): number { return this.origin + step * this.sd; }

  /** Is this player finished at `now` (non-looping end reached, or stopped by a transition)? */
  isOver(now: number): boolean {
    return (this.ended && now >= this.endTime) || now >= this.stopAt;
  }

  schedule(until: number): void {
    while (!this.ended) {
      const t = this.origin + this.n * this.sd;
      if (t >= this.stopAt) { this.finalizeStop(); return; }
      if (t >= until) return;
      if (this.pendingJump !== null && this.sStep % T.STEPS_PER_BAR === 0) {
        this.slot = this.pendingJump;
        this.sStep = 0;
        this.pendingJump = null;
      }
      this.step(t);
      this.n++;
      const nx = T.advanceCursor(this.slot, this.sStep, this.slotSteps, this.cs.loop, this.cs.loopToSlot);
      if (!nx) { this.ended = true; this.endTime = this.origin + this.n * this.sd; return; }
      this.slot = nx.slot;
      this.sStep = nx.step;
    }
  }

  private step(t: number): void {
    const sec = this.cs.sections[this.cs.timeline[this.slot]!]!;
    if (this.sStep % T.STEPS_PER_BAR === 0) this.onBar(t);
    if (this.silent()) return;
    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i]!;
      if (!tr.active) continue;
      const evs = sec.events[i]![this.sStep];
      if (!evs) continue;
      if (tr.ct.isDrum && t >= this.drumsMutedFrom) continue;
      for (const ev of evs) {
        const tt = t + ev.frac * this.sd;
        tr.out.touch(tt + ev.len * this.sd);
        tr.inst.trigger(tt, ev.midi, ev.len * this.sd, ev.vel, ev.glide, ev.drum);
        if (tr.ct.inst === 'hat' && ev.drum === 'x') for (const c of this.chokers) c.choke?.(tt);
      }
    }
  }

  private onBar(t: number): void {
    const sec = this.cs.sections[this.cs.timeline[this.slot]!]!;
    const eff = T.effectiveIntensity(this.intensity(), this.cs.intensityMin, this.cs.intensityMax, sec.intensity);
    for (const tr of this.tracks) {
      const on = T.layerActive(tr.active, eff, tr.ct.threshold);
      if (on !== tr.active) {
        tr.active = on;
        tr.out.setLayer(on, t);
        if (!on) tr.inst.releaseAll(t);
      }
      tr.inst.setBrightness?.(eff, t);
    }
    this.markers.push({ t, slot: this.slot, bar: this.sStep / T.STEPS_PER_BAR, eff });
    if (this.markers.length > 24) this.markers.splice(0, this.markers.length - 24);
  }

  /** Stop scheduling at `at`; fade the song gain from `fadeFrom` over `fadeDur`. */
  beginStop(at: number, fadeFrom: number, fadeDur: number): void {
    this.stopAt = at;
    this.bus.fade(0, fadeFrom, fadeDur);
  }

  /** Undo beginStop / muteDrumsFrom (only valid while `at` is still in the future). */
  cancelStop(now: number): void {
    this.stopAt = Infinity;
    this.stopped = false;
    this.drumsMutedFrom = Infinity;
    this.bus.fade(1, now, 0.05);
  }

  private finalizeStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const tr of this.tracks) tr.inst.releaseAll(this.stopAt);
  }

  muteDrumsFrom(t: number): void { this.drumsMutedFrom = t; }

  fadeIn(t: number, dur: number): void {
    this.fadeInUntil = t + dur;
    this.bus.fadeIn(t, dur);
  }

  private fadeInUntil = -1;
  private dipUntil = -1;

  /** Duck the whole song briefly (under a stinger). Skipped during song fades and overlapping dips. */
  dip(t: number, depth: number, dur: number): void {
    if (this.stopAt !== Infinity || depth <= 0 || t < this.fadeInUntil || t < this.dipUntil) return;
    this.dipUntil = t + dur + 0.2;
    this.bus.dent(t, Math.min(0.9, depth), dur);
  }

  /** Jump to a timeline slot on the next bar line. */
  jumpToSlot(slot: number): void {
    if (slot >= 0 && slot < this.slotSteps.length) this.pendingJump = slot;
  }

  /** Time of the first unscheduled bar line at or after minTime. */
  nextBarTime(minTime: number): number {
    return this.timeOf(T.nextBarStep(this.origin, this.cs.bpm, this.n, minTime));
  }

  /** Time of the first unscheduled grid step (grid in steps) at or after minTime. */
  nextGridTime(grid: number, minTime: number): number {
    const need = Math.max(this.n, Math.ceil((minTime - this.origin) / this.sd - 1e-9));
    return this.timeOf(T.nextGridStep(need, grid));
  }

  /**
   * What the song plays at time t (at or after the scheduling cursor; earlier times read as the
   * cursor): the section transpose there, the pad chord sounding (else the brass), and the bass
   * note. Stingers use it to land in the right key and on the right chord.
   */
  harmonyAt(t: number): Harmony {
    const k = Math.max(this.n, Math.round((t - this.origin) / this.sd));
    let slot = this.slot;
    let st = this.sStep;
    let jump = this.pendingJump;
    for (let i = this.n; ; i++) {
      // the same bar-line jump rule as schedule()
      if (jump !== null && st % T.STEPS_PER_BAR === 0) { slot = jump; st = 0; jump = null; }
      if (i >= k) break;
      const nx = T.advanceCursor(slot, st, this.slotSteps, this.cs.loop, this.cs.loopToSlot);
      if (!nx) break;
      slot = nx.slot;
      st = nx.step;
    }
    const sec = this.cs.sections[this.cs.timeline[slot] ?? 0];
    if (!sec) return { transpose: 0, chord: null, bass: null };
    /**
     * The latest event on a track of this instrument that starts at or before step st (within
     * `within` steps) and, when `held`, is still sounding at st.
     */
    const latest = (inst: InstrumentId, within: number, held: boolean): readonly number[] | null => {
      for (let ti = 0; ti < this.cs.tracks.length; ti++) {
        if (this.cs.tracks[ti]!.inst !== inst) continue;
        const row = sec.events[ti]!;
        for (let s = st; s >= 0 && s > st - within; s--) {
          for (const ev of row[s] ?? []) if (ev.midi.length > 0 && (!held || s + ev.frac + ev.len > st)) return ev.midi;
        }
      }
      return null;
    };
    const chord = latest('pad', sec.steps, true) ?? latest('brass', sec.steps, true);
    // the bass is often staccato: the last note it played in this bar stands for the root
    const bassNotes = latest('bass', T.STEPS_PER_BAR, false);
    return { transpose: sec.transpose, chord, bass: bassNotes ? bassNotes[0]! : null };
  }

  position(now: number): PlayerPosition | null {
    let m: Marker | undefined;
    for (const x of this.markers) if (x.t <= now + 1e-6) m = x;
    m ??= this.markers[0];
    if (!m) return null;
    const sec = this.cs.sections[this.cs.timeline[m.slot]!]!;
    return { section: sec.name, kind: sec.kind, bar: m.bar + 1, bars: sec.bars, slot: m.slot, transpose: sec.transpose, eff: m.eff };
  }

  activeLayers(): string[] {
    return this.tracks.filter((t) => t.active).map((t) => t.ct.id);
  }

  maintain(now: number): void {
    if (now - this.lastMaintain < 0.5) return;
    this.lastMaintain = now;
    for (const tr of this.tracks) {
      tr.inst.maintain(now);
      tr.out.maintain(now);
    }
  }

  dispose(): void {
    for (const tr of this.tracks) {
      tr.inst.dispose();
      tr.out.dispose();
    }
    this.tracks.length = 0;
    this.chokers.length = 0;
    this.bus.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Sequencer: current song + pending transition + retiring songs + a rack for fills/stingers
// ---------------------------------------------------------------------------------------------

const DEFAULT_FILL: Readonly<Partial<Record<'kick' | 'snare' | 'clap' | 'tom', string>>> = {
  snare: 'X . x? x',
  tom: '. h m f',
};

interface FillHit {
  t: number;
  inst: DrumInstrument;
  variant: string;
  vel: number;
}

interface Pending {
  player: SongPlayer;
  at: number;
  kind: TransitionKind;
  riser: RiserHandle | null;
  fill: FillHit[];
  crash: boolean;
}

export interface SequencerState {
  song: string | null;
  section: string | null;
  kind: string | null;
  bar: number;
  bars: number;
  bpm: number;
  key: string;
  intensity: number;
  effective: number;
  layers: string[];
  voices: number;
  steals: number;
  pending: string | null;
  ended: boolean;
}

export class Sequencer {
  private current: SongPlayer | null = null;
  private pending: Pending | null = null;
  private retired: SongPlayer[] = [];
  /** Instruments for fills and stingers, keyed by instrument + send amounts. */
  private readonly rack = new Map<string, { out: TrackOut; inst: Instrument }>();
  private rackBus: SongBus | null = null;
  private intensityTarget = 0.5;
  private intensity = 0.5;
  private lastPump = -1;
  /** Seconds scheduled ahead of the audio clock. */
  lookahead = 0.12;
  /** When true, time advances but no notes are created (muted: saves CPU). */
  silent = false;

  /** The synthesized kit rendered to samples once (see drums.ts). */
  readonly bank: DrumBank;

  constructor(readonly core: SynthCore) {
    const g = INSTRUMENT_DEFAULTS;
    this.bank = new DrumBank(core.ctx.sampleRate, { snare: g.snare.gated, clap: g.clap.gated, tom: g.tom.gated });
  }

  setIntensity(x: number, immediate = false): void {
    this.intensityTarget = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    if (immediate) this.intensity = this.intensityTarget;
  }

  get smoothedIntensity(): number { return this.intensity; }

  private makePlayer(cs: CompiledSong, origin: number): SongPlayer {
    return new SongPlayer(this.core, cs, origin, () => this.intensity, () => this.silent, this.bank);
  }

  private applySongFx(cs: CompiledSong, t: number): void {
    const s = cs.song;
    this.core.fx.setDelay(cs.bpm, s.delay?.time ?? '8d', s.delay?.feedback ?? 0.35, t);
    this.core.fx.setReverbDecay(s.reverb?.decay ?? 2.2, t);
  }

  /** The player a new request should be planned from (commits an imminent pending transition). */
  play(cs: CompiledSong, now: number): void {
    if (this.pending) {
      const p = this.pending;
      if (p.at - now > this.lookahead + 0.03) {
        if (p.player.cs === cs) return;
        p.player.dispose();
        p.riser?.cancel(now);
        this.pending = null;
        this.current?.cancelStop(now);
        if (this.current && this.current.cs === cs) return;
      } else {
        this.commit();
      }
    }
    const cur = this.current;
    if (cur && !cur.isOver(now) && cur.cs === cs) return;
    if (!cur || cur.isOver(now)) {
      const origin = now + 0.08;
      if (cur) this.retire(cur);
      this.current = this.makePlayer(cs, origin);
      this.applySongFx(cs, origin);
      return;
    }
    const kind: TransitionKind = cs.song.transition ?? 'fill';
    const minLead = T.beatDur(cur.cs.bpm) + this.lookahead + 0.06;
    const at = cur.nextBarTime(now + minLead);
    const bar = T.barDur(cur.cs.bpm);
    if (kind === 'fade') cur.beginStop(at + bar, at, bar);
    else cur.beginStop(at, at, kind === 'cut' ? 0.03 : 0.3);
    const next = this.makePlayer(cs, at);
    if (kind === 'fade') next.fadeIn(at, bar);
    const riser = kind === 'riser' || kind === 'both' ? playRiser(this.core, Math.max(now + 0.03, at - bar), at) : null;
    const fill = kind === 'fill' || kind === 'both' ? this.planFill(cur, at, now) : [];
    this.applySongFx(cs, at);
    this.pending = { player: next, at, kind, riser, fill, crash: kind === 'fill' || kind === 'riser' || kind === 'both' };
  }

  private planFill(cur: SongPlayer, at: number, now: number): FillHit[] {
    const lanes = cur.cs.song.fill ?? DEFAULT_FILL;
    const hits: FillHit[] = [];
    const earliest = Math.max(now + this.lookahead + 0.01, cur.timeOf(cur.cursor));
    let first = at;
    for (const [lane, str] of Object.entries(lanes)) {
      if (!str) continue;
      const inst = lane as DrumInstrument;
      const pp = parseSteps(str, true);
      for (const ev of pp.events) {
        const t = at - (pp.length - ev.at) * cur.sd;
        if (t < earliest) continue;
        let variant = 'x';
        try { variant = resolveDrum(ev.p, inst); } catch { continue; }
        hits.push({ t, inst, variant, vel: ev.vel });
        first = Math.min(first, t);
      }
    }
    if (hits.length > 0) cur.muteDrumsFrom(first);
    return hits.sort((a, b) => a.t - b.t);
  }

  /** Schedule the pending transition's fill hits and downbeat crash that fall before `until`. */
  private flushPending(p: Pending, until: number): void {
    while (p.fill.length > 0 && p.fill[0]!.t < until) {
      const h = p.fill.shift()!;
      if (!this.silent) this.rackInst(h.inst, h.t + 0.1).trigger(h.t, [], 0.1, h.vel, false, h.variant);
    }
    if (p.crash && p.at < until) {
      p.crash = false;
      if (!this.silent) this.rackInst('crash', p.at + 0.1).trigger(p.at, [], 0.1, 0.85, false, 'x');
    }
  }

  private commit(): void {
    const p = this.pending;
    if (!p) return;
    this.flushPending(p, Infinity);
    this.pending = null;
    if (this.current) this.retire(this.current);
    this.current = p.player;
  }

  private retire(p: SongPlayer): void {
    if (!this.retired.includes(p)) this.retired.push(p);
  }

  private rackInst(inst: InstrumentId, until: number, delay?: number, reverb?: number): Instrument {
    const d = INSTRUMENT_DEFAULTS[inst];
    const dl = Math.max(0, Math.min(1, delay ?? d.delay));
    const rv = Math.max(0, Math.min(1, reverb ?? d.reverb));
    const key = `${inst}|${dl}|${rv}`;
    let r = this.rack.get(key);
    if (!r) {
      this.rackBus ??= new SongBus(this.core);
      const out = new TrackOut(this.core, this.rackBus, { gain: 1, pan: 0, duck: false, delay: dl, reverb: rv });
      r = { out, inst: createInstrument(this.core, inst, out.input, this.bank, undefined, d.gated) };
      this.rack.set(key, r);
    }
    r.out.touch(until);
    return r.inst;
  }

  /** Advance the clock: smooth intensity, schedule everything due before now + lookahead, clean up. */
  pump(now: number): void {
    const dt = this.lastPump < 0 ? 0 : Math.max(0, now - this.lastPump);
    this.lastPump = now;
    this.intensity = T.smoothToward(this.intensity, this.intensityTarget, dt, 1.2);
    const until = now + this.lookahead;

    this.current?.schedule(until);
    this.current?.maintain(now);
    const p = this.pending;
    if (p) {
      this.flushPending(p, until);
      p.player.schedule(until);
      if (now >= p.at) this.commit();
    }
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const r = this.retired[i]!;
      r.schedule(until);
      r.maintain(now);
      const doneAt = Math.min(r.stopAt, r.endTime) + 4.5;
      if (now > doneAt) {
        r.dispose();
        this.retired.splice(i, 1);
      }
    }
    for (const r of this.rack.values()) {
      r.inst.maintain(now);
      r.out.maintain(now);
    }
    // render queued pad/brass note loops a little at a time (~2 ms of main thread per tick)
    this.core.assets.work(2);
  }

  /** Play a stinger on the next grid point of the current song (degrees follow its key). */
  stinger(st: Stinger, now: number): void {
    if (this.silent) return;
    const cur = this.current && !this.current.isOver(now) ? this.current : null;
    const grid = st.quantize === 'bar' ? 16 : st.quantize === 'beat' ? 4 : 1;
    const sd = cur ? cur.sd : T.stepDur(120);
    const t0 = cur ? cur.nextGridTime(grid, now + 0.02) : now + 0.03;
    // Each note is resolved against what the song plays when THAT note sounds: the section
    // transpose there (a bar-quantized stinger may start in the next, key-changed section) and,
    // for follow: 'chord', the chord there (a stinger can straddle a chord change).
    interface NoteCtx { pc: PitchContextLite; snap: Set<number> | null }
    const ctxCache = new Map<number, NoteCtx>();
    const contextAt = (t: number, octave: number): { tonicPc: number; mode: Mode; octave: number; voicing: 'fold'; transpose: number; snap: Set<number> | null } => {
      const key = cur ? Math.round((t - cur.origin) / cur.sd) : 0;
      let c = ctxCache.get(key);
      if (!c) {
        const h = cur ? cur.harmonyAt(t) : null;
        c = { pc: { tonicPc: cur ? cur.cs.tonicPc : 9, mode: cur ? cur.cs.mode : 'aeolian', transpose: h?.transpose ?? 0 }, snap: null };
        if (st.follow === 'chord' && h?.chord) {
          // re-key the degrees to that chord: its root, major or minor by its 3rd
          const tri = chordTriad(h.chord, h.bass);
          if (tri) c.pc = { tonicPc: tri.root, mode: tri.minor ? 'aeolian' : 'ionian', transpose: 0 }; // chord notes are already transposed
          c.snap = new Set(h.chord.map((m) => ((m % 12) + 12) % 12));
          if (h.bass !== null) c.snap.add(((h.bass % 12) + 12) % 12);
        }
        ctxCache.set(key, c);
      }
      return { ...c.pc, octave, voicing: 'fold', snap: c.snap };
    };
    let end = t0;
    for (const part of st.parts) {
      const drum = isDrum(part.inst);
      const pp = parseSteps(part.steps, drum);
      const inst = this.rackInst(part.inst, t0 + pp.length * sd, part.delay, part.reverb);
      const octave = part.octave ?? INSTRUMENT_DEFAULTS[part.inst].octave;
      const g = part.gain ?? 1;
      for (const ev of pp.events) {
        const t = t0 + ev.at * sd;
        const dur = ev.len * sd;
        end = Math.max(end, t + dur);
        const vel = Math.max(0, Math.min(1, ev.vel * g));
        try {
          if (drum) inst.trigger(t, [], dur, vel, false, resolveDrum(ev.p, part.inst as DrumInstrument));
          else {
            const c = contextAt(t, octave);
            let midi = resolvePitch(ev.p, c);
            const snap = c.snap;
            if (snap) midi = [...new Set(midi.map((m) => snapToPcs(m, snap)))].sort((x, y) => x - y);
            inst.trigger(t, midi, dur, vel, ev.glide, '');
          }
        } catch { /* malformed stinger token: skip the note (validated in tests) */ }
      }
    }
    cur?.dip(t0, st.duck ?? 0.25, Math.max(0.1, end - t0));
  }

  /** Jump the current song to a section (by name) on its next bar line. */
  jumpToSection(name: string): boolean {
    const cur = this.current;
    if (!cur) return false;
    const si = cur.cs.sections.findIndex((s) => s.name === name);
    if (si < 0) return false;
    const slot = cur.cs.timeline.indexOf(si);
    if (slot < 0) return false;
    cur.jumpToSlot(slot);
    return true;
  }

  get currentSong(): CompiledSong | null { return this.current?.cs ?? null; }
  get pendingSong(): CompiledSong | null { return this.pending?.player.cs ?? null; }

  isPlaying(now: number): boolean {
    return !!this.pending || (!!this.current && !this.current.isOver(now));
  }

  state(now: number): SequencerState {
    const cur = this.current;
    const pos = cur?.position(now) ?? null;
    const tonic = cur ? cur.cs.tonicPc + (pos?.transpose ?? 0) : 0;
    return {
      song: cur?.cs.song.title ?? null,
      section: pos?.section ?? null,
      kind: pos?.kind ?? null,
      bar: pos?.bar ?? 0,
      bars: pos?.bars ?? 0,
      bpm: cur?.cs.bpm ?? 0,
      key: cur ? `${pcName(tonic, true)} ${cur.cs.mode}` : '',
      intensity: this.intensity,
      effective: pos?.eff ?? 0,
      layers: cur?.activeLayers() ?? [],
      voices: this.core.budget.active(now),
      steals: this.core.budget.steals,
      pending: this.pending?.player.cs.song.title ?? null,
      ended: !!cur && cur.isOver(now),
    };
  }

  dispose(): void {
    this.current?.dispose();
    this.pending?.player.dispose();
    for (const r of this.retired) r.dispose();
    for (const r of this.rack.values()) { r.inst.dispose(); r.out.dispose(); }
    this.rack.clear();
    this.rackBus?.dispose();
    this.rackBus = null;
    this.current = null;
    this.pending = null;
    this.retired = [];
  }
}
