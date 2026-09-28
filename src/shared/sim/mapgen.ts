// OWNER: SIM agent. v0.3 match map dispatcher — the ONLY map entry point for Sim and GameClient.
// The signature is frozen (docs/v0.3-proposal.md §8.8).
import { isObjectiveSubMode } from '../data/gameTypes';
import type { GameMap, GameType, SubMode } from '../types';
import { generateFloor } from './floorgen';
import { generateMap } from './map';
import { placeObjectiveFeatures } from './objectives/index';

export interface MatchMapParams {
  seed: number;
  gameType: GameType;
  subMode: SubMode;
  /** 0 = FFA */
  teamCount: number;
  /** dungeon 1-based; else 0 */
  floor: number;
}

/**
 * Arena / Warzone: generateMap(seed, teamCount), then placeObjectiveFeatures(map, subMode, seed) for
 * objective sub-modes (ctf / zones / hotpoint; escort is v0.4).
 * Dungeon: generateFloor(seed, floor, teamCount). Deterministic; both hosts call it.
 *
 * Pass the values the Sim normalized (sim.world.config: gameType, subMode, and teamCount — 0 in FFA), so a
 * fallen-back combo builds the same map on the client as on the server.
 */
export function buildMatchMap(p: MatchMapParams): GameMap {
  const teams = Math.max(0, Math.floor(Number.isFinite(p.teamCount) ? p.teamCount : 0));
  if (p.gameType === 'dungeon') {
    // Rift floors are regenerated from (seed, floor) on both hosts; the party count feeds the floor seed.
    return generateFloor(p.seed, Math.max(1, Math.floor(p.floor) || 1), Math.max(1, teams));
  }
  // Arena / Warzone: v0.2 maps, byte-identical; objective sub-modes then add map.features (§5.1).
  // placeObjectiveFeatures uses its own Rng from the seed and carves only WALL/ROCK → EMPTY (never
  // TILE_BASE or the border), so deathmatch maps are untouched and both hosts build the same features.
  const map = generateMap(p.seed, teams);
  if (isObjectiveSubMode(p.subMode)) placeObjectiveFeatures(map, p.subMode, p.seed);
  return map;
}
