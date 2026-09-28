// Support + sustain numbers: duels, Repair Ray, Siphon, Polarize vs drones, fortress Juggernaut. Scratch only.
import { CLASSES, CLS, WEAPONS, KIND, DT, makeShip, damageShip, healShip, stepPilot, pad, padr, f1, f2, f0, ARMOR_CAP } from './v10_core.mjs';
import { writeFileSync } from 'node:fs';
const out = []; const P = (...a) => out.push(a.join(' '));

function hullMul(def, kind, armorOverride) {
  const K = KIND[kind]; const armor = armorOverride ?? CLASSES[def].armor;
  return K.vsHull * (1 - Math.min(ARMOR_CAP, Math.max(0, armor - K.pierce)));
}

// ------------------------------------------------------------------ duels
/** Each side: {cls, weapon, variant: 'phaser'|'tender'|'leech', sec: bool, acc, siphonInterp: 'raw'|'dealt'} */
function duel(a, b, dist, o = {}) {
  const A = makeShip(a.cls, { weapon: a.weapon ?? CLASSES[a.cls].weapon }), B = makeShip(b.cls, { weapon: b.weapon ?? CLASSES[b.cls].weapon });
  const sides = [[A, a, B], [B, b, A]];
  const q = [];
  let t = 0;
  const heal = { A: 0, B: 0 };
  while (t < 90) {
    t += DT;
    for (const [S, cfg, T] of sides) {
      let space = false, channel = false, lmb = true;
      if (cfg.variant === 'tender') { const need = S.integrity < 0.6 * S.maxIntegrity; if (need || (S.channeling && S.integrity < 0.95 * S.maxIntegrity)) { space = true; channel = true; lmb = false; } }
      if (cfg.variant === 'leech' && dist <= 480) { space = true; channel = true; lmb = false; }
      const pk = stepPilot(S, { lmb, rmb: !!cfg.sec, space, channel, variant: cfg.variant === 'leech' ? 'siphon' : 'standard', still: cfg.cls === 'tech', thrust: cfg.cls !== 'tech' }, { dist, disciplined: !!cfg.disc });
      for (const p of pk) q.push({ at: t + (p.src === 'weapon' && !WEAPONS[S.weapon].beam ? dist / WEAPONS[S.weapon].speed : (p.delay ?? 0)), p, T, acc: p.src === 'sentry' ? 0.8 : cfg.acc ?? 0.6 });
      if (S.channeling && cfg.variant === 'tender') heal[S === A ? 'A' : 'B'] += healShip(S, CLASSES.engineer.mob.self * DT);
      if (S.channeling && cfg.variant === 'leech') {
        const sc = CLASSES.engineer.siphon;
        const polar = T.polarized;
        if (polar) { healShip(T, sc.dps * 0.5 * DT); S.power -= sc.costPerSec * DT; }
        else {
          const r = damageShip(T, sc.dps * DT, { kind: 'ion' });
          const dealt = (o.siphonInterp === 'raw') ? sc.dps * DT : r.sDmg + r.H;
          heal[S === A ? 'A' : 'B'] += healShip(S, sc.ret * dealt);
          const drained = Math.min(T.power, sc.drain * DT); T.power -= drained; S.power = Math.min(S.maxPower, S.power + drained * sc.gainFrac);
        }
      }
    }
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= t) { const { p, T, acc } = q[i]; q.splice(i, 1); damageShip(T, p.amount * acc, { kind: p.kind, bleed: p.bleed, breakLock: p.breakLock }); }
    if (A.integrity <= 0 || B.integrity <= 0) break;
  }
  const win = A.integrity <= 0 && B.integrity <= 0 ? 'draw' : A.integrity <= 0 ? 'B' : B.integrity <= 0 ? 'A' : 'none';
  return { t, win, A, B, heal };
}
P('=== F. 1v1 duels (both shoot, 60% accuracy on weapons/skills, Laser users stand still, others thrust; hold LMB+RMB; fixed distance) ===');
P('  A vs B            @d   | winner  time  | A hull left  B hull left');
const kits = { brute: { cls: 'brute', sec: true }, tech: { cls: 'tech', sec: true }, engineer: { cls: 'engineer', sec: true },
  tender: { cls: 'engineer', sec: true, variant: 'tender' }, leech: { cls: 'engineer', sec: true, variant: 'leech' } };
const name = (k) => ({ brute: 'Jugg MD', tech: 'Arca LZ', engineer: 'Arti PH', tender: 'Arti PH+Tender', leech: 'Arti Leech' })[k];
for (const [x, y] of [['brute', 'tech'], ['brute', 'engineer'], ['tech', 'engineer'], ['brute', 'tender'], ['tech', 'tender'], ['brute', 'leech'], ['tech', 'leech'], ['engineer', 'leech'], ['tender', 'leech']]) {
  for (const d of [120, 350, 600]) {
    const r = duel(kits[x], kits[y], d);
    const wn = r.win === 'A' ? name(x) : r.win === 'B' ? name(y) : r.win;
    P(`  ${padr(name(x) + ' vs ' + name(y), 28)}@${pad(d, 3)} | ${padr(wn, 15)} ${pad(f1(r.t), 5)} | ${pad(f0(Math.max(0, r.A.integrity)), 5)}/${f0(r.A.maxIntegrity)}   ${pad(f0(Math.max(0, r.B.integrity)), 5)}/${f0(r.B.maxIntegrity)}`);
  }
}
P('  (Leech self-repair = 60% of POST-mitigation damage dealt (shield dmg counts ×2.5 for ion); "raw" interpretation below)');
for (const [x, y] of [['brute', 'leech'], ['tech', 'leech']]) for (const d of [350]) {
  const r = duel(kits[x], kits[y], d, { siphonInterp: 'raw' });
  P(`  RAW-interp ${padr(name(x) + ' vs ' + name(y), 22)}@${d} | ${r.win === 'A' ? name(x) : name(y)} ${f1(r.t)} s; leech healed ${f0(r.heal.B)}`);
}
P('');

// ------------------------------------------------------------------ Repair Ray
P('=== G. Repair Ray (Tender) sustain vs incoming DPS (target shield already broken; hull-only) ===');
const ray = CLASSES.engineer.mob;
P(`  Ray power: 90/s × (1+0.2·min(3,t)) → 144/s after 3 s (Medic 108/s) vs Artificer regen 280/s: net +${f0(280 - 144 - 18)}/s while thrusting → INFINITE channel.`);
P('  Break-even raw incoming DPS (hull loss = heal):  heal / (vsHull × (1 − armorEff))');
P('  heal source                  hull/s | vs Jugg kin/en/ion   | vs Arca kin/en/ion  | vs Arti kin/en/ion');
const heals = [['ally ray (0-3 s)', 180], ['ally ray fatigued ×0.6', 108], ['ally ray, 2 targets alternating (no fatigue)', 180], ['Medic ray +40%', 252], ['Medic fatigued', 151], ['Medic+Triage (<30% hull)', 378], ['self ray (no fatigue)', 120], ['Medic self ray', 168], ['2 Tenders cross-healing (each)', 180]];
for (const [n, h] of heals) {
  const cells = CLS.map((d) => ['kinetic', 'energy', 'ion'].map((k) => pad(f0(h / hullMul(d, k)), 4)).join('/'));
  P(`  ${padr(n, 44)} ${pad(h, 4)} | ${cells.join('  | ')}`);
}
P('  Reference incoming raw DPS at 60% accuracy: Jugg MD@120 405 (kin, +15%), MD@350 280, Arca Laser still 331 (en), Arti Phaser 254 (ion).');
function pocketTTK(def, att, wid, dist, healMode, acc = 0.6) {
  const A = makeShip(att, { weapon: wid }), D = makeShip(def); const q = [];
  let t = 0, onSince = 0, healed = 0;
  while (t < 120) {
    t += DT;
    const pk = stepPilot(A, { lmb: true, still: true }, { dist });
    for (const p of pk) q.push({ at: t + (p.src === 'weapon' && !WEAPONS[wid].beam ? dist / WEAPONS[wid].speed : 0), p });
    stepPilot(D, {}, {});
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= t) { const p = q[i].p; q.splice(i, 1); damageShip(D, p.amount * acc, { kind: p.kind, bleed: p.bleed, breakLock: p.breakLock }); }
    if (healMode) {
      let h = healMode.rate;
      if (healMode.fatigue && t - onSince > 3) h *= 0.6;
      if (healMode.triage && D.integrity < 0.3 * D.maxIntegrity) h *= 1.5;
      healed += healShip(D, h * DT);
    }
    if (D.integrity <= 0) return { t, healed };
  }
  return { t: Infinity, healed };
}
P('  TTK with a Tender pocketing the defender (60% acc, hold LMB): none / ray+fatigue / ray alternating / Medic+Triage+fatigue');
for (const def of CLS) for (const [att, wid, d] of [['brute', 'massdriver', 120], ['brute', 'massdriver', 350], ['tech', 'laser', 600], ['engineer', 'phaser', 400]]) {
  const r0 = pocketTTK(def, att, wid, d, null), r1 = pocketTTK(def, att, wid, d, { rate: 180, fatigue: true }), r2 = pocketTTK(def, att, wid, d, { rate: 180 }), r3 = pocketTTK(def, att, wid, d, { rate: 252, fatigue: true, triage: true });
  P(`   ${padr(CLASSES[def].short, 5)} ← ${padr(CLASSES[att].short + ' ' + WEAPONS[wid].short + '@' + d, 14)}: ${pad(f1(r0.t), 5)} / ${pad(f1(r1.t), 5)} / ${pad(f1(r2.t), 5)} / ${pad(f1(r3.t), 5)} s`);
}
P('');

// ------------------------------------------------------------------ Siphon
P('=== H. Siphon Ray (Leech) value ===');
const sc = CLASSES.engineer.siphon;
for (const def of CLS) {
  const c = CLASSES[def];
  const shieldRate = sc.dps * 2.5; const hullRate = sc.dps * hullMul(def, 'ion');
  const tShield = c.maxShield / shieldRate, tHull = c.maxIntegrity / hullRate;
  const healDealtShield = sc.ret * shieldRate, healDealtHull = sc.ret * hullRate, healRaw = sc.ret * sc.dps;
  P(`  vs ${padr(c.short, 5)}: strips shield in ${f2(tShield)} s (275/s), then hull ${f0(hullRate)}/s → full TTK ${f1(tShield + tHull)} s alone. Self-repair: ${f0(healDealtShield)}/s on shield phase, ${f0(healDealtHull)}/s on hull phase ("dealt" reading) or ${f0(healRaw)}/s ("raw" reading). Target power −60/s, you +30/s.`);
}
P(`  Cost 70/s ×1.6 = 112/s − 30/s gained = 82/s net vs 280 regen → infinite. Phaser comparison: 424 ion dps (1059 vs shield) — the Siphon is 26% of the Phaser's damage.`);
P(`  Polarize reversal: Jugg healed 55 hull/s; siphoner pays 2× = 140 → 224/s at 3 s+ (+18 thrust = 242 < 280 regen) → reversal is NOT a power punishment for the Artificer.`);
P(`  PvE: 140 dps, 40% return = 56 hull/s self-repair forever (cost 112/s) = offsets ${f1(56 / (110 * 1.15 * 0.95))} drone contacts/s (drone 110 kin → 120 hull on an Artificer).`);
P('');

// ------------------------------------------------------------------ Polarize vs drones
P('=== I. Polarize Shields vs a drone swarm (Juggernaut, base stats, MD fired with bot heat discipline; drones arrive at a steady rate) ===');
{
  const h = polarRun(2, 0, 'on', 'hold');
  P(`  !! Holding LMB (no discipline) with Polarize on, 2 drones/s: MD overheats at 2.9 s, taps own shield 320/s → Polarize drops when the SELF-TAP empties the shield; takedown at ${f1(h.deadAt)} s after only ${h.kills} polarized kills.`);
}
function polarRun(rate, L, mode, wmode = 'disc') {
  const s = makeShip('brute');
  let t = 0, acc = 0, kills = 0, contactsHull = 0, brokeAt = -1, deadAt = -1;
  const contact = 110 * (1 + 0.07 * L);
  while (t < 60) {
    t += DT; acc += rate * DT;
    stepPilot(s, { lmb: wmode !== 'off', thrust: true, polarize: mode !== 'off' }, { dist: 150, disciplined: wmode === 'disc' });
    while (acc >= 1) {
      acc -= 1;
      if (s.polarized) {
        // kamikaze dies on touch through killEnemy; 25% of its contact reaches the shield
        const f = mode === 'prow' ? 0.25 * 0.3 : 0.25;
        const r = damageShip(s, contact * f, { kind: 'kinetic' });
        if (mode === 'noAbsorb') {/* nothing */}
        s.power -= 10; kills++;
        if (r.broke && brokeAt < 0) brokeAt = t;
      } else {
        const r = damageShip(s, contact, { kind: 'kinetic' }); contactsHull++;
        if (r.broke && brokeAt < 0) brokeAt = t;
      }
      if (s.power < 0) s.power = 0;
    }
    if (s.integrity <= 0) { deadAt = t; break; }
  }
  return { kills, brokeAt, deadAt, s, contactsHull };
}
P('  drones/s  Threat L | Polarize ON: shield breaks at  drones eaten  takedown at | OFF: shield breaks  takedown at | power left (ON)');
for (const L of [0, 6.2, 13.7]) for (const rate of [1, 2, 4, 8]) {
  const on = polarRun(rate, L, 'on'), off = polarRun(rate, L, 'off');
  const on0 = polarRun(rate, L, 'on', 'off');
  P(`  ${pad(rate, 5)}     ${pad(L, 5)}   | ${pad(f1(on.brokeAt), 8)} s                ${pad(on.kills, 4)}         ${pad(f1(on.deadAt), 5)} s | ${pad(f1(off.brokeAt), 6)} s       ${pad(f1(off.deadAt), 5)} s | ${f0(on.s.power)}  | weapon off: breaks ${f1(on0.brokeAt)} s, ${on0.kills} eaten, down ${f1(on0.deadAt)} s`);
}
P('  Shield per drone while polarized: 110×0.25×0.85×(1−0.45) = 12.9 (L=0) → 50 drones per full shield; if the 0.45 absorb is NOT applied on top: 23.4 → 28 drones.');
P(`  Ram path Spiked Prow (×0.3) stacked with Polarize (×0.25) and absorb: 110×0.075×0.85×0.55 = ${f1(110 * 0.075 * 0.85 * 0.55)} shield per drone → ${f0(650 / (110 * 0.075 * 0.85 * 0.55))} drones per shield (effectively kamikaze-immune).`);
{
  const r = polarRun(8, 0, 'prow');
  P(`  Ram+Polarize at 8 drones/s, L=0: shield breaks at ${f1(r.brokeAt)} s, ${r.kills} kills in 60 s, power left ${f0(r.s.power)}`);
}
P('  Power: 40/s + 10/contact vs (170 − 28 thrust) = sustainable up to 10.2 contacts/s indefinitely on base stats (weapon off).');
P('');

// ------------------------------------------------------------------ Fortress Juggernaut
P('=== J. "Unkillable Juggernaut" checks (EHP vs energy, and heal break-even) ===');
function ehp(shield, hull, armor, kind, absorb = 0, brace = false) {
  const K = KIND[kind];
  const sm = K.vsShield * (1 - absorb) * (brace ? 0.65 : 1);
  const hm = K.vsHull * (1 - Math.min(ARMOR_CAP, Math.max(0, armor - K.pierce))) * (brace ? 0.75 : 1);
  return { e: shield / sm + hull / hm, hm };
}
const configs = [
  ['base Jugg', 650, 900, 0.40, 0, false, 0],
  ['base Jugg polarized', 650, 900, 0.40, 0.45, false, 0],
  ['Bulwark lvl~15 (shield×1.35×1.6 emitters5, hull×1.15×1.25 Titan×1.6 bulkhead5, plating5 → armor .65)', 650 * 1.35 * 1.6, 900 * 1.15 * 1.25 * 1.6, 0.65, 0.45, false, 0],
  ['Dreadnought n=5 of the above (+.15 armor→cap .70, shield ×1.4) + Brace', 650 * 1.35 * 1.6 * 1.4, 900 * 1.15 * 1.25 * 1.6, 0.8, 0.45, true, 0],
  ['  ... + 2 Hull Weld turrets (280/s) + a Tender ray (180/s, fatigue-free by alternating)', 650 * 1.35 * 1.6 * 1.4, 900 * 1.15 * 1.25 * 1.6, 0.8, 0.45, true, 460],
];
for (const [n, sh, hu, ar, ab, br, heal] of configs) {
  const cells = ['kinetic', 'energy', 'ion'].map((k) => { const r = ehp(sh, hu, ar, k, ab, br); return `${k} EHP ${f0(r.e)}${heal ? ' / break-even ' + f0(heal / r.hm) + ' raw dps' : ''}`; });
  P(`  ${n}: shield ${f0(sh)} hull ${f0(hu)} armor ${Math.min(0.7, ar).toFixed(2)}\n      ` + cells.join(' | '));
}
P('  Docked turret power: Artificer welder regen 280×1.5 (docked)×1.5 (Clamp) = 630/s vs Weld 150/s; Juggernaut bracer 170×1.5×1.5 = 382/s vs Brace 160/s → both INFINITE.');
P('  6 attackers at 60%: MD@120 6×405 = 2430 raw kin (> 1333 break-even: net ~1100/s vs 5.9k hull-EHP ... dies in ~5 s after shield);');
P('                      Laser still 6×331 = 1986 raw energy (< 2044 break-even) → the Dreadnought NEVER dies to 6 laser Arcanists once shields are gone,');
P('                      Phaser 6×254 = 1524 raw ion (< 3407) → never dies to Phasers.');
P('  EMP vs it: capital ×0.6 shield disrupt, 1.5 s EMP. Spec says EMP stops channels + turret OFFENSE, but not Brace / Hull Weld (turret DEFENSE) → EMP does not break the loop.');
P('');

writeFileSync(new URL('./v10_support.out.txt', import.meta.url), out.join('\n'));
console.log(out.join('\n'));
