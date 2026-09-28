# Voidswarm accounts (server side)

This is the HTTP JSON auth API under `/api/*`. The contract is the **Accounts** block in `src/shared/protocol.ts`. Data is stored with `node:sqlite` in the file at `AuthOptions.dbPath` (`data/voidswarm.db`, gitignored).

| File | Role |
|---|---|
| `index.ts` | Frozen public API (`AuthService`, `AuthOptions`, `createAuthService`) |
| `service.ts` | Endpoints, validation, sessions, rate limits (`createAuthServiceWith` adds test seams) |
| `store.ts` | SQLite schema + migrations (`PRAGMA user_version`), WAL mode |
| `crypto.ts` | scrypt password hashing, random tokens, sha256 |
| `ratelimit.ts` | In-memory sliding-window limiter |
| `mailer.ts` | nodemailer SMTP, or the dev console fallback |
| `http.ts` | Body limit (8 KB), JSON responses, CORS, client IP |

## Environment

| Var | Meaning |
|---|---|
| `PUBLIC_URL` | Base of reset links (`${PUBLIC_URL}/?reset=<token>`). The game server passes it in as `opts.publicUrl`. Use the **https** URL in production. |
| `SMTP_HOST` | Enables real mail. If unset, you get **dev mode**: the reset link is printed to the server console as `[auth] DEV reset link for <user>: <url>`. |
| `SMTP_PORT` | Default `587` (STARTTLS). |
| `SMTP_SECURE` | `1` = implicit TLS (port 465). If unset, it is inferred from port 465. |
| `SMTP_USER` / `SMTP_PASS` | SMTP credentials. When a user is set on a non-TLS port, STARTTLS is required, so credentials never travel in plaintext. |
| `MAIL_FROM` | e.g. `Voidswarm <noreply@yourdomain.com>`. Defaults to `SMTP_USER`. |
| `TRUST_PROXY` | `1` = key rate limits by the **last** `X-Forwarded-For` entry, which is the address your reverse proxy saw. Earlier entries can be forged by the client and are ignored. Only set this when the game port is reachable *only* through the proxy (firewall it or bind it locally). Otherwise clients can spoof their IP. |

A failed send is logged with its SMTP error code and never reaches the client. `/api/forgot` always answers `{ ok: true }`.

### Gmail (app password)
1. Turn on 2-Step Verification on the Google account.
2. Go to Google Account → Security → **App passwords**, create one, and copy the 16-character code.
3. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<app password>`, `MAIL_FROM="Voidswarm <you@gmail.com>"`.

Gmail rewrites the From address to your own and caps sending at about 500 mails/day. That is fine for a hobby server.

### Resend
1. Verify your domain at resend.com and create an API key.
2. Set `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_SECURE=1`, `SMTP_USER=resend`, `SMTP_PASS=re_...`, `MAIL_FROM="Voidswarm <noreply@yourdomain.com>"`.

### Other SMTP
Any provider works, for example SendGrid (`smtp.sendgrid.net`, user `apikey`), Mailgun, Postmark, Amazon SES or your own relay. For local testing, a catch-all such as Mailpit works too (`SMTP_HOST=localhost SMTP_PORT=1025`, no user).

## HTTPS is required on the internet
Passwords and session tokens travel in request bodies, and the ws `hello` carries the token. Plain http/ws is only acceptable on a LAN. Put a TLS-terminating proxy in front:

- **Caddy** (automatic HTTPS, proxies WebSockets out of the box):
  ```
  voidswarm.example.com {
      reverse_proxy 127.0.0.1:7777
  }
  ```
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:7777` for a quick test, or a named tunnel for a stable hostname.

Then set `PUBLIC_URL=https://voidswarm.example.com` and `TRUST_PROXY=1`, have players connect with `wss://`, and firewall port 7777 from the outside.

## Security summary
- **Passwords:** scrypt with **N=32768, r=8, p=3** (64-byte key, 16-byte salt), stored as `scrypt$N$r$p$salt$hash` and compared with `timingSafeEqual`. Login against an unknown user still runs one scrypt verify, against a dummy hash made with the current params.
  - These are OWASP's equivalent-strength params for N=2^17, p=1. They cost about the same CPU (N·r·p is 0.75× of it) but only a quarter of the memory: 32 MiB per hash, because the three lanes run one after another over the same buffer.
  - The params live in each stored hash, so older hashes still verify: v0.1 (N=16384, p=1) and the first hardening pass (N=32768, p=1). They are transparently rehashed with the current params on the next successful login. The swap is compare-and-swap, so it can never undo a password reset that lands mid-login.
  - A **failed** verify always costs at least one current-params verify. When the stored hash is cheaper (a dormant account on old params, or a corrupt row), the difference is burned as extra scrypt lanes in the same job. Without this, a wrong password for an account still on an old hash would answer measurably faster than one for an unknown login, and the timing would reveal that the account exists. A stronger stored hash is never shortened.
  - The verifier accepts working sets up to 128 MiB (N=2^17 at r=8), so raising `SCRYPT_N` later never locks anyone out. Each call's `maxmem` is computed from its own params.
  - At most 2 scrypt jobs run at once (32 MiB each). This bounds memory and keeps libuv pool threads free during a login flood. Each job takes about 3× the CPU time of the old p=1 setting (roughly 150–200 ms on a desktop CPU), so the server checks about a dozen passwords per second and queues the rest.
- **Tokens:** session and reset tokens are 32 random bytes, and only their sha256 is stored.
  - Sessions last 30 days, with a sliding refresh on `/api/me` or ws verify. Each account keeps at most 20.
  - Reset tokens last 30 minutes and are single use. A new request invalidates older tokens, and a successful reset revokes every session.
  - `AuthService.onSessionsRevoked(cb)` fires after every revocation, so the game server can kick live ws connections on a dead session. It fires `(accountId, sessionTokenHash(token))` on logout and when the oldest session is dropped by the 20-session cap, and `(accountId, null)` on a password reset, which revokes all sessions.
- **Rate limits** (per client address unless noted). An address is an IPv4 address or an **IPv6 /64**, since one subscriber usually owns a whole /64 and could otherwise rotate through it. IPv4-mapped IPv6 counts as IPv4.

  | Endpoint | Limit |
  |---|---|
  | login | 10 / 10 min, plus 5 failures / 10 min per (address, login), plus **10 failures / 15 min per account from all addresses** (username and email share it; unknown logins are locked the same way, so a lock reveals nothing; a password reset lifts it) |
  | register | 5 / h |
  | forgot | 5 / h, plus 3 / h per email |
  | reset | 10 / 10 min |

  A blocked request gets the same generic 429 (`Too many attempts — try again later`) with `Retry-After`, whichever limiter blocked it. Each limiter tracks at most 50k keys and evicts the least recently hit, which is O(1) per request.

  The two login **failure** limits are check-and-reserve. Each attempt reserves a failure slot on both the (address, login) and the account limiter *before* scrypt runs, with no await between the check and the reservation. A wrong password commits the slot as a failure; a success gives it back and clears the earlier failures (but not the slots other in-flight attempts still hold). So a parallel burst can't slip past the check: of 50 simultaneous wrong guesses for one account from 50 addresses, exactly 10 are evaluated and 40 get the 429 without any hashing. An unknown login under the same burst gets the identical split, bodies and `Retry-After`.
- **No email enumeration:** `/api/forgot` always answers `{ ok: true }`. `/api/register` answers a taken username and a registered email with the same 409 `Username or email unavailable`. Usernames are public in game anyway.

### Known residuals (deferred)
- **SEC-11, register email probe:** register still has to refuse a duplicate email. A probe that pairs the email with a surely-free username therefore learns whether that email has an account. Only an email-verification step before an address is bound to an account would close this, and that is deferred. Meanwhile the per-address register limit (5 / h) caps the probing. Behavior is unchanged on purpose.
- **Shared lock links username and email:** a username and its email share one per-account failure counter (otherwise an attacker would get 10 guesses through each). Someone who spends 10 failures to lock a username can then try a candidate email: a 429 instead of a 401 says the two belong together. That is more than the SEC-11 probe gives (it ties the email to a specific username). But it takes 10 failed logins to set up, it locks the owner out for the 15 minutes it lasts (a password reset lifts it), and each candidate email still counts against the per-address login limit. Pre-existing and unchanged; closing it would mean separate counters for username and email, which doubles an attacker's guesses.
- **HTTP:** POST only (405 otherwise). Requests must be `application/json` (415), with an 8 KB body cap (413). Responses carry `Cache-Control: no-store`.
- **CORS:** only `corsOrigins`, plus same-origin, are allowed. Any other `Origin` gets 403.
- **Logging:** passwords and tokens are never logged. The one exception is the dev-mode reset link, which is printed only when SMTP is unset.

## Loot profiles (v0.3 M2)
The account id is also the key of the pilot's cosmetic loot profile. The profile lives in `accounts.profile_json` (NULL until the first real change); `MIGRATIONS[1]` (schema v2) adds `accounts.profile_rev` and the `loot_ledger` table (`account_id, grant_key` primary key, `ON DELETE CASCADE`). `src/server/profile/sqliteProfiles.ts` (`createSqliteProfileStore(dbPath, { log })`) opens its **own** connection on the same file, so `server/index.ts` creates it only **after** the AuthService has migrated the schema, and closes it before the AuthService on shutdown (after every Zone connection has left, so leave grants still commit).

- **Rev check:** every profile write is `UPDATE … WHERE id = ? AND profile_rev = <rev this store last read or wrote>`. A row changed by anything else (a second process, a hand edit with the sqlite CLI) throws `ProfileConflict` instead of being clobbered, and a key this store never loaded may only be written while its `profile_json` is still NULL. `ProfileService` recovers per account: it re-reads the key, re-applies the already-rolled grant and commits again, so one stale account never costs the others their grant.
- **Ledger:** one `commitGrants` transaction per match records each grant key once; a replayed key returns `false` and writes nothing. Rows are pruned after **30 days** (`LEDGER_TTL_MS`), which is the idempotency window for a grant key. Grant keys are `${bootId}:${n}#${accountId}#${seq}` with a random boot id, so a restarted server never reuses one.
- **Unknown account** (deleted mid-session): `load` returns null, `save` throws a plain error, `commitGrants` returns `false` for that entry.
- One server process per DB file (ARCHITECTURE.md §3c). The rev check and the ledger make a second process safe against double grants and lost writes, not a supported deployment.

Tests: `npx vitest run src/server/auth src/server/profile`
