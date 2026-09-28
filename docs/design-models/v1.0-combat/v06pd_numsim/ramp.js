// Search a few flatter dungeon-ramp tunings with the agent model: full 1→6 runs + floor-1 damage intake.
'use strict';
const I = require('./items');
const K = require('./core');
const { Floor } = require('./swarm');
const { fmt, pad, padr } = K;
const SEEDS = [1, 2, 3];
const SPEC = { ...I.TUNE };
const VARIANTS = [
  ['spec', {}],
  ['A: tierHp .08, perFloor .15, 4 pulses from f5', { tierHpPer: 0.08, perFloor: 0.15, pulses4From: 5 }],
  ['B: A + base heat 1.3', { tierHpPer: 0.08, perFloor: 0.15, pulses4From: 5, base: 1.3 }],
  ['C: B + party count .20 / hp .15', { tierHpPer: 0.08, perFloor: 0.15, pulses4From: 5, base: 1.3, partyCountPer: 0.2, partyHpPer: 0.15 }],
  ['D: C + Drive crushes (1500 dps, no insta-kill)', { tierHpPer: 0.08, perFloor: 0.15, pulses4From: 5, base: 1.3, partyCountPer: 0.2, partyHpPer: 0.15, driveKillsKami: false, driveCrushDps: 1500 }],
];
const CFG = [['n6', 6, null], ['n4', 4, null], ['solo Jugg', 1, ['brute']], ['solo Arca', 1, ['tech']], ['solo Arti', 1, ['engineer']]];
const skill = process.env.SKILL || 'average';
const floors = +(process.env.FLOORS || 6);
for (const [name, tune] of VARIANTS) {
  Object.assign(I.TUNE, SPEC, tune);
  console.log(`\n--- ${name} (skill ${skill}) ---`);
  for (const [lab, n, cls] of CFG) {
    for (const pve of [2]) {
      const res = [];
      let f1dmg = 0, f1n = 0;
      for (const seed of SEEDS) {
        let lives = null, reached = 0, T = 0; const perFloorLost = [];
        for (let f = 1; f <= floors; f++) {
          const fl = new Floor({ f, n, classes: cls, seed, pve, lives, skill });
          const l0 = fl.lives; const r = fl.run(); T += r.time; lives = r.lives; perFloorLost.push(l0 - r.lives);
          if (f === 1) { for (const b of Object.values(r.byCls)) { f1dmg += b.dmgI / b.maxI / r.mins; f1n += b.n; } }
          if (r.log.wiped || r.log.timeout) break; reached = f;
        }
        res.push(`${reached}${reached === floors ? '✓' : '✗'} ${fmt(T / 60, 0)}m lost ${perFloorLost.join(',')}`);
      }
      console.log(`  ${padr(lab, 9)}: ${res.map((x) => padr(x, 30)).join('| ')} | f1 intake ${fmt(100 * f1dmg / f1n, 0)}% maxI/min`);
    }
  }
}
Object.assign(I.TUNE, SPEC);
