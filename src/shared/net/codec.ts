// OWNER: ROOM agent. Frozen signatures (client + server).
// Binary snapshot layout, VERSION 5 (little-endian; docs/v0.3-proposal.md §8.9 — the proposal calls this
// layout "v4", but v0.2.1 already shipped VERSION 4, see ARCHITECTURE.md §5):
//   header : u8 version, u32 tick, u32 ackSeq, u16 nShips, u16 nEnemies, u16 nProjectiles, u16 nGems,
//            u16 nDeployables, u16 nLoot                                                        (21 B)
//   ship   : u32 id, u32 playerId, i8 team, u8 class, u16 x, u16 y (1/8 px), i16 vx, i16 vy (px/s), u8 angle,
//            u8 energyFrac, u8 flags, u8 level, u32 attachedTo, i8 turretSlot, u8 turretCount, u8 orbitals, u8 alive,
//            i8 pathIdx, u16 beamLen (px), u8 beamKind, u8 resonance                             (35 B)
//   enemy  : u32 id, u8 kind|elite<<7, u16 x, u16 y, u8 angle, u8 hpFrac, u16 radius (1/4 px)
//            (kind = index in ENEMY_KINDS, the EnemyKind union order; an unknown index decodes as 'drone')
//   proj   : u32 id, u8 kind|level<<4, u16 x, u16 y, i16 vx, i16 vy, i8 team, u32 ownerId
//   gem    : u32 id, u16 x, u16 y, u16 value
//   deploy : u32 id, u8 kind, u32 ownerId, i8 team, u16 x, u16 y, u8 angle, u8 hpFrac, u16 radius (1/4 px),
//            u16 length (px), u8 lifeFrac
//   loot   : u32 id, u16 x, u16 y (1/8 px), u8 rarity | setIdx<<3 (LOOT_SETS order), u32 reservedFor,
//            u8 lifeFrac                                                                          (14 B)
//   stats  : u8 hasYou; if 1: f32 x STAT_KEYS.length (fixed order), u8 nKnobs, nKnobs x (u8 knobIdx, f32 value)
//            (you.stats packed in binary: ~300 B instead of ~1 KB of JSON; f32 decoded to 7 significant digits)
//   tail   : u32 byteLength + UTF-8 JSON { you (minus stats), match, events, carry?, xs?, xk? } (numbers rounded
//            to 1e-3). carry = flat [shipId, n, best, ...] (Snapshot.carry). `match` (incl. timed / gameType /
//            subMode / dungeon / objective) is serialized once per MatchView object (WeakMap memo): the
//            SnapshotBuilder shares one MatchView between every viewer of a snapshot tick.
//            xs / xk = stat fields / skill knobs not in the known tables (forward-compat; normally absent)
// v0.5: the layout is unchanged (VERSION 5), but the knob table below is derived from SKILL_KNOBS + TURRET_KNOBS, so
// the capital knobs (capCooldown, capCost, broadside*, overcharge*, bay*) shift knob indices: that is what
// PROTOCOL_VERSION 5 covers (the hello refuses mixed builds). Capital state itself is derived client-side from
// ShipView.turretCount / turretSlot: no new ShipView fields.
import { SHIP_CLASS_IDS, SKILL_KNOBS, TURRET_KNOBS } from '../data/ships';
import {
  LOOT_SETS,
  type CarryView, type DeployableKind, type DeployableView, type EnemyKind, type EnemyView, type GemView, type LootSet,
  type LootView, type MatchView, type ProjectileKind, type ProjectileView, type Rarity, type ShipStats, type ShipView,
  type Snapshot, type YouState,
} from '../types';

/**
 * v4 (v0.2.1): ShipView.playerId widened u16 -> u32 (player ids are never reused, so long-lived servers pass 65535).
 * v5 (v0.3): nLoot header count + loot section, `carry` tail, ENEMY_KINDS += 'matriarch', memoized match JSON.
 */
export const CODEC_VERSION = 5;
const VERSION = CODEC_VERSION;
const HEADER = 1 + 4 + 4 + 2 * 6;
const SHIP_BYTES = 35;
const ENEMY_BYTES = 13;
const PROJ_BYTES = 18;
const GEM_BYTES = 10;
const DEPLOY_BYTES = 21;
const LOOT_BYTES = 14;

/** Wire order of EnemyKind: append-only, mirrors the union order in types.ts. */
const ENEMY_KINDS: readonly EnemyKind[] = [
  'drone', 'dart', 'weaver', 'splitter', 'splitling', 'spinner', 'blackhole', 'brute', 'hive', 'matriarch',
];
const PROJ_KINDS: readonly ProjectileKind[] = [
  'bullet', 'bomb', 'mine', 'shrapnel', 'seeker', 'enemyShot', 'rocket', 'plasma', 'singularity',
];
const DEPLOY_KINDS: readonly DeployableKind[] = ['sentry', 'wall', 'well', 'drone', 'fire', 'nanite'];
const deployIdx = new Map(DEPLOY_KINDS.map((k, i) => [k, i]));
const enemyIdx = new Map(ENEMY_KINDS.map((k, i) => [k, i]));
const projIdx = new Map(PROJ_KINDS.map((k, i) => [k, i]));
const classIdx = new Map(SHIP_CLASS_IDS.map((k, i) => [k, i]));
const lootSetIdx = new Map(LOOT_SETS.map((k, i) => [k, i]));

/** Every non-skill ShipStats field, in wire order (the Record type makes tsc flag contract drift). */
const STAT_KEY_TABLE: Record<Exclude<keyof ShipStats, 'skill'>, 0> = {
  radius: 0, maxEnergy: 0, rechargePerSec: 0, thrust: 0, maxSpeed: 0, afterburnerSpeed: 0, afterburnerCostPerSec: 0,
  turnRate: 0, gunDamage: 0, gunCost: 0, gunSpeed: 0, gunCooldown: 0, gunLife: 0, gunCount: 0, gunSpread: 0,
  gunPierce: 0, secondaryCooldown: 0, secondaryCost: 0, secondaryPower: 0, mobilityCooldown: 0, mobilityCost: 0,
  mobilityPower: 0, utilityCooldown: 0, utilityCost: 0, utilityPower: 0, healMult: 0, magnetRadius: 0, armor: 0,
  maxTurrets: 0, xpMult: 0, damageMult: 0,
};
const STAT_KEYS = Object.keys(STAT_KEY_TABLE) as (keyof typeof STAT_KEY_TABLE)[];
const STAT_KEY_SET = new Set<string>(STAT_KEYS);
/** All known skill + turret-kit knob keys, sorted (≤ 255). */
const KNOB_KEYS: string[] = [...new Set([
  ...Object.values(SKILL_KNOBS).flatMap((o) => Object.keys(o)),
  ...Object.values(TURRET_KNOBS).flatMap((o) => Object.keys(o)),
])].sort().slice(0, 255);
const knobIdx = new Map(KNOB_KEYS.map((k, i) => [k, i]));

/**
 * The binary knob table (index = wire knob id), for tests and tooling. Any change to it changes the wire: bump
 * PROTOCOL_VERSION (v0.5 took 5 for the capital knobs).
 */
export function codecKnobKeys(): string[] {
  return KNOB_KEYS.slice();
}
const f32 = (v: number): number => { const n = Number(v.toPrecision(7)); return Object.is(n, -0) ? 0 : n; };

const TWO_PI = Math.PI * 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const qPos = (v: number): number => { const q = Math.round(v * 8); return q < 0 ? 0 : q > 65535 ? 65535 : q; };
const qVel = (v: number): number => { const q = Math.round(v); return q < -32768 ? -32768 : q > 32767 ? 32767 : (q | 0); };
const qAng = (a: number): number => { let n = a % TWO_PI; if (n < 0) n += TWO_PI; return Math.round((n / TWO_PI) * 256) & 255; };
const qFrac = (f: number): number => { const q = Math.round(f * 255); return q < 0 ? 0 : q > 255 ? 255 : q; };
const qU8 = (v: number): number => { const q = Math.round(v); return q < 0 ? 0 : q > 255 ? 255 : q; };
const qI8 = (v: number): number => { const q = Math.round(v); return q < -128 ? -128 : q > 127 ? 127 : q; };
const qU16 = (v: number): number => { const q = Math.round(v); return q < 0 ? 0 : q > 65535 ? 65535 : q; };
const dAng = (q: number): number => (q / 256) * TWO_PI;

function roundReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
}

const json = (v: unknown): string => JSON.stringify(v, roundReplacer) ?? 'null';

/**
 * `match` JSON per MatchView object. A snapshot tick builds ONE MatchView (SnapshotBuilder.prepare) that every
 * viewer's snapshot shares, so it is serialized once per tick instead of once per viewer. A MatchView must not
 * be mutated after it has been encoded (the builder never does).
 */
const matchJsonMemo = new WeakMap<object, string>();
function matchJson(m: MatchView | null | undefined): string {
  if (!m || typeof m !== 'object') return 'null';
  let j = matchJsonMemo.get(m);
  if (j === undefined) { j = json(m); matchJsonMemo.set(m, j); }
  return j;
}

/** Snapshot.carry as a flat [shipId, n, best, ...] array (absent / empty = omitted). */
function flatCarry(c: readonly CarryView[] | undefined): number[] | undefined {
  if (!c || !c.length) return undefined;
  const out: number[] = new Array(c.length * 3);
  for (let i = 0; i < c.length; i++) {
    out[i * 3] = c[i].shipId >>> 0;
    out[i * 3 + 1] = Math.max(0, Math.round(c[i].n));
    out[i * 3 + 2] = Math.max(0, Math.min(4, Math.round(c[i].best)));
  }
  return out;
}

function unflatCarry(f: unknown): CarryView[] | undefined {
  if (!Array.isArray(f) || f.length < 3) return undefined;
  const out: CarryView[] = [];
  for (let i = 0; i + 2 < f.length; i += 3) {
    const shipId = Number(f[i]), n = Number(f[i + 1]), best = Number(f[i + 2]);
    if (!Number.isFinite(shipId) || !Number.isFinite(n) || !Number.isFinite(best)) continue;
    out.push({ shipId, n, best: Math.max(0, Math.min(4, best | 0)) as Rarity });
  }
  return out.length ? out : undefined;
}

/** Compact binary encoding (quantized; see ARCHITECTURE.md §Wire). decode(encode(s)) ≈ s. */
export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const st = s.you ? s.you.stats : null;
  let xs: Record<string, unknown> | undefined, xk: Record<string, number> | undefined;
  const knobs: [number, number][] = [];
  if (st) {
    for (const k in st) {
      if (k === 'skill' || STAT_KEY_SET.has(k)) continue;
      (xs ??= {})[k] = (st as unknown as Record<string, unknown>)[k];
    }
    const sk = st.skill ?? {};
    for (const k in sk) {
      const i = knobIdx.get(k);
      if (i === undefined) (xk ??= {})[k] = sk[k];
      else knobs.push([i, sk[k]]);
    }
  }
  // Assembled by hand so the shared `match` JSON is reused (see matchJson); the same shape as
  // JSON.stringify({ you, match, events, carry, xs, xk }).
  const carry = flatCarry(s.carry);
  let tailStr = `{"you":${s.you ? json({ ...s.you, stats: undefined }) : 'null'},"match":${matchJson(s.match)},"events":${json(s.events ?? [])}`;
  if (carry) tailStr += `,"carry":${JSON.stringify(carry)}`;
  if (xs) tailStr += `,"xs":${json(xs)}`;
  if (xk) tailStr += `,"xk":${json(xk)}`;
  tailStr += '}';
  const tail = encoder.encode(tailStr);
  const loot: readonly LootView[] = s.loot ?? [];
  const statBytes = 1 + (st ? STAT_KEYS.length * 4 + 1 + knobs.length * 5 : 0);
  const size = HEADER + s.ships.length * SHIP_BYTES + s.enemies.length * ENEMY_BYTES
    + s.projectiles.length * PROJ_BYTES + s.gems.length * GEM_BYTES + s.deployables.length * DEPLOY_BYTES
    + loot.length * LOOT_BYTES + statBytes + 4 + tail.length;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, VERSION); o += 1;
  dv.setUint32(o, s.tick >>> 0, true); o += 4;
  dv.setUint32(o, s.ackSeq >>> 0, true); o += 4;
  dv.setUint16(o, s.ships.length, true); o += 2;
  dv.setUint16(o, s.enemies.length, true); o += 2;
  dv.setUint16(o, s.projectiles.length, true); o += 2;
  dv.setUint16(o, s.gems.length, true); o += 2;
  dv.setUint16(o, s.deployables.length, true); o += 2;
  dv.setUint16(o, loot.length, true); o += 2;

  for (const v of s.ships) {
    dv.setUint32(o, v.id >>> 0, true);
    dv.setUint32(o + 4, v.playerId >>> 0, true);
    dv.setInt8(o + 8, qI8(v.team));
    dv.setUint8(o + 9, classIdx.get(v.shipClass) ?? 0);
    dv.setUint16(o + 10, qPos(v.x), true);
    dv.setUint16(o + 12, qPos(v.y), true);
    dv.setInt16(o + 14, qVel(v.vx), true);
    dv.setInt16(o + 16, qVel(v.vy), true);
    dv.setUint8(o + 18, qAng(v.angle));
    dv.setUint8(o + 19, qFrac(v.energyFrac));
    dv.setUint8(o + 20, v.flags & 255);
    dv.setUint8(o + 21, qU8(v.level));
    dv.setUint32(o + 22, v.attachedTo >>> 0, true);
    dv.setInt8(o + 26, qI8(v.turretSlot));
    dv.setUint8(o + 27, qU8(v.turretCount));
    dv.setUint8(o + 28, qU8(v.orbitals));
    dv.setUint8(o + 29, v.alive ? 1 : 0);
    dv.setInt8(o + 30, qI8(v.pathIdx));
    dv.setUint16(o + 31, qU16(v.beamLen), true);
    dv.setUint8(o + 33, qU8(v.beamKind));
    dv.setUint8(o + 34, qU8(v.resonance));
    o += SHIP_BYTES;
  }
  for (const e of s.enemies) {
    dv.setUint32(o, e.id >>> 0, true);
    dv.setUint8(o + 4, ((enemyIdx.get(e.kind) ?? 0) & 127) | (e.elite ? 128 : 0));
    dv.setUint16(o + 5, qPos(e.x), true);
    dv.setUint16(o + 7, qPos(e.y), true);
    dv.setUint8(o + 9, qAng(e.angle));
    dv.setUint8(o + 10, qFrac(e.hpFrac));
    dv.setUint16(o + 11, qU16(e.radius * 4), true);
    o += ENEMY_BYTES;
  }
  for (const p of s.projectiles) {
    dv.setUint32(o, p.id >>> 0, true);
    dv.setUint8(o + 4, ((projIdx.get(p.kind) ?? 0) & 15) | ((Math.max(0, Math.min(15, p.level | 0))) << 4));
    dv.setUint16(o + 5, qPos(p.x), true);
    dv.setUint16(o + 7, qPos(p.y), true);
    dv.setInt16(o + 9, qVel(p.vx), true);
    dv.setInt16(o + 11, qVel(p.vy), true);
    dv.setInt8(o + 13, qI8(p.team));
    dv.setUint32(o + 14, p.ownerId >>> 0, true);
    o += PROJ_BYTES;
  }
  for (const g of s.gems) {
    dv.setUint32(o, g.id >>> 0, true);
    dv.setUint16(o + 4, qPos(g.x), true);
    dv.setUint16(o + 6, qPos(g.y), true);
    dv.setUint16(o + 8, qU16(g.value), true);
    o += GEM_BYTES;
  }
  for (const d of s.deployables) {
    dv.setUint32(o, d.id >>> 0, true);
    dv.setUint8(o + 4, deployIdx.get(d.kind) ?? 0);
    dv.setUint32(o + 5, d.ownerId >>> 0, true);
    dv.setInt8(o + 9, qI8(d.team));
    dv.setUint16(o + 10, qPos(d.x), true);
    dv.setUint16(o + 12, qPos(d.y), true);
    dv.setUint8(o + 14, qAng(d.angle));
    dv.setUint8(o + 15, qFrac(d.hpFrac));
    dv.setUint16(o + 16, qU16(d.radius * 4), true);
    dv.setUint16(o + 18, qU16(d.length), true);
    dv.setUint8(o + 20, qFrac(d.lifeFrac));
    o += DEPLOY_BYTES;
  }
  for (const l of loot) {
    dv.setUint32(o, l.id >>> 0, true);
    dv.setUint16(o + 4, qPos(l.x), true);
    dv.setUint16(o + 6, qPos(l.y), true);
    dv.setUint8(o + 8, Math.max(0, Math.min(7, l.rarity | 0)) | ((lootSetIdx.get(l.set) ?? 0) << 3));
    dv.setUint32(o + 9, l.reservedFor >>> 0, true);
    dv.setUint8(o + 13, qFrac(l.lifeFrac));
    o += LOOT_BYTES;
  }
  dv.setUint8(o, st ? 1 : 0); o += 1;
  if (st) {
    for (const k of STAT_KEYS) { dv.setFloat32(o, +st[k], true); o += 4; }
    dv.setUint8(o, knobs.length); o += 1;
    for (const [i, v] of knobs) { dv.setUint8(o, i); dv.setFloat32(o + 1, +v, true); o += 5; }
  }
  dv.setUint32(o, tail.length, true); o += 4;
  new Uint8Array(buf, o, tail.length).set(tail);
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const dv = new DataView(buf);
  let o = 0;
  const ver = dv.getUint8(o); o += 1;
  if (ver !== VERSION) throw new Error(`decodeSnapshot: unsupported version ${ver}`);
  const tick = dv.getUint32(o, true); o += 4;
  const ackSeq = dv.getUint32(o, true); o += 4;
  const nS = dv.getUint16(o, true); o += 2;
  const nE = dv.getUint16(o, true); o += 2;
  const nP = dv.getUint16(o, true); o += 2;
  const nG = dv.getUint16(o, true); o += 2;
  const nD = dv.getUint16(o, true); o += 2;
  const nL = dv.getUint16(o, true); o += 2;

  const ships: ShipView[] = new Array(nS);
  for (let i = 0; i < nS; i++) {
    ships[i] = {
      id: dv.getUint32(o, true), playerId: dv.getUint32(o + 4, true), team: dv.getInt8(o + 8),
      shipClass: SHIP_CLASS_IDS[dv.getUint8(o + 9)] ?? 'brute',
      x: dv.getUint16(o + 10, true) / 8, y: dv.getUint16(o + 12, true) / 8,
      vx: dv.getInt16(o + 14, true), vy: dv.getInt16(o + 16, true), angle: dAng(dv.getUint8(o + 18)),
      energyFrac: dv.getUint8(o + 19) / 255, flags: dv.getUint8(o + 20), level: dv.getUint8(o + 21),
      attachedTo: dv.getUint32(o + 22, true), turretSlot: dv.getInt8(o + 26), turretCount: dv.getUint8(o + 27),
      orbitals: dv.getUint8(o + 28), alive: dv.getUint8(o + 29) !== 0,
      pathIdx: dv.getInt8(o + 30), beamLen: dv.getUint16(o + 31, true), beamKind: dv.getUint8(o + 33),
      resonance: dv.getUint8(o + 34),
    };
    o += SHIP_BYTES;
  }
  const enemies: EnemyView[] = new Array(nE);
  for (let i = 0; i < nE; i++) {
    const k = dv.getUint8(o + 4);
    enemies[i] = {
      id: dv.getUint32(o, true), kind: ENEMY_KINDS[k & 127] ?? 'drone', elite: (k & 128) !== 0,
      x: dv.getUint16(o + 5, true) / 8, y: dv.getUint16(o + 7, true) / 8, angle: dAng(dv.getUint8(o + 9)),
      hpFrac: dv.getUint8(o + 10) / 255, radius: dv.getUint16(o + 11, true) / 4,
    };
    o += ENEMY_BYTES;
  }
  const projectiles: ProjectileView[] = new Array(nP);
  for (let i = 0; i < nP; i++) {
    const k = dv.getUint8(o + 4);
    projectiles[i] = {
      id: dv.getUint32(o, true), kind: PROJ_KINDS[k & 15] ?? 'bullet', level: k >> 4,
      x: dv.getUint16(o + 5, true) / 8, y: dv.getUint16(o + 7, true) / 8,
      vx: dv.getInt16(o + 9, true), vy: dv.getInt16(o + 11, true), team: dv.getInt8(o + 13),
      ownerId: dv.getUint32(o + 14, true),
    };
    o += PROJ_BYTES;
  }
  const gems: GemView[] = new Array(nG);
  for (let i = 0; i < nG; i++) {
    gems[i] = { id: dv.getUint32(o, true), x: dv.getUint16(o + 4, true) / 8, y: dv.getUint16(o + 6, true) / 8, value: dv.getUint16(o + 8, true) };
    o += GEM_BYTES;
  }
  const deployables: DeployableView[] = new Array(nD);
  for (let i = 0; i < nD; i++) {
    deployables[i] = {
      id: dv.getUint32(o, true), kind: DEPLOY_KINDS[dv.getUint8(o + 4)] ?? 'sentry', ownerId: dv.getUint32(o + 5, true),
      team: dv.getInt8(o + 9), x: dv.getUint16(o + 10, true) / 8, y: dv.getUint16(o + 12, true) / 8,
      angle: dAng(dv.getUint8(o + 14)), hpFrac: dv.getUint8(o + 15) / 255, radius: dv.getUint16(o + 16, true) / 4,
      length: dv.getUint16(o + 18, true), lifeFrac: dv.getUint8(o + 20) / 255,
    };
    o += DEPLOY_BYTES;
  }
  const loot: LootView[] = new Array(nL);
  for (let i = 0; i < nL; i++) {
    const rs = dv.getUint8(o + 8);
    loot[i] = {
      id: dv.getUint32(o, true), x: dv.getUint16(o + 4, true) / 8, y: dv.getUint16(o + 6, true) / 8,
      rarity: Math.min(4, rs & 7) as Rarity, set: (LOOT_SETS[rs >> 3] ?? 'common') as LootSet,
      reservedFor: dv.getUint32(o + 9, true), lifeFrac: dv.getUint8(o + 13) / 255,
    };
    o += LOOT_BYTES;
  }
  let stats: ShipStats | null = null;
  if (dv.getUint8(o++)) {
    const top: Record<string, unknown> = {};
    for (const k of STAT_KEYS) { top[k] = f32(dv.getFloat32(o, true)); o += 4; }
    const skill: Record<string, number> = {};
    const nk = dv.getUint8(o++);
    for (let i = 0; i < nk; i++) { skill[KNOB_KEYS[dv.getUint8(o)] ?? `k${dv.getUint8(o)}`] = f32(dv.getFloat32(o + 1, true)); o += 5; }
    top.skill = skill;
    stats = top as unknown as ShipStats;
  }
  const len = dv.getUint32(o, true); o += 4;
  const tail = JSON.parse(decoder.decode(new Uint8Array(buf, o, len))) as {
    you: Omit<YouState, 'stats'> | null; match: Snapshot['match']; events: Snapshot['events'];
    carry?: unknown; xs?: Record<string, unknown>; xk?: Record<string, number>;
  };
  let you: YouState | null = null;
  if (tail.you) {
    const s2 = (stats ?? { skill: {} }) as unknown as Record<string, unknown>;
    if (tail.xs) Object.assign(s2, tail.xs);
    if (tail.xk) Object.assign(s2.skill as Record<string, number>, tail.xk);
    you = { ...tail.you, stats: s2 as unknown as ShipStats };
  }
  const out: Snapshot = {
    tick, ackSeq, you, ships, enemies, projectiles, gems, deployables, events: tail.events ?? [], match: tail.match,
  };
  // Absent = none (the same shape the SnapshotBuilder produces), so LocalTransport and ws clients agree.
  if (nL) out.loot = loot;
  const carry = unflatCarry(tail.carry);
  if (carry) out.carry = carry;
  return out;
}
