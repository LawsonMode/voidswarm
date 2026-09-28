// FROZEN SHAPE — v0.3 game types + sub-modes. Numbers are tuning (ROOM may adjust, noting it in its report).
// `ready` is flipped by the owning module when its sim + bots land (see ARCHITECTURE.md §7 milestones).
import { PARTY_SIZE } from '../constants';
import type { GameMode, GameType, LootSet, ObjectiveSubMode, SubMode } from '../types';

export interface SubModeDef {
  id: SubMode;
  name: string;
  short: string;
  icon: string;
  blurb: string;
  /** Game types listing this sub-mode. */
  types: readonly GameType[];
  /** mode 'ffa' allowed. */
  ffa: boolean;
  minTeams: number;
  maxTeams: number;
  /** Target used when objectiveLimit === 0 (0 = no objective target). */
  defaultLimit: number;
  /** FFA default target (hotpoint). */
  defaultLimitFfa: number;
  limitMin: number;
  limitMax: number;
  limitLabel: '' | 'captures' | 'points';
  /** matchMinutes when this sub-mode is picked (0 = untimed). */
  defaultMinutes: number;
  /** Implemented in the sim AND bots play it. false = hidden/skipped by Command, Create, Quick Play, house rooms. */
  ready: boolean;
  since: '0.3' | '0.4';
}

export interface GameTypeDef {
  id: GameType;
  name: string;
  kind: 'PvE' | 'PvP' | 'PvPvE';
  tagline: string;
  bullets: readonly string[];
  /** UI accent 0xRRGGBB (card; not a ship accent). */
  accent: number;
  icon: string;
  subModes: readonly SubMode[];
  defaultSubMode: SubMode;
  minPlayers: number;
  maxPlayers: number;
  /** Players per team when > 0 (dungeon parties). */
  partySize: number;
  pve: 'off' | 'on';
  /** Labels for pveIntensity 0..3 in this type. */
  pveLabels: readonly [string, string, string, string];
  minutesMin: number;
  minutesMax: number;
  /** matchMinutes forced to 0. */
  untimed: boolean;
  dropIn: 'any' | 'floorStart';
  /** Exclusive loot set of this type (data/loot.ts SET_FOR_TYPE mirrors it). */
  lootSet: Exclude<LootSet, 'common'>;
  /** Base name for Quick Play overflow rooms. */
  houseName: string;
  playersLine: string;
}

export const SUB_MODES: Readonly<Record<SubMode, SubModeDef>> = {
  coop: { id: 'coop', name: 'Co-op Descent', short: 'Co-op', icon: '▼', blurb: 'One party of up to 4 pilots clears floor after floor.', types: ['dungeon'], ffa: false, minTeams: 1, maxTeams: 1, defaultLimit: 0, defaultLimitFfa: 0, limitMin: 0, limitMax: 0, limitLabel: '', defaultMinutes: 0, ready: true, since: '0.3' },
  rival: { id: 'rival', name: 'Rival Rift', short: 'Rival', icon: '⇄', blurb: 'Two parties race the same rift — and can shoot each other.', types: ['dungeon'], ffa: false, minTeams: 2, maxTeams: 2, defaultLimit: 0, defaultLimitFfa: 0, limitMin: 0, limitMax: 0, limitLabel: '', defaultMinutes: 0, ready: false, since: '0.4' },
  deathmatch: { id: 'deathmatch', name: 'Deathmatch', short: 'DM', icon: '✕', blurb: 'Score by kills and bounties (and swarm kills in Warzone).', types: ['arena', 'warzone'], ffa: true, minTeams: 2, maxTeams: 8, defaultLimit: 0, defaultLimitFfa: 0, limitMin: 0, limitMax: 0, limitLabel: '', defaultMinutes: 10, ready: true, since: '0.3' },
  ctf: { id: 'ctf', name: 'Capture the Flag', short: 'CTF', icon: '⚑', blurb: 'Steal their pennant; score it while yours is home.', types: ['arena'], ffa: false, minTeams: 2, maxTeams: 4, defaultLimit: 3, defaultLimitFfa: 3, limitMin: 1, limitMax: 10, limitLabel: 'captures', defaultMinutes: 12, ready: true, since: '0.3' },
  zones: { id: 'zones', name: 'Control Zones', short: 'Zones', icon: '◎', blurb: 'Hold relay pads; every owned pad ticks points.', types: ['arena', 'warzone'], ffa: false, minTeams: 2, maxTeams: 8, defaultLimit: 300, defaultLimitFfa: 300, limitMin: 100, limitMax: 1000, limitLabel: 'points', defaultMinutes: 10, ready: true, since: '0.3' },
  hotpoint: { id: 'hotpoint', name: 'Hot Point', short: 'Hot', icon: '✦', blurb: 'One point that moves every 60 s. Hold it uncontested to score.', types: ['arena'], ffa: true, minTeams: 2, maxTeams: 8, defaultLimit: 200, defaultLimitFfa: 120, limitMin: 60, limitMax: 600, limitLabel: 'points', defaultMinutes: 10, ready: true, since: '0.3' },
  escort: { id: 'escort', name: 'Escort', short: 'Escort', icon: '⬢', blurb: 'Push the payload through 3 checkpoints, then defend. 2-round stopwatch.', types: ['arena'], ffa: false, minTeams: 2, maxTeams: 2, defaultLimit: 0, defaultLimitFfa: 0, limitMin: 0, limitMax: 0, limitLabel: '', defaultMinutes: 0, ready: false, since: '0.4' },
};

export const GAME_TYPE_IDS: readonly GameType[] = ['dungeon', 'arena', 'warzone'];

export const GAME_TYPES: Readonly<Record<GameType, GameTypeDef>> = {
  dungeon: {
    id: 'dungeon', name: 'Dungeon Runner', kind: 'PvE', icon: '▼', accent: 0x2bf0c8,
    tagline: 'Descend together. Loot is only yours once you get it out.',
    bullets: ['Party of 1–4 (bots fill empty seats) · Reckless mode lets you shoot each other', '3 or 6 procedural floors — sealed arenas, treasure, a boss every 3rd floor', 'Die and your unsecured loot spills — extract after a boss to bank it'],
    subModes: ['coop', 'rival'], defaultSubMode: 'coop', minPlayers: 1, maxPlayers: PARTY_SIZE, partySize: PARTY_SIZE,
    pve: 'on', pveLabels: ['—', 'Story', 'Veteran', 'Nightmare'], minutesMin: 0, minutesMax: 0, untimed: true,
    dropIn: 'floorStart', lootSet: 'rift', houseName: 'Dungeon Run', playersLine: '1–4 pilots · bots fill the party',
  },
  arena: {
    id: 'arena', name: 'Arena', kind: 'PvP', icon: '◆', accent: 0xd8b35a,
    tagline: 'Pilots only. Play the objective.',
    bullets: ['Capture the Flag · Control Zones · Hot Point · Deathmatch', 'CTF 2–4 teams · Zones / Hot Point / DM up to 8 teams or FFA', 'No swarm — every kill is a pilot'],
    subModes: ['ctf', 'zones', 'hotpoint', 'deathmatch', 'escort'], defaultSubMode: 'ctf', minPlayers: 2, maxPlayers: 32, partySize: 0,
    pve: 'off', pveLabels: ['Off', 'Off', 'Off', 'Off'], minutesMin: 3, minutesMax: 20, untimed: false,
    dropIn: 'any', lootSet: 'gladiator', houseName: 'Arena', playersLine: '2–32 pilots · 8v8 default',
  },
  warzone: {
    id: 'warzone', name: 'Warzone', kind: 'PvPvE', icon: '✺', accent: 0xc6ff3b,
    tagline: 'Fight each other while the swarm eats everyone.',
    bullets: ['Up to 32 pilots · FFA or 2–8 teams', 'Swarm waves every 30 s, a Hive every 5th wave', 'Classic scoring, or hold Control Zones under swarm pressure'],
    subModes: ['deathmatch', 'zones'], defaultSubMode: 'deathmatch', minPlayers: 2, maxPlayers: 32, partySize: 0,
    pve: 'on', pveLabels: ['Off', 'Low', 'Normal', 'Chaos'], minutesMin: 1, minutesMax: 30, untimed: false,
    dropIn: 'any', lootSet: 'swarm', houseName: 'Warzone', playersLine: 'Up to 32 · FFA or 2–8 teams',
  },
};

export function isGameType(v: unknown): v is GameType {
  return typeof v === 'string' && (GAME_TYPE_IDS as readonly string[]).includes(v);
}
export function isSubMode(v: unknown): v is SubMode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SUB_MODES, v);
}
export function isObjectiveSubMode(s: SubMode): s is ObjectiveSubMode {
  return s === 'ctf' || s === 'zones' || s === 'hotpoint' || s === 'escort';
}
export function subModeInType(t: GameType, s: SubMode): boolean {
  return GAME_TYPES[t].subModes.includes(s);
}
export function readySubModes(t: GameType): SubMode[] {
  return GAME_TYPES[t].subModes.filter((s) => SUB_MODES[s].ready);
}
/** First ready sub-mode of a type (defaultSubMode preferred), or null if none is implemented yet. */
export function firstReadySubMode(t: GameType): SubMode | null {
  const T = GAME_TYPES[t];
  if (SUB_MODES[T.defaultSubMode].ready) return T.defaultSubMode;
  return T.subModes.find((s) => SUB_MODES[s].ready) ?? null;
}
/** Display label: Warzone deathmatch reads "Classic". */
export function subModeLabel(t: GameType, s: SubMode): string {
  return t === 'warzone' && s === 'deathmatch' ? 'Classic' : SUB_MODES[s].name;
}
/** Effective objective target (0 = no target). */
export function objectiveTarget(s: SubMode, mode: GameMode, objectiveLimit: number): number {
  const d = SUB_MODES[s];
  if (d.limitMax === 0) return 0;
  if (objectiveLimit > 0) return Math.max(d.limitMin, Math.min(d.limitMax, Math.round(objectiveLimit)));
  return mode === 'ffa' ? d.defaultLimitFfa : d.defaultLimit;
}
/** Legal type/sub-mode/allegiance/team combination (readiness NOT checked). Used by clampSettings + Sim fallback. */
export function isLegalCombo(t: GameType, s: SubMode, mode: GameMode, teamCount: number): boolean {
  if (!subModeInType(t, s)) return false;
  const d = SUB_MODES[s];
  if (mode === 'ffa') return d.ffa && t !== 'dungeon';
  return Number.isInteger(teamCount) && teamCount >= d.minTeams && teamCount <= d.maxTeams;
}
