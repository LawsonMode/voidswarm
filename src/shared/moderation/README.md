# `src/shared/moderation` — the chat & name filter

Pure, deterministic TypeScript: no DOM, no Node APIs, no I/O. The Node server and the browser's offline Zone run
exactly the same code, so a line is filtered the same way online and offline.

Owner: FILTER agent. The Zone-side seam (the chat gate, mutes, strikes, the chat log) lives in
`src/shared/room/moderation.ts` and `src/server/moderation/`.

## API (`filter.ts`)

```ts
filterChat(text, opts?) -> { text, action: 'pass' | 'mask' | 'block', hits: FilterHit[] }
checkName(name, opts?)  -> { ok, reason?, hits? }
isSpam(recent, text, now) -> boolean
tameText(text) -> string          // shouting lowercased, character floods collapsed (display only; links kept)
foldText(text) -> string          // the normalized stream the matcher sees (a log search key)
listStats() -> { block, mask, mild, nameOnly, allow }
parseStrictness(v) -> 'strict' | 'standard'   // a host setting (server env CHAT_FILTER); anything but 'standard' is strict
```

* `action: 'pass'` — show `text` as typed (it is the input unchanged).
* `action: 'mask'` — profanity: show `text`, where each offending word keeps its first character and the rest is
  starred (`w***`). The rest of the line is untouched.
* `action: 'block'` — a slur, hate term, sexual term, threat or a self-harm statement: **do not show the line at
  all**. `text` still comes back masked rather than raw, so a careless caller cannot leak it.
* `hits` — the matched terms, most severe first, for the moderator log only. Never show them back in chat.
  `String(hit)` is the term, so `hits.map(String)` is a log-friendly list.

`checkName` is for every human-chosen name: callsigns, account usernames, room names and bot names. Any hit
refuses the name, including terms hidden inside a longer word (`xXBadWordXx`) and the name-only list (hate
figures, which are fine to type in chat — a history lesson — but not to wear).

Both take `{ strictness }`. **`'strict'` is the default**: this server is hosted for a classroom, so the mild tier
is masked too. `'standard'` lets that tier through; nothing else changes. The Zone takes it as
`ZoneOptions.chatFilter` (server env `CHAT_FILTER`).

**Number codes** (hate symbols written in digits, `NUMERIC_TERMS`, ROT5) are a separate scan: in chat a standalone
digit run that spells one is starred and reported as a `mask`-tier `hate` hit (no strike for an innocent number);
in a name, the code anywhere in the name's digits refuses it.

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
* phrase terms accept any leet digit once the match has 3 real letters (numbers don't line up into a phrase).

Known gaps (by design, for numbers' sake): a term written entirely in digits (or digits + a unit), and a 3-letter
mask / mild term written with a digit *and* a separator. Self-censoring with a dash (`w-rd`) is not a wildcard.

It avoids the Scunthorpe problem with boundary-aware matching plus an allowlist of clean words and real names
(`class`, `assassin`, `Scunthorpe`, `cocktail`, `therapist`, `analysis`, `Hancock`, and roster names such as
`Harshit`, `Yamashita`, `Cockburn`, …). The tests check every distinct word and every line of the design docs,
a list of real given names and surnames, and game-chat lines full of numbers, codes and mentions for zero false
positives.

## Performance

A trie walked as an NFA, bounded by twice the longest term: linear in the input, with no regex backtracking. A
200-character line costs single-digit microseconds; the adversarial cases in `perf.test.ts` stay far under the
50 µs budget. Nothing is allocated per character.

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
| `engine.ts` | normalization (the letter stream) and the trie matcher |
| `lists.ts` | the word lists as data (ROT13) plus the allowlist / suffixes |
| `spam.ts` | `isSpam` (repeat flood), `tameText` (shouting, character floods) |
| `index.ts` | barrel |
| `filter.test.ts` | bypass corpus (every term × every evasion, incl. leet × separators, phrases with a digit, heavy leet, `@`, Greek), clean corpus (docs, numbers / codes, real names), number codes, output shape |
| `spam.test.ts` | flood and shouting helpers |
| `perf.test.ts` | the per-line budget and the adversarial inputs |
