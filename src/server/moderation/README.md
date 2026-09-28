# Voidswarm moderation (server side)

Chat is censored everywhere, and on a server every line is logged so a moderator can act on it later.
The operator guide (setup, privacy, ban scopes) is [`docs/MODERATION.md`](../../../docs/MODERATION.md).

- **Filter (always on, online and offline).** Every human chat line goes through `src/shared/moderation/filter.ts`:
  zone lobby and rooms, all chat and team chat. So does every human-chosen name: guest callsigns, `/name`, room
  names and new account usernames.
  - `mask`: the line is shown with the words starred.
  - `block`: the line is withheld. The sender sees "Message blocked (language)." and gets a strike.
  - `flag` (host custom terms only, see `docs/MODERATION.md` "Custom terms"): the line / name is allowed and shown as
    typed, and logged with action `flag` and a `flag:<category>:<term>` hit for review — never a strike.
    `log --review` / the dashboard's "For review" filter / API `log` `action: 'flag'` list them (a refused name that
    also carries a `flag:` hit too: a refused name logs one label per hit). An **account** username that the current
    lists match (a review-only term, or a custom term added after registration) is logged as `flag` on the `name`
    channel on every join: the account keeps its name, no strike. `--flagged` / "Flagged" and the whois
    `flagged24h` count only the lines the filter acted on (mask, block, spam, muted), never `flag` lines.
  - A refused guest callsign is replaced with a generated `Pilot1234`. A refused name is a strike only when it has
    a block-tier hit (slur, hate, sexual, threat); a profanity-only refusal is logged, not punished.
  - Repeating the same line floods out: the 3rd copy within 10 s is dropped.
  - Strictness: `CHAT_FILTER=strict` (default) or `standard` (mild words shown).
- **Log (servers with accounts).** SQLite, in the same file as the accounts (`DB_PATH`, default `data/voidswarm.db`).
  It records every line with who, where, what they typed, what others saw, and what the filter did. It also keeps
  bans / mutes, reports and an audit trail of every moderator action.
- **Strikes.** 3 blocked lines in 10 minutes → an automatic 10-minute mute, recorded as done by `system`. Online
  moderators are told.
  - A line blocked only as a **self-harm statement** is never a strike. The pilot gets a kind note, and online
    moderators get an alert to check in with them.
  - Threats are strikes, and moderators are alerted at once.
  - Lines withheld anyway (the pilot is muted, or a repeat flood) are still filtered: a self-harm statement or a
    threat in them alerts moderators (`ModerationHook.alert`, at most once a minute per pilot), with no strike.
  - If the DB is busy when an automatic mute is saved (the CLI holds the write lock), the mute is enforced from
    memory at once and saved on a later poll; the game thread never waits on the lock.
- **Bans.**
  - Refused at connect ("You are banned until …: reason"), at `/api/login` ("This account can't sign in right
    now.") and, for network bans, at `/api/register`.
  - A ban issued while the pilot is online disconnects them immediately.

## Setting up (the teacher)

1. Create your account in the game (title screen → create account).
2. On the server machine, make it a moderator. A running server picks this up within ~2 s:
   ```
   npm run mod -- promote <your-username>
   ```
3. Moderate in chat with the commands below, or open **`http(s)://<server>/admin`** and sign in with the same account.

## Moderator chat commands

Only moderators can see or use these. For anyone else they answer exactly like any unknown command.

| Command | What it does |
|---|---|
| `/ban <name> <dur> <reason>` | Ban an account (disconnects it). Durations: `10m 2h 1d 7d perm` |
| `/ipban <name> <dur> <reason>` | Ban their **network address**, which bans everyone there. It asks for `/confirm` if others share it. Moderators are never caught by address bans. |
| `/mute <name> <dur> [reason]` / `/unmute <name>` | Mute / unmute. A guest mute covers that callsign on that network. |
| `/unban <name \| #id \| address>` | Lift bans |
| `/mute <address> <dur>` · `/ban <address> <dur> <reason>` | A bare network address means that whole network (everyone there, moderators excepted), after `/confirm` |
| `/kick <name> [reason]` | Disconnect (they can come back) |
| `/warn <name> <message>` | Private warning line to them |
| `/log <name> [n]` | Their last n chat lines (default 10) |
| `/whois <name>` | Account, address, active bans / mutes, strikes |
| `/reports [reviewed\|dismiss <id>]` | Open reports / close one |
| `/modhelp` | This list |

Players have `/report <name> <reason>`, limited to 3 per 10 minutes. It files the target's last 20 lines and pings
online moderators.

**Guests and schools.** A whole school usually reaches the server from **one address**. So:

- A guest has no account to ban. `/kick` or `/mute` them instead.
- `/ipban` blocks the whole building. The server warns you and needs `/confirm` before it does that.
- If you want accountability, have students play with accounts.

## CLI (on the server machine; works while the server runs)

```
npm run mod -- promote <user> | demote <user> | admins
npm run mod -- ban <name> <dur> <reason> | ipban <name|address> <dur> <reason> [--guests-only] | mute <name> <dur> [reason]
npm run mod -- unban <name|#id|address> | unmute <name|#id> | bans [--all] [--mutes|--bans]
npm run mod -- log [--player X] [--since 2h] [--grep text] [--flagged|--review] [--limit n]
npm run -s mod -- export-log --since 7d > chat.csv        (or: export-log --since 7d --out chat.csv)
npm run mod -- reports [--open] | review <id> [reviewed|dismiss|open] [note] | prune
npm run mod -- purge-log --before 30d [--player X] | purge-log --all --yes
```

`-s` keeps npm's own banner out of the CSV. Cells that start with `= + - @` are prefixed with `'`, so a spreadsheet
never runs them as formulas.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `CHAT_FILTER` | strict | `strict` (classroom: mild words starred too) or `standard`. Anything else is strict. Also used for usernames at registration. |
| `CHAT_LOG_RETENTION_DAYS` | 90 | Chat lines older than this are pruned (hourly). Reports, actions and ended bans are kept 365 days. |
| `MOD_STRIKE_LIMIT` | 3 | Blocked lines that trigger an automatic mute |
| `MOD_STRIKE_WINDOW_MIN` | 10 | ...within this many minutes |
| `MOD_AUTOMUTE_MIN` | 10 | Length of the automatic mute |

## Files

| File | Role |
|---|---|
| `service.ts` | `ModerationService`: the Zone hook, ban matching / enforcement, strikes, reports, shared operations |
| `store.ts` | SQLite access (tables from `MIGRATIONS[2]` in `../auth/store.ts`), batched chat-log writes, retention |
| `commands.ts` | Moderator chat commands |
| `http.ts` | `/api/admin/*` (contract: `adminApi.md`) and the `/admin` dashboard files (`admin/`) |
| `cli.ts`, `cliCore.ts` | `npm run mod` |
| `durations.ts` | `10m / 2h / 1d / 7d / perm` parsing and date formatting |

**Performance.** Per chat line the Zone only does in-memory work (the filter, the mute check, a push onto the log
buffer). The log is written in 50-row transactions on a timer. Those writes never wait on a lock held by the CLI;
the rows stay buffered instead. Pruning runs in small steps.

**Pickup of CLI changes.** The server polls `mod_meta.rev` every 2 s. The CLI bumps it on every ban or moderator
change.
