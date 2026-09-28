import { runSwarm, growth } from './v10_swarm.mjs';
import { writeFileSync } from 'node:fs';
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const out = [];
const comps = { Mixed4: ['brute','tech','engineer','tech'], Mixed6: ['brute','brute','tech','tech','engineer','engineer'], soloJugg: ['brute'], soloArca: ['tech'] };
const A = { contactPerL: 0.04, contactCap: 1.6, eliteContact: 1.25, minuteRate: 0.5, pulseRate: 0.15 };
out.push('=== T. Offense growth needed to clear a floor (fresh lives pool, kiting 0.35, eff 0.5). g scales the card-growth slope: dmg ×(1+0.12g(f−1)), autos (60+50(f−1))·g ===');
out.push('  cell = seeds cleared of 3 / lives lost ; the "×eff" column = total offense vs base stats at that floor for g');
for (const [sn, sc] of [['spec', {}], ['fix A', A]]) for (const [cn, comp] of Object.entries(comps)) for (const f of [3, 6, 9]) {
  const cells = [1, 2, 3, 4, 6, 8].map(g => {
    const R = f >= 4 ? 4 : 3;
    const rs = [1,2,3].map(sd => runSwarm({ floor: f, classes: comp, seed: sd, kits: true, respawn: true, maxT: 900, connect: 0.35, stopAfterRooms: R, g, ...sc }));
    const G = growth(f, g);
    return `g${g}(×${G.dmg.toFixed(1)}+${G.auto.toFixed(0)}): ${rs.filter(r=>r.rooms>=R).length}/3 ${avg(rs.map(r=>r.livesLost)).toFixed(1)}`;
  });
  out.push(`  ${sn.padEnd(5)} ${cn.padEnd(8)} f${f}: ` + cells.map(c => c.padEnd(26)).join(''));
}
writeFileSync(new URL('./v10_growth.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
