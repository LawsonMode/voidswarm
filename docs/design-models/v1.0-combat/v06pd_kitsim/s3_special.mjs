// S3. E special uptime per kit / class / variant: effect uptime when cast on cooldown, with path bonuses and Flux Core 4
// (cooldowns x0.9^4 = 0.656, multiplicative as in live upgrades.ts), plus how long a held stance can be sustained on power.
import fs from 'node:fs';
import { CLASSES, SHORT, table, H, f0, f1, pct, flag, FLAGS, STRAIN_REGEN, LOAD_SURCHARGE } from './lib.mjs';
import { KIT_IDS, KIT_NAME, SPECIALS, ALTFIRE, CLASS_OVERRIDE } from './kits.mjs';
const lines = []; const log = (s = '') => lines.push(s);
const FLUX = Math.pow(0.9, 4);
function uptime(sp, cdMult = 1, durAdd = 0) {
  const cd = sp.cd * cdMult, dur = sp.dur + durAdd;
  if (sp.kind === 'stance') return { up: dur / (dur + (sp.cdFromEnd ? cd : Math.max(0, cd - dur))), perMin: 60 / (dur + (sp.cdFromEnd ? cd : Math.max(cd, dur))) };
  if (sp.kind === 'summon') return { up: Math.min(1, sp.life / cd / sp.max), alive: Math.min(sp.max, sp.life / cd), perMin: 60 / cd };
  return { up: Math.min(1, dur / cd), perMin: 60 / cd, overlap: dur / cd };
}
log(H('S3. E special uptime (effect active share when used on cooldown); Flux Core 4 = cooldowns x0.656'));
const rows = [];
for (const kit of KIT_IDS) for (const cls of ['brute', 'tech', 'engineer']) for (const sp of SPECIALS[kit][cls]) {
  const b = uptime(sp), fx = uptime(sp, FLUX);
  const extra = [];
  if (sp.id === 'gwell') { const v = uptime(sp, sp.voidCd / sp.cd), vd = uptime(sp, sp.voidCd / sp.cd, 2), vdf = uptime(sp, sp.voidCd / sp.cd * FLUX, 2); extra.push(`Void ${pct(v.up)}; +Deep Well (+2 s) ${pct(vd.up)}; +Flux4 ${f1(vdf.overlap)} wells up at once`); if (vdf.overlap >= 1) flag(kit, 'MED', 'Permanent Gravity Well', `Void path (cd ${sp.voidCd} s) + voi_horizon (+2 s) + Flux Core 4: ${f1(vdf.overlap)} wells alive on average (${pct(Math.min(1, vdf.overlap))} uptime) - a standing 280-360 px pull zone; cap wells at 1 alive or make Deep Well +1 s.`); }
  if (sp.kind === 'summon') extra.push(`Summoner (${sp.maxSummoner} max): ${f1(Math.min(sp.maxSummoner, sp.life / sp.cd))} alive; +Flux4 ${f1(Math.min(sp.maxSummoner, sp.life / (sp.cd * FLUX)))}`);
  if (sp.id === 'repair' && sp.medicCd) extra.push(`Medic Pulse cd ${sp.medicCd} s -> ${f1(60 / sp.medicCd)}/min; +Flux4 ${f1(60 / (sp.medicCd * FLUX))}/min`);
  if (sp.sustain) {
    // sustain on power alone (L2: LMB + sustain), Juggernaut reactor 1000 @ 280, MD cold 180/s, thrust 40
    const c = CLASSES[cls];
    const net = c.R * STRAIN_REGEN[2] - 40 - 180 * LOAD_SURCHARGE[2] - sp.sustain * LOAD_SURCHARGE[2];
    const noGun = c.R * STRAIN_REGEN[1] - 40 - sp.sustain * LOAD_SURCHARGE[1];
    extra.push(`hold: +LMB net ${f0(net)}/s -> ${f1(c.P / -net)} s past the 4 s tap; sustain alone net ${f0(noGun)}/s -> ${noGun >= 0 ? 'FOREVER' : f1(c.P / -noGun) + ' s'}`);
    const underFire = noGun - c.Sr * 1 * 0.6; // shield regen under fire at L1 costs 0.6 power per point
    extra.push(`under fire (shield regen ${c.Sr}/s x0.6 power): net ${f0(underFire)}/s -> ${f1(c.P / -underFire)} s`);
    if (noGun >= 0) flag(kit, 'MED', 'Polarize sustain alone is power-positive', `L1 sustain (no gun): ${c.R} regen - 40 thrust - ${sp.sustain} = +${f0(noGun)}/s (+${f0(noGun + 40)} parked), so it never ends off-fire; under sustained fire the free shield regen (${c.Sr}/s x 0.6 power) makes it ${f0(underFire)}/s -> ${f1(c.P / -underFire)} s of 0.5 hardening, kamikaze-proof shell and shield regen while tanking. The judge's 140 -> 200 fix only bites while shooting; count the sustain as 2 load or 260/s.`);
  }
  if (sp.drainPerSec) extra.push(`drain ${sp.drainPerSec}/s (no load)`);
  rows.push([KIT_NAME[kit], SHORT[cls], sp.name, sp.kind, `${sp.dur ?? sp.life} s / cd ${sp.cd} s${sp.cdFromEnd ? ' (from end)' : ''}`, pct(b.up) + (b.alive != null ? ` (${f1(b.alive)} alive)` : ''), f1(b.perMin), pct(fx.up) + (fx.alive != null ? ` (${f1(fx.alive)} alive)` : ''), extra.join('; ')]);
  if (fx.up >= 0.5 && sp.kind === 'stance' && sp.id !== 'polarize') flag(kit, 'LOW', `${sp.name} near-half uptime`, `${pct(fx.up)} uptime with Flux Core 4.`);
}
log(table(['kit', 'class', 'special', 'kind', 'duration / cooldown', 'uptime', 'casts/min', 'uptime Flux4', 'notes'], rows));

log('\nAlt fire (RMB) and walls where they matter:');
const r2 = [];
// Hero Architect wall: E cd 10.5 (path -25% already), life 6
{
  const w = SPECIALS.hero.engineer[1];
  r2.push(['Hero Kits', 'Architect Shield Wall (E)', pct(w.dur / w.cd), pct(w.dur / (w.cd * FLUX)), `${f1(w.dur / (w.cd * FLUX))} walls avg with Flux4`]);
}
{ // Arcade Architect: RMB wall, 2 charges, 7 s each, max 3 standing, life 6
  const rate = 1 / 7, rateF = 1 / (7 * FLUX);
  r2.push(['Arcade Kit', 'Architect Shield Wall (RMB, 2 charges / 7 s, max 3)', `${f1(6 * rate)} walls avg`, `${f1(6 * rateF)} walls avg`, 'burst: 2 walls at once, then 1 per 7 s']);
  if (6 * rateF >= 1) flag('arcade', 'MED', 'Permanent Shield Wall (Architect)', `2 charges at 7 s each + Flux Core 4 -> ${f1(6 * rateF)} walls standing on average (${pct(Math.min(1, 6 * rateF))} of the time at least one 2400-hp wall, Reinforced ones reflect lasers). Hero/Sortie walls sit at ${pct(6 / 10.5)} / ${pct(6 / 12)} base.`);
}
{
  const w = SPECIALS.sortie.engineer[2];
  r2.push(['Sortie Loadout', 'E3 Shield Wall (cd 12)', pct(w.dur / w.cd), pct(w.dur / (w.cd * FLUX)), 'Architect path: special cd -20% (x0.8)']);
}
{ // Arcade sentries on RMB cd 3 s
  r2.push(['Arcade Kit', 'Deploy Sentry (RMB, cd 3 s, life 15, max 2 / Summoner 4)', '2 alive always', '4 alive always (Summoner)', `200 power per 3 s if spammed = 67/s`]);
  r2.push(['Sortie Loadout', 'Deploy Sentry (RMB, cd 3 s, life 15, max 2 / Summoner 4)', '2 alive always', '4 alive always (Summoner)', '']);
  r2.push(['Hero Kits', 'Deploy Sentry (E, cd 7 s)', '2 alive always', `Summoner ${f1(15 / 7)} -> Flux4 ${f1(15 / (7 * FLUX))} of 4`, 'cd 3 -> 7 s makes Summoner a real choice']);
}
log(table(['kit', 'tool', 'uptime / alive', 'with Flux Core 4', 'note'], r2));

log('\nCapital skills on E (all three kits move them from Space to E): Broadside 180 / 8 s; Resonance Overcharge 4 s / 14 s = ' + pct(4 / 14) + ' (Flux4 ' + pct(4 / (14 * FLUX)) + '); Repair Bay 4 s / 16 s = ' + pct(4 / 16) + ' (Flux4 ' + pct(4 / (16 * FLUX)) + ').');
log('Hosting replaces the class special: a Bulwark Dreadnought loses Polarize (Arcade/Sortie keep bul_fortress as the compensation).');
fs.writeFileSync(new URL('./s3_special.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s3_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
