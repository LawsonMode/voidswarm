// v0.3 M3 objective HUD logic (pure): the top-centre strip models, the centre capture bar, objective banners (and
// the announcer that raises each piece of news once), and the scoreboard / results columns. docs §5.3–§5.7, §9 CLIENT.
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../shared/constants';
import { hexToCss, TEAM_COLORS } from '../../shared/data/teams';
import { CTF_OVERLOAD_FULL_SEC, CTF_OVERLOAD_SEC, HOT_WARN_SEC } from '../../shared/sim/objectives/rules';
import type { MapFeature, ObjectiveGameEvent, ObjectiveView, PlayerId, TeamId } from '../../shared/types';
import {
  captureBarModel, clockModel, ctfHint, ctfModel, dirArrow, eventFlagTeam, ffaTop, fmtDist, fmtObjTime, hotModel,
  hudShowsObjective, NEUTRAL_CSS, objCell, objColumns, ObjectiveAnnouncer, objectiveBannerFor, objectiveRulesLine,
  OT_REPEAT_MS, overloadModel, pointsMap, sideCss, teamPointRows, teamTotalUnit, zoneChips, zoneGlyph, zoneName,
  type BannerCtx, type EventCtx, type ObjCtx,
} from './objectiveInfo';

// ------------------------------------------------------------------ fixtures

const PLAYERS = new Map<PlayerId, { name: string; team: TeamId }>([
  [1, { name: 'Me', team: 0 }], [2, { name: 'Ally', team: 0 }], [3, { name: 'Foe', team: 1 }], [4, { name: 'Foe2', team: 1 }],
]);
const SHIPS = new Map<number, PlayerId>([[101, 1], [102, 2], [103, 3], [104, 4]]);

function ctx(over: Partial<ObjCtx> = {}): ObjCtx {
  return {
    mode: 'teams', myTeam: 0, myPid: 1, myShipId: 101,
    name: (pid) => PLAYERS.get(pid)?.name ?? `#${pid}`,
    shipPlayer: (id) => SHIPS.get(id) ?? 0,
    teamOf: (pid) => PLAYERS.get(pid)?.team,
    ...over,
  };
}

function ectx(sub: EventCtx['sub'], scores: number[] = [0, 0], over: Partial<ObjCtx> = {}): EventCtx {
  return { ...ctx(over), sub, teamCount: 2, limit: sub === 'ctf' ? 3 : 300, teamScore: (t) => scores[t] ?? 0 };
}

function bctx(sub: EventCtx['sub'], scores: number[] = [0, 0], prev: Record<string, { team: TeamId; pid: PlayerId }> = {}, over: Partial<ObjCtx> = {}): BannerCtx {
  return { ...ectx(sub, scores, over), prevOwner: (k) => prev[k] };
}

type FlagV = NonNullable<ObjectiveView['flags']>[number];
type ZoneV = NonNullable<ObjectiveView['zones']>[number];
const flag = (team: TeamId, s: 0 | 1 | 2, extra: Partial<FlagV> = {}): FlagV => ({ team, s, x: 0, y: 0, carrierId: 0, returnIn: 0, ...extra });
const zone = (i: number, extra: Partial<ZoneV> = {}): ZoneV => ({
  i, owner: -1, ownerPid: 0, cap: -1, capPid: 0, p: 0, contested: false, swarm: false, active: true, ...extra,
});
const ctfView = (flags: FlagV[], extra: Partial<ObjectiveView> = {}): ObjectiveView => ({ mode: 'ctf', limit: 3, overtime: false, suddenDeath: false, flags, ...extra });
const zonesView = (zones: ZoneV[], extra: Partial<ObjectiveView> = {}): ObjectiveView => ({ mode: 'zones', limit: 300, overtime: false, suddenDeath: false, zones, ...extra });
const hotView = (z: ZoneV, hot: Partial<NonNullable<ObjectiveView['hot']>> = {}, extra: Partial<ObjectiveView> = {}): ObjectiveView => ({
  mode: 'hotpoint', limit: 200, overtime: false, suddenDeath: false, zones: [z], hot: { site: 0, next: -1, moveIn: 42, armIn: 0, ...hot }, ...extra,
});
const ev = (kind: ObjectiveGameEvent['kind'], team: TeamId, playerId: PlayerId, index: number): ObjectiveGameEvent => ({ t: 'objective', kind, team, playerId, index, x: 0, y: 0, value: 0 });

const FEATURES: MapFeature[] = [
  { kind: 'zone', team: -1, index: 0, x: 1000, y: 1000, radius: 200 },
  { kind: 'zone', team: -1, index: 1, x: 3000, y: 1000, radius: 200 },
  { kind: 'hotSite', team: -1, index: 0, x: 500, y: 500, radius: 240 },
  { kind: 'hotSite', team: -1, index: 1, x: 2500, y: 500, radius: 240 },
  { kind: 'flagStand', team: 0, index: 0, x: 400, y: 3000, radius: 90 },
  { kind: 'flagStand', team: 1, index: 1, x: 5600, y: 3000, radius: 90 },
];

const RED = hexToCss(TEAM_COLORS[0]);
const BLUE = hexToCss(TEAM_COLORS[1]);

// ------------------------------------------------------------------ strip

describe('objective strip (top centre)', () => {
  it('replaces the classic strip only when the match has an objective view (never in a rift)', () => {
    expect(hudShowsObjective(null)).toBe(false);
    expect(hudShowsObjective({})).toBe(false);
    expect(hudShowsObjective({ objective: ctfView([]) })).toBe(true);
    expect(hudShowsObjective({ objective: ctfView([]), dungeon: {} as never })).toBe(false);
  });

  it('clock: m:ss, low under 30 s; overtime / sudden death badge, clock hidden once an overtime runs past 0', () => {
    const v = ctfView([]);
    expect(clockModel({ timeLeftSec: 125.2 }, v)).toEqual({ text: '2:06', low: false, badge: '' });
    expect(clockModel({ timeLeftSec: 12 }, v).low).toBe(true);
    expect(clockModel({ timeLeftSec: 170 }, { ...v, suddenDeath: true })).toEqual({ text: '2:50', low: false, badge: 'SUDDEN DEATH' });
    expect(clockModel({ timeLeftSec: 0 }, { ...v, overtime: true })).toEqual({ text: '', low: false, badge: 'OVERTIME' });
    expect(clockModel({ timeLeftSec: 0, timed: false }, v).text).toBe('');
  });

  it('CTF chips: flag state, captures n/limit, carrier name (YOU for yourself), return timer, own flag marked', () => {
    const m = ctfModel(ctfView([flag(1, 1, { carrierId: 101 }), flag(0, 2, { returnIn: 13.2 })]), [2, 1], ctx());
    expect(m.limit).toBe(3);
    expect(m.flags.map((f) => f.team)).toEqual([0, 1]); // sorted by team
    const [ours, theirs] = m.flags;
    expect(ours).toMatchObject({ state: 'dropped', status: 'DOWN 0:14', caps: 2, mine: true, color: RED });
    expect(theirs).toMatchObject({ state: 'carried', status: 'YOU', carrierIsMe: true, caps: 1, mine: false, carrierColor: RED });
    const m2 = ctfModel(ctfView([flag(0, 1, { carrierId: 103 }), flag(1, 0)]), [0, 0], ctx());
    expect(m2.flags[0]).toMatchObject({ status: 'Foe', carrier: 'Foe', carrierColor: BLUE, carrierIsMe: false });
    expect(m2.flags[1]).toMatchObject({ state: 'home', status: 'HOME' });
    // an invisible carrier (cloaked, not in the snapshot)
    expect(ctfModel(ctfView([flag(0, 1, { carrierId: 999 })]), [], ctx()).flags[0].status).toBe('TAKEN');
  });

  it('Flag Overload countdown: recharge ½ after 60 s of carry, none after 90 s', () => {
    expect(overloadModel(0)).toEqual({ level: 0, text: 'OVERLOAD IN 1:00' });
    expect(overloadModel(CTF_OVERLOAD_SEC - 0.5).level).toBe(0);
    expect(overloadModel(CTF_OVERLOAD_SEC)).toEqual({ level: 1, text: 'OVERLOAD · RECHARGE ½ · 0:30' });
    expect(overloadModel(CTF_OVERLOAD_FULL_SEC - 1).level).toBe(1);
    expect(overloadModel(CTF_OVERLOAD_FULL_SEC)).toEqual({ level: 2, text: 'OVERLOADED · NO RECHARGE' });
  });

  it('zone chips: Core ◆ then A–D, owner fill, capper ring, contested / swarm / threat', () => {
    const chips = zoneChips(zonesView([
      zone(2, { owner: 1, ownerPid: 3 }),
      zone(0, { owner: 0, ownerPid: 1, cap: 1, capPid: 3, p: 40 }), // ours, being decapped
      zone(1, { cap: 0, capPid: 1, p: 25, swarm: true }),
      zone(3, { contested: true, owner: 0 }),
    ]), ctx());
    expect(chips.map((c) => c.glyph)).toEqual(['◆', 'A', 'B', 'C']);
    expect(zoneGlyph(4)).toBe('D');
    expect(zoneName(0)).toBe('Core');
    expect(zoneName(2)).toBe('Zone B');
    expect(chips[0]).toMatchObject({ owned: true, mine: true, threat: true, ownerColor: RED, capColor: BLUE, p: 0.4 });
    expect(chips[1]).toMatchObject({ owned: false, mine: false, ownerColor: NEUTRAL_CSS, capColor: RED, p: 0.25, swarm: true });
    expect(chips[2]).toMatchObject({ owned: true, mine: false, ownerColor: BLUE, p: 0 });
    expect(chips[3]).toMatchObject({ contested: true, mine: true, threat: true });
  });

  it('team points: every team in order, own team and the leader(s) marked', () => {
    const rows = teamPointRows([120, 212, 212], 3, { myTeam: 0 });
    expect(rows.map((r) => [r.name, r.value, r.mine, r.lead])).toEqual([
      ['Crimson', 120, true, false], ['Azure', 212, false, true], ['Verdant', 212, false, true],
    ]);
    expect(teamPointRows([0, 0], 2, { myTeam: 1 }).some((r) => r.lead)).toBe(false);
  });

  it('FFA hot point: top 3 by points, plus you when you are outside it', () => {
    const c = ctx({ mode: 'ffa', myTeam: -1, myPid: 4 });
    const top = ffaTop([[1, 50], [2, 80], [3, 80], [4, 5], [9, 0]], c);
    expect(top.map((r) => r.name)).toEqual(['1. Ally', '2. Foe', '3. Me', '4. Foe2']);
    expect(top[3]).toMatchObject({ mine: true, value: 5 });
    expect(top[0].lead && top[1].lead).toBe(true);
    expect(ffaTop([[4, 30], [1, 10]], c).map((r) => r.name)).toEqual(['1. Foe2', '2. Me']);
    expect(ffaTop(undefined, c)).toEqual([]);
    expect(top[0].color).toBe(sideCss(-1, 2)); // pilot colours in FFA
  });

  it('hot point: owner, progress, move timer; within the warn window the next site direction and distance', () => {
    const c = ctx();
    const a = hotModel(hotView(zone(0, { owner: 1, ownerPid: 3, cap: 0, capPid: 1, p: 30 })), c, FEATURES, { x: 500, y: 500 })!;
    expect(a).toMatchObject({ ownerName: 'Azure', ownerColor: BLUE, owned: true, mine: false, p: 0.3, capColor: RED, timer: 'MOVES IN 0:42', warn: false, next: '' });
    const b = hotModel(hotView(zone(0), { moveIn: 8.2, next: 1 }), c, FEATURES, { x: 500, y: 500 })!;
    expect(b).toMatchObject({ ownerName: 'NEUTRAL', warn: true, timer: 'MOVING 0:09', next: 'NEXT → 2.0k' });
    expect(hotModel(hotView(zone(1), { site: 1, armIn: 2.5, moveIn: 60 }), c, FEATURES, null)!.timer).toBe('ARMING 0:03');
    const ffa = hotModel(hotView(zone(0, { ownerPid: 1 })), ctx({ mode: 'ffa', myTeam: -1 }), FEATURES, null)!;
    expect(ffa).toMatchObject({ ownerName: 'Me', mine: true, owned: true });
    expect(hotModel(zonesView([]), c, FEATURES, null)).toBeNull();
  });

  it('hot point: no move is announced in overtime or when the next move would land at the time-out', () => {
    const c = ctx();
    // overtime: the sim pauses relocation, but the wire moveIn still counts down and `next` may be set
    const ot = hotModel(hotView(zone(0, { owner: 0, ownerPid: 1 }), { moveIn: 5, next: 2 }, { overtime: true }), c, FEATURES, { x: 500, y: 500 })!;
    expect(ot).toMatchObject({ warn: false, next: '', timer: 'HOLD IT', final: true });
    const ot0 = hotModel(hotView(zone(0), { moveIn: 0, next: 2 }, { overtime: true }), c, FEATURES, { x: 500, y: 500 })!;
    expect(ot0.timer).toBe('HOLD IT');
    // 0:08 left in a 3-minute match: the move due at 0:00 never happens → FINAL POINT, no warn
    const last = hotModel(hotView(zone(0), { moveIn: 8, next: -1 }), c, FEATURES, { x: 500, y: 500 }, { timed: true, timeLeftSec: 7.9 })!;
    expect(last).toMatchObject({ warn: false, next: '', timer: 'FINAL POINT', final: true });
    expect(hotModel(hotView(zone(0), { moveIn: 42, next: -1 }), c, FEATURES, null, { timed: true, timeLeftSec: 41.6 })!.timer).toBe('FINAL POINT');
    // a regular move well before the time-out still counts down and warns
    const mid = hotModel(hotView(zone(0), { moveIn: 8, next: 1 }), c, FEATURES, { x: 500, y: 500 }, { timed: true, timeLeftSec: 68 })!;
    expect(mid).toMatchObject({ warn: true, timer: 'MOVING 0:08', final: false });
    // untimed matches keep moving
    expect(hotModel(hotView(zone(0), { moveIn: 30, next: -1 }), c, FEATURES, null, { timed: false, timeLeftSec: 0 })!.timer).toBe('MOVES IN 0:30');
  });

  it('direction arrows and distances', () => {
    expect([dirArrow(1, 0), dirArrow(1, 1), dirArrow(0, 1), dirArrow(-1, 0), dirArrow(0, -1), dirArrow(1, -1)]).toEqual(['→', '↘', '↓', '←', '↑', '↗']);
    expect(dirArrow(0, 0)).toBe('•');
    expect([fmtDist(850), fmtDist(2140)]).toEqual(['850', '2.1k']);
  });
});

// ------------------------------------------------------------------ capture bar

describe('capture bar (you are inside a zone)', () => {
  const c = ctx();
  const inCore = (z: Partial<ZoneV>, extra: Partial<ObjectiveView> = {}) => captureBarModel(zonesView([zone(0, z), zone(1)], extra), FEATURES, 1050, 1000, c);

  it('nothing outside every zone, for spectators, or without geometry', () => {
    expect(captureBarModel(zonesView([zone(0)]), FEATURES, 2000, 2000, c)).toBeNull();
    expect(captureBarModel(zonesView([zone(0)]), FEATURES, 1000, 1000, ctx({ myTeam: -2 }))).toBeNull();
    expect(captureBarModel(zonesView([zone(0)]), undefined, 1000, 1000, c)).toBeNull();
    expect(captureBarModel(undefined, FEATURES, 1000, 1000, c)).toBeNull();
  });

  it('neutral: CAPTURING with progress; enemy-owned: NEUTRALIZING; yours: HOLDING (full) or SECURING leftover progress', () => {
    expect(inCore({ cap: 0, capPid: 1, p: 64 })).toEqual({ label: 'CORE', text: 'CAPTURING', state: 'cap', p: 0.64, color: RED });
    expect(inCore({})).toMatchObject({ state: 'cap', p: 0 }); // just arrived
    expect(inCore({ owner: 1, ownerPid: 3, cap: 0, capPid: 1, p: 30 })).toMatchObject({ text: 'NEUTRALIZING', state: 'decap', p: 0.3, color: RED });
    expect(inCore({ owner: 0, ownerPid: 1 })).toMatchObject({ text: 'HOLDING', state: 'hold', p: 1 });
    expect(inCore({ owner: 0, ownerPid: 1, cap: 1, capPid: 3, p: 25 })).toMatchObject({ text: 'SECURING', state: 'secure', p: 0.75 });
  });

  it("another side's partial progress rolls back first (zones.ts): CLEARING <side> in the capper's colour, draining", () => {
    // neutral pad, Azure had 40 %: the viewer (Crimson) alone on it first clears Azure's progress
    expect(inCore({ cap: 1, capPid: 3, p: 40 })).toEqual({ label: 'CORE', text: 'CLEARING AZURE', state: 'revert', p: 0.4, color: BLUE });
    // a pad a third side owns, with Azure's partial decap on it: also Azure's progress being cleared, not ours
    expect(inCore({ owner: 2, ownerPid: 5, cap: 1, capPid: 3, p: 20 })).toMatchObject({ state: 'revert', color: BLUE });
    // our own progress keeps its CAPTURING / NEUTRALIZING labels
    expect(inCore({ cap: 0, capPid: 1, p: 40 })).toMatchObject({ state: 'cap' });
    expect(inCore({ owner: 1, ownerPid: 3, cap: 0, capPid: 1, p: 40 })).toMatchObject({ state: 'decap' });
    // FFA hot point: another pilot's progress
    const f = ctx({ mode: 'ffa', myTeam: -1 });
    const r = captureBarModel(hotView(zone(0, { capPid: 3, p: 30 })), FEATURES, 500, 500, f)!;
    expect(r).toMatchObject({ state: 'revert', p: 0.3 });
    expect(r.text.startsWith('CLEARING')).toBe(true);
  });

  it('contested freezes; the Warzone swarm blocks progress', () => {
    expect(inCore({ contested: true, cap: 1, capPid: 3, p: 50 })).toMatchObject({ text: 'CONTESTED', state: 'contested', p: 0.5, color: BLUE });
    expect(inCore({ contested: true, owner: 0, ownerPid: 1 })).toMatchObject({ state: 'contested', p: 1, color: RED });
    expect(inCore({ swarm: true, cap: 0, capPid: 1, p: 20 })).toMatchObject({ text: 'SWARM BLOCKING', state: 'blocked', p: 0.2 });
    expect(inCore({ swarm: true, owner: 0, ownerPid: 1 })).toMatchObject({ state: 'hold' }); // held zones still tick
  });

  it('picks the zone you are in by its feature index', () => {
    const v = zonesView([zone(0), zone(1, { owner: 0, ownerPid: 2 })]);
    expect(captureBarModel(v, FEATURES, 3100, 1000, c)).toMatchObject({ label: 'ZONE A', state: 'hold' });
  });

  it('hot point: only the active site; ARMING right after a move; FFA owners are pilots', () => {
    const v = hotView(zone(0, { cap: 0, capPid: 1, p: 50 }));
    expect(captureBarModel(v, FEATURES, 520, 520, c)).toMatchObject({ label: 'HOT POINT', state: 'cap', p: 0.5 });
    expect(captureBarModel(v, FEATURES, 2500, 500, c)).toBeNull(); // a candidate site, not the active one
    const arming = captureBarModel(hotView(zone(1), { site: 1, armIn: 1.5 }), FEATURES, 2500, 500, c)!;
    expect(arming).toMatchObject({ text: 'ARMING 0:02', state: 'arming' });
    expect(arming.p).toBeCloseTo(0.5);
    const f = ctx({ mode: 'ffa', myTeam: -1 });
    expect(captureBarModel(hotView(zone(0, { ownerPid: 1 })), FEATURES, 500, 500, f)).toMatchObject({ state: 'hold' });
    expect(captureBarModel(hotView(zone(0, { ownerPid: 3, capPid: 1, p: 10 })), FEATURES, 500, 500, f)).toMatchObject({ state: 'decap' });
  });

  it('CTF: a carrier at their stand while their own flag is away is told why nothing happens', () => {
    const away = ctfView([flag(0, 1, { carrierId: 103 }), flag(1, 1, { carrierId: 101 })]);
    expect(ctfHint(away, FEATURES, 420, 3000, c)).toBe('YOUR FLAG IS AWAY — RECOVER IT TO SCORE');
    const down = ctfView([flag(0, 2), flag(1, 1, { carrierId: 101 })]);
    expect(ctfHint(down, FEATURES, 420, 3000, c)).toBe('YOUR FLAG IS DOWN — RETURN IT TO SCORE');
    expect(ctfHint(ctfView([flag(0, 0), flag(1, 1, { carrierId: 101 })]), FEATURES, 420, 3000, c)).toBe(''); // home: it scores
    expect(ctfHint(away, FEATURES, 3000, 3000, c)).toBe(''); // far from the stand
    expect(ctfHint(ctfView([flag(0, 1, { carrierId: 103 }), flag(1, 0)]), FEATURES, 420, 3000, c)).toBe(''); // not carrying
  });
});

// ------------------------------------------------------------------ banners

describe('objective banners', () => {
  it('flag events resolve the flag team from index (stand index = team), else from team', () => {
    expect(eventFlagTeam({ index: 1, team: 0 }, 2)).toBe(1);
    expect(eventFlagTeam({ index: 7, team: 0 }, 2)).toBe(0);
  });

  it('flagTaken: yours taken (alert), an ally took theirs, your own pickup is left to the view', () => {
    const c = bctx('ctf');
    expect(objectiveBannerFor(ev('flagTaken', 1, 3, 0), c)).toMatchObject({ text: 'YOUR FLAG IS TAKEN', kind: 'obj-bad', priority: 3, color: BLUE });
    expect(objectiveBannerFor(ev('flagTaken', 0, 2, 1), c)).toMatchObject({ text: 'ALLY HAS THE AZURE FLAG', kind: 'obj-good' });
    expect(objectiveBannerFor(ev('flagTaken', 0, 1, 1), c)).toBeNull();
  });

  it('flagDropped / flagReturned', () => {
    const c = bctx('ctf');
    expect(objectiveBannerFor(ev('flagDropped', 0, 3, 0), c)!.text).toBe('YOUR FLAG IS DOWN — RETURN IT');
    expect(objectiveBannerFor(ev('flagDropped', 1, 1, 1), c)!.text).toBe('FLAG DROPPED');
    expect(objectiveBannerFor(ev('flagDropped', 1, 2, 1), c)!.text).toBe('AZURE FLAG DROPPED');
    expect(objectiveBannerFor(ev('flagReturned', 0, 1, 0), c)!.text).toBe('FLAG RETURNED · +20');
    expect(objectiveBannerFor(ev('flagReturned', 0, 0, 0), c)!.text).toBe('YOUR FLAG IS HOME'); // auto-return
    expect(objectiveBannerFor(ev('flagReturned', 1, 3, 1), c)).toMatchObject({ text: 'AZURE FLAG RETURNED', priority: 1 });
  });

  it('flagCaptured: you / your team / against you, with the tally', () => {
    expect(objectiveBannerFor(ev('flagCaptured', 0, 1, 1), bctx('ctf', [2, 0]))).toMatchObject({ text: 'YOU CAPTURED THE FLAG · 2/3', priority: 3 });
    expect(objectiveBannerFor(ev('flagCaptured', 0, 2, 1), bctx('ctf', [1, 0]))!.text).toBe('CRIMSON SCORES · 1/3');
    expect(objectiveBannerFor(ev('flagCaptured', 1, 3, 0), bctx('ctf', [0, 3]))).toMatchObject({ text: 'AZURE CAPTURED YOUR FLAG · 3/3', kind: 'obj-bad' });
    // spectator: neutral news
    expect(objectiveBannerFor(ev('flagCaptured', 1, 3, 0), bctx('ctf', [0, 1], {}, { myTeam: -2, myPid: 50 }))!.text).toBe("AZURE CAPTURED CRIMSON'S FLAG · 1/3");
    // the event's own tally (captures right after this one) wins over a mirrored score that has moved on
    expect(objectiveBannerFor({ ...ev('flagCaptured', 0, 2, 1), value: 2 }, bctx('ctf', [3, 0]))!.text).toBe('CRIMSON SCORES · 2/3');
  });

  it('zones: captured by you / by them; neutralized: LOST when it was yours (remembered owner)', () => {
    expect(objectiveBannerFor(ev('zoneCaptured', 0, 1, 2), bctx('zones'))).toMatchObject({ text: 'ZONE B CAPTURED', kind: 'obj-good', priority: 2 });
    expect(objectiveBannerFor(ev('zoneCaptured', 1, 3, 0), bctx('zones'))).toMatchObject({ text: 'AZURE TOOK CORE', priority: 1 });
    expect(objectiveBannerFor(ev('zoneNeutralized', 1, 3, 1), bctx('zones', [0, 0], { 1: { team: 0, pid: 0 } }))).toMatchObject({ text: 'ZONE A LOST', kind: 'obj-bad' });
    expect(objectiveBannerFor(ev('zoneNeutralized', 0, 1, 1), bctx('zones', [0, 0], { 1: { team: 1, pid: 0 } }))!.text).toBe('ZONE A NEUTRALIZED');
    expect(objectiveBannerFor(ev('zoneNeutralized', 1, 3, 1), bctx('zones', [0, 0], { 1: { team: 1, pid: 0 } }))).toBeNull();
    // no remembered owner (joined mid-match): OBJECTIVES' value = the previous owner side
    expect(objectiveBannerFor({ ...ev('zoneNeutralized', 1, 3, 2), value: 0 }, bctx('zones'))!.text).toBe('ZONE B LOST');
    expect(objectiveBannerFor({ ...ev('zoneNeutralized', 1, 3, 2), value: -1 }, bctx('zones'))).toBeNull();
  });

  it('hot point: captured (teams / FFA), warn, moved; overtime and sudden death', () => {
    expect(objectiveBannerFor(ev('zoneCaptured', 0, 1, 0), bctx('hotpoint'))!.text).toBe('HOT POINT CAPTURED');
    const ffa = bctx('hotpoint', [], {}, { mode: 'ffa', myTeam: -1 });
    expect(objectiveBannerFor(ev('zoneCaptured', -1, 1, 0), ffa)!.text).toBe('YOU HOLD THE HOT POINT');
    expect(objectiveBannerFor(ev('zoneCaptured', -1, 3, 0), ffa)!.text).toBe('FOE HOLDS THE HOT POINT');
    expect(objectiveBannerFor(ev('hotWarn', -1, 0, 0), ffa)!.text).toBe(`HOT POINT MOVING IN ${HOT_WARN_SEC}s`);
    expect(objectiveBannerFor(ev('hotMoved', -1, 0, 1), ffa)!.text).toBe('HOT POINT MOVED');
    expect(objectiveBannerFor(ev('overtime', -1, 0, 0), bctx('zones'))).toMatchObject({ text: 'TIE — OVERTIME +1:00', priority: 3 });
    expect(objectiveBannerFor(ev('overtime', -1, 0, 0), bctx('hotpoint'))!.text).toBe('OVERTIME — HOLD THE POINT');
    expect(objectiveBannerFor(ev('suddenDeath', -1, 0, 0), bctx('ctf'))).toMatchObject({ text: 'SUDDEN DEATH — NEXT CAPTURE WINS', kind: 'obj-alert' });
  });
});

describe('ObjectiveAnnouncer (each piece of news once, view or event first)', () => {
  const texts = (l: readonly { text: string }[]) => l.map((b) => b.text);

  it('"you have the flag" once per carry, from the view; your own flagTaken adds nothing; carry time from ticks', () => {
    const a = new ObjectiveAnnouncer();
    const carrying = ctfView([flag(0, 0), flag(1, 1, { carrierId: 101 })]);
    expect(texts(a.observe(carrying, ctx(), 600, 0))).toEqual(['YOU HAVE THE FLAG — BRING IT HOME']);
    expect(a.carrying).toBe(true);
    expect(a.observe(carrying, ctx(), 606, 100)).toEqual([]);
    expect(a.onEvents([ev('flagTaken', 0, 1, 1)], carrying, ectx('ctf'), 120)).toEqual([]);
    expect(a.carrySec(600 + 45 * TICK_RATE)).toBeCloseTo(45);
    a.observe(ctfView([flag(0, 0), flag(1, 2)]), ctx(), 700, 200); // dropped
    expect(a.carrying).toBe(false);
    expect(a.carrySec(900)).toBe(0);
    expect(texts(a.observe(carrying, ctx(), 800, 300))).toEqual(['YOU HAVE THE FLAG — BRING IT HOME']); // picked up again
    expect(a.carrySec(800 + TICK_RATE)).toBeCloseTo(1); // the overload clock restarts
  });

  it('overtime / sudden death: the view flip announces, the event that follows does not; a later Zones extension does', () => {
    const a = new ObjectiveAnnouncer();
    const ot = zonesView([], { overtime: true });
    expect(texts(a.observe(ot, ctx(), 1, 0))).toEqual(['TIE — OVERTIME +1:00']);
    expect(a.onEvents([ev('overtime', -1, 0, 0)], ot, ectx('zones'), 150)).toEqual([]);
    expect(a.observe(ot, ctx(), 2, 200)).toEqual([]);
    expect(texts(a.onEvents([ev('overtime', -1, 0, 0)], ot, ectx('zones'), OT_REPEAT_MS + 60_000))).toEqual(['TIE — OVERTIME +1:00']);
    const sd = ctfView([], { suddenDeath: true });
    const b = new ObjectiveAnnouncer();
    expect(texts(b.onEvents([ev('suddenDeath', -1, 0, 0)], sd, ectx('ctf'), 0))).toEqual(['SUDDEN DEATH — NEXT CAPTURE WINS']);
    expect(b.observe(sd, ctx(), 1, 10)).toEqual([]);
  });

  it('hot point warn / moved: once per relocation from view or event; a relocation neutralize is not "lost"', () => {
    const a = new ObjectiveAnnouncer();
    const mine = zone(0, { owner: 0, ownerPid: 1 });
    a.observe(hotView(mine, { moveIn: 30 }), ctx(), 1, 0);
    expect(texts(a.observe(hotView(mine, { moveIn: 9.9, next: 1 }), ctx(), 2, 10))).toEqual([`HOT POINT MOVING IN ${HOT_WARN_SEC}s`]);
    expect(a.onEvents([ev('hotWarn', -1, 0, 0)], hotView(mine, { moveIn: 9.8, next: 1 }), ectx('hotpoint'), 20)).toEqual([]);
    expect(a.observe(hotView(mine, { moveIn: 5, next: 1 }), ctx(), 3, 30)).toEqual([]);
    const moved = hotView(zone(1), { site: 1, moveIn: 60, armIn: 3 });
    expect(texts(a.observe(moved, ctx(), 4, 40))).toEqual(['HOT POINT MOVED']);
    expect(a.onEvents([ev('zoneNeutralized', -1, 0, 0), ev('hotMoved', -1, 0, 1)], moved, ectx('hotpoint'), 50)).toEqual([]);
    // the next relocation announces again, even back to site 0
    a.observe(hotView(zone(1), { site: 1, moveIn: 9, next: 0 }), ctx(), 5, 60);
    expect(texts(a.observe(hotView(zone(0), { site: 0, moveIn: 60 }), ctx(), 6, 70))).toEqual(['HOT POINT MOVED']);
  });

  it('hot point moved: the event released in the frame its snapshot arrives (before observe) announces once', () => {
    // The HUD handles a frame's events before it observes the frame; offline the event can be released at once.
    const a = new ObjectiveAnnouncer();
    a.observe(hotView(zone(0, { owner: 0, ownerPid: 1 }), { moveIn: 9, next: 1 }), ctx(), 1, 0);
    const moved = hotView(zone(1), { site: 1, moveIn: 60, armIn: 3 });
    expect(texts(a.onEvents([ev('zoneNeutralized', -1, 0, 0), ev('hotMoved', -1, 0, 1)], moved, ectx('hotpoint'), 10))).toEqual(['HOT POINT MOVED']);
    expect(a.observe(moved, ctx(), 2, 10)).toEqual([]);
    expect(a.prevOwner('hot')).toBeUndefined(); // the old site's owner is forgotten
    // and the next relocation still announces (from the view first this time)
    a.observe(hotView(zone(1), { site: 1, moveIn: 9, next: 0 }), ctx(), 3, 20);
    expect(texts(a.observe(hotView(zone(0), { site: 0, moveIn: 60 }), ctx(), 4, 30))).toEqual(['HOT POINT MOVED']);
    expect(a.onEvents([ev('hotMoved', -1, 0, 2)], hotView(zone(0), { site: 0, moveIn: 60 }), ectx('hotpoint'), 40)).toEqual([]);
  });

  it('zone lost: the owner remembered from earlier views makes a neutralize "ZONE A LOST"', () => {
    const a = new ObjectiveAnnouncer();
    a.observe(zonesView([zone(0), zone(1, { owner: 0, ownerPid: 2 })]), ctx(), 1, 0);
    const now = zonesView([zone(0), zone(1)]); // the view already shows it neutral when the event is released
    a.observe(now, ctx(), 2, 10);
    expect(texts(a.onEvents([{ ...ev('zoneNeutralized', 1, 3, 1), value: 7 }], now, ectx('zones'), 20))).toEqual(['ZONE A LOST']);
    a.reset(); // forgotten at match start: the event's value (the previous owner side) decides
    expect(a.onEvents([{ ...ev('zoneNeutralized', 1, 3, 1), value: 1 }], now, ectx('zones'), 30)).toEqual([]);
    expect(texts(a.onEvents([{ ...ev('zoneNeutralized', 1, 3, 1), value: 0 }], now, ectx('zones'), 40))).toEqual(['ZONE A LOST']);
    // FFA: the value is the previous owner's pilot id
    const ffa = { ...ectx('hotpoint', [], { mode: 'ffa', myTeam: -1 }) };
    const hv = hotView(zone(0));
    expect(texts(a.onEvents([{ ...ev('zoneNeutralized', -1, 3, 0), value: 1 }], hv, ffa, 50))).toEqual(['HOT POINT LOST']);
    expect(a.onEvents([{ ...ev('zoneNeutralized', -1, 3, 0), value: 2 }], hv, ffa, 60)).toEqual([]);
  });
});

// ------------------------------------------------------------------ scoreboard / results

describe('scoreboard + results objective columns', () => {
  it('columns per sub-mode: CTF caps + returns, Zones caps + objective time, Hot caps + hold (+ points in FFA)', () => {
    expect(objColumns('ctf', 'teams').map((c) => c.key)).toEqual(['caps', 'returns']);
    expect(objColumns('zones', 'teams').map((c) => c.key)).toEqual(['zoneCaps', 'objTime']);
    expect(objColumns('hotpoint', 'teams').map((c) => c.key)).toEqual(['zoneCaps', 'hotTime']);
    expect(objColumns('hotpoint', 'ffa').map((c) => c.key)).toEqual(['points', 'zoneCaps', 'hotTime']);
    expect(objColumns('deathmatch', 'teams')).toEqual([]);
    expect(objColumns(undefined, 'teams')).toEqual([]);
  });

  it('cells: counts, zone caps include neutralizes, times from ticks, "—" when the server sent no stats', () => {
    const s = { playerId: 7, obj: { caps: 2, returns: 3, zoneCaps: 4, neutralizes: 1, objTicks: 95 * TICK_RATE, hotHoldTicks: 30.9 * TICK_RATE } };
    expect(objCell('caps', s, null)).toBe('2');
    expect(objCell('returns', s, null)).toBe('3');
    expect(objCell('zoneCaps', s, null)).toBe('4+1'); // captures + neutralizes, as the Point Breaker award counts them
    expect(objCell('zoneCaps', { playerId: 7, obj: { zoneCaps: 2 } }, null)).toBe('2');
    expect(objCell('objTime', s, null)).toBe('1:35');
    expect(objCell('hotTime', s, null)).toBe('0:31'); // rounded, like room/objective.ts King of the Hill ("31 s")
    expect(objCell('hotTime', { playerId: 7, obj: { hotHoldTicks: 30.4 * TICK_RATE } }, null)).toBe('0:30');
    expect(objCell('caps', { playerId: 7 }, null)).toBe('—');
    expect(objCell('returns', { playerId: 7, obj: {} }, null)).toBe('0');
    expect(objCell('points', { playerId: 7 }, new Map([[7, 88.4]]))).toBe('88');
    expect(objCell('points', { playerId: 8 }, new Map([[7, 88]]))).toBe('0');
    expect(fmtObjTime(undefined)).toBe('0:00');
  });

  it('FFA points map (defensive), team-total units, lobby rules line', () => {
    const m = pointsMap([[1, 5], [2, Number.NaN], ['x' as unknown as number, 3], [3, 7]]);
    expect([...m]).toEqual([[1, 5], [3, 7]]);
    expect(pointsMap(undefined).size).toBe(0);
    expect([teamTotalUnit('ctf'), teamTotalUnit('zones'), teamTotalUnit('hotpoint'), teamTotalUnit('deathmatch')]).toEqual(['caps', 'pts', 'pts', '']);
    expect(objectiveRulesLine('ctf', 'teams', 3)).toBe('⚑ Steal their pennant; score it while yours is home. First to 3 captures.');
    expect(objectiveRulesLine('hotpoint', 'ffa', 120)).toContain('First to 120 points. Every pilot for themselves.');
    expect(objectiveRulesLine('deathmatch', 'teams', 0)).toBe('');
  });
});
