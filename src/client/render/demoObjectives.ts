// Render demo (RENDER agent, v0.3 M3): fake objective views for every objective sub-mode, driven by timers plus
// your ship. Not a sim: it only produces the MatchView / events / SHIPFLAG_CARRIER bits the renderer and audio
// consume, so every visual state shows up within a few seconds.
//   CTF (4 teams)     — Crimson (you) · Azure carried by an ally · your flag stolen → dropped → returned on a
//                       24 s loop · Verdant dropped next to the centre with a return timer · Solar is yours to
//                       steal: fly to its stand, bring it to your stand (capture needs your flag home), H drops it.
//   Zones / Warzone   — Core contested → decapped → neutralized → captured on a 20 s loop · A yours · B yours to
//                       take (fly in: decap, then capture) · C being worked (Warzone: swarm-blocked) · D neutral
//                       (Warzone: swarm).
//   Hot Point / FFA   — relocates every 30 s (demo speed): warn at 10 s with the next-site ghost, arming 3 s, then
//                       a scripted capper + a contested window; stand in the pad to take it yourself.
// N fires overtime / sudden death (banner-less here: screen tint + SFX).
import { NO_TEAM } from '../../shared/constants';
import { TEAM_NAMES } from '../../shared/data/teams';
import { SHIP_CLASSES } from '../../shared/data/ships';
import {
  CTF_CAPTURE_RADIUS, CTF_PICKUP_PAD, CTF_RETURN_SEC, HOT_ARM_SEC, HOT_CAP_SEC, HOT_RADIUS, HOT_WARN_SEC,
  ZONE_CAP_SEC, ZONE_DECAY_DELAY_SEC, ZONE_DECAY_PER_SEC, ZONE_RADIUS,
} from '../../shared/sim/objectives/rules';
import {
  SHIPFLAG_CARRIER, TILE_BASE, TILE_EMPTY,
  type GameEvent, type GameMap, type MapFeature, type MatchView, type ObjectiveEventKind, type ObjectiveView,
  type PlayerId, type ShipView, type SubMode, type TeamId,
} from '../../shared/types';

export const OBJ_MODES = ['off', 'CTF', 'Zones', 'Zones (Warzone)', 'Hot Point', 'Hot Point (FFA)'] as const;
/** Demo relocation period (the real one is HOT_MOVE_SEC = 60 s). */
export const DEMO_HOT_MOVE = 30;

interface DFlag { team: TeamId; s: 0 | 1 | 2; x: number; y: number; carrierId: number; returnIn: number }
interface DZone {
  i: number; owner: TeamId; ownerPid: PlayerId; cap: TeamId; capPid: PlayerId; p: number; contested: boolean; swarm: boolean; active: boolean;
  /** seconds since anyone stood on it (decay after ZONE_DECAY_DELAY_SEC) */
  empty: number;
}
interface Side { team: TeamId; pid: PlayerId }

const sameSide = (a: Side, team: TeamId, pid: PlayerId) => (a.team >= 0 || team >= 0 ? a.team === team : a.pid === pid && pid !== 0);

export interface DemoWorld {
  cx: number; cy: number;
  me: ShipView;
  ships: ShipView[];
  byId: Map<number, ShipView>;
  events: GameEvent[];
}

export class ObjectiveDemo {
  mode = 0;
  private mt = 0;
  private pc = 0;
  private feats: MapFeature[] = [];
  private flags: DFlag[] = [];
  private zones: DZone[] = [];
  private hot = { site: 0, next: -1, moveIn: DEMO_HOT_MOVE, armIn: HOT_ARM_SEC, moves: 0 };
  private scores: number[] = [0, 0, 0, 0];
  private ffaPoints = new Map<PlayerId, number>();
  private pointAcc = 0;
  private savedTeams = new Map<number, TeamId>();
  private telegraph = 0;
  /** Demo seconds (mt) until which the view reports overtime / sudden death (N). */
  private otUntil = -1;
  private sdUntil = -1;
  private dropX = 0; private dropY = 0;
  /** Last objective events, newest first (HUD readout). */
  readonly log: string[] = [];

  get label(): string { return OBJ_MODES[this.mode]; }
  get subMode(): SubMode { return this.mode === 1 ? 'ctf' : this.mode === 2 || this.mode === 3 ? 'zones' : this.mode >= 4 ? 'hotpoint' : 'deathmatch'; }
  private get warzone(): boolean { return this.mode === 3; }
  private get ffa(): boolean { return this.mode === 5; }

  /** Switch mode (0 = off). Returns the map to hand to renderer.setMap (features carved in). */
  setMode(mode: number, base: GameMap, w: DemoWorld): GameMap {
    if (this.ffa) this.restoreTeams(w);
    this.mode = ((mode % OBJ_MODES.length) + OBJ_MODES.length) % OBJ_MODES.length;
    this.mt = 0; this.pc = 0; this.pointAcc = 0; this.otUntil = -1; this.sdUntil = -1;
    this.scores = [0, 0, 0, 0]; this.ffaPoints.clear();
    this.feats = this.buildFeatures(w.cx, w.cy);
    this.flags = []; this.zones = [];
    this.hot = { site: 0, next: -1, moveIn: DEMO_HOT_MOVE, armIn: HOT_ARM_SEC, moves: 0 };
    if (this.subMode === 'ctf') {
      for (const f of this.feats) this.flags.push({ team: f.team, s: 0, x: f.x, y: f.y, carrierId: 0, returnIn: 0 });
    } else if (this.subMode === 'zones') {
      for (const f of this.feats) this.zones.push({ i: f.index, owner: -1, ownerPid: 0, cap: -1, capPid: 0, p: 0, contested: false, swarm: false, active: true, empty: 0 });
      this.zones[1].owner = 0; // A: yours
      this.zones[2].owner = 3; // B: Solar's, take it
      this.zones[3].owner = 1; // C: Azure's
    } else if (this.subMode === 'hotpoint') {
      this.zones.push({ i: 0, owner: -1, ownerPid: 0, cap: -1, capPid: 0, p: 0, contested: false, swarm: false, active: false, empty: 0 });
    }
    if (this.ffa) {
      for (const s of w.ships) { this.savedTeams.set(s.id, s.team); s.team = NO_TEAM; }
    }
    this.log.length = 0;
    return this.mapFor(base);
  }

  private restoreTeams(w: DemoWorld): void {
    for (const s of w.ships) { const t = this.savedTeams.get(s.id); if (t !== undefined) s.team = t; }
    this.savedTeams.clear();
  }

  private buildFeatures(cx: number, cy: number): MapFeature[] {
    const out: MapFeature[] = [];
    if (this.subMode === 'ctf') {
      const d = 720;
      const at = [[-1, -1], [1, -1], [-1, 1], [1, 1]]; // same corners as the demo spawns (team 0..3)
      for (let t = 0; t < 4; t++) out.push({ kind: 'flagStand', team: t, index: t, x: cx + at[t][0] * d, y: cy + at[t][1] * d, radius: CTF_CAPTURE_RADIUS });
    } else if (this.subMode === 'zones') {
      out.push({ kind: 'zone', team: -1, index: 0, x: cx, y: cy, radius: ZONE_RADIUS });
      const ring = 1150, ang = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
      for (let k = 0; k < 4; k++) out.push({ kind: 'zone', team: -1, index: k + 1, x: cx + Math.cos(ang[k]) * ring, y: cy + Math.sin(ang[k]) * ring, radius: ZONE_RADIUS });
    } else if (this.subMode === 'hotpoint') {
      out.push({ kind: 'hotSite', team: -1, index: 0, x: cx, y: cy, radius: HOT_RADIUS });
      for (let k = 1; k < 8; k++) {
        const a = -Math.PI / 2 + ((k - 1) * Math.PI * 2) / 7;
        out.push({ kind: 'hotSite', team: -1, index: k, x: cx + Math.cos(a) * 1350, y: cy + Math.sin(a) * 1350, radius: HOT_RADIUS });
      }
    }
    return out;
  }

  /** The base map with this mode's features, carved open (never touching TILE_BASE). */
  private mapFor(base: GameMap): GameMap {
    if (!this.feats.length) return { ...base, features: undefined };
    const tiles = new Uint8Array(base.tiles);
    const ts = base.tileSize;
    for (const f of this.feats) {
      const R = f.radius + 64, c0 = Math.floor((f.x - R) / ts), c1 = Math.ceil((f.x + R) / ts), r0 = Math.floor((f.y - R) / ts), r1 = Math.ceil((f.y + R) / ts);
      for (let r = Math.max(2, r0); r <= Math.min(base.rows - 3, r1); r++) for (let c = Math.max(2, c0); c <= Math.min(base.cols - 3, c1); c++) {
        const i = r * base.cols + c;
        if (tiles[i] !== TILE_BASE && Math.hypot((c + 0.5) * ts - f.x, (r + 0.5) * ts - f.y) < R) tiles[i] = TILE_EMPTY;
      }
    }
    return { ...base, tiles, features: this.feats.map((f) => ({ ...f })) };
  }

  private emit(w: DemoWorld, kind: ObjectiveEventKind, team: TeamId, playerId: PlayerId, index: number, x: number, y: number, value = 0): void {
    w.events.push({ t: 'objective', kind, team, playerId, index, x, y, value });
    const who = team >= 0 ? TEAM_NAMES[team % TEAM_NAMES.length] : playerId ? `P${playerId}` : '—';
    const what = this.subMode === 'ctf' ? `${TEAM_NAMES[index % TEAM_NAMES.length]} flag` : this.subMode === 'zones' ? `zone ${index === 0 ? 'Core' : String.fromCharCode(64 + index)}` : `site ${index}`;
    this.log.unshift(`${kind} · ${what} · ${who}`);
    if (this.log.length > 4) this.log.length = 4;
  }

  /**
   * N: overtime / sudden death (SFX + tint), alternating; the view then reports it for 8 s. During a Hot Point
   * overtime the relocation pauses at 0 as in the sim (the pad reads OVERTIME, the next-site ghost keeps no timer).
   */
  fireTelegraph(w: DemoWorld): void {
    const sd = this.telegraph++ % 2 === 1;
    if (sd) this.sdUntil = this.mt + 8; else this.otUntil = this.mt + 8;
    this.emit(w, sd ? 'suddenDeath' : 'overtime', -1, 0, 0, w.me.x, w.me.y);
  }
  private get overtime(): boolean { return this.mt < this.otUntil; }

  /** H: drop the flag you carry. */
  dropCarried(w: DemoWorld): void {
    const f = this.flags.find((q) => q.s === 1 && q.carrierId === w.me.id);
    if (!f) return;
    f.s = 2; f.x = w.me.x; f.y = w.me.y; f.carrierId = 0; f.returnIn = CTF_RETURN_SEC;
    this.emit(w, 'flagDropped', w.me.team, w.me.playerId, f.team, f.x, f.y);
  }

  // =============================================================================================

  step(dt: number, w: DemoWorld): void {
    if (this.mode === 0) return;
    this.mt += dt;
    if (this.subMode === 'ctf') this.stepCtf(dt, w);
    else if (this.subMode === 'zones') this.stepZones(dt, w);
    else this.stepHot(dt, w);
    this.pc = this.mt;
  }

  /** Crossed `a` (seconds into a `period` loop) since the last step. */
  private crossed(a: number, period: number): boolean {
    const c = this.mt % period, p = this.pc % period;
    return c >= p ? p < a && c >= a : p < a || c >= a;
  }

  private stepCtf(dt: number, w: DemoWorld): void {
    const c = this.mt % 24;
    const stand = (t: number) => this.feats[t];
    const [f0, f1, f2, f3] = this.flags;
    const thief = w.byId.get(6), ally = w.byId.get(2), returner = w.byId.get(10);
    // your flag (Crimson): home → stolen (8 s) → dropped (14 s) → returned (20 s)
    if (this.crossed(8, 24) && thief) this.emit(w, 'flagTaken', thief.team, thief.playerId, 0, stand(0).x, stand(0).y);
    if (this.crossed(14, 24) && thief) { this.dropX = thief.x; this.dropY = thief.y; this.emit(w, 'flagDropped', thief.team, thief.playerId, 0, thief.x, thief.y); }
    if (this.crossed(20, 24)) this.emit(w, 'flagReturned', 0, returner?.playerId ?? 0, 0, this.dropX, this.dropY);
    if (c >= 8 && c < 14 && thief) Object.assign(f0, { s: 1, x: thief.x, y: thief.y, carrierId: thief.id, returnIn: 0 });
    else if (c >= 14 && c < 20) Object.assign(f0, { s: 2, x: this.dropX || w.cx, y: this.dropY || w.cy, carrierId: 0, returnIn: CTF_RETURN_SEC - (c - 14) });
    else Object.assign(f0, { s: 0, x: stand(0).x, y: stand(0).y, carrierId: 0, returnIn: 0 });
    // Azure: carried by an ally, captured at 12 s, home until re-stolen at 16 s
    if (this.crossed(12, 24) && ally) this.emit(w, 'flagCaptured', ally.team, ally.playerId, 1, stand(0).x, stand(0).y, ++this.scores[0]);
    if (this.crossed(16, 24) && ally) this.emit(w, 'flagTaken', ally.team, ally.playerId, 1, stand(1).x, stand(1).y);
    if ((c < 12 || c >= 16) && ally) Object.assign(f1, { s: 1, x: ally.x, y: ally.y, carrierId: ally.id, returnIn: 0 });
    else Object.assign(f1, { s: 0, x: stand(1).x, y: stand(1).y, carrierId: 0, returnIn: 0 });
    // Verdant: dropped near the centre at 2 s, auto-returns at 22 s
    const vx = w.cx + 320, vy = w.cy + 260;
    if (this.crossed(2, 24)) this.emit(w, 'flagDropped', 0, 0, 2, vx, vy);
    if (this.crossed(22, 24)) this.emit(w, 'flagReturned', 2, 0, 2, stand(2).x, stand(2).y);
    if (c >= 2 && c < 22) Object.assign(f2, { s: 2, x: vx, y: vy, carrierId: 0, returnIn: CTF_RETURN_SEC - (c - 2) });
    else Object.assign(f2, { s: 0, x: stand(2).x, y: stand(2).y, carrierId: 0, returnIn: 0 });
    // Solar: yours to steal / capture / drop
    const me = w.me, reach = SHIP_CLASSES[me.shipClass].base.radius + CTF_PICKUP_PAD;
    if (f3.s !== 1 && Math.hypot(me.x - f3.x, me.y - f3.y) < reach) {
      Object.assign(f3, { s: 1, carrierId: me.id, returnIn: 0 });
      this.emit(w, 'flagTaken', me.team, me.playerId, 3, me.x, me.y);
    }
    if (f3.s === 1) {
      f3.x = me.x; f3.y = me.y;
      if (f0.s === 0 && Math.hypot(me.x - stand(0).x, me.y - stand(0).y) < CTF_CAPTURE_RADIUS) {
        Object.assign(f3, { s: 0, x: stand(3).x, y: stand(3).y, carrierId: 0 });
        this.emit(w, 'flagCaptured', me.team, me.playerId, 3, stand(0).x, stand(0).y, ++this.scores[0]);
      }
    } else if (f3.s === 2) {
      f3.returnIn -= dt;
      if (f3.returnIn <= 0) {
        Object.assign(f3, { s: 0, x: stand(3).x, y: stand(3).y, returnIn: 0 });
        this.emit(w, 'flagReturned', 3, 0, 3, f3.x, f3.y);
      }
    }
    for (const f of this.flags) if (f.s === 1) { const s = w.byId.get(f.carrierId); if (s) s.flags |= SHIPFLAG_CARRIER; }
  }

  /** Generic capture rule for the demo (the real one lives in sim/objectives): 1 side progresses, 2+ contest. */
  private capStep(z: DZone, present: Side[], dt: number, capSec: number, w: DemoWorld, x: number, y: number, blocked = false): void {
    z.contested = present.length >= 2;
    if (present.length === 0) {
      z.empty += dt;
      if (z.empty > ZONE_DECAY_DELAY_SEC && z.p > 0) { z.p = Math.max(0, z.p - ZONE_DECAY_PER_SEC * 100 * dt); if (z.p === 0) { z.cap = -1; z.capPid = 0; } }
      return;
    }
    z.empty = 0;
    if (z.contested || blocked) return;
    const s = present[0];
    const owned = z.owner >= 0 || z.ownerPid !== 0;
    if (owned && sameSide(s, z.owner, z.ownerPid)) { if (z.p > 0) z.p = Math.max(0, z.p - (100 / capSec) * dt); return; }
    if (!sameSide(s, z.cap, z.capPid)) { z.cap = s.team; z.capPid = s.pid; z.p = 0; }
    z.p = Math.min(100, z.p + (100 / capSec) * dt);
    if (z.p < 100) return;
    z.p = 0;
    if (owned) { z.owner = -1; z.ownerPid = 0; this.emit(w, 'zoneNeutralized', s.team, s.pid, z.i, x, y); }
    else { z.owner = s.team; z.ownerPid = s.pid; z.cap = -1; z.capPid = 0; this.emit(w, 'zoneCaptured', s.team, s.pid, z.i, x, y); }
  }

  private inside(w: DemoWorld, f: MapFeature): boolean { return Math.hypot(w.me.x - f.x, w.me.y - f.y) < f.radius; }
  private mySide(w: DemoWorld): Side { return { team: w.me.team, pid: w.me.playerId }; }

  private stepZones(dt: number, w: DemoWorld): void {
    const c = this.mt % 20;
    const [core, A, B, C, D] = this.zones;
    const fx = (i: number) => this.feats[i];
    // Core: contested (0–6) → Verdant decaps (6–10) → neutralized → Verdant caps (10–18) → captured
    if (this.crossed(10, 20)) this.emit(w, 'zoneNeutralized', 2, 0, 0, fx(0).x, fx(0).y);
    if (this.crossed(18, 20)) this.emit(w, 'zoneCaptured', 2, 0, 0, fx(0).x, fx(0).y);
    if (c < 6) Object.assign(core, { owner: 1, cap: 2, p: 35, contested: true });
    else if (c < 10) Object.assign(core, { owner: 1, cap: 2, p: 35 + ((c - 6) / 4) * 65, contested: false });
    else if (c < 18) Object.assign(core, { owner: -1, cap: 2, p: ((c - 10) / 8) * 100, contested: false });
    else Object.assign(core, { owner: 2, cap: -1, p: 0, contested: false });
    core.swarm = this.warzone && c < 6;
    // A: yours, quiet · B: fly in to take it · C: being worked (Warzone: swarm-blocked) · D: neutral
    Object.assign(A, { owner: 0, cap: -1, p: 0, contested: false, swarm: false });
    this.capStep(B, this.inside(w, fx(2)) ? [this.mySide(w)] : [], dt, ZONE_CAP_SEC, w, fx(2).x, fx(2).y);
    if (this.warzone) Object.assign(C, { owner: 1, cap: 0, p: 60, contested: false, swarm: true });
    else Object.assign(C, { owner: 1, cap: 3, p: 50 + 30 * Math.sin(this.mt * 0.5), contested: false, swarm: false });
    Object.assign(D, { owner: -1, cap: -1, p: 0, contested: false, swarm: this.warzone });
    // +1 point per owned zone every 2 s
    this.pointAcc += dt;
    while (this.pointAcc >= 2) { this.pointAcc -= 2; for (const z of this.zones) if (z.owner >= 0 && z.owner < 4) this.scores[z.owner]++; }
  }

  private stepHot(dt: number, w: DemoWorld): void {
    const h = this.hot, z = this.zones[0];
    const site = (i: number) => this.feats[i];
    h.moveIn = this.overtime ? Math.max(0, h.moveIn - dt) : h.moveIn - dt; // overtime: relocation waits at 0
    h.armIn = Math.max(0, h.armIn - dt);
    if (h.moveIn <= HOT_WARN_SEC && h.next < 0) {
      h.next = (h.site + 3 + (h.moves % 3)) % 8;
      if (h.next === h.site) h.next = (h.next + 1) % 8;
      this.emit(w, 'hotWarn', -1, 0, h.next, site(h.next).x, site(h.next).y);
    }
    if (h.moveIn <= 0 && !this.overtime) {
      h.site = h.next >= 0 ? h.next : (h.site + 1) % 8;
      h.next = -1; h.moveIn = DEMO_HOT_MOVE; h.armIn = HOT_ARM_SEC; h.moves++;
      Object.assign(z, { i: h.site, owner: -1, ownerPid: 0, cap: -1, capPid: 0, p: 0, contested: false });
      this.emit(w, 'hotMoved', -1, 0, h.site, site(h.site).x, site(h.site).y);
    }
    z.i = h.site;
    z.active = h.armIn <= 0;
    if (!z.active) return;
    // scripted presence after arming: a capper (Solar / pilot 8) from 0 s, a challenger (Azure / pilot 4) at 11–15 s
    const ta = DEMO_HOT_MOVE - HOT_ARM_SEC - h.moveIn;
    const present: Side[] = [];
    if (ta >= 0 && ta < 18) present.push(this.ffa ? { team: NO_TEAM, pid: 8 } : { team: 3, pid: 8 });
    if (ta >= 11 && ta < 15) present.push(this.ffa ? { team: NO_TEAM, pid: 4 } : { team: 1, pid: 4 });
    if (this.inside(w, site(h.site))) present.push(this.mySide(w));
    this.capStep(z, present, dt, HOT_CAP_SEC, w, site(h.site).x, site(h.site).y);
    // uncontested owner: +1 point / s
    this.pointAcc += dt;
    while (this.pointAcc >= 1) {
      this.pointAcc -= 1;
      if (z.contested) continue;
      if (this.ffa && z.ownerPid) this.ffaPoints.set(z.ownerPid, (this.ffaPoints.get(z.ownerPid) ?? 0) + 1);
      else if (z.owner >= 0 && z.owner < 4) this.scores[z.owner]++;
    }
  }

  // =============================================================================================

  private view(): ObjectiveView | undefined {
    if (this.mode === 0) return undefined;
    const base = {
      mode: this.subMode as 'ctf' | 'zones' | 'hotpoint', limit: this.subMode === 'ctf' ? 3 : this.ffa ? 120 : this.subMode === 'hotpoint' ? 200 : 300,
      overtime: this.overtime, suddenDeath: this.mt < this.sdUntil,
    };
    const zv = (z: DZone) => ({ i: z.i, owner: z.owner, ownerPid: z.ownerPid, cap: z.cap, capPid: z.capPid, p: Math.round(z.p), contested: z.contested, swarm: z.swarm, active: z.active });
    if (this.subMode === 'ctf') {
      return { ...base, flags: this.flags.map((f) => ({ team: f.team, s: f.s, x: f.x, y: f.y, carrierId: f.carrierId, returnIn: Math.max(0, Math.ceil(f.returnIn)) })) };
    }
    if (this.subMode === 'zones') return { ...base, zones: this.zones.map(zv) };
    const h = this.hot;
    return {
      ...base, zones: this.zones.map(zv),
      // whole seconds, rounded up, exactly like the wire (sim/objectives/view.ts): the layer smooths them itself
      hot: { site: h.site, next: h.next, moveIn: Math.max(0, Math.ceil(h.moveIn)), armIn: Math.max(0, Math.ceil(h.armIn)) },
      playerPoints: this.ffa ? [...this.ffaPoints.entries()].filter(([, p]) => p > 0) : undefined,
    };
  }

  /** MatchView for the frame (null when off, as before). */
  match(timeLeftSec: number): MatchView | null {
    const objective = this.view();
    if (!objective) return null;
    return {
      phase: 'playing', mode: this.ffa ? 'ffa' : 'teams', teamCount: this.ffa ? 0 : 4, timeLeftSec, teamScores: this.ffa ? [] : [...this.scores],
      wave: this.warzone ? 3 : 0, winnerTeam: -1, winnerPlayerId: 0, timed: true, gameType: this.warzone ? 'warzone' : 'arena',
      subMode: this.subMode, objective,
    };
  }

  /** One-line HUD readout. */
  status(): string {
    if (this.mode === 0) return 'objective: off (G cycles)';
    const v = this.view()!;
    let s = `objective: ${this.label}`;
    if (v.flags) s += ' · flags ' + v.flags.map((f) => `${TEAM_NAMES[f.team][0]}:${f.s === 0 ? 'home' : f.s === 1 ? 'carried' : `dropped ${f.returnIn}s`}`).join(' ');
    if (v.mode === 'zones' && v.zones) s += ' · ' + v.zones.map((z) => `${z.i === 0 ? 'Core' : String.fromCharCode(64 + z.i)}:${z.owner >= 0 ? TEAM_NAMES[z.owner][0] : '-'}${z.p ? ` ${z.p}%` : ''}${z.contested ? ' ⚔' : ''}${z.swarm ? ' ☣' : ''}`).join(' ');
    if (v.hot) s += ` · site ${v.hot.site} · move ${v.hot.moveIn}s${v.hot.armIn > 0 ? ` · arming ${v.hot.armIn}s` : ''}${v.hot.next >= 0 ? ` · next ${v.hot.next}` : ''}`;
    if (v.overtime) s += ' · OVERTIME';
    if (v.suddenDeath) s += ' · SUDDEN DEATH';
    s += this.ffa ? ` · points ${[...this.ffaPoints.entries()].map(([p, n]) => `P${p}:${n}`).join(' ')}` : ` · score ${this.scores.join('/')}`;
    return s;
  }
}
