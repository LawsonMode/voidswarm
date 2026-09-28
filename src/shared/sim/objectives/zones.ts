// OWNER: OBJECTIVES agent. Control Zones (docs/v0.3-proposal.md §5.4) and Hot Point (§5.5).
//
// Both share one capture machine per pad (stepZone). A "side" is a team in teams mode and a playerId in FFA
// Hot Point (owner / capTeam stay NO_TEAM there and ownerPlayerId / capPlayerId carry the side).
// - Presence: alive ships whose centre is inside the radius (turrets included). Bodies 1 / 2 / 3+ → ×1 / ×1.5 / ×2.
// - One side inside: an unowned pad fills toward it (8 s solo zones, 5 s hot); an enemy-owned pad is first
//   decapped to neutral at the same rate; the owner inside restores its pad; another side's partial progress
//   rolls back before the newcomer starts its own.
// - Two or more sides inside = contested: frozen. ≥ ZONE_SWARM_BLOCK enemies inside (Warzone) also freeze it.
// - Nobody inside for ZONE_DECAY_DELAY_SEC: partial progress decays at ZONE_DECAY_PER_SEC.
// - Zones: every owned pad gives its owner +1 point per ZONE_POINT_SEC of ownership, even while contested.
// - Hot: an owner that holds the point uncontested (inside, alone) gets +1 point per second.
// No world.rng anywhere: the next hot site and FFA spawn picks use Rng(hash32(…world state…, server salt)).
import { DT, NO_TEAM, TICK_RATE } from '../../constants';
import { ZONE_HOLD_ROLL_SEC } from '../../data/loot';
import type { GameMap, MapFeature, ObjectiveState, PlayerId, Ship, World, ZoneObjective } from '../../types';
import { hash32 } from '../../util/hash';
import { Rng } from '../../util/rng';
import { rollLoot } from '../loot';
import { forEachEnemyNear, secToTicks } from '../world';
import {
  credit, emitObjective, isFfa, mvpPid, objSide, setWinner, shipOfPid, statsFor, timeUp, uniqueTop,
} from './common';
import {
  HOT_ARM_SEC, HOT_CAP_SEC, HOT_FFA_SPAWN_AVOID, HOT_MIN_MOVE_DIST, HOT_MOVE_SEC, HOT_OT_CAP_SEC, HOT_OT_GRACE_SEC,
  HOT_SCORE, HOT_WARN_SEC, ZONE_BODY_MULT, ZONE_CAP_SEC, ZONE_CONTRIB_SEC, ZONE_DECAY_DELAY_SEC, ZONE_DECAY_PER_SEC,
  ZONE_POINT_SEC, ZONE_SCORE, ZONE_SWARM_BLOCK, ZONE_TIE_EXTEND_SEC, ZONE_TIE_EXTENSIONS,
} from './rules';

/** Float slack for progress sums (480 steps of 1/480 must reach 1 on the 480th tick). */
const EPS = 1e-9;

function noneSide(ffa: boolean): number {
  return ffa ? 0 : NO_TEAM;
}
function sideOf(s: Ship, ffa: boolean): number {
  return ffa ? s.playerId : s.team;
}
export function ownerSide(z: ZoneObjective, ffa: boolean): number {
  return ffa ? z.ownerPlayerId : z.owner;
}
export function capSide(z: ZoneObjective, ffa: boolean): number {
  return ffa ? z.capPlayerId : z.capTeam;
}
function setOwner(z: ZoneObjective, ffa: boolean, side: number, pid: PlayerId): void {
  if (ffa) { z.owner = NO_TEAM; z.ownerPlayerId = side > 0 ? side : 0; }
  else { z.owner = side; z.ownerPlayerId = side >= 0 ? pid : 0; }
}
function setCap(z: ZoneObjective, ffa: boolean, side: number, pid: PlayerId): void {
  if (ffa) { z.capTeam = NO_TEAM; z.capPlayerId = side > 0 ? side : 0; }
  else { z.capTeam = side; z.capPlayerId = side >= 0 ? pid : 0; }
}

function newZone(f: MapFeature, active: boolean, tick: number): ZoneObjective {
  return {
    index: f.index, x: f.x, y: f.y, radius: f.radius,
    owner: NO_TEAM, ownerPlayerId: 0, capTeam: NO_TEAM, capPlayerId: 0, progress: 0,
    contested: false, swarm: 0, active, lastPresenceTick: tick, heldSinceTick: 0,
  };
}

function resetSlots(world: World, o: ObjectiveState): void {
  const sd = objSide(o), none = noneSide(isFfa(world));
  sd.present = o.zones.map(() => new Map());
  sd.work = o.zones.map(() => new Map());
  sd.flippedFrom = o.zones.map(() => none);
}

/** map.features hotSite entries, by index. */
export function hotSiteFeatures(map: GameMap): MapFeature[] {
  return (map.features ?? []).filter((f) => f.kind === 'hotSite').sort((a, b) => a.index - b.index);
}

export function initZones(world: World, o: ObjectiveState): void {
  const pads = (world.map.features ?? []).filter((f) => f.kind === 'zone').sort((a, b) => a.index - b.index);
  for (const f of pads) o.zones.push(newZone(f, true, world.tick));
  resetSlots(world, o);
}

export function initHot(world: World, o: ObjectiveState): void {
  const sites = hotSiteFeatures(world.map);
  o.mem.hotCapped = 0; o.mem.hotAcc = 0; o.mem.hotBusy = 0; o.mem.hotBusyTick = -1;
  if (sites.length === 0) { o.hot = null; resetSlots(world, o); return; }
  const s0 = sites[0];
  const t = world.tick;
  o.zones.push(newZone(s0, true, t));
  o.hot = {
    site: s0.index, nextSite: -1,
    moveTick: t + secToTicks(HOT_MOVE_SEC), warnTick: t + secToTicks(HOT_MOVE_SEC - HOT_WARN_SEC),
    armTick: t, moves: 0, recent: [],
  };
  resetSlots(world, o);
}

// ---------------------------------------------------------------------------------------------
// The capture machine
// ---------------------------------------------------------------------------------------------

const counts = new Map<number, number>();
const inside: Ship[] = [];

/** The inside ship of `side` that has worked the pad longest (ties: lower playerId). FFA: the side itself. */
function leadPid(k: number, o: ObjectiveState, side: number, ffa: boolean): PlayerId {
  if (ffa) return side;
  const work = objSide(o).work[k];
  let best: PlayerId = 0, bestW = -1;
  for (const s of inside) {
    if (s.team !== side) continue;
    const w = work.get(s.playerId) ?? 0;
    if (w > bestW || (w === bestW && s.playerId < best)) { best = s.playerId; bestW = w; }
  }
  return best;
}

/** Pilots of `side` who were inside within ZONE_CONTRIB_SEC (and still fly for that side). */
function contributors(world: World, o: ObjectiveState, k: number, side: number, ffa: boolean): Ship[] {
  const out: Ship[] = [];
  const since = world.tick - secToTicks(ZONE_CONTRIB_SEC);
  for (const [pid, t] of objSide(o).present[k]) {
    if (t < since) continue;
    const s = shipOfPid(world, pid);
    if (s && sideOf(s, ffa) === side) out.push(s);
  }
  return out;
}

function topContributor(o: ObjectiveState, k: number, ships: Ship[]): PlayerId {
  const work = objSide(o).work[k];
  let best: PlayerId = 0, bestW = -1;
  for (const s of ships) {
    const w = work.get(s.playerId) ?? 0;
    if (w > bestW || (w === bestW && s.playerId < best)) { best = s.playerId; bestW = w; }
  }
  return best;
}

function addPoint(o: ObjectiveState, ffa: boolean, side: number, n: number): void {
  if (ffa) { if (side > 0) o.playerPoints.set(side, (o.playerPoints.get(side) ?? 0) + n); }
  else if (side >= 0 && side < o.teamPoints.length) o.teamPoints[side] += n;
}

/** Progress reached 1: neutralize an owned pad, else capture it. */
function flip(world: World, o: ObjectiveState, k: number, z: ZoneObjective, side: number, hot: boolean): void {
  const ffa = isFfa(world), none = noneSide(ffa), sd = objSide(o);
  const own = ownerSide(z, ffa);
  const capPid = ffa ? side : z.capPlayerId;
  const contrib = contributors(world, o, k, side, ffa);
  if (own !== none) {
    sd.flippedFrom[k] = own;
    setOwner(z, ffa, none, 0);
    z.progress = 0;
    z.heldSinceTick = 0;
    for (const s of contrib) {
      statsFor(o, s.playerId).neutralizes++;
      if (!hot) credit(world, s, ZONE_SCORE.neutralize);
    }
    if (hot) o.mem.hotAcc = 0;
    emitObjective(world, 'zoneNeutralized', ffa ? NO_TEAM : side, capPid, z.index, z.x, z.y, own);
    return; // the flipping side keeps capping from neutral (capTeam stays)
  }
  const from = sd.flippedFrom[k];
  setOwner(z, ffa, side, capPid);
  setCap(z, ffa, none, 0);
  z.progress = 0;
  z.heldSinceTick = world.tick;
  for (const s of contrib) {
    statsFor(o, s.playerId).zoneCaps++;
    credit(world, s, hot ? HOT_SCORE.capture : ZONE_SCORE.capture);
  }
  emitObjective(world, 'zoneCaptured', ffa ? NO_TEAM : side, capPid, z.index, z.x, z.y, from);
  if (hot) {
    o.mem.hotAcc = 0;
    if (!o.mem.hotCapped) {
      o.mem.hotCapped = 1;
      rollLoot(world, 'hotFirstCap', z.x, z.y, { priorityPid: capPid });
    }
  } else if (from !== none && from !== side) {
    // §6.3 zoneCapture: a pad flipped from an enemy (top contributor gets the priority window).
    rollLoot(world, 'zoneCapture', z.x, z.y, { priorityPid: topContributor(o, k, contrib) });
  }
  sd.flippedFrom[k] = none;
  sd.work[k].clear();
}

function stepZone(world: World, o: ObjectiveState, k: number, hot: boolean): void {
  const z = o.zones[k];
  const ffa = isFfa(world), none = noneSide(ffa), tick = world.tick;
  const playing = world.match.phase === 'playing';
  if (!z.active) {
    z.contested = false; z.swarm = 0;
    if (hot) o.mem.hotBusy = 0;
    return;
  }
  const sd = objSide(o);
  counts.clear();
  inside.length = 0;
  const r2 = z.radius * z.radius, nTeams = o.teamPoints.length;
  for (const s of world.ships.values()) {
    if (!s.alive) continue;
    const side = sideOf(s, ffa);
    if (ffa ? !(side > 0) : !(side >= 0 && side < nTeams)) continue;
    const dx = s.x - z.x, dy = s.y - z.y;
    if (dx * dx + dy * dy > r2) continue;
    inside.push(s);
    counts.set(side, (counts.get(side) ?? 0) + 1);
  }
  let swarm = 0;
  forEachEnemyNear(world, z.x, z.y, z.radius, (e) => {
    const dx = e.x - z.x, dy = e.y - z.y;
    if (dx * dx + dy * dy <= r2) swarm++;
  });
  z.swarm = swarm;
  const nSides = counts.size;
  z.contested = nSides >= 2;
  const blocked = swarm >= ZONE_SWARM_BLOCK;
  const own = ownerSide(z, ffa);
  if (nSides > 0) z.lastPresenceTick = tick;

  // Presence bookkeeping + "working the zone" (+1 per workTickSec inside: objTicks; hot hold: hotHoldTicks).
  const present = sd.present[k], work = sd.work[k];
  const workTicks = secToTicks(hot ? HOT_SCORE.workTickSec : ZONE_SCORE.workTickSec);
  for (const s of inside) {
    present.set(s.playerId, tick);
    work.set(s.playerId, (work.get(s.playerId) ?? 0) + 1);
    if (!playing) continue;
    const st = statsFor(o, s.playerId);
    st.objTicks++;
    if (st.objTicks % workTicks === 0) credit(world, s, 1);
    if (hot && own !== none && sideOf(s, ffa) === own) st.hotHoldTicks++;
  }

  // Capture progress.
  const capSec = hot ? HOT_CAP_SEC : ZONE_CAP_SEC;
  if (nSides === 0) {
    if (tick - z.lastPresenceTick >= secToTicks(ZONE_DECAY_DELAY_SEC)) {
      if (z.progress > 0) z.progress -= ZONE_DECAY_PER_SEC * DT;
      if (z.progress <= EPS) { z.progress = 0; if (capSide(z, ffa) !== none) setCap(z, ffa, none, 0); }
    }
  } else if (nSides === 1 && !blocked && playing) {
    const [side, n] = counts.entries().next().value as [number, number];
    const mult = ZONE_BODY_MULT[Math.min(n, ZONE_BODY_MULT.length - 1)];
    const step = (mult / capSec) * DT;
    const cap = capSide(z, ffa);
    if (side === own || (cap !== none && cap !== side && z.progress > 0)) {
      // The owner restores its pad; another side's partial progress rolls back before this side starts.
      if (z.progress > 0) {
        z.progress -= step;
        if (z.progress <= EPS) { z.progress = 0; setCap(z, ffa, none, 0); }
      }
    } else {
      setCap(z, ffa, side, leadPid(k, o, side, ffa));
      z.progress += step;
      if (z.progress >= 1 - EPS) flip(world, o, k, z, side, hot);
    }
  }

  if (!playing) return;
  if (hot) {
    const holder = ownerSide(z, ffa);
    if (holder !== none && nSides === 1 && counts.has(holder)) {
      o.mem.hotAcc = (o.mem.hotAcc ?? 0) + 1;
      if (o.mem.hotAcc % TICK_RATE === 0) addPoint(o, ffa, holder, 1);
    }
    // Overtime condition (§5.5): contested, or a non-owner inside (capping / decapping).
    let busy = nSides >= 2;
    if (nSides === 1 && !counts.has(holder)) busy = true;
    o.mem.hotBusy = busy ? 1 : 0;
    if (busy) o.mem.hotBusyTick = tick;
  } else if (z.owner >= 0) {
    const held = tick - z.heldSinceTick;
    if (held > 0 && held % secToTicks(ZONE_POINT_SEC) === 0) addPoint(o, false, z.owner, 1);
    if (held > 0 && held % secToTicks(ZONE_HOLD_ROLL_SEC) === 0) {
      rollLoot(world, 'zoneHold', z.x, z.y, { priorityPid: z.ownerPlayerId });
    }
  }
}

export function stepZones(world: World, o: ObjectiveState): void {
  for (let k = 0; k < o.zones.length; k++) stepZone(world, o, k, false);
}

// ---------------------------------------------------------------------------------------------
// Hot Point relocation
// ---------------------------------------------------------------------------------------------

/**
 * The next site (§5.5): ≥ HOT_MIN_MOVE_DIST from the current one and not one of the last 2; if none qualifies,
 * the farthest non-recent site. Seeded from world state (mapSeed, moves, site) — never world.rng.
 */
export function pickNextSite(world: World, o: ObjectiveState): number {
  const h = o.hot!;
  const sites = hotSiteFeatures(world.map);
  const cur = sites.find((s) => s.index === h.site);
  const others = sites.filter((s) => s.index !== h.site);
  if (others.length === 0) return h.site;
  const fresh = others.filter((s) => !h.recent.includes(s.index));
  const pool0 = fresh.length ? fresh : others;
  const dd = (s: MapFeature) => (cur ? (s.x - cur.x) ** 2 + (s.y - cur.y) ** 2 : 0);
  let pool = pool0.filter((s) => dd(s) >= HOT_MIN_MOVE_DIST * HOT_MIN_MOVE_DIST);
  if (pool.length === 0) {
    let far = -1;
    for (const s of pool0) far = Math.max(far, dd(s));
    pool = pool0.filter((s) => dd(s) === far);
  }
  const rng = new Rng(hash32(world.config.mapSeed | 0, serverSalt(world), 0x407b0a7, h.moves, h.site));
  return rng.pick(pool).index;
}

/**
 * Server-only salt for the hot-point hashes: SimConfig.lootSeed is never sent to clients (Room draws it from a
 * CSPRNG), so a modified client can't precompute the relocation order from mapSeed and defeat the T−10 s warning.
 * Hashing it consumes neither lootRng nor world.rng, so determinism (and every golden digest) is unaffected.
 */
function serverSalt(world: World): number {
  return (world.config.lootSeed ?? 0) | 0;
}

function relocate(world: World, o: ObjectiveState): void {
  const h = o.hot!, z = o.zones[0], ffa = isFfa(world), tick = world.tick, sd = objSide(o);
  if (h.nextSite < 0) h.nextSite = pickNextSite(world, o);
  const f = hotSiteFeatures(world.map).find((s) => s.index === h.nextSite);
  h.moveTick = tick + secToTicks(HOT_MOVE_SEC);
  h.warnTick = h.moveTick - secToTicks(HOT_WARN_SEC);
  if (!f || f.index === h.site) { h.nextSite = -1; return; }
  // §6.3 hotHold: the holder at relocation, at the old site.
  if (ownerSide(z, ffa) !== noneSide(ffa)) rollLoot(world, 'hotHold', z.x, z.y, { priorityPid: z.ownerPlayerId });
  h.recent = [h.site, ...h.recent].slice(0, 2);
  h.site = f.index;
  h.nextSite = -1;
  h.moves++;
  h.armTick = tick + secToTicks(HOT_ARM_SEC);
  Object.assign(z, newZone(f, false, tick));
  o.mem.hotCapped = 0; o.mem.hotAcc = 0; o.mem.hotBusy = 0;
  sd.present[0]?.clear(); sd.work[0]?.clear();
  sd.flippedFrom[0] = noneSide(ffa);
  emitObjective(world, 'hotMoved', NO_TEAM, 0, f.index, f.x, f.y, h.moves);
}

export function stepHot(world: World, o: ObjectiveState): void {
  const h = o.hot;
  if (!h || o.zones.length === 0) return;
  const tick = world.tick;
  // Relocation pauses during overtime (the fight on the current point decides it), and a move due at or after
  // the time-out never happens: every selectable length is a multiple of HOT_MOVE_SEC, so the last move would
  // land exactly on match.endTick, reset the point to neutral and make overtime (§5.5) unreachable. The final
  // point therefore stays put — no T−10 s warning, no move, no hotHold roll on the last tick.
  const endTick = world.match.endTick;
  const lastPoint = endTick > 0 && h.moveTick >= endTick;
  if (!o.overtime && !lastPoint && world.match.phase === 'playing') {
    if (h.nextSite < 0 && tick >= h.warnTick && tick < h.moveTick) {
      h.nextSite = pickNextSite(world, o);
      const f = hotSiteFeatures(world.map).find((s) => s.index === h.nextSite);
      if (f) emitObjective(world, 'hotWarn', NO_TEAM, 0, f.index, f.x, f.y, Math.ceil((h.moveTick - tick) / TICK_RATE));
    }
    if (tick >= h.moveTick) relocate(world, o);
  }
  o.zones[0].active = tick >= h.armTick;
  stepZone(world, o, 0, true);
}

/** FFA Hot Point respawns avoid spawn points within HOT_FFA_SPAWN_AVOID of the active site (§5.5). */
export function hotSpawnPoint(world: World, o: ObjectiveState, ship: Ship): { x: number; y: number } | null {
  if (!isFfa(world) || o.zones.length === 0) return null;
  const z = o.zones[0], avoid2 = HOT_FFA_SPAWN_AVOID * HOT_FFA_SPAWN_AVOID;
  const pts = world.map.spawns.filter((p) => (p.x - z.x) ** 2 + (p.y - z.y) ** 2 > avoid2);
  if (pts.length === 0) return null;
  const rng = new Rng(hash32(world.config.mapSeed | 0, serverSalt(world), world.tick, ship.id, 0x5a77));
  const picks = Math.min(pts.length, 5);
  let best = pts[0], bestScore = -1;
  for (let i = 0; i < picks; i++) {
    const p = pts[rng.int(0, pts.length - 1)];
    let minD = Infinity;
    for (const s of world.ships.values()) {
      if (s === ship || !s.alive) continue;
      minD = Math.min(minD, (s.x - p.x) ** 2 + (s.y - p.y) ** 2);
    }
    if (minD > bestScore) { bestScore = minD; best = p; }
  }
  return { x: best.x, y: best.y };
}

// ---------------------------------------------------------------------------------------------
// End checks
// ---------------------------------------------------------------------------------------------

/** Reach the limit. At time-out, most points; a tie adds ZONE_TIE_EXTEND_SEC up to 3 times, then a draw. */
export function zonesEndCheck(world: World, o: ObjectiveState): 'continue' | 'ended' {
  const pts = o.teamPoints;
  if (o.limit > 0 && pts.some((v) => v >= o.limit)) {
    const t = uniqueTop(pts);
    if (t >= 0) return setWinner(world, t, mvpPid(world));
  }
  if (!timeUp(world)) return 'continue';
  const t = uniqueTop(pts);
  if (t >= 0) return setWinner(world, t, mvpPid(world));
  if (o.extensions < ZONE_TIE_EXTENSIONS) {
    o.extensions++;
    o.overtime = true;
    world.match.endTick = world.tick + secToTicks(ZONE_TIE_EXTEND_SEC);
    emitObjective(world, 'overtime', NO_TEAM, 0, o.extensions, world.map.width / 2, world.map.height / 2, ZONE_TIE_EXTEND_SEC);
    return 'continue';
  }
  return setWinner(world, NO_TEAM, mvpPid(world));
}

/** FFA: the unique top playerPoints, then ship.score among the tied, else 0 (draw). */
function ffaHotWinner(world: World, o: ObjectiveState): PlayerId {
  const pts = new Map<PlayerId, number>(o.playerPoints);
  for (const s of world.ships.values()) if (!pts.has(s.playerId)) pts.set(s.playerId, 0);
  let best = -Infinity;
  for (const v of pts.values()) best = Math.max(best, v);
  const tied: PlayerId[] = [];
  for (const [pid, v] of pts) if (v === best) tied.push(pid);
  if (tied.length === 1) return tied[0];
  const scores = tied.map((pid) => shipOfPid(world, pid)?.score ?? -Infinity);
  const i = uniqueTop(scores);
  return i >= 0 ? tied[i] : 0;
}

function ffaLeader(o: ObjectiveState): { pid: PlayerId; pts: number; unique: boolean } {
  let pid = 0, pts = -Infinity, unique = false;
  for (const [p, v] of o.playerPoints) {
    if (v > pts) { pid = p; pts = v; unique = true; }
    else if (v === pts) unique = false;
  }
  return { pid, pts, unique };
}

/**
 * Reach the limit. At time-out, if the point is contested or a non-owner is capping, overtime runs until
 * HOT_OT_GRACE_SEC after that stops (cap HOT_OT_CAP_SEC). Then most points wins; a tie is a draw
 * (FFA: ship.score breaks it first).
 */
export function hotEndCheck(world: World, o: ObjectiveState): 'continue' | 'ended' {
  const ffa = isFfa(world), tick = world.tick;
  if (o.limit > 0) {
    if (ffa) {
      const L = ffaLeader(o);
      if (L.unique && L.pts >= o.limit) return setWinner(world, NO_TEAM, L.pid);
    } else if (o.teamPoints.some((v) => v >= o.limit)) {
      const t = uniqueTop(o.teamPoints);
      if (t >= 0) return setWinner(world, t, mvpPid(world));
    }
  }
  if (!o.overtime) {
    if (!timeUp(world)) return 'continue';
    if (o.mem.hotBusy) {
      o.overtime = true;
      o.overtimeCapTick = tick + secToTicks(HOT_OT_CAP_SEC);
      const z = o.zones[0];
      emitObjective(world, 'overtime', NO_TEAM, 0, 0, z ? z.x : 0, z ? z.y : 0, HOT_OT_CAP_SEC);
      return 'continue';
    }
  } else {
    const quiet = tick - (o.mem.hotBusyTick ?? tick) >= secToTicks(HOT_OT_GRACE_SEC);
    if (!quiet && tick < o.overtimeCapTick) return 'continue';
  }
  if (ffa) return setWinner(world, NO_TEAM, ffaHotWinner(world, o));
  return setWinner(world, uniqueTop(o.teamPoints), mvpPid(world));
}
