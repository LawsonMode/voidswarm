// Home-screen / web-manifest icons (v0.5 mobile): rasterizes the page's inline SVG favicon mark (index.html: the dark
// tile, the magenta orb, the cyan outer chevron and the magenta inner one) with a neon glow into PNGs under
// src/client/public/icons/. No dependencies (a tiny SDF rasterizer + a PNG encoder on node:zlib); not part of the
// build: rerun it by hand after changing the mark, then commit the PNGs (each stays well under 60 KB).
//   node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'public', 'icons');

// ---------------------------------------------------------------- shapes (the favicon's 64 × 64 space)
const CYAN = [0x3b, 0xf2, 0xff];
const MAGENTA = [0xff, 0x3b, 0xd4];
const CORE = [0xe6, 0xfe, 0xff];
const OUTER = [[13, 15], [32, 50], [51, 15]]; // stroke 7
const INNER = [[23, 15], [32, 32], [41, 15]]; // stroke 4
const ORB = { x: 32, y: 27, r: 17 };

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function polyDist(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return d;
}
/** Signed distance to a rounded square [0, 64]² with corner radius r (negative inside). */
function roundRectDist(px, py, r) {
  const qx = Math.abs(px - 32) - (32 - r), qy = Math.abs(py - 32) - (32 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;

/**
 * One icon. `scale` shrinks the mark about the tile centre (maskable icons keep it inside the 80 % safe circle);
 * `rounded` cuts the tile's corners (transparent) instead of filling the whole square.
 */
function render(size, { scale, rounded }) {
  const px = 64 / size; // favicon units per pixel
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bx = (x + 0.5) * px, by = (y + 0.5) * px; // tile space
      const mx = 32 + (bx - 32) / scale, my = 32.5 + (by - 32.5) / scale; // mark space
      const u = px / scale; // mark units per pixel
      // background: the page's #bg radial gradient (violet core → the game's #07040f)
      const g = clamp01(Math.hypot(bx - 32, (by - 24) * 1.1) / 44);
      let r = g < 0.5 ? mix(0x2a, 0x12, g / 0.5) : mix(0x12, 0x07, clamp01((g - 0.5) / 0.45));
      let gg = g < 0.5 ? mix(0x0f, 0x07, g / 0.5) : mix(0x07, 0x04, clamp01((g - 0.5) / 0.45));
      let b = g < 0.5 ? mix(0x4a, 0x2a, g / 0.5) : mix(0x2a, 0x0f, clamp01((g - 0.5) / 0.45));
      const over = (c, a) => { r = mix(r, c[0], a); gg = mix(gg, c[1], a); b = mix(b, c[2], a); };
      const add = (c, a) => { r += c[0] * a; gg += c[1] * a; b += c[2] * a; };
      // magenta orb: a soft disc plus a faint halo
      const od = Math.hypot(mx - ORB.x, my - ORB.y) - ORB.r;
      over(MAGENTA, 0.34 * clamp01(0.5 - od / 1.6));
      if (od > 0) add(MAGENTA, 0.12 * Math.exp(-od / 3.5));
      // cyan outer chevron: glow, stroke, white-hot core
      const cd = polyDist(mx, my, OUTER) - 3.5;
      if (cd > 0) add(CYAN, 0.5 * Math.exp(-cd / 2.4));
      over(CYAN, clamp01(0.5 - cd / u));
      over(CORE, 0.75 * clamp01(0.5 - (cd + 2.1) / u));
      // magenta inner chevron
      const md = polyDist(mx, my, INNER) - 2;
      if (md > 0) add(MAGENTA, 0.42 * Math.exp(-md / 1.8));
      over(MAGENTA, clamp01(0.5 - md / u));
      over([0xff, 0xd8, 0xf6], 0.6 * clamp01(0.5 - (md + 1.2) / u));
      const alpha = rounded ? clamp01(0.5 - roundRectDist(bx, by, 14) / px) : 1;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(Math.min(255, r));
      rgba[i + 1] = Math.round(Math.min(255, gg));
      rgba[i + 2] = Math.round(Math.min(255, b));
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- 256-colour palette (median cut, no dither)
// Glow gradients make a truecolour 512 px icon ~100 KB; indexed, it is a fraction of that with no visible banding.
function quantize(rgba) {
  const key = (i) => ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) { const k = key(i); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const colors = [...counts].map(([k, n]) => ({ k, c: [k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255, k & 255], n }));
  // Box stats: weighted mean, per-channel variance, total squared error.
  const stats = (box) => {
    let n = 0; const s = [0, 0, 0, 0], q = [0, 0, 0, 0];
    for (const e of box) for (let j = 0; j < 4; j++) { s[j] += e.c[j] * e.n; q[j] += e.c[j] * e.c[j] * e.n; }
    for (const e of box) n += e.n;
    const mean = s.map((v) => v / n), vr = q.map((v, j) => v / n - mean[j] * mean[j]);
    return { n, mean, vr, sse: vr.reduce((a, v) => a + v, 0) * n };
  };
  // Greedy variance cut: split the box with the most squared error at its mean along its widest channel.
  let boxes = [{ box: colors, st: stats(colors) }];
  while (boxes.length < 256) {
    let pick = -1, worst = 0;
    boxes.forEach((b, i) => { if (b.box.length > 1 && b.st.sse > worst) { worst = b.st.sse; pick = i; } });
    if (pick < 0) break;
    const { box, st } = boxes[pick];
    const ch = st.vr.indexOf(Math.max(...st.vr));
    const lo = box.filter((e) => e.c[ch] <= st.mean[ch]), hi = box.filter((e) => e.c[ch] > st.mean[ch]);
    if (!lo.length || !hi.length) { boxes[pick].st = { ...st, sse: 0 }; continue; }
    boxes.splice(pick, 1, { box: lo, st: stats(lo) }, { box: hi, st: stats(hi) });
  }
  let palette = boxes.map((b) => b.st.mean);
  // A few k-means passes over the unique colours polish the palette.
  const nearest = (c) => {
    let best = 0, bd = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const q = palette[p];
      const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2 + (c[3] - q[3]) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  for (let it = 0; it < 6; it++) {
    const acc = palette.map(() => [0, 0, 0, 0, 0]);
    for (const e of colors) { const a = acc[nearest(e.c)]; for (let j = 0; j < 4; j++) a[j] += e.c[j] * e.n; a[4] += e.n; }
    palette = palette.map((q, p) => (acc[p][4] ? acc[p].slice(0, 4).map((v) => v / acc[p][4]) : q));
  }
  palette = palette.map((q) => q.map((v) => Math.round(v)));
  const lookup = new Map();
  for (const e of colors) lookup.set(e.k, nearest(e.c));
  const idx = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < idx.length; i++) idx[i] = lookup.get(key(i * 4));
  return { palette, idx };
}

// ---------------------------------------------------------------- PNG (indexed 8-bit, or RGBA with adaptive filters)
function encodeIndexed(size, { palette, idx }) {
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) Buffer.from(idx.subarray(y * size, (y + 1) * size)).copy(raw, y * (size + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 3; // 8-bit palette
  const plte = Buffer.from(palette.flatMap((c) => c.slice(0, 3)));
  const alpha = palette.map((c) => c[3]);
  const chunks = [chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (alpha.some((a) => a < 255)) chunks.push(chunk('tRNS', Buffer.from(alpha)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks, chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < size; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        o[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- outputs
const ICONS = [
  // purpose "any": the favicon's rounded tile
  { file: 'icon-192.png', size: 192, scale: 1, rounded: true },
  { file: 'icon-512.png', size: 512, scale: 1, rounded: true },
  // purpose "maskable": full-bleed tile, mark inside the 80 % safe circle (launchers crop to their own shape)
  { file: 'icon-maskable-192.png', size: 192, scale: 0.78, rounded: false },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.78, rounded: false },
  // iOS home screen (it rounds the corners itself)
  { file: 'apple-touch-icon.png', size: 180, scale: 0.9, rounded: false },
];

mkdirSync(OUT, { recursive: true });
for (const ic of ICONS) {
  const rgba = render(ic.size, ic);
  // indexed unless the truecolour file is already small (the smaller of the two wins)
  const a = encodePng(ic.size, rgba), b = encodeIndexed(ic.size, quantize(rgba));
  const png = b.length < a.length ? b : a;
  writeFileSync(join(OUT, ic.file), png);
  console.log(`${ic.file}  ${ic.size}×${ic.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
