// Scratch prototype of the pure presentation math (NOT project code).
const HULL_TIER_BYTES = [217, 179, 128, 77, 38];
const qFrac = (f) => { const q = Math.round(f * 255); return q < 0 ? 0 : q > 255 ? 255 : q; };
const tierOfByte = (b) => { let t = 0; for (const B of HULL_TIER_BYTES) if (b < B) t++; return t; };
const hullDamageTier = (f) => tierOfByte(qFrac(f));
// round-trip check
let bad = 0;
for (let b = 0; b <= 255; b++) if (hullDamageTier(b / 255) !== tierOfByte(b)) bad++;
for (let i = 0; i <= 100000; i++) { const f = i / 100000; if (hullDamageTier(qFrac(f) / 255) !== hullDamageTier(f)) bad++; }
console.log('roundtrip mismatches', bad);

const smooth = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
const K = { redStart: 0.5, redFull: 0.05, redMax: 0.42, cap: 0.6,
  pulse: [null, null, null, null, { hz: 0.7, amp: 0.06 }, { hz: 1.1, amp: 0.12 }],
  hitGap: 0.5, hitGapReduced: 1.0, hitPeak: 0.22, hitTau: 0.12 };
const redBase = (h) => K.redMax * smooth((K.redStart - h) / (K.redStart - K.redFull));
for (const h of [1, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05, 0]) console.log('h', h, 'tier', hullDamageTier(h), 'redBase', redBase(h).toFixed(3));

class Screen {
  constructor(reduce) { this.reduce = reduce; this.hitA = 0; this.lastOnset = -9; this.boost = 0; this.base = 0; }
  step(dt, t, h, hits) {
    const tier = hullDamageTier(h);
    const want = redBase(h);
    const tau = want > this.base ? 0.12 : 0.5;
    this.base += (want - this.base) * Math.min(1, dt / tau);
    const p = this.reduce ? null : K.pulse[tier];
    for (const amt of hits) {
      if (p) { this.boost = Math.min(0.06, this.boost + 0.02); continue; }
      const gap = this.reduce ? K.hitGapReduced : K.hitGap;
      if (t - this.lastOnset >= gap) { this.lastOnset = t; this.hitA = Math.max(this.hitA, Math.min(K.hitPeak, 0.07 + 1.2 * amt) * (this.reduce ? 0.5 : 1)); }
    }
    this.hitA *= Math.exp(-dt / K.hitTau);
    this.boost *= Math.exp(-dt / 0.8);
    const pulse = p ? (p.amp + this.boost) * (0.5 - 0.5 * Math.cos(2 * Math.PI * p.hz * t)) : 0;
    return Math.min(K.cap, this.base + pulse + this.hitA);
  }
}
// worst case: hit every frame (60/s), hull sweeping down 1 -> 0.02 over 10 s, then hold
function flashes(series, dt, minDelta) { // count rise-then-fall peaks with amplitude >= minDelta; return max per 1 s window
  const peaks = []; let lo = series[0], hi = series[0], rising = true, hiT = 0;
  for (let i = 1; i < series.length; i++) {
    const v = series[i];
    if (rising) { if (v > hi) { hi = v; hiT = i * dt; } else if (hi - v >= minDelta && hi - lo >= minDelta) { peaks.push(hiT); rising = false; lo = v; } else if (v < lo) { lo = v; hi = v; } }
    else { if (v < lo) lo = v; else if (v - lo >= minDelta) { rising = true; hi = v; hiT = i * dt; } }
  }
  let best = 0; for (let i = 0; i < peaks.length; i++) { let n = 0; for (let j = i; j < peaks.length && peaks[j] - peaks[i] < 1; j++) n++; best = Math.max(best, n); }
  return { peaks: peaks.length, maxPerSec: best };
}
for (const reduce of [false, true]) {
  const s = new Screen(reduce), dt = 1 / 60, out = [];
  for (let i = 0; i < 60 * 20; i++) { const t = i * dt; const h = Math.max(0.02, 1 - t / 10); out.push(s.step(dt, t, h, [0.01])); }
  console.log('reduce', reduce, 'max', Math.max(...out).toFixed(3), flashes(out, dt, 0.02));
  // hits only at hull 0.6 (no pulse), 60/s
  const s2 = new Screen(reduce), o2 = [];
  for (let i = 0; i < 600; i++) o2.push(s2.step(dt, i * dt, 0.6, [0.02]));
  console.log('  hits@60%', flashes(o2, dt, 0.02));
  const s3 = new Screen(reduce), o3 = [];
  for (let i = 0; i < 600; i++) o3.push(s3.step(dt, i * dt, 0.1, [0.02]));
  console.log('  hits@10%', flashes(o3, dt, 0.02), 'max', Math.max(...o3).toFixed(3));
}

// crack layout
function crackLayout(sw, sh, ins, radar, count, lenFrac, mobile) {
  const safe = { x0: sw * 0.2, x1: sw * 0.8, y0: sh * 0.22, y1: sh * 0.78 };
  const bandTop = ins.top + 8;
  const botL = sh - Math.max(ins.bottomLeft, 0.12 * sh) - 8;
  const botR = Math.min(sh - 0.12 * sh, radar.y) - 8;
  const lerp = (a, b, t) => a + (b - a) * t;
  const slots = [
    [0, lerp(bandTop, botL, 0.30), 0], [sw, lerp(bandTop, botR, 0.55), 180],
    [0, lerp(bandTop, botL, 0.75), -10], [sw, lerp(bandTop, botR, 0.20), 170],
    [0, lerp(bandTop, botL, 0.16), 24], [sw, lerp(bandTop, botR, 0.88), 196],
  ].slice(0, Math.min(count, mobile ? 4 : 6));
  const L0 = lenFrac * Math.min(sw, sh);
  return slots.map(([x, y, deg]) => {
    const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    // clamp so the tip stays >= 8 px outside the safe rect (x-extent governs side cracks)
    let L = L0;
    const edgeX = ca > 0 ? safe.x0 - 8 - x : x - (safe.x1 + 8);
    if (Math.abs(ca) > 1e-6) L = Math.min(L, edgeX / Math.abs(ca));
    const tipX = x + ca * L, tipY = y + sa * L, w = 0.3 * L;
    const bb = { x0: Math.min(x, tipX) - w * Math.abs(sa), x1: Math.max(x, tipX) + w * Math.abs(sa), y0: Math.min(y, tipY) - w * Math.abs(ca), y1: Math.max(y, tipY) + w * Math.abs(ca) };
    return { x, y, deg, L, bb };
  });
}
const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
for (const [sw, sh, top, bottom, bottomLeft, mobile] of [[1920, 1080, 56, 150, 240, false], [1280, 720, 52, 140, 230, false], [2560, 1080, 56, 150, 240, false], [844, 390, 44, 96, 120, true], [1024, 768, 52, 150, 230, false]]) {
  const rs = Math.round(Math.max(140, Math.min(240, Math.min(sw, sh) * 0.22)));
  const radar = { x0: sw - rs - 22, x1: sw, y0: sh - rs - 22, y1: sh, y: sh - rs - 22 };
  const safe = { x0: sw * 0.2, x1: sw * 0.8, y0: sh * 0.22, y1: sh * 0.78 };
  const chat = { x0: 0, x1: Math.min(480, sw * 0.34), y0: sh - bottomLeft, y1: sh };
  const topStrip = { x0: 0, x1: sw, y0: 0, y1: top };
  const cr = crackLayout(sw, sh, { top, bottomLeft }, radar, 6, 0.24, mobile);
  const viol = cr.filter((c) => hit(c.bb, safe) || hit(c.bb, radar) || hit(c.bb, chat) || hit(c.bb, topStrip));
  console.log(sw + 'x' + sh, 'cracks', cr.length, 'L', cr.map((c) => Math.round(c.L)).join(','), 'violations', viol.length, viol.map(v=>v.deg).join(','));
}
