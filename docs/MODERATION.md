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
- **Number codes** (hate symbols written in digits) are starred in chat and refused in names.
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
- New slang is not on the list until someone adds it (see [Changing the word lists](#changing-the-word-lists)).

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
  text appear side by side.
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
npm run mod -- log --player <name> --since 2h          # also --grep text, --flagged, --limit n
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
terms into docs, commits or chat.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says "This account is not a moderator." | `npm run mod -- promote <username>` on the server machine. |
| `/admin` shows "Moderation is not available on this server." | Accounts didn't start. Check the server log for the `WARNING:` line. |
| A student's real name is refused | Add it to `ALLOW_WORDS` (see above), or let them pick a variant for now. It is not a strike. |
| Too strict for an older group | `CHAT_FILTER=standard` lets mild words through. Everything else stays blocked or starred. |
| A ban hit the whole class | `npm run mod -- bans`, then `unban #<id>`. Use account bans instead (see the NAT caveat). |
