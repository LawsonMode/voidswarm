// OWNER: FILTER agent. Public API of the shared chat / name filter.
//
//   filterChat(text, opts?)  → { text, action: 'pass' | 'mask' | 'block', hits }
//   checkName(name, opts?)   → { ok, reason?, hits? }       (callsigns, account usernames, room names, bot names)
//   isSpam(recent, text, now) → boolean                      (repeat flood; see spam.ts)
//   tameText(text)           → text with shouting lowercased and character floods collapsed (display only)
//
// Default strictness is 'strict' (classroom): profanity AND mild words (damn, hell, crap, ...) are starred out;
// 'standard' lets the mild tier through. Slurs, hate, sexual terms, threats and self-harm statements always block
// the whole line. Pure and deterministic, no DOM / Node APIs: the Node server and the browser's offline Zone run
// exactly the same code. Word lists live in lists.ts (ROT13); the matcher in engine.ts.
import { buildStream, compiled, scanStream, streamText, type RawHit, type ScanOptions, type Stream } from './engine';
import { NUMERIC_TERMS, rot5, type Category, type Tier } from './lists';

export { isSpam, tameText, collapseFlood, isShouting, spamKey, type RecentLine } from './spam';
export {
  SPAM_REPEAT_COUNT, SPAM_REPEAT_MS, CAPS_MIN_LEN, CAPS_RATIO, FLOOD_KEEP,
} from './spam';
export type { Category, MatchMode, Tier } from './lists';

export type Strictness = 'strict' | 'standard';
export const DEFAULT_STRICTNESS: Strictness = 'strict';

/**
 * A host setting (e.g. the server's CHAT_FILTER env var) -> Strictness. Only 'standard' (any case, trimmed) relaxes
 * the filter; anything else (unset, empty, a typo) is 'strict', the classroom-safe default.
 */
export function parseStrictness(v: unknown): Strictness {
  return typeof v === 'string' && v.trim().toLowerCase() === 'standard' ? 'standard' : 'strict';
}

export interface FilterOptions {
  /** 'strict' (default, classroom) also masks the mild tier; 'standard' lets it through. */
  strictness?: Strictness;
}

export type FilterAction = 'pass' | 'mask' | 'block';

/**
 * One matched term. `term` is the canonical spelling (for the moderator log — never show it back in chat);
 * `tier` 'block' withholds the line, 'mask' stars the word (a mild word in strict mode is a 'mask' hit).
 * String(hit) is the term, so `hits.map(String)` gives a log-friendly list.
 */
export class FilterHit {
  constructor(readonly term: string, readonly tier: 'mask' | 'block', readonly category: Category) {}
  toString(): string { return this.term; }
  toJSON(): { term: string; tier: 'mask' | 'block'; category: Category } {
    return { term: this.term, tier: this.tier, category: this.category };
  }
}

export interface FilterResult {
  /** What to show: the input for 'pass'; offending words starred ("f***") for 'mask' AND 'block' (never shown). */
  text: string;
  action: FilterAction;
  /** Distinct matched terms, most severe first (at most one entry per term). */
  hits: FilterHit[];
}

export interface NameCheck {
  ok: boolean;
  /** Log-friendly reason when refused ("offensive name (profanity)"); never contains the matched term. */
  reason?: string;
  /** The matched terms (for the moderator log). */
  hits?: FilterHit[];
}

/** Longest string the filter looks at (chat lines are CHAT_MAX_LEN = 200); the rest is cut first. */
export const FILTER_MAX_INPUT = 4000;

/** Stars after the kept first letter: one per hidden letter, at least 1, at most MAX_STARS. */
const MAX_STARS = 8;

const TIER_ORDER: Readonly<Record<Tier, number>> = { block: 0, mask: 1, mild: 2 };

function scan(text: string, strict: boolean, name: boolean): { st: Stream; hits: RawHit[] } {
  const opt: ScanOptions = { strict, name };
  const st = buildStream(text);
  return { st, hits: scanStream(st, opt) };
}

/**
 * Distinct terms, most severe first. A hit lying inside an already-kept hit of the same or a higher tier is
 * dropped ("motherf...er" reports one term, not also its 4-letter core; "f**k" reports one reading, not every
 * term its wildcards could spell).
 */
function reportHits(raw: readonly RawHit[]): FilterHit[] {
  const sorted = [...raw].sort((a, b) => TIER_ORDER[a.term.tier] - TIER_ORDER[b.term.tier]
    || (b.e - b.s) - (a.e - a.s) || (b.te - b.s) - (a.te - a.s) || a.term.rank - b.term.rank);
  const kept: RawHit[] = [];
  for (const h of sorted) {
    if (!kept.some((k) => k.s <= h.s && k.e >= h.e)) kept.push(h);
  }
  const seen = new Set<string>();
  const out: FilterHit[] = [];
  for (const h of kept) {
    if (seen.has(h.term.key)) continue;
    seen.add(h.term.key);
    out.push(new FilterHit(h.term.term, h.term.tier === 'block' ? 'block' : 'mask', h.term.category));
  }
  return out;
}

/** A span of the ORIGINAL text to star out: [o0, o1) UTF-16 offsets; `hidden` = how many stars it stands for. */
interface MaskSpan { o0: number; o1: number; hidden: number }

/** Star out every span: keep the first visible character of each (merged) span, then 1..MAX_STARS '*'. */
function maskText(text: string, st: Stream, raw: readonly RawHit[], extra: readonly MaskSpan[] = []): string {
  const spans: MaskSpan[] = raw.map((h) => ({ o0: st.oStart[h.s], o1: st.oEnd[h.e - 1], hidden: h.e - h.s - 1 }));
  for (const x of extra) spans.push(x);
  spans.sort((a, b) => a.o0 - b.o0 || b.o1 - a.o1);
  const merged: MaskSpan[] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.o0 < last.o1) {
      last.o1 = Math.max(last.o1, sp.o1);
      last.hidden = Math.max(last.hidden, sp.hidden);
    } else merged.push({ ...sp });
  }
  let out = '';
  let at = 0;
  for (const { o0, o1, hidden } of merged) {
    if (o0 < at) continue;
    const first = String.fromCodePoint(text.codePointAt(o0) ?? 42);
    out += text.slice(at, o0) + first + '*'.repeat(Math.min(MAX_STARS, Math.max(1, hidden)));
    at = o1;
  }
  return out + text.slice(at);
}

// ---------------------------------------------------------------------------------------------------------------
// Number codes (lists.ts NUMERIC_TERMS): digits are not letters to the word matcher, so they get their own scan.
// ---------------------------------------------------------------------------------------------------------------

let NUMERIC: { code: string; category: Category }[] | null = null;
const numericTerms = (): { code: string; category: Category }[] =>
  (NUMERIC ??= NUMERIC_TERMS.map((t) => ({ code: rot5(t.code), category: t.category })));

/** Separators allowed (one at a time) between the digits of one code ("14 88", "14.88", "14/88"). */
const DIGIT_SEP = new Set([' ', '.', '-', '_', '|', '/', ':', '\u00B7']);
const RE_FORMAT = /^\p{Cf}$/u;

/** Decimal value of one character: ASCII, fullwidth, mathematical or other compatibility digits; else -1. */
function digitOf(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c < 128) return c >= 48 && c <= 57 ? c - 48 : -1;
  const k = ch.normalize('NFKC');
  if (k.length === 1) {
    const d = k.charCodeAt(0);
    if (d >= 48 && d <= 57) return d - 48;
  }
  return -1;
}

/** Digit runs of `text` that spell a listed code exactly (a longer number such as "21488" does not). */
function numericSpans(text: string): { span: MaskSpan; hit: FilterHit }[] {
  const codes = numericTerms();
  const out: { span: MaskSpan; hit: FilterHit }[] = [];
  const at = (i: number): [string, number] => {
    const cp = text.codePointAt(i) ?? 0;
    const w = cp > 0xFFFF ? 2 : 1;
    return [text.slice(i, i + w), w];
  };
  for (let i = 0; i < text.length;) {
    const [ch, w] = at(i);
    if (digitOf(ch) < 0) { i += w; continue; }
    let digits = '';
    let end = i;
    let j = i;
    while (j < text.length && digits.length <= 16) {
      const [c2, w2] = at(j);
      if (digitOf(c2) >= 0) { digits += String(digitOf(c2)); j += w2; end = j; continue; }
      if (RE_FORMAT.test(c2)) { j += w2; continue; } // zero-width characters between digits
      if (j === end && DIGIT_SEP.has(c2) && j + w2 < text.length && digitOf(at(j + w2)[0]) >= 0) { j += w2; continue; }
      break;
    }
    const code = codes.find((x) => x.code === digits);
    if (code) out.push({ span: { o0: i, o1: end, hidden: digits.length - 1 }, hit: new FilterHit(code.code, 'mask', code.category) });
    i = Math.max(end, i + w);
  }
  return out;
}

/** Codes hidden anywhere in a name's digits ("Pilot1488", "14Ace88"). */
function numericInName(name: string): FilterHit[] {
  let digits = '';
  for (const ch of name) { const d = digitOf(ch); if (d >= 0) digits += String(d); }
  if (digits.length < 2) return [];
  return numericTerms().filter((x) => digits.includes(x.code)).map((x) => new FilterHit(x.code, 'block', x.category));
}

/**
 * Filter one chat line. 'block' when any block-tier term matches (slur, hate, sexual, threat, self-harm);
 * otherwise 'mask' when profanity (or, in strict mode, a mild word) matches; otherwise 'pass'.
 * Matching sees through case, leetspeak, look-alike letters, zero-width characters, repeated letters, spacing /
 * punctuation between letters and common suffixes, while boundary rules + an allowlist keep ordinary words
 * ("class", "Scunthorpe", "cocktail") clean.
 */
export function filterChat(text: unknown, opts?: FilterOptions): FilterResult {
  let input = typeof text === 'string' ? text : '';
  if (input.length > FILTER_MAX_INPUT) input = input.slice(0, FILTER_MAX_INPUT);
  if (!input) return { text: input, action: 'pass', hits: [] };
  const strict = (opts?.strictness ?? DEFAULT_STRICTNESS) !== 'standard';
  const { st, hits } = scan(input, strict, false);
  const nums = numericSpans(input);
  if (!hits.length && !nums.length) return { text: input, action: 'pass', hits: [] };
  const report = reportHits(hits);
  for (const x of nums) if (!report.some((h) => h.term === x.hit.term)) report.push(x.hit);
  const action: FilterAction = report.some((h) => h.tier === 'block') ? 'block' : 'mask';
  return { text: maskText(input, st, hits, nums.map((x) => x.span)), action, hits: report };
}

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  slur: 'slur', hate: 'hate', sexual: 'sexual', threat: 'threat', selfharm: 'self-harm', profanity: 'profanity', mild: 'profanity',
};

/**
 * May `name` be used as a callsign / account username / room name / bot name? Any hit refuses it — including
 * the mild tier in strict mode, the name-only list (hate figures), and longer terms hidden inside a word
 * ("xxBadWordxx"). Empty / non-string input is ok (the caller's sanitizer supplies a fallback).
 */
export function checkName(name: unknown, opts?: FilterOptions): NameCheck {
  let input = typeof name === 'string' ? name : '';
  if (input.length > FILTER_MAX_INPUT) input = input.slice(0, FILTER_MAX_INPUT);
  if (!input) return { ok: true };
  const strict = (opts?.strictness ?? DEFAULT_STRICTNESS) !== 'standard';
  const { hits } = scan(input, strict, true);
  const nums = numericInName(input);
  if (!hits.length && !nums.length) return { ok: true };
  const report = [...reportHits(hits), ...nums];
  return { ok: false, reason: `offensive name (${CATEGORY_LABEL[report[0].category]})`, hits: report };
}

/**
 * The normalized letter stream the matcher sees ("Ｓh1t  h3ad" → "shit head"): lowercase a-z, one space per
 * boundary. Handy as a search key for the moderator log.
 */
export function foldText(text: unknown): string {
  const input = typeof text === 'string' ? text.slice(0, FILTER_MAX_INPUT) : '';
  compiled();
  return streamText(buildStream(input));
}

/** Term counts per tier (for diagnostics / the admin page; never the terms themselves). */
export function listStats(): { block: number; mask: number; mild: number; nameOnly: number; allow: number } {
  const c = compiled();
  const out = { block: 0, mask: 0, mild: 0, nameOnly: 0, allow: c.allowPhrase.length };
  for (const t of c.terms) {
    if (t.nameOnly) out.nameOnly++;
    else out[t.tier]++;
  }
  return out;
}
