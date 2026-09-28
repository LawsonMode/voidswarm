// OWNER: ROOM agent. v0.3 M4: the pure rift glue (room/rift.ts) — RiftResult statuses, result lines, awards, the bot
// class complement. The Room-level flow (floorStart, drop-ins, extraction) is in room.test.ts.
import { describe, expect, it } from 'vitest';
import type { PlayerScore, RiftResult } from '../protocol';
import { createWorld } from '../sim/world';
import { emptyInput, type RiftState, type Ship, type World } from '../types';
import {
  RIFT_BIOME_NAMES, buildRiftResult, extractLine, floorLine, riftAwards, riftBotClass, riftFloorReached, riftOutcomeOf,
  riftResultLine, riftWinner,
} from './rift';

function rift(patch: Partial<RiftState> = {}): RiftState {
  return {
    floor: 3, floorsTotal: 6, floorStartTick: 0, rooms: [], portal: 0, departTick: 0,
    parties: [{ team: 0, lives: 7, status: 'active', anchorX: 0, anchorY: 0, seen: 1, roomsCleared: 12, bossesKilled: 1, deepestFloor: 3 }],
    extractOpen: false, victoryTick: 0, bossId: 0, bossPhase: 0, pendingFloor: 0, outcome: 'running', extracted: [], instabilityTick: 0,
    ...patch,
  };
}

function world(d: RiftState, pids: number[]): World {
  const map = { seed: 1, teamCount: 1, width: 6400, height: 6400, tileSize: 32, cols: 200, rows: 200, tiles: new Uint8Array(40000), spawns: [] };
  const w = createWorld({
    mapSeed: 1, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
    gameType: 'dungeon', subMode: 'coop', floors: 6,
  }, map);
  w.dungeon = d;
  w.tick = 125 * 60;
  for (const pid of pids) {
    const id = w.nextId++;
    w.ships.set(id, { id, playerId: pid, deaths: pid % 3, skillState: {}, input: emptyInput() } as unknown as Ship);
    w.shipsByPlayer.set(pid, id);
  }
  return w;
}

const row = (playerId: number, score: number): PlayerScore => ({ playerId, score, kills: 0, deaths: 0, enemyKills: 0, bounty: 0, level: 1 });

describe('rift result', () => {
  it('statuses: extracted wins (also after leaving), survived only on a clear, lost otherwise, left for quitters', () => {
    const d = rift({ outcome: 'extracted', extracted: [{ playerId: 1, floor: 3, tick: 10 }, { playerId: 4, floor: 3, tick: 20 }] });
    const w = world(d, [1, 2, 3]);
    const leavers = new Map([[4, { floor: 3, deaths: 1 }], [5, { floor: 2, deaths: 4 }], [2, { floor: 1, deaths: 2 }]]);
    const r = buildRiftResult(w, leavers, [row(3, 50), row(1, 40), row(2, 10)])!;
    expect(r).toMatchObject({ outcome: 'extracted', floorsTotal: 6, floorReached: 3, roomsCleared: 12, bossesKilled: 1, timeSec: 125 });
    expect(r.players).toEqual([
      { playerId: 3, status: 'lost', floor: 3, deaths: 0 }, // left behind when the humans extracted
      { playerId: 1, status: 'extracted', floor: 3, deaths: 1 },
      { playerId: 2, status: 'lost', floor: 3, deaths: 2 + 2 }, // came back after leaving: deaths add up
      { playerId: 4, status: 'extracted', floor: 3, deaths: 1 }, // extracted, then left the room
      { playerId: 5, status: 'left', floor: 2, deaths: 4 },
    ]);
    const cleared = buildRiftResult(world(rift({ outcome: 'cleared', floor: 6 }), [7]), new Map())!;
    expect(cleared.players).toEqual([{ playerId: 7, status: 'survived', floor: 6, deaths: 1 }]);
    expect(buildRiftResult(world(rift({ outcome: 'wiped' }), [7]), new Map())!.players[0].status).toBe('lost');
    const w2 = world(rift(), []);
    w2.dungeon = undefined;
    expect(buildRiftResult(w2, new Map())).toBeUndefined();
  });

  it('outcome, winner and floor reached; a still-running run the Room ends counts as abandoned', () => {
    expect(riftOutcomeOf(rift())).toBe('abandoned');
    expect(riftOutcomeOf(rift({ outcome: 'wiped' }))).toBe('wiped');
    expect(riftWinner('cleared')).toBe(0);
    expect(riftWinner('extracted')).toBe(0);
    expect(riftWinner('wiped')).toBe(-1);
    expect(riftWinner('abandoned')).toBe(-1);
    expect(riftFloorReached(rift({ floor: 2, parties: [{ ...rift().parties[0], deepestFloor: 5 }] }))).toBe(5);
    expect(riftFloorReached(rift({ floor: 4 }))).toBe(4);
  });

  it('fix #23 result lines and the event lines', () => {
    const r = (outcome: RiftResult['outcome']): RiftResult => ({ outcome, floorsTotal: 6, floorReached: 5, roomsCleared: 0, bossesKilled: 0, timeSec: 0, players: [] });
    expect(riftResultLine(r('cleared'), 6)).toBe('RIFT CONQUERED — all 6 floors cleared!');
    expect(riftResultLine(r('extracted'), 3)).toBe('Everyone extracted on floor 3.');
    expect(riftResultLine(r('wiped'), 5)).toBe('Party wiped on floor 5 — unsecured loot lost.');
    expect(riftResultLine(r('abandoned'), 2)).toBe('Run abandoned on floor 2.');
    expect(extractLine('Kestrel', 3, 5)).toBe('Kestrel extracted from floor 3 with 5 caches');
    expect(extractLine('Kestrel', 3, 1)).toBe('Kestrel extracted from floor 3 with 1 cache');
    expect(extractLine('Kestrel', 6, 0)).toBe('Kestrel extracted from floor 6.');
    const w = world(rift(), []);
    expect(floorLine(w, 4)).toBe(`Floor 4 — ${RIFT_BIOME_NAMES.prism}`);
    expect(floorLine(w, 1)).toBe('Floor 1 — Hive Warrens');
    expect(floorLine(w, 3)).toBe('Floor 3 — Hive Warrens · the Matriarch waits');
    expect(floorLine(w, 6)).toBe('Floor 6 — Prism Vaults · final floor');
  });

  it('awards: Delver = deepest floor (ties → the higher scorer; never a leaver), Treasure Hunter = most chests', () => {
    const res: RiftResult = {
      outcome: 'extracted', floorsTotal: 6, floorReached: 6, roomsCleared: 0, bossesKilled: 0, timeSec: 0, players: [
        { playerId: 1, status: 'extracted', floor: 3, deaths: 0 },
        { playerId: 2, status: 'lost', floor: 6, deaths: 0 },
        { playerId: 3, status: 'lost', floor: 6, deaths: 0 },
        { playerId: 9, status: 'left', floor: 6, deaths: 0 },
      ],
    };
    const scores = [row(3, 90), row(2, 50), row(1, 10)];
    const aw = riftAwards(res, scores, new Map([[1, 2], [2, 2], [3, 0]]));
    expect(aw).toEqual([
      { title: 'Delver', playerId: 3, value: 'floor 6' },
      { title: 'Treasure Hunter', playerId: 2, value: '2 chests' }, // tie on 2: the higher scorer
    ]);
    expect(riftAwards(res, scores, new Map())).toHaveLength(1);
    expect(riftAwards(undefined, scores, new Map())).toEqual([]);
  });

  it('bot class complement: an Artificer first, then the least-used class; a bot keeps its class on a tie', () => {
    const r = () => 0;
    expect(riftBotClass([], r)).toBe('engineer');
    expect(riftBotClass(['brute', 'brute'], r)).toBe('engineer');
    expect(riftBotClass(['brute', 'engineer'], r)).toBe('tech');
    expect(riftBotClass(['brute', 'engineer', 'tech'], () => 0.99, 'brute')).toBe('brute');
    expect(riftBotClass(['brute', 'engineer', 'tech', 'tech'], r, 'tech')).not.toBe('tech');
  });
});
