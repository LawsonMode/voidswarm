// Generates the README hero banner (docs/assets/banner.svg) and a neon divider (docs/assets/divider.svg).
//
//   node tools/showcase/banner.mjs
//
// Pure SVG + SMIL (no script, no external fonts: GitHub strips scripts from SVG and the wordmark is drawn as
// stroked paths, so it looks the same whatever fonts the viewer has). The ship silhouettes are the real
// class hulls, read from src/client/render/shapes.ts; team colours come from src/shared/data/teams.ts.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './serve.mjs';

const OUT = join(ROOT, 'docs', 'assets');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------------------ sources
/** HULLS from shapes.ts, evaluated with its three geometry helpers (the file itself imports pixi). */
function loadHulls() {
  const src = readFileSync(join(ROOT, 'src', 'client', 'render', 'shapes.ts'), 'utf8');
  const a = src.indexOf('const BRUTE_HULL');
  const b = src.indexOf('/** Local (unit) positions of the Arcanist');
  if (a < 0 || b < 0) throw new Error('shapes.ts layout changed: HULLS block not found');
  const block = src.slice(a, b).replace(/const HULLS:[^=]+=/, 'const HULLS =');
  // eslint-disable-next-line no-new-func
  return new Function(`
    const mirrorY = (p) => p.map((v, i) => (i % 2 ? -v : v));
    const diamond = (cx, cy, s) => [cx + s, cy, cx, cy + s * 0.7, cx - s, cy, cx, cy - s * 0.7];
    const rect = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
    ${block}
    return HULLS;`)();
}

function loadTeamColors() {
  const src = readFileSync(join(ROOT, 'src', 'shared', 'data', 'teams.ts'), 'utf8');
  const m = src.match(/TEAM_COLORS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('teams.ts layout changed: TEAM_COLORS not found');
  return [...m[1].matchAll(/0x([0-9a-fA-F]{6})/g)].map((x) => `#${x[1].toLowerCase()}`);
}

const HULLS = loadHulls();
const TEAM = loadTeamColors(); // crimson, azure, verdant, solar, violet, cyan, ember, rose
const DRONE = '#ff4fd8'; // ENEMY_COLORS.drone (src/client/render/palette.ts)

// ------------------------------------------------------------------------------------------------ helpers
const f = (n) => (Math.round(n * 10) / 10).toString();
const pts = (p, s) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push(`${f(p[i] * s)},${f(p[i + 1] * s)}`); return o.join(' '); };
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

/** One class hull at radius `r` (facing +x): outline in team colour, plates / lines / nodes as accents. */
function hull(cls, r, color) {
  const h = HULLS[cls];
  const out = [];
  h.polys.forEach((p, i) => out.push(`<polygon points="${pts(p, r)}" fill="${i === 0 ? '#12081f' : '#0c0616'}" fill-opacity=".85" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`));
  for (const p of h.plates ?? []) out.push(`<polygon points="${pts(p, r)}" fill="${color}" fill-opacity=".22" stroke="${color}" stroke-width="1.2" stroke-opacity=".8"/>`);
  for (const l of h.lines ?? []) out.push(`<polyline points="${pts(l, r)}" fill="none" stroke="${color}" stroke-width="1.1" stroke-opacity=".7"/>`);
  for (const n of h.nodes ?? []) out.push(`<polygon points="${pts(n, r)}" fill="${color}" fill-opacity=".5" stroke="#ffffff" stroke-width=".8"/>`);
  return out.join('');
}

/** Exhaust: a flickering flame + a fading trail, behind the hull's stern (x < 0). */
function exhaust(r, color, trail) {
  const x0 = -r * 1.0;
  return `<polygon points="${f(x0)},${f(-r * 0.22)} ${f(x0 - r * 0.9)},0 ${f(x0)},${f(r * 0.22)}" fill="#fff4d0">` +
    `<animate attributeName="points" dur=".18s" repeatCount="indefinite" values="${f(x0)},${f(-r * 0.22)} ${f(x0 - r * 0.9)},0 ${f(x0)},${f(r * 0.22)};${f(x0)},${f(-r * 0.18)} ${f(x0 - r * 1.35)},0 ${f(x0)},${f(r * 0.18)};${f(x0)},${f(-r * 0.22)} ${f(x0 - r * 0.9)},0 ${f(x0)},${f(r * 0.22)}"/></polygon>` +
    `<rect x="${f(x0 - trail)}" y="${f(-r * 0.12)}" width="${f(trail)}" height="${f(r * 0.24)}" fill="url(#trail-${color.slice(1)})"/>`;
}

/**
 * A ship flying `path` once every `dur` s (it crosses in the first `frac` of the cycle and waits off-screen for
 * the rest). A negative begin starts it mid-cycle, so nothing ever sits at the origin before its first run.
 */
function flyer({ cls, r, color, path, dur, frac, begin, trail = 90, bolts = false, scale = 1 }) {
  const b = [];
  if (bolts) {
    for (let i = 0; i < 3; i++) {
      b.push(`<rect x="${f(r * 1.4)}" y="-1.4" width="16" height="2.8" rx="1.4" fill="#fffbe6" opacity="0">` +
        `<animate attributeName="x" values="${f(r * 1.4)};${f(r * 1.4 + 260)}" dur=".55s" begin="${(i * 0.18).toFixed(2)}s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="1;1;0" keyTimes="0;.7;1" dur=".55s" begin="${(i * 0.18).toFixed(2)}s" repeatCount="indefinite"/></rect>`);
    }
  }
  return `<g filter="url(#glow)" opacity="${scale < 1 ? 0.75 : 1}">` +
    `<animateMotion path="${path}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite" rotate="auto" keyPoints="0;1;1" keyTimes="0;${frac};1" calcMode="linear"/>` +
    `<g transform="scale(${scale})">${exhaust(r, color, trail)}${b.join('')}${hull(cls, r, color)}</g></g>`;
}

/** A loose pack of swarm drones (enemy diamonds) sharing one flight path. */
function swarm({ path, dur, frac, begin, n, seed }) {
  const R = rng(seed);
  const d = [];
  for (let i = 0; i < n; i++) {
    const x = (R() - 0.5) * 90, y = (R() - 0.5) * 50, s = 6 + R() * 3;
    const spin = (R() * 2 + 1.2).toFixed(2);
    d.push(`<g transform="translate(${f(x)} ${f(y)})"><polygon points="${f(s)},0 0,${f(s * 0.7)} ${f(-s)},0 0,${f(-s * 0.7)}" fill="${DRONE}" fill-opacity=".25" stroke="${DRONE}" stroke-width="1.4">` +
      `<animateTransform attributeName="transform" type="rotate" values="0;360" dur="${spin}s" repeatCount="indefinite"/></polygon></g>`);
  }
  return `<g filter="url(#glow)"><animateMotion path="${path}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;${frac};1" calcMode="linear"/>${d.join('')}</g>`;
}

// ------------------------------------------------------------------------------------------------ wordmark
/**
 * VOIDSWARM as stroked centre-lines on a letter grid (a squared, geometric face in the spirit of the game's
 * Orbitron logo). Each glyph: [advance width, path(l, t, r, b, m, R)] in stroke-centre coordinates.
 */
const GLYPHS = {
  V: [80, (l, t, r, b) => { const c = (l + r) / 2; return `M${l} ${t}L${c - 7} ${b}H${c + 7}L${r} ${t}`; }],
  O: [80, (l, t, r, b, m, R) => `M${l + R} ${t}H${r - R}Q${r} ${t} ${r} ${t + R}V${b - R}Q${r} ${b} ${r - R} ${b}H${l + R}Q${l} ${b} ${l} ${b - R}V${t + R}Q${l} ${t} ${l + R} ${t}Z`],
  I: [16, (l, t, r, b) => `M${(l + r) / 2} ${t}V${b}`],
  D: [80, (l, t, r, b, m, R) => `M${l} ${t}H${r - R}Q${r} ${t} ${r} ${t + R}V${b - R}Q${r} ${b} ${r - R} ${b}H${l}Z`],
  S: [80, (l, t, r, b, m, R) => `M${r} ${t}H${l + R}Q${l} ${t} ${l} ${t + R}V${m - R * 0.6}Q${l} ${m} ${l + R} ${m}H${r - R}Q${r} ${m} ${r} ${m + R * 0.6}V${b - R}Q${r} ${b} ${r - R} ${b}H${l}`],
  W: [108, (l, t, r, b) => { const w = r - l; return `M${l} ${t}L${l + w * 0.2} ${b}H${l + w * 0.3}L${l + w * 0.5} ${t + (b - t) * 0.3}L${l + w * 0.7} ${b}H${l + w * 0.8}L${r} ${t}`; }],
  A: [80, (l, t, r, b, m, R) => `M${l} ${b}V${t + R}Q${l} ${t} ${l + R} ${t}H${r - R}Q${r} ${t} ${r} ${t + R}V${b}M${l} ${m + 6}H${r}`],
  R: [80, (l, t, r, b, m, R) => `M${l} ${b}V${t}H${r - R}Q${r} ${t} ${r} ${t + R}V${m - R * 0.6}Q${r} ${m} ${r - R} ${m}H${l}M${r - 28} ${m + 2}L${r - 3} ${b - 5}`],
  M: [96, (l, t, r, b) => { const c = (l + r) / 2; return `M${l} ${b}V${t}H${l + 6}L${c} ${t + (b - t) * 0.5}L${r - 6} ${t}H${r}V${b}`; }],
};

function wordmark(text, { cx, top, height, gap, stroke }) {
  const s = stroke / 2;
  const widths = [...text].map((c) => GLYPHS[c][0] * (height / 88));
  const total = widths.reduce((a, w) => a + w, 0) + gap * (text.length - 1);
  let x = cx - total / 2;
  const d = [];
  [...text].forEach((c, i) => {
    const w = widths[i];
    const l = x + s, r = x + w - s, t = top + s, b = top + height - s, m = (t + b) / 2;
    d.push(GLYPHS[c][1](l, t, r, b, m, Math.min(18, (r - l) / 3)));
    x += w + gap;
  });
  return { d: d.join(''), left: cx - total / 2, right: cx + total / 2 };
}

// ------------------------------------------------------------------------------------------------ banner
function banner() {
  const W = 1280, H = 360, HY = 238, CX = 640;
  const R = rng(0x5ca1ab1e);
  const parts = [];

  // stars (a few twinkle)
  const stars = [];
  for (let i = 0; i < 110; i++) {
    const x = R() * W, y = R() * (HY - 8), r = R() < 0.12 ? 1.5 : 0.5 + R() * 0.7, o = 0.35 + R() * 0.6;
    const tw = i % 7 === 0 ? `<animate attributeName="opacity" values="${o.toFixed(2)};.1;${o.toFixed(2)}" dur="${(2 + R() * 3).toFixed(1)}s" begin="-${(R() * 3).toFixed(1)}s" repeatCount="indefinite"/>` : '';
    stars.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${i % 9 === 0 ? '#bfe9ff' : '#ffffff'}" opacity="${o.toFixed(2)}">${tw}</circle>`);
  }
  parts.push(`<g>${stars.join('')}</g>`);

  // the sun: striped lower half, stripes drifting down
  const SUN_Y = 150, SUN_R = 118;
  const stripes = [];
  for (let y = SUN_Y - 70; y < SUN_Y + SUN_R + 20; y += 13) stripes.push(`<rect x="${CX - SUN_R - 4}" y="${y}" width="${SUN_R * 2 + 8}" height="${f(Math.max(1.5, 2 + (y - SUN_Y + 70) / 16))}"/>`);
  parts.push(`<g mask="url(#sun-mask)"><circle cx="${CX}" cy="${SUN_Y}" r="${SUN_R}" fill="url(#sun)"/></g>`);
  parts.push(`<circle cx="${CX}" cy="${SUN_Y}" r="${SUN_R + 40}" fill="url(#sun-halo)"/>`);

  // ridge silhouettes on the horizon
  const ridge = (seed, amp, col, op) => {
    const r = rng(seed); let d = `M0 ${HY}`;
    for (let x = 0; x <= W; x += 40) d += `L${x} ${f(HY - 4 - r() * amp * (Math.abs(x - CX) > 260 ? 1 : 0.25))}`;
    return `<path d="${d}L${W} ${HY}Z" fill="${col}" opacity="${op}"/>`;
  };
  parts.push(ridge(7, 34, '#2a0a45', 0.95), ridge(11, 20, '#3a0d57', 0.9));

  // perspective floor: converging verticals + horizontals scrolling toward the viewer
  const floor = [];
  for (let k = -16; k <= 16; k++) floor.push(`<line x1="${CX + k * 9}" y1="${HY}" x2="${CX + k * 150}" y2="${H + 40}"/>`);
  const N = 9, DUR = 3.2;
  const steps = 18;
  const ys = [], ops = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps, z = 12 - 11 * s; // far → near
    ys.push(`0 ${f(HY + (H + 30 - HY) / z)}`);
    ops.push(Math.min(1, s * 2.2).toFixed(2));
  }
  const hz = [];
  for (let i = 0; i < N; i++) {
    const b = -(i * DUR / N).toFixed(3);
    hz.push(`<line x1="0" y1="0" x2="${W}" y2="0"><animateTransform attributeName="transform" type="translate" values="${ys.join(';')}" dur="${DUR}s" begin="${b}s" repeatCount="indefinite"/>` +
      `<animate attributeName="stroke-opacity" values="${ops.join(';')}" dur="${DUR}s" begin="${b}s" repeatCount="indefinite"/></line>`);
  }
  parts.push(`<rect x="0" y="${HY}" width="${W}" height="${H - HY}" fill="url(#floor)"/>`);
  parts.push(`<g clip-path="url(#below)"><g stroke="#3bf2ff" stroke-opacity=".38" stroke-width="1.2">${floor.join('')}</g>` +
    `<g stroke="#ff3bd4" stroke-width="1.6" filter="url(#glow-soft)">${hz.join('')}</g></g>`);
  parts.push(`<rect x="0" y="${HY - 2}" width="${W}" height="4" fill="url(#horizon)" filter="url(#glow)"/>`);

  // ships and a swarm crossing the sky (hulls: src/client/render/shapes.ts; colours: TEAM_COLORS)
  const [CRIMSON, AZURE, VERDANT, SOLAR, VIOLET, CYAN] = TEAM;
  parts.push(swarm({ path: 'M-120 118 C 300 60, 700 150, 1420 96', dur: 12, frac: 0.62, begin: -1.5, n: 7, seed: 3 }));
  parts.push(flyer({ cls: 'tech', r: 17, color: AZURE, path: 'M-260 128 C 180 64, 620 160, 1320 100', dur: 12, frac: 0.62, begin: -1.5, bolts: true, trail: 120 }));
  parts.push(flyer({ cls: 'brute', r: 20, color: CRIMSON, path: 'M1420 64 C 1000 20, 520 110, -160 54', dur: 10, frac: 0.7, begin: -6, trail: 110 }));
  parts.push(flyer({ cls: 'engineer', r: 16, color: VERDANT, path: 'M-120 300 C 360 272, 860 322, 1420 286', dur: 14, frac: 0.55, begin: -9, trail: 100 }));
  parts.push(flyer({ cls: 'tech', r: 16, color: SOLAR, path: 'M1400 212 C 1000 190, 400 214, -140 180', dur: 16, frac: 0.5, begin: -3, trail: 80, scale: 0.7 }));
  parts.push(flyer({ cls: 'brute', r: 16, color: VIOLET, path: 'M-140 36 C 300 18, 900 50, 1420 24', dur: 19, frac: 0.55, begin: -13, trail: 70, scale: 0.6 }));
  parts.push(flyer({ cls: 'engineer', r: 16, color: CYAN, path: 'M1420 336 C 900 344, 400 318, -140 340', dur: 11, frac: 0.5, begin: -2, trail: 120 }));

  // wordmark: glow, chrome, shine
  const wm = wordmark('VOIDSWARM', { cx: CX, top: 146, height: 88, gap: 19, stroke: 16 });
  parts.push(`<path d="${wm.d}" fill="none" stroke="#ff2bd1" stroke-width="16" stroke-linejoin="miter" stroke-miterlimit="3" stroke-linecap="square" filter="url(#glow-big)" opacity=".85">` +
    `<animate attributeName="opacity" values=".6;.95;.6" dur="2.4s" repeatCount="indefinite"/></path>`);
  parts.push(`<path d="${wm.d}" fill="none" stroke="#1a0630" stroke-width="22" stroke-linejoin="miter" stroke-miterlimit="3" stroke-linecap="square"/>`);
  parts.push(`<path d="${wm.d}" fill="none" stroke="url(#chrome)" stroke-width="16" stroke-linejoin="miter" stroke-miterlimit="3" stroke-linecap="square"/>`);
  parts.push(`<path d="${wm.d}" fill="none" stroke="url(#shine)" stroke-width="16" stroke-linejoin="miter" stroke-miterlimit="3" stroke-linecap="square"/>`);
  parts.push(`<path d="${wm.d}" fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width="1.2" stroke-linejoin="miter" transform="translate(0 -5)"/>`);

  // tagline
  parts.push(`<text x="${CX}" y="${HY + 34}" text-anchor="middle" font-family="'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="700" font-size="15" letter-spacing="6" fill="#f2e8ff" stroke="#1a0630" stroke-width="3" paint-order="stroke">NEON ARENA · 32 PILOTS · THE SWARM IS HUNGRY</text>`);
  parts.push(`<text x="${CX}" y="${HY + 56}" text-anchor="middle" font-family="'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="600" font-size="11.5" letter-spacing="4" fill="#3bf2ff" stroke="#07040f" stroke-width="3" paint-order="stroke" opacity=".95">DUNGEON RUNNER · ARENA · WARZONE — PLAY IN THE BROWSER</text>`);

  // scanlines + vignette
  parts.push(`<rect width="${W}" height="${H}" fill="url(#scanp)" opacity=".2"/>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#vignette)"/>`);

  const trails = [...new Set(TEAM)].map((c) => `<linearGradient id="trail-${c.slice(1)}" x1="0" x2="1"><stop offset="0" stop-color="${c}" stop-opacity="0"/><stop offset="1" stop-color="${c}" stop-opacity=".75"/></linearGradient>`).join('');
  const defs = `<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05030d"/><stop offset=".45" stop-color="#170733"/><stop offset=".66" stop-color="#3a0b5a"/><stop offset=".7" stop-color="#12051f"/><stop offset="1" stop-color="#07040f"/></linearGradient>
<radialGradient id="haze" cx=".5" cy=".66" r=".6"><stop offset="0" stop-color="#ff3bd4" stop-opacity=".45"/><stop offset=".5" stop-color="#7a1fb0" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset=".45" stop-color="#ffb05a"/><stop offset=".75" stop-color="#ff6aa8"/><stop offset="1" stop-color="#ff3bd4"/></linearGradient>
<radialGradient id="sun-halo"><stop offset=".72" stop-color="#ff7ab8" stop-opacity=".22"/><stop offset="1" stop-color="#ff3bd4" stop-opacity="0"/></radialGradient>
<mask id="sun-mask"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000"><g>${stripes.join('')}<animateTransform attributeName="transform" type="translate" values="0 0;0 13" dur="1.6s" repeatCount="indefinite"/></g></g><rect x="0" y="0" width="${W}" height="${SUN_Y - 72}" fill="#fff"/><rect x="0" y="${HY}" width="${W}" height="${H - HY}" fill="#000"/></mask>
<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a0a45"/><stop offset=".25" stop-color="#12051f"/><stop offset="1" stop-color="#05030d"/></linearGradient>
<linearGradient id="horizon" x1="0" x2="1"><stop offset="0" stop-color="#ff3bd4" stop-opacity=".2"/><stop offset=".5" stop-color="#ffd6f4"/><stop offset="1" stop-color="#ff3bd4" stop-opacity=".2"/></linearGradient>
<clipPath id="below"><rect x="0" y="${HY}" width="${W}" height="${H - HY}"/></clipPath>
<linearGradient id="chrome" gradientUnits="userSpaceOnUse" x1="0" y1="146" x2="0" y2="234"><stop offset="0" stop-color="#f4feff"/><stop offset=".2" stop-color="#9ff3ff"/><stop offset=".48" stop-color="#3bc8ff"/><stop offset=".5" stop-color="#2a0f55"/><stop offset=".53" stop-color="#ff5fd0"/><stop offset=".8" stop-color="#ff9ae4"/><stop offset="1" stop-color="#fff0fb"/></linearGradient>
<linearGradient id="shine" gradientUnits="userSpaceOnUse" x1="${wm.left - 300}" y1="0" x2="${wm.left - 60}" y2="60"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
<animateTransform attributeName="gradientTransform" type="translate" values="0 0;0 0;${f(wm.right - wm.left + 420)} 0" keyTimes="0;.55;1" dur="5.5s" repeatCount="indefinite"/></linearGradient>
<pattern id="scanp" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".5"/></pattern>
<radialGradient id="vignette" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".65"/></radialGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="glow-soft" x="-5%" y="-50%" width="110%" height="200%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="glow-big" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
${trails}
</defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Voidswarm</title>
<desc id="d">Voidswarm: a neon synthwave arena. Ships of every class and team fly over a scrolling perspective grid under a striped sun.</desc>
${defs}
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<rect width="${W}" height="${H}" fill="url(#haze)"/>
${parts.join('\n')}
</svg>
`;
}

// ------------------------------------------------------------------------------------------------ divider
function divider() {
  const W = 1280, H = 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="divider">
<defs>
<linearGradient id="line" x1="0" x2="1"><stop offset="0" stop-color="#3bf2ff" stop-opacity="0"/><stop offset=".2" stop-color="#3bf2ff"/><stop offset=".5" stop-color="#ff3bd4"/><stop offset=".8" stop-color="#3bf2ff"/><stop offset="1" stop-color="#3bf2ff" stop-opacity="0"/></linearGradient>
<linearGradient id="pulse" gradientUnits="userSpaceOnUse" x1="-240" x2="0" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
<animateTransform attributeName="gradientTransform" type="translate" values="0 0;${W + 240} 0" dur="3.5s" repeatCount="indefinite"/></linearGradient>
<filter id="g" x="-5%" y="-300%" width="110%" height="700%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect x="0" y="${H / 2 - 1}" width="${W}" height="2" fill="url(#line)" filter="url(#g)"/>
<rect x="0" y="${H / 2 - 1}" width="${W}" height="2" fill="url(#pulse)" filter="url(#g)"/>
</svg>
`;
}

for (const [name, svg] of [['banner.svg', banner()], ['divider.svg', divider()]]) {
  const p = join(OUT, name);
  writeFileSync(p, svg);
  console.log(`${p.slice(ROOT.length + 1).replace(/\\/g, '/')}  ${(statSync(p).size / 1024).toFixed(1)} KB`);
}
