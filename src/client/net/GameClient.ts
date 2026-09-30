// Session state + netcode: interpolation of remote entities, prediction of the own ship, RenderFrame building.
import type { IGameRenderer, RenderFrame } from '../contracts';
import { CHAT_HISTORY, DT, MAP_SIZE, NAME_MAX_LEN, SNAPSHOT_EVERY_ONLINE, TICK_RATE } from '../../shared/constants';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { WS_CLOSE_KICKED } from '../../shared/net/closeCodes';
import { isGameType, isSubMode } from '../../shared/data/gameTypes';
import {
  DEFAULT_ROOM_SETTINGS,
  type AccountInfo, type ChatLine, type ClientMsg, type JoinIntent, type LootGrant, type MatchResult, type PlayerInfo,
  type PlayerScore, type Profile, type RoomPhase, type RoomSettings, type RoomSummary, type ServerMsg,
} from '../../shared/protocol';
import type { ProfileStore } from '../../shared/profile/store';
import { COSMETIC_SLOTS } from '../../shared/data/cosmetics';
import { applyRoomSeals } from '../../shared/sim/floorgen';
import { buildMatchMap, type MatchMapParams } from '../../shared/sim/mapgen';
import { stepShipMovement } from '../../shared/sim/movement';
import { capitalScale, turretOffset } from '../../shared/sim/world';
import {
  GLOBAL_EVENT_TYPES, SHIPFLAG_CARRIER,
  type CosmeticId, type CosmeticSlot, type EntityId, type GameMap, type GameMode, type GameType, type InputState,
  type PlayerId, type RiftView, type ShipClassId, type ShipStats, type ShipView, type Snapshot, type SubMode, type YouState,
} from '../../shared/types';
import { DeviceProfile } from '../profile/deviceProfile';
import { LocalProfileStore } from '../profile/LocalProfileStore';
import { asDeviceGrant, lookFor, sameLook, wonMatch } from '../ui/lootInfo';
import { GAME_VERSION, PROTOCOL_VERSION } from '../../shared/version';
import { hostRadii } from './attach';
import { EventQueue } from './eventQueue';
import {
  findBracket, insertSnapshot, interpDeployables, interpEnemies, interpGems, interpLoot, interpProjectiles, interpShips,
  RenderClock,
} from './interp';
import { LocalTransport } from './LocalTransport';
import { moveSkillsFor, predictRechargeMult, predictSpeedMult, predictStats, Predictor, type PredictCtx } from './prediction';
import { PING_INTERVAL_MS, SILENCE_MS, SILENT_CLOSE_REASON, SilenceWatch } from './silence';
import type { Transport } from './transport';
import { UpgradePickGuard } from './upgradePick';
import { WsTransport } from './WsTransport';

/** matchStart → the buildMatchMap params both hosts use (teamCount 0 = FFA; floor 0 outside dungeons). */
export function matchMapParams(m: Pick<Extract<ServerMsg, { type: 'matchStart' }>, 'mapSeed' | 'mode' | 'teamCount' | 'gameType' | 'subMode' | 'floor'>): MatchMapParams {
  const gameType: GameType = isGameType(m.gameType) ? m.gameType : 'warzone';
  const subMode: SubMode = isSubMode(m.subMode) ? m.subMode : gameType === 'dungeon' ? 'coop' : 'deathmatch';
  return {
    seed: m.mapSeed,
    gameType,
    subMode,
    teamCount: m.mode === 'ffa' ? 0 : m.teamCount,
    floor: gameType !== 'dungeon' ? 0 : Number.isInteger(m.floor) && m.floor > 0 ? m.floor : 1,
  };
}

/** Rift events tied to one floor's layout (room index / position / boss): dropped from the queue at a floor swap. */
const FLOOR_BOUND_EVENTS: ReadonlySet<string> = new Set([
  'roomSeal', 'roomClear', 'roomReset', 'chestOpen', 'bossIntro', 'bossPhase', 'portalOpen', 'departing', 'floorStart',
]);

/**
 * Rift: the ship the camera follows while you are out of lives (or extracted, while the server still sends your
 * YouState): RiftYou.followId, when that ship is shown and alive. undefined = normal camera.
 */
export function riftFollowTarget(you: YouState | null | undefined, ships: ReadonlyMap<EntityId, ShipView>): ShipView | undefined {
  const r = you?.rift;
  if (!r || !(r.waiting || r.extracted) || !r.followId || you?.alive) return undefined;
  const t = ships.get(r.followId);
  return t && t.alive ? t : undefined;
}

/** Highest rift floor a `floorStart` / snapshot may name (v0.3 runs are 3 or 6 floors; v0.4 adds 9). */
export const MAX_RIFT_FLOOR = 64;

/** `dropInRoom` after a Dungeon Quick Play, until its roomState says where it landed. */
const QUICK_DROP_IN = '\u0000quick';

/** A connect attempt was replaced by a newer one (or by disconnect()) before it finished. Not an error to show. */
export class ConnectSuperseded extends Error {
  constructor() { super('Connection attempt superseded'); this.name = 'ConnectSuperseded'; }
}

export interface ClientEvents {
  /** Anything lobby-visible changed (roomState, roomList, welcome, connection). */
  change: void;
  chat: ChatLine;
  /** The chat log was replaced (history or context switch). */
  chatReset: void;
  matchStart: void;
  matchEnd: MatchResult;
  scores: void;
  error: string;
  /** The connection closed unexpectedly (reason). See `closeKicked` for why. */
  close: string;
  pong: number;
  /** v0.3: `profile` changed (server message, or a device-profile op for online guests). */
  profile: void;
  /** v0.3: a loot grant arrived (after matchEnd, or on leaving with secured caches). */
  lootGrant: { grant: LootGrant; persisted: boolean };
  /** v0.3 rift: the run moved to this floor (map rebuilt, netcode reset). */
  floorStart: number;
}

/** Where `GameClient.profile` comes from. */
export type ProfileSource = 'server' | 'device';

/** seenItems / equip wire limits (validate.ts): ids ≤ 40 chars, ≤ 64 per message. */
const ITEM_ID_MAX = 40;
const SEEN_MAX = 64;

type Listener<T> = (v: T) => void;

export class GameClient {
  transport: Transport | null = null;
  connected = false;
  offline = false;
  welcomed = false;

  playerId: PlayerId = 0;
  name = '';
  motd = '';
  serverVersion = '';
  /** Logged-in account (online, token accepted), else null = guest / offline. */
  account: AccountInfo | null = null;
  /**
   * The last unexpected close was the server ending this session on purpose (ws close code
   * WS_CLOSE_KICKED: session revoked, logged in elsewhere...): the 'close' reason is its message.
   */
  closeKicked = false;
  /** The WebSocket close code of the last unexpected close (undefined when unknown / in-page). See net/reconnect.ts. */
  closeCode: number | undefined = undefined;
  /**
   * Ping cadence, and how long an online host may stay silent after a ping before the connection is dropped as lost
   * (net/silence.ts; LAN edition §3.7). Read at connect time; tests shorten them.
   */
  pingIntervalMs = PING_INTERVAL_MS;
  silenceMs = SILENCE_MS;

  roomId: string | null = null;
  phase: RoomPhase = 'lobby';
  settings: RoomSettings = { ...DEFAULT_ROOM_SETTINGS };
  playerList: PlayerInfo[] = [];
  players = new Map<PlayerId, PlayerInfo>();
  hostPlayerId: PlayerId = 0;
  countdown = 0;
  rooms: RoomSummary[] = [];
  /** v0.3: connected pilots zone-wide (roomList.online). */
  online = 0;
  /** performance.now() when `rooms` arrived: Command counts its timers down from here. */
  roomsAt = 0;

  // --- v0.3 profile / loot ---
  /**
   * The profile the Hangar and Command show. Accounts and offline: the server's (`profile` messages; offline
   * shows the device profile until the in-page Zone's arrives). Online guests: the device profile.
   */
  profile: Profile | null = null;
  profileSource: ProfileSource | null = null;
  /** The server said this profile is saved (false: a session-only account profile, or a device profile). */
  profilePersisted = false;
  /** The latest lootGrant (the results Debrief). Cleared at matchStart and on a new session. */
  lastGrant: LootGrant | null = null;
  /** performance.now() when `lastGrant` arrived (Debrief reveal timing). */
  lastGrantAt = 0;
  /** The device profile store (offline Zone + online guests), shared with LocalTransport. */
  readonly deviceStore: ProfileStore;
  private device: DeviceProfile;

  /** Chat log for the current context (zone lobby or current room). */
  chat: ChatLine[] = [];
  private zoneChat: ChatLine[] = [];

  scores = new Map<PlayerId, PlayerScore>();
  pingMs = 0;

  // --- match ---
  matchActive = false;
  map: GameMap | null = null;
  mode: GameMode = 'teams';
  teamCount = 2;
  /** v0.3 (matchStart): the running match's game type / sub-mode, and the dungeon floor (0 otherwise). */
  gameType: GameType = 'warzone';
  subMode: SubMode = 'deathmatch';
  floor = 0;
  /** The buildMatchMap params of the current (or last) match map; null before the first match. */
  mapParams: MatchMapParams | null = null;
  yourShipId: EntityId = 0;
  snapshotEvery = SNAPSHOT_EVERY_ONLINE;
  lastResult: MatchResult | null = null;
  latest: Snapshot | null = null;
  /** Last built frame (ships used for aim / attach targeting). */
  lastFrame: RenderFrame | null = null;
  /** Ship the spectator camera follows (0 = none). Mirrored to the server (NET-1) via syncSpectate(). */
  spectateId: EntityId = 0;
  /** Spectate target last sent to the server ({type:'spectate'}); 0 = server default. */
  private sentSpectateId: EntityId = 0;

  private buffer: Snapshot[] = [];
  private clock = new RenderClock(SNAPSHOT_EVERY_ONLINE, 6, 15);
  private predictor = new Predictor(stepShipMovement, DT);
  /** v0.5 own stats with the capital hull radius (ownStats), per snapshot stats object. */
  private ownStatsMemo: { src: ShipStats; cls: ShipClassId; n: number; out: ShipStats } | null = null;
  /** CTF: tick the own ShipView first showed SHIPFLAG_CARRIER this carry (-1 = not carrying); see trackCarry. */
  private carrySinceTick = -1;
  private events = new EventQueue();
  private picks = new UpgradePickGuard();
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by every connect and disconnect: an older attempt that resumes sees it changed and bails. */
  private connectAttempt = 0;
  /** Rejects the in-flight attempt's wait for `welcome` (so a superseded attempt settles at once). */
  private abortConnect: ((e: Error) => void) | null = null;
  private listeners: { [K in keyof ClientEvents]?: Set<Listener<ClientEvents[K]>> } = {};
  private snapErrors = 0;
  /** The current match's matchStart arrived while roomId was still null (see the roomState handler). */
  private matchBeforeRoom = false;
  // --- v0.3 rift ---
  /** The running match's map seed (rift: identifies the run across the spectator matchStart after extracting). */
  private mapSeed = -1;
  /** Snapshots older than the current floor's start tick belong to the previous floor (dropped). */
  private floorTick = 0;
  /** Room states last mirrored into the map with applyRoomSeals ('' = none yet on this floor). */
  private sealKey = '';
  private sealErrors = 0;
  /** The room this pilot asked to join at the next floor start (QUICK_DROP_IN: a Dungeon Quick Play in flight). */
  private dropInRoom: string | null = null;
  /** mapSeed of the run this pilot extracted from (-1 = none). */
  private extractedSeed = -1;

  constructor(private renderer: IGameRenderer | null, deviceStore?: ProfileStore) {
    this.deviceStore = deviceStore ?? new LocalProfileStore();
    this.device = new DeviceProfile(this.deviceStore);
  }

  // ------------------------------------------------------------------ events
  on<K extends keyof ClientEvents>(ev: K, fn: Listener<ClientEvents[K]>): () => void {
    let set = this.listeners[ev] as Set<Listener<ClientEvents[K]>> | undefined;
    if (!set) { set = new Set(); (this.listeners as Record<string, unknown>)[ev] = set; }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit<K extends keyof ClientEvents>(ev: K, v: ClientEvents[K]): void {
    const set = this.listeners[ev] as Set<Listener<ClientEvents[K]>> | undefined;
    if (!set) return;
    for (const fn of set) {
      try { fn(v); } catch (e) { console.error(`[voidswarm] listener ${ev} failed`, e); }
    }
  }

  // ------------------------------------------------------------------ connection
  /** `token` = session token from the accounts API (omit to play as a guest). */
  async connectOnline(url: string, name: string, token?: string): Promise<void> {
    await this.connectTransport(new WsTransport(url), name, token);
  }

  async connectOffline(name: string): Promise<void> {
    await this.connectTransport(new LocalTransport({ profiles: this.deviceStore }), name);
  }

  /**
   * Connect over `t` and wait for `welcome`. Starting another connect (or calling disconnect()) while
   * this one is in flight makes this one reject with ConnectSuperseded, without touching the newer
   * connection or installing a second ping timer.
   */
  async connectTransport(t: Transport, name: string, token?: string): Promise<void> {
    this.disconnect(true); // also supersedes any attempt still in flight
    const attempt = ++this.connectAttempt;
    const current = () => attempt === this.connectAttempt && this.transport === t;
    this.resetSession();
    this.offline = t.kind === 'offline';
    this.closeKicked = false;
    this.closeCode = undefined;
    // A silent online host (asleep, unplugged) never sends a close: anything it sends proves it is still there.
    const watch = t.kind === 'online' ? new SilenceWatch(this.silenceMs, this.pingIntervalMs) : null;
    t.onMessage = (m) => { watch?.received(); this.handleMsg(m); };
    t.onSnapshot = (s) => { watch?.received(); this.handleSnapshot(s); };
    t.onClose = (reason, code) => this.handleClose(reason, code);
    this.transport = t;
    try {
      await t.connect();
    } catch (e) {
      if (!current()) throw new ConnectSuperseded();
      throw e;
    }
    if (!current()) throw new ConnectSuperseded();
    this.connected = true;
    this.name = name.slice(0, NAME_MAX_LEN);
    const hello: ClientMsg = { type: 'hello', name: this.name, protocol: PROTOCOL_VERSION, version: GAME_VERSION };
    if (token && t.kind === 'online') hello.token = token;
    t.send(hello);
    // Resolve once the server welcomes us (or time out / close / get superseded).
    await new Promise<void>((resolve, reject) => {
      if (this.welcomed) { resolve(); return; }
      const done = () => { clearTimeout(timer); off(); offClose(); if (this.abortConnect === abort) this.abortConnect = null; };
      const abort = (e: Error) => { done(); reject(e); };
      const timer = setTimeout(() => abort(new Error('Server did not respond to hello')), 8000);
      const off = this.on('change', () => { if (this.welcomed && current()) { done(); resolve(); } });
      const offClose = this.on('close', (r) => abort(new Error(r)));
      this.abortConnect = abort;
    });
    if (!current()) throw new ConnectSuperseded();
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ping = () => {
      if (watch?.tick(performance.now())) { this.dropSilent(t); return; }
      this.send({ type: 'ping', t: performance.now() });
    };
    this.pingTimer = setInterval(ping, this.pingIntervalMs);
    ping();
  }

  /** Close the connection. `silent` = no 'close' event. Supersedes a connect still in flight. */
  disconnect(silent = false): void {
    this.connectAttempt++;
    const abort = this.abortConnect;
    this.abortConnect = null;
    abort?.(new ConnectSuperseded());
    const t = this.transport;
    this.transport = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (t) {
      t.onMessage = t.onSnapshot = null;
      t.onClose = null;
      try { t.close(); } catch { /* ignore */ }
    }
    const was = this.connected;
    this.connected = false;
    this.welcomed = false;
    this.endMatch();
    if (was && !silent) this.emit('close', 'Disconnected');
    this.emit('change', undefined);
  }

  /**
   * The online host stopped answering (SilenceWatch): drop the connection and report it like an unexpected close with
   * no code (net/reconnect.ts classifies it 'lost', so main.ts shows the host-lost text and retries for 60 s).
   */
  private dropSilent(t: Transport): void {
    if (this.transport !== t) return;
    t.onMessage = t.onSnapshot = null;
    t.onClose = null;
    try { t.close(); } catch { /* ignore */ }
    this.handleClose(SILENT_CLOSE_REASON);
  }

  private handleClose(reason: string, code?: number): void {
    this.closeKicked = code === WS_CLOSE_KICKED;
    this.closeCode = code;
    this.connectAttempt++;
    this.transport = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.connected = false;
    this.welcomed = false;
    this.endMatch();
    this.emit('close', reason);
    this.emit('change', undefined);
  }

  private resetSession(): void {
    this.playerId = 0;
    this.account = null;
    this.roomId = null;
    this.phase = 'lobby';
    this.playerList = [];
    this.players = new Map();
    this.rooms = [];
    this.online = 0;
    this.roomsAt = 0;
    this.chat = [];
    this.zoneChat = this.chat;
    this.scores.clear();
    this.lastResult = null;
    this.profile = null;
    this.profileSource = null;
    this.profilePersisted = false;
    this.lastGrant = null;
    this.lastGrantAt = 0;
    this.dropInRoom = null;
    this.extractedSeed = -1;
    this.endMatch();
  }

  send(msg: ClientMsg): void {
    this.transport?.send(msg);
  }

  // ------------------------------------------------------------------ convenience senders
  sendChat(channel: 'all' | 'team', text: string): void {
    text = text.trim();
    if (!text) return;
    if (text.startsWith('//')) { channel = 'team'; text = text.slice(2).trim(); if (!text) return; }
    this.send({ type: 'chat', channel, text });
  }

  /** v0.3 Command: join the best room of a type (or have one made). The server auto-readies / drops you in. */
  quickPlay(gameType: GameType, subMode?: SubMode): void {
    // A Dungeon Quick Play may land in a running run: that one takes you at its next floor start.
    if (gameType === 'dungeon') this.dropInRoom = QUICK_DROP_IN;
    this.send(subMode ? { type: 'quickPlay', gameType, subMode } : { type: 'quickPlay', gameType });
  }

  /**
   * Join a room from the Command list. `intent` 'play' drops into a running match, 'watch' spectates it. A running
   * Dungeon Run takes a 'play' joiner at its next floor start (spectating until then: `riftDropInPending`).
   */
  joinRoom(roomId: string, intent?: JoinIntent): void {
    const r = this.rooms.find((x) => x.id === roomId);
    if (intent === 'play' && r && r.gameType === 'dungeon' && r.phase === 'playing') this.dropInRoom = roomId;
    this.send(intent ? { type: 'joinRoom', roomId, intent } : { type: 'joinRoom', roomId });
  }

  /** Room lobby "Join · next floor": this pilot asked to join the running rift (it takes them at the next floor). */
  noteRiftDropIn(): void {
    if (this.roomId && this.settings.gameType === 'dungeon' && this.phase === 'playing') this.dropInRoom = this.roomId;
  }

  /** v0.3 rift: waiting (spectating) to join the running run at its next floor start. */
  get riftDropInPending(): boolean {
    const id = this.dropInRoom;
    return id !== null && id === this.roomId && this.phase === 'playing' && this.settings.gameType === 'dungeon'
      && !this.me?.inMatch;
  }

  /** v0.3 rift: this pilot extracted from the running run (it now watches the party; its caches are banked). */
  /** mapSeed of the current match (-1 = none): a rift re-sends matchStart with the same seed within one run. */
  get matchSeed(): number { return this.matchActive ? this.mapSeed : -1; }

  get riftExtracted(): boolean {
    return this.matchActive && this.gameType === 'dungeon' && this.extractedSeed >= 0 && this.extractedSeed === this.mapSeed;
  }

  // ------------------------------------------------------------------ v0.3 profile (Hangar)
  /** Online guest: loot, equips and NEW badges live in the device profile (the server keeps none for guests). */
  get deviceProfileMode(): boolean { return this.connected && !this.offline && !this.account; }

  /** Offline or guest: the Hangar reads "DEVICE PROFILE: items stay on this device". */
  get onDevice(): boolean { return this.offline || !this.account; }

  /** The device profile lives in memory only (browser storage blocked / full): loot is lost on reload. */
  get deviceVolatile(): boolean {
    const s = this.deviceStore as Partial<LocalProfileStore>;
    return this.onDevice && s.persistent === false && !this.deviceReadOnly;
  }

  /**
   * The device profile is from a newer version of the game (its blob or the profile itself has v > 1): it is read
   * but never written, so this session's loot is not saved. Known from connect time (the first device load).
   */
  get deviceReadOnly(): boolean {
    if (!this.onDevice) return false;
    const s = this.deviceStore as Partial<LocalProfileStore>;
    if (s.readOnly === true) return true;
    // Offline, the in-page Zone owns the store: it reports persisted:false only for a read-only (v > 1) profile.
    if (this.offline && this.profileSource === 'server') return !this.profilePersisted;
    return !!this.device.profile && this.device.writable === false;
  }

  /**
   * Hangar equip (itemId '' = starter; shipClass is required for hull / weapon / turret). Online guests apply
   * it to the device profile and patch their own look; everyone else asks the server, which answers with a
   * `profile` and a roomState carrying the new cosmetics. Returns false when it was refused locally.
   */
  equip(slot: CosmeticSlot, itemId: CosmeticId, shipClass?: ShipClassId): boolean {
    if (!COSMETIC_SLOTS.includes(slot) || typeof itemId !== 'string' || itemId.length > ITEM_ID_MAX) return false;
    const classSlot = slot === 'hull' || slot === 'weapon' || slot === 'turret';
    if (classSlot && !shipClass) return false;
    if (this.deviceProfileMode) {
      const r = this.device.equip(slot, itemId, classSlot ? shipClass : undefined, Date.now());
      if (!r.ok) { this.emit('error', r.error); return false; }
      this.setDeviceProfile(r.profile);
      return true;
    }
    if (!this.transport) return false;
    this.send(classSlot ? { type: 'equip', slot, itemId, shipClass } : { type: 'equip', slot, itemId });
    return true;
  }

  /** Clear NEW badges (≤ 64 ids per message; empty / oversized ids are dropped). */
  seenItems(ids: readonly CosmeticId[]): void {
    const clean = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= ITEM_ID_MAX))];
    if (!clean.length) return;
    if (this.deviceProfileMode) {
      const p = this.device.markSeen(clean, Date.now());
      if (p) this.setDeviceProfile(p);
      return;
    }
    for (let i = 0; i < clean.length; i += SEEN_MAX) this.send({ type: 'seenItems', ids: clean.slice(i, i + SEEN_MAX) });
  }

  /** Online guests (and offline until the Zone's `profile` arrives): show the device profile. */
  private loadDeviceProfile(): void {
    const p = this.device.load(Date.now());
    if (p) this.setDeviceProfile(p, false);
  }

  private setDeviceProfile(p: Profile, notify = true): void {
    this.profile = p;
    this.profileSource = 'device';
    this.profilePersisted = false;
    this.patchSelfCosmetics();
    if (notify) {
      this.emit('profile', undefined);
      this.emit('change', undefined);
    }
  }

  /**
   * §7.3 step 7: the server sends no cosmetics for an online guest, so the guest sees their own look by
   * patching their PlayerInfo from the device profile (others see starters). A new `players` Map identity
   * makes the renderer rebuild its looks.
   */
  private patchSelfCosmetics(): void {
    if (!this.deviceProfileMode || !this.profile) return;
    const me = this.players.get(this.playerId);
    if (!me) return;
    const look = lookFor(this.profile, me.shipClass);
    if (me.cosmetics && sameLook(me.cosmetics, look)) return;
    const patched: PlayerInfo = { ...me, cosmetics: look };
    this.playerList = this.playerList.map((p) => (p.playerId === me.playerId ? patched : p));
    this.players = new Map(this.playerList.map((p) => [p.playerId, p]));
  }

  private handleGrant(grant: LootGrant, persisted: boolean): void {
    if (!grant || typeof grant !== 'object' || !Array.isArray(grant.items)) return;
    // An online guest's grant was rolled against an empty profile: items this device already owns are duplicates
    // (→ shards) when applied, so the Debrief shows them that way (a replayed grantKey is left as it was).
    if (!persisted && this.deviceProfileMode) {
      const s = this.deviceStore as Partial<LocalProfileStore>;
      if (!s.hasGrant?.(grant.grantKey)) grant = asDeviceGrant(grant, this.device.load(Date.now()));
    }
    this.lastGrant = grant;
    this.lastGrantAt = performance.now();
    // persisted:false = "apply to the device profile" for guests (and offline, if the Zone's store did not take
    // it; the device ledger drops a grantKey it already recorded). For an account it means the server's store
    // failed: never mix that into the device profile.
    if (!persisted && !this.account) {
      const won = wonMatch(this.lastResult, this.playerId, this.me?.team, this.mode === 'ffa');
      const r = this.device.applyGrant(grant, Date.now(), won);
      if (r !== 'failed' && this.device.profile && (this.deviceProfileMode || this.profileSource !== 'server')) {
        this.setDeviceProfile(this.device.profile, false);
        this.emit('profile', undefined);
      }
    }
    this.emit('lootGrant', { grant, persisted });
    this.emit('change', undefined);
  }

  get me(): PlayerInfo | undefined { return this.players.get(this.playerId); }
  get isHost(): boolean {
    if (this.hostPlayerId === this.playerId) return true;
    const host = this.players.get(this.hostPlayerId);
    return !host || host.isBot; // no human host: anyone may start
  }

  /** Append a client-side system line (errors, notices). */
  localSystem(text: string): void {
    this.pushChat({ fromPlayerId: 0, fromName: '', channel: 'system', team: -1, text, time: Date.now() });
  }

  private pushChat(line: ChatLine): void {
    this.chat.push(line);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.emit('chat', line);
  }

  // ------------------------------------------------------------------ messages
  private handleMsg(m: ServerMsg): void {
    switch (m.type) {
      case 'welcome':
        this.playerId = m.playerId;
        this.name = m.name;
        this.motd = m.motd;
        this.serverVersion = m.serverVersion;
        this.account = m.account ?? null;
        this.welcomed = true;
        // v0.3: online guests keep a device profile; offline shows it until the Zone's `profile` arrives.
        if (!this.account && this.profileSource !== 'server') this.loadDeviceProfile();
        this.emit('change', undefined);
        break;
      case 'roomList':
        // v0.3: offline no longer auto-joins a room; it lands on Command like online.
        this.rooms = m.rooms;
        this.online = typeof m.online === 'number' && m.online >= 0 ? m.online : 0;
        this.roomsAt = performance.now();
        this.emit('change', undefined);
        break;
      case 'roomState': {
        const prevRoom = this.roomId;
        const prevPhase = this.phase;
        this.roomId = m.roomId;
        this.phase = m.phase;
        this.settings = m.settings;
        this.playerList = m.players;
        this.players = new Map(m.players.map((p) => [p.playerId, p]));
        this.hostPlayerId = m.hostPlayerId;
        this.countdown = m.countdown;
        if (prevRoom !== m.roomId) {
          // Defensive (v0.3 M1): a server that applies a join intent before sending the joiner its roomState
          // delivers matchStart while we are still in the zone lobby. That match belongs to the room we are
          // now entering, so keep it instead of dropping it (the player would be stuck on the room screen).
          const keepMatch = this.matchBeforeRoom && prevRoom === null && m.roomId !== null && this.matchActive;
          if (!keepMatch) this.endMatch();
          this.matchBeforeRoom = false;
          this.lastResult = null;
          this.scores.clear();
          if (m.roomId === null) this.chat = this.zoneChat;
          else this.chat = [];
          this.emit('chatReset', undefined);
        } else if (m.phase === 'lobby' && prevPhase !== 'lobby') {
          this.endMatch();
          this.lastResult = null;
        }
        // v0.3 rift drop-in: a Dungeon Quick Play that landed in a running run waits for its next floor; any other
        // room, or the run ending, cancels the wait. An extraction belongs to its run only.
        if (this.dropInRoom === QUICK_DROP_IN) {
          if (m.roomId !== null) this.dropInRoom = m.phase === 'playing' && m.settings?.gameType === 'dungeon' ? m.roomId : null;
        } else if (this.dropInRoom !== null && (m.roomId !== this.dropInRoom || m.phase !== 'playing')) {
          this.dropInRoom = null;
        }
        if (m.phase !== 'playing' || prevRoom !== m.roomId) this.extractedSeed = -1;
        this.matchBeforeRoom = false;
        this.patchSelfCosmetics();
        this.emit('change', undefined);
        break;
      }
      case 'chat':
        this.pushChat(m.line);
        break;
      case 'chatHistory':
        this.chat.length = 0;
        this.chat.push(...m.lines.slice(-CHAT_HISTORY));
        this.emit('chatReset', undefined);
        break;
      case 'matchStart':
        this.startMatch(m);
        break;
      case 'floorStart':
        this.enterFloor(m.floor, m.tick);
        break;
      case 'matchEnd':
        this.lastResult = m.result;
        for (const s of m.result.scores) this.scores.set(s.playerId, s);
        this.emit('matchEnd', m.result);
        this.emit('change', undefined);
        break;
      case 'scores':
        this.scores = new Map(m.scores.map((s) => [s.playerId, s]));
        this.emit('scores', undefined);
        break;
      case 'pong':
        this.pingMs = Math.max(0, Math.round(performance.now() - m.t));
        this.emit('pong', this.pingMs);
        break;
      case 'error':
        this.emit('error', m.message);
        break;
      case 'profile':
        // Never sent to online guests (their device profile is theirs); accepted from accounts and offline.
        if (!this.offline && !this.account) break;
        if (!m.profile || typeof m.profile !== 'object') break;
        this.profile = m.profile;
        this.profileSource = 'server';
        this.profilePersisted = m.persisted === true;
        this.emit('profile', undefined);
        this.emit('change', undefined);
        break;
      case 'lootGrant':
        this.handleGrant(m.grant, m.persisted === true);
        break;
    }
  }

  private startMatch(m: Extract<ServerMsg, { type: 'matchStart' }>): void {
    this.endMatch();
    this.matchBeforeRoom = this.roomId === null;
    // A rift re-sends matchStart (a drop-in added at a floor start, an extracted pilot turned spectator): same run,
    // same seed. A new seed is a new match.
    if (m.mapSeed !== this.mapSeed) this.extractedSeed = -1;
    this.mapSeed = m.mapSeed;
    this.mode = m.mode;
    this.teamCount = m.teamCount;
    this.gameType = isGameType(m.gameType) ? m.gameType : 'warzone';
    this.subMode = isSubMode(m.subMode) ? m.subMode : this.gameType === 'dungeon' ? 'coop' : 'deathmatch';
    this.yourShipId = m.yourShipId;
    this.snapshotEvery = Math.max(1, m.snapshotEvery || 1);
    this.lastResult = null;
    this.lastGrant = null;
    this.lastGrantAt = 0;
    if (this.offline) this.clock.configure(this.snapshotEvery, 1.5, 4);
    else this.clock.configure(this.snapshotEvery, 6, 15);
    // Maps are never sent: rebuild it exactly like the server did (sim/mapgen.ts is the only entry point).
    this.mapParams = matchMapParams(m);
    this.floor = this.mapParams.floor;
    try {
      this.map = buildMatchMap(this.mapParams);
      this.renderer?.setMap(this.map);
    } catch (e) {
      console.error('[voidswarm] map generation / setMap failed', e);
      this.map = null;
    }
    this.matchActive = true;
    this.picks.reset();
    this.emit('matchStart', undefined);
    this.emit('change', undefined);
  }

  private endMatch(): void {
    // Leaving spectate: the server's per-viewer target goes back to its default (a new matchStart resets
    // it server-side too; this covers every other way out).
    if (this.sentSpectateId) { this.sentSpectateId = 0; this.send({ type: 'spectate', shipId: 0 }); }
    this.matchActive = false;
    this.matchBeforeRoom = false;
    this.buffer.length = 0;
    this.events.clear();
    this.picks.reset();
    this.latest = null;
    this.lastFrame = null;
    this.clock.reset();
    this.predictor.reset();
    this.carrySinceTick = -1;
    this.spectateId = 0;
    this.floorTick = 0;
    this.sealKey = '';
  }

  /**
   * v0.3 rift floor swap (`floorStart`: sent before any snapshot of the new floor; same match, ship ids unchanged).
   * The map is rebuilt for the new floor exactly as the server built it (buildMatchMap, floor = `floor`) and handed to
   * the renderer (setMap is re-entrant); netcode starts afresh: interpolation buffer, render clock, latest snapshot,
   * pending inputs + predictor, carry clock and seal mirror. Queued old-floor events keep only their global ones.
   * A repeated / older floor is ignored. Returns true when the floor changed.
   */
  private enterFloor(floor: number, tick: number): boolean {
    if (!this.matchActive || this.gameType !== 'dungeon' || !this.mapParams) return false;
    if (!Number.isInteger(floor) || floor < 1 || floor > MAX_RIFT_FLOOR) return false;
    if (floor < this.floor || (floor === this.floor && this.map)) return false;
    this.floor = floor;
    this.mapParams = { ...this.mapParams, floor };
    this.floorTick = Number.isFinite(tick) && tick > 0 ? tick : 0;
    try {
      this.map = buildMatchMap(this.mapParams);
      this.renderer?.setMap(this.map);
    } catch (e) {
      console.error('[voidswarm] floor map generation / setMap failed', e);
      this.map = null;
    }
    this.buffer.length = 0;
    this.latest = null;
    this.lastFrame = null;
    this.clock.reset();
    this.predictor.reset();
    this.carrySinceTick = -1;
    this.sealKey = '';
    // Only globals that mean the same on any floor survive (kill feed, level-ups, lives, extractions…): the old
    // floor's room / chest / portal / boss events index and position the OLD layout, and released on the new map
    // they would play a phantom chest burst or clear bang in a same-numbered room.
    this.events.retain((e) => GLOBAL_EVENT_TYPES.has(e.t) && !FLOOR_BOUND_EVENTS.has(e.t));
    this.emit('floorStart', floor);
    this.emit('change', undefined);
    return true;
  }

  /**
   * Rift: a snapshot from before the current floor started belongs to the old map (dropped). One already on a later
   * floor means its floorStart never arrived: swap first (self-heal), then take it.
   */
  private acceptFloorSnapshot(s: Snapshot): boolean {
    if (s.tick < this.floorTick) return false;
    const f = s.match?.dungeon?.floor;
    if (typeof f !== 'number' || f === this.floor) return true;
    if (f < this.floor) return false;
    this.enterFloor(f, s.tick);
    return true;
  }

  /**
   * Rift doors: mirror the server's room states into the local map with applyRoomSeals (pure + idempotent, the only
   * runtime tile mutation, bumps map.rev), so prediction collides with sealed doors like the server. Floor-checked:
   * a view of another floor (or for another layout) never touches this map.
   */
  private mirrorSeals(view: RiftView | undefined): void {
    const map = this.map;
    const layout = map?.dungeon;
    if (!view || !map || !layout || !Array.isArray(view.rooms)) return;
    if (view.floor !== this.floor || layout.floor !== view.floor || view.rooms.length !== layout.rooms.length) return;
    const key = view.rooms.join(',');
    if (key === this.sealKey) return;
    this.sealKey = key;
    try {
      applyRoomSeals(map, view.rooms);
    } catch (e) {
      if (this.sealErrors++ < 3) console.error('[voidswarm] applyRoomSeals failed', e);
    }
  }

  /** Rift bookkeeping from the latest snapshot: a ship ends a drop-in wait; your own extraction is remembered. */
  private noteRift(s: Snapshot): void {
    const you = s.you;
    if (you && this.dropInRoom !== QUICK_DROP_IN) this.dropInRoom = null;
    if (you?.rift?.extracted) { this.extractedSeed = this.mapSeed; return; }
    for (const e of s.events) {
      if (e.t === 'extract' && e.playerId === this.playerId) { this.extractedSeed = this.mapSeed; return; }
    }
  }

  // ------------------------------------------------------------------ snapshots & prediction
  private handleSnapshot(s: Snapshot): void {
    if (!this.matchActive) return;
    try {
      if (this.gameType === 'dungeon' && !this.acceptFloorSnapshot(s)) return;
      const now = performance.now();
      insertSnapshot(this.buffer, s);
      this.clock.onSnapshot(s.tick, now);
      this.events.push(s.tick, now, s.events);
      if (!this.latest || s.tick > this.latest.tick) {
        this.latest = s;
        if (this.gameType === 'dungeon') {
          this.noteRift(s);
          // Before the replay: this snapshot's sealed doors are walls for the predicted ship too.
          this.mirrorSeals(s.match?.dungeon);
        }
        this.reconcile(s);
      }
    } catch (e) {
      if (this.snapErrors++ < 3) console.error('[voidswarm] snapshot handling failed', e);
    }
  }

  private reconcile(s: Snapshot): void {
    const you = s.you;
    this.trackCarry(s, you ? s.ships.find((v) => v.id === you.shipId) : undefined);
    if (!you || !you.alive || you.attachedTo !== 0 || !this.map) { this.predictor.suspend(); return; }
    const view = s.ships.find((v) => v.id === you.shipId);
    if (!view || !view.alive) { this.predictor.suspend(); return; }
    // A rift seal recall / doorway nudge teleports the ship (a `blink` on it that is not the Blink skill): snap.
    const teleported = this.gameType === 'dungeon' && s.events.some((e) => e.t === 'blink' && e.shipId === you.shipId);
    this.predictor.reconcile(view, s.ackSeq, this.predictCtx(you, view, this.map), teleported);
  }

  /**
   * Own stats for prediction and own-host turret placement: v0.5 capital hull radius while hosting (predictStats).
   * Memoized per snapshot stats object, so the 60 Hz input tick doesn't copy stats.
   */
  private ownStats(you: YouState, view: ShipView | undefined): ShipStats {
    const cls: ShipClassId = view?.shipClass ?? this.me?.shipClass ?? 'brute';
    const n = you.attachedTo ? 0 : you.turrets.length;
    const m = this.ownStatsMemo;
    if (m && m.src === you.stats && m.n === n && m.cls === cls) return m.out;
    const out = predictStats(you, cls);
    this.ownStatsMemo = { src: you.stats, cls, n, out };
    return out;
  }

  /** Everything the predictor needs from a snapshot: stats, map, energy, host / carrier slow-down, movement skills. */
  private predictCtx(you: YouState, view: ShipView | undefined, map: GameMap): PredictCtx {
    const tick = this.latest?.tick ?? 0;
    return {
      stats: this.ownStats(you, view), map, energy: you.energy,
      speedMult: predictSpeedMult(you.turrets.length, view?.flags ?? 0),
      rechargeMult: predictRechargeMult(this.carrySinceTick >= 0 ? (tick - this.carrySinceTick) / TICK_RATE : -1),
      skills: moveSkillsFor(you, view),
    };
  }

  /** CTF: the tick the own ShipView first showed SHIPFLAG_CARRIER (Flag Overload clock for prediction), -1 = not. */
  private trackCarry(s: Snapshot, view: ShipView | undefined): void {
    if (view && view.alive && (view.flags & SHIPFLAG_CARRIER)) { if (this.carrySinceTick < 0) this.carrySinceTick = s.tick; }
    else this.carrySinceTick = -1;
  }

  /** Fixed-rate input tick: stamp, send, and predict. */
  sendInput(partial: Omit<InputState, 'seq'>): void {
    if (!this.matchActive || !this.transport) return;
    const input: InputState = { ...partial, seq: ++this.seq };
    this.transport.send({ type: 'input', input });
    const latest = this.latest;
    const you = latest?.you;
    const ctx = latest && you && you.alive && you.attachedTo === 0 && this.map
      ? this.predictCtx(you, latest.ships.find((v) => v.id === you.shipId), this.map) : null;
    this.predictor.applyLocal(input, ctx);
  }

  /**
   * Pick level-up card `index` of the offer on screen. Sends at most one pick per offer (echoing its
   * offerId) until a snapshot shows the next offer. Returns true when a pick was sent.
   */
  chooseUpgrade(index: number, nowMs = performance.now()): boolean {
    if (!this.matchActive) return false;
    const msg = this.picks.pick(this.latest?.you, index, nowMs);
    if (!msg) return false;
    this.send(msg);
    return true;
  }

  /** Card already picked from the offer currently on screen (awaiting the next snapshot), else -1. */
  get pickedUpgrade(): number { return this.picks.pickedFor(this.latest?.you); }

  get localShipId(): EntityId { return this.ownShipIdFor(this.latest?.you); }

  /**
   * The ship this client flies, from a snapshot's `you`. A rift snapshot without `you` means spectating (an extracted
   * pilot, a drop-in waiting for the next floor): the extracted wreck that stays in world.ships for the scoreboard is
   * not "own", so the spectate camera follows (and cycles) the party instead of sitting on the exit.
   */
  private ownShipIdFor(you: YouState | null | undefined): EntityId {
    if (you) return you.shipId;
    return this.gameType === 'dungeon' ? 0 : this.yourShipId;
  }

  /** Pose of the local ship (predicted when possible) from the last frame, for aiming. */
  localPose(): { x: number; y: number; angle: number } | null {
    const f = this.lastFrame;
    if (!f || !f.localShipId) return null;
    const s = f.ships.find((v) => v.id === f.localShipId);
    return s ? { x: s.x, y: s.y, angle: s.angle } : null;
  }

  /** Spectating: cycle through alive ships (the server's interest follows the new target). */
  cycleSpectate(): void {
    const ships = (this.lastFrame?.ships ?? []).filter((s) => s.alive && s.attachedTo === 0);
    if (!ships.length) { this.syncSpectate(0); return; }
    const i = ships.findIndex((s) => s.id === this.spectateId);
    this.syncSpectate(ships[(i + 1) % ships.length].id);
  }

  /**
   * NET-1: set the spectate target and tell the server whenever it changes (manual cycling, automatic
   * fallback, or 0 when leaving spectate), so snapshot interest is centred where this camera looks.
   */
  private syncSpectate(id: EntityId): void {
    this.spectateId = id;
    if (id === this.sentSpectateId || !this.matchActive) return;
    this.sentSpectateId = id;
    this.send({ type: 'spectate', shipId: id });
  }

  buildFrame(nowMs: number, timeSec: number, dt: number, aimX: number, aimY: number, attachCandidateId: EntityId): RenderFrame | null {
    if (!this.matchActive || !this.latest) return null;
    const rt = this.clock.update(nowMs, dt);
    this.predictor.decay(dt);
    const br = findBracket(this.buffer, rt);
    if (!br) return null;

    const ships = interpShips(br);
    const enemies = interpEnemies(br);
    const projectiles = interpProjectiles(br, rt);
    const gems = interpGems(br);
    const deployables = interpDeployables(br);
    const loot = interpLoot(br);
    const you = this.latest.you;
    const localShipId = this.ownShipIdFor(you);

    const byId = new Map<EntityId, ShipView>();
    for (const s of ships) byId.set(s.id, s);

    // Own ship: use the predicted body (latest server truth + replayed inputs).
    const own = byId.get(localShipId);
    if (this.predictor.body && you && you.alive && you.attachedTo === 0) {
      const v = this.predictor.visual();
      if (own) {
        own.x = v.x; own.y = v.y; own.vx = v.vx; own.vy = v.vy; own.angle = v.angle;
        own.alive = true; own.attachedTo = 0;
      } else {
        const latestOwn = this.latest.ships.find((s) => s.id === localShipId);
        if (latestOwn) {
          const c: ShipView = { ...latestOwn, x: v.x, y: v.y, vx: v.vx, vy: v.vy, angle: v.angle };
          ships.push(c);
          byId.set(c.id, c);
        }
      }
    }

    // Turrets ride their (interpolated or predicted) host's hardpoints, at the host's real radius (talents and the v0.5
    // capital scale included): read off the server's placement, else the class hull × capitalScale(turrets).
    const radii = hostRadii(br.b.ships);
    for (const s of ships) {
      if (!s.attachedTo) continue;
      const host = byId.get(s.attachedTo);
      if (!host) continue;
      const r = host.id === localShipId && you
        ? this.ownStats(you, host).radius
        : radii.get(host.id) ?? (SHIP_CLASSES[host.shipClass]?.base.radius ?? 16) * capitalScale(Math.max(1, s.turretCount));
      const off = turretOffset(host.angle, Math.max(0, s.turretSlot), Math.max(1, s.turretCount), r);
      s.x = host.x + off.dx;
      s.y = host.y + off.dy;
      s.vx = host.vx;
      s.vy = host.vy;
    }

    // Events: each delivered once, released as the render clock reaches their tick (stale ones dropped).
    const events = this.events.drain(rt, nowMs);

    // Drop old snapshots (keep a couple behind the render tick).
    while (this.buffer.length > 2 && this.buffer[1].tick < rt - 2) this.buffer.shift();

    // Camera focus.
    let focusX = (this.map?.width ?? MAP_SIZE) / 2, focusY = (this.map?.height ?? MAP_SIZE) / 2;
    const ownNow = byId.get(localShipId);
    const follow = riftFollowTarget(you, byId);
    if (follow) {
      // Rift: out of lives (or extracted) — the camera rides the party member the server names (RiftYou.followId).
      focusX = follow.x; focusY = follow.y;
      if (this.spectateId || this.sentSpectateId) this.syncSpectate(0);
    } else if (ownNow && localShipId) {
      focusX = ownNow.x; focusY = ownNow.y;
      if (this.spectateId || this.sentSpectateId) this.syncSpectate(0); // back in a ship: stop spectating
    } else {
      let target = this.spectateId ? byId.get(this.spectateId) : undefined;
      if (!target || !target.alive) target = ships.find((s) => s.alive && s.attachedTo === 0);
      this.syncSpectate(target?.id ?? 0); // incl. the automatic fallback when the target died / left
      if (target) { focusX = target.x; focusY = target.y; }
    }

    const frame: RenderFrame = {
      time: timeSec, dt, renderTick: rt,
      localPlayerId: this.playerId,
      localShipId: ownNow ? localShipId : 0,
      focusX, focusY, ships, enemies, projectiles, gems, deployables, events,
      you, match: this.latest.match,
      players: this.players,
      aimX, aimY, attachCandidateId,
      // v0.3: caches interpolate like gems; carriers come from the displayed snapshot (pips + beacons).
      loot,
      carry: br.b.carry ?? [],
    };
    this.lastFrame = frame;
    return frame;
  }

  /** Diagnostics for the HUD. */
  netStats(): { delayMs: number; jitterMs: number; pending: number } {
    return {
      delayMs: Math.round((this.clock.delayTicks() * 1000) / TICK_RATE),
      jitterMs: Math.round(this.clock.jitterMs),
      pending: this.predictor.pendingCount,
    };
  }
}
