// Pure helpers used by GameClient/InputManager (unit-tested).
import { HOST_SPEED_PENALTY_PER_TURRET, LASER_RESONANCE, TURRET_HOST_FLOOR_FRAC } from '../../shared/constants';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { CTF_CARRIER_MAX_TURRETS } from '../../shared/sim/objectives/rules';
import { turretOffset } from '../../shared/sim/world';
import { BEAM_LASER, SHIPFLAG_CARRIER, type EntityId, type GameMode, type ShipView, type TeamId } from '../../shared/types';

export const ATTACH_PICK_RADIUS = 140;

/**
 * An allied, alive, non-turret ship nearest the aim point within ATTACH_PICK_RADIUS, else 0. v0.3 M3 (CTF): a flag
 * carrier can't attach, and a carrier host keeps only its gunner seat (CTF_CARRIER_MAX_TURRETS), so neither is
 * highlighted when the server would refuse it.
 */
export function pickAttachCandidate(
  ships: readonly ShipView[], localShipId: EntityId, localTeam: TeamId, mode: GameMode | null,
  aimX: number, aimY: number,
): EntityId {
  if (mode !== 'teams' || localTeam < 0 || !localShipId) return 0;
  const self = ships.find((s) => s.id === localShipId);
  if (self && (self.flags & SHIPFLAG_CARRIER) !== 0) return 0;
  let best: EntityId = 0;
  let bestD = ATTACH_PICK_RADIUS * ATTACH_PICK_RADIUS;
  for (const s of ships) {
    if (s.id === localShipId || !s.alive || s.attachedTo !== 0 || s.team !== localTeam) continue;
    if ((s.flags & SHIPFLAG_CARRIER) !== 0 && s.turretCount >= CTF_CARRIER_MAX_TURRETS) continue;
    const dx = s.x - aimX, dy = s.y - aimY, d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = s.id; }
  }
  return best;
}

/** turretOffset() puts turrets at hostRadius + this (derived, so it follows world.ts). */
const TURRET_RING_PAD = (() => { const o = turretOffset(0, 0, 1, 0); return Math.sqrt(o.dx * o.dx + o.dy * o.dy); })();

/**
 * Effective radius of every host that has a turret, read off the server's own turret placement
 * (turret = host + turretOffset(angle, slot, n, host.stats.radius), so |turret − host| − pad = radius).
 * This picks up radius talents (e.g. Bulwark's Titan) that ShipView doesn't carry. Use RAW snapshot
 * ships (both positions from the same tick), not interpolated ones.
 */
export function hostRadii(ships: readonly ShipView[]): Map<EntityId, number> {
  const byId = new Map<EntityId, ShipView>();
  for (const s of ships) byId.set(s.id, s);
  const out = new Map<EntityId, number>();
  for (const t of ships) {
    if (!t.attachedTo || !t.alive || out.has(t.attachedTo)) continue;
    const host = byId.get(t.attachedTo);
    if (!host) continue;
    const base = SHIP_CLASSES[host.shipClass]?.base.radius ?? 16;
    const r = Math.hypot(t.x - host.x, t.y - host.y) - TURRET_RING_PAD;
    if (r >= base * 0.7 && r <= base * 2) out.set(host.id, r); // otherwise a knock moved one of them: ignore
  }
  return out;
}

/** Host speed multiplier from its attached turrets. */
export function hostSpeedMult(turretCount: number): number {
  return Math.max(0.5, 1 - HOST_SPEED_PENALTY_PER_TURRET * turretCount);
}

/** Laser Lance turrets currently firing on `hostId`, and the resulting per-laser multiplier. */
export function laserResonance(ships: readonly ShipView[], hostId: EntityId): { lasers: number; factor: number } {
  if (!hostId) return { lasers: 0, factor: 1 };
  let n = 0;
  for (const s of ships) {
    if (s.attachedTo === hostId && s.alive && s.shipClass === 'tech' && s.beamKind === BEAM_LASER) n++;
  }
  return { lasers: n, factor: n > 0 ? Math.pow(LASER_RESONANCE, n - 1) : 1 };
}

/** Estimated HOST energy/s drawn by lasers firing on it (flak/seeker bursts aren't visible per tick). */
export function hostLaserDraw(ships: readonly ShipView[], hostId: EntityId): number {
  const { lasers, factor } = laserResonance(ships, hostId);
  const perLaser = SHIP_CLASSES.tech.base.skill.laserHostCostPerSec ?? 0;
  return lasers * perLaser * factor;
}

export type HostEnergyState = 'ok' | 'warn' | 'offline';

/** Turret offense stops below TURRET_HOST_FLOOR_FRAC; warn within 10 points of it. */
export function hostEnergyState(frac: number): HostEnergyState {
  if (frac <= TURRET_HOST_FLOOR_FRAC) return 'offline';
  if (frac < TURRET_HOST_FLOOR_FRAC + 0.1) return 'warn';
  return 'ok';
}
