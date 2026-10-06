# Voidswarm: handoff (state as of 2026-10-05)

**Start here** if you're picking this project up (human or AI). Read `CLAUDE.md` first (how to run, gotchas, frozen files), then this file, then the spec for whatever you're building. `ARCHITECTURE.md` is canon for the contract and module ownership.

## 1. Where things stand

| Item | State |
|---|---|
| Game version | `package.json` **0.6.0-m1.1** (canonical spot; `src/shared/version.ts` reads it). `PROTOCOL_VERSION` 5. |
| Live web build | https://lawsonmode.github.io/voidswarm/ (deploys on every push to `main` via `.github/workflows/pages.yml`). |
| Latest LAN release | **lan-v0.6.0-m1.1**: https://github.com/LawsonMode/voidswarm/releases/latest. It is built and attested by `.github/workflows/lan-package.yml`. Push a `lan-v*` tag to publish a new one; verify with `gh attestation verify <zip> --repo LawsonMode/voidswarm`. |
| Git | `main` is in sync with GitHub (last commit 1fa4280) **plus uncommitted local work**: the Quark client and the Lag Lab (`git status` lists it; `docs/QUARK.md`, `docs/LAG-LAB.md`). Nothing from it is pushed. The repo is public. |
| Tests | 145 files / 2,835 tests pass (`npx vitest run`); typecheck is clean; smoke and parity gates pass. |
| Shipped | v0.2 classes/turret kits/accounts · v0.3 game types, Command screen, loot, music · v0.4 chat moderation · v0.5 hardpoints, capital ships, mobile · 0.6.0-m1 LAN Edition M1 · m1.1 no-admin-rights fixes · the title always animates. |

## 2. What's next, in the owner's order

1. **Quark** (separate project, `A:\Code\Quark\`, **PLAN ONLY, do not build until the owner says so**).
   - It is a local hub for all the owner's digital-literacy apps: student SSO, chat as a service, and Idaho standards progress (apps propose, the teacher confirms).
   - **The remaining LAN Edition work (M2 HTTPS, M3 accounts/email/domain lock/rosters, M4 conduct/custom-term import/moderator limits/privacy, M5 classroom features) moved INTO Quark.** Voidswarm becomes Quark's first client.
   - **Voidswarm's side is started** (uncommitted): `docs/QUARK.md`. Waiting on Quark: networking standards in its catalog, then the Lag Lab manifest entries and `LAG_LAB_REPORTING = true`.
   - Plans: `Quark\docs\QUARK-PLAN.md`, `Quark\docs\CHAT-INTERFACE-CHANGES.md` (built vs planned chat features).
   - The detail for those features is still canon in `docs/LAN-EDITION-proposal.md` (sections 3–5, 11, 14, "M5", and the owner decisions at the end).
2. **v1.0.0, the combat overhaul.** The spec is final: `docs/v1.0-power-proposal.md` (owner decisions in section 14.3) and `docs/v1.0-presentation-proposal.md`. Design models are in `docs/design-models/`. It is a MAJOR bump, with `PROTOCOL_VERSION` going 5 → 6.
3. **v1.1, maps** (Solar / Galactic / Cosmic; narrows; capital shipyard respawn; crew eject/stay; vendetta and streaks): `docs/v1.1-notes.md`.

## 3. Owner decisions you must keep (don't re-ask, don't undo)

**Wording and tone**
- PG wording: **"takedown", never "kill"**, in every UI string.
- The streak names are owner-approved (see `docs/v1.1-notes.md`).

**v1.0 combat**
- **Power routing is automatic.** No manual power pips or allocation keys ("keep it simple and frantic").
- **Abilities (Overwatch-style):**
  - LMB main fire (the chosen weapon), RMB alt fire, E special, Q ultimate.
  - Space: boost with a direction, FULL STOP without one, double-tap for a perk.
  - R: bombs.
  - The capital skill replaces E while hosting.
  - One ultimate per class; docked ultimates allowed; about 75–80 s ultimate pace.
- **Damage tiers:** one real effect only. Each tier lowers max power and recharge, and the sparks are cosmetic.
- **XP pip gravity** plus the Tractor and Vacuum pickups.
- **Cosmetic-only loot.** Persistent perk unlocks are sidegrades, never stat boosts.

**v1.1 capital ships**
- While a pilot waits for the capital respawn, they may **only spectate, never turret**.

**Title screen**
- It **always animates**, ignoring OS reduced-motion. The owner uses it as a "can this PC run it" check.

**Chat and moderation (for the Quark work)**
- **Filtered lines:** others see a random friendly line **under the sender's name**; the sender gets a generic private warning that never names the words.
- **Self-harm:** never substituted. The line is withheld, the student gets a care note, and the teacher gets an urgent alert.
- **Tags:** PROFANITY / VULGAR / HATE / THREAT / GANG / SELF-HARM / custom, counted separately per student.
- **Gang terms:** come only from a **host-managed custom list** (district/SRO import). **Never author a gang-term list in the repo.** Moderation word lists are ROT13/ROT5 in `lists.ts`; never paste decoded terms anywhere.
- **Accounts:** email Optional / Required / Required + an **Allowed email domains** field. It is generic, with no hard-coded school domain; `caldwellschools.org` is only an example. When email is Required, **a 6-digit code must be entered before playing**, enforced on the server. Class rosters are also allowed.
- **Admin:** all admin controls are on one admin page behind a **dedicated host admin login**, separate from players. Moderators never see emails or conduct.
- **No QR code** for joining; text addresses only.

**Hosting**
- **Paid AWS is sidelined.** `docs/DEPLOY-AWS.md` exists for later; don't push it. No tunnels, nothing purchased.
- The LAN host is a **portable folder with the official signed node.exe**, not a custom single .exe (a single .exe triggers antivirus/SmartScreen).
- **Teachers have no admin rights.** The folder-permission check only warns (and can be switched off). Firewall blocking is explained, and IT gets `Allow Voidswarm (for IT).cmd`.

## 4. Known gaps and open items

**Admin page**
- No **Fix permissions** button; the banner gives the command instead. It and "open folder" need the panel → launcher action path (Quark Q5).
- Several settings exist in the backend with **no admin-page control yet**: stand-in mode, the friendly-line list, per-tag rules, the daily summary.

**Not yet tested on real setups**
- **`Allow Voidswarm (for IT).cmd`** was only dry-run. Its first real elevated run is on an IT machine.
- **A real phone + Bluetooth controller over http**.

**Open owner questions**
- Will IT help with the first school deployment?
- Should offline play pause on the "rotate your device" overlay?

**Code debt**
- The VPS/npm server still uses the v0.5 admin page.
- `Math.random` remains in `Room.ts`/`util.ts` (T-ROOM-5).

## 5. Working rules that bit us (also in CLAUDE.md)

**Files and data**
- **Never commit `data/`, `dist/` or `release/`.** The `.gitignore` entries are anchored (`/data/`), so `src/shared/data` is tracked.
- **Never edit with PowerShell 5.1 `Set-Content`/`Out-File`** (the BOM breaks `package.json`). Use `npm version <v> --no-git-tag-version` for versions.
- **User-facing paths use `A:\...`; machine-facing paths use `C:\AI Bins\...`.**

**Testing**
- **Never run `npm run build` into `dist/` while the owner's home server runs**: `scripts/host-online.ps1` serves `dist/` on :7777. Build into a scratch `--outDir`.
- **Test the LAN package on ports other than 7777/7778.** On Windows, Windows PowerShell must not inherit PS7's `PSModulePath` (already handled in `runPowerShell` / `authenticode`).

**CI**
- The Pages workflow (Linux) skips the Windows-only LAN suite and the heavy DB perf suites. The LAN workflow (Windows) runs them with a 30 s test timeout.
- Perf budgets get CI headroom; timing tests flake on shared runners.

**Git**
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Stage files by name. Commit and push only when the owner asks: a push to `main` deploys the public Pages site.

**Releases**
- Fresh-clone check before a first push.
- Attested release via a `lan-v*` tag.
- After a protocol bump, the owner must restart the home server (`scripts\host-online.ps1`), or the Pages client shows "Protocol mismatch".

## 6. Communicating with the owner

**Who they are**
- The owner is a high-school media tech teacher (Caldwell, Idaho), not a sysadmin.

**How to explain things**
- Explain in plain language, recommend one option, and ask before anything outward-facing: pushing a public release, downloads, accounts, DNS, purchases.
- Prefer showing what they can try next.

**Planning vs building**
- When the owner says **"plan only"** or **"don't build"**, write plans and specs and nothing else.
