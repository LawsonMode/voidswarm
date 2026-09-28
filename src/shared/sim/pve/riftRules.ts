// OWNER: PVE agent. v0.3 Dungeon Runner encounter tuning + pure helpers (docs/v0.3-proposal.md §4.4–4.5).
// Leaf module (types only, no sim imports) so enemies.ts, bosses.ts, waves.ts and rift.ts can all share it without
// import cycles. Everything here is a pure function of its arguments.
import type { EnemyKind, GameMap, PveIntensity, RiftBiome, RiftRoom } from '../../types';

// ---- Pulses (§4.4) ----
/** spawnWarn radius / lead time; the formation spawns RIFT_PULSE_WARN_TICKS after the warning. */
export const RIFT_WARN_RADIUS = 90;
export const RIFT_WARN_SEC = 0.8;
export const RIFT_PULSE_WARN_TICKS = 48;
/** A pulse of `count` enemies uses ⌈count / RIFT_PULSE_PER_MARKER⌉ spawn markers. */
export const RIFT_PULSE_PER_MARKER = 6;
/** Markers at least this far from every ship are preferred. */
export const RIFT_MARKER_CLEAR_PX = 260;
/** Next pulse when the enemies alive in the room ≤ this share of the last pulse ... */
export const RIFT_NEXT_PULSE_FRAC = 0.3;
/** ... or this long after the last pulse spawned ... */
export const RIFT_PULSE_MAX_SEC = 14;
/** ... but never sooner than this. */
export const RIFT_PULSE_MIN_GAP_SEC = 3;
/** Blackholes (floor 5+) per room. */
export const RIFT_MAX_BLACKHOLES_PER_ROOM = 1;
/** Biome favourites get this weight multiplier (hive: drone / splitter; prism: spinner / weaver). */
export const RIFT_BIOME_BOOST = 1.5;
/** Key-room mini-boss on floors 4–5: a Hive at this HP share. */
export const RIFT_KEY_HIVE_HP = 0.8;

// ---- Leash + dormancy (§4.4) ----
/** Out of the enemy's own room, a ship is a valid target only this close AND in line of sight. */
export const RIFT_LEASH_PX = 900;
/** A dormant pack wakes when a ship is this close with line of sight (or on room entry / damage). */
export const RIFT_WAKE_PX = 600;
/** Instability hunters ignore the leash and look this far for prey. */
export const RIFT_HUNT_RANGE_PX = 2400;

// ---- Instability (§4.4) ----
/** Hunter pack cadence once the floor is past RIFT_SOFT_LIMIT_SEC. */
export const RIFT_HUNTER_EVERY_SEC = 25;
export const RIFT_HUNTER_MIN_PX = 700;
export const RIFT_HUNTER_MAX_PX = 1100;
/** Enemy HP +10% per minute past the soft limit (applied to rift spawns from then on). */
export const RIFT_INSTABILITY_HP_PER_MIN = 0.1;

export interface RiftDifficulty {
  /** Enemy HP multiplier. */
  hp: number;
  /** Encounter / pack size multiplier. */
  count: number;
  /** Party lives adjustment (SIM applies it at run start; Nightmare floors the pool at 2). */
  lives: number;
}

/** pveIntensity 1 Story · 2 Veteran · 3 Nightmare (§4.4). Anything else reads as Veteran. */
export const RIFT_DIFFICULTY: Readonly<Record<1 | 2 | 3, RiftDifficulty>> = {
  1: { hp: 0.7, count: 0.8, lives: 2 },
  2: { hp: 1, count: 1, lives: 0 },
  3: { hp: 1.4, count: 1.25, lives: -2 },
};

export function riftDifficulty(pve: PveIntensity | number): RiftDifficulty {
  return pve === 1 || pve === 2 || pve === 3 ? RIFT_DIFFICULTY[pve] : RIFT_DIFFICULTY[2];
}

function partyN(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
/** Encounter size × (1 + 0.3(n − 1)). */
export function partyCountMult(n: number): number { return 1 + 0.3 * (partyN(n) - 1); }
/** Enemy HP × (1 + 0.25(n − 1)). */
export function partyHpMult(n: number): number { return 1 + 0.25 * (partyN(n) - 1); }
/** Boss HP × (1 + 0.6(n − 1)). */
export function partyBossHpMult(n: number): number { return 1 + 0.6 * (partyN(n) - 1); }

/** Enemy tier of a floor: 1 + 2·(floor − 1) (same formula as floorgen.riftTier; kept local so PVE has no SIM dep). */
export function riftTierOf(floor: number): number {
  const f = Number.isFinite(floor) && floor >= 1 ? Math.floor(floor) : 1;
  return 1 + 2 * (f - 1);
}

/** spawnEnemy's tier HP scale: 1 + 0.12·(tier − 1). */
export function tierHpScale(tier: number): number {
  return 1 + 0.12 * Math.max(0, tier - 1);
}

/** Pulses per arena / key room: 3 on floors 1–3, 4 on floors 4+. */
export function riftPulsesPerRoom(floor: number): number {
  return floor >= 4 ? 4 : 3;
}

/** Solo Veteran pulse size: 8 + 2·floor. */
export function riftSoloPulseSize(floor: number): number {
  return 8 + 2 * Math.max(1, Math.floor(floor) || 1);
}

/** Pulse size in drone-equivalents: (8 + 2f) × party count mult × difficulty count mult, rounded (≥ 1). */
export function riftPulseSize(floor: number, partySize: number, pve: PveIntensity | number): number {
  return Math.max(1, Math.round(riftSoloPulseSize(floor) * partyCountMult(partySize) * riftDifficulty(pve).count));
}

/** Dormant hall pack size (4 + f), before the party / difficulty count multipliers. */
export function riftHallPackSize(floor: number): number {
  return 4 + Math.max(1, Math.floor(floor) || 1);
}

/** Floors 1–3 'hive', 4+ 'prism' (a layout carries its own biome; this is the fallback). */
export function riftBiomeOf(floor: number): RiftBiome {
  return floor <= 3 ? 'hive' : 'prism';
}

/**
 * Rift kind weights (replace waves.pickKind in rifts, §4.4): floor 1 drone 10 · dart 4 · weaver 3; floor 2+ adds
 * splitter 3 · spinner 2; floor 3+ brute 1.2; floor 5+ blackhole 0.3. Biome favourites ×1.5 (hive: drone, splitter;
 * prism: spinner, weaver). `allowBlackhole` false drops the blackhole row (max 1 per room).
 */
export function riftKindWeights(floor: number, biome: RiftBiome, allowBlackhole = true): [EnemyKind, number][] {
  const t: [EnemyKind, number][] = [['drone', 10], ['dart', 4], ['weaver', 3]];
  if (floor >= 2) t.push(['splitter', 3], ['spinner', 2]);
  if (floor >= 3) t.push(['brute', 1.2]);
  if (floor >= 5 && allowBlackhole) t.push(['blackhole', 0.3]);
  const fav: readonly EnemyKind[] = biome === 'hive' ? ['drone', 'splitter'] : ['spinner', 'weaver'];
  for (const row of t) if (fav.includes(row[0])) row[1] *= RIFT_BIOME_BOOST;
  return t;
}

/**
 * Pulse / pack budgets are in drone-equivalents; a formation of a heavier kind gets fewer bodies
 * (members = max(1, round(budget / cost))), so a "6-strong" brute formation is one brute, not six.
 */
export const RIFT_KIND_COST: Readonly<Record<EnemyKind, number>> = {
  drone: 1, dart: 1, weaver: 1, splitling: 1, splitter: 2, spinner: 2, brute: 5, blackhole: 6, hive: 20, matriarch: 50,
};

export function riftMembersFor(kind: EnemyKind, budget: number): number {
  return Math.max(1, Math.round(budget / RIFT_KIND_COST[kind]));
}

/** Enemy HP multiplier from instability: +10% per minute past the soft limit (continuous), 1 before it. */
export function riftInstabilityHpMult(floorSec: number, softLimitSec: number): number {
  return floorSec > softLimitSec ? 1 + RIFT_INSTABILITY_HP_PER_MIN * ((floorSec - softLimitSec) / 60) : 1;
}

/**
 * world.pve.mem key set once the boss room's Matriarch has died on this floor (world.pve.mem is reset by the floor
 * swap, and a regroup reset leaves it alone): she never respawns and her bossCache rolls at most once per floor.
 */
export function riftBossDownKey(room: number): string {
  return 'bossDown' + room;
}

/** Is (x, y) inside the room's walkable interior rect [c0, c1) × [r0, r1) (tiles → px)? */
export function inRoomRect(room: RiftRoom, tileSize: number, x: number, y: number): boolean {
  return x >= room.c0 * tileSize && x < room.c1 * tileSize && y >= room.r0 * tileSize && y < room.r1 * tileSize;
}

/**
 * Room index at (x, y), or −1 for corridors / outside every room / a map without a rift layout. Same answer as
 * floorgen.roomAt on room interiors; PVE keeps its own copy so it never depends on SIM's in-flight module.
 */
export function roomIndexAt(map: GameMap, x: number, y: number): number {
  const rooms = map.dungeon?.rooms;
  if (!rooms) return -1;
  const ts = map.tileSize;
  for (let i = 0; i < rooms.length; i++) if (inRoomRect(rooms[i], ts, x, y)) return rooms[i].idx;
  return -1;
}
