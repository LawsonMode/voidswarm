// In-page staging helpers for the showcase capture. capture.mjs evaluates this file in the game page (DEV
// build only) after filling in the FS placeholder with the repo's /@fs/ URL prefix; it installs window.__show.
// Everything here drives the real offline game: the in-page Zone (client.transport.zone), its Room, and
// the room's Sim. Nothing is drawn by hand: the game renders what the sim holds.
((FS_ROOT) => {
  if (window.__show && window.__show.fs === FS_ROOT) return "already";
  const FS = FS_ROOT;
  const mods = new Map();
  const S = {
    fs: FS,
    /** Import a src/ module through Vite (the same module instance the game uses). */
    async mod(rel) {
      if (!mods.has(rel)) mods.set(rel, await import(/* @vite-ignore */ `${FS}/src/${rel}`));
      return mods.get(rel);
    },
    get client() { return window.__voidswarm?.client; },
    get zone() { return S.client?.transport?.zone ?? null; },
    rooms() { return S.zone ? [...S.zone.rooms.values()] : []; },
    /** The room the local pilot is in. */
    room() { const id = S.client?.roomId; return S.rooms().find((r) => r.id === id) ?? null; },
    world() { return S.room()?.sim?.world ?? null; },
    rp() { const r = S.room(); return r ? r.players.find((p) => p.playerId === S.client.playerId) : null; },
    ship(pid = S.client?.playerId) {
      const w = S.world(); if (!w) return null;
      const id = w.shipsByPlayer.get(pid);
      return id ? w.ships.get(id) ?? null : null;
    },
    bots() { const r = S.room(); return r ? r.players.filter((p) => p.isBot) : []; },
    botShips(filter = () => true) {
      const w = S.world(); if (!w) return [];
      return [...w.ships.values()].filter((s) => s.isBot && filter(s));
    },
    click(sel) {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element ${sel}`);
      el.click();
      return true;
    },
    has(sel) { return !!document.querySelector(sel); },
    async until(fn, ms = 20000, step = 50) {
      const t0 = performance.now();
      for (;;) {
        let v; try { v = fn(); } catch { v = undefined; }
        if (v) return v;
        if (performance.now() - t0 > ms) throw new Error(`timeout waiting for ${fn}`);
        await new Promise((r) => setTimeout(r, step));
      }
    },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    /** Keep a bots-only room alive (the bots-only abort would stop it after 10 s). */
    keepAlive(room) {
      if (room.__keep) return;
      room.__keep = true;
      const orig = room.tick.bind(room);
      room.tick = () => { room.emptyTicks = -1e9; orig(); };
    },
    /**
     * Fast-forward the local pilot's room by `sec` sim-seconds in one go (bots think, the sim steps; no
     * snapshots are built meanwhile). With the autopilot on, its brain flies the pilot's ship meanwhile and
     * answers level-up offers the way the Room answers them for bots. The ship is kept safe unless `mortal`.
     */
    fastForward(sec, { mortal = false, pick = true } = {}) {
      const room = S.room(), rp = S.rp();
      if (!room || !rp) throw new Error('not in a room');
      const was = rp.watching;
      rp.watching = false;
      const n = Math.round(sec * 60);
      try {
        for (let i = 0; i < n; i++) {
          const w = room.sim?.world, s = S.ship();
          if (w && s) {
            if (!mortal) s.invulnUntilTick = Math.max(s.invulnUntilTick, w.tick + 2);
            if (S.brain && S.client.sendInput !== S.client.__origSendInput) {
              const inp = S.patchInput({ ...S.brain.think(w, s) }, s, w);
              inp.seq = s.lastInputSeq;
              room.sim.setInput(s.playerId, inp);
              if (pick && s.offers.length && w.tick % 30 === 0) {
                const idx = S.brain.chooseUpgrade(w, s, s.offers[0]);
                room.sim.chooseUpgrade(s.playerId, idx >= 0 && idx < s.offers[0].length ? idx : 0, undefined);
              }
            }
          }
          room.tick();
          if (room.phase !== 'playing') break;
        }
      } finally { rp.watching = was; room.forceSnapshot = true; }
      return room.sim?.world.tick ?? -1;
    },
    /** Answer every pending level-up offer of a ship (brain's choice, else the first card). */
    clearOffers(ship = S.ship()) {
      const room = S.room(), w = S.world();
      let guard = 0;
      while (ship.offers.length && guard++ < 40) {
        const idx = S.brain ? S.brain.chooseUpgrade(w, ship, ship.offers[0]) : 0;
        room.sim.chooseUpgrade(ship.playerId, idx >= 0 && idx < ship.offers[0].length ? idx : 0, undefined);
      }
    },
    /** Record when each sim event type last fired (performance.now() ms), for timing shots. */
    watchEvents() {
      const sim = S.room()?.sim;
      if (!sim || sim.__watched) return;
      sim.__watched = true;
      S.evAt = S.evAt || {};
      const orig = sim.drainEvents.bind(sim);
      sim.drainEvents = () => {
        const evs = orig();
        const t = performance.now();
        for (const e of evs) { S.evAt[e.t] = t; if (e.t === 'telegraph') S.lastTelegraph = { ...e, at: t }; }
        return evs;
      };
    },
    evAge(type) { const t = S.evAt?.[type]; return t ? (performance.now() - t) / 1000 : Infinity; },
    /** Move a ship (and anything attached to it follows on the next step). */
    tp(ship, x, y) { ship.x = x; ship.y = y; ship.vx = 0; ship.vy = 0; },
    // ---- autopilot: a real bot brain flies the local pilot's ship through the normal input path ----
    /** The pilot stays a flying ship (the brain may not take a turret seat) unless turret is true. */
    patchInput(inp, s, w) {
      if (!S.turretOk) inp.attach = false;
      if (S.inputPatch) Object.assign(inp, S.inputPatch(inp, s, w));
      return inp;
    },
    async autopilot(on, skill = 'hard', { turret = false } = {}) {
      S.turretOk = turret;
      const c = S.client;
      if (!c.__origSendInput) c.__origSendInput = c.sendInput.bind(c);
      if (!on) { c.sendInput = c.__origSendInput; S.inputPatch = null; S.brain = null; return false; }
      const { createBotBrain } = await S.mod('shared/ai/bots.ts');
      const brain = createBotBrain(skill, 4242);
      S.brain = brain;
      c.sendInput = (partial) => {
        const w = S.world(), s = S.ship();
        if (w && s) {
          const inp = { ...brain.think(w, s) };
          delete inp.seq;
          return c.__origSendInput(S.patchInput(inp, s, w));
        }
        return c.__origSendInput(partial);
      };
      return true;
    },
    /** Fixed input (no brain): fn(ship, world) → partial InputState, merged over an idle input. */
    manual(fn) {
      const c = S.client;
      if (!c.__origSendInput) c.__origSendInput = c.sendInput.bind(c);
      c.sendInput = (partial) => {
        const w = S.world(), s = S.ship();
        const base = { moveX: 0, moveY: 0, aim: partial.aim, aimDist: 300, primary: false, secondary: false, mobility: false,
          utility: false, afterburner: false, attach: false, attachTarget: 0, detach: false };
        return c.__origSendInput(w && s ? { ...base, ...fn(s, w) } : partial);
      };
    },
    /** Attach `turret` ship onto `host` as a turret (the same bookkeeping tryAttach does). */
    async attach(turret, host) {
      const { placeTurret } = await S.mod('shared/sim/turrets.ts');
      const w = S.world();
      if (turret.attachedTo || host.turrets.includes(turret.id)) return;
      host.turrets.push(turret.id);
      turret.attachedTo = host.id;
      placeTurret(w, turret);
      w.events.push({ t: 'attach', turretShipId: turret.id, hostShipId: host.id });
    },
    /** Give the local ship XP through the PVE xp path (queues the real level-up offers). */
    async xp(amount, ship = S.ship()) {
      const { grantXp } = await S.mod('shared/sim/pve/index.ts');
      grantXp(S.world(), ship, amount);
    },
    /** Level a ship to `level` and pick `path` at the fork (the Sim's own chooseUpgrade). */
    async levelTo(ship, level, path) {
      const room = S.room();
      const { grantXp } = await S.mod('shared/sim/pve/index.ts');
      const w = S.world();
      let guard = 0;
      while (ship.level < level && guard++ < 40) {
        grantXp(w, ship, Math.max(1, ship.xpToNext - ship.xp + 0.01));
        while (ship.offers.length) {
          const offer = ship.offers[0];
          let idx = offer.findIndex((o) => o.id === `path:${path}`);
          if (idx < 0) idx = 0;
          room.sim.chooseUpgrade(ship.playerId, idx, undefined);
        }
      }
    },
    async spawn(kind, x, y, opts) {
      const { spawnEnemy } = await S.mod('shared/sim/pve/enemies.ts');
      return spawnEnemy(S.world(), kind, x, y, opts);
    },
    /** Spawn `n` enemies of `kind` in a ring of radius r around (x, y). */
    async ring(kind, n, x, y, r, opts) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
        const e = await S.spawn(kind, x + Math.cos(a) * r * (0.8 + Math.random() * 0.4), y + Math.sin(a) * r * (0.8 + Math.random() * 0.4), opts);
        if (e) out.push(e);
      }
      return out;
    },
    /**
     * An open patch of the current map: a point with no solid tile within `clear` px, and the direction
     * (`dir`, radians) with the longest open run from it (where a swarm can come from). `horizontal` limits
     * `dir` to within ±27° of left / right, so a lane fits a 16:9 frame.
     */
    async openSpot(clear = 600, { horizontal = false } = {}) {
      const { isSolidAt } = await S.mod('shared/sim/map.ts');
      const map = S.world().map;
      const Wpx = map.cols * map.tileSize, Hpx = map.rows * map.tileSize;
      const openDisk = (x, y, r) => {
        for (let rr = 0; rr <= r; rr += 48) {
          const n = Math.max(1, Math.round((rr * Math.PI * 2) / 48));
          for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; if (isSolidAt(map, x + Math.cos(a) * rr, y + Math.sin(a) * rr)) return false; }
        }
        return true;
      };
      let best = null;
      for (let k = 0; k < 4000 && !best; k++) {
        const x = clear + Math.random() * (Wpx - 2 * clear), y = clear + Math.random() * (Hpx - 2 * clear);
        if (openDisk(x, y, clear)) best = { x, y };
      }
      if (!best) best = { x: S.ship().x, y: S.ship().y };
      let dir = 0, run = -1;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        if (horizontal && Math.abs(Math.sin(a)) > 0.45) continue;
        let d = 0;
        while (d < 2500 && !isSolidAt(map, best.x + Math.cos(a) * d, best.y + Math.sin(a) * d)) d += 32;
        if (d > run) { run = d; dir = a; }
      }
      return { ...best, dir, run };
    },
    /** Quick state readout (debugging a staging step). */
    info() {
      const w = S.world(), s = S.ship();
      return {
        screen: document.body.className, room: S.room()?.id, phase: S.room()?.phase,
        tick: w?.tick, ship: s ? { x: Math.round(s.x), y: Math.round(s.y), alive: s.alive, level: s.level, cls: s.shipClass } : null,
        enemies: w?.enemies.size, ships: w?.ships.size,
      };
    },
  };
  window.__show = S;
  return 'installed';
})('__FS_ROOT__');
