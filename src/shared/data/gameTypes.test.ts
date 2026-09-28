// ARCHITECT: v0.3 game-type catalog + per-type room defaults (docs/v0.3-proposal.md §3.1, §8.2, §8.6).
// Milestone-agnostic: owners flip `ready` in M3/M4 without breaking these.
import { describe, expect, it } from 'vitest';
import { PARTY_SIZE, RIFT_FLOOR_OPTIONS } from '../constants';
import { DEFAULT_ROOM_SETTINGS, DEFAULT_SETTINGS_BY_TYPE } from '../protocol';
import type { GameType, SubMode } from '../types';
import {
  GAME_TYPE_IDS, GAME_TYPES, SUB_MODES, firstReadySubMode, isGameType, isLegalCombo, isObjectiveSubMode, isSubMode,
  objectiveTarget, readySubModes, subModeInType, subModeLabel,
} from './gameTypes';
import { SET_FOR_TYPE } from './loot';

const SUBS = Object.keys(SUB_MODES) as SubMode[];

describe('catalog shape', () => {
  it('ids match their keys', () => {
    expect([...GAME_TYPE_IDS].sort()).toEqual(Object.keys(GAME_TYPES).sort());
    for (const t of GAME_TYPE_IDS) expect(GAME_TYPES[t].id).toBe(t);
    for (const s of SUBS) expect(SUB_MODES[s].id).toBe(s);
  });

  it('type <-> sub-mode membership is symmetric and the default belongs to its type', () => {
    for (const t of GAME_TYPE_IDS) {
      const T = GAME_TYPES[t];
      expect(T.subModes).toContain(T.defaultSubMode);
      for (const s of T.subModes) expect(SUB_MODES[s].types).toContain(t);
    }
    for (const s of SUBS) for (const t of SUB_MODES[s].types) expect(GAME_TYPES[t].subModes).toContain(s);
  });

  it('team and target bounds are consistent', () => {
    for (const s of SUBS) {
      const d = SUB_MODES[s];
      expect(d.minTeams).toBeGreaterThanOrEqual(1);
      expect(d.maxTeams).toBeGreaterThanOrEqual(d.minTeams);
      expect(d.maxTeams).toBeLessThanOrEqual(8);
      if (d.limitMax === 0) {
        expect(d.limitLabel).toBe('');
        expect(d.defaultLimit).toBe(0);
      } else {
        expect(d.limitMin).toBeGreaterThan(0);
        for (const v of [d.defaultLimit, d.defaultLimitFfa]) {
          expect(v).toBeGreaterThanOrEqual(d.limitMin);
          expect(v).toBeLessThanOrEqual(d.limitMax);
        }
      }
    }
  });

  it('each type names its exclusive loot set exactly as data/loot.ts does', () => {
    for (const t of GAME_TYPE_IDS) expect(GAME_TYPES[t].lootSet).toBe(SET_FOR_TYPE[t]);
  });

  it('v0.4 reservations stay not-ready; deathmatch is the M1 ready gate', () => {
    for (const s of SUBS) if (SUB_MODES[s].since === '0.4') expect(SUB_MODES[s].ready).toBe(false);
    expect(SUB_MODES.rival.ready).toBe(false);
    expect(SUB_MODES.escort.ready).toBe(false);
    expect(SUB_MODES.deathmatch.ready).toBe(true);
  });
});

describe('helpers', () => {
  it('isGameType / isSubMode reject junk and prototype keys', () => {
    expect(isGameType('arena')).toBe(true);
    expect(isGameType('nope')).toBe(false);
    expect(isGameType(3)).toBe(false);
    expect(isSubMode('hotpoint')).toBe(true);
    expect(isSubMode('points')).toBe(false);
    expect(isSubMode('toString')).toBe(false);
    expect(isSubMode('__proto__')).toBe(false);
    expect(isSubMode(null)).toBe(false);
  });

  it('isObjectiveSubMode', () => {
    expect(SUBS.filter(isObjectiveSubMode).sort()).toEqual(['ctf', 'escort', 'hotpoint', 'zones']);
  });

  it('readySubModes / firstReadySubMode agree', () => {
    for (const t of GAME_TYPE_IDS) {
      const ready = readySubModes(t);
      for (const s of ready) expect(SUB_MODES[s].ready && subModeInType(t, s)).toBe(true);
      const first = firstReadySubMode(t);
      if (ready.length === 0) expect(first).toBeNull();
      else if (SUB_MODES[GAME_TYPES[t].defaultSubMode].ready) expect(first).toBe(GAME_TYPES[t].defaultSubMode);
      else expect(first).toBe(ready[0]);
    }
    expect(firstReadySubMode('warzone')).toBe('deathmatch');
    expect(firstReadySubMode('arena')).not.toBeNull();
  });

  it('subModeLabel: Warzone deathmatch reads "Classic"', () => {
    expect(subModeLabel('warzone', 'deathmatch')).toBe('Classic');
    expect(subModeLabel('arena', 'deathmatch')).toBe('Deathmatch');
    expect(subModeLabel('arena', 'ctf')).toBe('Capture the Flag');
  });

  it('objectiveTarget', () => {
    expect(objectiveTarget('deathmatch', 'teams', 50)).toBe(0);
    expect(objectiveTarget('coop', 'teams', 5)).toBe(0);
    expect(objectiveTarget('ctf', 'teams', 0)).toBe(3);
    expect(objectiveTarget('ctf', 'teams', 99)).toBe(10);
    expect(objectiveTarget('zones', 'teams', 50)).toBe(100);
    expect(objectiveTarget('zones', 'teams', 333.6)).toBe(334);
    expect(objectiveTarget('hotpoint', 'teams', 0)).toBe(200);
    expect(objectiveTarget('hotpoint', 'ffa', 0)).toBe(120);
  });

  it('isLegalCombo', () => {
    expect(isLegalCombo('warzone', 'deathmatch', 'teams', 2)).toBe(true);
    expect(isLegalCombo('warzone', 'deathmatch', 'teams', 8)).toBe(true);
    expect(isLegalCombo('warzone', 'deathmatch', 'teams', 9)).toBe(false);
    expect(isLegalCombo('warzone', 'deathmatch', 'teams', 2.5)).toBe(false);
    expect(isLegalCombo('warzone', 'deathmatch', 'ffa', 0)).toBe(true);
    expect(isLegalCombo('warzone', 'ctf', 'teams', 2)).toBe(false); // not a Warzone sub-mode in v0.3
    expect(isLegalCombo('arena', 'ctf', 'teams', 4)).toBe(true);
    expect(isLegalCombo('arena', 'ctf', 'teams', 5)).toBe(false);
    expect(isLegalCombo('arena', 'ctf', 'ffa', 2)).toBe(false);
    expect(isLegalCombo('arena', 'hotpoint', 'ffa', 0)).toBe(true);
    expect(isLegalCombo('dungeon', 'coop', 'teams', 1)).toBe(true);
    expect(isLegalCombo('dungeon', 'coop', 'teams', 2)).toBe(false);
    expect(isLegalCombo('dungeon', 'coop', 'ffa', 1)).toBe(false);
    expect(isLegalCombo('dungeon', 'deathmatch', 'teams', 2)).toBe(false);
  });
});

describe('room defaults per type (protocol.ts)', () => {
  it('v0.2 default is unchanged Warzone Classic', () => {
    expect(DEFAULT_ROOM_SETTINGS).toMatchObject({
      name: 'Main Arena', gameType: 'warzone', subMode: 'deathmatch', mode: 'teams', teamCount: 2, maxPlayers: 32,
      botFill: 12, botSkill: 'normal', matchMinutes: 10, scoreLimit: 0, pveIntensity: 2, friendlyFire: false,
      floors: 0, objectiveLimit: 0,
    });
    expect({ ...DEFAULT_SETTINGS_BY_TYPE.warzone, name: DEFAULT_ROOM_SETTINGS.name }).toEqual(DEFAULT_ROOM_SETTINGS);
  });

  it('every per-type default obeys its type rules', () => {
    for (const t of GAME_TYPE_IDS as readonly GameType[]) {
      const s = DEFAULT_SETTINGS_BY_TYPE[t];
      const T = GAME_TYPES[t];
      expect(s.gameType).toBe(t);
      expect(s.subMode).toBe(T.defaultSubMode);
      expect(isLegalCombo(t, s.subMode, s.mode, s.teamCount)).toBe(true);
      const seatCap = T.partySize ? s.teamCount * T.partySize : T.maxPlayers;
      expect(s.maxPlayers).toBeGreaterThanOrEqual(T.minPlayers);
      expect(s.maxPlayers).toBeLessThanOrEqual(seatCap);
      expect(s.botFill).toBeLessThanOrEqual(s.maxPlayers);
      if (T.untimed) expect(s.matchMinutes).toBe(0);
      else {
        expect(s.matchMinutes).toBeGreaterThanOrEqual(T.minutesMin);
        expect(s.matchMinutes).toBeLessThanOrEqual(T.minutesMax);
      }
      if (T.pve === 'off') expect(s.pveIntensity).toBe(0);
      else expect(s.pveIntensity).toBeGreaterThanOrEqual(1);
      if (t === 'dungeon') expect(RIFT_FLOOR_OPTIONS).toContain(s.floors);
      else expect(s.floors).toBe(0);
    }
    expect(DEFAULT_SETTINGS_BY_TYPE.dungeon.maxPlayers).toBe(PARTY_SIZE);
  });
});
