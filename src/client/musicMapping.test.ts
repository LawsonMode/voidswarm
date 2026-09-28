// v0.3 M4 integration: the music wiring's pure rules (musicMapping.ts) and the driver (musicDriver.ts) against a fake
// director — scene per screen / state, intensity from game state (≤ 1, smoothed), stingers, volume / mute / hidden.
import { describe, expect, it } from 'vitest';
import type { RenderFrame } from './contracts';
import type { MusicScene } from './audio/music/format';
import { MusicDriver, type MusicSink } from './musicDriver';
import {
  MUSIC_INTENSITY, musicIntensityFor, musicSceneFor, musicStingersFor, resultWon, smoothToward, type MusicIntensityInput,
  type MusicSceneInput,
} from './musicMapping';
import type { MatchResult, PlayerScore } from '../shared/protocol';
import type { EnemyView, GameEvent, MatchView, RiftView, ShipView, YouState } from '../shared/types';
import { BEAM_NONE } from '../shared/types';

const row = (playerId: number, score: number): PlayerScore => ({ playerId, score, kills: 0, deaths: 0, enemyKills: 0, bounty: 0, level: 1 });
const result = (p: Partial<MatchResult> = {}): MatchResult => ({
  winnerTeam: 0, winnerPlayerId: 0, teamScores: [10, 5], scores: [row(1, 10), row(2, 8), row(3, 6), row(4, 4)], awards: [],
  gameType: 'arena', subMode: 'deathmatch', ...p,
});
const match = (p: Partial<MatchView> = {}): MatchView => ({
  phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 100, teamScores: [0, 0], wave: 0, winnerTeam: -1, winnerPlayerId: 0, ...p,
});
const rift = (p: Partial<RiftView> = {}): RiftView => ({
  floor: 1, floorsTotal: 6, biome: 'hive', rooms: [], chests: [], lives: [8], seen: [1], anchors: [0, 0], portal: 0, departIn: 0,
  extractOpen: false, boss: null, waiting: [], extracting: [], floorSec: 0, ...p,
});
const scene = (p: Partial<MusicSceneInput>): MusicScene => musicSceneFor({
  screen: 'game', result: null, match: match(), myPlayerId: 1, myTeam: 0, ffa: false, ...p,
});

describe('music scene mapping', () => {
  it('title / command / lobby by screen; match in a running match; boss while a rift boss lives', () => {
    expect(scene({ screen: 'title' })).toBe('title');
    expect(scene({ screen: 'command' })).toBe('command');
    expect(scene({ screen: 'room' })).toBe('lobby');
    expect(scene({})).toBe('match');
    expect(scene({ match: match({ gameType: 'dungeon', dungeon: rift() }) })).toBe('match');
    expect(scene({ match: match({ gameType: 'dungeon', dungeon: rift({ boss: { id: 5, kind: 'matriarch', hpFrac: 0.5, phase: 2 } }) }) })).toBe('boss');
    expect(scene({ match: null })).toBe('match');
  });

  it('results: victory when your team / party won, defeat otherwise; FFA top 3 is a victory', () => {
    expect(scene({ result: result({ winnerTeam: 0 }), myTeam: 0 })).toBe('victory');
    expect(scene({ result: result({ winnerTeam: 1 }), myTeam: 0 })).toBe('defeat');
    expect(scene({ result: result({ winnerTeam: -1 }), myTeam: 0 })).toBe('defeat'); // draw
    // rift: the party is team 0; a wipe / abandon has no winner
    expect(scene({ result: result({ gameType: 'dungeon', winnerTeam: 0, teamScores: [0] }), myTeam: 0 })).toBe('victory');
    expect(scene({ result: result({ gameType: 'dungeon', winnerTeam: -1, teamScores: [0] }), myTeam: 0 })).toBe('defeat');
    // FFA
    const ffa = result({ winnerTeam: -1, winnerPlayerId: 1, teamScores: [] });
    expect(scene({ result: ffa, ffa: true, myPlayerId: 3 })).toBe('victory');
    expect(scene({ result: ffa, ffa: true, myPlayerId: 4 })).toBe('defeat');
    // FFA hot point ranks by objective points, not score
    const hot = result({ winnerTeam: -1, winnerPlayerId: 4, teamScores: [], objective: { playerPoints: [[4, 90], [3, 50], [2, 40], [1, 10]] } as MatchResult['objective'] });
    expect(resultWon(hot, 4, -1, true)).toBe(true);
    expect(resultWon(hot, 1, -1, true)).toBe(false);
    // a spectator: any winner is a victory tune, a draw is not
    expect(resultWon(result({ winnerTeam: 1 }), 99, -2, false)).toBe(true);
    expect(resultWon(result({ winnerTeam: -1 }), 99, -2, false)).toBe(false);
  });
});

function ship(id: number, team: number, x: number, y: number, alive = true): ShipView {
  return {
    id, playerId: id, team, shipClass: 'brute', x, y, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive, attachedTo: 0,
    turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: BEAM_NONE, resonance: 1,
  };
}
const enemy = (id: number, x: number, y: number, kind: EnemyView['kind'] = 'drone'): EnemyView =>
  ({ id, kind, x, y, angle: 0, hpFrac: 1, radius: 14, elite: false } as EnemyView);
const you = (energy: number, max = 1000): YouState => ({ alive: true, energy, stats: { maxEnergy: max } } as unknown as YouState);
const inten = (p: Partial<MusicIntensityInput>): number => musicIntensityFor({
  match: match(), you: null, focusX: 0, focusY: 0, enemies: [], ships: [], myTeam: 0, myShipId: 1, ffa: false, ...p,
});

describe('music intensity mapping', () => {
  it('0.3 base; + wave / floor tier, nearby enemies, hostiles, low energy, overtime, boss; never above 1', () => {
    expect(inten({})).toBeCloseTo(MUSIC_INTENSITY.base, 9);
    expect(inten({ match: match({ wave: 5 }) })).toBeCloseTo(0.4, 9);
    expect(inten({ match: match({ dungeon: rift({ floor: 6 }) }) })).toBeCloseTo(0.5, 9);
    const swarm = Array.from({ length: 15 }, (_, i) => enemy(i + 1, 100 + i, 0));
    expect(inten({ enemies: swarm })).toBeCloseTo(0.3 + 0.125, 9);
    expect(inten({ enemies: swarm.map((e) => ({ ...e, x: 5000 })) })).toBeCloseTo(0.3, 9); // far away: not counted
    // hostile ships (not own, not a teammate, alive, near)
    const ships = [ship(1, 0, 0, 0), ship(2, 0, 100, 0), ship(3, 1, 200, 0), ship(4, 1, 300, 0, false), ship(5, 1, 5000, 0)];
    expect(inten({ ships })).toBeCloseTo(0.3 + MUSIC_INTENSITY.hostileEach, 9);
    expect(inten({ ships, ffa: true })).toBeCloseTo(0.3 + 2 * MUSIC_INTENSITY.hostileEach, 9);
    expect(inten({ you: you(0) })).toBeCloseTo(0.45, 9);
    expect(inten({ you: you(900) })).toBeCloseTo(0.3, 9);
    expect(inten({ match: match({ objective: { mode: 'ctf', limit: 3, overtime: false, suddenDeath: true } as MatchView['objective'] }) })).toBeCloseTo(0.45, 9);
    expect(inten({ match: match({ dungeon: rift({ boss: { id: 5, kind: 'matriarch', hpFrac: 1, phase: 1 } }) }) })).toBeCloseTo(0.5, 9);
    expect(inten({ enemies: [enemy(9, 10, 10, 'hive')] })).toBeCloseTo(0.3 + 0.25 / 30 + 0.2, 9); // a Hive in view
    const all = inten({
      match: match({ wave: 50, objective: { mode: 'ctf', limit: 3, overtime: true, suddenDeath: false } as MatchView['objective'] }),
      you: you(0), enemies: Array.from({ length: 60 }, (_, i) => enemy(i + 1, i, 0, i === 0 ? 'hive' : 'drone')),
      ships: Array.from({ length: 8 }, (_, i) => ship(i + 10, 1, i * 10, 0)),
    });
    expect(all).toBe(1);
  });

  it('smoothToward eases with a time constant and clamps to 0..1', () => {
    expect(smoothToward(0.3, 1, 0)).toBe(0.3);
    const one = smoothToward(0.3, 1, 1.5, 1.5);
    expect(one).toBeCloseTo(0.3 + 0.7 * (1 - Math.exp(-1)), 9);
    let v = 0.3;
    for (let i = 0; i < 600; i++) v = smoothToward(v, 1, 1 / 60);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
    expect(smoothToward(0.5, 7, 100)).toBe(1);
  });

  it('stingers: waveStart, a boss wave or bossIntro = bossIncoming, your own levelUp only; once each per frame', () => {
    const ev: GameEvent[] = [
      { t: 'waveStart', wave: 3, boss: false } as GameEvent,
      { t: 'waveStart', wave: 5, boss: true } as GameEvent,
      { t: 'bossIntro', id: 1, kind: 'matriarch', x: 0, y: 0 },
      { t: 'levelUp', playerId: 2, level: 3 } as GameEvent,
    ];
    expect(musicStingersFor(ev, 7)).toEqual(['waveStart', 'bossIncoming']);
    expect(musicStingersFor([...ev, { t: 'levelUp', playerId: 7, level: 4 } as GameEvent], 7)).toEqual(['waveStart', 'bossIncoming', 'levelUp']);
    expect(musicStingersFor([{ t: 'bossIntro', id: 1, kind: 'matriarch', x: 0, y: 0 }], 7)).toEqual(['bossIncoming']);
    expect(musicStingersFor([{ t: 'levelUp', playerId: 0, level: 2 } as GameEvent], 0)).toEqual([]);
  });
});

class FakeSink implements MusicSink {
  calls: string[] = [];
  unlock(): void { this.calls.push('unlock'); }
  setScene(s: MusicScene): void { this.calls.push(`scene:${s}`); }
  setIntensity(x: number): void { this.calls.push(`int:${x.toFixed(2)}`); }
  setVolume(v: number): void { this.calls.push(`vol:${v}`); }
  setMuted(m: boolean): void { this.calls.push(`mute:${m}`); }
  stingerLevelUp(): void { this.calls.push('st:levelUp'); }
  stingerWaveStart(): void { this.calls.push('st:wave'); }
  stingerBossIncoming(): void { this.calls.push('st:boss'); }
}

const frame = (p: Partial<RenderFrame> = {}): RenderFrame => ({
  time: 0, dt: 1 / 60, renderTick: 0, localPlayerId: 7, localShipId: 7, focusX: 0, focusY: 0, ships: [], enemies: [],
  projectiles: [], gems: [], deployables: [], events: [], you: null, match: match(), players: new Map(), aimX: 0, aimY: 0,
  attachCandidateId: 0, ...p,
});

describe('MusicDriver', () => {
  it('only scene changes reach the director; volume / mute settings; muted while the tab is hidden', () => {
    const sink = new FakeSink();
    const d = new MusicDriver(sink);
    const base = { result: null, match: match(), myPlayerId: 7, myTeam: 0, ffa: false } as const;
    for (let i = 0; i < 3; i++) d.updateScene({ ...base, screen: 'title' });
    d.updateScene({ ...base, screen: 'command' });
    d.updateScene({ ...base, screen: 'room' });
    d.updateScene({ ...base, screen: 'game' });
    d.updateScene({ ...base, screen: 'game', result: result({ winnerTeam: 0 }) });
    d.updateScene({ ...base, screen: 'room' });
    expect(sink.calls).toEqual(['scene:title', 'scene:command', 'scene:lobby', 'scene:match', 'scene:victory', 'scene:lobby']);
    sink.calls.length = 0;
    d.setSettings(0.6, false);
    d.setHidden(true);
    d.setHidden(false);
    d.setSettings(0.25, true);
    d.setHidden(false);
    expect(sink.calls).toEqual(['vol:0.6', 'mute:false', 'mute:true', 'mute:false', 'vol:0.25', 'mute:true', 'mute:true']);
  });

  it('frames: intensity smoothed toward the mapped target, sent at most every 100 ms; stingers fire', () => {
    const sink = new FakeSink();
    const d = new MusicDriver(sink);
    const swarm = Array.from({ length: 60 }, (_, i) => enemy(i + 1, i, 0));
    let now = 0;
    for (let i = 0; i < 60; i++) { d.onFrame(frame({ enemies: swarm }), now, 0, false); now += 1000 / 60; }
    const sends = sink.calls.filter((c) => c.startsWith('int:'));
    expect(sends.length).toBeGreaterThanOrEqual(9);
    expect(sends.length).toBeLessThanOrEqual(11);
    expect(d.currentIntensity).toBeGreaterThan(0.3);
    expect(d.currentIntensity).toBeLessThan(0.55); // one second in: still easing toward 0.55
    sink.calls.length = 0;
    d.onFrame(frame({ events: [{ t: 'levelUp', playerId: 7, level: 2 } as GameEvent, { t: 'bossIntro', id: 1, kind: 'matriarch', x: 0, y: 0 }] }), now, 0, false);
    expect(sink.calls.filter((c) => c.startsWith('st:'))).toEqual(['st:levelUp', 'st:boss']); // in event order
  });

  it('a throwing director never breaks the game', () => {
    const bad: MusicSink = new Proxy({} as MusicSink, { get: () => () => { throw new Error('no audio'); } });
    const d = new MusicDriver(bad);
    const err = console.error;
    console.error = () => {};
    try {
      expect(() => {
        d.unlock();
        d.setSettings(1, false);
        d.updateScene({ screen: 'title', result: null, match: null, myPlayerId: 1, myTeam: 0, ffa: false });
        d.onFrame(frame({ events: [{ t: 'waveStart', wave: 1, boss: false } as GameEvent] }), 0, 0, false);
      }).not.toThrow();
    } finally { console.error = err; }
  });
});
