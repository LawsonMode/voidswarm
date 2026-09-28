import { runFloor, party } from './swarm.mjs';
import { f0, f1, table } from './core.mjs';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const seeds = [1, 2, 3, 4];
// Matriarch alone, clock preset to a typical arrival (floor 3: 150 s / 5 rooms; floor 6+: 240 s / 7 rooms)
const rows = [];
for (const f of [3, 6, 9]) for (const n of [1, 4, 6]) {
  const pre = f === 3 ? { startSec: 150, startRooms: 5 } : { startSec: 240, startRooms: 7 };
  const cell = (o) => { const rs = seeds.map((s) => runFloor({ classes: party('brute', n), floor: f, profile: 'typical', bossOnly: true, seed: s, maxSec: 2400, ...pre, ...o })); const c = rs.filter((r) => r.cleared).length; return `${c}/4 ${f0(mean(rs.map((r) => (r.bossSec ?? r.sec) - (o.legacy ? 0 : 0))))}s d${f1(mean(rs.map((r) => r.deaths)))}`; };
  const hp = 30000 * (1 + 0.12 * (2 * f - 2)) * (1 + 0.6 * (n - 1));
  const addHpS = (4 + n) / 3 * 160 * (1 + 0.12 * (2 * f - 2)) * (1 + 0.25 * (n - 1));
  rows.push([`f${f} n=${n}`, f0(hp), f0(addHpS), cell({ legacy: true }), cell({ threatOff: true }), cell({}), cell({ fixThreat: true, outMult: 1.4 })]);
}
console.log(table(rows, ['boss room', 'Matriarch HP (T=1)', 'add HP/s P1 (T=1)', 'v0.x', 'v1.0 T off', 'v1.0 spec', 'fix: no base + pause + wpn x1.4']));
