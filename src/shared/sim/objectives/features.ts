// OWNER: OBJECTIVES agent. Objective map geometry (docs/v0.3-proposal.md §5.1).
//
// placeObjectiveFeatures runs on BOTH hosts (buildMatchMap), so it must be a pure function of (map, subMode,
// seed): its only randomness is its own Rng(((seed | 0) ^ 0x0b1ec7ed) >>> 0) (never world.rng), it only carves
// WALL/ROCK → EMPTY (never TILE_BASE, never the 2-tile border), it only drops cover rocks on EMPTY tiles away
// from spawn points, and it finishes with connectPoints so every feature centre (and every spawn) is reachable
// from the map centre. Deathmatch / rift / escort maps are never touched (escort is reserved for v0.4).
import type { GameMap, MapFeature, SubMode } from '../../types';
import { TILE_BASE, TILE_EMPTY, TILE_ROCK, TILE_WALL } from '../../types';
import { Rng } from '../../util/rng';
import { connectPoints } from '../map';
import {
  COVER_MAX_PX, COVER_MIN_PX, COVER_ROCK_TILES, COVER_ROCKS, CTF_CAPTURE_RADIUS, CTF_STAND_CARVE_TILES,
  CTF_STAND_OFFSET_PX, HOT_BORDER_PX, HOT_FFA_MAX_CENTRE_DIST, HOT_MIN_BASE_DIST, HOT_MIN_SITE_SPACING, HOT_RADIUS,
  HOT_SITES, HOT_SPACING_RELAX_EVERY, HOT_SPACING_RELAX_MULT, PAD_CARVE_EXTRA_TILES, ZONE_RADIUS, ZONE_RING_PX,
  zoneCount,
} from './rules';

/** Solid frame generateMap keeps around the map (tiles). */
const BORDER = 2;
/** Cover rocks never land within this of a spawn point (px), so nobody spawns inside one. */
const SPAWN_KEEP_PX = 56;
/** Hot-site sampling gives up after this many draws (the relaxing spacing makes that practically unreachable). */
const HOT_MAX_ATTEMPTS = 40000;
/** A stand that would sit on TILE_BASE is pushed this much further toward the centre, at most STAND_NUDGES times. */
const STAND_NUDGE_PX = 16;
const STAND_NUDGES = 12;

export interface BaseCentre {
  team: number;
  x: number; y: number;
  /** Angle from the map centre (radians). */
  a: number;
}

/** Base centres = the centroid of each team's map.spawns, sorted by team (§5.1). FFA maps have none. */
export function baseCentres(map: GameMap): BaseCentre[] {
  const acc = new Map<number, { x: number; y: number; n: number }>();
  for (const s of map.spawns) {
    if (!(s.team >= 0)) continue;
    const a = acc.get(s.team) ?? { x: 0, y: 0, n: 0 };
    a.x += s.x; a.y += s.y; a.n++;
    acc.set(s.team, a);
  }
  const cx = map.width / 2, cy = map.height / 2;
  const out: BaseCentre[] = [];
  for (const [team, a] of acc) {
    const x = a.x / a.n, y = a.y / a.n;
    out.push({ team, x, y, a: Math.atan2(y - cy, x - cx) });
  }
  out.sort((p, q) => p.team - q.team);
  return out;
}

function tileInside(map: GameMap, c: number, r: number): boolean {
  return c >= BORDER && r >= BORDER && c < map.cols - BORDER && r < map.rows - BORDER;
}

/** WALL / ROCK → EMPTY for every tile whose centre is within rPx of (x, y). TILE_BASE and the border are kept. */
function carveDisc(map: GameMap, x: number, y: number, rPx: number): void {
  const ts = map.tileSize, r2 = rPx * rPx;
  const c0 = Math.floor((x - rPx) / ts), c1 = Math.floor((x + rPx) / ts);
  const r0 = Math.floor((y - rPx) / ts), r1 = Math.floor((y + rPx) / ts);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!tileInside(map, c, r)) continue;
      const dx = (c + 0.5) * ts - x, dy = (r + 0.5) * ts - y;
      if (dx * dx + dy * dy > r2) continue;
      const i = r * map.cols + c, t = map.tiles[i];
      if (t === TILE_WALL || t === TILE_ROCK) map.tiles[i] = TILE_EMPTY;
    }
  }
}

/** EMPTY → ROCK for tiles whose centre is within rPx of (x, y), skipping the border and anything near a spawn. */
function rockDisc(map: GameMap, x: number, y: number, rPx: number): void {
  const ts = map.tileSize, r2 = rPx * rPx, keep2 = SPAWN_KEEP_PX * SPAWN_KEEP_PX;
  const c0 = Math.floor((x - rPx) / ts), c1 = Math.floor((x + rPx) / ts);
  const r0 = Math.floor((y - rPx) / ts), r1 = Math.floor((y + rPx) / ts);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!tileInside(map, c, r)) continue;
      const tx = (c + 0.5) * ts, ty = (r + 0.5) * ts;
      const dx = tx - x, dy = ty - y;
      if (dx * dx + dy * dy > r2) continue;
      const i = r * map.cols + c;
      if (map.tiles[i] !== TILE_EMPTY) continue;
      let nearSpawn = false;
      for (const s of map.spawns) {
        const sx = s.x - tx, sy = s.y - ty;
        if (sx * sx + sy * sy < keep2) { nearSpawn = true; break; }
      }
      if (!nearSpawn) map.tiles[i] = TILE_ROCK;
    }
  }
}

/** Open pad (radius + PAD_CARVE_EXTRA_TILES) plus COVER_ROCKS cover rocks spread around it (§5.1). */
function carvePad(map: GameMap, rng: Rng, x: number, y: number, radius: number): void {
  carveDisc(map, x, y, radius + PAD_CARVE_EXTRA_TILES * map.tileSize);
  const a0 = rng.next() * Math.PI * 2;
  for (let i = 0; i < COVER_ROCKS; i++) {
    const a = a0 + (i * Math.PI * 2) / COVER_ROCKS + rng.range(-0.4, 0.4);
    const d = rng.range(COVER_MIN_PX, COVER_MAX_PX);
    rockDisc(map, x + Math.cos(a) * d, y + Math.sin(a) * d, COVER_ROCK_TILES * map.tileSize);
  }
}

function tileAtPx(map: GameMap, x: number, y: number): number {
  const c = Math.floor(x / map.tileSize), r = Math.floor(y / map.tileSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return TILE_WALL;
  return map.tiles[r * map.cols + c];
}

/** Angle in [0, 2π) from a to b going counter-clockwise (+angle). */
function ccw(a: number, b: number): number {
  const TAU = Math.PI * 2;
  let d = (b - a) % TAU;
  if (d <= 0) d += TAU;
  return d;
}

// ---------------------------------------------------------------------------------------------
// Per sub-mode layouts
// ---------------------------------------------------------------------------------------------

function flagStands(map: GameMap, bases: BaseCentre[]): MapFeature[] {
  const cx = map.width / 2, cy = map.height / 2;
  const out: MapFeature[] = [];
  for (const b of bases) {
    const dx = cx - b.x, dy = cy - b.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / d, uy = dy / d;
    let off = CTF_STAND_OFFSET_PX;
    let x = b.x + ux * off, y = b.y + uy * off;
    for (let k = 0; k < STAND_NUDGES && tileAtPx(map, x, y) === TILE_BASE; k++) {
      off += STAND_NUDGE_PX;
      x = b.x + ux * off; y = b.y + uy * off;
    }
    x = Math.round(x); y = Math.round(y);
    carveDisc(map, x, y, CTF_STAND_CARVE_TILES * map.tileSize);
    out.push({ kind: 'flagStand', team: b.team, index: b.team, x, y, radius: CTF_CAPTURE_RADIUS });
  }
  return out;
}

/** Flank angles "between adjacent bases" (§5.1): 2 teams → base0 ± π/2; 5+ teams → every (T/(n−1))-th. */
function flankAngles(bases: BaseCentre[], flanks: number, rng: Rng): number[] {
  if (bases.length < 2) {
    const a0 = rng.next() * Math.PI * 2;
    return Array.from({ length: flanks }, (_, k) => a0 + (k * Math.PI * 2) / flanks);
  }
  if (bases.length === 2) return [bases[0].a + Math.PI / 2, bases[0].a - Math.PI / 2].slice(0, flanks);
  // Walk the bases counter-clockwise from team 0 and take the mid-angle of each adjacent pair.
  const a0 = bases[0].a;
  const ring = bases.slice().sort((p, q) => ccw(a0, p.a) % (Math.PI * 2) - ccw(a0, q.a) % (Math.PI * 2));
  const between: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k].a, b = ring[(k + 1) % ring.length].a;
    between.push(a + ccw(a, b) / 2);
  }
  if (between.length <= flanks) return between;
  const T = between.length;
  return Array.from({ length: flanks }, (_, k) => between[Math.floor((k * T) / flanks)]);
}

function zonePads(map: GameMap, bases: BaseCentre[], rng: Rng, teams: number): MapFeature[] {
  const cx = map.width / 2, cy = map.height / 2;
  const n = zoneCount(Math.max(bases.length, teams));
  const out: MapFeature[] = [{ kind: 'zone', team: -1, index: 0, x: Math.round(cx), y: Math.round(cy), radius: ZONE_RADIUS }];
  const angles = flankAngles(bases, n - 1, rng);
  angles.forEach((a, k) => {
    out.push({
      kind: 'zone', team: -1, index: k + 1,
      x: Math.round(cx + Math.cos(a) * ZONE_RING_PX), y: Math.round(cy + Math.sin(a) * ZONE_RING_PX), radius: ZONE_RADIUS,
    });
  });
  for (const f of out) carvePad(map, rng, f.x, f.y, f.radius);
  return out;
}

function hotSites(map: GameMap, bases: BaseCentre[], rng: Rng): MapFeature[] {
  const W = map.width, H = map.height, cx = W / 2, cy = H / 2;
  const ffa = bases.length === 0;
  const sites: { x: number; y: number }[] = [{ x: Math.round(cx), y: Math.round(cy) }];
  let spacing = HOT_MIN_SITE_SPACING, fails = 0;
  const baseMin2 = HOT_MIN_BASE_DIST * HOT_MIN_BASE_DIST, ffaMax2 = HOT_FFA_MAX_CENTRE_DIST * HOT_FFA_MAX_CENTRE_DIST;
  for (let att = 0; sites.length < HOT_SITES && att < HOT_MAX_ATTEMPTS; att++) {
    const x = rng.range(HOT_BORDER_PX, W - HOT_BORDER_PX), y = rng.range(HOT_BORDER_PX, H - HOT_BORDER_PX);
    let ok = true;
    if (ffa) ok = (x - cx) ** 2 + (y - cy) ** 2 <= ffaMax2;
    else for (const b of bases) if ((x - b.x) ** 2 + (y - b.y) ** 2 < baseMin2) { ok = false; break; }
    if (ok) {
      const s2 = spacing * spacing;
      for (const s of sites) if ((x - s.x) ** 2 + (y - s.y) ** 2 < s2) { ok = false; break; }
    }
    if (!ok) {
      if (++fails >= HOT_SPACING_RELAX_EVERY) { fails = 0; spacing *= HOT_SPACING_RELAX_MULT; }
      continue;
    }
    sites.push({ x: Math.round(x), y: Math.round(y) });
  }
  const out = sites.map((s, i): MapFeature => ({ kind: 'hotSite', team: -1, index: i, x: s.x, y: s.y, radius: HOT_RADIUS }));
  for (const f of out) carvePad(map, rng, f.x, f.y, f.radius);
  return out;
}

/**
 * Adds map.features for objective sub-modes (flag stands / zones / hot sites), carving open space with
 * its own Rng(((seed | 0) ^ 0x0b1ec7ed) >>> 0) and finishing with connectPoints. buildMatchMap calls it
 * only for objective sub-modes; deathmatch and rift maps have no features. Escort (v0.4) is a no-op.
 * - ctf: `flagStand` × teams (index = team) at the base centroid + 192 px toward the centre (never on TILE_BASE),
 *   a 4-tile carve; radius = capture radius 90.
 * - zones: `zone` × clamp(teams + 1, 3, 5): index 0 Core at the centre, flanks A–D on a 1300 px ring at the angles
 *   between adjacent bases; pad carve radius + 2 tiles, 3 cover rocks; radius 200.
 * - hotpoint: `hotSite` × 8: site 0 at the centre, the rest rejection-sampled (≥ 900 px from every base; FFA:
 *   ≤ 2600 px from the centre; ≥ 700 px apart, relaxing ×0.85 every 400 failures; ≥ 400 px from the edge);
 *   9.5-tile carve, 3 cover rocks; radius 240.
 */
export function placeObjectiveFeatures(map: GameMap, subMode: SubMode, seed: number): void {
  if (subMode !== 'ctf' && subMode !== 'zones' && subMode !== 'hotpoint') return;
  const rng = new Rng(((seed | 0) ^ 0x0b1ec7ed) >>> 0);
  const bases = baseCentres(map);
  let features: MapFeature[];
  if (subMode === 'ctf') features = flagStands(map, bases);
  else if (subMode === 'zones') features = zonePads(map, bases, rng, map.teamCount);
  else features = hotSites(map, bases, rng);
  map.features = features;
  connectPoints(map, features.map((f) => ({ x: f.x, y: f.y })));
  ensureHullAccess(map, features, bases);
}

// ---------------------------------------------------------------------------------------------
// Hull-sized access (connectPoints only guarantees 4-neighbour TILE connectivity: a 1-tile gap passes it, but no
// hull does). generateMap's 8-arc central ring leaves ≈ 1.2-tile gaps, so in 8-team maps the Core / hot site 0
// sat sealed off for Engineer (r 18) and Juggernaut (r 22) hulls.
// ---------------------------------------------------------------------------------------------

/** Lane half-width (px) carved toward an unreachable feature: ≈ 3 tiles wide, room for the r 22 Juggernaut. */
const LANE_R_PX = 48;
/** Lane walk step (px). */
const LANE_STEP_PX = 12;
/** A feature counts as reachable when a hull-open 2×2 block centre lies within this of it (px). */
const ACCESS_NEAR_PX = 48;
const ACCESS_PASSES = 3;
/** Features this close to the map centre (inside generateMap's central ring, ≈ 14 tiles) get one lane per base. */
const CENTRAL_PX = 640;

/**
 * Blocks = 2×2 open tiles (a disc of r ≤ 1 tile fits at the block centre); two 4-adjacent open blocks overlap in a
 * 2×1 open strip, so a hull of radius ≤ 1 tile slides between them. Returns the block flood from every spawn.
 */
function hullReach(map: GameMap): Uint8Array {
  const { cols, rows, tiles, tileSize: ts } = map;
  const open = (c: number, r: number) => {
    const t = tiles[r * cols + c];
    return t !== TILE_WALL && t !== TILE_ROCK;
  };
  const bc = cols - 1, br = rows - 1;
  const blockOpen = new Uint8Array(bc * br);
  for (let r = 0; r < br; r++) for (let c = 0; c < bc; c++) {
    blockOpen[r * bc + c] = open(c, r) && open(c + 1, r) && open(c, r + 1) && open(c + 1, r + 1) ? 1 : 0;
  }
  const seen = new Uint8Array(bc * br);
  const queue = new Int32Array(bc * br);
  let head = 0, tail = 0;
  const push = (i: number) => { if (blockOpen[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; } };
  for (const s of map.spawns) {
    const c = Math.floor(s.x / ts), r = Math.floor(s.y / ts);
    for (let dr = -1; dr <= 0; dr++) for (let dc = -1; dc <= 0; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < bc && rr < br) push(rr * bc + cc);
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const c = i % bc, r = (i - c) / bc;
    if (c > 0) push(i - 1);
    if (c < bc - 1) push(i + 1);
    if (r > 0) push(i - bc);
    if (r < br - 1) push(i + bc);
  }
  return seen;
}

/** Whether a reached block centre (block (c, r) is centred on the tile corner (c + 1, r + 1)) is within `near` px. */
function reachedNear(map: GameMap, seen: Uint8Array, x: number, y: number, near: number): boolean {
  const ts = map.tileSize, bc = map.cols - 1, br = map.rows - 1, n2 = near * near;
  const c0 = Math.max(0, Math.floor((x - near) / ts) - 1), c1 = Math.min(bc - 1, Math.ceil((x + near) / ts));
  const r0 = Math.max(0, Math.floor((y - near) / ts) - 1), r1 = Math.min(br - 1, Math.ceil((y + near) / ts));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (!seen[r * bc + c]) continue;
    const dx = (c + 1) * ts - x, dy = (r + 1) * ts - y;
    if (dx * dx + dy * dy <= n2) return true;
  }
  return false;
}

/** The reached block centre nearest to (x, y), or null. */
function nearestReached(map: GameMap, seen: Uint8Array, x: number, y: number): { x: number; y: number } | null {
  const ts = map.tileSize, bc = map.cols - 1;
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i]) continue;
    const c = i % bc, r = (i - c) / bc;
    const px = (c + 1) * ts, py = (r + 1) * ts;
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD) { bestD = d; best = { x: px, y: py }; }
  }
  return best;
}

/**
 * Carve a LANE_R_PX lane from (x, y) toward (tx, ty), starting `from` px out, until it has run into the region
 * already hull-reachable (plus one lane radius, so the joint is hull-wide too) or reached the target.
 */
function carveLane(map: GameMap, seen: Uint8Array, x: number, y: number, tx: number, ty: number, from: number): void {
  const dx = tx - x, dy = ty - y, len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  let stopAt = len;
  for (let d = from; d <= len; d += LANE_STEP_PX) {
    const px = x + ux * d, py = y + uy * d;
    if (d < stopAt && reachedNear(map, seen, px, py, map.tileSize * 0.75)) stopAt = Math.min(len, d + LANE_R_PX);
    carveDisc(map, px, py, LANE_R_PX);
    if (d >= stopAt) break;
  }
}

/**
 * Every feature must be reachable by the largest hull from the spawns (§9 "every feature is reachable"). A
 * sealed feature gets symmetric lanes: one toward every base centroid (generateMap's ring gaps face the bases,
 * so each team gets an equal lane into the Core), or — FFA / still sealed — one toward the nearest reachable
 * spot. Starts outside the pad's cover rocks, so they stay put. Pure: same map in → same tiles out.
 */
function ensureHullAccess(map: GameMap, features: MapFeature[], bases: BaseCentre[]): void {
  for (let pass = 0; pass < ACCESS_PASSES; pass++) {
    const seen = hullReach(map);
    const sealed = features.filter((f) => !reachedNear(map, seen, f.x, f.y, ACCESS_NEAR_PX));
    if (sealed.length === 0) return;
    const cx = map.width / 2, cy = map.height / 2;
    for (const f of sealed) {
      // Pads: start past the cover rocks (they stay put) but inside the pad's own open carve.
      const padOpen = f.radius + PAD_CARVE_EXTRA_TILES * map.tileSize - 8;
      const from = f.kind === 'flagStand' ? 0 : Math.min(padOpen, COVER_MAX_PX + COVER_ROCK_TILES * map.tileSize + LANE_R_PX);
      const central = (f.x - cx) ** 2 + (f.y - cy) ** 2 < CENTRAL_PX * CENTRAL_PX;
      if (pass === 0 && central && bases.length >= 2) {
        for (const b of bases) carveLane(map, seen, f.x, f.y, b.x, b.y, from);
      } else {
        const t = nearestReached(map, seen, f.x, f.y);
        if (t) carveLane(map, seen, f.x, f.y, t.x, t.y, 0);
      }
    }
  }
}
