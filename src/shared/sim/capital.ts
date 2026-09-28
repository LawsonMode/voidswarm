// OWNER: SIM agent. v0.5 capital skills (ARCHITECTURE.md "Hardpoints + capital ships (v0.5)").
// While a ship hosts ≥ 1 turret (hull.ts isCapital) its Space press fires its class's capital skill
// (ShipClassDef.capital.skill) instead of the mobility skill:
//   Broadside (Dreadnought) · Resonance Overcharge (Spire) · Repair Bay (Foundry).
// The capital skill has its own cooldown and cost knobs (stats.skill.capCooldown / capCost, in place of
// mobilityCooldown / mobilityCost) on the Space slot's ready tick, ship.mobilityReadyTick: the Space slot has ONE
// cooldown whichever skill it holds, which is what the wire already carries (YouState.cd.mobility / cdSec.mobility,
// normalized by capCooldown while hosting: room/snapshot.ts spaceCooldownSec) and what bots and client prediction read.
// Overcharge and Repair Bay also set mobilityActiveUntilTick while they run (YouState.skillActive).
// Events (no new ShipView / YouState fields): 'ability' {skill} on use; Broadside also 'fire' {skill: 'broadside'};
// Broadside's slugs leave both flanks' gunports and converge on the aim point (broadsideFocus), so it aims like a shot.
// Overcharge also 'ability' {skill: 'overcharge', talent: OVERCHARGE_END} when it ends (time up, the last turret
// left, death, respawn / class swap), so clients can time the effect; Repair Bay heals emit the batched 'heal' events.
// No rng: every capital effect is deterministic, and none of this runs for a ship that never hosts a turret.
import { SHIP_CLASSES } from '../data/ships';
import type { Ship, SkillDef, SkillId, World } from '../types';
import { healShip } from './combat';
import { isCapital } from './hull';
import { emit, projectileDefaults, sameTeam, secToTicks, spawnProjectile } from './world';

// Tuning knobs
/** Fraction of the host's velocity a broadside slug inherits (as primaries, skills.ts PRIMARY_INHERIT). */
export const BROADSIDE_INHERIT = 0.3;
/** Broadside slug radius px (heavy mass-driver slug). */
export const BROADSIDE_RADIUS = 6;
/** Broadside slug lifetime s (≈ 900 px at the default 1150 px/s). */
export const BROADSIDE_LIFE = 0.8;
/** The gunports of one flank are spread over this many hull radii, stern to bow. */
export const BROADSIDE_HULL_SPAN = 1.2;
/**
 * The volley converges on the aim point (input.aim / input.aimDist), clamped to this range (px) from the hull. The
 * hull turns toward the aim, so slugs fired perpendicular to it could never hit what the pilot points at: instead
 * both flanks' gunports fire across at the aim point (a crossfire), and a pilot aims a Broadside like any shot.
 */
export const BROADSIDE_FOCUS_MIN = 150;
export const BROADSIDE_FOCUS_MAX = 700;
/**
 * Each flank's slugs land spread over this width (px) across the aim line at the focus, stern-end slug on the port
 * side of it. A ship on the aim point takes the inner half of each flank (4 of 8 slugs for a normal hull, the v0.5
 * perpendicular volley's best case); a big body, or a swarm spread across the line, takes more.
 */
export const BROADSIDE_FOCUS_SPREAD = 100;
/** Max slugs per flank (guards a runaway knob). */
export const BROADSIDE_MAX_SLUGS = 12;
/** Repair Bay shield is refreshed every tick on covered ships and lingers this many ticks after they leave. */
export const BAY_SHIELD_HOLD_TICKS = 2;
/**
 * skillState key: the Space slot's last cooldown in ticks (mobility or capital skill, whichever set mobilityReadyTick),
 * so the HUD sweep (room/snapshot.ts spaceCooldownSec) stays right when the ship gains or loses its capital form
 * while that cooldown runs. Read-only for the sim itself.
 */
export const SPACE_CD_TICKS = 'spaceCdTicks';
/** `talent` marker of the 'ability' event that ends Resonance Overcharge. */
export const OVERCHARGE_END = 'overchargeEnd';

/** skillState keys the capital skills keep (Sim clears them on (re)spawn / class swap through endCapitalEffects). */
export const CAPITAL_TRANSIENT_KEYS = ['overchargeUntil', 'bayUntil', 'bayTicks', 'bayShieldUntil', 'bayShieldAbsorb'];

/** The capital skill of the ship's class (the Space skill while it hosts turrets). */
export function capitalSkillOf(ship: Ship): SkillDef {
  return SHIP_CLASSES[ship.shipClass].capital.skill;
}

/** Capital skill cooldown s (the capCooldown knob; mobilityCooldown for a class without one). */
export function capitalCooldownSec(ship: Ship): number {
  const cd = ship.stats.skill.capCooldown;
  return typeof cd === 'number' && Number.isFinite(cd) ? cd : ship.stats.mobilityCooldown;
}

/** Capital skill energy cost (the capCost knob; mobilityCost for a class without one). */
export function capitalCost(ship: Ship): number {
  const c = ship.stats.skill.capCost;
  return Math.max(0, typeof c === 'number' && Number.isFinite(c) ? c : ship.stats.mobilityCost);
}

function ability(world: World, ship: Ship, skill: SkillId, talent?: string): void {
  if (talent) emit(world, { t: 'ability', shipId: ship.id, skill, x: ship.x, y: ship.y, talent });
  else emit(world, { t: 'ability', shipId: ship.id, skill, x: ship.x, y: ship.y });
}

// ---------------------------------------------------------------------------------------------
// Broadside (Juggernaut → Dreadnought): mass-driver slugs from both flanks at once, converging on the aim point
// ---------------------------------------------------------------------------------------------

const FLANKS = [-1, 1] as const; // port, starboard

/** The Broadside focus: the aim point (input.aim / aimDist) with its distance clamped to the focus range. */
export function broadsideFocus(ship: Ship): { x: number; y: number; a: number; d: number } {
  const inp = ship.input;
  const a = Number.isFinite(inp.aim) ? inp.aim : ship.angle;
  const raw = Number.isFinite(inp.aimDist) ? inp.aimDist : BROADSIDE_FOCUS_MIN;
  const d = Math.max(BROADSIDE_FOCUS_MIN, Math.min(BROADSIDE_FOCUS_MAX, raw));
  return { x: ship.x + Math.cos(a) * d, y: ship.y + Math.sin(a) * d, a, d };
}

/** Fire the broadside. Returns false (nothing spent) when the projectile cap refused every slug. */
function broadside(world: World, ship: Ship): boolean {
  const st = ship.stats, sk = st.skill, tick = world.tick;
  const n = Math.max(1, Math.min(BROADSIDE_MAX_SLUGS, Math.round(sk.broadsideSlugs ?? 4)));
  const speed = sk.broadsideSpeed ?? 1150;
  const dmg = (sk.broadsideDamage ?? 160) * st.mobilityPower * st.damageMult;
  const r = st.radius, c = Math.cos(ship.angle), s = Math.sin(ship.angle);
  const f = broadsideFocus(ship);
  const qx = -Math.sin(f.a), qy = Math.cos(f.a); // across the aim line (starboard of it)
  const expire = tick + Math.max(1, secToTicks(BROADSIDE_LIFE));
  let spawned = 0;
  for (const side of FLANKS) {
    // outward normal of this flank: starboard (right of the heading on a y-down screen) = (−sin, cos)
    const nx = -s * side, ny = c * side;
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) - 0.5 : 0; // −0.5 stern … +0.5 bow
      const along = t * BROADSIDE_HULL_SPAN * r, out = r + BROADSIDE_RADIUS;
      const x = ship.x + c * along + nx * out, y = ship.y + s * along + ny * out;
      // each gunport fires at its own point on a line across the aim point
      const tx = f.x + qx * t * BROADSIDE_FOCUS_SPREAD, ty = f.y + qy * t * BROADSIDE_FOCUS_SPREAD;
      const a = Math.atan2(ty - y, tx - x);
      if (spawnProjectile(world, {
        ...projectileDefaults(world), kind: 'bullet', ownerId: ship.id, ownerPlayerId: ship.playerId, ownerTeam: ship.team,
        x, y,
        vx: ship.vx * BROADSIDE_INHERIT + Math.cos(a) * speed, vy: ship.vy * BROADSIDE_INHERIT + Math.sin(a) * speed,
        damage: dmg, radius: BROADSIDE_RADIUS, expireTick: expire, level: 3,
      })) spawned++;
    }
  }
  if (spawned === 0) return false;
  emit(world, { t: 'fire', shipId: ship.id, skill: 'broadside', x: ship.x, y: ship.y });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Resonance Overcharge (Arcanist → Spire): lasers on this host count extra for resonance
// ---------------------------------------------------------------------------------------------

function startOvercharge(world: World, ship: Ship): void {
  const time = ship.stats.skill.overchargeTime ?? 4;
  const until = world.tick + Math.max(1, secToTicks(time));
  ship.skillState.overchargeUntil = until;
  ship.mobilityActiveUntilTick = until;
}

/**
 * Extra lasers counted for resonance on `host` this tick (turretkits.ts laser): overchargeBonus while its Resonance
 * Overcharge runs and it is still a capital host, else 0.
 */
export function overchargeBonus(world: World, host: Ship): number {
  const until = host.skillState.overchargeUntil;
  if (until === undefined || !(until > world.tick) || !isCapital(host)) return 0;
  return Math.max(0, Math.round(host.stats.skill.overchargeBonus ?? 1));
}

function endOvercharge(world: World, ship: Ship): void {
  delete ship.skillState.overchargeUntil;
  if (ship.mobilityActiveUntilTick > world.tick) ship.mobilityActiveUntilTick = world.tick; // ended early
  ability(world, ship, 'overcharge', OVERCHARGE_END);
}

// ---------------------------------------------------------------------------------------------
// Repair Bay (Artificer → Foundry): heal + shield this host's turrets and nearby allies over bayTime
// ---------------------------------------------------------------------------------------------

function startBay(world: World, ship: Ship): void {
  const ticks = Math.max(1, secToTicks(ship.stats.skill.bayTime ?? 4));
  ship.skillState.bayUntil = world.tick + ticks;
  ship.skillState.bayTicks = ticks;
  ship.mobilityActiveUntilTick = world.tick + ticks;
}

/**
 * One Repair Bay tick: every alive turret docked on `ship` (any distance) and every alive ally within bayRadius
 * (never the Foundry itself) heals bayHealFrac × its maxEnergy × healMult / bayTicks (so bayHealFrac over the whole
 * bay) and absorbs bayShield of incoming damage (combat.ts shieldAbsorb) while covered.
 */
function stepBay(world: World, ship: Ship): void {
  const st = ship.stats, sk = st.skill, tick = world.tick;
  const ticks = Math.max(1, ship.skillState.bayTicks ?? 1);
  const k = (Math.max(0, sk.bayHealFrac ?? 0.35) * st.healMult) / ticks;
  const r = sk.bayRadius ?? 420, r2 = r * r;
  const absorb = Math.max(0, Math.min(0.95, sk.bayShield ?? 0.3));
  for (const s of world.ships.values()) {
    if (!s.alive || s.id === ship.id) continue;
    if (s.attachedTo !== ship.id) {
      if (!sameTeam(s.team, ship.team)) continue;
      const dx = s.x - ship.x, dy = s.y - ship.y;
      if (dx * dx + dy * dy > r2) continue;
    }
    if (k > 0) healShip(world, s, k * s.stats.maxEnergy, ship.id);
    if (absorb > 0) {
      const ts = s.skillState;
      const active = (ts.bayShieldUntil ?? 0) > tick;
      ts.bayShieldAbsorb = active ? Math.max(ts.bayShieldAbsorb ?? 0, absorb) : absorb;
      ts.bayShieldUntil = Math.max(active ? ts.bayShieldUntil ?? 0 : 0, tick + BAY_SHIELD_HOLD_TICKS);
    }
  }
}

/** Repair Bay shield fraction currently protecting `ship` (0 if none). */
export function bayShieldOf(world: World, ship: Ship): number {
  const ss = ship.skillState;
  return (ss.bayShieldUntil ?? 0) > world.tick ? ss.bayShieldAbsorb ?? 0 : 0;
}

// ---------------------------------------------------------------------------------------------
// Entry points (Sim / skills.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Space press of a capital host (skills.ts stepClassSkills): the class's capital skill, gated by the Space slot's
 * ready tick (mobilityReadyTick) and paid with capCost, then on cooldown for capCooldown.
 */
export function useCapital(world: World, ship: Ship): void {
  const tick = world.tick;
  if (tick < ship.mobilityReadyTick) return;
  const cost = capitalCost(ship);
  if (ship.energy < cost) return;
  const id = capitalSkillOf(ship).id;
  switch (id) {
    case 'broadside': if (!broadside(world, ship)) return; break;
    case 'overcharge': startOvercharge(world, ship); break;
    case 'repairbay': startBay(world, ship); break;
    default: return;
  }
  ship.energy -= cost;
  const cd = Math.max(1, secToTicks(capitalCooldownSec(ship)));
  ship.mobilityReadyTick = tick + cd;
  ship.skillState[SPACE_CD_TICKS] = cd;
  ability(world, ship, id);
}

/**
 * Timed capital effects, once per tick for EVERY ship (Sim pass 3, dead ones too): Overcharge ends (event) when
 * its time is up, the host is no longer a capital or it died; Repair Bay heals / shields until bayUntil (it keeps
 * running if the last turret leaves; it ends on death). A ship that never used a capital skill returns at once.
 */
export function stepCapital(world: World, ship: Ship): void {
  const ss = ship.skillState;
  if (ss.overchargeUntil !== undefined && (!ship.alive || world.tick >= ss.overchargeUntil || !isCapital(ship))) {
    endOvercharge(world, ship);
  }
  if (ss.bayUntil !== undefined) {
    if (!ship.alive || world.tick >= ss.bayUntil) { delete ss.bayUntil; delete ss.bayTicks; }
    else stepBay(world, ship);
  }
}

/** End every capital effect now (respawn / in-place class swap): Overcharge emits its end event if it was running. */
export function endCapitalEffects(world: World, ship: Ship): void {
  const ss = ship.skillState;
  if (ss.overchargeUntil !== undefined) endOvercharge(world, ship);
  for (const k of CAPITAL_TRANSIENT_KEYS) delete ss[k];
}
