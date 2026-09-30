# Claude Context — Voidswarm (Subspace Clone)

**Voidswarm** is a SubSpace/Continuum-inspired browser arena shooter for up to 32 players. Modes are FFA or 2–8 teams, with a PvPvE layer: Geometry Wars–style swarms, Vampire Survivors–style XP and level-up cards, and auto-weapons.

v0.2 added:
- **3 Diablo-style classes:** Juggernaut, Arcanist and Artificer, each with 4 skills and 3 build paths. You choose a path at level 3 and take path talents at levels 6, 9, 12 and 15.
- **Turret kits:** attached turrets use LMB for offense, which draws the host's energy, and RMB for defense. Laser resonance adds ×1.5 per extra laser on the same host.
- **Deployables:** sentries, walls, wells, drones, napalm and nanite clouds.
- **Accounts:** username/password login, with the email used only for password reset.

**v0.3 (0.3.0) is complete** (all four milestones landed; the design is `docs/v0.3-proposal.md`). It adds:
- **3 game types:** Dungeon Runner (PvE co-op rift, 3 or 6 floors, sealed rooms, shared lives, the Matriarch boss every 3rd floor, Extract or Descend), Arena (PvP: Deathmatch, CTF, Control Zones, Hot Point) and Warzone (PvPvE: Classic deathmatch, Control Zones). `src/shared/data/gameTypes.ts` is canon for types and sub-modes; a sub-mode shows up only once its `ready` flag flips (every v0.3 sub-mode is ready; Rival Rift and Escort are reserved for v0.4).
- **A Command screen** that replaces the zone lobby: type cards, a live games list, Quick Play / Join / Watch / Create, and house rooms.
- **Cosmetic-only loot:** in-world caches and debrief crates, 4 sets × 13 items plus starters, and a per-account profile with a Hangar.
- **A synthesized soundtrack** (`src/client/audio/music/*`, driven by `src/client/musicDriver.ts` from the pure rules in `musicMapping.ts`): a scene per screen / state, match intensity, stingers; Music volume + mute in Settings.

Milestones: M1 contract + Command + Deathmatch, M2 loot, M3 objectives, M4 Dungeon Runner (+ music wiring). The frozen contract and the owner-file stubs for every milestone landed in M1. The M4 integration rulings (run-end rule, descend hold, boss-cache guard, crate credit per stint, …) are listed in ARCHITECTURE.md §3.2.

**GitHub:** [LawsonMode/voidswarm](https://github.com/LawsonMode/voidswarm) (**public**, branch `main`; live at https://lawsonmode.github.io/voidswarm/ via `.github/workflows/pages.yml` on every push). `data/` (account/profile SQLite DBs, playtest credentials), `dist/` and `node_modules/` are gitignored — never commit them.

The stack is TypeScript + Vite + PixiJS v8 on the client and an authoritative Node `ws` server. The same shared sim runs in the browser for offline play against bots. The build is contract-first: **`ARCHITECTURE.md` is canon** (frozen contract, module ownership, game design), and `src/shared/data/ships.ts` is canon for classes, skills and talents. Standalone, not 5bot.

**v0.4 (0.4.0) adds chat moderation** (guide: `docs/MODERATION.md`; seams: ARCHITECTURE.md "Moderation"): a shared word filter (`src/shared/moderation/`, strict by default, `CHAT_FILTER=standard` relaxes the mild tier) on every chat line and human-chosen name, online and offline; and, on the server (needs accounts), a SQLite chat log, strikes → auto-mute, bans / mutes (account, guest callsign, network), `/report`, moderator chat commands, the `/admin` dashboard and `npm run mod -- <cmd>` (promote, ban, log, export-log, purge-log, ...). The word lists are ROT13 / ROT5 data in `lists.ts`: never paste the decoded terms into docs, chat or commits.

**v0.5 (0.5.0) adds hardpoints + capital ships** (design + integration decisions: ARCHITECTURE.md "Hardpoints + capital ships (v0.5)"):
- **Hardpoints:** up to 5 turret mounts per host (3 fore, 2 aft; `HARDPOINT_LAYOUT` in `sim/world.ts`), re-flowing as turrets join and leave. A docked turret is a bubble dome (hitbox `TURRET_BUBBLE_RADIUS`) seated on the hull.
- **Capital variants:** a host with ≥ 1 turret becomes Dreadnought / Spire / Foundry (`ShipClassDef.capital`): hull + hitbox × `capitalScale(n)` and armor per turret (`sim/hull.ts`), and a capital skill on Space (`sim/capital.ts`): Broadside (slugs from both flanks converging on the aim point), Resonance Overcharge (+1 laser for resonance), Repair Bay (heal + shield turrets and allies). It shares the Space slot's cooldown tick (`mobilityReadyTick`, knobs `capCost` / `capCooldown`).
- **Client:** capital hulls, domes, morphs and turret fire styles (tracers, mass drivers, laser beams) in `src/client/render/capital.ts` + `GameRenderer.ts`; the HUD capital badge and skill-bar swap in `src/client/ui/capitalInfo.ts`; capital-aware prediction and bots (`src/shared/ai/bots.ts` planCapital).
- **Hosting:** `scripts/host-local.bat` (Windows double-click LAN host) + `docs/LOCAL-HOSTING.md`.
- The no-turret Deathmatch golden digests are the v0.4.0 values; the with-turret golden was re-pinned (reasons in `sim.v03.test.ts`).

**v0.6 (0.6.0, in development) is the LAN Edition** (spec, canon for detail: `docs/LAN-EDITION-proposal.md`; host guide: `docs/LAN-EDITION.md`; seams: ARCHITECTURE.md §4c). **M1 landed** (host basics and the full chat log); M2 networking + HTTPS, M3 accounts and M4 school features follow (the build plan is spec §14).
- **Package:** `npm run package:lan -- --out <folder>` builds `voidswarm-lan-<v>-win-x64.zip` (`scripts/build-lan.mjs`; never into `dist/`, never a network drive, `release/` is gitignored). It holds the signed `node.exe`, `app\{launch,server,maint,tool}.mjs`, `app\admin`, `app\display`, `web\` and the `.cmd` stubs. `npm run lan` runs the launcher from source.
- **Processes:** the launcher (`src/lan/launch.ts`) starts the server child (`src/server/index.ts --lan` → `app.ts startServer`) under `node --permission` (no workers, no child processes, writes only `data\`), and relays a sandboxed maintenance PROCESS for panel reads, exports, purges and backups (`src/lan/maintRelay.ts`, `src/server/maint/ipcTransport.ts`). The Host Control Panel listens on the admin port (default 7778, loopback): first-run setup with the console's setup code, the host admin login, Home, `/display`, Live, the Chat log, custom terms, Audit.
- **Gotchas:** under `--permission`, `fs.fsyncSync` throws ERR_ACCESS_DENIED (use `src/server/durable.ts fsyncBestEffort`); a worker thread would escape the sandbox, so never pass `--allow-worker`. `--this-pc-only` keeps the game on loopback (a try-out, or a gate run with no firewall prompt). Test the LAN package on ports other than 7777/7778 (`PORT=27777` seeds a first run).

## Version location
The root `package.json` `version` (currently 0.6.0-m1, the LAN Edition M1 release; `package-lock.json` carries the same, keep them in step). `src/shared/version.ts` reads it, and it also holds `PROTOCOL_VERSION` (currently 5, bumped in v0.5 because the capital skill knobs changed the codec's knob table; bump it on wire changes). Don't hardcode versions anywhere else.

## How to run
```
npm install
npm run dev        # client at http://localhost:5173 (offline mode needs no server)
npm run server     # ws game server + accounts API on :7777 (watch mode)
npm run build && npm start   # serve built client + ws + API on :7777 for friends/LAN
npm run typecheck
npm test           # vitest (vitest.config.ts, root = project)
npm run smoke      # headless 60 s bot match
npm run smoke -- --mode all          # objective AI-parity gates (CTF, Zones, Hot Point, Warzone Zones; 16 bots, 5 sim-min)
npm run smoke -- --mode hotpoint --ffa
npm test -- src/shared/ai/objectiveParity.test.ts   # the same gates on the real Sim, plus the Arena DM PvP rate
npm run smoke -- --rift              # a 180 s bot rift on the Room path (floor reached, drop-in, /end abandon)
npm run smoke -- --rift 700 --floors 3 --no-dropin   # a whole 3-floor run, cleared
npm test -- src/shared/ai/riftParity.test.ts        # the rift AI ready gate: 4 normal bots clear floor 1 of seed 1234 in ≤ 6 sim-min
```
Accounts use `node:sqlite` at `DB_PATH` (default `data/voidswarm.db`; `data/` is gitignored). Password-reset mail goes through SMTP env vars (see `src/server/auth/README.md`). Without SMTP, the reset link is printed to the server console.

`.claude/launch.json` has a `server-playtest` entry that uses `data/playtest.db`. Its test credentials are in the gitignored `data/playtest-credentials.txt`.

Moderation: `npm run mod -- promote <username>` makes an account a moderator (it must exist first); the dashboard is `http://localhost:7777/admin` (Node server only, not the Vite / Pages build). Chat-log retention is `CHAT_LOG_RETENTION_DAYS` (default 90); `npm run mod -- purge-log --before 30d` deletes older lines at once.

## Gotchas / constraints
- The sim must be deterministic given the seed: use `Rng`, never `Math.random`, anywhere in `src/shared/sim`. The client regenerates the map from `mapSeed` through `buildMatchMap` (`sim/mapgen.ts`), which is also how rift floors are rebuilt.
- `src/shared` must not touch the DOM or Node APIs, since it runs in both. Account persistence therefore lives in `src/server/auth` and reaches the Zone through `setAccount` / `isReservedName`.
- Coordinates are quantized to uint16 at 1/8 px on the wire, so `MAP_SIZE` must stay under 8192.
- Frozen contract files: `src/shared/{types,protocol,constants,version}.ts`, `src/shared/sim/world.ts`, `src/shared/data/ships.ts` (shape), `src/shared/data/{gameTypes,cosmetics,loot}.ts` (shape), `src/shared/util/hash.ts`, `src/shared/profile/store.ts`, `src/client/contracts.ts`, `src/server/auth/index.ts`. Changing any of them means updating ARCHITECTURE.md. The v0.3 cross-module signatures (proposal §8.8) are frozen too.
- Over the internet the server must sit behind HTTPS/WSS; plain ws is for LAN only.
- Don't edit files with PowerShell 5.1 `Set-Content`/`Out-File`. The BOM they write breaks `package.json` for Vite.
