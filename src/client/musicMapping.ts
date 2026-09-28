// OWNER: CLIENT (v0.3 M4 integration). Pure mapping from game state to the MusicDirector's inputs
// (audio/music/director.ts): which scene plays, how intense the match music is, and which stingers fire.
// No DOM, no audio: main.ts feeds it and hands the results to the director (musicDriver.ts), and
// musicMapping.test.ts pins every rule.
//
// Scenes: 'title' on the Title screen, 'command' on Command, 'lobby' in a room lobby, 'match' in a running match,
// 'boss' on a Dungeon Runner floor while its boss is alive (RiftView.boss non-null), 'victory' / 'defeat' while the
// results overlay shows (your team / party won or not; FFA: a top-3 finish is a victory), then back to 'lobby'.
import type { MusicScene } from './audio/music/format';
import type { MatchResult } from '../shared/protocol';
import type { EnemyView, GameEvent, MatchView, PlayerId, ShipView, TeamId, YouState } from '../shared/types';

export type MusicScreen = 'title' | 'command' | 'room' | 'game';

export interface MusicSceneInput {
  screen: MusicScreen;
  /** The result being shown (results overlay visible), else null. */
  result: MatchResult | null;
  /** The running match's view (latest snapshot), for the rift boss. */
  match: MatchView | null | undefined;
  myPlayerId: PlayerId;
  /** My team in the match (PlayerInfo.team); negative = spectating / unassigned. */
  myTeam: TeamId;
  /** Free-for-all match (client.mode). */
  ffa: boolean;
}

/**
 * Did the viewer win this result? Teams (the rift's party included): my team is the winner. FFA: a top-3 finish (by
 * objective points in an FFA Hot Point, else by score — the Room's crate rule). A spectator: any winner (no draw).
 */
export function resultWon(r: MatchResult, myPlayerId: PlayerId, myTeam: TeamId, ffa: boolean): boolean {
  if (!ffa) return r.winnerTeam >= 0 && (myTeam < 0 || myTeam === r.winnerTeam);
  const pts = r.objective?.playerPoints;
  const order = pts && pts.length ? pts.map(([pid]) => pid)
    : [...(Array.isArray(r.scores) ? r.scores : [])].sort((a, b) => b.score - a.score).map((s) => s.playerId);
  if (!order.includes(myPlayerId)) return r.winnerPlayerId > 0;
  return order.slice(0, 3).includes(myPlayerId);
}

/** The scene for the current screen / state. */
export function musicSceneFor(i: MusicSceneInput): MusicScene {
  switch (i.screen) {
    case 'title': return 'title';
    case 'command': return 'command';
    case 'room': return 'lobby';
    case 'game':
      if (i.result) return resultWon(i.result, i.myPlayerId, i.myTeam, i.ffa) ? 'victory' : 'defeat';
      if (i.match?.dungeon?.boss) return 'boss';
      return 'match';
  }
  return 'command';
}

export interface MusicIntensityInput {
  match: MatchView | null | undefined;
  you: YouState | null | undefined;
  /** Camera focus (own ship or spectate target). */
  focusX: number;
  focusY: number;
  enemies: readonly EnemyView[];
  ships: readonly ShipView[];
  /** The viewer's team (hostile = another team; FFA: everyone else). */
  myTeam: TeamId;
  myShipId: number;
  ffa: boolean;
}

/** Tuning (sum of the parts is clamped to 1). */
export const MUSIC_INTENSITY = {
  base: 0.3,
  /** + up to this from the swarm wave (Arena / Warzone) or the rift floor. */
  tierMax: 0.2,
  /** Enemies within this radius (px) of the focus count; + up to enemiesMax at enemiesFull of them. */
  enemyR: 700, enemiesFull: 30, enemiesMax: 0.25,
  /** Hostile ships within this radius; + hostileEach per ship, up to hostilesMax. */
  hostileR: 900, hostileEach: 0.06, hostilesMax: 0.18,
  /** Own energy below lowEnergyFrac adds up to lowEnergyMax. */
  lowEnergyFrac: 0.35, lowEnergyMax: 0.15,
  /** Objective overtime / sudden death. */
  overtime: 0.15,
  /** A boss alive (rift boss, or a Hive in view). */
  boss: 0.2,
} as const;

/** Raw (unsmoothed) 0..1 match intensity from what the viewer sees. */
export function musicIntensityFor(i: MusicIntensityInput): number {
  const K = MUSIC_INTENSITY;
  let v = K.base;
  const m = i.match;
  if (m?.dungeon) {
    const total = Math.max(1, m.dungeon.floorsTotal || 1);
    v += K.tierMax * Math.min(1, Math.max(0, (m.dungeon.floor - 1) / Math.max(1, total - 1)));
  } else if (m && m.wave > 0) {
    v += Math.min(K.tierMax, m.wave * 0.02);
  }
  const er2 = K.enemyR * K.enemyR;
  let near = 0, hive = false;
  for (const e of i.enemies) {
    const dx = e.x - i.focusX, dy = e.y - i.focusY;
    if (dx * dx + dy * dy <= er2) { near++; if (e.kind === 'hive' || e.kind === 'matriarch') hive = true; }
  }
  v += K.enemiesMax * Math.min(1, near / K.enemiesFull);
  const hr2 = K.hostileR * K.hostileR;
  let hostile = 0;
  for (const s of i.ships) {
    if (!s.alive || s.id === i.myShipId) continue;
    if (!i.ffa && (i.myTeam < 0 || s.team === i.myTeam)) continue;
    const dx = s.x - i.focusX, dy = s.y - i.focusY;
    if (dx * dx + dy * dy <= hr2) hostile++;
  }
  v += Math.min(K.hostilesMax, hostile * K.hostileEach);
  const you = i.you;
  if (you && you.alive && you.stats && you.stats.maxEnergy > 0) {
    const f = Math.max(0, you.energy) / you.stats.maxEnergy;
    if (f < K.lowEnergyFrac) v += K.lowEnergyMax * (1 - f / K.lowEnergyFrac);
  }
  if (m?.objective && (m.objective.overtime || m.objective.suddenDeath)) v += K.overtime;
  if (m?.dungeon?.boss || hive) v += K.boss;
  return Math.max(0, Math.min(1, v));
}

/** Exponential smoothing toward `target` with time constant `tauSec` (frame-rate independent). */
export function smoothToward(prev: number, target: number, dtSec: number, tauSec = 1.5): number {
  if (!(dtSec > 0)) return prev;
  const k = 1 - Math.exp(-dtSec / Math.max(1e-3, tauSec));
  return Math.max(0, Math.min(1, prev + (target - prev) * k));
}

export type MusicStinger = 'waveStart' | 'bossIncoming' | 'levelUp';

/**
 * Stingers for a frame's events: 'waveStart' (non-boss) → waveStart; waveStart {boss: true} and the rift's
 * 'bossIntro' → bossIncoming; your own 'levelUp' → levelUp. Each kind at most once per frame.
 */
export function musicStingersFor(events: readonly GameEvent[], myPlayerId: PlayerId): MusicStinger[] {
  const out: MusicStinger[] = [];
  const add = (s: MusicStinger): void => { if (!out.includes(s)) out.push(s); };
  for (const e of events) {
    if (e.t === 'waveStart') add(e.boss ? 'bossIncoming' : 'waveStart');
    else if (e.t === 'bossIntro') add('bossIncoming');
    else if (e.t === 'levelUp' && myPlayerId && e.playerId === myPlayerId) add('levelUp');
  }
  return out;
}
