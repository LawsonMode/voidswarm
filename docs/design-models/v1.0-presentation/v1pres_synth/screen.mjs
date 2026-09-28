// SYNTHESIS scratch model: final screen-damage composite (Redline ramp + beat-locked pulse + merging FlashGovernor)
// and the full-bezel crack layout with HUD keep-outs. Not project code.
const smooth = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
const HULL_TIER_BYTES = [217, 179, 128, 77, 38];
const fracByte = (f) => { const q = Math.round(f * 255); return q < 0 ? 0 : q > 255 ? 255 : q; };
const tierOf = (f) => { const b = fracByte(f); let t = 0; for (const B of HULL_TIER_BYTES) if (b < B) t++; return t; };
const S = { redMax: 0.42, cap: 0.6, pulseAmp: [0, 0, 0, 0, 0.06, 0.12], boostMax: 0.06, gap: 0.5, gapReduced: 1.0,
  hitPeak: 0.22, attack: 0.03, tau: 0.12, maxHz: 1.3 };
const redBase = (h) => S.redMax * smooth((0.5 - h) / 0.45);
function pulseHz(tier, bpm) {
  if (tier < 4) return 0;
  if (!(bpm >= 60 && bpm <= 200)) return tier === 4 ? 0.6 : 1.1;
  const hz = tier === 4 ? bpm / 240 : bpm / 120; // T4: one per bar, T5: one per 2 beats
  return Math.min(S.maxHz, hz);
}
class Governor { // merge semantics
  constructor(gap) { this.gap = gap; this.last = -9; this.env = 0; this.target = 0; this.pending = 0; this.holdUntil = -9; }
  request(t, amp) {
    if (amp < 0.03) return false;
    if (t - this.last >= this.gap) { this.last = t; this.target = Math.max(this.env, amp); this.holdUntil = t + this.gap; this.pending = 0; return true; }
    this.pending = Math.max(this.pending, amp); this.holdUntil = this.last + this.gap; return false;
  }
  claim(t) { if (t - this.last >= this.gap) { this.last = t; return true; } return false; } // a pulse crest
  step(t, dt) {
    if (t >= this.last + this.gap && this.pending > this.env + 0.03) { this.last = t; this.target = this.pending; this.pending = 0; this.holdUntil = t + this.gap; }
    if (this.target > this.env) { this.env = Math.min(this.target, this.env + (dt / S.attack) * this.target); if (this.env >= this.target) this.target = 0; }
    else if (t >= this.holdUntil) { this.env *= Math.exp(-dt / S.tau); this.pending = 0; }
    return this.env;
  }
}
class Screen {
  constructor(reduce) { this.reduce = reduce; this.gov = new Governor(reduce ? S.gapReduced : S.gap); this.base = 0; this.boost = 0; this.phase = 0; this.cycleOn = false; }
  step(dt, t, h, hits, bpm, full = []) {
    const tier = tierOf(h), want = redBase(h);
    this.base += (want - this.base) * Math.min(1, dt / (want > this.base ? 0.12 : 0.5));
    const hz = this.reduce ? 0 : pulseHz(tier, bpm);
    for (const amt of hits) {
      if (hz > 0) { this.boost = Math.min(S.boostMax, this.boost + 0.02); this.gov.request(t, 0.5 * Math.min(S.hitPeak, 0.07 + 1.2 * amt)); }
      else this.gov.request(t, Math.min(S.hitPeak, 0.07 + 1.2 * amt) * (tier <= 1 ? 0.6 : 1) * (this.reduce ? 0.5 : 1));
    }
    for (const a of full) this.gov.request(t, this.reduce ? a * 0.5 : a); // Matriarch white, boss tint, matchEnd, shield break
    this.boost *= Math.exp(-dt / 0.8);
    let pulse = 0;
    if (hz > 0) {
      const np = this.phase + hz * dt;
      if (np >= 1 || !this.started) { this.cycleOn = this.gov.claim(t + 0.5 / hz); this.started = true; } // the crest lands mid-cycle
      this.phase = np % 1;
      if (this.cycleOn) pulse = (S.pulseAmp[tier] + this.boost) * (0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase));
    } else { this.phase = 0; this.started = false; }
    return Math.min(S.cap, this.base + pulse + this.gov.step(t, dt));
  }
}
function peaks(series, dt, minDelta = 0.02) {
  const pk = []; let lo = series[0], hi = series[0], rising = true, hiT = 0;
  for (let i = 1; i < series.length; i++) {
    const v = series[i];
    if (rising) { if (v > hi) { hi = v; hiT = i * dt; } else if (hi - v >= minDelta && hi - lo >= minDelta) { pk.push(hiT); rising = false; lo = v; } else if (v < lo) { lo = v; hi = v; } }
    else { if (v < lo) lo = v; else if (v - lo >= minDelta) { rising = true; hi = v; hiT = i * dt; } }
  }
  let best = 0; for (let i = 0; i < pk.length; i++) { let n = 0; for (let j = i; j < pk.length && pk[j] - pk[i] < 1; j++) n++; best = Math.max(best, n); }
  return best;
}
let seed = 99; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const dt = 1 / 240; // 240 Hz audit
const scen = {
  'sweep 1→0.02, 60 hits/s @1%': (t) => ({ h: Math.max(0.02, 1 - t / 10), hits: rnd() < 60 * dt ? [0.01] : [] }),
  'hull 60%, big hit every 0.25 s @10%': (t) => ({ h: 0.6, hits: Math.abs((t % 0.25)) < dt / 2 ? [0.1] : [] }),
  'hull 40%, mass driver 15/s @2% + shield break 1/s': (t) => ({ h: 0.4, hits: rnd() < 15 * dt ? [0.02] : [], full: Math.abs(t % 1) < dt / 2 ? [0.18] : [] }),
  'hull 5%, 60 hits/s + bpm sweep 60..200': (t) => ({ h: 0.05, hits: rnd() < 60 * dt ? [0.02] : [], bpm: 60 + 7 * t }),
  'hull 20%, boss tint + Matriarch white + hits': (t) => ({ h: 0.2, hits: rnd() < 20 * dt ? [0.05] : [], full: rnd() < 1.5 * dt ? [0.22] : [], bpm: 150 }),
  'hull 25%, bpm 136 no hits': () => ({ h: 0.25, hits: [], bpm: 136 }),
  'hull 10%, bpm 150 no hits': () => ({ h: 0.1, hits: [], bpm: 150 }),
};
for (const reduce of [false, true]) {
  console.log(reduce ? '\nREDUCE FLASHING' : 'DEFAULT');
  for (const [name, fn] of Object.entries(scen)) {
    const s = new Screen(reduce), out = [];
    for (let i = 0; i < 240 * 20; i++) { const t = i * dt; const f = fn(t); out.push(s.step(dt, t, f.h, f.hits, f.bpm ?? 136, f.full ?? [])); }
    console.log(`  ${name.padEnd(52)} max ${Math.max(...out).toFixed(3)}  peaks/1s ${peaks(out, dt)}`);
  }
}
for (const h of [1, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05, 0]) process.stdout.write(`h${h}:${redBase(h).toFixed(3)} `);
console.log();
for (const bpm of [136, 140, 150, 122]) console.log('bpm', bpm, 'T4 Hz', pulseHz(4, bpm).toFixed(3), 'T5 Hz', pulseHz(5, bpm).toFixed(3));

// ---- crack layout along the whole bezel ----
const inter = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const pad = (r, p) => ({ x0: r.x0 - p, y0: r.y0 - p, x1: r.x1 + p, y1: r.y1 + p });
function keepOuts(sw, sh, mobile, rift) {
  const rs = Math.round(Math.max(140, Math.min(240, Math.min(sw, sh) * 0.22)));
  const k = [
    { n: 'topL', x0: 0, y0: 0, x1: Math.min(420, sw * 0.3), y1: mobile ? 44 : 56 },
    { n: 'topMid', x0: sw / 2 - 130, y0: 0, x1: sw / 2 + 130, y1: mobile ? 56 : 72 },
    { n: 'topR', x0: sw - Math.min(300, sw * 0.24), y0: 0, x1: sw, y1: mobile ? 44 : 56 },
    { n: 'killfeed', x0: sw - Math.min(360, sw * 0.3), y0: 56, x1: sw, y1: 56 + (process.env.QUIET ? 2 : 5) * (mobile ? 18 : 24) },
    ...(process.env.QUIET ? [] : [{ n: 'chat', x0: 0, y0: sh - (mobile ? 120 : 240), x1: Math.min(480, sw * 0.34), y1: sh }]),
    { n: 'bottom', x0: sw / 2 - Math.min(380, sw * 0.3), y0: sh - (mobile ? 96 : 160), x1: sw / 2 + Math.min(380, sw * 0.3), y1: sh },
    { n: 'radar', x0: sw - rs - 22, y0: sh - rs - 22, x1: sw, y1: sh },
  ];
  if (rift) k.push({ n: 'rift', x0: 0, y0: 56, x1: 320, y1: 124 });
  if (mobile && process.env.TOUCH) k.push({ n: 'stickL', x0: 0, y0: sh - 200, x1: 220, y1: sh }, { n: 'btnsR', x0: sw - 260, y0: sh - 240, x1: sw, y1: sh });
  return k;
}
function layout(sw, sh, keep, n, lenFrac, mobile, seed0) {
  let s = seed0; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const safe = { x0: sw * 0.2, x1: sw * 0.8, y0: sh * 0.22, y1: sh * 0.78 };
  const P = keep.map((k) => pad(k, 12));
  const L0 = lenFrac * Math.min(sw, sh);
  const per = 2 * (sw + sh), cands = [];
  for (let i = 0; i < 32; i++) {
    const u = ((i + r()) / 32) * per; let x, y, a; // clockwise from top-left
    if (u < sw) { x = u; y = 0; a = 90; } else if (u < sw + sh) { x = sw; y = u - sw; a = 180; }
    else if (u < 2 * sw + sh) { x = sw - (u - sw - sh); y = sh; a = 270; } else { x = 0; y = sh - (u - 2 * sw - sh); a = 0; }
    if (P.some((k) => x >= k.x0 && x <= k.x1 && y >= k.y0 && y <= k.y1)) continue;
    const a0 = a + (r() * 2 - 1) * 18; let ok = false;
    for (const off of [0, 40, -40, 60, -60]) { // tilt toward the bezel when the inward heading does not fit
    if (ok) break; a = a0 + off; const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180);
    let L = L0;
    for (; L >= 0.5 * L0; L -= 4) { // shorten until the bbox is clear
      const tx = x + ca * L, ty = y + sa * L, w = 0.3 * L;
      const bb = { x0: Math.min(x, tx) - w * Math.abs(sa), x1: Math.max(x, tx) + w * Math.abs(sa), y0: Math.min(y, ty) - w * Math.abs(ca), y1: Math.max(y, ty) + w * Math.abs(ca) };
      const bbIn = { x0: Math.max(0, bb.x0), y0: Math.max(0, bb.y0), x1: Math.min(sw, bb.x1), y1: Math.min(sh, bb.y1) };
      if (!inter(bbIn, pad(safe, 8)) && !P.some((k) => inter(bbIn, k))) { ok = true; cands.push({ x, y, a, L, off, bb: bbIn }); break; }
    }
    }
  }
  return cands;
}
for (const [sw, sh, mobile] of [[1920, 1080, false], [1280, 720, false], [2560, 1080, false], [3440, 1440, false], [1024, 768, false], [844, 390, true], [667, 375, true]]) {
  for (const rift of [false, true]) {
    const keep = keepOuts(sw, sh, mobile, rift), c = layout(sw, sh, keep, 6, 0.24, mobile, 7);
    const edges = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const k of c) edges[k.y === 0 ? 'top' : k.x === sw ? 'right' : k.y === sh ? 'bottom' : 'left']++;
    const safe = { x0: sw * 0.2, x1: sw * 0.8, y0: sh * 0.22, y1: sh * 0.78 };
    const viol = c.filter((k) => inter(k.bb, safe) || keep.some((q) => inter(k.bb, q))).length;
    console.log(`${sw}x${sh}${rift ? ' rift' : ''}${mobile ? ' mobile' : ''}: usable anchors ${c.length} (T ${edges.top} R ${edges.right} B ${edges.bottom} L ${edges.left}), shortest ${Math.round(Math.min(...c.map((k) => k.L)))} px, tilted ${c.filter((k)=>k.off).length} of ${Math.round(0.24 * Math.min(sw, sh))}, violations ${viol}`);
  }
}
