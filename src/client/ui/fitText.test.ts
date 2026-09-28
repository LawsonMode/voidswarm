// Shrink-to-fit math for long server hosts in the title screen buttons / link (fitText.ts).
import { describe, expect, it } from 'vitest';
import { FIT_MIN_PX, FIT_MIN_SCALE, fitFloor, fitScale } from './fitText';

describe('fitText: shrink a long label to fit, then ellipsize', () => {
  it('a label that fits keeps its size', () => {
    expect(fitScale(120, 200)).toBe(1);
    expect(fitScale(200, 200)).toBe(1);
  });

  it('a label a bit too wide shrinks just enough to fit (with a 1 px margin)', () => {
    const k = fitScale(300, 240);
    expect(k).toBeLessThan(1);
    expect(300 * k).toBeLessThanOrEqual(239);
    expect(300 * k).toBeGreaterThan(237);
  });

  it('a label far too wide stops at the floor (CSS ellipsis takes over from there)', () => {
    expect(fitScale(1000, 200)).toBe(FIT_MIN_SCALE);
    expect(fitScale(1000, 200, 0.8)).toBe(0.8);
  });

  it('the floor never goes below FIT_MIN_PX, and never above 1', () => {
    expect(fitFloor(20)).toBe(FIT_MIN_SCALE); // 20 × 0.62 = 12.4 px ≥ 8.5
    expect(fitFloor(11.25) * 11.25).toBeCloseTo(FIT_MIN_PX, 6); // the title buttons' host text
    expect(fitFloor(6)).toBe(1); // already below the px floor: never shrink further
    expect(fitFloor(0)).toBe(FIT_MIN_SCALE);
  });

  it('bad sizes (hidden, not laid out) never shrink', () => {
    expect(fitScale(0, 200)).toBe(1);
    expect(fitScale(300, 0)).toBe(1);
    expect(fitScale(Number.NaN, 200)).toBe(1);
  });
});
