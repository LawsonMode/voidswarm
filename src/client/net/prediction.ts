// Own-ship client-side prediction with input replay and smoothed corrections. Pure: the step fn is injected.
//
// The replay mirrors the server's per-tick movement (Sim.step pass 1 + the mobility part of pass 3):
// - afterburner engages only while moving and with energy > afterburnerCostPerSec·DT (Sim.ts), and
//   drains / recharges the predicted energy;
// - Ram Charge: the press tick moves normally and snaps the hull to the aim, then the ship drives at
//   chargeSpeed along the (wall-sliding) charge direction, ignoring input, and the end tick clamps to maxSpeed;
// - Repair Pulse: ×boostMult speed for boostTicks after the press;
// - Blink is server-authoritative: the first reconcile that includes it snaps instead of smoothing;
// - v0.3 M3: a CTF flag carrier (SHIPFLAG_CARRIER) moves (and Ram Charges) at × carrierSpeedMult, on top of the
//   turret slow-down, and recharges at × Flag Overload (PredictCtx.rechargeMult).
// Local presses are predicted from the last known cooldown/energy; every snapshot re-anchors them on
// server truth (cooldown remaining tells us the exact tick the server used the skill, SHIPFLAG_CHARGING
// whether a charge is still running), so a refused or early-ended charge is dropped at once.
import { TICK_RATE } from '../../shared/constants';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { collideCircle } from '../../shared/sim/map';
import { carrierSpeedMult, flagOverloadMult } from '../../shared/sim/objectives/rules';
import { THRUST_DEADZONE, type MovementBody } from '../../shared/sim/movement';
import { REPAIR_BOOST_MULT, REPAIR_BOOST_SEC, UNSTOPPABLE_DIST_MULT } from '../../shared/sim/skills';
import { SHIPFLAG_CHARGING, type GameMap, type InputState, type ShipStats, type ShipView, type YouState } from '../../shared/types';
import { angleDiff, wrapAngle } from '../../shared/util/math';
import { hostSpeedMult } from './attach';

export type StepFn = (
  body: MovementBody, input: InputState, stats: ShipStats, map: GameMap, dt: number,
  afterburner: boolean, speedMult: number,
) => void;

export type CollideFn = (map: GameMap, x: number, y: number, r: number) => { hit: boolean; x: number; y: number; nx: number; ny: number };

/** Time constant (seconds) for decaying the visual correction error. */
const SMOOTH_TAU = 0.1;
/** Corrections larger than this snap instead of blending (respawn, warp). */
export const SNAP_DIST = 220;
const MAX_INPUTS = 120;

/** Movement-relevant skill state the client can see; rebuilt from each snapshot (moveSkillsFor). */
export interface MoveSkills {
  /** Own class mobility skill: 'ram' | 'blink' | 'repair' (anything else: no movement effect). */
  mobility: string;
  mobilityCost: number;
  /** Mobility cooldown in ticks, as the server computes it (max(1, round(cooldown·TICK_RATE))). */
  cooldownTicks: number;
  /** Server: ticks until mobility is ready, as of the acked tick (0 = ready). */
  readyIn: number;
  /** Server: the own ship has SHIPFLAG_CHARGING at the acked tick. */
  charging: boolean;
  /** Ram Charge length in ticks (activeUntil − press tick). */
  chargeTicks: number;
  chargeSpeed: number;
  /** Repair Pulse boost length in ticks (boostUntil − press tick) and multiplier. */
  boostTicks: number;
  boostMult: number;
}

export interface PredictCtx {
  stats: ShipStats;
  map: GameMap;
  /** Server energy (latest snapshot). */
  energy: number;
  /** Host turret slow-down (hostSpeedMult). */
  speedMult: number;
  /**
   * Sim pass 3 recharge × objRechargeMult: a CTF carrier's Flag Overload (×0.5 after 60 s of carry, ×0 after 90 s;
   * `predictRechargeMult`). Omitted = 1.
   */
  rechargeMult?: number;
  /** null = don't model skills (plain movement only). */
  skills: MoveSkills | null;
}

/**
 * Sim.ts pass 1 speed multiplier the client can see: the host slow-down per attached turret (never below ×0.5)
 * times the objective multiplier (`carrierSpeedMult`: a CTF carrier is slower). Repair Pulse's boost is modelled
 * separately (MoveSkills). §5.2: speedMult = hostSpeedMult × carrierSpeedMult(view.flags).
 */
export function predictSpeedMult(turretCount: number, flags: number): number {
  return (turretCount > 0 ? hostSpeedMult(turretCount) : 1) * carrierSpeedMult(flags | 0);
}

/**
 * Flag Overload as the client can see it: `carrySec` = seconds since the own ShipView first showed SHIPFLAG_CARRIER
 * (negative = not carrying). Mirrors sim objRechargeMult for the carrier.
 */
export function predictRechargeMult(carrySec: number): number {
  return carrySec >= 0 ? flagOverloadMult(carrySec) : 1;
}

/** Build MoveSkills from the own YouState + ShipView (same rules as the server's skills.ts / Sim.ts). */
export function moveSkillsFor(you: YouState, view: ShipView | undefined): MoveSkills {
  const cls = SHIP_CLASSES[view?.shipClass ?? 'brute'];
  const st = you.stats;
  const sk = st.skill ?? {};
  const unstoppable = you.talents?.includes('ram_unstoppable') ?? false;
  return {
    mobility: cls?.skills.mobility.id ?? '',
    mobilityCost: st.mobilityCost,
    cooldownTicks: Math.max(1, Math.round(st.mobilityCooldown * TICK_RATE)),
    readyIn: Math.max(0, Math.round((you.cdSec?.mobility ?? 0) * TICK_RATE)),
    charging: !!view && (view.flags & SHIPFLAG_CHARGING) !== 0,
    chargeTicks: Math.max(1, Math.round((sk.chargeTime ?? 0.35) * (unstoppable ? UNSTOPPABLE_DIST_MULT : 1) * TICK_RATE)),
    // skills.ts stepCharge: × objSpeedMult, i.e. a CTF carrier charges × CTF_CARRIER_SPEED_MULT.
    chargeSpeed: (sk.chargeSpeed ?? 1500) * carrierSpeedMult(view?.flags ?? 0),
    boostTicks: Math.round(REPAIR_BOOST_SEC * TICK_RATE),
    boostMult: REPAIR_BOOST_MULT,
  };
}

/** Sim.ts afterburner rule: held, actually thrusting, and enough energy for this tick's cost. */
export function afterburnerEngaged(input: InputState, energy: number, stats: ShipStats, dt: number): boolean {
  if (!input.afterburner) return false;
  const mx = Number.isFinite(input.moveX) ? input.moveX : 0, my = Number.isFinite(input.moveY) ? input.moveY : 0;
  return Math.sqrt(mx * mx + my * my) > THRUST_DEADZONE && energy > stats.afterburnerCostPerSec * dt;
}

interface Charge {
  /** Seq of the press (the tick that started it; that tick itself moves normally). */
  start: number;
  ticks: number;
  /** Hull angle set at the press. */
  angle: number;
  /** Direction at the press, and the working direction (wall slides turn it) for the current pass. */
  dirX0: number; dirY0: number;
  dirX: number; dirY: number;
  /** Stopped dead against a wall in the current pass. */
  stopped: boolean;
}

interface Boost { start: number; ticks: number; mult: number }

export class Predictor {
  body: MovementBody | null = null;
  errX = 0;
  errY = 0;
  errA = 0;
  private inputs: InputState[] = [];
  /** Predicted energy along the current body timeline. */
  private energy = 0;
  private charge: Charge | null = null;
  private boost: Boost | null = null;
  /** First input seq at which mobility is predicted to be ready. */
  private readySeq = 0;
  /** Seq of the last locally predicted mobility use (until the server has seen it). */
  private localUse: number | null = null;
  private prevMobility = false;
  private lastAck = -1;

  constructor(private step: StepFn, private dt: number, private collide: CollideFn = collideCircle) {}

  reset(): void {
    this.body = null;
    this.inputs.length = 0;
    this.errX = this.errY = this.errA = 0;
    this.charge = this.boost = null;
    this.readySeq = 0;
    this.localUse = null;
    this.prevMobility = false;
    this.lastAck = -1;
  }

  /** Drop the predicted body but keep the input ring (while dead or attached as a turret). */
  suspend(): void {
    this.body = null;
    this.errX = this.errY = this.errA = 0;
    this.charge = this.boost = null;
    this.localUse = null;
  }

  get pendingCount(): number { return this.inputs.length; }

  /** Record a sent input and advance the predicted body by one tick. ctx null = not piloting (dead / turret). */
  applyLocal(input: InputState, ctx: PredictCtx | null): void {
    this.inputs.push(input);
    if (this.inputs.length > MAX_INPUTS) this.inputs.splice(0, this.inputs.length - MAX_INPUTS);
    const edge = input.mobility && !this.prevMobility;
    this.prevMobility = input.mobility;
    if (!ctx || !this.body) return;
    if (edge && ctx.skills) this.predictUse(input, ctx.skills);
    this.stepSeq(this.body, input, ctx);
  }

  /**
   * The server reports the ship at `server` after applying input `ackSeq`. Rewind and replay. `teleported`: the
   * server moved the ship this snapshot (a rift seal recall / doorway nudge, the `blink` event on the own ship), so
   * the jump is shown as one — no slide across the gap (it would cross a freshly sealed door).
   */
  reconcile(server: MovementBody, ackSeq: number, ctx: PredictCtx, teleported = false): void {
    let drop = 0;
    while (drop < this.inputs.length && this.inputs[drop].seq <= ackSeq) drop++;
    if (drop) this.inputs.splice(0, drop);

    const blinked = this.syncSkills(server, ackSeq, ctx);
    this.lastAck = ackSeq;

    const old = this.body ? this.visual() : null;
    const body: MovementBody = { x: server.x, y: server.y, vx: server.vx, vy: server.vy, angle: server.angle };
    this.energy = ctx.energy;
    for (const inp of this.inputs) this.stepSeq(body, inp, ctx);
    this.body = body;

    if (old) {
      this.errX = old.x - body.x;
      this.errY = old.y - body.y;
      this.errA = angleDiff(body.angle, old.angle);
      const big = this.errX * this.errX + this.errY * this.errY > SNAP_DIST * SNAP_DIST;
      // A teleport (Blink) is shown as one: no slide across the gap.
      if (big) this.errX = this.errY = this.errA = 0;
      else if (blinked || teleported) this.errX = this.errY = 0;
    } else {
      this.errX = this.errY = this.errA = 0;
    }
  }

  /** Blend the visual error toward zero. */
  decay(dtSec: number): void {
    const k = Math.exp(-dtSec / SMOOTH_TAU);
    this.errX *= k;
    this.errY *= k;
    this.errA *= k;
    if (Math.abs(this.errX) < 0.01) this.errX = 0;
    if (Math.abs(this.errY) < 0.01) this.errY = 0;
  }

  /** Predicted body plus the smoothing offset (what gets drawn). */
  visual(): { x: number; y: number; vx: number; vy: number; angle: number } {
    const b = this.body!;
    return { x: b.x + this.errX, y: b.y + this.errY, vx: b.vx, vy: b.vy, angle: b.angle + this.errA };
  }

  // ------------------------------------------------------------------ skills

  /** A local mobility press the server should accept (ready + affordable): start its movement effect. */
  private predictUse(input: InputState, sk: MoveSkills): void {
    if (input.seq < this.readySeq || this.energy < sk.mobilityCost) return;
    const aim = Number.isFinite(input.aim) ? input.aim : (this.body?.angle ?? 0);
    switch (sk.mobility) {
      case 'ram': {
        const dx = Math.cos(aim), dy = Math.sin(aim);
        this.charge = { start: input.seq, ticks: sk.chargeTicks, angle: wrapAngle(aim), dirX0: dx, dirY0: dy, dirX: dx, dirY: dy, stopped: false };
        break;
      }
      case 'repair': this.boost = { start: input.seq, ticks: sk.boostTicks, mult: sk.boostMult }; break;
      case 'blink': break; // server-authoritative teleport (snap on the reconcile that includes it)
      default: return;
    }
    this.localUse = input.seq; // its energy cost is taken in stepSeq (live and in every replay until acked)
    this.readySeq = input.seq + sk.cooldownTicks;
  }

  /**
   * Re-anchor skill state on the snapshot. Returns true when this snapshot is the first to include a Blink.
   * cooldownTicks − readyIn = ticks since the server last used mobility → the seq of that use.
   */
  private syncSkills(server: MovementBody, ackSeq: number, ctx: PredictCtx): boolean {
    const sk = ctx.skills;
    if (!sk) { this.charge = this.boost = null; this.localUse = null; return false; }
    const since = sk.readyIn > 0 ? sk.cooldownTicks - sk.readyIn : -1;
    const used: number | null = since >= 0 ? ackSeq - since : null;

    if (this.localUse !== null && this.localUse > ackSeq) this.readySeq = this.localUse + sk.cooldownTicks;
    else { this.localUse = null; this.readySeq = ackSeq + sk.readyIn; }

    // Ram Charge
    const c = this.charge;
    if (sk.mobility !== 'ram') this.charge = null;
    else if (c && c.start > ackSeq) { c.dirX = c.dirX0; c.dirY = c.dirY0; c.stopped = false; } // server hasn't seen the press yet
    else if (sk.charging && used !== null) {
      const same = !!c && c.start === used;
      let dx: number, dy: number;
      const sp = Math.sqrt(server.vx * server.vx + server.vy * server.vy);
      if (ackSeq > used && sp > 1) {
        // Charging velocity = dir × chargeSpeed, set BEFORE this tick's wall slide: if the ship is pressed
        // against a wall along it, the server turned the direction at this tick — do the same.
        dx = server.vx / sp; dy = server.vy / sp;
        const probe = this.collide(ctx.map, server.x + dx * 0.5, server.y + dy * 0.5, ctx.stats.radius);
        const slid = probe.hit ? slideDir(dx, dy, probe.nx, probe.ny) : null;
        if (slid && slid !== 'stop') { dx = slid.x; dy = slid.y; }
      } else if (same) { dx = c!.dirX0; dy = c!.dirY0; } else { dx = Math.cos(server.angle); dy = Math.sin(server.angle); }
      this.charge = {
        start: used, ticks: sk.chargeTicks, angle: same ? c!.angle : server.angle,
        dirX0: same ? c!.dirX0 : dx, dirY0: same ? c!.dirY0 : dy, dirX: dx, dirY: dy, stopped: false,
      };
    } else this.charge = null; // refused, stopped at a wall, or over: server truth from here on

    // Repair Pulse boost
    const b = this.boost;
    if (sk.mobility !== 'repair') this.boost = null;
    else if (b && b.start > ackSeq) { /* pending local press */ }
    else if (used !== null && ackSeq < used + sk.boostTicks) this.boost = { start: used, ticks: sk.boostTicks, mult: sk.boostMult };
    else this.boost = null;

    // Blink: the server used it after the previous snapshot we reconciled against.
    return sk.mobility === 'blink' && used !== null && used > this.lastAck && used <= ackSeq && this.lastAck >= 0;
  }

  /** One server tick of own-ship movement for input `inp` (mutates body + predicted energy). */
  private stepSeq(b: MovementBody, inp: InputState, ctx: PredictCtx): void {
    const s = inp.seq, st = ctx.stats, dt = this.dt;
    const c = this.charge;
    if (c && !c.stopped && s > c.start && s < c.start + c.ticks && ctx.skills) {
      this.chargeStep(b, c, ctx);
      this.recharge(st, ctx);
      return;
    }
    if (c && !c.stopped && s === c.start + c.ticks) {
      // endRam: shed the charge speed down to maxSpeed, then move normally this tick.
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > st.maxSpeed && sp > 0) { b.vx *= st.maxSpeed / sp; b.vy *= st.maxSpeed / sp; }
    }
    const ab = afterburnerEngaged(inp, this.energy, st, dt);
    let sm = ctx.speedMult;
    const bo = this.boost;
    if (bo && s > bo.start && s < bo.start + bo.ticks) sm *= bo.mult;
    this.step(b, inp, st, ctx.map, dt, ab, sm);
    if (ab) this.energy -= st.afterburnerCostPerSec * dt;
    else this.recharge(st, ctx);
    if (s === this.localUse && ctx.skills) this.energy -= ctx.skills.mobilityCost;
    if (c && s === c.start) b.angle = c.angle; // startRam faces the aim
  }

  private recharge(st: ShipStats, ctx: PredictCtx): void {
    const m = ctx.rechargeMult ?? 1;
    this.energy = Math.min(st.maxEnergy, this.energy + st.rechargePerSec * (Number.isFinite(m) ? m : 1) * this.dt);
  }

  /** skills.ts stepCharge movement (hits are the server's business). */
  private chargeStep(b: MovementBody, c: Charge, ctx: PredictCtx): void {
    const sp = ctx.skills!.chargeSpeed, dt = this.dt;
    b.vx = c.dirX * sp; b.vy = c.dirY * sp;
    b.x += b.vx * dt; b.y += b.vy * dt;
    const hit = this.collide(ctx.map, b.x, b.y, ctx.stats.radius);
    if (!hit.hit) return;
    b.x = hit.x; b.y = hit.y;
    const slid = slideDir(c.dirX, c.dirY, hit.nx, hit.ny);
    if (slid === 'stop') { c.stopped = true; b.vx = 0; b.vy = 0; return; }
    if (slid) { c.dirX = slid.x; c.dirY = slid.y; }
  }
}

/** skills.ts wall slide: drop the into-wall component (null = not into the wall, 'stop' = head-on). */
function slideDir(dirX: number, dirY: number, nx: number, ny: number): { x: number; y: number } | 'stop' | null {
  const dn = dirX * nx + dirY * ny;
  if (dn >= 0) return null;
  const dx = dirX - dn * nx, dy = dirY - dn * ny;
  const l = Math.sqrt(dx * dx + dy * dy);
  if (l < 0.2) return 'stop';
  return { x: dx / l, y: dy / l };
}
