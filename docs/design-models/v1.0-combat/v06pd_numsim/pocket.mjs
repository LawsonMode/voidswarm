// Pocket healer / fortress / Spire / v0.x TTK baseline (SCRATCH).
import { DT, CLS, Ship, applyHit, makeGun, falloff, f0, f1, f2, table } from './core.mjs';

const REL = { massdriver: 92, laser: 97, phaser: 85 };
const ACC = { massdriver: 0.6, laser: 0.8, phaser: 0.55 };
const BAND = { massdriver: 200, laser: 700, phaser: 450 };

/** A shooter with bot heat discipline and range-aware secondary (brute rockets / tech arc / engineer sentries skipped). */
function shooter(cls, wid) { const s = new Ship(cls, wid); s._hold = true; s._acc = 0; s._secAt = 0; return s; }
function shoot(s, now, dist, q, target) {
  if (!s.alive) return;
  if (s._hold && s.heat >= REL[s.wid]) s._hold = false; else if (!s._hold && s.heat <= 55) s._hold = true;
  const lmb = s._hold && dist <= s.gun.range;
  const strain = lmb ? 1 : 0;
  s.engines(now, DT, true, false); s.reactor(now, DT);
  for (const p of s.fire(now, DT, lmb, strain, dist)) {
    if (s.gun.beam) p.amt *= ACC[s.wid];
    else { s._acc += ACC[s.wid]; if (s._acc < 1) continue; s._acc -= 1; }
    q.push({ at: now + p.delay, amt: p.amt, type: p.type, to: target });
  }
  if (s.cls === 'brute' && now >= s._secAt && dist <= 1260 && s.pay(now, 150, strain + 1)) {
    s._secAt = now + 1.4; const hits = dist <= 300 ? 3 : dist <= 600 ? 2 : 1;
    for (let i = 0; i < hits; i++) q.push({ at: now + dist / 700 + 0.03 * i, amt: 180, type: 'blast', to: target });
  }
  s.shieldTick(now, DT, strain, false);
}

// ---------------------------------------------------------------------------------------------
console.log('== P1. Pocket healer: target Juggernaut (fighting back) rayed by an Artificer; attackers at their band, bot discipline, realistic acc');
console.log('   Ray: 120 hull/s x healMult below full hull; at full hull +220 shield/s and a jump-start every 6-tick payout (J = jump-start honoured, i.e. own regen may run under fire).');
const rayCases = [['no healer', 0, false], ['Ray base, no jump', 1, false], ['Ray base + jump-start', 1, true], ['Medic Ray + jump', 1.4, true], ['Medic+Medkit5 Ray + jump', 2.45, true], ['2 Medic Rays + jump', 2.8, true]];
const attackers = [
  ['1x Jugg MD', [['brute', 'massdriver']]],
  ['1x Arc Laser', [['tech', 'laser']]],
  ['2x (Jugg MD + Art Phaser)', [['brute', 'massdriver'], ['engineer', 'phaser']]],
  ['3x (MD + Laser + Phaser)', [['brute', 'massdriver'], ['tech', 'laser'], ['engineer', 'phaser']]],
];
const rows = [];
for (const [an, list] of attackers) {
  const row = [an];
  for (const [nm, hm, jump] of rayCases) {
    const T = shooter('brute', 'massdriver');
    const A = list.map(([c, w]) => shooter(c, w));
    const q = []; let now = 0, payT = 0, killedAttackers = 0;
    while (now < 60 && T.alive && A.some((a) => a.alive)) {
      for (const a of A) shoot(a, now, BAND[a.wid], q, T);
      // target shoots the first alive attacker at that attacker's band distance
      const foe = A.find((a) => a.alive); if (foe) shoot(T, now, BAND[foe.wid], q, foe);
      if (hm > 0) {
        payT += DT;
        if (payT >= 0.1 - 1e-9) {
          payT = 0;
          if (T.H < T.Hmax - 1e-6) T.H = Math.min(T.Hmax, T.H + 120 * hm * 0.1);
          else { T.S = Math.min(T.Smax, T.S + 220 * Math.min(hm, 1.4) * 0.1); if (jump) T.regenAt = Math.min(T.regenAt, now); }
        }
      }
      for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) { applyHit(q[i].to, q[i].amt, q[i].type, now); q.splice(i, 1); }
      now += DT;
    }
    const aDead = A.filter((a) => !a.alive).length;
    row.push(T.alive ? (aDead === A.length ? `Jugg WINS ${f1(now)}s` : `survives 60s`) : `dies ${f1(now)}s${aDead ? ` (-${aDead})` : ''}`);
  }
  rows.push(row);
}
console.log(table(rows, ['attackers vs rayed Jugg', ...rayCases.map((c) => c[0])]));

// ---------------------------------------------------------------------------------------------
console.log('\n== P2. Dreadnought fortress under focus fire (tick sim). Host = Bulwark+Titan Jugg with Shield Booster 5 / Reinforced Hull 5 / Plating 5; attackers at band, bot discipline, realistic acc');
function fortress(nTurrets, welders, braces, polar, attackersList) {
  const mods = { shield: 1.3 * 1.2 * 1.6 * (1 + 0.08 * nTurrets), hull: 1.2 * 1.2 * 1.6, armorAdd: 0.25 + 0.03 * nTurrets };
  const T = new Ship('brute', 'massdriver', mods);
  if (nTurrets === 0) { T.Smax = 800 * 1.3 * 1.2 * 1.6; T.S = T.Smax; }
  T.brace = braces > 0 ? 0.5 : 0;
  const A = attackersList.map(([c, w]) => shooter(c, w));
  const q = []; let now = 0, payT = 0, polarUntil = 0, polarCd = 0;
  while (now < 120 && T.alive) {
    for (const a of A) shoot(a, now, BAND[a.wid], q, T);
    T.reactor(now, DT);
    if (polar && now >= polarCd && T.S > 0) { polarUntil = now + 5; polarCd = now + 9; }
    T.absorb = polar && now < polarUntil && T.S > 0 ? 0.4 : 0;
    if (welders > 0) {
      payT += DT;
      if (payT >= 0.1 - 1e-9) {
        payT = 0;
        if (T.H < T.Hmax - 1e-6) T.H = Math.min(T.Hmax, T.H + 140 * welders * 0.1);
        else { T.S = Math.min(T.Smax, T.S + 200 * welders * 0.1); T.regenAt = Math.min(T.regenAt, now); }
      }
    }
    T.shieldTick(now, DT, 0, false);
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) { const r = applyHit(T, q[i].amt, q[i].type, now); if (r.broke) polarUntil = Math.min(polarUntil, now); q.splice(i, 1); }
    now += DT;
  }
  return T.alive ? '>120 s (unkillable)' : `${f1(now)} s`;
}
const three = [['brute', 'massdriver'], ['tech', 'laser'], ['engineer', 'phaser']];
const six = [...three, ...three];
const fr = [];
for (const [nm, n, w, b, p] of [
  ['plain Jugg (base stats)', -1, 0, 0, false],
  ['max-card Jugg, no turrets', 0, 0, 0, false],
  [' + Polarize', 0, 0, 0, true],
  ['Dreadnought n=2: 2 Art welders', 2, 2, 0, false],
  ['Dreadnought n=3: 2 welders + 1 Jugg brace', 3, 2, 1, false],
  ['Dreadnought n=5: 3 welders + 2 braces + Polarize', 5, 3, 2, true],
]) {
  const run = (list) => {
    if (n === -1) { const T = new Ship('brute'); const A = list.map(([c, wd]) => shooter(c, wd)); const q = []; let now = 0; while (now < 120 && T.alive) { for (const a of A) shoot(a, now, BAND[a.wid], q, T); T.reactor(now, DT); T.shieldTick(now, DT, 0, false); for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) { applyHit(T, q[i].amt, q[i].type, now); q.splice(i, 1); } now += DT; } return T.alive ? '>120 s' : `${f1(now)} s`; }
    return fortress(n, w, b, p, list);
  };
  fr.push([nm, run([['brute', 'massdriver']]), run(three), run(six)]);
}
console.log(table(fr, ['host', 'vs 1 Jugg MD', 'vs 3 (MD+Laser+Phaser)', 'vs 6']));
console.log('   (the host does not shoot back; welders heal 140 hull/s each, then 200 shield/s + jump-start; Brace x0.5; turret power: weld 180/s vs 450/s docked reactor = indefinite)');

// ---------------------------------------------------------------------------------------------
console.log('\n== P3. Spire (Arcanist host) laser resonance under the host-power rule (offense stops below 20% host power)');
for (const n of [1, 2, 3, 5]) {
  const res = Math.pow(1.5, n - 1);
  const dps = 260 * res * n, draw = 90 * res * n;
  const usable = 1300 * 0.8, net = draw - 230;
  const burstT = net > 0 ? usable / net : Infinity;
  const burstDmg = Number.isFinite(burstT) ? dps * burstT : Infinity;
  const sustained = net > 0 ? dps * 230 / draw : dps;
  const oc = 260 * Math.pow(1.5, n) * n;
  console.log(`  ${n} lasers: ${f0(dps)} DPS, host draw ${f0(draw)}/s -> ${Number.isFinite(burstT) ? `burst ${f2(burstT)} s = ${f0(burstDmg)} dmg, then ~${f0(sustained)} DPS at the reactor rate` : 'sustainable'}; Overcharge (free +1 counted) ${f0(oc)} DPS; Jugg EHP 2326 deleted in ${f2(2326 / dps)} s (${f2(2326 / oc)} s overcharged)`);
}

// ---------------------------------------------------------------------------------------------
console.log('\n== P4. v0.x TTK baseline (energy = health = ammo, recharge on while hit) vs v1.0, same accuracy model');
const V0 = {
  brute: { E: 1800, rech: 230, armor: 0.1, dmg: 140, cd: 11 / 60, cost: 32, name: 'Autocannon' },
  tech: { E: 1100, rech: 290, armor: 0, dmg: 115, cd: 9 / 60, cost: 28, name: 'Plasma' },
  engineer: { E: 1300, rech: 260, armor: 0, dmg: 70, cd: 6 / 60, cost: 18, name: 'Rivet' },
};
const rows4 = [];
for (const a of ['brute', 'tech', 'engineer']) {
  const row = [`${V0[a].name} (${a})`];
  for (const t of ['brute', 'tech', 'engineer']) {
    const cell = [];
    for (const acc of [1, 0.6]) {
      let E = V0[t].E, now = 0, cd = 0, accA = 0, ea = V0[a].E;
      while (E >= 0 && now < 60) {
        E = Math.min(V0[t].E, E + V0[t].rech * DT);
        ea = Math.min(V0[a].E, ea + V0[a].rech * DT);
        cd -= DT;
        if (cd <= 1e-9 && ea > V0[a].cost) { cd += V0[a].cd; ea -= V0[a].cost; accA += acc; if (accA >= 1) { accA -= 1; E -= V0[a].dmg * (1 - V0[t].armor); } }
        now += DT;
      }
      cell.push(E < 0 ? f2(now) : '∞');
    }
    row.push(cell.join(' / '));
  }
  rows4.push(row);
}
console.log(table(rows4, ['v0.x attacker', 'vs Jugg acc1 / acc.6', 'vs Arc', 'vs Art']));
