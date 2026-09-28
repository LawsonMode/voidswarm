// OWNER: SIM agent. Sim-private per-world side state (never serialized, never read by other modules).
import type { Deployable, EntityId, World } from '../types';
import { Rng } from '../util/rng';

export interface SideState {
  /** Ram Charge: ids already hit during the current charge, per charging ship. */
  ramHits: Map<EntityId, Set<EntityId>>;
  /** Piercing projectiles: every body already hit (a piercing projectile hits each body at most once). */
  pierceMem: Map<EntityId, Set<EntityId>>;
  /** Per-tick scratch: deployables that block / absorb projectiles (walls, sentries, drones). */
  blockers: Blocker[];
  blockerCount: number;
  /** Per grid cell (world.grid layout): indices into `blockers`. */
  blockerCells: number[][];
  /** Cells touched this tick (cleared next build). */
  blockerUsed: number[];

  // ---- v0.3 loot (sim/loot.ts) ----
  /**
   * The ONLY randomness loot uses: seeded from SimConfig.lootSeed (server-only crypto, never sent), so
   * world.rng is never consumed by loot and the v0.2 determinism of a lootMult-0 match is untouched.
   */
  lootRng: Rng;
  /** Non-personal caches spawned this match (arena / warzone match cap). */
  lootSpawned: number;
  /** Dungeon: non-personal caches spawned on `lootFloor` (per-floor cap; resets when the floor changes). */
  lootFloorSpawned: number;
  lootFloor: number;

  // ---- v0.3 rift (sim/dungeon.ts) ----
  /** Bit per party (team) whose starting lives were counted (lazily, once the party has ships). */
  riftLivesSet: number;
  /**
   * Descend hold: humans already standing in the Descend zone when it opened (a boss / key fight ends on top of
   * it). They do not start the countdown until they leave the zone or `riftPortalHoldUntil` passes.
   */
  riftPortalHeld: Set<EntityId>;
  riftPortalHoldUntil: number;
}

/** Precomputed blocker geometry (walls as segments a→b; others as circles at a). */
export interface Blocker {
  d: Deployable;
  wall: boolean;
  ax: number; ay: number; bx: number; by: number;
  minX: number; minY: number; maxX: number; maxY: number;
}

const sides = new WeakMap<World, SideState>();

export function side(world: World): SideState {
  let s = sides.get(world);
  if (!s) {
    const n = world.grid.cols * world.grid.rows;
    s = {
      ramHits: new Map(), pierceMem: new Map(), blockers: [], blockerCount: 0,
      blockerCells: Array.from({ length: n }, () => []), blockerUsed: [],
      lootRng: new Rng(world.config.lootSeed ?? 0), lootSpawned: 0, lootFloorSpawned: 0, lootFloor: 0,
      riftLivesSet: 0, riftPortalHeld: new Set(), riftPortalHoldUntil: 0,
    };
    sides.set(world, s);
  }
  return s;
}
