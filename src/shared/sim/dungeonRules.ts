// OWNER: SIM agent. v0.3 Dungeon Runner rules + tuning shared by SIM, AI, CLIENT and RENDER
// (docs/v0.3-proposal.md §4.2–4.7). Leaf module: types + constants only, no sim imports, so any module
// (renderer zone rings, bot goals, HUD) can read it without pulling in the simulation.
import type { RiftRoom, RiftRoomKind } from '../types';

// ---- floor geometry (§4.2; floorgen.ts) ----
/** Macro grid: RIFT_CELLS × RIFT_CELLS cells of RIFT_CELL_TILES tiles (4 × 50 = the 200-tile map). */
export const RIFT_CELLS = 4;
export const RIFT_CELL_TILES = 50;
/** Room rim thickness (TILE_WALL), tiles. */
export const RIFT_RIM_TILES = 2;
/** Corridor width, tiles (a sealable room's doorway is RIFT_CORRIDOR_TILES × RIFT_RIM_TILES). */
export const RIFT_CORRIDOR_TILES = 5;
/** A door band starts at least this many tiles from a room corner. */
export const RIFT_DOOR_CORNER_TILES = 4;
/** RiftDoor.inX/inY: the centre of the 3rd interior tile behind the doorway. */
export const RIFT_DOOR_IN_TILES = 3;
/** Party spawn ring in the entrance (6 per party). */
export const RIFT_PARTY_SPAWN_R = 110;
/** Sealable-room chest: room centre + (0, this). */
export const RIFT_CHEST_OFFSET_PX = 128;
/** Treasure chests: centre ± this × half-size (across the doorway axis). */
export const RIFT_TREASURE_CHEST_FRAC = 0.4;
/** Boss floors: the Extract portal sits this far from the boss-room centre, away from its door. */
export const RIFT_EXTRACT_OFFSET_PX = 352;

// ---- room state machine (§4.3; dungeon.ts) ----
/** DORMANT → ARMING → SEALED after this long (cannot be cancelled). */
export const RIFT_ARM_SEC = 1.5;
/** A ship triggers a sealable room once it is this many tiles inside the interior (boss: RIFT_BOSS_TRIGGER_INSET). */
export const RIFT_TRIGGER_INSET = 3;
export const RIFT_BOSS_TRIGGER_INSET = 5;
/** Seal: bodies overlapping a door tile move to that door's in-point ± this (px). */
export const RIFT_NUDGE_JITTER = 40;
/** Seal recall: party ships outside land on a ring of this radius (px) around a door in-point. */
export const RIFT_RECALL_MIN_R = 50;
export const RIFT_RECALL_MAX_R = 90;
/** Respawn jitter around the respawn anchor / in-point (px). */
export const RIFT_SPAWN_MIN_R = 60;
export const RIFT_SPAWN_MAX_R = 120;
/** Room clear: +score and grantXp(RIFT_CLEAR_XP_PER_TIER · tier) for each party ship inside. */
export const RIFT_CLEAR_SCORE = 25;
export const RIFT_CLEAR_XP_PER_TIER = 12;
/** Respawn anchor after a clear: room centre + (0, this). */
export const RIFT_ANCHOR_OFFSET_Y = -120;
/** A ship this close (centre to chest, px) opens an unopened chest. */
export const RIFT_CHEST_OPEN_R = 48;

// ---- lives (§4.6) ----
/** Run start: RIFT_LIVES_BASE + RIFT_LIVES_PER_PILOT · party size (+ difficulty), never below RIFT_LIVES_MIN. */
export const RIFT_LIVES_BASE = 2;
export const RIFT_LIVES_PER_PILOT = 2;
export const RIFT_LIVES_MIN = 2;
/** Lives added by a boss kill (capped at RIFT_LIVES_CAP). */
export const RIFT_BOSS_LIVES = 2;

// ---- portals, extraction, run end (§4.7) ----
/** Descend zone radius (px) and countdowns (s). */
export const RIFT_PORTAL_R = 160;
export const RIFT_DEPART_SEC = 20;
/** The countdown drops to this once every alive human stands in the zone. */
export const RIFT_DEPART_ALL_SEC = 3;
/**
 * A human already inside the Descend zone when it opens (the boss / key fight ends on top of it) does not start the
 * countdown until it leaves the zone and comes back, or this long passes: the bank-or-push-deeper choice stays open.
 */
export const RIFT_PORTAL_HOLD_SEC = 10;
export const RIFT_DESCEND_SCORE = 50;
/** Extract zone radius (px); a human channels RIFT_EXTRACT_TICKS in the zone (decays 2× as fast outside). */
export const RIFT_EXTRACT_R = 140;
export const RIFT_EXTRACT_TICKS = 180;
export const RIFT_EXTRACT_DECAY = 2;
export const RIFT_EXTRACT_SCORE = 100;
/** Final floor: the run ends this long after the last boss falls (the victory lap). */
export const RIFT_VICTORY_SEC = 45;
/**
 * Instability (PVE, pve/rift.ts): the HUD shows its warning this long before RIFT_SOFT_LIMIT_SEC, derived from
 * RiftView.floorSec — no event is sent for the warning. The `instability` event itself fires at the onset and with
 * every hunter pack that spawns; its `sec` is the time to the next pack.
 */
export const RIFT_INSTABILITY_WARN_SEC = 60;

/** Arena, key and boss rooms seal their doors; the others never do. */
export function isSealableKind(kind: RiftRoomKind): boolean {
  return kind === 'arena' || kind === 'key' || kind === 'boss';
}

/** (x, y) px inside the room interior shrunk by `insetTiles` on every side (tile size `ts`). */
export function inRoomInterior(room: RiftRoom, ts: number, x: number, y: number, insetTiles = 0): boolean {
  return x >= (room.c0 + insetTiles) * ts && x < (room.c1 - insetTiles) * ts &&
    y >= (room.r0 + insetTiles) * ts && y < (room.r1 - insetTiles) * ts;
}
