import { runSwarm } from './v10_swarm.mjs';
for (const mt of [20, 30, 40, 60, 90, 120]) {
  const r = runSwarm({ floor: 3, classes: ['brute','tech','engineer','tech'], seed: 1, kits: true, respawn: true, maxT: mt });
  console.log(mt, 'rooms', r.rooms, 'L', r.L.toFixed(1), 'downs', r.downs, 'spawned', r.spawned, 'kills', r.kills, 'pops', r.pops, 'hull', r.pilots.map(p => (p.integrity/p.maxIntegrity).toFixed(2)+(p.alive?'':'x')).join(','), 'sh', r.pilots.map(p=>p.shield.toFixed(0)).join(','), 'pw', r.pilots.map(p=>p.power.toFixed(0)).join(','));
}
