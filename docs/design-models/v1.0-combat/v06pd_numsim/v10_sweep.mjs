import { runSwarm } from './v10_swarm.mjs';
import { writeFileSync } from 'node:fs';
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out = [];
const comps = { 'Mixed4': ['brute','tech','engineer','tech'], 'Mixed6': ['brute','brute','tech','tech','engineer','engineer'], 'Arca4': ['tech','tech','tech','tech'], 'solo Jugg': ['brute'], 'solo Arca': ['tech'], 'solo Arti': ['engineer'] };
out.push('=== S. Sensitivity: contact-connect probability (kiting skill) × damage efficiency, spec numbers, one floor with a FRESH lives pool ===');
out.push('  cell = hull lost per pilot per floor (×max) / lives lost;  X = wiped');
for (const [cn, comp] of Object.entries(comps)) for (const eff of [0.5, 0.7]) for (const connect of [0.5, 0.35, 0.2, 0.1]) {
  const cells = [1,2,3,4,5,6,8,10].map(f => {
    const R = f >= 4 ? 4 : 3;
    const rs = [1,2,3].map(sd => runSwarm({ floor: f, classes: comp, seed: sd, kits: true, respawn: true, maxT: 900, connect, eff, stopAfterRooms: R }));
    const ok = rs.filter(r => r.rooms >= R).length;
    const n = comp.length;
    const hl = avg(rs.map(r => r.pilots.reduce((a,p)=>a+p.hullLost/p.maxIntegrity,0)/n));
    return `f${f} ${ok===3?'':ok?'*':'X'}${hl.toFixed(1)}/${avg(rs.map(r=>r.livesLost)).toFixed(1)}`;
  });
  out.push(`  ${cn.padEnd(9)} eff ${eff} connect ${String(connect).padEnd(4)}: ` + cells.map(c=>c.padEnd(14)).join(''));
}
out.push('');
out.push('  Danger gate (§18 gate 4: 4 bots, floor 1, Veteran: hull lost/bot ≥ 1.0, ≥ 1 kit/bot, ≤ 4 lives) — Mixed4 across regimes (6 seeds):');
for (const eff of [0.5, 0.7]) for (const connect of [0.5, 0.35, 0.2, 0.1]) {
  const rs = [1,2,3,4,5,6].map(sd => runSwarm({ floor: 1, classes: comps.Mixed4, seed: sd, kits: true, respawn: true, maxT: 900, connect, eff, stopAfterRooms: 3 }));
  const hl = avg(rs.map(r => r.pilots.reduce((a,p)=>a+p.hullLost/p.maxIntegrity,0)/4));
  const kp = avg(rs.map(r => r.pilots.reduce((a,p)=>a+p.kitsPicked,0)/4));
  const ll = avg(rs.map(r => r.livesLost));
  const tt = med(rs.map(r => r.t));
  out.push(`   eff ${eff} connect ${connect}: floor ${tt.toFixed(0)} s, hull lost ${hl.toFixed(2)}/bot, kits ${kp.toFixed(1)}/bot, lives lost ${ll.toFixed(1)} → ${hl >= 1 && kp >= 1 && ll <= 4 ? 'PASS' : 'FAIL'} ; Threat at clear ${avg(rs.map(r=>r.L)).toFixed(1)}`);
}
out.push('');
out.push('  Whole 6-floor run with ONE shared lives pool (lives(n) + boss +2/+3), Mixed4 / Mixed6, spec: lives consumed per floor (median seeds):');
for (const [cn, comp] of [['Mixed4', comps.Mixed4], ['Mixed6', comps.Mixed6]]) for (const [eff, connect] of [[0.5, 0.35], [0.7, 0.2], [0.7, 0.1]]) {
  const n = comp.length; let pool = Math.min(16, 2 + 2*Math.min(n,3) + Math.max(0,n-3)); const used = [];
  let f = 1;
  for (; f <= 6; f++) {
    const R = f >= 4 ? 4 : 3;
    const rs = [1,2,3].map(sd => runSwarm({ floor: f, classes: comp, seed: sd + 10*f, kits: true, respawn: true, maxT: 900, connect, eff, stopAfterRooms: R }));
    const ll = med(rs.map(r => r.rooms >= R ? r.livesLost : 99));
    used.push(ll >= 99 ? 'wipe' : ll.toFixed(0)); pool -= ll >= 99 ? 999 : ll;
    if (pool <= 0) break;
    if (f % 3 === 0) pool = Math.min(16, pool + (n >= 4 ? 3 : 2));
  }
  out.push(`   ${cn} eff ${eff} connect ${connect}: lives used per floor [${used.join(', ')}] → ${f > 6 ? 'RUN CLEARED' : 'run ends on floor ' + f}`);
}
writeFileSync(new URL('./v10_sweep.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
