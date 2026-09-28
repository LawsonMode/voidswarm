// Performance guard for the filter: every human chat line and name goes through it inside the Zone's message
// handling, so a line must cost microseconds, and no input may blow the scan up (no catastrophic backtracking —
// the matcher is a trie walk bounded by twice the longest term).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAT_MAX_LEN } from '../constants';
import { CUSTOM_LIMITS, checkName, compileCustomTerms, filterChat, type CustomTermInput, type CustomTermSet } from './filter';

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

/**
 * medianUs against a budget: when the median lands over it, measure again (at most 3 tries; the best counts). A
 * busy machine — the other test workers of a full `vitest run`, a CI neighbour — must not fail the build, while a
 * real blow-up (milliseconds, not microseconds) fails every try.
 */
function budgetUs(iters: number, run: (i: number) => void, budget: number): number {
  let best = Infinity;
  for (let k = 0; k < 3 && best >= budget; k++) best = Math.min(best, medianUs(iters, run));
  return best;
}

/**
 * The budget only catches real blow-ups (catastrophic backtracking costs milliseconds, not microseconds).
 * Shared CI runners are 1.5–2× slower than a dev box and noisy (a 79 us 'wildcard words' median failed Pages
 * CI on 2026-09-28 against the old flat 50 us), so CI (GitHub Actions sets CI=true) gets 4× headroom.
 */
const BUDGET_US = process.env.CI ? 200 : 50;

describe('performance', () => {
  it('filters a 200-character chat line in well under 50 us', () => {
    const lines = docs.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 60)
      .map((l) => `${l} ${l}`.slice(0, CHAT_MAX_LEN));
    expect(lines.length).toBeGreaterThan(100);
    expect(budgetUs(20000, (i) => { filterChat(lines[i % lines.length]); }, BUDGET_US)).toBeLessThan(BUDGET_US);
  });

  it('checks a callsign in well under 50 us', () => {
    expect(budgetUs(20000, (i) => { checkName(`Plasma_Pete_${i % 100}`); }, BUDGET_US)).toBeLessThan(BUDGET_US);
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
      const us = budgetUs(4000, () => { filterChat(line); }, BUDGET_US);
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

// ---------------------------------------------------------------------------------------------------------------
// The same budgets with a FULL host custom-term list (CUSTOM_LIMITS.maxEntries = 2000 entries)
// ---------------------------------------------------------------------------------------------------------------

/**
 * 2000 made-up, content-neutral entries: syllable tokens (2 or 3 syllables), some 'strong', some phrases, 1 in 10 a
 * number code, 1 in 5 anchored (1-2 anchors from a small pool), all three actions and scopes.
 */
function bigCustomList(): CustomTermInput[] {
  const syl = ['zor', 'blax', 'quen', 'vor', 'pik', 'drel', 'kin', 'skree', 'glim', 'mar', 'thul', 'xan', 'prok', 'vesh',
    'nib', 'quo', 'zel', 'bram', 'tov', 'yul', 'fex', 'gorp', 'wim', 'jask'];
  const tokens: string[] = [];
  for (let a = 0; a < syl.length && tokens.length < 1900; a++) {
    for (let b = 0; b < syl.length && tokens.length < 1900; b++) {
      tokens.push(syl[a] + syl[b]);
      if ((a + b) % 2 === 0) tokens.push(syl[a] + syl[b] + syl[(a * 7 + b) % syl.length]);
    }
  }
  const actions = ['block', 'mask', 'flag'] as const;
  const scopes = ['both', 'chat', 'names'] as const;
  const out: CustomTermInput[] = [];
  for (let i = 0; out.length < CUSTOM_LIMITS.maxEntries; i++) {
    const code = i % 10 === 9;
    const phrase = !code && i % 11 === 3;
    const term = code ? String(20_000 + i * 37) : phrase ? `${tokens[i % tokens.length]} ${tokens[(i * 13 + 5) % tokens.length]}` : tokens[i % tokens.length];
    const e: CustomTermInput = { term, action: actions[i % 3], scope: scopes[(i >> 1) % 3], category: `crew ${i % 17}`, id: `e${i}` };
    if (!code && !phrase && i % 7 === 0 && term.length >= 4) e.match = 'strong';
    if (i % 5 === 0) e.anchors = [tokens[(i * 3) % 50], ...(i % 10 === 0 ? [String(3000 + (i % 40))] : [])];
    out.push(e);
  }
  return out;
}

describe('performance with 2000 custom terms', () => {
  const list = bigCustomList();
  let custom: CustomTermSet | null = null;
  /**
   * The compiled 2000-entry set for a measurement, compiled once by whichever test runs first — so a test run on its
   * own (`-t`, `.only`) or after a failed compile test still measures the FULL custom list, never the built-ins only
   * (`custom: undefined` would mean "the installed set", which is none here).
   */
  const full = (): { custom: CustomTermSet } => {
    custom ??= compileCustomTerms(list).set;
    expect(custom, 'the 2000-entry set compiled').not.toBeNull();
    expect(custom!.size).toBe(CUSTOM_LIMITS.maxEntries);
    return { custom: custom! };
  };

  it('compiles 2000 entries quickly and deterministically', () => {
    const t0 = performance.now();
    const r = compileCustomTerms(list);
    const ms = performance.now() - t0;
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    custom = r.set!;
    expect(custom.size).toBe(CUSTOM_LIMITS.maxEntries);
    expect(ms).toBeLessThan(process.env.CI ? 4000 : 1000);
    expect(compileCustomTerms([...list].reverse()).set!.fingerprint).toBe(custom.fingerprint);
  });

  it('a 200-character chat line stays inside the budget', () => {
    const lines = docs.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 60)
      .map((l) => `${l} ${l}`.slice(0, CHAT_MAX_LEN));
    const opts = full();
    expect(budgetUs(20000, (i) => { filterChat(lines[i % lines.length], opts); }, BUDGET_US)).toBeLessThan(BUDGET_US);
  });

  /**
   * Worst case on purpose: EVERY word of the line is a custom term (40-56 raw hits per 200 characters, built from a
   * list where every syllable pair is an entry), so each line pays for ~20 reported hits, masking and the anchor
   * gate — about 4x the reporting work of an ordinary line (~35 us here). It guards against blow-ups (those cost
   * milliseconds), so it gets 2x the per-line budget; the ordinary budgets above and below hold at BUDGET_US.
   */
  it('lines where every word is a custom term, anchor or code stay linear (2x the per-line budget)', () => {
    const dense = list.slice(0, 400).map((e) => e.term).join(' ');
    const lines = Array.from({ length: 50 }, (_, k) => dense.slice(k * 37, k * 37 + CHAT_MAX_LEN));
    const opts = full();
    expect(filterChat(lines[0], opts).hits.length).toBeGreaterThan(10);
    expect(budgetUs(8000, (i) => { filterChat(lines[i % lines.length], opts); }, 2 * BUDGET_US)).toBeLessThan(2 * BUDGET_US);
  });

  it('a callsign check stays inside the budget', () => {
    const opts = full();
    expect(budgetUs(20000, (i) => { checkName(`Plasma_Pete_${i % 100}`, opts); }, BUDGET_US)).toBeLessThan(BUDGET_US);
    expect(budgetUs(20000, (i) => { checkName(`${list[i % 1500].term.replace(/ /g, '')}${i % 10}`.slice(0, 16), opts); }, BUDGET_US)).toBeLessThan(BUDGET_US);
  });

  it('no pathological input with the custom trie either', () => {
    const adversarial = ['a'.repeat(300), 'zorzorzor'.repeat(30), 'z o r b l a x '.repeat(20), '1l'.repeat(150), 'a**b '.repeat(60),
      '0123456789'.repeat(30), '7 3 5 1 '.repeat(30), 'qwrtypsdfghjklzxcvbnm'.repeat(15), 'zorblaxquenvorpik'.repeat(12)];
    const opts = full();
    const slow: string[] = [];
    adversarial.forEach((raw, k) => {
      const line = raw.slice(0, CHAT_MAX_LEN);
      const us = budgetUs(3000, () => { filterChat(line, opts); }, BUDGET_US);
      if (us >= BUDGET_US) slow.push(`#${k}: ${us.toFixed(1)} us`);
    });
    expect(slow).toEqual([]);
  });

  it('still scales linearly with length', () => {
    const unit = 'the quick brown zorblax jumps over the lazy quenvor 42 times ';
    const short = unit.repeat(4).slice(0, 200);
    const long = unit.repeat(16).slice(0, 800);
    const opts = full();
    const us200 = medianUs(8000, () => { filterChat(short, opts); });
    const us800 = medianUs(2000, () => { filterChat(long, opts); });
    expect(us800).toBeLessThan(us200 * 8);
  });
});
