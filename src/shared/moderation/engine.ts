// OWNER: FILTER agent. The matching engine behind filterChat / checkName (src/shared/moderation/filter.ts).
//
// Pure, deterministic and allocation-light: no DOM, no Node APIs, no regex on the hot path (regexes only classify a
// single non-ASCII code point, once, into a bounded cache). Runs identically in the Node server and the browser's
// offline Zone.
//
// Pipeline for one string:
//  1. normalize (buildStream): every code point becomes zero or more "positions", each a SET of candidate letters
//     a-z (bitmask) plus the UTF-16 span it came from. NFKD + mark stripping + Cyrillic/Greek/IPA look-alikes come
//     from room/util nameKey (imported, read-only), extended here with more look-alikes and leetspeak (0→o, 1→i|l,
//     @→a|o|u, $→s, ...). Zero-width / format characters vanish; whitespace, apostrophes and other punctuation become
//     boundary flags between positions (so "f.u.c.k" and "f u c k" are still one letter stream). camelCase humps
//     are soft boundaries. Runs of one letter are capped at 2 ("fuuuuck" → "fuuck").
//  2. match (scanStream): a trie of all terms walked as an NFA from every position — a position may match any of
//     its candidates, and a repeated letter may be absorbed ("fuuck" matches "fuck"). Each walk is bounded by twice
//     the longest term, so a scan is O(length × longest term): linear in the input, no backtracking blow-up.
//  3. accept: each raw match is checked against its term's mode (lists.ts MatchMode): word boundaries, suffixes
//     (a second trie), the spaced-out rules, the number rules (digits with no letter are a number; a number + unit
//     such as "45s" / "900k" is not leet; across a boundary a leet digit must read as a letter — see
//     digitsReadAsLetters), then the allowlist (a third trie; a hit inside an allowlisted word such as "Scunthorpe"
//     is dropped).
//
// The same walk runs over a second, host-supplied MatchSet: the runtime custom terms (custom.ts), which are
// compiled into their own trie so they can only ADD hits — the built-in lists are scanned exactly as before.
// Digits are not letters to the word matcher: number codes are matched on whole digit runs (digitRuns).
import { nameKey } from '../room/util';
import {
  ALLOW_WORDS, COMMON_SHORT_WORDS, NAME_ONLY_GROUPS, NUMERIC_TERMS, SUFFIXES, TERM_GROUPS, rot13, rot5,
  type Category, type MatchMode, type TermGroup, type Tier,
} from './lists';

// ---------------------------------------------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------------------------------------------

/**
 * Boundary flags between two positions. SOFT = punctuation / camelCase hump, SPACE = whitespace, HARD = apostrophe;
 * DASH comes with SOFT for a hyphen / dash ("5-hit combo": a number joined to a word, not a leet letter).
 */
const B_SOFT = 1;
const B_SPACE = 2;
const B_HARD = 4;
const B_DASH = 8;

/** Position kinds. */
const K_LETTER = 1;
const K_LEET = 2;
const K_DIGIT = 3;
const K_WILD = 4;

/** Char types. */
const T_IGNORE = 0;
const T_SPACE = 1;
const T_HARD = 2;
const T_SOFT = 3;
/** '-' and the Unicode dashes: a soft boundary that also sets B_DASH. */
const T_DASH = 6;
/** '!', '+', '|', '*': a letter only between two letters ("sh!t", "f**k"), punctuation otherwise. */
const T_COND = 4;
const T_POS = 5;

const ALL_LETTERS = (1 << 26) - 1;

interface CharInfo {
  readonly t: number;
  /** One candidate-letter bitmask per produced position ('æ' → a, e). */
  readonly masks: readonly number[];
  readonly kind: number;
  /** ASCII case: 0 none, 1 lower, 2 upper (camelCase humps). */
  readonly cas: number;
}

const bit = (letter: string): number => 1 << (letter.charCodeAt(0) - 97);
/** "il" → i|l (one position, two candidates). */
const maskOf = (letters: string): number => {
  let m = 0;
  for (const c of letters) if (c >= 'a' && c <= 'z') m |= bit(c);
  return m;
};

const IGNORE: CharInfo = { t: T_IGNORE, masks: [], kind: 0, cas: 0 };
const SPACE: CharInfo = { t: T_SPACE, masks: [], kind: 0, cas: 0 };
const HARD: CharInfo = { t: T_HARD, masks: [], kind: 0, cas: 0 };
const SOFT: CharInfo = { t: T_SOFT, masks: [], kind: 0, cas: 0 };
const DASH: CharInfo = { t: T_DASH, masks: [], kind: 0, cas: 0 };
const pos = (masks: number[], kind: number, cas = 0): CharInfo => ({ t: T_POS, masks, kind, cas });
const cond = (mask: number, kind: number): CharInfo => ({ t: T_COND, masks: [mask], kind, cas: 0 });

/** Digit leetspeak ('2' has no letter reading: it is punctuation). */
const DIGIT_LEET: Readonly<Record<string, string>> = {
  0: 'o', 1: 'il', 3: 'e', 4: 'a', 5: 's', 6: 'gb', 7: 't', 8: 'b', 9: 'g',
};

/**
 * Look-alikes and symbol leet beyond room/util nameKey (keys are lowercase). Value: positions separated by ',',
 * each a set of candidate letters ("vn" = v or n; "a,e" = two positions).
 */
const EXTRA: Readonly<Record<string, string>> = {
  // Latin letters NFKD leaves alone
  'ø': 'o', 'đ': 'd', 'ł': 'l', 'ħ': 'h', 'ŧ': 't', 'æ': 'a,e', 'œ': 'o,e',
  'ƒ': 'f', 'ĸ': 'k', 'ŋ': 'n', 'þ': 'p', 'ð': 'd', 'ɐ': 'a', 'ǝ': 'e', 'ɛ': 'e',
  'ɔ': 'c', 'ß': 'b',
  // symbols
  '€': 'e', '£': 'l', '¢': 'c', '©': 'c', '®': 'r', '¥': 'y', '¡': 'i', '§': 's',
  '∂': 'd', '†': 't', '√': 'v', '∩': 'n', '∪': 'u', '∑': 'e',
  // Greek (overrides: nu looks like v, mu like u, upsilon like u, eta like n, lunate sigma like c)
  'ν': 'vn', 'μ': 'um', 'µ': 'um', 'ς': 'cs', 'θ': 'o', 'π': 'n', 'δ': 'd',
  'υ': 'uy', 'ϒ': 'uy', 'η': 'nh', 'ϲ': 'c', 'Ϲ': 'c', 'σ': 'os', 'φ': 'f', 'ϕ': 'f', 'ϑ': 'o',
  // Cyrillic
  'и': 'nu', 'й': 'nu', 'я': 'r', 'ш': 'w', 'щ': 'w', 'ч': 'y', 'г': 'r', 'ц': 'u',
  'д': 'd', 'б': 'b', 'ф': 'f', 'ъ': 'b', 'э': 'e', 'є': 'e', 'ї': 'i', 'ґ': 'r',
  'ћ': 'h', 'ђ': 'h', 'л': 'n', 'ж': 'x',
  // Armenian
  'օ': 'o', 'ս': 'u', 'հ': 'h', 'ո': 'n', 'ց': 'g', 'ք': 'p',
};

/** Code point → letter: Cherokee and Lisu capitals that imitate Latin ones (their lowercase forms are added too). */
const EXTRA_CP: ReadonlyArray<readonly [number, string]> = [
  // Cherokee
  [0x13AA, 'a'], [0x13F4, 'b'], [0x13DF, 'c'], [0x13A0, 'd'], [0x13AC, 'e'], [0x13C0, 'g'], [0x13BB, 'h'], [0x13A5, 'i'],
  [0x13AB, 'j'], [0x13E6, 'k'], [0x13DE, 'l'], [0x13B7, 'm'], [0x13E2, 'p'], [0x13A1, 'r'], [0x13DA, 's'], [0x13A2, 't'],
  [0x13D9, 'v'], [0x13B3, 'w'], [0x13A9, 'y'], [0x13C3, 'z'],
  // Lisu
  [0xA4D0, 'b'], [0xA4D1, 'p'], [0xA4D3, 'd'], [0xA4D4, 't'], [0xA4D6, 'g'], [0xA4D7, 'k'], [0xA4D9, 'j'], [0xA4DA, 'c'],
  [0xA4DC, 'z'], [0xA4DD, 'f'], [0xA4DF, 'm'], [0xA4E0, 'n'], [0xA4E1, 'l'], [0xA4E2, 's'], [0xA4E3, 'r'], [0xA4E6, 'v'],
  [0xA4E7, 'h'], [0xA4EA, 'w'], [0xA4EB, 'x'], [0xA4EC, 'y'], [0xA4EE, 'a'], [0xA4F0, 'e'], [0xA4F2, 'i'], [0xA4F3, 'o'],
  [0xA4F4, 'u'],
];

/** Enclosed-letter blocks NFKD does not fold, A..Z: [first, last]. */
const LETTER_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x1F130, 0x1F149], // squared
  [0x1F150, 0x1F169], // negative circled
  [0x1F170, 0x1F189], // negative squared
  [0x1F1E6, 0x1F1FF], // regional indicators
];

/** Blank-rendering characters that are not \s: Hangul fillers, braille blank. They separate words. */
const BLANKS = new Set([0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800]);
/** Apostrophe look-alikes: a hard boundary ("he'll" is never "hell"). */
const APOSTROPHES = new Set([0x2018, 0x2019, 0x201B, 0x02BC, 0x02B9, 0x2032, 0x00B4, 0xFF07]);

const RE_IGNORE = /^[\p{Cf}\p{M}͏឴឵᠋-᠏]$/u;
const RE_SPACE = /^[\s\p{Cc}\p{Zs}\p{Zl}\p{Zp}]$/u;
const RE_MARKS = /\p{M}/gu;
const RE_DASH = /^[\p{Pd}−]$/u;

function buildAscii(): CharInfo[] {
  const t: CharInfo[] = [];
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if (c >= 97 && c <= 122) t.push(pos([bit(ch)], K_LETTER, 1));
    else if (c >= 65 && c <= 90) t.push(pos([bit(ch.toLowerCase())], K_LETTER, 2));
    else if (c >= 48 && c <= 57) t.push(DIGIT_LEET[ch] ? pos([maskOf(DIGIT_LEET[ch])], K_DIGIT) : SOFT);
    else if (c <= 32 || c === 127) t.push(SPACE);
    // '@' reads as a, o or u ("@ss", "f@ck", "b@@b")
    else if (ch === '@') t.push(pos([maskOf('aou')], K_LEET));
    else if (ch === '$') t.push(pos([bit('s')], K_LEET));
    else if (ch === '!') t.push(cond(bit('i'), K_LEET));
    else if (ch === '+') t.push(cond(bit('t'), K_LEET));
    else if (ch === '|') t.push(cond(maskOf('il'), K_LEET));
    else if (ch === '*') t.push(cond(ALL_LETTERS, K_WILD));
    else if (ch === "'" || ch === '`') t.push(HARD);
    else if (ch === '-') t.push(DASH);
    else t.push(SOFT);
  }
  return t;
}

const ASCII: readonly CharInfo[] = buildAscii();
let EXTRA_MAP: Map<number, CharInfo> | null = null;
const CHAR_CACHE = new Map<number, CharInfo>();
const CHAR_CACHE_MAX = 4096;

function extraMap(): Map<number, CharInfo> {
  if (EXTRA_MAP) return EXTRA_MAP;
  const m = new Map<number, CharInfo>();
  const put = (ch: string, spec: string): void => {
    const cp = ch.codePointAt(0);
    if (cp === undefined || m.has(cp)) return;
    m.set(cp, pos(spec.split(',').map(maskOf), K_LETTER));
  };
  for (const [k, v] of Object.entries(EXTRA)) put(k, v);
  for (const [cp, v] of EXTRA_CP) {
    const ch = String.fromCodePoint(cp);
    put(ch, v);
    const lo = ch.toLowerCase();
    if (lo !== ch && [...lo].length === 1) put(lo, v);
  }
  for (const [first, last] of LETTER_BLOCKS) {
    for (let cp = first; cp <= last; cp++) m.set(cp, pos([1 << (cp - first)], K_LETTER));
  }
  return (EXTRA_MAP = m);
}

function classifyNonAscii(cp: number, ch: string): CharInfo {
  if (BLANKS.has(cp)) return SPACE;
  if (APOSTROPHES.has(cp)) return HARD;
  if (RE_IGNORE.test(ch)) return IGNORE;
  if (RE_SPACE.test(ch)) return SPACE;
  if (RE_DASH.test(ch)) return DASH;
  const ex = extraMap();
  const direct = ex.get(cp);
  if (direct) return direct;
  const lo = ch.toLowerCase();
  if (lo !== ch && [...lo].length === 1) {
    const viaLower = ex.get(lo.codePointAt(0) ?? 0);
    if (viaLower) return viaLower;
  }
  // an accented / compatibility form of a listed look-alike ("ύ" → υ, "ϲ" → ς): the base letter's entry
  const base = [...ch.normalize('NFKD').replace(RE_MARKS, '')];
  if (base.length === 1 && base[0] !== ch) {
    const b = base[0];
    const viaBase = ex.get(b.codePointAt(0) ?? 0) ?? ex.get(b.toLowerCase().codePointAt(0) ?? 0);
    if (viaBase) return viaBase;
  }
  // NFKD, drop marks, Cyrillic/Greek/IPA look-alikes → Latin (room/util), then keep letters and leet digits.
  const folded = nameKey(ch);
  const masks: number[] = [];
  let letters = 0;
  for (const c of folded) {
    if (c >= 'a' && c <= 'z') { masks.push(bit(c)); letters++; } else if (DIGIT_LEET[c]) masks.push(maskOf(DIGIT_LEET[c]));
  }
  if (masks.length) return pos(masks, letters ? K_LETTER : K_DIGIT);
  return SOFT; // other scripts, symbols, emoji: word separators
}

function charInfo(cp: number, ch: string): CharInfo {
  let ci = CHAR_CACHE.get(cp);
  if (!ci) {
    ci = classifyNonAscii(cp, ch);
    if (CHAR_CACHE.size >= CHAR_CACHE_MAX) CHAR_CACHE.clear();
    CHAR_CACHE.set(cp, ci);
  }
  return ci;
}

// ---------------------------------------------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------------------------------------------

/** Max consecutive wildcard '*' that still count as letters ("f**k"); longer runs are decoration. */
const MAX_WILD_RUN = 3;
/** Max '*' in one whitespace-separated chunk for any of them to count as letters. */
const MAX_WILD_PER_CHUNK = 3;

/** Normalized letter stream of one string (module-level buffers, grown on demand; the filter is not re-entrant). */
export class Stream {
  n = 0;
  cap = 0;
  mask = new Int32Array(0);
  kind = new Uint8Array(0);
  /** bnd[i]: boundary flags between positions i-1 and i (bnd[n] = end). */
  bnd = new Uint8Array(0);
  oStart = new Int32Array(0);
  oEnd = new Int32Array(0);
  cas = new Uint8Array(0);
  /** may a word start at position i / end before position i (a boundary, or only digits up to one) */
  wStart = new Uint8Array(0);
  wEnd = new Uint8Array(0);
  letterPre = new Int32Array(0);
  wildPre = new Int32Array(0);
  digitPre = new Int32Array(0);

  ensure(size: number): void {
    if (size <= this.cap) return;
    const c = Math.max(size, this.cap * 2, 64);
    this.cap = c;
    this.mask = new Int32Array(c);
    this.kind = new Uint8Array(c);
    this.bnd = new Uint8Array(c + 1);
    this.oStart = new Int32Array(c);
    this.oEnd = new Int32Array(c);
    this.cas = new Uint8Array(c);
    this.wStart = new Uint8Array(c + 1);
    this.wEnd = new Uint8Array(c + 1);
    this.letterPre = new Int32Array(c + 1);
    this.wildPre = new Int32Array(c + 1);
    this.digitPre = new Int32Array(c + 1);
  }

  /** Is position i the first letter of a whitespace-separated chunk? */
  spaceStart(i: number): boolean { return i === 0 || (this.bnd[i] & B_SPACE) !== 0; }
  /** Does a whitespace-separated chunk end before position i? */
  spaceEnd(i: number): boolean { return i >= this.n || (this.bnd[i] & (B_SPACE | B_HARD)) !== 0; }
}

// Visible characters of the current string, before COND resolution.
const rawInfo: CharInfo[] = [];
let rawS = new Int32Array(64);
let rawE = new Int32Array(64);
let rawT = new Uint8Array(64);

const STREAM = new Stream();

/** Are the last k positions all mask m with no boundary between them (and before the next one)? */
function sameRun(st: Stream, n: number, m: number, k: number): boolean {
  for (let i = n - k; i < n; i++) {
    if (st.mask[i] !== m) return false;
    if (i > n - k && st.bnd[i] !== 0) return false;
  }
  return true;
}

/** Normalize `text` into the shared Stream. */
export function buildStream(text: string): Stream {
  const st = STREAM;
  const len = text.length;
  if (rawS.length < len) {
    const c = Math.max(len, rawS.length * 2);
    rawS = new Int32Array(c); rawE = new Int32Array(c); rawT = new Uint8Array(c);
  }
  // pass 1: classify visible code points
  let r = 0;
  for (let i = 0; i < len;) {
    const cp = text.codePointAt(i) ?? 0;
    const w = cp > 0xFFFF ? 2 : 1;
    const ci = cp < 128 ? ASCII[cp] : charInfo(cp, w === 1 ? text[i] : text.slice(i, i + 2));
    if (ci.t !== T_IGNORE) {
      rawInfo[r] = ci; rawS[r] = i; rawE[r] = i + w; rawT[r] = ci.t; r++;
    }
    i += w;
  }
  // pass 2a: a whitespace chunk with more than MAX_WILD_PER_CHUNK '*' is decoration ("a*b*c*d*"), not self-censoring
  for (let i = 0; i < r;) {
    let j = i;
    let stars = 0;
    while (j < r && rawT[j] !== T_SPACE) { if (rawT[j] === T_COND && rawInfo[j].kind === K_WILD) stars++; j++; }
    if (stars > MAX_WILD_PER_CHUNK) {
      for (let k = i; k < j; k++) if (rawT[k] === T_COND && rawInfo[k].kind === K_WILD) rawT[k] = T_SOFT;
    }
    i = j + 1;
  }
  // pass 2b: '!' '+' '|' '*' are letters only inside a word (a letter-ish char on both sides)
  for (let i = 0; i < r; i++) {
    if (rawT[i] !== T_COND) continue;
    let j = i;
    let wild = 0;
    while (j < r && rawT[j] === T_COND) { if (rawInfo[j].kind === K_WILD) wild++; j++; }
    const inside = i > 0 && rawT[i - 1] === T_POS && j < r && rawT[j] === T_POS && wild <= MAX_WILD_RUN;
    for (let k = i; k < j; k++) rawT[k] = inside ? T_POS : T_SOFT;
    i = j - 1;
  }
  // pass 3: positions
  st.ensure(len + 8);
  let n = 0;
  let pend = 0;
  for (let i = 0; i < r; i++) {
    const t = rawT[i];
    if (t === T_SPACE) { pend |= B_SPACE; continue; }
    if (t === T_HARD) { pend |= B_HARD; continue; }
    if (t === T_SOFT) { pend |= B_SOFT; continue; }
    if (t === T_DASH) { pend |= B_SOFT | B_DASH; continue; }
    const ci = rawInfo[i];
    const masks = ci.masks;
    for (let k = 0; k < masks.length; k++) {
      const m = masks[k];
      let b = k === 0 ? pend : 0;
      if (b === 0 && n > 0) {
        // camelCase humps: "bigDick" → big|Dick; a caps run into lowercase: "BIGdick" → BIG|dick
        const pc = st.cas[n - 1];
        if (ci.cas === 2 && pc === 1) b = B_SOFT;
        else if (ci.cas === 1 && pc === 2 && n > 1 && st.cas[n - 2] === 2 && st.bnd[n - 1] === 0) b = B_SOFT;
      }
      // cap runs of one letter at 2 ("fuuuuck" → "fuuck"; an ambiguous one such as '1' = i|l at 3, since "111"
      // may be "lli"); the dropped char joins the previous span
      const capRun = (m & (m - 1)) === 0 ? 2 : 3;
      if (b === 0 && n >= capRun && sameRun(st, n, m, capRun)) {
        st.oEnd[n - 1] = rawE[i];
        continue;
      }
      st.mask[n] = m;
      st.kind[n] = ci.kind;
      st.bnd[n] = b;
      st.oStart[n] = rawS[i];
      st.oEnd[n] = rawE[i];
      st.cas[n] = ci.cas;
      n++;
    }
    pend = 0;
  }
  st.n = n;
  st.bnd[n] = B_SPACE | B_HARD;
  // word starts / ends ("ass1", "1ass": digits at a word's edge don't hide it), letter & wildcard prefix sums
  st.letterPre[0] = 0; st.wildPre[0] = 0; st.digitPre[0] = 0;
  let allDigits = true;
  for (let i = 0; i < n; i++) {
    const boundary = i === 0 || st.bnd[i] !== 0;
    if (boundary) allDigits = true;
    st.wStart[i] = boundary || allDigits ? 1 : 0;
    allDigits = allDigits && st.kind[i] === K_DIGIT;
    st.letterPre[i + 1] = st.letterPre[i] + (st.kind[i] === K_LETTER ? 1 : 0);
    st.wildPre[i + 1] = st.wildPre[i] + (st.kind[i] === K_WILD ? 1 : 0);
    st.digitPre[i + 1] = st.digitPre[i] + (st.kind[i] === K_DIGIT ? 1 : 0);
  }
  allDigits = true;
  st.wEnd[n] = 1;
  for (let i = n - 1; i >= 0; i--) {
    allDigits = allDigits && st.kind[i] === K_DIGIT;
    st.wEnd[i] = st.bnd[i] !== 0 || allDigits ? 1 : 0;
    if (st.bnd[i] !== 0) allDigits = true;
  }
  return st;
}

// ---------------------------------------------------------------------------------------------------------------
// Tries
// ---------------------------------------------------------------------------------------------------------------

export class Trie {
  /** child[node * 26 + letter] (0 = none; the root is never a child) */
  readonly child: Int32Array;
  /** the letter on the edge into node */
  readonly letter: Uint8Array;
  /** payload index of a word ending at node, or -1 */
  readonly out: Int32Array;
  readonly size: number;
  readonly rootMask: number;
  readonly maxLen: number;

  constructor(words: readonly string[]) {
    let cap = 64;
    let child = new Int32Array(cap * 26);
    let letter = new Uint8Array(cap);
    let out = new Int32Array(cap).fill(-1);
    let size = 1;
    let maxLen = 0;
    words.forEach((w, idx) => {
      let node = 0;
      for (let i = 0; i < w.length; i++) {
        const l = w.charCodeAt(i) - 97;
        let c = child[node * 26 + l];
        if (!c) {
          if (size >= cap) {
            cap *= 2;
            const nc = new Int32Array(cap * 26); nc.set(child); child = nc;
            const nl = new Uint8Array(cap); nl.set(letter); letter = nl;
            const no = new Int32Array(cap).fill(-1); no.set(out); out = no;
          }
          c = size++;
          child[node * 26 + l] = c;
          letter[c] = l;
        }
        node = c;
      }
      if (w.length && out[node] < 0) out[node] = idx;
      maxLen = Math.max(maxLen, w.length);
    });
    let rootMask = 0;
    for (let l = 0; l < 26; l++) if (child[l]) rootMask |= 1 << l;
    this.child = child; this.letter = letter; this.out = out; this.size = size;
    this.rootMask = rootMask; this.maxLen = maxLen;
  }
}

/** NFA state buffers: one pair per walk that can be live at the same time (terms → suffix; allowlist). */
const MAX_STATES = 1024;
const termA = new Int32Array(MAX_STATES);
const termB = new Int32Array(MAX_STATES);
const sufA = new Int32Array(MAX_STATES);
const sufB = new Int32Array(MAX_STATES);
const allowA = new Int32Array(MAX_STATES);
const allowB = new Int32Array(MAX_STATES);
/** Per-node dedupe stamps (a fresh generation per step, so the tries can share it). */
let stamp = new Int32Array(0);
let gen = 0;

/** Make the shared stamp buffer big enough for a trie of `size` nodes (2 states per node). Never shrinks. */
export function ensureStamp(size: number): void {
  const need = 2 * (size + 1);
  if (stamp.length >= need) return;
  stamp = new Int32Array(need);
  gen = 0;
}

/**
 * One NFA step: states cur[0..count) consume a position with candidate mask m. Writes the next states into nxt
 * and returns their count. A state is node * 2 + absorbed: besides following a child edge, a state may absorb
 * ONE repeat of the letter that led into it ("fuuck" — runs are already capped at 2 when the stream is built), so
 * every walk dies within 2 × (term length) positions whatever the input.
 */
function step(t: Trie, cur: Int32Array, count: number, m: number, nxt: Int32Array): number {
  if (++gen >= 0x7FFFFFFF) { stamp.fill(0); gen = 1; }
  let k = 0;
  const child = t.child;
  const letter = t.letter;
  for (let i = 0; i < count; i++) {
    const state = cur[i];
    const node = state >> 1;
    if (node !== 0 && !(state & 1) && ((m >>> letter[node]) & 1)) {
      const rep = state | 1;
      if (stamp[rep] !== gen) { stamp[rep] = gen; if (k < MAX_STATES) nxt[k++] = rep; }
    }
    let mm = m;
    const base = node * 26;
    while (mm) {
      const low = mm & -mm;
      mm ^= low;
      const c = child[base + (31 - Math.clz32(low))];
      if (c) {
        const s2 = c << 1;
        if (stamp[s2] !== gen) { stamp[s2] = gen; if (k < MAX_STATES) nxt[k++] = s2; }
      }
    }
  }
  return k;
}

/** Wildcards ('*' inside a word) one match may use ("f**k" uses 2); bounds the fan-out of "a*a*a*...". */
const MAX_WILD_PER_MATCH = 2;

// ---------------------------------------------------------------------------------------------------------------
// Compiled lists
// ---------------------------------------------------------------------------------------------------------------

/** A term's tier inside the engine: the list tiers plus 'flag' (custom terms only: allowed, logged for review). */
export type EngineTier = Tier | 'flag';
/** Where a term comes from: the built-in lists (lists.ts) or the host's runtime custom terms (custom.ts). */
export type TermSource = 'builtin' | 'custom';

export interface TermInfo {
  /** position in the compiled list (list order: the plain spelling comes before its variants); custom: 1e6 + canonical position */
  readonly rank: number;
  /** canonical spelling (decoded; phrases keep their spaces) */
  readonly term: string;
  /** letters only */
  readonly key: string;
  readonly tier: EngineTier;
  /** a lists.ts Category for built-ins; the host's (sanitized) label for custom terms */
  readonly category: string;
  readonly mode: MatchMode;
  /** names only (never chat): the built-in NAME_ONLY_GROUPS, custom scope 'names' */
  readonly nameOnly: boolean;
  /** applies to chat lines */
  readonly chat: boolean;
  /** applies to names (callsigns, usernames, room names, bot names) */
  readonly names: boolean;
  readonly source: TermSource;
  /** custom: the host's id for the entry (null when none was given); built-ins: null */
  readonly id: string | null;
  /** custom: anchor ids of which at least one must match in the same line / name (null = not gated) */
  readonly anchors: readonly number[] | null;
  /** >= 0: this entry is a context ANCHOR with that id (it marks presence, it is never a hit); -1 = a term */
  readonly anchorId: number;
  /** built-ins: where the entry is listed ("TERM_GROUPS[3] #5"), for diagnostics — never the term itself */
  readonly origin: string;
}

/**
 * One compile diagnostic. Never contains a built-in term: built-in entries are named by list position, custom
 * entries by their input index / id.
 */
export interface CompileDiagnostic {
  code:
    /** two built-in entries have the same letters (merged: strictest tier, scopes merged) */
    | 'builtin-collision'
    /** a custom entry has the same letters (or digits) as a built-in entry: the built-in rule stays in force */
    | 'custom-builtin-collision'
    /** several custom entries normalize to the same term: on a line, the strictest one that applies wins */
    | 'duplicate-term'
    /** a custom term occurs inside allowlisted clean words: matches inside those words are ignored */
    | 'inside-allow-word'
    /** a custom entry's anchor is part of its own term, so it is always present when the term is */
    | 'anchor-inside-term';
  message: string;
  /** custom: input indices of the entries involved */
  entries?: number[];
  /** custom: their ids (when given) */
  ids?: string[];
}

/**
 * Terms compiled for the NFA walk: a trie over distinct letter keys, and per key the entries spelled with those
 * letters (built-ins: exactly one, after the explicit merge; custom: every entry and anchor with that key).
 */
export interface MatchSet {
  readonly trie: Trie;
  readonly keyTerms: readonly (readonly TermInfo[])[];
  readonly maxWalk: number;
}

/** Build a MatchSet over distinct `keys` (keyTerms[i] = the entries of keys[i]). */
export function buildMatchSet(keys: readonly string[], keyTerms: readonly (readonly TermInfo[])[]): MatchSet {
  const trie = new Trie(keys);
  ensureStamp(trie.size);
  return { trie, keyTerms, maxWalk: trie.maxLen * 2 + 2 };
}

interface Compiled {
  terms: TermInfo[];
  trie: Trie;
  /** the built-in terms as a MatchSet (same trie) */
  set: MatchSet;
  /** built-in terms by letter key */
  byKey: ReadonlyMap<string, TermInfo>;
  /** explicit collisions found while merging the built-in lists (none expected; see filter.test.ts) */
  diagnostics: CompileDiagnostic[];
  allow: Trie;
  /** per allow word: may it span a space? */
  allowPhrase: boolean[];
  /** the allowlist keys (letters only), in allow-trie order */
  allowKeys: string[];
  suffix: Trie;
  common: Set<string>;
  maxWalk: number;
}

const TIER_RANK: Readonly<Record<EngineTier, number>> = { flag: -1, mild: 0, mask: 1, block: 2 };
export const lettersOnly = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

let COMPILED: Compiled | null = null;

/** One part of the built-in lists: its groups, a label for diagnostics, and whether it is names-only. */
export interface ListPart { label: string; groups: readonly TermGroup[]; nameOnly: boolean }

/**
 * Merge list parts into one entry per letter key, explicitly and deterministically. When two entries share a key
 * (a collision): the STRICTEST tier wins, and with it that entry's spelling, category and mode (on a tie, the
 * entry listed first); the scopes are MERGED (a chat + names entry and a names-only entry give a chat + names
 * term — a names-only duplicate never takes a term out of chat); and the collision is reported in `diagnostics`
 * (by list position, never by term).
 */
export function mergeTermGroups(parts: readonly ListPart[]): { terms: TermInfo[]; diagnostics: CompileDiagnostic[] } {
  const byKey = new Map<string, TermInfo>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const part of parts) {
    part.groups.forEach((g, gi) => {
      g.terms.forEach((enc, ti) => {
        const term = rot13(enc).toLowerCase().trim().replace(/\s+/g, ' ');
        const key = lettersOnly(term);
        if (!key) return;
        const origin = `${part.label}[${gi}] #${ti}`;
        const cur: TermInfo = {
          rank: byKey.size, term, key, tier: g.tier, category: g.category, mode: g.mode, nameOnly: part.nameOnly,
          chat: !part.nameOnly, names: true, source: 'builtin', id: null, anchors: null, anchorId: -1, origin,
        };
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, cur); return; }
        const win = TIER_RANK[cur.tier] > TIER_RANK[prev.tier] ? cur : prev;
        const lose = win === cur ? prev : cur;
        const chat = prev.chat || cur.chat;
        byKey.set(key, { ...win, rank: prev.rank, chat, nameOnly: !chat, origin: prev.origin });
        const dropped: string[] = [];
        if (lose.tier !== win.tier) dropped.push(`tier ${lose.tier}`);
        if (lose.category !== win.category) dropped.push(`category ${lose.category}`);
        if (lose.mode !== win.mode) dropped.push(`mode ${lose.mode}`);
        diagnostics.push({
          code: 'builtin-collision',
          message: `${prev.origin} and ${origin} have the same letters: kept tier ${win.tier} / category ${win.category} / `
            + `mode ${win.mode} from ${win === cur ? origin : prev.origin}${dropped.length ? ` (dropped ${dropped.join(', ')})` : ''}; `
            + `scopes merged (${chat ? 'chat + names' : 'names only'})`,
        });
      });
    });
  }
  return { terms: [...byKey.values()], diagnostics };
}

function compile(): Compiled {
  const { terms, diagnostics } = mergeTermGroups([
    { label: 'TERM_GROUPS', groups: TERM_GROUPS, nameOnly: false },
    { label: 'NAME_ONLY_GROUPS', groups: NAME_ONLY_GROUPS, nameOnly: true },
  ]);
  const set = buildMatchSet(terms.map((t) => t.key), terms.map((t) => [t]));
  // allowlist keyed by letters; an entry may span a space if any spelling of it has one ("honky tonk")
  const allowPhraseByKey = new Map<string, boolean>();
  for (const w of ALLOW_WORDS) {
    const key = lettersOnly(w);
    if (key) allowPhraseByKey.set(key, (allowPhraseByKey.get(key) ?? false) || /\s/.test(w.trim()));
  }
  const allowKeys = [...allowPhraseByKey.keys()];
  const allow = new Trie(allowKeys);
  const suffix = new Trie(SUFFIXES.map(lettersOnly));
  ensureStamp(Math.max(set.trie.size, allow.size, suffix.size));
  return {
    terms, trie: set.trie, set, byKey: new Map(terms.map((t) => [t.key, t])), diagnostics, allow, allowKeys, suffix,
    allowPhrase: [...allowPhraseByKey.values()],
    common: new Set(COMMON_SHORT_WORDS.map(lettersOnly)),
    maxWalk: set.maxWalk,
  };
}

/** The decoded, compiled lists (built once, on first use). */
export function compiled(): Compiled {
  return (COMPILED ??= compile());
}

/** Collisions found while merging the built-in lists (by list position; expected empty). */
export function builtinDiagnostics(): readonly CompileDiagnostic[] {
  return compiled().diagnostics;
}

// ---------------------------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------------------------

export interface ScanOptions {
  /** include 'mild' terms */
  strict: boolean;
  /** names: also the name-only terms, and longer word terms anywhere inside a word ("xxbigdickxx") */
  name: boolean;
}

export interface RawHit {
  term: TermInfo;
  /** stream positions [s, e) to mask (e may include a suffix) */
  s: number;
  e: number;
  /** end of the term's own letters */
  te: number;
}

/**
 * Longest end e' > e such that [e, e') is a suffix and a word may end at e' (-1 if none). The suffix must be
 * attached (no boundary inside). chunkEnd: e' must also end a whitespace chunk.
 */
function suffixEnd(c: Compiled, st: Stream, e: number, chunkEnd: boolean): number {
  if (e >= st.n || st.bnd[e] !== 0) return -1;
  const t = c.suffix;
  let cur = sufA;
  let nxt = sufB;
  cur[0] = 0;
  let count = 1;
  let best = -1;
  for (let p = e; p < st.n && p - e <= t.maxLen * 2; p++) {
    if (p > e && st.bnd[p] !== 0) break;
    count = step(t, cur, count, st.mask[p], nxt);
    if (!count) break;
    const tmp = cur; cur = nxt; nxt = tmp;
    if (!st.wEnd[p + 1] || (chunkEnd && !st.spaceEnd(p + 1))) continue;
    for (let i = 0; i < count; i++) if (t.out[cur[i] >> 1] >= 0) { best = p + 1; break; }
  }
  return best;
}

/** A word-mode term spelled across spaces: tiny pieces only ("a s s", "sh it"), and not all ordinary short words. */
function spacedWordOk(c: Compiled, st: Stream, s: number, e: number): boolean {
  const sizes: number[] = [];
  const words: string[] = [];
  let size = 0;
  let w = '';
  for (let p = s; p < e; p++) {
    if (p > s && (st.bnd[p] & B_SPACE)) { sizes.push(size); words.push(w); size = 0; w = ''; }
    size++;
    const m = st.mask[p];
    w += String.fromCharCode(97 + (31 - Math.clz32(m & -m)));
  }
  sizes.push(size); words.push(w);
  const allTiny = sizes.every((z) => z <= 2);
  const big = sizes.filter((z) => z > 1).length;
  if (!allTiny && big > 1) return false;
  return !words.every((x) => c.common.has(x));
}

/** Does a digit follow a non-digit anywhere in [s, e)? ("5x17" yes; "45s", "900k" no) */
function digitAfterLetter(st: Stream, s: number, e: number): boolean {
  let seen = false;
  for (let p = s; p < e; p++) {
    if (st.kind[p] === K_DIGIT) { if (seen) return true; } else seen = true;
  }
  return false;
}

/** Is every piece (boundary-free run of positions) that [s, e) touches at most 2 positions long? ("w 0 r d s") */
function spelledOut(st: Stream, s: number, e: number): boolean {
  let p = s;
  while (p > 0 && st.bnd[p] === 0) p--; // back to the start of s's piece
  let size = 0;
  for (; p < st.n; p++) {
    if (st.bnd[p] !== 0 && size > 0) { // a new piece starts at p
      if (size > 2) return false;
      if (p >= e) return true;
      size = 0;
    }
    size++;
  }
  return size <= 2;
}

/** Does [s, e) hold a piece with 2+ real letters in a row ("rds" in "w0.rds"; none in "T1/T2/T3")? */
function hasLetterPair(st: Stream, s: number, e: number): boolean {
  for (let p = s + 1; p < e; p++) {
    if (st.bnd[p] === 0 && st.kind[p] === K_LETTER && st.kind[p - 1] === K_LETTER) return true;
  }
  return false;
}

/**
 * A match that crosses a boundary and contains leet digits: do the digits read as letters? Each run of digits must
 * - sit inside a word ("w0rd", "wo00rd"); or
 * - sit at a word's edge in a match with 3+ real letters and a real pair of letters ("w0.rds", "wo0 rd", but not
 *   "T1/T2/T3"); a block-tier term needs only 2 real letters (short 3-letter slurs); or
 * - be ONE digit standing alone, in a word spelled out letter by letter ("w 0 r d s", but not "45 s", "5 hits",
 *   "top 5 pics"), or joined to the rest by punctuation rather than a space ("5.w0rd"); a dash counts as apart
 *   except for block-tier terms ("5-hit combo" stays clean).
 * Phrase terms (several whole words in a row, "w0rd word", "1 word ...") only need 3 real letters: numbers
 * don't line up into a listed phrase.
 */
function digitsReadAsLetters(st: Stream, info: TermInfo, s: number, e: number, letters: number): boolean {
  if (info.mode === 'phrase') return letters >= 3;
  const block = info.tier === 'block';
  let spelled: boolean | null = null;
  let pair: boolean | null = null;
  for (let p = s; p < e; p++) {
    if (st.kind[p] !== K_DIGIT) continue;
    let q = p;
    while (q + 1 < e && st.kind[q + 1] === K_DIGIT && st.bnd[q + 1] === 0) q++;
    const left = p > 0 && st.bnd[p] === 0 && st.kind[p - 1] !== K_DIGIT;
    const right = q + 1 < st.n && st.bnd[q + 1] === 0 && st.kind[q + 1] !== K_DIGIT;
    if (!(left && right)) {
      if (left || right) {
        if (block ? letters < 2 : letters < 3 || !(pair ??= hasLetterPair(st, s, e))) return false;
      } else {
        if (q > p || letters < 2) return false;
        const apart = block ? B_SPACE : B_SPACE | B_DASH;
        const joined = (p > s && !(st.bnd[p] & apart)) || (q + 1 < e && !(st.bnd[q + 1] & apart));
        if (!joined && !(spelled ??= spelledOut(st, s, e))) return false;
      }
    }
    p = q;
  }
  return true;
}

const ORD_S = bit('s');
const ORD_T = bit('t');
const ORD_D = bit('d');
const ORD_H = bit('h');
/** n or r (the first letter of "nd" / "rd") */
const ORD_NR = bit('n') | bit('r');

/** Is position p the start of an ordinal ending attached to a number: st / nd / rd / th, then the word ends? */
function ordinalAt(st: Stream, p: number): boolean {
  if (p + 2 > st.n || st.bnd[p] !== 0 || st.bnd[p + 1] !== 0 || (p + 2 < st.n && st.bnd[p + 2] === 0)) return false;
  if (st.kind[p] !== K_LETTER || st.kind[p + 1] !== K_LETTER) return false;
  const a = st.mask[p];
  const b = st.mask[p + 1];
  return ((a & ORD_S) !== 0 && (b & ORD_T) !== 0) || ((a & ORD_NR) !== 0 && (b & ORD_D) !== 0) || ((a & ORD_T) !== 0 && (b & ORD_H) !== 0);
}

/**
 * Does the in-word match [s, e) read a callsign's trailing NUMBER as leet letters? That is a run of digits
 * that starts inside the match, after one of its letters, and runs on to the end of the word, optionally followed
 * by st / nd / rd / th ("Diana1", "Owyhee11", "Aspen1st": a name + a number, the most common callsign shape).
 */
function trailingNumber(st: Stream, s: number, e: number): boolean {
  for (let p = s + 1; p < e; p++) {
    if (st.kind[p] !== K_DIGIT || st.kind[p - 1] === K_DIGIT) continue;
    let q = p + 1;
    while (q < st.n && st.kind[q] === K_DIGIT && st.bnd[q] === 0) q++;
    if (q >= st.n || st.bnd[q] !== 0 || ordinalAt(st, q)) return true;
    p = q - 1;
  }
  return false;
}

/**
 * Is the raw match [s, e) of `info` (the walk crossed the boundary flags `crossed`) a hit? Returns the end to
 * mask up to (e, or past a suffix), or -1.
 */
function accept(c: Compiled, st: Stream, info: TermInfo, s: number, e: number, crossed: number, opt: ScanOptions): number {
  if (opt.name ? !info.names : !info.chat) return -1;
  if (info.tier === 'mild' && !opt.strict) return -1;
  // a host's short custom term (2-3 letters: initials, abbreviations) only counts typed as ONE piece: spelled out
  // across spaces / punctuation it is ordinary letters ("hold A B C", "pad D, A, B", "B.C.", "Ace_B_C")
  if (crossed !== 0 && info.source === 'custom' && info.key.length < 4 && info.mode !== 'phrase') return -1;
  const letters = st.letterPre[e] - st.letterPre[s];
  const digits = st.digitPre[e] - st.digitPre[s];
  // "455", "$5", "13580": a span of digits with no real letter is a number, not a word (symbol leet alone, "@$$", is)
  if (letters === 0 && (digits > 0 || e - s < 3)) return -1;
  const wild = st.wildPre[e] - st.wildPre[s];
  if (wild && (wild * 2 > e - s || letters < 2)) return -1;
  // a number with a unit ("45s", "10th", "900k") is not leet: a match starting on a digit needs 2+ real letters —
  // unless digits come back after its letter ("5x17"-style): that is leet, not a number followed by a unit
  if (st.kind[s] === K_DIGIT && letters < 2 && !(letters === 1 && e - s >= 4 && digitAfterLetter(st, s, e))) return -1;
  // leet digits across a boundary must read as letters ("w0.rd5", "w0rd word", "w 0 r d s"), not as
  // numbers or codes ("45 s", "T1/T2", "5 hits")
  if (crossed !== 0 && digits > 0 && !digitsReadAsLetters(st, info, s, e, letters)) return -1;
  const spaced = (crossed & B_SPACE) !== 0;
  const mode = info.mode;
  // names: longer word terms count anywhere inside a word too ("xxbigdickxx"); mild ones never do
  const inWord = mode === 'strong' || mode === 'compound'
    || (opt.name && mode !== 'phrase' && info.tier !== 'mild' && info.key.length >= 4);
  if (inWord && crossed === 0) {
    const end = Math.max(e, suffixEnd(c, st, e, false));
    // a callsign's number is a number, not leet letters that complete a term inside a word: a trailing number after
    // a match that starts mid-word ("Juliana1", "Deepak1st"; chat too, where a callsign is quoted: "gg Hiroshi7"),
    // and in names a leading number that the match reads into a word it doesn't finish ("5Picasso"). The
    // letters-only spelling inside a word, a match from a word start that ends in digits ("Xyz1" for a listed
    // "xyzl") and mid-word leet ("W0rdHead") still count.
    if (digits > 0) {
      if (!st.wStart[s] && trailingNumber(st, s, e)) return -1;
      if (opt.name && st.kind[s] === K_DIGIT && st.wStart[s] && !st.wEnd[end]) return -1;
    }
    return end;
  }
  // split by punctuation / spaces, or a word-mode term: must run boundary to boundary
  if (spaced ? !st.spaceStart(s) : !st.wStart[s]) return -1;
  let end = st.wEnd[e] && (!spaced || st.spaceEnd(e)) ? e : -1;
  if (mode !== 'exact') end = Math.max(end, suffixEnd(c, st, e, spaced));
  if (end < 0) return -1;
  // across spaces a word / compound term must be spelled out in tiny pieces ("h a n d j o b"), never be two
  // ordinary words ("cream pie", "pen is")
  if (spaced && mode !== 'strong' && mode !== 'phrase' && !spacedWordOk(c, st, s, e)) return -1;
  return end;
}

/**
 * Allowlist occurrences in the current stream, as flat triples [start, end, isPhrase, ...]. A span may cross a
 * space or an apostrophe only for the multi-word entries ("moby dick", "honky tonk"; a possessive spelling of a
 * multi-word place name, "x's y", too).
 */
function allowSpans(c: Compiled, st: Stream): number[] {
  const t = c.allow;
  const spans: number[] = [];
  for (let s = 0; s < st.n; s++) {
    if (!(st.mask[s] & t.rootMask)) continue;
    let cur = allowA;
    let nxt = allowB;
    cur[0] = 0;
    let count = 1;
    let crossed = 0;
    for (let p = s; p < st.n && p - s <= t.maxLen * 2; p++) {
      if (p > s) crossed |= st.bnd[p];
      count = step(t, cur, count, st.mask[p], nxt);
      if (!count) break;
      const tmp = cur; cur = nxt; nxt = tmp;
      for (let i = 0; i < count; i++) {
        const o = t.out[cur[i] >> 1];
        if (o >= 0 && (!(crossed & (B_SPACE | B_HARD)) || c.allowPhrase[o])) spans.push(s, p + 1, c.allowPhrase[o] ? 1 : 0);
      }
    }
  }
  return spans;
}

/**
 * Presence marks of context anchors for one scan (custom.ts): generation stamps, so starting a scan is O(1) and a
 * mark / lookup is O(1) — the anchor post-pass stays O(hits).
 */
export class AnchorMarks {
  private stamp: Int32Array;
  private gen = 1;
  constructor(count: number) { this.stamp = new Int32Array(Math.max(1, count)); }
  /** Start a new line / name: forget every mark. */
  begin(): void {
    if (++this.gen >= 0x7FFFFFFF) { this.stamp.fill(0); this.gen = 1; }
  }
  mark(id: number): void { this.stamp[id] = this.gen; }
  has(id: number): boolean { return this.stamp[id] === this.gen; }
  /** Does at least one of `ids` carry a mark? */
  any(ids: readonly number[]): boolean {
    for (let i = 0; i < ids.length; i++) if (this.stamp[ids[i]] === this.gen) return true;
    return false;
  }
}

/**
 * Walk `set` over the stream and append every accepted raw match to `found` (before the allowlist). Entries that
 * are anchors (anchorId >= 0) are not hits: an accepted anchor only sets its mark in `marks`. `wordStarts`: walks
 * start only where a word may start (st.wStart) — exact for a set with no mid-word matches (word / phrase / exact
 * entries in chat, which accept() only takes boundary to boundary); it skips most walks on a long line.
 */
function walkSet(c: Compiled, set: MatchSet, st: Stream, opt: ScanOptions, marks: AnchorMarks | null, found: RawHit[], wordStarts = false): void {
  const t = set.trie;
  const n = st.n;
  for (let s = 0; s < n; s++) {
    if (!(st.mask[s] & t.rootMask) || st.kind[s] === K_WILD) continue; // a match never starts on a '*'
    if (wordStarts && !st.wStart[s]) continue;
    let cur = termA;
    let nxt = termB;
    cur[0] = 0;
    let count = 1;
    let crossed = 0;
    for (let p = s; p < n && p - s < set.maxWalk; p++) {
      if (p > s) { const b = st.bnd[p]; if (b & B_HARD) break; crossed |= b; }
      if (st.kind[p] === K_WILD && st.wildPre[p + 1] - st.wildPre[s] > MAX_WILD_PER_MATCH) break;
      count = step(t, cur, count, st.mask[p], nxt);
      if (!count) break;
      const tmp = cur; cur = nxt; nxt = tmp;
      let lastO = -1;
      for (let i = 0; i < count; i++) {
        const o = t.out[cur[i] >> 1];
        if (o < 0 || o === lastO) continue; // (a node can be live twice: fresh and after absorbing a repeat)
        lastO = o;
        const list = set.keyTerms[o];
        for (let k = 0; k < list.length; k++) {
          const info = list[k];
          if (info.anchorId >= 0 && (!marks || marks.has(info.anchorId))) continue;
          const end = accept(c, st, info, s, p + 1, crossed, opt);
          if (end < 0) continue;
          if (info.anchorId >= 0) marks!.mark(info.anchorId);
          else found.push({ term: info, s, e: end, te: p + 1 });
        }
      }
    }
  }
}

/** Allowlist spans of the current stream, computed at most once per scan (shared by the built-in and custom scans). */
export interface AllowCache { spans: number[] | null }

/** Drop the hits an allowlisted word covers (see rescued). */
function rescueHits(c: Compiled, st: Stream, found: RawHit[], cache: AllowCache): RawHit[] {
  if (!found.length) return found;
  const spans = (cache.spans ??= allowSpans(c, st));
  if (!spans.length) return found;
  return found.filter((h) => !rescued(st, spans, h));
}

/** All accepted built-in hits in `st`, after the allowlist. */
export function scanStream(st: Stream, opt: ScanOptions, cache: AllowCache = { spans: null }): RawHit[] {
  const c = compiled();
  const found: RawHit[] = [];
  walkSet(c, c.set, st, opt, null, found);
  return rescueHits(c, st, found, cache);
}

/** One custom MatchSet to walk, and whether its matches can only start at a word start in this scan. */
export interface SetWalk { set: MatchSet; wordStarts: boolean }

/**
 * All accepted hits of the custom MatchSets in `st`, after the allowlist; accepted anchors set their marks (the
 * caller gates anchored hits afterwards, see custom.ts). Call on the same stream right after scanStream.
 */
export function scanCustomSets(st: Stream, walks: readonly SetWalk[], opt: ScanOptions, marks: AnchorMarks | null, cache: AllowCache): RawHit[] {
  const c = compiled();
  const found: RawHit[] = [];
  for (const w of walks) walkSet(c, w.set, st, opt, marks, found, w.wordStarts);
  return rescueHits(c, st, found, cache);
}

/**
 * Does an allowlisted word cover this hit's own letters (suffix excluded)? The clean word has to be spelled the
 * way the hit is: a boundary inside the allow span but outside the hit ("Big|Rape|Guy" against "grape") means the
 * writer did not type that word, so it does not rescue the hit. A custom term is rescued only by a clean word
 * strictly LONGER than its own letters: a host who lists an allowlisted word itself means that word.
 */
function rescued(st: Stream, spans: readonly number[], h: RawHit): boolean {
  const custom = h.term.source === 'custom';
  outer: for (let i = 0; i < spans.length; i += 3) {
    const as = spans[i];
    const ae = spans[i + 1];
    if (as > h.s || ae < h.te) continue;
    if (custom && as === h.s && ae === h.te) continue;
    // a multi-word entry is expected to have boundaries between its words
    if (spans[i + 2]) return true;
    for (let p = as + 1; p < ae; p++) if (st.bnd[p] !== 0 && (p <= h.s || p >= h.te)) continue outer;
    return true;
  }
  return false;
}

/** Primary letter of every position, with a space at each boundary (debug / tests / log search keys). */
export function streamText(st: Stream): string {
  let out = '';
  for (let i = 0; i < st.n; i++) {
    if (i > 0 && st.bnd[i]) out += ' ';
    const m = st.mask[i];
    out += st.kind[i] === K_WILD ? '*' : String.fromCharCode(97 + (31 - Math.clz32(m & -m)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Digit runs (number codes)
// ---------------------------------------------------------------------------------------------------------------

/** Separators allowed (one at a time) between the digits of one code ("14 88", "14.88", "14/88"). */
const DIGIT_SEP = new Set([' ', '.', '-', '_', '|', '/', ':', '\u00B7']);
/** Of those, the ones that join a decimal ("7351.5" is one number): every other separator also splits GROUPS. */
const DECIMAL_SEP = new Set(['.', '\u00B7']);
const RE_FORMAT = /^\p{Cf}$/u;
/** Longest digit run that is compared with the codes; a longer run is consumed whole and never matches. */
export const MAX_RUN_DIGITS = 16;

/** Non-ASCII code point → 0..9 (fullwidth, mathematical, other compatibility digits), -2 format char, -3 separator, -1 other. */
const DIGIT_CACHE = new Map<number, number>();
function nonAsciiDigitClass(cp: number): number {
  let v = DIGIT_CACHE.get(cp);
  if (v !== undefined) return v;
  const ch = String.fromCodePoint(cp);
  const k = ch.normalize('NFKC');
  if (k.length === 1 && k >= '0' && k <= '9') v = k.charCodeAt(0) - 48;
  else if (RE_FORMAT.test(ch)) v = -2;
  else if (DIGIT_SEP.has(ch)) v = -3;
  else v = -1;
  if (DIGIT_CACHE.size >= CHAR_CACHE_MAX) DIGIT_CACHE.clear();
  DIGIT_CACHE.set(cp, v);
  return v;
}

/** Decimal value of one character (ASCII or a compatibility digit such as fullwidth '４'), else -1. */
export function digitValue(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return -1;
  if (cp < 128) return cp >= 48 && cp <= 57 ? cp - 48 : -1;
  const v = nonAsciiDigitClass(cp);
  return v >= 0 ? v : -1;
}

/**
 * One maximal digit run of a string: UTF-16 span [o0, o1) and its digits ('' when longer than MAX_RUN_DIGITS).
 * `groups`: when a group separator (a space, '-', '_', '/', ...: anything but a decimal point) joins digits in the
 * run, its groups in order, each a run of its own (with groups null); null when the run is one group.
 */
export interface DigitRun { o0: number; o1: number; digits: string; groups: readonly DigitRun[] | null }

/**
 * Every STANDALONE digit run of `text`: a maximal sequence of digits, where one separator (DIGIT_SEP) between two
 * digits and zero-width format characters are transparent ("14 88", "14<zero-width>.88", "14.<zero-width>88" are
 * one run). A run is always taken whole — "21488" or a 20-digit number is one run and never spells a shorter code
 * inside it — and runs split by anything else (letters, two separators, other punctuation) are separate numbers
 * ("14Ace88" is "14" and "88"). Inside a run, the groups between group separators are numbers too ("wave 3 7351":
 * the run "37351" and its groups "3", "7351"); a decimal point joins ("7351.5" is one group). Chat and names use the
 * same runs. O(length), no allocation per character (one per group).
 */
export function digitRuns(text: string): DigitRun[] {
  const out: DigitRun[] = [];
  const len = text.length;
  /** digit value at i (>= 0), -2 format, -3 separator, -1 other; width in W */
  let W = 1;
  const cls = (i: number): number => {
    const c = text.charCodeAt(i);
    if (c < 128) {
      W = 1;
      if (c >= 48 && c <= 57) return c - 48;
      return DIGIT_SEP.has(text[i]) ? -3 : -1;
    }
    const cp = text.codePointAt(i) ?? 0;
    W = cp > 0xFFFF ? 2 : 1;
    return nonAsciiDigitClass(cp);
  };
  const group = (o0: number, o1: number, digits: string, count: number): DigitRun =>
    ({ o0, o1, digits: count <= MAX_RUN_DIGITS ? digits : '', groups: null });
  for (let i = 0; i < len;) {
    const d0 = cls(i);
    const w0 = W;
    if (d0 < 0) { i += w0; continue; }
    let digits = String(d0);
    let count = 1;
    let end = i + w0;
    let j = end;
    // the current group
    let g0 = i;
    let gDigits = digits;
    let gCount = 1;
    let groups: DigitRun[] | null = null;
    /** since the last digit: 0 no separator, 1 a decimal point, 2 a group separator */
    let sep = 0;
    while (j < len) {
      const d = cls(j);
      const w = W;
      if (d >= 0) {
        if (sep === 2) {
          (groups ??= []).push(group(g0, end, gDigits, gCount));
          g0 = j; gDigits = ''; gCount = 0;
        }
        sep = 0;
        if (++count <= MAX_RUN_DIGITS) digits += String(d);
        if (++gCount <= MAX_RUN_DIGITS) gDigits += String(d);
        j += w; end = j; continue;
      }
      if (d === -2) { j += w; continue; } // zero-width characters, on either side of a separator too
      // one separator joins; a second one before the next digit (or no digit after it) ends the run at `end`
      if (d === -3 && sep === 0) { sep = DECIMAL_SEP.has(text[j]) ? 1 : 2; j += w; continue; }
      break;
    }
    if (groups) groups.push(group(g0, end, gDigits, gCount));
    out.push({ o0: i, o1: end, digits: count <= MAX_RUN_DIGITS ? digits : '', groups });
    i = end;
  }
  return out;
}

/**
 * The numbers a code may match in one run: the whole run, and each of its groups (a code standing on its own
 * next to another number: "wave 3 7351", "7351 7351", "Ace_7351_2"). Calls `f` for each (whole run first).
 */
export function forEachNumber(r: DigitRun, f: (n: DigitRun) => void): void {
  f(r);
  if (r.groups) for (const g of r.groups) f(g);
}

let BUILTIN_CODES: Map<string, Category> | null = null;
/** The built-in number codes (lists.ts NUMERIC_TERMS, decoded once): code → category. */
export function builtinCodes(): ReadonlyMap<string, Category> {
  return (BUILTIN_CODES ??= new Map(NUMERIC_TERMS.map((t) => [rot5(t.code), t.category])));
}

// ---------------------------------------------------------------------------------------------------------------
// Normalizing host-supplied terms (custom.ts)
// ---------------------------------------------------------------------------------------------------------------

/** Does the normalizer read this one code point as one or more plain letters (not leet, not a separator)? */
export function readsAsLetter(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  const ci = cp < 128 ? ASCII[cp] : charInfo(cp, ch);
  return ci.t === T_POS && ci.kind === K_LETTER && ci.masks.length > 0;
}

/**
 * The letter words of a term exactly as the matcher will see them: the same pipeline as chat (NFKD, look-alikes,
 * case, zero-width characters, runs of one letter capped at 2), split into words at whitespace only (punctuation
 * and camelCase humps join, as they do in chat). Returns null when a position is not ONE plain letter (leet, a
 * wildcard, an ambiguous look-alike): the caller explains that the plain spelling is needed.
 */
export function letterWords(text: string): string[] | null {
  const st = buildStream(text);
  const words: string[] = [];
  let w = '';
  for (let i = 0; i < st.n; i++) {
    const m = st.mask[i];
    if (st.kind[i] !== K_LETTER || m === 0 || (m & (m - 1)) !== 0) return null;
    if (i > 0 && (st.bnd[i] & (B_SPACE | B_HARD))) { words.push(w); w = ''; }
    w += String.fromCharCode(97 + (31 - Math.clz32(m)));
  }
  if (w) words.push(w);
  return words;
}
