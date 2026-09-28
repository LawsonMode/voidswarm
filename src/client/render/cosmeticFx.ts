// Cosmetic particle presets (RENDER agent, v0.3 M2): engine trails and death presets.
// Emission goes through a tiny Spawner interface so the readability test can count what a preset emits.
// Bounds (enforced here, whatever the catalog says): engine rateMul ≤ 1.5 · accent share ≤ 0.5 ·
// lifeMul 0.6–2; death preset ≤ 70 particles, every particle and ring gone within linger ≤ 1.5 s.
import type { DeathParams, EngineParams } from '../../shared/data/cosmetics';
import type { SpawnOpts } from './particles';
import type { Atlas } from './textures';
import { READABILITY } from './cosmeticLook';
import { brighten, mix } from './palette';

// Same bit values as particles.ts (kept local so this module has no Pixi runtime dependency).
const P_ORIENT = 1, P_STRETCH = 2, P_SPIN = 4;

export interface Spawner { spawn(o: SpawnOpts): void }
/** The atlas cells a preset may use. */
export type FxAtlas = Pick<Atlas, 'soft' | 'dot' | 'streak' | 'diamond' | 'shard' | 'crystal' | 'ring' | 'wShard'>;

const TAU = Math.PI * 2;
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** Low-saturation (≤ 0.3) pastel hue, so prism particles never read as a team colour. */
export function pastel(h: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return 0.85 - 0.12 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

// =============================================================================================
// Engine
// =============================================================================================

/** Flame sprite tint: mix(team, tint, 0.5), then the usual afterburner / idle brightening. */
export function engineFlameTint(team: number, e: EngineParams, ab: boolean): number {
  const base = typeof e.tint === 'number' ? mix(team, e.tint, 0.5) : team;
  return ab ? brighten(mix(base, 0xffb040, 0.5), 0.35) : brighten(base, 0.25);
}

export interface EngineEmit {
  /** Nozzle position (world px). */
  x: number; y: number;
  /** Thrust direction (rad): particles leave opposite to it. */
  dir: number;
  /** Ship velocity (px/s). */
  vx: number; vy: number;
  /** Ship radius (px). */
  r: number;
  ab: boolean;
  team: number;
  /** Ship root alpha (cloak / invulnerability blink): multiplies every particle. */
  alpha: number;
  /** Renderer density 0..1. */
  density: number;
  time: number;
}

/** Engine trail particles for one ship this frame. Returns the number spawned. */
export function emitEngine(out: Spawner, A: FxAtlas, e: EngineParams, accent: number, c: EngineEmit): number {
  const rate = Math.max(0, Math.min(READABILITY.engineRateMulMax, e.rateMul));
  const share = Math.max(0, Math.min(READABILITY.engineMixMax, e.mix));
  const lifeMul = Math.max(READABILITY.engineLifeMulMin, Math.min(READABILITY.engineLifeMulMax, e.lifeMul));
  const expected = (c.ab ? 2 : 1) * rate * c.density;
  const n = Math.floor(expected) + (Math.random() < expected - Math.floor(expected) ? 1 : 0);
  if (n <= 0 || c.alpha <= 0) return 0;
  const ca = Math.cos(c.dir), sa = Math.sin(c.dir);
  const sc = c.r / 16;
  const base = typeof e.tint === 'number' ? mix(c.team, e.tint, 0.5) : c.team;
  const flameC = c.ab ? mix(base, 0xffc060, 0.55) : base;
  for (let i = 0; i < n; i++) {
    const useAccent = Math.random() < share;
    const jit = rand(-0.35, 0.35);
    let sp = rand(140, 260) * (c.ab ? 1.5 : 1);
    const x = c.x - ca * c.r * 0.95, y = c.y - sa * c.r * 0.95;
    const dvx = -Math.cos(c.dir + jit), dvy = -Math.sin(c.dir + jit);
    const inherit = 0.35;
    switch (e.particle) {
      case 'smoke':
        sp *= 0.45;
        out.spawn({
          tex: A.soft, x, y, vx: dvx * sp + c.vx * inherit, vy: dvy * sp + c.vy * inherit,
          life: 0.5 * lifeMul, color: useAccent ? accent : mix(flameC, 0x6a6a80, 0.45),
          s0: 0.16 * sc, s1: 0.5 * sc, alpha: 0.42 * c.alpha, drag: 2.2,
        });
        break;
      case 'ember': {
        sp *= 0.8;
        const side = rand(-0.7, 0.7) * sp * 0.4;
        out.spawn({
          tex: A.dot, x, y, vx: dvx * sp - sa * side + c.vx * inherit, vy: dvy * sp + ca * side + c.vy * inherit,
          life: 0.42 * lifeMul, color: useAccent ? accent : mix(flameC, 0xffa040, 0.35),
          s0: 0.3 * Math.min(1.4, sc), s1: 0, alpha: 0.95 * c.alpha, drag: 2.6,
        });
        break;
      }
      case 'spore': {
        sp *= 0.35;
        const drift = rand(-40, 40);
        out.spawn({
          tex: A.soft, x, y, vx: dvx * sp - sa * drift + c.vx * 0.2, vy: dvy * sp + ca * drift + c.vy * 0.2,
          life: 0.6 * lifeMul, color: useAccent ? accent : flameC,
          s0: 0.08 * sc, s1: 0.26 * sc, alpha: 0.6 * c.alpha, drag: 1.5,
        });
        break;
      }
      case 'prism':
        sp *= 0.9;
        out.spawn({
          tex: A.diamond, x, y, vx: dvx * sp + c.vx * inherit, vy: dvy * sp + c.vy * inherit,
          life: 0.38 * lifeMul, color: useAccent ? pastel((c.time * 0.35 + i * 0.17) % 1) : flameC,
          s0: 0.26 * Math.min(1.4, sc), s1: 0, alpha: 0.85 * c.alpha, drag: 2.4, flags: P_SPIN, spin: rand(-8, 8), rot: rand(0, TAU),
        });
        break;
      default: // 'spark' — the v0.2 thruster trail
        out.spawn({
          tex: A.soft, x, y, vx: dvx * sp + c.vx * inherit, vy: dvy * sp + c.vy * inherit,
          life: (c.ab ? 0.45 : 0.32) * lifeMul, color: useAccent ? accent : flameC,
          s0: (c.ab ? 0.34 : 0.24) * sc, s1: 0.02, alpha: 0.8 * c.alpha, drag: 3,
        });
    }
  }
  return n;
}

// =============================================================================================
// Death presets
// =============================================================================================

export interface DeathHost {
  /** Expanding (or, with r1 < r0, collapsing) ring. */
  ring(x: number, y: number, r0: number, r1: number, life: number, color: number, width: number): void;
  flash(x: number, y: number, size: number, color: number, life: number, alpha: number): void;
}

export interface DeathEmitResult { particles: number; maxLife: number; rings: number }

/**
 * The preset part of a ship death (the team-coloured core burst, flash, first ring and shake are the
 * renderer's and always play). 'std' emits nothing here. Every particle / ring lives ≤ p.linger (≤ 1.5 s)
 * and at most min(70, p.particles) particles are emitted.
 */
export function emitDeathPreset(
  out: Spawner, A: FxAtlas, p: DeathParams, x: number, y: number, team: number, density: number, host: DeathHost,
): DeathEmitResult {
  const res: DeathEmitResult = { particles: 0, maxLife: 0, rings: 0 };
  if (p.preset === 'std') return res;
  const linger = Math.max(0.2, Math.min(READABILITY.deathLingerMax, p.linger));
  const budget = Math.min(READABILITY.deathParticlesMax, Math.max(0, Math.round(p.particles)));
  const n = Math.min(budget, Math.ceil(budget * Math.max(0, Math.min(1, density))));
  const rings = Math.max(0, Math.min(READABILITY.deathRingsMax, Math.round(p.rings)));
  const acc = p.accent;
  const spawn = (o: SpawnOpts) => {
    if (res.particles >= n) return;
    o.life = Math.min(o.life, linger);
    res.maxLife = Math.max(res.maxLife, o.life);
    res.particles++;
    out.spawn(o);
  };
  const ring = (r0: number, r1: number, life: number, color: number, width: number) => {
    const l = Math.min(life, linger);
    res.rings++;
    res.maxLife = Math.max(res.maxLife, l);
    host.ring(x, y, r0, r1, l, color, width);
  };
  switch (p.preset) {
    case 'shatter': { // glass shards + crystal dust
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU), k = i / n;
        if (k < 0.6) {
          const sp = rand(120, 520);
          spawn({ tex: Math.random() < 0.5 ? A.shard : A.wShard, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.55, 1) * linger,
            color: Math.random() < 0.5 ? acc : Math.random() < 0.5 ? 0xffffff : brighten(team, 0.4), s0: rand(0.45, 0.8), s1: 0.1,
            flags: P_SPIN, spin: rand(-12, 12), rot: a, drag: 1.6 });
        } else if (k < 0.85) {
          const sp = rand(60, 260);
          spawn({ tex: A.crystal, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 1) * linger, color: acc,
            s0: rand(0.25, 0.45), s1: 0, flags: P_SPIN, spin: rand(-6, 6), drag: 2 });
        } else {
          const sp = rand(400, 800);
          spawn({ tex: A.streak, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.2, 0.4), color: 0xffffff,
            s0: 0.6, s1: 0, flags: P_ORIENT | P_STRETCH, sy: 0.3, drag: 3 });
        }
      }
      for (let i = 0; i < rings; i++) ring(12, 170 + i * 70, 0.35 + i * 0.12, i ? 0xffffff : acc, 3 - i);
      break;
    }
    case 'implode': { // everything falls inward, a collapsing ring, one last spark
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU), R = rand(90, 210), life = rand(0.55, 1) * linger, sp = R / life;
        spawn({ tex: i % 3 ? A.streak : A.dot, x: x + Math.cos(a) * R, y: y + Math.sin(a) * R, vx: -Math.cos(a) * sp, vy: -Math.sin(a) * sp,
          life, color: i % 4 === 0 ? 0xffffff : i % 2 ? acc : team, s0: i % 3 ? 0.55 : 0.4, s1: 0.05, alpha: 0.9,
          flags: i % 3 ? P_ORIENT | P_STRETCH : 0, sy: 0.35 });
      }
      for (let i = 0; i < rings; i++) ring(230 - i * 60, 6, linger * (0.8 - i * 0.2), i ? team : acc, 3.5 - i);
      host.flash(x, y, 1.1, acc, Math.min(0.3, linger), 0.7);
      break;
    }
    case 'triumph': { // fireworks upward + confetti
      for (let i = 0; i < n; i++) {
        if (i % 9 < 5) {
          const a = -Math.PI / 2 + rand(-0.65, 0.65), sp = rand(300, 650);
          spawn({ tex: A.streak, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 0.9) * linger, color: i % 2 ? acc : 0xffffff,
            s0: 0.7, s1: 0.05, flags: P_ORIENT | P_STRETCH, sy: 0.4, drag: 1.6 });
        } else {
          const a = rand(0, TAU), sp = rand(80, 300);
          spawn({ tex: A.diamond, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, life: rand(0.6, 1) * linger,
            color: i % 3 ? acc : brighten(team, 0.5), s0: rand(0.3, 0.5), s1: 0.1, flags: P_SPIN, spin: rand(-10, 10), drag: 1.8 });
        }
      }
      for (let i = 0; i < rings; i++) ring(10, 150 + i * 90, 0.45 + i * 0.15, i ? 0xffffff : acc, 3 - i * 0.8);
      break;
    }
    case 'hatch': { // spore blobs + wriggling larvae, slow and lingering
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU);
        if (i % 2) {
          const sp = rand(40, 170);
          spawn({ tex: A.soft, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.6, 1) * linger, color: i % 3 ? acc : team,
            s0: rand(0.45, 0.7), s1: 0.08, alpha: 0.75, drag: 1.3 });
        } else {
          const sp = rand(90, 240);
          spawn({ tex: A.dot, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 0.95) * linger, color: brighten(acc, 0.3),
            s0: rand(0.3, 0.45), s1: 0, flags: P_SPIN, spin: rand(-14, 14), drag: 2.2 });
        }
      }
      for (let i = 0; i < rings; i++) ring(10, 120 + i * 60, 0.7 - i * 0.15, acc, 2.5);
      break;
    }
  }
  return res;
}
