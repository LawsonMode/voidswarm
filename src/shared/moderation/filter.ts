// OWNER: FILTER agent. Public API of the shared chat / name filter.
//
//   filterChat(text, opts?)  → { text, action: 'pass' | 'flag' | 'mask' | 'block', hits }
//   checkName(name, opts?)   → { ok, action?: 'flag', reason?, hits? }   (callsigns, account usernames, room names, bot names)
//   isSpam(recent, text, now) → boolean                      (repeat flood; see spam.ts)
//   tameText(text)           → text with shouting lowercased and character floods collapsed (display only)
//   setCustomTerms(entries) / clearCustomTerms() / compileCustomTerms(entries)   (host-managed terms; see custom.ts)
//
// Default strictness is 'strict' (classroom): profanity AND mild words (damn, hell, crap, ...) are starred out;
// 'standard' lets the mild tier through. Slurs, hate, sexual terms, threats and self-harm statements always block
// the whole line. Pure and deterministic, no DOM / Node APIs: the Node server and the browser's offline Zone run
// exactly the same code. Word lists live in lists.ts (ROT13); the matcher in engine.ts; the host's runtime custom
// terms in custom.ts (scanned on their own, so they only ever add hits).
import { activeCustomTerms, scanCustom, type CustomTermSet } from './custom';
import {
  buildStream, builtinCodes, compiled, digitRuns, forEachNumber, scanStream, streamText,
  type AllowCache, type DigitRun, type RawHit, type ScanOptions, type Stream,
} from './engine';
import type { Category, Tier } from './lists';

export { isSpam, tameText, collapseFlood, isShouting, spamKey, type RecentLine } from './spam';
export {
  SPAM_REPEAT_COUNT, SPAM_REPEAT_MS, CAPS_MIN_LEN, CAPS_RATIO, FLOOD_KEEP,
} from './spam';
export type { Category, MatchMode, Tier } from './lists';
export {
  CUSTOM_LIMITS, CustomTermSet, activeCustomTerms, clearCustomTerms, compileCustomTerms, setCustomTerms,
  type CustomAction, type CustomCompileOptions, type CustomCompileResult, type CustomField, type CustomMatch,
  type CustomScope, type CustomTermEntry, type CustomTermError, type CustomTermInput, type CustomTermStats,
} from './custom';
export { builtinDiagnostics, type CompileDiagnostic } from './engine';

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
  /**
   * Custom terms for this call: omitted = the host's installed set (setCustomTerms), null = built-in lists only,
   * or a set from compileCustomTerms.
   */
  custom?: CustomTermSet | null;
}

/**
 * 'pass' = nothing matched; 'flag' = only review-only custom hits (shown unchanged, logged for review, no strike);
 * 'mask' = starred words; 'block' = withheld.
 */
export type FilterAction = 'pass' | 'flag' | 'mask' | 'block';
/** A hit's tier: 'block' withholds, 'mask' stars the word, 'flag' only reports it (custom terms). */
export type HitTier = 'mask' | 'block' | 'flag';
export type HitSource = 'builtin' | 'custom';

/**
 * One matched term. `term` is the canonical spelling (for the moderator log — never show it back in chat);
 * `tier` 'block' withholds the line, 'mask' stars the word (a mild word in strict mode is a 'mask' hit), 'flag'
 * (custom terms only) leaves the line as typed and only reports the hit. `category` is a lists.ts Category for
 * built-in hits and the host's label for custom ones; `source` says which; `id` is the custom entry's id.
 * String(hit) is the term, so `hits.map(String)` gives a log-friendly list.
 */
export class FilterHit {
  constructor(
    readonly term: string,
    readonly tier: HitTier,
    readonly category: string,
    readonly source: HitSource = 'builtin',
    readonly id: string | null = null,
  ) {}
  toString(): string { return this.term; }
  toJSON(): { term: string; tier: HitTier; category: string; source?: 'custom'; id?: string } {
    const o: { term: string; tier: HitTier; category: string; source?: 'custom'; id?: string } = { term: this.term, tier: this.tier, category: this.category };
    if (this.source === 'custom') {
      o.source = 'custom';
      if (this.id) o.id = this.id;
    }
    return o;
  }
}

export interface FilterResult {
  /** What to show: the input for 'pass' / 'flag'; offending words starred ("f***") for 'mask' AND 'block' (never shown). */
  text: string;
  action: FilterAction;
  /** Distinct matched terms, most severe first (block, mask, flag; at most one entry per term and source). */
  hits: FilterHit[];
}

export interface NameCheck {
  ok: boolean;
  /** 'flag': the name is allowed, but review-only custom terms matched (`hits`, tier 'flag') — log it, no strike. */
  action?: 'flag';
  /** Log-friendly reason when refused ("offensive name (profanity)"); never contains the matched term. */
  reason?: string;
  /** The matched terms (for the moderator log). */
  hits?: FilterHit[];
}

/** Longest string the filter looks at (chat lines are CHAT_MAX_LEN = 200); the rest is cut first. */
export const FILTER_MAX_INPUT = 4000;

/** Stars after the kept first letter: one per hidden letter, at least 1, at most MAX_STARS. */
const MAX_STARS = 8;

const TIER_ORDER: Readonly<Record<Tier | 'flag', number>> = { block: 0, mask: 1, mild: 2, flag: 3 };
const HIT_ORDER: Readonly<Record<HitTier, number>> = { block: 0, mask: 1, flag: 2 };

/** A number-code hit: the span to star (unless tier 'flag') and the reported hit. */
interface NumHit { span: MaskSpan; hit: FilterHit }

interface Scan {
  st: Stream;
  /** built-in word hits (after the allowlist) */
  builtin: RawHit[];
  /** custom word hits (after the allowlist and the anchor gate) */
  custom: RawHit[];
  /** number codes: built-in and custom */
  nums: NumHit[];
}

const NO_RUNS: readonly DigitRun[] = [];

/** Does the text contain a digit (ASCII fast path; any non-ASCII character is checked by digitRuns itself)? */
function mayHaveDigits(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 48 && c <= 57) || c >= 128) return true;
  }
  return false;
}

function resolveCustom(opts: FilterOptions | undefined): CustomTermSet | null {
  const c = opts?.custom === undefined ? activeCustomTerms() : opts.custom;
  return c && c.size ? c : null;
}

/** One pass over `text`: built-in words, number codes, then the custom terms (with their anchor gate). */
function scan(text: string, strict: boolean, name: boolean, custom: CustomTermSet | null): Scan {
  const opt: ScanOptions = { strict, name };
  const st = buildStream(text);
  const cache: AllowCache = { spans: null };
  const builtin = scanStream(st, opt, cache);
  const runs = mayHaveDigits(text) ? digitRuns(text) : NO_RUNS;
  const nums: NumHit[] = [];
  if (runs.length) {
    const codes = builtinCodes();
    // the whole run, or one group of it standing on its own ("wave 3 <code>", "Ace_<code>_2")
    const check = (r: DigitRun): void => {
      const category = r.digits ? codes.get(r.digits) : undefined;
      // chat: starred and logged — mask tier, so an innocent number costs no strike; names: refused
      if (category) nums.push({ span: runSpan(r), hit: new FilterHit(r.digits, name ? 'block' : 'mask', category) });
    };
    for (const r of runs) forEachNumber(r, check);
  }
  let customHits: RawHit[] = [];
  if (custom) {
    const r = scanCustom(custom, st, runs, opt, cache);
    customHits = r.hits;
    for (const x of r.codes) {
      nums.push({ span: runSpan(x.run), hit: new FilterHit(x.info.term, x.info.tier as HitTier, x.info.category, 'custom', x.info.id) });
    }
  }
  return { st, builtin, custom: customHits, nums };
}

const runSpan = (r: DigitRun): MaskSpan => ({ o0: r.o0, o1: r.o1, hidden: Math.max(1, r.digits.length - 1) });

const hitTierOf = (t: RawHit['term']['tier']): HitTier => (t === 'block' ? 'block' : t === 'flag' ? 'flag' : 'mask');

/**
 * Distinct terms of ONE source, most severe first. A hit lying inside an already-kept hit of the same or a higher
 * tier is dropped ("motherf...er" reports one term, not also its 4-letter core; "f**k" reports one reading, not
 * every term its wildcards could spell).
 */
function reportHits(raw: readonly RawHit[]): FilterHit[] {
  if (!raw.length) return [];
  const sorted = [...raw].sort((a, b) => TIER_ORDER[a.term.tier] - TIER_ORDER[b.term.tier]
    || (b.e - b.s) - (a.e - a.s) || (b.te - b.s) - (a.te - a.s) || a.term.rank - b.term.rank);
  const kept: RawHit[] = [];
  outer: for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    for (let j = 0; j < kept.length; j++) if (kept[j].s <= h.s && kept[j].e >= h.e) continue outer;
    kept.push(h);
  }
  const seen = new Set<string>();
  const out: FilterHit[] = [];
  for (const h of kept) {
    if (seen.has(h.term.key)) continue;
    seen.add(h.term.key);
    const t = h.term;
    out.push(t.source === 'custom'
      ? new FilterHit(t.term, hitTierOf(t.tier), t.category, 'custom', t.id)
      : new FilterHit(t.term, hitTierOf(t.tier), t.category));
  }
  return out;
}

/**
 * Every hit of a scan: built-in words, custom words, then number codes; at most one entry per term and source;
 * most severe first (a stable sort, so built-in hits keep their order within a tier). Built-in and custom hits are
 * reported side by side — a custom entry spelled like a built-in term shows up with its own label.
 */
function reportAll(sc: Scan): FilterHit[] {
  const out = [...reportHits(sc.builtin), ...reportHits(sc.custom)];
  for (const x of sc.nums) {
    if (!out.some((h) => h.source === x.hit.source && h.term === x.hit.term)) out.push(x.hit);
  }
  return out.sort((a, b) => HIT_ORDER[a.tier] - HIT_ORDER[b.tier]);
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

/**
 * Filter one chat line. 'block' when any block-tier term matches (slur, hate, sexual, threat, self-harm, or a
 * custom 'block' entry); otherwise 'mask' when profanity (or, in strict mode, a mild word, or a custom 'mask' entry)
 * matches; otherwise 'flag' when only review-only custom entries matched (the line is shown as typed); otherwise
 * 'pass'. Matching sees through case, leetspeak, look-alike letters, zero-width characters, repeated letters,
 * spacing / punctuation between letters and common suffixes, while boundary rules + an allowlist keep ordinary words
 * ("class", "Scunthorpe", "cocktail") clean. Number codes match whole digit runs only.
 */
export function filterChat(text: unknown, opts?: FilterOptions): FilterResult {
  let input = typeof text === 'string' ? text : '';
  if (input.length > FILTER_MAX_INPUT) input = input.slice(0, FILTER_MAX_INPUT);
  if (!input) return { text: input, action: 'pass', hits: [] };
  const strict = (opts?.strictness ?? DEFAULT_STRICTNESS) !== 'standard';
  const sc = scan(input, strict, false, resolveCustom(opts));
  if (!sc.builtin.length && !sc.custom.length && !sc.nums.length) return { text: input, action: 'pass', hits: [] };
  const report = reportAll(sc);
  const action: FilterAction = report.some((h) => h.tier === 'block') ? 'block' : report.some((h) => h.tier === 'mask') ? 'mask' : 'flag';
  if (action === 'flag') return { text: input, action, hits: report };
  const words = sc.custom.length ? [...sc.builtin, ...sc.custom.filter((h) => h.term.tier !== 'flag')] : sc.builtin;
  const spans = sc.nums.filter((x) => x.hit.tier !== 'flag').map((x) => x.span);
  return { text: maskText(input, sc.st, words, spans), action, hits: report };
}

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  slur: 'slur', hate: 'hate', sexual: 'sexual', threat: 'threat', selfharm: 'self-harm', profanity: 'profanity', mild: 'profanity',
};

const labelOf = (h: FilterHit): string =>
  (h.source === 'custom' ? `custom: ${h.category}` : CATEGORY_LABEL[h.category as Category] ?? h.category);

/**
 * May `name` be used as a callsign / account username / room name / bot name? Any block / mask hit refuses it —
 * including the mild tier in strict mode, the name-only list (hate figures), longer terms hidden inside a word
 * ("xxBadWordxx") and number codes as a whole digit run or a group of one ("Pilot<code>", "Ace_<co>_<de>",
 * "Ace_<code>_2", but not "<co>Ace<de>"). A callsign's number is a number, not leet completing a term inside the
 * name ("Juliana1" is fine).
 * Only review-only custom hits → ok, with action 'flag' and the hits (log it, no strike). Empty / non-string input
 * is ok (the caller's sanitizer supplies a fallback).
 */
export function checkName(name: unknown, opts?: FilterOptions): NameCheck {
  let input = typeof name === 'string' ? name : '';
  if (input.length > FILTER_MAX_INPUT) input = input.slice(0, FILTER_MAX_INPUT);
  if (!input) return { ok: true };
  const strict = (opts?.strictness ?? DEFAULT_STRICTNESS) !== 'standard';
  const sc = scan(input, strict, true, resolveCustom(opts));
  if (!sc.builtin.length && !sc.custom.length && !sc.nums.length) return { ok: true };
  const report = reportAll(sc);
  const refusing = report.find((h) => h.tier !== 'flag');
  if (!refusing) return { ok: true, action: 'flag', hits: report };
  return { ok: false, reason: `offensive name (${labelOf(refusing)})`, hits: report };
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
    else if (t.tier !== 'flag') out[t.tier]++;
  }
  return out;
}
