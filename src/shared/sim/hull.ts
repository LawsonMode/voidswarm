// OWNER: SIM agent. v0.5 hull geometry: capital hosts and bubble turrets (ARCHITECTURE.md "Hardpoints + capital
// ships (v0.5)").
//   - A free ship hosting n ≥ 1 docked turrets is its class's capital variant: stats.radius = base × capitalScale(n)
//     and stats.armor = min(0.6, base + CAPITAL_ARMOR_PER_TURRET × n). Every hit test, splash, pickup and wall test
//     reads stats.radius, so the bigger hull is easier to hit everywhere. The speed penalty stays in Sim pass 1.
//   - A docked turret is a bubble dome: stats.radius = TURRET_BUBBLE_RADIUS while attached.
// The base radius / armor are cached per stats OBJECT, so the change is exactly reversible. A stats rebuild
// (computeStats: upgrade pick, class swap) is a new object, and its radius / armor become the new base; a plain
// copy of the adjusted object ({ ...ship.stats, … }: same radius and armor as applied) keeps the cached base.
// Deterministic (no rng), and a ship that never hosts nor docks is never touched, so a no-turret match runs as v0.4.
// No imports from objectives/ or turrets.ts: objectives/ctf.ts calls this too (see its shakeOff note).
import { CAPITAL_ARMOR_PER_TURRET, MAX_HARDPOINTS, TURRET_BUBBLE_RADIUS } from '../constants';
import type { Ship, ShipStats, World } from '../types';
import { collideCircle } from './map';
import { capitalScale, turretOffset } from './world';

/** Armor cap applied by damageShip (and computeStats). */
const ARMOR_CAP = 0.6;

interface Hull {
  /** The stats object whose radius / armor this entry adjusted. */
  stats: ShipStats;
  baseRadius: number;
  baseArmor: number;
  /** Turrets counted by the applied capital form (0 = plain hull). */
  n: number;
  /** Bubble radius applied (ship docked as a turret). */
  bubble: boolean;
  /** The radius / armor this entry last wrote (to tell a copy of the adjusted stats from a rebuild). */
  radius: number;
  armor: number;
}

const hulls = new WeakMap<Ship, Hull>();

/** Docked turrets that count for the capital form (≤ MAX_HARDPOINTS). */
export function hostedCount(ship: Ship): number {
  return ship.turrets.length < MAX_HARDPOINTS ? ship.turrets.length : MAX_HARDPOINTS;
}

/** A free ship hosting ≥ 1 turret: its class's capital variant (Space = capital skill). */
export function isCapital(ship: Ship): boolean {
  return ship.attachedTo === 0 && ship.turrets.length > 0;
}

/** The ship's plain-hull radius (its stats radius without the capital / bubble change). */
export function baseRadiusOf(ship: Ship): number {
  const h = hulls.get(ship);
  return h && h.stats === ship.stats ? h.baseRadius : ship.stats.radius;
}

/**
 * Apply the hull for the ship's current role to ship.stats (radius + armor only). Idempotent. Returns the radius
 * change (> 0 = the hull grew), 0 when nothing changed (the radius always changes with the role: capitalScale grows
 * with every hardpoint). No side effects beyond ship.stats.
 */
export function applyHull(ship: Ship): number {
  const st = ship.stats;
  if (!st) return 0;
  const bubble = ship.attachedTo !== 0;
  const n = bubble ? 0 : hostedCount(ship);
  let h = hulls.get(ship);
  if (h && h.stats !== st) {
    const adjusted = h.n > 0 || h.bubble;
    if (adjusted && st.radius === h.radius && st.armor === h.armor) h.stats = st; // a copy: same base
    else h = undefined; // stats were rebuilt: their radius / armor are the new base
  }
  if (!h) {
    if (!bubble && n === 0) return 0; // plain hull and never adjusted: nothing to do (no allocation)
    h = { stats: st, baseRadius: st.radius, baseArmor: st.armor, n: 0, bubble: false, radius: st.radius, armor: st.armor };
    hulls.set(ship, h);
  }
  if (h.n === n && h.bubble === bubble) return 0;
  const before = st.radius;
  h.n = n;
  h.bubble = bubble;
  st.radius = bubble ? TURRET_BUBBLE_RADIUS : h.baseRadius * capitalScale(n);
  st.armor = n > 0 ? Math.min(ARMOR_CAP, Math.max(0, h.baseArmor) + CAPITAL_ARMOR_PER_TURRET * n) : h.baseArmor;
  h.radius = st.radius;
  h.armor = st.armor;
  return st.radius - before;
}

/** Seat a docked turret on its host's hardpoint (host position + turretOffset at the host's effective radius). */
export function seatTurret(world: World, turret: Ship): void {
  const host = world.ships.get(turret.attachedTo);
  if (!host) return;
  const slot = host.turrets.indexOf(turret.id);
  if (slot < 0) return;
  const o = turretOffset(host.angle, slot, host.turrets.length, host.stats.radius);
  turret.x = host.x + o.dx;
  turret.y = host.y + o.dy;
  turret.vx = host.vx;
  turret.vy = host.vy;
}

/** Re-seat every turret docked on `host` (mounts re-flow when a turret joins or leaves). */
export function reseatTurrets(world: World, host: Ship): void {
  for (const id of host.turrets) {
    const t = world.ships.get(id);
    if (t && t.attachedTo === host.id) seatTurret(world, t);
  }
}

/**
 * applyHull plus its world side effects: a free ship whose hull grew is pushed out of walls once (collideCircle);
 * a host whose turret count changed re-seats its turrets on the new layout at once (same tick).
 * Call after anything that changes ship.turrets / ship.attachedTo; Sim.step also runs it for every ship each tick.
 */
export function syncHull(world: World, ship: Ship): void {
  const delta = applyHull(ship);
  if (delta === 0) return;
  if (delta > 0 && ship.attachedTo === 0 && ship.alive) {
    const c = collideCircle(world.map, ship.x, ship.y, ship.stats.radius);
    if (c.hit) { ship.x = c.x; ship.y = c.y; }
  }
  if (ship.turrets.length) reseatTurrets(world, ship);
}
