// Scratch numeric model of "Reactor / Shield / Hull: the ARPG resource model (v1.0.0)". NOT project code.
// Independent re-implementation of the spec's §1–§5 numbers, tick-accurate at 60 Hz.
export const TICK = 60, DT = 1 / TICK;

export const KIND = {
  kinetic: { vsShield: 0.85, vsHull: 1.15, pierce: 0.10 },
  energy: { vsShield: 1.0, vsHull: 1.0, pierce: 0 },
  ion: { vsShield: 2.5, vsHull: 0.6, pierce: 0 },
  thermal: { vsShield: 1.0, vsHull: 1.0, pierce: 0.30 },
  true: { vsShield: 0, vsHull: 1.0, pierce: 1 },
};
export const ARMOR_CAP = 0.7;
export const STRAIN_MOVE = [1, 1, 0.88, 0.72, 0.6];
export const STRAIN_SHIELD = [1, 1, 0.55, 0.2, 0];
export const STRAIN_HEAT = [1, 1, 1.15, 1.3, 1.45];
export const SHIELD_CALM_SEC = 0.6, SHIELD_CALM_MULT = 1.75, SHIELD_DOWN_CLEAR = 0.15;
export const BROWNOUT_RECOVER = 0.25, BROWNOUT_MOVE = 0.8;
export const SURGE_STEP = 0.25, SURGE_MAX = 3, SURGE_WINDOW = 2.5, CH_ESC = 0.2, CH_ESC_MAX = 3;
export const HEAT_VENT_DELAY = 0.3, HEAT_JAM_CLEAR = 60;
export const DC_DELAY = 8, DC_RATE = 0.015, DC_CAP = 0.5, NANO_DELAY = 4, NANO_RATE = 0.025;

export const CLASSES = {
  brute: {
    id: 'brute', name: 'Juggernaut', short: 'Jugg', armorType: 'heavy',
    maxShield: 650, shieldRegen: 130, shieldDelay: 2.4, shieldBreakDelay: 3.6, shieldPowerCost: 0.3,
    maxIntegrity: 900, armor: 0.40, maxPower: 900, powerRegen: 170, thrustPower: 28, abCost: 200,
    radius: 22, mass: 2.0, drag: 0.5, thrust: 650, maxSpeed: 420, abSpeed: 620, turnRate: 9, maxTurrets: 2,
    weapon: 'massdriver',
    sec: { name: 'Rocket Salvo', cost: 150, cd: 1.4, kind: 'kinetic', dmg: 180, count: 3, speed: 700, aoe: 3 },
    mob: { name: 'Ram Charge', cost: 110, cd: 6, kind: 'kinetic', dmg: 400, bleed: 0.25, dash: 1500 * 0.35 },
    util: { name: 'Polarize', engage: 30, need: 80, drain: 40, perContact: 10, absorb: 0.45 },
  },
  tech: {
    id: 'tech', name: 'Arcanist', short: 'Arca', armorType: 'phase',
    maxShield: 600, shieldRegen: 200, shieldDelay: 1.4, shieldBreakDelay: 2.6, shieldPowerCost: 0.3,
    maxIntegrity: 420, armor: 0, maxPower: 1150, powerRegen: 220, thrustPower: 14, abCost: 170,
    radius: 16, mass: 0.8, drag: 9.0, thrust: 1300, maxSpeed: 520, abSpeed: 780, turnRate: 16, maxTurrets: 2,
    weapon: 'laser',
    sec: { name: 'Arc Lightning', cost: 130, cd: 1.1, kind: 'energy', dmg: 220, count: 1, hops: 4, range: 600, aoe: 4 },
    mob: { name: 'Blink', cost: 100, cd: 5, dash: 480 },
    util: { name: 'Singularity', cost: 180, cd: 10 },
  },
  engineer: {
    id: 'engineer', name: 'Artificer', short: 'Arti', armorType: 'nano',
    maxShield: 550, shieldRegen: 160, shieldDelay: 1.9, shieldBreakDelay: 3.0, shieldPowerCost: 0.3,
    maxIntegrity: 650, armor: 0.15, maxPower: 1000, powerRegen: 280, thrustPower: 18, abCost: 180,
    radius: 18, mass: 1.1, drag: 2.4, thrust: 950, maxSpeed: 470, abSpeed: 700, turnRate: 13, maxTurrets: 3,
    weapon: 'phaser',
    sec: { name: 'Deploy Sentry', cost: 200, cd: 3, kind: 'kinetic', dmg: 90, fireCd: 1.2, max: 2, life: 15, range: 550 },
    mob: { name: 'Repair Ray', costPerSec: 90, ally: 180, self: 120, range: 460, fatigueSec: 3, fatigueMult: 0.6 },
    siphon: { name: 'Siphon Ray', costPerSec: 70, dps: 110, pveDps: 140, ret: 0.6, pveRet: 0.4, drain: 60, gainFrac: 0.5, range: 480 },
    util: { name: 'Shield Wall', cost: 150, cd: 14 },
  },
};
export const CLS = ['brute', 'tech', 'engineer'];

export const WEAPONS = {
  massdriver: { id: 'massdriver', short: 'MD', kind: 'kinetic', beam: false, dmg: 44, interval: 0.075, speed: 1250, range: 560,
    fStart: 160, fMin: 0.35, cost: 8, heat: 2.6, vent: 45, bleedNear: 0.18, knock: 25 },
  laser: { id: 'laser', short: 'LZ', kind: 'energy', beam: true, dps: 400, range: 900, costPerSec: 80, heatPerSec: 22, vent: 35,
    focusMult: 1.2, focusSpeed: 60, fStart: 1e9, fMin: 1 },
  phaser: { id: 'phaser', short: 'PH', kind: 'ion', beam: false, dmg: 72, interval: 0.17, speed: 1400, range: 680,
    fStart: 450, fMin: 0.7, cost: 22, heat: 7, vent: 50, breakLock: 0.8 },
};
export const WPN = ['massdriver', 'laser', 'phaser'];

export function falloff(w, d) {
  if (d > w.range) return 0;
  if (d <= w.fStart) return 1;
  return 1 - (1 - w.fMin) * (d - w.fStart) / (w.range - w.fStart);
}
export function mdBleed(d) { return 0.18 * Math.min(1, Math.max(0, 1 - (d - 160) / 400)); }

/** Class affinity: damage dealt multiplier by source kind. */
export function dealtMult(cls, kind) {
  if (cls.armorType === 'heavy' && kind === 'kinetic') return 1.15;
  if (cls.armorType === 'phase' && kind === 'energy') return 1.15;
  return 1;
}

/** Ship runtime state. mods: {armorAdd, shieldMult, hullMult, regenMult, powerRegenMult, maxPowerMult, weaponCostMult, heatMult, ventMult, costMult} */
export function makeShip(clsId, mods = {}) {
  const c = CLASSES[clsId];
  const s = {
    cls: c, id: clsId, t: 0,
    maxShield: c.maxShield * (mods.shieldMult ?? 1),
    maxIntegrity: c.maxIntegrity * (mods.hullMult ?? 1),
    maxPower: c.maxPower * (mods.maxPowerMult ?? 1),
    armor: Math.min(ARMOR_CAP, c.armor + (mods.armorAdd ?? 0)),
    shieldRegen: c.shieldRegen * (mods.regenMult ?? 1),
    shieldDelay: c.shieldDelay * (mods.delayMult ?? 1),
    shieldBreakDelay: c.shieldBreakDelay,
    powerRegen: c.powerRegen * (mods.powerRegenMult ?? 1),
    weaponCostMult: (c.armorType === 'nano' ? 0.8 : 1) * (mods.weaponCostMult ?? 1),
    heatMult: mods.heatMult ?? 1,
    ventMult: (c.armorType === 'nano' ? 1.2 : 1) * (mods.ventMult ?? 1),
    costMult: mods.costMult ?? 1,
    absorb: 0, brace: false, charging: false,
    shield: 0, integrity: 0, power: 0, heat: 0,
    regenAt: 0, lastDamageT: -1e9, lastHeldT: -1e9, shieldDown: false,
    brownout: false, jammed: false, lastFireT: -1e9, fireAcc: 0, polarLockUntil: 0,
    surge: {}, channelSince: -1,
    stats: { brownouts: 0, brownoutTime: 0, jamTime: 0, tapShield: 0, shieldRegenGained: 0, dmgOut: 0, jams: 0, firstBrownout: -1, firstOverheat: -1, firstJam: -1, recov: [] },
    weapon: mods.weapon ?? c.weapon,
  };
  s.shield = s.maxShield; s.integrity = s.maxIntegrity; s.power = s.maxPower;
  return s;
}

/**
 * The §2 pipeline. Returns {sDmg, H, broke}. amount = post-affinity raw damage.
 * opts: {kind, bleed, breakLock, noDelay}
 */
export function damageShip(s, amount, opts) {
  if (s.integrity <= 0 || amount <= 0) return { sDmg: 0, H: 0, broke: false };
  const K = KIND[opts.kind];
  if (s.charging) amount *= 0.4;
  if (s.entropy) amount *= 1.3;
  let bleed = opts.bleed ?? 0;
  if (s.cls.armorType === 'heavy') bleed *= 0.5;
  const B = amount * bleed, S = amount - B;
  let over = 0, sDmg = 0, broke = false;
  if (opts.kind === 'true') over = S;
  else if (s.shield > 0) {
    const resist = (s.cls.armorType === 'phase' && opts.kind === 'energy') ? 0.8 : 1;
    const sm = K.vsShield * resist * (1 - s.absorb) * (s.brace ? 0.65 : 1);
    sDmg = S * sm;
    if (sDmg <= s.shield) s.shield -= sDmg;
    else {
      over = (sDmg - s.shield) / sm; sDmg = s.shield; s.shield = 0; broke = true;
      s.regenAt = s.t + s.shieldBreakDelay + (opts.breakLock ?? 0);
      s.shieldDown = true; s.polarLockUntil = s.t + 3; s.polarized = false; s.absorb = s.fortressAbsorb ?? 0;
    }
  } else over = S;
  const armorEff = opts.kind === 'true' ? 0 : Math.min(ARMOR_CAP, Math.max(0, s.armor - K.pierce));
  const H = (B + over) * K.vsHull * (1 - armorEff) * (s.brace ? 0.75 : 1);
  s.integrity -= H;
  if (!opts.noDelay) { s.regenAt = Math.max(s.regenAt, s.t + s.shieldDelay); s.lastDamageT = s.t; }
  return { sDmg, H, broke };
}

/** Heal integrity; overflow ×0.5 → shield. Returns hull restored. */
export function healShip(s, amount) {
  const room = s.maxIntegrity - s.integrity;
  const h = Math.min(room, amount);
  s.integrity += h;
  const ov = amount - h;
  if (ov > 0) s.shield = Math.min(s.maxShield, s.shield + ov * 0.5);
  return h;
}

function surgeCost(s, slot, base) {
  const st = s.surge[slot] ?? { stacks: 0, last: -1e9 };
  const stacks = (s.t - st.last <= SURGE_WINDOW) ? Math.min(SURGE_MAX, st.stacks + 1) : 0;
  return { cost: base * (1 + SURGE_STEP * stacks) * s.costMult, stacks };
}
function surgeCommit(s, slot, stacks) { s.surge[slot] = { stacks, last: s.t }; }

/**
 * One tick of a pilot's own systems. input: {lmb, rmb, space, ab, thrust, still, spaceSpam, util}
 * env: {dist, target(optional ship), onDamage(amount, opts, src), acc, reserveFrac (bot skill reserve), disciplined}
 * Returns damage packets emitted: [{amount, kind, bleed, breakLock, src, aoe}]
 */
export function stepPilot(s, input, env) {
  const c = s.cls, out = [];
  s.t += DT;
  // strain from held inputs
  const moveStrain = (input.lmb ? 1 : 0) + (input.rmb ? 1 : 0) + (input.space ? 1 : 0) + (input.ab ? 1 : 0);
  const shieldStrain = Math.min(4, moveStrain + (s.polarized ? 1 : 0));
  s.moveStrain = moveStrain;
  if (input.lmb || input.rmb) s.lastHeldT = s.t;
  const calm = (s.t - s.lastHeldT) >= SHIELD_CALM_SEC;
  // brownout gates
  const bo = s.brownout;
  // power regen
  const abOn = input.ab && !bo && s.power > c.abCost * DT;
  if (!abOn && !(s.empUntil > s.t)) s.power += s.powerRegen * (env.regenMult ?? 1) * DT;
  // thrust draw
  if (input.thrust) {
    if (abOn) s.power -= c.abCost * s.costMult * DT; else s.power -= c.thrustPower * s.costMult * DT;
  }
  // ---- weapon ----
  const w = WEAPONS[s.weapon];
  let fired = false;
  const wantFire = input.lmb && !s.jammed && !(input.channel);
  let fireOk = wantFire;
  if (env.disciplined && wantFire) {
    // bot heat discipline: release at >=80, resume <=40
    if (s.heat >= 80) s.holdOff = true;
    if (s.holdOff && s.heat <= 40) s.holdOff = false;
    if (s.holdOff) fireOk = false;
  }
  if (fireOk) {
    const heatMultCost = 1 + 2 * Math.max(0, s.heat - 50) / 50;
    const strainHeat = STRAIN_HEAT[moveStrain] * s.heatMult;
    let shots = 0;
    if (w.beam) { shots = DT; } // continuous: "shots" = seconds of beam this tick
    else {
      s.fireAcc += DT;
      if (s.fireAcc >= w.interval) { shots = Math.floor(s.fireAcc / w.interval); s.fireAcc -= shots * w.interval; }
    }
    if (shots > 0) {
      const baseCost = (w.beam ? w.costPerSec * shots : w.cost * shots) * s.weaponCostMult * s.costMult;
      const cost = baseCost * heatMultCost;
      const overheat = s.heat >= 100;
      let paid = false;
      if (overheat || bo) {
        // tap shield 1:1
        if (s.shield >= cost) { s.shield -= cost; s.stats.tapShield += cost; paid = true; }
        else {
          s.stats.tapShield += s.shield; s.shield = 0;
          if (overheat) { s.jammed = true; s.stats.jams++; if (s.stats.firstJam < 0) s.stats.firstJam = s.t; }
          paid = false;
        }
      } else {
        if (s.power >= cost) { s.power -= cost; paid = true; }
        else if (s.power > 0) { s.power = 0; paid = true; }
      }
      if (paid) {
        fired = true; s.lastFireT = s.t;
        s.heat = Math.min(100, s.heat + (w.beam ? w.heatPerSec * shots : w.heat * shots) * strainHeat);
        if (s.heat >= 100 && s.stats.firstOverheat < 0) s.stats.firstOverheat = s.t;
        const d = env.dist ?? 150;
        const f = falloff(w, d);
        if (f > 0) {
          let dmg = w.beam ? w.dps * shots : w.dmg * shots;
          dmg *= f * dealtMult(c, w.kind) * (env.dmgMult ?? 1);
          if (w.beam && input.still) dmg *= w.focusMult;
          out.push({ amount: dmg, kind: w.kind, bleed: w.id === 'massdriver' ? mdBleed(d) : 0, breakLock: w.breakLock ?? 0, src: 'weapon', aoe: 1, pierce: w.id === 'phaser' ? 1 : 0 });
        }
      }
    }
  } else if (!input.lmb) { s.fireAcc = Math.min(s.fireAcc, w.beam ? 0 : w.interval); }
  // vent
  if (s.t - s.lastFireT >= HEAT_VENT_DELAY) {
    s.heat = Math.max(0, s.heat - w.vent * s.ventMult * DT);
  }
  if (s.jammed) { s.stats.jamTime += DT; if (s.heat <= HEAT_JAM_CLEAR) s.jammed = false; }
  // ---- secondary ----
  const reserve = (env.reserveFrac ?? 0) * s.maxPower;
  if (input.rmb && !bo) {
    s.secReady = s.secReady ?? 0;
    if (s.t >= s.secReady) {
      const { cost, stacks } = surgeCost(s, 'sec', c.sec.cost);
      if (s.power >= cost + reserve) {
        s.power -= cost; surgeCommit(s, 'sec', stacks); s.secReady = s.t + c.sec.cd;
        const d = env.dist ?? 150;
        if (c.id === 'brute') out.push({ amount: c.sec.dmg * c.sec.count * dealtMult(c, 'kinetic') * (env.dmgMult ?? 1), kind: 'kinetic', src: 'rockets', aoe: c.sec.aoe, delay: d / c.sec.speed });
        else if (c.id === 'tech') { if (d <= c.sec.range) out.push({ amount: c.sec.dmg * dealtMult(c, 'energy') * (env.dmgMult ?? 1), kind: 'energy', src: 'arc', aoe: 1, hops: c.sec.hops }); }
        else { s.sentries = (s.sentries ?? []).filter((x) => x.until > s.t); if (s.sentries.length >= c.sec.max) s.sentries.shift(); s.sentries.push({ until: s.t + c.sec.life, next: s.t + 0.5 }); }
      }
    }
  }
  // sentries fire
  if (s.sentries) for (const se of s.sentries) {
    if (se.until > s.t && s.t >= se.next) { se.next += c.sec.fireCd; if ((env.dist ?? 150) <= c.sec.range + 200) out.push({ amount: c.sec.dmg * (env.dmgMult ?? 1), kind: 'kinetic', src: 'sentry', aoe: 1 }); }
  }
  // ---- mobility ----
  const spaceEdge = input.space && !s.prevSpace;
  if (c.id !== 'engineer' && input.space && !bo) {
    s.mobReady = s.mobReady ?? 0;
    if ((spaceEdge || input.spaceSpam) && s.t >= s.mobReady) {
      const { cost, stacks } = surgeCost(s, 'mob', c.mob.cost);
      if (s.power >= cost + reserve) {
        s.power -= cost; surgeCommit(s, 'mob', stacks); s.mobReady = s.t + c.mob.cd;
        if (c.id === 'brute' && (env.dist ?? 150) <= (c.mob.dash + 40)) out.push({ amount: c.mob.dmg * dealtMult(c, 'kinetic') * (env.dmgMult ?? 1), kind: 'kinetic', bleed: c.mob.bleed, src: 'ram', aoe: 1 });
        if (c.id === 'brute') { s.charging = true; s.chargeEnd = s.t + 0.35; }
      }
    }
  }
  if (s.charging && s.t >= s.chargeEnd) s.charging = false;
  s.prevSpace = input.space;
  // ---- engineer channel (Repair / Siphon) ----
  if (c.id === 'engineer' && input.space && !bo && !input.noChannel) {
    if (s.channelSince < 0) s.channelSince = s.t;
    const ch = Math.min(CH_ESC_MAX, s.t - s.channelSince);
    const variant = input.variant ?? 'standard';
    const base = variant === 'siphon' ? c.siphon.costPerSec : c.mob.costPerSec * (input.medic ? 0.75 : 1);
    const cost = base * (1 + CH_ESC * ch) * s.costMult * DT;
    if (s.power >= cost) { s.power -= cost; s.channeling = true; } else { s.power = 0; s.channeling = false; }
  } else { s.channelSince = -1; s.channeling = false; }
  // ---- Polarize (toggle channel) ----
  if (input.polarize && !s.polarized && !bo && s.t >= s.polarLockUntil && s.shield > 0 && s.power >= c.util.need) {
    s.polarized = true; s.power -= c.util.engage * s.costMult; s.absorb = Math.max(s.absorb, c.util.absorb);
  }
  if (!input.polarize && s.polarized) { s.polarized = false; s.absorb = s.fortressAbsorb ?? 0; }
  if (s.polarized) {
    s.power -= c.util.drain * s.costMult * DT;
    if (bo || s.shield <= 0) { s.polarized = false; s.absorb = s.fortressAbsorb ?? 0; s.polarLockUntil = s.t + 3; }
  }
  // ---- shield regen ----
  if (s.t >= s.regenAt && !bo && !(s.empUntil > s.t) && !(s.inStorm) && s.shield < s.maxShield) {
    const rate = s.shieldRegen * (calm ? SHIELD_CALM_MULT : 1) * STRAIN_SHIELD[shieldStrain] * (env.shieldRegenMult ?? 1);
    let gain = Math.min(s.maxShield - s.shield, rate * DT);
    const pc = (env.freeShield ? 0 : s.cls.shieldPowerCost);
    if (pc > 0 && s.power < gain * pc) gain = Math.max(0, s.power / pc);
    s.shield += gain; s.power -= gain * pc; s.stats.shieldRegenGained += gain;
  }
  if (s.shieldDown && s.shield >= SHIELD_DOWN_CLEAR * s.maxShield) s.shieldDown = false;
  // ---- hull passive regen ----
  if (s.t - s.lastDamageT >= DC_DELAY && !input.lmb && !input.rmb && s.integrity < DC_CAP * s.maxIntegrity)
    s.integrity = Math.min(DC_CAP * s.maxIntegrity, s.integrity + DC_RATE * s.maxIntegrity * DT);
  if (c.armorType === 'nano' && s.t - s.lastDamageT >= NANO_DELAY && s.integrity < s.maxIntegrity)
    s.integrity = Math.min(s.maxIntegrity, s.integrity + NANO_RATE * s.maxIntegrity * DT);
  // ---- power clamp + brownout ----
  s.power = Math.min(s.maxPower, s.power);
  if (s.power <= 0) {
    s.power = 0;
    if (!s.brownout) { s.brownout = true; s.stats.brownouts++; s.boStart = s.t; if (s.stats.firstBrownout < 0) s.stats.firstBrownout = s.t; }
  }
  if (s.brownout) {
    s.stats.brownoutTime += DT;
    if (s.power >= BROWNOUT_RECOVER * s.maxPower) { s.brownout = false; s.stats.recov.push(s.t - s.boStart); }
  }
  s.stats.dmgOut += out.reduce((a, p) => a + p.amount, 0);
  s.speedMult = STRAIN_MOVE[moveStrain] * (s.brownout ? BROWNOUT_MOVE : 1);
  return out;
}

export function pad(x, n) { x = String(x); return x.length >= n ? x : ' '.repeat(n - x.length) + x; }
export function padr(x, n) { x = String(x); return x.length >= n ? x : x + ' '.repeat(n - x.length); }
export function f1(x) { return Number.isFinite(x) ? x.toFixed(1) : (x === Infinity ? 'inf' : '-'); }
export function f2(x) { return Number.isFinite(x) ? x.toFixed(2) : (x === Infinity ? 'inf' : '-'); }
export function f0(x) { return Number.isFinite(x) ? Math.round(x).toString() : (x === Infinity ? 'inf' : '-'); }
