// OWNER: SIM agent. v0.3 in-world cosmetic loot caches (docs/v0.3-proposal.md §6.3–6.5).
//
// A cache is only {rarity, set, source}: the item is rolled server-side at grant time (profile/rolls.ts),
// so nothing here knows item ids. Every random draw uses side(world).lootRng (seeded from the server-only
// SimConfig.lootSeed) — NEVER world.rng — so a match with lootMult 0 is v0.2's match exactly.
//
// Call sites (canonical order, §9): combat.killShip (shutdown roll → spill → riftOnDeath), pve killEnemy
// (elite / boss), objectives (flag / zone / hot rules), dungeon chests (personal rules, M4), Sim.removePlayer
// and Sim.setPlayerTeam (spill, no priority), Sim.step → stepLoot (physics, expiry, pickup).
import {
  LOOT_LIFE_SEC, LOOT_PICKUP_PAD, LOOT_SPILL_LIFE_SEC, LOOT_SPILL_RESERVE_SEC, MAX_CARRIED, MAX_CARRIED_DUNGEON, MAX_LOOT,
} from '../constants';
import {
  CACHE_RARITY_W, DROP_RULES, LOOT_FLOOR_CAP_BASE, LOOT_FLOOR_CAP_PER_HUMAN, LOOT_MATCH_CAP_BASE, LOOT_MATCH_CAP_MAX,
  LOOT_MATCH_CAP_PER_HUMAN, MODE_SET_SHARE, riftRarityBoost, SET_FOR_TYPE,
} from '../data/loot';
import type { CacheToken, EntityId, GameMap, GameType, LootDrop, LootSet, LootSource, PlayerId, Rarity, Ship, World } from '../types';
import { hash32 } from '../util/hash';
import { Rng } from '../util/rng';
import { collideCircle, isSolidAt } from './map';
import { side } from './state';
import { allocId, carriedOf, emit, forEachShipNear, gameTypeOf, sameTeam, secToTicks } from './world';

export interface RollOpts {
  priorityPid: PlayerId;
  /** personal rules: one set per pid, reserved until floor end */
  personalFor?: readonly PlayerId[];
}

// ---- SIM tuning (not contract) ----
/** expireTick / reservedUntilTick of a personal cache: never (dungeon floor swap clears World.loot). */
export const LOOT_NO_EXPIRY = Number.MAX_SAFE_INTEGER;
/** Cache body radius vs walls (the sprite is 24 px). */
export const LOOT_RADIUS = 10;
/** Velocity kept per second (friction = FRICTION^dt), same feel as XP gems. */
export const LOOT_FRICTION = 0.08;
/** Pop speed range of a freshly rolled cache (px/s). */
export const LOOT_POP_SPEED_MIN = 30;
export const LOOT_POP_SPEED_MAX = 110;
/** Scatter speed range of spilled caches (px/s, §6.5). */
export const LOOT_SPILL_SPEED_MIN = 60;
export const LOOT_SPILL_SPEED_MAX = 180;
/** Lowest rarity that is never evicted by the world cap (epic). */
const EVICT_BELOW: Rarity = 3;
/** How many tile rings spawnDrop searches for an open tile when asked to spawn inside rock / wall. */
const UNSTICK_RINGS = 8;

/**
 * (x, y) itself when open, else the centre of the nearest open tile within UNSTICK_RINGS rings (a cache spawned
 * inside a wall would sit there, unreachable, holding a cap slot). A tile centre clears LOOT_RADIUS (10 < 16 px).
 */
function openPoint(map: GameMap, x: number, y: number): { x: number; y: number } {
  if (!isSolidAt(map, x, y)) return { x, y };
  const ts = map.tileSize, c0 = Math.floor(x / ts), r0 = Math.floor(y / ts);
  for (let ring = 1; ring <= UNSTICK_RINGS; ring++) {
    let bx = 0, by = 0, bestD = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const cx = (c0 + dc + 0.5) * ts, cy = (r0 + dr + 0.5) * ts;
        if (isSolidAt(map, cx, cy)) continue;
        const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (d < bestD) { bestD = d; bx = cx; by = cy; }
      }
    }
    if (bestD < Infinity) return { x: bx, y: by };
  }
  return { x, y };
}

function lootMap(world: World): Map<EntityId, LootDrop> {
  return (world.loot ??= new Map());
}

function humanCount(world: World): number {
  let n = 0;
  for (const s of world.ships.values()) if (!s.isBot) n++;
  return n;
}

/** MAX_CARRIED, or MAX_CARRIED_DUNGEON in a rift. */
export function carryCap(world: World): number {
  return world.dungeon || gameTypeOf(world.config) === 'dungeon' ? MAX_CARRIED_DUNGEON : MAX_CARRIED;
}

/**
 * Non-personal cache cap right now (§6.4.5): arena / warzone per match min(72, 8 + 4·humans); dungeon per
 * floor 4 + 2·humans. Humans are counted at roll time (bots never count).
 */
export function lootCap(world: World): number {
  const h = humanCount(world);
  if (gameTypeOf(world.config) === 'dungeon') return LOOT_FLOOR_CAP_BASE + LOOT_FLOOR_CAP_PER_HUMAN * h;
  return Math.min(LOOT_MATCH_CAP_MAX, LOOT_MATCH_CAP_BASE + LOOT_MATCH_CAP_PER_HUMAN * h);
}

/** Non-personal caches already spawned against lootCap (this match; this floor in a dungeon). */
export function lootCapUsed(world: World): number {
  const sd = side(world);
  if (gameTypeOf(world.config) !== 'dungeon') return sd.lootSpawned;
  const floor = world.dungeon?.floor ?? 1;
  if (sd.lootFloor !== floor) { sd.lootFloor = floor; sd.lootFloorSpawned = 0; }
  return sd.lootFloorSpawned;
}

function noteCapSpawn(world: World): void {
  const sd = side(world);
  sd.lootSpawned++;
  if (gameTypeOf(world.config) === 'dungeon') sd.lootFloorSpawned++;
}

/**
 * Rarity roll (§6.4.3): CACHE_RARITY_W restricted to rarities ≥ floorR; weights of rarity ≥ 2 × `boost`
 * (the dungeon riftRarityBoost; 1 elsewhere), renormalized. Pure given the rng.
 */
export function rollRarity(rng: Rng, floorR: Rarity, boost = 1): Rarity {
  const top = CACHE_RARITY_W.length - 1;
  const lo = Math.max(0, Math.min(top, floorR | 0));
  let total = 0;
  for (let r = lo; r <= top; r++) total += CACHE_RARITY_W[r] * (r >= 2 ? boost : 1);
  let u = rng.next() * total;
  for (let r = lo; r <= top; r++) {
    u -= CACHE_RARITY_W[r] * (r >= 2 ? boost : 1);
    if (u < 0) return r as Rarity;
  }
  return top as Rarity; // float edge (u landed exactly on the total)
}

/** Set roll (§6.4.4): the game type's exclusive set MODE_SET_SHARE of the time, else Salvage Line. */
export function rollSet(rng: Rng, gameType: GameType): LootSet {
  return rng.next() < MODE_SET_SHARE ? SET_FOR_TYPE[gameType] : 'common';
}

/**
 * World cap (§6.4.5): at MAX_LOOT, evict the oldest lowest-rarity cache below epic. If there is none, or
 * the cheapest one outranks the incoming cache, the incoming one is refused instead (the lowest rarity
 * always loses; epic+ caches are never evicted). Map insertion order = spawn order = age.
 */
function makeRoom(world: World, rarity: Rarity): boolean {
  const loot = lootMap(world);
  if (loot.size < MAX_LOOT) return true;
  let victim: LootDrop | null = null;
  for (const d of loot.values()) {
    if (d.token.rarity >= EVICT_BELOW) continue;
    if (!victim || d.token.rarity < victim.token.rarity) victim = d;
  }
  if (!victim || victim.token.rarity > rarity) return false;
  loot.delete(victim.id);
  return true;
}

function spawnDrop(
  world: World, token: CacheToken, x: number, y: number, speedMin: number, speedMax: number,
  reservedFor: PlayerId, reservedUntilTick: number, expireTick: number, droppedBy: PlayerId,
): LootDrop | null {
  if (!makeRoom(world, token.rarity)) return null;
  const id = allocId(world);
  // The pop / scatter direction is cosmetic and comes from public data (id, tick), never lootRng: clients see cache
  // motion in snapshots, and every lootRng output they can read helps reconstruct its state (the next rolls).
  const scatter = new Rng(hash32(id, world.tick, 0x10075));
  const a = scatter.next() * Math.PI * 2;
  const sp = scatter.range(speedMin, speedMax);
  const at = openPoint(world.map, x, y);
  const d: LootDrop = {
    id, x: at.x, y: at.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
    token, spawnTick: world.tick, expireTick,
    reservedFor: reservedFor > 0 ? reservedFor : 0,
    reservedUntilTick: reservedFor > 0 ? reservedUntilTick : 0,
    droppedBy,
  };
  lootMap(world).set(d.id, d);
  return d;
}

function rolledToken(world: World, rng: Rng, gt: GameType, floorR: Rarity, source: LootSource): CacheToken {
  const boost = gt === 'dungeon' ? riftRarityBoost(world.dungeon?.floor ?? 1, world.config.pveIntensity) : 1;
  const rarity = rollRarity(rng, floorR, boost);
  return { rarity, set: rollSet(rng, gt), source };
}

/**
 * Roll one DROP_RULES trigger at (x, y). Returns caches spawned. Uses side(world).lootRng only. No-op when
 * lootMult is 0/absent, the rule has no chance in this game type, or the match is over.
 * - Chance p = min(1, rule.chance[gameType] × lootMult), one draw per trigger.
 * - Non-personal: one cache per rule floor, reserved for `priorityPid` for rule.reserveSec, 90 s life;
 *   counts against lootCap (a trigger at the cap rolls nothing).
 * - Personal: one set (every floor) per recipient in `personalFor` (deduped; absent = [priorityPid]),
 *   reserved for that player with no expiry; exempt from lootCap.
 */
export function rollLoot(world: World, source: LootSource, x: number, y: number, o: RollOpts): number {
  const mult = world.config.lootMult ?? 0;
  if (!(mult > 0) || world.match.phase !== 'playing') return 0;
  const rule = DROP_RULES[source];
  if (!rule) return 0;
  const gt = gameTypeOf(world.config);
  const chance = rule.chance[gt] ?? 0;
  if (!(chance > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const rng = side(world).lootRng;
  const p = Math.min(1, chance * mult);
  let n = 0;

  if (rule.personal) {
    const pids: PlayerId[] = [];
    for (const pid of o.personalFor ?? [o.priorityPid]) if (pid > 0 && !pids.includes(pid)) pids.push(pid);
    if (pids.length === 0) return 0;
    if (!(rng.next() < p)) return 0;
    for (const pid of pids) {
      for (const f of rule.floors) {
        const d = spawnDrop(world, rolledToken(world, rng, gt, f, source), x, y, LOOT_POP_SPEED_MIN, LOOT_POP_SPEED_MAX,
          pid, LOOT_NO_EXPIRY, LOOT_NO_EXPIRY, 0);
        if (d) { n++; emitDrop(world, d); }
      }
    }
    return n;
  }

  const cap = lootCap(world);
  let used = lootCapUsed(world);
  if (used >= cap) return 0;
  if (!(rng.next() < p)) return 0;
  const reserveFor = rule.reserveSec > 0 ? o.priorityPid : 0;
  const reserveUntil = world.tick + secToTicks(rule.reserveSec);
  const expire = world.tick + secToTicks(LOOT_LIFE_SEC);
  for (const f of rule.floors) {
    if (used >= cap) break;
    const d = spawnDrop(world, rolledToken(world, rng, gt, f, source), x, y, LOOT_POP_SPEED_MIN, LOOT_POP_SPEED_MAX,
      reserveFor, reserveUntil, expire, 0);
    if (!d) continue;
    n++; used++;
    noteCapSpawn(world);
    emitDrop(world, d);
  }
  return n;
}

function emitDrop(world: World, d: LootDrop): void {
  emit(world, { t: 'lootDrop', id: d.id, x: d.x, y: d.y, rarity: d.token.rarity, set: d.token.set, source: d.token.source });
}

function shipOfPlayer(world: World, pid: PlayerId): Ship | undefined {
  const id = world.shipsByPlayer.get(pid);
  const s = id ? world.ships.get(id) : undefined;
  if (s) return s;
  for (const t of world.ships.values()) if (t.playerId === pid) return t;
  return undefined;
}

/**
 * Death / leave / team change (§6.5): scatter the ship's carried caches at its position, highest rarity
 * first, 60–180 px/s, 45 s life, droppedBy = the ship's player. A NON-ALLY killer (`killerPid`, with a ship
 * on another team or in FFA) gets LOOT_SPILL_RESERVE_SEC priority; allies, the swarm (0) and self-kills
 * get none. Tokens keep their set and source. Emits lootSpill (count = every token lost from the hold,
 * including any the world cap refused). Not gated on lootMult: whatever is carried always spills.
 */
export function spillCarried(world: World, ship: Ship, killerPid: PlayerId): void {
  const tokens = ship.carried;
  if (!tokens || tokens.length === 0) return;
  ship.carried = [];
  const sorted = tokens.slice().sort((a, b) => b.rarity - a.rarity); // stable: pickup order within a rarity
  let resFor: PlayerId = 0, resUntil = 0;
  if (killerPid > 0 && killerPid !== ship.playerId) {
    const k = shipOfPlayer(world, killerPid);
    if (k && k !== ship && !sameTeam(k.team, ship.team)) {
      resFor = killerPid;
      resUntil = world.tick + secToTicks(LOOT_SPILL_RESERVE_SEC);
    }
  }
  const expire = world.tick + secToTicks(LOOT_SPILL_LIFE_SEC);
  for (const t of sorted) {
    spawnDrop(world, { rarity: t.rarity, set: t.set, source: t.source }, ship.x, ship.y,
      LOOT_SPILL_SPEED_MIN, LOOT_SPILL_SPEED_MAX, resFor, resUntil, expire, ship.playerId);
  }
  emit(world, { t: 'lootSpill', playerId: ship.playerId, x: ship.x, y: ship.y, count: sorted.length, best: sorted[0].rarity });
}

/** Extraction: emits lootSecured { tokens } and clears carried. Nothing carried = no event. */
export function secureCarried(world: World, ship: Ship): void {
  const tokens = ship.carried;
  if (!tokens || tokens.length === 0) return;
  ship.carried = [];
  emit(world, {
    t: 'lootSecured', playerId: ship.playerId, how: 'extract',
    tokens: tokens.map((t) => ({ rarity: t.rarity, set: t.set, source: t.source })),
  });
}

/**
 * A player left the match: caches reserved for them become free at once (a leaver's personal rift caches
 * would otherwise sit untakeable until the floor ends). Expiry is unchanged. SIM addition (Sim.removePlayer).
 */
export function releaseLootFor(world: World, playerId: PlayerId): void {
  const loot = world.loot;
  if (!loot || loot.size === 0 || !(playerId > 0)) return;
  for (const d of loot.values()) {
    if (d.reservedFor === playerId) { d.reservedFor = 0; d.reservedUntilTick = 0; }
  }
}

/** Insert keeping Ship.carried in rarity-descending order (stable within a rarity). */
function insertByRarity(arr: CacheToken[], t: CacheToken): void {
  let i = arr.length;
  while (i > 0 && arr[i - 1].rarity < t.rarity) i--;
  arr.splice(i, 0, t);
}

// Pickup scratch (no per-drop closures on the tick path).
let pDrop: LootDrop | null = null;
let pBest: Ship | null = null;
let pBestD = 0;
let pCap = 0;
function considerPickup(s: Ship): void {
  // forEachShipNear already filtered alive ships within radius + LOOT_PICKUP_PAD.
  const d = pDrop!;
  if (s.isBot || s.attachedTo !== 0) return; // bots never pick up; neither do attached turrets
  if (d.reservedFor !== 0 && d.reservedFor !== s.playerId) return;
  if ((s.carried?.length ?? 0) >= pCap) return;
  const dx = s.x - d.x, dy = s.y - d.y, dd = dx * dx + dy * dy;
  if (!pBest || dd < pBestD || (dd === pBestD && s.id < pBest.id)) { pBest = s; pBestD = dd; }
}

/**
 * Per-tick cache step (canonical Sim.step order: … stepRift → stepLoot …):
 * expiry → lapsed reservations → physics (friction 0.08^dt, stop at walls) → pickup. A pickup needs an
 * alive HUMAN ship, not attached as a turret, below carryCap, within its radius + LOOT_PICKUP_PAD, and the
 * reservation (if any) must be theirs; the nearest eligible ship wins (ties: lower ship id). No pickups
 * once the match is over (the Room has already taken the survivors' holds).
 */
export function stepLoot(world: World, dt: number): void {
  const loot = world.loot;
  if (!loot || loot.size === 0) return;
  const tick = world.tick, map = world.map;
  const friction = Math.pow(LOOT_FRICTION, dt);
  const canPick = world.match.phase === 'playing';
  pCap = carryCap(world);
  for (const d of loot.values()) {
    if (tick >= d.expireTick) { loot.delete(d.id); continue; }
    if (d.reservedFor !== 0 && tick >= d.reservedUntilTick) { d.reservedFor = 0; d.reservedUntilTick = 0; }

    if (d.vx !== 0 || d.vy !== 0) {
      d.vx *= friction; d.vy *= friction;
      if (d.vx * d.vx + d.vy * d.vy < 1) { d.vx = 0; d.vy = 0; }
      else {
        const c = collideCircle(map, d.x + d.vx * dt, d.y + d.vy * dt, LOOT_RADIUS);
        d.x = c.x; d.y = c.y;
        if (c.hit) { d.vx = 0; d.vy = 0; }
      }
    }

    if (!canPick) continue;
    pDrop = d; pBest = null; pBestD = 0;
    forEachShipNear(world, d.x, d.y, LOOT_PICKUP_PAD, considerPickup);
    const s = pBest as Ship | null;
    pDrop = null; pBest = null;
    if (!s) continue;
    const held = carriedOf(s);
    insertByRarity(held, d.token);
    loot.delete(d.id);
    emit(world, {
      t: 'lootPickup', playerId: s.playerId, shipId: s.id, x: d.x, y: d.y,
      rarity: d.token.rarity, set: d.token.set, carried: held.length,
    });
  }
}
