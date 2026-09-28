// OWNER: PVE agent. v0.3 Dungeon Runner boss: the Hive Matriarch (docs/v0.3-proposal.md §4.5, EnemyKind 'matriarch').
//
// She is spawned by the rift director when a boss room seals (rift.ts → spawnMatriarch) and stepped from
// enemies.stepEnemies (case 'matriarch' → stepMatriarch). All randomness is world.rng; she only exists in a rift.
//
// State lives in enemy.mem (numbers only):
//   intro   tick the 3 s intro ends (dmgTaken 0 until then; combat.damageEnemy multiplies by mem.dmgTaken ?? 1)
//   phase   1 | 2 | 3            party  party size at seal     team  party team        room  boss room idx
//   hpm     HP multiplier of her adds (party × difficulty × instability at seal; the tier scale is applied on top)
//   drone / ring / brood / dash  next-action ticks;  ring2 / gap  pending second ring + its gap angle
//   bdue / bx / by               pending Brood Burst (spawns RIFT_PULSE_WARN_TICKS after its spawnWarn)
//   ddx / ddy / until            dash direction and the end tick of the current dash state
// aiState: 0 = hive script, 1 = dash telegraph (0.8 s), 2 = dashing (0.6 s at 900 px/s).
import { ENEMY_TEAM, MAX_ENEMIES } from '../../constants';
import type { Enemy, EntityId, PlayerId, RiftRoom, TeamId, World } from '../../types';
import { splashDamage } from '../combat';
import { rollLoot } from '../loot';
import { isSolidAt } from '../map';
import { emit, secToTicks } from '../world';
import { densestShipPoint, fireShot, spawnEnemy, steer } from './enemies';
import { inRoomRect, RIFT_PULSE_WARN_TICKS, RIFT_WARN_RADIUS, RIFT_WARN_SEC, riftBossDownKey, tierHpScale } from './riftRules';

// ---- Tuning (§4.5) ----
export const MATRIARCH_INTRO_SEC = 3;
/** Phase 2 below 66% HP, phase 3 below 33%. */
export const MATRIARCH_P2_FRAC = 0.66;
export const MATRIARCH_P3_FRAC = 0.33;
/** P1–P2: (4 + party) drones every 3 s; P3: every 2 s. */
export const MATRIARCH_DRONE_BASE = 4;
export const MATRIARCH_DRONE_SEC = 3;
export const MATRIARCH_DRONE_SEC_P3 = 2;
export const MATRIARCH_RING_SEC = 4.5;
export const MATRIARCH_RING_SHOTS = 20;
export const MATRIARCH_RING_SPEED = 240;
export const MATRIARCH_RING_DAMAGE = 80;
export const MATRIARCH_RING_LIFE_SEC = 3.5;
/** P2+: rings become double rings, 0.35 s apart, sharing one 60° gap. */
export const MATRIARCH_DOUBLE_RING_SEC = 0.35;
export const MATRIARCH_RING_GAP = Math.PI / 3;
/** P2+: Brood Burst, 3 splitters at the densest ship cluster every 8 s (spawnWarn first). */
export const MATRIARCH_BROOD_SEC = 8;
export const MATRIARCH_BROOD_COUNT = 3;
/** P3: Frenzy, every 6 s a 0.8 s line telegraph then a 0.6 s dash at 900 px/s. */
export const MATRIARCH_DASH_EVERY_SEC = 6;
export const MATRIARCH_DASH_WARN_SEC = 0.8;
export const MATRIARCH_DASH_SEC = 0.6;
export const MATRIARCH_DASH_SPEED = 900;
/** A dash that hits a wall ends there and spawns this many splitlings. */
export const MATRIARCH_IMPACT_SPLITLINGS = 4;
/** Floor 6+ variant: one Hive add at HP ×0.6 at each phase threshold (MAX_HIVES respected). */
export const MATRIARCH_ADD_FLOOR = 6;
export const MATRIARCH_ADD_HIVE_HP = 0.6;
/** Death: the Hive-style splash (400 damage, r 300). */
export const MATRIARCH_DEATH_SPLASH_R = 300;
export const MATRIARCH_DEATH_SPLASH_DMG = 400;
/** Same cap as waves.MAX_HIVES. */
const MAX_HIVES = 2;
/** First Brood Burst / dash this long after entering P2 / P3. */
const BROOD_FIRST_SEC = 2;
const DASH_FIRST_SEC = 1.5;
/** First drones / ring after the intro. */
const DRONE_FIRST_SEC = 1;
const RING_FIRST_SEC = 1.5;

/** Spawn the Matriarch at the boss room centre (bossIntro, dmgTaken 0 for the intro). Null at the enemy cap. */
export function spawnMatriarch(
  world: World, room: RiftRoom, partySize: number, team: TeamId, bossHpMult: number, addHpMult: number,
): Enemy | null {
  const tier = world.pve.wave;
  const e = spawnEnemy(world, 'matriarch', room.x, room.y, { hpScale: tierHpScale(tier) * bossHpMult });
  if (!e) return null;
  const t = world.tick;
  const intro = t + secToTicks(MATRIARCH_INTRO_SEC);
  const m = e.mem;
  m.intro = intro;
  m.dmgTaken = 0;
  m.phase = 1;
  m.party = Math.max(1, Math.floor(partySize) || 1);
  m.team = team;
  m.room = room.idx;
  m.hpm = addHpMult;
  m.drone = intro + secToTicks(DRONE_FIRST_SEC);
  m.ring = intro + secToTicks(RING_FIRST_SEC);
  m.ring2 = 0;
  m.brood = 0;
  m.bdue = 0;
  m.dash = 0;
  e.angle = Math.PI / 2;
  const d = world.dungeon;
  if (d) { d.bossId = e.id; d.bossPhase = 1; }
  world.pve.bossAlive = true;
  emit(world, { t: 'bossIntro', id: e.id, kind: 'matriarch', x: e.x, y: e.y });
  return e;
}

/** True during her 3 s intro (no attacks, no contact damage, damage ×0). */
export function matriarchInIntro(world: World, e: Enemy): boolean {
  return world.tick < (e.mem.intro ?? 0);
}

/** Phase for an HP fraction: 1 (≥ 66%), 2 (≥ 33%), 3 (< 33%). */
export function matriarchPhaseFor(hpFrac: number): 1 | 2 | 3 {
  return hpFrac < MATRIARCH_P3_FRAC ? 3 : hpFrac < MATRIARCH_P2_FRAC ? 2 : 1;
}

function roomOf(world: World, e: Enemy): RiftRoom | null {
  const rooms = world.map.dungeon?.rooms;
  const i = e.mem.room ?? -1;
  return rooms && i >= 0 && i < rooms.length ? rooms[i] : null;
}

/** Open tile, and inside her room when she has one (adds must count toward the room clear). */
function spotOk(world: World, room: RiftRoom | null, x: number, y: number): boolean {
  if (isSolidAt(world.map, x, y)) return false;
  return !room || inRoomRect(room, world.map.tileSize, x, y);
}

function addHpScale(world: World, e: Enemy): number {
  return tierHpScale(world.pve.wave) * (e.mem.hpm ?? 1);
}

function spawnDrones(world: World, e: Enemy): void {
  if (world.enemies.size >= MAX_ENEMIES - 10) return;
  const n = MATRIARCH_DRONE_BASE + (e.mem.party ?? 1);
  const hpScale = addHpScale(world, e);
  const room = roomOf(world, e);
  for (let i = 0; i < n; i++) {
    const a = world.rng.next() * Math.PI * 2;
    let x = e.x + Math.cos(a) * (e.radius + 14), y = e.y + Math.sin(a) * (e.radius + 14);
    if (!spotOk(world, room, x, y)) { x = e.x; y = e.y; } // against a wall: launch from her centre instead
    const s = spawnEnemy(world, 'drone', x, y, { hpScale });
    if (s) { s.vx = Math.cos(a) * 240; s.vy = Math.sin(a) * 240; }
  }
}

/** One 20-shot ring; with `gap` ≥ 0, shots within ±30° of that angle are skipped (the escape lane). */
function fireRing(world: World, e: Enemy, offset: number, gap: number): void {
  const n = MATRIARCH_RING_SHOTS, half = MATRIARCH_RING_GAP / 2;
  for (let i = 0; i < n; i++) {
    const a = offset + (i * Math.PI * 2) / n;
    if (gap >= 0) {
      let da = Math.abs(a - gap) % (Math.PI * 2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      if (da < half) continue;
    }
    if (!fireShot(world, e, a, MATRIARCH_RING_SPEED, MATRIARCH_RING_DAMAGE, MATRIARCH_RING_LIFE_SEC)) break;
  }
}

function spawnBrood(world: World, e: Enemy): void {
  const room = roomOf(world, e);
  const hpScale = addHpScale(world, e);
  const bx = e.mem.bx ?? e.x, by = e.mem.by ?? e.y;
  for (let i = 0; i < MATRIARCH_BROOD_COUNT; i++) {
    const a = (i * Math.PI * 2) / MATRIARCH_BROOD_COUNT + (e.mem.gap ?? 0);
    let x = bx + Math.cos(a) * 70, y = by + Math.sin(a) * 70;
    if (!spotOk(world, room, x, y)) { x = bx; y = by; }
    if (!spotOk(world, room, x, y)) { x = e.x; y = e.y; }
    spawnEnemy(world, 'splitter', x, y, { hpScale });
  }
}

function spawnHiveAdd(world: World, e: Enemy): void {
  let hives = 0;
  for (const o of world.enemies.values()) if (o.kind === 'hive') hives++;
  if (hives >= MAX_HIVES) return;
  const room = roomOf(world, e);
  const a0 = world.rng.next() * Math.PI * 2;
  for (let k = 0; k < 8; k++) {
    const a = a0 + (k * Math.PI) / 4;
    const x = e.x + Math.cos(a) * (e.radius + 110), y = e.y + Math.sin(a) * (e.radius + 110);
    if (!spotOk(world, room, x, y)) continue;
    const h = spawnEnemy(world, 'hive', x, y, { hpScale: addHpScale(world, e) * MATRIARCH_ADD_HIVE_HP });
    if (h) world.pve.bossAlive = true;
    return;
  }
}

/** Advance her phase to match her HP (one bossPhase event per threshold crossed; floor 6+ Hive adds). */
export function updateMatriarchPhase(world: World, e: Enemy): void {
  const want = matriarchPhaseFor(e.maxHp > 0 ? e.hp / e.maxHp : 0);
  const floor = world.dungeon?.floor ?? 1;
  while ((e.mem.phase ?? 1) < want) {
    const p = (e.mem.phase ?? 1) + 1;
    e.mem.phase = p;
    const d = world.dungeon;
    if (d && d.bossId === e.id) d.bossPhase = p;
    if (p === 2) e.mem.brood = world.tick + secToTicks(BROOD_FIRST_SEC);
    if (p === 3) e.mem.dash = world.tick + secToTicks(DASH_FIRST_SEC);
    emit(world, { t: 'bossPhase', id: e.id, kind: e.kind, phase: p, x: e.x, y: e.y });
    if (floor >= MATRIARCH_ADD_FLOOR) spawnHiveAdd(world, e);
  }
}

/** Distance her body can travel along (dx, dy) before touching a wall, up to maxLen (16 px steps). */
function clearRun(world: World, e: Enemy, dx: number, dy: number, maxLen: number): number {
  for (let s = 16; s <= maxLen; s += 16) {
    if (isSolidAt(world.map, e.x + dx * (s + e.radius), e.y + dy * (s + e.radius))) return Math.max(0, s - 16);
  }
  return maxLen;
}

function startDash(world: World, e: Enemy, hasTarget: boolean, tx: number, ty: number): void {
  let ax = hasTarget ? tx : e.mem.tx ?? e.x, ay = hasTarget ? ty : e.mem.ty ?? e.y;
  let dx = ax - e.x, dy = ay - e.y;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1) { dx = Math.cos(e.angle); dy = Math.sin(e.angle); d = 1; ax = e.x + dx; ay = e.y + dy; }
  dx /= d; dy /= d;
  const len = clearRun(world, e, dx, dy, MATRIARCH_DASH_SPEED * MATRIARCH_DASH_SEC);
  e.aiState = 1;
  e.mem.ddx = dx; e.mem.ddy = dy;
  e.mem.until = world.tick + secToTicks(MATRIARCH_DASH_WARN_SEC);
  e.mem.dash = world.tick + secToTicks(MATRIARCH_DASH_EVERY_SEC);
  emit(world, {
    t: 'telegraph', shape: 'line', x: e.x, y: e.y, x2: e.x + dx * len, y2: e.y + dy * len, r: e.radius,
    sec: MATRIARCH_DASH_WARN_SEC,
  });
}

function endDash(e: Enemy): void {
  e.aiState = 0;
  e.vx *= 0.25; e.vy *= 0.25;
}

/**
 * One AI tick (called from stepEnemies with the leashed chase target). Movement and velocity only; stepEnemies
 * integrates, collides (→ matriarchWallImpact) and applies contact damage (skipped during the intro).
 */
export function stepMatriarch(
  world: World, e: Enemy, hasTarget: boolean, tx: number, ty: number, speed: number, accel: number, dt: number,
): void {
  const tick = world.tick, m = e.mem;
  if (tick < (m.intro ?? 0)) {
    // Intro: invulnerable (dmgTaken 0; the HP reset is a belt-and-braces guard) and idle.
    m.dmgTaken = 0;
    if (e.hp < e.maxHp) e.hp = e.maxHp;
    steer(e, 0, 0, 4, dt);
    return;
  }
  if (m.dmgTaken !== 1) m.dmgTaken = 1;
  updateMatriarchPhase(world, e);
  const phase = m.phase ?? 1;

  // Movement / Frenzy dash.
  if (e.aiState === 1) {
    steer(e, 0, 0, 8, dt);
    if (tick >= (m.until ?? 0)) { e.aiState = 2; m.until = tick + secToTicks(MATRIARCH_DASH_SEC); }
  } else if (e.aiState === 2) {
    e.vx = (m.ddx ?? 1) * MATRIARCH_DASH_SPEED; e.vy = (m.ddy ?? 0) * MATRIARCH_DASH_SPEED;
    if (tick >= (m.until ?? 0)) endDash(e);
  } else {
    if ((tick + e.id) % 120 === 0 || m.tx === undefined) densestShipPoint(world, e);
    const dx = (m.tx ?? e.x) - e.x, dy = (m.ty ?? e.y) - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    if (d > 150) steer(e, (dx / d) * speed, (dy / d) * speed, accel, dt);
    else steer(e, 0, 0, accel, dt);
    if (phase >= 3 && tick >= (m.dash ?? 0)) startDash(world, e, hasTarget, tx, ty);
  }

  // Hive script: drones.
  if (tick >= (m.drone ?? 0)) {
    m.drone = tick + secToTicks(phase >= 3 ? MATRIARCH_DRONE_SEC_P3 : MATRIARCH_DRONE_SEC);
    spawnDrones(world, e);
  }
  // Rings (P2+: double rings with a shared 60° gap).
  if (tick >= (m.ring ?? 0)) {
    m.ring = tick + secToTicks(MATRIARCH_RING_SEC);
    const off = (m.ro = (m.ro ?? 0) + 0.16);
    if (phase >= 2) {
      const gap = world.rng.next() * Math.PI * 2;
      m.gap = gap;
      fireRing(world, e, off, gap);
      m.ring2 = tick + secToTicks(MATRIARCH_DOUBLE_RING_SEC);
    } else fireRing(world, e, off, -1);
  }
  if ((m.ring2 ?? 0) > 0 && tick >= m.ring2) {
    m.ring2 = 0;
    // second ring offset by half a step, so it covers the first ring's lanes (same gap)
    fireRing(world, e, (m.ro ?? 0) + Math.PI / MATRIARCH_RING_SHOTS, m.gap ?? 0);
  }
  // Brood Burst (P2+).
  if (phase >= 2 && !(m.bdue ?? 0) && tick >= (m.brood ?? 0)) {
    densestShipPoint(world, e);
    m.bx = m.tx ?? e.x; m.by = m.ty ?? e.y;
    m.bdue = tick + RIFT_PULSE_WARN_TICKS;
    m.brood = tick + secToTicks(MATRIARCH_BROOD_SEC);
    emit(world, { t: 'spawnWarn', x: m.bx, y: m.by, radius: RIFT_WARN_RADIUS, sec: RIFT_WARN_SEC });
  }
  if ((m.bdue ?? 0) > 0 && tick >= m.bdue) {
    m.bdue = 0;
    spawnBrood(world, e);
  }
}

/** Dash into a wall (stepEnemies' collision): 4 splitlings burst off the wall and the dash ends. */
export function matriarchWallImpact(world: World, e: Enemy, nx: number, ny: number): void {
  if (e.aiState !== 2) return;
  endDash(e);
  const hpScale = addHpScale(world, e);
  const base = Math.atan2(ny, nx);
  for (let i = 0; i < MATRIARCH_IMPACT_SPLITLINGS; i++) {
    const a = base + ((i / (MATRIARCH_IMPACT_SPLITLINGS - 1)) - 0.5) * (Math.PI * 2 / 3);
    const s = spawnEnemy(world, 'splitling', e.x + Math.cos(a) * (e.radius * 0.6), e.y + Math.sin(a) * (e.radius * 0.6), { hpScale });
    if (s) { s.vx = Math.cos(a) * 265; s.vy = Math.sin(a) * 265; }
  }
  emit(world, { t: 'explode', x: e.x - nx * e.radius, y: e.y - ny * e.radius, radius: 120, kind: 'bomb', team: ENEMY_TEAM });
}

/** Death blast (before loot): the Hive splash at r 300. */
export function matriarchDeathBlast(world: World, e: Enemy): void {
  splashDamage(world, e.x, e.y, MATRIARCH_DEATH_SPLASH_R, MATRIARCH_DEATH_SPLASH_DMG, ENEMY_TEAM, 0);
}

/** Humans of her party (not extracted): the bossCache recipients. */
export function bossCacheRecipients(world: World, team: TeamId): PlayerId[] {
  const out: PlayerId[] = [];
  for (const s of world.ships.values()) {
    if (s.isBot || s.team !== team || s.skillState.rOut) continue;
    out.push(s.playerId);
  }
  return out;
}

/**
 * bossCache (personal, every human of the party) at her death spot. Last in killEnemy, after every death spawn.
 * Records the kill for the floor first (riftBossDownKey): a regroup reset of her room can never bring her back or
 * roll a second set.
 */
export function rollBossCache(world: World, e: Enemy, priorityPid: PlayerId): void {
  const key = riftBossDownKey(e.mem.room ?? -1);
  if (world.pve.mem[key]) return;
  world.pve.mem[key] = 1;
  const personalFor = bossCacheRecipients(world, e.mem.team ?? 0);
  if (personalFor.length === 0) return;
  rollLoot(world, 'bossCache', e.x, e.y, { priorityPid: priorityPid || personalFor[0], personalFor });
}

/** She died or was removed: clear the rift's boss pointer (RiftView.boss → null). */
export function clearBossRef(world: World, id: EntityId): void {
  const d = world.dungeon;
  if (d && d.bossId === id) d.bossId = 0;
}
