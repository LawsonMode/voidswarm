// Pure (DOM-free) presentation logic for the v0.3 objective sub-modes (CTF / Control Zones / Hot Point): the HUD's
// top-centre objective strip, the centre capture bar, objective banners, and the Tab scoreboard / results columns.
// docs/v0.3-proposal.md §5.3–§5.5 and §5.7. `ObjectiveView` (types.ts) is the wire shape; geometry is map.features.
//
// Event fields: an `objective` event's `team` / `playerId` / `index` are read defensively. `index` is the flag's
// team for flag events (flag stand index = team) and the zone / site index otherwise; the acting pilot's team comes
// from PlayerInfo (falling back to `team`). "Zone lost" needs the previous owner, which the HUD tracks from views.
import { NO_TEAM, TICK_RATE } from '../../shared/constants';
import { isObjectiveSubMode, SUB_MODES } from '../../shared/data/gameTypes';
import { colorFor, hexToCss, TEAM_COLORS, teamName } from '../../shared/data/teams';
import type { PlayerScore } from '../../shared/protocol';
import {
  CTF_OVERLOAD_FULL_SEC, CTF_OVERLOAD_SEC, HOT_ARM_SEC, HOT_WARN_SEC, ZONE_TIE_EXTEND_SEC,
} from '../../shared/sim/objectives/rules';
import type {
  EntityId, GameMode, MapFeature, MatchView, ObjectiveGameEvent, ObjectiveSubMode, ObjectiveView, PlayerId, SubMode, TeamId,
} from '../../shared/types';
import { countLabel, fmtMinSec } from './gameTypeInfo';

// ------------------------------------------------------------------ context + colours

/** What the objective HUD needs to know about the viewer and the players (lambdas keep it testable). */
export interface ObjCtx {
  /** Allegiance of the running match. */
  mode: GameMode;
  /** The viewer's team (NO_TEAM in FFA, -2 spectating). */
  myTeam: TeamId;
  myPid: PlayerId;
  myShipId: EntityId;
  name(pid: PlayerId): string;
  /** Ship id → playerId (0 = not visible / unknown). */
  shipPlayer(id: EntityId): PlayerId;
  /** PlayerInfo team (undefined = unknown pilot). */
  teamOf(pid: PlayerId): TeamId | undefined;
}

export const NEUTRAL_CSS = '#9aa4c7';

export function teamCssOf(team: TeamId): string {
  return team >= 0 ? hexToCss(TEAM_COLORS[team % TEAM_COLORS.length]) : NEUTRAL_CSS;
}

/** Colour of a side: a team, or (FFA) a pilot; neutral grey when neither. */
export function sideCss(team: TeamId, pid: PlayerId): string {
  if (team >= 0) return teamCssOf(team);
  if (pid) return hexToCss(colorFor(NO_TEAM, pid));
  return NEUTRAL_CSS;
}

/** Whether the viewer's side is (team, pid): their team in team modes, themselves in FFA. */
export function isMySide(ctx: Pick<ObjCtx, 'mode' | 'myTeam' | 'myPid'>, team: TeamId, pid: PlayerId): boolean {
  if (ctx.mode === 'ffa') return !!pid && pid === ctx.myPid;
  return team >= 0 && team === ctx.myTeam;
}

function hasSide(ctx: Pick<ObjCtx, 'mode'>, team: TeamId, pid: PlayerId): boolean {
  return ctx.mode === 'ffa' ? !!pid : team >= 0;
}

function sideName(ctx: ObjCtx, team: TeamId, pid: PlayerId): string {
  if (ctx.mode === 'ffa') return pid ? ctx.name(pid) : '';
  return team >= 0 ? teamName(team) : '';
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** m:ss, rounded up (countdowns). */
export function fmtSec(sec: number): string {
  return fmtMinSec(Math.max(0, sec));
}

/**
 * Objective time from a tick count (Zones objTicks / Hot hotHoldTicks), m:ss rounded to the nearest second — the
 * same rounding room/objective.ts uses for the Anchor / King of the Hill awards, so the column and award agree.
 */
export function fmtObjTime(ticks: number | undefined): string {
  const t = typeof ticks === 'number' && Number.isFinite(ticks) ? Math.max(0, ticks) : 0;
  return fmtMinSec(Math.round(t / TICK_RATE), false);
}

// ------------------------------------------------------------------ which strip

/** The HUD's top-centre strip shows the objective (not the classic clock + wave) when the match has one. */
export function hudShowsObjective(m: Pick<MatchView, 'objective' | 'dungeon'> | null | undefined): boolean {
  return !!m && !!m.objective && !m.dungeon && isObjectiveSubMode(m.objective.mode);
}

export interface ClockModel { text: string; low: boolean; badge: string }

/** Clock + the overtime / sudden death badge (the clock is hidden once an overtime runs past 0). */
export function clockModel(m: Pick<MatchView, 'timed' | 'timeLeftSec'>, view: Pick<ObjectiveView, 'overtime' | 'suddenDeath'>): ClockModel {
  const badge = view.suddenDeath ? 'SUDDEN DEATH' : view.overtime ? 'OVERTIME' : '';
  const timed = m.timed !== false;
  const left = Math.max(0, m.timeLeftSec || 0);
  const text = !timed || (badge && left <= 0) ? '' : fmtSec(left);
  return { text, low: timed && !badge && left <= 30, badge };
}

// ------------------------------------------------------------------ CTF

export type FlagStateName = 'home' | 'carried' | 'dropped';

export interface FlagChipModel {
  team: TeamId;
  name: string;
  color: string;
  /** This team's captures (mirrored team score). */
  caps: number;
  state: FlagStateName;
  /** Carrier name ('' when the carrier isn't visible). */
  carrier: string;
  carrierColor: string;
  carrierIsMe: boolean;
  /** Dropped: seconds until the auto-return. */
  returnIn: number;
  /** The viewer's own team's flag. */
  mine: boolean;
  /** Status text: HOME / carrier name / YOU / DOWN 0:14. */
  status: string;
}

export interface CtfModel { limit: number; flags: FlagChipModel[] }

const FLAG_STATES: readonly FlagStateName[] = ['home', 'carried', 'dropped'];

export function ctfModel(view: ObjectiveView, teamScores: readonly number[], ctx: ObjCtx): CtfModel {
  const flags = (view.flags ?? []).slice().sort((a, b) => a.team - b.team).map((f): FlagChipModel => {
    const state = FLAG_STATES[f.s] ?? 'home';
    const carrierPid = state === 'carried' && f.carrierId ? ctx.shipPlayer(f.carrierId) : 0;
    const carrierIsMe = state === 'carried' && ((!!ctx.myShipId && f.carrierId === ctx.myShipId) || (!!carrierPid && carrierPid === ctx.myPid));
    const carrier = carrierPid ? ctx.name(carrierPid) : '';
    const carrierTeam = carrierPid ? ctx.teamOf(carrierPid) ?? -1 : -1;
    const status = state === 'home' ? 'HOME'
      : state === 'carried' ? (carrierIsMe ? 'YOU' : carrier || 'TAKEN')
        : `DOWN ${fmtSec(f.returnIn)}`;
    return {
      team: f.team, name: teamName(f.team), color: teamCssOf(f.team), caps: Math.round(teamScores[f.team] ?? 0),
      state, carrier, carrierColor: carrierTeam >= 0 ? teamCssOf(carrierTeam) : NEUTRAL_CSS, carrierIsMe,
      returnIn: Math.max(0, f.returnIn || 0), mine: ctx.mode === 'teams' && f.team === ctx.myTeam, status,
    };
  });
  return { limit: view.limit, flags };
}

/** The enemy flag the viewer carries (per the view), or null. */
export function carriedFlag(view: ObjectiveView | undefined, myShipId: EntityId): { team: TeamId } | null {
  if (!view?.flags || !myShipId) return null;
  const f = view.flags.find((x) => x.s === 1 && x.carrierId === myShipId);
  return f ? { team: f.team } : null;
}

export interface OverloadModel { level: 0 | 1 | 2; text: string }

/** Flag Overload (§5.3): recharge ×0.5 after CTF_OVERLOAD_SEC of continuous carry, ×0 after CTF_OVERLOAD_FULL_SEC. */
export function overloadModel(carrySec: number): OverloadModel {
  const t = Math.max(0, carrySec);
  if (t < CTF_OVERLOAD_SEC) return { level: 0, text: `OVERLOAD IN ${fmtSec(CTF_OVERLOAD_SEC - t)}` };
  if (t < CTF_OVERLOAD_FULL_SEC) return { level: 1, text: `OVERLOAD · RECHARGE ½ · ${fmtSec(CTF_OVERLOAD_FULL_SEC - t)}` };
  return { level: 2, text: 'OVERLOADED · NO RECHARGE' };
}

/** A carrier at their stand while their own flag is away gets told why nothing happens. */
export function ctfHint(view: ObjectiveView | undefined, features: readonly MapFeature[] | undefined, x: number, y: number, ctx: ObjCtx): string {
  if (!view?.flags || ctx.mode !== 'teams' || ctx.myTeam < 0) return '';
  if (!carriedFlag(view, ctx.myShipId)) return '';
  const own = view.flags.find((f) => f.team === ctx.myTeam);
  if (!own || own.s === 0) return '';
  const stand = features?.find((f) => f.kind === 'flagStand' && f.index === ctx.myTeam);
  if (!stand) return '';
  const r = Math.max(stand.radius, 90) * 2.2;
  const dx = stand.x - x, dy = stand.y - y;
  if (dx * dx + dy * dy > r * r) return '';
  return own.s === 1 ? 'YOUR FLAG IS AWAY — RECOVER IT TO SCORE' : 'YOUR FLAG IS DOWN — RETURN IT TO SCORE';
}

// ------------------------------------------------------------------ Zones

const LETTERS = 'ABCDEFGH';

/** Zone chip glyph: the Core is ◆, flanks are A–D. */
export function zoneGlyph(i: number): string {
  return i === 0 ? '◆' : LETTERS[i - 1] ?? String(i);
}

/** "Core" / "Zone A". */
export function zoneName(i: number): string {
  return i === 0 ? 'Core' : `Zone ${LETTERS[i - 1] ?? i}`;
}

export interface ZoneChipModel {
  i: number;
  glyph: string;
  name: string;
  owner: TeamId;
  ownerColor: string;
  /** Capper colour (neutral when nobody is capping). */
  capColor: string;
  /** Capture / decap progress 0..1. */
  p: number;
  contested: boolean;
  swarm: boolean;
  active: boolean;
  /** Has an owner (a team, or a pilot in FFA). */
  owned: boolean;
  /** Owned by the viewer's side. */
  mine: boolean;
  /** Owned by the viewer's side and under pressure (contested or being decapped). */
  threat: boolean;
}

export function zoneChips(view: ObjectiveView, ctx: ObjCtx): ZoneChipModel[] {
  return (view.zones ?? []).slice().sort((a, b) => a.i - b.i).map((z) => {
    const mine = isMySide(ctx, z.owner, z.ownerPid);
    const owned = hasSide(ctx, z.owner, z.ownerPid);
    const p = clamp01(z.p / 100);
    const capping = hasSide(ctx, z.cap, z.capPid) && p > 0;
    return {
      i: z.i, glyph: zoneGlyph(z.i), name: zoneName(z.i), owned,
      owner: z.owner, ownerColor: owned ? sideCss(z.owner, z.ownerPid) : NEUTRAL_CSS,
      capColor: capping ? sideCss(z.cap, z.capPid) : NEUTRAL_CSS, p: capping ? p : 0,
      contested: !!z.contested, swarm: !!z.swarm, active: z.active !== false,
      mine, threat: mine && (!!z.contested || (capping && !isMySide(ctx, z.cap, z.capPid))),
    };
  });
}

export interface SideScore { key: string; name: string; color: string; value: number; mine: boolean; lead: boolean }

/** Team points (objective points / captures), in team order; the leader(s) flagged. */
export function teamPointRows(teamScores: readonly number[], teamCount: number, ctx: Pick<ObjCtx, 'myTeam'>): SideScore[] {
  const n = Math.max(teamCount, teamScores.length);
  const rows: SideScore[] = [];
  let best = 0;
  for (let t = 0; t < n; t++) best = Math.max(best, Math.round(teamScores[t] ?? 0));
  for (let t = 0; t < n; t++) {
    const value = Math.round(teamScores[t] ?? 0);
    rows.push({ key: `t${t}`, name: teamName(t), color: teamCssOf(t), value, mine: t === ctx.myTeam, lead: best > 0 && value === best });
  }
  return rows;
}

/** FFA Hot Point: the top `n` by points (ties: lower playerId), plus the viewer when outside the top. */
export function ffaTop(points: readonly [PlayerId, number][] | undefined, ctx: Pick<ObjCtx, 'myPid' | 'name'>, n = 3): SideScore[] {
  const list = (points ?? []).filter(([pid, v]) => pid > 0 && Number.isFinite(v))
    .slice().sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const best = list.length ? Math.round(list[0][1]) : 0;
  const row = ([pid, v]: [PlayerId, number], rank: number): SideScore => ({
    key: `p${pid}`, name: `${rank}. ${ctx.name(pid)}`, color: sideCss(NO_TEAM, pid), value: Math.round(v),
    mine: pid === ctx.myPid, lead: best > 0 && Math.round(v) === best,
  });
  const out = list.slice(0, n).map((e, i) => row(e, i + 1));
  const at = list.findIndex(([pid]) => pid === ctx.myPid);
  if (ctx.myPid && at >= n) out.push(row(list[at], at + 1));
  return out;
}

// ------------------------------------------------------------------ Hot Point

/** 8-way arrow for a screen direction (y grows downward). */
export function dirArrow(dx: number, dy: number): string {
  if (!dx && !dy) return '•';
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const a = Math.atan2(dy, dx);
  const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return arrows[k];
}

/** "850" px, or "2.1k". */
export function fmtDist(px: number): string {
  const d = Math.max(0, Math.round(px));
  return d < 1000 ? String(d) : `${(d / 1000).toFixed(1)}k`;
}

export interface HotModel {
  site: number;
  ownerName: string;
  ownerColor: string;
  owned: boolean;
  mine: boolean;
  /** Capture progress 0..1 (by capColor). */
  p: number;
  capColor: string;
  contested: boolean;
  moveIn: number;
  armIn: number;
  /** MOVES IN 0:42 · MOVING 0:08 · ARMING 0:02 · FINAL POINT · HOLD IT (overtime). */
  timer: string;
  /** ≤ HOT_WARN_SEC before a move (the next site is known). */
  warn: boolean;
  /** Where the next site is from the viewer ("NEXT ↗ 2.1k"), when known. */
  next: string;
  /** No more moves: overtime (relocation paused), or the move would land at / after the time-out. */
  final: boolean;
}

/**
 * `clock` (the match's timed / timeLeftSec) lets the strip tell that no move is coming: the sim never relocates
 * during overtime, nor when the next move would land at or after the time-out (every selectable length is a
 * multiple of the 60 s move period), yet the wire moveIn keeps counting down to 0 in both cases.
 */
export function hotModel(
  view: ObjectiveView, ctx: ObjCtx, features: readonly MapFeature[] | undefined, pos: { x: number; y: number } | null,
  clock?: Pick<MatchView, 'timed' | 'timeLeftSec'>,
): HotModel | null {
  const hot = view.hot;
  if (!hot) return null;
  const z = view.zones?.[0];
  const owner = z?.owner ?? -1, ownerPid = z?.ownerPid ?? 0;
  const owned = !!z && hasSide(ctx, owner, ownerPid);
  const p = z ? clamp01(z.p / 100) : 0;
  const capping = !!z && hasSide(ctx, z.cap, z.capPid) && p > 0;
  const armIn = Math.max(0, hot.armIn || 0), moveIn = Math.max(0, hot.moveIn || 0);
  const left = clock && clock.timed !== false && Number.isFinite(clock.timeLeftSec) ? clock.timeLeftSec : Infinity;
  const lastPoint = !view.overtime && left > 0 && moveIn >= left - 0.5 && hot.next < 0;
  const final = !!view.overtime || lastPoint;
  const warn = !final && moveIn > 0 && moveIn <= HOT_WARN_SEC;
  const timer = armIn > 0 ? `ARMING ${fmtSec(armIn)}`
    : view.overtime ? 'HOLD IT'
      : lastPoint ? 'FINAL POINT'
        : warn ? `MOVING ${fmtSec(moveIn)}` : `MOVES IN ${fmtSec(moveIn)}`;
  let next = '';
  if (warn && hot.next >= 0 && pos) {
    const f = features?.find((x) => x.kind === 'hotSite' && x.index === hot.next);
    if (f) next = `NEXT ${dirArrow(f.x - pos.x, f.y - pos.y)} ${fmtDist(Math.hypot(f.x - pos.x, f.y - pos.y))}`;
  }
  return {
    site: hot.site,
    ownerName: owned ? sideName(ctx, owner, ownerPid) : 'NEUTRAL',
    ownerColor: owned ? sideCss(owner, ownerPid) : NEUTRAL_CSS,
    owned, mine: owned && isMySide(ctx, owner, ownerPid),
    p: capping ? p : 0, capColor: capping ? sideCss(z!.cap, z!.capPid) : NEUTRAL_CSS,
    contested: !!z?.contested, moveIn, armIn, timer, warn, next, final,
  };
}

// ------------------------------------------------------------------ capture bar (you are inside a zone)

export type CaptureState = 'cap' | 'decap' | 'secure' | 'revert' | 'hold' | 'contested' | 'blocked' | 'arming';

export interface CaptureBarModel {
  /** CORE / ZONE B / HOT POINT. */
  label: string;
  /** CAPTURING · NEUTRALIZING · HOLDING · CONTESTED · SWARM BLOCKING · SECURING · CLEARING CRIMSON · ARMING 0:02. */
  text: string;
  state: CaptureState;
  /** Bar fill 0..1. */
  p: number;
  color: string;
}

/** The zone (Zones) or active hot site the point (x, y) is inside, with its view entry. */
function zoneAt(view: ObjectiveView, features: readonly MapFeature[], x: number, y: number) {
  if (view.mode === 'zones') {
    let best: MapFeature | null = null, bestD = Infinity;
    for (const f of features) {
      if (f.kind !== 'zone') continue;
      const d = (f.x - x) ** 2 + (f.y - y) ** 2;
      if (d <= f.radius * f.radius && d < bestD) { bestD = d; best = f; }
    }
    if (!best) return null;
    const z = view.zones?.find((e) => e.i === best!.index);
    return z ? { f: best, z } : null;
  }
  if (view.mode === 'hotpoint' && view.hot) {
    const site = view.hot.site;
    const f = features.find((e) => e.kind === 'hotSite' && e.index === site);
    const z = view.zones?.[0];
    if (!f || !z) return null;
    if ((f.x - x) ** 2 + (f.y - y) ** 2 > f.radius * f.radius) return null;
    return { f, z };
  }
  return null;
}

/**
 * The centre capture bar while the viewer (alive, a ship or a turret) is inside a zone / the active hot point;
 * null anywhere else. Pure: `x, y` is the viewer's drawn position.
 */
export function captureBarModel(
  view: ObjectiveView | undefined, features: readonly MapFeature[] | undefined, x: number, y: number, ctx: ObjCtx,
): CaptureBarModel | null {
  if (!view || !features?.length) return null;
  if (ctx.mode === 'teams' && ctx.myTeam < 0) return null; // spectators don't capture
  const at = zoneAt(view, features, x, y);
  if (!at) return null;
  const { z } = at;
  const hot = view.mode === 'hotpoint';
  const label = hot ? 'HOT POINT' : zoneName(z.i).toUpperCase();
  const mineColor = sideCss(ctx.mode === 'ffa' ? NO_TEAM : ctx.myTeam, ctx.myPid);
  const p = clamp01(z.p / 100);
  const ownedByMe = isMySide(ctx, z.owner, z.ownerPid);
  const ownedByOther = hasSide(ctx, z.owner, z.ownerPid) && !ownedByMe;
  const armIn = hot ? Math.max(0, view.hot?.armIn ?? 0) : 0;
  if (armIn > 0) return { label, text: `ARMING ${fmtSec(armIn)}`, state: 'arming', p: clamp01(1 - armIn / HOT_ARM_SEC), color: NEUTRAL_CSS };
  if (z.contested) {
    const capColor = hasSide(ctx, z.cap, z.capPid) && p > 0 ? sideCss(z.cap, z.capPid) : ownedByMe ? mineColor : NEUTRAL_CSS;
    return { label, text: 'CONTESTED', state: 'contested', p: ownedByMe && p === 0 ? 1 : p, color: capColor };
  }
  if (ownedByMe && p === 0) return { label, text: 'HOLDING', state: 'hold', p: 1, color: mineColor };
  if (z.swarm && !hot) return { label, text: 'SWARM BLOCKING', state: 'blocked', p, color: NEUTRAL_CSS };
  if (ownedByMe) return { label, text: 'SECURING', state: 'secure', p: 1 - p, color: mineColor };
  // Another side's partial progress (zones.ts rolls it back before the viewer's own capture starts): the bar
  // drains in the CAPPER's colour, not the viewer's.
  if (p > 0 && hasSide(ctx, z.cap, z.capPid) && !isMySide(ctx, z.cap, z.capPid)) {
    const who = sideName(ctx, z.cap, z.capPid);
    return { label, text: who ? `CLEARING ${up(who)}` : 'CLEARING', state: 'revert', p, color: sideCss(z.cap, z.capPid) };
  }
  if (ownedByOther) return { label, text: 'NEUTRALIZING', state: 'decap', p, color: mineColor };
  return { label, text: 'CAPTURING', state: 'cap', p, color: mineColor };
}

// ------------------------------------------------------------------ banners

export interface ObjBanner {
  text: string;
  /** Banner style: 'obj' (neutral news), 'obj-good', 'obj-bad', 'obj-alert' (overtime / sudden death). */
  kind: 'obj' | 'obj-good' | 'obj-bad' | 'obj-alert';
  color: string;
  priority: number;
  ms: number;
}

export interface BannerCtx extends ObjCtx {
  sub: ObjectiveSubMode;
  teamCount: number;
  /** Current objective score of a team (captures in CTF), for "2/3". */
  teamScore(team: TeamId): number;
  limit: number;
  /** Owner the zone (key = zone index, or 'hot') had before it went neutral; undefined = unknown. */
  prevOwner(key: string): { team: TeamId; pid: PlayerId } | undefined;
}

/** Flag events: the flag's team (index = flag stand index = team), falling back to `team`. */
export function eventFlagTeam(ev: Pick<ObjectiveGameEvent, 'index' | 'team'>, teamCount: number): TeamId {
  return Number.isInteger(ev.index) && ev.index >= 0 && ev.index < Math.max(1, teamCount) ? ev.index : ev.team;
}

/** The acting pilot's team (PlayerInfo), falling back to the event's `team`. */
export function eventActorTeam(ev: Pick<ObjectiveGameEvent, 'playerId' | 'team'>, ctx: Pick<ObjCtx, 'teamOf'>): TeamId {
  const t = ev.playerId ? ctx.teamOf(ev.playerId) : undefined;
  return t !== undefined && t >= 0 ? t : ev.team;
}

const up = (s: string): string => s.toUpperCase();

/**
 * The banner for an `objective` event (null = none). "YOU HAVE THE FLAG" is not here: the HUD raises it from
 * the view as soon as the viewer becomes the carrier (see ObjectiveHud), so a flagTaken by the viewer is skipped.
 */
export function objectiveBannerFor(ev: ObjectiveGameEvent, ctx: BannerCtx): ObjBanner | null {
  const meTeam = ctx.mode === 'teams' ? ctx.myTeam : NO_TEAM;
  const byMe = !!ev.playerId && ev.playerId === ctx.myPid;
  const b = (text: string, kind: ObjBanner['kind'], color: string, priority: number, ms = 2200): ObjBanner => ({ text, kind, color, priority, ms });
  switch (ev.kind) {
    case 'flagTaken': case 'flagDropped': case 'flagReturned': case 'flagCaptured': {
      const flagTeam = eventFlagTeam(ev, ctx.teamCount);
      const actorTeam = eventActorTeam(ev, ctx);
      const ours = meTeam >= 0 && flagTeam === meTeam;
      const weActed = meTeam >= 0 && actorTeam === meTeam;
      const flagName = up(teamName(flagTeam));
      const actorName = actorTeam >= 0 ? up(teamName(actorTeam)) : up(ctx.name(ev.playerId) || 'SOMEONE');
      if (ev.kind === 'flagTaken') {
        if (byMe) return null; // the view-driven "YOU HAVE THE FLAG" covers it
        if (ours) return b('YOUR FLAG IS TAKEN', 'obj-bad', teamCssOf(actorTeam), 3, 2400);
        if (weActed) return b(`${up(ctx.name(ev.playerId) || teamName(actorTeam))} HAS THE ${flagName} FLAG`, 'obj-good', teamCssOf(meTeam), 2);
        return b(`${actorName} TOOK THE ${flagName} FLAG`, 'obj', teamCssOf(actorTeam), 1, 1600);
      }
      if (ev.kind === 'flagDropped') {
        if (ours) return b('YOUR FLAG IS DOWN — RETURN IT', 'obj-alert', teamCssOf(meTeam), 2, 2400);
        if (byMe) return b('FLAG DROPPED', 'obj-bad', teamCssOf(flagTeam), 2);
        return b(`${flagName} FLAG DROPPED`, 'obj', teamCssOf(flagTeam), 1, 1600);
      }
      if (ev.kind === 'flagReturned') {
        if (ours) return b(byMe ? 'FLAG RETURNED · +20' : 'YOUR FLAG IS HOME', 'obj-good', teamCssOf(meTeam), 2);
        return b(`${flagName} FLAG RETURNED`, 'obj', teamCssOf(flagTeam), 1, 1600);
      }
      // flagCaptured: `value` is the capturing team's captures right after this one (OBJECTIVES common.ts), so a
      // banner released late still shows its own tally; the mirrored team score is the fallback.
      const caps = actorTeam >= 0 ? Math.round(Number.isFinite(ev.value) && ev.value > 0 ? ev.value : ctx.teamScore(actorTeam)) : 0;
      const tally = ctx.limit > 0 && actorTeam >= 0 ? ` · ${caps}/${ctx.limit}` : '';
      if (byMe) return b(`YOU CAPTURED THE FLAG${tally}`, 'obj-good', teamCssOf(meTeam), 3, 2800);
      if (weActed) return b(`${actorName} SCORES${tally}`, 'obj-good', teamCssOf(meTeam), 3, 2600);
      if (ours) return b(`${actorName} CAPTURED YOUR FLAG${tally}`, 'obj-bad', teamCssOf(actorTeam), 3, 2600);
      return b(`${actorName} CAPTURED ${flagName}'S FLAG${tally}`, 'obj', teamCssOf(actorTeam), 2);
    }
    case 'zoneCaptured': {
      const hot = ctx.sub === 'hotpoint';
      const where = hot ? 'THE HOT POINT' : up(zoneName(ev.index));
      const team = ctx.mode === 'ffa' ? NO_TEAM : ev.team >= 0 ? ev.team : eventActorTeam(ev, ctx);
      const pid = ctx.mode === 'ffa' ? ev.playerId : 0;
      if (isMySide(ctx, team, pid)) {
        return b(hot ? (ctx.mode === 'ffa' ? 'YOU HOLD THE HOT POINT' : 'HOT POINT CAPTURED') : `${where} CAPTURED`, 'obj-good', sideCss(team, pid), 2);
      }
      const who = up(sideName(ctx, team, pid) || 'SOMEONE');
      return b(hot ? `${who} HOLDS THE HOT POINT` : `${who} TOOK ${where}`, 'obj', sideCss(team, pid), 1, 1500);
    }
    case 'zoneNeutralized': {
      const hot = ctx.sub === 'hotpoint';
      const where = hot ? 'HOT POINT' : up(zoneName(ev.index));
      // The owner remembered from earlier views; else the event's value (OBJECTIVES sends the previous owner side:
      // a team, or a pilot id in FFA).
      const prev = ctx.prevOwner(hot ? 'hot' : String(ev.index))
        ?? (Number.isInteger(ev.value) && ev.value >= 0
          ? (ctx.mode === 'ffa' ? { team: NO_TEAM, pid: ev.value } : { team: ev.value, pid: 0 }) : undefined);
      if (prev && isMySide(ctx, prev.team, prev.pid)) return b(`${where} LOST`, 'obj-bad', NEUTRAL_CSS, 2);
      const actorPid = ev.playerId;
      const actorTeam = ctx.mode === 'ffa' ? NO_TEAM : eventActorTeam(ev, ctx);
      if (isMySide(ctx, actorTeam, actorPid)) return b(`${where} NEUTRALIZED`, 'obj-good', sideCss(actorTeam, actorPid), 1, 1600);
      return null;
    }
    case 'hotWarn':
      return hotWarnBanner();
    case 'hotMoved':
      return hotMovedBanner();
    case 'overtime':
      return overtimeBanner(ctx.sub);
    case 'suddenDeath':
      return suddenDeathBanner();
    default:
      return null;
  }
}

export function overtimeBanner(sub: SubMode): ObjBanner {
  const text = sub === 'zones' ? `TIE — OVERTIME +${fmtMinSec(ZONE_TIE_EXTEND_SEC)}` : sub === 'hotpoint' ? 'OVERTIME — HOLD THE POINT' : 'OVERTIME';
  return { text, kind: 'obj-alert', color: '#ffd43b', priority: 3, ms: 2800 };
}

export function hotWarnBanner(): ObjBanner {
  return { text: `HOT POINT MOVING IN ${Math.round(HOT_WARN_SEC)}s`, kind: 'obj-alert', color: '#ffd43b', priority: 2, ms: 2000 };
}

export function hotMovedBanner(): ObjBanner {
  return { text: 'HOT POINT MOVED', kind: 'obj-alert', color: '#ffd43b', priority: 2, ms: 2000 };
}

export function suddenDeathBanner(): ObjBanner {
  return { text: 'SUDDEN DEATH — NEXT CAPTURE WINS', kind: 'obj-alert', color: '#ff3b5c', priority: 3, ms: 3000 };
}

export function youHaveFlagBanner(flagTeam: TeamId): ObjBanner {
  return { text: 'YOU HAVE THE FLAG — BRING IT HOME', kind: 'obj-good', color: teamCssOf(flagTeam), priority: 3, ms: 2600 };
}

// ------------------------------------------------------------------ scoreboard / results columns

export type ObjColumnKey = 'caps' | 'returns' | 'zoneCaps' | 'objTime' | 'hotTime' | 'points';

export interface ObjColumn { key: ObjColumnKey; label: string; title: string }

/** Objective columns per sub-mode (none for deathmatch / dungeon). FFA Hot Point adds the points column. */
export function objColumns(sub: SubMode | undefined, mode: GameMode): ObjColumn[] {
  switch (sub) {
    case 'ctf':
      return [
        { key: 'caps', label: 'Caps', title: 'Flag captures' },
        { key: 'returns', label: 'Ret', title: 'Flags returned' },
      ];
    case 'zones':
      return [
        { key: 'zoneCaps', label: 'Caps', title: 'Zones captured + neutralized' },
        { key: 'objTime', label: 'Obj', title: 'Time working a zone' },
      ];
    case 'hotpoint': {
      const cols: ObjColumn[] = [
        { key: 'zoneCaps', label: 'Caps', title: 'Hot Point captures + neutralized' },
        { key: 'hotTime', label: 'Hold', title: 'Time holding the Hot Point' },
      ];
      if (mode === 'ffa') cols.unshift({ key: 'points', label: 'Pts', title: 'Hot Point points' });
      return cols;
    }
    default:
      return [];
  }
}

/** One objective cell. `points` = FFA Hot Point points by player (null when not applicable). */
export function objCell(key: ObjColumnKey, s: Pick<PlayerScore, 'obj' | 'playerId'> | undefined, points: ReadonlyMap<PlayerId, number> | null): string {
  if (key === 'points') return String(Math.round(points?.get(s?.playerId ?? 0) ?? 0));
  const o = s?.obj;
  if (!o) return '—';
  switch (key) {
    case 'caps': return String(o.caps ?? 0);
    case 'returns': return String(o.returns ?? 0);
    // "captures+neutralizes" when there are neutralizes (the Point Breaker award counts both: "1 capture + 1 neutralized")
    case 'zoneCaps': return (o.neutralizes ?? 0) > 0 ? `${o.zoneCaps ?? 0}+${o.neutralizes}` : String(o.zoneCaps ?? 0);
    case 'objTime': return fmtObjTime(o.objTicks);
    case 'hotTime': return fmtObjTime(o.hotHoldTicks);
  }
  return '—';
}

/** [playerId, points] pairs → a Map (defensive: server JSON). */
export function pointsMap(pairs: readonly [PlayerId, number][] | undefined): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  for (const e of pairs ?? []) {
    if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number' && Number.isFinite(e[1])) out.set(e[0], e[1]);
  }
  return out;
}

/** Group-head unit for objective team totals ("3 caps", "212 pts"); '' outside objective sub-modes. */
export function teamTotalUnit(sub: SubMode | undefined): string {
  if (!sub || !isObjectiveSubMode(sub)) return '';
  const l = SUB_MODES[sub].limitLabel;
  return l === 'captures' ? 'caps' : l === 'points' ? 'pts' : '';
}

/** Room lobby rules line: "⚑ Steal their pennant; score it while yours is home. First to 3 captures." */
export function objectiveRulesLine(sub: SubMode, mode: GameMode, target: number): string {
  const d = SUB_MODES[sub];
  if (!d || !isObjectiveSubMode(sub)) return '';
  const unit = d.limitLabel || 'points';
  return `${d.icon} ${d.blurb}${target > 0 ? ` First to ${countLabel(target, unit)}.` : ''}${sub === 'hotpoint' && mode === 'ffa' ? ' Every pilot for themselves.' : ''}`;
}

// ------------------------------------------------------------------ announcer (which banners, once each)

/** Zones: a later tie extension announces again once this long has passed since the last overtime banner. */
export const OT_REPEAT_MS = 10000;

const NO_BANNERS: readonly ObjBanner[] = [];

/** Everything objectiveBannerFor needs besides the viewer (the announcer supplies prevOwner). */
export type EventCtx = Omit<BannerCtx, 'prevOwner'>;

/**
 * Decides which objective banners to raise, and raises each piece of news once per match, whether it is first
 * seen in the view (always at least as new as a released event) or in an `objective` event:
 * - "you have the flag" when the viewer becomes a carrier (their own flagTaken is skipped);
 * - overtime / sudden death when the view flags flip (the events then add nothing; a later Zones tie extension
 *   announces again after OT_REPEAT_MS);
 * - hot point warn / moved per relocation (keyed by a relocation counter, so a site that comes back re-announces);
 * - "zone lost" from the owner remembered before the zone went neutral; a relocation's neutralize is "moved".
 * It also times the viewer's continuous carry (Flag Overload). Pure: no DOM.
 */
export class ObjectiveAnnouncer {
  private prevOwners = new Map<string, { team: TeamId; pid: PlayerId }>();
  private announced = new Set<string>();
  private lastOtAt = -1e9;
  private wasOvertime = false;
  private wasSudden = false;
  private carryTeam: TeamId | null = null;
  private carryStartTick = -1;
  private lastHotSite = -1;
  private hotMoves = 0;

  reset(): void {
    this.prevOwners.clear();
    this.announced.clear();
    this.lastOtAt = -1e9;
    this.wasOvertime = this.wasSudden = false;
    this.carryTeam = null;
    this.carryStartTick = -1;
    this.lastHotSite = -1;
    this.hotMoves = 0;
  }

  /** The viewer carries an enemy flag (per the last observed view). */
  get carrying(): boolean { return this.carryTeam !== null; }

  /** Seconds of continuous carry at server tick `tick` (0 when not carrying). */
  carrySec(tick: number): number {
    return this.carryTeam !== null && this.carryStartTick >= 0 ? Math.max(0, (tick - this.carryStartTick) / TICK_RATE) : 0;
  }

  prevOwner(key: string): { team: TeamId; pid: PlayerId } | undefined {
    return this.prevOwners.get(key);
  }

  private once(key: string | undefined, b: ObjBanner, out: ObjBanner[]): void {
    if (key) {
      if (this.announced.has(key)) return;
      this.announced.add(key);
    }
    out.push(b);
  }

  /**
   * Hot point relocation bookkeeping from a view: counts a site change once (whichever of observe / onEvents sees
   * it first) and forgets the old site's owner. True when this call saw the move.
   */
  private trackHot(view: ObjectiveView): boolean {
    if (view.mode !== 'hotpoint' || !view.hot) return false;
    const site = view.hot.site;
    const moved = this.lastHotSite >= 0 && site !== this.lastHotSite;
    if (moved) {
      this.hotMoves++;
      this.prevOwners.delete('hot');
    }
    this.lastHotSite = site;
    return moved;
  }

  /** Per frame, with the latest view and server tick: owner memory, carry timing, and view-driven banners. */
  observe(view: ObjectiveView, ctx: Pick<ObjCtx, 'myShipId'>, tick: number, now: number): readonly ObjBanner[] {
    let out: ObjBanner[] | null = null;
    const add = (key: string | undefined, b: ObjBanner) => this.once(key, b, (out ??= []));

    // Hot point relocations (before the owner memory, which forgets the old site's owner on a move).
    if (this.trackHot(view)) add(`moved:${this.hotMoves}`, hotMovedBanner());
    if (view.mode === 'hotpoint' && view.hot && view.hot.moveIn > 0 && view.hot.moveIn <= HOT_WARN_SEC && view.hot.next >= 0) {
      add(`warn:${this.hotMoves}`, hotWarnBanner());
    }

    // Owner memory: the last side that owned each zone ('hot' for the hot point).
    const zs = view.zones ?? [];
    if (view.mode === 'hotpoint') {
      const z = zs[0];
      if (z && (z.owner >= 0 || z.ownerPid)) this.prevOwners.set('hot', { team: z.owner, pid: z.ownerPid });
    } else {
      for (const z of zs) if (z.owner >= 0 || z.ownerPid) this.prevOwners.set(String(z.i), { team: z.owner, pid: z.ownerPid });
    }

    if (view.overtime && !this.wasOvertime && now - this.lastOtAt >= OT_REPEAT_MS) {
      this.lastOtAt = now;
      add(undefined, overtimeBanner(view.mode));
    }
    this.wasOvertime = !!view.overtime;
    if (view.suddenDeath && !this.wasSudden) add('sudden', suddenDeathBanner());
    this.wasSudden = !!view.suddenDeath;

    // You became a carrier.
    const carried = view.mode === 'ctf' ? carriedFlag(view, ctx.myShipId) : null;
    if (carried && (this.carryTeam === null || this.carryTeam !== carried.team)) {
      this.carryStartTick = tick;
      add(undefined, youHaveFlagBanner(carried.team));
    }
    this.carryTeam = carried ? carried.team : null;
    if (!carried) this.carryStartTick = -1;
    return out ?? NO_BANNERS;
  }

  /**
   * Released `objective` events of one frame → banners. `view` is the latest snapshot's, never older than the
   * events. The HUD handles events before it observes the frame, and offline the render clock can release an
   * event in the frame its snapshot arrives, so a relocation is counted from the view here as well; otherwise the
   * event would announce under the old count and observe() again under the new one.
   */
  onEvents(events: readonly ObjectiveGameEvent[], view: ObjectiveView, ctx: EventCtx, now: number): readonly ObjBanner[] {
    if (!events.length) return NO_BANNERS;
    this.trackHot(view);
    let out: ObjBanner[] | null = null;
    const moved = events.some((e) => e.kind === 'hotMoved');
    const bctx: BannerCtx = { ...ctx, prevOwner: (k) => this.prevOwners.get(k) };
    for (const ev of events) {
      // A relocation neutralizes the old site: that's "moved", not "lost".
      if (moved && ev.kind === 'zoneNeutralized' && view.mode === 'hotpoint') continue;
      if (ev.kind === 'overtime') {
        if (now - this.lastOtAt < OT_REPEAT_MS) continue;
        this.lastOtAt = now;
        (out ??= []).push(overtimeBanner(view.mode));
        continue;
      }
      const b = objectiveBannerFor(ev, bctx);
      if (!b) continue;
      const key = ev.kind === 'suddenDeath' ? 'sudden'
        : ev.kind === 'hotWarn' ? `warn:${this.hotMoves}`
          : ev.kind === 'hotMoved' ? `moved:${this.hotMoves}` : undefined;
      this.once(key, b, (out ??= []));
    }
    return out ?? NO_BANNERS;
  }
}
