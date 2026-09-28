// Grids over the swarm model (SCRATCH). node grid.mjs [survival,floors,kits,tools,diff,fix]
import { runFloor, party } from './swarm.mjs';
import { f0, f1, table } from './core.mjs';

const only = process.argv[2];
const want = (k) => !only || only.split(',').includes(k);
const H = (s) => console.log(`\n${'='.repeat(110)}\n== ${s}\n${'='.repeat(110)}`);
const SEEDS = [1, 2, 3, 4];
const FLOORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const CLS = ['brute', 'tech', 'engineer'];
const NAME = { brute: 'Jugg', tech: 'Arc', engineer: 'Art' };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function many(o, seeds = SEEDS) { return seeds.map((s) => runFloor({ ...o, seed: s })); }

if (want('survival')) {
  H('A. Swarm survival: seconds until the FOCAL pilot\'s first takedown in back-to-back arena rooms (pulses + Threat ramp; cap 900 s). Veteran, typical progression, 4 seeds');
  console.log('   Party = focal + mixed fill (n=4: focal + Jugg/Arc/Art; n=6: 2/2/2). ">900" = survived the cap.');
  for (const legacy of [false, true]) {
    const rows = [];
    for (const c of CLS) for (const n of [1, 4, 6]) {
      if (legacy && n === 6) continue;
      const row = [`${legacy ? 'v0.x ' : ''}${NAME[c]} n=${n}`];
      for (const f of FLOORS) {
        const rs = many({ classes: party(c, n), floor: f, profile: 'typical', endurance: true, maxSec: 900, legacy });
        const t = rs.map((r) => (r.focalFirst ?? 901));
        const m = mean(t);
        row.push(m > 900 ? '>900' : f0(m));
      }
      rows.push(row);
    }
    console.log(table(rows, ['focal / party', ...FLOORS.map((f) => `f${f}(t${1 + 2 * (f - 1)})`)]));
  }
  console.log('\n   Same, NO progression (fresh kit, no cards / auto-weapons):');
  const rows = [];
  for (const c of CLS) for (const n of [1, 6]) {
    const row = [`${NAME[c]} n=${n}`];
    for (const f of FLOORS) { const m = mean(many({ classes: party(c, n), floor: f, profile: 'none', endurance: true, maxSec: 900 }).map((r) => r.focalFirst ?? 901)); row.push(m > 900 ? '>900' : f0(m)); }
    rows.push(row);
  }
  console.log(table(rows, ['focal / party', ...FLOORS.map((f) => `f${f}`)]));
}

if (want('floors')) {
  H('B. Floor outcomes (real floor plan: halls, arenas, key / boss). Veteran, typical progression, 4 seeds. cell = cleared/4 · mean s · deaths/lives · max Threat');
  for (const legacy of [false, true]) {
    const rows = [];
    const parties = [['Jugg solo', party('brute', 1)], ['Arc solo', party('tech', 1)], ['Art solo', party('engineer', 1)], ['n=4 mixed', party('brute', 4)], ['n=6 2/2/2', party('brute', 6)]];
    for (const [nm, cl] of parties) {
      if (legacy && cl.length === 6) continue;
      const row = [`${legacy ? 'v0.x ' : ''}${nm}`];
      for (const f of FLOORS) {
        const rs = many({ classes: cl, floor: f, profile: 'typical', legacy });
        const c = rs.filter((r) => r.cleared).length;
        row.push(`${c}/4 ${f0(mean(rs.map((r) => r.sec)))}s ${f1(mean(rs.map((r) => r.deaths)))}/${rs[0].lives0}${legacy ? '' : ` T${f1(mean(rs.map((r) => r.maxT)))}`}`);
      }
      rows.push(row);
    }
    console.log(table(rows, ['party', ...FLOORS.map((f) => `floor ${f}`)]));
  }
}

if (want('diff')) {
  H('B2. Difficulty sweep (n=4 and n=6), floors 1-6, typical progression: cleared/4 · deaths/lives');
  const rows = [];
  for (const diff of [1, 2, 3]) for (const n of [4, 6]) {
    const row = [`${['', 'Story', 'Veteran', 'Nightmare'][diff]} n=${n}`];
    for (const f of [1, 2, 3, 4, 5, 6]) {
      const rs = many({ classes: party('brute', n), floor: f, profile: 'typical', diff });
      row.push(`${rs.filter((r) => r.cleared).length}/4 ${f1(mean(rs.map((r) => r.deaths)))}/${rs[0].lives0}`);
    }
    rows.push(row);
  }
  console.log(table(rows, ['difficulty', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']));
  console.log('\n   Same with the Threat base term 0.4(f-1) removed AND the time term paused in boss rooms (candidate fix), wpn x1.4:');
}

if (want('kits')) {
  H('C. Repair-kit economy (Veteran, typical). Per pilot per minute: hull lost vs restored (kits / Ray+Pulse), in % of that pilot\'s max hull');
  const rows = [];
  for (const [nm, cl] of [['Jugg solo', party('brute', 1)], ['Arc solo', party('tech', 1)], ['Art solo', party('engineer', 1)], ['n=4', party('brute', 4)], ['n=6', party('brute', 6)]]) {
    for (const f of [1, 2, 3, 6]) {
      const rs = many({ classes: cl, floor: f, profile: 'typical' });
      const W = rs.map((r) => r.W);
      const perPilotMax = mean(W.map((w) => w.party.reduce((a, p) => a + p.Hmax, 0) / w.party.length));
      const lost = mean(rs.map((r) => r.hullLostPerMin)) / cl.length / perPilotMax * 100;
      const kit = mean(rs.map((r) => r.kitHullPerMin)) / cl.length / perPilotMax * 100;
      const heal = mean(rs.map((r) => r.rayHullPerMin + r.pulseHullPerMin)) / cl.length / perPilotMax * 100;
      const drops = mean(rs.map((r) => r.kitsPerMin));
      const taken = mean(rs.map((r) => (r.kitsTaken.small + r.kitsTaken.large) / (r.sec / 60)));
      const expired = mean(rs.map((r) => r.kitExpired / (r.sec / 60)));
      const lg = mean(rs.map((r) => r.kitDrops.large / Math.max(1, r.kitDrops.small + r.kitDrops.large)));
      rows.push([`${nm} f${f}`, f1(drops), `${f0(lg * 100)}%`, f1(taken), f1(expired), `${f0(lost)}%`, `${f0(kit)}%`, `${f0(heal)}%`, `${f0(100 * (kit + heal) / Math.max(1, lost))}%`, `${rs.filter((r) => r.cleared).length}/4`]);
    }
  }
  console.log(table(rows, ['party floor', 'kits dropped/min', 'large share', 'taken/min', 'expired/min', 'hull lost %/min/pilot', 'kit %/min', 'ray+pulse %/min', 'restored/lost', 'cleared']));
}

if (want('tools')) {
  H('D. Tool value in the swarm (4 seeds, typical progression, Veteran)');
  const cmp = (label, base, alt) => {
    const a = many(base), b = many(alt);
    const fmt = (rs) => `${rs.filter((r) => r.cleared).length}/4, ${f0(mean(rs.map((r) => r.sec)))} s, deaths ${f1(mean(rs.map((r) => r.deaths)))}, focal hull lost ${f0(100 * mean(rs.map((r) => r.focalHullLostPerMin)))}%/min, focal 1st takedown ${f0(mean(rs.map((r) => r.focalFirst ?? r.sec)))} s`;
    console.log(`${label}\n    without: ${fmt(a)}\n    with   : ${fmt(b)}`);
  };
  for (const f of [1, 2, 4]) {
    cmp(`Polarize, Jugg solo floor ${f}`, { classes: ['brute'], floor: f, profile: 'typical', polar: false }, { classes: ['brute'], floor: f, profile: 'typical', polar: true });
    cmp(`Polarize + Flux Core 4 (cd 5.9 s), Jugg solo floor ${f}`, { classes: ['brute'], floor: f, profile: 'typical', polar: true }, { classes: ['brute'], floor: f, profile: 'typical', polar: true, polarCdMult: 0.656 });
    cmp(`Siphon, Art solo floor ${f}`, { classes: ['engineer'], floor: f, profile: 'typical' }, { classes: ['engineer'], floor: f, profile: 'typical', siphon: true });
  }
  // endurance with/without
  for (const [nm, o] of [['Jugg solo Polarize', { classes: ['brute'], polar: true }], ['Jugg solo no Polarize', { classes: ['brute'], polar: false }], ['Jugg solo Polarize+Flux4', { classes: ['brute'], polar: true, polarCdMult: 0.656 }], ['Art solo', { classes: ['engineer'] }], ['Art solo + Siphon', { classes: ['engineer'], siphon: true }]]) {
    const row = [];
    for (const f of [1, 2, 3, 4, 6]) row.push(f0(mean(many({ ...o, floor: f, profile: 'typical', endurance: true, maxSec: 900 }).map((r) => r.focalFirst ?? 901))));
    console.log(`  endurance ${nm.padEnd(26)} f1/f2/f3/f4/f6: ${row.join(' / ')} s`);
  }
  // Ray value: n=4 with the Artificer vs replacing it with a 2nd Arcanist
  for (const f of [1, 2, 3]) cmp(`Artificer in the party (vs a 2nd Arcanist), n=4 floor ${f}`, { classes: ['brute', 'brute', 'tech', 'tech'], floor: f, profile: 'typical' }, { classes: ['brute', 'brute', 'tech', 'engineer'], floor: f, profile: 'typical' });
}

if (want('fix')) {
  H('E. Candidate fixes, floors 1-6 and 9, n = 1 / 4 / 6 (typical, Veteran): cleared/4 · deaths/lives');
  const variants = [
    ['spec as written', {}],
    ['FIX: no Threat base, boss rooms pause Threat, wpn x1.4', { fixThreat: true, outMult: 1.4 }],
    ['STRONG FIX: no base, boss pause, Threat rate 0.2/min, HP 0.05/level, PvE damage x1.8', { fixThreat: true, outMult: 1.8, threatRate: 0.2, threatHp: 0.05 }],
  ];
  for (const [nm, o] of variants) {
    const rows = [];
    for (const [pn, cl] of [['Jugg solo', ['brute']], ['Arc solo', ['tech']], ['Art solo', ['engineer']], ['n=4', party('brute', 4)], ['n=6', party('brute', 6)]]) {
      const row = [pn];
      for (const f of [1, 2, 3, 4, 5, 6, 9]) {
        const rs = many({ classes: cl, floor: f, profile: 'typical', ...o });
        row.push(`${rs.filter((r) => r.cleared).length}/4 ${f1(mean(rs.map((r) => r.deaths)))}/${rs[0].lives0} ${f0(mean(rs.map((r) => r.sec)))}s`);
      }
      rows.push(row);
    }
    console.log(`\n-- ${nm}`);
    console.log(table(rows, ['party', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f9']));
  }
}
