import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../constants';
import { createWorld } from '../sim/world';
import type { ObjectiveState, ObjectiveSubMode, SimConfig, World } from '../types';
import {
  ObjectiveAnnouncer, buildObjectiveResult, compassPhrase, objStatsOf, objWorkSec, objectivePlayerPoints,
  objectiveSummary, objectiveTeamPoints, objectiveWinner, zoneLabel,
} from './objective';

function world(mode: 'teams' | 'ffa', subMode: ObjectiveSubMode | 'deathmatch', teamCount = 2): World {
  const cols = 200, rows = 200;
  const config: SimConfig = {
    mapSeed: 1, mode, teamCount: mode === 'ffa' ? 0 : teamCount, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0,
    friendlyFire: false, gameType: 'arena', subMode,
  };
  return createWorld(config, {
    seed: 1, teamCount, width: cols * 32, height: rows * 32, tileSize: 32, cols, rows, tiles: new Uint8Array(cols * rows), spawns: [],
  } as unknown as World['map']);
}
function objState(mode: ObjectiveSubMode, teams: number): ObjectiveState {
  return {
    mode, limit: 300, teamPoints: new Array(teams).fill(0), playerPoints: new Map(), flags: [], zones: [], hot: null,
    overtime: false, overtimeCapTick: 0, suddenDeath: false, extensions: 0, stats: new Map(), mem: {},
  };
}
const noNames = (): string | null => null;

describe('room/objective helpers (v0.3 M3)', () => {
  it('compassPhrase: the centre, then 8 directions with y growing south; zoneLabel', () => {
    const w = world('teams', 'zones');
    const c = w.map.width / 2;
    expect(compassPhrase(w, c + 100, c - 50)).toBe('to the centre');
    const at = (dx: number, dy: number): string => compassPhrase(w, c + dx, c + dy);
    expect([at(2000, 0), at(2000, 2000), at(0, 2000), at(-2000, 2000), at(-2000, 0), at(-2000, -2000), at(0, -2000), at(2000, -2000)])
      .toEqual(['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east']);
    expect([0, 1, 2, 4].map(zoneLabel)).toEqual(['the Core', 'Zone A', 'Zone B', 'Zone D']);
  });

  it('team points come from objective.teamPoints, else the sim mirror, sized to teamCount; FFA has none', () => {
    const w = world('teams', 'zones', 3);
    w.match.teamScores = [5, 6, 7];
    expect(objectiveTeamPoints(w)).toEqual([5, 6, 7]);
    w.objective = objState('zones', 3);
    w.objective.teamPoints = [1, Number.NaN, 3];
    expect(objectiveTeamPoints(w)).toEqual([1, 0, 3]); // never NaN on the wire
    expect(objectiveTeamPoints(world('ffa', 'hotpoint'))).toEqual([]);
  });

  it('playerPoints: > 0 only, best first, ties by lower playerId', () => {
    const w = world('ffa', 'hotpoint');
    w.objective = objState('hotpoint', 0);
    w.objective.playerPoints.set(9, 10).set(3, 10).set(4, 0).set(7, 44).set(8, Number.NaN);
    expect(objectivePlayerPoints(w)).toEqual([[7, 44], [3, 10], [9, 10]]);
  });

  it('objectiveWinner: the sim verdict stands once ended; an early end goes by points; ties are draws', () => {
    const w = world('teams', 'ctf');
    expect(objectiveWinner(w, [2, 1], [])).toEqual({ winnerTeam: 0, winnerPlayerId: 0 });
    expect(objectiveWinner(w, [1, 1], [])).toEqual({ winnerTeam: -1, winnerPlayerId: 0 });
    w.match.phase = 'ended'; w.match.winnerTeam = 1;
    expect(objectiveWinner(w, [1, 1], [])).toEqual({ winnerTeam: 1, winnerPlayerId: 0 });
    const f = world('ffa', 'hotpoint');
    expect(objectiveWinner(f, [], [[5, 30], [6, 20]])).toEqual({ winnerTeam: -1, winnerPlayerId: 5 });
    expect(objectiveWinner(f, [], [[5, 30], [6, 30]])).toEqual({ winnerTeam: -1, winnerPlayerId: 0 });
    expect(objectiveWinner(f, [], [])).toEqual({ winnerTeam: -1, winnerPlayerId: 0 });
  });

  it('summary: unit, overtime / extensions / sudden death tags, FFA top 3 by name', () => {
    const w = world('teams', 'zones', 2);
    w.objective = objState('zones', 2);
    w.objective.teamPoints = [187.4, 212.6];
    w.objective.extensions = 1;
    expect(buildObjectiveResult(w, noNames)!.summary).toBe('Azure 213 – 187 Crimson (points, overtime)');
    const f = world('ffa', 'hotpoint');
    f.objective = objState('hotpoint', 0);
    expect(objectiveSummary(f, 'hotpoint', [], [], noNames)).toBe('No points scored (points)');
    f.objective.playerPoints.set(1, 5).set(2, 9).set(3, 7).set(4, 1);
    const names: Record<number, string> = { 1: 'Ace', 2: 'Bee', 3: 'Cee' };
    const r = buildObjectiveResult(f, (pid) => names[pid] ?? null)!;
    expect(r).toEqual({ mode: 'hotpoint', teamPoints: [], playerPoints: [[2, 9], [3, 7], [1, 5], [4, 1]], summary: 'Bee 9 · Cee 7 · Ace 5 (points)' });
    expect(buildObjectiveResult(world('teams', 'deathmatch'), noNames)).toBeUndefined();
  });

  it('objStatsOf keeps non-zero finite fields only; objWorkSec reads sim ticks', () => {
    const w = world('teams', 'ctf');
    w.objective = objState('ctf', 2);
    w.objective.stats.set(4, { caps: 1, steals: 0, returns: Number.NaN, carrierKills: 2, zoneCaps: 0, neutralizes: 0, objTicks: 0, hotHoldTicks: 0 });
    expect(objStatsOf(w, 4)).toEqual({ caps: 1, carrierKills: 2 });
    expect(objStatsOf(w, 5)).toBeUndefined();
    w.objective.stats.set(6, { caps: 0, steals: 0, returns: 0, carrierKills: 0, zoneCaps: 0, neutralizes: 0, objTicks: 0, hotHoldTicks: 0 });
    expect(objStatsOf(w, 6)).toBeUndefined();
    expect(objWorkSec(90 * TICK_RATE + 20)).toBe(90);
  });

  it('announcer: gates reset per match; unknown kinds / neutralizes / hotMoved are silent', () => {
    const w = world('teams', 'ctf');
    w.objective = objState('ctf', 2);
    w.objective.flags.push(
      { team: 0, state: 'home', x: 0, y: 0, standX: 0, standY: 0, carrierId: 0, carrierPlayerId: 0, droppedAtTick: 0, pickedAtTick: 0, runners: [] },
      { team: 1, state: 'home', x: 0, y: 0, standX: 0, standY: 0, carrierId: 0, carrierPlayerId: 0, droppedAtTick: 0, pickedAtTick: 0, runners: [] },
    );
    const an = new ObjectiveAnnouncer();
    const ev = { t: 'objective' as const, kind: 'flagDropped' as const, team: 0, playerId: 0, index: 1, x: 0, y: 0, value: 20 };
    expect(an.line(w, ev, noNames)).toBe("Azure's flag is down!");
    expect(an.line(w, ev, noNames)).toBeNull(); // same flag, same tick
    an.reset();
    expect(an.line(w, ev, noNames)).toBe("Azure's flag is down!");
    expect(an.line(w, { ...ev, kind: 'zoneNeutralized' }, noNames)).toBeNull();
    expect(an.line(w, { ...ev, kind: 'hotMoved' }, noNames)).toBeNull();
  });
});
