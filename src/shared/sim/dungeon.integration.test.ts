// SIM v0.3 M4 integration: the rift state machine on the REAL PVE (pve/rift.ts pulses, dormant packs, encounter
// hooks) and the real floor generator, no mocks. A scripted, invulnerable party walks the main path room by room and
// "shoots" (damageEnemy) every enemy near it, so the SIM ↔ PVE seam (riftEncounterStart / Done / Reset, riftFloorInit,
// the tier in world.pve.wave) is exercised end to end: seal → real pulses → clear → chest → key → Descend → floor 2.
// Bot play is the AI gate (ai/riftParity.test.ts); this file only needs the sim to be self-consistent.
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../constants';
import type { GameEvent, RiftRoom, Ship, SimConfig, World } from '../types';
import { RIFT_CLEARED, RIFT_SEALED, TILE_WALL } from '../types';
import { damageEnemy } from './combat';
import { buildRiftView } from './dungeon';
import { roomAt } from './floorgen';
import { Sim } from './Sim';

const cfg = (seed: number): SimConfig => ({
  mapSeed: seed, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
  gameType: 'dungeon', subMode: 'coop', floors: 6, lootMult: 1, lootSeed: 0xc0ffee,
});

interface Trace { events: GameEvent[]; lines: string[]; sim: Sim }

/** Kill every enemy within `r` of any party ship (the party's guns), after god-moding the party. */
function fire(w: World, ships: Ship[], r: number): void {
  for (const s of ships) s.invulnUntilTick = w.tick + 10 * TICK_RATE;
  for (const e of [...w.enemies.values()]) {
    for (const s of ships) {
      if (s.alive && Math.hypot(e.x - s.x, e.y - s.y) <= r) { damageEnemy(w, e, 1e9, s.id); break; }
    }
  }
}

/** A scripted party of two clears floor 1 of `seed` room by room, then descends. */
function clearFloor1(seed: number): Trace {
  const sim = new Sim(cfg(seed));
  const w = sim.world;
  const ships = [1, 2].map((pid) => w.ships.get(sim.addPlayer({ playerId: pid, name: 'p' + pid, team: 0, shipClass: pid === 1 ? 'brute' : 'tech', isBot: false }))!);
  const events: GameEvent[] = [];
  const lines: string[] = [];
  const step = (): void => {
    fire(w, ships, 700);
    sim.step();
    for (const e of sim.drainEvents()) {
      events.push(e);
      if (e.t.startsWith('room') || e.t === 'portalOpen' || e.t === 'departing' || e.t === 'floorStart' || e.t === 'chestOpen') {
        lines.push(`${w.tick}:${JSON.stringify(e)}`);
      }
    }
  };
  const L = w.map.dungeon!;
  const d = w.dungeon!;
  const goTo = (room: RiftRoom, x = room.x, y = room.y): void => {
    for (const [i, s] of ships.entries()) { s.x = x + i * 30; s.y = y; s.vx = 0; s.vy = 0; }
  };
  const limit = w.tick + 8 * 60 * TICK_RATE;
  for (const room of L.rooms.filter((r) => r.mainPath && r.kind !== 'entrance')) {
    goTo(room);
    while (d.rooms[room.idx].state !== RIFT_CLEARED && w.tick < limit && d.outcome === 'running') {
      step();
      if (d.rooms[room.idx].state === RIFT_SEALED) {
        // sealed: the door tiles are walls and both pilots are inside (recall)
        for (const dr of room.doors) for (const t of dr.tiles) expect(w.map.tiles[t]).toBe(TILE_WALL);
        for (const s of ships) expect(roomAt(w.map, s.x, s.y)).toBe(room.idx);
      }
    }
    expect(d.rooms[room.idx].state, `room ${room.idx} (${room.kind}) cleared`).toBe(RIFT_CLEARED);
    for (let k = 0; k < room.chests.length; k += 2) {
      goTo(room, room.chests[k], room.chests[k + 1]);
      step();
    }
    goTo(room); // off the chests
    for (let i = 0; i < 5; i++) step();
  }
  for (const t of L.rooms.filter((r) => r.kind === 'treasure')) {
    for (let k = 0; k < t.chests.length; k += 2) { goTo(t, t.chests[k], t.chests[k + 1]); step(); }
  }
  expect(d.portal).toBeGreaterThanOrEqual(1);
  const key = L.rooms[L.keyRoom];
  goTo(key, L.portalX, L.portalY);
  while (d.floor === 1 && w.tick < limit) step();
  return { events, lines, sim };
}

describe('rift floor 1 on the real PVE (scripted party)', () => {
  it('seal → real pulses → clear → chests → key → Descend → floor 2, with no regroup reset', () => {
    const { events, sim } = clearFloor1(1234);
    const w = sim.world, d = w.dungeon!;
    const count = (t: GameEvent['t']) => events.filter((e) => e.t === t).length;
    expect(d.floor).toBe(2);
    expect(d.outcome).toBe('running');
    expect(count('roomSeal')).toBe(2 * 3); // arming + sealed, for 2 arenas and the key room
    expect(count('roomClear')).toBe(3);
    expect(count('roomReset')).toBe(0);
    expect(count('spawnWarn')).toBeGreaterThan(0); // PVE's pulses really fired
    expect(count('enemyDeath')).toBeGreaterThan(20);
    expect(count('chestOpen')).toBe(2 + 1 + 2); // 2 arena reward chests + the key chest + the treasure room's 2
    expect(count('portalOpen')).toBe(1);
    expect(count('departing')).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.t === 'floorStart')).toEqual([{ t: 'floorStart', floor: 2 }]);
    expect(d.parties[0].roomsCleared).toBe(3);
    // floor 2 is a fresh, playable floor with its tier and its dormant packs (placed by PVE's riftFloorInit)
    expect(w.map.dungeon!.floor).toBe(2);
    expect(w.pve.wave).toBe(3);
    for (let i = 0; i < 3; i++) sim.step();
    expect(w.enemies.size).toBeGreaterThan(0);
    const v = buildRiftView(w);
    expect([v.floor, v.portal, v.extractOpen]).toEqual([2, 0, false]);
  }, 120_000);

  it('is deterministic: the same seed replays the same rift', () => {
    const a = clearFloor1(77), b = clearFloor1(77);
    expect(b.lines).toEqual(a.lines);
    expect(b.sim.world.tick).toBe(a.sim.world.tick);
    expect(b.sim.world.dungeon!.floor).toBe(2);
  }, 120_000);
});
