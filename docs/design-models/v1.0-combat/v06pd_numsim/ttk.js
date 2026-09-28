// 1v1 time-to-kill: attacker (full reactor model) vs a passive defender (full layer model), fixed distance.
'use strict';
const K = require('./core');
const { TICK, DT, CLASSES, CLS, SHORT, WPN, WSHORT, makeShip, reactorTick, damageShip, mdFalloff, fmt, pad, padr, AUTO_VS_SHIP } = K;

/**
 * policy: 'P' primary held (commit), 'PF' feather 90/40 until target shield 0, 'PS' primary + secondary on cd,
 *         'BURST' items (2 bombs) + all damaging skills + P + S, 'EMP' EMP opener (d ≤ 260) then P + S.
 * opts: shieldsDown (defender starts at S 0), acc (hit fraction), maxT s
 */
function duel(att, wid, def, dist, policy, opts = {}) {
  const A = makeShip(att, { weapon: wid, ...(opts.attShip || {}) });
  const D = makeShip(def, { weapon: 'massdriver', ...(opts.defShip || {}) });
  if (opts.shieldsDown) { D.S = 0; D.shieldReady = Math.round(D.st.sb * TICK); }
  const acc = opts.acc ?? 1;
  const maxT = (opts.maxT ?? 60) * TICK;
  const q = []; // pending hits {t, amount, type}
  let accum = 0, bombs = 2, itemReady = 0, held = true, sentries = [], wellUntil = -1, empUsed = false;
  const hitScale = (a) => a; // hook
  const addHit = (t, amount, type, isAuto) => { q.push({ t, amount: isAuto ? amount * AUTO_VS_SHIP : amount, type }); };
  const S = policy === 'PS' || policy === 'BURST' || policy === 'EMP';
  for (let t = 0; t < maxT; t++) {
    // feathering
    if (policy === 'PF') { const hi = wid === 'phaser' ? 60 : 90; if (D.S > 0) { if (held && A.heat >= hi) held = false; else if (!held && A.heat < 40) held = true; } else held = true; }
    const inp = { lmb: held && dist <= A.w.range, rmb: S, space: false, thrust: false };
    reactorTick(A, inp, t, {
      onShot: (d, kind) => {
        accum += acc; if (accum < 1 - 1e-9) return; accum -= 1;
        const m = A.w.falloff ? mdFalloff(dist, A.w.range, A.w.falloffFloor) : 1;
        const delay = kind === 'beam' ? 0 : Math.round(dist / A.w.speed * TICK);
        addHit(t + delay, d * m, A.w.dtype);
      },
      spend: (sh, L, sur, tt) => {
        if (policy === 'BURST' || policy === 'EMP') {
          // items: EMP opener (PvP 600 emp, drain 40% power, reactor offline 1.5 s, delay = break + 1 s) if in range
          if (policy === 'EMP' && !empUsed && dist <= 260 && sh.P >= 150 * sur) { sh.P -= 150 * sur; empUsed = true; itemReady = tt + 0.8 * TICK; q.push({ t: tt + 15, emp: true }); }
          if (policy === 'BURST' && bombs > 0 && tt >= itemReady && sh.P >= 120 * sur) { sh.P -= 120 * sur; bombs--; itemReady = tt + 0.8 * TICK; addHit(tt + Math.round(dist / 650 * TICK), 420, 'kinetic'); }
          // mobility / utility damage skills once when ready
          if (att === 'brute' && dist <= 525 && tt >= sh.mobReady && sh.P >= 120 * sur) { sh.P -= 120 * sur; sh.mobReady = tt + 6 * TICK; addHit(tt + Math.round(dist / 1500 * TICK), 400, 'kinetic'); }
          if (att === 'tech' && dist <= 700 && tt >= sh.utilReady && sh.P >= 220 * sur) { sh.P -= 220 * sur; sh.utilReady = tt + 10 * TICK; wellUntil = tt + Math.round((dist / 900) * TICK) + 3 * TICK; }
        }
        if (S && tt >= sh.secReady) {
          const c = sh.c.sec, cost = c.cost * sur;
          if (sh.P >= cost) {
            if (att === 'brute' && dist <= 900) { sh.P -= cost; sh.secReady = tt + c.cd * TICK; for (let i = 0; i < 3; i++) addHit(tt + Math.round(dist / 700 * TICK) + i * 3, 180, 'kinetic'); }
            if (att === 'tech' && dist <= 600) { sh.P -= cost; sh.secReady = tt + c.cd * TICK; addHit(tt, 220, 'energy'); }
            if (att === 'engineer' && dist <= 550 && sentries.length < 2) { sh.P -= cost; sh.secReady = tt + c.cd * TICK; sentries.push({ next: tt + 30 }); }
          }
        }
      },
    });
    for (const se of sentries) if (t >= se.next) { se.next = t + 1.2 * TICK; addHit(t + Math.round(dist / 440 * TICK), 90, 'kinetic', true); }
    if (t < wellUntil && t > wellUntil - 3 * TICK) addHit(t, 120 * DT, 'energy');
    // defender reactor (passive, holding nothing; its shield regen follows the rules)
    reactorTick(D, { lmb: false, thrust: false }, t, {});
    for (let i = q.length - 1; i >= 0; i--) if (q[i].t <= t) {
      const h = q[i]; q.splice(i, 1);
      if (h.emp) { const sd = Math.min(D.S, 600); D.S -= sd; D.P *= 0.6; D.empUntil = t + 1.5 * TICK; D.shieldReady = t + Math.round((D.st.sb + 1) * TICK); continue; }
      damageShip(D, h.amount, h.type, t);
      if (!D.alive) return { t: t / TICK, A, D };
    }
  }
  return { t: Infinity, A, D };
}

const bands = { massdriver: 150, laser: 900, phaser: 500 };
function matrix(title, policy, opts, distOf) {
  console.log(`\n--- ${title} ---`);
  console.log('  attacker weapon @px  →  defender: Jugg        Arca        Arti');
  for (const a of CLS) for (const w of WPN) {
    const d = distOf ? distOf(w) : bands[w];
    const row = CLS.map((df) => { const r = duel(a, w, df, d, policy, opts); return pad(fmt(r.t, 2) + ' s', 10); }).join('  ');
    console.log(`  ${SHORT[a]} ${WSHORT[w]} @${padr(d, 5)}               ${row}`);
  }
}
console.log('=== TTK (1v1, passive defender with its own shield-regen rules, attacker full reactor + heat model) ===');
console.log('Bands: MD 150 px, Laser 900 px, Phaser 500 px. "commit" = hold LMB; accuracy 100% unless stated.');
matrix('A1. Primary only, commit, shields UP, acc 100%', 'P', {});
matrix('A2. Primary only, commit, shields UP, acc 60% (projectiles realistic; laser time-on-target)', 'P', { acc: 0.6 });
matrix('A3. Primary only, feather 90/40 until shield breaks, shields UP, acc 100%', 'PF', {});
matrix('A4. Primary only, commit, shields DOWN (e.g. after an EMP or a Phaser strip), acc 100%', 'P', { shieldsDown: true });
matrix('B1. Primary + secondary (L2 surcharge), shields UP, acc 100%', 'PS', {});
matrix('B2. Primary + secondary, shields UP, acc 60%', 'PS', { acc: 0.6 });
matrix('B3. Primary + secondary, shields DOWN, acc 100%', 'PS', { shieldsDown: true });
matrix('C1. BURST: 2 bombs + damaging Space/E skill + primary + secondary, shields UP, acc 100% (MD @150, LZ 500 px for the well/ram, PH 500)', 'BURST', {}, (w) => (w === 'laser' ? 500 : bands[w]));
matrix('C2. EMP opener @200 px then primary + secondary, shields UP, acc 100%', 'EMP', {}, () => 200);

console.log('\n=== D. Juggernaut vs Arcanist burst (both directions), per weapon and distance ===');
for (const [a, d] of [['brute', 'tech'], ['tech', 'brute']]) for (const w of WPN) {
  const row = [100, 200, 300, 450, 600, 900].map((dist) => {
    const r = duel(a, w, d, dist, 'BURST', {}); const p = duel(a, w, d, dist, 'P', {});
    return `${dist}: ${fmt(r.t, 2)}/${fmt(p.t, 2)}`;
  }).join('  ');
  console.log(`  ${SHORT[a]}→${SHORT[d]} ${WSHORT[w]} (burst/primary-only, s):  ${row}`);
}
// the canonical Juggernaut opener: Ram + Rocket Salvo only (no primary, no bombs)
function opener(att, def, parts, dist) {
  const D = makeShip(def); let t = 0; const log = [];
  for (const [amt, type, delay] of parts) { damageShip(D, amt, type, 0); log.push(`${amt} ${type} → S ${fmt(D.S, 0)} I ${fmt(D.I, 0)}`); if (!D.alive) return { dead: true, log }; }
  return { dead: false, log };
}
const r1 = opener('brute', 'tech', [[400, 'kinetic'], [180, 'kinetic'], [180, 'kinetic'], [180, 'kinetic']]);
console.log(`  Jugg Ram (400) + Rocket Salvo (3×180) on a full Arcanist: ${r1.dead ? 'DEAD' : 'alive'} — ${r1.log.join(' | ')}`);
const r2 = opener('brute', 'tech', [[420, 'kinetic'], [420, 'kinetic']]);
console.log(`  2 standard-issue bombs on a full Arcanist: ${r2.dead ? 'DEAD' : 'alive'} — ${r2.log.join(' | ')}`);
const r3 = opener('brute', 'engineer', [[420, 'kinetic'], [420, 'kinetic'], [400, 'kinetic']]);
console.log(`  2 bombs + Ram on a full Artificer: ${r3.dead ? 'DEAD' : 'alive'} — ${r3.log.join(' | ')}`);
const r4 = opener('tech', 'brute', [[420, 'kinetic'], [420, 'kinetic'], [220, 'energy'], [360, 'energy']]);
console.log(`  Arcanist 2 bombs + Arc + full well (360) on a full Juggernaut: ${r4.dead ? 'DEAD' : 'alive'} — ${r4.log.join(' | ')}`);

console.log('\n=== E. Mass Driver TTK vs distance (commit, acc 100%, shields up) ===');
for (const a of CLS) {
  const row = CLS.map((df) => `${SHORT[df]} ` + [50, 150, 250, 350, 450].map((d) => fmt(duel(a, 'massdriver', df, d, 'P', {}).t, 1)).join('/')).join('  ');
  console.log(`  ${SHORT[a]} MD @50/150/250/350/450: ${row}`);
}
console.log('\n=== F. Two attackers: Phaser strip + Mass Driver finish (both commit, 100%), vs one attacker MD ===');
function duo(a1, w1, a2, w2, def, d1, d2) {
  const A1 = makeShip(a1, { weapon: w1 }), A2 = makeShip(a2, { weapon: w2 }), D = makeShip(def);
  const q = [];
  for (let t = 0; t < 60 * TICK; t++) {
    for (const [A, d] of [[A1, d1], [A2, d2]]) reactorTick(A, { lmb: d <= A.w.range }, t, { onShot: (x, k) => { const m = A.w.falloff ? mdFalloff(d, A.w.range) : 1; q.push({ t: t + (k === 'beam' ? 0 : Math.round(d / A.w.speed * TICK)), a: x * m, ty: A.w.dtype }); } });
    reactorTick(D, {}, t, {});
    for (let i = q.length - 1; i >= 0; i--) if (q[i].t <= t) { damageShip(D, q[i].a, q[i].ty, t); q.splice(i, 1); if (!D.alive) return t / TICK; }
  }
  return Infinity;
}
for (const df of CLS) {
  console.log(`  vs ${SHORT[df]}: Arca PH@500 + Jugg MD@150 ${fmt(duo('tech', 'phaser', 'brute', 'massdriver', df, 500, 150), 2)} s | 2× Jugg MD@150 ${fmt(duo('brute', 'massdriver', 'brute', 'massdriver', df, 150, 150), 2)} s | 2× Arca LZ@900 ${fmt(duo('tech', 'laser', 'tech', 'laser', df, 900, 900), 2)} s | PH+PH@500 ${fmt(duo('tech', 'phaser', 'engineer', 'phaser', df, 500, 500), 2)} s`);
}
module.exports = { duel };
