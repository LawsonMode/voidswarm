// OWNER: OBJECTIVES agent. Capture the Flag (docs/v0.3-proposal.md §5.3), 2–4 teams.
//
// Per tick (stepCtf, called from stepObjectives after stepProjectiles):
//   kill credits (this tick's shipDeath: carrier kill / defend kill) → carrier validity (a dead / removed /
//   attached / team-swapped carrier drops the flag where it was) → 20 s auto-return → captures (carrier within
//   90 px of its own stand while its own flag is home) → touches (nearest eligible ship: an enemy takes, a
//   teammate returns a dropped flag) → gunner seat (carrier keeps turret slot 0 only) → SHIPFLAG_CARRIER.
import { NO_TEAM } from '../../constants';
import type { FlagObjective, GameEvent, ObjectiveState, Ship, World } from '../../types';
import { SHIPFLAG_CARRIER, SHIPFLAG_CLOAKED, SHIPFLAG_INVULN } from '../../types';
import { syncHull } from '../hull';
import { rollLoot } from '../loot';
import { emit, secToTicks } from '../world';
import {
  credit, emitObjective, forFreshEvents, mvpPid, objSide, setWinner, shipOfPid, statsFor, timeUp, uniqueTop,
} from './common';
import {
  CTF_ASSIST_RADIUS, CTF_CAPTURE_RADIUS, CTF_CARRIER_MAX_TURRETS, CTF_CARRIER_SPEED_MULT, CTF_DEFEND_RADIUS,
  CTF_PICKUP_PAD, CTF_REPICK_SEC, CTF_RETURN_SEC, CTF_SCORE, CTF_SUDDEN_DEATH_SEC, flagOverloadMult,
} from './rules';

/** One flag per team from the map's flagStand features (state home). */
export function initCtf(world: World, o: ObjectiveState): void {
  const stands = (world.map.features ?? []).filter((f) => f.kind === 'flagStand').sort((a, b) => a.team - b.team);
  for (const f of stands) {
    if (!(f.team >= 0 && f.team < o.teamPoints.length) || o.flags.some((g) => g.team === f.team)) continue;
    o.flags.push({
      team: f.team, state: 'home', x: f.x, y: f.y, standX: f.x, standY: f.y,
      carrierId: 0, carrierPlayerId: 0, droppedAtTick: 0, pickedAtTick: 0, runners: [],
    });
  }
  o.mem.caps = 0;
  o.mem.sdCaps = 0;
}

export function flagCarriedBy(o: ObjectiveState, shipId: number): FlagObjective | undefined {
  if (!(shipId > 0)) return undefined;
  for (const f of o.flags) if (f.state === 'carried' && f.carrierId === shipId) return f;
  return undefined;
}

export function flagOf(o: ObjectiveState, team: number): FlagObjective | undefined {
  for (const f of o.flags) if (f.team === team) return f;
  return undefined;
}

function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function dropFlag(world: World, o: ObjectiveState, f: FlagObjective, x: number, y: number, carrier: Ship | undefined): void {
  const pid = f.carrierPlayerId;
  f.state = 'dropped';
  f.x = x; f.y = y;
  f.carrierId = 0; f.carrierPlayerId = 0;
  f.droppedAtTick = world.tick;
  if (carrier) carrier.flags &= ~SHIPFLAG_CARRIER;
  emitObjective(world, 'flagDropped', carrier ? carrier.team : NO_TEAM, pid, f.team, x, y, CTF_RETURN_SEC);
}

function sendHome(o: ObjectiveState, f: FlagObjective): void {
  objSide(o).keepCarry.delete(f.team);
  f.state = 'home';
  f.x = f.standX; f.y = f.standY;
  f.carrierId = 0; f.carrierPlayerId = 0;
  f.droppedAtTick = 0; f.pickedAtTick = 0;
  f.runners = [];
}

/** Touch return (+20, returns stat) when `by` is given; else the 20 s auto-return. */
function returnFlag(world: World, o: ObjectiveState, f: FlagObjective, by: Ship | undefined): void {
  sendHome(o, f);
  if (by) {
    statsFor(o, by.playerId).returns++;
    credit(world, by, CTF_SCORE.returned);
  }
  emitObjective(world, 'flagReturned', f.team, by ? by.playerId : 0, f.team, f.standX, f.standY, by ? 0 : 1);
}

/** Outward push of a shaken-off turret (px/s) — sim/turrets.ts DETACH_PUSH. */
const SHAKE_PUSH = 160;

/**
 * Detach `t` from `host` exactly as sim/turrets.ts detachTurret does (laser bank dropped, host velocity plus an
 * outward push, v0.5 hull re-size (sim/hull.ts, no cycle), 'detach' event). Not imported from turrets.ts: turrets.ts imports objectives/index, and that
 * cycle would make SIM's vi.mock seam (objhooks.test.ts) hand turrets.ts the real hooks.
 */
function shakeOff(world: World, host: Ship, t: Ship): void {
  t.attachedTo = 0;
  t.skillState.laserAcc = 0;
  t.skillState.laserTarget = 0;
  const idx = host.turrets.indexOf(t.id);
  if (idx >= 0) host.turrets.splice(idx, 1);
  let ax = Math.cos(t.angle), ay = Math.sin(t.angle);
  const dx = t.x - host.x, dy = t.y - host.y, d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1e-6) { ax = dx / d; ay = dy / d; }
  t.vx = host.vx + ax * SHAKE_PUSH;
  t.vy = host.vy + ay * SHAKE_PUSH;
  // v0.5 (as detachTurret): the turret's bubble hull and the carrier's capital hull re-size, mounts re-flow.
  syncHull(world, t);
  syncHull(world, host);
  emit(world, { t: 'detach', turretShipId: t.id, hostShipId: host.id });
}

/** A carrier keeps only the gunner seat (turret slot 0); extra turrets are shaken off (last slot first). */
function enforceGunnerSeat(world: World, carrier: Ship): void {
  let guard = 16;
  while (carrier.turrets.length > CTF_CARRIER_MAX_TURRETS && guard-- > 0) {
    const t = world.ships.get(carrier.turrets[carrier.turrets.length - 1]);
    if (!t || t.attachedTo !== carrier.id) { carrier.turrets.pop(); continue; }
    shakeOff(world, carrier, t);
  }
}

function pickupFlag(world: World, o: ObjectiveState, f: FlagObjective, s: Ship): void {
  const tick = world.tick;
  const fromHome = f.state === 'home';
  // A flag its own team's carrier released alive (class / team swap, leave) keeps that carry clock when the same
  // team re-takes it, so a swap never resets Flag Overload (ObjSide.keepCarry).
  const sd = objSide(o), keep = sd.keepCarry.get(f.team);
  sd.keepCarry.delete(f.team);
  f.state = 'carried';
  f.carrierId = s.id; f.carrierPlayerId = s.playerId;
  f.pickedAtTick = !fromHome && keep && keep.team === s.team ? keep.pickedAtTick : tick;
  f.droppedAtTick = 0;
  f.x = s.x; f.y = s.y;
  if (fromHome) {
    f.runners = [s.playerId];
    statsFor(o, s.playerId).steals++;
    credit(world, s, CTF_SCORE.steal);
  } else if (!f.runners.includes(s.playerId)) {
    f.runners.push(s.playerId);
  }
  // Picking up cancels spawn invulnerability.
  if (s.invulnUntilTick > tick) s.invulnUntilTick = tick;
  s.flags &= ~SHIPFLAG_INVULN;
  enforceGunnerSeat(world, s);
  s.flags = (s.flags | SHIPFLAG_CARRIER) & ~SHIPFLAG_CLOAKED;
  emitObjective(world, 'flagTaken', s.team, s.playerId, f.team, s.x, s.y, fromHome ? 1 : 0);
}

function capture(world: World, o: ObjectiveState, f: FlagObjective, c: Ship, own: FlagObjective): void {
  const T = c.team;
  o.teamPoints[T] = (o.teamPoints[T] ?? 0) + 1;
  o.mem.caps = (o.mem.caps ?? 0) + 1;
  statsFor(o, c.playerId).caps++;
  credit(world, c, CTF_SCORE.capture);
  // Assist: earlier runners of this steal, and teammates within CTF_ASSIST_RADIUS of the capture (+30 once each).
  const assist = new Set<number>();
  for (const pid of f.runners) {
    if (pid === c.playerId) continue;
    const s = shipOfPid(world, pid);
    if (s && s.team === T) assist.add(pid);
  }
  const r2 = CTF_ASSIST_RADIUS * CTF_ASSIST_RADIUS;
  for (const s of world.ships.values()) {
    if (s === c || !s.alive || s.team !== T) continue;
    if (d2(s.x, s.y, c.x, c.y) <= r2) assist.add(s.playerId);
  }
  for (const pid of assist) credit(world, shipOfPid(world, pid), CTF_SCORE.assist);
  rollLoot(world, 'flagCapture', own.standX, own.standY, { priorityPid: c.playerId });
  sendHome(o, f);
  c.flags &= ~SHIPFLAG_CARRIER;
  emitObjective(world, 'flagCaptured', T, c.playerId, f.team, own.standX, own.standY, o.teamPoints[T]);
}

/** Carrier kill (+25, carrierKill loot at the death spot) or defend kill (+5) for a hostile kill. */
function onShipDeath(world: World, o: ObjectiveState, e: Extract<GameEvent, { t: 'shipDeath' }>): void {
  if (world.match.phase !== 'playing' || !(e.killerPlayerId > 0)) return;
  const k = shipOfPid(world, e.killerPlayerId), v = world.ships.get(e.shipId);
  if (!k || !v || k === v || k.team < 0 || v.team < 0 || k.team === v.team) return;
  if (flagCarriedBy(o, v.id)) {
    statsFor(o, k.playerId).carrierKills++;
    credit(world, k, CTF_SCORE.carrierKill);
    rollLoot(world, 'carrierKill', e.x, e.y, { priorityPid: k.playerId });
    return;
  }
  const own = flagOf(o, k.team);
  if (!own) return;
  const r2 = CTF_DEFEND_RADIUS * CTF_DEFEND_RADIUS;
  if (d2(e.x, e.y, own.standX, own.standY) <= r2 || (own.state === 'dropped' && d2(e.x, e.y, own.x, own.y) <= r2)) {
    credit(world, k, CTF_SCORE.defendKill);
  }
}

export function stepCtf(world: World, o: ObjectiveState): void {
  const tick = world.tick;
  // 1. Kill credits first: a carrier killed this tick still holds its flag here.
  forFreshEvents(world, o, (e) => { if (e.t === 'shipDeath') onShipDeath(world, o, e); });

  // 2. Carrier validity (death / leave / turret / team swap → drop at the last position).
  const sd = objSide(o);
  for (const f of o.flags) {
    if (f.state !== 'carried') continue;
    const c = world.ships.get(f.carrierId);
    if (!c || !c.alive || c.attachedTo !== 0 || c.team < 0 || c.team === f.team) {
      sd.keepCarry.delete(f.team); // a death / forced drop starts the next carry fresh
      dropFlag(world, o, f, c ? c.x : f.x, c ? c.y : f.y, c);
    } else {
      f.x = c.x; f.y = c.y;
    }
  }

  // 3. Auto-return.
  const returnTicks = secToTicks(CTF_RETURN_SEC);
  for (const f of o.flags) {
    if (f.state === 'dropped' && tick - f.droppedAtTick >= returnTicks) returnFlag(world, o, f, undefined);
  }

  // 4. Captures: carrier within CTF_CAPTURE_RADIUS of its own stand while its own flag is home.
  const cr2 = CTF_CAPTURE_RADIUS * CTF_CAPTURE_RADIUS;
  if (world.match.phase === 'playing') {
    for (const f of o.flags) {
      if (f.state !== 'carried') continue;
      const c = world.ships.get(f.carrierId);
      if (!c) continue;
      const own = flagOf(o, c.team);
      if (own && own.state === 'home' && d2(c.x, c.y, own.standX, own.standY) <= cr2) capture(world, o, f, c, own);
    }
  }

  // 5. Touches: the nearest eligible alive, non-turret ship wins (ties: lower ship id).
  for (const f of o.flags) {
    if (f.state === 'carried') continue;
    let best: Ship | null = null, bestD = Infinity;
    for (const s of world.ships.values()) {
      if (!s.alive || s.attachedTo !== 0 || s.team < 0) continue;
      if (s.team === f.team) {
        if (f.state !== 'dropped') continue; // own flag: only a dropped one can be returned
      } else if (flagCarriedBy(o, s.id) || (sd.noPickup.get(s.id) ?? 0) > tick) {
        continue; // one enemy flag at a time; a just-released ship waits CTF_REPICK_SEC
      }
      const reach = s.stats.radius + CTF_PICKUP_PAD;
      const dd = d2(s.x, s.y, f.x, f.y);
      if (dd > reach * reach) continue;
      if (dd < bestD || (dd === bestD && best && s.id < best.id)) { best = s; bestD = dd; }
    }
    if (!best) continue;
    if (best.team === f.team) returnFlag(world, o, f, best);
    else if (world.match.phase === 'playing') pickupFlag(world, o, f, best);
  }

  // 6. Gunner seat + carrier flag bit (pass 3 recomputed ship.flags this tick; stepObjectives runs after it).
  //    A carrier is never cloaked: its position is public in the shared ObjectiveView (flag x / y, carrierId),
  //    so a cloak would leak anyway — no class cloaks today; this keeps it true if one ever does.
  for (const f of o.flags) {
    if (f.state !== 'carried') continue;
    const c = world.ships.get(f.carrierId);
    if (!c) continue;
    enforceGunnerSeat(world, c);
    c.flags = (c.flags | SHIPFLAG_CARRIER) & ~SHIPFLAG_CLOAKED;
  }
  if (sd.noPickup.size > 64) for (const [id, until] of sd.noPickup) if (until <= tick) sd.noPickup.delete(id);
}

/** Drop a carried flag at the ship's current position (respawn, class swap, team swap, leave). */
export function ctfRelease(world: World, o: ObjectiveState, ship: Ship): void {
  const f = flagCarriedBy(o, ship.id);
  if (!f) return;
  const sd = objSide(o);
  // Still alive (in-place class swap, team swap, leave): the team keeps this carry clock if it re-takes the flag
  // (keepCarry), and the ship itself can't instantly re-pick it (CTF_REPICK_SEC).
  if (ship.alive && ship.team >= 0) sd.keepCarry.set(f.team, { team: ship.team, pickedAtTick: f.pickedAtTick });
  else sd.keepCarry.delete(f.team);
  dropFlag(world, o, f, ship.x, ship.y, ship);
  if (ship.alive) sd.noPickup.set(ship.id, world.tick + secToTicks(CTF_REPICK_SEC));
}

export function ctfSpeedMult(o: ObjectiveState, ship: Ship): number {
  return flagCarriedBy(o, ship.id) ? CTF_CARRIER_SPEED_MULT : 1;
}

export function ctfRechargeMult(world: World, o: ObjectiveState, ship: Ship): number {
  const f = flagCarriedBy(o, ship.id);
  return f ? flagOverloadMult((world.tick - f.pickedAtTick) / secToTicks(1)) : 1;
}

/**
 * First to the limit. At time-out, most captures; a tie starts sudden death (+180 s, the next capture that
 * leaves one team on top wins); a sudden-death time-out is a draw.
 */
export function ctfEndCheck(world: World, o: ObjectiveState): 'continue' | 'ended' {
  const pts = o.teamPoints;
  if (o.limit > 0 && pts.some((v) => v >= o.limit)) {
    const t = uniqueTop(pts);
    if (t >= 0) return setWinner(world, t, mvpPid(world));
  }
  const caps = o.mem.caps ?? 0;
  if (o.suddenDeath && caps > (o.mem.sdCaps ?? 0)) {
    o.mem.sdCaps = caps;
    const t = uniqueTop(pts);
    if (t >= 0) return setWinner(world, t, mvpPid(world));
  }
  if (!timeUp(world)) return 'continue';
  const t = uniqueTop(pts);
  if (t >= 0) return setWinner(world, t, mvpPid(world));
  if (!o.suddenDeath) {
    o.suddenDeath = true;
    o.mem.sdCaps = caps;
    world.match.endTick = world.tick + secToTicks(CTF_SUDDEN_DEATH_SEC);
    emitObjective(world, 'suddenDeath', NO_TEAM, 0, 0, world.map.width / 2, world.map.height / 2, CTF_SUDDEN_DEATH_SEC);
    return 'continue';
  }
  return setWinner(world, NO_TEAM, mvpPid(world));
}
