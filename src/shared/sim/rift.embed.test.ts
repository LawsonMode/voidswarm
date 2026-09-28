// SIM + PVE v0.3 M4 (integrator fix): bodies shoved into rift rock never march off the map.
// A rift floor is solid rock outside its rooms. An enemy's contact push-out used to move a pinned ship with no wall
// check, and collideCircle's "centre inside a tile" branch then chained pushes across the solid mass every tick
// (+64 / +32 px per tick, off the map, soft-locking the run). Now PVE resolves the push against walls in a rift, and
// collideCircle rescues a deep embed to the nearest open tile once.
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../constants';
import type { GameMap, SimConfig } from '../types';
import { TILE_EMPTY, TILE_ROCK } from '../types';
import { collideCircle, isSolidAt } from './map';
import { spawnEnemy } from './pve/enemies';
import { Sim } from './Sim';

function rockMap(): GameMap {
  const cols = 60, ts = 32;
  const tiles = new Uint8Array(cols * cols).fill(TILE_ROCK);
  for (let r = 20; r < 40; r++) for (let c = 20; c < 40; c++) tiles[r * cols + c] = TILE_EMPTY;
  return { seed: 1, teamCount: 1, width: cols * ts, height: cols * ts, tileSize: ts, cols, rows: cols, tiles, spawns: [], rev: 0 };
}

describe('deep embeds (collideCircle)', () => {
  it('a body whose centre sits deep in solid rock is rescued to open ground once, then stays put', () => {
    const m = rockMap();
    let x = 15.5 * 32, y = 30.5 * 32; // 5 tiles into the rock west of the room
    const c = collideCircle(m, x, y, 22);
    expect(c.hit).toBe(true);
    expect(isSolidAt(m, c.x, c.y)).toBe(false);
    ({ x, y } = c);
    for (let i = 0; i < 120; i++) {
      const n = collideCircle(m, x, y, 22);
      expect(isSolidAt(m, n.x, n.y)).toBe(false);
      x = n.x; y = n.y;
    }
    expect(x).toBeGreaterThanOrEqual(20 * 32);
    expect(x).toBeLessThanOrEqual(40 * 32);
  });

  it('a body just touching a wall face is resolved as before (no rescue)', () => {
    const m = rockMap();
    const c = collideCircle(m, 20 * 32 + 10, 30.5 * 32, 22);
    expect([c.hit, c.x]).toEqual([true, 20 * 32 + 22]);
    expect(c.nx).toBeGreaterThan(0.8);
  });

  it('far off the map with nothing open near, the body is clamped back inside the map', () => {
    const m = rockMap();
    const c = collideCircle(m, -5000, 1e6, 22);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeLessThanOrEqual(m.height);
  });
});

describe('rift contact push-out', () => {
  it('a ship pinned in a room corner by a brute never ends a tick inside the rock', () => {
    const cfg: SimConfig = {
      mapSeed: 2, mode: 'teams', teamCount: 1, pveIntensity: 2, matchSeconds: 0, scoreLimit: 0, friendlyFire: false,
      gameType: 'dungeon', subMode: 'coop', floors: 3, lootMult: 0, lootSeed: 1,
    };
    const sim = new Sim(cfg);
    const w = sim.world;
    const s = w.ships.get(sim.addPlayer({ playerId: 1, name: 'p', team: 0, shipClass: 'brute', isBot: false }))!;
    sim.step();
    const L = w.map.dungeon!;
    const hall = L.rooms.find((r) => r.kind === 'hall')!;
    const ts = w.map.tileSize;
    const cx = hall.c0 * ts + s.stats.radius + 1, cy = hall.r0 * ts + s.stats.radius + 1; // the room's NW corner
    s.x = cx; s.y = cy; s.vx = 0; s.vy = 0;
    let worst = 0;
    for (let i = 0; i < 5 * TICK_RATE; i++) {
      s.invulnUntilTick = w.tick + TICK_RATE;
      s.energy = s.stats.maxEnergy;
      for (const e of [...w.enemies.values()]) w.enemies.delete(e.id);
      // a brute right on top of the ship, on its room side: the push-out points into the corner walls
      const b = spawnEnemy(w, 'brute', s.x + 6, s.y + 6)!;
      b.mem.cr = 0;
      sim.step();
      sim.drainEvents();
      expect(isSolidAt(w.map, s.x, s.y)).toBe(false);
      worst = Math.max(worst, Math.hypot(s.x - cx, s.y - cy));
    }
    expect(s.x).toBeGreaterThanOrEqual(hall.c0 * ts);
    expect(s.y).toBeGreaterThanOrEqual(hall.r0 * ts);
    expect(worst).toBeLessThan(400);
  });
});
