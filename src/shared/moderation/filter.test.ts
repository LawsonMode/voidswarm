import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOT_CALLSIGNS } from '../room/util';
import { compiled, type TermInfo } from './engine';
import { FilterHit, checkName, filterChat, foldText, listStats, parseStrictness } from './filter';
import { ALLOW_WORDS, NUMERIC_TERMS, rot13, rot5 } from './lists';

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
    for (const s of [code, `${code.slice(0, 2)} ${code.slice(2)}`, `${code.slice(0, 2)}.${code.slice(2)}`, `gg ${code} lol`]) {
      const r = filterChat(s);
      expect(r.action, s).toBe('mask');
      expect(r.text).not.toContain(code.slice(1));
      expect(r.hits.map((h) => h.category)).toContain('hate');
    }
    expect(filterChat(`2${code}`).action).toBe('pass'); // a longer number
    expect(filterChat(`${code}0 points`).action).toBe('pass');
    expect(checkName(`Pilot${code}`).ok).toBe(false);
    expect(checkName(`${code.slice(0, 2)}Ace${code.slice(2)}`).ok).toBe(false);
    expect(checkName('Pilot2024').ok).toBe(true);
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
      'Annaliese', 'Hancock', 'Dickens', 'Dickinson', 'Cassandra', 'Vanessa', 'Scunthorpe', 'Penistone'];
    for (const n of names) {
      expect(checkName(n).ok, n).toBe(true);
      expect(filterChat(`hi ${n}, gg`).action, n).toBe('pass');
    }
    expect(filterChat('the buttes of Utah').action).toBe('pass');
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
