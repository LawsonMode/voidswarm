// Spec §6.1 movement model, tick-accurate: stop, 0→max, reversal, 90° strafe, turn, knockback slide, capitals.
'use strict';
const { TICK, DT, CLASSES, CLS, SHORT, fmt, pad, padr } = require('./core');
const OVERSPEED = 1200;

function step(b, c, dir, ab, speedMult, mass) {
  // dir: [dx, dy] unit or null (coasting)
  if (dir) {
    const a = c.thrust * speedMult * (ab ? 1.5 : 1) / mass;
    b.vx += dir[0] * a * DT; b.vy += dir[1] * a * DT;
    const along = Math.max(0, b.vx * dir[0] + b.vy * dir[1]);
    const wx = b.vx - along * dir[0], wy = b.vy - along * dir[1];
    const wm = Math.hypot(wx, wy);
    if (wm > 0) {
      const nm = Math.max(0, wm - (c.drag * c.grip * wm + c.brake * c.grip) / mass * DT);
      const k = nm / wm; b.vx = along * dir[0] + wx * k; b.vy = along * dir[1] + wy * k;
    }
  } else {
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) { const ns = Math.max(0, sp * (1 - c.drag / mass * DT) - c.brake / mass * DT); b.vx *= ns / sp; b.vy *= ns / sp; }
  }
  const maxS = (ab ? c.abMax : c.max) * speedMult;
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > maxS) { const t = Math.max(maxS, sp - OVERSPEED * DT); b.vx *= t / sp; b.vy *= t / sp; }
  b.x += b.vx * DT; b.y += b.vy * DT;
}
function hostPen(n) { return Math.max(0.5, 1 - 0.07 * n); }
function mass(n) { return 1 + 0.25 * n; }

function stopFrom(c, v0, n = 0) { const b = { x: 0, y: 0, vx: v0, vy: 0 }; let t = 0; while (Math.hypot(b.vx, b.vy) > 0 && t < 30 * TICK) { step(b, c, null, false, 1, mass(n)); t++; } return { t: t / TICK, d: b.x }; }
function accelTo(c, frac, n = 0, ab = false) { const b = { x: 0, y: 0, vx: 0, vy: 0 }; const sm = hostPen(n); const target = (ab ? c.abMax : c.max) * sm * frac; let t = 0; while (b.vx < target - 1e-6 && t < 30 * TICK) { step(b, c, [1, 0], ab, sm, mass(n)); t++; } return t / TICK; }
function reversal(c, n = 0) {
  const sm = hostPen(n), b = { x: 0, y: 0, vx: c.max * sm, vy: 0 }; let t = 0, t0 = -1, t90 = -1, xmax = 0;
  while (t < 30 * TICK) { step(b, c, [-1, 0], false, sm, mass(n)); t++; xmax = Math.max(xmax, b.x); if (t0 < 0 && b.vx <= 0) t0 = t / TICK; if (b.vx <= -0.9 * c.max * sm) { t90 = t / TICK; break; } }
  return { t0, t90, overshoot: xmax };
}
function strafe(c, n = 0) {
  const sm = hostPen(n), b = { x: 0, y: 0, vx: c.max * sm, vy: 0 }; let t = 0, tHead = -1, t90 = -1;
  while (t < 30 * TICK) { step(b, c, [0, 1], false, sm, mass(n)); t++; const ang = Math.atan2(b.vy, b.vx); if (tHead < 0 && ang >= (80 * Math.PI) / 180) tHead = t / TICK; if (t90 < 0 && b.vy >= 0.9 * c.max * sm) t90 = t / TICK; if (tHead > 0 && t90 > 0) break; }
  return { tHead, t90, drift: b.x };
}
function knockSlide(c, impulse, n = 0) { const v = impulse * c.knock / mass(n); return { v, ...stopFrom(c, v, n) }; }
module.exports = { step, hostPen, mass, stopFrom };
if (require.main !== module) return;

console.log('=== Inertia (spec §6.1 model, 60 Hz) ===');
const old = (() => { const b = { vx: 470 }; let x = 0, t = 0; while (b.vx > 20) { b.vx *= 1 - 1.2 * DT; x += b.vx * DT; t++; } return { t: t / TICK, x }; })();
console.log(`  v0.5 reference (MOVE_DRAG 1.2, no brake) from 470: to < 20 px/s in ${fmt(old.t, 2)} s, ${fmt(old.x, 0)} px (never exactly 0)`);
console.log('  class | stop from max (t / px) | from AB | 0→90% max | 0→max | reversal: v=0 at / 90% back at / overshoot | 90° strafe: heading ≥80° at / 90% speed at / drift px | turn 180°');
for (const k of CLS) {
  const c = CLASSES[k];
  const s1 = stopFrom(c, c.max), s2 = stopFrom(c, c.abMax), r = reversal(c), st = strafe(c);
  console.log(`  ${SHORT[k]}  | ${fmt(s1.t, 2)} s / ${pad(fmt(s1.d, 0), 3)} px      | ${fmt(s2.t, 2)} s / ${pad(fmt(s2.d, 0), 3)} | ${fmt(accelTo(c, 0.9), 2)} s   | ${fmt(accelTo(c, 1), 2)} s | ${fmt(r.t0, 2)} s / ${fmt(r.t90, 2)} s / ${pad(fmt(r.overshoot, 0), 3)} px            | ${fmt(st.tHead, 2)} s / ${fmt(st.t90, 2)} s / ${pad(fmt(st.drift, 0), 3)} px                   | ${fmt(Math.PI / c.turn, 2)} s`);
}
console.log('  strain / brownout: effective top speed ×STRAIN_SPEED[L] × 0.7 in brownout (L3 + brownout = ×0.525):');
for (const k of CLS) { const c = CLASSES[k]; console.log(`   ${SHORT[k]}: L0 ${c.max}, L2 ${fmt(c.max * 0.9, 0)}, L3 ${fmt(c.max * 0.75, 0)}, brownout ${fmt(c.max * 0.7, 0)}, L3+brownout ${fmt(c.max * 0.525, 0)} px/s (drone 175 → 254 at H5; splitling 265 → 384; weaver 215 → 312)`); }
console.log('\n  capitals (host penalty max(0.5, 1−0.07n) on thrust & top speed; mass 1 + 0.25n divides thrust, drag, brake, knockback)');
for (const k of CLS) {
  const c = CLASSES[k];
  const rows = [1, 2, 3, 4, 5].map((n) => { const s = stopFrom(c, c.max * hostPen(n), n); const r = reversal(c, n); return `n${n}: stop ${fmt(s.t, 2)} s/${fmt(s.d, 0)} px, 0→max ${fmt(accelTo(c, 1, n), 2)} s, reverse ${fmt(r.t90, 2)} s (overshoot ${fmt(r.overshoot, 0)} px)`; });
  console.log(`   ${SHORT[k]} → ${['Dreadnought', 'Spire', 'Foundry'][CLS.indexOf(k)]}:`); for (const r of rows) console.log('      ' + r);
}
console.log('\n  knockback slide (impulse × knockTaken / mass, then coasting):');
for (const [src, imp] of [['brute contact', 520], ['splitter', 220], ['Polarize shell', 350], ['Hive/Matriarch', 700]]) {
  const row = CLS.map((k) => { const s = knockSlide(CLASSES[k], imp); return `${SHORT[k]} ${fmt(s.v, 0)} px/s → ${fmt(s.d, 0)} px in ${fmt(s.t, 2)} s`; }).join(' | ');
  const cap = knockSlide(CLASSES.brute, imp, 5);
  console.log(`   ${padr(src, 15)} ${imp}: ${row} | Dreadnought n5 ${fmt(cap.d, 0)} px`);
}
console.log('  v0.5 comparison: brute contact knockback 520 px/s with MOVE_DRAG 1.2 slid ≈ ' + fmt(520 / 1.2, 0) + ' px (asymptotic).');
module.exports = { step, hostPen, mass, stopFrom };
