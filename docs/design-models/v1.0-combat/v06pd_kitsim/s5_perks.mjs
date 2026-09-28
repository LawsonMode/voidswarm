// S5. Maneuver-perk value: escape and engage windows vs weapon TTK. 1-D chase on CR movement + reactor (boost halts regen,
// L2 strain x0.9 speed / x1.25 cost for a pursuer that boosts while firing), CR damage pipeline, 100% hit rate.
import fs from 'node:fs';
import { CLASSES, CLS, SHORT, DT, TICK, LOAD_SURCHARGE, STRAIN_SPEED, STRAIN_REGEN, SHIELD_LOAD, SHIELD_POWER_COST, BOOST_THRUST, IMPULSE_BLEED,
  weaponStats, DEFAULT_WPN, rawDps, makeTarget, hit, left, ttk, table, H, f0, f1, f2, pct, flag, FLAGS } from './lib.mjs';
import { KIT_IDS, KIT_NAME, CLASS_OVERRIDE, PERKS, SORTIE_REACH, BOOST } from './kits.mjs';
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

log(H('S5. Maneuver perks: escape value in an 8 s chase (target flees with boost from 300 px; pursuer boosts when > 70% of its range and fires in range)'));
log('cells: share of the target\'s EHP taken (DOWN@t if taken down) | seconds inside the pursuer\'s weapon range. Baseline "boost only" = no perk.');
log('Weapon ranges: Jugg MD ' + f0(weaponStats('brute', 'massdriver').range) + ' px, Arca Laser ' + f0(weaponStats('tech', 'laser').range) + ' px, Arti Phaser ' + f0(weaponStats('engineer', 'phaser').range) + ' px. The pursuer is always L2 while chasing and firing (x0.9 speed).');
const results = {};
for (const kit of KIT_IDS) {
  log(`\n--- ${KIT_NAME[kit]} ---`);
  const rows = [];
  for (const pb of CLS) {
    const perks = [null, ...Object.keys(PERKS[kit]).filter((id) => { const p = PERKS[kit][id]; return p.cls === null || p.cls === pb || kit !== 'hero'; })];
    for (const pid of perks) {
      const pk = pid ? PERKS[kit][pid] : null;
      if (pk && (pk.type === 'none' || pk.type === 'flip')) continue;
      if (pk && kit === 'hero' && pk.cls && pk.cls !== pb) continue; // Hero signatures are class-locked
      const row = [SHORT[pb], pk ? pk.name : 'boost only (baseline)', pk ? `${val(pk.cd, pb)} s${pk.charges ? ' x' + pk.charges : ''} / ${pk.cost}` : '-'];
      for (const pa of CLS) {
        const r = chase(kit, pa, pb, pid);
        row.push(`${r.dead ? 'DOWN@' + f1(r.deadAt) : pct(r.frac)} | ${f1(r.inRange)} s`);
        ((results[kit] ??= {})[pb] ??= {})[pid ?? 'none'] = { ...(results[kit][pb][pid ?? 'none'] || {}), [pa]: r };
      }
      rows.push(row);
    }
  }
  log(table(['target', 'perk', 'cd / power', 'vs Jugg MD', 'vs Arca Laser', 'vs Arti Phaser'], rows));
}

// ---- TTK reference and perk cooldown vs TTK
log('\nReference TTK (held weapon, 100% hits, target not regenerating) at 150 / 300 / 600 px, and how many perk uses fit inside it:');
const tt = [];
for (const kit of KIT_IDS) for (const pa of CLS) {
  const wid = DEFAULT_WPN[pa];
  const row = [KIT_NAME[kit], `${SHORT[pa]} ${weaponStats(pa, wid).short}`];
  for (const pb of CLS) { const c = cOf(kit, pb); row.push([150, 300, 600].map((d) => f2(ttk(pa, wid, pb, d, { tgtClass: c }))).join(' / ')); }
  tt.push(row);
}
log(table(['kit', 'attacker', 'vs Jugg (s)', 'vs Arca (s)', 'vs Arti (s)'], tt));

// ---- engage: attacker closes on a target cruising away from 800 px
log('\nEngage: attacker boosts (+ perk on cooldown once within 1.6x its range) after a target cruising away from 800 px; seconds to first in-range | damage dealt in 6 s (share of target EHP):');
function engage(kit, pa, pb, perkId) {
  const ca = cOf(kit, pa), cb = cOf(kit, pb), ws = weaponStats(pa, DEFAULT_WPN[pa]), pk = perkId ? PERKS[kit][perkId] : null;
  const A = { x: 0, v: ca.max, P: ca.P, t: 0 }, B = { x: 800, v: cb.max, t: 0 }; const tg = makeTarget(cb);
  let first = -1, used = false, dashUntil = -1, dashV = 0, gun = 0, surgeUntil = -1;
  const reach = kit === 'sortie' && pk?.reach ? SORTIE_REACH[pa] : 1;
  for (let k = 0; k < 6 * TICK; k++) {
    const t = k * DT; const d = B.x - A.x;
    if (pk && !used && d <= 1.6 * ws.range && A.P >= pk.cost) {
      used = true; A.P -= pk.cost;
      if (pk.type === 'blink') A.x += Math.min(d - 60, val(pk.range, pa) * reach);
      else if (pk.type === 'dash') { dashUntil = t + pk.time; dashV = pk.speed * reach; }
      else if (pk.type === 'impulse') { dashUntil = t + pk.time; dashV = A.v + val(pk.dv, pa); }
      else if (pk.type === 'surge') surgeUntil = t + pk.time;
      else if (pk.type === 'jump') { dashUntil = t + pk.spool; dashV = 0; A.jumpAt = t + pk.spool; A.jumpR = Math.min(pk.range * reach, d - 60); }
    }
    if (A.jumpAt && t >= A.jumpAt) { A.x += A.jumpR; A.jumpAt = 0; }
    const od = t < surgeUntil && pk?.free;
    const boost = od || A.P > BOOST[pa] * DT; if (boost && !od) A.P -= BOOST[pa] * DT;
    if (t < dashUntil) { A.v = dashV; A.x += A.v * DT; } else step1(A, ca, true, boost, 1, t < surgeUntil ? (pk.speedMult ?? 1) : 1);
    step1(B, cb, true, false, 1);
    const dd = B.x - A.x;
    if (dd <= ws.range) { if (first < 0) first = t; if (ws.beam) hit(tg, rawDps(ws, dd) * DT, ws.type, 0, t); else if (t >= gun) { gun = t + ws.cd; hit(tg, rawDps(ws, dd) * ws.cd, ws.type, 0, t); } }
  }
  return { first, frac: (tg.dealtS + tg.dealtI) / (cb.S + cb.I), dead: tg.dead };
}
const en = [];
for (const kit of KIT_IDS) for (const pa of CLS) {
  const perks = [null, ...Object.keys(PERKS[kit]).filter((id) => { const p = PERKS[kit][id]; return !['none', 'flip'].includes(p.type) && (kit !== 'hero' || !p.cls || p.cls === pa); })];
  for (const pid of perks) {
    const row = [KIT_NAME[kit], `${SHORT[pa]} ${weaponStats(pa, DEFAULT_WPN[pa]).short}`, pid ? PERKS[kit][pid].name : 'boost only'];
    for (const pb of CLS) { const r = engage(kit, pa, pb, pid); row.push(`${r.first < 0 ? 'never' : f2(r.first) + ' s'} | ${r.dead ? 'DOWN' : pct(r.frac)}`); }
    en.push(row);
  }
}
log(table(['kit', 'attacker', 'perk', 'vs Jugg', 'vs Arca', 'vs Arti'], en));

// ---- perk budget: displacement and i-frames per cooldown second
log('\nPerk budget per cooldown second (1st-second displacement over plain boost, i-frame seconds, damage-taken reduction):');
const bud = [];
for (const kit of KIT_IDS) for (const [pid, pk] of Object.entries(PERKS[kit])) {
  if (['none', 'flip'].includes(pk.type)) continue;
  for (const cls of CLS) {
    if (kit === 'hero' && pk.cls && pk.cls !== cls) continue;
    const reach = kit === 'sortie' && pk.reach ? SORTIE_REACH[cls] : 1, cd = val(pk.cd, cls), c = cOf(kit, cls);
    let disp = 0;
    if (pk.type === 'blink') disp = val(pk.range, cls) * reach;
    else if (pk.type === 'dash') disp = pk.speed * reach * pk.time - c.max * pk.time;
    else if (pk.type === 'impulse') disp = val(pk.dv, cls) * pk.time + (kit === 'hero' ? (val(pk.dv, cls) ** 2) / (2 * IMPULSE_BLEED) : 0);
    else if (pk.type === 'surge') disp = (pk.speedMult - 1) * c.abMax * Math.min(1, pk.time) + (pk.free ? 0 : 0);
    else if (pk.type === 'jump') disp = pk.range * reach - c.abMax * pk.spool * (1 - (pk.spoolSpeed ?? 0));
    const iframes = (pk.invuln ?? 0) * (pk.charges ?? 1);
    const eff = cd; // charges recharge one at a time: sustained rate = 1 per cooldown
    bud.push([KIT_NAME[kit], pk.name, SHORT[cls], `${cd} s${pk.charges ? ' x' + pk.charges : ''}`, f0(disp) + ' px', f0(disp / eff) + ' px/s', f2(iframes) + ' s', pct(iframes / eff), pk.taken ? `x${pk.taken} for ${pk.time} s` : '-']);
  }
}
log(table(['kit', 'perk', 'class', 'cooldown', 'displacement', 'per cd-second', 'i-frames/use', 'i-frame uptime', 'damage taken'], bud));

// ---- escape ranking: mean share of EHP taken over the three pursuers (a take-down counts as 100%)
log('\nEscape ranking (mean EHP share taken in the 8 s chase over the three pursuers; lower = better escape; DOWN = 100%):');
const rk = [];
const score = (r) => CLS.reduce((a, pa) => a + (r[pa].dead ? 1 : Math.min(1, r[pa].frac)), 0) / 3;
for (const kit of KIT_IDS) for (const pb of CLS) {
  const e = Object.entries(results[kit][pb]).map(([pid, r]) => [pid, score(r)]).sort((a, b) => a[1] - b[1]);
  const base = results[kit][pb].none;
  rk.push([KIT_NAME[kit], SHORT[pb], e.map(([pid, v]) => `${pid === 'none' ? 'baseline' : PERKS[kit][pid].name} ${pct(v)}`).join(' < ')]);
  // dominance: a universal perk that beats the class signature perk by >= 15 points on every pursuer
  const sig = { hero: { brute: 'ram', tech: 'blink', engineer: 'repair' }, arcade: { brute: 'ram', tech: 'blink', engineer: 'overdrive' }, sortie: { brute: 'ram', tech: 'blink', engineer: 'grapple' } }[kit][pb];
  const sr = results[kit][pb][sig];
  for (const [pid, r] of Object.entries(results[kit][pb])) {
    if (pid === 'none' || pid === sig || !sr) continue;
    const better = score(r) + 0.15 <= score(sr) && CLS.every((pa) => (r[pa].dead ? 1 : Math.min(1, r[pa].frac)) <= (sr[pa].dead ? 1 : Math.min(1, sr[pa].frac)) + 0.02);
    if (better) flag(kit, 'MED', `${PERKS[kit][pid].name} dominates ${SHORT[pb]}'s signature ${PERKS[kit][sig].name} as an escape`, `mean EHP taken in the 8 s chase ${pct(score(r))} vs ${pct(score(sr))} and no worse against any pursuer: the "sidegrade" is a strict escape upgrade on this hull (the signature keeps only its damage/heal).`);
  }
  // Warp vs short weapons: total escape
  const w = results[kit][pb].blink;
  if (w && w.brute.frac === 0 && w.engineer.frac === 0 && pb === 'tech') flag(kit, 'LOW', 'Warp is a total escape from MD/Phaser pursuers', `the Arcanist takes 0% from a chasing Jugg MD or Arti Phaser after one Warp (cd ${val(PERKS[kit].blink.cd, 'tech')} s < every MD/Phaser TTK); only Lasers (1265 px) punish it. Intended class identity, but combine with the shield-delay trim and the loop is: Warp, stop boosting, full shield in ~${f1(0.6 + 380 / 240)} s.`);
}
log(table(['kit', 'target', 'perks ranked (mean EHP taken)'], rk));
{
  // Jugg MD pursuer: can it ever catch a fleeing Arcanist? (strain x0.9 while firing)
  const r = results.hero.tech.none.brute;
  log(`\nNote: a pursuer that fires while boosting is L2 (x0.9 speed). Jugg MD vs fleeing Arcanist, no perk: ${pct(r.frac)} EHP in 8 s, ${f1(r.inRange)} s in range.`);
}
// Perk cooldown shorter than TTK -> multiple escapes per fight
for (const kit of KIT_IDS) for (const [pid, pk] of Object.entries(PERKS[kit])) {
  if (!pk.invuln || ['none', 'flip'].includes(pk.type)) continue;
  for (const cls of CLS) {
    if (kit === 'hero' && pk.cls && pk.cls !== cls) continue;
    const cd = val(pk.cd, cls);
    const ttkLaser = ttk('tech', 'laser', cls, 600, { tgtClass: cOf(kit, cls) });
    if (cd < ttkLaser * 0.8 && pk.invuln >= 0.18) flag(kit, 'LOW', `${pk.name} cycles inside a Laser TTK (${SHORT[cls]})`, `effective cd ${f1(cd)} s vs Laser TTK ${f1(ttkLaser)} s at 600 px: ${f1(ttkLaser / cd)} i-frame uses per duel.`);
  }
}
fs.writeFileSync(new URL('./s5_perks.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s5_results.json', import.meta.url), JSON.stringify(results));
fs.writeFileSync(new URL('./s5_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
