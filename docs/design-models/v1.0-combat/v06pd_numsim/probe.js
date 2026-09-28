const { Floor } = require('./swarm');
const skill = process.argv[2] || 'average';
for (const f of [3, 4, 5, 6]) for (const seed of [1, 2]) {
  const fl = new Floor({ f, n: 6, seed, skill }); const r = fl.run();
  const src = Object.entries(r.log.src || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}k`).join(', ');
  const deaths = Object.entries(r.byCls).map(([c, b]) => `${c[0]}${b.deaths}`).join(' ');
  console.log(`f${f} s${seed}: ${r.time.toFixed(0)} s H ${r.H.toFixed(2)} rooms ${r.log.roomsCleared} wiped ${r.log.wiped} lives ${r.lives} deaths ${deaths} peak ${r.log.peakAlive} cap ${r.log.capHits||0} | dmg by source: ${src}`);
}
