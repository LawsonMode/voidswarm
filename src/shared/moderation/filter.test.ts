import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOT_CALLSIGNS } from '../room/util';
import { builtinDiagnostics, compiled, mergeTermGroups, type TermInfo } from './engine';
import { FilterHit, checkName, filterChat, foldText, listStats, parseStrictness } from './filter';
import { ALLOW_WORDS, NUMERIC_TERMS, rot13, rot5, type TermGroup } from './lists';

// Offensive test inputs are never spelled out here: they are generated from the (ROT13) list itself, or written
// ROT13-encoded and decoded with R().
const R = rot13;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

const terms: readonly TermInfo[] = compiled().terms;
const chatTerms = terms.filter((t) => !t.nameOnly);
const nameOnlyTerms = terms.filter((t) => t.nameOnly);
const words = chatTerms.filter((t) => !t.term.includes(' '));
const phrases = chatTerms.filter((t) => t.term.includes(' '));
const expected = (t: TermInfo): 'block' | 'mask' => (t.tier === 'block' ? 'block' : 'mask');
const SEVERITY: Readonly<Record<string, number>> = { pass: 0, mask: 1, block: 2 };
/** A variant may come back MORE severe than its own term (spelling one out letter by letter can spell another). */
const atLeast = (got: string, want: 'block' | 'mask'): boolean => SEVERITY[got] >= SEVERITY[want];
const allowKeys = ALLOW_WORDS.map((w) => w.toLowerCase().replace(/[^a-z]/g, ''));
/**
 * A generated variant that happens to spell an allowlisted clean word is not a test case: "spic" + "ing" is
 * "spicing", and a repeat variant of a 3-letter term can collapse onto one ("wo…op" → "woop", "an…al" → "annal").
 */
const spellsAllowed = (s: string): boolean => {
  const l = s.toLowerCase().replace(/[^a-z]/g, '');
  const collapsed = l.replace(/(.)\1+/g, '$1$1');
  return allowKeys.some((a) => l.includes(a) || collapsed.includes(a) || collapsed.replace(/(.)\1+/g, '$1').includes(a));
};

// --- variant generators --------------------------------------------------------------------------------------
const cap = (w: string): string => w[0].toUpperCase() + w.slice(1);
const alternating = (w: string): string => [...w].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
const joinWith = (w: string, sep: string): string => [...w].join(sep);
const shift = (w: string, base: number): string => [...w].map((c) => String.fromCodePoint(base + c.charCodeAt(0) - 97)).join('');
const HOMOGLYPH: Readonly<Record<string, string>> = {
  a: 'а', b: 'в', c: 'с', d: 'ԁ', e: 'е', g: 'ց', h: 'һ', i: 'і', j: 'ј',
  k: 'к', l: 'ӏ', m: 'м', n: 'п', o: 'о', p: 'р', q: 'ԛ', r: 'г', s: 'ѕ',
  t: 'т', u: 'ս', w: 'ԝ', x: 'х', y: 'у', z: 'ᴢ',
};
const LEET: Readonly<Record<string, string>> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', l: '1', b: '8', g: '9' };
/** Leet every letter after the first (the first stays a real letter): "sh1t". */
const leetInner = (w: string): string => w[0] + [...w.slice(1)].map((c) => LEET[c] ?? c).join('');
const homoglyph = (w: string): string => [...w].map((c) => HOMOGLYPH[c] ?? c).join('');

function wordVariants(w: string): [string, string][] {
  const v: [string, string][] = [
    ['plain', w], ['upper', w.toUpperCase()], ['title', cap(w)], ['alternating case', alternating(w)],
    ['spaced', joinWith(w, ' ')], ['double-spaced', joinWith(w, '  ')], ['dotted', joinWith(w, '.')],
    ['underscored', joinWith(w, '_')], ['dashed', joinWith(w, '-')], ['zero-width', joinWith(w, '​')],
    ['soft hyphen', joinWith(w, '­')], ['word joiner', joinWith(w, '⁠')], ['fullwidth', shift(w, 0xFF41)],
    ['math bold', shift(w, 0x1D41A)], ['circled', shift(w, 0x24D0)], ['look-alikes', homoglyph(w)],
    ['repeated letter', w[0] + w[1].repeat(6) + w.slice(2)], ['in a sentence', `you are such a ${w} lol`],
    ['exclaimed', `${w}!!!`], ['quoted', `"${w}"`], ['combining marks', [...w].map((c) => c + '́').join('')],
  ];
  const leet = leetInner(w);
  if (leet !== w) v.push(['leet', leet]);
  return v;
}

describe('bypass corpus: every listed term, every evasion', () => {
  it('has a thorough list (counts only)', () => {
    const s = listStats();
    expect(s.block).toBeGreaterThanOrEqual(120);
    expect(s.mask).toBeGreaterThanOrEqual(60);
    expect(s.mild).toBeGreaterThanOrEqual(10);
    expect(s.nameOnly).toBeGreaterThanOrEqual(5);
    expect(s.allow).toBeGreaterThanOrEqual(150);
  });

  it('catches single-word terms through case, spacing, punctuation, invisibles, look-alikes, repeats and leet', () => {
    const misses: string[] = [];
    let n = 0;
    for (const t of words) {
      for (const [kind, v] of wordVariants(t.key)) {
        if (spellsAllowed(v)) continue;
        n++;
        const r = filterChat(v);
        if (!atLeast(r.action, expected(t))) misses.push(`${kind} of #${t.rank} (${t.tier}/${t.mode}) -> ${r.action}`);
      }
    }
    expect(misses).toEqual([]);
    expect(n).toBeGreaterThan(3000);
  });

  it('catches suffixed forms of word / strong terms (-s, -ing, -er, -ed)', () => {
    const misses: string[] = [];
    for (const t of words) {
      if (t.mode === 'exact') continue;
      for (const suf of ['s', 'ing', 'er', 'ed']) {
        const v = t.key + suf;
        if (spellsAllowed(v)) continue;
        const r = filterChat(v);
        if (!atLeast(r.action, expected(t))) misses.push(`#${t.rank} + ${suf} -> ${r.action}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('catches phrases however they are spaced or punctuated', () => {
    const misses: string[] = [];
    for (const t of phrases) {
      const p = t.term;
      const variants: [string, string][] = [
        ['plain', p], ['joined', p.replace(/ /g, '')], ['wide', p.replace(/ /g, '   ')], ['dotted', p.replace(/ /g, '.')],
        ['upper', p.toUpperCase()], ['in a sentence', `ok ${p} now`], ['zero-width', p.replace(/ /g, ' ​')],
        ['look-alikes', homoglyph(p)], ['exclaimed', `${p}!!`],
      ];
      for (const [kind, v] of variants) {
        const r = filterChat(v);
        if (!atLeast(r.action, expected(t))) misses.push(`${kind} of #${t.rank} -> ${r.action}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('refuses every term as a name, including embedded in a callsign', () => {
    const misses: string[] = [];
    for (const t of [...words, ...nameOnlyTerms]) {
      const w = t.key;
      const forms = [w, `xX_${w}_Xx`, `Big${cap(w)}Guy`, `${w}99`];
      if (t.key.length >= 4 && t.tier !== 'mild' && !spellsAllowed(`zz${w}zz`)) forms.push(`zz${w}zz`);
      for (const f of forms) if (checkName(f).ok) misses.push(`#${t.rank} as ${f.replace(w, '<term>')}`);
    }
    for (const t of phrases) if (checkName(t.term).ok || checkName(t.key).ok) misses.push(`phrase #${t.rank}`);
    expect(misses).toEqual([]);
  });

  it('name-only terms (hate figures) are refused as names but fine in chat (history class)', () => {
    expect(nameOnlyTerms.length).toBeGreaterThan(0);
    for (const t of nameOnlyTerms) {
      expect(filterChat(`we read about ${t.term} today`).action).toBe('pass');
      expect(checkName(cap(t.term)).ok).toBe(false);
    }
  });

  it('mild words: masked in strict (default), passed in standard', () => {
    const mild = words.filter((t) => t.tier === 'mild');
    expect(mild.length).toBeGreaterThan(0);
    for (const t of mild) {
      expect(filterChat(`oh ${t.key} no`).action).toBe('mask');
      expect(filterChat(`oh ${t.key} no`, { strictness: 'strict' }).action).toBe('mask');
      expect(filterChat(`oh ${t.key} no`, { strictness: 'standard' }).action).toBe('pass');
      expect(checkName(`${cap(t.key)}_Rider`).ok).toBe(false);
      expect(checkName(`${cap(t.key)}_Rider`, { strictness: 'standard' }).ok).toBe(true);
    }
    // the other tiers don't depend on strictness
    for (const t of words.filter((x) => x.tier !== 'mild')) {
      expect(filterChat(t.key, { strictness: 'standard' }).action).toBe(expected(t));
    }
  });
});

describe('bypass corpus: leet digits combined with separators, heavy leet, more look-alikes', () => {
  /** Every one-digit leet spelling of a word: [position, spelling]. */
  const oneDigit = (w: string): [number, string][] => [...w].flatMap((ch, i) => (LEET[ch] ? [[i, w.slice(0, i) + LEET[ch] + w.slice(i + 1)] as [number, string]] : []));
  /** 3-letter profanity with a digit AND a separator keeps only 2 real letters, like "T1/T2" — knowingly not caught. */
  const shortSoft = (t: TermInfo): boolean => t.tier !== 'block' && t.key.length <= 3;

  it('one leet digit plus spacing / dots / dashes / underscores between every letter', () => {
    const misses: string[] = [];
    let n = 0;
    for (const t of words) {
      if (t.key.length < 3) continue;
      for (const [i, v] of oneDigit(t.key)) {
        for (const [kind, s] of [['spaced', joinWith(v, ' ')], ['dotted', joinWith(v, '.')], ['dashed', joinWith(v, '-')], ['underscored', joinWith(v, '_')]]) {
          if (spellsAllowed(s)) continue;
          n++;
          if (!atLeast(filterChat(s).action, expected(t))) misses.push(`${kind} #${t.rank}@${i}`);
          if (t.tier !== 'mild' && checkName(s).ok) misses.push(`name ${kind} #${t.rank}@${i}`);
        }
      }
    }
    expect(misses).toEqual([]);
    expect(n).toBeGreaterThan(1500);
  });

  it('one leet digit plus a single separator anywhere in the word ("x1.yz", "x.1yz", "x1 yz")', () => {
    const misses: string[] = [];
    for (const t of words) {
      if (t.key.length < 3 || shortSoft(t)) continue;
      for (const [i, v] of oneDigit(t.key)) {
        for (let cut = 1; cut < v.length; cut++) {
          for (const sep of ['.', '_', ',']) {
            const s = v.slice(0, cut) + sep + v.slice(cut);
            if (spellsAllowed(s)) continue;
            // the unsplit word must be caught for the split one to count (word-mode terms never join two real words)
            if (!atLeast(filterChat(t.key.slice(0, cut) + sep + t.key.slice(cut)).action, expected(t))) continue;
            if (!atLeast(filterChat(s).action, expected(t))) misses.push(`#${t.rank}@${i} cut ${cut} '${sep}'`);
          }
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('phrases with a leet digit in any word ("w0rd ...", "... w0rd", "1 ...")', () => {
    const misses: string[] = [];
    let n = 0;
    for (const t of phrases) {
      for (const [i, v] of oneDigit(t.term)) {
        for (const s of [v, v.replace(/ /g, '.'), `ok ${v} now`]) {
          n++;
          if (!atLeast(filterChat(s).action, expected(t))) misses.push(`phrase #${t.rank}@${i}`);
        }
      }
    }
    expect(misses).toEqual([]);
    expect(n).toBeGreaterThan(500);
  });

  it('heavy leet whose digits come back after a letter ("5x17"-style, one real letter left)', () => {
    const misses: string[] = [];
    let n = 0;
    for (const t of words) {
      const v = [...t.key].map((ch) => LEET[ch] ?? ch).join('');
      const firstLetter = v.search(/[a-z]/);
      if (firstLetter < 1 || v.replace(/[^a-z]/g, '').length !== 1 || !/[0-9]/.test(v.slice(firstLetter)) || v.length < 4) continue;
      n++;
      if (!atLeast(filterChat(v).action, expected(t))) misses.push(`#${t.rank}`);
    }
    expect(misses).toEqual([]);
    expect(n).toBeGreaterThan(0);
  });

  it("'@' reads as a, o or u inside a word", () => {
    const misses: string[] = [];
    for (const t of words) {
      const i = [...t.key].findIndex((ch) => ch === 'a' || ch === 'o' || ch === 'u');
      if (i < 0 || t.key.length < 3) continue;
      const v = t.key.slice(0, i) + '@' + t.key.slice(i + 1);
      if (!atLeast(filterChat(v).action, expected(t))) misses.push(`#${t.rank}`);
    }
    expect(misses).toEqual([]);
  });

  it('Greek look-alikes (upsilon for u, lunate sigma for c, eta for n, ...), also accented and capitalized', () => {
    const GREEK: Readonly<Record<string, string>> = {
      a: 'α', b: 'β', c: 'ϲ', e: 'ε', i: 'ι', k: 'κ', n: 'η', o: 'ο', p: 'ρ', t: 'τ', u: 'υ', v: 'ν', w: 'ω', x: 'χ', y: 'γ',
    };
    const misses: string[] = [];
    for (const t of words) {
      for (const only of ['u', 'c', 'n', 'aceiknoptuvwxy']) {
        const v = [...t.key].map((ch) => (only.includes(ch) ? GREEK[ch] ?? ch : ch)).join('');
        if (v === t.key) continue;
        for (const s of [v, v[0].toUpperCase() + v.slice(1), v.replace(/υ/g, 'ύ')]) {
          if (!atLeast(filterChat(s).action, expected(t))) misses.push(`${only} #${t.rank}`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('number codes: starred and logged in chat (no strike: mask tier), refused in names', () => {
    const code = rot5(NUMERIC_TERMS[0].code);
    const [a, b] = [code.slice(0, 2), code.slice(2)];
    const wide = [...code].map((d) => String.fromCharCode(0xFF10 + Number(d))).join(''); // fullwidth digits
    for (const s of [code, `${a} ${b}`, `${a}.${b}`, `${a}/${b}`, `gg ${code} lol`, `${a}​${b}`, wide, `(${code})`]) {
      const r = filterChat(s);
      expect(r.action, s).toBe('mask');
      expect(r.text).not.toContain(code.slice(1));
      expect(r.hits.map((h) => h.category)).toContain('hate');
    }
    expect(filterChat(`2${code}`).action).toBe('pass'); // a longer number
    expect(filterChat(`${code}0 points`).action).toBe('pass');
    expect(checkName(`Pilot${code}`).ok).toBe(false);
    expect(checkName('Pilot2024').ok).toBe(true);
  });

  it('number codes match STANDALONE, WHOLE digit runs only (regression: long runs, digit groups in callsigns)', () => {
    const code = rot5(NUMERIC_TERMS[0].code); // kept encoded in lists.ts; decoded only in memory here
    const [a, b] = [code.slice(0, 2), code.slice(2)];
    // chat: a run longer than the 16-digit compare cap is ONE number — the old scan restarted mid-run and found
    // the code at its tail; one separator joins, two separators / other punctuation split
    for (const s of [`${'1'.repeat(17)}${code}`, `${'9'.repeat(40)}${code}`, `${'7'.repeat(16)}.${code}`, `3${a} ${b}`, `${a}.${b}.5`]) {
      expect(filterChat(s).action, `len ${s.length}`).toBe('pass');
    }
    for (const s of [`x ${a}.. ${code}`, `9..${code}`, `score: ${code}!`, `${'1'.repeat(20)} ${'2'.repeat(3)}, ${code}`]) {
      expect(filterChat(s).action).toBe('mask');
    }
    // names: the same whole runs as chat (one separator between digits joins them, like "14 88" in chat)
    for (const n of [`Pilot${code}`, `${code}Ace`, `Ace_${a}_${b}`, `Ace${a}.${b}`, `Sn1per_${code}`, `${a}​${b}Ace`]) {
      const r = checkName(n);
      expect(r.ok, 'refused').toBe(false);
      expect(r.hits?.[0].category).toBe('hate');
    }
    // ...but digit groups that merely CONTAIN the code when concatenated are separate numbers: these used to be
    // refused WITH A STRIKE (every digit of the name was concatenated and searched)
    for (const n of [`${a}Ace${b}`, `Jet${a}_Wing${b}`, `Pilot${code}7`, `R2${code}`, `Sq${a}d${b}`, `L${a}x${b}`, `${a}_Ace_${b}`]) {
      expect(checkName(n).ok, 'allowed').toBe(true);
    }
  });

  it('a code that is its own group next to another number counts (regression: groups joined by one separator were missed)', () => {
    const code = rot5(NUMERIC_TERMS[0].code); // kept encoded in lists.ts; decoded only in memory here
    const [a, b] = [code.slice(0, 2), code.slice(2)];
    const stars = `${code[0]}${'*'.repeat(code.length - 1)}`;
    // chat: only the code's own group is starred
    for (const [s, shown] of [[`${code} ${code}`, `${stars} ${stars}`], [`wave 3 ${code}`, `wave 3 ${stars}`], [`${code} 2`, `${stars} 2`],
      [`gg ${code} 42`, `gg ${stars} 42`], [`1-${code}`, `1-${stars}`], [`7 ${a}.${b}`, `7 ${stars}`]] as const) {
      const r = filterChat(s);
      expect(r.action, 'masked').toBe('mask');
      expect(r.text, 'only the group').toBe(shown);
    }
    // names: refused, the code as a group of its own
    for (const n of [`Ace_${code}_2`, `Pilot_1_${code}`, `Pilot${code}_7`, `${code}_${code}`, `Ace ${code} 9`]) {
      const r = checkName(n);
      expect(r.ok, 'refused').toBe(false);
      expect(r.hits?.[0].category).toBe('hate');
    }
    // still never a longer number, groups that only line up into the code, a decimal, or digits split by letters
    for (const s of [`3${a} ${b}`, `${a}.${b}.5`, `${code}.5`, `3.${code}`, `${a} ${b} 2`, `2 ${a} ${b}0`]) expect(filterChat(s).action, 'pass').toBe('pass');
    for (const n of [`Pilot${code}7`, `3${a}_${b}`, `${a}Ace${b}`, `Ace_${a}_${b}_2`]) expect(checkName(n).ok, 'allowed').toBe(true);
  });

  it('zero-width characters on either side of a separator do not hide a code (regression)', () => {
    const code = rot5(NUMERIC_TERMS[0].code);
    const [a, b] = [code.slice(0, 2), code.slice(2)];
    for (const s of [`${a}\u200b.${b}`, `${a}.\u200b${b}`, `${a}\u200b ${b}`, `${a} \u2060${b}`, `${a}\u200b\u200c/${b}`]) {
      expect(filterChat(s).action, JSON.stringify(s.replace(/\d/g, '#'))).toBe('mask');
      expect(checkName(`Ace${s}`).ok).toBe(false);
    }
    expect(filterChat(`${a}\u200b..${b}`).action).toBe('pass'); // two separators still split
  });
});

describe('names: a callsign number is a number, not leet letters (regression)', () => {
  /** the digit that reads as a letter (the normalizer's leet table) */
  const DIGIT_OF: Readonly<Record<string, string>> = { o: '0', i: '1', l: '1', e: '3', a: '4', s: '5', t: '7', b: '8', g: '9' };
  // the terms that count inside a word in names (4+ letters, not mild, not a phrase)
  const inWord = chatTerms.filter((t) => !t.term.includes(' ') && t.tier !== 'mild' && t.key.length >= 4);

  it('a trailing number after a match that starts mid-word is a number ("Juliana1"); the letters and a word-start match still count', () => {
    const wrong: string[] = [];
    let cases = 0;
    for (const t of inWord) {
      const last = t.key[t.key.length - 1];
      const d = DIGIT_OF[last];
      if (!d) continue;
      const stem = t.key.slice(0, -1);
      if (!checkName(`Qz${stem}`).ok || !checkName(`Qz${stem}7`).ok || spellsAllowed(`qz${t.key}`)) continue; // the stem alone matches
      cases++;
      if (checkName(`Qz${t.key}`).ok) wrong.push(`#${t.rank}: the letters inside a word are allowed`);
      // (after a '5' read as s, the "s" of "st" would join the run of s: that is "5t", not an ordinal)
      for (const tail of [d, `${d}7`, `${d}_Ace`, ...(d === '5' ? [] : [`${d}st`]), `${d}${d}`]) {
        if (!checkName(`Qz${stem}${tail}`).ok) wrong.push(`#${t.rank}: mid-word + trailing number "${tail.replace(/\d/g, '#')}" refused`);
      }
      // a word-start match that ends in a digit is still the evasion, and mid-word leet too
      if (checkName(`${cap(stem)}${d}`).ok) wrong.push(`#${t.rank}: word start + digit allowed`);
      if (checkName(`${cap(stem)}${d}Qz`).ok) wrong.push(`#${t.rank}: word start + digit + letters allowed`);
    }
    expect(cases).toBeGreaterThan(20);
    expect(wrong).toEqual([]);
  });

  it('a leading number read into a word it does not finish is a number ("5Picasso"); reaching the word end still counts', () => {
    const wrong: string[] = [];
    let cases = 0;
    for (const t of inWord) {
      const d = DIGIT_OF[t.key[0]];
      if (!d) continue;
      const rest = t.key.slice(1);
      if (!checkName(`${rest}qzx`).ok || !checkName(`${rest}`).ok || spellsAllowed(t.key)) continue;
      cases++;
      if (!checkName(`${d}${cap(rest)}qzx`).ok) wrong.push(`#${t.rank}: leading number + a longer word refused`);
      if (checkName(`${d}${cap(rest)}`).ok) wrong.push(`#${t.rank}: leading number reaching the word end allowed`);
      if (checkName(`${d}${rest}_Ace`).ok) wrong.push(`#${t.rank}: leading number reaching a boundary allowed`);
    }
    expect(cases).toBeGreaterThan(5);
    expect(wrong).toEqual([]);
  });

  it('ordinary name + number callsigns pass in both strictness modes (they used to be refused, many WITH A STRIKE)', () => {
    const names = ['Juliana1', 'Ariana10', 'Liliana12', 'Eliana1', 'Diana1', 'Svetlana1', 'Makana1', 'Montana1', 'Texarkana1', 'Oreana1',
      'Owyhee8', 'Owyhee11', 'Deepak1', 'Deepak1st', 'Ethan41', 'Ryan41', 'Logan41', 'Dylan41', 'Evan41', 'Sebastian41', 'Ada60',
      'Fukuda90', 'Charles60', 'Miles80', 'Apache11', 'Avalanche11', 'SalvageCache11', 'RiftCache11', 'SwarmCache11', 'GladiatorCache11',
      'Clapped0', 'Sniped0', 'Dropped0', 'Zapped0', '5Picasso', 'Hiroshi7', 'Keanu5', 'Seth007', 'Keith007', 'Smith007', 'Siddharth007',
      'StarWars3', 'Cars3', 'Cougars3', 'Aspen1st', 'Aspen15', 'Essex7', 'Skylar53', 'Omar53', 'Kash17', 'Xochitl3rd', 'Juliana1_Ace'];
    const bad = names.filter((n) => !checkName(n).ok || !checkName(n, { strictness: 'standard' }).ok);
    expect(bad).toEqual([]);
    // ...and quoted in chat they are shown as typed
    expect(names.filter((n) => filterChat(`gg ${n}, heal me`).action !== 'pass')).toEqual([]);
  });
});

describe('clean corpus: zero false positives', () => {
  it('numbers, codes, units and mentions in game chat pass ("45 s", "T1/T2", "5 hits", "900k", "5-hit combo")', () => {
    const lines = [
      '45 s left', 'respawn in 45 s', 'T1/T2/T3 tiers', 'tier T1 T2', '5 hits to kill', 'top 5 hits', 'took 5 pics', 'send 5 pics',
      '60 B', '600 B', '900k damage', '455 dmg', '13580 points', '1v1 me', '2v2', '3v3s', '5v5', '4x4', 'wave 3 done', 'lvl5 tank',
      'at 3pm', '10th place', '1st place', '2nd', '3rd', '4th', '5th', 'gg 1 v 1', 'b4 u go', 'l8r', 'gr8 job', 'w8 4 me', 'h8 this map',
      '1h30', '2h45', '5h30', '7h15', '10:45', '5 s', '7 s', 'A1 steak', 'B2 bomber', 'F5 to refresh', 'x10 multiplier', '3d printer',
      '4k60', '144hz', '60fps', '1080p', '7 7 7', 'room 4B', 'team 1 vs team 2', 'I have 3 lives', 'kill 3 bots', 'u 2', '1 sec',
      '10 secs', '1 2 3 go', '0 kills', '5-hit combo', '3-way split', '1-shot kill', '4-star map', '9-ball', 'v1.2.3', '1.5x speed',
      'me@school.edu', '@home', '@Ace_Pilot nice', 'email me at bob@example.com', '@Dickens', '@Assassin99',
    ];
    const hits = lines.filter((l) => filterChat(l).action !== 'pass');
    expect(hits).toEqual([]);
  });

  it('real given names and surnames from class rosters are legal callsigns and pass in chat', () => {
    const names = ['Harshit', 'Harshita', 'Kshitij', 'Yamashita', 'Kinoshita', 'Matsushita', 'Morishita', 'Shittu', 'Dikshit',
      'Hiscock', 'Alcock', 'Adcock', 'Laycock', 'Glasscock', 'Cockburn', 'Cockrell', 'Kuntz', 'Analise', 'Analiese', 'Anneliese',
      'Annaliese', 'Hancock', 'Dickens', 'Dickinson', 'Cassandra', 'Vanessa', 'Scunthorpe', 'Penistone',
      // found in review: two of these were refused WITH A STRIKE, the others starred in chat too
      'Kuntal', 'Analisa', 'Anusha', 'Anushka', 'Shital', 'Ashit', 'Ashita', 'Ashitaka', 'Shitij', 'Riddick', 'Farseer'];
    for (const n of names) {
      for (const strictness of ['strict', 'standard'] as const) {
        expect(checkName(n, { strictness }).ok, n).toBe(true);
        expect(checkName(`${n}13`, { strictness }).ok, n).toBe(true);
        expect(filterChat(`hi ${n}, gg`, { strictness }).action, n).toBe('pass');
      }
    }
    expect(filterChat('the buttes of Utah').action).toBe('pass');
  });

  it('Idaho landmarks, a local fish and a few ordinary place names / phrases pass (strict mode too)', () => {
    // clean text, but each contains a listed word, so it is written ROT13 like the other inputs here
    const lines = ['jr uvxrq Uryyf Pnalba', 'Uryyf Pnalba Qnz', 'Uryyf Tngr Fgngr Cnex va Yrjvfgba', "Uryy'f Unys Nper arne Vqnub Snyyf",
      "Uryy'f Pnalba vf qrrc", 'pnhtug n penccvr ng Ynxr Ybjryy', 'penccvrf ner ovgvat', 'jrag gb Pbba Encvqf bire gur jrrxraq',
      'zl pbba ubhaq', 'gvg sbe gng', 'vg jnf gvg-sbe-gng nyy tnzr'].map(R);
    lines.forEach((l, i) => {
      for (const strictness of ['strict', 'standard'] as const) expect(filterChat(l, { strictness }), `line ${i}`).toMatchObject({ action: 'pass', hits: [] });
    });
    ['UryyfPnalba', 'UryyfTngr', 'Uryyf_Unys_Nper', 'PenccvrXvat', 'PbbaEncvqf', 'Pbba_Ubhaq', 'GvgSbeGng'].map(R).forEach((n, i) => {
      expect(checkName(n).ok, `name ${i}`).toBe(true);
    });
    // the allow phrases rescue only themselves: a first word that is read on its own is still read before another word
    let checked = 0;
    for (const phrase of ['uryyf pnalba', 'uryyf tngr', 'pbba encvqf', 'pbba ubhaq', 'gvg sbe gng'].map(R)) {
      const first = phrase.split(' ')[0];
      if (!filterChat(first).hits.length) continue;
      checked++;
      expect(filterChat(`${first} zorblax`).hits.length, phrase).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  const docs = ['ARCHITECTURE.md', 'docs/v0.3-proposal.md', 'docs/v0.3-critique.md']
    .map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
  const docWords = [...new Set(docs.toLowerCase().match(/[a-z]{3,}/g) ?? [])];
  const docLines = docs.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  it('every distinct word of the design docs (500+) passes as chat and as a name', () => {
    expect(docWords.length).toBeGreaterThan(500);
    const chatHits = docWords.filter((w) => filterChat(w).hits.length > 0);
    const nameHits = docWords.filter((w) => !checkName(w).ok);
    expect(chatHits).toEqual([]);
    expect(nameHits).toEqual([]);
  });

  it('every line of the design docs passes (numbers + units, code, tables, punctuation)', () => {
    expect(docLines.length).toBeGreaterThan(500);
    const hits = docLines.filter((l) => filterChat(l).hits.length > 0).map((l) => l.slice(0, 80));
    expect(hits).toEqual([]);
  });

  it('the allowlist itself (the Scunthorpe traps) passes, alone and in a sentence', () => {
    for (const w of ALLOW_WORDS) {
      expect(filterChat(w).hits.map(String), w).toEqual([]);
      expect(filterChat(`the ${w} was great`).hits.map(String), w).toEqual([]);
      expect(checkName(w.replace(/ /g, '_')).ok, w).toBe(true);
    }
  });

  it('the examples from the brief pass', () => {
    const brief = ['class', 'classic', 'assassin', 'scunthorpe', 'cocktail', 'shitake', 'grape', 'therapist', 'analysis',
      'pass', 'bass', 'title', 'hello', 'shell', 'dickens', 'cockpit', 'penistone', 'sussex', 'assist', 'grass', 'passive',
      'glass', 'mass', 'hitch', 'butterfly', 'cocoa', 'Hancock', 'spice', 'raccoon'];
    for (const w of brief) {
      expect(filterChat(w).action, w).toBe('pass');
      expect(filterChat(w.toUpperCase()).action, w).toBe('pass');
      expect(checkName(cap(w)).ok, w).toBe(true);
    }
  });

  it('word boundaries: pieces of two real words never join into a term', () => {
    for (const line of ["he'll be fine", "she'll heal you", 'the pen is mightier', 'I met an Al there', '45 s left',
      'T1/T2/T3 tiers', 'a hole in the wall', 'nice shot, gg', 'wrapped it up', 'the rapper won', 'goodies inside',
      'woops, my bad', 'kill the boss', 'I will kill you in the arena', 'shoot the turret', 'bomb site B']) {
      expect(filterChat(line).hits.map(String), line).toEqual([]);
    }
  });

  it('every bot callsign is a legal name', () => {
    for (const b of BOT_CALLSIGNS) expect(checkName(b).ok, b).toBe(true);
  });
});

describe('filterChat output', () => {
  const F = R('shpx'); // the 4-letter f-word

  it('pass returns the text unchanged', () => {
    const r = filterChat('Nice shot! gg wp');
    expect(r).toEqual({ text: 'Nice shot! gg wp', action: 'pass', hits: [] });
  });

  it('mask keeps the first letter and stars the rest, leaving the rest of the line alone', () => {
    const r = filterChat(`oh ${F} that hurt`);
    expect(r.action).toBe('mask');
    expect(r.text).toBe(`oh ${F[0]}*** that hurt`);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].tier).toBe('mask');
    expect(r.hits[0].category).toBe('profanity');
    expect(r.hits[0].term).toBe(F);
  });

  it('masks evasions to a reasonable length (spaces and repeats collapse into the star run)', () => {
    expect(filterChat(joinWith(F, ' ')).text).toBe(`${F[0]}***`);
    expect(filterChat(`${F[0]}${F[1].repeat(40)}${F.slice(2)}`).text).toBe(`${F[0]}****`);
    expect(filterChat(`${F}ing`).text).toBe(`${F[0]}******`);
    expect(filterChat(`${F.toUpperCase()}!`).text).toBe(`${F[0].toUpperCase()}***!`);
    expect(filterChat(`a${F}b`).text.length).toBeLessThanOrEqual(10);
  });

  it('block: action block, the text still comes back starred (never the original)', () => {
    const t = words.find((x) => x.tier === 'block' && x.mode === 'strong') as TermInfo;
    const r = filterChat(`hey ${t.key} lol`);
    expect(r.action).toBe('block');
    expect(r.text).not.toContain(t.key);
    expect(r.text.startsWith('hey ')).toBe(true);
    expect(r.hits[0].tier).toBe('block');
  });

  it('hits are distinct, most severe first, and stringify to the term (hits.map(String) for logs)', () => {
    const blockT = words.find((x) => x.tier === 'block' && x.mode === 'strong') as TermInfo;
    const r = filterChat(`${F} ${F} ${blockT.key}`);
    expect(r.action).toBe('block');
    expect(r.hits.map(String)).toEqual([blockT.term, F]);
    expect(r.hits[0]).toBeInstanceOf(FilterHit);
    expect(JSON.parse(JSON.stringify(r.hits[1]))).toEqual({ term: F, tier: 'mask', category: 'profanity' });
    // a wildcard spelling reports one reading, not every term the stars could spell
    expect(filterChat(`${F[0]}**${F[3]}`).hits.map(String)).toEqual([F]);
  });

  it('is total and deterministic', () => {
    expect(filterChat(undefined)).toEqual({ text: '', action: 'pass', hits: [] });
    expect(filterChat(42)).toEqual({ text: '', action: 'pass', hits: [] });
    expect(filterChat('')).toEqual({ text: '', action: 'pass', hits: [] });
    const a = JSON.stringify(filterChat(`x ${F} y`));
    filterChat('something else entirely');
    filterChat('\u{1F600}'.repeat(50));
    expect(JSON.stringify(filterChat(`x ${F} y`))).toBe(a);
    expect(filterChat('x'.repeat(10000)).text.length).toBeLessThanOrEqual(4000);
  });

  it('surrogate pairs and emoji survive masking intact', () => {
    const r = filterChat(`\u{1F525}${F}\u{1F525}`);
    expect(r.action).toBe('mask');
    expect(r.text).toBe(`\u{1F525}${F[0]}***\u{1F525}`);
  });
});

describe('checkName', () => {
  it('ok for ordinary callsigns, refused with a term-free reason otherwise', () => {
    for (const n of ['Ace_Pilot', 'Neon Moth', 'xX_Sniper_Xx', 'Hellboy', 'Assassin99', 'Dickens', 'Hancock']) {
      expect(checkName(n).ok, n).toBe(true);
    }
    const t = words.find((x) => x.tier === 'mask' && x.mode === 'strong') as TermInfo;
    const r = checkName(`Big${cap(t.key)}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^offensive name \(/);
    expect(r.reason).not.toContain(t.key);
    expect(r.hits?.map(String)).toEqual([t.term]);
  });

  it('empty / junk input is ok (the sanitizer supplies a fallback)', () => {
    expect(checkName('')).toEqual({ ok: true });
    expect(checkName(null)).toEqual({ ok: true });
  });
});

describe('compile: explicit, deterministic collisions (engine.ts mergeTermGroups)', () => {
  it('the built-in lists have no letter-key collisions (a new one must be merged on purpose and listed here)', () => {
    expect(builtinDiagnostics()).toEqual([]);
    expect(new Set(terms.map((t) => t.key)).size).toBe(terms.length);
  });

  // made-up neutral tokens, ROT13-encoded like the real lists
  const mask: TermGroup = { tier: 'mask', category: 'profanity', mode: 'strong', terms: [R('zorblax'), R('quenth')] };
  const block: TermGroup = { tier: 'block', category: 'hate', mode: 'word', terms: [R('zor blax')] };
  const namesOnly: TermGroup = { tier: 'block', category: 'hate', mode: 'strong', terms: [R('quenth'), R('vorpik')] };
  const parts = [
    { label: 'A', groups: [mask, block], nameOnly: false },
    { label: 'N', groups: [namesOnly], nameOnly: true },
  ];

  it('keeps the strictest tier (with its spelling, category and mode), merges scopes, and reports it by position', () => {
    const { terms: t, diagnostics } = mergeTermGroups(parts);
    const by = new Map(t.map((x) => [x.key, x]));
    expect(by.get('zorblax')).toMatchObject({ tier: 'block', category: 'hate', mode: 'word', term: 'zor blax', chat: true, names: true, nameOnly: false, rank: 0 });
    // the old compile let a later names-only entry silently take a chat term out of chat: scopes now merge
    expect(by.get('quenth')).toMatchObject({ tier: 'block', category: 'hate', mode: 'strong', chat: true, names: true, nameOnly: false, rank: 1 });
    expect(by.get('vorpik')).toMatchObject({ chat: false, nameOnly: true });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'A[0] #0 and A[1] #0 have the same letters: kept tier block / category hate / mode word from A[1] #0 (dropped tier mask, category profanity, mode strong); scopes merged (chat + names)',
      'A[0] #1 and N[0] #0 have the same letters: kept tier block / category hate / mode strong from N[0] #0 (dropped tier mask, category profanity); scopes merged (chat + names)',
    ]);
    expect(diagnostics.every((d) => d.code === 'builtin-collision' && !/zorblax|quenth|vorpik/.test(d.message))).toBe(true);
  });

  it('is order-independent for tier and scope; on a tier tie the entry listed first wins', () => {
    const rev = mergeTermGroups([...parts].reverse()).terms;
    const fwd = mergeTermGroups(parts).terms;
    for (const k of ['zorblax', 'quenth', 'vorpik']) {
      const a = fwd.find((x) => x.key === k)!;
      const b = rev.find((x) => x.key === k)!;
      expect([b.tier, b.chat, b.names], k).toEqual([a.tier, a.chat, a.names]);
    }
    const tie = mergeTermGroups([{ label: 'T', groups: [
      { tier: 'mask', category: 'profanity', mode: 'word', terms: [R('drellik')] },
      { tier: 'mask', category: 'mild', mode: 'strong', terms: [R('drellik')] },
    ], nameOnly: false }]);
    expect(tie.terms[0]).toMatchObject({ category: 'profanity', mode: 'word' });
    expect(tie.diagnostics[0].message).toContain('from T[0] #0 (dropped category mild, mode strong)');
  });
});

describe('parseStrictness (host setting, e.g. CHAT_FILTER)', () => {
  it("only 'standard' relaxes; anything else is strict", () => {
    expect(parseStrictness('standard')).toBe('standard');
    expect(parseStrictness(' Standard ')).toBe('standard');
    for (const v of ['strict', '', undefined, null, 'off', 'none', 'standrad', 1]) expect(parseStrictness(v)).toBe('strict');
  });
});

describe('foldText', () => {
  it('shows the normalized stream the matcher sees', () => {
    expect(foldText('Ｈｅｌｌｏ  W0rld')).toBe('hello world');
    expect(foldText('A​d⁠m­i n')).toBe('admi n');
    expect(foldText('b.i.g')).toBe('b i g');
    expect(foldText('bigBoss')).toBe('big boss');
  });
});
