// 2D agent model of a v1.0 Dungeon Runner floor under the Continuum Reactor design (spec §9-§10 + §2-§8).
// Pilots are bot-like (spec §12 rules, simplified); enemies follow the live ENEMY_DEFS + the spec's heat ramp.
'use strict';
const K = require('./core');
const { TICK, DT, CLASSES, makeShip, damageShip, reactorTick, mdFalloff } = K;
const { step: moveStep } = require('./inertia');
const { TUNE, DIFF, heatH, heatScale, tierHp, tierContact, partyCount, partyHp, ENEMY } = require('./items');

function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hypot = Math.hypot;

const DEFAULT_WPN = { brute: 'massdriver', tech: 'laser', engineer: 'phaser' };
function partyClasses(n) {
  if (n === 1) return null; // caller chooses
  const base = ['brute', 'tech', 'engineer', 'engineer', 'brute', 'tech'];
  if (n === 6) return ['brute', 'brute', 'tech', 'tech', 'engineer', 'engineer'];
  return base.slice(0, n);
}
function floorPlan(f) {
  // live PLANS (main path minus the entrance) for floors 1-6; floors 7-10 extend the 4-6 pattern by one arena
  const P = { 1: 'HAHAK', 2: 'HAHAK', 3: 'HAHAHB', 4: 'HAHAAK', 5: 'HAAHAK', 6: 'HAHAHAB' };
  if (P[f]) return P[f];
  return f % 3 === 0 ? 'HAHAHAAB' : 'HAHAHAAK';
}
function kindWeights(f) {
  const hive = f <= 3;
  const t = [['drone', 10 * (hive ? 1.5 : 1)], ['dart', 4], ['weaver', 3 * (hive ? 1 : 1.5)]];
  if (f >= 2) t.push(['splitter', 3 * (hive ? 1.5 : 1)], ['spinner', 2 * (hive ? 1 : 1.5)]);
  if (f >= 3) t.push(['brute', 1.2]);
  if (f >= 5) t.push(['blackhole', 0.3]);
  return t;
}
function pick(rng, table) { let s = 0; for (const [, w] of table) s += w; let r = rng() * s; for (const [k, w] of table) { r -= w; if (r <= 0) return k; } return table[0][0]; }

/** Progression assumption: level at floor start and the stat multipliers it buys. */
function buildOf(level, prog) {
  if (!prog) return { dmg: 1, I: 1, S: 1, R: 1, nova: 0 };
  return { dmg: Math.min(2.2, 1 + 0.05 * (level - 1)), I: 1 + 0.025 * (level - 1), S: 1 + 0.025 * (level - 1), R: 1 + 0.02 * (level - 1),
    nova: Math.max(0, Math.min(5, Math.floor((level - 2) / 3))) };
}

class Floor {
  constructor(cfg) {
    Object.assign(this, { f: 1, n: 6, pve: 2, seed: 1, classes: null, weapons: {}, prog: true, items: true, drive: true, polarize: true, ray: true,
      reactorTiers: true, travelSec: 12, endless: false, skill: 'average', maxSec: 1500, kitsOn: true, verbose: false, lives: null, levelBonus: 0, ramPath: false }, cfg);
    this.rng = mulberry(this.seed * 7919 + this.f * 131 + this.n);
    this.SK = { expert: { R: 320, W: 2, react: 6, jit: 0 }, average: { R: 200, W: 1, react: 15, jit: 0.5 }, bot: { R: 140, W: 0.5, react: 24, jit: 0.8 } }[this.skill];
    this.t = 0; this.floorT = 0; this.cleared = 0;
    const d = DIFF[this.pve];
    this.lives = this.lives ?? Math.min(16, Math.max(this.pve === 3 ? 2 : 0, 2 + 2 * this.n + d.lives));
    this.level = 1 + 3 * (this.f - 1) + this.levelBonus;
    const B = buildOf(this.level, this.prog);
    this.B = B;
    const classes = this.classes || partyClasses(this.n);
    this.ships = classes.map((cls, i) => this.makePilot(cls, i));
    this.enemies = []; this.kits = []; this.prizes = []; this.walls = []; this.sentries = []; this.wells = []; this.ions = []; this.bombsFlying = [];
    this.log = { kills: 0, driveKills: 0, drives: 0, emps: 0, ionUses: 0, bombs: 0, peakAlive: 0, kitsDropped: 0, kitsTaken: 0, kitsExpired: 0, prizes: 0, wiped: false, bossDown: false, roomsCleared: 0, time: 0, H: 1 };
  }
  makePilot(cls, i) {
    const B = this.B;
    const s = makeShip(cls, { weapon: this.weapons[cls] || DEFAULT_WPN[cls], reactorTiers: this.reactorTiers, wdmg: B.dmg });
    s.st.I *= B.I; s.st.S *= B.S; s.st.R *= B.R; s.I = s.st.I; s.S = s.st.S;
    const a = (i / 6) * Math.PI * 2;
    return { i, cls, s, x: Math.cos(a) * 60, y: Math.sin(a) * 60, vx: 0, vy: 0, aim: 0, respawnAt: -1, out: false, bombs: 2, bombRegen: 18 * TICK, itemReady: 0,
      items: { emp: 0, ion: 0, sing: 0 }, held: true, rayOn: false, rayTgt: null, novaNext: 0, chargeDir: null, chargeHit: null,
      st: { dmgI: 0, dmgS: 0, kitI: 0, kitS: 0, healI: 0, healS: 0, deaths: 0, firstDeath: -1, kills: 0, dealt: 0, brownTicks: 0, aliveTicks: 0, polarTicks: 0 } };
  }
  H() { return heatH(this.f, this.floorT / (60 * TICK), this.pve, this.cleared); }

  // ------------------------------------------------------------------ enemies
  spawnEnemy(kind, x, y, opts = {}) {
    const H = this.H(), hs = heatScale(H), d = ENEMY[kind];
    const elite = opts.elite ?? (this.rng() < hs.elite);
    const tierF = opts.tierF ?? this.f;
    const hpScale = opts.hpScale ?? (tierHp(tierF) * partyHp(this.n) * DIFF[this.pve].hp * hs.hp * (this.floorT > 420 * TICK ? 1 + 0.1 * (this.floorT / TICK - 420) / 60 : 1));
    const hp = d.hp * hpScale * (elite ? 3 : 1);
    const e = { kind, d, x, y, vx: 0, vy: 0, hp, maxHp: hp, r: d.r * (elite ? 1.3 : 1), elite, alive: true, cr: 0, tgt: null, rt: 0,
      contact: d.contact * tierContact(tierF) * hs.dmg * (elite ? 1.5 : 1), speed: d.speed * hs.speed * (elite ? 1.08 : 1), fire: 1 + Math.min(0.6, 0.12 * (H - 1)), spin: 0, spinUntil: 0, stun: 0, shellTick: 0, boss: !!opts.boss };
    this.enemies.push(e);
    return e;
  }
  spawnPulse(budget) {
    const HS = this.room.hs, nMark = Math.max(1, Math.ceil(budget / 6)), per = budget / nMark;
    const markers = [];
    for (let m = 0; m < 8; m++) { const a = (m / 8) * Math.PI * 2 + 0.3; markers.push([Math.cos(a) * HS * 0.72, Math.sin(a) * HS * 0.72]); }
    markers.sort((p, q) => this.minShipDist(q[0], q[1]) - this.minShipDist(p[0], p[1]));
    const bh = this.enemies.some((e) => e.alive && e.kind === 'blackhole');
    const plan = [];
    for (let m = 0; m < nMark; m++) {
      const table = kindWeights(this.f).filter(([k]) => !(k === 'blackhole' && (bh || plan.some((q) => q.kind === 'blackhole'))));
      const kind = pick(this.rng, table);
      const members = Math.max(1, Math.round(per / ENEMY[kind].cost));
      const [mx, my] = markers[m % markers.length];
      for (let j = 0; j < members; j++) plan.push({ kind, x: mx + (this.rng() - 0.5) * 60, y: my + (this.rng() - 0.5) * 60 });
    }
    // RIFT_ROOM_BODY_CAP 160: surplus bodies are dropped; every 4 surplus drone-eq promotes one kept member to elite
    const room = Math.max(0, 160 - this.aliveEnemies());
    let promote = 0;
    if (plan.length > room) { let eq = 0; for (const q of plan.splice(room)) eq += ENEMY[q.kind].cost; promote = Math.floor(eq / 4); this.log.capHits = (this.log.capHits || 0) + 1; }
    for (const q of plan) { const el = promote > 0; if (el) promote--; this.spawnEnemy(q.kind, q.x, q.y, el ? { elite: true } : {}); }
    return plan.length;
  }
  aliveEnemies() { let n = 0; for (const e of this.enemies) if (e.alive) n++; return n; }
  minShipDist(x, y) { let m = 1e9; for (const p of this.ships) if (this.shipAlive(p)) m = Math.min(m, hypot(p.x - x, p.y - y)); return m; }
  shipAlive(p) { return p.s.alive && !p.out && p.respawnAt < 0; }

  killEnemy(e, p, reward = true) {
    if (!e.alive) return;
    e.alive = false; this.log.kills++;
    if (p) p.st.kills++;
    if (e.kind === 'splitter') { for (let i = 0; i < (e.elite ? 5 : 3); i++) { const a = (i / 3) * Math.PI * 2; const s = this.spawnEnemy('splitling', e.x + Math.cos(a) * 12, e.y + Math.sin(a) * 12, { hpScale: tierHp(this.f), elite: false }); s.vx = Math.cos(a) * 260; s.vy = Math.sin(a) * 260; } }
    if (!reward) return;
    if (this.kitsOn) {
      const kb = 1 + 0.15 * (this.H() - 1);
      const k = e.kind;
      if (k === 'drone' || k === 'dart' || k === 'weaver' || k === 'splitling') { if (this.rng() < 0.05 * kb) this.dropKit(e.x, e.y, 'small'); }
      else if (k === 'splitter' || k === 'spinner') { if (this.rng() < 0.14 * kb) this.dropKit(e.x, e.y, 'small'); }
      else if (k === 'brute' || k === 'blackhole') { this.dropKit(e.x, e.y, 'small'); if (this.rng() < 0.3 * kb) this.dropKit(e.x, e.y, 'large'); }
      if (e.elite) this.dropKit(e.x, e.y, 'large');
      if (e.kind === 'hive') for (let i = 0; i < 4; i++) this.dropKit(e.x, e.y, 'large');
      if (e.boss) for (let i = 0; i < 6; i++) this.dropKit(e.x, e.y, 'large');
    }
    if (this.items) {
      if (e.elite && this.rng() < 0.35) this.dropPrize(e.x, e.y);
      if (e.kind === 'hive') { this.dropPrize(e.x, e.y); this.dropPrize(e.x, e.y); }
      if (e.boss) { this.dropPrize(e.x, e.y, 'sing'); this.dropPrize(e.x, e.y); this.dropPrize(e.x, e.y); }
    }
  }
  dropKit(x, y, type) { this.kits.push({ x, y, type, exp: this.t + 20 * TICK }); this.log.kitsDropped++; }
  dropPrize(x, y, forced) {
    const r = this.rng() * 100; const it = forced || (r < 35 ? 'bomb' : r < 60 ? 'emp' : r < 85 ? 'ion' : 'sing');
    this.prizes.push({ x, y, it, exp: this.t + 30 * TICK }); this.log.prizes++;
  }
  damageEnemy(e, amt, p) {
    if (!e.alive || amt <= 0) return;
    e.hp -= amt; if (p) p.st.dealt += amt;
    if (e.hp <= 0) this.killEnemy(e, p, true);
  }

  // ------------------------------------------------------------------ encounters
  runEncounter(kind) {
    const f = this.f, n = this.n, d = DIFF[this.pve];
    const hs = { H: 450, A: 600, K: 672, B: 736 }[kind];
    this.room = { hs, kind };
    // regroup ships at the entrance edge
    this.ships.forEach((p, i) => { if (!p.out) { p.x = -hs + 80 + (i % 3) * 50; p.y = -120 + Math.floor(i / 3) * 80 + i * 10; p.vx = 200; p.vy = 0; } });
    this.enemies = []; this.walls = []; this.sentries = []; this.wells = []; this.ions = [];
    if (kind === 'H') {
      const pack = Math.round((4 + f) * partyCount(n) * d.count);
      for (let i = 0; i < Math.max(1, Math.round(pack / 1.5)); i++) { const kd = pick(this.rng, kindWeights(f)); this.spawnEnemy(kd === 'blackhole' ? 'drone' : kd, (this.rng() - 0.3) * hs, (this.rng() - 0.5) * hs * 1.4); }
      return this.fight({ pulses: 0 });
    }
    const pulses = f >= TUNE.pulses4From ? 4 : 3;
    return this.fight({ pulses, mini: kind === 'K', boss: kind === 'B' });
  }
  fight(enc) {
    const f = this.f, n = this.n, d = DIFF[this.pve];
    let fired = 0, lastSpawnT = -1e9, lastCount = 0, warnAt = enc.pulses > 0 ? this.t + Math.round(1.5 * TICK) : -1, trickleNext = 0, hunterNext = 0, miniDone = !enc.mini, boss = null;
    if (enc.boss) {
      boss = this.spawnEnemy('brute', 0, 0, { elite: false, boss: true, hpScale: (30000 / 2400) * (1 + 0.5 * (n - 1)) * d.hp * heatScale(this.H()).hp });
      boss.r = 88; boss.speed = 60; boss.contact = 320 * heatScale(this.H()).dmg; boss.ring = this.t + 3 * TICK; boss.drones = this.t + 3 * TICK; boss.dash = this.t + 6 * TICK;
      this.log.bossHp = boss.maxHp;
    }
    const startT = this.t;
    for (;;) {
      const H = this.H(), h = H - 1;
      const alive = this.aliveEnemies();
      this.log.peakAlive = Math.max(this.log.peakAlive, alive);
      // director
      if (enc.pulses > 0 || enc.endless) {
        const total = enc.endless ? Infinity : enc.pulses;
        const since = this.t - lastSpawnT;
        if (warnAt < 0 && fired < total) {
          const minGap = Math.max(1.5, 3 / (1 + 0.25 * h)) * TICK, maxGap = Math.max(6, 14 / (1 + 0.25 * h)) * TICK, next = Math.min(0.55, 0.3 + 0.08 * h);
          if (since >= minGap && (since >= maxGap || alive <= next * lastCount)) warnAt = this.t + 48;
        }
        if (warnAt >= 0 && this.t >= warnAt) {
          const k = Math.min(fired, enc.endless ? 8 : 99);
          const budget = (8 + 2 * f) * partyCount(n) * d.count * (1 + 0.35 * h) * (1 + 0.15 * k);
          lastCount = this.spawnPulse(budget); lastSpawnT = this.t; fired++; warnAt = -1;
        }
        // trickle between pulses
        if (H >= 1.5 && fired < total && this.t >= trickleNext && fired > 0) {
          trickleNext = this.t + Math.max(5, 16 / (1 + 0.4 * h)) * TICK;
          const cnt = Math.round(2 + 1.2 * h), a = this.rng() * Math.PI * 2, hs2 = this.room.hs * 0.72;
          for (let i = 0; i < cnt; i++) this.spawnEnemy('drone', Math.cos(a) * hs2 + (this.rng() - 0.5) * 40, Math.sin(a) * hs2 + (this.rng() - 0.5) * 40);
        }
        if (fired >= total && !miniDone && alive <= 0.3 * lastCount) {
          miniDone = true; const a = this.rng() * 6.28;
          if (f <= 3) this.spawnEnemy('brute', Math.cos(a) * 300, Math.sin(a) * 300, { elite: true });
          else { const hv = this.spawnEnemy('brute', Math.cos(a) * 300, Math.sin(a) * 300, { elite: false, hpScale: (9000 / 2400) * 0.8 * tierHp(f) * partyHp(n) * d.hp * heatScale(H).hp }); hv.kind = 'hive'; hv.r = 70; hv.speed = 50; hv.contact = 320 * tierContact(f) * heatScale(H).dmg; hv.ring = this.t + 3 * TICK; hv.isHive = true; }
        }
      }
      // instability hunters
      if (this.floorT > 420 * TICK && this.t >= hunterNext) {
        hunterNext = this.t + Math.max(12, 25 / (1 + 0.2 * h)) * TICK;
        const cnt = Math.round((4 + f) * partyCount(n) * d.count), a = this.rng() * 6.28;
        for (let i = 0; i < cnt; i++) this.spawnEnemy(this.rng() < 0.5 ? 'dart' : 'weaver', Math.cos(a) * this.room.hs * 0.8, Math.sin(a) * this.room.hs * 0.8, { tierF: this.f + 1 });
      }
      if (boss) this.bossAI(boss);
      this.tick();
      if (this.log.wiped) return false;
      const done = !enc.endless && fired >= enc.pulses && miniDone && this.aliveEnemies() === 0 && warnAt < 0 && (!boss || !boss.alive);
      if (done) {
        if (enc.pulses > 0) {
          this.cleared++; this.log.roomsCleared++;
          if (this.kitsOn) for (let i = 0; i < Math.ceil(n / 2); i++) this.dropKit((this.rng() - 0.5) * 60, (this.rng() - 0.5) * 60, 'large');
          if (this.items) for (let i = 0; i < Math.ceil(n / 2); i++) this.dropPrize((this.rng() - 0.5) * 60, (this.rng() - 0.5) * 60);
          if (boss) { this.log.bossDown = true; this.lives = Math.min(16, this.lives + 2); }
          // collect the room-clear drops (a few seconds of mopping up)
          for (let i = 0; i < 3 * TICK; i++) this.tick(true);
        }
        return true;
      }
      if (this.t - startT > this.maxSec * TICK) { this.log.timeout = true; return false; }
    }
  }
  bossAI(b) {
    if (!b.alive) return;
    const H = this.H(), fm = 1 + Math.min(0.6, 0.12 * (H - 1)), dm = heatScale(H).dmg;
    const phase3 = b.hp < 0.33 * b.maxHp;
    if (this.t >= b.ring) { b.ring = this.t + Math.round(4.5 / fm * TICK); this.ringVolley(b, 20, 80 * dm); }
    if (this.t >= b.drones) { b.drones = this.t + Math.round((phase3 ? 2 : 3) / fm * TICK); for (let i = 0; i < Math.round(4 * partyCount(this.n) * 0.5); i++) this.spawnEnemy('drone', b.x + (this.rng() - 0.5) * 120, b.y + (this.rng() - 0.5) * 120); }
    if (this.t >= b.dash) { b.dash = this.t + 6 * TICK; const tg = this.nearestShip(b.x, b.y); if (tg) { const dx = tg.x - b.x, dy = tg.y - b.y, dd = hypot(dx, dy) || 1; b.dashV = [dx / dd * 900, dy / dd * 900]; b.dashUntil = this.t + Math.round(1.4 * TICK); b.dashStart = this.t + Math.round(0.8 * TICK); } }
  }
  ringVolley(src, count, dmg) {
    // expected hits: each ship within 900 px catches a shot with p = min(1, count × (r + 6) × 2 / (2π d)) × 0.6 (dodging)
    for (const p of this.ships) {
      if (!this.shipAlive(p)) continue;
      const d = Math.max(60, hypot(p.x - src.x, p.y - src.y)); if (d > 840) continue;
      const pr = Math.min(1, count * (p.s.c.r + 6) * 2 / (2 * Math.PI * d)) * 0.6;
      if (this.rng() < pr) this.hurtShip(p, dmg, 'energy', src.boss ? 'boss ring' : 'hive ring');
    }
  }
  nearestShip(x, y) { let best = null, bd = 1e9; for (const p of this.ships) if (this.shipAlive(p)) { const d = hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } } return best; }
  hurtShip(p, amt, type, src = 'other') {
    const s = p.s, I0 = s.I, S0 = s.S, was = s.alive;
    if (!was || p.respawnAt >= 0 || p.out) return;
    damageShip(s, amt, type, this.t);
    const di = Math.max(0, I0 - Math.max(0, s.I)), dsh = Math.max(0, S0 - s.S);
    p.st.dmgI += di; p.st.dmgS += dsh;
    const L = this.log.src || (this.log.src = {}); L[src] = (L[src] || 0) + di + dsh;
    if (!s.alive) this.onDeath(p);
  }
  onDeath(p) {
    p.st.deaths++; if (p.st.firstDeath < 0) p.st.firstDeath = (this.floorT) / TICK;
    p.rayOn = false; p.s.polarSus = false;
    if (this.lives > 0) { this.lives--; p.respawnAt = this.t + 5 * TICK; }
    else p.out = true;
    // wipe?
    if (this.ships.every((q) => q.out || !q.s.alive)) { if (this.ships.every((q) => q.out)) this.log.wiped = true; }
  }
  respawn(p) {
    const mate = this.ships.find((q) => q !== p && this.shipAlive(q));
    const B = this.B; const fresh = makeShip(p.cls, { weapon: p.s.w.id, reactorTiers: this.reactorTiers, wdmg: B.dmg });
    fresh.st.I *= B.I; fresh.st.S *= B.S; fresh.st.R *= B.R; fresh.I = fresh.st.I; fresh.S = fresh.st.S;
    fresh.invulnUntil = this.t + 2 * TICK; fresh.stats = p.s.stats;
    p.s = fresh; p.respawnAt = -1; p.bombs = 2;
    if (mate) { p.x = mate.x + 30; p.y = mate.y; } else { p.x = 0; p.y = 0; }
    p.vx = p.vy = 0;
  }

  // ------------------------------------------------------------------ one tick
  tick(calm = false) {
    this.t++; this.floorT++;
    const t = this.t, HS = this.room.hs;
    // respawns
    for (const p of this.ships) if (p.respawnAt >= 0 && t >= p.respawnAt) this.respawn(p);
    if (this.log.wiped) return;
    // enemy grid for separation
    const cell = 64, grid = new Map();
    for (const e of this.enemies) if (e.alive) { const k = ((e.x + 4096) / cell | 0) * 1024 + ((e.y + 4096) / cell | 0); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(e); }
    // enemies
    const H = this.H(), rtTicks = Math.max(12, 30 - 4 * (H - 1));
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.stun > t) { e.vx *= 0.9; e.vy *= 0.9; continue; }
      if (t >= e.rt) { e.rt = t + rtTicks; e.tgt = this.nearestShip(e.x, e.y); if (e.d.kami && this.sentries.length) { let bd = e.tgt ? hypot(e.tgt.x - e.x, e.tgt.y - e.y) : 1e9; for (const sn of this.sentries) { const dd = hypot(sn.x - e.x, sn.y - e.y); if (sn.hp > 0 && dd < bd) { bd = dd; e.tgt = sn; } } } }
      let tx = 0, ty = 0, has = false;
      if (e.tgt && (e.tgt.hp > 0 || (e.tgt.s && this.shipAlive(e.tgt)))) { tx = e.tgt.x; ty = e.tgt.y; has = true; } else e.tgt = null;
      let dvx = 0, dvy = 0;
      if (has) {
        const dx = tx - e.x, dy = ty - e.y, dd = hypot(dx, dy) || 1;
        if (e.kind === 'spinner') {
          const dir = (e.maxHp * 1000 | 0) & 1 ? 1 : -1;
          if (dd > 520) { dvx = dx / dd * e.speed; dvy = dy / dd * e.speed; } else if (dd < 380) { dvx = -dx / dd * e.speed; dvy = -dy / dd * e.speed; } else { dvx = -dy / dd * dir * e.speed * 0.7; dvy = dx / dd * dir * e.speed * 0.7; }
          if (t >= e.spinUntil) { if (e.spin === 0 && dd < 900) { e.spin = 1; e.spinUntil = t + 2 * TICK; } else if (e.spin === 1) { e.spin = 0; e.spinUntil = t + 1.6 * TICK; } }
          if (e.spin === 1 && t % 7 === 0) this.spiralShot(e, 55 * heatScale(H).dmg * (e.elite ? 1.5 : 1), e.elite ? 2 : 1);
        } else if (e.boss && e.dashUntil > t && t >= e.dashStart) { e.vx = e.dashV[0]; e.vy = e.dashV[1]; }
        else { dvx = dx / dd * e.speed; dvy = dy / dd * e.speed; }
        if (e.isHive && t >= e.ring) { e.ring = t + Math.round(4 / e.fire * TICK); this.ringVolley(e, 20, 80 * heatScale(H).dmg); }
      }
      if (e.kind === 'blackhole') for (const p of this.ships) { if (!this.shipAlive(p)) continue; const dx = e.x - p.x, dy = e.y - p.y, dd = hypot(dx, dy) || 1; if (dd < 450) { const a = 80 + 650 * (1 - dd / 450); p.vx += dx / dd * a * DT; p.vy += dy / dd * a * DT; } }
      if (!(e.boss && e.dashUntil > t && t >= e.dashStart)) { const k = Math.min(1, e.d.accel * DT); e.vx += (dvx - e.vx) * k; e.vy += (dvy - e.vy) * k; }
      // wells (Arcanist) and Singularity Drives pull
      for (const w of this.wells) { const dx = w.x - e.x, dy = w.y - e.y, dd = hypot(dx, dy) || 1; if (dd < w.r && !e.boss) { e.vx += dx / dd * w.pull * DT; e.vy += dy / dd * w.pull * DT; if (dd < 60) this.damageEnemy(e, w.dps * DT, w.owner); } }
      for (const p of this.ships) if (p.driveUntil > t && this.shipAlive(p) && !e.boss && e.kind !== 'hive') {
        const dx = p.x - e.x, dy = p.y - e.y, dd = hypot(dx, dy) || 1;
        if (dd < 520) { e.vx += dx / dd * 1200 * DT; e.vy += dy / dd * 1200 * DT; e.x += dx / dd * 30 * DT; e.y += dy / dd * 30 * DT; }
        if (dd < p.s.c.r + 70 + e.r) { if (e.d.kami && TUNE.driveKillsKami) { this.log.driveKills++; this.killEnemy(e, p, true); } else { const was = e.alive; this.damageEnemy(e, TUNE.driveCrushDps * DT, p); if (was && !e.alive) this.log.driveKills++; if (e.alive && e.d.kami && hypot(p.x - e.x, p.y - e.y) < p.s.c.r + e.r) { this.hurtShip(p, e.contact * 0.5, 'contact', e.kind); e.alive = false; } } }
      }
      if (!e.alive) continue;
      for (const io of this.ions) { if (hypot(io.x - e.x, io.y - e.y) < 240) { e.vx *= 0.995; e.vy *= 0.995; } }
      // separation
      const gx = ((e.x + 4096) / cell | 0), gy = ((e.y + 4096) / cell | 0);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) { const a = grid.get((gx + ox) * 1024 + gy + oy); if (!a) continue; for (const o of a) { if (o === e || !o.alive) continue; const dx = e.x - o.x, dy = e.y - o.y, dd = hypot(dx, dy), m = e.r + o.r; if (dd < m && dd > 0.01) { const push = (m - dd) * 0.25; e.x += dx / dd * push; e.y += dy / dd * push; } } }
      e.x += e.vx * DT; e.y += e.vy * DT;
      // walls of the room
      const lim = HS - e.r; if (e.x > lim) { e.x = lim; e.vx = -Math.abs(e.vx) * 0.5; } if (e.x < -lim) { e.x = -lim; e.vx = Math.abs(e.vx) * 0.5; } if (e.y > lim) { e.y = lim; e.vy = -Math.abs(e.vy) * 0.5; } if (e.y < -lim) { e.y = -lim; e.vy = Math.abs(e.vy) * 0.5; }
      // Shield Walls
      for (const w of this.walls) if (w.hp > 0 && segDist(e.x, e.y, w) < e.r + 6) { if (e.d.kami) { w.hp -= e.contact; e.alive = false; break; } else { e.x -= e.vx * DT * 1.5; e.y -= e.vy * DT * 1.5; e.vx *= -0.3; e.vy *= -0.3; if (t >= e.cr) { w.hp -= e.contact; e.cr = t + 30; } } }
      if (!e.alive) continue;
      // sentries soak kamikaze
      for (const sn of this.sentries) if (sn.hp > 0 && hypot(sn.x - e.x, sn.y - e.y) < e.r + 14) { if (e.d.kami) { sn.hp -= e.contact; e.alive = false; break; } else if (t >= e.cr) { sn.hp -= e.contact; e.cr = t + 30; } }
      if (!e.alive) continue;
      // contact with ships
      for (const p of this.ships) {
        if (!this.shipAlive(p)) continue;
        const s = p.s, dx = p.x - e.x, dy = p.y - e.y, dd = hypot(dx, dy) || 1, R = s.c.r;
        const polar = t < s.polarUntil || s.polarSus;
        if (polar && dd < R + 14 + e.r && !e.d.kami && t >= e.shellTick) { e.shellTick = t + 6; this.damageEnemy(e, 450 * this.B.dmg * 0.1, p); if (!e.alive) break; }
        if (dd >= R + e.r) continue;
        if (e.d.kami) {
          if (t < s.invulnUntil) { e.vx = -dx / dd * 250; e.vy = -dy / dd * 250; continue; }
          if (polar || this.ramPath && p.cls === 'brute') { this.hurtShip(p, e.contact * (polar ? 0.25 : 1) * (this.ramPath && p.cls === 'brute' ? 0.3 : 1), 'contact', e.kind); this.killEnemy(e, p, true); }
          else { this.hurtShip(p, e.contact, 'contact', e.kind); e.alive = false; }
          break;
        }
        // solid body: push the ship out, periodic damage + knockback
        const pen = R + e.r - dd; p.x += dx / dd * pen; p.y += dy / dd * pen;
        if (t >= e.cr) {
          e.cr = t + 30;
          this.hurtShip(p, e.contact * (polar ? 0.5 : 1) * (this.ramPath && p.cls === 'brute' ? 0.3 : 1), 'contact', e.boss ? 'boss' : e.kind);
          const kb = (e.d.knock || (e.boss ? 700 : 0)) * s.c.knock; p.vx += dx / dd * kb; p.vy += dy / dd * kb;
        }
      }
    }
    this.enemies = this.enemies.filter((e) => e.alive);
    // deployables
    for (const sn of this.sentries) { sn.life--; if (sn.hp > 0 && t >= sn.next) { sn.next = t + Math.round(1.2 * TICK); const tg = this.nearestEnemy(sn.x, sn.y, 550); if (tg && this.rng() < 0.9) this.damageEnemy(tg, 90 * this.B.dmg, sn.owner); } }
    this.sentries = this.sentries.filter((s) => s.hp > 0 && s.life > 0);
    for (const w of this.walls) w.life--; this.walls = this.walls.filter((w) => w.hp > 0 && w.life > 0);
    for (const w of this.wells) w.life--; this.wells = this.wells.filter((w) => w.life > 0);
    for (const io of this.ions) { io.life--; if (io.life % 15 === 0) { let n = 0; for (const e of this.enemies) { if (n >= 4) break; if (e.alive && hypot(e.x - io.x, e.y - io.y) < 240) { this.damageEnemy(e, 70, io.owner); n++; } } } }
    this.ions = this.ions.filter((i) => i.life > 0);
    for (const b of this.bombsFlying) if (t >= b.at) { b.done = true; for (const e of this.enemies) { const dd = hypot(e.x - b.x, e.y - b.y); if (dd < 150 + e.r) this.damageEnemy(e, 630 * (1 - 0.6 * Math.min(1, dd / 150)), b.owner); } }
    this.bombsFlying = this.bombsFlying.filter((b) => !b.done);
    this.enemies = this.enemies.filter((e) => e.alive);
    // pilots
    for (const p of this.ships) this.pilot(p, calm);
    // pickups
    for (const k of this.kits) {
      if (t > k.exp) { k.gone = true; this.log.kitsExpired++; continue; }
      for (const p of this.ships) {
        if (!this.shipAlive(p)) continue; const s = p.s;
        const need = s.I < 0.95 * s.st.I || (k.type === 'large' && s.S < 0.7 * s.st.S);
        if (!need || hypot(p.x - k.x, p.y - k.y) > 120 + s.c.r) continue;
        const I0 = s.I, S0 = s.S;
        if (k.type === 'small') s.I = Math.min(s.st.I, s.I + 0.15 * s.st.I); else { s.I = Math.min(s.st.I, s.I + 0.35 * s.st.I); s.S = Math.min(s.st.S, s.S + 0.3 * s.st.S); }
        p.st.kitI += s.I - I0; p.st.kitS += s.S - S0; k.gone = true; this.log.kitsTaken++; break;
      }
    }
    this.kits = this.kits.filter((k) => !k.gone);
    for (const z of this.prizes) {
      if (t > z.exp) { z.gone = true; continue; }
      for (const p of this.ships) { if (!this.shipAlive(p) || hypot(p.x - z.x, p.y - z.y) > 120 + p.s.c.r) continue; if (z.it === 'bomb') { if (p.bombs < 4) { p.bombs = Math.min(4, p.bombs + 2); z.gone = true; } } else { const cap = { emp: 2, ion: 2, sing: 1 }[z.it]; if (p.items[z.it] < cap) { p.items[z.it]++; z.gone = true; } } if (z.gone) break; }
    }
    this.prizes = this.prizes.filter((z) => !z.gone);
    this.log.time = this.floorT / TICK; this.log.H = this.H();
  }
  spiralShot(e, dmg, shots) {
    for (let j = 0; j < shots; j++) {
      e.spinA = (e.spinA || 0) + 0.55;
      const ang = e.spinA + j * Math.PI;
      for (const p of this.ships) {
        if (!this.shipAlive(p)) continue;
        const dx = p.x - e.x, dy = p.y - e.y, dd = hypot(dx, dy); if (dd > 780) continue;
        let da = Math.abs(((Math.atan2(dy, dx) - ang) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (da < (p.s.c.r + 6) / dd && this.rng() < 0.7) this.hurtShip(p, dmg, 'energy', 'spinner shot');
      }
    }
  }
  nearestEnemy(x, y, maxD) { let best = null, bd = maxD; for (const e of this.enemies) if (e.alive) { const d = hypot(e.x - x, e.y - y) - e.r; if (d < bd) { bd = d; best = e; } } return best; }
  countNear(x, y, r) { let n = 0; for (const e of this.enemies) if (e.alive && hypot(e.x - x, e.y - y) < r) n++; return n; }

  // ------------------------------------------------------------------ pilot AI + reactor
  pilot(p, calm) {
    const t = this.t, s = p.s;
    if (!this.shipAlive(p)) return;
    p.st.aliveTicks++;
    const cls = p.cls, HS = this.room.hs;
    const tgt = this.nearestEnemy(p.x, p.y, 2000);
    const td = tgt ? hypot(tgt.x - p.x, tgt.y - p.y) : 1e9;
    const iF = s.I / s.st.I;
    const inRange = tgt && td - tgt.r <= s.w.range;
    // feathering (spec §12): release at heat ≥ 90 (MD/LZ) or ≥ 60 (PH), resume < 40
    const hi = s.w.id === 'phaser' ? 60 : 90;
    if (p.held && s.heat >= hi) p.held = false; else if (!p.held && s.heat < 40) p.held = true;
    const inp = { thrust: true, lmb: !!(inRange && p.held && !calm), rmb: false, space: false, ab: false, cont: [] };
    // ----- movement intent (recomputed every SK.react ticks: reaction lag)
    const SK = this.SK;
    const recompute = !p.intent || (t + p.i * 3) % SK.react === 0;
    let mx = 0, my = 0;
    const band = { massdriver: [120, 260], laser: [500, 900], phaser: [350, 600] }[s.w.id];
    const polar = t < s.polarUntil || s.polarSus;
    let thx = 0, thy = 0, near = 0;
    for (const e of this.enemies) { if (!e.alive) continue; const dx = p.x - e.x, dy = p.y - e.y, dd = hypot(dx, dy); if (dd < SK.R) { const w = (e.d.kami ? (cls === 'brute' && polar ? 0 : 1) : 2.5) / Math.max(30, dd); thx += dx / dd * w; thy += dy / dd * w; near++; } }
    if (tgt) {
      const dx = tgt.x - p.x, dy = tgt.y - p.y;
      if (cls === 'brute' && polar && tgt.d.kami) { mx += dx / td; my += dy / td; } // polarized: wade into swarmers
      else if (td > band[1]) { mx += dx / td * 0.8; my += dy / td * 0.8; }
      else if (td < band[0]) { mx -= dx / td; my -= dy / td; }
      else { mx += -dy / td * 0.6; my += dx / td * 0.6; } // orbit
    }
    { const tm = hypot(thx, thy); if (tm > 0) { mx += thx / tm * Math.min(SK.W, tm * 60 * SK.W / 2); my += thy / tm * Math.min(SK.W, tm * 60 * SK.W / 2); } }
    // kits / Artificer when hurt
    if (iF < 0.7) { let bk = null, bd = 700; for (const k of this.kits) { const d = hypot(k.x - p.x, k.y - p.y); if (d < bd) { bd = d; bk = k; } } if (bk) { mx += (bk.x - p.x) / bd * 1.5; my += (bk.y - p.y) / bd * 1.5; } }
    if (iF < 0.5 && cls !== 'engineer') { const a = this.ships.find((q) => q.cls === 'engineer' && this.shipAlive(q)); if (a) { const d = hypot(a.x - p.x, a.y - p.y); if (d > 300) { mx += (a.x - p.x) / d; my += (a.y - p.y) / d; } } }
    if (calm) { const d = hypot(p.x, p.y); if (d > 150) { mx = -p.x / d; my = -p.y / d; } else { mx = 0; my = 0; } }
    // wall avoidance
    const wm = 160; if (p.x > HS - wm) mx -= (p.x - HS + wm) / wm * 2; if (p.x < -HS + wm) mx += (-HS + wm - p.x) / wm * 2; if (p.y > HS - wm) my -= (p.y - HS + wm) / wm * 2; if (p.y < -HS + wm) my += (-HS + wm - p.y) / wm * 2;
    if (!calm && SK.jit > 0) { if (!p.jit || t % 30 === 0) { const a = this.rng() * 6.283; p.jit = [Math.cos(a), Math.sin(a)]; } mx += p.jit[0] * SK.jit; my += p.jit[1] * SK.jit; }
    if (recompute || calm) p.intent = [mx, my]; else { mx = p.intent[0]; my = p.intent[1]; }
    let dir = null; const mm = hypot(mx, my); if (mm > 0.15) dir = [mx / mm, my / mm]; else inp.thrust = false;
    // afterburner: fleeing when hurt, power > 45%
    const retreat = { brute: 0.3, tech: 0.45, engineer: 0.4 }[cls];
    if (iF < retreat && near >= 3 && s.P > 0.45 * s.st.P) inp.ab = true;
    // ----- skills
    const self = this;
    const rayWanted = this.ray && cls === 'engineer' && (() => {
      let best = null, bf = calm ? 0.98 : 0.75;
      for (const q of this.ships) if (q !== p && this.shipAlive(q) && hypot(q.x - p.x, q.y - p.y) < 450) { const f = q.s.I / q.s.st.I; if (f < bf) { bf = f; best = q; } }
      if (best) return best;
      if (iF < (calm ? 0.98 : 0.6)) return p;
      return null;
    })();
    if (rayWanted && s.P > 0.2 * s.st.P) { inp.space = true; p.rayTgt = rayWanted; inp.cont.push(p.rayDraw = { draw: 170 }); } else p.rayTgt = null;
    if (cls === 'brute' && this.polarize) {
      const tapOn = t < s.polarUntil;
      if (!tapOn && !s.polarSus && t >= s.utilReady && (this.countNear(p.x, p.y, 160) >= 3 || this.countNear(p.x, p.y, 250) >= 5)) s._wantPolar = true;
      if (s._tapActive && !tapOn && !s.polarSus && !s._susChecked) {
        s._susChecked = true;
        if (this.countNear(p.x, p.y, 120) >= 2 && s.P > 0.4 * s.st.P && !s.brown) s.polarSus = true;
        else { s._tapActive = false; s.utilReady = t + 11 * TICK; }
      }
      if (s.polarSus && (this.countNear(p.x, p.y, 120) < 2 || s.P < 0.4 * s.st.P)) s.polarSus = false;
      if (s._tapActive && s._susChecked && !s.polarSus) { s._tapActive = false; s.utilReady = t + 11 * TICK; }
    }
    const r = reactorTick(s, inp, t, {
      onShot: (dmg, kind) => self.primaryHit(p, tgt, dmg, kind),
      spend: (sh, L, sur, tt) => {
        if (calm) return;
        // RMB (bot rule: power > 50% or heat < 40)
        const rmbOk = sh.P > 0.5 * sh.st.P || sh.heat < 40;
        if (rmbOk && tt >= sh.secReady && tgt) {
          const c = sh.c.sec, cost = c.cost * sur;
          if (sh.P >= cost) {
            if (cls === 'brute' && td < 700) { sh.P -= cost; sh.secReady = tt + c.cd * TICK; for (let i = 0; i < 3; i++) { if (self.rng() < 0.85) self.splash(tgt.x + (self.rng() - 0.5) * 40, tgt.y + (self.rng() - 0.5) * 40, 70, 180 * self.B.dmg, p); } }
            if (cls === 'tech' && td < 600) { sh.P -= cost; sh.secReady = tt + c.cd * TICK; self.arc(p, tgt); }
            if (cls === 'engineer' && td < 550 && self.sentries.filter((x) => x.owner === p).length < 2) { sh.P -= cost; sh.secReady = tt + c.cd * TICK; self.sentries.push({ x: p.x, y: p.y, hp: 600, life: 15 * TICK, next: tt + 20, owner: p }); }
          }
        }
        // Space (tap skills)
        if (tt >= sh.mobReady && tgt) {
          const c = sh.c.mob, cost = c.cost * sur;
          if (cls === 'brute' && sh.P >= cost && self.countNear(p.x + (tgt.x - p.x) / td * 260, p.y + (tgt.y - p.y) / td * 260, 200) >= 4 && iF > 0.3) { sh.P -= cost; sh.mobReady = tt + 6 * TICK; self.ram(p, tgt, td); }
          if (cls === 'tech' && sh.P >= cost && self.countNear(p.x, p.y, 90) >= 1 && (sh.S < 0.5 * sh.st.S || iF < 0.6)) { sh.P -= cost; sh.mobReady = tt + 5 * TICK; self.blink(p); }
          if (cls === 'engineer' && sh.P >= cost && self.ships.some((q) => self.shipAlive(q) && hypot(q.x - p.x, q.y - p.y) < 380 && (q.s.I < 0.85 * q.s.st.I || q.s.S < 0.5 * q.s.st.S))) { sh.P -= cost; sh.mobReady = tt + 9 * TICK; self.pulse(p); }
        }
        // E
        if (tt >= sh.utilReady) {
          const c = sh.c.util, cost = c.cost * sur;
          if (cls === 'brute' && sh._wantPolar && sh.P >= cost) { sh.P -= cost; sh.polarUntil = tt + 4 * TICK; sh._wantPolar = false; sh.utilReady = tt + 1e9; sh._tapActive = true; sh._susChecked = false; }
          if (cls === 'tech' && tgt && sh.P >= cost) { const cx = tgt.x, cy = tgt.y; if (td < 600 && self.countNear(cx, cy, 280) >= 5) { sh.P -= cost; sh.utilReady = tt + 10 * TICK; self.wells.push({ x: cx, y: cy, r: 280, pull: 900, dps: 120 * self.B.dmg, life: 3 * TICK, owner: p }); } }
          if (cls === 'engineer' && tgt && sh.P >= cost && self.countNear(p.x, p.y, 350) >= 5) { sh.P -= cost; sh.utilReady = tt + 14 * TICK; const ux = (tgt.x - p.x) / td, uy = (tgt.y - p.y) / td; const cx = p.x + ux * 120, cy = p.y + uy * 120; self.walls.push({ ax: cx - uy * 110, ay: cy + ux * 110, bx: cx + uy * 110, by: cy - ux * 110, hp: 1500, life: 6 * TICK }); }
        }
        if (self.items) self.useItems(p, sh, sur, tt, tgt, td);
      },
    });
    if (s.polarSus || t < s.polarUntil) p.st.polarTicks++;
    if (s.brown) p.st.brownTicks++;
    // ray effect (after the reactor paid it)
    if (p.rayTgt && p.rayDraw && p.rayDraw.paid && !s.brown) {
      const q = p.rayTgt, qs = q.s;
      const I0 = qs.I, S0 = qs.S;
      if (q === p) qs.I = Math.min(qs.st.I, qs.I + 70 * DT);
      else if (qs.I < qs.st.I) qs.I = Math.min(qs.st.I, qs.I + 150 * DT); else qs.S = Math.min(qs.st.S, qs.S + 220 * DT);
      q.st.healI += qs.I - I0; q.st.healS += qs.S - S0;
    }
    // Pulse Nova-like auto (progression)
    if (this.B.nova > 0 && t >= p.novaNext && !calm) { const a = this.B.nova; p.novaNext = t + Math.round((4.2 - 0.35 * a) * TICK); this.splash(p.x, p.y, 140 + 22 * a, 130 + 55 * a, p, true); }
    // bomb regen
    if (p.bombs < 2 && --p.bombRegen <= 0) { p.bombs++; p.bombRegen = 18 * TICK; }
    // movement
    if (p.chargeUntil > t) { p.x += p.chargeDir[0] * 1500 * DT; p.y += p.chargeDir[1] * 1500 * DT; this.ramHits(p); }
    else if (p.driveUntil > t) { p.vx *= 1 - 10 * DT; p.vy *= 1 - 10 * DT; p.x += p.vx * DT; p.y += p.vy * DT; }
    else { const b = { x: p.x, y: p.y, vx: p.vx, vy: p.vy }; moveStep(b, s.c, dir, r.ab, r.speedMult, 1); p.x = b.x; p.y = b.y; p.vx = b.vx; p.vy = b.vy; }
    const lim = HS - s.c.r; if (p.x > lim) { p.x = lim; p.vx = -Math.abs(p.vx) * 0.5; } if (p.x < -lim) { p.x = -lim; p.vx = Math.abs(p.vx) * 0.5; } if (p.y > lim) { p.y = lim; p.vy = -Math.abs(p.vy) * 0.5; } if (p.y < -lim) { p.y = -lim; p.vy = Math.abs(p.vy) * 0.5; }
  }
  primaryHit(p, tgt, dmg, kind) {
    if (!tgt || !tgt.alive) return;
    const s = p.s, w = s.w, d = hypot(tgt.x - p.x, tgt.y - p.y);
    let pHit = kind === 'beam' ? 0.9 : Math.max(0.5, 0.92 - 0.4 * d / w.range);
    if (tgt.kind === 'weaver') pHit *= 0.75;
    if (this.rng() > pHit) return;
    const m = w.falloff ? mdFalloff(d, w.range, w.falloffFloor) : 1;
    const amt = dmg * m * w.enemyMult;
    this.damageEnemy(tgt, amt, p);
    if (w.enemyPierce > 0) {
      // first other enemy near the line beyond the target
      const ux = (tgt.x - p.x) / (d || 1), uy = (tgt.y - p.y) / (d || 1);
      let best = null, bt = 1e9;
      for (const e of this.enemies) { if (!e.alive || e === tgt) continue; const ex = e.x - p.x, ey = e.y - p.y, along = ex * ux + ey * uy; if (along <= d || along > w.range) continue; const perp = Math.abs(ex * uy - ey * ux); if (perp < e.r + 5 && along < bt) { bt = along; best = e; } }
      if (best) this.damageEnemy(best, amt * w.enemyPierceMult, p);
    }
  }
  splash(x, y, R, dmg, p, flat = false) { for (const e of this.enemies) { if (!e.alive) continue; const dd = hypot(e.x - x, e.y - y); if (dd < R + e.r) this.damageEnemy(e, flat ? dmg : dmg * (dd < 20 ? 1 : 0.7), p); } }
  arc(p, tgt) { let cur = tgt, dmg = 220 * this.B.dmg; const hit = new Set(); for (let h = 0; h < 4 && cur; h++) { hit.add(cur); this.damageEnemy(cur, dmg, p); dmg *= 0.85; let nx = null, nd = 260; for (const e of this.enemies) { if (!e.alive || hit.has(e)) continue; const dd = hypot(e.x - cur.x, e.y - cur.y); if (dd < nd) { nd = dd; nx = e; } } cur = nx; } }
  ram(p, tgt, td) { p.chargeDir = [(tgt.x - p.x) / td, (tgt.y - p.y) / td]; p.chargeUntil = this.t + Math.round(0.35 * TICK); p.s.chargeUntil = p.chargeUntil; p.chargeHit = new Set(); }
  ramHits(p) { for (const e of this.enemies) { if (!e.alive || p.chargeHit.has(e)) continue; if (hypot(e.x - p.x, e.y - p.y) < p.s.c.r + e.r + 10) { p.chargeHit.add(e); this.damageEnemy(e, 400 * this.B.dmg, p); } } if (this.t + 1 >= p.chargeUntil) { p.vx = p.chargeDir[0] * p.s.c.max; p.vy = p.chargeDir[1] * p.s.c.max; } }
  blink(p) { let cx = 0, cy = 0, n = 0; for (const e of this.enemies) if (e.alive && hypot(e.x - p.x, e.y - p.y) < 320) { cx += e.x; cy += e.y; n++; } if (!n) return; cx /= n; cy /= n; const dx = p.x - cx, dy = p.y - cy, d = hypot(dx, dy) || 1; const HS = this.room.hs - 40; p.x = Math.max(-HS, Math.min(HS, p.x + dx / d * 480)); p.y = Math.max(-HS, Math.min(HS, p.y + dy / d * 480)); p.s.invulnUntil = this.t + Math.round(0.3 * TICK); }
  pulse(p) { for (const q of this.ships) { if (!this.shipAlive(q) || hypot(q.x - p.x, q.y - p.y) > 380) continue; const qs = q.s, I0 = qs.I, S0 = qs.S; const heal = 0.22 * qs.st.I; const over = Math.max(0, qs.I + heal - qs.st.I); qs.I = Math.min(qs.st.I, qs.I + heal); qs.S = Math.min(qs.st.S, qs.S + over + 0.15 * qs.st.S); q.st.healI += qs.I - I0; q.st.healS += qs.S - S0; } }
  useItems(p, sh, sur, tt, tgt, td) {
    if (tt < p.itemReady || !tgt) return;
    const iF = sh.I / sh.st.I;
    if (this.drive && p.items.sing > 0 && this.countNear(p.x, p.y, 520) >= 12 && iF > 0.5 && sh.P > 0.6 * sh.st.P && sh.P >= 250 * sur) { sh.P -= 250 * sur; p.items.sing--; p.driveUntil = tt + 5 * TICK; sh.singUntil = tt + 5 * TICK; p.itemReady = tt + 0.8 * TICK; this.log.drives++; return; }
    if (p.items.emp > 0 && this.countNear(p.x, p.y, 300) >= 8 && sh.P >= 150 * sur) { sh.P -= 150 * sur; p.items.emp--; p.itemReady = tt + 0.8 * TICK; this.log.emps++; for (const e of this.enemies) if (e.alive && hypot(e.x - p.x, e.y - p.y) < 300) { e.stun = tt + 1.5 * TICK; this.damageEnemy(e, 150, p); } return; }
    if (p.items.ion > 0 && td < 400 && this.countNear(tgt.x, tgt.y, 240) >= 6 && sh.P >= 180 * sur) { sh.P -= 180 * sur; p.items.ion--; p.itemReady = tt + 0.8 * TICK; this.log.ionUses++; this.ions.push({ x: tgt.x, y: tgt.y, life: 6 * TICK, owner: p }); return; }
    if (p.bombs > 0 && td < 500 && this.countNear(tgt.x, tgt.y, 150) >= 3 && sh.P >= 120 * sur) { sh.P -= 120 * sur; p.bombs--; p.itemReady = tt + 0.8 * TICK; this.log.bombs++; this.bombsFlying.push({ x: tgt.x, y: tgt.y, at: tt + Math.round(td / 650 * TICK), owner: p }); }
  }

  // ------------------------------------------------------------------ run a floor
  run() {
    const plan = this.endless ? 'E' : floorPlan(this.f);
    for (const k of plan) {
      if (k === 'E') { this.room = { hs: 600 }; this.ships.forEach((p, i) => { p.x = (i - 3) * 40; p.y = 0; }); this.fight({ pulses: 0, endless: true }); break; }
      const ok = this.runEncounter(k);
      if (!ok) break;
      // travel: calm ticks (shield regen, repairs)
      this.enemies = []; this.room = { hs: 600 };
      for (let i = 0; i < this.travelSec * TICK; i++) this.tick(true);
      this.kits = []; // they stay behind in the room
    }
    return this.summary();
  }
  summary() {
    const byCls = {};
    const mins = Math.max(1e-9, this.floorT / TICK / 60);
    for (const p of this.ships) {
      const b = byCls[p.cls] || (byCls[p.cls] = { n: 0, deaths: 0, firstDeath: [], dmgI: 0, dmgS: 0, kitI: 0, healI: 0, healS: 0, kills: 0, dealt: 0, brown: 0, alive: 0, polar: 0, maxI: p.s.st.I });
      b.n++; b.deaths += p.st.deaths; if (p.st.firstDeath >= 0) b.firstDeath.push(p.st.firstDeath); b.dmgI += p.st.dmgI; b.dmgS += p.st.dmgS; b.kitI += p.st.kitI; b.healI += p.st.healI; b.healS += p.st.healS; b.kills += p.st.kills; b.dealt += p.st.dealt; b.brown += p.st.brownTicks; b.alive += p.st.aliveTicks; b.polar += p.st.polarTicks;
    }
    return { f: this.f, n: this.n, pve: this.pve, time: this.floorT / TICK, mins, H: this.H(), lives: this.lives, log: this.log, byCls, level: this.level };
  }
}
function segDist(x, y, w) { const vx = w.bx - w.ax, vy = w.by - w.ay, L2 = vx * vx + vy * vy; let u = ((x - w.ax) * vx + (y - w.ay) * vy) / L2; u = Math.max(0, Math.min(1, u)); return hypot(x - (w.ax + u * vx), y - (w.ay + u * vy)); }

module.exports = { Floor, floorPlan, buildOf };
