// Frame-budget governor for the Title attract scene (pure, no DOM).
// Feed it every frame's draw time and frame interval; it steps the quality level down when the scene is
// over budget (or the page is dropping frames) and back up, slowly and with backoff, when there is room.

export const QUALITY_MAX = 2;

export interface QualityOptions {
  /** Draw-time budget per frame, ms. */
  budgetMs: number;
  /** Frame interval that counts as "dropping frames", ms. */
  slowFrameMs: number;
  /** Seconds over budget before stepping down. */
  downAfterSec: number;
  /** Seconds comfortably under budget before stepping up (doubles after every step down). */
  upAfterSec: number;
  /** Frames ignored at start-up (cache builds, JIT warm-up). */
  warmupFrames: number;
}

// slowFrameMs 19 (≈ 52 fps): the draw time only counts script, so a GPU-bound page (glass blur, CSS
// animations, a software canvas) shows up only in the frame interval. 24 let a steady 48 fps through.
export const DEFAULT_QUALITY: QualityOptions = {
  budgetMs: 2, slowFrameMs: 19, downAfterSec: 0.75, upAfterSec: 6, warmupFrames: 30,
};

export class QualityGovernor {
  level: number;
  private readonly o: QualityOptions;
  private emaDraw = 0;
  private emaFrame = 1000 / 60;
  private frames = 0;
  private overSec = 0;
  private underSec = 0;
  private downs = 0;

  constructor(start = QUALITY_MAX, opts: Partial<QualityOptions> = {}) {
    this.o = { ...DEFAULT_QUALITY, ...opts };
    this.level = Math.max(0, Math.min(QUALITY_MAX, Math.round(start)));
  }

  get drawMs(): number { return this.emaDraw; }
  get frameMs(): number { return this.emaFrame; }

  /** Returns true when the level changed. Hiccups (tab switch, breakpoint) longer than 250 ms are ignored. */
  sample(drawMs: number, frameMs: number): boolean {
    if (!(frameMs > 0) || frameMs > 250 || !Number.isFinite(drawMs)) return false;
    this.frames++;
    if (this.frames === 1) { this.emaDraw = drawMs; this.emaFrame = frameMs; }
    this.emaDraw += (drawMs - this.emaDraw) * 0.1;
    this.emaFrame += (frameMs - this.emaFrame) * 0.1;
    if (this.frames <= this.o.warmupFrames) return false;
    const sec = frameMs / 1000;
    const over = this.emaDraw > this.o.budgetMs || this.emaFrame > this.o.slowFrameMs;
    const roomy = this.emaDraw < this.o.budgetMs * 0.45 && this.emaFrame < 18;
    if (over) {
      this.underSec = 0;
      this.overSec += sec;
      if (this.overSec >= this.o.downAfterSec && this.level > 0) {
        this.level--;
        this.downs++;
        this.overSec = 0;
        // Let the lower level show its own cost before judging it.
        this.emaDraw *= 0.6;
        return true;
      }
      return false;
    }
    this.overSec = Math.max(0, this.overSec - sec * 0.5);
    if (!roomy || this.level >= QUALITY_MAX) { this.underSec = 0; return false; }
    this.underSec += sec;
    if (this.underSec >= this.o.upAfterSec * 2 ** this.downs) {
      this.level++;
      this.underSec = 0;
      return true;
    }
    return false;
  }
}
