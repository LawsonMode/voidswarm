// OWNER: SIM agent. Frozen signatures (+ healShip, v0.2).
import { ENEMY_TEAM, RESPAWN_SEC } from '../constants';
import type { Enemy, EntityId, Ship, TeamId, World } from '../types';
import { SHUTDOWN_MIN_STREAK } from '../data/loot';
import { riftOnDeath } from './dungeon';
import { rollLoot, spillCarried } from './loot';
import { dropShipXp, onEnemyKilled } from './pve/index';
import { side } from './state';
import { crewSafe, has } from './targeting';
import { detachAll } from './turrets';
import {
  canDamageEnemy, canDamageShip, emit, forEachEnemyNear, forEachShipNear, sameTeam, secToTicks,
} from './world';

// Tuning knobs
/** Kill credit window for lastDamagedBy when an enemy/self finishes a ship. */
export const ASSIST_CREDIT_SEC = 5;
/** Base score for a player kill (plus victim bounty). */
export const KILL_SCORE = 10;
/** Push given to turrets when their host dies. */
export const DEATH_DETACH_PUSH = 220;
/** voi_entropy: damage taken multiplier for hostiles inside an Entropy well. */
export const ENTROPY_MULT = 1.3;
/** bul_reflect: share of Iron-Hide-absorbed damage reflected to the attacking ship. */
export const REFLECT_FRAC = 0.4;
/** med_triage: heal multiplier on allies below TRIAGE_BELOW of max energy. */
export const TRIAGE_MULT = 1.5;
export const TRIAGE_BELOW = 0.3;
/** Heal events are batched per target: emitted when a single heal ≥ this, or every HEAL_EVENT_TICKS. */
const HEAL_EVENT_MIN = 40;
const HEAL_EVENT_TICKS = 15;

/** Bounty = 10 + 2·level + 5·killStreak. Sim also recomputes this for every ship each tick. */
export function computeBounty(ship: Ship): number {
  return 10 + 2 * ship.level + 5 * ship.killStreak;
}

/** Ram Charge in progress? */
export function isCharging(world: World, ship: Ship): boolean {
  return (ship.skillState.charging ?? 0) > 0 && world.tick < ship.mobilityActiveUntilTick;
}

/** Iron Hide (own) active? */
export function ironHideActive(world: World, ship: Ship): boolean {
  return ship.shipClass === 'brute' && world.tick < ship.utilityActiveUntilTick && (ship.skillState.hide ?? 0) > 0;
}

/**
 * Fraction absorbed by any active shield on this ship (own Iron Hide, Fortress-granted, or v0.5 Repair Bay
 * coverage), 0 if none. Shields don't stack: the strongest applies.
 */
export function shieldAbsorb(world: World, ship: Ship): number {
  let a = 0;
  if (ironHideActive(world, ship)) a = ship.stats.skill.hideAbsorb ?? 0.6;
  const ss = ship.skillState;
  if ((ss.extShieldUntil ?? 0) > world.tick) a = Math.max(a, ss.extShieldAbsorb ?? 0);
  if ((ss.bayShieldUntil ?? 0) > world.tick) a = Math.max(a, ss.bayShieldAbsorb ?? 0);
  return a < 0 ? 0 : a > 0.95 ? 0.95 : a;
}

let reflectDepth = 0;

/**
 * Damage a ship. `amount` already includes the attacker's multipliers; this applies invulnerability,
 * shield, and armor, drains energy, emits 'hit', records lastDamagedBy, and kills the ship when
 * energy < 0 (bounty transfer, score, gem drop via pve dropShipXp, turret detach, 'shipDeath').
 * sourceShipId = attacking ship (0 when cause is 'enemy' or 'self').
 *
 * v0.2 modifiers, in order: invuln → Ram Charge (Unstoppable = immune, else × chargeDamageTaken) →
 * Entropy (+30%) → shield absorb (Iron Hide / Fortress / v0.5 Repair Bay; Reflector bounces 40% of absorbed) →
 * turret Brace (× 1 − braceAbsorb) → armor (v0.5: a capital host's armor includes its per-turret bonus, hull.ts).
 */
export function damageShip(
  world: World, ship: Ship, amount: number, sourceShipId: EntityId, cause: 'player' | 'enemy' | 'self',
): void {
  if (!ship.alive || !(amount > 0)) return;
  const tick = world.tick;
  if (tick < ship.invulnUntilTick) return;
  const ss = ship.skillState;
  if (isCharging(world, ship)) {
    if (has(ship, 'ram_unstoppable')) return;
    amount *= ship.stats.skill.chargeDamageTaken ?? 0.4;
  }
  if ((ss.entropyTick ?? -10) >= tick - 1) amount *= ENTROPY_MULT;
  const absorb = shieldAbsorb(world, ship);
  if (absorb > 0) {
    const absorbed = amount * absorb;
    amount -= absorbed;
    if (sourceShipId && sourceShipId !== ship.id && reflectDepth < 2 && ironHideActive(world, ship) && has(ship, 'bul_reflect')) {
      const att = world.ships.get(sourceShipId);
      if (att && att.alive) {
        reflectDepth++;
        damageShip(world, att, absorbed * REFLECT_FRAC, ship.id, 'player');
        reflectDepth--;
        // Mutual Reflectors: the attacker's reflect can bounce back into us and kill us inside that call.
        if (!ship.alive) return;
      }
    }
  }
  if ((ss.braceTick ?? -10) >= tick - 1) amount *= 1 - (ss.braceAbsorb ?? 0);
  const armor = ship.stats.armor < 0 ? 0 : ship.stats.armor > 0.6 ? 0.6 : ship.stats.armor;
  amount *= 1 - armor;
  if (!(amount > 0)) return;
  ship.energy -= amount;
  emit(world, { t: 'hit', x: ship.x, y: ship.y, targetKind: 'ship', targetId: ship.id, amount: Math.round(amount) });
  if (sourceShipId && sourceShipId !== ship.id && world.ships.has(sourceShipId)) {
    ship.lastDamagedBy = sourceShipId;
    ship.lastDamagedTick = tick;
  }
  if (ship.energy < 0) killShip(world, ship, sourceShipId, cause);
}

function killShip(world: World, victim: Ship, sourceShipId: EntityId, cause: 'player' | 'enemy' | 'self'): void {
  if (!victim.alive) return; // already dead (re-entrant damage) — never score / drop / emit twice
  let killer: Ship | undefined;
  if (sourceShipId && sourceShipId !== victim.id) killer = world.ships.get(sourceShipId);
  if (!killer && victim.lastDamagedBy && victim.lastDamagedBy !== victim.id &&
      world.tick - victim.lastDamagedTick <= secToTicks(ASSIST_CREDIT_SEC)) {
    killer = world.ships.get(victim.lastDamagedBy);
  }
  if (killer) cause = 'player';
  const bounty = victim.bounty;
  const streak = victim.killStreak; // v0.3 shutdown loot reads the streak BEFORE the reset below
  const scoring = world.match.phase === 'playing';
  const hostileKill = !!killer && !sameTeam(killer.team, victim.team);
  if (killer && hostileKill) {
    if (scoring) killer.score += KILL_SCORE + bounty;
    killer.kills++;
    killer.killStreak++;
    killer.bounty = computeBounty(killer);
  }
  victim.deaths++;
  victim.killStreak = 0;
  victim.bounty = computeBounty(victim);
  victim.energy = 0;

  dropShipXp(world, victim);
  detachAll(world, victim, DEATH_DETACH_PUSH);

  victim.alive = false;
  victim.respawnTick = world.tick + secToTicks(RESPAWN_SEC);
  victim.lastDamagedBy = 0;
  victim.utilityActiveUntilTick = 0;
  victim.mobilityActiveUntilTick = 0;
  victim.skillState.charging = 0;
  side(world).ramHits.delete(victim.id);
  emit(world, {
    t: 'shipDeath', shipId: victim.id, playerId: victim.playerId,
    killerPlayerId: killer ? killer.playerId : 0, cause,
    x: victim.x, y: victim.y, bounty,
  });

  // v0.3 loot (§9 killShip order): existing bookkeeping → rollLoot('shutdown') → spillCarried → riftOnDeath.
  // Shutdown: a non-ally killed a pilot on a killStreak ≥ SHUTDOWN_MIN_STREAK (killer priority 3 s).
  if (killer && hostileKill && streak >= SHUTDOWN_MIN_STREAK) {
    rollLoot(world, 'shutdown', victim.x, victim.y, { priorityPid: killer.playerId });
  }
  // Spill: a non-ally killer gets priority (spillCarried decides; allies, the swarm and self-kills get none).
  spillCarried(world, victim, killer ? killer.playerId : 0);
  // Rift (dungeon only): a life from the shared pool (respawn in RIFT_RESPAWN_SEC) or out for the floor; wipe check.
  if (world.dungeon) riftOnDeath(world, victim, killer);
}

/**
 * Heal a ship's energy (capped at maxEnergy). `amount` already includes the healer's healMult;
 * this applies Triage (source has med_triage and target is an ally below 30%). Returns energy restored.
 * Tracks source.skillState.healDone and emits batched 'heal' events.
 */
export function healShip(world: World, target: Ship, amount: number, sourceShipId: EntityId): number {
  if (!target.alive || !(amount > 0)) return 0;
  const src = sourceShipId ? world.ships.get(sourceShipId) : undefined;
  if (src && src.id !== target.id && has(src, 'med_triage') && target.energy < TRIAGE_BELOW * target.stats.maxEnergy) {
    amount *= TRIAGE_MULT;
  }
  const room = target.stats.maxEnergy - target.energy;
  if (room <= 0) return 0;
  const healed = amount < room ? amount : room;
  target.energy += healed;
  if (src) src.skillState.healDone = (src.skillState.healDone ?? 0) + healed;
  const ss = target.skillState;
  ss.healAcc = (ss.healAcc ?? 0) + healed;
  if (healed >= HEAL_EVENT_MIN || world.tick - (ss.healEmitTick ?? -1000) >= HEAL_EVENT_TICKS) {
    emit(world, { t: 'heal', x: target.x, y: target.y, targetId: target.id, amount: Math.round(ss.healAcc) });
    ss.healAcc = 0;
    ss.healEmitTick = world.tick;
  }
  return healed;
}

/**
 * Damage a PvE enemy. Emits 'hit'; when hp ≤ 0 calls pve onEnemyKilled(world, enemy, sourceShipId)
 * (which removes it, drops gems, awards score/xp, emits 'enemyDeath'). Entropy wells add +30%.
 * v0.3: the amount is first multiplied by enemy.mem.dmgTaken when set (the Matriarch's intro sets 0: no damage,
 * no 'hit'); absent = ×1, so every v0.2 enemy is untouched.
 */
export function damageEnemy(world: World, enemy: Enemy, amount: number, sourceShipId: EntityId): void {
  const taken = enemy.mem.dmgTaken;
  if (taken !== undefined) amount *= taken;
  if (!(amount > 0) || enemy.hp <= 0) return;
  if (world.enemies.get(enemy.id) !== enemy) return;
  if ((enemy.mem.entropyTick ?? -10) >= world.tick - 1) amount *= ENTROPY_MULT;
  enemy.hp -= amount;
  emit(world, { t: 'hit', x: enemy.x, y: enemy.y, targetKind: 'enemy', targetId: enemy.id, amount: Math.round(amount) });
  if (enemy.hp <= 0) onEnemyKilled(world, enemy, sourceShipId);
}

// scratch state for splash callbacks (avoid per-call closures)
let sW: World, sX = 0, sY = 0, sR = 0, sAmt = 0, sTeam: TeamId = 0, sOwner: EntityId = 0, sFall = true;
function falloff(dx: number, dy: number, bodyR: number): number {
  if (!sFall) return 1;
  const d = Math.max(0, Math.sqrt(dx * dx + dy * dy) - bodyR);
  const t = sR > 0 ? Math.min(1, d / sR) : 0;
  return 1 - 0.6 * t;
}
function splashShip(s: Ship): void {
  if (!canDamageShip(sW, sTeam, sOwner, s.team, s.id) || crewSafe(sW, sTeam, sOwner, s)) return;
  const f = falloff(s.x - sX, s.y - sY, s.stats.radius);
  const enemy = sTeam === ENEMY_TEAM;
  damageShip(sW, s, sAmt * f, enemy ? 0 : sOwner, enemy ? 'enemy' : 'player');
}
function splashEnemy(e: Enemy): void {
  const f = falloff(e.x - sX, e.y - sY, e.radius);
  damageEnemy(sW, e, sAmt * f, sOwner);
}

function areaDamage(
  world: World, x: number, y: number, radius: number, amount: number, ownerTeam: TeamId, ownerShipId: EntityId, fall: boolean,
): void {
  if (!(radius > 0) || !(amount > 0)) return;
  const prev = [sW, sX, sY, sR, sAmt, sTeam, sOwner, sFall] as const; // re-entrancy safety (kills can chain)
  const set = () => {
    sW = world; sX = x; sY = y; sR = radius; sAmt = amount; sTeam = ownerTeam; sFall = fall;
    sOwner = ownerTeam === ENEMY_TEAM ? 0 : ownerShipId;
  };
  set();
  forEachShipNear(world, x, y, radius, splashShip);
  if (canDamageEnemy(ownerTeam)) {
    set();
    forEachEnemyNear(world, x, y, radius, splashEnemy);
  }
  [sW, sX, sY, sR, sAmt, sTeam, sOwner, sFall] = prev;
}

/**
 * Area damage to every damageable ship and enemy within radius (linear falloff to 40% at edge).
 * Respects canDamageShip/canDamageEnemy. ownerShipId = 0 for enemy-owned blasts.
 */
export function splashDamage(
  world: World, x: number, y: number, radius: number, amount: number,
  ownerTeam: TeamId, ownerShipId: EntityId,
): void {
  areaDamage(world, x, y, radius, amount, ownerTeam, ownerShipId, true);
}

/** Like splashDamage but flat (no falloff) — used for damage-over-time zones. SIM addition. */
export function flatAreaDamage(
  world: World, x: number, y: number, radius: number, amount: number, ownerTeam: TeamId, ownerShipId: EntityId,
): void {
  areaDamage(world, x, y, radius, amount, ownerTeam, ownerShipId, false);
}
