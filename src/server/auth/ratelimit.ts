// OWNER: AUTH agent. In-memory sliding-window rate limiter (per key, e.g. client IP).

/** Default cap on tracked keys per limiter (~10 MB worst case). */
export const DEFAULT_MAX_KEYS = 50_000;

/**
 * A slot held by `reserve()`. It counts toward the limit from the moment it is reserved. Settle it
 * exactly once (later calls are no-ops): `commit()` turns it into a hit, `release()` gives it back.
 */
export interface LimiterSlot {
  /** Count the attempt as a hit, timestamped now (e.g. the login failed). */
  commit(): void;
  /** Hand the slot back without counting anything (e.g. the login succeeded). */
  release(): void;
}

export class SlidingWindowLimiter {
  /** Kept in least-recently-recorded-first order (a key moves to the end on every record). */
  private readonly hits = new Map<string, number[]>();
  /**
   * Slots reserved but not yet settled, per key. Only in-flight attempts live here (an entry is
   * deleted when its count drops to 0), so its size is bounded by concurrent requests, not by keys.
   */
  private readonly held = new Map<string, number>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number,
    readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  /** Timestamps still inside the window for `key` (prunes older ones in place). */
  private live(key: string, t: number): number[] | undefined {
    const arr = this.hits.get(key);
    if (!arr) return undefined;
    const cutoff = t - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i]! <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length === 0) { this.hits.delete(key); return undefined; }
    return arr;
  }

  /**
   * 0 if another hit is allowed right now, else ms until a slot frees up. Held (reserved) slots count
   * as hits made now, since each of them may still be committed.
   */
  blockedFor(key: string): number {
    const t = this.now();
    const arr = this.live(key, t);
    const count = (arr?.length ?? 0) + (this.held.get(key) ?? 0);
    if (count < this.max) return 0;
    // Hits are oldest-first; the one at index count-max has to age out before the count drops below max.
    const i = count - this.max;
    return arr && i < arr.length ? Math.max(1, arr[i]! + this.windowMs - t) : this.windowMs;
  }

  /**
   * Check and hold one slot in one synchronous step, so concurrent callers can never all pass the
   * check before any of them is counted (the check-then-record-after-an-await race). Returns the retry
   * delay (ms) when blocked, else the held slot, which the caller must settle (use try/finally).
   */
  reserve(key: string): LimiterSlot | number {
    const wait = this.blockedFor(key);
    if (wait > 0) return wait;
    this.held.set(key, (this.held.get(key) ?? 0) + 1);
    let open = true;
    const settle = (hit: boolean): void => {
      if (!open) return;
      open = false;
      const left = (this.held.get(key) ?? 1) - 1;
      if (left > 0) this.held.set(key, left);
      else this.held.delete(key);
      if (hit) this.record(key);
    };
    return { commit: () => settle(true), release: () => settle(false) };
  }

  /**
   * Record a hit unconditionally. O(1): over `maxKeys`, the least recently recorded keys are evicted
   * (never a full scan per hit). A key under active attack keeps being recorded, so it stays at the
   * back and is the last to go.
   */
  record(key: string): void {
    const t = this.now();
    const arr = this.live(key, t) ?? [];
    arr.push(t);
    this.hits.delete(key); // re-insert → most recently recorded
    this.hits.set(key, arr);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value as string;
      this.hits.delete(oldest);
    }
  }

  /** Record a hit if under the limit. Returns 0 if allowed (and recorded), else the retry delay (ms). */
  take(key: string): number {
    const wait = this.blockedFor(key);
    if (wait === 0) this.record(key);
    return wait;
  }

  /**
   * Forget a key's recorded hits (e.g. clear failure counts after a successful login). Slots other
   * in-flight attempts still hold are kept: they settle on their own.
   */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Unsettled reserved slots across all keys (diagnostics/tests; 0 when nothing is in flight). */
  get heldSlots(): number {
    let n = 0;
    for (const c of this.held.values()) n += c;
    return n;
  }

  /** Drop keys whose hits have all aged out (bounds memory; run periodically, not per hit). */
  sweep(): void {
    const t = this.now();
    for (const key of [...this.hits.keys()]) this.live(key, t);
  }

  get size(): number {
    return this.hits.size;
  }
}
