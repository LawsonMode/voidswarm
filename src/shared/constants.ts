// Frozen gameplay/network constants. Changing a value here is a contract change (see ARCHITECTURE.md).

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/** Snapshot every N sim ticks. Online = 3 (20 Hz); offline LocalTransport uses 1. */
export const SNAPSHOT_EVERY_ONLINE = 3;
export const SNAPSHOT_EVERY_LOCAL = 1;

/** Entities further than this from the viewer's camera focus are omitted from snapshots. */
export const INTEREST_RADIUS = 1700;
/** Client camera must never show further than this from its focus point (half-extent, world px). */
export const MAX_VIEW_HALF_EXTENT = 1500;

export const MAX_PLAYERS = 32;
export const MAX_TEAMS = 8;
export const MIN_TEAMS = 2;

/** team value for free-for-all ships (no allies). */
export const NO_TEAM = -1;
/** team value carried by PvE enemies and their projectiles. */
export const ENEMY_TEAM = 100;

export const MAP_TILE = 32;
/** World size in px. Coordinates are quantized to 1/8 px in uint16 on the wire, so must stay < 8192. */
export const MAP_SIZE = 6400;

export const MAX_ENEMIES = 350;
export const MAX_PROJECTILES = 1500;
export const MAX_GEMS = 600;

export const RESPAWN_SEC = 3;
export const SPAWN_INVULN_SEC = 2;
export const ATTACH_COOLDOWN_SEC = 3;
/** Attaching (warping onto a teammate as a turret) requires at least this fraction of max energy. */
export const ATTACH_MIN_ENERGY_FRAC = 0.5;
/** Turrets recharge energy faster while attached. */
export const TURRET_RECHARGE_MULT = 1.5;
/** Host max speed & thrust are multiplied by (1 - this * turretCount), floored at 0.5. */
export const HOST_SPEED_PENALTY_PER_TURRET = 0.07;

/** Turret offense draws HOST energy; it stops when the host is below this fraction of max energy. */
export const TURRET_HOST_FLOOR_FRAC = 0.2;
/** Laser resonance: each laser beam on a host deals × LASER_RESONANCE^(firingLasers - 1) and draws the same factor. */
export const LASER_RESONANCE = 1.5;

/** Level-up schedule: path fork at PATH_LEVEL, path talents at TALENT_LEVELS, general cards otherwise. */
export const PATH_LEVEL = 3;
export const TALENT_LEVELS: readonly number[] = [6, 9, 12, 15];

/** Orbit Blades (auto-weapon) geometry — the sim and the renderer MUST both use these. */
export const ORBIT_RADIUS = 70;
export const ORBIT_SPEED = 3.2; // rad/s
/** Blade i of n on a ship at tick t sits at angle: ORBIT_SPEED * t/TICK_RATE + i * 2π / n (world space). */

export const DEFAULT_PORT = 7777;
export const NAME_MAX_LEN = 16;
export const CHAT_MAX_LEN = 200;
export const CHAT_HISTORY = 100;

export const COUNTDOWN_SEC = 3;
export const RESULTS_SEC = 12;

// ---- v0.3 game types / Command ----
/** Pilots per Dungeon Runner party (team == party). */
export const PARTY_SIZE = 4;
/** Contract ceiling on rift parties (Rival Rift, v0.4). v0.3 co-op uses 1. */
export const MAX_PARTIES = 2;
/** Extra room slots usable only by spectators (Command "Watch"). */
export const SPECTATOR_SLOTS = 4;
/** While any room is playing, the zone re-pushes the room list (live timers / scores) this often. */
export const ROOM_LIST_LIVE_SEC = 5;
/** Online: max rooms in countdown/playing at once (single-threaded tick budget). */
export const MAX_PLAYING_ROOMS = 6;
/** A countdown/playing room with no humans (spectators included) for this long returns to its lobby. */
export const BOTS_ONLY_ABORT_SEC = 10;
/** Quick Play skips timed matches with less than this left. */
export const QUICKPLAY_MIN_TIME_LEFT_SEC = 90;

// ---- v0.3 Dungeon Runner (rift) ----
/** Boss + extraction every Nth floor. */
export const RIFT_BOSS_EVERY = 3;
/** Floors per run. v0.4 appends 9. */
export const RIFT_FLOOR_OPTIONS: readonly number[] = [3, 6];
export const RIFT_RESPAWN_SEC = 5;
export const RIFT_FLOOR_INVULN_SEC = 3;
/** Seconds on one floor before rift instability (hunter packs). */
export const RIFT_SOFT_LIMIT_SEC = 420;
export const RIFT_LIVES_CAP = 12;
/** A sealed room with no alive sealing-party ship inside for this long resets (regroup). */
export const RIFT_REGROUP_SEC = 2;

// ---- v0.3 loot ----
/** World cap on in-world caches (evicts oldest lowest-rarity below epic). */
export const MAX_LOOT = 64;
/** Unsecured caches one ship can carry (arena / warzone). */
export const MAX_CARRIED = 8;
/** ... in a Dungeon Runner (extraction is every 3rd floor). */
export const MAX_CARRIED_DUNGEON = 24;
/** Pickup distance = ship radius + this (px). No magnet. */
export const LOOT_PICKUP_PAD = 22;
export const LOOT_LIFE_SEC = 90;
export const LOOT_SPILL_LIFE_SEC = 45;
/** Non-ally killer priority on spilled caches. */
export const LOOT_SPILL_RESERVE_SEC = 2;
/** A carrier shows on every radar with ≥ this many caches ... */
export const LOOT_BEACON_COUNT = 4;
/** ... or any cache of at least this rarity (epic). */
export const LOOT_BEACON_RARITY = 3;
