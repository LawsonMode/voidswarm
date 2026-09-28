// OWNER: PVE agent. v0.3 Dungeon Runner rift director (docs/v0.3-proposal.md §4.4).
//
// In a rift the wave director is off (waves.stepDirector returns early) and this runs first in pveStep:
// - riftFloorInit places the dormant packs of halls and treasure rooms (deferred to the first tick with a ship when
//   there is none yet, e.g. floor 1 is initialised in the Sim constructor before addPlayer).
// - riftEncounterStart (SIM, when a room seals) queues pulses (arena / key) or the Matriarch (boss);
//   stepRiftDirector fires them: spawnWarn, then spawnFormation RIFT_PULSE_WARN_TICKS later, next pulse when the
//   room is down to 30% of the last one or after 14 s (min 3 s). Key rooms end with a mini-boss pulse.
// - riftEncounterDone / riftEncounterReset answer SIM's clear / regroup checks.
// - Instability: from RIFT_SOFT_LIMIT_SEC (420 s) on a floor, a hunter pack every 25 s (world.dungeon.instabilityTick
//   is the next pack tick) and +10% enemy HP per extra minute. `instability {sec: 25}` at the onset and with every pack
//   that spawns (sec = seconds to the next one); the 360 s warning is the HUD's own (RiftView.floorSec).
// world.pve.wave is the floor TIER in a rift (spawnEnemy / spawnFormation scale by it unchanged).
// Every random draw is world.rng; the director's per-floor bookkeeping lives in a side WeakMap keyed by the World
// and invalidated when world.map changes (every floor swap builds a new map).
import { RIFT_SOFT_LIMIT_SEC, TICK_RATE } from '../../constants';
import type { Enemy, EnemyKind, RiftBiome, RiftLayout, RiftRoom, RiftRoomKind, RiftState, Ship, TeamId, World } from '../../types';
import { RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_BASE } from '../../types';
import { isSolidAt, tileAt } from '../map';
import { emit, secToTicks } from '../world';
import { spawnMatriarch } from './bosses';
import { discardEnemy, refreshBossAlive, sleepKey, spawnEnemy, wakeRoomSleepers } from './enemies';
import {
  inRoomRect, partyBossHpMult, partyCountMult, partyHpMult, RIFT_HUNTER_EVERY_SEC, RIFT_HUNTER_MAX_PX,
  RIFT_HUNTER_MIN_PX, RIFT_KEY_HIVE_HP, RIFT_MARKER_CLEAR_PX, RIFT_MAX_BLACKHOLES_PER_ROOM,
  RIFT_NEXT_PULSE_FRAC, RIFT_PULSE_MAX_SEC, RIFT_PULSE_MIN_GAP_SEC, RIFT_PULSE_PER_MARKER, RIFT_PULSE_WARN_TICKS,
  RIFT_WARN_RADIUS, RIFT_WARN_SEC, riftBiomeOf, riftBossDownKey, riftDifficulty, riftHallPackSize, riftInstabilityHpMult,
  riftKindWeights, riftMembersFor, riftPulseSize, riftPulsesPerRoom, riftTierOf, roomIndexAt, tierHpScale,
} from './riftRules';
import { spawnFormation } from './waves';

/** Treasure rooms: chance of a dormant guard pack, (3 + ⌊f/2⌋) weavers + 1 spinner at tier + 1. */
export const RIFT_TREASURE_GUARD_CHANCE = 0.5;
/** Instability hunters spawn at tier + 2; their pack is (4 + f) darts or weavers. */
export const RIFT_HUNTER_TIER_BONUS = 2;
export const RIFT_TREASURE_TIER_BONUS = 1;

interface PendingSpawn {
  x: number; y: number;
  kind: EnemyKind;
  /** Bodies (already converted from the drone-equivalent budget). */
  count: number;
  due: number;
  /** Key-room mini-boss (an elite brute, or a Hive at HP ×0.8). */
  mini: boolean;
}

interface Encounter {
  room: number;
  kind: RiftRoomKind;
  team: TeamId;
  /** Party ships at seal time. */
  n: number;
  /** Pulses in this encounter (a key room's last one is the mini-boss). */
  total: number;
  /** Pulses fired (warned) so far. */
  fired: number;
  /** Regular pulse size, drone-equivalents. */
  size: number;
  mini: EnemyKind | null;
  pending: PendingSpawn[];
  /** Spawned by the pulse in flight. */
  acc: number;
  /** Tick the last pulse finished spawning, and how many it spawned. */
  lastTick: number;
  lastCount: number;
  boss: boolean;
  bossSpawned: boolean;
}

interface RiftDirector {
  /** The floor's map: a new map object means a new floor (the bookkeeping resets). */
  map: World['map'];
  inited: boolean;
  packsPlaced: boolean;
  enc: Map<number, Encounter>;
  /** Open ground hunters may spawn on (flat px), built once per floor on first use; see hunterSpots. */
  hunterSpots: number[] | null;
}

const directors = new WeakMap<World, RiftDirector>();

function freshDirector(world: World): RiftDirector {
  const dir: RiftDirector = { map: world.map, inited: false, packsPlaced: false, enc: new Map(), hunterSpots: null };
  directors.set(world, dir);
  return dir;
}

function director(world: World): RiftDirector {
  const dir = directors.get(world);
  return dir && dir.map === world.map ? dir : freshDirector(world);
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function floorOf(world: World): number {
  return world.dungeon?.floor ?? 1;
}

function biomeOf(world: World, layout: RiftLayout | undefined): RiftBiome {
  return layout?.biome ?? riftBiomeOf(floorOf(world));
}

/** Ships still in the run on this floor (bots included; extracted pilots excluded). */
function activeMembers(world: World): number {
  let n = 0;
  for (const s of world.ships.values()) if (!s.skillState.rOut) n++;
  return n;
}

function floorSec(world: World, d: RiftState): number {
  return Math.max(0, (world.tick - d.floorStartTick) / TICK_RATE);
}

function instabilityHp(world: World): number {
  const d = world.dungeon;
  return d ? riftInstabilityHpMult(floorSec(world, d), RIFT_SOFT_LIMIT_SEC) : 1;
}

/** Run `fn` with world.pve.wave temporarily at `tier` (spawnEnemy / spawnFormation read the tier from it). */
function atTier<T>(world: World, tier: number, fn: () => T): T {
  const saved = world.pve.wave;
  world.pve.wave = tier;
  try { return fn(); } finally { world.pve.wave = saved; }
}

/** Enemies whose centre is inside the room's interior rect. */
export function enemiesInRoom(world: World, room: RiftRoom): number {
  const ts = world.map.tileSize;
  let n = 0;
  for (const e of world.enemies.values()) if (inRoomRect(room, ts, e.x, e.y)) n++;
  return n;
}

function blackholesIn(world: World, room: RiftRoom): number {
  const ts = world.map.tileSize;
  let n = 0;
  for (const e of world.enemies.values()) if (e.kind === 'blackhole' && inRoomRect(room, ts, e.x, e.y)) n++;
  return n;
}

/** One weighted draw over the rift kind table (exactly one world.rng draw). */
function pickRiftKind(world: World, biome: RiftBiome, allowBlackhole: boolean): EnemyKind {
  const table = riftKindWeights(floorOf(world), biome, allowBlackhole);
  let total = 0;
  for (const [, w] of table) total += w;
  let r = world.rng.next() * total;
  for (const [k, w] of table) { r -= w; if (r < 0) return k; }
  return table[table.length - 1][0];
}

/** A spawn marker and its squared distance to the nearest alive ship (IEEE basic ops only, no Math.hypot). */
interface Marker { x: number; y: number; clear: number }

function markersOf(room: RiftRoom): Marker[] {
  const out: Marker[] = [];
  const s = room.spawns;
  for (let i = 0; i + 1 < s.length; i += 2) out.push({ x: s[i], y: s[i + 1], clear: Infinity });
  if (out.length === 0) out.push({ x: room.x, y: room.y, clear: Infinity });
  return out;
}

/**
 * `m` spawn markers of the room (repeating when it has fewer): markers ≥ RIFT_MARKER_CLEAR_PX from every alive ship
 * first, in random order; then the rest, farthest from the nearest ship first.
 */
function pickMarkers(world: World, room: RiftRoom, m: number): Marker[] {
  const pts = markersOf(room);
  for (const p of pts) {
    for (const s of world.ships.values()) {
      if (!s.alive) continue;
      const dx = s.x - p.x, dy = s.y - p.y, d2 = dx * dx + dy * dy;
      if (d2 < p.clear) p.clear = d2;
    }
  }
  const clear2 = RIFT_MARKER_CLEAR_PX * RIFT_MARKER_CLEAR_PX;
  const good = pts.filter((p) => p.clear >= clear2);
  const rest = pts.filter((p) => p.clear < clear2).sort((a, b) => b.clear - a.clear);
  for (let i = good.length - 1; i > 0; i--) {
    const j = Math.floor(world.rng.next() * (i + 1));
    const t = good[i]; good[i] = good[j]; good[j] = t;
  }
  const list = good.concat(rest);
  const out: Marker[] = [];
  for (let i = 0; i < m; i++) out.push(list[i % list.length]);
  return out;
}

function warn(world: World, x: number, y: number): void {
  emit(world, { t: 'spawnWarn', x, y, radius: RIFT_WARN_RADIUS, sec: RIFT_WARN_SEC });
}

// ---------------------------------------------------------------------------------------------
// Floor init: dormant packs (§4.4 Scripts)
// ---------------------------------------------------------------------------------------------

function spawnDormant(world: World, room: RiftRoom, kind: EnemyKind, x: number, y: number, count: number, hpMult: number): void {
  const out: Enemy[] = [];
  spawnFormation(world, kind, x, y, count, hpMult, out);
  for (const e of out) { e.mem.sleep = 1; e.mem.room = room.idx; }
  if (out.length > 0) world.pve.mem[sleepKey(room.idx)] = 1;
}

/**
 * Halls: 1 dormant pack of (4 + f) (2 packs plus a spinner on floor ≥ 4). Treasure: 50% a guard pack of
 * (3 + ⌊f/2⌋) weavers + 1 spinner at tier + 1. Sizes × party / difficulty count mults (party = members now).
 */
function placeFloorPacks(world: World, dir: RiftDirector): void {
  dir.packsPlaced = true;
  const layout = world.map.dungeon;
  if (!layout) return;
  const floor = floorOf(world);
  const n = Math.max(1, activeMembers(world));
  const diff = riftDifficulty(world.config.pveIntensity);
  const countMult = partyCountMult(n) * diff.count;
  const hpMult = partyHpMult(n) * diff.hp;
  const biome = biomeOf(world, layout);
  for (const room of layout.rooms) {
    if (room.kind === 'hall') {
      const markers = pickMarkers(world, room, 3);
      const packs = floor >= 4 ? 2 : 1;
      for (let p = 0; p < packs; p++) {
        const kind = pickRiftKind(world, biome, false);
        spawnDormant(world, room, kind, markers[p].x, markers[p].y, riftMembersFor(kind, riftHallPackSize(floor) * countMult), hpMult);
      }
      if (floor >= 4) spawnDormant(world, room, 'spinner', markers[2].x, markers[2].y, 1, hpMult);
    } else if (room.kind === 'treasure') {
      if (!world.rng.chance(RIFT_TREASURE_GUARD_CHANCE)) continue;
      const markers = pickMarkers(world, room, 2);
      const weavers = Math.max(1, Math.round((3 + Math.floor(floor / 2)) * countMult));
      atTier(world, world.pve.wave + RIFT_TREASURE_TIER_BONUS, () => {
        spawnDormant(world, room, 'weaver', markers[0].x, markers[0].y, weavers, hpMult);
        spawnDormant(world, room, 'spinner', markers[1].x, markers[1].y, 1, hpMult);
      });
    }
  }
}

/**
 * Floor start (SIM calls it from Sim.enterFloor after resetting world.pve and the rift rooms; pveInit calls it for
 * floor 1). Idempotent per floor map. Sets the tier, clears the instability clock and the boss pointer, and places
 * the dormant packs (or defers them to the first director tick when no ship exists yet).
 */
export function riftFloorInit(world: World): void {
  const d = world.dungeon;
  if (!d) return;
  const cur = directors.get(world);
  if (cur && cur.map === world.map && cur.inited) return;
  const dir = freshDirector(world);
  dir.inited = true;
  world.pve.wave = riftTierOf(d.floor);
  refreshBossAlive(world);
  d.instabilityTick = 0;
  d.bossId = 0;
  d.bossPhase = 0;
  if (activeMembers(world) > 0) placeFloorPacks(world, dir);
}

// ---------------------------------------------------------------------------------------------
// Encounters (§4.4 Pulses / Scripts, §4.5)
// ---------------------------------------------------------------------------------------------

function firePulse(world: World, layout: RiftLayout, enc: Encounter, room: RiftRoom): void {
  const k = enc.fired++;
  enc.acc = 0;
  const due = world.tick + RIFT_PULSE_WARN_TICKS;
  if (enc.mini && k === enc.total - 1) {
    const m = pickMarkers(world, room, 1)[0];
    warn(world, m.x, m.y);
    enc.pending.push({ x: m.x, y: m.y, kind: enc.mini, count: 1, due, mini: true });
    return;
  }
  const count = enc.size;
  const nMarkers = Math.max(1, Math.ceil(count / RIFT_PULSE_PER_MARKER));
  const markers = pickMarkers(world, room, nMarkers);
  const base = Math.floor(count / nMarkers);
  let rem = count - base * nMarkers;
  let bh = blackholesIn(world, room);
  const biome = biomeOf(world, layout);
  for (let i = 0; i < nMarkers; i++) {
    const share = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    const kind = pickRiftKind(world, biome, bh < RIFT_MAX_BLACKHOLES_PER_ROOM);
    if (kind === 'blackhole') bh++;
    const m = markers[i];
    warn(world, m.x, m.y);
    enc.pending.push({ x: m.x, y: m.y, kind, count: riftMembersFor(kind, share), due, mini: false });
  }
}

function spawnPending(world: World, enc: Encounter, p: PendingSpawn): number {
  const diff = riftDifficulty(world.config.pveIntensity);
  const hpMult = partyHpMult(enc.n) * diff.hp * instabilityHp(world);
  if (p.mini) {
    const tierScale = tierHpScale(world.pve.wave);
    if (p.kind === 'hive') {
      const e = spawnEnemy(world, 'hive', p.x, p.y, { hpScale: tierScale * RIFT_KEY_HIVE_HP * hpMult });
      if (e) world.pve.bossAlive = true;
      return e ? 1 : 0;
    }
    return spawnEnemy(world, p.kind, p.x, p.y, { elite: true, hpScale: tierScale * hpMult }) ? 1 : 0;
  }
  const out: Enemy[] = [];
  spawnFormation(world, p.kind, p.x, p.y, p.count, hpMult, out);
  return out.length;
}

function trySpawnBoss(world: World, enc: Encounter, room: RiftRoom): void {
  const diff = riftDifficulty(world.config.pveIntensity);
  const inst = instabilityHp(world);
  const e = spawnMatriarch(world, room, enc.n, enc.team, partyBossHpMult(enc.n) * diff.hp * inst, partyHpMult(enc.n) * diff.hp * inst);
  if (e) enc.bossSpawned = true;
}

function stepEncounter(world: World, d: RiftState, layout: RiftLayout, dir: RiftDirector, enc: Encounter): void {
  const state = d.rooms[enc.room]?.state ?? RIFT_DORMANT;
  if (state === RIFT_DORMANT || state === RIFT_CLEARED) { dir.enc.delete(enc.room); return; } // reset / cleared
  if (state !== RIFT_SEALED) return;
  const room = layout.rooms[enc.room];
  if (!room) return;
  if (enc.boss) { if (!enc.bossSpawned) trySpawnBoss(world, enc, room); return; } // retry at the enemy cap
  const tick = world.tick;
  if (enc.pending.length > 0) {
    for (let i = 0; i < enc.pending.length;) {
      const p = enc.pending[i];
      if (p.due <= tick) { enc.acc += spawnPending(world, enc, p); enc.pending.splice(i, 1); } else i++;
    }
    if (enc.pending.length === 0) { enc.lastTick = tick; enc.lastCount = enc.acc; }
    return;
  }
  if (enc.fired >= enc.total) return;
  const since = tick - enc.lastTick;
  if (since < secToTicks(RIFT_PULSE_MIN_GAP_SEC)) return;
  if (since < secToTicks(RIFT_PULSE_MAX_SEC) && enemiesInRoom(world, room) > RIFT_NEXT_PULSE_FRAC * enc.lastCount) return;
  firePulse(world, layout, enc, room);
}

/**
 * A room sealed with `partySize` party ships (alive, not extracted) inside. Arena: riftPulsesPerRoom(f) pulses;
 * key: the same plus a final mini-boss pulse (elite brute on floors 1–3, a Hive at HP ×0.8 after); boss: the
 * Matriarch. The first pulse is warned at once. Other room kinds get an empty encounter (done when the room is empty).
 */
export function riftEncounterStart(world: World, room: number, partySize: number): void {
  const d = world.dungeon, layout = world.map.dungeon;
  if (!d || !layout) return;
  const r = layout.rooms[room];
  if (!r) return;
  const dir = director(world);
  const floor = d.floor;
  const n = Math.max(1, Math.floor(partySize) || 1);
  const sealedBy = d.rooms[room]?.sealedBy ?? -1;
  const enc: Encounter = {
    room, kind: r.kind, team: sealedBy >= 0 ? sealedBy : 0, n,
    total: 0, fired: 0, size: riftPulseSize(floor, n, world.config.pveIntensity), mini: null,
    pending: [], acc: 0, lastTick: world.tick, lastCount: 0,
    // A boss room whose Matriarch already died this floor (then regroup-reset while her adds held it) re-seals as an
    // empty encounter: done once the room is empty, no second Matriarch and no second bossCache.
    boss: r.kind === 'boss' && !world.pve.mem[riftBossDownKey(room)], bossSpawned: false,
  };
  if (r.kind === 'arena') enc.total = riftPulsesPerRoom(floor);
  else if (r.kind === 'key') { enc.total = riftPulsesPerRoom(floor) + 1; enc.mini = floor <= 3 ? 'brute' : 'hive'; }
  dir.enc.set(room, enc);
  if (world.pve.mem[sleepKey(room)]) wakeRoomSleepers(world, room);
  if (enc.boss) trySpawnBoss(world, enc, r);
  else if (enc.total > 0) firePulse(world, layout, enc, r);
}

/**
 * All pulses spawned (the Matriarch included) and no enemy inside the room rect. A room with no encounter on record
 * (never started this floor) is done as soon as it is empty, so a lifecycle mismatch can never soft-lock a seal.
 */
export function riftEncounterDone(world: World, room: number): boolean {
  const r = world.map.dungeon?.rooms[room];
  if (!r) return true;
  const enc = director(world).enc.get(room);
  if (enc && (enc.fired < enc.total || enc.pending.length > 0 || (enc.boss && !enc.bossSpawned))) return false;
  return enemiesInRoom(world, r) === 0;
}

/**
 * Regroup reset: forget the room's encounter (a re-seal starts again from pulse 1 / a fresh Matriarch) and remove
 * any enemy still inside the room rect, silently (SIM removes them too; whichever runs first wins).
 */
export function riftEncounterReset(world: World, room: number): void {
  director(world).enc.delete(room);
  const r = world.map.dungeon?.rooms[room];
  if (r) {
    const ts = world.map.tileSize;
    for (const e of world.enemies.values()) if (inRoomRect(r, ts, e.x, e.y)) discardEnemy(world, e);
  }
  const d = world.dungeon;
  if (d && (!d.bossId || !world.enemies.has(d.bossId))) { d.bossId = 0; d.bossPhase = 0; }
}

// ---------------------------------------------------------------------------------------------
// Instability (§4.4)
// ---------------------------------------------------------------------------------------------

function inLockedRoom(world: World, d: RiftState, x: number, y: number): boolean {
  const i = roomIndexAt(world.map, x, y);
  if (i < 0) return false;
  const st = d.rooms[i]?.state;
  return st === RIFT_ARMING || st === RIFT_SEALED;
}

function hunterSpotOk(world: World, d: RiftState, x: number, y: number): boolean {
  const m = world.map;
  if (x < 64 || y < 64 || x > m.width - 64 || y > m.height - 64) return false;
  if (isSolidAt(m, x, y)) return false;
  if (tileAt(m, Math.floor(x / m.tileSize), Math.floor(y / m.tileSize)) === TILE_BASE) return false;
  return !inLockedRoom(world, d, x, y);
}

const huntBuf: Ship[] = [];
const spotBuf: number[] = [];

/** Open-ground sampling stride (tiles) for the hunter candidates. */
const HUNTER_GRID_STRIDE = 3;
/** Last-resort ring for hunters when nothing lies 700–1100 px from any eligible ship. */
const HUNTER_FALLBACK_MAX_PX = 1600;

/** A 3 × 3 tile block of open, non-BASE ground centred on (c, r): room for a formation to land. */
function openBlock(m: World['map'], c: number, r: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const t = tileAt(m, c + dc, r + dr);
      if (t === TILE_BASE || isSolidAt(m, (c + dc + 0.5) * m.tileSize, (r + dr + 0.5) * m.tileSize)) return false;
    }
  }
  return true;
}

/**
 * Hunter candidates of the floor (flat px), computed once per floor map: every room's spawn markers, centre and door
 * in-points, plus open ground (3 × 3 open, non-BASE blocks) sampled every HUNTER_GRID_STRIDE tiles over the whole
 * floor, rooms and corridors alike. A rift floor is mostly solid rock, so blind samples on a ring around a ship miss
 * about half the time; hunterSpotOk still filters BASE and arming / sealed rooms per pack.
 */
function hunterSpots(world: World, dir: RiftDirector): number[] {
  if (dir.hunterSpots) return dir.hunterSpots;
  const m = world.map, out: number[] = [];
  const add = (x: number, y: number): void => {
    const c = Math.floor(x / m.tileSize), r = Math.floor(y / m.tileSize);
    if (openBlock(m, c, r)) out.push(x, y);
  };
  for (const room of m.dungeon?.rooms ?? []) {
    for (let i = 0; i + 1 < room.spawns.length; i += 2) add(room.spawns[i], room.spawns[i + 1]);
    add(room.x, room.y);
    for (const door of room.doors) add(door.inX, door.inY);
  }
  for (let r = 1; r < m.rows - 1; r += HUNTER_GRID_STRIDE) {
    for (let c = 1; c < m.cols - 1; c += HUNTER_GRID_STRIDE) {
      if (openBlock(m, c, r)) out.push((c + 0.5) * m.tileSize, (r + 0.5) * m.tileSize);
    }
  }
  dir.hunterSpots = out;
  return out;
}

/**
 * A hunter spot for ship `s`: a random open candidate 700–1100 px away (not BASE, not in an arming / sealed room),
 * or with `fallback` the nearest one ≥ 700 px and ≤ HUNTER_FALLBACK_MAX_PX. −1 when there is none.
 */
function hunterSpotFor(world: World, d: RiftState, spots: number[], s: Ship, fallback: boolean): number {
  const min2 = RIFT_HUNTER_MIN_PX * RIFT_HUNTER_MIN_PX;
  const maxPx = fallback ? HUNTER_FALLBACK_MAX_PX : RIFT_HUNTER_MAX_PX, max2 = maxPx * maxPx;
  spotBuf.length = 0;
  let best = -1, bestD = Infinity;
  for (let i = 0; i + 1 < spots.length; i += 2) {
    const dx = spots[i] - s.x, dy = spots[i + 1] - s.y, d2 = dx * dx + dy * dy;
    if (d2 < min2 || d2 > max2 || !hunterSpotOk(world, d, spots[i], spots[i + 1])) continue;
    if (fallback) { if (d2 < bestD) { bestD = d2; best = i; } } else spotBuf.push(i);
  }
  if (fallback) return best;
  return spotBuf.length ? spotBuf[Math.floor(world.rng.next() * spotBuf.length)] : -1;
}

/**
 * (4 + f) darts or weavers at tier + 2, 700–1100 px from a random active ship that is not in a sealed room, on open
 * ground (hunterSpots). No spot for that ship → the other eligible ships in turn → the nearest open spot ≥ 700 px
 * (≤ 1600 px) of the first ship → skip.
 */
function spawnHunterPack(world: World, d: RiftState, dir: RiftDirector): number {
  huntBuf.length = 0;
  for (const s of world.ships.values()) {
    if (!s.alive || s.attachedTo || s.skillState.rOut) continue;
    if (inLockedRoom(world, d, s.x, s.y)) continue;
    huntBuf.push(s);
  }
  if (huntBuf.length === 0) return 0;
  const spots = hunterSpots(world, dir);
  const first = Math.floor(world.rng.next() * huntBuf.length);
  let at = -1;
  for (let k = 0; k < huntBuf.length && at < 0; k++) at = hunterSpotFor(world, d, spots, huntBuf[(first + k) % huntBuf.length], false);
  if (at < 0) at = hunterSpotFor(world, d, spots, huntBuf[first], true);
  huntBuf.length = 0;
  if (at < 0) return 0;
  const x = spots[at], y = spots[at + 1];
  const kind: EnemyKind = world.rng.chance(0.5) ? 'dart' : 'weaver';
  const n = Math.max(1, activeMembers(world));
  const diff = riftDifficulty(world.config.pveIntensity);
  const count = Math.max(1, Math.round((4 + d.floor) * partyCountMult(n) * diff.count));
  const hpMult = partyHpMult(n) * diff.hp * instabilityHp(world);
  const out: Enemy[] = [];
  atTier(world, world.pve.wave + RIFT_HUNTER_TIER_BONUS, () => spawnFormation(world, kind, x, y, count, hpMult, out));
  let kept = 0;
  for (const e of out) {
    if (inLockedRoom(world, d, e.x, e.y)) { discardEnemy(world, e); continue; } // never inside a sealed fight
    e.mem.hunt = 1;
    e.aiTimer = world.tick;
    kept++;
  }
  return kept;
}

/**
 * The instability clock (PVE owns it; SIM zeroes instabilityTick per floor). `instability` means "hunters are here":
 * it fires at the onset (always, so ROOM's once-per-floor chat line and the HUD banner land at 420 s) and after that
 * with every hunter pack that actually spawns; `sec` = seconds until the next pack. There is no 360 s event: the
 * one-minute warning is the HUD's, from RiftView.floorSec.
 */
function stepInstability(world: World, d: RiftState, dir: RiftDirector): void {
  const tick = world.tick;
  if (d.instabilityTick === 0) {
    if (floorSec(world, d) < RIFT_SOFT_LIMIT_SEC) return;
    d.instabilityTick = tick + secToTicks(RIFT_HUNTER_EVERY_SEC);
    spawnHunterPack(world, d, dir);
    emit(world, { t: 'instability', sec: RIFT_HUNTER_EVERY_SEC });
    return;
  }
  if (tick < d.instabilityTick) return;
  d.instabilityTick = tick + secToTicks(RIFT_HUNTER_EVERY_SEC);
  if (spawnHunterPack(world, d, dir) > 0) emit(world, { t: 'instability', sec: RIFT_HUNTER_EVERY_SEC });
}

// ---------------------------------------------------------------------------------------------
// Per-tick director
// ---------------------------------------------------------------------------------------------

/** A ship inside a room that still has dormant enemies wakes them all (room entry). */
function wakeEnteredRooms(world: World): void {
  const mem = world.pve.mem;
  for (const s of world.ships.values()) {
    if (!s.alive || s.attachedTo) continue;
    const r = roomIndexAt(world.map, s.x, s.y);
    if (r >= 0 && mem[sleepKey(r)]) wakeRoomSleepers(world, r);
  }
}

/** pveStep, first (rift only): tier, deferred packs, room-entry wakes, instability, encounter pulses. */
export function stepRiftDirector(world: World): void {
  const d = world.dungeon;
  if (!d) return;
  const dir = director(world);
  const tier = riftTierOf(d.floor);
  if (world.pve.wave !== tier) world.pve.wave = tier;
  if (world.match.phase !== 'playing' || d.outcome !== 'running') return;
  const layout = world.map.dungeon;
  if (!layout) return; // no rift layout on this map (pre-floorgen fallback): nothing to direct
  if (!dir.packsPlaced && activeMembers(world) > 0) placeFloorPacks(world, dir);
  wakeEnteredRooms(world);
  stepInstability(world, d, dir);
  for (const enc of dir.enc.values()) stepEncounter(world, d, layout, dir, enc);
}
