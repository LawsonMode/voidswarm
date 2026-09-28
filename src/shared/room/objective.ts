// OWNER: ROOM agent. v0.3 M3 objective glue for the Room (docs/v0.3-proposal.md §5.7 "Room"): the objective result
// (fix #7: objective points only, never kill sums), PlayerScore.obj, the objective awards and the objective chat lines.
// Pure reads of World / ObjectiveState: nothing here mutates the sim or touches world.rng.
import { TICK_RATE } from '../constants';
import { SUB_MODES, isObjectiveSubMode } from '../data/gameTypes';
import { teamName } from '../data/teams';
import type { MatchResult, ObjectiveResult } from '../protocol';
import { HOT_WARN_SEC, ZONE_TIE_EXTEND_SEC, ZONE_TIE_EXTENSIONS } from '../sim/objectives/rules';
import { subModeOf } from '../sim/world';
import type {
  ObjectiveGameEvent, ObjectivePlayerStats, ObjectiveState, ObjectiveSubMode, PlayerId, TeamId, World,
} from '../types';

/** Every ObjectivePlayerStats field (the Record makes tsc flag contract drift). */
const STAT_TABLE: Record<keyof ObjectivePlayerStats, 0> = {
  caps: 0, steals: 0, returns: 0, carrierKills: 0, zoneCaps: 0, neutralizes: 0, objTicks: 0, hotHoldTicks: 0,
};
const STAT_KEYS = Object.keys(STAT_TABLE) as (keyof ObjectivePlayerStats)[];

/** Name lookup for chat / summaries: the Room's roster first, then the ship. null = unknown pilot. */
export type NameOf = (pid: PlayerId) => string | null;

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The objective sub-mode of this match: world.objective's, else the config's (null = deathmatch / dungeon). */
export function objectiveModeOf(world: World): ObjectiveSubMode | null {
  if (world.objective) return world.objective.mode;
  const s = subModeOf(world.config);
  return isObjectiveSubMode(s) ? s : null;
}

/**
 * Objective points per team (length = teamCount; [] in FFA): objective.teamPoints, else the sim's mirror in
 * match.teamScores. NEVER rebuilt from ship.score / kills (fix #7).
 */
export function objectiveTeamPoints(world: World): number[] {
  if (world.config.mode !== 'teams') return [];
  const n = Math.max(0, Math.min(8, world.config.teamCount | 0));
  const src: readonly number[] = world.objective?.teamPoints ?? world.match.teamScores;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = finite(src[i]);
  return out;
}

/** FFA hot point: [playerId, points] for points > 0, best first (ties: lower playerId first). */
export function objectivePlayerPoints(world: World): [PlayerId, number][] {
  const pts = world.objective?.playerPoints;
  if (!pts || !pts.size) return [];
  const out: [PlayerId, number][] = [];
  for (const [pid, v] of pts) if (finite(v) > 0) out.push([pid, v]);
  out.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return out;
}

/** PlayerScore.obj: the pilot's non-zero objective stats (keyed by playerId, so a rejoin keeps them), or undefined. */
export function objStatsOf(world: World, pid: PlayerId): Partial<ObjectivePlayerStats> | undefined {
  const st = world.objective?.stats?.get(pid);
  if (!st) return undefined;
  let out: Partial<ObjectivePlayerStats> | undefined;
  for (const k of STAT_KEYS) {
    const v = finite(st[k]);
    if (v !== 0) (out ??= {})[k] = v;
  }
  return out;
}

/** Index of the unique maximum, -1 on a tie (or an empty list). */
function uniqueBest(vals: readonly number[]): number {
  let best = -1, tie = false;
  for (let i = 0; i < vals.length; i++) {
    if (best < 0 || vals[i] > vals[best]) { best = i; tie = false; } else if (vals[i] === vals[best]) tie = true;
  }
  return tie ? -1 : best;
}

/**
 * Winner of an objective match. When the sim ended it (objectiveEndCheck: target, time-out, overtime, sudden death and
 * its tie-breaks or draw) its verdict stands. An early /end (the match is still 'playing') goes by objective points
 * (FFA hot point: playerPoints); a tie is a draw (§5.7).
 */
export function objectiveWinner(
  world: World, teamPoints: readonly number[], playerPoints: readonly [PlayerId, number][],
): { winnerTeam: TeamId; winnerPlayerId: PlayerId } {
  const m = world.match;
  if (m.phase === 'ended') return { winnerTeam: m.winnerTeam, winnerPlayerId: m.winnerPlayerId };
  if (world.config.mode === 'teams') return { winnerTeam: uniqueBest(teamPoints), winnerPlayerId: 0 };
  const top = playerPoints[0];
  if (!top || (playerPoints.length > 1 && playerPoints[1][1] === top[1])) return { winnerTeam: -1, winnerPlayerId: 0 };
  return { winnerTeam: -1, winnerPlayerId: top[0] };
}

/** Unit of a sub-mode's score ("captures" / "points"). */
function unitOf(mode: ObjectiveSubMode): string {
  return SUB_MODES[mode].limitLabel || 'points';
}

/** "Crimson 3 – 1 Azure (captures)", "Crimson 212 · Azure 187 · Verdant 90 (points, overtime)", "Kestrel 120 · Vex 88 (points)". */
export function objectiveSummary(
  world: World, mode: ObjectiveSubMode, teamPoints: readonly number[], playerPoints: readonly [PlayerId, number][],
  nameOf: NameOf,
): string {
  const o = world.objective;
  const tags = [unitOf(mode)];
  if (o?.suddenDeath) tags.push('sudden death');
  else if (o && (o.overtime || o.extensions > 0)) tags.push('overtime');
  const tail = ` (${tags.join(', ')})`;
  if (world.config.mode === 'teams') {
    if (!teamPoints.length) return `No score${tail}`;
    const order = teamPoints.map((v, t) => [t, Math.round(v)] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (order.length === 2) return `${teamName(order[0][0])} ${order[0][1]} – ${order[1][1]} ${teamName(order[1][0])}${tail}`;
    return order.map(([t, v]) => `${teamName(t)} ${v}`).join(' · ') + tail;
  }
  if (!playerPoints.length) return `No points scored${tail}`;
  return playerPoints.slice(0, 3).map(([pid, v]) => `${nameOf(pid) ?? 'Pilot'} ${Math.round(v)}`).join(' · ') + tail;
}

/** MatchResult.objective (objective sub-modes only; undefined otherwise). */
export function buildObjectiveResult(world: World, nameOf: NameOf): ObjectiveResult | undefined {
  const mode = objectiveModeOf(world);
  if (!mode) return undefined;
  const teamPoints = objectiveTeamPoints(world);
  const playerPoints = world.config.mode === 'teams' ? [] : objectivePlayerPoints(world);
  const res: ObjectiveResult = { mode, teamPoints, summary: objectiveSummary(world, mode, teamPoints, playerPoints, nameOf) };
  if (world.config.mode !== 'teams') res.playerPoints = playerPoints;
  return res;
}

/**
 * Seconds a pilot "worked" a zone / the hot point. objTicks counts sim ticks inside an active zone (OBJECTIVES credits
 * +1 personal score every ZONE_SCORE.workTickSec of them), like hotHoldTicks.
 */
export function objWorkSec(objTicks: number): number {
  return Math.round(finite(objTicks) / TICK_RATE);
}

/**
 * The objective awards, in §5.7 order (the Room puts them first, max 5 awards in all):
 * CTF — Flag Runner (caps), Goalkeeper (returns), Carrier Killer; Zones / Hot — Anchor (objTicks), Point Breaker
 * (captures + neutralizes), King of the Hill (hot hold seconds, hot point only). `pids` = the pilots eligible (the
 * result's score rows, best first: ties go to the higher scorer).
 */
export function objectiveAwards(world: World, pids: readonly PlayerId[]): MatchResult['awards'] {
  const o = world.objective;
  if (!o || !o.stats || !o.stats.size) return [];
  const out: MatchResult['awards'] = [];
  const best = (val: (s: ObjectivePlayerStats) => number): [PlayerId, ObjectivePlayerStats, number] | null => {
    let b: [PlayerId, ObjectivePlayerStats, number] | null = null;
    for (const pid of pids) {
      const st = o.stats.get(pid);
      if (!st) continue;
      const v = val(st);
      if (Number.isFinite(v) && v > 0 && (!b || v > b[2])) b = [pid, st, v];
    }
    return b;
  };
  const add = (title: string, hit: [PlayerId, ObjectivePlayerStats, number] | null, value: (s: ObjectivePlayerStats, v: number) => string): void => {
    if (hit) out.push({ title, playerId: hit[0], value: value(hit[1], hit[2]) });
  };
  if (o.mode === 'ctf') {
    add('Flag Runner', best((s) => finite(s.caps)), (_s, v) => plural(v, 'capture'));
    add('Goalkeeper', best((s) => finite(s.returns)), (_s, v) => plural(v, 'flag return'));
    add('Carrier Killer', best((s) => finite(s.carrierKills)), (_s, v) => plural(v, 'carrier kill'));
  } else if (o.mode === 'zones' || o.mode === 'hotpoint') {
    const where = o.mode === 'hotpoint' ? 'the point' : 'the zones';
    add('Anchor', best((s) => finite(s.objTicks)), (_s, v) => `${objWorkSec(v)} s working ${where}`);
    add('Point Breaker', best((s) => finite(s.zoneCaps) + finite(s.neutralizes)), (s) => {
      const parts: string[] = [];
      if (finite(s.zoneCaps) > 0) parts.push(plural(finite(s.zoneCaps), 'capture'));
      if (finite(s.neutralizes) > 0) parts.push(`${finite(s.neutralizes)} neutralized`);
      return parts.join(' + ');
    });
    if (o.mode === 'hotpoint') {
      const k = best((s) => finite(s.hotHoldTicks));
      if (k && k[2] >= TICK_RATE) add('King of the Hill', k, (_s, v) => `${Math.round(v / TICK_RATE)} s holding the point`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Objective chat lines (§5.7): flag taken / dropped / returned / captured, zone and hot point captures, the hot point
// moving, overtime and sudden death. Teams, flags and counts are read from the post-step ObjectiveState (the event's
// own team / value fields are only a fallback), so a line always matches what the HUD shows.
// ---------------------------------------------------------------------------------------------

/** Per-flag gap for "took" / "dropped" lines (a scramble around a stand must not flood chat). */
export const FLAG_NOTE_GAP_SEC = 5;
/** Zone flips (and hot point captures) are rate-limited to one line per this long (§5.7). */
export const ZONE_NOTE_GAP_SEC = 5;

/** "the Core" / "Zone A".."Zone D" (zone feature index 0 = Core). */
export function zoneLabel(index: number): string {
  if (index <= 0) return 'the Core';
  return `Zone ${String.fromCharCode(64 + Math.min(26, index))}`;
}

/** Compass phrase for a map position: "to the centre" or "north-east" (y grows southward). */
export function compassPhrase(world: World, x: number, y: number): string {
  const w = world.map.width || 1, h = world.map.height || 1;
  const dx = x - w / 2, dy = y - h / 2;
  if (Math.hypot(dx, dy) < Math.min(w, h) * 0.12) return 'to the centre';
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  let a = Math.atan2(dy, dx);
  if (a < 0) a += Math.PI * 2;
  return dirs[Math.round(a / (Math.PI / 4)) % 8];
}

function hotSitePos(world: World, site: number): { x: number; y: number } | null {
  for (const f of world.map.features ?? []) if (f.kind === 'hotSite' && f.index === site) return { x: f.x, y: f.y };
  return null;
}

function teamOfPlayer(world: World, pid: PlayerId): TeamId | null {
  if (!pid) return null;
  const sid = world.shipsByPlayer.get(pid);
  const s = sid ? world.ships.get(sid) : undefined;
  return s ? s.team : null;
}

/** The flag an event is about: flag events carry the flag's team in `index` (the actor's team is `team`). */
function flagTeamOf(o: ObjectiveState | null | undefined, ev: ObjectiveGameEvent): TeamId {
  if (o && o.flags.some((f) => f.team === ev.index)) return ev.index;
  return ev.index >= 0 ? ev.index : ev.team;
}

/** Rate-limited objective chat lines for one match (reset() at each match start). */
export class ObjectiveAnnouncer {
  private last = new Map<string, number>();

  reset(): void { this.last.clear(); }

  /** At most one line per `key` per `gapSec` (world ticks). */
  private gate(key: string, tick: number, gapSec: number): boolean {
    const t = this.last.get(key);
    if (t !== undefined && tick - t < gapSec * TICK_RATE) return false;
    this.last.set(key, tick);
    return true;
  }

  /** The system chat line for one objective event, or null (not announced, or rate-limited). */
  line(world: World, ev: ObjectiveGameEvent, nameOf: NameOf): string | null {
    const o = world.objective;
    const tick = world.tick;
    const actor = ev.playerId ? nameOf(ev.playerId) : null;
    const actorTeam = teamOfPlayer(world, ev.playerId);
    switch (ev.kind) {
      case 'flagTaken': {
        const ft = flagTeamOf(o, ev);
        if (!this.gate(`ft:${ft}`, tick, FLAG_NOTE_GAP_SEC)) return null;
        return actor ? `${actor} took ${teamName(ft)}'s flag!` : `${teamName(ft)}'s flag was taken!`;
      }
      case 'flagDropped': {
        const ft = flagTeamOf(o, ev);
        if (!this.gate(`fd:${ft}`, tick, FLAG_NOTE_GAP_SEC)) return null;
        return actor ? `${actor} dropped ${teamName(ft)}'s flag!` : `${teamName(ft)}'s flag is down!`;
      }
      case 'flagReturned': {
        const ft = flagTeamOf(o, ev);
        if (!this.gate(`fr:${ft}`, tick, 1)) return null;
        return actor ? `${actor} returned ${teamName(ft)}'s flag.` : `${teamName(ft)}'s flag returned home.`;
      }
      case 'flagCaptured': {
        const ft = flagTeamOf(o, ev);
        let cap = actorTeam ?? -1;
        if (cap < 0 && ev.team >= 0 && ev.team !== ft) cap = ev.team;
        const score = o && cap >= 0 && cap < o.teamPoints.length ? `${Math.round(finite(o.teamPoints[cap]))}/${o.limit}` : '';
        const who = cap >= 0 ? teamName(cap) : (actor ?? 'Someone');
        return `${who} captured ${teamName(ft)}'s flag!${score ? ` ${score}` : ''}${actor && cap >= 0 ? ` (${actor})` : ''}`;
      }
      case 'zoneCaptured': {
        if (!this.gate('zone', tick, ZONE_NOTE_GAP_SEC)) return null;
        const z = o?.zones.find((q) => q.index === ev.index) ?? o?.zones[0];
        if (o?.mode === 'hotpoint') {
          if (world.config.mode !== 'teams') {
            const who = actor ?? (z && z.ownerPlayerId ? nameOf(z.ownerPlayerId) : null);
            return `${who ?? 'Someone'} took the Hot Point!`;
          }
          const team = z && z.owner >= 0 ? z.owner : (actorTeam ?? ev.team);
          return `${teamName(team)} took the Hot Point!`;
        }
        const team = z && z.owner >= 0 ? z.owner : (actorTeam ?? ev.team);
        return `${teamName(team)} captured ${zoneLabel(ev.index)}!`;
      }
      case 'hotWarn': {
        const h = o?.hot;
        const pos = h ? hotSitePos(world, h.nextSite) : null;
        const where = pos ? compassPhrase(world, pos.x, pos.y) : (ev.x || ev.y ? compassPhrase(world, ev.x, ev.y) : 'soon');
        const left = h && h.moveTick > tick ? Math.ceil((h.moveTick - tick) / TICK_RATE) : HOT_WARN_SEC;
        return where === 'soon' ? `The Hot Point moves in ${left} s.` : `The Hot Point moves ${where} in ${left} s.`;
      }
      case 'overtime': {
        if (!this.gate('ot', tick, 5)) return null;
        if (o?.mode === 'hotpoint') return 'Overtime! The Hot Point is still in play.';
        if (o?.mode === 'zones') {
          const n = Math.max(1, Math.min(ZONE_TIE_EXTENSIONS, o.extensions | 0));
          return `Tied! Overtime ${n}/${ZONE_TIE_EXTENSIONS}: +${ZONE_TIE_EXTEND_SEC} s.`;
        }
        return 'Overtime!';
      }
      case 'suddenDeath':
        if (!this.gate('sd', tick, 5)) return null;
        return 'Sudden death! The next capture wins.';
      // zoneNeutralized / hotMoved: HUD banners only (the hot warning already named the next site).
      default:
        return null;
    }
  }
}
