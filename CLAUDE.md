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

**GitHub:** [LawsonMode/voidswarm](https://github.com/LawsonMode/voidswarm) (**private**, branch `main`). `data/` (account/profile SQLite DBs, playtest credentials), `dist/` and `node_modules/` are gitignored — never commit them.

The stack is TypeScript + Vite + PixiJS v8 on the client and an authoritative Node `ws` server. The same shared sim runs in the browser for offline play against bots. The build is contract-first: **`ARCHITECTURE.md` is canon** (frozen contract, module ownership, game design), and `src/shared/data/ships.ts` is canon for classes, skills and talents. Standalone, not 5bot.

## Version location
The root `package.json` `version` (currently 0.3.0). `src/shared/version.ts` reads it, and it also holds `PROTOCOL_VERSION` (currently 4, bump it on wire changes). Don't hardcode versions anywhere else.

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

## Gotchas / constraints
- The sim must be deterministic given the seed: use `Rng`, never `Math.random`, anywhere in `src/shared/sim`. The client regenerates the map from `mapSeed` through `buildMatchMap` (`sim/mapgen.ts`), which is also how rift floors are rebuilt.
- `src/shared` must not touch the DOM or Node APIs, since it runs in both. Account persistence therefore lives in `src/server/auth` and reaches the Zone through `setAccount` / `isReservedName`.
- Coordinates are quantized to uint16 at 1/8 px on the wire, so `MAP_SIZE` must stay under 8192.
- Frozen contract files: `src/shared/{types,protocol,constants,version}.ts`, `src/shared/sim/world.ts`, `src/shared/data/ships.ts` (shape), `src/shared/data/{gameTypes,cosmetics,loot}.ts` (shape), `src/shared/util/hash.ts`, `src/shared/profile/store.ts`, `src/client/contracts.ts`, `src/server/auth/index.ts`. Changing any of them means updating ARCHITECTURE.md. The v0.3 cross-module signatures (proposal §8.8) are frozen too.
- Over the internet the server must sit behind HTTPS/WSS; plain ws is for LAN only.
- Don't edit files with PowerShell 5.1 `Set-Content`/`Out-File`. The BOM they write breaks `package.json` for Vite.
