// v1.0 "Shields Down" — aggregate Dungeon Runner swarm model (SCRATCH, not project code).
//
// Abstraction: 1-D "distance to my target" per enemy (no map), a party of bots following the §14 rules, the rift
// director's pulse / hall / key / boss structure (pve/rift.ts + riftRules.ts, current code) with the §15 Threat ramp on
// top, the §2 pipeline and §3/§4 meters (core.mjs applyHit + regen rules), §9 kits, Artificer Ray / Pulse.
// A 'legacy' mode reproduces v0.x (energy = health = ammo, no threat) as a calibration anchor: the real gate says
// 4 normal bots clear floor 1 (seed 1234) in ~98 s with no deaths, and 6 floors in ~22 min with <= 1 death.
//
// Assumptions (all knobs are at the top of this file):
//   spawn distance U(300, 700) px; closing speed x closeFactor (kiting: Jugg 1.0 / Art 0.85 / Arc 0.7);
//   kamikaze touch lands with p (drone .9, weaver .85, dart .6, splitling .9); weapon accuracy vs swarm MD .75,
//   laser .9, phaser .7 (x0.7 vs weavers); enemies pick a target weighted by aggro (Jugg 1.3, Art 1, Arc .8);
//   brute / blackhole close at 25% (kited), knockback resets them to 150 px;
//   spinner: 0.35 hits/s while in its 2 s spiral (of every 3.6 s); travel 10 s between rooms; auto-weapon DPS
//   per pilot (typical progression) = 100 x min(8, f - 1) AoE over the 4 nearest.
import {
  CLS, WPN, DEFAULT_WEAPON, TUNE, makeGun, falloff, hotMult, applyHit, SM, HM, ARMOR_CAP,
  STRAIN_DRAW, STRAIN_SHIELD, BROWN, FIRE_WIN, FIRE_MULT, IDLE_MULT, rng, f0, f1, f2, table,
} from './core.mjs';

const DT = 0.05;
// ---------------- enemies (pve/enemies.ts ENEMY_DEFS) ----------------
const ED = {
  drone: { r: 13, hp: 160, speed: 175, contact: 110, kam: true, hitP: 0.9, cost: 1 },
  dart: { r: 11, hp: 130, speed: 260, contact: 160, kam: true, hitP: 0.6, cost: 1 }, // dash averaged in
  weaver: { r: 13, hp: 210, speed: 215, contact: 120, kam: true, hitP: 0.85, cost: 1, dodge: 0.7 },
  splitter: { r: 18, hp: 380, speed: 140, contact: 90, kam: false, every: 0.75, cost: 2 },
  splitling: { r: 9, hp: 80, speed: 265, contact: 60, kam: true, hitP: 0.9, cost: 1 },
  spinner: { r: 15, hp: 420, speed: 180, contact: 80, kam: false, shooter: true, cost: 2 },
  brute: { r: 34, hp: 2400, speed: 90, contact: 240, kam: false, every: 1.0, cost: 5 },
  blackhole: { r: 30, hp: 1800, speed: 35, contact: 180, kam: false, every: 0.5, cost: 6 },
  hive: { r: 70, hp: 9000, speed: 50, contact: 320, kam: false, every: 1.0, cost: 20, hive: true },
  matriarch: { r: 88, hp: 30000, speed: 60, contact: 320, kam: false, cost: 50, boss: true },
};
const KAMI = new Set(['drone', 'dart', 'weaver', 'splitling']);
const DIFF = { 1: { hp: 0.7, count: 0.8, lives: 3, D: 0.6 }, 2: { hp: 1, count: 1, lives: 0, D: 1.0 }, 3: { hp: 1.4, count: 1.25, lives: -3, D: 1.5 } };
const PLANS = [
  { main: ['E', 'H', 'A', 'H', 'A', 'K'], br: 1 }, { main: ['E', 'H', 'A', 'H', 'A', 'K'], br: 1 },
  { main: ['E', 'H', 'A', 'H', 'A', 'H', 'B'], br: 1 }, { main: ['E', 'H', 'A', 'H', 'A', 'A', 'K'], br: 2 },
  { main: ['E', 'H', 'A', 'A', 'H', 'A', 'K'], br: 2 }, { main: ['E', 'H', 'A', 'H', 'A', 'H', 'A', 'B'], br: 2 },
];
const tierOf = (f) => 1 + 2 * (f - 1);
const tierHp = (t) => 1 + 0.12 * Math.max(0, t - 1);
const partyCount = (n) => 1 + 0.3 * (n - 1), partyHp = (n) => 1 + 0.25 * (n - 1), partyBoss = (n) => 1 + 0.6 * (n - 1);
function kindWeights(f, e) {
  const t = [['drone', 10], ['dart', 4], ['weaver', 3]];
  if (f >= 2) t.push(['splitter', 3], ['spinner', 2]);
  if (f >= 3) t.push(['brute', 1.2]);
  if (f >= 5) t.push(['blackhole', 0.3]);
  const fav = f <= 3 ? ['drone', 'splitter'] : ['spinner', 'weaver'];
  for (const r of t) {
    if (fav.includes(r[0])) r[1] *= 1.5;
    if (e > 0 && (r[0] === 'dart' || r[0] === 'weaver')) r[1] *= 1 + 0.15 * e;
    if (e > 0 && r[0] === 'spinner') r[1] *= 1 + 0.1 * e;
  }
  return t;
}
// ---------------- §15 threat ----------------
let THREAT_RATE = 0.35, THREAT_HP = 0.1;
function threatOf(f, floorSec, rooms, D) {
  const teff = Math.min(floorSec, 420) + 3 * Math.max(0, floorSec - 420);
  return 1 + 0.4 * (f - 1) + THREAT_RATE * D * teff / 60 + 0.2 * rooms;
}
function fx(T) {
  const e = Math.max(0, T - 1);
  return {
    e, budget: Math.min(2.2, 1 + 0.2 * e), hp: 1 + THREAT_HP * e, speed: Math.min(1.3, 1 + 0.05 * e), dmg: Math.min(1.5, 1 + 0.08 * e),
    elite: Math.min(0.15, 0.05 + 0.015 * e), next: Math.min(0.5, 0.3 + 0.04 * e), maxWait: Math.max(7, 14 - 1.2 * e), minGap: Math.max(1.5, 3 - 0.25 * e),
    packs: 1 + 0.15 * e,
  };
}
const FX1 = fx(1);

// ---------------- pilots ----------------
const AGGRO = { brute: 1.3, engineer: 1.0, tech: 0.8 };
const CLOSE = { brute: 1.0, engineer: 0.85, tech: 0.7 };
const ACC = { massdriver: 0.75, laser: 0.9, phaser: 0.7 };
const REL = { massdriver: 92, laser: 97, phaser: 85 };
const RETREAT_R = { brute: 0.35, engineer: 0.45, tech: 0.55 };
// v0.x legacy primaries (data/ships.ts base)
const LEGACY = {
  brute: { E: 1800, rech: 230, armor: 0.1, dmg: 140, cd: 11 / 60, cost: 32, range: 850 * 0.9 },
  tech: { E: 1100, rech: 290, armor: 0, dmg: 115, cd: 9 / 60, cost: 28, range: 1000 * 1.2 },
  engineer: { E: 1300, rech: 260, armor: 0, dmg: 70, cd: 6 / 60, cost: 18, range: 1100 * 0.9 },
};

function progression(profile, f) {
  if (profile === 'none') return { dmg: 1, auto: 0, shield: 1, hull: 1, preg: 1, heal: 1 };
  const k = f - 1;
  if (profile === 'strong') return { dmg: 1 + 0.12 * k, auto: 150 * Math.min(8, k), shield: 1 + 0.07 * k, hull: 1 + 0.07 * k, preg: 1 + 0.05 * k, heal: 1 + 0.1 * k };
  return { dmg: Math.min(1.72, 1 + 0.08 * k), auto: 100 * Math.min(8, k), shield: Math.min(1.36, 1 + 0.04 * k), hull: Math.min(1.36, 1 + 0.04 * k), preg: 1 + 0.03 * k, heal: 1 + 0.05 * k };
}

function mkPilot(cls, prog, legacy, idx) {
  const c = CLS[cls];
  const p = {
    idx, cls, c, legacy, alive: true, deadUntil: 0, deaths: 0, firstDeath: null,
    wid: DEFAULT_WEAPON[cls], heat: 0, holding: true, shotClock: 0, lastShot: -1e9, ventUntil: -1e9, jam: false, cut: false,
    secAt: 0, mobAt: 0, utilAt: 0, polarUntil: 0, sentries: [], wallHp: 0, wallUntil: 0, wellUntil: 0, wellSet: [],
    retreat: false, invulnUntil: 0,
    st: { hullLost: 0, shieldLost: 0, kitHeal: 0, rayHeal: 0, pulseHeal: 0, siphonHeal: 0, dmgOut: 0, kills: 0, kitsTaken: 0, polarKills: 0 },
  };
  p.gun = makeGun(cls, p.wid, { dmg: prog.dmg });
  p.auto = prog.auto;
  p.heal = prog.heal;
  if (legacy) {
    const L = LEGACY[cls];
    p.Emax = L.E * prog.hull; p.E = p.Emax; p.rech = L.rech * prog.preg; p.armor = L.armor;
    p.gun = { beam: false, dmg: L.dmg * prog.dmg, cd: L.cd, cost: L.cost, range: L.range, type: 'kinetic', fStart: 1e9, fMin: 1, over: 'none', heat: 0 };
    p.Smax = 0; p.S = 0; p.Hmax = p.Emax; p.H = p.Emax;
  } else {
    p.Smax = c.S * prog.shield; p.S = p.Smax; p.Hmax = c.H * prog.hull; p.H = p.Hmax; p.Pmax = c.P; p.P = p.Pmax;
    p.Sreg = c.Sreg; p.Sdel = c.Sdel; p.Sbrk = c.Sbrk; p.hard = c.hard; p.spc = c.spc; p.armor = c.armor; p.Preg = c.Preg * prog.preg;
    p.regenAt = -1e9; p.firedAt = -1e9; p.breakerUntil = -1e9; p.disruptedUntil = -1e9;
  }
  return p;
}
function resetPilot(p, now) {
  if (p.legacy) { p.E = p.Emax; p.H = p.Emax; }
  else { p.S = p.Smax; p.H = p.Hmax; p.P = p.Pmax; p.regenAt = -1e9; p.heat = 0; }
  p.alive = true; p.invulnUntil = now + 2; p.retreat = false; p.jam = false; p.cut = false; p.ventUntil = -1e9;
}
const hullFrac = (p) => (p.legacy ? p.E / p.Emax : p.H / p.Hmax);

// damage to a pilot; returns hull (or energy) lost
function hurt(W, p, amt, type) {
  if (!p.alive || W.now < p.invulnUntil) return 0;
  amt *= W.dmgScale;
  if (W.dbg) { const k = W.curKind || 'other'; W.dbg[k] = (W.dbg[k] || 0) + amt; }
  if (p.legacy) {
    const d = amt * (1 - p.armor); p.E -= d; p.H = p.E; p.st.hullLost += d;
    if (p.E < 0) takedown(W, p);
    return d;
  }
  if (p.cls === 'brute' && W.now < p.polarUntil) p.absorb = 0.4; else p.absorb = 0;
  const S0 = p.S;
  const r = applyHit(p, amt, type, W.now);
  p.st.hullLost += r.h; p.st.shieldLost += r.s;
  if (r.broke && p.cls === 'brute' && W.now < p.polarUntil) p.polarUntil = W.now; // polarity collapses
  if (p.H <= 0) takedown(W, p);
  return r.h;
}
function takedown(W, p) {
  if (!p.alive) return;
  p.alive = false; p.deaths++; W.deaths++;
  if (p.firstDeath === null) p.firstDeath = W.now;
  if (W.focal === p && W.focalFirst === null) W.focalFirst = W.now;
  W.lives--;
  dropKit(W, 'large', 'takedown');
  p.deadUntil = W.lives >= 0 ? W.now + 5 + 5 : Infinity; // RIFT_RESPAWN_SEC + regroup travel
  for (const e of W.enemies) if (e.tgt === p) retarget(W, e);
}
function heal(W, p, amt, src) {
  if (!p.alive || amt <= 0) return 0;
  if (p.legacy) { const room = p.Emax - p.E; const h = Math.min(room, amt); p.E += h; p.H = p.E; return h; }
  const room = p.Hmax - p.H; const h = Math.min(room, amt); p.H += h;
  const over = amt - h; if (over > 0) p.S = Math.min(p.Smax, p.S + over);
  return h;
}

// ---------------- kits (§9) ----------------
function dropKit(W, size, src) {
  W.kits.push({ size, until: W.now + 20, src });
  W.kitDrops[size]++;
}
function kitRoll(W, e, killer) {
  if (W.legacy || !W.kitsOn) return;
  const low = killer && !killer.legacy && killer.H / killer.Hmax < 0.5 ? 2 : 1;
  const m = 1.5 * low;
  const k = e.kind;
  if (k === 'hive') { for (let i = 0; i < 4; i++) dropKit(W, 'large', 'boss'); return; }
  if (k === 'matriarch') { for (let i = 0; i < 6; i++) dropKit(W, 'large', 'boss'); return; }
  if (KAMI.has(k)) { if (W.r() < 0.025 * m) dropKit(W, 'small', 'trash'); }
  else if (k === 'splitter' || k === 'spinner') { if (W.r() < 0.08 * m) dropKit(W, 'small', 'mid'); }
  else if (k === 'brute' || k === 'blackhole') { if (W.r() < Math.min(1, 0.4 * m)) dropKit(W, 'large', 'big'); }
  if (e.elite && W.r() < Math.min(1, 0.6 * m)) dropKit(W, 'large', 'elite');
}
function stepKits(W) {
  if (!W.kits.length) return;
  const inFight = W.enemies.length > 0;
  for (let i = W.kits.length - 1; i >= 0; i--) {
    const k = W.kits[i];
    if (k.until < W.now) { W.kitExpired++; W.kits.splice(i, 1); continue; }
    // lowest-integrity alive pilot below full picks it up (claim map); mid-fight only 40%/s pickup rate
    let best = null;
    for (const p of W.party) if (p.alive && hullFrac(p) < 0.999 && (!best || hullFrac(p) < hullFrac(best))) best = p;
    if (!best) continue;
    if (inFight && hullFrac(best) > 0.75) continue; // §14: go for a kit only below 75% mid-fight
    if (inFight && W.r() > 0.4 * DT * 2) continue; // travel to the kit mid-fight (~2.5 s average)
    const frac = k.size === 'large' ? 0.35 : 0.15;
    const h = heal(W, best, frac * (best.legacy ? best.Emax : best.Hmax), 'kit');
    best.st.kitHeal += h; best.st.kitsTaken++; W.kitsTaken[k.size]++; W.kitHullTotal += h;
    W.kits.splice(i, 1);
  }
}

// ---------------- enemies ----------------
function retarget(W, e) {
  let tot = 0; for (const p of W.party) if (p.alive) tot += AGGRO[p.cls];
  if (tot <= 0) { e.tgt = null; return; }
  let x = W.r() * tot;
  for (const p of W.party) if (p.alive) { x -= AGGRO[p.cls]; if (x <= 0) { e.tgt = p; return; } }
  e.tgt = W.party.find((p) => p.alive) ?? null;
}
function spawn(W, kind, opt = {}) {
  if (W.enemies.length >= 350) return null;
  const d = ED[kind];
  const X = W.legacy ? FX1 : W.fx;
  const elite = opt.elite ?? (!d.boss && !d.hive && kind !== 'blackhole' && kind !== 'splitling' && W.r() < (W.legacy ? 0.05 : X.elite));
  const hpScale = (opt.hpScale ?? 1) * (opt.noTier ? 1 : tierHp(W.tier)) * (opt.noThreat ? 1 : X.hp) * (W.legacy ? W.instHp : 1);
  const hp = d.hp * hpScale * (elite ? 3 : 1);
  const tierDmg = 1 + 0.04 * Math.max(0, W.tier - 1);
  const e = {
    kind, hp, maxHp: hp, elite, kam: d.kam,
    aegis: W.legacy || !W.aegisOn ? 0 : elite ? 0.5 * hp : d.hive || d.boss ? 0.25 * hp : 0,
    speed: d.speed * (elite ? 1.08 : 1) * (W.legacy ? 1 : X.speed),
    contact: d.contact * (elite ? 1.5 : 1) * tierDmg * (W.legacy ? 1 : X.dmg),
    shot: 55 * (elite ? 1.5 : 1) * (W.legacy ? 1 : (1 + 0.05 * (W.tier - 1)) * X.dmg),
    r: opt.r ?? 300 + 400 * W.r(), nextHit: 0, tgt: null, pinnedUntil: 0,
    boss: !!d.boss, hive: !!d.hive, spawnT: W.now,
  };
  e.maxAegis = e.aegis;
  retarget(W, e);
  W.enemies.push(e);
  return e;
}
function spawnPulse(W, budget, where = 'pulse') {
  const X = W.legacy ? FX1 : W.fx;
  const count = Math.max(1, Math.round(budget));
  const nMarkers = Math.max(1, Math.ceil(count / 6));
  const base = Math.floor(count / nMarkers); let rem = count - base * nMarkers;
  const wts = kindWeights(W.floor, W.legacy ? 0 : X.e);
  const sum = wts.reduce((a, b) => a + b[1], 0);
  let spawned = 0, want = 0; const made = [];
  let bh = W.enemies.filter((e) => e.kind === 'blackhole').length;
  for (let i = 0; i < nMarkers; i++) {
    const share = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
    let x = W.r() * sum, kind = 'drone';
    for (const [k, w] of wts) { x -= w; if (x <= 0) { kind = k; break; } }
    if (kind === 'blackhole' && bh >= 1) kind = 'drone';
    if (kind === 'blackhole') bh++;
    const members = Math.max(1, Math.round(share / ED[kind].cost));
    want += members;
    for (let m = 0; m < members; m++) { const e = spawn(W, kind, { hpScale: W.pHp }); if (e) { spawned++; made.push(e); } }
  }
  // §15 cap rule: missing budget -> HP on the spawned members (cap x2)
  if (!W.legacy && spawned < want && spawned > 0) {
    const m = Math.min(2, 1 + (want - spawned) / spawned);
    for (const e of made) { e.hp *= m; e.maxHp *= m; e.aegis *= m; e.maxAegis = e.aegis; }
    W.capHits++;
  }
  W.maxAlive = Math.max(W.maxAlive, W.enemies.length);
  return spawned;
}
function damageEnemy(W, e, amt, type, src) {
  if (e.hp <= 0) return 0;
  let d = amt;
  if (e.aegis > 0) {
    const sd = d * SM[type];
    if (sd <= e.aegis) { e.aegis -= sd; return amt; }
    const f = e.aegis / sd; e.aegis = 0; d *= 1 - f;
  }
  e.hp -= d;
  if (e.hp <= 0) killEnemy(W, e, src);
  return amt;
}
function killEnemy(W, e, src, noReward = false) {
  if (e.dead) return;
  e.dead = true; e.hp = 0;
  W.kills++;
  if (src) src.st.kills++;
  if (!noReward) kitRoll(W, e, src);
  if (e.kind === 'splitter') for (let i = 0; i < (e.elite ? 5 : 3); i++) spawn(W, 'splitling', { hpScale: 1, noThreat: true, r: Math.max(40, e.r) });
  if (e.kind === 'blackhole') {
    for (let i = 0; i < 5; i++) spawn(W, 'drone', { hpScale: 1, noThreat: true, r: Math.max(60, e.r) });
    if (e.r < 280 && e.tgt) hurt(W, e.tgt, 500 * 0.6, 'blast'); // 500 splash to ships in 280 px (avg falloff)
  }
  if (e.boss) { W.bossDead = true; for (const p of W.party) if (p.alive && W.r() < 0.5) hurt(W, p, 400 * 0.5, 'blast'); }
}
function purge(W) {
  if (W.enemies.some((e) => e.dead)) W.enemies = W.enemies.filter((e) => !e.dead);
}

// ---------------- pilot actions ----------------
function nearest(W, p, range, skip) {
  let best = null, bd = 1e9;
  for (const e of W.enemies) {
    if (e.dead || (skip && skip.has(e))) continue;
    const d = e.tgt === p ? e.r : e.r + 150;
    if (d <= range && d < bd) { bd = d; best = e; }
  }
  return best ? { e: best, d: bd } : null;
}
function nearestK(W, p, range, k) {
  const arr = [];
  for (const e of W.enemies) { if (e.dead) continue; const d = e.tgt === p ? e.r : e.r + 150; if (d <= range) arr.push([d, e]); }
  arr.sort((a, b) => a[0] - b[0]);
  return arr.slice(0, k).map((x) => x[1]);
}
function strainOf(b) { return (b.lmb ? 1 : 0) + (b.rmb ? 1 : 0) + (b.spc ? 1 : 0); }
function pay(W, p, cost, strain) {
  if (p.legacy) { if (p.E < cost + 50) return false; p.E -= cost; p.H = p.E; return true; }
  if (W.now < p.breakerUntil) return false;
  const c = cost * STRAIN_DRAW[strain];
  if (p.P < c) return false;
  p.P -= c; if (p.P <= 1e-9) { p.P = 0; p.breakerUntil = W.now + 1; W.breakers++; }
  return true;
}

function pilotStep(W, p) {
  const now = W.now;
  if (!p.alive) {
    if (now >= p.deadUntil) resetPilot(p, now);
    return;
  }
  const g = p.gun;
  const hf = hullFrac(p);
  // retreat rule (§14)
  if (!p.legacy) {
    const sF = p.S / p.Smax;
    if (!p.retreat && !W.noRetreat && p.S <= 0 && hf < RETREAT_R[p.cls]) p.retreat = true;
    else if (p.retreat && (sF >= 0.7 || (hf >= RETREAT_R[p.cls] + 0.25 && sF >= 0.4))) p.retreat = false;
  }
  const b = { lmb: false, rmb: false, spc: false };
  const tgt = nearest(W, p, g.range);
  // heat discipline
  if (p.holding && p.heat >= (W.relOff ? 101 : (REL[p.wid] ?? 101))) p.holding = false; else if (!p.holding && p.heat <= W.resume) p.holding = true;
  if (tgt && !p.retreat && p.holding) b.lmb = true;
  // Artificer ray decision (hold Space): lowest-integrity ally below 70%
  let rayT = null;
  if (p.cls === 'engineer' && !p.legacy) {
    for (const q of W.party) if (q !== p && q.alive && hullFrac(q) < 0.7 && (!rayT || hullFrac(q) < hullFrac(rayT))) rayT = q;
    if (!rayT && hf < 0.5 && W.enemies.length === 0) rayT = p;
    if (!rayT && W.siphon && W.enemies.length) rayT = 'siphon';
    if (rayT) b.spc = true;
  }
  let strain = strainOf(b);
  // ---- power: pass 1 engines (always thrusting in a fight), pass 3 reactor ----
  if (!p.legacy) {
    p.P = Math.max(0, p.P - p.c.thrustC * DT); if (p.P <= 1e-9 && now >= p.breakerUntil) { p.P = 0; p.breakerUntil = now + 1; W.breakers++; }
    p.P = Math.min(p.Pmax, p.P + p.Preg * (now < p.breakerUntil ? 1.5 : 1) * DT);
  } else {
    p.E = Math.min(p.Emax, p.E + p.rech * DT); p.H = p.E;
  }
  const inBreaker = !p.legacy && now < p.breakerUntil;
  // ---- weapon ----
  let fired = false;
  if (b.lmb && !inBreaker) {
    if (g.beam) {
      if (p.cut && p.heat <= 70) p.cut = false;
      if (!p.cut) {
        const need = g.cost * STRAIN_DRAW[strain] * DT, paid = Math.min(need, p.P); p.P -= paid;
        p.heat = Math.min(100, p.heat + g.heat * DT);
        if (p.heat >= 100) { if (p.S <= 0) p.cut = true; else { p.S = Math.max(0, p.S - g.overShield * DT); p.regenAt = Math.max(p.regenAt, now + p.Sdel); } }
        if (!p.cut && paid > 0) {
          const acc = ACC.laser * (tgt.e.kind === 'weaver' ? 0.85 : 1);
          const dmg = g.dps * (paid / need) * DT * acc * W.outMult;
          damageEnemy(W, tgt.e, dmg, g.type, p); p.st.dmgOut += dmg; fired = true;
        }
      }
    } else {
      p.shotClock += DT;
      if (p.jam && p.heat <= 70) p.jam = false;
      while (p.shotClock >= g.cd) {
        p.shotClock -= g.cd;
        if (now < p.ventUntil || p.jam) break;
        const t2 = nearest(W, p, g.range); if (!t2) break;
        if (p.legacy) {
          if (p.E < g.cost + 1) break;
          p.E -= g.cost; p.H = p.E;
        } else {
          const atMax = p.heat >= 100;
          if (g.over === 'md' && atMax && p.S <= 0) { p.jam = true; break; }
          const cost = g.cost * hotMult(g, p.heat) * STRAIN_DRAW[strain];
          if (p.P < cost) break;
          p.P -= cost;
          p.heat = Math.min(100, p.heat + g.heat);
          if (g.over === 'md' && atMax) { p.S = Math.max(0, p.S - g.overShield); p.regenAt = Math.max(p.regenAt, now + p.Sdel); }
          if (g.over === 'vent' && p.heat >= 100) { p.ventUntil = now + g.vent; }
        }
        fired = true;
        const acc = (p.legacy ? 0.75 : ACC[p.wid]) * (t2.e.kind === 'weaver' ? ED.weaver.dodge : 1);
        if (W.r() < acc) { const dmg = g.dmg * falloff(g, t2.d) * W.outMult; damageEnemy(W, t2.e, dmg, g.type, p); p.st.dmgOut += dmg; }
      }
      p.shotClock = Math.min(p.shotClock, g.cd);
    }
  } else if (!g.beam) p.shotClock = Math.min(p.shotClock + DT, g.cd);
  if (fired) { p.lastShot = now; p.firedAt = now; }
  if (!p.legacy) {
    if (!g.beam && now < p.ventUntil) p.heat = Math.max(0, p.heat - (100 / g.vent) * DT);
    else if (now - p.lastShot >= 0.3) p.heat = Math.max(0, p.heat - g.cool * DT);
  }
  // ---- skills (tapped: strain 2 only on the press tick) ----
  const near = (R) => { let n = 0; for (const e of W.enemies) if (!e.dead && e.tgt === p && e.r < R) n++; return n; };
  const pNorm = p.legacy ? p.E / p.Emax : p.P / p.Pmax;
  if (!inBreaker && (!p.retreat || p.cls === 'engineer')) {
    if (p.cls === 'brute') {
      if (now >= p.secAt && W.enemies.length && (p.legacy ? p.E > 2.2 * 160 : p.P >= 2.2 * 150) && pay(W, p, p.legacy ? 160 : 150, Math.min(3, strain + 1))) {
        p.secAt = now + 1.4;
        for (let i = 0; i < 3; i++) {
          const t = nearest(W, p, 1260); if (!t) break;
          const dens = Math.min(3, Math.floor(near(250) / 5));
          damageEnemy(W, t.e, 180 * W.outMult, 'blast', p);
          const others = nearestK(W, p, 1260, 1 + dens).filter((x) => x !== t.e);
          for (const o of others.slice(0, dens)) damageEnemy(W, o, 180 * 0.6 * W.outMult, 'blast', p);
        }
      }
      if (now >= p.mobAt && near(300) >= 3 && pay(W, p, p.legacy ? 100 : 110, Math.min(3, strain + 1))) {
        p.mobAt = now + 6; for (const o of nearestK(W, p, 400, 2)) damageEnemy(W, o, 400 * W.outMult, 'kinetic', p);
      }
      if (!p.legacy && W.polarOn && now >= p.utilAt && near(160) >= 3 && p.S >= 0.4 * p.Smax && pay(W, p, 120, Math.min(3, strain + 1))) {
        p.utilAt = now + 9 * W.polarCdMult; p.polarUntil = now + 5; W.polarCasts++;
      }
      if (p.legacy && now >= p.utilAt && near(160) >= 3) { p.utilAt = now + 12; p.hideUntil = now + 3; }
      if (!p.legacy && now < p.polarUntil) { if (!pay(W, p, 30 * DT / STRAIN_DRAW[strain], strain)) p.polarUntil = now; }
    } else if (p.cls === 'tech') {
      if (now >= p.secAt && (p.legacy ? p.E > 2.2 * 140 : p.P >= 2.2 * 130)) {
        const hops = nearestK(W, p, 600, 4);
        if (hops.length && pay(W, p, p.legacy ? 140 : 130, Math.min(3, strain + 1))) {
          p.secAt = now + 1.1; let d = 220;
          for (const o of hops) { damageEnemy(W, o, d * W.outMult, 'energy', p); d *= 0.85; }
        }
      }
      if (now >= p.utilAt && near(450) >= 5 && pay(W, p, 200, Math.min(3, strain + 1))) {
        p.utilAt = now + 10; p.wellUntil = now + 3; p.wellSet = nearestK(W, p, 500, 10);
        for (const o of p.wellSet) o.pinnedUntil = now + 3;
      }
      if (now < p.wellUntil) for (const o of p.wellSet) if (!o.dead) damageEnemy(W, o, 120 * DT * W.outMult, 'energy', p);
      if (now >= p.mobAt && near(120) >= 4 && pay(W, p, 120, Math.min(3, strain + 1))) {
        p.mobAt = now + 5; for (const e of W.enemies) if (e.tgt === p) e.r += 400;
        if (!p.legacy) p.regenAt = Math.min(p.regenAt, now + 1.0);
      }
    } else {
      p.sentries = p.sentries.filter((s) => s.until > now && s.hp > 0);
      if (!p.retreat && now >= p.secAt && W.enemies.length && (p.legacy ? p.E > 2.2 * 220 : p.P >= 2.2 * 200) && pay(W, p, p.legacy ? 220 : 200, Math.min(3, strain + 1))) {
        p.secAt = now + 3; if (p.sentries.length >= 2) p.sentries.shift();
        p.sentries.push({ until: now + 15, next: now + 1.2, hp: 600 });
      }
      for (const s of p.sentries) if (now >= s.next) { s.next += 1.2; const t = nearest(W, p, 700); if (t) damageEnemy(W, t.e, 90 * W.outMult, 'blast', p); }
      if (now >= p.utilAt && near(300) >= 4 && pay(W, p, 150, Math.min(3, strain + 1))) { p.utilAt = now + 14; p.wallHp = 1500; p.wallUntil = now + 6; }
      // Repair Pulse (press)
      const lowAllies = W.party.filter((q) => q.alive && hullFrac(q) < 0.7).length;
      if (now >= p.mobAt && (lowAllies >= 2 || hf < 0.4) && pay(W, p, p.legacy ? 0 : 60, Math.min(3, strain + 1))) {
        p.mobAt = now + 9;
        for (const q of W.party) if (q.alive && W.r() < 0.8 || q === p) {
          const amt = (p.legacy ? 0.25 * q.Emax : 0.22 * q.Hmax) * p.heal;
          const h = heal(W, q, amt, 'pulse'); p.st.pulseHeal += h; W.pulseHullTotal += h;
          if (!q.legacy) q.regenAt = Math.min(q.regenAt, now); // jump-start
        }
      }
      // Repair / Siphon ray (held)
      if (!p.legacy && rayT) {
        const frac = payCont(W, p, rayT === 'siphon' ? 110 : 130, strain);
        if (frac > 0) {
          if (rayT === 'siphon') {
            const t = nearest(W, p, 440);
            if (t) { damageEnemy(W, t.e, 150 * DT * frac, 'ion', p); const back = 0.6 * 150 * DT * frac * p.heal; const h = heal(W, p, back, 'siphon'); p.st.siphonHeal += h; W.rayHullTotal += h; }
          } else {
            const m = rayT === p ? 0.6 : 1;
            const h = heal(W, rayT, 120 * m * p.heal * DT * frac, 'ray'); p.st.rayHeal += h; W.rayHullTotal += h;
            if (W.rayJump && rayT.H >= rayT.Hmax - 1e-6) { rayT.S = Math.min(rayT.Smax, rayT.S + 220 * DT * frac); rayT.regenAt = Math.min(rayT.regenAt, now); }
          }
        }
      }
    }
    // auto-weapons: AoE DPS over the 4 nearest
    if (p.auto > 0 && !p.retreat) { const ts = nearestK(W, p, 350, 4); for (const o of ts) damageEnemy(W, o, (p.auto / Math.max(1, ts.length)) * DT * Math.min(1, ts.length / 2) * W.outMult, 'blast', p); }
  }
  // legacy Iron Hide
  // ---- shield regen (paid last) ----
  if (!p.legacy) {
    if (p.S < p.Smax && now >= p.regenAt && now >= p.disruptedUntil && now >= p.breakerUntil) {
      const fm = now - p.firedAt < FIRE_WIN ? FIRE_MULT : 1;
      const pf = p.P / p.Pmax, bb = pf < BROWN ? pf / BROWN : 1;
      const idle = p.retreat && W.enemies.length === 0; // stopped behind cover
      let pts = p.Sreg * fm * (idle ? IDLE_MULT : 1) * STRAIN_SHIELD[strain] * bb * DT;
      pts = Math.min(pts, p.Smax - p.S); if (pts * p.spc > p.P) pts = p.P / p.spc;
      p.S += pts; p.P -= pts * p.spc;
    }
    if (p.P < BROWN * p.Pmax) W.brownTime += DT;
  }
}
function payCont(W, p, perSec, strain) {
  if (W.now < p.breakerUntil) return 0;
  const need = perSec * STRAIN_DRAW[strain] * DT, paid = Math.min(need, p.P);
  p.P -= paid; if (p.P <= 1e-9) { p.P = 0; p.breakerUntil = W.now + 1; W.breakers++; }
  return need > 0 ? paid / need : 0;
}

// ---------------- enemy step ----------------
function enemyStep(W) {
  const now = W.now;
  for (const e of W.enemies) {
    if (e.dead) continue;
    W.curKind = e.kind + (e.elite ? '*' : '');
    if (!e.tgt || !e.tgt.alive) { retarget(W, e); if (!e.tgt) continue; }
    const p = e.tgt;
    if (e.boss || e.hive) { bossStep(W, e); continue; }
    if (now < e.pinnedUntil) { e.r = Math.max(e.r, 220); continue; } // held in a Singularity well
    const d = ED[e.kind];
    if (d.shooter) {
      const want = 450;
      e.r += Math.sign(want - e.r) * Math.min(Math.abs(want - e.r), e.speed * DT);
      // 2 s spiral of every 3.6 s, W.spinHit hits/s while spiralling (geometric estimate 0.16-0.35)
      const phase = ((now - e.spawnT) % 3.6);
      if (phase < 2 && W.r() < W.spinHit * DT) hurt(W, p, e.shot, 'energy');
      continue;
    }
    const kite = e.kind === 'brute' || e.kind === 'blackhole' ? 0.25 : 1; // ships out-run 90 / 35 px/s heavies
    if (e.r > 0) { e.r -= e.speed * CLOSE[p.cls] * kite * (p.retreat ? 0.75 : 1) * DT; continue; }
    // contact
    if (e.kam) {
      // Artificer walls / sentries soak swarmers
      const art = W.party.find((q) => q.cls === 'engineer' && q.alive && (q.wallHp > 0 && q.wallUntil > now));
      if (art && W.r() < 0.25) { art.wallHp -= e.contact; killEnemy(W, e, null, true); continue; }
      const sArt = W.party.find((q) => q.cls === 'engineer' && q.alive && q.sentries.some((s) => s.hp > 0 && s.until > now));
      if (sArt && W.r() < 0.12) { const s = sArt.sentries.find((x) => x.hp > 0); s.hp -= e.contact; killEnemy(W, e, null, true); continue; }
      if (p.cls === 'brute' && !p.legacy && now < p.polarUntil) { killEnemy(W, e, p); p.st.polarKills++; continue; }
      if (W.r() < ED[e.kind].hitP) { hurt(W, p, p.legacy && p.hideUntil > now ? e.contact * 0.4 : e.contact, 'kinetic'); killEnemy(W, e, null, true); }
      else e.r = 150; // overshoot, turn around
    } else {
      if (now >= e.nextHit) {
        e.nextHit = now + (d.every ?? 0.5);
        let amt = e.contact;
        if (p.legacy && p.hideUntil > now) amt *= 0.4;
        hurt(W, p, amt, 'kinetic');
        if (p.cls === 'brute' && !p.legacy && now < p.polarUntil) { damageEnemy(W, e, 260 + 0.5 * amt, 'kinetic', p); }
        e.r = d.every >= 1 ? 150 : 30; // knockback (+ the pilot backs off a slow heavy)
      }
    }
  }
}
function bossStep(W, e) {
  const now = W.now;
  e.r = 450;
  const tierShot = W.legacy ? 1 : (1 + 0.05 * (W.tier - 1)) * W.fx.dmg;
  const frac = e.hp / e.maxHp;
  if (e.boss) {
    const phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    if (phase !== e.phase) {
      if (e.phase && !W.legacy) {
        if (W.aegisOn) e.aegis = e.maxAegis;
        if (W.kitsOn) for (let i = 0; i < 3; i++) dropKit(W, 'large', 'boss');
        if (W.floor >= 6) spawn(W, 'hive', { hpScale: 0.6 * W.pHp, r: 500 });
      }
      e.phase = phase;
    }
    if (now < e.spawnT + 3) return; // intro
    if (now >= (e.droneAt ?? e.spawnT + 4)) { e.droneAt = now + (phase === 3 ? 2 : 3); for (let i = 0; i < 4 + W.n; i++) spawn(W, 'drone', { hpScale: W.pHp, r: 420 }); }
    if (now >= (e.ringAt ?? e.spawnT + 4.5)) {
      e.ringAt = now + 4.5;
      for (const p of W.party) if (p.alive) { if (W.r() < (phase >= 2 ? 0.55 : 0.35)) hurt(W, p, 80 * tierShot, 'energy'); }
    }
    if (phase >= 2 && now >= (e.broodAt ?? now + 2)) { e.broodAt = now + 8; for (let i = 0; i < 3; i++) spawn(W, 'splitter', { hpScale: W.pHp, r: 250 }); }
    if (phase === 3 && now >= (e.dashAt ?? now + 1.5)) { e.dashAt = now + 6; if (e.tgt && W.r() < 0.4) hurt(W, e.tgt, e.contact, 'kinetic'); }
  } else {
    if (now >= (e.droneAt ?? e.spawnT + 2)) { e.droneAt = now + 3.5; for (let i = 0; i < 3 + Math.floor(W.tier / 5); i++) spawn(W, 'drone', { r: 400 }); }
    if (now >= (e.ringAt ?? e.spawnT + 3)) { e.ringAt = now + 4.5; for (const p of W.party) if (p.alive && W.r() < 0.35) hurt(W, p, 80 * tierShot, 'energy'); }
  }
}

// ---------------- the floor ----------------
export function runFloor(o) {
  const { classes, floor, diff = 2, profile = 'typical', legacy = false, seed = 1, endurance = false, maxSec = 1500 } = o;
  THREAT_RATE = o.threatRate ?? 0.35; THREAT_HP = o.threatHp ?? 0.1;
  const n = classes.length;
  const prog = progression(profile, floor);
  const W = {
    r: rng(seed * 7919 + floor * 131 + n * 17), now: 0, floor, n, tier: tierOf(floor), legacy, D: DIFF[diff].D,
    kitsOn: o.kits ?? true, aegisOn: o.aegis ?? true, polarOn: o.polar ?? true, polarCdMult: o.polarCdMult ?? 1, siphon: !!o.siphon, rayJump: o.rayJump ?? true,
    outMult: o.outMult ?? 1, dmgScale: o.dmgScale ?? 1,
    enemies: [], kits: [], kitDrops: { small: 0, large: 0 }, kitsTaken: { small: 0, large: 0 }, kitExpired: 0, kitHullTotal: 0, rayHullTotal: 0, pulseHullTotal: 0,
    kills: 0, deaths: 0, breakers: 0, brownTime: 0, polarCasts: 0, maxAlive: 0, capHits: 0, rooms: 0, surges: 0, maxT: 1, instHp: 1,
    fixThreat: !!o.fixThreat, paused: 0, inBoss: false, spinHit: o.spinHit ?? 0.35, noRetreat: !!o.noRetreat, dbg: o.dbg ? {} : null, focalFirst: null, resume: o.resume ?? 55, relOff: !!o.relOff, threatOff: !!o.threatOff,
  };
  W.party = classes.map((c, i) => mkPilot(c, prog, legacy, i));
  W.focal = W.party[0];
  const lives0 = legacy ? Math.min(12, Math.max(2, 2 + 2 * n + (diff === 1 ? 2 : diff === 3 ? -2 : 0))) : Math.min(20, Math.max(2, 3 + 2 * n + DIFF[diff].lives));
  W.lives = lives0;
  const cnt = partyCount(n) * DIFF[diff].count;
  W.pHp = partyHp(n) * DIFF[diff].hp;
  W.fx = FX1;
  const pulseSize = Math.max(1, Math.round((8 + 2 * floor) * cnt));
  const plan = PLANS[(floor - 1) % 6];
  // rooms: main path + branches (treasure: 50% guard)
  const rooms = [];
  for (const k of plan.main) if (k !== 'E') rooms.push(k);
  for (let i = 0; i < plan.br; i++) rooms.splice(1 + i * 2, 0, 'T');
  if (endurance) { rooms.length = 0; for (let i = 0; i < 200; i++) rooms.push('A'); }
  if (o.bossOnly) { rooms.length = 0; rooms.push('B'); W.now = o.startSec ?? 0; W.rooms = o.startRooms ?? 0; }
  let lastT = 1;
  const updT = () => {
    if (legacy) { W.fx = FX1; W.instHp = W.now > 420 ? 1 + 0.1 * (W.now - 420) / 60 : 1; return; }
    if (W.inBoss && W.fixThreat) W.paused += DT;
    const T = W.threatOff ? 1 : W.fixThreat ? threatOf(1, W.now - W.paused, W.rooms, W.D) : threatOf(floor, W.now, W.rooms, W.D);
    W.fx = fx(T); W.maxT = Math.max(W.maxT, T);
    // surges on crossing integer levels
    while (Math.floor(T) > Math.floor(lastT) && Math.floor(T) >= 2) {
      lastT = Math.floor(T) + 0.0001; W.surges++;
      const size = Math.round((4 + floor) * partyCount(n));
      for (let i = 0; i < size; i++) spawn(W, W.r() < 0.5 ? 'dart' : 'weaver', { hpScale: W.pHp, r: 700 + 300 * W.r() });
    }
    if (T > lastT) lastT = Math.max(lastT, T);
  };
  let hunterAt = 420;
  const tick = () => {
    updT();
    if (W.now >= hunterAt && W.now >= 420) { hunterAt = W.now + 25; const sz = Math.round((4 + floor) * cnt); for (let i = 0; i < sz; i++) spawn(W, 'dart', { hpScale: W.pHp, r: 800 }); }
    for (const p of W.party) pilotStep(W, p);
    enemyStep(W);
    W.curKind = null;
    purge(W);
    stepKits(W);
    W.now += DT;
  };
  const allOut = () => W.party.every((p) => !p.alive && p.deadUntil === Infinity);
  const fail = () => allOut() || W.now > maxSec || (endurance && W.focalFirst !== null);
  const clearRoom = () => { while (W.enemies.length && !fail()) tick(); };
  const travel = (sec) => { const end = W.now + sec; while (W.now < end && !fail()) tick(); };
  const roomLog = [];
  for (const k of rooms) {
    if (fail()) break;
    const t0 = W.now;
    if (k === 'H' || k === 'T') {
      if (k === 'T' && W.r() >= 0.5) { travel(6); continue; }
      const packs = k === 'H' ? (floor >= 4 ? 2 : 1) : 1;
      const X = legacy ? FX1 : W.fx;
      for (let i = 0; i < packs; i++) {
        const wts = kindWeights(floor, legacy ? 0 : X.e); const sum = wts.reduce((a, b) => a + b[1], 0); let x = W.r() * sum, kind = 'drone';
        for (const [kk, w] of wts) { x -= w; if (x <= 0) { kind = kk; break; } }
        if (kind === 'blackhole') kind = 'drone';
        const size = k === 'H' ? (4 + floor) * cnt * (legacy ? 1 : X.packs) : (3 + Math.floor(floor / 2)) * cnt;
        const members = Math.max(1, Math.round(size / ED[k === 'T' ? 'weaver' : kind].cost));
        for (let m = 0; m < members; m++) spawn(W, k === 'T' ? 'weaver' : kind, { hpScale: W.pHp, r: 400 + 300 * W.r() });
      }
      if (floor >= 4 || k === 'T') spawn(W, 'spinner', { hpScale: W.pHp });
      clearRoom();
    } else if (k === 'A' || k === 'K') {
      const total = (floor >= 4 ? 4 : 3) + (k === 'K' ? 1 : 0);
      let last = 0, lastAt = W.now;
      for (let kk = 0; kk < total && !fail(); kk++) {
        if (kk > 0) {
          // wait for the next-pulse condition
          while (!fail()) {
            const X = legacy ? FX1 : W.fx;
            const since = W.now - lastAt;
            const minGap = legacy ? 3 : X.minGap, maxWait = legacy ? 14 : X.maxWait, nf = legacy ? 0.3 : X.next;
            if (since >= minGap && (since >= maxWait || W.enemies.length <= nf * last)) break;
            tick();
          }
        }
        travel(0.8); // spawnWarn lead
        if (k === 'K' && kk === total - 1) {
          if (floor <= 3) spawn(W, 'brute', { elite: true, hpScale: W.pHp });
          else spawn(W, 'hive', { hpScale: 0.8 * W.pHp });
          last = 1;
        } else {
          const esc = legacy ? 1 : (0.8 + 0.2 * kk) * W.fx.budget;
          last = spawnPulse(W, pulseSize * esc);
        }
        lastAt = W.now;
      }
      clearRoom();
      if (!legacy && W.kitsOn) { for (let i = 0; i < Math.ceil(n / 2); i++) dropKit(W, 'large', 'clear'); for (let i = 0; i < 2; i++) dropKit(W, 'large', 'chest'); }
    } else if (k === 'B') {
      W.inBoss = true;
      const boss = spawn(W, 'matriarch', { hpScale: partyBoss(n) * DIFF[diff].hp, noThreat: false, elite: false, r: 450 });
      if (boss) { boss.phase = 0; }
      while (!fail() && (!W.bossDead || W.enemies.length)) tick();
      W.inBoss = false;
    }
    W.rooms++;
    roomLog.push({ k, sec: W.now - t0, deaths: W.deaths, T: W.fx.e + 1, alive: W.enemies.length });
    travel(10);
  }
  const done = !fail() || (endurance && W.focalFirst !== null);
  const min = W.now / 60;
  const f = W.focal;
  return {
    W, cleared: !allOut() && W.now <= maxSec && !endurance, sec: W.now, deaths: W.deaths, lives0, livesLeft: W.lives,
    focalFirst: W.focalFirst, focalDeaths: f.deaths, focalHullLostPerMin: f.st.hullLost / (legacy ? f.Emax : f.Hmax) / min,
    kitsPerMin: (W.kitDrops.small + W.kitDrops.large) / min, kitsTaken: W.kitsTaken, kitDrops: W.kitDrops, kitExpired: W.kitExpired,
    kitHullPerMin: W.kitHullTotal / min, rayHullPerMin: W.rayHullTotal / min, pulseHullPerMin: W.pulseHullTotal / min,
    hullLostPerMin: W.party.reduce((a, p) => a + p.st.hullLost, 0) / min,
    maxT: W.maxT, maxAlive: W.maxAlive, surges: W.surges, breakers: W.breakers, capHits: W.capHits, roomLog,
    polarKills: W.party.reduce((a, p) => a + p.st.polarKills, 0), kills: W.kills, bossSec: (roomLog.find((x) => x.k === 'B') || {}).sec,
  };
}

export function party(focal, n) {
  if (n === 1) return [focal];
  if (n === 4) return [focal, 'brute', 'tech', 'engineer'];
  const rest = ['brute', 'brute', 'tech', 'tech', 'engineer', 'engineer'];
  rest.splice(rest.indexOf(focal), 1);
  return [focal, ...rest];
}
