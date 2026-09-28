import { runSwarm } from './v10_swarm.mjs';
const t0 = Date.now();
for (const [f, comp] of [[1, ['brute','tech','engineer','tech']], [1, ['tech']], [6, ['brute','tech','engineer','tech']], [9, ['brute','brute','tech','tech','engineer','engineer']]]) {
  const r = runSwarm({ floor: f, classes: comp, seed: 1, oneRoom: true, respawn: false, maxT: 240 });
  console.log(f, comp.length, 'rooms', r.rooms, 'roomT', r.roomTimes.map(x=>x.toFixed(1)), 't', r.t.toFixed(1), 'L', r.L.toFixed(2), 'spawned', r.spawned, 'kills', r.kills, 'pops', r.pops, 'polarKills', r.polarKills, 'downs', r.downs, 'kits', r.kitsDropped, 'hullLost', r.pilots.map(p => (p.hullLost/p.maxIntegrity).toFixed(2)).join(','), 'ray', r.rayHeal.toFixed(0));
}
const r = runSwarm({ floor: 3, classes: ['brute','tech','engineer','tech'], seed: 1, kits: true, respawn: true, maxT: 360 });
console.log('6min f3 n4 rooms', r.rooms, r.roomTimes.map(x=>x.toFixed(0)).join(','), 'L', r.L.toFixed(1), 'downs', r.downs, 'kits', r.kitsDropped, 'kitHull', r.kitHull.toFixed(0), 'dmg', r.dmgTaken.toFixed(0), 'ray', r.rayHeal.toFixed(0));
console.log('ms', Date.now() - t0);
