// Runs the dungeon agent model over floors 1..10 × party sizes, plus survival, kit economy, sensitivity and full runs.
'use strict';
const { Floor, floorPlan } = require('./swarm');
const { fmt, pad, padr } = require('./core');
const SEEDS = [1, 2, 3];
const CONFIGS = [['solo Jugg', 1, ['brute']], ['solo Arca', 1, ['tech']], ['solo Arti', 1, ['engineer']], ['n4', 4, null], ['n6', 6, null]];
const which = process.argv[2] || 'all';
const baseOpts = { skill: process.env.SKILL || 'average', pve: +(process.env.PVE || 2), prog: process.env.PROG !== '0' };

function agg(runs) {
  const o = { time: 0, rooms: 0, wiped: 0, livesLost: 0, H: 0, peak: 0, byCls: {}, kitsDropped: 0, kitsTaken: 0, kitsExpired: 0, drives: 0, driveKills: 0, kills: 0, n: runs.length, mins: 0 };
  for (const r of runs) {
    o.time += r.time; o.rooms += r.log.roomsCleared; o.wiped += r.log.wiped ? 1 : 0; o.livesLost += r.livesStart - r.lives; o.H += r.H; o.peak = Math.max(o.peak, r.log.peakAlive);
    o.kitsDropped += r.log.kitsDropped; o.kitsTaken += r.log.kitsTaken; o.kitsExpired += r.log.kitsExpired; o.drives += r.log.drives; o.driveKills += r.log.driveKills; o.kills += r.log.kills; o.mins += r.mins;
    for (const [c, b] of Object.entries(r.byCls)) {
      const a = o.byCls[c] || (o.byCls[c] = { n: 0, deaths: 0, fd: [], dmgI: 0, dmgS: 0, kitI: 0, healI: 0, healS: 0, pilotMin: 0, brown: 0, alive: 0, polar: 0, maxI: b.maxI });
      a.n += b.n; a.deaths += b.deaths; a.fd.push(...b.firstDeath); a.dmgI += b.dmgI; a.dmgS += b.dmgS; a.kitI += b.kitI; a.healI += b.healI; a.healS += b.healS; a.pilotMin += b.n * r.mins; a.brown += b.brown; a.alive += b.alive; a.polar += b.polar;
    }
  }
  return o;
}
function runFloor(f, n, classes, extra = {}) {
  const runs = [];
  for (const seed of SEEDS) {
    const fl = new Floor({ f, n, classes, seed, ...baseOpts, ...extra });
    const livesStart = fl.lives; const r = fl.run(); r.livesStart = livesStart; r.sealed = [...floorPlan(f)].filter((c) => c !== 'H').length; runs.push(r);
  }
  return runs;
}
const clsName = { brute: 'Jugg', tech: 'Arca', engineer: 'Arti' };

if (which === 'all' || which === 'floors') {
  console.log(`=== T1. Isolated floors (start fresh AT the floor, level 1+3(f−1)), ${['', 'Story', 'Veteran', 'Nightmare'][baseOpts.pve]}, skill ${baseOpts.skill}, progression ${baseOpts.prog}, ${SEEDS.length} seeds ===`);
  console.log('  cfg        f  | floor s  sealed cleared | wipes | lives lost/pool | end H | peak | deaths per class (first death s, earliest)');
  const kitRows = [];
  for (const [lab, n, cls] of CONFIGS) {
    for (let f = 1; f <= 10; f++) {
      const runs = runFloor(f, n, cls); const a = agg(runs);
      const sealed = runs[0].sealed;
      const d = Object.entries(a.byCls).map(([c, b]) => `${clsName[c]} ${fmt(b.deaths / SEEDS.length, 1)} (${b.fd.length ? fmt(Math.min(...b.fd), 0) : '—'})`).join('  ');
      console.log(`  ${padr(lab, 9)} ${pad(f, 2)} | ${pad(fmt(a.time / a.n, 0), 6)}  ${fmt(a.rooms / a.n, 1)}/${sealed}         | ${a.wiped}/${a.n}   | ${pad(fmt(a.livesLost / a.n, 1), 4)}/${runs[0].livesStart}          | ${fmt(a.H / a.n, 2)}  | ${pad(a.peak, 3)}  | ${d}`);
      kitRows.push([lab, f, a]);
    }
  }
  console.log('\n=== T2. Kit economy (per pilot per minute, averaged over seeds; integrity points and % of that class\'s max integrity) ===');
  console.log('  cfg        f  | class: dmg taken I/min (%max)  kit repair I/min (%max)  ray+pulse I/min | kits dropped/min (party) taken% expired% | Drive uses/kills');
  for (const [lab, f, a] of kitRows) {
    if (!(f === 1 || f === 3 || f === 5 || f === 6 || f === 8 || f === 10)) continue;
    const cl = Object.entries(a.byCls).map(([c, b]) => `${clsName[c]} ${pad(fmt(b.dmgI / b.pilotMin, 0), 4)} (${pad(fmt(100 * b.dmgI / b.pilotMin / b.maxI, 0), 3)}%) kit ${pad(fmt(b.kitI / b.pilotMin, 0), 4)} (${pad(fmt(100 * b.kitI / b.pilotMin / b.maxI, 0), 3)}%) heal ${pad(fmt(b.healI / b.pilotMin, 0), 4)}`).join(' | ');
    console.log(`  ${padr(lab, 9)} ${pad(f, 2)} | ${cl} | ${fmt(a.kitsDropped / a.mins, 1)}/min ${fmt(100 * a.kitsTaken / Math.max(1, a.kitsDropped), 0)}% ${fmt(100 * a.kitsExpired / Math.max(1, a.kitsDropped), 0)}% | ${fmt(a.drives / a.n, 1)}/${fmt(a.driveKills / a.n, 0)}`);
  }
}

if (which === 'all' || which === 'endless') {
  console.log(`\n=== T3. Swarm survival: one endless sealed arena (pulses never stop, k capped at 8), heat ramps with minutes, NO lives; time to first death per class (s), 3 seeds (median) ===`);
  console.log('  cfg        | ' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((f) => padr(`tier ${f}`, 17)).join(''));
  for (const [lab, n, cls] of CONFIGS) {
    const cells = [];
    for (let f = 1; f <= 10; f++) {
      const per = {};
      for (const seed of SEEDS) {
        const fl = new Floor({ f, n, classes: cls, seed, ...baseOpts, endless: true, lives: 0, maxSec: 900 });
        const r = fl.run();
        for (const [c, b] of Object.entries(r.byCls)) { (per[c] = per[c] || []).push(...(b.firstDeath.length ? b.firstDeath : [Infinity]).slice(0, b.n)); while (per[c].length % b.n) per[c].push(Infinity); }
      }
      const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      cells.push(Object.entries(per).map(([c, v]) => `${{ brute: 'J', tech: 'A', engineer: 'R' }[c]}${med(v) === Infinity ? '>900' : fmt(med(v), 0)}`).join(' '));
    }
    console.log(`  ${padr(lab, 10)} | ` + cells.map((c) => padr(c, 17)).join(''));
  }
  console.log('  (J = Juggernaut, A = Arcanist, R = Artificer; median seconds until that class first dies)');
}

if (which === 'all' || which === 'sens') {
  console.log('\n=== T4. Sensitivity / ablations, n = 6 (3 seeds): floors 3, 5, 6 ===');
  const variants = [
    ['baseline (average, prog, items)', {}],
    ['skill expert', { skill: 'expert' }], ['skill bot', { skill: 'bot' }],
    ['no progression', { prog: false }], ['+6 levels', { levelBonus: 6 }],
    ['Story', { pve: 1 }], ['Nightmare', { pve: 3 }],
    ['no Singularity Drive', { drive: false }], ['no items at all', { items: false }], ['no Polarize', { polarize: false }], ['no Repair Ray', { ray: false }],
    ['no kits', { kitsOn: false }], ['reactor tiers off', { reactorTiers: false }], ['Ram path (Spiked Prow)', { ramPath: true }],
  ];
  console.log('  variant                          | ' + [3, 5, 6].map((f) => padr(`f${f}: wipes lives-lost time deaths(J/A/R)`, 44)).join(''));
  for (const [lab, o] of variants) {
    const cells = [3, 5, 6].map((f) => { const runs = runFloor(f, 6, null, o); const a = agg(runs); const d = ['brute', 'tech', 'engineer'].map((c) => fmt((a.byCls[c]?.deaths || 0) / a.n, 1)).join('/'); return padr(`${a.wiped}/${a.n}  ${fmt(a.livesLost / a.n, 1)}/${runs[0].livesStart}  ${fmt(a.time / a.n, 0)} s  ${d}`, 44); });
    console.log(`  ${padr(lab, 32)} | ${cells.join('')}`);
  }
}

if (which === 'all' || which === 'run') {
  console.log('\n=== T5. Full runs: floors 1→N carrying the lives pool (+2 per boss), average skill, 3 seeds ===');
  for (const [lab, n, cls] of [['n6', 6, null], ['n4', 4, null], ['solo Jugg', 1, ['brute']], ['solo Arca', 1, ['tech']], ['solo Arti', 1, ['engineer']]]) for (const pve of [1, 2, 3]) {
    const out = [];
    for (const seed of SEEDS) {
      let lives = null, reached = 0, totalT = 0;
      for (let f = 1; f <= 10; f++) {
        const fl = new Floor({ f, n, classes: cls, seed, ...baseOpts, pve, lives });
        const r = fl.run(); totalT += r.time; lives = r.lives;
        if (r.log.wiped || r.log.timeout) break; reached = f;
      }
      out.push(`${reached}${reached === 10 ? '' : '✗'} (${fmt(totalT / 60, 0)} min, lives ${lives})`);
    }
    console.log(`  ${padr(lab, 9)} ${padr(['', 'Story', 'Veteran', 'Nightmare'][pve], 9)}: floors cleared per seed: ${out.join(' | ')}`);
  }
}
