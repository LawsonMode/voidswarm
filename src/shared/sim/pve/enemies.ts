// OWNER: PVE agent. Enemy definitions, spawning, AI, contact damage, death effects.
// v0.3 M4 rift additions (docs/v0.3-proposal.md §4.4–4.5), all gated on world.dungeon so Arena / Warzone run the
// v0.2 code path exactly: the leash in retarget, dormancy (mem.sleep), steering home (mem.hx / hy) instead of
// wandering, instability hunters (mem.hunt), and the Matriarch (bosses.ts).
import { ENEMY_TEAM, MAX_ENEMIES, TICK_RATE } from '../../constants';
import { PATHS, hasUpgrade, pathKey } from '../../data/ships';
import type { Deployable, Enemy, EnemyKind, EntityId, LootSource, Ship, World } from '../../types';
import { damageEnemy, damageShip, splashDamage } from '../combat';
import { rollLoot } from '../loot';
import { reseatTurrets } from '../hull';
import { collideCircle, lineOfSight } from '../map';
import { allocId, dropGems, emit, projectileDefaults, secToTicks, spawnProjectile } from '../world';
import {
  clearBossRef, matriarchDeathBlast, matriarchInIntro, matriarchWallImpact, rollBossCache, stepMatriarch,
} from './bosses';
import { queryEnemies, queryShips } from './query';
import { RIFT_HUNT_RANGE_PX, RIFT_LEASH_PX, RIFT_WAKE_PX, roomIndexAt } from './riftRules';

export interface EnemyDef {
  radius: number;
  hp: number;
  speed: number;
  /** Steering responsiveness (1/s). */
  accel: number;
  contact: number;
  score: number;
  xp: number;
  /** Dies on contact (small swarmer) vs periodic contact damage + knockback. */
  kamikaze: boolean;
  knockback: number;
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  drone:     { radius: 13, hp: 160,  speed: 175, accel: 3,   contact: 110, score: 1,  xp: 1,  kamikaze: true,  knockback: 0 },
  dart:      { radius: 11, hp: 130,  speed: 130, accel: 4,   contact: 160, score: 2,  xp: 2,  kamikaze: true,  knockback: 0 },
  weaver:    { radius: 13, hp: 210,  speed: 215, accel: 5,   contact: 120, score: 2,  xp: 2,  kamikaze: true,  knockback: 0 },
  splitter:  { radius: 18, hp: 380,  speed: 140, accel: 2.5, contact: 90,  score: 3,  xp: 3,  kamikaze: false, knockback: 220 },
  splitling: { radius: 9,  hp: 80,   speed: 265, accel: 5,   contact: 60,  score: 1,  xp: 1,  kamikaze: true,  knockback: 0 },
  spinner:   { radius: 15, hp: 420,  speed: 180, accel: 3,   contact: 80,  score: 4,  xp: 4,  kamikaze: false, knockback: 200 },
  brute:     { radius: 34, hp: 2400, speed: 90,  accel: 1.5, contact: 240, score: 8,  xp: 10, kamikaze: false, knockback: 520 },
  blackhole: { radius: 30, hp: 1800, speed: 35,  accel: 1,   contact: 180, score: 10, xp: 12, kamikaze: false, knockback: 0 },
  hive:      { radius: 70, hp: 9000, speed: 50,  accel: 1,   contact: 320, score: 50, xp: 80, kamikaze: false, knockback: 700 },
  // v0.3 Dungeon Runner boss (§4.5): floors 3 and 6. Tier, party (×(1 + 0.6(n − 1))) and difficulty HP apply on top.
  matriarch: { radius: 88, hp: 30000, speed: 60,  accel: 1,   contact: 320, score: 150, xp: 150, kamikaze: false, knockback: 700 },
};

/** Largest enemy body (the Matriarch's 88 fits; the grid queries pad by 96). */
export const MAX_RADIUS = 90;
const RETARGET_TICKS = 30;
const PREFER_RANGE = 1800;
const CONTACT_CD_TICKS = 30;
/** Ram path (Spiked Prow): fraction of contact damage still taken. */
export const RAM_CONTACT_TAKEN = 0.3;
/** Reactive Plating: fraction of contact damage taken that is reflected to the enemy. */
export const PLATING_REFLECT = 0.25;

const shipBuf: Ship[] = [];
const enemyBuf: Enemy[] = [];
const enemyBuf2: Enemy[] = [];
const stepList: Enemy[] = [];
const wallBuf: Deployable[] = [];
const sentryBuf: Deployable[] = [];

export interface SpawnOpts { elite?: boolean; hpScale?: number }

export function spawnEnemy(world: World, kind: EnemyKind, x: number, y: number, opts: SpawnOpts = {}): Enemy | null {
  if (world.enemies.size >= MAX_ENEMIES) return null;
  const d = ENEMY_DEFS[kind];
  const elite = !!opts.elite;
  const hpScale = opts.hpScale ?? 1;
  const hp = Math.round(d.hp * hpScale * (elite ? 3 : 1));
  const radius = Math.min(MAX_RADIUS, d.radius * (elite ? 1.3 : 1));
  const e: Enemy = {
    id: allocId(world), kind, x, y, vx: 0, vy: 0, angle: world.rng.next() * Math.PI * 2,
    hp, maxHp: hp, radius, elite, targetId: 0, spawnTick: world.tick,
    aiState: 0, aiTimer: 0, mem: {},
    contactDamage: Math.round(d.contact * (elite ? 1.5 : 1) * (1 + 0.04 * Math.max(0, world.pve.wave - 1))),
    scoreValue: d.score * (elite ? 3 : 1),
    xpValue: Math.round(d.xp * (elite ? 3 : 1) * (1 + 0.08 * Math.max(0, world.pve.wave - 1))),
  };
  // stagger AI cadence
  e.aiTimer = world.tick + world.rng.int(0, RETARGET_TICKS);
  // Rift: an enemy with no (leash-valid) target steers back here.
  if (world.dungeon) { e.mem.hx = x; e.mem.hy = y; }
  world.enemies.set(e.id, e);
  return e;
}

/** pve.bossAlive = any Hive or Matriarch still alive. */
export function refreshBossAlive(world: World): void {
  let any = false;
  for (const o of world.enemies.values()) if (o.kind === 'hive' || o.kind === 'matriarch') { any = true; break; }
  world.pve.bossAlive = any;
}

function removeEnemy(world: World, e: Enemy): void {
  world.enemies.delete(e.id);
  if (e.kind === 'hive' || e.kind === 'matriarch') refreshBossAlive(world);
  if (e.kind === 'matriarch') clearBossRef(world, e.id);
}

/** Rift: remove an enemy with no death effects and no event (regroup reset). Never rolls loot. */
export function discardEnemy(world: World, e: Enemy): void {
  if (world.enemies.get(e.id) === e) removeEnemy(world, e);
}

function waveHpScale(world: World): number {
  return 1 + 0.12 * Math.max(0, world.pve.wave - 1);
}

/** Removal without rewards (kamikaze / consumed). Never rolls loot. */
function vanish(world: World, e: Enemy): void {
  removeEnemy(world, e);
  emit(world, { t: 'enemyDeath', id: e.id, kind: e.kind, x: e.x, y: e.y, elite: e.elite });
  emit(world, { t: 'explode', x: e.x, y: e.y, radius: e.radius * 1.5, kind: 'shrapnel', team: ENEMY_TEAM });
}

/**
 * v0.3 in-world loot source for an enemy death (docs/v0.3-proposal.md §6.3), or null when it never drops:
 * the Hive → 'boss'; any other elite → 'elite'. The Matriarch's drop is the personal 'bossCache' (M4), not this.
 */
export function enemyLootSource(e: Enemy): LootSource | null {
  if (e.kind === 'hive') return 'boss';
  if (e.kind === 'matriarch') return null;
  return e.elite ? 'elite' : null;
}

/**
 * Kill with rewards (gems, score, death effects). Loot (§6.3 / §9 PVE M2): an elite or Hive killed by a ship
 * (killerShipId ≠ 0) rolls through rollLoot, which draws from side(world).lootRng only (never world.rng), so the core
 * rng stream is identical with loot on or off. A Spiked Prow ram kill is a ship kill and rolls like any other; the
 * "kamikaze deaths never drop" rule is the swarmer's own contact pop, which goes through vanish() and never gets here.
 * (M2 integration ruling: the Ram path's whole identity is killing swarmers by contact.)
 */
export function killEnemy(world: World, e: Enemy, killerShipId: EntityId): void {
  if (world.enemies.get(e.id) !== e) return;
  removeEnemy(world, e);
  dropGems(world, e.x, e.y, e.xpValue);
  const killer = killerShipId ? world.ships.get(killerShipId) : undefined;
  // captured now: the death effects below may kill / spill the killer, but the priority stays theirs
  const priorityPid = killer ? killer.playerId : 0;
  if (killer) { killer.score += e.scoreValue; killer.enemyKills++; }
  emit(world, { t: 'enemyDeath', id: e.id, kind: e.kind, x: e.x, y: e.y, elite: e.elite });
  const big = e.radius >= 30;
  emit(world, { t: 'explode', x: e.x, y: e.y, radius: big ? e.radius * 2.5 : e.radius * 1.6, kind: big ? 'bomb' : 'shrapnel', team: ENEMY_TEAM });

  const hpScale = waveHpScale(world);
  if (e.kind === 'splitter') {
    const n = e.elite ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const a = e.angle + (i * Math.PI * 2) / n;
      const s = spawnEnemy(world, 'splitling', e.x + Math.cos(a) * 12, e.y + Math.sin(a) * 12, { hpScale });
      if (s) { s.vx = Math.cos(a) * 260; s.vy = Math.sin(a) * 260; s.targetId = e.targetId; }
    }
  } else if (e.kind === 'blackhole') {
    const fed = e.mem.fed ?? 0;
    const r = 220 + e.radius * 2;
    emit(world, { t: 'explode', x: e.x, y: e.y, radius: r, kind: 'bomb', team: ENEMY_TEAM });
    splashDamage(world, e.x, e.y, r, 500 + 30 * fed, ENEMY_TEAM, 0);
    const n = Math.min(16, 5 + Math.floor(fed / 3));
    for (let i = 0; i < n; i++) {
      const a = (i * Math.PI * 2) / n;
      const s = spawnEnemy(world, 'drone', e.x + Math.cos(a) * 20, e.y + Math.sin(a) * 20, { hpScale });
      if (s) { s.vx = Math.cos(a) * 320; s.vy = Math.sin(a) * 320; }
    }
  } else if (e.kind === 'hive') {
    splashDamage(world, e.x, e.y, 260, 400, ENEMY_TEAM, 0);
  } else if (e.kind === 'matriarch') {
    matriarchDeathBlast(world, e);
  }

  // Loot last, so the death spawns above allocate the same entity ids whether loot is on or off.
  if (killerShipId !== 0) {
    const source = enemyLootSource(e);
    if (source) rollLoot(world, source, e.x, e.y, { priorityPid });
  }
  // v0.3 M4: the Matriarch drops a personal bossCache for every human of the party (whoever landed the kill).
  if (e.kind === 'matriarch') rollBossCache(world, e, priorityPid);
}

// ---------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------

/** Rift step in progress (set by stepEnemies; the AI helpers below read it instead of taking a world flag). */
let curRift = false;

/**
 * Rift leash (§4.4): a ship (or sentry) at (x, y), d2 px² away, is a valid target for `e` only when it is in the
 * enemy's own room, or within RIFT_LEASH_PX with line of sight. `myRoom` = roomIndexAt(e) (−1 = corridor).
 */
function leashOk(world: World, e: Enemy, myRoom: number, x: number, y: number, d2: number): boolean {
  if (myRoom >= 0 && roomIndexAt(world.map, x, y) === myRoom) return true;
  return d2 <= RIFT_LEASH_PX * RIFT_LEASH_PX && lineOfSight(world.map, e.x, e.y, x, y);
}

/** Rift retarget: nearest leash-valid ship (hunters: nearest ship within RIFT_HUNT_RANGE_PX). No rng draws. */
function riftRetarget(world: World, e: Enemy, kamikaze: boolean): void {
  const hunt = (e.mem.hunt ?? 0) > 0;
  const range = hunt ? RIFT_HUNT_RANGE_PX : PREFER_RANGE;
  const myRoom = roomIndexAt(world.map, e.x, e.y);
  let best: Ship | null = null, bestD = range * range;
  queryShips(world, e.x, e.y, range, shipBuf);
  for (let i = 0; i < shipBuf.length; i++) {
    const s = shipBuf[i];
    const dx = s.x - e.x, dy = s.y - e.y, d = dx * dx + dy * dy;
    if (d >= bestD) continue;
    if (!hunt && !leashOk(world, e, myRoom, s.x, s.y, d)) continue;
    bestD = d; best = s;
  }
  e.targetId = best ? best.id : 0;
  e.mem.dep = 0;
  if (kamikaze) {
    for (let i = 0; i < sentryBuf.length; i++) {
      const d = sentryBuf[i];
      const dx = d.x - e.x, dy = d.y - e.y, dd = dx * dx + dy * dy;
      if (dd >= bestD || !leashOk(world, e, myRoom, d.x, d.y, dd)) continue;
      bestD = dd; e.mem.dep = d.id; e.targetId = 0;
    }
  }
}

function retarget(world: World, e: Enemy, kamikaze: boolean): void {
  if (curRift) { riftRetarget(world, e, kamikaze); return; }
  let best: Ship | null = null, bestD = PREFER_RANGE * PREFER_RANGE;
  queryShips(world, e.x, e.y, PREFER_RANGE, shipBuf);
  for (let i = 0; i < shipBuf.length; i++) {
    const s = shipBuf[i];
    const dx = s.x - e.x, dy = s.y - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = s; }
  }
  e.targetId = best ? best.id : 0;
  e.mem.dep = 0;
  // Swarmers go for a sentry when it's closer than any ship.
  if (kamikaze) {
    for (let i = 0; i < sentryBuf.length; i++) {
      const d = sentryBuf[i];
      const dx = d.x - e.x, dy = d.y - e.y, dd = dx * dx + dy * dy;
      if (dd < bestD) { bestD = dd; e.mem.dep = d.id; e.targetId = 0; }
    }
  }
  if (!e.targetId && !e.mem.dep && world.rng.chance(0.3)) e.mem.wa = world.rng.next() * Math.PI * 2;
}

export function steer(e: Enemy, dvx: number, dvy: number, accel: number, dt: number): void {
  const k = Math.min(1, accel * dt);
  e.vx += (dvx - e.vx) * k;
  e.vy += (dvy - e.vy) * k;
}

export function fireShot(world: World, e: Enemy, angle: number, speed: number, damage: number, lifeSec: number): boolean {
  const p = spawnProjectile(world, {
    ...projectileDefaults(world),
    kind: 'enemyShot', ownerId: e.id, ownerPlayerId: 0, ownerTeam: ENEMY_TEAM,
    x: e.x + Math.cos(angle) * e.radius, y: e.y + Math.sin(angle) * e.radius,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    damage, radius: 6, level: e.elite ? 2 : 1, expireTick: world.tick + secToTicks(lifeSec),
  });
  return p !== null;
}

function weaverDodge(world: World, e: Enemy): void {
  // Look for a hostile projectile closing on us within ~260 px; sidestep perpendicular to it.
  let bestT = 0.6;
  let sx = 0, sy = 0;
  for (const p of world.projectiles.values()) {
    if (p.ownerTeam === ENEMY_TEAM || p.kind === 'mine') continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy > 260 * 260) continue;
    const rvx = p.vx - e.vx, rvy = p.vy - e.vy;
    const vv = rvx * rvx + rvy * rvy;
    if (vv < 1) continue;
    const t = (dx * rvx + dy * rvy) / vv; // time of closest approach
    if (t <= 0 || t > bestT) continue;
    const cx = dx - rvx * t, cy = dy - rvy * t; // miss vector at closest approach
    const miss = Math.sqrt(cx * cx + cy * cy);
    if (miss > e.radius + p.radius + 24) continue;
    bestT = t;
    const pl = Math.sqrt(vv);
    // perpendicular to projectile direction, on the side we're already on
    let px = -rvy / pl, py = rvx / pl;
    if (px * cx + py * cy < 0) { px = -px; py = -py; }
    sx = px; sy = py;
  }
  if (sx !== 0 || sy !== 0) {
    e.mem.dx = sx; e.mem.dy = sy; e.mem.du = world.tick + 18;
  }
}

/**
 * Point of the densest alive-ship cluster (→ e.mem.tx / ty; the enemy's own spot when there is none).
 * In a rift only leash-valid ships count, so a boss never locks onto a party outside its sealed room.
 */
export function densestShipPoint(world: World, e: Enemy): void {
  let bestN = -1, bx = e.x, by = e.y;
  const myRoom = curRift ? roomIndexAt(world.map, e.x, e.y) : -1;
  for (const s of world.ships.values()) {
    if (!s.alive) continue;
    if (curRift && !leashOk(world, e, myRoom, s.x, s.y, (s.x - e.x) ** 2 + (s.y - e.y) ** 2)) continue;
    let n = 0;
    for (const o of world.ships.values()) {
      if (!o.alive) continue;
      const dx = o.x - s.x, dy = o.y - s.y;
      if (dx * dx + dy * dy < 600 * 600) n++;
    }
    // tie-break toward closer groups
    const dx = s.x - e.x, dy = s.y - e.y;
    const score = n - Math.sqrt(dx * dx + dy * dy) / 5000;
    if (score > bestN) { bestN = score; bx = s.x; by = s.y; }
  }
  e.mem.tx = bx; e.mem.ty = by;
}

function blackholeEffects(world: World, e: Enemy, dt: number): void {
  const fed = e.mem.fed ?? 0;
  const R = Math.min(600, 450 + fed * 4);
  const R2 = R * R;
  // ships
  queryShips(world, e.x, e.y, R, shipBuf);
  for (let i = 0; i < shipBuf.length; i++) {
    const s = shipBuf[i];
    if (s.attachedTo) continue;
    const dx = e.x - s.x, dy = e.y - s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const a = 80 + 650 * (1 - d / R);
    s.vx += (dx / d) * a * dt; s.vy += (dy / d) * a * dt;
  }
  // gems
  for (const g of world.gems.values()) {
    const dx = e.x - g.x, dy = e.y - g.y, dd = dx * dx + dy * dy;
    if (dd > R2 || g.magnetTo) continue;
    const d = Math.sqrt(dd) || 1, a = 900 * (1 - d / R) + 100;
    g.vx += (dx / d) * a * dt; g.vy += (dy / d) * a * dt;
  }
  // projectiles
  for (const p of world.projectiles.values()) {
    if (p.kind === 'mine') continue;
    const dx = e.x - p.x, dy = e.y - p.y, dd = dx * dx + dy * dy;
    if (dd > R2) continue;
    const d = Math.sqrt(dd) || 1, a = 900 * (1 - d / R);
    p.vx += (dx / d) * a * dt; p.vy += (dy / d) * a * dt;
  }
  // enemies: pull, and consume those that fall in
  queryEnemies(world, e.x, e.y, R, enemyBuf2);
  for (let i = 0; i < enemyBuf2.length; i++) {
    const o = enemyBuf2[i];
    if (o === e || o.kind === 'blackhole' || o.kind === 'hive' || o.kind === 'matriarch') continue;
    if (!world.enemies.has(o.id)) continue;
    const dx = e.x - o.x, dy = e.y - o.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    if (d < e.radius) {
      vanish(world, o);
      e.mem.fed = (e.mem.fed ?? 0) + 1;
      e.radius = Math.min(MAX_RADIUS, e.radius + 1.2);
      e.hp += 120; e.maxHp += 120;
      e.xpValue += 1;
      continue;
    }
    const a = 500 * (1 - d / R) + 60;
    o.vx += (dx / d) * a * dt; o.vy += (dy / d) * a * dt;
  }
}

/** Enemies vs deployables: walls push enemies out; brute/hive smash walls + sentries; swarmers suicide into sentries. */
function deployableContact(world: World, e: Enemy, def: EnemyDef): boolean {
  const smasher = e.kind === 'brute' || e.kind === 'hive' || e.kind === 'matriarch';
  const ready = smasher && world.tick >= (e.mem.dc ?? 0);
  let smashed = false;
  for (let i = 0; i < wallBuf.length; i++) {
    const w = wallBuf[i];
    if (w.hp <= 0) continue;
    const hx = Math.cos(w.angle) * w.length * 0.5, hy = Math.sin(w.angle) * w.length * 0.5;
    const ax = w.x - hx, ay = w.y - hy, bx = w.x + hx, by = w.y + hy;
    const abx = bx - ax, aby = by - ay, l2 = abx * abx + aby * aby;
    let t = l2 > 0 ? ((e.x - ax) * abx + (e.y - ay) * aby) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + abx * t, cy = ay + aby * t;
    let nx = e.x - cx, ny = e.y - cy;
    const rr = e.radius + w.radius;
    const dd = nx * nx + ny * ny;
    if (dd >= rr * rr) continue;
    const d = Math.sqrt(dd);
    if (d < 0.01) {
      // dead center: push out along the wall normal, back the way we came
      nx = -Math.sin(w.angle); ny = Math.cos(w.angle);
      if (nx * e.vx + ny * e.vy > 0) { nx = -nx; ny = -ny; }
    } else { nx /= d; ny /= d; }
    e.x = cx + nx * rr; e.y = cy + ny * rr;
    const vn = e.vx * nx + e.vy * ny;
    if (vn < 0) { e.vx -= vn * nx; e.vy -= vn * ny; }
    if (ready) { w.hp -= e.contactDamage; smashed = true; }
  }
  for (let i = 0; i < sentryBuf.length; i++) {
    const d = sentryBuf[i];
    if (d.hp <= 0) continue;
    const dx = e.x - d.x, dy = e.y - d.y, rr = e.radius + d.radius;
    if (dx * dx + dy * dy >= rr * rr) continue;
    if (def.kamikaze) {
      d.hp -= e.contactDamage;
      vanish(world, e);
      return false;
    }
    if (ready) { d.hp -= e.contactDamage; smashed = true; }
    // keep enemies from sitting on top of sentries
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    e.x = d.x + (dx / dist) * rr; e.y = d.y + (dy / dist) * rr;
  }
  if (smashed) e.mem.dc = world.tick + CONTACT_CD_TICKS;
  return true;
}

const RAM_KEY = pathKey('ram');
function hasRamPath(s: Ship): boolean {
  return s.shipClass === PATHS.ram.classId && hasUpgrade(s.upgrades, RAM_KEY);
}

/**
 * Contact damage a ship takes from `e`, after Spiked Prow; applies Reactive Plating reflection, which
 * is 25% of the energy the ship actually lost (nothing while invulnerable / Unstoppable; after shield
 * and armor) — "contact damage you take".
 */
function hurtShip(world: World, e: Enemy, s: Ship, amount: number): void {
  const ram = hasRamPath(s);
  if (ram) amount *= RAM_CONTACT_TAKEN;
  const before = s.alive ? s.energy : 0;
  damageShip(world, s, amount, 0, 'enemy');
  const taken = before - Math.max(0, s.energy);
  if (ram && taken > 0 && hasUpgrade(s.upgrades, 'ram_plating') && world.enemies.get(e.id) === e) {
    damageEnemy(world, e, taken * PLATING_REFLECT, s.id);
  }
}

function contact(world: World, e: Enemy, def: EnemyDef): boolean {
  const n = queryShips(world, e.x, e.y, e.radius, shipBuf);
  if (n === 0) return true;
  if (def.kamikaze) {
    for (let i = 0; i < n; i++) {
      const s = shipBuf[i];
      const dx = e.x - s.x, dy = e.y - s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (s.invulnUntilTick > world.tick) {
        // bounce off spawn-protected ships
        e.vx = (dx / d) * 250; e.vy = (dy / d) * 250;
        continue;
      }
      if (hasRamPath(s)) {
        // Spiked Prow: the swarmer is destroyed by the ship (drops gems, credits the kill, elites roll loot)
        damageShip(world, s, e.contactDamage * RAM_CONTACT_TAKEN, 0, 'enemy');
        killEnemy(world, e, s.id);
        return false;
      }
      damageShip(world, s, e.contactDamage, 0, 'enemy');
      vanish(world, e);
      return false;
    }
    return true;
  }
  const ready = world.tick >= (e.mem.cr ?? 0);
  for (let i = 0; i < n; i++) {
    const s = shipBuf[i];
    const dx = s.x - e.x, dy = s.y - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / d, ny = dy / d;
    if (!s.attachedTo && def.knockback > 0) {
      // keep ships out of solid bodies
      const pen = e.radius + s.stats.radius - d;
      if (pen > 0) {
        s.x += nx * pen; s.y += ny * pen;
        // Rift floors are solid rock outside the rooms: never leave a pinned ship inside a wall (Arena / Warzone keep
        // the v0.2 behaviour, so their golden digest is unchanged; movement resolves the overlap there).
        if (world.dungeon) { const c = collideCircle(world.map, s.x, s.y, s.stats.radius); s.x = c.x; s.y = c.y; }
        // v0.5: a capital host's domes ride its hardpoints (they were seated in Sim pass 2, before this push), so the
        // snapshot and this tick's hit tests see them on the hull
        if (s.turrets.length) reseatTurrets(world, s);
      }
    }
    if (ready) {
      hurtShip(world, e, s, e.contactDamage);
      if (!s.attachedTo && def.knockback > 0) { s.vx += nx * def.knockback; s.vy += ny * def.knockback; }
      if (world.enemies.get(e.id) !== e) return false; // reflected to death
    }
  }
  if (ready) e.mem.cr = world.tick + CONTACT_CD_TICKS;
  return true;
}

function separate(world: World, e: Enemy): void {
  const n = queryEnemies(world, e.x, e.y, e.radius + 2, enemyBuf);
  let pushes = 0;
  for (let i = 0; i < n && pushes < 6; i++) {
    const o = enemyBuf[i];
    if (o === e || o.kind === 'blackhole') continue;
    const dx = e.x - o.x, dy = e.y - o.y;
    const dd = dx * dx + dy * dy;
    const rr = e.radius + o.radius;
    if (dd >= rr * rr) continue;
    const d = Math.sqrt(dd) || 0.01;
    const overlap = rr - d;
    // heavier (bigger) enemies get pushed less
    const w = o.radius / (e.radius + o.radius);
    const k = overlap * 0.6 * w;
    e.x += (dx / d) * k; e.y += (dy / d) * k;
    pushes++;
  }
}

/** Advance all enemies one tick. */
export function stepEnemies(world: World, dt: number): void {
  stepList.length = 0;
  for (const e of world.enemies.values()) stepList.push(e);
  wallBuf.length = 0; sentryBuf.length = 0;
  for (const d of world.deployables.values()) {
    if (d.kind === 'wall') wallBuf.push(d);
    else if (d.kind === 'sentry') sentryBuf.push(d);
  }
  const tick = world.tick;
  const map = world.map;
  const tSec = tick / TICK_RATE;
  const rift = !!world.dungeon;
  curRift = rift;

  for (let idx = 0; idx < stepList.length; idx++) {
    const e = stepList[idx];
    if (world.enemies.get(e.id) !== e) continue;
    // Rift dormancy (§4.4): no AI, no movement, no contact damage until the pack wakes.
    if (rift && e.mem.sleep === 1) {
      if (!sleeperWakes(world, e)) continue;
      wakeRoomSleepers(world, e.mem.room ?? -1);
      delete e.mem.sleep; // a sleeper without a room wakes alone
      e.aiTimer = tick;
    }
    const def = ENEMY_DEFS[e.kind];
    if (tick >= e.aiTimer) { retarget(world, e, def.kamikaze); e.aiTimer = tick + RETARGET_TICKS; }

    // Resolve the chase target: a ship, or (swarmers) a sentry.
    let target = false, tx = 0, ty = 0;
    if (e.targetId) {
      const s = world.ships.get(e.targetId);
      if (s && s.alive) { target = true; tx = s.x; ty = s.y; } else e.targetId = 0;
    } else if (e.mem.dep) {
      const d = world.deployables.get(e.mem.dep);
      if (d && d.hp > 0) { target = true; tx = d.x; ty = d.y; } else e.mem.dep = 0;
    }
    let tdx = 0, tdy = 0, td = 0;
    if (target) {
      tdx = tx - e.x; tdy = ty - e.y; td = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
      tdx /= td; tdy /= td;
    }
    const speed = def.speed * (e.elite ? 1.08 : 1);

    switch (e.kind) {
      case 'drone':
      case 'splitling':
      case 'splitter':
      case 'brute': {
        if (target) steer(e, tdx * speed, tdy * speed, def.accel, dt);
        else wander(e, speed, def.accel, dt);
        break;
      }
      case 'weaver': {
        if ((tick + e.id) % 4 === 0) weaverDodge(world, e);
        let vx = 0, vy = 0;
        if (target) {
          // gentle sinusoidal weave on the approach
          const w = Math.sin(tSec * 4 + e.id) * 0.45;
          vx = (tdx - tdy * w) * speed; vy = (tdy + tdx * w) * speed;
        }
        if ((e.mem.du ?? 0) > tick) { vx = vx * 0.3 + e.mem.dx * speed * 1.8; vy = vy * 0.3 + e.mem.dy * speed * 1.8; }
        if (target || (e.mem.du ?? 0) > tick) steer(e, vx, vy, def.accel * 2, dt);
        else wander(e, speed, def.accel, dt);
        break;
      }
      case 'dart': {
        // 0 = approach, 1 = telegraph (locked dir), 2 = dash, 3 = recover
        if (e.aiState === 0) {
          if (target) {
            steer(e, tdx * speed, tdy * speed, def.accel, dt);
            if (td < 650 && tick >= (e.mem.next ?? 0)) {
              e.aiState = 1; e.mem.until = tick + secToTicks(0.6);
            }
          } else wander(e, speed, def.accel, dt);
        } else if (e.aiState === 1) {
          steer(e, 0, 0, 8, dt);
          if (target) { e.mem.dx = tdx; e.mem.dy = tdy; }
          if (tick >= e.mem.until) { e.aiState = 2; e.mem.until = tick + secToTicks(0.5); }
        } else if (e.aiState === 2) {
          const ds = 780 * (e.elite ? 1.1 : 1);
          e.vx = (e.mem.dx ?? 1) * ds; e.vy = (e.mem.dy ?? 0) * ds;
          if (tick >= e.mem.until) { e.aiState = 3; e.mem.until = tick + secToTicks(0.4); }
        } else {
          steer(e, 0, 0, 4, dt);
          if (tick >= e.mem.until) { e.aiState = 0; e.mem.next = tick + secToTicks(1.2); }
        }
        break;
      }
      case 'spinner': {
        if (target) {
          let vx: number, vy: number;
          const orbitDir = e.id & 1 ? 1 : -1;
          if (td > 520) { vx = tdx * speed; vy = tdy * speed; }
          else if (td < 380) { vx = -tdx * speed; vy = -tdy * speed; }
          else { vx = -tdy * orbitDir * speed * 0.7; vy = tdx * orbitDir * speed * 0.7; }
          steer(e, vx, vy, def.accel, dt);
          // aiState 0 = resting, 1 = firing spiral
          if (e.aiState === 0) {
            if (td < 900 && tick >= (e.mem.until ?? 0)) { e.aiState = 1; e.mem.until = tick + secToTicks(2); }
          } else {
            if ((tick + e.id) % 7 === 0) {
              e.mem.spin = (e.mem.spin ?? 0) + 0.55;
              const dmg = 55 * (e.elite ? 1.5 : 1);
              fireShot(world, e, e.mem.spin, 260, dmg, 3);
              if (e.elite) fireShot(world, e, e.mem.spin + Math.PI, 260, dmg, 3);
            }
            if (tick >= e.mem.until) { e.aiState = 0; e.mem.until = tick + secToTicks(1.6); }
          }
        } else { wander(e, speed, def.accel, dt); e.aiState = 0; }
        break;
      }
      case 'blackhole': {
        if (target) steer(e, tdx * speed, tdy * speed, def.accel, dt);
        else if (rift) wander(e, speed, def.accel, dt); // rift: steer home
        else steer(e, 0, 0, def.accel, dt);
        blackholeEffects(world, e, dt);
        break;
      }
      case 'hive': {
        if ((tick + e.id) % 120 === 0 || e.mem.tx === undefined) densestShipPoint(world, e);
        const dx = (e.mem.tx ?? e.x) - e.x, dy = (e.mem.ty ?? e.y) - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d > 150) steer(e, (dx / d) * speed, (dy / d) * speed, def.accel, dt);
        else steer(e, 0, 0, def.accel, dt);
        if (tick >= (e.mem.spawn ?? e.spawnTick + secToTicks(2))) {
          e.mem.spawn = tick + secToTicks(3.5);
          const n = 3 + Math.floor(world.pve.wave / 5);
          if (world.enemies.size < MAX_ENEMIES - 10) {
            const hpScale = waveHpScale(world);
            for (let i = 0; i < n; i++) {
              const a = world.rng.next() * Math.PI * 2;
              const s = spawnEnemy(world, 'drone', e.x + Math.cos(a) * (e.radius + 14), e.y + Math.sin(a) * (e.radius + 14), { hpScale });
              if (s) { s.vx = Math.cos(a) * 240; s.vy = Math.sin(a) * 240; }
            }
          }
        }
        if (tick >= (e.mem.ring ?? e.spawnTick + secToTicks(3))) {
          e.mem.ring = tick + secToTicks(4.5);
          const n = 20;
          const off = (e.mem.ro = (e.mem.ro ?? 0) + 0.16);
          for (let i = 0; i < n; i++) if (!fireShot(world, e, off + (i * Math.PI * 2) / n, 240, 80, 3.5)) break;
        }
        break;
      }
      case 'matriarch': {
        stepMatriarch(world, e, target, tx, ty, speed, def.accel, dt);
        break;
      }
    }

    // integrate + walls
    e.x += e.vx * dt; e.y += e.vy * dt;
    const c = collideCircle(map, e.x, e.y, e.radius);
    if (c.hit) {
      e.x = c.x; e.y = c.y;
      const vn = e.vx * c.nx + e.vy * c.ny;
      if (vn < 0) { e.vx -= vn * c.nx * (e.kind === 'dart' ? 1.6 : 1); e.vy -= vn * c.ny * (e.kind === 'dart' ? 1.6 : 1); }
      if (e.kind === 'matriarch') matriarchWallImpact(world, e, c.nx, c.ny);
    }
    if (e.vx * e.vx + e.vy * e.vy > 4) e.angle = Math.atan2(e.vy, e.vx);
    if ((tick + e.id) % 2 === 0 && e.kind !== 'blackhole') separate(world, e);

    if ((wallBuf.length > 0 || sentryBuf.length > 0) && !deployableContact(world, e, def)) continue;
    if (e.kind === 'matriarch' && matriarchInIntro(world, e)) continue;
    contact(world, e, def);
  }
  stepList.length = 0;
  curRift = false;
}

/** No target: v0.2 wanders; a rift enemy steers home (mem.hx / hy) and settles there. */
function wander(e: Enemy, speed: number, accel: number, dt: number): void {
  if (curRift) {
    const hx = e.mem.hx, hy = e.mem.hy;
    if (hx === undefined || hy === undefined) { steer(e, 0, 0, accel, dt); return; }
    const dx = hx - e.x, dy = hy - e.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 24) { steer(e, 0, 0, accel, dt); return; }
    const k = (speed * Math.min(1, d / 200)) / d; // arrive: slow down over the last 200 px
    steer(e, dx * k, dy * k, accel, dt);
    return;
  }
  const a = e.mem.wa ?? e.angle;
  steer(e, Math.cos(a) * speed * 0.4, Math.sin(a) * speed * 0.4, accel, dt);
}

// ---------------------------------------------------------------------------------------------
// Rift dormancy (§4.4). A dormant enemy has mem.sleep = 1 and mem.room = its room idx; world.pve.mem['sleep<room>']
// = 1 while that room still holds sleepers (the rift director wakes a room when a ship enters it).
// ---------------------------------------------------------------------------------------------

/** pve.mem key flagging a room that still holds dormant enemies. */
export function sleepKey(room: number): string {
  return 'sleep' + room;
}

/** Damaged, or (every 6 ticks, staggered) a ship within RIFT_WAKE_PX with line of sight. */
function sleeperWakes(world: World, e: Enemy): boolean {
  if (e.hp < e.maxHp) return true;
  if ((world.tick + e.id) % 6 !== 0) return false;
  const n = queryShips(world, e.x, e.y, RIFT_WAKE_PX, shipBuf);
  for (let i = 0; i < n; i++) {
    const s = shipBuf[i];
    if (lineOfSight(world.map, e.x, e.y, s.x, s.y)) return true;
  }
  return false;
}

/** Wake every dormant enemy of `room` (room entry, or one of them was disturbed). Returns how many woke. */
export function wakeRoomSleepers(world: World, room: number): number {
  if (room < 0) return 0;
  delete world.pve.mem[sleepKey(room)];
  let n = 0;
  for (const o of world.enemies.values()) {
    if (o.mem.sleep !== 1 || o.mem.room !== room) continue;
    delete o.mem.sleep;
    o.aiTimer = world.tick;
    n++;
  }
  return n;
}
