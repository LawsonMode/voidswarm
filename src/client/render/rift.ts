// Rift layer (RENDER agent, v0.3 M4), docs/v0.3-proposal.md §4 + §9 RENDER M4:
//  · door force-fields per room state: DORMANT (open doorway, jambs + a threshold on the room side) → ARMING
//    (hazard panels close in from both jambs over RIFT_ARM_SEC, flickering) → SEALED (solid field, scrolling
//    lattice, slam FX) → CLEARED (the field retracts in a green burst, the jambs settle to a calm tint). A regroup
//    reset (SEALED → DORMANT) fizzles the field out;
//  · the sealed-room vignette (screen space) while the viewer's focus is inside an ARMING / SEALED room;
//  · chests (locked / ready / opened), the party's respawn anchor beacon, the Descend portal (closed sigil, open
//    vortex, departing countdown; hidden on the final floor) and the Extract portal (EXTRACT, or EXIT on the final
//    floor, with the victory-lap countdown) with channel arcs from the portal to every extracting ship;
//  · spawnWarn ground cracks, boss telegraphs (dash lanes, rings), minimap room fog by party.seen (seen rooms full,
//    rooms linked to a seen room glimpsed, the rest hidden), radar icons, rift event FX, the Matriarch's phase /
//    intro state for the enemy renderer, and the open portals on render/beamBus (AudioFx portal hum).
// Geometry comes from map.dungeon (setMap, never on the wire); dynamic state from frame.match.dungeon, floor-checked
// against map.dungeon.floor. With no view for this floor (the floorStart race, a drop-in) the door tiles are read
// from the map instead: a door tile holding TILE_WALL means SEALED (the client mirrors seals with applyRoomSeals).
// Pixi types only (no runtime import), so the rules are unit-tested in node: GameRenderer supplies a RiftHost.
import type { Graphics } from 'pixi.js';
import type { RenderFrame } from '../contracts';
import { ENEMY_COLOR, colorFor } from '../../shared/data/teams';
import { RARITY_COLORS } from '../../shared/data/loot';
import {
  RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_WALL,
  type EntityId, type GameEvent, type GameMap, type PlayerId, type RiftLayout, type RiftRoom, type RiftRoomKind,
  type RiftView, type TeamId,
} from '../../shared/types';
import { beamBus, publishPortal } from './beamBus';
import { Countdown, type ObjShip } from './objectives';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import { brighten, darken, mix } from './palette';

// ---------------------------------------------------------------------------------------------
// numbers (proposal §4.2–§4.7) and colours
// ---------------------------------------------------------------------------------------------

/** ARMING → SEALED delay (proposal §4.3: 1.5 s, not cancellable). */
export const RIFT_ARM_SEC = 1.5;
/** Descend / Extract zone radii (§4.7) and the chest reach (§4.3). */
export const DESCEND_R = 160;
export const EXTRACT_R = 140;
export const CHEST_REACH = 48;
/** Anchor beacon beam height (world px). */
export const ANCHOR_BEAM_H = 240;
/** A telegraph flashes this long once its warning time is up. */
export const TELEGRAPH_STRIKE_SEC = 0.25;
export const MAX_TELEGRAPHS = 24;
export const MAX_CRACKS = 32;
/** Room rim thickness (tiles) around an interior (§4.2 step 4). */
export const RIM_TILES = 2;

/** The swarm's lock: sealed fields, the sealed-room vignette. */
export const SEAL_COLOR = ENEMY_COLOR;
/** Hazard: doors closing. */
export const ARM_COLOR = 0xffe27a;
/** Safe again: cleared rooms. */
export const CLEAR_COLOR = 0x6bff9a;
/** Descend vortex (violet rim, ice core). */
export const PORTAL_COLOR = 0x8f7bff;
export const PORTAL_CORE = 0x7fe9ff;
/** Extract / Exit (gold). */
export const EXTRACT_COLOR = 0xffd27a;
/** Boss attack lanes / rings. */
export const TELEGRAPH_COLOR = 0xff5a2a;
/** Encounter spawn cracks (enemies appear here). */
export const SPAWN_COLOR = ENEMY_COLOR;
/** Neutral grey for resets / waiting marks. */
const GREY = 0xc8d0ff;

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// =============================================================================================
// pure rules (unit-tested)
// =============================================================================================

/** The rift view for this map, or null (no view, or a view for another floor: the floorStart race). */
export function viewFor(view: RiftView | null | undefined, layout: RiftLayout | null | undefined): RiftView | null {
  return view && layout && view.floor === layout.floor ? view : null;
}

/**
 * Room states for a map, index = room idx. From the (floor-checked) view when present; else read from the door
 * tiles, where a door holding TILE_WALL is SEALED (applyRoomSeals mirrors seals into the tiles on both hosts).
 */
export function roomStates(map: GameMap, view: RiftView | null, out: number[] = []): number[] {
  const L = map.dungeon;
  out.length = 0;
  if (!L) return out;
  for (const room of L.rooms) {
    let s = RIFT_DORMANT;
    if (view) s = view.rooms[room.idx] ?? RIFT_DORMANT;
    else {
      for (const d of room.doors) {
        let sealed = false;
        for (const i of d.tiles) if (map.tiles[i] === TILE_WALL) { sealed = true; break; }
        if (sealed) { s = RIFT_SEALED; break; }
      }
    }
    out[room.idx] = s;
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = RIFT_DORMANT;
  return out;
}

/** Room index whose walkable interior holds (x, y), or -1 (corridor, rim, outside). */
export function roomIndexAt(L: RiftLayout | null | undefined, tileSize: number, x: number, y: number): number {
  if (!L) return -1;
  const c = Math.floor(x / tileSize), r = Math.floor(y / tileSize);
  for (const room of L.rooms) if (c >= room.c0 && c < room.c1 && r >= room.r0 && r < room.r1) return room.idx;
  return -1;
}

/** Every rift door tile index (open or sealed) of a map. */
export function doorTileIndices(map: GameMap): number[] {
  const out: number[] = [];
  const L = map.dungeon;
  if (L) for (const room of L.rooms) for (const d of room.doors) for (const i of d.tiles) out.push(i);
  return out;
}

export interface DoorGeom {
  room: number; door: number;
  /** Tile rect [c0, c1) × [r0, r1). */
  c0: number; r0: number; c1: number; r1: number;
  /** Pixel rect + centre. */
  x0: number; y0: number; x1: number; y1: number;
  cx: number; cy: number;
  /** true: the gap runs along x (a door in a top / bottom rim). */
  alongX: boolean;
  /** Unit normal pointing into the room. */
  nx: number; ny: number;
  tiles: readonly number[];
}

/** Door rectangles of a rift map (one per RiftDoor with tiles). */
export function doorGeoms(map: GameMap): DoorGeom[] {
  const L = map.dungeon;
  const out: DoorGeom[] = [];
  if (!L) return out;
  const ts = map.tileSize, cols = map.cols;
  for (const room of L.rooms) {
    for (let k = 0; k < room.doors.length; k++) {
      const d = room.doors[k];
      if (!d.tiles.length) continue;
      let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
      for (const i of d.tiles) {
        const c = i % cols, r = (i - c) / cols;
        if (c < c0) c0 = c; if (r < r0) r0 = r;
        if (c + 1 > c1) c1 = c + 1; if (r + 1 > r1) r1 = r + 1;
      }
      const x0 = c0 * ts, y0 = r0 * ts, x1 = c1 * ts, y1 = r1 * ts;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const alongX = c1 - c0 >= r1 - r0;
      let dx = d.inX - cx, dy = d.inY - cy;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) { dx = room.x - cx; dy = room.y - cy; }
      const nx = alongX ? 0 : dx >= 0 ? 1 : -1, ny = alongX ? (dy >= 0 ? 1 : -1) : 0;
      out.push({ room: room.idx, door: k, c0, r0, c1, r1, x0, y0, x1, y1, cx, cy, alongX, nx, ny, tiles: d.tiles });
    }
  }
  return out;
}

/**
 * Minimap fog owner per tile: the room whose interior + rim is nearest (ties → lower idx), so a corridor belongs
 * half to each end. Null on maps without a rift layout.
 */
export function fogOwners(map: GameMap): Int8Array | null {
  const L = map.dungeon;
  if (!L || !L.rooms.length) return null;
  const { cols, rows } = map;
  const own = new Int8Array(cols * rows);
  const rooms = L.rooms;
  const n = rooms.length;
  const a0 = new Int32Array(n), a1 = new Int32Array(n), b0 = new Int32Array(n), b1 = new Int32Array(n), id = new Int8Array(n);
  for (let k = 0; k < n; k++) {
    const q = rooms[k];
    a0[k] = q.c0 - RIM_TILES; a1[k] = q.c1 + RIM_TILES - 1; b0[k] = q.r0 - RIM_TILES; b1[k] = q.r1 + RIM_TILES - 1; id[k] = q.idx;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const dx = c < a0[k] ? a0[k] - c : c > a1[k] ? c - a1[k] : 0;
        const dy = r < b0[k] ? b0[k] - r : r > b1[k] ? r - b1[k] : 0;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = id[k]; }
      }
      own[r * cols + c] = best;
    }
  }
  return own;
}

/** Fog level per room: 2 = seen, 1 = linked to a seen room (glimpsed), 0 = hidden. */
export function fogLevels(L: RiftLayout, seen: number): Uint8Array {
  const out = new Uint8Array(L.rooms.length);
  for (const room of L.rooms) if ((seen >> room.idx) & 1) out[room.idx] = 2;
  for (const room of L.rooms) {
    if (out[room.idx] !== 2) continue;
    for (const k of room.links) if (k >= 0 && k < out.length && out[k] === 0) out[k] = 1;
  }
  return out;
}

export type ChestState = 'locked' | 'ready' | 'opened';
/** Treasure chests open any time; reward (arena) and key chests only once the room is CLEARED (§4.3). */
export function chestState(room: RiftRoom, k: number, state: number, mask: number): ChestState {
  if ((mask >> k) & 1) return 'opened';
  return room.kind === 'treasure' || state === RIFT_CLEARED ? 'ready' : 'locked';
}
/** A chest's glow is its drop's rarity floor (data/loot.ts DROP_RULES): roomChest [C], treasure / key [U]. */
export function chestRarity(kind: RiftRoomKind): number {
  return kind === 'treasure' || kind === 'key' ? 1 : 0;
}

export type DoorMode = 'open' | 'arming' | 'sealed' | 'cleared';
export interface DoorLook {
  mode: DoorMode;
  /** Closed fraction of the gap (0 open … 1 shut): arming panels close from both jambs. */
  close: number;
  color: number;
  /** Field alpha. */
  alpha: number;
  jamb: number;
  jambAlpha: number;
}
/**
 * Door field look. armAge = seconds since ARMING began; clearAge = seconds since CLEARED (Infinity = long ago: the
 * field is gone and the jambs have settled). `idle` = the biome's door colour.
 */
export function doorLook(state: number, armAge: number, clearAge: number, t: number, idle: number): DoorLook {
  switch (state) {
    case RIFT_ARMING: {
      const close = clamp01(armAge / RIFT_ARM_SEC);
      const fl = Math.floor(t * 16) % 2 ? 1 : 0.55;
      return { mode: 'arming', close, color: ARM_COLOR, alpha: (0.35 + 0.45 * close) * fl, jamb: ARM_COLOR, jambAlpha: 0.95 };
    }
    case RIFT_SEALED:
      return { mode: 'sealed', close: 1, color: SEAL_COLOR, alpha: 0.82 + 0.1 * Math.sin(t * 5), jamb: SEAL_COLOR, jambAlpha: 1 };
    case RIFT_CLEARED: {
      const retract = clamp01(clearAge / 0.45);
      const settle = clamp01(clearAge / 2) * 0.65;
      return { mode: 'cleared', close: 1 - retract, color: CLEAR_COLOR, alpha: 0.7 * (1 - retract), jamb: mix(CLEAR_COLOR, idle, settle), jambAlpha: 0.95 - 0.45 * clamp01(clearAge / 2) };
    }
    default:
      return { mode: 'open', close: 0, color: idle, alpha: 0, jamb: idle, jambAlpha: 0.55 };
  }
}

/** Screen vignette while the viewer is inside a room in this state (alpha 0 = none). */
export function vignetteFor(state: number, t: number): { color: number; alpha: number } {
  if (state === RIFT_SEALED) return { color: darken(SEAL_COLOR, 0.3), alpha: 0.62 + 0.08 * Math.sin(t * 2.4) };
  if (state === RIFT_ARMING) return { color: darken(ARM_COLOR, 0.25), alpha: 0.4 + (Math.floor(t * 8) % 2 ? 0.15 : 0) };
  return { color: 0, alpha: 0 };
}

export interface PortalLook {
  /** none: no portal on this floor / the final floor (only Extract, labelled EXIT, opens there). */
  descend: 'none' | 'closed' | 'open' | 'departing';
  extract: 'none' | 'open';
  exitLabel: 'EXTRACT' | 'EXIT';
  final: boolean;
}
export function portalLook(L: RiftLayout, view: RiftView | null): PortalLook {
  const final = !!view && view.floor >= view.floorsTotal;
  let descend: PortalLook['descend'] = 'closed';
  if (!(L.portalX >= 0) || (final && L.bossFloor)) descend = 'none';
  else if (view?.portal === 2) descend = 'departing';
  else if (view?.portal === 1) descend = 'open';
  const extract: PortalLook['extract'] = L.extractX >= 0 && !!view?.extractOpen ? 'open' : 'none';
  return { descend, extract, exitLabel: final ? 'EXIT' : 'EXTRACT', final };
}

/** Matriarch phase (1..3): the view's boss entry when it is this enemy, else from its HP (66% / 33%, §4.5). */
export function matriarchPhase(view: RiftView | null, id: EntityId, hpFrac: number): number {
  if (view?.boss && view.boss.id === id) return Math.max(1, Math.min(3, view.boss.phase || 1));
  return hpFrac > 0.66 ? 1 : hpFrac > 0.33 ? 2 : 3;
}

/** The viewer's party: you.rift.party, else the local ship / roster team, else party 0 (spectators). */
export function viewerParty(frame: RenderFrame): TeamId {
  const rp = frame.you?.rift?.party;
  if (rp !== undefined && rp >= 0) return rp;
  if (frame.localShipId) for (const s of frame.ships) if (s.id === frame.localShipId && s.team >= 0) return s.team;
  const p = frame.players.get(frame.localPlayerId);
  return p && p.team >= 0 ? p.team : 0;
}

/** Warning progress 0..1 of a telegraph / crack of `sec` seconds, `age` seconds in. */
export const warnFrac = (age: number, sec: number): number => (sec > 0 ? clamp01(age / sec) : 1);

/** mm:ss */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// host + transient FX records
// ---------------------------------------------------------------------------------------------

/** What the rift layer needs from the renderer (keeps rift.ts free of GameRenderer internals). */
export interface RiftHost {
  inView(x: number, y: number, margin: number): boolean;
  /** Display position / radius / root alpha of a live, drawn ship (null if not drawn). */
  ship(id: EntityId): ObjShip | null;
  /** Live ship id of a player (0 = none). */
  shipOfPlayer(pid: PlayerId): EntityId;
  /** Pooled label, shown this frame only ('world' = world px under the ships). */
  label(key: string, space: 'world' | 'screen', text: string, x: number, y: number, color: number, alpha: number, size: number): void;
  ring(x: number, y: number, r0: number, r1: number, life: number, color: number, width: number, follow?: EntityId): void;
  burst(x: number, y: number, n: number, color: number, spMin: number, spMax: number, life: number, scale: number, dots?: boolean): void;
  flash(x: number, y: number, size: number, color: number, life: number, alpha: number): void;
  impulse(x: number, y: number, radius: number, strength: number): void;
  tint(color: number, alpha: number, decay: number): void;
  /** Camera trauma, attenuated by distance from the camera. */
  shake(amount: number, x: number, y: number): void;
  /** Screen shockwave centred on (x, y). */
  shock(x: number, y: number): void;
  /** One particle moving with (vx, vy): portal suction, chest sparkles. */
  spark(x: number, y: number, vx: number, vy: number, life: number, color: number, scale: number): void;
}

interface Tele { shape: 'line' | 'ring'; x: number; y: number; x2: number; y2: number; r: number; sec: number; t0: number; struck: boolean }
interface Crack { x: number; y: number; radius: number; sec: number; t0: number; pts: number[]; done: boolean }
/** Crack polylines per spawnWarn, points per crack. */
const CRACKS_PER_WARN = 7, CRACK_PTS = 5;

// =============================================================================================
// the layer
// =============================================================================================

export class RiftLayer {
  /** Viewer's party (recomputed by begin()). */
  party: TeamId = 0;
  private map: GameMap | null = null;
  private L: RiftLayout | null = null;
  private doors: DoorGeom[] = [];
  private doorsByRoom: DoorGeom[][] = [];
  private owners: Int8Array | null = null;
  private levels: Uint8Array = new Uint8Array(0);
  private levelsFor = -2;
  private view: RiftView | null = null;
  private states: number[] = [];
  private prev: number[] = [];
  private armT: number[] = [];
  private clearT: number[] = [];
  private prevChest: number[] = [];
  /** Chest open time, key = room * 16 + chest. */
  private chestT = new Map<number, number>();
  private introT = new Map<EntityId, number>();
  private teles: Tele[] = [];
  private cracks: Crack[] = [];
  private anchorX = NaN; private anchorY = NaN;
  private depart = new Countdown();
  private departTotal = 0;
  private seenMask = -1;
  private idleDoor = 0xffe27a;
  private now = 0;

  constructor(private readonly A: Atlas, readonly glow: SpriteBatch) {}

  /** Re-entrant (every matchStart / floorStart): rebuilds the door / fog index and drops every transient. */
  setMap(map: GameMap, idleDoorColor = 0xffe27a): void {
    this.map = map;
    this.L = map.dungeon ?? null;
    this.idleDoor = idleDoorColor;
    this.doors = doorGeoms(map);
    this.doorsByRoom = [];
    if (this.L) for (const room of this.L.rooms) this.doorsByRoom[room.idx] = [];
    for (const d of this.doors) (this.doorsByRoom[d.room] ??= []).push(d);
    this.owners = fogOwners(map);
    this.levels = new Uint8Array(this.L?.rooms.length ?? 0);
    this.levelsFor = -2;
    this.view = null;
    this.states.length = 0; this.prev.length = 0; this.armT.length = 0; this.clearT.length = 0; this.prevChest.length = 0;
    this.chestT.clear(); this.introT.clear();
    this.teles.length = 0; this.cracks.length = 0;
    this.anchorX = NaN; this.anchorY = NaN;
    this.depart = new Countdown(); this.departTotal = 0;
    this.seenMask = this.L ? this.entranceMask() : -1;
  }

  /** A rift floor is loaded. */
  get active(): boolean { return !!this.L; }
  /** Door / fog index sizes (debug / tests). */
  get counts(): { rooms: number; doors: number; telegraphs: number; cracks: number } {
    return { rooms: this.L?.rooms.length ?? 0, doors: this.doors.length, telegraphs: this.teles.length, cracks: this.cracks.length };
  }
  /** Minimap fog key: the viewer party's seen mask, -1 when there is no rift (no fog). */
  get fogKey(): number { return this.L ? this.seenMask : -1; }
  /** Per-tile fog owners + per-room fog levels for the minimap, or null (no rift). */
  fog(): { owners: Int8Array; levels: Uint8Array } | null {
    if (!this.L || !this.owners) return null;
    return { owners: this.owners, levels: this.fogLevelsNow() };
  }
  /** Room states this frame (index = room idx). */
  get roomStateList(): readonly number[] { return this.states; }

  private entranceMask(): number {
    const L = this.L;
    if (!L) return 0;
    const e = L.entrances[this.party] ?? L.entrances[0];
    return e !== undefined && e >= 0 ? 1 << e : 0;
  }

  private fogLevelsNow(): Uint8Array {
    if (this.L && this.levelsFor !== this.seenMask) { this.levels = fogLevels(this.L, this.seenMask); this.levelsFor = this.seenMask; }
    return this.levels;
  }

  /** Fully revealed at (x, y) (no rift = always). Radar enemy dots in fogged rooms are hidden. */
  revealedAt(x: number, y: number): boolean {
    const m = this.map, own = this.owners;
    if (!m || !own || !this.L) return true;
    const c = Math.floor(x / m.tileSize), r = Math.floor(y / m.tileSize);
    if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return false;
    const o = own[r * m.cols + c];
    return o < 0 || this.fogLevelsNow()[o] === 2;
  }

  /** Room idx at (x, y), or -1. */
  roomAt(x: number, y: number): number {
    return this.map ? roomIndexAt(this.L, this.map.tileSize, x, y) : -1;
  }
  /** State of the room at (x, y), or -1 outside any room. */
  stateAt(x: number, y: number): number {
    const i = this.roomAt(x, y);
    return i >= 0 ? (this.states[i] ?? RIFT_DORMANT) : -1;
  }

  /** Matriarch phase for the enemy renderer. */
  bossPhase(id: EntityId, hpFrac: number): number { return matriarchPhase(this.view, id, hpFrac); }
  /** Seconds since this boss's intro (Infinity = none seen): the renderer draws the 3 s intro shield. */
  introAge(id: EntityId, t: number): number { const a = this.introT.get(id); return a === undefined ? Infinity : t - a; }

  // ------------------------------------------------------------------------------------------

  /**
   * Once per frame, BEFORE the frame's events: view + room states (floor-checked), seen mask, and the state
   * transitions' FX (the first observation of a room is silent, so a drop-in never replays a slam).
   */
  begin(frame: RenderFrame, t: number, host: RiftHost): void {
    this.now = t;
    this.glow.begin();
    beamBus.portalCount = 0;
    const L = this.L, map = this.map;
    if (!L || !map) { this.view = null; return; }
    this.party = viewerParty(frame);
    this.view = viewFor(frame.match?.dungeon, L);
    roomStates(map, this.view, this.states);
    const v = this.view;
    if (v) {
      const s = v.seen[this.party] ?? v.seen[0];
      if (typeof s === 'number') this.seenMask = s | this.entranceMask();
    }
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[i], p = this.prev[i];
      if (p === undefined) {
        this.armT[i] = s === RIFT_ARMING ? t : -1e9;
        this.clearT[i] = -1e9;
      } else if (s !== p) this.transition(i, p, s, t, host);
      this.prev[i] = s;
    }
    if (v) {
      for (const room of L.rooms) {
        const mask = v.chests[room.idx] ?? 0, pm = this.prevChest[room.idx];
        if (pm !== undefined && mask !== pm) {
          for (let k = 0; k * 2 < room.chests.length; k++) {
            if (!((mask >> k) & 1) || ((pm >> k) & 1)) continue;
            const key = room.idx * 16 + k;
            if (!this.chestT.has(key)) { this.chestT.set(key, t); this.chestFx(room, k, host); }
          }
        }
        this.prevChest[room.idx] = mask;
      }
      // anchor moved (a room clear): pulse the new spot
      const ax = v.anchors[this.party * 2], ay = v.anchors[this.party * 2 + 1];
      if (typeof ax === 'number' && typeof ay === 'number') {
        if (Number.isFinite(this.anchorX) && Math.hypot(ax - this.anchorX, ay - this.anchorY) > 8) {
          const c = this.partyColor();
          host.ring(ax, ay, 12, 120, 0.6, c, 3);
          host.flash(ax, ay, 1.6, c, 0.3, 0.6);
        }
        this.anchorX = ax; this.anchorY = ay;
      }
      // departing countdown total (the first value seen per departure: 20 s, or 3 s once every human is in)
      if (v.departIn > 0) { if (this.departTotal <= 0 || v.departIn > this.departTotal) this.departTotal = v.departIn; }
      else this.departTotal = 0;
    }
  }

  end(): void { this.glow.end(); }

  private partyColor(): number { return brighten(colorFor(this.party, 0), 0.3); }

  private transition(i: number, p: number, s: number, t: number, host: RiftHost): void {
    const L = this.L!;
    const room = L.rooms[i] ?? L.rooms.find((q) => q.idx === i);
    const doors = this.doorsByRoom[i] ?? [];
    if (s === RIFT_ARMING) {
      this.armT[i] = t;
      for (const d of doors) host.flash(d.cx, d.cy, 1.2, ARM_COLOR, 0.2, 0.6);
    } else if (s === RIFT_SEALED) {
      if (p !== RIFT_ARMING) this.armT[i] = t - RIFT_ARM_SEC;
      for (const d of doors) {
        host.flash(d.cx, d.cy, 2.2, SEAL_COLOR, 0.3, 0.9);
        host.burst(d.cx, d.cy, 16, brighten(SEAL_COLOR, 0.3), 120, 420, 0.4, 0.45);
        host.impulse(d.cx, d.cy, 220, 520);
      }
      if (room) host.shake(0.35, room.x, room.y);
    } else if (s === RIFT_CLEARED) {
      this.clearT[i] = t;
      if (p === RIFT_SEALED || p === RIFT_ARMING) {
        for (const d of doors) {
          host.burst(d.cx, d.cy, 22, CLEAR_COLOR, 80, 360, 0.5, 0.45, true);
          host.flash(d.cx, d.cy, 1.8, CLEAR_COLOR, 0.25, 0.7);
        }
      }
    } else if (s === RIFT_DORMANT && (p === RIFT_SEALED || p === RIFT_ARMING)) {
      // regroup reset: the field fizzles out
      for (const d of doors) host.burst(d.cx, d.cy, 10, GREY, 40, 200, 0.4, 0.35, true);
      this.clearT[i] = -1e9;
    }
  }

  private chestPos(room: RiftRoom, k: number): { x: number; y: number } {
    return { x: room.chests[k * 2], y: room.chests[k * 2 + 1] };
  }

  private chestFx(room: RiftRoom, k: number, host: RiftHost): void {
    const { x, y } = this.chestPos(room, k);
    const c = RARITY_COLORS[chestRarity(room.kind)];
    host.burst(x, y - 6, 26, brighten(c, 0.3), 80, 340, 0.6, 0.45, true);
    host.ring(x, y, 8, 110, 0.5, c, 3);
    host.flash(x, y, 2, c, 0.3, 0.8);
    host.impulse(x, y, 160, 300);
  }

  // ------------------------------------------------------------------------------------------
  // world layer (under gems / ships). `pad` = normal-blend fills, `add` = additive lines.

  drawWorld(frame: RenderFrame, t: number, pad: Graphics, add: Graphics, host: RiftHost): void {
    const L = this.L;
    if (!L || !this.map) return;
    this.drawDoors(t, pad, add, host);
    this.drawChests(t, pad, add, host);
    this.drawAnchor(t, add, host);
    this.drawPortals(t, pad, add, host);
    this.drawCracks(t, add, host);
    this.drawTelegraphs(t, pad, add, host);
    void frame;
  }

  private drawDoors(t: number, pad: Graphics, add: Graphics, host: RiftHost): void {
    const L = this.L!;
    for (const d of this.doors) {
      if (!host.inView(d.cx, d.cy, 160)) continue;
      const room = L.rooms[d.room];
      const st = this.states[d.room] ?? RIFT_DORMANT;
      const look = doorLook(st, t - (this.armT[d.room] ?? -1e9), t - (this.clearT[d.room] ?? -1e9), t, this.idleDoor);
      // axis frame: u along the gap, v across it (toward the room when v > 0 · side)
      const ax = d.alongX ? 1 : 0, ay = d.alongX ? 0 : 1;
      const px = d.alongX ? 0 : 1, py = d.alongX ? 1 : 0;
      const hl = (d.alongX ? d.x1 - d.x0 : d.y1 - d.y0) / 2;
      const hd = (d.alongX ? d.y1 - d.y0 : d.x1 - d.x0) / 2;
      const side = d.nx * px + d.ny * py >= 0 ? 1 : -1;
      const P = (u: number, v: number, out: number[]): number[] => { out[0] = d.cx + ax * u + px * v; out[1] = d.cy + ay * u + py * v; return out; };
      const rectUV = (g: Graphics, u0: number, u1: number, v0: number, v1: number) => {
        const a = P(u0, v0, tmpA), b = P(u1, v1, tmpB);
        g.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      };
      // jambs (emitter posts at both ends of the gap)
      for (const e of [-1, 1]) {
        rectUV(add, e * hl - (e > 0 ? 5 : -5), e * hl, -hd, hd);
        const q = P(e * hl, 0, tmpA);
        this.glow.put(this.A.soft, q[0], q[1], 0, 0.55, (hd * 2) / 40, look.jamb, 0.3 * look.jambAlpha);
      }
      add.stroke({ width: 2, color: look.jamb, alpha: look.jambAlpha });
      // dormant sealable doorway: a dashed threshold on the room side + a chevron pointing in
      if (look.mode === 'open' && room && (room.kind === 'arena' || room.kind === 'key' || room.kind === 'boss')) {
        const v0 = side * hd;
        const n = 6;
        for (let k = 0; k < n; k++) {
          const u0 = -hl + ((k + 0.2) / n) * 2 * hl, u1 = -hl + ((k + 0.7) / n) * 2 * hl;
          const a = P(u0, v0, tmpA); add.moveTo(a[0], a[1]);
          const b = P(u1, v0, tmpB); add.lineTo(b[0], b[1]);
        }
        const bob = 3 * Math.sin(t * 3 + d.room);
        const c0 = P(-10, v0 + side * (6 + bob), tmpA); add.moveTo(c0[0], c0[1]);
        const c1 = P(0, v0 + side * (14 + bob), tmpB); add.lineTo(c1[0], c1[1]);
        const c2 = P(10, v0 + side * (6 + bob), tmpA); add.lineTo(c2[0], c2[1]);
        add.stroke({ width: 1.6, color: look.jamb, alpha: 0.4 });
      }
      if (look.close <= 0.001 || look.alpha <= 0.001) continue;
      // field panels closing in from both jambs (they meet at close = 1)
      const fv = hd * 0.6;
      const reach = look.close * hl;
      for (const e of [-1, 1]) {
        const ua = e < 0 ? -hl : hl - reach, ub = e < 0 ? -hl + reach : hl;
        rectUV(pad, ua, ub, -fv, fv);
        pad.fill({ color: look.color, alpha: 0.1 * look.alpha });
        rectUV(add, ua, ub, -fv, fv);
        add.fill({ color: look.color, alpha: 0.12 * look.alpha });
        // scrolling diagonal lattice, clipped to the panel
        const step = 14, off = (t * (look.mode === 'sealed' ? 26 : 60)) % step;
        for (let s = ua - 2 * fv - step + off; s < ub; s += step) {
          const va = Math.max(-fv, ua - s - fv), vb = Math.min(fv, ub - s - fv);
          if (vb <= va) continue;
          const a = P(s + va + fv, va, tmpA); add.moveTo(a[0], a[1]);
          const b = P(s + vb + fv, vb, tmpB); add.lineTo(b[0], b[1]);
        }
        add.stroke({ width: 1.2, color: brighten(look.color, 0.35), alpha: 0.45 * look.alpha });
        // leading edge
        if (look.close < 0.999) {
          const ue = e < 0 ? ub : ua;
          const a = P(ue, -fv, tmpA); add.moveTo(a[0], a[1]);
          const b = P(ue, fv, tmpB); add.lineTo(b[0], b[1]);
          add.stroke({ width: 2.4, color: 0xffffff, alpha: 0.85 * look.alpha });
        }
      }
      // slab edges + glow
      for (const vv of [-fv, fv]) {
        const a = P(-hl, vv, tmpA); add.moveTo(a[0], a[1]);
        const b = P(-hl + reach, vv, tmpB); add.lineTo(b[0], b[1]);
        const c = P(hl - reach, vv, tmpA); add.moveTo(c[0], c[1]);
        const e2 = P(hl, vv, tmpB); add.lineTo(e2[0], e2[1]);
      }
      add.stroke({ width: 1.8, color: look.color, alpha: 0.9 * look.alpha });
      const gx = d.alongX ? (hl * 2) / 44 : (fv * 2) / 30, gy = d.alongX ? (fv * 2) / 30 : (hl * 2) / 44;
      this.glow.put(this.A.soft, d.cx, d.cy, 0, gx * look.close, gy, look.color, 0.35 * look.alpha);
      if (look.mode === 'sealed') {
        // pulsing seam + an occasional spark off the field
        const a = P(0, -fv, tmpA); add.moveTo(a[0], a[1]);
        const b = P(0, fv, tmpB); add.lineTo(b[0], b[1]);
        add.stroke({ width: 3, color: 0xffffff, alpha: 0.35 + 0.3 * Math.sin(t * 7 + d.room) });
        if (Math.random() < 0.08) {
          const u = (Math.random() * 2 - 1) * hl, q = P(u, 0, tmpA);
          host.spark(q[0], q[1], px * side * -60 + (Math.random() - 0.5) * 80, py * side * -60 + (Math.random() - 0.5) * 80, 0.3, brighten(SEAL_COLOR, 0.4), 0.3);
        }
      }
    }
  }

  private drawChests(t: number, pad: Graphics, add: Graphics, host: RiftHost): void {
    const L = this.L!, v = this.view;
    for (const room of L.rooms) {
      const st = this.states[room.idx] ?? RIFT_DORMANT;
      const mask = v ? (v.chests[room.idx] ?? 0) : 0;
      for (let k = 0; k * 2 + 1 < room.chests.length; k++) {
        const x = room.chests[k * 2], y0 = room.chests[k * 2 + 1];
        if (!host.inView(x, y0, 90)) continue;
        const cs = chestState(room, k, st, mask);
        const big = room.kind === 'key';
        const w = big ? 36 : 30, h = big ? 24 : 20;
        const col = RARITY_COLORS[chestRarity(room.kind)];
        const ph = room.idx * 1.3 + k * 2.1;
        if (cs === 'opened') {
          const age = t - (this.chestT.get(room.idx * 16 + k) ?? -1e9);
          const glow = Math.max(0, 1 - age / 3);
          pad.rect(x - w / 2, y0 - h / 2 + 4, w, h - 4).fill({ color: darken(col, 0.8), alpha: 0.75 });
          add.rect(x - w / 2, y0 - h / 2 + 4, w, h - 4).stroke({ width: 1.6, color: col, alpha: 0.35 + 0.5 * glow });
          // lid flipped up behind
          add.rect(x - w / 2 + 2, y0 - h / 2 - 8, w - 4, 7).stroke({ width: 1.4, color: col, alpha: 0.3 + 0.5 * glow });
          if (glow > 0) this.glow.put(this.A.soft, x, y0 - 4, 0, 1.2, 1.2, col, 0.4 * glow);
          continue;
        }
        const ready = cs === 'ready';
        const y = y0 + (ready ? Math.sin(t * 2.4 + ph) * 2 : 0);
        const pulse = 0.5 + 0.5 * Math.sin(t * 3 + ph);
        if (ready) {
          this.glow.put(this.A.soft, x, y, 0, 1.3 + 0.2 * pulse, 1.1 + 0.2 * pulse, col, 0.3 + 0.15 * pulse);
          // reach ring (48 px): fly in to open
          const n = 10;
          for (let i = 0; i < n; i++) {
            const a0 = t * 0.8 + ph + (i * TAU) / n;
            add.moveTo(x + Math.cos(a0) * CHEST_REACH, y0 + Math.sin(a0) * CHEST_REACH).arc(x, y0, CHEST_REACH, a0, a0 + (TAU / n) * 0.5);
          }
          add.stroke({ width: 1.2, color: col, alpha: 0.25 + 0.15 * pulse });
          if (Math.random() < 0.05) host.spark(x + (Math.random() - 0.5) * w, y - h / 2, 0, -40 - Math.random() * 40, 0.6, brighten(col, 0.5), 0.25);
        }
        pad.rect(x - w / 2, y - h / 2, w, h).fill({ color: darken(col, ready ? 0.7 : 0.88), alpha: ready ? 0.85 : 0.7 });
        add.rect(x - w / 2, y - h / 2, w, h).stroke({ width: ready ? 2 : 1.4, color: ready ? brighten(col, 0.2) : col, alpha: ready ? 0.95 : 0.28 });
        // lid seam + corner studs
        add.moveTo(x - w / 2, y - h * 0.15).lineTo(x + w / 2, y - h * 0.15)
          .stroke({ width: ready ? 2 : 1, color: ready ? 0xffffff : col, alpha: ready ? 0.55 + 0.4 * pulse : 0.25 });
        if (!ready) {
          // padlock: shackle + body
          const lx = x, ly = y + 2;
          add.moveTo(lx - 4, ly - 2).arc(lx, ly - 2, 4, Math.PI, TAU).stroke({ width: 1.4, color: 0xffffff, alpha: 0.4 });
          add.rect(lx - 5, ly - 2, 10, 7).stroke({ width: 1.4, color: 0xffffff, alpha: 0.4 });
        }
      }
    }
  }

  private drawAnchor(t: number, add: Graphics, host: RiftHost): void {
    const v = this.view, L = this.L!;
    let x = NaN, y = NaN;
    if (v) { x = v.anchors[this.party * 2]; y = v.anchors[this.party * 2 + 1]; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const e = L.rooms[L.entrances[this.party] ?? L.entrances[0] ?? 0];
      if (!e) return;
      x = e.x; y = e.y;
    }
    if (!host.inView(x, y, ANCHOR_BEAM_H + 40)) return;
    const c = this.partyColor();
    const p = 0.5 + 0.5 * Math.sin(t * 2.2);
    this.glow.put(this.A.beam, x, y - ANCHOR_BEAM_H / 2, 0, 0.55, ANCHOR_BEAM_H / 64, c, 0.22 + 0.1 * p);
    this.glow.put(this.A.soft, x, y, 0, 1.4, 1.4, c, 0.18 + 0.08 * p);
    const n = 6, R = 34;
    for (let i = 0; i < n; i++) {
      const a0 = -t * 0.6 + (i * TAU) / n;
      add.moveTo(x + Math.cos(a0) * R, y + Math.sin(a0) * R).arc(x, y, R, a0, a0 + (TAU / n) * 0.55);
    }
    add.stroke({ width: 1.8, color: c, alpha: 0.55 });
    add.moveTo(x, y - 9).lineTo(x + 7, y).lineTo(x, y + 9).lineTo(x - 7, y).closePath()
      .stroke({ width: 1.6, color: c, alpha: 0.8 + 0.2 * p });
  }

  private drawPortals(t: number, pad: Graphics, add: Graphics, host: RiftHost): void {
    const L = this.L!, v = this.view;
    const look = portalLook(L, v);
    // ---- Descend
    if (look.descend !== 'none') {
      const x = L.portalX, y = L.portalY;
      const open = look.descend !== 'closed', dep = look.descend === 'departing';
      if (open) publishPortal(x, y, dep ? 2 : 1, 0);
      if (host.inView(x, y, DESCEND_R + 80)) {
        if (!open) {
          dashed(add, x, y, 70, 12, 0.5, t * 0.1);
          add.stroke({ width: 2, color: PORTAL_COLOR, alpha: 0.2 });
          add.moveTo(x - 22, y - 12).lineTo(x, y + 14).lineTo(x + 22, y - 12).stroke({ width: 2.2, color: PORTAL_COLOR, alpha: 0.22 });
          dashed(add, x, y, DESCEND_R, 28, 0.3, -t * 0.05);
          add.stroke({ width: 1.2, color: PORTAL_COLOR, alpha: 0.07 });
        } else {
          const k = dep ? 1 : 0;
          const spin = 1.2 + 2.6 * k;
          this.glow.put(this.A.soft, x, y, 0, DESCEND_R / 26, DESCEND_R / 26, PORTAL_COLOR, 0.14 + 0.1 * k);
          this.glow.put(this.A.soft, x, y, 0, 2.2, 2.2, PORTAL_CORE, 0.5 + 0.2 * Math.sin(t * 6));
          pad.circle(x, y, 118).fill({ color: 0x000000, alpha: 0.35 });
          for (let ring = 0; ring < 4; ring++) {
            const rr = 34 + ring * 28;
            const rot = t * spin * (1 + ring * 0.35) * (ring % 2 ? -1 : 1) + ring;
            for (let j = 0; j < 3; j++) {
              const a0 = rot + (j * TAU) / 3;
              add.moveTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr).arc(x, y, rr, a0, a0 + 1.25);
            }
            add.stroke({ width: 3.2 - ring * 0.5, color: mix(PORTAL_CORE, PORTAL_COLOR, ring / 3), alpha: 0.85 - ring * 0.12 });
          }
          dashed(add, x, y, DESCEND_R, 32, 0.5, t * 0.15);
          add.stroke({ width: 2, color: PORTAL_COLOR, alpha: 0.35 + 0.3 * k });
          if (Math.random() < 0.5 + 0.4 * k) {
            const a = Math.random() * TAU, r0 = 150;
            host.spark(x + Math.cos(a) * r0, y + Math.sin(a) * r0, -Math.cos(a) * 260, -Math.sin(a) * 260, 0.5, PORTAL_CORE, 0.3);
          }
          let label = 'DESCEND';
          if (dep && v) {
            const left = this.depart.read(v.departIn, t);
            const f = this.departTotal > 0 ? clamp01(left / this.departTotal) : 0;
            add.circle(x, y, DESCEND_R + 12).stroke({ width: 4, color: 0xffffff, alpha: 0.1 });
            if (arcPath(add, x, y, DESCEND_R + 12, TOP, f * TAU)) add.stroke({ width: 4, color: PORTAL_CORE, alpha: 0.9 });
            label = `DESCENDING ${Math.max(0, Math.ceil(v.departIn))}`;
          }
          // below the ring, or above it when the Extract ring sits right below (boss floors: centre + 352 px)
          const exBelow = L.extractX >= 0 && L.extractY > y && Math.abs(L.extractX - x) < DESCEND_R && L.extractY - y < 420;
          host.label('rift:descend', 'world', label, x, exBelow ? y - DESCEND_R - 24 : y + DESCEND_R + 26, PORTAL_CORE, 0.7, 22);
        }
      }
    }
    // ---- Extract / Exit
    if (look.extract === 'open') {
      const x = L.extractX, y = L.extractY;
      publishPortal(x, y, 1, 1);
      if (host.inView(x, y, EXTRACT_R + 380)) {
        const p = 0.5 + 0.5 * Math.sin(t * 3);
        this.glow.put(this.A.beam, x, y - 180, 0, 1.2, 360 / 64, EXTRACT_COLOR, 0.3 + 0.1 * p);
        this.glow.put(this.A.soft, x, y, 0, EXTRACT_R / 30, EXTRACT_R / 30, EXTRACT_COLOR, 0.12 + 0.05 * p);
        pad.circle(x, y, EXTRACT_R).fill({ color: EXTRACT_COLOR, alpha: 0.04 });
        add.circle(x, y, EXTRACT_R).stroke({ width: 3, color: EXTRACT_COLOR, alpha: 0.75 });
        add.circle(x, y, EXTRACT_R).stroke({ width: 12, color: EXTRACT_COLOR, alpha: 0.06 });
        dashed(add, x, y, EXTRACT_R - 18, 18, 0.45, -t * 0.4);
        add.stroke({ width: 1.6, color: EXTRACT_COLOR, alpha: 0.45 });
        for (let i = 0; i < 6; i++) {
          const a = t * 0.9 + (i * TAU) / 6;
          add.circle(x + Math.cos(a) * EXTRACT_R, y + Math.sin(a) * EXTRACT_R, 4).fill({ color: 0xffffff, alpha: 0.85 });
        }
        let label: string = look.exitLabel;
        if (look.final && v && v.departIn > 0) {
          // final floor: the victory lap counts down on the exit ring
          const left = this.depart.read(v.departIn, t);
          const f = this.departTotal > 0 ? clamp01(left / this.departTotal) : 0;
          if (arcPath(add, x, y, EXTRACT_R + 14, TOP, f * TAU)) add.stroke({ width: 4, color: 0xffffff, alpha: 0.8 });
          label = `EXIT ${clockText(v.departIn)}`;
        }
        host.label('rift:extract', 'world', label, x, y + EXTRACT_R + 26, EXTRACT_COLOR, 0.75, 22);
      }
    }
  }

  private drawCracks(t: number, add: Graphics, host: RiftHost): void {
    let w = 0;
    for (let i = 0; i < this.cracks.length; i++) {
      const c = this.cracks[i];
      const age = t - c.t0;
      if (age > c.sec + 0.25) continue;
      this.cracks[w++] = c;
      if (!c.done && age >= c.sec) {
        c.done = true;
        host.burst(c.x, c.y, 18, SPAWN_COLOR, 60, 300, 0.45, 0.45);
        host.ring(c.x, c.y, c.radius * 0.3, c.radius * 1.2, 0.35, SPAWN_COLOR, 2.5);
      }
      if (!host.inView(c.x, c.y, c.radius + 40)) continue;
      const f = warnFrac(age, c.sec);
      const fade = age > c.sec ? 1 - (age - c.sec) / 0.25 : 1;
      this.glow.put(this.A.soft, c.x, c.y, 0, (c.radius / 30) * (0.4 + 0.6 * f), (c.radius / 30) * (0.4 + 0.6 * f), SPAWN_COLOR, (0.12 + 0.3 * f) * fade);
      const pulse = 0.5 + 0.5 * Math.sin(t * 18);
      dashed(add, c.x, c.y, c.radius, 12, 0.5, t * 1.5);
      add.stroke({ width: 1.6, color: SPAWN_COLOR, alpha: (0.25 + 0.35 * pulse) * fade });
      // cracks grow outward with the warning
      const upto = Math.max(1, Math.ceil(f * (CRACK_PTS - 1)));
      for (let k = 0; k < CRACKS_PER_WARN; k++) {
        const o = k * CRACK_PTS * 2;
        add.moveTo(c.pts[o], c.pts[o + 1]);
        for (let j = 1; j <= upto; j++) add.lineTo(c.pts[o + j * 2], c.pts[o + j * 2 + 1]);
      }
      add.stroke({ width: 2.2, color: SPAWN_COLOR, alpha: (0.35 + 0.55 * f) * fade });
      if (f > 0.6) {
        for (let k = 0; k < CRACKS_PER_WARN; k++) {
          const o = k * CRACK_PTS * 2;
          add.moveTo(c.pts[o], c.pts[o + 1]);
          for (let j = 1; j <= upto; j++) add.lineTo(c.pts[o + j * 2], c.pts[o + j * 2 + 1]);
        }
        add.stroke({ width: 0.9, color: 0xffffff, alpha: (f - 0.6) * 2 * fade });
      }
    }
    this.cracks.length = w;
  }

  private drawTelegraphs(t: number, pad: Graphics, add: Graphics, host: RiftHost): void {
    let w = 0;
    for (let i = 0; i < this.teles.length; i++) {
      const q = this.teles[i];
      const age = t - q.t0;
      if (age > q.sec + TELEGRAPH_STRIKE_SEC) continue;
      this.teles[w++] = q;
      const f = warnFrac(age, q.sec);
      const strike = age >= q.sec ? 1 - (age - q.sec) / TELEGRAPH_STRIKE_SEC : 0;
      if (age >= q.sec && !q.struck) {
        q.struck = true;
        host.flash(q.shape === 'line' ? q.x2 : q.x, q.shape === 'line' ? q.y2 : q.y, 1.6, TELEGRAPH_COLOR, 0.2, 0.7);
      }
      const blink = Math.floor(t * (6 + 14 * f)) % 2 ? 1 : 0.6;
      if (q.shape === 'line') {
        const dx = q.x2 - q.x, dy = q.y2 - q.y, len = Math.hypot(dx, dy);
        if (!(len > 1)) continue;
        const mx = (q.x + q.x2) / 2, my = (q.y + q.y2) / 2;
        if (!host.inView(mx, my, len / 2 + q.r + 40)) continue;
        const ux = dx / len, uy = dy / len, nx = -uy * q.r, ny = ux * q.r;
        lane(pad, q.x, q.y, q.x + dx * f, q.y + dy * f, nx, ny);
        pad.fill({ color: TELEGRAPH_COLOR, alpha: 0.14 + 0.1 * f });
        lane(add, q.x, q.y, q.x2, q.y2, nx, ny);
        add.stroke({ width: 2, color: TELEGRAPH_COLOR, alpha: 0.7 * blink });
        // chevrons sliding toward the far end
        const cw = Math.min(q.r * 0.8, 40);
        for (let u = (t * 420) % 90; u < len - cw; u += 90) {
          const bx = q.x + ux * u, by = q.y + uy * u;
          add.moveTo(bx + nx * 0.6, by + ny * 0.6).lineTo(bx + ux * cw, by + uy * cw).lineTo(bx - nx * 0.6, by - ny * 0.6);
        }
        add.stroke({ width: 2.4, color: brighten(TELEGRAPH_COLOR, 0.3), alpha: 0.55 * (0.4 + 0.6 * f) });
        if (strike > 0) {
          lane(add, q.x, q.y, q.x2, q.y2, nx, ny);
          add.fill({ color: brighten(TELEGRAPH_COLOR, 0.4), alpha: 0.45 * strike });
        }
      } else {
        if (!host.inView(q.x, q.y, q.r + 40)) continue;
        pad.circle(q.x, q.y, Math.max(1, q.r * f)).fill({ color: TELEGRAPH_COLOR, alpha: 0.14 + 0.1 * f });
        dashed(add, q.x, q.y, q.r, 24, 0.55, t * 0.8);
        add.stroke({ width: 2.2, color: TELEGRAPH_COLOR, alpha: 0.75 * blink });
        add.circle(q.x, q.y, Math.max(1, q.r * f)).stroke({ width: 1.6, color: brighten(TELEGRAPH_COLOR, 0.4), alpha: 0.6 });
        if (strike > 0) add.circle(q.x, q.y, q.r).fill({ color: brighten(TELEGRAPH_COLOR, 0.4), alpha: 0.4 * strike });
      }
    }
    this.teles.length = w;
  }

  // ------------------------------------------------------------------------------------------
  // after drawShips (fresh root alpha): extract channel arcs around every extracting ship

  drawShipFx(frame: RenderFrame, t: number, add: Graphics, host: RiftHost): void {
    const L = this.L, v = this.view;
    if (!L || !v || !v.extracting.length) return;
    const open = portalLook(L, v).extract === 'open';
    for (const e of v.extracting) {
      if (!(e.frac > 0)) continue;
      const sid = host.shipOfPlayer(e.playerId);
      const a = sid ? host.ship(sid) : null;
      if (!a || (!a.ally && a.alpha < 0.2)) continue; // root-alpha rule
      const f = clamp01(e.frac);
      const R = a.r + 18;
      add.circle(a.x, a.y, R).stroke({ width: 4, color: EXTRACT_COLOR, alpha: 0.14 * a.alpha });
      if (arcPath(add, a.x, a.y, R, TOP, f * TAU)) add.stroke({ width: 4, color: EXTRACT_COLOR, alpha: 0.95 * a.alpha });
      this.glow.put(this.A.soft, a.x, a.y, 0, (R / 26) * (0.8 + 0.4 * f), (R / 26) * (0.8 + 0.4 * f), EXTRACT_COLOR, (0.1 + 0.25 * f) * a.alpha);
      // the channel: a jagged arc from the exit's beam base to the ship, brighter as it completes
      const dx = a.x - L.extractX, dy = a.y - L.extractY, len = Math.hypot(dx, dy);
      if (open && len > a.r && host.inView((a.x + L.extractX) / 2, (a.y + L.extractY) / 2, 400)) {
        const sx = L.extractX, sy = L.extractY;
        const nx = -dy / len, ny = dx / len, n = Math.max(3, Math.min(8, Math.round(len / 30)));
        add.moveTo(sx, sy);
        for (let k = 1; k < n; k++) {
          const q = k / n, j = (Math.random() - 0.5) * 16 * (1 - f * 0.5);
          add.lineTo(sx + (a.x - sx) * q + nx * j, sy + (a.y - sy) * q + ny * j);
        }
        add.lineTo(a.x, a.y);
        add.stroke({ width: 1.4 + 1.6 * f, color: brighten(EXTRACT_COLOR, 0.4), alpha: (0.35 + 0.5 * f) * a.alpha });
      }
    }
    void frame; void t;
  }

  // ------------------------------------------------------------------------------------------
  // radar / big map (sx, sy = map px → radar px)

  drawRadar(frame: RenderFrame, g: Graphics, ox: number, oy: number, sx: number, sy: number, big: boolean, t: number): void {
    const L = this.L;
    if (!L) return;
    const lv = this.fogLevelsNow();
    const blink = Math.floor(t * 4) % 2 === 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    const k = big ? 1.6 : 1;
    // doors by state (seen / glimpsed rooms)
    for (const d of this.doors) {
      const lev = lv[d.room] ?? 0;
      if (!lev) continue;
      const st = this.states[d.room] ?? RIFT_DORMANT;
      const col = st === RIFT_SEALED ? SEAL_COLOR : st === RIFT_ARMING ? ARM_COLOR : st === RIFT_CLEARED ? CLEAR_COLOR : this.idleDoor;
      const al = (st === RIFT_ARMING ? (blink ? 1 : 0.4) : st === RIFT_SEALED ? 1 : 0.7) * (lev === 2 ? 1 : 0.4);
      const x0 = ox + d.x0 * sx, y0 = oy + d.y0 * sy, w = Math.max(1.4, (d.x1 - d.x0) * sx), h = Math.max(1.4, (d.y1 - d.y0) * sy);
      g.rect(x0, y0, w, h).fill({ color: col, alpha: al });
    }
    const v = this.view;
    // chests (seen rooms): ready = bright, locked = dim, opened = gone
    for (const room of L.rooms) {
      if (lv[room.idx] !== 2) continue;
      const st = this.states[room.idx] ?? RIFT_DORMANT;
      const mask = v ? (v.chests[room.idx] ?? 0) : 0;
      for (let c = 0; c * 2 + 1 < room.chests.length; c++) {
        const cs = chestState(room, c, st, mask);
        if (cs === 'opened') continue;
        const x = ox + room.chests[c * 2] * sx, y = oy + room.chests[c * 2 + 1] * sy, s = 1.6 * k;
        g.rect(x - s, y - s, s * 2, s * 2).fill({ color: RARITY_COLORS[chestRarity(room.kind)], alpha: cs === 'ready' ? 0.6 + 0.4 * pulse : 0.3 });
      }
    }
    // portals (once their room is at least glimpsed)
    const look = portalLook(L, v);
    const keyLev = lv[L.keyRoom] ?? 0;
    if (look.descend !== 'none' && keyLev) {
      const x = ox + L.portalX * sx, y = oy + L.portalY * sy;
      if (look.descend === 'closed') g.circle(x, y, 2.4 * k).stroke({ width: 1, color: PORTAL_COLOR, alpha: 0.5 });
      else {
        g.circle(x, y, 2.6 * k).fill({ color: PORTAL_CORE, alpha: look.descend === 'departing' && !blink ? 0.4 : 1 });
        g.circle(x, y, 4 * k + 2 * pulse).stroke({ width: 1.2, color: PORTAL_COLOR, alpha: 0.8 });
      }
    }
    if (look.extract === 'open') {
      const x = ox + L.extractX * sx, y = oy + L.extractY * sy;
      g.circle(x, y, 3.4 * k + 1.5 * pulse).stroke({ width: 1.4, color: EXTRACT_COLOR, alpha: 0.95 });
      g.circle(x, y, 1.4 * k).fill({ color: EXTRACT_COLOR, alpha: 1 });
    }
    // respawn anchor
    let ax = NaN, ay = NaN;
    if (v) { ax = v.anchors[this.party * 2]; ay = v.anchors[this.party * 2 + 1]; }
    if (Number.isFinite(ax) && Number.isFinite(ay)) {
      const x = ox + ax * sx, y = oy + ay * sy, d = 2.6 * k;
      g.moveTo(x, y - d).lineTo(x + d, y).lineTo(x, y + d).lineTo(x - d, y).closePath().stroke({ width: 1.2, color: this.partyColor(), alpha: 0.9 });
    }
    void frame;
  }

  // ------------------------------------------------------------------------------------------
  // events (rift events are global except spawnWarn / telegraph, which are positional)

  event(ev: GameEvent, t: number, host: RiftHost): void {
    switch (ev.t) {
      case 'telegraph': {
        if (this.teles.length >= MAX_TELEGRAPHS) this.teles.shift();
        this.teles.push({ shape: ev.shape, x: ev.x, y: ev.y, x2: ev.x2, y2: ev.y2, r: Math.max(8, ev.r), sec: Math.max(0.05, ev.sec), t0: t, struck: false });
        host.flash(ev.x, ev.y, 1, TELEGRAPH_COLOR, 0.15, 0.5);
        break;
      }
      case 'spawnWarn': {
        if (this.cracks.length >= MAX_CRACKS) this.cracks.shift();
        this.cracks.push({ x: ev.x, y: ev.y, radius: Math.max(20, ev.radius), sec: Math.max(0.05, ev.sec), t0: t, pts: crackPoints(ev.x, ev.y, Math.max(20, ev.radius)), done: false });
        break;
      }
      case 'roomSeal': {
        // timing only (the state diff draws the slam): an arming event carries the seconds until the seal
        if (ev.sec > 0) this.armT[ev.room] = t - Math.max(0, RIFT_ARM_SEC - ev.sec);
        break;
      }
      case 'roomClear': {
        host.ring(ev.x, ev.y, 30, 420, 0.8, CLEAR_COLOR, 4);
        host.ring(ev.x, ev.y, 10, 240, 0.6, 0xffffff, 1.6);
        host.burst(ev.x, ev.y, 30, CLEAR_COLOR, 100, 420, 0.7, 0.5, true);
        host.impulse(ev.x, ev.y, 480, 520);
        host.tint(CLEAR_COLOR, 0.07, 0.8);
        break;
      }
      case 'chestOpen': {
        const key = ev.room * 16 + ev.chest;
        if (!this.chestT.has(key)) {
          this.chestT.set(key, t);
          const room = this.L?.rooms[ev.room];
          if (room && ev.chest * 2 + 1 < room.chests.length) this.chestFx(room, ev.chest, host);
          else { host.burst(ev.x, ev.y, 20, 0xffffff, 80, 300, 0.5, 0.4, true); host.ring(ev.x, ev.y, 8, 100, 0.5, 0xffffff, 3); }
        }
        break;
      }
      case 'bossIntro': {
        this.introT.set(ev.id, t);
        host.ring(ev.x, ev.y, 40, 900, 1.2, 0xff8fc8, 6);
        host.ring(ev.x, ev.y, 20, 520, 0.9, 0xffffff, 2);
        host.burst(ev.x, ev.y, 50, 0xff8fc8, 150, 600, 0.9, 0.6);
        host.shake(0.9, ev.x, ev.y);
        host.shock(ev.x, ev.y);
        host.impulse(ev.x, ev.y, 900, 1200);
        host.tint(0xff2bd1, 0.2, 0.45);
        break;
      }
      case 'bossPhase': {
        host.ring(ev.x, ev.y, 30, 600, 0.8, ev.phase >= 3 ? 0xff5050 : 0xff2bd1, 5);
        host.burst(ev.x, ev.y, 36, ev.phase >= 3 ? 0xff7070 : 0xff2bd1, 120, 520, 0.7, 0.55);
        host.shake(0.45, ev.x, ev.y);
        host.impulse(ev.x, ev.y, 700, 900);
        host.tint(ev.phase >= 3 ? 0xff3040 : 0xff2bd1, 0.12, 0.6);
        break;
      }
      case 'portalOpen': {
        const c = ev.extract ? EXTRACT_COLOR : PORTAL_CORE;
        host.ring(ev.x, ev.y, 10, 320, 0.8, c, 4);
        host.ring(ev.x, ev.y, 200, 20, 0.6, ev.extract ? 0xffffff : PORTAL_COLOR, 2.5);
        host.burst(ev.x, ev.y, 34, c, 100, 460, 0.7, 0.5, true);
        host.flash(ev.x, ev.y, 3.4, c, 0.35, 0.8);
        host.impulse(ev.x, ev.y, 420, -600);
        break;
      }
      case 'departing': {
        const L = this.L;
        if (L && L.portalX >= 0) { host.ring(L.portalX, L.portalY, DESCEND_R, 30, 0.6, PORTAL_CORE, 3); host.flash(L.portalX, L.portalY, 3, PORTAL_CORE, 0.3, 0.7); }
        break;
      }
      case 'extract': {
        host.ring(ev.x, ev.y, 10, 260, 0.7, EXTRACT_COLOR, 4);
        host.ring(ev.x, ev.y, 80, 6, 0.5, 0xffffff, 2);
        host.burst(ev.x, ev.y, 40, EXTRACT_COLOR, 120, 520, 0.8, 0.55, true);
        for (let i = 0; i < 14; i++) host.spark(ev.x + (Math.random() - 0.5) * 30, ev.y, (Math.random() - 0.5) * 60, -300 - Math.random() * 400, 0.8, brighten(EXTRACT_COLOR, 0.4), 0.45);
        host.flash(ev.x, ev.y, 3, EXTRACT_COLOR, 0.35, 0.9);
        break;
      }
      case 'outOfLives':
        host.ring(ev.x, ev.y, 90, 10, 0.7, GREY, 3);
        host.burst(ev.x, ev.y, 12, GREY, 30, 140, 0.8, 0.4, true);
        break;
      case 'partyWiped': host.tint(0x600010, 0.35, 0.25); break;
      case 'instability': host.tint(0xff9a2a, 0.12, 0.5); break;
      case 'riftEnd':
        host.tint(ev.outcome === 'cleared' || ev.outcome === 'extracted' ? EXTRACT_COLOR : 0x404050, 0.2, 0.35);
        break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// drawing helpers
// ---------------------------------------------------------------------------------------------

const tmpA: number[] = [0, 0];
const tmpB: number[] = [0, 0];

/** n dashes of `duty` around a circle, rotated by rot (caller strokes). */
function dashed(g: Graphics, x: number, y: number, r: number, n: number, duty: number, rot: number): void {
  const step = TAU / n, len = step * duty;
  for (let i = 0; i < n; i++) {
    const a0 = rot + i * step;
    g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a0 + len);
  }
}
function arcPath(g: Graphics, x: number, y: number, r: number, a0: number, span: number): boolean {
  if (!(span > 1e-3)) return false;
  g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a0 + Math.min(TAU, span));
  return true;
}
/** Closed lane quad from (x0, y0) to (x1, y1), half-width vector (nx, ny). */
function lane(g: Graphics, x0: number, y0: number, x1: number, y1: number, nx: number, ny: number): void {
  g.moveTo(x0 + nx, y0 + ny).lineTo(x1 + nx, y1 + ny).lineTo(x1 - nx, y1 - ny).lineTo(x0 - nx, y0 - ny).closePath();
}

/** Deterministic crack polylines for a spawnWarn at (x, y): CRACKS_PER_WARN × CRACK_PTS points, flat. */
export function crackPoints(x: number, y: number, radius: number): number[] {
  let s = ((Math.round(x) * 73856093) ^ (Math.round(y) * 19349663)) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts: number[] = [];
  for (let k = 0; k < CRACKS_PER_WARN; k++) {
    let a = (k / CRACKS_PER_WARN) * TAU + (rnd() - 0.5) * 0.6;
    const L = radius * (0.75 + 0.45 * rnd());
    let px = x, py = y;
    pts.push(px, py);
    for (let j = 1; j < CRACK_PTS; j++) {
      a += (rnd() - 0.5) * 0.9;
      const seg = L / (CRACK_PTS - 1);
      px += Math.cos(a) * seg; py += Math.sin(a) * seg;
      pts.push(px, py);
    }
  }
  return pts;
}
