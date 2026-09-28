// S6. XP pip gravity: collection rate of each kit's two-zone well vs today's 120 px magnet snap (live pve/gems.ts), with and
// without Magnet L5 / Tractor Field / Vacuum. Tick-accurate, deterministic (id parity handedness), 4-tick staggered rebinding.
import fs from 'node:fs';
import { DT, TICK, rng, table, H, f0, f1, f2, pct, flag, FLAGS, capMass } from '../v06pd_kitsim/lib.mjs';
import { GRAV } from '../v06pd_kitsim/kits.mjs';
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
function field(seed, L, halfW, density) { const r = rng(seed); const n = Math.round(L * 2 * halfW * density); return Array.from({ length: n }, () => ({ x: 300 + r() * L, y: (r() - 0.5) * 2 * halfW })); }
function swath(m, v, mod, shipR = 18, arena = false) {
  const L = 2200, halfW = 900, dens = 1 / 4000;
  const pips = field(7, L, halfW, dens);
  const ship = { x: 0, y: 0, vx: v, vy: 0, r: shipR };
  const ps = run(m, ship, pips, { ...mod, arena }, { sec: (L + 600) / v });
  return ps.filter((p) => p.done >= 0).length / (dens * L);
}
const cur = swath('current', 470, {});
const orig = { ...GRAV.sortie };
for (const [pve, arena] of [[320, 240], [260, 200], [240, 190], [220, 180]]) {
  GRAV.sortie.pveBase = pve; GRAV.sortie.arenaBase = arena;
  const row = [];
  for (const d of [100, 150, 200, 250]) { const [p] = run('sortie', ART, [{ x: d, y: 0 }], {}, { sec: 4 }); row.push(p.done < 0 ? `${d}:no` : `${d}:${f2(p.done)}s/${f0(Math.abs(p.sweep) * 180 / Math.PI)}deg`); }
  const w = swath('sortie', 470, {}), wa = swath('sortie', 470, {}, 18, true), wm = swath('sortie', 470, { magnet: 5 }), wt = swath('sortie', 470, { tractor: true });
  console.log(`sortie-dynamics pve ${pve} / arena ${arena}: ${row.join('  ')} | flyby PvE ${f0(w)} px (${f2(w / cur)}x)  Arena ${f0(wa)} (${f2(wa / cur)}x)  MagnetL5 ${f0(wm)} (${f2(wm / w)}x base)  Tractor ${f0(wt)}`);
}
Object.assign(GRAV.sortie, orig);
console.log(`hero flyby ${f0(swath('hero',470,{}))}, arcade ${f0(swath('arcade',470,{}))}, current ${f0(cur)}`);
