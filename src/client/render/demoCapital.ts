// v0.5 render demo: capital ships + bubble turrets (RENDER agent). Three capitals (Dreadnought, Spire, Foundry) each
// cycle 0 → 5 turrets so the hardpoint re-flow and the transform (and back) are visible; their turret pools cover every
// fire preset (tracer, mass driver, flak burst, spore burst, laser solid / pulse / helix / lance, seeker smoke / ion /
// hornet). Capital skills (Broadside, Resonance Overcharge, Repair Bay) fire on a timer and on X; Z parks the row
// beside you. Fake data only: positions follow the in-game turretOffset (capital-scaled radius).
import { BROADSIDE_FOCUS_SPREAD, BROADSIDE_HULL_SPAN, BROADSIDE_RADIUS } from '../../shared/sim/capital';
import { FLAK_LIFE, FLAK_SPEED, FLAK_SPREAD } from '../../shared/sim/turretkits';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { capitalScale, turretOffset } from '../../shared/sim/world';
import {
  BEAM_LASER, BEAM_NONE, SHIPFLAG_THRUSTING, type CosmeticLoadout, type GameEvent, type ProjectileKind, type ShipClassId, type ShipView, type SkillId,
} from '../../shared/types';
import { MAX_HARDPOINTS } from '../../shared/constants';
import { FIRE_PRESETS, TURRET_FIRE } from './capital';

export interface CapitalDemoWorld {
  me: ShipView;
  ships: ShipView[];
  byId: Map<number, ShipView>;
  events: GameEvent[];
  cx: number; cy: number;
  addShip(id: number, cls: ShipClassId, team: number, x: number, y: number, pathIdx: number): ShipView;
  shoot(s: { x: number; y: number; vx?: number; vy?: number; team: number; id: number }, kind: ProjectileKind, ang: number, speed: number, life: number, level?: number): void;
  nearestEnemy(x: number, y: number, max: number): { x: number; y: number } | null;
}

interface PoolSeat { cls: ShipClassId; turret: string }
const POOLS: { cls: ShipClassId; team: number; path: number; seats: PoolSeat[] }[] = [
  { cls: 'brute', team: 0, path: 0, seats: [ // Dreadnought: one of every kit
    { cls: 'brute', turret: 'com.turret.flak' }, { cls: 'brute', turret: 'rift.turret.flak' }, { cls: 'tech', turret: 'glad.turret.laser' },
    { cls: 'engineer', turret: 'glad.turret.seekerpod' }, { cls: 'brute', turret: 'std.turret.flak' },
  ] },
  { cls: 'tech', team: 1, path: 1, seats: [ // Spire: every laser preset (Overcharge thickens them)
    { cls: 'tech', turret: 'std.turret.laser' }, { cls: 'tech', turret: 'com.turret.laser' }, { cls: 'tech', turret: 'rift.turret.laser' },
    { cls: 'tech', turret: 'glad.turret.laser' }, { cls: 'tech', turret: 'swarm.turret.laser' },
  ] },
  { cls: 'engineer', team: 2, path: 2, seats: [ // Foundry: seekers + flak bursts
    { cls: 'engineer', turret: 'std.turret.seekerpod' }, { cls: 'engineer', turret: 'rift.turret.seekerpod' }, { cls: 'brute', turret: 'swarm.turret.flak' },
    { cls: 'engineer', turret: 'swarm.turret.seekerpod' }, { cls: 'brute', turret: 'glad.turret.flak' },
  ] },
];
const PRIMARY_SKILL: Record<ShipClassId, SkillId> = { brute: 'autocannon', tech: 'plasma', engineer: 'rivet' };
/** Broadside focus in the demo (px ahead of the hull; the sim uses the pilot's aim point). */
const DEMO_FOCUS = 360;
const CAP_SKILL: Record<ShipClassId, SkillId> = { brute: 'broadside', tech: 'overcharge', engineer: 'repairbay' };
const CYCLE_SEC = 1.7;
const SKILL_SEC = 6;

export class CapitalDemo {
  readonly hosts: ShipView[] = [];
  readonly pools: ShipView[][] = [];
  /** Per-pilot turret cosmetics (demo.ts applyLooks keeps them in every look mode). */
  readonly loadouts = new Map<number, CosmeticLoadout>();
  /** Z: park the capital row beside you. */
  near = false;
  /** Cycle paused (a fixed count per host) — dev hook. */
  hold = false;
  private count = [0, 0, 0];
  private cycleT = [0, 0.6, 1.2];
  private skillT = [2, 4, 6];
  private gunCd = new Map<number, number>();
  private ocUntil = [-9, -9, -9];
  private owned = new Set<number>();
  private time = 0;

  constructor(w: CapitalDemoWorld) {
    POOLS.forEach((p, i) => {
      const h = w.addShip(600 + i, p.cls, p.team, w.cx - 380 + i * 380, w.cy - 640, p.path);
      this.hosts.push(h);
      this.owned.add(h.id);
      const pool: ShipView[] = [];
      p.seats.forEach((seat, k) => {
        const t = w.addShip(610 + i * 10 + k, seat.cls, p.team, h.x, h.y, k % 3);
        t.alive = false;
        this.loadouts.set(t.id, { turret: seat.turret });
        this.owned.add(t.id);
        pool.push(t);
      });
      this.pools.push(pool);
    });
  }

  owns(id: number): boolean { return this.owned.has(id); }

  /** Set host i's turret count now (0..MAX_HARDPOINTS), with attach / detach events like the sim's. */
  setCount(i: number, n: number, w: CapitalDemoWorld): void {
    const h = this.hosts[i], pool = this.pools[i];
    const want = Math.max(0, Math.min(MAX_HARDPOINTS, n));
    const cur = this.count[i];
    if (want === cur) return;
    for (let k = cur; k < want; k++) {
      const t = pool[k];
      t.alive = true; t.x = h.x; t.y = h.y;
      w.events.push({ t: 'attach', turretShipId: t.id, hostShipId: h.id });
    }
    for (let k = want; k < cur; k++) {
      const t = pool[k];
      w.events.push({ t: 'detach', turretShipId: t.id, hostShipId: h.id });
      t.alive = false; t.attachedTo = 0; t.turretSlot = -1; t.turretCount = 0; t.beamLen = 0; t.beamKind = BEAM_NONE;
    }
    this.count[i] = want;
    for (let k = 0; k < want; k++) { const t = pool[k]; t.attachedTo = h.id; t.turretSlot = k; t.turretCount = want; }
    h.turretCount = want;
  }

  /** Fire every capital's skill now (hosts without turrets skip). */
  fireSkills(w: CapitalDemoWorld): void {
    for (let i = 0; i < this.hosts.length; i++) this.useSkill(i, w);
  }

  private useSkill(i: number, w: CapitalDemoWorld): void {
    const h = this.hosts[i];
    if (this.count[i] <= 0) return;
    w.events.push({ t: 'ability', shipId: h.id, skill: CAP_SKILL[h.shipClass], x: h.x, y: h.y });
    const sk = SHIP_CLASSES[h.shipClass].base.skill;
    if (h.shipClass === 'brute') {
      // slugs out of both flanks' gunports, converging on a point ahead as the sim's (sim/capital.ts broadside, aimed
      // DEMO_FOCUS px along the heading); bullets: the renderer draws them as mass-driver slugs
      const n = Math.round(sk.broadsideSlugs ?? 4), sp = sk.broadsideSpeed ?? 1150;
      const r = SHIP_CLASSES.brute.base.radius * capitalScale(this.count[i]);
      const c = Math.cos(h.angle), s = Math.sin(h.angle);
      const fx = h.x + c * DEMO_FOCUS, fy = h.y + s * DEMO_FOCUS;
      for (const side of [1, -1]) {
        for (let k = 0; k < n; k++) {
          const t = n > 1 ? k / (n - 1) - 0.5 : 0;
          const along = t * BROADSIDE_HULL_SPAN * r, out = r + BROADSIDE_RADIUS;
          const gx = h.x + c * along - s * side * out, gy = h.y + s * along + c * side * out;
          const a = Math.atan2(fy + c * t * BROADSIDE_FOCUS_SPREAD - gy, fx - s * t * BROADSIDE_FOCUS_SPREAD - gx);
          // demo shoot() spawns 20 px along the shot: start that much behind the gunport
          w.shoot({ x: gx - Math.cos(a) * 20, y: gy - Math.sin(a) * 20, vx: h.vx, vy: h.vy, team: h.team, id: h.id }, 'bullet', a, sp, 0.7);
        }
      }
    } else if (h.shipClass === 'tech') {
      this.ocUntil[i] = this.time + (sk.overchargeTime ?? 4);
    } else {
      for (const t of this.pools[i]) if (t.alive) w.events.push({ t: 'heal', x: t.x, y: t.y, targetId: t.id, amount: 60 + Math.round(Math.random() * 40) });
      w.events.push({ t: 'heal', x: h.x, y: h.y, targetId: h.id, amount: 120 });
    }
  }

  step(dt: number, time: number, w: CapitalDemoWorld): void {
    this.time = time;
    // hosts: a slow patrol with a turning heading, so the domes ride the hull around
    for (let i = 0; i < this.hosts.length; i++) {
      const h = this.hosts[i];
      const bx = this.near ? w.me.x - 320 + i * 320 : w.cx - 380 + i * 380;
      const by = this.near ? w.me.y + 260 : w.cy - 640;
      const tx = bx + Math.cos(time * 0.4 + i) * 30, ty = by + Math.sin(time * 0.5 + i * 2) * 20;
      h.vx = (tx - h.x) / Math.max(dt, 1e-3); h.vy = (ty - h.y) / Math.max(dt, 1e-3);
      if (Math.hypot(tx - h.x, ty - h.y) > 400) { h.vx = h.vy = 0; }
      h.x = tx; h.y = ty;
      h.angle = -Math.PI / 2 + Math.sin(time * 0.35 + i * 1.3) * 1.2;
      h.flags = SHIPFLAG_THRUSTING;
      h.energyFrac = 0.6 + 0.4 * Math.sin(time * 0.5 + i);
      if (!this.hold) {
        this.cycleT[i] += dt;
        if (this.cycleT[i] >= CYCLE_SEC) { this.cycleT[i] = 0; this.setCount(i, (this.count[i] + 1) % (MAX_HARDPOINTS + 1), w); }
      }
      this.skillT[i] -= dt;
      if (this.skillT[i] <= 0) { this.skillT[i] = SKILL_SEC; this.useSkill(i, w); }
    }
    // turrets: in-game placement (capital-scaled host radius), own aim, kit fire
    for (let i = 0; i < this.pools.length; i++) {
      const h = this.hosts[i];
      const n = this.count[i];
      const hostR = SHIP_CLASSES[h.shipClass].base.radius * capitalScale(n);
      let lasers = 0;
      for (const t of this.pools[i]) if (t.alive && t.shipClass === 'tech') lasers++;
      const oc = time < this.ocUntil[i] ? 1 : 0;
      for (const t of this.pools[i]) {
        if (!t.alive) continue;
        const o = turretOffset(h.angle, t.turretSlot, n, hostR);
        t.x = h.x + o.dx; t.y = h.y + o.dy; t.vx = h.vx; t.vy = h.vy; t.energyFrac = 0.8;
        t.beamLen = 0; t.beamKind = BEAM_NONE; t.resonance = 1;
        const range = t.shipClass === 'tech' ? 620 : t.shipClass === 'brute' ? 480 : 700;
        const tgt = w.nearestEnemy(t.x, t.y, range);
        t.angle = tgt ? Math.atan2(tgt.y - t.y, tgt.x - t.x) : h.angle + (t.turretSlot - 2) * 0.5 + Math.sin(time * 1.3 + t.id) * 0.4;
        let cd = (this.gunCd.get(t.id) ?? Math.random()) - dt;
        if (t.shipClass === 'tech') {
          if (tgt) {
            t.beamKind = BEAM_LASER; t.resonance = lasers + oc;
            t.beamLen = Math.hypot(tgt.x - t.x, tgt.y - t.y);
            if (cd <= 0) { cd = 0.5; this.fire(t, w); }
          }
        } else if (cd <= 0 && tgt) {
          if (t.shipClass === 'brute') {
            cd = 0.45;
            for (let k = 0; k < 7; k++) w.shoot({ ...t, vx: t.vx, vy: t.vy }, 'shrapnel', t.angle + (k / 6 - 0.5) * FLAK_SPREAD, FLAK_SPEED * (0.85 + 0.3 * Math.random()), FLAK_LIFE);
          } else {
            cd = 1;
            for (let k = 0; k < 2; k++) w.shoot({ ...t, vx: t.vx * 0.5, vy: t.vy * 0.5 }, 'seeker', t.angle + (k - 0.5) * 0.6, 560, 1.4);
          }
          this.fire(t, w);
        }
        this.gunCd.set(t.id, cd);
      }
    }
  }

  private fire(t: ShipView, w: CapitalDemoWorld): void {
    w.events.push({ t: 'fire', shipId: t.id, skill: PRIMARY_SKILL[t.shipClass], x: t.x, y: t.y });
  }

  status(): string {
    const names = this.hosts.map((h, i) => `${SHIP_CLASSES[h.shipClass].capital.name} ${this.count[i]}`);
    const presets = new Set<string>();
    for (const pool of this.pools) for (const t of pool) if (t.alive) { const id = this.loadouts.get(t.id)?.turret; if (id) presets.add(FIRE_PRESETS[TURRET_FIRE[id]]?.name ?? id); }
    return `capitals: ${names.join(' · ')}${this.near ? ' (beside you)' : ''} · fire: ${[...presets].join(', ') || '—'}`;
  }
}
