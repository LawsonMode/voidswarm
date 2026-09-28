// Title logo effects that need script: the one-time glitch / scanline intro, and the glow that pulses on
// the beat while the title music plays. (The chrome gradient and the shine sweep are pure CSS.)
//
// Intro: held (logo hidden, .intro-wait) until the display font has loaded (or 1.5 s passed) and the page
// has settled (3 frames in a row under 50 ms, or 2.5 s passed), so the glitch neither plays during the
// start-up stall nor swaps fonts halfway through.
//
// Beat: only with a real beat source. In dev builds main.ts exposes the MusicDirector as
// `window.__voidswarm.musicDirector`; its getState() gates the pulse (running, not muted, scene 'title'),
// supplies the bpm, and each bar change re-locks the phase to that downbeat. Without it (production) the
// glow only breathes slowly: a free-running pulse would sit at an arbitrary phase against the real kick.
// The glow is a separate, pre-blurred layer: only its opacity changes per frame (compositor-only).
import { approach, beatPulse, beatsSince, TITLE_BPM } from './sceneMath';

interface MusicStateLike { running?: boolean; muted?: boolean; scene?: string | null; bpm?: number; bar?: number }
interface MusicHook { getState(): MusicStateLike }

function musicHook(): MusicHook | null {
  try {
    const w = window as unknown as { __voidswarm?: { musicDirector?: unknown } };
    const d = w.__voidswarm?.musicDirector as Partial<MusicHook> | null | undefined;
    return d && typeof d.getState === 'function' ? (d as MusicHook) : null;
  } catch {
    return null;
  }
}

/** The display font the wordmark is set in (styles.css .logo). */
const LOGO_FONT = '900 1em Orbitron';
const FONT_WAIT_MS = 1500;
/** After the font: frames this short, this many in a row, mean the page has settled. */
const SETTLED_FRAME_MS = 50;
const SETTLED_FRAMES = 3;
const SETTLE_WAIT_MS = 2500;
const INTRO_MS = 1600;

let introPlayed = false;

export class LogoFx {
  private origin = performance.now();
  private bpm = TITLE_BPM;
  private lastBar = -1;
  private env = 0;
  private introTimer: ReturnType<typeof setTimeout> | null = null;
  private waitRaf = 0;
  private waiting = false;
  private destroyed = false;

  constructor(private readonly wrap: HTMLElement, private readonly glow: HTMLElement, private readonly reduced: () => boolean) {}

  /** The glitch / scanline intro, once per page load (never with reduced motion), once the page is ready for it. */
  playIntro(): void {
    if (introPlayed || this.waiting || this.destroyed || this.reduced()) return;
    this.waiting = true;
    this.wrap.classList.add('intro-wait');
    void this.fontReady().then(() => this.waitForSettled());
  }

  private fontReady(): Promise<void> {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
    const load = fonts.load(LOGO_FONT).then(() => undefined, () => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_MS));
    return Promise.race([load, timeout]);
  }

  private waitForSettled(): void {
    if (this.destroyed) return;
    const start = performance.now();
    let last = 0, good = 0;
    const tick = (now: number): void => {
      this.waitRaf = 0;
      if (this.destroyed) return;
      if (last) good = now - last < SETTLED_FRAME_MS ? good + 1 : 0;
      last = now;
      if (good >= SETTLED_FRAMES || now - start > SETTLE_WAIT_MS) { this.startIntro(); return; }
      this.waitRaf = requestAnimationFrame(tick);
    };
    this.waitRaf = requestAnimationFrame(tick);
  }

  private startIntro(): void {
    this.waiting = false;
    this.wrap.classList.remove('intro-wait');
    if (this.reduced()) return;
    introPlayed = true;
    this.wrap.classList.add('intro');
    this.introTimer = setTimeout(() => { this.wrap.classList.remove('intro'); this.introTimer = null; }, INTRO_MS);
  }

  /** Per animated frame (driven by the title scene's loop). */
  frame(now: number, dt: number): void {
    if (this.destroyed) return;
    if (this.reduced()) { this.glow.style.opacity = ''; return; }
    let playing = false;
    const hook = musicHook();
    if (hook) {
      let s: MusicStateLike | null = null;
      try { s = hook.getState(); } catch { s = null; }
      playing = !!s && !!s.running && !s.muted && s.scene === 'title';
      if (s && typeof s.bpm === 'number' && s.bpm > 0) this.bpm = s.bpm;
      if (s && typeof s.bar === 'number' && s.bar !== this.lastBar) {
        if (this.lastBar >= 0) this.origin = now; // a bar line just passed: lock the phase to it
        this.lastBar = s.bar;
      }
    }
    this.env = approach(this.env, playing ? 1 : 0, dt, 0.8);
    const b = beatsSince(now, this.origin, this.bpm);
    const beat = Math.floor(b);
    const pulse = this.env > 0.01 ? beatPulse(b - beat, ((beat % 4) + 4) % 4 === 0) * this.env : 0;
    // resting glow 0.55 (a slow breath), up to 1 on a downbeat
    const rest = 0.5 + 0.06 * Math.sin(now / 1400);
    this.glow.style.opacity = Math.min(1, rest + 0.45 * pulse).toFixed(3);
  }

  destroy(): void {
    this.destroyed = true;
    this.waiting = false;
    if (this.waitRaf) { cancelAnimationFrame(this.waitRaf); this.waitRaf = 0; }
    if (this.introTimer) { clearTimeout(this.introTimer); this.introTimer = null; }
    this.wrap.classList.remove('intro', 'intro-wait');
    this.glow.style.opacity = '';
  }
}
