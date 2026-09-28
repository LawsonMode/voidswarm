// The HUD's one shared banner queue (docs/v0.3-proposal.md §9 CLIENT, HUD layout rule): wave / boss / level
// banners, loot banners and (M3) objective banners take turns in the same spot below the top strip. Pure (no DOM),
// unit-tested.

export interface Banner {
  text: string;
  /** Visual style: 'wave' | 'boss' | 'level' | 'loot' | 'obj' | 'obj-good' | 'obj-bad' | 'obj-alert'. */
  kind: string;
  /** Loot rarity (0..4) for the loot style's colour. */
  rarity?: number;
  /** v0.3 M3 objective banners: the accent colour (a team / pilot colour), as CSS. */
  color?: string;
  ms: number;
  /** Higher interrupts lower. Equal or lower waits its turn. */
  priority: number;
}

interface Entry extends Banner { at: number; seq: number }

/** Waiting banners kept at most (the oldest lowest-priority one is dropped). */
export const BANNER_QUEUE_MAX = 4;
/** A queued banner older than this is dropped instead of shown late. */
export const BANNER_STALE_MS = 6000;

export class BannerQueue {
  private cur: Entry | null = null;
  private until = 0;
  private waiting: Entry[] = [];
  private seq = 0;

  push(b: Banner, now: number): void {
    const e: Entry = { ...b, at: now, seq: ++this.seq };
    if (!this.cur || now >= this.until) { this.show(e, now); return; }
    if (e.priority > this.cur.priority) { this.show(e, now); return; }
    this.waiting.push(e);
    if (this.waiting.length > BANNER_QUEUE_MAX) {
      // Drop the lowest-priority, oldest entry.
      let drop = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        const w = this.waiting[i], d = this.waiting[drop];
        if (w.priority < d.priority || (w.priority === d.priority && w.seq < d.seq)) drop = i;
      }
      this.waiting.splice(drop, 1);
    }
  }

  /** The banner on screen at `now` (advances the queue), or null. */
  current(now: number): Banner | null {
    if (this.cur && now < this.until) return this.cur;
    this.cur = null;
    this.waiting = this.waiting.filter((w) => now - w.at <= BANNER_STALE_MS);
    if (!this.waiting.length) return null;
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      const w = this.waiting[i], b = this.waiting[best];
      if (w.priority > b.priority || (w.priority === b.priority && w.seq < b.seq)) best = i;
    }
    const [next] = this.waiting.splice(best, 1);
    this.show(next, now);
    return this.cur;
  }

  /** Identity of the banner on screen (changes whenever a new one starts). 0 = none. */
  get currentSeq(): number { return this.cur?.seq ?? 0; }

  clear(): void {
    this.cur = null;
    this.until = 0;
    this.waiting = [];
  }

  private show(e: Entry, now: number): void {
    this.cur = e;
    this.until = now + Math.max(200, e.ms);
  }
}
