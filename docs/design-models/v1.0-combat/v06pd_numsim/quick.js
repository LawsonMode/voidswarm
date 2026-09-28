const { Floor } = require('./swarm');
const skill = process.argv[2] || 'average';
for (const [f, n, cls] of [[1, 6], [3, 6], [6, 6], [1, 1, ['tech']], [1, 1, ['brute']], [3, 1, ['engineer']]]) {
  const t0 = Date.now();
  const fl = new Floor({ f, n, seed: 1, classes: cls, skill });
  const r = fl.run();
  console.log(`f${f} n${n}: ${(Date.now() - t0)} ms wall, sim ${r.time.toFixed(0)} s, H ${r.H.toFixed(2)}, lives ${r.lives}, wiped ${r.log.wiped}, timeout ${!!r.log.timeout}, rooms ${r.log.roomsCleared}, kills ${r.log.kills}, peak ${r.log.peakAlive}, drives ${r.log.drives}/${r.log.driveKills}, kits ${r.log.kitsTaken}/${r.log.kitsDropped}`);
  for (const [c, b] of Object.entries(r.byCls)) console.log(`   ${c}: deaths ${b.deaths} firstDeath ${b.firstDeath.map(x=>x.toFixed(0))} dmgI/min/pilot ${(b.dmgI/b.n/r.mins).toFixed(0)} dmgS ${(b.dmgS/b.n/r.mins).toFixed(0)} kitI ${(b.kitI/b.n/r.mins).toFixed(0)} healI ${(b.healI/b.n/r.mins).toFixed(0)} kills ${b.kills} dealt ${(b.dealt/1000).toFixed(0)}k brown% ${(100*b.brown/Math.max(1,b.alive)).toFixed(1)} polar% ${(100*b.polar/Math.max(1,b.alive)).toFixed(0)}`);
}
