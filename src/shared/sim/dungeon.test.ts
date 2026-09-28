// SIM v0.3 M4 acceptance (docs/v0.3-proposal.md §9 SIM dungeon.test, §4.3–4.7): a room seals 1.5 s after entry and
// recalls teammates, the nudge moves ships inside; clear unseals, moves the anchor, and the chest opens once; a death
// costs a life, 0 lives means waiting; a vacated sealed room resets after 2 s; wipe; the extract channel completes,
// secures caches and removes the ship; the floor swap keeps ids / XP / level / upgrades / path / carried, clears
// entities and loot, revives waiting pilots, emits floorStart, keeps grid dimensions; final boss → cleared after 45 s.
//
// The real Sim and the real floor generator; PVE's encounter hooks are replaced by switches (vi.mock) so this file
// tests the SIM state machine alone: riftEncounterDone(room) is true exactly when the test says the room is beaten,
// and pveStep is a no-op (no swarm, no enemy AI). dungeon.integration.test.ts runs the same flow on the real PVE.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RIFT_LIVES_CAP, RIFT_RESPAWN_SEC, TICK_RATE } from '../constants';
import type { CacheToken, GameEvent, RiftRoom, Ship, ShipClassId, SimConfig, World } from '../types';
import { RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_DOOR, TILE_WALL } from '../types';
import { damageEnemy, damageShip } from './combat';
import {
  buildRiftView, RIFT_ARM_SEC, RIFT_CHEST_OFFSET_PX, RIFT_EXTRACT_TICKS, RIFT_PORTAL_HOLD_SEC, RIFT_VICTORY_SEC,
  riftSpawnPoint, riftYou, startingLives,
} from './dungeon';
import { roomAt } from './floorgen';
import { rollLoot } from './loot';
import { spawnEnemy } from './pve/enemies';
import { Sim } from './Sim';
import { side } from './state';
import { dropGems, projectileDefaults, spawnDeployable, spawnProjectile } from './world';

const hooks = vi.hoisted(() => ({
  done: new Set<number>(),
  started: [] as [number, number][],
  resets: [] as number[],
  floorInits: 0,
}));

vi.mock('./pve/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pve/index')>();
  return {
    ...real,
    pveStep: () => {},
    riftFloorInit: () => { hooks.floorInits++; },
    riftEncounterStart: (_w: World, room: number, n: number) => { hooks.started.push([room, n]); },
    riftEncounterDone: (_w: World, room: number) => hooks.done.has(room),
    riftEncounterReset: (_w: World, room: number) => { hooks.resets.push(room); },
  };
});

beforeEach(() => {
  hooks.done.clear();
  hooks.started.length = 0;
  hooks.resets.length = 0;
  hooks.floorInits = 0;
});

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  mapSeed: 1234, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
  gameType: 'dungeon', subMode: 'coop', floors: 6, lootMult: 4, lootSeed: 0x5eed, ...o,
});
interface Pilot { cls?: ShipClassId; bot?: boolean }
/** A rift with these pilots (pids 1..n), stepped once so the party's lives are counted. */
function rig(o: Partial<SimConfig> = {}, pilots: Pilot[] = [{}, {}]) {
  const sim = new Sim(cfg(o));
  const w = sim.world;
  const ships = pilots.map((p, i) =>
    w.ships.get(sim.addPlayer({ playerId: i + 1, name: 'p' + (i + 1), team: 0, shipClass: p.cls ?? 'brute', isBot: !!p.bot }))!);
  sim.step();
  sim.drainEvents();
  return { sim, w, d: w.dungeon!, ships, L: () => w.map.dungeon! };
}
function run(sim: Sim, n: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) { sim.step(); out.push(...sim.drainEvents()); }
  return out;
}
const ofType = <T extends GameEvent['t']>(ev: GameEvent[], t: T) => ev.filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);
function put(s: Ship, x: number, y: number): void { s.x = x; s.y = y; s.vx = 0; s.vy = 0; }
const kill = (w: World, s: Ship): void => { s.invulnUntilTick = 0; damageShip(w, s, 1e9, 0, 'enemy'); };
const inside = (w: World, s: Ship, room: RiftRoom): boolean => roomAt(w.map, s.x, s.y) === room.idx;
const doorTiles = (w: World, room: RiftRoom): number[] => room.doors.flatMap((d) => d.tiles.map((t) => w.map.tiles[t]));
const firstArena = (w: World): RiftRoom => w.map.dungeon!.rooms.find((r) => r.kind === 'arena' && r.mainPath)!;
const ARM_TICKS = Math.round(RIFT_ARM_SEC * TICK_RATE);
/** `s` walks into the room centre: one step to arm, ARM_TICKS more to seal. Returns every event of those steps. */
function sealWith(sim: Sim, s: Ship, room: RiftRoom): GameEvent[] {
  put(s, room.x, room.y);
  return run(sim, 1 + ARM_TICKS);
}
const tok = (rarity: CacheToken['rarity'], source: CacheToken['source'] = 'roomChest'): CacheToken => ({ rarity, set: 'rift', source });
function toFloor(sim: Sim, floor: number): GameEvent[] {
  sim.world.dungeon!.pendingFloor = floor;
  return run(sim, 1);
}

describe('run start', () => {
  it('floor 1 of a fresh run: entrance visited, tier 1, untimed; lives 2 + 2·party (+ difficulty), counted at run start', () => {
    const { w, d, L } = rig({}, [{}, {}, { bot: true }]);
    const ent = L().rooms[L().entrances[0]];
    expect([d.floor, d.floorsTotal, d.outcome, d.portal, d.extractOpen]).toEqual([1, 6, 'running', 0, false]);
    expect(d.rooms[ent.idx].state).toBe(RIFT_CLEARED);
    expect(d.rooms.filter((r) => r.state === RIFT_DORMANT)).toHaveLength(L().rooms.length - 1);
    expect(d.parties).toHaveLength(1);
    expect(d.parties[0]).toMatchObject({ team: 0, lives: 8, status: 'active', anchorX: ent.x, anchorY: ent.y, seen: 1 << ent.idx, deepestFloor: 1 });
    expect(w.pve.wave).toBe(1);
    expect(w.match.endTick).toBe(0);
    for (const s of w.ships.values()) expect(roomAt(w.map, s.x, s.y)).toBe(ent.idx); // spawned in the entrance
    // the table: Story +2, Veteran 0, Nightmare −2 (never below 2), capped at RIFT_LIVES_CAP
    expect([startingLives(1, 1), startingLives(1, 2), startingLives(1, 3)]).toEqual([6, 4, 2]);
    expect([startingLives(4, 1), startingLives(4, 2), startingLives(4, 3)]).toEqual([RIFT_LIVES_CAP, 10, 8]);
    // counted once: a later join does not recount
    const late = rig({ pveIntensity: 3 }, [{}]);
    expect(late.d.parties[0].lives).toBe(2);
    late.sim.addPlayer({ playerId: 9, name: 'late', team: 0, shipClass: 'tech', isBot: true });
    run(late.sim, 3);
    expect(late.d.parties[0].lives).toBe(2);
  });

  it('entering a non-sealable room visits it (minimap + CLEARED) without sealing anything', () => {
    const { sim, w, d, ships: [a] } = rig();
    const hall = w.map.dungeon!.rooms.find((r) => r.kind === 'hall')!;
    put(a, hall.x, hall.y);
    const ev = run(sim, 2);
    expect(d.rooms[hall.idx].state).toBe(RIFT_CLEARED);
    expect(d.parties[0].seen & (1 << hall.idx)).toBeTruthy();
    expect(ofType(ev, 'roomSeal')).toEqual([]);
    expect(hall.doors).toEqual([]);
  });
});

describe('sealing (§4.3)', () => {
  it('a room seals 1.5 s after entry and recalls teammates; the nudge moves ships inside', () => {
    const { sim, w, d, ships: [a, b, c] } = rig({}, [{}, {}, { cls: 'tech' }]);
    const A = firstArena(w);
    const ent = w.map.dungeon!.rooms[0];
    const door = A.doors[0];
    const dc = door.tiles.reduce((p, t) => ({ x: p.x + ((t % w.map.cols) + 0.5) * w.map.tileSize / door.tiles.length, y: p.y + (Math.floor(t / w.map.cols) + 0.5) * w.map.tileSize / door.tiles.length }), { x: 0, y: 0 });
    put(a, A.x, A.y);
    put(b, ent.x, ent.y); // far away, in the entrance
    put(c, dc.x, dc.y); // straddling the doorway
    const e = spawnEnemy(w, 'drone', dc.x + 8, dc.y - 8)!;
    const t0 = w.tick;
    let ev = run(sim, 1);
    expect(d.rooms[A.idx]).toMatchObject({ state: RIFT_ARMING, until: t0 + 1 + ARM_TICKS, sealedBy: 0 });
    expect(ofType(ev, 'roomSeal')).toEqual([{ t: 'roomSeal', room: A.idx, team: 0, sec: RIFT_ARM_SEC }]);
    ev = run(sim, ARM_TICKS - 1);
    expect(d.rooms[A.idx].state).toBe(RIFT_ARMING); // doors still open, nothing moved
    expect(new Set(doorTiles(w, A))).toEqual(new Set([TILE_DOOR]));
    expect([b.x, b.y]).toEqual([ent.x, ent.y]);
    const rev0 = w.map.rev ?? 0;
    ev = run(sim, 1);
    expect(d.rooms[A.idx].state).toBe(RIFT_SEALED);
    expect(new Set(doorTiles(w, A))).toEqual(new Set([TILE_WALL]));
    expect(w.map.rev).toBe(rev0 + 1);
    expect(ofType(ev, 'roomSeal')).toEqual([{ t: 'roomSeal', room: A.idx, team: 0, sec: 0 }]);
    expect(hooks.started).toEqual([[A.idx, 3]]);
    // recall: b is inside, on the 50–90 px ring of a door in-point, with a blink from the entrance
    expect(inside(w, b, A)).toBe(true);
    const ring = Math.min(...A.doors.map((dd) => Math.hypot(b.x - dd.inX, b.y - dd.inY)));
    expect(ring).toBeLessThanOrEqual(90 + 1e-6);
    expect(ofType(ev, 'blink').find((x) => x.shipId === b.id)).toMatchObject({ fromX: ent.x, fromY: ent.y, x: b.x, y: b.y });
    // nudge: the ship and the enemy in the doorway are moved inside, within ±40 px of that door's in-point
    for (const body of [c, e]) {
      expect(roomAt(w.map, body.x, body.y)).toBe(A.idx);
      expect(Math.abs(body.x - door.inX)).toBeLessThanOrEqual(40);
      expect(Math.abs(body.y - door.inY)).toBeLessThanOrEqual(40);
    }
    // a stayed where it was
    expect([a.x, a.y]).toEqual([A.x, A.y]);
  });

  it('a seal recall leaves a pilot channelling Extract where it is (integrator fix)', () => {
    const { sim, w, d, ships: [a, b, c] } = rig({}, [{}, {}, {}]);
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    const boss = L.rooms[L.keyRoom];
    sealWith(sim, a, boss);
    for (const s of [a, b, c]) put(s, boss.doors[0].inX, boss.doors[0].inY);
    hooks.done.add(boss.idx);
    run(sim, 1);
    expect(d.extractOpen).toBe(true);
    const A = L.rooms.find((r) => r.kind === 'arena' && d.rooms[r.idx].state === RIFT_DORMANT)!;
    put(a, L.extractX, L.extractY);
    put(c, boss.x, boss.y - 300); // idles in the boss room: recalled
    run(sim, 20);
    const t0 = a.skillState.rExT!;
    expect(t0).toBe(20);
    const ev = sealWith(sim, b, A);
    expect(d.rooms[A.idx].state).toBe(RIFT_SEALED);
    expect([a.x, a.y]).toEqual([L.extractX, L.extractY]);
    expect(a.skillState.rExT).toBe(t0 + 1 + ARM_TICKS);
    expect(inside(w, c, A)).toBe(true);
    expect(ofType(ev, 'blink').map((e) => e.shipId)).not.toContain(a.id);
  });

  it('one fight at a time: another sealable room does not arm while the party has one sealed', () => {
    const { sim, w, d, ships: [a, b] } = rig({}, [{}, { bot: true }]);
    const arenas = w.map.dungeon!.rooms.filter((r) => r.kind === 'arena');
    const [A, B] = arenas;
    sealWith(sim, a, A);
    expect(d.rooms[A.idx].state).toBe(RIFT_SEALED);
    put(b, B.x, B.y); // a bot "left" the sealed room (teleport)
    run(sim, 30);
    expect(d.rooms[B.idx].state).toBe(RIFT_DORMANT);
    hooks.done.add(A.idx);
    run(sim, 2);
    expect(d.rooms[A.idx].state).toBe(RIFT_CLEARED);
    expect(d.rooms[B.idx].state).toBe(RIFT_ARMING);
  });

  it('a ship just inside the rim (within the 3-tile trigger inset) does not arm the room; 3 tiles in does', () => {
    const { sim, w, d, ships: [a] } = rig({}, [{}]);
    const A = firstArena(w);
    put(a, (A.c0 + 1.5) * w.map.tileSize, A.y); // inside the room, but within 3 tiles of its wall
    run(sim, 5);
    expect(d.rooms[A.idx].state).toBe(RIFT_DORMANT);
    put(a, (A.c0 + 3.5) * w.map.tileSize, A.y);
    run(sim, 1);
    expect(d.rooms[A.idx].state).toBe(RIFT_ARMING);
  });
});

describe('clear, chests, regroup (§4.3)', () => {
  it('clear unseals, rewards the ships inside, moves the anchor, and the chest opens once (personal caches for every human)', () => {
    const { sim, w, d, ships: [a, b] } = rig();
    const A = firstArena(w);
    sealWith(sim, a, A);
    // the reward chest stays shut while the room is sealed
    const [cx, cy] = A.chests;
    expect([cx, cy]).toEqual([A.x, A.y + RIFT_CHEST_OFFSET_PX]);
    put(a, cx, cy);
    let ev = run(sim, 3);
    expect(ofType(ev, 'chestOpen')).toEqual([]);
    put(a, A.x, A.y);
    const before = [a.score, b.score, a.xp + a.level * 1e6, b.xp + b.level * 1e6];
    hooks.done.add(A.idx);
    ev = run(sim, 1);
    expect(d.rooms[A.idx].state).toBe(RIFT_CLEARED);
    expect(new Set(doorTiles(w, A))).toEqual(new Set([TILE_DOOR]));
    expect(ofType(ev, 'roomClear')).toEqual([{ t: 'roomClear', room: A.idx, team: 0, x: A.x, y: A.y }]);
    expect(d.parties[0]).toMatchObject({ anchorX: A.x, anchorY: A.y - 120, roomsCleared: 1 });
    expect([a.score - before[0], b.score - before[1]]).toEqual([25, 25]);
    expect(a.xp + a.level * 1e6).toBeGreaterThan(before[2]);
    expect(b.xp + b.level * 1e6).toBeGreaterThan(before[3]);
    expect(d.portal).toBe(0); // an arena opens nothing
    // now the chest opens, once
    put(a, cx + 20, cy);
    ev = run(sim, 1);
    expect(ofType(ev, 'chestOpen')).toEqual([{ t: 'chestOpen', room: A.idx, chest: 0, playerId: 1, team: 0, x: cx, y: cy }]);
    expect(d.rooms[A.idx].chests).toBe(1);
    const drops = ofType(ev, 'lootDrop');
    expect(drops).toHaveLength(2); // roomChest 25% × lootMult 4 = 100%, one personal cache per human
    expect(drops.every((x) => x.source === 'roomChest')).toBe(true);
    ev = run(sim, 30);
    expect(ofType(ev, 'chestOpen')).toEqual([]);
    expect(ofType(ev, 'lootDrop')).toEqual([]);
    expect((a.carried ?? []).length).toBe(1); // a took its own cache; b's stays reserved for b
    expect([...w.loot!.values()].map((l) => l.reservedFor)).toEqual([2]);
  });

  it('treasure chests open any time; the key room opens Descend; bots open chests only with no human alive; loot is for humans only', () => {
    const { sim, w, d, ships: [a, bot] } = rig({}, [{}, { bot: true }]);
    const L = w.map.dungeon!;
    const T = L.rooms.find((r) => r.kind === 'treasure')!;
    put(bot, T.chests[0], T.chests[1]);
    let ev = run(sim, 1);
    expect(ofType(ev, 'chestOpen')).toEqual([]); // the human is alive: the chest (and the Treasure Hunter credit) waits for a pilot
    a.alive = false; a.respawnTick = Number.MAX_SAFE_INTEGER;
    ev = run(sim, 1);
    a.alive = true; a.respawnTick = 0;
    expect(ofType(ev, 'chestOpen')).toMatchObject([{ room: T.idx, chest: 0, playerId: 2 }]);
    const drop = ofType(ev, 'lootDrop');
    expect(drop.length).toBe(1); // treasureChest 25% × 4: one personal cache, for the human only
    expect(w.loot!.get(drop[0].id)!.reservedFor).toBe(1);
    const key = L.rooms[L.keyRoom];
    expect(key.kind).toBe('key');
    sealWith(sim, a, key);
    put(a, key.doors[0].inX, key.doors[0].inY); // out of the Descend zone (the room centre)
    hooks.done.add(key.idx);
    ev = run(sim, 1);
    expect(d.portal).toBe(1);
    expect(ofType(ev, 'portalOpen')).toEqual([{ t: 'portalOpen', x: L.portalX, y: L.portalY, extract: false }]);
    expect(d.extractOpen).toBe(false);
    put(a, key.chests[0], key.chests[1]);
    ev = run(sim, 1);
    expect(ofType(ev, 'chestOpen')).toHaveLength(1);
    expect(ofType(ev, 'lootDrop')[0]).toMatchObject({ source: 'keyChest' });
  });

  it('a vacated sealed room resets after 2 s: dormant, unsealed, enemies inside removed, chest bits kept', () => {
    const { sim, w, d, ships: [a] } = rig({}, [{}]);
    const A = firstArena(w);
    sealWith(sim, a, A);
    d.rooms[A.idx].chests = 1;
    const e = spawnEnemy(w, 'weaver', A.x + 100, A.y)!;
    const outside = spawnEnemy(w, 'weaver', w.map.dungeon!.rooms[0].x, w.map.dungeon!.rooms[0].y)!;
    const ent = w.map.dungeon!.rooms[0];
    put(a, ent.x, ent.y); // the party is gone (a teleport stands in for a death / a blink out)
    let ev = run(sim, 2 * TICK_RATE - 1);
    expect(d.rooms[A.idx].state).toBe(RIFT_SEALED);
    expect(d.rooms[A.idx].vacantTicks).toBe(2 * TICK_RATE - 1);
    ev = run(sim, 1);
    expect(d.rooms[A.idx]).toMatchObject({ state: RIFT_DORMANT, sealedBy: -1, vacantTicks: 0, chests: 1 });
    expect(new Set(doorTiles(w, A))).toEqual(new Set([TILE_DOOR]));
    expect(ofType(ev, 'roomReset')).toEqual([{ t: 'roomReset', room: A.idx, team: 0 }]);
    expect(hooks.resets).toEqual([A.idx]);
    expect(w.enemies.has(e.id)).toBe(false);
    expect(w.enemies.has(outside.id)).toBe(true);
    // a member back inside keeps a sealed room alive
    sealWith(sim, a, A);
    for (let i = 0; i < 5; i++) {
      put(a, ent.x, ent.y);
      run(sim, TICK_RATE);
      put(a, A.x, A.y);
      run(sim, 1);
    }
    expect(d.rooms[A.idx].state).toBe(RIFT_SEALED);
  });
});

describe('lives, respawn, wipe (§4.6)', () => {
  it('a death costs a life (respawn in 5 s); at 0 lives the pilot waits for the next floor', () => {
    const { sim, w, d, ships: [a, b] } = rig();
    expect(d.parties[0].lives).toBe(6);
    kill(w, a);
    let ev = sim.drainEvents();
    expect(ofType(ev, 'lifeLost')).toEqual([{ t: 'lifeLost', team: 0, playerId: 1, lives: 5 }]);
    expect(a.respawnTick).toBe(w.tick + RIFT_RESPAWN_SEC * TICK_RATE);
    run(sim, RIFT_RESPAWN_SEC * TICK_RATE);
    expect(a.alive).toBe(true);
    expect(roomAt(w.map, a.x, a.y)).toBe(0); // back at the anchor (the entrance)
    d.parties[0].lives = 0;
    kill(w, b);
    ev = sim.drainEvents();
    expect(ofType(ev, 'outOfLives')).toEqual([{ t: 'outOfLives', playerId: 2, x: b.x, y: b.y }]);
    expect(ofType(ev, 'lifeLost')).toEqual([]);
    expect([b.skillState.rWait, b.respawnTick]).toEqual([1, Number.MAX_SAFE_INTEGER]);
    run(sim, 20 * TICK_RATE);
    expect(b.alive).toBe(false);
    expect(d.outcome).toBe('running'); // a is still flying
    expect(buildRiftView(w).waiting).toEqual([2]);
    expect(riftYou(w, b)).toEqual({ party: 0, lives: 0, waiting: true, extracted: false, extract: 0, followId: a.id });
    expect(riftYou(w, a)).toMatchObject({ waiting: false, followId: 0 });
  });

  it('respawn point: the sealed room holding a live member (its door in-point), else the party anchor', () => {
    const { sim, w, ships: [a, b] } = rig();
    const A = firstArena(w);
    sealWith(sim, a, A);
    expect(inside(w, b, A)).toBe(true);
    kill(w, b);
    run(sim, RIFT_RESPAWN_SEC * TICK_RATE);
    expect(b.alive).toBe(true);
    expect(inside(w, b, A)).toBe(true);
    const dd = Math.hypot(b.x - A.doors[0].inX, b.y - A.doors[0].inY);
    expect(dd === 0 || (dd >= 60 - 1e-6 && dd <= 120 + 1e-6)).toBe(true);
    // no live member in a sealed room → the anchor ring (the entrance at floor start)
    const p = riftSpawnPoint(w, { ...a, team: 0, alive: false } as Ship);
    expect(p).not.toBeNull();
  });

  it('wipe: the last member down with no life left ends the run (partyWiped, riftEnd, match over, no winner)', () => {
    const { sim, w, d, ships: [a, b] } = rig();
    d.parties[0].lives = 0;
    kill(w, a);
    expect(d.outcome).toBe('running');
    kill(w, b);
    const ev = sim.drainEvents();
    expect(ofType(ev, 'partyWiped')).toEqual([{ t: 'partyWiped', team: 0 }]);
    expect(ofType(ev, 'riftEnd')).toEqual([{ t: 'riftEnd', outcome: 'wiped' }]);
    expect([d.outcome, d.parties[0].status]).toEqual(['wiped', 'wiped']);
    const end = run(sim, 1);
    expect(w.match.phase).toBe('ended');
    expect(w.match.winnerTeam).toBe(-1);
    expect(ofType(end, 'matchEnd')).toHaveLength(1);
  });

  it('a death paid with a life is still coming back: not a wipe (the spent life is honoured)', () => {
    const { sim, w, d, ships: [a, b] } = rig();
    d.parties[0].lives = 1;
    kill(w, a); // the last life: a respawns in 5 s
    kill(w, b); // 0 lives: b waits
    expect(d.outcome).toBe('running');
    run(sim, RIFT_RESPAWN_SEC * TICK_RATE);
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(false);
    kill(w, a); // now nobody is coming back
    expect(d.outcome).toBe('wiped');
  });
});

describe('extraction (§4.7)', () => {
  it('the extract channel completes, secures caches and removes the ship; bots never channel; decay outside', () => {
    const { sim, w, d, ships: [a, b, c] } = rig({}, [{}, {}, { bot: true }]);
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    expect([L.floor, L.bossFloor, d.floor]).toEqual([3, true, 3]);
    const boss = L.rooms[L.keyRoom];
    expect(boss.kind).toBe('boss');
    sealWith(sim, a, boss);
    expect(d.rooms[boss.idx].state).toBe(RIFT_SEALED);
    const lives0 = d.parties[0].lives;
    // keep the humans out of the Descend zone (the room centre) or the clear would start the countdown
    const idle = { x: boss.doors[0].inX, y: boss.doors[0].inY };
    put(a, idle.x, idle.y + 40);
    put(b, idle.x, idle.y);
    hooks.done.add(boss.idx);
    let ev = run(sim, 1);
    expect(d.rooms[boss.idx].state).toBe(RIFT_CLEARED);
    expect([d.portal, d.extractOpen, d.parties[0].bossesKilled, d.parties[0].lives]).toEqual([1, true, 1, Math.min(RIFT_LIVES_CAP, lives0 + 2)]);
    expect(ofType(ev, 'portalOpen')).toEqual([
      { t: 'portalOpen', x: L.portalX, y: L.portalY, extract: false },
      { t: 'portalOpen', x: L.extractX, y: L.extractY, extract: true },
    ]);
    put(c, L.extractX, L.extractY + 30); // a bot in the Extract zone: never channels
    const tokens = [tok(4, 'bossCache'), tok(1)];
    a.carried = tokens.slice();
    put(a, L.extractX, L.extractY);
    const score0 = a.score;
    ev = run(sim, RIFT_EXTRACT_TICKS - 1);
    expect(a.alive).toBe(true);
    expect(a.skillState.rExtract).toBeCloseTo((RIFT_EXTRACT_TICKS - 1) / RIFT_EXTRACT_TICKS, 9);
    expect(buildRiftView(w).extracting).toEqual([{ playerId: 1, frac: Math.round(((RIFT_EXTRACT_TICKS - 1) / RIFT_EXTRACT_TICKS) * 1000) / 1000 }]);
    ev = run(sim, 1);
    expect([a.alive, a.skillState.rOut, a.respawnTick]).toEqual([false, 1, Number.MAX_SAFE_INTEGER]);
    expect(ofType(ev, 'lootSecured')).toEqual([{ t: 'lootSecured', playerId: 1, how: 'extract', tokens }]);
    expect(ofType(ev, 'extract')).toEqual([{ t: 'extract', playerId: 1, x: a.x, y: a.y }]);
    expect(d.extracted).toEqual([{ playerId: 1, floor: 3, tick: w.tick }]);
    expect(a.carried).toEqual([]);
    expect(a.score - score0).toBe(100);
    expect(w.ships.has(a.id)).toBe(true); // stays for the scoreboard
    expect(riftYou(w, a)).toMatchObject({ extracted: true, extract: 1 });
    expect(c.skillState.rExtract).toBeUndefined();
    run(sim, 10 * TICK_RATE);
    expect(a.alive).toBe(false);
    expect(d.outcome).toBe('running'); // b is still here
    // decay: half a channel, then out of the zone at 2× speed
    put(b, L.extractX, L.extractY);
    run(sim, RIFT_EXTRACT_TICKS / 2);
    expect(b.skillState.rExtract).toBeCloseTo(0.5, 9);
    put(b, idle.x, idle.y);
    run(sim, 1);
    expect(b.skillState.rExtract).toBeCloseTo(0.5 - 2 / RIFT_EXTRACT_TICKS, 9);
    run(sim, RIFT_EXTRACT_TICKS / 4);
    expect(b.skillState.rExtract).toBeUndefined();
    // the last human out: outcome 'extracted', the party is done, the match ends with team 0 on top
    put(b, L.extractX, L.extractY);
    ev = run(sim, RIFT_EXTRACT_TICKS);
    expect(b.skillState.rOut).toBe(1);
    expect([d.outcome, d.parties[0].status]).toEqual(['extracted', 'done']);
    expect(ofType(ev, 'riftEnd')).toEqual([{ t: 'riftEnd', outcome: 'extracted' }]);
    expect([w.match.phase, w.match.winnerTeam]).toEqual(['ended', 0]);
  });
});

describe('descend + floor swap (§4.7)', () => {
  it('Descend: 20 s countdown from a human in the zone, 3 s once every alive human is in; bots alone never start it; +50 each', () => {
    const { sim, w, d, ships: [a, b, c] } = rig({}, [{}, {}, { bot: true }]);
    const L = w.map.dungeon!;
    const key = L.rooms[L.keyRoom];
    sealWith(sim, a, key);
    const off = { x: key.doors[0].inX, y: key.doors[0].inY };
    put(a, off.x, off.y); put(b, off.x, off.y + 40);
    put(c, L.portalX, L.portalY); // a bot in the zone
    hooks.done.add(key.idx);
    let ev = run(sim, 30);
    expect(d.portal).toBe(1);
    expect(ofType(ev, 'departing')).toEqual([]); // humans alive: the bot can't start it
    put(a, L.portalX + 50, L.portalY);
    ev = run(sim, 1);
    expect(d.portal).toBe(2);
    expect(ofType(ev, 'departing')).toEqual([{ t: 'departing', sec: 20, team: 0 }]);
    expect(d.departTick).toBe(w.tick + 20 * TICK_RATE);
    expect(buildRiftView(w).departIn).toBe(20);
    run(sim, 2 * TICK_RATE);
    put(b, L.portalX - 50, L.portalY);
    ev = run(sim, 1);
    expect(ofType(ev, 'departing')).toEqual([{ t: 'departing', sec: 3, team: 0 }]);
    expect(d.departTick).toBe(w.tick + 3 * TICK_RATE);
    const scores = [a.score, b.score, c.score];
    ev = run(sim, 3 * TICK_RATE - 1);
    expect(d.floor).toBe(1);
    ev = run(sim, 1);
    expect(ofType(ev, 'floorStart')).toEqual([{ t: 'floorStart', floor: 2 }]);
    expect([a.score - scores[0], b.score - scores[1], c.score - scores[2]]).toEqual([50, 50, 50]);
  });

  it('a human already in the Descend zone when it opens starts nothing until it re-enters, or RIFT_PORTAL_HOLD_SEC passes (integrator fix)', () => {
    for (const leave of [true, false]) {
      const { sim, w, d, ships: [a] } = rig({}, [{}]);
      const L = w.map.dungeon!;
      const key = L.rooms[L.keyRoom];
      sealWith(sim, a, key);
      put(a, L.portalX + 40, L.portalY); // the fight ends on top of the portal
      hooks.done.add(key.idx);
      let ev = run(sim, 1);
      expect(d.portal).toBe(1);
      ev = run(sim, 2 * TICK_RATE);
      expect([d.portal, ofType(ev, 'departing')]).toEqual([1, []]);
      if (leave) {
        put(a, key.doors[0].inX, key.doors[0].inY);
        run(sim, 1);
        put(a, L.portalX, L.portalY);
        ev = run(sim, 1);
        expect(ofType(ev, 'departing')).toEqual([{ t: 'departing', sec: 3, team: 0 }]);
      } else {
        ev = run(sim, RIFT_PORTAL_HOLD_SEC * TICK_RATE - 2 * TICK_RATE - 1);
        expect(ofType(ev, 'departing')).toEqual([]);
        ev = run(sim, 1);
        expect(ofType(ev, 'departing')).toEqual([{ t: 'departing', sec: 3, team: 0 }]);
      }
    }
  });

  it('a bots-only party (every human out of lives) descends on its own, fast, and the waiting humans come back', () => {
    const { sim, w, d, ships: [a, b, c] } = rig({}, [{}, {}, { bot: true }]);
    d.parties[0].lives = 0;
    kill(w, a); kill(w, b);
    expect(d.outcome).toBe('running'); // the bot still flies
    d.portal = 1;
    put(c, w.map.dungeon!.portalX, w.map.dungeon!.portalY);
    let ev = run(sim, 1);
    expect(ofType(ev, 'departing')).toEqual([{ t: 'departing', sec: 3, team: 0 }]);
    ev = run(sim, 3 * TICK_RATE);
    expect(ofType(ev, 'floorStart')).toEqual([{ t: 'floorStart', floor: 2 }]);
    for (const s of [a, b, c]) { expect(s.alive).toBe(true); expect(s.skillState.rWait).toBeUndefined(); }
  });

  it('the floor swap keeps ship ids, XP, level, upgrades, path and carried caches, clears entities and loot, revives waiting pilots, emits floorStart, keeps the grid', () => {
    const { sim, w, d, ships: [a, b, c, e] } = rig({}, [{}, { cls: 'tech' }, { cls: 'engineer', bot: true }, {}]);
    const old = w.map;
    const gridDims = [w.grid.cols, w.grid.rows, w.grid.cell, w.grid.ships.length];
    const A = firstArena(w);
    // progression + hold on a
    a.xp = 37; a.level = 7; a.upgrades['path:ram'] = 1; a.upgrades.bru_gun = 2; a.path = 'ram';
    a.carried = [tok(3, 'keyChest'), tok(0)];
    a.kills = 4; a.score = 321;
    // b is out of lives; e extracted on this floor
    d.parties[0].lives = 0;
    kill(w, b);
    expect(b.skillState.rWait).toBe(1);
    e.alive = false; e.respawnTick = Number.MAX_SAFE_INTEGER; e.skillState.rOut = 1;
    // a sealed room, and entities of every kind
    sealWith(sim, a, A);
    expect(w.map.rev).toBeGreaterThan(0);
    spawnEnemy(w, 'drone', A.x, A.y + 200);
    dropGems(w, A.x, A.y, 40);
    spawnProjectile(w, { ...projectileDefaults(w), kind: 'bullet', ownerId: a.id, ownerPlayerId: 1, ownerTeam: 0, x: A.x, y: A.y, vx: 0, vy: 0, damage: 5, radius: 3, expireTick: w.tick + 600 });
    spawnDeployable(w, { kind: 'sentry', ownerId: c.id, ownerPlayerId: 3, team: 0, x: A.x, y: A.y, vx: 0, vy: 0, angle: 0, hp: 100, maxHp: 100, radius: 14, length: 0, spawnTick: w.tick, expireTick: w.tick + 6000, power: 1, mem: {} });
    rollLoot(w, 'keyChest', A.x, A.y - 300, { priorityPid: 1 });
    side(w).ramHits.set(a.id, new Set([123]));
    expect([w.enemies.size, w.gems.size, w.projectiles.size, w.deployables.size, w.loot!.size].every((n) => n > 0)).toBe(true);
    const ids = [...w.ships.keys()];
    const keep = (s: Ship) => JSON.stringify([s.id, s.playerId, s.xp, s.level, s.upgrades, s.path, s.carried ?? [], s.kills, s.score, s.shipClass]);
    const kept = [a, b, c, e].map(keep);
    const rev = w.map.rev!;
    const ev = toFloor(sim, 2);
    expect(w.map).not.toBe(old);
    expect([w.map.dungeon!.floor, d.floor, w.pve.wave]).toEqual([2, 2, 3]);
    expect([w.map.cols, w.map.rows, w.map.tileSize, w.map.width, w.map.height]).toEqual([old.cols, old.rows, old.tileSize, old.width, old.height]);
    expect([w.grid.cols, w.grid.rows, w.grid.cell, w.grid.ships.length]).toEqual(gridDims);
    expect(w.map.rev).toBe(rev + 1);
    expect([...w.ships.keys()]).toEqual(ids);
    expect([a, b, c, e].map(keep)).toEqual(kept);
    expect([w.enemies.size, w.gems.size, w.projectiles.size, w.deployables.size, w.loot!.size]).toEqual([0, 0, 0, 0, 0]);
    expect(side(w).ramHits.size).toBe(0);
    // every non-extracted ship is up at the new entrance, protected for 3 s; the waiting pilot is back
    const ent = w.map.dungeon!.rooms[w.map.dungeon!.entrances[0]];
    for (const s of [a, b, c]) {
      expect(s.alive).toBe(true);
      expect(roomAt(w.map, s.x, s.y)).toBe(ent.idx);
      expect(s.invulnUntilTick).toBe(w.tick + 3 * TICK_RATE);
      expect(s.attachedTo).toBe(0);
    }
    expect(b.skillState.rWait).toBeUndefined();
    expect([e.alive, e.skillState.rOut]).toEqual([false, 1]);
    // fresh floor state; lives, counters and extracted carry over
    expect(d.rooms.map((r) => r.state)).toEqual(w.map.dungeon!.rooms.map((r) => (r.kind === 'entrance' ? RIFT_CLEARED : RIFT_DORMANT)));
    expect([d.portal, d.extractOpen, d.victoryTick, d.pendingFloor, d.instabilityTick, d.floorStartTick]).toEqual([0, false, 0, 0, 0, w.tick]);
    expect(d.parties[0]).toMatchObject({ lives: 0, anchorX: ent.x, anchorY: ent.y, seen: 1 << ent.idx, deepestFloor: 2, roomsCleared: 0 });
    // events: floorStart last, after the respawns; PVE got its floor init
    expect(ev[ev.length - 1]).toEqual({ t: 'floorStart', floor: 2 });
    expect(ofType(ev, 'shipSpawn').map((x) => x.playerId).sort()).toEqual([1, 2, 3]);
    expect(hooks.floorInits).toBe(1);
    // and the new floor plays: its first arena seals
    const A2 = firstArena(w);
    run(sim, 3 * TICK_RATE);
    sealWith(sim, a, A2);
    expect(d.rooms[A2.idx].state).toBe(RIFT_SEALED);
  });
});

describe('run end (§4.7)', () => {
  it('final boss: Extract ("Exit") only, the run is cleared after the 45 s victory lap', () => {
    const { sim, w, d, ships: [a, b] } = rig({ floors: 3 });
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    const boss = L.rooms[L.keyRoom];
    sealWith(sim, a, boss);
    hooks.done.add(boss.idx);
    let ev = run(sim, 1);
    expect([d.portal, d.extractOpen, d.victoryTick]).toEqual([0, true, w.tick + RIFT_VICTORY_SEC * TICK_RATE]);
    expect(ofType(ev, 'portalOpen')).toEqual([{ t: 'portalOpen', x: L.extractX, y: L.extractY, extract: true }]);
    expect(buildRiftView(w).departIn).toBe(45);
    put(a, boss.doors[0].inX, boss.doors[0].inY); put(b, boss.doors[0].inX, boss.doors[0].inY + 40);
    ev = run(sim, RIFT_VICTORY_SEC * TICK_RATE - 1);
    expect(d.outcome).toBe('running');
    ev = run(sim, 1);
    expect(d.outcome).toBe('cleared');
    expect(ofType(ev, 'riftEnd')).toEqual([{ t: 'riftEnd', outcome: 'cleared' }]);
    expect([w.match.phase, w.match.winnerTeam, w.match.winnerPlayerId]).toEqual(['ended', 0, 0]);
    expect(ofType(ev, 'matchEnd')).toHaveLength(1);
  });

  it('final boss: every human extracting ends the run as cleared at once', () => {
    const { sim, w, d, ships: [a] } = rig({ floors: 3 }, [{}, { bot: true }]);
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    sealWith(sim, a, L.rooms[L.keyRoom]);
    hooks.done.add(L.keyRoom);
    run(sim, 1);
    put(a, L.extractX, L.extractY);
    run(sim, RIFT_EXTRACT_TICKS);
    expect(d.outcome).toBe('cleared');
    expect(w.match.phase).toBe('ended');
  });

  it('the last human extracting while a bot waits out of lives ends the run extracted, not wiped (integrator fix)', () => {
    const { sim, w, d, ships: [a, bot] } = rig({}, [{}, { bot: true }]);
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    const boss = L.rooms[L.keyRoom];
    sealWith(sim, a, boss);
    d.parties[0].lives = 0;
    kill(w, bot);
    expect(bot.skillState.rWait).toBe(1);
    put(a, boss.doors[0].inX, boss.doors[0].inY);
    hooks.done.add(boss.idx);
    run(sim, 1);
    expect([d.parties[0].lives, d.extractOpen, d.outcome]).toEqual([2, true, 'running']); // the boss refilled the pool
    put(a, L.extractX, L.extractY);
    const ev = run(sim, RIFT_EXTRACT_TICKS);
    expect(ofType(ev, 'partyWiped')).toEqual([]);
    expect(ofType(ev, 'riftEnd')).toEqual([{ t: 'riftEnd', outcome: 'extracted' }]);
    expect([d.outcome, d.parties[0].status, w.match.winnerTeam]).toEqual(['extracted', 'done', 0]);
  });

  it('final floor: Exit while a teammate waits out of lives ends the run cleared, not wiped (integrator fix)', () => {
    const { sim, w, d, ships: [a, b] } = rig({ floors: 3 });
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    const boss = L.rooms[L.keyRoom];
    sealWith(sim, a, boss);
    d.parties[0].lives = 0;
    kill(w, b);
    expect(b.skillState.rWait).toBe(1);
    hooks.done.add(boss.idx);
    run(sim, 1);
    expect(d.victoryTick).toBeGreaterThan(w.tick);
    put(a, L.extractX, L.extractY);
    const ev = run(sim, RIFT_EXTRACT_TICKS);
    expect(ofType(ev, 'partyWiped')).toEqual([]);
    expect(ofType(ev, 'riftEnd')).toEqual([{ t: 'riftEnd', outcome: 'cleared' }]);
    expect([w.match.phase, w.match.winnerTeam]).toEqual(['ended', 0]);
  });

  it('after the final boss nobody can wipe: the last member left going down ends the run cleared', () => {
    const { sim, w, d, ships: [a] } = rig({ floors: 3 }, [{}]);
    toFloor(sim, 3);
    const L = w.map.dungeon!;
    sealWith(sim, a, L.rooms[L.keyRoom]);
    hooks.done.add(L.keyRoom);
    run(sim, 1);
    d.parties[0].lives = 0;
    kill(w, a);
    expect(d.outcome).toBe('cleared');
  });

  it('abandonRift: outcome abandoned, riftEnd, the match ends with no winner; only once', () => {
    const { sim, w, d } = rig();
    sim.abandonRift();
    expect(d.outcome).toBe('abandoned');
    expect(ofType(sim.drainEvents(), 'riftEnd')).toEqual([{ t: 'riftEnd', outcome: 'abandoned' }]);
    sim.abandonRift();
    expect(ofType(sim.drainEvents(), 'riftEnd')).toEqual([]);
    const ev = run(sim, 1);
    expect([w.match.phase, w.match.winnerTeam]).toEqual(['ended', -1]);
    expect(ofType(ev, 'matchEnd')).toHaveLength(1);
  });
});

describe('views + combat hook', () => {
  it('buildRiftView / riftYou mirror the run', () => {
    const { sim, w, d, ships: [a, b] } = rig();
    const A = firstArena(w);
    sealWith(sim, a, A);
    const v = buildRiftView(w);
    expect(v).toMatchObject({
      floor: 1, floorsTotal: 6, biome: 'hive', lives: [6], portal: 0, departIn: 0, extractOpen: false, boss: null,
      waiting: [], extracting: [],
    });
    expect(v.rooms).toEqual(d.rooms.map((r) => r.state));
    expect(v.rooms[A.idx]).toBe(RIFT_SEALED);
    expect(v.chests).toEqual(d.rooms.map(() => 0));
    expect(v.seen[0] & (1 << A.idx)).toBeTruthy();
    expect(v.anchors).toEqual([Math.round(d.parties[0].anchorX), Math.round(d.parties[0].anchorY)]);
    expect(v.floorSec).toBe(Math.floor((w.tick - d.floorStartTick) / TICK_RATE));
    const boss = spawnEnemy(w, 'hive', A.x, A.y)!;
    d.bossId = boss.id; d.bossPhase = 2;
    boss.hp = boss.maxHp / 4;
    expect(buildRiftView(w).boss).toEqual({ id: boss.id, kind: 'hive', hpFrac: 0.25, phase: 2 });
    expect(riftYou(w, b)).toEqual({ party: 0, lives: 6, waiting: false, extracted: false, extract: 0, followId: 0 });
    expect(JSON.parse(JSON.stringify(v))).toEqual(v); // plain JSON (the snapshot tail)
  });

  it('damageEnemy multiplies by enemy.mem.dmgTaken when set (0 = no damage, no hit event)', () => {
    const { w } = rig({}, [{}]);
    const e = spawnEnemy(w, 'brute', 3000, 3000)!;
    const hp = e.hp;
    e.mem.dmgTaken = 0;
    w.events.length = 0;
    damageEnemy(w, e, 100, 0);
    expect(e.hp).toBe(hp);
    expect(w.events).toEqual([]);
    e.mem.dmgTaken = 0.5;
    damageEnemy(w, e, 100, 0);
    expect(e.hp).toBe(hp - 50);
    delete e.mem.dmgTaken;
    damageEnemy(w, e, 100, 0);
    expect(e.hp).toBe(hp - 150);
  });
});
