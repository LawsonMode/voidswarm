// FROZEN CONTRACT — client <-> server messages.
// JSON text frames for everything below; Snapshots travel separately (binary on WebSocket,
// plain objects on LocalTransport) — see net/codec.ts.

import type {
  BotSkill, ClassSlot, CosmeticId, CosmeticLoadout, CosmeticSlot, EntityId, GameMode, GameType, InputState,
  LootSource, ObjectivePlayerStats, ObjectiveSubMode, PlayerId, PveIntensity, Rarity, RiftOutcome, SharedSlot,
  ShipClassId, SubMode, TeamId,
} from './types';

export interface RoomSettings {
  name: string;
  /** v0.3 Command card. Lobby-only; changing it re-bases on DEFAULT_SETTINGS_BY_TYPE. */
  gameType: GameType;
  /** v0.3: a READY member of GAME_TYPES[gameType].subModes (clampSettings enforces). Lobby-only. */
  subMode: SubMode;
  /** Allegiance. Dungeon: always 'teams'. 'ffa' only when SUB_MODES[subMode].ffa. */
  mode: GameMode;
  /** Teams / parties: coop 1; deathmatch 2..8; ctf 2..4; zones / hotpoint 2..8. */
  teamCount: number;
  /** Seats for ACTIVE pilots (humans + bots). Dungeon ≤ teamCount × PARTY_SIZE. Spectators: + SPECTATOR_SLOTS. */
  maxPlayers: number;
  /** Bots are added/removed so active humans + bots == botFill (never above maxPlayers). 0 = no bots. */
  botFill: number;
  botSkill: BotSkill;
  /** 0 = untimed (dungeon only). Arena 3..20, Warzone 1..30. */
  matchMinutes: number;
  /** Deathmatch score limit; 0 = none. Forced 0 for other sub-modes. */
  scoreLimit: number;
  /** Arena 0. Warzone 1..3 (Low/Normal/Chaos). Dungeon 1..3 difficulty (Story/Veteran/Nightmare). */
  pveIntensity: PveIntensity;
  /** Dungeon: "Reckless". */
  friendlyFire: boolean;
  /** v0.3 dungeon: floors per run (RIFT_FLOOR_OPTIONS); 0 otherwise. */
  floors: number;
  /** v0.3 objective target (captures / points); 0 = sub-mode default; 0 for sub-modes without a target. */
  objectiveLimit: number;
}

/** Warzone Classic — identical to the v0.2 default (keeps tests and smoke unchanged). */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  name: 'Main Arena',
  gameType: 'warzone',
  subMode: 'deathmatch',
  mode: 'teams',
  teamCount: 2,
  maxPlayers: 32,
  botFill: 12,
  botSkill: 'normal',
  matchMinutes: 10,
  scoreLimit: 0,
  pveIntensity: 2,
  friendlyFire: false,
  floors: 0,
  objectiveLimit: 0,
};

/** v0.3: base settings per game type (Zone.createRoomInternal / quickPlay / type switches). */
export const DEFAULT_SETTINGS_BY_TYPE: Readonly<Record<GameType, RoomSettings>> = {
  dungeon: {
    ...DEFAULT_ROOM_SETTINGS, name: 'Dungeon Run', gameType: 'dungeon', subMode: 'coop', mode: 'teams',
    teamCount: 1, maxPlayers: 4, botFill: 4, matchMinutes: 0, scoreLimit: 0, pveIntensity: 2, floors: 6, objectiveLimit: 0,
  },
  arena: {
    ...DEFAULT_ROOM_SETTINGS, name: 'Arena', gameType: 'arena', subMode: 'ctf', mode: 'teams',
    teamCount: 2, maxPlayers: 16, botFill: 10, matchMinutes: 12, scoreLimit: 0, pveIntensity: 0, floors: 0, objectiveLimit: 0,
  },
  warzone: { ...DEFAULT_ROOM_SETTINGS, name: 'Warzone' },
};

/** 'lobby' = pre-match (team select + chat); 'countdown' → 'playing' → 'results' → back to 'lobby'. */
export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'results';

export interface PlayerInfo {
  playerId: PlayerId;
  name: string;
  /** NO_TEAM in FFA. In teams mode, -2 = spectator / not yet picked. */
  team: TeamId;
  shipClass: ShipClassId;
  isBot: boolean;
  isHost: boolean;
  ready: boolean;
  /** ms, 0 for bots/local */
  ping: number;
  /** true once this player has a ship in the running match */
  inMatch: boolean;
  /** v0.3: server-resolved look for the current class (starters omitted). Absent for online guests (self-patched locally). */
  cosmetics?: CosmeticLoadout;
}

export const TEAM_UNASSIGNED = -2;

// ---------------------------------------------------------------------------------------------
// Accounts (v0.2) — HTTP JSON API served by the Node game server on the same port as the ws.
// All endpoints: POST, Content-Type application/json, respond JSON. Errors: 4xx { error: string }.
//   POST /api/register { username, email, password }  -> AuthResponse
//   POST /api/login    { login (username or email), password } -> AuthResponse
//   POST /api/logout   { token } -> { ok: true }
//   POST /api/me       { token } -> { account: AccountInfo }  (401 if invalid/expired)
//   POST /api/forgot   { email } -> { ok: true }   (always ok — never reveals whether the email exists)
//   POST /api/reset    { resetToken, password } -> AuthResponse
// Reset emails link to `${PUBLIC_URL}/?reset=<resetToken>`; the client shows a new-password form.
// Rules: username 3–16 chars [A-Za-z0-9_-] (case-insensitive unique), password ≥ 8 chars, valid email
// (unique). Session tokens last 30 days; reset tokens 30 min, single use.
// ---------------------------------------------------------------------------------------------

export interface AccountInfo {
  accountId: string;
  username: string;
  /** Masked for display, e.g. "ch***@gmail.com". */
  emailMasked: string;
  createdAt: number;
}

export interface AuthResponse {
  token: string;
  account: AccountInfo;
}

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
export const PASSWORD_MIN = 8;

export interface PlayerScore {
  playerId: PlayerId;
  score: number;
  kills: number;
  deaths: number;
  enemyKills: number;
  bounty: number;
  level: number;
  /** v0.3 objective stats (objective sub-modes only). */
  obj?: Partial<ObjectivePlayerStats>;
}

/** v0.3: live progress of a running match (RoomSummary.live). */
export interface RoomLive {
  elapsedSec: number;
  /** -1 = untimed. */
  timeLeftSec: number;
  /** Swarm wave; 0 in arena and dungeon. */
  wave: number;
  /** Dungeon: 1-based floor and floors per run; 0 otherwise. */
  floor: number;
  floorsTotal: number;
  /** Dungeon party lives; -1 otherwise. */
  lives: number;
  /** Per team: objective points/captures if the sub-mode has them, else team score. [] in FFA. ≤ 8. */
  scores: number[];
  /** Preformatted short status: "2–1", "212–187", "Kestrel 820", "Floor 3/6 · 7 lives". */
  scoreline: string;
  /** FFA leader; '' / 0 in team modes. */
  leader: string;
  leaderScore: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  mode: GameMode;
  teamCount: number;
  phase: RoomPhase;
  /** All humans in the room, spectators included. */
  humans: number;
  bots: number;
  maxPlayers: number;
  // --- v0.3 ---
  gameType: GameType;
  subMode: SubMode;
  pveIntensity: PveIntensity;
  floors: number;
  /** Server default ("house") room, never auto-closed. */
  house: boolean;
  /** Human host's name; '' if none. */
  hostName: string;
  spectators: number;
  /** A zone user could join to PLAY now (dungeon while playing: joins at the next floor). */
  joinable: boolean;
  /** A zone user could WATCH the running match now. */
  watchable: boolean;
  /** Seconds until launch (lobby auto-start or countdown); 0 = not scheduled. */
  startsInSec: number;
  /** Non-null only while phase === 'playing'. */
  live: RoomLive | null;
}

/**
 * v0.3: what the joiner wants. 'lobby' (default) = v0.2 behaviour; 'play' = drop into the running match
 * (dungeon: at the next floor); 'watch' = spectate. Quick Play's 'quick' intent is server-internal and is
 * never accepted from the wire (validate.ts whitelist).
 */
export type JoinIntent = 'lobby' | 'play' | 'watch';

export interface RiftResult {
  outcome: Exclude<RiftOutcome, 'running'>;
  floorsTotal: number;
  /** Deepest floor any pilot reached. */
  floorReached: number;
  roomsCleared: number;
  bossesKilled: number;
  timeSec: number;
  players: {
    playerId: PlayerId;
    /** extracted = banked at a portal; survived = in the rift at a 'cleared' end; lost = wiped/abandoned; left = quit. */
    status: 'extracted' | 'survived' | 'lost' | 'left';
    floor: number;
    deaths: number;
  }[];
}

export interface ObjectiveResult {
  mode: ObjectiveSubMode;
  teamPoints: number[];
  /** FFA hot point. */
  playerPoints?: [PlayerId, number][];
  /** e.g. "Crimson 3 – 1 Azure (captures)". */
  summary: string;
}

export type ChatChannel = 'all' | 'team' | 'system';

export interface ChatLine {
  /** 0 for system */
  fromPlayerId: PlayerId;
  fromName: string;
  channel: ChatChannel;
  /** team of the sender (for coloring / team channel) */
  team: TeamId;
  text: string;
  /** epoch ms */
  time: number;
}

export interface MatchResult {
  winnerTeam: TeamId;
  winnerPlayerId: PlayerId;
  teamScores: number[];
  scores: PlayerScore[];
  /** Fun awards, e.g. { title: 'Most Turret Time', playerId, value } */
  awards: { title: string; playerId: PlayerId; value: string }[];
  /** v0.3 */
  gameType: GameType;
  subMode: SubMode;
  /** v0.3 dungeon only. */
  rift?: RiftResult;
  /** v0.3 objective sub-modes only. */
  objective?: ObjectiveResult;
  /** v0.3: public epic+ reveals for the results screen / chat. */
  lootHighlights?: { playerId: PlayerId; itemId: CosmeticId; rarity: Rarity }[];
}

// ---------------------------------------------------------------------------------------------
// v0.3 Profile / cosmetic loot (ARCHITECTURE.md §3c). Server-authoritative per account (accounts.profile_json).
// Offline + online guests: device-local copy, never uploaded, merged or broadcast.
// ---------------------------------------------------------------------------------------------
export const PROFILE_VERSION = 1;

export interface LoadoutSel {
  shared: Partial<Record<SharedSlot, CosmeticId>>;
  byClass: Partial<Record<ShipClassId, Partial<Record<ClassSlot, CosmeticId>>>>;
}

/** 'craft' is reserved for v0.4. */
export interface OwnedItem { at: number; src: GameType | 'craft' }

export interface Profile {
  v: number;
  /** Starters are implicit and never stored. Unknown ids are preserved but ignored. */
  owned: Record<CosmeticId, OwnedItem>;
  shards: number;
  loadout: LoadoutSel;
  /** NEW badges (≤ 64). */
  fresh: CosmeticId[];
  /** Crates since the last epic+ reveal, per game type (PITY_EPIC forces epic). */
  pity: Partial<Record<GameType, number>>;
  /** Crates since the last legendary, any game type (PITY_LEGENDARY forces legendary). */
  pityLegendary: number;
  stats: {
    matches: number; wins: number; cachesSecured: number; cachesLost: number;
    byType: Partial<Record<GameType, { matches: number; wins: number }>>;
  };
  /** Newest first, ≤ 20. */
  recent: { at: number; gameType: GameType; itemIds: CosmeticId[]; shards: number }[];
  updatedAt: number;
}

export interface GrantItem {
  itemId: CosmeticId;
  rarity: Rarity;
  from: 'cache' | 'crate' | 'pity';
  source?: LootSource;
  /** Already owned after the reroll: converted to `shards`, not added. */
  dupe: boolean;
  shards: number;
}

export interface LootGrant {
  /** `${matchId}#${profileKey}#${seq}` — ledger key (idempotent). */
  grantKey: string;
  gameType: GameType;
  items: GrantItem[];
  /** Total shards granted (base + duplicates). */
  shards: number;
  cachesSecured: number;
  cachesLost: number;
  /** Crates remaining until each pity guarantee (after this grant). */
  epicIn: number;
  legendaryIn: number;
}

// ---------------------------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------------------------

export type ClientMsg =
  /**
   * `token` = session token from the HTTP auth API (logged-in pilot). The Node server verifies it
   * BEFORE the Zone sees the hello; a valid account forces `name` to the account username.
   * No token = guest (guests may not use a registered username).
   */
  | { type: 'hello'; name: string; protocol: number; version: string; token?: string }
  | { type: 'listRooms' }
  | { type: 'createRoom'; settings: Partial<RoomSettings> }
  /** v0.3: optional intent (default 'lobby'). */
  | { type: 'joinRoom'; roomId: string; intent?: JoinIntent }
  /** v0.3: find (or create) the best room of this type and join it (auto-ready / auto drop-in). */
  | { type: 'quickPlay'; gameType: GameType; subMode?: SubMode }
  | { type: 'leaveRoom' }
  /** Zone-level chat works outside rooms too (the entry "chat lobby"). Text starting with '/' is a command. */
  | { type: 'chat'; channel: 'all' | 'team'; text: string }
  | { type: 'setName'; name: string }
  /** TEAM_UNASSIGNED to spectate; NO_TEAM is ignored in teams mode. */
  | { type: 'setTeam'; team: TeamId }
  | { type: 'setShip'; shipClass: ShipClassId }
  | { type: 'ready'; ready: boolean }
  /** host only */
  | { type: 'updateSettings'; settings: Partial<RoomSettings> }
  /** host only (or anyone when the room has no human host) */
  | { type: 'startMatch' }
  /** Enter the running match (drop-in) with current team/ship. */
  | { type: 'joinMatch' }
  | { type: 'input'; input: InputState }
  /** Spectators only: which ship the camera follows (0 = server default), so interest follows it. */
  | { type: 'spectate'; shipId: EntityId }
  /** offerId = YouState.offerId of the offer being answered; mismatches are ignored server-side. */
  | { type: 'chooseUpgrade'; index: number; offerId: number }
  | { type: 'ping'; t: number }
  /** v0.3 Hangar (handled by Zone). itemId '' = starter. shipClass required for class slots. */
  | { type: 'equip'; slot: CosmeticSlot; itemId: CosmeticId; shipClass?: ShipClassId }
  /** v0.3: clear NEW badges (≤ 64 ids). */
  | { type: 'seenItems'; ids: CosmeticId[] };

// ---------------------------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------------------------

export type ServerMsg =
  | {
      type: 'welcome'; playerId: PlayerId; name: string; serverVersion: string; motd: string;
      /** null = guest (or offline). */
      account: AccountInfo | null;
    }
  /** v0.3: `online` = connected pilots zone-wide. */
  | { type: 'roomList'; rooms: RoomSummary[]; online: number }
  /** Full room state; sent on join and whenever anything lobby-visible changes. roomId null = in zone lobby. */
  | {
      type: 'roomState'; roomId: string | null; phase: RoomPhase; settings: RoomSettings;
      players: PlayerInfo[]; hostPlayerId: PlayerId; countdown: number;
    }
  | { type: 'chat'; line: ChatLine }
  /** Sent when you enter a room: recent history. */
  | { type: 'chatHistory'; lines: ChatLine[] }
  /**
   * You are now in the match. Rebuild the map locally with
   * buildMatchMap({ seed: mapSeed, gameType, subMode, teamCount, floor }).
   */
  | {
      type: 'matchStart'; mapSeed: number; mode: GameMode; teamCount: number;
      /** v0.3 */
      gameType: GameType; subMode: SubMode;
      /** v0.3 dungeon: current 1-based floor (drop-ins); 0 otherwise. */
      floor: number;
      yourShipId: EntityId; tick: number; snapshotEvery: number;
    }
  /**
   * v0.3 rift: the whole rift moved to `floor`. Rebuild the map with buildMatchMap, re-run setMap, reset
   * interpolation + prediction. Sent before any snapshot of the new floor; ship ids are unchanged.
   */
  | { type: 'floorStart'; floor: number; tick: number }
  | { type: 'matchEnd'; result: MatchResult }
  /** 1 Hz while a match runs. */
  | { type: 'scores'; scores: PlayerScore[] }
  | { type: 'pong'; t: number }
  | { type: 'error'; message: string }
  /** v0.3: after welcome (accounts + offline) and after every profile change. Never sent to online guests. */
  | { type: 'profile'; profile: Profile; persisted: boolean }
  /** v0.3: after matchEnd (and on leave with secured caches). persisted:false = apply to the device profile. */
  | { type: 'lootGrant'; grant: LootGrant; persisted: boolean };
