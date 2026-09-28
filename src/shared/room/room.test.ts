import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';

vi.mock('../sim/Sim', async () => {
  const { createWorld } = await import('../sim/world');
  const { SHIP_CLASSES } = await import('../data/ships');
  const { emptyInput } = await import('../types');
  type AnyWorld = import('../types').World;
  class FakeSim {
    readonly world: AnyWorld;
    static last: FakeSim | null = null;
    inputs = new Map<number, unknown>();
    /** Respawns (like the real Sim.spawnShip: alive, full energy, spawn protection) per player, with the tick. */
    spawns: { pid: number; tick: number }[] = [];
    picks: [number, number, number | undefined][] = [];
    constructor(config: import('../types').SimConfig) {
      const cols = 200, rows = 200;
      const map = {
        seed: config.mapSeed, teamCount: config.teamCount, width: cols * 32, height: rows * 32, tileSize: 32, cols, rows,
        tiles: new Uint8Array(cols * rows), spawns: [],
      };
      this.world = createWorld(config, map);
      // v0.3 M4: a dungeon config gets a minimal RiftState on floor 1 (like the real createRiftState).
      if (config.gameType === 'dungeon') {
        this.world.dungeon = {
          floor: 1, floorsTotal: config.floors ?? 6, floorStartTick: 0, rooms: [], portal: 0, departTick: 0,
          parties: [{ team: 0, lives: 10, status: 'active', anchorX: 1000, anchorY: 1000, seen: 1, roomsCleared: 0, bossesKilled: 0, deepestFloor: 1 }],
          extractOpen: false, victoryTick: 0, bossId: 0, bossPhase: 0, pendingFloor: 0, outcome: 'running', extracted: [], instabilityTick: 0,
        };
      }
      FakeSim.last = this;
    }
    /**
     * v0.3 M4 test double of Sim.enterFloor (§4.7): the rift moves to `floor` in THIS step — ship ids unchanged,
     * every non-extracted ship respawned at the entrance — and emits floorStart. `before` = events emitted earlier
     * in the same step (e.g. positional ones from the old floor).
     */
    floorSwap(floor: number, before: import('../types').GameEvent[] = []): void {
      const w = this.world, d = w.dungeon!;
      for (const e of before) w.events.push(e);
      d.floor = floor;
      d.floorStartTick = w.tick;
      for (const p of d.parties) p.deepestFloor = Math.max(p.deepestFloor, floor);
      for (const s of w.ships.values()) {
        if (s.skillState.rOut) continue;
        s.skillState.rWait = 0;
        s.x = 1000; s.y = 1000;
        this.spawn(s);
      }
      w.events.push({ t: 'floorStart', floor });
    }
    addPlayer(o: import('../sim/Sim').AddPlayerOpts): number {
      const w = this.world;
      const id = w.nextId++;
      const stats = { ...SHIP_CLASSES[o.shipClass].base };
      w.ships.set(id, {
        id, playerId: o.playerId, name: o.name, team: w.config.mode === 'ffa' ? -1 : o.team, shipClass: o.shipClass, isBot: o.isBot,
        x: 1000, y: 1000, vx: 0, vy: 0, angle: 0, alive: true, respawnTick: 0, invulnUntilTick: 0,
        energy: stats.maxEnergy, stats, input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0, path: null,
        gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
        utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0, skillState: {},
        attachedTo: 0, turrets: [], xp: 0, level: 1, xpToNext: 10, offers: [], offerSerial: 0, upgrades: {}, autoState: {},
        kills: 0, deaths: 0, score: 0, bounty: 10, killStreak: 0, enemyKills: 0, lastDamagedBy: 0, lastDamagedTick: 0, flags: 0,
      });
      w.shipsByPlayer.set(o.playerId, id);
      return id;
    }
    removePlayer(pid: number): void { const id = this.world.shipsByPlayer.get(pid); if (id) { this.world.ships.delete(id); this.world.shipsByPlayer.delete(pid); } }
    // Like the real Sim, a team change respawns the ship.
    setPlayerTeam(pid: number, team: number): void { const s = this.ship(pid); if (s) { s.team = team; this.spawn(s); } }
    /** v0.3 Sim semantics: a LIVE ship in a running arena/warzone match swaps in place (no respawn); dead -> v0.2 respawn. */
    classSwaps: { pid: number; tick: number; inPlace: boolean }[] = [];
    setShipClass(pid: number, c: import('../types').ShipClassId): void {
      const s = this.ship(pid);
      if (!s) return;
      const inPlace = s.alive && this.world.config.gameType !== 'dungeon';
      this.classSwaps.push({ pid, tick: this.world.tick, inPlace });
      const frac = s.stats.maxEnergy > 0 ? s.energy / s.stats.maxEnergy : 1;
      s.shipClass = c;
      s.stats = { ...SHIP_CLASSES[c].base };
      if (inPlace) s.energy = frac * s.stats.maxEnergy;
      else this.spawn(s);
    }
    // fix #12: the v0.3 Sim API additions (M2 loot / M4 rift), as inert doubles.
    lootMult = 0;
    abandoned = false;
    setLootMult(mult: number): void { this.lootMult = mult; }
    takeCarried(pid: number): import('../types').CacheToken[] {
      const s = this.ship(pid);
      const out = s?.carried ?? [];
      if (s) s.carried = [];
      return out;
    }
    abandonRift(): void {
      const d = this.world.dungeon;
      if (!d) return;
      this.abandoned = true;
      if (d.outcome === 'running') d.outcome = 'abandoned';
    }
    setInput(pid: number, input: import('../types').InputState): void { this.inputs.set(pid, input); const s = this.ship(pid); if (s) s.lastInputSeq = input.seq; }
    chooseUpgrade(pid: number, index: number, offerId?: number): void { this.picks.push([pid, index, offerId]); }
    step(): void {
      this.world.tick++;
      for (const s of this.world.ships.values()) if (!s.alive && this.world.tick >= s.respawnTick) this.spawn(s);
    }
    private spawn(s: import('../types').Ship): void {
      s.alive = true; s.energy = s.stats.maxEnergy; s.invulnUntilTick = this.world.tick + 120;
      this.spawns.push({ pid: s.playerId, tick: this.world.tick });
    }
    drainEvents(): import('../types').GameEvent[] { const e = this.world.events; this.world.events = []; return e; }
    shipIdFor(pid: number): number { return this.world.shipsByPlayer.get(pid) ?? 0; }
    private ship(pid: number) { const id = this.world.shipsByPlayer.get(pid); return id ? this.world.ships.get(id) : undefined; }
  }
  return { Sim: FakeSim };
});

vi.mock('../ai/bots', async () => {
  const { emptyInput } = await import('../types');
  return {
    createBotBrain: () => ({ think: () => emptyInput(), chooseUpgrade: () => 0 }),
  };
});

// v0.3 M4: the rift views (SIM) as small doubles over the FakeSim's hand-built RiftState, so the room layer is tested
// on its own (the real buildRiftView / riftYou need a generated floor).
vi.mock('../sim/dungeon', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sim/dungeon')>();
  type W = import('../types').World;
  return {
    ...real,
    buildRiftView: vi.fn((w: W): import('../types').RiftView => {
      const d = w.dungeon!;
      return {
        floor: d.floor, floorsTotal: d.floorsTotal, biome: d.floor <= 3 ? 'hive' : 'prism',
        rooms: d.rooms.map((r) => r.state), chests: d.rooms.map((r) => r.chests), lives: d.parties.map((p) => p.lives),
        seen: d.parties.map((p) => p.seen), anchors: d.parties.flatMap((p) => [p.anchorX, p.anchorY]), portal: d.portal,
        departIn: 0, extractOpen: d.extractOpen, boss: null,
        waiting: [...w.ships.values()].filter((s) => s.skillState.rWait).map((s) => s.playerId), extracting: [],
        floorSec: (w.tick - d.floorStartTick) / 60,
      };
    }),
    riftYou: vi.fn((w: W, s: import('../types').Ship): import('../types').RiftYou => {
      const d = w.dungeon!;
      let follow = 0, best = Infinity;
      for (const o of w.ships.values()) if (o.alive && o.id !== s.id && o.playerId < best) { best = o.playerId; follow = o.id; }
      return {
        party: 0, lives: d.parties[0]?.lives ?? 0, waiting: !!s.skillState.rWait, extracted: !!s.skillState.rOut,
        extract: s.skillState.rExtract ?? 0, followId: s.skillState.rWait ? follow : 0,
      };
    }),
  };
});

// v0.3 M3: buildObjectiveView is a pass-through spy, so the objective room tests can swap in a view builder for
// their hand-built ObjectiveState (and count calls) without depending on OBJECTIVES internals.
vi.mock('../sim/objectives/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sim/objectives/index')>();
  return { ...real, buildObjectiveView: vi.fn(real.buildObjectiveView) };
});

import { COUNTDOWN_SEC, INTEREST_RADIUS, NO_TEAM, RESULTS_SEC, TICK_RATE } from '../constants';
import { TEAM_UNASSIGNED, type ClientMsg, type RoomSummary, type ServerMsg } from '../protocol';
import { SHIPFLAG_CLOAKED, type Snapshot } from '../types';
import { PROTOCOL_VERSION } from '../version';
import { Sim } from '../sim/Sim';
import {
  LOBBY_STATE_THROTTLE_TICKS, MAX_LOBBY_LIST, MAX_ROOMS_PER_ADDRESS, PRESENCE_BURST, Zone, type ClientSink, type ZoneConnection,
} from './Zone';
import { CLASS_QUEUED_MSG, EMPTY_MATCH_END_SEC } from './Room';
import {
  AUTO_START_SEC, NO_SEAT_MSG, START_WAIT_MSG, WATCH_SAME_NETWORK_MSG, type Room,
} from './Room';
import { LOCAL_MAX_CUSTOM_ROOMS, MAX_ROOMS } from './Zone';
import { houseRooms } from './houseRooms';
import {
  BOTS_ONLY_ABORT_SEC, MAX_PLAYING_ROOMS, ROOM_LIST_LIVE_SEC, SPECTATOR_SLOTS,
} from '../constants';
import { nameKey } from './util';
import { PATHS, SHIP_CLASSES } from '../data/ships';
import { teamName } from '../data/teams';
import type { AccountInfo } from '../protocol';
// v0.3 M2 loot wiring
import { LOOT_BEACON_RARITY, MAX_CARRIED } from '../constants';
import { CRATE_MIN_MATCH_SEC, CRATE_MIN_PLAYED_SEC, LOOT_MULT_SOLO, SHARDS_BASE } from '../data/loot';
import { decodeSnapshot, encodeSnapshot } from '../net/codec';
import { defaultProfile } from '../profile/profile';
import { botWardrobe } from '../profile/rolls';
import { LOOT_NOT_SAVED_MSG, ProfileService, type GrantEntry } from '../profile/service';
import { MemoryProfileStore, type ProfileStore } from '../profile/store';
import type { CacheToken, LootDrop } from '../types';
import { PROFILE_RETRY_SEC } from './Zone';
import type { RoomHost } from './user';
// v0.3 M3 objectives
import { SUB_MODES, objectiveTarget } from '../data/gameTypes';
import { buildObjectiveView } from '../sim/objectives/index';
import {
  SHIPFLAG_CARRIER,
  type FlagObjective, type GameEvent, type ObjectiveEventKind, type ObjectivePlayerStats, type ObjectiveState,
  type ObjectiveSubMode, type ObjectiveView, type SubMode, type World, type ZoneObjective,
} from '../types';
import type { RoomSettings } from '../protocol';
import { FLAG_NOTE_GAP_SEC, ZONE_NOTE_GAP_SEC } from './objective';

class FakeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  snaps: Snapshot[] = [];
  /** Arrival order across both channels ('snap' or the message type). */
  order: string[] = [];
  conn!: ZoneConnection;
  closedReason: string | null = null;
  close(reason: string): void { this.closedReason = reason; }
  sendMsg(m: ServerMsg): void { this.msgs.push(m); this.order.push(m.type); }
  sendSnapshot(s: Snapshot): void { this.snaps.push(s); this.order.push('snap'); }
  send(m: ClientMsg): void { this.conn.handle(m); }
  of<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }>[] {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
  last<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }> { const a = this.of(t); return a[a.length - 1]; }
  chatTexts(): string[] { return this.of('chat').map((c) => c.line.text); }
  get pid(): number { return this.last('welcome').playerId; }
}

function mkZone(local = false, rooms: ConstructorParameters<typeof Zone>[0]['defaultRooms'] = [
  { name: 'Main Arena', mode: 'teams', teamCount: 2, botFill: 12 },
  { name: 'Free-For-All', mode: 'ffa', botFill: 10 },
], blockSameNetworkWatch = false): Zone {
  return new Zone({ snapshotEvery: 3, defaultRooms: rooms, motd: 'hi', local, blockSameNetworkWatch });
}

function join(zone: Zone, name: string, account: AccountInfo | null = null): FakeClient {
  const c = new FakeClient();
  c.conn = zone.connect(c);
  c.conn.setAccount(account);
  c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: account ? 'tok' : undefined });
  return c;
}

const acct = (username: string, id = 'acc-' + username): AccountInfo => ({
  accountId: id, username, emailMasked: 'x***@y.z', createdAt: 1,
});

function roomId(c: FakeClient, name: string): string {
  const r = c.last('roomList').rooms.find((x: RoomSummary) => x.name === name);
  return r!.id;
}

function ticks(zone: Zone, n: number): void { for (let i = 0; i < n; i++) zone.tick(); }

function startPlaying(zone: Zone, c: FakeClient): void {
  c.send({ type: 'startMatch' });
  ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
}

const fakeSim = (): Sim & { world: import('../types').World } =>
  (Sim as unknown as { last: Sim & { world: import('../types').World } }).last;


/**
 * Back to the pre-M3 world (CTF / Zones / Hot Point not open) for tests that pin the rules for sub-modes that
 * aren't open yet; returns the undo. Those rules still guard escort / rival / coop.
 */
function preM3(): () => void {
  const subs = ['ctf', 'zones', 'hotpoint', 'coop'] as const;
  const was = subs.map((k) => SUB_MODES[k].ready);
  for (const k of subs) (SUB_MODES[k] as { ready: boolean }).ready = false;
  return () => subs.forEach((k, j) => { (SUB_MODES[k] as { ready: boolean }).ready = was[j]; });
}

/** The pre-M4 world (the Dungeon Runner's co-op opened in 0.3.0): pins the "isn't open yet" paths for a not-ready type. */
function preM4(): void {
  const was = SUB_MODES.coop.ready;
  (SUB_MODES.coop as { ready: boolean }).ready = false;
  onTestFinished(() => { (SUB_MODES.coop as { ready: boolean }).ready = was; });
}

describe('zone lobby', () => {
  it('welcomes, sends room list, lobby state, history; rejects bad protocol', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    expect(a.msgs[0].type).toBe('welcome');
    expect(a.last('welcome').motd).toBe('hi');
    expect(a.last('roomList').rooms).toHaveLength(2);
    const rs = a.last('roomState');
    expect(rs.roomId).toBeNull();
    expect(rs.players.map((p) => p.name)).toEqual(['Ace']);
    expect(a.of('chatHistory')).toHaveLength(1);

    const bad = new FakeClient();
    bad.conn = zone.connect(bad);
    bad.send({ type: 'hello', name: 'x', protocol: 999, version: '' });
    expect(bad.msgs[0].type).toBe('error');
    expect(bad.of('welcome')).toHaveLength(0);
  });

  it('dedupes and sanitizes names', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'ace');
    const c = join(zone, '  \u0007Ace\n ');
    const d = join(zone, 'ABCDEFGHIJKLMNOPQRSTUV');
    expect(a.last('welcome').name).toBe('Ace');
    expect(b.last('welcome').name).toBe('ace2');
    expect(c.last('welcome').name).toBe('Ace3');
    expect(d.last('welcome').name.length).toBeLessThanOrEqual(16);
    expect(new Set([a.pid, b.pid, c.pid, d.pid]).size).toBe(4);
    const e = join(zone, '');
    expect(e.last('welcome').name).toBe('Pilot');
  });

  it('zone chat broadcasts to lobby users, rate-limits, and handles commands', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    expect(a.chatTexts().some((t) => t.includes('Bee entered'))).toBe(true);
    a.send({ type: 'chat', channel: 'all', text: 'hello zone' });
    expect(b.of('chat').some((c) => c.line.text === 'hello zone' && c.line.fromName === 'Ace')).toBe(true);
    for (let i = 0; i < 10; i++) a.send({ type: 'chat', channel: 'all', text: `spam${i}` });
    const got = b.of('chat').filter((c) => c.line.text.startsWith('spam')).length;
    expect(got).toBeLessThanOrEqual(4);
    b.send({ type: 'chat', channel: 'all', text: '/help' });
    expect(b.chatTexts().some((t) => t.includes('Zone commands'))).toBe(true);
    b.send({ type: 'chat', channel: 'all', text: '/name Buzz' });
    expect(b.last('welcome').name).toBe('Buzz');
    // a newcomer gets history
    const c = join(zone, 'Cee');
    expect(c.last('chatHistory').lines.some((l) => l.text === 'hello zone')).toBe(true);
  });

  it('createRoom clamps settings and closes empty user rooms after 60s', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'createRoom', settings: { name: 'Mine', teamCount: 99, maxPlayers: 500, botFill: 400, matchMinutes: 0 } });
    const rs = a.last('roomState');
    expect(rs.roomId).not.toBeNull();
    expect(rs.settings.teamCount).toBe(8);
    expect(rs.settings.maxPlayers).toBe(32);
    expect(rs.settings.botFill).toBe(32);
    expect(rs.settings.matchMinutes).toBe(1);
    expect(rs.players.filter((p) => p.isBot)).toHaveLength(31);
    a.send({ type: 'leaveRoom' });
    expect(a.last('roomState').roomId).toBeNull();
    ticks(zone, 61 * TICK_RATE);
    expect(a.last('roomList').rooms.map((r) => r.name)).not.toContain('Mine');
    expect(a.last('roomList').rooms).toHaveLength(2);
  });
});

describe('room', () => {
  let zone: Zone;
  let a: FakeClient;
  beforeEach(() => {
    zone = mkZone();
    a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
  });

  it('fills bots, removes one per human, balances teams, host = first human', () => {
    let rs = a.last('roomState');
    expect(rs.players).toHaveLength(12);
    expect(rs.players.filter((p) => !p.isBot)).toHaveLength(1);
    expect(rs.hostPlayerId).toBe(a.pid);
    const me = rs.players.find((p) => p.playerId === a.pid)!;
    expect(me.team).toBe(TEAM_UNASSIGNED);
    a.send({ type: 'setTeam', team: 0 });
    rs = a.last('roomState');
    const counts = [0, 0];
    for (const p of rs.players) if (p.team >= 0) counts[p.team]++;
    expect(Math.abs(counts[0] - counts[1])).toBeLessThanOrEqual(1);

    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    rs = b.last('roomState');
    expect(rs.players).toHaveLength(12);
    expect(rs.players.filter((p) => p.isBot)).toHaveLength(10);
    expect(rs.players.every((p) => !p.isBot || p.ready)).toBe(true);
    expect(new Set(rs.players.map((p) => p.name.toLowerCase())).size).toBe(12);

    a.send({ type: 'leaveRoom' });
    rs = b.last('roomState');
    expect(rs.hostPlayerId).toBe(b.pid);
    expect(rs.players.filter((p) => p.isBot)).toHaveLength(11);
  });

  it('spectators do not count toward bot fill', () => {
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(a.last('roomState').players.filter((p) => p.isBot)).toHaveLength(12);
  });

  it("a new room's bot fill never deals a callsign twice ('Echo-7' ends in a digit; the room is not registered yet)", () => {
    // A constant draw of 0.66 picks index 32 of the 49 callsigns ('Echo-7') first. The old digit-stripping pool check
    // kept offering it and the Zone could not see the unregistered room's roster, so every bot came out 'Echo-7'.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.66);
    let z: Zone;
    try {
      z = mkZone(false, [{ name: 'Dup Test', mode: 'teams', teamCount: 2, botFill: 12 }]);
    } finally {
      spy.mockRestore();
    }
    const c = join(z, 'Cee');
    c.send({ type: 'joinRoom', roomId: roomId(c, 'Dup Test') });
    const names = c.last('roomState').players.map((p) => nameKey(p.name));
    expect(names).toHaveLength(12);
    expect(new Set(names).size).toBe(12);
    expect(names.filter((n) => n.startsWith('echo-7')).length).toBeLessThanOrEqual(1);
  });

  it('room chat, team chat via //, and commands', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let t = Date.now();
    const tick = () => { t += 1100; vi.setSystemTime(t); };
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    b.send({ type: 'setTeam', team: 1 });
    tick(); a.send({ type: 'chat', channel: 'all', text: 'hi room' });
    expect(b.chatTexts()).toContain('hi room');
    tick(); a.send({ type: 'chat', channel: 'all', text: '//secret plan' });
    expect(b.chatTexts()).not.toContain('secret plan');
    expect(a.chatTexts()).toContain('secret plan');
    // commands
    tick(); a.send({ type: 'chat', channel: 'all', text: '/class tech' });
    expect(a.last('roomState').players.find((p) => p.playerId === a.pid)!.shipClass).toBe('tech');
    tick(); a.send({ type: 'chat', channel: 'all', text: '/ship Artificer' });
    expect(a.last('roomState').players.find((p) => p.playerId === a.pid)!.shipClass).toBe('engineer');
    tick(); a.send({ type: 'setShip', shipClass: 'striker' as never });
    expect(a.last('roomState').players.find((p) => p.playerId === a.pid)!.shipClass).toBe('engineer');
    tick(); a.send({ type: 'chat', channel: 'all', text: '/team 2' });
    expect(a.last('roomState').players.find((p) => p.playerId === a.pid)!.team).toBe(1);
    tick(); b.send({ type: 'chat', channel: 'all', text: '/bots 4' });
    expect(b.chatTexts().some((t) => t.includes('host-only'))).toBe(true);
    tick(); a.send({ type: 'chat', channel: 'all', text: '/bots 4' });
    expect(a.last('roomState').players.filter((p) => p.isBot)).toHaveLength(2);
    tick(); a.send({ type: 'chat', channel: 'all', text: '/mode ffa' });
    let rs = a.last('roomState');
    expect(rs.settings.mode).toBe('ffa');
    expect(rs.players.every((p) => p.team === NO_TEAM)).toBe(true);
    tick(); a.send({ type: 'chat', channel: 'all', text: '/mode teams 4' });
    rs = a.last('roomState');
    expect(rs.settings.teamCount).toBe(4);
    tick(); a.send({ type: 'chat', channel: 'all', text: '/skill hard' });
    expect(a.last('roomState').settings.botSkill).toBe('hard');
    tick(); a.send({ type: 'chat', channel: 'all', text: '/pve 0' }); // Warzone swarm is 1-3
    expect(a.last('roomState').settings.pveIntensity).toBe(2);
    expect(a.chatTexts().some((t) => t.startsWith('Usage: /pve 1-3'))).toBe(true);
    tick(); a.send({ type: 'chat', channel: 'all', text: '/pve 3' });
    expect(a.last('roomState').settings.pveIntensity).toBe(3);
    tick(); a.send({ type: 'chat', channel: 'all', text: '/name Zed' });
    expect(a.last('roomState').players.find((p) => p.playerId === a.pid)!.name).toBe('Zed');
    tick(); a.send({ type: 'chat', channel: 'all', text: '/leave' });
    expect(a.last('roomState').roomId).toBeNull();
    vi.useRealTimers();
  });

  it('phases: lobby -> countdown -> playing -> results -> lobby', () => {
    a.send({ type: 'setTeam', team: 0 });
    a.send({ type: 'ready', ready: true });
    a.send({ type: 'startMatch' });
    expect(a.last('roomState').phase).toBe('countdown');
    expect(a.last('roomState').countdown).toBe(COUNTDOWN_SEC);
    ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
    expect(a.last('roomState').phase).toBe('playing');
    const ms = a.last('matchStart');
    expect(ms.yourShipId).toBeGreaterThan(0);
    expect(ms.snapshotEvery).toBe(3);
    const world = fakeSim().world;
    expect(world.ships.size).toBe(12);
    ticks(zone, 60);
    expect(a.snaps.length).toBeGreaterThanOrEqual(19);
    expect(a.snaps[a.snaps.length - 1].you!.shipId).toBe(ms.yourShipId);
    expect(a.of('scores').length).toBeGreaterThanOrEqual(1);
    // input reaches the sim and is acked
    a.send({ type: 'input', input: { seq: 42, moveX: 5, moveY: 0, aim: 0, aimDist: 300, primary: true, secondary: false, mobility: false, utility: false, afterburner: false, attach: false, attachTarget: 0, detach: false } });
    ticks(zone, 3);
    expect(a.snaps[a.snaps.length - 1].ackSeq).toBe(42);
    // end
    world.match.phase = 'ended';
    world.ships.get(ms.yourShipId)!.kills = 3;
    world.ships.get(ms.yourShipId)!.score = 50;
    zone.tick();
    expect(a.last('roomState').phase).toBe('results');
    const res = a.last('matchEnd').result;
    expect(res.scores.length).toBe(12);
    expect(res.awards.find((x) => x.title === 'Top Gun')!.playerId).toBe(a.pid);
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    const rs = a.last('roomState');
    expect(rs.phase).toBe('lobby');
    expect(rs.players.find((p) => p.playerId === a.pid)!.ready).toBe(false);
    expect(rs.players.find((p) => p.playerId === a.pid)!.team).toBe(0);
  });

  it('/end forces results; drop-in joinMatch; unassigned humans auto-balanced', () => {
    startPlaying(zone, a);
    const me = a.last('roomState').players.find((p) => p.playerId === a.pid)!;
    expect(me.team).toBeGreaterThanOrEqual(0);
    expect(me.inMatch).toBe(true);
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    expect(b.last('roomState').phase).toBe('playing');
    expect(b.of('matchStart')).toHaveLength(0);
    ticks(zone, 6);
    expect(b.snaps).toHaveLength(0);
    b.send({ type: 'joinMatch' });
    expect(b.last('matchStart').yourShipId).toBeGreaterThan(0);
    expect(fakeSim().world.ships.size).toBe(12); // a bot made room for Bee
    ticks(zone, 6);
    expect(b.snaps.length).toBeGreaterThan(0);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(a.last('roomState').phase).toBe('results');
    expect(b.of('matchEnd')).toHaveLength(1);
  });

  it('auto-starts after 20 s with a ready human (server mode only)', () => {
    a.send({ type: 'ready', ready: true });
    ticks(zone, 20 * TICK_RATE);
    expect(['countdown', 'playing']).toContain(a.last('roomState').phase);
  });

  it('spectators get snapshots without a ship', () => {
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    startPlaying(zone, a);
    expect(a.last('matchStart').yourShipId).toBe(0);
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    expect(s.you).toBeNull();
    expect(s.ships.length).toBe(12);
  });

  it('snapshot interest filtering and cloak hiding', () => {
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = fakeSim().world;
    const myId = a.last('matchStart').yourShipId;
    const me = w.ships.get(myId)!;
    me.x = 1000; me.y = 1000;
    // enemies near / far
    const mkEnemy = (id: number, x: number) => w.enemies.set(id, {
      id, kind: 'drone', x, y: 1000, vx: 0, vy: 0, angle: 0, hp: 5, maxHp: 10, radius: 10, elite: false, targetId: 0,
      spawnTick: 0, aiState: 0, aiTimer: 0, mem: {}, contactDamage: 1, scoreValue: 1, xpValue: 1,
    });
    mkEnemy(90001, 1500);
    mkEnemy(90002, 1000 + INTEREST_RADIUS + 50);
    w.gems.set(90003, { id: 90003, x: 1100, y: 1000, vx: 0, vy: 0, value: 3, spawnTick: 0, expireTick: 9999, magnetTo: 0 });
    // a cloaked opponent far away, and one close
    const opp = [...w.ships.values()].filter((s) => s.team === 1);
    opp[0].flags = SHIPFLAG_CLOAKED; opp[0].x = 3000; opp[0].y = 3000;
    opp[1].flags = SHIPFLAG_CLOAKED; opp[1].x = 1100; opp[1].y = 1000;
    const ally = [...w.ships.values()].find((s) => s.team === 0 && s.id !== myId)!;
    ally.flags = SHIPFLAG_CLOAKED; ally.x = 5000; ally.y = 5000;
    // events
    w.events.push({ t: 'hit', x: 1010, y: 1000, targetKind: 'enemy', targetId: 1, amount: 3 });
    w.events.push({ t: 'hit', x: 6000, y: 6000, targetKind: 'enemy', targetId: 1, amount: 3 });
    w.events.push({ t: 'waveStart', wave: 5, boss: true });
    w.events.push({ t: 'arc', points: [6000, 6000, 6100, 6100], team: 1 });
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    expect(s.enemies.map((e) => e.id)).toEqual([90001]);
    expect(s.gems.map((g) => g.id)).toEqual([90003]);
    const ids = s.ships.map((x) => x.id);
    expect(ids).not.toContain(opp[0].id);
    expect(ids).toContain(opp[1].id);
    expect(ids).toContain(ally.id);
    expect(s.events.map((e) => e.t).sort()).toEqual(['hit', 'waveStart']);
    expect(a.chatTexts().some((t) => t.includes('Hive'))).toBe(true);
    expect(s.match.timeLeftSec).toBeGreaterThan(0);
  });

  it('turret views carry slot/count', () => {
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = fakeSim().world;
    const team0 = [...w.ships.values()].filter((s) => s.team === 0);
    const host = team0[0], t1 = team0[1], t2 = team0[2];
    host.turrets = [t1.id, t2.id]; t1.attachedTo = host.id; t2.attachedTo = host.id;
    host.upgrades['orbit'] = 2;
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    const hv = s.ships.find((x) => x.id === host.id)!;
    expect(hv.turretCount).toBe(2); expect(hv.turretSlot).toBe(-1); expect(hv.orbitals).toBe(3);
    expect(s.ships.find((x) => x.id === t2.id)!.turretSlot).toBe(1);
    ticks(zone, TICK_RATE * 2);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    const aw = a.last('matchEnd').result.awards.find((x) => x.title === 'Most Stacked');
    expect(aw).toBeTruthy();
  });
});

describe('v0.2 snapshot fields', () => {
  it('ship path/beam fields, deployables, YouState cds/talents, beam event position', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = fakeSim().world;
    const myId = a.last('matchStart').yourShipId;
    const me = w.ships.get(myId)!;
    me.x = 1000; me.y = 1000;
    me.shipClass = 'engineer'; me.path = 'medic';
    const talentId = PATHS.medic.talents[0].id;
    me.upgrades = { 'path:medic': 1, orbit: 1, mystery_card: 2, [talentId]: 1 };
    me.skillState = { beamLen: 240, beamKind: 2, resonance: 2 };
    me.secondaryReadyTick = w.tick + 30; me.stats.secondaryCooldown = 1;
    me.mobilityActiveUntilTick = w.tick + 100;
    const dep = (id: number, x: number, kind: 'sentry' | 'wall') => w.deployables.set(id, {
      id, kind, ownerId: myId, ownerPlayerId: a.pid, team: 0, x, y: 1000, vx: 0, vy: 0, angle: 0, hp: 50, maxHp: 100,
      radius: 12, length: kind === 'wall' ? 200 : 0, spawnTick: w.tick, expireTick: w.tick + 400, power: 1, mem: {},
    });
    dep(80001, 1100, 'sentry'); dep(80002, 1200, 'sentry'); dep(80003, 1000 + INTEREST_RADIUS + 500, 'wall');
    const other = [...w.ships.values()].find((x) => x.id !== myId)!;
    other.x = 6000; other.y = 6000;
    w.events.push({ t: 'beam', fromId: myId, toId: other.id, kind: 'heal' });
    w.events.push({ t: 'beam', fromId: other.id, toId: myId, kind: 'heal' });
    w.events.push({ t: 'heal', x: 1000, y: 1000, targetId: myId, amount: 5 });
    w.events.push({ t: 'deployDeath', id: 1, kind: 'sentry', x: 6000, y: 6000 });
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    const mv = s.ships.find((x) => x.id === myId)!;
    expect(mv.pathIdx).toBe(SHIP_CLASSES.engineer.paths.findIndex((p) => p.id === 'medic'));
    expect(mv.beamLen).toBe(240); expect(mv.beamKind).toBe(2); expect(mv.resonance).toBe(2);
    const ov = s.ships.find((x) => x.id === other.id)!;
    expect(ov.pathIdx).toBe(-1); expect(ov.resonance).toBe(1); expect(ov.beamLen).toBe(0);
    expect(s.deployables.map((d) => d.id).sort()).toEqual([80001, 80002]);
    expect(s.deployables[0].hpFrac).toBe(0.5);
    expect(s.deployables[0].lifeFrac).toBeGreaterThan(0.9);
    const you = s.you!;
    expect(you.deployables).toEqual({ sentry: 2, wall: 1 });
    expect(you.path).toBe('medic');
    expect(you.talents).toEqual([talentId]);
    expect(you.upgrades.map((u) => u.id).sort()).toEqual(['mystery_card', 'orbit']);
    expect(you.upgrades.find((u) => u.id === 'mystery_card')!.icon).toBe('?');
    expect(you.cd.secondary).toBeGreaterThan(0.4);
    expect(you.cdSec.secondary).toBeGreaterThan(26 / TICK_RATE);
    expect(you.cdSec.secondary).toBeLessThanOrEqual(30 / TICK_RATE);
    expect(you.cd.secondary).toBeCloseTo(you.cdSec.secondary / me.stats.secondaryCooldown, 6);
    expect(you.skillActive).toBe(true);
    // beam from me is local; beam from the far ship is not; heal is local; the far deployDeath is dropped
    expect(s.events.map((e) => e.t).sort()).toEqual(['beam', 'heal']);
    expect((s.events.find((e) => e.t === 'beam') as { fromId: number }).fromId).toBe(myId);
  });

  it('Field Medic and Battle Station awards', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = fakeSim().world;
    const team0 = [...w.ships.values()].filter((x) => x.team === 0);
    const host = team0[0], t1 = team0[1], t2 = team0[2];
    host.turrets = [t1.id, t2.id]; t1.attachedTo = host.id; t2.attachedTo = host.id;
    t1.skillState.healDone = 321;
    ticks(zone, TICK_RATE * 2);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    const awards = a.last('matchEnd').result.awards;
    expect(awards.find((x) => x.title === 'Field Medic')).toMatchObject({ playerId: t1.playerId, value: '321 healed' });
    expect(awards.find((x) => x.title === 'Battle Station')!.playerId).toBe(host.playerId);
    expect(awards.length).toBeLessThanOrEqual(5);
  });

  it('bots are spread across all classes; humans default to brute', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    const bots = a.last('roomState').players.filter((p) => p.isBot);
    const counts = new Map<string, number>();
    for (const b of bots) counts.set(b.shipClass, (counts.get(b.shipClass) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(['brute', 'engineer', 'tech']);
    expect(a.last('roomState').players.find((p) => p.playerId === a.pid)!.shipClass).toBe('brute');
  });
});

describe('accounts', () => {
  const registered = new Set(['maverick', 'glitch']);
  const mk = () => new Zone({
    snapshotEvery: 3, motd: 'hi', local: false, defaultRooms: [{ name: 'Main Arena', botFill: 12 }],
    isReservedName: (n) => registered.has(n.toLowerCase()),
  });

  it('account pilots use their username and get account in welcome; guests get null', () => {
    const zone = mk();
    const g = join(zone, 'Guesty');
    expect(g.last('welcome').account).toBeNull();
    const m = join(zone, 'whatever', acct('Maverick'));
    expect(m.last('welcome').name).toBe('Maverick');
    expect(m.last('welcome').account!.username).toBe('Maverick');
    m.send({ type: 'setName', name: 'Other' });
    expect(m.last('welcome').name).toBe('Maverick');
    expect(m.of('chat').some((c) => c.line.text.includes('account name'))).toBe(true);
  });

  it('guests (and bots) cannot take a registered name', () => {
    const zone = mk();
    const g = join(zone, 'maverick');
    expect(g.last('welcome').name).toBe('maverick2');
    g.send({ type: 'setName', name: 'Maverick' });
    expect(g.last('welcome').name.toLowerCase()).not.toBe('maverick');
    g.send({ type: 'joinRoom', roomId: g.last('roomList').rooms[0].id });
    expect(g.last('roomState').players.some((p) => p.name === 'Glitch')).toBe(false);
  });

  it('same account logging in again kicks the older connection', () => {
    const zone = mk();
    const m1 = join(zone, '', acct('Maverick'));
    m1.send({ type: 'joinRoom', roomId: m1.last('roomList').rooms[0].id });
    const m2 = join(zone, '', acct('Maverick'));
    expect(m2.last('welcome').name).toBe('Maverick');
    expect(m1.of('error').some((e) => e.message === 'Logged in elsewhere')).toBe(true);
    expect(m1.closedReason).toBe('Logged in elsewhere');
    const before = m1.msgs.length;
    m1.send({ type: 'listRooms' });
    expect(m1.msgs.length).toBe(before); // ignored after kick
    m1.conn.close(); // the transport closing afterwards is harmless
    expect(m2.last('roomState').players.map((p) => p.name)).toEqual(['Maverick']);
    zone.tick();
    expect(m2.last('roomList').rooms[0].humans).toBe(0);
  });

  it('a guest squatting an account name is renamed when the owner logs in', () => {
    const zone = mk();
    const g = join(zone, 'Ace');
    expect(g.last('welcome').name).toBe('Ace');
    registered.add('ace');
    const o = join(zone, '', acct('Ace'));
    expect(o.last('welcome').name).toBe('Ace');
    expect(g.last('welcome').name).toBe('Ace2');
    registered.delete('ace');
  });
});

describe('local mode', () => {
  it('never auto-starts and never closes rooms', () => {
    const zone = mkZone(true, [{ name: 'Offline', botFill: 8 }]);
    const a = join(zone, 'Solo');
    a.send({ type: 'createRoom', settings: { name: 'Custom' } });
    expect(a.last('roomState').hostPlayerId).toBe(a.pid);
    a.send({ type: 'ready', ready: true });
    ticks(zone, 25 * TICK_RATE);
    expect(a.last('roomState').phase).toBe('lobby');
    a.send({ type: 'leaveRoom' });
    ticks(zone, 70 * TICK_RATE);
    expect(a.last('roomList').rooms.map((r) => r.name)).toContain('Custom');
  });
});

// ---------------------------------------------------------------------------------------------
// v0.2 fix-pass regressions
// ---------------------------------------------------------------------------------------------

type FakeSimT = {
  world: import('../types').World;
  spawns: { pid: number; tick: number }[];
  classSwaps: { pid: number; tick: number; inPlace: boolean }[];
  lootMult: number;
  abandoned: boolean;
  picks: [number, number, number | undefined][];
  inputs: Map<number, import('../types').InputState>;
  floorSwap(floor: number, before?: import('../types').GameEvent[]): void;
};
const fake = (): FakeSimT => (Sim as unknown as { last: FakeSimT }).last;
const shipOf = (c: FakeClient): import('../types').Ship => {
  const w = fake().world;
  return w.ships.get(w.shipsByPlayer.get(c.pid)!)!;
};
const meIn = (c: FakeClient) => c.last('roomState').players.find((p) => p.playerId === c.pid)!;
const spawnsOf = (pid: number) => fake().spawns.filter((x) => x.pid === pid);

function joinFrom(zone: Zone, name: string, address: string): FakeClient {
  const c = new FakeClient();
  c.conn = zone.connect(c);
  c.conn.setAccount(null);
  c.conn.setAddress(address);
  c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test' });
  return c;
}

describe('SEC-2: mid-match class/team changes never hand out a free respawn', () => {
  let zone: Zone;
  let a: FakeClient;
  beforeEach(() => {
    zone = mkZone();
    a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
  });

  it('v0.3 #6: a live ship swaps class IN PLACE — same spot, same energy fraction, no invulnerability, no respawn', () => {
    const s = shipOf(a);
    s.x = 1234; s.y = 2345; s.energy = s.stats.maxEnergy * 0.25; s.invulnUntilTick = 0;
    const before = spawnsOf(a.pid).length;
    for (let i = 0; i < 7; i++) a.send({ type: 'setShip', shipClass: i % 2 ? 'brute' : 'tech' });
    zone.tick();
    expect(s.shipClass).toBe('tech'); // 7 toggles, the last one picks tech
    expect(s.x).toBe(1234); expect(s.y).toBe(2345);
    expect(s.energy / s.stats.maxEnergy).toBeCloseTo(0.25, 6);
    expect(s.invulnUntilTick).toBe(0);
    expect(spawnsOf(a.pid)).toHaveLength(before);
    expect(fake().classSwaps.filter((x) => x.pid === a.pid).every((x) => x.inPlace)).toBe(true);
    expect(a.chatTexts()).not.toContain(CLASS_QUEUED_MSG);
    expect(meIn(a).shipClass).toBe('tech');
  });

  it('a dead ship keeps the new class queued; it arrives with the normal respawn, not before', () => {
    const s = shipOf(a);
    const w = fake().world;
    s.alive = false; s.respawnTick = w.tick + 180;
    const before = spawnsOf(a.pid).length;
    a.send({ type: 'setShip', shipClass: 'tech' });
    expect(a.chatTexts()).toContain(CLASS_QUEUED_MSG);
    ticks(zone, 120);
    expect(s.alive).toBe(false);
    expect(s.shipClass).toBe('brute');
    ticks(zone, 61);
    expect(s.alive).toBe(true);
    expect(s.shipClass).toBe('tech');
    const sp = spawnsOf(a.pid);
    expect(sp).toHaveLength(before + 1);
    expect(sp[sp.length - 1].tick).toBeGreaterThanOrEqual(s.respawnTick - 1);
  });

  it('a dead ship cannot skip its respawn timer by switching class', () => {
    const s = shipOf(a);
    const w = fake().world;
    s.alive = false; s.respawnTick = w.tick + 180;
    a.send({ type: 'setShip', shipClass: 'engineer' });
    ticks(zone, 60);
    expect(s.alive).toBe(false);
    expect(s.shipClass).toBe('brute');
    ticks(zone, 121);
    expect(s.alive).toBe(true);
    expect(s.shipClass).toBe('engineer');
  });

  it('a team switch waits for the respawn; team chat routing keeps the current team until then', () => {
    const s = shipOf(a);
    const w = fake().world;
    s.energy = 5;
    a.send({ type: 'setTeam', team: 1 });
    zone.tick();
    expect(s.team).toBe(0);
    expect(s.energy).toBe(5);
    expect(meIn(a).team).toBe(0);
    expect(a.chatTexts().some((t) => t.includes('queued'))).toBe(true);
    a.send({ type: 'setTeam', team: 0 });
    expect(a.chatTexts()).toContain('Team change cancelled.');
    a.send({ type: 'setTeam', team: 1 });
    s.alive = false; s.respawnTick = w.tick + 30;
    ticks(zone, 20);
    expect(s.team).toBe(0);
    ticks(zone, 11);
    expect(s.alive).toBe(true);
    expect(s.team).toBe(1);
    expect(meIn(a).team).toBe(1);
    expect(a.chatTexts()).toContain(`Ace joined team ${teamName(1)}.`);
  });

  it('a switch still queued when the match ends applies to the next match', () => {
    a.send({ type: 'setTeam', team: 1 });
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(a.last('roomState').phase).toBe('lobby');
    expect(meIn(a).team).toBe(1);
  });

  it('leaving to spectate stays immediate', () => {
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(fake().world.shipsByPlayer.has(a.pid)).toBe(false);
    expect(meIn(a).inMatch).toBe(false);
  });
});

describe('upgrade picks carry offerId', () => {
  it('forwards a human offerId, drops picks without one, bots pass undefined; YouState.offerId = ship.offerSerial', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    shipOf(a).offerSerial = 5;
    ticks(zone, 3);
    expect(a.snaps[a.snaps.length - 1].you!.offerId).toBe(5);
    a.send({ type: 'chooseUpgrade', index: 1, offerId: 5 });
    a.send({ type: 'chooseUpgrade', index: 2 } as unknown as ClientMsg);
    expect(fake().picks).toEqual([[a.pid, 1, 5]]);
    const bot = [...fake().world.ships.values()].find((x) => x.isBot)!;
    bot.offers = [[{ id: 'orbit', name: 'Orbit Blades', description: '', level: 1, maxLevel: 5, category: 'auto', icon: 'O' }]];
    ticks(zone, 30);
    expect(fake().picks.some(([pid, , id]) => pid === bot.playerId && id === undefined)).toBe(true);
  });
});

describe('NET-2: the last events of a match are delivered', () => {
  function playing(): { zone: Zone; a: FakeClient } {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    // align to just after a snapshot tick, so the next tick is NOT a snapshot tick
    const n0 = a.snaps.length;
    for (let i = 0; i < 10 && a.snaps.length === n0; i++) zone.tick();
    return { zone, a };
  }
  const death = (killer: number): import('../types').GameEvent => ({
    t: 'shipDeath', shipId: 1, playerId: 2, killerPlayerId: killer, cause: 'player', x: 1, y: 2, bounty: 30,
  });

  it('a sim-ended match flushes a final snapshot (deciding kill + matchEnd) before the matchEnd message', () => {
    const { zone, a } = playing();
    const n = a.snaps.length;
    const w = fake().world;
    w.events.push(death(a.pid), { t: 'matchEnd', winnerTeam: 0, winnerPlayerId: 0 });
    w.match.phase = 'ended';
    zone.tick();
    expect(a.snaps).toHaveLength(n + 1);
    expect(a.snaps[n].events.map((e) => e.t)).toEqual(expect.arrayContaining(['shipDeath', 'matchEnd']));
    expect(a.order.lastIndexOf('snap')).toBeLessThan(a.order.indexOf('matchEnd'));
  });

  it('/end flushes pending events too', () => {
    const { zone, a } = playing();
    const n = a.snaps.length;
    fake().world.events.push(death(a.pid));
    zone.tick(); // drained, but not a snapshot tick
    expect(a.snaps).toHaveLength(n);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(a.snaps).toHaveLength(n + 1);
    expect(a.snaps[n].events.some((e) => e.t === 'shipDeath')).toBe(true);
  });
});

describe('NET-1: spectator interest follows the ship the client camera follows', () => {
  it('first alive unattached ship, kept until it dies — not the top scorer', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    startPlaying(zone, a);
    const w = fake().world;
    const ships = [...w.ships.values()];
    for (const s of ships) { s.x = 5000; s.y = 5000; }
    const [first, second] = ships;
    first.x = 500; first.y = 500;
    second.score = 999; // the top scorer sits elsewhere
    const mkEnemy = (id: number, x: number, y: number) => w.enemies.set(id, {
      id, kind: 'drone', x, y, vx: 0, vy: 0, angle: 0, hp: 5, maxHp: 10, radius: 10, elite: false, targetId: 0,
      spawnTick: 0, aiState: 0, aiTimer: 0, mem: {}, contactDamage: 1, scoreValue: 1, xpValue: 1,
    });
    mkEnemy(91001, 600, 500);
    mkEnemy(91002, 5100, 5000);
    const enemyIds = () => a.snaps[a.snaps.length - 1].enemies.map((e) => e.id);
    ticks(zone, 3);
    expect(enemyIds()).toEqual([91001]);
    first.alive = false; first.respawnTick = w.tick + 10_000;
    ticks(zone, 3);
    expect(enemyIds()).toEqual([91002]); // switched to the next alive ship (like the client)
    first.alive = true;
    ticks(zone, 3);
    expect(enemyIds()).toEqual([91002]); // sticky, like the client camera
  });

  it("round 2: ClientMsg 'spectate' moves the spectator's interest; 0 / unknown / dead ids fall back; pilots can't use it", () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    b.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = fake().world;
    const ships = [...w.ships.values()];
    for (const s of ships) { s.x = 5000; s.y = 5000; }
    const first = ships[0];
    const other = ships.find((s) => s.id !== first.id && s.playerId !== b.pid)!;
    const bShip = shipOf(b);
    first.x = 500; first.y = 500;
    other.x = 3000; other.y = 3000;
    if (bShip !== first) { bShip.x = 900; bShip.y = 4000; }
    const mkEnemy = (id: number, x: number, y: number) => w.enemies.set(id, {
      id, kind: 'drone', x, y, vx: 0, vy: 0, angle: 0, hp: 5, maxHp: 10, radius: 10, elite: false, targetId: 0,
      spawnTick: 0, aiState: 0, aiTimer: 0, mem: {}, contactDamage: 1, scoreValue: 1, xpValue: 1,
    });
    mkEnemy(91001, 600, 500);
    mkEnemy(91003, 3100, 3000);
    mkEnemy(91002, 5100, 5000);
    const enemyIds = (c: FakeClient) => c.snaps[c.snaps.length - 1].enemies.map((e) => e.id).sort();
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91001]); // server default: first alive ship
    a.send({ type: 'spectate', shipId: other.id });
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91003]); // follows the client's camera target
    a.send({ type: 'spectate', shipId: 0 });
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91001]); // 0 = back to the default rule
    a.send({ type: 'spectate', shipId: 987654 });
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91001]); // unknown id: default
    a.send({ type: 'spectate', shipId: other.id });
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91003]);
    other.alive = false; other.respawnTick = w.tick + 10_000;
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91001]); // dead target: default (like the client's own fallback)
    other.alive = true;
    ticks(zone, 3);
    expect(enemyIds(a)).toEqual([91001]); // the dead request was dropped, not resumed
    // a pilot's interest stays on its own ship whatever it sends
    const before = enemyIds(b);
    b.send({ type: 'spectate', shipId: other.id });
    ticks(zone, 3);
    expect(enemyIds(b)).toEqual(before);
    expect(enemyIds(b)).not.toContain(91003);
  });
});

describe('SEC-3: room abuse caps', () => {
  it('a running match with no humans left is stopped after a grace period', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    a.send({ type: 'leaveRoom' });
    const phase = () => a.last('roomList').rooms.find((r) => r.name === 'Main Arena')!.phase;
    ticks(zone, EMPTY_MATCH_END_SEC * TICK_RATE - 10);
    expect(phase()).toBe('playing');
    ticks(zone, 10 + TICK_RATE + 1);
    expect(phase()).toBe('lobby');
  });

  it("a connection's previous room is recycled; open rooms per address are capped", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let t = Date.now();
      const zone = mkZone();
      const obs = join(zone, 'Watcher');
      const a = joinFrom(zone, 'Ace', '9.9.9.9');
      for (let i = 0; i < 4; i++) {
        t += 30_000; vi.setSystemTime(t);
        a.send({ type: 'createRoom', settings: { name: 'Mine' } });
        expect(a.of('error')).toHaveLength(0);
      }
      ticks(zone, TICK_RATE + 1);
      expect(obs.last('roomList').rooms).toHaveLength(3); // 2 built-in + only a's latest
      for (let i = 1; i < MAX_ROOMS_PER_ADDRESS; i++) {
        const c = joinFrom(zone, `Alt${i}`, '9.9.9.9');
        c.send({ type: 'createRoom', settings: { name: `Alt ${i}` } });
        expect(c.of('error')).toHaveLength(0);
      }
      const over = joinFrom(zone, 'Over', '9.9.9.9');
      over.send({ type: 'createRoom', settings: { name: 'One too many' } });
      expect(over.last('error').message).toMatch(/rooms open/);
      expect(over.last('roomState').roomId).toBeNull();
      const elsewhere = joinFrom(zone, 'Else', '8.8.8.8');
      elsewhere.send({ type: 'createRoom', settings: { name: 'Different net' } });
      expect(elsewhere.of('error')).toHaveLength(0);
      expect(elsewhere.last('roomState').roomId).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('built-in rooms keep their name and player cap, and reset once they empty', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'updateSettings', settings: { maxPlayers: 2, name: 'Locked Out', botFill: 4 } });
    const rs = a.last('roomState');
    expect(rs.settings.maxPlayers).toBe(32);
    expect(rs.settings.name).toBe('Main Arena');
    expect(rs.settings.botFill).toBe(4);
    expect(a.chatTexts().some((x) => x.includes('built-in room'))).toBe(true);
    a.send({ type: 'leaveRoom' });
    ticks(zone, 2);
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    expect(b.last('roomState').settings.botFill).toBe(12);
  });

  it('user-created rooms stay fully customizable', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'createRoom', settings: { name: 'Mine' } });
    a.send({ type: 'updateSettings', settings: { maxPlayers: 4, name: 'Renamed' } });
    expect(a.last('roomState').settings).toMatchObject({ maxPlayers: 4, name: 'Renamed' });
  });
});

describe('SEC-4: message rate limits', () => {
  it('rename spam is bounded (few announcements) and warned about once', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    for (let i = 0; i < 40; i++) a.send({ type: 'setName', name: i % 2 ? 'Ace' : 'Aaa' });
    const renames = b.chatTexts().filter((x) => x.includes('is now known as')).length;
    expect(renames).toBeGreaterThan(0);
    expect(renames).toBeLessThanOrEqual(8);
    expect(a.chatTexts().filter((x) => x.startsWith('Slow down')).length).toBe(1);
  });

  it('60 inputs/s pass; an input flood is cut off', () => {
    // The buckets refill with Date.now(): freeze it, so a slow run (a loaded CI box, the scrypt-heavy auth
    // tests in parallel) can't refill the bucket while the flood is being sent.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const zone = mkZone();
      const a = join(zone, 'Ace');
      a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
      startPlaying(zone, a);
      const inp = (seq: number): ClientMsg => ({
        type: 'input',
        input: { seq, moveX: 0, moveY: 0, aim: 0, aimDist: 300, primary: false, secondary: false, mobility: false, utility: false, afterburner: false, attach: false, attachTarget: 0, detach: false },
      });
      for (let i = 1; i <= 60; i++) a.send(inp(i));
      expect(fake().inputs.get(a.pid)!.seq).toBe(60);
      for (let i = 61; i <= 600; i++) a.send(inp(i));
      expect(fake().inputs.get(a.pid)!.seq).toBeLessThan(300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a crowded or reserved name costs a bounded number of lookups', () => {
    let calls = 0;
    const zone = new Zone({
      snapshotEvery: 3, motd: 'hi', local: false, defaultRooms: [{ name: 'Main Arena', botFill: 0 }],
      isReservedName: () => { calls++; return true; }, // everything "registered": dedupe must still stop
    });
    const c = join(zone, 'Q');
    expect(calls).toBeLessThanOrEqual(160);
    expect(c.last('welcome').name.length).toBeLessThanOrEqual(16);
    const names = new Set<string>();
    const zone2 = mkZone(false, [{ name: 'Main Arena', botFill: 0 }]);
    for (let i = 0; i < 130; i++) names.add(join(zone2, 'Q').last('welcome').name.toLowerCase());
    expect(names.size).toBe(130);
  });
});

describe('SEC-5: zone lobby broadcasts are coalesced', () => {
  it('a connect storm sends each lobby pilot O(1) lists, capped in size; newcomers still get one at once', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const others: FakeClient[] = [];
    for (let i = 0; i < 80; i++) others.push(join(zone, `P${i}`));
    expect(a.of('roomState')).toHaveLength(1); // its own, at hello
    expect(others[79].of('roomState')).toHaveLength(1);
    ticks(zone, LOBBY_STATE_THROTTLE_TICKS);
    const lists = a.of('roomState');
    expect(lists).toHaveLength(2);
    expect(lists[1].players).toHaveLength(MAX_LOBBY_LIST);
    // presence lines are budgeted zone-wide too (the history is not flushed by a storm)
    const entered = a.chatTexts().filter((x) => x.endsWith('entered the zone.')).length;
    expect(entered).toBeGreaterThan(0);
    expect(entered).toBeLessThanOrEqual(PRESENCE_BURST + 1);
  });
});

describe('SEC-8: look-alike callsigns', () => {
  it('guests cannot pose as a registered pilot with homoglyphs, invisible fillers or styled letters', () => {
    const registered = new Set(['admin']);
    const zone = new Zone({
      snapshotEvery: 3, motd: 'hi', local: false, defaultRooms: [{ name: 'Main Arena', botFill: 0 }],
      isReservedName: (n) => registered.has(n.toLowerCase()),
    });
    const tries = ['\u0410dmin', 'Admin\u3164', '\uFF21\uFF44\uFF4D\uFF49\uFF4E', 'A\u200Bdmin', 'Ad\u0307min', '\u{1D400}dmin', '\u0391DMIN', 'Adm\u0456n'];
    for (const raw of tries) {
      const g = join(zone, raw);
      expect(nameKey(g.last('welcome').name)).not.toBe('admin');
    }
  });

  it('online pilots cannot be imitated, and an account login renames a look-alike squatter', () => {
    const reg = new Set<string>();
    const zone = new Zone({
      snapshotEvery: 3, motd: 'hi', local: false, defaultRooms: [{ name: 'Main Arena', botFill: 0 }],
      isReservedName: (n) => reg.has(n.toLowerCase()),
    });
    join(zone, 'Bob');
    const imitator = join(zone, '\u0412\u043Eb'); // Cyrillic "\u0412\u043E" + Latin "b"
    expect(nameKey(imitator.last('welcome').name)).not.toBe('bob');
    const lookalike = join(zone, '\u0410ce'); // looks like "Ace": the Cyrillic letter is simply dropped
    expect(lookalike.last('welcome').name).toBe('ce');
    const squatter = join(zone, 'ACE'); // an ASCII case variant squats the name
    expect(squatter.last('welcome').name).toBe('ACE');
    reg.add('ace');
    const owner = join(zone, '', acct('Ace'));
    expect(owner.last('welcome').name).toBe('Ace');
    expect(nameKey(squatter.last('welcome').name)).not.toBe('ace');
  });

  it('round 2: guest names are ASCII only \u2014 Armenian / Cherokee / Lisu / IPA look-alikes never show as a registered name', () => {
    const registered = new Set(['bob', 'admin']);
    const zone = new Zone({
      snapshotEvery: 3, motd: 'hi', local: false, defaultRooms: [{ name: 'Main Arena', botFill: 0 }],
      isReservedName: (n) => registered.has(n.toLowerCase()),
    });
    const tries = ['B\u0585b', '\uA4D0ob', '\u13F4ob', '\u0561dmin', 'adm\u0268n', '\u13AAdmin', 'admi\u0578', 'ad\u217Fin', 'Bob', 'ADMIN', 'B o b'];
    for (const raw of tries) {
      const g = join(zone, raw);
      const name = g.last('welcome').name;
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
      expect(['bob', 'admin']).not.toContain(name.toLowerCase());
      expect(['bob', 'admin']).not.toContain(nameKey(name));
      g.send({ type: 'setName', name: 'B\u0585b' }); // renames go through the same filter
      const renamed = g.last('welcome').name;
      expect(renamed).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
      expect(renamed.toLowerCase()).not.toBe('bob');
    }
    const spaced = join(zone, 'Ace  Pilot');
    expect(spaced.last('welcome').name).toBe('Ace_Pilot');
  });

  it('round 2: bot callsigns are ASCII', () => {
    const zone = mkZone(false, [{ name: 'Main Arena', mode: 'teams', teamCount: 2, botFill: 32 }]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    const bots = a.last('roomState').players.filter((p) => p.isBot);
    expect(bots.length).toBeGreaterThan(20);
    for (const b of bots) expect(b.name).toMatch(/^[A-Za-z0-9 _-]{1,16}$/);
  });
});

describe('SEC-10: ZoneConnection.kick (revoked sessions)', () => {
  it('ends a live pilot: error, removed from the room, transport closed, later messages ignored', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace', acct('Ace'));
    const b = join(zone, 'Bee');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    a.conn.kick('Session ended — please log in again');
    expect(a.last('error').message).toBe('Session ended — please log in again');
    expect(a.closedReason).toBe('Session ended — please log in again');
    expect(b.last('roomState').players.some((p) => p.playerId === a.pid)).toBe(false);
    const n = a.msgs.length;
    a.send({ type: 'listRooms' });
    expect(a.msgs.length).toBe(n);
    a.conn.close(); // the transport closing afterwards is harmless
    a.conn.kick('again'); // idempotent
    expect(a.of('error')).toHaveLength(1);
  });

  it('a connection kicked before its hello is refused', () => {
    const zone = mkZone();
    const c = new FakeClient();
    c.conn = zone.connect(c);
    c.conn.kick('bye');
    c.send({ type: 'hello', name: 'Late', protocol: PROTOCOL_VERSION, version: 'test' });
    expect(c.of('welcome')).toHaveLength(0);
    expect(c.closedReason).toBe('bye');
  });
});

// ---------------------------------------------------------------------------------------------
// v0.3 M1 (docs/v0.3-proposal.md §3, §9 ROOM acceptance)
// ---------------------------------------------------------------------------------------------

const roomsOf = (zone: Zone): Room[] => [...(zone as unknown as { rooms: Map<string, Room> }).rooms.values()];
const roomNamed = (zone: Zone, name: string): Room => roomsOf(zone).find((r) => r.settings.name === name)!;
const wzRoom = (name: string) => ({ name, gameType: 'warzone' as const, subMode: 'deathmatch' as const, botFill: 4 });

describe('v0.3 M1: room summary', () => {
  it('house flag, host name, seats, startsInSec (pushed when the auto-start begins), and the live block', () => {
    const zone = mkZone(false, houseRooms(false));
    const obs = join(zone, 'Obs');
    let list = obs.last('roomList');
    expect(list.online).toBe(1);
    const wz = list.rooms.find((r) => r.name === 'Warzone Classic')!;
    expect(wz).toMatchObject({
      gameType: 'warzone', subMode: 'deathmatch', house: true, hostName: '', humans: 0, bots: 12, spectators: 0,
      joinable: true, watchable: false, startsInSec: 0, live: null, pveIntensity: 2, floors: 0, maxPlayers: 32,
    });
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: wz.id });
    a.send({ type: 'ready', ready: true });
    ticks(zone, TICK_RATE + 1); // list pushes are throttled to 1/s
    list = obs.last('roomList');
    expect(list.online).toBe(2);
    let s = list.rooms.find((r) => r.id === wz.id)!;
    expect(s.hostName).toBe('Ace');
    expect(s.humans).toBe(1);
    expect(s.startsInSec).toBeGreaterThan(AUTO_START_SEC - 2);
    expect(s.startsInSec).toBeLessThanOrEqual(AUTO_START_SEC + COUNTDOWN_SEC);
    a.send({ type: 'startMatch' });
    const room = roomNamed(zone, 'Warzone Classic');
    expect(room.summary()).toMatchObject({ phase: 'countdown', startsInSec: COUNTDOWN_SEC, live: null });
    ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
    ticks(zone, 2 * TICK_RATE);
    const w = room.sim!.world;
    w.match.teamScores = [212, 187]; // the real Sim keeps these summed every tick
    w.pve.wave = 4;
    s = room.summary();
    expect(s).toMatchObject({ phase: 'playing', watchable: true, joinable: true, startsInSec: 0 });
    expect(s.live).toMatchObject({ wave: 4, floor: 0, floorsTotal: 0, lives: -1, scores: [212, 187], scoreline: '212–187', leader: '', leaderScore: 0 });
    expect(s.live!.elapsedSec).toBeGreaterThanOrEqual(2);
    expect(s.live!.timeLeftSec).toBeGreaterThan(590);
    expect(s.live!.timeLeftSec).toBeLessThanOrEqual(600);
  });

  it('FFA live block names the leader; Arena reports no wave; an untimed match reports -1 left', () => {
    const zone = mkZone(false, houseRooms(false));
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Duel Pit') });
    startPlaying(zone, a);
    const room = roomNamed(zone, 'Duel Pit');
    const w = room.sim!.world;
    [...w.ships.values()].find((x) => x.playerId === a.pid)!.score = 820;
    w.pve.wave = 3;
    let s = room.summary();
    expect(s.mode).toBe('ffa');
    expect(s.live).toMatchObject({ wave: 0, scores: [], leader: 'Ace', leaderScore: 820, scoreline: 'Ace 820' });
    w.match.endTick = 0;
    s = room.summary();
    expect(s.live!.timeLeftSec).toBe(-1);
    ticks(zone, 3);
    const m = a.snaps[a.snaps.length - 1].match;
    expect(m.timed).toBe(false);
    expect(m.timeLeftSec).toBe(0);
  });

  it(`while a room plays, zone-lobby users get a fresh list every ${ROOM_LIST_LIVE_SEC} s (and not otherwise)`, () => {
    const zone = mkZone();
    const obs = join(zone, 'Obs');
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    ticks(zone, 2 * TICK_RATE);
    const n0 = obs.of('roomList').length;
    ticks(zone, 3 * ROOM_LIST_LIVE_SEC * TICK_RATE);
    const n = obs.of('roomList').length - n0;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
    expect(obs.last('roomList').rooms.find((r) => r.name === 'Main Arena')!.live).not.toBeNull();
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    ticks(zone, (RESULTS_SEC + 2) * TICK_RATE);
    const m0 = obs.of('roomList').length;
    ticks(zone, 3 * ROOM_LIST_LIVE_SEC * TICK_RATE);
    expect(obs.of('roomList').length).toBe(m0);
  });

  it('/rooms lists type, mode, pilots and status', () => {
    const zone = mkZone(false, houseRooms(false));
    const a = join(zone, 'Ace');
    a.send({ type: 'chat', channel: 'all', text: '/rooms' });
    // M4: The Descent opens first; M3: Flag Run and Hot Points, ahead of Duel Pit and Warzone Classic
    expect(a.chatTexts().some((t) => t.startsWith('1. The Descent — Dungeon Runner Co-op'))).toBe(true);
    expect(a.chatTexts().some((t) => t.startsWith('2. Flag Run — Arena CTF, 2 teams, 0 pilots + '))).toBe(true);
    expect(a.chatTexts().some((t) => t.startsWith('3. Hot Points — Arena Hot, 2 teams, 0 pilots + '))).toBe(true);
    expect(a.chatTexts()).toContain('4. Duel Pit — Arena DM, FFA, 0 pilots + 4 bots, lobby');
    expect(a.chatTexts()).toContain('5. Warzone Classic — Warzone Classic, 2 teams, 0 pilots + 12 bots, lobby');
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Warzone Classic') });
    startPlaying(zone, b);
    a.send({ type: 'chat', channel: 'all', text: '/rooms' });
    expect(a.chatTexts().some((t) => /^5\. Warzone Classic — Warzone Classic, 2 teams, 1 pilots \+ 11 bots, playing \d+:\d\d left · 0–0( · wave \d+)?$/.test(t))).toBe(true);
    a.send({ type: 'chat', channel: 'all', text: '/help' });
    expect(a.chatTexts().some((t) => t.includes('/play <type> [mode]'))).toBe(true);
  });
});

describe('v0.3 M1: Quick Play', () => {
  it('picks the populated lobby over an idle one, readies up, and the 20 s auto-start launches it', () => {
    const zone = mkZone(false, [wzRoom('W1'), wzRoom('W2')]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'W2') });
    const b = join(zone, 'Bee');
    b.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(b.last('roomState').settings.name).toBe('W2');
    expect(meIn(b).ready).toBe(true);
    expect(b.chatTexts()).toContain(`Quick Play → W2 (Classic). Auto-start in ${AUTO_START_SEC} s — un-ready to wait.`);
    ticks(zone, AUTO_START_SEC * TICK_RATE);
    expect(['countdown', 'playing']).toContain(b.last('roomState').phase);
  });

  it('respects the type and the sub-mode', () => {
    const zone = mkZone(false, [wzRoom('W1'), { name: 'Pit', gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', botFill: 4 }]);
    const a = join(zone, 'Ace');
    a.send({ type: 'quickPlay', gameType: 'arena', subMode: 'deathmatch' });
    expect(a.last('roomState').settings.name).toBe('Pit');
    const b = join(zone, 'Bee');
    b.send({ type: 'quickPlay', gameType: 'warzone', subMode: 'deathmatch' });
    expect(b.last('roomState').settings.name).toBe('W1');
    const c = join(zone, 'Cee');
    c.send({ type: 'chat', channel: 'all', text: '/play arena dm' });
    expect(c.last('roomState').settings.name).toBe('Pit');
  });

  it('drops into a running match, but skips one with < 90 s left: an overflow room opens instead', () => {
    const zone = mkZone(false, [wzRoom('W1')]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'W1') });
    startPlaying(zone, a);
    const w = roomNamed(zone, 'W1').sim!.world;
    const b = join(zone, 'Bee');
    b.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(b.last('roomState').settings.name).toBe('W1');
    expect(b.last('matchStart').yourShipId).toBeGreaterThan(0);
    expect(meIn(b).inMatch).toBe(true);
    w.match.endTick = w.tick + 60 * TICK_RATE;
    const c = join(zone, 'Cee');
    c.send({ type: 'quickPlay', gameType: 'warzone' });
    const rs = c.last('roomState');
    expect(rs.settings).toMatchObject({ name: 'Warzone · DM #1', gameType: 'warzone', subMode: 'deathmatch' });
    expect(rs.phase).toBe('lobby');
    expect(roomNamed(zone, 'Warzone · DM #1').summary().house).toBe(false); // user-created: closes when empty
    const d = join(zone, 'Dee');
    d.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(d.last('roomState').settings.name).toBe('Warzone · DM #1');
  });

  it("errors: a type / mode that isn't open yet, a mode of another type, and no free room slot", () => {
    preM4(); // pins the not-open path (co-op opened in M4; Rival Rift / Escort stay closed below)
    const zone = mkZone(false, Array.from({ length: MAX_ROOMS }, (_, i) => ({
      name: `A${i}`, gameType: 'arena' as const, subMode: 'deathmatch' as const, botFill: 0,
    })));
    const a = join(zone, 'Ace');
    a.send({ type: 'quickPlay', gameType: 'dungeon' });
    expect(a.last('error').message).toBe("Dungeon Runner isn't open yet.");
    a.send({ type: 'quickPlay', gameType: 'dungeon', subMode: 'rival' });
    expect(a.last('error').message).toBe("Dungeon Runner · Rival Rift isn't open yet.");
    a.send({ type: 'quickPlay', gameType: 'arena', subMode: 'escort' });
    expect(a.last('error').message).toBe("Arena · Escort isn't open yet.");
    a.send({ type: 'quickPlay', gameType: 'arena', subMode: 'coop' });
    expect(a.last('error').message).toBe('Arena has no such mode.');
    a.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(a.last('error').message).toBe('All game slots are busy — try again in a moment.');
    expect(a.last('roomState').roomId).toBeNull();
    a.send({ type: 'quickPlay', gameType: 'arena' });
    expect(a.last('roomState').roomId).not.toBeNull();
  });

  it('Quick Play during results readies the pilot for the next match', () => {
    const zone = mkZone(false, [wzRoom('W1')]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'W1') });
    startPlaying(zone, a);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    const b = join(zone, 'Bee');
    b.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(b.last('roomState').phase).toBe('results');
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(b.last('roomState').phase).toBe('lobby');
    expect(meIn(b).ready).toBe(true);
    expect(meIn(a).ready).toBe(false);
  });

  it('lastShipClass: the class a pilot picked last comes along into the next room, drop-ins included', () => {
    const zone = mkZone(false, [{ name: 'Pit', gameType: 'arena', subMode: 'deathmatch', botFill: 2 }, { name: 'Main Arena', botFill: 4 }]);
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    startPlaying(zone, b);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Pit') });
    a.send({ type: 'setShip', shipClass: 'tech' });
    a.send({ type: 'leaveRoom' });
    a.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(a.last('roomState').settings.name).toBe('Main Arena');
    expect(meIn(a).shipClass).toBe('tech');
    expect(shipOf(a).shipClass).toBe('tech');
  });
});

describe('v0.3 M1: join intents, spectator slots, watch rules', () => {
  it('Watch spectates a running match without evicting bots; Play drops straight in', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const botsBefore = a.last('roomState').players.filter((p) => p.isBot).length;
    const w = join(zone, 'Watcher');
    w.send({ type: 'joinRoom', roomId: roomId(w, 'Main Arena'), intent: 'watch' });
    expect(w.last('matchStart')).toMatchObject({ yourShipId: 0, gameType: 'warzone', subMode: 'deathmatch', floor: 0 });
    expect(meIn(w)).toMatchObject({ team: TEAM_UNASSIGNED, inMatch: false });
    expect(w.last('roomState').players.filter((p) => p.isBot)).toHaveLength(botsBefore);
    ticks(zone, 3);
    expect(w.snaps[w.snaps.length - 1].you).toBeNull();
    expect(roomNamed(zone, 'Main Arena').summary()).toMatchObject({ humans: 2, spectators: 1 });
    const p = join(zone, 'Pilot');
    p.send({ type: 'joinRoom', roomId: roomId(p, 'Main Arena'), intent: 'play' });
    expect(p.last('matchStart').yourShipId).toBeGreaterThan(0);
    expect(meIn(p).inMatch).toBe(true);
    expect(p.last('roomState').players.filter((q) => q.isBot)).toHaveLength(botsBefore - 1); // a pilot takes a bot's seat
  });

  it('Watch needs a running match; a lobby join with play intent is a plain join', () => {
    const zone = mkZone();
    const w = join(zone, 'Watcher');
    w.send({ type: 'joinRoom', roomId: roomId(w, 'Main Arena'), intent: 'watch' });
    expect(w.last('error').message).toMatch(/not running/);
    expect(w.last('roomState').roomId).toBeNull();
    w.send({ type: 'joinRoom', roomId: roomId(w, 'Main Arena'), intent: 'play' });
    expect(w.last('roomState')).toMatchObject({ phase: 'lobby' });
    expect(meIn(w)).toMatchObject({ ready: false, team: TEAM_UNASSIGNED });
  });

  it(`pilot seats = maxPlayers; ${SPECTATOR_SLOTS} extra slots take watchers only`, () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'createRoom', settings: { name: 'Tiny', gameType: 'arena', subMode: 'deathmatch', maxPlayers: 2, botFill: 0 } });
    const id = a.last('roomState').roomId!;
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: id });
    startPlaying(zone, a);
    const room = roomsOf(zone).find((r) => r.id === id)!;
    expect(room.summary()).toMatchObject({ joinable: false, watchable: true, humans: 2 });
    const c = join(zone, 'Cee');
    c.send({ type: 'joinRoom', roomId: id });
    expect(c.last('error').message).toBe('That room is full.');
    c.send({ type: 'joinRoom', roomId: id, intent: 'play' });
    expect(c.last('error').message).toBe('That room is full.');
    const watchers: FakeClient[] = [];
    for (let i = 0; i < SPECTATOR_SLOTS; i++) {
      const x = join(zone, `W${i}`);
      x.send({ type: 'joinRoom', roomId: id, intent: 'watch' });
      expect(x.of('error')).toHaveLength(0);
      watchers.push(x);
    }
    expect(room.summary()).toMatchObject({ humans: 2 + SPECTATOR_SLOTS, spectators: SPECTATOR_SLOTS, watchable: false, joinable: false });
    const late = join(zone, 'Late');
    late.send({ type: 'joinRoom', roomId: id, intent: 'watch' });
    expect(late.last('error').message).toBe('That room is full.');
    // a watcher can't take a pilot seat while none is free...
    watchers[0].send({ type: 'setTeam', team: 0 });
    expect(watchers[0].chatTexts()).toContain(NO_SEAT_MSG);
    expect(meIn(watchers[0]).team).toBe(TEAM_UNASSIGNED);
    // ...but can once a pilot leaves
    b.send({ type: 'leaveRoom' });
    watchers[0].send({ type: 'setTeam', team: 0 });
    expect(meIn(watchers[0])).toMatchObject({ team: 0, inMatch: true });
  });

  it('fix #1: watchers never evict bots, even from a full room', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'createRoom', settings: { name: 'Full', gameType: 'arena', subMode: 'deathmatch', maxPlayers: 4, botFill: 4 } });
    const id = a.last('roomState').roomId!;
    startPlaying(zone, a);
    for (let i = 0; i < SPECTATOR_SLOTS; i++) join(zone, `W${i}`).send({ type: 'joinRoom', roomId: id, intent: 'watch' });
    expect(a.last('roomState').players.filter((p) => p.isBot)).toHaveLength(3);
    expect(a.last('roomState').players.filter((p) => !p.isBot)).toHaveLength(1 + SPECTATOR_SLOTS);
    expect(fake().world.ships.size).toBe(4);
  });

  it('same-network Watch is allowed by default (classrooms / households share one address)', () => {
    const zone = mkZone();
    const a = joinFrom(zone, 'Ace', '10.1.1.1');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const mate = joinFrom(zone, 'Classmate', '10.1.1.1');
    mate.send({ type: 'joinRoom', roomId: roomId(mate, 'Main Arena'), intent: 'watch' });
    expect(mate.of('error')).toHaveLength(0);
    expect(mate.last('matchStart').yourShipId).toBe(0);
    ticks(zone, 6);
    expect(mate.snaps.length).toBeGreaterThan(0);
    // a same-network pilot dropping in later doesn't cut the watcher off either
    const third = joinFrom(zone, 'Third', '10.1.1.1');
    third.send({ type: 'joinRoom', roomId: roomId(third, 'Main Arena'), intent: 'play' });
    expect(meIn(third).inMatch).toBe(true);
    expect(mate.last('roomState').roomId).not.toBeNull();
    expect(mate.chatTexts()).not.toContain(WATCH_SAME_NETWORK_MSG);
  });

  it('fix #2 (opt-in blockSameNetworkWatch): an online Watch from the network of a pilot in the room is refused (offline never)', () => {
    const zone = mkZone(false, undefined, true);
    const a = joinFrom(zone, 'Ace', '10.1.1.1');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const twin = joinFrom(zone, 'Twin', '10.1.1.1');
    twin.send({ type: 'joinRoom', roomId: roomId(twin, 'Main Arena'), intent: 'watch' });
    expect(twin.last('error').message).toBe(WATCH_SAME_NETWORK_MSG);
    expect(twin.last('roomState').roomId).toBeNull();
    // joining for a seat and then switching to spectate is refused the same way
    twin.send({ type: 'joinRoom', roomId: roomId(twin, 'Main Arena') });
    twin.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(twin.chatTexts()).toContain(WATCH_SAME_NETWORK_MSG);
    expect(twin.of('matchStart')).toHaveLength(0);
    const other = joinFrom(zone, 'Other', '10.2.2.2');
    other.send({ type: 'joinRoom', roomId: roomId(other, 'Main Arena'), intent: 'watch' });
    expect(other.of('error')).toHaveLength(0);
    expect(other.last('matchStart').yourShipId).toBe(0);

    const local = mkZone(true, [{ name: 'Solo Room', botFill: 2 }]);
    const s1 = joinFrom(local, 'Solo', '10.1.1.1');
    s1.send({ type: 'joinRoom', roomId: roomId(s1, 'Solo Room') });
    startPlaying(local, s1);
    const s2 = joinFrom(local, 'Two', '10.1.1.1');
    s2.send({ type: 'joinRoom', roomId: roomId(s2, 'Solo Room'), intent: 'watch' });
    expect(s2.of('error')).toHaveLength(0);
    expect(s2.last('matchStart').yourShipId).toBe(0);
  });

  it('fix #2: spectators never receive cloaked ships; pilots still see their own and nearby ones', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = join(zone, 'Watcher');
    w.send({ type: 'joinRoom', roomId: roomId(w, 'Main Arena'), intent: 'watch' });
    const world = fake().world;
    const me = shipOf(a);
    me.x = 1000; me.y = 1000; me.flags = SHIPFLAG_CLOAKED;
    const opp = [...world.ships.values()].find((x) => x.team === 1)!;
    opp.x = 1050; opp.y = 1000; opp.flags = SHIPFLAG_CLOAKED;
    ticks(zone, 3);
    const ws = w.snaps[w.snaps.length - 1];
    expect(ws.ships.some((v) => (v.flags & SHIPFLAG_CLOAKED) !== 0)).toBe(false);
    expect(ws.ships).toHaveLength(world.ships.size - 2);
    const as = a.snaps[a.snaps.length - 1];
    expect(as.ships.map((v) => v.id)).toEqual(expect.arrayContaining([me.id, opp.id]));
  });

  it("'quick' is server-internal: a joinRoom carrying it (LocalTransport skips validate.ts) is a plain join", () => {
    const zone = mkZone(true, [{ name: 'Solo Room', botFill: 2 }]);
    const a = join(zone, 'Solo');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Solo Room'), intent: 'quick' as never });
    expect(a.last('roomState').phase).toBe('lobby');
    expect(meIn(a).ready).toBe(false);
  });
});

describe('v0.3 M1: offline', () => {
  it('Quick Play joins the house room and starts the countdown at once; leaving stops the sim (bots-only abort)', () => {
    const zone = mkZone(true, houseRooms(true));
    const a = join(zone, 'Solo');
    expect(a.last('roomList').rooms.map((r) => r.name)).toEqual(['Offline Descent', 'Offline Arena', 'Offline Warzone']);
    expect(a.last('roomList').rooms.every((r) => r.house)).toBe(true);
    a.send({ type: 'quickPlay', gameType: 'warzone' });
    expect(a.last('roomState')).toMatchObject({ phase: 'countdown' });
    expect(a.last('roomState').settings.name).toBe('Offline Warzone');
    expect(a.chatTexts()).toContain('Quick Play → Offline Warzone (Classic). Launching now.');
    ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
    expect(a.last('matchStart').yourShipId).toBeGreaterThan(0);
    a.send({ type: 'leaveRoom' });
    ticks(zone, BOTS_ONLY_ABORT_SEC * TICK_RATE + 2);
    const room = roomNamed(zone, 'Offline Warzone');
    expect(room.phase).toBe('lobby');
    expect(room.sim).toBeNull();
    expect(a.of('matchEnd')).toHaveLength(0);
  });

  it(`custom games are capped at ${LOCAL_MAX_CUSTOM_ROOMS}: a new one closes the oldest one without a human`, () => {
    const zone = mkZone(true, houseRooms(true));
    const a = join(zone, 'Solo');
    for (let i = 1; i <= 4; i++) a.send({ type: 'createRoom', settings: { name: `Custom ${i}`, gameType: 'arena', subMode: 'deathmatch' } });
    expect(a.of('error')).toHaveLength(0);
    expect(a.last('roomState').settings.name).toBe('Custom 4');
    expect(roomsOf(zone).map((r) => r.settings.name)).toEqual(['Offline Descent', 'Offline Arena', 'Offline Warzone', 'Custom 2', 'Custom 3', 'Custom 4']);
  });

  it("Create refuses a game type that isn't open yet", () => {
    preM4();
    const zone = mkZone(true, houseRooms(true));
    const a = join(zone, 'Solo');
    a.send({ type: 'createRoom', settings: { name: 'Deep', gameType: 'dungeon' } });
    expect(a.last('error').message).toBe("Dungeon Runner isn't open yet.");
    expect(a.last('roomState').roomId).toBeNull();
  });
});

describe('v0.3 M1: room guards', () => {
  it('bots-only abort: a watcher keeps the match alive; with nobody left it returns to the lobby silently', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const w = join(zone, 'Watcher');
    w.send({ type: 'joinRoom', roomId: roomId(w, 'Main Arena'), intent: 'watch' });
    a.send({ type: 'leaveRoom' });
    ticks(zone, (BOTS_ONLY_ABORT_SEC + 2) * TICK_RATE);
    const room = roomNamed(zone, 'Main Arena');
    expect(room.phase).toBe('playing');
    w.send({ type: 'leaveRoom' });
    ticks(zone, BOTS_ONLY_ABORT_SEC * TICK_RATE - 5);
    expect(room.phase).toBe('playing');
    ticks(zone, 10);
    expect(room.phase).toBe('lobby');
    expect(a.of('matchEnd')).toHaveLength(0);
    expect(w.of('matchEnd')).toHaveLength(0);
  });

  it(`playing cap: at most ${MAX_PLAYING_ROOMS} rooms run at once online; the next launch waits for a free slot`, () => {
    const n = MAX_PLAYING_ROOMS + 1;
    const zone = mkZone(false, Array.from({ length: n }, (_, i) => ({ name: `R${i}`, botFill: 0 })));
    const cs: FakeClient[] = [];
    for (let i = 0; i < n; i++) {
      const c = join(zone, `P${i}`);
      c.send({ type: 'joinRoom', roomId: roomId(c, `R${i}`) });
      c.send({ type: 'startMatch' });
      cs.push(c);
    }
    ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
    expect(roomsOf(zone).filter((r) => r.phase === 'playing')).toHaveLength(MAX_PLAYING_ROOMS);
    const last = roomNamed(zone, `R${n - 1}`);
    expect(last.phase).toBe('lobby');
    expect(cs[n - 1].chatTexts()).toContain(START_WAIT_MSG);
    expect(cs[n - 1].chatTexts().filter((t) => t === START_WAIT_MSG)).toHaveLength(1); // said once, re-checked quietly
    cs[0].send({ type: 'chat', channel: 'all', text: '/end' }); // results don't count against the cap
    ticks(zone, TICK_RATE + 1);
    expect(['countdown', 'playing']).toContain(last.phase);
  });
});

describe('v0.3 M1: host settings', () => {
  it('/type /sub /mode /floors /target /pve follow the game-type rules', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const undo = preM3(); // this pins the M1 rules for sub-modes that aren't open (CTF / Zones / Hot Point opened in M3, co-op in M4)
    try {
      let t = Date.now();
      const zone = mkZone();
      const a = join(zone, 'Ace');
      const say = (text: string): void => { t += 1100; vi.setSystemTime(t); a.send({ type: 'chat', channel: 'all', text }); };
      a.send({ type: 'createRoom', settings: { name: 'Mine' } });
      const st = () => a.last('roomState').settings;
      say('/type dungeon');
      expect(a.chatTexts()).toContain("Dungeon Runner isn't open yet.");
      expect(st().gameType).toBe('warzone');
      say('/sub zones');
      expect(a.chatTexts().some((x) => x.startsWith("Control Zones isn't open yet"))).toBe(true);
      say('/type arena');
      expect(st()).toMatchObject({ gameType: 'arena', subMode: 'deathmatch', pveIntensity: 0, maxPlayers: 16, botFill: 10, name: 'Mine' });
      expect(a.chatTexts().some((x) => x.startsWith('Settings: type Arena, Deathmatch'))).toBe(true);
      say('/pve 2');
      expect(a.chatTexts()).toContain('Arena has no swarm.');
      say('/floors 3');
      expect(a.chatTexts()).toContain('Floors are a Dungeon Runner setting.');
      say('/target 5');
      expect(a.chatTexts().some((x) => x.includes('has no objective target'))).toBe(true);
      say('/mode ffa');
      expect(st().mode).toBe('ffa');
      say('/mode teams 9');
      expect(a.chatTexts()).toContain('Deathmatch allows 2-8 teams.');
      say('/sub dm');
      say('/help');
      expect(a.chatTexts().some((x) => x.startsWith('Host: /type'))).toBe(true);
    } finally {
      undo();
      vi.useRealTimers();
    }
  });

  it('lobby-only settings are locked while a match runs; seated pilots and house rooms are protected', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    a.send({ type: 'updateSettings', settings: { gameType: 'arena' } });
    expect(a.chatTexts().some((x) => x.includes('built-in room'))).toBe(true);
    expect(a.last('roomState').settings.gameType).toBe('warzone');
    a.send({ type: 'createRoom', settings: { name: 'Mine' } });
    const id = a.last('roomState').roomId!;
    join(zone, 'Bee').send({ type: 'joinRoom', roomId: id });
    join(zone, 'Cee').send({ type: 'joinRoom', roomId: id });
    a.send({ type: 'updateSettings', settings: { maxPlayers: 2 } });
    expect(a.chatTexts()).toContain('3 pilots are seated — those settings allow only 2.');
    expect(a.last('roomState').settings.maxPlayers).toBe(32);
    startPlaying(zone, a);
    a.send({ type: 'updateSettings', settings: { subMode: 'deathmatch', mode: 'ffa', teamCount: 4, matchMinutes: 5 } });
    expect(a.last('roomState').settings).toMatchObject({ mode: 'teams', teamCount: 2, matchMinutes: 5 });
    expect(a.chatTexts()).toContain('Game type, mode, teams and floors can only change in the lobby.');
    expect(a.chatTexts().some((x) => x.includes('apply next match'))).toBe(true);
  });
});

describe('v0.3 M1: match wiring', () => {
  it('SimConfig / matchStart / snapshots / results carry the game type; the loot seed never leaves the server', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const cfg = fake().world.config;
    // M2: one human online in a Warzone = the solo anti-farm multiplier (§6.4.6).
    expect(cfg).toMatchObject({ gameType: 'warzone', subMode: 'deathmatch', floors: 0, objectiveLimit: 0, lootMult: 0.5, matchSeconds: 600 });
    expect(Number.isInteger(cfg.lootSeed)).toBe(true);
    expect(cfg.lootSeed).toBeGreaterThanOrEqual(0);
    expect(a.last('matchStart')).toMatchObject({ gameType: 'warzone', subMode: 'deathmatch', floor: 0 });
    ticks(zone, 3);
    const m = a.snaps[a.snaps.length - 1].match;
    expect(m).toMatchObject({ timed: true, gameType: 'warzone', subMode: 'deathmatch' });
    expect(m.dungeon).toBeUndefined();
    expect(m.objective).toBeUndefined();
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(a.last('matchEnd').result).toMatchObject({ gameType: 'warzone', subMode: 'deathmatch' });
    expect(JSON.stringify(a.msgs) + JSON.stringify(a.snaps)).not.toContain('lootSeed');
  });

  it('every snapshot viewer shares one MatchView per snapshot tick (the codec memoizes its JSON)', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena') });
    startPlaying(zone, a);
    ticks(zone, 3);
    expect(a.snaps[a.snaps.length - 1].match).toBe(b.snaps[b.snaps.length - 1].match);
  });
});

describe('v0.3 M1 integration fixes', () => {
  it("a joiner's first room message is its roomState — before the history, the tells and a drop-in's matchStart", () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    for (const intent of ['play', 'watch', 'quick'] as const) {
      const c = join(zone, `J-${intent}`);
      const from = c.order.length;
      if (intent === 'quick') c.send({ type: 'quickPlay', gameType: 'warzone' });
      else c.send({ type: 'joinRoom', roomId: roomId(c, 'Main Arena'), intent });
      const seq = c.order.slice(from);
      expect(seq[0]).toBe('roomState');
      expect(seq.indexOf('chatHistory')).toBeGreaterThan(0);
      expect(seq.indexOf('matchStart')).toBeGreaterThan(seq.indexOf('chatHistory'));
      const first = c.msgs[from] as Extract<ServerMsg, { type: 'roomState' }>;
      expect(first.roomId).toBe(roomId(c, 'Main Arena'));
    }
  });

  it("SEC-3: Quick Play overflow rooms count against the per-address cap and recycle the connection's last room", () => {
    const zone = mkZone(false, [{ name: 'Pit', gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', maxPlayers: 2, botFill: 0 }]);
    for (const n of ['F1', 'F2']) {
      const f = joinFrom(zone, n, n === 'F1' ? '10.9.9.1' : '10.9.9.2');
      f.send({ type: 'joinRoom', roomId: roomId(f, 'Pit') });
    }
    expect(roomNamed(zone, 'Pit').activeHumanCount).toBe(2); // full: every arena Quick Play needs an overflow room
    const ADDR = '203.0.113.5';
    const xs = Array.from({ length: MAX_ROOMS_PER_ADDRESS + 2 }, (_, i) => joinFrom(zone, `X${i}`, ADDR));
    for (const x of xs) {
      for (let k = 0; k < 3; k++) {
        x.send({ type: 'quickPlay', gameType: 'arena' });
        x.send({ type: 'chat', channel: 'all', text: '/type warzone' }); // hide it from the next Quick Play
      }
    }
    const created = roomsOf(zone).filter((r) => r.userCreated);
    expect(created.every((r) => r.creatorAddress === ADDR)).toBe(true);
    expect(created.length).toBe(MAX_ROOMS_PER_ADDRESS); // one per connection (recycled), capped per address
    expect(xs[MAX_ROOMS_PER_ADDRESS].last('error').message).toMatch(/already has 6 rooms open/);
    expect(xs[MAX_ROOMS_PER_ADDRESS].last('roomState').roomId).toBeNull();
    // another network still gets its overflow room
    const other = joinFrom(zone, 'Elsewhere', '198.51.100.1');
    other.send({ type: 'quickPlay', gameType: 'arena' });
    expect(other.of('error')).toHaveLength(0);
    expect(other.last('roomState').settings.name).toMatch(/^Arena · CTF #\d+$/); // M3: Arena's own default is open
  });

  it('fix #2 (opt-in blockSameNetworkWatch): only pilots who fly the match block a same-network Watch; one dropping in later cuts the watcher off', () => {
    const zone = mkZone(false, undefined, true);
    const a = joinFrom(zone, 'Ace', '10.1.1.1');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const mate = joinFrom(zone, 'Mate', '10.3.3.3');
    mate.send({ type: 'joinRoom', roomId: roomId(mate, 'Main Arena') }); // in the room lobby, not flying
    const w = joinFrom(zone, 'Mw', '10.3.3.3');
    w.send({ type: 'joinRoom', roomId: roomId(w, 'Main Arena'), intent: 'watch' });
    expect(w.of('error')).toHaveLength(0);
    expect(w.last('matchStart').yourShipId).toBe(0);
    ticks(zone, 6);
    expect(w.snaps.length).toBeGreaterThan(0);
    mate.send({ type: 'joinMatch' });
    expect(meIn(mate).inMatch).toBe(true);
    expect(w.last('roomState').roomId).toBeNull(); // back on Command
    expect(w.chatTexts()).toContain(WATCH_SAME_NETWORK_MSG);
    const n = w.snaps.length;
    ticks(zone, 6);
    expect(w.snaps.length).toBe(n);
    expect(roomNamed(zone, 'Main Arena').summary().spectators).toBe(0);
    // offline (one trusted device) never cuts anyone off
    const local = mkZone(true, [{ name: 'Solo Room', botFill: 2 }]);
    const s1 = joinFrom(local, 'Solo', '10.1.1.1');
    s1.send({ type: 'joinRoom', roomId: roomId(s1, 'Solo Room') });
    startPlaying(local, s1);
    const s2 = joinFrom(local, 'Two', '10.1.1.1');
    s2.send({ type: 'joinRoom', roomId: roomId(s2, 'Solo Room'), intent: 'watch' });
    const s3 = joinFrom(local, 'Three', '10.1.1.1');
    s3.send({ type: 'joinRoom', roomId: roomId(s3, 'Solo Room'), intent: 'play' });
    expect(meIn(s3).inMatch).toBe(true);
    expect(s2.last('roomState').roomId).not.toBeNull();
    expect(s2.chatTexts()).not.toContain(WATCH_SAME_NETWORK_MSG);
  });

  it('Quick Play from a spectator seat of a full room moves to a room with a free seat (and readies there)', () => {
    const zone = mkZone(false, [
      { name: 'Tiny', gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', maxPlayers: 2, botFill: 0 },
      { name: 'Big', gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', maxPlayers: 16, botFill: 0 },
    ]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Tiny') });
    const s = join(zone, 'Spec');
    s.send({ type: 'joinRoom', roomId: roomId(s, 'Tiny') });
    s.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Tiny') });
    expect(roomNamed(zone, 'Tiny').activeHumanCount).toBe(2);
    s.send({ type: 'quickPlay', gameType: 'arena' });
    expect(s.last('roomState').settings.name).toBe('Big');
    expect(meIn(s).ready).toBe(true);
    expect(roomNamed(zone, 'Tiny').humans.every((p) => !p.ready)).toBe(true);
  });

  it('§3.2: a botFill change mid-match applies at the next match', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    const bots = () => a.last('roomState').players.filter((p) => p.isBot).length;
    expect(bots()).toBe(11);
    a.send({ type: 'updateSettings', settings: { botFill: 4 } });
    expect(a.last('roomState').settings.botFill).toBe(4);
    expect(bots()).toBe(11);
    expect(a.chatTexts().some((t) => t.startsWith('Settings: bots 4') && t.includes('(match settings apply next match)'))).toBe(true);
    const late = join(zone, 'Late');
    late.send({ type: 'joinRoom', roomId: roomId(late, 'Main Arena'), intent: 'play' });
    expect(bots()).toBe(10); // a drop-in still takes a bot's seat under the match's own fill
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(a.last('roomState').phase).toBe('lobby');
    expect(bots()).toBe(2);
  });

  it("a settings patch with a sub-mode that isn't open (or isn't the type's) is refused, not half-applied", () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    a.send({ type: 'createRoom', settings: { name: 'Mine', gameType: 'arena' } });
    // M3: Arena's default (CTF) is open, with its own length
    expect(a.last('roomState').settings).toMatchObject({ gameType: 'arena', subMode: 'ctf', matchMinutes: 12 });
    a.send({ type: 'updateSettings', settings: { matchMinutes: 5 } });
    const n = a.chatTexts().length;
    a.send({ type: 'updateSettings', settings: { subMode: 'escort' } }); // reserved for v0.4
    expect(a.chatTexts().slice(n)).toEqual(["Escort isn't open yet."]);
    a.send({ type: 'updateSettings', settings: { subMode: 'coop' } });
    expect(a.chatTexts()).toContain('Arena has no such mode.');
    expect(a.last('roomState').settings).toMatchObject({ subMode: 'ctf', matchMinutes: 5 });
  });

  it('no dungeon Sim can start while coop is not ready (every path refuses the type)', () => {
    // Pinned: the rule holds for any not-ready sub-mode, whatever the integrator has flipped since.
    const was = SUB_MODES.coop.ready;
    SUB_MODES.coop.ready = false;
    onTestFinished(() => { SUB_MODES.coop.ready = was; });
    const zone = mkZone(false, houseRooms(false));
    const a = join(zone, 'Ace');
    expect(a.last('roomList').rooms.some((r) => r.gameType === 'dungeon')).toBe(false);
    a.send({ type: 'createRoom', settings: { name: 'Deep', gameType: 'dungeon' } });
    a.send({ type: 'quickPlay', gameType: 'dungeon' });
    expect(a.of('error').map((e) => e.message).filter((m) => m === "Dungeon Runner isn't open yet.")).toHaveLength(2);
    a.send({ type: 'createRoom', settings: { name: 'Mine', gameType: 'arena' } });
    a.send({ type: 'updateSettings', settings: { gameType: 'dungeon' } });
    a.send({ type: 'updateSettings', settings: { gameType: 'dungeon', subMode: 'coop' } });
    expect(a.last('roomState').settings.gameType).toBe('arena');
    startPlaying(zone, a);
    expect(fake().world.config.gameType).toBe('arena');
    expect(roomsOf(zone).every((r) => r.settings.gameType !== 'dungeon')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// v0.3 M2: loot wiring (docs/v0.3-proposal.md §6.4.6, §6.6, §7.3; §9 ROOM acceptance)
// Real ProfileService + MemoryProfileStore (LOOT); the Room's GrantInputs are captured with a spy.
// ---------------------------------------------------------------------------------------------

function mkLootZone(store: ProfileStore | undefined, local = false, rooms: ConstructorParameters<typeof Zone>[0]['defaultRooms'] = [
  { name: 'Main Arena', mode: 'teams', teamCount: 2, botFill: 4 },
]): Zone {
  return new Zone({ snapshotEvery: 3, defaultRooms: rooms, motd: 'hi', local, profiles: store });
}
/** A stored profile owning `ids` (starters are implicit). */
function ownedProfile(...ids: string[]): ReturnType<typeof defaultProfile> {
  const p = defaultProfile(1);
  for (const id of ids) p.owned[id] = { at: 1, src: 'arena' };
  return p;
}
const tok = (rarity: CacheToken['rarity'], set: CacheToken['set'] = 'common', source: CacheToken['source'] = 'elite'): CacheToken =>
  ({ rarity, set, source });
const infoOf = (c: FakeClient, pid: number) => c.last('roomState').players.find((p) => p.playerId === pid)!;
/** Fast-forward the running match's clock (the FakeSim never ends a match by itself). */
function advance(sec: number): void { fake().world.tick += Math.round(sec * TICK_RATE); }

describe('v0.3 M2: profiles and looks', () => {
  it('hello attaches the profile: accounts and offline get `profile` right after welcome; online guests never do', () => {
    const store = new MemoryProfileStore();
    store.save('acc-Ace', ownedProfile('com.hull.brute'));
    const zone = mkLootZone(store);
    const a = join(zone, 'Ace', acct('Ace'));
    expect(a.msgs.slice(0, 3).map((m) => m.type)).toEqual(['welcome', 'profile', 'roomList']);
    expect(a.last('profile').persisted).toBe(true);
    expect(a.last('profile').profile.owned['com.hull.brute']).toBeTruthy();
    const g = join(zone, 'Gus');
    expect(g.of('profile')).toHaveLength(0);
    const off = join(mkLootZone(undefined, true), 'Solo');
    expect(off.msgs.slice(0, 2).map((m) => m.type)).toEqual(['welcome', 'profile']); // key 'local'
    expect(off.last('profile').persisted).toBe(false); // no device store injected here: session-only
  });

  it('PlayerInfo.cosmetics: profile looks for pilots, botWardrobe for bots, none for online guests; equip and class follow at once', () => {
    const store = new MemoryProfileStore();
    store.save('acc-Ace', ownedProfile('com.hull.brute', 'com.engine.aurora'));
    const zone = mkLootZone(store);
    const a = join(zone, 'Ace', acct('Ace'));
    const g = join(zone, 'Gus');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    g.send({ type: 'joinRoom', roomId: roomId(g, 'Main Arena') });
    expect(infoOf(a, a.pid).cosmetics).toEqual({}); // starters are omitted
    expect(infoOf(a, g.pid).cosmetics).toBeUndefined(); // guests patch their own look on their device
    const room = roomNamed(zone, 'Main Arena');
    const bots = room.allPlayers.filter((p) => p.isBot);
    expect(bots.length).toBeGreaterThan(0);
    for (const b of bots) expect(infoOf(a, b.playerId).cosmetics).toEqual(botWardrobe(b.seed, 'warzone', b.shipClass));

    // Hangar ops are the Zone's: saved, pushed, and the room re-sends the look (never forwarded as a room message).
    const chats = a.of('chat').length;
    a.send({ type: 'equip', slot: 'hull', itemId: 'com.hull.brute', shipClass: 'brute' });
    a.send({ type: 'equip', slot: 'engine', itemId: 'com.engine.aurora' });
    expect(infoOf(a, a.pid).cosmetics).toEqual({ hull: 'com.hull.brute', engine: 'com.engine.aurora' });
    expect(infoOf(g, a.pid).cosmetics).toEqual({ hull: 'com.hull.brute', engine: 'com.engine.aurora' });
    expect(a.last('profile').profile.loadout.byClass.brute?.hull).toBe('com.hull.brute');
    expect((store.load('acc-Ace') as { loadout: { shared: { engine?: string } } }).loadout.shared.engine).toBe('com.engine.aurora');
    expect(a.of('chat').length).toBe(chats);
    a.send({ type: 'equip', slot: 'hull', itemId: 'swarm.hull.tech', shipClass: 'tech' }); // not owned
    expect(a.last('error').message).toMatch(/own/i);

    // hull / weapon / turret follow the selected class
    a.send({ type: 'setShip', shipClass: 'tech' });
    expect(infoOf(a, a.pid).cosmetics).toEqual({ engine: 'com.engine.aurora' });
    a.send({ type: 'setShip', shipClass: 'brute' });
    expect(infoOf(a, a.pid).cosmetics).toEqual({ hull: 'com.hull.brute', engine: 'com.engine.aurora' });

    // mid-match equips apply immediately (looks travel in roomState, never in snapshots)
    startPlaying(zone, a);
    a.send({ type: 'equip', slot: 'hull', itemId: '', shipClass: 'brute' });
    expect(infoOf(g, a.pid).cosmetics).toEqual({ engine: 'com.engine.aurora' });
    ticks(zone, 3);
    expect(JSON.stringify(g.snaps[g.snaps.length - 1])).not.toContain('com.engine.aurora');
  });

  it('bots are re-dressed from the new mode set when the game type changes', () => {
    const zone = mkLootZone(undefined);
    const a = join(zone, 'Ace');
    a.send({ type: 'createRoom', settings: { name: 'Mine', gameType: 'warzone', botFill: 6 } });
    a.send({ type: 'chat', channel: 'all', text: '/type arena' });
    const room = roomNamed(zone, 'Mine');
    expect(room.settings.gameType).toBe('arena');
    for (const b of room.allPlayers.filter((p) => p.isBot)) {
      expect(infoOf(a, b.playerId).cosmetics).toEqual(botWardrobe(b.seed, 'arena', b.shipClass));
    }
  });
});

describe('v0.3 M2: lootMult (anti-farm, §6.4.6)', () => {
  it('online: the solo multiplier for one human, 1.0 for two; updated as humans drop in, leave or spectate', () => {
    const zone = mkLootZone(undefined);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    expect(fake().world.config.lootMult).toBe(LOOT_MULT_SOLO.warzone);
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: roomId(b, 'Main Arena'), intent: 'play' });
    expect(b.last('matchStart')).toBeTruthy();
    expect(fake().lootMult).toBe(1);
    b.send({ type: 'leaveRoom' });
    expect(fake().lootMult).toBe(LOOT_MULT_SOLO.warzone);
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(fake().lootMult).toBe(0); // nobody left who can pick a cache up
  });

  it('Arena solo is 0.35; offline is always 1.0', () => {
    const arena = mkLootZone(undefined, false, [{ name: 'Pit', gameType: 'arena', subMode: 'deathmatch', mode: 'teams', teamCount: 2, botFill: 2 }]);
    const a = join(arena, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Pit') });
    startPlaying(arena, a);
    expect(fake().world.config.lootMult).toBe(LOOT_MULT_SOLO.arena);
    const off = mkLootZone(undefined, true);
    const o = join(off, 'Solo');
    o.send({ type: 'joinRoom', roomId: roomId(o, 'Main Arena') });
    startPlaying(off, o);
    expect(fake().world.config.lootMult).toBe(1);
  });
});

describe('v0.3 M2: grants', () => {
  let store: MemoryProfileStore;
  let zone: Zone;
  let a: FakeClient;
  let g: FakeClient;
  let spy: MockInstance<ProfileService['grantBatch']>;
  const entries = (): GrantEntry[] => (spy.mock.calls as unknown as [GrantEntry[]][]).flatMap((c) => c[0]);
  const entryOf = (key: string): GrantEntry | undefined => entries().filter((e) => e.profileKey === key).pop();
  beforeEach(() => {
    store = new MemoryProfileStore();
    zone = mkLootZone(store);
    spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    a = join(zone, 'Ace', acct('Ace'));
    g = join(zone, 'Gus');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    g.send({ type: 'joinRoom', roomId: roomId(g, 'Main Arena') });
  });
  afterEach(() => { spy.mockRestore(); });

  it('at results: ONE batch for the humans (bots excluded), keyed matchId#profileKey#0; survivors bank their carried caches; matchEnd, then lootGrant', () => {
    startPlaying(zone, a);
    const room = roomNamed(zone, 'Main Arena');
    const carried = [tok(4, 'swarm', 'boss'), tok(0)];
    shipOf(a).carried = carried.slice();
    const bot = room.allPlayers.find((p) => p.isBot)!;
    const botShip = fake().world.ships.get(fake().world.shipsByPlayer.get(bot.playerId)!)!;
    botShip.carried = [tok(1)];
    advance(CRATE_MIN_MATCH_SEC + 20);
    ticks(zone, 1);
    a.send({ type: 'chat', channel: 'all', text: '/end' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(entries().map((e) => e.profileKey).sort()).toEqual(['acc-Ace', `guest:${g.pid}`].sort());
    expect(room.matchId).toMatch(/^[0-9a-z]+:1$/); // `${bootId}:${n}`
    const ea = entryOf('acc-Ace')!;
    expect(ea.user?.playerId).toBe(a.pid);
    expect(ea.input).toMatchObject({ grantKey: `${room.matchId}#acc-Ace#0`, gameType: 'warzone', tokens: carried, cachesLost: 0 });
    expect(ea.input.crateRolls).toBeGreaterThanOrEqual(1);
    expect(ea.input.shards).toBeGreaterThanOrEqual(SHARDS_BASE + 3); // 200 s flown = 3 full minutes
    expect(entryOf(`guest:${g.pid}`)!.input.grantKey).toBe(`${room.matchId}#guest:${g.pid}#0`);
    expect(shipOf(a).carried).toEqual([]); // taken (secured) at match end
    expect(botShip.carried).toHaveLength(1); // bots never receive grants

    expect(a.order.indexOf('matchEnd')).toBeLessThan(a.order.lastIndexOf('lootGrant'));
    expect(a.last('lootGrant')).toMatchObject({ persisted: true, grant: { grantKey: ea.input.grantKey } });
    expect(g.last('lootGrant').persisted).toBe(false); // guest: applied to the device profile
    expect(store.hasGrant('acc-Ace', ea.input.grantKey)).toBe(true);
    // the legendary Swarm cache is the set's legendary: a public highlight + a chat line; the profile owns it
    const res = a.last('matchEnd').result;
    expect(res.lootHighlights).toContainEqual({ playerId: a.pid, itemId: 'swarm.turret.laser', rarity: 4 });
    expect(a.chatTexts()).toContain("Ace unboxed Queen's Gaze — Legendary!");
    expect(a.last('profile').profile.owned['swarm.turret.laser']).toBeTruthy();
  });

  it(`the ${CRATE_MIN_PLAYED_SEC} s played / ${CRATE_MIN_MATCH_SEC} s match gates; an early /end voids crates and base shards (caches still count)`, () => {
    startPlaying(zone, a);
    shipOf(a).carried = [tok(1)];
    advance(30);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(entryOf('acc-Ace')!.input).toMatchObject({ crateRolls: 0, shards: 0, tokens: [tok(1)] });
    expect(entryOf(`guest:${g.pid}`)).toBeUndefined(); // nothing at all to grant: no grant, no ledger row
    expect(a.of('lootGrant')).toHaveLength(1);
    expect(g.of('lootGrant')).toHaveLength(0);

    // next match: a late drop-in with < 120 s flown gets no crates while the first pilot does
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    spy.mockClear();
    g.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    startPlaying(zone, a);
    advance(CRATE_MIN_MATCH_SEC - 30);
    g.send({ type: 'setTeam', team: 1 });
    ticks(zone, 1);
    expect(g.last('matchStart')).toBeTruthy();
    shipOf(g).carried = [tok(0)];
    advance(60);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(entryOf('acc-Ace')!.input.crateRolls).toBeGreaterThanOrEqual(1);
    expect(entryOf(`guest:${g.pid}`)!.input).toMatchObject({ crateRolls: 0, shards: 0, tokens: [tok(0)] });
  });

  it('a leaver gets the secured bank (crateRolls 0) BEFORE the carried caches spill; a rejoin gets the next seq key', () => {
    startPlaying(zone, a);
    const room = roomNamed(zone, 'Main Arena');
    const w = fake().world;
    w.events.push({ t: 'lootSecured', playerId: a.pid, how: 'extract', tokens: [tok(2, 'swarm')] });
    ticks(zone, 1); // noteEvents banks it
    shipOf(a).carried = [tok(0), tok(1)];
    g.send({ type: 'leaveRoom' }); // nothing secured: nothing to grant
    expect(spy).not.toHaveBeenCalled();
    a.send({ type: 'leaveRoom' });
    expect(spy).toHaveBeenCalledTimes(1);
    const e1 = entryOf('acc-Ace')!;
    expect(e1.input).toMatchObject({
      grantKey: `${room.matchId}#acc-Ace#0`, tokens: [tok(2, 'swarm')], crateRolls: 0, shards: 0, won: false,
      cachesLost: 2, // counted while the ship still carried them: the grant ran before removePlayer
    });
    expect(a.last('lootGrant')).toMatchObject({ persisted: true, grant: { grantKey: e1.input.grantKey } });
    expect(store.hasGrant('acc-Ace', e1.input.grantKey)).toBe(true);
    // what the real removePlayer emits for those 2 carried caches (drained on the next tick)
    w.events.push({ t: 'lootSpill', playerId: a.pid, x: 1000, y: 1000, count: 2, best: 1 });

    // back in the same match (before that tick): the results grant is seq 1, the bank was not granted twice,
    // and the 2 spilled caches the leave grant already counted are not counted again
    a.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    ticks(zone, 4 * TICK_RATE); // SEC-2 rejoin delay
    expect(shipOf(a)).toBeTruthy();
    advance(CRATE_MIN_MATCH_SEC);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    const e2 = entryOf('acc-Ace')!;
    expect(e2.input.grantKey).toBe(`${room.matchId}#acc-Ace#1`);
    expect(e2.input.tokens).toEqual([]);
    expect(e2.input.cachesLost).toBe(0);
  });

  it('idempotent: results grant once per match; a replayed batch is recognized by the ledger and changes nothing', () => {
    startPlaying(zone, a);
    const room = roomNamed(zone, 'Main Arena');
    shipOf(a).carried = [tok(3, 'swarm')];
    advance(CRATE_MIN_MATCH_SEC + 5);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    const batch = entries();
    expect(batch).toHaveLength(2);
    room.enterResults(); // already in results: no second grant
    expect(spy).toHaveBeenCalledTimes(1);
    const writes = store.writes;
    const profileBefore = JSON.stringify(store.load('acc-Ace'));
    const host = (room as unknown as { host: RoomHost }).host;
    const again = host.grantLoot(batch);
    expect(again[batch.findIndex((e) => e.profileKey === 'acc-Ace')]).toMatchObject({ duplicate: true, persisted: true });
    expect(store.writes).toBe(writes);
    expect(JSON.stringify(store.load('acc-Ace'))).toBe(profileBefore);
    // the next match has a new matchId, so its keys never collide with this one's
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    const first = room.matchId;
    startPlaying(zone, a);
    expect(room.matchId).not.toBe(first);
  });

  it('a duplicate outcome (key already recorded) is never sent or announced again', () => {
    spy.mockImplementation((batch) => batch.map((e) => ({
      grant: { grantKey: e.input.grantKey, gameType: 'warzone', items: [{ itemId: 'swarm.turret.laser', rarity: 4, from: 'cache', dupe: false, shards: 0 }], shards: 5, cachesSecured: 1, cachesLost: 0, epicIn: 12, legendaryIn: 60 },
      persisted: true, duplicate: true,
    })));
    startPlaying(zone, a);
    shipOf(a).carried = [tok(4, 'swarm', 'boss')];
    advance(CRATE_MIN_MATCH_SEC + 5);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.last('matchEnd')).toBeTruthy();
    expect(a.of('lootGrant')).toHaveLength(0);
    expect(a.last('matchEnd').result.lootHighlights).toBeUndefined();
    expect(a.chatTexts().some((t) => /unboxed/.test(t))).toBe(false);
  });

  it('a failing grantLoot never aborts the match: results, lobby and the next match all still happen', () => {
    spy.mockImplementation(() => { throw new Error('boom'); });
    startPlaying(zone, a);
    shipOf(a).carried = [tok(1)];
    advance(CRATE_MIN_MATCH_SEC + 5);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(a.last('matchEnd')).toBeTruthy();
    expect(a.of('lootGrant')).toHaveLength(0);
    expect(a.last('roomState').phase).toBe('results');
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(a.last('roomState').phase).toBe('lobby');
    startPlaying(zone, a);
    expect(a.last('roomState').phase).toBe('playing');
  });

  it('a store failure queues the grant (persisted: false) and a later housekeeping pass commits it', () => {
    startPlaying(zone, a);
    shipOf(a).carried = [tok(2, 'swarm')];
    advance(CRATE_MIN_MATCH_SEC + 5);
    store.failNext = 1;
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    const key = entryOf('acc-Ace')!.input.grantKey;
    expect(a.last('lootGrant')).toMatchObject({ persisted: false, grant: { grantKey: key } });
    expect(store.hasGrant('acc-Ace', key)).toBe(false);
    ticks(zone, PROFILE_RETRY_SEC * TICK_RATE + 1);
    expect(store.hasGrant('acc-Ace', key)).toBe(true);
    expect(a.of('error').map((e) => e.message)).not.toContain(LOOT_NOT_SAVED_MSG);
  });

  it('spills count as caches lost; epic+ drops and big spills get a chat line', () => {
    startPlaying(zone, a);
    const w = fake().world;
    w.events.push({ t: 'lootSpill', playerId: a.pid, x: 1000, y: 1000, count: 5, best: 3 });
    ticks(zone, 1);
    expect(a.chatTexts()).toContain('Ace spilled 5 caches, an Epic among them! Grab them.');
    ticks(zone, TICK_RATE);
    w.events.push({ t: 'lootDrop', id: 777, x: 1000, y: 1000, rarity: 4, set: 'swarm', source: 'boss' });
    w.events.push({ t: 'lootDrop', id: 778, x: 1000, y: 1000, rarity: 2, set: 'common', source: 'elite' });
    ticks(zone, 1);
    expect(a.chatTexts()).toContain('A Legendary Swarm Cache dropped!');
    expect(a.chatTexts().some((t) => t.includes('Rare'))).toBe(false);
    w.events.push({ t: 'lootSpill', playerId: g.pid, x: 1000, y: 1000, count: 1, best: 0 });
    ticks(zone, TICK_RATE);
    expect(a.chatTexts().some((t) => t.startsWith('Gus spilled'))).toBe(false); // small spills stay quiet
    advance(CRATE_MIN_MATCH_SEC);
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    expect(entryOf('acc-Ace')!.input.cachesLost).toBe(5);
    expect(entryOf(`guest:${g.pid}`)!.input.cachesLost).toBe(1);
  });
});

describe('v0.3 M2: snapshot loot', () => {
  it('caches near the focus + every epic+ cache; expired reservations read 0; carry for visible carriers; you.carried sorted', () => {
    const zone = mkLootZone(undefined);
    const a = join(zone, 'Ace');
    const g = join(zone, 'Gus');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    g.send({ type: 'joinRoom', roomId: roomId(g, 'Main Arena') });
    a.send({ type: 'setTeam', team: 0 });
    g.send({ type: 'setTeam', team: TEAM_UNASSIGNED }); // spectator
    startPlaying(zone, a);
    const w = fake().world;
    const me = shipOf(a);
    me.x = 1000; me.y = 1000;
    const drop = (id: number, x: number, y: number, rarity: LootDrop['token']['rarity'], extra: Partial<LootDrop> = {}): void => {
      w.loot!.set(id, {
        id, x, y, vx: 0, vy: 0, token: tok(rarity, 'swarm'), spawnTick: w.tick, expireTick: w.tick + 90 * TICK_RATE,
        reservedFor: 0, reservedUntilTick: 0, droppedBy: 0, ...extra,
      });
    };
    drop(95001, 1100, 1000, 0, { reservedFor: a.pid, reservedUntilTick: w.tick + 10 * TICK_RATE });
    drop(95002, 1000 + INTEREST_RADIUS + 100, 1000, 2);
    drop(95003, 6000, 6000, LOOT_BEACON_RARITY);
    drop(95004, 1200, 1000, 1, { reservedFor: 999, reservedUntilTick: 1 });
    drop(95005, 1300, 1000, 0, { expireTick: Number.MAX_SAFE_INTEGER });
    me.carried = [tok(0), tok(4, 'rift'), tok(2)];
    const cloaker = [...w.ships.values()].find((s) => s.team === 1)!;
    cloaker.flags = SHIPFLAG_CLOAKED; cloaker.x = 5000; cloaker.y = 5000;
    cloaker.carried = [tok(3)];
    // lootPickup is a global event: the hidden cloaker's must not reach anyone who doesn't see that ship
    w.events.push({ t: 'lootPickup', playerId: cloaker.playerId, shipId: cloaker.id, x: 5000, y: 5000, rarity: 3, set: 'swarm', carried: 1 });
    w.events.push({ t: 'lootPickup', playerId: a.pid, shipId: me.id, x: 1000, y: 1000, rarity: 0, set: 'common', carried: 3 });
    ticks(zone, 3);
    const pickups = (c: FakeClient) => c.snaps.flatMap((x) => x.events).filter((e) => e.t === 'lootPickup').map((e) => (e as { shipId: number }).shipId);
    expect(pickups(a)).toEqual([me.id]);
    expect(pickups(g)).toEqual([me.id]);
    const s = a.snaps[a.snaps.length - 1];
    expect(s.loot!.map((l) => l.id).sort()).toEqual([95001, 95003, 95004, 95005]);
    const byId = new Map(s.loot!.map((l) => [l.id, l]));
    expect(byId.get(95001)).toMatchObject({ reservedFor: a.pid, rarity: 0, set: 'swarm' });
    expect(byId.get(95004)!.reservedFor).toBe(0); // the priority window is over
    expect(byId.get(95005)!.lifeFrac).toBe(1); // no expiry
    expect(byId.get(95001)!.lifeFrac).toBeGreaterThan(0.9);
    expect(s.carry).toEqual([{ shipId: me.id, n: 3, best: 4 }]); // the hidden cloaker's carry would give it away
    expect(s.you!.carried).toEqual([{ rarity: 4, set: 'rift' }, { rarity: 2, set: 'common' }, { rarity: 0, set: 'common' }]);
    expect(s.you!.carryCap).toBe(MAX_CARRIED);
    // the spectator: no cloaked ship, so no cloaked carry; loot around its camera + the epic one
    const gs = g.snaps[g.snaps.length - 1];
    expect((gs.carry ?? []).map((c) => c.shipId)).not.toContain(cloaker.id);
    expect(gs.loot!.some((l) => l.id === 95003)).toBe(true);
    // the codec carries the real loot count (VERSION 5 nLoot) and the carry tail
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.loot!.map((l) => l.id)).toEqual(s.loot!.map((l) => l.id));
    expect(d.carry).toEqual(s.carry);
    expect(d.you!.carried).toEqual(s.you!.carried);
  });

  it('no caches and no carriers: loot / carry / you.carried are absent', () => {
    const zone = mkLootZone(undefined);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Main Arena') });
    startPlaying(zone, a);
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    expect('loot' in s).toBe(false);
    expect('carry' in s).toBe(false);
    expect(s.you!.carried).toBeUndefined();
    expect(s.you!.carryCap).toBe(MAX_CARRIED); // loot is on (lootMult > 0): the HUD knows the cap
  });
});

// ---------------------------------------------------------------------------------------------
// v0.3 M3: the objective room layer (docs/v0.3-proposal.md §5.7 "Room", §9 ROOM M3): match.objective in snapshots,
// objective results (fix #7), PlayerScore.obj, objective awards, objective chat lines, /target, house rooms.
// The sub-modes are not `ready` yet (the integrator flips them after the AI gates pass), so these tests open them
// for their own duration. The FakeSim world gets a hand-built ObjectiveState; buildObjectiveView is a spy.
// ---------------------------------------------------------------------------------------------

const OBJ_SUBS: readonly SubMode[] = ['ctf', 'zones', 'hotpoint'];

function mkObjState(mode: ObjectiveSubMode, teams: number, limit: number): ObjectiveState {
  return {
    mode, limit, teamPoints: new Array(teams).fill(0), playerPoints: new Map(), flags: [], zones: [], hot: null,
    overtime: false, overtimeCapTick: 0, suddenDeath: false, extensions: 0, stats: new Map(), mem: {},
  };
}
const objStats = (p: Partial<ObjectivePlayerStats>): ObjectivePlayerStats => ({
  caps: 0, steals: 0, returns: 0, carrierKills: 0, zoneCaps: 0, neutralizes: 0, objTicks: 0, hotHoldTicks: 0, ...p,
});
const flagObj = (team: number, x: number, y: number): FlagObjective => ({
  team, state: 'home', x, y, standX: x, standY: y, carrierId: 0, carrierPlayerId: 0, droppedAtTick: 0, pickedAtTick: 0, runners: [],
});
const zoneObj = (index: number, owner = -1): ZoneObjective => ({
  index, x: 3200, y: 3200, radius: 200, owner, ownerPlayerId: 0, capTeam: -1, capPlayerId: 0, progress: 0,
  contested: false, swarm: 0, active: true, lastPresenceTick: 0, heldSinceTick: 0,
});
const objEv = (kind: ObjectiveEventKind, o: Partial<Extract<GameEvent, { t: 'objective' }>> = {}): GameEvent =>
  ({ t: 'objective', kind, team: -1, playerId: 0, index: 0, x: 0, y: 0, value: 0, ...o });
/** System chat lines only (bot greetings / banter are player lines). */
const sysTexts = (c: FakeClient): string[] => c.of('chat').filter((m) => m.line.channel === 'system').map((m) => m.line.text);

/** The spy's stand-in for buildObjectiveView: enough to prove the Room forwards what it returns. */
function fakeObjectiveView(w: World): ObjectiveView | undefined {
  const o = w.objective;
  if (!o) return undefined;
  return {
    mode: o.mode, limit: o.limit, overtime: o.overtime, suddenDeath: o.suddenDeath,
    flags: o.flags.map((f) => ({ team: f.team, s: f.state === 'home' ? 0 : f.state === 'carried' ? 1 : 2, x: f.x, y: f.y, carrierId: f.carrierId, returnIn: 0 })),
  };
}

describe('v0.3 M3: objective room layer', () => {
  let prevReady: boolean[] = [];
  let restoreView: (() => void) | null = null;
  beforeEach(() => {
    prevReady = OBJ_SUBS.map((s) => SUB_MODES[s].ready);
    for (const s of OBJ_SUBS) SUB_MODES[s].ready = true;
    const spy = vi.mocked(buildObjectiveView);
    const orig = spy.getMockImplementation();
    spy.mockImplementation(fakeObjectiveView);
    restoreView = () => { if (orig) spy.mockImplementation(orig); };
  });
  afterEach(() => {
    OBJ_SUBS.forEach((s, i) => { SUB_MODES[s].ready = prevReady[i]; });
    restoreView?.();
    vi.useRealTimers();
  });

  /** An Arena objective room: Ace flies for team 0 (FFA: no team) with 3 bots; the match runs with world.objective set. */
  function objMatch(patch: Partial<RoomSettings>): { zone: Zone; a: FakeClient; w: World; o: ObjectiveState; bots: import('../types').Ship[] } {
    const zone = mkZone(false, [{ name: 'Obj', gameType: 'arena', mode: 'teams', teamCount: 2, botFill: 4, ...patch }]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Obj') });
    a.send({ type: 'setTeam', team: 0 });
    startPlaying(zone, a);
    const w = fake().world;
    const mode = w.config.subMode as ObjectiveSubMode;
    const teams = w.config.mode === 'teams' ? w.config.teamCount : 0;
    const o = mkObjState(mode, teams, objectiveTarget(mode, w.config.mode, w.config.objectiveLimit ?? 0));
    if (mode === 'ctf') for (let t = 0; t < teams; t++) o.flags.push(flagObj(t, 800 + t * 4800, 3200));
    w.objective = o;
    const bots = [...w.ships.values()].filter((s) => s.isBot);
    return { zone, a, w, o, bots };
  }
  const end = (a: FakeClient) => { a.send({ type: 'chat', channel: 'all', text: '/end' }); return a.last('matchEnd').result; };

  it('fix #7: /end results use the objective points, never kills; the winner comes from points', () => {
    const { a, w, o } = objMatch({ subMode: 'ctf' });
    expect(w.config).toMatchObject({ gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2 });
    for (const s of w.ships.values()) if (s.team === 1) { s.kills = 9; s.score = 900; } // Azure has every kill
    o.teamPoints = [2, 1];
    w.match.teamScores = [2, 1]; // the sim's mirror
    const r = end(a);
    expect(r).toMatchObject({ gameType: 'arena', subMode: 'ctf', teamScores: [2, 1], winnerTeam: 0, winnerPlayerId: 0 });
    expect(r.objective).toEqual({ mode: 'ctf', teamPoints: [2, 1], summary: 'Crimson 2 – 1 Azure (captures)' });
    expect(sysTexts(a)).toContain('Team Crimson wins!');
  });

  it('fix #7: a points tie is a draw and "nobody scored" never falls back to kill sums', () => {
    for (const pts of [[1, 1], [0, 0]]) {
      const { a, w, o } = objMatch({ subMode: 'ctf' });
      for (const s of w.ships.values()) if (s.team === 0) { s.kills = 4; s.score = 400; }
      o.teamPoints = pts.slice();
      w.match.teamScores = pts.slice();
      const r = end(a);
      expect(r.teamScores).toEqual(pts);
      expect(r.winnerTeam).toBe(-1);
      expect(r.objective!.summary).toBe(`Crimson ${pts[0]} – ${pts[1]} Azure (captures)`);
      expect(sysTexts(a)).toContain("Match over — it's a draw.");
    }
  });

  it('fix #7: with no ObjectiveState the sim mirror (match.teamScores) is used, still never kills', () => {
    const zone = mkZone(false, [{ name: 'Obj', gameType: 'arena', subMode: 'zones', mode: 'teams', teamCount: 3, botFill: 5 }]);
    const a = join(zone, 'Ace');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Obj') });
    startPlaying(zone, a);
    const w = fake().world;
    expect(w.objective).toBeUndefined();
    for (const s of w.ships.values()) { s.kills = 3; s.score = 300; }
    w.match.teamScores = [40, 212, 187];
    const r = end(a);
    expect(r.teamScores).toEqual([40, 212, 187]);
    expect(r.winnerTeam).toBe(1);
    expect(r.objective).toEqual({ mode: 'zones', teamPoints: [40, 212, 187], summary: 'Azure 212 · Verdant 187 · Crimson 40 (points)' });
  });

  it("a match the sim ended keeps the sim's verdict (a sudden-death draw stays a draw)", () => {
    const { zone, a, w, o } = objMatch({ subMode: 'ctf' });
    o.teamPoints = [3, 3];
    o.suddenDeath = true;
    w.match.teamScores = [3, 3];
    w.match.phase = 'ended';
    w.match.winnerTeam = -1;
    ticks(zone, 1);
    const r = a.last('matchEnd').result;
    expect(r.winnerTeam).toBe(-1);
    expect(r.objective!.summary).toBe('Crimson 3 – 3 Azure (captures, sudden death)');
    // ...and a sim-declared winner stands even where an early /end would have said draw
    const m2 = objMatch({ subMode: 'zones' });
    m2.o.teamPoints = [100, 100];
    m2.w.match.phase = 'ended';
    m2.w.match.winnerTeam = 1;
    ticks(m2.zone, 1);
    expect(m2.a.last('matchEnd').result.winnerTeam).toBe(1);
  });

  it('PlayerScore.obj carries the non-zero objective stats (live scores and results); CTF awards come first', () => {
    const { zone, a, o, bots } = objMatch({ subMode: 'ctf' });
    o.stats.set(a.pid, objStats({ caps: 2, steals: 3 }));
    o.stats.set(bots[0].playerId, objStats({ returns: 4 }));
    o.stats.set(bots[1].playerId, objStats({ carrierKills: 1, returns: 1 }));
    o.stats.set(987654, objStats({ caps: 9 })); // a pilot who left: stats survive, but no score row / award
    shipOf(a).kills = 5;
    ticks(zone, TICK_RATE); // the 1 Hz scores message
    const live = a.last('scores').scores;
    expect(live.find((s) => s.playerId === a.pid)!.obj).toEqual({ caps: 2, steals: 3 });
    expect(live.find((s) => s.playerId === bots[2].playerId)!.obj).toBeUndefined();
    const r = end(a);
    expect(r.scores.find((s) => s.playerId === bots[0].playerId)!.obj).toEqual({ returns: 4 });
    expect(r.scores.some((s) => s.playerId === 987654)).toBe(false);
    expect(r.awards.slice(0, 3)).toEqual([
      { title: 'Flag Runner', playerId: a.pid, value: '2 captures' },
      { title: 'Goalkeeper', playerId: bots[0].playerId, value: '4 flag returns' },
      { title: 'Carrier Killer', playerId: bots[1].playerId, value: '1 carrier kill' },
    ]);
    expect(r.awards[3]).toMatchObject({ title: 'Top Gun', playerId: a.pid });
    expect(r.awards.length).toBeLessThanOrEqual(5);
  });

  it('Zones / Hot Point awards: Anchor (objTicks), Point Breaker (captures + neutralizes), King of the Hill (hot only)', () => {
    const hot = objMatch({ subMode: 'hotpoint' });
    hot.o.stats.set(hot.a.pid, objStats({ objTicks: 30 * TICK_RATE, zoneCaps: 1 }));
    hot.o.stats.set(hot.bots[0].playerId, objStats({ zoneCaps: 2, neutralizes: 1 }));
    hot.o.stats.set(hot.bots[1].playerId, objStats({ hotHoldTicks: 45 * TICK_RATE }));
    expect(end(hot.a).awards.slice(0, 3)).toEqual([
      { title: 'Anchor', playerId: hot.a.pid, value: '30 s working the point' },
      { title: 'Point Breaker', playerId: hot.bots[0].playerId, value: '2 captures + 1 neutralized' },
      { title: 'King of the Hill', playerId: hot.bots[1].playerId, value: '45 s holding the point' },
    ]);
    const z = objMatch({ subMode: 'zones' });
    z.o.stats.set(z.bots[2].playerId, objStats({ objTicks: 7 * TICK_RATE + 20, neutralizes: 2, hotHoldTicks: 999 }));
    const aw = end(z.a).awards;
    expect(aw.slice(0, 2)).toEqual([
      { title: 'Anchor', playerId: z.bots[2].playerId, value: '7 s working the zones' },
      { title: 'Point Breaker', playerId: z.bots[2].playerId, value: '2 neutralized' },
    ]);
    expect(aw.some((x) => x.title === 'King of the Hill')).toBe(false);
  });

  it('FFA Hot Point: live leader and the /end winner by playerPoints, summary of the top 3, a tie is a draw', () => {
    const { zone, a, w, o, bots } = objMatch({ subMode: 'hotpoint', mode: 'ffa' });
    expect(w.config.mode).toBe('ffa');
    expect(sysTexts(a)).toContain('Free-for-all Hot Point! First to 120 points.');
    shipOf(a).score = 999; // ship score is not the objective: no leader until someone has points
    expect(roomNamed(zone, 'Obj').summary().live).toMatchObject({ leader: '', scoreline: '', scores: [] });
    o.playerPoints.set(bots[0].playerId, 40).set(a.pid, 12).set(bots[1].playerId, 88).set(bots[2].playerId, 0);
    expect(roomNamed(zone, 'Obj').summary().live).toMatchObject({ leader: bots[1].name, leaderScore: 88, scoreline: `${bots[1].name} 88` });
    const r = end(a);
    expect(r).toMatchObject({ winnerTeam: -1, winnerPlayerId: bots[1].playerId, teamScores: [] });
    expect(r.objective).toEqual({
      mode: 'hotpoint', teamPoints: [],
      playerPoints: [[bots[1].playerId, 88], [bots[0].playerId, 40], [a.pid, 12]],
      summary: `${bots[1].name} 88 · ${bots[0].name} 40 · Ace 12 (points)`,
    });
    expect(sysTexts(a)).toContain(`${bots[1].name} wins!`);
    const t = objMatch({ subMode: 'hotpoint', mode: 'ffa' });
    t.o.playerPoints.set(t.a.pid, 50).set(t.bots[0].playerId, 50);
    shipOf(t.a).score = 500;
    expect(end(t.a).winnerPlayerId).toBe(0);
    expect(sysTexts(t.a)).toContain("Match over — it's a draw.");
  });

  it('FFA Hot Point loot grants: "won" is a top-3 finish by objective points, not by ship score', () => {
    const spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    try {
      for (const acePts of [0, 25]) {
        const { zone, a, o, bots } = objMatch({ subMode: 'hotpoint', mode: 'ffa', botFill: 5 });
        shipOf(a).score = 5000; // the best ship score in the room
        o.playerPoints.set(bots[0].playerId, 30).set(bots[1].playerId, 20).set(bots[2].playerId, 10).set(a.pid, acePts);
        advance(CRATE_MIN_MATCH_SEC + 20);
        ticks(zone, 1);
        end(a);
        const batch = spy.mock.calls.at(-1)![0] as GrantEntry[];
        const mine = batch.find((e) => e.profileKey === `guest:${a.pid}`)!;
        expect(mine.input.won).toBe(acePts > 0); // 25 points = 2nd place; 0 points = no finish at all
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('live summary: objective team scores come from the points (never the ship-score sums)', () => {
    const { zone, w, o } = objMatch({ subMode: 'zones', teamCount: 3 });
    for (const s of w.ships.values()) s.score = 1000;
    o.teamPoints = [12, 30, 7];
    w.match.teamScores = [12, 30, 7];
    const L = roomNamed(zone, 'Obj').summary().live!;
    expect(L.scores).toEqual([12, 30, 7]);
    expect(L.scoreline).toBe('12–30–7');
  });

  it('chat: flag took / dropped (rate-limited per flag), returned, captured with the score; sudden death', () => {
    const { zone, a, w, o } = objMatch({ subMode: 'ctf' });
    const n0 = sysTexts(a).length;
    const push = (...evs: GameEvent[]): void => { w.events.push(...evs); ticks(zone, 1); };
    push(objEv('flagTaken', { playerId: a.pid, team: 0, index: 1 }));
    push(objEv('flagDropped', { playerId: a.pid, team: 1, index: 1 }));
    push(objEv('flagTaken', { playerId: a.pid, team: 0, index: 1 })); // < 5 s after the last "took" of this flag: quiet
    push(objEv('flagReturned', { team: 1, index: 1 })); // auto-return (no pilot)
    o.teamPoints[0] = 2;
    push(objEv('flagCaptured', { playerId: a.pid, team: 0, index: 1, value: 2 }));
    expect(sysTexts(a).slice(n0)).toEqual([
      "Ace took Azure's flag!",
      "Ace dropped Azure's flag!",
      "Azure's flag returned home.",
      "Crimson captured Azure's flag! 2/3 (Ace)",
    ]);
    ticks(zone, FLAG_NOTE_GAP_SEC * TICK_RATE);
    push(objEv('flagTaken', { playerId: a.pid, team: 0, index: 1 }));
    push(objEv('suddenDeath'));
    expect(sysTexts(a).slice(-2)).toEqual(["Ace took Azure's flag!", 'Sudden death! The next capture wins.']);
  });

  it('chat: zone flips at most one line per 5 s; neutralizes stay quiet; zones overtime counts its extensions', () => {
    const { zone, a, w, o } = objMatch({ subMode: 'zones' });
    o.zones = [zoneObj(0), zoneObj(1, 1), zoneObj(2)];
    const n0 = sysTexts(a).length;
    const push = (...evs: GameEvent[]): void => { w.events.push(...evs); ticks(zone, 1); };
    push(objEv('zoneCaptured', { team: 1, index: 1 }));
    o.zones[0].owner = 0;
    push(objEv('zoneCaptured', { team: 0, index: 0 })); // within 5 s: rate-limited
    push(objEv('zoneNeutralized', { team: 0, index: 2 }));
    ticks(zone, ZONE_NOTE_GAP_SEC * TICK_RATE);
    push(objEv('zoneCaptured', { team: 0, index: 0 }));
    o.extensions = 1;
    push(objEv('overtime'));
    expect(sysTexts(a).slice(n0)).toEqual(['Azure captured Zone A!', 'Crimson captured the Core!', 'Tied! Overtime 1/3: +60 s.']);
  });

  it('chat: the hot point names where it moves next; captures by team or (FFA) by pilot; overtime', () => {
    const { zone, a, w, o } = objMatch({ subMode: 'hotpoint' });
    w.map.features = [
      { kind: 'hotSite', team: -1, index: 0, x: w.map.width / 2, y: w.map.height / 2, radius: 240 },
      { kind: 'hotSite', team: -1, index: 3, x: w.map.width - 800, y: 800, radius: 240 },
    ];
    o.zones = [zoneObj(0, 1)];
    o.hot = { site: 0, nextSite: 3, moveTick: w.tick + 1 + 10 * TICK_RATE, warnTick: w.tick + 1, armTick: 0, moves: 0, recent: [] };
    const n0 = sysTexts(a).length;
    const push = (...evs: GameEvent[]): void => { w.events.push(...evs); ticks(zone, 1); };
    push(objEv('hotWarn', { index: 3 }));
    push(objEv('zoneCaptured', { team: 1, index: 0 }));
    push(objEv('hotMoved', { index: 3 })); // the warning already said it
    push(objEv('overtime'));
    expect(sysTexts(a).slice(n0)).toEqual([
      'The Hot Point moves north-east in 10 s.', 'Azure took the Hot Point!', 'Overtime! The Hot Point is still in play.',
    ]);
    o.hot.nextSite = 0;
    push(objEv('hotWarn', { index: 0 }));
    expect(sysTexts(a).at(-1)).toMatch(/^The Hot Point moves to the centre in \d+ s\.$/);
    const f = objMatch({ subMode: 'hotpoint', mode: 'ffa' });
    f.o.zones = [zoneObj(0)];
    f.w.events.push(objEv('zoneCaptured', { playerId: f.bots[0].playerId, index: 0 }));
    ticks(f.zone, 1);
    expect(sysTexts(f.a).at(-1)).toBe(`${f.bots[0].name} took the Hot Point!`);
  });

  it('snapshots carry match.objective = buildObjectiveView(world): built once per snapshot tick, shared by pilots and spectators; the carrier flag rides ShipView.flags', () => {
    const zone = mkZone(false, [{ name: 'Obj', gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, botFill: 4 }]);
    const a = join(zone, 'Ace');
    const g = join(zone, 'Gus');
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Obj') });
    g.send({ type: 'joinRoom', roomId: roomId(g, 'Obj') });
    a.send({ type: 'setTeam', team: 0 });
    g.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    startPlaying(zone, a);
    const w = fake().world;
    ticks(zone, 3);
    expect(a.snaps.at(-1)!.match.objective).toBeUndefined(); // no ObjectiveState: no view
    const o = mkObjState('ctf', 2, 3);
    o.flags.push(flagObj(0, 800, 3200), flagObj(1, 5600, 3200));
    const me = shipOf(a);
    o.flags[1].state = 'carried'; o.flags[1].carrierId = me.id; o.flags[1].carrierPlayerId = a.pid;
    w.objective = o;
    me.flags |= SHIPFLAG_CARRIER;
    const spy = vi.mocked(buildObjectiveView);
    const calls0 = spy.mock.calls.length;
    ticks(zone, 3);
    expect(spy.mock.calls.length - calls0).toBe(1); // once per snapshot tick, not per viewer
    const sa = a.snaps.at(-1)!;
    const sg = g.snaps.at(-1)!;
    expect(sg.you).toBeNull();
    expect(sa.match).toBe(sg.match);
    expect(sa.match).toMatchObject({ gameType: 'arena', subMode: 'ctf', objective: fakeObjectiveView(w) });
    const mine = sa.ships.find((v) => v.id === me.id)!;
    expect(mine.flags & SHIPFLAG_CARRIER).toBe(SHIPFLAG_CARRIER);
    const d = decodeSnapshot(encodeSnapshot(sa));
    expect(d.match.objective).toEqual(sa.match.objective);
    expect(d.ships.find((v) => v.id === me.id)!.flags & SHIPFLAG_CARRIER).toBe(SHIPFLAG_CARRIER);
  });

  it('/target: anyone may read it, the host sets it within the sub-mode bounds, the start line names it, mid-match it waits', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let t = Date.now();
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    const say = (c: FakeClient, text: string): void => { t += 1100; vi.setSystemTime(t); c.send({ type: 'chat', channel: 'all', text }); };
    a.send({ type: 'createRoom', settings: { name: 'Mine', gameType: 'arena', subMode: 'ctf' } });
    const id = a.last('roomState').roomId!;
    b.send({ type: 'joinRoom', roomId: id });
    say(b, '/target');
    expect(b.chatTexts().at(-1)).toBe('Target: 3 captures (default). Host: /target <1-10> (0 = default).');
    say(b, '/target 5');
    expect(b.chatTexts().at(-1)).toBe('/target is host-only.');
    say(a, '/target 50');
    expect(a.last('roomState').settings.objectiveLimit).toBe(10);
    say(a, '/target 5');
    expect(a.last('roomState').settings.objectiveLimit).toBe(5);
    expect(sysTexts(a)).toContain('Settings: target 5.');
    // malformed numbers are refused with the usage line (parseInt used to read '1e3' as 1, '2.9' as 2)
    for (const bad of ['1e3', '2.9', '5abc', '-3', '0x4']) {
      say(a, `/target ${bad}`);
      expect(a.chatTexts().at(-1), bad).toBe('Usage: /target <1-10 captures> (0 = default 3)');
      expect(a.last('roomState').settings.objectiveLimit, bad).toBe(5);
    }
    say(a, '/target');
    expect(a.chatTexts().at(-1)).toBe('Target: 5 captures. Host: /target <1-10> (0 = default).');
    startPlaying(zone, a);
    expect(fake().world.config).toMatchObject({ subMode: 'ctf', objectiveLimit: 5 });
    expect(sysTexts(a)).toContain('Fight! Capture the Flag, 2 teams, 12 minutes. First to 5 captures.');
    say(a, '/target 7');
    expect(a.last('roomState').settings.objectiveLimit).toBe(7);
    expect(sysTexts(a).at(-1)).toBe('Settings: target 7, (match settings apply next match).');
    expect(fake().world.config.objectiveLimit).toBe(5);
    say(a, '/target 0');
    expect(a.last('roomState').settings.objectiveLimit).toBe(0);
  });

  it('house rooms: Flag Run and Hot Points open once their sub-modes are ready (and Quick Play finds them); Offline Arena plays CTF', () => {
    const names = houseRooms(false).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Flag Run', 'Hot Points', 'Duel Pit', 'Warzone Classic']));
    const zone = mkZone(false, houseRooms(false));
    const a = join(zone, 'Ace');
    const list = a.last('roomList').rooms;
    expect(list.find((r) => r.name === 'Flag Run')).toMatchObject({ gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, maxPlayers: 16, house: true });
    expect(list.find((r) => r.name === 'Hot Points')).toMatchObject({ gameType: 'arena', subMode: 'hotpoint', mode: 'teams', teamCount: 2, maxPlayers: 16, house: true });
    expect(houseRooms(true).find((r) => r.name === 'Offline Arena')).toMatchObject({ gameType: 'arena', subMode: 'ctf' });
    a.send({ type: 'quickPlay', gameType: 'arena', subMode: 'hotpoint' });
    expect(a.last('roomState').settings).toMatchObject({ name: 'Hot Points', subMode: 'hotpoint' });
    // not ready (yet): skipped online, substituted offline
    SUB_MODES.ctf.ready = false;
    SUB_MODES.hotpoint.ready = false;
    const off = houseRooms(false).map((r) => r.name);
    expect(off).not.toContain('Flag Run');
    expect(off).not.toContain('Hot Points');
    expect(houseRooms(true).find((r) => r.name === 'Offline Arena')?.subMode).not.toBe('ctf');
  });
});

// ---------------------------------------------------------------------------------------------
// v0.3 M4: the rift room layer (docs/v0.3-proposal.md §4.8; §9 ROOM M4 acceptance). The FakeSim carries a hand-built
// RiftState (floorSwap = Sim.enterFloor's double); buildRiftView / riftYou are small doubles (vi.mock above).
// ---------------------------------------------------------------------------------------------

describe('v0.3 M4: rift room layer', () => {
  let wasReady = false;
  beforeEach(() => { wasReady = SUB_MODES.coop.ready; SUB_MODES.coop.ready = true; });
  afterEach(() => { SUB_MODES.coop.ready = wasReady; });

  const DEEP = { name: 'Deep', gameType: 'dungeon' as const, subMode: 'coop' as const, floors: 6, botFill: 4 };
  /** A Dungeon Runner room: Ace flies (as a Juggernaut) with 3 bots; the run is on floor 1. */
  function riftMatch(opts: { store?: ProfileStore; patch?: Partial<RoomSettings>; account?: boolean } = {}) {
    const rooms = [{ ...DEEP, ...opts.patch }];
    const zone = opts.store ? mkLootZone(opts.store, false, rooms) : mkZone(false, rooms);
    const a = join(zone, 'Ace', opts.account ? acct('Ace') : null);
    a.send({ type: 'joinRoom', roomId: roomId(a, 'Deep') });
    a.send({ type: 'setShip', shipClass: 'brute' });
    startPlaying(zone, a);
    const room = roomNamed(zone, 'Deep');
    const w = fake().world;
    return { zone, a, room, w, d: w.dungeon! };
  }
  const botsOf = (room: Room) => room.allPlayers.filter((p) => p.isBot);
  const end = (a: FakeClient) => { a.send({ type: 'chat', channel: 'all', text: '/end' }); return a.last('matchEnd').result; };
  const grantOf = (spy: MockInstance<ProfileService['grantBatch']>, key: string): GrantEntry | undefined =>
    (spy.mock.calls as unknown as [GrantEntry[]][]).flatMap((c) => c[0]).filter((e) => e.profileKey === key).pop();
  /** What the real SIM does when the run ends: outcome set, stepMatch ends the match. */
  function simEnds(w: World, outcome: 'cleared' | 'extracted' | 'wiped'): void {
    w.dungeon!.outcome = outcome;
    w.match.phase = 'ended';
    w.match.winnerTeam = outcome === 'wiped' ? -1 : 0;
  }

  it('matchStart names floor 1; the Sim runs untimed single-party co-op; bots complement the party; live summary + snapshots carry the rift', () => {
    const { zone, a, room, w } = riftMatch();
    expect(a.last('matchStart')).toMatchObject({ gameType: 'dungeon', subMode: 'coop', mode: 'teams', teamCount: 1, floor: 1 });
    expect(w.config).toMatchObject({ gameType: 'dungeon', subMode: 'coop', mode: 'teams', teamCount: 1, floors: 6, matchSeconds: 0 });
    expect([...w.ships.values()].every((s) => s.team === 0)).toBe(true);
    // §4.8: an Artificer if the party has none, then the least-used class — Ace's Juggernaut + 3 bots covers all three
    const botClasses = botsOf(room).map((b) => b.shipClass);
    expect(botClasses).toContain('engineer');
    expect(new Set(['brute', ...botClasses])).toEqual(new Set(['brute', 'tech', 'engineer']));
    expect(room.summary().live).toMatchObject({ floor: 1, floorsTotal: 6, lives: 10, timeLeftSec: -1, scoreline: 'Floor 1/6 · 10 lives' });
    expect(room.statusLine()).toBe('playing Floor 1/6 · 10 lives');
    expect(a.chatTexts()).toContain('The descent begins — 6 floors. Stay together.');
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    expect(s.match).toMatchObject({ gameType: 'dungeon', timed: false, dungeon: { floor: 1, floorsTotal: 6, biome: 'hive', lives: [10] } });
    expect(s.you!.rift).toMatchObject({ party: 0, lives: 10, waiting: false, extracted: false });
    // the rift tail survives the wire codec
    const dec = decodeSnapshot(encodeSnapshot(s));
    expect(dec.match.dungeon).toEqual(s.match.dungeon);
    expect(dec.you!.rift).toEqual(s.you!.rift);
  });

  it("floorStart: every watcher gets it BEFORE the new floor's first snapshot (forced that tick); old positional events are dropped; bots reset; chat names the floor", () => {
    const { zone, a, room, w } = riftMatch();
    const wt = join(zone, 'Wat');
    wt.send({ type: 'joinRoom', roomId: room.id, intent: 'watch' });
    ticks(zone, 2); // brains exist now
    const calls: number[] = [];
    for (const b of botsOf(room)) (b.brain as unknown as { onFloorChange: () => void }).onFloorChange = () => calls.push(b.playerId);
    // this tick: an old-floor hit (positional) and a level-up (global), then the swap
    const o0 = a.order.length, s0 = a.snaps.length, wo0 = wt.order.length;
    fake().floorSwap(2, [
      { t: 'hit', x: 10, y: 10, targetKind: 'enemy', targetId: 5, amount: 3 },
      { t: 'levelUp', playerId: a.pid, level: 2 },
    ]);
    ticks(zone, 1);
    for (const [c, from] of [[a, o0], [wt, wo0]] as const) {
      const seg = c.order.slice(from);
      expect(seg).toContain('floorStart');
      expect(seg.indexOf('floorStart')).toBeLessThan(seg.indexOf('snap'));
    }
    expect(a.last('floorStart')).toEqual({ type: 'floorStart', floor: 2, tick: w.tick });
    const fresh = a.snaps.slice(s0);
    expect(fresh).toHaveLength(1); // forced on the swap tick
    expect(fresh[0].tick).toBe(w.tick);
    expect(fresh[0].match.dungeon!.floor).toBe(2);
    const types = fresh[0].events.map((e) => e.t);
    expect(types).toContain('floorStart');
    expect(types).toContain('levelUp'); // globals stay (kill feed, banners)
    expect(types).not.toContain('hit'); // the old floor's positional FX are gone
    expect(calls.sort()).toEqual(botsOf(room).map((b) => b.playerId).sort());
    expect(a.chatTexts()).toContain('Floor 2 — Hive Warrens');
    fake().floorSwap(4);
    ticks(zone, 1);
    expect(a.chatTexts()).toContain('Floor 4 — Prism Vaults');
  });

  it('a Join / Quick Play while the rift runs waits as a spectator (no bot evicted mid-floor) and is added at the next floor start in place of a bot', () => {
    const { zone, a, room, w } = riftMatch();
    expect(botsOf(room)).toHaveLength(3);
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    expect(b.last('matchStart')).toMatchObject({ yourShipId: 0, floor: 1 });
    expect(b.chatTexts().some((t) => t.includes('You join the party at the next floor.'))).toBe(true);
    const pb = room.allPlayers.find((p) => p.playerId === b.pid)!;
    expect(pb).toMatchObject({ spectating: true, pendingDropIn: true, inMatch: false });
    ticks(zone, 5);
    expect(botsOf(room)).toHaveLength(3); // the seat changes hands at the floor start, not now
    expect(w.shipsByPlayer.has(b.pid)).toBe(false);
    expect(b.snaps[b.snaps.length - 1].you).toBeNull();
    expect(room.summary()).toMatchObject({ humans: 2, joinable: true }); // Ace + Bee's claim: 2 of 4 seats
    const bo = b.order.length;
    fake().floorSwap(2);
    ticks(zone, 1);
    expect(w.shipsByPlayer.has(b.pid)).toBe(true);
    expect(pb).toMatchObject({ spectating: false, pendingDropIn: false, inMatch: true, team: 0 });
    expect(botsOf(room)).toHaveLength(2);
    expect(w.ships.size).toBe(4);
    const seg = b.order.slice(bo);
    expect(seg.indexOf('floorStart')).toBeLessThan(seg.indexOf('matchStart'));
    expect(seg.indexOf('matchStart')).toBeLessThan(seg.indexOf('snap'));
    expect(b.last('matchStart')).toMatchObject({ floor: 2, yourShipId: w.shipsByPlayer.get(b.pid) });
    expect(b.snaps[b.snaps.length - 1].you?.shipId).toBe(w.shipsByPlayer.get(b.pid));
    expect(a.chatTexts()).toContain('Bee joined the party on floor 2.');
  });

  it('seats: pending drop-ins claim them (a full party refuses Join, Watch still works); the final floor has no drop-in; Spectate cancels one', () => {
    const { zone, room, d } = riftMatch({ patch: { botFill: 1 } });
    const joiners = ['Bee', 'Cee', 'Dee'].map((n) => { const c = join(zone, n); c.send({ type: 'joinRoom', roomId: room.id, intent: 'play' }); return c; });
    expect(joiners.every((c) => c.last('roomState').roomId === room.id)).toBe(true);
    expect(room.canJoin('play')).toBe(false); // Ace + 3 claims = 4 seats
    expect(room.summary().joinable).toBe(false);
    const e = join(zone, 'Eve');
    e.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    expect(e.last('error').message).toBe('That room is full.');
    e.send({ type: 'joinRoom', roomId: room.id, intent: 'watch' });
    expect(e.last('matchStart')).toMatchObject({ yourShipId: 0 });
    // Dee changes their mind: Spectate cancels the drop-in and frees the seat
    joiners[2].send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(joiners[2].chatTexts()).toContain("Drop-in cancelled — you're watching.");
    expect(room.canJoin('play')).toBe(true);
    // the final floor: no floor start is coming, so a Join just watches
    d.floor = 6;
    const f = join(zone, 'Fay');
    f.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    expect(f.chatTexts().some((t) => t.includes('This is the final floor'))).toBe(true);
    expect(room.allPlayers.find((p) => p.playerId === f.pid)!.pendingDropIn).toBe(false);
  });

  it('spectate and back mid-floor: no ship until the next floor start (the rejoin timer never adds one); a waiting drop-in flies the next run', () => {
    const { zone, a, room, w } = riftMatch();
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED }); // leaves the run (a 'left' pilot until re-added)
    expect(w.shipsByPlayer.has(a.pid)).toBe(false);
    ticks(zone, 4 * TICK_RATE);
    a.send({ type: 'setTeam', team: 0 });
    expect(a.chatTexts()).toContain('You join the party at the next floor.');
    ticks(zone, 8 * TICK_RATE); // well past the SEC-2 rejoin delay
    expect(w.shipsByPlayer.has(a.pid)).toBe(false);
    fake().floorSwap(2);
    ticks(zone, 1);
    expect(w.shipsByPlayer.has(a.pid)).toBe(true);
    // a drop-in still waiting when the run ends gets a pilot seat for the next run
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    end(a);
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(room.phase).toBe('lobby');
    expect(room.allPlayers.find((p) => p.playerId === b.pid)).toMatchObject({ spectating: false, pendingDropIn: false });
    expect(botsOf(room)).toHaveLength(2);
  });

  it('class changes during a run are queued to the next floor start — never applied at a respawn', () => {
    const { zone, a, w } = riftMatch();
    a.send({ type: 'setShip', shipClass: 'tech' });
    expect(a.chatTexts()).toContain('Class change applies at the next floor.');
    expect(shipOf(a).shipClass).toBe('brute');
    // a death + respawn mid-floor keeps the old class
    const s = shipOf(a);
    s.alive = false; s.respawnTick = w.tick + 2;
    ticks(zone, 4);
    expect(s.alive).toBe(true);
    expect(fake().classSwaps).toHaveLength(0);
    fake().floorSwap(2);
    ticks(zone, 1);
    expect(fake().classSwaps).toEqual([expect.objectContaining({ pid: a.pid, inPlace: false })]);
    expect(shipOf(a).shipClass).toBe('tech');
    expect(a.chatTexts()).toContain('Floor 2: you fly the Arcanist now.');
    // a swap back before the floor ends cancels the queue
    a.send({ type: 'setShip', shipClass: 'brute' });
    a.send({ type: 'setShip', shipClass: 'tech' });
    expect(a.chatTexts()).toContain('Class change cancelled — you keep your Arcanist.');
    fake().floorSwap(3);
    ticks(zone, 1);
    expect(fake().classSwaps).toHaveLength(1);
  });

  it('extraction: the pilot turns spectator (ship kept for the scoreboard), the secured caches are banked and granted at results; result.rift', () => {
    const spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    onTestFinished(() => spy.mockRestore());
    const { zone, a, room, w, d } = riftMatch({ store: new MemoryProfileStore(), account: true });
    expect(w.config.lootMult).toBe(1); // dungeon solo multiplier is 1.0
    fake().floorSwap(3);
    ticks(zone, 1);
    const ship = shipOf(a);
    const key = tok(2, 'rift', 'keyChest');
    ship.alive = false; ship.skillState.rOut = 1; ship.respawnTick = Number.MAX_SAFE_INTEGER;
    d.extracted.push({ playerId: a.pid, floor: 3, tick: w.tick });
    w.events.push({ t: 'lootSecured', playerId: a.pid, how: 'extract', tokens: [key] });
    w.events.push({ t: 'extract', playerId: a.pid, x: 1000, y: 1000 });
    ticks(zone, 3);
    expect(a.chatTexts()).toContain('Ace extracted from floor 3 with 1 cache');
    expect(room.allPlayers.find((p) => p.playerId === a.pid)).toMatchObject({ extracted: true, inMatch: true, spectating: false });
    expect(a.snaps[a.snaps.length - 1].you).toBeNull(); // spectator snapshots from now on
    expect(w.ships.has(ship.id)).toBe(true);
    expect(fake().lootMult).toBe(0); // nobody left to pick loot up
    expect(botsOf(room)).toHaveLength(3); // an extracted pilot keeps the seat (no bot takes it)
    // the pilot's own inputs no longer reach the sim; team swaps are refused
    fake().inputs.delete(a.pid);
    a.send({ type: 'input', input: { ...ship.input, seq: 99 } });
    expect(fake().inputs.has(a.pid)).toBe(false);
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(a.chatTexts()).toContain("You extracted — you're watching the rest of the run.");
    // no active human remains: the sim ends the run 'extracted'
    simEnds(w, 'extracted');
    ticks(zone, 1);
    const res = a.last('matchEnd').result;
    expect(res).toMatchObject({ gameType: 'dungeon', subMode: 'coop', winnerTeam: 0 });
    expect(res.rift).toMatchObject({ outcome: 'extracted', floorsTotal: 6, floorReached: 3 });
    expect(res.rift!.players.find((p) => p.playerId === a.pid)).toEqual({ playerId: a.pid, status: 'extracted', floor: 3, deaths: 0 });
    for (const b of botsOf(room)) expect(res.rift!.players.find((p) => p.playerId === b.playerId)?.status).toBe('lost');
    expect(a.chatTexts()).toContain('Everyone extracted on floor 3.');
    expect(grantOf(spy, 'acc-Ace')!.input).toMatchObject({ gameType: 'dungeon', tokens: [key], cachesLost: 0 });
    expect(a.last('lootGrant').grant.cachesSecured).toBe(1);
  });

  it('an extracted pilot who leaves and rejoins only watches the rest of the run — never a second drop-in (integrator fix)', () => {
    const { zone, a, room, w, d } = riftMatch({ store: new MemoryProfileStore(), account: true });
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: room.id, intent: 'play' }); // keeps a human in the room
    fake().floorSwap(3);
    ticks(zone, 1);
    const ship = shipOf(a);
    ship.alive = false; ship.skillState.rOut = 1; ship.respawnTick = Number.MAX_SAFE_INTEGER;
    d.extracted.push({ playerId: a.pid, floor: 3, tick: w.tick });
    w.events.push({ t: 'extract', playerId: a.pid, x: 1000, y: 1000 });
    ticks(zone, 2);
    a.send({ type: 'leaveRoom' });
    a.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    const pa = room.allPlayers.find((p) => p.playerId === a.pid)!;
    expect(pa).toMatchObject({ extracted: true, pendingDropIn: false, inMatch: false });
    expect(a.last('matchStart')).toMatchObject({ yourShipId: 0 }); // watching
    expect(a.chatTexts()).toContain("You extracted — you're watching the rest of the run.");
    a.send({ type: 'setTeam', team: 0 });
    expect(pa.pendingDropIn).toBe(false);
    fake().floorSwap(4);
    ticks(zone, 1);
    expect(w.shipsByPlayer.has(a.pid)).toBe(false);
    expect(d.extracted.filter((e) => e.playerId === a.pid)).toHaveLength(1);
    // the next run starts clean
    end(b);
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(room.allPlayers.find((p) => p.playerId === a.pid)!.extracted).toBe(false);
  });

  it('Quick Play skips a rift whose Descend portal is departing (§3.4)', () => {
    const { zone, room, d } = riftMatch();
    d.portal = 1;
    const r = join(zone, 'Rex');
    r.send({ type: 'quickPlay', gameType: 'dungeon' });
    expect(r.last('roomState').roomId).toBe(room.id);
    d.portal = 2;
    const q = join(zone, 'Quin');
    q.send({ type: 'quickPlay', gameType: 'dungeon' });
    expect(q.last('roomState').roomId).not.toBe(room.id);
  });

  it('crate credit counts only floors flown: a late drop-in, or a spectator who drops in late and /ends, gets no party floors (integrator fix)', () => {
    const spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    onTestFinished(() => spy.mockRestore());
    const { zone, a, room, w } = riftMatch({ store: new MemoryProfileStore(), account: true });
    const b = join(zone, 'Bee', acct('Bee'));
    b.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    fake().floorSwap(5);
    ticks(zone, 1);
    expect(w.shipsByPlayer.has(b.pid)).toBe(true); // dropped in on floor 5
    fake().floorSwap(6);
    ticks(zone, 1);
    simEnds(w, 'cleared');
    ticks(zone, 1);
    expect(grantOf(spy, 'acc-Ace')!.input.crateRolls).toBe(1 + 3 + 1); // six floors flown + the full clear
    expect(grantOf(spy, 'acc-Bee')!.input.crateRolls).toBe(1 + 2); // floors 5 and 6 only, no full clear
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);

    // a host who watches while bots fly, drops in on floor 4 and /ends at once: no floor credit, so the time gates apply
    spy.mockClear();
    const { zone: z2, room: r2, w: w2 } = riftMatch({ store: new MemoryProfileStore(), account: true, patch: { name: 'Deep' } });
    const c = join(z2, 'Cee', acct('Cee'));
    c.send({ type: 'joinRoom', roomId: r2.id, intent: 'watch' });
    fake().floorSwap(4);
    ticks(z2, 1);
    c.send({ type: 'setTeam', team: 0 });
    fake().floorSwap(5);
    ticks(z2, 1);
    expect(w2.shipsByPlayer.has(c.pid)).toBe(true);
    const pc = r2.allPlayers.find((p) => p.playerId === c.pid)!;
    expect(pc.riftJoinFloor).toBe(5);
    simEnds(w2, 'wiped');
    ticks(z2, 1);
    const g = grantOf(spy, 'acc-Cee');
    expect(g?.input.crateRolls ?? 0).toBe(0);
  });

  it('/end (host) abandons the rift: abandonRift, carried caches lost, no winner, "Run abandoned on floor N."', () => {
    const spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    onTestFinished(() => spy.mockRestore());
    const { zone, a } = riftMatch({ store: new MemoryProfileStore(), account: true });
    fake().floorSwap(2);
    ticks(zone, 1);
    shipOf(a).carried = [tok(1, 'rift', 'roomChest')];
    const res = end(a);
    expect(fake().abandoned).toBe(true);
    expect(res.winnerTeam).toBe(-1);
    expect(res.rift).toMatchObject({ outcome: 'abandoned', floorReached: 2 });
    expect(res.rift!.players.find((p) => p.playerId === a.pid)!.status).toBe('lost');
    expect(a.chatTexts()).toContain('Ace abandoned the rift — unsecured loot is lost.');
    expect(a.chatTexts()).toContain('Run abandoned on floor 2.');
    expect(a.chatTexts().some((t) => t.startsWith('Team ') && t.endsWith(' wins!'))).toBe(false);
    expect(grantOf(spy, 'acc-Ace')!.input).toMatchObject({ tokens: [], cachesLost: 1 });
  });

  it('a cleared run: survivors, a leaver, awards (Delver, Treasure Hunter first; no PvP awards), carried caches secured', () => {
    const spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    onTestFinished(() => spy.mockRestore());
    const { zone, a, room, w } = riftMatch({ store: new MemoryProfileStore(), account: true });
    const b = join(zone, 'Bee');
    b.send({ type: 'joinRoom', roomId: room.id, intent: 'play' });
    fake().floorSwap(2);
    ticks(zone, 1);
    shipOf(b).deaths = 2;
    b.send({ type: 'leaveRoom' }); // quits on floor 2
    const bot = botsOf(room)[0];
    w.events.push(
      { t: 'chestOpen', room: 1, chest: 0, playerId: a.pid, team: 0, x: 0, y: 0 },
      { t: 'chestOpen', room: 2, chest: 0, playerId: a.pid, team: 0, x: 0, y: 0 },
      { t: 'chestOpen', room: 3, chest: 1, playerId: bot.playerId, team: 0, x: 0, y: 0 },
    );
    shipOf(a).kills = 3; // Reckless team-kills don't make a Top Gun in a rift
    ticks(zone, 1);
    fake().floorSwap(6);
    ticks(zone, 1);
    const carried = [tok(3, 'rift', 'bossCache')];
    shipOf(a).carried = carried.slice();
    simEnds(w, 'cleared');
    w.dungeon!.parties[0].roomsCleared = 31;
    w.dungeon!.parties[0].bossesKilled = 2;
    ticks(zone, 1);
    const res = a.last('matchEnd').result;
    expect(res.winnerTeam).toBe(0);
    expect(res.rift).toMatchObject({ outcome: 'cleared', floorReached: 6, roomsCleared: 31, bossesKilled: 2 });
    const st = (pid: number) => res.rift!.players.find((p) => p.playerId === pid);
    expect(st(a.pid)).toMatchObject({ status: 'survived', floor: 6 });
    expect(st(b.pid)).toEqual({ playerId: b.pid, status: 'left', floor: 2, deaths: 2 });
    expect(res.awards[0]).toMatchObject({ title: 'Delver', value: 'floor 6 (full clear)' });
    expect(res.awards[1]).toEqual({ title: 'Treasure Hunter', playerId: a.pid, value: '2 chests' });
    expect(res.awards.map((x) => x.title)).not.toContain('Top Gun');
    expect(a.chatTexts()).toContain('RIFT CONQUERED — all 6 floors cleared!');
    expect(grantOf(spy, 'acc-Ace')!.input).toMatchObject({ gameType: 'dungeon', tokens: carried }); // cleared: survivors bank what they carry
  });

  it('a wipe: "Party wiped on floor N — unsecured loot lost." and nothing carried survives', () => {
    const spy = vi.spyOn(ProfileService.prototype, 'grantBatch');
    onTestFinished(() => spy.mockRestore());
    const { zone, a, w } = riftMatch({ store: new MemoryProfileStore(), account: true });
    fake().floorSwap(5);
    ticks(zone, 1);
    shipOf(a).carried = [tok(0, 'rift', 'roomChest'), tok(1, 'common', 'elite')];
    simEnds(w, 'wiped');
    ticks(zone, 1);
    const res = a.last('matchEnd').result;
    expect(res.rift!.outcome).toBe('wiped');
    expect(res.winnerTeam).toBe(-1);
    expect(a.chatTexts()).toContain('Party wiped on floor 5 — unsecured loot lost.');
    expect(grantOf(spy, 'acc-Ace')!.input).toMatchObject({ tokens: [], cachesLost: 2 });
  });

  it('chat: the Matriarch wakes once per boss; instability once per floor', () => {
    const { zone, a, w } = riftMatch();
    fake().floorSwap(3);
    w.events.push({ t: 'bossIntro', id: 77, kind: 'matriarch', x: 0, y: 0 }, { t: 'bossIntro', id: 77, kind: 'matriarch', x: 0, y: 0 });
    w.events.push({ t: 'instability', sec: 0 }, { t: 'instability', sec: 25 });
    ticks(zone, 1);
    const texts = a.chatTexts();
    expect(texts.filter((t) => t === 'The Hive Matriarch awakens!')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Rift unstable — hunters inbound')).toHaveLength(1);
    expect(texts).toContain('Floor 3 — Hive Warrens · the Matriarch waits');
    fake().floorSwap(4);
    w.events.push({ t: 'instability', sec: 0 });
    ticks(zone, 1);
    expect(a.chatTexts().filter((t) => t === 'Rift unstable — hunters inbound')).toHaveLength(2);
  });

  it('a pilot out of lives watches RiftYou.followId: interest (gems, enemies…) follows that ship, not the wreck', () => {
    const { zone, a, w } = riftMatch();
    const me = shipOf(a);
    me.alive = false; me.skillState.rWait = 1; me.respawnTick = Number.MAX_SAFE_INTEGER; me.x = 200; me.y = 200;
    const lead = [...w.ships.values()].filter((s) => s.id !== me.id).sort((x, y) => x.playerId - y.playerId)[0];
    lead.alive = true; lead.x = 5000; lead.y = 5000;
    const gem = (id: number, x: number, y: number) => ({ id, x, y, vx: 0, vy: 0, value: 1, spawnTick: 0, expireTick: 1e9, magnetTo: 0 });
    w.gems.set(9001, gem(9001, 5050, 5000));
    w.gems.set(9002, gem(9002, 250, 200));
    ticks(zone, 3);
    const s = a.snaps[a.snaps.length - 1];
    expect(s.you!.rift).toMatchObject({ waiting: true, followId: lead.id });
    expect(s.gems.map((g) => g.id)).toContain(9001);
    expect(s.gems.map((g) => g.id)).not.toContain(9002);
  });

  it('house rooms: The Descent opens once coop is ready (and Quick Play finds it); Offline Descent too', () => {
    const on = houseRooms(false).find((r) => r.name === 'The Descent');
    expect(on).toMatchObject({ gameType: 'dungeon', subMode: 'coop', floors: 6, botFill: 4 });
    expect(houseRooms(true).find((r) => r.name === 'Offline Descent')).toMatchObject({ gameType: 'dungeon', subMode: 'coop' });
    const zone = mkZone(false, houseRooms(false));
    const a = join(zone, 'Ace');
    expect(a.last('roomList').rooms.find((r) => r.name === 'The Descent')).toMatchObject({
      gameType: 'dungeon', subMode: 'coop', mode: 'teams', teamCount: 1, maxPlayers: 4, floors: 6, house: true,
    });
    a.send({ type: 'quickPlay', gameType: 'dungeon' });
    expect(a.last('roomState').settings).toMatchObject({ name: 'The Descent', gameType: 'dungeon', subMode: 'coop' });
    SUB_MODES.coop.ready = false;
    expect(houseRooms(false).map((r) => r.name)).not.toContain('The Descent');
    expect(houseRooms(true).map((r) => r.name)).not.toContain('Offline Descent');
  });
});
