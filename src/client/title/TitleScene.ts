// Title attract scene: an animated synthwave backdrop behind the Title / login panel.
//
// Canvas2D on its own <canvas>, sharing nothing with the game's PixiJS renderer (no WebGL context, no
// GraphicsContext caches, no ticker). TitleScreen creates it when the Title screen shows and destroys it
// when the screen goes away, so in a match GameRenderer is the only thing drawing. The loop pauses while
// the tab is hidden. prefers-reduced-motion gets one static poster frame (redrawn only on resize).
// Budget: ≤ 2 ms of script per frame at 1080p; the backdrop's DPR is capped at 1.5, and a governor
// steps quality down (DPR, stars, ships, particles, heat shimmer) when frames run long.
import { Cast, type CastHost, type FocusRect } from './actors';
import { Backdrop, CAM_SWAY, type FloorRipple, type StageLayout } from './backdrop';
import { Director, type SceneEvent } from './director';
import { QualityGovernor, QUALITY_MAX } from './quality';
import { approach, clamp, floorDepthAt, floorXAt, mulberry32, type Rand } from './sceneMath';
import { SpriteCache } from './sprites';

export interface RectLike { left: number; top: number; right: number; bottom: number }

/**
 * Where the DOM puts things (viewport px), so the sun and the action frame them: the logo (the sun sits behind
 * it and the horizon under it), the tagline (the horizon stays above it), the whole title column (the action
 * avoids it) and the glass panel (far, faint flybys may cross behind it).
 */
export interface TitleAnchors { logo: RectLike | null; focus: RectLike | null; tagline?: RectLike | null; panel?: RectLike | null }

export interface TitleSceneOptions {
  reducedMotion?: boolean;
  seed?: number;
  /** Called after every animated frame (the logo's beat pulse rides on this loop). */
  onFrame?: (nowMs: number, dt: number) => void;
  /** Called when the quality governor changes level (the page can shed its own GPU cost too). */
  onQuality?: (level: number) => void;
}

export interface TitleSceneStats {
  drawMs: number; frameMs: number; quality: number; dpr: number; stars: number; particles: number; crafts: number;
  /** Too slow even at quality 0 (e.g. no GPU canvas): showing the static poster instead. */
  fallback: boolean;
}

const DPR_BY_QUALITY = [1, 1.25, 1.5] as const;
const STAR_DENSITY = [11000, 6500, 3800] as const;
const TAU = Math.PI * 2;
/** At quality 0, a draw EMA over this for FALLBACK_SEC switches to the static poster. */
const FALLBACK_DRAW_MS = 6;
const FALLBACK_SEC = 2.5;

export class TitleScene implements CastHost {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  W = 0;
  H = 0;
  dpr = 1;
  S = 1;
  hy = 0;
  focus: FocusRect | null = null;
  panel: FocusRect | null = null;
  sprites: SpriteCache;
  rand: Rand;
  private readonly seed: number;
  private readonly backdrop = new Backdrop();
  private readonly cast: Cast;
  private director: Director;
  private readonly governor: QualityGovernor;
  private readonly ripples: FloorRipple[] = [];
  private readonly events: SceneEvent[] = [];
  private readonly layout: StageLayout = { W: 0, H: 0, dpr: 1, cx: 0, hy: 0, sunY: 0, sunR: 0 };
  private readonly target = { cx: 0, hy: 0, sunR: 0 };
  private anchors: TitleAnchors = { logo: null, focus: null };
  private raf = 0;
  private wanted = false;
  private looping = false;
  private last = 0;
  private t = 0;
  private dirty = true;
  private snapLayout = true;
  private reduced: boolean;
  private fallback = false;
  private slowSec = 0;
  private posterQueued = 0;
  private destroyed = false;
  private readonly ro: ResizeObserver | null;
  private readonly onVisibility = (): void => this.syncLoop();
  /** ResizeObserver + window resize (also DPR changes): rebuild only when the stage really changed. */
  private readonly onResize = (): void => {
    const host = this.canvas.parentElement;
    const W = Math.max(1, host?.clientWidth || window.innerWidth);
    const H = Math.max(1, host?.clientHeight || window.innerHeight);
    const dpr = Math.min(DPR_BY_QUALITY[this.quality], window.devicePixelRatio || 1);
    if (W === this.W && H === this.H && dpr === this.dpr) return;
    this.dirty = true;
    if (this.posterMode) this.queuePoster();
  };

  constructor(host: HTMLElement, private readonly opts: TitleSceneOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'title-scene';
    this.canvas.setAttribute('aria-hidden', 'true');
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('title scene: 2D canvas unavailable');
    this.ctx = ctx;
    host.prepend(this.canvas);
    this.seed = opts.seed ?? 0x5ca1ab1e;
    this.rand = mulberry32(this.seed);
    this.reduced = !!opts.reducedMotion;
    this.governor = new QualityGovernor(QUALITY_MAX);
    this.sprites = new SpriteCache(1);
    this.cast = new Cast(this);
    this.cast.setQuality(this.quality);
    this.director = new Director(this.rand);
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this.onResize) : null;
    this.ro?.observe(host);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (import.meta.env?.DEV) (window as unknown as Record<string, unknown>).__voidswarmTitle = this;
  }

  get quality(): number { return this.governor.level; }

  /** One static frame instead of the loop: reduced motion, or the slow-device fallback. */
  private get posterMode(): boolean { return this.reduced || this.fallback; }

  get stats(): TitleSceneStats {
    return {
      drawMs: this.governor.drawMs, frameMs: this.governor.frameMs, quality: this.quality, dpr: this.dpr,
      stars: this.backdrop.starCount, particles: this.cast.particles.n, crafts: this.cast.craftCount, fallback: this.fallback,
    };
  }

  // ------------------------------------------------------------------ lifecycle
  start(): void {
    if (this.destroyed) return;
    this.wanted = true;
    if (this.posterMode) this.queuePoster();
    this.syncLoop();
  }

  stop(): void {
    this.wanted = false;
    this.syncLoop();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    if (this.posterQueued) cancelAnimationFrame(this.posterQueued);
    this.ro?.disconnect();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.backdrop.destroy();
    this.cast.clear();
    this.sprites.clear();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.remove();
    const w = window as unknown as Record<string, unknown>;
    if (w.__voidswarmTitle === this) delete w.__voidswarmTitle;
  }

  setReducedMotion(on: boolean): void {
    if (on === this.reduced) return;
    this.reduced = on;
    if (on) this.queuePoster();
    this.syncLoop();
  }

  setAnchors(a: TitleAnchors): void {
    this.anchors = a;
    // The wordmark is wider than the column on most screens: the action avoids both.
    const f = a.focus, l = a.logo;
    this.focus = f && l
      ? { left: Math.min(f.left, l.left), top: Math.min(f.top, l.top), right: Math.max(f.right, l.right), bottom: Math.max(f.bottom, l.bottom) }
      : f ? { left: f.left, top: f.top, right: f.right, bottom: f.bottom } : null;
    const p = a.panel;
    this.panel = p && p.right - p.left > 10 ? { left: p.left, top: p.top, right: p.right, bottom: p.bottom } : null;
    this.computeTarget();
    if (this.posterMode) this.queuePoster();
  }

  /** Run the loop only when wanted, animated, and the tab is visible. */
  private syncLoop(): void {
    const run = this.wanted && !this.posterMode && !this.destroyed && !document.hidden;
    if (run && !this.looping) {
      this.looping = true;
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    } else if (!run && this.looping) {
      this.looping = false;
      cancelAnimationFrame(this.raf);
    }
  }

  // ------------------------------------------------------------------ layout
  private rebuild(): void {
    const host = this.canvas.parentElement;
    const W = Math.max(1, host?.clientWidth || window.innerWidth);
    const H = Math.max(1, host?.clientHeight || window.innerHeight);
    // A width change re-lays the whole stage; a height-only change (phone keyboard, browser chrome, a short
    // window) keeps the ships in flight and the stars, and the horizon eases to its new place.
    const widthChanged = this.W === 0 || W !== this.W;
    const heightOnly = !widthChanged && H !== this.H;
    const dpr = Math.min(DPR_BY_QUALITY[this.quality], window.devicePixelRatio || 1);
    const dprChanged = dpr !== this.dpr;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.S = clamp(Math.min(W, H) / 900, 0.62, 1.35);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.layout.W = W; this.layout.H = H; this.layout.dpr = dpr;
    this.computeTarget();
    this.backdrop.build(W, H, dpr, this.target.sunR, STAR_DENSITY[this.quality], this.seed, heightOnly && !dprChanged);
    this.layout.sunR = this.target.sunR;
    // Sprites are baked at the DPR: a new cache for new ships. Ships in flight keep theirs, except on a
    // width change, where every size and lane changes anyway.
    if (widthChanged) {
      this.cast.clear();
      this.ripples.length = 0;
      this.sprites.clear();
    }
    if (widthChanged || dprChanged) this.sprites = new SpriteCache(dpr);
    this.snapLayout = this.snapLayout || widthChanged;
    this.dirty = false;
  }

  private computeTarget(): void {
    const { W, H } = this;
    if (!W || !H) return;
    const logo = this.anchors.logo;
    let cx = W / 2;
    let hy = H * 0.46;
    let sunR = clamp(Math.min(W * 0.2, H * 0.26), 56, 300);
    if (logo && logo.right - logo.left > 10) {
      const lw = logo.right - logo.left;
      cx = (logo.left + logo.right) / 2;
      sunR = clamp(lw * 0.3, 56, 300);
      // The wordmark stands on the horizon; the horizon line stays clear above the tagline (a bright line
      // through white text is unreadable).
      hy = logo.bottom + 4;
      const tag = this.anchors.tagline;
      if (tag && tag.bottom - tag.top > 1) hy = Math.min(hy, tag.top - 6);
      hy = clamp(hy, Math.min(48, H * 0.3), H * 0.8);
    }
    // keep the top of the disc on screen (its centre sits 0.3 R above the horizon)
    sunR = Math.max(40, Math.min(sunR, (hy - 10) / 1.3));
    this.target.cx = cx;
    this.target.hy = hy;
    if (Math.abs(sunR - this.target.sunR) >= 2) {
      this.target.sunR = sunR;
      this.backdrop.setSunRadius(sunR);
      this.layout.sunR = sunR;
    }
  }

  private easeLayout(dt: number): void {
    const L = this.layout, T = this.target;
    if (this.snapLayout) {
      L.cx = T.cx; L.hy = T.hy;
      this.snapLayout = false;
    } else {
      L.cx = approach(L.cx, T.cx, dt, 0.22);
      L.hy = approach(L.hy, T.hy, dt, 0.22);
    }
    L.sunY = L.hy - L.sunR * 0.3;
    this.hy = L.hy;
  }

  // ------------------------------------------------------------------ CastHost
  ripple(x: number, y: number, size: number, color: number): void {
    const cam = this.backdrop.cam;
    if (cam.floorH <= 8) return;
    const yFloor = y > this.hy + 12 ? Math.min(this.H - 4, y + 18 * this.S) : this.hy + cam.floorH * 0.42;
    const z = floorDepthAt(cam, yFloor);
    if (!Number.isFinite(z)) return;
    if (this.ripples.length >= 6) this.ripples.shift();
    this.ripples.push({ X: floorXAt(cam, x, z), z, age: 0, life: 1.3, size, color });
  }

  // ------------------------------------------------------------------ frame
  private readonly frame = (now: number): void => {
    if (!this.looping) return;
    this.raf = requestAnimationFrame(this.frame);
    const frameMs = this.last ? now - this.last : 1000 / 60;
    this.last = now;
    const dt = Math.min(0.05, Math.max(0, frameMs / 1000));
    const t0 = performance.now();
    try {
      if (this.dirty) this.rebuild();
      this.step(dt);
      this.render();
    } catch (e) {
      console.error('[voidswarm] title scene', e);
      this.stop();
      return;
    }
    const drawMs = performance.now() - t0;
    if (this.governor.sample(drawMs, frameMs)) this.applyQuality();
    // Still far over budget at the lowest quality (software canvas, very old device): stop animating.
    this.slowSec = this.quality === 0 && this.governor.drawMs > FALLBACK_DRAW_MS ? this.slowSec + dt : Math.max(0, this.slowSec - dt);
    if (this.slowSec > FALLBACK_SEC) {
      this.fallback = true;
      console.info('[voidswarm] title scene too slow here; showing a static backdrop');
      this.queuePoster();
      this.syncLoop();
      return;
    }
    this.opts.onFrame?.(now, dt);
  };

  private applyQuality(): void {
    const q = this.quality;
    this.cast.setQuality(q);
    this.opts.onQuality?.(q);
    const dpr = Math.min(DPR_BY_QUALITY[q], window.devicePixelRatio || 1);
    if (Math.abs(dpr - this.dpr) > 0.01) this.dirty = true; // rebuilds the canvas + caches at the new DPR
    else this.backdrop.setStarDensity(STAR_DENSITY[q], this.seed);
  }

  private step(dt: number): void {
    this.t += dt;
    this.easeLayout(dt);
    this.events.length = 0;
    this.director.step(dt, this.events);
    for (const e of this.events) {
      switch (e) {
        case 'flyby': this.cast.spawnFlyby(); break;
        case 'dogfight': this.cast.spawnDogfight(); break;
        case 'swarm': this.cast.spawnSwarm(); break;
        case 'setpiece': this.cast.spawnSetpiece(); break;
        case 'shooting': this.backdrop.addShootingStar(this.rand, this.hy); break;
      }
    }
    this.backdrop.update(dt);
    this.cast.update(dt);
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      if (r.age >= r.life) this.ripples.splice(i, 1);
    }
  }

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const camX = this.reduced ? 0 : CAM_SWAY * Math.sin((this.t * TAU) / 46);
    const q = this.quality;
    const t0 = performance.now();
    this.backdrop.draw(ctx, this.layout, this.t, camX, q >= 2 && !this.reduced, q >= 1, this.ripples);
    const t1 = performance.now();
    this.cast.draw(ctx, this.t);
    const t2 = performance.now();
    const p = this.profile;
    p.back += (t1 - t0 - p.back) * 0.1;
    p.cast += (t2 - t1 - p.cast) * 0.1;
    // (the vignette is a static CSS layer over the canvas: .title-bg::after)
  }

  /** Smoothed per-section draw times (ms), for tuning. */
  readonly profile = { back: 0, cast: 0 };

  // ------------------------------------------------------------------ reduced motion: one poster frame
  private queuePoster(): void {
    if (this.posterQueued || this.destroyed) return;
    this.posterQueued = requestAnimationFrame(() => {
      this.posterQueued = 0;
      if (this.destroyed || !this.posterMode || !this.wanted) return;
      try { this.renderPoster(); } catch (e) { console.error('[voidswarm] title poster', e); }
    });
  }

  private renderPoster(): void {
    this.rebuild();
    this.cast.clear();
    this.ripples.length = 0;
    this.snapLayout = true;
    this.easeLayout(0);
    // A fixed tableau: the Juggernaut stack mid-crossing with its lance at full resonance, pilots in flight.
    // Re-seeded so every poster (resize, view change) is the same picture.
    const saved = this.t;
    const liveRand = this.rand;
    this.rand = mulberry32(this.seed ^ 0x9e3779b9);
    this.cast.spawnSetpiece(1);
    for (let i = 0; i < 3; i++) this.cast.spawnFlyby();
    const dt = 1 / 30;
    for (let s = 0; s < Math.round(4.3 / dt); s++) {
      this.cast.update(dt);
      if (s === 40) this.cast.spawnFlyby();
    }
    this.cast.particles.clear();
    this.t = saved + 12.34;
    this.render();
    this.t = saved;
    this.rand = liveRand;
  }
}
