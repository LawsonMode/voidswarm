// S1. Ultimate uptime: ults per player per 10 min in Arena DM, Warzone and a 6-pilot Dungeon Runner floor, for each kit's
// charge model. PvP activity is a stochastic fight model calibrated to the Arena DM gate (>= 15 takedowns/min over 16 ships);
// PvE activity is the recorded per-pilot time series of the judge-validated CR swarm harness (pve_profiles.json, variant C).
import fs from 'node:fs';
import { rng, table, H, f0, f1, pct, flag, FLAGS } from './lib.mjs';
import { KIT_IDS, KIT_NAME, CHARGE, ULTS } from './kits.mjs';

const BIN = 0.1;
const EHP_AVG = 1110; // mean shield + integrity of the three classes (Arcade normalizes ship damage by victim EHP)

// ------------------------------------------------------------------ activity series
/** PvP / Warzone stochastic generator -> per-bin records. p = per-minute rates while alive. */
function genPvP(p, seconds, seed) {
  const R = rng(seed), n = Math.round(seconds / BIN);
  const bins = Array.from({ length: n }, () => ({ alive: 1, fight: 0, shipDmg: 0, healAlly: 0, healSelf: 0, mit: 0, de: 0, hp: 0, hpE: 0, td: 0, as: 0, elite: 0, room: 0, phase: 0, hive: 0, objSec: 0, cap: 0, ret: 0, zone: 0 }));
  const fightRate = p.fights ?? 3; // fights per alive-minute
  let i = 0;
  while (i < n) {
    // gap (travel / reposition) before the next fight
    const gap = -Math.log(1 - R()) * (60 / fightRate) * 0.55; i += Math.round(gap / BIN);
    const dur = 4 + R() * 6, nb = Math.round(dur / BIN);
    const perFight = (x) => (x ?? 0) / fightRate; // expected amount per fight
    const pois = (m) => { let k = 0, L = Math.exp(-m), q = 1; for (;;) { q *= R(); if (q < L) return k; k++; } };
    for (let j = 0; j < nb && i + j < n; j++) {
      const b = bins[i + j]; b.fight = 1;
      b.shipDmg += perFight(p.dmg) / nb; b.healAlly += perFight(p.healAlly) / nb; b.healSelf += perFight(p.healSelf) / nb; b.mit += perFight(p.mit) / nb;
      b.de += perFight(p.de) / nb; b.hp += perFight(p.hp) / nb; b.objSec += (p.objFrac ?? 0) * BIN;
    }
    const end = Math.min(n - 1, i + nb);
    bins[end].td += pois(perFight(p.td)); bins[end].as += pois(perFight(p.as)); bins[end].elite += pois(perFight(p.elite));
    bins[end].cap += pois(perFight(p.cap)); bins[end].zone += pois(perFight(p.zone));
    i = end + 1;
    if (R() < perFight(p.deaths)) { const dead = Math.round((p.respawn ?? 3) / BIN) + Math.round((p.travel ?? 4) / BIN); for (let j = 0; j < dead && i + j < n; j++) bins[i + j].alive = j < Math.round((p.respawn ?? 3) / BIN) ? 0 : 1; i += dead; }
  }
  return bins;
}

/** Dungeon: per-pilot series from pve_profiles.json (heals received are credited to the party's Artificers). */
function dungeonSeries(run) {
  const nb = run.pilots[0].alive.length;
  const engIdx = run.pilots.map((q, i) => (q.cls === 'engineer' ? i : -1)).filter((i) => i >= 0);
  const room = new Set(run.party.room), phase = new Set(run.party.phase);
  return run.pilots.map((q, i) => {
    const out = [];
    for (let b = 0; b < nb; b++) {
      let healAlly = 0, healSelf = 0;
      if (q.cls === 'engineer') {
        for (let k = 0; k < run.pilots.length; k++) {
          const h = run.pilots[k].heal[b] || 0; if (!h) continue;
          if (run.pilots[k].cls !== 'engineer') healAlly += h / engIdx.length;
          else if (k === i) { healSelf += h * 0.5; } else healAlly += h * 0.5;
        }
      }
      const alive = q.alive[b] ?? 1;
      out.push({ alive, fight: 0, shipDmg: 0, healAlly, healSelf, mit: q.cls === 'brute' ? (q.polTaken[b] || 0) : 0,
        deH: q.deH[b] || 0, deA: q.deA[b] || 0, hp: q.hp[b] || 0, hpE: q.hpE[b] || 0, td: 0, as: 0, elite: q.elite[b] || 0,
        room: room.has(b) && alive ? 1 : 0, phase: phase.has(b) && alive ? 1 : 0, hive: 0, objSec: 0, cap: 0, ret: 0, zone: 0 });
    }
    // party-wide hive bonus (Arcade: +6% to pilots within 1000 px): any pilot's hive kill
    for (let b = 0; b < nb; b++) for (const p2 of run.pilots) if (p2.hive[b]) out[b].hive += p2.hive[b];
    // "in combat" = some DE dealt by anyone in the party within the last 1.5 s
    const party = new Array(nb).fill(0);
    for (const p2 of run.pilots) for (let b = 0; b < nb; b++) party[b] += p2.deH[b] || 0;
    let last = -1e9;
    for (let b = 0; b < nb; b++) { if (party[b] > 0) last = b; out[b].fight = b - last <= 15 ? 1 : 0; }
    return out;
  });
}

// ------------------------------------------------------------------ charge engines
/**
 * Run a kit's charge model over bins. ult: {cost, dur}. mode: 'arena' | 'warzone' | 'dungeon'.
 * policy: 'ready' = cast the first alive bin at full; 'smart' = also wait for a fight (max hold 20 s).
 * opts: {sortieActiveDrain (default true), arcadeRoomPerPilot (n pilots alive, default 1)}
 */
function runCharge(kit, ult, bins, mode, policy, opts = {}) {
  const C = CHARGE[kit];
  let U = 0, bank = 0, activeUntil = -1, readyAt = -1;
  const casts = [];
  const cost = kit === 'arcade' ? 1 : kit === 'sortie' ? C.points : ult.cost;
  const dur = (mode === 'arena' && ult.durArena) ? ult.durArena : ult.dur;
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i], t = i * BIN, active = t < activeUntil, alive = b.alive > 0;
    if (kit === 'hero') {
      if (alive && !active) U += C.passive * BIN;
      if (!active) {
        const de = b.deH ?? b.de ?? 0;
        const stream = C.kShip * b.shipDmg + C.kHealAlly * b.healAlly + C.kHealSelf * b.healSelf + Math.min(C.mitCapPerSec * BIN, C.kMit * b.mit) + C.kDE * de;
        bank = Math.min(C.bucketMax, bank + stream);
        U += C.takedown * b.td + C.assist * b.as + C.objPerSec * b.objSec + C.capture * b.cap + C.room * b.room;
      }
      const mv = Math.min(bank, C.bucketRate * BIN); bank -= mv; if (!active) U += mv;
      U = Math.min(U, cost);
    } else if (kit === 'arcade') {
      const M = opts.mult ?? 1;
      if (alive && !active) U += C.passive * BIN * M;
      if (!active) {
        const de = b.deA ?? b.de ?? 0;
        const act = C.kShip * b.shipDmg / EHP_AVG + C.kHeal * (b.healAlly + C.selfMult * b.healSelf) / EHP_AVG + C.kPve * de;
        bank = Math.min(C.bankCap, bank + act);
        const roomMult = opts.arcadeRoomPerPilot ?? 1;
        U += M * (C.takedown * b.td + C.assist * b.as + C.elite * b.elite + C.room * b.room * roomMult + C.bossPhase * b.phase + C.hive * b.hive + C.capture * b.cap + C.zoneCapture * b.zone);
      }
      const mv = Math.min(bank, C.actRate * BIN); bank -= mv; if (!active) U += mv * M;
      U = Math.min(U, 1);
    } else {
      const M = opts.mult ?? 1;
      if (alive && !active) U += C.passive * BIN * M;
      const pts = M * ( C.kShip * b.shipDmg + C.kEnemy * (b.hp + (b.de && !b.hp ? b.de * 240 : 0)) + C.kEnemyElite * b.hpE + C.kHealAlly * b.healAlly + C.kHealSelf * b.healSelf + C.kMit * b.mit
        + C.takedown * b.td + C.assist * b.as + C.elite * b.elite + C.bossPhase * b.phase + C.room * b.room + C.capture * b.cap + C.holdPerSec * b.objSec);
      const gainOk = !active || (opts.sortieActiveDrain ?? true);
      if (gainOk) bank = Math.min(C.pendingCap, bank + pts);
      if (alive && gainOk) { const d = Math.min(bank, C.rate[mode] * BIN); bank -= d; U += d; }
      U = Math.min(U, cost);
    }
    // cast
    if (!active && alive && U >= cost - 1e-9) {
      if (readyAt < 0) readyAt = t;
      const hold = t - readyAt;
      if (policy === 'ready' || b.fight || hold >= 20) {
        casts.push({ t, wait: hold });
        U = 0; if (kit === 'sortie') bank = 0;
        activeUntil = t + dur; readyAt = -1;
      }
    }
  }
  return casts;
}

// ------------------------------------------------------------------ scenarios
const PVP = {
  'Arena avg': { dmg: 1650, td: 1.0, as: 0.9, deaths: 1.0, fights: 3 },
  'Arena top 25%': { dmg: 2600, td: 1.8, as: 1.1, deaths: 0.7, fights: 3.4 },
  'Arena weak': { dmg: 800, td: 0.4, as: 0.5, deaths: 1.3, fights: 2.6 },
  'Arena tank (Polarize)': { dmg: 1400, td: 0.8, as: 1.0, deaths: 0.8, mit: 600, fights: 3 },
  'Arena healer (Artificer)': { dmg: 900, td: 0.5, as: 1.4, deaths: 0.8, healAlly: 3000, healSelf: 300, fights: 3 },
  'Arena FFA avg (no assists)': { dmg: 1650, td: 1.0, as: 0, deaths: 1.0, fights: 3 },
  'Warzone avg (PvPvE)': { dmg: 700, td: 0.5, as: 0.4, deaths: 0.5, de: 22, hp: 22 * 240, elite: 0.4, fights: 3.5, travel: 6 },
  'Warzone Zones holder': { dmg: 600, td: 0.4, as: 0.5, deaths: 0.6, de: 18, hp: 18 * 240, elite: 0.3, objFrac: 0.45, zone: 0.5, fights: 3.5, travel: 6 },
};
const SEC = 600, SEEDS = [11, 22, 33, 44, 55, 66];
const lines = [];
const log = (s = '') => { lines.push(s); };

log(H('S1. Ultimate uptime (cast count per player per 10 min; charge kept on death; no gain while an ult runs where the kit says so)'));
log('PvP model: fights ~3/min (4-10 s each), rates below are per alive-minute; 16-ship Arena DM at 16 takedowns/min total (gate >= 15).');
log('PvE model: pve_profiles.json = recorded 0.1 s activity of each pilot in the CR swarm harness (variant C ramp, n=6 2/2/2, Veteran, 3 seeds).');
log('policy "smart" = cast when full AND in a fight (bots/humans do not waste it in travel); "ready" = the instant it is full (upper bound).');
log('Uptime = share of alive time the pilot has an ult active. Map-wide = 16 pilots (Arena/Warzone) or party of 6 (Dungeon).');

const results = {}; // results[kit][scenario][cls][ultId] = {per10, mean, uptime}
function record(kit, scen, cls, u, casts, seconds, pol = 'smart') {
  const per10 = casts.length / seconds * 600;
  const gaps = casts.slice(1).map((c, i) => c.t - casts[i].t);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : (casts.length ? casts[0].t : Infinity);
  ((results[kit] ??= {})[scen] ??= {})[cls] ??= {};
  const o = { per10, mean, first: casts.length ? casts[0].t : Infinity, uptime: casts.length * u.dur / seconds };
  if (pol === 'smart') results[kit][scen][cls][u.id] = { ...(results[kit][scen][cls][u.id] || {}), ...o };
  else (results[kit][scen][cls][u.id] ??= {}).ready = o;
}

// ---- PvP + Warzone
for (const [scen, p] of Object.entries(PVP)) {
  const mode = scen.startsWith('Warzone') ? 'warzone' : 'arena';
  for (const kit of KIT_IDS) for (const cls of ['brute', 'tech', 'engineer']) {
    if (scen.includes('tank') && cls !== 'brute') continue;
    if (scen.includes('healer') && cls !== 'engineer') continue;
    for (const u of ULTS[kit][cls]) {
      for (const pol of ['ready', 'smart']) {
        let all = [], tot = 0;
        for (const sd of SEEDS) { const bins = genPvP(p, SEC, sd); const c = runCharge(kit, u, bins, mode, pol); all.push(...c.map((x) => ({ ...x, t: x.t + tot }))); tot += SEC; }
        record(kit, scen, cls, u, all, tot, pol);
      }
    }
  }
}
// ---- Dungeon: per floor (loop the floor's series to 10 min) and the whole 6-floor run
const PV = JSON.parse(fs.readFileSync(new URL('./pve_profiles.json', import.meta.url)));
const byFloor = {};
for (const r of PV.runs) (byFloor[r.floor] ??= []).push(r);
function dungeonCasts(kit, u, seriesList, policy, opts) {
  let casts = [], tot = 0;
  for (const s of seriesList) { const c = runCharge(kit, u, s, 'dungeon', policy, opts); casts.push(...c.map((x) => ({ ...x, t: x.t + tot }))); tot += s.length * BIN; }
  return { casts, tot };
}
const loopTo = (series, sec) => { const out = []; while (out.length * BIN < sec) out.push(...series); return out.slice(0, Math.round(sec / BIN)); };
const dungeonScen = [];
for (const f of [1, 3, 6]) {
  const scen = `Dungeon f${f} (n6)`; dungeonScen.push(scen);
  for (const kit of KIT_IDS) for (const cls of ['brute', 'tech', 'engineer']) for (const u of ULTS[kit][cls]) {
    const lists = [];
    for (const r of byFloor[f]) { const ser = dungeonSeries(r); ser.forEach((s, i) => { if (r.pilots[i].cls === cls) lists.push(loopTo(s, SEC)); }); }
    for (const pol of ['ready', 'smart']) { const { casts, tot } = dungeonCasts(kit, u, lists, pol); record(kit, scen, cls, u, casts, tot, pol); }
  }
}
{
  const scen = 'Dungeon run f1-f6 (n6)'; dungeonScen.push(scen);
  const seeds = [...new Set(PV.runs.map((r) => r.seed))];
  for (const kit of KIT_IDS) for (const cls of ['brute', 'tech', 'engineer']) for (const u of ULTS[kit][cls]) {
    const lists = [];
    for (const sd of seeds) {
      const runs = PV.runs.filter((r) => r.seed === sd).sort((a, b) => a.floor - b.floor);
      const per = runs.map(dungeonSeries);
      for (let pi = 0; pi < 6; pi++) if (runs[0].pilots[pi].cls === cls) lists.push(per.flatMap((ser) => ser[pi]));
    }
    // charge carries across floors: run each pilot's whole run as one series
    for (const pol of ['ready', 'smart']) { const { casts, tot } = dungeonCasts(kit, u, lists, pol); record(kit, scen, cls, u, casts, tot, pol); }
  }
}

// ---- print
const scens = [...Object.keys(PVP), ...dungeonScen];
for (const kit of KIT_IDS) {
  log(`\n--- ${KIT_NAME[kit]} ---`);
  const rows = [];
  for (const scen of scens) for (const cls of ['brute', 'tech', 'engineer']) {
    const r = results[kit][scen]?.[cls]; if (!r) continue;
    for (const u of ULTS[kit][cls]) { const x = r[u.id]; rows.push([scen, cls, u.name, `${f1(x.per10)} (${f1(x.ready.per10)})`, `${f0(x.mean)} s (${f0(x.ready.mean)} s)`, f0(x.first) + ' s', pct(x.uptime)]); }
  }
  log(table(['scenario', 'class', 'ult', 'ults/10 min smart (ready)', 'mean gap smart (ready)', 'first ult', 'uptime'], rows));
}

// ---- map-wide summary
log('\n--- Map-wide ult density (cast-on-need, averaged over the three classes and their ults) ---');
const sumRows = [];
for (const kit of KIT_IDS) for (const scen of ['Arena avg', 'Warzone avg (PvPvE)', ...dungeonScen]) {
  let per10 = 0, up = 0, n = 0, rd = 0;
  for (const cls of ['brute', 'tech', 'engineer']) for (const u of ULTS[kit][cls]) { const x = results[kit][scen][cls][u.id]; per10 += x.per10; up += x.uptime; rd += x.ready.per10; n++; }
  per10 /= n; up /= n; rd /= n;
  const pilots = scen.startsWith('Dungeon') ? 6 : 16;
  sumRows.push([KIT_NAME[kit], scen, `${f1(per10)} (${f1(rd)})`, f1(per10 / 10 * pilots), f1(60 / (per10 / 10 * pilots)) + ' s', f1(up * pilots)]);
}
log(table(['kit', 'scenario', 'ults/pilot/10 min', `ults/min (map or party)`, 'one ult every', 'ults active at once'], sumRows));

// ---- sensitivity: spec ambiguities
log('\n--- Sensitivity to spec ambiguities ---');
{
  const u = ULTS.arcade.brute[0];
  const lists = []; for (const r of byFloor[1]) dungeonSeries(r).forEach((s, i) => { if (r.pilots[i].cls === 'brute') lists.push(loopTo(s, SEC)); });
  const a = dungeonCasts('arcade', u, lists, 'smart'), b = dungeonCasts('arcade', u, lists, 'smart', { arcadeRoomPerPilot: 6 });
  const ra = a.casts.length / a.tot * 600, rb = b.casts.length / b.tot * 600;
  log(`Arcade "rift room cleared: +6% for each live party pilot": read as +6% each -> ${f1(ra)} ults/10 min (Jugg, f1); read as +6% x 6 pilots -> ${f1(rb)} ults/10 min.`);
  if (rb > ra * 1.15) flag('arcade', 'MED', 'Room-clear bonus wording', `"+6% for each live party pilot" read as x6 = +36% per room per pilot -> ${f1(rb)} vs ${f1(ra)} ults/10 min on floor 1 (${pct(rb / ra - 1)} more). Pin it to +6% per pilot.`);
}
{
  const u = ULTS.sortie.tech[1]; // Hyperlance, short
  const u2 = ULTS.sortie.engineer[2]; // Drone Carrier, 12 s
  for (const uu of [u, u2]) {
    const bins = genPvP(PVP['Arena avg'], 3600, 7);
    const a = runCharge('sortie', uu, bins, 'arena', 'smart', { sortieActiveDrain: true }), b = runCharge('sortie', uu, bins, 'arena', 'smart', { sortieActiveDrain: false });
    log(`Sortie ${uu.name}: pending keeps draining while the ult runs -> ${f1(a.length / 6)} ults/10 min; blocked -> ${f1(b.length / 6)} (spec is silent; ult damage also feeds pending).`);
  }
  flag('sortie', 'LOW', 'Charge during an active ult is unspecified', 'Sortie only stops the PASSIVE while an ult runs; pending (incl. the ult\'s own damage) keeps filling and draining. Harmless in Arena (pending cap 400, rate 12/s floor 49 s) but state it: "no source points while ult-active; ult damage never charges".');
}

// ---- charge-rate cards
{
  const top = PVP['Arena top 25%'];
  const bins = genPvP(top, 3600, 9);
  const g = (kit, u, m) => { const c = runCharge(kit, u, bins, 'arena', 'ready', { mult: m }); const gaps = c.slice(1).map((x, i) => x.t - c[i].t); return gaps.length ? Math.min(...gaps) : Infinity; };
  const a0 = g('arcade', ULTS.arcade.tech[0], 1), a1 = g('arcade', ULTS.arcade.tech[0], 1.2);
  const s0 = g('sortie', ULTS.sortie.tech[1], 1), s1 = g('sortie', ULTS.sortie.tech[1], 1.3);
  log(`Charge cards (top-25% Arena pilot, shortest gap between two casts): Arcade Flux Core L4 (all gains x1.2): ${f0(a0)} s -> ${f0(a1)} s; Sortie Ultimate Core L3 (x1.3 on passive + points): ${f0(s0)} s -> ${f0(s1)} s (the spec's hard floor is 49 s in Arena).`);
  if (s1 < 49) flag('sortie', 'LOW', 'Ultimate Core breaks the 49 s Arena floor', `x1.3 on passive + points with the fixed 12/s drain: floor 1000/(8.5 x 1.3 + 12) = 43 s; model shortest gap ${f0(s1)} s. Scale the drain too or cap the card at x1.15.`);
  if (a1 < 52) flag('arcade', 'LOW', 'Flux Core pushes ults under the "never under ~52 s" promise', `all gains x1.2 -> ${f0(a1)} s shortest gap for a top pilot (floor 59.4 / 1.2 = 49.5 s).`);
}

// ---- first-ult timing & cross-kit checks
log('\n--- Checks against each spec\'s own claims ---');
const claim = (kit, scen, cls, uid, lo, hi, label) => {
  const x = results[kit][scen][cls][uid]; const gap = x.mean, g2 = x.ready.mean;
  const ok = (gap >= lo && gap <= hi) || (g2 >= lo && g2 <= hi);
  log(`${KIT_NAME[kit]}: ${label} -> model mean gap ${f0(gap)} s smart / ${f0(g2)} s cast-on-ready (claim ${lo}-${hi} s) ${ok ? 'OK' : 'DIFFERS'}`);
  return gap;
};
claim('hero', 'Arena avg', 'brute', 'wreckingrun', 55, 80, 'avg PvP pilot ~65-74 s');
claim('hero', 'Dungeon f1 (n6)', 'brute', 'wreckingrun', 64, 82, 'rift floor 1 ~72-82 s');
claim('hero', 'Dungeon f6 (n6)', 'tech', 'ionstorm', 50, 64, 'floor 6 ~55-64 s');
claim('arcade', 'Arena avg', 'brute', 'eventhorizon', 55, 70, 'avg PvP 61 s');
claim('arcade', 'Dungeon f1 (n6)', 'brute', 'eventhorizon', 60, 80, 'rift f1 73 s');
claim('arcade', 'Dungeon f6 (n6)', 'brute', 'eventhorizon', 50, 60, 'rift f6 55 s');
claim('sortie', 'Arena avg', 'brute', 'carpetbomb', 55, 80, 'Arena avg bot 70 s');
claim('sortie', 'Dungeon f1 (n6)', 'brute', 'carpetbomb', 65, 90, 'rift f1 78 s');
claim('sortie', 'Dungeon f6 (n6)', 'brute', 'carpetbomb', 55, 62, 'rift f6 58 s (at the floor)');

// ---- automatic flags
for (const kit of KIT_IDS) {
  let dens = 0, n = 0;
  for (const cls of ['brute', 'tech', 'engineer']) for (const u of ULTS[kit][cls]) { dens += results[kit]['Arena avg'][cls][u.id].per10; n++; }
  const perMin = dens / n / 10 * 16;
  if (perMin >= 14) flag(kit, 'MED', 'Arena ult density', `${f1(perMin)} ults/min across a 16-ship DM (one every ${f1(60 / perMin)} s): tells and fields will overlap constantly; consider a slower passive in Arena.`);
  const heal = results[kit]['Arena healer (Artificer)']?.engineer;
  if (heal) for (const u of ULTS[kit].engineer) { const x = heal[u.id]; const dmg = results[kit]['Arena avg'].engineer[u.id]; if (x.per10 > dmg.per10 * 1.25) flag(kit, 'LOW', 'Healer charges fastest', `${u.name}: healer ${f1(x.per10)} vs avg damage pilot ${f1(dmg.per10)} ults/10 min.`); }
  // Dungeon: party ult rate on floor 6
  let pd = 0, m = 0; for (const cls of ['brute', 'tech', 'engineer']) for (const u of ULTS[kit][cls]) { pd += results[kit]['Dungeon f6 (n6)'][cls][u.id].per10; m++; }
  const partyPerMin = pd / m / 10 * 6;
  if (partyPerMin > 5.5) flag(kit, 'MED', 'Dungeon ult chaining (party)', `6-pilot floor 6: ${f1(partyPerMin)} party ults/min (one every ${f1(60 / partyPerMin)} s); a sealed room (~40-60 s of pulses) sees ${f0(partyPerMin * 0.8)}+ ults: back-to-back ult chains trivialise pulses unless riftParity is re-tuned with ults on.`);
}

fs.writeFileSync(new URL('./s1_ultcharge.out.txt', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./s1_results.json', import.meta.url), JSON.stringify(results));
fs.writeFileSync(new URL('./s1_flags.json', import.meta.url), JSON.stringify(FLAGS, null, 1));
console.log(lines.join('\n'));
export { results };
