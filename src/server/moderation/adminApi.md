# Voidswarm moderation — admin HTTP API (contract)

Owner: SERVER MODERATION (`src/server/moderation/http.ts`). The admin dashboard (`src/server/moderation/admin/*`,
ADMIN builder) codes against this file. Change it only together with `http.ts`.

## Serving

- The game server (`src/server/index.ts`) serves the dashboard from `src/server/moderation/admin/`:
  - `GET /admin` and `GET /admin/` → `admin.html`
  - `GET /admin/<file>` → that file (only `.html .css .js .mjs .json .svg .png .ico .woff2`; no sub-folders).
- Headers on every dashboard file: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
  `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  So: **no inline `<script>`**, no `eval`, no CDN; the page talks only to its own origin.
- The API lives on the same origin, so the page uses relative URLs (`/api/login`, `/api/admin/...`).

## Signing in

The dashboard uses the normal accounts API (`src/shared/protocol.ts`, "Accounts"):

- `POST /api/login` `{ login, password }` → `200 { token, account: { accountId, username, emailMasked, createdAt } }`
- `POST /api/logout` `{ token }` → `200 { ok: true }`

Then call `POST /api/admin/me` to learn whether that account is a moderator. Accounts become moderators only from the
server console: `npm run mod -- promote <username>` (there is no HTTP endpoint for promote / demote on purpose).
Keep the token in memory or `sessionStorage` (not `localStorage`); it is the account's normal 30-day session.

## Request rules (every endpoint)

- `POST /api/admin/<endpoint>` only (`OPTIONS` preflight is answered; anything else → `405`).
- Headers: `Content-Type: application/json` (else `415`) and `Authorization: Bearer <token>`.
- Body: a JSON **object**, at most 8 KB (`{}` when there are no parameters). Unknown fields are ignored.
- CORS: the same allowlist as the accounts API (same origin always works). Preflight allows
  `Content-Type, Authorization`.
- Rate limits: 240 requests / minute per moderator account; 20 failed authorizations (401 / 403) per 10 minutes per
  client address, after which further *unauthorized* calls from that address get `429` with `Retry-After` (seconds).
  A valid moderator token is never blocked by the failure limit (a classroom shares one address).
- Every call is audited in `mod_actions` (changes as their own action; reads as `note` rows such as
  `api log player=Bob`; an identical read from the same moderator within 60 s is not written twice).

### Errors

Any non-2xx answer is `{ "error": "<human-readable text>" }` (plus the fields noted per endpoint):

| Status | Meaning |
|---|---|
| 400 | Bad parameter (the message says which) |
| 401 | Missing / invalid / expired token — `Not logged in` |
| 403 | Valid session but not a moderator — `Not a moderator`; or `Origin not allowed` |
| 404 | Unknown endpoint, or the target / id does not exist (`No such player`, `No such report`, ...) |
| 405 / 413 / 415 | Wrong method / body too large / wrong Content-Type |
| 409 | Needs confirmation (see `bans/create`) |
| 429 | Rate limited (`Retry-After` header) |
| 503 | Moderation is unavailable on this server (accounts disabled / DB failed) |

## Conventions

- Times are epoch milliseconds (numbers). `null` expiry = permanent.
- Durations are strings `10m`, `2h`, `1d`, `7d`, `perm` (generally `<n>m`, `<n>h`, `<n>d`, `<n>w`; at most 365 days)
  or a number of seconds. `since` in `log` also accepts such a duration, meaning "that long ago".
- Addresses are the server's address key: an IPv4 address (`203.0.113.7`) or an IPv6 `/64` prefix
  (`2001:db8:1:2::/64`). **A whole school or household usually shares one address.**
- Player lookup (`target`, `player`): the current callsign of an online pilot or an account username;
  case-insensitive and look-alike aware (Cyrillic `а` = Latin `a`, and so on).
- Lists come newest first. Paging: pass the returned `nextBefore` (an id) as `before`; `null` = no more.

### Types

```ts
type Action = 'pass' | 'flag' | 'mask' | 'block' | 'spam' | 'muted';
// pass = shown as typed; flag = shown as typed (a name: allowed), but a host custom term marked 'flag' matched —
// logged for review, never a strike; mask = shown with words starred; block = not shown (language);
// spam = not shown (repeat flood); muted = not shown (sender is muted)

interface ChatLogRow {
  id: number; ts: number;
  roomId: string | null;        // null = the zone lobby (Command screen chat)
  roomName: string;             // 'Zone' for the lobby
  channel: 'all' | 'team' | 'name' | 'room';
  // 'name' = a callsign attempt that was refused (original = the attempted name) — or, with action 'flag', an
  // allowed one that a custom 'flag' term matched (shown = the name), or an ACCOUNT username that the current
  // lists match, logged on every join (kept, never renamed, no strike); 'room' = the same for a room name
  team: number;                 // -1 = none
  playerId: number; name: string;
  accountId: string | null;     // null = guest
  address: string | null;
  original: string;             // what they typed
  shown: string;                // what others saw ('' when not shown)
  action: Action;
  hits: string[];               // one label per filter hit (≤ 128 chars each; a refused name too, one per hit):
                                //   "category:term" — the built-in lists, e.g. "profanity:<term>", "selfharm:<phrase>";
                                //     categories: slur hate sexual threat selfharm profanity mild (refused names too)
                                //   "custom:category:term" — a host custom term's block / mask hit
                                //   "flag:category:term" — a host custom term marked 'flag' (review only)
                                // custom categories are the host's labels (lowercase a-z 0-9 space _ -, ≤ 24 chars)
}
// Self-harm statements are blocked but never counted as a strike; online moderators get an alert in chat
// ("… may be about self-harm … /log <name>"). Filter on hits starting with "selfharm:" (built-in) or
// "custom:selfharm:" (a host custom term; any spelling of the label self-harm is stored as selfharm) to find them.

interface OnlinePlayer {
  playerId: number; name: string;
  accountId: string | null; username: string | null; guest: boolean;
  address: string | null;
  roomId: string | null; roomName: string | null;   // null = in the zone lobby
  muted: { until: number | null; reason: string } | null;
  strikes: number;              // blocked messages in the last 10 minutes
  admin: boolean;
}

interface BanRow {
  id: number;
  kind: 'ban' | 'mute';
  scope: 'account' | 'address' | 'guest';
  // account = that account everywhere; address = EVERYONE on that address (accounts and guests) except
  // moderator accounts; guest = guests (no account) on that address — with `username` set, only that guest callsign
  accountId: string | null; username: string | null; address: string | null;
  createdAt: number; expiresAt: number | null; revokedAt: number | null;
  reason: string;
  by: string;                   // moderator username, 'cli' or 'system' (auto-mute)
  active: boolean;              // not revoked and not expired
}

interface Party { playerId: number | null; name: string; accountId: string | null; address: string | null }

interface ReportRow {
  id: number; ts: number;
  status: 'open' | 'reviewed' | 'dismissed';
  reason: string; room: string;
  reporter: Party; target: Party;
  recentChat: ChatLogRow[];     // the target's last ≤ 20 chat lines when the report was filed (oldest first)
  reviewedBy: string | null; reviewedAt: number | null; note: string | null;
}

interface ActionRow {
  id: number; ts: number;
  actor: string;                // moderator username, 'cli' or 'system'
  actorAccountId: string | null;
  action: 'ban' | 'unban' | 'mute' | 'unmute' | 'kick' | 'warn' | 'note' | 'promote' | 'demote';
  targetAccountId: string | null; targetName: string | null; targetAddress: string | null;
  durationSec: number | null; expiresAt: number | null;
  reason: string;
}
```

## Endpoints

All paths are under `/api/admin/`. Success answers always include `"ok": true`.

### `me` — who am I
`{}` → `{ ok, admin: { accountId, username } }` (403 if the account is not a moderator).

### `online` — pilots connected right now
`{}` → `{ ok, players: OnlinePlayer[] }`

### `log` — search the chat log
```ts
{ player?: string; accountId?: string; address?: string;
  grep?: string;                 // case-insensitive substring of original OR shown text (≤ 100 chars)
  action?: Action | 'flagged';   // flagged = the lines the filter acted on: mask, block, spam, muted
                                 //   (not 'pass', and not 'flag': a review-only line was shown, no strike);
                                 // flag = lines FOR REVIEW: action 'flag', or any line with a "flag:" hit
  roomId?: string;
  since?: number | string;       // epoch ms, or a duration such as '2h' (= 2 hours ago)
  until?: number;
  limit?: number;                // 1..1000, default 100
  before?: number }              // paging cursor (row id)
```
→ `{ ok, lines: ChatLogRow[], nextBefore: number | null }` (newest first). `player` matches the callsign at the
time of the line or the account username.

### `reports` — list player reports
`{ status?: 'open' | 'reviewed' | 'dismissed' | 'all' (default 'open'), limit?: 1..200 (default 50), before?: number }`
→ `{ ok, reports: ReportRow[], nextBefore: number | null }`

### `reports/review` — close / reopen a report
`{ id: number, status: 'reviewed' | 'dismissed' | 'open', note?: string (≤ 500) }` → `{ ok, report: ReportRow }`

### `bans` — list bans and mutes
`{ kind?: 'ban' | 'mute' | 'all' (default 'all'), includeInactive?: boolean (default false), limit?: 1..1000 (default 200) }`
→ `{ ok, bans: BanRow[] }`

### `bans/create` — ban or mute
```ts
{ kind: 'ban' | 'mute';
  target?: string;               // callsign / username (online pilot first, then any account username)
  accountId?: string;            // or an account id
  address?: string;              // or an address key (for scope 'address' / 'guest')
  scope?: 'account' | 'address' | 'guest';
  duration: string | number;     // '10m' | '2h' | '1d' | '7d' | 'perm' | seconds
  reason: string;                // 1..200 chars, shown to the player
  confirm?: boolean }            // required when an address-wide ban/mute would also hit other online pilots
```
Scope default: `account` when the target has an account. For a guest target, a mute defaults to `guest` (that
callsign on that network); a ban needs an explicit `scope: 'guest'` (every guest on that network) or `'address'`
(everyone on that network) — otherwise `400` explaining this.

→ `{ ok, ban: BanRow, kicked: number }` (`kicked` = connections closed right away; mutes kick nobody).
→ `409 { error, needsConfirm: true, sharing: number }` when an address / guest scope would affect `sharing` other
online pilots and `confirm` was not `true`. Show the warning and resend with `confirm: true`.

Banned pilots are disconnected at once with `You are banned until <date>: <reason>` and refused at connect,
login and (for address bans) registration.

### `bans/revoke` — lift a ban or mute
`{ id: number }` or `{ target: string, kind: 'ban' | 'mute' }` (lifts every active one of that kind for that target)
→ `{ ok, revoked: number }`

### `kick` — disconnect a pilot (they can reconnect)
`{ target?: string, playerId?: number, reason: string }` → `{ ok, kicked: number }`

### `warn` — private warning line to a pilot
`{ target?: string, playerId?: number, reason: string }` → `{ ok, warned: number }`
(The pilot sees `Warning from a moderator: <reason>`.)

### `whois` — everything about one player
`{ target: string }` →
```ts
{ ok, whois: {
  query: string;
  online: OnlinePlayer[];                   // matching live connections
  account: { accountId: string; username: string; createdAt: number; lastLogin: number | null; admin: boolean } | null;
  addresses: string[];                      // addresses seen in their chat log (most recent first, ≤ 10)
  activeBans: BanRow[];
  strikes: number;                          // blocked messages in the last 10 minutes
  flagged24h: number;                       // their log lines the filter acted on in the last 24 h (mask, block,
                                            // spam, muted — review-only 'flag' lines are not counted)
  recentActions: ActionRow[];               // last ≤ 20 moderation actions against them
} }
```
404 when nothing matches (no online pilot, no account, no log line with that name).

### `actions` — the moderation audit trail
`{ limit?: 1..1000 (default 100), before?: number, target?: string }` → `{ ok, actions: ActionRow[], nextBefore: number | null }`

## LAN edition (v0.6): the Host Control Panel's endpoints

In the LAN edition the panel is served by the **admin listener** on port A (default 7778, loopback only unless the host
turns on remote access; `src/server/listeners.ts`, `http.ts startAdminPanel`), not by the game port (its `/admin` only
says "The control panel is on the host PC"). The request rules above hold, with these differences (spec §5.15):

- `Authorization: Bearer <admin session>` (a `vsadm_…` token from `setup` or `login`). Player game tokens are refused.
  Only `setup/status`, `setup`, `login` and `display/state` need no token.
- No CORS: a POST must carry the listener's own `Origin` (`http://localhost:A` on the host PC), else `403`.
- Each route has a capability (`capabilities.ts can()`); `401 { code: 'reauth' }` asks for `reauth` on a sensitive
  (★) call with a stale session; `403 Host PC only` / `Not allowed for your role`.
- Rows for moderators never carry `address` (an `addressTag` instead), `original`, email or SELF-HARM lines.
- The Chat log reads (`log`, `log/context`, `log/reveal`, `log/rooms`, `log/stats`, `log/export`, `log/purge`) run in
  the maintenance worker; while it is down they answer `503`.

### `setup/status`
Host PC only, no token. `{}` → `{ ok, needsSetup, setupKind: 'first' | 'reset' | null }`.

### `setup`
Host PC only, no token. `{ setupCode, username, password, preset: 'home' | 'school', serverName, accountsMode: 'email' |
'roster', domains?: { domain, subdomains }[] }` → `{ ok, token, session }`. `400 { field, attemptsLeft }` on a wrong
code or a weak password; `429 { retryAfter }` after too many wrong codes (the code is voided; the console shows a new
one); `404` once set up. The code comes from the launcher's console (the browser it opens has it in the URL fragment).

### `login`
`{ role?: 'host' | 'moderator', username, password }` → `{ ok, token, session }`. `401` wrong password; `403` remote
access off / the moderators' view off / needs https; `429 { retryAfter }` after repeated failures.

### `reauth`
`{ password }` → `{ ok, session }`: the step-up for ★ calls (valid `admin.stepUpMinutes`, default 10).

### `logout`
`{}` → `{ ok }` (this session only).

### `home`
`{}` → host: `{ ok, serverName, join: { url, notServing, others }, rooms, counts, online, alerts: { urgent, banner,
wellbeing }, openReports, presentingAtLogin, … }`; a moderator gets the counts only (`{ ok, counts, openReports? }`).

### `alerts/list`
`{ includeAcked? }` → `{ ok, alerts: Alert[], counts }` (newest first; a wellbeing alert is nameless: no name,
account or words, only `wellbeing: true` and its tags). Host principals only.

### `alerts/ack`
★ `{ id, note? }` → `{ ok, alert }`. A wellbeing alert also needs `wellbeing`, and is stored so it never comes back.

### `wellbeing/open`
★ `{ id }` → `{ ok, student, line, context }`: the one place a wellbeing line's name and words are shown (audited).

### `wellbeing/ack`
★ `{ id, note }` → `{ ok }`.

### `chat/live`
`{ after?: seq, wait?: 0..25 (seconds, long-poll), limit?: 1..500, roomUid?, tag?, flaggedOnly?, channel?, player? }` →
`{ ok, lines: LiveLine[], next, gap }`. Lines are what the others saw (`shown`, with `display`: as-typed, substituted,
system, hidden, withheld) with their `tags` and `ts`; never the original. `gap: true` when lines were missed (a ring of
5,000, numbered from the start time, so a restart shows a gap). At most 4 waits per session (`429 liveBusy`).

### `log/context`
`{ id, before?: 0..50, after?: 0..50 }` → `{ ok, anchor, before, after, scope, moreBefore, moreAfter }` (the lines
around one line in the same room; always audited).

### `log/reveal`
★ `{ ids: number[] }` (1..100) or `{ accountId, since?, until?, before? }` → `{ ok, originals: { id, original }[],
nextBefore }`. The ONLY way to read what a student typed; every call is audited (never coalesced).

### `log/rooms`
`{ since?, until?, limit?: 1..1000 }` → `{ ok, rooms }` (the rooms that have lines in the range).

### `log/stats`
`{ days?, tzOffsetMin?, fresh? }` → `{ ok, rows, oldest, newest, dbBytes, walBytes, perDay, retention, nextPurgeAt,
dropped, pending, indexTidyPending }`.

### `log/export`
★ A filter (as `log`) plus `{ format: 'csv' | 'json', all?, includeOriginal?, includeWellbeing?, saveOnHost? }` → a file
(`Content-Disposition`, `X-Row-Count`; CSV is UTF-8 with a BOM, CRLF, formula cells neutralised), or with `saveOnHost`
`{ ok, savedTo, fileName, rows }` (data\exports, deleted after 7 days). `includeOriginal` needs `reveal`. Audited.

### `log/purge`
★ `{ before, accountId?, confirmRows? }` → first `409 { needsConfirm, rows }`, then with `confirmRows` equal to that
count `{ ok, deleted }`. Recorded in the deletion ledger (a restore re-applies it). Audited.

### `announce`
`{ text: 1..200, roomId? }` → `{ ok, delivered, roomId }`: a `[Host] <text>` line to every room (or one), logged on
channel `announce`.

### `settings/get`
★ `{}` → `{ ok, settings, rev }` (no secrets: the SMTP password is only reported as set or not).

### `settings/update`
★ `{ rev, patch }` → `{ ok, settings, rev, changed, warnings, restartNeeded }`; `409 { error, rev }` when `rev` is
stale; `400 { error, field }`. Applies live and writes one `settings` audit row per changed leaf.

### `customTerms/list`
★ Host admin only. `{}` → `{ ok, terms: CustomTerm[] }` (the host's own list; never shown to moderators).

### `customTerms/add`
★ `{ term: 2..64 characters, category?, action?: 'block' | 'mask' | 'flag' (default flag), scope?: 'chat' | 'names' |
'both', match?: 'word' | 'phrase' | 'strong', context?: string[] (at most 8), note? }` → `{ ok, term }`. A typed term
is confirmed by the host who typed it and applies at once; a term that doesn't compile is refused (`400`) and not
saved. Audited by category (never the term itself).

### `customTerms/remove`
★ `{ id }` → `{ ok, removed }` (`404` for an unknown id).

### `customTerms/test`
★ `{ text }` → `{ ok, action, tags, customHits }` ("Try a line"; never names a built-in term).

`customTerms/update`, `customTerms/import`, `customTerms/export` and `customTerms/confirm` arrive in M4 (they answer
`501` until then), as do the Rooms, Accounts, Conduct, certificate and network endpoints listed in spec §5.15.

## Retention

Chat log rows are kept `CHAT_LOG_RETENTION_DAYS` days (env, default 90); reports and moderation actions 365 days;
expired / revoked bans 365 days after they ended. Pruning runs hourly.
