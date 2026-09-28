// Runs every section and compiles the degenerate-combo flags + the dungeon ult-share estimate. node run_all.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const here = (f) => new URL('./' + f, import.meta.url);
const P = (f) => decodeURIComponent(here(f).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (!fs.existsSync(here('pve_profiles.json'))) execFileSync(process.execPath, [P('pvefeed.cjs')], { stdio: 'inherit' });
const SECTIONS = ['s1_ultcharge', 's2_ultimpact', 's3_special', 's4_stops', 's5_perks', 's6_pips', 's7_power'];
for (const s of SECTIONS) { process.stdout.write(`running ${s} ... `); execFileSync(process.execPath, [P(s + '.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] }); console.log('ok'); }

// ---- merge flags
const all = [];
for (const s of SECTIONS) { const f = here(s.split('_')[0] + '_flags.json'); if (fs.existsSync(f)) for (const x of JSON.parse(fs.readFileSync(f))) all.push({ ...x, src: s }); }
const seen = new Set(), flags = [];
for (const x of all) { const k = x.kit + '|' + x.what; if (!seen.has(k)) { seen.add(k); flags.push(x); } }
const order = { HIGH: 0, MED: 1, LOW: 2 };
flags.sort((a, b) => order[a.sev] - order[b.sev] || a.kit.localeCompare(b.kit));

// ---- dungeon: how much of a room the party's ults clear (rough upper bound, no overlap)
const s1 = JSON.parse(fs.readFileSync(here('s1_results.json')));
const sw = JSON.parse(fs.readFileSync(here('s2_swarm.json')));
const pv = JSON.parse(fs.readFileSync(here('pve_profiles.json')));
const ULTMAP = {
  hero: { brute: ['Hero Wrecking Run', 'Hero Carpet Bomb', 'Hero EMP Pulse'], tech: ['Hero Ion Storm', 'Hero Event Horizon', 'Hero Hyperlance'], engineer: ['Hero Drone Carrier', null, null] },
  arcade: { brute: ['Arcade Event Horizon'], tech: ['Arcade Ion Storm'], engineer: ['Arcade Overload Pulse'] },
  sortie: { brute: ['Sortie Event Horizon', 'Sortie Carpet Bomb', 'Sortie Rampage'], tech: ['Sortie Ion Storm', 'Sortie Hyperlance', 'Sortie Black Star'], engineer: [null, 'Sortie EMP Pulse', 'Sortie Drone Carrier'] },
};
const out = [];
out.push('Dungeon ult share (6-pilot 2/2/2 party): party ults per pulse x mean ult clear% of a pulse (S2-B) = share of the floor\'s swarm DE the ults alone remove (upper bound).');
for (const f of [1, 3, 6]) {
  const runs = pv.runs.filter((r) => r.floor === f);
  const floorSec = runs.reduce((a, r) => a + r.time, 0) / runs.length;
  const pulses = runs.reduce((a, r) => a + r.rooms, 0) / runs.length * (f >= 5 ? 4 : 3);
  for (const kit of ['hero', 'arcade', 'sortie']) {
    let per10 = 0, clear = 0, n = 0;
    for (const cls of ['brute', 'tech', 'engineer']) {
      const ids = Object.keys(s1[kit][`Dungeon f${f} (n6)`][cls]);
      ids.forEach((id, i) => { per10 += s1[kit][`Dungeon f${f} (n6)`][cls][id].per10; const nm = ULTMAP[kit][cls][i]; clear += nm ? sw[nm] : 0; n++; });
    }
    per10 /= n; clear /= n;
    const partyPerMin = per10 / 10 * 6, ultsPerFloor = partyPerMin * floorSec / 60, perPulse = ultsPerFloor / pulses;
    const share = Math.min(1, perPulse * clear);
    out.push(`  floor ${f}: ${kit.padEnd(6)} ${partyPerMin.toFixed(1)} party ults/min, ${ultsPerFloor.toFixed(1)} per floor (${floorSec.toFixed(0)} s, ${pulses.toFixed(0)} pulses) = ${perPulse.toFixed(2)} per pulse x mean clear ${(100 * clear).toFixed(0)}% -> ~${(100 * share).toFixed(0)}% of the pulse DE`);
    if (share >= 0.4 && f === 3) flags.push({ kit, sev: 'MED', what: 'Dungeon: party ults carry a large share of every pulse', detail: `floor 3: ${perPulse.toFixed(2)} ults per pulse x ${(100 * clear).toFixed(0)}% clear = ~${(100 * share).toFixed(0)}% of the swarm removed by ults alone; the variant-C ramp was validated without ults (riftParity / 6-bot Veteran must be re-run with ults on, expect ~+${(100 * share * 0.6).toFixed(0)}% budget).`, src: 'run_all' });
  }
}
flags.sort((a, b) => order[a.sev] - order[b.sev] || a.kit.localeCompare(b.kit));
const txt = [...out, '', 'FLAGS (degenerate combos / risks), most severe first:', ...flags.map((x) => `[${x.sev}] ${x.kit.toUpperCase()} - ${x.what}: ${x.detail} (${x.src})`)].join('\n');
fs.writeFileSync(here('flags.out.txt'), txt + '\n');
fs.writeFileSync(here('flags.json'), JSON.stringify(flags, null, 1));
console.log('\n' + txt);
