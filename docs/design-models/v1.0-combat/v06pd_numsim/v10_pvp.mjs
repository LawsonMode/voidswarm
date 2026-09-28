// PvP numbers: weapon curves, heat, TTK matrix, bursts, brownout. Scratch only.
import { CLASSES, CLS, WEAPONS, WPN, KIND, DT, falloff, mdBleed, dealtMult, makeShip, damageShip, stepPilot, pad, padr, f1, f2, f0, ARMOR_CAP, STRAIN_MOVE, STRAIN_SHIELD } from './v10_core.mjs';

const out = [];
const P = (...a) => out.push(a.join(' '));

// ---------------------------------------------------------------- A. weapon DPS vs distance
P('=== A. Weapon DPS vs distance (raw, 100% accuracy, cold weapon; class affinity applied) ===');
const dists = [0, 100, 160, 250, 350, 450, 560, 680, 900];
P('  att  wpn  ' + dists.map((d) => pad(d, 5)).join('') + '   (Laser +20% Focus when still not included)');
for (const a of CLS) for (const wid of WPN) {
  const c = CLASSES[a], w = WEAPONS[wid];
  const row = dists.map((d) => {
    const f = falloff(w, d); if (f <= 0) return pad('-', 5);
    const base = w.beam ? w.dps : w.dmg / w.interval;
    return pad(f0(base * f * dealtMult(c, w.kind)), 5);
  });
  P('  ' + padr(c.short, 5) + padr(w.short, 5) + row.join(''));
}
P('');
P('  Effective layer damage per second (vs SHIELD / vs HULL after armor), attacker default affinity, at d:');
function layerRates(att, wid, def, d, still = false) {
  const ca = CLASSES[att], cd = CLASSES[def], w = WEAPONS[wid], K = KIND[w.kind];
  const f = falloff(w, d); if (f <= 0) return [0, 0];
  let raw = (w.beam ? w.dps * (still ? w.focusMult : 1) : w.dmg / w.interval) * f * dealtMult(ca, w.kind);
  const resist = cd.armorType === 'phase' && w.kind === 'energy' ? 0.8 : 1;
  let bleed = wid === 'massdriver' ? mdBleed(d) : 0; if (cd.armorType === 'heavy') bleed *= 0.5;
  const hullMul = K.vsHull * (1 - Math.min(ARMOR_CAP, Math.max(0, cd.armor - K.pierce)));
  const shieldRate = raw * (1 - bleed) * K.vsShield * resist;
  const hullRate = raw * hullMul;
  return [shieldRate, hullRate, raw * bleed * hullMul];
}
for (const wid of WPN) for (const d of (wid === 'massdriver' ? [120, 350, 540] : wid === 'laser' ? [600] : [400, 650])) {
  const cells = [];
  for (const def of CLS) { const [s, h] = layerRates(CLASSES[wid === 'massdriver' ? 'brute' : wid === 'laser' ? 'tech' : 'engineer'].id, wid, def, d); cells.push(`${CLASSES[def].short} S ${pad(f0(s), 4)} H ${pad(f0(h), 4)}`); }
  P(`  ${padr(WEAPONS[wid].short, 3)} @${pad(d, 3)} (${wid === 'massdriver' ? 'Jugg' : wid === 'laser' ? 'Arca' : 'Arti'} firing): ` + cells.join(' | '));
}
P('');

// ---------------------------------------------------------------- B. heat
P('=== B. Heat: hold LMB from cold, not thrusting, no incoming damage (so own shield regen DOES run while tapping) ===');
P('  att wpn  | t50   t100  | tap drain/s  regen/s | shield->0 (unhit)  shield->0 (under fire) | 1st jam  jam len | dps 0-3s  dps 3-30s  disciplined(80/40) | dmg/power cold');
function heatRun(att, wid, opts = {}) {
  const s = makeShip(att, { weapon: wid, ...(opts.mods ?? {}) });
  let t50 = -1, t100 = -1, d03 = 0, d330 = 0, underFire = opts.underFire;
  let powerUsed = 0;
  for (let i = 0; i < 30 * 60; i++) {
    const p0 = s.power;
    if (underFire) s.regenAt = s.t + 10; // continuous incoming damage blocks regen (no actual damage applied)
    const pk = stepPilot(s, { lmb: true, still: true, rmb: !!opts.rmb, space: !!opts.space }, { dist: 100, disciplined: !!opts.disc });
    const dmg = pk.filter((p) => p.src === 'weapon').reduce((a, p) => a + p.amount, 0);
    if (s.t <= 3) d03 += dmg; else d330 += dmg;
    if (t50 < 0 && s.heat >= 50) t50 = s.t;
    if (t100 < 0 && s.heat >= 100) t100 = s.t;
  }
  return { s, t50, t100, dps03: d03 / 3, dps330: d330 / 27 };
}
for (const a of CLS) for (const wid of WPN) {
  const r = heatRun(a, wid), rf = heatRun(a, wid, { underFire: true }), rd = heatRun(a, wid, { disc: true });
  const c = CLASSES[a], w = WEAPONS[wid], s = r.s;
  const tapPerSec = (w.beam ? w.costPerSec : w.cost / w.interval) * s.weaponCostMult * 3;
  const regen = c.shieldRegen; // not calm, strain 1
  const drainUnhit = tapPerSec > regen ? c.maxShield / (tapPerSec - regen) : Infinity;
  const drainFire = c.maxShield / tapPerSec;
  const coldCost = (w.beam ? w.costPerSec : w.cost / w.interval) * s.weaponCostMult;
  const coldDps = (w.beam ? w.dps * 1.2 : w.dmg / w.interval) * dealtMult(c, w.kind);
  P(`  ${padr(c.short, 4)} ${padr(w.short, 3)} | ${pad(f2(r.t50), 4)}  ${pad(f2(r.t100), 4)} | ${pad(f0(tapPerSec), 6)}  ${pad(f0(regen), 6)}      | ${pad(f1(drainUnhit), 6)} s           ${pad(f1(drainFire), 5)} s              | ${pad(f1(rf.s.stats.firstJam), 5)}  ${pad(f1(rf.s.stats.jamTime / Math.max(1, rf.s.stats.jams)), 4)} s | ${pad(f0(rf.dps03), 5)}   ${pad(f0(rf.dps330), 5)}(fire) ${pad(f0(r.dps330), 5)}(unhit)  ${pad(f0(rd.dps330), 5)} | ${f2(coldDps / coldCost)}`);
}
P('  note: at heat 100 the ×3 cost is paid from SHIELD, so the power cost of an overheated weapon is 0; the shield it taps is refilled');
P('        by regen at 0.3 power/pt, i.e. an overheated weapon costs 0.9× its COLD power (cheaper than heat 50–100 at ×1–×3).');
P('  Arcanist + Laser, unhit: tap 240/s vs regen 200/s → net −40/s. With Shield Harmonics ×2 (+24% regen = 248/s) the tap is FREE FOREVER:');
for (const lv of [0, 1, 2, 5]) {
  const r = heatRun('tech', 'laser', { mods: { regenMult: 1 + 0.12 * lv } });
  P(`    harmonics ${lv}: first jam ${r.s.stats.firstJam < 0 ? 'never (30 s)' : f1(r.s.stats.firstJam) + ' s'}; dps 3-30s ${f0(r.dps330)}; power left ${f0(r.s.power)}`);
}
P('');

// ---------------------------------------------------------------- C. TTK matrix
function ttk(att, wid, def, o) {
  const A = makeShip(att, { weapon: wid, ...(o.attMods ?? {}) });
  const D = makeShip(def, o.defMods ?? {});
  if (o.defShield === 'down') { D.shield = 0; D.regenAt = D.t + D.shieldBreakDelay; D.shieldDown = true; }
  if (o.defShield === 'poldown') { /* nothing */ }
  const q = [];
  const w = WEAPONS[wid];
  const maxT = o.maxT ?? 60;
  let t = 0, shieldBreakT = -1;
  const dist = o.dist;
  while (t < maxT) {
    t += DT;
    const inp = { lmb: true, still: o.still ?? true, rmb: !!o.sec, space: !!o.mob, spaceSpam: !!o.mob, thrust: !o.still };
    const pk = stepPilot(A, inp, { dist, disciplined: !!o.disc, reserveFrac: 0 });
    for (const p of pk) {
      let delay = p.delay ?? 0;
      if (p.src === 'weapon' && !w.beam) delay = dist / w.speed;
      if (p.src === 'sentry') delay = 0.6;
      q.push({ at: t + delay, p });
    }
    stepPilot(D, { polarize: !!o.defPol }, { dist });
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= t) {
      const p = q[i].p; q.splice(i, 1);
      const r = damageShip(D, p.amount * (o.acc ?? 1), { kind: p.kind, bleed: p.bleed, breakLock: p.breakLock });
      if (r.broke && shieldBreakT < 0) shieldBreakT = t;
    }
    if (D.integrity <= 0) return { t, shieldBreakT, A, D };
  }
  return { t: Infinity, shieldBreakT, A, D };
}
const RANGE_OF = { massdriver: [120, 350, 540], laser: [600], phaser: [400] };
P('=== C. TTK (s), one attacker, defender passive (not shooting, not dodging). Default weapons. hold = LMB held (overheat → shield tap → jam);');
P('       disc = bot discipline (release at heat 80, resume 40). "S up" = full shield; "S down" = shield just broken, full hull. ===');
P('  attacker@d            defender | prim hold 100%  60% | prim disc 60% | prim+sec 100%  60% | S down: prim 100%  60% | +sec 60%');
for (const a of CLS) {
  const wid = CLASSES[a].weapon;
  for (const d of RANGE_OF[wid]) for (const def of CLS) {
    const r1 = ttk(a, wid, def, { dist: d, acc: 1 }), r2 = ttk(a, wid, def, { dist: d, acc: 0.6 });
    const r3 = ttk(a, wid, def, { dist: d, acc: 0.6, disc: true });
    const r4 = ttk(a, wid, def, { dist: d, acc: 1, sec: true }), r5 = ttk(a, wid, def, { dist: d, acc: 0.6, sec: true });
    const r6 = ttk(a, wid, def, { dist: d, acc: 1, defShield: 'down' }), r7 = ttk(a, wid, def, { dist: d, acc: 0.6, defShield: 'down' });
    const r8 = ttk(a, wid, def, { dist: d, acc: 0.6, defShield: 'down', sec: true });
    P(`  ${padr(CLASSES[a].short + ' ' + WEAPONS[wid].short + '@' + d, 16)} vs ${padr(CLASSES[def].short, 5)}| ${pad(f1(r1.t), 5)} (brk ${pad(f1(r1.shieldBreakT), 4)}) ${pad(f1(r2.t), 5)} | ${pad(f1(r3.t), 5)}         | ${pad(f1(r4.t), 5)}        ${pad(f1(r5.t), 5)} | ${pad(f1(r6.t), 5)}             ${pad(f1(r7.t), 5)} | ${pad(f1(r8.t), 5)}`);
  }
}
P('');
P('  Off-class weapons (100% / 60% hold, primary only, shield up; attacker affinity only if matching kind):');
for (const a of CLS) for (const wid of WPN) {
  if (wid === CLASSES[a].weapon) continue;
  const d = wid === 'massdriver' ? 120 : wid === 'laser' ? 600 : 400;
  const cells = CLS.map((def) => { const r1 = ttk(a, wid, def, { dist: d, acc: 1 }), r2 = ttk(a, wid, def, { dist: d, acc: 0.6 }); return `${CLASSES[def].short} ${pad(f1(r1.t), 4)}/${pad(f1(r2.t), 4)}`; });
  P(`  ${padr(CLASSES[a].short + ' ' + WEAPONS[wid].short + '@' + d, 16)} ` + cells.join('  '));
}
P('');
P('  Laser moving (no Focus) vs still, 100%: ' + CLS.map((def) => `${CLASSES[def].short} ${f1(ttk('tech', 'laser', def, { dist: 600, acc: 1, still: false }).t)} / ${f1(ttk('tech', 'laser', def, { dist: 600, acc: 1, still: true }).t)}`).join('  '));
P('  Polarized Juggernaut defender (shield absorb 0.45 until break):');
for (const a of CLS) {
  const wid = CLASSES[a].weapon, d = RANGE_OF[wid][0];
  const r1 = ttk(a, wid, 'brute', { dist: d, acc: 1, defPol: true }), r2 = ttk(a, wid, 'brute', { dist: d, acc: 0.6, defPol: true });
  const b1 = ttk(a, wid, 'brute', { dist: d, acc: 1 });
  P(`    ${CLASSES[a].short} ${WEAPONS[wid].short}@${d}: ${f1(r1.t)} s (60%: ${f1(r2.t)}) vs unpolarized ${f1(b1.t)} s; shield broke at ${f1(r1.shieldBreakT)} s; Jugg power left ${f0(r1.D.power)}`);
}
P('');

// ---------------------------------------------------------------- D. bursts
P('=== D. Juggernaut vs Arcanist bursts (100% accuracy unless noted) ===');
function burst(att, def, script, o = {}) {
  const A = makeShip(att, o.attMods ?? {}); const D = makeShip(def, o.defMods ?? {});
  const q = []; let t = 0; const log = [];
  let brk = -1;
  while (t < 20) {
    t += DT;
    const inp = script(t, A);
    const pk = stepPilot(A, inp, { dist: inp.dist ?? o.dist ?? 120, dmgMult: o.dmgMult ?? 1 });
    for (const p of pk) q.push({ at: t + (p.src === 'weapon' && !WEAPONS[A.weapon].beam ? (inp.dist ?? 120) / WEAPONS[A.weapon].speed : p.delay ?? 0), p });
    stepPilot(D, { polarize: !!o.defPol }, {});
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= t) {
      const p = q[i].p; q.splice(i, 1);
      const acc = p.src === 'weapon' ? (o.acc ?? 1) : (o.skillAcc ?? 1);
      const r = damageShip(D, p.amount * acc, { kind: p.kind, bleed: p.bleed, breakLock: p.breakLock });
      if (r.broke && brk < 0) brk = t;
    }
    if (D.integrity <= 0) return { t, brk, A, D };
  }
  return { t: Infinity, brk, A, D };
}
{
  // Jugg: Ram at t=0 (dash 525 px closes to point blank), rockets at 0.36 s, Mass Driver from 0.36 s at 100 px
  const js = (t) => ({ space: t < 0.05, rmb: t >= 0.36, lmb: t >= 0.36, dist: t < 0.36 ? 400 : 100, thrust: true });
  const r = burst('brute', 'tech', js), r6 = burst('brute', 'tech', js, { acc: 0.6 });
  P(`  Jugg Ram(400 kin, bleed .25) → Rockets 3×180 → Mass Driver @100 on Arcanist: takedown ${f2(r.t)} s (shield broke ${f2(r.brk)} s); MD 60%: ${f2(r6.t)} s`);
  const js2 = (t) => ({ rmb: true, lmb: true, dist: 100, thrust: true });
  P(`  Jugg Rockets + MD @100 (no Ram): ${f2(burst('brute', 'tech', js2).t)} s; 60% all: ${f2(burst('brute', 'tech', js2, { acc: 0.6, skillAcc: 0.6 }).t)} s`);
  const rp = burst('brute', 'tech', js, { attMods: { }, dmgMult: 1 });
  // Ram path: cd -40%, dmg +50% ; model as ram dmg ×1.5
  CLASSES.brute.mob.dmg = 600; const rr = burst('brute', 'tech', js); CLASSES.brute.mob.dmg = 400;
  P(`  Ram path (Ram dmg ×1.5): ${f2(rr.t)} s`);
  // Arcanist on Jugg: Laser still + Arc at 550 px; Lance+Focus talent: ×1.3 on weapon
  const as = (t) => ({ lmb: true, rmb: true, still: true, dist: 550 });
  const a1 = burst('tech', 'brute', as), a2 = burst('tech', 'brute', as, { acc: 0.6, skillAcc: 1 });
  P(`  Arcanist Laser(Focus, still)+Arc @550 on Juggernaut: ${f2(a1.t)} s (shield ${f2(a1.brk)}); laser 60%: ${f2(a2.t)} s`);
  const asL = (t) => ({ lmb: true, rmb: true, still: true, dist: 550 });
  // Lance Focus talent: +30% weapon dmg while not thrusting → approximate with dmgMult 1.3 on everything (arc too, slight overcount)
  const a3 = burst('tech', 'brute', (t) => ({ lmb: true, still: true, dist: 550 }), { dmgMult: 1.3 });
  P(`  Arcanist Lance+Focus talent Laser only (718 dps) @550: ${f2(a3.t)} s (spec says ~3.9 s at 900 px)`);
  const a4 = burst('tech', 'brute', as, { defPol: true });
  P(`  ... vs POLARIZED Jugg (Laser+Arc): ${f2(a4.t)} s (shield ${f2(a4.brk)})`);
  const a5 = burst('tech', 'brute', (t) => ({ lmb: true, still: false, dist: 700, thrust: true }), { acc: 0.6 });
  P(`  Kiting Arcanist (moving, no Focus, 60%) @700 on Jugg: ${f2(a5.t)} s — Jugg MD cannot reply beyond 560 px`);
}
P('  Kite geometry: Arcanist max 520 / AB 780 vs Jugg 420 / AB 620; Laser 900 px vs MD 560 px; Ram dash 525 px per 6 s vs Blink 480 px per 5 s.');
{
  // time for Jugg to close from 900 to 560 when the Arcanist backs off at max speed: never (420 < 520). With AB: 620 vs 520 → 340/100 = 3.4 s, costs 200/s → 680 power
  P(`    Jugg afterburner chase closing 340 px vs a backing Arcanist (620−520=100 px/s): 3.4 s, 680 power of 900; Arcanist AB (780) re-opens at 160 px/s.`);
}
P('');

// ---------------------------------------------------------------- E. brownout
P('=== E. Strain / Brownout: hold combos for 60 s, thrusting, no incoming damage, shield starts BROKEN (so regen competes for power) ===');
P('  Space: Jugg Ram / Arca Blink re-pressed on cooldown (spam); Arti = Repair Ray channel (blocks weapon).');
P('  combo       | strain | 1st brownout  count  %time | recov s | speed avg (strain×BO) | shield regen: rate mult  pts/s | weapon dps  jam%');
function boRun(a, wid, combo, mods = {}) {
  const s = makeShip(a, { weapon: wid, ...mods });
  s.shield = 0; s.regenAt = s.cls.shieldBreakDelay;
  let spd = 0, dmg = 0, jam = 0;
  const N = 60 * 60;
  for (let i = 0; i < N; i++) {
    const inp = { thrust: true, lmb: combo.includes('L'), rmb: combo.includes('R'), space: combo.includes('S'), spaceSpam: true, ab: combo.includes('A'), channel: a === 'engineer' && combo.includes('S') };
    const pk = stepPilot(s, inp, { dist: 150 });
    dmg += pk.filter((p) => p.src === 'weapon').reduce((x, p) => x + p.amount, 0);
    spd += s.speedMult; if (s.jammed) jam++;
  }
  const strain = combo.replace(/[^LRSA]/g, '').length;
  const rec = s.stats.recov.length ? s.stats.recov.reduce((x, y) => x + y, 0) / s.stats.recov.length : NaN;
  return { s, strain, rec, spd: spd / N, dps: dmg / 60, jam: jam / N, regenPts: s.stats.shieldRegenGained / 60 };
}
for (const a of CLS) {
  const wid = CLASSES[a].weapon;
  for (const combo of ['L', 'LR', 'LRS', 'LRSA', 'RS', 'LA']) {
    const r = boRun(a, wid, combo);
    const regenMult = STRAIN_SHIELD[Math.min(4, r.strain)];
    P(`  ${padr(CLASSES[a].short + ' ' + WEAPONS[wid].short + ' ' + combo, 12)}|   ${r.strain}    | ${pad(r.s.stats.firstBrownout < 0 ? 'never' : f1(r.s.stats.firstBrownout) + ' s', 8)}   ${pad(r.s.stats.brownouts, 4)}  ${pad(f0(100 * r.s.stats.brownoutTime / 60), 4)}% | ${pad(f2(r.rec), 5)}   | ${pad(f0(100 * r.spd), 4)}% (table ${f0(100 * STRAIN_MOVE[Math.min(4, r.strain)])}%)        |        ×${f2(regenMult)}   ${pad(f0(r.regenPts), 4)}  | ${pad(f0(r.dps), 5)}   ${pad(f0(100 * r.jam), 3)}%`);
  }
}
P('  Recovery from 0 → 25% with everything released except thrust: ' + CLS.map((a) => { const c = CLASSES[a]; return `${c.short} ${f2(0.25 * c.maxPower / (c.powerRegen - c.thrustPower))} s`; }).join(', '));
P('');
P('  Never-brownout check, LMB+RMB+Space held 60 s, default weapon, with cards:');
const CARDS = {
  none: {},
  'coils (lance talent)': { weaponCostMult: 0.65, heatMult: 0.75, powerRegenMult: 1.15 },
  'efficiency 4 (−40% all costs)': { costMult: 0.6 },
  'reactor 5 (+60% regen)': { powerRegenMult: 1.6 },
  'reactor 3 + efficiency 2': { powerRegenMult: 1.36, costMult: 0.8 },
};
for (const a of CLS) {
  const cells = Object.entries(CARDS).map(([k, m]) => { const r = boRun(a, CLASSES[a].weapon, 'LRS', m); return `${k}: ${r.s.stats.firstBrownout < 0 ? 'NEVER' : f1(r.s.stats.firstBrownout) + 's/' + f0(100 * r.s.stats.brownoutTime / 60) + '%'}`; });
  P(`    ${padr(CLASSES[a].short, 5)} ` + cells.join(' | '));
}
P('');

export const pvpOut = out;
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./v10_pvp.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
