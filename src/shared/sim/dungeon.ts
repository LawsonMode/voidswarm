// OWNER: SIM agent. v0.3 Dungeon Runner run state (docs/v0.3-proposal.md §4.3–4.7).
//
// World.dungeon (RiftState) holds the run; GameMap.dungeon (RiftLayout, floorgen.ts) the static floor. stepRift runs
// once per tick (Sim.step: … stepObjectives → stepRift → stepLoot …) and drives, in order: minimap reveal, the room
// state machine (trigger → ARMING 1.5 s → SEALED: seal, doorway nudge, recall, riftEncounterStart → clear or regroup
// reset), chests, the extract channel, the Descend portal, and the run-end checks (wipe / extracted / cleared).
// PVE owns the encounters (pve/rift.ts) and the whole instability clock (warning, onset, hunter cadence): SIM only
// restarts it per floor (floorStartTick, instabilityTick 0). Per-ship flags live in ship.skillState:
// rOut = 1 extracted, rWait = 1 out of lives until the next floor, rExtract = channel progress 0..1 (rExT = its ticks).
import { RIFT_LIVES_CAP, RIFT_REGROUP_SEC, RIFT_RESPAWN_SEC, TICK_RATE } from '../constants';
import type {
  LootSource, PlayerId, RiftLayout, RiftOutcome, RiftParty, RiftRoom, RiftRoomKind, RiftRoomRun, RiftState, RiftView,
  RiftYou, Ship, TeamId, World,
} from '../types';
import { RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED } from '../types';
import {
  inRoomInterior, isSealableKind, RIFT_ANCHOR_OFFSET_Y, RIFT_ARM_SEC, RIFT_BOSS_LIVES, RIFT_BOSS_TRIGGER_INSET,
  RIFT_CHEST_OPEN_R, RIFT_CLEAR_SCORE, RIFT_CLEAR_XP_PER_TIER, RIFT_DEPART_ALL_SEC, RIFT_DEPART_SEC, RIFT_DESCEND_SCORE,
  RIFT_EXTRACT_DECAY, RIFT_EXTRACT_R, RIFT_EXTRACT_SCORE, RIFT_EXTRACT_TICKS, RIFT_LIVES_BASE, RIFT_LIVES_MIN,
  RIFT_LIVES_PER_PILOT, RIFT_NUDGE_JITTER, RIFT_PORTAL_HOLD_SEC, RIFT_PORTAL_R, RIFT_RECALL_MAX_R, RIFT_RECALL_MIN_R, RIFT_SPAWN_MAX_R,
  RIFT_SPAWN_MIN_R, RIFT_TRIGGER_INSET, RIFT_VICTORY_SEC,
} from './dungeonRules';
import { applyRoomSeals, floorBiome, riftTier, roomAt } from './floorgen';
import { LOOT_RADIUS, rollLoot, secureCarried } from './loot';
import { collideCircle } from './map';
import { grantXp, riftEncounterDone, riftEncounterReset, riftEncounterStart } from './pve/index';
import { riftDifficulty } from './pve/riftRules';
import { side } from './state';
import { detachAll, placeTurret } from './turrets';
import { emit, secToTicks } from './world';

export * from './dungeonRules';

/** respawnTick of a pilot who is out for the floor / extracted. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** Chest i of a room rolls this source (the boss room has no chest: the Matriarch drops the bossCache, PVE). */
const CHEST_SOURCE: Partial<Record<RiftRoomKind, LootSource>> = { arena: 'roomChest', treasure: 'treasureChest', key: 'keyChest' };

// ---------------------------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------------------------

function newRun(kind: RiftRoomKind): RiftRoomRun {
  // The entrance is where the party stands at floor start: visited (and never sealable).
  return { state: kind === 'entrance' ? RIFT_CLEARED : RIFT_DORMANT, until: 0, sealedBy: -1, chests: 0, vacantTicks: 0 };
}

function entranceOf(lay: RiftLayout, team: TeamId): RiftRoom {
  return lay.rooms[lay.entrances[team] ?? lay.entrances[0] ?? 0] ?? lay.rooms[0];
}

/** A fresh run on the world's current (floor-1) map: Sim constructor, after createWorld and before pveInit. */
export function createRiftState(world: World): RiftState {
  const lay = world.map.dungeon;
  const floor = lay?.floor ?? 1;
  const parties: RiftParty[] = [];
  for (let t = 0; t < Math.max(1, Math.floor(world.config.teamCount) || 1); t++) {
    const ent = lay ? entranceOf(lay, t) : null;
    parties.push({
      team: t, lives: 0, status: 'active',
      anchorX: ent ? ent.x : world.map.width / 2, anchorY: ent ? ent.y : world.map.height / 2,
      seen: ent ? 1 << ent.idx : 0, roomsCleared: 0, bossesKilled: 0, deepestFloor: floor,
    });
  }
  return {
    floor, floorsTotal: world.config.floors ?? 6, floorStartTick: world.tick,
    rooms: lay ? lay.rooms.map((r) => newRun(r.kind)) : [], parties,
    portal: 0, departTick: 0, extractOpen: false, victoryTick: 0, bossId: 0, bossPhase: 0, pendingFloor: 0,
    outcome: 'running', extracted: [], instabilityTick: 0,
  };
}

/**
 * Floor swap (Sim.enterFloor, once world.map is the new floor): fresh room runs, Descend / Extract / boss / victory
 * state and instability clock; party anchors back to the entrance, minimap = the entrance, deepestFloor updated.
 * Lives, counters, the extracted list and the outcome carry over.
 */
export function resetRiftFloor(world: World, floor: number): void {
  const d = world.dungeon, lay = world.map.dungeon;
  if (!d || !lay) return;
  d.floor = floor;
  d.floorStartTick = world.tick;
  d.rooms = lay.rooms.map((r) => newRun(r.kind));
  d.portal = 0; d.departTick = 0; d.extractOpen = false; d.victoryTick = 0;
  d.bossId = 0; d.bossPhase = 0; d.pendingFloor = 0; d.instabilityTick = 0;
  for (const p of d.parties) {
    const ent = entranceOf(lay, p.team);
    p.anchorX = ent.x; p.anchorY = ent.y;
    p.seen = 1 << ent.idx;
    p.deepestFloor = Math.max(p.deepestFloor, floor);
  }
}

/** Entrance ring slot `i` of the party (floor-start respawn); the entrance centre when the map has no ring. */
export function riftEntrancePoint(world: World, team: TeamId, i: number): { x: number; y: number } {
  const ring = world.map.spawns.filter((s) => s.team === team);
  if (ring.length) { const p = ring[((i % ring.length) + ring.length) % ring.length]; return { x: p.x, y: p.y }; }
  const lay = world.map.dungeon;
  const ent = lay ? entranceOf(lay, team) : null;
  return ent ? { x: ent.x, y: ent.y } : { x: world.map.width / 2, y: world.map.height / 2 };
}

/** Lives at run start: 2 + 2·party size + difficulty (Story +2, Nightmare −2), clamped to [2, RIFT_LIVES_CAP]. */
export function startingLives(partySize: number, pveIntensity: number): number {
  const n = Math.max(1, Math.floor(partySize) || 1);
  const v = RIFT_LIVES_BASE + RIFT_LIVES_PER_PILOT * n + riftDifficulty(pveIntensity).lives;
  return Math.max(RIFT_LIVES_MIN, Math.min(RIFT_LIVES_CAP, v));
}

/**
 * Count each party's starting lives once, the first time it has ships ("counted at run start, bots included"):
 * the Room adds every seat before the first step. Idempotent.
 */
function initLives(world: World, d: RiftState): void {
  const sd = side(world);
  for (const p of d.parties) {
    const bit = 1 << p.team;
    if (sd.riftLivesSet & bit) continue;
    let n = 0;
    for (const s of world.ships.values()) if (s.team === p.team) n++;
    if (n === 0) continue;
    sd.riftLivesSet |= bit;
    p.lives = startingLives(n, world.config.pveIntensity);
  }
}

function partyOf(d: RiftState, team: TeamId): RiftParty | undefined {
  return team >= 0 ? d.parties[team] : undefined;
}

function roomStates(d: RiftState): number[] {
  return d.rooms.map((r) => r.state);
}

/** End the run once (Sim.stepMatch closes the match on the next stepMatch). Emits riftEnd. */
export function endRift(world: World, outcome: Exclude<RiftOutcome, 'running'>): void {
  const d = world.dungeon;
  if (!d || d.outcome !== 'running') return;
  d.outcome = outcome;
  d.pendingFloor = 0;
  emit(world, { t: 'riftEnd', outcome });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/** Centre inside the room (when given) and the body clear of every solid tile. */
function spotOk(world: World, x: number, y: number, r: number, room: RiftRoom | null): boolean {
  if (room && !inRoomInterior(room, world.map.tileSize, x, y)) return false;
  return !collideCircle(world.map, x, y, r).hit;
}

/** A random open spot on the ring [rMin, rMax] around (x, y) (world.rng), else (x, y) itself. */
function ringNear(world: World, x: number, y: number, rMin: number, rMax: number, bodyR: number, room: RiftRoom | null): { x: number; y: number } {
  for (let i = 0; i < 16; i++) {
    const a = world.rng.next() * Math.PI * 2, rr = world.rng.range(rMin, rMax);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (spotOk(world, px, py, bodyR, room)) return { x: px, y: py };
  }
  return { x, y };
}

/** A random open spot within ±j px of (x, y) (world.rng), else (x, y). */
function jitterNear(world: World, x: number, y: number, j: number, bodyR: number, room: RiftRoom): { x: number; y: number } {
  for (let i = 0; i < 8; i++) {
    const px = x + world.rng.range(-j, j), py = y + world.rng.range(-j, j);
    if (spotOk(world, px, py, bodyR, room)) return { x: px, y: py };
  }
  return { x, y };
}

/** Does an alive, non-extracted ship of `team` (other than `except`) stand inside the room? */
function memberInside(world: World, room: RiftRoom, team: TeamId, except: Ship | null = null): boolean {
  const ts = world.map.tileSize;
  for (const s of world.ships.values()) {
    if (s === except || !s.alive || s.team !== team || s.skillState.rOut) continue;
    if (inRoomInterior(room, ts, s.x, s.y)) return true;
  }
  return false;
}

/** The party already has a room arming or sealed (one fight at a time: recall must not split the party). */
function partyBusy(d: RiftState, team: TeamId): boolean {
  for (const r of d.rooms) if ((r.state === RIFT_ARMING || r.state === RIFT_SEALED) && r.sealedBy === team) return true;
  return false;
}

/** Human pilots of the party still on the floor (not extracted): personal chest drops. */
function partyHumans(world: World, team: TeamId): PlayerId[] {
  const out: PlayerId[] = [];
  for (const s of world.ships.values()) if (!s.isBot && s.team === team && !s.skillState.rOut) out.push(s.playerId);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Room state machine (§4.3)
// ---------------------------------------------------------------------------------------------

/** DORMANT: a non-sealable room is visited (→ CLEARED) by any ship inside; a sealable one arms. */
function tryTrigger(world: World, d: RiftState, room: RiftRoom, run: RiftRoomRun): void {
  const ts = world.map.tileSize;
  const sealable = isSealableKind(room.kind) && room.doors.length > 0;
  const inset = !sealable ? 0 : room.kind === 'boss' ? RIFT_BOSS_TRIGGER_INSET : RIFT_TRIGGER_INSET;
  let who: Ship | null = null;
  for (const s of world.ships.values()) {
    if (!s.alive || s.skillState.rOut || !partyOf(d, s.team)) continue;
    if (sealable && (s.attachedTo !== 0 || partyBusy(d, s.team))) continue;
    if (inRoomInterior(room, ts, s.x, s.y, inset)) { who = s; break; }
  }
  if (!who) return;
  if (!sealable) { run.state = RIFT_CLEARED; return; }
  run.state = RIFT_ARMING;
  run.until = world.tick + secToTicks(RIFT_ARM_SEC);
  run.sealedBy = who.team;
  run.vacantTicks = 0;
  emit(world, { t: 'roomSeal', room: room.idx, team: who.team, sec: RIFT_ARM_SEC });
}

/** Pixel rect of a door's tiles. */
function doorRect(world: World, tiles: readonly number[]): { x0: number; y0: number; x1: number; y1: number } {
  const { cols, tileSize: ts } = world.map;
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (const i of tiles) {
    const c = i % cols, r = (i - c) / cols;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  return { x0: c0 * ts, y0: r0 * ts, x1: (c1 + 1) * ts, y1: (r1 + 1) * ts };
}

function circleHitsRect(x: number, y: number, r: number, b: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const px = x < b.x0 ? b.x0 : x > b.x1 ? b.x1 : x;
  const py = y < b.y0 ? b.y0 : y > b.y1 ? b.y1 : y;
  return (x - px) * (x - px) + (y - py) * (y - py) < r * r;
}

/** Seal: every free ship, enemy and cache overlapping a (now walled) door tile moves to its in-point ± 40 px. */
function nudgeDoorways(world: World, room: RiftRoom): void {
  for (const door of room.doors) {
    const box = doorRect(world, door.tiles);
    for (const s of world.ships.values()) {
      if (!s.alive || s.attachedTo !== 0 || !circleHitsRect(s.x, s.y, s.stats.radius, box)) continue;
      const fromX = s.x, fromY = s.y;
      const p = jitterNear(world, door.inX, door.inY, RIFT_NUDGE_JITTER, s.stats.radius, room);
      s.x = p.x; s.y = p.y; s.vx = 0; s.vy = 0;
      for (const tid of s.turrets) { const t = world.ships.get(tid); if (t) placeTurret(world, t); }
      emit(world, { t: 'blink', shipId: s.id, fromX, fromY, x: s.x, y: s.y });
    }
    for (const e of world.enemies.values()) {
      if (!circleHitsRect(e.x, e.y, e.radius, box)) continue;
      const p = jitterNear(world, door.inX, door.inY, RIFT_NUDGE_JITTER, e.radius, room);
      e.x = p.x; e.y = p.y; e.vx = 0; e.vy = 0;
    }
    if (world.loot) {
      for (const l of world.loot.values()) {
        if (!circleHitsRect(l.x, l.y, LOOT_RADIUS, box)) continue;
        const p = jitterNear(world, door.inX, door.inY, RIFT_NUDGE_JITTER, LOOT_RADIUS, room);
        l.x = p.x; l.y = p.y; l.vx = 0; l.vy = 0;
      }
    }
  }
}

/**
 * Seal: every alive, free party ship outside the room warps to its nearest door's in-point ring (50–90 px). A pilot
 * channelling Extract (rExT > 0) is left where it is: a teammate's seal must not cancel an extraction.
 */
function recallParty(world: World, room: RiftRoom, team: TeamId): void {
  const ts = world.map.tileSize;
  for (const s of world.ships.values()) {
    if (!s.alive || s.attachedTo !== 0 || s.skillState.rOut || s.team !== team) continue;
    if ((s.skillState.rExT ?? 0) > 0) continue;
    if (inRoomInterior(room, ts, s.x, s.y)) continue;
    let door = room.doors[0], best = Infinity;
    for (const dr of room.doors) {
      const dd = (dr.inX - s.x) * (dr.inX - s.x) + (dr.inY - s.y) * (dr.inY - s.y);
      if (dd < best) { best = dd; door = dr; }
    }
    const fromX = s.x, fromY = s.y;
    const p = ringNear(world, door.inX, door.inY, RIFT_RECALL_MIN_R, RIFT_RECALL_MAX_R, s.stats.radius, room);
    s.x = p.x; s.y = p.y; s.vx = 0; s.vy = 0;
    for (const tid of s.turrets) { const t = world.ships.get(tid); if (t) placeTurret(world, t); }
    emit(world, { t: 'blink', shipId: s.id, fromX, fromY, x: s.x, y: s.y });
  }
}

/** ARMING → SEALED: wall the doors, nudge the doorways, recall the party, start the encounter. */
function sealRoom(world: World, d: RiftState, room: RiftRoom, run: RiftRoomRun): void {
  run.state = RIFT_SEALED;
  run.until = 0;
  run.vacantTicks = 0;
  applyRoomSeals(world.map, roomStates(d));
  nudgeDoorways(world, room);
  recallParty(world, room, run.sealedBy);
  let n = 0;
  for (const s of world.ships.values()) if (s.alive && !s.skillState.rOut && s.team === run.sealedBy) n++;
  riftEncounterStart(world, room.idx, n);
  emit(world, { t: 'roomSeal', room: room.idx, team: run.sealedBy, sec: 0 });
}

function inDescendZone(lay: RiftLayout, s: Ship): boolean {
  const dx = s.x - lay.portalX, dy = s.y - lay.portalY;
  return s.alive && dx * dx + dy * dy <= RIFT_PORTAL_R * RIFT_PORTAL_R;
}

function openDescend(world: World, d: RiftState, lay: RiftLayout): void {
  if (d.portal !== 0) return;
  d.portal = 1;
  // The clear usually happens on top of the zone: hold the humans already inside (RIFT_PORTAL_HOLD_SEC).
  const sd = side(world);
  sd.riftPortalHeld.clear();
  sd.riftPortalHoldUntil = world.tick + secToTicks(RIFT_PORTAL_HOLD_SEC);
  for (const s of world.ships.values()) {
    if (!s.isBot && !s.skillState.rOut && partyOf(d, s.team) && inDescendZone(lay, s)) sd.riftPortalHeld.add(s.id);
  }
  emit(world, { t: 'portalOpen', x: lay.portalX, y: lay.portalY, extract: false });
}

/** SEALED → CLEARED: unseal, move the anchor, reward the ships inside; key / boss rooms open the portals. */
function clearRoom(world: World, d: RiftState, lay: RiftLayout, room: RiftRoom, run: RiftRoomRun): void {
  const ts = world.map.tileSize, team = run.sealedBy;
  run.state = RIFT_CLEARED;
  run.until = 0;
  run.vacantTicks = 0;
  applyRoomSeals(world.map, roomStates(d));
  const tier = riftTier(d.floor);
  const scoring = world.match.phase === 'playing';
  for (const s of world.ships.values()) {
    if (!s.alive || s.skillState.rOut || s.team !== team || !inRoomInterior(room, ts, s.x, s.y)) continue;
    if (scoring) s.score += RIFT_CLEAR_SCORE;
    grantXp(world, s, RIFT_CLEAR_XP_PER_TIER * tier);
  }
  const party = partyOf(d, team);
  if (party) {
    party.anchorX = room.x;
    party.anchorY = room.y + RIFT_ANCHOR_OFFSET_Y;
    party.roomsCleared++;
  }
  emit(world, { t: 'roomClear', room: room.idx, team, x: room.x, y: room.y });
  const final = d.floor >= d.floorsTotal;
  if (room.kind === 'key') openDescend(world, d, lay);
  else if (room.kind === 'boss') {
    if (party) {
      party.bossesKilled++;
      party.lives = Math.min(RIFT_LIVES_CAP, party.lives + RIFT_BOSS_LIVES);
    }
    if (!final) openDescend(world, d, lay);
    if (!d.extractOpen && lay.extractX >= 0) {
      d.extractOpen = true;
      emit(world, { t: 'portalOpen', x: lay.extractX, y: lay.extractY, extract: true });
    }
    if (final) d.victoryTick = world.tick + secToTicks(RIFT_VICTORY_SEC);
  }
}

/**
 * Regroup (the downed / rescue replacement): the vacated room goes back to DORMANT, unsealed, and its encounter is
 * forgotten; the enemies still inside are removed silently (PVE's reset does it, SIM sweeps what is left). Chest
 * bits persist.
 */
function resetRoom(world: World, d: RiftState, room: RiftRoom, run: RiftRoomRun): void {
  const team = run.sealedBy;
  run.state = RIFT_DORMANT;
  run.until = 0;
  run.sealedBy = -1;
  run.vacantTicks = 0;
  applyRoomSeals(world.map, roomStates(d));
  riftEncounterReset(world, room.idx);
  const ts = world.map.tileSize;
  for (const e of world.enemies.values()) if (inRoomInterior(room, ts, e.x, e.y)) world.enemies.delete(e.id);
  if (d.bossId && !world.enemies.has(d.bossId)) { d.bossId = 0; d.bossPhase = 0; }
  let boss = false;
  for (const e of world.enemies.values()) if (e.kind === 'hive' || e.kind === 'matriarch') { boss = true; break; }
  world.pve.bossAlive = boss;
  emit(world, { t: 'roomReset', room: room.idx, team });
}

function stepRoom(world: World, d: RiftState, lay: RiftLayout, room: RiftRoom): void {
  const run = d.rooms[room.idx];
  if (run.state === RIFT_DORMANT) tryTrigger(world, d, room, run);
  else if (run.state === RIFT_ARMING) { if (world.tick >= run.until) sealRoom(world, d, room, run); }
  else if (run.state === RIFT_SEALED) {
    if (riftEncounterDone(world, room.idx)) clearRoom(world, d, lay, room, run);
    else if (memberInside(world, room, run.sealedBy)) run.vacantTicks = 0;
    else if (++run.vacantTicks >= secToTicks(RIFT_REGROUP_SEC)) resetRoom(world, d, room, run);
  }
}

// ---------------------------------------------------------------------------------------------
// Chests, extraction, Descend (§4.3, §4.7)
// ---------------------------------------------------------------------------------------------

/**
 * A party ship within 48 px opens a chest: treasure chests any time, reward / key chests once the room is CLEARED.
 * While the party has an alive human only humans open chests (bots trail their leader over them; the opening and
 * the Treasure Hunter credit belong to the pilots — the drops are personal for every human either way).
 */
function stepChests(world: World, d: RiftState, lay: RiftLayout): void {
  const r2 = RIFT_CHEST_OPEN_R * RIFT_CHEST_OPEN_R;
  let humanTeams = 0;
  for (const s of world.ships.values()) {
    if (!s.isBot && s.alive && !s.skillState.rOut && s.team >= 0 && s.team < 31) humanTeams |= 1 << s.team;
  }
  for (const room of lay.rooms) {
    const n = room.chests.length >> 1;
    if (n === 0) continue;
    const run = d.rooms[room.idx];
    if (room.kind !== 'treasure' && run.state !== RIFT_CLEARED) continue;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (run.chests & bit) continue;
      const cx = room.chests[2 * i], cy = room.chests[2 * i + 1];
      let opener: Ship | null = null, best = Infinity;
      for (const s of world.ships.values()) {
        if (!s.alive || s.skillState.rOut || !partyOf(d, s.team)) continue;
        if (s.isBot && (humanTeams & (1 << s.team))) continue;
        const dd = (s.x - cx) * (s.x - cx) + (s.y - cy) * (s.y - cy);
        if (dd <= r2 && dd < best) { best = dd; opener = s; }
      }
      if (!opener) continue;
      run.chests |= bit;
      emit(world, { t: 'chestOpen', room: room.idx, chest: i, playerId: opener.playerId, team: opener.team, x: cx, y: cy });
      const source = CHEST_SOURCE[room.kind];
      if (source) rollLoot(world, source, cx, cy, { priorityPid: opener.playerId, personalFor: partyHumans(world, opener.team) });
    }
  }
}

/** Extraction: bank the carried caches, leave the floor for good (the ship stays in world.ships for the scoreboard). */
function extractShip(world: World, d: RiftState, s: Ship): void {
  const ss = s.skillState;
  secureCarried(world, s);
  detachAll(world, s);
  s.alive = false;
  s.respawnTick = NEVER;
  s.vx = 0; s.vy = 0;
  ss.rOut = 1;
  ss.rExtract = 1;
  delete ss.rExT;
  delete ss.rWait;
  if (world.match.phase === 'playing') s.score += RIFT_EXTRACT_SCORE;
  emit(world, { t: 'extract', playerId: s.playerId, x: s.x, y: s.y });
  d.extracted.push({ playerId: s.playerId, floor: d.floor, tick: world.tick });
}

/** Humans only: +1 tick in the Extract zone, −2 outside; RIFT_EXTRACT_TICKS (3 s) completes. */
function stepExtract(world: World, d: RiftState, lay: RiftLayout): void {
  if (!d.extractOpen || lay.extractX < 0) return;
  const r2 = RIFT_EXTRACT_R * RIFT_EXTRACT_R;
  for (const s of world.ships.values()) {
    const ss = s.skillState;
    if (s.isBot || ss.rOut || !partyOf(d, s.team)) continue;
    const inZone = s.alive && (s.x - lay.extractX) * (s.x - lay.extractX) + (s.y - lay.extractY) * (s.y - lay.extractY) <= r2;
    let t = ss.rExT ?? 0;
    if (inZone) t = Math.min(RIFT_EXTRACT_TICKS, t + 1);
    else if (t > 0) t = Math.max(0, t - RIFT_EXTRACT_DECAY);
    else continue;
    if (t > 0) { ss.rExT = t; ss.rExtract = t / RIFT_EXTRACT_TICKS; }
    else { delete ss.rExT; delete ss.rExtract; }
    if (inZone && t >= RIFT_EXTRACT_TICKS) extractShip(world, d, s);
  }
}

/**
 * Descend (portal 1 → 2 → next floor): a human in the zone starts a 20 s countdown (any ship when the party has no
 * alive human); 3 s once every alive human stands in it; no cancel. A human who was already inside when the portal
 * opened counts only after leaving and re-entering, or after RIFT_PORTAL_HOLD_SEC. At departure each alive member
 * gets +50.
 */
function stepPortal(world: World, d: RiftState, lay: RiftLayout): void {
  if (d.portal === 0) return;
  const inZone = (s: Ship): boolean => inDescendZone(lay, s);
  let humansAlive = 0, humansIn = 0;
  for (const s of world.ships.values()) {
    if (s.isBot || s.skillState.rOut || !s.alive || !partyOf(d, s.team)) continue;
    humansAlive++;
    if (inZone(s)) humansIn++;
  }
  const allIn = humansIn === humansAlive; // vacuous with no alive human: a bots-only party departs fast
  if (d.portal === 1) {
    const sd = side(world);
    const holding = world.tick < sd.riftPortalHoldUntil;
    if (sd.riftPortalHeld.size) {
      for (const id of sd.riftPortalHeld) {
        const s = world.ships.get(id);
        if (!holding || !s || !inZone(s)) sd.riftPortalHeld.delete(id);
      }
    }
    let trigger: Ship | null = null;
    for (const s of world.ships.values()) {
      if (s.skillState.rOut || !partyOf(d, s.team) || !inZone(s)) continue;
      if (humansAlive === 0 || (!s.isBot && !sd.riftPortalHeld.has(s.id))) { trigger = s; break; }
    }
    if (!trigger) return;
    d.portal = 2;
    const sec = allIn ? RIFT_DEPART_ALL_SEC : RIFT_DEPART_SEC;
    d.departTick = world.tick + secToTicks(sec);
    emit(world, { t: 'departing', sec, team: trigger.team });
    return;
  }
  if (allIn && d.departTick - world.tick > secToTicks(RIFT_DEPART_ALL_SEC)) {
    d.departTick = world.tick + secToTicks(RIFT_DEPART_ALL_SEC);
    emit(world, { t: 'departing', sec: RIFT_DEPART_ALL_SEC, team: d.parties[0]?.team ?? 0 });
  }
  if (world.tick < d.departTick) return;
  if (world.match.phase === 'playing') {
    for (const s of world.ships.values()) if (s.alive && !s.skillState.rOut && partyOf(d, s.team)) s.score += RIFT_DESCEND_SCORE;
  }
  // No floor below the last one (a 3 / 6-floor run's last floor is a boss floor with Exit only, so this is a guard).
  if (d.floor >= d.floorsTotal) endRift(world, 'cleared');
  else d.pendingFloor = d.floor + 1;
}

// ---------------------------------------------------------------------------------------------
// Lives, wipe, run end (§4.6, §4.7)
// ---------------------------------------------------------------------------------------------

/**
 * Party stuck: it has members on the floor and none is alive or coming back — every non-extracted member is dead
 * AND out of lives (rWait). A member whose death was paid with a life is still respawning, so it is not stuck. The
 * lives pool is deliberately not read: a boss kill can refill it while everyone left is already waiting for the next
 * floor, and nobody could reach the portal.
 */
function partyStuck(world: World, team: TeamId): boolean {
  let members = 0;
  for (const s of world.ships.values()) {
    if (s.team !== team || s.skillState.rOut) continue;
    members++;
    if (s.alive || !s.skillState.rWait) return false;
  }
  return members > 0;
}

function wipe(world: World, party: RiftParty): void {
  party.status = 'wiped';
  emit(world, { t: 'partyWiped', team: party.team });
  endRift(world, 'wiped');
}

/**
 * The one run-end rule (§4.6 / §4.7; stepRift and riftOnDeath both use it), in priority order:
 *  1. After the final boss (victoryTick > 0) the run can only be won: 'cleared' at victoryTick, once every human
 *     has used Exit, or as soon as nobody left on the floor can continue.
 *  2. No human left on the floor and at least one extracted: 'extracted', whatever the bots are doing.
 *  3. Only then a party whose remaining members are all dead and waiting is wiped.
 */
function checkRunEnd(world: World, d: RiftState): void {
  if (d.outcome !== 'running') return;
  let humans = 0, remaining = 0;
  for (const s of world.ships.values()) {
    if (s.isBot || !partyOf(d, s.team)) continue;
    humans++;
    if (!s.skillState.rOut) remaining++;
  }
  if (d.victoryTick > 0) {
    let stuck = false;
    for (const p of d.parties) if (p.status === 'active' && partyStuck(world, p.team)) stuck = true;
    if (world.tick >= d.victoryTick || (humans > 0 && remaining === 0) || stuck) endRift(world, 'cleared');
    return;
  }
  if (d.extracted.length > 0 && remaining === 0) {
    for (const p of d.parties) if (p.status === 'active') p.status = 'done';
    endRift(world, 'extracted');
    return;
  }
  for (const p of d.parties) {
    if (p.status === 'active' && partyStuck(world, p.team)) { wipe(world, p); return; }
  }
}

/**
 * Death hook (§4.6; combat.killShip, dungeon only, after the loot spill): a life if the pool has one (respawn in
 * RIFT_RESPAWN_SEC, lifeLost), else out for the floor (rWait, outOfLives); then the wipe check.
 */
export function riftOnDeath(world: World, victim: Ship, _killer?: Ship): void {
  const d = world.dungeon;
  if (!d) return;
  const ss = victim.skillState;
  if (ss.rOut) { victim.respawnTick = NEVER; return; }
  delete ss.rExT;
  delete ss.rExtract;
  if (d.outcome !== 'running') return;
  const party = partyOf(d, victim.team);
  if (!party) return;
  initLives(world, d);
  if (party.lives > 0) {
    party.lives--;
    victim.respawnTick = world.tick + secToTicks(RIFT_RESPAWN_SEC);
    emit(world, { t: 'lifeLost', team: party.team, playerId: victim.playerId, lives: party.lives });
  } else {
    ss.rWait = 1;
    victim.respawnTick = NEVER;
    emit(world, { t: 'outOfLives', playerId: victim.playerId, x: victim.x, y: victim.y });
  }
  checkRunEnd(world, d);
}

// ---------------------------------------------------------------------------------------------
// Per-tick step
// ---------------------------------------------------------------------------------------------

/**
 * Per-tick rift step (canonical Sim.step order: … stepObjectives → stepRift → stepLoot …). A no-op when
 * world.dungeon is absent, the run is over, or the map is not the run's floor.
 */
export function stepRift(world: World): void {
  const d = world.dungeon, lay = world.map.dungeon;
  if (!d || !lay || d.outcome !== 'running' || lay.floor !== d.floor || d.rooms.length !== lay.rooms.length) return;
  initLives(world, d);
  // Minimap reveal: any room an alive party ship stands in.
  for (const s of world.ships.values()) {
    if (!s.alive || s.skillState.rOut) continue;
    const p = partyOf(d, s.team);
    const ri = p ? roomAt(world.map, s.x, s.y) : -1;
    if (p && ri >= 0) p.seen |= 1 << ri;
  }
  for (const room of lay.rooms) stepRoom(world, d, lay, room);
  stepChests(world, d, lay);
  stepExtract(world, d, lay);
  stepPortal(world, d, lay);
  checkRunEnd(world, d);
}

/**
 * Rift respawn point (§4.6): the first door's in-point of an arming / sealed room of the ship's party that holds
 * another alive member, else the party anchor; jittered 60–120 px onto open ground (inside that room). Null outside
 * a rift (Sim.spawnShip then uses its default spawn pick).
 */
export function riftSpawnPoint(world: World, ship: Ship): { x: number; y: number } | null {
  const d = world.dungeon, lay = world.map.dungeon;
  if (!d || !lay || lay.floor !== d.floor) return null;
  const r = ship.stats.radius;
  for (const room of lay.rooms) {
    const run = d.rooms[room.idx];
    if (!run || (run.state !== RIFT_ARMING && run.state !== RIFT_SEALED) || run.sealedBy !== ship.team || room.doors.length === 0) continue;
    if (!memberInside(world, room, ship.team, ship)) continue;
    const door = room.doors[0];
    return ringNear(world, door.inX, door.inY, RIFT_SPAWN_MIN_R, RIFT_SPAWN_MAX_R, r, room);
  }
  const party = partyOf(d, ship.team);
  const ent = entranceOf(lay, ship.team);
  const ax = party ? party.anchorX : ent.x, ay = party ? party.anchorY : ent.y;
  const ri = roomAt(world.map, ax, ay);
  return ringNear(world, ax, ay, RIFT_SPAWN_MIN_R, RIFT_SPAWN_MAX_R, r, ri >= 0 ? lay.rooms[ri] : null);
}

// ---------------------------------------------------------------------------------------------
// Views (§8.8 frozen)
// ---------------------------------------------------------------------------------------------

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Rift state for clients (MatchView.dungeon). Call only when world.dungeon is set. */
export function buildRiftView(world: World): RiftView {
  const d = world.dungeon!;
  initLives(world, d);
  const tick = world.tick;
  let departIn = 0;
  if (d.portal === 2 && d.departTick > tick) departIn = (d.departTick - tick) / TICK_RATE;
  else if (d.victoryTick > tick) departIn = (d.victoryTick - tick) / TICK_RATE;
  const waiting: PlayerId[] = [];
  const extracting: { playerId: PlayerId; frac: number }[] = [];
  for (const s of world.ships.values()) {
    const ss = s.skillState;
    if (ss.rWait && !s.alive && !ss.rOut) waiting.push(s.playerId);
    if (!ss.rOut && (ss.rExtract ?? 0) > 0) extracting.push({ playerId: s.playerId, frac: round3(ss.rExtract) });
  }
  const b = d.bossId ? world.enemies.get(d.bossId) : undefined;
  const anchors: number[] = [];
  for (const p of d.parties) anchors.push(Math.round(p.anchorX), Math.round(p.anchorY));
  return {
    floor: d.floor,
    floorsTotal: d.floorsTotal,
    biome: world.map.dungeon?.biome ?? floorBiome(d.floor),
    rooms: d.rooms.map((r) => r.state),
    chests: d.rooms.map((r) => r.chests),
    lives: d.parties.map((p) => p.lives),
    seen: d.parties.map((p) => p.seen),
    anchors,
    portal: d.portal,
    departIn: round1(departIn),
    extractOpen: d.extractOpen,
    boss: b ? { id: b.id, kind: b.kind, hpFrac: round3(b.maxHp > 0 ? Math.max(0, b.hp / b.maxHp) : 0), phase: d.bossPhase } : null,
    waiting,
    extracting,
    floorSec: Math.max(0, Math.floor((tick - d.floorStartTick) / TICK_RATE)),
  };
}

/** Private rift state for one ship's player (YouState.rift). Call only when world.dungeon is set. */
export function riftYou(world: World, ship: Ship): RiftYou {
  const d = world.dungeon!;
  const ss = ship.skillState;
  let followId = 0;
  if (!ship.alive) {
    let best: Ship | null = null;
    for (const s of world.ships.values()) {
      if (s === ship || !s.alive || s.team !== ship.team || s.skillState.rOut) continue;
      if (!best || s.playerId < best.playerId) best = s;
    }
    followId = best ? best.id : 0;
  }
  return {
    party: ship.team,
    lives: partyOf(d, ship.team)?.lives ?? 0,
    waiting: !!ss.rWait,
    extracted: !!ss.rOut,
    extract: ss.rOut ? 1 : round3(ss.rExtract ?? 0),
    followId,
  };
}
