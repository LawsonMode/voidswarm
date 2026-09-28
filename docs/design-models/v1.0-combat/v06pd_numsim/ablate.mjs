import { runFloor, party } from './swarm.mjs';
const seeds = [1, 2, 3, 4, 5, 6];
const cases = [
  ['v0.x legacy', { legacy: true }],
  ['v1.0 full spec', {}],
  ['v1.0, Threat off (T=1)', { threatOff: true }],
  ['v1.0, bots hold through heat', { relOff: true }],
  ['v1.0, weapons x1.4 (v0.x primary DPS)', { outMult: 1.4 }],
  ['v1.0, threat off + hold heat', { threatOff: true, relOff: true }],
  ['v1.0, no kits', { kits: false }],
  ['v1.0, no aegis', { aegis: false }],
  ['v1.0, incoming x0.7', { dmgScale: 0.7 }],
  ['v1.0, no bot retreat', { noRetreat: true }],
  ['v1.0, T off + no retreat', { threatOff: true, noRetreat: true }],
];
for (const f of [1, 2, 3, 4, 6]) {
  console.log(`\n--- floor ${f}, 4 bots [Jugg, Jugg, Arc, Art], Veteran, ${f === 1 ? 'no' : 'typical'} progression, ${seeds.length} seeds ---`);
  for (const [nm, o] of cases) {
    let clr = 0, sec = 0, d = 0, T = 0, boss = 0;
    for (const s of seeds) {
      const r = runFloor({ classes: party('brute', 4), floor: f, profile: f === 1 ? 'none' : 'typical', seed: s, ...o });
      if (r.cleared) clr++; sec += r.sec; d += r.deaths; T += r.maxT; const b = r.roomLog.find(x => x.k === 'B' || x.k === 'K'); if (b) boss += b.sec;
    }
    const n = seeds.length;
    console.log(`${nm.padEnd(40)} cleared ${clr}/${n}  mean ${(sec / n).toFixed(0).padStart(4)} s  deaths ${(d / n).toFixed(1).padStart(4)} (lives ${o.legacy ? 10 : 11})  maxT ${(T / n).toFixed(1)}  key/boss room ${(boss / n).toFixed(0)} s`);
  }
}
