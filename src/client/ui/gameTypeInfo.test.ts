// CLIENT M1: Command list logic, type-aware settings rows, Create Game preview normalization, HUD strip rules.
// Readiness-agnostic where possible: M3/M4 flip `ready` flags without breaking these.
import { describe, expect, it } from 'vitest';
import { COSMETICS } from '../../shared/data/cosmetics';
import { GAME_TYPES, readySubModes, SUB_MODES } from '../../shared/data/gameTypes';
import { SET_INFO } from '../../shared/data/loot';
import { DEFAULT_ROOM_SETTINGS, DEFAULT_SETTINGS_BY_TYPE, type RoomLive, type RoomSettings, type RoomSummary } from '../../shared/protocol';
import type { SubMode } from '../../shared/types';
import { clampSettings } from '../../shared/room/util';
import {
  activeHumans, createDefaults, defaultCommandType, featuredDraws, fieldPatch, filterRooms, fmtMinSec, hudShowsClock,
  hudWaveText, liveLine, modeLabel, normalizeDraft, onlineText, parseStoredType, pilotsParts, resultModeLine, roomTitleText,
  rowActions, settingsFields, sortRooms, statusText, subModeShort, typeLive, typeOpen,
} from './gameTypeInfo';

function room(p: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'r1', name: 'Room', mode: 'teams', teamCount: 2, phase: 'lobby', humans: 0, bots: 10, maxPlayers: 16,
    gameType: 'arena', subMode: 'deathmatch', pveIntensity: 0, floors: 0, house: false, hostName: '', spectators: 0,
    joinable: true, watchable: false, startsInSec: 0, live: null, ...p,
  };
}

function live(p: Partial<RoomLive> = {}): RoomLive {
  return {
    elapsedSec: 0, timeLeftSec: 600, wave: 0, floor: 0, floorsTotal: 0, lives: -1, scores: [], scoreline: '', leader: '', leaderScore: 0, ...p,
  };
}

/** Temporarily mark sub-modes ready (as M3/M4 owners will), restoring them afterwards. */
function withReady<T>(subs: SubMode[], fn: () => T): T {
  const before = subs.map((s) => SUB_MODES[s].ready);
  try {
    for (const s of subs) (SUB_MODES[s] as { ready: boolean }).ready = true;
    return fn();
  } finally {
    subs.forEach((s, i) => { (SUB_MODES[s] as { ready: boolean }).ready = before[i]; });
  }
}

/** The pre-M3 world (CTF / Zones / Hot Point not open) — the substitution rules still guard escort / rival / coop. */
function withNotReady<T>(subs: SubMode[], fn: () => T): T {
  const before = subs.map((s) => SUB_MODES[s].ready);
  try {
    for (const s of subs) (SUB_MODES[s] as { ready: boolean }).ready = false;
    return fn();
  } finally {
    subs.forEach((s, i) => { (SUB_MODES[s] as { ready: boolean }).ready = before[i]; });
  }
}
const PRE_M3: SubMode[] = ['ctf', 'zones', 'hotpoint'];

describe('labels', () => {
  it('formats m:ss (ceil for countdowns, floor for elapsed)', () => {
    expect(fmtMinSec(14)).toBe('0:14');
    expect(fmtMinSec(13.2)).toBe('0:14');
    expect(fmtMinSec(402)).toBe('6:42');
    expect(fmtMinSec(760.9, false)).toBe('12:40');
    expect(fmtMinSec(-5)).toBe('0:00');
  });

  it('mode column: "CTF · 2 teams", "DM · FFA", "Co-op · 6 floors", Warzone DM reads Classic', () => {
    expect(modeLabel(room({ subMode: 'ctf' }))).toBe('CTF · 2 teams');
    expect(modeLabel(room({ mode: 'ffa' }))).toBe('DM · FFA');
    expect(modeLabel(room({ gameType: 'dungeon', subMode: 'coop', teamCount: 1, floors: 6 }))).toBe('Co-op · 6 floors');
    expect(modeLabel(room({ gameType: 'warzone', teamCount: 4 }))).toBe('Classic · 4 teams');
    expect(subModeShort('arena', 'deathmatch')).toBe('DM');
  });

  it('room titles and the results sub-line use the type accent names', () => {
    expect(roomTitleText({ gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, floors: 0 })).toBe('Arena · Capture the Flag · 2 teams');
    expect(roomTitleText({ gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', teamCount: 2, floors: 0 })).toBe('Arena · Deathmatch · Free-for-all');
    expect(roomTitleText({ gameType: 'warzone', subMode: 'deathmatch', mode: 'teams', teamCount: 4, floors: 0 })).toBe('Warzone · Classic · 4 teams');
    expect(roomTitleText({ gameType: 'dungeon', subMode: 'coop', mode: 'teams', teamCount: 1, floors: 6 })).toBe('Dungeon Runner · Co-op Descent · 6 floors');
    expect(resultModeLine('warzone', 'deathmatch')).toBe('Warzone · Classic');
    expect(resultModeLine(undefined, undefined)).toBe('');
  });

  it('pilots column counts active humans, then +bots / max and watchers', () => {
    const r = room({ humans: 5, spectators: 2, bots: 9, maxPlayers: 16 });
    expect(activeHumans(r)).toBe(3);
    expect(pilotsParts(r)).toEqual({ humans: '3', rest: ' +9 / 16', watch: 'watch 2' });
    expect(pilotsParts(room({ humans: 1 })).watch).toBe('');
    expect(onlineText(1)).toBe('1 pilot online');
    expect(onlineText(7)).toBe('7 pilots online');
  });
});

describe('statusText (§2.3)', () => {
  it('lobby: countdown from roomsAt, else Lobby / Open · bots ready', () => {
    expect(statusText(room({ startsInSec: 20 }), 1000, 7000)).toBe('Starting in 0:14');
    expect(statusText(room({ startsInSec: 5 }), 1000, 7000)).toBe('Launching');
    expect(statusText(room({ humans: 2 }), 0, 0)).toBe('Lobby');
    expect(statusText(room({ humans: 0 }), 0, 0)).toBe('Open · bots ready');
  });

  it('countdown / results', () => {
    expect(statusText(room({ phase: 'countdown' }), 0, 0)).toBe('Launching');
    expect(statusText(room({ phase: 'results' }), 0, 0)).toBe('Wrapping up');
  });

  it('playing, timed: time left ticks down on the client, plus scoreline and (Warzone) the wave', () => {
    const wz = room({ gameType: 'warzone', phase: 'playing', live: live({ timeLeftSec: 405, scoreline: '212–187', wave: 7 }) });
    expect(statusText(wz, 0, 3000)).toBe('6:42 left · 212–187 · Wave 7');
    const ar = room({ phase: 'playing', live: live({ timeLeftSec: 60, scoreline: '2–1', wave: 3 }) });
    expect(statusText(ar, 0, 0)).toBe('1:00 left · 2–1'); // Arena never shows a wave
    expect(statusText(room({ phase: 'playing', live: live({ timeLeftSec: 30 }) }), 0, 0)).toBe('0:30 left');
  });

  it('playing, dungeon: floor, elapsed and lives', () => {
    const d = room({ gameType: 'dungeon', subMode: 'coop', phase: 'playing', live: live({ timeLeftSec: -1, elapsedSec: 758, floor: 3, floorsTotal: 6, lives: 7 }) });
    expect(statusText(d, 0, 2000)).toBe('Floor 3/6 · 12:40 in · 7 lives');
    const one = room({ gameType: 'dungeon', subMode: 'coop', phase: 'playing', live: live({ timeLeftSec: -1, floor: 1, floorsTotal: 3, lives: 1 }) });
    expect(statusText(one, 0, 0)).toBe('Floor 1/3 · 0:00 in · 1 life');
  });
});

describe('live list order, filter, actions', () => {
  it('joinable first, then live with humans, lobby with humans, idle house, then humans desc (stable)', () => {
    const rooms = [
      room({ id: 'full', joinable: false, humans: 9, phase: 'playing' }),
      room({ id: 'idleCustom' }),
      room({ id: 'idleHouse', house: true }),
      room({ id: 'lobby1', humans: 1 }),
      room({ id: 'live2', humans: 2, phase: 'playing' }),
      room({ id: 'lobby3', humans: 3, phase: 'countdown' }),
      room({ id: 'live1', humans: 1, phase: 'playing' }),
      room({ id: 'idleHouse2', house: true }),
    ];
    expect(sortRooms(rooms).map((r) => r.id)).toEqual(['live2', 'live1', 'lobby3', 'lobby1', 'idleHouse', 'idleHouse2', 'idleCustom', 'full']);
  });

  it('filters by type and sub-mode', () => {
    const rooms = [room({ id: 'a' }), room({ id: 'b', gameType: 'warzone' }), room({ id: 'c', subMode: 'ctf' })];
    expect(filterRooms(rooms, 'arena', null).map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterRooms(rooms, 'arena', 'ctf').map((r) => r.id)).toEqual(['c']);
    expect(filterRooms(rooms, 'dungeon', null)).toEqual([]);
  });

  it('actions: Join (lobby), Join + Watch (playing), dungeon joins at the next floor, Watch only, Full; no Watch offline', () => {
    const lab = (r: RoomSummary, off = false) => rowActions(r, off).map((a) => `${a.label}${a.intent ? `:${a.intent}` : ''}`);
    expect(lab(room())).toEqual(['Join:lobby']);
    expect(lab(room({ phase: 'playing', watchable: true }))).toEqual(['Join:play', 'Watch:watch']);
    expect(lab(room({ phase: 'playing', watchable: true }), true)).toEqual(['Join:play']);
    expect(lab(room({ gameType: 'dungeon', subMode: 'coop', phase: 'playing', watchable: true }))).toEqual(['Join · next floor:play', 'Watch:watch']);
    expect(lab(room({ phase: 'playing', joinable: false, watchable: true }))).toEqual(['Watch:watch']);
    expect(lab(room({ phase: 'playing', joinable: false, watchable: true }), true)).toEqual(['Full']);
    expect(lab(room({ joinable: false }))).toEqual(['Full']);
  });

  it('card live line counts live rooms and pilots of the type', () => {
    const rooms = [
      room({ phase: 'playing', humans: 3 }), room({ phase: 'playing', humans: 4 }), room({ phase: 'lobby', humans: 0 }),
      room({ gameType: 'warzone', phase: 'playing', humans: 9 }),
    ];
    expect(typeLive(rooms, 'arena')).toEqual({ live: 2, pilots: 7 });
    expect(liveLine(rooms, 'arena')).toBe('2 live · 7 pilots');
    expect(liveLine([], 'dungeon')).toBe('0 live · 0 pilots');
  });
});

describe('cards: readiness, stored type, draws', () => {
  it('a type is open iff it has a ready sub-mode; the default selection is an open type', () => {
    for (const t of ['dungeon', 'arena', 'warzone'] as const) expect(typeOpen(t)).toBe(readySubModes(t).length > 0);
    expect(typeOpen(defaultCommandType())).toBe(true);
    expect(parseStoredType('warzone')).toBe('warzone');
    expect(parseStoredType('nope')).toBe(defaultCommandType());
    expect(parseStoredType(null)).toBe(defaultCommandType());
  });

  it("draws strip shows the type's exclusive set's 3 featured items with catalog rarities", () => {
    for (const t of ['dungeon', 'arena', 'warzone'] as const) {
      const d = featuredDraws(t);
      expect(d.map((x) => x.id)).toEqual(SET_INFO[GAME_TYPES[t].lootSet].featured);
      for (const x of d) {
        expect(x.name).toBe(COSMETICS[x.id].name);
        expect(x.rarity).toBe(COSMETICS[x.id].rarity);
      }
    }
  });
});

describe('type-aware settings rows (Create Game + RoomLobby)', () => {
  const keys = (s: RoomSettings, withType = false) => settingsFields(s, withType).map((f) => f.key);
  const field = (s: RoomSettings, k: string) => settingsFields(s, true).find((f) => f.key === k)!;

  it('Warzone Classic: allegiance, teams 2–8, score limit, length 1–30, Swarm Low/Normal/Chaos, friendly fire', () => {
    const s = { ...DEFAULT_ROOM_SETTINGS };
    expect(keys(s, true)).toEqual(['gameType', 'subMode', 'mode', 'teamCount', 'scoreLimit', 'maxPlayers', 'botFill', 'botSkill', 'matchMinutes', 'pveIntensity', 'friendlyFire']);
    expect(field(s, 'teamCount').options!.map((o) => o.value)).toEqual(['2', '3', '4', '5', '6', '7', '8']);
    expect(field(s, 'pveIntensity').label).toBe('Swarm');
    expect(field(s, 'pveIntensity').options!.map((o) => o.label)).toEqual(['Low', 'Normal', 'Chaos']);
    const mins = field(s, 'matchMinutes').options!.map((o) => Number(o.value));
    expect(Math.min(...mins)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...mins)).toBeLessThanOrEqual(30);
    expect(field(s, 'subMode').options!.map((o) => o.label)).toContain('Classic');
    expect(field(s, 'maxPlayers').max).toBe(32);
  });

  it('FFA hides the team count', () => {
    expect(keys({ ...DEFAULT_ROOM_SETTINGS, mode: 'ffa' })).not.toContain('teamCount');
  });

  it('Arena: no swarm row, length 3–20', () => {
    const s = createDefaults('arena', 'x');
    expect(keys(s)).not.toContain('pveIntensity');
    const mins = field(s, 'matchMinutes').options!.map((o) => Number(o.value));
    expect(Math.min(...mins)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...mins)).toBeLessThanOrEqual(20);
  });

  it('Dungeon: floors 3/6, Difficulty Story/Veteran/Nightmare, Reckless, party seats ≤ 4, no length / allegiance / teams', () => {
    const s = { ...DEFAULT_SETTINGS_BY_TYPE.dungeon };
    const k = keys(s);
    expect(k).toEqual(expect.arrayContaining(['floors', 'pveIntensity', 'friendlyFire', 'maxPlayers', 'botFill']));
    for (const no of ['matchMinutes', 'mode', 'teamCount', 'scoreLimit', 'objectiveLimit']) expect(k).not.toContain(no);
    expect(field(s, 'floors').options!.map((o) => o.value)).toEqual(['3', '6']);
    expect(field(s, 'pveIntensity').label).toBe('Difficulty');
    expect(field(s, 'pveIntensity').options!.map((o) => o.label)).toEqual(['Story', 'Veteran', 'Nightmare']);
    expect(field(s, 'friendlyFire').label).toMatch(/Reckless/);
    expect(field(s, 'maxPlayers').max).toBe(4);
  });

  it('objective sub-modes show a target with its unit and no score limit', () => {
    const ctf = { ...DEFAULT_SETTINGS_BY_TYPE.arena, subMode: 'ctf' as const };
    const t = field(ctf, 'objectiveLimit');
    expect(t.options![0]).toEqual({ value: '0', label: 'Default (3 captures)' });
    expect(t.options!.slice(1).map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(keys(ctf)).not.toContain('scoreLimit');
    expect(keys(ctf)).not.toContain('mode'); // CTF has no FFA
    const zones = field({ ...DEFAULT_SETTINGS_BY_TYPE.warzone, subMode: 'zones' }, 'objectiveLimit');
    expect(zones.options![0].label).toBe('Default (300 points)');
    for (const o of zones.options!.slice(1)) expect(Number(o.value)).toBeGreaterThanOrEqual(100);
  });

  it('sub-mode options list ready sub-modes only; types without one are marked (soon)', () => {
    const s = createDefaults('arena', 'x');
    expect(field(s, 'subMode').options!.map((o) => o.value)).toEqual(readySubModes('arena'));
    const gt = field(s, 'gameType').options!;
    expect(gt.find((o) => o.value === 'dungeon')!.disabled).toBe(!typeOpen('dungeon'));
  });

  it('control values become patches', () => {
    expect(fieldPatch('mode', 'ffa')).toEqual({ mode: 'ffa' });
    expect(fieldPatch('teamCount', '4')).toEqual({ teamCount: 4 });
    expect(fieldPatch('friendlyFire', true)).toEqual({ friendlyFire: true });
    expect(fieldPatch('gameType', 'dungeon')).toEqual({ gameType: 'dungeon' });
    expect(fieldPatch('gameType', 'bogus')).toEqual({});
    expect(fieldPatch('pveIntensity', '9')).toEqual({ pveIntensity: 3 });
  });
});

describe('Create Game preview normalization (mirrors §3.2)', () => {
  it('a type switch re-bases on the type defaults, keeping name and bot skill', () => {
    const base = { ...DEFAULT_ROOM_SETTINGS, name: 'Mine', botSkill: 'hard' as const, teamCount: 6, pveIntensity: 3 as const };
    const d = normalizeDraft(base, { gameType: 'dungeon' });
    expect(d).toMatchObject({ gameType: 'dungeon', name: 'Mine', botSkill: 'hard', teamCount: 1, mode: 'teams', matchMinutes: 0, floors: 6 });
    expect(d.maxPlayers).toBeLessThanOrEqual(4);
    const a = normalizeDraft(base, { gameType: 'arena' });
    expect(a.pveIntensity).toBe(0);
    expect(a.floors).toBe(0);
  });

  it('dungeon forces teams; floors snap to 3/6; bots never exceed seats', () => {
    const dz = createDefaults('dungeon', 'x');
    expect(normalizeDraft(dz, { mode: 'ffa' }).mode).toBe('teams');
    expect(normalizeDraft(dz, { floors: 4 }).floors).toBe(3);
    expect(normalizeDraft(dz, { floors: 5 }).floors).toBe(6);
    expect(normalizeDraft(dz, { floors: 0 }).floors).toBe(6);
    expect(normalizeDraft(dz, { maxPlayers: 20 }).maxPlayers).toBe(4);
    expect(normalizeDraft(dz, { maxPlayers: 2, botFill: 4 }).botFill).toBe(2);
  });

  it('v0.2 clamp behaviour for Warzone DM is kept', () => {
    const b = { ...DEFAULT_ROOM_SETTINGS };
    expect(normalizeDraft(b, { teamCount: 1 }).teamCount).toBe(2);
    expect(normalizeDraft(b, { teamCount: 99 }).teamCount).toBe(8);
    expect(normalizeDraft(b, { maxPlayers: 500 }).maxPlayers).toBe(32);
    expect(normalizeDraft(b, { matchMinutes: 0 }).matchMinutes).toBe(1);
    expect(normalizeDraft(b, { mode: 'ffa', teamCount: 5 })).toMatchObject({ mode: 'ffa', teamCount: 5 });
  });

  it('a not-ready sub-mode is substituted; a sub-mode switch resets length and target', () => {
    const arena = createDefaults('arena', 'x');
    if (!SUB_MODES.ctf.ready) {
      expect(normalizeDraft(arena, { subMode: 'ctf' }).subMode).toBe('deathmatch');
      expect(arena.matchMinutes).toBe(SUB_MODES.deathmatch.defaultMinutes);
    }
    withReady(['ctf', 'hotpoint'], () => {
      const ctf = normalizeDraft({ ...arena, subMode: 'deathmatch', matchMinutes: 5 }, { subMode: 'ctf' });
      expect(ctf).toMatchObject({ subMode: 'ctf', matchMinutes: SUB_MODES.ctf.defaultMinutes, objectiveLimit: 0, scoreLimit: 0 });
      expect(normalizeDraft(ctf, { mode: 'ffa' }).mode).toBe('teams'); // CTF has no FFA
      expect(normalizeDraft(ctf, { teamCount: 8 }).teamCount).toBe(4); // CTF caps at 4 teams
      expect(normalizeDraft(ctf, { objectiveLimit: 50 }).objectiveLimit).toBe(10);
      const hot = normalizeDraft(ctf, { subMode: 'hotpoint', objectiveLimit: 30 });
      expect(hot).toMatchObject({ subMode: 'hotpoint', objectiveLimit: 60 });
      expect(normalizeDraft(hot, { mode: 'ffa' }).mode).toBe('ffa');
    });
  });
});

describe('HUD strip (fix #3 / #24)', () => {
  const m = { phase: 'playing' as const, mode: 'teams' as const, teamCount: 2, timeLeftSec: 0, teamScores: [], wave: 7, winnerTeam: -1, winnerPlayerId: 0 };
  it('clock only when timed (absent = timed)', () => {
    expect(hudShowsClock(m)).toBe(true);
    expect(hudShowsClock({ ...m, timed: true })).toBe(true);
    expect(hudShowsClock({ ...m, timed: false })).toBe(false);
  });
  it('wave hidden in dungeons and at wave 0', () => {
    expect(hudWaveText(m)).toBe('WAVE 7');
    expect(hudWaveText({ ...m, gameType: 'dungeon' })).toBe('');
    expect(hudWaveText({ ...m, wave: 0 })).toBe('');
  });
});

describe('Create Game preview agrees with the server (clampSettings)', () => {
  it('a type switch onto a not-ready default sub-mode takes the substitute\'s own length (Arena → DM 10 min)', () => {
    const bases = [DEFAULT_SETTINGS_BY_TYPE.warzone, DEFAULT_ROOM_SETTINGS, { ...DEFAULT_ROOM_SETTINGS, matchMinutes: 25 }];
    withNotReady(PRE_M3, () => {
      for (const base of bases) {
        const preview = normalizeDraft(base, { gameType: 'arena' });
        const server = clampSettings(base, { gameType: 'arena' });
        expect(preview).toEqual(server);
        expect(preview).toMatchObject({ subMode: 'deathmatch', matchMinutes: SUB_MODES.deathmatch.defaultMinutes });
      }
    });
    // M3: CTF (Arena's default) is open — its own length
    for (const base of bases) {
      expect(normalizeDraft(base, { gameType: 'arena' })).toEqual(clampSettings(base, { gameType: 'arena' }));
      expect(normalizeDraft(base, { gameType: 'arena' })).toMatchObject({ subMode: 'ctf', matchMinutes: SUB_MODES.ctf.defaultMinutes });
    }
  });

  it("a sub-mode that isn't open (or not the type's) changes nothing — no length reset as a side effect", () => {
    withNotReady(PRE_M3, () => {
      const pre = { ...clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, {}), matchMinutes: 5 };
      expect(normalizeDraft(pre, { subMode: 'ctf' })).toMatchObject({ subMode: 'deathmatch', matchMinutes: 5 });
    });
    const dm5 = { ...clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, { subMode: 'deathmatch' }), matchMinutes: 5 };
    for (const patch of [{ subMode: 'escort' as const }, { subMode: 'coop' as const }]) {
      expect(normalizeDraft(dm5, patch)).toEqual(clampSettings(dm5, patch));
      expect(normalizeDraft(dm5, patch)).toMatchObject({ subMode: 'deathmatch', matchMinutes: 5 });
    }
    const wz = { ...DEFAULT_ROOM_SETTINGS, matchMinutes: 7 };
    expect(normalizeDraft(wz, { subMode: 'ctf' })).toEqual(clampSettings(wz, { subMode: 'ctf' }));
    expect(clampSettings(wz, { subMode: 'ctf' }).matchMinutes).toBe(7);
  });
});
