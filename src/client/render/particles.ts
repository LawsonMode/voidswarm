// Pooled additive particle system on a single Pixi v8 ParticleContainer (one atlas source).
import { Particle, ParticleContainer, type Texture } from 'pixi.js';

export const P_ORIENT = 1; // rotate to velocity
export const P_STRETCH = 2; // scaleX grows with speed
export const P_SPIN = 4; // spin by `spin` rad/s

export interface SpawnOpts {
  tex: Texture;
  x: number; y: number;
  vx?: number; vy?: number;
  life: number;
  color: number;
  s0?: number; s1?: number;
  alpha?: number;
  drag?: number; // per-second velocity damping factor (0 = none)
  flags?: number;
  rot?: number;
  spin?: number;
  sy?: number; // Y scale multiplier (for streak thickness)
}

export class Particles {
  readonly pc: ParticleContainer;
  private list: Particle[];
  private free: Particle[] = [];
  private cap: number;
  private vx: Float32Array; private vy: Float32Array;
  private life: Float32Array; private max: Float32Array;
  private s0: Float32Array; private s1: Float32Array;
  private a0: Float32Array; private drag: Float32Array;
  private flags: Uint8Array; private spin: Float32Array; private sy: Float32Array;
  private lastCount = 0;

  constructor(baseTex: Texture, cap: number) {
    this.cap = cap;
    this.pc = new ParticleContainer({
      texture: baseTex,
      dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
    });
    this.pc.blendMode = 'add';
    this.list = this.pc.particleChildren as Particle[];
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap);
    this.a0 = new Float32Array(cap); this.drag = new Float32Array(cap);
    this.flags = new Uint8Array(cap); this.spin = new Float32Array(cap); this.sy = new Float32Array(cap);
    for (let i = 0; i < 256; i++) this.free.push(new Particle({ texture: baseTex, anchorX: 0.5, anchorY: 0.5 }));
  }

  get count(): number { return this.list.length; }

  spawn(o: SpawnOpts): void {
    const i = this.list.length;
    if (i >= this.cap) return;
    const p = this.free.pop() ?? new Particle({ texture: o.tex, anchorX: 0.5, anchorY: 0.5 });
    p.texture = o.tex;
    p.x = o.x; p.y = o.y;
    p.tint = o.color;
    p.alpha = o.alpha ?? 1;
    p.rotation = o.rot ?? 0;
    this.list.push(p);
    this.vx[i] = o.vx ?? 0; this.vy[i] = o.vy ?? 0;
    this.life[i] = o.life; this.max[i] = o.life;
    this.s0[i] = o.s0 ?? 1; this.s1[i] = o.s1 ?? 0;
    this.a0[i] = o.alpha ?? 1; this.drag[i] = o.drag ?? 0;
    this.flags[i] = o.flags ?? 0; this.spin[i] = o.spin ?? 0; this.sy[i] = o.sy ?? 1;
    p.scaleX = p.scaleY = this.s0[i];
  }

  update(dt: number): void {
    const L = this.list;
    let n = L.length;
    for (let i = 0; i < n; i++) {
      let life = this.life[i] - dt;
      if (life <= 0) {
        // swap-remove
        const last = n - 1;
        const dead = L[i];
        if (i !== last) {
          L[i] = L[last];
          this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
          this.life[i] = this.life[last]; this.max[i] = this.max[last];
          this.s0[i] = this.s0[last]; this.s1[i] = this.s1[last];
          this.a0[i] = this.a0[last]; this.drag[i] = this.drag[last];
          this.flags[i] = this.flags[last]; this.spin[i] = this.spin[last]; this.sy[i] = this.sy[last];
        }
        L.pop();
        this.free.push(dead);
        n--; i--;
        continue;
      }
      this.life[i] = life;
      const p = L[i];
      const d = this.drag[i];
      if (d > 0) { const k = Math.exp(-d * dt); this.vx[i] *= k; this.vy[i] *= k; }
      const vx = this.vx[i], vy = this.vy[i];
      p.x += vx * dt; p.y += vy * dt;
      const t = 1 - life / this.max[i];
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const f = this.flags[i];
      if (f & P_ORIENT) p.rotation = Math.atan2(vy, vx);
      else if (f & P_SPIN) p.rotation += this.spin[i] * dt;
      if (f & P_STRETCH) {
        const sp = Math.sqrt(vx * vx + vy * vy);
        p.scaleX = s * (0.35 + Math.min(2.2, sp / 350));
        p.scaleY = s * this.sy[i];
      } else {
        p.scaleX = s; p.scaleY = s * this.sy[i];
      }
      // fade: quick in, ease out
      const fade = life / this.max[i];
      p.alpha = this.a0[i] * (fade < 1 ? fade * (2 - fade) : 1);
    }
    if (n !== this.lastCount) { this.pc.update(); this.lastCount = n; }
  }

  clear(): void {
    const L = this.list;
    while (L.length) this.free.push(L.pop()!);
    this.pc.update();
    this.lastCount = 0;
  }
}

/**
 * Per-frame "immediate" sprite list on a ParticleContainer (projectiles, gems): call begin(), put() each
 * visible thing, end(). Particle objects are pooled and reused, so no per-frame allocation.
 */
export class SpriteBatch {
  readonly pc: ParticleContainer;
  private pool: Particle[] = [];
  private list: Particle[];
  private n = 0;
  private lastCount = -1;
  constructor(baseTex: Texture, blend: 'add' | 'normal' = 'add') {
    this.pc = new ParticleContainer({
      texture: baseTex,
      dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
    });
    this.pc.blendMode = blend;
    this.list = this.pc.particleChildren as Particle[];
    this.baseTex = baseTex;
  }
  private baseTex: Texture;
  begin(): void { this.n = 0; }
  put(tex: Texture, x: number, y: number, rot: number, sx: number, sy: number, color: number, alpha: number): void {
    let p = this.pool[this.n];
    if (!p) { p = new Particle({ texture: this.baseTex, anchorX: 0.5, anchorY: 0.5 }); this.pool.push(p); }
    this.n++;
    p.texture = tex; p.x = x; p.y = y; p.rotation = rot; p.scaleX = sx; p.scaleY = sy; p.tint = color; p.alpha = alpha;
  }
  end(): void {
    const L = this.list;
    if (L.length !== this.n) {
      L.length = 0;
      for (let i = 0; i < this.n; i++) L.push(this.pool[i]);
    }
    if (this.n !== this.lastCount) { this.pc.update(); this.lastCount = this.n; }
  }
}
