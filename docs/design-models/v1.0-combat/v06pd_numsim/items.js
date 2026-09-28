// Items (spec §8): Singularity Drive vs a swarm and vs players, EMP vs shields, Ion Storm and Bomb area damage.
'use strict';
const K = require('./core');
const { TICK, DT, CLASSES, CLS, SHORT, makeShip, damageShip, fmt, pad, padr } = K;
const { step, hostPen, mass } = require('./inertia');

// ---- shared PvE scaling (current code + spec §10) ----
const DIFF = { 1: { name: 'Story', rate: 0.7, count: 0.8, hp: 0.7, cap: 4, lives: 2 }, 2: { name: 'Veteran', rate: 1, count: 1, hp: 1, cap: 5, lives: 0 }, 3: { name: 'Nightmare', rate: 1.35, count: 1.25, hp: 1.4, cap: 6, lives: -2 } };
const TUNE = { base: 1, perFloor: 0.25, perMin: 0.3, perMin2: 0.02, perRoom: 0.05, tierHpPer: 0.12, tierContactPer: 0.04, partyCountPer: 0.25, partyHpPer: 0.2, pulses4From: 4, driveKillsKami: true, driveCrushDps: 600 };
function heatH(fl, m, pve, cleared = 0) { const d = DIFF[pve]; const x = TUNE.base + TUNE.perFloor * (fl - 1) + d.rate * (TUNE.perMin * m + TUNE.perMin2 * m * m) + TUNE.perRoom * cleared; const s = x <= 4 ? x : 4 + (x - 4) * 0.5; return Math.min(d.cap, s); }
const heatScale = (H) => { const h = H - 1; return { budget: 1 + 0.35 * h, hp: 1 + 0.15 * h, speed: Math.min(1.45, 1 + 0.1 * h), dmg: Math.min(1.8, 1 + 0.15 * h), elite: Math.min(0.2, 0.05 + 0.025 * h) }; };
const tierOf = (f) => 1 + 2 * (f - 1);
const tierHp = (f) => 1 + TUNE.tierHpPer * (tierOf(f) - 1);
const tierContact = (f) => 1 + TUNE.tierContactPer * (tierOf(f) - 1);
const partyCount = (n) => 1 + TUNE.partyCountPer * (n - 1), partyHp = (n) => 1 + TUNE.partyHpPer * (n - 1);
const ENEMY = {
  drone: { r: 13, hp: 160, speed: 175, accel: 3, contact: 110, kami: true, cost: 1 },
  dart: { r: 11, hp: 130, speed: 130, accel: 4, contact: 160, kami: true, cost: 1 },
  weaver: { r: 13, hp: 210, speed: 215, accel: 5, contact: 120, kami: true, cost: 1 },
  splitling: { r: 9, hp: 80, speed: 265, accel: 5, contact: 60, kami: true, cost: 1 },
  splitter: { r: 18, hp: 380, speed: 140, accel: 2.5, contact: 90, kami: false, cost: 2, knock: 220 },
  spinner: { r: 15, hp: 420, speed: 180, accel: 3, contact: 80, kami: false, cost: 2, knock: 200 },
  brute: { r: 34, hp: 2400, speed: 90, accel: 1.5, contact: 240, kami: false, cost: 5, knock: 520 },
  blackhole: { r: 30, hp: 1800, speed: 35, accel: 1, contact: 180, kami: false, cost: 6 },
};
module.exports = { TUNE, DIFF, heatH, heatScale, tierOf, tierHp, tierContact, partyCount, partyHp, ENEMY };
if (require.main !== module) return;

console.log('=== 0. Enemy numbers the design produces (Veteran, H at minute 3 with 2 rooms cleared) ===');
console.log('  floor tier H    | drone HP n1/n4/n6      | drone contact | brute HP n6 | pulse budget k0 n1/n4/n6');
for (let f = 1; f <= 10; f++) {
  const H = heatH(f, 3, 2, 2), hs = heatScale(H);
  const hp = [1, 4, 6].map((n) => fmt(160 * tierHp(f) * partyHp(n) * hs.hp, 0)).join('/');
  const bud = [1, 4, 6].map((n) => fmt((8 + 2 * f) * partyCount(n) * hs.budget, 0)).join('/');
  console.log(`  f${pad(f, 2)}  ${pad(tierOf(f), 3)} ${fmt(H, 2)} | ${padr(hp, 22)} | ${pad(fmt(110 * tierContact(f) * hs.dmg, 0), 5)} (×${fmt(tierContact(f) * hs.dmg, 2)}) | ${pad(fmt(2400 * tierHp(f) * partyHp(6) * hs.hp, 0), 6)}      | ${bud}`);
}
console.log('  NOTE: the spec quotes "a drone lands 110 × the heat damage multiplier", but the live code also scales contact by tier: ×(1 + 0.04·(tier − 1)) = ×1.4 on floor 6, ×1.72 on floor 9.');

// ---- 1. Singularity Drive vs a swarm (2D mini sim) ----
function driveVsSwarm(opts) {
  const { f = 3, n = 6, pve = 2, drive = true, cls = 'brute', H: Hover, polar = false, secs = 5, mix = 'swarm' } = opts;
  const H = Hover ?? heatH(f, 3, pve, 2), hs = heatScale(H);
  const ship = makeShip(cls); const R = CLASSES[cls].r;
  if (polar) ship.polarUntil = 1e9;
  const horizon = R + 70;
  const budget = (8 + 2 * f) * partyCount(n) * DIFF[pve].count * hs.budget * 1.3; // one mid-room pulse
  const kinds = mix === 'swarm' ? ['drone', 'drone', 'weaver', 'dart'] : ['drone', 'weaver', 'splitter', 'spinner', 'brute'];
  const es = []; let eq = 0, i = 0;
  const rng = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  while (eq < budget) {
    const k = kinds[i++ % kinds.length], d = ENEMY[k]; eq += d.cost;
    const a = rng() * Math.PI * 2, rr = 250 + rng() * 350; // spawned in the room 250-600 px away
    es.push({ k, d, x: Math.cos(a) * rr, y: Math.sin(a) * rr, vx: 0, vy: 0, hp: d.hp * tierHp(f) * partyHp(n) * hs.hp, alive: true, cr: 0 });
  }
  let kills = 0, killsKami = 0, crushDmg = 0, took = 0;
  const Tend = secs * TICK;
  for (let t = 0; t < Tend; t++) {
    const on = drive && t < 5 * TICK;
    for (const e of es) {
      if (!e.alive) continue;
      const dx = -e.x, dy = -e.y, dist = Math.hypot(dx, dy) || 1;
      const sp = e.d.speed * hs.speed;
      const k = Math.min(1, e.d.accel * DT);
      e.vx += (dx / dist * sp - e.vx) * k; e.vy += (dy / dist * sp - e.vy) * k;
      if (on && dist < 520) { e.vx += dx / dist * 1200 * DT; e.vy += dy / dist * 1200 * DT; e.x += dx / dist * 30 * DT; e.y += dy / dist * 30 * DT; }
      e.x += e.vx * DT; e.y += e.vy * DT;
      const nd = Math.hypot(e.x, e.y);
      if (on && nd < horizon + e.d.r) {
        if (e.d.kami) { e.alive = false; kills++; killsKami++; continue; }
        e.hp -= 600 * DT; crushDmg += 600 * DT; if (e.hp <= 0) { e.alive = false; kills++; continue; }
      }
      if (nd < R + e.d.r) {
        const contact = e.d.contact * tierContact(f) * hs.dmg;
        if (e.d.kami) { const b = ship.I + ship.S; damageShip(ship, contact * (polar ? 0.25 : 1), 'contact', t); took += b - ship.I - ship.S; e.alive = false; if (polar) kills++; continue; }
        if (t >= e.cr) { const b = ship.I + ship.S; damageShip(ship, contact * (on ? 0.5 : 1) * (polar ? 0.5 : 1), 'contact', t); took += b - ship.I - ship.S; e.cr = t + 30; }
        // keep out of the ship
        e.x = e.x / nd * (R + e.d.r); e.y = e.y / nd * (R + e.d.r);
      }
    }
    K.reactorTick(ship, {}, t, {});
  }
  const alive = es.filter((e) => e.alive).length;
  return { H, bodies: es.length, kills, killsKami, alive, took, crushDmg, ship };
}
console.log('\n=== 1. Singularity Drive (PvE: pull 520 px @1200 px/s² + 30 px/s nudge, horizon r+70, kamikaze crushed, 600 crush dps) ===');
console.log('  A pulse of 1.3 × pulse-budget bodies spawned 250–600 px around an anchored ship (worst case: all of them target it).');
for (const mix of ['swarm', 'mixed']) for (const [f, n] of [[1, 1], [1, 6], [3, 6], [6, 6], [9, 6]]) {
  const a = driveVsSwarm({ f, n, mix, drive: true, cls: 'engineer' }), b = driveVsSwarm({ f, n, mix, drive: false, cls: 'engineer' });
  console.log(`  ${mix} f${f} n${n} H${fmt(a.H, 1)}: ${a.bodies} bodies | Drive 5 s: ${a.kills} killed (${a.killsKami} kamikaze), ${a.alive} left, Artificer took ${fmt(a.took, 0)} (S ${fmt(a.ship.S, 0)} I ${fmt(a.ship.I, 0)}) | no Drive: Artificer took ${fmt(b.took, 0)}${b.ship.alive ? '' : ' → DEAD'} (${b.alive} left)`);
}

// ---- 2. Singularity Drive vs players (PvP: pull 450 px/s², 520 px, 180 crush dps inside the horizon, 4 s) ----
function escape(cls, n, L, brown, ab, d0 = 250, pull = 450, horizonPad = 70, ownerR = 22, secs = 4) {
  const c = CLASSES[cls]; const b = { x: d0, y: 0, vx: 0, vy: 0 };
  const sm = hostPen(n) * [1, 1, 0.9, 0.75][L] * (brown ? 0.7 : 1);
  const s = makeShip(cls, { turrets: n }); let t = 0, crushT = 0;
  for (; t < secs * TICK; t++) {
    const dist = Math.hypot(b.x, b.y);
    if (dist > 520) return { escaped: true, t: t / TICK, crush: crushT / TICK, s };
    // pull toward 0 (not mass-scaled)
    b.vx -= (b.x / dist) * pull * DT;
    step(b, c, [1, 0], ab, sm, mass(n));
    const nd = Math.hypot(b.x, b.y);
    const myR = c.r * (n ? 1.2 + 0.07 * n : 1);
    if (nd < ownerR + horizonPad + myR) { crushT++; damageShip(s, 180 * DT, 'crush', t); b.x = Math.max(b.x, ownerR + horizonPad * 0.5); }
  }
  return { escaped: false, t: Infinity, crush: crushT / TICK, s };
}
console.log('\n=== 2. Singularity Drive vs players: thrusting straight out from 250 px (at rest), pull 450 px/s² ===');
console.log('  class n | L0 | L0+AB | L3 | L3+AB | brownout(L3) | crush damage taken if caught (4 s)');
for (const k of CLS) for (const n of [0, 1, 2, 3, 5]) {
  const cells = [[0, false, false], [0, false, true], [3, false, false], [3, false, true], [3, true, false]].map(([L, br, ab]) => { const r = escape(k, n, L, br, ab); return r.escaped ? `out ${fmt(r.t, 2)} s` : `STUCK`; });
  const worst = escape(k, n, 3, true, false);
  console.log(`  ${SHORT[k]} n${n} | ${cells.map((c) => padr(c, 10)).join(' | ')} | horizon ${fmt(worst.crush, 1)} s, S ${fmt(worst.s.S, 0)}/${fmt(worst.s.st.S, 0)} I ${fmt(worst.s.I, 0)}/${fmt(worst.s.st.I, 0)}`);
}
console.log('  net escape accel = thrust × penalty × strain × (AB 1.5) / mass − 450 (plus the grip brake, which also resists being pulled backward):');
for (const k of CLS) { const c = CLASSES[k]; console.log(`   ${SHORT[k]}: thrust ${c.thrust}, grip brake ${fmt(c.brake * c.grip, 0)} px/s² → n0 L0 ${fmt(c.thrust - 450, 0)}, n5 AB ${fmt(c.thrust * 0.65 * 1.5 / 2.25 - 450, 0)} px/s²`); }

// ---- 3. EMP vs shields ----
console.log('\n=== 3. EMP Pulse vs shields (PvP: 600 emp shield-only, −40% current power, reactor offline 1.5 s, shield delay → break + 1 s) ===');
for (const k of CLS) for (const [lab, o] of [['base', {}], ['shieldcap×5', { cards: { shieldcap: 5 } }], ['capital n5', { turrets: 5 }], ['Bulwark+cap5+n5', { bulwark: true, cards: { shieldcap: 5 }, turrets: 5 }]]) {
  if (lab.startsWith('Bulwark') && k !== 'brute') continue;
  const s = makeShip(k, o); const S0 = s.st.S; const removed = Math.min(S0, 600);
  const regenBack = Math.max(1.5, s.st.sb + 1);
  const polarHalf = k === 'brute' ? ` | polarized: 300 removed (${fmt(Math.min(S0, 300) / S0 * 100, 0)}%), drain 20%, offline 0.75 s` : '';
  console.log(`  ${SHORT[k]} ${padr(lab, 16)} shield ${pad(fmt(S0, 0), 4)}: removes ${pad(fmt(removed, 0), 3)} (${pad(fmt(removed / S0 * 100, 0), 3)}%), shield regen restarts after ${fmt(regenBack, 1)} s, refill done at ${fmt(regenBack + S0 / (s.st.Sr * 1.6), 1)} s (L0)${polarHalf}`);
}
console.log('  PvE EMP: 150 flat + 1.5 s stun in 300 px and deletes hostile projectiles; stunned kamikaze do no contact.');

// ---- 4. Ion Storm ----
console.log('\n=== 4. Ion Storm (240 px, 6 s, every 0.25 s arcs to ≤ 4 targets × 70 PvE; PvP ≤ 3 targets × 40 ion + 25 power/arc) ===');
for (const [f, n] of [[1, 1], [1, 6], [3, 6], [6, 6], [9, 6]]) {
  const H = heatH(f, 3, 2, 2), hs = heatScale(H); const hp = 160 * tierHp(f) * partyHp(n) * hs.hp;
  const total = 24 * 4 * 70; const perTarget = 280;
  console.log(`  PvE f${f} n${n}: drone HP ${fmt(hp, 0)} → each arc target dies in ${fmt(hp / perTarget, 2)} s; ≈ ${fmt(total / hp, 0)} drone kills max over 6 s (${total} dmg total, 1120 dps cap), brute HP ${fmt(2400 * tierHp(f) * partyHp(n) * hs.hp, 0)} takes ${fmt(280 * 6, 0)} over 6 s`);
}
for (const k of CLS) {
  const s = makeShip(k); let t = 0, tStrip = -1, tDead = -1;
  for (; t < 6 * TICK; t++) {
    if (t % 15 === 0) { damageShip(s, 40, 'ion', t); s.P = Math.max(0, s.P - 25); if (tStrip < 0 && s.S <= 0) tStrip = t / TICK; if (!s.alive) { tDead = t / TICK; break; } }
    K.reactorTick(s, {}, t, {});
  }
  console.log(`  PvP sit-in ${SHORT[k]}: shield stripped at ${fmt(tStrip, 2)} s; after 6 s S ${fmt(s.S, 0)} I ${fmt(s.I, 0)}/${s.st.I} P ${fmt(s.P, 0)}${tDead > 0 ? ' DEAD ' + fmt(tDead, 2) : ''} (spec also says ion drains 0.5 × amount power — with both, 45 power per arc)`);
}

// ---- 5. Bomb ----
console.log('\n=== 5. Bomb (420 kinetic, splash 150 px falling to 40% at the edge; PvE ×1.5 = 630) ===');
for (const [f, n] of [[1, 1], [1, 6], [3, 6], [6, 6], [9, 6], [10, 6]]) {
  const H = heatH(f, 3, 2, 2), hs = heatScale(H); const hp = 160 * tierHp(f) * partyHp(n) * hs.hp;
  // splash m(r) = 1 − 0.6 r/150 → kill radius where 630 m ≥ hp
  const m = hp / 630; const r = m > 1 ? 0 : Math.min(150, (1 - m) / 0.6 * 150);
  console.log(`  PvE f${f} n${n}: drone HP ${fmt(hp, 0)} → one bomb kills drones within ${fmt(r, 0)} px (${r > 0 ? 'area ' + fmt(Math.PI * r * r / (Math.PI * 150 * 150) * 100, 0) + '% of the blast' : 'none'})`);
}
for (const k of CLS) {
  const one = makeShip(k); damageShip(one, 420, 'kinetic', 0);
  const two = makeShip(k); damageShip(two, 420, 'kinetic', 0); damageShip(two, 420, 'kinetic', 0);
  const down = makeShip(k); down.S = 0; damageShip(down, 420, 'kinetic', 0);
  console.log(`  PvP ${SHORT[k]}: 1 bomb → S ${fmt(one.S, 0)} I ${fmt(one.I, 0)} | 2 bombs → S ${fmt(two.S, 0)} I ${fmt(two.I, 0)}${two.alive ? '' : ' DEAD'} | 1 bomb, shield down → I ${fmt(down.I, 0)}${down.alive ? '' : ' DEAD'}`);
}
console.log('  Bomb economy: 2 at spawn + 1 per 18 s (cap 2): 3.3 free bombs/min = 2100 PvE splash dmg/min, cost 120 power each.');
