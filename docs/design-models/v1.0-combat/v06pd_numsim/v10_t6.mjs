import { runSwarm } from './v10_swarm.mjs';
const mix4 = ['brute','tech','engineer','tech'];
const C = { contactPerL: 0.04, contactCap: 1.6, eliteContact: 1.25, minuteRate: 0.5, pulseRate: 0.15, shieldDelayMult: 0.6, shieldRegenMult: 1.8, g: 2 };
for (const f of [3, 4]) for (const [nm, sc] of [['spec', {}], ['C', C]]) {
  const r = runSwarm({ floor: f, classes: mix4, seed: 1, kits: true, respawn: true, maxT: 900, connect: 0.35, stopAfterRooms: f>=4?4:3, ...sc });
  const tot = Object.values(r.dmgBy).reduce((a,b)=>a+b,0);
  console.log(`f${f} ${nm}: t ${r.t.toFixed(0)} rooms ${r.rooms} [${r.roomTimes.map(x=>x.toFixed(0))}] downs ${r.downs} spawned ${r.spawned} kills ${r.kills} pops ${r.pops} polar ${r.polarKills} L ${r.L.toFixed(1)} | dmg ${tot.toFixed(0)}: ` + Object.entries(r.dmgBy).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${(100*v/tot).toFixed(0)}%`).join(' ') + ' | alive: ' + r.E.slice(0,10).join(' '));
}
