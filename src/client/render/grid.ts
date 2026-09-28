// Geometry-Wars style spring-mass warp grid in world space.
// Displacement field on a regular lattice; neighbor coupling (discrete wave equation) + weak anchor + damping.
// Only a window around the camera is simulated and drawn each frame.
import type { Graphics } from 'pixi.js';
import { GRID_COLOR, GRID_HOT, GRID_MAJOR } from './palette';

const K_NEIGHBOR = 85;
const K_ANCHOR = 7;
const DAMP = 3.2;
const STEP = 1 / 60;

export class SpringGrid {
  spacing: number;
  /** Line colours (v0.3 M4: rift biomes retint the grid; default = the arena look). */
  colors = { minor: GRID_COLOR, major: GRID_MAJOR, hot: GRID_HOT };
  cols = 0; rows = 0;
  private dx!: Float32Array; private dy!: Float32Array;
  private vx!: Float32Array; private vy!: Float32Array;
  private acc = 0;
  private w: number; private h: number;
  /** Bounding window [c0,r0,c1,r1] last simulated (empty until the first step). */
  private win = [1, 1, 0, 0];

  constructor(worldW: number, worldH: number, spacing: number) {
    this.w = worldW; this.h = worldH; this.spacing = spacing;
    this.alloc();
  }

  setSpacing(s: number): void {
    if (s === this.spacing) return;
    this.spacing = s;
    this.alloc();
  }

  resize(worldW: number, worldH: number): void {
    this.w = worldW; this.h = worldH; this.alloc();
  }

  private alloc(): void {
    this.cols = Math.ceil(this.w / this.spacing) + 1;
    this.rows = Math.ceil(this.h / this.spacing) + 1;
    const n = this.cols * this.rows;
    this.dx = new Float32Array(n); this.dy = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.win = [1, 1, 0, 0];
  }

  /**
   * Radial velocity kick. strength > 0 pushes outward, < 0 pulls inward. Only cells inside the window
   * last simulated by step() are kicked: cells outside are never integrated or damped, so velocity
   * added there would pile up (a black hole off-screen keeps pulling every frame) and jolt the grid
   * when the camera arrives.
   */
  impulse(x: number, y: number, radius: number, strength: number): void {
    const s = this.spacing, w = this.win;
    const c0 = Math.max(w[0], Math.floor((x - radius) / s)), c1 = Math.min(w[2], Math.ceil((x + radius) / s));
    const r0 = Math.max(w[1], Math.floor((y - radius) / s)), r1 = Math.min(w[3], Math.ceil((y + radius) / s));
    if (c0 > c1 || r0 > r1) return;
    const r2 = radius * radius;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * this.cols + c;
        const px = c * s + this.dx[i] - x, py = r * s + this.dy[i] - y;
        const d2 = px * px + py * py;
        if (d2 >= r2 || d2 < 1) continue;
        const d = Math.sqrt(d2);
        const f = strength * (1 - d / radius);
        this.vx[i] += (px / d) * f;
        this.vy[i] += (py / d) * f;
      }
    }
  }

  step(dt: number, x0: number, y0: number, x1: number, y1: number): void {
    const s = this.spacing, C = this.cols;
    const c0 = Math.max(1, Math.floor(x0 / s)), c1 = Math.min(C - 2, Math.ceil(x1 / s));
    const r0 = Math.max(1, Math.floor(y0 / s)), r1 = Math.min(this.rows - 2, Math.ceil(y1 / s));
    this.win[0] = c0; this.win[1] = r0; this.win[2] = c1; this.win[3] = r1;
    this.acc = Math.min(this.acc + dt, STEP * 3);
    const dx = this.dx, dy = this.dy, vx = this.vx, vy = this.vy;
    const lim = s * 0.85;
    const damp = Math.exp(-DAMP * STEP);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (let r = r0; r <= r1; r++) {
        let i = r * C + c0;
        for (let c = c0; c <= c1; c++, i++) {
          const ax = K_NEIGHBOR * (dx[i - 1] + dx[i + 1] + dx[i - C] + dx[i + C] - 4 * dx[i]) - K_ANCHOR * dx[i];
          const ay = K_NEIGHBOR * (dy[i - 1] + dy[i + 1] + dy[i - C] + dy[i + C] - 4 * dy[i]) - K_ANCHOR * dy[i];
          vx[i] = (vx[i] + ax * STEP) * damp;
          vy[i] = (vy[i] + ay * STEP) * damp;
        }
      }
      for (let r = r0; r <= r1; r++) {
        let i = r * C + c0;
        for (let c = c0; c <= c1; c++, i++) {
          let x = dx[i] + vx[i] * STEP, y = dy[i] + vy[i] * STEP;
          if (x > lim) x = lim; else if (x < -lim) x = -lim;
          if (y > lim) y = lim; else if (y < -lim) y = -lim;
          dx[i] = x; dy[i] = y;
        }
      }
    }
  }

  /** Draw the lattice inside the world rect into `g` (caller clears g). */
  draw(g: Graphics, x0: number, y0: number, x1: number, y1: number): void {
    const s = this.spacing, C = this.cols;
    const c0 = Math.max(0, Math.floor(x0 / s)), c1 = Math.min(C - 1, Math.ceil(x1 / s));
    const r0 = Math.max(0, Math.floor(y0 / s)), r1 = Math.min(this.rows - 1, Math.ceil(y1 / s));
    const dx = this.dx, dy = this.dy;
    const major = 4;
    // minor lines
    for (let pass = 0; pass < 2; pass++) {
      const wantMajor = pass === 1;
      for (let r = r0; r <= r1; r++) {
        if ((r % major === 0) !== wantMajor) continue;
        let i = r * C + c0;
        g.moveTo(c0 * s + dx[i], r * s + dy[i]);
        for (let c = c0 + 1; c <= c1; c++) { i++; g.lineTo(c * s + dx[i], r * s + dy[i]); }
      }
      for (let c = c0; c <= c1; c++) {
        if ((c % major === 0) !== wantMajor) continue;
        let i = r0 * C + c;
        g.moveTo(c * s + dx[i], r0 * s + dy[i]);
        for (let r = r0 + 1; r <= r1; r++) { i += C; g.lineTo(c * s + dx[i], r * s + dy[i]); }
      }
      if (wantMajor) g.stroke({ width: 1.6, color: this.colors.major, alpha: 0.42 });
      else g.stroke({ width: 1, color: this.colors.minor, alpha: 0.5 });
    }
    // hot segments where the grid is strongly displaced
    const hot2 = (s * 0.1) * (s * 0.1);
    let any = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * C + c;
        const m = dx[i] * dx[i] + dy[i] * dy[i];
        if (m < hot2) continue;
        const px = c * s + dx[i], py = r * s + dy[i];
        if (c < c1) { g.moveTo(px, py); g.lineTo((c + 1) * s + dx[i + 1], r * s + dy[i + 1]); any = true; }
        if (r < r1) { g.moveTo(px, py); g.lineTo(c * s + dx[i + C], (r + 1) * s + dy[i + C]); any = true; }
      }
    }
    if (any) g.stroke({ width: 2, color: this.colors.hot, alpha: 0.75 });
  }
}
