import { runSwarm } from './v10_swarm.mjs';
const mix4 = ['brute','tech','engineer','tech'];
for (const f of [3, 4, 5]) for (const growth of ['base','matched']) {
  const r = runSwarm({ floor: f, classes: mix4, seed: 1, kits: false, respawn: false, stopOnDown: true, maxT: 600, connect: 0.35, growth });
  const tot = Object.values(r.dmgBy).reduce((a,b)=>a+b,0);
  console.log(`f${f} ${growth}: firstDown ${r.firstDownT.toFixed(1)} rooms ${r.rooms} spawned ${r.spawned} kills ${r.kills} pops ${r.pops} L ${r.L.toFixed(1)} | dmg by: ` + Object.entries(r.dmgBy).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${(100*v/tot).toFixed(0)}%`).join(' ') + ' | alive: ' + r.E.slice(0,12).join(' '));
}
