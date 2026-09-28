// MusicDirector: the small, stable API the game calls. It owns its OWN AudioContext, created in
// unlock() on the first user gesture, so no audio happens before unlock.
//
//   const music = new MusicDirector();
//   window.addEventListener('pointerdown', () => music.unlock(), { once: true });
//   music.setScene('title');          // switches songs on the next bar line, with a fill/riser
//   music.setIntensity(0.7);          // 0..1, smoothed; layers switch on bar lines
//   music.setVolume(0.8); music.setMuted(false);
//   music.stingerLevelUp();           // one-shot phrase in the current key
//   music.stingerWaveStart();         // a PvE wave begins (next beat)
//   music.stingerBossIncoming();      // a boss is about to spawn (next bar, 2 bars)
//   music.destroy();
import { compileSong, type CompiledSong } from './compile';
import type { MusicScene, Song, StingerId } from './format';
import { Sequencer, type SequencerState } from './sequencer';
import { SCENE_SONG, SONGS, type SongId } from './songs/index';
import { DEFAULT_STINGERS } from './songs/stingers';
import { MUSIC_SAMPLE_RATE, SynthCore } from './synth';

export type { MusicScene } from './format';

export interface MusicDirectorOptions {
  /** Override registered songs (demo / tests). */
  songs?: Partial<Record<SongId, Song>>;
  /** Override the scene → song mapping. */
  scenes?: Partial<Record<MusicScene, SongId>>;
  /** Engine sample rate (default MUSIC_SAMPLE_RATE = 32 kHz); null = the device's rate. */
  sampleRate?: number | null;
}

export interface MusicState extends SequencerState {
  unlocked: boolean;
  running: boolean;
  scene: MusicScene | null;
  volume: number;
  muted: boolean;
  time: number;
  /** The music AudioContext's sample rate (0 before unlock). */
  sampleRate: number;
}

const TICK_MS = 25;
const LOOKAHEAD = 0.12;
const LOOKAHEAD_HIDDEN = 1.5;
const STINGER_GAP = 0.9;

export class MusicDirector {
  private ctx: AudioContext | null = null;
  private core: SynthCore | null = null;
  private seq: Sequencer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The pending "suspend after the mute fade" timeout. */
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private scene: MusicScene | null = null;
  private intensity = 0.5;
  private volume = 0.8;
  private muted = false;
  private destroyed = false;
  /** Last time each stinger fired (rate limit is per stinger, so a level-up never eats a boss warning). */
  private readonly lastStinger = new Map<StingerId, number>();
  private suspendGen = 0;
  private analyser: AnalyserNode | null = null;
  private readonly songs: Record<SongId, Song>;
  private readonly scenes: Record<MusicScene, SongId>;
  private readonly compiled = new Map<Song, CompiledSong | null>();
  private readonly sampleRate: number | null;

  constructor(opts: MusicDirectorOptions = {}) {
    this.sampleRate = opts.sampleRate === undefined ? MUSIC_SAMPLE_RATE : opts.sampleRate;
    this.songs = { ...SONGS, ...(opts.songs ?? {}) } as Record<SongId, Song>;
    this.scenes = { ...SCENE_SONG, ...(opts.scenes ?? {}) } as Record<MusicScene, SongId>;
  }

  /** Call on the first user gesture: creates (or resumes) the music AudioContext and starts playback. */
  unlock(): void {
    if (this.destroyed) return;
    if (!this.ctx) {
      const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = w.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      let ctx: AudioContext;
      try {
        ctx = new AC(this.sampleRate ? { latencyHint: 'playback', sampleRate: this.sampleRate } : { latencyHint: 'playback' });
      } catch {
        try { ctx = new AC({ latencyHint: 'playback' }); } catch { ctx = new AC(); }
      }
      this.ctx = ctx;
      this.core = new SynthCore(ctx);
      this.seq = new Sequencer(this.core);
      this.seq.setIntensity(this.intensity, true);
      this.applyGain(true);
      if (this.scene) this.startScene(this.scene);
      this.tick();
    }
    if (this.ctx.state !== 'running' && !this.isSilent()) void this.ctx.resume().catch(() => undefined);
  }

  setScene(scene: MusicScene): void {
    if (this.destroyed) return;
    this.scene = scene;
    if (this.seq) this.startScene(scene);
  }

  /** 0..1 game intensity (smoothed, ~1.2 s time constant; layers change on bar lines). */
  setIntensity(x: number): void {
    this.intensity = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    this.seq?.setIntensity(this.intensity);
  }

  /** 0..1 master music volume (linear gain). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    this.applyGain();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyGain();
  }

  /** A short level-up phrase over the music, quantized to the next 16th (rate-limited). */
  stingerLevelUp(): void {
    this.playStinger('levelUp');
  }

  /** A PvE wave begins: tom pickup into a tonic brass hit + crash, on the next beat. */
  stingerWaveStart(): void {
    this.playStinger('waveStart');
  }

  /** A boss is about to spawn: two-bar menace (cluster stabs, diminished chord, floor toms), on the next bar. */
  stingerBossIncoming(): void {
    this.playStinger('bossIncoming');
  }

  playStinger(id: StingerId): void {
    const ctx = this.ctx;
    const seq = this.seq;
    if (!ctx || !seq || this.isSilent() || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - (this.lastStinger.get(id) ?? -Infinity) < STINGER_GAP) return;
    this.lastStinger.set(id, now);
    const st = seq.currentSong?.song.stingers?.[id] ?? DEFAULT_STINGERS[id];
    seq.stinger(st, now);
  }

  /** Debug/demo: jump the current song to a named section on the next bar. */
  jumpToSection(name: string): boolean {
    return this.seq?.jumpToSection(name) ?? false;
  }

  /** Debug/demo: a tap on the final output for meters (created on first call). */
  getAnalyser(): AnalyserNode | null {
    if (!this.ctx || !this.core) return null;
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.core.fx.out.connect(this.analyser);
    }
    return this.analyser;
  }

  getState(): MusicState {
    const now = this.ctx?.currentTime ?? 0;
    const base: SequencerState = this.seq?.state(now) ?? {
      song: null, section: null, kind: null, bar: 0, bars: 0, bpm: 0, key: '', intensity: this.intensity,
      effective: 0, layers: [], voices: 0, steals: 0, pending: null, ended: false,
    };
    return {
      ...base,
      unlocked: !!this.ctx,
      running: this.ctx?.state === 'running',
      scene: this.scene,
      volume: this.volume,
      muted: this.muted,
      time: now,
      sampleRate: this.ctx?.sampleRate ?? 0,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.timer = null;
    this.suspendTimer = null;
    this.seq?.dispose();
    this.core?.dispose();
    this.analyser?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.seq = null;
    this.core = null;
    this.ctx = null;
    this.analyser = null;
  }

  // -------------------------------------------------------------------------------------------

  private songFor(scene: MusicScene): CompiledSong | null {
    const id = this.scenes[scene];
    const song = this.songs[id] ?? this.songs.placeholder;
    if (!this.compiled.has(song)) {
      const r = compileSong(song);
      if (!r.compiled) console.error(`[music] song "${song.title}" (${id}) has errors:\n  ${r.errors.join('\n  ')}`);
      this.compiled.set(song, r.compiled);
    }
    const cs = this.compiled.get(song) ?? null;
    if (cs || song === this.songs.placeholder) return cs;
    // fall back to the placeholder so the game still has music
    if (!this.compiled.has(this.songs.placeholder)) this.compiled.set(this.songs.placeholder, compileSong(this.songs.placeholder).compiled);
    return this.compiled.get(this.songs.placeholder) ?? null;
  }

  private startScene(scene: MusicScene): void {
    const cs = this.songFor(scene);
    if (cs && this.seq && this.ctx) this.seq.play(cs, this.ctx.currentTime);
  }

  private isSilent(): boolean {
    return this.muted || this.volume <= 0.001;
  }

  private applyGain(immediate = false): void {
    const ctx = this.ctx;
    const core = this.core;
    const seq = this.seq;
    if (!ctx || !core || !seq) return;
    const silent = this.isSilent();
    const target = silent ? 0 : this.volume;
    const gen = ++this.suspendGen;
    if (this.suspendTimer !== null) { clearTimeout(this.suspendTimer); this.suspendTimer = null; }
    if (silent) {
      core.fx.setVolume(0, ctx.currentTime, immediate ? 0.001 : 0.04);
      // after the fade, stop making notes and suspend the context (zero CPU while muted)
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (gen !== this.suspendGen || !this.ctx || !this.isSilent()) return;
        seq.silent = true;
        if (this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
      }, immediate ? 0 : 250);
    } else {
      seq.silent = false;
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
      core.fx.setVolume(target, ctx.currentTime, immediate ? 0.001 : 0.05);
    }
  }

  private tick = (): void => {
    const ctx = this.ctx;
    const seq = this.seq;
    if (!ctx || !seq || this.destroyed) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    seq.lookahead = hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
    if (ctx.state === 'running') seq.pump(ctx.currentTime);
    this.timer = setTimeout(this.tick, TICK_MS);
  };
}
