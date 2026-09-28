// Foreground cast of the Title attract scene: ships (real hulls, team colours, engine trails) crossing the
// screen, mini-dogfights (tracers / plasma / rockets / seekers ending in an explosion + grid ripple), a
// drone swarm chasing a pilot into a Pulse Nova, and the set-piece: a Juggernaut carrying three Arcanist
// laser turrets whose beams resonate (×1.5 per extra laser) into one lance. Pools everything it can.
import { brighten, ENEMY_COLORS, mix } from '../render/palette';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { TEAM_COLORS } from '../../shared/data/teams';
import { TURRET_BUBBLE_RADIUS } from '../../shared/constants';
import { capitalScale, turretOffset } from '../../shared/sim/world';
import type { ShipClassId } from '../../shared/types';
import { clamp, lerp, pick, range, type Rand } from './sceneMath';
import { rgba, type Sprite, type SpriteCache } from './sprites';

const TAU = Math.PI * 2;
const CLASSES: readonly ShipClassId[] = ['brute', 'tech', 'engineer'];
const TRAIL_N = 16;
const DRONE = ENEMY_COLORS.drone;

export interface FocusRect { left: number; top: number; right: number; bottom: number }

/** What the cast needs from the scene. */
export interface CastHost {
  readonly W: number;
  readonly H: number;
  readonly hy: number;
  /** Size scale for the stage (1 at a 900 px short side). */
  readonly S: number;
  readonly dpr: number;
  /** The title column plus the logo: the action stays out of it. */
  readonly focus: FocusRect | null;
  /** The glass panel: only far, faint flybys may pass behind it. */
  readonly panel: FocusRect | null;
  readonly sprites: SpriteCache;
  readonly rand: Rand;
  /** Quality level 0..2. */
  readonly quality: number;
  /** A ripple on the grid floor under screen point (x, y). */
  ripple(x: number, y: number, size: number, color: number): void;
}

// ---------------------------------------------------------------------------------------------
// Particles (struct of arrays, fixed capacity)
// ---------------------------------------------------------------------------------------------

export class Particles {
  n = 0;
  private cap: number;
  private readonly x: Float32Array; private readonly y: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly size: Float32Array; private readonly drag: Float32Array;
  private readonly col: string[];

  constructor(private readonly max: number) {
    this.cap = max;
    this.x = new Float32Array(max); this.y = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.size = new Float32Array(max); this.drag = new Float32Array(max);
    this.col = new Array<string>(max).fill('#fff');
  }

  setCap(c: number): void { this.cap = Math.max(0, Math.min(this.max, c)); }

  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, drag = 1.6): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.age[i] = 0; this.life[i] = life; this.size[i] = size; this.drag[i] = drag; this.col[i] = color;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        const j = --this.n; // swap-remove
        this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
        this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j]; this.drag[i] = this.drag[j]; this.col[i] = this.col[j];
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k; this.vy[i] *= k;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      i++;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.n) return;
    ctx.globalCompositeOperation = 'lighter';
    let last = '';
    for (let i = 0; i < this.n; i++) {
      const k = 1 - this.age[i] / this.life[i];
      const c = this.col[i];
      if (c !== last) { ctx.fillStyle = c; last = c; }
      ctx.globalAlpha = k;
      const s = this.size[i] * (0.4 + 0.6 * k);
      ctx.fillRect(this.x[i] - s / 2, this.y[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  clear(): void { this.n = 0; }
}

// ---------------------------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------------------------

export class Craft {
  x = 0; y = 0; vx = 0; vy = 0; angle = 0;
  alive = true;
  alpha = 1;
  readonly trail = new Float32Array(TRAIL_N * 2);
  trailN = 0;
  private trailHead = 0;
  private trailAcc = 0;
  readonly c0: string;
  readonly c1: string;
  readonly sprite: Sprite;
  readonly seed: number;
  /** Flame length multiplier (the set-piece host burns hotter). */
  flame = 1;

  constructor(readonly cls: ShipClassId, readonly color: number, readonly r: number, readonly depth: number, sprites: SpriteCache, rand: Rand) {
    this.sprite = sprites.ship(cls, color, r);
    this.c0 = rgba(color, 0);
    this.c1 = rgba(brighten(color, 0.25), 1);
    this.seed = rand() * 100;
  }

  place(x: number, y: number, vx: number, vy: number, angle = Math.atan2(vy, vx)): void {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy; this.angle = angle;
  }

  private sternX(): number { return this.x - Math.cos(this.angle) * this.r * 1.05; }
  private sternY(): number { return this.y - Math.sin(this.angle) * this.r * 1.05; }

  tickTrail(dt: number): void {
    this.trailAcc += dt;
    if (this.trailAcc < 1 / 40) return;
    this.trailAcc = 0;
    this.trail[this.trailHead * 2] = this.sternX();
    this.trail[this.trailHead * 2 + 1] = this.sternY();
    this.trailHead = (this.trailHead + 1) % TRAIL_N;
    if (this.trailN < TRAIL_N) this.trailN++;
  }

  drawTrail(ctx: CanvasRenderingContext2D, glow: boolean): void {
    if (this.trailN < 2 || !this.alive) return;
    const oldest = (this.trailHead - this.trailN + TRAIL_N) % TRAIL_N;
    const ox = this.trail[oldest * 2], oy = this.trail[oldest * 2 + 1];
    const sx = this.sternX(), sy = this.sternY();
    if (Math.abs(sx - ox) + Math.abs(sy - oy) < 2) return;
    const g = ctx.createLinearGradient(ox, oy, sx, sy);
    g.addColorStop(0, this.c0);
    g.addColorStop(1, this.c1);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    for (let k = 1; k < this.trailN; k++) {
      const i = (oldest + k) % TRAIL_N;
      ctx.lineTo(this.trail[i * 2], this.trail[i * 2 + 1]);
    }
    ctx.lineTo(sx, sy);
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (glow) {
      ctx.globalAlpha = 0.16 * this.alpha;
      ctx.lineWidth = this.r * 1.2;
      ctx.stroke();
    }
    ctx.globalAlpha = 0.55 * this.alpha;
    ctx.lineWidth = this.r * 0.36;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  draw(ctx: CanvasRenderingContext2D, dpr: number, t: number): void {
    if (!this.alive) return;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    ctx.setTransform(c * dpr, s * dpr, -s * dpr, c * dpr, this.x * dpr, this.y * dpr);
    const r = this.r;
    // engine flame(s), additive
    ctx.globalCompositeOperation = 'lighter';
    const len = r * (0.55 + 0.22 * Math.sin(t * 43 + this.seed) + 0.12 * Math.sin(t * 71 + this.seed * 2)) * this.flame;
    const flames: readonly [number, number, number][] = this.cls === 'brute'
      ? [[-1.12, 0.43, 0.12], [-1.12, -0.43, 0.12]]
      : this.cls === 'tech' ? [[-1.08, 0, 0.14]] : [[-0.9, 0, 0.17]];
    for (const [fx, fy, hw] of flames) {
      ctx.globalAlpha = 0.6 * this.alpha;
      ctx.fillStyle = this.c1;
      ctx.beginPath();
      ctx.moveTo(fx * r, (fy - hw) * r); ctx.lineTo(fx * r - len, fy * r); ctx.lineTo(fx * r, (fy + hw) * r);
      ctx.fill();
      ctx.globalAlpha = 0.85 * this.alpha;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(fx * r, (fy - hw * 0.5) * r); ctx.lineTo(fx * r - len * 0.5, fy * r); ctx.lineTo(fx * r, (fy + hw * 0.5) * r);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.alpha;
    const h = this.sprite.half;
    ctx.drawImage(this.sprite.canvas, -h, -h, h * 2, h * 2);
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

/**
 * A straight crossing with a gentle weave: horizontal (x0 → x1 along y0), or with `vertical` set, down or up a
 * side column (x0 → x1 are y values, y0 is the column's x).
 */
class Cross {
  constructor(readonly x0: number, readonly x1: number, readonly y0: number, readonly dur: number,
    readonly amp: number, readonly freq: number, readonly ph: number, readonly vertical = false) {}
  get dir(): number { return Math.sign(this.x1 - this.x0) || 1; }
  get speed(): number { return Math.abs(this.x1 - this.x0) / this.dur; }
  /** Scene time at which the path reaches screen x (horizontal paths). */
  timeAtX(x: number): number { return ((x - this.x0) / (this.x1 - this.x0)) * this.dur; }
  apply(c: Craft, t: number): void {
    const v = (this.x1 - this.x0) / this.dur;
    const w = TAU * this.freq;
    const along = this.x0 + v * t, across = this.y0 + this.amp * Math.sin(this.ph + w * t);
    const vAcross = this.amp * w * Math.cos(this.ph + w * t);
    if (this.vertical) c.place(across, along, vAcross, v);
    else c.place(along, across, v, vAcross);
  }
}

/** A flyby lane: a horizontal band [a, b] of y, or (vertical) a side column [a, b] of x. */
interface Lane { a: number; b: number; vertical: boolean; faint: boolean }

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

type ShotKind = 'tracer' | 'plasma' | 'bigplasma' | 'rivet' | 'rocket' | 'seeker';
interface Shot {
  kind: ShotKind; x: number; y: number; vx: number; vy: number; age: number; life: number;
  color: number; css: string; target: Craft | null; kill: boolean; size: number; smoke: number;
  onKill: ((s: Shot) => void) | null;
}

interface Ring { x: number; y: number; r: number; age: number; life: number; css: string; w: number }

interface Drone { x: number; y: number; vx: number; vy: number; spin: number; ox: number; oy: number; alive: boolean }

// ---------------------------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------------------------

interface Beat { update(dt: number): boolean; drawUnder?(ctx: CanvasRenderingContext2D): void; drawOver?(ctx: CanvasRenderingContext2D): void }

export class Cast {
  readonly particles = new Particles(640);
  private readonly crafts: Craft[] = [];
  private readonly beats: Beat[] = [];
  private readonly shots: Shot[] = [];
  private readonly shotPool: Shot[] = [];
  private readonly rings: Ring[] = [];
  private flybys = 0;
  private t = 0;

  constructor(private readonly host: CastHost) {}

  get craftCount(): number { return this.crafts.length; }

  clear(): void {
    this.crafts.length = 0;
    this.beats.length = 0;
    this.shots.length = 0;
    this.rings.length = 0;
    this.particles.clear();
    this.flybys = 0;
  }

  setQuality(q: number): void { this.particles.setCap([160, 340, 640][clamp(q, 0, 2)]); }

  // ----------------------------------------------------------------------------- helpers
  private margin(r: number): number { return r * 3 + 40; }

  private team(exclude = -1): number {
    let i = Math.floor(this.host.rand() * TEAM_COLORS.length);
    if (i === exclude) i = (i + 1 + Math.floor(this.host.rand() * (TEAM_COLORS.length - 1))) % TEAM_COLORS.length;
    return i;
  }

  /** A ship at `depth` (0 far … 1 near); `radius` overrides the depth-scaled class radius (CSS px). */
  private craft(cls: ShipClassId, color: number, depth: number, radius = 0): Craft {
    const r = radius || SHIP_CLASSES[cls].base.radius * this.host.S * lerp(0.62, 1.18, depth);
    const c = new Craft(cls, color, r, depth, this.host.sprites, this.host.rand);
    c.alpha = lerp(0.5, 1, depth);
    // keep draw order back → front
    let i = this.crafts.length;
    while (i > 0 && this.crafts[i - 1].depth > depth) i--;
    this.crafts.splice(i, 0, c);
    return c;
  }

  private drop(c: Craft): void {
    const i = this.crafts.indexOf(c);
    if (i >= 0) this.crafts.splice(i, 1);
  }

  private sides(): { l: number; r: number } {
    const f = this.host.focus;
    return f ? { l: Math.max(0, f.left), r: Math.max(0, this.host.W - f.right) } : { l: this.host.W * 0.3, r: this.host.W * 0.3 };
  }

  /**
   * The roomier band (top / bottom of the focus rect): its centre y and height. `preferBottom` takes the band
   * over the grid floor unless the top one is much bigger (the top band is where the sun is).
   */
  private widestBand(preferBottom = false): { y: number; room: number } {
    const { H } = this.host, f = this.host.focus;
    if (!f) return { y: H * 0.85, room: H * 0.3 };
    const top = Math.max(0, f.top), bottom = Math.max(0, H - f.bottom);
    const useTop = preferBottom ? top > bottom * 1.25 : top >= bottom;
    return useTop ? { y: top / 2, room: top } : { y: f.bottom + bottom / 2, room: bottom };
  }

  /**
   * A lane y with at least `room` px clear of the focus rect (top / bottom band), or null. `preferBottom`
   * takes the bottom band whenever it fits.
   */
  private bandLane(room: number, preferBottom = false): number | null {
    const { H } = this.host, f = this.host.focus, rand = this.host.rand;
    if (!f) return range(rand, 0.1, 0.9) * H;
    const bands: [number, number][] = [];
    if (f.top >= room) bands.push([0, f.top]);
    if (H - f.bottom >= room) bands.push([f.bottom, H]);
    if (!bands.length) return null;
    const [a, b] = preferBottom ? bands[bands.length - 1] : pick(rand, bands);
    return lerp(a, b, range(rand, 0.4, 0.6));
  }

  /**
   * Where an ambient flyby may fly, for a ship of radius r weaving ±amp: the bands above and below the title
   * column, else (short / landscape screens) the side columns at least 120 px wide, flown vertically. Far
   * ships (depth < 0.2) may instead cross behind the glass panel, faintly: never through the logo or tagline.
   */
  private flybyLanes(r: number, amp: number, depth: number): Lane[] {
    const { W, H } = this.host, f = this.host.focus, p = this.host.panel;
    if (!f) return [{ a: H * 0.05, b: H * 0.95, vertical: false, faint: false }];
    const pad = r * 1.4 + amp + 4;
    const lanes: Lane[] = [];
    if (f.top - pad >= pad) lanes.push({ a: pad, b: f.top - pad, vertical: false, faint: false });
    if (H - pad >= f.bottom + pad) lanes.push({ a: f.bottom + pad, b: H - pad, vertical: false, faint: false });
    if (!lanes.length) {
      if (f.left >= 120) lanes.push({ a: pad, b: Math.max(pad, f.left - pad), vertical: true, faint: false });
      if (W - f.right >= 120) lanes.push({ a: Math.min(W - pad, f.right + pad), b: W - pad, vertical: true, faint: false });
    }
    if (p && depth < 0.2 && p.bottom - p.top > pad * 2 + 20 && (!lanes.length || this.host.rand() < 0.3)) {
      return [{ a: Math.max(0, p.top) + pad, b: Math.min(H, p.bottom) - pad, vertical: false, faint: true }];
    }
    return lanes;
  }

  /**
   * A crossing lane y in [lo, hi], padded by `pad`, clear of the whole title column when there is room above or
   * below it; otherwise (short screens) clear of its head at least (logo, tagline and ticker: from the column's
   * top to the panel's top), so a fight may pass behind the glass panel but never through the wordmark.
   */
  private laneY(lo: number, hi: number, pad: number): number {
    const { rand } = this.host, f = this.host.focus, p = this.host.panel;
    if (!f) return range(rand, lo, hi);
    const pickOutside = (a: number, b: number): number | null => {
      const spans: [number, number][] = [];
      if (a > lo) spans.push([lo, Math.min(a, hi)]);
      if (b < hi) spans.push([Math.max(b, lo), hi]);
      const total = spans.reduce((sum, [x, y]) => sum + Math.max(0, y - x), 0);
      if (!(total > 0)) return null;
      let k = rand() * total;
      for (const [x, y] of spans) {
        const len = Math.max(0, y - x);
        if (k <= len) return x + k;
        k -= len;
      }
      return spans[spans.length - 1][1];
    };
    return pickOutside(f.top - pad, f.bottom + pad)
      ?? pickOutside(f.top - pad, (p ? p.top : f.bottom) + pad)
      ?? range(rand, lo, hi);
  }

  /** x inside the side column ahead of travel (explosions stay off the panel), or null if the column is too narrow. */
  private sideX(dir: number, min = 110): number | null {
    const s = this.sides(), rand = this.host.rand;
    if (dir > 0 ? s.r < min : s.l < min) return null;
    return dir > 0 ? this.host.W - s.r * range(rand, 0.35, 0.65) : s.l * range(rand, 0.35, 0.65);
  }

  private shot(kind: ShotKind, x: number, y: number, ang: number, speed: number, color: number, target: Craft | null, kill: boolean,
    onKill: ((s: Shot) => void) | null = null): void {
    const s = this.shotPool.pop() ?? ({} as Shot);
    const S = this.host.S;
    s.kind = kind; s.x = x; s.y = y; s.vx = Math.cos(ang) * speed; s.vy = Math.sin(ang) * speed;
    s.age = 0; s.life = kind === 'rocket' || kind === 'seeker' ? 1.6 : 0.9; s.color = color;
    s.css = rgba(brighten(color, 0.3)); s.target = target; s.kill = kill; s.smoke = 0; s.onKill = onKill;
    s.size = (kind === 'bigplasma' ? 7 : kind === 'plasma' ? 4 : kind === 'rivet' ? 1.6 : kind === 'rocket' ? 3 : kind === 'seeker' ? 2.4 : 2.2) * S;
    this.shots.push(s);
  }

  sparks(x: number, y: number, color: number, n: number, speed: number): void {
    const rand = this.host.rand, S = this.host.S;
    const c1 = rgba(brighten(color, 0.35)), c2 = '#ffffff';
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, v = speed * (0.3 + rand()) * S;
      this.particles.spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, range(rand, 0.25, 0.6), range(rand, 1.4, 2.6) * S, i % 3 ? c1 : c2, 3);
    }
  }

  explode(x: number, y: number, color: number, scale = 1): void {
    const rand = this.host.rand, S = this.host.S * scale;
    const n = [18, 30, 46][this.host.quality];
    const cols = [rgba(brighten(color, 0.2)), rgba(brighten(color, 0.6)), '#ffffff', rgba(0xffd43b)];
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, v = range(rand, 60, 420) * S;
      this.particles.spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, range(rand, 0.4, 1.1), range(rand, 1.6, 3.8) * S, cols[i % 4], 2.2);
    }
    this.rings.push({ x, y, r: 80 * S, age: 0, life: 0.5, css: rgba(brighten(color, 0.5)), w: 3 * S });
    this.rings.push({ x, y, r: 40 * S, age: 0, life: 0.22, css: '#ffffff', w: 10 * S }); // flash
    this.host.ripple(x, y, 0.55 * scale, brighten(color, 0.3));
  }

  // ----------------------------------------------------------------------------- beats
  spawnFlyby(): void {
    const max = [2, 3, 5][this.host.quality];
    if (this.flybys >= max) return;
    const { W, H, rand, S } = this.host;
    const depth = rand() ** 1.4;
    const cls = pick(rand, CLASSES);
    const r = SHIP_CLASSES[cls].base.radius * S * lerp(0.62, 1.18, depth);
    const amp = range(rand, 4, 26) * S;
    const lanes = this.flybyLanes(r, amp, depth);
    if (!lanes.length) return; // no room anywhere (tiny screen): skip this one
    const lane = pick(rand, lanes);
    const c = this.craft(cls, TEAM_COLORS[this.team()], depth, r);
    if (lane.faint) c.alpha = Math.min(c.alpha, 0.4);
    const dir = rand() < 0.5 ? 1 : -1;
    const m = this.margin(c.r);
    const len = lane.vertical ? H : W;
    const path = new Cross(dir > 0 ? -m : len + m, dir > 0 ? len + m : -m, lerp(lane.a, lane.b, rand()),
      lerp(10, 4.2, depth) * clamp(len / 1200, 0.7, 1.3), amp, range(rand, 0.08, 0.3), rand() * TAU, lane.vertical);
    let t = 0;
    this.flybys++;
    this.beats.push({
      update: (dt) => {
        t += dt;
        path.apply(c, t);
        c.tickTrail(dt);
        if (t >= path.dur) { this.drop(c); this.flybys--; return false; }
        return true;
      },
    });
  }

  spawnDogfight(): void {
    const { W, H, rand, S } = this.host;
    const preyTeam = this.team();
    const prey = this.craft(pick(rand, CLASSES), TEAM_COLORS[preyTeam], range(rand, 0.75, 1));
    const hunterCls = pick(rand, CLASSES);
    const hunter = this.craft(hunterCls, TEAM_COLORS[this.team(preyTeam)], range(rand, 0.75, 1));
    const dir = rand() < 0.5 ? 1 : -1;
    let killX = this.sideX(dir);
    let y = this.laneY(0.1 * H, 0.9 * H, 34 * S + Math.max(prey.r, hunter.r) * 1.5);
    if (killX === null) {
      y = this.bandLane(70 * S) ?? y;
      killX = W * range(rand, 0.3, 0.7) + dir * W * 0.1;
    }
    const m = this.margin(prey.r) + 260 * S;
    const speed = clamp(W / 4.4, 150, 420);
    const x0 = dir > 0 ? -m : W + m, x1 = dir > 0 ? W + m : -m;
    const path = new Cross(x0, x1, y, Math.abs(x1 - x0) / speed, range(rand, 16, 34) * S, range(rand, 0.35, 0.6), rand() * TAU);
    const lag = clamp(210 * S / speed, 0.35, 0.9);
    const killT = path.timeAtX(killX);
    const kit = hunterCls === 'brute'
      ? { kind: 'tracer' as ShotKind, every: 0.12, burst: 4, pause: 0.55, speed: 950, killKind: 'rocket' as ShotKind, lead: 0.62, killN: 3 }
      : hunterCls === 'tech'
        ? { kind: 'plasma' as ShotKind, every: 0.3, burst: 1, pause: 0, speed: 900, killKind: 'bigplasma' as ShotKind, lead: 0.34, killN: 1 }
        : { kind: 'rivet' as ShotKind, every: 0.075, burst: 7, pause: 0.5, speed: 1100, killKind: 'seeker' as ShotKind, lead: 0.7, killN: 3 };
    let t = 0, cd = 0.5, inBurst = 0, killFired = false, killed = false;
    const onScreen = (c: Craft) => c.x > -20 && c.x < W + 20;
    const fire = (kind: ShotKind, spd: number, kill: boolean, spread: number) => {
      const nose = hunter.r * 1.3;
      const d = Math.hypot(prey.x - hunter.x, prey.y - hunter.y);
      const lead = d / (spd * S);
      const aim = Math.atan2(prey.y + prey.vy * lead - hunter.y, prey.x + prey.vx * lead - hunter.x) + spread;
      this.shot(kind, hunter.x + Math.cos(hunter.angle) * nose, hunter.y + Math.sin(hunter.angle) * nose, aim, spd * S, hunter.color,
        prey, kill, kill ? (s) => {
          if (!killed) { killed = true; prey.alive = false; this.explode(prey.x, prey.y, prey.color, 1); } else this.sparks(s.x, s.y, s.color, 8, 160);
        } : null);
    };
    this.beats.push({
      update: (dt) => {
        t += dt;
        path.apply(prey, t);
        path.apply(hunter, Math.max(0, t - lag));
        hunter.angle = Math.atan2(prey.y - hunter.y, prey.x - hunter.x);
        prey.tickTrail(dt);
        hunter.tickTrail(dt);
        if (!killed && onScreen(prey) && onScreen(hunter)) {
          if (!killFired && t >= killT - kit.lead) {
            killFired = true;
            for (let i = 0; i < kit.killN; i++) fire(kit.killKind, kit.killKind === 'bigplasma' ? 1000 : 620, true, (i - (kit.killN - 1) / 2) * 0.35);
          } else if (!killFired && t > 0.3) {
            cd -= dt;
            if (cd <= 0) {
              fire(kit.kind, kit.speed, false, range(rand, -0.06, 0.06));
              inBurst++;
              if (inBurst >= kit.burst) { inBurst = 0; cd = kit.every + kit.pause; } else cd = kit.every;
            }
          }
        }
        // a kill shot that lost its target still ends the fight if the prey reaches the far edge
        if (t >= path.dur + lag) { this.drop(prey); this.drop(hunter); return false; }
        return true;
      },
    });
  }

  spawnSwarm(): void {
    const { W, H, rand, S } = this.host;
    const runner = this.craft(pick(rand, CLASSES), TEAM_COLORS[this.team()], range(rand, 0.8, 1));
    const dir = rand() < 0.5 ? 1 : -1;
    let novaX = this.sideX(dir, 130);
    let y = this.laneY(0.12 * H, 0.88 * H, 95 * S); // runner weave + the drones trailing around it
    if (novaX === null) { y = this.bandLane(80 * S) ?? y; novaX = W * (dir > 0 ? 0.72 : 0.28); }
    const speed = clamp(W / 5.2, 130, 340);
    const m = this.margin(runner.r) + 320 * S;
    const x0 = dir > 0 ? -m : W + m, x1 = dir > 0 ? W + m : -m;
    const path = new Cross(x0, x1, y, Math.abs(x1 - x0) / speed, range(rand, 20, 40) * S, range(rand, 0.25, 0.45), rand() * TAU);
    const count = [6, 10, 14][this.host.quality];
    const drones: Drone[] = [];
    for (let i = 0; i < count; i++) {
      drones.push({
        x: x0 - dir * range(rand, 60, 300) * S, y: y + range(rand, -60, 60) * S, vx: speed * dir, vy: 0, spin: rand() * TAU,
        ox: range(rand, -46, 46) * S, oy: range(rand, -46, 46) * S, alive: true,
      });
    }
    const dr = 9 * S;
    const sprite = this.host.sprites.drone(dr);
    const novaT = path.timeAtX(novaX);
    let t = 0;
    let nova = -1; // age of the nova ring, -1 = not fired
    const novaR = 150 * S;
    const pink = rgba(brighten(DRONE, 0.3));
    this.beats.push({
      update: (dt) => {
        t += dt;
        path.apply(runner, t);
        runner.tickTrail(dt);
        const max = speed * 1.12;
        for (const d of drones) {
          if (!d.alive) continue;
          const tx = runner.x - dir * 90 * S + d.ox, ty = runner.y + d.oy;
          const dx = tx - d.x, dy = ty - d.y, dist = Math.hypot(dx, dy) || 1;
          const want = Math.min(max, dist * 3);
          d.vx += ((dx / dist) * want - d.vx) * Math.min(1, dt * 2.4);
          d.vy += ((dy / dist) * want - d.vy) * Math.min(1, dt * 2.4);
          d.x += d.vx * dt; d.y += d.vy * dt;
          d.spin += dt * 3;
        }
        if (nova < 0 && t >= novaT) {
          nova = 0;
          this.rings.push({ x: runner.x, y: runner.y, r: novaR, age: 0, life: 0.55, css: rgba(brighten(runner.color, 0.5)), w: 4 * S });
          this.host.ripple(runner.x, runner.y, 0.4, runner.color);
        }
        if (nova >= 0 && nova < 0.55) {
          nova += dt;
          const rad = novaR * Math.min(1, nova / 0.55);
          for (const d of drones) {
            if (d.alive && Math.hypot(d.x - runner.x, d.y - runner.y) < rad + dr) {
              d.alive = false;
              for (let i = 0; i < 7; i++) {
                const a = rand() * TAU, v = range(rand, 60, 240) * S;
                this.particles.spawn(d.x, d.y, Math.cos(a) * v, Math.sin(a) * v, range(rand, 0.3, 0.7), range(rand, 1.5, 3) * S, i % 2 ? pink : '#ffffff', 2.5);
              }
            }
          }
        }
        if (t >= path.dur) { this.drop(runner); return false; }
        return true;
      },
      drawOver: (ctx) => {
        const dpr = this.host.dpr, h = sprite.half;
        for (const d of drones) {
          if (!d.alive) continue;
          const a = Math.atan2(d.vy, d.vx) + Math.sin(d.spin) * 0.5;
          const c = Math.cos(a), s = Math.sin(a);
          ctx.setTransform(c * dpr, s * dpr, -s * dpr, c * dpr, d.x * dpr, d.y * dpr);
          ctx.drawImage(sprite.canvas, -h, -h, h * 2, h * 2);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      },
    });
  }

  /**
   * The set-piece: a Juggernaut with three Arcanist laser turrets (in-game turretOffset slots). Each laser
   * that joins multiplies the lance ×1.5 (LASER_RESONANCE), so the merged beam widens and heats to gold.
   * v0.5: as in the game, the host flies its capital size (capitalScale(3)) and the turrets ride ON the hull at
   * bubble size, on the 3-turret hardpoints (fore port / fore starboard / center aft).
   */
  spawnSetpiece(forceDir = 0): void {
    const { W, rand, S } = this.host;
    const hostR = SHIP_CLASSES.brute.base.radius * capitalScale(3);
    // Fly the stack in a clear band above or below the title column; shrink it (down to ×0.6) to fit the room.
    const unit = (hostR + 12 + 20) * 2.1; // formation height per unit of scale
    // Prefer the band over the grid floor: in the top band the white-gold lance crosses the sun, gold on gold.
    let k = S * 1.9;
    let y = this.bandLane(unit * k, true);
    if (y === null) {
      const b = this.widestBand(true);
      k = Math.max(S * 1.9 * 0.6, Math.min(k, b.room / unit));
      y = b.y;
    }
    const team = this.team();
    const color = TEAM_COLORS[team];
    // one scale k for hull radii AND turret offsets, so the stack matches the in-game geometry
    const host = this.craft('brute', color, 1, hostR * k);
    host.flame = 1.5;
    const turrets = [0, 1, 2].map(() => this.craft('tech', color, 0.99, TURRET_BUBBLE_RADIUS * 1.15 * k));
    const dir = forceDir || (rand() < 0.5 ? 1 : -1);
    const span = (hostR + 12 + 20) * k;
    const m = span + 420 * S;
    const x0 = dir > 0 ? -m : W + m, x1 = dir > 0 ? W + m : -m;
    const path = new Cross(x0, x1, y, 11, 6 * S, 0.12, rand() * TAU);
    const count = [5, 8, 11][this.host.quality];
    const targets: Drone[] = [];
    for (let i = 0; i < count; i++) {
      targets.push({
        x: x1 + dir * range(rand, 0, 420) * S, y: y + range(rand, -26, 26) * S, vx: -dir * range(rand, 50, 90) * S, vy: 0, spin: rand() * TAU,
        ox: 0, oy: range(rand, -1, 1), alive: true,
      });
    }
    const dr = 9 * S;
    const sprite = this.host.sprites.drone(dr);
    const pink = rgba(brighten(DRONE, 0.3));
    let t = 0;
    let firing = 0; // seconds since the first laser opened (−1 while holding fire)
    let onAt = -1;
    const beam = { fx: 0, fy: 0, lx: 0, ly: 0, n: 0, w: 0 };
    this.beats.push({
      update: (dt) => {
        t += dt;
        path.apply(host, t);
        // face the direction of travel, with only a hint of the weave (a heavy hull doesn't wobble)
        host.angle = dir > 0 ? Math.atan2(host.vy, host.vx) * 0.3 : Math.PI - Math.atan2(host.vy, -host.vx) * 0.3;
        host.tickTrail(dt);
        const fx = host.x + Math.cos(host.angle) * 200 * k * 0.55, fy = host.y + Math.sin(host.angle) * 200 * k * 0.55;
        turrets.forEach((tr, slot) => {
          const o = turretOffset(host.angle, slot, 3, hostR);
          tr.place(host.x + o.dx * k, host.y + o.dy * k, host.vx, host.vy, Math.atan2(fy - (host.y + o.dy * k), fx - (host.x + o.dx * k)));
        });
        // fire while the formation is well on screen
        const visible = host.x > W * 0.06 && host.x < W * 0.94;
        if (visible && onAt < 0) onAt = t;
        const n = onAt < 0 || !visible ? 0 : Math.min(3, 1 + Math.floor((t - onAt) / 0.5));
        firing = n ? firing + dt : 0;
        beam.n = n;
        beam.fx = fx; beam.fy = fy;
        const len = 380 * S;
        beam.lx = fx + Math.cos(host.angle) * len; beam.ly = fy + Math.sin(host.angle) * len;
        beam.w = n ? 1.5 ** (n - 1) : 0;
        // targets drift in; the lance vaporizes them
        for (const d of targets) {
          if (!d.alive) continue;
          d.x += d.vx * dt;
          d.y += Math.sin(t * 2 + d.oy * 3) * 12 * S * dt;
          d.spin += dt * 3;
          if (n > 0) {
            const px = beam.lx - fx, py = beam.ly - fy;
            const u = clamp(((d.x - fx) * px + (d.y - fy) * py) / (px * px + py * py), 0, 1);
            const ddx = fx + px * u - d.x, ddy = fy + py * u - d.y;
            if (Math.hypot(ddx, ddy) < dr + 5 * S * beam.w) {
              d.alive = false;
              this.sparks(d.x, d.y, DRONE, 5, 200);
              for (let i = 0; i < 6; i++) {
                const a = rand() * TAU, v = range(rand, 40, 200) * S;
                this.particles.spawn(d.x, d.y, Math.cos(a) * v, Math.sin(a) * v, range(rand, 0.3, 0.8), range(rand, 1.6, 3.2) * S, i % 2 ? pink : '#fff6a8', 2);
              }
              this.rings.push({ x: d.x, y: d.y, r: 26 * S, age: 0, life: 0.3, css: pink, w: 2 * S });
            }
          }
        }
        if (n > 0 && this.host.quality > 0 && rand() < dt * 30) {
          // sparks shed at the convergence point
          const a = host.angle + range(rand, -1.2, 1.2), v = range(rand, 60, 220) * S;
          this.particles.spawn(fx, fy, Math.cos(a) * v, Math.sin(a) * v, range(rand, 0.2, 0.5), range(rand, 1.2, 2.4) * S, '#fff6a8', 3);
        }
        if (t >= path.dur) { this.drop(host); for (const tr of turrets) this.drop(tr); return false; }
        return true;
      },
      drawUnder: () => {
        // v0.5: no tethers (the turrets sit on the hull); their hardpoint rings are drawn in drawOver
      },
      drawOver: (ctx) => {
        const dpr = this.host.dpr, h = sprite.half;
        // hardpoint rings: each bubble turret glows on its mount (the in-game dome ring)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgba(brighten(color, 0.4), 0.55);
        ctx.lineWidth = 1.3 * S;
        ctx.beginPath();
        for (const tr of turrets) { ctx.moveTo(tr.x + tr.r + 3 * S, tr.y); ctx.arc(tr.x, tr.y, tr.r + 3 * S, 0, Math.PI * 2); }
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        for (const d of targets) {
          if (!d.alive) continue;
          const a = d.spin, c = Math.cos(a), s = Math.sin(a);
          ctx.setTransform(c * dpr, s * dpr, -s * dpr, c * dpr, d.x * dpr, d.y * dpr);
          ctx.drawImage(sprite.canvas, -h, -h, h * 2, h * 2);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const n = beam.n;
        if (!n) return;
        const flick = 0.85 + 0.15 * Math.sin(t * 55);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        // the three lasers, converging ahead of the prow
        for (let i = 0; i < n; i++) {
          const tr = turrets[i];
          const nx = tr.x + Math.cos(tr.angle) * tr.r * 1.2, ny = tr.y + Math.sin(tr.angle) * tr.r * 1.2;
          ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(beam.fx, beam.fy);
          ctx.strokeStyle = rgba(color, 0.22); ctx.lineWidth = 7 * S * flick; ctx.stroke();
          ctx.strokeStyle = rgba(brighten(color, 0.55), 0.95); ctx.lineWidth = 1.8 * S; ctx.stroke();
        }
        // the resonance lance: ×1.5 per extra laser, cyan → white-gold as it stacks
        const heat = (n - 1) / 2;
        const core = mix(brighten(color, 0.5), 0xfff6a8, heat);
        const edge = mix(color, 0xffd43b, heat);
        const w = beam.w * flick;
        ctx.globalAlpha = clamp(firing / 0.25, 0, 1); // the lance snaps on over a quarter second
        ctx.beginPath(); ctx.moveTo(beam.fx, beam.fy); ctx.lineTo(beam.lx, beam.ly);
        // a dark-violet outline first, so the lance still reads over the sun and the bright horizon
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(22, 6, 44, 0.55)'; ctx.lineWidth = 6 * S * w + 4; ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgba(edge, 0.16); ctx.lineWidth = 16 * S * w; ctx.stroke();
        ctx.strokeStyle = rgba(edge, 0.45); ctx.lineWidth = 6 * S * w; ctx.stroke();
        ctx.strokeStyle = rgba(core, 1); ctx.lineWidth = 2.2 * S * w; ctx.stroke();
        // convergence flare
        ctx.fillStyle = rgba(core, 0.35);
        ctx.beginPath(); ctx.arc(beam.fx, beam.fy, 9 * S * w, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(beam.fx, beam.fy, 3.2 * S * Math.sqrt(w), 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    });
  }

  // ----------------------------------------------------------------------------- frame
  update(dt: number): void {
    this.t += dt;
    for (let i = this.beats.length - 1; i >= 0; i--) if (!this.beats[i].update(dt)) this.beats.splice(i, 1);
    const S = this.host.S;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.age += dt;
      const tg = s.target;
      if ((s.kind === 'rocket' || s.kind === 'seeker' || s.kind === 'bigplasma') && tg && tg.alive) {
        // homing: turn toward the target
        const sp = Math.hypot(s.vx, s.vy);
        const want = Math.atan2(tg.y - s.y, tg.x - s.x), cur = Math.atan2(s.vy, s.vx);
        let d = want - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const turn = (s.kind === 'seeker' ? 7 : s.kind === 'rocket' ? 4.5 : 3) * dt;
        const a = cur + clamp(d, -turn, turn);
        const nsp = s.kind === 'bigplasma' ? sp : Math.min(sp * (1 + dt * 1.2), 1100 * S);
        s.vx = Math.cos(a) * nsp; s.vy = Math.sin(a) * nsp;
      }
      s.x += s.vx * dt; s.y += s.vy * dt;
      if ((s.kind === 'rocket' || s.kind === 'seeker') && this.host.quality > 0) {
        s.smoke += dt;
        if (s.smoke > 0.02) {
          s.smoke = 0;
          this.particles.spawn(s.x, s.y, -s.vx * 0.05, -s.vy * 0.05, 0.35, 2.6 * S, 'rgba(190,150,255,0.5)', 1);
        }
      }
      let hit = false;
      if (tg && tg.alive && Math.hypot(tg.x - s.x, tg.y - s.y) < tg.r * 1.05) {
        hit = true;
        if (s.kill && s.onKill) s.onKill(s);
        else this.sparks(s.x, s.y, s.color, s.kind === 'rivet' ? 3 : 5, 140);
      } else if (tg && !tg.alive && s.kill && Math.hypot(tg.x - s.x, tg.y - s.y) < tg.r * 1.4) {
        hit = true;
        if (s.onKill) s.onKill(s);
      }
      if (hit || s.age >= s.life) {
        this.shots.splice(i, 1);
        this.shotPool.push(s);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age >= r.life) this.rings.splice(i, 1);
    }
    this.particles.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D, t: number): void {
    const dpr = this.host.dpr, glow = this.host.quality > 0, S = this.host.S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    for (const c of this.crafts) c.drawTrail(ctx, glow);
    ctx.globalCompositeOperation = 'source-over';
    for (const b of this.beats) b.drawUnder?.(ctx);
    for (const c of this.crafts) c.draw(ctx, dpr, t);
    for (const b of this.beats) b.drawOver?.(ctx);
    // shots
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of this.shots) {
      const sp = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / sp, uy = s.vy / sp;
      if (s.kind === 'tracer' || s.kind === 'rivet') {
        const len = (s.kind === 'tracer' ? 16 : 9) * S;
        ctx.strokeStyle = s.css; ctx.lineWidth = s.size * 1.9; ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - ux * len, s.y - uy * len); ctx.stroke();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = s.size * 0.7; ctx.globalAlpha = 1;
        ctx.stroke();
      } else if (s.kind === 'rocket' || s.kind === 'seeker') {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = s.size;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - ux * s.size * 2.4, s.y - uy * s.size * 2.4); ctx.stroke();
        ctx.fillStyle = s.css; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.arc(s.x - ux * s.size * 3, s.y - uy * s.size * 3, s.size * 1.3, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = s.css; ctx.globalAlpha = 0.3;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 2.2, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 1.1, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 0.55, 0, TAU); ctx.fill();
      }
    }
    // rings (shockwaves, flashes, novas)
    for (const r of this.rings) {
      const k = r.age / r.life;
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = r.css;
      ctx.lineWidth = r.w * (1 - k * 0.7);
      ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(0.5, r.r * (0.2 + 0.8 * Math.sqrt(k))), 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.particles.draw(ctx);
  }
}
