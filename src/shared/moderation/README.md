# `src/shared/moderation` — the chat & name filter

Pure, deterministic TypeScript: no DOM, no Node APIs, no I/O. The Node server and the browser's offline Zone run
exactly the same code, so a line is filtered the same way online and offline.

Owner: FILTER agent. The Zone-side seam (the chat gate, mutes, strikes, the chat log) lives in
`src/shared/room/moderation.ts` and `src/server/moderation/`.

## API (`filter.ts`)

```ts
filterChat(text, opts?) -> { text, action: 'pass' | 'flag' | 'mask' | 'block', hits: FilterHit[] }
checkName(name, opts?)  -> { ok, action?: 'flag', reason?, hits? }
isSpam(recent, text, now) -> boolean
tameText(text) -> string          // shouting lowercased, character floods collapsed (display only; links kept)
foldText(text) -> string          // the normalized stream the matcher sees (a log search key)
listStats() -> { block, mask, mild, nameOnly, allow }
parseStrictness(v) -> 'strict' | 'standard'   // a host setting (server env CHAT_FILTER); anything but 'standard' is strict

// host-managed custom terms (custom.ts)
compileCustomTerms(entries, { partial? }) -> { ok, set, errors, diagnostics, accepted, rejected }   // installs nothing
setCustomTerms(entries, { partial? })     -> the same, and installs the set for every later call
clearCustomTerms() / activeCustomTerms()
builtinDiagnostics() -> CompileDiagnostic[]   // collisions in the built-in lists (expected: none)
```

* `action: 'pass'` — show `text` as typed (it is the input unchanged).
* `action: 'flag'` — only review-only custom terms matched: show `text` as typed (unchanged); `hits` (tier `'flag'`)
  are for the moderator log. No strike.
* `action: 'mask'` — profanity: show `text`, where each offending word keeps its first character and the rest is
  starred (`w***`). The rest of the line is untouched.
* `action: 'block'` — a slur, hate term, sexual term, threat or a self-harm statement: **do not show the line at
  all**. `text` still comes back masked rather than raw, so a careless caller cannot leak it.
* `hits` — the matched terms, most severe first (block, mask, flag), for the moderator log only. Never show them
  back in chat. `String(hit)` is the term, so `hits.map(String)` is a log-friendly list. A hit has `term`, `tier`
  (`'block' | 'mask' | 'flag'`), `category`, `source` (`'builtin' | 'custom'`) and, for a custom entry, the host's
  `id`. `room/moderation.ts` `hitLabel` turns one into a log label: `category:term` (built-in),
  `custom:category:term` (a custom block / mask hit) or `flag:category:term` (review-only).

`checkName` is for every human-chosen name: callsigns, account usernames, room names and bot names. Any hit
refuses the name, including terms hidden inside a longer word (`xXBadWordXx`) and the name-only list (hate
figures, which are fine to type in chat — a history lesson — but not to wear).

Both take `{ strictness, custom }` (`custom` omitted = the installed custom set, `null` = the built-in lists only). **`'strict'` is the default**: this server is hosted for a classroom, so the mild tier
is masked too. `'standard'` lets that tier through; nothing else changes. The Zone takes it as
`ZoneOptions.chatFilter` (server env `CHAT_FILTER`).

**Number codes** (hate symbols written in digits, `NUMERIC_TERMS`, ROT5; custom digit codes too) are a separate scan
over whole **digit runs** (`engine.ts` `digitRuns`): a run is a maximal sequence of digits, where ONE separator
(space . - _ | / : ·) between two digits and zero-width characters (on either side of that separator too:
`14<zero-width>.88`, `14.<zero-width>88`) are transparent. A run is taken whole — a longer number, even a 20-digit
one, never hides a code at its end — and runs split by letters or anything else are separate numbers. Inside a run,
the **groups** between separators other than a decimal point (space - _ | / :) are numbers too, so a code standing
as its own group next to another number counts (`wave 3 <code>`, `<code> <code>`, `Ace_<code>_2`), while a decimal
(`<code>.5`) and groups that only line up into the code (`3<co> <de>`, `<co>.<de>.5`) do not (`forEachNumber`: the
whole run, then each group). In chat a matching run or group is starred (only that group) and reported as a
`mask`-tier `hate` hit (no strike for an innocent number); in a name it refuses it (`Pilot<code>`,
`Ace_<co>_<de>`), but digit groups split by letters do not (`<co>Ace<de>`: the old check concatenated every digit
of a name and refused it with a strike).

## What it sees through

Matching runs on a normalized letter stream, never on the raw text (the original is kept for display and for the
log). It sees through case, NFKC/NFKD styling (fullwidth, math-bold, circled letters), zero-width and other
format characters, combining marks, look-alike letters from other scripts (Cyrillic, Greek, Armenian, Cherokee,
Lisu, IPA; Greek upsilon / eta / lunate sigma / phi read as u / n / c / f, accented forms too), leetspeak (`0→o`,
`1→i/l`, `@→a/o/u`, `$→s`, `!→i`, `+→t`, `|→l`, `*→any`), repeated letters (`wuuuuurd`), spacing and punctuation
between letters (`w u r d`, `w.u.r.d`, `w_u_r_d`), camelCase humps, and common suffixes (`-s`, `-ed`, `-er`, `-ing`,
`-y`, …).

**Digits** get extra rules so numbers stay numbers (`engine.ts` `accept` / `digitsReadAsLetters`):
* a span of digits with no real letter is a number (`455`, a score), and so is a number followed by a unit (`45s`,
  `10th`, `900k`); but digits coming back after a letter are leet (`5x17`-style);
* across a boundary a leet digit must read as a letter: inside a word (`w0rd`, `wo00rd`), at a word's edge in a match
  with 3+ real letters and a real letter pair (block tier: 2 letters), or one digit alone in a word spelled out
  letter by letter / joined by punctuation — never `45 s`, `T1/T2/T3`, `5 hits`, `top 5 pics`, `5-hit combo`;
* phrase terms accept any leet digit once the match has 3 real letters (numbers don't line up into a phrase);
* **a callsign's number is a number** (`trailingNumber` in `accept`). A match that starts inside a word and needs a
  trailing digit run — one that runs to the end of the word, optionally followed by st / nd / rd / th — is not a hit
  (`Juliana1`, `Owyhee11`, `Aspen1st`; in names, and in chat where the callsign is quoted: `gg Hiroshi7`). In names,
  neither is a leading number that the match reads into a word it doesn't finish (`5Picasso`). The letters-only
  spelling inside a word, mid-word leet (`W0rdHead`) and a match from a word start that ends in a digit still
  count.

Known gaps (by design, for numbers' sake): a term written entirely in digits (or digits + a unit), and a 3-letter
mask / mild term written with a digit *and* a separator. Self-censoring with a dash (`w-rd`) is not a wildcard.

It avoids the Scunthorpe problem with boundary-aware matching plus an allowlist of clean words and real names
(`class`, `assassin`, `Scunthorpe`, `cocktail`, `therapist`, `analysis`, `Hancock`, and roster names such as
`Harshit`, `Yamashita`, `Cockburn`, …). The tests check every distinct word and every line of the design docs,
a list of real given names and surnames, and game-chat lines full of numbers, codes and mentions for zero false
positives.

## Custom terms (`custom.ts`)

The host manages its own list at run time (for example a school's local slang or crew names, from the admin
console); nothing is shipped in the repo. An entry is `{ term, category?, action: 'block' | 'mask' | 'flag',
scope?: 'chat' | 'names' | 'both', match?: 'word' | 'phrase' | 'strong', anchors?: string[], id? }`:

* **term** — plain words (2+ words = a phrase) or a digit code (`7351`). It goes through the same normalizer as chat
  (case, accents, look-alikes, fullwidth, zero-width characters, punctuation between letters), so `Zörb-lax` is
  `zorblax`, and every evasion the built-in lists see through matches it too. Leetspeak, wildcards and regex syntax
  in the term itself are refused (list the plain spelling); so are letters and digits mixed in one term (use a code
  with a word anchor instead). A `word` term typed in parts of 2+ letters joined by `- _ .` (`Zorb-Lax`; entry
  `spaced: true`) is also compiled as a phrase, so the spaced-out form players type (`zorb lax`) matches too.
* **short terms** — a custom term under 4 letters (initials, abbreviations; not a phrase) only counts typed as ONE
  piece (`accept`: no boundary crossed), never spelled out across spaces / punctuation: `bc` never matches
  `hold A B C`, `pad D, A, B`, `B.C.` or `Ace_B_C`.
* **action** — `block` withholds the line (a strike, like the built-in block tier), `mask` stars the word, `flag`
  allows the line / name unchanged and only reports the hit (tier `flag`) for the moderator log.
* **scope** — chat lines, names, or both (default). **match** — `word` (default; boundary to boundary plus common
  suffixes, and in names 4+ letters also inside a word), `phrase` (default for 2+ words), `strong` (anywhere, 4+
  letters). Digit codes always match a whole digit run.
* **anchors** — context gating: an anchored entry counts only when one of its anchors (a word, phrase or code)
  matches in the same line or name. It is a post-pass after the trie scan and the digit runs, O(hits).
* **category** — a free label, sanitized to lowercase `a-z 0-9 space _ -`, at most 24 characters (default
  `custom`). `threat` and `selfharm` keep their Zone meaning (moderator alert / care note); the spellings
  `self-harm`, `self harm`, `self_harm` map to `selfharm` and `threats` to `threat` (`CATEGORY_ALIASES`).

Validation errors name the entry (`index`, `id`) and the field; the list is refused as a whole unless
`{ partial: true }` (then only the bad entries are skipped — but a partial list with NO valid entry is still refused,
so `setCustomTerms` keeps the installed set; only an empty list or `clearCustomTerms()` removes it). Every entry of
a duplicated id is refused (not just the later ones). Limits (`CUSTOM_LIMITS`): 2000 entries, 64 characters per
term / anchor, 8 anchors per entry, 2-12 digits per code, 40 000 letters in all. The compile is deterministic:
entries are put in a canonical order, so the same entries in any order give the same `fingerprint` and results
(partial mode too).

Custom terms **never weaken** the built-in lists: they are compiled into their own trie and scanned after the
built-in one, so they can only add hits (a `flag` entry spelled like a built-in block-tier term still blocks), and
built-in and custom hits are reported side by side. The allowlist still protects clean words from custom terms,
except a custom term that IS an allowlisted word (the host means it).

**Diagnostics** (`set.diagnostics`; never a built-in term, entries are named by index / id):
`custom-builtin-collision` (same letters / digits as a built-in entry: the built-in rule stays in force),
`duplicate-term` (several entries normalize to the same term: on a line the strictest one that applies wins),
`inside-allow-word`, `anchor-inside-term`. The built-in lists are compiled the same explicit way
(`mergeTermGroups`): entries with the same letters keep the STRICTEST tier (with its spelling, category and mode;
the first listed on a tie) and MERGE their scopes (a names-only duplicate never takes a term out of chat), and each
collision is reported by list position (`builtinDiagnostics()`; the tests require it to be empty).

## Performance

A trie walked as an NFA, bounded by twice the longest term: linear in the input, with no regex backtracking. A
200-character line costs single-digit microseconds (about 13 µs with a full 2000-entry custom list, which
compiles in about 20 ms); the adversarial cases in `perf.test.ts` stay far under the 50 µs budget, with and without
the custom list. Nothing is allocated per character.

## Word lists (`lists.ts`)

Terms are stored **ROT13-encoded** so slurs don't turn up in a casual grep, a code search or a screen-share.
That is housekeeping, not security. To add a term: ROT13 it, lowercase ASCII letters and single spaces only, and
put it in the group that matches its tier (`block` / `mask` / `mild`), category and match mode (the modes are
documented at the top of the file). List only the plain spelling — the normalizer derives the leet, spaced,
repeated and suffixed forms. The allowlist, the suffixes and the short-word list underneath are ordinary clean
words, stored in plain text.

Counts (`listStats()`), not contents, are what belongs in reports and on the admin page.

## Files

| File | What it is |
|---|---|
| `filter.ts` | the public API: `filterChat`, `checkName`, masking, hit reporting |
| `custom.ts` | host-managed custom terms: validation, the deterministic compile, anchors, the installed set |
| `engine.ts` | normalization (the letter stream) and the trie matcher |
| `lists.ts` | the word lists as data (ROT13) plus the allowlist / suffixes |
| `spam.ts` | `isSpam` (repeat flood), `tameText` (shouting, character floods) |
| `index.ts` | barrel |
| `filter.test.ts` | bypass corpus (every term × every evasion, incl. leet × separators, phrases with a digit, heavy leet, `@`, Greek), clean corpus (docs, numbers / codes, real names), number codes, output shape |
| `custom.test.ts` | custom terms: validation errors, normalization, actions / scopes / modes, anchors, codes, determinism, never weaker than the built-ins |
| `fpCorpus.ts` / `fpCorpus.test.ts` | the false-positive corpus: 2400 PG game-chat lines and 1700 callsigns built from the game's vocabulary, names, places, teams and trash talk (test data only) |
| `spam.test.ts` | flood and shouting helpers |
| `perf.test.ts` | the per-line budget and the adversarial inputs, also with 2000 custom entries |
