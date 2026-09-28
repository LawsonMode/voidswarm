// S7. Power budget when chaining LMB + RMB + E + Space (+ perk), per kit and class: time to first brownout, brownout duty,
// recovery. CR reactor (load L, surcharge, strain-throttled regen, boost halts regen, brownout at 0 -> recover at 25%),
// CR heat (hot cost multipliers), judge fixes. Default weapons: Jugg Mass Driver, Arca Laser, Arti Phaser.
import fs from 'node:fs';
import { CLASSES, CLS, SHORT, DT, TICK, LOAD_SURCHARGE, STRAIN_REGEN, SHIELD_LOAD, SHIELD_POWER_COST, BROWNOUT_RECOVER, weaponStats, DEFAULT_WPN, table, H, f0, f1, f2, pct, flag, FLAGS } from './lib.mjs';
import { KIT_IDS, KIT_NAME, CLASS_OVERRIDE, STOP, BOOST, PERKS, SIG_PERK, SPECIALS, ALTFIRE } from './kits.mjs';
const lines = []; const log = (s = '') => lines.push(s);
const cOf = (kit, cls) => ({ ...CLASSES[cls], ...(CLASS_OVERRIDE[kit][cls] || {}) });

/**
 * combo: {lmb, rmb, e: 'tap'|'hold'|null, space: 'boost'|'brake'|null, perk, feather, underFire (dps on shield), eSpec (override special index), ult: 'eh60'}
 * Returns stats over `sec` seconds.
 */
function reactor(kit, cls, combo, sec = 30) {
  const c = cOf(kit, cls), ws = weaponStats(cls, combo.weapon ?? DEFAULT_WPN[cls]);
  const alt = ALTFIRE[kit][cls], sp = SPECIALS[kit][cls][combo.eIdx ?? 0], pk = PERKS[kit][combo.perkId ?? SIG_PERK[kit][cls]];
  let P = c.P, S = c.S, heat = 0, gunReady = 0, altReady = 0, eReady = 0, perkReady = 0, perkUntil = -1, eUntil = -1, eSus = false, brown = false, shieldReady = 0, vent = -1;
  let firstBrown = -1, brownT = 0, nBrown = 0, recoveries = [], brownAt = 0, net2 = null; const P0 = P;
  let odUntil = -1, lastTrig = -1e9, feathering = false, clampLoss = 0;
  for (let k = 0; k < sec * TICK; k++) {
    const t = k * DT;
    // held inputs (feather: bot band 95/70 on heat)
    if (combo.feather) { if (!feathering && heat >= 95) feathering = true; else if (feathering && heat <= 70) feathering = false; }
    const lmb = combo.lmb && !feathering;
    const rmbHold = !!(combo.rmb && alt.hold), eHold = combo.e === 'hold' && (sp.hold || sp.sustain);
    const space = !!combo.space;
    let L = (lmb ? 1 : 0) + (combo.rmb ? 1 : 0) + (space ? 1 : 0) + ((eHold && (sp.holdLoad || (sp.sustain && eSus))) ? 1 : 0) + (combo.ult === 'eh60' ? 1 : 0);
    L = Math.min(3, L);
    const sur = LOAD_SURCHARGE[L];
    let cut = false;
    const od = t < odUntil;
    // thrust (always thrusting unless braking)
    if (combo.space !== 'brake') { const cost = c.thr * DT; if (P >= cost) P -= cost; else cut = true; }
    // boost
    let boosting = false;
    if (combo.space === 'boost' && !brown) {
      const cost = od ? 0 : BOOST[cls] * sur * DT;
      if (P > cost) { P -= cost; boosting = true; }
    }
    // brake draw: Hero/Arcade only while moving (a stop-and-pop pilot is decelerating ~50% of the held time); Sortie: whenever held
    if (combo.space === 'brake' && !brown) { P -= STOP[kit][cls].draw * sur * DT * (kit === 'sortie' ? 1 : 0.5); if (P < 0) { P = 0; cut = true; } }
    // regen (strain-throttled; boost halts it unless Overdrive)
    if (!boosting || od) { const g = c.R * STRAIN_REGEN[L] * DT; const b4 = P; P = Math.min(c.P, P + g); if (k < 2 * TICK) clampLoss += b4 + g - P; }
    // skills first (judge: debit a pressed skill before the weapon)
    if (!brown) {
      // perk on cooldown
      if (combo.perk && t >= perkReady && P >= pk.cost * sur) { P -= pk.cost * sur; perkReady = t + (pk.cd?.[cls] ?? pk.cd); if (pk.type === 'surge' && pk.free) odUntil = t + pk.time; }
      // E
      if (combo.e && t >= eReady) {
        if (sp.kind === 'stance') { if (P >= sp.cost * sur) { P -= sp.cost * sur; eUntil = t + sp.dur; eReady = Infinity; } }
        else if (sp.kind === 'summon' || sp.kind === 'field') { if (!eHold && P >= sp.cost * sur) { P -= sp.cost * sur; eReady = t + sp.cd; } }
      }
      if (sp.kind === 'stance' && eUntil > 0 && t >= eUntil && !eSus) {
        if (combo.e === 'hold' && sp.sustain) eSus = true; else { eReady = t + sp.cd; eUntil = -1; }
      }
      // RMB
      if (combo.rmb && !alt.hold && t >= altReady && P >= alt.cost * sur) { P -= alt.cost * sur; altReady = t + alt.cd; }
    }
    // continuous draws: ray (RMB hold or E hold), Polarize sustain, Siege drain, EH 60/s
    const conts = [];
    if (rmbHold) conts.push(alt.hold);
    if (eHold && sp.hold) conts.push(sp.hold);
    if (eSus) conts.push(sp.sustain);
    if (sp.drainPerSec && eUntil > t) conts.push(sp.drainPerSec);
    if (combo.ult === 'eh60') conts.push(60);
    if (!brown) for (const d of conts) { const need = d * sur * DT; if (P >= need) P -= need; else { P = 0; cut = true; } }
    // weapon
    if (lmb && !brown && t >= vent) {
      lastTrig = t; const Hh = ws.heat;
      if (ws.beam) {
        const d = ws.draw * (heat >= Hh.hot ? Hh.hotMult : 1) * sur * DT;
        if (P >= d) { P -= d; heat = Math.min(100, heat + Hh.sec * ws.heatMult * DT); if (heat >= 100) { S = Math.max(0, S - Hh.overShieldSec * DT); shieldReady = t + c.sb; if (S <= 0) { vent = t + 1.5; heat = 40; } } }
        else { P = 0; cut = true; }
      } else if (t >= gunReady) {
        const cost = ws.cost * (heat >= Hh.hot ? Hh.hotMult : 1) * sur;
        if (P >= cost) { P -= cost; gunReady = t + ws.cd * (heat >= 100 && Hh.overCd ? Hh.overCd : 1); heat = Math.min(100, heat + Hh.shot * ws.heatMult);
          if (heat >= 100 && Hh.overShieldShot) { S = Math.max(0, S - Hh.overShieldShot); shieldReady = t + c.sb; if (S <= 0) { vent = t + 1.5; heat = 40; } } }
      }
    }
    if (t - lastTrig > ws.heat.delay) heat = Math.max(0, heat - ws.heat.decay * DT);
    // incoming fire (shield) + shield regen (Polarize regenerates under fire)
    const pol = sp.id === 'polarize' && (eUntil > t || eSus);
    if (combo.underFire) { const dmg = combo.underFire * DT * (pol ? 0.5 : 1); S = Math.max(0, S - dmg); if (!pol) shieldReady = t + c.sd; }
    if ((t >= shieldReady || pol) && S < c.S && !brown && !boosting) {
      let want = Math.min(c.S - S, c.Sr * SHIELD_LOAD[L] * DT); let cost = want * SHIELD_POWER_COST; if (P < cost) { want = P / SHIELD_POWER_COST; cost = P; }
      S += want; P -= cost;
    }
    // brownout
    if (!brown && (P < 0.02 * c.P || cut)) { brown = true; P = Math.max(0, P); nBrown++; brownAt = t; if (firstBrown < 0) firstBrown = t; eSus = false; if (eUntil > 0) { eReady = t + sp.cd; eUntil = -1; } }
    else if (brown && P >= BROWNOUT_RECOVER * c.P) { brown = false; recoveries.push(t - brownAt); }
    if (brown) brownT += DT;
    if (k === 2 * TICK - 1) net2 = (P - P0 + clampLoss) / 2;
  }
  return { firstBrown, duty: brownT / sec, nBrown, rec: recoveries.length ? recoveries.reduce((a, b) => a + b, 0) / recoveries.length : NaN, net2 };
}

const COMBOS = [
  ['LMB (held, heat builds)', { lmb: true }],
  ['LMB feathered (bot 95/70)', { lmb: true, feather: true }],
  ['LMB+RMB', { lmb: true, rmb: true }],
  ['LMB+RMB+E tap', { lmb: true, rmb: true, e: 'tap' }],
  ['LMB+RMB+E hold', { lmb: true, rmb: true, e: 'hold' }],
  ['LMB+RMB+E+boost+perk', { lmb: true, rmb: true, e: 'tap', space: 'boost', perk: true }],
  ['LMB+RMB+E hold+boost+perk', { lmb: true, rmb: true, e: 'hold', space: 'boost', perk: true }],
  ['LMB+RMB+E+FULL STOP+perk', { lmb: true, rmb: true, e: 'tap', space: 'brake', perk: true }],
  ['boost only', { space: 'boost' }],
];
log(H('S7. Power budget chains (30 s, shield full unless stated). cells: net power/s over the first 2 s | first brownout | brownout duty | mean recovery'));
log('E hold = Polarize sustain (Jugg), the Ray (Arcade/Sortie Arti E; Hero Arti ray is RMB), Gravity Well/Sentry are taps. Perk = signature perk on cooldown.');
log('Brownout trips deterministically when stored power < 2% after all draws or a continuous draw is refused (judge fix); recovers at 25%.');
log('LMB is blocked in brownout (CR reactor), although Hero/Arcade list only RMB/E/perk/R/boost as brownout-locked (spec wording gap).');
const summary = {};
for (const kit of KIT_IDS) {
  log(`\n--- ${KIT_NAME[kit]} ---`);
  const rows = [];
  for (const [lab, cb] of COMBOS) {
    const row = [lab];
    for (const cls of CLS) {
      const r = reactor(kit, cls, cb);
      row.push(`${f0(r.net2)}/s | ${r.firstBrown < 0 ? 'never' : f1(r.firstBrown) + ' s'} | ${pct(r.duty)} | ${Number.isFinite(r.rec) ? f1(r.rec) + ' s' : '-'}`);
      ((summary[kit] ??= {})[cls] ??= {})[lab] = r;
    }
    rows.push(row);
  }
  log(table(['combo', `Jugg ${weaponStats('brute', 'massdriver').short}`, `Arca ${weaponStats('tech', 'laser').short}`, `Arti ${weaponStats('engineer', 'phaser').short}`], rows));
}
// special rows
log('\n--- Special cases ---');
const sp = [];
let sorRay;
const add = (kit, cls, lab, cb) => { const r = reactor(kit, cls, cb); sp.push([KIT_NAME[kit], SHORT[cls], lab, `${f0(r.net2)}/s`, r.firstBrown < 0 ? 'never' : f1(r.firstBrown) + ' s', pct(r.duty)]); return r; };
const heroRay = add('hero', 'engineer', 'Phaser + Repair Ray (RMB hold), L2', { lmb: true, rmb: true });
const heroRayF = add('hero', 'engineer', 'Phaser feathered + Repair Ray', { lmb: true, rmb: true, feather: true });
add('arcade', 'engineer', 'Phaser + Ray (E hold) + Sentry spam (RMB)', { lmb: true, rmb: true, e: 'hold' });
const arcRay = add('arcade', 'engineer', 'Phaser + Ray (E hold), no RMB', { lmb: true, e: 'hold' });
sorRay = add('sortie', 'engineer', 'Phaser + Repair Ray (E1 hold), no RMB', { lmb: true, e: 'hold' });
add('hero', 'brute', 'MD + Polarize sustain, under 300 dps fire', { lmb: true, e: 'hold', underFire: 300 });
add('arcade', 'brute', 'MD + Polarize sustain, under 300 dps fire', { lmb: true, e: 'hold', underFire: 300 });
const ehPol = add('sortie', 'brute', 'MD + Polarize sustain + Event Horizon (60/s, +1 load)', { lmb: true, e: 'hold', ult: 'eh60' });
add('sortie', 'brute', 'MD + RMB + Siege Mode (E2, 50/s, no load)', { lmb: true, rmb: true, e: 'tap', eIdx: 1 });
add('arcade', 'engineer', 'boost + Overdrive (free boost 3 s / 14 s)', { space: 'boost', perk: true });
add('hero', 'tech', 'boost + Overdrive perk (free 3 s / 16 s)', { space: 'boost', perk: true, perkId: 'overdrive' });
add('sortie', 'tech', 'boost + Overdrive perk (free 3 s / 14 s)', { space: 'boost', perk: true, perkId: 'overdrive' });
log(table(['kit', 'class', 'case', 'net/s (2 s)', 'first brownout', 'duty (30 s)'], sp));

// ---- flags
for (const kit of KIT_IDS) for (const cls of CLS) {
  const full = summary[kit][cls]['LMB+RMB+E+boost+perk'];
  if (full.firstBrown < 0) flag(kit, 'HIGH', `Never-brownout loop (${SHORT[cls]} everything held)`, `LMB+RMB+E+boost+perk never browns out in 30 s.`);
  const l2 = summary[kit][cls]['LMB+RMB'];
  if (l2.firstBrown < 0 && cls === 'engineer') flag(kit, 'MED', `Artificer LMB+RMB never browns out`, `${KIT_NAME[kit]} Artificer (420/s reactor) holds Phaser + ${ALTFIRE[kit].engineer.name} indefinitely (net ${f0(l2.net2)}/s over the first 2 s).`);
}
if (heroRay.firstBrown < 0 || heroRay.duty < 0.02) flag('hero', 'MED', 'Artificer heals forever while shooting', `Hero puts the Repair Ray on RMB: Phaser + Ray is L2 and ${heroRay.firstBrown < 0 ? 'never browns out' : 'browns out only ' + pct(heroRay.duty) + ' of the time'} (the judge's "builds that never brown out go away" fix is undone for the healer). Move the Ray to an E stance (+1 load, as Arcade/Sortie) or charge it 170/s.`);
if (arcRay.firstBrown < 0) flag('arcade', 'MED', 'Artificer Phaser + Ray sustainable', `Phaser + E-hold Ray (L2, 170/s) never browns out in 30 s (net ${f0(arcRay.net2)}/s): the 420/s reactor still funds endless heal-while-shooting.`);
if (sorRay.firstBrown < 0) flag('sortie', 'MED', 'Artificer Phaser + Ray sustainable', `Phaser + E1-hold Ray (L2, 170/s) never browns out in 30 s (net ${f0(sorRay.net2)}/s).`);
if (ehPol.firstBrown >= 0 && ehPol.firstBrown < 5) flag('sortie', 'MED', 'Polarize + Event Horizon (the "intended combo") browns out mid-ult', `MD + Polarize sustain + EH 60/s is L3 (x1.6, regen x0.6): first brownout at ${f1(ehPol.firstBrown)} s and brownout ENDS Event Horizon. The advertised combo lasts ~${f1(ehPol.firstBrown)} s of a 5 s ult; drop EH's power draw (the other kits make ults free) or exclude it from load.`);
fs.writeFileSync(new URL('./s7_power.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s7_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
