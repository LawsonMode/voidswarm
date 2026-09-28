// Numerically validate the proposed fixes (scratch only).
'use strict';
const K = require('./core');
const { TICK, CLS, SHORT, WPN, WSHORT, makeShip, reactorTick, damageShip, fmt, pad, padr } = K;
const { holdTest } = require('./reactor.js');
const which = process.argv[2] || 'all';

function sustained(c, wid, pol, ship = {}) {
  const s = makeShip(c, { weapon: wid, ...ship }); let dmg = 0, d10 = 0, held = true;
  for (let t = 0; t < 30 * TICK; t++) {
    if (pol === 'feather') { const hi = wid === 'phaser' ? 60 : 90; if (held && s.heat >= hi) held = false; else if (!held && s.heat < 40) held = true; }
    reactorTick(s, { lmb: held, thrust: true }, t, { onShot: (d) => { dmg += d; } });
    if (t === 10 * TICK - 1) d10 = dmg;
  }
  return { dps: (dmg - d10) / 20, S: s.S, vents: s.stats.vents };
}
if (which === 'all' || which === 'heat') {
  console.log('=== F1. Overheat fix: drain arms the shield BREAK delay; vent to heat 40 for 1.5 s (sustained dps 10–30 s, hold vs feather) ===');
  for (const c of CLS) for (const w of ['massdriver', 'laser']) {
    const a = sustained(c, w, 'hold'), b = sustained(c, w, 'feather'), a2 = sustained(c, w, 'hold', { ovFix: { ventTo: 40, ventSec: 1.5 } }), b2 = sustained(c, w, 'feather', { ovFix: { ventTo: 40, ventSec: 1.5 } });
    console.log(`  ${SHORT[c]} ${WSHORT[w]}: spec hold ${fmt(a.dps, 0)} vs feather ${fmt(b.dps, 0)} (hold/feather ${fmt(a.dps / b.dps, 2)}, hold ends with S ${fmt(a.S, 0)}) | fixed hold ${fmt(a2.dps, 0)} vs feather ${fmt(b2.dps, 0)} (${fmt(a2.dps / b2.dps, 2)}, hold ends with S ${fmt(a2.S, 0)})`);
  }
}
if (which === 'all' || which === 'strain') {
  console.log('\n=== F2. Strain also throttles regen (L2 ×0.85, L3 ×0.6): 120 s holds, shield broken at t 0 — brownouts (0 = never) ===');
  const builds = [['base', {}], ['reactor×3', { cards: { reactor: 3 } }], ['eff×3+reac×3', { cards: { efficiency: 3, reactor: 3 } }]];
  for (const c of CLS) for (const w of WPN) {
    const row = ['LR', 'LRS'].map((k) => builds.map(([n, b]) => { const r0 = holdTest(c, w, k, 120, { shieldBroken: true, ship: b }); const r1 = holdTest(c, w, k, 120, { shieldBroken: true, ship: { ...b, strainRegen: [1, 1, 0.85, 0.6] } }); return `${n} ${r0.count}→${r1.count}`; }).join(', ')).join(' || ');
    console.log(`  ${SHORT[c]} ${WSHORT[w]}  LR: ${row.replace(' || ', ' || LRS: ')}`);
  }
}
if (which === 'all' || which === 'pvp') {
  console.log('\n=== F3. Bombs at 300 PvP (PvE keeps 630): 2 bombs vs each class from full ===');
  for (const d of CLS) { const s = makeShip(d); damageShip(s, 300, 'kinetic', 0); damageShip(s, 300, 'kinetic', 0); console.log(`  ${SHORT[d]}: S ${fmt(s.S, 0)} I ${fmt(s.I, 0)}/${s.st.I}${s.alive ? '' : ' DEAD'}`); }
  console.log('\n=== F4. Phaser fix: phase integrity ×0.7 → ×0.9 and overheat rate ×0.5 → ×0.75 (commit, 100%, 500 px) ===');
  const { duel } = require('./ttk.js');
  for (const a of CLS) {
    const base = CLS.map((d) => fmt(duel(a, 'phaser', d, 500, 'P', {}).t, 2)).join('/');
    K.WEAPONS.phaser.heat.overCdMult = 1.333;
    const fixed = CLS.map((d) => fmt(duel(a, 'phaser', d, 500, 'P', { defShip: { typeMult: { phase: [2.5, 0.9, 1] } } }).t, 2)).join('/');
    K.WEAPONS.phaser.heat.overCdMult = 2;
    const md = CLS.map((d) => fmt(duel(a, 'massdriver', d, 350, 'P', {}).t, 2)).join('/');
    console.log(`  ${SHORT[a]} PH vs Jugg/Arca/Arti: spec ${base} s → fixed ${fixed} s   (MD @350 for reference ${md} s)`);
  }
}
