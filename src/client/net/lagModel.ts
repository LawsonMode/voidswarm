// Lag Lab: a model of a slow, uneven network for offline play (docs/LAG-LAB.md). Pure and DOM-free so it is unit tested.
//
// Voidswarm talks over a WebSocket, which is TCP: a "lost" packet is never skipped, it is re-sent, and everything
// behind it waits (head-of-line blocking). So loss shows up as a stall followed by a burst, not as a missing update.
// That is the model here: messages stay in order, each gets one-way delay + jitter, and a lost one adds a retransmit
// timeout to itself and to everything queued behind it.

export interface LagSettings {
  /** Extra round-trip time in ms (half added each way). */
  rttMs: number;
  /** Extra random delay per message, 0..jitterMs, in ms. */
  jitterMs: number;
  /** Chance (percent) that a message needs a retransmit. */
  lossPct: number;
}

export const NO_LAG: Readonly<LagSettings> = { rttMs: 0, jitterMs: 0, lossPct: 0 };
export const LAG_LIMITS = { rttMs: { min: 0, max: 600, step: 10 }, jitterMs: { min: 0, max: 150, step: 5 }, lossPct: { min: 0, max: 20, step: 1 } } as const;
/** TCP waits at least this long before re-sending (RFC 6298's 1 s is shortened so the effect is playable). */
export const MIN_RETRANSMIT_MS = 200;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

export function clampLag(s: Partial<LagSettings>): LagSettings {
  return {
    rttMs: clamp(s.rttMs ?? 0, LAG_LIMITS.rttMs.min, LAG_LIMITS.rttMs.max),
    jitterMs: clamp(s.jitterMs ?? 0, LAG_LIMITS.jitterMs.min, LAG_LIMITS.jitterMs.max),
    lossPct: clamp(s.lossPct ?? 0, LAG_LIMITS.lossPct.min, LAG_LIMITS.lossPct.max),
  };
}

export function lagActive(s: LagSettings): boolean {
  return s.rttMs > 0 || s.jitterMs > 0 || s.lossPct > 0;
}

/** One direction of the link (client to server, or back). */
export class LagChannel {
  /** Messages that needed a retransmit since this channel was made. */
  stalls = 0;
  private lastDeliverAt = 0;

  constructor(private settings: () => LagSettings, private rng: () => number = Math.random) {}

  /** Milliseconds to wait before delivering a message sent at `nowMs` (0 = deliver now). Never reorders. */
  schedule(nowMs: number): number {
    const s = this.settings();
    let delay = 0;
    if (lagActive(s)) {
      delay = s.rttMs / 2 + this.rng() * s.jitterMs;
      if (s.lossPct > 0 && this.rng() * 100 < s.lossPct) {
        this.stalls++;
        delay += Math.max(MIN_RETRANSMIT_MS, 2 * s.rttMs);
      }
    }
    const at = Math.max(this.lastDeliverAt, nowMs + delay);
    this.lastDeliverAt = at;
    const wait = at - nowMs;
    return wait < 0.5 ? 0 : wait;
  }
}
