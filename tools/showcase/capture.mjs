// Voidswarm README showcase capture: real screenshots and GIFs of the offline game.
//
//   node tools/showcase/capture.mjs                  # every shot and GIF → docs/assets/
//   node tools/showcase/capture.mjs --only title,ctf # a subset (names below)
//   node tools/showcase/capture.mjs --url http://127.0.0.1:5173/   # use a running DEV server instead
//   node tools/showcase/capture.mjs --headed         # watch it drive a visible browser window
//
// It starts its own Vite dev server (port 5391, no HMR / no file watching), launches headless Edge or Chrome
// with --remote-debugging-port, and drives the OFFLINE game through the Chrome DevTools Protocol: clicks the
// real UI, sends real client messages, and stages moments through the in-page offline Zone (page.js). PNGs
// are fitted under 700 KB with ffmpeg; GIFs are recorded with Page.startScreencast and built with ffmpeg
// palettegen / paletteuse. Needs ffmpeg on PATH. See tools/showcase/README.md.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { encodeGif, ffmpeg } from './gif.mjs';
import { ROOT, startVite } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'docs', 'assets');
const W = 1600, H = 900;
const PNG_MAX = 700_000; // bytes (decimal KB, so the limit holds however it is counted)
const GIF_MAX = 6_000_000;

// ------------------------------------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);
const ALL = ['title', 'command', 'classes', 'hangar', 'ctf', 'warzone', 'dungeon', 'boss', 'debrief', 'resonance', 'dungeongif'];
const only = arg('only', '') ? arg('only', '').split(',').map((s) => s.trim()).filter(Boolean) : ALL;
for (const n of only) if (!ALL.includes(n)) { console.error(`unknown shot "${n}" (have: ${ALL.join(', ')})`); process.exit(2); }
const TMP = arg('tmp', join(tmpdir(), 'voidswarm-showcase'));
const PORT = Number(arg('port', 5391));
const CDP_PORT = Number(arg('cdp-port', 9391));
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[showcase]', ...a);

// ------------------------------------------------------------------------------------------------ ffmpeg
/** Luma standard deviation of a 64×36 thumbnail (0 = a flat, blank frame). */
function lumaSpread(pngPath) {
  const raw = ffmpeg(['-i', pngPath, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
  let s = 0, s2 = 0;
  for (const v of raw) { s += v; s2 += v * v; }
  const n = raw.length || 1, m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/**
 * Write `buf` (a viewport PNG) to docs/assets/<name>.png under PNG_MAX: re-encode losslessly first, then step
 * the width down (1440, 1280) before falling back to a 256-colour palette.
 */
function fitPng(name, buf) {
  const raw = join(TMP, `${name}.raw.png`);
  writeFileSync(raw, buf);
  const spread = lumaSpread(raw);
  if (spread < 6) throw new Error(`${name}: frame looks blank (luma spread ${spread.toFixed(1)})`);
  const out = join(OUT, `${name}.png`);
  const tries = [
    ['-pred', 'mixed', '-compression_level', '100'],
    ['-vf', 'scale=1440:-1:flags=lanczos', '-pred', 'mixed'],
    ['-vf', 'scale=1280:-1:flags=lanczos', '-pred', 'mixed'],
    ['-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a'],
    ['-vf', 'scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a'],
  ];
  for (const t of tries) {
    ffmpeg(['-i', raw, ...t, out]);
    const size = statSync(out).size;
    if (size <= PNG_MAX) { log(`${name}.png ${(size / 1024).toFixed(0)} KB (spread ${spread.toFixed(1)})`); return { path: out, size }; }
  }
  throw new Error(`${name}: could not fit under ${PNG_MAX} bytes`);
}

// ------------------------------------------------------------------------------------------------ page
let cdp, baseUrl, fsRoot;

async function ev(code, timeout = 60000) { return cdp.eval(code, { timeout }); }
async function until(code, ms = 30000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await ev(code); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${code}`);
    await sleep(step);
  }
}

const HELPERS = () => readFileSync(join(HERE, 'page.js'), 'utf8').replace("'__FS_ROOT__'", JSON.stringify(fsRoot));

/** Fresh page: the Pages-style title (offline first), callsign Nova, audio off, helpers installed. */
async function fresh({ seed = true } = {}) {
  await cdp.send('Page.navigate', { url: baseUrl });
  await until('!!(window.__voidswarm && window.__voidswarm.client)', 30000);
  await ev(HELPERS());
  if (seed) await ev(`(${seedProfile.toString()})()`);
  await until('document.fonts ? document.fonts.status === "loaded" : true', 10000).catch(() => {});
}

const INIT_SCRIPT = `
  window.VOIDSWARM_STATIC = true;
  try {
    localStorage.setItem('voidswarm.name', 'Nova');
    localStorage.setItem('voidswarm.settings', JSON.stringify({ aimMode: 'mouse', deadzone: 0.25, volume: 0, musicVolume: 0,
      musicMuted: true, screenShake: 0, showFps: false }));
  } catch (e) {}
`;

/**
 * Page-side: a device profile with a few evenings of history, rolled by the game's own grant code
 * (reproducible grant RNG), with a look equipped per class. Written where the offline Zone reads it.
 */
async function seedProfile() {
  const S = window.__show;
  const P = await S.mod('shared/profile/profile.ts');
  const R = await S.mod('shared/profile/rolls.ts');
  const { COSMETICS } = await S.mod('shared/data/cosmetics.ts');
  const now = Date.now();
  let p = P.defaultProfile(now - 9 * 86400e3);
  const types = ['warzone', 'arena', 'dungeon', 'warzone', 'arena', 'dungeon', 'warzone', 'arena', 'dungeon', 'warzone', 'arena', 'dungeon', 'warzone', 'arena'];
  const setOf = { warzone: 'swarm', arena: 'gladiator', dungeon: 'rift' };
  types.forEach((gt, i) => {
    const key = `showcase-${i}#local#0`;
    const tokens = [{ rarity: i % 4 === 0 ? 2 : 1, set: setOf[gt], source: 'elite' }, { rarity: 0, set: 'common', source: 'elite' }];
    const input = { grantKey: key, gameType: gt, tokens, crateRolls: 2, shards: 25, won: i % 3 !== 2, cachesLost: i % 5 === 0 ? 1 : 0 };
    p = R.rollGrant(p, input, R.grantRng(key, 'local'), now - (types.length - i) * 5 * 3600e3).profile;
  });
  // Equip the best owned item per slot for each class.
  const owned = Object.keys(p.owned).map((id) => COSMETICS[id]).filter(Boolean);
  const best = (f) => owned.filter(f).sort((a, b) => b.rarity - a.rarity)[0];
  const kitOf = { brute: 'flak', tech: 'laser', engineer: 'seeker' };
  for (const cls of ['brute', 'tech', 'engineer']) {
    for (const slot of ['hull', 'weapon']) {
      const d = best((c) => c.slot === slot && c.shipClass === cls);
      if (d) { const r = P.equip(p, slot, d.id, cls); if (r.ok) p = r.profile; }
    }
    const t = best((c) => c.slot === 'turret' && (c.kit === kitOf[cls] || !kitOf[cls]));
    if (t) { const r = P.equip(p, 'turret', t.id, cls); if (r.ok) p = r.profile; }
  }
  for (const slot of ['engine', 'death', 'title', 'killicon']) {
    const d = best((c) => c.slot === slot);
    if (d) { const r = P.equip(p, slot, d.id); if (r.ok) p = r.profile; }
  }
  // Older finds already looked at: keep NEW badges on the latest few only.
  p = P.markSeen(p, p.fresh.slice(6));
  localStorage.setItem('voidswarm.profile.device', JSON.stringify({ v: 1, profiles: { local: p }, ledger: [] }));
  return Object.keys(p.owned).length;
}

async function goOffline() {
  await until("!!document.querySelector('[data-nav=offline]')");
  await ev("__show.click('[data-nav=offline]')");
  await until("!!document.querySelector('[data-nav=qp-arena]') && __show.client.welcomed && __show.client.roomId === null", 20000);
  await sleep(400);
}

/** Quick Play a game type from Command and wait for the own ship in a running match. */
async function quickPlay(type) {
  await ev(`__show.click('[data-nav=qp-${type}]')`);
  await until("__show.room()?.phase === 'playing' && !!__show.ship() && document.body.classList.contains('in-game')", 30000);
  await ev('__show.watchEvents()');
  await sleep(300);
}

async function shot() { return cdp.screenshot(); }

async function viewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

/**
 * Sample the page for `ms`: every `step` ms evaluate `scoreExpr` (a number) and screenshot when it beats the
 * best so far; returns the best screenshot. `ready` (optional) must be truthy for a sample to count.
 */
async function bestOf(scoreExpr, ms, { step = 250, ready = 'true' } = {}) {
  let best = null, bestScore = -Infinity;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await ev(`(() => { if (!(${ready})) return -Infinity; return (${scoreExpr}); })()`).catch(() => -Infinity);
    if (s > bestScore) { bestScore = s; best = await shot(); }
    await sleep(step);
  }
  if (!best) best = await shot();
  log(`  best score ${bestScore}`);
  return best;
}

/** Count of things near the camera (the own ship). */
const inView = (what) => `(() => { const w = __show.world(), me = __show.ship(); if (!w || !me) return 0; let n = 0;
  for (const e of w.${what}.values()) if (Math.abs(e.x - me.x) < 760 && Math.abs(e.y - me.y) < 400 && (e.alive ?? true)) n++; return n; })()`;

// ------------------------------------------------------------------------------------------------ GIFs
/**
 * Record `sec` seconds with Page.startScreencast (every painted frame, timestamped), then build a GIF at
 * `fps` / `width` from the frames resampled to a constant rate. `crop` = [w, h] around the viewport centre,
 * or [w, h, x, y].
 */
async function record(name, sec, { fps = 20, width = 960, crop = [W, H], during, nth = 3 } = {}) {
  const dir = join(TMP, `frames-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const off = cdp.on('Page.screencastFrame', async (p) => {
    const i = frames.length;
    const file = join(dir, `f${String(i).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(p.data, 'base64'));
    frames.push({ file, t: p.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  // PNG frames: JPEG noise in the black would change every pixel every frame and bloat the GIF.
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: nth });
  const t0 = Date.now();
  while (Date.now() - t0 < sec * 1000) {
    if (during) await during((Date.now() - t0) / 1000);
    await sleep(100);
  }
  await cdp.send('Page.stopScreencast');
  off();
  await sleep(200);
  if (frames.length < fps * sec * 0.5) throw new Error(`${name}: only ${frames.length} frames captured`);
  // Constant-rate list: for each output tick pick the latest frame at or before it.
  const start = frames[0].t;
  const list = [];
  let j = 0;
  const n = Math.floor(sec * fps);
  for (let k = 0; k < n; k++) {
    const t = start + k / fps;
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    list.push(frames[j].file);
  }
  const concat = join(dir, 'list.txt');
  writeFileSync(concat, list.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nduration ${1 / fps}`).join('\n') + '\n');
  log(`  ${frames.length} frames painted in ${sec}s → ${list.length} GIF frames`);
  const out = join(OUT, `${name}.gif`);
  const r = await encodeGif(concat, out, { dir, fps, width, crop, view: [W, H], maxBytes: GIF_MAX, log });
  log(`${name}.gif ${(r.size / 1048576).toFixed(2)} MB (deadband ${r.variant.band}, ${r.variant.colors} colours)`);
  return { path: r.path, size: r.size };
}

// ------------------------------------------------------------------------------------------------ shots
const SHOTS = {
  /** Title: the attract scene mid Juggernaut set-piece (scene time ≈ 12 s), Pages-style offline-first panel. */
  async title() {
    await fresh();
    await until('(window.__voidswarmTitle?.director?.t ?? 0) >= 12.2', 30000, 20);
    return fitPng('title', await shot());
  },

  /** Command: live games list (Arena), every house room running, the zone's own /rooms answer in Comms. */
  async command() {
    await fresh();
    await goOffline();
    await ev(`(() => {
      const z = __show.zone;
      const mk = (patch) => z.createRoomInternal(z.settingsFor(patch), true);
      mk({ gameType: 'arena', subMode: 'zones', name: 'Grid Lock', teamCount: 3 });
      mk({ gameType: 'arena', subMode: 'hotpoint', name: 'Hot Wire', mode: 'ffa' });
      for (const r of __show.rooms()) { __show.keepAlive(r); r.startCountdown(); }
    })()`);
    await until("__show.rooms().every((r) => r.phase === 'playing')", 20000);
    await sleep(9000); // scorelines tick up
    await ev("__show.click('[data-nav=gt-arena]')");
    await ev("__show.client.sendChat('all', '/rooms')");
    await sleep(1500);
    return fitPng('command', await shot());
  },

  /** Room lobby: class picker + build planner (Arcanist, Void path tab). Taller viewport: the whole planner. */
  async classes() {
    await viewport(W, 1250);
    try {
      await fresh();
      await goOffline();
      await ev("(() => { const r = __show.rooms().find((x) => x.settings.gameType === 'warzone'); __show.client.joinRoom(r.id, 'lobby'); })()");
      await until("!!__show.client.roomId && !!document.querySelector('[data-nav=\"class-tech\"]')", 15000);
      await sleep(500);
      await ev("__show.click('[data-nav=\"team-auto\"]')");
      await sleep(500);
      // Pick the Arcanist in the class picker, then its second build path (Void) in the planner.
      await ev("__show.click('[data-nav=\"class-tech\"]')");
      await until("__show.client.me?.shipClass === 'tech'", 5000).catch(() => {});
      await sleep(400);
      await ev("__show.click('[data-nav=\"path-tab-1\"]')");
      await sleep(700);
      return fitPng('classes', await shot());
    } finally { await viewport(W, H); }
  },

  /** Hangar: the seeded device profile, an epic+ item selected in the detail drawer. */
  async hangar() {
    await fresh();
    await goOffline();
    await ev("__show.click('[data-nav=cmd-hangar]')");
    await until("!!document.querySelector('[data-nav^=\"hg-item-\"]')", 10000);
    await ev("document.querySelector('[data-nav=\"hg-class-tech\"]')?.click()");
    await sleep(400);
    await ev(`(async () => {
      const { COSMETICS } = await __show.mod('shared/data/cosmetics.ts');
      const tiles = [...document.querySelectorAll('[data-nav^="hg-item-"]')];
      const score = (el) => { const d = COSMETICS[el.getAttribute('data-nav').slice(8)]; return d ? d.rarity * 10 - (el.className.includes('locked') ? 100 : 0) : -1e9; };
      tiles.sort((a, b) => score(b) - score(a));
      tiles[0]?.click();
    })()`);
    await sleep(800);
    return fitPng('hangar', await shot());
  },

  /** Arena CTF: Nova steals the Azure pennant; the brawl around the carrier, CTF HUD strip + Flag Overload. */
  async ctf() {
    await fresh();
    await goOffline();
    await quickPlay('arena');
    await ev('__show.autopilot(true)');
    await ev('__show.fastForward(30)');
    await sleep(10000); // let the kill feed of the fast-forward fade
    // Nova grabs the enemy pennant: fly onto it whenever it is not already in someone's hold.
    const mine = "__show.world().objective.flags.some((f) => f.carrierId === __show.ship()?.id)";
    const t0 = Date.now();
    while (!(await ev(mine))) {
      if (Date.now() - t0 > 40000) throw new Error('ctf: the enemy flag never came free');
      await ev(`(() => {
        const w = __show.world(), me = __show.ship();
        const f = w.objective.flags.find((x) => x.team !== me.team);
        if (me.alive && f.state !== 'carried') __show.tp(me, f.x - 20, f.y);
      })()`);
      await sleep(400);
    }
    await sleep(2500);
    return fitPng('ctf', await bestOf(`${inView('ships')} * 3 + ${inView('projectiles')} * 0.2`, 6000, {
      ready: "__show.world().objective.flags.some((f) => f.carrierId === __show.ship()?.id)",
    }));
  },

  /** Warzone: a battle-station host with three turrets in a swarm, the level-6 talent cards up. */
  async warzone() {
    await fresh();
    await goOffline();
    await quickPlay('warzone');
    await ev('__show.autopilot(true)');
    await ev('__show.fastForward(80)');
    await sleep(9500);
    await ev(`(async () => {
      const S = __show, me = S.ship();
      S.clearOffers(me);
      await S.levelTo(me, 5, 'bulwark');
      S.clearOffers(me);
      const spot = await S.openSpot(650);
      S.tp(me, spot.x, spot.y);
      await S.autopilot(false);
      S.manual((s, w) => {
        let tx = s.x + 300, ty = s.y, bd = 1e12;
        for (const e of w.enemies.values()) { const q = (e.x - s.x) ** 2 + (e.y - s.y) ** 2; if (q < bd) { bd = q; tx = e.x; ty = e.y; } }
        const hx = spot.x - s.x, hy = spot.y - s.y, hd = Math.hypot(hx, hy), k = hd > 40 ? Math.min(1, hd / 200) : 0;
        return { aim: Math.atan2(ty - s.y, tx - s.x), moveX: hd ? (hx / hd) * k : 0, moveY: hd ? (hy / hd) * k : 0, primary: bd < 700 * 700 };
      });
      // Three teammates take the turret seats (off whatever seat or host role they had).
      const { detachTurret, shakeOffTurrets } = await S.mod('shared/sim/turrets.ts');
      const w = S.world();
      const mates = S.botShips((s) => s.team === me.team && s.alive && s.id !== me.id).slice(0, 3);
      for (const m of mates) {
        if (m.turrets.length) shakeOffTurrets(w, m, 0);
        if (m.attachedTo) detachTurret(w, m, 0);
        S.tp(m, me.x, me.y);
        await S.attach(m, me);
      }
    })()`);
    await sleep(1500); // the camera settles on the new spot
    await ev(`(async () => {
      const S = __show, me = S.ship();
      await S.ring('drone', 28, me.x, me.y, 400);
      await S.ring('dart', 10, me.x, me.y, 500);
      await S.ring('weaver', 10, me.x, me.y, 580);
      await S.ring('spinner', 4, me.x, me.y, 620);
      await S.ring('brute', 2, me.x, me.y, 650);
      await S.xp(me.xpToNext - me.xp + 1); // the next level-up: its cards show on screen
    })()`);
    await sleep(900);
    return fitPng('warzone', await bestOf(`${inView('enemies')} + ${inView('projectiles')} * 0.1 + (__show.ship().turrets.length * 5)`, 2500, {
      step: 150,
      ready: '__show.ship()?.offers.length > 0 && __show.ship().turrets.length > 0',
    }));
  },

  /** Dungeon Runner: the party seals an arena room; RiftHud, spawn warnings and a force-field door in frame. */
  async dungeon() {
    await fresh();
    await goOffline();
    await quickPlay('dungeon');
    await stageRiftArena();
    await sleep(1000);
    await ev(THICKEN_PULSE);
    await sleep(600);
    return fitPng('dungeon', await bestOf(`${inView('enemies')} + ${inView('projectiles')} * 0.1 + (__show.evAge('spawnWarn') < 1 ? 6 : 0)`, 3500, { step: 200 }));
  },

  /** The Hive Matriarch (floor 3 boss room), caught while one of her attacks is telegraphed. */
  async boss() {
    await fresh();
    await goOffline();
    await quickPlay('dungeon');
    await stageBoss();
    // The final phase (Frenzy) telegraphs its dash with a warning line: take the frame while one is up.
    return fitPng('boss', await bestOf(`(() => {
      const w = __show.world(), me = __show.ship(), b = w.enemies.get(w.dungeon.bossId);
      if (!b || !me) return -1;
      __show.clearOffers(me);
      // she must be fully in frame and clear of the bottom HUD (the camera centres on Nova)
      const dx = b.x - me.x, dy = b.y - me.y;
      const near = Math.abs(dx) < 560 && dy > -240 && dy < 170 ? 25 - (Math.abs(dx) + Math.abs(dy)) / 100 : 0;
      // a dash warning well under way (0.8 s long), its line inside the frame; longer lines read better
      const t = __show.lastTelegraph, age = __show.evAge('telegraph');
      let tg = 0;
      if (t && age > 0.3 && age < 0.75) {
        const mx = (t.x + t.x2) / 2, my = (t.y + t.y2) / 2;
        if (Math.abs(mx - me.x) < 700 && Math.abs(my - me.y) < 380) tg = 20 + Math.hypot(t.x2 - t.x, t.y2 - t.y) / 40;
      }
      return near + tg + (near > 0 && tg > 0 ? 40 : 0) + ${inView('projectiles')} * 0.03;
    })()`, 24000, { step: 120 }));
  },

  /** Results: a Warzone match ended by the host after ~3 minutes, the Debrief revealing caches and crates. */
  async debrief() {
    await fresh();
    await goOffline();
    // The house Warzone as host: 5 v 5 (/bots 9), started from the lobby.
    await ev("(() => { const r = __show.rooms().find((x) => x.settings.gameType === 'warzone'); __show.client.joinRoom(r.id, 'lobby'); })()");
    await until("!!__show.client.roomId && !!document.querySelector('[data-nav=\"team-auto\"]')", 15000);
    await ev("__show.click('[data-nav=\"team-auto\"]')");
    await sleep(300);
    await ev("__show.client.sendChat('all', '/bots 9')");
    await sleep(300);
    await ev("__show.client.send({ type: 'startMatch' })");
    await until("__show.room()?.phase === 'playing' && !!__show.ship() && document.body.classList.contains('in-game')", 30000);
    await ev('__show.autopilot(true)');
    await ev('__show.fastForward(195, { mortal: true })');
    // A few more seconds at a time until Nova's team leads (at most one extra minute).
    for (let i = 0; i < 12; i++) {
      const lead = await ev('(() => { const w = __show.world(), t = __show.ship().team, s = w.match.teamScores; return s[t] > Math.max(...s.filter((_, j) => j !== t)); })()');
      if (lead) break;
      await ev('__show.fastForward(5, { mortal: true })');
    }
    await sleep(1500);
    // Caches in the hold at the whistle are secured and revealed with the crates.
    await ev(`(() => {
      const s = __show.ship();
      s.carried = [{ rarity: 4, set: 'swarm', source: 'boss' }, { rarity: 3, set: 'swarm', source: 'elite' }, { rarity: 2, set: 'common', source: 'elite' }];
    })()`);
    await sleep(400);
    await ev("__show.client.sendChat('all', '/end')");
    await until("!!document.querySelector('.debrief:not(.hidden) .db-item')", 10000);
    await until("document.querySelectorAll('.debrief .db-item.sealed').length === 0", 10000).catch(() => {});
    await sleep(1200);
    return fitPng('debrief', await shot());
  },

  /** GIF: a Juggernaut battle station carrying four Laser Lance turrets — the resonance beam into a swarm. */
  async resonance() {
    await fresh();
    await goOffline();
    await quickPlay('warzone');
    // Level up before the fast-forward: its events (and so the level-up banners) never reach the client.
    await ev(`(async () => { const S = __show, me = S.ship(); await S.levelTo(me, 5, 'bulwark'); S.clearOffers(me); })()`);
    await ev('__show.fastForward(6)');
    await ev(`(async () => {
      const S = __show, me = S.ship(), w = S.world(), room = S.room();
      S.clearOffers(me);
      const spot = await S.openSpot(620, { horizontal: true });
      S.tp(me, spot.x, spot.y);
      const mates = S.botShips((s) => s.team === me.team && s.alive && !s.attachedTo).slice(0, 4);
      room.settings.botSkill = 'hard'; // sharper gunners: quicker target acquisition keeps the beams on
      for (const m of mates) {
        const rp = room.players.find((p) => p.playerId === m.playerId);
        if (rp) { rp.shipClass = 'tech'; rp.brain = null; }
        room.sim.setShipClass(m.playerId, 'tech');
      }
      for (const m of mates) { const s = S.ship(m.playerId); S.tp(s, me.x, me.y); await S.attach(s, me); }
      S.lasers = mates.map((m) => m.id);
      S.heading = spot.dir;
      // The host holds still and faces the lane; the four turrets pick their own targets.
      S.manual(() => ({ aim: S.heading }));
      return mates.length;
    })()`);
    await sleep(1200);
    // Staging for a readable clip:
    // - the swarm streams in single file along the open lane: tough drones, spawned just outside laser range, so
    //   each one holds the converged beams for a moment on its way in;
    // - anything off the lane (the wave director's own spawns) is dropped, and enemy-team pilots are moved out
    //   of the shot, so nothing reaches the host from behind;
    // - the host's energy is topped up throughout, so four lasers at ×1.5³ resonance can fire for the clip.
    const wave = async () => ev(`(async () => {
      const S = __show, me = S.ship(), w = S.world();
      const { discardEnemy } = await S.mod('shared/sim/pve/enemies.ts');
      const { detachTurret } = await S.mod('shared/sim/turrets.ts');
      // Exactly the four lasers: a teammate that hops into the fifth Bulwark seat is sent back out.
      for (const id of [...me.turrets]) { const t = w.ships.get(id); if (t && !S.lasers.includes(id)) detachTurret(w, t); }
      for (const e of [...w.enemies.values()]) {
        const d = Math.hypot(e.x - me.x, e.y - me.y);
        let da = Math.atan2(e.y - me.y, e.x - me.x) - S.heading;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        if (d < 1800 && Math.abs(da) > 0.9) discardEnemy(w, e);
      }
      const a = S.heading + (Math.random() - 0.5) * 0.5, r = 680 + Math.random() * 60;
      await S.spawn('drone', me.x + Math.cos(a) * r, me.y + Math.sin(a) * r, { hpScale: 8 });
      for (const s of w.ships.values()) {
        if (s.team === me.team || !s.alive) continue;
        if (Math.hypot(s.x - me.x, s.y - me.y) < 1700) S.tp(s, me.x - Math.cos(S.heading) * 2600, me.y - Math.sin(S.heading) * 2600);
      }
      me.energy = Math.max(me.energy, me.stats.maxEnergy * 0.9);
    })()`);
    for (let i = 0; i < 6; i++) { await wave(); await sleep(600); } // the stream reaches a steady state
    let next = 0;
    // Frame the lane: the crop leans toward the side the swarm comes from; the bottom HUD bar (glass over the
    // game, so noisy) is cropped out.
    const heading = await ev('__show.heading');
    return record('resonance', 6, {
      crop: [1280, 640, Math.cos(heading) < 0 ? 0 : W - 1280, 80],
      during: async (t) => {
        await ev('(() => { const me = __show.ship(); if (me) me.energy = Math.max(me.energy, me.stats.maxEnergy * 0.9); })()');
        if (t >= next) { next = t + 0.6; await wave(); }
      },
    });
  },

  /** GIF: the party fighting inside a sealed rift arena. */
  async dungeongif() {
    await fresh();
    await goOffline();
    await quickPlay('dungeon');
    await stageRiftArena();
    await sleep(1000);
    await ev(THICKEN_PULSE);
    await sleep(400);
    return record('dungeon', 6, { crop: [1280, 680, 160, 0] }); // Rift HUD strip in, the bottom HUD bar out
  },
};

/** Staging: thicken the sealed room's first encounter pulse (a floor-1 pulse is small) so the frame is busy. */
const THICKEN_PULSE = `(async () => {
  const S = __show, me = S.ship();
  await S.ring('drone', 10, me.x, me.y, 460);
  await S.ring('dart', 4, me.x, me.y, 520);
  await S.ring('splitter', 2, me.x, me.y, 560);
})()`;

/** Rift: park the party just inside the first arena room's door and hold there until it seals. */
async function stageRiftArena() {
  await ev(`(async () => {
    const S = __show, w = S.world();
    const L = w.map.dungeon;
    const room = L.rooms.filter((r) => r.kind === 'arena').sort((a, b) => a.depth - b.depth)[0];
    const door = room.doors[0];
    // 260 px from the door toward the room centre: the sealed door stays in frame.
    const dx = room.x - door.inX, dy = room.y - door.inY, d = Math.hypot(dx, dy) || 1;
    const px = door.inX + (dx / d) * 200, py = door.inY + (dy / d) * 200;
    let i = 0;
    for (const s of w.ships.values()) { S.tp(s, px + (i % 2 ? 70 : -70), py + (i < 2 ? -60 : 60)); i++; }
    S.manual((s, w) => {
      let tx = room.x, ty = room.y, bd = 1e12;
      for (const e of w.enemies.values()) { const q = (e.x - s.x) ** 2 + (e.y - s.y) ** 2; if (q < bd) { bd = q; tx = e.x; ty = e.y; } }
      const hx = px - s.x, hy = py - s.y, hd = Math.hypot(hx, hy);
      const k = hd > 40 ? Math.min(1, hd / 200) : 0;
      return { aim: Math.atan2(ty - s.y, tx - s.x), moveX: hd ? (hx / hd) * k : 0, moveY: hd ? (hy / hd) * k : 0, primary: bd < 800 * 800, secondary: bd < 500 * 500 };
    });
    S.riftRoom = room.idx;
  })()`);
  await until('__show.world().dungeon.rooms[__show.riftRoom].state === 2', 15000);
}

/** Rift: jump the run to floor 3, walk the party into the boss room and let the autopilot fight. */
async function stageBoss() {
  await ev('__show.world().dungeon.pendingFloor = 3');
  await until('__show.world().dungeon.floor === 3 && __show.client.latest?.match?.dungeon?.floor === 3', 15000);
  await sleep(800);
  await ev(`(async () => {
    const S = __show, w = S.world();
    const room = w.map.dungeon.rooms.find((r) => r.kind === 'boss');
    const door = room.doors[0];
    const dx = room.x - door.inX, dy = room.y - door.inY, d = Math.hypot(dx, dy) || 1;
    const px = door.inX + (dx / d) * 260, py = door.inY + (dy / d) * 260;
    let i = 0;
    for (const s of w.ships.values()) { S.tp(s, px + (i % 2 ? 70 : -70), py + (i < 2 ? -60 : 60)); i++; }
    await S.levelTo(S.ship(), 4, 'barrage');
    S.clearOffers(S.ship());
    await S.autopilot(true);
    S.watchEvents();
  })()`);
  await until('__show.evAge("bossIntro") < 60', 15000);
  await sleep(5000);
  // Skip ahead to her last third (Frenzy: the dash with a telegraphed line every 6 s).
  await ev('(() => { const w = __show.world(), b = w.enemies.get(w.dungeon.bossId); if (b) b.hp = Math.min(b.hp, b.maxHp * 0.31); })()');
  await until('__show.world().dungeon.bossPhase >= 3', 8000).catch(() => {});
  await sleep(1500);
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  let vite = null;
  if (arg('url')) baseUrl = arg('url');
  else { vite = await startVite(PORT); baseUrl = vite.url; }
  const origin = new URL(baseUrl).origin;
  const posix = ROOT.replace(/\\/g, '/');
  fsRoot = `${origin}/@fs${posix.startsWith('/') ? '' : '/'}${encodeURI(posix)}`;
  log(`vite ${baseUrl}`);
  const browser = await launch({ width: W, height: H, port: CDP_PORT, tmpDir: TMP, headless: !flag('headed') });
  cdp = browser.cdp;
  log(`browser ${browser.exe}`);
  const results = [];
  let failed = 0;
  try {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
    const gpu = await (async () => {
      await cdp.send('Page.navigate', { url: 'about:blank' });
      return ev(`(() => { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return 'none';
        const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);
    })();
    log(`WebGL: ${gpu}`);
    for (const name of only) {
      log(`— ${name}`);
      try {
        const r = await SHOTS[name]();
        results.push({ name, ...r });
      } catch (e) {
        failed++;
        console.error(`[showcase] ${name} FAILED: ${e.stack || e.message}`);
      }
    }
  } finally {
    await browser.close();
    if (vite) await vite.close();
  }
  console.log('\nAssets:');
  for (const r of results) console.log(`  ${r.path.slice(ROOT.length + 1).replace(/\\/g, '/')}  ${(r.size / 1024).toFixed(0)} KB`);
  if (!flag('keep-frames')) for (const f of readdirSync(TMP)) if (f.startsWith('frames-') || f.endsWith('.raw.png')) rmSync(join(TMP, f), { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
