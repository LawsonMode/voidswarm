// OWNER: AI agent. Incoming-damage estimate for bots (Iron Hide spikes, turret Brace).
//
// Bots only see `world` at think() time, and Room drains world.events right after each step, so
// 'hit' events are never visible to a brain. Instead we sample a ship's energy once per tick and
// subtract everything the ship is known to have done to it since the previous sample:
//   + recharge actually available (none on an afterburner tick, never above maxEnergy)
//   - primary / secondary / mobility / utility costs (detected from their ready-tick changes)
//   - afterburner (SHIPFLAG_AFTERBURNER)
//   - host energy drawn by turret offense (flak / seeker pod bursts, laser beams with resonance)
// Whatever energy loss remains is damage. Heals only make the estimate smaller (net damage).
// Mirrors the sim's order in Sim.step(): tick++, movement + afterburner, recharge, skills.
import { DT, LASER_RESONANCE, TICK_RATE } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import { SHIPFLAG_AFTERBURNER, type EntityId, type Ship, type World } from '../types';

/** A failed secondary (no target / sentry refused) sets secondaryReadyTick = tick + 6 without cost. */
const SECONDARY_RETRY_TICKS = 6;

export class DamageMeter {
  private id: EntityId = 0;
  /** world.tick of the last sample; -1 = no baseline. */
  private tick = -1;
  private energy = 0;
  private max = 0;
  private gunReady = 0;
  private secReady = 0;
  private mobReady = 0;
  private utilReady = 0;
  /** Turret id -> its gunReadyTick at the last sample (host-drain detection for flak / pods). */
  private readonly turretGun = new Map<EntityId, number>();
  private acc = 0;

  /** Forget the baseline and any accumulated damage. */
  reset(): void {
    this.tick = -1;
    this.acc = 0;
    this.turretGun.clear();
  }

  /**
   * Sample `s` at the current world.tick (call once per tick, before that tick's step). A sample
   * that does not directly follow the previous one (skipped ticks, another ship, respawn, a
   * max-energy change, or the ship riding as a turret) only re-baselines.
   */
  sample(world: World, s: Ship): void {
    const t = world.tick;
    if (s.alive && s.attachedTo === 0 && this.tick >= 0 && s.id === this.id && t === this.tick + 1 &&
        s.stats.maxEnergy === this.max) {
      const dmg = this.energy + this.rechargeCredit(s) - this.spent(world, s, t) - s.energy;
      if (dmg > 0) this.acc += dmg;
    }
    this.snapshot(s, world, t);
  }

  /** Damage accumulated since the last take(); resets the accumulator. */
  take(): number {
    const a = this.acc;
    this.acc = 0;
    return a;
  }

  private rechargeCredit(s: Ship): number {
    if (s.flags & SHIPFLAG_AFTERBURNER) return 0; // the sim skips recharge on afterburner ticks
    const room = s.stats.maxEnergy - this.energy;
    return room > 0 ? Math.min(s.stats.rechargePerSec * DT, room) : 0;
  }

  private spent(world: World, s: Ship, t: number): number {
    const st = s.stats;
    let c = 0;
    if (s.gunReadyTick !== this.gunReady) c += st.gunCost;
    if (s.secondaryReadyTick !== this.secReady && s.secondaryReadyTick - t > SECONDARY_RETRY_TICKS) c += st.secondaryCost;
    if (s.mobilityReadyTick !== this.mobReady) c += st.mobilityCost;
    if (s.utilityReadyTick !== this.utilReady) c += st.utilityCost;
    if (s.flags & SHIPFLAG_AFTERBURNER) c += st.afterburnerCostPerSec * DT;
    if (s.turrets.length) c += this.turretDrain(world, s, t);
    return c;
  }

  /** Host energy drawn by this host's turrets during the last step. */
  private turretDrain(world: World, host: Ship, t: number): number {
    let c = 0;
    let laserCost = 0;
    for (const id of host.turrets) {
      const tr = world.ships.get(id);
      if (!tr || tr.attachedTo !== host.id) continue;
      const kit = SHIP_CLASSES[tr.shipClass]?.turret.id;
      const sk = tr.stats.skill;
      if (kit === 'laser') {
        if (!laserCost) laserCost = sk.laserHostCostPerSec ?? 90;
        continue;
      }
      const flak = kit === 'flak';
      const prev = this.turretGun.get(id);
      if (prev === undefined) {
        // seated during the last step (not in our snapshot): it fired in that same step iff its
        // gunReadyTick is exactly this tick + its burst cooldown (sim: tick + max(1, secToTicks(cd)))
        const cd = Math.max(1, Math.round((flak ? (sk.flakCd ?? 0.45) : (sk.podCd ?? 1)) * TICK_RATE));
        if (tr.gunReadyTick !== t + cd) continue;
      } else if (tr.gunReadyTick === prev) continue;
      c += flak ? (sk.flakHostCost ?? 40) : (sk.podHostCost ?? 45);
    }
    // Lasers: the sim caches the firing count on the host for the tick it charged them.
    const ss = host.skillState;
    const n = ss.laserTick === t ? (ss.laserN ?? 0) : 0;
    if (n > 0) c += n * (laserCost || 90) * DT * (n <= 1 ? 1 : Math.pow(LASER_RESONANCE, n - 1));
    return c;
  }

  private snapshot(s: Ship, world: World, t: number): void {
    if (!s.alive || s.attachedTo !== 0) { this.reset(); return; }
    this.id = s.id;
    this.tick = t;
    this.energy = s.energy;
    this.max = s.stats.maxEnergy;
    this.gunReady = s.gunReadyTick;
    this.secReady = s.secondaryReadyTick;
    this.mobReady = s.mobilityReadyTick;
    this.utilReady = s.utilityReadyTick;
    this.turretGun.clear();
    for (const id of s.turrets) {
      const tr = world.ships.get(id);
      if (tr) this.turretGun.set(id, tr.gunReadyTick);
    }
  }
}
