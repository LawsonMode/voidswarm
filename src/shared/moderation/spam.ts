// OWNER: FILTER agent. Chat flood helpers: repeat detection (isSpam) and display taming (tameText: shouting and
// character floods). Pure and deterministic; no DOM / Node APIs.

/** One of a pilot's recent chat lines (epoch ms). */
export interface RecentLine { text: string; time: number }

/** The same line this many times within SPAM_REPEAT_MS is spam (the 3rd copy is refused). */
export const SPAM_REPEAT_COUNT = 3;
export const SPAM_REPEAT_MS = 10_000;
/** Lines longer than this that are mostly capitals get lowercased. */
export const CAPS_MIN_LEN = 12;
export const CAPS_RATIO = 0.7;
/** A character (or a 2–4 character unit) repeated more than this many times in a row is cut back to it. */
export const FLOOD_KEEP = 3;

/**
 * Comparison key for "the same message": case-, spacing-, punctuation- and flood-insensitive, so "gg ez",
 * "GG!!! EZ" and "ggggggg ez" are one message. Repeats collapse all the way to one character here (harsher than
 * the display rule) because padding a line is the cheapest way to repeat it.
 */
export function spamKey(text: string): string {
  const s = String(text ?? '').toLowerCase();
  let key = '';
  let last = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    // keep letters / digits / anything non-ASCII (emoji-only lines still compare); drop ASCII punctuation & spaces
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c > 127)) continue;
    if (ch === last) continue;
    last = ch;
    key += ch;
  }
  // "hahahaha" / "lolololol": collapse a repeated 2–4 character unit too
  for (let u = 2; u <= 4; u++) {
    const re = new RegExp(`(.{${u}})\\1{2,}`, 'gu');
    key = key.replace(re, '$1');
  }
  return key || s.trim();
}

/**
 * Is `text` a repeat flood? True when `recent` (this pilot's earlier lines, any order) already holds
 * SPAM_REPEAT_COUNT - 1 copies of the same message (spamKey) from the last SPAM_REPEAT_MS before `now`.
 * The caller then drops the line; it should NOT add a refused line to `recent`.
 */
export function isSpam(recent: readonly RecentLine[] | null | undefined, text: string, now: number): boolean {
  if (!recent || !recent.length) return false;
  const key = spamKey(text);
  if (!key) return false;
  let same = 0;
  for (const r of recent) {
    if (!r || typeof r.text !== 'string' || typeof r.time !== 'number') continue;
    const age = now - r.time;
    if (age < 0 || age > SPAM_REPEAT_MS) continue;
    if (spamKey(r.text) === key && ++same >= SPAM_REPEAT_COUNT - 1) return true;
  }
  return false;
}

/**
 * Cut runs of a repeated character (or of a repeated 2–4 character unit: "hahahahaha", "lolololol") down to
 * FLOOD_KEEP copies. Digit runs are left alone (1000000 stays a number). Linear time.
 */
export function collapseFlood(text: string): string {
  const s = String(text ?? '');
  const n = s.length;
  if (n <= FLOOD_KEEP) return s;
  let out = '';
  let i = 0;
  outer: while (i < n) {
    for (let u = 1; u <= 4 && i + u * (FLOOD_KEEP + 1) <= n; u++) {
      const unit = s.substr(i, u);
      if (/^\d+$/.test(unit) || /^\s+$/.test(unit)) continue;
      // don't split a surrogate pair
      const last = unit.charCodeAt(u - 1);
      if (last >= 0xD800 && last <= 0xDBFF) continue;
      let k = 1;
      while (i + (k + 1) * u <= n && s.startsWith(unit, i + k * u)) k++;
      if (k > FLOOD_KEEP) {
        out += unit.repeat(FLOOD_KEEP);
        i += k * u;
        continue outer;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

/** Is the line "shouting" (longer than CAPS_MIN_LEN, more than CAPS_RATIO of its letters upper case)? */
export function isShouting(text: string): boolean {
  const s = String(text ?? '');
  if (s.length <= CAPS_MIN_LEN) return false;
  let upper = 0;
  let letters = 0;
  for (const ch of s) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo === up) continue; // not a cased letter
    letters++;
    if (ch === up) upper++;
  }
  return letters > 0 && upper / letters > CAPS_RATIO;
}

/** A link ("https://…", "www.…"): case and repeated letters there are meaningful. */
const isLink = (word: string): boolean => {
  const l = word.toLowerCase();
  return l.includes('://') || l.includes('www.');
};

/**
 * What to display: floods collapsed, shouting lowercased. Idempotent, linear. Words that look like links are left
 * exactly as typed (only the text around them is tamed), so "https://aaaa.example.com/X" survives.
 */
export function tameText(text: string): string {
  const src = String(text ?? '');
  if (!isLink(src)) {
    const s = collapseFlood(src);
    return isShouting(s) ? s.toLowerCase() : s;
  }
  // [text, link, text, link, ..., text]: whitespace stays with the text around the links
  const pieces: string[] = [''];
  for (const tok of src.split(/(\s+)/)) {
    if (tok && !/^\s/.test(tok) && isLink(tok)) pieces.push(tok, '');
    else pieces[pieces.length - 1] += tok;
  }
  for (let i = 0; i < pieces.length; i += 2) pieces[i] = collapseFlood(pieces[i]!);
  const shouting = isShouting(pieces.filter((_, i) => i % 2 === 0).join(' '));
  return pieces.map((p, i) => (i % 2 === 0 && shouting ? p.toLowerCase() : p)).join('');
}
