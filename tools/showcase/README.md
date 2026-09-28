# Showcase capture

These scripts make the images the project README uses, in `docs/assets/`. Every screenshot and GIF comes from the real offline game running in a headless browser, so a re-run picks up whatever the game looks like now.

```
node tools/showcase/banner.mjs      # banner.svg + divider.svg (no browser needed)
node tools/showcase/capture.mjs     # every PNG and GIF (a few minutes)
```

## Requirements

- `npm install` done (the scripts use the repo's `vite` and `ws` packages).
- **Edge or Chrome.** The standard Windows, macOS and Linux install paths are checked. Set `SHOWCASE_BROWSER` to use another Chromium build.
- **ffmpeg** on `PATH`. On Windows: `winget install Gyan.FFmpeg`.

## capture.mjs

```
node tools/showcase/capture.mjs [--only title,ctf,...] [--url http://127.0.0.1:5173/] [--headed]
                                [--tmp <dir>] [--port 5391] [--cdp-port 9391] [--keep-frames]
```

- It starts its own Vite dev server on port 5391, with HMR and file watching off. An edit elsewhere in the repo therefore can't reload the page mid-shot, and a dev server you already have running on 5173 is left alone.
- `--url` uses a DEV server that is already running instead. The build must be a DEV build, because the capture drives the game through `window.__voidswarm`.
- It launches the browser headless with `--remote-debugging-port` at 1600×900 and talks the Chrome DevTools Protocol over `ws` (`cdp.mjs`).
- WebGL runs on the GPU if headless mode gets one. Otherwise it runs on SwiftShader, and `--enable-unsafe-swiftshader` is passed for that. The WebGL renderer in use is printed at the start of the run.
- Each shot starts from a fresh page with the Pages-style title (`window.VOIDSWARM_STATIC = true`), the callsign **Nova**, audio off and screen shake off. It then clicks **Play offline vs bots**.
- A device profile is seeded first, so the Hangar and Command show a collection. The profile is built by the game's own grant code (`rollGrant` with the reproducible `grantRng`), as if Nova had played 14 matches.
- Every PNG is checked for a blank frame (luma spread of a thumbnail) and fitted under 700 KB (700,000 bytes). Fitting tries a lossless re-encode first, then 1440 px and 1280 px widths, then a 256-colour palette.
- Every GIF is fitted under 6 MB (6,000,000 bytes; see `gif.mjs`).
- Temporary files go to `--tmp`, which defaults to `<os tmp>/voidswarm-showcase`. They are deleted at the end unless you pass `--keep-frames`.
- The script stops its browser and Vite server when it finishes, including when a shot fails. A failed shot is reported, the rest still run, and the exit code is 1.

| Shot | File | What is staged |
|---|---|---|
| `title` | title.png | The title attract scene at scene time ≈ 12 s, mid Juggernaut set-piece. |
| `command` | command.png | Every house room plus two custom Arena rooms (Zones 3 teams, Hot Point FFA), started and kept alive with bots only. The Arena card is selected, and the zone's own `/rooms` answer fills Comms. |
| `classes` | classes.png | The house Warzone lobby: Nova auto-joins a team and picks the Arcanist, and the Void tab is open in the build planner. The viewport is 1600×1250 so the whole planner fits. |
| `hangar` | hangar.png | The Hangar on the Arcanist tab, with its highest-rarity item open in the detail drawer. |
| `ctf` | ctf.png | Arena CTF. A bot brain flies Nova (autopilot) through 30 fast-forwarded seconds. Nova is then placed on the enemy pennant whenever it is free. The frame with the most ships in view is kept. |
| `warzone` | warzone.png | Warzone Classic after 80 fast-forwarded seconds with the autopilot. Nova is levelled to 5, moved to an open patch of the map and holds it there, firing at the nearest enemy. Three teammates are seated as turrets and rings of swarm enemies are spawned around Nova. The next level-up's cards are left on screen. |
| `dungeon` | dungeon.png | Dungeon Runner. The party is placed just inside the first arena room's door. Nova holds position there until the room seals. The room's first encounter pulse is thickened (a floor-1 pulse is small), and the frame with the most enemies in view is kept. |
| `boss` | boss.png | Dungeon Runner. The run jumps to floor 3 (`pendingFloor`) and the party enters the boss room. After the Matriarch's intro, her HP is cut to 31% so she enters Frenzy, and the frame is taken while her dash telegraph is up. |
| `debrief` | debrief.png | The house Warzone at 5 v 5 (`/bots 9`). 195 s are fast-forwarded with the autopilot, and then more until Nova's team leads. Nova carries a legendary, an epic and a rare cache when the host ends the match with `/end`. The frame is taken after every reveal. |
| `resonance` | resonance.gif | Warzone. Nova's Juggernaut takes the Bulwark path (5 turret slots), holds still in an open patch, and seats four Arcanist teammates on Laser Lance, with the bots set to hard skill (a teammate that hops into the fifth seat is sent back out). The crop leans toward the lane. Tough drones stream in single file along an open lane, just outside laser range. Enemies off the lane are dropped and enemy-team pilots are moved out of the shot, so nothing reaches the host from behind. The host's energy is topped up throughout, so ×1.5³ resonance can fire for the full 6 s. |
| `dungeongif` | dungeon.gif | The sealed rift arena from `dungeon` (same thickened pulse), recorded for 6 s. |

Staging runs through `page.js`, which is evaluated in the game page and installs `window.__show`. It works on the in-page offline Zone (`client.transport.zone`), its Room and the room's Sim:

- **Fast-forward.** The room is ticked without building snapshots.
- **Autopilot.** A real `createBotBrain` brain produces the pilot's input, which goes through `client.sendInput`, so prediction stays in step.
- **Game functions.** Levels go through `grantXp` and `Sim.chooseUpgrade`, enemies are spawned with `spawnEnemy`, and turret seats use the same bookkeeping as `tryAttach` via `placeTurret`.
- **Teleports.**

Nothing is drawn by hand: the game renders whatever the sim holds.

## gif.mjs

`Page.startScreencast` delivers PNG frames of every paint, each with a timestamp. They are resampled to a constant 20 fps, cropped, scaled to 960 px wide, run through a **deadband**, and then passed through ffmpeg `palettegen` / `paletteuse`.

The deadband is there because of noise. Bloom halos, the reactive grid and twinkling stars shift most pixels by a few levels every frame, and that noise defeats the GIF's frame-difference compression. So a pixel keeps its previous value until it moves by at least `band` levels. A pixel whose input has settled takes its exact value, so fades leave no residue.

The encoder tries progressively coarser settings (band 12 → 26, 160 → 96 colours) until the file fits in 6 MB.

To re-encode kept frames without recording again (keep them outside the repo so they never end up in a commit):

```
node tools/showcase/capture.mjs --only resonance --keep-frames --tmp ../voidswarm-showcase-tmp
node tools/showcase/gif.mjs ../voidswarm-showcase-tmp/frames-resonance docs/assets/resonance.gif --crop 1280x640+160+80
```

## banner.mjs

`banner.svg` is a 1280×360 animated SVG built from SVG and SMIL only: no script and no external fonts, so GitHub renders it in an `<img>`.

- **Backdrop.** A deep-space gradient with twinkling stars, and a sun whose stripes drift down.
- **Floor.** A perspective neon grid whose horizontal lines scroll toward the viewer.
- **Ships.** They cross the sky with engine flicker and trails, and one fires at a pack of swarm drones. The silhouettes are the real class hulls, read from `src/client/render/shapes.ts` when the script runs. The colours are `TEAM_COLORS` from `src/shared/data/teams.ts`.
- **Wordmark.** VOIDSWARM is drawn as stroked paths with a chrome gradient, a glow and a sweeping shine, so it looks the same with any fonts. The tagline is `<text>` in a bold system-font stack.

`divider.svg` is a thin neon line with a travelling highlight.
