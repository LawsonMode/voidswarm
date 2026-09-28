// OWNER: AI agent. Frozen signatures (Room depends on them).
//
// Bot brain (v0.2): a utility-scored decision layer at 10 Hz (staggered per seed) plus cheap
// per-tick steering / aiming. Class kits: Brute (autocannon/rockets/ram/iron hide), Tech
// (plasma/arc/blink/singularity), Engineer (rivet/sentry/repair/wall), plus the turret kits
// (offense draws HOST energy, defense spends own). Reads only `world` + its own memory.
// Deterministic per seed (own Rng; never world.rng). Helpers: damageMeter.ts (real incoming damage from
// per-tick energy samples, own spending excluded), navBudget.ts (per-world A* budget with starvation-free
// priority), nav.ts (coarse grid + A*), upgradePick.ts (level-up cards), objectiveGoals.ts (v0.3 M3).
//
// v0.3 M3: mode 'objective' (CTF roles, Control Zones, Hot Point; objectiveGoals.ts) joins decide() via
// consider(). While an objective is live, fight scores for targets > 800 px are x0.6 (a carrier's x0.3),
// holders jitter their hold point inside the pad, carriers never attach, and turret rolls prefer our carrier.
// On a capture pad, fights with ships off the pad are x0.7 (holders shoot from the pad). A chased carrier
// spends its skills on the run home (Blink / Ram along the route at the real, halved carrier Blink range;
// Iron Hide, Shield Wall, Repair against the chasers). Bots ignore in-world loot caches (only humans pick them
// up), but weigh hostile loot carriers +20%.
// PvP engagement (M3 fix): focus fire (+0.3 on a target a teammate hit in the last second), fewer turret
// seats in Deathmatch (x0.3; objective modes x0.5), shorter Deathmatch stints, finishing (close in / burn
// after a weak target), and a faster hunt urge (10 s ramp with no swarm, 12 s under a swarm).
// M3 integration: the Arena Deathmatch opening (first 20 s) hunts from the first decision; pad holders steer
// their velocity onto the hold point (arrive) and only strafe well inside the pad; CTF attackers damp fights with
// ships behind them (x0.6, the defenders' job); nav edges need hull clearance (nav.ts "wide" tiles), so no route
// runs through a 1-tile gap a Juggernaut can't pass (bots used to wedge there for the whole match).
//
// v0.3 M4 (the Rift, §4.9): mode 'rift' (riftGoals.ts) joins decide() via consider(): fight inside ARMING / SEALED
// rooms (farm bonus for the room's enemies, kite inside the room when low), follow the lowest-pid free human, or
// (no human alive) advance room by room behind the lowest-pid free bot, open chests, and take the open portal.
// Rift perception only engages enemies the bot can reach (same room or line of sight; dormant packs only in its
// own room). No hunt urge in a co-op rift (no hostile ships) and no battle-station "seek teammates" roam bonus (a
// station leading the party deadlocked it), fewer turret seats (x0.5), boss focus (a Matriarch / Hive counts as
// RIFT_BOSS_FOCUS_PX closer unless an add is in our face), retreat home = the party anchor. Map swaps (floor change)
// and teleports (seal recall, doorway nudge) drop the cached path; so does map.rev (door seals; nav.ts rebuilds its
// grid). onFloorChange() (Room, on floorStart) clears path, goal and target. Everything rift-only is gated on
// world.dungeon, so Arena / Warzone bots behave exactly as in M3.
import { ATTACH_MIN_ENERGY_FRAC, DT, ENEMY_TEAM, TICK_RATE, TURRET_HOST_FLOOR_FRAC } from '../constants';
import { SHIP_CLASSES, hasUpgrade } from '../data/ships';
import { CTF_CARRIER_BLINK_MULT } from '../sim/objectives/rules';
import { isSolidAt, lineOfSight } from '../sim/map';
import { countDeployables, forEachEnemyNear, forEachShipNear, sameTeam, subModeOf } from '../sim/world';
import {
  SHIPFLAG_CLOAKED,
  emptyInput,
  type BotSkill, type Enemy, type EntityId, type GameMap, type InputState, type Ship, type UpgradeChoice, type World,
} from '../types';
import { angleDiff, clamp } from '../util/math';
import { Rng } from '../util/rng';
import { DamageMeter } from './damageMeter';
import { cellIndexOf, findPath, getNavGrid } from './nav';
import { navBudget } from './navBudget';
import {
  CARRIER_FIGHT_MULT, OBJ_FAR_FIGHT_MULT, OBJ_FAR_FIGHT_PX, carriedFlagOf, friendlyCarrier, hostSeats, objectiveGoal,
  objectiveRank, type ObjectiveGoal,
} from './objectiveGoals';
import {
  newRiftMem, riftCanEngage, riftForbiddenRoom, riftGoal, riftRetreatPoint, riftRoomExit, riftRoomIndexAt, type RiftGoal,
} from './riftGoals';
import { pickUpgrade } from './upgradePick';

export interface BotBrain {
  /** Produce this tick's input for the bot's ship (called every tick, alive or dead). */
  think(world: World, ship: Ship): InputState;
  /** Pick an index 0..offer.length-1. */
  chooseUpgrade(world: World, ship: Ship, offer: UpgradeChoice[]): number;
  /**
   * v0.3 rift (§4.8 / §8.8): the floor changed (Room calls it when it drains `floorStart`). Clears path, goal and
   * target. Optional for callers: think() also notices a swapped world.map on its own.
   */
  onFloorChange?(): void;
}

export function createBotBrain(skill: BotSkill, seed: number): BotBrain {
  return new Brain(skill, seed);
}

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

/** Decision interval in ticks (60/6 = 10 Hz). */
export const DECIDE_EVERY = 6;
/** Fraction of the shooter's velocity that projectiles inherit (the sim's real value). */
export const BULLET_INHERIT = 0.3;
/** Turret offense only while the host is above this fraction of max energy (offense drains the host). */
export const TURRET_OFFENSE_HOST_FRAC = Math.max(0.35, TURRET_HOST_FLOOR_FRAC + 0.1);

interface SkillParams {
  reactionTicks: number;
  aimError: number;
  lead: number;
  dodge: number;
  /** Stop firing below this energy fraction (unless finishing a kill). */
  minFireFrac: number;
  retreatFrac: number;
  recoverFrac: number;
  /** Per-decision probability to use a skill when its condition holds. */
  abilityChance: number;
  /** Per-decision probability to fire the secondary when its condition holds. */
  secondaryChance: number;
  /** Angular slack (rad) added to the fire cone. */
  fireSlack: number;
  /** Multiplies kite movement quality (strafing). */
  strafe: number;
  /** Chance per roll to take a turret seat when eligible. */
  turretChance: number;
}

const SKILLS: Record<BotSkill, SkillParams> = {
  easy: {
    reactionTicks: 24, aimError: 0.16, lead: 0.3, dodge: 0.12, minFireFrac: 0.12, retreatFrac: 0.22,
    recoverFrac: 0.55, abilityChance: 0.1, secondaryChance: 0.2, fireSlack: 0.25, strafe: 0.35, turretChance: 0.2,
  },
  normal: {
    reactionTicks: 13, aimError: 0.07, lead: 0.75, dodge: 0.45, minFireFrac: 0.28, retreatFrac: 0.33,
    recoverFrac: 0.7, abilityChance: 0.35, secondaryChance: 0.45, fireSlack: 0.12, strafe: 0.7, turretChance: 0.3,
  },
  hard: {
    reactionTicks: 7, aimError: 0.025, lead: 1.0, dodge: 0.85, minFireFrac: 0.35, retreatFrac: 0.36,
    recoverFrac: 0.78, abilityChance: 0.75, secondaryChance: 0.7, fireSlack: 0.05, strafe: 1.0, turretChance: 0.4,
  },
};

type Mode = 'roam' | 'fight' | 'farm' | 'gems' | 'retreat' | 'flee' | 'turret' | 'objective' | 'rift';

const RING = 32;
const SCAN_R = 1100;
/** Ticks an aimed edge skill waits for the hull to turn before pressing anyway. */
const AIM_EDGE_TIMEOUT = 20;
/** Shield Wall placement distance (sim uses min(aimDist, 160) ahead). */
const WALL_AIM_DIST = 120;
/**
 * Retreat is for recharging: the afterburner drains energy (= health) AND stops recharge. A retreating
 * bot only burns away from a hostile ship running it down faster than this (px/s)...
 */
const RETREAT_AB_CLOSING = 150;
/** ...within this range (px)... */
const RETREAT_AB_RANGE = 600;
/** ...and only while energy stays this far above its retreat threshold (fraction of max). */
const RETREAT_AB_MARGIN = 0.12;
/** Non-engineer turrets leave a host below this energy fraction (engineers stay and weld). */
const HOST_LEAVE_FRAC = 0.12;
/** findHost skips (non-engineer) hosts below HOST_LEAVE_FRAC + this, so we never seat only to leave. */
const HOST_PICK_MARGIN = 0.1;
/** After leaving a host for low energy, don't pick it again for this long (s). */
const HOST_AVOID_SEC = 10;
/**
 * Finishing Blink: Blink always travels its full blinkRange (the sim ignores aimDist; only walls and
 * the map edge stop it), so blinking straight at a target lands `d - blinkRange` from it. Only commit
 * when that landing distance falls in this band (px): close enough to finish, clear of its hull.
 */
const BLINK_FINISH_MIN = 150;
const BLINK_FINISH_MAX = 400;
/** A goal cell A* just proved unreachable is not searched again for this many ticks. */
const NAV_FAIL_MEMORY_TICKS = 90;

// ---- v0.3 M3: PvP engagement + objectives ----
/** Focus fire: bonus on a hostile ship a teammate damaged within FOCUS_WINDOW_TICKS. */
export const FOCUS_BONUS = 0.3;
const FOCUS_WINDOW_TICKS = 60;
/** Turret-seat roll chance multiplier: Deathmatch (free pilots are what makes kills) / objective sub-modes. */
export const TURRET_SEAT_MULT_DM = 0.3;
export const TURRET_SEAT_MULT_OBJ = 0.5;
/** Deathmatch turret stints are shorter (x this), so gunners rejoin the fight as free pilots. */
export const TURRET_STINT_MULT_DM = 0.5;
/** Seconds without a ship fight for the hunt urge to peak: swarm matches / no-swarm (Arena) matches. */
const HUNT_RAMP_SEC = 12;
const HUNT_RAMP_SEC_NO_SWARM = 10;
/** Arena Deathmatch: roam goals hunt the nearest hostile from the start for this long (ticks). */
const ARENA_OPENING_HUNT_TICKS = 20 * TICK_RATE;
/** Hunt urge scale while an objective goal is live (the objective is where the fights are). */
const HUNT_OBJ_MULT = 0.3;
/** Fight bonus on the hostile ship carrying OUR flag (anyone who sees it shoots it). */
const FLAG_THIEF_BONUS = 0.3;
/** Extra fight bonus for the hunters assigned to that thief (objectiveGoal targetShipId). */
const HUNT_TARGET_BONUS = 0.4;
/** Hostile loot carrier (>= LOOT_CARRIER_MIN caches, or one epic+): target weight x this. */
const LOOT_CARRIER_MULT = 1.2;
const LOOT_CARRIER_MIN = 3;
/** Objective goals at or above this are urgent: no turret seat roll, and a turret leaves its host for them. */
const OBJ_URGENT = 1.3;
/** Hold jitter: a new hold point inside holdR x HOLD_JITTER_FRAC every HOLD_JITTER_SEC. */
const HOLD_JITTER_FRAC = 0.7;
const HOLD_JITTER_SEC: readonly [number, number] = [1.2, 2.8];
/** While holding inside a pad, farming a swarm target is x this (holders shoot from the pad instead). */
const HOLD_FARM_MULT = 0.5;
/**
 * On a capture pad (zone / hot point), the fight score for a ship more than PAD_FIGHT_SLACK px off the pad
 * is x this: holders keep the pad and shoot from it (opportunistic fire) instead of chasing off it.
 */
const PAD_FIGHT_MULT = 0.7;
/** CTF attackers: fight score × this for ships behind them (away from the enemy flag they're going for). */
const ATTACK_BEHIND_MULT = 0.6;
/** Holding a pad: the under-fire strafe only runs inside this fraction of the pad radius (else steer back in). */
const HOLD_STRAFE_EDGE = 0.6;
/** Holding a pad: arrive at the hold point at ≤ this speed (px/s), gain (1/s) and velocity time constant (s). */
const HOLD_ARRIVE_MAX_V = 300;
const HOLD_ARRIVE_GAIN = 2.5;
const HOLD_ARRIVE_TAU = 0.25;
const PAD_FIGHT_SLACK = 60;
/** A chased flag carrier rolls its mobility skill (dash home along the route) this much more often. */
const CARRIER_ESCAPE_SKILL_MULT = 2;
/** Finishing: a target below this energy fraction is chased at FINISH_RANGE_MULT x the engage range. */
const FINISH_FRAC = 0.3;
const FINISH_RANGE_MULT = 0.7;

// ---- v0.3 M4: the Rift ----
/** Inside an ARMING / SEALED room: farm scores for the room's enemies + this (clearing the room is the job). */
export const RIFT_SEALED_FARM_BONUS = 0.25;
/** Turret-seat roll chance multiplier in a rift (free pilots trigger rooms and clear them). */
export const TURRET_SEAT_MULT_RIFT = 0.5;
/** A jump this far (px) between two ticks is a teleport (seal recall, doorway nudge, respawn): drop the path. */
const TELEPORT_PX = 300;
/** Farm stand-off extra for the Matriarch (radius 88, heavy contact damage). */
const MATRIARCH_RANGE_PAD = 240;
/** Rift boss focus: target choice treats a Matriarch / Hive as this much closer (px) than it is... */
export const RIFT_BOSS_FOCUS_PX = 450;
/** ...while an add within RIFT_ADD_CLOSE_PX (in our face) still comes first. */
const RIFT_ADD_CLOSE_PX = 170;
const RIFT_ADD_CLOSE_BONUS = 700;

/** An edge-triggered skill waiting to be pressed, optionally with its own aim. */
interface PendingEdge {
  active: boolean;
  /** Fixed aim angle, or NaN to aim at the current target, or null = keep normal aim. */
  aim: number | null;
  /** input.aimDist for the press (px); NaN = distance to the current target. */
  dist: number;
  deadline: number;
}

/** Default aim distance when nothing is targeted (matches emptyInput). */
const DEFAULT_AIM_DIST = 300;

const knob = (s: Ship, k: string, dflt: number): number => {
  const v = s.stats.skill?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
};
const efOf = (s: Ship): number => s.energy / Math.max(1, s.stats.maxEnergy);

/** A pilot hauling unsecured loot worth a detour: ≥ LOOT_CARRIER_MIN caches, or one epic-or-better (read-only). */
function isLootCarrier(s: Ship): boolean {
  const c = s.carried;
  if (!c || c.length === 0) return false;
  if (c.length >= LOOT_CARRIER_MIN) return true;
  for (const k of c) if (k.rarity >= 3) return true;
  return false;
}

/** Battle-station hosts: Bulwark, or Architect with Turret Bay. */
export function isBattleStation(s: Ship): boolean {
  return s.path === 'bulwark' || (s.path === 'architect' && hasUpgrade(s.upgrades, 'arc_turretbay'));
}

// ---------------------------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------------------------

class Brain implements BotBrain {
  private readonly p: SkillParams;
  private readonly rng: Rng;
  private readonly phase: number;
  private decidedOnce = false;

  private mode: Mode = 'roam';
  private targetKind: 'ship' | 'enemy' | null = null;
  private targetId: EntityId = 0;
  private acquireTick = 0;
  private losOk = false;
  private aimOffset = 0;

  // lagged target samples (ring buffer)
  private readonly rx = new Float32Array(RING);
  private readonly ry = new Float32Array(RING);
  private readonly rvx = new Float32Array(RING);
  private readonly rvy = new Float32Array(RING);
  private ringHead = 0;
  private ringCount = 0;

  private goalX = 0;
  private goalY = 0;
  private roamUntil = 0;
  /** Last tick this bot was in a ship fight; drives the 'hunt' urge that pushes bots across the map. */
  private lastFightTick = 0;
  private huntBoost = 0;
  private threatX = 0;
  private threatY = 0;
  private hasThreat = false;
  private retreating = false;

  private path: number[] | null = null;
  private pathIdx = 0;
  private pathGoalCell = -1;
  private pathTick = -9999;
  private directLos = true;
  /** Tick we started waiting for an A* slot (-1 = not waiting); a refused request re-asks every tick. */
  private navWaitSince = -1;
  /** Goal cell of the last failed search, and until when it is not retried. */
  private failCell = -1;
  private failUntil = 0;

  private strafeSign = 1;
  private strafeFlipTick = 0;

  // v0.3 objectives
  private obj: ObjectiveGoal | null = null;
  /** Inside the current hold area (hold goals only): strafe in place, slower cruise. */
  private objInside = false;
  private holdX = 0;
  private holdY = 0;
  /** Goal centre the current hold point was jittered around, and when to re-jitter. */
  private holdAX = NaN;
  private holdAY = NaN;
  private holdUntil = 0;
  private desiredRange = 450;
  /** Fighting a ship below FINISH_FRAC energy: closer range, may afterburn after it. */
  private finishing = false;
  /** Movement magnitude cap (battle stations cruise slower). */
  private moveScale = 1;

  // v0.3 M4 rift
  private rift: RiftGoal | null = null;
  private readonly riftMem = newRiftMem();
  /** Map the brain last acted on (a new object = floor swap) and its rev (door seals) for the cached path. */
  private lastMap: GameMap | null = null;
  private navRev = 0;
  /** Position on the previous tick (teleport detection). */
  private prevTickX = NaN;
  private prevTickY = NaN;

  private dodgeUntil = 0;
  private dodgeX = 0;
  private dodgeY = 0;

  // skills
  private wantSecondary = false;
  /** Secondary must be aimed at the target (rockets/arc) vs. placed anywhere (sentry). */
  private secondaryAimed = false;
  /** Projectile speed used for leading while the secondary is wanted (0 = instant). */
  private secondarySpeed = 0;
  private readonly mob: PendingEdge = { active: false, aim: null, dist: NaN, deadline: 0 };
  private readonly util: PendingEdge = { active: false, aim: null, dist: NaN, deadline: 0 };
  /** The aimed edge that held input.aim last tick (only one aimed press owns the aim at a time). */
  private aimOwner: PendingEdge | null = null;

  // turret
  private pulseAttach = false;
  private pulseDetach = false;
  private attachHost: EntityId = 0;
  private nextTurretRoll = 0;
  private detachAt = 0;
  private wasAttached = false;
  private turretOffense = false;
  private turretDefense = false;
  /** Host we left for low energy, and until when findHost skips it. */
  private avoidHost: EntityId = 0;
  private avoidHostUntil = 0;
  /** Real incoming damage to our host (own spending and turret drains excluded), decayed per decision. */
  private readonly hostMeter = new DamageMeter();
  private hostDmg = 0;

  /** Real incoming damage to us (own spending excluded), decayed per decision. */
  private readonly selfMeter = new DamageMeter();
  private dmgTaken = 0;
  private afterburn = false;

  private lastX = 0;
  private lastY = 0;
  private stuckTicks = 0;
  private unstickUntil = 0;
  private unstickX = 0;
  private unstickY = 0;

  private out = emptyInput();

  constructor(private readonly skill: BotSkill, seed: number) {
    this.p = SKILLS[skill] ?? SKILLS.normal;
    this.rng = new Rng((seed * 2654435761) ^ 0xb07b07);
    this.phase = ((seed % DECIDE_EVERY) + DECIDE_EVERY) % DECIDE_EVERY;
    this.strafeSign = this.rng.chance(0.5) ? 1 : -1;
  }

  chooseUpgrade(world: World, ship: Ship, offer: UpgradeChoice[]): number {
    try {
      const mode = world?.config?.mode ?? 'teams';
      return clamp(pickUpgrade(this.skill, this.rng, ship, offer, mode), 0, Math.max(0, offer.length - 1));
    } catch {
      return 0;
    }
  }

  onFloorChange(): void {
    this.resetTransient();
    this.goalX = this.goalY = 0;
    this.lastX = this.lastY = 0;
    this.stuckTicks = 0;
    this.unstickUntil = this.dodgeUntil = 0;
    this.failCell = -1;
    this.failUntil = 0;
    this.pathGoalCell = -1;
    this.lastMap = null;
    this.prevTickX = this.prevTickY = NaN;
    Object.assign(this.riftMem, newRiftMem());
    this.out = emptyInput();
  }

  think(world: World, ship: Ship): InputState {
    // a swapped map is a floor change even if the host never called onFloorChange()
    if (this.lastMap !== world.map) {
      if (this.lastMap) this.onFloorChange();
      this.lastMap = world.map;
      this.navRev = world.map.rev ?? 0;
    }
    // doors sealed / unsealed (map.rev): the cached path and the "unreachable" memory may be wrong now
    let resealed = false;
    if ((world.map.rev ?? 0) !== this.navRev) {
      this.navRev = world.map.rev ?? 0;
      this.path = null;
      this.failCell = -1;
      resealed = true;
    }
    if (!ship.alive) {
      this.resetTransient();
      this.prevTickX = this.prevTickY = NaN;
      this.out = emptyInput();
      return this.out;
    }
    // rift: teleported (seal recall, doorway nudge): the cached path and stuck probe belong to the old spot
    // (arena / warzone keep their v0.2 behaviour after a Blink or an attach warp)
    let jumped = false;
    if (world.dungeon && Math.abs(ship.x - this.prevTickX) + Math.abs(ship.y - this.prevTickY) > TELEPORT_PX) {
      jumped = true;
      this.path = null;
      this.lastX = ship.x; this.lastY = ship.y;
      this.stuckTicks = 0;
    }
    this.prevTickX = ship.x; this.prevTickY = ship.y;
    const t = world.tick;
    // per-tick energy sampling: separates real damage from our (and our host's) own spending
    this.selfMeter.sample(world, ship);
    const host = ship.attachedTo !== 0 ? world.ships.get(ship.attachedTo) : undefined;
    if (host) this.hostMeter.sample(world, host);
    else this.hostMeter.reset();
    const force = (this.targetKind !== null && !this.resolveTarget(world)) || ((jumped || resealed) && ship.attachedTo === 0);
    if (!this.decidedOnce || force || (t + this.phase) % DECIDE_EVERY === 0) {
      this.decidedOnce = true;
      this.decide(world, ship);
    } else if (this.navWaitSince >= 0 && ship.attachedTo === 0) {
      this.updatePath(world, ship, t); // refused an A* slot earlier: ask again this tick
    }
    return this.act(world, ship);
  }

  private resetTransient(): void {
    this.mode = 'roam';
    this.targetKind = null;
    this.targetId = 0;
    this.path = null;
    this.navWaitSince = -1;
    this.retreating = false;
    this.wasAttached = false;
    this.pulseAttach = this.pulseDetach = this.wantSecondary = false;
    this.turretOffense = this.turretDefense = false;
    this.mob.active = this.util.active = false;
    this.aimOwner = null;
    this.selfMeter.reset();
    this.hostMeter.reset();
    this.dmgTaken = this.hostDmg = 0;
    this.ringCount = 0;
    this.roamUntil = 0;
    this.decidedOnce = false;
    this.obj = null;
    this.rift = null;
    this.riftMem.waitSince = -1;
    this.objInside = false;
    this.holdAX = this.holdAY = NaN;
    this.holdUntil = 0;
  }

  private resolveTarget(world: World): Ship | Enemy | null {
    if (this.targetKind === 'ship') {
      const s = world.ships.get(this.targetId);
      return s && s.alive ? s : null;
    }
    if (this.targetKind === 'enemy') return world.enemies.get(this.targetId) ?? null;
    return null;
  }

  private setTarget(kind: 'ship' | 'enemy' | null, id: EntityId, tick: number): void {
    if (kind === this.targetKind && id === this.targetId) return;
    this.targetKind = kind;
    this.targetId = id;
    this.acquireTick = tick;
    this.ringCount = 0;
    this.aimOffset = this.rng.range(-1, 1) * this.p.aimError;
  }

  private queueEdge(e: PendingEdge, aim: number | null, t: number, dist = NaN): void {
    e.active = true;
    e.aim = aim;
    e.dist = dist;
    e.deadline = t + AIM_EDGE_TIMEOUT;
  }

  // -------------------------------------------------------------------------------------------
  // Decision layer (10 Hz)
  // -------------------------------------------------------------------------------------------

  private decide(world: World, me: Ship): void {
    const t = world.tick;
    const st = me.stats;
    const ef = efOf(me);
    const teams = world.config.mode === 'teams';
    const cls = SHIP_CLASSES[me.shipClass];

    // damage-rate bookkeeping (Iron Hide spikes): real incoming damage since the last decision
    this.dmgTaken = this.dmgTaken * 0.5 + this.selfMeter.take();

    // stuck detection
    const moved = Math.abs(me.x - this.lastX) + Math.abs(me.y - this.lastY);
    this.lastX = me.x; this.lastY = me.y;
    const holding = (this.mode === 'objective' || this.mode === 'rift') && this.objInside;
    if (me.attachedTo === 0 && moved < 6 && this.mode !== 'fight' && this.mode !== 'farm' && !holding) {
      if (++this.stuckTicks > 8) {
        this.stuckTicks = 0;
        const a = this.rng.range(0, Math.PI * 2);
        this.unstickX = Math.cos(a); this.unstickY = Math.sin(a);
        this.unstickUntil = t + 30;
        this.path = null;
      }
    } else this.stuckTicks = 0;

    // ---- objective goal (v0.3 M3; null in deathmatch / dungeon) ---------------------------------
    const obj = world.objective ? objectiveGoal(world, me, objectiveRank(world, me)) : null;
    const carrier = obj ? obj.carrier : false;
    const myFlag = world.objective?.mode === 'ctf' ? world.objective.flags.find((f) => f.team === me.team) : undefined;
    const thiefId = myFlag && myFlag.state === 'carried' ? myFlag.carrierId : 0;
    const onPad = !!obj && obj.padR > 0 && Math.hypot(obj.x - me.x, obj.y - me.y) < obj.padR;

    // ---- rift goal (v0.3 M4; null outside a running rift, and for turrets / downed pilots) ------------
    const riftMap = world.dungeon ? world.map.dungeon : undefined;
    const rift = riftMap && me.attachedTo === 0 ? riftGoal(world, me, this.riftMem) : null;
    const myRoom = rift ? rift.room : riftMap ? riftRoomIndexAt(riftMap, world.map.tileSize, me.x, me.y) : -1;
    const sealedRoom = rift ? rift.sealedRoom : -1;

    // ---- perception: ships ------------------------------------------------------------------
    let bestShip: Ship | null = null, bestShipScore = -Infinity, bestShipD = 0;
    let hostilesClose = 0, hostilesNear = 0;
    let closingFast = false;
    let tx = 0, ty = 0, tn = 0;
    let hurtAlliesInHeal = 0, alliesNear = 0;
    let hurtAlly: Ship | null = null, hurtAllyEf = 1;
    const healR = knob(me, 'healRadius', 380);
    forEachShipNear(world, me.x, me.y, SCAN_R, (s) => {
      if (s.id === me.id) return;
      const d = Math.hypot(s.x - me.x, s.y - me.y);
      if (teams && sameTeam(s.team, me.team)) {
        const aef = efOf(s);
        if (d < 700) alliesNear++;
        if (d < healR * 0.9 && aef < 0.6) hurtAlliesInHeal++;
        if (aef < hurtAllyEf && aef < 0.7) { hurtAllyEf = aef; hurtAlly = s; }
        return;
      }
      if ((s.flags & SHIPFLAG_CLOAKED) && d > 180) return; // can't see cloaked opponents
      if (d < 300) hostilesClose++;
      if (d < 700) { hostilesNear++; tx += s.x; ty += s.y; tn++; }
      if (d < RETREAT_AB_RANGE && d > 1 &&
          -((s.vx - me.vx) * (s.x - me.x) + (s.vy - me.vy) * (s.y - me.y)) / d > RETREAT_AB_CLOSING) closingFast = true;
      const sef = efOf(s);
      let sc = 1.0 - d / 1500 + (1 - sef) * 0.45 + Math.min(s.bounty, 120) / 300;
      if (this.targetKind === 'ship' && this.targetId === s.id) sc += 0.2;
      if (this.skill === 'easy') sc = 1.0 - d / 1200; // easy: just the nearest
      // focus fire: pile onto a target a teammate is already hitting (kills, not stalemates)
      if (teams && s.lastDamagedBy !== 0 && s.lastDamagedBy !== me.id && t - s.lastDamagedTick < FOCUS_WINDOW_TICKS) {
        const src = world.ships.get(s.lastDamagedBy);
        if (src && sameTeam(src.team, me.team)) sc += FOCUS_BONUS;
      }
      if (s.id === thiefId) sc += FLAG_THIEF_BONUS + (obj && obj.targetShipId === s.id ? HUNT_TARGET_BONUS : 0);
      if (sc > 0 && isLootCarrier(s)) sc *= LOOT_CARRIER_MULT;
      // objective damping: a carrier barely fights; others ignore far fights (except the flag thief)
      if (obj) {
        if (carrier) sc *= CARRIER_FIGHT_MULT;
        else if (d > OBJ_FAR_FIGHT_PX && s.id !== thiefId) sc *= OBJ_FAR_FIGHT_MULT;
        // on a capture pad: shoot from it rather than chase ships off it (a contester on the pad is fair game)
        if (onPad && Math.hypot(s.x - obj.x, s.y - obj.y) > obj.padR + PAD_FIGHT_SLACK) sc *= obj.padFightMult ?? PAD_FIGHT_MULT;
        // CTF attacker: ships behind us (away from the flag we're going for) are the defenders' job — keep pushing
        // (still shooting them opportunistically) instead of turning every run into a brawl at our own stand
        if (obj.kind === 'attack' && s.id !== thiefId && (s.x - me.x) * (obj.x - me.x) + (s.y - me.y) * (obj.y - me.y) < 0) sc *= ATTACK_BEHIND_MULT;
      }
      if (sc > bestShipScore) { bestShipScore = sc; bestShip = s; bestShipD = d; }
    });

    // ---- perception: enemies ----------------------------------------------------------------
    let nearestE: Enemy | null = null, nearestED = Infinity;
    let enemiesClose = 0;
    let bigThreat: Enemy | null = null, bigThreatD = Infinity;
    let dartThreat: Enemy | null = null;
    forEachEnemyNear(world, me.x, me.y, SCAN_R, (e) => {
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      // rift: only what we could reach (own room / line of sight; dormant packs only in our room). A black hole
      // pulls through walls, so it always counts as a threat.
      if (riftMap && e.kind !== 'blackhole' && !riftCanEngage(world, me, myRoom, e, d)) return;
      if (d < 260) enemiesClose++;
      if (d < 500) { tx += e.x * 0.5; ty += e.y * 0.5; tn += 0.5; }
      if (e.kind === 'blackhole' || e.kind === 'hive' || e.kind === 'matriarch') {
        const pull = e.kind === 'blackhole' ? 360 + e.radius * 3 : e.kind === 'hive' ? 260 + e.radius * 2 : e.radius + 170;
        const danger = e.kind === 'hive' ? (ef < 0.6 || d < 260) : true;
        if (danger && d < pull && d < bigThreatD) { bigThreat = e; bigThreatD = d; }
        if (e.kind === 'blackhole') return; // don't farm the black hole
      }
      if (e.kind === 'dart' && d < 480) {
        const facing = Math.abs(angleDiff(e.angle, Math.atan2(me.y - e.y, me.x - e.x)));
        if (facing < 0.3) dartThreat = e;
      }
      let dd = d;
      if (this.targetKind === 'enemy' && this.targetId === e.id) dd -= 120; // hysteresis
      // rift boss focus: the Matriarch / a key-room Hive keeps spawning adds, so shoot her unless an add is in our face
      if (riftMap) {
        if (e.kind === 'matriarch' || e.kind === 'hive') dd -= RIFT_BOSS_FOCUS_PX;
        else if (d < RIFT_ADD_CLOSE_PX) dd -= RIFT_ADD_CLOSE_BONUS;
      }
      if (dd < nearestED) { nearestED = dd; nearestE = e; }
    });
    this.hasThreat = tn > 0;
    if (tn > 0) { this.threatX = tx / tn; this.threatY = ty / tn; }

    // ---- perception: projectiles (dodge / walls / deflector) ------------------------------------
    let incoming = 0, projNear = 0;
    let dodgeBest = Infinity, dvx = 0, dvy = 0, incX = 0, incY = 0;
    const deflR = knob(me, 'deflectRadius', 170) + 60;
    for (const pr of world.projectiles.values()) {
      if (pr.ownerId === me.id || pr.kind === 'mine') continue;
      const ddx = pr.x - me.x, ddy = pr.y - me.y;
      if (ddx > 700 || ddx < -700 || ddy > 700 || ddy < -700) continue;
      const friendly = pr.ownerTeam !== ENEMY_TEAM && pr.ownerTeam === me.team && me.team >= 0 && !world.config.friendlyFire;
      if (friendly) continue;
      if (ddx * ddx + ddy * ddy < deflR * deflR) projNear++;
      // closest approach within 0.7 s
      const rvx = pr.vx - me.vx, rvy = pr.vy - me.vy;
      const vv = rvx * rvx + rvy * rvy;
      if (vv < 1) continue;
      const tc = -(ddx * rvx + ddy * rvy) / vv;
      if (tc < 0 || tc > 0.7) continue;
      const cx = ddx + rvx * tc, cy = ddy + rvy * tc;
      const miss = Math.hypot(cx, cy);
      const hitR = st.radius + pr.radius + 10 + pr.splash * 0.5;
      if (miss > hitR) continue;
      incoming++;
      if (tc < dodgeBest) {
        dodgeBest = tc;
        incX = pr.x; incY = pr.y;
        // perpendicular to the projectile's velocity, away from its line
        const pl = Math.hypot(pr.vx, pr.vy) || 1;
        let px = -pr.vy / pl, py = pr.vx / pl;
        if (px * -cx + py * -cy < 0) { px = -px; py = -py; }
        if (miss < 2) { px *= this.strafeSign; py *= this.strafeSign; }
        dvx = px; dvy = py;
      }
    }
    if (me.attachedTo === 0) {
      if (incoming > 0 && t >= this.dodgeUntil && this.rng.chance(this.p.dodge)) {
        this.dodgeUntil = t + 14; this.dodgeX = dvx; this.dodgeY = dvy;
      }
      if (dartThreat && t >= this.dodgeUntil && this.rng.chance(this.p.dodge)) {
        const d = dartThreat as Enemy;
        const a = d.angle + (Math.PI / 2) * this.strafeSign;
        this.dodgeUntil = t + 20; this.dodgeX = Math.cos(a); this.dodgeY = Math.sin(a);
      }
    }

    // ---- turret mode ---------------------------------------------------------------------------
    if (me.attachedTo !== 0) {
      this.decideTurret(world, me, bestShip, bestShipD, nearestE, nearestED, projNear, ef);
      return;
    }
    this.wasAttached = false;
    this.turretOffense = this.turretDefense = false;
    this.hostDmg = 0;

    // ---- retreat hysteresis -----------------------------------------------------------------
    if (this.retreating) { if (ef > this.p.recoverFrac) this.retreating = false; }
    else if (ef < this.p.retreatFrac) this.retreating = true;

    // ---- utility scoring ----------------------------------------------------------------------
    let mode = 'roam' as Mode;
    let score = 0.2;
    const cur = this.mode;
    const consider = (m: Mode, s: number): void => {
      if (m === cur) s += 0.12;
      if (s > score) { score = s; mode = m; }
    };
    const station = teams && isBattleStation(me);
    const medic = teams && me.path === 'medic';

    // Hunt urge: swarms spawn around everyone, so without this bots farm forever and never meet. With no
    // swarm (Arena) there is nothing else to do, so it builds faster; with an objective live it stays low.
    const huntRamp = world.config.pveIntensity > 0 ? HUNT_RAMP_SEC : HUNT_RAMP_SEC_NO_SWARM;
    this.huntBoost = clamp((t - this.lastFightTick) * DT / huntRamp, 0, 1) * (station || medic ? 0.3 : 0.75) *
      (obj ? HUNT_OBJ_MULT : 1);
    if (riftMap) this.huntBoost = 0; // co-op rift: no hostile ships to hunt; the rift goal replaces roaming
    // (a battle station's "seek teammates" roam bonus stays out of a rift: there the rift goal keeps the party together,
    // and a station that leads the party would otherwise wait for its followers while they wait for it)
    if (!this.retreating) consider('roam', 0.2 + this.huntBoost + (station && !riftMap && me.turrets.length < hostSeats(world, me) ? 0.25 : 0));
    // objective (a carrier keeps running home even while low: capturing is how it gets safe)
    if (obj && (!this.retreating || carrier || (obj.stay && hostilesClose === 0))) consider('objective', obj.score);
    // rift (§4.9): fight in sealed rooms, follow the leader, advance, chests, portal
    if (rift) consider('rift', rift.score);

    if (bigThreat) consider('flee', 2.0);
    if (this.retreating && (hostilesNear > 0 || enemiesClose > 0 || this.hasThreat)) consider('retreat', 1.6);
    else if (this.retreating) consider('retreat', 0.9);

    let aggression = me.shipClass === 'brute' ? 1.1 : me.shipClass === 'engineer' ? 0.95 : 1.0;
    if (station) aggression = me.turrets.length > 0 ? 1.1 : 0.8;
    if (medic && alliesNear === 0) aggression *= 0.85;
    if (bestShip && !this.retreating) consider('fight', bestShipScore * aggression);
    const holdFarm = obj && obj.hold && Math.hypot(obj.x - me.x, obj.y - me.y) < obj.holdR * 1.4 ? HOLD_FARM_MULT : 1;
    // sealed rift room: every enemy we see is one of the room's (riftCanEngage) and clearing it is the job
    const riftFarm = sealedRoom >= 0 ? RIFT_SEALED_FARM_BONUS : 0;
    if (nearestE && !this.retreating) consider('farm', (0.78 - nearestED / 900 * 0.35) * (carrier ? CARRIER_FIGHT_MULT : holdFarm) + riftFarm);
    else if (nearestE && this.retreating && nearestED < 450 && ef > 0.2 && hostilesNear === 0) consider('farm', 0.5);

    // gems
    let gem: { x: number; y: number; value: number } | null = null, gemD = Infinity;
    for (const g of world.gems.values()) {
      const dx = g.x - me.x, dy = g.y - me.y;
      if (dx > 520 || dx < -520 || dy > 520 || dy < -520) continue;
      const d = Math.hypot(dx, dy);
      if (d < gemD) { gemD = d; gem = g; }
    }
    // rift: a gem behind a wall (another room) is not worth the detour
    if (gem && riftMap && !lineOfSight(world.map, me.x, me.y, gem.x, gem.y)) gem = null;
    if (gem && gemD < 520 && enemiesClose === 0 && hostilesClose === 0) {
      consider('gems', 0.62 - gemD / 1300 + Math.min((gem as { value: number }).value, 30) / 120 + (this.retreating ? 0.5 : 0));
    }

    // turret seat (a carrier never attaches; an urgent objective beats riding, unless the seat is our carrier's)
    let host: Ship | null = null;
    const gunnerSeat = world.objective?.mode === 'ctf' ? this.carrierSeat(world, me) : null;
    if (teams && cls.canTurret && !station && !carrier && me.turrets.length === 0 && ef >= ATTACH_MIN_ENERGY_FRAC + 0.1 &&
        t >= me.attachReadyTick && t >= this.nextTurretRoll && hostilesClose === 0 &&
        (!obj || obj.score < OBJ_URGENT || gunnerSeat)) {
      this.nextTurretRoll = t + Math.round(this.rng.range(2.5, 5) / DT);
      let chance = this.p.turretChance * (world.objective ? TURRET_SEAT_MULT_OBJ : riftMap ? TURRET_SEAT_MULT_RIFT :
        subModeOf(world.config) === 'deathmatch' ? TURRET_SEAT_MULT_DM : 1);
      if (medic) chance *= 1.8;
      if (me.shipClass === 'tech') chance *= 1.2;
      if (gunnerSeat) chance *= 2; // §5.7: turret rolls prefer our carrier
      if (this.rng.chance(Math.min(1, chance))) host = this.findHost(world, me);
    }
    if (host) {
      this.pulseAttach = true;
      this.attachHost = host.id;
      this.nextTurretRoll = t + Math.round(4 / DT); // retry backoff if the attach is refused
    }

    // ---- commit mode + targets ----------------------------------------------------------------
    this.mode = mode;
    this.moveScale = 1;
    this.finishing = false;
    this.obj = obj;
    this.rift = rift;
    if (mode !== 'objective' && mode !== 'rift') this.objInside = false;
    switch (mode) {
      case 'fight': {
        const s = bestShip as unknown as Ship;
        this.lastFightTick = t;
        this.setTarget('ship', s.id, t);
        this.desiredRange = this.engageRange(me, true);
        this.finishing = this.skill !== 'easy' && efOf(s) < FINISH_FRAC;
        if (this.finishing) this.desiredRange *= FINISH_RANGE_MULT; // close in for the kill
        this.goalX = s.x; this.goalY = s.y;
        if (station) this.moveScale = 0.75;
        break;
      }
      case 'farm': {
        const e = nearestE as unknown as Enemy;
        this.setTarget('enemy', e.id, t);
        this.desiredRange = this.engageRange(me, false) +
          (e.kind === 'hive' ? 180 : e.kind === 'matriarch' ? MATRIARCH_RANGE_PAD : e.kind === 'brute' ? 60 : 0);
        this.goalX = e.x; this.goalY = e.y;
        if (station) this.moveScale = 0.75;
        break;
      }
      case 'gems': {
        const g = gem as unknown as { x: number; y: number };
        this.goalX = g.x; this.goalY = g.y;
        this.opportunisticTarget(me, t, bestShip, bestShipD, nearestE, nearestED);
        break;
      }
      case 'objective': {
        this.commitObjective(world, me, obj as ObjectiveGoal, t);
        this.opportunisticTarget(me, t, bestShip, bestShipD, nearestE, nearestED);
        break;
      }
      case 'rift': {
        this.commitObjective(world, me, rift as RiftGoal, t);
        this.opportunisticTarget(me, t, bestShip, bestShipD, nearestE, nearestED);
        break;
      }
      case 'retreat':
      case 'flee': {
        if (riftMap && (mode === 'retreat' || sealedRoom >= 0)) {
          // rift: retreat home = the party anchor; inside a sealed room, kite inside it (the doors are walls)
          const b = mode === 'flee' ? bigThreat as unknown as Enemy : null;
          const threat = b ? { x: b.x, y: b.y } : this.hasThreat ? { x: this.threatX, y: this.threatY } : null;
          const p = riftRetreatPoint(world, me, threat, sealedRoom);
          this.goalX = p.x; this.goalY = p.y;
          if (bestShip && bestShipD < 260 && ef > 0.18) this.setTarget('ship', (bestShip as Ship).id, t);
          else if (nearestE && nearestED < 300 && ef > 0.15) this.setTarget('enemy', (nearestE as Enemy).id, t);
          else this.setTarget(null, 0, t);
          break;
        }
        let fx: number, fy: number;
        if (mode === 'flee') { const b = bigThreat as unknown as Enemy; fx = b.x; fy = b.y; }
        else if (this.hasThreat) { fx = this.threatX; fy = this.threatY; }
        else { fx = me.x - me.vx; fy = me.y - me.vy; }
        let ax = me.x - fx, ay = me.y - fy;
        const al = Math.hypot(ax, ay) || 1;
        ax /= al; ay /= al;
        const home = teams ? world.map.spawns.find((sp) => sp.team === me.team) : undefined;
        if (home && mode === 'retreat') {
          const hx = home.x - me.x, hy = home.y - me.y, hl = Math.hypot(hx, hy) || 1;
          ax = ax * 0.6 + (hx / hl) * 0.4; ay = ay * 0.6 + (hy / hl) * 0.4;
        }
        this.goalX = clamp(me.x + ax * 700, 64, world.map.width - 64);
        this.goalY = clamp(me.y + ay * 700, 64, world.map.height - 64);
        // fire only in self-defence at point blank
        if (mode === 'retreat' && bestShip && bestShipD < 260 && ef > 0.18) this.setTarget('ship', (bestShip as Ship).id, t);
        else this.setTarget(null, 0, t);
        break;
      }
      default: {
        if (medic && hurtAlly) {
          const h = hurtAlly as Ship;
          this.goalX = h.x; this.goalY = h.y; this.roamUntil = t + 30;
        } else if (t >= this.roamUntil || Math.hypot(this.goalX - me.x, this.goalY - me.y) < 150) {
          this.pickRoamGoal(world, me, station || medic);
        }
        if (station) this.moveScale = 0.8;
        this.opportunisticTarget(me, t, bestShip, bestShipD, nearestE, nearestED);
      }
    }

    if (t >= this.strafeFlipTick) {
      this.strafeSign = -this.strafeSign;
      this.strafeFlipTick = t + Math.round(this.rng.range(1.2, 3.5) / DT);
    }

    this.afterburn = false;
    // Flee (black hole / Hive pull): speed is what matters. Retreat: recharge is what matters, and the
    // afterburner both costs energy (= health) and stops recharge, so only burst away from a ship that
    // is actively running us down, and never below a floor well above the retreat threshold.
    if (mode === 'flee' && ef > 0.15) this.afterburn = true;
    // run a weak ship down before it recharges (only with energy to spare: burning is health)
    else if (mode === 'fight' && this.finishing && ef > 0.6 && bestShipD > this.desiredRange + 150) this.afterburn = true;
    else if (mode === 'retreat' && closingFast && ef > this.p.retreatFrac + RETREAT_AB_MARGIN) this.afterburn = true;
    if ((mode === 'roam' || mode === 'gems') && ef > 0.85 && this.skill !== 'easy' && !station &&
        Math.hypot(this.goalX - me.x, this.goalY - me.y) > 900) this.afterburn = true;
    // objective runs: burn across the map; a carrier burns home down to a lower floor
    if (mode === 'objective' && !this.objInside && this.skill !== 'easy' && !station && ef > (carrier ? 0.55 : 0.85) &&
        Math.hypot(this.goalX - me.x, this.goalY - me.y) > (carrier ? 500 : 900)) this.afterburn = true;
    // rift: catch up with a leader > 1000 px ahead (§4.9), or burn to an open portal
    if (mode === 'rift' && rift && rift.burn && this.skill !== 'easy' && ef > 0.6) this.afterburn = true;

    this.updateLos(world, me);
    this.updatePath(world, me, t);
    this.decideSkills(world, me, {
      ef, bestShip, bestShipD, enemiesClose, hostilesClose, hostilesNear, incoming, incX, incY,
      hurtAlliesInHeal, bigThreat,
    });
  }

  /** Preferred engagement distance per class/path. */
  private engageRange(me: Ship, vsShip: boolean): number {
    switch (me.shipClass) {
      case 'brute': return me.path === 'ram' ? 300 : me.path === 'barrage' ? 380 : 340;
      case 'tech': return (me.path === 'lance' ? 640 : 560) - (vsShip && this.skill !== 'hard' ? 40 : 0);
      default: return vsShip ? 470 : 430;
    }
  }

  /** Shoot at something close while doing another job. */
  private opportunisticTarget(me: Ship, t: number, s: Ship | null, sd: number, e: Enemy | null, ed: number): void {
    const r = Math.min(650, me.stats.gunSpeed * me.stats.gunLife * 0.9);
    if (s && sd < r) this.setTarget('ship', s.id, t);
    else if (e && ed < r) this.setTarget('enemy', e.id, t);
    else this.setTarget(null, 0, t);
  }

  /**
   * v0.3 M3 objective commit: travel to the goal, or hold a jittered point inside its hold radius (so
   * holders spread over the pad and keep moving instead of stacking on the exact centre).
   */
  private commitObjective(world: World, me: Ship, g: { x: number; y: number; hold: boolean; holdR: number }, t: number): void {
    this.lastFightTick = t; // playing the objective (or the rift) is engagement: the hunt urge stays down
    if (!g.hold) {
      this.goalX = g.x; this.goalY = g.y;
      this.objInside = false;
      this.holdAX = this.holdAY = NaN;
      return;
    }
    const moved = !(Math.hypot(this.holdAX - g.x, this.holdAY - g.y) <= g.holdR * 0.5); // NaN → true
    if (moved || t >= this.holdUntil) {
      this.holdAX = g.x; this.holdAY = g.y;
      this.holdX = g.x; this.holdY = g.y;
      for (let i = 0; i < 4; i++) {
        const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(0.15, 1) * g.holdR * HOLD_JITTER_FRAC;
        const hx = g.x + Math.cos(a) * r, hy = g.y + Math.sin(a) * r;
        if (!isSolidAt(world.map, hx, hy)) { this.holdX = hx; this.holdY = hy; break; }
      }
      this.holdUntil = t + Math.round(this.rng.range(HOLD_JITTER_SEC[0], HOLD_JITTER_SEC[1]) / DT);
    }
    this.goalX = this.holdX; this.goalY = this.holdY;
    this.objInside = Math.hypot(g.x - me.x, g.y - me.y) < g.holdR;
    if (this.objInside) this.moveScale = 0.75;
  }

  /** CTF: our flag carrier, when it still has its gunner seat free (turret rolls prefer it). */
  private carrierSeat(world: World, me: Ship): Ship | null {
    const o = world.objective;
    if (!o) return null;
    const c = friendlyCarrier(world, o, me);
    return c && c.attachedTo === 0 && c.turrets.length < hostSeats(world, c) ? c : null;
  }

  private findHost(world: World, me: Ship): Ship | null {
    let best: Ship | null = null, bestS = -Infinity;
    for (const s of world.ships.values()) {
      if (s.id === me.id || !s.alive || !sameTeam(s.team, me.team)) continue;
      if (s.attachedTo !== 0 || s.turrets.length >= hostSeats(world, s)) continue;
      const hef = efOf(s);
      // Never warp onto a host we would leave on the next decision (engineers stay to weld).
      if (me.shipClass !== 'engineer' && hef < HOST_LEAVE_FRAC + HOST_PICK_MARGIN) continue;
      if (s.id === this.avoidHost && world.tick < this.avoidHostUntil) continue;
      const d = Math.hypot(s.x - me.x, s.y - me.y);
      let sc = 1 - d / 8000;
      if (isBattleStation(s)) sc += 0.6;
      if (s.shipClass === 'brute') sc += 0.2; // tanky
      if (!s.isBot) sc += 0.5;
      if (hef < 0.4) sc -= 0.6;
      if (me.shipClass === 'tech') {
        // laser resonance: stack with other lasers
        for (const id of s.turrets) if (world.ships.get(id)?.shipClass === 'tech') sc += 0.45;
      }
      // CTF: the gunner seat on our flag carrier beats any other host (§5.7 "turret rolls prefer our carrier")
      if (carriedFlagOf(world, s)) sc = Math.max(sc, 0) * 2 + 1;
      if (sc > bestS) { bestS = sc; best = s; }
    }
    return best;
  }

  private pickRoamGoal(world: World, me: Ship, social: boolean): void {
    const t = world.tick;
    this.roamUntil = t + Math.round(this.rng.range(3, 6) / DT);
    const g = world.grid;
    const teams = world.config.mode === 'teams';
    // Arena Deathmatch opening (no swarm, no objective): fighting is the only thing to do, so hunt from the
    // first decision instead of drifting around the base while the urge builds (first contact came ~15–20 s
    // in, and a 60 s match averaged under 15 kills on many seeds). Later the usual hunt ramp applies.
    const arenaOpening = world.config.pveIntensity === 0 && !world.objective && !world.dungeon && t < ARENA_OPENING_HUNT_TICKS;
    if (this.huntBoost > 0.3 || arenaOpening) {
      // go hunting: head for the nearest visible hostile ship anywhere on the map
      let hb: Ship | null = null, hd = Infinity;
      for (const s of world.ships.values()) {
        if (s.id === me.id || !s.alive || (teams && sameTeam(s.team, me.team)) || (s.flags & SHIPFLAG_CLOAKED)) continue;
        const d = Math.hypot(s.x - me.x, s.y - me.y) + this.rng.range(0, 500);
        if (d < hd) { hd = d; hb = s; }
      }
      if (hb) { this.goalX = (hb as Ship).x; this.goalY = (hb as Ship).y; this.roamUntil = t + Math.round(2 / DT); return; }
    }
    // Stations and medics seek teammates; others sometimes do.
    if (teams && (social || this.rng.chance(0.35))) {
      let n = 0, sx = 0, sy = 0;
      for (const s of world.ships.values()) {
        if (s.id === me.id || !s.alive || !sameTeam(s.team, me.team) || s.attachedTo !== 0) continue;
        sx += s.x; sy += s.y; n++;
      }
      if (n > 0) { this.goalX = sx / n; this.goalY = sy / n; return; }
    }
    let best = -1, bestS = -Infinity;
    for (let i = 0; i < g.cols * g.rows; i++) {
      const c = g.ships[i].length * 2 + g.enemies[i].length;
      if (c === 0) continue;
      const cx = ((i % g.cols) + 0.5) * g.cell, cy = (((i / g.cols) | 0) + 0.5) * g.cell;
      const s = c - Math.hypot(cx - me.x, cy - me.y) / 600 + this.rng.next();
      if (s > bestS) { bestS = s; best = i; }
    }
    if (best >= 0) {
      this.goalX = ((best % g.cols) + 0.5) * g.cell;
      this.goalY = (((best / g.cols) | 0) + 0.5) * g.cell;
    } else {
      this.goalX = this.rng.range(0.15, 0.85) * world.map.width;
      this.goalY = this.rng.range(0.15, 0.85) * world.map.height;
    }
  }

  private updateLos(world: World, me: Ship): void {
    const tg = this.resolveTarget(world);
    this.losOk = !!tg && lineOfSight(world.map, me.x, me.y, tg.x, tg.y);
  }

  private updatePath(world: World, me: Ship, t: number): void {
    const gx = this.goalX, gy = this.goalY;
    this.directLos = lineOfSight(world.map, me.x, me.y, gx, gy);
    if (this.directLos) { this.path = null; this.navWaitSince = -1; return; }
    const grid = getNavGrid(world.map);
    const gc = cellIndexOf(grid, gx, gy);
    if (!this.path || gc !== this.pathGoalCell || t - this.pathTick > 90) {
      if (gc === this.failCell && t < this.failUntil) {
        // proven unreachable a moment ago: don't spend the world's budget proving it again
        this.path = null;
        this.navWaitSince = -1;
        return;
      }
      if (this.navWaitSince < 0) this.navWaitSince = t;
      if (!navBudget(world, t, this.navWaitSince)) return; // keep old path / go direct; re-ask next tick
      this.navWaitSince = -1;
      this.path = findPath(grid, me.x, me.y, gx, gy);
      this.pathIdx = 0;
      this.pathGoalCell = gc;
      this.pathTick = t;
      if (!this.path) { this.failCell = gc; this.failUntil = t + NAV_FAIL_MEMORY_TICKS; }
    } else if (this.path && this.pathIdx + 2 < this.path.length) {
      // string-pull: skip a waypoint if the next-next is visible
      if (lineOfSight(world.map, me.x, me.y, this.path[this.pathIdx + 2], this.path[this.pathIdx + 3])) this.pathIdx += 2;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Turret mode (attached): offense draws HOST energy, defense spends own
  // -------------------------------------------------------------------------------------------

  private decideTurret(
    world: World, me: Ship, bestShip: Ship | null, bestShipD: number, nearestE: Enemy | null, nearestED: number,
    projNear: number, ef: number,
  ): void {
    const t = world.tick;
    const host = world.ships.get(me.attachedTo);
    if (!this.wasAttached) {
      this.wasAttached = true;
      const medicSeat = me.path === 'medic';
      const stint = !world.objective && subModeOf(world.config) === 'deathmatch' ? TURRET_STINT_MULT_DM : 1;
      this.detachAt = t + Math.round(this.rng.range(20, 60) / DT * (medicSeat || me.shipClass === 'tech' ? 1.5 : 1) * stint);
      this.hostDmg = 0;
    }
    this.mode = 'turret';
    this.path = null;
    this.navWaitSince = -1;
    this.wantSecondary = false;
    this.mob.active = this.util.active = false;
    const hef = host ? efOf(host) : 0;

    // host damage rate: real incoming damage only (the host's own firing, afterburner, turret drains
    // and a capped recharge are accounted for by the meter)
    this.hostDmg = this.hostDmg * 0.5 + this.hostMeter.take();

    const hostLow = !!host && hef < HOST_LEAVE_FRAC && ef > 0.4 && me.shipClass !== 'engineer';
    // CTF: the gunner on our carrier rides until the capture; anyone else leaves the seat for an urgent
    // objective (hunt the thief, return our flag, grab a dropped one) when it is one of the responders.
    let objLeave = false;
    if (world.objective && host) {
      if (carriedFlagOf(world, host)) this.detachAt = Math.max(this.detachAt, t + DECIDE_EVERY * 2);
      else if (world.objective.mode === 'ctf') {
        const g = objectiveGoal(world, me, objectiveRank(world, me));
        objLeave = !!g && g.score >= OBJ_URGENT && ef > 0.3;
      }
    }
    if (!host || !host.alive || t >= this.detachAt || hostLow || objLeave) {
      this.pulseDetach = true;
      if (hostLow && host) { this.avoidHost = host.id; this.avoidHostUntil = t + Math.round(HOST_AVOID_SEC / DT); }
    }

    // target within kit range: prefer ships, then enemies
    const range = this.turretRange(me);
    if (bestShip && bestShipD < range && lineOfSight(world.map, me.x, me.y, bestShip.x, bestShip.y)) {
      this.setTarget('ship', bestShip.id, t);
    } else if (nearestE && nearestED < range) {
      this.setTarget('enemy', nearestE.id, t);
    } else this.setTarget(null, 0, t);
    this.updateLos(world, me);

    // offense: only while the host can afford it
    this.turretOffense = !!this.targetKind && this.losOk && hef > TURRET_OFFENSE_HOST_FRAC;

    // defense (hold): class-specific
    let def = false;
    if (host) {
      switch (me.shipClass) {
        case 'brute': def = this.hostDmg > host.stats.maxEnergy * 0.04 && ef > 0.25; break;
        case 'tech': def = projNear > 0 && ef > 0.2; break;
        case 'engineer': def = hef < 0.6 && ef > 0.4; break;
      }
    }
    this.turretDefense = def;
  }

  private turretRange(me: Ship): number {
    switch (me.shipClass) {
      case 'brute': return 380;
      case 'tech': return knob(me, 'laserRange', 620) * 0.95;
      default: return 650;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Class skills
  // -------------------------------------------------------------------------------------------

  private decideSkills(world: World, me: Ship, c: {
    ef: number; bestShip: Ship | null; bestShipD: number; enemiesClose: number; hostilesClose: number;
    hostilesNear: number; incoming: number; incX: number; incY: number; hurtAlliesInHeal: number;
    bigThreat: Enemy | null;
  }): void {
    const t = world.tick;
    const st = me.stats;
    const tg = this.resolveTarget(world);
    const d = tg ? Math.hypot(tg.x - me.x, tg.y - me.y) : Infinity;
    const ef = c.ef;
    // CTF: a flag carrier on its run home spends its skills on getting there (dash along the route,
    // Iron Hide / Shield Wall / Repair against the chasers) instead of on the fight.
    const carrierRun = this.mode === 'objective' && !!this.obj && this.obj.carrier && !this.objInside;
    const chased = carrierRun && (c.hostilesNear > 0 || c.incoming > 0);
    let runAngle = NaN;
    if (carrierRun) {
      let wx = this.goalX, wy = this.goalY;
      if (!this.directLos && this.path && this.pathIdx < this.path.length) { wx = this.path[this.pathIdx]; wy = this.path[this.pathIdx + 1]; }
      runAngle = Math.atan2(wy - me.y, wx - me.x);
    }
    const escaping = this.mode === 'retreat' || this.mode === 'flee' || chased;
    const awayAngle = Math.atan2(me.y - (c.bigThreat ? c.bigThreat.y : this.threatY), me.x - (c.bigThreat ? c.bigThreat.x : this.threatX));

    // ---------- secondary (held while wanted; the sim applies its cooldown) ----------
    this.wantSecondary = false;
    if (t >= me.secondaryReadyTick && me.energy > st.secondaryCost * 2.2 && !escaping &&
        this.rng.chance(this.p.secondaryChance)) {
      switch (me.shipClass) {
        case 'brute': {
          // Rocket Salvo: clusters, or ships at mid range
          if (tg && this.losOk && ef > 0.4) {
            if (this.targetKind === 'ship' && d > 200 && d < 750) this.wantSecondary = true;
            else if (this.targetKind === 'enemy' && d > 120 && d < 700) {
              let cluster = 0;
              forEachEnemyNear(world, tg.x, tg.y, knob(me, 'rocketSplash', 70) * 1.8, () => { cluster++; });
              const k = (tg as Enemy).kind;
              if (cluster >= 3 || k === 'brute' || k === 'hive' || me.path === 'barrage') this.wantSecondary = true;
            }
          }
          this.secondaryAimed = true;
          this.secondarySpeed = knob(me, 'rocketSpeed', 700);
          break;
        }
        case 'tech': {
          // Arc Lightning: 2+ hostiles clustered near the aim (or a ship duel for non-easy bots)
          if (tg && this.losOk && d < knob(me, 'arcRange', 600) && ef > 0.35) {
            const hop = knob(me, 'arcHopRange', 260);
            let n = 0;
            forEachEnemyNear(world, tg.x, tg.y, hop, () => { n++; });
            forEachShipNear(world, tg.x, tg.y, hop, (s) => {
              if (s.id !== me.id && !(world.config.mode === 'teams' && sameTeam(s.team, me.team))) n++;
            });
            if (this.targetKind === 'enemy' && n >= 2) this.wantSecondary = true;
            if (this.targetKind === 'ship' && (n >= 2 || (this.skill !== 'easy' && me.path === 'storm') || ef > 0.7)) this.wantSecondary = true;
          }
          this.secondaryAimed = true;
          this.secondarySpeed = 0;
          break;
        }
        case 'engineer': {
          // Deploy Sentry at the fight, up to sentryMax
          const max = Math.round(knob(me, 'sentryMax', 2));
          if (countDeployables(world, me.id, 'sentry') < max && ef > 0.4 &&
              ((tg && d < knob(me, 'sentryRange', 550) + 150) || c.hostilesNear > 0 || c.enemiesClose >= 2)) {
            this.wantSecondary = true;
          }
          this.secondaryAimed = false;
          this.secondarySpeed = 0;
          break;
        }
      }
    }

    // ---------- mobility (edge) ----------
    if (!this.mob.active && t >= me.mobilityReadyTick && t >= me.mobilityActiveUntilTick &&
        me.energy > st.mobilityCost * 1.5) {
      const chance = this.p.abilityChance * (me.shipClass === 'brute' && me.path === 'ram' ? 1.6 : 1) * (chased ? CARRIER_ESCAPE_SKILL_MULT : 1);
      if (this.rng.chance(Math.min(1, chance))) {
        switch (me.shipClass) {
          case 'brute': this.planRam(world, me, c.bestShip, c.bestShipD, escaping, chased ? runAngle : awayAngle, t); break;
          case 'tech': {
            // a flag carrier blinks CTF_CARRIER_BLINK_MULT as far (skills.ts), so plan with the real range
            const blinkR = knob(me, 'blinkRange', 480) * (this.obj && this.obj.carrier ? CTF_CARRIER_BLINK_MULT : 1);
            const swarmed = c.enemiesClose >= 4 || c.hostilesClose >= 2;
            if (chased) {
              if (this.clearAlong(world, me, runAngle, blinkR)) this.queueEdge(this.mob, runAngle, t, blinkR);
            } else if ((escaping && this.hasThreat) || (swarmed && ef < 0.6) || c.bigThreat) {
              if (this.clearAlong(world, me, awayAngle, blinkR * 0.6)) this.queueEdge(this.mob, awayAngle, t, blinkR);
            } else if (this.skill === 'hard' && (me.path === 'lance' || me.path === 'storm') &&
                this.targetKind === 'ship' && tg && this.losOk && ef > 0.5 && efOf(tg as Ship) < 0.25) {
              // Blink in for the finish. Blink always covers its full range (aimDist is ignored), so
              // straight at the target we land d - blinkR from it: only commit when that is in the band.
              const land = d - blinkR;
              const a = Math.atan2(tg.y - me.y, tg.x - me.x);
              if (land >= BLINK_FINISH_MIN && land <= BLINK_FINISH_MAX && this.clearAlong(world, me, a, blinkR)) {
                this.queueEdge(this.mob, a, t, blinkR);
              }
            }
            break;
          }
          case 'engineer': {
            // Repair Pulse: self or allies in heal radius hurt (medics are eager)
            const medic = me.path === 'medic';
            const selfTh = medic ? 0.7 : 0.55;
            if (ef < selfTh || c.hurtAlliesInHeal >= (medic ? 1 : 1) || this.turretsHurt(world, me)) {
              this.queueEdge(this.mob, null, t);
            }
            break;
          }
        }
      }
    }

    // ---------- utility (edge) ----------
    if (!this.util.active && t >= me.utilityReadyTick && t >= me.utilityActiveUntilTick &&
        me.energy > st.utilityCost * 1.5 && this.rng.chance(this.p.abilityChance)) {
      switch (me.shipClass) {
        case 'brute': {
          // Iron Hide on a damage spike (or low and in trouble; a chased carrier on any real damage)
          if (this.dmgTaken > st.maxEnergy * (chased ? 0.05 : 0.1) || (ef < 0.4 && (c.hostilesClose > 0 || c.enemiesClose > 2))) {
            this.queueEdge(this.util, null, t);
          }
          break;
        }
        case 'tech': {
          // Singularity: densest enemy clump, or onto a fleeing ship
          const clump = this.densestClump(world, me, knob(me, 'wellRadius', 280) * 0.6);
          if (clump && clump.n >= (this.skill === 'easy' ? 6 : 4)) {
            this.queueEdge(this.util, Math.atan2(clump.y - me.y, clump.x - me.x), t, Math.hypot(clump.x - me.x, clump.y - me.y));
          } else if (this.targetKind === 'ship' && tg && this.losOk && d > 250 && d < 750) {
            const s = tg as Ship;
            const away = (s.vx * (s.x - me.x) + s.vy * (s.y - me.y)) / Math.max(1, d);
            if (away > 120 || efOf(s) < 0.35) {
              const lead = Math.min(0.6, d / 700);
              const lx = s.x + s.vx * lead - me.x, ly = s.y + s.vy * lead - me.y;
              this.queueEdge(this.util, Math.atan2(ly, lx), t, Math.hypot(lx, ly));
            }
          }
          break;
        }
        case 'engineer': {
          // Shield Wall between us and incoming projectiles / a chasing swarm
          if (c.incoming >= 2) {
            this.queueEdge(this.util, Math.atan2(c.incY - me.y, c.incX - me.x), t, WALL_AIM_DIST);
          } else if ((c.enemiesClose >= 4 || (escaping && this.hasThreat)) ||
              (me.path === 'architect' && (c.hostilesNear > 0 || c.enemiesClose >= 2))) {
            this.queueEdge(this.util, Math.atan2(this.threatY - me.y, this.threatX - me.x), t, WALL_AIM_DIST);
          }
          break;
        }
      }
    }
  }

  /** Brute Ram Charge: through a lined-up swarm, at a weak ship, or as an escape. */
  private planRam(world: World, me: Ship, s: Ship | null, sd: number, escaping: boolean, awayAngle: number, t: number): void {
    const ram = me.path === 'ram';
    const len = knob(me, 'chargeSpeed', 1500) * knob(me, 'chargeTime', 0.35) * (hasUpgrade(me.upgrades, 'ram_unstoppable') ? 1.6 : 1);
    if (escaping && this.hasThreat) {
      if (this.clearAlong(world, me, awayAngle, len * 0.7)) this.queueEdge(this.mob, awayAngle, t, len);
      return;
    }
    // weak hostile ship within reach
    if (s && sd < Math.min(450, len) && (efOf(s) < 0.35 || (ram && sd < 380)) &&
        lineOfSight(world.map, me.x, me.y, s.x, s.y)) {
      this.queueEdge(this.mob, NaN, t);
      if (this.targetKind !== 'ship' || this.targetId !== s.id) this.setTarget('ship', s.id, t);
      return;
    }
    // swarm line: count enemies in the corridor toward the nearest few directions
    const tg = this.resolveTarget(world);
    if (!tg) return;
    const a = Math.atan2(tg.y - me.y, tg.x - me.x);
    const n = this.countInCorridor(world, me, a, len, 55);
    if (n >= (ram ? 2 : 3) && lineOfSight(world.map, me.x, me.y, me.x + Math.cos(a) * len * 0.6, me.y + Math.sin(a) * len * 0.6)) {
      this.queueEdge(this.mob, a, t, len);
    }
  }

  private countInCorridor(world: World, me: Ship, a: number, len: number, halfW: number): number {
    const ux = Math.cos(a), uy = Math.sin(a);
    const cx = me.x + ux * len * 0.5, cy = me.y + uy * len * 0.5;
    let n = 0;
    forEachEnemyNear(world, cx, cy, len * 0.5 + halfW, (e) => {
      const rx = e.x - me.x, ry = e.y - me.y;
      const along = rx * ux + ry * uy;
      if (along < 0 || along > len) return;
      const perp = Math.abs(-rx * uy + ry * ux);
      if (perp <= halfW + e.radius) n++;
    });
    return n;
  }

  private densestClump(world: World, me: Ship, r: number): { x: number; y: number; n: number } | null {
    const pts: Enemy[] = [];
    forEachEnemyNear(world, me.x, me.y, 750, (e) => { if (pts.length < 40 && e.kind !== 'blackhole') pts.push(e); });
    if (pts.length < 3) return null;
    let best: { x: number; y: number; n: number } | null = null;
    const r2 = r * r;
    for (const p of pts) {
      let n = 0, sx = 0, sy = 0;
      for (const q of pts) {
        const dx = q.x - p.x, dy = q.y - p.y;
        if (dx * dx + dy * dy <= r2) { n++; sx += q.x; sy += q.y; }
      }
      if (!best || n > best.n) best = { x: sx / n, y: sy / n, n };
    }
    return best;
  }

  private turretsHurt(world: World, me: Ship): boolean {
    for (const id of me.turrets) {
      const tr = world.ships.get(id);
      if (tr && efOf(tr) < 0.5) return true;
    }
    return false;
  }

  private clearAlong(world: World, me: Ship, a: number, dist: number): boolean {
    return lineOfSight(world.map, me.x, me.y, me.x + Math.cos(a) * dist, me.y + Math.sin(a) * dist);
  }

  // -------------------------------------------------------------------------------------------
  // Per-tick action: steering + aim + fire
  // -------------------------------------------------------------------------------------------

  private act(world: World, me: Ship): InputState {
    const t = world.tick;
    const st = me.stats;
    const prev = this.out;
    const inp = emptyInput();
    const tg = this.resolveTarget(world);
    const attached = me.attachedTo !== 0;

    // sample target into the lag ring
    if (tg) {
      this.rx[this.ringHead] = tg.x; this.ry[this.ringHead] = tg.y;
      this.rvx[this.ringHead] = tg.vx; this.rvy[this.ringHead] = tg.vy;
      this.ringHead = (this.ringHead + 1) % RING;
      if (this.ringCount < RING) this.ringCount++;
    }

    // ---------- movement ----------
    let mx = 0, my = 0;
    if (!attached) {
      if (this.mode === 'fight' || this.mode === 'farm') {
        if (tg && this.losOk) {
          const dx = tg.x - me.x, dy = tg.y - me.y, d = Math.hypot(dx, dy) || 1;
          const ux = dx / d, uy = dy / d;
          const band = me.shipClass === 'brute' ? 60 : 90;
          const lo = this.desiredRange - band, hi = this.desiredRange + band;
          const radial = d > hi ? 1 : d < lo ? -1 : (d - this.desiredRange) / band * 0.4;
          const tang = this.p.strafe * this.strafeSign * 0.85;
          mx = ux * radial + -uy * tang;
          my = uy * radial + ux * tang;
        } else if (tg) {
          [mx, my] = this.navDir(world, me, tg.x, tg.y, t);
        }
      } else if (this.mode !== 'turret') {
        const hg = this.obj;
        const padHold = this.mode === 'objective' && !!hg && hg.hold && hg.padR > 0 && Math.hypot(me.x - hg.x, me.y - hg.y) < hg.padR;
        // On a pad we hold: steer the VELOCITY toward the hold point (arrive), so holders brake onto the point
        // instead of orbiting it at full speed and sailing off the pad edge.
        [mx, my] = padHold ? this.arrive(me, this.goalX, this.goalY) : this.navDir(world, me, this.goalX, this.goalY, t);
        if (this.mode === 'objective' && this.objInside && tg && this.losOk) {
          // holding a pad under fire: strafe around the (jittered) hold point instead of sitting still — but only
          // well inside the pad; near its edge, steer back in (the strafe used to carry holders off the point)
          const g = this.obj;
          const edge = g && g.padR > 0 ? Math.hypot(me.x - g.x, me.y - g.y) / g.padR : 0;
          if (edge < HOLD_STRAFE_EDGE) {
            const dx = tg.x - me.x, dy = tg.y - me.y, d = Math.hypot(dx, dy) || 1;
            const tang = this.p.strafe * this.strafeSign * 0.6;
            mx += (-dy / d) * tang; my += (dx / d) * tang;
          } else if (g) {
            const dx = g.x - me.x, dy = g.y - me.y, d = Math.hypot(dx, dy) || 1;
            mx += (dx / d) * 0.6; my += (dy / d) * 0.6;
          }
        }
      }
      // rift: stay out of the open Descend zone while a human is alive (bots never trigger a descent)
      const rg = this.rift;
      if (rg && rg.avoidR > 0) {
        const ox = me.x - rg.avoidX, oy = me.y - rg.avoidY, od = Math.hypot(ox, oy);
        if (od < rg.avoidR) {
          const k = clamp((rg.avoidR - od) / 60, 0, 1);
          const ux = od > 1 ? ox / od : 1, uy = od > 1 ? oy / od : 0;
          mx = mx * (1 - k) + ux * k; my = my * (1 - k) + uy * k;
        }
      }
      // rift: drifted (farming, chasing, dodging) toward the trigger of a dormant sealable room the human leader
      // isn't in: back out through its nearest door before the seal trips and recalls the whole party
      if (world.dungeon && this.mode !== 'turret') {
        const fr = riftForbiddenRoom(world, me, me.x, me.y, 2);
        const out = fr >= 0 ? riftRoomExit(world, fr, me.x, me.y) : null;
        if (out) {
          const ox = out.x - me.x, oy = out.y - me.y, od = Math.hypot(ox, oy) || 1;
          mx = mx * 0.2 + (ox / od) * 0.8; my = my * 0.2 + (oy / od) * 0.8;
        }
      }
      if (t < this.dodgeUntil) { mx = mx * 0.3 + this.dodgeX; my = my * 0.3 + this.dodgeY; }
      if (t < this.unstickUntil) { mx = this.unstickX; my = this.unstickY; }
      const ml = Math.hypot(mx, my);
      if (ml > 1e-3) {
        mx /= ml; my /= ml;
        [mx, my] = this.whiskers(world, me, mx, my);
        const scale = Math.min(1, ml) * this.moveScale;
        mx *= scale; my *= scale;
      }
    }
    inp.moveX = mx; inp.moveY = my;
    inp.afterburner = this.afterburn && !attached;

    // ---------- aim ----------
    let aim = Math.hypot(mx, my) > 0.1 ? Math.atan2(my, mx) : me.angle;
    let targetAim = NaN;
    let fire = false;
    if (tg && this.ringCount > 0) {
      const lag = Math.min(this.p.reactionTicks, this.ringCount - 1);
      const k = (this.ringHead - 1 - lag + RING * 2) % RING;
      const lagSec = lag * DT * this.p.lead;
      const px = this.rx[k] + this.rvx[k] * lagSec, py = this.ry[k] + this.rvy[k] * lagSec;
      let speed = this.wantSecondary && this.secondaryAimed ? this.secondarySpeed : st.gunSpeed;
      if (attached && me.shipClass === 'tech') speed = 0; // laser lance is hitscan
      let ax = px, ay = py;
      if (speed > 0) {
        const vx = this.rvx[k] - me.vx * BULLET_INHERIT, vy = this.rvy[k] - me.vy * BULLET_INHERIT;
        const tHit = interceptTime(px - me.x, py - me.y, vx, vy, speed);
        ax = px + vx * tHit * this.p.lead; ay = py + vy * tHit * this.p.lead;
      }
      // slowly drifting aim error
      this.aimOffset += this.rng.range(-0.1, 0.1) * this.p.aimError;
      this.aimOffset = clamp(this.aimOffset, -this.p.aimError * 1.5, this.p.aimError * 1.5);
      targetAim = Math.atan2(ay - me.y, ax - me.x) + this.aimOffset;
      aim = targetAim;

      const d = Math.hypot(tg.x - me.x, tg.y - me.y);
      const range = attached ? this.turretRange(me) : st.gunSpeed * st.gunLife * 0.95;
      const reacted = t >= this.acquireTick + this.p.reactionTicks;
      const tRad = 'kind' in tg ? (tg as Enemy).radius : (tg as Ship).stats.radius;
      const cone = Math.atan2(tRad + 6, Math.max(d, 1)) + this.p.fireSlack + st.gunSpread * 0.5 + (attached ? 0.1 : 0);
      const aligned = Math.abs(angleDiff(me.angle, aim)) < cone;
      if (attached) {
        fire = this.turretOffense && reacted && this.losOk && d < range && aligned;
      } else {
        const ef = efOf(me);
        const tgWeak = this.targetKind === 'ship' && (tg as Ship).energy < st.gunDamage * 2 && this.skill !== 'easy';
        const energyOk = me.energy > st.gunCost * st.gunCount * 2 && (ef > this.p.minFireFrac || tgWeak ||
          (this.mode === 'retreat' && d < 260 && ef > 0.15));
        fire = reacted && this.losOk && d < range && aligned && energyOk;
        if (this.wantSecondary && this.secondaryAimed && reacted && this.losOk && aligned) {
          inp.secondary = true;
          if (prev.secondary) this.wantSecondary = false; // held ≥ 2 ticks → fired (cooldown gates repeats)
        }
      }
    } else if (attached) {
      const host = world.ships.get(me.attachedTo);
      if (host) aim = host.angle;
    }
    if (!attached && this.wantSecondary && !this.secondaryAimed) {
      inp.secondary = true;
      if (prev.secondary) this.wantSecondary = false;
    }

    // ---------- aimed edge skills (mobility / utility) ----------
    // The sim reads input.aim / input.aimDist for every edge skill, so at most ONE aimed press owns
    // them per tick (mobility first). The other aimed press waits for its own turn and its own aim.
    const tgDist = tg ? Math.hypot(tg.x - me.x, tg.y - me.y) : DEFAULT_AIM_DIST;
    let aimDist = tgDist;
    let owner: PendingEdge | null = null;
    if (!attached) {
      if (this.mob.active && this.mob.aim !== null) owner = this.mob;
      else if (this.util.active && this.util.aim !== null) owner = this.util;
    }
    if (owner) {
      // a press that just got the aim (e.g. queued behind the other one) gets a fresh turn window
      if (owner !== this.aimOwner) owner.deadline = Math.max(owner.deadline, t + AIM_EDGE_TIMEOUT);
      const ea = owner.aim as number;
      aim = Number.isNaN(ea) ? (tg ? Math.atan2(tg.y - me.y, tg.x - me.x) : me.angle) : ea;
      aimDist = Number.isNaN(owner.dist) ? tgDist : owner.dist;
      fire = false;
      inp.secondary = inp.secondary && this.secondaryAimed === false;
    }
    this.aimOwner = owner;
    inp.aim = aim;
    inp.aimDist = clamp(aimDist, 0, 2000);
    inp.primary = fire;

    if (attached) {
      inp.secondary = this.turretDefense;
      this.mob.active = this.util.active = false;
    } else {
      inp.mobility = this.fireEdge(this.mob, prev.mobility, me, owner, aim, t);
      // Blink / Ram move us: an aimed utility planned from the old spot is stale, re-plan it next decision.
      if (inp.mobility && owner === this.mob && this.util.active && this.util.aim !== null && displacingMobility(me)) {
        this.util.active = false;
      }
      inp.utility = this.fireEdge(this.util, prev.utility, me, owner, aim, t);
    }

    // ---------- attach / detach edges (one tick high, never on consecutive ticks) ----------
    if (this.pulseAttach) {
      if (attached) this.pulseAttach = false;
      else {
        inp.attach = !prev.attach;
        inp.attachTarget = this.attachHost;
        if (inp.attach) this.pulseAttach = false;
      }
    }
    if (this.pulseDetach) {
      if (!attached) this.pulseDetach = false;
      else { inp.detach = !prev.detach; if (inp.detach) this.pulseDetach = false; }
    }

    this.out = inp;
    return inp;
  }

  /**
   * Emit a single-tick press. An aimed press goes out only on a tick where it owns input.aim, once the
   * hull faces that aim (or on its timeout); an un-aimed press (Iron Hide, Repair) goes out at once.
   */
  private fireEdge(e: PendingEdge, prevHeld: boolean, me: Ship, owner: PendingEdge | null, aim: number, t: number): boolean {
    if (!e.active || prevHeld) return false;
    if (e.aim !== null) {
      if (e !== owner) return false; // the other aimed press holds input.aim this tick
      if (Math.abs(angleDiff(me.angle, aim)) > 0.3 && t < e.deadline) return false;
    }
    e.active = false;
    return true;
  }

  private navDir(world: World, me: Ship, gx: number, gy: number, t: number): [number, number] {
    let wx = gx, wy = gy;
    if (!this.directLos && this.path && this.pathIdx < this.path.length) {
      wx = this.path[this.pathIdx]; wy = this.path[this.pathIdx + 1];
      if (Math.hypot(wx - me.x, wy - me.y) < 80 && this.pathIdx + 2 < this.path.length) {
        this.pathIdx += 2;
        wx = this.path[this.pathIdx]; wy = this.path[this.pathIdx + 1];
      }
    } else if (!this.directLos && !this.path && this.targetKind && t % 30 === this.phase) {
      // chasing a target without a path: request one toward it
      this.goalX = gx; this.goalY = gy;
      this.updatePath(world, me, t);
    }
    const dx = wx - me.x, dy = wy - me.y, d = Math.hypot(dx, dy);
    if (d < 1) return [0, 0];
    // slow down on arrival so we don't overshoot gems / waypoints
    const brake = d < 120 && (!this.path || this.pathIdx + 2 >= (this.path?.length ?? 0)) ? d / 120 : 1;
    return [(dx / d) * brake, (dy / d) * brake];
  }

  /** Velocity-aware arrival: thrust toward the velocity that closes on (gx, gy) at ≤ HOLD_ARRIVE_MAX_V, braking. */
  private arrive(me: Ship, gx: number, gy: number): [number, number] {
    const dx = gx - me.x, dy = gy - me.y, d = Math.hypot(dx, dy);
    const want = Math.min(HOLD_ARRIVE_MAX_V, d * HOLD_ARRIVE_GAIN);
    const wx = d > 1 ? (dx / d) * want : 0, wy = d > 1 ? (dy / d) * want : 0;
    const k = Math.max(1, me.stats.thrust * HOLD_ARRIVE_TAU);
    return [(wx - me.vx) / k, (wy - me.vy) / k];
  }

  /** Local wall avoidance: probe ahead, rotate the desired direction toward open space. */
  private whiskers(world: World, me: Ship, dx: number, dy: number): [number, number] {
    const map = world.map;
    const speed = Math.hypot(me.vx, me.vy);
    const look = clamp(me.stats.radius + 30 + speed * 0.2, 50, 150);
    if (!isSolidAt(map, me.x + dx * look, me.y + dy * look) &&
        !isSolidAt(map, me.x + dx * look * 0.5, me.y + dy * look * 0.5)) return [dx, dy];
    const base = Math.atan2(dy, dx);
    const offs = [0.6, 1.2, 1.8, 2.5];
    for (const o of offs) {
      for (const sgn of [this.strafeSign, -this.strafeSign]) {
        const a = base + o * sgn;
        const cx = Math.cos(a), cy = Math.sin(a);
        if (!isSolidAt(map, me.x + cx * look, me.y + cy * look)) return [cx, cy];
      }
    }
    return [-dx, -dy];
  }
}

/** Smallest positive t with |r + v t| = s t; falls back to straight-line time. */
export function interceptTime(rx: number, ry: number, vx: number, vy: number, s: number): number {
  const a = vx * vx + vy * vy - s * s;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  const straight = Math.sqrt(c) / Math.max(1, s);
  if (Math.abs(a) < 1e-6) {
    const tt = b !== 0 ? -c / b : straight;
    return tt > 0 ? Math.min(tt, 3) : straight;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return straight;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  let tt = Infinity;
  if (t1 > 0) tt = t1;
  if (t2 > 0 && t2 < tt) tt = t2;
  return tt === Infinity ? straight : Math.min(tt, 3);
}

/** True when this ship's mobility skill relocates it (Blink, Ram Charge) rather than acting in place. */
function displacingMobility(me: Ship): boolean {
  const id = SHIP_CLASSES[me.shipClass]?.skills.mobility.id;
  return id === 'blink' || id === 'ram';
}
