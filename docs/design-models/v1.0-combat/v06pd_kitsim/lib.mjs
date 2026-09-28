// SCRATCH numeric core (NOT project code): the judged Continuum Reactor (CR) combat model with the judge's required fixes,
// re-implemented standalone so the three v1.0 ability-kit proposals can be checked on one common base. 60 Hz tick-accurate.
// Sources: CR numbers as modelled in ../v06pd_numsim/core.js + inertia.js; judge fixes: strain throttles regen (L2 x0.85,
// L3 x0.6), Phaser integrity x0.9 and overheat rate x0.75, heat vent to 40 with a 1.5 s lockout, movement hard clamp while
// thrusting (2500 px/s^2 impulse bleed), Rocket Salvo life 1.0 s, PvP bombs 300, Polarize sustain 200/s.
export const TICK = 60, DT = 1 / TICK;
export const LOAD_SURCHARGE = [1, 1, 1.25, 1.6];
export const STRAIN_SPEED = [1, 1, 0.9, 0.75];
export const STRAIN_REGEN = [1, 1, 0.85, 0.6]; // judge fix
export const SHIELD_LOAD = [1.6, 1, 0.5, 0.15];
export const SHIELD_POWER_COST = 0.6, LOW_POWER_FRAC = 0.2, BROWNOUT_RECOVER = 0.25, BROWNOUT_SPEED = 0.7;
export const ARMOR_CAP = 0.7, AUTO_VS_SHIP = 0.6, BOOST_THRUST = 1.5, IMPULSE_BLEED = 2500;

// CR §1 classes (+ judge fixes). `I` of the Arcanist is kit-dependent (Hero Kits keeps 420; Arcade & Sortie use the 500 fix).
export const CLASSES = {
  brute: { id: 'brute', name: 'Juggernaut', short: 'Jugg', P: 1000, R: 280, thr: 40, ab: 240, S: 500, Sr: 170, sd: 2.2, sb: 3.4, I: 900, armor: 0.4, r: 22,
    thrust: 620, max: 430, abMax: 640, turn: 10, drag: 0.55, brake: 70, grip: 0.15, knock: 0.5 },
  tech: { id: 'tech', name: 'Arcanist', short: 'Arca', P: 1300, R: 320, thr: 15, ab: 200, S: 380, Sr: 240, sd: 1.4, sb: 2.4, I: 500, armor: 0, r: 16,
    thrust: 1100, max: 500, abMax: 760, turn: 16, drag: 2.0, brake: 1800, grip: 1.0, knock: 1.0 },
  engineer: { id: 'engineer', name: 'Artificer', short: 'Arti', P: 1000, R: 420, thr: 25, ab: 200, S: 450, Sr: 200, sd: 1.8, sb: 2.8, I: 600, armor: 0.1, r: 18,
    thrust: 900, max: 470, abMax: 700, turn: 13, drag: 1.2, brake: 300, grip: 0.5, knock: 0.8 },
};
export const CLS = ['brute', 'tech', 'engineer'];
export const SHORT = { brute: 'Jugg', tech: 'Arca', engineer: 'Arti' };
export const CAPNAME = { brute: 'Dreadnought', tech: 'Spire', engineer: 'Foundry' };
export const capMass = (n) => 1 + 0.25 * n;
export const hostPen = (n) => Math.max(0.5, 1 - 0.07 * n);

/** Damage-type multipliers [vs shield, vs integrity, armor factor] (CR §7 + judge Phaser x0.9). */
export const TYPE = { kinetic: [0.8, 1.2, 1], energy: [1, 1, 1], phase: [2.5, 0.9, 1], ion: [1.5, 0.5, 1], contact: [1, 1, 1], crush: [1, 1, 0.5], emp: [1, 0, 0] };

// CR §3 weapons + class mounts.
export const WEAPONS = {
  massdriver: { id: 'massdriver', short: 'MD', beam: false, type: 'kinetic', dmg: 48, cd: 0.1, cost: 18, speed: 1300, life: 0.4, falloff: true,
    heat: { shot: 2.5, sec: 0, decay: 40, delay: 0.25, hot: 50, hotMult: 2, overShieldShot: 8 } },
  laser: { id: 'laser', short: 'LZ', beam: true, type: 'energy', dps: 240, draw: 150, range: 1100,
    heat: { shot: 0, sec: 30, decay: 50, delay: 0.25, hot: 60, hotMult: 1.5, overShieldSec: 70 } },
  phaser: { id: 'phaser', short: 'PH', beam: false, type: 'phase', dmg: 70, cd: 0.25, cost: 28, speed: 1400, life: 0.5, falloff: false,
    heat: { shot: 8, sec: 0, decay: 35, delay: 0.3, hot: 60, hotMult: 1.5, overCd: 1 / 0.75 } },
};
export const WPN = ['massdriver', 'laser', 'phaser'];
export const DEFAULT_WPN = { brute: 'massdriver', tech: 'laser', engineer: 'phaser' };
export const MOUNTS = {
  brute: { dmg: 1.15, cd: 1.1, range: 0.9, heat: 0.8, cost: 1.1, laserDps: 1.15, laserDraw: 1.1 },
  tech: { dmg: 1, cd: 1, range: 1.15, heat: 1.1, cost: 1, laserDps: 1.05, laserDraw: 1 },
  engineer: { dmg: 0.85, cd: 0.87, range: 1, heat: 1, cost: 0.85, laserDps: 0.9, laserDraw: 0.85 },
};
export function weaponStats(cls, wid) {
  const w = WEAPONS[wid], m = MOUNTS[cls];
  if (w.beam) return { ...w, dps: w.dps * m.laserDps, draw: w.draw * m.laserDraw, range: w.range * m.range, heatMult: m.heat };
  return { ...w, dmg: w.dmg * m.dmg, cd: w.cd * m.cd, cost: w.cost * m.cost, range: w.speed * w.life * m.range, heatMult: m.heat };
}
/** Mass Driver damage multiplier by travelled distance (x1.3 point blank -> x1 at 200 -> x0.4 at max range). */
export function mdFalloff(d, range) { if (d <= 200) return 1.3 - 0.3 * (d / 200); if (d >= range) return 0.4; return 1 - 0.6 * ((d - 200) / (range - 200)); }
/** Raw (pre-target) sustained cold dps of a weapon at distance d (0 if out of range). */
export function rawDps(ws, d) {
  if (d > ws.range) return 0;
  if (ws.beam) return ws.dps;
  return ws.dmg / ws.cd * (ws.falloff ? mdFalloff(d, ws.range) : 1);
}

/** A damageable ship-like target. */
export function makeTarget(c, o = {}) {
  const S = o.S ?? c.S, I = o.I ?? c.I;
  return { c, maxS: S, maxI: I, S: o.shieldDown ? 0 : S, I, armor: Math.min(ARMOR_CAP, (o.armor ?? c.armor)), h: o.h ?? 0, dead: false, deadAt: -1, dealtS: 0, dealtI: 0 };
}
/** CR §7 pipeline: hardening h, then shield (type mult) with clean overflow, then integrity (type mult, armor x factor). */
export function hit(t, amount, type, h = 0, now = 0) {
  if (t.dead || amount <= 0) return 0;
  amount *= 1 - Math.min(0.95, Math.max(h, t.h));
  const [sm, im, af] = TYPE[type];
  let over = 0;
  if (type === 'emp') { const sd = Math.min(t.S, amount * sm); t.S -= sd; t.dealtS += sd; return sd; }
  if (t.S > 0) { const sd = amount * sm; if (sd <= t.S) { t.S -= sd; t.dealtS += sd; } else { over = (sd - t.S) / sm; t.dealtS += t.S; t.S = 0; } }
  else over = amount;
  const id = over * im * (1 - t.armor * af);
  t.I -= id; t.dealtI += id;
  if (t.I <= 0 && !t.dead) { t.dead = true; t.deadAt = now; t.I = 0; }
  return id;
}
export const left = (t) => (t.dead ? 'DOWN' : `${Math.round(t.S)}/${Math.round(t.I)}`);
/** Raw damage of a type needed to take down a target from its current state. */
export function rawToKill(t, type) {
  const [sm, im, af] = TYPE[type];
  if (im === 0) return Infinity;
  return t.S / sm + t.I / (im * (1 - t.armor * af));
}

/**
 * Time-to-kill of a held weapon at fixed distance vs a target (100% hit rate; heat + judge vent fix; target shield regen
 * blocked by the constant fire). opts: {shieldDown, h, dmgMult, pre:[{t, amt, type}] extra packets, maxT}.
 */
export function ttk(attCls, wid, tgtCls, d, opts = {}) {
  const ws = weaponStats(attCls, wid), c = opts.tgtClass ?? CLASSES[tgtCls];
  const tg = makeTarget(c, { shieldDown: opts.shieldDown, h: opts.h, I: opts.I });
  let heat = 0, gunReady = 0, t = 0;
  const pre = (opts.pre || []).slice();
  const maxT = opts.maxT ?? 30;
  for (let k = 0; k < maxT * TICK && !tg.dead; k++) {
    t = k * DT;
    for (const p of pre) if (!p.done && t >= p.t) { p.done = true; hit(tg, p.amt, p.type, 0, t); }
    if (tg.dead) break;
    // (overheated MD / Laser keep firing on the shooter's own shield for several seconds, so no vent inside a TTK window)
    if (d > ws.range || t < (opts.startAt ?? 0)) continue;
    const f = ws.falloff ? mdFalloff(d, ws.range) : 1;
    const H = ws.heat;
    if (ws.beam) {
      hit(tg, ws.dps * DT * (opts.dmgMult ?? 1), ws.type, 0, t);
      heat = Math.min(100, heat + H.sec * ws.heatMult * DT);
    } else if (t >= gunReady) {
      hit(tg, ws.dmg * f * (opts.dmgMult ?? 1), ws.type, 0, t);
      const cdm = heat >= 100 && H.overCd ? H.overCd : 1;
      gunReady = t + ws.cd * cdm;
      heat = Math.min(100, heat + H.shot * ws.heatMult);
    }
  }
  return tg.dead ? tg.deadAt : Infinity;
}

// ---------------------------------------------------------------- movement (CR §6.1 + judge clamp)
/**
 * One tick. b {x,y,vx,vy}; c class; o {dir:[x,y]|null, boost, stop (FULL STOP), stopBrake, m (capitalMass), sm (speedMult),
 * ext:[ax,ay] external accel (pulls)}. While thrusting, speed is hard-clamped to the cap; excess (impulses) bleeds at 2500.
 */
export function moveStep(b, c, o = {}) {
  const m = o.m ?? 1, sm = o.sm ?? 1;
  if (o.ext) { b.vx += o.ext[0] * DT; b.vy += o.ext[1] * DT; }
  const dir = o.dir;
  if (dir) {
    const a = c.thrust * sm * (o.boost ? BOOST_THRUST : 1) * (o.thrustMult ?? 1) / m;
    b.vx += dir[0] * a * DT; b.vy += dir[1] * a * DT;
    const along = Math.max(0, b.vx * dir[0] + b.vy * dir[1]);
    const wx = b.vx - along * dir[0], wy = b.vy - along * dir[1], wm = Math.hypot(wx, wy);
    if (wm > 0) { const nm = Math.max(0, wm - (c.drag * c.grip * wm + c.brake * c.grip) / m * DT); const k = nm / wm; b.vx = along * dir[0] + wx * k; b.vy = along * dir[1] + wy * k; }
  } else {
    const sp = Math.hypot(b.vx, b.vy);
    const brake = (c.brake + (o.stop ? (o.stopBrake ?? 0) : 0)) / m;
    if (sp > 0) { const ns = Math.max(0, sp * (1 - c.drag / m * DT) - brake * DT); b.vx *= ns / sp; b.vy *= ns / sp; }
  }
  const cap = (o.boost ? (o.abMax ?? c.abMax) : (o.max ?? c.max)) * sm * (o.capMult ?? 1);
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > cap) {
    const tgt = dir && !o.impulse ? cap : Math.max(cap, sp - IMPULSE_BLEED * DT);
    b.vx *= tgt / sp; b.vy *= tgt / sp;
  }
  b.x += b.vx * DT; b.y += b.vy * DT;
}

// ---------------------------------------------------------------- misc
export function rng(seed = 1) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const f0 = (n) => (Number.isFinite(n) ? n.toFixed(0) : n === Infinity ? 'inf' : String(n));
export const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : n === Infinity ? 'inf' : String(n));
export const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : n === Infinity ? 'inf' : String(n));
export const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + '%' : String(x));
export function table(head, rows) {
  const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (r) => r.map((x, i) => String(x ?? '').padEnd(w[i])).join(' | ');
  return [line(head), w.map((n) => '-'.repeat(n)).join('-|-'), ...rows.map(line)].join('\n');
}
export function H(title) { return `\n${'='.repeat(110)}\n== ${title}\n${'='.repeat(110)}`; }
export const FLAGS = [];
/** Record a flagged (degenerate / risky / spec-gap) finding. sev: 'HIGH' | 'MED' | 'LOW'. */
export function flag(kit, sev, what, detail) { FLAGS.push({ kit, sev, what, detail }); }
