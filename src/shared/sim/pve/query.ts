// OWNER: PVE agent. Allocation-free grid queries (the world.ts helpers take closures).
import type { Enemy, Ship, World } from '../../types';

/** Largest ship radius headroom for the grid scan (v0.5 capital hulls reach ~40 px: brute 22 × Titan 1.15 × 1.55). */
const SHIP_REACH_PAD = 48;

/** Fill `out` with alive ships whose bodies intersect circle (x,y,r). Returns count. */
export function queryShips(world: World, x: number, y: number, r: number, out: Ship[]): number {
  out.length = 0;
  const g = world.grid;
  const reach = r + SHIP_REACH_PAD;
  const x0 = Math.max(0, Math.floor((x - reach) / g.cell)), x1 = Math.min(g.cols - 1, Math.floor((x + reach) / g.cell));
  const y0 = Math.max(0, Math.floor((y - reach) / g.cell)), y1 = Math.min(g.rows - 1, Math.floor((y + reach) / g.cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const cell = g.ships[cy * g.cols + cx];
      for (let i = 0; i < cell.length; i++) {
        const s = world.ships.get(cell[i]);
        if (!s || !s.alive) continue;
        const dx = s.x - x, dy = s.y - y, rr = r + s.stats.radius;
        if (dx * dx + dy * dy <= rr * rr) out.push(s);
      }
    }
  }
  return out.length;
}

/** Fill `out` with enemies whose bodies intersect circle (x,y,r). Returns count. */
export function queryEnemies(world: World, x: number, y: number, r: number, out: Enemy[]): number {
  out.length = 0;
  const g = world.grid;
  const reach = r + 96;
  const x0 = Math.max(0, Math.floor((x - reach) / g.cell)), x1 = Math.min(g.cols - 1, Math.floor((x + reach) / g.cell));
  const y0 = Math.max(0, Math.floor((y - reach) / g.cell)), y1 = Math.min(g.rows - 1, Math.floor((y + reach) / g.cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const cell = g.enemies[cy * g.cols + cx];
      for (let i = 0; i < cell.length; i++) {
        const e = world.enemies.get(cell[i]);
        if (!e) continue;
        const dx = e.x - x, dy = e.y - y, rr = r + e.radius;
        if (dx * dx + dy * dy <= rr * rr) out.push(e);
      }
    }
  }
  return out.length;
}
