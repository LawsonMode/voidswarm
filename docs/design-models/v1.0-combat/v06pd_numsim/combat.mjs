// v1.0 "Shields Down" — PvP / power / movement / item / sustain checks (SCRATCH).
import {
  DT, CLS, CLASS_IDS, SHORT, WPN, WEAPON_IDS, DEFAULT_WEAPON, TUNE, makeGun, falloff, hotMult, Ship, applyHit, ehp,
  STRAIN_DRAW, STRAIN_MOVE, STRAIN_SHIELD, SM, HM, ARMOR_CAP, f0, f1, f2, table,
} from './core.mjs';

const H = (s) => console.log(`\n${'='.repeat(100)}\n== ${s}\n${'='.repeat(100)}`);
const only = process.argv[2];
const want = (k) => !only || only.split(',').includes(k);

// ---------------------------------------------------------------------------------------------
// Secondary skills as damage sources (RMB held = auto-repeat at cooldown, strain counts it)
// ---------------------------------------------------------------------------------------------
function secondaryTick(s, now, dt, strain, dist, st, opt) {
  const out = [];
  const c = s.cls;
  if (c === 'brute') {
    if (now >= (st.secAt ?? 0) && dist <= 1260 && s.pay(now, 150, strain)) {
      st.secAt = now + 1.4;
      const hits = opt.rocketHits === 'auto' ? (dist <= 300 ? 3 : dist <= 600 ? 2 : 1) : (opt.rocketHits ?? 3);
      for (let i = 0; i < hits; i++) out.push({ amt: 180, type: 'blast', delay: dist / 700 + 0.02 * i });
    }
  } else if (c === 'tech') {
    if (now >= (st.secAt ?? 0) && dist <= 600 && s.pay(now, 130, strain)) { st.secAt = now + 1.1; out.push({ amt: 220, type: 'energy', delay: 0 }); }
  } else {
    // sentries: deploy on cooldown (max 2 alive, 15 s life), each fires 90 blast every 1.2 s within 550 px
    st.sentries = (st.sentries ?? []).filter((x) => x.until > now);
    if (now >= (st.secAt ?? 0) && s.pay(now, 200, strain)) {
      st.secAt = now + 3;
      if (st.sentries.length >= 2) st.sentries.shift();
      st.sentries.push({ until: now + 15, nextAt: now + 1.2 });
    }
    for (const x of st.sentries) {
      if (now >= x.nextAt) { x.nextAt += 1.2; if (dist <= 550) out.push({ amt: 90, type: 'blast', delay: dist / 600 }); }
    }
  }
  return out;
}

/**
 * Generic fight. Each side: { ship, lmb, rmb, space, thrust, acc, rocketHits }. dist fixed. B may be passive.
 * Returns time B dies (or A), plus logs.
 */
function fight(A, B, dist, opt = {}) {
  const T = opt.maxT ?? 60;
  const q = []; // pending packets {at, amt, type, to}
  const stA = {}, stB = {};
  const acc = { A: 0, B: 0 };
  let now = 0;
  const log = { firstBreak: { A: null, B: null }, gatedHits: 0, gatedDmg: 0 };
  const side = (me, st, key, tgt) => {
    const s = me.ship;
    if (!s.alive) return;
    if (me.smart) {
      const rel = { massdriver: 92, laser: 97, phaser: 85 }[s.wid];
      const inRange = dist <= s.gun.range;
      if (me._hold === undefined) me._hold = true;
      if (me._hold && s.heat >= rel) me._hold = false; else if (!me._hold && s.heat <= 55) me._hold = true;
      me.lmb = inRange && me._hold;
      const secR = { brute: 1260, tech: 600, engineer: 550 }[s.cls];
      me.rmb = dist <= secR;
    }
    const strain = (me.lmb ? 1 : 0) + (me.rmb ? 1 : 0) + (me.space ? 1 : 0);
    s.engines(now, DT, !!me.thrust, false);
    s.reactor(now, DT);
    const pk = s.fire(now, DT, !!me.lmb, strain, dist);
    if (me.rmb) for (const x of secondaryTick(s, now, DT, strain, dist, st, me)) { x.sec = true; pk.push(x); }
    if (me.space && s.cls === 'engineer') s.drain(now, 130, DT, strain); // ray held (no ally: self-repair)
    for (const p of pk) {
      const a = p.sec ? 1 : (me.acc ?? 1);
      if (s.gun.beam && p.type === s.gun.type && p.delay === 0 && a < 1) { p.amt *= a; }
      else if (a < 1) { acc[key] += a; if (acc[key] < 1) continue; acc[key] -= 1; }
      q.push({ at: now + p.delay, amt: p.amt, type: p.type, to: tgt });
    }
    const idle = !me.thrust && !me.lmb && !me.rmb && !me.space && now - s.firedAt >= 0.4;
    s.shieldTick(now, DT, strain, idle);
  };
  while (now < T) {
    side(A, stA, 'A', B.ship);
    if (B.lmb || B.rmb || B.smart) side(B, stB, 'B', A.ship);
    else { const s = B.ship; s.reactor(now, DT); s.shieldTick(now, DT, 0, !B.thrust); }
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].at <= now + 1e-9) {
        const p = q[i]; q.splice(i, 1);
        const r = applyHit(p.to, p.amt, p.type, now);
        if (r.gated) { log.gatedHits++; }
        const k = p.to === B.ship ? 'B' : 'A';
        if (r.broke && log.firstBreak[k] === null) log.firstBreak[k] = now;
      }
    }
    now += DT;
    if (!A.ship.alive || !B.ship.alive) break;
  }
  return { t: now, aDead: !A.ship.alive, bDead: !B.ship.alive, A: A.ship, B: B.ship, log };
}

function ttk(atkCls, wid, tgtCls, dist, o = {}) {
  const A = { ship: new Ship(atkCls, wid, o.amods), lmb: true, rmb: !!o.rmb, thrust: o.thrust ?? true, acc: o.acc ?? 1, rocketHits: o.rocketHits };
  const tB = new Ship(tgtCls, DEFAULT_WEAPON[tgtCls], o.tmods);
  if (o.shieldDown) { tB.S = 0; tB.regenAt = tB.Sbrk; }
  const B = { ship: tB, lmb: false, rmb: false, thrust: true };
  const r = fight(A, B, dist, { maxT: o.maxT ?? 60 });
  return r.bDead ? r.t : Infinity;
}

// =============================================================================================
if (want('sheet')) {
  H('0. Class sheet (spec §1) — EHP vs each damage type from full (ignoring the gate)');
  const rows = CLASS_IDS.map((c) => {
    const k = CLS[c];
    const e = (t) => k.S / (SM[t] * (1 - k.hard)) + k.H / (HM[t] * (1 - Math.min(ARMOR_CAP, k.armor)));
    return [k.name, k.S, k.H, k.armor, k.hard, f0(ehp(k)), f0(e('kinetic')), f0(e('energy')), f0(e('ion')),
      f2(k.S / (k.Sreg)), f2(k.S / (k.Sreg * 0.5)), f2(k.S / (k.Sreg * 1.25))];
  });
  console.log(table(rows, ['class', 'shield', 'hull', 'armor', 'hard', 'EHP(neutral)', 'EHP kinetic', 'EHP energy', 'EHP ion', 'refill s', 'refill firing', 'refill idle']));
}

// =============================================================================================
if (want('dps')) {
  H('1. Weapon DPS vs distance (full rate, raw before type mults) per weapon x class  [also: per-type effective vs shield / hull]');
  const dists = [0, 100, 150, 200, 300, 400, 500, 520, 600, 700, 800, 950, 1100];
  const rows = [];
  for (const wid of WEAPON_IDS) for (const c of CLASS_IDS) {
    const g = makeGun(c, wid);
    const base = g.beam ? g.dps : g.dmg / g.cd;
    rows.push([`${WPN[wid].name} (${SHORT[c]})`, f0(g.range), ...dists.map((d) => f0(base * falloff(g, d)))]);
  }
  console.log(table(rows, ['weapon (class)', 'range', ...dists.map((d) => `@${d}`)]));
  console.log('\nEffective DPS at the weapon band (MD 200 / Laser 700 / Phaser 450) vs each target LAYER (type mult, hardness, armor):');
  const band = { massdriver: 200, laser: 700, phaser: 450 };
  const r2 = [];
  for (const wid of WEAPON_IDS) for (const c of CLASS_IDS) {
    const g = makeGun(c, wid);
    const base = (g.beam ? g.dps : g.dmg / g.cd) * falloff(g, band[wid]);
    const row = [`${WPN[wid].name} (${SHORT[c]})`, f0(base)];
    for (const t of CLASS_IDS) {
      const k = CLS[t];
      row.push(`${f0(base * SM[g.type] * (1 - k.hard))} / ${f0(base * HM[g.type] * (1 - k.armor))}`);
    }
    r2.push(row);
  }
  console.log(table(r2, ['weapon (class)', 'raw', 'vs Jugg S/H', 'vs Arc S/H', 'vs Art S/H']));
}

// =============================================================================================
if (want('heat')) {
  H('2. Heat / overheat / burst vs sustained (held LMB vs a dummy at band distance, thrusting, strain 1, own shield full)');
  const band = { massdriver: 200, laser: 700, phaser: 450 };
  const rows = [];
  for (const wid of WEAPON_IDS) for (const c of CLASS_IDS) {
    const s = new Ship(c, wid);
    let now = 0, dmg = 0, d3 = 0, d10 = 0, tHot = null, tMax = null, tShield0 = null, tFirstStop = null;
    let firing = 0, powerSpent = 0; let lastFiredCount = 0;
    const dist = band[wid];
    let prevDmgT = 0;
    let firstBrown = null;
    for (; now < 30; now += DT) {
      s.engines(now, DT, true, false); s.reactor(now, DT);
      const pk = s.fire(now, DT, true, 1, dist);
      for (const p of pk) dmg += p.amt;
      s.shieldTick(now, DT, 1, false);
      if (tHot === null && s.heat >= 60) tHot = now;
      if (tMax === null && s.heat >= 100) tMax = now;
      if (tShield0 === null && s.S <= 0) tShield0 = now;
      if (tFirstStop === null && (s.jam || s.cut || now < s.ventUntil)) tFirstStop = now;
      if (firstBrown === null && s.pf() < 0.25) firstBrown = now;
      if (now < 3) d3 = dmg; if (now < 10) d10 = dmg;
    }
    const g = s.gun;
    rows.push([`${WPN[wid].name} (${SHORT[c]})`, f2(tHot), f2(tMax), tShield0 === null ? '-' : f1(tShield0), f1(tFirstStop), firstBrown === null ? 'never' : f1(firstBrown),
      f0(d3 / 3), f0(d10 / 10), f0(dmg / 30), `${f0(100 * (dmg / 30) / ((s.gun.beam ? s.gun.dps : s.gun.dmg / s.gun.cd) * falloff(s.gun, dist)))}%`, f0(s.stats.selfShieldDrain), f2(dmg / Math.max(1, s.stats.powerSpentGun)), f0(s.P)]);
  }
  console.log(table(rows, ['weapon (class)', 't hot(60)', 't 100', 't own S=0', 't 1st jam/cut/vent', 't brownout', 'DPS 0-3s', 'DPS 0-10s', 'DPS 0-30s', 'sust/max', 'own S drained', 'dmg/power', 'P left']));
  console.log('\nBot heat discipline (§14: release MD at 92, Laser 97, Phaser 85; resume at 55 assumed) — sustained DPS over 30 s:');
  const rel = { massdriver: 92, laser: 97, phaser: 85 };
  const rows2 = [];
  for (const wid of WEAPON_IDS) for (const c of CLASS_IDS) {
    const s = new Ship(c, wid); let dmg = 0, holding = true;
    for (let now = 0; now < 30; now += DT) {
      if (holding && s.heat >= rel[wid]) holding = false; else if (!holding && s.heat <= 55) holding = true;
      s.engines(now, DT, true, false); s.reactor(now, DT);
      for (const p of s.fire(now, DT, holding, holding ? 1 : 0, band[wid])) dmg += p.amt;
      s.shieldTick(now, DT, holding ? 1 : 0, false);
    }
    rows2.push([`${WPN[wid].name} (${SHORT[c]})`, f0(dmg / 30), `${f0(100 * (dmg / 30) / ((s.gun.beam ? s.gun.dps : s.gun.dmg / s.gun.cd) * falloff(s.gun, band[wid])))}%`, f0(s.stats.selfShieldDrain)]);
  }
  console.log(table(rows2, ['weapon (class)', 'DPS 30s (bot)', 'sust/max', 'own S drained']));
}

// =============================================================================================
if (want('ttk')) {
  H('3. TTK (s) from full, attacker holds fire, thrusting; target passive but regenerates by the rules. P = primary only, P+S = primary + secondary (strain 2).');
  console.log('   distance = weapon band (MD 200, Laser 700, Phaser 450). "dn" = target starts with shield broken (S = 0, break delay running). acc = 1 (theoretical).');
  const band = { massdriver: 200, laser: 700, phaser: 450 };
  const rows = [];
  for (const c of CLASS_IDS) for (const wid of WEAPON_IDS) {
    const row = [`${SHORT[c]} ${WPN[wid].name}${wid === DEFAULT_WEAPON[c] ? ' *' : ''}`];
    for (const t of CLASS_IDS) {
      const d = band[wid];
      row.push(`${f2(ttk(c, wid, t, d))} | ${f2(ttk(c, wid, t, d, { rmb: true }))} | ${f2(ttk(c, wid, t, d, { shieldDown: true }))} | ${f2(ttk(c, wid, t, d, { rmb: true, shieldDown: true }))}`);
    }
    rows.push(row);
  }
  console.log(table(rows, ['attacker (* default)', 'vs Jugg  P | P+S | P dn | P+S dn', 'vs Arc  P | P+S | P dn | P+S dn', 'vs Art  P | P+S | P dn | P+S dn']));

  console.log('\nSpec §19 distances, primary only, acc 1 (compare with the design table):');
  const rows2 = [];
  const specD = { brute: { massdriver: [100, 300, 500] }, tech: { laser: [800] }, engineer: { phaser: [400, 650] } };
  for (const c of CLASS_IDS) for (const [wid, ds] of Object.entries(specD[c])) {
    rows2.push([`${SHORT[c]} ${WPN[wid].name} @${ds.join('/')}`, ...CLASS_IDS.map((t) => ds.map((d) => f2(ttk(c, wid, t, d))).join(' / '))]);
  }
  console.log(table(rows2, ['attacker', 'vs Jugg', 'vs Arc', 'vs Art']));

  console.log('\nRealistic accuracy (MD 0.6, Laser 0.8 beam-time, Phaser 0.55, rockets 2 of 3), band distance, P / P+S:');
  const accW = { massdriver: 0.6, laser: 0.8, phaser: 0.55 };
  const rows3 = [];
  for (const c of CLASS_IDS) for (const wid of WEAPON_IDS) {
    rows3.push([`${SHORT[c]} ${WPN[wid].name}`, ...CLASS_IDS.map((t) => `${f2(ttk(c, wid, t, band[wid], { acc: accW[wid], rocketHits: 'auto' }))} | ${f2(ttk(c, wid, t, band[wid], { acc: accW[wid], rmb: true, rocketHits: 'auto' }))}`)]);
  }
  console.log(table(rows3, ['attacker', 'vs Jugg P | P+S', 'vs Arc P | P+S', 'vs Art P | P+S']));

  console.log('\nArena DM pace proxy: mean default-weapon TTK over all 9 class pairs, band distance, realistic acc, P+S:');
  let sum = 0, n = 0, jug = 0, jn = 0;
  for (const c of CLASS_IDS) for (const t of CLASS_IDS) {
    const w = DEFAULT_WEAPON[c];
    const x = ttk(c, w, t, band[w], { acc: accW[w], rmb: true, rocketHits: 'auto' });
    sum += x; n++; if (t === 'brute') { jug += x; jn++; }
  }
  console.log(`  mean ${f2(sum / n)} s; vs Juggernaut targets ${f2(jug / jn)} s; v0.x reference ≈ 2.9 s vs an Arcanist (spec)`);
}

// =============================================================================================
if (want('duel')) {
  H('4. Mutual duels, default weapons, both hold P+S, fixed distance, realistic accuracy. Winner (time) and winner hull% left');
  const accW = { massdriver: 0.6, laser: 0.8, phaser: 0.55 };
  const rows = [];
  for (const d of [200, 450, 700, 900]) for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    const a = CLASS_IDS[i], b = CLASS_IDS[j];
    const A = { ship: new Ship(a), lmb: true, rmb: true, thrust: true, acc: accW[DEFAULT_WEAPON[a]], rocketHits: 'auto' };
    const B = { ship: new Ship(b), lmb: true, rmb: true, thrust: true, acc: accW[DEFAULT_WEAPON[b]], rocketHits: 'auto' };
    const r = fight(A, B, d, { maxT: 60 });
    const win = r.aDead && r.bDead ? 'trade' : r.bDead ? SHORT[a] : r.aDead ? SHORT[b] : 'none';
    const w = r.bDead && !r.aDead ? r.A : r.aDead && !r.bDead ? r.B : null;
    rows.push([`${d}px ${SHORT[a]} v ${SHORT[b]}`, win, f2(r.t), w ? `${f0(100 * w.H / w.Hmax)}%` : '-', w ? `${f0(100 * w.S / w.Smax)}%` : '-']);
  }
  console.log(table(rows, ['duel', 'winner', 'time s', 'win hull', 'win shield']));
  console.log('\nSMART duels: LMB only when in range with bot heat discipline (release 92/97/85, resume 55); RMB only inside its range (rockets 1260, arc 600, sentry 550):');
  const rs = [];
  for (const d of [200, 450, 700, 900]) for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const a = CLASS_IDS[i], b = CLASS_IDS[j];
    const A = { ship: new Ship(a), smart: true, thrust: true, acc: accW[DEFAULT_WEAPON[a]], rocketHits: 'auto' };
    const B = { ship: new Ship(b), smart: true, thrust: true, acc: accW[DEFAULT_WEAPON[b]], rocketHits: 'auto' };
    const r = fight(A, B, d, { maxT: 60 });
    const win = r.aDead && r.bDead ? 'trade' : r.bDead ? SHORT[a] : r.aDead ? SHORT[b] : 'none';
    const w = r.bDead && !r.aDead ? r.A : r.aDead && !r.bDead ? r.B : null;
    rs.push([`${d}px ${SHORT[a]} v ${SHORT[b]}`, win, f2(r.t), w ? `${f0(100 * w.H / w.Hmax)}%` : '-']);
  }
  console.log(table(rs, ['duel', 'winner', 'time s', 'win hull']));
}

// =============================================================================================
if (want('burst')) {
  H('5. Scripted bursts');
  // Juggernaut vs Arcanist: start 450 px; Ram Charge (0.35 s @1500 px/s, 400 kinetic on contact), then Rockets 3x180
  // at ~60 px, then MD point-blank + Polarize aura (240 ion DPS in 10-tick steps while within r+14).
  const scen = (arcBlinks, polar) => {
    const J = new Ship('brute'), A = new Ship('tech');
    let now = 0, dist = 450, events = [];
    const q = [];
    let rammed = false, rockets = false, blinked = false, polarOn = false, auraT = 0;
    let arcFireFrom = 0;
    while (now < 20 && A.alive) {
      // Jugg
      J.reactor(now, DT);
      if (!rammed) { J.pay(now, 110, 1); rammed = true; events.push(`t=${f2(now)} RAM`); }
      if (now < 0.35 && dist > 40) dist = Math.max(40, dist - 1500 * DT);
      if (rammed && !events.some((e) => e.includes('ram hit')) && dist <= 40) { q.push({ at: now, amt: 400, type: 'kinetic' }); events.push(`t=${f2(now)} ram hit`); }
      if (!rockets && now >= 0.3) { if (J.pay(now, 150, 2)) { rockets = true; for (let i = 0; i < 3; i++) q.push({ at: now + dist / 700 + 0.03 * i, amt: 180, type: 'blast' }); } }
      if (polar && !polarOn && now >= 0.35) { J.pay(now, 120, 2); polarOn = true; }
      for (const p of J.fire(now, DT, now >= 0.35, 2 + (polar ? 0 : 0), Math.max(40, dist))) q.push({ at: now + p.delay, amt: p.amt, type: p.type });
      if (polarOn && dist <= 16 + 22 + 14 + 10) { auraT += DT; if (auraT >= 10 / 60) { auraT = 0; q.push({ at: now, amt: 40, type: 'ion' }); } }
      // Arcanist reaction: blink away 0.25 s after its shield breaks
      if (arcBlinks && !blinked && A.S <= 0 && A.lastBreak !== undefined && now >= A.lastBreak + 0.25) {
        blinked = true; dist += 480; A.regenAt = Math.min(A.regenAt, now + 1.0); events.push(`t=${f2(now)} ARC BLINKS (dist ${f0(dist)})`);
      }
      // Jugg chases at max speed after the charge
      if (now > 0.35 && dist > 60) dist = Math.max(60, dist - (430 - (blinked ? 500 : 0) * 0) * DT * (blinked ? 0.0 : 1));
      for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) {
        const r = applyHit(A, q[i].amt, q[i].type, now); q.splice(i, 1);
        if (r.broke) { A.lastBreak = now; events.push(`t=${f2(now)} ARC SHIELD BREAK${r.gated ? ' (gated overflow)' : ''}`); }
      }
      A.reactor(now, DT); A.shieldTick(now, DT, 0, false);
      now += DT;
    }
    return { t: A.alive ? Infinity : now, events, arcHull: A.H, dist };
  };
  for (const [blink, polar] of [[false, false], [false, true], [true, false]]) {
    const r = scen(blink, polar);
    console.log(`Jugg -> Arc burst (Ram + Rockets + MD${polar ? ' + Polarize aura' : ''})${blink ? ', Arcanist blinks 0.25 s after break' : ''}: takedown ${Number.isFinite(r.t) ? f2(r.t) + ' s' : 'NO (escaped)'}; Arc hull left ${f0(Math.max(0, r.arcHull))}`);
    console.log('    ' + r.events.slice(0, 8).join(' | '));
  }
  // Arcanist burst on a Jugg: Arc Lightning + Laser at 600 px + Singularity (120 energy DPS 3 s, pull)
  {
    const A = { ship: new Ship('tech'), lmb: true, rmb: true, thrust: false, acc: 1 };
    const B = { ship: new Ship('brute'), lmb: false, rmb: false, thrust: true };
    const r = fight(A, B, 600, { maxT: 30 });
    console.log(`Arc -> Jugg (Laser + Arc Lightning, 600 px, acc 1, stop-and-pop): takedown ${f2(r.t)} s (Jugg shield broke at ${f2(r.log.firstBreak.B)} s)`);
  }
  // Combined arms: Phaser opener + MD finisher (two attackers)
  console.log('\nCombined arms, 2 attackers (Art Phaser @450 + Jugg MD @150) vs each class, acc 1:');
  for (const t of CLASS_IDS) {
    const tgt = new Ship(t); let now = 0; const P = new Ship('engineer', 'phaser'), M = new Ship('brute', 'massdriver');
    let brk = null; const q = [];
    while (now < 30 && tgt.alive) {
      for (const [s, d] of [[P, 450], [M, 150]]) { s.reactor(now, DT); for (const p of s.fire(now, DT, true, 1, d)) q.push({ at: now + p.delay, ...p }); s.shieldTick(now, DT, 1, false); }
      for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) { const r = applyHit(tgt, q[i].amt, q[i].type, now); if (r.broke && brk === null) brk = now; q.splice(i, 1); }
      tgt.reactor(now, DT); tgt.shieldTick(now, DT, 0, false);
      now += DT;
    }
    console.log(`  vs ${CLS[t].name}: shield down ${f2(brk)} s, takedown ${f2(now)} s`);
  }
  // Shield-gate value: big hits vs a full / 21% / 19% shield
  console.log('\nShield gate — hull damage from one hit vs Arcanist (600 S / 450 H) at shield 100% / 21% / 19%:');
  const hits = [['Bomb centre 480 blast', 480, 'blast'], ['Ram 400 kinetic', 400, 'kinetic'], ['Railshot MD 4x69', 276, 'kinetic'], ['Broadside flank 4x160 (one volley)', 640, 'kinetic'], ['Rocket volley 3x180', 540, 'blast']];
  const rows = [];
  for (const [nm, amt, ty] of hits) {
    const r = [nm];
    for (const fr of [1, 0.21, 0.19, 0]) {
      const a = new Ship('tech'); a.S = a.Smax * fr;
      const parts = nm.startsWith('Railshot') || nm.startsWith('Broadside') || nm.startsWith('Rocket') ? (nm.startsWith('Railshot') ? [276] : nm.startsWith('Broadside') ? [160, 160, 160, 160] : [180, 180, 180]) : [amt];
      let h = 0; for (const p of parts) h += applyHit(a, p, ty, 0).h;
      r.push(f0(h));
    }
    rows.push(r);
  }
  console.log(table(rows, ['hit', 'S 100%', 'S 21%', 'S 19%', 'S 0']));
}

// =============================================================================================
if (want('strain')) {
  H('6. Strain / brownout / breaker — hold buttons continuously for 30 s (thrusting), then release everything (idle) and recover');
  console.log('   Space held: Jugg Ram every 6 s, Arc Blink every 5 s, Art Repair Ray 130/s (+Pulse 60 every 9 s). RMB auto-repeats at cooldown. Target dummy at band distance.');
  const band = { massdriver: 200, laser: 500, phaser: 450 }; // every skill in range (arc 600, sentry 550)
  const run = (c, wid, lmb, rmb, space, mods) => {
    const s = new Ship(c, wid, mods); const st = {};
    let now = 0, dmg = 0, tBrown = null, tBreaker = null, speedSum = 0, regenMultSum = 0, samples = 0;
    let mobAt = 0; const strain = (lmb ? 1 : 0) + (rmb ? 1 : 0) + (space ? 1 : 0);
    for (; now < 30; now += DT) {
      s.engines(now, DT, true, false); s.reactor(now, DT);
      for (const p of s.fire(now, DT, lmb, strain, band[wid])) dmg += p.amt;
      if (rmb) for (const p of secondaryTick(s, now, DT, strain, band[wid], st, {})) dmg += p.amt;
      if (space) {
        if (c === 'engineer') { s.drain(now, 130, DT, strain); if (now >= mobAt && s.pay(now, 60, strain)) mobAt = now + 9; }
        else if (now >= mobAt && s.pay(now, c === 'brute' ? 110 : 120, strain)) mobAt = now + (c === 'brute' ? 6 : 5);
      }
      // own shield is damaged at t=0 to see regen: start at 50%
      if (now === 0) { s.S = s.Smax * 0.5; }
      s.shieldTick(now, DT, strain, false);
      if (tBrown === null && s.pf() < 0.25) tBrown = now;
      if (tBreaker === null && s.inBreaker(now)) tBreaker = now;
      speedSum += s.moveMult(now, strain); regenMultSum += STRAIN_SHIELD[strain] * (s.inBreaker(now) ? 0 : s.brownB()); samples++;
    }
    const pAt30 = s.pf();
    // recovery: release all, stop thrusting (idle), shield refills too
    const S30 = s.S; let t25 = null, tFull = null, rec = 0; s.firedAt = -1e9;
    for (let t = now; t < now + 30; t += DT) {
      s.reactor(t, DT); s.shieldTick(t, DT, 0, t - s.lastShot >= 0.4);
      rec += DT;
      if (t25 === null && s.pf() >= 0.25) t25 = rec;
      if (tFull === null && s.pf() >= 0.999) tFull = rec;
    }
    return { tBrown, tBreaker, breakers: s.stats.breakers, speed: speedSum / samples, regen: regenMultSum / samples, dps: dmg / 30, pAt30, t25, tFull, S30: S30 / s.Smax };
  };
  const rows = [];
  for (const c of CLASS_IDS) {
    const wid = DEFAULT_WEAPON[c];
    for (const [nm, l, r, sp] of [['LMB', 1, 0, 0], ['LMB+RMB', 1, 1, 0], ['LMB+SPC', 1, 0, 1], ['LMB+RMB+SPC', 1, 1, 1], ['RMB+SPC', 0, 1, 1]]) {
      const x = run(c, wid, !!l, !!r, !!sp);
      rows.push([`${SHORT[c]} ${nm}`, x.tBrown === null ? 'never' : f1(x.tBrown), x.tBreaker === null ? 'never' : f1(x.tBreaker), x.breakers, `${f0(100 * x.speed)}%`, `${f0(100 * x.regen)}%`, f0(x.dps), `${f0(100 * x.pAt30)}%`, `${f0(100 * x.S30)}%`, x.t25 === null ? '-' : f2(x.t25), x.tFull === null ? '>30' : f1(x.tFull)]);
    }
  }
  console.log(table(rows, ['class held', 't brownout', 't breaker', '#breakers', 'avg speed', 'avg S-regen mult', 'DPS', 'P@30s', 'S@30s', 'rec to 25%', 'rec to full P']));

  console.log('\nBreaker under the "strict" reading (trip when a wanted discrete cost is refused for lack of power), LMB+RMB+SPC 30 s:');
  // Monkey-patch pay/fire refusal detection: count refusals while in brownout
  for (const c of CLASS_IDS) {
    const s = new Ship(c); const st = {}; let refusals = 0, now = 0, mobAt = 0, trips = 0, tripUntil = -1;
    const origPay = s.pay.bind(s);
    s.pay = (n, cost, strain) => { const ok = origPay(n, cost, strain); if (!ok && !s.inBreaker(n)) { refusals++; s.breakerUntil = n + 1; trips++; } return ok; };
    let dmg = 0, firingTime = 0;
    for (; now < 30; now += DT) {
      s.engines(now, DT, true, false); s.reactor(now, DT);
      const before = s.P; const pk = s.fire(now, DT, true, 3, 300); for (const p of pk) dmg += p.amt;
      if (!s.inBreaker(now) && pk.length === 0 && now + 1e-9 >= s.cdAt && !s.jam && now >= s.ventUntil && !s.gun.beam && s.P < s.gun.cost * hotMult(s.gun, s.heat) * STRAIN_DRAW[3]) { s.breakerUntil = now + 1; trips++; }
      for (const p of secondaryTick(s, now, DT, 3, 300, st, {})) dmg += p.amt;
      if (c === 'engineer') { s.drain(now, 130, DT, 3); if (now >= mobAt && s.pay(now, 60, 3)) mobAt = now + 9; }
      else if (now >= mobAt && s.pay(now, c === 'brute' ? 110 : 120, 3)) mobAt = now + (c === 'brute' ? 6 : 5);
      s.shieldTick(now, DT, 3, false);
    }
    console.log(`  ${CLS[c].name}: ${trips} breaker trips in 30 s, breaker time ${f1(s.stats.breakerTime)} s, DPS ${f0(dmg / 30)}`);
  }

  H('6b. Never-brownout builds: net power/s while HOLDING the combo (sustained average, hot weapon), by card stack');
  // average draws per second (sustained): weapon at hot-band steady state, secondary at cooldown, space at cooldown / ray.
  const hotAvg = { massdriver: 2.5, laser: 1, phaser: 1.5 * 0.69 + 0 }; // MD pinned at 100 (x2.5); phaser ~69% duty at x1.5 hot mostly
  const combos = [];
  const cards = [];
  for (const coils of [0, 1, 2, 3, 4]) for (const reactor of [0, 1, 2, 3, 4, 5]) for (const lanc of [0, 1]) cards.push({ coils, reactor, lanc });
  const draw = (c, wid, strain, k) => {
    const g = makeGun(c, wid, { gunCost: k.lanc ? 0.65 : 1 });
    const cm = Math.pow(0.9, k.coils);
    const wpn = (g.beam ? g.cost : g.cost / g.cd) * (wid === 'massdriver' ? 2.5 : wid === 'phaser' ? 1.5 * 0.69 : 1) * cm;
    const sec = { brute: 150 / 1.4, tech: 130 / 1.1, engineer: 200 / 3 }[c] * cm;
    const spc = { brute: 110 / 6, tech: 120 / 5, engineer: 130 + 60 / 9 }[c] * cm;
    const d = [wpn, strain >= 2 ? sec : 0, strain >= 3 ? spc : 0].reduce((a, b) => a + b, 0) * STRAIN_DRAW[strain] + CLS[c].thrustC;
    const regen = CLS[c].Preg * (1 + 0.12 * k.reactor) * (k.lanc ? 1.15 : 1);
    return regen - d;
  };
  const rows2 = [];
  for (const c of CLASS_IDS) for (const wid of WEAPON_IDS) {
    const r = [`${SHORT[c]} ${WPN[wid].name}`];
    for (const strain of [1, 2, 3]) {
      const base = draw(c, wid, strain, { coils: 0, reactor: 0, lanc: 0 });
      // minimal cards to reach >= 0
      let best = null;
      for (const k of cards) { if (k.lanc && c !== 'tech') continue; if (draw(c, wid, strain, k) >= 0) { const n = k.coils + k.reactor + k.lanc; if (!best || n < best.n) best = { ...k, n }; } }
      r.push(`${base >= 0 ? '+' : ''}${f0(base)} ${best ? (best.n === 0 ? '(never)' : `(C${best.coils}R${best.reactor}${best.lanc ? '+L' : ''})`) : '(no build)'}`);
    }
    rows2.push(r);
  }
  console.log(table(rows2, ['class weapon', 'LMB net/s (min cards)', 'LMB+RMB net/s', 'LMB+RMB+SPC net/s']));
  console.log('   (C = Efficient Coils level, R = Reactor level, L = lan_coils; "(never)" = already power-positive with no cards.)');
}

// =============================================================================================
if (want('move')) {
  H('7. Inertia — stop time / distance, 0->max, reverse, 90° strafe response, turn (60 Hz; stop = speed < 5 px/s)');
  const v1 = (c) => CLS[c];
  const stopRun = (v0, drag, brake, maxS, bleed) => {
    let v = v0, d = 0, t = 0;
    while (v > 5 && t < 30) {
      if (v > maxS) v = Math.max(maxS, v - bleed * DT);
      v = Math.max(0, v * (1 - drag * DT) - brake * DT);
      d += v * DT; t += DT;
    }
    return { t, d };
  };
  // literal port of stepShipMovement with the v1.0 changes (no damping while thrusting, bleed clamp)
  const stepV1 = (b, mx, my, k, ab, hardClamp, mult = 1) => {
    const m = Math.hypot(mx, my);
    if (m > 0.1) {
      const a = k.thrust * mult * (ab ? 1.5 : 1);
      b.vx += (mx / m) * a * DT; b.vy += (my / m) * a * DT;
    } else {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) { const ns = Math.max(0, sp * (1 - k.drag * DT) - k.brake * DT); b.vx *= ns / sp; b.vy *= ns / sp; }
    }
    const maxS = (ab ? k.abSpeed : k.maxSpeed) * mult;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > maxS) {
      const target = hardClamp ? maxS : Math.max(maxS, sp - Math.max(400, 4 * k.brake) * DT);
      b.vx *= target / sp; b.vy *= target / sp;
    }
  };
  const rows = [];
  for (const c of CLASS_IDS) {
    const k = v1(c);
    const s = stopRun(k.maxSpeed, k.drag, k.brake, 1e9, 0);
    const sab = stopRun(k.abSpeed, k.drag, k.brake, k.maxSpeed, Math.max(400, 4 * k.brake));
    // 0 -> 95% max
    let b = { vx: 0, vy: 0 }, t = 0; while (Math.hypot(b.vx, b.vy) < 0.95 * k.maxSpeed && t < 10) { stepV1(b, 1, 0, k, false, true); t += DT; }
    const acc = t;
    // reverse: from +max x, thrust -x until vx <= -0.9 max
    b = { vx: k.maxSpeed, vy: 0 }; t = 0; let tZero = null; while (b.vx > -0.9 * k.maxSpeed && t < 10) { stepV1(b, -1, 0, k, false, true); t += DT; if (tZero === null && b.vx <= 0) tZero = t; }
    const rev = t;
    // 90° strafe: from +max x, thrust +y until heading within 10° of +y
    b = { vx: k.maxSpeed, vy: 0 }; t = 0; let lat = 0; while (Math.atan2(b.vy, b.vx) < (80 * Math.PI) / 180 && t < 10) { stepV1(b, 0, 1, k, false, true); t += DT; }
    const str = t;
    // same strafe with thrust-release first (coast) — n/a; turn 180
    const turn = Math.PI / k.turn;
    rows.push([k.name, f2(s.t), f0(s.d), f2(sab.t), f0(sab.d), f2(acc), f2(tZero), f2(rev), f2(str), f2(turn)]);
  }
  console.log(table(rows, ['class', 'stop s (max)', 'stop px', 'stop s (AB)', 'stop px AB', '0->95% s', 'reverse to 0 s', 'reverse to -90% s', '90° strafe (to 80°) s', '180° turn s']));
  {
    const s = stopRun(470, 1.2, 0, 1e9, 0); console.log(`v0.x reference (drag 1.2, no brake) from 470: ${f2(s.t)} s / ${f0(s.d)} px`);
  }
  console.log('\nCapital stop from their (penalised) max speed: mass 1 + 0.4n divides drag and brake; speed penalty 1 - 0.07n:');
  const rows2 = [];
  for (const c of CLASS_IDS) {
    const k = v1(c);
    rows2.push([k.name, ...[1, 3, 5].map((n) => { const m = 1 + 0.4 * n, vm = k.maxSpeed * Math.max(0.5, 1 - 0.07 * n); const r = stopRun(vm, k.drag / m, k.brake / m, 1e9, 0); return `${f2(r.t)} s / ${f0(r.d)} px`; })]);
  }
  console.log(table(rows2, ['capital of', 'n=1', 'n=3', 'n=5']));

  console.log('\nOverspeed-bleed check (literal code: clamp = max(maxS, sp - bleed*dt), bleed = max(400, 4*brake)) — speed after holding thrust along velocity:');
  const rows3 = [];
  for (const c of CLASS_IDS) {
    const k = v1(c);
    for (const ab of [false, true]) {
      for (const thr of [0, 5]) {
        const kk = { ...k, thrust: k.thrust * (1 + 0.08 * thr), maxSpeed: k.maxSpeed * (1 + 0.06 * thr), abSpeed: k.abSpeed * (1 + 0.06 * thr) };
        const b = { vx: 0, vy: 0 }; const sp = [];
        for (let t = 0; t <= 5 + 1e-9; t += DT) { stepV1(b, 1, 0, kk, ab, false); if (Math.abs(t - 1) < DT / 2 || Math.abs(t - 3) < DT / 2 || Math.abs(t - 5) < DT / 2) sp.push(Math.hypot(b.vx, b.vy)); }
        rows3.push([`${k.name}${ab ? ' AB' : ''}${thr ? ' +Thrusters5' : ''}`, f0(ab ? kk.abSpeed : kk.maxSpeed), f0(kk.thrust * (ab ? 1.5 : 1)), f0(Math.max(400, 4 * k.brake)), ...sp.map(f0)]);
      }
    }
  }
  console.log(table(rows3, ['ship', 'cap', 'accel', 'bleed', 'v@1s', 'v@3s', 'v@5s']));
  // v0.x existing code check: OVERSPEED_DECEL 1200 vs AB thrust
  console.log('\nv0.x EXISTING code (movement.ts, OVERSPEED_DECEL 1200, AB thrust x1.5) — speed after 1/3/5 s of afterburner:');
  const old = { brute: { thrust: 850, ab: 640 }, tech: { thrust: 950, ab: 760 }, engineer: { thrust: 900, ab: 700 } };
  for (const c of CLASS_IDS) {
    const o = old[c]; let vx = 0; const sp = [];
    for (let t = 0; t <= 5 + 1e-9; t += DT) {
      vx += o.thrust * 1.5 * DT;
      if (vx > o.ab) vx = Math.max(o.ab, vx - 1200 * DT);
      if (Math.abs(t - 1) < DT / 2 || Math.abs(t - 3) < DT / 2 || Math.abs(t - 5) < DT / 2) sp.push(vx);
    }
    console.log(`  ${CLS[c].name}: AB cap ${o.ab}, accel ${f0(o.thrust * 1.5)} vs bleed 1200 -> ${sp.map(f0).join(' / ')} px/s`);
  }
}

// =============================================================================================
if (want('items')) {
  H('8. Items');
  const grav = (d, R, A, floor = 0.35) => (d < R ? A * (floor + (1 - floor) * (1 - d / R)) : 0);
  console.log('Singularity Core pull on ships (A 700, R 540) vs thrust — can the ship thrust straight out?');
  const rows = [];
  for (const c of CLASS_IDS) {
    const k = CLS[c];
    for (const n of [0, 3]) {
      const mass = 1 + 0.4 * n;
      const pen = Math.max(0.5, 1 - 0.07 * n);
      const thr = k.thrust * pen, ab = thr * 1.5;
      const dEsc = [40, 120, 270, 500].map((d) => `${f0(thr - grav(d, 540, 700) / mass)}`);
      // time to escape from d=90 (crush edge) with thrust (no AB) and with AB (power permitting); crush dmg taken
      const esc = (useAb) => {
        let d = 60, v = 0, t = 0, crush = 0;
        while (d < 540 && t < 10) {
          const a = (useAb ? ab : thr) - grav(d, 540, 700) / mass;
          v += a * DT; v = Math.min(v, useAb ? k.abSpeed * pen : k.maxSpeed * pen);
          d += v * DT; t += DT;
          if (d < k.radius * (n ? 1.2 + 0.07 * n : 1) + 90) crush += 320 * DT;
          if (v < -50) { v = -50; }
        }
        return { t, crush };
      };
      const e1 = esc(false), e2 = esc(true);
      rows.push([`${k.name}${n ? ` capital n=${n}` : ''}`, f0(thr), ...dEsc, `${f2(e1.t)} s / ${f0(e1.crush)}`, `${f2(e2.t)} s / ${f0(e2.crush)}`]);
    }
  }
  console.log(table(rows, ['ship', 'thrust', 'net@40', 'net@120', 'net@270', 'net@500', 'escape from 60 px (thrust) t/crush', 'escape (AB) t/crush']));
  console.log('\nSingularity Core vs a swarm (A 1400 on enemies, own chase speed added, kamikaze consumed at r+40):');
  const rows2 = [];
  for (const kind of [['drone', 175], ['dart', 130], ['weaver', 215], ['splitter', 140], ['brute', 90]]) {
    const ts = [150, 300, 540].map((d0) => {
      let d = d0, v = 0, t = 0;
      while (d > 22 + 40 && t < 5) { v = Math.min(v + grav(d, 540, 1400) * DT, 1e9); d -= (v + kind[1]) * DT; t += DT; }
      return t >= 5 ? '>5' : f2(t);
    });
    rows2.push([kind[0], ...ts]);
  }
  console.log(table(rows2, ['enemy', 'reach core from 150 px', 'from 300 px', 'from 540 px']));
  console.log('  -> every kamikaze in 540 px is consumed in < ~1.2 s; over the 5 s duration the Core eats the whole local wave. Crush 512 DPS vs non-kamikaze inside r+90.');

  console.log('\nEMP vs shields (r 400): shield -> 0 (break, no hull), regen blocked 3.5 s, -40% max power (can trip breaker), DISRUPTED 2 s');
  for (const c of CLASS_IDS) {
    const k = CLS[c];
    // follow-up: MD point-blank on hull right after EMP; vs without EMP
    const withEmp = ttk('brute', 'massdriver', c, 150, { shieldDown: true });
    const noEmp = ttk('brute', 'massdriver', c, 150);
    const pw = k.P * 0.4;
    console.log(`  ${k.name}: strips ${k.S} shield instantly (Phaser needs ${f2(k.S / (110 * 0.95 * 4 * 2 * (1 - k.hard)))} s); power -${f0(pw)}; Jugg MD @150 follow-up TTK ${f2(withEmp)} s vs ${f2(noEmp)} s without EMP`);
  }
  console.log('\nBomb (r 180, 480 blast centre -> 40% edge, full shield gates it; x1.6 vs enemies):');
  const avgFall = 1 - 0.6 * (2 / 3);
  console.log(`  mean falloff over a uniform disc = ${f2(avgFall)} -> ${f0(480 * avgFall)} per ship, ${f0(768 * avgFall)} per enemy in radius`);
  for (const c of CLASS_IDS) {
    const r = [];
    for (const [nm, S] of [['full S', 1], ['S 19%', 0.19], ['S 0', 0]]) {
      const a = new Ship(c); a.S = a.Smax * S; const x = applyHit(a, 480, 'blast', 0); r.push(`${nm}: hull -${f0(x.h)}${a.H <= 0 ? ' (TAKEDOWN)' : ''}`);
    }
    console.log(`  ${CLS[c].name} (hull ${CLS[c].H}): ${r.join(' | ')}`);
  }
  console.log('  EMP (teammate) + direct Bomb on an Arcanist from full: shield 0 then 480 blast on 450 hull -> takedown in ~0.35 s + bomb flight');
  console.log('\nIon Storm (r 240, 6 s, 4 arcs/s to <=5 hostiles, 60 ion each; x1.8 vs enemies):');
  for (const c of CLASS_IDS) {
    const k = CLS[c];
    const sDps = 240 * 2 * (1 - k.hard), hDps = 240 * 0.8 * (1 - k.armor);
    const tS = k.S / sDps, tH = k.H / hDps;
    console.log(`  ${k.name}: shield DPS ${f0(sDps)} (strip in ${f2(tS)} s), then hull ${f0(hDps)} DPS -> takedown if it stays ${f2(tS + tH)} s (storm lasts 6 s); DISRUPTED = no regen inside`);
  }
  console.log(`  vs a swarm: 5 targets x 4 arcs/s x 108 = ${f0(5 * 4 * 108)} DPS for 6 s = ${f0(5 * 4 * 108 * 6)} damage (+30% slow)`);
}

// =============================================================================================
if (want('sustain')) {
  H('9. Repair Ray / Siphon / Weld / Repair Bay sustain vs incoming DPS');
  const heal = (base, hm) => base * hm;
  const hms = [['base', 1], ['Medic', 1.4], ['Medic+Medkit5', 1.4 * 1.75]];
  const rows = [];
  for (const [nm, hm] of hms) {
    for (const t of CLASS_IDS) {
      const k = CLS[t];
      const ray = heal(120, hm);
      // incoming raw DPS that the ray fully negates on the hull (after armor, per damage type)
      const kin = ray / (HM.kinetic * (1 - k.armor)), en = ray / (1 - k.armor), ion = ray / (0.8 * (1 - k.armor));
      rows.push([`${nm} -> ${k.name}`, f0(ray), f0(ray * 1.5), f0(kin), f0(en), f0(ion), f1((k.H / ray)), `${f1(60 * ray / k.H)}x`]);
    }
  }
  console.log(table(rows, ['Ray healer -> target', 'hull/s', 'Triage<30%', 'negates kinetic raw DPS', 'energy', 'ion', 's to refill hull', 'hull refills/min']));
  // self-ray economics
  console.log('\nSelf Repair Ray (no ally in cone): 72 hull/s base for 130 power/s — sustainability vs the 300/s reactor:');
  for (const [nm, strain, wpn] of [['Space only (strain 1)', 1, 0], ['Phaser + Space (strain 2)', 2, 1], ['Phaser + Sentry + Space (strain 3)', 3, 2]]) {
    const g = makeGun('engineer', 'phaser');
    const draw = (130 + (wpn >= 1 ? g.cost / g.cd * 1.0 : 0) + (wpn >= 2 ? 200 / 3 : 0)) * STRAIN_DRAW[strain] + 25;
    console.log(`  ${nm}: draw ${f0(draw)}/s vs reactor 300 -> net ${f0(300 - draw)}/s; ${300 - draw >= 0 ? 'INDEFINITE' : `brownout in ${f1(1100 * 0.75 / (draw - 300))} s`}; self-repair ${f0(72)} hull/s = ${f1(72 * 60 / 650)}x max hull per minute`);
  }
  // shield side: ray on a full-hull target restores 220 shield/s + jump-start each payout
  console.log('\nRay on a FULL-hull target: +220 shield/s and a jump-start every payout (6 ticks). If the jump-start lets the target\'s own regen run under fire:');
  for (const t of CLASS_IDS) {
    const k = CLS[t];
    const own = k.Sreg * 0.5; // target firing
    const tot = 220 + own;
    const brk = CLS[t].S / (1 - k.hard);
    const weapons = CLASS_IDS.map((a) => { const g = makeGun(a, DEFAULT_WEAPON[a]); const d = { massdriver: 200, laser: 700, phaser: 450 }[g.id]; return (g.beam ? g.dps : g.dmg / g.cd) * falloff(g, d) * SM[g.type] * (1 - k.hard); });
    console.log(`  ${k.name}: shield regen under fire = 220 (ray) + ${f0(own)} (own, firing x0.5) = ${f0(tot)}/s; incoming shield DPS from Jugg MD ${f0(weapons[0])}, Arc Laser ${f0(weapons[1])}, Art Phaser ${f0(weapons[2])} -> ${weapons.map((w, i) => `${['MD', 'Laser', 'Phaser'][i]} ${w > tot ? `breaks in ${f1(k.S / (w - tot))} s` : 'NEVER breaks'}`).join(', ')}`);
  }
  console.log('\nSiphon (med_siphon): 150/s ion drain (x2 on shields) + 60% return, 110 power/s:');
  for (const t of CLASS_IDS) {
    const k = CLS[t];
    const sDps = 150 * 2 * (1 - k.hard), hDps = 150 * 0.8 * (1 - k.armor);
    const retS = 0.6 * sDps, retH = 0.6 * hDps;
    console.log(`  vs ${k.name}: shield DPS ${f0(sDps)} (return ${f0(retS)} hull/s), hull DPS ${f0(hDps)} (return ${f0(retH)} hull/s)`);
  }
  {
    const g = makeGun('engineer', 'phaser');
    const d2 = (g.cost / g.cd + 110) * STRAIN_DRAW[2] + 25;
    console.log(`  vs a PvE enemy: 150 HP/s drained (x2 on aegis) -> 90 hull/s returned while ANY hostile is in the 20° cone <= 440 px. Phaser + Siphon draw ${f0(d2)}/s vs reactor 300 -> ${300 - d2 >= 0 ? 'INDEFINITE' : 'brownout'}; = ${f1(90 * 60 / 650)}x max hull/min`);
    console.log(`  Siphon alone vs Phaser alone on a Juggernaut shield: ${f0(300 * 0.85)} vs ${f0(110 * 0.95 * 4 * 2 * 0.85)} shield DPS; Siphon + Phaser ${f0((300 + 110 * 0.95 * 4 * 2) * 0.85)}`);
  }
  console.log('\nDocked defense sustain (turret own power: reactor x1.5 docked; x2.25 on a Clamp host):');
  for (const [nm, c, cost] of [['Brace (Jugg turret) 200/s', 'brute', 200], ['Hull Weld (Art turret) 180/s', 'engineer', 180], ['Deflector (Arc turret) 35/shot', 'tech', 0]]) {
    const r = CLS[c].Preg * 1.5, r2 = CLS[c].Preg * 2.25;
    console.log(`  ${nm}: turret reactor ${f0(r)} (${f0(r2)} clamp) -> ${cost ? (r >= cost ? 'INDEFINITE hold' : `holds ${f1(CLS[c].P / (cost - r))} s`) : 'per shot'}${cost && r < cost && r2 >= cost ? ' (INDEFINITE on a Clamp host)' : ''}`);
  }

  H('9b. "Unkillable Juggernaut" — Dreadnought fortress EHP and hull sustain');
  const builds = [
    { nm: 'Jugg base', S: 800, H: 900, armor: 0.35, absorb: 0, brace: 0, weld: 0, shieldW: 0 },
    { nm: 'Jugg + Polarize', S: 800, H: 900, armor: 0.35, absorb: 0.4, brace: 0, weld: 0, shieldW: 0 },
    { nm: 'Bulwark+Titan, Shield5, Hull5, Plating5', S: 800 * 1.3 * 1.2 * 1.6, H: 900 * 1.2 * 1.2 * 1.6, armor: 0.35 + 0.25, absorb: 0, brace: 0, weld: 0, shieldW: 0 },
    { nm: ' ^ as Dreadnought n=2 (2 Art welders)', S: 800 * 1.3 * 1.2 * 1.6 * 1.16, H: 900 * 1.2 * 1.2 * 1.6, armor: 0.35 + 0.25 + 0.06, absorb: 0, brace: 0, weld: 280, shieldW: 400 },
    { nm: ' ^ n=5 (2 Jugg brace + 3 Art weld) + Polarize', S: 800 * 1.3 * 1.2 * 1.6 * 1.4, H: 900 * 1.2 * 1.2 * 1.6, armor: 0.75, absorb: 0.4, brace: 0.5, weld: 420, shieldW: 600 },
  ];
  const rows3 = [];
  for (const b of builds) {
    const arm = Math.min(0.75, b.armor);
    const mult = 1 / ((1 - b.absorb) * (1 - b.brace));
    const eS = b.S / 0.85 * mult, eH = b.H / (1 - arm) * mult;
    const negate = b.weld / (1 - arm) * mult; // raw energy DPS the weld offsets on hull
    const focus = [1, 3, 6].map((n) => { const dps = 440 * n; const hullNet = dps - negate; return hullNet <= 0 ? '∞' : f1((eS) / dps + eH / hullNet); });
    rows3.push([b.nm, f0(b.S), f0(b.H), f2(arm), f0(eS + eH), f0(negate), ...focus]);
  }
  console.log(table(rows3, ['build', 'shield', 'hull', 'armor', 'EHP raw', 'raw DPS negated by weld', 'TTK vs 1 laser', 'vs 3', 'vs 6']));
  console.log('  (TTK uses 440 raw energy DPS per attacker, no shield regen; weld shield part and jump-starts ignored = optimistic for attackers.)');
}

// =============================================================================================
if (want('polar')) {
  H('10. Polarize Shields vs a drone swarm (analytic)');
  for (const flux of [0, 2, 4]) {
    const cd = 9 * Math.pow(0.9, flux), up = Math.min(1, 5 / cd);
    console.log(`  Flux Core ${flux}: cooldown ${f1(cd)} s, uptime ${f0(up * 100)}% -> kamikaze contact damage taken x${f2(1 - up)}; non-kamikaze x${f2(1 - 0.4 * up)} with 50% reflected; drain 30/s + 120 per cast = ${f0(30 * up + 120 / cd)} power/s avg`);
  }
  const tier = [1, 5, 11];
  for (const t of tier) {
    const c = 110 * (1 + 0.04 * (t - 1));
    console.log(`  tier ${t}: a drone touch is ${f0(c)} kinetic (x0.75x0.85 = ${f0(c * 0.75 * 0.85)} shield / ${f0(c * 1.25 * 0.65)} hull on a Jugg); under Polarize: 0, and it dies through killEnemy (XP + kit roll).`);
  }
  console.log('  Only non-kamikaze contact, shots and a shield break end it; a drone-only swarm cannot break it (it deals 0). With Flux Core 4 the Jugg is drone-immune 85% of the time.');
}
