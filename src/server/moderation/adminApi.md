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
type Action = 'pass' | 'mask' | 'block' | 'spam' | 'muted';
// pass = shown as typed; mask = shown with words starred; block = not shown (language);
// spam = not shown (repeat flood); muted = not shown (sender is muted)

interface ChatLogRow {
  id: number; ts: number;
  roomId: string | null;        // null = the zone lobby (Command screen chat)
  roomName: string;             // 'Zone' for the lobby
  channel: 'all' | 'team' | 'name' | 'room';
  // 'name' = a callsign attempt that was refused (original = the attempted name);
  // 'room' = a refused room name (original = the attempted room name)
  team: number;                 // -1 = none
  playerId: number; name: string;
  accountId: string | null;     // null = guest
  address: string | null;
  original: string;             // what they typed
  shown: string;                // what others saw ('' when not shown)
  action: Action;
  hits: string[];               // "category:term" per filter hit, e.g. "profanity:<term>", "selfharm:<phrase>";
                                // categories: slur hate sexual threat selfharm profanity mild (refused names too)
}
// Self-harm statements are blocked but never counted as a strike; online moderators get an alert in chat
// ("… may be about self-harm … /log <name>"). Filter on hits starting with "selfharm:" to find them.

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
  action?: Action | 'flagged';   // flagged = everything except 'pass'
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
  flagged24h: number;                       // their non-'pass' log lines in the last 24 h
  recentActions: ActionRow[];               // last ≤ 20 moderation actions against them
} }
```
404 when nothing matches (no online pilot, no account, no log line with that name).

### `actions` — the moderation audit trail
`{ limit?: 1..1000 (default 100), before?: number, target?: string }` → `{ ok, actions: ActionRow[], nextBefore: number | null }`

## Retention

Chat log rows are kept `CHAT_LOG_RETENTION_DAYS` days (env, default 90); reports and moderation actions 365 days;
expired / revoked bans 365 days after they ended. Pruning runs hourly.
