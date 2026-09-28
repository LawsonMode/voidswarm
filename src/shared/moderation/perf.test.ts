// Performance guard for the filter: every human chat line and name goes through it inside the Zone's message
// handling, so a line must cost microseconds, and no input may blow the scan up (no catastrophic backtracking —
// the matcher is a trie walk bounded by twice the longest term).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAT_MAX_LEN } from '../constants';
import { checkName, filterChat } from './filter';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = readFileSync(path.resolve(here, '../../../ARCHITECTURE.md'), 'utf8');

/** Median µs per call over `iters` (a median, not a mean: a GC pause must not fail the build). */
function medianUs(iters: number, run: (i: number) => void): number {
  for (let i = 0; i < Math.min(iters, 2000); i++) run(i); // warm up (the lists compile on first use)
  const runs = 7;
  const each = Math.max(1, Math.floor(iters / runs));
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    for (let i = 0; i < each; i++) run(i);
    times.push(((performance.now() - t0) * 1000) / each);
  }
  return times.sort((a, b) => a - b)[runs >> 1];
}

/** CI machines are slower than a dev box; the budget is generous so the test only catches real blow-ups. */
const BUDGET_US = 50;

describe('performance', () => {
  it('filters a 200-character chat line in well under 50 us', () => {
    const lines = docs.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 60)
      .map((l) => `${l} ${l}`.slice(0, CHAT_MAX_LEN));
    expect(lines.length).toBeGreaterThan(100);
    expect(medianUs(20000, (i) => { filterChat(lines[i % lines.length]); })).toBeLessThan(BUDGET_US);
  });

  it('checks a callsign in well under 50 us', () => {
    expect(medianUs(20000, (i) => { checkName(`Plasma_Pete_${i % 100}`); })).toBeLessThan(BUDGET_US);
  });

  it('has no pathological input: every adversarial 200-character line stays inside the budget', () => {
    const adversarial: Record<string, string> = {
      'single letter': 'a'.repeat(300),
      'two letters': 'ab'.repeat(150),
      'leet digits': '1l'.repeat(150),
      'wildcards': '*'.repeat(300),
      'wildcard words': 'a**b '.repeat(60),
      'wildcard chains': 'a*b*c*d*e '.repeat(30),
      'spaced letters': 'a s '.repeat(75),
      'dotted letters': 'a.b.'.repeat(75),
      'exclamations': 'a!'.repeat(150),
      'pipes': 'a|'.repeat(150),
      'zero width': 'a​'.repeat(150),
      'combining marks': 'á'.repeat(150),
      'look-alikes': 'ас'.repeat(150),
      'emoji': '\u{1F600}a'.repeat(100),
      'camelCase': 'AbCd'.repeat(75),
      'mixed evasion': 'f​u*c k1 '.repeat(30),
      'no letters': '0123456789'.repeat(30),
      'one long word': 'qwrtypsdfghjklzxcvbnm'.repeat(15),
    };
    const slow: string[] = [];
    for (const [name, raw] of Object.entries(adversarial)) {
      const line = raw.slice(0, CHAT_MAX_LEN);
      const us = medianUs(4000, () => { filterChat(line); });
      if (us >= BUDGET_US) slow.push(`${name}: ${us.toFixed(1)} us`);
    }
    expect(slow).toEqual([]);
  });

  it('scales linearly with length (4x the input is not 16x the work)', () => {
    const unit = 'the quick brown fox jumps over the lazy dog 42 times ';
    const short = unit.repeat(4).slice(0, 200);
    const long = unit.repeat(16).slice(0, 800);
    const us200 = medianUs(8000, () => { filterChat(short); });
    const us800 = medianUs(2000, () => { filterChat(long); });
    expect(us800).toBeLessThan(us200 * 8); // linear would be 4x; 8x leaves room for noise
  });

  it('the hard input cap bounds the very worst case', () => {
    const huge = 'a s s '.repeat(4000);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) filterChat(huge);
    expect((performance.now() - t0) / 20).toBeLessThan(10); // ms per call
  });
});
