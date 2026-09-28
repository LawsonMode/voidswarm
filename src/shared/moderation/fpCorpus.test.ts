// False-positive corpus (fpCorpus.ts): 1500+ realistic PG game-chat lines and 500+ callsigns built from the game's
// own vocabulary, first names, US / Idaho places, sports teams and PG trash talk. Every item must pass the built-in
// lists — no mask, no block, no hit at all — in both strictness modes. A failure lists the offending lines (they are
// clean text, so they may be printed); fix a genuine false positive with an allow word or a mode change, never by
// deleting a protective term without a note in docs/MODERATION.md.
import { describe, expect, it } from 'vitest';
import { checkName, filterChat } from './filter';
import { fpCallsigns, fpChatLines, fpNumberedCallsigns } from './fpCorpus';

const lines = fpChatLines();
const names = fpCallsigns();
const numbered = fpNumberedCallsigns();

describe('false-positive corpus (built-in lists)', () => {
  it('is large: 1500+ distinct chat lines and 500+ distinct callsigns', () => {
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.length).toBeGreaterThanOrEqual(1500);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(500);
    expect(names.every((n) => n.length <= 16)).toBe(true);
  });

  it('every chat line passes untouched (strict and standard)', () => {
    const bad = lines.filter((l) => {
      const r = filterChat(l, { custom: null });
      return r.action !== 'pass' || r.hits.length > 0 || r.text !== l || filterChat(l, { strictness: 'standard', custom: null }).action !== 'pass';
    });
    expect(bad).toEqual([]);
  });

  it('every callsign / room name is a legal name, and passes in chat', () => {
    const bad = names.filter((n) => !checkName(n, { custom: null }).ok || filterChat(`gg ${n}`, { custom: null }).action !== 'pass');
    expect(bad).toEqual([]);
  });

  it('every name + number callsign (60,000+: "Juliana1", "Owyhee11", "Aspen1st", "5Picasso") is a legal name', () => {
    // strict mode refuses a superset of what standard refuses, so strict alone covers both
    expect(numbered.length).toBeGreaterThan(60_000);
    const bad = numbered.filter((n) => !checkName(n, { custom: null }).ok);
    expect(bad).toEqual([]);
  });
});
