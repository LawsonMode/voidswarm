// Weapons vs distance, heat/overheat timelines, load/brownout, never-brownout search, burst vs sustained.
'use strict';
const K = require('./core');
const { TICK, DT, CLASSES, CLS, SHORT, WPN, WSHORT, makeShip, reactorTick, mdFalloff, fmt, pad, padr, TYPE_MULT } = K;

console.log('=== A. Weapon DPS vs distance (raw, before layer mults; accuracy 100%) ===');
const dists = [0, 100, 200, 300, 400, 500, 600, 700, 900, 1100, 1265];
console.log('  ' + padr('class/weapon', 16) + dists.map((d) => pad(d, 6)).join('') + '   range  power/s  dmg/power');
for (const c of CLS) for (const wid of WPN) {
  const s = makeShip(c, { weapon: wid }); const w = s.w;
  const row = dists.map((d) => {
    if (d > w.range + 1e-6) return pad('-', 6);
    if (w.beam) return pad(fmt(w.dps, 0), 6);
    const m = w.falloff ? mdFalloff(d, w.range) : 1;
    return pad(fmt(w.dmg * m / w.cd, 0), 6);
  }).join('');
  const pps = w.beam ? w.draw : w.cost / w.cd;
  const dpp = w.beam ? w.dps / w.draw : w.dmg / w.cost;
  console.log('  ' + padr(`${SHORT[c]} ${WSHORT[wid]}`, 16) + row + `   ${pad(fmt(w.range, 0), 5)}  ${pad(fmt(pps, 0), 6)}  ${fmt(dpp, 2)} (PB ${w.falloff ? fmt(dpp * 1.3, 2) : '-'})`);
}
console.log('  effective vs each defender layer (dps at the weapon\'s best band: MD 100 px, LZ any, PH any):');
for (const c of CLS) for (const wid of WPN) {
  const s = makeShip(c, { weapon: wid }); const w = s.w;
  const raw = w.beam ? w.dps : w.dmg * (w.falloff ? mdFalloff(100, w.range) : 1) / w.cd;
  const [sm, im] = TYPE_MULT[w.dtype];
  const row = CLS.map((d) => `${SHORT[d]} shield ${pad(fmt(raw * sm, 0), 4)}/s integ ${pad(fmt(raw * im * (1 - CLASSES[d].armor), 0), 4)}/s`).join(' | ');
  console.log(`   ${SHORT[c]} ${WSHORT[wid]}: ${row}`);
}

// ---------------- B. Heat timeline: hold the trigger forever (no target, no thrust) ----------------
console.log('\n=== B. Heat: hold LMB forever from cold, full meters, no thrust, no incoming damage (30 s) ===');
console.log('  class wpn | t_hot  t_over | first vent  vents  shield lost by overheat | dmg out 0-5s  5-30s dps | brownouts | power min');
for (const c of CLS) for (const wid of WPN) {
  const s = makeShip(c, { weapon: wid });
  let tHot = -1, tOver = -1, dmg5 = 0, dmgAll = 0, pmin = 1e9, shieldLost = 0, tVent = -1;
  for (let t = 0; t < 30 * TICK; t++) {
    const S0 = s.S;
    reactorTick(s, { lmb: true }, t, { onShot: (d) => { if (t < 5 * TICK) dmg5 += d; dmgAll += d; } });
    if (s.S < S0) shieldLost += S0 - s.S;
    if (tHot < 0 && s.heat >= s.w.heat.hot) tHot = t / TICK;
    if (tOver < 0 && s.heat >= 100) tOver = t / TICK;
    if (tVent < 0 && t < s.ventUntil) tVent = t / TICK;
    pmin = Math.min(pmin, s.P);
  }
  console.log(`  ${SHORT[c]} ${WSHORT[wid]}  | ${pad(fmt(tHot, 2), 5)} ${pad(fmt(tOver, 2), 6)} | ${pad(tVent < 0 ? 'never' : fmt(tVent, 2), 9)} ${pad(s.stats.vents, 5)}  ${pad(fmt(shieldLost, 0), 6)}                  | ${pad(fmt(dmg5 / 5, 0), 5)} ${pad(fmt((dmgAll - dmg5) / 25, 0), 9)}     | ${pad(s.stats.brownouts, 3)}       | ${fmt(pmin, 0)}`);
}
// Overheat-to-shield-drain time: the MD/Laser row above assumes power allows firing. Pure drain rates:
console.log('  overheat shield drain while firing at 100 heat: MD 8/slug ×rate; Laser 70/s.');
for (const c of CLS) {
  const md = makeShip(c, { weapon: 'massdriver' }).w, lz = makeShip(c, { weapon: 'laser' }).w;
  console.log(`   ${SHORT[c]}: MD ${fmt(8 / md.cd, 0)} shield/s → empties ${CLASSES[c].S} in ${fmt(CLASSES[c].S / (8 / md.cd), 1)} s (if power sustains ${fmt(2 * md.cost / md.cd, 0)}/s hot cost); Laser 70/s → ${fmt(CLASSES[c].S / 70, 1)} s (hot draw ${fmt(lz.draw * 1.5, 0)}/s)`);
}

// ---------------- C. Load / brownout ----------------
// Space: brute = Ram on cooldown (120), tech = Blink on cooldown (120), engineer = Repair Ray continuous 170/s.
function holdTest(c, wid, keys, secs, opts = {}) {
  const s = makeShip(c, { weapon: wid, ...(opts.ship || {}) });
  if (opts.shieldBroken) { s.S = 0; s.shieldReady = Math.round(s.st.sb * TICK); }
  if (opts.integ) s.I = s.st.I * opts.integ;
  let speedSum = 0, shieldSum = 0, n = 0, dmg = 0, L = 0, S0 = s.S;
  const cont = [];
  const ray = { draw: 170 };
  for (let t = 0; t < secs * TICK; t++) {
    const inp = { thrust: opts.thrust !== false, lmb: keys.includes('L'), rmb: keys.includes('R'), space: keys.includes('S'), ab: keys.includes('A'), cont: [] };
    if (inp.space && c === 'engineer') inp.cont.push(ray);
    if (opts.polarSus) s.polarSus = !s.brown ? true : false;
    const Sb = s.S;
    const r = reactorTick(s, inp, t, {
      onShot: (d) => { dmg += d; },
      spend: (sh, LL, sur, tt) => {
        if (inp.rmb && tt >= sh.secReady && sh.P >= sh.c.sec.cost * sur * sh.st.costMult) { sh.P -= sh.c.sec.cost * sur * sh.st.costMult; sh.secReady = tt + sh.c.sec.cd * TICK; dmg += c === 'brute' ? 540 : c === 'tech' ? 220 : 0; }
        if (inp.space && c !== 'engineer' && tt >= sh.mobReady && sh.P >= sh.c.mob.cost * sur * sh.st.costMult) { sh.P -= sh.c.mob.cost * sur * sh.st.costMult; sh.mobReady = tt + sh.c.mob.cd * TICK; if (c === 'brute') dmg += 400; }
      },
    });
    L = r.L; speedSum += r.speedMult; n++;
    shieldSum += Math.max(0, s.S - Sb);
  }
  const rec = s.stats.recovers || [];
  return { s, first: s.stats.firstBrown < 0 ? Infinity : s.stats.firstBrown / TICK, count: s.stats.brownouts, brownPct: 100 * s.stats.brownTicks / n,
    speed: speedSum / n, shield: shieldSum / (secs), recover: rec.length ? rec.reduce((a, b) => a + b, 0) / rec.length / TICK : NaN, dmg: dmg / secs, L,
    ventPct: 100 * s.stats.ventTicks / n, overPct: 100 * (s.stats.overheatTicks || 0) / n };
}
console.log('\n=== C. Load / brownout: held combos for 30 s, thrusting the whole time ===');
console.log('  Shield broken at t=0 (so shield regen competes for power) unless noted. Space: Jugg=Ram on cd, Arca=Blink on cd, Arti=Repair Ray 170/s.');
console.log('  "shield/s" = average shield regenerated; free L0 regen for reference Jugg 272, Arca 384, Arti 320.');
console.log('  class wpn keys | L | 1st brownout  #  %time | avg speed | shield/s | recovery s | raw dmg/s | overheat% vent%');
for (const c of CLS) for (const wid of WPN) for (const keys of ['L', 'LR', 'LRS', 'LS', 'RS']) {
  const r = holdTest(c, wid, keys, 30, { shieldBroken: true });
  console.log(`  ${SHORT[c]} ${WSHORT[wid]} ${padr(keys, 3)}   | ${r.L} | ${pad(fmt(r.first, 2), 6)} s ${pad(r.count, 3)} ${pad(fmt(r.brownPct, 0), 4)}% | ${pad(fmt(r.speed * 100, 0), 4)}%     | ${pad(fmt(r.shield, 0), 5)}    | ${pad(fmt(r.recover, 2), 5)}      | ${pad(fmt(r.dmg, 0), 6)}    | ${pad(fmt(r.overPct, 0), 3)} ${pad(fmt(r.ventPct, 0), 3)}`);
}
console.log('  Same with the shield FULL (no shield draw): first brownout / count / %time');
for (const c of CLS) for (const wid of WPN) {
  const row = ['L', 'LR', 'LRS'].map((keys) => { const r = holdTest(c, wid, keys, 30, {}); return `${keys}: ${fmt(r.first, 2)} s ×${r.count} ${fmt(r.brownPct, 0)}%`; }).join(' | ');
  console.log(`   ${SHORT[c]} ${WSHORT[wid]}: ${row}`);
}
console.log('  Afterburner + LMB (regen halted), shield full:');
for (const c of CLS) for (const wid of WPN) { const r = holdTest(c, wid, 'LA', 20, {}); console.log(`   ${SHORT[c]} ${WSHORT[wid]} LMB+AB: first brownout ${fmt(r.first, 2)} s, ${r.count} brownouts in 20 s, ${fmt(r.brownPct, 0)}% of time`); }
console.log('  Recovery time from a brownout (0 → 25%), thrusting vs coasting, per reactor tier:');
for (const c of CLS) {
  const row = [0, 3, 5].map((tier) => {
    const frac = [1, 0.8, 0.6, 0.4, 0.2, 0.1][tier];
    const s = makeShip(c, { reactorTiers: true }); s.I = s.st.I * frac;
    const maxP = K.effMaxP(s), reg = K.effRegen(s);
    return `tier ${tier}: ${fmt(0.25 * maxP / reg, 2)} s coasting / ${fmt(0.25 * maxP / (reg - s.st.thr), 2)} s thrusting`;
  }).join(' · ');
  console.log(`   ${SHORT[c]}: ${row}`);
}

// ---------------- D. Never-brownout search ----------------
console.log('\n=== D. Never-brownout search: 120 s holds with the shield broken at t=0, thrusting ===');
const builds = [
  ['base', {}], ['reactor×3', { cards: { reactor: 3 } }], ['reactor×5', { cards: { reactor: 5 } }], ['efficiency×3', { cards: { efficiency: 3 } }],
  ['eff×3+reac×3', { cards: { efficiency: 3, reactor: 3 } }], ['lan_coils', { coils: true }], ['coils+eff×3+reac×3', { coils: true, cards: { efficiency: 3, reactor: 3 } }],
];
const never = [];
for (const c of CLS) for (const wid of WPN) for (const keys of ['L', 'LR', 'LS', 'LRS']) {
  const res = builds.map(([name, ship]) => { const r = holdTest(c, wid, keys, 120, { shieldBroken: true, ship }); if (r.count === 0) never.push(`${SHORT[c]} ${WSHORT[wid]} ${keys} [${name}] (vent ${fmt(r.ventPct, 0)}%, dmg/s ${fmt(r.dmg, 0)})`); return r.count === 0 ? 'NEVER' : `${r.count}`; });
  if (keys === 'L') continue;
  console.log(`  ${SHORT[c]} ${WSHORT[wid]} ${padr(keys, 3)}: ` + builds.map(([n], i) => `${n}=${res[i]}`).join(' '));
}
console.log('  never browns out (120 s):'); for (const x of never) console.log('   ' + x);

// ---------------- E. Burst vs sustained efficiency ----------------
console.log('\n=== E. Burst vs sustained: raw primary damage per window, hold vs feather (release heat ≥ 90 MD/LZ, ≥ 60 PH; resume < 40) ===');
function feather(c, wid, secs, policy) {
  const s = makeShip(c, { weapon: wid });
  let dmg = 0, held = true; const w2 = [];
  const win = [2, 5, 10, 30]; const out = {};
  for (let t = 0; t < secs * TICK; t++) {
    if (policy === 'feather') {
      const hi = wid === 'phaser' ? 60 : 90;
      if (held && s.heat >= hi) held = false; else if (!held && s.heat < 40) held = true;
    } else if (policy === 'cold') { // stay below "hot": release at hot-1, resume at hot-20
      const hot = s.w.heat.hot;
      if (held && s.heat >= hot - 1) held = false; else if (!held && s.heat < hot - 20) held = true;
    }
    reactorTick(s, { lmb: held, thrust: true }, t, { onShot: (d) => { dmg += d; } });
    for (const W of win) if (t === W * TICK - 1) out[W] = dmg;
  }
  return { out, s };
}
console.log('  class wpn policy  | dps 0-2s  0-5s  0-10s  10-30s | dmg per power spent | brownouts | shield lost');
for (const c of CLS) for (const wid of WPN) for (const pol of ['hold', 'feather', 'cold']) {
  const { out, s } = feather(c, wid, 30, pol);
  const lost = s.st.S - s.S;
  console.log(`  ${SHORT[c]} ${WSHORT[wid]} ${padr(pol, 7)} | ${pad(fmt(out[2] / 2, 0), 5)} ${pad(fmt(out[5] / 5, 0), 5)} ${pad(fmt(out[10] / 10, 0), 5)} ${pad(fmt((out[30] - out[10]) / 20, 0), 6)}  | ${pad(fmt(s.stats.dmgOut / Math.max(1, s.stats.powerSpent), 2), 5)}              | ${pad(s.stats.brownouts, 3)}       | ${fmt(lost, 0)}`);
}
module.exports = { holdTest };
