// Voidswarm v1.0 "Shields Down" — independent numeric model (SCRATCH, not project code).
// Core: spec constants, damage pipeline (§2), shield regen (§3), power / strain / brownout / breaker (§4), weapons (§5).
// Tick order mirrors Sim.ts: pass 1 engines (thrust + AB) -> pass 3 reactor -> weapons -> skills -> shield regen.
export const DT = 1 / 60;
export const TICK = 60;
export const ticks = (s) => Math.round(s * TICK);

// ---- §2 damage types ----
export const SM = { kinetic: 0.75, energy: 1.0, ion: 2.0, blast: 1.0, hazard: 1.0 }; // vs shield
export const HM = { kinetic: 1.25, energy: 1.0, ion: 0.8, blast: 1.0, hazard: 1.0 }; // vs hull
export const GATE = 0.2, ARMOR_CAP = 0.75, ION_DELAY = 0.5, ION_DELAY_MAX = 2;
// ---- §3 / §4 ----
export const FIRE_MULT = 0.5, IDLE_MULT = 1.25, FIRE_WIN = 0.4;
export const STRAIN_MOVE = [1, 1, 0.85, 0.7], STRAIN_SHIELD = [1, 1, 0.5, 0], STRAIN_DRAW = [1, 1, 1.2, 1.45];
export const BROWN = 0.25, BROWN_MIN_MOVE = 0.6, BREAKER_SEC = 1, BREAKER_REGEN = 1.5, SPEED_FLOOR = 0.4;
export const HEAT_HOT = 60, HEAT_RESUME = 70, HEAT_COOL_DELAY = 0.3;

// ---- §1 / §4.2 / §6 per-class numbers ----
export const CLS = {
  brute: {
    name: 'Juggernaut', S: 800, Sreg: 320, Sdel: 2.5, Sbrk: 4.0, hard: 0.15, spc: 0.40, H: 900, armor: 0.35,
    P: 1000, Preg: 190, thrustC: 35, abC: 320, thrust: 650, maxSpeed: 430, abSpeed: 640, drag: 0.55, brake: 60, turn: 8, radius: 22,
    sec: { name: 'Rocket Salvo', cost: 150, cd: 1.4 }, mob: { name: 'Ram Charge', cost: 110, cd: 6 }, util: { name: 'Polarize', cost: 120, cd: 9 },
  },
  tech: {
    name: 'Arcanist', S: 600, Sreg: 400, Sdel: 2.0, Sbrk: 3.25, hard: 0, spc: 0.40, H: 450, armor: 0,
    P: 1300, Preg: 230, thrustC: 20, abC: 380, thrust: 1300, maxSpeed: 500, abSpeed: 760, drag: 6.0, brake: 900, turn: 16, radius: 16,
    sec: { name: 'Arc Lightning', cost: 130, cd: 1.1 }, mob: { name: 'Blink', cost: 120, cd: 5 }, util: { name: 'Singularity', cost: 200, cd: 10 },
  },
  engineer: {
    name: 'Artificer', S: 650, Sreg: 360, Sdel: 2.25, Sbrk: 3.5, hard: 0, spc: 0.35, H: 650, armor: 0.10,
    P: 1100, Preg: 300, thrustC: 25, abC: 340, thrust: 1000, maxSpeed: 470, abSpeed: 700, drag: 2.0, brake: 300, turn: 13, radius: 18,
    sec: { name: 'Deploy Sentry', cost: 200, cd: 3 }, mob: { name: 'Repair Pulse/Ray', cost: 60, cd: 9, rayPerSec: 130 }, util: { name: 'Shield Wall', cost: 150, cd: 14 },
  },
};
export const CLASS_IDS = ['brute', 'tech', 'engineer'];
export const SHORT = { brute: 'Jugg', tech: 'Arc', engineer: 'Art' };

// ---- §5 weapons ----
export const WPN = {
  massdriver: { id: 'massdriver', name: 'Mass Driver', type: 'kinetic', beam: false, dmg: 60, cd: 0.10, speed: 1300, range: 520, fStart: 150, fMin: 0.40,
    cost: 9, heat: 4, cool: 60, over: 'md', overShield: 10 },
  laser: { id: 'laser', name: 'Laser', type: 'energy', beam: true, dps: 440, cost: 110, heat: 40, cool: 50, range: 950, over: 'laser', overShield: 140 },
  phaser: { id: 'phaser', name: 'Phaser', type: 'ion', beam: false, dmg: 110, cd: 0.25, speed: 1000, range: 700, fStart: 500, fMin: 0.70,
    cost: 28, heat: 9, cool: 45, over: 'vent', vent: 1.25 },
};
export const WEAPON_IDS = ['massdriver', 'laser', 'phaser'];
export const DEFAULT_WEAPON = { brute: 'massdriver', tech: 'laser', engineer: 'phaser' };
export const TUNE = {
  brute: { damage: 1.15, cooldown: 1.1, heat: 0.9, range: 0.95, speed: 1, cost: 1, cool: 1 },
  tech: { damage: 1, cooldown: 1, heat: 1, range: 1.15, speed: 1.1, cost: 1.1, cool: 1 },
  engineer: { damage: 0.95, cooldown: 1, heat: 1, range: 1, speed: 1, cost: 0.8, cool: 1.25 },
};

/** Effective gun for class + weapon (+ optional card mods). cd is rounded to whole ticks, like secToTicks. */
export function makeGun(cls, wid, mods = {}) {
  const w = WPN[wid], t = TUNE[cls];
  const dmgMult = t.damage * (mods.dmg ?? 1);
  const g = {
    ...w,
    range: Math.min(1300, w.range * t.range * (mods.range ?? 1)),
    cost: w.cost * t.cost * (mods.gunCost ?? 1),
    heat: w.heat * t.heat * (mods.heat ?? 1),
    cool: w.cool * t.cool,
  };
  if (w.beam) g.dps = w.dps * dmgMult;
  else {
    g.dmg = w.dmg * dmgMult;
    g.cdTicks = Math.max(1, ticks(w.cd * t.cooldown * (mods.cd ?? 1)));
    g.cd = g.cdTicks / TICK;
    g.speed = w.speed * t.speed;
  }
  return g;
}

/** Damage fraction at distance d (0 beyond range = the projectile expired). */
export function falloff(g, d) {
  if (d > g.range) return 0;
  if (g.beam) return 1;
  if (d <= g.fStart) return 1;
  const k = Math.min(1, (d - g.fStart) / Math.max(1, g.range - g.fStart));
  return 1 - (1 - g.fMin) * k;
}

/** Hot-band cost multiplier. */
export function hotMult(g, heat) {
  if (heat < HEAT_HOT) return 1;
  if (g.over === 'md') return 1 + 1.5 * Math.min(1, (heat - HEAT_HOT) / 40);
  if (g.over === 'vent') return 1.5;
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Ship: three meters + gun state. Time in seconds (now), dt configurable.
// ---------------------------------------------------------------------------------------------
export class Ship {
  constructor(cls, wid = DEFAULT_WEAPON[cls], mods = {}) {
    const c = CLS[cls];
    this.cls = cls; this.c = c; this.wid = wid; this.mods = mods;
    this.Smax = c.S * (mods.shield ?? 1); this.Hmax = c.H * (mods.hull ?? 1); this.Pmax = c.P * (mods.power ?? 1);
    this.Sreg = c.Sreg * (mods.sreg ?? 1); this.Sdel = c.Sdel * (mods.sdel ?? 1); this.Sbrk = c.Sbrk * (mods.sdel ?? 1);
    this.hard = c.hard; this.spc = c.spc * (mods.costAll ?? 1); this.armor = Math.min(ARMOR_CAP, c.armor + (mods.armorAdd ?? 0));
    this.Preg = c.Preg * (mods.preg ?? 1);
    this.costAll = mods.costAll ?? 1; // Efficient Coils (all power costs)
    this.S = this.Smax; this.H = this.Hmax; this.P = this.Pmax;
    this.regenAt = -1e9; this.breakerUntil = -1e9; this.firedAt = -1e9; this.disruptedUntil = -1e9;
    this.gun = makeGun(cls, wid, mods);
    this.heat = 0; this.lastShot = -1e9; this.ventUntil = -1e9; this.ventDur = 1; this.jam = false; this.cut = false; this.cdAt = 0;
    this.bank = 0; this.bankT = 0;
    this.absorb = 0; this.brace = 0;
    this.stats = { breakers: 0, breakerTime: 0, brownTime: 0, fireTime: 0, selfShieldDrain: 0, powerSpentGun: 0, shieldRegen: 0, dmgOut: 0 };
  }
  get alive() { return this.H > 0; }
  pf() { return this.P / this.Pmax; }
  inBreaker(now) { return now < this.breakerUntil; }
  brownB() { const f = this.pf(); return f < BROWN ? f / BROWN : 1; }
  moveMult(now, strain) {
    let m = STRAIN_MOVE[strain];
    if (this.inBreaker(now)) m *= 0.6; else if (this.pf() < BROWN) m *= BROWN_MIN_MOVE + 0.4 * this.brownB();
    return Math.max(SPEED_FLOOR, m);
  }
  checkBreaker(now) {
    if (this.P <= 1e-9 && !this.inBreaker(now)) { this.P = 0; this.breakerUntil = now + BREAKER_SEC; this.stats.breakers++; }
  }
  // pass 1
  engines(now, dt, thrust, ab) {
    if (thrust) { this.P = Math.max(0, this.P - this.c.thrustC * dt); this.checkBreaker(now); }
    if (ab && !this.inBreaker(now) && this.P >= this.c.abC * dt) { this.P -= this.c.abC * dt; this.checkBreaker(now); return true; }
    return false;
  }
  // pass 3a
  reactor(now, dt, mult = 1) {
    const m = mult * (this.inBreaker(now) ? BREAKER_REGEN : 1);
    this.P = Math.min(this.Pmax, this.P + this.Preg * m * dt);
  }
  /** Pay a discrete power cost (skills). Gated by power >= cost; returns true when paid. */
  pay(now, cost, strain) {
    if (this.inBreaker(now)) return false;
    const c = cost * STRAIN_DRAW[strain] * this.costAll;
    if (this.P < c) return false;
    this.P -= c; this.checkBreaker(now); return true;
  }
  /** Continuous draw; returns the paid fraction (0..1). */
  drain(now, perSec, dt, strain) {
    if (this.inBreaker(now)) return 0;
    const need = perSec * STRAIN_DRAW[strain] * this.costAll * dt;
    const paid = Math.min(need, this.P);
    this.P -= paid; this.checkBreaker(now);
    return need > 0 ? paid / need : 1;
  }
  drainShield(amt, now) {
    const d = Math.min(this.S, amt); this.S -= d; this.stats.selfShieldDrain += d;
    this.regenAt = Math.max(this.regenAt, now + this.Sdel);
    return d;
  }
  /** Weapon tick (pass 3b). Returns array of packets {amt, type, delay}. `want` = LMB held. */
  fire(now, dt, want, strain, dist) {
    const g = this.gun, out = [];
    if (this.inBreaker(now)) want = false;
    const sd = STRAIN_DRAW[strain] * this.costAll;
    let fired = false;
    if (g.beam) {
      if (this.cut && this.heat <= HEAT_RESUME) this.cut = false;
      if (want && !this.cut && this.P > 0) {
        const need = g.cost * sd * dt, paid = Math.min(need, this.P);
        this.P -= paid; this.stats.powerSpentGun += paid;
        const frac = paid / need;
        this.heat = Math.min(100, this.heat + g.heat * dt);
        let ok = true;
        if (this.heat >= 100) {
          if (this.S <= 0) { this.cut = true; ok = false; } else this.drainShield(g.overShield * dt, now);
        }
        if (ok) {
          fired = true;
          const f = falloff(g, dist);
          this.bank += g.dps * dt * frac * f; this.bankT += dt;
          if (this.bankT >= 6 / TICK - 1e-9) { out.push({ amt: this.bank, type: g.type, delay: 0 }); this.bank = 0; this.bankT = 0; }
        }
        this.checkBreaker(now);
      }
      if (!fired && this.bank > 0) { out.push({ amt: this.bank, type: g.type, delay: 0 }); this.bank = 0; this.bankT = 0; }
    } else {
      const venting = now < this.ventUntil;
      if (this.jam && this.heat <= HEAT_RESUME) this.jam = false;
      if (want && !venting && !this.jam && now + 1e-9 >= this.cdAt) {
        const atMax = this.heat >= 100;
        if (g.over === 'md' && atMax && this.S <= 0) this.jam = true;
        else {
          const cost = g.cost * hotMult(g, this.heat) * sd;
          if (this.P >= cost) {
            this.P -= cost; this.stats.powerSpentGun += cost;
            this.cdAt = now + g.cd - 1e-9;
            this.heat = Math.min(100, this.heat + g.heat);
            if (g.over === 'md' && atMax) this.drainShield(g.overShield, now);
            if (g.over === 'vent' && this.heat >= 100) { this.ventUntil = now + g.vent; this.ventDur = g.vent; }
            const f = falloff(g, dist);
            if (f > 0) out.push({ amt: g.dmg * f, type: g.type, delay: dist / g.speed });
            fired = true;
            this.checkBreaker(now);
          }
        }
      }
    }
    if (fired) { this.lastShot = now; this.firedAt = now; this.stats.fireTime += dt; }
    // cooling
    if (!g.beam && now < this.ventUntil) this.heat = Math.max(0, this.heat - (100 / this.ventDur) * dt);
    else if (now - this.lastShot >= HEAT_COOL_DELAY) this.heat = Math.max(0, this.heat - g.cool * dt);
    return out;
  }
  // pass 3d
  shieldTick(now, dt, strain, idle, extraMult = 1) {
    if (this.pf() < BROWN) this.stats.brownTime += dt;
    if (this.inBreaker(now)) this.stats.breakerTime += dt;
    if (this.S >= this.Smax || now < this.regenAt || now < this.disruptedUntil || this.inBreaker(now)) return 0;
    const fm = now - this.firedAt < FIRE_WIN ? FIRE_MULT : 1;
    const im = idle ? IDLE_MULT : 1;
    let pts = this.Sreg * fm * im * STRAIN_SHIELD[strain] * this.brownB() * extraMult * dt;
    pts = Math.min(pts, this.Smax - this.S);
    if (pts * this.spc > this.P) pts = this.P / this.spc;
    this.S += pts; this.P -= pts * this.spc; this.stats.shieldRegen += pts;
    this.checkBreaker(now);
    return pts;
  }
}

/**
 * §2 pipeline steps 5–9 (absorb, brace, shield layer + gate, hull layer, regen clock). Returns what landed.
 * opts.noGate: hazard/lethal. absorbFrac / brace read from the ship.
 */
export function applyHit(t, amount, type, now, opts = {}) {
  if (t.H <= 0 || amount <= 0) return { s: 0, h: 0, broke: false, gated: false };
  if (t.invulnUntil && now < t.invulnUntil) return { s: 0, h: 0, broke: false, gated: false };
  amount *= 1 - Math.min(0.95, t.absorb || 0);
  amount *= 1 - (t.brace || 0);
  let carried = amount, s = 0, h = 0, broke = false, gated = false;
  if (t.S > 0) {
    const sd = amount * SM[type] * (1 - t.hard);
    if (sd <= t.S) { t.S -= sd; s = sd; carried = 0; }
    else {
      const f = t.S / sd, before = t.S; s = before; t.S = 0; broke = true;
      if (before >= GATE * t.Smax && !opts.noGate && type !== 'hazard') { carried = 0; gated = true; }
      else carried = amount * (1 - f);
    }
  }
  if (carried > 0) {
    const arm = type === 'hazard' ? 0 : Math.min(t.armor, ARMOR_CAP);
    h = carried * HM[type] * (1 - arm);
    t.H -= h;
  }
  const delay = t.S <= 0 ? t.Sbrk : t.Sdel;
  t.regenAt = Math.max(t.regenAt, now + delay);
  if (type === 'ion' && s > 0) t.regenAt = Math.min(t.regenAt + ION_DELAY, now + delay + ION_DELAY_MAX);
  return { s, h, broke, gated };
}

/** Effective HP vs neutral (energy) damage, ignoring the gate. */
export function ehp(c) {
  return c.S / (1 - c.hard) + c.H / (1 - Math.min(ARMOR_CAP, c.armor));
}

// ---- formatting helpers ----
export const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '∞');
export const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '∞');
export const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '∞');
export const pad = (s, n) => String(s).padEnd(n);
export const lpad = (s, n) => String(s).padStart(n);
export function table(rows, head) {
  const all = head ? [head, ...rows] : rows;
  const w = [];
  for (const r of all) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, String(c).length); });
  const line = (r) => r.map((c, i) => (i === 0 ? pad(c, w[i]) : lpad(c, w[i]))).join('  ');
  const out = [];
  if (head) { out.push(line(head)); out.push(w.map((n) => '-'.repeat(n)).join('  ')); }
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

/** Tiny deterministic RNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
