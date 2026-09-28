import { DT, Ship, applyHit, f1 } from './core.mjs';
const REL = { massdriver: 92, laser: 97, phaser: 85 }, ACC = { massdriver: 0.6, laser: 0.8, phaser: 0.55 }, BAND = { massdriver: 200, laser: 700, phaser: 450 };
function sh(c, w) { const s = new Ship(c, w); s._h = true; s._a = 0; s._sec = 0; return s; }
function shoot(s, now, q, T) {
  const d = BAND[s.wid];
  if (s._h && s.heat >= REL[s.wid]) s._h = false; else if (!s._h && s.heat <= 55) s._h = true;
  s.engines(now, DT, true, false); s.reactor(now, DT);
  for (const p of s.fire(now, DT, s._h, 1, d)) { if (s.gun.beam) p.amt *= ACC[s.wid]; else { s._a += ACC[s.wid]; if (s._a < 1) continue; s._a -= 1; } q.push({ at: now + p.delay, ...p }); }
  if (s.cls === 'brute' && now >= s._sec && s.pay(now, 150, 2)) { s._sec = now + 1.4; for (let i = 0; i < 3; i++) q.push({ at: now + 0.3, amt: 180, type: 'blast' }); }
  s.shieldTick(now, DT, 1, false);
}
// BASE Juggernaut stats (no cards) as a Dreadnought with n turrets (shield x(1+0.08n), armor +0.03n), w welders, b brace
for (const [n, w, b] of [[1, 1, 0], [2, 2, 0], [2, 1, 1], [3, 2, 1], [3, 3, 0]]) {
  const out = [];
  for (const att of [[['brute', 'massdriver']], [['brute', 'massdriver'], ['tech', 'laser'], ['engineer', 'phaser']], [['brute', 'massdriver'], ['brute', 'massdriver'], ['tech', 'laser'], ['engineer', 'phaser']]]) {
    const T = new Ship('brute', 'massdriver', { shield: 1 + 0.08 * n, armorAdd: 0.03 * n }); T.brace = b ? 0.5 : 0;
    const A = att.map(([c, x]) => sh(c, x)); const q = []; let now = 0, pt = 0;
    while (now < 120 && T.alive) {
      for (const a of A) shoot(a, now, q, T);
      T.reactor(now, DT);
      pt += DT; if (pt >= 0.1 - 1e-9) { pt = 0; if (T.H < T.Hmax - 1e-6) T.H = Math.min(T.Hmax, T.H + 140 * w * 0.1); else { T.S = Math.min(T.Smax, T.S + 200 * w * 0.1); T.regenAt = Math.min(T.regenAt, now); } }
      T.shieldTick(now, DT, 0, false);
      for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) { applyHit(T, q[i].amt, q[i].type, now); q.splice(i, 1); }
      now += DT;
    }
    out.push(T.alive ? '>120 s' : `${f1(now)} s`);
  }
  console.log(`BASE-stat Dreadnought n=${n}, ${w} welder(s), ${b} brace: vs 1 MD ${out[0]} | vs MD+Laser+Phaser ${out[1]} | vs 2MD+Laser+Phaser (point-blank rockets) ${out[2]}`);
}
