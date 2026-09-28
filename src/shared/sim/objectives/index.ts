// OWNER: OBJECTIVES agent. Objective sub-modes (CTF / Control Zones / Hot Point) — docs/v0.3-proposal.md §5.
// Signatures are frozen (§8.8). Every hook returns its NEUTRAL value when world.objective is absent / null
// (deathmatch, rifts, escort — reserved for v0.4), so a deathmatch tick is exactly the v0.2 tick.
//
// Modules: ctf.ts (§5.3), zones.ts (§5.4 + §5.5), features.ts (§5.1 geometry), view.ts (MatchView.objective),
// common.ts (stats / score credit / events / winner helpers), rules.ts (shared tuning).
// Determinism: nothing here draws from world.rng or Math.random (features: their own seeded Rng; the next hot
// site and FFA hot spawns: Rng(hash32(world state))). Loot goes through sim/loot.ts rollLoot (its own lootRng).
//
// Match flow: Sim.stepMatch mirrors objective.teamPoints into match.teamScores, calls objectiveEndCheck, and on
// 'ended' flips the phase and emits matchEnd once; objectiveEndCheck only records the winner (and may extend
// match.endTick for sudden death / tie extensions).
import { isObjectiveSubMode, objectiveTarget } from '../../data/gameTypes';
import type { ObjectiveState, ObjectiveView, Ship, World } from '../../types';
import { subModeOf } from '../world';
import { ctfEndCheck, ctfRechargeMult, ctfRelease, ctfSpeedMult, flagCarriedBy, initCtf, stepCtf } from './ctf';
import { placeObjectiveFeatures } from './features';
import { buildView } from './view';
import { hotEndCheck, hotSpawnPoint, initHot, initZones, stepHot, stepZones, zonesEndCheck } from './zones';
import { CTF_CARRIER_MAX_TURRETS } from './rules';

export { placeObjectiveFeatures } from './features';

/**
 * Sets world.objective (null for deathmatch / dungeon / escort). Called by the Sim constructor after pveInit.
 * The map normally already has its features (buildMatchMap); a map without them gets them placed here.
 */
export function objectivesInit(world: World): void {
  const sub = subModeOf(world.config);
  if (world.dungeon || !isObjectiveSubMode(sub) || sub === 'escort') {
    world.objective = null;
    return;
  }
  if (!world.map.features) placeObjectiveFeatures(world.map, sub, world.config.mapSeed);
  const teams = world.config.mode === 'teams';
  const o: ObjectiveState = {
    mode: sub,
    limit: objectiveTarget(sub, world.config.mode, world.config.objectiveLimit ?? 0),
    teamPoints: teams ? new Array(Math.max(0, world.config.teamCount)).fill(0) : [],
    playerPoints: new Map(),
    flags: [], zones: [], hot: null,
    overtime: false, overtimeCapTick: 0, suddenDeath: false, extensions: 0,
    stats: new Map(), mem: {},
  };
  if (sub === 'ctf') initCtf(world, o);
  else if (sub === 'zones') initZones(world, o);
  else initHot(world, o);
  world.objective = o;
}

/** Per tick, after stepProjectiles (and after pass 3, so SHIPFLAG_CARRIER survives into the snapshot). */
export function stepObjectives(world: World): void {
  const o = world.objective;
  if (!o) return;
  if (o.mode === 'ctf') stepCtf(world, o);
  else if (o.mode === 'zones') stepZones(world, o);
  else if (o.mode === 'hotpoint') stepHot(world, o);
}

/** stepMatch delegate when world.objective is set; records the winner on 'ended'. Neutral: 'continue'. */
export function objectiveEndCheck(world: World): 'continue' | 'ended' {
  const o = world.objective;
  if (!o || world.match.phase !== 'playing') return 'continue';
  // Mirror first (Sim does it too): results never fall back to kill sums.
  const ts = world.match.teamScores;
  for (let t = 0; t < ts.length; t++) ts[t] = o.teamPoints[t] ?? 0;
  if (o.mode === 'ctf') return ctfEndCheck(world, o);
  if (o.mode === 'zones') return zonesEndCheck(world, o);
  if (o.mode === 'hotpoint') return hotEndCheck(world, o);
  return 'continue';
}

/** Respawn point override: FFA Hot Point avoids the active site. Neutral: null = default spawn point. */
export function objectiveSpawnPoint(world: World, ship: Ship): { x: number; y: number } | null {
  const o = world.objective;
  if (!o || o.mode !== 'hotpoint') return null;
  return hotSpawnPoint(world, o, ship);
}

/** Drop anything the ship carries (flag) at its current position: respawn, class swap, team swap, leave. */
export function objectiveRelease(world: World, ship: Ship): void {
  const o = world.objective;
  if (o && o.mode === 'ctf') ctfRelease(world, o, ship);
}

/** The ship is carrying an enemy flag. Neutral: false. */
export function isCarrier(world: World, ship: Ship): boolean {
  const o = world.objective;
  return !!o && o.mode === 'ctf' && !!flagCarriedBy(o, ship.id);
}

/** Pass 1 speed multiplier (carrier ×CTF_CARRIER_SPEED_MULT; the gunner's host penalty stacks on top). Neutral: 1. */
export function objSpeedMult(world: World, ship: Ship): number {
  const o = world.objective;
  return o && o.mode === 'ctf' ? ctfSpeedMult(o, ship) : 1;
}

/** Pass 3 recharge multiplier (Flag Overload: ×0.5 after 60 s of carry, ×0 after 90 s). Neutral: 1. */
export function objRechargeMult(world: World, ship: Ship): number {
  const o = world.objective;
  return o && o.mode === 'ctf' ? ctfRechargeMult(world, o, ship) : 1;
}

/** Turret slots a host may use (carrier: CTF_CARRIER_MAX_TURRETS, the gunner seat). Neutral: host.stats.maxTurrets. */
export function objMaxTurrets(world: World, host: Ship): number {
  const max = host.stats.maxTurrets;
  const o = world.objective;
  if (o && o.mode === 'ctf' && flagCarriedBy(o, host.id)) return Math.min(max, CTF_CARRIER_MAX_TURRETS);
  return max;
}

/**
 * Swarm spawn anchors for findSpawnCenter (§5.6, ARCHITECTURE "Warzone Control Zones"): every active Control
 * Zone, weight 2. [] for every other mode (Hot Point is Arena-only in v0.3, so it never has a swarm).
 * findSpawnCenter applies the pveIntensity > 0 gate itself.
 */
export function objectiveAnchors(world: World): { x: number; y: number; weight: number }[] {
  const o = world.objective;
  if (!o || o.mode !== 'zones') return [];
  const out: { x: number; y: number; weight: number }[] = [];
  for (const z of o.zones) if (z.active) out.push({ x: z.x, y: z.y, weight: 2 });
  return out;
}

/** MatchView.objective. Neutral: undefined. */
export function buildObjectiveView(world: World): ObjectiveView | undefined {
  const o = world.objective;
  return o ? buildView(world, o) : undefined;
}
