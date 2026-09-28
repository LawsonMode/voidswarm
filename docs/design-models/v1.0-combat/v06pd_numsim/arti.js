const I = require('./items'); const { Floor } = require('./swarm'); const { fmt, padr } = require('./core');
Object.assign(I.TUNE, { tierHpPer: 0.08, perFloor: 0.15, pulses4From: 5 });
for (const [lab, n, cls, weapons] of [['solo Arti PH', 1, ['engineer'], {}], ['solo Arti MD', 1, ['engineer'], { engineer: 'massdriver' }], ['solo Arti LZ', 1, ['engineer'], { engineer: 'laser' }], ['n6 Arti PH', 6, null, {}], ['n6 Arti MD', 6, null, { engineer: 'massdriver' }], ['solo Arca MD', 1, ['tech'], { tech: 'massdriver' }], ['solo Arca PH', 1, ['tech'], { tech: 'phaser' }]]) {
  const res = [];
  for (const seed of [1, 2, 3]) { let lives = null, reached = 0; const deaths = {}; for (let f = 1; f <= 6; f++) { const fl = new Floor({ f, n, classes: cls, seed, lives, weapons }); const r = fl.run(); lives = r.lives; for (const [c, b] of Object.entries(r.byCls)) deaths[c] = (deaths[c] || 0) + b.deaths; if (r.log.wiped) break; reached = f; } res.push(`${reached}${reached === 6 ? '✓' : '✗'} deaths ${Object.entries(deaths).map(([c, d]) => c[0] + d).join(' ')}`); }
  console.log(`  ${padr(lab, 13)}: ${res.join(' | ')}`);
}
