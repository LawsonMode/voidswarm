import { runSwarm, countMult, hpMult, bossMult, lives, threatBase, growth } from './v10_swarm.mjs';
import { CLASSES, makeShip, stepPilot, pad, padr, f1, f2, f0 } from './v10_core.mjs';
import { writeFileSync } from 'node:fs';
const out = []; const P = (...a) => { out.push(a.join(' ')); };
const SEEDS = [1, 2, 3];
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const KITE = 0.35;
const comps = {
  Jugg: (n) => Array(n).fill('brute'), Arca: (n) => Array(n).fill('tech'), Arti: (n) => Array(n).fill('engineer'),
  Mixed: (n) => n === 1 ? ['brute'] : n === 4 ? ['brute', 'tech', 'engineer', 'tech'] : ['brute', 'brute', 'tech', 'tech', 'engineer', 'engineer'],
};
const floors = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

P('=== M. Ramp tables (§13 formulas as written, Veteran) ===');
P('  n | count  hp   boss | lives S/V/N | per-pilot vs solo: EHP (count×hp/n)  contact (count/n)  boss/n  lives/n');
for (const n of [1, 2, 3, 4, 5, 6]) P(`  ${n} | ${countMult(n).toFixed(2)}  ${hpMult(n).toFixed(2)}  ${bossMult(n).toFixed(2)} | ${pad(lives(n, 2), 2)}/${pad(lives(n, 0), 2)}/${pad(lives(n, -2), 2)}    |   ${f2(countMult(n) * hpMult(n) / n)}                  ${f2(countMult(n) / n)}             ${f2(bossMult(n) / n)}   ${f2(lives(n) / n)}`);
P('  Threat and the offense a party needs vs floor-1-start (to kill a pulse as fast as on floor 1): need = (8+2f)/10 × (1+0.08L) × (1+0.06L) × speed');
P('  floor | L start  need× | L +4min(≈3 pulses/min)  need× | contact× start/+4m | elite% | k0 bodies n1/n4/n6 | k3 n6 | Matriarch n6');
for (const f of floors) {
  const L0 = threatBase(f, 0), L4 = L0 + 3.2 + 3;
  const need = (L) => ((8 + 2 * f) / 10) * (1 + 0.08 * L) * (1 + 0.06 * L) * Math.min(1.4, 1 + 0.03 * L);
  const b = (n, k, L) => Math.round((8 + 2 * f) * countMult(n) * (1 + 0.08 * L) * (1 + 0.15 * k));
  P(`   ${pad(f, 2)}  | ${pad(f1(L0), 5)}   ${pad(f1(need(L0)), 5)} | ${pad(f1(L4), 5)}                   ${pad(f1(need(L4)), 5)} | ${f2(1 + 0.07 * L0)} / ${f2(1 + 0.07 * L4)}        | ${pad(f0(100 * Math.min(0.25, 0.05 + 0.012 * L0)), 3)}    | ${pad(b(1, 0, L0), 3)}/${pad(b(4, 0, L0), 3)}/${pad(b(6, 0, L0), 3)}        | ${pad(b(6, 3, L0), 3)}  | ${f0(30000 * (1 + 0.06 * (L0 + 4.7)) * bossMult(6) / 1000)}k${f % 3 === 0 ? '' : ' (no boss)'}`);
}
P('  Base growth assumption used below (NOT in the spec): weapon+skill ×(1+0.12(f−1)), autos (60+50(f−1)) dps AoE×2, shield/hull ×(1+0.05(f−1))');
P('   → offense at floor 6 ≈ ×1.6 weapon + 310 autos (≈ ×2.1 total) vs need ×' + f1(((8 + 12) / 10) * (1 + 0.08 * 7.5) * (1 + 0.06 * 7.5) * Math.min(1.4, 1 + 0.03 * 7.5)) + '; "matched" growth = offense set to need×, defense as base.');
P('');

P('=== N. Pilot PvE output under bot discipline (heat 80/40, skills only above cost + 25% reserve), single target 250 px, base stats ===');
for (const c of ['brute', 'tech', 'engineer']) {
  const s = makeShip(c); let w = 0, sk = 0;
  for (let i = 0; i < 60 * 60; i++) { const pk = stepPilot(s, { lmb: true, rmb: true, thrust: true, still: c === 'tech' }, { dist: 250, disciplined: true, reserveFrac: 0.25 }); for (const p of pk) { if (p.src === 'weapon') w += p.amount; else sk += p.amount; } }
  P(`  ${padr(CLASSES[c].short, 5)} weapon ${f0(w / 60)} dps + skills ${f0(sk / 60)} dps = ${f0((w + sk) / 60)}; brownout ${f0(100 * s.stats.brownoutTime / 60)}% of time, jam ${f0(100 * s.stats.jamTime / 60)}%`);
}
P('');

P(`=== O. One FLOOR = its sealed rooms back-to-back (3 on f1-3, 4 on f4+; 10 s walks + hall packs), Mixed party, kiting (contact connects ${KITE}), eff 0.5, kits + respawns on ===`);
P('  cell = floor time s / hull lost per pilot (×maxHull) / kits picked per pilot / lives lost (of pool) / Threat at clear;  X = run wiped (lives out) before clearing');
for (const mode of ['base', 'matched']) for (const n of [1, 4, 6]) {
  P(`  growth ${mode}, n=${n} (lives ${lives(n)}):`);
  const cells = floors.map((f) => {
    const R = f >= 4 ? 4 : 3;
    const rs = SEEDS.map((sd) => runSwarm({ floor: f, classes: comps.Mixed(n), seed: sd, kits: true, respawn: true, maxT: 900, connect: KITE, stopAfterRooms: R, growth: mode }));
    const ok = rs.filter((r) => r.rooms >= R);
    const tt = ok.length ? med(ok.map((r) => r.t)) : Infinity;
    const hl = avg(rs.map((r) => r.pilots.reduce((a, p) => a + p.hullLost / p.maxIntegrity, 0) / n));
    const kp = avg(rs.map((r) => r.pilots.reduce((a, p) => a + p.kitsPicked, 0) / n));
    const ll = avg(rs.map((r) => r.livesLost));
    const L = avg(rs.map((r) => r.L));
    return `f${f}: ${ok.length === rs.length ? f0(tt) : ok.length ? f0(tt) + '*' : 'X'}/${f2(hl)}/${f1(kp)}/${f1(ll)}/${f1(L)}`;
  });
  for (let i = 0; i < cells.length; i += 5) P('    ' + cells.slice(i, i + 5).map((c) => padr(c, 30)).join(''));
}
P('  (* = some seeds wiped)');
P('');

for (const kitsOn of [false, true]) for (const mode of ['base', 'matched']) {
  P(`=== P${kitsOn ? 'b' : 'a'}. Swarm survival, growth ${mode}, kits ${kitsOn ? 'ON' : 'OFF'}: rooms back-to-back on floor f (Threat keeps climbing), kiting ${KITE}; median time (s) to the FIRST pilot down, cap 600 ===`);
  for (const n of [1, 4, 6]) {
    P(`  n=${n}   ` + floors.map((f) => pad('f' + f, 6)).join(''));
    for (const [cn, comp] of Object.entries(comps)) {
      const cells = floors.map((f) => {
        const rs = SEEDS.map((sd) => runSwarm({ floor: f, classes: comp(n), seed: sd, kits: kitsOn, respawn: false, stopOnDown: true, maxT: 600, connect: KITE, growth: mode }));
        const tt = med(rs.map((r) => r.firstDownT < 0 ? 600 : r.firstDownT));
        return pad(tt >= 600 ? '600+' : f0(tt), 6);
      });
      P(`  ${padr(cn, 6)} ` + cells.join(''));
    }
  }
  P('');
}

P(`=== Q. Kit economy (Mixed party, rooms back-to-back 6 min, kiting ${KITE}, base growth, kits + respawns on) — per pilot per minute ===`);
P('  n  floor | hull dmg taken/min (×maxHull) | kits dropped/min (party) | kit hull restored/min/pilot (×max) | ray heal/min/pilot (×max) | kit restore ÷ dmg | lives lost /6 min | Threat at 6 min');
for (const n of [1, 4, 6]) for (const f of [1, 3, 6, 9]) {
  const rs = SEEDS.map((sd) => runSwarm({ floor: f, classes: comps.Mixed(n), seed: sd, kits: true, respawn: true, maxT: 360, connect: KITE }));
  const mins = avg(rs.map((r) => r.t)) / 60;
  const meanMax = avg(rs[0].pilots.map((p) => p.maxIntegrity));
  const dmg = avg(rs.map((r) => r.dmgTaken)) / n / mins / meanMax;
  const kd = avg(rs.map((r) => r.kitsDropped)) / mins;
  const kh = avg(rs.map((r) => r.kitHull)) / n / mins / meanMax;
  const rh = avg(rs.map((r) => r.rayHeal)) / n / mins / meanMax;
  P(`  ${n}  ${pad(f, 3)}   | ${pad(f2(dmg), 6)}                        | ${pad(f1(kd), 5)}                    | ${pad(f2(kh), 5)}                              | ${pad(f2(rh), 5)}                     | ${pad(f2(kh / Math.max(1e-9, dmg)), 5)}           | ${pad(f1(avg(rs.map((r) => r.livesLost))), 4)} (run ${f1(mins)} min)  | ${f1(avg(rs.map((r) => r.L)))}`);
}
P('  Supply check vs spec §10 estimate ("4-pilot floor ≈560 takedowns → ~22 small + ~20 large + 8 room-clear large"):');
{
  const rs = SEEDS.map((sd) => runSwarm({ floor: 1, classes: comps.Mixed(4), seed: sd, kits: true, respawn: true, maxT: 900, connect: KITE, stopAfterRooms: 3 }));
  P(`   modelled floor 1 (3 sealed rooms + 2 hall packs), n=4: ${f0(avg(rs.map((r) => r.kills)))} takedowns, ${f1(avg(rs.map((r) => r.kitsDropped)))} kits dropped (incl. ${3 * 2} room-clear large), pops (kamikaze hits, no drop) ${f0(avg(rs.map((r) => r.pops)))}`);
}
writeFileSync(new URL('./v10_swarm.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
