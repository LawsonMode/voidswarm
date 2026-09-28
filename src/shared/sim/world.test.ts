// ARCHITECT: v0.3 frozen-contract helpers (world.ts, types.ts) and the neutral hot-path hooks of the M1 stubs.
// The hook checks describe the contract "no objective / no loot in this match", so they stay valid after the
// owners implement the modules.
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_EVENT_TYPES, LOOT_SETS, SHIPFLAG_BOT, SHIPFLAG_CARRIER, TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL,
} from '../types';
import type { GameEvent, Ship, SimConfig } from '../types';
import { generateMap } from './map';
import { carriedOf, createWorld, gameTypeOf, isDungeon, subModeOf } from './world';
import { rollLoot, spillCarried, stepLoot } from './loot';
import { stepRift } from './dungeon';
import {
  buildObjectiveView, isCarrier, objMaxTurrets, objRechargeMult, objSpeedMult, objectiveAnchors, objectiveEndCheck,
  objectiveRelease, objectiveSpawnPoint, objectivesInit, stepObjectives,
} from './objectives';
import { carrierSpeedMult, CTF_CARRIER_SPEED_MULT } from './objectives/rules';

const base: SimConfig = {
  mapSeed: 42, mode: 'teams', teamCount: 2, pveIntensity: 2, matchSeconds: 600, scoreLimit: 0, friendlyFire: false,
};
const mkWorld = (cfg: Partial<SimConfig> = {}) => {
  const c = { ...base, ...cfg };
  return createWorld(c, generateMap(c.mapSeed, c.mode === 'teams' ? c.teamCount : 0));
};
const fakeShip = (maxTurrets = 2): Ship => ({ id: 7, playerId: 3, stats: { maxTurrets } } as unknown as Ship);

describe('types.ts v0.3 constants', () => {
  it('TILE_DOOR is a new, distinct tile value', () => {
    expect(TILE_DOOR).toBe(4);
    expect(new Set([TILE_EMPTY, TILE_WALL, TILE_ROCK, TILE_BASE, TILE_DOOR]).size).toBe(5);
  });

  it('SHIPFLAG_CARRIER is bit 128 and fits the u8 flags byte', () => {
    expect(SHIPFLAG_CARRIER).toBe(128);
    expect(SHIPFLAG_CARRIER & SHIPFLAG_BOT).toBe(0);
    expect(SHIPFLAG_CARRIER).toBeLessThan(256);
  });

  it('LOOT_SETS wire order is frozen', () => {
    expect(LOOT_SETS).toEqual(['common', 'rift', 'gladiator', 'swarm']);
  });

  it('GLOBAL_EVENT_TYPES: rift / objective / loot globals added, positional ones excluded', () => {
    const globals: GameEvent['t'][] = [
      'shipSpawn', 'shipDeath', 'levelUp', 'upgrade', 'attach', 'detach', 'waveStart', 'matchEnd',
      'roomSeal', 'roomClear', 'roomReset', 'chestOpen', 'bossIntro', 'bossPhase', 'portalOpen', 'departing',
      'floorStart', 'lifeLost', 'outOfLives', 'extract', 'partyWiped', 'instability', 'riftEnd',
      'objective', 'lootPickup', 'lootSpill', 'lootSecured',
    ];
    for (const t of globals) expect(GLOBAL_EVENT_TYPES.has(t)).toBe(true);
    expect(GLOBAL_EVENT_TYPES.size).toBe(globals.length);
    for (const t of ['spawnWarn', 'telegraph', 'lootDrop', 'hit', 'explode'] as GameEvent['t'][]) {
      expect(GLOBAL_EVENT_TYPES.has(t)).toBe(false);
    }
  });
});

describe('world.ts v0.3 helpers', () => {
  it('createWorld initializes an empty loot map and keeps v0.2 fields', () => {
    const w = mkWorld();
    expect(w.loot).toBeInstanceOf(Map);
    expect(w.loot!.size).toBe(0);
    expect(w.dungeon).toBeUndefined();
    expect(w.match.endTick).toBe(600 * 60);
    expect(w.match.teamScores).toEqual([0, 0]);
  });

  it('matchSeconds 0 means untimed (endTick 0)', () => {
    expect(mkWorld({ matchSeconds: 0 }).match.endTick).toBe(0);
  });

  it('gameTypeOf falls back on pveIntensity; explicit wins', () => {
    expect(gameTypeOf({ ...base })).toBe('warzone');
    expect(gameTypeOf({ ...base, pveIntensity: 0 })).toBe('arena');
    expect(gameTypeOf({ ...base, pveIntensity: 0, gameType: 'warzone' })).toBe('warzone');
    expect(gameTypeOf({ ...base, gameType: 'dungeon' })).toBe('dungeon');
  });

  it('subModeOf defaults to deathmatch (coop in a dungeon); explicit wins', () => {
    expect(subModeOf({ ...base })).toBe('deathmatch');
    expect(subModeOf({ ...base, gameType: 'dungeon' })).toBe('coop');
    expect(subModeOf({ ...base, gameType: 'arena', subMode: 'ctf' })).toBe('ctf');
  });

  it('isDungeon follows world.dungeon', () => {
    expect(isDungeon(mkWorld())).toBe(false);
  });

  it('carriedOf creates the array once and returns the same one', () => {
    const s = fakeShip();
    expect(s.carried).toBeUndefined();
    const a = carriedOf(s);
    expect(a).toEqual([]);
    a.push({ rarity: 3, set: 'swarm', source: 'boss' });
    expect(carriedOf(s)).toBe(a);
    expect(s.carried).toHaveLength(1);
  });
});

describe('hot-path hooks are neutral without an objective / loot', () => {
  it('loot: nothing rolls with lootMult absent, spill and step are safe', () => {
    const w = mkWorld();
    const s = fakeShip();
    expect(rollLoot(w, 'elite', 100, 100, { priorityPid: 3 })).toBe(0);
    expect(() => spillCarried(w, s, 0)).not.toThrow();
    expect(() => stepLoot(w, 1 / 60)).not.toThrow();
    expect(w.loot!.size).toBe(0);
    expect(w.events).toEqual([]);
  });

  it('rift: stepRift is a no-op outside a dungeon', () => {
    const w = mkWorld();
    expect(() => stepRift(w)).not.toThrow();
    expect(w.events).toEqual([]);
  });

  it('objectives: deathmatch init sets null and every hook returns its neutral value', () => {
    const w = mkWorld();
    objectivesInit(w);
    expect(w.objective).toBeNull();
    const s = fakeShip(3);
    expect(() => stepObjectives(w)).not.toThrow();
    expect(objectiveEndCheck(w)).toBe('continue');
    expect(objectiveSpawnPoint(w, s)).toBeNull();
    expect(() => objectiveRelease(w, s)).not.toThrow();
    expect(isCarrier(w, s)).toBe(false);
    expect(objSpeedMult(w, s)).toBe(1);
    expect(objRechargeMult(w, s)).toBe(1);
    expect(objMaxTurrets(w, s)).toBe(3);
    expect(objectiveAnchors(w)).toEqual([]);
    expect(buildObjectiveView(w)).toBeUndefined();
    expect(w.events).toEqual([]);
  });

  it('carrierSpeedMult reads SHIPFLAG_CARRIER', () => {
    expect(carrierSpeedMult(0)).toBe(1);
    expect(carrierSpeedMult(SHIPFLAG_BOT)).toBe(1);
    expect(carrierSpeedMult(SHIPFLAG_CARRIER | SHIPFLAG_BOT)).toBe(CTF_CARRIER_SPEED_MULT);
  });
});
