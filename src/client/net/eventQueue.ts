// Snapshot events waiting for the render clock. Pure (no DOM), unit-tested.
// Each batch is released once, when the render tick reaches it or it has waited RELEASE_MS.
// Frames are not drawn while the tab is hidden, but snapshots keep arriving, so the queue is
// bounded by age: batches older than STALE_MS are dropped unplayed instead of flooding one frame.
import type { GameEvent } from '../../shared/types';

/** Release a batch after this long even if the render clock hasn't reached its tick. */
export const RELEASE_MS = 250;
/** Batches older than this are stale (no sound / FX / kill-feed row for them). */
export const STALE_MS = 1000;
/** Hard cap on queued batches (offline sends 60 snapshots/s, so ~1 s of them). */
export const MAX_BATCHES = 90;

interface Batch { tick: number; at: number; events: GameEvent[] }

export class EventQueue {
  private q: Batch[] = [];
  private head = 0;

  get size(): number { return this.q.length - this.head; }

  clear(): void { this.q.length = 0; this.head = 0; }

  /**
   * Keep only the queued events that pass `keep` (batches left empty are dropped). v0.3 rift floor swap: events
   * still waiting from the old floor lose their positional ones (the old map's coordinates) but keep the global
   * ones (kill feed, level-ups).
   */
  retain(keep: (e: GameEvent) => boolean): void {
    const out: Batch[] = [];
    for (let i = this.head; i < this.q.length; i++) {
      const b = this.q[i];
      const events = b.events.filter(keep);
      if (events.length) out.push({ tick: b.tick, at: b.at, events });
    }
    this.q = out;
    this.head = 0;
  }

  push(tick: number, atMs: number, events: GameEvent[]): void {
    if (!events.length) return;
    this.dropStale(atMs);
    this.q.push({ tick, at: atMs, events });
    while (this.size > MAX_BATCHES) this.head++;
    this.compact();
  }

  /** Events due at render tick `rt` (fresh ones only), oldest first. */
  drain(rt: number, nowMs: number): GameEvent[] {
    this.dropStale(nowMs);
    const out: GameEvent[] = [];
    while (this.head < this.q.length) {
      const b = this.q[this.head];
      if (!(b.tick <= rt + 0.5 || nowMs - b.at > RELEASE_MS)) break;
      for (const e of b.events) out.push(e);
      this.head++;
    }
    this.compact();
    return out;
  }

  private dropStale(nowMs: number): void {
    while (this.head < this.q.length && nowMs - this.q[this.head].at > STALE_MS) this.head++;
  }

  private compact(): void {
    if (this.head === this.q.length) { this.q.length = 0; this.head = 0; }
    else if (this.head > 64 && this.head * 2 > this.q.length) { this.q.splice(0, this.head); this.head = 0; }
  }
}
