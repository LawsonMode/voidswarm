import { ENEMY_TEAM, NO_TEAM } from '../constants';
import type { PlayerId, TeamId } from '../types';

export const TEAM_NAMES = ['Crimson', 'Azure', 'Verdant', 'Solar', 'Violet', 'Cyan', 'Ember', 'Rose'] as const;

/** Neon team colors (0xRRGGBB). */
export const TEAM_COLORS: readonly number[] = [
  0xff3b5c, // crimson
  0x3b8bff, // azure
  0x3bff7a, // verdant
  0xffd43b, // solar
  0xb05bff, // violet
  0x3bf2ff, // cyan
  0xff8a2b, // ember
  0xff5bd6, // rose
];

export const ENEMY_COLOR = 0xff2bd1;

/** Stable per-player hue for FFA. */
export function ffaColor(playerId: PlayerId): number {
  const h = (playerId * 137.508) % 360;
  return hslToHex(h, 1, 0.6);
}

/** Color for a ship/projectile given its team and owning player. */
export function colorFor(team: TeamId, playerId: PlayerId): number {
  if (team === ENEMY_TEAM) return ENEMY_COLOR;
  if (team === NO_TEAM || team < 0) return ffaColor(playerId);
  return TEAM_COLORS[team % TEAM_COLORS.length];
}

export function teamName(team: TeamId): string {
  if (team === NO_TEAM) return 'Free-for-all';
  if (team === ENEMY_TEAM) return 'The Swarm';
  if (team < 0) return 'Spectator';
  return TEAM_NAMES[team % TEAM_NAMES.length];
}

export function hexToCss(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

function hslToHex(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(f(0) * 255), g = Math.round(f(8) * 255), b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}
