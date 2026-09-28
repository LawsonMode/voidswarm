// FROZEN CONTRACT — shared data types for sim, server, bots, and client.
// Changing a shape here is a contract change: update ARCHITECTURE.md and tell every module owner.

import type { Rng } from './util/rng';

export type EntityId = number; // 0 = none
export type PlayerId = number; // 1..n, unique per server process; 0 = none
/** 0..7 for teams, NO_TEAM (-1) in FFA, ENEMY_TEAM (100) for PvE. */
export type TeamId = number;

export type GameMode = 'ffa' | 'teams';
export type BotSkill = 'easy' | 'normal' | 'hard';
/** 0 = off, 1 = low, 2 = normal, 3 = chaos */
export type PveIntensity = 0 | 1 | 2 | 3;

// v0.2: three Diablo-style classes, each with three build paths (see data/ships.ts).
export type ShipClassId = 'brute' | 'tech' | 'engineer';
export type PathId =
  | 'ram' | 'barrage' | 'bulwark' // brute
  | 'storm' | 'void' | 'lance' // tech
  | 'summoner' | 'medic' | 'architect'; // engineer
/** The four active skills: LMB primary, RMB secondary, Space mobility, E utility. */
export type SkillSlot = 'primary' | 'secondary' | 'mobility' | 'utility';
export type SkillId =
  | 'autocannon' | 'rockets' | 'ram' | 'ironhide' // brute
  | 'plasma' | 'arc' | 'blink' | 'singularity' // tech
  | 'rivet' | 'sentry' | 'repair' | 'wall' // engineer
  // v0.5 capital skills: replace the mobility (Space) skill while the ship hosts ≥ 1 turret
  | 'broadside' | 'overcharge' | 'repairbay';
/** Placed/summoned objects owned by a ship. */
export type DeployableKind =
  | 'sentry' // engineer turret: fires seekers
  | 'wall' // engineer barrier segment: blocks hostile projectiles + enemies
  | 'well' // tech singularity: pulls + damages
  | 'drone' // summoner combat drone: follows owner, shoots
  | 'fire' // barrage napalm patch: damage over time
  | 'nanite'; // medic healing cloud

/** Append-only: codec ENEMY_KINDS follows this order. */
export type EnemyKind =
  | 'drone' // slow homing chaser — the bread-and-butter swarm unit
  | 'dart' // pauses, then dashes in a straight line
  | 'weaver' // dodges incoming projectiles while approaching
  | 'splitter' // on death splits into 3 splitlings
  | 'splitling'
  | 'spinner' // keeps distance, fires enemyShot spirals
  | 'blackhole' // gravity well: pulls ships/gems/projectiles, grows when fed, pops violently
  | 'brute' // big, slow, lots of HP
  | 'hive' // boss — spawns drones, fires rings
  | 'matriarch'; // v0.3 Dungeon Runner boss (floors 3 and 6). v0.4 appends 'warden' | 'prism' | 'leviathan'.

export type ProjectileKind =
  | 'bullet' // ship gun
  | 'bomb' // ship bomb (splash, may bounce off walls)
  | 'mine' // stationary splash, arms after 0.5 s
  | 'shrapnel' // burst ability / bomb fragments
  | 'seeker' // homing auto-weapon missile
  | 'enemyShot' // PvE projectile
  | 'rocket' // brute Rocket Salvo (splash, mild homing)
  | 'plasma' // tech Plasma Bolt primary
  | 'singularity'; // tech utility in flight; becomes a 'well' deployable on arrival
// Note: brute/engineer primaries are 'bullet' (renderer styles them by owner class).

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/**
 * Sent by the client once per client-side fixed tick (TICK_RATE). The server queues inputs per ship
 * (max 8) and consumes exactly one per sim tick in seq order; when the queue is empty it holds the
 * last input, and a standing surplus is drained only by skipping inputs whose buttons equal the next
 * one (so presses are never lost). Snapshot.ackSeq is the seq actually applied. Buttons are levels
 * (held); the sim derives rising edges itself by comparing against ship.prevInput.
 */
export interface InputState {
  seq: number;
  /** World-relative thrust direction, each -1..1, vector magnitude ≤ 1 (twin-stick style). */
  moveX: number;
  moveY: number;
  /** Desired facing / aim, radians, world space (0 = +x, π/2 = +y which is DOWN on screen). */
  aim: number;
  /**
   * Distance (px) from the ship to the aim point (cursor / stick reticle), 0..2000. The sim uses
   * aimX = ship.x + cos(aim)·aimDist for targeted skills (Singularity destination, Arc first-target
   * search, sentry/wall placement). Gamepad: a fixed reach (~320 px) scaled by stick deflection.
   */
  aimDist: number;
  /** LMB / RT — held auto-repeats. */
  primary: boolean;
  /** RMB / RB — held auto-repeats at its cooldown. */
  secondary: boolean;
  /** Space / A — rising edge. */
  mobility: boolean;
  /** E / LB — rising edge. */
  utility: boolean;
  afterburner: boolean;
  /** Rising edge = attach as turret. If already a turret, rising edge = detach. */
  attach: boolean;
  /** Preferred host ship id (the teammate under the cursor); 0 = auto-pick nearest teammate to aim point. */
  attachTarget: EntityId;
  /** Rising edge = host shakes off all its turrets / turret detaches. */
  detach: boolean;
}

export function emptyInput(): InputState {
  return {
    seq: 0, moveX: 0, moveY: 0, aim: 0, aimDist: 300,
    primary: false, secondary: false, mobility: false, utility: false,
    afterburner: false, attach: false, attachTarget: 0, detach: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Ship stats & classes
// ---------------------------------------------------------------------------------------------

/** Effective per-ship numbers. Units: px, px/s, px/s², seconds, radians. Energy is BOTH health and ammo. */
export interface ShipStats {
  radius: number;
  maxEnergy: number;
  rechargePerSec: number;
  thrust: number;
  maxSpeed: number;
  afterburnerSpeed: number;
  afterburnerCostPerSec: number;
  turnRate: number;

  // --- primary weapon (LMB): "gun*" = the class's primary ---
  gunDamage: number;
  gunCost: number;
  gunSpeed: number;
  gunCooldown: number;
  gunLife: number;
  /** Parallel barrels fired per shot. */
  gunCount: number;
  /** Total fan angle across barrels (0 = parallel barrels offset sideways). */
  gunSpread: number;
  /** Extra targets a primary projectile passes through. */
  gunPierce: number;

  // --- other skills: cooldown (s), energy cost, and a generic power multiplier (damage/heal/hp) ---
  secondaryCooldown: number;
  secondaryCost: number;
  secondaryPower: number;
  mobilityCooldown: number;
  mobilityCost: number;
  mobilityPower: number;
  utilityCooldown: number;
  utilityCost: number;
  utilityPower: number;
  /** Multiplies all healing this ship does. */
  healMult: number;
  /**
   * Class/path skill knobs (see SKILL_KNOBS in data/ships.ts for each class's keys and meaning),
   * e.g. rocketCount, arcHops, sentryMax, wallLength. Paths/talents modify these in computeStats.
   */
  skill: Record<string, number>;

  magnetRadius: number;
  /** Fraction of incoming damage ignored, 0..0.6. */
  armor: number;
  /** How many teammates may attach to this ship as turrets. */
  maxTurrets: number;
  xpMult: number;
  /** Multiplies all outgoing damage (all skills, auto-weapons, deployables). */
  damageMult: number;
}

export interface SkillDef {
  id: SkillId;
  slot: SkillSlot;
  name: string;
  description: string;
  icon: string;
}

/** Turret kit used while attached to a host: LMB offense (draws HOST energy), RMB defense (own energy). */
export type TurretKitId = 'flak' | 'laser' | 'seekerpod';
export interface TurretKitDef {
  id: TurretKitId;
  name: string;
  offense: { name: string; description: string; icon: string };
  defense: { name: string; description: string; icon: string };
}

/** Where a talent's effect is implemented: pure stat change (computeStats) or sim behavior. */
export type TalentImpl = 'stats' | 'sim' | 'both';

export interface TalentDef {
  id: UpgradeId;
  path: PathId;
  name: string;
  icon: string;
  description: string;
  impl: TalentImpl;
}

export interface PathDef {
  id: PathId;
  classId: ShipClassId;
  name: string;
  tagline: string;
  /** What choosing the path grants immediately. */
  description: string;
  icon: string;
  /** Accent color for UI and hull trim (0xRRGGBB). */
  accent: number;
  /** Path bonus implementation split (same meaning as TalentImpl). */
  impl: TalentImpl;
  talents: TalentDef[];
}

/**
 * v0.5 capital variant. A host with ≥ 1 docked turret transforms: hull + hitbox scale by capitalScale(turrets)
 * (sim/world.ts), armor + CAPITAL_ARMOR_PER_TURRET per turret, speed penalty as before, turrets render as bubble
 * domes on HARDPOINT_LAYOUT mounts, and `skill` replaces the mobility (Space) skill until the last turret leaves.
 */
export interface CapitalDef {
  name: string;
  description: string;
  skill: SkillDef;
}

export interface ShipClassDef {
  id: ShipClassId;
  name: string;
  /** 'Brute' | 'Tech' | 'Engineer' */
  archetype: string;
  role: string;
  description: string;
  skills: Record<SkillSlot, SkillDef>;
  /** Kit this class uses while attached as a turret. */
  turret: TurretKitDef;
  /** v0.5: the capital variant this ship becomes while hosting ≥ 1 turret (bigger hull, hardpoints, new Space skill). */
  capital: CapitalDef;
  paths: PathDef[];
  /** Can this class attach to a teammate as a turret? */
  canTurret: boolean;
  /** Outgoing damage multiplier applied while this ship is attached as a turret. */
  turretDamageMult: number;
  base: ShipStats;
}

// ---------------------------------------------------------------------------------------------
// Upgrades (Vampire-Survivors-style level-up choices) — ids/defs owned by sim/pve/upgrades.ts
// ---------------------------------------------------------------------------------------------

export type UpgradeId = string;

export interface UpgradeChoice {
  id: UpgradeId;
  name: string;
  description: string;
  /** The level the upgrade will be at after picking it (1 = new). */
  level: number;
  maxLevel: number;
  /**
   * 'weapon' = skill tweak, 'auto' = auto-firing weapon, 'passive' = stat,
   * 'path' = build-path fork (level 3; id `path:<PathId>`), 'talent' = path talent (levels 6/9/12/15).
   */
  category: 'weapon' | 'auto' | 'passive' | 'path' | 'talent';
  /** Short icon key for the UI (single emoji is fine). */
  icon: string;
}

// ---------------------------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------------------------

export const TILE_EMPTY = 0;
export const TILE_WALL = 1;
/** Destructible-looking but solid decorative rock; treated as wall by physics. */
export const TILE_ROCK = 2;
/** Team base floor (walkable, rendered tinted). Safe-ish zone near spawns — enemies do not spawn here. */
export const TILE_BASE = 3;
/**
 * v0.3 sealable rift doorway (walkable while open). Sealing writes TILE_WALL into its door tiles; unsealing
 * writes TILE_DOOR back. Only sim/floorgen.ts applyRoomSeals() mutates tiles at runtime (both hosts call it).
 */
export const TILE_DOOR = 4;

export interface SpawnPoint {
  /** team index, or -1 for FFA/any */
  team: TeamId;
  x: number;
  y: number;
}

export interface GameMap {
  seed: number;
  teamCount: number;
  width: number; // px
  height: number; // px
  tileSize: number;
  cols: number;
  rows: number;
  /** row-major, cols*rows, TILE_* values */
  tiles: Uint8Array;
  spawns: SpawnPoint[];
  /** v0.3 Dungeon Runner floors only: static room graph, doors and markers (deterministic from seed + floor). */
  dungeon?: RiftLayout;
  /** v0.3 objective geometry (flag stands, zones, hot sites). Absent on deathmatch and rift maps. */
  features?: MapFeature[];
  /** v0.3: bumped whenever tiles change at runtime (applyRoomSeals). Absent = 0. Nav caches rebuild on change. */
  rev?: number;
}

// ---------------------------------------------------------------------------------------------
// World entities (server/sim-internal; the client never sees these directly)
// ---------------------------------------------------------------------------------------------

export interface Ship {
  id: EntityId;
  playerId: PlayerId;
  name: string;
  team: TeamId;
  shipClass: ShipClassId;
  isBot: boolean;

  x: number; y: number; vx: number; vy: number;
  angle: number;

  alive: boolean;
  respawnTick: number;
  invulnUntilTick: number;

  energy: number;
  stats: ShipStats;

  input: InputState;
  prevInput: InputState;
  lastInputSeq: number;

  /** Chosen build path (null until the level-3 fork). Mirrors upgrades['path:<id>']. */
  path: PathId | null;

  gunReadyTick: number;
  secondaryReadyTick: number;
  mobilityReadyTick: number;
  utilityReadyTick: number;
  attachReadyTick: number;
  /** Timed skill effects (Iron Hide, Ram Charge...) end at this tick. */
  utilityActiveUntilTick: number;
  mobilityActiveUntilTick: number;
  /** Free-form per-skill/talent state (owned by sim/skills). */
  skillState: Record<string, number>;

  /** Host ship id when this ship is a turret, else 0. */
  attachedTo: EntityId;
  /** Ship ids of turrets attached to this ship, in slot order. */
  turrets: EntityId[];

  xp: number;
  level: number;
  xpToNext: number;
  /** Queue of pending level-up offers; offers[0] is the one shown to the player. */
  offers: UpgradeChoice[][];
  /**
   * Serial of offers[0]: changes whenever offers[0] is consumed or replaced (e.g. class swap rebuilds
   * the queue). A chooseUpgrade carrying a different offerId is ignored (prevents a double-press from
   * spending the next queued offer, or a stale card from the old class being applied).
   */
  offerSerial: number;
  /** upgrade id -> current level */
  upgrades: Record<UpgradeId, number>;
  /** Free-form timers/state for auto-weapons (owned by pve). */
  autoState: Record<string, number>;

  kills: number;
  deaths: number;
  score: number;
  bounty: number;
  killStreak: number;
  enemyKills: number;

  /** Last ship that damaged us (for kill credit when an enemy/wall finishes us), and when. */
  lastDamagedBy: EntityId;
  lastDamagedTick: number;

  /** SHIPFLAG_* bitmask, recomputed each tick. */
  flags: number;
  /** v0.3 loot: unsecured caches carried. Absent = none. Owned by sim/loot.ts (use carriedOf(ship)). */
  carried?: CacheToken[];
}

export const SHIPFLAG_AFTERBURNER = 1;
export const SHIPFLAG_CLOAKED = 2;
export const SHIPFLAG_INVULN = 4;
/** Iron Hide / any damage-absorb shield active. */
export const SHIPFLAG_SHIELD = 8;
/** Ram Charge dash in progress. */
export const SHIPFLAG_CHARGING = 16;
export const SHIPFLAG_THRUSTING = 32;
export const SHIPFLAG_BOT = 64;

export interface Enemy {
  id: EntityId;
  kind: EnemyKind;
  x: number; y: number; vx: number; vy: number;
  angle: number;
  hp: number;
  maxHp: number;
  radius: number;
  elite: boolean;
  /** Ship id currently being chased (0 = none). */
  targetId: EntityId;
  spawnTick: number;
  /** Generic AI state (owned by pve/enemies.ts). */
  aiState: number;
  aiTimer: number;
  mem: Record<string, number>;
  /** Contact damage dealt to ships per touch (pve decides cadence). */
  contactDamage: number;
  scoreValue: number;
  xpValue: number;
}

export interface Projectile {
  id: EntityId;
  kind: ProjectileKind;
  /** Ship id (or enemy id when ownerTeam === ENEMY_TEAM). */
  ownerId: EntityId;
  ownerPlayerId: PlayerId; // 0 for enemies
  ownerTeam: TeamId;
  x: number; y: number; vx: number; vy: number;
  damage: number;
  radius: number;
  /** Splash radius on detonation; 0 = direct hit only. */
  splash: number;
  bouncesLeft: number;
  /** Visual tier 1..3 (guns/bombs/mines level) for rendering. */
  level: number;
  spawnTick: number;
  expireTick: number;
  /** Seekers: steer toward nearest hostile within this range (0 = no homing). */
  homingRange: number;
  /** Seekers: max turn rate rad/s. */
  homingTurn: number;
  /** Bullets/shrapnel may pierce this many extra targets. */
  pierce: number;
  /** Tick at which a mine becomes armed (mines only). */
  armTick: number;
}

export interface Deployable {
  id: EntityId;
  kind: DeployableKind;
  ownerId: EntityId;
  ownerPlayerId: PlayerId;
  team: TeamId;
  x: number; y: number; vx: number; vy: number;
  /** Facing (sentry/drone aim) or wall orientation (wall runs along this angle). */
  angle: number;
  hp: number;
  maxHp: number;
  /** Circle radius (sentry/well/fire/nanite/drone) or half-thickness (wall). */
  radius: number;
  /** Walls: full length along `angle`. Others: 0. */
  length: number;
  spawnTick: number;
  expireTick: number;
  /** Damage/heal per tick or per shot, precomputed by the owner's multipliers. */
  power: number;
  mem: Record<string, number>;
}

export interface Gem {
  id: EntityId;
  x: number; y: number; vx: number; vy: number;
  value: number;
  spawnTick: number;
  expireTick: number;
  /** Ship id currently magnetizing this gem (0 = none). */
  magnetTo: EntityId;
}

// ---------------------------------------------------------------------------------------------
// Match / sim config
// ---------------------------------------------------------------------------------------------

export interface SimConfig {
  mapSeed: number;
  mode: GameMode;
  /** 2..8 in teams mode (dungeon: 1..MAX_PARTIES parties); ignored (treated as 0) in FFA. */
  teamCount: number;
  pveIntensity: PveIntensity;
  /** 0 = untimed (endTick 0). */
  matchSeconds: number;
  /** Deathmatch only. 0 = no score limit. */
  scoreLimit: number;
  friendlyFire: boolean;
  /** v0.3. Absent = gameTypeOf(): pveIntensity > 0 ? 'warzone' : 'arena'. Room ALWAYS sets it. */
  gameType?: GameType;
  /** v0.3. Absent = 'deathmatch' ('coop' for dungeon). Illegal combos fall back (isLegalCombo). */
  subMode?: SubMode;
  /** v0.3 dungeon: floors in the run (RIFT_FLOOR_OPTIONS). Ignored otherwise. */
  floors?: number;
  /** v0.3 objective target; 0/absent = objectiveTarget() default. */
  objectiveLimit?: number;
  /** v0.3 anti-farm multiplier on every cache chance (Room-computed). 0/absent = in-world loot off. */
  lootMult?: number;
  /** v0.3 server-only loot RNG seed (crypto). NEVER sent to clients. */
  lootSeed?: number;
}

export type MatchPhase = 'playing' | 'ended';

export interface MatchState {
  phase: MatchPhase;
  startTick: number;
  endTick: number;
  /** Index = team; FFA: empty array. */
  teamScores: number[];
  /** -1 = none / tie */
  winnerTeam: TeamId;
  /** 0 = none */
  winnerPlayerId: PlayerId;
}

/** PvE director state (owned by sim/pve). Extend via `mem` rather than editing this interface. */
export interface PveState {
  wave: number;
  nextWaveTick: number;
  bossAlive: boolean;
  mem: Record<string, number>;
}

/** Uniform-grid spatial hash rebuilt every tick (see sim/world.ts). */
export interface SpatialHash {
  cell: number;
  cols: number;
  rows: number;
  /** Per cell: entity ids. */
  ships: EntityId[][];
  enemies: EntityId[][];
}

export interface World {
  tick: number;
  config: SimConfig;
  map: GameMap;
  rng: Rng;
  nextId: number;

  ships: Map<EntityId, Ship>;
  shipsByPlayer: Map<PlayerId, EntityId>;
  enemies: Map<EntityId, Enemy>;
  projectiles: Map<EntityId, Projectile>;
  gems: Map<EntityId, Gem>;
  deployables: Map<EntityId, Deployable>;

  /** Events produced during the current tick; Sim.drainEvents() returns and clears them. */
  events: GameEvent[];

  match: MatchState;
  pve: PveState;
  grid: SpatialHash;
  /** v0.3: present only when gameType === 'dungeon' (sim/dungeon.ts). */
  dungeon?: RiftState;
  /** v0.3: objective sub-modes only (sim/objectives). Absent/null = deathmatch or dungeon. */
  objective?: ObjectiveState | null;
  /** v0.3: in-world loot caches (sim/loot.ts). createWorld initializes it. */
  loot?: Map<EntityId, LootDrop>;
}

// ---------------------------------------------------------------------------------------------
// Events (sim -> clients, for FX, audio, kill feed). Coordinates are world px.
// ---------------------------------------------------------------------------------------------

export type GameEvent =
  | { t: 'shipSpawn'; shipId: EntityId; playerId: PlayerId; x: number; y: number }
  | {
      t: 'shipDeath'; shipId: EntityId; playerId: PlayerId;
      /** 0 if not killed by a player */
      killerPlayerId: PlayerId;
      cause: 'player' | 'enemy' | 'self';
      x: number; y: number; bounty: number;
    }
  | { t: 'hit'; x: number; y: number; targetKind: 'ship' | 'enemy'; targetId: EntityId; amount: number }
  | { t: 'explode'; x: number; y: number; radius: number; kind: ProjectileKind; team: TeamId }
  | { t: 'enemyDeath'; id: EntityId; kind: EnemyKind; x: number; y: number; elite: boolean }
  | { t: 'fire'; shipId: EntityId; skill: SkillId; x: number; y: number }
  /** Healing landed (for green FX + numbers). */
  | { t: 'heal'; x: number; y: number; targetId: EntityId; amount: number }
  /** Tech Blink / any teleport. */
  | { t: 'blink'; shipId: EntityId; fromX: number; fromY: number; x: number; y: number }
  /** Continuous beam this tick (Medic Repair Beam): renderer draws for ~0.15 s. */
  | { t: 'beam'; fromId: EntityId; toId: EntityId; kind: 'heal' }
  | { t: 'deployDeath'; id: EntityId; kind: DeployableKind; x: number; y: number }
  | { t: 'gem'; x: number; y: number; playerId: PlayerId; value: number }
  | { t: 'levelUp'; playerId: PlayerId; level: number }
  | { t: 'upgrade'; playerId: PlayerId; upgradeId: UpgradeId; level: number }
  | { t: 'attach'; turretShipId: EntityId; hostShipId: EntityId }
  | { t: 'detach'; turretShipId: EntityId; hostShipId: EntityId }
  /** A non-primary skill was used (secondary/mobility/utility) or a talent proc'd (skill = trigger). */
  | { t: 'ability'; shipId: EntityId; skill: SkillId; x: number; y: number; talent?: UpgradeId }
  | { t: 'nova'; x: number; y: number; radius: number; team: TeamId }
  /** Chain-lightning polyline: flat [x0,y0,x1,y1,...] */
  | { t: 'arc'; points: number[]; team: TeamId }
  | { t: 'waveStart'; wave: number; boss: boolean }
  | { t: 'matchEnd'; winnerTeam: TeamId; winnerPlayerId: PlayerId }
  | RiftGameEvent | ObjectiveGameEvent | LootGameEvent;

/** Events that every client receives regardless of position (all others are interest-filtered by x/y). */
export const GLOBAL_EVENT_TYPES: ReadonlySet<GameEvent['t']> = new Set([
  'shipSpawn', 'shipDeath', 'levelUp', 'upgrade', 'attach', 'detach', 'waveStart', 'matchEnd',
  // v0.3 rift ('spawnWarn' and 'telegraph' stay interest-filtered)
  'roomSeal', 'roomClear', 'roomReset', 'chestOpen', 'bossIntro', 'bossPhase', 'portalOpen', 'departing',
  'floorStart', 'lifeLost', 'outOfLives', 'extract', 'partyWiped', 'instability', 'riftEnd',
  // v0.3 objectives + loot ('lootDrop' stays positional; epic+ caches are always in Snapshot.loot)
  'objective', 'lootPickup', 'lootSpill', 'lootSecured',
] as GameEvent['t'][]);

// ---------------------------------------------------------------------------------------------
// Snapshot (per-client view of the world, sent every SNAPSHOT_EVERY ticks)
// ---------------------------------------------------------------------------------------------

export interface ShipView {
  id: EntityId;
  playerId: PlayerId;
  team: TeamId;
  shipClass: ShipClassId;
  x: number; y: number; vx: number; vy: number;
  angle: number;
  /** 0..1 */
  energyFrac: number;
  alive: boolean;
  attachedTo: EntityId;
  /** Index in host.turrets when attached (-1 otherwise); position = host + turretOffset(...). */
  turretSlot: number;
  /** Total turrets on this ship's host (when attached) or on this ship (when hosting). */
  turretCount: number;
  flags: number;
  level: number;
  /** Number of Orbit Blades to draw (positions derived from ORBIT_* constants + tick). */
  orbitals: number;
  /** Index (0..2) of the chosen path within SHIP_CLASSES[shipClass].paths, -1 = none yet. For hull trim. */
  pathIdx: number;
  /** Continuous beam emitted this tick along `angle`: length in px (0 = none). */
  beamLen: number;
  /** BEAM_* kind of that beam. */
  beamKind: number;
  /** Laser resonance: number of laser turrets firing together on the same host (1 = alone). */
  resonance: number;
}

export const BEAM_NONE = 0;
/** Tech turret Laser Lance. */
export const BEAM_LASER = 1;
/** Engineer turret Hull Weld (short beam into the host). */
export const BEAM_WELD = 2;

export interface DeployableView {
  id: EntityId;
  kind: DeployableKind;
  ownerId: EntityId;
  team: TeamId;
  x: number; y: number;
  angle: number;
  hpFrac: number;
  radius: number;
  length: number;
  /** 0..1 of lifetime remaining (for fade-out). */
  lifeFrac: number;
}

export interface EnemyView {
  id: EntityId;
  kind: EnemyKind;
  x: number; y: number;
  angle: number;
  hpFrac: number;
  radius: number;
  elite: boolean;
}

export interface ProjectileView {
  id: EntityId;
  kind: ProjectileKind;
  x: number; y: number; vx: number; vy: number;
  team: TeamId;
  ownerId: EntityId;
  level: number;
}

export interface GemView {
  id: EntityId;
  x: number; y: number;
  value: number;
}

/** Private, exact state for the receiving player's own ship. */
export interface YouState {
  playerId: PlayerId;
  shipId: EntityId;
  alive: boolean;
  /** Seconds until respawn when dead, else 0. */
  respawnIn: number;
  energy: number;
  stats: ShipStats;
  xp: number;
  xpToNext: number;
  level: number;
  /** Offer currently awaiting a pick (3 cards), or null. */
  offer: UpgradeChoice[] | null;
  /** ship.offerSerial — echo it back in chooseUpgrade. */
  offerId: number;
  /** Number of additional queued offers after the current one. */
  queuedOffers: number;
  upgrades: { id: UpgradeId; name: string; icon: string; level: number; maxLevel: number }[];
  /** Remaining cooldown fraction 0..1 (0 = ready). */
  cd: { primary: number; secondary: number; mobility: number; utility: number; attach: number };
  /** Seconds of cooldown remaining per slot (for numeric HUD). */
  cdSec: { secondary: number; mobility: number; utility: number };
  /** Active deployables owned by you, by kind (e.g. { sentry: 2 }). */
  deployables: Partial<Record<DeployableKind, number>>;
  path: PathId | null;
  /** Talent ids taken, in order. */
  talents: UpgradeId[];
  bounty: number;
  attachedTo: EntityId;
  turrets: EntityId[];
  /** A timed skill (Iron Hide / Ram Charge) is active. */
  skillActive: boolean;
  /** v0.3 rift runs only. */
  rift?: RiftYou;
  /** v0.3: your unsecured caches (rarity desc) and your carry cap. Absent = none. */
  carried?: { rarity: Rarity; set: LootSet }[];
  carryCap?: number;
}

export interface MatchView {
  phase: MatchPhase;
  mode: GameMode;
  teamCount: number;
  /** ≥ 0. 0 when untimed — check `timed`. */
  timeLeftSec: number;
  teamScores: number[];
  /** Swarm wave. In a rift this is the enemy TIER — the HUD hides it when `dungeon` is set. */
  wave: number;
  winnerTeam: TeamId;
  winnerPlayerId: PlayerId;
  /** v0.3: false = untimed (dungeon); HUD hides the clock. Absent = true. */
  timed?: boolean;
  /** v0.3 */
  gameType?: GameType;
  subMode?: SubMode;
  /** v0.3 rift runs only. */
  dungeon?: RiftView;
  /** v0.3 objective sub-modes only. */
  objective?: ObjectiveView;
}

export interface Snapshot {
  tick: number;
  /** Highest InputState.seq the server has applied for this client (for client prediction). */
  ackSeq: number;
  you: YouState | null;
  /** All visible ships (every ship in the match, minus cloaked opponents out of detection range). */
  ships: ShipView[];
  /** Interest-filtered. */
  enemies: EnemyView[];
  projectiles: ProjectileView[];
  gems: GemView[];
  /** Interest-filtered. */
  deployables: DeployableView[];
  /** Events since the previous snapshot (global + interest-filtered). */
  events: GameEvent[];
  match: MatchView;
  /** v0.3: interest-filtered caches; epic+ always included (map-wide radar). */
  loot?: LootView[];
  /** v0.3: every ship carrying caches (carrier pips + beacons). */
  carry?: CarryView[];
}

// =============================================================================================
// APPEND — v0.3 game types (ARCHITECTURE.md §3). Orthogonal to GameMode, which stays allegiance-only.
// =============================================================================================
export type GameType = 'dungeon' | 'arena' | 'warzone';
/** Rule set inside a game type (data/gameTypes.ts). 'rival' and 'escort' are reserved for v0.4 (ready: false). */
export type SubMode = 'coop' | 'rival' | 'deathmatch' | 'ctf' | 'zones' | 'hotpoint' | 'escort';
export type ObjectiveSubMode = Extract<SubMode, 'ctf' | 'zones' | 'hotpoint' | 'escort'>;

// =============================================================================================
// APPEND — Dungeon Runner ("the Rift"). Owned by sim/dungeon.ts + sim/floorgen.ts (SIM).
// Per-ship rift flags live in ship.skillState: rOut = 1 extracted, rWait = 1 out of lives until next floor,
// rExtract = 0..1 extract channel progress.
// =============================================================================================
/** Floors 1–3 'hive', 4–6 'prism'. v0.4 appends 'void'. */
export type RiftBiome = 'hive' | 'prism';
export type RiftRoomKind = 'entrance' | 'hall' | 'arena' | 'treasure' | 'key' | 'boss';

export const RIFT_DORMANT = 0;
export const RIFT_ARMING = 1;
export const RIFT_SEALED = 2;
/** Also "visited" for non-sealable rooms. */
export const RIFT_CLEARED = 3;
export type RiftRoomState = 0 | 1 | 2 | 3;

export interface RiftDoor {
  /** Tile indices (row * cols + col): TILE_DOOR when open, TILE_WALL while sealed. */
  tiles: number[];
  /** Point 3 tiles inside the room (px): doorway nudge, recall and in-room respawn target. */
  inX: number;
  inY: number;
}

export interface RiftRoom {
  idx: number;
  kind: RiftRoomKind;
  /** Walkable interior, tile rect [c0, c1) x [r0, r1). */
  c0: number; r0: number; c1: number; r1: number;
  /** Interior centre, px. */
  x: number; y: number;
  /** Sealable rooms (arena / key / boss) only; [] otherwise. */
  doors: RiftDoor[];
  /** Enemy spawn markers, flat px [x0, y0, x1, y1, ...]. */
  spawns: number[];
  /** Chest positions, flat px. Chest i of this room = bit i of RiftRoomRun.chests. */
  chests: number[];
  /** Corridor-connected neighbour room indices. */
  links: number[];
  /** Room-graph distance from the nearest entrance (entrance = 0). */
  depth: number;
  mainPath: boolean;
  /** Entrance rooms: owning party (team); -1 otherwise. */
  party: TeamId;
}

export interface RiftLayout {
  floor: number;
  biome: RiftBiome;
  /** floor % RIFT_BOSS_EVERY === 0 → the key room is a boss room and an extract portal exists. */
  bossFloor: boolean;
  rooms: RiftRoom[];
  /** Entrance room index per party (length = parties). */
  entrances: number[];
  keyRoom: number;
  portalX: number; portalY: number;
  /** -1 on non-boss floors. */
  extractX: number; extractY: number;
}

export interface RiftRoomRun {
  state: RiftRoomState;
  /** Tick at which ARMING becomes SEALED (0 otherwise). */
  until: number;
  /** Team that triggered the seal (-1 = none). */
  sealedBy: TeamId;
  /** Opened-chest bitmask. Survives regroup resets. */
  chests: number;
  /** Ticks SEALED with no alive sealing-party ship inside (regroup reset at RIFT_REGROUP_SEC). */
  vacantTicks: number;
}

export interface RiftParty {
  team: TeamId;
  lives: number;
  /** done = every member extracted. */
  status: 'active' | 'wiped' | 'done';
  /** Respawn anchor, px (entrance, then last cleared room). */
  anchorX: number; anchorY: number;
  /** Rooms any member has entered (bit = room idx; ≤ 16 rooms) — minimap reveal. */
  seen: number;
  roomsCleared: number;
  bossesKilled: number;
  deepestFloor: number;
}

export type RiftOutcome = 'running' | 'cleared' | 'extracted' | 'wiped' | 'abandoned';

export interface RiftState {
  /** 1-based current floor. */
  floor: number;
  floorsTotal: number;
  floorStartTick: number;
  /** Index = RiftRoom.idx. */
  rooms: RiftRoomRun[];
  /** Index = team. v0.3: length 1. */
  parties: RiftParty[];
  /** 0 closed, 1 open, 2 departing. */
  portal: 0 | 1 | 2;
  departTick: number;
  extractOpen: boolean;
  /** Final floor: the run ends at this tick (victory lap); 0 = n/a. */
  victoryTick: number;
  bossId: EntityId;
  bossPhase: number;
  /** Set by stepRift; Sim.step swaps floors at the end of the tick. 0 = none. */
  pendingFloor: number;
  outcome: RiftOutcome;
  extracted: { playerId: PlayerId; floor: number; tick: number }[];
  /** Tick of the next instability hunter pack; 0 = stable. */
  instabilityTick: number;
}

export type RiftGameEvent =
  /** sec > 0: arming (doors close in sec); sec = 0: sealed. */
  | { t: 'roomSeal'; room: number; team: TeamId; sec: number }
  | { t: 'roomClear'; room: number; team: TeamId; x: number; y: number }
  /** Regroup: a vacated sealed room reset to dormant. */
  | { t: 'roomReset'; room: number; team: TeamId }
  /** Encounter pulse telegraph: enemies appear here in `sec`. Positional. */
  | { t: 'spawnWarn'; x: number; y: number; radius: number; sec: number }
  | { t: 'chestOpen'; room: number; chest: number; playerId: PlayerId; team: TeamId; x: number; y: number }
  | { t: 'bossIntro'; id: EntityId; kind: EnemyKind; x: number; y: number }
  | { t: 'bossPhase'; id: EntityId; kind: EnemyKind; phase: number; x: number; y: number }
  /** Boss attack warning. 'line': (x,y)->(x2,y2) half-width r; 'ring': circle (x,y,r). Positional. */
  | { t: 'telegraph'; shape: 'line' | 'ring'; x: number; y: number; x2: number; y2: number; r: number; sec: number }
  | { t: 'portalOpen'; x: number; y: number; extract: boolean }
  | { t: 'departing'; sec: number; team: TeamId }
  | { t: 'floorStart'; floor: number }
  | { t: 'lifeLost'; team: TeamId; playerId: PlayerId; lives: number }
  | { t: 'outOfLives'; playerId: PlayerId; x: number; y: number }
  | { t: 'extract'; playerId: PlayerId; x: number; y: number }
  | { t: 'partyWiped'; team: TeamId }
  | { t: 'instability'; sec: number }
  | { t: 'riftEnd'; outcome: Exclude<RiftOutcome, 'running'> };

/** Rift state for clients (MatchView.dungeon, JSON tail). */
export interface RiftView {
  floor: number;
  floorsTotal: number;
  biome: RiftBiome;
  /** RiftRoomState per room idx. Clients mirror seals with applyRoomSeals(map, rooms) when floor matches. */
  rooms: number[];
  /** Opened-chest bitmask per room idx. */
  chests: number[];
  /** Per party (index = team). */
  lives: number[];
  seen: number[];
  /** Respawn anchor per party, flat px. */
  anchors: number[];
  portal: 0 | 1 | 2;
  /** Seconds until descent (portal 2) or victory end; 0 otherwise. */
  departIn: number;
  extractOpen: boolean;
  boss: { id: EntityId; kind: EnemyKind; hpFrac: number; phase: number } | null;
  /** Out of lives until the next floor. */
  waiting: PlayerId[];
  extracting: { playerId: PlayerId; frac: number }[];
  /** Seconds on this floor (instability at RIFT_SOFT_LIMIT_SEC). */
  floorSec: number;
}

/** Private rift state for the receiving player. */
export interface RiftYou {
  party: TeamId;
  lives: number;
  /** Out of lives — rejoin at the next floor. */
  waiting: boolean;
  extracted: boolean;
  /** 0..1 extract channel progress. */
  extract: number;
  /** Ship the camera should follow while waiting (lowest-pid alive party member); 0 = none. */
  followId: EntityId;
}

// =============================================================================================
// APPEND — objectives (Arena / Warzone). Owned by sim/objectives/* (OBJECTIVES).
// =============================================================================================
/** 'payloadPath' | 'checkpoint' are reserved for Escort (v0.4). */
export type MapFeatureKind = 'flagStand' | 'zone' | 'hotSite' | 'payloadPath' | 'checkpoint';

export interface MapFeature {
  kind: MapFeatureKind;
  /** flagStand: owning team. Others: -1. */
  team: TeamId;
  /** zone: 0 = Core, 1.. = A..D; hotSite: 0..7; flagStand: team; checkpoint: 1..3; payloadPath: 0. */
  index: number;
  x: number; y: number;
  /** Capture / pad radius px (flagStand = capture radius). payloadPath: corridor half-width. */
  radius: number;
  /** payloadPath: flat polyline px; checkpoint: [distAlongPath]. */
  path?: number[];
}

/** Carrying an objective item (CTF flag). Bit 128: the last free u8 SHIPFLAG bit (reserved for objectives). */
export const SHIPFLAG_CARRIER = 128;

export type FlagState = 'home' | 'carried' | 'dropped';

export interface FlagObjective {
  team: TeamId;
  state: FlagState;
  x: number; y: number;
  standX: number; standY: number;
  carrierId: EntityId;
  carrierPlayerId: PlayerId;
  droppedAtTick: number;
  pickedAtTick: number;
  /** playerIds who carried it during the current steal (assist credit). */
  runners: PlayerId[];
}

export interface ZoneObjective {
  /** zones: zone feature index; hotpoint: current hotSite index. */
  index: number;
  x: number; y: number; radius: number;
  owner: TeamId;
  ownerPlayerId: PlayerId;
  capTeam: TeamId;
  capPlayerId: PlayerId;
  /** 0..1 toward capTeam (or decap of owner). */
  progress: number;
  contested: boolean;
  /** Enemies inside this tick (warzone: ≥ ZONE_SWARM_BLOCK blocks progress). */
  swarm: number;
  active: boolean;
  lastPresenceTick: number;
  heldSinceTick: number;
}

export interface HotPointState {
  site: number;
  nextSite: number;
  moveTick: number;
  warnTick: number;
  armTick: number;
  moves: number;
  recent: number[];
}

export interface ObjectivePlayerStats {
  caps: number;
  steals: number;
  returns: number;
  carrierKills: number;
  zoneCaps: number;
  neutralizes: number;
  objTicks: number;
  hotHoldTicks: number;
}

export interface ObjectiveState {
  mode: ObjectiveSubMode;
  /** Captures / points target (objectiveTarget()). */
  limit: number;
  /** Objective points per team. Mirrored into match.teamScores; NEVER rebuilt from ship.score. */
  teamPoints: number[];
  /** FFA hotpoint. */
  playerPoints: Map<PlayerId, number>;
  flags: FlagObjective[];
  zones: ZoneObjective[];
  hot: HotPointState | null;
  overtime: boolean;
  overtimeCapTick: number;
  suddenDeath: boolean;
  /** Zones tie extensions used (≤ 3). */
  extensions: number;
  /** Keyed by playerId so stats survive removePlayer. */
  stats: Map<PlayerId, ObjectivePlayerStats>;
  mem: Record<string, number>;
}

/** Dynamic objective state for clients (MatchView.objective). Geometry = map.features. */
export interface ObjectiveView {
  mode: ObjectiveSubMode;
  limit: number;
  overtime: boolean;
  suddenDeath: boolean;
  /** CTF. s: 0 home, 1 carried, 2 dropped. returnIn = seconds until auto-return (dropped). */
  flags?: { team: TeamId; s: 0 | 1 | 2; x: number; y: number; carrierId: EntityId; returnIn: number }[];
  /** Zones / hot point (hotpoint: one entry, i = site). p = 0..100. */
  zones?: {
    i: number; owner: TeamId; ownerPid: PlayerId; cap: TeamId; capPid: PlayerId;
    p: number; contested: boolean; swarm: boolean; active: boolean;
  }[];
  hot?: { site: number; next: number; moveIn: number; armIn: number };
  /** FFA hot point: [playerId, points] for players with points > 0. */
  playerPoints?: [PlayerId, number][];
}

export type ObjectiveEventKind =
  | 'flagTaken' | 'flagDropped' | 'flagReturned' | 'flagCaptured'
  | 'zoneCaptured' | 'zoneNeutralized'
  | 'hotWarn' | 'hotMoved'
  | 'overtime' | 'suddenDeath';

export type ObjectiveGameEvent =
  | { t: 'objective'; kind: ObjectiveEventKind; team: TeamId; playerId: PlayerId; index: number; x: number; y: number; value: number };

// =============================================================================================
// APPEND — cosmetic loot (sim/loot.ts, data/cosmetics.ts, data/loot.ts).
// =============================================================================================
/** 0 common · 1 uncommon · 2 rare · 3 epic · 4 legendary */
export type Rarity = 0 | 1 | 2 | 3 | 4;
/** 'common' (Salvage Line) drops in every game type; the others are exclusive (data/loot.ts SET_FOR_TYPE). */
export type LootSet = 'common' | 'rift' | 'gladiator' | 'swarm';
/** Wire order (codec packs setIdx in 2 bits). Append-only. */
export const LOOT_SETS: readonly LootSet[] = ['common', 'rift', 'gladiator', 'swarm'];
export type LootSource =
  | 'elite' | 'boss' | 'shutdown'                                      // combat
  | 'roomChest' | 'treasureChest' | 'keyChest' | 'bossCache'          // Dungeon Runner (personal)
  | 'flagCapture' | 'carrierKill' | 'zoneCapture' | 'zoneHold' | 'hotHold' | 'hotFirstCap'; // objectives
// v0.4 appends 'checkpoint' | 'deliver' (Escort).

/** v0.3 slots. v0.4 appends 'tracer' | 'decal' (with PROFILE_VERSION 2). */
export type CosmeticSlot = 'hull' | 'weapon' | 'turret' | 'engine' | 'death' | 'title' | 'killicon';
export type ClassSlot = Extract<CosmeticSlot, 'hull' | 'weapon' | 'turret'>;
export type SharedSlot = Exclude<CosmeticSlot, ClassSlot>;
/** Stable catalog id (data/cosmetics.ts), e.g. 'rift.hull.brute'. Persisted: never renamed. */
export type CosmeticId = string;
/** Resolved look of one ship (slot -> item). Missing slot = starter. */
export type CosmeticLoadout = Partial<Record<CosmeticSlot, CosmeticId>>;

/** An unopened cache. Its item is rolled server-side only at grant time (profile-aware). */
export interface CacheToken { rarity: Rarity; set: LootSet; source: LootSource }

/** In-world cache (World.loot). Owned by SIM (sim/loot.ts). */
export interface LootDrop {
  id: EntityId;
  x: number; y: number; vx: number; vy: number;
  token: CacheToken;
  spawnTick: number;
  /** Number.MAX_SAFE_INTEGER = no expiry (dungeon personal drops; cleared at floor swap). */
  expireTick: number;
  /** Only this player may take it before reservedUntilTick. 0 = anyone. Personal drops: until expiry. */
  reservedFor: PlayerId;
  reservedUntilTick: number;
  /** Player whose death/leave spilled it (0 = freshly rolled). */
  droppedBy: PlayerId;
}

/** Snapshot view of a cache (binary codec section). */
export interface LootView {
  id: EntityId;
  x: number; y: number;
  rarity: Rarity;
  set: LootSet;
  /** 0 = free right now; else only that player may take it. */
  reservedFor: PlayerId;
  /** 0..1 of lifetime remaining (1 = no expiry). */
  lifeFrac: number;
}

/** A ship carrying unsecured caches (JSON tail as flat [shipId, n, best, ...]). */
export interface CarryView { shipId: EntityId; n: number; best: Rarity }

export type LootGameEvent =
  | { t: 'lootDrop'; id: EntityId; x: number; y: number; rarity: Rarity; set: LootSet; source: LootSource }
  | { t: 'lootPickup'; playerId: PlayerId; shipId: EntityId; x: number; y: number; rarity: Rarity; set: LootSet; carried: number }
  | { t: 'lootSpill'; playerId: PlayerId; x: number; y: number; count: number; best: Rarity }
  /** v0.3: how = 'extract' (dungeon). v0.4 adds 'bank'. */
  | { t: 'lootSecured'; playerId: PlayerId; how: 'extract'; tokens: CacheToken[] };
