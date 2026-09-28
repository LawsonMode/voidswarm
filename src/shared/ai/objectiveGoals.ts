// OWNER: AI agent. Objective goals for bots (docs/v0.3-proposal.md §5.7): CTF roles, Control Zones, Hot Point.
//
// objectiveGoal() is pure: it reads world.objective (frozen ObjectiveState shape), map.features and ship
// positions, and returns the bot's best objective goal (or null). bots.ts joins it into decide() as mode
// 'objective' via consider(), applies the fight damping and the hold jitter. Nothing here draws randomness,
// so a goal never consumes world.rng or the brain's Rng.
//
// Tuning on top of the §5.7 table (measured with 16-bot, 5-minute real-Sim runs; objectiveParity.test.ts):
// a carrier detours to touch-return our dropped flag and waits on its stand while our flag is out; in a
// stalemate (both flags carried) 5 hunt their carrier instead of 3; attackers close to a flag at its stand
// dive for it (+0.4 × (1 − d/600)); a pilot whose side is capping the hot point alone finishes the capture
// (+0.4, whatever its rank, even while low); pad goals carry padR so bots.ts can damp off-pad fights.
// M3 integration: "capping" means working the armed point alone — incl. rolling back another side's partial
// progress first (capTeam is still theirs then) and, in FFA, holding it (an FFA owner scores only while on it);
// FFA converges 5 of 10 ranks (7 in teams) and a lone FFA worker damps off-pad fights ×0.4.
import { TICK_RATE } from '../constants';
import { CTF_CAPTURE_RADIUS, CTF_CARRIER_MAX_TURRETS, HOT_WARN_SEC } from '../sim/objectives/rules';
import { objMaxTurrets } from '../sim/objectives/index';
import { sameTeam } from '../sim/world';
import type { EntityId, FlagObjective, ObjectiveState, Ship, World, ZoneObjective } from '../types';

export type ObjectiveGoalKind =
  | 'carry' | 'hunt' | 'return' | 'grab' | 'defend' | 'attack' | 'escort'
  | 'zone' | 'zoneHold' | 'hot' | 'hotNext';

export interface ObjectiveGoal {
  x: number; y: number;
  /** Utility score for consider('objective', score) (§5.7 table). */
  score: number;
  /** Stay inside a radius of (x, y) (zone pad, stand guard) instead of arriving and moving on. */
  hold: boolean;
  /** hold: radius (px) of the area to stay in (the brain jitters its hold point inside it). */
  holdR: number;
  /**
   * Zone / hot pad radius (px) when the goal is a capture pad: while the bot is on the pad, fights with ships
   * off the pad are damped (holders shoot from the pad instead of being drawn off it). 0 = not a pad.
   */
  padR: number;
  /** Hunt this ship (the enemy carrier of our flag). */
  targetShipId?: EntityId;
  kind: ObjectiveGoalKind;
  /** This bot carries a flag: fight scores ×0.3 and it never attaches. */
  carrier: boolean;
  /** Keep playing this goal even while retreating (a carrier running home, a pilot finishing a capture). */
  stay?: boolean;
  /** On the pad: fight score × this for ships off the pad (default bots.ts PAD_FIGHT_MULT). */
  padFightMult?: number;
}

// ---- §5.7 scores ----
export const OBJ_SCORE = {
  carry: 1.9, hunt: 1.5, return: 1.4, grab: 1.3, defend: 0.9, attack: 0.85, attackOpen: 0.3, attackDive: 0.4, escort: 0.8,
  zone: 0.95, zoneHold: 0.6, zoneContested: 0.3, hot: 1.0, hotCapping: 0.4,
} as const;
/** Hot Point convergers: rank % 10 below this head for the point (§5.7: 7 of 10; FFA: fewer, or it is always a brawl). */
export const HOT_CONVERGE = 7;
export const HOT_CONVERGE_FFA = 5;
/** FFA Hot Point: a pilot working the pad alone damps off-pad fights harder (it scores only while it stays on). */
export const HOT_FFA_PAD_FIGHT_MULT = 0.4;
/** Fight scores for targets farther than this (px) are × OBJ_FAR_FIGHT_MULT while an objective is live. */
export const OBJ_FAR_FIGHT_PX = 800;
export const OBJ_FAR_FIGHT_MULT = 0.6;
/** A flag carrier's fight scores are × this. */
export const CARRIER_FIGHT_MULT = 0.3;
/** Responders: nearest N teammates hunt our carried flag / return our dropped flag / grab a dropped enemy flag. */
export const HUNT_N = 3;
/**
 * Stalemate (both flags carried): our carrier can't score until our flag comes home, so more of the team
 * goes after their carrier (it hides at their stand behind defenders; 3 hunters just feed kills).
 */
export const HUNT_N_STALEMATE = 5;
export const RETURN_N = 2;
export const GRAB_N = 3;
/** Defender: travel to the stand when farther than this, else hold within DEFEND_HOLD_R of it. */
export const DEFEND_TRAVEL_PX = 600;
export const DEFEND_HOLD_R = 400;
/** Escort sits this far behind our carrier. */
export const ESCORT_BEHIND_PX = 150;
/** Attack dive: within this range of the enemy flag the attack score gains up to OBJ_SCORE.attackDive (linear). */
export const ATTACK_DIVE_R = 600;
/** "≤ 1 defender nearby" radius around an enemy stand (attack bonus). */
const STAND_GUARD_R = 700;
/** A carrier detours to touch-return our own dropped flag when it is this close. */
const CARRIER_RETURN_DETOUR = 700;
/** A zone we own counts as threatened when a hostile ship is within radius + this. */
const ZONE_THREAT_PAD = 250;
const ZONE_DIST_NORM = 5000;

const d2 = (ax: number, ay: number, bx: number, by: number): number => (ax - bx) ** 2 + (ay - by) ** 2;

/** The flag this ship carries (CTF), read straight from the objective state. */
export function carriedFlagOf(world: World, ship: Ship): FlagObjective | null {
  const o = world.objective;
  if (!o || o.mode !== 'ctf') return null;
  for (const f of o.flags) if (f.state === 'carried' && f.carrierId === ship.id) return f;
  return null;
}

/** Turret seats this host really offers (a carrier keeps only the gunner seat). */
export function hostSeats(world: World, host: Ship): number {
  let n = objMaxTurrets(world, host);
  if (carriedFlagOf(world, host)) n = Math.min(n, CTF_CARRIER_MAX_TURRETS);
  return n;
}

/**
 * §5.7 rank: the bot's index among alive teammates (itself included) sorted by ship id. FFA has no
 * teammates, so there it is the index among all alive ships (spreads FFA hot-point roles too).
 */
export function objectiveRank(world: World, me: Ship): number {
  const teams = world.config.mode === 'teams';
  let rank = 0;
  for (const s of world.ships.values()) {
    if (!s.alive || s.id === me.id || s.id > me.id) continue;
    if (teams && !sameTeam(s.team, me.team)) continue;
    rank++;
  }
  return rank;
}

/**
 * True when fewer than `n` other free teammates (alive, not a turret, not a carrier) are closer to
 * (x, y) than `me` (ties broken by ship id), i.e. `me` is among the nearest n responders.
 */
export function amongNearest(world: World, me: Ship, x: number, y: number, n: number): boolean {
  const o = world.objective;
  const mine = d2(me.x, me.y, x, y);
  let closer = 0;
  for (const s of world.ships.values()) {
    if (s.id === me.id || !s.alive || s.attachedTo !== 0 || !sameTeam(s.team, me.team)) continue;
    if (o && o.mode === 'ctf' && o.flags.some((f) => f.state === 'carried' && f.carrierId === s.id)) continue;
    const d = d2(s.x, s.y, x, y);
    if (d < mine || (d === mine && s.id < me.id)) {
      if (++closer >= n) return false;
    }
  }
  return true;
}

/** Best objective goal for this bot, or null (deathmatch, dungeon, or no role right now). */
export function objectiveGoal(world: World, me: Ship, rank: number): ObjectiveGoal | null {
  const o = world.objective;
  if (!o || !me.alive) return null;
  switch (o.mode) {
    case 'ctf': return ctfGoal(world, o, me, rank);
    case 'zones': return zonesGoal(world, o, me, rank);
    case 'hotpoint': return hotGoal(world, o, me, rank);
    default: return null; // escort: v0.4
  }
}

function goal(kind: ObjectiveGoalKind, x: number, y: number, score: number, hold = false, holdR = 0, padR = 0): ObjectiveGoal {
  return { kind, x, y, score, hold, holdR, padR, carrier: false };
}

// ---------------------------------------------------------------------------------------------
// Capture the Flag
// ---------------------------------------------------------------------------------------------

function ctfGoal(world: World, o: ObjectiveState, me: Ship, rank: number): ObjectiveGoal | null {
  const myFlag = o.flags.find((f) => f.team === me.team) ?? null;
  const carried = carriedFlagOf(world, me);
  if (carried) {
    // Carrier → own stand (capture needs our flag home). Detour to touch-return our own dropped flag.
    if (myFlag && myFlag.state === 'dropped' && d2(me.x, me.y, myFlag.x, myFlag.y) < CARRIER_RETURN_DETOUR ** 2) {
      return { ...goal('carry', myFlag.x, myFlag.y, OBJ_SCORE.carry), carrier: true };
    }
    const sx = myFlag ? myFlag.standX : me.x, sy = myFlag ? myFlag.standY : me.y;
    // Our flag is out: wait on the stand (inside the capture radius) until it comes home.
    const wait = !!myFlag && myFlag.state !== 'home';
    return { ...goal('carry', sx, sy, OBJ_SCORE.carry, wait, CTF_CAPTURE_RADIUS * 0.6), carrier: true };
  }

  let best: ObjectiveGoal | null = null;
  const offer = (g: ObjectiveGoal): void => { if (!best || g.score > best.score) best = g; };

  if (myFlag) {
    if (myFlag.state === 'carried') {
      const c = world.ships.get(myFlag.carrierId);
      const stalemate = !!friendlyCarrier(world, o, me);
      if (c && c.alive && amongNearest(world, me, c.x, c.y, stalemate ? HUNT_N_STALEMATE : HUNT_N)) {
        // lead the carrier a little along its velocity
        const g = goal('hunt', c.x + c.vx * 0.4, c.y + c.vy * 0.4, OBJ_SCORE.hunt);
        g.targetShipId = c.id;
        offer(g);
      }
    } else if (myFlag.state === 'dropped' && amongNearest(world, me, myFlag.x, myFlag.y, RETURN_N)) {
      offer(goal('return', myFlag.x, myFlag.y, OBJ_SCORE.return));
    }
  }

  // enemy flags lying on the ground: nearest 3 grab (one flag at a time: we carry none here)
  let dropped: FlagObjective | null = null, dropD = Infinity;
  for (const f of o.flags) {
    if (f.team === me.team || f.state !== 'dropped') continue;
    const d = d2(me.x, me.y, f.x, f.y);
    if (d < dropD) { dropD = d; dropped = f; }
  }
  if (dropped) {
    const f = dropped as FlagObjective;
    if (amongNearest(world, me, f.x, f.y, GRAB_N)) offer(goal('grab', f.x, f.y, OBJ_SCORE.grab));
  }

  // roles
  const role = rank % 5;
  const ourCarrier = friendlyCarrier(world, o, me);
  if ((role === 2 || role === 4) && myFlag) {
    const far = d2(me.x, me.y, myFlag.standX, myFlag.standY) > DEFEND_TRAVEL_PX ** 2;
    offer(goal('defend', myFlag.standX, myFlag.standY, OBJ_SCORE.defend, !far, DEFEND_HOLD_R));
  } else if (role === 0 || role === 1) {
    const a = attackGoal(world, o, me, rank, OBJ_SCORE.attack, true);
    if (a) offer(a);
    else if (ourCarrier) offer(escortGoal(ourCarrier));
  } else if (role === 3) {
    if (ourCarrier) offer(escortGoal(ourCarrier));
    else {
      const a = attackGoal(world, o, me, rank, OBJ_SCORE.escort, false);
      if (a) offer(a);
    }
  }
  return best;
}

/** The teammate carrying an enemy flag (the one to escort / seat on), or null. */
export function friendlyCarrier(world: World, o: ObjectiveState, me: Ship): Ship | null {
  let best: Ship | null = null, bestD = Infinity;
  for (const f of o.flags) {
    if (f.state !== 'carried' || f.team === me.team) continue;
    const c = world.ships.get(f.carrierId);
    if (!c || !c.alive || c.id === me.id || !sameTeam(c.team, me.team)) continue;
    const d = d2(me.x, me.y, c.x, c.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function escortGoal(c: Ship): ObjectiveGoal {
  const sp = Math.hypot(c.vx, c.vy);
  const hx = sp > 40 ? c.vx / sp : Math.cos(c.angle), hy = sp > 40 ? c.vy / sp : Math.sin(c.angle);
  return goal('escort', c.x - hx * ESCORT_BEHIND_PX, c.y - hy * ESCORT_BEHIND_PX, OBJ_SCORE.escort);
}

/**
 * Steal: an enemy flag at home (else one lying on the ground), spread over enemy teams by rank; +0.3 when
 * ≤ 1 defender guards its stand.
 */
function attackGoal(world: World, o: ObjectiveState, me: Ship, rank: number, base: number, openBonus: boolean): ObjectiveGoal | null {
  let pool: FlagObjective[] = [];
  for (const f of o.flags) if (f.team !== me.team && f.state === 'home') pool.push(f);
  if (pool.length === 0) pool = o.flags.filter((f) => f.team !== me.team && f.state === 'dropped');
  if (pool.length === 0) return null;
  const f = pool[(rank + Math.max(0, me.team)) % pool.length];
  let guards = 0;
  if (openBonus) {
    for (const s of world.ships.values()) {
      if (!s.alive || s.team !== f.team) continue;
      if (d2(s.x, s.y, f.standX, f.standY) < STAND_GUARD_R ** 2) guards++;
    }
  }
  // Close to a flag at its stand: dive for it (a steal pulls the whole fight onto the run home) instead of
  // trading shots with defenders who respawn beside their stand every few seconds. (A flag on the ground is
  // the nearest-3 'grab' goal's job.)
  const df = Math.hypot(f.x - me.x, f.y - me.y);
  const dive = f.state === 'home' && df < ATTACK_DIVE_R ? OBJ_SCORE.attackDive * (1 - df / ATTACK_DIVE_R) : 0;
  return goal('attack', f.x, f.y, base + (openBonus && guards <= 1 ? OBJ_SCORE.attackOpen : 0) + dive);
}

// ---------------------------------------------------------------------------------------------
// Control Zones
// ---------------------------------------------------------------------------------------------

function zoneThreatened(world: World, z: ZoneObjective, me: Ship): boolean {
  if (z.contested) return true;
  if (z.capTeam >= 0 && z.capTeam !== me.team && z.progress > 0) return true;
  const r = z.radius + ZONE_THREAT_PAD;
  for (const s of world.ships.values()) {
    if (!s.alive || sameTeam(s.team, me.team)) continue;
    if (d2(s.x, s.y, z.x, z.y) < r * r) return true;
  }
  return false;
}

function zonesGoal(world: World, o: ObjectiveState, me: Ship, rank: number): ObjectiveGoal | null {
  const zs = o.zones;
  const n = zs.length;
  if (n === 0) return null;
  const pref = zs[(rank + Math.max(0, me.team)) % n];
  const holdR = pref.radius * 0.6;
  const dPref = Math.hypot(pref.x - me.x, pref.y - me.y);
  const ours = pref.owner === me.team;
  if (!ours || zoneThreatened(world, pref, me)) {
    const s = OBJ_SCORE.zone * Math.max(0.2, 1 - dPref / ZONE_DIST_NORM) + (pref.contested ? OBJ_SCORE.zoneContested : 0);
    return goal('zone', pref.x, pref.y, s, true, holdR, pref.radius);
  }
  // Our assigned zone is owned and safe: hold it if we're on it, else help take the nearest zone we don't own.
  if (dPref < pref.radius) return goal('zoneHold', pref.x, pref.y, OBJ_SCORE.zoneHold, true, holdR, pref.radius);
  let alt: ZoneObjective | null = null, altD = Infinity;
  for (const z of zs) {
    if (z === pref || (z.owner === me.team && !z.contested)) continue;
    const d = Math.hypot(z.x - me.x, z.y - me.y);
    if (d < altD) { altD = d; alt = z; }
  }
  if (alt) {
    const z = alt as ZoneObjective;
    const s = OBJ_SCORE.zone * 0.8 * Math.max(0.2, 1 - altD / ZONE_DIST_NORM) + (z.contested ? OBJ_SCORE.zoneContested : 0);
    if (s > OBJ_SCORE.zoneHold) return goal('zone', z.x, z.y, s, true, z.radius * 0.6, z.radius);
  }
  return goal('zoneHold', pref.x, pref.y, OBJ_SCORE.zoneHold, true, holdR, pref.radius);
}

// ---------------------------------------------------------------------------------------------
// Hot Point
// ---------------------------------------------------------------------------------------------

function hotGoal(world: World, o: ObjectiveState, me: Ship, rank: number): ObjectiveGoal | null {
  const hot = o.hot;
  const z = o.zones[0];
  if (!hot || !z) return null;
  const toMove = hot.moveTick - world.tick;
  if (rank % 5 < 2 && toMove >= 0 && toMove <= HOT_WARN_SEC * TICK_RATE && hot.nextSite >= 0 && hot.nextSite !== hot.site) {
    const f = world.map.features?.find((ft) => ft.kind === 'hotSite' && ft.index === hot.nextSite);
    if (f) return goal('hotNext', f.x, f.y, OBJ_SCORE.hot, true, f.radius * 0.55, f.radius);
  }
  // A pilot alone on the armed point works it to the end, whatever its rank and even while low: capping, rolling
  // back another side's partial progress first (capTeam is still theirs then), or securing our own pad. In FFA the
  // holder also stays — an FFA owner scores only while it sits on the point alone.
  const ffa = world.config.mode !== 'teams';
  const onPad = d2(me.x, me.y, z.x, z.y) < z.radius * z.radius;
  const ownerMe = ffa ? z.ownerPlayerId === me.playerId : z.owner === me.team;
  const alone = onPad && z.active && !z.contested;
  const working = alone && (!ownerMe || z.progress > 0 || ffa);
  if (rank % 10 < (ffa ? HOT_CONVERGE_FFA : HOT_CONVERGE) || working) {
    const g = goal('hot', z.x, z.y, OBJ_SCORE.hot + (z.contested ? 0.1 : 0) + (working ? OBJ_SCORE.hotCapping : 0), true, z.radius * 0.55, z.radius);
    if (working) g.stay = true;
    if (working && ffa) g.padFightMult = HOT_FFA_PAD_FIGHT_MULT;
    return g;
  }
  return null;
}
