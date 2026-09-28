// Backdrop layers of the Title attract scene, back to front: deep-space gradient + nebula, a twinkling
// parallax starfield with shooting stars, the synthwave sun (scrolling stripe cut-outs, bloom, heat
// shimmer), neon mountain / city silhouettes, the perspective grid scrolling toward the viewer (with
// floor ripples) and the horizon fog. Everything static is pre-rendered on build(); a frame is mostly
// drawImage + a few dozen strokes.
import {
  clamp, gridRowDepths, lerp, mulberry32, projectFloor, range, ridgeHeights, smoothstep,
  type FloorCam, type Pt, type Rand,
} from './sceneMath';
import { rgba } from './sprites';

export interface StageLayout {
  W: number;
  H: number;
  dpr: number;
  /** Sun / vanishing point x. */
  cx: number;
  /** Horizon y. */
  hy: number;
  sunY: number;
  sunR: number;
}

export interface FloorRipple { X: number; z: number; age: number; life: number; size: number; color: number }

const CYAN = 0x3bf2ff;
const MAGENTA = 0xff3bd4;
const TAU = Math.PI * 2;
/** Sun bloom square side, in sun radii. */
const GLOW_SPAN = 3.8;
/** Horizon drift (px) before the baked sky layer is redrawn. */
const SKY_REBUILD_PX = 24;
/** Peak lateral camera sway, floor units (TitleScene sways camX within ±CAM_SWAY). */
export const CAM_SWAY = 0.07;
/** Slack added to the floor layer's side margin, so an easing vanishing point doesn't rebuild it every frame. */
const FLOOR_SLACK = 48;

/**
 * Extra width each side of the floor layer so its edges never show: the sway shears the bottom row by up to
 * CAM_SWAY × f, and the layer is centred on the vanishing point (cx), which can sit off the stage centre.
 */
export function floorMarginFor(W: number, cx: number, f: number): number {
  return Math.ceil(CAM_SWAY * f + Math.abs(cx - W / 2)) + 8;
}

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('title scene: 2D canvas unavailable');
  return [c, ctx];
}

function free(c: HTMLCanvasElement | null): void {
  if (c) { c.width = 0; c.height = 0; }
}

interface Strip { canvas: HTMLCanvasElement; w: number; h: number; sway: number }
interface Antenna { x: number; y: number; ph: number }
interface Shooting { x: number; y: number; vx: number; vy: number; age: number; life: number; len: number }

/** Stars: struct of arrays, grouped by tint (white, cyan, pink). */
interface Stars { n: number; x: Float32Array; y: Float32Array; s: Float32Array; ph: Float32Array; tw: Float32Array; v: Float32Array; a: Float32Array; groups: [number, number, number, number] }

export class Backdrop {
  private W = 0;
  private H = 0;
  private dpr = 1;
  private sunR = 0;
  private sky: HTMLCanvasElement | null = null;
  private skyHy = -1;
  private skyCx = -1;
  private skySunR = -1;
  private floor: HTMLCanvasElement | null = null;
  private floorH = 0;
  /** Side margin (CSS px) the current floor layer was built with. */
  private floorMargin = 0;
  private blobs: { col: number; a: number; x: number; y: number; r: number }[] = [];
  private sunDisc: HTMLCanvasElement | null = null;
  private fog: HTMLCanvasElement | null = null;
  private fogH = 0;
  private band: HTMLCanvasElement | null = null;
  private far: Strip | null = null;
  private city: Strip | null = null;
  private near: Strip | null = null;
  private antennas: Antenna[] = [];
  private stars: Stars | null = null;
  private readonly shooting: Shooting[] = [];
  private readonly rowZ: number[] = [];
  private readonly pt: Pt = { x: 0, y: 0 };
  /** Side margin of the mountain / city strips (their sway is at most 0.25 × CAM_SWAY × f). */
  private margin = 48;
  /** Grid rows scrolled toward the viewer. */
  scroll = 0;
  readonly cam: FloorCam = { cx: 0, horizonY: 0, floorH: 1, f: 1, camX: 0 };

  /**
   * (Re)build every cached layer for a W×H CSS-px stage at `dpr`; `starDensity` = CSS px² per star.
   * `keepStars`: a height-only change (phone keyboard, browser chrome) keeps the starfield in place, rescaled
   * to the new height, instead of re-seeding it (which would make every star jump).
   */
  build(W: number, H: number, dpr: number, sunR: number, starDensity: number, seed: number, keepStars = false): void {
    const kept = keepStars && this.W === W && this.H > 0 ? this.stars : null;
    const oldH = this.H;
    this.destroy();
    this.W = W; this.H = H; this.dpr = dpr; this.sunR = sunR;
    this.margin = Math.max(48, Math.ceil(0.25 * CAM_SWAY * 0.5 * Math.max(W, H)) + 8);
    const rand = mulberry32(seed);
    this.pickNebula(rand);
    this.buildSun();
    this.buildStrips(rand);
    this.buildFog();
    if (kept) {
      const k = H / oldH;
      for (let i = 0; i < kept.n; i++) kept.y[i] *= k;
      this.stars = kept;
    } else {
      this.buildStars(rand, starDensity);
    }
  }

  /** Rebuild only the sun (its radius follows the logo width). */
  setSunRadius(r: number): void {
    if (Math.abs(r - this.sunR) < 2 || this.W === 0) return;
    this.sunR = r;
    free(this.sunDisc);
    this.buildSun();
    this.skySunR = -1; // the bloom in the sky layer follows the sun
  }

  /** Re-seed the starfield at a new density (quality change). */
  setStarDensity(density: number, seed: number): void {
    if (this.W === 0) return;
    this.buildStars(mulberry32(seed ^ 0x5eed), density);
  }

  get starCount(): number { return this.stars?.n ?? 0; }

  private pickNebula(rand: Rand): void {
    const cols: [number, number][] = [[0x9b5bff, 0.13], [MAGENTA, 0.08], [CYAN, 0.05], [0x9b5bff, 0.09], [MAGENTA, 0.06], [0x3b8bff, 0.06]];
    this.blobs = cols.map(([col, a]) => ({
      col, a, x: range(rand, 0.05, 0.95), y: range(rand, 0.02, 0.55), r: range(rand, 0.18, 0.42),
    }));
  }

  /**
   * Sky gradient + nebula + the sun's bloom in one full-resolution layer: one plain copy per frame. Rebuilt
   * only when the horizon / sun move far (the fog band hides small offsets) or the sun is resized.
   */
  private buildSky(hy: number, cx: number, sunY: number): void {
    free(this.sky);
    const [c, ctx] = canvas2d(this.W * this.dpr, this.H * this.dpr);
    ctx.scale(this.dpr, this.dpr);
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
    g.addColorStop(0, '#03010a');
    g.addColorStop(0.5, '#0d0524');
    g.addColorStop(0.82, '#230a42');
    g.addColorStop(1, '#46105e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = 'lighter';
    const M = Math.max(this.W, this.H);
    for (const b of this.blobs) {
      const x = b.x * this.W, y = b.y * this.H, r = b.r * M;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, rgba(b.col, b.a));
      rg.addColorStop(0.45, rgba(b.col, b.a * 0.4));
      rg.addColorStop(1, rgba(b.col, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, this.W, this.H);
    }
    const R = this.sunR;
    if (R > 0) {
      const gr = R * GLOW_SPAN * 0.5;
      const rg = ctx.createRadialGradient(cx, sunY, R * 0.6, cx, sunY, gr);
      rg.addColorStop(0, 'rgba(255,120,200,0.5)');
      rg.addColorStop(0.28, 'rgba(255,59,212,0.22)');
      rg.addColorStop(0.62, 'rgba(155,91,255,0.07)');
      rg.addColorStop(1, 'rgba(155,91,255,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(cx - gr, sunY - gr, gr * 2, gr * 2);
    }
    this.sky = c;
    this.skyHy = hy;
    this.skyCx = cx;
    this.skySunR = R;
  }

  /**
   * The floor gradient + converging grid lines, pre-rendered once with the vanishing point at the top centre.
   * Per frame it is one transformed blit: camera sway is a shear (near lines slide further than far ones)
   * and a horizon move is a vertical scale about the vanishing point — both exact for this projection.
   */
  private buildFloor(floorH: number, margin: number): void {
    free(this.floor);
    this.floorMargin = margin;
    const Wc = this.W + margin * 2;
    const h = Math.max(8, floorH);
    const [c, ctx] = canvas2d(Wc * this.dpr, h * this.dpr);
    ctx.scale(this.dpr, this.dpr);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#12052c');
    g.addColorStop(1, '#05020d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, Wc, h);
    const f = 0.5 * Math.max(this.W, this.H);
    const cam: FloorCam = { cx: Wc / 2, horizonY: 0, floorH: h, f, camX: 0 };
    const p = this.pt;
    const zMax = 60, step = 0.25;
    const xr = (6 * (Wc / 2)) / f;
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    for (let X = -Math.ceil(xr / step) * step; X <= xr + 1e-6; X += step) {
      projectFloor(cam, X, zMax, p);
      ctx.moveTo(p.x, p.y);
      projectFloor(cam, X, 0.85, p);
      ctx.lineTo(p.x, p.y);
    }
    // Fade the lines in from the horizon: where they converge they would otherwise read as a bright wedge.
    const fade = (a: number) => {
      const lg = ctx.createLinearGradient(0, 0, 0, h * 0.42);
      lg.addColorStop(0, rgba(CYAN, 0));
      lg.addColorStop(0.35, rgba(CYAN, a * 0.35));
      lg.addColorStop(1, rgba(CYAN, a));
      return lg;
    };
    ctx.strokeStyle = fade(0.1);
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = fade(0.42);
    ctx.lineWidth = 1.1;
    ctx.stroke();
    this.floor = c;
    this.floorH = h;
  }

  private buildSun(): void {
    const R = this.sunR, d = this.dpr;
    const side = (R * 2 + 4) * d;
    const [disc, dctx] = canvas2d(side, side);
    dctx.scale(d, d);
    const g = dctx.createLinearGradient(0, 2, 0, 2 + R * 2);
    g.addColorStop(0, '#ffd45e');
    g.addColorStop(0.28, '#ffa052');
    g.addColorStop(0.52, '#ff5f98');
    g.addColorStop(0.76, '#f23bd4');
    g.addColorStop(1, '#8f45ff');
    dctx.fillStyle = g;
    dctx.beginPath();
    dctx.arc(R + 2, R + 2, R, 0, TAU);
    dctx.fill();
    // soft inner highlight
    const hl = dctx.createRadialGradient(R + 2, R * 0.55, 0, R + 2, R * 0.55, R * 0.9);
    hl.addColorStop(0, 'rgba(255,255,230,0.35)');
    hl.addColorStop(1, 'rgba(255,255,230,0)');
    dctx.globalCompositeOperation = 'source-atop';
    dctx.fillStyle = hl;
    dctx.fillRect(0, 0, R * 2 + 4, R * 2 + 4);
    this.sunDisc = disc;
    // (the sun's bloom is baked into the sky layer)
  }

  private strip(h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, sway: number): Strip {
    const w = this.W + this.margin * 2;
    const [c, ctx] = canvas2d(w * this.dpr, (h + 8) * this.dpr);
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(0, 8); // headroom for rim glow and antennas
    draw(ctx, w, h);
    return { canvas: c, w, h: h + 8, sway };
  }

  /** Mountains stay low in the middle so the sun sits in a valley. */
  private valley(x: number, lo: number, e0: number, e1: number): number {
    const u = Math.abs((x - this.margin) / this.W - 0.5);
    return lo + (1 - lo) * smoothstep(e0, e1, u);
  }

  private ridge(ctx: CanvasRenderingContext2D, w: number, h: number, heights: Float32Array, env: (x: number) => number,
    fillTop: string, fillBot: string, rim: number, rimA: number): void {
    const n = heights.length;
    const step = w / (n - 1);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) { const x = i * step; ctx.lineTo(x, h - heights[i] * h * env(x)); }
    ctx.lineTo(w, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, fillTop);
    g.addColorStop(1, fillBot);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = i * step; const y = h - heights[i] * h * env(x); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.lineJoin = 'round';
    ctx.shadowColor = rgba(rim, 0.9);
    ctx.shadowBlur = 6 * this.dpr;
    ctx.strokeStyle = rgba(rim, rimA);
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private buildStrips(rand: Rand): void {
    const H = this.H;
    const farH = clamp(H * 0.13, 36, 150);
    this.far = this.strip(farH, (ctx, w, h) => {
      const hts = ridgeHeights(Math.ceil(w / 5), rand, 6, 0.5);
      this.ridge(ctx, w, h, hts, (x) => this.valley(x, 0.18, 0.06, 0.34), '#2b0f58', '#150630', CYAN, 0.5);
    }, 0.06);
    const cityH = clamp(H * 0.095, 28, 110);
    const ants: Antenna[] = [];
    this.city = this.strip(cityH, (ctx, w, h) => {
      let x = 0;
      const lit = [rgba(CYAN, 0.6), rgba(0xffd43b, 0.55), rgba(0xff7ad9, 0.55)];
      while (x < w) {
        const bw = range(rand, 9, 34);
        const env = this.valley(x + bw / 2, 0, 0.13, 0.3);
        const bh = h * range(rand, 0.25, 1) * env;
        if (bh > 5) {
          const top = h - bh;
          ctx.fillStyle = '#0d0522';
          ctx.fillRect(x, top, bw, bh);
          ctx.fillStyle = rgba(MAGENTA, 0.55);
          ctx.fillRect(x, top, bw, 1);
          for (let wy = top + 4; wy < h - 3; wy += 5) {
            for (let wx = x + 3; wx < x + bw - 3; wx += 5) {
              if (rand() < 0.2) { ctx.fillStyle = lit[Math.floor(rand() * 3)]; ctx.fillRect(wx, wy, 1.6, 1.6); }
            }
          }
          if (bh > h * 0.55 && rand() < 0.35) {
            const ax = x + bw / 2, ah = range(rand, 5, 11);
            ctx.fillStyle = 'rgba(160,120,220,0.7)';
            ctx.fillRect(ax - 0.5, top - ah, 1, ah);
            ants.push({ x: ax, y: top - ah + 8, ph: rand() * TAU });
          }
        }
        x += bw + range(rand, 1, 7);
      }
    }, 0.12);
    this.antennas = ants;
    const nearH = clamp(H * 0.055, 18, 64);
    this.near = this.strip(nearH, (ctx, w, h) => {
      const hts = ridgeHeights(Math.ceil(w / 6), rand, 4, 0.15);
      this.ridge(ctx, w, h, hts, (x) => this.valley(x, 0.3, 0.05, 0.3), '#0b0418', '#07030f', MAGENTA, 0.75);
    }, 0.25);
  }

  private buildFog(): void {
    const s = 0.5;
    const fh = clamp(this.H * 0.26, 80, 320);
    this.fogH = fh;
    const [fog, fctx] = canvas2d(8, fh * this.dpr * s); // 1-D gradient, stretched on draw
    const fg = fctx.createLinearGradient(0, 0, 0, fog.height);
    fg.addColorStop(0, 'rgba(46,10,82,0)');
    fg.addColorStop(0.42, 'rgba(52,12,88,0.78)');
    fg.addColorStop(0.5, 'rgba(60,14,96,0.95)');
    fg.addColorStop(0.62, 'rgba(26,6,52,0.7)');
    fg.addColorStop(1, 'rgba(12,4,30,0)');
    fctx.fillStyle = fg;
    fctx.fillRect(0, 0, fog.width, fog.height);
    this.fog = fog;
    const [band, bctx] = canvas2d(8, fh * this.dpr * s);
    const bg = bctx.createLinearGradient(0, 0, 0, band.height);
    bg.addColorStop(0, 'rgba(255,59,212,0)');
    bg.addColorStop(0.44, 'rgba(255,59,212,0.2)');
    bg.addColorStop(0.5, 'rgba(255,120,220,0.42)');
    bg.addColorStop(0.56, 'rgba(155,91,255,0.16)');
    bg.addColorStop(1, 'rgba(155,91,255,0)');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, band.width, band.height);
    this.band = band;
  }

  private buildStars(rand: Rand, density: number): void {
    const n = Math.max(24, Math.min(900, Math.round((this.W * this.H) / Math.max(800, density))));
    // Every attribute is random per star, so tint groups can simply be index ranges: 72% white, 14% cyan, 14% pink.
    const st: Stars = {
      n, x: new Float32Array(n), y: new Float32Array(n), s: new Float32Array(n), ph: new Float32Array(n),
      tw: new Float32Array(n), v: new Float32Array(n), a: new Float32Array(n),
      groups: [0, Math.round(n * 0.72), Math.round(n * 0.86), n],
    };
    const speeds = [1.2, 3.5, 7.5];
    for (let k = 0; k < n; k++) {
      const layer = Math.floor(rand() * 3);
      st.x[k] = rand() * this.W;
      st.y[k] = rand() ** 1.25 * this.H * 0.74;
      const size = 0.6 + rand() ** 3 * (layer + 1) * 0.75;
      st.s[k] = size;
      st.ph[k] = rand() * TAU;
      st.tw[k] = range(rand, 0.5, 2.6);
      st.v[k] = speeds[layer] * range(rand, 0.8, 1.2);
      st.a[k] = clamp(0.3 + size * 0.32, 0.3, 1);
    }
    this.stars = st;
  }

  addShootingStar(rand: Rand, hy: number): void {
    if (this.shooting.length >= 3) return;
    const dir = rand() < 0.5 ? -1 : 1;
    const ang = range(rand, 0.3, 0.55);
    const sp = range(rand, 700, 1150);
    this.shooting.push({
      x: range(rand, 0.1, 0.9) * this.W, y: range(rand, 0.03, 0.34) * Math.max(80, hy),
      vx: Math.cos(ang) * sp * dir, vy: Math.sin(ang) * sp, age: 0, life: range(rand, 0.45, 0.85), len: range(rand, 70, 170),
    });
  }

  update(dt: number): void {
    const st = this.stars;
    if (st) {
      for (let k = 0; k < st.n; k++) {
        let x = st.x[k] - st.v[k] * dt;
        if (x < -3) x += this.W + 6;
        st.x[k] = x;
      }
    }
    for (let i = this.shooting.length - 1; i >= 0; i--) {
      const s = this.shooting[i];
      s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.age >= s.life) this.shooting.splice(i, 1);
    }
    this.scroll += dt * 1.05;
  }

  private readonly sunDraw = {
    ctx: null as CanvasRenderingContext2D | null, disc: null as HTMLCanvasElement | null,
    x0: 0, y0: 0, side: 0, t: 0, shTop: Infinity, shSpan: 1,
  };

  /** Rows [a, b) of the sun disc (disc-local CSS px), sliced with a sideways wobble below the shimmer line. */
  private sunBand(a: number, b: number): void {
    const s = this.sunDraw, ctx = s.ctx, disc = s.disc, d = this.dpr;
    if (!ctx || !disc || b - a < 0.25) return;
    const plainEnd = Math.min(b, s.shTop);
    if (plainEnd - a >= 0.25) ctx.drawImage(disc, 0, a * d, s.side * d, (plainEnd - a) * d, s.x0, s.y0 + a, s.side, plainEnd - a);
    for (let y = Math.max(a, s.shTop); y < b; y += 3) {
      const h = Math.min(3, b - y);
      const k = (y - s.shTop) / s.shSpan;
      const off = Math.sin((s.y0 + y) * 0.11 + s.t * 2.4) * (0.4 + k * 1.8);
      ctx.drawImage(disc, 0, y * d, s.side * d, h * d, s.x0 + off, s.y0 + y, s.side, h);
    }
  }

  private drawStrip(ctx: CanvasRenderingContext2D, s: Strip | null, L: StageLayout, swayPx: number): void {
    if (!s) return;
    ctx.drawImage(s.canvas, -this.margin + swayPx * s.sway, L.hy - s.h + 1, s.w, s.h);
  }

  /** Everything behind the actors. `camX` = lateral camera sway (floor units); `shimmer` = heat haze on. */
  draw(ctx: CanvasRenderingContext2D, L: StageLayout, t: number, camX: number, shimmer: boolean, glints: boolean,
    ripples: readonly FloorRipple[]): void {
    const { W, H, hy } = L;
    // --- sky (gradient + nebula + sun bloom, baked)
    if (!this.sky || Math.abs(this.skyHy - hy) > SKY_REBUILD_PX || Math.abs(this.skyCx - L.cx) > SKY_REBUILD_PX || this.skySunR !== this.sunR) {
      this.buildSky(hy, L.cx, L.sunY);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (this.sky) ctx.drawImage(this.sky, 0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    // --- stars
    const st = this.stars;
    if (st) {
      const cols = ['#ffffff', '#9ff8ff', '#ffb8ee'];
      for (let gi = 0; gi < 3; gi++) {
        ctx.fillStyle = cols[gi];
        for (let k = st.groups[gi]; k < st.groups[gi + 1]; k++) {
          const y = st.y[k];
          if (y > hy) continue;
          const a = st.a[k] * (0.5 + 0.5 * Math.sin(t * st.tw[k] + st.ph[k]));
          if (a < 0.04) continue;
          ctx.globalAlpha = a;
          const s = st.s[k];
          ctx.fillRect(st.x[k], y, s, s);
          if (glints && s > 2.1) {
            ctx.globalAlpha = a * 0.45;
            ctx.fillRect(st.x[k] - s * 1.5, y + s * 0.5 - 0.35, s * 4, 0.7);
            ctx.fillRect(st.x[k] + s * 0.5 - 0.35, y - s * 1.5, 0.7, s * 4);
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    // --- shooting stars
    for (const s of this.shooting) {
      if (s.y > hy - 6) continue;
      const k = 1 - s.age / s.life;
      const sp = Math.hypot(s.vx, s.vy);
      const tx = s.x - (s.vx / sp) * s.len, ty = s.y - (s.vy / sp) * s.len;
      const g = ctx.createLinearGradient(s.x, s.y, tx, ty);
      g.addColorStop(0, `rgba(255,255,255,${(0.9 * k).toFixed(3)})`);
      g.addColorStop(0.3, `rgba(160,245,255,${(0.35 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(160,245,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
    // --- sun: the disc drawn band by band (the gaps between bands are the scrolling stripe cut-outs, so
    // no per-frame offscreen layer), with a heat shimmer near the horizon
    const R = this.sunR;
    ctx.globalCompositeOperation = 'source-over';
    const disc = this.sunDisc;
    if (disc) {
      const side = R * 2 + 4;
      const x0 = L.cx - R - 2, y0 = L.sunY - R - 2;
      const bottom = Math.min(side, hy - y0 + 2); // disc rows above the horizon
      if (bottom > 0) {
        const sun = this.sunDraw;
        sun.ctx = ctx; sun.disc = disc; sun.x0 = x0; sun.y0 = y0; sun.side = side; sun.t = t;
        sun.shTop = shimmer ? Math.max(0, bottom - R * 0.7) : Infinity;
        sun.shSpan = Math.max(1, bottom - sun.shTop);
        ctx.globalAlpha = 0.92;
        // Cut-outs start high (the logo covers the sun's middle) and thicken toward the horizon.
        const v0 = 0.1, gap = 0.064;
        const ph = (t * 0.09) % 1;
        let y = 0;
        for (let i = -1; i < 18 && y < bottom; i++) {
          const v = v0 + (i + ph) * gap;
          if (v < v0) continue;
          if (v > 1.02) break;
          const hh = (v - v0) * 0.075 + 0.0015;
          const g0 = 2 + v * R * 2 - hh * R;
          this.sunBand(y, Math.min(g0, bottom));
          y = g0 + hh * R * 2;
        }
        if (y < bottom) this.sunBand(y, bottom);
        ctx.globalAlpha = 1;
      }
    }
    // --- far mountains, city (behind the fog)
    const swayPx = -camX * this.cam.f;
    this.drawStrip(ctx, this.far, L, swayPx);
    this.drawStrip(ctx, this.city, L, swayPx);
    if (this.city && this.antennas.length) {
      ctx.fillStyle = '#ff4a6a';
      for (const a of this.antennas) {
        const on = Math.sin(t * 2.2 + a.ph);
        if (on < 0.55) continue;
        ctx.globalAlpha = (on - 0.55) / 0.45;
        ctx.fillRect(a.x - this.margin + swayPx * this.city.sway - 1, hy - this.city.h + 1 + a.y - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    // --- floor + converging lines: one blit of the pre-rendered layer, sheared by the sway, scaled to the horizon
    const cam = this.cam;
    cam.cx = L.cx; cam.horizonY = hy; cam.floorH = Math.max(1, H - hy); cam.f = 0.5 * Math.max(W, H); cam.camX = camX;
    // rebuilt only on a big horizon move (a moderate vertical scale is exact, it just thickens the lines a bit),
    // or when the vanishing point moves far enough off centre that the sheared layer would show an edge
    const needMargin = floorMarginFor(W, L.cx, cam.f);
    if (!this.floor || Math.abs(cam.floorH / this.floorH - 1) > 0.25 || needMargin > this.floorMargin) {
      this.buildFloor(cam.floorH, needMargin + FLOOR_SLACK);
    }
    if (this.floor) {
      const d = this.dpr, Wc = W + this.floorMargin * 2;
      const sy = cam.floorH / this.floorH;
      const shear = (-camX * cam.f) / this.floorH; // x += shear · (row in the layer)
      ctx.setTransform(d, 0, shear * d, sy * d, (L.cx - Wc / 2) * d, hy * d);
      ctx.drawImage(this.floor, 0, 0, Wc, this.floorH);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }
    this.drawGrid(ctx, W, ripples);
    // --- horizon fog, near hills, glow band
    if (this.fog) ctx.drawImage(this.fog, 0, hy - this.fogH / 2, W, this.fogH);
    this.drawStrip(ctx, this.near, L, swayPx);
    ctx.globalCompositeOperation = 'lighter';
    if (this.band) ctx.drawImage(this.band, 0, hy - this.fogH / 2, W, this.fogH);
    ctx.fillStyle = 'rgba(255,170,240,0.5)';
    ctx.fillRect(0, hy - 0.75, W, 1.5);
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawGrid(ctx: CanvasRenderingContext2D, W: number, ripples: readonly FloorRipple[]): void {
    const cam = this.cam, p = this.pt;
    const zMax = 14, step = 0.25;
    ctx.globalCompositeOperation = 'lighter';
    // rows scrolling toward the viewer (the converging lines are in the floor layer)
    const n = gridRowDepths(this.scroll, step, zMax, this.rowZ);
    for (let i = 0; i < n; i++) {
      const z = this.rowZ[i];
      const y = cam.horizonY + cam.floorH / z;
      const a = clamp(1.5 / z, 0.1, 0.85);
      const w = clamp(2.4 / z, 0.5, 2.4);
      ctx.fillStyle = rgba(MAGENTA, a * 0.2);
      ctx.fillRect(0, y - w * 1.8, W, w * 3.6);
      ctx.fillStyle = rgba(MAGENTA, a);
      ctx.fillRect(0, y - w / 2, W, w);
    }
    // ripples: rings on the floor, projected
    for (const r of ripples) {
      const k = r.age / r.life;
      if (k >= 1) continue;
      const rad = r.size * (0.15 + 0.85 * (1 - (1 - k) ** 2.2));
      for (let ring = 0; ring < 2; ring++) {
        const rr = rad * (ring ? 0.62 : 1);
        ctx.beginPath();
        for (let i = 0; i <= 28; i++) {
          const a = (i / 28) * TAU;
          projectFloor(cam, r.X + Math.cos(a) * rr, Math.max(0.9, r.z + Math.sin(a) * rr), p);
          if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.strokeStyle = rgba(r.color, (1 - k) * (ring ? 0.35 : 0.75));
        ctx.lineWidth = lerp(2.6, 0.8, k);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  destroy(): void {
    for (const c of [this.sky, this.floor, this.sunDisc, this.fog, this.band,
      this.far?.canvas ?? null, this.city?.canvas ?? null, this.near?.canvas ?? null]) free(c);
    this.sky = this.floor = this.sunDisc = this.fog = this.band = null;
    this.sunDraw.ctx = null;
    this.sunDraw.disc = null;
    this.far = this.city = this.near = null;
    this.stars = null;
    this.antennas = [];
    this.shooting.length = 0;
    this.skyHy = this.skyCx = this.skySunR = -1;
    this.floorH = 0;
    this.floorMargin = 0;
  }
}
