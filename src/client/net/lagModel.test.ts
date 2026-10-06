import { describe, expect, it } from 'vitest';
import { clampLag, LagChannel, lagActive, MIN_RETRANSMIT_MS, NO_LAG, type LagSettings } from './lagModel';

function chan(s: LagSettings, rolls: number[] = []) {
  let i = 0;
  return new LagChannel(() => s, () => rolls[i++ % Math.max(1, rolls.length)] ?? 0);
}

describe('lagModel', () => {
  it('no lag delivers immediately and counts no stalls', () => {
    const c = chan({ ...NO_LAG });
    expect(c.schedule(100)).toBe(0);
    expect(c.stalls).toBe(0);
    expect(lagActive(NO_LAG)).toBe(false);
  });

  it('adds half the round trip each way plus jitter', () => {
    expect(chan({ rttMs: 200, jitterMs: 0, lossPct: 0 }).schedule(0)).toBe(100);
    expect(chan({ rttMs: 200, jitterMs: 40, lossPct: 0 }, [0.5]).schedule(0)).toBe(120);
  });

  it('never reorders: a fast message waits behind a slow one', () => {
    const c = chan({ rttMs: 0, jitterMs: 100, lossPct: 0 }, [1, 0]);
    expect(c.schedule(0)).toBe(100);        // delivered at 100
    expect(c.schedule(10)).toBe(90);        // would be 10, held until 100
  });

  it('a lost message waits a retransmit timeout and blocks the ones behind it', () => {
    // rolls: jitter 0, loss roll 0 (< 50% loss) for the first; second is clean
    const c = chan({ rttMs: 100, jitterMs: 0, lossPct: 50 }, [0, 0, 0, 0.99]);
    const first = c.schedule(0);
    expect(first).toBe(50 + Math.max(MIN_RETRANSMIT_MS, 200));
    expect(c.stalls).toBe(1);
    expect(c.schedule(5)).toBe(first - 5);  // head-of-line blocking
  });

  it('loss alone (no extra ping) still stalls for the minimum retransmit time', () => {
    const c = chan({ rttMs: 0, jitterMs: 0, lossPct: 100 }, [0, 0]);
    expect(c.schedule(0)).toBe(MIN_RETRANSMIT_MS);
  });

  it('once the backlog clears and lag is off, delivery is immediate again', () => {
    const s: LagSettings = { rttMs: 100, jitterMs: 0, lossPct: 0 };
    const c = new LagChannel(() => s, () => 0);
    expect(c.schedule(0)).toBe(50);
    s.rttMs = 0;
    expect(c.schedule(10)).toBe(40);        // still behind the queued one
    expect(c.schedule(60)).toBe(0);
  });

  it('clamps and sanitises settings', () => {
    expect(clampLag({ rttMs: 9999, jitterMs: -5, lossPct: NaN })).toEqual({ rttMs: 600, jitterMs: 0, lossPct: 0 });
  });
});
