// OWNER: ROOM agent. Small pure helpers: name sanitizing, settings clamping (v0.3: per game type), Quick Play
// scoring, bot callsigns, input sanitizing.
import { MAX_PLAYERS, MAX_TEAMS, MIN_TEAMS, NAME_MAX_LEN, QUICKPLAY_MIN_TIME_LEFT_SEC, RIFT_FLOOR_OPTIONS } from '../constants';
import {
  GAME_TYPES, GAME_TYPE_IDS, SUB_MODES, firstReadySubMode, isGameType, isSubMode, subModeLabel,
} from '../data/gameTypes';
import { DEFAULT_ROOM_SETTINGS, DEFAULT_SETTINGS_BY_TYPE, type RoomSettings, type RoomSummary } from '../protocol';
import { SHIP_CLASS_IDS } from '../data/ships';
import {
  emptyInput, type BotSkill, type GameType, type InputState, type PveIntensity, type ShipClassId, type SubMode,
} from '../types';

const CONTROL_RE = /[\p{C}]/gu;
/**
 * Characters that render as blank / nothing but are not \s or \p{C}: Hangul fillers (Lo), the combining
 * grapheme joiner, Mongolian/Khmer invisibles, variation selectors, braille blank.
 */
const INVISIBLE_RE = /[\u115F\u1160\u3164\uFFA0\u034F\u17B4\u17B5\u180B-\u180F\uFE00-\uFE0F\u2800\u{E0100}-\u{E01EF}]/gu;
const MARK_RE = /\p{M}/gu;

/**
 * Strip control/format/invisible chars, NFKC-fold (fullwidth / math-bold / ligature letters become plain),
 * collapse whitespace, trim, clamp to maxLen. Empty -> fallback.
 */
export function sanitizeName(raw: unknown, fallback = 'Pilot', maxLen = NAME_MAX_LEN): string {
  let s = typeof raw === 'string' ? raw.slice(0, 256) : '';
  s = s.normalize('NFKC').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || fallback;
}

/** Everything outside the registered-username charset (USERNAME_RE). */
const NOT_USERNAME_CHAR_RE = /[^A-Za-z0-9_-]/g;
/** Bot callsigns may also keep single spaces ("Neon Moth"). */
const NOT_BOT_CHAR_RE = /[^A-Za-z0-9 _-]/g;

/** NFKD-fold (fullwidth / math-bold / ligatures -> plain; accented letters -> base + mark), drop marks & invisibles. */
function asciiFold(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.slice(0, 256) : '';
  return s.normalize('NFKD').replace(MARK_RE, '').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
}

/**
 * SEC-8: a guest (no account) callsign uses the same ASCII charset as registered usernames,
 * [A-Za-z0-9_-]: NFKD-fold ('José' -> 'Jose', fullwidth / styled letters -> plain), trim, collapse each
 * whitespace run to '_', then drop every other character (so homoglyphs from any script — Cyrillic,
 * Greek, Armenian, Cherokee, Lisu, IPA... — can't imitate a Latin name). Clamped to maxLen; empty ->
 * fallback. The caller still applies the reserved / look-alike dedupe on top.
 */
export function sanitizeGuestName(raw: unknown, fallback = 'Pilot', maxLen = NAME_MAX_LEN): string {
  let s = asciiFold(raw).trim().replace(/\s+/g, '_').replace(NOT_USERNAME_CHAR_RE, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || fallback;
}

/** SEC-8: bot callsigns are ASCII too — the guest charset plus single inner spaces. */
export function sanitizeBotName(raw: unknown, fallback = 'Bot', maxLen = NAME_MAX_LEN): string {
  let s = asciiFold(raw).replace(/\s+/g, ' ').replace(NOT_BOT_CHAR_RE, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || fallback;
}

/**
 * Lowercase Cyrillic / Greek / IPA letters that look like a Latin letter (after toLowerCase, so an
 * uppercase look-alike such as Cyrillic 'Н' or Greek 'Η' maps via its lowercase form).
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u0437': '3', '\u043A': 'k', '\u043C': 'm', '\u043D': 'h', '\u043E': 'o', '\u043F': 'n', '\u0440': 'p', '\u0441': 'c',
  '\u0442': 't', '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u04CF': 'l', '\u04BB': 'h', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w',
  '\u04AF': 'y', '\u044C': 'b',
  // Greek
  '\u03B1': 'a', '\u03B2': 'b', '\u03B3': 'y', '\u03B5': 'e', '\u03B6': 'z', '\u03B7': 'h', '\u03B9': 'i', '\u03BA': 'k', '\u03BC': 'm', '\u03BD': 'n', '\u03BF': 'o',
  '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'y', '\u03C7': 'x', '\u03C9': 'w', '\u03F2': 'c', '\u03F3': 'j', '\u03DD': 'f',
  // Latin / IPA look-alikes (small capitals, dotless i/j, script a/g)
  '\u0131': 'i', '\u0237': 'j', '\u0251': 'a', '\u0261': 'g', '\u01C0': 'l', '\u0269': 'i', '\u026A': 'i', '\u029F': 'l', '\u1D00': 'a', '\u0299': 'b', '\u1D04': 'c',
  '\u1D05': 'd', '\u1D07': 'e', '\u0262': 'g', '\u029C': 'h', '\u1D0A': 'j', '\u1D0B': 'k', '\u1D0D': 'm', '\u0274': 'n', '\u1D0F': 'o', '\u1D18': 'p', '\u0280': 'r',
  '\uA731': 's', '\u1D1B': 't', '\u1D1C': 'u', '\u1D20': 'v', '\u1D21': 'w', '\u028F': 'y', '\u1D22': 'z',
};

/**
 * Comparison key for "do these two callsigns look the same?": NFKD, drop combining marks and invisible
 * characters, collapse whitespace, lowercase, map Cyrillic/Greek/IPA look-alikes to Latin. Plain ASCII
 * names map to their lowercase form. (ASCII-only ambiguity such as I/l/1 or 0/O is not folded.)
 */
export function nameKey(name: string): string {
  const s = name.normalize('NFKD').replace(MARK_RE, '').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  let out = '';
  for (const ch of s) out += CONFUSABLE[ch] ?? ch;
  return out;
}

/** Sanitize free text (chat): strip control chars, trim, clamp length. */
export function sanitizeText(raw: unknown, maxLen: number): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Sequential suffixes tried before switching to random ones (bounds the cost of a crowded name). */
const DEDUPE_SEQUENTIAL = 99;
const DEDUPE_RANDOM_TRIES = 50;

/**
 * Make `name` unique by appending digits, keeping within maxLen. At most ~150 `taken` calls: suffixes
 * 2..99 in order, then random 3–5 digit suffixes, then an unchecked random one.
 */
export function dedupeName(name: string, taken: (n: string) => boolean, maxLen = NAME_MAX_LEN): string {
  if (!taken(name)) return name;
  const withSuffix = (suffix: string): string => name.slice(0, Math.max(1, maxLen - suffix.length)).trimEnd() + suffix;
  for (let i = 2; i <= DEDUPE_SEQUENTIAL; i++) {
    const cand = withSuffix(String(i));
    if (!taken(cand)) return cand;
  }
  for (let k = 0; k < DEDUPE_RANDOM_TRIES; k++) {
    const cand = withSuffix(String(100 + Math.floor(Math.random() * 99900)));
    if (!taken(cand)) return cand;
  }
  return withSuffix(String(Math.floor(Math.random() * 1e6)));
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
};

const SKILLS: readonly BotSkill[] = ['easy', 'normal', 'hard'];

/** Room names (settings.name) are at most this long. */
export const ROOM_NAME_MAX_LEN = 32;

/**
 * v0.3 (docs/v0.3-proposal.md §3.2): merge `patch` over `base`, validating every field, then enforce the
 * game type's rules (normalizeForType). Order:
 *  1. type switch — a valid `patch.gameType` different from base re-bases on DEFAULT_SETTINGS_BY_TYPE
 *     (keeping name + bot skill);
 *  2. sub-mode switch — a `patch.subMode` that is a READY member of the (new) type and differs from the
 *     current one resets matchMinutes to its default and objectiveLimit to 0, unless the patch sets them
 *     (a not-ready or foreign sub-mode is ignored, so it can't reset those as a side effect);
 *  3. every other field is parsed with wide raw bounds;
 *  4. normalizeForType.
 */
export function clampSettings(base: RoomSettings, patch: Partial<RoomSettings> | unknown): RoomSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  let out: RoomSettings = { ...base };
  if (!isGameType(out.gameType)) out.gameType = DEFAULT_ROOM_SETTINGS.gameType;
  if (!isSubMode(out.subMode)) out.subMode = GAME_TYPES[out.gameType].defaultSubMode;
  // 1. type switch
  if (isGameType(p.gameType) && p.gameType !== out.gameType) {
    const t = p.gameType;
    out = { ...DEFAULT_SETTINGS_BY_TYPE[t], name: out.name, botSkill: out.botSkill };
    // The type's default sub-mode may not be implemented yet (arena CTF until M3): take the substitute's
    // own match length, as if it had been picked.
    const sub = SUB_MODES[out.subMode].ready ? out.subMode : firstReadySubMode(t);
    if (sub && sub !== out.subMode) { out.subMode = sub; out.matchMinutes = SUB_MODES[sub].defaultMinutes; }
  }
  // 2. sub-mode switch (ready members of the type only)
  if (isSubMode(p.subMode) && p.subMode !== out.subMode && GAME_TYPES[out.gameType].subModes.includes(p.subMode)
    && SUB_MODES[p.subMode].ready) {
    out.subMode = p.subMode;
    if (p.matchMinutes === undefined) out.matchMinutes = SUB_MODES[p.subMode].defaultMinutes;
    if (p.objectiveLimit === undefined) out.objectiveLimit = 0;
  }
  // 3. fields (wide raw bounds; normalizeForType applies the per-type ones)
  if (p.name !== undefined) out.name = sanitizeName(p.name, out.name, ROOM_NAME_MAX_LEN);
  if (p.mode === 'ffa' || p.mode === 'teams') out.mode = p.mode;
  if (p.teamCount !== undefined) out.teamCount = clampInt(p.teamCount, 1, MAX_TEAMS, out.teamCount);
  if (p.maxPlayers !== undefined) out.maxPlayers = clampInt(p.maxPlayers, 1, MAX_PLAYERS, out.maxPlayers);
  if (p.botFill !== undefined) out.botFill = clampInt(p.botFill, 0, MAX_PLAYERS, out.botFill);
  if (typeof p.botSkill === 'string' && (SKILLS as string[]).includes(p.botSkill)) out.botSkill = p.botSkill as BotSkill;
  if (p.matchMinutes !== undefined) out.matchMinutes = clampInt(p.matchMinutes, 0, 60, out.matchMinutes);
  if (p.floors !== undefined) out.floors = clampInt(p.floors, 0, 10, out.floors);
  if (p.objectiveLimit !== undefined) out.objectiveLimit = clampInt(p.objectiveLimit, 0, 5000, out.objectiveLimit);
  if (p.scoreLimit !== undefined) out.scoreLimit = clampInt(p.scoreLimit, 0, 100000, out.scoreLimit);
  if (p.pveIntensity !== undefined) out.pveIntensity = clampInt(p.pveIntensity, 0, 3, out.pveIntensity) as PveIntensity;
  if (typeof p.friendlyFire === 'boolean') out.friendlyFire = p.friendlyFire;
  // 4. per-type rules
  return normalizeForType(out);
}

/** Snap a dungeon floor count to RIFT_FLOOR_OPTIONS (nearest; ties go lower; 0 / junk = the default 6). */
function snapFloors(v: number): number {
  const opts = RIFT_FLOOR_OPTIONS;
  const dflt = DEFAULT_SETTINGS_BY_TYPE.dungeon.floors;
  if (!(typeof v === 'number' && Number.isFinite(v)) || v <= 0) return dflt;
  let best = opts[0];
  for (const o of opts) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  return best;
}

/**
 * v0.3 (§3.2): force `s` into its game type's rules — a ready sub-mode of the type, legal allegiance and team
 * count, seats, bot fill, match length, swarm level, floors, objective target and score limit. Pure; returns
 * a new object.
 */
export function normalizeForType(s: RoomSettings): RoomSettings {
  const out: RoomSettings = { ...s };
  if (!isGameType(out.gameType)) out.gameType = DEFAULT_ROOM_SETTINGS.gameType;
  const t = out.gameType;
  const T = GAME_TYPES[t];
  // 1. sub-mode: a member of the type, then a READY one (Zone refuses types with none ready)
  if (!isSubMode(out.subMode) || !T.subModes.includes(out.subMode)) out.subMode = T.defaultSubMode;
  // (§3.2 says `?? s.subMode`; the type's default is used instead so a reserved v0.4 mode such as 'rival'
  // never survives normalization — the Zone refuses the not-ready room either way.)
  if (!SUB_MODES[out.subMode].ready) {
    const was = out.subMode;
    out.subMode = firstReadySubMode(t) ?? T.defaultSubMode;
    // A length still at the replaced sub-mode's default follows the substitute (Arena CTF 12 → DM 10).
    if (out.subMode !== was && out.matchMinutes === SUB_MODES[was].defaultMinutes) out.matchMinutes = SUB_MODES[out.subMode].defaultMinutes;
  }
  const D = SUB_MODES[out.subMode];
  // 2. allegiance
  if (out.mode !== 'ffa' && out.mode !== 'teams') out.mode = DEFAULT_ROOM_SETTINGS.mode;
  if (t === 'dungeon' || (out.mode === 'ffa' && !D.ffa)) out.mode = 'teams';
  // 3. teams (kept within [2, 8] in FFA so switching back to teams has a sane value)
  out.teamCount = out.mode === 'teams'
    ? clampInt(out.teamCount, D.minTeams, D.maxTeams, D.minTeams)
    : clampInt(out.teamCount, MIN_TEAMS, MAX_TEAMS, DEFAULT_ROOM_SETTINGS.teamCount);
  // 4. seats (dungeon: parties × PARTY_SIZE)
  const maxSeats = T.partySize ? out.teamCount * T.partySize : T.maxPlayers;
  out.maxPlayers = clampInt(out.maxPlayers, T.minPlayers, maxSeats, maxSeats);
  // 5. bots
  out.botFill = clampInt(out.botFill, 0, out.maxPlayers, 0);
  // 6. match length
  out.matchMinutes = T.untimed ? 0 : clampInt(out.matchMinutes, T.minutesMin, T.minutesMax, D.defaultMinutes || T.minutesMin);
  // 7. swarm / difficulty
  out.pveIntensity = (T.pve === 'off' ? 0 : clampInt(out.pveIntensity, 1, 3, 2)) as PveIntensity;
  // 8. floors
  out.floors = t === 'dungeon' ? snapFloors(out.floors) : 0;
  // 9. objective target (0 = sub-mode default)
  out.objectiveLimit = D.limitMax === 0 || !(out.objectiveLimit > 0)
    ? 0 : clampInt(out.objectiveLimit, D.limitMin, D.limitMax, D.limitMin);
  // 10. score limit: deathmatch only
  out.scoreLimit = out.subMode === 'deathmatch' ? clampInt(out.scoreLimit, 0, 100000, 0) : 0;
  // (defensive: fields a hand-built base may lack)
  if (typeof out.name !== 'string' || !out.name) out.name = DEFAULT_ROOM_SETTINGS.name;
  if (!(SKILLS as string[]).includes(out.botSkill)) out.botSkill = DEFAULT_ROOM_SETTINGS.botSkill;
  if (typeof out.friendlyFire !== 'boolean') out.friendlyFire = false;
  return out;
}

/**
 * v0.3 Quick Play (§3.4): how good `s` is for a "Quick Play <t> [sub]" request, or −1 if not eligible
 * (other type / sub-mode, sub-mode not ready, not joinable, a timed match with < 90 s left, the last
 * floor of a rift). Higher is better; the caller breaks ties by room order.
 */
export function quickPlayScore(s: RoomSummary, t: GameType, sub?: SubMode): number {
  if (s.gameType !== t) return -1;
  if (sub !== undefined && s.subMode !== sub) return -1;
  if (!SUB_MODES[s.subMode]?.ready || !s.joinable) return -1;
  let base: number;
  switch (s.phase) {
    case 'countdown': base = 130; break;
    case 'lobby': base = s.startsInSec > 0 ? 120 : 100; break;
    case 'results': base = 60; break;
    case 'playing': {
      const L = s.live;
      if (GAME_TYPES[t].dropIn === 'any') {
        const left = L ? L.timeLeftSec : -1;
        if (left >= 0 && left < QUICKPLAY_MIN_TIME_LEFT_SEC) return -1;
        base = 80;
      } else {
        // Dungeon drop-ins join at the next floor start: none is coming on the last floor.
        // (A departing portal is not visible in the summary; M4 may clear `joinable` for it.)
        if (L && L.floorsTotal > 0 && L.floor >= L.floorsTotal) return -1;
        base = 40;
      }
      break;
    }
    default: return -1;
  }
  const active = Math.max(0, s.humans - s.spectators);
  return base + 10 * Math.min(active, Math.max(0, s.maxPlayers - 1)) + (s.house ? 5 : 0);
}

/** `/play` / `/type` argument → game type ("dungeon", "rift", "arena", "warzone", "wz", ...). */
export function parseGameType(q: string): GameType | null {
  const l = q.trim().toLowerCase();
  if (!l) return null;
  if (isGameType(l)) return l;
  if (l === 'dr' || l === 'rift' || l === 'dungeon runner' || l === 'descent') return 'dungeon';
  if (l === 'wz') return 'warzone';
  const byName = GAME_TYPE_IDS.find((id) => GAME_TYPES[id].name.toLowerCase() === l);
  return byName ?? null;
}

/**
 * `/play <type> <sub>` / `/sub` argument → a sub-mode of type `t` ("ctf", "dm", "classic", "hot", "zones"...).
 * Returns null when nothing in the type matches (readiness is NOT checked here).
 */
export function parseSubMode(t: GameType, q: string): SubMode | null {
  const l = q.trim().toLowerCase();
  if (!l) return null;
  const subs = GAME_TYPES[t].subModes;
  for (const s of subs) {
    const d = SUB_MODES[s];
    if (s === l || d.short.toLowerCase() === l || d.name.toLowerCase() === l || subModeLabel(t, s).toLowerCase() === l) return s;
  }
  const alias: Record<string, SubMode> = {
    dm: 'deathmatch', classic: 'deathmatch', flag: 'ctf', flags: 'ctf', zone: 'zones', control: 'zones',
    hot: 'hotpoint', 'hot point': 'hotpoint', points: 'hotpoint', koth: 'hotpoint', 'co-op': 'coop', coop: 'coop',
  };
  const a = alias[l];
  return a && subs.includes(a) ? a : null;
}

export function isShipClass(v: unknown): v is ShipClassId {
  return typeof v === 'string' && (SHIP_CLASS_IDS as string[]).includes(v);
}

const num = (v: unknown, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0;

/** Defensive copy of a client input (never trust the wire). */
export function sanitizeInput(raw: unknown): InputState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const inp = emptyInput();
  inp.seq = typeof r.seq === 'number' && Number.isFinite(r.seq) ? Math.max(0, Math.floor(r.seq)) >>> 0 : 0;
  let mx = num(r.moveX, -1, 1), my = num(r.moveY, -1, 1);
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  inp.moveX = mx; inp.moveY = my;
  inp.aim = num(r.aim, -1e4, 1e4);
  inp.aimDist = typeof r.aimDist === 'number' && Number.isFinite(r.aimDist) ? Math.max(0, Math.min(2000, r.aimDist)) : 300;
  inp.primary = r.primary === true;
  inp.secondary = r.secondary === true;
  inp.mobility = r.mobility === true;
  inp.utility = r.utility === true;
  inp.afterburner = r.afterburner === true;
  inp.attach = r.attach === true;
  inp.detach = r.detach === true;
  inp.attachTarget = typeof r.attachTarget === 'number' && Number.isFinite(r.attachTarget) ? Math.max(0, Math.floor(r.attachTarget)) : 0;
  return inp;
}

/** Original, silly-but-tasteful bot callsigns. */
export const BOT_CALLSIGNS: readonly string[] = [
  'Rustbucket', 'Glitch', 'Hexfire', 'Tachyon', 'Bitflip', 'Lumen', 'Kestrel', 'Quasar Jo',
  'Static', 'Paradox', 'Fizzle', 'Wobble', 'Driftwood', 'Neon Moth', 'Pixel Rat', 'Solder',
  'Cobalt', 'Void Otter', 'Plasma Pete', 'Sprocket', 'Krill', 'Zephyr', 'Magpie', 'Blip',
  'Photon Phil', 'Gravel', 'Nebula Nan', 'Spudnik', 'Warp Toast', 'Captain Lag', 'Fuse', 'Jinx',
  'Echo-7', 'Moxie', 'Rivet', 'Sable', 'Torque', 'Umbra', 'Widget', 'Yolk', 'Dustmite',
  'Orbit Olga', 'Parsec', 'Ratchet Ray', 'Cinder', 'Mothball', 'Flux', 'Gizmo Grey', 'Noodle',
];

/** Uniform class pick for bots. */
export function randomBotClass(r: () => number): ShipClassId {
  return SHIP_CLASS_IDS[Math.min(SHIP_CLASS_IDS.length - 1, Math.floor(r() * SHIP_CLASS_IDS.length))] ?? 'brute';
}

/** Least-used class among `current` (ties broken randomly) — keeps bot rosters mixed across all classes. */
export function leastUsedClass(current: readonly ShipClassId[], r: () => number): ShipClassId {
  const counts = new Map<ShipClassId, number>(SHIP_CLASS_IDS.map((c) => [c, 0]));
  for (const c of current) counts.set(c, (counts.get(c) ?? 0) + 1);
  const min = Math.min(...counts.values());
  const pool = SHIP_CLASS_IDS.filter((c) => counts.get(c) === min);
  return pool[Math.floor(r() * pool.length)] ?? randomBotClass(r);
}
