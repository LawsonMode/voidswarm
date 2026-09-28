// v0.3 M2 CLIENT: profile / lootGrant handling, equip + seenItems senders, the guest device profile and its
// self cosmetics patch, interpLoot and loot/carry in the RenderFrame, and the LocalProfileStore injected
// into the offline Zone. LOOT's pure ops and the map generator are mocked so these tests pin the client.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMsg, LootGrant, PlayerInfo, Profile, ServerMsg } from '../../shared/protocol';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/protocol';
import { BEAM_NONE, type LootView, type ShipView, type Snapshot } from '../../shared/types';
import { DEVICE_PROFILE_KEY, LocalProfileStore, type StorageLike } from '../profile/LocalProfileStore';
import { ConnectSuperseded, GameClient } from './GameClient';
import { findBracket, interpLoot } from './interp';
import { LocalTransport } from './LocalTransport';
import type { Transport } from './transport';

vi.mock('../../shared/sim/mapgen', () => ({ buildMatchMap: () => ({ width: 6400, height: 6400, tag: 'fake-map' }) }));

const zoneMock = vi.hoisted(() => ({ opts: null as unknown }));
vi.mock('../../shared/room/Zone', () => ({
  Zone: class {
    constructor(opts: unknown) { zoneMock.opts = opts; }
    connect() { return { handle() {}, close() {} }; }
    start() {}
    stop() {}
  },
}));

// Minimal stand-ins for LOOT's pure ops (profile.ts / rolls.ts), so these tests pin the client wiring only.
vi.mock('../../shared/profile/profile', () => {
  const blank = (now: number) => ({
    v: 1, owned: {}, shards: 0, loadout: { shared: {}, byClass: {} }, fresh: [], pity: {}, pityLegendary: 0,
    stats: { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} }, recent: [], updatedAt: now,
  });
  const CLASS = new Set(['hull', 'weapon', 'turret']);
  return {
    defaultProfile: blank,
    normalizeProfile: (raw: unknown, now: number) => (raw && typeof raw === 'object'
      ? { profile: JSON.parse(JSON.stringify(raw)), writable: ((raw as { v: number }).v ?? 1) <= 1 }
      : { profile: blank(now), writable: true }),
    resolveLoadout: (p: Profile, cls: string) => ({ ...p.loadout.shared, ...(p.loadout.byClass as Record<string, object>)[cls] }),
    equip: (p: Profile, slot: string, itemId: string, cls?: string) => {
      if (itemId && !p.owned[itemId]) return { ok: false, error: 'not owned' };
      const loadout = JSON.parse(JSON.stringify(p.loadout));
      const bucket = CLASS.has(slot) ? (loadout.byClass[cls!] ??= {}) : loadout.shared;
      if (itemId) bucket[slot] = itemId; else delete bucket[slot];
      return { ok: true, profile: { ...p, loadout } };
    },
    markSeen: (p: Profile, ids: readonly string[]) => ({ ...p, fresh: p.fresh.filter((id) => !ids.includes(id)) }),
  };
});
vi.mock('../../shared/profile/rolls', () => ({
  applyGrant: (p: Profile, g: LootGrant, now: number) => ({
    ...p,
    owned: { ...p.owned, ...Object.fromEntries(g.items.filter((i) => !i.dupe).map((i) => [i.itemId, { at: now, src: g.gameType }])) },
    fresh: [...p.fresh, ...g.items.filter((i) => !i.dupe).map((i) => i.itemId)],
    shards: p.shards + g.shards,
  }),
  rollGrant: () => { throw new Error('server only'); },
  botWardrobe: () => ({}),
}));

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
}

class FakeTransport implements Transport {
  onMessage: ((msg: ServerMsg) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onClose: ((reason: string, code?: number) => void) | null = null;
  sent: ClientMsg[] = [];
  constructor(readonly kind: 'online' | 'offline' = 'online') {}
  connect(): Promise<void> { return Promise.resolve(); }
  send(msg: ClientMsg): void { this.sent.push(msg); }
  close(): void {}
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function profile(extra: Partial<Profile> = {}): Profile {
  return {
    v: 1, owned: {}, shards: 0, loadout: { shared: {}, byClass: {} }, fresh: [], pity: {}, pityLegendary: 0,
    stats: { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} }, recent: [], updatedAt: 0, ...extra,
  };
}
const own = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { at: 1, src: 'warzone' as const }]));

function seedDevice(st: MemStorage, p: Profile, ledger: string[] = []): void {
  st.data.set(DEVICE_PROFILE_KEY, JSON.stringify({ v: 1, profiles: { local: p }, ledger }));
}
const deviceProfile = (st: MemStorage): Profile => JSON.parse(st.data.get(DEVICE_PROFILE_KEY)!).profiles.local;

function player(playerId: number, extra: Partial<PlayerInfo> = {}): PlayerInfo {
  return { playerId, name: `p${playerId}`, team: 0, shipClass: 'tech', isBot: false, isHost: false, ready: false, ping: 0, inMatch: false, ...extra };
}
function roomState(players: PlayerInfo[]): ServerMsg {
  return { type: 'roomState', roomId: 'r1', phase: 'lobby', settings: { ...DEFAULT_ROOM_SETTINGS }, players, hostPlayerId: 0, countdown: 0 };
}
function grant(key: string, extra: Partial<LootGrant> = {}): LootGrant {
  return {
    grantKey: key, gameType: 'warzone', shards: 10, cachesSecured: 1, cachesLost: 0, epicIn: 11, legendaryIn: 59,
    items: [{ itemId: 'com.death.glass', rarity: 3, from: 'crate', dupe: false, shards: 0 }], ...extra,
  };
}

async function connect(kind: 'online' | 'offline', account: boolean, st = new MemStorage()) {
  const c = new GameClient(null, new LocalProfileStore(() => st));
  const t = new FakeTransport(kind);
  const p = c.connectTransport(t, 'pilot');
  await flush();
  t.onMessage?.({
    type: 'welcome', playerId: 7, name: 'pilot', serverVersion: 'x', motd: '',
    account: account ? { accountId: 'acc1', username: 'pilot', emailMasked: 'p***@x', createdAt: 0 } : null,
  });
  await p;
  return { c, t, st };
}

describe('v0.3 profile + loot on the client', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('online guest: the device profile is shown, a server profile is ignored', async () => {
    const st = new MemStorage();
    seedDevice(st, profile({ shards: 42 }));
    const { c, t } = await connect('online', false, st);
    expect(c.deviceProfileMode).toBe(true);
    expect(c.profileSource).toBe('device');
    expect(c.profile?.shards).toBe(42);
    t.onMessage?.({ type: 'profile', profile: profile({ shards: 999 }), persisted: true });
    expect(c.profile?.shards).toBe(42);
    c.disconnect(true);
  });

  it('online guest: own PlayerInfo.cosmetics is patched from the device profile (new players Map)', async () => {
    const st = new MemStorage();
    seedDevice(st, profile({ owned: own('swarm.hull.tech', 'com.engine.aurora'), loadout: { shared: {}, byClass: { tech: { hull: 'swarm.hull.tech' } } } }));
    const { c, t } = await connect('online', false, st);
    t.onMessage?.(roomState([player(7), player(8)]));
    expect(c.players.get(7)?.cosmetics).toEqual({ hull: 'swarm.hull.tech' });
    expect(c.players.get(8)?.cosmetics).toBeUndefined(); // others see starters
    const before = c.players;
    // equip a shared slot: applied to the device profile, never sent to the server
    expect(c.equip('engine', 'com.engine.aurora')).toBe(true);
    expect(t.sent.some((m) => m.type === 'equip')).toBe(false);
    expect(c.players).not.toBe(before);
    expect(c.players.get(7)?.cosmetics).toEqual({ hull: 'swarm.hull.tech', engine: 'com.engine.aurora' });
    expect(deviceProfile(st).loadout.shared.engine).toBe('com.engine.aurora');
    expect(c.playerList.find((p) => p.playerId === 7)?.cosmetics?.engine).toBe('com.engine.aurora');
    // a later roomState (server sends no guest cosmetics) is re-patched
    t.onMessage?.(roomState([player(7), player(8)]));
    expect(c.players.get(7)?.cosmetics?.engine).toBe('com.engine.aurora');
    // not owned → refused locally with an error
    const errors: string[] = [];
    c.on('error', (e) => errors.push(e));
    expect(c.equip('death', 'rift.death.collapse')).toBe(false);
    expect(errors).toEqual(['not owned']);
    // a class slot needs the class
    expect(c.equip('hull', 'swarm.hull.tech')).toBe(false);
    c.disconnect(true);
  });

  it('online guest: lootGrant persisted:false is applied to the device profile exactly once', async () => {
    const st = new MemStorage();
    seedDevice(st, profile({ shards: 5 }));
    const { c, t } = await connect('online', false, st);
    const grants: LootGrant[] = [];
    c.on('lootGrant', ({ grant: g }) => grants.push(g));
    t.onMessage?.({ type: 'lootGrant', grant: grant('b:1#guest:7#0'), persisted: false });
    expect(deviceProfile(st).shards).toBe(15);
    expect(deviceProfile(st).owned['com.death.glass']).toBeTruthy();
    expect(c.profile?.shards).toBe(15);
    expect(c.lastGrant?.grantKey).toBe('b:1#guest:7#0');
    // a replay of the same grant key changes nothing
    t.onMessage?.({ type: 'lootGrant', grant: grant('b:1#guest:7#0'), persisted: false });
    expect(deviceProfile(st).shards).toBe(15);
    expect(grants.length).toBe(2);
    // seenItems clears NEW badges locally, nothing on the wire
    c.seenItems(['com.death.glass']);
    expect(deviceProfile(st).fresh).toEqual([]);
    expect(t.sent.some((m) => m.type === 'seenItems')).toBe(false);
    c.disconnect(true);
  });

  it('account: profile comes from the server; equip / seenItems go to the server; grants never touch the device', async () => {
    const st = new MemStorage();
    seedDevice(st, profile({ shards: 1 }));
    const { c, t } = await connect('online', true, st);
    expect(c.profile).toBeNull();
    t.onMessage?.({ type: 'profile', profile: profile({ shards: 77 }), persisted: false });
    expect(c.profileSource).toBe('server');
    expect(c.profile?.shards).toBe(77);
    expect(c.profilePersisted).toBe(false);
    expect(c.equip('hull', 'rift.hull.brute', 'brute')).toBe(true);
    expect(c.equip('title', '')).toBe(true);
    const eq = t.sent.filter((m) => m.type === 'equip');
    expect(eq).toEqual([
      { type: 'equip', slot: 'hull', itemId: 'rift.hull.brute', shipClass: 'brute' },
      { type: 'equip', slot: 'title', itemId: '' },
    ]);
    const ids = Array.from({ length: 70 }, (_, i) => `id.${i}`);
    c.seenItems([...ids, 'id.0', 'x'.repeat(41), '']);
    const seen = t.sent.filter((m): m is Extract<ClientMsg, { type: 'seenItems' }> => m.type === 'seenItems');
    expect(seen.map((m) => m.ids.length)).toEqual([64, 6]);
    t.onMessage?.({ type: 'lootGrant', grant: grant('b:1#acc1#0'), persisted: false });
    expect(deviceProfile(st).shards).toBe(1); // a store failure is not the device's business
    expect(c.lastGrant?.grantKey).toBe('b:1#acc1#0');
    c.disconnect(true);
  });

  it('offline: the device profile shows until the Zone\'s profile arrives; a grant the Zone already stored is not re-applied', async () => {
    const st = new MemStorage();
    seedDevice(st, profile({ shards: 30 }), ['b:2#local#0']);
    const { c, t } = await connect('offline', false, st);
    expect(c.profileSource).toBe('device');
    t.onMessage?.({ type: 'profile', profile: profile({ shards: 30 }), persisted: true });
    expect(c.profileSource).toBe('server');
    t.onMessage?.({ type: 'lootGrant', grant: grant('b:2#local#0'), persisted: false });
    expect(deviceProfile(st).shards).toBe(30);
    t.onMessage?.({ type: 'lootGrant', grant: grant('b:2#local#1'), persisted: false });
    expect(deviceProfile(st).shards).toBe(40);
    // offline equips go to the in-page Zone (its ProfileService owns the store)
    c.equip('engine', '');
    expect(t.sent.filter((m) => m.type === 'equip').length).toBe(1);
    c.disconnect(true);
  });

  it('matchStart clears the previous grant; buildFrame carries interpolated loot and carriers', async () => {
    const { c, t } = await connect('online', true);
    t.onMessage?.({ type: 'lootGrant', grant: grant('old'), persisted: true });
    expect(c.lastGrant).not.toBeNull();
    t.onMessage?.(roomState([player(7)]));
    t.onMessage?.({ type: 'matchStart', mapSeed: 1, mode: 'teams', teamCount: 2, gameType: 'warzone', subMode: 'deathmatch', floor: 0, yourShipId: 5, tick: 0, snapshotEvery: 3 });
    expect(c.lastGrant).toBeNull();
    const ship: ShipView = {
      id: 5, playerId: 7, team: 0, shipClass: 'tech', x: 100, y: 100, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true, attachedTo: 0,
      turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: BEAM_NONE, resonance: 1,
    };
    const loot: LootView[] = [{ id: 40, x: 10, y: 20, rarity: 3, set: 'swarm', reservedFor: 0, lifeFrac: 1 }];
    const snap = (tick: number): Snapshot => ({
      tick, ackSeq: 0, you: null, ships: [ship], enemies: [], projectiles: [], gems: [], deployables: [], events: [],
      match: { phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 600, teamScores: [0, 0], wave: 0, winnerTeam: -1, winnerPlayerId: 0 },
      loot, carry: [{ shipId: 5, n: 2, best: 3 }],
    });
    t.onSnapshot?.(snap(3));
    t.onSnapshot?.(snap(6));
    const f = c.buildFrame(performance.now(), 1, 1 / 60, 0, 0, 0)!;
    expect(f).not.toBeNull();
    expect(f.loot).toEqual(loot);
    expect(f.loot![0]).not.toBe(loot[0]); // copies, not the snapshot's objects
    expect(f.carry).toEqual([{ shipId: 5, n: 2, best: 3 }]);
    c.disconnect(true);
  });
});

describe('interpLoot', () => {
  const base = { rarity: 1 as const, set: 'common' as const, reservedFor: 0, lifeFrac: 1 };
  const s = (tick: number, loot?: LootView[]): Snapshot => ({
    tick, ackSeq: 0, you: null, ships: [], enemies: [], projectiles: [], gems: [], deployables: [], events: [],
    match: { phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 1, teamScores: [], wave: 0, winnerTeam: -1, winnerPlayerId: 0 },
    ...(loot ? { loot } : {}),
  });

  it('lerps caches present in both snapshots, keeps new ones where they are, tolerates a missing array', () => {
    const a = s(3, [{ id: 1, x: 0, y: 0, ...base }]);
    const b = s(6, [{ id: 1, x: 30, y: 60, ...base }, { id: 2, x: 5, y: 5, ...base }]);
    const out = interpLoot(findBracket([a, b], 4.5)!);
    expect(out[0]).toMatchObject({ id: 1, x: 15, y: 30 });
    expect(out[1]).toMatchObject({ id: 2, x: 5, y: 5 });
    expect(interpLoot(findBracket([s(3), s(6)], 4)!)).toEqual([]);
    expect(interpLoot(findBracket([s(3), b], 4)!).map((l) => l.id)).toEqual([1, 2]);
  });
});

describe('LocalTransport', () => {
  it('injects the device ProfileStore into the offline Zone (ZoneOptions.profiles)', async () => {
    const store = new LocalProfileStore(() => null);
    const t = new LocalTransport({ profiles: store });
    await t.connect();
    expect((zoneMock.opts as { profiles?: unknown }).profiles).toBe(store);
    expect((zoneMock.opts as { local?: boolean }).local).toBe(true);
    t.close();
  });

  it('GameClient.connectOffline shares its device store with the Zone', async () => {
    const c = new GameClient(null, new LocalProfileStore(() => null));
    const p = c.connectOffline('me');
    await flush();
    expect((zoneMock.opts as { profiles?: unknown }).profiles).toBe(c.deviceStore);
    c.disconnect(true);
    await expect(p).rejects.toBeInstanceOf(ConnectSuperseded);
  });
});

describe('M2 integration: guest Debrief duplicates, read-only device profile', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('online guest: an item the device already owns shows as a duplicate in the grant the Debrief reads', async () => {
    const st = new MemStorage();
    seedDevice(st, profile({ owned: own('com.death.glass'), shards: 5 }));
    const { c, t } = await connect('online', false, st);
    t.onMessage?.({ type: 'lootGrant', grant: grant('b:2#guest:7#0'), persisted: false });
    expect(c.lastGrant?.items[0]).toMatchObject({ itemId: 'com.death.glass', dupe: true });
    expect(c.lastGrant!.items[0].shards).toBeGreaterThan(0);
    expect(c.lastGrant!.shards).toBe(10 + c.lastGrant!.items[0].shards);
    expect(deviceProfile(st).shards).toBe(5 + c.lastGrant!.shards); // what the device applied = what is shown
    c.disconnect(true);
  });

  it('a newer-version device blob is read-only (not "storage blocked"), from connect time', async () => {
    const st = new MemStorage();
    st.data.set(DEVICE_PROFILE_KEY, JSON.stringify({ v: 2, profiles: { local: profile({ shards: 3 }) }, ledger: [] }));
    const { c } = await connect('online', false, st);
    expect(c.deviceReadOnly).toBe(true);
    expect(c.deviceVolatile).toBe(false);
    c.disconnect(true);
    const ok = await connect('online', false, new MemStorage());
    expect(ok.c.deviceReadOnly).toBe(false);
    ok.c.disconnect(true);
  });

  it('offline: the in-page Zone reporting persisted:false (a v > 1 profile) marks the device profile read-only', async () => {
    const { c, t } = await connect('offline', false);
    t.onMessage?.({ type: 'profile', profile: profile(), persisted: true });
    expect(c.deviceReadOnly).toBe(false);
    t.onMessage?.({ type: 'profile', profile: { ...profile(), v: 2 }, persisted: false });
    expect(c.deviceReadOnly).toBe(true);
    c.disconnect(true);
  });
});
