// SYNTHESIS scratch model: the FINAL v1.0 music reducers (Heat & Redline + grafts). Not project code.
// node music.mjs            -> scenario table + exact test vectors
const UP5 = Number(process.env.UP5 ?? 0.80);
const ENEMY = Number(process.env.ENEMY ?? 0.05);
const K = {
  heat: { tau: 16, cap: 3, enemy: ENEMY, elite: 0.12, brute: 0.08, ship: 0.5, levelUp: 0.3, survive: 0.3, deathKeep: 0.5 },
  dens: { W0: 24 },
  drive: { wS: 0.4, wH: 0.45, wP: 0.35, levelFull: 15 },
  tier: { up: [0, 0.12, 0.28, 0.45, 0.62, UP5], hyst: 0.08, tauUp: 0.5, tauDown: 4, dwellUp: 1.5, dwellDown: 8, holdDown: 3, urgentSec: 2 },
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const HULL_TIER_BYTES = [217, 179, 128, 77, 38];
const fracByte = (f) => { const q = Math.round(f * 255); return q < 0 ? 0 : q > 255 ? 255 : q; };
const tierOfByte = (b) => { let t = 0; for (const B of HULL_TIER_BYTES) if (b < B) t++; return t; };
const hullDamageTier = (f) => tierOfByte(fracByte(f));

function heatStep(h, dt, add, mult = 1) {
  let raw = Math.min(K.heat.cap, h.raw * mult + add);
  raw *= Math.exp(-dt / K.heat.tau);
  return { raw, H: 1 - Math.exp(-raw) };
}
const density = (w) => 1 - Math.exp(-w / K.dens.W0);
function driveFor(S, H, level, C) {
  const P = clamp01((level - 1) / (K.drive.levelFull - 1));
  return clamp01((K.drive.wS * S + K.drive.wH * H) * (1 + K.drive.wP * P) + C);
}
// urgent: seconds left in an urgent window (a forcing event opened it): ds snaps up, up-dwell waived
function tierStep(s, D, dt, floor = 0, ceil = 5, urgentNow = false) {
  const T = K.tier;
  let urgent = urgentNow ? T.urgentSec : Math.max(0, (s.urgent ?? 0) - dt);
  const tau = D > s.ds ? T.tauUp : T.tauDown;
  const ds = urgent > 0 && D > s.ds ? D : s.ds + (D - s.ds) * (1 - Math.exp(-dt / tau));
  let since = s.since + dt, tier = s.tier;
  let below = ds < T.up[tier] - T.hyst ? (s.below ?? 0) + dt : 0;
  let up = 0; while (up < 5 && ds >= T.up[up + 1]) up++;
  up = Math.min(ceil, Math.max(up, floor));
  if (tier > ceil) { tier = ceil; since = 0; below = 0; }
  else if (up > tier && (since >= T.dwellUp || urgent > 0)) { tier = up; since = 0; below = 0; }
  else if (tier > floor && below >= T.holdDown && since >= T.dwellDown) { tier--; since = 0; below = 0; }
  return { ds, tier, since, below, urgent };
}
// danger: stage = max(0, tier-2); rise same frame; release after 1.0 s continuously with hull >= edge(stage)+0.03,
// then straight to the CURRENT target
const EDGE = [0, 0.5, 0.3, 0.15];
function dangerStep(d, hull, dt) {
  const target = Math.max(0, hullDamageTier(hull) - 2);
  if (target > d.stage) return { stage: target, lower: 0 };
  if (target < d.stage && hull >= EDGE[d.stage] + 0.03) {
    const lower = d.lower + dt;
    if (lower >= 1.0 - 1e-9) return { stage: target, lower: 0 };
    return { stage: d.stage, lower };
  }
  return { stage: d.stage, lower: 0 };
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const poisson = (rate, dt) => rnd() < rate * dt;

function run(name, secs, fn, quiet = false) {
  const dt = 1 / 60;
  let h = { raw: 0, H: 0 }, t = { ds: 0, tier: 0, since: 99 };
  let changes = 0, prev = 0; const firstAt = [0, -1, -1, -1, -1, -1], timeIn = [0, 0, 0, 0, 0, 0], log = [];
  for (let i = 0; i < secs * 60; i++) {
    const time = i * dt, f = fn(time, dt);
    h = heatStep(h, dt, f.add ?? 0, f.mult ?? 1);
    const D = driveFor(density(f.w), h.H, f.level ?? 1, f.C ?? 0);
    t = tierStep(t, D, dt, f.floor ?? 0, f.ceil ?? 5, !!f.urgent);
    if (t.tier !== prev) { changes++; prev = t.tier; if (firstAt[t.tier] < 0) firstAt[t.tier] = +time.toFixed(2); log.push(`${time.toFixed(1)}→T${t.tier}`); }
    timeIn[t.tier] += dt;
  }
  if (!quiet) {
    console.log(`\n[${name}] ${secs}s changes=${changes} (${(changes / (secs / 60)).toFixed(1)}/min) final T${t.tier} H=${h.H.toFixed(2)}`);
    console.log('  first:', firstAt.map((v, k) => `T${k}:${v}`).join(' '));
    console.log('  share:', timeIn.map((v, k) => `T${k} ${((100 * v) / secs).toFixed(0)}%`).join(' '));
    console.log('  log:', log.slice(0, 24).join(' '));
  }
  return { changes, timeIn, firstAt };
}
const E = K.heat.enemy, SHIP = K.heat.ship;
run('A early Warzone, 4-10 drones, L1', 120, () => ({ w: 4 + 6 * rnd(), level: 1 }));
run('B steady 1/s, W~20, L5, fire 70%', 180, (tm, dt) => ({ w: 20 * (0.7 + 0.6 * rnd()), level: 5, add: poisson(1, dt) ? E : 0, C: rnd() < 0.7 ? 0.12 : 0 }));
run('B2 1.5/s, W~25, L9, under fire', 180, (tm, dt) => ({ w: 25 * (0.7 + 0.6 * rnd()), level: 9, add: poisson(1.5, dt) ? E : 0, C: 0.12 }));
run('B3 1.5/s, W~25, L9, no fire', 180, (tm, dt) => ({ w: 25 * (0.7 + 0.6 * rnd()), level: 9, add: poisson(1.5, dt) ? E : 0 }));
run('B4 1.5/s, W~25, L5, under fire', 180, (tm, dt) => ({ w: 25 * (0.7 + 0.6 * rnd()), level: 5, add: poisson(1.5, dt) ? E : 0, C: 0.12 }));
run('C frantic 2.5/s, W~45, L12, fire', 120, (tm, dt) => ({ w: 45 * (0.7 + 0.6 * rnd()), level: 12, add: poisson(2.5, dt) ? E : 0, C: 0.12 }));
run('E peak 60 s then empty', 150, (tm, dt) => (tm < 60 ? { w: 45, level: 10, add: poisson(2.5, dt) ? E : 0, C: 0.12 } : { w: 0, level: 10 }));
run('F edge flicker', 300, () => ({ w: 50 * (0.6 + 0.8 * rnd()), level: 1, C: 0.1 }));
{ let hh = 1; run('H DM realistic', 300, (tm, dt) => { if (rnd() < dt / 4) hh = Math.max(0, Math.min(4, hh + (rnd() < 0.5 ? -1 : 1))); return { w: hh * 6 + hh * 0.8, level: 1 + tm / 30, add: poisson(1 / 25, dt) ? SHIP : 0, C: hh > 0 ? 0.12 : 0 }; }); }
// J: Arena 1v1 (the judge's flap case for HEAT): 8 s fights (hostile on screen, under fire, 1 takedown at the end) + 6 s lulls
run('J Arena 1v1 fights+lulls', 84, (tm, dt) => { const ph = tm % 14; const fight = ph < 8; const at = Math.abs(ph - 8) < dt / 2; return { w: fight ? 6 + 1.2 : 0, level: 1 + tm / 20, add: at ? SHIP : 0, C: fight ? 0.12 : 0 }; });
// K: 3v3 brawl (HEAT saturated here): 3 hostiles on screen, bullets, a team takedown by me every ~15 s
run('K 3v3 brawl', 120, (tm, dt) => ({ w: 3 * 6 + 6, level: 1 + tm / 20, add: poisson(1 / 15, dt) ? SHIP : 0, C: 0.12 }));
// L: urgent path: calm T1, a multi-takedown at 20 s (two ship takedowns 3 s apart; the 2nd is forcing) -> floor T3 12 s
{ const dt = 1 / 60; let h = { raw: 0, H: 0 }, t = { ds: 0, tier: 0, since: 99 }; const ch = []; let prev = 0;
  for (let i = 0; i < 60 * 40; i++) { const tm = i * dt; const a1 = Math.abs(tm - 17) < dt / 2, a2 = Math.abs(tm - 20) < dt / 2;
    h = heatStep(h, dt, a1 || a2 ? SHIP : 0); const D = driveFor(density(8), h.H, 3, 0.12);
    t = tierStep(t, D, dt, tm >= 20 && tm < 32 ? 3 : 0, 5, a2);
    if (t.tier !== prev) { ch.push(`${tm.toFixed(3)}→T${t.tier}`); prev = t.tier; } }
  console.log('\n[L urgent multiTakedown @20 s (1st @17)]', ch.join(' ')); }

// exact gate timings (60 fps)
{ const dt = 1 / 60; let t = { ds: 0, tier: 0, since: 99 }; const ch = [];
  for (let i = 1; i <= 300; i++) { const n = tierStep(t, 0.5, dt); if (n.tier !== t.tier) ch.push(`${(i * dt).toFixed(3)}s→T${n.tier}`); t = n; }
  for (let i = 1; i <= 1800; i++) { const n = tierStep(t, 0, dt); if (n.tier !== t.tier) ch.push(`+${(i * dt).toFixed(3)}s→T${n.tier}`); t = n; }
  console.log('\n[gate D=0.5 5 s then D=0]', ch.join(' '));
  t = { ds: 0, tier: 0, since: 99 }; let late = 0, prev = 0;
  for (let i = 1; i <= 7200; i++) { const D = Math.floor(i / 12) % 2 ? 0.5 : 0.4; t = tierStep(t, D, dt); if (t.tier !== prev) { if (i * dt > 10) late++; prev = t.tier; } }
  console.log('[flap 0.40/0.50 @0.2 s] changes after 10 s', late, 'tier', t.tier);
  // urgent from T1: D steps 0.2 -> 0.7 with a forcing event at t=5
  t = { ds: 0, tier: 0, since: 99 }; const u = [];
  for (let i = 1; i <= 600; i++) { const tm = i * dt; const n = tierStep(t, tm < 5 ? 0.2 : 0.7, dt, 0, 5, Math.abs(tm - 5) < dt / 2); if (n.tier !== t.tier) u.push(`${tm.toFixed(3)}→T${n.tier}`); t = n; }
  console.log('[urgent D 0.2→0.7 forcing @5 s]', u.join(' '));
  t = { ds: 0, tier: 0, since: 99 }; const nu = [];
  for (let i = 1; i <= 600; i++) { const tm = i * dt; const n = tierStep(t, tm < 5 ? 0.2 : 0.7, dt); if (n.tier !== t.tier) nu.push(`${tm.toFixed(3)}→T${n.tier}`); t = n; }
  console.log('[same, not urgent]', nu.join(' '));
}
// drive vectors
console.log('\n[drive] S(12)=', density(12).toFixed(6), 'D(S12,H0,L1)=', driveFor(density(12), 0, 1, 0).toFixed(6),
  'D(0,0,L15)=', driveFor(0, 0, 15, 0), 'D(1,0,L1)=', driveFor(1, 0, 1, 0), 'D(1,1,L15)=', driveFor(1, 1, 15, 0));
for (const r of [0.3, 1, 1.5, 2.5]) { const raw = Math.min(3, r * E * K.heat.tau); console.log(`  steady ${r}/s -> raw ${raw.toFixed(3)} H ${(1 - Math.exp(-raw)).toFixed(3)}`); }
// danger
{ const dt = 1 / 60; let d = { stage: 3, lower: 0 }; const seq = [];
  for (let i = 1; i <= 480; i++) { const tm = i * dt; const hull = Math.min(0.6, 0.12 + 0.12 * tm); const nd = dangerStep(d, hull, dt); if (nd.stage !== d.stage) seq.push(`${tm.toFixed(3)}s stage${nd.stage} (hull ${(hull * 100).toFixed(1)}%)`); d = nd; }
  console.log('\n[repair 12%→60% over 4 s]', seq.join(', '));
  d = { stage: 0, lower: 0 }; let flips = 0, prev = 0, after = 0, entered = -1;
  for (let i = 0; i < 3600; i++) { const tm = i / 60; const hull = tm < 10 ? 1 - tm * 0.072 : 0.3 + 0.025 * Math.sin(tm * 3.1) + 0.01 * (rnd() - 0.5);
    d = dangerStep(d, hull, dt); if (d.stage !== prev) { flips++; if (d.stage === 2 && entered < 0) entered = tm; else if (entered >= 0) after++; prev = d.stage; } }
  console.log('[wobble 30% ±2.5%]', 'changes', flips, 'after entering stage 2', after, 'final', d.stage);
  for (const hv of [0.51, 0.5, 0.4999, 0.3, 0.2999, 0.15, 0.149, 0.147, 0.1499]) console.log('   hull', hv, 'tier', hullDamageTier(hv), 'target', Math.max(0, hullDamageTier(hv) - 2));
}
let bad = 0; for (let b = 0; b <= 255; b++) if (hullDamageTier(b / 255) !== tierOfByte(b)) bad++;
for (let i = 0; i <= 100000; i++) { const f = i / 100000; if (hullDamageTier(fracByte(f) / 255) !== hullDamageTier(f)) bad++; }
console.log('\n[tier byte round-trip mismatches]', bad);
