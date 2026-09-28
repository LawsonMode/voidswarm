import { runSwarm, lives } from './v10_swarm.mjs';
import { pad, padr, f1, f2, f0 } from './v10_core.mjs';
import { writeFileSync } from 'node:fs';
const out = []; const P = (...a) => out.push(a.join(' '));
const SEEDS = [1, 2, 3];
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const floors = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const comps = {
  'solo Jugg': ['brute'], 'solo Arca': ['tech'], 'solo Arti': ['engineer'],
  'Mixed 4': ['brute', 'tech', 'engineer', 'tech'], 'Mixed 6': ['brute', 'brute', 'tech', 'tech', 'engineer', 'engineer'],
};
const SCEN = {
  spec: {},
  'A: contact +4%/L cap ×1.6, elite contact ×1.25, clock 0.5/min, 0.15/pulse': { contactPerL: 0.04, contactCap: 1.6, eliteContact: 1.25, minuteRate: 0.5, pulseRate: 0.15 },
  'B: A + in-combat shield (delay ×0.6, regen ×1.8)': { contactPerL: 0.04, contactCap: 1.6, eliteContact: 1.25, minuteRate: 0.5, pulseRate: 0.15, shieldDelayMult: 0.6, shieldRegenMult: 1.8 },
  'C: B + strong offense growth (g=2)': { contactPerL: 0.04, contactCap: 1.6, eliteContact: 1.25, minuteRate: 0.5, pulseRate: 0.15, shieldDelayMult: 0.6, shieldRegenMult: 1.8, g: 2 },
};
P('=== R. Floor outcomes by scenario (kiting 0.35, eff 0.5, kits+respawns on): floor time s / hull lost per pilot / kits per pilot / lives lost of pool;  X = run wiped ===');
for (const [sn, sc] of Object.entries(SCEN)) {
  P(`  --- ${sn}`);
  for (const [cn, comp] of Object.entries(comps)) {
    const n = comp.length;
    const cells = floors.map((f) => {
      const R = f >= 4 ? 4 : 3;
      const rs = SEEDS.map((sd) => runSwarm({ floor: f, classes: comp, seed: sd, kits: true, respawn: true, maxT: 900, connect: 0.35, stopAfterRooms: R, ...sc }));
      const ok = rs.filter((r) => r.rooms >= R);
      const tt = ok.length ? med(ok.map((r) => r.t)) : Infinity;
      const hl = avg(rs.map((r) => r.pilots.reduce((a, p) => a + p.hullLost / p.maxIntegrity, 0) / n));
      const ll = avg(rs.map((r) => r.livesLost));
      return `${ok.length === rs.length ? f0(tt) : ok.length ? f0(tt) + '*' : 'X'}/${f1(hl)}/${f1(ll)}`;
    });
    P(`   ${padr(cn + ' (' + lives(n) + ' lives)', 20)}` + cells.map((c, i) => padr(`f${i + 1} ${c}`, 16)).join(''));
  }
}
P('  cell = floor time s / hull lost per pilot (×max) / lives lost');
writeFileSync(new URL('./v10_fixes.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
