// OWNER: FILTER agent. Runtime CUSTOM TERMS for the chat / name filter: a list the HOST manages (e.g. from the admin
// console of a school deployment), compiled next to the built-in lists (lists.ts) at run time. Nothing here ships
// any terms: the engine is content-neutral, and the host supplies the entries.
//
//   compileCustomTerms(entries, opts?) → { ok, set, errors, diagnostics, accepted, rejected }   (pure; installs nothing)
//   setCustomTerms(entries, opts?)     → the same, and installs the set for every later filterChat / checkName call
//   clearCustomTerms()                 → back to the built-in lists only
//   activeCustomTerms()                → the installed set (null = none)
//
// One entry: { term, category?, action: 'block' | 'mask' | 'flag', scope?: 'chat' | 'names' | 'both',
// match?: 'word' | 'phrase' | 'strong', anchors?: string[], id? }.
//  - term: plain words (a phrase has 2+ words) or a digit code ("7351"). It goes through the SAME normalizer as chat,
//    so case, accents, look-alike letters, fullwidth / styled letters, zero-width characters and punctuation between
//    letters are all folded ("Zörb-lax" is "zorblax"), and every evasion the built-in lists see through (leetspeak,
//    look-alikes, spacing, repeats, suffixes) matches the custom term too. Leetspeak, wildcards and regular
//    expressions are refused in the term itself: list the plain spelling. A word typed in parts of 2+ letters joined
//    by - _ . ("Zorb-Lax") also matches with the parts spaced out ("zorb lax"). A term under 4 letters (initials) only
//    counts typed as one piece, never spelled out across spaces / punctuation ("bc" is not "hold A B C").
//  - action: 'block' withholds the line (a strike, like a built-in block-tier term), 'mask' stars the word out,
//    'flag' ALLOWS the line / name unchanged and only reports the hit (tier 'flag'), so the host can log it for review
//    with no strike and no mute.
//  - scope: chat lines, names (callsigns, usernames, room names) or both (default).
//  - match: 'word' (default for one word: boundary to boundary plus common suffixes; names: 4+ letters also inside a
//    longer word, like built-ins), 'phrase' (default for 2+ words: the words in a row however they are spaced),
//    'strong' (anywhere, even inside another word; 4+ letters). Digit codes always match a WHOLE digit run or a
//    whole group of one (engine.ts digitRuns / forEachNumber: "7351", "7351 2", but never "173510" or "7351.5").
//  - anchors: context words / codes. An anchored entry counts only when at least one anchor matches in the same line
//    (or the same name) — gating is a post-pass over the hits after the trie scan and the digit runs, O(hits).
//  - category: a free label (sanitized: lowercase a-z 0-9 space _ -, at most 24 characters; default 'custom'). Hits
//    carry it with source 'custom'. The labels 'threat' and 'selfharm' keep their built-in meaning in the Zone
//    ("self-harm", "Self Harm", "self_harm" are stored as 'selfharm', "threats" as 'threat').
//
// Custom terms never weaken the built-in lists: they live in their own trie, so the built-in scan runs exactly as
// before and a custom entry can only ADD hits (a 'flag' entry spelled like a built-in block-tier term still blocks).
// The compile is deterministic: entries are put in a canonical order first, so the same entries in any order give
// the same set (same fingerprint, same results).
import { fnv1a } from '../util/hash';
import {
  AnchorMarks, buildMatchSet, builtinCodes, compiled, digitValue, forEachNumber, letterWords, readsAsLetter, scanCustomSets,
  type AllowCache, type CompileDiagnostic, type DigitRun, type MatchSet, type RawHit, type ScanOptions, type SetWalk,
  type Stream, type TermInfo,
} from './engine';
import type { MatchMode } from './lists';

export type CustomAction = 'block' | 'mask' | 'flag';
export type CustomScope = 'chat' | 'names' | 'both';
export type CustomMatch = 'word' | 'phrase' | 'strong';

/** One host-supplied entry. Unknown fields are ignored. */
export interface CustomTermInput {
  /** plain words (2+ words = a phrase) or a digit code */
  term: string;
  /** free label, sanitized (default 'custom') */
  category?: string;
  action: CustomAction;
  /** default 'both' */
  scope?: CustomScope;
  /** default 'word' for one word, 'phrase' for several; digit codes always match whole numbers */
  match?: CustomMatch;
  /** context words / codes: the entry counts only when one of them matches in the same line / name */
  anchors?: readonly string[];
  /** the host's id for the entry (returned on its hits, and in errors / diagnostics) */
  id?: string;
}

/** Validation caps (they also bound the compile's memory and the scan's cost). */
export const CUSTOM_LIMITS = Object.freeze({
  maxEntries: 2000,
  /** characters of a term / an anchor as typed */
  maxTermChars: 64,
  maxCategoryChars: 24,
  maxIdChars: 64,
  maxAnchors: 8,
  /** letters of a word / phrase term or anchor (after normalization) */
  minLetters: 2,
  /** 'strong' terms match inside other words, so they must be longer */
  minStrongLetters: 4,
  maxPhraseWords: 8,
  minCodeDigits: 2,
  maxCodeDigits: 12,
  /** letters of every term + distinct anchor together (the trie's size) */
  maxTotalLetters: 40_000,
  maxDistinctAnchors: 2000,
});

export type CustomField = 'list' | 'entry' | 'term' | 'category' | 'action' | 'scope' | 'match' | 'anchors' | 'id';

/** A validation error: `index` = the entry's position in the input (-1 = the list itself). */
export interface CustomTermError { index: number; id?: string; field: CustomField; message: string }

/** An entry as the filter reads it (for the host to review what will be matched). */
export interface CustomTermEntry {
  /** position in the input */
  index: number;
  id: string | null;
  kind: 'letters' | 'digits';
  /** normalized: lowercase letter words joined by one space, or the digits */
  term: string;
  category: string;
  action: CustomAction;
  scope: CustomScope;
  match: CustomMatch;
  /** normalized anchors */
  anchors: string[];
  /**
   * true: a one-word term typed in parts joined by - _ . ("Zorb-Lax"): it matches as one word AND with the parts
   * spaced out ("zorb lax"); absent otherwise
   */
  spaced?: true;
}

export interface CustomTermStats {
  entries: number;
  block: number; mask: number; flag: number;
  chat: number; names: number; both: number;
  /** digit-code entries */
  codes: number;
  /** entries with anchors */
  anchored: number;
  /** distinct anchors */
  anchors: number;
}

/** A digit code's entries and the anchors spelled with those digits. */
interface CodeEntry { terms: TermInfo[]; anchorIds: number[] }

/** A compiled, immutable custom-term set. Build it with compileCustomTerms / setCustomTerms. */
export class CustomTermSet {
  /**
   * @internal the letter tries to walk in chat / in names: 'strong' entries in one trie (walked from every
   * position), word / phrase entries and anchors in another — in chat those can only match from a word start, so
   * that trie is walked from word starts only; in names (4+ letters count inside a word) from every position.
   */
  readonly walks: { readonly chat: readonly SetWalk[]; readonly names: readonly SetWalk[] };
  /** @internal digit codes → entries / anchors */
  readonly codes: ReadonlyMap<string, CodeEntry>;
  /** @internal anchor presence marks, reused by every scan */
  readonly marks: AnchorMarks;
  /** Number of entries. */
  readonly size: number;
  /** Stable hash of the normalized entries: the same entries in any order give the same fingerprint. */
  readonly fingerprint: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  private readonly list: readonly CustomTermEntry[];
  private readonly counts: CustomTermStats;

  /** @internal */
  constructor(p: {
    strong: MatchSet | null; words: MatchSet | null; codes: Map<string, CodeEntry>; anchorCount: number; list: CustomTermEntry[];
    fingerprint: string; diagnostics: CompileDiagnostic[];
  }) {
    const chat: SetWalk[] = [];
    const names: SetWalk[] = [];
    if (p.strong) { chat.push({ set: p.strong, wordStarts: false }); names.push({ set: p.strong, wordStarts: false }); }
    if (p.words) { chat.push({ set: p.words, wordStarts: true }); names.push({ set: p.words, wordStarts: false }); }
    this.walks = { chat, names };
    this.codes = p.codes;
    this.marks = new AnchorMarks(p.anchorCount);
    this.size = p.list.length;
    this.fingerprint = p.fingerprint;
    this.diagnostics = Object.freeze(p.diagnostics.slice());
    this.list = p.list;
    const s: CustomTermStats = { entries: p.list.length, block: 0, mask: 0, flag: 0, chat: 0, names: 0, both: 0, codes: 0, anchored: 0, anchors: p.anchorCount };
    for (const e of p.list) {
      s[e.action]++;
      s[e.scope]++;
      if (e.kind === 'digits') s.codes++;
      if (e.anchors.length) s.anchored++;
    }
    this.counts = s;
  }

  /** The entries as normalized, in canonical order (copies). */
  entries(): CustomTermEntry[] {
    return this.list.map((e) => ({ ...e, anchors: [...e.anchors] }));
  }

  stats(): CustomTermStats {
    return { ...this.counts };
  }
}

export interface CustomCompileResult {
  /**
   * false = nothing was compiled (every error is listed); with opts.partial, only list-level errors make it false —
   * including a partial list in which no entry is valid (so setCustomTerms keeps the installed set)
   */
  ok: boolean;
  set: CustomTermSet | null;
  errors: CustomTermError[];
  diagnostics: CompileDiagnostic[];
  /** entries in the set */
  accepted: number;
  /** entries refused (partial mode) or, when ok is false, every entry */
  rejected: number;
}

export interface CustomCompileOptions {
  /** Skip invalid entries instead of refusing the whole list (their errors are still reported). Default false. */
  partial?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

const ACTIONS: readonly CustomAction[] = ['block', 'mask', 'flag'];
const SCOPES: readonly CustomScope[] = ['chat', 'names', 'both'];
const MATCHES: readonly CustomMatch[] = ['word', 'phrase', 'strong'];
const ACTION_RANK: Readonly<Record<CustomAction, number>> = { flag: 0, mask: 1, block: 2 };

/** Regular-expression / wildcard syntax: refused (the normalizer handles the variants). */
const RE_REGEX = /[\\^$*+?()[\]{}|]/;
/** What a term may contain: letters (any script, marks) and digits, spaces, and the joiners - _ . */
const RE_TERM_CHAR = /^[\p{L}\p{M}\p{Nd}\s._-]$/u;
const RE_LETTER = /^\p{L}$/u;
const RE_DIGIT = /^\p{Nd}$/u;
const RE_CONTROL = /[\p{Cc}\p{Cf}]/gu;
const RE_CONTROL_CHAR = /^[\p{Cc}\p{Cf}]$/u;
const RE_MARKS = /\p{M}/gu;

/**
 * A term / anchor read by the normalizer. `spaced`: one word typed in parts joined by - _ . ("Zorb-Lax", each part
 * 2+ letters): it matches as one word AND with the parts spaced out ("zorb lax"), which is how players type it.
 */
interface Parsed { kind: 'letters' | 'digits'; key: string; words: string[]; spaced: boolean }

const RE_JOINERS = /[._-]+/;

/** Was this one-word term typed as 2+ parts of 2+ letters joined by - _ . ("Zorb-Lax"; not "z.o.r.b")? */
function joinedParts(text: string): boolean {
  if (!RE_JOINERS.test(text)) return false;
  const pieces = text.split(RE_JOINERS).filter((p) => p.trim());
  if (pieces.length < 2) return false;
  return pieces.every((p) => {
    const w = letterWords(p);
    return !!w && w.length === 1 && w[0].length >= 2;
  });
}

/** Read one term / anchor, or return why it can't be used. */
function parseTerm(raw: unknown, what: string): Parsed | string {
  if (typeof raw !== 'string') return `${what} must be a string`;
  const text = raw.trim();
  if (!text) return `${what} is empty`;
  if (text.length > CUSTOM_LIMITS.maxTermChars) return `${what} is longer than ${CUSTOM_LIMITS.maxTermChars} characters`;
  if (RE_REGEX.test(text)) {
    return `${what} looks like a regular expression or wildcard — list plain words; leetspeak, look-alike letters, `
      + 'spacing and word endings are matched automatically';
  }
  let letters = 0;
  let digits = 0;
  for (const ch of text) {
    if (!RE_TERM_CHAR.test(ch)) {
      const shown = RE_CONTROL_CHAR.test(ch) ? `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}` : `"${ch}"`;
      return `${what} has an unsupported character ${shown} — only letters, digits, spaces and - _ . (leetspeak is matched automatically; type the plain spelling)`;
    }
    if (RE_LETTER.test(ch)) {
      if (!readsAsLetter(ch)) return `${what} has a letter the filter can't match ("${ch}"): use Latin letters (accents and look-alikes are fine)`;
      letters++;
    } else if (RE_DIGIT.test(ch)) {
      if (digitValue(ch) < 0) return `${what} has a digit the filter doesn't read as a number ("${ch}")`;
      digits++;
    }
  }
  if (letters && digits) {
    return `${what} mixes letters and digits — list the plain spelling (leetspeak is matched automatically), or put a `
      + 'number code in its own entry and use the word as its anchor';
  }
  if (digits) {
    let d = '';
    for (const ch of text) { const v = digitValue(ch); if (v >= 0) d += String(v); }
    if (d.length < CUSTOM_LIMITS.minCodeDigits) return `${what} is too short: a number code needs at least ${CUSTOM_LIMITS.minCodeDigits} digits`;
    if (d.length > CUSTOM_LIMITS.maxCodeDigits) return `${what} is too long: a number code has at most ${CUSTOM_LIMITS.maxCodeDigits} digits`;
    return { kind: 'digits', key: d, words: [d], spaced: false };
  }
  if (!letters) return `${what} has no letters or digits`;
  const words = letterWords(text);
  if (!words) return `${what} has a character that doesn't read as one plain letter — type the plain spelling`;
  const key = words.join('');
  if (key.length < CUSTOM_LIMITS.minLetters) return `${what} is too short: at least ${CUSTOM_LIMITS.minLetters} letters`;
  if (words.length > CUSTOM_LIMITS.maxPhraseWords) return `${what} has more than ${CUSTOM_LIMITS.maxPhraseWords} words`;
  return { kind: 'letters', key, words, spaced: words.length === 1 && joinedParts(text) };
}

/** The Zone's built-in meaning of a label: spellings of 'selfharm' / 'threat' map to those ids. */
const CATEGORY_ALIASES: ReadonlyMap<string, string> = new Map([['selfharm', 'selfharm'], ['threat', 'threat'], ['threats', 'threat']]);

/** Sanitize a category label, or return why it can't be used. */
function parseCategory(raw: unknown): string | { error: string } {
  if (raw === undefined || raw === null || raw === '') return 'custom';
  if (typeof raw !== 'string') return { error: 'category must be a string' };
  if (raw.length > 200) return { error: `category is longer than ${CUSTOM_LIMITS.maxCategoryChars} characters` };
  const s = raw.normalize('NFKD').replace(RE_MARKS, '').toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { error: 'category has no usable characters (letters a-z, digits, space, - or _)' };
  if (s.length > CUSTOM_LIMITS.maxCategoryChars) return { error: `category is longer than ${CUSTOM_LIMITS.maxCategoryChars} characters` };
  // "self-harm", "Self Harm", "self_harm" (the spelling the product shows) keep the Zone's self-harm handling
  return CATEGORY_ALIASES.get(s.replace(/[ _-]/g, '')) ?? s;
}

/** Sanitize an id: a string or a finite number; printable, at most maxIdChars. */
function parseId(raw: unknown): string | null | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return { error: 'id must be a string' };
  const s = raw.replace(RE_CONTROL, '').trim();
  if (!s) return null;
  if (s.length > CUSTOM_LIMITS.maxIdChars) return { error: `id is longer than ${CUSTOM_LIMITS.maxIdChars} characters` };
  return s;
}

/** A validated entry, before the compile. */
interface Prepared {
  index: number;
  id: string | null;
  kind: 'letters' | 'digits';
  key: string;
  words: string[];
  category: string;
  action: CustomAction;
  scope: CustomScope;
  match: CustomMatch;
  anchors: Parsed[];
  /** a 'word' term typed in joined parts ("Zorb-Lax"): also compiled as a phrase (see Parsed.spaced) */
  spaced: boolean;
}

const anchorSig = (a: Parsed): string => `${a.kind}:${a.words.join(' ')}${a.spaced ? '~' : ''}`;

function prepareEntry(raw: unknown, index: number, errors: CustomTermError[]): Prepared | null {
  const before = errors.length;
  const err = (field: CustomField, message: string, id?: string | null): void => {
    errors.push(id ? { index, id, field, message } : { index, field, message });
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err('entry', 'entry must be an object'); return null; }
  const o = raw as Record<string, unknown>;
  const idR = parseId(o.id);
  const id = typeof idR === 'object' && idR ? null : (idR as string | null);
  if (typeof idR === 'object' && idR) err('id', idR.error);
  const term = parseTerm(o.term, 'term');
  if (typeof term === 'string') err('term', term, id);
  const cat = parseCategory(o.category);
  if (typeof cat === 'object') err('category', cat.error, id);
  const action = o.action;
  if (!(ACTIONS as readonly unknown[]).includes(action)) err('action', "action must be 'block', 'mask' or 'flag'", id);
  const scope = o.scope === undefined || o.scope === null ? 'both' : o.scope;
  if (!(SCOPES as readonly unknown[]).includes(scope)) err('scope', "scope must be 'chat', 'names' or 'both'", id);
  let match: CustomMatch = 'word';
  if (typeof term === 'object') {
    const multi = term.words.length > 1;
    const m = o.match === undefined || o.match === null ? (multi ? 'phrase' : 'word') : o.match;
    if (!(MATCHES as readonly unknown[]).includes(m)) err('match', "match must be 'word', 'phrase' or 'strong'", id);
    else if (term.kind === 'digits' && m !== 'word') err('match', 'a number code always matches a whole number: leave match out (or use \'word\')', id);
    else if (m === 'phrase' && !multi) err('match', "match 'phrase' needs two or more words", id);
    else if (m !== 'phrase' && multi) err('match', `the term has ${term.words.length} words: use match 'phrase'`, id);
    else if (m === 'strong' && term.key.length < CUSTOM_LIMITS.minStrongLetters) {
      err('match', `match 'strong' needs at least ${CUSTOM_LIMITS.minStrongLetters} letters (it matches inside other words)`, id);
    } else match = m as CustomMatch;
  }
  const anchors: Parsed[] = [];
  if (o.anchors !== undefined && o.anchors !== null) {
    if (!Array.isArray(o.anchors)) err('anchors', 'anchors must be a list of words or number codes', id);
    else if (o.anchors.length > CUSTOM_LIMITS.maxAnchors) err('anchors', `at most ${CUSTOM_LIMITS.maxAnchors} anchors per entry`, id);
    else {
      const seen = new Set<string>();
      o.anchors.forEach((a, k) => {
        const p = parseTerm(a, `anchor ${k + 1}`);
        if (typeof p === 'string') { err('anchors', p, id); return; }
        const sig = anchorSig(p);
        if (!seen.has(sig)) { seen.add(sig); anchors.push(p); }
      });
    }
  }
  if (errors.length > before || typeof term !== 'object' || typeof cat !== 'string') return null;
  return {
    index, id, kind: term.kind, key: term.key, words: term.words, category: cat, action: action as CustomAction,
    scope: scope as CustomScope, match, anchors, spaced: term.spaced && match === 'word',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------------------------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical order: the compile (ranks, trie layout, fingerprint) does not depend on the input order. */
function canonical(a: Prepared, b: Prepared): number {
  return cmp(a.kind, b.kind) || cmp(a.key, b.key) || ACTION_RANK[b.action] - ACTION_RANK[a.action]
    || cmp(a.scope, b.scope) || cmp(a.match, b.match) || cmp(a.words.join(' '), b.words.join(' '))
    || cmp(a.category, b.category) || cmp(a.anchors.map(anchorSig).sort().join('|'), b.anchors.map(anchorSig).sort().join('|'))
    || Number(a.spaced) - Number(b.spaced) || cmp(a.id ?? '', b.id ?? '') || a.index - b.index;
}

const who = (p: Prepared): string => `#${p.index}${p.id ? ` (id ${p.id})` : ''}`;

function diagnose(prepared: readonly Prepared[]): CompileDiagnostic[] {
  const c = compiled();
  const out: CompileDiagnostic[] = [];
  const withIds = (list: readonly Prepared[]): Pick<CompileDiagnostic, 'entries' | 'ids'> => {
    const ids = list.map((p) => p.id).filter((x): x is string => !!x);
    return ids.length ? { entries: list.map((p) => p.index), ids } : { entries: list.map((p) => p.index) };
  };
  // several entries with the same letters / digits
  const groups = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const k = `${p.kind}:${p.key}`;
    const g = groups.get(k);
    if (g) g.push(p); else groups.set(k, [p]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const list = [...g].sort((a, b) => a.index - b.index);
    out.push({
      code: 'duplicate-term',
      message: `entries ${list.map((p) => `#${p.index}`).join(', ')} normalize to the same ${list[0].kind === 'digits' ? 'number' : 'letters'}: `
        + 'on a line, the strictest one that applies (scope, anchors) wins',
      ...withIds(list),
    });
  }
  const codes = builtinCodes();
  for (const p of prepared) {
    // same letters / digits as a built-in entry: the built-in rule stays in force (it is scanned on its own)
    const b = p.kind === 'letters' ? c.byKey.get(p.key) : undefined;
    const bTier = b ? b.tier : p.kind === 'digits' && codes.has(p.key) ? 'mask' : null;
    if (bTier) {
      const what = b ? `a built-in ${b.tier}-tier ${b.category} term${b.nameOnly ? ' (names only)' : ''}`
        : `a built-in ${codes.get(p.key)} number code (masked in chat, refused in names)`;
      const bRank = bTier === 'block' ? 2 : bTier === 'flag' ? 0 : 1;
      const tail = ACTION_RANK[p.action] < bRank ? `, and this entry's '${p.action}' cannot lower it`
        : ACTION_RANK[p.action] > bRank ? `; this entry's '${p.action}' applies as well (the stricter wins)` : '';
      out.push({
        code: 'custom-builtin-collision',
        message: `entry ${who(p)} has the same ${p.kind === 'digits' ? 'digits' : 'letters'} as ${what}: the built-in rule stays in force${tail}`,
        ...withIds([p]),
      });
    }
    if (p.kind === 'letters') {
      const inside = c.allowKeys.filter((a) => a.length > p.key.length && a.includes(p.key));
      if (inside.length) {
        out.push({
          code: 'inside-allow-word',
          message: `entry ${who(p)} occurs inside ${inside.length} allowlisted clean word${inside.length === 1 ? '' : 's'} `
            + `(e.g. "${inside[0]}"): matches inside those words are ignored`,
          ...withIds([p]),
        });
      }
      for (const a of p.anchors) {
        if (a.kind === 'letters' && p.key.includes(a.key)) {
          out.push({
            code: 'anchor-inside-term',
            message: `entry ${who(p)}: anchor "${a.words.join(' ')}" is part of the term itself, so it is always present when the term is`,
            ...withIds([p]),
          });
        }
      }
    }
  }
  return out;
}

const tierOf = (a: CustomAction): TermInfo['tier'] => a;
const modeOf = (m: CustomMatch): MatchMode => m;

function build(prepared: Prepared[]): CustomTermSet | string {
  const list = [...prepared].sort(canonical);
  // distinct anchors, in canonical order → ids
  const anchorBySig = new Map<string, Parsed>();
  for (const p of list) for (const a of p.anchors) if (!anchorBySig.has(anchorSig(a))) anchorBySig.set(anchorSig(a), a);
  const anchorList = [...anchorBySig.entries()].sort((x, y) => cmp(x[0], y[0]));
  if (anchorList.length > CUSTOM_LIMITS.maxDistinctAnchors) return `too many distinct anchors: ${anchorList.length} (max ${CUSTOM_LIMITS.maxDistinctAnchors})`;
  let letters = 0;
  for (const p of list) if (p.kind === 'letters') letters += p.key.length;
  for (const [, a] of anchorList) if (a.kind === 'letters') letters += a.key.length;
  if (letters > CUSTOM_LIMITS.maxTotalLetters) return `the custom terms are too large: ${letters} letters in all (max ${CUSTOM_LIMITS.maxTotalLetters})`;
  const anchorId = new Map<string, number>(anchorList.map(([sig], i) => [sig, i]));

  // two tries: 'strong' entries (they match inside other words) and everything else (word / phrase entries and the
  // anchors, which in chat only ever match from a word start)
  const strongTerms = new Map<string, TermInfo[]>();
  const wordTerms = new Map<string, TermInfo[]>();
  const codes = new Map<string, CodeEntry>();
  const addKey = (map: Map<string, TermInfo[]>, key: string, info: TermInfo): void => {
    const l = map.get(key);
    if (l) l.push(info); else map.set(key, [info]);
  };
  const codeOf = (key: string): CodeEntry => {
    let e = codes.get(key);
    if (!e) { e = { terms: [], anchorIds: [] }; codes.set(key, e); }
    return e;
  };
  const entries: CustomTermEntry[] = [];
  list.forEach((p, i) => {
    const anchors = p.anchors.length ? [...new Set(p.anchors.map((a) => anchorId.get(anchorSig(a))!))].sort((x, y) => x - y) : null;
    const info: TermInfo = {
      rank: 1_000_000 + i, term: p.words.join(' '), key: p.key, tier: tierOf(p.action), category: p.category,
      mode: modeOf(p.match), nameOnly: p.scope === 'names', chat: p.scope !== 'names', names: p.scope !== 'chat',
      source: 'custom', id: p.id, anchors, anchorId: -1, origin: `custom #${p.index}`,
    };
    if (p.kind === 'letters') addKey(p.match === 'strong' ? strongTerms : wordTerms, p.key, info); else codeOf(p.key).terms.push(info);
    // typed in joined parts ("Zorb-Lax"): the same entry once more as a phrase, so "zorb lax" matches too
    if (p.spaced) addKey(wordTerms, p.key, { ...info, mode: 'phrase' });
    const entry: CustomTermEntry = {
      index: p.index, id: p.id, kind: p.kind, term: p.words.join(' '), category: p.category, action: p.action,
      scope: p.scope, match: p.match, anchors: p.anchors.map((a) => a.words.join(' ')),
    };
    if (p.spaced) entry.spaced = true;
    entries.push(entry);
  });
  anchorList.forEach(([, a], id) => {
    if (a.kind === 'digits') { codeOf(a.key).anchorIds.push(id); return; }
    const info: TermInfo = {
      rank: 2_000_000 + id, term: a.words.join(' '), key: a.key, tier: 'mask', category: '',
      mode: a.words.length > 1 ? 'phrase' : 'word', nameOnly: false, chat: true, names: true, source: 'custom',
      id: null, anchors: null, anchorId: id, origin: `anchor ${id}`,
    };
    addKey(wordTerms, a.key, info);
    if (a.spaced) addKey(wordTerms, a.key, { ...info, mode: 'phrase' });
  });
  const setOf = (map: Map<string, TermInfo[]>): MatchSet | null => {
    const keys = [...map.keys()];
    return keys.length ? buildMatchSet(keys, keys.map((k) => map.get(k)!)) : null;
  };
  const fp = JSON.stringify(entries.map((e) => [e.kind, e.term, e.category, e.action, e.scope, e.match, [...e.anchors].sort(), e.id, ...(e.spaced ? [1] : [])]));
  const fingerprint = `${fnv1a(fp).toString(16).padStart(8, '0')}${fnv1a(`${fp.length}:${fp}`).toString(16).padStart(8, '0')}-${entries.length}`;
  return new CustomTermSet({ strong: setOf(strongTerms), words: setOf(wordTerms), codes, anchorCount: anchorList.length, list: entries, fingerprint, diagnostics: diagnose(list) });
}

/**
 * Validate and compile host-supplied entries (installs nothing). Refuses the whole list on any error unless
 * opts.partial (then invalid entries are skipped and reported; a list in which EVERY entry is invalid is still
 * refused). Deterministic: the same entries in any order give the same set (every entry of a duplicated id is
 * refused, not the later ones).
 */
export function compileCustomTerms(entries: unknown, opts: CustomCompileOptions = {}): CustomCompileResult {
  let errors: CustomTermError[] = [];
  const fail = (total: number): CustomCompileResult => ({ ok: false, set: null, errors, diagnostics: [], accepted: 0, rejected: total });
  if (!Array.isArray(entries)) {
    errors.push({ index: -1, field: 'list', message: 'custom terms must be a list of entries' });
    return fail(0);
  }
  if (entries.length > CUSTOM_LIMITS.maxEntries) {
    errors.push({ index: -1, field: 'list', message: `too many entries: ${entries.length} (max ${CUSTOM_LIMITS.maxEntries})` });
    return fail(entries.length);
  }
  let prepared: Prepared[] = [];
  const idUse = new Map<string, number[]>();
  entries.forEach((raw, i) => {
    const p = prepareEntry(raw, i, errors);
    if (!p) return;
    if (p.id !== null) {
      const use = idUse.get(p.id);
      if (use) use.push(i); else idUse.set(p.id, [i]);
    }
    prepared.push(p);
  });
  // a duplicated id: every entry that uses it is refused (whichever comes first), so the input order never matters
  const dup = new Set<number>();
  for (const [id, use] of idUse) {
    if (use.length < 2) continue;
    for (const i of use) {
      dup.add(i);
      errors.push({ index: i, id, field: 'id', message: `duplicate id: entries ${use.map((k) => `#${k}`).join(', ')} use it` });
    }
  }
  if (dup.size) {
    prepared = prepared.filter((p) => !dup.has(p.index));
    errors = errors.map((e, k) => ({ e, k })).sort((a, b) => a.e.index - b.e.index || a.k - b.k).map((x) => x.e);
  }
  if (errors.length && !opts.partial) return fail(entries.length);
  // partial mode with nothing usable: refused, so a bad upload never silently removes the installed list
  if (errors.length && !prepared.length) {
    errors.push({ index: -1, field: 'list', message: 'no valid entries: nothing was compiled (to remove every custom term, install an empty list)' });
    return fail(entries.length);
  }
  const set = build(prepared);
  if (typeof set === 'string') {
    errors.push({ index: -1, field: 'list', message: set });
    return fail(entries.length);
  }
  return { ok: true, set, errors, diagnostics: [...set.diagnostics], accepted: set.size, rejected: entries.length - set.size };
}

// ---------------------------------------------------------------------------------------------------------------
// The installed set
// ---------------------------------------------------------------------------------------------------------------

let ACTIVE: CustomTermSet | null = null;

/**
 * Validate, compile and INSTALL a custom-term list for every later filterChat / checkName call that doesn't pass
 * its own `custom` option. Nothing changes when the result is not ok (the previous list stays installed).
 */
export function setCustomTerms(entries: unknown, opts: CustomCompileOptions = {}): CustomCompileResult {
  const r = compileCustomTerms(entries, opts);
  if (r.ok) ACTIVE = r.set && r.set.size ? r.set : null;
  return r;
}

/** Back to the built-in lists only. */
export function clearCustomTerms(): void {
  ACTIVE = null;
}

/** The installed custom-term set (null = none). */
export function activeCustomTerms(): CustomTermSet | null {
  return ACTIVE;
}

// ---------------------------------------------------------------------------------------------------------------
// Scan (filter.ts calls this on the stream it already built)
// ---------------------------------------------------------------------------------------------------------------

/** A custom number-code hit: the digit run and the entry. */
export interface CodeHit { run: DigitRun; info: TermInfo }

/**
 * Custom hits of one line / name: the letter walk (anchors set their marks), then the digit runs (codes and code
 * anchors), then the CONTEXT-GATING post-pass — an anchored entry survives only when one of its anchors was marked
 * in this same line / name. O(hits) after the scan.
 */
export function scanCustom(set: CustomTermSet, st: Stream, runs: readonly DigitRun[], opt: ScanOptions, cache: AllowCache): { hits: RawHit[]; codes: CodeHit[] } {
  const marks = set.marks;
  marks.begin();
  const walks = opt.name ? set.walks.names : set.walks.chat;
  let hits = walks.length ? scanCustomSets(st, walks, opt, marks, cache) : [];
  let codes: CodeHit[] = [];
  if (set.codes.size) {
    // the whole run, or one group of it standing on its own ("wave 3 7351", "Ace_7351_2"): codes and code anchors
    const check = (run: DigitRun): void => {
      if (!run.digits) return;
      const e = set.codes.get(run.digits);
      if (!e) return;
      for (const id of e.anchorIds) marks.mark(id);
      for (const info of e.terms) if (opt.name ? info.names : info.chat) codes.push({ run, info });
    };
    for (const run of runs) forEachNumber(run, check);
  }
  // context gating (post-pass): O(hits × anchors per entry), anchors per entry ≤ CUSTOM_LIMITS.maxAnchors
  if (hits.length) hits = hits.filter((h) => h.term.anchors === null || marks.any(h.term.anchors));
  if (codes.length) codes = codes.filter((x) => x.info.anchors === null || marks.any(x.info.anchors));
  return { hits, codes };
}
