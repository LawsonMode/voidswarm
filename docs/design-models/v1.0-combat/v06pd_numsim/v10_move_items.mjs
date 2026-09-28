// Inertia (spec §9) + items (spec §11). Scratch only.
import { CLASSES, CLS, KIND, DT, makeShip, damageShip, stepPilot, pad, padr, f1, f2, f0, ARMOR_CAP, STRAIN_MOVE } from './v10_core.mjs';
import { writeFileSync } from 'node:fs';
const out = []; const P = (...a) => out.push(a.join(' '));
const MOVE_GRIP = 0.6, OVERSPEED = 1200;

function stats(clsId, n = 0) {
  const c = CLASSES[clsId];
  const pen = Math.max(0.5, 1 - 0.07 * n);
  return { drag: c.drag / (1 + 0.15 * n), mass: c.mass + 0.25 * n, thrust: c.thrust * pen, maxSpeed: c.maxSpeed * pen, abSpeed: c.abSpeed * pen, turnRate: c.turnRate };
}
function step(b, st, dir, ab, sm, ext = [0, 0]) {
  if (dir) {
    const a = st.thrust * sm * (ab ? 1.5 : 1);
    b.vx += dir[0] * a * DT; b.vy += dir[1] * a * DT;
    const vpar = b.vx * dir[0] + b.vy * dir[1];
    let px = b.vx - vpar * dir[0], py = b.vy - vpar * dir[1];
    const k = Math.max(0, 1 - st.drag * MOVE_GRIP * DT); px *= k; py *= k;
    b.vx = vpar * dir[0] + px; b.vy = vpar * dir[1] + py;
  } else { const k = Math.max(0, 1 - st.drag * DT); b.vx *= k; b.vy *= k; }
  b.vx += ext[0] * DT; b.vy += ext[1] * DT;
  const maxS = (ab ? st.abSpeed : st.maxSpeed) * sm, sp = Math.hypot(b.vx, b.vy);
  if (sp > maxS && sp > 0) { const tgt = Math.max(maxS, sp - OVERSPEED * DT); b.vx *= tgt / sp; b.vy *= tgt / sp; }
  b.x += b.vx * DT; b.y += b.vy * DT;
}
function measure(clsId, n = 0, sm = 1) {
  const st = stats(clsId, n);
  const r = {};
  // 0 -> 95% max
  let b = { x: 0, y: 0, vx: 0, vy: 0 }, t = 0;
  while (Math.hypot(b.vx, b.vy) < 0.95 * st.maxSpeed * sm && t < 20) { step(b, st, [1, 0], false, sm); t += DT; }
  r.accel = t;
  // coast from max to 20
  b = { x: 0, y: 0, vx: st.maxSpeed * sm, vy: 0 }; t = 0;
  while (b.vx > 20 && t < 60) { step(b, st, null, false, sm); t += DT; }
  r.coastT = t; r.coastD = b.x;
  b = { x: 0, y: 0, vx: st.maxSpeed * sm, vy: 0 }; t = 0;
  while (b.vx > 60 && t < 60) { step(b, st, null, false, sm); t += DT; }
  r.focusCoast = t;
  // counter-thrust brake to <20
  b = { x: 0, y: 0, vx: st.maxSpeed * sm, vy: 0 }; t = 0;
  while (b.vx > 20 && t < 60) { step(b, st, [-1, 0], false, sm); t += DT; }
  r.brakeT = t; r.brakeD = b.x;
  // 90° turn: moving +x at max, thrust +y; time until heading within 10° of +y; x drift
  b = { x: 0, y: 0, vx: st.maxSpeed * sm, vy: 0 }; t = 0;
  while (Math.abs(Math.atan2(b.vx, b.vy)) > 10 * Math.PI / 180 && t < 30) { step(b, st, [0, 1], false, sm); t += DT; }
  r.turn90T = t; r.turn90Drift = b.x;
  // reverse 180°: +max → −0.9 max
  b = { x: 0, y: 0, vx: st.maxSpeed * sm, vy: 0 }; t = 0;
  while (b.vx > -0.9 * st.maxSpeed * sm && t < 30) { step(b, st, [-1, 0], false, sm); t += DT; }
  r.revT = t; r.revOvershoot = Math.max(...[b.x]);
  // strafe dodge from rest: lateral displacement after 0.25 / 0.5 s
  b = { x: 0, y: 0, vx: 0, vy: 0 };
  for (let i = 0; i < 15; i++) step(b, st, [0, 1], false, sm); r.dodge25 = b.y;
  for (let i = 0; i < 15; i++) step(b, st, [0, 1], false, sm); r.dodge50 = b.y;
  // dodge while cruising +x at max: lateral y after 0.5 s
  b = { x: 0, y: 0, vx: st.maxSpeed * sm, vy: 0 };
  for (let i = 0; i < 30; i++) step(b, st, [0, 1], false, sm); r.cruiseDodge50 = b.y;
  // knock 500/mass slide (coasting)
  b = { x: 0, y: 0, vx: 500 / st.mass, vy: 0 }; t = 0;
  while (b.vx > 20 && t < 60) { step(b, st, null, false, sm); t += DT; }
  r.knockD = b.x;
  r.turn180 = Math.PI / st.turnRate;
  r.st = st;
  return r;
}
P('=== K. Inertia (60 Hz linear drag form, MOVE_GRIP 0.6) ===');
P('  hull          drag  mass | 0→95%max | coast→20: t   dist | coast→60 (Focus) | brake(counter) t dist | 90° turn: t  drift | reverse 180: t | dodge 0.25/0.5 s rest | dodge 0.5 s cruising | 500 knock slide | aim 180° t');
for (const a of CLS) for (const n of [0, 1, 3, 5]) {
  const r = measure(a, n);
  const lbl = n === 0 ? CLASSES[a].name : `${({ brute: 'Dreadnought', tech: 'Spire', engineer: 'Foundry' })[a]} n=${n}`;
  P(`  ${padr(lbl, 14)} ${pad(r.st.drag.toFixed(2), 4)} ${pad(r.st.mass.toFixed(2), 5)} | ${pad(f2(r.accel), 5)} s  | ${pad(f2(r.coastT), 5)} s ${pad(f0(r.coastD), 5)} px | ${pad(f2(r.focusCoast), 5)} s         | ${pad(f2(r.brakeT), 5)} s ${pad(f0(r.brakeD), 4)} px     | ${pad(f2(r.turn90T), 5)} s ${pad(f0(r.turn90Drift), 4)} px | ${pad(f2(r.revT), 5)} s        | ${pad(f0(r.dodge25), 3)} / ${pad(f0(r.dodge50), 3)} px          | ${pad(f0(r.cruiseDodge50), 4)} px            | ${pad(f0(r.knockD), 4)} px         | ${f2(r.turn180)} s`);
}
P('  Under Strain 3 (speedMult 0.72) and Brownout+Strain 3 (0.576):');
for (const a of CLS) for (const sm of [0.72, 0.576]) {
  const r = measure(a, 0, sm);
  P(`  ${padr(CLASSES[a].short + ' ×' + sm, 12)} 0→95% ${f2(r.accel)} s | dodge 0.5 s ${f0(r.dodge50)} px | 90° turn ${f2(r.turn90T)} s drift ${f0(r.turn90Drift)} px | brake ${f2(r.brakeT)} s`);
}
P('  Mass Driver knock stream: 25 px/s per slug ÷ mass × 13.3 slugs/s = accel ' + CLS.map((a) => `${CLASSES[a].short} ${f0(25 * 13.33 / CLASSES[a].mass)} px/s² → coasting terminal drift ${f0(25 * 13.33 / CLASSES[a].mass / CLASSES[a].drag)} px/s`).join('; '));
{
  // distance a coasting Juggernaut target is pushed during a 3 s MD stream
  for (const a of CLS) {
    const st = stats(a); const b = { x: 0, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 180; i++) step(b, st, null, false, 1, [25 * 13.33 / st.mass, 0]);
    P(`    ${CLASSES[a].short} coasting under a 3 s point-blank MD stream is pushed ${f0(b.x)} px (MD full damage only ≤160 px, bleed 0 by 560 px)`);
  }
}
P('');

// ------------------------------------------------------------------ items
P('=== L. Items ===');
function hitsToKill(def, dmg, kind, absorb = 0) {
  const s = makeShip(def); s.absorb = absorb; let n = 0, brk = 0;
  while (s.integrity > 0 && n < 50) { const r = damageShip(s, dmg, { kind }); n++; if (r.broke) brk = n; }
  return { n, brk };
}
P('  Bomb PvP (480 kinetic direct, r 170, falloff to 40% at edge; Juggernaut thrower +15%):');
for (const def of CLS) {
  const cells = [480, 480 * 0.7, 480 * 0.4, 552].map((d) => { const r = hitsToKill(def, d, 'kinetic'); return `${f0(d)}: break@${r.brk} kill@${r.n}`; });
  P(`    vs ${padr(CLASSES[def].short, 5)} ` + cells.join(' | '));
}
P('    3 charges, cd 1.0 s: a full stack (3 direct) = 1440 raw → Arcanist EHP vs kinetic 1071 → an Arcanist dies to 3 direct bombs in ~2.0 s (+flight). Arena spawns everyone with 1.');
P('  Bomb PvE (760, r 200, falloff to 40%): kill radius vs drone HP 160×(1+0.06L)×partyHp:');
for (const [L, n] of [[0, 1], [0, 6], [6.2, 4], [13.7, 6], [19, 6]]) {
  const ph = n <= 4 ? 1 + 0.25 * (n - 1) : 1.75 + 0.15 * (n - 4);
  const hp = 160 * (1 + 0.06 * L) * ph;
  const f = hp / 760; // need 1 − 0.6 d/200 ≥ f
  const dmax = f <= 0.4 ? 200 : Math.max(0, (1 - f) / 0.6 * 200);
  P(`    L ${pad(L, 4)} n=${n}: drone hp ${f0(hp)} → killed within ${f0(dmax)} px (area ${f0(Math.PI * dmax * dmax / 1000)}k px²); elite drone ${f0(hp * 3)} hp → ${f0(hp * 3 / 760 <= 0.4 ? 200 : Math.max(0, (1 - hp * 3 / 760) / 0.6 * 200))} px; brute ${f0(2400 * (1 + 0.06 * L) * ph)} hp → ${f0(760 * 100 / (2400 * (1 + 0.06 * L) * ph))}% of hp`);
}
P('');
P('  EMP (r 340): shield disrupted 60% (polarized ×0.5 → 30%, capital ×0.6 → 36%), power −35%, EMP\'d 2.5 s (capital 1.5 s) = no shield/power regen.');
for (const def of CLS) {
  const c = CLASSES[def];
  const sh = 0.6 * c.maxShield, pw = 0.35 * c.maxPower;
  // follow-up: time for each weapon at 100% to break remaining 40% shield
  const rem = 0.4 * c.maxShield;
  const md = rem / (587 * 1.15 * 0.85 * (1 - 0.18 * (def === 'brute' ? 0.5 : 1))), lz = rem / (460 * 1.2 * (def === 'tech' ? 0.8 : 1)), ph = rem / (424 * 2.5);
  const fullMd = c.maxShield / (587 * 1.15 * 0.85 * (1 - 0.18 * (def === 'brute' ? 0.5 : 1))), fullLz = c.maxShield / (460 * 1.2 * (def === 'tech' ? 0.8 : 1)), fullPh = c.maxShield / (424 * 2.5);
  P(`    vs ${padr(c.short, 5)}: −${f0(sh)} shield, −${f0(pw)} power. Remaining shield breaks in MD ${f2(md)} s (vs ${f2(fullMd)} full) | Laser ${f2(lz)} (${f2(fullLz)}) | Phaser ${f2(ph)} (${f2(fullPh)}); regen blocked 2.5 s ≈ ${f0(2.5 * c.shieldRegen)} regen denied`);
}
P('    PvE: 200 ion (enemies raw → 200; ×2.5 vs wards = 500) + stun 1.8 s in r 340 (area 363k px²): a whole floor-1 pulse (10–33 bodies) is stunned; drones at L 0 (160 hp) survive (200 < 160? no: 200 ≥ 160 → killed at n=1; n=6 hp 328 → survive).');
P('');
P('  Ion Storm (r 230, 6 s, strike every 0.4 s: 5 ships × 60 ion, 10 enemies × 130 ion; ships inside: speed ×0.75, shield regen blocked):');
for (const def of CLS) {
  const s = makeShip(def); let t = 0, brk = -1; const perStrike = 60;
  for (let i = 1; i <= 15; i++) { const r = damageShip(s, perStrike, { kind: 'ion' }); if (r.broke && brk < 0) brk = i * 0.4; if (s.integrity <= 0) { t = i * 0.4; break; } }
  const escape = 230 / (CLASSES[def].maxSpeed * 0.75);
  P(`    ${padr(CLASSES[def].short, 5)} standing in it 6 s: shield breaks at ${f1(brk)} s (375 shield/s), hull left ${f0(Math.max(0, s.integrity))}/${CLASSES[def].maxIntegrity}${t ? ' — DOWN at ' + f1(t) + ' s' : ''}; escape from center at ×0.75 speed ≈ ${f2(escape)} s (≈ ${f0(escape / 0.4 * 60 * 2.5)} shield lost)`);
}
P('    PvE: 10 enemies × 130 per 0.4 s = 3250 dps area, 19.5k total per storm; drones (160–330 hp) die in 2–3 strikes → up to ~150 swarm bodies per storm if density allows.');
P('');
P('  Singularity Drive (5 s, r 650 / Void 845 / capital ×1.25; owner anchored at speedMult 0.18):');
{
  // enemy approach: drone speed v toward owner + pull a(d) = 1600 sqrt(1 − d/R) + 300 (inside R); kill at horizon 60 + owner radius
  for (const [L, R] of [[0, 650], [13.7, 650], [0, 845]]) {
    const v0 = 175 * Math.min(1.4, 1 + 0.03 * L);
    const cells = [];
    for (const d0 of [300, 650, 900, 1200]) {
      let d = d0, v = v0, t = 0;
      while (d > 82 && t < 10) { const a = d < R ? 1600 * Math.sqrt(Math.max(0, 1 - d / R)) + 300 : 0; v = Math.max(v, v0) + a * DT; d -= v * DT; t += DT; }
      cells.push(`${d0}px→${f2(t)}s`);
    }
    P(`    drone (${f0(v0)} px/s, L ${L}) reaches the horizon, R ${R}: ${cells.join('  ')}`);
  }
  P('    ⇒ every kamikaze starting within ~1150 px dies at the horizon inside the 5 s (full XP/kit rolls); bosses immune; brutes pulled ×0.3.');
  P('    Projectile absorption: +12 shield per hostile projectile destroyed → a Mass Driver stream (13.3/s) feeds the owner +160 shield/s, Phaser +71/s, rockets +12 each.');
  P('    vs ships: pull 520/mass → Arca 650, Arti 473, Jugg 260 px/s² vs thrust (and multipliers):');
  for (const def of CLS) {
    const c = CLASSES[def], pull = 520 / c.mass;
    const cells = [[1, 'free'], [0.72, 'strain3'], [0.576, 'strain3+BO'], [0.75, 'storm'], [0.72 * 0.75, 'strain3+storm'], [0.576 * 0.75, 'S3+BO+storm']].map(([m, n]) => `${n} ${f0(c.thrust * m - pull)}`);
    P(`      ${padr(c.short, 5)} net escape accel px/s²: ${cells.join(' | ')}`);
  }
  P('    crush inside horizon: 160 ion dps → 400 shield/s then 96 hull/s ×(1−armor): Arcanist 600 shield in 1.5 s + 420 hull in 4.4 s; collapse 300 energy.');
}

writeFileSync(new URL('./v10_move_items.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
