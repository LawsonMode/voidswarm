// SYNTHESIS scratch model v2 (not project code). Run: node mobile2.mjs
// 1) today's v0.5 CSS on a notched phone (vw-based widths inside the safe-area-inset #ui) vs the proposed v1.0 rules
// 2) the v1.0 bottom block (skill bar LMB RMB Q E Space + five-system panel + Q ring) fit, desktop and phone
// 3) phone zoom -> on-screen hull radius -> decal mark caps
// 4) chord-aware pickup chime ladder (every pitch in scale or chord; never a semitone against a sounding chord tone)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inter = (a, b) => a.x0 < b.x1 - 0.01 && a.x1 > b.x0 + 0.01 && a.y0 < b.y1 - 0.01 && a.y1 > b.y0 + 0.01;
const R = (v) => Math.round(v);

function layout(vw, vh, safe, mobile, rules) {
  const rem = clamp(0.55 * vw / 100 + 0.6 * vh / 100 + 3, 13, 30);
  const uw = vw - safe.l - safe.r, uh = vh - safe.t - safe.b;          // #game / #ui box (styles.css:52)
  const g = 0.8 * rem;
  const rs = R(clamp(Math.min(uw, uh) * 0.22, 140, 240));              // GameRenderer.layoutHud
  const radar = { n: 'radar', x0: uw - rs - 22, y0: uh - rs - 22, x1: uw - 10, y1: uh - 10 };
  let bw, chatW;
  if (rules === 'v05') {                                                // today: vw = the VIEWPORT, not #ui
    bw = Math.min(40 * rem, 0.5 * vw);
    chatW = Math.min(30 * rem, 0.34 * vw, 0.5 * vw - Math.min(20 * rem, 0.25 * vw) - 1.6 * rem);
  } else if (!mobile) {                                                 // v1.0 desktop: the same rules in % of #ui
    bw = Math.min(40 * rem, 0.5 * uw);
    chatW = Math.min(30 * rem, 0.34 * uw, 0.5 * uw - bw / 2 - 2 * g);
  } else {                                                              // v1.0 phones: between the chat column and the radar
    bw = Math.min(40 * rem, 0.52 * uw, uw - 2 * (rs + 34));
    chatW = 0.5 * uw - bw / 2 - 2 * g;
  }
  // v1.0 bottom block
  const slot = 3.6 * rem, qSlot = 5 * rem, gap = 0.4 * rem, qFace = 3.75 * rem, face = 3 * rem;
  const barW = 4 * slot + qSlot + 4 * gap;
  const names = !mobile, reservedUlt = !mobile;
  const skillsH = qFace + (names ? 0.7 * rem : 0);
  const xpRow = mobile ? 0.8 * rem : 0.9 * rem, sysRow = 1.6 * rem, pad = 0.9 * rem, rowGap = mobile ? 0.3 * rem : 0.35 * rem;
  const hullRow = 0.55 * rem, hullGap = 0.2 * rem;                   // the local HULL strip (tier colour, notches 50/30/15)
  const panelH = xpRow + rowGap + hullRow + hullGap + sysRow + pad;
  const blockH = (reservedUlt ? 1.1 * rem : 0) + skillsH + (mobile ? 0.4 : 0.5) * rem + panelH;
  const bottom = { n: 'bottom', x0: (uw - bw) / 2, y0: uh - g - blockH, x1: (uw + bw) / 2, y1: uh - g };
  const chat = { n: 'chat', x0: g, y0: uh - g - 14 * rem, x1: g + chatW, y1: uh - g };
  const ultLabelPx = Math.max(0.62 * rem, mobile ? 11 : 0), ultLabelW = 14 * 0.72 * ultLabelPx; // "ULTIMATE READY"
  const ultTop = mobile ? bottom.y0 - ultLabelPx * 1.3 - 2 : bottom.y0;  // phones: absolute label over the Q slot
  // five-system panel: POWER bar | 4 mini gauges (WPN SPC SHD THR) | REACTOR chip (desktop) / reactor text in the bar (phone)
  const labelPx = Math.max(0.5 * rem, mobile ? 10 : 0);
  const gaugeW = Math.max(1.5 * rem, 3 * 0.72 * labelPx + 4);         // a 3-letter label must fit inside
  const gauges = 4 * gaugeW + 3 * 0.25 * rem;
  const chipW = mobile ? 0 : 7.5 * rem;
  const powerW = bw - 2 * 0.6 * rem - gauges - 0.5 * rem - (chipW ? chipW + 0.5 * rem : 0);
  const reactorTextW = mobile ? 9 * 0.62 * labelPx : 0;                // "-18%/-24%" inside the bar's right end on phones
  const glyphPx = Math.max(0.5 * rem, mobile ? 10 : 0);
  const spaceGlyphW = (mobile ? 3 : 5) * 0.72 * glyphPx + 5;           // phones show "SPC", desktop "Space"
  const boxes = [radar, bottom, chat];
  const ov = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (inter(boxes[i], boxes[j])) ov.push(`${boxes[i].n}/${boxes[j].n}`);
  const shipCy = uh / 2;
  return { rem, uw, uh, rs, bw, chatW, barW, blockH, bottom, radar, chat, ov, ultTop, ultLabelW, gaugeW, powerW, reactorTextW, glyphPx, spaceGlyphW, face, qFace,
    clearBelowShip: ultTop - shipCy,
    fits: barW <= bw + 0.5 && ultLabelW <= bw && powerW >= (mobile ? 150 : 10 * rem) && reactorTextW <= powerW * 0.45 && spaceGlyphW <= face && ov.length === 0 };
}

const cases = [
  ['desktop 1920x1080', 1920, 1080, { t: 0, r: 0, b: 0, l: 0 }, false],
  ['laptop 1280x720', 1280, 720, { t: 0, r: 0, b: 0, l: 0 }, false],
  ['laptop 1024x768', 1024, 768, { t: 0, r: 0, b: 0, l: 0 }, false],
  ['phone 812x375 (safe L/R 44, B 21)', 812, 375, { t: 0, r: 44, b: 21, l: 44 }, true],
  ['phone 844x390 (safe L/R 47, B 21)', 844, 390, { t: 0, r: 47, b: 21, l: 47 }, true],
  ['phone 667x375 (no insets)', 667, 375, { t: 0, r: 0, b: 0, l: 0 }, true],
];
console.log('1) TODAY (v0.5 CSS, v0.4 bottom width) on the inset #ui');
for (const [n, vw, vh, s, m] of cases) {
  const r = layout(vw, vh, s, m, 'v05');
  console.log(`  ${n.padEnd(36)} #ui ${r.uw}x${r.uh}  bottom ${R(r.bottom.x0)}..${R(r.bottom.x1)}  chat ..${R(r.chat.x1)}  radar ${R(r.radar.x0)}..  overlaps: ${r.ov.join(', ') || 'none'}`);
}
console.log('\n2) v1.0 bottom block');
for (const [n, vw, vh, s, m] of cases) {
  const r = layout(vw, vh, s, m, 'v1');
  console.log(`  ${n.padEnd(36)} rem ${r.rem.toFixed(1)} | block ${R(r.bw)}x${R(r.blockH)} at x ${R(r.bottom.x0)}..${R(r.bottom.x1)}, y ${R(r.bottom.y0)}..${R(r.bottom.y1)} | bar ${R(r.barW)} | Q face ${R(r.qFace)} | ` +
    `power bar ${R(r.powerW)} | gauge ${R(r.gaugeW)} | glyph ${r.glyphPx.toFixed(1)} px | chat w ${R(r.chatW)} | ULT label top ${R(r.ultTop)} (${R(r.clearBelowShip)} px below ship centre) | overlaps ${r.ov.join(',') || 'none'} | fits ${r.fits}`);
}

console.log('\n3) phone zoom -> hull radius on screen -> mark cap (screenR < 8: 4 marks, < 12: 8 marks, else full)');
for (const [n, vw, vh, s] of cases) {
  const w = vw - s.l - s.r, h = vh - s.t - s.b;
  const halfW = clamp(w * 0.55, 640, 1100);
  const zoom = Math.max(w / 2 / halfW, h / 2 / 1500, w / 2 / 1500);   // GameRenderer.updateCamera
  const cap = (sr) => (sr < 8 ? 4 : sr < 12 ? 8 : 14);
  const cls = [['Juggernaut', 22], ['Arcanist', 16], ['Artificer', 18], ['dome', 9]];
  console.log(`  ${n.padEnd(36)} zoom ${zoom.toFixed(3)}: ` + cls.map(([c, r]) => `${c} ${(r * zoom).toFixed(1)} px -> ${c === 'dome' ? 'no decals' : cap(r * zoom) + ' marks'}`).join(', '));
}

// 4) chime ladder
const MODES = { aeolian: [0, 2, 3, 5, 7, 8, 10], phrygian: [0, 1, 3, 5, 7, 8, 10] };
const PENTA_IDX = [0, 2, 3, 4, 6]; // scale degrees 1 3 4 5 7 of the minor modes
function chimeLadder(tonicPc, mode, chordPcs) {
  const scale = MODES[mode].map((s) => (tonicPc + s) % 12);
  const diatonic = chordPcs.every((p) => scale.includes(p));
  const pcs = diatonic ? PENTA_IDX.map((i) => scale[i]) : [...chordPcs];
  const root = chordPcs[0];
  const start = 74 + ((root - 2 + 12) % 12);            // the chord root placed in D5..C#6 (A5 = 880 Hz, today's base)
  const maxStep = diatonic ? 8 : 5;                      // about 1.6 octaves of pentatonic, 2 octaves of arpeggio
  const lad = []; for (let m = start; m < 120; m++) if (pcs.includes(m % 12)) lad.push(m);
  return { diatonic, maxStep, notes: Array.from({ length: 12 }, (_, n) => lad[Math.min(n, maxStep)]) };
}
const nm = (m) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12] + (Math.floor(m / 12) - 1);
const chords = {
  'A aeolian': [9, 'aeolian', { Am: [9, 0, 4], F: [5, 9, 0], G: [7, 11, 2], Dm: [2, 5, 9], C: [0, 4, 7], 'E (V, G#)': [4, 8, 11] }],
  'E phrygian': [4, 'phrygian', { Em: [4, 7, 11], F: [5, 9, 0], G: [7, 11, 2], Am: [9, 0, 4], 'Bb (tritone)': [10, 2, 5], 'B (V, D#)': [11, 3, 6] }],
};
console.log('\n4) CHIME LADDER (n = 0..11 pickups in a streak)');
let bad = 0;
for (const [key, [tonic, mode, cs]] of Object.entries(chords)) {
  for (const [cn, pcs] of Object.entries(cs)) {
    const l = chimeLadder(tonic, mode, pcs);
    const scale = MODES[mode].map((s) => (tonic + s) % 12);
    let rising = true; for (let n = 1; n <= l.maxStep; n++) if (l.notes[n] <= l.notes[n - 1]) rising = false; const hi = Math.max(...l.notes), lo = Math.min(...l.notes); if (hi > 104 || lo < 74) rising = false;
    const semis = l.notes.filter((m) => pcs.some((p) => { const d = Math.abs(((m % 12) - p + 12) % 12); return d === 1 || d === 11; }) && !pcs.includes(m % 12));
    const out = l.notes.filter((m) => !scale.includes(m % 12) && !pcs.includes(m % 12));
    if (!rising || out.length) bad++;
    console.log(`  ${key.padEnd(10)} over ${cn.padEnd(13)} ${l.diatonic ? 'pentatonic' : 'chord tones'}: ${l.notes.slice(0, 10).map(nm).join(' ')}  range ${nm(Math.min(...l.notes))}..${nm(Math.max(...l.notes))}, rising+in-range ${rising}, out-of-key ${out.length}, semitone-rubs ${semis.length}`);
  }
}
console.log(`  violations (not rising for n<=8, or out of scale+chord): ${bad}`);

// 5) crack layout (same algorithm as screen.mjs / mobile.mjs) on the v1.0 geometry: keep-outs = radar, bottom block (+ the
//    phone ULT label strip over Q), chat (only while it shows lines), top strip, kill feed (3 rows)
const padR = (r, p) => ({ x0: r.x0 - p, y0: r.y0 - p, x1: r.x1 + p, y1: r.y1 + p });
function cracks(sw, sh, keep, lenFrac, seed0, maxN) {
  let s = seed0; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const safe = { x0: sw * 0.2, x1: sw * 0.8, y0: sh * 0.22, y1: sh * 0.78 };
  const P = keep.map((k) => padR(k, 12)); const L0 = lenFrac * Math.min(sw, sh); const per = 2 * (sw + sh), c = [];
  for (let i = 0; i < 32; i++) {
    const u = ((i + r()) / 32) * per; let x, y, a;
    if (u < sw) { x = u; y = 0; a = 90; } else if (u < sw + sh) { x = sw; y = u - sw; a = 180; }
    else if (u < 2 * sw + sh) { x = sw - (u - sw - sh); y = sh; a = 270; } else { x = 0; y = sh - (u - 2 * sw - sh); a = 0; }
    if (P.some((k) => x >= k.x0 && x <= k.x1 && y >= k.y0 && y <= k.y1)) continue;
    const a0 = a + (r() * 2 - 1) * 18; let ok = false;
    for (const off of [0, 40, -40, 60, -60]) {
      if (ok) break; a = a0 + off; const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180);
      for (let L = L0; L >= 0.5 * L0; L -= 4) {
        const tx = x + ca * L, ty = y + sa * L, w = 0.3 * L;
        const bb = { x0: Math.max(0, Math.min(x, tx) - w * Math.abs(sa)), x1: Math.min(sw, Math.max(x, tx) + w * Math.abs(sa)), y0: Math.max(0, Math.min(y, ty) - w * Math.abs(ca)), y1: Math.min(sh, Math.max(y, ty) + w * Math.abs(ca)) };
        if (!inter(bb, padR(safe, 8)) && !P.some((k) => inter(bb, k))) { ok = true; c.push({ L, bb }); break; }
      }
    }
  }
  const viol = c.filter((k) => inter(k.bb, safe) || keep.some((q) => inter(k.bb, q))).length;
  return { n: c.length, usable: Math.min(c.length, maxN), viol, shortest: c.length ? Math.round(Math.min(...c.map((k) => k.L))) : 0 };
}
console.log('\n5) CRACK ANCHORS on the v1.0 layout (T5 length 0.24 x min side; chat showing / chat quiet)');
for (const [n, vw, vh, s, m] of cases) {
  const r = layout(vw, vh, s, m, 'v1');
  const rem = r.rem;
  const top = { x0: 0, y0: 0, x1: r.uw, y1: 0.7 * rem + 2.6 * rem };
  const feed = { x0: r.uw - Math.min(360, 0.3 * r.uw), y0: 3.2 * rem, x1: r.uw - 0.8 * rem, y1: 3.2 * rem + 3 * 1.35 * rem };
  const ult = m ? { x0: r.uw / 2 - r.ultLabelW / 2, y0: r.ultTop, x1: r.uw / 2 + r.ultLabelW / 2, y1: r.bottom.y0 } : null;
  const base = [r.radar, r.bottom, top, feed, ...(ult ? [ult] : [])];
  const maxN = m ? 3 : 6;
  const a = cracks(r.uw, r.uh, [...base, r.chat], 0.24, 7, maxN), b = cracks(r.uw, r.uh, base, 0.24, 7, maxN);
  console.log(`  ${n.padEnd(36)} anchors ${a.n} / ${b.n} (shown ${a.usable} / ${b.usable} of max ${maxN}), shortest ${a.shortest} / ${b.shortest} px, violations ${a.viol + b.viol}`);
}
