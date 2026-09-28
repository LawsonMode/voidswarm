// Render demo (RENDER agent, v0.3 M4): a fake rift floor + a scripted RiftView, so every rift state shows up within
// seconds. Not a sim: it only produces the map (map.dungeon), MatchView.dungeon, rift events and the Matriarch the
// renderer and audio consume. R cycles the floors (each one goes through renderer.setMap, exercising the re-entrant
// floorStart path).
//   Layout (the same on every floor; biome and boss room change): entrance (W) → ARENA (centre, the showcase fights
//   here) → hall (E) → key / boss room (SE); a treasure branch N of the arena; a second arena S of the entrance.
//   ARENA (26 s loop)  dormant → ARMING 1.5 s → SEALED (spawn cracks + pulses at its markers) → CLEARED (anchor moves,
//                      the reward chest unlocks; a bot opens it 3 s later) → demo reset.
//   South arena (14 s) dormant → ARMING → SEALED → regroup reset (roomReset).
//   Key room           seals at 8 s, clears at 20 s → Descend opens. Boss floors: the Matriarch (intro shield, three
//                      phases on a 50 s HP ramp, ring telegraphs, P3 dash lanes + dashes) → Descend + Extract open.
//                      Final floor (F6): only EXIT opens, with the 45 s victory lap on its ring.
//   You: rooms you enter are seen (minimap fog), chests open at 48 px, the Descend zone departs in 5 s (→ the next
//   floor), the Extract zone channels in 3 s.
// Keys (demo.ts): R floors · T descend now · Y boss telegraph · U spawn cracks at the cursor · I instability.
import { MAP_SIZE, MAP_TILE } from '../../shared/constants';
import {
  RIFT_ARMING, RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_BASE, TILE_DOOR, TILE_EMPTY, TILE_ROCK, TILE_WALL,
  type EnemyKind, type EnemyView, type GameEvent, type GameMap, type MatchView, type RiftBiome, type RiftDoor,
  type RiftLayout, type RiftRoom, type RiftRoomKind, type RiftView, type ShipView, type TeamId,
} from '../../shared/types';
import { CHEST_REACH, DESCEND_R, EXTRACT_R, RIFT_ARM_SEC, roomIndexAt } from './rift';

export const RIFT_PRESETS: readonly { floor: number; biome: RiftBiome }[] = [
  { floor: 1, biome: 'hive' }, { floor: 3, biome: 'hive' }, { floor: 4, biome: 'prism' }, { floor: 6, biome: 'prism' },
];
export const RIFT_MODES = ['off', ...RIFT_PRESETS.map((p) => `F${p.floor} ${p.biome}${p.floor % 3 === 0 ? ' boss' : ''}`)] as const;
const FLOORS_TOTAL = 6;
/** Demo speeds (the sim's are 20 s / 3 s departure, 45 s victory lap, 1/180 per tick channel). */
const DEMO_DEPART_SEC = 5, DEMO_EXTRACT_SEC = 3, DEMO_VICTORY_SEC = 45, BOSS_FIGHT_SEC = 50;
const BOSS_RADIUS = 88;

export interface RiftDemoWorld {
  me: ShipView;
  ships: ShipView[];
  byId: Map<number, ShipView>;
  events: GameEvent[];
  enemies: EnemyView[];
  /** Adds an enemy of `kind` to `enemies` (anywhere) and returns it; the rift demo re-homes it into a room. */
  spawn(kind: EnemyKind): EnemyView;
}

interface RoomSpec { kind: RiftRoomKind; cc: number; cr: number; size: number }
interface CorrSpec { a: number; b: number; alongX: boolean; lo: number; hi: number; at: number }

// Room centres / sizes in tiles (interior), corridors 5 wide. Index = room idx.
const ROOMS: RoomSpec[] = [
  { kind: 'entrance', cc: 40, cr: 100, size: 22 },
  { kind: 'arena', cc: 100, cr: 100, size: 40 },
  { kind: 'treasure', cc: 100, cr: 44, size: 18 },
  { kind: 'hall', cc: 160, cr: 100, size: 26 },
  { kind: 'key', cc: 160, cr: 158, size: 44 },
  { kind: 'arena', cc: 40, cr: 158, size: 34 },
];
const LINKS: number[][] = [[1, 5], [0, 2, 3], [1], [1, 4], [3], [0]];
const DEPTH = [0, 1, 2, 2, 3, 1];
const MAIN = [true, true, false, true, true, false];
/** Corridors: along x at row band `at` (tiles at..at+4) from col lo to hi, or along y at col band `at`. */
const CORRS: CorrSpec[] = [
  { a: 0, b: 1, alongX: true, at: 98, lo: 51, hi: 80 },
  { a: 1, b: 2, alongX: false, at: 98, lo: 53, hi: 80 },
  { a: 1, b: 3, alongX: true, at: 98, lo: 120, hi: 147 },
  { a: 3, b: 4, alongX: false, at: 158, lo: 113, hi: 136 },
  { a: 0, b: 5, alongX: false, at: 38, lo: 111, hi: 141 },
];

const sealable = (k: RiftRoomKind) => k === 'arena' || k === 'key' || k === 'boss';

/** A fake rift floor on the full 200×200 grid (deterministic; hand-placed, not floorgen). */
export function buildDemoFloor(floor: number, biome: RiftBiome): GameMap {
  const ts = MAP_TILE, cols = MAP_SIZE / ts, rows = MAP_SIZE / ts;
  const tiles = new Uint8Array(cols * rows).fill(TILE_ROCK);
  const set = (c: number, r: number, v: number) => { if (c >= 0 && r >= 0 && c < cols && r < rows) tiles[r * cols + c] = v; };
  const get = (c: number, r: number) => (c >= 0 && r >= 0 && c < cols && r < rows ? tiles[r * cols + c] : TILE_ROCK);
  const boss = floor % 3 === 0;
  const specs = ROOMS.map((s, i) => (i === 4 && boss ? { ...s, kind: 'boss' as RiftRoomKind, size: 46 } : s));
  const rects = specs.map((s) => {
    const c0 = s.cc - Math.floor(s.size / 2), r0 = s.cr - Math.floor(s.size / 2);
    return { c0, r0, c1: c0 + s.size, r1: r0 + s.size };
  });
  // rims + interiors
  rects.forEach((q, i) => {
    for (let r = q.r0 - 2; r < q.r1 + 2; r++) for (let c = q.c0 - 2; c < q.c1 + 2; c++) set(c, r, TILE_WALL);
    for (let r = q.r0; r < q.r1; r++) for (let c = q.c0; c < q.c1; c++) set(c, r, specs[i].kind === 'entrance' ? TILE_BASE : TILE_EMPTY);
  });
  // corridors: open floor; crossing a sealable rim = door tiles; rock beside a corridor = wall
  const doorTiles: number[][] = specs.map(() => []);
  const inRim = (i: number, c: number, r: number) => {
    const q = rects[i];
    return c >= q.c0 - 2 && c < q.c1 + 2 && r >= q.r0 - 2 && r < q.r1 + 2 && !(c >= q.c0 && c < q.c1 && r >= q.r0 && r < q.r1);
  };
  for (const k of CORRS) {
    for (let u = k.lo; u < k.hi; u++) for (let w = k.at; w < k.at + 5; w++) {
      const c = k.alongX ? u : w, r = k.alongX ? w : u;
      let door = -1;
      for (const i of [k.a, k.b]) if (inRim(i, c, r) && sealable(specs[i].kind)) door = i;
      set(c, r, door >= 0 ? TILE_DOOR : TILE_EMPTY);
      if (door >= 0) doorTiles[door].push(r * cols + c);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (get(c, r) !== TILE_ROCK) continue;
    let near = false;
    for (let dr = -1; dr <= 1 && !near; dr++) for (let dc = -1; dc <= 1; dc++) {
      const t = get(c + dc, r + dr);
      if (t === TILE_EMPTY || t === TILE_DOOR) { near = true; break; }
    }
    if (near) set(c, r, TILE_WALL);
  }
  // pillars: hive = round rock, prism = 3×3 wall squares (≥ 7 tiles from the centre)
  const pillar = (pc: number, pr: number) => {
    if (biome === 'hive') {
      for (let r = pr - 3; r <= pr + 3; r++) for (let c = pc - 3; c <= pc + 3; c++) if (Math.hypot(c - pc, r - pr) <= 2.2) set(c, r, TILE_ROCK);
    } else for (let r = pr - 1; r <= pr + 1; r++) for (let c = pc - 1; c <= pc + 1; c++) set(c, r, TILE_WALL);
  };
  for (const [dc, dr] of [[-11, -11], [11, -11], [-11, 11], [11, 11]]) pillar(100 + dc, 100 + dr);
  pillar(154, 93); pillar(166, 107);
  const kc = specs[4].cc, kr = specs[4].cr;
  for (const [dc, dr] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) pillar(kc + dc, kr + dr);
  for (const [dc, dr] of [[-9, 0], [9, 0]]) pillar(specs[5].cc + dc, specs[5].cr + dr);

  // layout
  const rooms: RiftRoom[] = specs.map((s, i) => {
    const q = rects[i];
    const x = ((q.c0 + q.c1) / 2) * ts, y = ((q.r0 + q.r1) / 2) * ts, half = (s.size / 2) * ts;
    const doors: RiftDoor[] = [];
    if (sealable(s.kind) && doorTiles[i].length) {
      // one door per corridor crossing: group the tiles by the corridor they belong to
      const groups = new Map<number, number[]>();
      for (const t of doorTiles[i]) {
        const c = t % cols, r = (t - c) / cols;
        const key = CORRS.findIndex((k) => (k.a === i || k.b === i) && (k.alongX ? r >= k.at && r < k.at + 5 && c >= k.lo && c < k.hi : c >= k.at && c < k.at + 5 && r >= k.lo && r < k.hi));
        let g = groups.get(key); if (!g) groups.set(key, (g = []));
        g.push(t);
      }
      for (const g of groups.values()) {
        let sx = 0, sy = 0;
        for (const t of g) { const c = t % cols; sx += c + 0.5; sy += (t - c) / cols + 0.5; }
        const dcx = (sx / g.length) * ts, dcy = (sy / g.length) * ts;
        const dx = x - dcx, dy = y - dcy, len = Math.hypot(dx, dy) || 1;
        // the in-point: 3 tiles inside the interior along the corridor axis
        const horiz = Math.abs(dx) > Math.abs(dy);
        const inX = horiz ? (dx > 0 ? q.c0 + 3 : q.c1 - 3) * ts : dcx, inY = horiz ? dcy : (dy > 0 ? q.r0 + 3 : q.r1 - 3) * ts;
        void len;
        doors.push({ tiles: g, inX, inY });
      }
    }
    const spawns: number[] = [];
    const nSp = sealable(s.kind) ? 8 : s.kind === 'hall' ? 4 : s.kind === 'treasure' ? 3 : 0;
    for (let k = 0; k < nSp; k++) { const a = (k / nSp) * Math.PI * 2 + Math.PI / 8; spawns.push(x + Math.cos(a) * half * 0.72, y + Math.sin(a) * half * 0.72); }
    const chests: number[] = [];
    if (s.kind === 'arena' || s.kind === 'key') chests.push(x, y + 128);
    if (s.kind === 'treasure') chests.push(x - half * 0.4, y, x + half * 0.4, y);
    return { idx: i, kind: s.kind, ...q, x, y, doors, spawns, chests, links: LINKS[i], depth: DEPTH[i], mainPath: MAIN[i], party: s.kind === 'entrance' ? 0 : -1 };
  });
  const key = rooms[4];
  const dungeon: RiftLayout = {
    floor, biome, bossFloor: boss, rooms, entrances: [0], keyRoom: 4,
    portalX: key.x, portalY: key.y,
    // the key door is on the north rim, so Extract sits 352 px to the south
    extractX: boss ? key.x : -1, extractY: boss ? key.y + 352 : -1,
  };
  const e = rooms[0];
  const spawns = Array.from({ length: 6 }, (_, k) => ({ team: 0 as TeamId, x: e.x + Math.cos((k / 6) * Math.PI * 2) * 110, y: e.y + Math.sin((k / 6) * Math.PI * 2) * 110 }));
  return { seed: 4242 + floor, teamCount: 1, width: MAP_SIZE, height: MAP_SIZE, tileSize: ts, cols, rows, tiles, spawns, dungeon, rev: 0 };
}

// =============================================================================================

export class RiftDemo {
  mode = 0;
  map: GameMap | null = null;
  private L: RiftLayout | null = null;
  private mt = 0;
  private pc = 0;
  private rooms: number[] = [];
  private chests: number[] = [];
  private seen = 1;
  private anchor: [number, number] = [0, 0];
  private portal: 0 | 1 | 2 = 0;
  private departIn = 0;
  private extractOpen = false;
  private extract = 0;
  private victoryIn = 0;
  private lives = 6;
  private ended = false;
  private boss: EnemyView | null = null;
  private bossHp = 1;
  private bossPhase = 1;
  private bossDash = 0;
  private bossDashV = { x: 0, y: 0 };
  private nextTele = 0;
  private homes = new Map<number, number>();
  private pulses: { at: number; room: number; x: number; y: number }[] = [];
  private savedTeams = new Map<number, TeamId>();
  private savedEnemies: EnemyView[] | null = null;
  private savedPos: { x: number; y: number } | null = null;
  readonly log: string[] = [];

  get active(): boolean { return this.mode > 0 && !!this.L; }
  get label(): string { return RIFT_MODES[this.mode] ?? 'off'; }

  /** Switch floor preset (0 = off). Returns the map for renderer.setMap. */
  setMode(mode: number, base: GameMap, w: RiftDemoWorld): GameMap {
    const m = ((mode % RIFT_MODES.length) + RIFT_MODES.length) % RIFT_MODES.length;
    if (m === 0) { this.leave(w); this.mode = 0; return base; }
    const wasOn = this.mode > 0;
    this.mode = m;
    if (!wasOn) {
      this.savedPos = { x: w.me.x, y: w.me.y };
      for (const s of w.ships) { this.savedTeams.set(s.id, s.team); s.team = 0; }
      this.savedEnemies = w.enemies.splice(0);
    }
    return this.enterFloor(w);
  }

  private leave(w: RiftDemoWorld): void {
    if (this.mode === 0) return;
    for (const s of w.ships) { const t = this.savedTeams.get(s.id); if (t !== undefined) s.team = t; }
    this.savedTeams.clear();
    w.enemies.length = 0;
    if (this.savedEnemies) w.enemies.push(...this.savedEnemies);
    this.savedEnemies = null;
    if (this.savedPos) { w.me.x = this.savedPos.x; w.me.y = this.savedPos.y; }
    this.map = null; this.L = null; this.boss = null;
  }

  /** The Descend flow: the next preset (floorStart event + a fresh map). */
  descend(w: RiftDemoWorld): GameMap | null {
    if (!this.active) return null;
    this.mode = (this.mode % RIFT_PRESETS.length) + 1;
    return this.enterFloor(w);
  }

  private enterFloor(w: RiftDemoWorld): GameMap {
    const p = RIFT_PRESETS[this.mode - 1];
    const map = buildDemoFloor(p.floor, p.biome);
    this.map = map; this.L = map.dungeon!;
    const L = this.L;
    this.mt = 0; this.pc = 0;
    this.rooms = L.rooms.map(() => RIFT_DORMANT);
    this.chests = L.rooms.map(() => 0);
    this.seen = 1 << L.entrances[0];
    this.rooms[L.entrances[0]] = RIFT_CLEARED;
    const e = L.rooms[L.entrances[0]];
    this.anchor = [e.x, e.y];
    this.portal = 0; this.departIn = 0; this.extractOpen = false; this.extract = 0; this.victoryIn = 0; this.ended = false;
    this.boss = null; this.bossHp = 1; this.bossPhase = 1; this.bossDash = 0; this.nextTele = 0;
    this.pulses = [];
    this.homes.clear();
    w.enemies.length = 0;
    // dormant packs / guards in the halls, the treasure room and the south arena
    const fill = (room: number, kinds: EnemyKind[]) => { for (const k of kinds) this.place(w.spawn(k), room, true); };
    fill(3, ['drone', 'drone', 'dart', 'weaver', 'drone', 'spinner']);
    fill(2, ['weaver', 'weaver', 'weaver', 'spinner']);
    fill(5, ['drone', 'dart', 'splitter', 'drone', 'weaver', 'drone']);
    fill(1, ['drone', 'drone', 'dart', 'dart', 'weaver', 'splitter', 'spinner', 'drone', 'weaver', 'brute']);
    if (!L.bossFloor) fill(4, ['brute', 'drone', 'drone', 'weaver', 'dart', 'spinner']);
    w.me.x = e.x; w.me.y = e.y; w.me.vx = 0; w.me.vy = 0;
    w.events.push({ t: 'floorStart', floor: L.floor });
    this.note(`floor ${L.floor} · ${L.biome}${L.bossFloor ? ' · boss' : ''}`);
    return map;
  }

  private place(e: EnemyView, room: number, random: boolean): void {
    const q = this.L!.rooms[room];
    this.homes.set(e.id, room);
    if (random) {
      const ts = MAP_TILE;
      e.x = (q.c0 + 2 + Math.random() * (q.c1 - q.c0 - 4)) * ts;
      e.y = (q.r0 + 2 + Math.random() * (q.r1 - q.r0 - 4)) * ts;
    }
  }

  private note(s: string): void { this.log.unshift(s); if (this.log.length > 4) this.log.length = 4; }

  /** Crossed `a` (seconds into a `period` loop; period 0 = no loop) since the last step. */
  private crossed(a: number, period = 0): boolean {
    if (!period) return this.pc < a && this.mt >= a;
    const c = this.mt % period, p = this.pc % period;
    return c >= p ? p < a && c >= a : p < a || c >= a;
  }

  private setRoom(w: RiftDemoWorld, i: number, s: number): void {
    const L = this.L!, room = L.rooms[i], prev = this.rooms[i];
    if (prev === s) return;
    this.rooms[i] = s;
    if (s === RIFT_ARMING) w.events.push({ t: 'roomSeal', room: i, team: 0, sec: RIFT_ARM_SEC });
    else if (s === RIFT_SEALED) w.events.push({ t: 'roomSeal', room: i, team: 0, sec: 0 });
    else if (s === RIFT_CLEARED && (prev === RIFT_SEALED || prev === RIFT_ARMING)) {
      w.events.push({ t: 'roomClear', room: i, team: 0, x: room.x, y: room.y });
      this.anchor = [room.x, room.y - 120];
    } else if (s === RIFT_DORMANT && prev === RIFT_SEALED) w.events.push({ t: 'roomReset', room: i, team: 0 });
    this.note(`room ${i} (${room.kind}) → ${['dormant', 'arming', 'sealed', 'cleared'][s]}`);
  }

  /** One encounter pulse: cracks at 3 markers, enemies 0.8 s later. */
  private pulse(w: RiftDemoWorld, i: number): void {
    const room = this.L!.rooms[i];
    const n = room.spawns.length / 2;
    if (!n) return;
    for (let k = 0; k < 3; k++) {
      const m = Math.floor(Math.random() * n);
      const x = room.spawns[m * 2], y = room.spawns[m * 2 + 1];
      w.events.push({ t: 'spawnWarn', x, y, radius: 90, sec: 0.8 });
      this.pulses.push({ at: this.mt + 0.8, room: i, x, y });
    }
  }

  // =============================================================================================

  step(dt: number, w: RiftDemoWorld): void {
    if (!this.active) return;
    const L = this.L!, me = w.me;
    this.mt += dt;
    // seen + visits (non-sealable rooms clear on the first entry)
    const here = roomIndexAt(L, MAP_TILE, me.x, me.y);
    if (here >= 0) {
      this.seen |= 1 << here;
      const room = L.rooms[here];
      if (!room.doors.length && this.rooms[here] === RIFT_DORMANT) this.rooms[here] = RIFT_CLEARED;
    }
    // ---- central arena (26 s loop)
    const a = this.mt % 26;
    if (this.crossed(3, 26)) this.setRoom(w, 1, RIFT_ARMING);
    if (this.crossed(4.5, 26)) this.setRoom(w, 1, RIFT_SEALED);
    for (const at of [6, 9.5, 13]) if (this.crossed(at, 26)) this.pulse(w, 1);
    if (this.crossed(18, 26)) this.setRoom(w, 1, RIFT_CLEARED);
    if (this.crossed(21, 26) && !(this.chests[1] & 1)) {
      const room = L.rooms[1], bot = w.byId.get(2);
      this.chests[1] |= 1;
      w.events.push({ t: 'chestOpen', room: 1, chest: 0, playerId: bot?.playerId ?? 2, team: 0, x: room.chests[0], y: room.chests[1] });
    }
    if (this.crossed(25.9, 26)) { // demo loop: the room (and its chest) re-arm; the anchor goes home
      this.rooms[1] = RIFT_DORMANT; this.chests[1] = 0;
      const e = L.rooms[L.entrances[0]]; this.anchor = [e.x, e.y];
    }
    void a;
    // ---- south arena (14 s loop): arming → sealed → regroup reset
    if (this.crossed(2, 14)) this.setRoom(w, 5, RIFT_ARMING);
    if (this.crossed(3.5, 14)) this.setRoom(w, 5, RIFT_SEALED);
    if (this.crossed(6, 14)) this.pulse(w, 5);
    if (this.crossed(9.5, 14)) this.setRoom(w, 5, RIFT_DORMANT);
    // ---- key / boss room
    if (L.bossFloor) this.stepBoss(dt, w);
    else {
      if (this.crossed(8)) this.setRoom(w, 4, RIFT_ARMING);
      if (this.crossed(9.5)) this.setRoom(w, 4, RIFT_SEALED);
      for (const at of [11, 14.5]) if (this.crossed(at)) this.pulse(w, 4);
      if (this.crossed(20)) {
        this.setRoom(w, 4, RIFT_CLEARED);
        this.portal = 1;
        w.events.push({ t: 'portalOpen', x: L.portalX, y: L.portalY, extract: false });
      }
    }
    // ---- pulses land
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      if (this.mt < p.at) continue;
      this.pulses.splice(i, 1);
      if (w.enemies.length > 80) continue;
      for (let k = 0; k < 3; k++) {
        const e = w.spawn((['drone', 'dart', 'weaver', 'splitter'] as EnemyKind[])[k % 4]);
        this.place(e, p.room, false);
        e.x = p.x + (Math.random() - 0.5) * 60; e.y = p.y + (Math.random() - 0.5) * 60;
      }
    }
    // ---- chests (48 px; reward / key chests only once cleared)
    for (const room of L.rooms) {
      for (let k = 0; k * 2 + 1 < room.chests.length; k++) {
        if ((this.chests[room.idx] >> k) & 1) continue;
        if (!(room.kind === 'treasure' || this.rooms[room.idx] === RIFT_CLEARED)) continue;
        const x = room.chests[k * 2], y = room.chests[k * 2 + 1];
        if (Math.hypot(me.x - x, me.y - y) > CHEST_REACH + 20) continue;
        this.chests[room.idx] |= 1 << k;
        w.events.push({ t: 'chestOpen', room: room.idx, chest: k, playerId: me.playerId, team: 0, x, y });
      }
    }
    // ---- Descend: stand in the zone → departing → the next floor
    const final = L.floor >= FLOORS_TOTAL;
    if (this.portal === 1 && !final && Math.hypot(me.x - L.portalX, me.y - L.portalY) < DESCEND_R) {
      this.portal = 2; this.departIn = DEMO_DEPART_SEC;
      w.events.push({ t: 'departing', sec: DEMO_DEPART_SEC, team: 0 });
    }
    if (this.portal === 2) {
      this.departIn -= dt;
      if (this.departIn <= 0) { this.departIn = 0; this.pendingDescend = true; }
    }
    // ---- Extract: 3 s channel in the zone, decays twice as fast outside
    if (this.extractOpen) {
      const inside = Math.hypot(me.x - L.extractX, me.y - L.extractY) < EXTRACT_R;
      this.extract = inside ? this.extract + dt / DEMO_EXTRACT_SEC : Math.max(0, this.extract - (2 * dt) / DEMO_EXTRACT_SEC);
      if (this.extract >= 1) {
        this.extract = 0;
        w.events.push({ t: 'extract', playerId: me.playerId, x: me.x, y: me.y });
        this.note('you extracted (demo: channel again)');
      }
    }
    // ---- final floor victory lap
    if (this.victoryIn > 0) {
      this.victoryIn -= dt;
      if (this.victoryIn <= 0 && !this.ended) { this.victoryIn = 0; this.ended = true; w.events.push({ t: 'riftEnd', outcome: 'cleared' }); this.note('RIFT CONQUERED'); }
    }
    // ---- keep every enemy in its room (the demo's enemies chase you through walls otherwise)
    for (const e of w.enemies) {
      if (e === this.boss) continue;
      let h = this.homes.get(e.id);
      if (h === undefined) {
        const at = roomIndexAt(L, MAP_TILE, e.x, e.y);
        h = at > 0 ? at : 1;
        this.place(e, h, at <= 0);
      }
      const q = L.rooms[h], ts = MAP_TILE, m = e.radius + 8;
      e.x = Math.max(q.c0 * ts + m, Math.min(q.c1 * ts - m, e.x));
      e.y = Math.max(q.r0 * ts + m, Math.min(q.r1 * ts - m, e.y));
    }
    this.pc = this.mt;
  }

  /** Set once the departure countdown ends: demo.ts swaps the floor (renderer.setMap) on the next frame. */
  pendingDescend = false;

  private stepBoss(dt: number, w: RiftDemoWorld): void {
    const L = this.L!, room = L.rooms[L.keyRoom];
    if (this.crossed(2)) this.setRoom(w, L.keyRoom, RIFT_ARMING);
    if (this.crossed(3.5)) this.setRoom(w, L.keyRoom, RIFT_SEALED);
    if (this.crossed(4) && !this.boss) {
      const b = w.spawn('matriarch');
      b.x = room.x; b.y = room.y - 120; b.radius = BOSS_RADIUS; b.hpFrac = 1; b.elite = false;
      this.boss = b; this.bossHp = 1; this.bossPhase = 1; this.nextTele = this.mt + 5;
      w.events.push({ t: 'bossIntro', id: b.id, kind: 'matriarch', x: b.x, y: b.y });
      this.note('The Hive Matriarch awakens!');
    }
    const b = this.boss;
    if (!b) return;
    if (this.mt >= 7) this.bossHp = Math.max(0, this.bossHp - dt / BOSS_FIGHT_SEC); // 3 s intro (immune), then the ramp
    b.hpFrac = this.bossHp;
    const ph = this.bossHp > 0.66 ? 1 : this.bossHp > 0.33 ? 2 : 3;
    if (ph !== this.bossPhase) {
      this.bossPhase = ph;
      w.events.push({ t: 'bossPhase', id: b.id, kind: 'matriarch', phase: ph, x: b.x, y: b.y });
      this.note(`Matriarch phase ${ph}`);
    }
    // movement: a slow drift around the room centre, or a telegraphed dash (P3)
    if (this.bossDash > 0) {
      this.bossDash -= dt;
      b.x += this.bossDashV.x * dt; b.y += this.bossDashV.y * dt;
      b.angle = Math.atan2(this.bossDashV.y, this.bossDashV.x);
    } else {
      const tx = room.x + Math.cos(this.mt * 0.3) * 260, ty = room.y + Math.sin(this.mt * 0.45) * 200;
      const dx = tx - b.x, dy = ty - b.y;
      b.x += dx * Math.min(1, dt * 0.8); b.y += dy * Math.min(1, dt * 0.8);
      const me = w.me;
      b.angle = Math.atan2(me.y - b.y, me.x - b.x);
    }
    const ts = MAP_TILE, m = BOSS_RADIUS + 10;
    b.x = Math.max(room.c0 * ts + m, Math.min(room.c1 * ts - m, b.x));
    b.y = Math.max(room.r0 * ts + m, Math.min(room.r1 * ts - m, b.y));
    // telegraphs: rings (P1/P2), dash lanes (P3)
    if (this.bossHp > 0 && this.mt >= this.nextTele) {
      if (ph >= 3) { this.telegraphDash(w); this.nextTele = this.mt + 4; }
      else { w.events.push({ t: 'telegraph', shape: 'ring', x: b.x, y: b.y, x2: b.x, y2: b.y, r: 300, sec: 1 }); this.nextTele = this.mt + (ph === 2 ? 4 : 6); }
    }
    // death → portals
    if (this.bossHp <= 0) {
      w.events.push({ t: 'enemyDeath', id: b.id, kind: 'matriarch', x: b.x, y: b.y, elite: false });
      const i = w.enemies.indexOf(b); if (i >= 0) w.enemies.splice(i, 1);
      this.boss = null;
      this.setRoom(w, L.keyRoom, RIFT_CLEARED);
      this.lives = Math.min(12, this.lives + 2);
      const final = L.floor >= FLOORS_TOTAL;
      if (!final) { this.portal = 1; w.events.push({ t: 'portalOpen', x: L.portalX, y: L.portalY, extract: false }); }
      else this.victoryIn = DEMO_VICTORY_SEC;
      this.extractOpen = true;
      w.events.push({ t: 'portalOpen', x: L.extractX, y: L.extractY, extract: true });
      this.note(final ? 'EXIT open — victory lap' : 'Descend + Extract open');
    }
  }

  /** Y: a boss telegraph now (the dash lane toward you in P3, else a ring), or a line from you toward (ax, ay). */
  fireTelegraph(w: RiftDemoWorld, ax: number, ay: number): void {
    if (!this.active) return;
    const b = this.boss;
    if (b) { if (this.bossPhase >= 3) this.telegraphDash(w); else w.events.push({ t: 'telegraph', shape: 'ring', x: b.x, y: b.y, x2: b.x, y2: b.y, r: 300, sec: 1 }); return; }
    const me = w.me, dx = ax - me.x, dy = ay - me.y, len = Math.hypot(dx, dy) || 1, L = Math.min(900, len);
    w.events.push({ t: 'telegraph', shape: 'line', x: me.x, y: me.y, x2: me.x + (dx / len) * L, y2: me.y + (dy / len) * L, r: 60, sec: 0.8 });
  }

  private telegraphDash(w: RiftDemoWorld): void {
    const b = this.boss!, me = w.me;
    const dx = me.x - b.x, dy = me.y - b.y, len = Math.hypot(dx, dy) || 1, L = Math.min(900 * 0.6, Math.max(300, len));
    const x2 = b.x + (dx / len) * L, y2 = b.y + (dy / len) * L;
    w.events.push({ t: 'telegraph', shape: 'line', x: b.x, y: b.y, x2, y2, r: BOSS_RADIUS * 0.8, sec: 0.8 });
    // the dash follows the warning (0.8 s later, 0.6 s at 900 px/s)
    setTimeout(() => { if (this.boss === b) { this.bossDash = 0.6; this.bossDashV = { x: (dx / len) * 900, y: (dy / len) * 900 }; } }, 800);
  }

  /** U: spawn cracks at (x, y). */
  spawnWarnAt(w: RiftDemoWorld, x: number, y: number): void {
    if (!this.active) return;
    w.events.push({ t: 'spawnWarn', x, y, radius: 90, sec: 0.8 });
  }

  /** I: an instability pulse. */
  instability(w: RiftDemoWorld): void {
    if (!this.active) return;
    w.events.push({ t: 'instability', sec: 25 });
  }

  // =============================================================================================

  private view(w: RiftDemoWorld): RiftView | undefined {
    const L = this.L;
    if (!this.active || !L) return undefined;
    return {
      floor: L.floor, floorsTotal: FLOORS_TOTAL, biome: L.biome,
      rooms: [...this.rooms], chests: [...this.chests], lives: [this.lives], seen: [this.seen], anchors: [...this.anchor],
      portal: this.portal,
      departIn: this.portal === 2 ? Math.max(0, Math.ceil(this.departIn)) : this.victoryIn > 0 ? Math.ceil(this.victoryIn) : 0,
      extractOpen: this.extractOpen,
      boss: this.boss ? { id: this.boss.id, kind: 'matriarch', hpFrac: this.bossHp, phase: this.bossPhase } : null,
      waiting: [],
      extracting: this.extract > 0 ? [{ playerId: w.me.playerId, frac: this.extract }] : [],
      floorSec: Math.floor(this.mt),
    };
  }

  match(w: RiftDemoWorld): MatchView | null {
    const dungeon = this.view(w);
    if (!dungeon) return null;
    return {
      phase: 'playing', mode: 'teams', teamCount: 1, timeLeftSec: 0, teamScores: [0], wave: 1 + 2 * (dungeon.floor - 1),
      winnerTeam: -1, winnerPlayerId: 0, timed: false, gameType: 'dungeon', subMode: 'coop', dungeon,
    };
  }

  status(): string {
    if (!this.active) return 'rift: off (R cycles floors)';
    const L = this.L!;
    const st = this.rooms.map((s, i) => `${i}:${'DASC'[s]}`).join(' ');
    let s = `rift: F${L.floor}/${FLOORS_TOTAL} ${L.biome} · rooms ${st} · seen 0b${this.seen.toString(2)} · portal ${this.portal}${this.portal === 2 ? ` ${Math.ceil(this.departIn)}s` : ''}`;
    if (this.extractOpen) s += ` · extract${this.extract > 0 ? ` ${Math.round(this.extract * 100)}%` : ''}`;
    if (this.boss) s += ` · Matriarch P${this.bossPhase} ${Math.round(this.bossHp * 100)}%`;
    if (this.victoryIn > 0) s += ` · victory lap ${Math.ceil(this.victoryIn)}s`;
    return s;
  }
}
