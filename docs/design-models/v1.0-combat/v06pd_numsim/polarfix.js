const { polar } = require('./heal.js');
const { heatH } = require('./items'); const { fmt } = require('./core');
for (const [lab, ship] of [['spec (140/s, shield ×1)', {}], ['sustain 200/s', { polarSustain: 200 }], ['polarized shield regen ×0.5', { polarShieldMult: 0.5 }], ['both', { polarSustain: 200, polarShieldMult: 0.5 }]]) {
  const row = [[1, 1], [3, 3], [6, 3]].map(([f, m]) => { const H = heatH(f, m, 2, 2); return `f${f}: ` + [2, 4, 6, 8].map((r) => { const x = polar(f, H, r, 0, 'sustain', false, { ship }); return x.dead === Infinity ? 'holds' : fmt(x.dead, 0) + 's'; }).join('/'); }).join('  ');
  console.log(`  ${lab.padEnd(30)} sustain not firing, 2/4/6/8 drones/s → ${row}`);
}
