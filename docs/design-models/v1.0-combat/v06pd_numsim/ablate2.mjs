import { runFloor, party } from './swarm.mjs';
const seeds = [1, 2, 3, 4, 5, 6];
const cases = [
  ['v0.x legacy', { legacy: true }],
  ['v1.0 spec', {}],
  ['T off + wpn x1.4', { threatOff: true, outMult: 1.4 }],
  ['T off + wpn x1.4 + hold heat', { threatOff: true, outMult: 1.4, relOff: true }],
  ['T on + wpn x1.4 + resume 80', { outMult: 1.4, resume: 80 }],
  ['T on + wpn x1.8', { outMult: 1.8 }],
  ['T on + wpn x1.8 + incoming x0.7', { outMult: 1.8, dmgScale: 0.7 }],
];
for (const n of [4, 6]) for (const f of [3, 4, 6]) {
  console.log(`\n--- floor ${f}, n=${n} mixed bots, Veteran, typical progression ---`);
  for (const [nm, o] of cases) {
    let clr = 0, sec = 0, d = 0, T = 0, kitH = 0, lost = 0, ray = 0, lives = 0;
    for (const s of seeds) {
      const r = runFloor({ classes: party('brute', n), floor: f, profile: 'typical', seed: s, ...o });
      if (r.cleared) clr++; sec += r.sec; d += r.deaths; T += r.maxT; kitH += r.kitHullPerMin; lost += r.hullLostPerMin; ray += r.rayHullPerMin + r.pulseHullPerMin; lives = r.lives0;
    }
    const k = seeds.length;
    console.log(`${nm.padEnd(34)} cleared ${clr}/${k}  ${(sec / k).toFixed(0).padStart(4)} s  deaths ${(d / k).toFixed(1).padStart(4)}/${lives}  maxT ${(T / k).toFixed(1)}  hull lost ${(lost / k).toFixed(0)}/min vs kits ${(kitH / k).toFixed(0)} + heals ${(ray / k).toFixed(0)}`);
  }
}
