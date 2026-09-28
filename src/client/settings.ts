import { loadJSON, saveJSON } from './storage';

export type AimMode = 'auto' | 'mouse' | 'stick';

export interface ClientSettings {
  /** Which device aims: 'auto' = last active device. */
  aimMode: AimMode;
  /** Gamepad stick radial deadzone, 0.05..0.5 */
  deadzone: number;
  /** Sound-effects volume 0..1 */
  volume: number;
  /** v0.3 M4: music volume 0..1 (the Settings slider shows 0–100, default 60) and the music mute toggle. */
  musicVolume: number;
  musicMuted: boolean;
  /** Screen shake 0..1 */
  screenShake: number;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: ClientSettings = {
  aimMode: 'auto', deadzone: 0.25, volume: 0.7, musicVolume: 0.6, musicMuted: false, screenShake: 0.7, showFps: false,
};

const KEY = 'voidswarm.settings';

export function loadSettings(): ClientSettings {
  const s = loadJSON<ClientSettings>(KEY, { ...DEFAULT_SETTINGS });
  return sanitizeSettings(s);
}

export function saveSettings(s: ClientSettings): void {
  saveJSON(KEY, s);
}

export function sanitizeSettings(s: Partial<ClientSettings>): ClientSettings {
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    aimMode: s.aimMode === 'mouse' || s.aimMode === 'stick' ? s.aimMode : 'auto',
    deadzone: num(s.deadzone, 0.05, 0.5, DEFAULT_SETTINGS.deadzone),
    volume: num(s.volume, 0, 1, DEFAULT_SETTINGS.volume),
    musicVolume: num(s.musicVolume, 0, 1, DEFAULT_SETTINGS.musicVolume),
    musicMuted: s.musicMuted === true,
    screenShake: num(s.screenShake, 0, 1, DEFAULT_SETTINGS.screenShake),
    showFps: !!s.showFps,
  };
}
