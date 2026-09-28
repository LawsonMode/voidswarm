// ARCHITECT: frozen hash utils (docs/v0.3-proposal.md §8.6). Grant RNG + floor seeds depend on these values.
import { describe, expect, it } from 'vitest';
import { fnv1a, hash32 } from './hash';

describe('fnv1a', () => {
  it('matches the reference 32-bit FNV-1a vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('is an unsigned 32-bit integer and deterministic', () => {
    const k = 'boot1:7#acct-42#0|acct-42';
    const h = fnv1a(k);
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
    expect(fnv1a(k)).toBe(h);
    expect(fnv1a(k + '1')).not.toBe(h);
  });
});

describe('hash32', () => {
  it('is deterministic, unsigned 32-bit and order-sensitive', () => {
    const a = hash32(1234, 3, 1);
    expect(hash32(1234, 3, 1)).toBe(a);
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true);
    expect(hash32(1, 3, 1234)).not.toBe(a);
    expect(hash32(1234, 4, 1)).not.toBe(a);
    expect(hash32()).toBe(0x9e3779b9);
  });

  it('spreads consecutive floors (no collisions over 200 seeds × 6 floors)', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 200; seed++) for (let f = 1; f <= 6; f++) seen.add(hash32(seed, f, 1));
    expect(seen.size).toBe(1200);
  });
});
