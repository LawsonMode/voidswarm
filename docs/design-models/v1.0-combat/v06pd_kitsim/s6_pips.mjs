// S6. XP pip gravity: collection rate of each kit's two-zone well vs today's 120 px magnet snap (live pve/gems.ts), with and
// without Magnet L5 / Tractor Field / Vacuum. Tick-accurate, deterministic (id parity handedness), 4-tick staggered rebinding.
import fs from 'node:fs';
import { DT, TICK, rng, table, H, f0, f1, f2, pct, flag, FLAGS, capMass } from './lib.mjs';
import { GRAV } from './kits.mjs';
const lines = []; const log = (s = '') => lines.push(s);

/** Well parameters for a ship under a model + modifiers {magnet: lv, tractor, arena, n (turrets)}. */
function well(model, ship, mod = {}) {
  const lv = mod.magnet ?? 0, n = mod.n ?? 0, s = ship.r / 18;
  if (model === 'current') return { kind: 'snap', snap: 120 * (1 + 0.35 * lv), keep: 1.6 };
  if (model === 'hero') {
    const g = GRAV.hero, tr = mod.tractor ? g.tractor : { capture: 1, well: 1, accel: 1 };
    return { kind: 'hero', C: g.capture * (1 + g.magnetLv.capture * lv) * Math.sqrt(s) * tr.capture, R: g.well * (1 + g.magnetLv.well * lv) * Math.sqrt(s) * tr.well,
      A: g.accel * (1 + g.magnetLv.accel * lv) * s * capMass(n) * tr.accel, keep: g.keep };
  }
  if (model === 'arcade') {
    const g = GRAV.arcade, trP = mod.tractor ? (mod.arena ? g.tractorArena : g.tractor) : { well: 1, accel: 1 };
    const R0 = mod.arena ? g.wellArena : g.well, A0 = mod.arena ? g.accelArena : g.accel;
    return { kind: 'arcade', R: Math.min(900, R0 * (1 + g.magnetLv.well * lv) * (1 + 0.12 * n) * trP.well), A: A0 * (1 + g.magnetLv.accel * lv) * capMass(n) * trP.accel, Rc: ship.r + g.capturePad + g.magnetLv.capturePx * lv };
  }
  const g = GRAV.sortie, pull = mod.tractor ? g.tractorField.pull : 1;
  const Rg = Math.min(g.maxRadius, (mod.arena ? g.arenaBase : g.pveBase) * Math.sqrt(s) * (1 + g.magnetLv.radius * lv) * pull);
  return { kind: 'sortie', capture: (ship.r + g.capturePad * (1 + g.magnetLv.capture * lv)) * (mod.tractor ? 2 : 1), Rg, A: g.aCore * Math.sqrt(capMass(n)) * (1 + g.magnetLv.accel * lv) * pull, collect: ship.r + g.collectPad };
}
/** Today's snap homing (gems.ts). Returns true when collected. */
function snapStep(p, ship, dt) {
  const dx = ship.x - p.x, dy = ship.y - p.y, d = Math.hypot(dx, dy) || 1;
  if (d <= ship.r + 10) return true;
  const want = Math.max(520, Math.hypot(ship.vx, ship.vy) + 350), k = Math.min(1, 9 * dt);
  p.vx += (dx / d * want - p.vx) * k; p.vy += (dy / d * want - p.vy) * k;
  if (Math.hypot(p.vx, p.vy) * dt >= d) return true;
  p.x += p.vx * dt; p.y += p.vy * dt; return false;
}
/** One pip tick. Returns true when collected. */
function pipStep(model, p, ship, w, t, dt, vac) {
  const dx = ship.x - p.x, dy = ship.y - p.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  if (vac) {
    if (model === 'hero') { p.vx += ux * 2500 * dt; p.vy += uy * 2500 * dt; if (d <= ship.r + 10 || Math.hypot(p.vx, p.vy) * dt >= d) return true; p.x += p.vx * dt; p.y += p.vy * dt; return false; }
    const sp = model === 'arcade' ? 1800 : Math.max(1400, Math.hypot(ship.vx, ship.vy) + 350);
    if (sp * dt >= d || d <= ship.r + 10) return true; p.x += ux * sp * dt; p.y += uy * sp * dt; p.vx = ux * sp; p.vy = uy * sp; return false;
  }
  if (w.kind === 'snap') return snapStep(p, ship, dt);
  if (w.kind === 'hero') {
    if (d <= w.C) return snapStep(p, ship, dt);
    const a = w.A * (0.25 + 0.75 * (1 - Math.min(1, d / w.R)) ** 2);
    const sw = 0.6 * a * Math.max(0, 1 - (t - p.bound) / 3) * p.hand;
    let rvx = p.vx - ship.vx, rvy = p.vy - ship.vy;
    rvx += (ux * a + -uy * sw) * dt; rvy += (uy * a + ux * sw) * dt;
    const k = Math.max(0, 1 - 2.0 * dt); rvx *= k; rvy *= k;
    const rs = Math.hypot(rvx, rvy); if (rs > 1100) { rvx *= 1100 / rs; rvy *= 1100 / rs; }
    p.vx = ship.vx + rvx; p.vy = ship.vy + rvy; p.x += p.vx * dt; p.y += p.vy * dt;
    return Math.hypot(ship.x - p.x, ship.y - p.y) <= ship.r + 10;
  }
  if (w.kind === 'arcade') {
    // kinematic spiral in the owner's frame
    if (d <= w.Rc) return true;
    const ar = w.A * (0.35 + 0.65 * (1 - Math.min(1, d / w.R)));
    const vcap = Math.max(650, Math.hypot(ship.vx, ship.vy) + 380);
    p.vr = Math.min(vcap, Math.max(p.vr ?? 0, 60) + ar * dt);
    p.vt = (p.vt ?? 0) + (1.2 * p.vr * p.hand - (p.vt ?? 0)) * Math.min(1, 8 * dt);
    if (p.vr * dt >= d - w.Rc) return true;
    // move: radial inward vr, tangential vt, plus the ship's own motion (pip lives in the owner's frame)
    p.x += (ux * p.vr + -uy * p.vt) * dt + ship.vx * dt; p.y += (uy * p.vr + ux * p.vt) * dt + ship.vy * dt;
    p.vx = ship.vx + ux * p.vr - uy * p.vt; p.vy = ship.vy + uy * p.vr + ux * p.vt;
    return false;
  }
  // sortie
  if (d <= w.collect) return true;
  if (d <= w.capture) return snapStep(p, ship, dt);
  const u = Math.max(0, Math.min(1, (d - w.capture) / (w.Rg - w.capture)));
  const a = w.A * (1 - u) + 320, own = t - p.bound;
  let rvx = p.vx - ship.vx, rvy = p.vy - ship.vy;
  const rr = rvx * ux + rvy * uy, tx = -uy, ty = ux, rt = rvx * tx + rvy * ty;
  const side = Math.abs(rt) > 1 ? Math.sign(rt) : p.hand;
  const sw = 1.1 * a * Math.max(0, 1 - own / 1.1) * side;
  let nrr = rr + a * dt, nrt = rt + sw * dt;
  nrt *= Math.max(0, 1 - (2 + 4 * own) * dt);
  rvx = ux * nrr + tx * nrt; rvy = uy * nrr + ty * nrt;
  const rs = Math.hypot(rvx, rvy); if (rs > 700) { rvx *= 700 / rs; rvy *= 700 / rs; }
  p.vx = ship.vx + rvx; p.vy = ship.vy + rvy; p.x += p.vx * dt; p.y += p.vy * dt;
  return Math.hypot(ship.x - p.x, ship.y - p.y) <= w.collect;
}
/** Is the pip inside the ship's pull (bindable)? */
function inReach(model, p, ship, w, bound) {
  const d = Math.hypot(ship.x - p.x, ship.y - p.y);
  if (w.kind === 'snap') return d <= w.snap * (bound ? w.keep : 1);
  if (w.kind === 'hero') return d <= w.R * (bound ? w.keep : 1);
  if (w.kind === 'arcade') return d <= w.R;
  return d <= w.Rg;
}
/**
 * Run pips against one ship. ship {x,y,vx,vy,r} moves at constant velocity. opts {sec, vacuumAt}. Returns per-pip collect time (or -1) + swept angle.
 */
function run(model, ship0, pips0, mod = {}, opts = {}) {
  const ship = { ...ship0 }, w = well(model, ship, mod);
  const pips = pips0.map((q, i) => ({ ...q, vx: q.vx ?? 0, vy: q.vy ?? 0, id: i, hand: (i & 1) ? 1 : -1, owned: false, bound: 0, done: -1, a0: Math.atan2(q.y - ship.y, q.x - ship.x), sweep: 0, last: Math.atan2(q.y - ship.y, q.x - ship.x), vac: false }));
  const sec = opts.sec ?? 3;
  for (let k = 0; k < sec * TICK; k++) {
    const t = k * DT;
    ship.x += ship.vx * DT; ship.y += ship.vy * DT;
    for (const p of pips) {
      if (p.done >= 0) continue;
      if (opts.vacuumAt != null && t >= opts.vacuumAt && !p.vac && Math.hypot(ship.x - p.x, ship.y - p.y) <= (model === 'hero' ? GRAV.hero.vacuum.radius : model === 'arcade' ? GRAV.arcade.vacuum.radius : GRAV.sortie.vacuum.radius)) { p.vac = true; p.owned = true; }
      if ((k + p.id) % 4 === 0 && !p.vac) { const r = inReach(model, p, ship, w, p.owned); if (r && !p.owned) { p.owned = true; p.bound = t; p.vr = 0; p.vt = 0; } else if (!r && p.owned) p.owned = false; }
      if (p.owned) { if (pipStep(model, p, ship, w, t, DT, p.vac)) { p.done = t; continue; } }
      else { const f = Math.pow(0.08, DT); p.vx *= f; p.vy *= f; p.x += p.vx * DT; p.y += p.vy * DT; }
      const ang = Math.atan2(p.y - ship.y, p.x - ship.x); let da = ang - p.last; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; p.sweep += da; p.last = ang;
    }
  }
  return pips;
}
const ART = { x: 0, y: 0, vx: 0, vy: 0, r: 18 };
const MODELS = ['current', 'hero', 'arcade', 'sortie'];
const MNAME = { current: 'current snap (120)', hero: 'Hero Kits', arcade: 'Arcade Kit', sortie: 'Sortie Loadout' };

log(H('S6. XP pip gravity vs today\'s 120 px magnet snap (live gems.ts: bind <= 120, home at max(520, v+350), keep <= 192)'));
// ---- A. single pip at rest, parked Artificer
log('A. One pip at rest, parked Artificer: collect time (s) and visible curl (degrees swept around the ship):');
const A = [];
for (const m of MODELS) {
  const row = [MNAME[m]];
  for (const d of [100, 150, 200, 250, 300, 400, 500]) { const [p] = run(m, ART, [{ x: d, y: 0 }], {}, { sec: 4 }); row.push(p.done < 0 ? 'no' : `${f2(p.done)} s ${f0(Math.abs(p.sweep) * 180 / Math.PI)}°`); }
  A.push(row);
}
log(table(['model', '100 px', '150', '200', '250', '300', '400', '500'], A));

// ---- B. scatter around a parked ship
function scatter(n, R, seed) { const r = rng(seed); return Array.from({ length: n }, () => { const a = r() * 2 * Math.PI, d = Math.sqrt(r()) * R; return { x: Math.cos(a) * d, y: Math.sin(a) * d }; }); }
log('\nB. 400 pips scattered uniformly in a 450 px disc around a parked Artificer: collected within 3 s (mean time):');
const B = [];
for (const m of MODELS) for (const [lab, mod] of [['base', {}], ['Magnet L5', { magnet: 5 }], ['Tractor', { tractor: true }]]) {
  if (m === 'current' && lab === 'Tractor') continue;
  const ps = run(m, ART, scatter(400, 450, 3), mod, { sec: 3 });
  const got = ps.filter((p) => p.done >= 0);
  B.push([MNAME[m], lab, pct(got.length / ps.length), got.length ? f2(got.reduce((a, p) => a + p.done, 0) / got.length) + ' s' : '-']);
}
log(table(['model', 'mods', 'collected in 3 s', 'mean time'], B));

// ---- C. fly-through swath: ship crosses a uniform field; effective capture width and pips/s
function field(seed, L, halfW, density) { const r = rng(seed); const n = Math.round(L * 2 * halfW * density); return Array.from({ length: n }, () => ({ x: 300 + r() * L, y: (r() - 0.5) * 2 * halfW })); }
function swath(m, v, mod, shipR = 18, arena = false) {
  const L = 2200, halfW = 900, dens = 1 / 4000; // 1 pip per 63x63 px
  const pips = field(7, L, halfW, dens);
  const ship = { x: 0, y: 0, vx: v, vy: 0, r: shipR };
  const ps = run(m, ship, pips, { ...mod, arena }, { sec: (L + 600) / v });
  const got = ps.filter((p) => p.done >= 0).length;
  const W = got / (dens * L);
  return { W, rate: dens * v * W, got };
}
log('\nC. Fly-through: effective collection width W (pips collected / (density x path length)) and pips per second at density 1 per 63x63 px:');
const C = [];
const base470 = swath('current', 470, {}).W;
for (const [lab, v, r] of [['Artificer cruise 470', 470, 18], ['Artificer boost 700', 700, 18], ['Juggernaut cruise 430', 430, 22], ['Arcanist boost 760', 760, 16]]) {
  for (const m of MODELS) for (const [ml, mod] of [['base', {}], ['Magnet L5', { magnet: 5 }], ['Tractor', { tractor: true }]]) {
    if (m === 'current' && ml === 'Tractor') continue;
    const s = swath(m, v, mod, r);
    C.push([lab, MNAME[m], ml, f0(s.W) + ' px', f1(s.rate) + '/s', f2(s.W / base470) + 'x']);
  }
}
log(table(['ship', 'model', 'mods', 'width W', 'pips/s', 'vs current snap @470'], C));
log('Arena (pips only from takedowns; Hero has no Arena multiplier, Arcade x0.85, Sortie 240 base):');
const CA = [];
for (const m of MODELS) { const s = swath(m, 470, {}, 18, true); CA.push([MNAME[m], f0(s.W) + ' px', f2(s.W / base470) + 'x']); }
log(table(['model', 'width W @470 (Arena)', 'vs current'], CA));

// ---- D. Vacuum and big wells
log('\nD. Vacuum pickup (instant) on 400 pips scattered in a 1500 px disc around a parked Artificer: collected in 3 s:');
const D = [];
for (const m of ['hero', 'arcade', 'sortie']) { const ps = run(m, ART, scatter(400, 1500, 5), {}, { sec: 3, vacuumAt: 0 }); const got = ps.filter((p) => p.done >= 0); D.push([MNAME[m], pct(got.length / ps.length), f2(got.reduce((a, p) => a + p.done, 0) / Math.max(1, got.length)) + ' s', f2(Math.max(...got.map((p) => p.done))) + ' s']); }
log(table(['model', 'collected in 3 s', 'mean', 'last'], D));

// ---- E. capital crews: Dreadnought n5 vs a nearby Arcanist (who wins pips in between?)
log('\nE. Contest: Dreadnought n5 (r 34) and an Arcanist (r 16) 500 px apart, 60 pips on the line between them: share won by the Dreadnought:');
function contest(m) {
  const dr = { x: 0, y: 0, vx: 0, vy: 0, r: 34 }, ar = { x: 500, y: 0, vx: 0, vy: 0, r: 16 };
  const wd = well(m, dr, { n: 5 }), wa = well(m, ar, {});
  const pull = (w, d) => w.kind === 'snap' ? (d <= w.snap ? 1e6 - d : 0) : w.kind === 'hero' ? (d <= w.R ? w.A * (0.25 + 0.75 * (1 - d / w.R) ** 2) : 0) : w.kind === 'arcade' ? (d <= w.R ? w.A * (0.35 + 0.65 * (1 - d / w.R)) : 0) : (d <= w.Rg ? w.A * (1 - Math.max(0, (d - w.capture) / (w.Rg - w.capture))) + 320 : 0);
  let won = 0, any = 0;
  for (let i = 1; i < 60; i++) { const x = 500 * i / 60; const a = pull(wd, x), b = pull(wa, 500 - x); if (a > 0 || b > 0) any++; if (a > b) won++; }
  return { won, any };
}
const E = [];
for (const m of MODELS) { const r = contest(m); E.push([MNAME[m], `${r.won}/59 pips (${pct(r.won / 59)})`, `${r.any}/59 inside any well`]); }
log(table(['model', 'Dreadnought n5 wins', 'reach'], E));

// ---- flags
{
  const cur = swath('current', 470, {}).W;
  for (const m of ['hero', 'arcade', 'sortie']) {
    const b = swath(m, 470, {}).W, mg = swath(m, 470, { magnet: 5 }).W, tr = swath(m, 470, { tractor: true }).W;
    const kit = m;
    if (b / cur >= 1.8) flag(kit, 'MED', 'Pip gravity roughly doubles passive XP pickup', `fly-by collection width ${f0(b)} px vs today's ${f0(cur)} px (${f2(b / cur)}x) before any Magnet card; Magnet L5 ${f0(mg)} px, Tractor ${f0(tr)} px. Levels (and the level-3 path / ult unlocks) arrive earlier; re-pin the XP curve or trim the base well.`);
    if (mg / b < 1.35) flag(kit, 'LOW', 'Magnet card loses value', `Magnet L5 only ${f2(mg / b)}x the base well width (today L5 = 2.75x radius): the card becomes a weak pick.`);
  }
}
fs.writeFileSync(new URL('./s6_pips.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s6_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
