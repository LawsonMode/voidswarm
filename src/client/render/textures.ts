// Procedural texture atlas (one shared source so every ParticleContainer can batch it) + starfield tiles.
import { Rectangle, Texture } from 'pixi.js';

export interface Atlas {
  base: Texture;
  soft: Texture; // radial soft glow
  dot: Texture; // tight hot dot
  streak: Texture; // horizontal elongated glow (points +x)
  diamond: Texture; // diamond outline glow
  shard: Texture; // filled triangle
  crystal: Texture; // gem crystal
  ring: Texture; // thin glowing ring
  square: Texture; // square outline
  plus: Texture; // healing plus sign
  // v0.3 cosmetics (weapon shapes, points +x) + loot
  wShard: Texture; // long faceted kite
  needle: Texture; // thin bright needle
  orb: Texture; // round bolt with a rim
  droplet: Texture; // teardrop, round end trailing
  hexCrate: Texture; // loot cache hex crate (24 px drawn at 0.75)
  beam: Texture; // vertical loot beam (bright at the bottom, fades upward), 32×64
}

const W = 256, H = 128;

export function buildAtlas(): Atlas {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, W, H);

  // soft (0,0,64,64)
  radial(c, 32, 32, 30, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [0.6, 'rgba(255,255,255,0.15)'], [1, 'rgba(255,255,255,0)']]);
  // dot (64,0,32,32)
  radial(c, 80, 16, 14, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.9)'], [0.7, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]);
  // streak (96,0,64,16)
  c.save();
  c.translate(128, 8); c.scale(30, 6.5);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill();
  c.restore();
  // diamond (160,0,32,32)
  glowStroke(c, () => { c.moveTo(176, 4); c.lineTo(188, 16); c.lineTo(176, 28); c.lineTo(164, 16); c.closePath(); }, 2.2);
  // shard (192,0,32,32)
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.beginPath(); c.moveTo(220, 16); c.lineTo(198, 8); c.lineTo(202, 24); c.closePath(); c.fill();
  // crystal (224,0,32,32)
  c.save();
  const cg = c.createLinearGradient(230, 4, 250, 28);
  cg.addColorStop(0, 'rgba(255,255,255,1)'); cg.addColorStop(1, 'rgba(255,255,255,0.55)');
  c.fillStyle = cg;
  c.beginPath(); c.moveTo(240, 3); c.lineTo(250, 12); c.lineTo(246, 27); c.lineTo(234, 27); c.lineTo(230, 12); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = 1.2; c.stroke();
  c.restore();
  // ring (0,64,64,64)
  glowStroke(c, () => { c.arc(32, 96, 26, 0, Math.PI * 2); }, 2.5);
  // square (64,32,32,32)
  glowStroke(c, () => { c.rect(70, 38, 20, 20); }, 2.2);
  // plus (96,32,32,32)
  c.save();
  c.fillStyle = 'rgba(255,255,255,0.3)';
  c.fillRect(106, 36, 12, 24); c.fillRect(100, 42, 24, 12);
  c.fillStyle = 'rgba(255,255,255,1)';
  c.fillRect(109, 39, 6, 18); c.fillRect(103, 45, 18, 6);
  c.restore();

  // ---- v0.3 cosmetic weapon cells (free region x 128..256, y 32..64), each 32×32, pointing +x
  // wShard (128,32)
  c.save();
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.beginPath(); c.moveTo(159, 48); c.lineTo(141, 41); c.lineTo(129, 48); c.lineTo(141, 55); c.closePath(); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.beginPath(); c.moveTo(158, 48); c.lineTo(142, 43); c.lineTo(132, 48); c.lineTo(142, 53); c.closePath(); c.fill();
  c.restore();
  // needle (160,32)
  c.save();
  c.translate(176, 48); c.scale(15, 2.2);
  const ng = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  ng.addColorStop(0, 'rgba(255,255,255,1)'); ng.addColorStop(0.5, 'rgba(255,255,255,0.8)'); ng.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = ng; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill();
  c.restore();
  c.fillStyle = 'rgba(255,255,255,1)'; c.fillRect(174, 47, 16, 2);
  // orb (192,32)
  radial(c, 208, 48, 12, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.85)'], [0.75, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]);
  glowStroke(c, () => { c.arc(208, 48, 9, 0, Math.PI * 2); }, 1.2);
  // droplet (224,32): round head at +x, tapering tail toward -x
  c.save();
  c.fillStyle = 'rgba(255,255,255,0.3)';
  c.beginPath(); c.moveTo(226, 48); c.quadraticCurveTo(240, 38, 248, 41); c.arc(247, 48, 7.5, -Math.PI / 2, Math.PI / 2); c.quadraticCurveTo(240, 58, 226, 48); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.beginPath(); c.moveTo(229, 48); c.quadraticCurveTo(240, 41, 247, 43); c.arc(247, 48, 5, -Math.PI / 2, Math.PI / 2); c.quadraticCurveTo(240, 55, 229, 48); c.fill();
  c.restore();
  // hexCrate (64,64): hex outline + inner facets, faint fill (tinted by rarity)
  c.save();
  const hexPath = (cx: number, cy: number, r: number) => { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; if (i) c.lineTo(x, y); else c.moveTo(x, y); } c.closePath(); };
  c.fillStyle = 'rgba(255,255,255,0.22)'; c.beginPath(); hexPath(80, 80, 13); c.fill();
  glowStroke(c, () => hexPath(80, 80, 13), 1.8);
  c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1.1; c.beginPath();
  c.moveTo(80, 80); c.lineTo(80, 67); c.moveTo(80, 80); c.lineTo(80 + Math.cos(Math.PI / 6) * 13, 80 + Math.sin(Math.PI / 6) * 13);
  c.moveTo(80, 80); c.lineTo(80 - Math.cos(Math.PI / 6) * 13, 80 + Math.sin(Math.PI / 6) * 13); c.stroke();
  c.restore();
  // beam (96,64,32,64): vertical column, brightest at the bottom, fading to the top
  c.save();
  const bh = c.createLinearGradient(0, 64, 0, 128);
  bh.addColorStop(0, 'rgba(255,255,255,0)'); bh.addColorStop(0.55, 'rgba(255,255,255,0.35)'); bh.addColorStop(1, 'rgba(255,255,255,0.95)');
  c.fillStyle = bh;
  for (let x = 100; x < 124; x++) { // per-column horizontal falloff (no global compositing: keeps the rest of the atlas)
    const u = (x + 0.5 - 112) / 12;
    c.globalAlpha = Math.exp(-u * u * 4);
    c.fillRect(x, 64, 1, 64);
  }
  c.restore();

  const base = Texture.from(cv);
  base.source.scaleMode = 'linear';
  const sub = (x: number, y: number, w: number, h: number) => new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) });
  return {
    base,
    soft: sub(0, 0, 64, 64),
    dot: sub(64, 0, 32, 32),
    streak: sub(96, 0, 64, 16),
    diamond: sub(160, 0, 32, 32),
    shard: sub(192, 0, 32, 32),
    crystal: sub(224, 0, 32, 32),
    ring: sub(0, 64, 64, 64),
    square: sub(64, 32, 32, 32),
    plus: sub(96, 32, 32, 32),
    wShard: sub(128, 32, 32, 32),
    needle: sub(160, 32, 32, 32),
    orb: sub(192, 32, 32, 32),
    droplet: sub(224, 32, 32, 32),
    hexCrate: sub(64, 64, 32, 32),
    beam: sub(96, 64, 32, 64),
  };
}

function radial(c: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [number, string][]): void {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, col] of stops) g.addColorStop(o, col);
  c.fillStyle = g;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
}

function glowStroke(c: CanvasRenderingContext2D, path: () => void, w: number): void {
  c.save();
  c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = w * 3;
  c.beginPath(); path(); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = w;
  c.beginPath(); path(); c.stroke();
  c.restore();
}

/**
 * v0.3 M4 screen vignette (rift sealed rooms): white, transparent in the middle and opaque at the edges, stretched
 * over the screen and tinted by the room state.
 */
export function buildVignette(): Texture {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(S / 2, S / 2, S * 0.28, S / 2, S / 2, S * 0.72);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  const t = Texture.from(cv);
  t.source.scaleMode = 'linear';
  return t;
}

/** Tileable star layer (wraps at edges). */
export function buildStarTile(size: number, count: number, maxR: number, seed: number, tint: [number, number, number]): Texture {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const c = cv.getContext('2d')!;
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size, r = 0.4 + rnd() * rnd() * maxR, a = 0.25 + rnd() * 0.75;
    const hue = rnd();
    const rr = Math.round(tint[0] * (0.7 + hue * 0.3)), gg = Math.round(tint[1] * (0.7 + (1 - hue) * 0.3)), bb = tint[2];
    for (const ox of [0, -size, size]) for (const oy of [0, -size, size]) {
      const px = x + ox, py = y + oy;
      if (px < -8 || py < -8 || px > size + 8 || py > size + 8) continue;
      const g = c.createRadialGradient(px, py, 0, px, py, r * 2.5);
      g.addColorStop(0, `rgba(${rr},${gg},${bb},${a})`);
      g.addColorStop(0.35, `rgba(${rr},${gg},${bb},${a * 0.4})`);
      g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(px, py, r * 2.5, 0, Math.PI * 2); c.fill();
    }
  }
  const t = Texture.from(cv);
  t.source.addressMode = 'repeat';
  return t;
}
