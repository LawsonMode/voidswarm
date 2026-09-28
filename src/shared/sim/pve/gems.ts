// OWNER: PVE agent. XP gem physics, magnetism, collection (with turret-stack bonus), expiry.
import type { Ship, World } from '../../types';
import { isSolidAt } from '../map';
import { emit } from '../world';
import { queryShips } from './query';
import { grantXp } from './xp';

/** Upper bound for magnet search (largest plausible magnetRadius). */
const MAX_MAGNET_SEARCH = 700;
const STACK_BONUS = 0.5;
const shipBuf: Ship[] = [];

function findMagnet(world: World, x: number, y: number): Ship | null {
  queryShips(world, x, y, MAX_MAGNET_SEARCH, shipBuf);
  let best: Ship | null = null, bestD = Infinity;
  for (let i = 0; i < shipBuf.length; i++) {
    const s = shipBuf[i];
    const dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
    const mr = s.stats.magnetRadius;
    if (d <= mr * mr && d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function collect(world: World, ship: Ship, value: number): void {
  grantXp(world, ship, value);
  if (ship.turrets.length > 0) {
    for (const tid of ship.turrets) {
      const t = world.ships.get(tid);
      if (t && t.alive) grantXp(world, t, value * STACK_BONUS);
    }
  } else if (ship.attachedTo) {
    const h = world.ships.get(ship.attachedTo);
    if (h && h.alive) grantXp(world, h, value * STACK_BONUS);
  }
  emit(world, { t: 'gem', x: ship.x, y: ship.y, playerId: ship.playerId, value });
}

export function stepGems(world: World, dt: number): void {
  const tick = world.tick;
  const friction = Math.pow(0.08, dt);
  const map = world.map;
  for (const g of world.gems.values()) {
    if (tick >= g.expireTick) { world.gems.delete(g.id); continue; }
    let ship = g.magnetTo ? world.ships.get(g.magnetTo) : undefined;
    if (ship && !ship.alive) ship = undefined;
    if (ship) {
      const dx = ship.x - g.x, dy = ship.y - g.y;
      const mr = ship.stats.magnetRadius * 1.6;
      if (dx * dx + dy * dy > mr * mr) ship = undefined;
    }
    if (!ship && (tick + g.id) % 4 === 0) ship = findMagnet(world, g.x, g.y) ?? undefined;
    g.magnetTo = ship ? ship.id : 0;

    if (ship) {
      const dx = ship.x - g.x, dy = ship.y - g.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const reach = ship.stats.radius + 10;
      if (d <= reach) { world.gems.delete(g.id); collect(world, ship, g.value); continue; }
      const shipSpeed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
      const want = Math.max(520, shipSpeed + 350);
      const k = Math.min(1, 9 * dt);
      g.vx += ((dx / d) * want - g.vx) * k;
      g.vy += ((dy / d) * want - g.vy) * k;
      // don't overshoot the ship this tick
      const step = Math.sqrt(g.vx * g.vx + g.vy * g.vy) * dt;
      if (step >= d) { world.gems.delete(g.id); collect(world, ship, g.value); continue; }
      g.x += g.vx * dt; g.y += g.vy * dt;
    } else {
      g.vx *= friction; g.vy *= friction;
      if (g.vx * g.vx + g.vy * g.vy < 1) { g.vx = 0; g.vy = 0; continue; }
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
      if (isSolidAt(map, nx, ny)) { g.vx = 0; g.vy = 0; } else { g.x = nx; g.y = ny; }
    }
  }
}
