// Scratch numeric model of the v1.0 "Continuum Reactor" proposal (NOT project code).
// Independent re-implementation of spec §1-§9 as written, tick-accurate at 60 Hz.
'use strict';
const TICK = 60, DT = 1 / TICK;
const LOAD_SURCHARGE = [1, 1, 1.25, 1.6];
const STRAIN_SPEED = [1, 1, 0.9, 0.75];
const SHIELD_LOAD = [1.6, 1, 0.5, 0.15];
const SHIELD_POWER_COST = 0.6, LOW_POWER_FRAC = 0.2, BROWNOUT_RECOVER = 0.25, BROWNOUT_SPEED = 0.7;
const ARMOR_CAP = 0.7, AUTO_VS_SHIP = 0.6;

const CLASSES = {
  brute: { name: 'Juggernaut', P: 1000, R: 280, thr: 40, ab: 240, S: 500, Sr: 170, sd: 2.2, sb: 3.4, I: 900, armor: 0.4, r: 22,
    thrust: 620, max: 430, abMax: 640, turn: 10, drag: 0.55, brake: 70, grip: 0.15, knock: 0.5,
    sec: { cost: 170, cd: 1.4 }, mob: { cost: 120, cd: 6 }, util: { cost: 120, cd: 11 } },
  tech: { name: 'Arcanist', P: 1300, R: 320, thr: 15, ab: 200, S: 380, Sr: 240, sd: 1.4, sb: 2.4, I: 420, armor: 0, r: 16,
    thrust: 1100, max: 500, abMax: 760, turn: 16, drag: 2.0, brake: 1800, grip: 1.0, knock: 1.0,
    sec: { cost: 150, cd: 1.1 }, mob: { cost: 120, cd: 5 }, util: { cost: 220, cd: 10 } },
  engineer: { name: 'Artificer', P: 1000, R: 420, thr: 25, ab: 200, S: 450, Sr: 200, sd: 1.8, sb: 2.8, I: 600, armor: 0.1, r: 18,
    thrust: 900, max: 470, abMax: 700, turn: 13, drag: 1.2, brake: 300, grip: 0.5, knock: 0.8,
    sec: { cost: 200, cd: 3 }, mob: { cost: 80, cd: 9 }, util: { cost: 150, cd: 14 } },
};
const CLS = ['brute', 'tech', 'engineer'];
const SHORT = { brute: 'Jugg', tech: 'Arca', engineer: 'Arti' };

const WEAPONS = {
  massdriver: { name: 'Mass Driver', beam: false, dtype: 'kinetic', dmg: 48, cd: 0.1, cost: 18, speed: 1300, life: 0.4,
    heat: { perShot: 2.5, perSec: 0, decay: 40, delay: 0.25, hot: 50, hotMult: 2, overShieldShot: 8, overShieldSec: 0, overCdMult: 1, vent: true },
    falloff: true, enemyPierce: 0, enemyMult: 1 },
  laser: { name: 'Laser', beam: true, dtype: 'energy', dps: 240, draw: 150, range: 1100,
    heat: { perShot: 0, perSec: 30, decay: 50, delay: 0.25, hot: 60, hotMult: 1.5, overShieldShot: 0, overShieldSec: 70, overCdMult: 1, vent: true },
    falloff: false, enemyPierce: 1, enemyPierceMult: 0.7, enemyMult: 1 },
  phaser: { name: 'Phaser', beam: false, dtype: 'phase', dmg: 70, cd: 0.25, cost: 28, speed: 1400, life: 0.5,
    heat: { perShot: 8, perSec: 0, decay: 35, delay: 0.3, hot: 60, hotMult: 1.5, overShieldShot: 0, overShieldSec: 0, overCdMult: 2, vent: false },
    falloff: false, enemyPierce: 1, enemyPierceMult: 1, enemyMult: 1.1 },
};
const WPN = ['massdriver', 'laser', 'phaser'];
const WSHORT = { massdriver: 'MD', laser: 'LZ', phaser: 'PH' };
const MOUNTS = {
  brute: { dmg: 1.15, cd: 1.1, range: 0.9, speed: 1, heat: 0.8, cost: 1.1, laserDps: 1.15, laserDraw: 1.1 },
  tech: { dmg: 1, cd: 1, range: 1.15, speed: 1.1, heat: 1.1, cost: 1, laserDps: 1.05, laserDraw: 1 },
  engineer: { dmg: 0.85, cd: 0.87, range: 1, speed: 1, heat: 1, cost: 0.85, laserDps: 0.9, laserDraw: 0.85 },
};
// [shield mult, integrity mult, armor factor]
const TYPE_MULT = {
  kinetic: [0.8, 1.2, 1], energy: [1, 1, 1], phase: [2.5, 0.7, 1], ion: [1.5, 0.5, 1], contact: [1, 1, 1],
  crush: [1, 1, 0.5], emp: [1, 0, 0], heat: [1, 1, 1],
};

/** Equipped weapon stats after the class mount (+ optional card mods). */
function weaponStats(cls, wid, mods = {}) {
  const w = WEAPONS[wid], m = MOUNTS[cls];
  const heatMult = m.heat * (mods.heatMult ?? 1);
  const costMult = mods.costMult ?? 1, dmgMult = mods.dmgMult ?? 1, cdMult = mods.cdMult ?? 1;
  if (w.beam) {
    return { id: wid, beam: true, dtype: w.dtype, dps: w.dps * m.laserDps * dmgMult, draw: w.draw * m.laserDraw * costMult,
      range: w.range * m.range, heat: w.heat, heatMult, enemyPierce: w.enemyPierce, enemyPierceMult: w.enemyPierceMult, enemyMult: w.enemyMult };
  }
  const speed = w.speed * m.speed, range = w.speed * w.life * m.range; // design table: range = base range × mount range
  return { id: wid, beam: false, dtype: w.dtype, dmg: w.dmg * m.dmg * dmgMult, cd: w.cd * m.cd * cdMult, cost: w.cost * m.cost * costMult,
    speed, range, heat: w.heat, heatMult, falloff: w.falloff, falloffFloor: mods.falloffFloor ?? 0.4,
    enemyPierce: w.enemyPierce, enemyPierceMult: w.enemyPierceMult ?? 1, enemyMult: w.enemyMult };
}
/** Mass Driver multiplier by distance travelled. */
function mdFalloff(d, range, floor = 0.4) {
  if (d <= 200) return 1.3 - 0.3 * (d / 200);
  if (d >= range) return floor;
  return 1 - (1 - floor) * ((d - 200) / Math.max(1, range - 200));
}
function hullDamageTier(f) { return f >= 0.85 ? 0 : f >= 0.7 ? 1 : f >= 0.5 ? 2 : f >= 0.3 ? 3 : f >= 0.15 ? 4 : 5; }

/** Build a ship. opts: weapon, reactorTiers (bool), cards {reactor, capacitor, efficiency, shieldcap, quickcharge, hullplate, plating, heatsink}, turrets n (capital) */
function makeShip(cls, opts = {}) {
  const c = CLASSES[cls];
  const cards = opts.cards || {};
  const n = opts.turrets || 0;
  const st = {
    P: c.P * (1 + 0.12 * (cards.capacitor || 0)) * (1 + 0.08 * n) * (opts.titan ? 1 : 1),
    R: c.R * (1 + 0.12 * (cards.reactor || 0)) * (1 + 0.10 * n) * (opts.titan ? 1.2 : 1) * (opts.coils ? 1.15 : 1),
    S: c.S * (1 + 0.12 * (cards.shieldcap || 0)) * (1 + 0.10 * n) * (opts.bulwark ? 1.2 : 1),
    Sr: c.Sr * (1 + 0.10 * (cards.quickcharge || 0)),
    sd: c.sd * Math.pow(0.9, cards.quickcharge || 0), sb: c.sb * Math.pow(0.9, cards.quickcharge || 0),
    I: c.I * (1 + 0.10 * (cards.hullplate || 0)) * (opts.bulwark ? 1.35 : 1) * (opts.titan ? 1.25 : 1),
    armor: Math.min(ARMOR_CAP, c.armor + 0.06 * (cards.plating || 0) + 0.03 * n + (opts.ramPlating ? 0.15 : 0)),
    thr: c.thr, ab: c.ab, costMult: Math.pow(0.9, cards.efficiency || 0) * 1,
  };
  const wmods = { heatMult: Math.pow(0.85, cards.heatsink || 0) * (opts.coils ? 0.75 : 1), costMult: st.costMult * (opts.coils ? 0.65 : 1),
    dmgMult: opts.wdmg || 1, cdMult: opts.wcd || 1 };
  const w = weaponStats(cls, opts.weapon || 'massdriver', wmods);
  return {
    cls, c, st, w, opts, n,
    P: st.P, S: st.S, I: st.I, heat: 0, ventUntil: -1, brown: false, shieldReady: 0, empUntil: -1,
    gunReady: 0, secReady: 0, mobReady: 0, utilReady: 0, lastTrig: -1e9, laserBank: 0, laserTick: 0,
    polarUntil: -1, polarSus: false, singUntil: -1, invulnUntil: -1, chargeUntil: -1, alive: true,
    tiers: !!opts.reactorTiers, stats: { brownouts: 0, brownTicks: 0, fired: 0, dmgOut: 0, powerSpent: 0, shieldRegen: 0, overheats: 0, vents: 0, ventTicks: 0, firstBrown: -1 },
    lowPowerTicks: 0,
  };
}
function effMaxP(s) { if (!s.tiers) return s.st.P; return s.st.P * (1 - 0.06 * hullDamageTier(s.I / s.st.I)); }
function effRegen(s) { if (!s.tiers) return s.st.R; return s.st.R * (1 - 0.07 * hullDamageTier(s.I / s.st.I)); }

/** Damage pipeline §7 (hardening h, armor on integrity only, no bleed-through). Returns {sd, idmg, broke}. */
function damageShip(s, amount, type, t, h = 0) {
  if (!s.alive || amount <= 0) return { sd: 0, idmg: 0 };
  if (t < s.invulnUntil) return { sd: 0, idmg: 0 };
  if (t < s.chargeUntil) amount *= 0.4;
  if (t < s.polarUntil || s.polarSus) h = Math.max(h, 0.5);
  amount *= 1 - Math.min(0.95, h);
  const [sm, im, af] = (s.opts.typeMult && s.opts.typeMult[type]) || TYPE_MULT[type];
  let sd = 0, overflow = 0, broke = false;
  const wasZero = s.S <= 0;
  if (type === 'emp') { sd = Math.min(s.S, amount * sm); s.S -= sd; if (s.S <= 0) broke = true; }
  else if (s.S > 0) {
    sd = amount * sm;
    if (sd <= s.S) { s.S -= sd; } else { overflow = (sd - s.S) / sm; sd = s.S; s.S = 0; broke = true; }
  } else overflow = amount;
  const armorEff = Math.min(ARMOR_CAP, s.st.armor) * af;
  const idmg = overflow * im * (1 - armorEff);
  s.I -= idmg;
  const polar = t < s.polarUntil || s.polarSus;
  if (!polar) s.shieldReady = t + Math.round(((broke || wasZero) ? s.st.sb : s.st.sd) * TICK);
  if (type === 'ion') s.P = Math.max(0, s.P - 0.5 * amount);
  if (s.I < 0) { s.alive = false; }
  return { sd, idmg, broke };
}

/**
 * One reactor tick (spec §2.1 steps 1-9) for a ship. inp = {thrust, ab, lmb, rmb, space, eSus (polarize sustain requested)}.
 * `spend(s, L, sur)` is called at step 6 for skills (returns nothing); the weapon is handled here and returns shot events via onShot(dmg).
 * Continuous draws (beyond the laser) are passed as inp.cont = [{draw}] -> each is taken with min(P, draw).
 */
function reactorTick(s, inp, t, hooks = {}) {
  if (!s.alive) return { L: 0, speedMult: 0, ab: false };
  const w = s.w;
  // 1 load
  let L = (inp.lmb ? 1 : 0) + (inp.rmb ? 1 : 0) + (inp.space ? 1 : 0) + (s.polarSus ? 1 : 0) + (t < s.singUntil ? 1 : 0);
  L = Math.min(3, L);
  const sur = LOAD_SURCHARGE[L];
  let cutBrown = false;
  // 2 thrust
  if (inp.thrust) {
    const cost = s.st.thr * DT;
    if (s.P >= cost) { s.P -= cost; s.stats.powerSpent += cost; } else cutBrown = true;
  }
  // 3 afterburner
  let ab = false;
  if (inp.ab && inp.thrust && !s.brown && s.P > s.st.ab * DT) { s.P -= s.st.ab * DT; ab = true; s.stats.powerSpent += s.st.ab * DT; }
  const speedMult = STRAIN_SPEED[L] * (s.brown ? BROWNOUT_SPEED : 1);
  // 5 regen
  const emp = t < s.empUntil;
  if (!ab && !emp) s.P = Math.min(effMaxP(s), s.P + effRegen(s) * (inp.regenMult || 1) * (s.opts.strainRegen ? s.opts.strainRegen[L] : 1) * DT);
  // 6 spend: weapon
  const venting = t < s.ventUntil;
  const overheated = s.heat >= 100;
  if (inp.lmb) s.lastTrig = t;
  if (inp.lmb && !s.brown && !venting) {
    const H = w.heat;
    if (w.beam) {
      const draw = w.draw * (s.heat >= H.hot ? H.hotMult : 1) * sur * DT;
      if (s.P >= draw) {
        s.P -= draw; s.stats.powerSpent += draw;
        s.laserBank += w.dps * DT;
        s.heat = Math.min(100, s.heat + H.perSec * w.heatMult * DT);
        if (s.heat >= 100) { s.S = Math.max(0, s.S - H.overShieldSec * DT); if (s.opts.ovFix) s.shieldReady = Math.max(s.shieldReady, t + Math.round(s.st.sb * TICK)); if (s.S <= 0 && H.vent) { s.ventUntil = t + Math.round((s.opts.ovFix?.ventSec ?? 1) * TICK); s.heat = s.opts.ovFix?.ventTo ?? 70; s.stats.vents++; } }
        if (++s.laserTick % 6 === 0) { if (hooks.onShot) hooks.onShot(s.laserBank, 'beam'); s.stats.dmgOut += s.laserBank; s.laserBank = 0; s.stats.fired++; }
      } else { s.stats.powerSpent += s.P; s.P = 0; cutBrown = true; }
    } else if (t >= s.gunReady) {
      const cost = w.cost * (s.heat >= H.hot ? H.hotMult : 1) * sur;
      if (s.P >= cost) {
        s.P -= cost; s.stats.powerSpent += cost;
        const cdMult = (overheated || (s.phaserSlow && s.heat >= 60)) && H.overCdMult > 1 ? H.overCdMult : 1;
        if (overheated && H.overCdMult > 1) s.phaserSlow = true;
        if (s.phaserSlow && s.heat < 60) s.phaserSlow = false;
        s.gunReady = t + w.cd * cdMult * TICK; // fractional ticks allowed
        if (hooks.onShot) hooks.onShot(w.dmg, 'shot');
        s.stats.fired++; s.stats.dmgOut += w.dmg;
        if (overheated && H.overShieldShot > 0) { s.S = Math.max(0, s.S - H.overShieldShot); if (s.opts.ovFix) s.shieldReady = Math.max(s.shieldReady, t + Math.round(s.st.sb * TICK)); if (s.S <= 0 && H.vent) { s.ventUntil = t + Math.round((s.opts.ovFix?.ventSec ?? 1) * TICK); s.heat = s.opts.ovFix?.ventTo ?? 70; s.stats.vents++; } }
        s.heat = Math.min(100, s.heat + H.perShot * w.heatMult);
      }
    }
  }
  if (s.heat >= 100) s.stats.overheatTicks = (s.stats.overheatTicks || 0) + 1;
  if (venting) s.stats.ventTicks++;
  // 6 spend: skills + continuous draws
  if (!s.brown && hooks.spend) hooks.spend(s, L, sur, t);
  if (inp.cont && !s.brown) for (const c of inp.cont) {
    const need = c.draw * sur * DT;
    if (s.P >= need) { s.P -= need; s.stats.powerSpent += need; c.paid = true; } else { s.P = 0; c.paid = false; cutBrown = true; }
  }
  if (s.polarSus && !s.brown) {
    const need = (s.opts.polarSustain ?? 140) * sur * DT;
    if (s.P >= need) { s.P -= need; s.stats.powerSpent += need; } else { s.P = 0; s.polarSus = false; cutBrown = true; }
  }
  // 7 shield regen
  const overheatBlocks = s.heat >= 100 && w.heat.vent; // MD / Laser
  const polar = t < s.polarUntil || s.polarSus;
  if ((t >= s.shieldReady || polar) && s.S < s.st.S && !s.brown && !emp && !overheatBlocks && !ab) {
    const low = s.P < LOW_POWER_FRAC * effMaxP(s);
    let want = s.st.Sr * SHIELD_LOAD[L] * (low ? 0.5 : 1) * (inp.shieldMult || 1) * (polar && s.opts.polarShieldMult ? s.opts.polarShieldMult : 1) * DT;
    want = Math.min(want, s.st.S - s.S);
    let cost = want * SHIELD_POWER_COST;
    if (s.P < cost) { want = s.P / SHIELD_POWER_COST; cost = s.P; }
    s.S += want; s.P -= cost; s.stats.shieldRegen += want; s.stats.powerSpent += cost;
  }
  if (s.P < LOW_POWER_FRAC * effMaxP(s)) s.lowPowerTicks++;
  // 8 brownout
  if (!s.brown && (s.P <= 0.5 || cutBrown)) {
    s.P = 0; s.brown = true; s.stats.brownouts++; if (s.stats.firstBrown < 0) s.stats.firstBrown = t;
    s.polarSus = false; s.brownStart = t;
  } else if (s.brown && s.P >= BROWNOUT_RECOVER * effMaxP(s)) {
    s.brown = false; s.stats.lastRecover = t - s.brownStart; (s.stats.recovers = s.stats.recovers || []).push(t - s.brownStart);
  }
  if (s.brown) s.stats.brownTicks++;
  // 9 heat decay
  if (t - s.lastTrig > w.heat.delay * TICK) s.heat = Math.max(0, s.heat - w.heat.decay * DT);
  return { L, speedMult, ab };
}

const fmt = (n, d = 1) => (n === Infinity ? 'inf' : n === -Infinity ? '-inf' : Number.isFinite(n) ? n.toFixed(d) : String(n));
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

module.exports = { TICK, DT, LOAD_SURCHARGE, STRAIN_SPEED, SHIELD_LOAD, SHIELD_POWER_COST, CLASSES, CLS, SHORT, WEAPONS, WPN, WSHORT, MOUNTS,
  TYPE_MULT, weaponStats, mdFalloff, hullDamageTier, makeShip, effMaxP, effRegen, damageShip, reactorTick, fmt, pad, padr, AUTO_VS_SHIP, ARMOR_CAP };
