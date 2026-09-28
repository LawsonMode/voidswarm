// per-tier ambient rates (per s, LOD0, density 1) + event bursts; lifetimes in s
const LIFE = { spark: 0.28, smoke: 1.2, vapor: 0.8, debris: 1.3, ember: 0.7, tspark: 0.25, puff: 0.5, gspark: 0.10, nspark: 0.25 };
const T = [
  null,
  { spark: 0, vapor: 0, smoke: 0, debris: 0, ember: 0, cut: 0, tsp: 0, gun: 0, gsp: 0, nsp: 0 },
  { spark: 2, vapor: 1.5, smoke: 0, debris: 0, ember: 0, cut: 0, tsp: 0, gun: 0, gsp: 0, nsp: 0 },
  { spark: 4, vapor: 0, smoke: 3, debris: 0.4, ember: 0, cut: 1 / 2.2, tsp: 3, gun: 0.15, gsp: 2, nsp: 0 },
  { spark: 6, vapor: 0, smoke: 5, debris: 0.8, ember: 0, cut: 1 / 1.4, tsp: 4, gun: 0.35, gsp: 3, nsp: 1 },
  { spark: 9, vapor: 0, smoke: 6, debris: 1.2, ember: 3, cut: 1 / 0.8, tsp: 5, gun: 0.6, gsp: 4, nsp: 2 },
];
const GUN_BURSTS_MAX = 1 / 0.15; // at most one gun-short burst per 0.15 s per ship
const FIRE_RATE = 6.7; // primary fire events / s (worst: autocannon / mass driver)
function alive(tier, lod) {
  const r = T[tier]; if (!r) return { add: 0, smoke: 0 };
  const m = [1, 0.5, 0.2][lod];
  const gun = lod === 2 ? 0 : Math.min(GUN_BURSTS_MAX, FIRE_RATE * r.gun) * r.gsp * LIFE.gspark;
  const add = m * (r.spark * LIFE.spark + (lod === 2 ? 0 : r.debris * LIFE.debris) + r.ember * LIFE.ember + (lod === 2 ? 0 : r.cut * r.tsp * LIFE.tspark) + (lod === 0 ? r.nsp * 3 * LIFE.nspark / 3 : 0)) + m * gun;
  let smoke = m * (r.smoke * LIFE.smoke + r.vapor * LIFE.vapor + r.cut * LIFE.puff);
  if (lod === 2 && tier >= 4) smoke = Math.max(smoke, 1.2 * LIFE.smoke);
  return { add: +add.toFixed(2), smoke: +smoke.toFixed(2) };
}
for (let t = 1; t <= 5; t++) console.log('T' + t, 'LOD0', alive(t, 0), 'LOD1', alive(t, 1), 'LOD2', alive(t, 2));
function worst(n, l0, l1, mobileMult) {
  let add = 0, smoke = 0;
  for (let i = 0; i < n; i++) { const lod = i < l0 ? 0 : i < l0 + l1 ? 1 : 2; const a = alive(5, lod); add += a.add * mobileMult; smoke += a.smoke * mobileMult; }
  return { add: Math.round(add), smoke: Math.round(smoke) };
}
console.log('desktop q2 32xT5', worst(32, 6, 10, 1));
console.log('desktop q1 32xT5', worst(32, 4, 8, 0.65));
console.log('desktop q0 32xT5', worst(32, 2, 4, 0.35));
console.log('mobile 12xT5', worst(12, 3, 5, 0.5));
console.log('mobile 32xT5', worst(32, 3, 5, 0.5));
