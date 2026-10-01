# Voidswarm LAN Edition: architecture spec, revision 2 (target v0.6.0)

- **Status:** design only. Nothing is implemented, and no project file was edited while writing this revision.
- **Date:** 2026-09-28. **Role:** architect (revision).
- **What changed since the draft:**
  - every blocker, major and minor from both critics is answered; §13 (Decision log) gives the outcome of each one;
  - owner amendments A1 (separate tags, per-tag counters and policy) and A2 (positive substitution, generic private warning) from design-scratch/lan-amendments.md` are folded in (§5.8);
  - a Build plan is added (§14).
- **Inputs:**
  - the packaging, HTTPS and code-map research (design-scratch/lan_packaging\`, `lan_https\`, `lan_codemapper\`);
  - the privacy/security critic (`lan_security\`) and the usability/operations critic (`lan_opscritic\`);
  - the owner's decisions of 2026-09-28 and amendments A1 and A2;
  - new measurements for this revision in design-scratch/lan_architect\r2\`: `heavy.mjs`, `purge.mjs`, `optimize.mjs`, `merge.mjs`, `sqlite-api.mjs`, `auth2.mjs`, `inter.mjs`/`inter.ps1`/`inter2.ps1`, `nc.mjs`/`nc.ps1`. The scratch DBs were deleted after measuring.
  - The scratch root is `design-scratch/`.
- **Version:**
  - The root `package.json` goes from 0.5.0 to **0.6.0** (MINOR).
  - `PROTOCOL_VERSION` stays **5**. Substitute lines, warnings and announcements are ordinary chat and system lines, and policy and verification travel over the HTTP accounts API.
  - The DB schema goes from **v3 to v4**, migrated automatically after an encrypted backup.
- **Out of scope:**
  - the v1.0 combat overhaul;
  - a signed single-file .exe;
  - Google sign-in (§4.4);
  - a hosted AI moderation service (only its seam is designed);
  - Windows DPAPI (dropped, §2.4).

> **Design-time evidence.** Paths under `design-scratch/` refer to measurement scripts and prototypes the design agents ran on the owner's PC; they are not in the repo (they contain machine details). The facts they measured are summarized in section 0 and the Appendix.

---

## 0. Facts that shape the design (read first)

1. **Controllers work over plain http on current desktop browsers.**
   - The Gamepad API's secure-context rule was removed from the spec (w3c/gamepad PR #194) and from Firefox 125. Chrome never shipped it.
   - Measured on `http://192.168.1.50` in Chrome 153 and Edge 154: `isSecureContext = false`, and `getGamepads()` returns 4 slots.
   - Only Firefox 81–124 hides controllers over http.
   - **Not yet tested:** a real phone with a Bluetooth controller. That is release gate T-REL-3.
   - HTTPS stays the default because of passwords and tokens on classroom Wi-Fi.
2. **The server already logs every human chat line** with the ORIGINAL text, in `chat_log`.
   - That covers every action: pass, flag, mask, block, spam and muted.
   - The schema is in `auth/store.ts` MIGRATIONS[2]; the writes are in `moderation/store.ts`.
   - There is no whisper channel: `ChatChannel = 'all' | 'team' | 'system'` (`protocol.ts:219`).
3. **Heavy admin queries freeze the game.** `node:sqlite` is synchronous and shares the tick thread. Measured:

   | Query | Rows | Time |
   |---|---|---|
   | `LIKE` substring search | 1M | **302 ms** |
   | per-student `GROUP BY` (conduct summary) | 500k | **3,067 ms** |
   | FTS5 trigram search | 1M | 14 ms |

   - The same 3 s query in a `worker_threads` worker with its own read-only connection left the game thread free:
     - a 60 Hz timer's worst gap was 17.7 ms, with an event-loop p99 of 2.9 ms;
     - concurrent chat flushes took at most 3.9 ms.
   - So every admin read runs in a worker (§5.16).
4. **FTS5's own `secure-delete` option makes purges 30–130× slower.** Measured on 1,000-row delete chunks:

   | Setup | Rows in table | p50 per chunk | Worst chunk |
   |---|---|---|---|
   | FTS5 secure-delete on | 100k | 291 ms | – |
   | FTS5 secure-delete on | 500k | 762 ms | 3.97 s |
   | FTS5 secure-delete off (SQLite `secure_delete` on) | 300k | **5.8 ms** | 63 ms |

   - SQLite's own `secure_delete` costs about 7%.
   - The draft's FTS5 secure-delete is therefore dropped. Deleted rows' index entries are removed by an FTS `optimize` in quiet windows instead (0.93–1.0 s at 240k rows; §5.16).
5. **One server runs every game type at once.**
   - `MAX_ROOMS` = 24, including the 5 house rooms (`Zone.ts:119`).
   - `MAX_PLAYING_ROOMS` = 6 can be mid-match (`constants.ts:87`).
6. **For accounts, the callsign is the username** (`Zone.ts:486-488`). A callsign history therefore only exists for guests.
7. **If the DB fails to open, the server continues with no chat log** (`index.ts:79-110`).
8. **Signup requires an email in three places:** `TitleScreen.ts:663`, `auth/service.ts:230`, and the schema (`email_lower NOT NULL UNIQUE`).
9. **A loopback socket address does not prove "host PC":**
   - the owner's `scripts/host-online.ps1` tunnels cloudflared to 127.0.0.1;
   - Caddy proxies from localhost on the VPS;
   - the ws upgrade has no Origin check (`index.ts:218`);
   - the admin API's CORS list includes every :5173 and :4173 dev origin (`netguard.ts:205-226`).
10. **In-game moderator commands bypass any panel limits** (`commands.ts:39-129`):
    - `/ban … perm`;
    - `/unban` of any ban;
    - `/log` (up to 50 ORIGINAL lines);
    - `/whois` (addresses, strikes);
    - `/reports` (who reported whom);
    - self-harm and threat alerts naming the student go to every online moderator (`service.ts:454, 536`).
11. **Reports store 20 full chat rows each** (original text and address) for 365 days (`moderation/store.ts:546`). They outlive chat retention and purges (`:654`).
12. **Node 24.16 sandbox facts (measured):**
    - `--permission` blocks fs writes outside the allow-list, and child processes;
    - it does **not** restrict `node:sqlite` or `listen`;
    - `DatabaseSync.setAuthorizer` exists, and denying `SQLITE_ATTACH` also denies `VACUUM INTO`;
    - `trusted_schema` defaults to 1 and can be set to 0;
    - `loadExtension` is refused by default.
13. **Windows facts on the owner's PC, as a standard user:**
    - `Get-NetConnectionProfile`, `Get-Volume`, `powercfg /query`, `whoami /groups` and `icacls` work; `fsutil fsinfo` is denied.
    - The owner's **Desktop is on OneDrive** (`C:\Users\<you>\OneDrive\Desktop`).
    - `%USERPROFILE%` grants only the user, SYSTEM and Administrators.
    - `C:\` gives Authenticated Users Modify on new subfolders.
14. **Name constraints:**
    - OpenSSL rejects an out-of-scope leaf under a constrained **intermediate** ("permitted subtree violation", measured).
    - Chrome enforces intermediate constraints. RFC 5280 makes constraints on the trust anchor itself optional.
    - Windows CryptoAPI with an untrusted root reports only `UntrustedRoot`, so its behaviour with a trusted root needs a VM test (T-LAN-5b). The owner PC's trust store was not touched.
    - Hence the two-level certificate hierarchy in §3.3.
15. **The Start launcher's `call <nul` wrapper feeds NUL to stdin.** A console `[Y/n]` prompt reads end-of-input at once (opscritic `stdin-test.cmd`). The Start launcher therefore never prompts in the console.
16. **The certificate prototype mints a new CA whenever ANY adapter** (Tailscale, WSL, hotspot, IPv6) is outside the existing CAs: CA#2 to CA#6 in opscritic `vpn-ca.mjs`. The default-route source address (a UDP connect, no packet sent) picked the right one, 192.168.1.50.

---

## 1. Summary for the owner

### What you download and double-click

- **Download:** one zip, `voidswarm-lan-0.6.0-win-x64.zip`, about 36 MB.
- **Once, before unzipping:** right-click the zip → Properties → tick **Unblock** → OK.
- **Where to extract:** your user folder, typed as `%USERPROFILE%` in the Extract box. It becomes `C:\Users\<you>\Voidswarm LAN`. Avoid these:

  | Don't extract to | Why |
  |---|---|
  | Desktop or Documents | they often sync to OneDrive (your Desktop does) |
  | Downloads, Temp, a USB stick | antivirus suspicion, auto-cleanup, or no file permissions |
  | directly under `C:\` | every user of the PC could change the files |

  The launcher refuses these places and says where to move it.
- **Double-click `Start Voidswarm Host.cmd`.** A small black window opens; after the first run it opens minimised. It must stay running.
- **Your browser opens the Host Control Panel** at `http://localhost:7778`.
- **The first time:**
  - the setup code is already filled in;
  - you create the admin login, choose **Home** or **School**, and name the server;
  - then the **Network check** runs. When Windows asks about "Node.js JavaScript Runtime", that is Voidswarm's engine: choose Allow on Private networks.
- **To update:** put the new zip in the folder and double-click `Update Voidswarm.cmd` while the host is stopped. Everything stays the same: data, firewall permission and shortcut. The old version is kept for rollback.

### Your question: "a standalone .exe for the server and web content, or a batch file? What would you suggest?"

**Recommendation: a portable folder with a double-click launcher.** That means neither a single .exe nor a bare batch file.

- **A bare batch file** would need Node.js installed, which school PCs forbid.
- **A single .exe** was built and tested. It matched the folder: 35.5 MB zipped, starts in 0.78 s, uses 60 MB of RAM. The problem is the signature:
  - building it strips Node's digital signature;
  - an unsigned, never-seen .exe is exactly what SmartScreen, Smart App Control, school Defender prevalence rules and Bitdefender block;
  - malware ships the same way (Node single-executable apps; Fortinet, Oct 2025);
  - the fix is paid code signing ($10/month, or $200–700/year) plus reputation-building, and every rebuild resets the reputation.
- **The folder** runs the official, unmodified `node.exe`, signed by the OpenJS Foundation.
  - Our code sits beside it as readable text.
  - IT can allow it with a rule scoped to the teacher and this folder.
  - Updates replace about 4 MB.
- A signed .exe launcher can wrap the same folder later.

### Your question: "Will it have an admin screen with access to the chat?"

**Yes.** It is at `http://localhost:7778`, and only on the host PC unless you allow other devices.

- **It opens on the Home tab:** the join address, a QR code, the rooms and alert counts, with no chat or names. That is safe to show on a projector. **Show on projector** opens a separate page with just the join details and rooms.
- **The Live chat and full Chat log tabs** show what players saw, with a coloured tag per kind of language: PROFANITY, VULGAR, HATE, THREAT, GANG and SELF-HARM (A1).
  - The unfiltered text opens when you click Reveal. Every reveal is recorded.
  - If you have been away for 10 minutes, reveals and the other private views ask for your password again.
- **The other tabs:** per-student Conduct, Rooms, Accounts, Custom terms, Settings (email policy, mail), Server and backups.

### Your question: "Can several different game types run at once, or does each game need its own server?"

**One server runs them all.**
- It holds up to 24 rooms, including the 5 standing house rooms, in any mix of Dungeon Runner, Arena and Warzone.
- Up to 6 can be mid-match at the same time; the rest wait in their lobby.
- Both numbers are settings.

**Practical limit:**
- **Expected:** comfortable for a class of 30–36 on a school PC that is plugged in and wired. A 16-bot match costs 0.28 ms of a 16.7 ms tick on your PC; three full 32-player matches used about 300 MB of RAM.
- **To confirm before release:** a 36-client load test (T-PERF-1), because 36 real clients' snapshot encoding has not been measured.
- **The real limit is Wi-Fi:** about 0.5 Mbit/s per player, so about 18 Mbit/s for 36. Wire the host PC.

### What players do

- They scan the QR code, which opens a start page, and tap **Play (secure)**.
- **School Chromebooks:**
  - If IT pushed the certificate, there is no warning.
  - Otherwise: Advanced → Proceed, about once a week.
- **Phones at home:** install the certificate once, or use the plain-http link. iPhone and iPad must do one of the two.
- A **/check** page tests any device before class.

### What students see in School mode

- **Accounts:** you choose one of two ways.
  - **School email:** a 6-digit code is emailed; they type it in before they can play.
  - **Class roster:** you import the class list and print login slips. No email and no mail server are needed.
- **The notice** at signup and in chat says who can read chat and for how long.
- **Guest play is off**, and the word filter is on its strict setting.
- **When a line is filtered,** everyone else sees a friendly line such as "Great flying, everyone!". The sender gets a private warning that never names the words (A2).
- **Self-harm statements** are withheld, and the student gets a kind note with support information. You get an urgent alert that shows no name until you open it.

---

## 2. Packaging

### 2.1 Folder layout (the zip)

The top-level folder name carries no version.

```
Voidswarm LAN\
  Start Voidswarm Host.cmd            stub: starts runtime\node.exe app\launch.mjs
  Update Voidswarm.cmd                in-place update, or --rollback (host must be stopped)
  Reset admin password.cmd            host PC only; prints a new setup code
  Restore a backup.cmd                lists backups and restores one (host stopped)
  Allow through firewall (admin).cmd  optional; Home = Private, School = Domain + Private
  START HERE.html                     host guide with pictures (unblock, SmartScreen, firewall, Bitdefender)
  FOR SCHOOL IT.txt                   §9.1
  VERSION.txt  SHA256SUMS.txt  THIRD-PARTY-NOTICES.txt
  runtime\node.exe  runtime\LICENSE   official Node 24.x x64, signature intact (92.3 MB)
  app\launch.mjs                      host agent (parent process, §2.2)
  app\server.mjs                      game + accounts + admin server (child process; unminified bundle)
  app\maint.mjs                       DB worker: admin reads, purges, backups, index upkeep (§5.16)
  app\tool.mjs                        maintenance CLI (update, restore, admin-reset, mod commands)
  app\build-info.json                 version, Node version, build date
  app\admin\*  app\display\*  app\landing\*  app\check\*
  web\*                               the game client (vite build), fonts included
  previous\                           the last version's app\ and web\ (and runtime\ if it changed), for rollback
  data\                               everything that is YOURS; ACL-checked (§2.2)
    voidswarm.db                      accounts, chat log, conduct counters, reports, audit, custom terms (SQLite WAL)
    voidswarm.config.json             settings, no secrets
    deletions.jsonl                   deletion ledger (§6.4)
    preflight.json                    cached host checks
    secrets\                          pepper, backup key, pipe key, SMTP password, issuing-CA key and leaf key
                                      (owner, SYSTEM and Administrators only)
    tls\                              root and issuing-CA certificates, and the current leaf
    backups\                          *.vsbak (encrypted, gzip), rotated by age
    exports\                          files from "Save on this PC" (deleted after 7 days)
    logs\                             host-YYYY-MM-DD.log (14 days; no chat text and no names)
```

**Sizes:** about 96 MB unzipped and 36 MB zipped. An update touches `app\` and `web\` (about 3.9 MB) unless the Node runtime changes.

**The `.cmd` stubs** are 8 lines or fewer. Their contract is frozen for 0.6.x (fixed entry points), so an update never rewrites a running stub. They tell these failures apart:

| What the stub finds | What it says |
|---|---|
| `app\` missing | "Unzip the WHOLE folder first" (exit code 1) |
| `app\` present, `runtime\node.exe` missing | "Your antivirus may have removed runtime\node.exe. Check Bitdefender → Protection → Quarantine, then add an exception (START HERE.html)" |
| error 9009, or blocked by policy | "Windows blocked the Voidswarm engine (school policy). Give FOR SCHOOL IT.txt to IT" |

- Only the Start stub uses `call <nul "%~f0" --child`. It suppresses Ctrl+C's "Terminate batch job?" prompt.
- Once `data\voidswarm.config.json` exists, the Start stub relaunches itself in a minimised window (`start "Voidswarm LAN Host" /min`) and closes.

### 2.2 Launcher (parent) and server (child)

**One `node.exe`, two processes:**
- **The parent, `launch.mjs`,** is the *host agent*. It runs every OS integration:
  - read-only PowerShell, `netsh`, `powercfg`, `icacls`, `explorer`, the browser;
  - the console banner;
  - the named-pipe lock;
  - supervising the child.
  - It opens no network port.
- **The child, `server.mjs`,** does everything network-facing.
  - It is started with `--permission --allow-fs-read=<root> --allow-fs-write=<root>\data --allow-worker`: no child processes and no addons.
  - Its stdio is piped to the parent, with an IPC channel. It never writes to the console, so a QuickEdit selection in the console can never freeze a game.
  - Secrets arrive over IPC, never through argv or the environment.
  - The sqlite authorizer closes the gap the permission model leaves (§6.5).

**`launch.mjs`, in order:**

1. **Location.** Paths come from the launcher's own location. It **refuses to start** (both presets) when the root or `data\` is:
   - under `%OneDrive%`, `%OneDriveCommercial%`, `%OneDriveConsumer%`, or a Dropbox, Google Drive or iCloudDrive folder;
   - on a UNC path or a mapped or redirected drive;
   - under `%TEMP%` (including the `Temp1_*` folders Explorer's zip view uses), Downloads or Program Files;
   - read-only, on FAT or exFAT, or on a removable drive (`Get-Volume`, cached).

   The message suggests `%USERPROFILE%\Voidswarm LAN`.
2. **Elevation.** A High-integrity token (`whoami /groups` shows `S-1-16-12288`) means it was started as administrator. School: **refuse**. Home: a warning banner (homes with UAC switched off run everything elevated).
3. **Permissions** (`icacls`, read-only).
   - **The check:** any SID other than the user, SYSTEM and Administrators with write access to the root, `app\`, `runtime\` or the stubs, or with read access to `data\`.
   - **Result:** School refuses to start; Home warns.
   - **One-click fix** (panel, or `--fix-permissions`): `icacls "<root>" /inheritance:r /grant:r "<user>":(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`.
   - `data\secrets\` always gets that ACL when it is created.
4. **Mark-of-the-Web.** It lists files that still carry `:Zone.Identifier` and says "unblock these". It never strips them, because that is itself an antivirus signal.
5. **Single-instance lock: a named pipe,** `\\.\pipe\voidswarm-lan-<first 16 hex of sha256(dataPath)>`.
   - It frees itself on a crash or power loss, so a stale PID can't block the next start.
   - A second launch asks the running host for its panel URL, opens it, and exits with code 0: "Voidswarm is already running — opened the control panel."
   - Pipe commands (`stop`, `reload-admin`, `status`) need `data\secrets\pipe.key`.
6. **Moved data.** `data\MOVED-TO.json` present → refuse: "This data was moved to …\Voidswarm LAN on Oct 3 — start that copy."
7. **Config:** load it, or seed it from the environment (first run only).
8. **Staged work:** apply a staged restore (§6.2), and clean up update leftovers.
9. **Preflight** (cached in `preflight.json`; refreshed at first run, after an update, on a network change, and after 5 minutes with no LAN device):
   - the network category (Public means loopback only);
   - firewall BLOCK rules for this `node.exe` (`netsh`, read-only);
   - the sleep timeouts on AC and battery (`powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`) and the power source;
   - free disk space (`fs.statfs`).
10. **Before listening:**
    - the migration, after an encrypted backup;
    - the FTS `optimize`, if purges ran since the last one (console: "Tidying the chat log index… about 4 s").
11. **Ports.** The game port P (default 7777) and the admin port A = P+1 are chosen once and stored in the config.
    - **Home, first run:** if 7777/7778 is busy, it takes the first free pair up to 7797 and saves it.
    - **School:** it never picks a port by itself. It refuses with the name of the process holding the port (`netstat -ano` + `tasklist`) and "change the port in Settings".
    - **The busy probe** connects to 127.0.0.1:P, [::1]:P and primary:P (anything that answers means busy), then binds. This catches the owner's live server holding only 127.0.0.1:7777.
    - **Advanced option:** "standard ports" (443 plus 80).
12. **Start the child;** pass the secrets over IPC.
13. **Banner and browser:** print the banner (§5.1) and open `http://localhost:A/`. On the first run it opens `http://localhost:A/#setup=K7QP-4MXD`: the fragment is never sent to the server, and the page clears it with `history.replaceState`. `--no-browser` or `network.openBrowser = false` skips this.
14. **Supervise.** If the child exits without being asked, the parent restarts it: at most 3 times in 10 minutes, with a panel banner "The server restarted after an error at 10:14" and one console line.

**Flags:** `--no-browser`, `--data <dir>` (advanced), `--fix-permissions`.

### 2.3 Build script: `npm run package:lan`

`scripts/build-lan.mjs` uses only `node_modules` and the Node that runs it.

1. **Build the client:** `vite build --outDir release/stage/web --emptyOutDir`. It fails on any external URL in the built html, css or manifest.
2. **Bundle with the esbuild JS API** (0.28.2, already installed):
   - entries: `src/server/index.ts` → `app/server.mjs`, `src/lan/launch.ts` → `app/launch.mjs`, `src/lan/tool.ts` → `app/tool.mjs`, `src/server/maint/worker.ts` → `app/maint.mjs`;
   - settings: `platform: node`, `target: node24`, `format: esm`, `minify: false`, `legalComments: 'inline'`;
   - `bufferutil` and `utf-8-validate` stay external;
   - a `createRequire` banner, for ws and nodemailer.
3. **Copy the static pages:** `src/server/moderation/admin/*`, `src/lan/display/*`, `src/lan/landing/*` and `src/lan/check/*`. `adminPageDir` is an option, so tests don't depend on the layout.
4. **Copy the runtime:** `node.exe` from `process.execPath`, after checking:
   - the Node major version is 24;
   - on Windows, `Get-AuthenticodeSignature` is `Valid` with subject OpenJS Foundation.
   - It also copies `scripts/lan/vendor/node-LICENSE` (deps).
5. **Write the text files** from `scripts/lan/templates/`, filling in the version: the stubs, `START HERE.html`, the IT sheet, `THIRD-PARTY-NOTICES.txt`, `VERSION.txt`, `app/build-info.json`.
6. **Zip:** `SHA256SUMS.txt`, then Windows `tar -a -c -f` → `release/voidswarm-lan-0.6.0-win-x64.zip` plus its `.sha256`. The top-level folder is `Voidswarm LAN\`.
7. **Gitignore** `/release/`, anchored.
8. **Runtime policy:** rebuild the zip on every Node 24 security release. The Server panel shows the runtime version and the build date. There is no update check (offline by design).

### 2.4 Secrets without DPAPI

**What:** everything secret lives in `data\secrets\`:
- `pepper.key` and `backup.key` (32 random bytes each);
- `pipe.key`;
- `smtp.secret`;
- `tls\issuing.key` and `tls\leaf.key`.

**How it is protected:**
- the enforced ACL (owner, SYSTEM, Administrators), checked at every start;
- the IT sheet's advice: BitLocker and a Windows password on the host PC.

**Why DPAPI was dropped:**
1. On managed school PCs, PowerShell runs in Constrained Language Mode and blocks the DPAPI route, so the fallback would be the school norm.
2. node.exe → powershell.exe → ProtectedData at every start matches infostealer patterns in EDR and Bitdefender ATD.
3. It adds nothing that the ACL doesn't: another user of the PC is stopped by the ACL, and malware running as the teacher can call DPAPI anyway.

**Reimage or new PC:** the recovery file (§6.3) covers it. The root CA's key never exists on disk (§3.3).

### 2.5 Update, rollback and moving

**`Update Voidswarm.cmd`** runs `tool update`. The tool stubs read the console normally; they don't use `call <nul`.
1. It checks the host is stopped (the pipe).
2. It finds the newest `voidswarm-lan-*.zip` in the folder or in `updates\`.
3. It shows the version and SHA-256, and compares them automatically with a `.sha256` file placed beside the zip. Then it asks Y/N.
4. It makes an encrypted backup, `pre-update-<version>`.
5. It extracts with Windows `tar -xf` into `update.staging\`, then checks `SHA256SUMS` and the `node.exe` signature.
6. It moves `app\` and `web\` into `previous\` and puts the new ones in. If the runtime changed, the stub swaps `runtime\` after node exits.
7. The data, folder path, firewall rule, AppLocker path rule, Bitdefender rule and desktop shortcut are all unchanged.

**Rollback** (`Update Voidswarm.cmd --rollback`) restores `previous\`. If the newer version migrated the DB, it restores the pre-update backup after a confirmation, then re-applies the deletion ledger (§6.4).

**Moving to another folder or PC:**
- The new copy's first-run page offers **Bring in data from another copy**:
  - a list of `…\Voidswarm LAN*\data` folders found next to it or in the profile;
  - a path you type;
  - or a backup plus its recovery file.
- The data is treated as untrusted (§6.5). Afterwards the source gets `data\MOVED-TO.json`.
- This replaces the draft's console prompt, which could never read an answer (fact 15).

---

## 3. Networking and HTTPS

### 3.1 Listeners and the primary address

**Primary address:**
- It is the source IPv4 of the default route, found with a UDP connect to 192.0.2.1:9 (no packet is sent).
- It is accepted only if it is private (RFC 1918): 10/8, 172.16/12 or 192.168/16.
- It is never 100.64/10 (Tailscale or carrier-grade NAT), 169.254/16 or IPv6.
- Fallback: the first RFC 1918 address on an adapter that is up.
- Settings → Network → **Serve on adapter** pins one.

**Game listener:** TCP P on the primary address, plus 127.0.0.1 and ::1.
- It is **not** bound to 0.0.0.0, so VPN, WSL, hotspot and other adapters are never served.
- The front door reads the first byte of each connection: `0x16` goes to TLS, anything else to http.
- **Limits:**
  - `tls` `handshakeTimeout` 10 s;
  - a socket that sends nothing for 10 s is closed;
  - `maxConnections` 1,024;
  - a per-address socket cap of 128 before the upgrade;
  - then the existing ws `ConnectionGate` (scaled in School, §4.14).

**Admin listener:** TCP A.
- It is always on 127.0.0.1 and ::1, over plain http.
- It is also on the primary address, **over https only**, while `admin.remoteAccess` is not `off`.
- It is a separate origin from the game, so nothing that runs on the game origin can read an admin session.

**When the game listener stays on loopback only:**
- **Before first-run setup.** The banner says "Players can join after setup".
- **On a Public network, or a new network nobody has approved.** The panel asks:
  - Home: "New network 10.20.0.0/16 ('District-Guest'): serve players here?"
  - School: "This network is outside the certificate — ask IT."

**Network watch (every 30 s):** only a change of the PRIMARY address counts. Adapters coming and going are ignored. On a change it:
1. re-binds the game listener (existing sockets stay);
2. re-issues the leaf certificate if the new address is inside the scope (§3.3);
3. updates the QR code and URLs;
4. shows a panel banner and prints one console line.

**The VPS and `npm start`** (`lan: false`):
- the binding is today's (`BIND`, `TRUST_PROXY`);
- there is no admin listener: `/admin` stays on the main port behind Caddy, with the host role (§4.10).

### 3.2 What each address serves

**Game listener:**

| Request | `http://<primary>:P` | `https://<primary>:P` | `http://localhost:P` |
|---|---|---|---|
| `/` | **landing page** (§3.4) | game | game |
| `/play` | game over plain http (guests only when `signInOverHttp = block`) | game | game |
| `/check` | device check | device check | device check |
| `/ca.crt` (PEM), `/ca.cer` (DER), `/ca.mobileconfig` | the root certificate | same | same |
| `/api/*` (accounts) | endpoints that carry a credential or token follow `signInOverHttp` | yes | yes |
| `/admin` | a page: "The control panel is on the host PC" | same | same, with a link to `http://localhost:A` |
| WebSocket | `ws` | `wss` | `ws` |

**Admin listener:**
- `/` is the panel (login, setup, reauth);
- `/display` is the projector page: loopback only, no login;
- `/api/admin/*` is the API.

**Rules:**
- **Host allowlist, per listener.**
  - Game: the primary IP, the computer name, `<name>.local`, IT's extra names, and localhost/127.0.0.1/[::1], each with `:P`.
  - Admin: localhost/127.0.0.1/[::1] with `:A`, plus the primary address and IT names with `:A` while remote access is on.
  - Anything else gets **421**.
- **Origin.**
  - POSTs and ws upgrades must carry an Origin equal to the listener's own origin; otherwise **403**.
  - Dev mode (`npm run dev`) keeps today's CORS list, but the LAN edition and the admin API never use CORS.
  - A ws with no Origin is accepted only from a loopback socket (tools such as smoke), and never with host-PC rights.
- **Proxies and tunnels.**
  - A request from a **loopback** socket that carries any forwarding header means a tunnel or a local reverse proxy. The headers: `Forwarded`, `X-Forwarded-*`, `Via`, `CF-*`, `X-Real-IP`, `True-Client-IP`. It gets **403**: "This classroom server can't be used through a tunnel — the VPS kit is for online play."
  - From a **LAN** socket it is probably a school proxy. It is served but flagged on the panel ("Requests arrive through a proxy — ask IT to send <ip> DIRECT"), and the header is never trusted for the client address.
  - The admin listener refuses any forwarding header.
- **`isHostPc(req)`** is true only when all of these hold:
  - the request arrived on the admin listener's loopback binding;
  - the socket is loopback;
  - Host is `localhost`, `127.0.0.1` or `[::1]` with `:A`;
  - no forwarding header is present;
  - `TRUST_PROXY` is off.

  It gates every host-PC-only rule. The game port's only host-PC rule (guest play labelled "Host PC" while guests are off) uses the same test with `:P` and a same-origin Origin.
- **Refused combinations.** The launcher refuses to start with `TRUST_PROXY` set or a non-LAN `PUBLIC_URL` ("that is the VPS kit").
- **No HSTS and no `upgrade-insecure-requests`.** Either would break the http fallback.

### 3.3 Certificates (two-level hierarchy)

**Root CA:**
- ECDSA P-256, valid 10 years, pathLen 1, **no name constraints**.
- Its private key is generated in memory, used once to sign the issuing CA, and discarded. It is never written anywhere.

**Issuing CA:**
- pathLen 0, keyCertSign, with **critical name constraints**.
- It signs every leaf. Its key is kept in `data\secrets\tls\`.
- RFC 5280 requires validators to enforce constraints on intermediates; only constraints on the trust anchor itself are optional. So on any conforming platform, a stolen issuing key can mint certificates only for the permitted names.
- **Verified:** OpenSSL (measured, T-LAN-5). **To verify:** Windows CryptoAPI and iOS, on a VM or test device (T-LAN-5b), before `START HERE.html` tells Windows or iOS users to install the root. Chrome enforces intermediate constraints.
- This replaces "destroy the CA key after issuing the leaf". It bounds a key theft the same way, and silent leaf renewal still works.

**Scope,** chosen when a root is created:
- **"This PC's address only":** the primary address as a /32. School default; it needs a DHCP reservation.
- **"This network":** the primary address's /24, or the adapter mask if that is narrower. Home default.
- Always added: 127.0.0.1/32, ::1/128, DNS `localhost`, `<host>`, `<host>.local`, and IT's extra names as exact names (never a whole domain).

**Leaf:**
- P-256, serverAuth, valid 397 days.
- SAN: `localhost`, `<host>`, `<host>.local`, the IT names, 127.0.0.1, ::1 and the primary IPv4 address.
- It is served together with the issuing CA.
- It is re-issued, hot-swapped with `setSecureContext`, only when fewer than 30 days remain or the primary address or names change inside the scope.

**New root:**
- **Home:** only when the host approves a new network outside every existing scope (the panel asks).
- **School:** never automatically. The panel says "This PC's address (10.20.31.77) is outside the certificate. Ask IT to reserve the address, or press New certificate and ask IT to push it."
- Old roots stay as retired records, certificates only.

**New certificate** (host PC only) makes a new root and issuing CA, and deletes the old issuing key.

**Use my own certificate** (PEM, or PFX with its key; host PC only):
- For example the district's certificate for `voidswarm.caldwellschools.org`, with an internal DNS record.
- There is no root to push and no warning. The canonical origin becomes that name, and the Host allowlist adds it.

**Fingerprint:**
- The root's SHA-256 is shown on the panel Home tab, on `/display` and in the console banner.
- The landing page says "Compare with the fingerprint on your teacher's screen". It never offers its own copy as proof: the landing page is http, so an attacker could change both.

**Incident plan** (IT sheet): the host is lost or compromised → remove the root from the OU and the devices → New certificate.

### 3.4 Canonical origin, landing page and device check

**Canonical origin:** `https://<primary>:P`, or the IT hostname.

**The QR code and the Join card** carry one URL:
- **By default:** the http landing page `http://<primary>:P/`. An iPhone that clicked through a warning reportedly breaks `wss`, so the landing page is where it can choose.
- **With `network.devicesTrustCert` on** ("devices here trust this server's certificate: IT pushed it, or it's my own certificate"): the https URL. The same setting turns on a 302 from http to https for LAN requests, except `/ca.*` and `/check`.

**Landing page** (plain HTML, no scripts needed, `app\landing\`):
- A big **Play (secure)** link.
- **School Chromebook**, listed first: "If you see a warning, click Advanced → Proceed. Your school handles certificates."
- **Your own device, install once:**
  - Android: Settings → Security → Install a certificate → CA certificate (`/ca.cer`).
  - ChromeOS, when not managed: `chrome://certificate-manager` → Import (`/ca.crt`).
  - Windows and iPhone: steps shown only after T-LAN-5b passes.
- **iPhone and iPad:** install the profile, or use the plain link.
- The fingerprint-compare line, the server name and the version.
- **Play without the certificate (http)**, with the note: "Keyboard, touch and controllers work; your password would cross the network unencrypted." In School it is guests only.

**`/check`** (no login; http and https) tests:
- the page over http;
- whether the secure address is reachable (an image probe);
- `wss` and `ws` connections;
- whether the Gamepad API is present;
- the clock offset;
- a proxy (the server echoes whether `Via` or `X-Forwarded-For` arrived).

Each failure has a plain-language fix, for example "Secure WebSocket blocked — your web filter or proxy; show FOR SCHOOL IT.txt §Network". The results (browser family and pass or fail per test, nothing identifying) post to the host: "Device checks today: 27 passed, 3 failed secure WebSocket".

**In the client:**
- If `wss` fails on iOS after a click-through, it shows "On iPhone/iPad use the plain link or install the certificate", with both links.
- Guests are told that cosmetics belong to the address they use: each origin has its own storage.

### 3.5 Firewall, Bitdefender and the first-device check

- **First-run Network check step,** shown before the Windows prompt appears: "Windows may ask about **Node.js JavaScript Runtime** — that is Voidswarm's engine. Choose Allow on **Private** networks." `START HERE.html` has a picture of it.
- **Read-only checks by the parent:**
  - `Get-NetConnectionProfile`: on Public, "Other devices can't connect: set this network to Private";
  - `netsh advfirewall firewall show rule name=all verbose`: BLOCK rules for this `node.exe` path (clicking Cancel on the prompt records one);
  - `netsh advfirewall show currentprofile`: policy that ignores local rules.
- **`Allow through firewall (admin).cmd`:**
  1. removes Voidswarm rules for folders that no longer exist, and any BLOCK rule for this path;
  2. asks Home (Private) or School (Domain + Private);
  3. adds a program rule with **no port** (so a port change doesn't break it);
  4. if policy ignores local rules, it says "IT must add this rule (FOR SCHOOL IT.txt)".

  Run it only after the permission check (§2.2) passes, never from a folder other users can write.
- **Bitdefender** (the owner's firewall): allow `runtime\node.exe` under Protection → Firewall → Rules (Home/Office), plus an Advanced Threat Defense exception if it is ever flagged.
- **The panel shows:**
  - "First device connected ✓ 10:02 (192.168.50.31)";
  - or, after 5 minutes with none: "No other device has reached this PC yet". The troubleshooter covers the network profile, the firewall rule, AP isolation and guest Wi-Fi, being on the same Wi-Fi, and `/check`.
- **School PCs** use the Domain profile, set by GPO, so IT must add the rule (§9.1).

### 3.6 What works over plain http as a fallback

| Feature | https, root trusted (or own certificate) | https, click-through | http on the LAN address | http://localhost |
|---|---|---|---|---|
| Keyboard, mouse, touch | yes | yes | yes | yes |
| Controllers | yes | yes | yes on current Chrome, Edge, Firefox 125+ and Safari (desktop measured; phones in T-REL-3); no on Firefox 81–124 | yes |
| Sign-in | encrypted | encrypted against passive sniffing only | **clear text**: School blocks it, Home warns | local only |
| iPhone/iPad WebSocket | yes | reported broken | yes (`ws`) | – |
| Host Control Panel | remote `full` or `limited` (§5.2) | remote `limited` only | never | yes (admin port) |

**Client wording fix:** `PAD_PROMPT_NO_API` (`mobile.ts:89`) becomes *"This browser can't read controllers here. Try Chrome or Edge, or open the secure address."* It is shown only when `getGamepads` is missing, and it suggests https only when `!isSecureContext`.

### 3.7 Client server address and reconnect

- **Address bug:** `defaultServerUrl` (`serverUrl.ts:34-40`) dials `ws://host:7777` unless the page is on port 7777. That breaks on 7779 and on https.
  - New rule: Vite dev and preview pages (ports 5173 and 4173) keep `ws://<hostname>:7777`, and the Pages build keeps its rule.
  - **Everything else uses the page's own origin:** `(https ? 'wss' : 'ws') + '://' + location.host`.
  - `resetServerUrl` (`main.ts:181`) and `serverUrl.test.ts:37` change the same way.
- **Unexpected close:** the client retries for 60 s, showing "Lost the host PC (asleep, stopped or moved) — tell your teacher".
- **Planned restart** (a restore or a port change): the server sends the close reason "Server restarting — back in about 20 s".

### 3.8 Host sleep and power

- **Preflight** (§2.2 step 9) warns: "This PC sleeps after 15 minutes on battery. Plug it in and set Sleep to Never while hosting; don't close the lid."
- **Wake lock:** the panel page is on localhost, which is a secure context, so it holds a Screen Wake Lock while visible. T-REL-4 checks whether that also stops idle sleep on Windows.
- **Resume detection:** a wall-clock gap of more than 30 s in the tick loop is logged, and the panel shows "The host PC was asleep 10:14–10:31; players were disconnected."
- **The README** says: plugged in, the "Best performance" power mode, and Win+L when stepping away (the game keeps running while the PC is locked).

---

## 4. Accounts on the LAN

### 4.1 Three kinds of identity

| Identity | Stored in | Plays | Opens the panel | Created by |
|---|---|---|---|---|
| **Player account** | `accounts` | once `active` | no | signup, or the host's roster import (§4.12) |
| **Moderator** (a player account with a flag and a server-wide tier, §5.2) | `admins` | yes | only the Moderator view, and only if the host enables it (off by default) | the host (Accounts tab) |
| **Host admin** | `host_admins` | **no** (not a game account) | the full panel | first-run setup on the host PC, or `admin-set` on a VPS |

- The host admin is separate from game accounts, so no student can ever become admin through the game.
- The host admin's username, and the names `Host`, `Host PC`, `Teacher`, `Admin`, `Moderator`, `System` and `Server`, are **reserved**, together with their look-alikes (`isReservedLookalike`, `Zone.ts:456`). That covers both accounts and guest callsigns.

### 4.2 Account policy (a server setting)

It lives in the Settings panel, stored in `voidswarm.config.json` under `accounts`. Environment variables seed it on first run, including on a VPS.

| Setting | Values | Home default | School default | Env seed |
|---|---|---|---|---|
| `signup` | `open` / `rosterOnly` | `open` | `open` (you pick roster in setup) | `ACCOUNT_SIGNUP` |
| `email` | `optional` / `required` | `optional` | `optional` until mail works | `ACCOUNT_EMAIL` |
| `domains` | list of `{ domain, subdomains }` (empty = any) | `[]` | `[]` | `ACCOUNT_EMAIL_DOMAINS=caldwellschools.org,*.caldwellschools.org` |
| verification | **always on when `required`** (not a switch) | – | – | – |
| `hostApproval` | an extra step after the code | off | off | `ACCOUNT_APPROVAL=1` |
| `allowGuests` | on / off | on | **off** with required + domains, or with `rosterOnly` | `ALLOW_GUESTS` |
| `existingAccounts` | `grandfather` / `verifyAtNextLogin` | `verifyAtNextLogin` | same | – |
| `emailStorage` | `full` / `hashOnly` (§4.9) | `full` | `full` (open question 3) | `EMAIL_STORAGE` |
| `selfServiceReset` | email reset links (needs mail and a verified email) | on when mail works | same | – |
| `selfDelete` | on / off | on | **off** (it would destroy conduct records) | – |
| `signInOverHttp` | `allow` / `warn` / `block` | `warn` | **`block`** | – |
| `sessionHours` | game-session lifetime | 720 (30 days) | **12** | – |
| `sessionStore` | default for the "Public computer" box | `local` | **`session`** (ticked) | – |

- **Switching to `required` is refused** until a test email has succeeded with the current mail settings (§4.7). An env-seeded `required` without working mail logs a loud warning and falls back to `optional`.
- **`rosterOnly`:** `/api/register` answers 403 "Ask your teacher for a login slip."
- **VPS:** if `ACCOUNT_EMAIL` is unset, the seed is `optional` and the server logs a notice. `docs/DEPLOY-VPS.md` tells operators to set `required` together with SMTP.

### 4.3 Domain matching rules

This is the pure module `src/server/auth/emailPolicy.ts`.

- **Parsing:**
  - trim, Unicode NFC, and split at the **last** `@`;
  - total length at most 254, local part 1–64;
  - reject quoted local parts, comments, IP-literal domains, empty labels and a trailing dot.
- **Case:** the domain is compared lowercase. The local part is compared case-insensitively for uniqueness, but mail goes to the address exactly as typed.
- **IDN:** the domain goes through `url.domainToASCII()`; an empty result means invalid. The allowlist is stored in ASCII and shown with `domainToUnicode()`.
- **Look-alikes:** a Cyrillic look-alike becomes `xn--…`, which never equals the ASCII entry. With an allowlist set, confusable or mixed-script domains get the specific error.
- **Exact vs subdomain:** `domain === allowed`, or, only when `subdomains` is on, `domain.endsWith('.' + allowed)`. The match is always at a label boundary.
- **ASCII local part** is required when an allowlist is set.
- **Plus-addressing:** `email_key` drops `+tag`, so `jdoe+x@` and `jdoe@` are ONE email. Dots are kept, except in the key for `gmail.com` and `googlemail.com`.
- **The domain editor** warns when a second domain is added: "Allowing an alias domain lets one student verify several accounts. Most schools need only the student domain."
- **Error texts:** *"Use your @caldwellschools.org email address."* With several domains: *"Use your school email (@a.org or @b.org)."*

### 4.4 Verification modes and the offline alternative

**(a) Email code.** A 6-digit code sent through SMTP, **always on when email is Required** (owner decision).

**(b) Host approval.** An optional extra step after the code, never instead of it (owner decision).

**(c) Both** is Required with approval turned on.

**(d) A domain check alone** is not offered. Anyone can type a made-up address at the school domain.

**(e) Class roster accounts** (§4.12) are the answer for districts without working mail.
- The teacher assigns every username and hands out login slips, so a person is identified without email.
- That serves the owner's accountability purpose, with guests off.

**Why not "Sign in with Google" restricted to the domain:**
- Google OAuth web redirect URIs must be https with a public domain. Raw IP addresses and `.local` names are refused (localhost is the only exception).
- The device-code flow avoids redirects, but still needs a Google Cloud client, internet on the host, and the Workspace admin's approval for under-18 users.
- It becomes possible with **Use my own certificate** plus a real district hostname (§3.3) and an app registered by IT.

### 4.5 Account states and server-side enforcement

**States:** `accounts.status` ∈ `active` | `verify` | `approval` | `disabled`.
- A roster account is `active` with `roster = 1`. Until its first-login code is used, nobody knows its password.

**Enforcement on the server:**
- **The ws `hello`** calls `auth.sessionState(token)`:
  - `verify` → kicked: "Enter the code we emailed you first";
  - `approval` → kicked: "Waiting for your teacher to approve your account";
  - a pending account **never** falls back to guest play.
- **With guests off,** a hello without an active account is kicked: "This server needs an account — sign in or create one." Only `isHostPc` (the "Host PC" guest) is exempt.
- **In School,** a token sent over plain `ws` from a LAN address is refused (§4.10).
- **`verifyToken()`** returns null for accounts that aren't active.

**A pending session may call only:** `/api/me`, `/api/verify`, `/api/verify/resend`, `/api/account/email` and `/api/logout`.

**`disabled`:** the message "This account is switched off — ask your teacher" is sent **only after the password verifies**, as `signInBlocked` does today, so it can't be used to learn which usernames were disabled.

### 4.6 Verification codes

- **Format:** 6 digits from `crypto.randomInt`.
- **Storage:** `sha256(pepper ‖ accountId ‖ code)`. It lasts 15 minutes and works once.
- **Attempts:**
  - 5 per code;
  - 10 failures per hour per account locks verification for 1 h (audited `verify-lockout`);
  - 60 per 10 minutes per address;
  - **20 failures per day per `email_key`** locks that email for 24 h and raises a host banner. This stops guessing by repeatedly replacing a pending account.
- **Resend:**
  - a 60 s cooldown;
  - 5 per hour per account, and 5 per hour per `email_key`;
  - per address: 30 per hour at Home, **120 per hour** in School or when a shared address is detected (§4.14);
  - 300 per hour for the whole server.
- **Changing the email always re-verifies.** The old verified email stays until the new one is confirmed.
- **Squatting:**
  - an unverified account is deleted after 24 h;
  - a new signup may replace a pending account older than 30 minutes;
  - younger than that, the answer is the generic "That username or email can't be used."

### 4.7 Mail (SMTP) setup: Settings panel → Mail

**Presets, in this order:**
1. **District SMTP relay, or a dedicated no-reply mailbox** (recommended). Examples: the Workspace relay `smtp-relay.gmail.com:587` (Gmail → Routing → SMTP relay, allowlisting the school's public IP), or the district's own relay.
2. **Google Workspace app password:** `smtp.gmail.com:587` with STARTTLS. It shows the warning: *"An app password also opens the whole mailbox (IMAP). Don't use your own teacher account; ask IT for a no-reply mailbox."*
3. **Microsoft 365:** `smtp.office365.com:587` with SMTP AUTH, which Microsoft is retiring. If it is off in your tenant, use the relay.
4. **Generic:** host, port, security, user, password, From. "None" is allowed only to a private-address relay, and never with a password.

**Note in the panel:** *"Send from a @caldwellschools.org address — student mailboxes often accept only mail from inside the school."*

**The password:**
- write-only: the panel shows only "password saved";
- stored in `data\secrets\smtp.secret`;
- never in the config file, backups (other than the recovery file, §6.3), exports or logs;
- `SMTP_PASS` from the environment still works on a VPS.

**Send test email** (`smtp/test`, 5 per minute):
- It sends the verification template with code `000000`, to the host's address or to a student test mailbox from IT.
- Errors in plain language:

  | Error | Message |
  |---|---|
  | `EAUTH` | "The mail server rejected the username or password (for Gmail use an app password)." |
  | `ECONNECTION` / `ETIMEDOUT` | "Could not reach smtp.gmail.com:587 — the network may block outgoing mail; ask IT, or try port 465." |
  | TLS errors | "The secure connection to the mail server failed." |
  | `EENVELOPE` | "The mail server refused the From address." |

- Success is saved as `mail.lastTest`. Required stays locked until a test succeeds with the current settings.

**When mail fails later:**
- Signup still creates the pending account but answers `503 { mail: 'failed' }`. The screen says "The verification email could not be sent — ask your teacher", with a Resend button.
- The panel shows the banner "Mail is failing: <error> — 7 failed sends in the last hour."
- The escape hatches: switch the account policy to Optional (audited), or use roster accounts.

**Verification email** (PG; plain text plus simple HTML):
- Subject: "Your Voidswarm code for Room 136 – Mr. O'Brien".
- Body: the name, the code, "type it within 15 minutes; it works once", "a classroom game run by your teacher on the school network; chat is filtered and logged", and "if you didn't sign up, ignore this email".

**Host alert emails** (optional; `alerts.email`) are **content-free**: "An urgent alert is waiting on the Voidswarm host panel (Room 136)." They never include a name, text or tag.

### 4.8 Existing accounts when the policy changes

- **`grandfather`:** accounts without a verified in-policy email keep playing. They see a banner, "Add your school email", and are marked `legacy`.
- **`verifyAtNextLogin`** (default): such accounts move to `verify` (purpose `relogin`) at their next login or reconnect.
  - Live matches are not interrupted.
  - **Apply now** signs them out immediately (audited).
- **Tightening the domain list** treats newly out-of-policy accounts the same way.
- **Required → Optional:** waiting signups become `active` after a warning ("12 waiting accounts will be able to play"). Their unverified emails can't receive reset links.
- **Turning approval off:** the panel asks "Approve all 5 waiting accounts?"

### 4.9 Student email privacy (FERPA-style minimisation)

- **Full addresses: the host admin only.**
  - Players see their own address masked (`n***@caldwellschools.org`); an email-less account gets `''`.
  - Moderators never see emails, whether in `whois`, Live, reports or in-game commands.
- **Host screens:**
  - the Accounts list and the Conduct summary mask addresses;
  - **Show** reveals one address; it is a sensitive action (§5.2), audited `reveal-email`;
  - the per-student Conduct header shows the address, and viewing it is audited.
- **`emailStorage = 'hashOnly'`:**
  - after verification, the address is replaced by `email_hash = HMAC(pepper, email_key)` plus `email_hint`;
  - uniqueness and "find by email" still work;
  - self-service reset mail becomes impossible (host reset codes still work).
  - The pepper is in the recovery file, so a restore on a new PC keeps lookups working.
- **No email:** Optional mode stores `email = ''` and `email_lower = '#none:<id>'`. The sentinel has no `@`, so login-by-email and `forgot` can never match it. No table rebuild is needed.

### 4.10 Host admin credential, sessions and remote access

**First-run setup:**
- `/` on the admin listener shows **Create the host admin login** while `host_admins` has no usable password.
- It is served only when `isHostPc`, with a same-origin Origin. Remote devices get 403 "Setup only works on the host PC". `setup/status` answers the host PC only.
- The launcher opens the page with the **setup code in the URL fragment**, so nothing needs typing. The code is also in the console banner as a fallback.
  - 8 characters of Crockford base32, stored as a hash, valid 30 minutes.
  - After 5 wrong tries the code is void, and setup waits 60 s, doubling up to 15 minutes. Restarting the launcher (proof of presence) prints a fresh code and clears the wait.
- The form asks for username, password and confirm; **Home** or **School**; the server name; and, in School, **Email verification** or **Class roster**.
- Then the Network check (§3.5), then **Create a recovery file** (§6.3; it can be skipped, with a banner until done).

**Password rules:** 10–128 characters, not the username or the server name. scrypt with the account parameters (N=2^15, r=8, p=3).

**Sessions:**
- 32 random bytes, stored as sha256 in `admin_sessions`, together with `address`, `via` (`local`, `https` or `proxy`), `last_action` and `reauth_at`.
- The token travels as `Authorization: Bearer` and is kept in the admin origin's `sessionStorage`. A session only works from the address and route that created it.
- **Idle timeout** 30 minutes (setting 5–240). **Absolute limit** 12 h. At most 5 sessions per principal; all are revoked on a password change or reset. Explicit Sign out.
- **Step-up:** a *sensitive* capability (★ in §5.2) needs the password within the last 10 minutes of *deliberate* activity (setting 5–30). Otherwise it answers **401 `reauth`**, and the panel asks for the password in place.
- **`admin.liveKeepsAlive`** (localhost only; default on): an open Live view keeps the session alive for **at most 3 h**. It never refreshes step-up freshness.
- **Moderator sessions** (`mod:<accountId>`) are revoked on demote, disable, delete or ban, and the moderator flag is re-checked on every call.

**CSRF:** the token is in a header, never a cookie. Plus the Host and Origin rules (§3.2), `Content-Type: application/json` only (415 otherwise), `rev` on settings, and `confirm` fields on destructive calls.

**Login throttle:**
- 5 failures per 10 minutes per address blocks that address for 15 minutes (429).
- 30 remote failures per hour disables remote admin login for 1 h, with a banner.
- **The host PC is never locked out by LAN attempts.** On the host PC itself: 5 failures means a 60 s wait, doubling up to 15 minutes.
- The host-PC admin login has its **own scrypt lane**, so a LAN login flood can't delay it.
- Every login, failure and logout is audited.

**Remote access:** `admin.remoteAccess = 'off' | 'limited' | 'full'`. LAN default `off`.
- **`limited`** (https only): Live (shown text), Rooms, Reports, announcements, and mute, kick and warn. It exists for a teacher's own Chromebook that clicked through the warning.
- **`full`**: everything except the host-PC-only controls (Stop, restore, recovery file, New certificate, own certificate, open folders, update). It is allowed only when the TLS is one the devices really trust:
  - on the LAN, when `network.devicesTrustCert` is on (IT-pushed root, or your own certificate);
  - on a VPS, a public certificate behind a trusted proxy.

  After a click-through, a man in the middle could capture the admin session, so click-through remote sessions never get more than `limited`.

**Forgot the admin password:** `Reset admin password.cmd` (host PC desktop). It works whether or not the host is running:
1. clears the password hash (the row and its audit history stay);
2. revokes the admin sessions;
3. tells a running host over the pipe;
4. prints a new setup code.

**VPS parity:**
- `npm run mod -- admin-set <username>`: hidden TTY input or `--password-stdin`. `admin-reset` works the same.
- The `sudo voidswarm-mod` wrapper lives in `deploy/vps/`, owned by the deploy builder.
- There is no "host PC" on a VPS: Stop, restore and update are CLI or systemd only.
- `ADMIN_REMOTE` seeds `full` when `TRUST_PROXY` is set with an https `PUBLIC_URL`.
- Upgraded VPS data that already has moderators seeds `moderatorView = true`, `moderatorLogSearch = true` and `moderators.tier = 'trusted'`, so today's moderators keep their tools.
- Until `admin-set` runs, the panel says "No host admin yet — run `voidswarm-mod admin-set <name>`."

### 4.11 Host password resets with one-time codes

- **Accounts → Reset password** gives an 8-character code.
  - It is shown once, in a dialog that says **"Show this privately or write it down — don't read it aloud."**
  - It lasts **10 minutes**, works once, and allows 5 attempts. It is stored hashed in `reset_codes`, audited `account-reset`.
  - In Required mode the host may instead **Send the code to the student's verified email**.
- **The student** chooses "I have a reset code from my teacher", then enters username, code and new password (`POST /api/reset/code`).
  - That reuses the atomic `store.completeReset`: set the password, revoke all sessions, lift the lock, kick live sessions.
- **The dev mailer is disabled in the LAN edition:** no reset link ever goes to the console.
  - `forgot` answers generically: "If that account has a verified email, a link is on its way. No email? Ask your host for a reset code."
- **Reset links** use `PUBLIC_URL = <canonical origin>` and follow address changes.

### 4.12 Class roster accounts (School; no email needed)

- **Accounts → Import roster:** paste or upload CSV with the columns `display name, username`, username optional.
  - Usernames are suggested as `firstname + initial + digits`, checked against the name filter and the reserved names.
  - A dry run comes first.
- **Each account is created `active` with `roster = 1`:**
  - it gets a random, unknowable password;
  - it gets a **first-login code** (`reset_codes`, purpose `first-login`), valid **14 days** or until used.
- **Print login slips:** a print view, one slip per student, with server name, address, username, code and "Keep this private".
  - Reprinting a slip replaces the code.
  - The display names are only on the paper and in the host's list, never stored in game data.
- **At first login** the student types username and code, then chooses a password (the same flow as §4.11).
- **Pairs with:**
  - `signup = rosterOnly` and guests off: every person is someone the teacher assigned;
  - `emailStorage` doesn't matter: no email is stored.

  Email can still be added later for self-service reset.

### 4.13 Account management and deletion (host admin)

- **List and search** by username, callsign, or email (host only). Status filters: active, verify, approval, disabled, locked, moderators, legacy, roster, email conflict. Sorting by created, last login or username.
- **Actions:**
  - approve or reject;
  - **unlock**;
  - enable or disable;
  - a reset code, or a reprinted slip;
  - promote or demote a moderator (audited);
  - **sign out everywhere**;
  - delete;
  - export.
- **Delete** requires typing the username (sensitive, §5.2). It offers two choices:
  - **Delete records:** removes their chat lines (including tags, counters and reviews), the reports **they filed and the reports about them**, bans and mutes, and review marks.
    - Audit rows where they are the target *or the actor* get anonymised ids.
    - Audit `reason` text that contains the username is scrubbed.
    - Optional tick: "also guest-era lines under the same callsign from addresses this account used", with a count preview.
  - **Pseudonymise:** keeps the lines for room context under "Former player #N", with `original` removed (shown text only).
  - **Either way:**
    - the account row, sessions, codes, known devices and loot are deleted (cascade);
    - the id goes into the deletion ledger (§6.4);
    - exports that mention them are listed (`data\exports\` files are deleted after 7 days anyway);
    - the dialog says backups keep a copy for at most 35 days.
- **Export:** CSV or JSON of accounts (sensitive; emails only if ticked), with a FERPA warning, through the shared CSV writer (§5.5).
- **Where it runs:** all account operations run inside the AuthService, through the new `AuthAdmin` seam. The in-memory `usernames` Set (`service.ts:141`) therefore never goes stale.

### 4.14 Rate limits tuned for a classroom

**The reality:**
- The LAN edition serves IPv4 on the primary address, so each Chromebook usually has its own address.
- A whole class shares one address only behind NAT or a filter proxy.
- The server counts distinct accounts per address. **More than 8 in 10 minutes** switches that address to the *scaled* limits and raises a banner.

| Limit | Today | Home | School, or a shared address detected |
|---|---|---|---|
| register per address | 5 / h | 30 / h | **120 / h** |
| login per address | 10 / 10 min | 60 / 10 min | **180 / 10 min** |
| failed login per (address, login) | 5 | 5 | 5 |
| failed login per account | 10 / 15 min lock | 10 / 15 min lock, from **unknown devices** only | same |
| failed login per (account, known device) | – | 10 / 15 min | same |
| forgot per address / per email | 5 / h, 3 / h | same | same |
| reset / roster-code attempts | – | 5 per code | 5 per code |
| verification sends per address | – | 30 / h | **120 / h** |
| ws connections per address / total | 64 / 512 | 64 / 512 | **128** / 512 |
| sockets per address before upgrade | – | 128 | 128 |
| rooms per address | 6 | 3 | 6 |
| scrypt at once | 2 | `clamp(cores/4, 2, 4)`, `UV_THREADPOOL_SIZE=6` | same, plus the host-PC admin lane |

**Known devices:**
- A random 128-bit device id is kept in `localStorage` (`voidswarm.device`), even in "Public computer" mode, because it identifies the machine, not the person.
- The server stores `HMAC(pepper, deviceId)` for up to 10 devices per account after a successful login.
- The account-wide lock counts only failures from **unknown** devices. So a classmate typing wrong passwords can't lock a student out of the laptop they always use.

**The host sees who is locking whom:** "NovaPilot locked 3× today — unknown device, 10.0.0.7 (tag 3f9a)". Unlock lifts the lock.

**Per-email and per-account caps** stay the real abuse control.

### 4.15 Signup UI wording and errors

The client reads `GET /api/info` before showing the form.

**The email field label:**
- Optional: *"Email (optional — lets you reset your own password; without one, your host can reset it)"*
- Required: *"Email (required — we'll send you a 6-digit code)"*
- Required with domains: *"School email — use your @caldwellschools.org address"* (placeholder `yourname@caldwellschools.org`)

**Under the password field:** *"Don't reuse your school password."*

**The notice** is generated from the settings (§8.2), for example: *"Chat is filtered and logged. Your teacher can read it [and so can student moderators]. Lines are kept for 90 days. Ask your teacher for a copy or to delete it."* The host can add one line (at most 200 characters, name-filtered) but can't remove the generated facts.

**Screens:**
- Verify: a code box, Resend (0:45), "Wrong address? Change it".
- Waiting for approval: polls every 10 s.
- "I have a code from my teacher" (reset and roster).
- Account: email, password, **sign out everywhere**, and delete (when allowed).
- The **Public computer** box: ticked by default in School. It keeps the token in `sessionStorage`.
- The insecure-sign-in warning (Home, http).

**Errors:**
- "That doesn't look like an email address."
- "Use your @caldwellschools.org email address."
- "That username or email can't be used." (a generic 409, also used by `account/email`)
- "The verification email could not be sent — ask your teacher."
- "Wrong code — 3 tries left."
- "That code has expired — tap Resend."
- "Too many wrong codes. Try again in 1 hour or ask your teacher."
- "Please wait 45 s before asking for another code."
- "Waiting for your teacher to approve your account."
- "This server needs an account — guests are off."
- "Ask your teacher for a login slip." (roster only)
- "Sign in on the secure address https://…" (School over http)

---

## 5. Host console and Host Control Panel

### 5.1 Console window (the parent process only)

**Banner:**
```
 VOIDSWARM LAN HOST 0.6.0 — keep this running (closing it stops the game)

 Host Control Panel (this PC):  http://localhost:7778
 Players join at:               http://192.168.1.50:7777   (start page; QR on the panel)
                                https://192.168.1.50:7777  (secure)
 Certificate:                   root #1  SHA-256 3F:9A:…:C2   (this PC's address only)
 Data folder:                   C:\Users\…\Voidswarm LAN\data
 First run — setup code:        K7QP-4MXD   (already filled in on the setup page)
 Stop: Ctrl+C here, or Stop in the control panel. Tip: don't click inside this window.
```

- **Addresses:** only the canonical address pair. Other adapters are listed on the panel under "Other addresses (may not work)".
- **Window title,** updated every 5 s: `Voidswarm Host · 12 online · 3 rooms · 192.168.1.50:7777`.
- **After the banner, the console stays silent** except fatal errors and rare one-line notices (address change, new network, restarted). Because the child never writes to the console, a QuickEdit selection can only pause the parent's own output, never the game (T-LAN-10 verifies it).
- **Log files:** the child writes `data\logs\host-YYYY-MM-DD.log` asynchronously, rotated daily and kept 14 days.
  - **Log hygiene (both presets):** no chat text, no names, no room names, and no wellbeing lines.
  - Players appear as `#<playerId>` and rooms as `r<id>`.
  - No tokens, codes or links. Connect lines keep `ip:port`.
  - Today's `[mod] possible self-harm statement from <name>` line (`service.ts:455`) is dropped in LAN mode.
- **Clean shutdown** on Ctrl+C (SIGINT), SIGTERM, SIGHUP (the window's X, about 5 s of grace), SIGBREAK, or the panel's Stop (host PC; confirm):
  1. flush the chat buffer and checkpoint the DB **first**;
  2. send the 3 s "Server stopping — thanks for playing" system line;
  3. run the per-socket teardowns (leave grants);
  4. close ws;
  5. close profiles;
  6. `mod.close()`;
  7. `auth.close()`;
  8. the parent releases the pipe.

  A 4 s watchdog forces the exit.
- **Chat lines are written at the end of the tick in which they arrive** (noWait); they are buffered only while the DB is busy. So a Windows sign-out or shutdown, which Node does not see as a signal (libuv maps only Ctrl+C, Ctrl+Break and close), loses at most one tick of chat (T-REL-5).
- **`uncaughtException`:** log, flush, exit 1. The parent then restarts the child (§2.2).
- **A busy port** gives a friendly message and exit code 2. The missing listen `error` handler (`index.ts:362`) is added.

### 5.2 The panel: roles, capabilities, step-up and Presenting

`/` on the admin listener is a framework-free ES-module page with the strict CSP: no inline script, no `data:` images, `connect-src 'self'`.

**Tabs:** Home, Live, Chat log, Conduct, Rooms, Accounts, Reports, Bans & mutes, Custom terms, Settings, Server, Audit.
- `me` returns the caller's `capabilities`, and the page shows only the tabs they allow.
- **Banners** across the top: mail failing, chat not logged, low disk, new network, proxy detected, shared address, certificate expiring, host was asleep, server restarted, term ending, DB over 1 GB, no recovery file, permissions warning (Home), urgent alerts.

**One capability table, `can(principal, cap)`, used by BOTH the HTTP routes and `runAdminCommand`** (the in-game commands):

| Capability | Host on host PC | Host remote `full` | Host remote `limited` | Moderator `trusted` | Moderator `limited` |
|---|---|---|---|---|---|
| Home, Server status | ✔ | ✔ | ✔ | counts only | counts only |
| Live and Chat log: shown text and tags | ✔ | ✔ | ✔ | ✔ (log only if `moderatorLogSearch`) | Live only |
| ★ Reveal original text (a line, a page, one student's history) | ✔ | ✔ | – | in game: `/log` | – |
| ★ Chat log export, ★ purge; stats | ✔ | ✔ | – | – | – |
| Announcements | ✔ | ✔ | ✔ | – | – |
| Rooms: list | ✔ | ✔ | ✔ | ✔ | ✔ |
| Rooms: create, close, reset | ✔ | ✔ | ✔ | – | – |
| Accounts: list (masked) and actions | ✔ | ✔ | – | – | – |
| ★ Reveal email, ★ account export, ★ delete | ✔ | ✔ | – | – | – |
| ★ Conduct, ★ wellbeing alerts | ✔ | ✔ | – | – | – |
| Reports | ✔ | ✔ | ✔ | ✔ | reporter hidden; shown text only |
| Mute ≤ 24 h, kick, warn | ✔ | ✔ | ✔ | ✔ | ✔ (never a moderator) |
| Ban, network ban, unban, mute of any length | ✔ | ✔ | ✔ | ✔ (not host bans) | – |
| Network addresses | ✔ | ✔ | tag only | ✔ | – |
| Threat alerts | ✔ | ✔ | ✔ | in game: name only | – |
| ★ Custom terms, ★ Settings, mail test | ✔ | ✔ | – | – | – |
| Backups: list, back up now | ✔ | ✔ | – | – | – |
| Restore, recovery file, Stop, New certificate, own certificate, open folders, update | ✔ | – | – | – | – |
| Audit trail | ✔ | ✔ | – | – | – |
| First-run setup | ✔ (setup code) | – | – | – | – |

- **★ = sensitive:** it needs the password within the last 10 minutes of deliberate activity (§4.10).
- **Remote `full`** requires trusted TLS (§4.10). Otherwise remote sessions are `limited`.
- **The moderator tier** is a server setting, `moderators.tier`:
  - `limited` is the default everywhere and is **fixed in the School preset**;
  - `trusted` is only for a VPS host who chooses it (the seed for upgraded VPS data).
- **Nobody below the host can act on a moderator.**
- **Address bans** never match the host PC's own connection. The address-ban exemption for moderators applies only to the `trusted` tier.
- **SELF-HARM lines and alerts are for the host admin only, in every tier:**
  - moderators' feeds, `/log` and report lines leave them out entirely;
  - no in-game alert names the student.

**In-game commands, through `can()`:**

| Command | `limited` moderator | `trusted` moderator |
|---|---|---|
| `/kick`, `/warn`, `/modhelp` | ✔ | ✔ |
| `/mute` | ≤ 24 h | any length |
| `/unmute` | only mutes they created | ✔ |
| `/reports` | no reporter names; shown text | today's behaviour |
| `/log <name>` | the last 10 lines, **shown text** plus tag chips | original text |
| `/whois` | current room and any active mute | today's, without emails |
| `/ban`, `/ipban`, `/unban` | answer "Ask the host" | ✔ (not host bans) |

**Presenting mode** (a toggle in the header; **on by default in School**, remembered per browser):
- it hides names and chat text in Live and the Chat log, and every email;
- it greys out Conduct and Accounts until it is switched off, which needs a reauth if the session is stale.

### 5.3 Home tab and projector page

- **The launcher opens the Home tab.** It shows:
  - the Join card: the canonical URL, a QR code drawn on a `<canvas>`, the server name, the fingerprint, and "Other addresses (may not work)";
  - the rooms with type, phase and player counts;
  - players online;
  - alert **counts** without names ("1 urgent alert — open");
  - device checks today; first device connected;
  - the setup checklist: recovery file, network check, certificate.
- **Show on projector** opens `/display` in a new window, which you can drag to the projector. It shows:
  - the big URL and QR code;
  - the server name and fingerprint;
  - the rooms and their phase;
  - the latest `[Host]` announcement;
  - the chat notice.
  - It never shows chat, names or alerts. It is loopback only, needs no login, and updates by long-poll (`display/state`).

### 5.4 Live chat (auto-updating feed)

**Source:** `ModerationService.hook().logChat` also pushes each line into an **in-memory ring of 5,000 lines** (about 2 MB) with a sequence number. Announcements go in too. The feed keeps working while the DB is busy.

**Transport:** the long-poll `chat/live { after, wait ≤ 25 s }`, all waiters woken together per `setImmediate`, at most 4 waits per session. The ring stays on the game thread; it does no DB work.

**Each line shows:**
- the time;
- the **room and team label** ("Flag Run · Crimson (team chat)", or "Zone lobby");
- the player (username, or guest plus address tag), the channel;
- the **shown text** (what others saw; for a substituted line the chip says "substituted", §5.8);
- a coloured **tag chip** per category (§5.8) and an action chip.

**The original text is never in the default feed.**
- **Reveal** on a line, or **Show originals** for the current view, is sensitive (★); it is audited once per line or per view.
- SELF-HARM lines appear as "Wellbeing alert — needs your attention", with no name or text until opened (★).

**Filters:** room, channel, tag, "flagged only", player, and a **Pause** toggle that keeps buffering.

**One-click actions:** Mute (10 minutes, 1 h or 1 day, with a reason), Kick, Warn, Context, and (host) Conduct, all through the existing endpoints by `playerId`.

### 5.5 Chat log: the full log (the owner's request: "I want to keep a log of all of the chat also")

**Already true:** every human line in the lobby, rooms and team chat is stored with its original and shown text (§5.7). 0.6.0 adds a real browser, tags, exports, retention controls and the gaps in §5.7.

**Browser:**
- **Filters:**
  - date: Today, This class period, Last 60 minutes, 7 days, or custom;
  - student or account (autocomplete; the host can also search by email);
  - **room**, listed from the range including closed rooms, for example "Flag Run (Sep 28, 10:02–10:51)";
  - **class period** (Settings → Chat → Class periods);
  - channel: lobby, all, team, names, room names, announcements;
  - action: shown, substituted, masked, blocked, flagged for review, flood, muted;
  - **tag**;
  - **text search**.
- **Search:** the FTS5 trigram index, a case-insensitive substring, 3 characters or more. 1–2 characters fall back to `LIKE` over at most 7 days. Searches run in the worker (§5.16) and match the original text for the host, the shown text for moderators.
- **Table:** time, room and team, player, channel, action chip, tag chips, the **shown** text, and a Reveal button.
- **Context drawer:** 10 lines before and after **in the same room** (`room_uid`), with team lines marked, "load 10 more" at either end. Lobby lines show lobby context. Rows from before 0.6.0 fall back to `room_id` plus ±10 minutes.
- **Paging:** 100 per page, newest first, plus "jump to date".
- **Header:** "Showing 1–100 · the log holds 812,331 lines since Aug 25 · 372 MB · retention 90 days · next purge tonight". It comes from `log/stats`, cached for 5 minutes.

**Export** (sensitive ★):
- CSV or JSON, through **one shared CSV writer for every export** (UTF-8 with BOM; any cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is neutralised).
- **Scope:** the current filter, a date range, a room, a class period, one student, or everything.
- **Columns:** time, room, team, channel, player, account, **what they typed** (only when "include unfiltered text" is ticked), **what others saw**, action, display, tags.
- **SELF-HARM lines are left out** unless "include wellbeing lines" is ticked.
- Rows are streamed by the worker in pages of 1,000.
- **Save on this PC** writes to `data\exports\`, which is deleted after 7 days (recommended above 200,000 rows).
- Every export is audited with its filter and row count.

**Retention** (Settings → Chat; host only):
- **`days: N`** (1–3650; default **90**, seeded by `CHAT_LOG_RETENTION_DAYS`).
- **`term: <end date>`:**
  - nothing is purged before the date;
  - a banner 7 days before;
  - at the end date + 14 days, lines older than the end date are purged, after an encrypted backup;
  - then the panel asks for the next term's date. **If none is set within 14 days, it falls back to `days: 90`**, with a banner.
- **`forever`:** no automatic purge. The School preset offers it only with the tick "My district approved keeping chat until I delete it".
- **Records (365 days by default)** cover reports, audit, ended bans and conduct counters.
- **Wellbeing lines:** their original text is cleared 30 days after the host acknowledges them (§5.11).
- **Manual purge** ★: "Purge lines before <date>", optionally for one student.
  - The first call answers 409 with the row count; the host confirms that count.
  - The worker purges in chunks (§5.16). Dependent tags, counters, reviews and report copies go too, and the purge is recorded in the deletion ledger.
  - The dialog says: "Backups keep these lines until they age out (at most 35 days). The search index finishes tidying at the next restart or overnight."

**Audit:** searches are coalesced per 60 s; reveals, context views, exports and purges are always written.

### 5.6 Announcements

- `announce { text, roomId? }` sends a `system` line **`[Host] <text>`**:
  - with no `roomId`, to everyone in the zone lobby and every room;
  - with a `roomId`, to that room.
- It goes through the new public `Zone.announce()`. Today `zoneSystem` is private and lobby-only (`Zone.ts:629-638`).
- System lines are drawn in the system style, and players can't send on the system channel; the reserved names (§4.1) stop a player calling themselves "Host".
- It is logged in `chat_log` (channel `announce`) and `mod_actions`.
- **UI:** a text box, a target picker, and the quick buttons "5 minutes left", "Finish your match" and "Server restarting soon".

### 5.7 What is logged (confirmed in code) and the gaps 0.6.0 closes

| Where / what | Logged today? | 0.6.0 |
|---|---|---|
| Zone lobby chat (`Zone.lobbyChat` → `chatGate`) | yes (`all`, `room_id` NULL) | adds `room_uid = <bootId>:zone`, `display`, tags |
| Room chat, all (`Room.onChat` → `host.chatGate`) | yes | same |
| Room team chat (`team` or a `//` prefix) | yes | same |
| Muted, flood, blocked, masked, flagged, filter-error lines | yes, **original kept** | `display` records what others saw (§5.8) |
| Refused callsigns and room names | yes (`name` / `room`, block) | – |
| **Accepted** guest callsigns (joining name and `/name`) | **no** | **added** (`name`, pass) |
| **Accepted** room names (create, rename) | **no** | **added** (`room`, pass) |
| Host announcements | new | **added** (`announce`) |
| Whisper or private messages | **no such channel exists** | a test pins that every channel a human can send is logged |
| `/report` text | `reports`, with 20 full rows | the report stores **chat ids plus shown text** only (§6.4) |
| Moderator commands | `mod_actions` | shown in Conduct and Audit |
| Other slash commands, bot chat, automatic system lines | no (not chat, or not people) | unchanged |
| Lines buffered when the window closes | **lost** (no SIGHUP handler; 1 s buffer) | **fixed**: SIGHUP and SIGBREAK flush, plus end-of-tick writes |
| Chat while the DB can't open | **not logged** | LAN: the start fails loudly; VPS: a red banner |
| Buffer overflow (> 20,000 lines while busy), `SQLITE_FULL`, I/O errors | dropped and counted | a "Chat is NOT being logged" banner, plus the counter on the Server panel |

- **Account callsigns can't change**, so "callsign changes logged against the account" holds by construction. The accepted-name rows cover guests.
- **`chat_log.room_uid = <bootId>:<roomId>`** keeps "by room" and context correct across restarts (`Zone.ts:179`).

### 5.8 Tags, per-tag policy and substitution (owner amendments A1, A2)

**Tags (A1).** Every filtered line carries one tag per category it hit, each counted separately.

| Tag | Source | Severity in Conduct |
|---|---|---|
| **PROFANITY** | built-in `profanity`, plus `mild` in strict mode | medium (mild: low) |
| **VULGAR** | built-in `sexual` | high |
| **HATE** | `slur`, `hate` | high |
| **THREAT** | `threat` | high |
| **SELF-HARM** | `selfharm` | wellbeing: **never an offence** |
| **GANG** | host custom terms with category `gang` | review until confirmed (below) |
| **<LABEL>** | any other custom category, under its own label | review until confirmed |

- Tags are derived from the hit labels. Built-in labels are `category:term`; custom block and mask hits are `custom:category:term`; review-only hits are `flag:category:term` (`hitLabel`, `shared/room/moderation.ts`, already in the working tree).
- They are stored in `chat_tags(chat_id, tag, ts, account_id)` for filtering.
- They are counted per student per day in `conduct_daily(account_key, day, tag, n)`. The Conduct view reads the counters: 0.33 ms, against 3,067 ms for a scan (§0 fact 3).

**Per-tag policy** (Settings → Chat → Tags; one row per tag):

| Field | Meaning |
|---|---|
| `strike` | counts toward the strike limit (`MOD_STRIKE_LIMIT` in `MOD_STRIKE_WINDOW_MIN`) |
| `autoMuteAfter` | N strikes from this tag in the window → auto-mute (null = never) |
| `notify` | `none`, `banner`, or `urgent` (an urgent banner plus the optional content-free email, §4.7) |
| `dailySummary` | included in the day's counts card (and email: counts only, no names) |

Defaults (A1):

| Tag | strike | autoMuteAfter | notify |
|---|---|---|---|
| THREAT | yes | 2 | **urgent** |
| SELF-HARM | **never** (fixed) | – | **urgent** (at least `banner`; can't be switched off) |
| HATE | yes | 3 | banner |
| GANG (confirmed terms) | yes | 3 | banner |
| PROFANITY | yes | 3 | none |
| VULGAR | yes | 3 | none |
| Other custom labels (confirmed) | no | – | none |

Every tag has `dailySummary` on.

**Unconfirmed custom terms (reconciling A1's GANG default with review-first):**
- Every imported term starts **unconfirmed**. The server compiles it as a `flag` term whatever its stored action: the line is shown unchanged, logged as `flag` with its tag, and gets no strike and no warning.
- The GANG policy applies only after the host **confirms** the term (§5.12), or ticked "apply this list's actions" on import (audited).
- Terms the host types by hand are confirmed when saved.
- Unconfirmed hits count as "for review" in Conduct and are left out of the Top offenders ranking.

**Substitution (A2), in `Zone.chatGate`, online and offline:**
- **A blocked or masked line (any tag except SELF-HARM):**
  - Everyone else sees a **random positive line** instead. The default is under the **sender's name**; `chat.substitute` can make it a system line (`system`) or hide it (`hide`).
  - The lines are a curated PG list of about 40, editable in Settings → Chat. Each is at most 60 characters and must itself pass the filter; at least 5 are kept.
  - The pick comes from a shuffled deck per Zone, seeded from `bootId` with the shared `Rng` (no `Math.random`), and never repeats twice in a row.
  - Team lines are substituted to the same team audience.
- **The sender** does not see the substitute. They get a private warning that never names the words, the category or the tag:
  - 1st: *"That message used inappropriate language and wasn't shared. Keep chat friendly!"*
  - 2nd: *"Second warning — that message wasn't shared either."*
  - at strike limit − 1: *"One more and your chat will be muted for a while."*
  - then the existing mute notice.
- **SELF-HARM:** the line is withheld (never replaced with a cheerful line). The sender gets `MSG_CARE`, extended with *"In the US you can call or text 988."* There is no strike. The host gets the urgent wellbeing alert (§5.11).
- **THREAT:** substituted like the others, plus the urgent alert.
- **Flag tier:** shown unchanged and logged with its tag; no warning.
- **Offline vs bots:** the same rules (substitute and warn), and nothing is logged.
- **The log** keeps `action` as the filter's verdict (block, mask, …) so severity stays queryable. The new column `display` records what others saw:

  | `display` | Meaning |
  |---|---|
  | `as-typed` | the line as written |
  | `masked` | stars (substitution off) |
  | `substituted` | a positive line (`shown` = that line) |
  | `system` | the positive line as a system line |
  | `hidden` | nothing |
  | `withheld` | self-harm |

  So A2's "action = substituted" is recorded as `display = 'substituted'` (decision log).
- **Attribution in views and exports:** the admin views and exports show "Others saw: 'GG, pilots!' (substituted)". A substitute is never presented as the student's words.

### 5.9 Rooms: several game types at once

**Rooms tab** (refreshes every 3 s while visible):
- one row per room: name, type and sub-mode, phase, humans/bots/spectators out of the maximum, host, score, age;
- badges: house, pinned;
- the player list, with warn, kick and mute;
- a **Watch link** (copy, plus QR) to `…/?watch=<roomId>`.

**Create:** type → a *ready* sub-mode → name (name-filtered) → options → **Pinned** (default on for host rooms: they never auto-close). It runs through `Zone.adminCreateRoom()`, which checks `ready` and `maxRooms`.

**Close:** `Zone.adminCloseRoom(roomId, reason)` sends each player the reason and calls `leaveRoom` on each, so leave grants are paid. It needs `confirm` when players are present. House rooms can only be **Reset**; **Reset all house rooms** does every one.

**Caps card:** rooms X / `maxRooms`; playing Y / `maxPlayingRooms`; "2 rooms waiting to start"; the per-address cap.

**Host-configurable caps** (Settings → Rooms & limits; applied live with `zone.setLimits()`; lowering a cap never closes rooms, it only stops new ones):

| Cap | Code default | LAN default | Range |
|---|---|---|---|
| `maxRooms` (house rooms count) | 24 | **12** | 5–24 |
| `maxPlayingRooms` | 6 | 6 | 1–12 |
| `maxRoomsPerAddress` | 6 | Home 3 / School 6 | 1–24 |
| `maxConnections` / per address | 512 / 64 | 512 / 64 (School 128) | – |

**Practical limit (to be confirmed by T-PERF-1):**
- **CPU:** a 16-bot Warzone match averaged 0.277 ms per tick (10 ms at worst) on a Core Ultra 9 285K. Six playing rooms come to about 1.7 ms there. 32 humans add snapshot encoding per client, which is budgeted at 2× and not yet measured.
- **RAM:** about 300 MB for three full 32-player matches.
- **Network:** about 0.5 Mbit/s per player.
- **Tick counters** (avg, p99, max, dropped over 60 s) are added to the Zone loop (`Zone.ts:284-300`). The panel warns when p99 stays above 12 ms for 30 s.

### 5.10 Accounts panel

- **Table columns:** username, email (masked; Show ★), verified ✓, status, roster, created, last login, moderator ★, locked 🔒 (with who is locking whom), online ●, flagged lines in 30 days.
- **Bulk actions:** approve, reject, disable, **print slips**.
- **Badges:** a "Waiting" badge for approval and pending verification, with the last mail error.
- **Code and slip dialogs:** "Show this privately — don't read it aloud."
- **Export** ★ and **Find by email** (works in `hashOnly` mode).

### 5.11 Conduct view (host admin only; sensitive ★)

**Purpose (owner):** accountability for profanity and bad language. It is built from:
- `conduct_daily` and `chat_tags`;
- `chat_log` by `account_id`;
- `mod_actions` by target;
- `bans`, and `reports` by target or reporter;
- guest callsign rows.

**Class summary: "Top offenders."**
- Date range (default 30 days) and class-period filter.
- It is a **students × tags** table (A1), with columns for today, this week, the term and all time.
- It also shows blocked, masked and substituted counts, auto-mutes, mutes, bans, reports against, and last incident.
- Rows are sorted by high, then medium, then most recent. Unreviewed custom hits sit in a separate "For review" column and don't rank.
- Emails are masked; Show ★ is audited.

**Wellbeing** is never an offence and never counted:
- The Home tab and Live show only "A wellbeing alert needs your attention".
- Opening one ★ shows the student, time, line and context.
- **Acknowledge**, with a note, is stored in `wellbeing_acks`. The line's original text is cleared 30 days after acknowledgement.
- Wellbeing lines are left out of exports unless ticked. Moderators never see them.

**Per student:**
- **Header:** username, callsign history, email (full; the view is audited), roster flag, state, created, last seen.
- **Per-tag counters** for today, week, term and all time.
- **Totals by severity.**
- **Timeline:**
  - lines with their shown text; **"Show unfiltered history"** ★ reveals the originals, which is audited (A1);
  - strikes, auto-mutes, mutes, bans, warns and kicks;
  - reports against them and by them;
  - host notes.
- Search, date range, and **Context** on every line.

**Review queue:** flag-tier and unconfirmed custom hits get **OK** or **Needs follow-up** plus a note (`flag_reviews`), with a badge count. Per-term hit counts in Custom terms show overbroad terms.

**Export for school discipline records** ★:
- **CSV:** one student's timeline, or the class summary.
- **Print / Save as PDF:** a `@media print` view inside the panel (`window.print()`; no PDF library). It carries:
  - "Confidential — student conduct record", the server name, the range, and who generated it and when;
  - page footers;
  - the note *"Lines are attributed to the signed-in account; a shared or unattended session can misattribute."*
  - Substituted lines show what others saw, labelled as substituted.

**Audit:** every student-record view writes `mod_actions` `view` (never coalesced); exports write `export`.

### 5.12 Custom terms (host admin only; the district's own list; no gang list in the public repo)

**Storage:** the `custom_terms` table.
- It is in encrypted backups and exportable to share between teachers.
- It is never shown to moderators and never committed to the repo.

**Each entry:**
- term (2–64 characters);
- category (sanitised, at most 24 characters; `gang`, `local`, `bullying`, …);
- action: `block`, `mask` or `flag`;
- scope: chat, names or both;
- match: `word`, `phrase` or `strong`;
- up to 8 context anchors;
- a note, enabled;
- **confirmed at/by**;
- source (`typed` or `import`);
- **hit count and last hit**.

**Engine (already in the working tree, `src/shared/moderation/custom.ts`):**
- `compileCustomTerms(entries)` validates and returns errors and diagnostics.
- `setCustomTerms(entries)` installs the set **process-wide** for every later `filterChat` and `checkName`. One Zone runs per server process; the offline client never calls it.
- Caps: `CUSTOM_LIMITS` (2,000 entries, 64 characters, 8 anchors, 40,000 letters).
- The server passes **unconfirmed** entries with `action: 'flag'`. It compiles on every change and installs only if the compile succeeds; a rejected change is not saved. Diagnostics are shown per entry and never contain built-in terms.

**Import and export:**
- CSV columns `term,category,action,scope,match,context,note` (context split on `|`), or JSON.
- **Dry run first** (added, updated, skipped, errors per row), then merge or replace.
- **Imported rows land unconfirmed**, so they only flag, whatever their action, unless "apply this list's actions" is ticked (audited).
- Rows without an action default to `flag`.

**Confirm:** one term or a whole category, with each term's recent hits shown first. It is audited.

**Test box:** "Try a line" shows the verdict, the shown text, the tags and the hits.

**Hit labels:** the host sees `custom:<category>:<term>` or `flag:<category>:<term>`. Moderators and in-game commands see only the tag.

**Hosted moderation API:** optional, later, off by default. Only the settings key `hostedModeration: { enabled: false }` and the hook point exist in 0.6.0. It would score after display, never blocking chat, and in School needs the tick "My district has approved sending chat text to <provider>".

### 5.13 Settings panel and presets (host admin only; ★; applies live; audited)

**Sections:**
- **Accounts & email:** §4.2, the domain editor, and **Roster**.
- **Mail:** §4.7, with the test button and alert email.
- **Chat:**
  - strictness: **strict**;
  - the notice line;
  - retention (§5.5);
  - records retention;
  - class periods;
  - tags and per-tag policy;
  - substitution mode and the positive lines;
  - address minimisation.
- **Custom terms:** a link to its tab.
- **Admin access:**
  - remote access (off, limited or full);
  - idle minutes;
  - step-up minutes;
  - live-keeps-alive;
  - moderator view, moderator log search, moderator tier.
- **Rooms & limits.**
- **Network:**
  - port (restart needed);
  - serve on adapter;
  - devices trust the certificate (QR and redirect);
  - extra addresses from IT;
  - own certificate;
  - standard ports;
  - open the browser at start.
- **Backups:** daily, off-PC copy location, size cap.
- **Optional integrations:** disabled.

**Presets** (first-run choice; each value can still be changed):

| Setting | Home | School |
|---|---|---|
| `signInOverHttp` | warn | **block** |
| guests | on | off with required + domains, or roster |
| `sessionHours` / Public-computer box | 720 / unticked | **12 / ticked** |
| `selfDelete` | on | off |
| certificate scope / new root | this network (/24) / ask | **this PC (/32) / never automatic** |
| port auto-pick | first run only | never |
| started as administrator | warn | **refuse** |
| permission problems | warn (with fix) | **refuse** (with fix) |
| moderator tier | limited | limited (fixed) |
| rate limits | normal (scaled if shared) | **scaled** |
| Presenting on at login | off | **on** |
| `forever` retention | allowed | needs the "district approved" tick |
| address minimisation | off | **on**: address NULL on account lines after 7 days (guests off); guest lines keep only the address tag after 7 days |
| `maxRoomsPerAddress` | 3 | 6 |

**Persistence:**
- `data\voidswarm.config.json` with `configVersion` and `rev`. Writes are atomic (temp file, fsync, rename).
- Env vars seed only on first run. Later a differing variable logs one warning, for example "CHAT_LOG_RETENTION_DAYS=30 ignored — the admin console setting (90) wins."

**Live apply:** each component subscribes.
- Auth: policy, limits, mailer.
- Moderation: retention, strikes, tags, custom terms (`setCustomTerms`).
- Zone: `setLimits`, `setChatOptions`.
- HTTP: remote access, redirect, allowlist.
- Launcher: port, on restart.

**Audit:** one `settings` row per changed leaf, with `old → new`; secrets show as `(changed)`.

**On the VPS** the same page and API are reachable for the host role (`full`, behind a public certificate).

### 5.14 Server panel (status, certificate, backups)

- **Status:**
  - players online (accounts / guests), connections, rooms and playing;
  - uptime, RSS and heap, CPU %;
  - tick avg, p99, max and dropped;
  - DB and WAL size, chat rows, buffered and dropped lines;
  - free disk;
  - mail mode and last error;
  - "sign-ins over https today: 27 of 30";
  - proxy seen; device checks;
  - **runtime Node version and build date**;
  - data path, with whether it is synced, shared or restricted.
- **Join card** (as on Home).
- **Certificate card:**
  - the root number and fingerprint, the scope, the leaf names and expiry;
  - Regenerate leaf, **New certificate** and **Use my own certificate** (host PC only);
  - download links.
- **Backups card:**
  - the list (date, reason, size, encrypted ✓), Back up now;
  - **Restore…** (stages a restore; host PC);
  - **Create or replace the recovery file** (host PC);
  - **Open backups folder** and **Open exports folder** (host PC; the parent runs `explorer.exe`);
  - the last off-PC copy, and the total size against the cap.
- **Stop server** (host PC; confirm).
- **Audit tab:** the `actions` list, filterable by actor, action and target.

### 5.15 API: conventions and endpoints

These follow `adminApi.md`: `POST /api/admin/<endpoint>` with a JSON body; success answers include `"ok": true`; errors are `{ error }`.

**Conventions:**
- **Auth:** `Authorization: Bearer <admin session>`. Player game tokens are no longer accepted. Only `setup/status`, `setup`, `login` and `display/state` need no token.
- **Access:** each route declares `{ cap, sensitive?, hostPcOnly?, bodyLimit, file? }` and is checked by `can()`.
- **Error codes:**

  | Code | When |
  |---|---|
  | 401 `reauth` | a sensitive call with a stale session |
  | 403 `Host PC only` / `Not allowed for your role` | the capability or place rule fails |
  | 421 | a bad Host header |
  | 409 `{ error, rev }` | a settings revision mismatch |
  | 409 `{ needsConfirm, … }` | a destructive call without its confirm |
  | 415 | not JSON |
  | 502 `{ error, code, hint }` | `smtp/test` failed |

- **Body limit** 8 KB, except the imports at 512 KB.
- **Handlers are async** (the long-poll, and the worker).
- **Files** come back as `200` with `Content-Disposition` and `X-Row-Count`; the panel downloads through fetch → Blob → `a[download]`.
- **Moderator sessions** never receive `address` (they get `addressTag`), `email`, `original`, reporter identity (limited tier) or SELF-HARM rows.
- **Types:**
  - `ChatLogRow` gains `roomUid`, `display` and `tags`;
  - `original` is present only from reveal endpoints;
  - `channel` gains `'announce'`;
  - the existing `Action` includes `'flag'`.
- **Audit:** reads are coalesced per 60 s, except reveals, `conduct/*`, `accounts/get`, exports and wellbeing, which always write.

**Types:**
```ts
type Principal = { kind: 'host'; via: 'local'|'full'|'limited' } | { kind: 'moderator'; tier: 'trusted'|'limited' };
type Tag = 'PROFANITY'|'VULGAR'|'HATE'|'THREAT'|'SELF-HARM'|'GANG'|(string & {});
type Display = 'as-typed'|'masked'|'substituted'|'system'|'hidden'|'withheld';
interface Session { principal: Principal; username: string; expiresAt: number; idleSec: number; freshUntil: number; capabilities: string[] }
interface LiveLine { seq: number; ts: number; roomUid: string|null; roomName: string; channel: string; team: number; playerId: number;
  name: string; accountId: string|null; addressTag: string|null; shown: string; action: string; display: Display; tags: Tag[];
  wellbeing: boolean /* true → name and shown are blank until wellbeing/open */; online: boolean }
interface RoomRow { roomId; roomUid; name; gameType; subMode; mode; teamCount; floors; phase; humans; bots; spectators; maxPlayers;
  house; pinned; hostName; score; createdAt; playingSince; players: { playerId; name; username; team; spectator }[]; watchUrl }
interface AccountAdminRow { accountId; username; email: string|null /* masked unless revealed */; emailVerified; emailInPolicy;
  status; roster: boolean; legacy; createdAt; lastLogin; moderator; locked: { until: number; unknownDeviceFails: number }|null; online; flagged30d }
interface CustomTerm { id; term; category; action; scope; match; context: string[]; note; enabled; source: 'typed'|'import';
  confirmedAt: number|null; confirmedBy: string|null; hits: number; lastHit: number|null; diagnostics: string[] }
interface ConductEvent { ts; kind: 'line'|'name'|'automute'|'mute'|'ban'|'kick'|'warn'|'report-against'|'report-by'|'note'|'review';
  severity: 'high'|'medium'|'low'|'review'|null; tags?: Tag[]; roomName; roomUid; channel?; shown?; display?; action?; by?; reason?; chatId? }
```

**Session, setup and step-up:**

| Endpoint | Request | Response |
|---|---|---|
| `setup/status` (host PC) | `{}` | `{ ok, needsSetup }` |
| `setup` (host PC) | `{ setupCode, username, password, preset, serverName, accountsMode: 'email'\|'roster' }` | `{ ok, token, session }` · 400 `attemptsLeft` · 429 `retryAfter` · 404 once set up |
| `login` | `{ role: 'host'\|'moderator', username, password }` | `{ ok, token, session }` · 401 · 403 (remote off / moderator view off / needs https) · 429 |
| `reauth` | `{ password }` | `{ ok, session }` |
| `logout` / `password` | `{}` / `{ current, next }` | `{ ok }` (password: other sessions revoked) |
| `me` | `{}` | `{ ok, admin, session, capabilities, banners }` |

**Home, display, alerts and checks:**

| Endpoint | Request | Response | Capability |
|---|---|---|---|
| `home` | `{}` | `{ ok, join, rooms, online, alerts: { urgent, banner }, checks, firstDevice, setupChecklist }` | status |
| `display/state` (loopback, no token) | `{ after? }` | `{ ok, serverName, joinUrl, fingerprint, rooms, announcement, notice }` | – |
| `alerts/list`, `alerts/ack` | `{}` / `{ id, note? }` | `{ ok, alerts }` (threat: name; wellbeing: nameless) | status / ★ |
| `wellbeing/open`, `wellbeing/ack` | `{ id }` / `{ id, note }` | `{ ok, student, line, context }` / `{ ok }` | ★ wellbeing |
| `checks/list` | `{ since? }` | `{ ok, summary, recent }` | status |
| `network/approve` (host PC) | `{ networkId, serve: boolean }` | `{ ok }` | settings |

**Live, log and announcements:**

| Endpoint | Request | Response | Capability |
|---|---|---|---|
| `chat/live` | `{ after?, wait?: 0..25, limit?: 1..500, roomUid?, tag?, flaggedOnly? }` | `{ ok, lines: LiveLine[], next, gap }` | live |
| `log` | filters + `q`, `channel`, `roomUid`, `period`, `action`, `tag`, `before` | `{ ok, lines, nextBefore }` | log |
| `log/context` | `{ id, before?: 0..50, after?: 0..50 }` | `{ ok, anchor, before, after }` | log |
| `log/reveal` ★ | `{ ids: number[] }` (≤ 100) \| `{ accountId, since?, until? }` | `{ ok, originals: { id, original }[] }` | reveal |
| `log/rooms` | `{ since?, until? }` | `{ ok, rooms }` | log |
| `log/stats` | `{}` | `{ ok, rows, oldest, newest, dbBytes, walBytes, perDay, retention, nextPurgeAt, dropped, pending, indexTidyPending }` | log.stats |
| `log/export` ★ | filter + `{ format, all?, includeOriginal?, includeWellbeing?, saveOnHost? }` | a file, or `{ ok, savedTo, rows }` | log.export |
| `log/purge` ★ | `{ before, accountId?, confirmRows? }` | 409 `{ needsConfirm, rows }` → `{ ok, deleted }` | log.purge |
| `announce` | `{ text: 1..200, roomId? }` | `{ ok, delivered }` | announce |

**Rooms:** `rooms/list`, `rooms/create`, `rooms/close`, `rooms/reset`, as in the draft; capabilities rooms.read and rooms.manage.

**Accounts:**
- the draft's endpoints: `list`, `get`, `findEmail`, `resetCode { accountId, send?: 'email' }`, `unlock`, `approve`, `reject`, `disable`, `setModerator`, `delete { accountId, records: 'delete'|'pseudonymise', guestEra?: boolean, confirmUsername }`, `export`;
- plus `accounts/signOutEverywhere { accountId }`;
- plus `accounts/roster/import { csv, dryRun }` → `{ ok, rows, errors }`;
- plus `accounts/roster/slips { accountIds }`, which reissues the codes and returns them for the print view.

**Conduct ★:**
- `conduct/summary { since?, until?, period?, limit? }` → `{ ok, rows: { accountKey, username, callsigns, emailMasked, tags: Record<Tag, { today, week, term, all }>, blocked, masked, substituted, forReview, autoMutes, mutes, bans, reportsAgainst, lastAt }[] }`;
- `conduct/student { accountId | guest, since?, until?, q?, before? }` → `{ ok, student, counters, bySeverity, timeline: ConductEvent[], nextBefore }`;
- `conduct/review { chatId, status, note? }`;
- `conduct/export { accountId | all, since, until, format, includeOriginal? }`.

**Custom terms ★:**
- the draft's `list`, `add`, `update`, `remove`, `import` (`applyActions?` flag), `export`, `test`;
- plus `customTerms/confirm { ids | category }` → `{ ok, confirmed }`.

**Settings, server and backups:**
- `settings/get`, `settings/update { rev, patch }`, `smtp/test`, `status`;
- `backups/list`, `backups/create`, `backups/restore` (host PC), `recovery/create { passphrase? }` (host PC; the generated words are returned once), `backups/copyNow`;
- `cert/status`, `cert/renewLeaf`, `cert/new { confirm }` (host PC), `cert/own { pem | pfxBase64, key?, passphrase? }` (host PC);
- `server/openFolder { which: 'backups'|'exports' }` (host PC), `shutdown { confirm }` (host PC).

**Unchanged, now behind `can()`:** `online`, `reports`, `reports/review`, `bans`, `bans/create`, `bans/revoke`, `kick`, `warn`, `whois` (the host view adds email) and `actions`.

**Player accounts API** (`src/server/auth`; the Accounts block in `protocol.ts` gains additive types; ARCHITECTURE.md §3b is updated):
- `GET /api/info` → `{ ok, version, serverName, signup, email, domains, verify, approval, guests, resetByEmail, selfDelete, notice, secure, httpsUrl, signInOverHttp, sessionStore }`.
- `POST /api/register { username, email?, password }` → `{ token, account, state, mail? }` (403 in `rosterOnly`).
- `/api/login { …, deviceId }` and `/api/me` add `state` and `email: { masked, verified, pending }`.
- `POST /api/verify`, `/api/verify/resend`, `/api/account/email` (a collision gives the generic 409), `/api/account/password`, `/api/account/signOutEverywhere`, `/api/reset/code { username, code, password }` (reset and first-login), `/api/account/delete` (only when `selfDelete` is on).
- Over plain http from a LAN address, every endpoint that carries a password, token or code follows `signInOverHttp`:
  - `block`: 403 "Sign in on the secure address https://…";
  - `warn`: the header `X-Voidswarm-Insecure: 1`.

### 5.16 Where the work runs (keeping the game thread free)

**The game thread:**
- chat and audit inserts, written at the end of the tick with no wait for the lock (buffered only while the DB is busy);
- the in-memory live ring;
- small indexed point queries needed in play: ban checks, and `/log` and `/whois` with `LIMIT`.

T-PERF-2 budgets each of these at 1M rows.

**The DB worker, `app\maint.mjs`** (`worker_threads`, one per server; its own connections; it inherits the `--permission` sandbox and the authorizer):
- **Every panel read:** log, search, context, rooms, stats, conduct, exports (streamed back in pages over a MessagePort) and the device-check summaries.
- **Chunked writes:**
  - purges, retention pruning, deletion, address minimisation and wellbeing clears;
  - **250 rows per transaction**: about 1.5 ms each on the owner's PC (a 1,000-row chunk took 5.8 ms at p50 and 63 ms at worst);
  - a yield between chunks.

  So the game thread's auth connection (`busy_timeout` 5,000 ms) waits at most a few ms for the write lock. T-PERF-3 pins auth write p99 below 50 ms during a 200k-row purge.
- **Backups:** the `node:sqlite` `backup()` in steps, then gzip, then AES-GCM.
- **FTS `optimize`** (about 1 s per 250k rows; it holds the write lock) runs only in quiet windows:
  - before the listener opens at start;
  - when there have been no connections for 10 minutes overnight;
  - at Stop, when the estimate is under 10 s.

  Until then, `log/stats` shows `indexTidyPending`.
- **Compact database** (VACUUM; ★, host PC) runs only in a quiet window with twice the DB size free. It shows "this takes about N s".
- **Disk:** free space is checked at start and hourly.
  - Below 2 GB: skip backups, with a banner.
  - Below 500 MB: the red banner "Chat may stop being logged".
  - `SQLITE_FULL` or I/O errors on the chat write raise the "Chat is NOT being logged" banner.

---

## 6. Data safety

### 6.1 Backups

**Contents:**
- `voidswarm.db` (accounts, the full chat log, conduct counters, reports, bans, audit, custom terms, loot);
- `voidswarm.config.json`;
- `deletions.jsonl`.

**Never included:** `secrets\`, `tls\`, `logs\` and `exports\`.

**Format:** `data\backups\2026-09-28_0712_start.vsbak`.
- A header (`VSBK1`, key id, nonce), then gzip, then **AES-256-GCM** with `data\secrets\backup.key`.
- The `node:sqlite` `backup()` runs in the worker: 116 ms for 29 MB. Gzip: 5.2× on synthetic chat, about 3× expected on real chat.

**When:**
- at start, when a migration is pending or the last backup is more than 6 h old;
- daily, at the first quiet moment after 02:00 or after 24 h of uptime;
- before a restore, a term purge, an update or a New certificate;
- on demand.
- **Not** before an account deletion: that would defeat it.

**Retention (by age, then size):**
- every class is capped at **35 days**: start (at most 5), daily (at most 7), weekly (at most 4);
- pre-migration and pre-update backups at 30 days;
- a size cap of 2 GB drops the oldest first. The newest 3 are exempt only while they are within 35 days.
- So a host that runs once a week never keeps anything older than 35 days (T-BAK-2).

**Off-PC copy:** Settings → Backups → **Also copy backups to** (a USB stick or district share). The parent copies the encrypted files after each backup; the sandboxed child can't write there. The Home tab shows a banner when there has been no off-PC copy for 30 days.

**Protect backups:** they are encrypted, but the README still says: keep off-PC copies on district-approved storage, not personal cloud drives, and use BitLocker.

### 6.2 Restore

- **From the panel:** Server → Backups → Restore… (host PC). It stages `data\restore.pending.json`; you then stop and start the host.
- **From `Restore a backup.cmd`:** it refuses while the host runs (pipe), lists the backups, and asks for a number and a confirmation.
- **Either way:**
  1. a safety backup of the current DB;
  2. decrypt (with `backup.key`, or the recovery file for a backup from another install) and un-gzip;
  3. `integrity_check` and the untrusted-data checks when the backup came from another install (§6.5);
  4. remove the stale `-wal`/`-shm` files;
  5. **re-apply the deletion ledger** (the current one plus the backup's);
  6. **keep the current `host_admins` rows and clear `admin_sessions`.** A restore never brings back an old admin password; if the current DB is unreadable, first-run setup runs again;
  7. optionally restore the config.

### 6.3 Recovery file and moving PCs

**Contents:** `voidswarm-recovery-<server>-<date>.vsrec` holds the pepper, the backup key, the SMTP password and the install id. It **never** holds certificate keys (the root key doesn't exist; the issuing key stays on the PC).

**Encryption:** AES-256-GCM with a key from scrypt of a passphrase. The passphrase is **4 generated words**, shown once ("write it down, keep it apart from the file"), or your own of 16 characters or more.

**Offered** at first-run setup. A "No recovery file yet" banner stays until one exists, with a reminder yearly and 14 days before a term ends.

**Moving to another PC:** a backup plus the recovery file, through **Bring in data from another copy** (§2.5) or `tool restore --recovery`.
- The certificate is new, so devices trust again.
- Everything else, including `hashOnly` email lookups, known devices and address tags, keeps working.

### 6.4 Retention hygiene and the deletion ledger

- **Reports** store `recent_ids` (chat ids) plus shown-text copies only. The migration rewrites existing `recent_chat_json` to shown-only. Purges and account deletions remove report copies of the deleted lines.
- **Exports:** `data\exports\` files are deleted after 7 days. Browser downloads are outside the server's reach, and the export dialog says so.
- **Host logs** contain no names or text (§5.1).
- **Deletion ledger:** `data\deletions.jsonl` (append-only; also in each backup) records `{ ts, kind: 'account'|'purge', accountId?, usernameHash?, before?, by }`. It is re-applied idempotently after every restore or import, so a deleted student stays deleted (T-BAK-3).
- **Address minimisation** (School, guests off): the address on account lines is set to NULL after 7 days; guest lines keep only the address tag after 7 days. Bans keep their own addresses.

### 6.5 Untrusted data (imports, restores from elsewhere)

- **Open with protections:** `PRAGMA trusted_schema = OFF`, and an authorizer that denies `ATTACH`/`DETACH` (and so `VACUUM INTO`), everywhere except the worker's own backup steps. `load_extension` stays off (the default).
- **Compare `sqlite_schema`** with the expected schema for that `user_version`: no extra tables, triggers or views, and matching columns. Otherwise it is refused: "This data folder was changed outside Voidswarm."
- **`host_admins` and `admin_sessions` are never imported:** the new copy runs setup.
- **Secrets** come only from a recovery file.
- **Config** is validated field by field.

### 6.6 Migrations and schema v4

**Rules:**
- Migrations are forward-only SQL appended to `MIGRATIONS`.
- v4 uses **only** `ALTER TABLE ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, `CREATE VIRTUAL TABLE` and `CREATE TRIGGER`.
- JS backfills (`email_key`, `email_hash`, report copies) run idempotently.
- Duplicate keys mark the later account `email conflict`.
- The FTS rebuild costs about 0.5 s per 100k existing lines; the console says so.
- A **newer** DB is refused with the friendly text (`store.ts:221-223`).
- `configVersion` has its own small migration.

```sql
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | verify | approval | disabled
ALTER TABLE accounts ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN roster INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN email_key TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER;
ALTER TABLE accounts ADD COLUMN email_hash TEXT;
ALTER TABLE accounts ADD COLUMN email_hint TEXT;
ALTER TABLE accounts ADD COLUMN approved_at INTEGER;
ALTER TABLE accounts ADD COLUMN approved_by TEXT;
CREATE UNIQUE INDEX accounts_email_key ON accounts(email_key) WHERE email_key IS NOT NULL;
CREATE INDEX accounts_status ON accounts(status, created_at);
CREATE TABLE email_codes (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, purpose TEXT NOT NULL,
  email TEXT NOT NULL, email_key TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 1, last_sent_at INTEGER NOT NULL, mail_error TEXT);
CREATE TABLE email_key_fails (email_key TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (email_key, day)) WITHOUT ROWID;
CREATE TABLE reset_codes (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, purpose TEXT NOT NULL DEFAULT 'reset',
  code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL);
CREATE TABLE known_devices (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (account_id, device_hash)) WITHOUT ROWID;
CREATE TABLE host_admins (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, pass_hash TEXT,
  created_at INTEGER NOT NULL, last_login INTEGER, pass_changed_at INTEGER);
CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  last_action INTEGER NOT NULL, reauth_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, address TEXT, via TEXT NOT NULL);
CREATE INDEX admin_sessions_principal ON admin_sessions(principal);
CREATE TABLE host_setup (k TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE custom_terms (id INTEGER PRIMARY KEY, term TEXT NOT NULL, term_key TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('block','mask','flag')), scope TEXT NOT NULL CHECK (scope IN ('chat','names','both')),
  match TEXT NOT NULL CHECK (match IN ('word','phrase','strong')), context_json TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'typed', confirmed_at INTEGER, confirmed_by TEXT,
  hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE UNIQUE INDEX custom_terms_key ON custom_terms(term_key, scope);
ALTER TABLE chat_log ADD COLUMN room_uid TEXT;
ALTER TABLE chat_log ADD COLUMN display TEXT NOT NULL DEFAULT 'as-typed';
CREATE INDEX chat_log_room ON chat_log(room_uid, id);
CREATE TABLE chat_tags (chat_id INTEGER NOT NULL REFERENCES chat_log(id) ON DELETE CASCADE, tag TEXT NOT NULL, ts INTEGER NOT NULL,
  account_id TEXT, PRIMARY KEY (chat_id, tag)) WITHOUT ROWID;
CREATE INDEX chat_tags_tag ON chat_tags(tag, ts);
CREATE INDEX chat_tags_account ON chat_tags(account_id, ts);
CREATE TABLE conduct_daily (account_key TEXT NOT NULL, day INTEGER NOT NULL, tag TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (account_key, day, tag)) WITHOUT ROWID;                    -- account id, or 'g:<name_key>' for guests
CREATE TABLE flag_reviews (chat_id INTEGER PRIMARY KEY REFERENCES chat_log(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok','followup')), by TEXT NOT NULL, at INTEGER NOT NULL, note TEXT);
CREATE TABLE wellbeing_acks (chat_id INTEGER PRIMARY KEY REFERENCES chat_log(id) ON DELETE CASCADE, acked_at INTEGER NOT NULL,
  acked_by TEXT NOT NULL, note TEXT);
CREATE TABLE device_checks (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, browser TEXT NOT NULL, results_json TEXT NOT NULL); -- 7 days
ALTER TABLE reports ADD COLUMN recent_ids TEXT NOT NULL DEFAULT '[]';
CREATE VIRTUAL TABLE chat_fts USING fts5(original, shown, content='chat_log', content_rowid='id', tokenize='trigram');
INSERT INTO chat_fts(chat_fts) VALUES('rebuild');
CREATE TRIGGER chat_log_ai AFTER INSERT ON chat_log BEGIN
  INSERT INTO chat_fts(rowid, original, shown) VALUES (new.id, new.original, new.shown); END;
CREATE TRIGGER chat_log_ad AFTER DELETE ON chat_log BEGIN
  INSERT INTO chat_fts(chat_fts, rowid, original, shown) VALUES ('delete', old.id, old.original, old.shown); END;
CREATE TRIGGER chat_log_au AFTER UPDATE OF original, shown ON chat_log BEGIN
  INSERT INTO chat_fts(chat_fts, rowid, original, shown) VALUES ('delete', old.id, old.original, old.shown);
  INSERT INTO chat_fts(rowid, original, shown) VALUES (new.id, new.original, new.shown); END;
```

**Notes on the schema:**
- The draft's `INSERT INTO chat_fts(chat_fts, rank) VALUES('secure-delete', 1)` is **removed** (§0 fact 4). Connections keep `PRAGMA secure_delete = ON` and `foreign_keys = ON` (both already set).
- `mod_actions.action` has no CHECK constraint, so the new kinds need no migration: `announce`, `view`, `reveal`, `reveal-email`, `export`, `purge`, `settings`, `login`, `login-fail`, `logout`, `reauth`, `account-reset`, `account-delete`, `approve`, `reject`, `disable`, `roster`, `room-create`, `room-close`, `room-reset`, `terms`, `terms-confirm`, `backup`, `restore`, `recovery`, `verify-lockout`, `wellbeing-ack`, `cert`.

---

## 7. Offline operation

- **Fonts:**
  - Remove the Google Fonts links (`index.html:20-22`).
  - Self-host Orbitron (variable woff2) and Rajdhani (500/600/700 latin) in `src/client/public/fonts/`, with `OFL.txt` and `font-display: swap`.
  - This is a one-time fetch (deps); about 100 KB is committed.
  - Fallback stack: `Orbitron, Rajdhani, "Segoe UI", system-ui, sans-serif`.
- **No other internet calls:** no analytics, telemetry or update checks. The panel, landing, check and display pages use `default-src 'self'`.
- **The only outbound traffic** is SMTP, when configured.
- **Checks:**
  - the build fails on any `http(s)://` in the built html, css or manifest;
  - an offline e2e test in headless Chrome (`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"`) must render the title screen within 3 s.

---

## 8. Privacy for students

### 8.1 What is stored, where, for how long, and who sees it

Everything is stored on the host PC only.

| Data | Where | Retention (default) | Host admin | Moderator | Player |
|---|---|---|---|---|---|
| Username, created, last login, state, roster flag | `accounts` | until deleted | ✔ | name only | own |
| Email | `accounts` (full, or hash + hint) | until deleted | ✔ (masked; reveal ★ audited) | ✘ never | own, masked |
| Password, codes, sessions, device ids | hashes only | until expiry | ✘ | ✘ | ✘ |
| Every chat line: original, shown, display, tags, room, channel, team, callsign, account, address | `chat_log`, `chat_tags`, `chat_fts` | 90 days (days, term or forever); addresses minimised after 7 days in School | ✔ (originals ★) | shown text only; no addresses; no wellbeing | ✘ |
| Per-student tag counters | `conduct_daily` | records retention (365 days) | ✔ | ✘ | ✘ |
| Wellbeing lines | `chat_log`, `wellbeing_acks` | original cleared 30 days after acknowledgement | ✔ ★ | ✘ | ✘ |
| Guest callsigns, room names | `chat_log` | chat retention | ✔ | ✔ | ✘ |
| Reports (ids plus shown copies), actions, bans | `reports`, `mod_actions`, `bans` | 365 days | ✔ | per tier (§5.2) | ✘ |
| Custom terms | `custom_terms` | until removed | ✔ | ✘ | ✘ |
| Device-check results (no identity) | `device_checks` | 7 days | ✔ | ✘ | ✘ |
| Deletion ledger (ids and hashes) | `deletions.jsonl` | kept (it enforces deletions) | ✔ | ✘ | ✘ |
| Loot, cosmetics | `profile_json`, `loot_ledger` | until deleted (ledger 30 days) | – | – | own |
| Host logs | `data\logs` | 14 days; no text, no names | ✔ | ✘ | ✘ |
| Exports saved on the PC | `data\exports` | 7 days | ✔ | ✘ | ✘ |
| Backups | `data\backups` (encrypted) | at most 35 days | ✔ | ✘ | ✘ |
| The player's device | `localStorage` (device id, settings; token unless "Public computer") | until sign-out | – | – | own |

### 8.2 School defaults and handling

- **The filter stays strict.** Every settings change is audited.
- **Accountability** needs Required email with the school domain and guests off, **or** roster accounts with guests off.
- **Transparency:** the notice is generated from the settings (§4.15): who can read chat, how long lines are kept, "the unfiltered text is kept", and how to ask for a copy or deletion. It appears at signup, at the top of the chat panel and in the zone MOTD.
  - Guest lines keep the device's network address for 7 days, which a school can link to a student. `docs/LAN-PRIVACY.md` and the notice say so.
- **FERPA-style records:** conduct records tied to school accounts are student education records.
  - The host PC is the only store; backups are encrypted copies.
  - Disclose them only to school officials with a legitimate interest, following district policy. Use the per-student export or print view.
  - This is design guidance, not legal advice; district policy wins.
- **Minimisation:**
  - `hashOnly` email storage;
  - roster accounts store no email at all;
  - address minimisation;
  - moderators never see addresses or originals;
  - logs carry no names.
- **Delete, pseudonymise and purge** (§4.13, §5.5), plus the ledger (§6.4). Backups age out within 35 days, and the UI says so.
- **Wellbeing** is never punished (the `MSG_CARE` path plus 988). It is the host's alone, and nameless until opened.

### 8.3 Disk growth of the full chat log

**Measured bytes per line:** 289 B with today's indexes, 307 B with the room index, 457 B with FTS5 trigram. `chat_tags` and `conduct_daily` add under 1%, because only about 2% of lines are tagged. **The budget is 500 B per line.**

| Scenario (30 students) | Lines / class-hour | MB / class-hour | 90 days (3 classes/day × 60 days) | School year (180 days) |
|---|---|---|---|---|
| Quiet (0.5 / min / student) | 900 | 0.45 | 81 MB | 243 MB |
| Typical (1 / min) | 1,800 | 0.9 | 162 MB | 486 MB |
| Chatty (3 / min) | 5,400 | 2.7 | 486 MB | 1.46 GB |
| Home (4 players, 2 h / week) | about 500 / week | – | about 3 MB | about 12 MB |

- **Backups:** a typical year-end DB (about 490 MB) gives an encrypted backup of about 160 MB. The 35-day age cap and the 2 GB cap bound them.
- **When to archive:** at each term end (export to district storage, then purge), whenever the **DB over 1 GB** banner shows, and before shortening retention.
- **Speed at 1M lines** (owner's PC; a school PC is 2–3× slower):
  - FTS search: 14 ms, in the worker;
  - context: 0.12 ms;
  - Conduct from counters: under 1 ms;
  - a purge: about 1.5 ms per 250 rows, in the worker;
  - `optimize`: about 4 s, in quiet windows only.

---

## 9. School IT notes and home notes

### 9.1 `FOR SCHOOL IT.txt` (one page; also `docs/LAN-SCHOOL-IT.md`)

**What it is:**
- a portable folder: the official OpenJS-signed `node.exe` 24.x plus plain-text JavaScript;
- it listens on **TCP 7777** (game: http and https) and **7778** (control panel: loopback, plus https only if the teacher enables remote access);
- its only outbound traffic is SMTP, when configured;
- it installs nothing, changes no registry and runs no service.

**Process tree and writes:**
- `cmd.exe` → `node.exe` (launcher) → `node.exe` (server, sandboxed with `--permission`) plus a worker thread.
- The launcher also runs read-only `powershell.exe` (`Get-NetConnectionProfile`, `Get-Volume`), `netsh`, `powercfg`, `icacls`, `whoami`, `tasklist` and `netstat`, and `explorer.exe` on request.
- It writes only inside `…\Voidswarm LAN\data\`, plus the off-PC backup folder if one is configured.

**The host PC:**
- **Install location:** `%USERPROFILE%\Voidswarm LAN` for the teacher's account. The launcher refuses OneDrive, Temp, Downloads, UNC and FAT paths, and in School mode refuses folders other users can write.
- **AppLocker or WDAC:** allow `runtime\node.exe` (publisher OpenJS Foundation) **and** the script rule for `…\Voidswarm LAN\*.cmd`. **Scope both to the teacher's user or group plus this path**: a global OpenJS allow would hand every student a script runtime. The default script rules (only `%WINDIR%` and `%PROGRAMFILES%`) otherwise block the `.cmd`.
- **Antivirus and EDR:** Defender attack-surface-reduction prevalence rules and Bitdefender may need an exclusion for `…\runtime\node.exe`; a Sigma rule flags "node.exe running a .js file". It never runs as administrator (it refuses in School mode).
- **SmartScreen and Smart App Control:** unblock the zip before extracting, or deliver the folder from a network share or USB.
- **Firewall:** by GPO, an inbound **program** rule for `…\runtime\node.exe` (no port) on the **Domain** and Private profiles. Never run the `.cmd` elevated from a user folder.
- **Addresses:** a **DHCP reservation** for the host. With a USB-C dock, reserve the **dock's** MAC. Wired Ethernet.
- **BitLocker** and a Windows password.

**The network:**
- Student Wi-Fi client isolation: allow the student VLAN → host IP on TCP 7777 (and 7778 only if remote admin is used).
- Proxy or PAC: **DIRECT** for the host IP. A cloud proxy (Securly, Lightspeed, iboss, Zscaler) can't reach a private IP. The panel flags proxied requests.
- Web filter and `URLAllowlist` (allowlist-only OUs): `http://<host-ip>:7777` (the start page) **and** `https://<host-ip>:7777`.
- Teacher tools (GoGuardian Teacher scenes, Hāpara, Securly Classroom): add both URLs, or they close the tab. A teacher can do this without IT.

**Chromebooks:**
- **Best:** push `voidswarm-lan-ca.crt` (**PEM**) under Devices → Networks → Certificates for the classroom OU. Optionally use `CACertificatesWithConstraints` with `permitted_cidrs=<host-ip>/32`.
- **Or:** give the host **its own certificate** (Settings → Network) for an internal DNS name, for example `voidswarm.caldwellschools.org`. There is then no push and no warnings.
- **Otherwise:** `SSLErrorOverrideAllowedForOrigins` = `https://<host-ip>:7777`. Prefer pushing the certificate: weekly click-throughs teach students to ignore certificate warnings.
- `CACertificateManagementAllowed = 2` (students can't import) is fine.

**iPads:** deliver the certificate payload through MDM.

**Every IP-based rule breaks when the address changes.** Reserve it, or use the DNS name.

**Mail** (only for school-email verification):
- outbound 587/465 from the host to the relay;
- or the Workspace SMTP relay for the school's public IP;
- a dedicated no-reply mailbox;
- a student test mailbox for the test button.

**Incident:** host lost or compromised → remove the Voidswarm certificate from the OU now; the teacher makes a New certificate.

**Data:** accounts, the full chat log and conduct records stay in `data\` on the host PC. `docs/LAN-PRIVACY.md` is the data sheet for the district privacy officer.

**Before rollout:** open `http://<host-ip>:7777/check` on a student-profile Chromebook.

### 9.2 Home notes

- Extract to `%USERPROFILE%\Voidswarm LAN`, **not** the Desktop: on this PC it is OneDrive.
- The network profile must be **Private**.
- Allow `runtime\node.exe` in **Bitdefender Firewall**, and add an ATD exception if it is ever flagged.
- Router guest networks and AP isolation block players. Use the main Wi-Fi.
- **Phones:** scan the QR code (the start page).
  - Android: install `/ca.cer` once, or click through.
  - **iPhone and iPad:** install the profile (once T-LAN-5b passes), or use the http link.
  - Controllers are expected to work over both (T-REL-3).
- **The Home preset:** guests on, email optional, the chat log kept.

---

## 10. Mac and Linux hosts (npm path; packaged later)

- **From source:** `npm ci && npm run build && npm run lan -- --data ./data-lan`. It runs the same launcher, sandboxed child, front door, TLS and panel. `npm start` (no LAN features) keeps working.
- **From the Windows zip:** `app\` and `web\` don't depend on the OS; `node app/launch.mjs` works with Node 24 installed. Add `start-host.command` and `start-host.sh`.
- **Secrets:** the same `data/secrets/` model, with 0700/0600 modes checked at start.
- **Firewall:** macOS asks "accept incoming connections" for `node`; on Linux, `ufw allow 7777/tcp`.
- **Checks** use the OS equivalents (`ls -l`, the network service and `pmset` on macOS). Windows-only checks are skipped with a note.
- **Later:** per-OS zips; macOS signing and notarisation cost extra. Chromebooks cannot host.

---

## 11. Code changes per module, with acceptance tests

Tests use ephemeral ports (`listen(0)`), never 7777, 7778, 5173 or 5621. Manual release gates are in §11.13.

### 11.1 Build and packaging

**Changes:**
- `package.json`: version 0.6.0; the scripts `package:lan` and `lan`; pin `esbuild` 0.28.2.
- `scripts/build-lan.mjs`, `scripts/lan/templates/*` (the 5 stubs, `START HERE.html`, the IT sheet, notices, VERSION), and `scripts/lan/vendor/node-LICENSE`.
- `.gitignore` gains `/release/`.
- `scripts/host-local.*` stays for developers.
- `scripts/host-online.ps1` prints "not for the LAN edition" when pointed at a LAN-edition data folder. The server-side tunnel refusal is the real guard (§3.2).

**Tests:**
- **T-PKG-1:** the zip is 40 MB or less, and its `.sha256` matches.
- **T-PKG-2:** the staged tree equals §2.1 (a manifest test).
- **T-PKG-3:** `node.exe` has a `Valid` signature from OpenJS Foundation and is Node major 24.
- **T-PKG-4:** no `http(s)://` in the built web files; the offline e2e test passes.
- **T-PKG-5:**
  - extract to `%TEMP%\t\Room 136 (Mr. O'Brien) & Co\Voidswarm LAN` with the location check disabled by a test flag, and run from cwd `C:\Windows\Temp`;
  - expect: http `/` landing; https `/` 200; admin `/` 200 with the CSP; a ws `welcome`; the DB created;
  - after a stop, one checkpointed DB file remains.
- **T-PKG-6:** a stub copied out alone gives "Unzip the WHOLE folder first" (exit 1). With `runtime\node.exe` deleted, it gives the antivirus message.
- **T-PKG-7:** `server.mjs` is unminified and keeps its licence comments.
- **T-LAN-17:**
  - `tool update` with a newer zip keeps `data\` and the root path, and moves `app\` to `previous\`;
  - `--rollback` restores it, and restores the pre-update backup when the schema changed;
  - a running host blocks the update.

### 11.2 Launcher (new `src/lan/`)

**Files:**
- `launch.ts`: the parent (§2.2);
- `paths.ts`: location rules;
- `acl.ts`: parse `icacls` output, build the fix;
- `elevation.ts`;
- `motw.ts`;
- `pipe.ts`: the lock and its commands;
- `ports.ts`: pair choice and the connect-probe;
- `preflight.ts`: network category, firewall, power, disk, cached;
- `child.ts`: spawn with `--permission`, IPC, supervise;
- `banner.ts`, `console.ts`;
- `import.ts`: the browser-driven import, untrusted checks, MOVED-TO;
- `restore.ts`, `update.ts`;
- `tool.ts`: `update`, `restore`, `admin-reset`, `admin-set`, `backup`, `fix-permissions`, plus the mod CLI;
- `tls/asn1.ts`, `tls/certgen.ts` (adds the root and issuing-CA hierarchy), `tls/ensure.ts` (primary-only identity, scope, approvals);
- `netwatch.ts`, `primary.ts`: default-route source, RFC 1918 filter, pin;
- `display/*`, `landing/*`, `check/*`.

**Tests:**
- **T-LAN-1:** with a listener on `127.0.0.1:P`, the probe reports the pair as busy. Home picks the next pair and persists it; School refuses with the holder's process name.
- **T-LAN-2:** a second launch on the same `data\` opens the running panel's URL (mocked browser) and exits 0.
- **T-LAN-3:** refuse under a simulated `%OneDrive%`, `%TEMP%\Temp1_x`, Downloads, a UNC path, a FAT volume or Program Files; each message suggests `%USERPROFILE%\Voidswarm LAN`.
- **T-LAN-4:** `SIGHUP` to an in-process host: every line typed before it is in the DB within 1 tick of arrival, and the pipe is released within 4 s.
- **T-LAN-5 (port of `test-ensure.mjs`, two-level):**
  - first run: root #1, an issuing CA and a leaf; the root key is never written (scan `data\`);
  - relaunch: no change;
  - a primary change inside a /24 scope: a new leaf with the same root, hot-swapped;
  - a new network: no root until approved (Home) / never (School);
  - after approval: root #2; back home: root #1 reused;
  - +380 days: the leaf renews;
  - OpenSSL and `node:tls` check every step, and an out-of-scope leaf signed by the issuing key is rejected ("permitted subtree violation").
- **T-LAN-5b (manual, VM):** see §11.13.
- **T-LAN-6:** the front door serves http, https, ws and wss on one port; a silent socket closes at 10 s, and an unfinished TLS handshake at 10 s.
- **T-LAN-8:** the landing page over http on the LAN Host; the game over https and localhost; `/admin` on the game port gives the pointer page.
- **T-LAN-9:** a Host outside the allowlist gets 421 on both listeners.
- **T-LAN-10 (manual, conhost):** a QuickEdit selection held for 60 s never stalls the tick counters (the child keeps its own log).
- **T-LAN-11:** a root with `Authenticated Users:(M)`: School refuses and offers the fix, Home warns; after `--fix-permissions` the check passes.
- **T-LAN-12:** a simulated High-integrity token: School refuses, Home starts with a banner.
- **T-LAN-13 (sandbox):** from the child, writing outside `data\` fails with `ERR_ACCESS_DENIED`; `child_process.spawn` fails; `ATTACH` and `VACUUM INTO` are denied by the authorizer.
- **T-LAN-14:** after `kill -9` of the parent, the next start acquires the pipe.
- **T-LAN-15:** import from a planted sibling DB with an extra trigger is refused. A clean one imports without `host_admins`, writes MOVED-TO, and the old copy then refuses to start.
- **T-LAN-16:** the real Start stub with stdin redirected (`<nul`) starts, and the first-run import offer appears in the browser flow (no console prompt).
- **T-LAN-18 (adapter churn):** Tailscale 100.x, WSL vEthernet, hotspot 192.168.137.1, a global IPv6 address and an IPv6 prefix change each leave the root number, leaf, QR and binding unchanged.
- **T-LAN-19:** a simulated 60 s wall-clock gap gives the "was asleep" banner and a log line.

### 11.3 Server entry and front door (`src/server/index.ts`, new `app.ts`, `frontdoor.ts`, `listeners.ts`)

**Changes:**
- **`startServer(opts): Promise<RunningServer>`.** `index.ts` keeps the env boot. The options add `dataDir`, `settings`, `tls`, `lan`, `logSink`, `adminPageDir`, `ipc`, `primary`.
- **Two listeners** (§3.1), the Host and Origin rules, the proxy rules, `isHostPc`, and the DoS limits.
- **The signInOverHttp gate** on every credential or token endpoint and on the ws hello.
- **Process handling:**
  - the listen `error` handler (exit 2);
  - `uncaughtException` (flush, exit 1);
  - SIGHUP and SIGBREAK;
  - the flush-first shutdown;
  - end-of-tick chat writes.
- **When `lan` is set,** a DB open failure is fatal.
- **`onHello`:** state enforcement and the guests-off rule.

**Tests:**
- **T-SRV-1:** a `verify` token in `hello` is kicked with the code message and never becomes a guest.
- **T-SRV-2:** with guests off, a tokenless hello from a LAN test address is kicked, while `isHostPc` is accepted as "Host PC".
- **T-SRV-3:** a busy port exits with code 2 and a message.
- **T-SRV-4:** `lan` plus an unreadable DB rejects with the data-folder message.
- **T-NET-1:**
  - a loopback socket with `CF-Connecting-IP` or `X-Forwarded-For` gets 403 on the game port;
  - a LAN socket with `Via` is served, flagged, and never counted as that header's address;
  - the admin listener refuses any forwarding header;
  - `127.0.0.1` with Host `x.trycloudflare.com` gets 421 and no host rights.
- **T-NET-2:** a ws from Origin `https://evil.example` gets 403; same-origin connects; no Origin from loopback connects without host-PC rights.
- **T-NET-3:** the 129th socket from one address before the upgrade is refused.
- **T-NET-4:** a `/check` report appears in `checks/list`.
- **T-NET-5:** a Public network category (mocked preflight), or an unapproved network, leaves the game listener loopback-only.

### 11.4 Settings (new `src/server/settings/`)

**Files:**
- `schema.ts`: `HostSettings`, the presets (§5.13) and `validate`;
- `store.ts`: atomic writes, `rev`, env seeding;
- `secrets.ts`: files in `data\secrets` with ACL/mode checks;
- `service.ts`: get, update, subscribe, audit.

**Tests:**
- **T-SET-1:** env seeding on the first run; later, one warning per differing variable.
- **T-SET-2:** a stale `rev` gets 409.
- **T-SET-3:** one audit row per changed leaf; the password shows as `(changed)`.
- **T-SET-4:** `required` without `lastTest` gets 409 `needsMailTest`.
- **T-SET-5:** lowering `maxRooms` blocks the next create live; running rooms survive.
- **T-SET-6:** a crash during a write leaves the previous config readable.
- **T-SET-7:** the School preset gives the §5.13 values, and `moderators.tier` can't be set to `trusted` under School.

### 11.5 Auth (`src/server/auth/`)

**Changes:**
- `emailPolicy.ts`;
- `service.ts`: optional email and the sentinel; states; `signup` modes; roster import and first-login codes; verify, resend, email change, password change, sign-out-everywhere, reset by code, self-delete; known devices; scaled limits; the per-`email_key` fail cap; disabled only after the password; generic 409s; the dev mailer off in LAN;
- `store.ts`: migration v4 and the backfills;
- `mailer.ts`: `sendVerify`, `sendTest`, `sendAlert` (content-free), `reconfigure`;
- `index.ts` (frozen → ARCHITECTURE.md §3b): `sessionState(token)` and `admin(): AuthAdmin` (list, get, findEmail, resetCode, unlock, approve, reject, disable, delete, export, signOutEverywhere, rosterImport, setPolicy). `verifyToken` returns null for non-active accounts.

**Tests:**
- **T-AUTH-1:** the policy table, as in the draft (case, subdomains, label boundaries, Cyrillic, punycode, trailing dot, quoted, IP literal, Unicode local part, plus-address key, dots at a school domain vs gmail).
- **T-AUTH-2:** Optional mode registers two email-less accounts; `emailMasked` is `''`; `forgot` never matches the sentinel.
- **T-AUTH-3:** Required mode: one mail with a 6-digit code; 5 wrong tries void it; 15 minutes expire it; resend is 429 within 60 s; the 6th send in an hour is 429; only a hash is stored.
- **T-AUTH-4:** the wrong domain gets the school message and costs no send.
- **T-AUTH-5:** with approval on, code → `approval` → `approve` → `active`.
- **T-AUTH-6:** an email change keeps the old email until the new code is entered.
- **T-AUTH-7:** `verifyAtNextLogin` vs `grandfather`.
- **T-AUTH-8:** a reset code works once, lasts 10 minutes, allows 5 attempts, revokes sessions and lifts the lock. The email-send variant arrives at the verified address.
- **T-AUTH-9:** a mail failure gives 503 `failed`, the account exists, and the banner count goes up.
- **T-AUTH-10:** v3 → v4 keeps the child tables; duplicate keys get flagged; report copies are rewritten shown-only; a v5 DB is refused.
- **T-AUTH-11:** `signInOverHttp = block`: `login`, `register`, `reset/code`, `account/*`, `verify` and `me` over http from a LAN address get 403, and a ws hello with a token over `ws` is refused; localhost gets 200.
- **T-AUTH-12:** Home: 30 registrations per hour from one address succeed and the 31st gets 429. School or a shared address: 120 succeed and the 121st gets 429.
- **T-AUTH-13:** 10 wrong passwords from an unknown device lock the account for unknown devices, while the student's known device still signs in. The lock event is visible to the host.
- **T-AUTH-14:** 20 failed verifications per day on one `email_key`, across replaced pending accounts, lock that email for 24 h with a banner.
- **T-AUTH-15:** a disabled account's message appears only after the correct password; `account/email` to a taken email gives the generic 409.
- **T-ROST-1:** a roster import dry run, then a commit, then the slips (print view contains username and code), then first login with the code sets the password; the code is then dead; a reprint replaces the code.
- **T-ROST-2:** `rosterOnly` answers 403 to `/api/register` with the slip message.
- **T-ROST-3:** a roster code expires after 14 days.

### 11.6 Moderation and admin API (`src/server/moderation/`, new `src/server/maint/`)

**Changes:**
- `hostAdmin.ts`: credential, setup code with backoff, sessions (idle, absolute, bound to address and `via`), step-up, the host-PC scrypt lane.
- `capabilities.ts`: `can(principal, cap)`, the §5.2 table, used by `http.ts` and `commands.ts`.
- `http.ts`: per-route `{ cap, sensitive, hostPcOnly, bodyLimit, file }`, every §5.15 endpoint, moderator scrubbing, async handlers, `adminPageDir`. Status and rooms still answer when the DB is down.
- `commands.ts`: every command through `can()`; the limited-tier behaviour of §5.2; no originals, no reporter names and no SELF-HARM lines for limited moderators.
- `service.ts`:
  - the live ring and waiters;
  - `ZoneControl` gains `announce`, `rooms`, `createRoom`, `closeRoom`, `resetHouse`, `setLimits`, `setChatOptions` and `stats`;
  - tag policy (strikes, auto-mute, notify);
  - alert routing: wellbeing to the host only, threat to host plus trusted moderators with no text;
  - log redaction; the NAT detector; custom-term compile via `setCustomTerms` (unconfirmed → flag); audit kinds.
- `store.ts`: the insert adds `room_uid`, `display`, tags and counters; reports store ids plus shown text; point queries only (heavy work moves to `maint/`).
- `maint/worker.ts`, `maint/client.ts`: the worker protocol (query, stream, chunked write, backup, optimize, compact) and quiet-window scheduling.
- `csv.ts`: the shared CSV writer.
- `cliCore.ts`: `admin-set`, `admin-reset`, `settings get`, `backup`, `restore`, `fix-permissions`.
- `adminApi.md`: rewritten conventions and endpoints, plus a fix for the stale CSP line.

**Tests:**
- **T-ADM-1:** setup via `isHostPc` with the right code gives 200; from a LAN address 403; bad Host 421; already set up 404; 5 wrong codes then a 60 s wait, doubling.
- **T-ADM-2:**
  - host login; 5 wrong from one LAN address gives 429 while localhost still works;
  - 30 minutes idle gives 401; 12 h gives 401;
  - a password change revokes the others;
  - a token used from another address gives 401.
- **T-ADM-3:**
  - `remoteAccess off`: LAN login 403;
  - `limited` over TLS: Live and Rooms 200, `conduct/*` 403;
  - `full` without `devicesTrustCert`: it behaves as `limited`;
  - plain http from LAN: always 403.
- **T-ADM-4 (moderator matrix, HTTP and in-game):**
  - limited: `/log` returns no originals and no SELF-HARM lines; `/unban` of a host ban is refused; `/reports` hides the reporter; `/whois` shows only the room and mute; acting on a moderator is refused; `/ban` answers "Ask the host";
  - no moderator session ever receives `address`, `email` or `original`;
  - `moderatorView` off makes moderator login 403.
- **T-ADM-5:** `chat/live` resolves within 100 ms of a new line; `gap`; more than 4 waits gives 429; an abort frees the waiter; default lines contain no `original`.
- **T-ADM-6:** context from the same `room_uid`, with the legacy fallback.
- **T-ADM-7:** at 1M synthetic rows, a `log` search returns within 50 ms, from the worker.
- **T-ADM-8:** purge without the count gives 409 with the count; with it, the rows, their tags, counters, reviews and report copies are gone, the ledger has the entry, and after the next `optimize` a MATCH returns 0.
- **T-ADM-9:** term retention: no purge before the date; at date + grace, a purge after a backup; no next date within 14 days → it falls back to 90 days, with a banner.
- **T-ADM-10:** `accounts/delete`:
  - `pseudonymise` keeps the rows as "Former player #N" with `original` empty;
  - `delete` removes their lines, the reports they filed and the reports about them, and anonymises actor and target audit rows;
  - a username in audit reason text is scrubbed;
  - the `guestEra` option removes the matching guest rows;
  - the ledger entry is written.
- **T-ADM-11:** every `conduct/student` and every reveal writes an audit row, even when repeated within 60 s.
- **T-ADM-12:**
  - a `customTerms/import` dry run reports per-row errors;
  - after a merge, a matching line is shown unchanged with `action: 'flag'` and tag GANG, and gets no strike;
  - after `customTerms/confirm`, the same line is blocked, substituted and struck;
  - a moderator sees only the tag.
- **T-ADM-13:** rooms of 3 types at once; close with players pays leave grants and sends the reason; a house room can reset but not close.
- **T-ADM-14:** `announce` everywhere vs one room; logged as `announce`.
- **T-ADM-15:** `smtp/test` against a local fake SMTP server gives 200; bad auth gives 502 `auth`; the password never appears in any response.
- **T-ADM-16:** a demoted, disabled, banned or deleted moderator's next call gets 401.
- **T-ADM-17:** a sensitive call more than 10 minutes after the last deliberate action gets 401 `reauth`; `reauth` makes it work; live polling never refreshes freshness; `liveKeepsAlive` ends by 3 h.
- **T-WB-1:**
  - a SELF-HARM line produces a nameless alert and nothing in moderator feeds, in-game alerts or the log file;
  - `wellbeing/open` is ★ and audited;
  - after an ack plus 30 days, the original is empty;
  - class and "everything" exports leave it out unless ticked.
- **T-CSV-1:** every export (chat, conduct, accounts, custom terms) neutralises cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return.
- **T-PERF-2:** for each panel endpoint at 1M rows, the main-thread event-loop delay stays at p99 < 5 ms and max < 20 ms while it runs.
- **T-PERF-3:** a 200k-row purge in the worker keeps auth write p99 < 50 ms and loses no chat lines.

### 11.7 Admin UI (`src/server/moderation/admin/`, `src/lan/display/`)

**Changes:**
- `admin.html`: login (Host/Moderator), setup (fragment code), reauth dialog, 12 tabs, banners, Presenting toggle, print root.
- `admin.js`: the capability-driven tabs, the long-poll, reveal flows, the idle and freshness countdowns, blob downloads, the print views (conduct, slips), the wake lock.
- `qr.js`: the vendored `qrcode-generator` (deps), or a hand-written encoder.
- `admin.css`, `admin.d.ts`.
- `display.html` and `display.js`.
- The strict CSP stays.

**Tests:**
- **T-UI-1:** every `ENDPOINTS` entry is documented in `adminApi.md`.
- **T-UI-2:** no inline script.
- **T-UI-3 (jsdom):** a limited moderator's `me` shows only Live, Reports and Rooms.
- **T-UI-4:** the print view has "Confidential — student conduct record", the attribution note, and substituted lines labelled.
- **T-UI-5:** the QR canvas matches a known test vector for the landing URL.
- **T-UI-6:** the default Live and Chat-log DOM contains no `original` of a blocked line; Presenting hides names; a reveal triggers one audited call.
- **T-UI-7:** the reauth dialog appears on a 401 `reauth` and retries the call.
- **T-UI-8:** `/display` shows no chat text, names or alerts.

### 11.8 Shared room (`src/shared/room/`)

**Changes:**
- **`Zone.ts`:**
  - `ZoneOptions.limits` and `setLimits()`;
  - `setChatOptions({ substitute, positiveLines, strictness })`;
  - `announce()`, `adminRooms()`, `adminCreateRoom()`, `adminCloseRoom()`, `resetHouseRoom()`;
  - `pinned` rooms;
  - log accepted guest callsigns and room names;
  - `roomUid` and `display` on every entry;
  - **substitution** in `chatGate` (a deck seeded from `bootId` via `Rng`; broadcast to everyone except the sender; team audience);
  - the escalating private warnings;
  - the SELF-HARM withheld path with `MSG_CARE` + 988;
  - tick timing and wall-clock-gap detection;
  - the reserved names.
- **`moderation.ts`:**
  - `LogChannel` gains `'announce'`;
  - `ChatLogEntry` gains `roomUid` and `display`;
  - new message constants for the warnings;
  - `MSG_CARE` gains 988;
  - a `tagsOf(hits)` helper;
  - `ChatAction 'flag'` and the `custom:`/`flag:` labels **already landed** in the working tree.
- **`Room.ts`:** `host.roomNameAccepted()`, and a broadcast that can skip the sender.
- **`constants.ts`** (frozen) is unchanged.

**Tests:**
- **T-ROOM-1 (channel coverage pin):** a line in the lobby, in room `all`, in room `team` and with a `//` prefix gives exactly 4 entries with the right channel, team and `roomUid`. Iterating every client-sendable `ChatChannel` fails the test if a new channel is not logged.
- **T-ROOM-2:** a guest joining as `Nova` and then `/name Vega` logs both as `pass`; an account holder's `/name` logs nothing.
- **T-ROOM-3:** `setLimits({ maxPlayingRooms: 1 })` makes the second match wait.
- **T-ROOM-4:** a pinned room survives 120 s empty; an unpinned one closes at 60 s.
- **T-ROOM-5:** the determinism smoke and the parity tests pass; no `Math.random` in `src/shared/sim` or `src/shared/room`.
- **T-CHAT-1:**
  - a blocked line → the other clients get a positive line under the sender's name, and the sender gets only the generic warning, which names no term or category;
  - `display = 'substituted'`, and `shown` is the positive line;
  - no line repeats twice in a row over 200 substitutions;
  - the 2nd and last-before-mute wording escalates;
  - modes `system` and `hide` work;
  - team lines reach only the team.
- **T-CHAT-2:** each built-in category maps to its tag (§5.8); the custom category `gang` maps to GANG; `bullying` maps to BULLYING; `conduct_daily` increments once per tag per line.
- **T-CHAT-3:** SELF-HARM is withheld, with `MSG_CARE` including 988, no strike, and an urgent alert; THREAT is substituted with an urgent alert; flag lines are unchanged with no warning; offline play vs bots substitutes and warns, and logs nothing.

### 11.9 Shared filter (`src/shared/moderation/`)

- **Landed in the working tree** (the engine builder): `custom.ts` (`compileCustomTerms`, `setCustomTerms`, `CUSTOM_LIMITS`), `FilterAction 'flag'`, `HitTier 'flag'`, `FilterHit.source`, and `Zone.chatGate` mapping `flag`.
- **0.6.0 adds:** nothing in the engine. The server decides what is unconfirmed, by compiling those entries as `flag`.
- **Tests:**
  - **T-FLT-1:** an anchor-gated flag term flags only with its anchor;
  - **T-FLT-2:** `strict` stays the default;
  - **T-FLT-3:** the perf test passes with 2,000 custom terms;
  - **T-FLT-4:** diagnostics never contain a decoded built-in term.

### 11.10 Client (`src/client/`)

**Changes:**
- self-hosted fonts;
- the same-origin `serverUrl`;
- the 60 s auto-retry and close-reason text;
- the iOS `wss` hint;
- `accounts.ts`: `info`, `verify`, `resend`, `changeEmail`, `changePassword`, `signOutEverywhere`, `resetWithCode`, `deleteAccount`, policy-aware validation, the device id;
- the TitleScreen screens (§4.15), including slips and codes;
- the generated chat notice at the top of the chat panel;
- the `mobile.ts` wording;
- the `?watch=<roomId>` deep link.

**Tests:**
- **T-CL-1:** `https://10.0.0.5:7779/` → `wss://10.0.0.5:7779`; `http://localhost:5173/` → `ws://localhost:7777`; Pages → `''`.
- **T-CL-2:** policy-aware validation (Optional accepts an empty email; Required plus domains rejects gmail).
- **T-CL-3:** no request to a host other than the page's own (the offline e2e test).
- **T-CL-4:** `?watch=r2` joins as a spectator.
- **T-CL-5:** with "Public computer", the token is in `sessionStorage` and the device id in `localStorage`.
- **T-CL-6:** an unexpected close shows the host-lost text and retries for 60 s; the planned-restart reason shows "back in about 20 s".

### 11.11 Docs

- **New:**
  - `docs/LAN-EDITION.md`, the host guide (mirrors `START HERE.html`);
  - `docs/LAN-SCHOOL-IT.md` (§9.1);
  - `docs/LAN-PRIVACY.md` (§8).
- **Updated:**
  - `adminApi.md`;
  - `docs/MODERATION.md`: tags, substitution, the full log, retention, custom terms with confirmation, Conduct, roles and tiers;
  - `ARCHITECTURE.md`: the frozen-file changes (`auth/index.ts`, the `protocol.ts` Accounts block, `ZoneOptions.limits`), the moderation seams (`display`, `roomUid`, `announce`, `ZoneControl`, `can()`), and a LAN-edition section with the process model;
  - `src/server/auth/README.md`;
  - `README.md`;
  - the project `CLAUDE.md`: 0.6.0, `package:lan`, `lan`, new gotchas (the stub contract, no FTS secure-delete, admin reads in the worker, `setCustomTerms` is process-wide);
  - `docs/DEPLOY-VPS.md` and `deploy/vps/`: coordinate with the deploy builder.

### 11.12 Existing tests to update (they pin old behaviour)

- **`auth.test.ts`:**
  - 197-210 (duplicate email and `email_key`);
  - 212-230 (email validation now depends on policy);
  - 299-317 (limits now come from settings);
  - 563-640 (add v3→v4);
  - 641-646 (`maskEmail('')` → `''`);
  - 771-890 (per-account lock: unknown devices only, and Unlock).
- **`accounts.test.ts:49-63`.**
- **`serverUrl.test.ts:30-66`.**
- **`server.moderation.test.ts:258-317`:** the role matrix, the admin listener, and "game tokens refused". The CSP assertions stay.
- **`admin.test.ts`** (the endpoints list).
- **`moderation.test.ts:468-493`** (the CLI, plus `admin-set`).
- **`server.guard.test.ts:80-92`:** BIND, and CORS only for dev.
- **`room.test.ts`** 1044 / 1411 / 1680-1691 / 1824-1835: the caps now come from `ZoneOptions.limits`. Chat tests that expect masked text for others now expect substitution; `chat.substitute: 'masked'` is kept as a test-only option for the old assertions.
- **The moderator command tests** in `src/server/moderation/moderation.test.ts` (`/log` originals, `/whois`) now run under `trusted` or assert the limited behaviour.
- **`smoke.ts:215`** (unchanged shape).

### 11.13 Release gates (manual or long-running; each is a checklist item for the verifier)

- **T-PERF-1:** 36 headless ws clients over 6 rooms, with the panel's Live open. Tick p99 < 12 ms on an efficiency core or with Windows power throttling (about 2–3× slower). §1's capacity sentence ships only after this passes.
- **T-LAN-5b:** on a disposable Windows VM, install the root in CurrentUser Root; `certutil -verify` / X509Chain must reject an out-of-scope leaf from the issuing CA. Same on an iPhone with the profile. Only then do the landing and README show the Windows and iPhone install steps.
- **T-REL-1:** a fresh Windows VM:
  - download → Unblock → extract to the profile → first run;
  - the SmartScreen path when not unblocked;
  - the firewall prompt: Allow works; Cancel records a block that the preflight names and `Allow through firewall (admin).cmd` removes;
  - Bitdefender quarantine gives the stub's message.
- **T-REL-2:** the owner's PC: Bitdefender Firewall prompt and rule; Desktop extraction refused (OneDrive).
- **T-REL-3:** real Android Chrome and iPhone Safari, each with a Bluetooth controller, over http and https (click-through and installed).
- **T-REL-4:** the Screen Wake Lock on the localhost panel stops idle sleep on battery (with a 1-minute sleep setting on the VM).
- **T-REL-5:** Windows sign-out and restart with the host running lose at most one tick of chat; the result is documented.
- **T-REL-6:** a managed Chromebook (if the owner's district has a test OU): `/check`, the pushed PEM, and `SSLErrorOverrideAllowedForOrigins`.

---

## 12. Risks and open questions

1. **School policy can block hosting whatever the packaging:** AppLocker or WDAC, the Domain firewall profile, Wi-Fi isolation, proxies, web filters.
   - *Mitigation:* the IT sheet, `/check`, the proxy flag, the first-device indicator, own-certificate support.
   - **Question:** will the first classroom deployment have IT help (certificate push, firewall rule, VLAN route, DHCP reservation)? If not, expect weekly click-throughs and a teacher-only setup at the IT sheet's "teacher tools" level.
2. **Accounts without mail.**
   - *Resolved by design:* roster accounts (§4.12) need no SMTP.
   - **Question:** for the first class, roster or school-email verification? Roster is recommended.
3. **Student-records obligations.**
   - **Question:** keep `emailStorage: 'full'` and 90 days as the School defaults, or make `hashOnly` and "until end of term" the School defaults?
4. **Substitution under the sender's name (A2)** means classmates see a friendly line "from" a student who typed a slur. It is harmless, and the admin views label it.
   - **Question:** keep `sender` as the School default, or use `system`?
5. **Custom-list false positives.** Imports are unconfirmed (flag only) until the host confirms them.
   - **Question:** is "confirm before strikes" acceptable for the resource officer's list?
6. **Platform verification pending:**
   - Windows CryptoAPI and iOS enforcement of the issuing CA's constraints (T-LAN-5b);
   - real phone controllers over http (T-REL-3);
   - whether the wake lock blocks idle sleep (T-REL-4).

   Until they pass, the README doesn't promise them.

---

## 13. Decision log

**P** = privacy/security critic, **O** = operations critic. B = blocker, M = major, m = minor.

| ID | Finding (short) | Outcome | Where |
|---|---|---|---|
| P-B1 | Panel auto-opens on the projector with originals, the self-harm name and emails; a 12 h unattended session | **Accepted.** Home tab by default; `/display` page; shown text plus tags with Reveal ★; nameless wellbeing; masked emails; Presenting (School on); step-up after 10 minutes; `liveKeepsAlive` ≤ 3 h | §5.2–5.4, §5.11, §4.10 |
| P-B2 | In-game moderator commands bypass the limits | **Accepted.** One `can()` table for HTTP and chat commands; `limited` tier (fixed in School); SELF-HARM host-only; no reporter names; no originals | §5.2, §11.6 T-ADM-4 |
| P-M1 | "Host PC" spoofable (tunnel, Caddy); ws without Origin; dev-origin CORS on the admin API | **Accepted.** Separate loopback admin listener; `isHostPc`; Origin required; no CORS in the LAN edition or the admin API; loopback + forwarding header = 403; launcher refuses `TRUST_PROXY`; no host PC on the VPS. *Modified:* instead of making `host-online.ps1` refuse, the server refuses tunnels (the script is a dev tool, not shipped, and the server check covers every tunnel tool); the script only prints a warning | §3.1, §3.2 |
| P-M2 | Folder ACL not checked; OneDrive; planted-DB import; global OpenJS rule | **Accepted.** `%USERPROFILE%` location; ACL check (School refuses) with one-click fix; OneDrive/FAT/removable/UNC refused; untrusted-DB pipeline; `host_admins` never imported; IT rules scoped to the teacher plus the path | §2.2, §6.5, §9.1 |
| P-M3 | CA scope too wide; constraint enforcement unverified; plaintext key; export contradiction; fingerprint on http; no incident path | **Accepted, with a different mechanism.** The two-level hierarchy (root key never stored, constrained issuing CA) replaces "destroy the CA key after the leaf": the same theft bound, enforced by RFC 5280 on intermediates, and silent renewals keep working. /32 in School, ≤ /24 at Home; Windows and iOS install steps hidden until T-LAN-5b; the recovery file never holds certificate keys; "compare with the teacher's screen"; incident step. *Rejected:* DPAPI for the leaf key (see O-M8) | §3.3, §6.3, §9.1 |
| P-M4 | Clear-text sign-in in School; narrow gate; click-through MITM on remote admin | **Accepted.** School `block`; the gate covers every credential or token endpoint and the ws hello; password-reuse hint; sessions bound to address and `via`. *Modified:* remote sessions get the sensitive panels only in `full` mode, which requires trusted TLS (IT-pushed root, own certificate, or a public certificate on the VPS); click-through gets `limited`. The owner requires Settings on the VPS `/admin`, and the risk is the click-through, not remoteness itself | §4.10, §5.2 |
| P-M5 | Term fallback; count-based backups; report copies; exports; logs; incomplete deletion; anonymise ≠ anonymous; restore resurrects | **Accepted.** Term → 90 days after 14 days; age-capped encrypted backups; reports store ids plus shown text; exports deleted after 7 days; logs with no names; complete deletion (reporter, actor, audit text, guest-era option); "Pseudonymise" drops originals; deletion ledger; restores keep the current `host_admins`. *Modified:* backup encryption uses `backup.key` plus the recovery file, not DPAPI | §5.5, §6, §4.13 |
| P-M6 | Wellbeing data to moderators, the log file, the projector, exports and email | **Accepted.** Host only, nameless until opened, no log line, excluded from moderator feeds and default exports, cleared 30 days after acknowledgement, content-free email | §5.4, §5.11, §4.7 |
| P-M7 | Limits break a class of 31–36 behind NAT; lock DoS by a classmate | **Accepted.** Scaled limits in School or when a shared address is detected (register and sends 120/h, ws 128); known-device exemption from the account-wide lock; who-locks-whom view; T-AUTH-12 fixed | §4.14 |
| P-M8 | Takeover or misattribution: codes read aloud, 30-day sessions, code guessing, alias domains, substituted text | **Accepted.** Private code display, 10 minutes, optional email; School sessions 12 h in `sessionStorage`; per-`email_key` cap; alias-domain warning and IT note; attribution note; substitutes labelled | §4.6, §4.11, §4.15, §5.8, §5.11 |
| P-M9 | Server runs with full rights; elevation; sqlite outside the sandbox; PowerShell arguments; runtime patching | **Accepted.** Parent/child split, child with `--permission`; the authorizer denies ATTACH (and VACUUM INTO); secrets over IPC; PowerShell gets fixed scripts with values in env vars; rebuild on each Node security release. *Modified:* elevated start is refused in School but only warned at Home (homes with UAC off run everything elevated) | §2.2, §2.3, §6.5 |
| P-M10 | District lists go straight to high-severity strikes; A1's GANG default | **Accepted.** Imports land unconfirmed (flag only) unless "apply actions" is ticked; the GANG policy applies after confirmation; unreviewed hits don't rank; per-term hit counts | §5.8, §5.12 |
| P-m1 | Demoted moderators keep their sessions | **Accepted** (revocation plus a per-call re-check) | §4.10, T-ADM-16 |
| P-m2 | Serving before setup; `setup/status` to the LAN; rotation lockout | **Accepted** (loopback until setup; host PC only; backoff, and a restart resets) | §3.1, §4.10 |
| P-m3 | Names like Host or Teacher | **Accepted** (reserved, plus look-alikes; system style) | §4.1, §5.6 |
| P-m4 | Café Wi-Fi or Public network | **Accepted** (Public → loopback; new networks need approval) | §3.1 |
| P-m5 | Formula injection in the other CSVs | **Accepted** (one shared writer) | §5.5, T-CSV-1 |
| P-m6 | An app password opens the whole mailbox | **Accepted** (relay or no-reply first; warning) | §4.7 |
| P-m7 | Front-door DoS; shared scrypt queue | **Accepted** (10 s handshake, socket caps, host-PC scrypt lane) | §3.1, §4.10 |
| P-m8 | Notice omits facts; addresses kept | **Accepted** (generated notice; address minimisation) | §4.15, §6.4 |
| P-m9 | Disabled-account and email enumeration | **Accepted** | §4.5, §5.15 |
| O-B1 | CA churn from VPN, WSL, hotspot and IPv6; wrong QR address; wide scope | **Accepted.** Primary address via the default route, RFC 1918 only; bind the primary address only; scope chosen at creation; School never mints automatically; leaf changes only with the primary; churn test T-LAN-18 | §3.1, §3.3 |
| O-M1 | The `[Y/n]` import prompt can't read input | **Accepted.** Import moves to the browser; tool stubs don't use `call <nul`; T-LAN-16 | §2.5 |
| O-M2 | Versioned folders break paths, rules and shortcuts; runtime patching | **Accepted.** Unversioned folder; in-place updater with `previous\`; MOVED-TO marker; rebuild policy | §2.1, §2.5 |
| O-M3 | Firewall prompt pitfalls; Private-only helper; port-bound rule; no reachability check | **Accepted** (network check step, read-only checks, better helper, first-device indicator) | §3.5 |
| O-M4 | No pre-class device test | **Accepted** (`/check` with reports to the host) | §3.4 |
| O-M5 | IT sheet gaps; no DNS name or own certificate | **Accepted** (script rule, PAC, allowlists, teacher tools, process tree, dock MAC, IT names, own certificate). *Rejected:* permitting the whole school email domain as a DNS subtree — it would let a stolen issuing key sign for every district hostname; exact IT names only | §3.3, §9.1 |
| O-M6 | Projector exposure; reset code read aloud | **Accepted** (merged with P-B1; the code shown privately, 10 minutes; Win+L advice) | §5.3, §4.11 |
| O-M7 | OneDrive, UNC, Temp, Downloads; the Windows chmod fallback | **Accepted** (refuse list; ACL check). *Modified:* secrets stay in `data\secrets` with an enforced ACL rather than moving to `%LOCALAPPDATA%`: that keeps the one-folder portable model, and the ACL check gives the same protection | §2.2, §2.4 |
| O-M8 | DPAPI at every start looks like malware; lost on reimage | **Accepted, going further:** DPAPI dropped entirely; recovery file at setup, holding the pepper, backup key and SMTP password (never certificate keys, per P-M3) | §2.4, §6.3 |
| O-M9 | Backups on the same disk; no off-PC copy; low disk | **Accepted** (open-folder buttons, off-PC copy, 30-day banner, disk checks, SQLITE_FULL banner) | §6.1, §5.16 |
| O-M10 | A stale PID lock after power loss | **Accepted** (named pipe; a second start opens the panel and exits 0) | §2.2 |
| O-M11 | Origin churn resets saved data and IT rules | **Accepted** (persisted pair; no auto-pick in School; one canonical origin; guest-loot note). *Modified:* standard ports 80/443 is an advanced option, not the default (common conflicts with other software; IT rules name a port either way) | §2.2, §3.4 |
| O-M12 | QR to https breaks iPhones after a click-through | **Accepted** (QR → landing unless `devicesTrustCert`; client hint) | §3.4 |
| O-M13 | Email codes slow and fragile in a class period | **Accepted** (roster accounts; school-domain sender note; student test mailbox) | §4.12, §4.7 |
| O-M14 | Admin DB work on the game thread | **Accepted, extended by measurement:** every admin read in a worker (3 s query → 17.7 ms worst tick gap); daily counters (0.33 ms); chunked purges; FTS secure-delete dropped (30–130× slower); optimize in quiet windows; budgets for every endpoint; Compact | §5.16, §0 facts 3–4 |
| O-M15 | Host sleep | **Accepted** (powercfg preflight, wake lock with T-REL-4, resume detection, client retry, README) | §3.8, §3.7 |
| O-M16 | SmartScreen and antivirus recovery | **Accepted** (`START HERE.html`, stub diagnostics, MOTW listing without stripping) | §2.1, §2.2 |
| O-m1 | QuickEdit; setup code behind the browser | **Accepted.** The child never writes the console (this is the critic's fallback, made structural); code in the URL fragment; minimised after setup | §2.2, §5.1 |
| O-m2 | Shutdown flush order; sign-out not signalled | **Accepted** (flush first; end-of-tick writes; T-REL-5) | §5.1 |
| O-m3 | Chromebook self-import dead end; phones untested | **Accepted** (landing wording; T-REL-3) | §3.4, §11.13 |
| O-m4 | Capacity claim from bots only | **Accepted** (hedged; T-PERF-1 gate) | §1, §5.9 |
| O-m5 | Guest lines tie to devices | **Accepted** (wording; tag after 7 days in School) | §8.2, §6.4 |
| Own | FTS5 secure-delete (draft) | **Reversed** after measurement (fact 4) | §6.6 |
| Own | A2's "action = substituted" | Recorded as `display = 'substituted'` with `action` kept as the filter verdict, so blocked-vs-masked severity (A1) stays queryable. Same behaviour for players | §5.8 |
| Own | `zone.setFilterOptions({ custom })` (draft) | Replaced by the landed engine API `setCustomTerms()` (process-wide) | §5.12 |

---

## 14. Build plan

Each task is sized for **one builder plus one verifier pass**.

**The builder** owns the listed files and writes the listed tests.

**The verifier** runs:
- the task's tests, `npm run typecheck` and `npm test`;
- the determinism checks (`npm run smoke -- --mode all`, `riftParity`) when `src/shared` changed;
- a fresh-clone build at each milestone gate;
- and checks that frozen-contract changes are reflected in ARCHITECTURE.md.

**Sizes:** S ≈ half a day, M ≈ 1 day, L ≈ 2 days.

**Coordinate with the builders editing `deploy/` and docs** before B24.

### M1: host basics and the full chat log

Gate: the owner can unzip at home, run it, and use Live and the full Chat log over http with the panel on localhost.

| # | Task | Owner (files) | Depends | Acceptance tests | Size |
|---|---|---|---|---|---|
| B1 | `startServer` refactor; listen error; uncaught; SIGHUP/SIGBREAK; flush-first shutdown; end-of-tick chat writes; fatal DB open in LAN | SERVER (`src/server/index.ts`, `app.ts`) | – | T-SRV-3, T-SRV-4, T-LAN-4 | M |
| B2 | Settings service, presets, env seeding, audit, live subscribe; `secrets.ts` | SETTINGS (`src/server/settings/*`) | B1 | T-SET-1…7 | M |
| B3 | Schema v4 migration and backfills; untrusted-DB guard (authorizer, `trusted_schema`, schema diff) | AUTH store (`auth/store.ts`, `src/server/db/guard.ts`) | B1 | T-AUTH-10, T-LAN-13 (sqlite part) | M |
| B4a | Launcher checks: location, ACL and fix, elevation, MOTW, pipe lock, port pair and probe, preflight cache | LAUNCHER (`src/lan/paths,acl,elevation,motw,pipe,ports,preflight.ts`) | – | T-LAN-1, 2, 3, 11, 12, 14 | M |
| B4b | Parent/child: `--permission` child, IPC secrets, supervise and restart, banner, quiet console, redacted log sink | LAUNCHER (`src/lan/launch,child,banner,console.ts`) | B1, B4a | T-LAN-13, T-LAN-10 (manual), T-LAN-16 | M |
| B5 | Maintenance worker skeleton; encrypted backups; age and size caps; disk checks; restore (panel stage + tool); recovery file; deletion ledger | SERVER MODERATION (`src/server/maint/*`), LAUNCHER (`restore.ts`) | B2, B3 | T-BAK-1 (encrypt/restore/recovery), T-BAK-2 (age caps), T-BAK-3 (ledger), T-BAK-4 (low disk) | L |
| B6 | Admin listener (loopback); `isHostPc`; proxy refusal; Host and Origin; host admin credential; setup (fragment, backoff); sessions; step-up; `can()` table; `admin-reset` over the pipe | SERVER MODERATION (`hostAdmin.ts`, `capabilities.ts`, `http.ts`), SERVER (`listeners.ts`) | B2, B3, B4b | T-ADM-1, 2, 3, 16, 17; T-NET-1 (admin part), T-LAN-9 | L |
| B7 | Zone chat pipeline: `roomUid`, `display`, accepted names, tags, A2 substitution and warnings, SELF-HARM path, `announce()`, reserved names, channel-coverage pin | ROOM (`src/shared/room/Zone.ts`, `Room.ts`, `moderation.ts`) | – | T-ROOM-1, 2, 5; T-CHAT-1, 2, 3; T-ADM-14 | L |
| B8a | Moderation store and worker queries: FTS, context, rooms-in-range, stats, `chat_tags`, `conduct_daily`, point-query budgets | SERVER MODERATION (`store.ts`, `maint/queries.ts`) | B3, B5, B7 | T-ADM-6, 7; T-PERF-2 | M |
| B8b | Live ring and long-poll; streamed exports and the shared CSV writer; chunked purge; retention modes and fallback; report copies shown-only; tag policy and alert routing | SERVER MODERATION (`service.ts`, `csv.ts`, `maint/writes.ts`) | B8a, B6 | T-ADM-5, 8, 9; T-CSV-1; T-PERF-3; T-WB-1 (routing part) | L |
| B9 | Panel shell: login, setup, reauth; Home; `/display`; Live; Chat log (reveal, context, export dialog, retention); announcements; Presenting; banners; Audit | ADMIN UI (`admin/*`, `src/lan/display/*`) | B6, B8b | T-UI-1, 2, 6, 7, 8 | L |
| B10 | Client: offline fonts, same-origin `serverUrl`, auto-retry and close reasons, pad wording, chat notice line | CLIENT (`src/client/*`) | – | T-CL-1, 3, 6; T-PKG-4 | M |
| B11 | Packaging: `build-lan.mjs`, stubs and templates, `START HERE.html`, SHA256SUMS, zip; in-place updater and rollback | PACKAGING (`scripts/build-lan.mjs`, `scripts/lan/*`, `src/lan/update.ts`, `tool.ts`) | B4b, B9, B10 | T-PKG-1…7, T-LAN-17 | M |

### M2: networking and HTTPS

| # | Task | Owner (files) | Depends | Acceptance tests | Size |
|---|---|---|---|---|---|
| B12 | TLS: root in memory plus issuing CA, scope choice, leaf lifecycle, primary address, netwatch re-bind, new-network approval, own certificate, IT names | LAUNCHER (`src/lan/tls/*`, `primary.ts`, `netwatch.ts`) | B4b | T-LAN-5, T-LAN-18, T-NET-5 | L |
| B13 | Front door: sniffing, handshake and socket limits, game-port Host/Origin/proxy rules, `signInOverHttp` gate everywhere, landing, `/check` with reports, `devicesTrustCert` redirect and QR target | SERVER (`frontdoor.ts`, `listeners.ts`), LAUNCHER (`landing/*`, `check/*`) | B12, B6 | T-LAN-6, 8, 9; T-NET-1…4; T-AUTH-11 (http part) | L |
| B14 | Host ops: firewall and network preflight surfacing, Allow `.cmd`, first-device indicator, sleep and resume, wake lock | LAUNCHER (`preflight.ts`, templates), ADMIN UI (Home) | B13 | T-LAN-19; T-REL-4 (manual) | M |
| B15 | Rooms and Server panel: `setLimits`, pinned, admin create/close/reset, tick stats; Rooms tab; Server panel (status, join card with QR, certificate card, backups card, runtime info, open folders via the parent) | ROOM (`Zone.ts`), SERVER MODERATION (`service.ts`), ADMIN UI | B9, B12 | T-ADM-13, T-SET-5, T-ROOM-3, 4, T-UI-5 | M |

### M3: accounts

| # | Task | Owner (files) | Depends | Acceptance tests | Size |
|---|---|---|---|---|---|
| B16 | `emailPolicy.ts`; register, verify, resend, email change; states; hello enforcement; disabled only after the password; generic 409s; per-`email_key` cap | AUTH (`emailPolicy.ts`, `service.ts`, `index.ts`), SERVER (`onHello`) | B3, B13 | T-AUTH-1…7, 14, 15; T-SRV-1, 2 | L |
| B17 | Mail settings, presets, test, failure banner, content-free alert email | AUTH (`mailer.ts`), SETTINGS | B16, B2 | T-ADM-15, T-AUTH-9, T-SET-4 | M |
| B18 | Reset codes (private, 10 minutes, email option); roster import, slips, first login; known devices; scaled limits; lock insight; session TTL and storage; sign out everywhere | AUTH (`service.ts`, `ratelimit.ts`) | B16 | T-AUTH-8, 12, 13; T-ROST-1…3 | L |
| B19 | Accounts and Settings tabs (accounts, mail, roster); client signup, verify, code and account screens; Public computer; device id | ADMIN UI, CLIENT (`TitleScreen.ts`, `accounts.ts`) | B17, B18 | T-CL-2, 4, 5; T-UI-3 | L |

### M4: school features and release

| # | Task | Owner (files) | Depends | Acceptance tests | Size |
|---|---|---|---|---|---|
| B20 | Conduct: summary and student views from counters and the worker; wellbeing (nameless, open, ack, retention); print and CSV with attribution; audited views | SERVER MODERATION, ADMIN UI | B8b, B19 | T-ADM-11, T-UI-4, T-WB-1 | L |
| B21 | Custom terms: storage and API on `setCustomTerms`; unconfirmed → flag; confirm; import dry run, merge, replace; per-term hits; test box | SERVER MODERATION (`terms.ts`), ADMIN UI | B8b | T-ADM-12, T-FLT-1…4 | M |
| B22 | Moderator tiers: `can()` in `runAdminCommand`; limited command set; alert routing; moderator panel view; session revocation; address-ban exemption rules | SERVER MODERATION (`commands.ts`, `service.ts`) | B6, B20 | T-ADM-4, T-ADM-16, T-UI-3 | M |
| B23 | Deletion and privacy: complete delete, pseudonymise, guest-era option, audit-text scrub, address minimisation, exports auto-delete, generated notice | SERVER MODERATION, AUTH (`AuthAdmin`) | B20, B18 | T-ADM-10, T-BAK-3 | M |
| B24 | Docs and VPS parity: `admin-set`/`admin-reset` CLI, `adminApi.md`, MODERATION.md, ARCHITECTURE.md, LAN docs, CLAUDE.md, README; coordinate `docs/DEPLOY-VPS.md` and `deploy/vps/` | DOCS, SERVER MODERATION (`cliCore.ts`) | B22, B23 | T-UI-1; the CLI part of `moderation.test.ts` | M |
| B25 | Release gates: T-PERF-1 load harness and run; manual T-LAN-5b, T-REL-1…6; final fresh-clone `package:lan` | PACKAGING plus the verifier | all | §11.13 | M |

**Critical path:** B1 → B4b → B6 → B8b → B9 → B11 (M1). B7 and B10 run in parallel with the server tasks. M2 can start once B6 lands.

---

## Appendix: evidence

**New measurements for this revision** (design-scratch/lan_architect\r2\`; Node 24.16.0, SQLite 3.53.0, Core Ultra 9 285K):

- **`heavy.mjs`** (500k rows, v4 schema with FTS5 trigram):
  - on the game thread: `log/stats` per-day GROUP BY 92 ms; the conduct aggregate 3,067 ms;
  - the same in a worker: 96.5 ms and 3,071 ms, while the main thread's 60 Hz timer had a worst gap of 17.7 ms (event-loop p99 2.9 ms) and 20-row chat flushes took at most 3.9 ms;
  - with FTS5 secure-delete on: 1,000-row delete chunks p50 762 ms and worst 3,971 ms; 257 s for 200k rows.
- **`purge.mjs`** (100k rows; delete 20k in 1,000-row chunks), p50 per chunk:

  | Variant | p50 |
  |---|---|
  | no secure options | 7.6 ms |
  | SQLite `secure_delete` | 8.1 ms |
  | FTS5 secure-delete | 291 ms |
  | both | 250 ms |
  | 100-row chunks, no secure options | 2.3 ms |

- **`optimize.mjs` / `merge.mjs`** (300k rows; purge 60k without FTS secure-delete):
  - chunk p50 5.8–6.1 ms, worst 60–63 ms, 0.58–0.63 s in total;
  - FTS `optimize` 0.93–1.0 s at 240k rows;
  - the conduct summary from `conduct_daily`: 0.2–0.33 ms;
  - FTS `merge` with a positive page count did no work after a bulk load, so it is not a cleanup path.
- **`sqlite-api.mjs` / `auth2.mjs`:**
  - `setAuthorizer` is present; denying `SQLITE_ATTACH` denies both `ATTACH` and `VACUUM INTO`;
  - the `backup()` API is unaffected;
  - `trusted_schema` 1 → 0 works;
  - `loadExtension` is refused by default.
- **`inter.mjs`:** with an unconstrained root and a constrained issuing CA (192.168.1.50/32, loopback, localhost and the host names), OpenSSL (`node:tls`) accepts the in-scope leaf and rejects 192.168.50.21 and `www.example.com` with "permitted subtree violation".
- **`inter2.ps1` / `nc.ps1`:** CryptoAPI through X509Chain with the root untrusted reports only `UntrustedRoot` for both constrained designs. Constraint behaviour with a trusted root needs the VM (T-LAN-5b); the owner PC's trust store was not modified.
- **Windows probes (standard user):**
  - `Get-NetConnectionProfile`: Ethernet = Private;
  - `Get-Volume C:`: NTFS, Fixed;
  - `fsutil fsinfo volumeinfo`: access denied;
  - `powercfg` STANDBYIDLE AC/DC = 0;
  - `whoami /groups`: Medium (S-1-16-8192);
  - `%USERPROFILE%` ACL: SYSTEM, Administrators, the user;
  - the Desktop is redirected to OneDrive; Documents is local;
  - `fs.statfsSync` gives free space (type 0 on Windows).

**Critics' evidence used:**
- `lan_opscritic\vpn-ca.mjs` (CA#2–#6 from adapter churn);
- `nic.mjs` (the default-route source is 192.168.1.50);
- `pipe-lock.mjs` (EADDRINUSE while held; freed on exit);
- `stdin-test.cmd` (EOF under `call <nul`);
- `lan_security\perm3.mjs` (`--permission` vs `node:sqlite` and fs).

**Earlier measurements carried over:**
- `chatsize.mjs`: 289 / 307 / 457 B per row; LIKE 302 ms vs FTS 14 ms at 1M rows; context 0.12 ms; FTS rebuild 0.5 s per 100k;
- `backup.mjs`: 116 ms and 5.2× gzip for 29 MB;
- the packaging and HTTPS research (folder vs single .exe, port shadowing, `call <nul`, the browser matrix, ChromeOS policies);
- the code map (the email-required sites, rate limits, admin API, 0.277 ms per 16-bot tick).

**Code facts:**
- `commands.ts:39-129` (the moderator commands);
- `service.ts:252-255` (moderators exempt from address bans), `:454-455`, `:536-540` (alerts and log lines that name the student);
- `moderation/store.ts:546` (reports store 20 rows), `:654`;
- `netguard.ts:205-226` (dev-origin CORS);
- `index.ts:218` (ws without Origin check), `:362`, `:391-392`;
- `scripts/host-online.ps1:50` (cloudflared);
- `shared/room/moderation.ts:15-37, 149-170` (`flag` and the hit labels, already landed);
- `shared/moderation/custom.ts` (`setCustomTerms`, `CUSTOM_LIMITS`);
- `Zone.ts:119, 123, 179, 456, 972-1049`;
- `auth/store.ts:175-178` and `moderation/store.ts:244-247` (WAL, `foreign_keys`, `busy_timeout`).

## Owner decisions (2026-09-28)

1. **Student accounts in School mode:** **both** are available, and the host picks per class in the admin page:
   - school email with an emailed 6-digit code, required before playing;
   - a class roster with printed login slips.
2. **Records defaults (School):**
   - **full email visible to the host admin** (`emailStorage: 'full'`);
   - **90-day** chat-log retention;
   - both are changeable in Settings.
3. **Friendly stand-in line:** shown under the **student's name** (`sender`), the owner's idea. The admin views label it as substituted.
4. **Downloads approved:**
   - the game fonts (Orbitron + Rajdhani woff2, OFL, from npm; about 100 KB committed);
   - the Node.js LICENSE text (from the v24.16.0 tag on GitHub);
   - qrcode-generator (MIT, from npm; only `qrcode.js` vendored).
5. **Not asked, so the design defaults stand:**
   - imported custom lists are "confirm before strikes" (flag-only until the host confirms);
   - the IT-help question stays open, and the design works with or without IT.
6. **The domain lock is a generic field for ANY school or network** (owner, 2026-09-29): "I want it to be for any domain lock... not just caldwellschools.org. I would like this to work for any school or network, so having a domain lock field would be better."
   - **Field:** Settings → Accounts has an editable **Allowed email domains** field. It is a list of `{ domain, subdomains }`, any number of domains, and empty means any domain.
     - It is also offered, optionally, in first-run setup when School mode is chosen.
     - It is seeded from `ACCOUNT_EMAIL_DOMAINS` on the VPS / env path.
   - **No hard-coded domain anywhere in production code or presets.** The School preset leaves the list empty until the host fills it in. `caldwellschools.org` appears only in tests and docs as an example.
   - **Every user-facing string derives from the configured list:** the signup label, the placeholder, errors, the mail-sender hint, and masked addresses.
     - One domain: "Use your @<domain> email". Placeholder `yourname@<domain>`.
     - Several domains: "Use your school email (@a.org or @b.org)".
     - None configured: a generic "you@example.org" placeholder.
   - **Validation:** normalized to lowercase, IDN to punycode, no scheme/path/@/wildcards typed by hand (the subdomain toggle covers them), public-suffix-only entries refused (e.g. `org`, `co.uk`), duplicates merged.
   - **Guard test (M3):** fails if a non-test file under `src/` or `scripts/` contains a literal school domain.
7. **No QR code** (owner, 2026-09-29): "no reason to have a QR code for the join." The join card, the Home tab, `/display` and the Server panel show the join address as text only. Don't vendor qrcode-generator, or remove it if M1 already did. T-UI tests that expect a QR are dropped.

## M1 gate rulings (integrator, 2026-09-30)

These amend the body of this spec where it says otherwise; the code follows them.

1. **HA: the maintenance worker is a process, not a thread.** On Node 24.16 a worker thread's permissions are not pinned to its process's (a `Worker` with `execArgv: []`, or an `env` holding `NODE_OPTIONS`, runs unsandboxed), so the server child gets **no `--allow-worker`** (§0 fact 12 and T-LAN-13 gain "no worker threads"). §5.16's `app\maint.mjs` runs as a second sandboxed child (`app\maint.mjs --maint`, the same flags as the server) that the launcher starts on the server's request and relays over IPC (`src/lan/maintRelay.ts`, `src/server/maint/ipcTransport.ts`; streams use `{t:'sp', id, m}` envelopes instead of a MessagePort). The npm / VPS path keeps a worker thread.
2. **fsync in the sandbox.** Under `--permission`, Node 24.16 refuses `fs.fsyncSync` / `fdatasyncSync` (`FileHandle.sync()` works). The synchronous atomic writers keep temp + rename and skip the flush inside the sandbox (`src/server/durable.ts`). Durability of `data\` writes against a power cut inside the child is therefore the file system's (NTFS journals metadata); the settings file keeps its `.bak`.
3. **Custom terms in M1:** `customTerms/list`, `add`, `remove` and `test` are built (a typed term is confirmed by the host who typed it); `update`, `import`, `export` and `confirm` stay with B21 (M4).
4. **`--this-pc-only`** (launcher flag): the game listener stays on loopback whatever the network (notServing reason `this-pc-only`). For a solo try-out and for gate runs, so no firewall prompt appears.
5. **Planned restarts** (the launcher's respawn after setup, and later restores and port changes) send `stop { restart: true }`; the child closes players' sockets with 1012 and `RESTART_CLOSE_REASON` (`shared/net/closeCodes.ts`), so clients reconnect on their own.
6. **Zone.setLimits** (planned for B15) landed at the gate, so Settings → Rooms applies live (T-SET-5 runs on the real Zone).
7. **The game port in LAN mode** serves no admin API: `/admin` is the "The control panel is on the host PC" page and `/api/admin/*` is 404 (§3.2), until B13's front door replaces it.
8. **Decision 7 (no QR)** supersedes the QR in §1, §3.1, §3.4, §5.3, §5.9, §9.2, §11.7 (the `qr.js` line and T-UI-5) and B15; those passages are left as written for the record.
9. **B11's packaging departures are accepted:** the §2.1 stub table gains the "An update is running or was interrupted…" row (exit 1; the Start stub refuses while `update.journal.json` exists, and Update runs `update.recover.mjs`); `update.recover.mjs` and `update.journal.json` sit at the root while a swap runs, and `previous\` also holds `root\` and `update.json`; the updater extracts and verifies before the pre-update backup (§2.5 steps 4 and 5 swap); T-PKG-4 allows exact XML-namespace strings and PixiJS's banner URL in the built JS / SVG (they are text, not requests).


## Carried into M2–M4 (from the M1 gate, 2026-09-30)

Open items the M1 checkpoint handed forward. Each is picked up by the task named in it; the next milestone's builders must read this list.

- **B8a minors:**
  - `ts_disorder` only ever rises (SERVER MODERATION).
  - The two retention paths treat report copies differently (needs a spec ruling).
  - Conduct days are UTC, not local (your decision).
- **M3 accounts (B16/B19):** `GET /api/info`, which the client also needs to choose its "host lost" text on IT hostnames. The `email_key`/`email_hash` fixes, and the alert email (`setUrgentAlertSink` needs mail).
- **B22:** in-game address bans still need to spare the host PC and only exempt trusted moderators.
- **B23:** account deletion must refuse ids that aren't accounts.
- **Unassigned (T-LAN-15):** "bring in data from another copy". The launcher offers the other copies, but nothing imports them yet.
- **M2 (B13/B14):** front door, landing page, `/check`, remote access over https, the iOS wss hint, the firewall stub, and the https parts of T-PKG-5.
- **B24 docs:** FOR SCHOOL IT additions, MODERATION.md and README updates for v4, update-recovery docs, the make-icons comment.
- **Smaller items:**
  - Only a player's `/report` got `noWait`. Lifting a ban and reviewing a report can still wait up to 250 ms on the game thread, because the CLI shares the service.
  - The npm/VPS path still uses the v0.5 admin, with no settings service and no maintenance worker.
  - T-ROOM-5 still has `Math.random` in `Room.ts`/`util.ts`; fixing it needs a Zone seed in `smoke.ts`.
  - B4a's fix-hint wording.


## M5: classroom learning features (planned 2026-10-01, NOT built yet)

**Owner direction:** "Are there any of the Idaho standards for digital literacy and computer science standards that we could worm in here?", then "Don't build anything yet, but just set the builds up."

**Source:** the owner's crosswalk `Digital Literacy Games\Proposals\Idaho Standards Crosswalk.md`. It was reviewed 2026-09-28 against Idaho's **Digital Literacy Course Guidance (Aug 21, 2025)**, and the identifiers below use its notation. Confirm the district's applicable version before formal course approval.

**How Voidswarm fits:**
- The crosswalk assigns privacy to Appagotchi, remixing and research to Arcade Repair Center, and programming, networking and cybersecurity perspectives to Programmon. Voidswarm doesn't duplicate those.
- It adds what only a **real multiplayer game on a real network** can show:
  - real latency;
  - a real chat log kept about the students themselves;
  - real data they generated.

**The crosswalk's evidence rule applies to every task.** Playing is not evidence. Each feature ships with a short student task (compare / explain / create / evaluate) and a teacher guide in `docs/classroom/`. Game results (wins, takedowns, levels) are never used as mastery evidence.

### Standards map

| Identifier (crosswalk notation) | Voidswarm feature | Student evidence |
|---|---|---|
| 9-12.CS.2.6, cybersecurity viewpoints (essential) | **Chat-log policy council** (B30): the host's real chat-log settings are the case. Students argue as a security specialist, a privacy advocate and an administrator. | A written comparison of all three views and a defended retention/visibility policy. |
| 9-12.ICT.2.1, identity/reputation (essential) | **"My record" self-view** (B29): a student sees their own callsign history, filtered-line count by tag (no other students) and how long it is kept. | Explain one lasting consequence of something typed in chat, and how it would differ with different content. |
| 9-12.ICT.2.2, responsible behavior (supporting) | The existing stand-in lines and private warnings, plus a **"why was I warned?" explainer** (B29) that teaches without naming the matched words. | Respond to three fictional chat scenarios (impersonation, pile-on, a friend in distress). |
| 9-12.ICT.2.4 security/tracking; ODC.9-10.5 privacy/tracking awareness (supporting) | **"What this server knows about you"** page on the join page (B29): what is stored, where, for how long, and who can see it. | Identify one item they would minimise, and how. |
| 9-12.CS.3.3, personal-data tradeoffs (supporting) | B28 anonymisation choices plus B29. | Explain one convenience-vs-privacy tradeoff in the account settings (email optional vs required). |
| 9-12.CS.3.7 define AI (supporting); 9-12.CS.3.8 AI impacts (essential, partial) | **Bot "why" viewer** (B31): spectating a bot shows the fixed rule it is following live ("hull < 30% → retreat to ally"). | Compare a fixed-rule bot with a learned model (pairs with the shared AI investigation). The crosswalk warns that scripted opponents alone don't teach AI literacy, so this is partial by design. |
| 9-12.CS.5.1, execution diagrams (supporting) | B31's rule trace, exported as a step list. | Annotate a bot decision trace and predict its next action. |
| Practical skill: export results to a spreadsheet and make an honest chart (crosswalk "real-tool transfer") | **Class data export** (B28): an anonymised match CSV (class picks, outcomes, per-minute stats; no names, no conduct data). | A spreadsheet summary plus one honest comparison chart (for example, "is one class overpowered?"). |
| Networking practice (supports Programmon's IP/port/firewall work; not an essential identifier itself) | **Network stats overlay** (B26) and **Lag Lab** (B27). | Predict, then measure, the effect of added delay and loss. Explain what client prediction hides and what it can't. |
| Algorithms: pseudo-randomness and determinism (CS practice) | **Seed Lab** (B32): enter a map/floor seed, and the same seed rebuilds the same map. | Predict and verify; explain why a game needs repeatable "randomness". |
| ODC.9-12.8, media-supported explanations (supporting) | B28's per-match summary card (an image) for a short presentation. | A 1-minute narrated explanation of one match decision, made with real tools. |

### Build plan (M5), sized like section 14

| # | Task | Owner (files) | Depends | Acceptance tests | Size |
|---|---|---|---|---|---|
| B26 | **Network stats overlay**: a per-client toggle (F3 / Settings) showing ping, snapshot rate, bytes in/out per second, the prediction correction size, and packet age. The host can lock it on for a lesson. | CLIENT (`src/client/ui/netStats.ts`, HUD), ROOM (stats fields if needed) | M2 | Stats are pure functions of the transport counters (unit-tested); the overlay fits 812×375 phone landscape. No new wire fields unless the spec decides otherwise. | S |
| B27 | **Lag Lab** (host control): the admin page sets added latency (0–400 ms), jitter and packet loss **per room**, labelled LAG LAB ACTIVE on every client in that room, with an auto-off timer (max 15 min). Never on house rooms unless chosen. | SERVER (send-queue shaping), ADMIN UI (Rooms tab), CLIENT (banner) | B15, B26 | The shaping is deterministic under a seeded test clock; it can't affect rooms not chosen; the auto-off fires; it is audited. | M |
| B28 | **Class data export**: the admin page exports an anonymised per-match CSV + JSON (pseudonymous per-export player ids, class/path, team, outcome, duration, per-minute takedowns/assists/damage, wave/floor reached). No names, emails, chat or conduct. A summary-card PNG per match. | SERVER MODERATION (`maint/` export op), ADMIN UI | M4 | No column can identify a student (column allowlist test); ids are re-randomised per export; the CSV is RFC-4180 and opens in Excel and Sheets. | M |
| B29 | **Transparency + "My record"**: a "What this server knows about you" page (public on the join page, generated from the live settings); a signed-in student's own record view (callsign history, tag counts, retention dates); and a "why was I warned?" explainer with no matched words. | SERVER (`/me/record`), CLIENT (Account screen), LAUNCHER (landing page) | M3, M4 (B20) | A student sees only their own data; no matched terms appear; the page text follows the settings (retention, email policy); a11y check. | M |
| B30 | **Chat-log policy council kit**: teacher guide + 3 role cards + a policy worksheet in `docs/classroom/`, plus a read-only **policy simulator** in the admin page ("if retention were N days / emails hidden / guests on, here is what you could and couldn't see"). | DOCS, ADMIN UI | B29 | The simulator never changes settings; worksheet checklist. | S |
| B31 | **Bot "why" viewer**: when spectating a bot, a panel shows the active rule and its inputs (the bots already pick goals in `src/shared/ai/bots.ts`); exportable as a step list. | AI (`bots.ts` debug reason, sim-neutral), CLIENT (spectate panel) | M2 | Exposing reasons doesn't change bot decisions (the determinism digest is unchanged); the reasons are PG and human-readable. | M |
| B32 | **Seed Lab**: the room-create screen and the admin page accept a map/floor seed (lesson mode); a "seed" readout in the debrief. | ROOM (`RoomSettings.mapSeed` opt-in), CLIENT | – | Same seed ⇒ the same map digest (test); a lesson-mode-only control; the house rooms are unaffected. | S |
| B33 | **Teacher guides**: `docs/classroom/README.md` with one 1-page lesson per feature (objective, identifiers, setup, the student task, a quick rubric, cautions), using the crosswalk's evidence plan (introduce → guided → independent → transfer). | DOCS | B26–B32 | Each lesson names its identifiers and the evidence artifact; no student data in examples. | M |

**Order and risk:**
- B26/B27 and B32 can move into M2 if wanted (networking).
- B28–B30 need the M3/M4 accounts and conduct work.
- B31 is independent of the LAN work.
- Privacy guardrails: B28 and B29 get a dedicated privacy review (same critic as section 8) before release.
- Title animation: decided (owner, 2026-10-01). It is always on, even with OS reduced motion, as a check that the machine can run the game. It shipped outside M5.
