// OWNER: ROOM agent. Internal types shared by Zone and Room.
import type { AccountInfo, ClientMsg, LootGrant, Profile } from '../protocol';
import type { GrantInput } from '../profile/rolls';
import type { PlayerId, ShipClassId } from '../types';
import type { ClientSink } from './Zone';
import type { Room } from './Room';

export interface ZoneUser {
  playerId: PlayerId;
  name: string;
  sink: ClientSink;
  room: Room | null;
  /** ms, measured by the transport (0 offline) */
  ping: number;
  /** epoch ms of recent chat messages (rate limiting) */
  chatTimes: number[];
  /** Logged-in account (null = guest / offline). Account pilots' names are fixed to the username. */
  account: AccountInfo | null;
  /** Set when this connection was superseded (same account logged in elsewhere) or its session revoked. */
  kicked: boolean;
  /** Rate-limit key of the client's network address (set by the transport; null offline / unknown). */
  address: string | null;
  /** Id of the user-created room this connection opened most recently (per-connection room cap). */
  ownedRoomId: string | null;
  /** v0.3: the class this pilot picked last (any room); a room they join (or Quick Play into) starts them on it. */
  lastShipClass?: ShipClassId;
  // --- v0.3 M2 loot profile (docs/v0.3-proposal.md §7.3, §8.8). Filled by ProfileService.attach on hello. ---
  /** Normalized profile (accounts + offline); null for online guests (their loot lives on their device). */
  profile: Profile | null;
  /** Store key: accountId, 'local' offline, null for an online guest. */
  profileKey: string | null;
  /** false = read-only this session (a newer PROFILE_VERSION) or not persisted. */
  profileWritable: boolean;
  /** epoch ms of recent equip / seenItems ops (ProfileService rate limit). */
  opTimes: number[];
  /** Moderation: this pilot's recent chat lines (repeat-flood check; see room/moderation.ts SPAM_RECENT_*). */
  recentChat?: { text: string; time: number }[];
}

/** Where a chat line was said (moderation gate / chat log). `roomId` null = the zone lobby. */
export interface ChatWhere { roomId: string | null; roomName: string; channel: 'all' | 'team'; team: number }

/** One human's grant for RoomHost.grantLoot (profileKey = accountId | 'local' | `guest:${playerId}`). */
export interface LootGrantEntry { user: ZoneUser | null; profileKey: string; input: GrantInput }
/**
 * persisted: false = not in a server-side store (guests: apply to the device profile; accounts: the store failed or
 * is absent). duplicate = an idempotent replay of an already-recorded key (don't announce it). queued = retried later.
 */
export interface LootGrantOutcome { grant: LootGrant; persisted: boolean; duplicate?: boolean; queued?: boolean }

/** What a Room needs from its Zone. */
export interface RoomHost {
  readonly snapshotEvery: number;
  readonly local: boolean;
  /** ZoneOptions.blockSameNetworkWatch (never true offline). Gates the fix #2 same-network Watch rule. */
  readonly blockSameNetworkWatch: boolean;
  allocPlayerId(): PlayerId;
  /**
   * Unique (zone-wide, case-insensitive, look-alike aware) sanitized BOT callsign for playerId: ASCII
   * letters, digits, space, '_' and '-' only (see sanitizeBotName).
   */
  uniqueName(raw: string, exceptPid: PlayerId): string;
  /** Rename a human (zone-wide bookkeeping + announcements). Returns the final name. */
  renameUser(user: ZoneUser, raw: string): string;
  /** Something in this room's summary changed (room list push, throttled). */
  roomsChanged(): void;
  log(line: string): void;
  // --- v0.3 (docs/v0.3-proposal.md §8.8) ---
  /** Unique id for a match about to start (loot grant keys, M2). */
  newMatchId(): string;
  /** 31-bit seed from a CSPRNG where available (SimConfig.lootSeed — server-only, never sent). */
  randomSeed(): number;
  /** Online: false while MAX_PLAYING_ROOMS rooms are in countdown / playing. Always true offline. */
  canStartMatch(): boolean;
  /** Pilots connected zone-wide (RoomList.online). */
  onlineCount(): number;
  /**
   * v0.3 M1 (fix #2, ROOM addition): take `user` out of their room and back to the zone lobby (Command),
   * then tell them `reason`. The Room calls it from flush(), never while iterating its players.
   */
  returnToLobby(user: ZoneUser, reason: string): void;
  /**
   * v0.3 M2: grant a batch of loot (one ProfileService.grantBatch → one commitGrants transaction). NEVER throws
   * (fix #18); outcomes line up with `entries` by index, and a missing outcome means "not granted" (logged).
   */
  grantLoot(entries: LootGrantEntry[]): LootGrantOutcome[];
  // --- moderation (room/moderation.ts) ---
  /**
   * The moderation gate for one human chat line (after rate limiting and command handling): mute check, repeat
   * flood, word filter, chat log, strikes. Returns the text to broadcast (possibly masked), or null when nothing is
   * shown (the sender already got a private notice).
   */
  chatGate(user: ZoneUser, text: string, where: ChatWhere): string | null;
  /** A host renames the room to `name` (already sanitized): false = refused by the name filter (logged + strike). */
  roomNameAllowed(user: ZoneUser | null, name: string): boolean;
}

/** Chat rate limit: at most CHAT_BURST messages per CHAT_WINDOW_MS. */
export const CHAT_BURST = 5;
export const CHAT_WINDOW_MS = 5000;

export function allowChat(user: ZoneUser, now: number): boolean {
  const t = user.chatTimes;
  while (t.length && now - t[0] > CHAT_WINDOW_MS) t.shift();
  if (t.length >= CHAT_BURST) return false;
  t.push(now);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Per-connection message rate limits (token buckets). Chat keeps its own allowChat window on top.
// ---------------------------------------------------------------------------------------------

export interface TokenBucket { tokens: number; at: number }

/** Refill `b` (capacity `cap`, `perSec` tokens/s) up to `now`, then take `cost` if available. */
export function takeToken(b: TokenBucket, now: number, cap: number, perSec: number, cost = 1): boolean {
  const el = Math.max(0, now - b.at) / 1000;
  b.tokens = Math.min(cap, b.tokens + el * perSec);
  b.at = Math.max(b.at, now);
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}

export type RateClass = 'input' | 'general' | 'action' | 'announce' | 'create';

/**
 * [burst capacity, refill per second]. input: the client sends ~60/s (bursts of up to 4 per frame).
 * general: every other message. action: anything that mutates room/zone state (each one can trigger a
 * full roomState broadcast). announce: actions that broadcast a system chat line to others
 * (rename / join / leave / team). create: createRoom.
 */
export const RATE_LIMITS: Readonly<Record<RateClass, readonly [number, number]>> = {
  input: [120, 90],
  general: [60, 30],
  action: [12, 2],
  announce: [8, 0.25],
  create: [3, 1 / 20],
};

const MSG_CLASSES: Readonly<Record<ClientMsg['type'], readonly RateClass[]>> = {
  input: ['input'],
  hello: ['general'], ping: ['general'], listRooms: ['general'], chat: ['general'], chooseUpgrade: ['general'],
  spectate: ['general'],
  ready: ['general', 'action'], setShip: ['general', 'action'], updateSettings: ['general', 'action'],
  startMatch: ['general', 'action'], joinMatch: ['general', 'action'],
  setTeam: ['general', 'action', 'announce'], setName: ['general', 'action', 'announce'],
  joinRoom: ['general', 'action', 'announce'], leaveRoom: ['general', 'action', 'announce'],
  // v0.3: Quick Play joins (and at most creates one overflow room per request — only when nothing of that type
  // is joinable, so repeats land in the room just made): priced like joinRoom, not like createRoom.
  quickPlay: ['general', 'action', 'announce'],
  createRoom: ['general', 'action', 'announce', 'create'],
  // v0.3 Hangar (ProfileService adds its own equip limit on top, M2)
  equip: ['general', 'action'], seenItems: ['general'],
};

/** Rate-limit state of one connection. */
export class ConnectionRate {
  private buckets: Record<RateClass, TokenBucket>;
  private lastNotice = -1e12;

  constructor(now: number) {
    const mk = (c: RateClass): TokenBucket => ({ tokens: RATE_LIMITS[c][0], at: now });
    this.buckets = { input: mk('input'), general: mk('general'), action: mk('action'), announce: mk('announce'), create: mk('create') };
  }

  /** Does a message of `type` fit every bucket of its class? (Consumes tokens up to the first refusal.) */
  allow(type: string, now: number): boolean {
    const classes = MSG_CLASSES[type as ClientMsg['type']] ?? ['general'];
    for (const c of classes) {
      const [cap, per] = RATE_LIMITS[c];
      if (!takeToken(this.buckets[c], now, cap, per)) return false;
    }
    return true;
  }

  /** At most one "slow down" notice per `gapMs`. */
  shouldNotify(now: number, gapMs = 3000): boolean {
    if (now - this.lastNotice < gapMs) return false;
    this.lastNotice = now;
    return true;
  }
}
