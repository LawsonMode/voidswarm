import { runSwarm } from './v10_swarm.mjs';
const mix4 = ['brute','tech','engineer','tech'];
for (const mt of [3, 6, 10, 15, 20, 30, 45, 60]) {
  const r = runSwarm({ floor: 6, classes: mix4, seed: 1, kits: true, respawn: true, maxT: mt, connect: 0.35, debug: true });
  console.log(mt, 'L', r.L.toFixed(1), 'downs', r.downs, 'spawned', r.spawned, 'kills', r.kills, 'pops', r.pops, 'polar', r.polarKills, 'dmgTaken', r.dmgTaken.toFixed(0), 'hull', r.pilots.map(p => (p.integrity/p.maxIntegrity).toFixed(2)+(p.alive?'':'x')).join(','), 'alive E', r.E ? r.E.length : '?');
}
