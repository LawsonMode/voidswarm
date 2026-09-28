// S2. Ultimate impact on the CR damage pipeline: (A) PvP burst vs each class with shields up / down, (B) swarm clear %
// with a 2D pulse model, (C) Event Horizon (and Black Star) pull on a swarm and on players, capitals included.
import fs from 'node:fs';
import { CLASSES, CLS, SHORT, CAPNAME, TYPE, DT, TICK, makeTarget, hit, left, rawToKill, ttk, weaponStats, rawDps, mdFalloff, moveStep,
  capMass, hostPen, rng, table, H, f0, f1, f2, pct, flag, FLAGS } from './lib.mjs';
import { KIT_IDS, KIT_NAME, CLASS_OVERRIDE } from './kits.mjs';

const lines = []; const log = (s = '') => lines.push(s);
const cOf = (kit, cls) => ({ ...CLASSES[cls], ...(CLASS_OVERRIDE[kit][cls] || {}) });
/** Apply a list of packets [{amt, type, h}] to a fresh target; returns 'S/I' or 'DOWN'. */
function burst(kit, cls, packets, o = {}) {
  const t = makeTarget(cOf(kit, cls), o);
  for (const p of packets) hit(t, p.amt, p.type, p.h ?? 0);
  return t;
}
const rep = (n, amt, type) => Array.from({ length: n }, () => ({ amt, type }));
const cells = (kit, packets) => CLS.flatMap((c) => [left(burst(kit, c, packets)), left(burst(kit, c, packets, { shieldDown: true }))]);
const HEAD = ['kit', 'ult', 'case', 'Jugg full', 'Jugg shields down', 'Arca full', 'Arca down', 'Arti full', 'Arti down'];

// =====================================================================================================================
log(H('S2-A. PvP burst per ultimate (remaining shield/integrity, or DOWN). "down" = target starts with 0 shield (broken), full integrity'));
log('Pipeline: CR §7 (kinetic 0.8/1.2, energy 1/1, phase 2.5/0.9, ion 1.5/0.5, crush armor x0.5, emp shield-only), armor on integrity: Jugg 0.40, Arti 0.10.');
log('Arcanist integrity: Hero Kits 420 (as its checks quote), Arcade/Sortie 500 (judge fix). No hardening unless stated.');
const A = [];
// ---- Hero
A.push(['Hero', 'Wrecking Run', '1 hit + shockwave (spec check)', ...cells('hero', [{ amt: 350, type: 'kinetic' }, { amt: 400, type: 'kinetic' }])]);
A.push(['Hero', 'Wrecking Run', '2 hits + shockwave (loop re-hit)', ...cells('hero', [...rep(2, 350, 'kinetic'), { amt: 400, type: 'kinetic' }])]);
A.push(['Hero', 'Wrecking Run', '3 hits + shockwave (max in 3 s)', ...cells('hero', [...rep(3, 350, 'kinetic'), { amt: 400, type: 'kinetic' }])]);
A.push(['Hero', 'Wrecking Run', '2 hits + shock, ram_momentum x1.5', ...cells('hero', [...rep(2, 525, 'kinetic'), { amt: 400, type: 'kinetic' }])]);
const cbFall = (d, R) => (d > R ? 0 : 1 - 0.6 * d / R);
const cbParked = 280 * (1 + 2 * cbFall(77, 130)), cbOff80 = 280 * (cbFall(80, 130) + 2 * cbFall(Math.hypot(80, 77), 130));
A.push(['Hero', 'Carpet Bomb', `parked on the lane (${f0(cbParked)} raw)`, ...cells('hero', [{ amt: cbParked, type: 'kinetic' }])]);
A.push(['Hero', 'Carpet Bomb', `80 px off the lane (${f0(cbOff80)} raw)`, ...cells('hero', [{ amt: cbOff80, type: 'kinetic' }])]);
A.push(['Hero', 'Carpet Bomb', 'parked + the Big One (450)', ...cells('hero', [{ amt: cbParked, type: 'kinetic' }, { amt: 450, type: 'kinetic' }])]);
A.push(['Hero', 'EMP Pulse', '600 emp (shield only) + 2 s offline', ...cells('hero', [{ amt: 600, type: 'emp' }])]);
A.push(['Hero', 'Ion Storm', 'stationary full 6 s (24 arcs x 50 ion)', ...cells('hero', rep(24, 50, 'ion'))]);
A.push(['Hero', 'Ion Storm', 'reacts: 7 arcs (tell 0.5 s + 0.25 s + ~1 s out)', ...cells('hero', rep(7, 50, 'ion'))]);
A.push(['Hero', 'Event Horizon', 'crush only, 5 s inside the horizon (180 crush/s)', ...cells('hero', rep(50, 18, 'crush'))]);
A.push(['Hero', 'Hyperlance', '1 rail (650 energy)', ...cells('hero', [{ amt: 650, type: 'energy' }])]);
A.push(['Hero', 'Hyperlance', '2 rails', ...cells('hero', rep(2, 650, 'energy'))]);
A.push(['Hero', 'Hyperlance', '3 rails', ...cells('hero', rep(3, 650, 'energy'))]);
A.push(['Hero', 'Drone Carrier', '6 drones 1 s (6 x 150/s x0.6 = 540 kinetic/s)', ...cells('hero', rep(60, 9, 'kinetic'))]);
A.push(['Hero', 'Drone Carrier', '6 drones 2 s', ...cells('hero', rep(120, 9, 'kinetic'))]);
// ---- Arcade
A.push(['Arcade', 'Event Horizon', 'crush only, 4 s (Arena) inside the horizon', ...cells('arcade', rep(40, 18, 'crush'))]);
A.push(['Arcade', 'Ion Storm', 'stationary full 6 s (24 arcs x 45 ion)', ...cells('arcade', rep(24, 45, 'ion'))]);
A.push(['Arcade', 'Ion Storm', 'reacts: 6 arcs', ...cells('arcade', rep(6, 45, 'ion'))]);
A.push(['Arcade', 'Overload Pulse', '600 emp + 1.5 s offline', ...cells('arcade', [{ amt: 600, type: 'emp' }])]);
A.push(['Arcade', 'Overload Pulse', '+ 2 bombs (2 x 300 kinetic) (spec check)', ...cells('arcade', [{ amt: 600, type: 'emp' }, ...rep(2, 300, 'kinetic')])]);
// ---- Sortie
A.push(['Sortie', 'Carpet Bomb', 'per-target cap: 3 x 200 kinetic', ...cells('sortie', rep(3, 200, 'kinetic'))]);
A.push(['Sortie', 'Rampage', '3 contacts (160 each, 1 per 0.5 s)', ...cells('sortie', rep(3, 160, 'kinetic'))]);
A.push(['Sortie', 'Rampage', '10 contacts (max 1 per 0.5 s for 5 s)', ...cells('sortie', rep(10, 160, 'kinetic'))]);
A.push(['Sortie', 'Ion Storm', 'stationary full 6 s (24 arcs x 40 ion)', ...cells('sortie', rep(24, 40, 'ion'))]);
A.push(['Sortie', 'Hyperlance', '1 beam 650 energy', ...cells('sortie', [{ amt: 650, type: 'energy' }])]);
A.push(['Sortie', 'Hyperlance', '+1 bomb (the spec\'s intended lethal combo)', ...cells('sortie', [{ amt: 650, type: 'energy' }, { amt: 300, type: 'kinetic' }])]);
A.push(['Sortie', 'Black Star', 'core 3 s (150/s) + collapse 400', ...cells('sortie', [...rep(30, 15, 'energy'), { amt: 400, type: 'energy' }])]);
A.push(['Sortie', 'Event Horizon', 'crush only, 4 s PvP (180/s)', ...cells('sortie', rep(40, 18, 'crush'))]);
A.push(['Sortie', 'EMP Pulse', '600 emp + 1.5 s offline + suppress', ...cells('sortie', [{ amt: 600, type: 'emp' }])]);
A.push(['Sortie', 'Drone Carrier', '6 drones 2 s (6 x 120/s x0.6 = 432 kinetic/s)', ...cells('sortie', rep(120, 7.2, 'kinetic'))]);
log(table(HEAD, A));

// ---- two-ult chains: an EMP-type ult (shield strip, regen offline) followed by a teammate's burst ult on the same target
log('\nTwo-ult team chains (EMP-type first, then one burst ult; full target):');
const CH = [];
const chain = (kit, lab, first, second) => CH.push([KIT_NAME[kit], lab, ...CLS.map((c) => left(burst(kit, c, [...first, ...second])))]);
const EMPp = [{ amt: 600, type: 'emp' }];
chain('hero', 'EMP -> 1 Hyperlance rail', EMPp, [{ amt: 650, type: 'energy' }]);
chain('hero', 'EMP -> 2 Hyperlance rails', EMPp, rep(2, 650, 'energy'));
chain('hero', 'EMP -> Wrecking Run (1 hit + shock)', EMPp, [{ amt: 350, type: 'kinetic' }, { amt: 400, type: 'kinetic' }]);
chain('hero', 'EMP -> Carpet Bomb (parked)', EMPp, [{ amt: cbParked, type: 'kinetic' }]);
chain('hero', 'EMP -> Drone Carrier 1 s', EMPp, rep(60, 9, 'kinetic'));
chain('arcade', 'Overload -> Ion Storm 2 s (8 arcs)', EMPp, rep(8, 45, 'ion'));
chain('arcade', 'Overload -> EH crush 2 s', EMPp, rep(20, 18, 'crush'));
chain('sortie', 'EMP -> Hyperlance', EMPp, [{ amt: 650, type: 'energy' }]);
chain('sortie', 'EMP -> Carpet Bomb cap (3x200)', EMPp, rep(3, 200, 'kinetic'));
chain('sortie', 'EMP -> Black Star collapse (400)', EMPp, [{ amt: 400, type: 'energy' }]);
log(table(['kit', 'chain', 'Jugg', 'Arca', 'Arti'], CH));
for (const r of CH) if (r.slice(2).filter((x) => x === 'DOWN').length >= 2) flag(r[0] === 'Hero Kits' ? 'hero' : r[0] === 'Arcade Kit' ? 'arcade' : 'sortie', 'MED', `Ult chain "${r[1]}" takes down 2+ classes from full`, `${r.slice(2).join(' / ')} (Jugg / Arca / Arti). EMP-type ults are the enabler; with ~10-12 ults/min on a 16-ship map, a coordinated pair lands every few seconds somewhere.`);

// ---- non-ult burst rule (judge): Ram + full Rocket Salvo, two bombs, must not take down a full Arcanist
log('\nJudge burst rule (non-ult tools must not one-shot a full Arcanist):');
const ramRows = [];
for (const kit of KIT_IDS) {
  const ramAmt = kit === 'sortie' ? 400 * 1.25 * 0.625 : 400;
  const t1 = burst(kit, 'tech', [{ amt: ramAmt, type: 'kinetic' }, ...rep(3, 180, 'kinetic')]);
  const t2 = burst(kit, 'tech', rep(2, 300, 'kinetic'));
  const t3 = burst(kit, 'tech', [{ amt: ramAmt, type: 'kinetic' }, ...rep(3, 180, 'kinetic'), { amt: 300, type: 'kinetic' }]);
  ramRows.push([KIT_NAME[kit], `${f0(ramAmt)} + 3x180`, left(t1), left(t2), left(t3)]);
  if (t1.dead) flag(kit, 'HIGH', 'Ram Charge + Rocket Salvo one-shots a full Arcanist', `Ram ${f0(ramAmt)} kinetic + 3 x 180 rockets = ${f0(ramAmt + 540)} raw vs Arcanist ${cOf(kit, 'tech').S}/${cOf(kit, 'tech').I}: DOWN. The judge required fix (Arcanist 500 or Ram x0.75 vs ships) is ${kit === 'hero' ? 'not applied (420, Ram 400)' : 'only half applied (500 but Ram unscaled vs ships)'}; use RAM_VS_SHIP 0.625 as Sortie does.`);
}
log(table(['kit', 'Ram + Salvo raw', 'Ram+Salvo -> full Arca', '2 bombs -> full Arca', 'Ram+Salvo+bomb'], ramRows));

// ---- EMP-type ults: follow-up TTK of a point-blank Juggernaut Mass Driver (150 px) and an Arcanist Laser (600 px)
log('\nEMP-type ults: seconds for a follow-up weapon to finish each class (target shield stripped by the EMP vs untouched):');
const empRows = [];
for (const [kit, name] of [['hero', 'EMP Pulse (Hero)'], ['arcade', 'Overload (Arcade)'], ['sortie', 'EMP Pulse (Sortie)']]) {
  for (const [att, wid, d] of [['brute', 'massdriver', 150], ['tech', 'laser', 600], ['engineer', 'phaser', 400]]) {
    const row = [name, `${SHORT[att]} ${weaponStats(att, wid).short} @${d}px`];
    for (const tc of CLS) {
      const c = cOf(kit, tc);
      const base = ttk(att, wid, tc, d, { tgtClass: c });
      const after = ttk(att, wid, tc, d, { tgtClass: c, shieldDown: true });
      row.push(`${f2(after)} s (${f2(base)})`);
    }
    empRows.push(row);
  }
}
log(table(['ult', 'follow-up', 'vs Jugg: after (without)', 'vs Arca', 'vs Arti'], empRows));
{
  const r = ttk('brute', 'massdriver', 'tech', 150, { tgtClass: cOf('hero', 'tech'), shieldDown: true });
  flag('hero', 'MED', 'EMP Pulse is un-counterable inside its radius', `r420 with a 0.35 s tell: from the centre nobody can leave (needs ~1200 px/s). It zeroes shields, drains 40% power and blocks regen 2 s; a point-blank Jugg MD then takes an Arcanist down in ${f2(r)} s. Counterplay is only pre-emptive spacing; consider r340 (Arcade/Sortie) or a 0.6 s tell.`);
}

// ---- Hyperlance dodge feasibility
log('\nHyperlance dodge: lateral move needed = hull radius + 12 px (half of the 24 px rail); from rest, with a 0.25 s human reaction:');
const dodgeRows = [];
for (const cls of CLS) {
  const c = CLASSES[cls], need = c.r + 12;
  const tFromRest = Math.sqrt(2 * need / c.thrust);
  dodgeRows.push([SHORT[cls], need + ' px', f2(tFromRest) + ' s', f2(0.25 + tFromRest) + ' s', (0.25 + tFromRest) <= 0.45 ? 'yes' : 'NO', (0.25 + tFromRest) <= 1.0 ? 'yes' : 'NO']);
}
log(table(['class', 'lateral need', 'thrust time', 'reaction + move', 'dodge Hero 0.45 s spool (aim locked)', 'dodge Sortie 1.0 s charge (aim locked)'], dodgeRows));
log('If the shooter may keep aiming during the spool/charge (Hero: "line along your aim"; Sortie: turn x0.5 = 5-8 rad/s), a moving target at 500 px needs only ~1 rad/s of tracking: NOT dodgeable except by LOS / walls / Warp / i-frames.');
flag('hero', 'MED', 'Hyperlance spool can track', 'Spool 0.45 s along the live aim: a Juggernaut at rest needs 0.58 s (reaction + 34 px of thrust) to leave a locked line, and nothing can leave a tracking one. Lock the rail direction at spool start (or turn-rate cap ~1 rad/s) so "react to the line" is real counterplay.');
flag('sortie', 'MED', 'Hyperlance charge tracks at turn x0.5', 'Rooted 1.0 s with turn x0.5 (Arcanist 16 rad/s -> 8 rad/s) tracks anything; 650 per ship and 2500 x pveScale per enemy pierce-all at 2600 px. Lock the aim for the last 0.5 s of the charge.');

// ---- Drone Carrier vs its counter
log('\nDrone Carrier vs its counter ("shoot the drones"): time for a point-blank weapon to clear all drones vs time the drones need to finish you:');
const dcRows = [];
for (const [kit, n, hp, dps, dur] of [['hero', 6, 250, 540, 10], ['sortie', 6, 150, 432, 12]]) {
  for (const [att, wid] of [['brute', 'massdriver'], ['tech', 'laser'], ['engineer', 'phaser']]) {
    const ws = weaponStats(att, wid), dd = rawDps(ws, 150) * (wid === 'phaser' ? 1 : 1);
    const clear = n * hp / dd + (n - 1) * 0.25; // + retarget
    const row = [KIT_NAME[kit], `${SHORT[att]} ${ws.short}`, f1(clear) + ' s'];
    const t = makeTarget(cOf(kit, att)); const need = rawToKill(t, 'kinetic');
    // drones die linearly while you shoot them: incoming dps falls from full to 0 over `clear`
    let tt = 0, dealt = 0; while (dealt < need && tt < dur) { const alive = Math.max(0, 1 - tt / clear); dealt += dps * alive * 0.1; tt += 0.1; }
    row.push(dealt >= need ? `DOWN at ${f1(tt)} s` : `survives (${f0(100 * dealt / need)}% of EHP taken)`);
    const t0 = need / dps; row.push(f1(t0) + ' s');
    dcRows.push(row);
  }
}
log(table(['kit', 'you (shooting drones)', 'clear all drones', 'you while clearing', 'TTK if you ignore them'], dcRows));
for (const kit of ['Hero Kits', 'Sortie Loadout']) {
  const bad = dcRows.filter((r) => r[0] === kit && r[3].startsWith('DOWN'));
  if (bad.length) flag(kit === 'Hero Kits' ? 'hero' : 'sortie', 'MED', 'Drone Carrier counterplay fails', `"shoot the drones": ${bad.map((r) => r[1] + ' is taken down at ' + r[3].slice(8) + ' while clearing (' + r[2] + ' to clear)').join('; ')}. 6 drones = ${kit === 'Hero Kits' ? '540' : '432'} kinetic dps within ${kit === 'Hero Kits' ? 550 : 450} px for ${kit === 'Hero Kits' ? 10 : 12} s, i.e. a second point-blank Mass Driver that auto-aims. Cut drone dps vs ships (x0.4) or drone count to 4.`);
}
flag('hero', 'MED', 'Wrecking Run re-hit loop', 'Impacts allow one hit per target per 0.5 s and stagger lasts 0.6 s; at 900 px/s and turn 6 rad/s the run loops back in ~1.05 s (150 px radius), so a staggered target is hit 2-3 times in the 3 s run: 2 hits + shockwave take down a full Arcanist, 3 hits a full Artificer (the spec checks only 1 hit). Make it once per target per run (or stagger 0.3 s).');
flag('arcade', 'LOW', 'Ult castable in brownout', 'Q ignores brownout (only EMP blocks it): brown out on purpose, then ult. Hero and Sortie block Q in brownout.');
flag('sortie', 'LOW', 'Rampage contact cap', 'contacts limited to once per 0.5 s per target -> up to 10 x 160 = 1600 raw on one ship in 5 s while CC-immune; 3 contacts leave a full Arcanist at 0/494 but 5+ take it down. Cap at 3 hits per target per run (like Carpet Bomb).');

// ---- Lifeline (Hero) survival
log('\nHero Lifeline vs focus fire (600 energy dps on an Arcanist / 900 on a Juggernaut): time to take down without / with Lifeline (heal 180/s capped 200, shield 120/s, 25% hardening, Last Breath once):');
const llRows = [];
for (const [cls, dps] of [['tech', 600], ['engineer', 700], ['brute', 900]]) {
  const run = (life) => {
    const t = makeTarget(cOf('hero', cls)); let tt = 0, lb = life, inv = 0;
    while (tt < 12) {
      if (tt < inv) { tt += DT; continue; }
      const I0 = t.I; hit(t, dps * DT, 'energy', life && tt < 5 ? 0.25 : 0);
      if (t.dead && lb && tt < 5) { t.dead = false; t.I = 1; lb = false; inv = tt + 0.5; }
      if (t.dead) return tt;
      if (life && tt < 5) { t.I = Math.min(t.maxI, t.I + Math.min(200, 180) * DT); if (t.I >= t.maxI) t.S = Math.min(t.maxS, t.S + 120 * DT); }
      tt += DT;
    }
    return Infinity;
  };
  llRows.push([SHORT[cls], dps, f2(run(false)) + ' s', f2(run(true)) + ' s']);
}
log(table(['target', 'focus dps', 'without', 'with Lifeline'], llRows));

// =====================================================================================================================
// S2-B. Swarm clear %: 2D pulse model
// =====================================================================================================================
const EN = {
  drone: { r: 13, hp: 160, speed: 175, accel: 3, kami: true, cost: 1 }, dart: { r: 11, hp: 130, speed: 130, accel: 4, kami: true, cost: 1 },
  weaver: { r: 13, hp: 210, speed: 215, accel: 5, kami: true, cost: 1 }, splitter: { r: 18, hp: 380, speed: 140, accel: 2.5, kami: false, cost: 2 },
  splitling: { r: 9, hp: 80, speed: 265, accel: 5, kami: true, cost: 1 }, spinner: { r: 15, hp: 420, speed: 180, accel: 3, kami: false, cost: 2 },
  brute: { r: 34, hp: 2400, speed: 90, accel: 1.5, kami: false, cost: 5 },
};
const F3_WEIGHTS = [['drone', 15], ['dart', 4], ['weaver', 3], ['splitter', 4.5], ['spinner', 2], ['brute', 1.2]];
const HS = 600; // arena room half-size
function makePulse(seed, de = 60) {
  const R = rng(seed); const es = [];
  const pick = () => { let s = 0; for (const [, w] of F3_WEIGHTS) s += w; let x = R() * s; for (const [k, w] of F3_WEIGHTS) { x -= w; if (x <= 0) return k; } return 'drone'; };
  let left = de, m = 0;
  while (left > 0) {
    const kind = pick(), d = EN[kind]; const per = Math.min(left, 10); const members = Math.max(1, Math.round(per / d.cost));
    const a = R() * Math.PI * 2, rr = m % 3 === 0 ? 180 + R() * 150 : 380 + R() * 180; // a third already engaged, the rest arriving
    const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
    for (let j = 0; j < members; j++) {
      const elite = R() < 0.07;
      const hp = d.hp * (elite ? 3 : 1);
      es.push({ kind, d, x: Math.max(-HS + 30, Math.min(HS - 30, cx + (R() - 0.5) * 70)), y: Math.max(-HS + 30, Math.min(HS - 30, cy + (R() - 0.5) * 70)), vx: 0, vy: 0, hp, maxHp: hp, r: d.r * (elite ? 1.3 : 1), elite, alive: true, stun: 0, slow: 1, hitAt: {} , cost: d.cost * (elite ? 3 : 1) });
    }
    left -= members * d.cost; m++;
  }
  return es;
}
const SPEED_MULT = 1.18; // heat ~2.85 on floor 3 (variant C): speed x min(1.45, 1 + 0.1 (H - 1))
function party() { return Array.from({ length: 6 }, (_, i) => ({ x: Math.cos(i) * 50, y: Math.sin(i) * 50, r: 18 })); }

/** Simulate one ult against a pulse. ult: {dur, init(S), tick(S)}. Returns cleared DE fraction etc. */
function swarmRun(ult, seed, o = {}) {
  const es = makePulse(seed, o.de ?? 60);
  const cp = o.casterPos ?? [0, 0];
  const S = { t: 0, es, ships: party(), caster: { x: cp[0], y: cp[1], vx: 0, vy: 0, r: o.casterR ?? 22, heading: 0 }, killedDE: 0, killed: 0, suicided: 0, contacts: 0, spawned: 0, totalDE: es.reduce((a, e) => a + e.cost, 0), log: {} };
  S.ships[0] = S.caster;
  const kill = (e, byUlt = true) => {
    if (!e.alive) return; e.alive = false;
    if (byUlt) { S.killedDE += e.cost; S.killed++; }
    if (e.kind === 'splitter') for (let i = 0; i < (e.elite ? 5 : 3); i++) { const a = i / 3 * Math.PI * 2; S.es.push({ kind: 'splitling', d: EN.splitling, x: e.x + Math.cos(a) * 12, y: e.y + Math.sin(a) * 12, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, hp: 80, maxHp: 80, r: 9, elite: false, alive: true, stun: 0, slow: 1, hitAt: {}, cost: 1 }); S.totalDE += 1; S.spawned++; }
  };
  S.dmg = (e, amt) => { if (!e.alive) return; e.hp -= amt; if (e.hp <= 0) kill(e, true); };
  S.kill = kill;
  ult.init?.(S);
  const T = ult.dur + (o.tail ?? 0.5);
  for (let k = 0; k < T * TICK; k++) {
    S.t = k * DT;
    S.pull = null;
    ult.tick(S);
    // enemies: seek the nearest ship (or keep the pull)
    for (const e of S.es) {
      if (!e.alive) continue;
      let best = null, bd = 1e9; for (const s of S.ships) { const dd = Math.hypot(s.x - e.x, s.y - e.y); if (dd < bd) { bd = dd; best = s; } }
      const sp = e.d.speed * SPEED_MULT * e.slow;
      if (S.t >= e.stun) {
        const dx = best.x - e.x, dy = best.y - e.y, dd = Math.hypot(dx, dy) || 1;
        const want = dd > best.r + e.r + 4 ? sp : 0;
        const kk = Math.min(1, e.d.accel * DT);
        e.vx += (dx / dd * want - e.vx) * kk; e.vy += (dy / dd * want - e.vy) * kk;
      } else { e.vx *= 0.9; e.vy *= 0.9; }
      if (S.pull && e.r < 30) { const [px, py, R, A, nudge, capV, floor] = S.pull; const dx = px - e.x, dy = py - e.y, dd = Math.hypot(dx, dy) || 1; if (dd < R) { const a = A * (floor != null ? floor + (1 - floor) * (1 - dd / R) : 1); e.vx += dx / dd * a * DT; e.vy += dy / dd * a * DT; if (capV) { const v = Math.hypot(e.vx, e.vy); if (v > capV) { e.vx *= capV / v; e.vy *= capV / v; } } e.x += dx / dd * Math.min(dd, (nudge || 0) * DT); e.y += dy / dd * Math.min(dd, (nudge || 0) * DT); } }
      e.x += e.vx * DT; e.y += e.vy * DT;
      e.x = Math.max(-HS + e.r, Math.min(HS - e.r, e.x)); e.y = Math.max(-HS + e.r, Math.min(HS - e.r, e.y));
      e.slow = 1;
      // kamikaze contact: the body dies on the hull (not an ult kill)
      if (e.d.kami && Math.hypot(best.x - e.x, best.y - e.y) < best.r + e.r) { if (best === S.caster) S.contacts++; e.alive = false; S.suicided++; }
    }
  }
  return { clear: S.killedDE / S.totalDE, killed: S.killed, suicided: S.suicided, contactsOnCaster: S.contacts, totalDE: S.totalDE, log: S.log };
}
const alive = (S) => S.es.filter((e) => e.alive);
function densest(S, R, maxRange, from = S.caster) {
  let best = [from.x, from.y], bn = -1;
  for (let gx = -HS + 60; gx <= HS - 60; gx += 60) for (let gy = -HS + 60; gy <= HS - 60; gy += 60) {
    if (Math.hypot(gx - from.x, gy - from.y) > maxRange) continue;
    let n = 0; for (const e of S.es) if (e.alive && Math.hypot(e.x - gx, e.y - gy) < R) n += e.cost;
    if (n > bn) { bn = n; best = [gx, gy]; }
  }
  return best;
}
/** steer the caster toward a point with a turn-rate limit; wall-aware. returns true if it hit a wall fast. */
function steer(S, speed, turn, target) {
  const c = S.caster; let [tx, ty] = target;
  const px = c.x + Math.cos(c.heading) * speed * 0.35, py = c.y + Math.sin(c.heading) * speed * 0.35;
  if (Math.abs(px) > HS - 60 || Math.abs(py) > HS - 60) { tx = 0; ty = 0; }
  const want = Math.atan2(ty - c.y, tx - c.x);
  let dA = ((want - c.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  c.heading += Math.max(-turn * DT, Math.min(turn * DT, dA));
  c.x += Math.cos(c.heading) * speed * DT; c.y += Math.sin(c.heading) * speed * DT;
  if (Math.abs(c.x) > HS - c.r || Math.abs(c.y) > HS - c.r) { c.x = Math.max(-HS + c.r, Math.min(HS - c.r, c.x)); c.y = Math.max(-HS + c.r, Math.min(HS - c.r, c.y)); return true; }
  return false;
}
function lineHits(S, x0, y0, ang, len, width, bounces, falloff) {
  // returns list of [enemy, mult] along a reflected ray in the room box
  const out = new Map(); let x = x0, y = y0, dx = Math.cos(ang), dy = Math.sin(ang), rem = len, mult = 1;
  for (let b = 0; b <= bounces && rem > 0; b++) {
    // distance to the box wall
    const tx = dx > 0 ? (HS - x) / dx : dx < 0 ? (-HS - x) / dx : Infinity, ty = dy > 0 ? (HS - y) / dy : dy < 0 ? (-HS - y) / dy : Infinity;
    const seg = Math.min(rem, tx, ty);
    for (const e of S.es) { if (!e.alive || out.has(e)) continue; const ex = e.x - x, ey = e.y - y, al = ex * dx + ey * dy; if (al < 0 || al > seg) continue; if (Math.abs(ex * dy - ey * dx) <= width / 2 + e.r) out.set(e, mult); }
    x += dx * seg; y += dy * seg; rem -= seg; if (tx <= ty) dx = -dx; else dy = -dy; mult *= falloff;
  }
  return [...out.entries()];
}
function bestLine(S, len, width, bounces, falloff) {
  let best = 0, ba = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 90) { const h = lineHits(S, S.caster.x, S.caster.y, a, len, width, bounces, falloff); const v = h.reduce((s, [e]) => s + e.cost, 0); if (v > best) { best = v; ba = a; } }
  return ba;
}

const U = {};
// Hero
U['Hero Wrecking Run'] = { dur: 3.4, init(S) { S.c = S.caster; }, tick(S) {
  if (S.t < 0.4 || S.ended) return;
  if (S.t >= 3.4) { if (!S.ended) { S.ended = true; for (const e of alive(S)) if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 300 + e.r) S.dmg(e, 500); } return; }
  const wall = steer(S, 900, 6, densest(S, 250, 900));
  for (const e of alive(S)) { if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 22 + e.r && (S.t - (e.hitAt.wr ?? -9)) >= 0.5) { e.hitAt.wr = S.t; if (e.d.kami) S.kill(e); else { S.dmg(e, 600); const dx = e.x - S.caster.x, dy = e.y - S.caster.y, dd = Math.hypot(dx, dy) || 1; e.vx += dx / dd * 700; e.vy += dy / dd * 700; } } }
  if (wall) { S.ended = true; S.log.wall = f1(S.t); for (const e of alive(S)) if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 300 + e.r) S.dmg(e, 500); }
} };
U['Hero Carpet Bomb'] = { dur: 3.3 + 0.6, init(S) { S.bombs = []; S.n = 0; }, tick(S) {
  if (S.t >= 0.3 && S.t < 3.3) { steer(S, 640, 10, densest(S, 200, 700)); if (S.t >= 0.3 + S.n * 0.12) { S.n++; S.bombs.push({ x: S.caster.x, y: S.caster.y, at: S.t + 0.6, big: S.n === 25 }); } }
  for (const b of S.bombs) if (!b.done && S.t >= b.at) { b.done = true; const R = b.big ? 220 : 130, D = b.big ? 700 : 420; for (const e of alive(S)) { const dd = Math.hypot(e.x - b.x, e.y - b.y); if (dd < R + e.r) S.dmg(e, D * (1 - 0.6 * Math.min(1, dd / R))); } }
} };
U['Hero EMP Pulse'] = { dur: 2.35, tick(S) { if (!S.done && S.t >= 0.35) { S.done = true; for (const e of alive(S)) if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 420) { S.dmg(e, 0.2 * e.maxHp); e.stun = S.t + 2; } } } };
const ionStorm = (range, R, dur, every, n, dmg, slow, delay = 0, drift = 0) => ({ dur: dur + delay, init(S) { S.c = null; }, tick(S) {
  if (!S.c) { const [x, y] = densest(S, R, range); S.c = { x, y, next: delay }; }
  if (drift && S.t > delay) { const [tx, ty] = densest(S, R, range); const dx = tx - S.c.x, dy = ty - S.c.y, dd = Math.hypot(dx, dy); if (dd > 1) { S.c.x += dx / dd * Math.min(dd, drift * DT); S.c.y += dy / dd * Math.min(dd, drift * DT); } }
  const inside = alive(S).filter((e) => Math.hypot(e.x - S.c.x, e.y - S.c.y) < R);
  for (const e of inside) e.slow = slow;
  if (S.t >= S.c.next && S.t < dur + delay) { S.c.next += every; inside.sort((a, b) => Math.hypot(a.x - S.c.x, a.y - S.c.y) - Math.hypot(b.x - S.c.x, b.y - S.c.y)); for (const e of inside.slice(0, n)) S.dmg(e, dmg); }
} });
U['Hero Ion Storm'] = ionStorm(700, 300, 6, 0.25, 8, 100, 0.6, 0.5);
const eventHorizon = (dur, R, A, nudge, crush, crushKami, horizon, floor, capV, bigTake, delay = 0) => ({ dur: dur + delay, tick(S) {
  if (S.t < delay) return;
  const cx = S.caster.x, cy = S.caster.y;
  S.pull = [cx, cy, R, A, nudge, capV, floor];
  for (const e of alive(S)) { const dd = Math.hypot(e.x - cx, e.y - cy); if (dd < horizon + e.r) S.dmg(e, (e.r >= 30 ? bigTake : e.d.kami ? crushKami : crush) * DT); }
} });
U['Hero Event Horizon'] = { ...eventHorizon(5, 560, 1200, 30, 1500, 1500, 16 + 70, null, null, 300, 0.3), note: 'caster = Arcanist' };
U['Hero Hyperlance'] = { dur: 1.5, init(S) { S.n = 0; }, tick(S) { if (S.n < 3 && S.t >= 0.45 * (S.n + 1)) { S.n++; const a = bestLine(S, 1500, 24, 2, 0.8); for (const [e, m] of lineHits(S, S.caster.x, S.caster.y, a, 1500, 24, 2, 0.8)) S.dmg(e, 900 * m); } } };
const carrier = (dur, n, dmg, cd, range, delay = 0) => ({ dur: dur + delay, init(S) { S.dr = Array.from({ length: n }, (_, i) => ({ next: delay + i * cd / n })); }, tick(S) {
  for (const d of S.dr) if (S.t >= d.next && S.t < dur + delay) { d.next += cd; let best = null, bd = range; for (const e of alive(S)) { const dd = Math.hypot(e.x - S.caster.x, e.y - S.caster.y); if (dd < bd) { bd = dd; best = e; } } if (best) S.dmg(best, dmg); }
} });
U['Hero Drone Carrier'] = carrier(10, 6, 60, 0.4, 550, 0.3);
// Arcade
U['Arcade Event Horizon'] = eventHorizon(5, 520, 1200, 0, 900, 900, 22 + 70, 0.35, 450, 900, 0.3);
U['Arcade Ion Storm'] = ionStorm(520, 240, 6, 0.25, 4, 70, 0.7);
U['Arcade Ion Storm Supercell'] = ionStorm(520, 240, 6, 0.25, 6, 70, 0.7, 0, 140);
U['Arcade Overload Pulse'] = { dur: 1.85, tick(S) { if (!S.done && S.t >= 0.35) { S.done = true; for (const e of alive(S)) if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 340) { S.dmg(e, 150); e.stun = S.t + (e.elite ? 1 : 1.5); } } } };
// Sortie
U['Sortie Event Horizon'] = eventHorizon(5, 520, 1200, 30, 600, 1500, 22 + 70, null, null, 600);
U['Sortie Carpet Bomb'] = { dur: 3.2 + 1.5, init(S) { S.bombs = []; S.n = 0; S.caps = new Map(); }, tick(S) {
  if (S.t < 3.2) { steer(S, 768, 10, densest(S, 200, 700)); if (S.t >= S.n * 0.2) { S.n++; S.bombs.push({ x: S.caster.x, y: S.caster.y, arm: S.t + 0.4, t0: S.t }); } }
  for (const b of S.bombs) {
    if (b.done || S.t < b.arm) continue;
    const near = alive(S).some((e) => Math.hypot(e.x - b.x, e.y - b.y) < 30 + e.r);
    const expire = S.t - b.t0 >= 1.5 + 4;
    if (near || expire) { b.done = true; for (const e of alive(S)) { const dd = Math.hypot(e.x - b.x, e.y - b.y); if (dd < 110 + e.r) { const k = S.caps.get(e) ?? 0; if (k < 3) { S.caps.set(e, k + 1); S.dmg(e, 260 * (1 - 0.6 * Math.min(1, dd / 110))); } } } }
  }
} };
U['Sortie Rampage'] = { dur: 5, tick(S) {
  steer(S, 832, 13, densest(S, 250, 900));
  for (const e of alive(S)) if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 22 + e.r && (S.t - (e.hitAt.rp ?? -9)) >= 0.5) { e.hitAt.rp = S.t; if (e.d.kami) S.kill(e); else { S.dmg(e, 450); const dx = e.x - S.caster.x, dy = e.y - S.caster.y, dd = Math.hypot(dx, dy) || 1; e.vx += dx / dd * 700; e.vy += dy / dd * 700; } }
} };
U['Sortie Ion Storm'] = ionStorm(600, 260, 6, 0.25, 4, 90, 0.7, 0, 70);
U['Sortie Hyperlance'] = { dur: 1.2, tick(S) { if (!S.done && S.t >= 1.0) { S.done = true; const a = bestLine(S, 2600, 24, 1, 1); for (const [e] of lineHits(S, S.caster.x, S.caster.y, a, 2600, 24, 1, 1)) S.dmg(e, 2500); } } };
U['Sortie Black Star'] = { dur: 5.8, init(S) { S.bs = null; }, tick(S) {
  if (!S.bs) { const [x, y] = densest(S, 300, 700); S.bs = { x, y, land: Math.hypot(x - S.caster.x, y - S.caster.y) / 900 }; }
  const b = S.bs; if (S.t < b.land) return;
  const age = S.t - b.land; if (age > 5) { if (!b.boom) { b.boom = true; for (const e of alive(S)) if (Math.hypot(e.x - b.x, e.y - b.y) < 260 + e.r) S.dmg(e, 900); } return; }
  const R = 200 + 220 * age / 5; S.pull = [b.x, b.y, R, 1100, 0, null, null];
  for (const e of alive(S)) if (Math.hypot(e.x - b.x, e.y - b.y) < 60 + e.r) { if (e.d.kami) S.kill(e); else S.dmg(e, 1000 * DT); }
} };
U['Sortie EMP Pulse'] = { dur: 1.85, tick(S) { if (!S.done && S.t >= 0.35) { S.done = true; for (const e of alive(S)) if (Math.hypot(e.x - S.caster.x, e.y - S.caster.y) < 340) { S.dmg(e, 150); e.stun = S.t + 1.5; } } } };
U['Sortie Drone Carrier'] = carrier(12, 6, 60, 0.5, 450);

log(H('S2-B. Swarm clear %: ult alone vs a floor-3 sealed-room pulse (6-pilot party at the centre, ~60 drone-equivalents incl. brutes/elites, heat speed x1.18)'));
log('Damage is x hpScale in every kit, so the % is floor-invariant (except Sortie\'s pveScale cap of 4, table below). Kamikazes that reach a hull die there (not counted as ult clears).');
log('Parry weapons are OFF: this is the ult\'s own share. Clear % = ult-killed DE / (pulse DE + splitlings spawned). 6 seeds.');
const B = []; const EHC = {};
for (const [name, u] of Object.entries(U)) {
  const rs = [1, 2, 3, 4, 5, 6].map((sd) => swarmRun(u, sd));
  const m = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  B.push([name, f1(u.dur) + ' s', pct(m((r) => r.clear)), f1(m((r) => r.killed)), f1(m((r) => r.suicided)), f1(m((r) => r.contactsOnCaster)), u.note ?? '']);
  if (name.includes('Event Horizon')) {
    const rf = [1, 2, 3, 4, 5, 6].map((sd) => swarmRun(u, sd, { casterPos: [260, 0], casterR: name.startsWith('Hero') ? 16 : 22 }));
    const mf = (f) => rf.reduce((a, r) => a + f(r), 0) / rf.length;
    B.push([name + ' (parked 260 px out)', f1(u.dur) + ' s', pct(mf((r) => r.clear)), f1(mf((r) => r.killed)), f1(mf((r) => r.suicided)), f1(mf((r) => r.contactsOnCaster)), 'owner fantasy: alone on the event horizon']);
    EHC[name] = mf((r) => r.contactsOnCaster);
  }
}
log(table(['ult', 'window', 'clear % (DE)', 'bodies killed', 'kamikazes on hulls', 'on the caster', 'note'], B));
fs.writeFileSync(new URL('./s2_swarm.json', import.meta.url), JSON.stringify(Object.fromEntries(B.map((r) => [r[0], parseInt(r[2], 10) / 100]))));
log('Utility-only ults (Lifeline, Citadel, Nanite Surge) clear 0% by design; EMP-type ults are CC (stun) rather than clear.');
{
  // kamikaze contact eaten by the EH owner (x0.5 in every kit; Hero adds 25% hardening; Arcade/Sortie owners can Polarize: 40% chip)
  const contactF = (f) => 110 * (1 + 0.04 * (2 * f - 2)) * (1 + 0.15 * (1.3 + 0.15 * (f - 1) + 0.6 - 1));
  for (const [nm, ownerCls, h] of [['Hero Event Horizon', 'tech', 0.25], ['Sortie Event Horizon', 'brute', 0.5]]) {
    const n = EHC[nm] ?? 0;
    for (const f of [3, 6]) {
      const per = contactF(f) * 0.5 * (1 - h) * (ownerCls === 'brute' ? 0.8 : 1);
      const tot = n * per, c = CLASSES[ownerCls], ehp = (ownerCls === 'tech' ? 380 + 420 : 500 + 900 / (1 - 0.4));
      log(`${nm} parked forward, floor ${f}: ~${f1(n)} kamikaze contacts on the owner x ${f0(per)} = ${f0(tot)} contact damage vs owner EHP ~${f0(ehp)} (${pct(tot / ehp)}).`);
      if (ownerCls === 'tech' && tot > 0.6 * ehp) flag('hero', 'MED', 'Event Horizon owner is the glass cannon', `Hero puts the ship-centred black hole on the Arcanist (380/420): parked alone it eats ~${f1(n)} kamikaze contacts in 5 s (${f0(tot)} dmg on floor ${f}, ${pct(tot / ehp)} of its EHP) plus the pulled swarm; the other two kits give EH to the Juggernaut (armor 0.4 + Polarize).`);
    }
  }
}
// flags from the swarm table
for (const row of B) {
  const v = parseInt(row[2], 10);
  if (v >= 60) flag(row[0].split(' ')[0].toLowerCase(), 'MED', `${row[0]} clears ${row[2]} of a floor-3 pulse alone`, 'hpScale-relative damage keeps this true on every floor: with ~5 party ults/min a 6-pilot party can delete most pulses without weapons; re-run riftParity with ults on.');
}
// pveScale cap (Sortie)
log('\nSortie pveScale cap 4 (min(4, maxHp/baseHp)): hpScale = tierHp x partyHp x heat hp (variant C ramp), n=6; share of full ult damage that survives the cap:');
const capRows = [];
for (const diff of [['Veteran', 1], ['Nightmare', 1.4]]) for (const f of [1, 3, 6, 9]) {
  const tier = 1 + 2 * (f - 1), tierHp = 1 + 0.08 * (tier - 1), pHp = 1 + 0.15 * 5;
  const Hh = Math.min(5, 1.3 + 0.15 * (f - 1) + 0.3 * 2 + 0.02 * 4 + 0.05 * 3); const heatHp = 1 + 0.15 * (Hh - 1);
  const s = tierHp * pHp * heatHp * diff[1];
  capRows.push([diff[0], 'f' + f, f2(s), pct(Math.min(1, 4 / s))]);
}
log(table(['difficulty', 'floor', 'hpScale (n6, mid-floor)', 'Sortie ult damage kept'], capRows));
flag('sortie', 'LOW', 'pveScale cap 4 bites from Veteran floor 6 / Nightmare floor 3', 'Ults (and R items) lose 10-45% of their relative power exactly where the Geometry Wars ramp peaks; either lift the cap to 6 or accept that late floors need weapons more.');

// =====================================================================================================================
// S2-C. Event Horizon (and Black Star) on players: escape vs pull, crush and the anchored owner's guns
// =====================================================================================================================
log(H('S2-C. Event Horizon vs ships (CR movement, reaction 0.25 s, then full thrust outward; boost if the kit allows and power > 0)'));
log('Target starts at rest at d0 from the anchored owner. "guns" adds the owner\'s LMB (Hero: Arcanist Laser 1265 px; Arcade/Sortie: Juggernaut MD 468 px, falloff) with 100% hits.');
const EH = {
  hero: { owner: 'tech', R: 560, pull: (d, m) => 300, horizon: 16 + 70, crush: 180, dur: 5, boostInside: true, cap: Infinity },
  arcade: { owner: 'brute', R: 520, pull: (d, m) => 300 * (0.35 + 0.65 * (1 - d / 520)) / m, horizon: 22 + 70, crush: 180, dur: 4, boostInside: false, cap: Infinity },
  sortie: { owner: 'brute', R: 520, pull: (d, m) => 260, horizon: 22 + 70, crush: 180, dur: 4, boostInside: true, cap: 600 },
};
function ehEscape(kit, tcls, n, d0, guns) {
  const e = EH[kit], c0 = cOf(kit, tcls);
  const c = { ...c0 };
  const m = n > 0 ? capMass(n) : 1, sm = n > 0 ? hostPen(n) : 1;
  const tg = makeTarget(c, { armor: Math.min(0.7, c.armor + 0.03 * n) });
  const b = { x: d0, y: 0, vx: 0, vy: 0 }; let P = c.P, t = 0, out = -1, inHor = 0;
  const ow = weaponStats(e.owner, e.owner === 'tech' ? 'laser' : 'massdriver');
  for (let k = 0; k < e.dur * TICK && !tg.dead; k++) {
    t = k * DT; const d = Math.abs(b.x);
    const inside = d < e.R;
    if (out < 0 && !inside) out = t;
    const pullA = inside ? Math.min(e.cap, e.pull(d, m)) : 0;
    const react = t >= 0.25;
    const canBoost = react && P > c.ab * DT && (e.boostInside || !inside);
    if (canBoost) P -= c.ab * DT;
    const sg = b.x >= 0 ? 1 : -1;
    moveStep(b, c, { dir: react ? [sg, 0] : null, boost: canBoost, m, sm, ext: [-sg * pullA, 0], impulse: true });
    if (d < e.horizon) { hit(tg, e.crush * DT, 'crush', 0, t); inHor += DT; }
    if (guns && d <= ow.range) hit(tg, rawDps(ow, d) * DT, ow.type, 0, t);
  }
  return { out, dead: tg.dead, deadAt: tg.deadAt, left: left(tg), inHor };
}
const C = [];
for (const kit of KIT_IDS) {
  for (const [lab, tcls, n] of [['Jugg', 'brute', 0], ['Arca', 'tech', 0], ['Arti', 'engineer', 0], ['Dreadnought n1', 'brute', 1], ['Dreadnought n3', 'brute', 3], ['Dreadnought n5', 'brute', 5], ['Spire n5', 'tech', 5], ['Foundry n5', 'engineer', 5]]) {
    const row = [KIT_NAME[kit], lab];
    for (const d0 of [60, 250, 450]) {
      const r = ehEscape(kit, tcls, n, d0, false), g = ehEscape(kit, tcls, n, d0, true);
      row.push(`${r.out >= 0 ? 'out ' + f2(r.out) + ' s' : 'NOT OUT in ' + EH[kit].dur + ' s'}; ${r.left}${r.dead ? '@' + f1(r.deadAt) : ''} | guns ${g.dead ? 'DOWN@' + f1(g.deadAt) : g.left}`);
    }
    C.push(row);
    if (n === 0 || n === 3 || n === 5) {
      const r = ehEscape(kit, tcls, n, 250, false);
      if (r.out < 0) flag(kit, n >= 5 ? 'LOW' : 'MED', `Event Horizon traps ${lab}`, `pull ${kit === 'arcade' ? '300/m with falloff' : EH[kit].pull(0, 1)} px/s^2 > its thrust${EH[kit].boostInside ? ' even boosting' : ' (boost is disabled inside the pull)'}: from 250 px it never leaves in ${EH[kit].dur} s.`);
    }
  }
}
log(table(['kit', 'target', 'from 60 px (in the horizon)', 'from 250 px', 'from 450 px'], C));
log('Cells: time to leave the pull radius; S/I after the ult (crush only); "guns" = same with the owner\'s weapon firing the whole time.');

// ---- E Gravity Well on ships: live deployables.ts pulls hostile ships at the FULL well pull (900; x1.5 with Deep Well), uniform
log('\nGravity Well (the Arcanist E, not an ult) on ships: live stepWell() pulls hostile ships at the full 900 px/s^2 (Deep Well x1.5 = 1350), uniform inside r;');
log('none of the kits changes that, only Sortie caps total hostile pull at SHIP_PULL_CAP 600. From 100 px (inside the 112 px damage core), reaction 0.25 s, boost allowed:');
function gwEscape(kit, tcls, n, d0, pull, R, dur) {
  const c = cOf(kit, tcls), m = n > 0 ? capMass(n) : 1, sm = n > 0 ? hostPen(n) : 1;
  const b = { x: d0, y: 0, vx: 0, vy: 0 }; let P = c.P, out = -1, core = 0;
  for (let k = 0; k < dur * TICK; k++) {
    const t = k * DT, d = Math.abs(b.x);
    if (d >= R) { out = t; break; }
    const react = t >= 0.25, boost = react && P > c.ab * DT; if (boost) P -= c.ab * DT;
    const sg = b.x >= 0 ? 1 : -1;
    moveStep(b, c, { dir: react ? [sg, 0] : null, boost, m, sm, ext: [-sg * (kit === 'sortie' ? Math.min(600, pull) : pull), 0], impulse: true });
    if (d < R * 0.4) core += DT;
  }
  return { out, core };
}
const GW = [];
for (const kit of KIT_IDS) for (const [lab, tcls, n] of [['Jugg', 'brute', 0], ['Arca', 'tech', 0], ['Arti', 'engineer', 0], ['Dreadnought n3', 'brute', 3]]) {
  const a = gwEscape(kit, tcls, n, 100, 900, 280, 3), b = gwEscape(kit, tcls, n, 100, 1350, 364, 5);
  GW.push([KIT_NAME[kit], lab, a.out >= 0 ? `out ${f2(a.out)} s (${f1(a.core)} s in the core)` : `NOT OUT in 3 s (${f1(a.core)} s in the core)`, b.out >= 0 ? `out ${f2(b.out)} s` : 'NOT OUT in 5 s']);
  if (tcls === 'brute' && (b.out < 0 || a.out < 0)) flag(kit, 'MED', `Gravity Well (E) traps the ${lab}`, `the E well pulls hostile ships at the full well pull (live stepWell, uniform): base 900 px/s^2 for 3 s ${a.out < 0 ? 'holds' : 'lets out after ' + f2(a.out) + ' s'} the ${lab}; Void + Deep Well (1350, r364, 5 s) ${b.out < 0 ? 'holds it the whole 5 s' : 'lets it out after ' + f2(b.out) + ' s'} even boosting (CR Jugg thrust 620, x1.5 boost = 930). A 6.5-10 s-cooldown SPECIAL out-pulls the Event Horizon ultimate (260-300 on ships). Cap well ship pull at ~300 or apply Sortie's SHIP_PULL_CAP.`);
}
log(table(['kit', 'target', 'base well (900, r280, 3 s)', 'Void + Deep Well (1350, r364, 5 s)'], GW));

// ---- EH on a swarm: pull reach check
log('\nEvent Horizon on the swarm (from S2-B, same pulse): see the "Hero/Arcade/Sortie Event Horizon" rows. Kamikaze crossing check:');
for (const [kit, crushK, hor, capV] of [['Hero', 1500, 86, null], ['Arcade', 900, 92, 450], ['Sortie', 1500, 92, null]]) {
  const band = hor - 22 - 13; // horizon ring to hull contact for a drone
  const vIn = capV ?? (175 * SPEED_MULT + 1200 / 3);
  const tCross = band / vIn, tDie = 160 / crushK;
  log(`${kit}: drone crosses the ${f0(band)} px crush band in ~${f2(tCross)} s at ~${f0(vIn)} px/s, dies in ${f2(tDie)} s -> ${tDie <= tCross ? 'dies on the ring' : 'REACHES THE HULL (contact x0.5)'}; elite drone (480 hp) ${f2(480 / crushK)} s.`);
  if (tDie > tCross) flag(kit.toLowerCase(), 'LOW', 'Event Horizon: kamikazes reach the hull', `crush ${crushK}/s kills a drone in ${f2(tDie)} s but it crosses the ${f0(band)} px band in ${f2(tCross)} s; elites x3 HP always reach the hull.`);
}

fs.writeFileSync(new URL('./s2_ultimpact.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s2_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
