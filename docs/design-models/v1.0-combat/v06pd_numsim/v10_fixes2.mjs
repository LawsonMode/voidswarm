import { runSwarm, lives } from './v10_swarm.mjs';
import { writeFileSync } from 'node:fs';
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out = [];
const comps = { 'solo Jugg': ['brute'], 'solo Arca': ['tech'], 'solo Arti': ['engineer'], 'Mixed 4': ['brute','tech','engineer','tech'], 'Mixed 6': ['brute','brute','tech','tech','engineer','engineer'] };
const D = { budgetPerL: 0.03, perPulse: 0.08, contactPerL: 0.04, contactCap: 1.6, eliteContact: 1.25, minuteRate: 0.5, pulseRate: 0.15 };
const E = { ...D, shieldDelayMult: 0.6, shieldRegenMult: 1.8 };
for (const [sn, sc] of [['D: budget +3%/L, +8%/pulse, contact +4%/L cap 1.6, elite contact ×1.25, clock 0.5/min + 0.15/pulse (base growth)', D], ['E: D + in-combat shield (delay ×0.6, regen ×1.8)', E], ['E with growth g=2', { ...E, g: 2 }]]) {
  out.push(`  --- ${sn}`);
  for (const [cn, comp] of Object.entries(comps)) {
    const n = comp.length;
    const cells = [1,2,3,4,5,6,7,8,9,10].map(f => {
      const R = f >= 4 ? 4 : 3;
      const rs = [1,2,3].map(sd => runSwarm({ floor: f, classes: comp, seed: sd, kits: true, respawn: true, maxT: 900, connect: 0.35, stopAfterRooms: R, ...sc }));
      const ok = rs.filter(r => r.rooms >= R);
      const hl = avg(rs.map(r => r.pilots.reduce((a,p)=>a+p.hullLost/p.maxIntegrity,0)/n));
      return `f${f} ${ok.length===3?'':ok.length?'*':'X'}${hl.toFixed(1)}/${avg(rs.map(r=>r.livesLost)).toFixed(1)}`;
    });
    out.push(`   ${(cn + ' (' + lives(n) + ')').padEnd(14)} ` + cells.map(c=>c.padEnd(13)).join(''));
  }
}
out.push('  cell = hull lost per pilot per floor (×max) / lives lost; X = wiped, * = some seeds wiped');
writeFileSync(new URL('./v10_fixes2.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
