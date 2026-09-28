# Chat moderation (Voidswarm 0.4)

Voidswarm filters chat for everyone, and a server with accounts also **logs every chat line** so you can look back,
mute, kick or ban. It is built for a teacher hosting students: the defaults are strict and classroom-safe.

- **Filter:** always on, online and offline. It checks every chat line and every name a player picks.
- **Log, strikes, bans, reports, dashboard:** on a server with accounts (the normal `npm start` /
  `scripts\host-online.ps1` setup). Offline play filters chat but stores nothing.

Details for developers: [`src/shared/moderation/README.md`](../src/shared/moderation/README.md) (the filter),
[`src/server/moderation/README.md`](../src/server/moderation/README.md) (server side) and
[`src/server/moderation/adminApi.md`](../src/server/moderation/adminApi.md) (dashboard API). The seams are in
ARCHITECTURE.md §4b.

## Quick start (5 minutes)

1. Start the server as usual (`npm run build && npm start`, or `scripts\host-online.ps1` for a tunnel).
2. In the game, create your own account (title screen → create account).
3. On the server machine, in the project folder, make that account a moderator. A running server picks this up
   within about 2 seconds, so there is no need to restart:
   ```
   npm run mod -- promote <your-username>
   ```
4. Open the dashboard and sign in with the same account:
   - on the server machine: **http://localhost:7777/admin**
   - on a LAN: `http://<server-ip>:7777/admin`
   - through a tunnel: **the tunnel URL + `/admin`**, e.g. `https://<random>.trycloudflare.com/admin`

   You can also moderate straight from in-game chat (see [In-game commands](#in-game-commands)).

The server prints `chat filter: strict (classroom default)` when it starts. It also prints
`[mod] ready — N moderator(s) …` when the log and bans are active. If you see
`WARNING: moderation needs the accounts database`, accounts failed to start. Chat is still filtered, but nothing
is logged and bans are not enforced.

## What is filtered

The filter checks every chat line (the Command-screen chat, room chat, all chat and team chat) and every name a
player picks (guest callsigns, `/name`, room names, and usernames when an account is created).

| Tier | What | What happens |
|---|---|---|
| **block** | slurs, hate speech, sexual content, threats, self-harm statements | The line is shown to **nobody**. The sender sees "Message blocked (language)." and gets a strike. |
| **mask** | profanity | The line is shown with the word starred: first letter kept, the rest `*`. |
| **mild** | milder words a teacher might let slide | Starred in **strict** (the default). Shown as typed in **standard**. |

- **Self-harm statements** are blocked but are **never** a strike. The student gets a private note: "If you're
  having a hard time, please talk to a teacher or another adult you trust." Online moderators get an alert to
  check in.
- **Threats** (including threats against the school) are strikes, and online moderators are alerted at once.
- **Muted students:** muted and repeated (flood) lines are not shown, but they are still checked. A self-harm
  statement or threat from a muted student still alerts you.
- **Names** are checked more strictly than chat: a listed word hidden inside a name ("xXsomethingXx") is refused.
  - A refused guest callsign becomes a generated `Pilot1234`.
  - A refused `/name` or room name is simply refused.
  - A refused name counts as a strike only when it contains a slur, hate, sexual or threat term. A name refused
    only for profanity is logged but not punished. Real names sometimes collide with the list, and a student
    retrying their own name must not end up muted.
  - A number on a callsign is a number, not leetspeak: a name + number such as `Juliana1`, `Owyhee11`, `Aspen1st`
    or `5Picasso` is never refused because the digit would complete a listed word *inside* the name (and quoted
    in chat, such a callsign is shown as typed).
  - An account keeps the username it registered with. When your custom list (see below) matches a username, the
    account is not renamed and gets no strike; each time it joins, the username is logged as `flag` for you to review.
- **Number codes** (hate symbols written in digits) are starred in chat and refused in names. Only a number
  standing on its own counts:
  - The whole number, even split by one separator: `73 51`, `73.51`.
  - Or one group of a number next to another, split by a space, `-`, `_` or `/`: `wave 3 7351`, `7351 7351`, `Ace_7351_2`.
  - A longer number that contains the code (`173510`), a decimal (`7351.5`), or digits split up by letters inside a
    callsign (`Jet12_Wing34` is never read as the number `1234`) are left alone.
- **Repeats:** the same line a 3rd time within 10 seconds is dropped. Lines that are mostly capitals are lowercased,
  and long letter floods ("nooooooo") are cut down. Links are left exactly as typed.

The filter sees through most evasions:
- upper/lower case
- spaces, dots, dashes or underscores between letters
- invisible characters
- look-alike letters: Cyrillic, Greek, fullwidth, "fancy" math and circled letters
- leetspeak: digits and `@ $ ! + | *`
- repeated letters, word endings, and camelCase

It is also "Scunthorpe-safe": ordinary words and real names that happen to contain a listed word are allowed
(*class*, *cocktail*, *therapist*, *Dickens*, and a list of real given names and surnames).

**Known limits.** No filter is perfect, which is why there is also a log, `/report` and you.
- A string of plain digits is treated as a number, and so is a number followed by a unit such as "900k" or "45s".
  That keeps scores and damage numbers readable, but a word written *entirely* in digits gets through.
- A 3-letter profanity written with one digit *and* a separator, and self-censoring with a dash, are not caught.
  Those are starred at most anyway.
- A callsign whose number completes a listed word *from the start* of the name (a short name + `1`) is still
  refused, because that is also the most common way to sneak a word in. The student picks another number.
- The other side of the same rule: a listed word hidden *inside* a longer word, with its last letter written as a
  digit at the very end, reads as a name + number and gets through. The plain spelling inside a word is still
  caught, and so is the digit form from the start of a word.
- New slang is not on the list until someone adds it (see [Changing the word lists](#changing-the-word-lists)).

Besides the built-in lists, the host can add a **custom term list** of its own, with a review-only **flag** action
(see [Custom terms](#custom-terms-your-own-list)).

## Strictness: `CHAT_FILTER`

| Value | Meaning |
|---|---|
| `strict` (default) | Classroom: profanity **and** mild words are starred. |
| `standard` | Mild words are shown as typed. Profanity is still starred. |

Slurs, hate, sexual content, threats and self-harm statements are blocked in **both** modes. A missing, empty or
misspelled value means `strict`. Set it before starting the server:

```powershell
$env:CHAT_FILTER = 'standard'; npm start          # PowerShell
CHAT_FILTER=standard npm start                    # bash
```

Offline play (no server) is always strict. The same setting applies to usernames at account creation.

## Custom terms (your own list)

Every school has its own local slang, crew names and number codes that no shipped list can know about. So the
built-in lists stay content-neutral, and **you** keep a custom list on the server. The list editor in the admin
console is part of the LAN Edition; the filter engine underneath is in place now (`setCustomTerms` in
`src/shared/moderation`, see its README). Custom terms apply online and, when the host loads them, offline too.

Each entry has:

| Field | What it does |
|---|---|
| **term** | A word, a phrase (2+ words), or a number code such as `7351`. Type the plain spelling: the filter already sees through capitals, accents, look-alike letters, spacing, dots, repeated letters, word endings and leetspeak, exactly as it does for the built-in lists. A word typed in parts joined by `-`, `_` or `.` (`Zorb-Lax`) also matches with the parts spaced out (`zorb lax`). A **short term of 2-3 letters** (initials) counts only when it is typed as one piece: `bc` matches `bc` and `BC`, but never `hold A B C` or `B.C.`, so the game's lettered pads and zones stay clean. |
| **action** | `block` = the line is not shown and it is a strike (like a slur). `mask` = the word is starred. `flag` = **the line is shown as typed** and only logged for you to review — no strike, no mute. |
| **scope** | `chat`, `names` (callsigns, usernames, room names) or `both` (default). |
| **match** | `word` (default: the whole word plus endings like -s / -ing; in names also inside a longer name when 4+ letters), `phrase` (the words in a row, however they are spaced), `strong` (anywhere, even inside another word). Number codes always match a whole number only: `7351` but never `173510`. |
| **anchors** | Optional context words or codes. The entry counts only when one of them is in the **same line** (or the same name). Use this for a number or a word that is only a problem next to something else, e.g. the code `7351` only together with the word `zorblax`. |
| **category** | Your own label (up to 24 characters, letters, digits, space, `-`, `_`), shown in the log. `self-harm`, `Self Harm` and `self_harm` all mean `selfharm`; `threats` means `threat` (see below). |

**Flag is for watching, not punishing.** A flagged line or name reaches everyone unchanged and is logged with the
action `flag` and a hit label `flag:<category>:<term>`. Use it for words that are usually innocent but that you want
to keep an eye on. Masked and blocked custom hits are logged as `custom:<category>:<term>`, so you can always tell
your own list apart from the built-in one. Naming a category `threat` or `selfharm` (any spelling of self-harm)
gives a blocked line the built-in handling: moderators alerted, or the kind note instead of a strike. Its hits read
`custom:selfharm:<term>`.

**Account usernames.** A username is checked when the account is created, before your list may have had a term for
it, and a `flag` term never refuses one. So the server also checks an account's username against your *current*
list every time the account joins. A match is logged as `flag` on the `name` channel with the matching labels. The
account keeps its name and gets no strike; if the name needs to go, talk to the student or ban the account.

**Your list can only add.** A custom entry never weakens the built-in lists: if an entry is spelled like a
built-in term, the built-in rule stays in force (a `flag` entry can't let a slur through) and you get a note about
it. The built-in allowlist of ordinary words and real names still protects them from your terms, except when you
list one of those words yourself.

**Checks when you load a list.** The whole list is refused, with a message per problem (entry number, id and field),
when an entry is empty, too long (64 characters), looks like a wildcard or regular expression (`*`, `?`, `^`, `$`,
`( )`, `[ ]`, …), mixes letters and digits, or uses characters the filter can't read. Limits: 2000 entries, 8 anchors
per entry, number codes of 2-12 digits. Two entries with the same id are both refused. Loading also returns
**notes** (never containing a built-in term): an entry that matches a built-in term, two entries that come out the
same, an entry that sits inside an allowlisted word, or an anchor that is part of its own term. The same list in
any order gives exactly the same result.

*Partial* loading (`setCustomTerms(entries, { partial: true })`) skips the bad entries and keeps the rest. A partial
list in which **every** entry is bad is still refused, and the list you had stays in force: a broken upload never
quietly removes your protection. To remove every custom term, load an empty list (or `clearCustomTerms()`).

**Reviewing flagged lines.** On the dashboard, Chat log → Filter action → **For review (flag terms)**. From the
CLI: `npm run mod -- log --review` (or `export-log --review`). Both find lines and names logged as `flag`, and also
masked or blocked lines and refused names that carry a flag hit. `--flagged` / "Flagged (masked, blocked, withheld)"
is the other view: only the lines the filter acted on. Review-only `flag` lines are left out of it, and out of the
"flagged lines in 24 h" count on a player's card, because they were shown as typed and are not misconduct.

## Strikes and automatic mutes

3 blocked lines within 10 minutes mute that student automatically for 10 minutes. The mute is logged as done by
`system`, and online moderators are told. The student is warned one strike before the mute. To change the numbers,
set `MOD_STRIKE_LIMIT`, `MOD_STRIKE_WINDOW_MIN` and `MOD_AUTOMUTE_MIN`.

## Becoming a moderator

```
npm run mod -- promote <username>     # the account must exist (create it in the game first)
npm run mod -- demote <username>
npm run mod -- admins                 # list moderators
```

Moderators can use the moderator chat commands and the dashboard. They are never caught by a network (address)
ban, so a teacher on the school network can ban a troll on that same network. Use a strong password on moderator
accounts.

## In-game commands

**Every player** has `/report <name> <reason>`. It saves the reported player's last 20 lines with the report and
alerts online moderators. It is limited to 3 per 10 minutes per player.

**Moderators only.** For anyone else these answer exactly like an unknown command. Durations are `10m 2h 1d 7d perm`.

| Command | What it does |
|---|---|
| `/mute <name> <dur> [reason]` / `/unmute <name>` | Stop / allow their chat. A guest mute covers that callsign on that network. |
| `/kick <name> [reason]` | Disconnect them (they can come back). |
| `/warn <name> <message>` | A private warning line to them. |
| `/ban <name> <dur> <reason>` | Ban their **account** (disconnects them, and they can't sign in). |
| `/ipban <name> <dur> <reason>` | Ban their **network address**, which means everyone there (see [Ban scopes](#ban-scopes)). Asks for `/confirm` when others share it. |
| `/unban <name \| #id \| address>` | Lift bans. |
| `/log <name> [n]` | Their last n chat lines (default 10), including blocked ones. |
| `/whois <name>` | Account or guest, address, active bans / mutes, strikes, recent actions. |
| `/reports` · `/reports reviewed <id>` · `/reports dismiss <id>` | Open reports / close one. |
| `/confirm` | Go ahead with a network ban / mute that the server asked about (within 60 s). |
| `/modhelp` | This list. |

`/ban`, `/ipban` and `/mute` also accept a network address from `/whois` (e.g. `/mute 10.0.0.7 10m`). That means
everyone on that network except moderators, and it asks for `/confirm` first.

## The dashboard (`/admin`)

Open `http(s)://<your server>/admin` and sign in with a moderator account. The tabs:

- **Live:** who is online, with room, account or guest, address, strikes and mute state, plus Warn / Kick / Mute /
  Ban buttons. Click any name to look the player up.
- **Chat log:** search by player, text, address, room, what the filter did, and time. The original and the shown
  text appear side by side. **For review (flag terms)** lists the lines your custom `flag` terms caught.
- **Reports:** open, reviewed and dismissed reports, with the saved chat, and ban / mute / warn / dismiss buttons.
- **Bans & mutes:** create one (for an account, a guest callsign, every guest on a network, or everyone on a
  network) or lift one.
- **Actions:** the audit trail of every moderation action.

Bans default to 1 day and mutes to 10 minutes. Permanent bans ask twice.

- **Where it runs:** only the Node game server serves the dashboard. The GitHub Pages site (offline play) has no
  `/admin` and never talks to your database.
- **Security:** the page runs under a strict Content-Security-Policy (same-origin scripts and styles only, no
  inline code, cannot be framed) and is never cached. Your sign-in lives only in that browser tab. Anyone who can
  reach the server can load the sign-in page, but only moderator accounts can use it. Over the internet, always use
  the HTTPS tunnel URL, never plain `http://`.

## CLI (on the server machine)

The CLI works while the server is running. The server notices bans and moderator changes within about 2 seconds.

```
npm run mod -- help
npm run mod -- ban <name> 1d "reason"                  # account ban
npm run mod -- ipban <name|address> 1h "reason" [--guests-only]
npm run mod -- mute <name> 10m ["reason"]
npm run mod -- unban <name|#id|address>                # unmute <name|#id> lifts mutes
npm run mod -- bans [--all] [--mutes|--bans]
npm run mod -- log --player <name> --since 2h          # also --grep text, --flagged, --review, --limit n
npm run mod -- log --review --since 1d                 # lines your custom 'flag' terms caught
npm run -s mod -- export-log --since 7d > chat.csv     # or: export-log --since 7d --out chat.csv
npm run mod -- reports --open
npm run mod -- review <id> reviewed "note"             # or dismiss / open
npm run mod -- prune                                   # apply the retention rules now
npm run mod -- purge-log --before 30d                  # delete chat lines older than 30 days, now
npm run mod -- purge-log --before 1h --player <name>   # ...only that player's
npm run mod -- purge-log --all --yes                   # delete the whole chat log
```

Use `npm run -s` when redirecting the output, so npm's banner stays out of the CSV. Exported text cells that start
with `= + - @` are prefixed with `'`, so a spreadsheet never runs them as formulas.

## The chat log: what is stored, where, for how long

**What.** For every chat line (including blocked, muted and repeated ones) and every refused name attempt:
- the time, room, channel (all / team) and team
- the connection's player number and callsign, and the account (if signed in)
- the network address: the IPv4 address, or the IPv6 /64 prefix
- what they typed, what the others saw, what the filter did, and which listed words matched

The same database also keeps:
- bans and mutes
- reports, each with its own copy of the reported player's last 20 lines
- the moderator list
- the audit trail of moderation actions, including which moderator looked at what

**Where.** In the accounts database on the server machine only: `DB_PATH`, default `data\voidswarm.db`. It is
gitignored, so it is never committed, and nothing is sent anywhere else. Offline play stores nothing.

**How long.**
- Chat lines: `CHAT_LOG_RETENTION_DAYS`, default **90** days, pruned automatically every hour.
- Reports, the audit trail, and bans / mutes that have ended: 365 days.

**Deleting it.**
- `npm run mod -- purge-log --before 30d` deletes older chat lines at once.
- Add `--player <name>` to delete only one player's lines, or use `--all --yes` to delete everything.
- Deleted rows are wiped from the database file (SQLite secure delete), not just marked as free space.
- Reports keep their own saved lines until they age out (365 days).
- An exported CSV is a separate copy: delete it yourself when you are done.

**Privacy note.** The chat log and the addresses are information about your students, and your school's rules on
student records apply (in the US, FERPA). In practice:
- Tell students that chat is logged. The server's welcome line says so whenever logging is on.
- Keep the database and any exports private, and back them up only somewhere as private.
- Keep retention as short as you actually need. 30 days is plenty for a class, so consider
  `CHAT_LOG_RETENTION_DAYS=30`.
- Promote only the adults who need to moderate.

## Ban scopes

| Scope | Hits | Use it for |
|---|---|---|
| **account** (`/ban`) | That account, from any network. They can't connect or sign in. | **The normal choice.** It follows the student, not the room. |
| **guest callsign** (`/mute` on a guest) | That guest callsign on that network (and the live connection, even after a rename). | Quieting one guest. |
| **every guest on a network** (`ipban --guests-only`, dashboard) | All **guests** from that address. Accounts still work. | Forcing a raid of throwaway guests to sign in. |
| **everyone on a network** (`/ipban`) | **Everyone** from that address, accounts and guests, except moderators. New accounts can't be created from it either. | Last resort. |

An **address** is an IPv4 address, or an IPv6 **/64** prefix (one household or connection usually owns a whole
/64, so rotating addresses inside it doesn't escape a ban).

**NAT caveat: an address ban can hit a whole classroom or school.**
- Behind a school or home router, everyone shares one public address. The same happens to everyone who reaches you
  through a tunnel from the same building.
- `/ipban` on one student can therefore lock out the entire class, or every class in the school. The server warns
  you and asks for `/confirm` whenever other pilots online share the address.
- In a classroom, prefer **account** bans and mutes, and have students play with accounts so there is an account
  to act on.
- On a plain LAN (`npm start` inside the building, no tunnel), each machine usually has its own address, so an
  address ban is narrower. Check `/whois` first.

## Changing the word lists

The lists live in [`src/shared/moderation/lists.ts`](../src/shared/moderation/lists.ts). The terms are stored
ROT13-encoded (number codes ROT5), so the slurs don't show up in a casual search or a screen-share.
- To **add** a term, ROT13 it and put it in the right group. The normalizer works out the leetspeak, look-alike,
  spaced-out and suffixed versions itself.
- To **allow** a clean word or a student's real name that gets refused, add it in plain text to `ALLOW_WORDS`.

Then run `npm test`. The tests generate thousands of evasions of every listed term and check the design docs, a
list of real names and a game-chat corpus for false positives. Restart the server afterwards. Never paste decoded
terms into docs, commits or chat. (Local slang does not go here: use the [custom list](#custom-terms-your-own-list).)

**The false-positive corpus** (`src/shared/moderation/fpCorpus.ts`) is 2400 PG game-chat lines, 1700 callsigns
and 90,000+ name + number callsigns built from the game's own words (classes, skills, paths, capital ships, game types, objectives, team colors, room
names), common first names, US and Idaho places, sports teams and PG trash talk. Every one must pass untouched. A
genuine false positive is fixed with an allow word or a match-mode change, never by quietly deleting a protective
term; any such change is noted here:

- Allow word `bonner` (Bonner County and Bonners Ferry, Idaho): the matcher absorbs a repeated letter, so the
  double-n spelling read as a masked word. No term was removed.
- Allow words for real given names found in review: `kuntal`, `analisa`, `anusha`, `anushka`, `shital`, `shitij`,
  `ashit` (also covers Ashita and Ashitaka), `riddick`, `farseer`. Two of them were refused with a strike. No term
  was removed.
- Allow entries for three Idaho landmark names (a canyon, a state park near Lewiston and a lava field near Idaho
  Falls) and a fish common in Lake Lowell, which were starred in strict mode (see the comment next to them in
  `ALLOW_WORDS`). Multi-word allow entries now also read across an apostrophe, so the possessive spelling of a
  landmark is covered. The fish's name is matched as a substring like every allow word, so in strict mode it can
  also let through a longer mild-tier word that contains it. No term was removed.
- Allow phrases for a Minnesota city, a hound breed written as two words, and an everyday "eye for an eye" phrase,
  which were blocked or starred (see `ALLOW_WORDS`). Only the whole phrase is allowed. No term was removed.
- Match rule, not a list change: in names, a callsign's trailing number after a match that starts inside the name
  (`Juliana1`), or a leading number read into a longer word (`5Picasso`), is a number, not leet letters. The
  letters-only spelling inside a name, and a match from the start of the name that ends in a digit, still count.
  The corpus's name + number block (`fpNumberedCallsigns`, 90,000+ callsigns) keeps this covered.

Two entries with the same letters in the lists are merged on purpose: the stricter tier wins and the scopes are
combined. The tests require the built-in lists to have no such collisions, so a new one is always noticed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says "This account is not a moderator." | `npm run mod -- promote <username>` on the server machine. |
| `/admin` shows "Moderation is not available on this server." | Accounts didn't start. Check the server log for the `WARNING:` line. |
| A student's real name is refused | Add it to `ALLOW_WORDS` (see above), or let them pick a variant for now. It is not a strike. |
| A custom term catches innocent lines | Give it anchors (it then counts only next to them), switch `strong` to `word`, or make it `flag` to watch it first. |
| Too strict for an older group | `CHAT_FILTER=standard` lets mild words through. Everything else stays blocked or starred. |
| A ban hit the whole class | `npm run mod -- bans`, then `unban #<id>`. Use account bans instead (see the NAT caveat). |
