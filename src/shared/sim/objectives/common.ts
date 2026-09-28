// OWNER: OBJECTIVES agent. Helpers shared by sim/objectives/* (not part of the frozen contract).
import { NO_TEAM } from '../../constants';
import type {
  EntityId, GameEvent, ObjectiveEventKind, ObjectivePlayerStats, ObjectiveState, PlayerId, Ship, TeamId, World,
} from '../../types';
import { emit } from '../world';

/**
 * Objectives-private per-match side state (never serialized, never read by other modules). Keyed by the
 * ObjectiveState object, so a fresh objectivesInit starts clean.
 */
export interface ObjSide {
  /** world.events array last scanned for shipDeath (Sim.drainEvents swaps the array) and how far. */
  evArr: GameEvent[] | null;
  evIdx: number;
  /** CTF: ship id → first tick it may take a flag again (forced drop while alive, CTF_REPICK_SEC). */
  noPickup: Map<EntityId, number>;
  /**
   * CTF: flag team → the carry clock of a flag released by a still-alive carrier (class / team swap, leave).
   * The releasing team re-taking that flag before it goes home keeps the old clock, so a swap can't reset
   * Flag Overload for the team (a teammate standing next to the swapper would otherwise start a fresh 60 s).
   */
  keepCarry: Map<number, { team: number; pickedAtTick: number }>;
  /** Zones / hot point, per zone slot (index into ObjectiveState.zones): playerId → last tick inside. */
  present: Map<PlayerId, number>[];
  /** Per zone slot: playerId → ticks spent inside since the zone last flipped (top contributor / lead capper). */
  work: Map<PlayerId, number>[];
  /** Per zone slot: the owner side a neutralize took the zone from (none = no flip pending). */
  flippedFrom: number[];
}

const sides = new WeakMap<ObjectiveState, ObjSide>();

export function objSide(o: ObjectiveState): ObjSide {
  let s = sides.get(o);
  if (!s) {
    s = { evArr: null, evIdx: 0, noPickup: new Map(), keepCarry: new Map(), present: [], work: [], flippedFrom: [] };
    sides.set(o, s);
  }
  return s;
}

/**
 * Visit the events emitted since the previous call (this tick's shipDeath, …); survives Sim.drainEvents
 * (which swaps the array). Events `fn` itself emits are not revisited.
 */
export function forFreshEvents(world: World, o: ObjectiveState, fn: (e: GameEvent) => void): void {
  const sd = objSide(o), ev = world.events;
  if (sd.evArr !== ev || sd.evIdx > ev.length) { sd.evArr = ev; sd.evIdx = 0; }
  const end = ev.length;
  for (let i = sd.evIdx; i < end; i++) fn(ev[i]);
  sd.evIdx = ev.length; // skip whatever fn emitted itself
}

export function emptyStats(): ObjectivePlayerStats {
  return { caps: 0, steals: 0, returns: 0, carrierKills: 0, zoneCaps: 0, neutralizes: 0, objTicks: 0, hotHoldTicks: 0 };
}

/** Per-player objective stats (keyed by playerId, so a leaver keeps them for the results screen). */
export function statsFor(o: ObjectiveState, pid: PlayerId): ObjectivePlayerStats {
  let s = o.stats.get(pid);
  if (!s) { s = emptyStats(); o.stats.set(pid, s); }
  return s;
}

export function shipOfPid(world: World, pid: PlayerId): Ship | undefined {
  if (!(pid > 0)) return undefined;
  const id = world.shipsByPlayer.get(pid);
  return id ? world.ships.get(id) : undefined;
}

/** Personal score credit (ship.score) — only while the match is running. */
export function credit(world: World, ship: Ship | undefined, pts: number): void {
  if (!ship || world.match.phase !== 'playing' || !(pts > 0)) return;
  ship.score += pts;
}

export function isFfa(world: World): boolean {
  return world.config.mode !== 'teams';
}

/**
 * Emit an `objective` event (global). Field meaning per kind (documented for ROOM chat / CLIENT HUD / RENDER):
 * - flagTaken     team = carrier's team, playerId = carrier, index = flag's team, value = 1 from its stand (a steal) / 0 re-picked
 * - flagDropped   team = carrier's team, playerId = carrier, index = flag's team, value = seconds until auto-return
 * - flagReturned  team = flag's team, playerId = returner (0 = auto-return), index = flag's team, value = 1 auto / 0 touch
 * - flagCaptured  team = capturing team, playerId = carrier, index = captured flag's team, value = the team's captures now
 * - zoneCaptured  team = new owner (FFA hot: -1), playerId = capper, index = zone index (hot: site), value = side it was
 *                 taken from (team; FFA hot: playerId; -1 / 0 = was neutral)
 * - zoneNeutralized team = neutralizing team (FFA: -1), playerId = capper, index = zone / site, value = previous owner
 *                 (team; FFA hot: playerId)
 * - hotWarn       index = next site, x / y = next site, value = seconds until the move
 * - hotMoved      index = new site, x / y = new site, value = moves so far
 * - overtime      zones: a tie extension (index = extension number, value = seconds added); hot: time-out overtime
 *                 (index 0, value = cap seconds)
 * - suddenDeath   CTF tie at time-out (value = seconds added)
 */
export function emitObjective(
  world: World, kind: ObjectiveEventKind, team: TeamId, playerId: PlayerId, index: number, x: number, y: number, value: number,
): void {
  emit(world, { t: 'objective', kind, team, playerId, index, x: Math.round(x), y: Math.round(y), value });
}

/** Index of the unique maximum, or -1 on a tie / empty. */
export function uniqueTop(values: readonly number[]): number {
  let best = -1, bestV = -Infinity, tie = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v > bestV) { bestV = v; best = i; tie = false; }
    else if (v === bestV) tie = true;
  }
  return tie ? -1 : best;
}

/** Top personal scorer (MVP) when unique, else 0 — the deathmatch meaning of match.winnerPlayerId. */
export function mvpPid(world: World): PlayerId {
  let top: Ship | null = null, topScore = -Infinity, tie = false;
  for (const s of world.ships.values()) {
    if (s.score > topScore) { topScore = s.score; top = s; tie = false; }
    else if (s.score === topScore) tie = true;
  }
  return top && !tie ? top.playerId : 0;
}

/** Record the winner (Sim.stepObjectiveMatch closes the match and emits matchEnd once on 'ended'). */
export function setWinner(world: World, team: TeamId, pid: PlayerId): 'ended' {
  world.match.winnerTeam = team >= 0 ? team : NO_TEAM;
  world.match.winnerPlayerId = pid > 0 ? pid : 0;
  return 'ended';
}

export function timeUp(world: World): boolean {
  const m = world.match;
  return m.endTick > 0 && world.tick >= m.endTick;
}
