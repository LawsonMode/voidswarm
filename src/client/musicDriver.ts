// OWNER: CLIENT (v0.3 M4 integration). Drives the MusicDirector (audio/music/director.ts) from main.ts: one director
// per page, unlocked on the first user gesture (with the SFX), a scene per screen / state, a smoothed match intensity,
// stingers from game events, and the Music volume / mute settings (muted while the tab is hidden). Every call into
// the director is guarded: music trouble never breaks the game. The rules themselves are pure (musicMapping.ts).
import type { RenderFrame } from './contracts';
import type { MusicScene } from './audio/music/format';
import {
  musicIntensityFor, musicSceneFor, musicStingersFor, smoothToward, type MusicSceneInput, type MusicStinger,
} from './musicMapping';

/** What the driver needs from the director (MusicDirector implements it; tests pass a fake). */
export interface MusicSink {
  unlock(): void;
  setScene(scene: MusicScene): void;
  setIntensity(x: number): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  stingerLevelUp(): void;
  stingerWaveStart(): void;
  stingerBossIncoming(): void;
}

/** Hand the director a new intensity at most this often (it smooths again and switches layers on bar lines). */
const INTENSITY_EVERY_MS = 100;

export class MusicDriver {
  private scene: MusicScene | null = null;
  private level = 0.3;
  private lastSentMs = -1e9;
  private volume = 0.6;
  private userMuted = false;
  private hidden = false;

  constructor(private sink: MusicSink) {}

  private call(fn: () => void): void {
    try { fn(); } catch (e) { console.error('[voidswarm] music', e); }
  }

  unlock(): void { this.call(() => this.sink.unlock()); }

  /** Music volume 0..1 and the Music mute toggle (settings). */
  setSettings(volume: number, muted: boolean): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
    this.userMuted = !!muted;
    this.call(() => this.sink.setVolume(this.volume));
    this.applyMute();
  }

  /** The page was hidden / shown (document.visibilitychange): music is muted while hidden. */
  setHidden(hidden: boolean): void {
    this.hidden = !!hidden;
    this.applyMute();
  }

  private applyMute(): void {
    const m = this.userMuted || this.hidden;
    this.call(() => this.sink.setMuted(m));
  }

  get currentScene(): MusicScene | null { return this.scene; }
  get currentIntensity(): number { return this.level; }

  /** Pick the scene for the current screen / state (called every frame; only a change reaches the director). */
  updateScene(input: MusicSceneInput): MusicScene {
    const next = musicSceneFor(input);
    if (next !== this.scene) {
      this.scene = next;
      if (next === 'match' || next === 'boss') this.level = Math.max(this.level, 0.3);
      this.call(() => this.sink.setScene(next));
    }
    return next;
  }

  /** A rendered match frame: intensity (smoothed) and stingers. */
  onFrame(f: RenderFrame, nowMs: number, myTeam: number, ffa: boolean): void {
    const target = musicIntensityFor({
      match: f.match, you: f.you, focusX: f.focusX, focusY: f.focusY, enemies: f.enemies, ships: f.ships,
      myTeam, myShipId: f.localShipId, ffa,
    });
    this.level = smoothToward(this.level, target, f.dt);
    if (nowMs - this.lastSentMs >= INTENSITY_EVERY_MS) {
      this.lastSentMs = nowMs;
      const v = this.level;
      this.call(() => this.sink.setIntensity(v));
    }
    for (const s of musicStingersFor(f.events, f.localPlayerId)) this.stinger(s);
  }

  private stinger(s: MusicStinger): void {
    this.call(() => {
      if (s === 'waveStart') this.sink.stingerWaveStart();
      else if (s === 'bossIncoming') this.sink.stingerBossIncoming();
      else this.sink.stingerLevelUp();
    });
  }
}
