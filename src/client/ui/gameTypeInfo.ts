// Pure (DOM-free) presentation logic for v0.3 game types: Command cards and live list, the type-aware
// settings rows shared by CreateGameModal and the RoomLobby host panel, and room titles.
// docs/v0.3-proposal.md §2.3 / §2.5 / §3.1 / §3.2. data/gameTypes.ts is canon for the numbers.
import { RIFT_FLOOR_OPTIONS } from '../../shared/constants';
import { COSMETICS } from '../../shared/data/cosmetics';
import {
  firstReadySubMode, GAME_TYPE_IDS, GAME_TYPES, isGameType, isSubMode, objectiveTarget, readySubModes, SUB_MODES,
  subModeInType, subModeLabel,
} from '../../shared/data/gameTypes';
import { RARITY_COLORS, RARITY_NAMES, SET_INFO } from '../../shared/data/loot';
import { hexToCss } from '../../shared/data/teams';
import {
  DEFAULT_SETTINGS_BY_TYPE, type JoinIntent, type RoomSettings, type RoomSummary,
} from '../../shared/protocol';
import type { BotSkill, CosmeticId, GameMode, GameType, MatchView, PveIntensity, Rarity, SubMode } from '../../shared/types';

// ------------------------------------------------------------------ small formatting

/** m:ss. `ceil` for countdowns ("0:14 left"), floor for elapsed time ("12:40 in"). */
export function fmtMinSec(sec: number, ceil = true): string {
  const s = Math.max(0, ceil ? Math.ceil(sec - 1e-9) : Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function typeAccentCss(t: GameType): string {
  return hexToCss(GAME_TYPES[t].accent);
}

export function rarityCss(r: Rarity): string {
  return hexToCss(RARITY_COLORS[r] ?? RARITY_COLORS[0]);
}

/** Sub-mode short tag for lists: Warzone deathmatch reads "Classic". */
export function subModeShort(t: GameType, s: SubMode): string {
  if (t === 'warzone' && s === 'deathmatch') return 'Classic';
  return SUB_MODES[s]?.short ?? s;
}

/** True when the type has at least one ready sub-mode (else its card reads "Coming soon"). */
export function typeOpen(t: GameType): boolean {
  return firstReadySubMode(t) !== null;
}

/** First type with a ready sub-mode (Command's default selection). */
export function defaultCommandType(): GameType {
  return GAME_TYPE_IDS.find(typeOpen) ?? GAME_TYPE_IDS[0];
}

/** Stored 'voidswarm.command.type' value → a valid type (unknown / garbage → default). */
export function parseStoredType(v: string | null): GameType {
  return isGameType(v) ? v : defaultCommandType();
}

type ModeFields = Pick<RoomSummary, 'gameType' | 'subMode' | 'mode' | 'teamCount' | 'floors'>;

/** "CTF · 2 teams", "DM · FFA", "Co-op · 6 floors", "Classic · 4 teams". */
export function modeLabel(r: ModeFields): string {
  const short = subModeShort(r.gameType, r.subMode);
  if (r.gameType === 'dungeon') return `${short} · ${r.floors} floors`;
  if (r.mode === 'ffa') return `${short} · FFA`;
  return `${short} · ${r.teamCount} teams`;
}

/** RoomLobby title tail: "Arena · Capture the Flag · 2 teams" / "Dungeon Runner · Co-op Descent · 6 floors". */
export function roomTitleText(s: Pick<RoomSettings, 'gameType' | 'subMode' | 'mode' | 'teamCount' | 'floors'>): string {
  const t = isGameType(s.gameType) ? s.gameType : 'warzone';
  const sub = isSubMode(s.subMode) ? s.subMode : 'deathmatch';
  const tail = t === 'dungeon' ? `${s.floors} floors` : s.mode === 'ffa' ? 'Free-for-all' : `${s.teamCount} teams`;
  return `${GAME_TYPES[t].name} · ${subModeLabel(t, sub)} · ${tail}`;
}

/** Results banner sub-line ("Arena · Deathmatch", "Warzone · Classic"). */
export function resultModeLine(gameType: GameType | undefined, subMode: SubMode | undefined): string {
  if (!isGameType(gameType) || !isSubMode(subMode)) return '';
  return `${GAME_TYPES[gameType].name} · ${subModeLabel(gameType, subMode)}`;
}

// ------------------------------------------------------------------ HUD (top-centre strip)

/** The clock shows only in timed matches (`MatchView.timed` absent = timed, e.g. a v0.2 view). */
export function hudShowsClock(m: Pick<MatchView, 'timed' | 'timeLeftSec'>): boolean {
  return m.timed !== false;
}

/** "WAVE n" in Warzone; empty in Arena (wave 0) and in dungeons (there the wave is the rift's enemy tier). */
export function hudWaveText(m: Pick<MatchView, 'wave' | 'dungeon' | 'gameType'>): string {
  if (m.dungeon || m.gameType === 'dungeon') return '';
  return m.wave > 0 ? `WAVE ${m.wave}` : '';
}

// ------------------------------------------------------------------ live list

/** Humans actually flying (spectators excluded). */
export function activeHumans(r: Pick<RoomSummary, 'humans' | 'spectators'>): number {
  return Math.max(0, r.humans - (r.spectators || 0));
}

/** Pilots column: active humans, "+bots / max", and "watch n". */
export function pilotsParts(r: RoomSummary): { humans: string; rest: string; watch: string } {
  return {
    humans: String(activeHumans(r)),
    rest: ` +${r.bots} / ${r.maxPlayers}`,
    watch: r.spectators > 0 ? `watch ${r.spectators}` : '',
  };
}

/**
 * Status cell (§2.3). Timers count down on the client from `roomsAt` (when the list arrived) to `now`
 * (same clock, ms).
 */
export function statusText(r: RoomSummary, roomsAt: number, now: number): string {
  const dt = Math.max(0, (now - roomsAt) / 1000);
  switch (r.phase) {
    case 'lobby': {
      if (r.startsInSec > 0) {
        const left = r.startsInSec - dt;
        return left > 0 ? `Starting in ${fmtMinSec(left)}` : 'Launching';
      }
      return r.humans > 0 ? 'Lobby' : 'Open · bots ready';
    }
    case 'countdown': return 'Launching';
    case 'results': return 'Wrapping up';
    case 'playing': {
      const L = r.live;
      if (!L) return 'Live';
      if (r.gameType === 'dungeon') {
        const lives = L.lives >= 0 ? `${L.lives} ${L.lives === 1 ? 'life' : 'lives'}` : '';
        return join([`Floor ${L.floor}/${L.floorsTotal}`, `${fmtMinSec(L.elapsedSec + dt, false)} in`, lives]);
      }
      if (L.timeLeftSec < 0) return join([`${fmtMinSec(L.elapsedSec + dt, false)} in`, L.scoreline]);
      return join([
        `${fmtMinSec(L.timeLeftSec - dt)} left`, L.scoreline,
        r.gameType === 'warzone' && L.wave > 0 ? `Wave ${L.wave}` : '',
      ]);
    }
  }
  return '';
}

function join(parts: string[]): string {
  return parts.filter((p) => !!p).join(' · ');
}

/** 0 live with humans · 1 lobby with humans · 2 idle house room · 3 everything else. */
export function roomCategory(r: RoomSummary): number {
  if (r.humans > 0) return r.phase === 'playing' ? 0 : 1;
  return r.house ? 2 : 3;
}

/** Joinable first; then live with humans, lobby with humans, idle house rooms; then humans desc. Stable. */
export function sortRooms(rooms: readonly RoomSummary[]): RoomSummary[] {
  return rooms
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(!a.r.joinable) - Number(!b.r.joinable)
      || roomCategory(a.r) - roomCategory(b.r)
      || b.r.humans - a.r.humans
      || a.i - b.i)
    .map((x) => x.r);
}

/** Rooms of one type (and optionally one sub-mode). */
export function filterRooms(rooms: readonly RoomSummary[], t: GameType, sub: SubMode | null): RoomSummary[] {
  return rooms.filter((r) => r.gameType === t && (sub === null || r.subMode === sub));
}

/** List rows shown before "Show all". */
export const LIST_ROWS = 12;

export interface RowAction {
  kind: 'join' | 'watch' | 'full';
  label: string;
  /** Sent with joinRoom; absent for the disabled "Full". */
  intent?: JoinIntent;
}

/** Action buttons for a live-list row (§2.3). Watch is hidden offline. */
export function rowActions(r: RoomSummary, offline: boolean): RowAction[] {
  const out: RowAction[] = [];
  const playing = r.phase === 'playing';
  const watch = !offline && r.watchable;
  if (r.joinable) {
    out.push(playing
      ? { kind: 'join', label: r.gameType === 'dungeon' ? 'Join · next floor' : 'Join', intent: 'play' }
      : { kind: 'join', label: 'Join', intent: 'lobby' });
    if (playing && watch) out.push({ kind: 'watch', label: 'Watch', intent: 'watch' });
  } else if (watch) {
    out.push({ kind: 'watch', label: 'Watch', intent: 'watch' });
  }
  if (!out.length) out.push({ kind: 'full', label: 'Full' });
  return out;
}

/** Card live line data: rooms of the type in play, and humans in its rooms. */
export function typeLive(rooms: readonly RoomSummary[], t: GameType): { live: number; pilots: number } {
  let live = 0, pilots = 0;
  for (const r of rooms) {
    if (r.gameType !== t) continue;
    if (r.phase === 'playing') live++;
    pilots += r.humans;
  }
  return { live, pilots };
}

export function liveLine(rooms: readonly RoomSummary[], t: GameType): string {
  const { live, pilots } = typeLive(rooms, t);
  return `${live} live · ${pilots} ${pilots === 1 ? 'pilot' : 'pilots'}`;
}

/** "N pilots online" (roomList.online). */
export function onlineText(n: number): string {
  return `${n} ${n === 1 ? 'pilot' : 'pilots'} online`;
}

// ------------------------------------------------------------------ draws strip

export const DRAWS_LINE = 'Hulls ×3 · Weapons ×3 · Turrets ×3 · Engine · Death FX · Title · Kill icon';

export interface DrawChip { id: CosmeticId; name: string; rarity: Rarity; rarityName: string }

/** The type's exclusive set's 3 featured items (SET_INFO[set].featured), for the card's draws strip. */
export function featuredDraws(t: GameType): DrawChip[] {
  const set = GAME_TYPES[t].lootSet;
  return SET_INFO[set].featured.flatMap((id) => {
    const d = COSMETICS[id];
    return d ? [{ id, name: d.name, rarity: d.rarity, rarityName: RARITY_NAMES[d.rarity] ?? '' }] : [];
  });
}

export function setName(t: GameType): string {
  return SET_INFO[GAME_TYPES[t].lootSet].name;
}

// ------------------------------------------------------------------ type-aware settings rows

export type SettingsKey =
  | 'gameType' | 'subMode' | 'mode' | 'teamCount' | 'floors' | 'objectiveLimit' | 'scoreLimit'
  | 'maxPlayers' | 'botFill' | 'botSkill' | 'matchMinutes' | 'pveIntensity' | 'friendlyFire';

export interface FieldOpt { value: string; label: string; disabled?: boolean }

export interface FieldSpec {
  key: SettingsKey;
  label: string;
  kind: 'select' | 'number' | 'check';
  options?: FieldOpt[];
  min?: number;
  max?: number;
  value: string | boolean;
  /** Changing it outside the lobby is refused by the server (§3.2). */
  lobbyOnly: boolean;
}

const MINUTE_STEPS = [1, 3, 5, 8, 10, 12, 15, 20, 25, 30];
const SCORE_STEPS = [0, 100, 250, 500, 1000, 2500];
const POINT_STEPS = [60, 100, 120, 150, 200, 250, 300, 400, 500, 600, 750, 1000];
const LOBBY_ONLY: ReadonlySet<SettingsKey> = new Set(['gameType', 'subMode', 'mode', 'teamCount', 'floors']);

/** Upper bound on seats for the type (dungeon: party size × parties). */
export function seatMax(s: Pick<RoomSettings, 'gameType' | 'teamCount'>): number {
  const T = GAME_TYPES[s.gameType];
  return T.partySize ? Math.max(1, s.teamCount) * T.partySize : T.maxPlayers;
}

/** "1 capture" / "3 captures" (units are plural in data/gameTypes.ts limitLabel). */
export function countLabel(n: number, unit: string): string {
  return `${n} ${n === 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit}`;
}

function withCurrent(opts: FieldOpt[], value: string, label: string): FieldOpt[] {
  return opts.some((o) => o.value === value) ? opts : [...opts, { value, label }];
}

/**
 * The rows shown for `s` (§2.5 / §9 CLIENT M1): ready sub-modes only; the FFA toggle only when the
 * sub-mode allows it; team range from the sub-mode; floors 3/6 for dungeons; a target with its unit for
 * objective sub-modes; the DM score limit; seats + bot fill; bot skill; match length hidden for
 * dungeons; Swarm / Difficulty (hidden for Arena); friendly fire / Reckless.
 */
export function settingsFields(s: RoomSettings, includeType: boolean): FieldSpec[] {
  const t: GameType = isGameType(s.gameType) ? s.gameType : 'warzone';
  const T = GAME_TYPES[t];
  const sub: SubMode = isSubMode(s.subMode) && subModeInType(t, s.subMode) ? s.subMode : T.defaultSubMode;
  const D = SUB_MODES[sub];
  const out: FieldSpec[] = [];
  const add = (f: Omit<FieldSpec, 'lobbyOnly'>) => out.push({ ...f, lobbyOnly: LOBBY_ONLY.has(f.key) });

  if (includeType) {
    add({
      key: 'gameType', label: 'Game type', kind: 'select', value: t,
      options: GAME_TYPE_IDS.map((id) => ({
        value: id, label: typeOpen(id) ? GAME_TYPES[id].name : `${GAME_TYPES[id].name} (soon)`, disabled: !typeOpen(id) && id !== t,
      })),
    });
  }
  const subs = readySubModes(t);
  add({
    key: 'subMode', label: 'Mode', kind: 'select', value: sub,
    options: withCurrent(subs.map((id) => ({ value: id, label: subModeLabel(t, id) })), sub, subModeLabel(t, sub)),
  });
  if (D.ffa && t !== 'dungeon') {
    add({
      key: 'mode', label: 'Allegiance', kind: 'select', value: s.mode === 'ffa' ? 'ffa' : 'teams',
      options: [{ value: 'teams', label: 'Teams' }, { value: 'ffa', label: 'Free-for-all' }],
    });
  }
  const teamsMode = s.mode !== 'ffa' || !D.ffa || t === 'dungeon';
  if (teamsMode && D.minTeams < D.maxTeams) {
    const opts: FieldOpt[] = [];
    for (let n = D.minTeams; n <= D.maxTeams; n++) opts.push({ value: String(n), label: `${n} teams` });
    add({ key: 'teamCount', label: 'Teams', kind: 'select', value: String(s.teamCount), options: withCurrent(opts, String(s.teamCount), `${s.teamCount} teams`) });
  }
  if (t === 'dungeon') {
    add({
      key: 'floors', label: 'Floors', kind: 'select', value: String(s.floors),
      options: withCurrent(RIFT_FLOOR_OPTIONS.map((n) => ({ value: String(n), label: `${n} floors` })), String(s.floors), `${s.floors} floors`),
    });
  }
  if (D.limitMax > 0) {
    const unit = D.limitLabel || 'points';
    const def = objectiveTarget(sub, teamsMode ? 'teams' : 'ffa', 0);
    const steps = D.limitMax <= 10
      ? Array.from({ length: D.limitMax - D.limitMin + 1 }, (_, i) => D.limitMin + i)
      : POINT_STEPS.filter((n) => n >= D.limitMin && n <= D.limitMax);
    const opts: FieldOpt[] = [{ value: '0', label: `Default (${countLabel(def, unit)})` }, ...steps.map((n) => ({ value: String(n), label: countLabel(n, unit) }))];
    add({ key: 'objectiveLimit', label: 'Target', kind: 'select', value: String(s.objectiveLimit), options: withCurrent(opts, String(s.objectiveLimit), countLabel(s.objectiveLimit, unit)) });
  }
  if (sub === 'deathmatch') {
    add({
      key: 'scoreLimit', label: 'Score limit', kind: 'select', value: String(s.scoreLimit),
      options: withCurrent(SCORE_STEPS.map((n) => ({ value: String(n), label: n ? String(n) : 'None' })), String(s.scoreLimit), String(s.scoreLimit)),
    });
  }
  const max = seatMax({ gameType: t, teamCount: teamsMode ? s.teamCount : 1 });
  add({ key: 'maxPlayers', label: t === 'dungeon' ? 'Party seats' : 'Max pilots', kind: 'number', min: T.minPlayers, max, value: String(s.maxPlayers) });
  add({ key: 'botFill', label: 'Bot fill', kind: 'number', min: 0, max: Math.max(0, Math.min(max, s.maxPlayers)), value: String(s.botFill) });
  add({
    key: 'botSkill', label: 'Bot skill', kind: 'select', value: s.botSkill,
    options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
  });
  if (!T.untimed) {
    const opts = MINUTE_STEPS.filter((m) => m >= T.minutesMin && m <= T.minutesMax).map((m) => ({ value: String(m), label: `${m} min` }));
    add({ key: 'matchMinutes', label: 'Match length', kind: 'select', value: String(s.matchMinutes), options: withCurrent(opts, String(s.matchMinutes), `${s.matchMinutes} min`) });
  }
  if (T.pve !== 'off') {
    add({
      key: 'pveIntensity', label: t === 'dungeon' ? 'Difficulty' : 'Swarm', kind: 'select', value: String(s.pveIntensity),
      options: [1, 2, 3].map((i) => ({ value: String(i), label: T.pveLabels[i] })),
    });
  }
  add({ key: 'friendlyFire', label: t === 'dungeon' ? 'Reckless (friendly fire)' : 'Friendly fire', kind: 'check', value: !!s.friendlyFire });
  return out;
}

/** A raw control value → the settings patch to send / apply. */
export function fieldPatch(key: SettingsKey, raw: string | boolean): Partial<RoomSettings> {
  const n = typeof raw === 'string' ? Number(raw) : 0;
  switch (key) {
    case 'gameType': return isGameType(raw) ? { gameType: raw } : {};
    case 'subMode': return isSubMode(raw) ? { subMode: raw } : {};
    case 'mode': return { mode: raw === 'ffa' ? 'ffa' : 'teams' };
    case 'botSkill': return raw === 'easy' || raw === 'hard' || raw === 'normal' ? { botSkill: raw as BotSkill } : {};
    case 'friendlyFire': return { friendlyFire: raw === true || raw === 'true' };
    case 'pveIntensity': return Number.isFinite(n) ? { pveIntensity: Math.max(0, Math.min(3, Math.round(n))) as PveIntensity } : {};
    default: return Number.isFinite(n) ? { [key]: Math.round(n) } as Partial<RoomSettings> : {};
  }
}

const clampI = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * Client-side PREVIEW of the server's clampSettings / normalizeForType (§3.2), used by the Create
 * Game modal so its rows follow the rules while you edit. The server stays authoritative.
 */
export function normalizeDraft(base: RoomSettings, patch: Partial<RoomSettings>): RoomSettings {
  let out: RoomSettings = { ...base };
  // 1. type switch: re-base on the type defaults (keeping name + bot skill)
  if (isGameType(patch.gameType) && patch.gameType !== base.gameType) {
    const t = patch.gameType;
    out = { ...DEFAULT_SETTINGS_BY_TYPE[t], name: base.name, botSkill: base.botSkill };
    // Like the server's clampSettings: a not-ready default sub-mode (Arena CTF until M3) is replaced by the
    // first ready one, with that one's own match length.
    const sub = SUB_MODES[out.subMode].ready ? out.subMode : firstReadySubMode(t);
    if (sub && sub !== out.subMode) { out.subMode = sub; out.matchMinutes = SUB_MODES[sub].defaultMinutes; }
  }
  // 2. sub-mode switch (ready members of the type only): reset length + target unless the patch sets them
  if (isSubMode(patch.subMode) && patch.subMode !== out.subMode && subModeInType(out.gameType, patch.subMode)
    && SUB_MODES[patch.subMode].ready) {
    out.subMode = patch.subMode;
    if (patch.matchMinutes === undefined) out.matchMinutes = SUB_MODES[patch.subMode].defaultMinutes;
    if (patch.objectiveLimit === undefined) out.objectiveLimit = 0;
  }
  // 3. plain fields (wide bounds)
  if (typeof patch.name === 'string') out.name = patch.name.slice(0, 32);
  if (patch.mode === 'ffa' || patch.mode === 'teams') out.mode = patch.mode;
  if (patch.teamCount !== undefined) out.teamCount = clampI(patch.teamCount, 1, 8, out.teamCount);
  if (patch.maxPlayers !== undefined) out.maxPlayers = clampI(patch.maxPlayers, 1, 32, out.maxPlayers);
  if (patch.botFill !== undefined) out.botFill = clampI(patch.botFill, 0, 32, out.botFill);
  if (patch.matchMinutes !== undefined) out.matchMinutes = clampI(patch.matchMinutes, 0, 60, out.matchMinutes);
  if (patch.floors !== undefined) out.floors = clampI(patch.floors, 0, 10, out.floors);
  if (patch.objectiveLimit !== undefined) out.objectiveLimit = clampI(patch.objectiveLimit, 0, 5000, out.objectiveLimit);
  if (patch.scoreLimit !== undefined) out.scoreLimit = clampI(patch.scoreLimit, 0, 100000, out.scoreLimit);
  if (patch.pveIntensity !== undefined) out.pveIntensity = clampI(patch.pveIntensity, 0, 3, out.pveIntensity) as PveIntensity;
  if (patch.botSkill === 'easy' || patch.botSkill === 'normal' || patch.botSkill === 'hard') out.botSkill = patch.botSkill;
  if (typeof patch.friendlyFire === 'boolean') out.friendlyFire = patch.friendlyFire;
  return normalizeForTypePreview(out);
}

/** §3.2 normalizeForType, step for step (preview only). */
export function normalizeForTypePreview(s: RoomSettings): RoomSettings {
  const out = { ...s };
  const t: GameType = isGameType(out.gameType) ? out.gameType : 'warzone';
  out.gameType = t;
  const T = GAME_TYPES[t];
  if (!isSubMode(out.subMode) || !subModeInType(t, out.subMode)) out.subMode = T.defaultSubMode;
  if (!SUB_MODES[out.subMode].ready) {
    const was = out.subMode;
    out.subMode = firstReadySubMode(t) ?? T.defaultSubMode;
    if (out.subMode !== was && out.matchMinutes === SUB_MODES[was].defaultMinutes) out.matchMinutes = SUB_MODES[out.subMode].defaultMinutes;
  }
  const D = SUB_MODES[out.subMode];
  let mode: GameMode = out.mode === 'ffa' ? 'ffa' : 'teams';
  if (t === 'dungeon' || (mode === 'ffa' && !D.ffa)) mode = 'teams';
  out.mode = mode;
  out.teamCount = mode === 'teams' ? clampI(out.teamCount, D.minTeams, D.maxTeams, D.minTeams) : clampI(out.teamCount, 2, 8, 2);
  out.maxPlayers = clampI(out.maxPlayers, T.minPlayers, T.partySize ? out.teamCount * T.partySize : T.maxPlayers, T.maxPlayers);
  out.botFill = Math.min(Math.max(0, out.botFill), out.maxPlayers);
  out.matchMinutes = T.untimed ? 0 : clampI(out.matchMinutes, T.minutesMin, T.minutesMax, T.minutesMin);
  out.pveIntensity = (T.pve === 'off' ? 0 : clampI(out.pveIntensity, 1, 3, 2)) as PveIntensity;
  if (t === 'dungeon') {
    const f = out.floors > 0 ? out.floors : 6;
    let best = RIFT_FLOOR_OPTIONS[0];
    for (const o of RIFT_FLOOR_OPTIONS) if (Math.abs(o - f) < Math.abs(best - f)) best = o; // ties keep the lower
    out.floors = best;
  } else {
    out.floors = 0;
  }
  out.objectiveLimit = D.limitMax === 0 || out.objectiveLimit <= 0 ? 0 : clampI(out.objectiveLimit, D.limitMin, D.limitMax, 0);
  if (out.subMode !== 'deathmatch') out.scoreLimit = 0;
  return out;
}

/** Create Game starting point for a type: its defaults, the pilot's room name, and a ready sub-mode. */
export function createDefaults(t: GameType, name: string): RoomSettings {
  const base = { ...DEFAULT_SETTINGS_BY_TYPE[t], name: name.slice(0, 32) };
  const out = normalizeForTypePreview(base);
  // The default sub-mode wasn't ready (Arena CTF before M3): use the substitute's own match length.
  if (out.subMode !== base.subMode) out.matchMinutes = normalizeForTypePreview({ ...out, matchMinutes: SUB_MODES[out.subMode].defaultMinutes }).matchMinutes;
  return out;
}
