// OWNER: ROOM agent. Frozen public API — the transport-agnostic "server".
// The Node server wraps it with WebSockets; the browser's offline mode (LocalTransport) runs it in-page.
import { CHAT_HISTORY, CHAT_MAX_LEN, MAX_PLAYING_ROOMS, NO_TEAM, ROOM_LIST_LIVE_SEC, TICK_RATE } from '../constants';
import {
  GAME_TYPES, SUB_MODES, firstReadySubMode, isGameType, isSubMode, readySubModes, subModeLabel,
} from '../data/gameTypes';
import {
  DEFAULT_ROOM_SETTINGS, DEFAULT_SETTINGS_BY_TYPE, TEAM_UNASSIGNED,
  type AccountInfo, type ChatLine, type ClientMsg, type JoinIntent, type PlayerInfo, type RoomSettings, type ServerMsg,
} from '../protocol';
import { ProfileService, type ProfileMsg } from '../profile/service';
import type { ProfileStore } from '../profile/store';
import type { GameType, PlayerId, Snapshot, SubMode } from '../types';
import { GAME_VERSION, PROTOCOL_VERSION } from '../version';
import { checkName, filterChat, isSpam, tameText, type FilterResult, type Strictness } from '../moderation/filter';
import {
  MOD_COMMANDS, MSG_BLOCKED, MSG_CARE, MSG_NAME_REFUSED, MSG_REPORT_OFFLINE, MSG_REPORT_USAGE, MSG_ROOM_NAME_REFUSED, MSG_SPAM,
  REPORT_COMMAND, SPAM_RECENT_MAX, SPAM_RECENT_MS, blockCategories, hitLabel, mutedMessage,
  type ChatAction, type ChatLogEntry, type LogChannel, type ModerationHook, type ModUser, type MuteInfo, type OnlinePilot,
  type ReplyLines, type StrikeReason,
} from './moderation';
import { Room, subModeShort } from './Room';
import {
  ConnectionRate, allowChat, takeToken, type ChatWhere, type LootGrantEntry, type LootGrantOutcome, type RoomHost,
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
}

/** Zone-lobby chat lines are logged under this room name (roomId null). */
export const ZONE_LOG_ROOM_NAME = 'Zone';

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

/** 31-bit random seed, from the platform CSPRNG when there is one (browsers, Node 19+). */
function cryptoSeed(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] >>> 1;
  }
  return Math.floor(Math.random() * 0x7fffffff);
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
  private zoneChat: ChatLine[] = [];
  private lobbyDirty = false;
  private lastLobbyTick = -1e9;
  private roomListDirty = false;
  private lastRoomListTick = -1e9;
  private tickCount = 0;
  /** Zone-wide budget for "X entered/left the zone." lines (a connect storm must not flood every lobby chat). */
  private presence: TokenBucket = { tokens: PRESENCE_BURST, at: Date.now() };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;
  private hostApi: RoomHost;
  private matchCounter = 0;
  private readonly bootId = makeBootId();
  /** v0.3 M2: the only door to profile storage (Room never touches it). */
  private readonly profiles: ProfileService;
  /** Moderation hook (null offline / in tests without one): filter only. */
  private readonly mod: ModerationHook | null;
  /** Word-filter strictness (ZoneOptions.chatFilter; 'strict' unless the host says 'standard'). */
  private readonly filterOpts: { strictness: Strictness };

  constructor(opts: ZoneOptions) {
    this.opts = opts;
    this.mod = opts.moderation ?? null;
    this.filterOpts = { strictness: opts.chatFilter === 'standard' ? 'standard' : 'strict' };
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
      chatGate: (u, text, where) => this.chatGate(u, text, where),
      roomNameAllowed: (u, name) => this.nameAllowed(u, name, 'room', u?.room ?? null),
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
    return n < MAX_PLAYING_ROOMS;
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
    if (!this.nameAllowed(user, next, 'name', user.room)) {
      if (via === 'msg') user.sink.sendMsg({ type: 'error', message: MSG_NAME_REFUSED });
      else this.tell(user, MSG_NAME_REFUSED);
      return user.name;
    }
    const old = user.name;
    user.name = next;
    const text = `${old} is now known as ${next}.`;
    if (user.room) { user.room.onRenamed(user); user.room.system(text); }
    else { this.zoneSystem(text); this.lobbyDirty = true; }
    user.sink.sendMsg(this.welcomeMsg(user));
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
    // Moderation: a guest callsign the name filter refuses becomes a generated one (logged below; a strike only when
    // the name is hateful / sexual / a slur, see nameRefused).
    let refused: { name: string; reason: string; severe: boolean } | null = null;
    if (!account) {
      const chk = this.checkNameSafe(name);
      if (!chk.ok) {
        refused = { name, reason: chk.reason, severe: chk.severe };
        name = this.uniqueName(`Pilot${1000 + Math.floor(Math.random() * 9000)}`, pid);
      }
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
    sink.sendMsg({ type: 'chatHistory', lines: this.zoneChat.slice() });
    if (refused) {
      this.nameRefused(user, refused.name, refused.reason, refused.severe, 'name', null);
      this.tell(user, `That callsign isn't allowed here — you're flying as ${user.name}. Pick another with /name.`);
    }
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

  private pushZoneChat(line: ChatLine): void {
    this.zoneChat.push(line);
    if (this.zoneChat.length > CHAT_HISTORY) this.zoneChat.splice(0, this.zoneChat.length - CHAT_HISTORY);
    const msg: ServerMsg = { type: 'chat', line };
    for (const u of this.users.values()) if (!u.room) u.sink.sendMsg(msg);
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
    if (named && !this.nameAllowed(user, settings.name, 'room', null)) {
      user.sink.sendMsg({ type: 'error', message: MSG_ROOM_NAME_REFUSED });
      return;
    }
    if (!SUB_MODES[settings.subMode].ready) {
      // The Zone refuses a type (or sub-mode) that isn't implemented yet (section 3.2).
      user.sink.sendMsg({ type: 'error', message: `${GAME_TYPES[settings.gameType].name} isn't open yet.` });
      return;
    }
    const slot = this.userRoomSlot(user, 'Too many rooms open right now.');
    if (!slot.ok) { user.sink.sendMsg({ type: 'error', message: slot.message }); return; }
    this.openUserRoom(user, settings, slot.recyclable, 'lobby');
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
    if (this.rooms.size - (recyclable ? 1 : 0) >= MAX_ROOMS) return { ok: false, message: fullMessage };
    if (user.address) {
      let mine = 0;
      for (const r of this.rooms.values()) if (r.userCreated && r !== recyclable && r.creatorAddress === user.address) mine++;
      if (mine >= MAX_ROOMS_PER_ADDRESS) return { ok: false, message: `Your network already has ${mine} rooms open — join one of those instead.` };
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
    user.sink.sendMsg({ type: 'chatHistory', lines: this.zoneChat.slice() });
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
    const shown = this.chatGate(user, text, { roomId: null, roomName: ZONE_LOG_ROOM_NAME, channel: 'all', team: NO_TEAM });
    if (shown === null) return;
    this.pushZoneChat({ fromPlayerId: user.playerId, fromName: user.name, channel: 'all', team: NO_TEAM, text: shown, time: Date.now() });
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

  /** Record a strike; the hook may answer with a private notice (e.g. an automatic mute). */
  private strike(user: ZoneUser, reason: StrikeReason): void {
    const notice = this.safeHook<string | null | void>('onStrike', (h) => h.onStrike(this.modUser(user), reason), null);
    if (typeof notice === 'string' && notice) this.tell(user, notice);
  }

  /**
   * RoomHost.chatGate (and the zone lobby): mute → repeat flood → word filter, then the chat log. Returns the text
   * to broadcast ('mask' = starred), or null when the line is not shown (the sender got a private notice).
   */
  private chatGate(user: ZoneUser, text: string, where: ChatWhere): string | null {
    const now = Date.now();
    const log = (action: ChatAction, shown: string, hits: string[]): void => this.logChat({
      time: now, roomId: where.roomId, roomName: where.roomName, channel: where.channel, team: where.team,
      playerId: user.playerId, name: user.name, accountId: user.account?.accountId ?? null, address: user.address,
      original: text, shown, action, hits,
    });
    /** The filter's verdict; null when it threw (fail closed: the line is not shown). */
    const verdict = (): FilterResult | null => {
      try {
        return filterChat(text, this.filterOpts);
      } catch (e) {
        this.log(`moderation filterChat failed: ${(e as Error)?.message ?? e}`);
        return null;
      }
    };
    const labels = (r: FilterResult | null): string[] =>
      (r ? (Array.isArray(r.hits) ? r.hits.slice(0, 20).map(hitLabel) : []) : ['filter-error']);
    /**
     * A line that is withheld anyway (muted / repeat flood) is still read by the filter: its hits go to the log, and
     * a self-harm statement or a threat still reaches the moderators (a pilot who was just muted is exactly the one
     * who might write one). No strike: the line was never going to be shown.
     */
    const withheld = (action: 'muted' | 'spam'): null => {
      const r = verdict();
      log(action, '', labels(r));
      const cats = r ? blockCategories(r.hits) : [];
      if (cats.includes('selfharm')) { this.tell(user, MSG_CARE); this.alert(user, 'selfharm'); }
      else if (cats.includes('threat')) this.alert(user, 'threat');
      return null;
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
    // Fail closed: a filter error (r === null) never lets an unchecked line through.
    const r = verdict();
    let action: ChatAction = 'block';
    let shown = '';
    const hits = labels(r);
    const blockCats = r ? blockCategories(r.hits) : [];
    if (r && r.action === 'pass') { action = 'pass'; shown = text; }
    else if (r && r.action === 'mask' && typeof r.text === 'string' && r.text) { action = 'mask'; shown = r.text; }
    if (action === 'block') {
      log('block', '', hits);
      // A line blocked only as a self-harm statement is not punished: a kind private note, and the host alerts a
      // moderator. A threat is a strike that moderators hear about at once.
      if (blockCats.length && blockCats.every((c) => c === 'selfharm')) {
        this.tell(user, MSG_CARE);
        this.strike(user, 'selfharm');
      } else {
        this.tell(user, MSG_BLOCKED);
        this.strike(user, blockCats.includes('threat') ? 'threat' : 'language');
        // a self-harm statement mixed with other blocked language still reaches the moderators
        if (blockCats.includes('selfharm')) this.alert(user, 'selfharm');
      }
      return null;
    }
    // Display taming (shouting lowercased, character floods cut back): what everyone sees, and what is logged.
    try { const tamed = tameText(shown); if (typeof tamed === 'string' && tamed.trim()) shown = tamed; } catch { /* untamed */ }
    log(action, shown, hits);
    return shown;
  }

  /** A self-harm statement / threat in a withheld line: tell the moderators (ModerationHook.alert; no strike). */
  private alert(user: ZoneUser, kind: 'selfharm' | 'threat'): void {
    this.safeHook('alert', (h) => h.alert?.(this.modUser(user), kind), undefined);
  }

  /**
   * checkName that never throws (a failing filter refuses the name). `reason` = log label(s) of the refusal;
   * `severe` = a block-tier hit (slur, hate, sexual, threat), the only kind of refused name that is a strike.
   */
  private checkNameSafe(name: string): { ok: true } | { ok: false; reason: string; severe: boolean } {
    try {
      const r = checkName(name, this.filterOpts);
      if (r && r.ok) return { ok: true };
      const list: unknown[] = Array.isArray(r?.hits) ? r.hits : [];
      const hits = list.slice(0, 5).map(hitLabel).join(', ');
      const severe = list.some((h) => !!h && typeof h === 'object' && (h as { tier?: unknown }).tier === 'block');
      return { ok: false, reason: hits || (r && typeof r.reason === 'string' && r.reason ? r.reason : 'name'), severe };
    } catch (e) {
      this.log(`moderation checkName failed: ${(e as Error)?.message ?? e}`);
      return { ok: false, reason: 'filter-error', severe: false };
    }
  }

  /**
   * A refused name attempt: always logged (channel 'name' / 'room'). A strike only when `severe` (a slur, hate,
   * sexual term or threat): profanity inside a name is refused but not punished, because real names collide with
   * the list and a student retrying their own name must not end up auto-muted.
   */
  private nameRefused(user: ZoneUser, attempted: string, reason: string, severe: boolean,
    channel: Extract<LogChannel, 'name' | 'room'>, room: Room | null): void {
    this.logChat({
      time: Date.now(), roomId: room?.id ?? null, roomName: room ? room.settings.name : ZONE_LOG_ROOM_NAME, channel,
      team: NO_TEAM, playerId: user.playerId, name: user.name, accountId: user.account?.accountId ?? null,
      address: user.address, original: attempted, shown: '', action: 'block', hits: [reason],
    });
    if (severe) this.strike(user, 'name');
  }

  /** Is a human-chosen name (callsign or room name) allowed? A refusal is logged (and a strike when severe). */
  private nameAllowed(user: ZoneUser | null, name: string, channel: 'name' | 'room', room: Room | null): boolean {
    const chk = this.checkNameSafe(name);
    if (chk.ok) return true;
    if (user) this.nameRefused(user, name, chk.reason, chk.severe, channel, room);
    return false;
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
