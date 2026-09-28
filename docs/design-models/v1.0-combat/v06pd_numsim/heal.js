// Repair Ray sustain vs incoming DPS, Siphon value, Polarize Shields vs a drone swarm, kit/pulse arithmetic.
'use strict';
const K = require('./core');
const { TICK, DT, CLASSES, CLS, SHORT, makeShip, damageShip, reactorTick, fmt, pad, padr } = K;
const { heatH, heatScale, tierContact, tierHp, partyHp } = require('./items');

// ---------------- 1. Repair Ray on a target under steady fire ----------------
// rays: array of healMult per ray (first full, others at 50% per the stacking rule); pulse: {every, frac, sfrac}
function rayHold(tgt, dps, type, secs, o = {}) {
  const T = makeShip(tgt, o.tgtShip || {});
  const rays = o.rays ?? [1];
  const eff = rays.map((m, i) => m * (i === 0 ? 1 : 0.5));
  const art = rays.map(() => makeShip('engineer', { weapon: o.artWeapon || 'phaser' }));
  let acc = 0, minI = T.I; let artBrown = 0;
  for (let t = 0; t < secs * TICK; t++) {
    // incoming, paid every 6 ticks like a beam
    acc += dps * DT; if (t % 6 === 5) { damageShip(T, acc, type, t); acc = 0; }
    if (!T.alive) return { dead: t / TICK, T, minI: 0, artBrown };
    reactorTick(T, {}, t, {});
    // each Artificer holds Space (L1) or Space + LMB (L2)
    art.forEach((A, i) => {
      const ray = { draw: 170 };
      reactorTick(A, { space: true, lmb: !!o.artFire, thrust: true, cont: [ray] }, t, {});
      if (A.brown) { artBrown++; return; }
      if (!ray.paid) return;
      if (T.I < T.st.I) T.I = Math.min(T.st.I, T.I + 150 * eff[i] * (o.healMult || 1) * DT);
      else T.S = Math.min(T.st.S, T.S + 220 * eff[i] * (o.healMult || 1) * DT);
    });
    if (o.pulse && t % Math.round(o.pulse.every * TICK) === 0 && t > 0) {
      const heal = o.pulse.frac * T.st.I * (o.healMult || 1); const over = Math.max(0, T.I + heal - T.st.I);
      T.I = Math.min(T.st.I, T.I + heal); T.S = Math.min(T.st.S, T.S + over + o.pulse.sfrac * T.st.S * (o.healMult || 1));
    }
    minI = Math.min(minI, T.I);
  }
  return { dead: Infinity, T, minI, artBrown, artP: art.map((A) => A.P) };
}
function breakEven(tgt, type, o) { let lo = 0, hi = 3000; for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (rayHold(tgt, m, type, 60, o).dead === Infinity) lo = m; else hi = m; } return lo; }
console.log('=== 1. Repair Ray sustain: highest steady incoming dps the target survives for 60 s ===');
console.log('  (Artificer ray 150 integrity/s → 220 shield/s when integrity full, 170 power/s; 2nd ray at 50%; Pulse 22% I + 15% S every 9 s)');
const types = ['kinetic', 'energy', 'phase', 'contact'];
console.log('  target   heal setup                  | ' + types.map((t) => padr(t, 8)).join(' ') + ' | unhealed TTK @300 dps kinetic');
for (const tgt of CLS) for (const [lab, o] of [['none', { rays: [] }], ['1 ray', {}], ['1 ray + Pulse', { pulse: { every: 9, frac: 0.22, sfrac: 0.15 } }], ['2 rays (2nd @50%)', { rays: [1, 1] }], ['Medic ray ×1.4 + Pulse 6.3 s', { healMult: 1.4, pulse: { every: 6.3, frac: 0.22, sfrac: 0.15 } }], ['1 ray, Arti firing MD', { artFire: true, artWeapon: 'massdriver' }]]) {
  const row = types.map((ty) => pad(fmt(breakEven(tgt, ty, o), 0), 8)).join(' ');
  const u = rayHold(tgt, 300, 'kinetic', 60, { rays: [] });
  console.log(`  ${SHORT[tgt]}   ${padr(lab, 27)} | ${row} | ${fmt(u.dead, 2)} s`);
}
console.log('  Time to death with 1 ray vs steady kinetic dps (Juggernaut / Arcanist / Artificer target):');
for (const d of [150, 250, 300, 400, 450, 600]) {
  const row = CLS.map((tg) => { const r = rayHold(tg, d, 'kinetic', 120, {}); const u = rayHold(tg, d, 'kinetic', 120, { rays: [] }); return `${SHORT[tg]} ${r.dead === Infinity ? 'holds (min I ' + fmt(r.minI, 0) + ')' : fmt(r.dead, 1) + ' s'} vs ${fmt(u.dead, 1)} s unhealed`; }).join(' | ');
  console.log(`   ${pad(d, 3)} dps: ${row}`);
}
console.log('  Artificer power while holding the ray (L1: 170 + 25 thrust vs 420 regen): ' + (() => { const r = rayHold('brute', 150, 'kinetic', 60, {}); return `after 60 s P ${fmt(r.artP[0], 0)}, brownout ticks ${r.artBrown}`; })());
console.log('  ... with its Phaser held too (L2): ' + (() => { const r = rayHold('brute', 150, 'kinetic', 60, { artFire: true, artWeapon: 'phaser' }); return `P ${fmt(r.artP[0], 0)}, brownout ticks ${r.artBrown}`; })() + ' | with the MD: ' + (() => { const r = rayHold('brute', 150, 'kinetic', 60, { artFire: true, artWeapon: 'massdriver' }); return `P ${fmt(r.artP[0], 0)}, brownout ticks ${r.artBrown}`; })());

// ---------------- 2. Self-ray / out-of-combat repair ----------------
console.log('\n=== 2. Out-of-combat repair (dungeon integrity never regenerates by itself) ===');
for (const tgt of CLS) {
  const I = CLASSES[tgt].I;
  console.log(`  ${SHORT[tgt]} ${I} integrity from 10% → full: ray ${fmt(0.9 * I / 150, 1)} s (${fmt(0.9 * I / 150 * 170, 0)} power); Pulse ${Math.ceil(0.9 / 0.22)} pulses = ${fmt((Math.ceil(0.9 / 0.22) - 1) * 9, 0)} s; self-ray (Artificer only) ${tgt === 'engineer' ? fmt(0.9 * I / 70, 1) + ' s' : '—'}`);
}
console.log('  Party of 6 (2 Jugg, 2 Arca, 2 Arti) all at 30% integrity after a room: two Artificers ray + pulse → full in ≈ ' + (() => {
  const need = [900, 900, 420, 420, 600, 600].map((x) => 0.7 * x); let t = 0; const pulseAll = (f) => need.forEach((v, i, a) => { a[i] = Math.max(0, v - f * [900, 900, 420, 420, 600, 600][i]); });
  while (need.some((v) => v > 0) && t < 600) { if (t % 9 === 0) pulseAll(0.22 * 2); let rays = 2; for (let i = 0; i < 6 && rays > 0; i++) if (need[i] > 0) { need[i] = Math.max(0, need[i] - 150); rays--; } t++; }
  return t + ' s (walking between rooms takes ~10–20 s), for ≈ ' + fmt(t * 170 * 2, 0) + ' power total (free: both reactors refill at 420/s)';
})());

// ---------------- 3. Siphon ----------------
console.log('\n=== 3. Siphon Ray (Medic talent: 140 ion dps, shield ×1.5 / integrity ×0.5, drains 0.5×dmg power, 50% of damage dealt returns as repair) ===');
for (const def of CLS) {
  const D = makeShip(def); let healed = 0, t = 0, tStrip = -1;
  for (; t < 60 * TICK && D.alive; t++) {
    if (t % 6 === 5) { const r = damageShip(D, 140 * 0.1, 'ion', t); healed += 0.5 * (r.sd + r.idmg); if (tStrip < 0 && D.S <= 0) tStrip = t / TICK; }
    reactorTick(D, {}, t, {});
  }
  console.log(`  vs ${SHORT[def]} (passive): shield down at ${fmt(tStrip, 2)} s, kill at ${D.alive ? '>60' : fmt(t / TICK, 1)} s; repair returned ${fmt(healed, 0)} total (${fmt(healed / (t / TICK), 0)}/s avg; shield phase ${fmt(0.5 * 210, 0)}/s, integrity phase ${fmt(0.5 * 70 * (1 - CLASSES[def].armor), 0)}/s)`);
}
console.log('  vs PvE enemies (no layers, ion ×1): 140 dps + 70 repair/s for 170 power/s — Artificer own damage intake it cancels: 70 integrity/s = ' + fmt(70 / 110, 2) + ' raw drone contacts/s at H1 f1.');
console.log('  vs self-ray (70/s, no damage): Siphon is strictly better whenever a hostile is within 380 px; both run forever at L1 (420 regen − 170 − 25 = +225/s).');

// ---------------- 4. Polarize Shields vs a drone stream ----------------
// mode: 'none' | 'tap' (4 s every 15 s) | 'sustain' (tap then hold E while power allows) ; lmb: firing the MD (L+1)
function polar(f, H, dronesPerSec, brutes, mode, lmb, o = {}) {
  const s = makeShip('brute', { weapon: 'massdriver', ...(o.ship || {}) });
  const hs = heatScale(H); const contact = 110 * tierContact(f) * hs.dmg * (o.elite ? 1.5 : 1);
  const bruteContact = 240 * tierContact(f) * hs.dmg;
  const ram = !!o.ram;
  let acc = 0, killed = 0, tapUntil = -1, cdUntil = 0, active = false, susStarted = false;
  for (let t = 0; t < 60 * TICK; t++) {
    // stance control: tap (4 s), optional sustain after it, cooldown 11 s from the end
    if (mode !== 'none') {
      if (!active && t >= cdUntil && !s.brown && s.P >= 120) { s.P -= 120; tapUntil = t + 4 * TICK; s.polarUntil = tapUntil; active = true; susStarted = false; }
      if (active && t >= tapUntil) {
        if (mode === 'sustain' && !susStarted) { s.polarSus = true; susStarted = true; }
        if (s.polarSus && o.release && s.P < o.release * s.st.P) s.polarSus = false;
        if (!s.polarSus) { active = false; cdUntil = t + 11 * TICK; }
      }
    }
    const polarOn = t < s.polarUntil || s.polarSus;
    reactorTick(s, { lmb, thrust: true }, t, {});
    acc += dronesPerSec * DT;
    while (acc >= 1) {
      acc--;
      const c = contact * (ram ? 0.3 : 1) * (polarOn ? 0.25 : 1);
      damageShip(s, c, 'contact', t); if (polarOn || ram) killed++;
    }
    if (brutes && t % 30 === 0) damageShip(s, bruteContact * brutes * (ram ? 0.3 : 1) * (polarOn ? 0.5 : 1), 'contact', t);
    if (!s.alive) return { dead: t / TICK, killed, s };
  }
  return { dead: Infinity, killed, s };
}
console.log('\n=== 4. Polarize Shields: Juggernaut (MD) in a stream of drones that all reach it; 60 s ===');
console.log('  modes: none | tap (4 s, 11 s cd → 27% uptime) | sustain (tap, then hold E at 140/s ×load until brownout, then 11 s cd). "MD" = firing too.');
for (const [f, m] of [[1, 1], [3, 3], [6, 3], [6, 6], [9, 5]]) {
  const H = heatH(f, m, 2, 2);
  console.log(`  floor ${f}, minute ${m} (H ${fmt(H, 2)}, drone contact ${fmt(110 * tierContact(f) * heatScale(H).dmg, 0)}):`);
  for (const rate of [2, 4, 6, 8, 12]) {
    const cells = [['none', false], ['tap', false], ['sustain', false], ['sustain', true]].map(([md, l]) => { const r = polar(f, H, rate, 0, md, l); return r.dead === Infinity ? `holds (I ${fmt(r.s.I, 0)})` : `${fmt(r.dead, 1)} s`; });
    const ram = polar(f, H, rate, 0, 'sustain', true, { ram: true });
    console.log(`    ${pad(rate, 2)} drones/s: none ${padr(cells[0], 14)} tap ${padr(cells[1], 14)} sustain ${padr(cells[2], 14)} sustain+MD ${padr(cells[3], 14)} | Ram path (Spiked Prow) sustain+MD ${ram.dead === Infinity ? 'holds (I ' + fmt(ram.s.I, 0) + ')' : fmt(ram.dead, 1) + ' s'}`);
  }
  const b = polar(f, H, 2, 1, 'sustain', false), b2 = polar(f, H, 4, 2, 'sustain', false);
  console.log(`    + brutes in contact, sustain, not firing: 2 drones/s + 1 brute ${b.dead === Infinity ? 'holds (I ' + fmt(b.s.I, 0) + ')' : fmt(b.dead, 1) + ' s'} | 4 drones/s + 2 brutes ${b2.dead === Infinity ? 'holds (I ' + fmt(b2.s.I, 0) + ')' : fmt(b2.dead, 1) + ' s'}`);
}
// sustain power budget
console.log('  Sustain power: L1 (E only) = 140 + 40 thrust + shield regen (170 × 0.6 = 102 while refilling) = 282/s vs 280 regen → break-even; L2 with MD: (180 + 140) × 1.25 + 40 + (85 × 0.6) = 491/s → brownout in ≈ ' + fmt(1000 / (491 - 280), 1) + ' s');
const pol = polar(3, 2.6, 6, 0, 'sustain', false);
console.log(`  sustain, not firing, 6 drones/s f3: ${pol.dead === Infinity ? 'holds' : 'dies ' + fmt(pol.dead, 1)} — ${pol.killed} drones taken down via killEnemy in 60 s (all rewarded: XP, kit rolls, elite loot)`);
module.exports = { rayHold, polar };
