// Dungeon Runner swarm model under the §13 Threat ramp + §10 kit economy. Scratch only.
// Abstraction: the party stands together at the room center; enemies spawn 300–650 px out and close at their speed;
// party damage (from each pilot's real stepPilot power/heat loop) is applied nearest-first × an efficiency factor.
import { CLASSES, WEAPONS, DT, makeShip, damageShip, healShip, stepPilot, pad, padr, f1, f2, f0 } from './v10_core.mjs';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- rng
function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- design formulas (§13)
export const countMult = (n) => 1 + 0.3 * (Math.min(n, 4) - 1) + 0.2 * Math.max(0, n - 4);
export const hpMult = (n) => 1 + 0.25 * (Math.min(n, 4) - 1) + 0.15 * Math.max(0, n - 4);
export const bossMult = (n) => 1 + 0.6 * (Math.min(n, 4) - 1) + 0.4 * Math.max(0, n - 4);
export const lives = (n, d = 0) => Math.min(16, Math.max(2, 2 + 2 * Math.min(n, 3) + Math.max(0, n - 3) + d));
const DIFF = { story: { D: -1, hp: 0.7, count: 0.8, lives: 2 }, veteran: { D: 0, hp: 1, count: 1, lives: 0 }, nightmare: { D: 2, hp: 1.4, count: 1.25, lives: -2 } };
const DEF = {
  drone: { hp: 160, speed: 175, contact: 110, kami: true, cost: 1, xp: 1, drop: 'k' },
  dart: { hp: 130, speed: 130, contact: 160, kami: true, cost: 1, xp: 2, drop: 'k' },
  weaver: { hp: 210, speed: 215 * 0.75, contact: 120, kami: true, cost: 1, xp: 2, drop: 'k' },
  splitling: { hp: 80, speed: 265, contact: 60, kami: true, cost: 1, xp: 1, drop: 'k' },
  splitter: { hp: 380, speed: 140, contact: 90, kami: false, cost: 2, xp: 3, drop: 'm' },
  spinner: { hp: 420, speed: 180, contact: 80, kami: false, ranged: true, cost: 2, xp: 4, drop: 'm' },
  brute: { hp: 2400, speed: 90, contact: 240, kami: false, cost: 5, xp: 10, drop: 'b' },
  blackhole: { hp: 1800, speed: 35, contact: 180, kami: false, cost: 6, xp: 12, drop: 'h' },
};
function kindWeights(f, L, allowBH) {
  const hive = f <= 3;
  const t = [['drone', 10], ['dart', 4 * (1 + 0.06 * L)], ['weaver', 3 * (1 + 0.06 * L)]];
  if (L >= 1.5 || f >= 2) t.push(['splitter', 3], ['spinner', 2]);
  if (L >= 3 || f >= 3) t.push(['brute', 1.2]);
  if ((L >= 9 || f >= 5) && allowBH) t.push(['blackhole', 0.3]);
  for (const r of t) if ((hive && (r[0] === 'drone' || r[0] === 'splitter')) || (!hive && (r[0] === 'spinner' || r[0] === 'weaver'))) r[1] *= 1.5;
  return t;
}
function pick(rng, t) { let s = 0; for (const r of t) s += r[1]; let x = rng() * s; for (const r of t) { x -= r[1]; if (x <= 0) return r[0]; } return t[t.length - 1][0]; }
export const threatBase = (f, D) => Math.max(0, 1.5 * (f - 1) + D);

// ---------------------------------------------------------------- growth assumption (NOT in the spec: player power curve)
export function growth(f, g = 1, mode = 'base') {
  if (mode === 'matched') {
    // offense scaled so a floor-start pulse dies as fast as on floor 1 (EHP-rate factor), defense as base
    const L = threatBase(f, 0);
    const need = ((8 + 2 * f) / 10) * (1 + 0.08 * L) * (1 + 0.06 * L) * Math.min(1.4, 1 + 0.03 * L);
    return { dmg: need, auto: 60 * need, def: 1 + 0.05 * (f - 1) };
  }
  return {
    dmg: 1 + 0.12 * g * (f - 1),            // weapon/skill cards (Heavy Rounds, Rapid, Multi, talents)
    auto: (60 + 50 * (f - 1)) * g,          // free auto-weapons dps, AoE ×2 (Orbit, Seeker, Nova, Arc, Mines)
    def: 1 + 0.05 * g * (f - 1),            // emitters / bulkhead / plating picks
  };
}

// ---------------------------------------------------------------- the sim
export function runSwarm(cfg) {
  const rng = mulberry(cfg.seed ?? 1);
  const f = cfg.floor, n = cfg.classes.length, diff = DIFF[cfg.diff ?? 'veteran'];
  const G = growth(f, cfg.g ?? 1, cfg.growth ?? 'base');
  const eff = cfg.eff ?? 0.5;
  const pilots = cfg.classes.map((c, i) => {
    const s = makeShip(c, { shieldMult: G.def, hullMult: G.def, weapon: (cfg.weapons && cfg.weapons[i]) || undefined });
    s.idx = i; s.alive = true; s.dmgSinceKit = 0; s.respawnAt = 0; s.hullLost = 0; s.kitsPicked = 0; s.hullFromKits = 0; s.healRecv = 0;
    s.polarWant = false; s.rayOn = -1; s.rayOnSince = 0; s.lastThreatT = 0;
    if (cfg.startHull != null) s.integrity = s.maxIntegrity * cfg.startHull;
    if (cfg.shieldDelayMult) { s.shieldDelay *= cfg.shieldDelayMult; }
    return s;
  });
  const E = []; // enemies {kind, hp, maxHp, d, speed, contact, elite, kami, target, nextHit, pulse}
  const kits = []; // {frac, at}
  let t = 0, L = threatBase(f, diff.D), livesLost = 0, livesLeft = lives(n, diff.lives), pulsesCleared = 0;
  const st = { kitsDropped: 0, kitHull: 0, dmgTaken: 0, downs: 0, rooms: 0, firstDownT: -1, kills: 0, pops: 0, polarKills: 0, roomTimes: [], hullLostRoom1: 0, spawned: 0, xp: 0, rayHeal: 0 };
  const pulseAlive = new Map(); let pulseId = 0;
  // room schedule
  const pulsesPerRoom = cfg.pulses ?? (f >= 4 ? 4 : 3);
  let room = { k: 0, fired: 0, lastPulseT: -1e9, lastCount: 0, start: 0, done: false, nextAt: 0.8, hallDone: false };
  let walkUntil = -1;
  const maxT = cfg.maxT ?? 600;
  const aliveCount = () => E.length;
  const bhIn = () => E.some((e) => e.kind === 'blackhole');
  function spawnBody(kind, dist, pid) {
    const d = DEF[kind];
    const elite = rng() < Math.min(0.25, 0.05 + 0.012 * L);
    const inst = t > 420 ? 1 + 0.1 * (t - 420) / 60 : 1;
    const hp = d.hp * (1 + (cfg.hpPerL ?? 0.06) * L) * hpMult(n) * diff.hp * inst * (elite ? 3 : 1);
    const target = pilots[Math.floor(rng() * n)];
    E.push({ kind, hp, maxHp: hp, d: dist, speed: d.speed * Math.min(1.4, 1 + 0.03 * L), contact: d.contact * Math.min(cfg.contactCap ?? 99, 1 + (cfg.contactPerL ?? 0.07) * L) * (elite ? (cfg.eliteContact ?? 1.5) : 1),
      elite, kami: d.kami, ranged: !!d.ranged, target, nextHit: 0, pulse: pid, xp: d.xp * (elite ? 3 : 1) * (1 + 0.05 * L) });
    st.spawned++;
    if (pid >= 0) pulseAlive.set(pid, (pulseAlive.get(pid) ?? 0) + 1);
  }
  function firePulse() {
    const k = room.fired++;
    let budget = (8 + 2 * f) * countMult(n) * diff.count * (1 + (cfg.budgetPerL ?? 0.08) * L) * (1 + (cfg.perPulse ?? 0.15) * k);
    const surge = L >= 10 && k > 0 && (k + 1) % 4 === 0;
    const pid = pulseId++;
    let bodies = 0;
    if (surge) {
      const kind = ['dart', 'weaver', 'splitling'][Math.floor(rng() * 3)];
      const m = Math.round(budget * 1.5);
      for (let i = 0; i < m; i++) spawnBody(kind, 300 + rng() * 350, pid); bodies += m;
    } else {
      const count = Math.max(1, Math.round(budget));
      const nm = Math.max(1, Math.ceil(count / 6));
      const base = Math.floor(count / nm); let rem = count - base * nm;
      for (let i = 0; i < nm; i++) {
        const share = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
        const kind = pick(rng, kindWeights(f, L, !bhIn()));
        let members = Math.max(1, Math.round(share / DEF[kind].cost));
        let hpScale = 1;
        const dist = 300 + rng() * 350;
        for (let j = 0; j < members; j++) spawnBody(kind, dist + rng() * 60, pid);
        bodies += members;
      }
    }
    // RIFT_PULSE_BODY_CAP 120: fold excess into hp
    if (bodies > 120) { const sc = bodies / 120; let removed = 0; for (let i = E.length - 1; i >= 0 && removed < bodies - 120; i--) if (E[i].pulse === pid) { E.splice(i, 1); removed++; } for (const e of E) if (e.pulse === pid) { e.hp *= sc; e.maxHp *= sc; } pulseAlive.set(pid, 120); bodies = 120; }
    room.lastPulseT = t; room.lastCount = bodies;
  }
  function hallPack() {
    const m0 = (4 + f) * countMult(n) * diff.count;
    const packs = f >= 4 ? 2 : 1;
    const pid = pulseId++;
    for (let p = 0; p < packs; p++) { const kind = pick(rng, kindWeights(f, L, false)); const m = Math.max(1, Math.round(m0 / DEF[kind].cost)); for (let j = 0; j < m; j++) spawnBody(kind, 350 + rng() * 250, pid); }
    if (f >= 4) spawnBody('spinner', 450, pid);
  }
  function dropKit(frac) { kits.push({ frac, at: t + 2, until: t + 20 }); st.kitsDropped++; }
  function killEnemy(e, byPolar) {
    st.kills++; st.xp += e.xp; if (byPolar) st.polarKills++;
    const d = DEF[e.kind];
    const m = 1 + 0.03 * L;
    if (cfg.kits !== false) {
      if (e.elite) { if (rng() < 0.35 * m) dropKit(0.30); }
      else if (d.drop === 'k') { if (rng() < 0.03 * m) dropKit(0.12); }
      else if (d.drop === 'm') { if (rng() < 0.08 * m) dropKit(0.12); }
      else if (d.drop === 'b') { dropKit(rng() < 0.5 ? 0.30 : 0.12); }
      else if (d.drop === 'h') { if (rng() < 0.4 * m) dropKit(0.30); }
      // pity: credited to a random alive pilot
      const alive = pilots.filter((p) => p.alive); if (alive.length) { const p = alive[Math.floor(rng() * alive.length)]; if (p.dmgSinceKit >= 0.7 * p.maxIntegrity) { dropKit(0.12); p.dmgSinceKit = 0; } }
    }
    if (e.kind === 'splitter') { const m2 = e.elite ? 5 : 3; for (let i = 0; i < m2; i++) spawnBody('splitling', e.d, e.pulse); }
  }
  function removeAt(i) { const e = E[i]; E.splice(i, 1); if (e.pulse >= 0) { const c = (pulseAlive.get(e.pulse) ?? 1) - 1; pulseAlive.set(e.pulse, c); if (c <= 0) { pulseAlive.delete(e.pulse); pulsesCleared++; } } }
  st.dmgBy = {};
  function hitPilot(p, amount, kind) {
    if (kind) st.dmgBy[kind] = (st.dmgBy[kind] ?? 0) + amount;
    const before = p.integrity + p.shield;
    const r = damageShip(p, amount, { kind: 'kinetic' });
    st.dmgTaken += r.H; p.hullLost += r.H; p.dmgSinceKit += r.H;
    if (p.integrity <= 0 && p.alive) {
      p.alive = false; st.downs++; livesLost++; livesLeft--; if (st.firstDownT < 0) st.firstDownT = t; p.respawnAt = t + 5; p.polarized = false;
    }
  }
  while (t < maxT) {
    t += DT;
    L = Math.max(threatBase(f, diff.D), 1.5 * (f - 1) + (cfg.minuteRate ?? 0.8) * (t / 60) + (cfg.pulseRate ?? 0.25) * pulsesCleared + diff.D - 0.5 * livesLost);
    // ---- room flow
    if (walkUntil > 0) {
      if (t >= walkUntil && E.length === 0) { walkUntil = -1; room = { k: 0, fired: 0, lastPulseT: -1e9, lastCount: 0, start: t, done: false, nextAt: t + 0.8 }; }
    } else {
      if (room.fired < pulsesPerRoom) {
        const alive = aliveCount();
        const gapOk = t - room.lastPulseT >= Math.max(1.5, 3 - 0.12 * L);
        const due = room.fired === 0 ? t >= room.nextAt : (alive <= 0.3 * room.lastCount || t - room.lastPulseT >= Math.max(7, 14 - 0.6 * L));
        if (due && gapOk) firePulse();
      } else if (E.length === 0) {
        st.rooms++; st.roomTimes.push(t - room.start);
        if (st.rooms === 1) st.hullLostRoom1 = pilots.reduce((a, p) => a + p.hullLost / p.maxIntegrity, 0) / n;
        if (cfg.kits !== false) for (let i = 0; i < Math.ceil(n / 2); i++) dropKit(0.30);
        if (cfg.oneRoom) break;
        if (cfg.stopAfterRooms && st.rooms >= cfg.stopAfterRooms) break;
        walkUntil = t + (cfg.walk ?? 10);
        if (cfg.halls !== false) hallPack();
      }
    }
    // ---- respawns
    for (const p of pilots) if (!p.alive && t >= p.respawnAt && livesLeft > 0 && cfg.respawn !== false) {
      p.alive = true; p.shield = p.maxShield; p.integrity = p.maxIntegrity; p.power = p.maxPower; p.heat = 0; p.jammed = false; p.brownout = false;
    }
    if (cfg.stopOnDown && st.downs > 0) break;
    if (livesLeft <= 0 && pilots.every((p) => !p.alive)) break;
    // ---- enemies sorted by distance
    E.sort((a, b) => a.d - b.d);
    const nearD = E.length ? Math.max(40, E[0].d) : 400;
    const within = (r) => { let c = 0; for (const e of E) { if (e.d <= r) c++; else break; } return c; };
    // ---- pilots act
    let pool = [];
    for (const p of pilots) {
      if (!p.alive) { p.t += DT; continue; }
      const fight = E.length > 0 && E[0].d < 700;
      const inp = { lmb: fight, rmb: fight, thrust: true, still: p.cls.id === 'tech' };
      if (p.cls.id === 'brute' && cfg.polarize !== false) {
        const threat = within(220) >= 3;
        if (threat) p.lastThreatT = t;
        if (!p.polarized && threat && p.power > 0.3 * p.maxPower) p.polarWant = true;
        if (p.polarized && (p.power < 0.12 * p.maxPower || t - p.lastThreatT > 1.5)) p.polarWant = false;
        inp.polarize = p.polarWant;
      }
      if (p.cls.id === 'engineer' && cfg.tender !== false) {
        // Repair Ray: lowest hull-fraction ally < 0.7 (others first); self if < 0.6 and no hostile within 300 px
        let best = null, bf = 1;
        for (const q of pilots) if (q !== p && q.alive) { const fr = q.integrity / q.maxIntegrity; if (fr < 0.7 && fr < bf) { bf = fr; best = q; } }
        if (!best && p.integrity < 0.6 * p.maxIntegrity && within(300) === 0) best = p;
        if (p.rayOn >= 0) { const q = pilots[p.rayOn]; if (!q.alive || q.integrity >= 0.95 * q.maxIntegrity || p.power < 0.15 * p.maxPower) p.rayOn = -1; }
        if (p.rayOn < 0 && best && p.power >= 0.15 * p.maxPower) { p.rayOn = best.idx; p.rayOnSince = t; }
        if (p.rayOn >= 0) { inp.space = true; inp.channel = true; inp.lmb = false; }
      }
      const pk = stepPilot(p, inp, { dist: nearD, disciplined: true, reserveFrac: 0.25, dmgMult: G.dmg, shieldRegenMult: cfg.shieldRegenMult ?? 1 });
      if (p.channeling && p.rayOn >= 0) {
        const q = pilots[p.rayOn];
        let h = q === p ? CLASSES.engineer.mob.self : CLASSES.engineer.mob.ally;
        if (q !== p && t - p.rayOnSince > 3) h *= 0.6;
        const got = healShip(q, h * DT); st.rayHeal += got; q.healRecv += got;
      }
      for (const x of pk) {
        let mult = 1;
        if (x.src === 'rockets') mult = 1.6; else if (x.src === 'arc') mult = (220 + 187 + 159 + 135) / 220; else if (x.src === 'weapon' && x.pierce) mult = 1.5;
        pool.push({ amt: x.amount * eff, aoe: mult });
      }
      if (fight) pool.push({ amt: G.auto * DT * eff, aoe: 2 });
    }
    // ---- apply party damage nearest-first
    for (const pk of pool) {
      let amt = pk.amt * (E.length >= 2 ? pk.aoe : 1);
      let i = 0;
      while (amt > 0 && i < E.length) {
        const e = E[i];
        if (e.d > 900) break;
        const use = Math.min(amt, e.hp); e.hp -= use; amt -= use;
        if (e.hp <= 0.001) { E.splice(i, 1); if (e.pulse >= 0) { const c = (pulseAlive.get(e.pulse) ?? 1) - 1; pulseAlive.set(e.pulse, c); if (c <= 0) { pulseAlive.delete(e.pulse); pulsesCleared++; } } killEnemy(e, false); }
        else i++;
      }
    }
    // Polarize contact dps on non-kamikaze touching a polarized Jugg
    // ---- enemies move + contact
    for (let i = E.length - 1; i >= 0; i--) {
      const e = E[i];
      if (!e.target.alive) { const alive = pilots.filter((p) => p.alive); if (alive.length) e.target = alive[Math.floor(rng() * alive.length)]; else continue; }
      if (e.ranged) {
        if (e.d > 450) e.d -= e.speed * DT;
        const cyc = 3.6 / (1 + 0.05 * L);
        const firing = ((t + i * 0.37) % cyc) < 2;
        if (firing && e.d < 900) {
          const shotsPerTick = (1 / 7);
          const pHit = 0.0127 * n * (cfg.connect ?? 1) * (e.elite ? 2 : 1);
          if (rng() < shotsPerTick * pHit) hitPilot(e.target, 55 * (1 + 0.07 * L) * (e.elite ? 1.5 : 1), 'spinnerShot');
        }
        continue;
      }
      if (e.d > 30) { e.d -= e.speed * DT; continue; }
      const p = e.target;
      const connect = cfg.connect ?? 1;
      if (e.kami) {
        if (!p.polarized && rng() >= connect) { e.d = 120; continue; }
        if (p.polarized) { damageShip(p, e.contact * 0.25, { kind: 'kinetic' }); p.power = Math.max(0, p.power - 10); E.splice(i, 1); if (e.pulse >= 0) { const c = (pulseAlive.get(e.pulse) ?? 1) - 1; pulseAlive.set(e.pulse, c); if (c <= 0) { pulseAlive.delete(e.pulse); pulsesCleared++; } } killEnemy(e, true); }
        else { hitPilot(p, e.contact, e.kind); st.pops++; E.splice(i, 1); if (e.pulse >= 0) { const c = (pulseAlive.get(e.pulse) ?? 1) - 1; pulseAlive.set(e.pulse, c); if (c <= 0) { pulseAlive.delete(e.pulse); pulsesCleared++; } } }
      } else {
        if (p.polarized) { e.hp -= 300 * G.dmg * DT; p.power = Math.max(0, p.power - 10 * DT); if (e.hp <= 0) { E.splice(i, 1); if (e.pulse >= 0) { const c = (pulseAlive.get(e.pulse) ?? 1) - 1; pulseAlive.set(e.pulse, c); if (c <= 0) { pulseAlive.delete(e.pulse); pulsesCleared++; } } killEnemy(e, true); continue; } }
        if (t >= e.nextHit) { if (rng() < connect) hitPilot(p, e.contact, e.kind + (e.elite ? '*' : '')); e.nextHit = t + 1.0; }
      }
    }
    // ---- kits pickup
    for (let i = kits.length - 1; i >= 0; i--) {
      const k = kits[i];
      if (t > k.until) { kits.splice(i, 1); continue; }
      if (t < k.at) continue;
      const alive = pilots.filter((p) => p.alive);
      if (!alive.length) continue;
      let low = alive[0]; for (const p of alive) if (p.integrity / p.maxIntegrity < low.integrity / low.maxIntegrity) low = p;
      const thresh = cfg.kitThresh ?? 0.75;
      if (low.integrity / low.maxIntegrity < thresh) {
        let got = healShip(low, k.frac * low.maxIntegrity); low.kitsPicked++; low.dmgSinceKit = 0;
        for (const p of alive) if (p !== low) got += healShip(p, 0.5 * k.frac * p.maxIntegrity);
        st.kitHull += got; low.hullFromKits += got;
        kits.splice(i, 1);
      }
    }
  }
  st.E = E.map(e => e.kind + (e.elite?"*":"") + ":" + Math.round(e.hp) + "@" + Math.round(e.d)); st.t = t; st.L = L; st.pilots = pilots; st.livesLeft = livesLeft; st.livesLost = livesLost;
  return st;
}

