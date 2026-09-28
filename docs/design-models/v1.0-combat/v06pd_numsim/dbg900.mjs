import { Ship, DT, STRAIN_DRAW } from './core.mjs';
// Jugg holding LMB (MD out of range at 900) + RMB: how many rockets actually launch in 30 s?
for (const lmb of [true, false]) {
  const s = new Ship('brute'); let secAt = 0, rockets = 0, now = 0, minP = 1e9;
  for (; now < 30; now += DT) {
    const strain = (lmb ? 1 : 0) + 1;
    s.engines(now, DT, true, false); s.reactor(now, DT);
    s.fire(now, DT, lmb, strain, 900);
    if (now >= secAt && s.pay(now, 150, strain)) { secAt = now + 1.4; rockets++; }
    s.shieldTick(now, DT, strain, false);
    minP = Math.min(minP, s.P);
  }
  console.log(`LMB ${lmb}: rockets fired ${rockets} in 30 s (max ${Math.floor(30/1.4)+1}), min P ${minP.toFixed(0)}, P end ${s.P.toFixed(0)}, jam ${s.jam}, heat ${s.heat.toFixed(0)}, own S ${s.S.toFixed(0)}`);
}
