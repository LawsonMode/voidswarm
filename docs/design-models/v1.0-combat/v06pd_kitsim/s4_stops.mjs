// S4. Space FULL STOP vs coasting (and vs counter-thrust) per class and for capitals, tick-accurate on CR movement.
import fs from 'node:fs';
import { CLASSES, CLS, SHORT, CAPNAME, DT, TICK, moveStep, capMass, hostPen, table, H, f0, f1, f2, flag, FLAGS } from './lib.mjs';
import { KIT_IDS, KIT_NAME, CLASS_OVERRIDE, STOP } from './kits.mjs';
const lines = []; const log = (s = '') => lines.push(s);
const cOf = (kit, cls) => ({ ...CLASSES[cls], ...(CLASS_OVERRIDE[kit][cls] || {}) });

/** mode: 'coast' | 'stop' | 'reverse' | 'stopBrownout'. Returns {t, d, energy}. Stop = |v| < 5 px/s. */
function stopFrom(kit, cls, v0, mode, n = 0) {
  const c = cOf(kit, cls), st = STOP[kit][cls], m = capMass(n), sm = hostPen(n);
  const b = { x: 0, y: 0, vx: v0, vy: 0 }; let k = 0, energy = 0;
  const sb = mode === 'stopBrownout' ? (kit === 'arcade' ? 0.5 * st.k : st.k) : st.k;
  while (Math.hypot(b.vx, b.vy) > 5 && k < 20 * TICK) {
    if (mode === 'reverse') moveStep(b, c, { dir: [-1, 0], m, sm });
    else moveStep(b, c, { stop: mode !== 'coast', stopBrake: sb, m, sm });
    if (b.vx < 0) { b.vx = 0; }
    if (mode === 'stop') energy += st.draw * DT;
    if (mode === 'reverse') energy += c.thr * DT;
    k++;
  }
  return { t: k / TICK, d: b.x, energy };
}
log(H('S4. FULL STOP (Space held, no direction) vs coast vs counter-thrust; time and distance to < 5 px/s'));
log('CR movement: coast |v| <- |v|(1 - drag/m dt) - brake/m dt; FULL STOP adds stopBrake/m; counter-thrust = reverse thrust + grip-scaled drag/brake. m = 1 + 0.25n, speed x max(0.5, 1 - 0.07n).');
const rows = [];
const claims = {
  hero: { brute: [0.50, 96], tech: [0.10, 18], engineer: [0.23, 47] },
  arcade: { brute: [0.77, 149], tech: [0.12, 20], engineer: [0.28, 58] },
  sortie: { brute: [0.53, 105], tech: [0.10, 20], engineer: [0.25, 50] },
};
for (const kit of KIT_IDS) for (const cls of CLS) {
  const c = cOf(kit, cls);
  const co = stopFrom(kit, cls, c.max, 'coast'), fs1 = stopFrom(kit, cls, c.max, 'stop'), rv = stopFrom(kit, cls, c.max, 'reverse');
  const fb = stopFrom(kit, cls, c.abMax, 'stop'), cb = stopFrom(kit, cls, c.abMax, 'coast'), bo = stopFrom(kit, cls, c.max, 'stopBrownout');
  const cl = claims[kit][cls];
  rows.push([KIT_NAME[kit], SHORT[cls], `${f2(co.t)} s / ${f0(co.d)} px`, `${f2(fs1.t)} s / ${f0(fs1.d)} px`, `${f1(co.t / fs1.t)}x`, `${f2(rv.t)} s / ${f0(rv.d)} px`,
    `${f2(cb.t)} / ${f2(fb.t)} s`, `${f2(bo.t)} s`, f0(fs1.energy), `${cl[0]} s / ${cl[1]} px ${Math.abs(fs1.t - cl[0]) <= 0.04 ? 'OK' : 'DIFF'}`]);
  if (rv.t < fs1.t - 0.02) flag(kit, 'MED', `FULL STOP slower than counter-thrust (${SHORT[cls]})`, `${KIT_NAME[kit]} ${SHORT[cls]}: FULL STOP ${f2(fs1.t)} s / ${f0(fs1.d)} px but reversing thrust stops in ${f2(rv.t)} s / ${f0(rv.d)} px: the new brake is a trap on this hull (raise stopDecel to >= thrust - brake).`);
}
log(table(['kit', 'class', 'coast from cruise', 'FULL STOP from cruise', 'faster', 'counter-thrust', 'from boost: coast / STOP', 'STOP in brownout', 'brake power', 'spec claim'], rows));

log('\nCapitals (host = the class; coast -> FULL STOP from the host\'s capped cruise speed):');
const cap = [];
for (const kit of KIT_IDS) for (const cls of CLS) {
  const row = [KIT_NAME[kit], CAPNAME[cls]];
  for (const n of [1, 3, 5]) {
    const c = cOf(kit, cls), v = c.max * hostPen(n);
    const a = stopFrom(kit, cls, v, 'coast', n), b = stopFrom(kit, cls, v, 'stop', n), r = stopFrom(kit, cls, v, 'reverse', n);
    row.push(`${f2(a.t)} s/${f0(a.d)} -> ${f2(b.t)} s/${f0(b.d)} (rev ${f2(r.t)})`);
  }
  cap.push(row);
}
log(table(['kit', 'capital', 'n=1', 'n=3', 'n=5'], cap));

log('\nShove (500 px/s x knock factor, / mass): slide while coasting vs while holding FULL STOP:');
const sh = [];
for (const kit of KIT_IDS) {
  const row = [KIT_NAME[kit]];
  for (const cls of CLS) { const c = cOf(kit, cls); const v = 500 * c.knock; const a = stopFrom(kit, cls, v, 'coast'), b = stopFrom(kit, cls, v, 'stop'); row.push(`${f0(a.d)} px -> ${f0(b.d)} px`); }
  const vd = 500 * 0.5 / capMass(5); const a = stopFrom(kit, 'brute', vd, 'coast', 5), b = stopFrom(kit, 'brute', vd, 'stop', 5); row.push(`${f0(a.d)} -> ${f0(b.d)} px`);
  sh.push(row);
}
log(table(['kit', 'Jugg', 'Arca', 'Arti', 'Dreadnought n5'], sh));

log('\nStop-and-pop cycle (cruise -> FULL STOP -> 0.5 s of fire -> back to 90% cruise), seconds; and a Laser Arcanist\'s effective uptime at range:');
const sp = [];
for (const kit of KIT_IDS) {
  const row = [KIT_NAME[kit]];
  for (const cls of CLS) {
    const c = cOf(kit, cls); const s1 = stopFrom(kit, cls, c.max, 'stop');
    const b = { x: 0, y: 0, vx: 0, vy: 0 }; let k = 0; while (b.vx < 0.9 * c.max && k < 10 * TICK) { moveStep(b, c, { dir: [1, 0] }); k++; }
    const cyc = s1.t + 0.5 + k / TICK; row.push(`${f2(cyc)} s (stop ${f2(s1.t)} + 0.5 + accel ${f2(k / TICK)})`);
  }
  sp.push(row);
}
log(table(['kit', 'Jugg', 'Arca', 'Arti'], sp));
log('\nNote (Sortie): Arcanist coast brake 1800 -> 1100 makes the Arcanist coast 0.33 s instead of 0.23 s, i.e. the change makes its no-input slide LONGER to give FULL STOP a job; the Arcanist\'s identity ("stops almost instantly") now requires holding Space (+1 load).');
flag('sortie', 'LOW', 'Arcanist coast brake nerf 1800 -> 1100', 'Coast 0.23 s -> 0.33 s; the Arcanist now pays +1 load (x0.85 regen, x1.25 surcharge) for its old free stop. Retune the CR movement tests (stop time +-2 ticks).');
{
  const h = stopFrom('hero', 'brute', 430, 'stop'); const hb = stopFrom('hero', 'brute', 0.01, 'stop');
  flag('all', 'LOW', 'Held brake counts as load even at v = 0', 'Hero/Arcade/Sortie all count Space-held FULL STOP in L; a parked pilot holding Space is strained (regen x0.85, surcharge x1.25) for no benefit. Count it only while |v| > 5 px/s.');
}
fs.writeFileSync(new URL('./s4_stops.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s4_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
