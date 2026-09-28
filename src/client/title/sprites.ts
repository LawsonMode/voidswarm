// Canvas2D sprites for the Title attract scene: the real class hull outlines (render/shapes.ts, read-only)
// in the in-game neon style, and the swarm's drone diamond. Each sprite is drawn once per
// class / colour / size into a small canvas (glow baked in), so a frame is just drawImage calls.
import { ENGINEER_ANTENNA, TECH_NODES, hullPolys, polyExtent, type Poly } from '../render/shapes';
import { ENEMY_COLORS, brighten, darken } from '../render/palette';
import type { ShipClassId } from '../../shared/types';

/** 0xRRGGBB → CSS colour (rgba when a < 1). */
export function rgba(c: number, a = 1): string {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.max(0, a).toFixed(3)})`;
}

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Half the sprite's side, CSS px (draw at −half … +half around the ship origin). */
  half: number;
}

function polyPath(ctx: CanvasRenderingContext2D, polys: readonly Poly[], s: number): void {
  ctx.beginPath();
  for (const p of polys) {
    ctx.moveTo(p[0] * s, p[1] * s);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * s, p[i + 1] * s);
    ctx.closePath();
  }
}

/** The in-game neonPolys look: dark fill, wide faint halo, crisp outline, hot inner line. */
function neonStroke(ctx: CanvasRenderingContext2D, color: number, w: number, dpr: number, fillA: number): void {
  ctx.fillStyle = rgba(darken(color, 0.74), fillA);
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = rgba(color, 0.9);
  ctx.shadowBlur = w * 3.2 * dpr;
  ctx.strokeStyle = rgba(color, 0.22);
  ctx.lineWidth = w * 3;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rgba(color);
  ctx.lineWidth = w;
  ctx.stroke();
  ctx.strokeStyle = rgba(brighten(color, 0.75), 0.9);
  ctx.lineWidth = w * 0.38;
  ctx.stroke();
}

const diamond = (cx: number, cy: number, s: number): Poly => [cx + s, cy, cx, cy + s * 0.7, cx - s, cy, cx, cy - s * 0.7];

export class SpriteCache {
  private readonly map = new Map<string, Sprite>();

  constructor(private readonly dpr: number) {}

  get size(): number { return this.map.size; }

  private make(key: string, half: number, draw: (ctx: CanvasRenderingContext2D) => void): Sprite {
    const hit = this.map.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    const side = Math.max(2, Math.ceil(half * 2 * this.dpr));
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, half * this.dpr, half * this.dpr);
      draw(ctx);
    }
    const s: Sprite = { canvas, half };
    this.map.set(key, s);
    return s;
  }

  /** Class hull at radius `r` CSS px, facing +x, in `color` (a team colour). */
  ship(cls: ShipClassId, color: number, r: number): Sprite {
    const rr = Math.max(4, Math.round(r));
    const polys = hullPolys(cls);
    const w = Math.max(1.2, Math.min(3.2, rr * 0.11));
    const half = Math.ceil(Math.max(polyExtent(polys), 1.3) * rr + w * 4 + 2);
    return this.make(`s|${cls}|${color}|${rr}`, half, (ctx) => {
      polyPath(ctx, polys, rr);
      neonStroke(ctx, color, w, this.dpr, 0.85);
      const detail = rgba(brighten(color, 0.4), 0.85);
      ctx.strokeStyle = detail;
      ctx.lineWidth = Math.max(0.8, w * 0.55);
      ctx.beginPath();
      if (cls === 'brute') {
        // keel + prow ram (the class's plate lines, simplified)
        ctx.moveTo(0.5 * rr, 0); ctx.lineTo(-0.9 * rr, 0);
        ctx.moveTo(1.2 * rr, 0); ctx.lineTo(0.72 * rr, 0.34 * rr); ctx.lineTo(0.5 * rr, 0); ctx.lineTo(0.72 * rr, -0.34 * rr); ctx.closePath();
        ctx.moveTo(0.62 * rr, 0.52 * rr); ctx.lineTo(0.3 * rr, 0.5 * rr);
        ctx.moveTo(0.62 * rr, -0.52 * rr); ctx.lineTo(0.3 * rr, -0.5 * rr);
      } else if (cls === 'tech') {
        ctx.moveTo(1.45 * rr, 0); ctx.lineTo(-1.1 * rr, 0);
        ctx.moveTo(0.25 * rr, 0.3 * rr); ctx.lineTo(-0.2 * rr, 0); ctx.lineTo(0.25 * rr, -0.3 * rr);
      } else {
        for (const x of [0.15, -0.3]) for (const sy of [1, -1]) { ctx.moveTo(x * rr, 0.36 * sy * rr); ctx.lineTo(x * rr, 0.62 * sy * rr); }
        ctx.moveTo(-0.55 * rr, 0.1 * rr); ctx.lineTo(ENGINEER_ANTENNA[0] * rr, ENGINEER_ANTENNA[1] * rr);
      }
      ctx.stroke();
      if (cls === 'tech') {
        // floating emitter nodes
        const node = brighten(color, 0.4);
        const nodes = TECH_NODES.map(([x, y], i) => diamond(x, y, i < 2 ? 0.17 : 0.12));
        polyPath(ctx, nodes, rr);
        neonStroke(ctx, node, Math.max(0.8, w * 0.6), this.dpr, 0.7);
      } else if (cls === 'engineer') {
        ctx.fillStyle = rgba(brighten(color, 0.6));
        ctx.beginPath();
        ctx.arc(ENGINEER_ANTENNA[0] * rr, ENGINEER_ANTENNA[1] * rr, Math.max(1.4, rr * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
      // cockpit spark
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc((cls === 'brute' ? 0.2 : 0.4) * rr, 0, Math.max(1.3, rr * 0.09), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** The swarm's drone: nested neon diamonds (render/shapes.ts enemyBody 'drone'), radius `r` CSS px. */
  drone(r: number): Sprite {
    const rr = Math.max(3, Math.round(r));
    const color = ENEMY_COLORS.drone;
    const w = Math.max(1, Math.min(2.4, rr * 0.13));
    const half = Math.ceil(rr + w * 4 + 2);
    return this.make(`d|${rr}`, half, (ctx) => {
      polyPath(ctx, [[1, 0, 0, 0.62, -1, 0, 0, -0.62], [0.45, 0, 0, 0.28, -0.45, 0, 0, -0.28]], rr);
      neonStroke(ctx, color, w, this.dpr, 0.3);
    });
  }

  /** Free the backing stores now (GPU memory), rather than waiting for GC. */
  clear(): void {
    for (const s of this.map.values()) { s.canvas.width = 0; s.canvas.height = 0; }
    this.map.clear();
  }
}
