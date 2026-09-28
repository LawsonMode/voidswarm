// OWNER: ROOM agent. One arena: players (humans + bots), teams, chat, bots, phases, one Sim per match.
import {
  BOTS_ONLY_ABORT_SEC, CHAT_HISTORY, CHAT_MAX_LEN, COUNTDOWN_SEC, LOOT_BEACON_COUNT, LOOT_BEACON_RARITY, NO_TEAM,
  RESPAWN_SEC, RESULTS_SEC, RIFT_FLOOR_OPTIONS, SPECTATOR_SLOTS, TICK_RATE,
} from '../constants';
import { COSMETICS } from '../data/cosmetics';
import {
  GAME_TYPES, SUB_MODES, firstReadySubMode, isGameType, isObjectiveSubMode, isSubMode, objectiveTarget, readySubModes,
  subModeLabel,
} from '../data/gameTypes';
import { LOOT_MULT_SOLO, RARITY_NAMES, SET_INFO } from '../data/loot';
import { SHIP_CLASSES, SHIP_CLASS_IDS } from '../data/ships';
import { TEAM_NAMES, teamName } from '../data/teams';
import { resolveLoadout } from '../profile/profile';
import { baseShards, botWardrobe, crateCount, crateEligible, type CrateContext, type GrantInput } from '../profile/rolls';
import {
  TEAM_UNASSIGNED,
  type ChatLine, type ClientMsg, type JoinIntent, type MatchResult, type PlayerInfo, type PlayerScore, type RoomLive,
  type RoomPhase, type RoomSettings, type RoomSummary, type ServerMsg,
} from '../protocol';
import { createBotBrain, type BotBrain } from '../ai/bots';
import { Sim } from '../sim/Sim';
import { gameTypeOf, subModeOf } from '../sim/world';
import {
  GLOBAL_EVENT_TYPES,
  type CacheToken, type CosmeticLoadout, type GameEvent, type GameType, type LootSet, type PlayerId, type Rarity, type Ship,
  type ShipClassId, type SubMode, type TeamId, type World,
} from '../types';
import {
  ObjectiveAnnouncer, buildObjectiveResult, objStatsOf, objectiveAwards, objectiveModeOf, objectivePlayerPoints,
  objectiveTeamPoints, objectiveWinner,
} from './objective';
import {
  RIFT_CLASS_QUEUED_MSG, RIFT_EXTRACTED_MSG, RIFT_FINAL_FLOOR_MSG, RIFT_PARTY_FULL_MSG, RiftAnnouncer, buildRiftResult,
  extractLine, floorLine, riftAwards, riftBotClass, riftOutcomeOf, riftResultLine, riftWinner, type RiftLeaver,
} from './rift';
import { SnapshotBuilder } from './snapshot';
import { allowChat, type LootGrantEntry, type LootGrantOutcome, type RoomHost, type ZoneUser } from './user';
import {
  BOT_CALLSIGNS, clampSettings, dedupeName, isShipClass, leastUsedClass, nameKey, parseGameType, parseSubMode,
  sanitizeInput, sanitizeText,
} from './util';

/** Server-only: a room with >=1 ready human auto-starts after this long in the lobby. */
export const AUTO_START_SEC = 20;
/**
 * v0.3 bots-only abort (§3.6): a countdown / running match with no humans in the room (spectators count as
 * humans) for this long goes back to its lobby silently — no results. (v0.2 name kept for its tests.)
 */
export const EMPTY_MATCH_END_SEC = BOTS_ONLY_ABORT_SEC;
/** Dead ship (Arena / Warzone): the new class waits for the respawn. A Dungeon Run uses RIFT_CLASS_QUEUED_MSG. */
export const CLASS_QUEUED_MSG = 'Class change queued — applies when you respawn.';
/** Online Watch refusal (fix #2): no ghosting your own match from a second connection. */
export const WATCH_SAME_NETWORK_MSG = "Can't watch a room you're playing in from the same network.";
/** Online playing-room cap reached (MAX_PLAYING_ROOMS): the start waits for a free slot. */
export const START_WAIT_MSG = 'All arenas are busy — launching as soon as one frees up.';
export const NO_SEAT_MSG = 'No free pilot seat — the room is full. You can keep watching.';
/** Short sub-mode label for chat / lists ("CTF", "DM", Warzone deathmatch = "Classic"). */
export function subModeShort(t: GameType, s: SubMode): string {
  return t === 'warzone' && s === 'deathmatch' ? 'Classic' : SUB_MODES[s].short;
}
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** Minimum spacing of "notable" match system messages. */
const NOTE_GAP_TICKS = 3 * TICK_RATE;
/** Consecutive tick errors before a match is aborted. */
const MAX_TICK_ERRORS = 60;
/**
 * SEC-2: while a match runs, a pilot may go to spectate (or hop teams without a ship) at most once per
 * this long. Leaving spectate is always accepted; the new ship then waits out the rejoin delay.
 */
export const TEAM_CHANGE_GAP_SEC = 3;
const TEAM_CHANGE_GAP_TICKS = TEAM_CHANGE_GAP_SEC * TICK_RATE;
/** Leaving the running match (spectate / leave room) counts as a death for respawn purposes. */
const REJOIN_DELAY_TICKS = RESPAWN_SEC * TICK_RATE;
/** Private line shown to a pilot waiting out the rejoin delay. */
export const rejoinMsg = (waitTicks: number): string =>
  `Rejoining in ${Math.max(1, Math.ceil(waitTicks / TICK_RATE))}s — spectating until then.`;
/** Minimum spacing of loot chat lines (epic+ drops, big spills): rare, but a boss wave must not flood chat. */
const LOOT_NOTE_GAP_TICKS = TICK_RATE;
/** "An Epic Swarm Cache" / "A Legendary Salvage Cache". */
export function cacheLabel(rarity: Rarity, set: LootSet): string {
  const r = RARITY_NAMES[rarity] ?? 'Unknown';
  return `${/^[AEIOU]/.test(r) ? 'An' : 'A'} ${r} ${SET_INFO[set]?.cacheName ?? 'Cache'}`;
}
/** Same look? (CosmeticLoadout objects are small: slot -> id.) */
function sameLook(a: CosmeticLoadout | undefined, b: CosmeticLoadout | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a) as (keyof CosmeticLoadout)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export interface RoomPlayer {
  playerId: PlayerId;
  name: string;
  /** Wire team: real team, NO_TEAM (FFA) or TEAM_UNASSIGNED. */
  team: TeamId;
  shipClass: ShipClassId;
  isBot: boolean;
  ready: boolean;
  /** Explicitly spectating (vs. merely not having picked a team yet). */
  spectating: boolean;
  user: ZoneUser | null;
  brain: BotBrain | null;
  seed: number;
  /** Has a ship in the running match. */
  inMatch: boolean;
  /** Received matchStart for the running match (gets snapshots). */
  watching: boolean;
  joinOrder: number;
  /**
   * Team switch requested while flying in the running match: applied at the ship's next respawn so a
   * switch can never be used as an instant full-energy, spawn-protected respawn. `team` stays the
   * current (sim) team until then — it routes team chat.
   */
  pendingTeam: TeamId | null;
  /**
   * SEC-2 "respawn not before": world tick before which this pilot can't get a new ship in the running
   * match (set when they leave it — spectate or leave the room — as if they had died then). 0 = none.
   * A pilot who asks back in earlier waits as a spectator until then (runRejoins).
   */
  rejoinTick: number;
  /** Room tick of this pilot's last capped team/spectate change in a running match (TEAM_CHANGE_GAP_SEC). */
  lastTeamChangeTick: number;
  // --- v0.3 (§8.8) ---
  /** World tick this pilot's ship entered the running match (loot crate gates, M2). */
  matchJoinTick: number;
  /** Dungeon: extracted this run (now a spectator; M4). */
  extracted: boolean;
  /** Dungeon: joined a running rift — spectates until the next floor start adds them (M4). */
  pendingDropIn: boolean;
  /** Dungeon: class swap queued to the next floor (M4). */
  pendingClass: ShipClassId | null;
  /**
   * Dungeon: the floor this pilot's current stint in the run began on (1 at the start, the floor of a drop-in);
   * 0 = not flying. Crate credit counts only floors cleared while flying (floorsCleared).
   */
  riftJoinFloor: number;
  /** Quick Play during results: ready again once the room is back in its lobby. */
  readyAfterResults: boolean;
  // --- v0.3 M2 loot ---
  /**
   * Server-resolved look for `shipClass` (PlayerInfo.cosmetics): resolveLoadout(profile) for humans with a profile
   * (accounts, offline), botWardrobe(seed, gameType, class) for bots; absent for online guests (self-patched locally).
   */
  cosmetics?: CosmeticLoadout;
  /**
   * Ticks flown in the running match in finished stints (a stint ends when the ship leaves the sim, e.g. going to
   * spectate); the current stint is world.tick − matchJoinTick. Crate / shard time gates (§6.6). Reset per match.
   */
  playedTicks: number;
}

interface PendingBotChat { at: number; pid: PlayerId; text: string; channel: 'all' | 'team' }

const CLASS_LIST = SHIP_CLASS_IDS.map((id) => `${id} (${SHIP_CLASSES[id].name})`).join(', ');
const HELP_LINES = [
  'Commands: /help  /name <callsign>  /team <1-8|auto|spec>  /class <class>  /ready  /leave',
  'Host: /type dungeon|arena|warzone  /sub <mode>  /mode ffa | /mode teams <n>  /floors 3|6  /target <n>',
  'Host: /bots <n>  /skill easy|normal|hard  /pve 1-3  /start  /end (in a Dungeon Run: abandon it)',
  `Classes: ${CLASS_LIST}.  Prefix a message with // for team chat.`,
];

/** Resolve a class by id, display name or archetype (e.g. 'brute', 'Juggernaut'). */
export function findClass(q: string): ShipClassId | undefined {
  const l = q.trim().toLowerCase();
  if (!l) return undefined;
  return SHIP_CLASS_IDS.find((id) => id === l || SHIP_CLASSES[id].name.toLowerCase() === l
    || SHIP_CLASSES[id].archetype.toLowerCase() === l);
}

const GREETINGS = ['o/ {n}', 'welcome, {n}!', 'hey {n}, grab a ship', 'fresh pilot! hi {n}', 'yo {n}'];
const GGS = ['gg', 'gg wp', 'ggs all', 'good games', 'gg, rematch?'];
const TEAM_BANTER = ['need a turret?', 'anyone want to ride along?', 'swarm incoming, stick together', 'on your wing'];

export class Room {
  readonly id: string;
  settings: RoomSettings;
  readonly userCreated: boolean;
  phase: RoomPhase = 'lobby';
  /** Ticks with no humans (for closing user-created rooms). */
  emptyTicks = 0;
  /** Zone bookkeeping: rate-limit address of the connection that created this room (null = built-in / unknown). */
  creatorAddress: string | null = null;
  /** Built-in rooms go back to these settings once they empty out (server mode). */
  private readonly baseSettings: RoomSettings;
  private customized = false;

  private host: RoomHost;
  private players: RoomPlayer[] = [];
  private hostPid: PlayerId = 0;
  private history: ChatLine[] = [];
  private dirty = true;
  private joinCounter = 0;
  private tickCount = 0;

  private countdownTicks = 0;
  private resultsTicks = 0;
  private autoStartTicks = 0;
  private lastCountdownSent = -1;
  /** A start was asked for while MAX_PLAYING_ROOMS were busy: re-checked every second (§3.6). */
  private pendingStart = false;
  /** botFill the running match started with (§3.2: a changed botFill applies at the next match); null = lobby. */
  private matchBotFill: number | null = null;
  /** RoomHost.newMatchId() of the running / last match (loot grant keys, M2). */
  matchId = '';

  sim: Sim | null = null;
  private mapSeed = 0;
  private snapCounter = 0;
  private scoreCounter = 0;
  private pendingEvents: GameEvent[] = [];
  private builder = new SnapshotBuilder();
  private turretTicks = new Map<PlayerId, number>();
  /** Turret-ticks hosted (sum over ticks of turrets carried). */
  private hostTicks = new Map<PlayerId, number>();
  private bountyClaimed = new Map<PlayerId, number>();
  private gemXp = new Map<PlayerId, number>();
  private lastNoteTick = -1e9;
  private botChats: PendingBotChat[] = [];
  private tickErrors = 0;
  /**
   * SEC-2: rejoin-not-before ticks of pilots who left the running match by leaving the room, keyed by
   * connection (`p:<playerId>`) and account (`a:<accountId>`), so leave + rejoin room + Join Match is no
   * faster than dying. Cleared with every match.
   */
  private rejoinAfter = new Map<string, number>();
  /**
   * v0.3 M4: connection (`p:<playerId>`) and account (`a:<accountId>`) keys of pilots who extracted from the running
   * rift. Extraction ends their run: a leave + rejoin comes back as a watcher (RoomPlayer.extracted), never as a
   * drop-in. Cleared with every match.
   */
  private riftExtractedKeys = new Set<string>();
  // --- v0.3 M2 loot (§7.3). All keyed by grant profile key (accountId | 'local' | `guest:${playerId}`), per match. ---
  /** Secured (extracted) caches waiting for this match's grant. */
  private bank = new Map<string, CacheToken[]>();
  /** Caches spilled (lost) this match: GrantInput.cachesLost. */
  private spills = new Map<string, number>();
  /** Grants already issued per key this match (join sequence in the grant key, fix #17). */
  private grantSeq = new Map<string, number>();
  /**
   * Leavers whose carried caches a leave grant already counted as lost: their very next lootSpill (the one
   * removePlayer emits) is skipped, so a same-connection rejoin before the next tick can't count them twice.
   * Cleared after every event pass.
   */
  private spillCounted = new Set<PlayerId>();
  /** The anti-farm multiplier last handed to the running Sim (§6.4.6). */
  private lootMult = 0;
  private lastLootNoteTick = -1e9;
  /** One log line per room when the profile layer can't resolve looks (pilots then show starters). */
  private lookErrorLogged = false;
  /** v0.3 M3: objective chat lines (flag / zone / hot point / overtime), rate-limited per match. */
  private objAnnouncer = new ObjectiveAnnouncer();
  // --- v0.3 M4 rift (§4.8) ---
  /** Rift event chat lines (the Matriarch, instability), once per boss / floor. */
  private riftAnnouncer = new RiftAnnouncer();
  /** Pilots who left the running rift (leave room / spectate): RiftResult status 'left'. Per match. */
  private riftLeavers = new Map<PlayerId, RiftLeaver>();
  /** chestOpen events per pilot this run (Treasure Hunter). */
  private riftChests = new Map<PlayerId, number>();
  /** A floor started this tick: the next snapshot goes out now, right after the floorStart message. */
  private forceSnapshot = false;

  constructor(id: string, settings: RoomSettings, host: RoomHost, userCreated: boolean) {
    this.id = id;
    this.settings = settings;
    this.baseSettings = { ...settings };
    this.host = host;
    this.userCreated = userCreated;
    this.syncBots();
  }

  /** Built-in room of the public server: its name and player cap are not the host's to change. */
  private get locked(): boolean { return !this.userCreated && !this.host.local; }

  // ------------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------------

  get humans(): RoomPlayer[] { return this.players.filter((p) => !p.isBot); }
  get humanCount(): number { let n = 0; for (const p of this.players) if (!p.isBot) n++; return n; }
  get botCount(): number { let n = 0; for (const p of this.players) if (p.isBot) n++; return n; }
  get allPlayers(): readonly RoomPlayer[] { return this.players; }
  get hostPlayerId(): PlayerId { return this.hostPid; }
  get world(): World | null { return this.sim ? this.sim.world : null; }

  /** Humans with a pilot seat (not spectating). */
  get activeHumanCount(): number { let n = 0; for (const p of this.players) if (!p.isBot && !p.spectating) n++; return n; }
  /**
   * v0.3 M4: pilot seats claimed — active humans plus rift drop-ins who wait (as spectators) for the next floor
   * start. Outside a running rift nobody is a pending drop-in, so this equals activeHumanCount.
   */
  private claimedSeats(except?: RoomPlayer): number {
    let n = 0;
    for (const p of this.players) if (p !== except && !p.isBot && (!p.spectating || p.pendingDropIn)) n++;
    return n;
  }
  /**
   * Humans syncBots fills around. In a running rift only the pilots actually in the run count: a drop-in takes a
   * bot's seat at the floor start that adds them (§3.5), never mid-floor. Elsewhere: every active human.
   */
  private get seatedHumanCount(): number {
    const rift = this.riftRunning;
    let n = 0;
    for (const p of this.players) if (!p.isBot && !p.spectating && (!rift || p.inMatch)) n++;
    return n;
  }
  /** A Dungeon Runner match is running (drop-ins wait for the next floor start). */
  private get riftRunning(): boolean {
    return this.phase === 'playing' && !!this.sim && GAME_TYPES[this.settings.gameType].dropIn === 'floorStart';
  }
  /**
   * §3.4 Quick Play: a running rift whose Descend portal is departing is skipped (RoomLive is frozen and carries no
   * portal state, so the Zone asks the room directly).
   */
  get riftDeparting(): boolean {
    return this.riftRunning && this.sim!.world.dungeon?.portal === 2;
  }
  /** Every human (pilots + spectators) fits in maxPlayers + SPECTATOR_SLOTS. */
  private get humanCap(): number { return this.settings.maxPlayers + SPECTATOR_SLOTS; }

  /** No free pilot seat (v0.2 API; v0.3 callers use canJoin). */
  isFull(): boolean { return !this.canJoin('lobby'); }

  /**
   * v0.3 (§3.5): may one more zone user join with `intent`? 'watch' needs a running match and a free
   * spectator slot; everything else needs a free pilot seat (claimed seats < maxPlayers: a rift drop-in waiting
   * for the next floor already holds one).
   */
  canJoin(intent: JoinIntent | 'quick'): boolean {
    if (this.humanCount >= this.humanCap) return false;
    if (intent === 'watch') return this.phase === 'playing' && !!this.sim;
    return this.claimedSeats() < this.settings.maxPlayers;
  }

  /** A user joining with `intent` enters as a spectator (Watch, or a drop-in that waits for the next rift floor). */
  joinsAsSpectator(intent: JoinIntent | 'quick'): boolean {
    if (intent === 'watch') return true;
    return (intent === 'play' || intent === 'quick') && this.phase === 'playing' && !!this.sim
      && GAME_TYPES[this.settings.gameType].dropIn === 'floorStart';
  }

  /**
   * Online (fix #2): why `user` may not spectate this room's match — another connection from the same network
   * address flies it (fliesInMatch) — or null. Offline / unknown address: never refused. The reverse order
   * (watch first, then a same-network pilot drops in) is handled by cutSameNetworkWatchers.
   */
  spectateRefusal(user: ZoneUser): string | null {
    if (this.host.local || !this.host.blockSameNetworkWatch || !user.address) return null;
    for (const p of this.players) {
      if (p.isBot || !p.user || p.user === user || !Room.fliesInMatch(p)) continue;
      if (p.user.address === user.address) return WATCH_SAME_NETWORK_MSG;
    }
    return null;
  }

  /**
   * fix #2: a human who counts as "playing" this room's match: has a ship in it, is waiting out a rejoin
   * delay, or is a rift pilot waiting for the next floor. Room members who merely sit in the room lobby while
   * the match runs (no ship, not watching) don't count, so a housemate may watch until they drop in.
   */
  private static fliesInMatch(p: RoomPlayer): boolean {
    return p.inMatch || p.pendingDropIn || (!p.spectating && p.watching);
  }

  /**
   * v0.3 Quick Play "stay here" check: `user` is in this room and holds a pilot seat, or can take one
   * (a spectator of a full room can't — Quick Play then looks for another room).
   */
  canHoldPilotSeat(user: ZoneUser): boolean {
    const p = this.player(user.playerId);
    if (!p) return false;
    return !p.spectating || p.pendingDropIn || this.claimedSeats(p) < this.settings.maxPlayers;
  }

  /** Users whose match feed was cut by cutSameNetworkWatchers; flush() sends them back to Command. */
  private evictions: ZoneUser[] = [];

  /**
   * fix #2, reverse order (online): `pilot` (a human) just got a ship in the running match, so watchers of
   * this match on the pilot's network lose the feed at once (no further snapshots) and go back to Command
   * on the next flush — watch-first-then-play must not get around the Watch refusal.
   */
  private cutSameNetworkWatchers(pilot: RoomPlayer): void {
    const addr = pilot.user?.address;
    if (this.host.local || !this.host.blockSameNetworkWatch || !addr) return;
    for (const q of this.players) {
      if (q === pilot || q.isBot || !q.user || !q.watching || q.inMatch || !q.spectating || q.pendingDropIn) continue;
      if (q.user.address !== addr) continue;
      q.watching = false;
      this.builder.resetSpectator(q.playerId);
      if (!this.evictions.includes(q.user)) this.evictions.push(q.user);
    }
  }

  /** An account pilot claimed the name with nameKey `key`: rename any bot currently using (a look-alike of) it. */
  renameBotsNamed(key: string): void {
    for (const p of this.players) {
      if (p.isBot && nameKey(p.name) === key) {
        p.name = this.host.uniqueName(p.name + '2', p.playerId);
        const w = this.world;
        const sid = w?.shipsByPlayer.get(p.playerId);
        const ship = sid ? w!.ships.get(sid) : undefined;
        if (ship) ship.name = p.name;
        this.dirty = true;
      }
    }
  }

  summary(): RoomSummary {
    const s = this.settings;
    let humans = 0, spectators = 0, bots = 0, waiting = 0;
    for (const p of this.players) {
      if (p.isBot) bots++;
      else { humans++; if (p.spectating) { spectators++; if (p.pendingDropIn) waiting++; } }
    }
    const host = this.hostPid ? this.player(this.hostPid) : undefined;
    const playing = this.phase === 'playing' && !!this.sim;
    return {
      id: this.id, name: s.name, mode: s.mode, teamCount: s.teamCount,
      phase: this.phase, humans, bots, maxPlayers: s.maxPlayers,
      gameType: s.gameType, subMode: s.subMode, pveIntensity: s.pveIntensity, floors: s.floors,
      house: !this.userCreated, hostName: host && !host.isBot ? host.name : '', spectators,
      // rift drop-ins waiting for the next floor already hold a seat (claimedSeats)
      joinable: humans - spectators + waiting < s.maxPlayers && humans < this.humanCap,
      watchable: humans < this.humanCap && playing,
      startsInSec: this.startsInSec(),
      live: playing ? this.liveInfo() : null,
    };
  }

  /** Seconds until launch: the lobby auto-start (+ its countdown) or the countdown itself; 0 = not scheduled. */
  private startsInSec(): number {
    if (this.phase === 'countdown') return Math.max(1, Math.ceil(this.countdownTicks / TICK_RATE));
    if (this.phase === 'lobby' && this.autoStartTicks > 0) {
      const left = Math.max(0, AUTO_START_SEC * TICK_RATE - this.autoStartTicks);
      return Math.ceil(left / TICK_RATE) + COUNTDOWN_SEC;
    }
    return 0;
  }

  /** RoomSummary.live of the running match. */
  private liveInfo(): RoomLive | null {
    const w = this.world;
    if (!w) return null;
    const m = w.match;
    const gt = gameTypeOf(w.config);
    const elapsedSec = Math.max(0, Math.floor((w.tick - m.startTick) / TICK_RATE));
    const timeLeftSec = m.endTick > 0 ? Math.max(0, Math.ceil((m.endTick - w.tick) / TICK_RATE)) : -1;
    const wave = gt === 'warzone' ? w.pve.wave : 0;
    let floor = 0, floorsTotal = 0, lives = -1;
    let scores: number[] = [], scoreline = '', leader = '', leaderScore = 0;
    const d = w.dungeon;
    if (d) {
      floor = d.floor; floorsTotal = d.floorsTotal;
      lives = d.parties.reduce((a, p) => a + Math.max(0, p.lives), 0);
      scoreline = `Floor ${floor}/${floorsTotal} · ${lives} ${lives === 1 ? 'life' : 'lives'}`;
    } else if (w.config.mode === 'teams') {
      // Objective sub-modes: their points / captures (never kills, fix #7); deathmatch: the team score sums.
      scores = (objectiveModeOf(w) ? objectiveTeamPoints(w) : m.teamScores).slice(0, 8).map((v) => Math.round(v));
      scoreline = scores.join('–');
    } else if (objectiveModeOf(w)) {
      // FFA hot point: the points leader (nobody until someone scores — ship score is not the objective).
      const pts = objectivePlayerPoints(w);
      if (pts.length) {
        leader = this.nameOf(pts[0][0]) ?? '';
        leaderScore = Math.round(pts[0][1]);
      }
      if (leader) scoreline = `${leader} ${leaderScore}`;
    } else {
      let top: Ship | null = null;
      for (const sh of w.ships.values()) if (!top || sh.score > top.score) top = sh;
      if (top) { leader = top.name; leaderScore = Math.round(top.score); }
      if (leader) scoreline = `${leader} ${leaderScore}`;
    }
    return { elapsedSec, timeLeftSec, wave, floor, floorsTotal, lives, scores, scoreline, leader, leaderScore };
  }

  /** One `/rooms` status fragment: "lobby", "starting in 0:14", "playing 6:40 left · 212–187", ... */
  statusLine(): string {
    const sm = this.summary();
    switch (sm.phase) {
      case 'lobby': return sm.startsInSec > 0 ? `starting in ${mmss(sm.startsInSec)}` : 'lobby';
      case 'countdown': return 'launching';
      case 'results': return 'wrapping up';
      case 'playing': {
        const L = sm.live;
        if (!L) return 'playing';
        if (L.floorsTotal > 0) return `playing ${L.scoreline}`;
        let t = L.timeLeftSec >= 0 ? `playing ${mmss(L.timeLeftSec)} left` : 'playing';
        if (L.scoreline) t += ` · ${L.scoreline}`;
        if (L.wave > 0) t += ` · wave ${L.wave}`;
        return t;
      }
    }
    return sm.phase;
  }

  private player(pid: PlayerId): RoomPlayer | undefined { return this.players.find((p) => p.playerId === pid); }

  /** A pilot's name: the room roster, else the ship in the running match (a leaver's ship is gone: null). */
  private nameOf(pid: PlayerId): string | null {
    const p = this.player(pid);
    if (p) return p.name;
    const w = this.world;
    const sid = w?.shipsByPlayer.get(pid);
    const s = sid ? w!.ships.get(sid) : undefined;
    return s ? s.name : null;
  }

  private info(p: RoomPlayer): PlayerInfo {
    const info: PlayerInfo = {
      playerId: p.playerId, name: p.name, team: p.team, shipClass: p.shipClass, isBot: p.isBot,
      isHost: p.playerId === this.hostPid, ready: p.isBot ? true : p.ready, ping: p.user ? p.user.ping : 0,
      inMatch: p.inMatch,
    };
    if (p.cosmetics) info.cosmetics = p.cosmetics; // sent once per roomState, never per snapshot (§6.1)
    return info;
  }

  // ------------------------------------------------------------------------------------------
  // v0.3 M2: cosmetics (looks)
  // ------------------------------------------------------------------------------------------

  /** The look `p` shows for its selected class, or undefined (online guest / profile layer unavailable). */
  private lookFor(p: RoomPlayer): CosmeticLoadout | undefined {
    try {
      if (p.isBot) return botWardrobe(p.seed, this.settings.gameType, p.shipClass);
      const prof = p.user?.profile;
      return prof ? resolveLoadout(prof, p.shipClass) : undefined;
    } catch (e) {
      if (!this.lookErrorLogged) {
        this.lookErrorLogged = true;
        this.host.log(`[${this.settings.name}] cosmetics unavailable: ${(e as Error)?.message ?? e}`);
      }
      return undefined;
    }
  }

  /** Recompute p's look; true (and a roomState is due) when it changed. */
  private refreshLook(p: RoomPlayer): boolean {
    const next = this.lookFor(p);
    if (sameLook(p.cosmetics, next)) return false;
    p.cosmetics = next;
    this.dirty = true;
    return true;
  }

  /**
   * §7.3.2: the pilot's profile changed (an equip in the Hangar): push a roomState with the new
   * PlayerInfo.cosmetics. Mid-match equips apply at once (looks travel in roomState, not in snapshots).
   */
  onProfileChanged(user: ZoneUser): void {
    const p = this.player(user.playerId);
    if (p && !p.isBot) this.refreshLook(p);
  }

  roomStateMsg(): ServerMsg {
    let countdown = 0;
    if (this.phase === 'countdown') countdown = Math.ceil(this.countdownTicks / TICK_RATE);
    else if (this.phase === 'results') countdown = Math.ceil(this.resultsTicks / TICK_RATE);
    return {
      type: 'roomState', roomId: this.id, phase: this.phase, settings: { ...this.settings },
      players: this.players.map((p) => this.info(p)), hostPlayerId: this.hostPid, countdown,
    };
  }

  markDirty(): void { this.dirty = true; }

  /** Send roomState to every human if anything changed. */
  flush(): void {
    if (this.evictions.length) {
      const list = this.evictions;
      this.evictions = [];
      for (const u of list) if (u.room === this) this.host.returnToLobby(u, WATCH_SAME_NETWORK_MSG);
    }
    if (!this.dirty) return;
    this.dirty = false;
    const msg = this.roomStateMsg();
    for (const p of this.players) if (p.user) p.user.sink.sendMsg(msg);
  }

  // ------------------------------------------------------------------------------------------
  // Membership
  // ------------------------------------------------------------------------------------------

  /**
   * Add a zone user. `asSpectator` (Watch, or a rift drop-in waiting for the next floor) takes a spectator
   * slot instead of a pilot seat. Returns false when there is no room (Zone checks canJoin first).
   */
  addUser(user: ZoneUser, asSpectator = false): boolean {
    if (this.humanCount >= this.humanCap) return false;
    if (!asSpectator && this.claimedSeats() >= this.settings.maxPlayers) return false;
    const p: RoomPlayer = {
      playerId: user.playerId, name: user.name,
      team: asSpectator || this.settings.mode !== 'ffa' ? TEAM_UNASSIGNED : NO_TEAM,
      shipClass: isShipClass(user.lastShipClass) ? user.lastShipClass : 'brute',
      isBot: false, ready: false, spectating: asSpectator, user, brain: null, seed: 0,
      inMatch: false, watching: false, joinOrder: this.joinCounter++, pendingTeam: null,
      rejoinTick: this.recalledRejoin(user), lastTeamChangeTick: -1e9,
      matchJoinTick: 0, extracted: false, pendingDropIn: false, pendingClass: null, readyAfterResults: false,
      playedTicks: 0, riftJoinFloor: 0,
    };
    p.cosmetics = this.lookFor(p);
    // A pilot who already extracted from this run (then left) only watches the rest of it.
    if (this.phase === 'playing' && this.sim && Room.rejoinKeys(user).some((k) => this.riftExtractedKeys.has(k))) p.extracted = true;
    this.players.push(p);
    user.room = this;
    if (!this.hostPid) this.hostPid = p.playerId;
    this.emptyTicks = 0;
    this.syncBots();
    this.rebalanceBots();
    // The joiner's first room message is its roomState, BEFORE the history, any tells and a matchStart (Zone
    // applies the join intent right after this): the client switches its context (room chat log, match state)
    // on a roomState for a new roomId, so anything that arrived ahead of it landed in the zone-lobby context
    // and a drop-in's matchStart was thrown away (Join / Watch / Quick Play into a live match).
    user.sink.sendMsg(this.roomStateMsg());
    user.sink.sendMsg({ type: 'chatHistory', lines: this.historyFor(p) });
    this.system(`${p.name} joined the room.`);
    this.maybeGreet(p);
    this.dirty = true;
    this.host.roomsChanged();
    this.host.log(`[${this.settings.name}] + ${p.name} (${this.humanCount} humans)`);
    return true;
  }

  removeUser(user: ZoneUser): void {
    const p = this.player(user.playerId);
    if (!p) return;
    if (this.phase === 'playing' && this.sim) {
      // Leaving mid-match counts as a death for respawn purposes (SEC-2), also across a room rejoin.
      const notBefore = Math.max(p.rejoinTick, p.inMatch ? this.rejoinNotBefore(p) : 0);
      if (notBefore > this.sim.world.tick) this.rememberRejoin(user, notBefore);
      // §7.3.6: the secured bank is granted BEFORE removePlayer spills the carried caches.
      this.grantOnLeave(p);
      this.noteRiftLeaver(p);
    }
    if (p.inMatch && this.sim) this.safeSim(() => this.sim!.removePlayer(p.playerId));
    this.builder.resetSpectator(p.playerId);
    this.players.splice(this.players.indexOf(p), 1);
    if (user.room === this) user.room = null;
    if (p.inMatch) this.updateLootMult(); // one human fewer in the match (§6.4.6)
    // (A rift seat freed mid-floor goes to a bot at once — syncBots below, §4.6; a pending drop-in replaces a bot
    // at the next floor start.)
    if (this.hostPid === p.playerId) {
      const next = this.humans.sort((a, b) => a.joinOrder - b.joinOrder)[0];
      this.hostPid = next ? next.playerId : 0;
      if (next) this.system(`${next.name} is now the host.`);
    }
    this.system(`${p.name} left the room.`);
    this.syncBots();
    this.rebalanceBots();
    if (this.humanCount === 0 && this.phase === 'countdown') this.phase = 'lobby';
    if (this.humanCount === 0) this.pendingStart = false;
    this.dirty = true;
    this.host.roomsChanged();
    this.host.log(`[${this.settings.name}] - ${p.name} (${this.humanCount} humans)`);
  }

  /** Remove everyone (room closing). */
  close(): void {
    for (const p of this.players) if (p.user && p.user.room === this) p.user.room = null;
    this.players = [];
    this.evictions = [];
    this.sim = null;
  }

  /**
   * v0.3 (§3.5): apply what a (just added, or already present) user asked for when joining.
   *  - watch: spectate; if the match runs, start receiving it (online: refused from the network of a pilot here).
   *  - play / quick while playing: Arena / Warzone drop in now (auto team, SEC-2 rejoin delay respected);
   *    Dungeon waits as a spectator for the next floor start (pendingDropIn, M4).
   *  - quick in lobby / countdown: ready up (the 20 s auto-start runs; offline the countdown starts at once).
   *  - lobby: v0.2 behaviour (nothing more).
   */
  onJoinIntent(user: ZoneUser, intent: JoinIntent | 'quick'): void {
    const p = this.player(user.playerId);
    if (!p || intent === 'lobby') return;
    const s = this.settings;
    const T = GAME_TYPES[s.gameType];
    const label = `${s.name} (${subModeShort(s.gameType, s.subMode)})`;
    const playing = this.phase === 'playing' && !!this.sim;
    const quick = intent === 'quick' ? 'Quick Play → ' : '';
    if (intent === 'watch') {
      if (!p.spectating) this.setTeam(p, TEAM_UNASSIGNED);
      if (!p.spectating) return; // refused (same network / rate cap): setTeam told them why
      if (p.pendingDropIn) { p.pendingDropIn = false; this.dirty = true; this.host.roomsChanged(); } // Watch = no rift drop-in
      if (playing) {
        const why = this.spectateRefusal(user);
        if (why) { this.tell(p, why); return; }
        this.joinMatch(p);
        this.tell(p, `Watching ${label}. Pick a team in the room to fly.`);
      }
      return;
    }
    // 'play' | 'quick'
    if (playing) {
      if (T.dropIn === 'floorStart') {
        // Rift (§3.5): watch now; the next floor start adds the ship (onFloorStart), replacing a bot if the party is full.
        if (p.inMatch) { this.tell(p, p.extracted ? RIFT_EXTRACTED_MSG : `${quick}${label}. You're already in the run.`); return; }
        // No floor start is coming (final floor), or no seat to claim: just watch (online: not from a pilot's network).
        const watchOnly = (line: string): void => {
          const why = p.spectating && p.user && !p.watching ? this.spectateRefusal(p.user) : null;
          if (why) { this.tell(p, why); return; }
          if (!p.watching) this.sendMatchStart(p);
          this.tell(p, line);
        };
        if (p.extracted) { p.pendingDropIn = false; watchOnly(RIFT_EXTRACTED_MSG); return; }
        const d = this.world?.dungeon;
        if (d && d.floor >= d.floorsTotal) { p.pendingDropIn = false; watchOnly(`${quick}${label}. ${RIFT_FINAL_FLOOR_MSG}`); return; }
        if (p.spectating && !p.pendingDropIn && this.claimedSeats(p) >= s.maxPlayers) { watchOnly(NO_SEAT_MSG); return; }
        p.pendingDropIn = true;
        this.dirty = true;
        if (!p.watching) this.sendMatchStart(p);
        this.tell(p, `${quick}${label}. You join the party at the next floor.`);
        this.host.roomsChanged();
        return;
      }
      if (p.spectating) {
        if (this.activeHumanCount >= s.maxPlayers) { this.tell(p, NO_SEAT_MSG); return; }
        p.spectating = false;
        p.team = s.mode === 'ffa' ? NO_TEAM : TEAM_UNASSIGNED;
        this.syncBots();
      }
      if (s.mode === 'ffa') p.team = NO_TEAM;
      else if (p.team < 0 || p.team >= s.teamCount) p.team = this.smallestTeam(p);
      this.dirty = true;
      if (quick) this.tell(p, `${quick}${label}. Dropping in${s.mode === 'teams' ? ` for ${teamName(p.team)}` : ''}.`);
      this.joinMatch(p);
      return;
    }
    if (intent !== 'quick') return; // 'play' outside a match = a plain lobby join
    if (this.phase === 'results') {
      p.readyAfterResults = true;
      this.tell(p, `${quick}${label}. You're in for the next match (after the results).`);
      return;
    }
    // lobby / countdown
    if (p.spectating) {
      if (this.activeHumanCount < s.maxPlayers) { p.spectating = false; p.team = s.mode === 'ffa' ? NO_TEAM : TEAM_UNASSIGNED; this.syncBots(); }
      else { this.tell(p, NO_SEAT_MSG); return; } // no seat: don't ready a spectator (the launch isn't theirs)
    }
    p.ready = true;
    this.dirty = true;
    if (this.phase === 'countdown') { this.tell(p, `${quick}${label}. Launching now.`); return; }
    if (this.host.local) {
      this.tell(p, `${quick}${label}. Launching now.`);
      this.startCountdown();
      return;
    }
    this.tell(p, `${quick}${label}. Auto-start in ${AUTO_START_SEC} s — un-ready to wait.`);
  }

  /** A human's name changed at the zone level. */
  onRenamed(user: ZoneUser): void {
    const p = this.player(user.playerId);
    if (!p) return;
    p.name = user.name;
    const w = this.world;
    if (w) {
      const sid = w.shipsByPlayer.get(p.playerId);
      const ship = sid ? w.ships.get(sid) : undefined;
      if (ship) ship.name = p.name;
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------------------------------------
  // Messages
  // ------------------------------------------------------------------------------------------

  handle(user: ZoneUser, msg: ClientMsg): void {
    const p = this.player(user.playerId);
    if (!p) return;
    switch (msg.type) {
      case 'chat': this.onChat(p, msg.channel, msg.text); break;
      case 'setTeam': this.setTeam(p, msg.team); break;
      case 'setShip': this.setShip(p, msg.shipClass); break;
      case 'ready':
        p.ready = msg.ready === true;
        this.dirty = true;
        break;
      case 'updateSettings':
        if (p.playerId !== this.hostPid) { this.tell(p, 'Only the host can change settings.'); break; }
        this.applySettings(msg.settings, p);
        break;
      case 'startMatch': this.requestStart(p); break;
      case 'joinMatch': this.joinMatch(p); break;
      case 'spectate': {
        // NET-1: the ship this spectator's camera follows, so interest (enemies, shots, gems...) follows
        // it too. 0 = server default. Pilots' interest follows their own ship (clearing is harmless).
        if (this.phase !== 'playing') break;
        const id = typeof msg.shipId === 'number' && Number.isInteger(msg.shipId) && msg.shipId > 0 ? msg.shipId : 0;
        if (id && p.inMatch && !p.extracted) break; // (an extracted rift pilot spectates the rest of the run)
        this.builder.setSpectateTarget(p.playerId, id);
        break;
      }
      case 'input':
        if (p.inMatch && !p.extracted && this.sim && this.phase === 'playing') {
          const inp = sanitizeInput(msg.input);
          this.safeSim(() => this.sim!.setInput(p.playerId, inp));
        }
        break;
      case 'chooseUpgrade':
        // offerId (YouState.offerId) is required from humans: a pick answering an older offer is ignored
        // by the sim, so a double-press can't spend the next queued offer.
        if (p.inMatch && this.sim && this.phase === 'playing' && typeof msg.index === 'number' && Number.isFinite(msg.index)
          && Number.isInteger(msg.offerId)) {
          const idx = Math.max(0, Math.min(9, Math.floor(msg.index)));
          const offerId = msg.offerId;
          this.safeSim(() => this.sim!.chooseUpgrade(p.playerId, idx, offerId));
        }
        break;
      default: break;
    }
  }

  private canHostAct(p: RoomPlayer): boolean {
    return p.playerId === this.hostPid || this.hostPid === 0;
  }

  private onChat(p: RoomPlayer, channel: unknown, rawText: unknown): void {
    let text = sanitizeText(rawText, CHAT_MAX_LEN);
    if (!text) return;
    if (!p.user || !allowChat(p.user, Date.now())) { this.tell(p, 'Slow down — chat is rate limited.'); return; }
    let ch: 'all' | 'team' = channel === 'team' ? 'team' : 'all';
    if (text.startsWith('//')) { ch = 'team'; text = text.slice(2).trim(); if (!text) return; }
    else if (text.startsWith('/')) { this.command(p, text); return; }
    this.pushChat({ fromPlayerId: p.playerId, fromName: p.name, channel: ch, team: p.team, text, time: Date.now() });
  }

  private command(p: RoomPlayer, text: string): void {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ');
    const a1 = (parts[1] || '').toLowerCase();
    const hostOnly = (): boolean => {
      if (this.canHostAct(p)) return true;
      this.tell(p, `/${cmd} is host-only.`);
      return false;
    };
    switch (cmd) {
      case 'help': case '?': for (const l of HELP_LINES) this.tell(p, l); break;
      case 'name':
        if (!arg) { this.tell(p, 'Usage: /name <callsign>'); break; }
        if (p.user) this.host.renameUser(p.user, arg);
        break;
      case 'team': {
        if (this.settings.mode === 'ffa' && a1 !== 'spec' && a1 !== 'spectate' && a1 !== 'auto') {
          this.setTeam(p, NO_TEAM); break;
        }
        if (a1 === 'spec' || a1 === 'spectate') { this.setTeam(p, TEAM_UNASSIGNED); break; }
        if (a1 === 'auto' || !a1) { this.setTeam(p, this.settings.mode === 'ffa' ? NO_TEAM : this.smallestTeam(p)); break; }
        let t = parseInt(a1, 10) - 1;
        if (!Number.isFinite(t)) t = TEAM_NAMES.findIndex((n) => n.toLowerCase() === a1);
        if (!(t >= 0 && t < this.settings.teamCount)) { this.tell(p, `Team must be 1-${this.settings.teamCount}, auto or spec.`); break; }
        this.setTeam(p, t);
        break;
      }
      case 'class': case 'ship': {
        const c = findClass(arg);
        if (!c) { this.tell(p, `Classes: ${CLASS_LIST}`); break; }
        this.setShip(p, c);
        this.tell(p, `Class: ${SHIP_CLASSES[c].name} (${SHIP_CLASSES[c].archetype}).`);
        break;
      }
      case 'ready': p.ready = !p.ready; this.dirty = true; this.tell(p, p.ready ? 'You are ready.' : 'You are not ready.'); break;
      case 'bots': {
        if (!hostOnly()) break;
        const n = parseInt(a1, 10);
        if (!Number.isFinite(n)) { this.tell(p, 'Usage: /bots <n>'); break; }
        this.applySettings({ botFill: n }, p);
        break;
      }
      case 'skill':
        if (!hostOnly()) break;
        if (a1 !== 'easy' && a1 !== 'normal' && a1 !== 'hard') { this.tell(p, 'Usage: /skill easy|normal|hard'); break; }
        this.applySettings({ botSkill: a1 }, p);
        break;
      case 'mode': {
        if (!hostOnly()) break;
        const s = this.settings;
        const D = SUB_MODES[s.subMode];
        if (a1 === 'ffa') {
          if (!D.ffa || s.gameType === 'dungeon') { this.tell(p, `${subModeLabel(s.gameType, s.subMode)} is teams only.`); break; }
          this.applySettings({ mode: 'ffa' }, p);
        } else if (a1 === 'teams') {
          const n = parseInt(parts[2] || '', 10);
          if (Number.isFinite(n) && (n < D.minTeams || n > D.maxTeams)) {
            this.tell(p, D.minTeams === D.maxTeams ? `${subModeLabel(s.gameType, s.subMode)} plays with ${D.minTeams} team${D.minTeams > 1 ? 's' : ''}.`
              : `${subModeLabel(s.gameType, s.subMode)} allows ${D.minTeams}-${D.maxTeams} teams.`);
            break;
          }
          this.applySettings(Number.isFinite(n) ? { mode: 'teams', teamCount: n } : { mode: 'teams' }, p);
        } else this.tell(p, 'Usage: /mode ffa | /mode teams <n>');
        break;
      }
      case 'pve': {
        if (!hostOnly()) break;
        const T = GAME_TYPES[this.settings.gameType];
        if (T.pve === 'off') { this.tell(p, `${T.name} has no swarm.`); break; }
        const n = parseInt(a1, 10);
        if (!(n >= 1 && n <= 3)) { this.tell(p, `Usage: /pve 1-3 (${T.pveLabels.slice(1).join(' / ')})`); break; }
        this.applySettings({ pveIntensity: n as RoomSettings['pveIntensity'] }, p);
        break;
      }
      case 'type': {
        if (!hostOnly()) break;
        const t = parseGameType(arg);
        if (!t) { this.tell(p, 'Usage: /type dungeon|arena|warzone'); break; }
        if (!firstReadySubMode(t)) { this.tell(p, `${GAME_TYPES[t].name} isn't open yet.`); break; }
        if (t === this.settings.gameType) { this.tell(p, `This room already plays ${GAME_TYPES[t].name}.`); break; }
        this.applySettings({ gameType: t }, p);
        break;
      }
      case 'sub': case 'submode': {
        if (!hostOnly()) break;
        const t = this.settings.gameType;
        const sub = parseSubMode(t, arg);
        const list = readySubModes(t).map((x) => subModeShort(t, x).toLowerCase()).join(', ');
        if (!sub) { this.tell(p, `Usage: /sub <mode> — ${GAME_TYPES[t].name}: ${list}`); break; }
        if (!SUB_MODES[sub].ready) { this.tell(p, `${subModeLabel(t, sub)} isn't open yet (${GAME_TYPES[t].name}: ${list}).`); break; }
        this.applySettings({ subMode: sub }, p);
        break;
      }
      case 'floors': {
        if (!hostOnly()) break;
        if (this.settings.gameType !== 'dungeon') { this.tell(p, 'Floors are a Dungeon Runner setting.'); break; }
        const n = parseInt(a1, 10);
        if (!RIFT_FLOOR_OPTIONS.includes(n)) { this.tell(p, `Usage: /floors ${RIFT_FLOOR_OPTIONS.join('|')}`); break; }
        this.applySettings({ floors: n }, p);
        break;
      }
      case 'target': {
        const s = this.settings;
        const D = SUB_MODES[s.subMode];
        if (!a1 && D.limitMax > 0) {
          // No argument: anyone may ask what the target is.
          const cur = objectiveTarget(s.subMode, s.mode, s.objectiveLimit);
          this.tell(p, `Target: ${cur} ${D.limitLabel}${s.objectiveLimit ? '' : ' (default)'}. Host: /target <${D.limitMin}-${D.limitMax}> (0 = default).`);
          break;
        }
        if (!hostOnly()) break;
        if (D.limitMax === 0) { this.tell(p, `${subModeLabel(s.gameType, s.subMode)} has no objective target — try /bots, /mode or /pve.`); break; }
        // whole numbers only: parseInt would quietly read '1e3' as 1, '2.9' as 2 and '5abc' as 5
        const n = /^\d{1,6}$/.test(a1) ? parseInt(a1, 10) : NaN;
        if (!Number.isFinite(n) || n < 0) { this.tell(p, `Usage: /target <${D.limitMin}-${D.limitMax} ${D.limitLabel}> (0 = default ${D.defaultLimit})`); break; }
        this.applySettings({ objectiveLimit: n }, p);
        break;
      }
      case 'start': this.requestStart(p); break;
      case 'end':
        if (!hostOnly()) break;
        if (this.phase === 'playing' && this.sim?.world.dungeon) {
          // §3.7 / §4.7: in a Dungeon Run, /end abandons the rift (outcome 'abandoned'): unsecured loot is lost.
          const sim = this.sim;
          this.system(`${p.name} abandoned the rift — unsecured loot is lost.`);
          this.safeSim(() => sim.abandonRift());
          this.enterResults();
        } else if (this.phase === 'playing') { this.system(`${p.name} ended the match.`); this.enterResults(); }
        else if (this.phase === 'countdown') { this.phase = 'lobby'; this.system('Countdown cancelled.'); this.dirty = true; this.host.roomsChanged(); }
        else if (this.pendingStart) { this.pendingStart = false; this.system('Launch cancelled.'); this.host.roomsChanged(); }
        else this.tell(p, 'No match is running.');
        break;
      case 'leave': break; // handled by Zone
      default: this.tell(p, `Unknown command /${cmd} — try /help`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Teams & ships
  // ------------------------------------------------------------------------------------------

  /** Team member counts (non-spectating players with a real team). */
  teamCounts(exceptPid: PlayerId = 0): number[] {
    const counts = new Array(this.settings.teamCount).fill(0);
    for (const p of this.players) {
      if (p.playerId === exceptPid || p.spectating) continue;
      if (p.team >= 0 && p.team < counts.length) counts[p.team]++;
    }
    return counts;
  }

  smallestTeam(except?: RoomPlayer): TeamId {
    const c = this.teamCounts(except ? except.playerId : 0);
    let best = 0;
    for (let i = 1; i < c.length; i++) if (c[i] < c[best]) best = i;
    return best;
  }

  private setTeam(p: RoomPlayer, raw: unknown): void {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
    const ffa = this.settings.mode === 'ffa';
    let team: TeamId;
    let spectating = false;
    if (raw === TEAM_UNASSIGNED) { team = TEAM_UNASSIGNED; spectating = true; }
    else if (ffa) team = NO_TEAM;
    else if (raw === NO_TEAM) return; // ignored in teams mode
    else if (raw >= 0 && raw < this.settings.teamCount) team = Math.floor(raw);
    else return;
    const playing = this.phase === 'playing' && !!this.sim;
    // v0.3 M4: an extracted pilot's run is over — their ship stays on the scoreboard until the results.
    if (playing && p.extracted) { this.tell(p, RIFT_EXTRACTED_MSG); return; }
    // Flying in the running match: a team switch respawns the ship (full energy + spawn protection), so
    // it waits for the ship's next respawn instead (SEC-2). Leaving to spectate stays immediate.
    if (!spectating && !ffa && p.inMatch && playing && this.shipOf(p)) {
      if (team === p.team) {
        if (p.pendingTeam !== null) { p.pendingTeam = null; this.tell(p, 'Team change cancelled.'); }
        return;
      }
      if (p.pendingTeam === team) return;
      p.pendingTeam = team;
      this.tell(p, `Team change to ${teamName(team)} queued — applies when you respawn.`);
      return;
    }
    if (p.team === team && p.spectating === spectating) {
      p.pendingTeam = null;
      if (spectating && p.pendingDropIn) {
        // a rift drop-in waiting as a spectator picked Spectate: they stay a watcher
        p.pendingDropIn = false;
        this.tell(p, "Drop-in cancelled — you're watching.");
        this.dirty = true;
        this.host.roomsChanged();
      }
      return;
    }
    const wasSpectating = p.spectating;
    // v0.3 seats: a spectator takes a pilot seat only if one is free (spectators ride on SPECTATOR_SLOTS).
    if (wasSpectating && !spectating && !p.pendingDropIn && this.claimedSeats(p) >= this.settings.maxPlayers) { this.tell(p, NO_SEAT_MSG); return; }
    // fix #2: no spectating a running match from the network of a pilot in it (online).
    if (spectating && !wasSpectating && playing && p.user) {
      const why = this.spectateRefusal(p.user);
      if (why) { this.tell(p, why); return; }
    }
    // SEC-2: in a running match, going to spectate (or hopping teams while shipless) is capped to one
    // change per TEAM_CHANGE_GAP_SEC. Leaving spectate is always accepted: the new ship then waits out
    // the rejoin delay (enterMatchOrWait), so spectate toggles can never beat the respawn timer.
    if (playing && !wasSpectating) {
      const since = this.tickCount - p.lastTeamChangeTick;
      if (since < TEAM_CHANGE_GAP_TICKS) {
        const left = Math.max(1, Math.ceil((TEAM_CHANGE_GAP_TICKS - since) / TICK_RATE));
        this.tell(p, `Slow down — one team change every ${TEAM_CHANGE_GAP_SEC} s (try again in ${left} s).`);
        return;
      }
      p.lastTeamChangeTick = this.tickCount;
    }
    p.pendingTeam = null;
    p.team = team;
    p.spectating = spectating;
    this.dirty = true;
    if (spectating) this.system(`${p.name} is now spectating.`);
    else if (!ffa) this.system(`${p.name} joined team ${teamName(team)}.`);
    else if (wasSpectating) this.system(`${p.name} stopped spectating.`);

    if (playing) {
      if (spectating && p.inMatch) {
        // Leaving the match counts as a death for respawn purposes (SEC-2): remember when they may be back.
        p.rejoinTick = Math.max(p.rejoinTick, this.rejoinNotBefore(p));
        this.endStint(p);
        this.noteRiftLeaver(p);
        this.safeSim(() => this.sim!.removePlayer(p.playerId)); // carried caches spill (lootSpill → cachesLost)
        p.inMatch = false;
        p.riftJoinFloor = 0;
        this.updateLootMult();
      } else if (!spectating && p.inMatch && !ffa) {
        this.safeSim(() => this.sim!.setPlayerTeam(p.playerId, team));
      } else if (!spectating && !p.inMatch && p.watching) {
        if (GAME_TYPES[this.settings.gameType].dropIn === 'floorStart') {
          // rift: the next floor start adds them (onFloorStart); none is coming on the final floor
          const d = this.world?.dungeon;
          if (d && d.floor >= d.floorsTotal) this.tell(p, RIFT_FINAL_FLOOR_MSG);
          else { p.pendingDropIn = true; this.tell(p, 'You join the party at the next floor.'); }
        } else this.enterMatchOrWait(p);
      }
    }
    if (spectating) p.pendingDropIn = false;
    if (wasSpectating !== spectating) this.syncBots();
    this.rebalanceBots();
    this.host.roomsChanged();
  }

  /**
   * `p.shipClass` is the pilot's selected class (also remembered zone-wide as `user.lastShipClass`).
   * v0.3 (§1.3.B #6): in a running Arena / Warzone match a LIVE ship swaps class in place (Sim.setShipClass
   * keeps position, velocity and energy fraction, grants no invulnerability), which can't be used as a free
   * respawn (SEC-2). A dead ship (and, in a Dungeon Run, every ship) keeps the choice queued:
   * applyQueuedChanges() swaps it in with the normal respawn, never earlier.
   */
  private setShip(p: RoomPlayer, raw: unknown): void {
    if (!isShipClass(raw)) return;
    if (p.user) p.user.lastShipClass = raw;
    if (p.shipClass === raw) return;
    p.shipClass = raw;
    this.refreshLook(p); // hull / weapon / turret follow the selected class
    this.dirty = true;
    // Dungeon lobby: the fill bots re-complement the party (§4.8) as pilots pick classes.
    if (this.phase === 'lobby' && !p.isBot && this.settings.gameType === 'dungeon') this.complementBotClasses();
    const ship = p.inMatch && this.phase === 'playing' ? this.shipOf(p) : undefined;
    if (!ship) return;
    if (ship.shipClass === raw) {
      p.pendingClass = null;
      this.tell(p, `Class change cancelled — you keep your ${SHIP_CLASSES[raw].name}.`);
      return;
    }
    if (this.settings.gameType === 'dungeon') {
      // §4.8: a class change during a run is queued to the next floor start (onFloorStart), dead or alive.
      if (p.extracted) return;
      p.pendingClass = raw;
      this.tell(p, RIFT_CLASS_QUEUED_MSG);
      return;
    }
    if (ship.alive && this.sim) {
      const sim = this.sim;
      this.safeSim(() => sim.setShipClass(p.playerId, raw));
      return;
    }
    this.tell(p, CLASS_QUEUED_MSG);
  }

  /**
   * §4.8 bot class complement (Dungeon Runner): each fill bot, in join order, takes an Artificer if the party has none,
   * otherwise the party's least-used class. Lobby / match start only; a bot that joins mid-run picks the same way.
   */
  private complementBotClasses(): void {
    const party: ShipClassId[] = [];
    for (const p of this.players) if (!p.isBot && !p.spectating) party.push(p.shipClass);
    for (const b of this.players) {
      if (!b.isBot) continue;
      const c = riftBotClass(party, Math.random, b.shipClass);
      party.push(c);
      if (b.shipClass === c) continue;
      b.shipClass = c;
      this.refreshLook(b);
      this.dirty = true;
    }
  }

  private shipOf(p: RoomPlayer): Ship | undefined {
    const w = this.world;
    if (!w) return undefined;
    const sid = w.shipsByPlayer.get(p.playerId);
    return sid ? w.ships.get(sid) : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // SEC-2: leaving the running match counts as a death for respawn purposes
  // ------------------------------------------------------------------------------------------

  /**
   * World tick before which a pilot leaving the match now may not get a new ship: a full respawn delay
   * from now, or the ship's own respawn tick when it is already dead and due later.
   */
  private rejoinNotBefore(p: RoomPlayer): number {
    const w = this.world;
    if (!w) return 0;
    let t = w.tick + REJOIN_DELAY_TICKS;
    const ship = this.shipOf(p);
    if (ship && !ship.alive && Number.isFinite(ship.respawnTick)) t = Math.max(t, ship.respawnTick);
    return t;
  }

  /**
   * Ticks this pilot still has to wait before a new ship (0 = may enter now). A ship added between ticks
   * first acts on the next step (world.tick + 1) — the same step a dead ship with that respawnTick
   * would come back on.
   */
  private rejoinWait(p: RoomPlayer): number {
    const w = this.world;
    if (!w || !p.rejoinTick) return 0;
    return Math.max(0, p.rejoinTick - (w.tick + 1));
  }

  /** Drop a watching pilot back into the running match now, or once their rejoin delay is over (runRejoins). */
  private enterMatchOrWait(p: RoomPlayer): void {
    const wait = this.rejoinWait(p);
    if (wait > 0) { this.tell(p, rejoinMsg(wait)); return; }
    p.rejoinTick = 0;
    this.addToSim(p);
    this.sendMatchStart(p);
  }

  /** Pilots waiting out their rejoin delay get their ship on the step the delay ends. */
  private runRejoins(world: World): void {
    // A rift adds ships only at floor starts (onFloorStart), whatever a pilot's rejoin delay says.
    if (this.riftRunning) return;
    for (const p of this.players) {
      if (p.isBot || p.inMatch || p.spectating || !p.watching || !p.rejoinTick) continue;
      if (world.tick + 1 < p.rejoinTick) continue;
      p.rejoinTick = 0;
      this.addToSim(p);
      this.sendMatchStart(p);
      this.rebalanceBots();
      this.host.roomsChanged();
    }
  }

  private static rejoinKeys(user: ZoneUser): string[] {
    const keys = [`p:${user.playerId}`];
    if (user.account) keys.push(`a:${user.account.accountId}`);
    return keys;
  }

  private rememberRejoin(user: ZoneUser, notBefore: number): void {
    const now = this.sim ? this.sim.world.tick : 0;
    for (const [k, t] of this.rejoinAfter) if (t <= now) this.rejoinAfter.delete(k); // expired: keep it small
    for (const k of Room.rejoinKeys(user)) this.rejoinAfter.set(k, Math.max(notBefore, this.rejoinAfter.get(k) ?? 0));
  }

  /** Rejoin-not-before tick carried over from this connection's / account's last exit from the running match. */
  private recalledRejoin(user: ZoneUser): number {
    if (this.phase !== 'playing' || !this.sim) return 0;
    let t = 0;
    for (const k of Room.rejoinKeys(user)) t = Math.max(t, this.rejoinAfter.get(k) ?? 0);
    return t > this.sim.world.tick ? t : 0;
  }

  /**
   * Apply queued class/team changes to ships that respawn on the coming step (dead, respawn timer
   * expiring). Calling the sim now makes that respawn happen with the new class/team — never earlier
   * than the normal timer, so neither change can skip the respawn delay or refill a live ship.
   */
  private applyQueuedChanges(world: World): void {
    const sim = this.sim;
    if (!sim) return;
    for (const p of this.players) {
      if (p.isBot || !p.inMatch) continue;
      const ship = this.shipOf(p);
      if (!ship) { p.pendingTeam = null; continue; }
      const teamChange = p.pendingTeam !== null && p.pendingTeam !== p.team;
      // A rift's class changes wait for the next floor start (onFloorStart), not the next respawn (§4.8).
      const classChange = ship.shipClass !== p.shipClass && gameTypeOf(world.config) !== 'dungeon';
      if (!teamChange && !classChange) { p.pendingTeam = null; continue; }
      if (ship.alive || world.tick + 1 < ship.respawnTick) continue;
      if (classChange) this.safeSim(() => sim.setShipClass(p.playerId, p.shipClass));
      if (teamChange) {
        const team = p.pendingTeam!;
        p.team = team;
        this.safeSim(() => sim.setPlayerTeam(p.playerId, team));
        this.system(`${p.name} joined team ${teamName(team)}.`);
        this.rebalanceBots();
        this.host.roomsChanged();
      }
      p.pendingTeam = null;
      this.dirty = true;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------------------------------

  /** Settings a house (built-in, online) room's host may not change: they are the room's identity. */
  private static readonly HOUSE_FIXED = ['name', 'maxPlayers', 'gameType', 'subMode'] as const;
  /** Settings that only change in the lobby (§3.2); the rest apply at the next match. */
  private static readonly LOBBY_ONLY = ['gameType', 'subMode', 'mode', 'teamCount', 'floors'] as const;

  applySettings(patch: unknown, by?: RoomPlayer): void {
    const inLobby = this.phase === 'lobby';
    const raw: Record<string, unknown> = patch && typeof patch === 'object' ? { ...(patch as Record<string, unknown>) } : {};
    if (this.locked && by) {
      // House rooms: whoever happens to be host can't rename them, change what they are, or shrink the
      // player cap (which would lock everyone else out of the shared default rooms).
      let refused = false;
      for (const k of Room.HOUSE_FIXED) {
        if (raw[k] !== undefined && raw[k] !== this.settings[k]) refused = true;
        delete raw[k];
      }
      if (refused) this.tell(by, 'This is a built-in room: its name, game type, mode and player cap are fixed. Create a game to customize them.');
    }
    if (!inLobby) {
      let refused = false;
      for (const k of Room.LOBBY_ONLY) {
        if (raw[k] !== undefined && raw[k] !== this.settings[k]) refused = true;
        delete raw[k];
      }
      if (refused && by) this.tell(by, 'Game type, mode, teams and floors can only change in the lobby.');
    }
    if (by && raw.subMode !== undefined && raw.subMode !== this.settings.subMode) {
      // Like /sub: a sub-mode that isn't open yet (or belongs to another type) is refused, not silently
      // swapped back by clampSettings.
      const t = isGameType(raw.gameType) ? raw.gameType : this.settings.gameType;
      const sm = raw.subMode;
      if (!isSubMode(sm) || !GAME_TYPES[t].subModes.includes(sm)) { this.tell(by, `${GAME_TYPES[t].name} has no such mode.`); return; }
      if (!SUB_MODES[sm].ready) { this.tell(by, `${subModeLabel(t, sm)} isn't open yet.`); return; }
    }
    const next = clampSettings(this.settings, raw);
    if (by && !SUB_MODES[next.subMode].ready
      && (next.gameType !== this.settings.gameType || next.subMode !== this.settings.subMode)) {
      this.tell(by, `${GAME_TYPES[next.gameType].name} isn't open yet.`);
      return;
    }
    const seated = this.activeHumanCount;
    if (seated > next.maxPlayers) {
      if (by) this.tell(by, `${seated} pilots are seated — those settings allow only ${next.maxPlayers}.`);
      return;
    }
    const prev = this.settings;
    this.settings = next;
    const changes: string[] = [];
    if (prev.gameType !== next.gameType) changes.push(`type ${GAME_TYPES[next.gameType].name}`);
    if (prev.subMode !== next.subMode || prev.gameType !== next.gameType) changes.push(subModeLabel(next.gameType, next.subMode));
    if (prev.floors !== next.floors && next.gameType === 'dungeon') changes.push(`${next.floors} floors`);
    if (prev.objectiveLimit !== next.objectiveLimit) changes.push(`target ${next.objectiveLimit || 'default'}`);
    if (prev.mode !== next.mode || prev.teamCount !== next.teamCount) {
      changes.push(next.gameType === 'dungeon' ? 'party' : next.mode === 'ffa' ? 'mode FFA' : `mode ${next.teamCount} teams`);
      for (const p of this.players) {
        if (p.spectating) { p.team = TEAM_UNASSIGNED; continue; }
        if (next.mode === 'ffa') p.team = NO_TEAM;
        else if (prev.mode === 'ffa' || p.team >= next.teamCount) p.team = p.isBot ? NO_TEAM : TEAM_UNASSIGNED;
      }
      for (const p of this.players) if (p.isBot && next.mode === 'teams' && p.team < 0) p.team = this.smallestTeam(p);
    }
    // Bots "window shop" the mode's set: a new game type re-dresses them (botWardrobe is seeded per bot).
    if (prev.gameType !== next.gameType) for (const p of this.players) if (p.isBot) this.refreshLook(p);
    if (prev.botFill !== next.botFill) changes.push(`bots ${next.botFill}`);
    if (prev.botSkill !== next.botSkill) {
      changes.push(`bot skill ${next.botSkill}`);
      for (const p of this.players) if (p.isBot) p.brain = null; // rebuilt lazily with the new skill
    }
    if (prev.pveIntensity !== next.pveIntensity && prev.gameType === next.gameType) {
      const lbl = GAME_TYPES[next.gameType].pveLabels[next.pveIntensity] ?? String(next.pveIntensity);
      changes.push(`${next.gameType === 'dungeon' ? 'difficulty' : 'swarm'} ${lbl}`);
    }
    if (prev.matchMinutes !== next.matchMinutes) changes.push(next.matchMinutes ? `${next.matchMinutes} min` : 'untimed');
    if (prev.scoreLimit !== next.scoreLimit) changes.push(`score limit ${next.scoreLimit || 'none'}`);
    if (prev.friendlyFire !== next.friendlyFire) changes.push(`friendly fire ${next.friendlyFire ? 'on' : 'off'}`);
    if (prev.maxPlayers !== next.maxPlayers) changes.push(`max ${next.maxPlayers}`);
    if (prev.name !== next.name) changes.push(`name "${next.name}"`);
    this.syncBots();
    this.rebalanceBots();
    if (changes.length && by && !this.userCreated) this.customized = true;
    if (changes.length) {
      if (this.matchBotFill !== null && (prev.pveIntensity !== next.pveIntensity || prev.matchMinutes !== next.matchMinutes
        || prev.scoreLimit !== next.scoreLimit || prev.friendlyFire !== next.friendlyFire
        || prev.objectiveLimit !== next.objectiveLimit || prev.botFill !== next.botFill)) {
        changes.push('(match settings apply next match)');
      }
      this.system(`Settings: ${changes.join(', ')}.`);
    }
    this.dirty = true;
    this.host.roomsChanged();
  }

  // ------------------------------------------------------------------------------------------
  // Bots
  // ------------------------------------------------------------------------------------------

  /**
   * Keep active humans + bots == botFill (never above maxPlayers). v0.3 fix #1: only ACTIVE humans take
   * seats — spectators ride on SPECTATOR_SLOTS and never evict bots.
   */
  syncBots(): void {
    const s = this.settings;
    // §3.2: botFill changes take effect at the next match — the running match keeps the fill it started with.
    const fill = this.matchBotFill ?? s.botFill;
    const want = Math.max(0, Math.min(fill, s.maxPlayers) - this.seatedHumanCount);
    let bots = this.botCount;
    while (bots > want) { this.removeOneBot(); bots--; }
    while (bots < want) { this.addBot(); bots++; }
  }

  private addBot(): void {
    const pid = this.host.allocPlayerId();
    // A callsign is in use when a bot here wears it, bare or with a dedupe digit suffix. ('Echo-7' ends in a digit
    // itself, so stripping trailing digits off the used names never matched it and it could be dealt twice.)
    const botKeys = this.players.filter((p) => p.isBot).map((p) => nameKey(p.name));
    const inUse = (c: string): boolean => {
      const k = nameKey(c);
      return botKeys.some((n) => n === k || (n.startsWith(k) && /^\d+$/.test(n.slice(k.length))));
    };
    const pool = BOT_CALLSIGNS.filter((n) => !inUse(n));
    const raw = pool.length ? pool[Math.floor(Math.random() * pool.length)] : BOT_CALLSIGNS[Math.floor(Math.random() * BOT_CALLSIGNS.length)];
    // host.uniqueName checks the zone's pilots and registered rooms, but the constructor fills a room before the Zone
    // registers it, so this room's own roster is checked here as well.
    const own = new Set(this.players.map((q) => nameKey(q.name)));
    let name = this.host.uniqueName(raw, pid);
    for (let i = 0; i < 4 && own.has(nameKey(name)); i++) {
      name = this.host.uniqueName(dedupeName(name, (n) => own.has(nameKey(n))), pid);
    }
    // Dungeon (§4.8): the bot complements the party (humans + bots flying); elsewhere it keeps bot rosters mixed.
    const shipClass = this.settings.gameType === 'dungeon'
      ? riftBotClass(this.players.filter((q) => !q.spectating).map((q) => q.shipClass), Math.random)
      : leastUsedClass(this.players.filter((q) => q.isBot).map((q) => q.shipClass), Math.random);
    const p: RoomPlayer = {
      playerId: pid, name,
      team: this.settings.mode === 'ffa' ? NO_TEAM : this.smallestTeam(),
      shipClass, isBot: true, ready: true, spectating: false, user: null, brain: null,
      seed: (Math.random() * 0xffffffff) >>> 0, inMatch: false, watching: false, joinOrder: this.joinCounter++, pendingTeam: null,
      rejoinTick: 0, lastTeamChangeTick: -1e9,
      matchJoinTick: 0, extracted: false, pendingDropIn: false, pendingClass: null, readyAfterResults: false,
      playedTicks: 0, riftJoinFloor: 0,
    };
    p.cosmetics = this.lookFor(p);
    this.players.push(p);
    if (this.phase === 'playing' && this.sim) this.addToSim(p);
    this.dirty = true;
  }

  private removeOneBot(): void {
    const bots = this.players.filter((p) => p.isBot);
    if (!bots.length) return;
    let victim = bots[bots.length - 1];
    if (this.settings.mode === 'teams') {
      const c = this.teamCounts();
      let best = -1;
      for (const b of bots) if (b.team >= 0 && (best < 0 || c[b.team] > c[best])) { best = b.team; victim = b; }
    }
    if (victim.inMatch && this.sim) this.safeSim(() => this.sim!.removePlayer(victim.playerId));
    this.players.splice(this.players.indexOf(victim), 1);
    this.dirty = true;
  }

  /** Move bots from the largest to the smallest team until within 1. */
  rebalanceBots(): void {
    if (this.settings.mode !== 'teams') return;
    for (let guard = 0; guard < 64; guard++) {
      const c = this.teamCounts();
      let min = 0, max = -1;
      for (let i = 0; i < c.length; i++) if (c[i] < c[min]) min = i;
      for (let i = 0; i < c.length; i++) {
        if (this.players.some((p) => p.isBot && p.team === i) && (max < 0 || c[i] > c[max])) max = i;
      }
      if (max < 0 || c[max] - c[min] <= 1) return;
      const bot = [...this.players].reverse().find((p) => p.isBot && p.team === max)!;
      bot.team = min;
      if (bot.inMatch && this.sim) this.safeSim(() => this.sim!.setPlayerTeam(bot.playerId, min));
      this.dirty = true;
    }
  }

  private brainFor(p: RoomPlayer): BotBrain {
    if (!p.brain) p.brain = createBotBrain(this.settings.botSkill, p.seed);
    return p.brain;
  }

  private maybeGreet(human: RoomPlayer): void {
    if (Math.random() > 0.35) return;
    const bots = this.players.filter((p) => p.isBot);
    if (!bots.length) return;
    const b = bots[Math.floor(Math.random() * bots.length)];
    const text = GREETINGS[Math.floor(Math.random() * GREETINGS.length)].replace('{n}', human.name);
    this.queueBotChat(b, text, 'all', 2 + Math.random() * 3);
  }

  private queueBotChat(b: RoomPlayer, text: string, channel: 'all' | 'team', delaySec: number): void {
    this.botChats.push({ at: this.tickCount + Math.round(delaySec * TICK_RATE), pid: b.playerId, text, channel });
  }

  private runBotChats(): void {
    if (!this.botChats.length) return;
    const keep: PendingBotChat[] = [];
    for (const c of this.botChats) {
      if (c.at > this.tickCount) { keep.push(c); continue; }
      const b = this.player(c.pid);
      if (!b) continue;
      this.pushChat({ fromPlayerId: b.playerId, fromName: b.name, channel: c.channel, team: b.team, text: c.text, time: Date.now() });
    }
    this.botChats = keep;
  }

  // ------------------------------------------------------------------------------------------
  // Chat plumbing
  // ------------------------------------------------------------------------------------------

  private historyFor(p: RoomPlayer): ChatLine[] {
    return this.history.filter((l) => l.channel !== 'team' || l.team === p.team);
  }

  pushChat(line: ChatLine): void {
    this.history.push(line);
    if (this.history.length > CHAT_HISTORY) this.history.splice(0, this.history.length - CHAT_HISTORY);
    const msg: ServerMsg = { type: 'chat', line };
    for (const p of this.players) {
      if (!p.user) continue;
      if (line.channel === 'team' && p.team !== line.team) continue;
      p.user.sink.sendMsg(msg);
    }
  }

  system(text: string): void {
    this.pushChat({ fromPlayerId: 0, fromName: '', channel: 'system', team: NO_TEAM, text, time: Date.now() });
  }

  /** Private system line (not stored). */
  tell(p: RoomPlayer, text: string): void {
    p.user?.sink.sendMsg({ type: 'chat', line: { fromPlayerId: 0, fromName: '', channel: 'system', team: NO_TEAM, text, time: Date.now() } });
  }

  // ------------------------------------------------------------------------------------------
  // Phases
  // ------------------------------------------------------------------------------------------

  private requestStart(p: RoomPlayer): void {
    if (!this.canHostAct(p)) { this.tell(p, 'Only the host can start the match.'); return; }
    if (this.phase === 'playing') { this.tell(p, 'A match is already running — use Join Match.'); return; }
    if (this.phase !== 'lobby') return;
    this.startCountdown();
  }

  startCountdown(): void {
    if (this.phase !== 'lobby') return;
    this.autoStartTicks = 0;
    // §3.6 playing cap (online): wait in the lobby for a free slot, re-checked every second (tickLobby).
    if (!this.host.canStartMatch()) {
      if (!this.pendingStart) {
        this.pendingStart = true;
        this.system(START_WAIT_MSG);
        this.dirty = true;
        this.host.roomsChanged();
      }
      return;
    }
    this.pendingStart = false;
    this.phase = 'countdown';
    this.countdownTicks = COUNTDOWN_SEC * TICK_RATE;
    this.lastCountdownSent = -1;
    this.autoStartTicks = 0;
    this.system(`Match starting in ${COUNTDOWN_SEC}...`);
    this.dirty = true;
    this.host.roomsChanged();
  }

  private addToSim(p: RoomPlayer): void {
    if (!this.sim || p.inMatch) return;
    const ffa = this.settings.mode === 'ffa';
    if (!ffa && p.team < 0) p.team = this.smallestTeam(p);
    if (ffa) p.team = NO_TEAM;
    this.sim.addPlayer({ playerId: p.playerId, name: p.name, team: p.team, shipClass: p.shipClass, isBot: p.isBot });
    p.inMatch = true;
    p.matchJoinTick = this.sim.world.tick;
    p.riftJoinFloor = this.sim.world.dungeon ? this.sim.world.dungeon.floor : 0;
    this.dirty = true;
    // (At match start the phase is still 'countdown' here; beginPlaying refuses lobby spectators instead, and sets
    // the loot multiplier once everyone is in.)
    if (!p.isBot && this.phase === 'playing') {
      this.cutSameNetworkWatchers(p);
      this.updateLootMult();
    }
  }

  /** The ship leaves the sim (spectate / leave): bank the stint's flown time for the crate gates. */
  private endStint(p: RoomPlayer): void {
    const w = this.world;
    if (w && p.inMatch) p.playedTicks += Math.max(0, w.tick - p.matchJoinTick);
  }

  // ------------------------------------------------------------------------------------------
  // v0.3 M2: loot wiring (§6.4.6 anti-farm multiplier, §7.3 grant flow). Room never touches storage.
  // ------------------------------------------------------------------------------------------

  /** §6.4.6: ≥ 2 humans flying (or offline) 1.0; exactly 1 human LOOT_MULT_SOLO[type]; nobody to pick up: 0. */
  private computeLootMult(humansFlying: number): number {
    if (humansFlying <= 0) return 0;
    if (this.host.local || humansFlying >= 2) return 1;
    return LOOT_MULT_SOLO[this.settings.gameType] ?? 1;
  }

  /** Hand the running Sim a new multiplier when the number of humans flying crossed a threshold (join / leave). */
  private updateLootMult(): void {
    const sim = this.sim;
    if (!sim || this.phase !== 'playing') return;
    let n = 0;
    for (const p of this.players) if (!p.isBot && p.inMatch && !p.extracted) n++;
    const m = this.computeLootMult(n);
    if (m === this.lootMult) return;
    this.lootMult = m;
    this.safeSim(() => sim.setLootMult(m));
  }

  /** Grant / ledger key owner: accountId | 'local' (from ProfileService.attach) or `guest:${playerId}`. */
  private profileKeyOf(p: RoomPlayer): string {
    return p.user?.profileKey ?? `guest:${p.playerId}`;
  }

  /** `${matchId}#${profileKey}#${seq}`: seq = grants already issued to this key in this match (fix #17). */
  private nextGrantKey(key: string): string {
    const seq = this.grantSeq.get(key) ?? 0;
    this.grantSeq.set(key, seq + 1);
    return `${this.matchId}#${key}#${seq}`;
  }

  /** host.grantLoot, guarded: a failing profile layer never aborts the match (fix #18). */
  private grantBatch(entries: LootGrantEntry[]): (LootGrantOutcome | undefined)[] {
    if (!entries.length) return [];
    try {
      const out = this.host.grantLoot(entries);
      return Array.isArray(out) ? out : [];
    } catch (e) {
      this.host.log(`[${this.settings.name}] loot grant failed: ${(e as Error)?.message ?? e}`);
      return [];
    }
  }

  /**
   * §7.3.6 leave mid-match: grant the secured bank (crateRolls 0, no shards) BEFORE removePlayer spills the carried
   * caches (those count as lost). Nothing secured = nothing to grant (a rejoin later gets the next seq key).
   */
  private grantOnLeave(p: RoomPlayer): void {
    if (p.isBot || !this.sim) return;
    const key = this.profileKeyOf(p);
    const bank = this.bank.get(key);
    if (!bank || !bank.length) return;
    const carried = this.shipOf(p)?.carried?.length ?? 0;
    if (carried > 0) this.spillCounted.add(p.playerId); // removePlayer's lootSpill for these is already counted
    const input: GrantInput = {
      grantKey: this.nextGrantKey(key), gameType: gameTypeOf(this.sim.world.config), tokens: bank.slice(),
      crateRolls: 0, shards: 0, won: false, cachesLost: (this.spills.get(key) ?? 0) + carried,
    };
    this.bank.delete(key);
    this.spills.delete(key);
    const [out] = this.grantBatch([{ user: p.user, profileKey: key, input }]);
    // A duplicate (the key was already recorded) was delivered once already: never send or show it again.
    if (out && !out.duplicate && p.user) p.user.sink.sendMsg({ type: 'lootGrant', grant: out.grant, persisted: out.persisted });
    this.host.log(`[${this.settings.name}] leave grant ${input.grantKey}: ${input.tokens.length} secured${out ? '' : ' (not granted)'}`);
  }

  /**
   * Floors of the run this pilot got through WHILE FLYING it (crate bonus / dungeon eligibility): counted from the
   * floor their current stint began on (riftJoinFloor), so a late drop-in or a spectate-then-drop-in never collects
   * the floors the party (or its bots) cleared without them. 0 outside a rift or when not flying.
   */
  private floorsCleared(world: World, p: RoomPlayer): number {
    const d = world.dungeon;
    const j = p.riftJoinFloor;
    if (!d || j <= 0) return 0;
    const ex = d.extracted.find((e) => e.playerId === p.playerId);
    if (ex) return Math.max(0, ex.floor - j + 1);
    if (d.outcome === 'cleared') return Math.max(0, d.floorsTotal - j + 1);
    return Math.max(0, d.floor - j);
  }

  /**
   * §7.3.5 / §6.6: build every human's GrantInput for this match and grant them in ONE batch. Mutates
   * `result.lootHighlights` (public epic+ reveals). Returns what to send each pilot after matchEnd.
   */
  private grantResults(world: World, result: MatchResult): { p: RoomPlayer; out: LootGrantOutcome }[] {
    const sim = this.sim;
    if (!sim) return [];
    const gameType = gameTypeOf(world.config);
    const dungeon = gameType === 'dungeon';
    const cleared = world.dungeon?.outcome === 'cleared';
    // Survivors' carried caches are secured at match end: Arena / Warzone always, a rift only when cleared (§6.5).
    const secureCarried = !dungeon || cleared;
    const matchSec = Math.max(0, world.tick - world.match.startTick) / TICK_RATE;
    const teams = world.config.mode === 'teams';
    // FFA "won" = a top-3 finish: by objective points in an FFA hot point (fix #7), else by score.
    const ffaPts = result.objective?.playerPoints;
    const top3 = new Set(ffaPts ? ffaPts.slice(0, 3).map(([pid]) => pid) : result.scores.slice(0, 3).map((s) => s.playerId));
    const lead = result.scores[0];
    const mvpPid = lead && lead.score > 0 && this.player(lead.playerId) && !this.player(lead.playerId)!.isBot ? lead.playerId : 0;
    const entries: LootGrantEntry[] = [];
    const who: RoomPlayer[] = [];
    for (const p of this.players) {
      if (p.isBot || !p.user) continue;
      const key = this.profileKeyOf(p);
      const bank = this.bank.get(key) ?? [];
      if (!p.inMatch && p.playedTicks <= 0 && !bank.length) continue; // never flew this match (lobby / watcher)
      const ship = this.shipOf(p);
      const tokens = bank.slice();
      let lostNow = 0;
      if (ship && ship.carried && ship.carried.length) {
        let taken: CacheToken[] = [];
        try { taken = sim.takeCarried(p.playerId); } catch (e) { this.host.log(`[${this.settings.name}] takeCarried failed: ${(e as Error)?.message ?? e}`); }
        if (secureCarried && ship.alive) tokens.push(...taken);
        else lostNow += taken.length; // rift not cleared: unsecured loot is lost
      }
      const playedSec = (p.playedTicks + (p.inMatch ? Math.max(0, world.tick - p.matchJoinTick) : 0)) / TICK_RATE;
      const team = ship ? ship.team : p.team;
      const won = teams ? result.winnerTeam >= 0 && team === result.winnerTeam : top3.has(p.playerId);
      const ctx: CrateContext = {
        gameType, playedSec, matchSec, won,
        ...(dungeon ? { floorsCleared: this.floorsCleared(world, p), fullClear: cleared && p.riftJoinFloor === 1 } : {}),
      };
      // Crates (§6.6) behind the 120 s played / 180 s match gates. Base shards sit behind the same gates: a host
      // /end-ing matches back to back must not farm the per-match base + win + MVP shards.
      const eligible = crateEligible(ctx);
      const crateRolls = eligible ? crateCount(ctx) : 0;
      const shards = eligible ? baseShards({ playedSec, won, mvp: mvpPid === p.playerId }) : 0;
      const cachesLost = (this.spills.get(key) ?? 0) + lostNow;
      if (!tokens.length && !crateRolls && !shards && !cachesLost) continue; // e.g. a /end before the time gates
      entries.push({
        user: p.user, profileKey: key,
        input: { grantKey: this.nextGrantKey(key), gameType, tokens, crateRolls, shards, won, cachesLost },
      });
      who.push(p);
    }
    this.bank.clear();
    this.spills.clear();
    const outs = this.grantBatch(entries);
    const sends: { p: RoomPlayer; out: LootGrantOutcome }[] = [];
    const highlights: NonNullable<MatchResult['lootHighlights']> = [];
    for (let i = 0; i < who.length; i++) {
      const out = outs[i];
      if (!out || !out.grant) { this.host.log(`[${this.settings.name}] no grant for ${entries[i].input.grantKey}`); continue; }
      if (out.duplicate) continue; // an idempotent replay: already delivered and announced once
      sends.push({ p: who[i], out });
      for (const it of out.grant.items ?? []) {
        if (it && !it.dupe && it.rarity >= 3) highlights.push({ playerId: who[i].playerId, itemId: it.itemId, rarity: it.rarity });
      }
    }
    if (highlights.length) result.lootHighlights = highlights.slice(0, 32);
    return sends;
  }

  private sendMatchStart(p: RoomPlayer): void {
    if (!p.user || !this.sim) return;
    p.watching = true;
    this.builder.resetSpectator(p.playerId); // the client starts a fresh spectate camera on matchStart
    const w = this.sim.world;
    p.user.sink.sendMsg({
      type: 'matchStart', mapSeed: this.mapSeed, mode: w.config.mode, teamCount: w.config.teamCount,
      // v0.3: the client rebuilds the map with buildMatchMap({ seed, gameType, subMode, teamCount, floor }).
      gameType: gameTypeOf(w.config), subMode: subModeOf(w.config), floor: w.dungeon ? w.dungeon.floor : 0,
      yourShipId: p.inMatch ? this.sim.shipIdFor(p.playerId) : 0, tick: w.tick, snapshotEvery: this.host.snapshotEvery,
    });
  }

  private beginPlaying(): void {
    const s = this.settings;
    const ffa = s.mode === 'ffa';
    // place unassigned (non-spectating) humans, then even out bots
    for (const p of this.players) {
      if (p.spectating) { p.team = TEAM_UNASSIGNED; continue; }
      if (ffa) p.team = NO_TEAM;
      else if (p.team < 0 || p.team >= s.teamCount) p.team = this.smallestTeam(p);
    }
    this.matchBotFill = s.botFill;
    this.rebalanceBots(); // (a lobby-only step for a rift's single party: every pilot is team 0 already)
    if (s.gameType === 'dungeon') this.complementBotClasses();
    for (const p of this.players) { p.extracted = false; p.pendingDropIn = false; p.pendingClass = null; }
    this.mapSeed = (Math.random() * 0x7fffffff) >>> 0;
    this.matchId = this.host.newMatchId();
    // §6.4.6 anti-farm multiplier for the humans about to fly (updated on every human join / leave).
    let flying = 0;
    for (const p of this.players) if (!p.isBot && !p.spectating) flying++;
    this.lootMult = this.computeLootMult(flying);
    this.sim = new Sim({
      mapSeed: this.mapSeed, mode: s.mode, teamCount: ffa ? 0 : s.teamCount, pveIntensity: s.pveIntensity,
      // 0 = untimed (dungeon): endTick 0, MatchView.timed = false.
      matchSeconds: s.matchMinutes * 60, scoreLimit: s.scoreLimit, friendlyFire: s.friendlyFire,
      // v0.3: always explicit (gameTypeOf's fallback is only for v0.2-shaped configs).
      gameType: s.gameType, subMode: s.subMode, floors: s.floors, objectiveLimit: s.objectiveLimit,
      lootMult: this.lootMult,
      // Server-only loot RNG seed (fix #14): never leaves the server (not in matchStart / snapshots).
      lootSeed: this.host.randomSeed(),
    });
    this.bank.clear(); this.spills.clear(); this.grantSeq.clear(); this.spillCounted.clear();
    this.lastLootNoteTick = -1e9;
    this.objAnnouncer.reset();
    this.riftAnnouncer.reset(); this.riftLeavers.clear(); this.riftChests.clear(); this.forceSnapshot = false;
    for (const p of this.players) p.playedTicks = 0;
    this.turretTicks.clear(); this.hostTicks.clear(); this.bountyClaimed.clear(); this.gemXp.clear();
    this.builder.resetSpectator(); // entity ids restart with the new world
    this.rejoinAfter.clear(); // world ticks restart too
    this.riftExtractedKeys.clear();
    for (const p of this.players) p.rejoinTick = 0;
    this.pendingEvents = [];
    this.snapCounter = 0;
    this.scoreCounter = 0;
    this.tickErrors = 0;
    this.lastNoteTick = -1e9;
    for (const p of this.players) if (!p.spectating) this.addToSim(p);
    this.phase = 'playing';
    this.updateLootMult(); // no-op unless the roster changed on the way in
    for (const p of this.players) {
      if (!p.user) continue;
      // fix #2: a lobby spectator on the network of a pilot in this match doesn't get to watch it.
      const why = p.spectating ? this.spectateRefusal(p.user) : null;
      if (why) { this.tell(p, why); continue; }
      this.sendMatchStart(p);
    }
    const label = subModeLabel(s.gameType, s.subMode);
    // v0.3 M3: objective sub-modes name their target ("first to 3 captures").
    const target = objectiveTarget(s.subMode, s.mode, s.objectiveLimit);
    const unit = SUB_MODES[s.subMode].limitLabel || 'points';
    const goal = target > 0 ? ` First to ${target} ${target === 1 ? unit.replace(/s$/, '') : unit}.` : '';
    if (s.gameType === 'dungeon') this.system(`The descent begins — ${s.floors} floors. Stay together.`);
    else if (ffa && goal) this.system(`Free-for-all ${label}!${goal}`);
    else if (ffa) this.system(`Free-for-all ${label}! Last pilot standing... or highest score, anyway.`);
    else this.system(`Fight! ${label}, ${s.teamCount} teams, ${s.matchMinutes} minutes.${goal}`);
    this.dirty = true;
    this.host.roomsChanged();
    this.host.log(`[${s.name}] match start seed=${this.mapSeed} players=${this.players.length}`);
  }

  private joinMatch(p: RoomPlayer): void {
    if (this.phase !== 'playing' || !this.sim) { this.tell(p, 'No match is running.'); return; }
    if (p.watching && (p.inMatch || p.spectating)) return;
    if (p.spectating && p.user && !p.pendingDropIn) {
      const why = this.spectateRefusal(p.user);
      if (why) { this.tell(p, why); return; }
    }
    if (!p.spectating && !p.inMatch && GAME_TYPES[this.settings.gameType].dropIn === 'floorStart') {
      // Rift: watch now, the next floor start adds the ship (onFloorStart) — none is coming on the final floor.
      if (p.pendingDropIn && p.watching) return;
      const d = this.sim.world.dungeon;
      if (p.extracted) this.tell(p, RIFT_EXTRACTED_MSG);
      else if (d && d.floor >= d.floorsTotal) this.tell(p, RIFT_FINAL_FLOOR_MSG);
      else { p.pendingDropIn = true; this.tell(p, 'You join the party at the next floor.'); }
      if (!p.watching) this.sendMatchStart(p);
      this.dirty = true;
      return;
    }
    if (!p.spectating && !p.inMatch) {
      const wait = this.rejoinWait(p);
      if (wait > 0) {
        // SEC-2: left the match moments ago (spectate / leave room): watch until the delay is over,
        // then runRejoins drops the ship in.
        this.tell(p, rejoinMsg(wait));
        if (!p.watching) { this.sendMatchStart(p); this.dirty = true; }
        return;
      }
      p.rejoinTick = 0;
      this.addToSim(p);
      this.rebalanceBots();
      if (this.settings.mode === 'teams') this.system(`${p.name} dropped in for ${teamName(p.team)}.`);
      else this.system(`${p.name} dropped in.`);
    }
    this.sendMatchStart(p);
    this.dirty = true;
  }

  enterResults(): void {
    if (this.phase !== 'playing' || !this.sim) return;
    // Events drained since the last snapshot tick (the deciding kill, matchEnd...) would be lost once the
    // phase changes: flush them in a final snapshot, before the matchEnd message.
    if (this.pendingEvents.length) {
      this.snapCounter = 0;
      this.sendSnapshots(this.sim.world);
    }
    const world = this.sim.world;
    const result = this.buildResult(world);
    // §7.3.5: one grant batch for every human (never throws), THEN matchEnd (with lootHighlights), then each
    // pilot's lootGrant, then the legendary reveal lines.
    const grants = this.grantResults(world, result);
    const msg: ServerMsg = { type: 'matchEnd', result };
    for (const p of this.players) p.user?.sink.sendMsg(msg);
    for (const { p, out } of grants) p.user?.sink.sendMsg({ type: 'lootGrant', grant: out.grant, persisted: out.persisted });
    this.phase = 'results';
    this.resultsTicks = RESULTS_SEC * TICK_RATE;
    // announce (fix #23: a rift says how the run ended, not "Team Crimson wins!")
    if (result.rift) this.system(riftResultLine(result.rift, world.dungeon?.floor ?? result.rift.floorReached));
    else if (this.settings.mode === 'teams' && result.winnerTeam >= 0) this.system(`Team ${teamName(result.winnerTeam)} wins!`);
    else if (result.winnerPlayerId) this.system(`${this.player(result.winnerPlayerId)?.name ?? 'Someone'} wins!`);
    else this.system('Match over — it\'s a draw.');
    for (const h of result.lootHighlights ?? []) {
      if (h.rarity < 4) continue;
      const def = COSMETICS[h.itemId];
      this.system(`${this.player(h.playerId)?.name ?? 'Someone'} unboxed ${def ? def.name : h.itemId} — Legendary!`);
    }
    // a little sportsmanship
    const bots = this.players.filter((p) => p.isBot);
    for (let i = 0; i < 2 && bots.length; i++) {
      if (Math.random() < 0.5) {
        const b = bots.splice(Math.floor(Math.random() * bots.length), 1)[0];
        this.queueBotChat(b, GGS[Math.floor(Math.random() * GGS.length)], 'all', 1 + Math.random() * 3);
      }
    }
    this.dirty = true;
    this.host.roomsChanged();
    this.host.log(`[${this.settings.name}] match end winnerTeam=${result.winnerTeam} winner=${result.winnerPlayerId}`);
  }

  private backToLobby(): void {
    this.phase = 'lobby';
    this.sim = null;
    this.matchBotFill = null; // the lobby (and the next match) use settings.botFill again
    this.pendingEvents = [];
    this.rejoinAfter.clear();
    this.riftExtractedKeys.clear();
    // A match that never reached results (bots-only abort, server error) grants nothing (§3.6).
    this.bank.clear(); this.spills.clear(); this.spillCounted.clear();
    this.lootMult = 0;
    this.riftLeavers.clear(); this.riftChests.clear(); this.forceSnapshot = false;
    // Rift drop-ins still waiting when the run ended take their seat for the next run (seats permitting).
    for (const p of this.players) {
      if (p.isBot || !p.pendingDropIn || !p.spectating) continue;
      if (this.activeHumanCount >= this.settings.maxPlayers) break;
      p.spectating = false;
      p.team = this.settings.mode === 'ffa' ? NO_TEAM : TEAM_UNASSIGNED;
    }
    for (const p of this.players) {
      if (p.pendingTeam !== null && !p.spectating) p.team = p.pendingTeam; // queued switch applies to the next match
      p.pendingTeam = null;
      p.rejoinTick = 0;
      p.inMatch = false;
      p.watching = false;
      p.ready = p.isBot || p.readyAfterResults; // Quick Play during results: in for this next match
      p.readyAfterResults = false;
      p.pendingDropIn = false;
      p.pendingClass = null;
      p.extracted = false;
      p.riftJoinFloor = 0;
    }
    this.autoStartTicks = 0;
    this.pendingStart = false;
    this.syncBots();
    this.rebalanceBots();
    this.dirty = true;
    this.host.roomsChanged();
  }

  scores(world: World): PlayerScore[] {
    const out: PlayerScore[] = [];
    const obj = !!world.objective;
    for (const s of world.ships.values()) {
      const row: PlayerScore = {
        playerId: s.playerId, score: s.score, kills: s.kills, deaths: s.deaths, enemyKills: s.enemyKills,
        bounty: s.bounty, level: s.level,
      };
      // v0.3 M3: objective stats (world.objective.stats, keyed by playerId); non-zero fields only.
      if (obj) { const o = objStatsOf(world, s.playerId); if (o) row.obj = o; }
      out.push(row);
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  buildResult(world: World): MatchResult {
    const scores = this.scores(world);
    const teams = world.config.mode === 'teams';
    const gameType = gameTypeOf(world.config);
    const subMode = subModeOf(world.config);
    if (world.dungeon) {
      // v0.3 M4 (§4.8): the run's outcome decides the winner (the party on a clear / extraction), and RiftResult
      // carries every pilot's status. The team score is the party's summed ship score.
      const rift = buildRiftResult(world, this.riftLeavers, scores)!;
      const teamScores = teams ? new Array<number>(Math.max(1, world.config.teamCount)).fill(0) : [];
      for (const s of world.ships.values()) if (s.team >= 0 && s.team < teamScores.length) teamScores[s.team] += s.score;
      const outcome = riftOutcomeOf(world.dungeon);
      return {
        winnerTeam: riftWinner(outcome), winnerPlayerId: 0, teamScores, scores,
        awards: this.awards(scores, world, rift), gameType, subMode, rift,
      };
    }
    if (isObjectiveSubMode(subMode) || world.objective) {
      // fix #7 (§5.7): objective results come from the sim's objective points ONLY — never from kills or ship
      // score, not even when nobody scored. An early /end goes by points (FFA hot point: playerPoints); a tie is a draw.
      const objective = buildObjectiveResult(world, (pid) => this.nameOf(pid));
      const teamScores = teams ? objectiveTeamPoints(world) : [];
      const { winnerTeam, winnerPlayerId } = objectiveWinner(world, teamScores, objective?.playerPoints ?? []);
      const result: MatchResult = {
        winnerTeam, winnerPlayerId, teamScores, scores, awards: this.awards(scores, world), gameType, subMode,
      };
      if (objective) result.objective = objective;
      return result;
    }
    // Deathmatch: team score = the sum of member scores (the sim's own sums when it kept them).
    let teamScores: number[] = [];
    if (teams) {
      teamScores = new Array(world.config.teamCount).fill(0);
      for (const s of world.ships.values()) if (s.team >= 0 && s.team < teamScores.length) teamScores[s.team] += s.score;
      if (world.match.teamScores.length === teamScores.length) {
        const simSum = world.match.teamScores.reduce((a, b) => a + b, 0);
        if (simSum > 0) teamScores = world.match.teamScores.slice();
      }
    }
    let winnerTeam: TeamId = -1, winnerPlayerId: PlayerId = 0;
    if (world.match.phase === 'ended' && (world.match.winnerTeam >= 0 || world.match.winnerPlayerId)) {
      winnerTeam = world.match.winnerTeam;
      winnerPlayerId = world.match.winnerPlayerId;
    } else if (teams) {
      let best = -1, bestV = -Infinity, tie = false;
      teamScores.forEach((v, i) => { if (v > bestV) { bestV = v; best = i; tie = false; } else if (v === bestV) tie = true; });
      winnerTeam = tie ? -1 : best;
    } else if (scores.length && (scores.length === 1 || scores[0].score > scores[1].score)) {
      winnerPlayerId = scores[0].playerId;
    }
    return { winnerTeam, winnerPlayerId, teamScores, scores, awards: this.awards(scores, world), gameType, subMode };
  }

  private awards(scores: PlayerScore[], world: World, rift?: MatchResult['rift']): MatchResult['awards'] {
    // v0.3 M3 (§5.7): objective awards first (Flag Runner / Goalkeeper / Carrier Killer; Anchor / Point Breaker /
    // King of the Hill), then the classic ones fill up to 5. v0.3 M4 (§4.8): a rift leads with Delver and Treasure
    // Hunter, then Exterminator, Field Medic, Battle Station (no PvP awards: the party is one team).
    const out: MatchResult['awards'] = rift
      ? riftAwards(rift, scores, this.riftChests)
      : objectiveAwards(world, scores.map((s) => s.playerId)).slice(0, 5);
    const top = <T>(items: T[], val: (t: T) => number): T | null => {
      let b: T | null = null, bv = 0;
      for (const it of items) { const v = val(it); if (v > bv) { bv = v; b = it; } }
      return b;
    };
    const k = rift ? null : top(scores, (s) => s.kills);
    if (k) out.push({ title: 'Top Gun', playerId: k.playerId, value: `${k.kills} kills` });
    const e = top(scores, (s) => s.enemyKills);
    if (e) out.push({ title: 'Exterminator', playerId: e.playerId, value: `${e.enemyKills} swarm kills` });
    const bh = rift ? null : top([...this.bountyClaimed], ([, v]) => v);
    if (bh) out.push({ title: 'Big Game Hunter', playerId: bh[0], value: `${bh[1]}-point bounty` });
    const heals: [PlayerId, number][] = [];
    for (const s of world.ships.values()) heals.push([s.playerId, s.skillState.healDone ?? 0]);
    const hm = top(heals, ([, v]) => v);
    if (hm && hm[1] >= 1) out.push({ title: 'Field Medic', playerId: hm[0], value: `${Math.round(hm[1])} healed` });
    const bs = top([...this.hostTicks], ([, v]) => v);
    if (bs && bs[1] >= TICK_RATE) out.push({ title: 'Battle Station', playerId: bs[0], value: `${Math.round(bs[1] / TICK_RATE)} turret-seconds hosted` });
    const tt = top([...this.turretTicks], ([, v]) => v);
    if (tt && tt[1] >= TICK_RATE && out.length < 5) out.push({ title: 'Most Stacked', playerId: tt[0], value: `${Math.round(tt[1] / TICK_RATE)} s as a turret` });
    const gx = top([...this.gemXp], ([, v]) => v);
    if (gx && out.length < 5) out.push({ title: 'Gem Hoarder', playerId: gx[0], value: `${Math.round(gx[1])} XP collected` });
    const lv = top(scores, (s) => s.level);
    if (lv && out.length < 5) out.push({ title: 'Ascended', playerId: lv.playerId, value: `level ${lv.level}` });
    return out.slice(0, 5);
  }

  // ------------------------------------------------------------------------------------------
  // Tick
  // ------------------------------------------------------------------------------------------

  tick(): void {
    this.tickCount++;
    if (this.humanCount === 0) this.emptyTicks++; else this.emptyTicks = 0;
    if (this.customized && this.locked && this.emptyTicks > 0 && this.phase === 'lobby') {
      // A built-in room emptied out: undo the last host's customizations for whoever comes next.
      this.customized = false;
      this.applySettings(this.baseSettings);
      this.host.log(`[${this.settings.name}] settings reset to defaults (room empty)`);
    }
    switch (this.phase) {
      case 'lobby': this.tickLobby(); break;
      case 'countdown':
        if (this.emptyTicks >= BOTS_ONLY_ABORT_SEC * TICK_RATE) { this.backToLobby(); break; } // bots-only abort
        if (--this.countdownTicks <= 0) this.beginPlaying();
        else {
          const sec = Math.ceil(this.countdownTicks / TICK_RATE);
          if (sec !== this.lastCountdownSent) { this.lastCountdownSent = sec; this.dirty = true; }
        }
        break;
      case 'playing': this.tickPlaying(); break;
      case 'results':
        if (--this.resultsTicks <= 0) this.backToLobby();
        else if (this.resultsTicks % TICK_RATE === 0) this.dirty = true;
        break;
    }
    this.runBotChats();
  }

  private tickLobby(): void {
    if (this.pendingStart) {
      // Waiting for a free playing slot (MAX_PLAYING_ROOMS): re-check once a second while someone is here.
      if (this.humanCount === 0) { this.pendingStart = false; this.host.roomsChanged(); }
      else if (this.tickCount % TICK_RATE === 0) this.startCountdown();
      return;
    }
    if (this.host.local) return;
    const ready = this.players.some((p) => !p.isBot && p.ready);
    if (!ready) {
      if (this.autoStartTicks > 0) { this.autoStartTicks = 0; this.host.roomsChanged(); } // "Starting in" goes away
      return;
    }
    this.autoStartTicks++;
    if (this.autoStartTicks === 1) this.host.roomsChanged(); // the room list shows "Starting in 0:23"
    if (this.autoStartTicks === (AUTO_START_SEC - 10) * TICK_RATE) this.system('Auto-starting in 10 s...');
    if (this.autoStartTicks >= AUTO_START_SEC * TICK_RATE) this.startCountdown();
  }

  private tickPlaying(): void {
    const sim = this.sim;
    if (!sim) { this.backToLobby(); return; }
    if (this.emptyTicks >= BOTS_ONLY_ABORT_SEC * TICK_RATE) {
      // Bots-only abort (§3.6): no humans (spectators count) for BOTS_ONLY_ABORT_SEC — stop simulating and go
      // back to the lobby silently (no results). A grace period covers page reloads; this also stops the
      // offline sim a pilot left behind by going back to Command.
      this.host.log(`[${this.settings.name}] match stopped: no humans for ${BOTS_ONLY_ABORT_SEC} s`);
      this.backToLobby();
      return;
    }
    const world = sim.world;
    this.applyQueuedChanges(world);
    this.runRejoins(world);
    // bots
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.isBot || !p.inMatch) continue;
      const sid = world.shipsByPlayer.get(p.playerId);
      const ship = sid ? world.ships.get(sid) : undefined;
      if (!ship) continue;
      const brain = this.brainFor(p);
      sim.setInput(p.playerId, brain.think(world, ship));
      if (ship.offers.length && (this.tickCount + i * 7) % 30 === 0) {
        const offer = ship.offers[0];
        let idx = brain.chooseUpgrade(world, ship, offer);
        if (!(idx >= 0 && idx < offer.length)) idx = 0;
        sim.chooseUpgrade(p.playerId, Math.floor(idx), undefined); // bots always answer the current offer
      }
    }
    sim.step();
    const evs = sim.drainEvents();
    let floorStartAt = -1;
    if (evs.length) {
      const base = this.pendingEvents.length;
      for (const ev of evs) this.pendingEvents.push(ev);
      for (let i = evs.length - 1; i >= 0; i--) if (evs[i].t === 'floorStart') { floorStartAt = base + i; break; }
      this.noteEvents(world, evs);
    }
    this.spillCounted.clear(); // only ever meant for the spill removePlayer emitted before this step
    if (floorStartAt >= 0 && world.dungeon) this.onFloorStart(world, floorStartAt);
    for (const s of world.ships.values()) {
      if (s.attachedTo) this.turretTicks.set(s.playerId, (this.turretTicks.get(s.playerId) ?? 0) + 1);
      if (s.turrets.length) this.hostTicks.set(s.playerId, (this.hostTicks.get(s.playerId) ?? 0) + s.turrets.length);
    }
    // occasional team banter
    if (this.settings.mode === 'teams' && this.tickCount % (60 * TICK_RATE) === 0 && Math.random() < 0.15) {
      const bots = this.players.filter((p) => p.isBot && p.inMatch);
      if (bots.length) this.queueBotChat(bots[Math.floor(Math.random() * bots.length)], TEAM_BANTER[Math.floor(Math.random() * TEAM_BANTER.length)], 'team', 0);
    }

    if (++this.snapCounter >= this.host.snapshotEvery || this.forceSnapshot) {
      this.snapCounter = 0;
      this.forceSnapshot = false;
      this.sendSnapshots(world);
    }
    if (++this.scoreCounter >= TICK_RATE) {
      this.scoreCounter = 0;
      const msg: ServerMsg = { type: 'scores', scores: this.scores(world) };
      for (const p of this.players) p.user?.sink.sendMsg(msg);
    }
    this.tickErrors = 0;
    if (world.match.phase === 'ended') this.enterResults();
  }

  private sendSnapshots(world: World): void {
    let any = false;
    for (const p of this.players) if (p.user && p.watching) { any = true; break; }
    if (!any) { this.pendingEvents = []; return; }
    this.builder.prepare(world, this.pendingEvents);
    this.pendingEvents = [];
    for (const p of this.players) {
      if (!p.user || !p.watching) continue;
      // An extracted rift pilot watches the rest of the run: spectator snapshots (their ship stays for the scoreboard).
      p.user.sink.sendSnapshot(this.builder.build({ playerId: p.playerId, spectator: !p.inMatch || p.extracted }));
    }
  }

  // ------------------------------------------------------------------------------------------
  // v0.3 M4: the rift room layer (§4.8)
  // ------------------------------------------------------------------------------------------

  /**
   * A `floorStart` event was drained (at index `at` of pendingEvents): the whole rift moved to a new floor, same
   * Sim, ship ids unchanged. In order:
   *  1. drop the positional events queued before it (they belong to the old floor's map; globals stay for the feed);
   *  2. send {type:'floorStart', floor, tick} to every watcher — BEFORE any snapshot of the new floor;
   *  3. brain.onFloorChange() for every bot (paths, goals and targets point into the old map);
   *  4. apply queued class swaps (setShipClass respawns the ship with the new class at the entrance);
   *  5. add pending drop-ins in join order while the party has a seat — syncBots replaces a bot — then send them
   *     matchStart (which names the new floor);
   *  6. force a snapshot this tick.
   */
  private onFloorStart(world: World, at: number): void {
    const d = world.dungeon;
    const sim = this.sim;
    if (!d || !sim) return;
    const floor = d.floor;
    // 1.
    const evs = this.pendingEvents;
    const kept: GameEvent[] = [];
    for (let i = 0; i < evs.length; i++) if (i >= at || GLOBAL_EVENT_TYPES.has(evs[i].t)) kept.push(evs[i]);
    this.pendingEvents = kept;
    // 2.
    const msg: ServerMsg = { type: 'floorStart', floor, tick: world.tick };
    for (const p of this.players) if (p.user && p.watching) p.user.sink.sendMsg(msg);
    // 3.
    for (const p of this.players) {
      if (!p.isBot || !p.brain) continue;
      const brain = p.brain;
      try { brain.onFloorChange?.(); } catch (e) { this.host.log(`[${this.settings.name}] onFloorChange failed: ${(e as Error)?.message ?? e}`); }
    }
    // 4.
    for (const p of this.players) {
      if (p.isBot || !p.inMatch || p.extracted) continue;
      const ship = this.shipOf(p);
      if (ship && ship.shipClass !== p.shipClass) {
        const cls = p.shipClass;
        this.safeSim(() => sim.setShipClass(p.playerId, cls));
        this.tell(p, `Floor ${floor}: you fly the ${SHIP_CLASSES[cls].name} now.`);
      }
      p.pendingClass = null;
    }
    // 5.
    if (floor <= d.floorsTotal) {
      const pending = this.players.filter((p) => !p.isBot && p.pendingDropIn && !p.inMatch && !p.extracted && p.user)
        .sort((a, b) => a.joinOrder - b.joinOrder);
      let flying = 0;
      for (const p of this.players) if (!p.isBot && p.inMatch) flying++;
      let added = 0;
      for (const p of pending) {
        if (flying >= this.settings.maxPlayers) { this.tell(p, RIFT_PARTY_FULL_MSG); continue; }
        p.pendingDropIn = false;
        p.spectating = false;
        p.team = 0;
        p.pendingTeam = null;
        p.rejoinTick = 0;
        flying++;
        added++;
        this.addToSim(p);
        this.syncBots(); // now seated: a bot gives up its seat (removeOneBot → sim.removePlayer)
        this.sendMatchStart(p);
        this.system(`${p.name} joined the party on floor ${floor}.`);
      }
      if (added) { this.rebalanceBots(); this.dirty = true; this.host.roomsChanged(); }
    }
    // 6.
    this.forceSnapshot = true;
    this.dirty = true;
  }

  /** A pilot leaves the running rift (leave room / spectate): remembered for RiftResult ('left'). Humans only. */
  private noteRiftLeaver(p: RoomPlayer): void {
    const w = this.world;
    const d = w?.dungeon;
    if (!d || p.isBot || !p.inMatch) return;
    const ship = this.shipOf(p);
    const prev = this.riftLeavers.get(p.playerId);
    this.riftLeavers.set(p.playerId, {
      floor: Math.max(prev?.floor ?? 0, d.floor), deaths: (prev?.deaths ?? 0) + (ship ? ship.deaths : 0),
    });
  }

  private noteEvents(world: World, evs: GameEvent[]): void {
    const tick = world.tick;
    const canNote = (): boolean => tick - this.lastNoteTick >= NOTE_GAP_TICKS;
    const nameOf = (pid: PlayerId): string => this.player(pid)?.name ?? '???';
    /** Caches secured per pilot in this batch (lootSecured precedes its 'extract'). */
    let secured: Map<PlayerId, number> | null = null;
    let extractedNow = false;
    for (const ev of evs) {
      switch (ev.t) {
        case 'gem': if (ev.playerId) this.gemXp.set(ev.playerId, (this.gemXp.get(ev.playerId) ?? 0) + ev.value); break;
        case 'shipDeath': {
          if (ev.cause !== 'player' || !ev.killerPlayerId) break;
          if (ev.bounty > (this.bountyClaimed.get(ev.killerPlayerId) ?? 0)) this.bountyClaimed.set(ev.killerPlayerId, ev.bounty);
          const ksid = world.shipsByPlayer.get(ev.killerPlayerId);
          const killer = ksid ? world.ships.get(ksid) : undefined;
          if (killer && killer.killStreak > 0 && killer.killStreak % 5 === 0 && canNote()) {
            this.lastNoteTick = tick;
            this.system(`${nameOf(ev.killerPlayerId)} is on a ${killer.killStreak}-kill streak!`);
          } else if (ev.bounty >= 60 && canNote()) {
            this.lastNoteTick = tick;
            this.system(`${nameOf(ev.killerPlayerId)} claimed ${nameOf(ev.playerId)}'s ${ev.bounty}-point bounty!`);
          }
          break;
        }
        case 'waveStart':
          if (ev.boss) { this.lastNoteTick = tick; this.system(`Wave ${ev.wave}: a Hive is inbound!`); }
          break;
        case 'levelUp':
          if (ev.level % 10 === 0 && canNote()) { this.lastNoteTick = tick; this.system(`${nameOf(ev.playerId)} reached level ${ev.level}.`); }
          break;
        // --- v0.3 M2 loot (§7.3.4): secured tokens go into the bank, spills count as lost ---
        case 'lootSecured': {
          if (Array.isArray(ev.tokens) && ev.tokens.length) {
            (secured ??= new Map()).set(ev.playerId, (secured.get(ev.playerId) ?? 0) + ev.tokens.length);
          }
          const p = this.player(ev.playerId);
          if (!p || p.isBot || !Array.isArray(ev.tokens) || !ev.tokens.length) break;
          const key = this.profileKeyOf(p);
          const bank = this.bank.get(key);
          if (bank) bank.push(...ev.tokens); else this.bank.set(key, ev.tokens.slice());
          break;
        }
        case 'lootSpill': {
          if (this.spillCounted.delete(ev.playerId)) break; // counted by the leave grant (a quick rejoin is back already)
          const p = this.player(ev.playerId);
          if (!p || p.isBot || !(ev.count > 0)) break; // a leaver's spill lands after they left: not counted twice
          const key = this.profileKeyOf(p);
          this.spills.set(key, (this.spills.get(key) ?? 0) + ev.count);
          if ((ev.count >= LOOT_BEACON_COUNT || ev.best >= LOOT_BEACON_RARITY) && this.canLootNote(tick)) {
            const best = ev.best >= LOOT_BEACON_RARITY ? `, ${/^[AEIOU]/.test(RARITY_NAMES[ev.best]) ? 'an' : 'a'} ${RARITY_NAMES[ev.best]} among them` : '';
            this.system(`${p.name} spilled ${ev.count} cache${ev.count === 1 ? '' : 's'}${best}! Grab them.`);
          }
          break;
        }
        case 'lootDrop':
          if (ev.rarity >= LOOT_BEACON_RARITY && this.canLootNote(tick)) this.system(`${cacheLabel(ev.rarity, ev.set)} dropped!`);
          break;
        // --- v0.3 M3 objectives (§5.7): flags, zone / hot point captures, the hot point moving, overtime, sudden death ---
        case 'objective': {
          const line = this.objAnnouncer.line(world, ev, (pid) => this.nameOf(pid));
          if (line) this.system(line);
          break;
        }
        // --- v0.3 M4 rift (§4.8): floor starts, extraction (→ spectator), chests, the Matriarch, instability ---
        case 'floorStart':
          this.system(floorLine(world, ev.floor));
          break;
        case 'extract': {
          const p = this.player(ev.playerId);
          if (!p) break;
          if (!p.isBot && !p.extracted) {
            // The ship stays in the world for the scoreboard; the pilot now gets spectator snapshots (sendSnapshots).
            p.extracted = true;
            p.pendingClass = null;
            if (p.user) for (const k of Room.rejoinKeys(p.user)) this.riftExtractedKeys.add(k);
            this.builder.resetSpectator(p.playerId);
            extractedNow = true;
          }
          const floor = world.dungeon?.extracted.find((e) => e.playerId === ev.playerId)?.floor ?? world.dungeon?.floor ?? 0;
          const n = secured?.get(ev.playerId) ?? 0;
          this.system(extractLine(p.name, floor, n));
          if (!p.isBot) this.tell(p, `${n > 0 ? `${n} cache${n === 1 ? '' : 's'} banked. ` : ''}${RIFT_EXTRACTED_MSG}`);
          break;
        }
        case 'chestOpen': {
          // Treasure Hunter is a pilot's award: a bot opening a chest (bots-only stretches) is not counted.
          const cp = ev.playerId ? this.player(ev.playerId) : undefined;
          if (cp && !cp.isBot) this.riftChests.set(ev.playerId, (this.riftChests.get(ev.playerId) ?? 0) + 1);
          break;
        }
        case 'bossIntro': case 'instability': {
          const line = this.riftAnnouncer.line(world, ev);
          if (line) this.system(line);
          break;
        }
        default: break;
      }
    }
    if (extractedNow) {
      this.updateLootMult(); // an extracted pilot no longer picks up loot (§6.4.6: humans flying)
      this.dirty = true;
      this.host.roomsChanged();
    }
  }

  /** Loot chat lines (epic+ drops, big spills) share their own small gap (LOOT_NOTE_GAP_TICKS). */
  private canLootNote(tick: number): boolean {
    if (tick - this.lastLootNoteTick < LOOT_NOTE_GAP_TICKS) return false;
    this.lastLootNoteTick = tick;
    return true;
  }

  /** Run a sim call from a message handler without letting one bad call kill the connection. */
  private safeSim(fn: () => void): void {
    try { fn(); } catch (e) { this.host.log(`[${this.settings.name}] sim call failed: ${(e as Error)?.message ?? e}`); }
  }

  /** Called by the Zone's run loop when tick() throws; aborts a match that keeps failing. */
  onTickError(e: unknown): void {
    this.host.log(`[${this.settings.name}] tick error: ${(e as Error)?.stack ?? e}`);
    if (this.phase === 'playing' && ++this.tickErrors >= MAX_TICK_ERRORS) {
      this.system('Match aborted (server error).');
      this.backToLobby();
    }
  }
}
