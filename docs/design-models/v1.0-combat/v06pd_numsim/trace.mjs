import { runFloor, party } from './swarm.mjs';
for (const [f, o] of [[4, {}], [4, { threatOff: true }], [6, {}]]) {
  const r = runFloor({ classes: party('brute', 4), floor: f, profile: 'typical', seed: 2, dbg: true, ...o });
  const tot = Object.values(r.W.dbg).reduce((a, b) => a + b, 0);
  console.log(`\nfloor ${f} ${JSON.stringify(o)}: ${r.sec.toFixed(0)} s, deaths ${r.deaths}, maxAlive ${r.maxAlive}, surges ${r.surges}`);
  console.log('  rooms: ' + r.roomLog.map((x) => `${x.k}:${x.sec.toFixed(0)}s d${x.deaths} T${x.T.toFixed(1)}`).join(' | '));
  console.log('  incoming raw dmg share by source: ' + Object.entries(r.W.dbg).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(0)}%`).join(', ') + `  (total ${tot.toFixed(0)})`);
  console.log('  pilots: ' + r.W.party.map((p) => `${p.cls} dmgOut ${(p.st.dmgOut / r.sec).toFixed(0)}/s kills ${p.st.kills} deaths ${p.deaths} hullLost ${p.st.hullLost.toFixed(0)} shieldLost ${p.st.shieldLost.toFixed(0)}`).join(' ; '));
}
