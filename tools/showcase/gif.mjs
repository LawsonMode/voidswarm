// GIF assembly for the showcase: constant-rate frame list → crop / scale → deadband → palettegen / paletteuse.
//
// Re-encode kept frames (capture.mjs --keep-frames) without recording again:
//   node tools/showcase/gif.mjs <frames-dir> <out.gif> [--crop 1280x720[+x+y]] [--width 960] [--fps 20] [--max-mb 6]
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function ffmpeg(args, input) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { input, maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`ffmpeg not runnable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`);
  return r.stdout;
}

/**
 * Decode the frame list at a constant `fps` (cropped + scaled) and write raw RGB with a deadband: a pixel
 * that moved less than `band` levels (max channel) since the last value written keeps that value. Bloom
 * halos, the reactive grid and twinkling stars nudge most pixels by a few levels every frame, and left
 * alone that noise defeats the GIF's frame-difference compression. A pixel whose input has settled (within
 * 2 levels for `settle` frames) takes its exact value, so a slow fade never leaves a faint residue behind.
 * Rows from `exactFrom` (a fraction of the height) down are copied exactly.
 */
export async function deadband(concat, rawPath, { fps, crop, width, height, band, settle = 4, exactFrom = 1 }) {
  const px = width * height, fsz = px * 3;
  const dec = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
    '-vf', `${crop},scale=${width}:${height}:flags=lanczos`, '-r', String(fps), '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  const out = createWriteStream(rawPath);
  let pend = Buffer.alloc(0), n = 0;
  let prevOut = null, prevIn = null;
  const still = new Uint8Array(px);
  // The HUD strip (DOM, noise-free) is copied exactly: a deadband there would leave stepped residue in the bars.
  const exactPx = Math.round(height * exactFrom) * width;
  dec.stdout.on('data', (c) => {
    pend = pend.length ? Buffer.concat([pend, c]) : c;
    while (pend.length >= fsz) {
      const f = Buffer.from(pend.subarray(0, fsz));
      pend = pend.subarray(fsz);
      const input = Buffer.from(f);
      if (prevOut && band > 0) {
        for (let p = 0, i = 0; p < exactPx; p++, i += 3) {
          const r = f[i], g = f[i + 1], b = f[i + 2];
          const dIn = Math.max(Math.abs(r - prevIn[i]), Math.abs(g - prevIn[i + 1]), Math.abs(b - prevIn[i + 2]));
          still[p] = dIn <= 2 ? Math.min(255, still[p] + 1) : 0;
          const d = Math.max(Math.abs(r - prevOut[i]), Math.abs(g - prevOut[i + 1]), Math.abs(b - prevOut[i + 2]));
          if (d < band && !(d > 6 && still[p] >= settle)) { f[i] = prevOut[i]; f[i + 1] = prevOut[i + 1]; f[i + 2] = prevOut[i + 2]; }
        }
      }
      prevOut = f;
      prevIn = input;
      out.write(f);
      n++;
    }
  });
  const code = await new Promise((r) => dec.on('close', r));
  await new Promise((r) => out.end(r));
  if (code !== 0 || n === 0) throw new Error(`frame decode failed (${code}, ${n} frames)`);
  return n;
}

export const GIF_VARIANTS = [
  { band: 12, colors: 160, dither: 'none' },
  { band: 15, colors: 144, dither: 'none' },
  { band: 18, colors: 128, dither: 'none' },
  { band: 22, colors: 112, dither: 'none' },
  { band: 26, colors: 96, dither: 'none' },
];

/**
 * Encode `concat` (an ffconcat list at `fps`) to `out`, trying ever coarser settings until it fits in
 * `maxBytes`. `crop` = [w, h] around the centre of a `view` = [W, H] frame, or [w, h, x, y]. Returns { path, size, variant }.
 */
export async function encodeGif(concat, out, { dir, fps = 20, width = 960, crop, view, maxBytes, log = () => {}, variants = GIF_VARIANTS, exactFrom = 1 }) {
  const [cw, ch, cx, cy] = crop;
  const [VW, VH] = view;
  const height = Math.round((width * ch) / cw / 2) * 2;
  const raw = join(dir, 'frames.rgb');
  const cropF = `crop=${cw}:${ch}:${cx ?? Math.round((VW - cw) / 2)}:${cy ?? Math.round((VH - ch) / 2)}`;
  let lastBand = -1;
  for (const v of variants) {
    if (v.band !== lastBand) { await deadband(concat, raw, { fps, crop: cropF, width, height, band: v.band, exactFrom }); lastBand = v.band; }
    const rawIn = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps), '-i', raw];
    const pal = join(dir, 'palette.png');
    ffmpeg([...rawIn, '-vf', `palettegen=max_colors=${v.colors}:stats_mode=diff`, pal]);
    ffmpeg([...rawIn, '-i', pal, '-lavfi', `paletteuse=dither=${v.dither}:diff_mode=rectangle`, '-loop', '0', out]);
    const size = statSync(out).size;
    if (size <= maxBytes) return { path: out, size, variant: v };
    log(`  ${(size / 1048576).toFixed(2)} MB at deadband ${v.band} / ${v.colors} colours — too big, trying coarser`);
  }
  throw new Error(`GIF over ${maxBytes} bytes at every setting: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const opt = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const [dir, out] = a;
  if (!dir || !out) { console.error('usage: node tools/showcase/gif.mjs <frames-dir> <out.gif> [--crop 1280x720[+x+y]] [--width 960] [--fps 20] [--max-mb 6]'); process.exit(2); }
  const [cw, ch, cx, cy] = opt('crop', '1280x720').split(/[x+]/).map(Number);
  const [vw, vh] = opt('view', '1600x900').split('x').map(Number);
  const r = await encodeGif(join(dir, 'list.txt'), out, {
    dir, fps: Number(opt('fps', 20)), width: Number(opt('width', 960)), crop: [cw, ch, cx, cy], view: [vw, vh],
    maxBytes: Number(opt('max-mb', 6)) * 1e6, log: console.log,
    variants: opt('variant') ? [JSON.parse(opt('variant'))] : GIF_VARIANTS, exactFrom: Number(opt('exact-from', 1)),
  });
  console.log(`${r.path} ${(r.size / 1048576).toFixed(2)} MB`, r.variant);
}
