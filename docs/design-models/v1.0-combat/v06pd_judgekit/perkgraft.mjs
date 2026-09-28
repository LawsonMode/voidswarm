// S5. Maneuver-perk value: escape and engage windows vs weapon TTK. 1-D chase on CR movement + reactor (boost halts regen,
// L2 strain x0.9 speed / x1.25 cost for a pursuer that boosts while firing), CR damage pipeline, 100% hit rate.
import fs from 'node:fs';
import { CLASSES, CLS, SHORT, DT, TICK, LOAD_SURCHARGE, STRAIN_SPEED, STRAIN_REGEN, SHIELD_LOAD, SHIELD_POWER_COST, BOOST_THRUST, IMPULSE_BLEED,
  weaponStats, DEFAULT_WPN, rawDps, makeTarget, hit, left, ttk, table, H, f0, f1, f2, pct, flag, FLAGS } from '../v06pd_kitsim/lib.mjs';
import { KIT_IDS, KIT_NAME, CLASS_OVERRIDE, PERKS, SORTIE_REACH, BOOST } from '../v06pd_kitsim/kits.mjs';
const lines = []; const log = (s = '') => lines.push(s);
const cOf = (kit, cls) => ({ ...CLASSES[cls], ...(CLASS_OVERRIDE[kit][cls] || {}) });
const val = (x, cls) => (x && typeof x === 'object' ? x[cls] : x);

/** One ship's 1-D kinematics (x, v) with a cap; returns nothing. */
function step1(s, c, thrust, boost, sm, capMult = 1) {
  const cap = (boost ? c.abMax : c.max) * sm * capMult;
  if (thrust) { s.v += c.thrust * sm * (boost ? BOOST_THRUST : 1) * (s.thrustMult ?? 1) * DT; if (s.v > cap) s.v = s.impulseUntil > s.t ? s.v : Math.max(cap, s.v - (s.v > cap + 1 ? IMPULSE_BLEED * DT : 0)); }
  else { s.v = Math.max(0, s.v * (1 - c.drag * DT) - c.brake * DT); }
  s.x += s.v * DT;
}

/**
 * Chase: pursuer (cls pa, default weapon) at x=0 behind a target (cls pb) at x=d0, both at cruise. The target boosts away and
 * uses `perkId` (kit) on cooldown once the pursuer is within weapon range + 60 px. sec = 8.
 */
function chase(kit, pa, pb, perkId, o = {}) {
  const ca = cOf(kit, pa), cb = cOf(kit, pb), ws = weaponStats(pa, DEFAULT_WPN[pa]);
  const pk = perkId ? PERKS[kit][perkId] : null;
  const A = { x: 0, v: ca.max, P: ca.P, t: 0 }, B = { x: o.d0 ?? 300, v: cb.max, P: cb.P, t: 0, impulseUntil: -1 };
  const tg = makeTarget(cb);
  let gun = 0, heat = 0, shieldReady = 0, perkReady = 0, charges = pk?.charges ?? 1, rechargeAt = -1, inv = -1, takenMult = 1, takenUntil = -1;
  let dashUntil = -1, dashV = 0, surgeUntil = -1, surge = null, lockUntil = -1, spoolUntil = -1, spoolPk = null, spoolI0 = 0, spoolS0 = 0;
  let inRange = 0, uses = 0, sec = o.sec ?? 8, firstOut = -1;
  const reach = kit === 'sortie' && pk?.reach ? SORTIE_REACH[pb] : 1;
  for (let k = 0; k < sec * TICK && !tg.dead; k++) {
    const t = k * DT; A.t = B.t = t;
    const d = B.x - A.x;
    // ---- target perk
    if (rechargeAt >= 0 && t >= rechargeAt) { charges++; rechargeAt = charges < (pk.charges ?? 1) ? t + val(pk.cd, pb) : -1; } // charges recharge one at a time
    if (pk && pk.type !== 'none' && pk.type !== 'flip' && t >= perkReady && charges > 0 && d <= ws.range + 60 && spoolUntil < 0 && t >= dashUntil) {
      const cost = pk.cost; if (B.P >= cost) {
        B.P -= cost; uses++; charges--; const cd = val(pk.cd, pb); if (pk.charges) { if (rechargeAt < 0) rechargeAt = t + cd; perkReady = t + 0.3; } else perkReady = t + cd;
        if (pk.type === 'blink') { B.x += val(pk.range, pb) * reach; inv = t + pk.invuln; const trim = val(pk.shieldTrim, pb); if (trim != null) shieldReady = Math.min(shieldReady, t + trim); }
        else if (pk.type === 'dash') { const spd = pk.speed * reach; dashUntil = t + pk.time; dashV = spd; if (pk.taken) { takenMult = pk.taken; takenUntil = dashUntil; } if (pk.invuln) inv = t + pk.invuln; }
        else if (pk.type === 'impulse') { const dv = val(pk.dv, pb); if (kit === 'hero') { B.v += dv; B.impulseUntil = t + pk.time; } else { dashUntil = t + pk.time; dashV = B.v + dv; } if (pk.taken) { takenMult = pk.taken; takenUntil = t + pk.time; } }
        else if (pk.type === 'surge') { surgeUntil = t + pk.time; surge = pk; if (pk.heal) { tg.I = Math.min(tg.maxI, tg.I + pk.heal[0] * tg.maxI); tg.S = Math.min(tg.maxS, tg.S + pk.heal[1] * tg.maxS); } }
        else if (pk.type === 'jump') { spoolUntil = t + pk.spool; spoolPk = pk; spoolI0 = tg.I; spoolS0 = tg.S; }
      }
    }
    // spool resolution / cancel
    if (spoolUntil >= 0) {
      const broke = spoolS0 > 0 && tg.S <= 0;
      const bigHit = (spoolI0 - tg.I) >= 0.15 * tg.maxI;
      const cancel = (kit === 'hero' && (broke || bigHit)) || (kit === 'sortie' && broke);
      if (cancel) { spoolUntil = -1; perkReady = t + val(spoolPk.cd, pb) * 0.5; }
      else if (t >= spoolUntil) { B.x += spoolPk.range * reach; inv = t + spoolPk.invuln; spoolUntil = -1; if (spoolPk.spoolSpeed === 0) B.v = 0; }
    }
    // ---- target movement + power (flees with boost while it has power; Overdrive = free boost; lockout after)
    const od = t < surgeUntil && surge?.free;
    const canBoost = t >= lockUntil && (od || B.P > BOOST[pb] * DT);
    const spooling = spoolUntil >= 0;
    if (canBoost && !od) B.P -= BOOST[pb] * DT;
    if (!canBoost || od) B.P = Math.min(cb.P, B.P + cb.R * DT);
    if (surge && t >= surgeUntil && surge.lockAfter && lockUntil < surgeUntil) lockUntil = surgeUntil + surge.lockAfter;
    B.thrustMult = t < surgeUntil ? (surge.thrustMult ?? 1) : 1;
    const capM = t < surgeUntil ? (surge.speedMult ?? 1) : 1;
    if (t < dashUntil) { B.v = dashV; B.x += B.v * DT; if (t + DT >= dashUntil && kit === 'sortie' && pk?.id !== 'grapple') B.v = Math.min(B.v, cb.max); }
    else if (spooling && spoolPk.spoolSpeed === 0) { B.v = Math.max(0, B.v - 3000 * DT); B.x += B.v * DT; }
    else step1(B, cb, true, canBoost, spooling ? spoolPk.spoolSpeed : 1, capM);
    // ---- pursuer: fires in range, boosts when far and power > 25%
    const fire = d <= ws.range, boostA = d > 0.7 * ws.range && A.P > 0.25 * ca.P;
    const L = (fire ? 1 : 0) + (boostA ? 1 : 0), sur = LOAD_SURCHARGE[L];
    if (boostA) A.P -= BOOST[pa] * sur * DT; else A.P = Math.min(ca.P, A.P + ca.R * STRAIN_REGEN[L] * DT);
    step1(A, ca, true, boostA, STRAIN_SPEED[L]);
    if (fire) {
      inRange += DT;
      const Hh = ws.heat, mult = (t < inv ? 0 : 1) * (t < takenUntil ? takenMult : 1);
      if (ws.beam) { const cst = ws.draw * (heat >= Hh.hot ? Hh.hotMult : 1) * sur * DT; if (A.P >= cst) { A.P -= cst; heat = Math.min(100, heat + Hh.sec * ws.heatMult * DT); if (mult) { hit(tg, rawDps(ws, d) * DT * mult, ws.type, 0, t); shieldReady = t + (tg.S <= 0 ? cb.sb : cb.sd); } } }
      else if (t >= gun) { const cst = ws.cost * (heat >= Hh.hot ? Hh.hotMult : 1) * sur; if (A.P >= cst) { A.P -= cst; gun = t + ws.cd; heat = Math.min(100, heat + Hh.shot * ws.heatMult); if (mult) { hit(tg, rawDps(ws, d) * ws.cd * mult, ws.type, 0, t); shieldReady = t + (tg.S <= 0 ? cb.sb : cb.sd); } } }
    } else { heat = Math.max(0, heat - ws.heat.decay * DT); if (firstOut < 0 && t > 0.5) firstOut = t; }
    // ---- target shield regen (not while boosting)
    if (t >= shieldReady && tg.S < tg.maxS && !(canBoost && !od)) { let w = Math.min(tg.maxS - tg.S, cb.Sr * SHIELD_LOAD[canBoost ? 1 : 0] * DT); const cst = w * SHIELD_POWER_COST; if (B.P >= cst) { tg.S += w; B.P -= cst; } }
  }
  const ehp = cb.S + cb.I;
  return { dead: tg.dead, deadAt: tg.deadAt, frac: (tg.dealtS + tg.dealtI) / ehp, inRange, uses, left: left(tg) };
}

const P = PERKS.arcade, od0 = { ...P.overdrive };
const row = (label) => {
  const cells = [];
  for (const pid of [null, 'overdrive', 'blink', 'ram', 'dodge']) {
    const rs = CLS.map((pa) => chase('arcade', pa, 'engineer', pid));
    const mean = rs.reduce((a, r) => a + (r.dead ? 1 : r.frac), 0) / 3;
    cells.push(`${pid ?? 'none'} ${rs.map((r) => (r.dead ? 'DOWN' : pct(r.frac))).join('/')} (mean ${pct(mean)})`);
  }
  console.log(label.padEnd(38), cells.join(' | '));
};
row('Arcade as specced');
Object.assign(P.overdrive, { speedMult: 1.3 }); row('Overdrive cap x1.3');
Object.assign(P.overdrive, { speedMult: 1.3, thrustMult: 1.8 }); row('Overdrive cap x1.3 thrust x1.8');
Object.assign(P.overdrive, od0, { speedMult: 1.25, thrustMult: 1.8, heal: [0, 0.25] }); row('x1.25/thrust1.8 + 25% shield on start');
Object.assign(P.overdrive, od0, { speedMult: 1.25, thrustMult: 1.8, time: 4, heal: [0, 0.25] }); row('same, 4 s');
Object.assign(P.overdrive, od0);
Object.assign(P.blink.range, { engineer: 360 }); row('Warp on Artificer 360 px (od as specced)');
