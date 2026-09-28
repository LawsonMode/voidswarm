import { describe, expect, it } from 'vitest';
import {
  BOT_CALLSIGNS, clampSettings, dedupeName, leastUsedClass, nameKey, normalizeForType, parseGameType, parseSubMode,
  quickPlayScore, sanitizeBotName, sanitizeGuestName, sanitizeInput, sanitizeName,
} from './util';
import { houseRooms } from './houseRooms';
import { DEFAULT_ROOM_SETTINGS, DEFAULT_SETTINGS_BY_TYPE, type RoomSettings, type RoomSummary } from '../protocol';
import { SUB_MODES } from '../data/gameTypes';
import type { SubMode } from '../types';

describe('sanitizeInput', () => {
  it('whitelists v0.2 fields and clamps', () => {
    const i = sanitizeInput({
      seq: 12.7, moveX: 3, moveY: 4, aim: 1.5, aimDist: 99999, primary: true, secondary: 1, mobility: true,
      utility: false, afterburner: true, attach: true, attachTarget: 7.9, detach: 'yes', fireGun: true, evil: 1,
    });
    expect(i.seq).toBe(12);
    expect(Math.hypot(i.moveX, i.moveY)).toBeCloseTo(1);
    expect(i.aimDist).toBe(2000);
    expect(i.primary).toBe(true);
    expect(i.secondary).toBe(false); // must be a real boolean
    expect(i.mobility).toBe(true);
    expect(i.attachTarget).toBe(7);
    expect(i.detach).toBe(false);
    expect(Object.keys(i).sort()).toEqual([
      'afterburner', 'aim', 'aimDist', 'attach', 'attachTarget', 'detach', 'mobility', 'moveX', 'moveY',
      'primary', 'secondary', 'seq', 'utility',
    ]);
  });
  it('defaults aimDist to 300 and floors negatives at 0', () => {
    expect(sanitizeInput({}).aimDist).toBe(300);
    expect(sanitizeInput({ aimDist: NaN }).aimDist).toBe(300);
    expect(sanitizeInput({ aimDist: -5 }).aimDist).toBe(0);
    expect(sanitizeInput(null).aimDist).toBe(300);
  });
});

describe('names & settings', () => {
  it('sanitizes and dedupes', () => {
    expect(sanitizeName('‮  Bob\t ')).toBe('Bob');
    expect(dedupeName('Bob', (n) => n === 'Bob')).toBe('Bob2');
  });
  it('strips invisible fillers and NFKC-folds styled letters', () => {
    expect(sanitizeName('Admin\u3164')).toBe('Admin'); // Hangul filler (Lo)
    expect(sanitizeName('\u3164\u3164')).toBe('Pilot');
    expect(sanitizeName('A\u200Bd\u2060min\uFE0F')).toBe('Admin');
    expect(sanitizeName('\uFF21\uFF44\uFF4D\uFF49\uFF4E')).toBe('Admin'); // fullwidth
    expect(sanitizeName('\u{1D400}dmin')).toBe('Admin'); // mathematical bold A
    expect(sanitizeName('Jos\u00E9')).toBe('Jos\u00E9'); // real letters survive
  });
  it('nameKey folds look-alikes onto the Latin name they imitate', () => {
    expect(nameKey('Admin')).toBe('admin');
    expect(nameKey('\u0410dmin')).toBe('admin'); // Cyrillic \u0410
    expect(nameKey('\u0391\u0414\u039C\u0399\u039D')).not.toBe('admin'); // \u0414 is not a d look-alike...
    expect(nameKey('\u0391DMIN')).toBe('admin'); // ...but Greek \u0391 is an A
    expect(nameKey('Ad\u0307min')).toBe('admin'); // combining dot
    expect(nameKey('\u0420\u0430\u0441\u0435r')).toBe('pacer');
    expect(nameKey('Ace  Pilot ')).toBe('ace pilot');
    expect(nameKey('Bob')).not.toBe(nameKey('B0b')); // ASCII-only ambiguity is not folded
  });
  it('dedupeName is bounded even when everything is taken', () => {
    let calls = 0;
    const n = dedupeName('Crowded', () => { calls++; return true; });
    expect(calls).toBeLessThanOrEqual(150);
    expect(n.length).toBeLessThanOrEqual(16);
    expect(dedupeName('A', (x) => x !== 'A42' && /^A\d*$/.test(x))).toBe('A42');
    expect(dedupeName('Long Room Name For Test', (x) => x === 'Long Room Name For Test', 32)).toBe('Long Room Name For Test2');
  });
  it('SEC-8: guest callsigns are ASCII [A-Za-z0-9_-], spaces become _', () => {
    const ok = /^[A-Za-z0-9_-]{1,16}$/;
    expect(sanitizeGuestName('Ace Pilot')).toBe('Ace_Pilot');
    expect(sanitizeGuestName('  Ace \t  Pilot  ')).toBe('Ace_Pilot');
    expect(sanitizeGuestName('José')).toBe('Jose'); // accents fold to the base letter
    expect(sanitizeGuestName('Ａｄｍｉｎ')).toBe('Admin'); // fullwidth
    expect(sanitizeGuestName('\u{1D400}dmin')).toBe('Admin'); // mathematical bold
    expect(sanitizeGuestName('adⅿin')).toBe('admin'); // small roman numeral m (NFKD)
    expect(sanitizeGuestName('x_x-9')).toBe('x_x-9');
    expect(sanitizeGuestName('<b>hi</b>!')).toBe('bhib');
    expect(sanitizeGuestName('Воб')).toBe('Pilot'); // nothing ASCII left -> fallback
    expect(sanitizeGuestName('')).toBe('Pilot');
    expect(sanitizeGuestName(42)).toBe('Pilot');
    expect(sanitizeGuestName('ABCDEFGHIJKLMNOPQRSTUV')).toHaveLength(16);
    // the verifier's homoglyphs, incl. scripts the CONFUSABLE map does not cover
    const lookalikes: [string, string][] = [
      ['Bօb', 'bob'], // Armenian oh
      ['ꓐob', 'bob'], // Lisu BA
      ['Ᏼob', 'bob'], // Cherokee YV
      ['աdmin', 'admin'], // Armenian ayb
      ['admɨn', 'admin'], // Latin i with stroke
      ['Ꭺdmin', 'admin'], // Cherokee A
      ['admiո', 'admin'], // Armenian vo
      ['аdmin', 'admin'], // Cyrillic a
    ];
    for (const [raw, imitated] of lookalikes) {
      const n = sanitizeGuestName(raw);
      expect(n).toMatch(ok);
      expect(n.toLowerCase()).not.toBe(imitated);
    }
    // invisible fillers are stripped: what is left is the plain name (the reserved-name dedupe renames it)
    expect(sanitizeGuestName('adminㅤ')).toBe('admin');
  });
  it('SEC-8: bot callsigns are ASCII (inner spaces kept)', () => {
    expect(sanitizeBotName('Neon Moth')).toBe('Neon Moth');
    expect(sanitizeBotName(' Quasar   Jo ')).toBe('Quasar Jo');
    expect(sanitizeBotName('Bօbㅤ')).toBe('Bb');
    expect(sanitizeBotName('Во')).toBe('Bot');
    for (const c of BOT_CALLSIGNS) {
      expect(c).toMatch(/^[A-Za-z0-9 _-]{1,16}$/);
      expect(sanitizeBotName(c)).toBe(c);
    }
  });
  it('clamps settings', () => {
    const s = clampSettings(DEFAULT_ROOM_SETTINGS, { teamCount: 1, botFill: 50, maxPlayers: 10, mode: 'nope' });
    expect(s.teamCount).toBe(2);
    expect(s.maxPlayers).toBe(10);
    expect(s.botFill).toBe(10);
    expect(s.mode).toBe('teams');
  });
  it('leastUsedClass fills the rarest class', () => {
    expect(leastUsedClass(['brute', 'brute', 'tech'], () => 0)).toBe('engineer');
  });
});

/** Run `fn` with some not-yet-ready sub-modes flagged ready (their owners flip them in M3/M4). */
function withReady<T>(subs: SubMode[], fn: () => T): T {
  const defs = SUB_MODES as Record<SubMode, { ready: boolean }>;
  const was = subs.map((s) => defs[s].ready);
  subs.forEach((s) => { defs[s].ready = true; });
  try { return fn(); } finally { subs.forEach((s, i) => { defs[s].ready = was[i]; }); }
}

/**
 * The pre-M3 world (CTF / Zones / Hot Point shipped `ready` in 0.3.0-m3): the substitution rules these tests pin
 * still guard every sub-mode that isn't open (escort, rival, coop until M4).
 */
const PRE_M3: SubMode[] = ['ctf', 'zones', 'hotpoint', 'coop'];
/** The pre-M4 world: the Dungeon Runner's co-op shipped `ready` in 0.3.0. */
const PRE_M4: SubMode[] = ['coop'];
function withNotReady<T>(subs: SubMode[], fn: () => T): T {
  const defs = SUB_MODES as Record<SubMode, { ready: boolean }>;
  const was = subs.map((s) => defs[s].ready);
  subs.forEach((s) => { defs[s].ready = false; });
  try { return fn(); } finally { subs.forEach((s, i) => { defs[s].ready = was[i]; }); }
}

describe('v0.3 settings: the game-type matrix (clampSettings / normalizeForType)', () => {
  it('the absent/base type is Warzone Classic, so v0.2 patches clamp as before', () => {
    const s = clampSettings(DEFAULT_ROOM_SETTINGS, { teamCount: 99, maxPlayers: 500, botFill: 400, matchMinutes: 0 });
    expect(s).toMatchObject({ gameType: 'warzone', subMode: 'deathmatch', teamCount: 8, maxPlayers: 32, botFill: 32, matchMinutes: 1 });
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, {})).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { matchMinutes: 45 }).matchMinutes).toBe(30);
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { pveIntensity: 0 }).pveIntensity).toBe(1); // warzone swarm 1-3
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { floors: 6, objectiveLimit: 300 })).toMatchObject({ floors: 0, objectiveLimit: 0 });
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'nope', subMode: 'nope' } as never)).toEqual(DEFAULT_ROOM_SETTINGS);
  });

  it('coop: 1 party, at most 4 seats, untimed, teams only, floors snap to 3 | 6', () => {
    const raw: RoomSettings = {
      ...DEFAULT_SETTINGS_BY_TYPE.dungeon, mode: 'ffa', teamCount: 5, maxPlayers: 30, botFill: 30, matchMinutes: 12,
      pveIntensity: 0, floors: 4, objectiveLimit: 50, scoreLimit: 100,
    };
    const s = normalizeForType(raw);
    expect(s).toMatchObject({
      gameType: 'dungeon', subMode: 'coop', mode: 'teams', teamCount: 1, maxPlayers: 4, botFill: 4, matchMinutes: 0,
      pveIntensity: 1, floors: 3, objectiveLimit: 0, scoreLimit: 0,
    });
    expect(normalizeForType({ ...raw, floors: 5 }).floors).toBe(6);
    expect(normalizeForType({ ...raw, floors: 0 }).floors).toBe(6);
    expect(normalizeForType({ ...raw, floors: 9 }).floors).toBe(6);
    expect(normalizeForType({ ...raw, maxPlayers: 0 }).maxPlayers).toBe(1);
    expect(raw.teamCount).toBe(5); // pure
    // switching TO dungeon re-bases on its defaults
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'dungeon' })).toMatchObject({
      gameType: 'dungeon', subMode: 'coop', teamCount: 1, maxPlayers: 4, botFill: 4, matchMinutes: 0, floors: 6,
    });
  });

  it('arena: no swarm, 3-20 min, 2-32 seats', () => {
    const s = clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena', pveIntensity: 3, matchMinutes: 1, maxPlayers: 1 });
    expect(s).toMatchObject({ gameType: 'arena', pveIntensity: 0, matchMinutes: 3, maxPlayers: 2 });
    expect(clampSettings(s, { matchMinutes: 25 }).matchMinutes).toBe(20);
    expect(clampSettings(s, { pveIntensity: 2 }).pveIntensity).toBe(0);
  });

  it('ctf + ffa -> teams (and 2-4 teams); DM and Hot Point allow FFA; Warzone Zones does not', () => {
    withReady(['ctf', 'zones', 'hotpoint'], () => {
      const arena = { ...DEFAULT_SETTINGS_BY_TYPE.arena };
      expect(normalizeForType({ ...arena, subMode: 'ctf', mode: 'ffa' }).mode).toBe('teams');
      expect(normalizeForType({ ...arena, subMode: 'ctf', teamCount: 8 }).teamCount).toBe(4);
      expect(normalizeForType({ ...arena, subMode: 'hotpoint', mode: 'ffa' }).mode).toBe('ffa');
      expect(normalizeForType({ ...arena, subMode: 'deathmatch', mode: 'ffa' }).mode).toBe('ffa');
      expect(normalizeForType({ ...DEFAULT_ROOM_SETTINGS, subMode: 'zones', mode: 'ffa' }).mode).toBe('teams');
      // FFA keeps a sane team count for switching back
      expect(normalizeForType({ ...arena, subMode: 'deathmatch', mode: 'ffa', teamCount: 1 }).teamCount).toBe(2);
    });
  });

  it('a type switch re-bases on the type defaults (keeping name and bot skill)', () => {
    const mine: RoomSettings = { ...DEFAULT_ROOM_SETTINGS, name: 'Mine', botSkill: 'hard', maxPlayers: 10, botFill: 3, pveIntensity: 3, matchMinutes: 25 };
    const s = clampSettings(mine, { gameType: 'arena' });
    expect(s).toMatchObject({
      name: 'Mine', botSkill: 'hard', gameType: 'arena', maxPlayers: 16, botFill: 10, pveIntensity: 0,
      // M3: arena's default sub-mode (CTF) is open, with its own length
      subMode: 'ctf', matchMinutes: 12,
    });
    withNotReady(PRE_M3, () => {
      // while CTF wasn't ready (M1/M2): Deathmatch, with its own length
      expect(clampSettings(mine, { gameType: 'arena' })).toMatchObject({ subMode: 'deathmatch', matchMinutes: 10 });
    });
    // patch fields still apply on top of the new base
    expect(clampSettings(mine, { gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', maxPlayers: 8 })).toMatchObject({ mode: 'ffa', maxPlayers: 8, name: 'Mine' });
    // same type = no re-base
    expect(clampSettings(mine, { gameType: 'warzone' }).maxPlayers).toBe(10);
  });

  it('a sub-mode switch resets the match length and target unless the patch sets them', () => {
    withReady(['ctf', 'zones', 'hotpoint'], () => {
      const dm: RoomSettings = { ...DEFAULT_SETTINGS_BY_TYPE.arena, subMode: 'deathmatch', matchMinutes: 15, scoreLimit: 500 };
      expect(clampSettings(dm, { subMode: 'ctf' })).toMatchObject({ subMode: 'ctf', matchMinutes: 12, objectiveLimit: 0, scoreLimit: 0 });
      expect(clampSettings(dm, { subMode: 'ctf', matchMinutes: 7 }).matchMinutes).toBe(7);
      const zones = clampSettings(dm, { subMode: 'zones', objectiveLimit: 500 });
      expect(zones).toMatchObject({ subMode: 'zones', matchMinutes: 10, objectiveLimit: 500 });
      expect(clampSettings(zones, { subMode: 'hotpoint' }).objectiveLimit).toBe(0);
      expect(clampSettings(zones, { objectiveLimit: 50 }).objectiveLimit).toBe(100); // limitMin
      expect(clampSettings(zones, { objectiveLimit: 5000 }).objectiveLimit).toBe(1000); // limitMax
      expect(clampSettings(zones, { objectiveLimit: 0 }).objectiveLimit).toBe(0); // 0 = sub-mode default
      expect(clampSettings(dm, { objectiveLimit: 5 }).objectiveLimit).toBe(0); // DM has no target
      expect(clampSettings(dm, { scoreLimit: 250 }).scoreLimit).toBe(250);
    });
  });

  it('a not-ready sub-mode is substituted by the first ready one of the type', () => {
    withNotReady(PRE_M3, () => {
      expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena', subMode: 'ctf' }).subMode).toBe('deathmatch');
      expect(clampSettings(DEFAULT_ROOM_SETTINGS, { subMode: 'zones' }).subMode).toBe('deathmatch');
    });
    // escort (v0.4) is never open: the type's default (CTF, open since M3; Deathmatch before)
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena', subMode: 'escort' }).subMode).toBe('ctf');
    withNotReady(PRE_M3, () => {
      expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena', subMode: 'escort' }).subMode).toBe('deathmatch');
    });
    // M3: CTF / Zones / Hot Point are open
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena', subMode: 'ctf' }).subMode).toBe('ctf');
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { subMode: 'zones' }).subMode).toBe('zones'); // Warzone Control Zones
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena', subMode: 'hotpoint' }).subMode).toBe('hotpoint');
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { subMode: 'ctf' }).subMode).toBe('deathmatch'); // not a warzone mode
    // nothing of the type is ready: the type's default stays (the Zone refuses to open such a room)
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'dungeon', subMode: 'rival' }).subMode).toBe('coop');
    withReady(['ctf'], () => {
      expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena' })).toMatchObject({ subMode: 'ctf', matchMinutes: 12 });
    });
  });
});

describe('v0.3 quickPlayScore', () => {
  const sum = (o: Partial<RoomSummary>): RoomSummary => ({
    id: 'r1', name: 'R', mode: 'teams', teamCount: 2, phase: 'lobby', humans: 0, bots: 10, maxPlayers: 16,
    gameType: 'warzone', subMode: 'deathmatch', pveIntensity: 2, floors: 0, house: false, hostName: '', spectators: 0,
    joinable: true, watchable: false, startsInSec: 0, live: null, ...o,
  });
  const live = (timeLeftSec: number, floor = 0, floorsTotal = 0) => ({
    elapsedSec: 60, timeLeftSec, wave: 1, floor, floorsTotal, lives: -1, scores: [], scoreline: '', leader: '', leaderScore: 0,
  });

  it('phase bases, +10 per active human (capped), +5 for house rooms', () => {
    expect(quickPlayScore(sum({ phase: 'countdown' }), 'warzone')).toBe(130);
    expect(quickPlayScore(sum({ phase: 'lobby', startsInSec: 14 }), 'warzone')).toBe(120);
    expect(quickPlayScore(sum({}), 'warzone')).toBe(100);
    expect(quickPlayScore(sum({ phase: 'results' }), 'warzone')).toBe(60);
    expect(quickPlayScore(sum({ phase: 'playing', live: live(400) }), 'warzone')).toBe(80);
    expect(quickPlayScore(sum({ house: true }), 'warzone')).toBe(105);
    expect(quickPlayScore(sum({ humans: 3, spectators: 1 }), 'warzone')).toBe(120); // 2 active
    expect(quickPlayScore(sum({ humans: 40, maxPlayers: 4 }), 'warzone')).toBe(130); // min(active, max - 1)
  });

  it('ineligible: other type / sub-mode, not ready, not joinable, < 90 s left, the last rift floor', () => {
    expect(quickPlayScore(sum({}), 'arena')).toBe(-1);
    expect(quickPlayScore(sum({}), 'warzone', 'zones')).toBe(-1);
    expect(quickPlayScore(sum({}), 'warzone', 'deathmatch')).toBe(100);
    withNotReady(PRE_M3, () => {
      expect(quickPlayScore(sum({ gameType: 'arena', subMode: 'ctf' }), 'arena')).toBe(-1); // not ready
    });
    expect(quickPlayScore(sum({ gameType: 'arena', subMode: 'ctf' }), 'arena')).toBe(100); // M3: open
    expect(quickPlayScore(sum({ gameType: 'arena', subMode: 'escort' }), 'arena')).toBe(-1); // v0.4
    expect(quickPlayScore(sum({ joinable: false }), 'warzone')).toBe(-1);
    expect(quickPlayScore(sum({ phase: 'playing', live: live(89) }), 'warzone')).toBe(-1);
    expect(quickPlayScore(sum({ phase: 'playing', live: live(90) }), 'warzone')).toBe(80);
    expect(quickPlayScore(sum({ phase: 'playing', live: live(-1) }), 'warzone')).toBe(80); // untimed
    withReady(['coop'], () => {
      const rift = { gameType: 'dungeon' as const, subMode: 'coop' as const, maxPlayers: 4 };
      expect(quickPlayScore(sum({ ...rift, phase: 'playing', live: live(-1, 2, 6) }), 'dungeon')).toBe(40);
      expect(quickPlayScore(sum({ ...rift, phase: 'playing', live: live(-1, 6, 6) }), 'dungeon')).toBe(-1);
    });
  });
});

describe('v0.3 house rooms', () => {
  it('online: only rooms whose sub-mode is ready (M3: + Flag Run + Hot Points; M4: + The Descent)', () => {
    const rooms = houseRooms(false);
    expect(rooms.map((r) => r.name)).toEqual(['The Descent', 'Flag Run', 'Hot Points', 'Duel Pit', 'Warzone Classic']);
    for (const r of rooms) expect(SUB_MODES[r.subMode!].ready).toBe(true);
    withNotReady(PRE_M4, () => {
      expect(houseRooms(false).map((r) => r.name)).toEqual(['Flag Run', 'Hot Points', 'Duel Pit', 'Warzone Classic']); // M3
    });
    withNotReady(PRE_M3, () => {
      expect(houseRooms(false).map((r) => r.name)).toEqual(['Duel Pit', 'Warzone Classic']); // M1 / M2
    });
    const duel = rooms.find((r) => r.name === 'Duel Pit')!;
    expect(clampSettings(DEFAULT_SETTINGS_BY_TYPE[duel.gameType!], duel)).toMatchObject({
      gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', maxPlayers: 8, botFill: 4, pveIntensity: 0,
    });
    withReady(['ctf', 'hotpoint', 'coop'], () => {
      expect(houseRooms(false).map((r) => r.name)).toEqual(['The Descent', 'Flag Run', 'Hot Points', 'Duel Pit', 'Warzone Classic']);
    });
  });

  it('offline: one per type, a not-ready sub-mode swapped for the first ready one, types with none skipped', () => {
    withNotReady(PRE_M3, () => {
      const rooms = houseRooms(true);
      expect(rooms.map((r) => r.name)).toEqual(['Offline Arena', 'Offline Warzone']);
      expect(rooms[0]).toMatchObject({ gameType: 'arena', subMode: 'deathmatch', mode: 'teams', teamCount: 2, maxPlayers: 12, botFill: 10 });
      expect(rooms[1]).toMatchObject({ gameType: 'warzone', subMode: 'deathmatch', botFill: 12 });
    });
    // M3: Offline Arena plays its own sub-mode (CTF); before M4 the Rift had nothing ready
    withNotReady(PRE_M4, () => {
      const rooms = houseRooms(true);
      expect(rooms.map((r) => r.name)).toEqual(['Offline Arena', 'Offline Warzone']);
      expect(rooms[0]).toMatchObject({ gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2 });
    });
    // M4: the Offline Descent opens too
    const rooms = houseRooms(true);
    expect(rooms.map((r) => r.name)).toEqual(['Offline Descent', 'Offline Arena', 'Offline Warzone']);
    expect(rooms[0]).toMatchObject({ gameType: 'dungeon', subMode: 'coop', floors: 6, botFill: 4 });
    withReady(['ctf', 'coop'], () => {
      const r = houseRooms(true);
      expect(r.map((x) => x.name)).toEqual(['Offline Descent', 'Offline Arena', 'Offline Warzone']);
      expect(r[1].subMode).toBe('ctf');
    });
  });
});

describe('v0.3 chat-command parsers', () => {
  it('game types and sub-modes by id, short name, name or alias', () => {
    expect(parseGameType('Arena')).toBe('arena');
    expect(parseGameType('rift')).toBe('dungeon');
    expect(parseGameType('Dungeon Runner')).toBe('dungeon');
    expect(parseGameType('wz')).toBe('warzone');
    expect(parseGameType('pong')).toBeNull();
    expect(parseSubMode('arena', 'dm')).toBe('deathmatch');
    expect(parseSubMode('arena', 'CTF')).toBe('ctf');
    expect(parseSubMode('arena', 'hot')).toBe('hotpoint');
    expect(parseSubMode('arena', 'capture the flag')).toBe('ctf');
    expect(parseSubMode('warzone', 'classic')).toBe('deathmatch');
    expect(parseSubMode('warzone', 'ctf')).toBeNull(); // not a warzone mode
    expect(parseSubMode('dungeon', 'co-op')).toBe('coop');
    expect(parseSubMode('arena', '')).toBeNull();
  });
});

describe('v0.3 M1: sub-mode substitution keeps the length consistent', () => {
  it("createRoom {gameType:'arena'} (CTF default → DM) gets DM's 10 min, not CTF's 12", () => {
    withNotReady(PRE_M3, () => {
      expect(clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, { gameType: 'arena' })).toMatchObject({ subMode: 'deathmatch', matchMinutes: 10 });
      expect(clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, {})).toMatchObject({ subMode: 'deathmatch', matchMinutes: 10 });
      expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena' })).toMatchObject({ subMode: 'deathmatch', matchMinutes: 10 });
      // any other length is kept (one equal to CTF's default is indistinguishable from it, so it follows DM)
      expect(clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, { gameType: 'arena', matchMinutes: 15 }).matchMinutes).toBe(15);
      expect(clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, { matchMinutes: 7 }).matchMinutes).toBe(7);
    });
    // M3: CTF is open, so Arena keeps its own default and length
    expect(clampSettings(DEFAULT_ROOM_SETTINGS, { gameType: 'arena' })).toMatchObject({ subMode: 'ctf', matchMinutes: 12 });
  });

  it("a not-ready or foreign sub-mode in a patch is ignored: it doesn't reset the length or target", () => {
    withNotReady(PRE_M3, () => {
      const dm5 = { ...clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, {}), matchMinutes: 5 };
      expect(clampSettings(dm5, { subMode: 'ctf' })).toEqual(dm5);
    });
    const dm5 = { ...clampSettings(DEFAULT_SETTINGS_BY_TYPE.arena, { subMode: 'deathmatch' }), matchMinutes: 5 };
    expect(clampSettings(dm5, { subMode: 'escort' })).toEqual(dm5);
    expect(clampSettings(dm5, { subMode: 'coop' })).toEqual(dm5);
    const wz = { ...DEFAULT_ROOM_SETTINGS, matchMinutes: 7 };
    expect(clampSettings(wz, { subMode: 'ctf' })).toEqual(wz);
  });
});
