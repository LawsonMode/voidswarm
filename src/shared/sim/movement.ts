// OWNER: SIM agent. Frozen signature; used by the server sim AND client-side prediction.
import type { GameMap, InputState, ShipStats } from '../types';
import { angleDiff, wrapAngle } from '../util/math';
import { collideCircle } from './map';

export interface MovementBody {
  x: number; y: number; vx: number; vy: number; angle: number;
}

// Tuning knobs
/** Fraction of velocity lost per second when not thrusting (SubSpace-floaty). */
export const MOVE_DRAG = 1.2;
/** Wall bounce restitution along the normal. */
export const WALL_RESTITUTION = 0.5;
/** Afterburner thrust multiplier. */
export const AFTERBURNER_THRUST_MULT = 1.5;
/** When above max speed (e.g. after afterburner ends) speed bleeds off at this rate, px/s². */
export const OVERSPEED_DECEL = 1200;
/** Move-input magnitude below this counts as "not thrusting". */
export const THRUST_DEADZONE = 0.1;

/** Turn body.angle toward aim, limited by turnRate (rad/s). */
export function turnToward(body: MovementBody, aim: number, turnRate: number, dt: number): void {
  if (!Number.isFinite(aim)) return;
  const d = angleDiff(body.angle, aim);
  const maxT = turnRate * dt;
  body.angle = wrapAngle(body.angle + (d > maxT ? maxT : d < -maxT ? -maxT : d));
}

/**
 * Advance one ship's movement by dt: turn toward input.aim (limited by turnRate), accelerate along
 * (moveX,moveY) (world-relative), apply drag, clamp to maxSpeed (or afterburnerSpeed when
 * `afterburner`), integrate, and collide with walls (bounce with damping, SubSpace-style).
 * `speedMult` scales thrust and max speed (host turret penalty). Pure w.r.t. everything but `body`.
 */
export function stepShipMovement(
  body: MovementBody, input: InputState, stats: ShipStats, map: GameMap, dt: number,
  afterburner: boolean, speedMult: number,
): void {
  turnToward(body, input.aim, stats.turnRate, dt);

  let mx = Number.isFinite(input.moveX) ? input.moveX : 0;
  let my = Number.isFinite(input.moveY) ? input.moveY : 0;
  const m = Math.sqrt(mx * mx + my * my);
  if (m > 1) { mx /= m; my /= m; }

  if (m > THRUST_DEADZONE) {
    const a = stats.thrust * speedMult * (afterburner ? AFTERBURNER_THRUST_MULT : 1);
    body.vx += mx * a * dt;
    body.vy += my * a * dt;
  } else {
    const k = Math.max(0, 1 - MOVE_DRAG * dt);
    body.vx *= k; body.vy *= k;
  }

  const maxS = (afterburner ? stats.afterburnerSpeed : stats.maxSpeed) * speedMult;
  const sp = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
  if (sp > maxS && sp > 0) {
    const target = Math.max(maxS, sp - OVERSPEED_DECEL * dt);
    const f = target / sp;
    body.vx *= f; body.vy *= f;
  }

  body.x += body.vx * dt;
  body.y += body.vy * dt;

  const res = collideCircle(map, body.x, body.y, stats.radius);
  if (res.hit) {
    body.x = res.x; body.y = res.y;
    const vn = body.vx * res.nx + body.vy * res.ny;
    if (vn < 0) {
      body.vx -= (1 + WALL_RESTITUTION) * vn * res.nx;
      body.vy -= (1 + WALL_RESTITUTION) * vn * res.ny;
    }
  }
}
