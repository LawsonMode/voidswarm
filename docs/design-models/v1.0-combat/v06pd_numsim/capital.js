// Capital host power with laser resonance as the live code charges it (per laser 90 × 1.5^(n−1)), spec §5.2 reactor bonuses.
const { fmt, pad } = require('./core');
const DT = 1 / 60;
console.log('=== Spire (Arcanist host) power with n resonating Laser Lance turrets; host also holds its own Laser (150/s) ===');
console.log('  n | host max / regen | per-laser draw | total stack draw | spec text | full → 20% floor | stack duty at the floor | stack dps (full / sustained)');
for (let n = 1; n <= 5; n++) for (const oc of [false, true]) {
  if (oc && n === 5) continue;
  const lasers = n + (oc ? 1 : 0);
  const P = 1300 * (1 + 0.08 * n), R = 320 * (1 + 0.10 * n);
  const f = Math.pow(1.5, lasers - 1), per = 90 * f, total = n * per, own = 150 + 15;
  const net = R - own - total;
  const tFloor = net >= 0 ? Infinity : (0.8 * P) / -net;
  const duty = Math.min(1, Math.max(0, (R - own) / total));
  const dps = n * 260 * f;
  console.log(`  ${n}${oc ? '+OC' : '   '} | ${fmt(P, 0)} / ${fmt(R, 0)}       | ${pad(fmt(per, 0), 5)}          | ${pad(fmt(total, 0), 5)}            | ${oc ? '—' : fmt(per, 0) + ' "total"'}  | ${pad(fmt(tFloor, 1), 5)} s          | ${pad(fmt(duty * 100, 0), 3)}%                    | ${fmt(dps, 0)} / ${fmt(dps * duty, 0)}`);
}
console.log('  Flak turret: 40 host power per 0.45 s burst = 89/s each; Seeker Pod: 45 per 1 s = 45/s each (no resonance).');
