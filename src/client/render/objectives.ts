// Objective layer (RENDER agent, v0.3 M3), docs/v0.3-proposal.md §5.7:
//  · CTF: flag stands (capture ring + plate + animated pennant), the empty socket while the flag is away, carried
//    pennants trailing behind the carrier in the FLAG's team colour, dropped pennants with a return-timer ring;
//  · Control Zones: dashed neutral ring, owner fill, capper arc (decap eats the owner ring), contested flicker,
//    Warzone swarm-block marker, letter label (CORE / A–D);
//  · Hot Point: pad + beam, arm-up arc, warn countdown ring + 1 Hz shrink tick, faint candidate sites, a ghost of
//    the next site with a guide line;
//  · carrier glow (SHIPFLAG_CARRIER), radar / big-map icons, off-screen edge pointers, objective event FX.
// Geometry comes from map.features (setMap, never on the wire); dynamic state from frame.match.objective.
// Pixi types only (no runtime import), so the rules are unit-tested in node: GameRenderer supplies an ObjectiveHost.
//
// Readability: team colours mean ownership only. Neutral / telegraph marks are white or NEUTRAL_COLOR (saturation
// < 0.3), the swarm block is ENEMY_COLOR plus a hazard shape. Carrier GLOW follows the root-alpha rule (× root alpha,
// nothing for a non-ally below 0.2); the carried PENNANT itself is objective information and is always drawn (the
// flag's position is public in ObjectiveView).
import type { Graphics } from 'pixi.js';
import type { RenderFrame } from '../contracts';
import { hudInsets } from '../hudInsets';
import { ENEMY_TEAM, NO_TEAM } from '../../shared/constants';
import { ENEMY_COLOR, colorFor } from '../../shared/data/teams';
import { CTF_CAPTURE_RADIUS, CTF_RETURN_SEC, HOT_ARM_SEC, HOT_WARN_SEC } from '../../shared/sim/objectives/rules';
import {
  SHIPFLAG_CARRIER,
  type EntityId, type GameEvent, type GameMap, type MapFeature, type ObjectiveView, type PlayerId, type TeamId,
} from '../../shared/types';
import { beamBus } from './beamBus';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import { GOLD, brighten } from './palette';

export type FlagV = NonNullable<ObjectiveView['flags']>[number];
export type ZoneV = NonNullable<ObjectiveView['zones']>[number];
export type HotV = NonNullable<ObjectiveView['hot']>;

/** Neutral pads / telegraph accents: pale, saturation < 0.3, so it never reads as a team. */
export const NEUTRAL_COLOR = 0xc8d0ff;
/** Stand plate radius, pennant pole height (world px). */
export const STAND_R = 22;
export const POLE_H = 34;
/** Return-timer ring radius around a dropped flag (world px). */
export const RETURN_R = 30;
/** Hot point beam height (world px). */
export const HOT_BEAM_H = 360;
/** Minimum screen-space insets for edge pointers (the HUD's measured strip / skill panel push them further in). */
export const EDGE_INSETS: Insets = { l: 30, r: 30, t: 72, b: 104 };
/** A pointer reaches this far outward past its edge point (arrow tip) — the HUD insets keep that clear too. */
const POINTER_OUT_PX = 16;

/**
 * Edge-pointer insets for a w × h view: EDGE_INSETS, pushed in past the DOM HUD's top row and bottom block
 * (client/hudInsets, reported by the HUD) so pointers never sit on the objective strip or the skill panel.
 * On a short view both shrink proportionally so the pointer band keeps ≥ 120 px.
 */
export function pointerInsets(w: number, h: number, hud: { top: number; bottom: number }): Insets {
  let t = Math.max(EDGE_INSETS.t, hud.top > 0 ? hud.top + POINTER_OUT_PX : 0);
  let b = Math.max(EDGE_INSETS.b, hud.bottom > 0 ? hud.bottom + POINTER_OUT_PX : 0);
  const room = h - 120;
  if (t + b > room && t + b > 0) { const k = Math.max(0, room) / (t + b); t *= k; b *= k; }
  void w;
  return { l: EDGE_INSETS.l, r: EDGE_INSETS.r, t, b };
}
export const MAX_POINTERS = 10;
const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;

export interface Insets { l: number; r: number; t: number; b: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface EdgePt { x: number; y: number; /** direction toward the target */ a: number }

/** Display state of a live ship (reused object: read it before the next call). */
export interface ObjShip { x: number; y: number; r: number; vx: number; vy: number; alpha: number; ally: boolean; cloaked: boolean }

/** What the objective layer needs from the renderer (keeps objectives.ts free of GameRenderer internals). */
export interface ObjectiveHost {
  inView(x: number, y: number, margin: number): boolean;
  /** Display position / radius / root alpha of a live, drawn ship (null if not drawn). */
  ship(id: EntityId): ObjShip | null;
  /** World px → screen px (current camera). */
  toScreen(x: number, y: number, out: { x: number; y: number }): void;
  screenW(): number;
  screenH(): number;
  /** Screen rect edge pointers must stay out of (the radar), or null. */
  avoidRect(): Rect | null;
  /** Pooled label, shown this frame only. 'world' = world px (under ships), 'screen' = screen px (HUD). */
  label(key: string, space: 'world' | 'screen', text: string, x: number, y: number, color: number, alpha: number, size: number): void;
  ring(x: number, y: number, r0: number, r1: number, life: number, color: number, width: number, follow?: EntityId): void;
  burst(x: number, y: number, n: number, color: number, spMin: number, spMax: number, life: number, scale: number, dots?: boolean): void;
  flash(x: number, y: number, size: number, color: number, life: number, alpha: number): void;
  impulse(x: number, y: number, radius: number, strength: number): void;
  tint(color: number, alpha: number, decay: number): void;
}

/** Whose side the viewer is on: team ≥ 0 (teams), NO_TEAM (FFA, identified by pid), < -1 spectator. */
export interface Side { team: TeamId; pid: PlayerId }

// =============================================================================================
// pure rules (unit-tested)
// =============================================================================================

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Colour of a side (team, else FFA player), null = neutral / nobody. */
export function sideColor(team: TeamId, pid: PlayerId): number | null {
  if (team >= 0 && team !== ENEMY_TEAM) return colorFor(team, pid);
  if (pid > 0) return colorFor(NO_TEAM, pid);
  return null;
}
export const teamColor = (team: TeamId): number => colorFor(team, 0);

/** Same side: teams compare by team, FFA by player id. */
export function sameSide(t1: TeamId, p1: PlayerId, t2: TeamId, p2: PlayerId): boolean {
  if (t1 >= 0 || t2 >= 0) return t1 === t2;
  return p1 !== 0 && p1 === p2;
}

/** The viewer's side from the frame (local ship, else the roster entry). */
export function localSide(frame: RenderFrame): Side {
  let team: TeamId = -2;
  const ls = frame.localShipId ? frame.ships.find((s) => s.id === frame.localShipId) : undefined;
  if (ls) team = ls.team;
  else { const p = frame.players.get(frame.localPlayerId); if (p) team = p.team; }
  return { team, pid: frame.localPlayerId };
}
/** Is (team, pid) the viewer's side? Spectators have no side. */
export function isOurs(side: Side, team: TeamId, pid: PlayerId): boolean {
  if (side.team >= 0) return team === side.team;
  if (side.team === NO_TEAM) return pid !== 0 && pid === side.pid;
  return false;
}

/** Zone label: 0 = Core, 1.. = A, B, C, D. */
export function zoneLabel(index: number): string {
  return index <= 0 ? 'CORE' : String.fromCharCode(64 + index);
}

/** Fraction of the auto-return timer left (1 = just dropped). */
export const returnFrac = (returnIn: number): number => clamp01(returnIn / CTF_RETURN_SEC);

export interface ZoneLook {
  /** Owner colour, null = neutral. */
  owner: number | null;
  /** Capper colour while progress > 0, else null. */
  cap: number | null;
  /** 0..1 capture (or decap) progress. */
  progress: number;
  /** The capper is removing someone else's hold: the owner ring shrinks as the arc grows. */
  decap: boolean;
  contested: boolean;
  swarm: boolean;
  /** Contested flicker phase (8 Hz). */
  flickerOn: boolean;
  /** Ring colour this frame. */
  ring: number;
  /** Neutral pads draw a dashed ring. */
  dashed: boolean;
}
export const NEUTRAL_LOOK: Readonly<ZoneLook> = Object.freeze({
  owner: null, cap: null, progress: 0, decap: false, contested: false, swarm: false, flickerOn: false, ring: NEUTRAL_COLOR, dashed: true,
});

export function zoneLook(z: ZoneV | undefined, t: number): ZoneLook {
  if (!z) return NEUTRAL_LOOK;
  const owner = sideColor(z.owner, z.ownerPid);
  const capC = sideColor(z.cap, z.capPid);
  const progress = clamp01(z.p / 100);
  const capping = capC !== null && progress > 0.001;
  const decap = capping && owner !== null && !sameSide(z.cap, z.capPid, z.owner, z.ownerPid);
  const flickerOn = z.contested && Math.floor(t * 8) % 2 === 0;
  const base = owner ?? NEUTRAL_COLOR;
  return {
    owner, cap: capping ? capC : null, progress: capping ? progress : 0, decap, contested: z.contested, swarm: z.swarm,
    flickerOn, ring: flickerOn ? 0xffffff : base, dashed: owner === null,
  };
}

export type HotPhase = 'arming' | 'live' | 'warn';
/**
 * arming: armIn > 0 · warn: the next site is picked and the move is ≤ HOT_WARN_SEC away · live otherwise.
 * Overtime is always live: relocation is paused (zones.ts stepHot) and the match ends on this point.
 */
export function hotPhase(h: HotV, overtime = false): HotPhase {
  if (h.armIn > 0) return 'arming';
  if (!overtime && h.next >= 0 && h.next !== h.site && h.moveIn <= HOT_WARN_SEC) return 'warn';
  return 'live';
}

/** The next hot site to preview (ghost, pointer, radar blink), or -1: none picked yet, or overtime (no move comes). */
export function hotNextIndex(h: HotV, overtime = false): number {
  return !overtime && h.next >= 0 && h.next !== h.site ? h.next : -1;
}

/**
 * Screen-edge pointer for an off-screen target (screen px). The point lies on the inset rectangle along the ray
 * from its centre; `avoid` (the radar) slides it along that edge out of the box. Null = the target is on screen.
 */
export function edgePointer(tx: number, ty: number, w: number, h: number, ins: Insets, avoid?: Rect | null, pad = 12): EdgePt | null {
  const x0 = ins.l, x1 = w - ins.r, y0 = ins.t, y1 = h - ins.b;
  if (!(x1 > x0 && y1 > y0) || !Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return null;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const dx = tx - cx, dy = ty - cy;
  const kx = dx !== 0 ? (x1 - x0) / 2 / Math.abs(dx) : Infinity;
  const ky = dy !== 0 ? (y1 - y0) / 2 / Math.abs(dy) : Infinity;
  const k = Math.min(kx, ky);
  let x = cx + dx * k, y = cy + dy * k;
  if (avoid && x > avoid.x - pad && x < avoid.x + avoid.w + pad && y > avoid.y - pad && y < avoid.y + avoid.h + pad) {
    let bx = x, by = y, best = Infinity;
    const at = (nx: number, ny: number) => {
      if (nx < x0 - 1e-6 || nx > x1 + 1e-6 || ny < y0 - 1e-6 || ny > y1 + 1e-6) return;
      const d = Math.hypot(nx - x, ny - y);
      if (d < best) { best = d; bx = nx; by = ny; }
    };
    if (kx <= ky) { at(x, avoid.y - pad); at(x, avoid.y + avoid.h + pad); } // left / right edge: slide vertically
    else { at(avoid.x - pad, y); at(avoid.x + avoid.w + pad, y); } // top / bottom edge: slide horizontally
    x = bx; y = by;
  }
  return { x, y, a: Math.atan2(ty - y, tx - x) };
}

/**
 * Sub-second estimate of a countdown the wire carries as whole seconds (view.ts sends ceil(ticks left / rate)), so
 * return rings, arm arcs and warn rings drain smoothly instead of stepping once a second. Every change of the wire
 * value is a sync point: the true remaining time just crossed it (a drop, a relocation, an arm start or a 1 s step).
 * Between changes the estimate runs down with frame time but never below value − 1 (the next step is due by then),
 * so a late snapshot or a paused countdown drifts by one second at most. Fractional inputs (the render demo, any
 * finer wire) pass through untouched.
 */
export class Countdown {
  private v = NaN;
  private at = 0;
  read(value: number, t: number): number {
    if (!Number.isFinite(value) || value <= 0) { this.v = value; return 0; }
    if (value !== Math.floor(value)) { this.v = NaN; return value; }
    if (value !== this.v || !(t >= this.at)) { this.v = value; this.at = t; }
    return Math.max(value - 1, value - (t - this.at));
  }
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * k;
}

// =============================================================================================
// drawing helpers (Graphics paths; strokes / fills are issued by the caller)
// =============================================================================================

/** n dashes of `duty` (0..1) around a circle, rotated by rot. */
function dashedRing(g: Graphics, x: number, y: number, r: number, n: number, duty: number, rot: number): void {
  const step = TAU / n, len = step * duty;
  for (let i = 0; i < n; i++) {
    const a0 = rot + i * step;
    g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a0 + len);
  }
}
/** Arc of `span` rad from a0 (clockwise on screen). False (nothing drawn) when the span is ~0. */
function arcPath(g: Graphics, x: number, y: number, r: number, a0: number, span: number): boolean {
  if (!(span > 1e-3)) return false;
  g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a0 + Math.min(TAU, span));
  return true;
}
function hexPath(g: Graphics, x: number, y: number, r: number): void {
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.closePath();
}
/**
 * Waving pennant cloth anchored at (ax, ay), flowing along angle th (a triangle whose free edge ripples).
 * Drawn with moveTo/lineTo (Pixi's poly() keeps a reference to its array).
 */
function cloth(g: Graphics, ax: number, ay: number, th: number, L: number, W: number, t: number, ph: number, amp: number, color: number, alpha: number): void {
  const n = 5, c = Math.cos(th), s = Math.sin(th);
  const wave = (u: number) => Math.sin(t * 8 - u * 5 + ph) * amp * u;
  for (let k = 0; k <= n; k++) {
    const u = k / n, lx = u * L, ly = (-W / 2) * (1 - u) + wave(u);
    const px = ax + c * lx - s * ly, py = ay + s * lx + c * ly;
    if (k) g.lineTo(px, py); else g.moveTo(px, py);
  }
  for (let k = n - 1; k >= 0; k--) {
    const u = k / n, lx = u * L, ly = (W / 2) * (1 - u) + wave(u);
    g.lineTo(ax + c * lx - s * ly, ay + s * lx + c * ly);
  }
  g.closePath();
  g.fill({ color, alpha: 0.55 * alpha }).stroke({ width: 1.6, color: brighten(color, 0.35), alpha: 0.95 * alpha });
}

interface PtrTarget {
  x: number; y: number; color: number; alpha: number; urgent: boolean;
  glyph: 'flag' | 'home' | 'zone' | 'core' | 'hot' | 'next'; letter: string;
}

// =============================================================================================
// the layer
// =============================================================================================

export class ObjectiveLayer {
  /** Viewer's side, recomputed by begin() (GameRenderer mirrors it onto the audio bus). */
  side: Side = { team: -2, pid: 0 };
  private view: ObjectiveView | null = null;
  private stands = new Map<TeamId, MapFeature>();
  private zoneF = new Map<number, MapFeature>();
  private sites: MapFeature[] = [];
  private siteByIdx = new Map<number, MapFeature>();
  /** Smoothed trail angle per carried flag team. */
  private trailTh = new Map<TeamId, number>();
  private armWas = false;
  private lastSite = -1;
  private ptrs: PtrTarget[] = [];
  private nPtr = 0;
  private tmp = { x: 0, y: 0 };
  /** Smoothed wire countdowns: 'move' / 'arm' (hot point), 'ret' + team (dropped flags). */
  private clocks = new Map<string, Countdown>();

  constructor(private readonly A: Atlas, readonly glow: SpriteBatch) {}

  /** Smoothed seconds left of a whole-second wire countdown (see Countdown). */
  private clock(key: string, value: number, t: number): number {
    let c = this.clocks.get(key);
    if (!c) { c = new Countdown(); this.clocks.set(key, c); }
    return c.read(value, t);
  }

  /** Re-entrant (every matchStart / floorStart): rebuilds the feature index and drops transient state. */
  setMap(map: GameMap): void {
    this.stands.clear(); this.zoneF.clear(); this.sites.length = 0; this.siteByIdx.clear(); this.trailTh.clear();
    this.clocks.clear();
    this.armWas = false; this.lastSite = -1; this.view = null;
    const feats = map.features ?? [];
    for (let k = 0; k < feats.length; k++) {
      const f = feats[k];
      if (f.kind === 'flagStand') this.stands.set(f.team >= 0 ? f.team : f.index, f);
      else if (f.kind === 'zone') this.zoneF.set(f.index, f);
      else if (f.kind === 'hotSite') { this.sites.push(f); this.siteByIdx.set(f.index, f); }
    }
    this.sites.sort((a, b) => a.index - b.index);
  }

  /** Feature counts (debug / tests). */
  get featureCounts(): { stands: number; zones: number; sites: number } {
    return { stands: this.stands.size, zones: this.zoneF.size, sites: this.sites.length };
  }

  begin(frame: RenderFrame): void {
    this.side = localSide(frame);
    this.view = frame.match?.objective ?? null;
    this.glow.begin();
  }
  end(): void { this.glow.end(); }

  // ------------------------------------------------------------------------------------------
  // world layer (under gems / ships)

  /** Stands, home / dropped flags, zone pads, the hot point. `pad` = normal-blend fills, `add` = additive lines. */
  drawWorld(frame: RenderFrame, t: number, pad: Graphics, add: Graphics, host: ObjectiveHost): void {
    const v = this.view;
    if (!v) { this.armWas = false; this.lastSite = -1; return; }
    if (v.mode === 'ctf') this.drawCtf(frame, v, t, pad, add, host);
    else if (v.mode === 'zones') this.drawZones(v, t, pad, add, host);
    else if (v.mode === 'hotpoint') this.drawHot(v, t, pad, add, host);
  }

  private flagOf(v: ObjectiveView, team: TeamId): FlagV | undefined {
    const fl = v.flags;
    if (fl) for (const f of fl) if (f.team === team) return f;
    return undefined;
  }

  /** Team of the flag the local ship carries, or -1. */
  private localCarried(frame: RenderFrame, v: ObjectiveView): TeamId {
    if (!frame.localShipId || !v.flags) return -1;
    for (const f of v.flags) if (f.s === 1 && f.carrierId === frame.localShipId) return f.team;
    return -1;
  }

  /** Stand position of a team: the feature, else a home flag's position (a map without features). */
  private standPos(v: ObjectiveView, team: TeamId): { x: number; y: number; r: number } | null {
    const f = this.stands.get(team);
    if (f) return { x: f.x, y: f.y, r: f.radius || CTF_CAPTURE_RADIUS };
    const fv = this.flagOf(v, team);
    return fv && fv.s === 0 ? { x: fv.x, y: fv.y, r: CTF_CAPTURE_RADIUS } : null;
  }

  private drawCtf(frame: RenderFrame, v: ObjectiveView, t: number, pad: Graphics, add: Graphics, host: ObjectiveHost): void {
    const carrying = this.localCarried(frame, v);
    const myTeam = this.side.team;
    const myFlagHome = myTeam >= 0 && (this.flagOf(v, myTeam)?.s ?? 0) === 0;
    const teams = new Set<TeamId>(this.stands.keys());
    if (v.flags) for (const f of v.flags) teams.add(f.team);
    for (const team of teams) {
      const st = this.standPos(v, team);
      if (!st) continue;
      const hint = carrying >= 0 && team === myTeam && myFlagHome;
      this.drawStand(st.x, st.y, st.r, team, this.flagOf(v, team), hint, t, pad, add, host);
    }
    if (v.flags) for (const fv of v.flags) if (fv.s === 2) this.drawDropped(fv, t, add, host);
  }

  private drawStand(x: number, y: number, R: number, team: TeamId, fv: FlagV | undefined, hint: boolean, t: number,
    pad: Graphics, add: Graphics, host: ObjectiveHost): void {
    if (!host.inView(x, y, R + 60)) return;
    const col = teamColor(team), ph = team * 1.7;
    const home = !fv || fv.s === 0;
    // capture ring: dashed; pulses when the local carrier can capture here
    dashedRing(add, x, y, R, 18, 0.55, t * 0.25 + ph);
    add.stroke({ width: hint ? 3.2 : 2, color: col, alpha: hint ? 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 7)) : home ? 0.42 : 0.22 });
    if (hint) add.circle(x, y, R).stroke({ width: 10, color: col, alpha: 0.1 });
    // plate
    hexPath(pad, x, y, STAND_R); pad.fill({ color: col, alpha: 0.14 });
    hexPath(add, x, y, STAND_R); add.stroke({ width: 2, color: col, alpha: 0.85 });
    if (home) {
      this.glow.put(this.A.soft, x, y - POLE_H * 0.6, 0, 1.4, 1.4, col, 0.22 + 0.08 * Math.sin(t * 3 + ph));
      add.moveTo(x, y).lineTo(x, y - POLE_H).stroke({ width: 2.2, color: brighten(col, 0.55), alpha: 0.95 });
      cloth(add, x, y - POLE_H, 0.12 * Math.sin(t * 1.3 + ph), 28, 16, t, ph, 3, col, 1);
    } else {
      // empty socket: a blinking hollow ring + a ghost pole
      const b = Math.floor(t * 3) % 2 ? 0.5 : 0.22;
      add.circle(x, y, STAND_R * 0.45).stroke({ width: 1.6, color: col, alpha: b });
      add.moveTo(x, y).lineTo(x, y - POLE_H).stroke({ width: 1.4, color: col, alpha: 0.25 });
    }
  }

  private drawDropped(fv: FlagV, t: number, add: Graphics, host: ObjectiveHost): void {
    const x = fv.x, y = fv.y;
    const left = this.clock('ret' + fv.team, fv.returnIn, t); // keep the clock in sync even while off-screen
    if (!host.inView(x, y, 120)) return;
    const col = teamColor(fv.team), ph = fv.team * 1.7;
    // pickup hint + return-timer ring (track, then the remaining arc; white blink in the last 5 s)
    dashedRing(add, x, y, 46, 10, 0.5, -t * 0.6);
    add.stroke({ width: 1.4, color: col, alpha: 0.35 });
    add.circle(x, y, RETURN_R).stroke({ width: 4, color: col, alpha: 0.12 });
    const warn = fv.returnIn <= 5 && Math.floor(t * 6) % 2 === 0;
    if (arcPath(add, x, y, RETURN_R, TOP, returnFrac(left) * TAU)) add.stroke({ width: 3, color: warn ? 0xffffff : col, alpha: 0.9 });
    // lying pennant
    this.glow.put(this.A.soft, x, y, 0, 1.1, 1.1, col, 0.25);
    add.moveTo(x - 12, y + 8).lineTo(x + 10, y - 14).stroke({ width: 2, color: brighten(col, 0.5), alpha: 0.9 });
    cloth(add, x + 10, y - 14, 0.9, 22, 13, t * 0.4, ph, 1.5, col, 0.9);
  }

  private drawZones(v: ObjectiveView, t: number, pad: Graphics, add: Graphics, host: ObjectiveHost): void {
    const zones = v.zones;
    for (const [idx, f] of this.zoneF) {
      let zv: ZoneV | undefined;
      if (zones) for (const z of zones) if (z.i === idx) { zv = z; break; }
      this.drawPad(f.x, f.y, f.radius, zv, t, pad, add, host, zoneLabel(idx), 'z:' + idx, 1, false);
    }
  }

  /** One capture pad (zone or the hot point). */
  private drawPad(x: number, y: number, R: number, zv: ZoneV | undefined, t: number, pad: Graphics, add: Graphics,
    host: ObjectiveHost, label: string, key: string, alphaMul: number, arming: boolean): void {
    if (!host.inView(x, y, R + 80)) return;
    const L = zoneLook(zv, t);
    // an inactive pad is dimmed; an arming hot point has its own (brighter) arming look
    const am = (zv && !zv.active && !arming ? 0.35 : 1) * alphaMul;
    const base = L.owner ?? NEUTRAL_COLOR;
    // owner fill (fades while being decapped)
    if (L.owner !== null) {
      pad.circle(x, y, R).fill({ color: L.owner, alpha: 0.075 * am * (L.decap ? 1 - 0.6 * L.progress : 1) });
      this.glow.put(this.A.soft, x, y, 0, R / 26, R / 26, L.owner, 0.09 * am);
    } else pad.circle(x, y, R).fill({ color: NEUTRAL_COLOR, alpha: 0.025 * am });
    // ring: dashed when neutral / arming, the owner's hold shrinking during a decap, else solid
    if (L.dashed || arming) {
      dashedRing(add, x, y, R, 32, 0.5, t * 0.12);
      add.stroke({ width: 2.5, color: L.ring, alpha: (L.flickerOn ? 0.95 : 0.6) * am });
    } else if (L.decap) {
      if (arcPath(add, x, y, R, TOP + L.progress * TAU, (1 - L.progress) * TAU)) add.stroke({ width: 3, color: L.ring, alpha: 0.85 * am });
    } else {
      add.circle(x, y, R).stroke({ width: 3, color: L.ring, alpha: (L.flickerOn ? 1 : 0.8) * am });
    }
    add.circle(x, y, R).stroke({ width: 12, color: base, alpha: 0.06 * am });
    // capper arc
    if (L.cap !== null) {
      const rr = R - 12;
      add.circle(x, y, rr).stroke({ width: 7, color: L.cap, alpha: 0.12 * am });
      if (arcPath(add, x, y, rr, TOP, L.progress * TAU)) add.stroke({ width: 7, color: L.cap, alpha: (L.contested || L.swarm ? 0.55 : 0.9) * am });
    }
    // contested: four clash marks just outside the ring
    if (L.contested) {
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2, cx = x + Math.cos(a) * (R + 18), cy = y + Math.sin(a) * (R + 18), s = 7;
        g4x(add, cx, cy, s);
      }
      add.stroke({ width: 2.4, color: L.flickerOn ? 0xffffff : base, alpha: 0.9 * am });
    }
    // Warzone swarm block: hazard ticks in the enemy colour + a warning triangle over the label
    if (L.swarm) {
      const rot = t * 0.5;
      for (let i = 0; i < 16; i++) {
        const a = rot + (i * TAU) / 16, c = Math.cos(a), s = Math.sin(a);
        add.moveTo(x + c * (R + 6), y + s * (R + 6)).lineTo(x + c * (R + 20), y + s * (R + 20));
      }
      add.stroke({ width: 3, color: ENEMY_COLOR, alpha: 0.75 * am });
      const ty = y - 48, s = 14;
      add.moveTo(x, ty - s).lineTo(x + s * 1.1, ty + s * 0.8).lineTo(x - s * 1.1, ty + s * 0.8).closePath();
      add.stroke({ width: 2.4, color: ENEMY_COLOR, alpha: (0.7 + 0.3 * Math.sin(t * 6)) * am });
      add.moveTo(x, ty - s * 0.45).lineTo(x, ty + s * 0.25).stroke({ width: 2.4, color: ENEMY_COLOR, alpha: 0.9 * am });
      add.circle(x, ty + s * 0.55, 1.6).fill({ color: ENEMY_COLOR, alpha: 0.9 * am });
    }
    host.label(key, 'world', label, x, y, base, 0.55 * am, label.length > 2 ? 24 : 34);
  }

  private drawHot(v: ObjectiveView, t: number, pad: Graphics, add: Graphics, host: ObjectiveHost): void {
    const h = v.hot;
    if (!h) { this.armWas = false; this.lastSite = -1; return; }
    let zv: ZoneV | undefined;
    if (v.zones) { for (const z of v.zones) if (z.i === h.site) { zv = z; break; } if (!zv) zv = v.zones[0]; }
    const cur = this.siteByIdx.get(h.site);
    // Overtime pauses relocation (zones.ts stepHot): no countdown and no next-site ghost then, the fight on this
    // point decides it.
    const ot = v.overtime;
    const phase = hotPhase(h, ot);
    const arming = phase === 'arming';
    const nextIdx = hotNextIndex(h, ot);
    const nextF = nextIdx >= 0 ? this.siteByIdx.get(nextIdx) : undefined;
    const moveIn = this.clock('move', h.moveIn, t), armIn = this.clock('arm', h.armIn, t);

    // faint candidate sites
    for (const f of this.sites) {
      if (f === cur || f === nextF || !host.inView(f.x, f.y, f.radius)) continue;
      dashedRing(add, f.x, f.y, f.radius * 0.3, 8, 0.45, t * 0.1);
      add.stroke({ width: 1.5, color: NEUTRAL_COLOR, alpha: 0.13 });
      add.circle(f.x, f.y, 3).fill({ color: NEUTRAL_COLOR, alpha: 0.2 });
    }

    // armed transition (same site, armIn > 0 → 0): FX + the audio bus pulse
    if (cur && this.armWas && !arming && this.lastSite === h.site) {
      const L = zoneLook(zv, t);
      host.ring(cur.x, cur.y, cur.radius * 0.4, cur.radius + 70, 0.6, 0xffffff, 3);
      host.flash(cur.x, cur.y, 3, L.owner ?? 0xffffff, 0.3, 0.6);
      beamBus.hotArmSeq++;
      beamBus.hotArmAt = typeof performance !== 'undefined' ? performance.now() : 0;
    }
    this.armWas = arming; this.lastSite = h.site;

    if (cur) {
      const R = cur.radius;
      const label = arming ? 'ARMING' : ot ? 'OVERTIME' : phase === 'warn' ? `MOVE ${Math.max(0, Math.ceil(h.moveIn))}` : 'HOT';
      this.drawPad(cur.x, cur.y, R, zv, t, pad, add, host, label, 'hot', arming ? 0.6 : 1, arming);
      if (host.inView(cur.x, cur.y, R + HOT_BEAM_H)) {
        const L = zoneLook(zv, t);
        const bc = L.owner ?? 0xffffff;
        const flick = arming ? (Math.floor(t * 10) % 2 ? 0.7 : 0.35) : 0.8 + 0.2 * Math.sin(t * 4);
        this.glow.put(this.A.beam, cur.x, cur.y - HOT_BEAM_H / 2, 0, 1.1, HOT_BEAM_H / 64, bc, 0.45 * flick);
        this.glow.put(this.A.soft, cur.x, cur.y, 0, 2.4, 2.4, bc, 0.3 * flick);
        if (arming) {
          const f = 1 - clamp01(armIn / HOT_ARM_SEC);
          add.circle(cur.x, cur.y, R + 14).stroke({ width: 4, color: 0xffffff, alpha: 0.1 });
          if (arcPath(add, cur.x, cur.y, R + 14, TOP, f * TAU)) add.stroke({ width: 4, color: 0xffffff, alpha: 0.85 });
        }
        if (phase === 'warn' && !ot) {
          // countdown ring (drains over HOT_WARN_SEC, pulses faster near the move) + a 1 Hz shrink tick
          const f = clamp01(moveIn / HOT_WARN_SEC);
          const p = 0.5 + 0.5 * Math.sin(t * TAU * (1.5 + 6 * (1 - f)));
          if (arcPath(add, cur.x, cur.y, R + 28, TOP, f * TAU)) add.stroke({ width: 3, color: 0xffffff, alpha: 0.45 + 0.45 * p });
          const k = moveIn - Math.floor(moveIn);
          add.circle(cur.x, cur.y, R + 40 * k).stroke({ width: 2, color: 0xffffff, alpha: 0.5 * (1 - k) + 0.1 });
        }
      }
    }

    // ghost of the next site + a dashed guide line during the warning
    if (nextF) {
      const p = 0.5 + 0.5 * Math.sin(t * 5);
      if (host.inView(nextF.x, nextF.y, nextF.radius + 320)) {
        dashedRing(add, nextF.x, nextF.y, nextF.radius, 24, 0.5, -t * 0.4);
        add.stroke({ width: 2.5, color: 0xffffff, alpha: 0.25 + 0.3 * p });
        pad.circle(nextF.x, nextF.y, nextF.radius).fill({ color: 0xffffff, alpha: 0.025 });
        this.glow.put(this.A.beam, nextF.x, nextF.y - 150, 0, 0.8, 300 / 64, 0xffffff, 0.12 + 0.1 * p);
        host.label('hotNext', 'world', ot ? 'NEXT' : `NEXT ${Math.max(0, Math.ceil(h.moveIn))}`, nextF.x, nextF.y, 0xffffff, 0.5, 26);
      }
      if (cur && phase === 'warn' && !ot) {
        const dx = nextF.x - cur.x, dy = nextF.y - cur.y, len = Math.hypot(dx, dy);
        if (len > cur.radius + nextF.radius) {
          const ux = dx / len, uy = dy / len, off = (t * 60) % 60;
          let any = false;
          for (let u = cur.radius + off; u < len - nextF.radius; u += 60) {
            const u1 = Math.min(u + 28, len - nextF.radius);
            add.moveTo(cur.x + ux * u, cur.y + uy * u).lineTo(cur.x + ux * u1, cur.y + uy * u1);
            any = true;
          }
          if (any) add.stroke({ width: 2, color: 0xffffff, alpha: 0.14 });
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // carriers (called after drawShips: fresh root alpha; the Graphics still sits under the ships)

  /** Carrier glow on every SHIPFLAG_CARRIER ship + carried pennants trailing behind their carriers. */
  drawCarriers(frame: RenderFrame, t: number, add: Graphics, host: ObjectiveHost): void {
    const v = this.view;
    for (const s of frame.ships) {
      if (!s.alive || !(s.flags & SHIPFLAG_CARRIER)) continue;
      const a = host.ship(s.id);
      if (!a || (!a.ally && a.alpha < 0.2)) continue; // root-alpha rule: never weaken cloak / invulnerability blink
      let col = GOLD;
      if (v?.flags) for (const f of v.flags) if (f.s === 1 && f.carrierId === s.id) { col = teamColor(f.team); break; }
      const p = 0.5 + 0.5 * Math.sin(t * 6 + s.id);
      const gs = (a.r / 32) * 3.6;
      this.glow.put(this.A.soft, a.x, a.y, 0, gs, gs, col, (0.22 + 0.16 * p) * a.alpha);
      dashedRing(add, a.x, a.y, a.r + 12 + 2 * p, 6, 0.6, t * 2 + s.id);
      add.stroke({ width: 2, color: col, alpha: (0.5 + 0.35 * p) * a.alpha });
    }
    if (v?.mode === 'ctf' && v.flags) for (const fv of v.flags) if (fv.s === 1) this.drawCarried(fv, t, add, host);
  }

  private drawCarried(fv: FlagV, t: number, add: Graphics, host: ObjectiveHost): void {
    const col = teamColor(fv.team), ph = fv.team * 1.7;
    const a = fv.carrierId ? host.ship(fv.carrierId) : null;
    let x = fv.x, y = fv.y, r = 14;
    let th = this.trailTh.get(fv.team) ?? Math.PI / 2;
    if (a) {
      x = a.x; y = a.y; r = a.r;
      if (Math.hypot(a.vx, a.vy) > 40) th = lerpAngle(th, Math.atan2(-a.vy, -a.vx), 0.2);
    }
    this.trailTh.set(fv.team, th);
    if (!host.inView(x, y, 90)) return;
    const c = Math.cos(th), s = Math.sin(th);
    const ax = x + c * (r + 10), ay = y + s * (r + 10);
    add.moveTo(x + c * r * 0.7, y + s * r * 0.7).lineTo(ax, ay).stroke({ width: 2, color: brighten(col, 0.5), alpha: 0.9 });
    this.glow.put(this.A.soft, ax + c * 14, ay + s * 14, 0, 0.9, 0.9, col, 0.3);
    cloth(add, ax, ay, th, 30, 16, t * 1.4, ph, 3.5, col, 1);
  }

  // ------------------------------------------------------------------------------------------
  // off-screen edge pointers (screen space, HUD layer)

  private pushPtr(x: number, y: number, color: number, alpha: number, urgent: boolean, glyph: PtrTarget['glyph'], letter = ''): void {
    let p = this.ptrs[this.nPtr];
    if (!p) { p = { x: 0, y: 0, color: 0, alpha: 1, urgent: false, glyph: 'flag', letter: '' }; this.ptrs.push(p); }
    this.nPtr++;
    p.x = x; p.y = y; p.color = color; p.alpha = alpha; p.urgent = urgent; p.glyph = glyph; p.letter = letter;
  }

  /** Objectives worth pointing at, most important first (pooled; valid until the next call). */
  pointerTargets(frame: RenderFrame, host: ObjectiveHost): readonly PtrTarget[] {
    this.nPtr = 0;
    const v = this.view;
    if (!v) return this.ptrs.slice(0, 0);
    const side = this.side, spect = side.team < -1;
    if (v.mode === 'ctf' && v.flags) {
      const carrying = this.localCarried(frame, v);
      if (carrying >= 0 && side.team >= 0) {
        const st = this.standPos(v, side.team);
        if (st) this.pushPtr(st.x, st.y, teamColor(side.team), 1, true, 'home');
      }
      for (const fv of v.flags) {
        const ours = side.team >= 0 && fv.team === side.team;
        if (fv.s === 1 && fv.carrierId === frame.localShipId && frame.localShipId) continue; // you are the carrier
        if (ours && fv.s === 0 && !spect) continue; // your own flag at home: no pointer
        let x = fv.x, y = fv.y;
        if (fv.s === 1 && fv.carrierId) { const a = host.ship(fv.carrierId); if (a) { x = a.x; y = a.y; } }
        this.pushPtr(x, y, teamColor(fv.team), 1, (ours && fv.s === 1) || (!ours && fv.s === 2), 'flag');
      }
    } else if (v.mode === 'zones') {
      for (const [idx, f] of this.zoneF) {
        let zv: ZoneV | undefined;
        if (v.zones) for (const z of v.zones) if (z.i === idx) { zv = z; break; }
        const ownedByUs = !!zv && isOurs(side, zv.owner, zv.ownerPid);
        const threatened = !!zv && (zv.contested || (ownedByUs && zoneLook(zv, 0).decap));
        const col = zv ? (sideColor(zv.owner, zv.ownerPid) ?? NEUTRAL_COLOR) : NEUTRAL_COLOR;
        const quiet = ownedByUs && !threatened;
        this.pushPtr(f.x, f.y, col, quiet ? 0.45 : 0.95, threatened, idx === 0 ? 'core' : 'zone', idx === 0 ? '' : zoneLabel(idx));
      }
    } else if (v.mode === 'hotpoint' && v.hot) {
      const h = v.hot, cur = this.siteByIdx.get(h.site);
      let zv: ZoneV | undefined;
      if (v.zones) { for (const z of v.zones) if (z.i === h.site) { zv = z; break; } if (!zv) zv = v.zones[0]; }
      if (cur) {
        const col = zv ? (sideColor(zv.owner, zv.ownerPid) ?? 0xffffff) : 0xffffff;
        const ph = hotPhase(h, v.overtime);
        this.pushPtr(cur.x, cur.y, col, ph === 'arming' ? 0.6 : 1, !!zv?.contested || ph === 'warn', 'hot');
      }
      const ni = hotNextIndex(h, v.overtime);
      const nf = ni >= 0 ? this.siteByIdx.get(ni) : undefined;
      if (nf) this.pushPtr(nf.x, nf.y, 0xffffff, 0.7, false, 'next');
    }
    return this.ptrs.slice(0, this.nPtr);
  }

  /** Screen-edge pointers for off-screen objectives (g is a screen-space Graphics). Returns pointers drawn. */
  drawPointers(frame: RenderFrame, t: number, g: Graphics, host: ObjectiveHost): number {
    const w = host.screenW(), hh = host.screenH();
    if (!this.view || !w || !hh) return 0;
    const list = this.pointerTargets(frame, host);
    const avoid = host.avoidRect();
    const ins = pointerInsets(w, hh, hudInsets());
    let n = 0;
    for (const p of list) {
      if (n >= MAX_POINTERS) break;
      host.toScreen(p.x, p.y, this.tmp);
      const e = edgePointer(this.tmp.x, this.tmp.y, w, hh, ins, avoid);
      if (!e) continue;
      this.drawPointer(g, e, p, t, host, n);
      n++;
    }
    return n;
  }

  private drawPointer(g: Graphics, e: EdgePt, p: PtrTarget, t: number, host: ObjectiveHost, n: number): void {
    const k = p.urgent ? 1 + 0.18 * Math.sin(t * 12) : 1;
    const al = p.alpha, col = p.color;
    const c = Math.cos(e.a), s = Math.sin(e.a);
    // arrow head at the edge point
    g.moveTo(e.x + c * 12 * k, e.y + s * 12 * k)
      .lineTo(e.x - c * 4 - s * 8 * k, e.y - s * 4 + c * 8 * k)
      .lineTo(e.x - c * 4 + s * 8 * k, e.y - s * 4 - c * 8 * k)
      .closePath();
    g.fill({ color: col, alpha: 0.9 * al }).stroke({ width: 1.2, color: 0xffffff, alpha: 0.6 * al });
    // icon disk, inward
    const ix = e.x - c * 21, iy = e.y - s * 21;
    g.circle(ix, iy, 13 * (p.urgent ? k : 1)).fill({ color: 0x07041a, alpha: 0.78 * al }).stroke({ width: 1.8, color: col, alpha: 0.95 * al });
    switch (p.glyph) {
      case 'flag': case 'home':
        g.moveTo(ix - 4, iy + 7).lineTo(ix - 4, iy - 7).stroke({ width: 1.6, color: 0xffffff, alpha: 0.9 * al });
        g.moveTo(ix - 4, iy - 7).lineTo(ix + 7, iy - 3).lineTo(ix - 4, iy + 1).closePath().fill({ color: col, alpha: al });
        if (p.glyph === 'home') g.circle(ix, iy, 9).stroke({ width: 1.2, color: 0xffffff, alpha: 0.7 * al });
        break;
      case 'core':
        g.moveTo(ix, iy - 7).lineTo(ix + 7, iy).lineTo(ix, iy + 7).lineTo(ix - 7, iy).closePath().fill({ color: col, alpha: 0.9 * al });
        break;
      case 'zone':
        host.label('ptr:' + n, 'screen', p.letter, ix, iy + 0.5, col, al, 15);
        break;
      case 'hot':
        g.circle(ix, iy, 4).fill({ color: col, alpha: al });
        g.circle(ix, iy, 8).stroke({ width: 1.4, color: col, alpha: al });
        break;
      case 'next':
        dashedRing(g, ix, iy, 8, 6, 0.5, t);
        g.stroke({ width: 1.6, color: 0xffffff, alpha: al });
        break;
    }
  }

  // ------------------------------------------------------------------------------------------
  // radar / big map (sx, sy = map px → radar px)

  drawRadar(frame: RenderFrame, g: Graphics, ox: number, oy: number, sx: number, sy: number, big: boolean, t: number, host: ObjectiveHost): void {
    const v = this.view;
    if (!v) return;
    const k = big ? 1.6 : 1;
    const blink = Math.floor(t * 4) % 2 === 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    if (v.mode === 'ctf') {
      const teams = new Set<TeamId>(this.stands.keys());
      if (v.flags) for (const f of v.flags) teams.add(f.team);
      for (const team of teams) {
        const st = this.standPos(v, team);
        if (!st) continue;
        const col = teamColor(team), x = ox + st.x * sx, y = oy + st.y * sy;
        const home = (this.flagOf(v, team)?.s ?? 0) === 0;
        g.moveTo(x, y + 3 * k).lineTo(x, y - 5 * k).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
        g.moveTo(x, y - 5 * k).lineTo(x + 5 * k, y - 3 * k).lineTo(x, y - 1 * k).closePath();
        if (home) g.fill({ color: col, alpha: 1 }); else g.stroke({ width: 1, color: col, alpha: 0.9 });
      }
      if (v.flags) for (const fv of v.flags) {
        if (fv.s === 0) continue;
        const col = teamColor(fv.team);
        let wx = fv.x, wy = fv.y;
        if (fv.s === 1 && fv.carrierId) { const a = host.ship(fv.carrierId); if (a) { wx = a.x; wy = a.y; } }
        const x = ox + wx * sx, y = oy + wy * sy, d = 3.4 * k;
        if (fv.s === 1) {
          g.moveTo(x, y - d).lineTo(x + d, y).lineTo(x, y + d).lineTo(x - d, y).closePath()
            .fill({ color: col, alpha: blink ? 1 : 0.55 }).stroke({ width: 1, color: 0xffffff, alpha: 0.9 });
        } else {
          g.circle(x, y, 2.2 * k).fill({ color: col, alpha: 1 });
          g.circle(x, y, 4.5 * k + pulse * 1.5).stroke({ width: 1, color: col, alpha: 0.7 });
        }
      }
    } else if (v.mode === 'zones') {
      for (const [idx, f] of this.zoneF) {
        let zv: ZoneV | undefined;
        if (v.zones) for (const z of v.zones) if (z.i === idx) { zv = z; break; }
        const L = zoneLook(zv, t);
        const x = ox + f.x * sx, y = oy + f.y * sy, rr = Math.max(3 * k, f.radius * sx);
        if (L.owner !== null) g.circle(x, y, rr).fill({ color: L.owner, alpha: 0.55 });
        g.circle(x, y, rr).stroke({ width: big ? 1.6 : 1.1, color: L.ring, alpha: L.owner !== null ? 0.95 : 0.6 });
        if (big && L.cap !== null && arcPath(g, x, y, rr + 3, TOP, L.progress * TAU)) g.stroke({ width: 2, color: L.cap, alpha: 0.95 });
        if (L.swarm) g.circle(x, y, 1.6 * k).fill({ color: ENEMY_COLOR, alpha: 1 });
      }
    } else if (v.mode === 'hotpoint' && v.hot) {
      const h = v.hot;
      if (big) for (const f of this.sites) {
        if (f.index === h.site || f.index === h.next) continue;
        g.circle(ox + f.x * sx, oy + f.y * sy, 1.2 * k).fill({ color: NEUTRAL_COLOR, alpha: 0.35 });
      }
      const cur = this.siteByIdx.get(h.site);
      if (cur) {
        let zv: ZoneV | undefined;
        if (v.zones) { for (const z of v.zones) if (z.i === h.site) { zv = z; break; } if (!zv) zv = v.zones[0]; }
        const L = zoneLook(zv, t);
        const col = L.owner ?? 0xffffff;
        const x = ox + cur.x * sx, y = oy + cur.y * sy, rr = Math.max(4 * k, cur.radius * sx);
        g.circle(x, y, rr).fill({ color: col, alpha: hotPhase(h) === 'arming' ? 0.2 : 0.4 });
        g.circle(x, y, rr).stroke({ width: 1.2, color: L.ring, alpha: 0.95 });
        g.circle(x, y, rr + 2 + 3 * pulse).stroke({ width: 1, color: col, alpha: 0.3 + 0.4 * (1 - pulse) });
      }
      const ni = hotNextIndex(h, v.overtime);
      const nf = ni >= 0 ? this.siteByIdx.get(ni) : undefined;
      if (nf) g.circle(ox + nf.x * sx, oy + nf.y * sy, Math.max(4 * k, nf.radius * sx)).stroke({ width: 1, color: 0xffffff, alpha: blink ? 0.85 : 0.3 });
    }
  }

  // ------------------------------------------------------------------------------------------
  // objective events (global)

  private featurePos(kind: 'stand' | 'zone' | 'site', index: number, fx: number, fy: number): { x: number; y: number; r: number } {
    // zone events in Hot Point carry the site index (a map has zones XOR hot sites, so the fallback is unambiguous)
    const f = kind === 'stand' ? this.stands.get(index)
      : kind === 'zone' ? (this.zoneF.get(index) ?? this.siteByIdx.get(index)) : this.siteByIdx.get(index);
    return f ? { x: f.x, y: f.y, r: f.radius } : { x: fx, y: fy, r: kind === 'stand' ? CTF_CAPTURE_RADIUS : 200 };
  }

  /**
   * FX for `{t:'objective'}`. Reads `index` as the flag team (CTF) / zone index / hot site index, `team` + `playerId`
   * as the acting side (captured by, taken by, returned by), and x, y as where it happened.
   */
  event(ev: GameEvent, host: ObjectiveHost): void {
    if (ev.t !== 'objective') return;
    switch (ev.kind) {
      case 'flagTaken': {
        const col = teamColor(ev.index);
        host.ring(ev.x, ev.y, 10, 150, 0.5, col, 3);
        host.burst(ev.x, ev.y, 18, col, 80, 320, 0.5, 0.45, true);
        host.impulse(ev.x, ev.y, 200, 260);
        break;
      }
      case 'flagDropped': {
        const col = teamColor(ev.index);
        host.ring(ev.x, ev.y, 8, 70, 0.4, col, 2);
        host.burst(ev.x, ev.y, 8, col, 40, 160, 0.4, 0.35, true);
        break;
      }
      case 'flagReturned': {
        const col = teamColor(ev.index);
        const p = this.featurePos('stand', ev.index, ev.x, ev.y);
        host.ring(p.x, p.y, 170, 12, 0.55, col, 3);
        host.ring(p.x, p.y, 10, 90, 0.45, 0xffffff, 1.6);
        host.burst(p.x, p.y, 14, col, 60, 220, 0.45, 0.4, true);
        break;
      }
      case 'flagCaptured': {
        const capC = sideColor(ev.team, ev.playerId) ?? teamColor(ev.index);
        host.ring(ev.x, ev.y, 20, 340, 0.8, capC, 4);
        host.ring(ev.x, ev.y, 10, 190, 0.6, 0xffffff, 2);
        host.burst(ev.x, ev.y, 40, capC, 120, 520, 0.7, 0.55, true);
        host.flash(ev.x, ev.y, 4, capC, 0.35, 0.8);
        host.impulse(ev.x, ev.y, 380, 540);
        host.tint(capC, 0.12, 0.6);
        break;
      }
      case 'zoneCaptured': {
        const p = this.featurePos('zone', ev.index, ev.x, ev.y);
        const c = sideColor(ev.team, ev.playerId) ?? NEUTRAL_COLOR;
        host.ring(p.x, p.y, p.r * 0.3, p.r + 70, 0.7, c, 4);
        host.ring(p.x, p.y, p.r + 40, p.r * 0.5, 0.5, 0xffffff, 1.6);
        host.burst(p.x, p.y, 24, c, 80, 360, 0.6, 0.45, true);
        host.impulse(p.x, p.y, p.r * 1.5, 380);
        break;
      }
      case 'zoneNeutralized': {
        const p = this.featurePos('zone', ev.index, ev.x, ev.y);
        host.ring(p.x, p.y, p.r + 30, 20, 0.5, 0xffffff, 2.5);
        host.burst(p.x, p.y, 10, NEUTRAL_COLOR, 60, 200, 0.4, 0.35, true);
        break;
      }
      case 'hotWarn': {
        const p = this.featurePos('site', ev.index, ev.x, ev.y);
        host.ring(p.x, p.y, 30, p.r, 0.7, 0xffffff, 2.5);
        host.flash(p.x, p.y, 2, 0xffffff, 0.3, 0.5);
        break;
      }
      case 'hotMoved': {
        const p = this.featurePos('site', ev.index, ev.x, ev.y);
        host.ring(p.x, p.y, p.r * 1.6, p.r * 0.2, 0.7, 0xffffff, 3);
        host.flash(p.x, p.y, 3.5, 0xffffff, 0.35, 0.7);
        host.impulse(p.x, p.y, p.r * 1.6, 420);
        host.tint(0xffffff, 0.06, 1);
        break;
      }
      case 'overtime': host.tint(0xffc070, 0.1, 0.5); break;
      case 'suddenDeath': host.tint(0xff1030, 0.14, 0.4); break;
    }
  }
}

/** An "X" (clash mark) of half-size s. */
function g4x(g: Graphics, x: number, y: number, s: number): void {
  g.moveTo(x - s, y - s).lineTo(x + s, y + s).moveTo(x + s, y - s).lineTo(x - s, y + s);
}
