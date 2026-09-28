// Scratch model of the v1.0 adaptive-music input model (heat, density, drive, tier gate, danger stage).
// Pure JS mirror of the proposed musicMapping reducers; used to pick and sanity-check the constants.
const K = {
  heat: { tau: 16, hold: 0, cap: 3, enemy: 0.04, elite: 0.12, brute: 0.08, ship: 0.5, levelUp: 0.3, deathKeep: 0.5 },
  dens: { W0: 24, hostileShip: 6, friendlyShip: 0.5, projEach: 0.2, projMax: 10 },
  drive: { wS: 0.4, wH: 0.45, wP: 0.35, levelFull: 15, combat: 0.12 },
  tier: { up: [0, 0.12, 0.28, 0.45, 0.62, 0.8], hyst: 0.08, tauUp: 0.5, tauDown: 4, dwellUp: 1.5, dwellDown: 8, holdDown: 3 },
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function heatStep(h, dt, add) {
  let { raw, sinceEvent } = h;
  if (add > 0) { raw = Math.min(K.heat.cap, raw + add); sinceEvent = 0; } else sinceEvent += dt;
  if (sinceEvent >= K.heat.hold) raw *= Math.exp(-dt / K.heat.tau);
  return { raw, sinceEvent, H: 1 - Math.exp(-raw) };
}
const density = (w) => 1 - Math.exp(-w / K.dens.W0);
function driveFor(S, H, level, extra) {
  const P = clamp01((level - 1) / (K.drive.levelFull - 1));
  return clamp01((K.drive.wS * S + K.drive.wH * H) * (1 + K.drive.wP * P) + extra);
}
function tierStep(s, drive, dt, floorTier = 0) {
  const T = K.tier;
  const tau = drive > s.ds ? T.tauUp : T.tauDown;
  const ds = s.ds + (drive - s.ds) * (1 - Math.exp(-dt / tau));
  let since = s.since + dt;
  let tier = s.tier;
  let below = ds < T.up[tier] - T.hyst ? (s.below ?? 0) + dt : 0;
  let up = tier;
  while (up < 5 && ds >= T.up[up + 1]) up++;
  up = Math.max(up, floorTier);
  if (up > tier && since >= T.dwellUp) { tier = up; since = 0; below = 0; }
  else if (tier > floorTier && below >= T.holdDown && since >= T.dwellDown) { tier--; since = 0; below = 0; }
  return { ds, tier, since, below };
}
const hullTier = (f) => (f < 0.15 ? 5 : f < 0.3 ? 4 : f < 0.5 ? 3 : f < 0.7 ? 2 : f < 0.85 ? 1 : 0);
const EXIT = [0, 0.5, 0.3, 0.15];
function dangerStep(d, hullFrac, dt) {
  const target = Math.max(0, hullTier(hullFrac) - 2);
  if (target > d.stage) return { stage: target, lower: 0 };
  if (target < d.stage) {
    const lower = d.lower + dt;
    if (lower >= 1.5 && hullFrac >= EXIT[d.stage] + 0.03) return { stage: d.stage - 1 >= target ? d.stage - 1 : target, lower: 0 };
    return { stage: d.stage, lower };
  }
  return { stage: d.stage, lower: 0 };
}

// deterministic noise
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

function run(name, secs, fn) {
  const dt = 1 / 60;
  let h = { raw: 0, sinceEvent: 99, H: 0 };
  let t = { ds: 0, tier: 0, since: 99 };
  let changes = 0, prev = 0;
  const firstAt = [0, -1, -1, -1, -1, -1];
  const timeIn = [0, 0, 0, 0, 0, 0];
  const log = [];
  for (let i = 0; i < secs * 60; i++) {
    const time = i * dt;
    const f = fn(time, dt);
    h = heatStep(h, dt, f.add ?? 0);
    const S = density(f.w);
    const D = driveFor(S, h.H, f.level ?? 1, f.extra ?? 0);
    t = tierStep(t, D, dt, f.floor ?? 0);
    if (t.tier !== prev) { changes++; prev = t.tier; if (firstAt[t.tier] < 0) firstAt[t.tier] = +time.toFixed(2); log.push(`${time.toFixed(1)}s→T${t.tier}`); }
    timeIn[t.tier] += dt;
  }
  console.log(`\n[${name}] ${secs}s  tier changes=${changes} (${(changes / (secs / 60)).toFixed(1)}/min)  final T${t.tier} H=${h.H.toFixed(2)}`);
  console.log('  first reached:', firstAt.map((v, k) => `T${k}:${v}`).join(' '));
  console.log('  share:', timeIn.map((v, k) => `T${k} ${((100 * v) / secs).toFixed(0)}%`).join(' '));
  console.log('  log:', log.slice(0, 30).join(' '));
}

// Poisson-ish takedown events at `rate` per second
const takedowns = (rate, dt, w) => (rnd() < rate * dt ? w : 0);

// A: early Warzone: 4-10 drones on screen, no takedowns, level 1 → should sit at T0/T1
run('A early, no takedowns', 120, (time, dt) => ({ w: 4 + 6 * rnd(), level: 1 }));
// B: steady swarm clearing, 1 takedown/s, ~20 enemies (±30% flicker), level 5
run('B steady clearing', 180, (time, dt) => ({ w: 20 * (0.7 + 0.6 * rnd()), level: 5, add: takedowns(1, dt, K.heat.enemy), extra: 0.12 * (rnd() < 0.7 ? 1 : 0) }));
// C: frantic: 2.5 takedowns/s, 45 entities, level 12, under fire
run('C frantic peak', 120, (time, dt) => ({ w: 45 * (0.7 + 0.6 * rnd()), level: 12, add: takedowns(2.5, dt, K.heat.enemy), extra: 0.12 }));
// D: PvP duel: 1 hostile ship + 6 bullets; a ship takedown at 25 s and 30 s and 80 s; under fire 50% of the time
run('D PvP duel', 120, (time, dt) => {
  const add = [25, 30, 80].some((s) => Math.abs(time - s) < dt / 2) ? K.heat.ship : 0;
  return { w: 6 + 6 * 0.2, level: 3, add, extra: time % 10 < 5 ? 0.12 : 0 };
});
// E: peak for 60 s, then all action stops (empty screen) → how long to wind down to T0?
run('E peak then calm', 150, (time, dt) => (time < 60
  ? { w: 45, level: 10, add: takedowns(2.5, dt, K.heat.enemy), extra: 0.12 }
  : { w: 0, level: 10 }));
// F: boundary noise: drive hovering at a tier edge (density flicker ±40% around the T2/T3 edge)
run('F edge flicker', 300, (time, dt) => ({ w: 50 * (0.6 + 0.8 * rnd()), level: 1, extra: 0.1 }));
// G: 8-player Arena DM: 0-4 hostiles on screen changing every ~3 s, ship takedown every ~20 s
let hostiles = 1;
run('G arena DM', 300, (time, dt) => {
  if (rnd() < dt / 3) hostiles = Math.floor(rnd() * 5);
  return { w: hostiles * 6 + hostiles * 4 * 0.2, level: 1 + time / 30, add: takedowns(1 / 20, dt, K.heat.ship), extra: hostiles > 0 && rnd() < 0.5 ? 0.12 : 0 };
});

// Danger: hull wobbling around 30% under a repair beam while taking fire → stage must not flap
{
  let d = { stage: 0, lower: 0 }, flips = 0, prev = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 60; i++) {
    const time = i * dt;
    const hull = time < 10 ? 1 - time * 0.072 : 0.3 + 0.025 * Math.sin(time * 3.1) + 0.01 * (rnd() - 0.5);
    d = dangerStep(d, hull, dt);
    if (d.stage !== prev) { flips++; prev = d.stage; }
  }
  console.log(`\n[danger wobble at 30% hull ±2.5%] 60 s: stage changes=${flips}, final stage=${d.stage}`);
  // repair from 12% to 60% over 4 s
  d = { stage: 3, lower: 0 };
  const seq = [];
  for (let i = 0; i < 60 * 8; i++) {
    const time = i * dt;
    const hull = Math.min(0.6, 0.12 + (0.48 * time) / 4);
    const nd = dangerStep(d, hull, dt);
    if (nd.stage !== d.stage) seq.push(`${time.toFixed(2)}s stage${nd.stage} (hull ${(hull * 100).toFixed(0)}%)`);
    d = nd;
  }
  console.log('[repair 12%→60% over 4 s]', seq.join(', '));
}

// H: realistic 8-player DM: hostiles on screen random-walk ±1 every ~4 s (0..4), takedown every ~25 s
let hh = 1;
run('H arena DM realistic', 300, (time, dt) => {
  if (rnd() < dt / 4) hh = Math.max(0, Math.min(4, hh + (rnd() < 0.5 ? -1 : 1)));
  return { w: hh * 6 + hh * 4 * 0.2, level: 1 + time / 30, add: takedowns(1 / 25, dt, K.heat.ship), extra: hh > 0 ? 0.12 : 0 };
});

// I: Arena DM streak: 2 hostiles on screen, takedowns at 20, 28, 35, 44 s (streak 1..4), own death at 90 s
{
  let streak = 0;
  run('I arena streak', 150, (time, dt) => {
    const at = (s) => Math.abs(time - s) < dt / 2;
    let add = 0;
    if ([20, 28, 35, 44].some(at)) { add = K.heat.ship; streak++; }
    if (at(90)) streak = 0;
    const w = time < 90 ? 2 * 6 + 8 * 0.2 : 0;
    return { w, level: 4, add, extra: (time < 90 ? 0.12 : 0) + Math.min(0.24, 0.06 * streak) };
  });
}
// tier gate exact timings for the test spec
{
  const dt = 1 / 60; let t = { ds: 0, tier: 0, since: 99 }; const ch = [];
  for (let i = 1; i <= 60 * 5; i++) { const n = tierStep(t, 0.5, dt); if (n.tier !== t.tier) ch.push(`${(i * dt).toFixed(3)}s→T${n.tier}`); t = n; }
  for (let i = 1; i <= 60 * 30; i++) { const n = tierStep(t, 0, dt); if (n.tier !== t.tier) ch.push(`+${(i * dt).toFixed(3)}s→T${n.tier}`); t = n; }
  console.log('\n[gate D=0.5 for 5 s, then D=0 for 30 s]', ch.join(' '));
  // flap: alternate 0.40 / 0.50 every 0.2 s for 120 s
  t = { ds: 0, tier: 0, since: 99 }; let late = 0, total = 0, prev = 0;
  for (let i = 1; i <= 60 * 120; i++) { const D = Math.floor(i / 12) % 2 ? 0.5 : 0.4; t = tierStep(t, D, dt); if (t.tier !== prev) { total++; if (i * dt > 10) late++; prev = t.tier; } }
  console.log('[flap 0.40/0.50 @0.2 s] changes total', total, 'after 10 s', late, 'tier', t.tier);
}
