import { runFloor, party } from './swarm.mjs';
const t0 = Date.now();
for (const legacy of [true, false]) for (const f of [1, 3, 6]) {
  const r = runFloor({ classes: party('brute', 4), floor: f, profile: f === 1 ? 'none' : 'typical', legacy, seed: 1 });
  console.log(`${legacy ? 'v0.x' : 'v1.0'} f${f}: cleared ${r.cleared} in ${r.sec.toFixed(0)} s, deaths ${r.deaths}/${r.lives0}, maxAlive ${r.maxAlive}, maxT ${r.maxT.toFixed(2)}, kills ${r.kills}, rooms ${r.roomLog.map(x => x.k + ':' + x.sec.toFixed(0)).join(' ')}, kits ${r.kitDrops.small}s/${r.kitDrops.large}L taken ${r.kitsTaken.small}/${r.kitsTaken.large}, hullLost/min ${r.hullLostPerMin.toFixed(0)}, kitHeal/min ${r.kitHullPerMin.toFixed(0)}, ray/min ${r.rayHullPerMin.toFixed(0)}, pulse/min ${r.pulseHullPerMin.toFixed(0)}, breakers ${r.breakers}`);
}
console.log(`elapsed ${Date.now() - t0} ms`);
