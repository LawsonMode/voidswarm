// OWNER: ROOM agent. Frozen public API — the transport-agnostic "server".
// The Node server wraps it with WebSockets; the browser's offline mode (LocalTransport) runs it in-page.
import { CHAT_HISTORY, CHAT_MAX_LEN, MAX_PLAYING_ROOMS, NO_TEAM, ROOM_LIST_LIVE_SEC, TICK_RATE } from '../constants';
import {
  GAME_TYPES, SUB_MODES, firstReadySubMode, isGameType, isSubMode, readySubModes, subModeLabel,
} from '../data/gameTypes';
import {
  DEFAULT_ROOM_SETTINGS, DEFAULT_SETTINGS_BY_TYPE, TEAM_UNASSIGNED,
  type AccountInfo, type ChatLine, type ClientMsg, type JoinIntent, type PlayerInfo, type RoomSettings, type RoomSummary, type ServerMsg,
} from '../protocol';
import { ProfileService, type ProfileMsg } from '../profile/service';
import type { ProfileStore } from '../profile/store';
import type { GameType, PlayerId, Snapshot, SubMode } from '../types';
import { GAME_VERSION, PROTOCOL_VERSION } from '../version';
import { checkName, filterChat, isSpam, tameText, type FilterResult, type Strictness } from '../moderation/filter';
import { fnv1a, hash32 } from '../util/hash';
import { Rng } from '../util/rng';
import {
  ANNOUNCE_ALL_ROOM_NAME, ANNOUNCE_MAX_LEN, ANNOUNCE_PREFIX, ANNOUNCE_SENDER_NAME, DEFAULT_POSITIVE_LINES, MOD_COMMANDS,
  MSG_BLOCKED, MSG_CARE, MSG_CARE_NAME, MSG_NAME_REFUSED, MSG_NAME_RESERVED, MSG_NOT_SENT, MSG_REPORT_OFFLINE, MSG_REPORT_USAGE,
  MSG_ROOM_NAME_REFUSED, MSG_SPAM, MSG_WARN_LAST, POSITIVE_LINE_MAX_LEN, POSITIVE_LINES_MAX, POSITIVE_LINES_MIN,
  REPORT_COMMAND, SPAM_RECENT_MAX, SPAM_RECENT_MS, SUBSTITUTE_MODES, TAG_SELF_HARM, TAG_THREAT, enforcedTagsOf, hitLabel, tagOfCategory, tagsOf,
  chatSenderKey, isReservedCallsign, isStrikeStatus, mutedMessage, warningText,
  type AlertKind, type AnnounceResult, type ChatAction, type ChatDisplay, type ChatLogEntry, type ChatOptionsResult,
  type LogChannel, type ModerationHook, type ModUser, type MuteInfo, type OnlinePilot, type RejectedLine, type ReplyLines,
  type StrikeDetail, type StrikeReason, type StrikeStatus, type SubstituteMode, type ZoneChatOptions,
} from './moderation';
import { Room, subModeShort, type ChatVerdict, type ZoneRoomHost } from './Room';
import {
  ConnectionRate, allowChat, takeToken, type ChatWhere, type LootGrantEntry, type LootGrantOutcome,
  type TokenBucket, type ZoneUser,
} from './user';
import {
  ROOM_NAME_MAX_LEN, clampSettings, dedupeName, nameKey, parseGameType, parseSubMode, quickPlayScore, sanitizeBotName,
  sanitizeGuestName, sanitizeName, sanitizeText,
} from './util';

/**
 * Where the zone delivers output for one connected client.
 * A broadcast passes the SAME message object to every recipient's sendMsg, and the zone never mutates a
 * message after sending it, so a transport may cache the serialization of the last object it saw.
 */
export interface ClientSink {
  sendMsg(msg: ServerMsg): void;
  sendSnapshot(s: Snapshot): void;
  /** ROOM addition (optional): the zone wants this connection closed (e.g. same account logged in elsewhere). */
  close?(reason: string): void;
}

export interface ConnectionHandle {
  /** Feed a message from this client. */
  handle(msg: ClientMsg): void;
  /** Client disconnected. */
  close(): void;
}

/** ROOM addition: transports that can measure RTT report it here (shown in PlayerInfo.ping). */
export interface ZoneConnection extends ConnectionHandle {
  setPing(ms: number): void;
  /**
   * v0.2: the transport verified this connection's session token. Call BEFORE forwarding 'hello'.
   * null = guest. The account username becomes the pilot's (fixed) name.
   */
  setAccount(account: AccountInfo | null): void;
  /**
   * ROOM addition (optional to call): the client's network address as a rate-limit key (e.g. IPv4 or
   * IPv6 /64). Used for the per-address cap on user-created rooms. Call before 'hello'.
   */
  setAddress(address: string | null): void;
  /**
   * ROOM addition: drop this connection from the zone (e.g. its session was revoked): sends
   * { type:'error', message: reason }, removes the pilot, then asks the sink to close.
   */
  kick(reason: string): void;
}

export interface ZoneOptions {
  /** SNAPSHOT_EVERY_ONLINE for the server, SNAPSHOT_EVERY_LOCAL offline. */
  snapshotEvery: number;
  /** Rooms created at startup. At least one. */
  defaultRooms: Partial<RoomSettings>[];
  motd: string;
  /** Offline mode: single human, auto-host, rooms never close. */
  local: boolean;
  /** ROOM addition (optional): concise log sink for connects/room events. Default: silent. */
  log?: (line: string) => void;
  /** v0.2 (optional): registered usernames; guests (and bots) whose name is reserved get a digit suffix. */
  isReservedName?: (name: string) => boolean;
  /**
   * v0.3 (optional, default false): refuse an online Watch of a match that a pilot on the same network
   * address is flying (anti-"ghosting" with a second tab). Off by default because one NAT is one address:
   * a classroom or household would otherwise be unable to watch each other. Server env WATCH_SAME_NETWORK_BLOCK=1.
   */
  blockSameNetworkWatch?: boolean;
  /**
   * v0.3 M2 (optional): where loot profiles live — the SQLite store on the server, LocalProfileStore offline,
   * MemoryProfileStore in tests / smoke. Absent = session-only profiles (nothing is saved). Rooms never touch
   * it: everything goes through the Zone's ProfileService (attach on hello, equip / seenItems, grantLoot).
   */
  profiles?: ProfileStore;
  /**
   * Moderation hook (optional; room/moderation.ts). The word filter always runs (online and offline); this adds the
   * host's chat log, mutes, strikes / auto-mute, moderator commands and /report. The Node server injects its
   * SQLite-backed implementation (src/server/moderation/service.ts); offline there is none.
   */
  moderation?: ModerationHook;
  /**
   * Word-filter strictness for chat and human-chosen names (moderation/filter.ts). Default 'strict' (classroom:
   * profanity AND mild words are starred); 'standard' lets the mild tier through. Slurs, hate, sexual content,
   * threats and self-harm statements are blocked either way. The server sets it from env CHAT_FILTER.
   */
  chatFilter?: Strictness;
  /**
   * v0.6 LAN edition (optional; docs/LAN-EDITION-proposal.md §5.8): chat substitution mode, positive lines and
   * strictness (`strictness` here wins over `chatFilter`). Defaults: substitute 'sender', DEFAULT_POSITIVE_LINES.
   * Zone.setChatOptions changes them live (Settings → Chat).
   */
  chat?: Partial<ZoneChatOptions>;
  /**
   * v0.6 (optional; §4.1): callsigns reserved on top of RESERVED_CALLSIGNS (Host, Teacher, Admin, ...), e.g. the host
   * admin's username. Zone.setReservedNames changes them live.
   */
  reservedNames?: readonly string[];
  /**
   * v0.6 (optional; §5.9 Settings → Rooms): the online room caps (default MAX_ROOMS, MAX_PLAYING_ROOMS,
   * MAX_ROOMS_PER_ADDRESS). Zone.setLimits changes them live; a lowered cap only refuses new rooms / matches.
   */
  limits?: Partial<ZoneLimits>;
}

/** The online room caps (Zone.setLimits). */
export interface ZoneLimits { maxRooms: number; maxPlayingRooms: number; maxRoomsPerAddress: number }

/** Zone-lobby chat lines are logged under this room name (roomId null). */
export const ZONE_LOG_ROOM_NAME = 'Zone';
/** v0.6: the zone lobby's part of a roomUid (`${bootId}:zone`). Room ids are 'r<n>', so it never collides. */
export const ZONE_ROOM_UID_KEY = 'zone';
/** v0.6: the Zone's own count of warned lines per pilot (offline, and when the host's tag policy doesn't count one). */
export const WARN_WINDOW_MS = 10 * 60_000;

/**
 * A chat line kept for history, with its audience: `skip` = the one pilot who must not see it (a substitute's
 * sender), `skipWho` = that sender's chatSenderKey (so a reconnect, which gets a new playerId, still doesn't see it).
 */
interface ZoneHistoryEntry { line: ChatLine; skip: PlayerId; skipWho: string | null }

/** User-created rooms with no humans close after this long (server mode only). */
export const EMPTY_ROOM_CLOSE_SEC = 60;
const ROOM_LIST_THROTTLE_TICKS = TICK_RATE;
/** Zone-lobby roomState (online pilots list) broadcasts are coalesced to at most one per this many ticks. */
export const LOBBY_STATE_THROTTLE_TICKS = TICK_RATE / 2;
/** The zone-lobby pilots list carries at most this many entries (it is cosmetic; keeps broadcasts O(1)). */
export const MAX_LOBBY_LIST = 64;
export const MAX_ROOMS = 24;
/** Offline: custom (created) rooms kept at once; creating one more closes the oldest one without a human. */
export const LOCAL_MAX_CUSTOM_ROOMS = 3;
/** Open user-created rooms per client address (server mode; see ZoneConnection.setAddress). */
export const MAX_ROOMS_PER_ADDRESS = 6;
/** Zone-wide "entered/left the zone" announcements: burst, then per second. */
export const PRESENCE_BURST = 10;
const PRESENCE_PER_SEC = 2;
const MAX_CATCHUP_TICKS = 5;
/** Queued (failed) loot grant commits are retried once per this many seconds (ProfileService.retryQueued). */
export const PROFILE_RETRY_SEC = 5;

/** Shape of a registered username's key (USERNAME_RE, lowercased): only such keys can be reserved. */
const REGISTERABLE_KEY_RE = /^[a-z0-9_-]{3,16}$/;

const ZONE_HELP = [
  'Zone commands: /help  /name <callsign>  /rooms  /join <room # or name>  /play <type> [mode]  /report <name> <reason>',
  'Types: dungeon, arena, warzone (e.g. /play arena dm, /play warzone). Or use Quick Play / Join / Watch / Create.',
];

/** Fallback when a command handler of the moderation hook throws / rejects. */
const MOD_FAILED_MSG = 'That command failed — see the server log.';
/** The log label of a name check whose filter threw (the name is refused; fail closed). */
const FILTER_ERROR = 'filter-error';
/** The log label of a refused reserved callsign (Host, Teacher, ...; never a strike). */
const RESERVED_LABEL = 'reserved';
/** Draws of a generated callsign (per stem) before a taken one is settled with a digit suffix. */
const GENERATED_CALLSIGN_TRIES = 8;
/**
 * Stems of generated callsigns ("Pilot4821"), in order: the next one is used only when every draw of the previous one
 * was a reserved look-alike (a host admin whose username is "Pilot1" reserves every PilotNNNN).
 */
const GENERATED_CALLSIGN_STEMS: readonly string[] = ['Pilot', 'Flyer', 'Guest'];

let fallbackSeeds = 0;

/**
 * 31-bit random seed, from the platform CSPRNG (browsers, Node 19+ — every supported runtime). Without one, a
 * time-based seed: never the global PRNG here (T-ROOM-5 keeps it out of Zone.ts and moderation.ts).
 */
function cryptoSeed(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] >>> 1;
  }
  return hash32(Date.now() % 0x7fffffff, Math.floor(now() * 1000) % 0x7fffffff, ++fallbackSeeds) >>> 1;
}

/**
 * Random base36 id of this Zone instance (§7.3: matchId = `${bootId}:${n}`). Two server boots never share
 * grant keys, so a restarted server can't collide with ledger rows written before the restart.
 */
function makeBootId(): string {
  return (cryptoSeed().toString(36) + cryptoSeed().toString(36)).slice(0, 12);
}

export class Zone {
  private opts: ZoneOptions;
  private users = new Map<PlayerId, ZoneUser>();
  private rooms = new Map<string, Room>();
  private nextPid = 1;
  private nextRoomNum = 1;
  private zoneChat: ZoneHistoryEntry[] = [];
  private lobbyDirty = false;
  private lastLobbyTick = -1e9;
  private roomListDirty = false;
  private lastRoomListTick = -1e9;
  private tickCount = 0;
  /** Zone-wide budget for "X entered/left the zone." lines (a connect storm must not flood every lobby chat). */
  private presence: TokenBucket = { tokens: PRESENCE_BURST, at: Date.now() };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;
  private hostApi: ZoneRoomHost;
  private matchCounter = 0;
  private readonly bootId = makeBootId();
  /** v0.3 M2: the only door to profile storage (Room never touches it). */
  private readonly profiles: ProfileService;
  /** Moderation hook (null offline / in tests without one): filter only. */
  private readonly mod: ModerationHook | null;
  /** Word-filter strictness (ZoneOptions.chatFilter / chat.strictness; 'strict' unless the host says 'standard'). */
  private readonly filterOpts: { strictness: Strictness };
  /** v0.6: the Zone's own seeded PRNG (bootId): the positive-line deck and generated callsigns. */
  private readonly rng: Rng;
  /** v0.6: substitution mode and positive lines (setChatOptions); strictness lives in filterOpts. */
  private chatOpts: { substitute: SubstituteMode; positiveLines: readonly string[] };
  /** v0.6: the shuffled positive-line deck (drawn from the end) and the last line drawn (never twice in a row). */
  private deck: string[] = [];
  private lastPositive: string | null = null;
  /** v0.6: warned lines per pilot in WARN_WINDOW_MS (the Zone's own escalation count). */
  private warned = new Map<PlayerId, number[]>();
  /** v0.6: extra reserved callsigns (the host admin's username; setReservedNames). */
  private reservedExtra: string[] = [];
  /** v0.6: the online room caps (setLimits). */
  private limits: ZoneLimits = { maxRooms: MAX_ROOMS, maxPlayingRooms: MAX_PLAYING_ROOMS, maxRoomsPerAddress: MAX_ROOMS_PER_ADDRESS };

  constructor(opts: ZoneOptions) {
    this.opts = opts;
    this.mod = opts.moderation ?? null;
    this.filterOpts = { strictness: opts.chatFilter === 'standard' ? 'standard' : 'strict' };
    this.rng = new Rng(fnv1a(this.bootId));
    this.chatOpts = { substitute: 'sender', positiveLines: DEFAULT_POSITIVE_LINES };
    if (opts.chat) {
      // a bad setting never stops the Zone: the defaults are kept
      try {
        const r = this.setChatOptions(opts.chat);
        if (!r.ok) this.log(`chat options refused (defaults kept): ${r.error}`);
      } catch (e) {
        this.log(`chat options refused (defaults kept): ${(e as Error)?.message ?? e}`);
      }
    }
    if (opts.reservedNames) this.setReservedNames(opts.reservedNames);
    if (opts.limits) this.setLimits(opts.limits);
    this.profiles = new ProfileService(opts.profiles ?? null, { log: (line) => this.log(line) });
    const self = this;
    this.hostApi = {
      snapshotEvery: Math.max(1, Math.floor(opts.snapshotEvery) || 1),
      local: opts.local,
      blockSameNetworkWatch: !opts.local && !!opts.blockSameNetworkWatch,
      allocPlayerId: () => this.nextPid++,
      uniqueName: (raw, except) => this.uniqueName(raw, except, 'bot'), // rooms only name bots
      renameUser: (u, raw) => this.renameUser(u, raw),
      roomsChanged: () => { self.roomListDirty = true; },
      log: (line) => this.log(line),
      newMatchId: () => `${this.bootId}:${(++this.matchCounter).toString(36)}`,
      randomSeed: cryptoSeed,
      canStartMatch: () => this.canStartMatch(),
      onlineCount: () => this.users.size,
      returnToLobby: (u, reason) => {
        if (this.users.get(u.playerId) !== u || !u.room) return;
        this.leaveRoom(u);
        this.tell(u, reason);
      },
      grantLoot: (entries) => this.grantLoot(entries),
      // RoomHost.chatGate (text only) is kept for the RoomHost shape; Rooms use chatVerdict (a substitute skips the sender).
      chatGate: (u, text, where) => this.chatVerdict(u, text, where).text,
      chatVerdict: (u, text, where) => this.chatVerdict(u, text, where),
      // RoomHost.roomNameAllowed is kept for the RoomHost shape; Rooms use roomNameRefusal (the note to tell)
      roomNameAllowed: (u, name) => this.nameCheck(u, name, 'room', u?.room ?? null).ok,
      roomNameRefusal: (u, name) => {
        const chk = this.nameCheck(u, name, 'room', u?.room ?? null);
        return chk.ok ? null : chk.selfharm ? MSG_CARE_NAME : MSG_ROOM_NAME_REFUSED;
      },
      roomNameAccepted: (u, name) => this.roomNameAccepted(u, name),
    };
    const defs = opts.defaultRooms.length ? opts.defaultRooms : [{}];
    for (const d of defs) this.createRoomInternal(this.settingsFor(d), false);
  }

  // ------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------

  /** Register a new client connection. The zone sends 'welcome' + 'roomList' after the client's 'hello'. */
  connect(sink: ClientSink): ZoneConnection {
    let user: ZoneUser | null = null;
    let account: AccountInfo | null = null;
    let address: string | null = null;
    let closed = false;
    let rejected = false;
    // Offline (in-page, single trusted human) is never rate limited.
    const rate = this.opts.local ? null : new ConnectionRate(Date.now());
    return {
      handle: (msg: ClientMsg) => {
        if (closed || rejected || !msg || typeof msg !== 'object') return;
        if (user && user.kicked) return;
        if (rate) {
          const t = Date.now();
          if (!rate.allow(msg.type, t)) {
            if (user && msg.type !== 'input' && rate.shouldNotify(t)) this.tell(user, 'Slow down — too many requests.');
            return;
          }
        }
        if (msg.type === 'ping') { sink.sendMsg({ type: 'pong', t: typeof msg.t === 'number' ? msg.t : 0 }); return; }
        if (!user) {
          if (msg.type !== 'hello') return;
          if (msg.protocol !== PROTOCOL_VERSION) {
            rejected = true;
            sink.sendMsg({ type: 'error', message: `Protocol mismatch: server v${PROTOCOL_VERSION}, client v${msg.protocol}. Please refresh.` });
            return;
          }
          user = this.hello(sink, msg.name, account, address);
        } else {
          this.handleUser(user, msg);
        }
        this.flush();
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (user && !user.kicked) this.disconnect(user);
        this.flush();
      },
      setPing: (ms: number) => { if (user && Number.isFinite(ms)) user.ping = Math.max(0, Math.round(ms)); },
      setAccount: (acc: AccountInfo | null) => { if (!user) account = acc; },
      setAddress: (addr: string | null) => {
        if (user) return;
        address = typeof addr === 'string' && addr ? addr.slice(0, 100) : null;
      },
      kick: (reason: string) => {
        if (closed || rejected) return;
        if (user) {
          if (user.kicked) return;
          this.kick(user, reason);
        } else {
          rejected = true; // not greeted yet: just refuse the connection
          sink.sendMsg({ type: 'error', message: reason });
          try { sink.close?.(reason); } catch { /* transport already gone */ }
        }
        this.flush();
      },
    };
  }

  /** Start the fixed-rate tick loop (setTimeout-based, drift-corrected; works in Node and browsers). */
  start(): void {
    if (this.timer) return;
    const step = 1000 / TICK_RATE;
    this.nextTickAt = now() + step;
    const loop = (): void => {
      const t = now();
      let n = 0;
      while (t >= this.nextTickAt && n < MAX_CATCHUP_TICKS) {
        this.tickSafe();
        this.nextTickAt += step;
        n++;
      }
      if (t - this.nextTickAt > step * MAX_CATCHUP_TICKS) this.nextTickAt = t + step; // too far behind: drop
      this.timer = setTimeout(loop, Math.max(0, this.nextTickAt - now()));
    };
    this.timer = setTimeout(loop, step);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Advance every room one tick (exposed for tests / manual stepping). Throws on room errors. */
  tick(): void {
    this.tickCount++;
    for (const r of this.rooms.values()) r.tick();
    this.housekeeping();
  }

  // --- Moderation (called by the host's moderation service, never from a tick) ---

  /** Every greeted connection, with its account, address and room (moderation: online list, lookups). */
  onlinePilots(): OnlinePilot[] {
    const out: OnlinePilot[] = [];
    for (const u of this.users.values()) out.push(this.pilotOf(u));
    return out;
  }

  /**
   * Kick every greeted connection `select` picks (a ban took effect): each gets { type:'error', message: reason },
   * leaves the zone and is closed by its transport. Returns how many were kicked.
   */
  kickPilots(select: (p: OnlinePilot) => boolean, reason: string): number {
    let n = 0;
    for (const u of [...this.users.values()]) {
      if (u.kicked) continue;
      let hit = false;
      try { hit = select(this.pilotOf(u)); } catch { hit = false; }
      if (!hit) continue;
      this.kick(u, reason);
      n++;
    }
    if (n) this.flush();
    return n;
  }

  /** A private system line to one pilot (moderator warnings, report notices). False = not connected. */
  tellPilot(playerId: PlayerId, text: string): boolean {
    const u = this.users.get(playerId);
    if (!u || u.kicked) return false;
    this.tell(u, text);
    return true;
  }

  // --- v0.6 LAN edition (docs/LAN-EDITION-proposal.md §5.6-§5.8) ---

  /**
   * The room identity the chat log uses (ChatLogEntry.roomUid): `${bootId}:${roomId}`, or `${bootId}:zone` for the
   * zone lobby (roomId null). Room ids restart at r1 on every boot; the bootId makes them unique across restarts.
   */
  roomUidOf(roomId: string | null): string {
    return `${this.bootId}:${roomId ?? ZONE_ROOM_UID_KEY}`;
  }

  /**
   * A host announcement (§5.6): the system line "[Host] <text>" to everyone — the zone lobby and every room — or,
   * with `roomId`, to that room only. Logged on the 'announce' channel (roomUid null for everyone). `text` is
   * sanitized and cut to ANNOUNCE_MAX_LEN; empty text or an unknown room is refused. Only `roomId` undefined or null
   * means everyone: an empty string (an unset room picker) is refused, never read as "every room". Players can't
   * send system lines and can't fly as "Host" (RESERVED_CALLSIGNS), so the line can't be faked.
   */
  announce(text: unknown, roomId?: string | null): AnnounceResult {
    const body = sanitizeText(text, ANNOUNCE_MAX_LEN);
    if (!body) return { ok: false, error: `Type an announcement (1–${ANNOUNCE_MAX_LEN} characters).` };
    let room: Room | null = null;
    if (roomId === '') return { ok: false, error: 'Pick a room, or all rooms.' };
    if (roomId !== undefined && roomId !== null) {
      room = typeof roomId === 'string' ? this.rooms.get(roomId) ?? null : null;
      if (!room) return { ok: false, error: 'That room no longer exists.' };
    }
    const line = `${ANNOUNCE_PREFIX}${body}`;
    let delivered: number;
    if (room) {
      room.system(line);
      delivered = room.humans.filter((p) => !!p.user).length;
    } else {
      this.zoneSystem(line);
      for (const r of this.rooms.values()) r.system(line);
      delivered = this.users.size; // every greeted pilot is in the zone lobby or in exactly one room
    }
    this.logChat({
      time: Date.now(), roomId: room?.id ?? null, roomName: room ? room.settings.name : ANNOUNCE_ALL_ROOM_NAME,
      roomUid: room ? this.roomUidOf(room.id) : null, channel: 'announce', team: NO_TEAM, playerId: 0,
      name: ANNOUNCE_SENDER_NAME, accountId: null, address: null, original: body, shown: line, action: 'pass', hits: [],
      display: 'as-typed',
    });
    this.log(`announcement to ${room ? room.settings.name : 'all rooms'} (${delivered} pilot${delivered === 1 ? '' : 's'})`);
    this.flush();
    return { ok: true, delivered, roomId: room?.id ?? null };
  }

  /** The chat options in force (Settings → Chat). */
  chatOptions(): ZoneChatOptions {
    return { substitute: this.chatOpts.substitute, positiveLines: [...this.chatOpts.positiveLines], strictness: this.filterOpts.strictness };
  }

  /**
   * Change the chat options live (§5.13; Settings → Chat). All or nothing: an unknown mode or strictness, or a
   * positive-line list with fewer than POSITIVE_LINES_MIN usable lines, changes nothing. A positive line is used only
   * when it is 1..POSITIVE_LINE_MAX_LEN characters and passes the filter at the (new) strictness; the others come back
   * in `rejected` (with a reason that never names a matched term), as do duplicates.
   */
  setChatOptions(patch: Partial<ZoneChatOptions> | null | undefined): ChatOptionsResult {
    const p = patch && typeof patch === 'object' ? patch : {};
    const rejected: RejectedLine[] = [];
    let substitute = this.chatOpts.substitute;
    if (p.substitute !== undefined) {
      if (!SUBSTITUTE_MODES.includes(p.substitute as SubstituteMode)) {
        return { ok: false, error: `substitute must be one of ${SUBSTITUTE_MODES.join(', ')}`, rejected };
      }
      substitute = p.substitute as SubstituteMode;
    }
    let strictness = this.filterOpts.strictness;
    if (p.strictness !== undefined) {
      if (p.strictness !== 'strict' && p.strictness !== 'standard') return { ok: false, error: "strictness must be 'strict' or 'standard'", rejected };
      strictness = p.strictness;
    }
    let lines = this.chatOpts.positiveLines;
    if (p.positiveLines !== undefined) {
      if (!Array.isArray(p.positiveLines)) return { ok: false, error: 'positiveLines must be a list of lines', rejected };
      const kept: string[] = [];
      const seen = new Set<string>();
      for (const raw of p.positiveLines.slice(0, POSITIVE_LINES_MAX * 2)) {
        const shown = typeof raw === 'string' ? raw.slice(0, 200) : `(${raw === null ? 'null' : typeof raw})`; // never String(raw): it can throw
        const s = sanitizeText(raw, 400);
        if (!s) { rejected.push({ line: shown, why: 'empty' }); continue; }
        if (s.length > POSITIVE_LINE_MAX_LEN) { rejected.push({ line: shown, why: `longer than ${POSITIVE_LINE_MAX_LEN} characters` }); continue; }
        const key = s.toLowerCase();
        if (seen.has(key)) { rejected.push({ line: s, why: 'duplicate' }); continue; }
        if (!this.passesFilter(s, strictness)) { rejected.push({ line: s, why: "doesn't pass the chat filter" }); continue; }
        if (kept.length >= POSITIVE_LINES_MAX) { rejected.push({ line: s, why: `more than ${POSITIVE_LINES_MAX} lines` }); continue; }
        seen.add(key);
        kept.push(s);
      }
      if (kept.length < POSITIVE_LINES_MIN) {
        return { ok: false, error: `Keep at least ${POSITIVE_LINES_MIN} positive lines that pass the filter (each at most ${POSITIVE_LINE_MAX_LEN} characters).`, rejected };
      }
      lines = kept;
    }
    const linesChanged = lines !== this.chatOpts.positiveLines;
    this.chatOpts = { substitute, positiveLines: lines };
    this.filterOpts.strictness = strictness;
    if (linesChanged) this.deck = [];
    return { ok: true, options: this.chatOptions(), rejected };
  }

  /**
   * Callsigns reserved on top of RESERVED_CALLSIGNS (§4.1), e.g. the host admin's username; replaces the previous
   * extra list. Guests can no longer take them (a pilot already flying under one keeps it until they rename).
   */
  /** The online room caps now. */
  roomLimits(): ZoneLimits { return { ...this.limits }; }

  /**
   * v0.6 (§5.9): change the online room caps live. Each is a whole number ≥ 1 (others are ignored); a lowered cap
   * never closes a room or stops a match: it only refuses the next create or match start.
   */
  setLimits(patch: Partial<ZoneLimits> | null | undefined): ZoneLimits {
    if (!patch || typeof patch !== 'object') return this.roomLimits();
    const next = { ...this.limits };
    for (const k of ['maxRooms', 'maxPlayingRooms', 'maxRoomsPerAddress'] as const) {
      const v = patch[k];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000) next[k] = v;
    }
    this.limits = next;
    return this.roomLimits();
  }

  setReservedNames(names: readonly string[] | null | undefined): void {
    const out: string[] = [];
    if (Array.isArray(names)) {
      for (const n of names) if (typeof n === 'string' && n.trim() && out.length < 64) out.push(n.trim().slice(0, 64));
    }
    this.reservedExtra = out;
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  /** Like tick() but isolates failures per room (used by the run loop). */
  private tickSafe(): void {
    this.tickCount++;
    for (const r of this.rooms.values()) {
      try { r.tick(); } catch (e) { r.onTickError(e); }
    }
    try { this.housekeeping(); } catch (e) { this.log(`zone housekeeping error: ${(e as Error)?.stack ?? e}`); }
  }

  private housekeeping(): void {
    // §7.3.5 / fix #18: failed grant commits are retried on the next GRANT_RETRY_PASSES passes, one pass per
    // PROFILE_RETRY_SEC (a transient storage hiccup gets seconds, not three consecutive ticks, to clear).
    if (this.tickCount % (PROFILE_RETRY_SEC * TICK_RATE) === 0) {
      try { this.profiles.retryQueued(); } catch (e) { this.log(`profile retry error: ${(e as Error)?.message ?? e}`); }
    }
    if (!this.opts.local) {
      for (const r of [...this.rooms.values()]) {
        if (r.userCreated && r.humanCount === 0 && r.emptyTicks >= EMPTY_ROOM_CLOSE_SEC * TICK_RATE) this.closeRoom(r);
      }
    }
    // Section 3.6 live list: while something is playing and someone looks at the list, re-push it every
    // ROOM_LIST_LIVE_SEC so live timers / scorelines stay fresh (structural changes still go out within 1 s).
    if (!this.roomListDirty && this.tickCount - this.lastRoomListTick >= ROOM_LIST_LIVE_SEC * TICK_RATE
      && this.anyRoomPlaying() && this.anyUserInZoneLobby()) this.roomListDirty = true;
    if (this.roomListDirty && this.tickCount - this.lastRoomListTick >= ROOM_LIST_THROTTLE_TICKS) {
      this.roomListDirty = false;
      this.lastRoomListTick = this.tickCount;
      const msg = this.roomListMsg();
      for (const u of this.users.values()) if (!u.room) u.sink.sendMsg(msg);
    }
    // Zone-lobby membership changes (connects, renames, joins/leaves) are coalesced: one list per
    // LOBBY_STATE_THROTTLE_TICKS instead of one per event (which made connect storms O(N²)).
    if (this.lobbyDirty && this.tickCount - this.lastLobbyTick >= LOBBY_STATE_THROTTLE_TICKS) {
      this.lobbyDirty = false;
      this.lastLobbyTick = this.tickCount;
      const msg = this.lobbyStateMsg();
      for (const u of this.users.values()) if (!u.room) u.sink.sendMsg(msg);
    }
    this.flush();
  }

  private anyRoomPlaying(): boolean {
    for (const r of this.rooms.values()) if (r.phase === 'playing') return true;
    return false;
  }

  private anyUserInZoneLobby(): boolean {
    for (const u of this.users.values()) if (!u.room) return true;
    return false;
  }

  /** RoomHost.canStartMatch: online, at most MAX_PLAYING_ROOMS rooms in countdown / playing (tick budget). */
  private canStartMatch(): boolean {
    if (this.opts.local) return true;
    let n = 0;
    for (const r of this.rooms.values()) if (r.phase === 'countdown' || r.phase === 'playing') n++;
    return n < this.limits.maxPlayingRooms;
  }

  private closeRoom(r: Room): void {
    r.close();
    this.rooms.delete(r.id);
    this.roomListDirty = true;
    this.log(`room closed: ${r.settings.name}`);
  }

  private log(line: string): void { this.opts.log?.(line); }

  /** Push pending room states (the zone-lobby list is flushed, throttled, by housekeeping). */
  private flush(): void {
    for (const r of this.rooms.values()) r.flush();
  }

  /** The public room list (as the zone lobby shows it): the control panel's Home and /display, the launcher's title. */
  roomSummaries(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => r.summary());
  }

  private roomListMsg(): ServerMsg {
    return { type: 'roomList', rooms: [...this.rooms.values()].map((r) => r.summary()), online: this.users.size };
  }

  private lobbyStateMsg(): ServerMsg {
    const players: PlayerInfo[] = [];
    for (const u of this.users.values()) {
      if (u.room) continue;
      if (players.length >= MAX_LOBBY_LIST) break;
      players.push({
        playerId: u.playerId, name: u.name, team: TEAM_UNASSIGNED, shipClass: 'brute', isBot: false,
        isHost: false, ready: false, ping: u.ping, inMatch: false,
      });
    }
    return {
      type: 'roomState', roomId: null, phase: 'lobby', settings: { ...DEFAULT_ROOM_SETTINGS, name: 'Zone Lobby' },
      players, hostPlayerId: 0, countdown: 0,
    };
  }

  private isReserved(name: string): boolean {
    try { return this.opts.isReservedName ? this.opts.isReservedName(name) : false; } catch { return false; }
  }

  /**
   * Is `name` a registered username, or a look-alike of one (Cyrillic/Greek letters, invisible
   * fillers, combining marks...)? Registered usernames are ASCII, so the look-alike check asks about
   * the name's ASCII-folded key.
   */
  private isReservedLookalike(name: string): boolean {
    if (this.isReserved(name)) return true;
    const key = nameKey(name);
    return key !== name.toLowerCase() && REGISTERABLE_KEY_RE.test(key) && this.isReserved(key);
  }

  /** nameKey of every other pilot's and bot's name (built once per uniqueName call). */
  private takenKeys(exceptPid: PlayerId): Set<string> {
    const keys = new Set<string>();
    for (const u of this.users.values()) if (u.playerId !== exceptPid) keys.add(nameKey(u.name));
    for (const r of this.rooms.values()) {
      for (const p of r.allPlayers) if (p.isBot && p.playerId !== exceptPid) keys.add(nameKey(p.name));
    }
    return keys;
  }

  /**
   * Unique name for a guest or bot. SEC-8: both are ASCII only — guests the registered-username charset
   * [A-Za-z0-9_-] (spaces become '_'), bots that plus spaces — so no other script can imitate a pilot.
   * Names that are taken, registered, or look like either (see nameKey; kept as defense in depth) get a
   * digit suffix. Bounded cost: one O(users + bots) pass plus ≤ ~150 key lookups.
   */
  private uniqueName(raw: string, exceptPid: PlayerId, kind: 'guest' | 'bot' = 'guest'): string {
    const taken = this.takenKeys(exceptPid);
    const base = kind === 'bot' ? sanitizeBotName(raw) : sanitizeGuestName(raw);
    return dedupeName(base, (n) => taken.has(nameKey(n)) || this.isReservedLookalike(n));
  }

  /** `via` 'msg' = a setName message (a refusal is an error), 'cmd' = the /name chat command (a system line). */
  private renameUser(user: ZoneUser, raw: string, via: 'cmd' | 'msg' = 'cmd'): string {
    if (user.account) {
      this.tell(user, 'Your callsign is your account name.');
      return user.name;
    }
    const next = this.uniqueName(raw, user.playerId);
    if (next === user.name) return next;
    const refuse = (message: string): string => {
      if (via === 'msg') user.sink.sendMsg({ type: 'error', message });
      else this.tell(user, message);
      return user.name;
    };
    if (this.isReservedCallsignName(next)) {
      this.nameRefused(user, next, [RESERVED_LABEL], false, 'name', user.room);
      return refuse(MSG_NAME_RESERVED);
    }
    const chk = this.nameCheck(user, next, 'name', user.room);
    if (!chk.ok && chk.selfharm) {
      // wellbeing, never an offence: the kind note (a setName refusal also toasts it), no strike, the host alerted
      if (via === 'msg') user.sink.sendMsg({ type: 'error', message: MSG_CARE_NAME });
      this.tell(user, MSG_CARE_NAME);
      return user.name;
    }
    if (!chk.ok) return refuse(MSG_NAME_REFUSED);
    const old = user.name;
    user.name = next;
    const text = `${old} is now known as ${next}.`;
    if (user.room) { user.room.onRenamed(user); user.room.system(text); }
    else { this.zoneSystem(text); this.lobbyDirty = true; }
    user.sink.sendMsg(this.welcomeMsg(user));
    // §5.7: an accepted guest callsign is logged (accounts never get here: their callsign is their username)
    this.nameAccepted(user, next, 'name', user.room, chk.flagged);
    return next;
  }

  private welcomeMsg(user: ZoneUser): ServerMsg {
    return {
      type: 'welcome', playerId: user.playerId, name: user.name, serverVersion: GAME_VERSION, motd: this.opts.motd,
      account: user.account,
    };
  }

  private hello(sink: ClientSink, rawName: unknown, account: AccountInfo | null, address: string | null): ZoneUser {
    const pid = this.nextPid++;
    let name: string;
    const displaced: ZoneUser[] = [];
    if (account) {
      name = sanitizeName(account.username);
      const key = nameKey(name);
      for (const u of [...this.users.values()]) {
        if (nameKey(u.name) !== key) continue;
        if (u.account && u.account.accountId === account.accountId) this.kick(u, 'Logged in elsewhere');
        else if (!u.account) displaced.push(u); // a guest squatting (or imitating) the name
      }
      for (const r of this.rooms.values()) r.renameBotsNamed(key);
    } else {
      name = this.uniqueName(typeof rawName === 'string' ? rawName : '', pid);
    }
    // Moderation: a guest callsign the name filter refuses — or a reserved one (Host, Teacher, ...) — becomes a
    // generated one (logged below; a strike only when the name is hateful / sexual / a slur, see nameRefused).
    let refused: { name: string; labels: string[]; severe: boolean; selfharm: boolean } | null = null;
    let reserved: string | null = null;
    let flagged: string[] | null = null;
    if (!account) {
      if (this.isReservedCallsignName(name)) {
        reserved = name;
        name = this.generatedCallsign(pid);
      } else {
        const chk = this.checkNameSafe(name);
        if (!chk.ok) {
          refused = { name, labels: chk.labels, severe: chk.severe, selfharm: chk.selfharm };
          name = this.generatedCallsign(pid);
        } else if (chk.flagged) flagged = chk.flagged; // allowed, logged for review below (no strike)
      }
    } else {
      // An account keeps its username (it passed the filter at registration), but the host's CURRENT lists may
      // match it — a custom term added later, or a review-only 'flag' term (never refused at registration). Such a
      // username is logged on every join as 'flag' for a moderator to look at: no rename, no strike.
      const chk = this.checkNameSafe(name);
      if (!chk.ok) { if (chk.labels[0] !== FILTER_ERROR) flagged = chk.labels; } else if (chk.flagged) flagged = chk.flagged;
      // §4.1: reserved names cover accounts too. Registration refuses them; an account made before that (or before the
      // host admin took the name) keeps flying under it, but every join is logged as 'flag' ['reserved', ...] so the
      // host can see it and rename or disable the account. No rename, no strike.
      if (this.isReservedCallsignName(name)) flagged = [RESERVED_LABEL, ...(flagged ?? [])];
    }
    const user: ZoneUser = {
      playerId: pid, name, sink, room: null, ping: 0, chatTimes: [], account, kicked: false, address, ownedRoomId: null,
      profile: null, profileKey: null, profileWritable: false, opTimes: [],
    };
    this.users.set(pid, user);
    for (const d of displaced) this.renameUser(d, d.name);
    sink.sendMsg(this.welcomeMsg(user));
    // §7.3.1: the loot profile right after welcome (accounts + offline; online guests never get one).
    this.attachProfile(user);
    sink.sendMsg(this.roomListMsg());
    this.lobbyDirty = true; // everyone else's list: coalesced by housekeeping
    sink.sendMsg(this.lobbyStateMsg()); // roomState (zone lobby) before history
    sink.sendMsg({ type: 'chatHistory', lines: this.zoneHistoryFor(user) });
    if (reserved) {
      this.nameRefused(user, reserved, [RESERVED_LABEL], false, 'name', null);
      this.tell(user, `That callsign is reserved — you're flying as ${user.name}. Pick another with /name.`);
    } else if (refused?.selfharm) {
      // wellbeing, never an offence: the kind note (988), no strike, the host alerted (nameRefused)
      this.nameRefused(user, refused.name, refused.labels, refused.severe, 'name', null, true);
      this.tell(user, MSG_CARE_NAME);
      this.tell(user, `You're flying as ${user.name} — pick another callsign with /name.`);
    } else if (refused) {
      this.nameRefused(user, refused.name, refused.labels, refused.severe, 'name', null);
      this.tell(user, `That callsign isn't allowed here — you're flying as ${user.name}. Pick another with /name.`);
    } else if (!account) this.nameAccepted(user, user.name, 'name', null, flagged ?? undefined); // §5.7: the joining callsign
    else if (flagged) this.nameFlagged(user, user.name, flagged, 'name', null); // an account username for review
    this.presenceLine(`${user.name} entered the zone.`);
    this.log(`+ ${user.name} (#${pid}${account ? ', account' : ', guest'}) — ${this.users.size} online`);
    return user;
  }

  /**
   * §7.3.1: ProfileService.attach with key = accountId (account pilot), 'local' (offline) or null (online guest).
   * A failing profile layer never costs the connection: the pilot then plays with a guest-style device profile.
   */
  private attachProfile(user: ZoneUser): void {
    const key = this.opts.local ? 'local' : user.account ? user.account.accountId : null;
    try {
      this.profiles.attach(user, key);
    } catch (e) {
      user.profile = null; user.profileKey = null; user.profileWritable = false;
      this.log(`profile attach failed for ${user.name} (#${user.playerId}): ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * §7.3.2: Hangar ops are the Zone's (never forwarded to a room): ProfileService applies the pure op, saves and
   * pushes the new profile; an equip then refreshes the pilot's look in their room (a new roomState with the new
   * PlayerInfo.cosmetics — mid-match equips apply at once).
   */
  private profileOp(user: ZoneUser, msg: ProfileMsg): void {
    let lookChanged: unknown;
    try {
      lookChanged = this.profiles.handle(user, msg);
    } catch (e) {
      this.log(`profile ${msg.type} failed for ${user.name} (#${user.playerId}): ${(e as Error)?.message ?? e}`);
      return;
    }
    // handle() says whether the equipped look changed; onProfileChanged is idempotent either way.
    if (lookChanged !== false && msg.type === 'equip' && user.room) user.room.onProfileChanged(user);
  }

  /** RoomHost.grantLoot: one ProfileService batch (one commitGrants transaction). Never throws (fix #18). */
  private grantLoot(entries: LootGrantEntry[]): LootGrantOutcome[] {
    if (!entries.length) return [];
    try {
      const out = this.profiles.grantBatch(entries);
      return Array.isArray(out) ? out : [];
    } catch (e) {
      this.log(`loot grant failed (${entries.length} entries): ${(e as Error)?.stack ?? e}`);
      return [];
    }
  }

  /** Drop a connection on the zone side and ask the transport to close it. */
  private kick(user: ZoneUser, reason: string): void {
    if (user.kicked) return;
    user.sink.sendMsg({ type: 'error', message: reason });
    this.disconnect(user);
    user.kicked = true;
    try { user.sink.close?.(reason); } catch { /* transport already gone */ }
  }

  private disconnect(user: ZoneUser): void {
    if (this.users.get(user.playerId) !== user) return;
    if (user.room) user.room.removeUser(user); // a mid-match leave grants the secured bank first (§7.3.6)
    try { this.profiles.detach(user); } catch { /* bookkeeping only */ }
    this.users.delete(user.playerId);
    this.warned.delete(user.playerId);
    this.presenceLine(`${user.name} left the zone.`);
    this.lobbyDirty = true;
    this.log(`- ${user.name} (#${user.playerId}) — ${this.users.size} online`);
  }

  /** Connect / disconnect announcement, dropped (not queued) beyond the zone-wide presence budget. */
  private presenceLine(text: string): void {
    if (!this.opts.local && !takeToken(this.presence, Date.now(), PRESENCE_BURST, PRESENCE_PER_SEC)) return;
    this.zoneSystem(text);
  }

  private zoneSystem(text: string): void {
    this.pushZoneChat({ fromPlayerId: 0, fromName: '', channel: 'system', team: NO_TEAM, text, time: Date.now() });
  }

  /**
   * Broadcast to the zone lobby (and keep it for history). `skip` = a pilot who must not get it (a substitute's
   * sender): nor does anyone with the same chatSenderKey, now or in a later history (a reconnect).
   */
  private pushZoneChat(line: ChatLine, skip: ZoneUser | null = null): void {
    const skipWho = skip ? chatSenderKey(skip) : null;
    const e: ZoneHistoryEntry = { line, skip: skip?.playerId ?? 0, skipWho };
    this.zoneChat.push(e);
    if (this.zoneChat.length > CHAT_HISTORY) this.zoneChat.splice(0, this.zoneChat.length - CHAT_HISTORY);
    const msg: ServerMsg = { type: 'chat', line };
    for (const u of this.users.values()) if (!u.room && Zone.seesZoneLine(e, u)) u.sink.sendMsg(msg);
  }

  /** Is `user` in this zone-lobby line's audience (a substitute never reaches its own sender, even reconnected)? */
  private static seesZoneLine(e: ZoneHistoryEntry, user: ZoneUser): boolean {
    if (e.skip && e.skip === user.playerId) return false;
    return !e.skipWho || e.skipWho !== chatSenderKey(user);
  }

  /** The zone-lobby history `user` may see (a substitute is never shown to its own sender). */
  private zoneHistoryFor(user: ZoneUser): ChatLine[] {
    const out: ChatLine[] = [];
    for (const e of this.zoneChat) if (Zone.seesZoneLine(e, user)) out.push(e.line);
    return out;
  }

  private tell(user: ZoneUser, text: string): void {
    user.sink.sendMsg({ type: 'chat', line: { fromPlayerId: 0, fromName: '', channel: 'system', team: NO_TEAM, text, time: Date.now() } });
  }

  /**
   * v0.3 per-type base: a patch naming a game type starts from DEFAULT_SETTINGS_BY_TYPE[type]; a v0.2-shaped
   * patch (no type) from DEFAULT_ROOM_SETTINGS (Warzone Classic).
   */
  private settingsFor(patch: Partial<RoomSettings> | unknown): RoomSettings {
    const t = patch && typeof patch === 'object' ? (patch as Record<string, unknown>).gameType : undefined;
    return clampSettings(isGameType(t) ? DEFAULT_SETTINGS_BY_TYPE[t] : DEFAULT_ROOM_SETTINGS, patch);
  }

  /** `userCreated` = false makes a house room (RoomSummary.house; never auto-closed). */
  private createRoomInternal(settings: RoomSettings, userCreated: boolean): Room {
    const id = `r${this.nextRoomNum++}`;
    if (userCreated) {
      // keep room names unique-ish
      const names = new Set([...this.rooms.values()].map((r) => nameKey(r.settings.name)));
      if (names.has(nameKey(settings.name))) settings.name = dedupeName(settings.name, (n) => names.has(nameKey(n)), ROOM_NAME_MAX_LEN);
    }
    const room = new Room(id, settings, this.hostApi, userCreated);
    this.rooms.set(id, room);
    this.roomListDirty = true;
    this.log(`room open: ${settings.name} (${id}, ${settings.gameType}/${settings.subMode}, ${settings.mode}${settings.mode === 'teams' ? ' ' + settings.teamCount : ''}, bots ${settings.botFill}${userCreated ? '' : ', house'})`);
    return room;
  }

  /**
   * createRoom with abuse caps (server mode): a connection's previous room is recycled (closed at once)
   * when nobody else is in it, open user rooms per client address are capped, and so is the total.
   */
  private createRoomFor(user: ZoneUser, patch: unknown): void {
    const settings = this.settingsFor(patch);
    const named = !!patch && typeof patch === 'object' && (patch as Record<string, unknown>).name !== undefined;
    let flagged: string[] | undefined;
    if (named) {
      const chk = this.nameCheck(user, settings.name, 'room', null);
      if (!chk.ok) {
        user.sink.sendMsg({ type: 'error', message: chk.selfharm ? MSG_CARE_NAME : MSG_ROOM_NAME_REFUSED });
        if (chk.selfharm) this.tell(user, MSG_CARE_NAME); // the toast fades; the chat keeps the kind note
        return;
      }
      flagged = chk.flagged;
    }
    if (!SUB_MODES[settings.subMode].ready) {
      // The Zone refuses a type (or sub-mode) that isn't implemented yet (section 3.2).
      user.sink.sendMsg({ type: 'error', message: `${GAME_TYPES[settings.gameType].name} isn't open yet.` });
      return;
    }
    const slot = this.userRoomSlot(user, 'Too many rooms open right now.');
    if (!slot.ok) { user.sink.sendMsg({ type: 'error', message: slot.message }); return; }
    const room = this.openUserRoom(user, settings, slot.recyclable, 'lobby');
    // §5.7: an accepted (human-chosen) room name is logged under its final (deduped) spelling
    if (named) this.nameAccepted(user, room.settings.name, 'room', room, flagged);
  }

  /**
   * SEC-3 caps on opening one more user-created room for `user` (Create, and Quick Play overflow rooms):
   * offline the custom-room cap; online the zone-wide MAX_ROOMS and the per-address MAX_ROOMS_PER_ADDRESS.
   * `recyclable` = the connection's previous room when nobody else is in it (closed once the new one opens,
   * so one connection never holds more than one empty room).
   */
  private userRoomSlot(user: ZoneUser, fullMessage: string): { ok: true; recyclable?: Room } | { ok: false; message: string } {
    const prev = user.ownedRoomId ? this.rooms.get(user.ownedRoomId) : undefined;
    const recyclable = prev && prev.userCreated && prev.humans.every((p) => p.playerId === user.playerId) ? prev : undefined;
    if (this.opts.local) {
      if (!this.makeLocalCustomSlot(user)) return { ok: false, message: `Up to ${LOCAL_MAX_CUSTOM_ROOMS} custom games at a time — leave one first.` };
      return { ok: true };
    }
    if (this.rooms.size - (recyclable ? 1 : 0) >= this.limits.maxRooms) return { ok: false, message: fullMessage };
    if (user.address) {
      let mine = 0;
      for (const r of this.rooms.values()) if (r.userCreated && r !== recyclable && r.creatorAddress === user.address) mine++;
      if (mine >= this.limits.maxRoomsPerAddress) return { ok: false, message: `Your network already has ${mine} rooms open — join one of those instead.` };
    }
    return { ok: true, recyclable };
  }

  /** Open a user-created room owned by `user` (after userRoomSlot said yes), join it, and recycle the old one. */
  private openUserRoom(user: ZoneUser, settings: RoomSettings, recyclable: Room | undefined, intent: JoinIntent | 'quick'): Room {
    const room = this.createRoomInternal(settings, true);
    room.creatorAddress = user.address;
    this.joinRoom(user, room, intent);
    user.ownedRoomId = room.id;
    if (!this.opts.local && recyclable && recyclable !== room && recyclable.humanCount === 0 && this.rooms.has(recyclable.id)) {
      this.closeRoom(recyclable);
    }
    return room;
  }

  /**
   * Offline custom-room cap (section 2.6): make space for one more user-created room by closing the oldest
   * one that has no human (never the caller's current room). False = every custom room is occupied.
   */
  private makeLocalCustomSlot(user: ZoneUser): boolean {
    const custom = [...this.rooms.values()].filter((r) => r.userCreated);
    let excess = custom.length - (LOCAL_MAX_CUSTOM_ROOMS - 1);
    for (const r of custom) {
      if (excess <= 0) break;
      if (r === user.room || r.humanCount > 0) continue;
      this.closeRoom(r);
      excess--;
    }
    return excess <= 0;
  }

  /**
   * v0.3 (section 3.5): join `room` with `intent`. Seats follow Room.canJoin (pilot seats, or spectator
   * slots for 'watch'); an online Watch from the network of a pilot in the room is refused (fix #2). An
   * intent for the room the user is already in is applied in place ('lobby' just resends the room state).
   */
  private joinRoom(user: ZoneUser, room: Room, intent: JoinIntent | 'quick' = 'lobby'): void {
    if (user.room === room) {
      if (intent === 'lobby') user.sink.sendMsg(room.roomStateMsg());
      else room.onJoinIntent(user, intent);
      return;
    }
    if (!room.canJoin(intent)) {
      const message = intent === 'watch' && room.phase !== 'playing' ? 'That match is not running — join the room instead.' : 'That room is full.';
      user.sink.sendMsg({ type: 'error', message });
      return;
    }
    if (intent === 'watch') {
      const why = room.spectateRefusal(user);
      if (why) { user.sink.sendMsg({ type: 'error', message: why }); return; }
    }
    const wasInLobby = !user.room;
    if (user.room) this.leaveRoom(user, false);
    if (!room.addUser(user, room.joinsAsSpectator(intent))) {
      user.sink.sendMsg({ type: 'error', message: 'That room is full.' });
      if (!wasInLobby) this.sendZoneLobby(user);
      return;
    }
    room.onJoinIntent(user, intent);
    this.lobbyDirty = true;
    room.markDirty();
  }

  /**
   * v0.3 Quick Play (section 3.4): join the best eligible room of type `t` (and sub-mode, if given) with
   * the server-internal 'quick' intent, or create an overflow room when none is eligible.
   */
  private quickPlay(user: ZoneUser, rawType: unknown, rawSub: unknown): void {
    const err = (message: string): void => user.sink.sendMsg({ type: 'error', message });
    if (!isGameType(rawType)) { err('Unknown game type.'); return; }
    const t: GameType = rawType;
    const T = GAME_TYPES[t];
    let sub: SubMode | undefined;
    if (rawSub !== undefined && rawSub !== null) {
      if (!isSubMode(rawSub) || !T.subModes.includes(rawSub)) { err(`${T.name} has no such mode.`); return; }
      if (!SUB_MODES[rawSub].ready) { err(`${T.name} · ${subModeLabel(t, rawSub)} isn't open yet.`); return; }
      sub = rawSub;
    }
    const s0 = sub ?? firstReadySubMode(t);
    if (!s0) { err(`${T.name} isn't open yet.`); return; }
    // Already in a matching room where this user holds (or can take) a pilot seat: stay and apply the Quick
    // Play there. A spectator of a full room looks for a room with a free seat instead.
    const cur = user.room;
    if (cur && cur.settings.gameType === t && (!sub || cur.settings.subMode === sub) && SUB_MODES[cur.settings.subMode].ready
      && cur.canHoldPilotSeat(user)) {
      cur.onJoinIntent(user, 'quick');
      return;
    }
    let best: Room | null = null;
    let bestScore = -1;
    for (const r of this.rooms.values()) {
      if (r === cur || r.riftDeparting) continue;
      const sc = quickPlayScore(r.summary(), t, sub);
      if (sc > bestScore) { bestScore = sc; best = r; } // ties: the earlier room
    }
    if (!best) {
      // Overflow room: a user-created room owned by this connection, under the same SEC-3 caps as Create
      // (per-address count, one empty room per connection, zone-wide MAX_ROOMS).
      const slot = this.userRoomSlot(user, 'All game slots are busy — try again in a moment.');
      if (!slot.ok) { err(slot.message); return; }
      const names = new Set([...this.rooms.values()].map((r) => nameKey(r.settings.name)));
      let k = 1;
      const base = `${T.houseName} · ${SUB_MODES[s0].short}`;
      while (names.has(nameKey(`${base} #${k}`))) k++;
      const room = this.openUserRoom(user, clampSettings(DEFAULT_SETTINGS_BY_TYPE[t], { gameType: t, subMode: s0, name: `${base} #${k}` }), slot.recyclable, 'quick');
      this.log(`quick play overflow: ${room.settings.name}`);
      return;
    }
    this.joinRoom(user, best, 'quick');
  }

  /** Zone-lobby view for a user who is (back) in the zone lobby. */
  private sendZoneLobby(user: ZoneUser): void {
    this.lobbyDirty = true;
    user.sink.sendMsg(this.roomListMsg());
    user.sink.sendMsg(this.lobbyStateMsg());
    user.sink.sendMsg({ type: 'chatHistory', lines: this.zoneHistoryFor(user) });
  }

  private leaveRoom(user: ZoneUser, backToLobby = true): void {
    const room = user.room;
    if (!room) return;
    room.removeUser(user);
    user.room = null;
    if (backToLobby) this.sendZoneLobby(user);
  }

  private findRoom(q: string): Room | undefined {
    const list = [...this.rooms.values()];
    const n = parseInt(q, 10);
    if (Number.isFinite(n) && String(n) === q.trim() && n >= 1 && n <= list.length) return list[n - 1];
    const lq = q.toLowerCase();
    return this.rooms.get(q) ?? list.find((r) => r.settings.name.toLowerCase() === lq)
      ?? list.find((r) => r.settings.name.toLowerCase().startsWith(lq));
  }

  private handleUser(user: ZoneUser, msg: ClientMsg): void {
    switch (msg.type) {
      case 'hello': return; // already greeted
      case 'listRooms': user.sink.sendMsg(this.roomListMsg()); return;
      case 'createRoom': this.createRoomFor(user, msg.settings); return;
      case 'joinRoom': {
        const room = typeof msg.roomId === 'string' ? this.rooms.get(msg.roomId) : undefined;
        if (!room) { user.sink.sendMsg({ type: 'error', message: 'That room no longer exists.' }); user.sink.sendMsg(this.roomListMsg()); return; }
        // Whitelist (fix #20): 'quick' is server-internal — LocalTransport hands messages over unvalidated.
        const intent: JoinIntent = msg.intent === 'play' || msg.intent === 'watch' ? msg.intent : 'lobby';
        this.joinRoom(user, room, intent);
        return;
      }
      case 'quickPlay': this.quickPlay(user, msg.gameType, msg.subMode); return;
      // v0.3 Hangar messages belong to the ProfileService (§7.3.2); never forwarded to a room.
      case 'equip': case 'seenItems': this.profileOp(user, msg); return;
      case 'leaveRoom': this.leaveRoom(user); return;
      case 'setName': this.renameUser(user, typeof msg.name === 'string' ? msg.name : '', 'msg'); return;
      case 'chat': {
        const text = sanitizeText(msg.text, CHAT_MAX_LEN);
        if (/^\/leave\b/i.test(text)) { if (user.room) this.leaveRoom(user); return; }
        // /report and the moderator commands work the same in the zone lobby and in every room.
        if (this.moderationCommand(user, text)) return;
        if (user.room) { user.room.handle(user, msg); return; }
        this.lobbyChat(user, text);
        return;
      }
      default:
        if (user.room) user.room.handle(user, msg);
    }
  }

  private lobbyChat(user: ZoneUser, text: string): void {
    if (!text) return;
    if (!allowChat(user, Date.now())) { this.tell(user, 'Slow down — chat is rate limited.'); return; }
    if (text.startsWith('/') && !text.startsWith('//')) {
      const parts = text.slice(1).trim().split(/\s+/);
      const cmd = (parts[0] || '').toLowerCase();
      const arg = parts.slice(1).join(' ');
      switch (cmd) {
        case 'help': case '?': for (const l of ZONE_HELP) this.tell(user, l); return;
        case 'name': if (arg) this.renameUser(user, arg); else this.tell(user, 'Usage: /name <callsign>'); return;
        case 'rooms': {
          let i = 1;
          for (const r of this.rooms.values()) {
            const s = r.summary();
            const shape = s.gameType === 'dungeon' ? `${s.floors} floors` : s.mode === 'ffa' ? 'FFA' : `${s.teamCount} teams`;
            const watch = s.spectators ? ` (${s.spectators} watching)` : '';
            this.tell(user, `${i++}. ${s.name} — ${GAME_TYPES[s.gameType].name} ${subModeShort(s.gameType, s.subMode)}, ${shape}, `
              + `${s.humans - s.spectators} pilots + ${s.bots} bots${watch}, ${r.statusLine()}`);
          }
          return;
        }
        case 'play': {
          const t = parseGameType(parts[1] || '');
          if (!t) { this.tell(user, 'Usage: /play dungeon|arena|warzone [mode]'); return; }
          const rest = parts.slice(2).join(' ');
          let sub: SubMode | undefined;
          if (rest) {
            const m = parseSubMode(t, rest);
            if (!m) {
              const list = readySubModes(t).map((x) => subModeShort(t, x).toLowerCase()).join(', ') || 'none open yet';
              this.tell(user, `${GAME_TYPES[t].name} modes: ${list}`);
              return;
            }
            sub = m;
          }
          this.quickPlay(user, t, sub);
          return;
        }
        case 'join': {
          const r = arg ? this.findRoom(arg) : undefined;
          if (!r) { this.tell(user, 'No such room — try /rooms'); return; }
          this.joinRoom(user, r);
          return;
        }
        default: this.tell(user, `Unknown command /${cmd} — try /help`); return;
      }
    }
    if (text.startsWith('//')) text = text.slice(2).trim();
    if (!text) return;
    const v = this.chatVerdict(user, text, { roomId: null, roomName: ZONE_LOG_ROOM_NAME, channel: 'all', team: NO_TEAM });
    if (v.text === null) return;
    const line: ChatLine = v.as === 'system'
      ? { fromPlayerId: 0, fromName: '', channel: 'system', team: NO_TEAM, text: v.text, time: Date.now() }
      : { fromPlayerId: user.playerId, fromName: user.name, channel: 'all', team: NO_TEAM, text: v.text, time: Date.now() };
    this.pushZoneChat(line, v.skipSender ? user : null);
  }

  // ------------------------------------------------------------------------------------------
  // Moderation (room/moderation.ts)
  // ------------------------------------------------------------------------------------------

  private modUser(u: ZoneUser): ModUser {
    return {
      playerId: u.playerId, name: u.name, accountId: u.account?.accountId ?? null, username: u.account?.username ?? null,
      address: u.address,
    };
  }

  private pilotOf(u: ZoneUser): OnlinePilot {
    return { ...this.modUser(u), roomId: u.room?.id ?? null, roomName: u.room ? u.room.settings.name : null };
  }

  /** Run a hook call; a throw is logged and yields `fallback`. */
  private safeHook<T>(what: string, fn: (h: ModerationHook) => T, fallback: T): T {
    const h = this.mod;
    if (!h) return fallback;
    try {
      return fn(h);
    } catch (e) {
      this.log(`moderation ${what} failed: ${(e as Error)?.message ?? e}`);
      return fallback;
    }
  }

  private logChat(entry: ChatLogEntry): void {
    this.safeHook('logChat', (h) => h.logChat(entry), undefined);
  }

  /**
   * Record a strike (ModerationHook.onStrike): its private notice (non-empty string) or null, and the host's
   * strike status right after it (ModerationHook.strikeStatus; null when the hook has none).
   */
  private strikeRaw(user: ZoneUser, reason: StrikeReason, detail?: StrikeDetail): { notice: string | null; status: StrikeStatus | null } {
    const out = this.safeHook<string | null | void>('onStrike', (h) => h.onStrike(this.modUser(user), reason, detail), null);
    const notice = typeof out === 'string' && out ? out : null;
    const st = this.safeHook<StrikeStatus | null>('strikeStatus', (h) => (h.strikeStatus ? h.strikeStatus(this.modUser(user)) : null), null);
    return { notice, status: isStrikeStatus(st) ? st : null };
  }

  /**
   * Record a strike whose private notice is the hook's own (a refused name, a blocked line with substitution off):
   * the hook's notice (e.g. an automatic mute) is passed on; with a strike status at limit − 1, MSG_WARN_LAST.
   */
  private strike(user: ZoneUser, reason: StrikeReason, detail?: StrikeDetail): void {
    const { notice, status } = this.strikeRaw(user, reason, detail);
    if (notice) this.tell(user, notice);
    else if (status && status.limit > 1 && status.count === status.limit - 1) this.tell(user, MSG_WARN_LAST);
  }

  /** One more warned line for `user` in WARN_WINDOW_MS; returns how many there are now. */
  private bumpWarnings(user: ZoneUser): number {
    const t = Date.now();
    let arr = this.warned.get(user.playerId);
    if (!arr) { arr = []; this.warned.set(user.playerId, arr); }
    while (arr.length && t - arr[0]! > WARN_WINDOW_MS) arr.shift();
    arr.push(t);
    if (arr.length > 50) arr.shift();
    return arr.length;
  }

  /**
   * A2: the strike + generic private warning for a substituted (blocked or masked) line. It never names the words,
   * the category or the tag. With the host's strike status the step follows its count (1st, 2nd, "one more ..." at
   * limit − 1) and its notice (the auto-mute line) replaces the warning; without one (offline, an older hook) — or
   * when the host's tag policy didn't count the line — the Zone's own count in WARN_WINDOW_MS picks the step, and an
   * older hook's notice follows the warning.
   */
  private warnSender(user: ZoneUser, reason: StrikeReason, detail: StrikeDetail): void {
    const n = this.bumpWarnings(user);
    const { notice, status } = this.strikeRaw(user, reason, detail);
    if (status) {
      if (notice) { this.tell(user, notice); return; }
      this.tell(user, status.count > 0 ? warningText(status.count, status.limit) : warningText(n, 0));
      return;
    }
    this.tell(user, warningText(n, 0));
    if (notice) this.tell(user, notice);
  }

  /** Does `text` pass the word filter (action 'pass') at `strictness`? A throwing filter = no. */
  private passesFilter(text: string, strictness: Strictness = this.filterOpts.strictness): boolean {
    try {
      return filterChat(text, { strictness }).action === 'pass';
    } catch {
      return false;
    }
  }

  /** Fisher-Yates with the Zone's seeded Rng; the first line drawn (the last element) is never `avoid`. */
  private shuffledDeck(lines: readonly string[], avoid: string | null): string[] {
    const d = [...lines];
    for (let i = d.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      const t = d[i]!; d[i] = d[j]!; d[j] = t;
    }
    if (d.length > 1 && d[d.length - 1] === avoid) {
      const t = d[0]!; d[0] = d[d.length - 1]!; d[d.length - 1] = t;
    }
    return d;
  }

  /**
   * A2: the next positive line from the shuffled deck (seeded from bootId; never the same line twice in a row).
   * Each line is re-checked against the CURRENT filter (a host custom term added later may match one); null when no
   * line passes (the substitute is then hidden).
   */
  private nextPositive(): string | null {
    const lines = this.chatOpts.positiveLines;
    if (!lines.length) return null;
    for (let tries = 0; tries < lines.length * 2 + 2; tries++) {
      if (!this.deck.length) this.deck = this.shuffledDeck(lines, this.lastPositive);
      const s = this.deck.pop()!;
      if (s === this.lastPositive && lines.length > 1) continue;
      if (!this.passesFilter(s)) continue;
      this.lastPositive = s;
      return s;
    }
    return null;
  }

  /**
   * RoomHost.chatVerdict (and the zone lobby): mute → repeat flood → word filter, then the chat log (with `roomUid`
   * and `display`), strikes, warnings and alerts. What to broadcast (spec §5.8):
   *  - pass / flag: the (display-tamed) line as typed, to everyone; a review-only (unconfirmed) SELF-HARM hit also
   *    sends the host the wellbeing alert (§5.8: SELF-HARM's notify can't be switched off) — no note, no strike;
   *  - SELF-HARM (any enforced hit): nothing — withheld, the sender gets MSG_CARE (with 988), no strike, and the host
   *    an urgent wellbeing alert (ModerationHook.alert 'selfharm'); a threat in it alerts too;
   *  - blocked or masked (A2, substitute 'sender' / 'system' / 'hide'): everyone EXCEPT the sender sees a positive
   *    line under the sender's name / as a system line / nothing; the sender gets the generic escalating warning
   *    (warnSender) and never sees the substitute; a THREAT also sends the urgent alert;
   *  - substitute 'masked' (test-only, v0.5): masked lines starred for everyone, blocked lines withheld (MSG_BLOCKED);
   *  - a throwing filter: nothing (fail closed), MSG_NOT_SENT, no strike.
   * Muted and repeat-flood lines are withheld but still read: their hits are logged and a self-harm statement or a
   * threat still reaches the host. Offline (no hook) the same rules apply; nothing is logged.
   */
  private chatVerdict(user: ZoneUser, text: string, where: ChatWhere): ChatVerdict {
    const now = Date.now();
    const NONE: ChatVerdict = { text: null, as: 'sender', skipSender: false };
    const log = (action: ChatAction, shown: string, hits: string[], display: ChatDisplay): ChatLogEntry => {
      const entry: ChatLogEntry = {
        time: now, roomId: where.roomId, roomName: where.roomName, roomUid: this.roomUidOf(where.roomId),
        channel: where.channel, team: where.team, playerId: user.playerId, name: user.name,
        accountId: user.account?.accountId ?? null, address: user.address, original: text, shown, action, hits, display,
      };
      this.logChat(entry);
      return entry;
    };
    /** The filter's verdict; null when it threw (fail closed: the line is not shown). */
    const verdict = (): FilterResult | null => {
      try {
        return filterChat(text, this.filterOpts);
      } catch (e) {
        this.log(`moderation filterChat failed: ${(e as Error)?.message ?? e}`);
        return null;
      }
    };
    /** A hit of the SELF-HARM category (kept first, so the 20-label cap never drops the one that hides a line). */
    const isSelfHarmHit = (h: unknown): boolean => !!h && typeof h === 'object'
      && typeof (h as { category?: unknown }).category === 'string' && tagOfCategory((h as { category: string }).category) === TAG_SELF_HARM;
    const labels = (r: FilterResult | null): string[] => {
      if (!r) return [FILTER_ERROR];
      if (!Array.isArray(r.hits)) return [];
      const hits = r.hits.length > 20 ? [...r.hits.filter(isSelfHarmHit), ...r.hits.filter((h) => !isSelfHarmHit(h))] : r.hits;
      return hits.slice(0, 20).map(hitLabel);
    };
    /** A review-only ('flag' tier: an unconfirmed custom term) SELF-HARM hit: the host hears of it, nothing else changes. */
    const reviewSelfHarm = (r: FilterResult | null): boolean =>
      !!r && Array.isArray(r.hits) && tagsOf(r.hits.filter((h) => !!h && typeof h === 'object' && h.tier === 'flag')).includes(TAG_SELF_HARM);
    const tame = (s: string): string => {
      try { const t = tameText(s); if (typeof t === 'string' && t.trim()) return t; } catch { /* untamed */ }
      return s;
    };
    /**
     * A line that is withheld anyway (muted / repeat flood) is still read by the filter: its hits go to the log, and
     * a self-harm statement or a threat still reaches the host (a pilot who was just muted is exactly the one who
     * might write one). No strike: the line was never going to be shown.
     */
    const withheld = (action: 'muted' | 'spam'): ChatVerdict => {
      const r = verdict();
      const tags = r ? enforcedTagsOf(r.hits) : [];
      const selfharm = tags.includes(TAG_SELF_HARM);
      const entry = log(action, '', labels(r), selfharm ? 'withheld' : 'hidden');
      if (selfharm) { this.tell(user, MSG_CARE); this.alert(user, 'selfharm', entry); }
      else if (reviewSelfHarm(r)) this.alert(user, 'selfharm', entry);
      if (tags.includes(TAG_THREAT)) this.alert(user, 'threat', entry);
      return NONE;
    };
    const mute = this.safeHook<MuteInfo | null>('isMuted', (h) => h.isMuted(this.modUser(user)), null);
    if (mute) {
      this.tell(user, mutedMessage(mute));
      return withheld('muted');
    }
    const recent = user.recentChat ?? (user.recentChat = []);
    while (recent.length && (now - recent[0].time > SPAM_RECENT_MS || recent.length > SPAM_RECENT_MAX)) recent.shift();
    let spam = false;
    try { spam = isSpam(recent, text, now) === true; } catch (e) { this.log(`moderation isSpam failed: ${(e as Error)?.message ?? e}`); }
    if (spam) {
      this.tell(user, MSG_SPAM);
      return withheld('spam');
    }
    recent.push({ text, time: now });
    const r = verdict();
    // Fail closed: a filter error never lets an unchecked line through (and is no strike: not the pilot's doing).
    if (!r) {
      log('block', '', labels(null), 'hidden');
      this.tell(user, MSG_NOT_SENT);
      return NONE;
    }
    const hits = labels(r);
    // pass, or review-only custom hits ('flag'): shown as typed (display-tamed), no warning, no strike
    if (r.action === 'pass' || r.action === 'flag') {
      const shown = tame(text);
      const entry = log(r.action, shown, hits, 'as-typed');
      if (reviewSelfHarm(r)) this.alert(user, 'selfharm', entry); // entry.action 'flag' tells the host it is unconfirmed
      return { text: shown, as: 'sender', skipSender: false };
    }
    const action: 'block' | 'mask' = r.action === 'mask' && typeof r.text === 'string' && r.text ? 'mask' : 'block';
    const tags = enforcedTagsOf(r.hits);
    // SELF-HARM: withheld, never replaced with a cheerful line, never punished (not even for other words in the line)
    if (tags.includes(TAG_SELF_HARM)) {
      const entry = log(action, '', hits, 'withheld');
      this.tell(user, MSG_CARE);
      this.alert(user, 'selfharm', entry);
      if (tags.includes(TAG_THREAT)) this.alert(user, 'threat', entry);
      return NONE;
    }
    const threat = tags.includes(TAG_THREAT);
    const reason: StrikeReason = threat ? 'threat' : 'language';
    const detail: StrikeDetail = { tags: tags.slice(), action };
    const mode = this.chatOpts.substitute;
    if (mode === 'masked') {
      // v0.5 behaviour (substitution off; test-only): starred for everyone, or withheld with MSG_BLOCKED + a strike
      if (action === 'mask') {
        const shown = tame(r.text);
        const entry = log('mask', shown, hits, 'masked');
        if (reviewSelfHarm(r)) this.alert(user, 'selfharm', entry);
        return { text: shown, as: 'sender', skipSender: false };
      }
      const entry = log('block', '', hits, 'hidden');
      this.tell(user, MSG_BLOCKED);
      this.strike(user, reason, detail);
      if (threat) this.alert(user, 'threat', entry);
      if (reviewSelfHarm(r)) this.alert(user, 'selfharm', entry);
      return NONE;
    }
    // A2 substitution: everyone else sees a positive line (or nothing); the sender gets the generic warning
    const positive = mode === 'hide' ? null : this.nextPositive();
    const display: ChatDisplay = positive === null ? 'hidden' : mode === 'system' ? 'system' : 'substituted';
    const entry = log(action, positive ?? '', hits, display);
    this.warnSender(user, reason, detail);
    if (threat) this.alert(user, 'threat', entry);
    if (reviewSelfHarm(r)) this.alert(user, 'selfharm', entry);
    if (positive === null) return NONE;
    return { text: positive, as: mode === 'system' ? 'system' : 'sender', skipSender: true };
  }

  /** A self-harm statement or a threat: tell the host (ModerationHook.alert; never a strike by itself). */
  private alert(user: ZoneUser, kind: AlertKind, entry: ChatLogEntry): void {
    this.safeHook('alert', (h) => h.alert?.(this.modUser(user), kind, entry), undefined);
  }

  /**
   * checkName that never throws (a failing filter refuses the name). `labels` = the log labels of the refusal, one
   * per hit (so a review-only "flag:..." label among them is found by the log's review filter);
   * `severe` = a block-tier hit other than self-harm (slur, hate, sexual, threat), the only kind of refused name
   * that is a strike; `selfharm` = an enforced (block / mask tier) SELF-HARM hit: wellbeing, never an offence
   * (§5.8, §5.11). The name is not used, the pilot gets the kind note, the host the alert, and there is no strike
   * even when other words sit next to it (the same rule as a chat line).
   * `flagged` = log labels of an ALLOWED name that review-only custom terms matched (logged, never a strike).
   */
  private checkNameSafe(name: string): { ok: true; flagged?: string[] } | { ok: false; labels: string[]; severe: boolean; selfharm: boolean } {
    try {
      const r = checkName(name, this.filterOpts);
      if (r && r.ok) {
        const flags: unknown[] = r.action === 'flag' && Array.isArray(r.hits) ? r.hits : [];
        return flags.length ? { ok: true, flagged: flags.slice(0, 5).map(hitLabel) } : { ok: true };
      }
      const list: unknown[] = Array.isArray(r?.hits) ? r.hits : [];
      const labels = list.slice(0, 5).map(hitLabel);
      const selfharm = enforcedTagsOf(list).includes(TAG_SELF_HARM);
      const severe = list.some((h) => {
        if (!h || typeof h !== 'object') return false;
        const o = h as { tier?: unknown; category?: unknown };
        return o.tier === 'block' && !(typeof o.category === 'string' && tagOfCategory(o.category) === TAG_SELF_HARM);
      });
      return {
        ok: false, labels: labels.length ? labels : [r && typeof r.reason === 'string' && r.reason ? r.reason : 'name'], severe, selfharm,
      };
    } catch (e) {
      this.log(`moderation checkName failed: ${(e as Error)?.message ?? e}`);
      return { ok: false, labels: [FILTER_ERROR], severe: false, selfharm: false };
    }
  }

  /** One 'name' / 'room' log entry for `user` (roomUid of `room`, or of the zone lobby). */
  private nameEntry(user: ZoneUser, channel: Extract<LogChannel, 'name' | 'room'>, room: Room | null, original: string,
    shown: string, action: ChatAction, hits: string[], display: ChatDisplay): ChatLogEntry {
    return {
      time: Date.now(), roomId: room?.id ?? null, roomName: room ? room.settings.name : ZONE_LOG_ROOM_NAME,
      roomUid: this.roomUidOf(room?.id ?? null), channel, team: NO_TEAM, playerId: user.playerId, name: user.name,
      accountId: user.account?.accountId ?? null, address: user.address, original, shown, action, hits, display,
    };
  }

  /**
   * A refused name attempt: always logged (channel 'name' / 'room'). A strike only when `severe` (a slur, hate,
   * sexual term or threat): profanity inside a name is refused but not punished, because real names collide with
   * the list and a student retrying their own name must not end up auto-muted. A reserved callsign is logged with
   * the label 'reserved' (never a strike). `selfharm` (a name read as a self-harm statement): logged as 'withheld',
   * the host gets the wellbeing alert, and there is never a strike; the caller tells the pilot MSG_CARE_NAME.
   */
  private nameRefused(user: ZoneUser, attempted: string, labels: string[], severe: boolean,
    channel: Extract<LogChannel, 'name' | 'room'>, room: Room | null, selfharm = false): void {
    const entry = this.nameEntry(user, channel, room, attempted, '', 'block', labels, selfharm ? 'withheld' : 'hidden');
    this.logChat(entry);
    if (selfharm) { this.alert(user, 'selfharm', entry); return; }
    const tags = enforcedTagsOf(labels).filter((t) => t !== TAG_SELF_HARM); // StrikeDetail never carries SELF-HARM
    if (severe) this.strike(user, 'name', { tags, action: 'block' });
  }

  /** An account username that review-only custom terms (or the host's current lists) match: logged as 'flag'. */
  private nameFlagged(user: ZoneUser, name: string, hits: string[], channel: Extract<LogChannel, 'name' | 'room'>, room: Room | null): void {
    this.logChat(this.nameEntry(user, channel, room, name, name, 'flag', hits, 'as-typed'));
  }

  /**
   * §5.7: an accepted human-chosen name — a guest's joining callsign or /name, a room name at create or rename — is
   * logged as 'pass' (or 'flag' with its hits when review-only custom terms matched). Accounts' callsigns are their
   * usernames and never change, so they are not logged here.
   */
  private nameAccepted(user: ZoneUser, name: string, channel: Extract<LogChannel, 'name' | 'room'>, room: Room | null, flagged?: string[]): void {
    const f = flagged && flagged.length ? flagged : null;
    const entry = this.nameEntry(user, channel, room, name, name, f ? 'flag' : 'pass', f ?? [], 'as-typed');
    this.logChat(entry);
    // a review-only (unconfirmed) SELF-HARM term in a name just chosen: the host hears of it (as for a chat line)
    if (f && tagsOf(f).includes(TAG_SELF_HARM)) this.alert(user, 'selfharm', entry);
  }

  /** RoomHost.roomNameAccepted: a room host's rename went through (Room.applySettings) — log the accepted name. */
  private roomNameAccepted(user: ZoneUser | null, name: string): void {
    if (!user || this.users.get(user.playerId) !== user) return;
    const chk = this.checkNameSafe(name);
    this.nameAccepted(user, name, 'room', user.room, chk.ok ? chk.flagged : undefined);
  }

  /**
   * Is a human-chosen name (callsign or room name) allowed by the word filter? A refusal is logged (and a strike when
   * severe); an allowed name's review-only hits come back in `flagged` for the acceptance log (nameAccepted).
   */
  private nameCheck(user: ZoneUser | null, name: string, channel: 'name' | 'room', room: Room | null): { ok: boolean; flagged?: string[]; selfharm?: boolean } {
    const chk = this.checkNameSafe(name);
    if (chk.ok) return { ok: true, flagged: chk.flagged };
    if (user) this.nameRefused(user, name, chk.labels, chk.severe, channel, room, chk.selfharm);
    return { ok: false, selfharm: chk.selfharm };
  }

  /** §4.1: a reserved callsign (RESERVED_CALLSIGNS or setReservedNames) or a look-alike of one? */
  private isReservedCallsignName(name: string): boolean {
    try { return isReservedCallsign(name, this.reservedExtra); } catch { return false; }
  }

  /**
   * A generated guest callsign ("Pilot4821") for a refused or reserved one; the Zone's seeded Rng. A taken draw is
   * redrawn a few times before uniqueName's digit suffix ("Pilot48212") settles it. A draw that is itself a reserved
   * look-alike (setReservedNames: a host admin named "Pilot1") is never used; when every draw of a stem is, the
   * next stem is tried (GENERATED_CALLSIGN_STEMS).
   */
  private generatedCallsign(pid: PlayerId): string {
    let first = '';
    for (const stem of GENERATED_CALLSIGN_STEMS) {
      let suffixed = '';
      for (let i = 0; i < GENERATED_CALLSIGN_TRIES; i++) {
        const want = `${stem}${this.rng.int(1000, 9999)}`;
        const name = this.uniqueName(want, pid);
        first ||= name;
        if (this.isReservedCallsignName(name)) continue;
        if (name === want) return name;
        suffixed ||= name;
      }
      if (suffixed) return suffixed;
    }
    return first; // every stem reserved (a pathological reserved list): still a unique name
  }

  /**
   * `/report` (everyone) and the moderator commands (MOD_COMMANDS), in the zone lobby and in rooms. True = handled.
   * A pilot the hook doesn't call a moderator gets exactly the ordinary unknown-command line, so the commands'
   * existence never shows (same chat budget, same text as any other unknown command).
   */
  private moderationCommand(user: ZoneUser, text: string): boolean {
    if (!text.startsWith('/') || text.startsWith('//')) return false;
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    if (cmd !== REPORT_COMMAND && !MOD_COMMANDS.has(cmd)) return false;
    const args = parts.slice(1);
    const mu = this.modUser(user);
    // A moderator's own commands skip the chat budget (a teacher muting / kicking several pilots in a row must not
    // be told to slow down; the per-connection message limits still apply). Everyone else pays it like any command.
    const moderator = cmd !== REPORT_COMMAND && this.safeHook('isAdmin', (h) => h.isAdmin(mu) === true, false);
    if (!moderator && !allowChat(user, Date.now())) { this.tell(user, 'Slow down — chat is rate limited.'); return true; }
    if (cmd === REPORT_COMMAND) {
      if (!this.mod) { this.tell(user, MSG_REPORT_OFFLINE); return true; }
      const target = args[0] ?? '';
      const reason = args.slice(1).join(' ').trim();
      if (!target || !reason) { this.tell(user, MSG_REPORT_USAGE); return true; }
      const room = user.room;
      this.replyTo(user, 'report', (h) => h.report(mu, target, reason, { roomId: room?.id ?? null, roomName: room ? room.settings.name : ZONE_LOG_ROOM_NAME }));
      return true;
    }
    if (!moderator) {
      this.tell(user, `Unknown command /${cmd} — try /help`);
      return true;
    }
    this.replyTo(user, cmd, (h) => h.adminCommand(mu, cmd, args));
    return true;
  }

  /** Deliver a hook's reply lines (sync or async) to `user` as private system lines. */
  private replyTo(user: ZoneUser, what: string, fn: (h: ModerationHook) => ReplyLines): void {
    const h = this.mod;
    if (!h) return;
    const fail = (e: unknown): void => {
      this.log(`moderation /${what} failed: ${(e as Error)?.stack ?? e}`);
      this.tell(user, MOD_FAILED_MSG);
    };
    const send = (lines: unknown): void => {
      if (!Array.isArray(lines)) return;
      for (const l of lines) if (typeof l === 'string' && l) this.tell(user, l.slice(0, 500));
    };
    let out: ReplyLines;
    try { out = fn(h); } catch (e) { fail(e); return; }
    if (out && typeof (out as Promise<string[]>).then === 'function') (out as Promise<string[]>).then(send, fail);
    else send(out);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
