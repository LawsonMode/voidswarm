// SCRATCH (not project code): tables for the v1.0 synthesized spec. node tables.mjs
import { CLASSES, CLS, moveStep, capMass, hostPen, DT, LOAD_SURCHARGE, STRAIN_REGEN } from '../v06pd_kitsim/lib.mjs';
const STOP = { brute: 620, tech: 2600, engineer: 1100 };
const f2 = (x) => x.toFixed(2), f0 = (x) => Math.round(x);
function stopFrom(c, v0, o) {
  const b = { x: 0, y: 0, vx: v0, vy: 0 }; let t = 0;
  while (Math.hypot(b.vx, b.vy) > 1 && t < 30) { moveStep(b, c, o); t += DT; }
  return [t, b.x];
}
function counter(c, v0, o) {
  const b = { x: 0, y: 0, vx: v0, vy: 0 }; let t = 0;
  while (b.vx > 0 && t < 30) { moveStep(b, c, { ...o, dir: [-1, 0] }); t += DT; }
  return [t, b.x];
}
console.log('== A) stops (from max speed; to < 1 px/s). coast | FULL STOP | counter-thrust | x faster');
for (const k of CLS) {
  const c = CLASSES[k];
  for (let n = 0; n <= 5; n++) {
    const m = capMass(n), sm = n ? hostPen(n) : 1, v0 = c.max * sm;
    const o = { m, sm };
    const [tc, dc] = stopFrom(c, v0, o);
    const [ts, ds] = stopFrom(c, v0, { ...o, stop: true, stopBrake: STOP[k] });
    const [tr, dr] = counter(c, v0, o);
    const vb = c.abMax * sm;
    const [tcb, dcb] = stopFrom(c, vb, o);
    const [tsb, dsb] = stopFrom(c, vb, { ...o, stop: true, stopBrake: STOP[k] });
    console.log(`${k} n${n} v${f0(v0)}: coast ${f2(tc)}s/${f0(dc)} | STOP ${f2(ts)}s/${f0(ds)} | counter ${f2(tr)}s/${f0(dr)} | x${(tc / ts).toFixed(1)} | fromBoost v${f0(vb)} coast ${f2(tcb)}/${f0(dcb)} stop ${f2(tsb)}/${f0(dsb)} ${ts < tr ? 'OK' : 'SLOWER'}`);
  }
}
console.log('\n== accel 0 -> 90% max, cruise -> boost cap');
for (const k of CLS) {
  const c = CLASSES[k]; const b = { x: 0, y: 0, vx: 0, vy: 0 }; let t = 0;
  while (b.vx < 0.9 * c.max) { moveStep(b, c, { dir: [1, 0] }); t += DT; }
  while (b.vx < c.max - 1) { moveStep(b, c, { dir: [1, 0] }); }
  let t2 = 0; while (b.vx < c.abMax - 1 && t2 < 5) { moveStep(b, c, { dir: [1, 0], boost: true }); t2 += DT; }
  console.log(k, f2(t), f2(t2));
}

const WD = { brute: { md: 180, lz: 165, ph: 112 }, tech: { md: 180, lz: 150, ph: 112 }, engineer: { md: 176, lz: 128, ph: 109 } };
const RMB = { brute: 170 / 1.4, tech: 150 / 1.1, engineer: 200 / 3 };
const E = { brute: 200, tech: 22, engineer: 200 };
const DEF = { brute: 'md', tech: 'lz', engineer: 'ph' };
console.log('\n== B) net power/s (shield full, thrusting, default weapon)');
for (const k of CLS) {
  const c = CLASSES[k], w = WD[k][DEF[k]];
  const combos = [
    ['LMB', 1, w], ['LMB+RMB', 2, w + RMB[k]], ['LMB+E stance', k === 'tech' ? 1 : 2, w + E[k]],
    ['LMB+RMB+boost', 3, w + RMB[k] + c.ab], ['LMB+RMB+brake(moving)', 3, w + RMB[k] + ({ brute: 90, tech: 30, engineer: 50 })[k]],
    ['boost only', 1, c.ab], ['LMB+RMB+E stance', 3, w + RMB[k] + E[k]],
  ];
  for (const [name, L, d] of combos) {
    const regen = name.includes('boost') ? 0 : c.R * STRAIN_REGEN[L];
    const net = regen - LOAD_SURCHARGE[L] * (d + c.thr);
    console.log(`${k} ${name.padEnd(24)} L${L} net ${f0(net)}/s ${net < 0 ? 'empty ' + (c.P / -net).toFixed(1) + ' s' : 'sustained'}`);
  }
  for (const wid of ['md', 'lz', 'ph']) {
    const a = c.R - (WD[k][wid] + c.thr); const b2 = c.R * 0.85 - 1.25 * (WD[k][wid] + RMB[k] + c.thr);
    console.log(`   ${k} ${wid}: LMB ${f0(a)}  LMB+RMB ${f0(b2)}`);
  }
}
console.log('\n== C) shield back to full after a break (s): parked idle | L0 thrusting | L1 firing | L2 firing | L3 firing');
for (const k of CLS) {
  const c = CLASSES[k];
  const r = (m) => (c.sb + c.S / (c.Sr * m)).toFixed(1);
  console.log(k, r(1.6 * 1.25), r(1.6), r(1 * 0.5), r(0.5 * 0.5), r(0.15 * 0.5));
}
console.log('\n== D) reactor tiers');
for (let t = 0; t <= 5; t++) { const cm = 1 - 0.06 * t, rm = 1 - 0.07 * t; console.log(t, f2(cm), f2(rm), CLS.map((k) => `${f0(CLASSES[k].P * cm)}@${f0(CLASSES[k].R * rm)}`).join('  ')); }
for (const k of CLS) { const c = CLASSES[k]; const net = c.R * 0.65 - (WD[k][DEF[k]] + c.thr); console.log('tier5', k, 'LMB net', f0(net), net < 0 ? `burst ${(c.P * 0.7 / -net).toFixed(0)} s` : 'sustained'); }
for (const k of CLS) { const c = CLASSES[k]; const net = c.R * 0.65 * 0.85 - 1.25 * (WD[k][DEF[k]] + RMB[k] + c.thr); console.log('tier5', k, 'LMB+RMB net', f0(net), net < 0 ? `empty ${(c.P * 0.7 / -net).toFixed(1)} s` : 'sustained'); }

console.log('\n== E) heat H');
const Hof = (f, m, rooms = 0, D = 1, cap = 5) => { const Ef = f <= 2 ? 1.5 : 1; const raw = 1.3 + 0.15 * (f - 1) + D * Ef * (0.30 * m + 0.02 * m * m) + 0.05 * rooms; const s = raw <= 4 ? raw : 4 + (raw - 4) * 0.5; return Math.min(cap, s); };
const mins = [0, 1, 2, 3, 4, 5, 6, 8];
console.log('floor | ' + mins.map((m) => 'm' + m).join('  '));
for (const f of [1, 2, 3, 4, 5, 6]) console.log('f' + f + ' | ' + mins.map((m) => f2(Hof(f, m))).join(' '));
console.log('Story f1 | f6:', mins.map((m) => f2(Hof(1, m, 0, 0.7, 4))).join(' '), '|', mins.map((m) => f2(Hof(6, m, 0, 0.7, 4))).join(' '));
console.log('Nightmare f1 | f6:', mins.map((m) => f2(Hof(1, m, 0, 1.35, 6))).join(' '), '|', mins.map((m) => f2(Hof(6, m, 0, 1.35, 6))).join(' '));
const partyCount = (n) => 1 + 0.2 * (n - 1), partyHp = (n) => 1 + 0.15 * (n - 1);
const pulses = (f) => (f >= 5 ? 4 : 3);
const tierOf = (f) => 1 + 2 * (f - 1), tierHp = (t) => 1 + 0.08 * (t - 1);
const DIFF = { S: { count: 0.8, D: 0.7, cap: 4 }, V: { count: 1, D: 1, cap: 5 }, N: { count: 1.25, D: 1.35, cap: 6 } };
console.log('\n== F) pulse budget n6 m3 2 rooms; x1.10 ult allowance');
for (const [dn, d] of Object.entries(DIFF)) {
  const row = [1, 2, 3, 4, 5, 6].map((f) => { const H = Hof(f, 3, 2, d.D, d.cap), h = H - 1; const base = (8 + 2 * f) * partyCount(6) * d.count * (1 + 0.35 * h) * 1.10; const P = pulses(f); return `f${f} H${f2(H)} ${f0(base)}->${f0(base * (1 + 0.15 * (P - 1)))}`; });
  console.log(dn, row.join(' | '));
}
for (const n of [1, 4, 6]) {
  const row = [1, 3, 6].map((f) => { const H = Hof(f, 3, 2), h = H - 1; const base = (8 + 2 * f) * partyCount(n) * (1 + 0.35 * h) * 1.10; return `f${f} ${f0(base)}`; });
  console.log('Veteran n' + n, row.join(' | '));
}
console.log('v0.5 n4 f1 Veteran pulse', f0(10 * (1 + 0.3 * 3)), 'n6', f0(10 * (1 + 0.3 * 5)));
console.log('\n== G) enemy HP multiplier');
for (const f of [1, 2, 3, 4, 5, 6]) { const H = Hof(f, 3, 2), h = H - 1; console.log('f' + f, 'tier', tierOf(f), f2(tierHp(tierOf(f))), 'x party6', f2(partyHp(6)), 'x heat', f2(1 + 0.15 * h), '=', f2(tierHp(tierOf(f)) * partyHp(6) * (1 + 0.15 * h)), ' v0.5 n6:', f2((1 + 0.12 * (tierOf(f) - 1)) * (1 + 0.25 * 5))); }
console.log('\n== H) heat effects');
for (const H of [1, 1.5, 2, 3, 4, 5]) { const h = H - 1; console.log(`H${H}: budget x${f2(1 + 0.35 * h)} hp x${f2(1 + 0.15 * h)} speed x${f2(Math.min(1.45, 1 + 0.10 * h))} dmg x${f2(Math.min(1.8, 1 + 0.15 * h))} fire x${f2(Math.min(1.6, 1 + 0.12 * h))} elite ${(Math.min(20, 5 + 2.5 * h)).toFixed(1)}% next@${f0(Math.min(55, 30 + 8 * h))}% gap ${f2(Math.max(1.5, 3 / (1 + 0.25 * h)))}-${f2(Math.max(6, 14 / (1 + 0.25 * h)))} trickle ${H >= 1.5 ? Math.round(2 + 1.2 * h) + ' / ' + f2(Math.max(5, 16 / (1 + 0.4 * h))) + 's' : '-'} kit x${f2(1 + 0.15 * h)} xp x${f2(1 + 0.2 * h)}`); }
console.log('\n== I) lives');
for (const n of [1, 2, 3, 4, 5, 6]) { const l = (adj) => Math.min(16, Math.max(2, 2 + 2 * n + adj + (n === 1 ? 2 : 0))); console.log('n' + n, l(2), l(0), l(-2)); }
console.log('\n== J) pip wells');
for (const k of CLS) for (const n of [0, 1, 3, 5]) { const c = CLASSES[k]; const R = 240 * Math.sqrt(c.r / 18) * (1 + 0.12 * n), Ra = 190 * Math.sqrt(c.r / 18) * (1 + 0.12 * n); const rr = c.r * (n ? 1.2 + 0.07 * n : 1); console.log(k, 'n' + n, 'R', f0(R), 'arena', f0(Ra), 'capture', f0(rr + 60), 'collect', f0(rr + 10), 'A', f0(1900 * Math.sqrt(capMass(n)))); }
for (let L = 1; L <= 5; L++) console.log('magnet L' + L, 'R x', f2(1 + 0.2 * L), 'A x', f2(1 + 0.25 * L), 'pad', 60 + 4 * L, 'Artificer R', f0(240 * (1 + 0.2 * L)));
