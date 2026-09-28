// Runtime custom terms (custom.ts): validation, normalization through the chat pipeline, actions (block / mask /
// flag), scopes, match modes, context anchors, number codes, determinism, and the rule that custom terms never
// weaken the built-in lists. Every custom term here is an obviously made-up neutral token (zorblax, quenth, 7351, ...);
// built-in terms are only ever taken from the (ROT13) list itself, never spelled out.
import { afterEach, describe, expect, it } from 'vitest';
import { blockCategories, hitLabel } from '../room/moderation';
import { buildStream, compiled, scanCustomSets, type RawHit, type TermInfo } from './engine';
import {
  CUSTOM_LIMITS, FilterHit, activeCustomTerms, checkName, clearCustomTerms, compileCustomTerms, filterChat,
  setCustomTerms, type CustomTermInput, type CustomTermSet,
} from './filter';
import { fpChatLines } from './fpCorpus';

afterEach(() => clearCustomTerms());

/** Compile or fail the test with the errors. */
function set(entries: unknown[]): CustomTermSet {
  const r = compileCustomTerms(entries);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  return r.set!;
}
const E = (term: string, action: CustomTermInput['action'], more: Partial<CustomTermInput> = {}): CustomTermInput => ({ term, action, category: 'test', ...more });
/** The only errors' messages of one bad entry. */
const errorsOf = (entry: unknown): { field: string; message: string }[] =>
  compileCustomTerms([entry]).errors.map(({ field, message }) => ({ field, message }));

describe('validation: clear errors, nothing installed', () => {
  it('refuses empty, over-long, regex-like, leet, mixed and unsupported input with a message per problem', () => {
    const cases: [unknown, string, RegExp][] = [
      [{ term: '', action: 'block' }, 'term', /empty/],
      [{ term: '   ', action: 'block' }, 'term', /empty/],
      [{ term: 42, action: 'block' }, 'term', /must be a string/],
      [{ term: 'z'.repeat(65), action: 'block' }, 'term', /longer than 64/],
      [{ term: 'zorb.*lax', action: 'block' }, 'term', /regular expression/],
      [{ term: '^zorblax$', action: 'block' }, 'term', /regular expression/],
      [{ term: 'zorb(lax)?', action: 'block' }, 'term', /regular expression/],
      [{ term: 'z0rblax', action: 'block' }, 'term', /mixes letters and digits/],
      [{ term: 'zorblax 7351', action: 'block' }, 'term', /anchor/],
      [{ term: 'zorbl@x', action: 'block' }, 'term', /unsupported character "@"/],
      [{ term: "zorb'lax", action: 'block' }, 'term', /unsupported character/],
      [{ term: 'zorb​lax', action: 'block' }, 'term', /U\+200B/],
      [{ term: '中文', action: 'block' }, 'term', /Latin letters/],
      [{ term: 'z', action: 'block' }, 'term', /too short/],
      [{ term: '7', action: 'block' }, 'term', /at least 2 digits/],
      [{ term: '1234567890123', action: 'block' }, 'term', /at most 12 digits/],
      [{ term: 'a b c d e f g h i', action: 'block' }, 'term', /more than 8 words/],
      [{ term: 'zorblax' }, 'action', /'block', 'mask' or 'flag'/],
      [{ term: 'zorblax', action: 'ban' }, 'action', /'block', 'mask' or 'flag'/],
      [{ term: 'zorblax', action: 'flag', scope: 'everywhere' }, 'scope', /'chat', 'names' or 'both'/],
      [{ term: 'zorblax', action: 'flag', match: 'regex' }, 'match', /'word', 'phrase' or 'strong'/],
      [{ term: 'zorblax', action: 'flag', match: 'phrase' }, 'match', /two or more words/],
      [{ term: 'zorb lax', action: 'flag', match: 'word' }, 'match', /use match 'phrase'/],
      [{ term: 'zor', action: 'flag', match: 'strong' }, 'match', /at least 4 letters/],
      [{ term: '7351', action: 'flag', match: 'strong' }, 'match', /whole number/],
      [{ term: 'zorblax', action: 'flag', category: 'x'.repeat(25) }, 'category', /longer than 24/],
      [{ term: 'zorblax', action: 'flag', category: '!!!' }, 'category', /no usable characters/],
      [{ term: 'zorblax', action: 'flag', category: 7 }, 'category', /must be a string/],
      [{ term: 'zorblax', action: 'flag', anchors: 'quenth' }, 'anchors', /list/],
      [{ term: 'zorblax', action: 'flag', anchors: Array.from({ length: 9 }, (_, i) => `quenth${'x'.repeat(i)}`) }, 'anchors', /at most 8/],
      [{ term: 'zorblax', action: 'flag', anchors: ['qu*nth'] }, 'anchors', /anchor 1 looks like a regular expression/],
      [{ term: 'zorblax', action: 'flag', id: 'x'.repeat(65) }, 'id', /longer than 64/],
      ['zorblax', 'entry', /must be an object/],
      [null, 'entry', /must be an object/],
    ];
    for (const [entry, field, re] of cases) {
      const errs = errorsOf(entry);
      expect(errs.length, JSON.stringify(entry)).toBeGreaterThan(0);
      expect(errs[0].field, JSON.stringify(entry)).toBe(field);
      expect(errs[0].message, JSON.stringify(entry)).toMatch(re);
    }
  });

  it('errors carry the entry index and id; a bad list installs nothing (the previous list stays)', () => {
    expect(setCustomTerms([E('zorblax', 'block')]).ok).toBe(true);
    const r = setCustomTerms([E('quenth', 'mask'), { term: '', action: 'block', id: 'row-7' }, E('vorpik', 'nope' as never)]);
    expect(r.ok).toBe(false);
    expect(r.set).toBeNull();
    expect(r.errors.map((e) => [e.index, e.field, e.id ?? null])).toEqual([[1, 'term', 'row-7'], [2, 'action', null]]);
    expect(r.rejected).toBe(3);
    // the previous list is still in force
    expect(filterChat('zorblax').action).toBe('block');
    expect(filterChat('quenth').action).toBe('pass');
  });

  it('partial mode skips invalid entries and keeps the rest', () => {
    const r = setCustomTerms([E('quenth', 'mask'), { term: 'z0rb', action: 'block' }, E('vorpik', 'flag')], { partial: true });
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(filterChat('quenth').action).toBe('mask');
    expect(filterChat('vorpik').action).toBe('flag');
  });

  it('partial mode with NO valid entry is refused: a bad upload never silently removes the installed list', () => {
    expect(setCustomTerms([E('zorblax', 'block')]).ok).toBe(true);
    const r = setCustomTerms([{ term: 'z0rb', action: 'block' }, { term: '', action: 'mask' }], { partial: true });
    expect(r.ok).toBe(false);
    expect(r.set).toBeNull();
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(2);
    expect(r.errors.map((e) => [e.index, e.field])).toEqual([[0, 'term'], [1, 'term'], [-1, 'list']]);
    expect(r.errors.at(-1)!.message).toMatch(/no valid entries/);
    expect(activeCustomTerms()?.size).toBe(1);
    expect(filterChat('zorblax').action).toBe('block');
    // an explicitly empty list still clears it
    expect(setCustomTerms([], { partial: true }).ok).toBe(true);
    expect(activeCustomTerms()).toBeNull();
  });

  it('partial mode: every entry of a duplicated id is refused, so the input order never changes the set', () => {
    const list = [E('zorblax', 'mask', { id: 'x' }), E('quenth', 'block', { id: 'x' }), E('vorpik', 'flag', { id: 'y' })];
    const a = compileCustomTerms(list, { partial: true });
    const b = compileCustomTerms([...list].reverse(), { partial: true });
    expect(a.ok).toBe(true);
    expect(a.set!.fingerprint).toBe(b.set!.fingerprint);
    expect(a.set!.entries().map((e) => e.term)).toEqual(['vorpik']);
    expect(a.errors.map((e) => [e.index, e.id, e.field])).toEqual([[0, 'x', 'id'], [1, 'x', 'id']]);
    expect(filterChat('zorblax quenth', { custom: a.set })).toMatchObject({ action: 'pass' });
  });

  it('list-level limits: not a list, more than 2000 entries, duplicate ids, too many letters in all', () => {
    expect(compileCustomTerms('zorblax').errors[0]).toMatchObject({ index: -1, field: 'list' });
    const many = Array.from({ length: CUSTOM_LIMITS.maxEntries + 1 }, (_, i) => E(`zorb${'x'.repeat(i % 5)}${String.fromCharCode(97 + (i % 26))}`, 'flag'));
    const r = compileCustomTerms(many);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ index: -1, field: 'list', message: 'too many entries: 2001 (max 2000)' }]);
    const dup = compileCustomTerms([E('zorblax', 'flag', { id: 'a' }), E('quenth', 'flag', { id: 'a' })]);
    expect(dup.errors).toEqual([
      { index: 0, id: 'a', field: 'id', message: 'duplicate id: entries #0, #1 use it' },
      { index: 1, id: 'a', field: 'id', message: 'duplicate id: entries #0, #1 use it' },
    ]);
    const big = Array.from({ length: 1000 }, (_, i) => E(`${'q'.repeat(2)}${'uenth'.repeat(9)}${i.toString(26).replace(/[0-9]/g, (d) => 'zyxwvutsrq'[Number(d)])}`, 'flag'));
    const rb = compileCustomTerms(big);
    expect(rb.ok).toBe(false);
    expect(rb.errors[0].message).toMatch(/too large: \d+ letters in all \(max 40000\)/);
  });

  it('category and id are sanitized (lowercase label, accents folded, punctuation dropped)', () => {
    const s = set([{ term: 'Zorblax', action: 'flag', category: '  Crew: Nörth Side! ', id: ' row-1\u0007 ' }]);
    expect(s.entries()).toEqual([{
      index: 0, id: 'row-1', kind: 'letters', term: 'zorblax', category: 'crew north side', action: 'flag', scope: 'both', match: 'word', anchors: [],
    }]);
    expect(set([{ term: 'zorblax', action: 'flag' }]).entries()[0].category).toBe('custom');
  });

  it("spellings of the Zone's own categories map to them: 'self-harm' / 'Self Harm' keep the self-harm handling", () => {
    for (const [label, id] of [['self-harm', 'selfharm'], ['Self Harm', 'selfharm'], ['self_harm', 'selfharm'], ['SELFHARM', 'selfharm'],
      ['Threats', 'threat'], ['threat', 'threat'], ['self harm crew', 'self harm crew'], ['constructor', 'constructor'],
      ['to_String', 'to_string'], ['__proto__', '__proto__']] as const) {
      const s = set([E('zorblax', 'block', { category: label })]);
      expect(s.entries()[0].category, label).toBe(id);
    }
    const s = set([E('zorblax', 'block', { category: 'Self-Harm' })]);
    const r = filterChat('zorblax', { custom: s });
    expect(blockCategories(r.hits)).toEqual(['selfharm']);
    expect(r.hits.map(hitLabel)).toEqual(['custom:selfharm:zorblax']);
  });
});

describe('normalization: the same pipeline as chat', () => {
  it('reads the term through case, accents, look-alikes, fullwidth, separators and camelCase', () => {
    const forms = ['zorblax', 'ZORBLAX', 'Zörblax', 'zor-blax', 'zor_blax', 'z.o.r.b.l.a.x', 'ZorBlax', 'ｚｏｒｂｌａｘ', 'zоrblах'];
    for (const f of forms) expect(set([E(f, 'flag')]).entries()[0].term, f).toBe('zorblax');
    expect(set([E('Quenth   Vorpik', 'flag')]).entries()[0]).toMatchObject({ term: 'quenth vorpik', match: 'phrase' });
    expect(set([E('73-51', 'flag')]).entries()[0]).toMatchObject({ kind: 'digits', term: '7351' });
  });

  it("a word typed in joined parts ('Zorb-Lax') also matches with the parts spaced out, as players type it", () => {
    const hy = set([E('Zorb-Lax', 'block')]);
    expect(hy.entries()[0]).toMatchObject({ term: 'zorblax', match: 'word', spaced: true });
    for (const v of ['zorblax', 'zorb-lax', 'zorb lax', 'Zorb Lax crew', 'zorb.lax', 'ZorbLax', 'zorb  lax', 'z0rb l4x']) {
      expect(filterChat(v, { custom: hy }).action, v).toBe('block');
    }
    // still one word everywhere else: suffixes, names inside a longer word, not across unrelated words
    expect(filterChat('zorblaxes', { custom: hy }).action).toBe('block');
    expect(checkName('xxZorblaxxx', { custom: hy }).ok).toBe(false);
    expect(checkName('Zorb_Lax', { custom: hy }).ok).toBe(false);
    expect(filterChat('xzorb laxy', { custom: hy }).action).toBe('pass');
    // one hit per line, one entry in the set
    expect(filterChat('zorb lax', { custom: hy }).hits.map(hitLabel)).toEqual(['custom:test:zorblax']);
    expect(hy.size).toBe(1);
    // the same letters typed without a joiner stay a plain word, and single letters with dots are not "parts"
    expect(set([E('zorblax', 'block')]).entries()[0].spaced).toBeUndefined();
    expect(set([E('z.o.r.b.l.a.x', 'block')]).entries()[0].spaced).toBeUndefined();
    expect(filterChat('zorb lax', { custom: set([E('zorblax', 'block')]) }).action).toBe('pass');
    // ...and the fingerprint tells the two apart
    expect(set([E('Zorb-Lax', 'block')]).fingerprint).not.toBe(set([E('zorblax', 'block')]).fingerprint);
    // anchors typed in parts too
    const an = set([E('7351', 'block', { anchors: ['Quenth-Vor'] })]);
    expect(filterChat('7351 quenth vor', { custom: an }).action).toBe('block');
    expect(filterChat('7351 quenthvor', { custom: an }).action).toBe('block');
  });

  it('chat evasions of a custom term are caught like the built-in ones', () => {
    setCustomTerms([E('zorblax', 'mask')]);
    const variants = ['zorblax', 'Zorblax', 'ZORBLAX', 'z0rblax', 'zorbl4x', 'z o r b l a x', 'z.o.r.b.l.a.x', 'z_o_r_b_l_a_x',
      'z​o​rblax', 'zoooorblax', 'zorblaxes', 'zorblaxing', 'zоrblах', 'ｚｏｒｂｌａｘ',
      'you zorblax!!', '"zorblax"', 'zórblàx', 'BigZorblax', 'ZORBLAXguy', '7zorblax', 'zorblax99', 'x.zorblax', 'go-zorblax'];
    for (const v of variants) {
      const r = filterChat(v);
      expect(r.action, v).toBe('mask');
      expect(r.text.toLowerCase()).not.toContain('orblax');
    }
    // word mode: not inside another word in chat, not two real words
    for (const v of ['xzorblaxy', 'the zorb lax way']) expect(filterChat(v).action, v).toBe('pass');
  });

  it('phrases match however they are spaced or punctuated, and only as the words in a row', () => {
    setCustomTerms([E('quenth vorpik', 'block')]);
    for (const v of ['quenth vorpik', 'quenthvorpik', 'Quenth.Vorpik', 'quenth   vorpik', 'ok quenth vorpik now', 'qu3nth v0rpik']) {
      expect(filterChat(v).action, v).toBe('block');
    }
    for (const v of ['quenth', 'vorpik', 'quenth and vorpik', 'xquenth vorpikx']) expect(filterChat(v).action, v).toBe('pass');
  });

  it("'strong' matches inside other words; 'word' only boundary to boundary (names: 4+ letters inside a word too)", () => {
    const s = set([E('zorblax', 'mask', { match: 'strong' }), E('quenth', 'mask')]);
    expect(filterChat('xxzorblaxyy', { custom: s }).action).toBe('mask');
    expect(filterChat('xxquenthyy', { custom: s }).action).toBe('pass');
    expect(checkName('xxQuenthyy', { custom: s }).ok).toBe(false);
  });
});

describe('actions, scopes and hit labels', () => {
  it("'block' withholds the line (text still starred), 'mask' stars the word, 'flag' leaves it as typed", () => {
    const s = set([E('zorblax', 'block', { category: 'crew a' }), E('quenth', 'mask', { category: 'crew b' }), E('vorpik', 'flag', { category: 'crew c', id: 'v1' })]);
    const b = filterChat('hey zorblax lol', { custom: s });
    expect(b.action).toBe('block');
    expect(b.text).toBe('hey z****** lol');
    const m = filterChat('hey quenth lol', { custom: s });
    expect(m).toMatchObject({ action: 'mask', text: 'hey q***** lol' });
    const f = filterChat('hey vorpik lol', { custom: s });
    expect(f.action).toBe('flag');
    expect(f.text).toBe('hey vorpik lol');
    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]).toBeInstanceOf(FilterHit);
    expect(JSON.parse(JSON.stringify(f.hits[0]))).toEqual({ term: 'vorpik', tier: 'flag', category: 'crew c', source: 'custom', id: 'v1' });
    // a flag hit next to a masked word: the line is masked, the flagged word is shown, both are reported
    const mf = filterChat('quenth and vorpik', { custom: s });
    expect(mf.action).toBe('mask');
    expect(mf.text).toBe('q***** and vorpik');
    expect(mf.hits.map((h) => [h.term, h.tier])).toEqual([['quenth', 'mask'], ['vorpik', 'flag']]);
  });

  it('log labels: custom:<category>:<term> for block / mask, flag:<category>:<term> for review-only hits', () => {
    const s = set([E('zorblax', 'block', { category: 'crew a' }), E('vorpik', 'flag', { category: 'crew c' })]);
    const r = filterChat('zorblax vorpik', { custom: s });
    expect(r.hits.map(hitLabel)).toEqual(['custom:crew a:zorblax', 'flag:crew c:vorpik']);
    // built-in hits keep "category:term"
    const F = compiled().terms.find((t) => t.tier === 'mask' && t.mode === 'strong')!;
    expect(filterChat(F.key).hits.map(hitLabel)).toEqual([`profanity:${F.term}`]);
  });

  it("categories 'threat' / 'selfharm' keep their Zone meaning (blockCategories)", () => {
    const s = set([E('zorblax', 'block', { category: 'threat' })]);
    expect(blockCategories(filterChat('zorblax', { custom: s }).hits)).toEqual(['threat']);
  });

  it('scope: chat-only entries never touch names, names-only entries never touch chat', () => {
    const s = set([E('zorblax', 'block', { scope: 'chat' }), E('quenth', 'block', { scope: 'names' }), E('vorpik', 'block')]);
    expect(filterChat('zorblax', { custom: s }).action).toBe('block');
    expect(checkName('Zorblax', { custom: s }).ok).toBe(true);
    expect(filterChat('quenth', { custom: s }).action).toBe('pass');
    expect(checkName('Quenth', { custom: s }).ok).toBe(false);
    expect(filterChat('vorpik', { custom: s }).action).toBe('block');
    expect(checkName('Vorpik_7', { custom: s }).ok).toBe(false);
  });

  it("names: 'flag' allows the name and reports the hits; block / mask refuse it with a custom reason", () => {
    const s = set([E('vorpik', 'flag', { category: 'crew c' }), E('zorblax', 'mask', { category: 'crew a' })]);
    const f = checkName('xX_Vorpik_Xx', { custom: s });
    expect(f.ok).toBe(true);
    expect(f.action).toBe('flag');
    expect(f.hits?.map((h) => [h.term, h.tier, h.category])).toEqual([['vorpik', 'flag', 'crew c']]);
    const m = checkName('VorpikZorblax', { custom: s });
    expect(m.ok).toBe(false);
    expect(m.reason).toBe('offensive name (custom: crew a)');
    expect(m.hits?.map((h) => h.tier)).toEqual(['mask', 'flag']);
    expect(checkName('Ace_Pilot', { custom: s })).toEqual({ ok: true });
  });

  it('installed set vs the per-call option (null = built-ins only)', () => {
    expect(activeCustomTerms()).toBeNull();
    setCustomTerms([E('zorblax', 'block')]);
    expect(activeCustomTerms()?.size).toBe(1);
    expect(filterChat('zorblax').action).toBe('block');
    expect(filterChat('zorblax', { custom: null }).action).toBe('pass');
    expect(filterChat('quenth', { custom: set([E('quenth', 'mask')]) }).action).toBe('mask');
    setCustomTerms([]);
    expect(activeCustomTerms()).toBeNull();
    expect(filterChat('zorblax').action).toBe('pass');
  });
});

describe('number codes (custom): whole digit runs only', () => {
  it('matches the code as a standalone run in chat and names, never inside a longer number or split by letters', () => {
    const s = set([E('7351', 'flag', { category: 'code' }), E('4096', 'block', { category: 'code b' })]);
    for (const v of ['7351', 'room 7351', '73 51', '73.51', '(7351)', 'x7351', '７３５１']) {
      const r = filterChat(v, { custom: s });
      expect(r.action, v).toBe('flag');
      expect(r.text).toBe(v);
      expect(r.hits[0]).toMatchObject({ term: '7351', tier: 'flag', source: 'custom' });
    }
    for (const v of ['17351', '73510', '7351.5', '3.7351', '73 51 2', '73..51', `${'1'.repeat(20)}7351`]) expect(filterChat(v, { custom: s }).action, v).toBe('pass');
    expect(filterChat('4096 now', { custom: s })).toMatchObject({ action: 'block', text: '4*** now' });
    expect(checkName('Pilot7351', { custom: s })).toMatchObject({ ok: true, action: 'flag' });
    expect(checkName('Ace_40_96', { custom: s }).ok).toBe(false);
    expect(checkName('40Ace96', { custom: s }).ok).toBe(true);
    expect(checkName('Pilot40961', { custom: s }).ok).toBe(true);
  });

  it('a code that is its own group next to another number still counts (regression: "7351 2", "Ace_7351_2")', () => {
    const s = set([E('7351', 'block', { category: 'code' })]);
    // chat: the whole run, or one group of it (split by a space, - _ / | :), is a number; only that group is starred
    for (const [v, shown] of [['7351 7351', '7*** 7***'], ['wave 3 7351', 'wave 3 7***'], ['7351 2', '7*** 2'], ['7351 42', '7*** 42'],
      ['gg 7351 2', 'gg 7*** 2'], ['7351 1', '7*** 1'], ['1-7351', '1-7***'], ['73 51 7351', '73 51 7***'], ['9 73.51', '9 7***']] as const) {
      expect(filterChat(v, { custom: s }), v).toMatchObject({ action: 'block', text: shown });
    }
    // ...but never a longer number, two groups that only line up into the code, or a decimal
    for (const v of ['73 51 2', '3 73 51', '73510 2', '7351.5', '2 7351.5', '1.7351']) expect(filterChat(v, { custom: s }).action, v).toBe('pass');
    // names: the same groups
    for (const n of ['Ace_7351_2', 'Ace 7351 7351', 'Pilot_1_7351', 'Pilot7351_7', 'Ace-7351-9']) expect(checkName(n, { custom: s }).ok, n).toBe(false);
    for (const n of ['Pilot73517', '3_73_51', '73Ace51', 'Ace_73_51_2']) expect(checkName(n, { custom: s }).ok, n).toBe(true);
    // a code anchor sees groups too
    const an = set([E('vorpik', 'block', { anchors: ['7351'] })]);
    expect(filterChat('vorpik 7351 2', { custom: an }).action).toBe('block');
    expect(filterChat('vorpik 73512', { custom: an }).action).toBe('pass');
  });

  it('zero-width characters on either side of a separator do not split a number (regression)', () => {
    const s = set([E('7351', 'mask', { category: 'code' })]);
    for (const v of ['73\u200b.51', '73.\u200b51', '73\u200b\u200c 51', '73 \u2060\u200b51', '7\u200b351']) {
      expect(filterChat(v, { custom: s }).action, JSON.stringify(v)).toBe('mask');
    }
    expect(filterChat('73\u200b..51', { custom: s }).action).toBe('pass');
  });
});

describe('short custom terms (2-3 letters: initials) only count typed as one piece', () => {
  it('never across spaces or punctuation: lettered objective callouts stay clean (regression)', () => {
    const s = set([E('bc', 'block'), E('qx', 'block'), E('abc', 'block'), E('dab', 'mask'), E('zv', 'flag')]);
    for (const v of ['hold A B C', 'pads B C are ours', 'zone b c', 'grid B C', 'rotate b, c next', 'B.C.', 'we hold A B C', 'zone A B C',
      'A B C D all ours', 'take a b c', 'pad D, A, B', 'D A B', 'b-c', 'Q X', 'plan q x', 'z v', 'hold a.b.c']) {
      expect(filterChat(v, { custom: s }), v).toMatchObject({ action: 'pass', hits: [] });
    }
    for (const n of ['Ace_B_C', 'B_C', 'A_B_C', 'D.A.B']) expect(checkName(n, { custom: s }), n).toEqual({ ok: true });
    // typed as one piece they still count, with leet and look-alikes
    for (const v of ['bc', 'BC', 'b.c.x bc', 'go qx', 'abc!', 'ABC', 'dab on them']) expect(filterChat(v, { custom: s }).action, v).not.toBe('pass');
    expect(filterChat('zv', { custom: s }).action).toBe('flag');
    expect(checkName('XxBCxX', { custom: s }).ok).toBe(false);
    // a 4+ letter term keeps the spelled-out matching (w o r d s)
    expect(filterChat('z o r b', { custom: set([E('zorb', 'mask')]) }).action).toBe('mask');
    // a phrase is the host's explicit choice of separate words
    expect(filterChat('a bc', { custom: set([E('a bc', 'mask')]) }).action).toBe('mask');
  });
});

describe('context anchors (post-pass gate)', () => {
  it('an anchored entry counts only when one of its anchors matches in the same line', () => {
    const s = set([
      E('7351', 'block', { category: 'code', anchors: ['zorblax', 'quenth vorpik'] }),
      E('skreel', 'mask', { anchors: ['4096'] }),
    ]);
    expect(filterChat('wave 7351 incoming', { custom: s }).action).toBe('pass');
    expect(filterChat('zorblax 7351', { custom: s }).action).toBe('block');
    expect(filterChat('7351 ... Z0RBLAXES', { custom: s }).action).toBe('block');
    expect(filterChat('7351 quenth vorpik', { custom: s }).action).toBe('block');
    expect(filterChat('7351 quenth', { custom: s }).action).toBe('pass');
    expect(filterChat('skreel', { custom: s }).action).toBe('pass');
    expect(filterChat('skreel 4096', { custom: s }).action).toBe('mask');
    expect(filterChat('skreel 40960', { custom: s }).action).toBe('pass');
    // an anchor is not a hit by itself
    expect(filterChat('zorblax quenth vorpik 4096', { custom: s })).toEqual({ text: 'zorblax quenth vorpik 4096', action: 'pass', hits: [] });
  });

  it('names: anchors count inside the same name', () => {
    const s = set([E('7351', 'block', { anchors: ['zorblax'] })]);
    expect(checkName('Pilot7351', { custom: s }).ok).toBe(true);
    expect(checkName('Zorblax7351', { custom: s }).ok).toBe(false);
    expect(checkName('xxzorblaxxx_7351', { custom: s }).ok).toBe(false);
  });

  it('the same term with and without anchors: the strictest entry that applies wins', () => {
    const s = set([E('zorblax', 'flag', { category: 'watch' }), E('zorblax', 'block', { category: 'crew', anchors: ['quenth'] })]);
    expect(filterChat('zorblax', { custom: s }).hits.map(hitLabel)).toEqual(['flag:watch:zorblax']);
    expect(filterChat('zorblax quenth', { custom: s }).hits.map(hitLabel)).toEqual(['custom:crew:zorblax']);
    expect(s.diagnostics.map((d) => d.code)).toContain('duplicate-term');
  });
});

describe('custom terms never weaken the built-in lists', () => {
  const builtIn = (tier: string): TermInfo => compiled().terms.find((t) => t.tier === tier && t.mode !== 'phrase' && !t.nameOnly && t.key.length >= 4)!;

  it("a 'flag' / 'mask' entry spelled like a built-in block-tier term cannot lower it (and says so)", () => {
    const t = builtIn('block');
    for (const action of ['flag', 'mask'] as const) {
      const r = compileCustomTerms([E(t.key, action, { id: 'x' })]);
      expect(r.ok).toBe(true);
      const d = r.diagnostics.find((x) => x.code === 'custom-builtin-collision')!;
      expect(d.message).toMatch(/built-in block-tier/);
      expect(d.message).toMatch(new RegExp(`this entry's '${action}' cannot lower it`));
      expect(d.message).not.toContain(t.key);
      expect(d).toMatchObject({ entries: [0], ids: ['x'] });
      expect(filterChat(`hey ${t.key}`, { custom: r.set }).action).toBe('block');
      expect(checkName(t.key, { custom: r.set }).ok).toBe(false);
    }
  });

  it("a 'block' entry spelled like a built-in mask-tier term makes it stricter; both labels are reported", () => {
    const t = builtIn('mask');
    const s = set([E(t.key, 'block', { category: 'local' })]);
    const r = filterChat(`oh ${t.key}`, { custom: s });
    expect(r.action).toBe('block');
    expect(r.hits.map((h) => [h.source, h.tier])).toEqual([['custom', 'block'], ['builtin', 'mask']]);
  });

  it('allowlisted clean words still protect: a custom term inside one is ignored there, but a term equal to one is meant', () => {
    const s = set([E('ssass', 'mask', { match: 'strong' }), E('spice', 'flag')]);
    expect(filterChat('the assassin', { custom: s }).action).toBe('pass');
    expect(filterChat('xssassx', { custom: s }).action).toBe('mask');
    expect(filterChat('spice', { custom: s }).action).toBe('flag');
    expect(filterChat('spicy food', { custom: s }).action).toBe('pass');
    const inside = s.diagnostics.filter((d) => d.code === 'inside-allow-word');
    expect(inside.map((d) => d.entries)).toEqual([[1], [0]]); // canonical order: 'spice' sorts before 'ssass'
    expect(inside[1].message).toMatch(/^entry #0 occurs inside \d+ allowlisted clean words? \(e\.g\. "[a-z]+"\): matches inside those words are ignored$/);
  });
});

describe('scan: the word-start shortcut is exact', () => {
  it('in chat, walking the word / phrase trie from word starts only finds exactly the hits of a walk from every position', () => {
    // word / phrase entries and anchors only (no 'strong'), built from the game vocabulary so they really occur
    const s = set([
      E('arena', 'flag'), E('pilot', 'mask'), E('wave', 'block', { anchors: ['boss'] }), E('rocket salvo', 'flag'),
      E('flag', 'mask'), E('blink', 'flag', { scope: 'chat' }), E('zone', 'mask'), E('the hive', 'block'), E('gg', 'flag'),
      E('boise', 'flag'), E('team', 'mask'), E('floor', 'flag', { anchors: ['boss', 'descend'] }), E('shot', 'mask'),
    ]);
    expect(s.walks.chat).toHaveLength(1);
    expect(s.walks.chat[0].wordStarts).toBe(true);
    const key = (hs: RawHit[]): string => hs.map((h) => `${h.term.rank}:${h.s}:${h.e}`).sort().join(' ');
    const lines = [...fpChatLines(), 'BigArena', 'x.arena', '7pilots', 'pilot99', 'go-zone', 'ArenaPilotWave', 'a r e n a', 'ar3na'];
    let hits = 0;
    const opt = { strict: true, name: false };
    for (const line of lines) {
      const starts = scanCustomSets(buildStream(line), s.walks.chat, opt, s.marks, { spans: null });
      const every = scanCustomSets(buildStream(line), [{ set: s.walks.chat[0].set, wordStarts: false }], opt, s.marks, { spans: null });
      expect(key(starts), line).toBe(key(every));
      hits += starts.length;
    }
    expect(hits).toBeGreaterThan(500);
  });
});

describe('determinism and diagnostics', () => {
  const entries: CustomTermInput[] = [
    E('zorblax', 'block', { id: 'a', anchors: ['quenth', '7351'] }), E('quenth vorpik', 'mask', { id: 'b' }),
    E('7351', 'flag', { id: 'c', scope: 'names' }), E('skreel', 'flag', { id: 'd', match: 'strong' }), E('drellik', 'mask', { id: 'e', scope: 'chat' }),
  ];
  const lines = ['zorblax', 'zorblax quenth', 'quenth vorpik 7351', 'Pilot7351', 'xxskreelxx drellik', 'nothing here'];

  it('the same entries in any order give the same set (fingerprint, entries, results)', () => {
    const a = set(entries);
    const b = set([...entries].reverse());
    const c = set([entries[2], entries[0], entries[4], entries[1], entries[3]]);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).toBe(a.fingerprint);
    expect(b.entries().map((e) => e.id)).toEqual(a.entries().map((e) => e.id));
    for (const l of lines) {
      expect(JSON.stringify(filterChat(l, { custom: b }))).toBe(JSON.stringify(filterChat(l, { custom: a })));
      expect(JSON.stringify(checkName(l, { custom: c }))).toBe(JSON.stringify(checkName(l, { custom: a })));
    }
    expect(set([...entries, E('glimmark', 'flag')]).fingerprint).not.toBe(a.fingerprint);
    expect(a.stats()).toEqual({ entries: 5, block: 1, mask: 2, flag: 2, chat: 1, names: 1, both: 3, codes: 1, anchored: 1, anchors: 2 });
  });

  it('reports duplicates and anchors inside their own term, never a built-in term', () => {
    const s = set([E('zorblax', 'flag'), E('Zor-Blax', 'mask', { id: 'z2' }), E('quenthor', 'flag', { match: 'strong', anchors: ['quenth'] })]);
    const codes = s.diagnostics.map((d) => d.code);
    expect(codes).toContain('duplicate-term');
    expect(codes).toContain('anchor-inside-term');
    expect(s.diagnostics.find((d) => d.code === 'duplicate-term')).toMatchObject({ entries: [0, 1], ids: ['z2'] });
  });
});
