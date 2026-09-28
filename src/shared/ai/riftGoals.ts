// OWNER: AI agent. Rift (Dungeon Runner, co-op) goals for bots (docs/v0.3-proposal.md §4.9).
//
// riftGoal() reads world.dungeon (RiftState), world.map.dungeon (RiftLayout) and ship positions and returns the
// bot's rift goal (or null). bots.ts joins it into decide() as mode 'rift' via consider(), the way objective goals
// join: fights, farming and gems still win when they score higher. Nothing here draws randomness (the brain's Rng
// jitters hold points), so a goal never consumes world.rng. The only state is RiftMem, owned by the brain (the
// leader's regroup wait and the chest give-up timer).
//
// Priorities (§4.9, evaluated before roaming):
//  1. Inside an ARMING or SEALED room: fight there (fallback goal: hold near the room centre; bots.ts farms the
//     room's enemies with a bonus and kites inside the room when low — the doors are walls).
//  2. Follow the leader: the lowest-playerId alive, free human of the party. Stay 200–450 px behind (spread per bot),
//     afterburn past 1000 px. A follow point never lies inside a dormant sealable room (a bot never trips a seal the
//     human didn't), and while a human is alive bots keep out of the open Descend zone (they never trigger a descent).
//  3. A human of the party is down but respawning: regroup at the party anchor (its respawn point).
//  4. No alive human: bot-only progression. Open chests in the (cleared) room you're in (nearest bot; given up after
//     RIFT_CHEST_GIVEUP_SEC), go to the portal once it is open, else the lowest-playerId free bot leads to the
//     lowest-depth main-path room that isn't CLEARED; before entering it the leader waits (≤ RIFT_WAIT_MAX_SEC)
//     until the group is within RIFT_GROUP_R.
//     The others follow the leader bot (150–350 px). Treasure branches are skipped (no humans to loot them).
// Bots never extract or pick up loot (the sim only lets humans do either). Retreat home = the party anchor
// (riftRetreatPoint); inside a sealed room it is a kite point inside the room.
import { TICK_RATE } from '../constants';
import { SHIP_CLASS_IDS } from '../data/ships';
import { RIFT_PORTAL_R as SIM_PORTAL_R, isSealableKind } from '../sim/dungeonRules';
import { isSolidAt, lineOfSight } from '../sim/map';
import { sameTeam } from '../sim/world';
import {
  RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED,
  type RiftDoor, type RiftLayout, type RiftRoom, type RiftState, type Ship, type ShipClassId, type World,
} from '../types';

export type RiftGoalKind = 'fight' | 'stage' | 'follow' | 'regroup' | 'wait' | 'advance' | 'chest' | 'portal' | 'idle';

export interface RiftGoal {
  kind: RiftGoalKind;
  x: number; y: number;
  /** Utility score for consider('rift', score). */
  score: number;
  /** Stay inside holdR of (x, y) (the brain jitters its hold point inside it) instead of arriving and moving on. */
  hold: boolean;
  holdR: number;
  /** Room index the bot is in (-1 = corridor). */
  room: number;
  /** The ARMING / SEALED room the bot is inside (fight there; retreat inside it), else -1. */
  sealedRoom: number;
  /** Afterburn toward the goal (following a leader > RIFT_BURN_PX away). */
  burn: boolean;
  /** Keep out of this circle (the open Descend zone while a human is alive). r = 0: none. */
  avoidX: number; avoidY: number; avoidR: number;
}

/** Per-brain rift memory (the leader's regroup wait, the chest give-up timer). Reset on a floor change. */
export interface RiftMem {
  /** Tick the leader started waiting for the group before `waitRoom` (-1 = not waiting). */
  waitSince: number;
  waitRoom: number;
  stageX: number; stageY: number;
  /** Frontier room the leader already waited for (it doesn't wait twice for one room). */
  waitedRoom: number;
  /** Chest being opened (room · 16 + chest, -1 = none), since when, and chests given up on (unreachable). */
  chestKey: number;
  chestSince: number;
  skipChests: number[];
}

export function newRiftMem(): RiftMem {
  return { waitSince: -1, waitRoom: -1, stageX: 0, stageY: 0, waitedRoom: -1, chestKey: -1, chestSince: 0, skipChests: [] };
}

// ---- §4.9 tuning ----
export const RIFT_SCORE = {
  /** Sealed-room fallback (hold near the centre): any enemy in the room outscores it. */
  fight: 0.35,
  /** Outside a sealed room the party is in: wait by its door. */
  stage: 0.55,
  /** Following, within the band: low, so farming and gems nearby still win. */
  followNear: 0.3,
  /** Following, beyond the band: base + up to followFarMax more with distance (beats farming past ~1000 px). */
  followFar: 0.45, followFarMax: 0.6,
  regroup: 0.5,
  wait: 0.45,
  advance: 0.45,
  chest: 0.62,
  portal: 0.72,
  idle: 0.3,
} as const;
/** Follow band behind a human leader (px): §4.9 "stay 200–450 px behind". */
export const FOLLOW_NEAR_PX = 200;
export const FOLLOW_FAR_PX = 450;
/** Follow band behind the leader bot (tighter: bots move as a pack). */
export const FOLLOW_BOT_NEAR_PX = 150;
export const FOLLOW_BOT_FAR_PX = 350;
/** Afterburn toward the leader past this (px). */
export const RIFT_BURN_PX = 1000;
/** Leader bot: waits for the group when within this distance (px) of the frontier room... */
export const RIFT_WAIT_NEAR_PX = 520;
/** ...while another free, alive member is farther than this from it (px)... */
export const RIFT_GROUP_R = 650;
/** ...for at most this long (s). */
export const RIFT_WAIT_MAX_SEC = 5;
/** Bots open a chest in their room when it is this close (px)... */
export const RIFT_CHEST_PX = 900;
/** ...and give up on one they haven't reached in this long (s; blocked by a wedge or a pillar). */
export const RIFT_CHEST_GIVEUP_SEC = 10;
/** Descend zone radius (§4.7; sim/dungeonRules) and the keep-out margin bots add while a human is alive. */
export const RIFT_PORTAL_R = SIM_PORTAL_R;
export const RIFT_PORTAL_KEEPOUT = 60;
/** Speed (px/s) above which "behind" follows the leader's velocity instead of its facing. */
const HEADING_MIN_SPEED = 60;
/** Lateral spread of follow points per follower slot (rad off straight behind). */
const FOLLOW_SPREAD = [0, 0.65, -0.65, 1.2, -1.2, 1.6, -1.6];

const isOut = (s: Ship): boolean => !!(s.skillState.rOut || s.skillState.rWait);
/** Alive, not a turret, not extracted / out of lives. */
const isFree = (s: Ship): boolean => s.alive && s.attachedTo === 0 && !isOut(s);

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** Interior rect of a room in px, inset by `inset` tiles. */
function rectOf(room: RiftRoom, ts: number, inset = 0): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: (room.c0 + inset) * ts, y0: (room.r0 + inset) * ts, x1: (room.c1 - inset) * ts, y1: (room.r1 - inset) * ts };
}

export function inRoomRect(room: RiftRoom, ts: number, x: number, y: number, inset = 0): boolean {
  const r = rectOf(room, ts, inset);
  return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
}

/** Room index whose interior holds (x, y), or -1 (corridor / rock). Same rect rule as floorgen.roomAt. */
export function riftRoomIndexAt(layout: RiftLayout, ts: number, x: number, y: number): number {
  for (const r of layout.rooms) if (inRoomRect(r, ts, x, y)) return r.idx;
  return -1;
}

/** Distance (px) from (x, y) to a room's interior rect (0 inside). */
function distToRoom(room: RiftRoom, ts: number, x: number, y: number): number {
  const r = rectOf(room, ts);
  const dx = Math.max(r.x0 - x, 0, x - r.x1), dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

const halfSize = (room: RiftRoom, ts: number): number => Math.min(room.c1 - room.c0, room.r1 - room.r0) * ts * 0.5;
const sealable = (room: RiftRoom): boolean => isSealableKind(room.kind);

/** A point just outside a door (the mirror of its in-point across the door tiles). */
export function doorOutside(world: World, door: RiftDoor): { x: number; y: number } {
  const m = world.map, ts = m.tileSize;
  let sx = 0, sy = 0;
  for (const t of door.tiles) { sx += ((t % m.cols) + 0.5) * ts; sy += (Math.floor(t / m.cols) + 0.5) * ts; }
  const n = Math.max(1, door.tiles.length);
  const cx = door.tiles.length ? sx / n : door.inX, cy = door.tiles.length ? sy / n : door.inY;
  let ox = cx - door.inX, oy = cy - door.inY;
  const l = Math.hypot(ox, oy);
  if (l < 1) return { x: cx, y: cy };
  ox /= l; oy /= l;
  // 3.5 tiles past the door gap, stepping back toward it if that lands in rock
  for (const k of [3.5, 2.5, 1.5]) {
    const x = cx + ox * ts * k, y = cy + oy * ts * k;
    if (!isSolidAt(m, x, y)) return { x, y };
  }
  return { x: cx, y: cy };
}

/** The door of `room` whose outside point is nearest (x, y); null for a room without doors. */
function nearestDoorOutside(world: World, room: RiftRoom, x: number, y: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null, bd = Infinity;
  for (const d of room.doors) {
    const p = doorOutside(world, d);
    const dd = Math.hypot(p.x - x, p.y - y);
    if (dd < bd) { bd = dd; best = p; }
  }
  return best;
}

/** Point inside a dormant (not yet triggered) sealable room — a bot standing there could trip its seal. */
function inDormantSealable(world: World, layout: RiftLayout, st: RiftState, x: number, y: number): number {
  const ts = world.map.tileSize;
  for (const r of layout.rooms) {
    if (!sealable(r) || (st.rooms[r.idx]?.state ?? RIFT_DORMANT) !== RIFT_DORMANT) continue;
    if (inRoomRect(r, ts, x, y, -1)) return r.idx;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------------------------

/** §4.9 leader: the lowest-playerId alive, free human of the team (null if none). */
export function riftLeader(world: World, team: number): Ship | null {
  let best: Ship | null = null;
  for (const s of world.ships.values()) {
    if (s.isBot || !sameTeam(s.team, team) || !isFree(s)) continue;
    if (!best || s.playerId < best.playerId) best = s;
  }
  return best;
}

/** The lowest-playerId alive, free bot of the team (the bot-only party's pathfinder). */
export function riftBotLeader(world: World, team: number): Ship | null {
  let best: Ship | null = null;
  for (const s of world.ships.values()) {
    if (!s.isBot || !sameTeam(s.team, team) || !isFree(s)) continue;
    if (!best || s.playerId < best.playerId) best = s;
  }
  return best;
}

/** A human of the team is down but will respawn (not extracted, not out of lives). */
function humanRespawning(world: World, team: number): boolean {
  for (const s of world.ships.values()) {
    if (!s.isBot && sameTeam(s.team, team) && !s.alive && !isOut(s) && Number.isFinite(s.respawnTick) &&
        s.respawnTick < Number.MAX_SAFE_INTEGER) return true;
  }
  return false;
}

/** §4.9 rule 3: the lowest-depth main-path room (not an entrance) that isn't CLEARED, or -1. */
export function riftFrontier(layout: RiftLayout, st: RiftState): number {
  let best = -1, bd = Infinity;
  for (const r of layout.rooms) {
    if (!r.mainPath || r.kind === 'entrance') continue;
    if ((st.rooms[r.idx]?.state ?? RIFT_DORMANT) === RIFT_CLEARED) continue;
    if (r.depth < bd || (r.depth === bd && r.idx < best)) { bd = r.depth; best = r.idx; }
  }
  return best;
}

/** Party anchor (respawn point): the party's, else the first entrance's centre. */
export function riftAnchor(world: World, team: number): { x: number; y: number } {
  const st = world.dungeon, L = world.map.dungeon;
  const p = st?.parties[team] ?? st?.parties[0];
  if (p && Number.isFinite(p.anchorX) && Number.isFinite(p.anchorY)) return { x: p.anchorX, y: p.anchorY };
  const e = L ? L.rooms[L.entrances[0] ?? 0] : undefined;
  return e ? { x: e.x, y: e.y } : { x: world.map.width / 2, y: world.map.height / 2 };
}

/** Index of `me` among the team's free bots sorted by playerId, skipping `skip` (follow-point spread). */
function followerSlot(world: World, me: Ship, skip: Ship): number {
  let slot = 0;
  for (const s of world.ships.values()) {
    if (s.id === me.id || s.id === skip.id || !s.isBot || !sameTeam(s.team, me.team) || !isFree(s)) continue;
    if (s.playerId < me.playerId) slot++;
  }
  return slot;
}

/** Chest k of `room` is unopened and openable: treasure chests any time, reward / key chests once CLEARED (§4.3). */
function openableChest(room: RiftRoom, st: RiftState, k: number): boolean {
  const run = st.rooms[room.idx];
  if (!run || (run.chests & (1 << k))) return false;
  return room.kind === 'treasure' || run.state === RIFT_CLEARED;
}

// ---------------------------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------------------------

function goal(kind: RiftGoalKind, x: number, y: number, score: number, room: number, hold = false, holdR = 0): RiftGoal {
  return { kind, x, y, score, hold, holdR, room, sealedRoom: -1, burn: false, avoidX: 0, avoidY: 0, avoidR: 0 };
}

/**
 * Follow point behind `leader`: `mid` px behind its heading, spread by slot. Falls back to the point on the line
 * leader → me when that spot is solid, out of the leader's sight, or inside a dormant sealable room.
 */
function followPoint(world: World, me: Ship, leader: Ship, slot: number, mid: number): { x: number; y: number } {
  const L = world.map.dungeon!, st = world.dungeon!;
  const sp = Math.hypot(leader.vx, leader.vy);
  const hx = sp > HEADING_MIN_SPEED ? leader.vx / sp : Math.cos(leader.angle);
  const hy = sp > HEADING_MIN_SPEED ? leader.vy / sp : Math.sin(leader.angle);
  const a = Math.atan2(-hy, -hx) + FOLLOW_SPREAD[slot % FOLLOW_SPREAD.length];
  const px = leader.x + Math.cos(a) * mid, py = leader.y + Math.sin(a) * mid;
  const leaderRoom = riftRoomIndexAt(L, world.map.tileSize, leader.x, leader.y);
  const ok = (x: number, y: number): boolean => {
    if (isSolidAt(world.map, x, y) || !lineOfSight(world.map, leader.x, leader.y, x, y)) return false;
    const dr = inDormantSealable(world, L, st, x, y);
    return dr < 0 || dr === leaderRoom;
  };
  if (ok(px, py)) return { x: px, y: py };
  // toward me along the line from the leader (the side we came from is explored)
  const dx = me.x - leader.x, dy = me.y - leader.y, d = Math.hypot(dx, dy);
  if (d > 1) {
    for (const k of [mid, mid * 0.6, mid * 0.3]) {
      const x = leader.x + (dx / d) * Math.min(k, d), y = leader.y + (dy / d) * Math.min(k, d);
      if (ok(x, y)) return { x, y };
    }
  }
  return { x: leader.x, y: leader.y };
}

/** Follow `leader`: travel beyond the band (score grows with distance), hold a spot behind it inside the band. */
function followGoal(world: World, me: Ship, leader: Ship, room: number, near: number, far: number): RiftGoal {
  const d = Math.hypot(leader.x - me.x, leader.y - me.y);
  const p = followPoint(world, me, leader, followerSlot(world, me, leader), (near + far) / 2);
  if (d > far) {
    const g = goal('follow', p.x, p.y, RIFT_SCORE.followFar + Math.min(RIFT_SCORE.followFarMax, (d - far) / 1100), room);
    g.burn = d > RIFT_BURN_PX;
    return g;
  }
  return goal('follow', p.x, p.y, RIFT_SCORE.followNear, room, true, Math.max(40, (far - near) * 0.3));
}

/**
 * The bot's rift goal (§4.9), or null outside a running rift / while dead, attached, extracted or out of lives.
 * `mem` is the brain's RiftMem (only the bot-only leader's regroup wait writes it).
 */
export function riftGoal(world: World, me: Ship, mem: RiftMem): RiftGoal | null {
  const st = world.dungeon, L = world.map.dungeon;
  if (!st || !L || st.outcome !== 'running' || !isFree(me)) return null;
  const ts = world.map.tileSize;
  const t = world.tick;
  const myRoom = riftRoomIndexAt(L, ts, me.x, me.y);

  // 1. inside an ARMING / SEALED room: fight there
  if (myRoom >= 0) {
    const s = st.rooms[myRoom]?.state ?? RIFT_DORMANT;
    if (s === RIFT_ARMING || s === RIFT_SEALED) {
      const r = L.rooms[myRoom];
      const g = goal('fight', r.x, r.y, RIFT_SCORE.fight, myRoom, true, halfSize(r, ts) * 0.35);
      g.sealedRoom = myRoom;
      return g;
    }
  }

  // 2. follow the human leader
  const leader = riftLeader(world, me.team);
  if (leader) {
    const lr = riftRoomIndexAt(L, ts, leader.x, leader.y);
    const ls = lr >= 0 ? (st.rooms[lr]?.state ?? RIFT_DORMANT) : RIFT_DORMANT;
    let g: RiftGoal;
    if (lr >= 0 && lr !== myRoom && ls === RIFT_SEALED) {
      // the leader is behind sealed doors (we weren't recalled: we were a turret or dead then) — wait at a door
      const p = nearestDoorOutside(world, L.rooms[lr], me.x, me.y);
      g = p ? goal('stage', p.x, p.y, RIFT_SCORE.stage, myRoom, true, 60) : followGoal(world, me, leader, myRoom, FOLLOW_NEAR_PX, FOLLOW_FAR_PX);
    } else g = followGoal(world, me, leader, myRoom, FOLLOW_NEAR_PX, FOLLOW_FAR_PX);
    // bots never trigger a descent while the party has an alive human (the sim agrees; this keeps them clear)
    if (st.portal === 1 && L.portalX >= 0) {
      g.avoidX = L.portalX; g.avoidY = L.portalY; g.avoidR = RIFT_PORTAL_R + RIFT_PORTAL_KEEPOUT;
      const ox = g.x - L.portalX, oy = g.y - L.portalY, od = Math.hypot(ox, oy);
      if (od < g.avoidR + 30) {
        // push the goal onto a ring just outside the zone (on our side of it)
        const ux = od > 1 ? ox / od : (me.x - L.portalX) / (Math.hypot(me.x - L.portalX, me.y - L.portalY) || 1);
        const uy = od > 1 ? oy / od : (me.y - L.portalY) / (Math.hypot(me.x - L.portalX, me.y - L.portalY) || 1);
        g.x = L.portalX + ux * (g.avoidR + 50); g.y = L.portalY + uy * (g.avoidR + 50);
      }
    }
    mem.waitSince = -1;
    return g;
  }

  // 3. a human is respawning: regroup at the anchor (where they come back)
  if (humanRespawning(world, me.team)) {
    const a = riftAnchor(world, me.team);
    mem.waitSince = -1;
    return goal('regroup', a.x, a.y, RIFT_SCORE.regroup, myRoom, true, 220);
  }

  // 4. bot-only progression
  // 4a. an openable chest in this room: the nearest free bot opens it
  if (myRoom >= 0) {
    const r = L.rooms[myRoom];
    let best = -1, bd = Infinity;
    for (let k = 0; k * 2 + 1 < r.chests.length; k++) {
      if (!openableChest(r, st, k) || mem.skipChests.includes(myRoom * 16 + k)) continue;
      const cx = r.chests[k * 2], cy = r.chests[k * 2 + 1];
      const d = Math.hypot(cx - me.x, cy - me.y);
      if (d > RIFT_CHEST_PX || d >= bd) continue;
      let mine = true;
      for (const s of world.ships.values()) {
        if (s.id === me.id || !s.isBot || !sameTeam(s.team, me.team) || !isFree(s)) continue;
        const ds = Math.hypot(cx - s.x, cy - s.y);
        if (ds < d || (ds === d && s.playerId < me.playerId)) { mine = false; break; }
      }
      if (mine) { best = k; bd = d; }
    }
    if (best >= 0) {
      const key = myRoom * 16 + best;
      if (mem.chestKey !== key) { mem.chestKey = key; mem.chestSince = t; }
      if (t - mem.chestSince <= RIFT_CHEST_GIVEUP_SEC * TICK_RATE) {
        return goal('chest', r.chests[best * 2], r.chests[best * 2 + 1], RIFT_SCORE.chest, myRoom);
      }
      mem.skipChests.push(key);
    }
  }
  mem.chestKey = -1;

  // 4b. the Descend portal is open (or departing): everyone into the zone
  if (st.portal >= 1 && L.portalX >= 0) {
    mem.waitSince = -1;
    const g = goal('portal', L.portalX, L.portalY, RIFT_SCORE.portal, myRoom, true, RIFT_PORTAL_R * 0.45);
    g.burn = Math.hypot(L.portalX - me.x, L.portalY - me.y) > RIFT_BURN_PX;
    return g;
  }

  const front = riftFrontier(L, st);
  if (front < 0) {
    // every main-path room cleared and no portal (final floor: the victory lap / Exit is the humans' business)
    const a = L.extractX >= 0 ? { x: L.extractX, y: L.extractY } : riftAnchor(world, me.team);
    return goal('idle', a.x, a.y, RIFT_SCORE.idle, myRoom, true, 260);
  }
  const fr = L.rooms[front];
  const fs = st.rooms[front]?.state ?? RIFT_DORMANT;
  if (fs === RIFT_SEALED && myRoom !== front) {
    // our party is fighting behind sealed doors without us: wait at the nearest door
    const p = nearestDoorOutside(world, fr, me.x, me.y);
    if (p) return goal('stage', p.x, p.y, RIFT_SCORE.stage, myRoom, true, 60);
  }

  const lead = riftBotLeader(world, me.team);
  if (!lead || lead.id !== me.id) {
    if (lead) return followGoal(world, me, lead, myRoom, FOLLOW_BOT_NEAR_PX, FOLLOW_BOT_FAR_PX);
    return goal('advance', fr.x, fr.y, RIFT_SCORE.advance, myRoom, true, halfSize(fr, ts) * 0.25);
  }

  // the leader: wait for the group before stepping into the next room (once per room, ≤ RIFT_WAIT_MAX_SEC)
  const outside = myRoom !== front;
  if (outside && mem.waitedRoom !== front && distToRoom(fr, ts, me.x, me.y) <= RIFT_WAIT_NEAR_PX) {
    let spread = false;
    for (const s of world.ships.values()) {
      if (s.id === me.id || !sameTeam(s.team, me.team) || !isFree(s)) continue;
      if (Math.hypot(s.x - me.x, s.y - me.y) > RIFT_GROUP_R) { spread = true; break; }
    }
    if (mem.waitSince < 0 || mem.waitRoom !== front) {
      mem.waitSince = t; mem.waitRoom = front; mem.stageX = me.x; mem.stageY = me.y;
    }
    if (spread && t - mem.waitSince < RIFT_WAIT_MAX_SEC * TICK_RATE) {
      return goal('wait', mem.stageX, mem.stageY, RIFT_SCORE.wait, myRoom, true, 70);
    }
    mem.waitedRoom = front;
    mem.waitSince = -1;
  }
  return goal('advance', fr.x, fr.y, RIFT_SCORE.advance, myRoom, true, halfSize(fr, ts) * 0.25);
}

/**
 * Retreat target in a rift (§4.9 "retreat home means party.anchor"): inside an ARMING / SEALED room a kite point
 * away from the threat that stays inside the room (the doors are walls); elsewhere the party anchor, blended with
 * "away from the threat" while it is close.
 */
export function riftRetreatPoint(world: World, me: Ship, threat: { x: number; y: number } | null, sealedRoom: number): { x: number; y: number } {
  const m = world.map, L = m.dungeon, ts = m.tileSize;
  if (L && sealedRoom >= 0 && L.rooms[sealedRoom]) {
    const r = L.rooms[sealedRoom];
    const rc = rectOf(r, ts, 2.5);
    let ax = threat ? me.x - threat.x : r.x - me.x, ay = threat ? me.y - threat.y : r.y - me.y;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al; ay /= al;
    const base = Math.atan2(ay, ax);
    for (const off of [0, 0.7, -0.7, 1.4, -1.4, 2.2, -2.2]) {
      const a = base + off;
      const x = Math.min(rc.x1, Math.max(rc.x0, me.x + Math.cos(a) * 480));
      const y = Math.min(rc.y1, Math.max(rc.y0, me.y + Math.sin(a) * 480));
      if (!isSolidAt(m, x, y) && Math.hypot(x - me.x, y - me.y) > 120) return { x, y };
    }
    return { x: r.x, y: r.y };
  }
  const a = riftAnchor(world, me.team);
  if (threat && Math.hypot(threat.x - me.x, threat.y - me.y) < 320) {
    let ax = me.x - threat.x, ay = me.y - threat.y;
    const al = Math.hypot(ax, ay) || 1;
    const hx = a.x - me.x, hy = a.y - me.y, hl = Math.hypot(hx, hy) || 1;
    ax = (ax / al) * 0.6 + (hx / hl) * 0.4; ay = (ay / al) * 0.6 + (hy / hl) * 0.4;
    const x = me.x + ax * 500, y = me.y + ay * 500;
    if (!isSolidAt(m, x, y) && lineOfSight(m, me.x, me.y, x, y)) return { x, y };
  }
  return a;
}

/** Trigger inset (tiles) of a sealable room (sim dungeon.ts: 3, the boss room 5). */
const triggerInset = (room: RiftRoom): number => (room.kind === 'boss' ? 5 : 3);

/**
 * While the party has a free human leader: the dormant sealable room — not the leader's own — whose trigger interior
 * (grown by `slackTiles`, so a bot turns back before it) holds (x, y); else -1. A bot never trips a seal (and the
 * recall of the whole party) the human didn't choose: it doesn't chase into such a room and backs out of one.
 */
export function riftForbiddenRoom(world: World, me: Ship, x: number, y: number, slackTiles = 1.5): number {
  const st = world.dungeon, L = world.map.dungeon;
  if (!st || !L || st.outcome !== 'running') return -1;
  const leader = riftLeader(world, me.team);
  if (!leader) return -1;
  const ts = world.map.tileSize;
  const lr = riftRoomIndexAt(L, ts, leader.x, leader.y);
  for (const r of L.rooms) {
    if (r.idx === lr || !sealable(r) || r.doors.length === 0 || (st.rooms[r.idx]?.state ?? RIFT_DORMANT) !== RIFT_DORMANT) continue;
    if (inRoomRect(r, ts, x, y, Math.max(0, triggerInset(r) - slackTiles))) return r.idx;
  }
  return -1;
}

/** The way out of `room` for a bot at (x, y): the outside point of its nearest door (null without doors). */
export function riftRoomExit(world: World, room: number, x: number, y: number): { x: number; y: number } | null {
  const r = world.map.dungeon?.rooms[room];
  return r ? nearestDoorOutside(world, r, x, y) : null;
}

/**
 * May the bot fight this enemy in a rift? Only what it could reach: enemies in its own room, or in line of sight
 * (≤ `maxD` px). Dormant ones (mem.sleep) only in its own room or close by, so a bot never wakes a pack in a room the
 * party isn't entering (a treasure branch's guards seen through a door). Never one inside a dormant sealable room the
 * human leader isn't in (riftForbiddenRoom): chasing it would seal the room and recall the party.
 */
export function riftCanEngage(world: World, me: Ship, myRoom: number, e: { x: number; y: number; mem: Record<string, number> }, d: number, maxD = 900): boolean {
  const L = world.map.dungeon;
  if (!L) return true;
  if (riftForbiddenRoom(world, me, e.x, e.y, 3) >= 0) return false;
  const eRoom = riftRoomIndexAt(L, world.map.tileSize, e.x, e.y);
  if (e.mem.sleep === 1) {
    if (eRoom < 0 || eRoom !== myRoom) {
      if (d > 420) return false;
    }
  }
  if (myRoom >= 0 && eRoom === myRoom) return true;
  return d <= maxD && lineOfSight(world.map, me.x, me.y, e.x, e.y);
}

/**
 * §4.8 / §9 AI "class complement for rift fill bots": an Artificer (engineer) if the party has none, else the
 * least-used class (ties: `r()` picks, default the first in SHIP_CLASS_IDS order). ROOM calls this for each fill bot.
 */
export function riftFillClass(party: readonly ShipClassId[], r: () => number = () => 0): ShipClassId {
  if (!party.includes('engineer')) return 'engineer';
  const counts = new Map<ShipClassId, number>(SHIP_CLASS_IDS.map((c) => [c, 0]));
  for (const c of party) if (counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const min = Math.min(...counts.values());
  const pool = SHIP_CLASS_IDS.filter((c) => counts.get(c) === min);
  const i = Math.floor(Math.max(0, Math.min(0.999999, r())) * pool.length);
  return pool[i] ?? 'engineer';
}
