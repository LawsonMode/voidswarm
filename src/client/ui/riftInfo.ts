// Pure (DOM-free) presentation logic for the v0.3 Dungeon Runner ("the Rift", docs/v0.3-proposal.md §4, §9 CLIENT M4):
// the HUD's top-centre rift strip (FLOOR n/N · biome · lives · rooms c/R · mm:ss), the boss bar, rift banners (pushed
// into the HUD's one shared banner queue), the out-of-lives waiting overlay, the extract ring, off-screen portal
// arrows, the party roster, and the results banner / status column. RiftView / RiftYou / RiftGameEvent (types.ts) are
// the wire shapes; room kinds, doors and portal spots come from map.dungeon (RiftLayout). RiftHud.ts only draws.
import { RIFT_BOSS_EVERY, RIFT_SOFT_LIMIT_SEC } from '../../shared/constants';
import { SUB_MODES } from '../../shared/data/gameTypes';
import { RIFT_INSTABILITY_WARN_SEC } from '../../shared/sim/dungeonRules';
import type { RiftResult } from '../../shared/protocol';
import {
  RIFT_CLEARED,
  type EnemyKind, type EntityId, type GameEvent, type MatchView, type PlayerId, type RiftBiome, type RiftGameEvent,
  type RiftLayout, type RiftRoomKind, type RiftView, type RiftYou, type ShipView, type TeamId, type YouState,
} from '../../shared/types';
import { fmtMinSec } from './gameTypeInfo';

// ------------------------------------------------------------------ names + small helpers

/** The strip's clock turns amber this long into a floor (a minute before instability, §4.4). */
export const RIFT_WARN_SEC = RIFT_SOFT_LIMIT_SEC - RIFT_INSTABILITY_WARN_SEC;

export const BIOME_NAMES: Readonly<Record<RiftBiome, string>> = { hive: 'Hive Warrens', prism: 'Prism Vaults' };
const BIOME_SHORT: Readonly<Record<RiftBiome, string>> = { hive: 'HIVE', prism: 'PRISM' };

export function biomeName(b: RiftBiome | string | undefined): string {
  return (b && BIOME_NAMES[b as RiftBiome]) || 'The Rift';
}

/** §4.1: floors 1–3 are the hive, 4–6 the prism (for wording before a floor's layout is known). */
export function defaultBiome(floor: number): RiftBiome {
  return floor >= 4 ? 'prism' : 'hive';
}

export const ROOM_KIND_NAMES: Readonly<Record<RiftRoomKind, string>> = {
  entrance: 'Entrance', hall: 'Hall', arena: 'Arena', treasure: 'Treasure Room', key: 'Key Vault', boss: 'Boss Chamber',
};

const BOSS_NAMES: Partial<Record<EnemyKind, string>> = { matriarch: 'The Hive Matriarch', hive: 'Hive', brute: 'Elite Brute' };

/** Display name of a boss / mini-boss kind. */
export function bossName(kind: EnemyKind | string | undefined): string {
  const k = String(kind ?? '');
  return BOSS_NAMES[k as EnemyKind] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Boss');
}

/** The Matriarch's phase names (§4.5): P1 Hive script, P2 Brood Burst, P3 Frenzy. */
export function bossPhaseName(kind: EnemyKind | string | undefined, phase: number): string {
  if (kind !== 'matriarch') return phase > 1 ? `PHASE ${phase}` : '';
  return phase >= 3 ? 'FRENZY' : phase === 2 ? 'BROOD BURST' : 'BROOD QUEEN';
}

const up = (s: string): string => s.toUpperCase();
const int = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);
const clamp01 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** "1 life" / "7 lives". */
export function livesLabel(n: number): string {
  return `${n} ${n === 1 ? 'life' : 'lives'}`;
}

// ------------------------------------------------------------------ which strip

/** The HUD's top-centre strip is the rift strip whenever the match carries a RiftView. */
export function hudShowsRift(m: Pick<MatchView, 'dungeon'> | null | undefined): boolean {
  return !!m && !!m.dungeon;
}

/** The viewer's party: RiftYou.party, else their team, else party 0 (v0.3 has one party). */
export function partyOf(you: Pick<YouState, 'rift'> | null | undefined, myTeam: TeamId | undefined): TeamId {
  const p = you?.rift?.party;
  if (typeof p === 'number' && p >= 0) return p;
  return typeof myTeam === 'number' && myTeam >= 0 ? myTeam : 0;
}

/** Final floor of the run (the boss clear opens only Extract, shown as "Exit"). */
export function isFinalFloor(view: Pick<RiftView, 'floor' | 'floorsTotal'>): boolean {
  return view.floorsTotal > 0 && view.floor >= view.floorsTotal;
}

// ------------------------------------------------------------------ strip

export interface RiftStripModel {
  /** "FLOOR 3/6" */
  floor: string;
  /** "HIVE" / "PRISM" */
  biome: string;
  biomeKey: RiftBiome | '';
  lives: number;
  /** 0 ok · 1 low (≤ 2) · 2 none left */
  livesLevel: 0 | 1 | 2;
  /** "ROOMS 3/7" */
  rooms: string;
  /** Time on this floor, m:ss. */
  clock: string;
  /** 0 · 1 amber (≥ RIFT_WARN_SEC) · 2 unstable (≥ RIFT_SOFT_LIMIT_SEC) */
  clockLevel: 0 | 1 | 2;
  /** DESCENDING 0:17 · EXIT · RUN ENDS 0:45 · EXTRACT OPEN · PORTAL OPEN · '' */
  badge: string;
  badgeKind: '' | 'depart' | 'exit' | 'extract' | 'portal';
}

export function riftStripModel(view: RiftView, party: TeamId): RiftStripModel {
  const rooms = Array.isArray(view.rooms) ? view.rooms : [];
  const cleared = rooms.filter((s) => s === RIFT_CLEARED).length;
  const lives = Math.max(0, int(Array.isArray(view.lives) ? view.lives[party] : 0));
  const sec = Math.max(0, Number.isFinite(view.floorSec) ? view.floorSec : 0);
  const depart = Math.max(0, Number.isFinite(view.departIn) ? view.departIn : 0);
  let badge = '';
  let badgeKind: RiftStripModel['badgeKind'] = '';
  if (view.portal === 2) { badge = `DESCENDING ${fmtMinSec(depart)}`; badgeKind = 'depart'; }
  else if (view.extractOpen && isFinalFloor(view) && depart > 0) { badge = `EXIT · RUN ENDS ${fmtMinSec(depart)}`; badgeKind = 'exit'; }
  else if (view.extractOpen) { badge = isFinalFloor(view) ? 'EXIT OPEN' : 'EXTRACT OPEN'; badgeKind = isFinalFloor(view) ? 'exit' : 'extract'; }
  else if (view.portal === 1) { badge = 'PORTAL OPEN'; badgeKind = 'portal'; }
  return {
    floor: `FLOOR ${Math.max(1, int(view.floor, 1))}/${Math.max(1, int(view.floorsTotal, 1))}`,
    biome: BIOME_SHORT[view.biome] ?? '',
    biomeKey: BIOME_SHORT[view.biome] ? view.biome : '',
    lives,
    livesLevel: lives <= 0 ? 2 : lives <= 2 ? 1 : 0,
    rooms: `ROOMS ${cleared}/${rooms.length}`,
    clock: fmtMinSec(sec, false),
    clockLevel: sec >= RIFT_SOFT_LIMIT_SEC ? 2 : sec >= RIFT_WARN_SEC ? 1 : 0,
    badge,
    badgeKind,
  };
}

// ------------------------------------------------------------------ boss bar

export interface BossBarModel {
  name: string;
  hpFrac: number;
  /** "64%" */
  pct: string;
  phase: number;
  /** BROOD BURST / FRENZY / PHASE 2 / '' */
  phaseName: string;
  /** Phase pips to draw (≥ 3 for the Matriarch). */
  phases: number;
}

export function bossBarModel(view: Pick<RiftView, 'boss'> | null | undefined): BossBarModel | null {
  const b = view?.boss;
  if (!b) return null;
  const hp = clamp01(b.hpFrac);
  const phase = Math.max(1, int(b.phase, 1));
  return {
    name: up(bossName(b.kind)),
    hpFrac: hp,
    pct: `${Math.ceil(hp * 100)}%`,
    phase,
    phaseName: bossPhaseName(b.kind, phase),
    phases: b.kind === 'matriarch' ? Math.max(3, phase) : Math.max(1, phase),
  };
}

// ------------------------------------------------------------------ banners

export interface RiftBanner {
  text: string;
  /** Banner style: 'rift' (news), 'rift-good', 'rift-bad', 'rift-alert' (flashing), 'boss' (the classic boss flash). */
  kind: 'rift' | 'rift-good' | 'rift-bad' | 'rift-alert' | 'boss';
  priority: number;
  ms: number;
}

export interface RiftCtx {
  myPid: PlayerId;
  party: TeamId;
  name(pid: PlayerId): string;
  /** map.dungeon of the current floor (room kinds, chests). */
  layout: RiftLayout | null | undefined;
  /** Latest RiftView (final-floor wording). */
  view: RiftView | null | undefined;
}

const RIFT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'roomSeal', 'roomClear', 'roomReset', 'spawnWarn', 'chestOpen', 'bossIntro', 'bossPhase', 'telegraph', 'portalOpen',
  'departing', 'floorStart', 'lifeLost', 'outOfLives', 'extract', 'partyWiped', 'instability', 'riftEnd',
]);

export function isRiftEvent(ev: GameEvent): ev is RiftGameEvent {
  return RIFT_EVENT_TYPES.has(ev.t);
}

function roomKindName(ctx: Pick<RiftCtx, 'layout'>, room: number): string {
  const r = ctx.layout?.rooms?.[room];
  return up(r ? ROOM_KIND_NAMES[r.kind] ?? 'Room' : 'Room');
}

/** Floor-start banner: "FLOOR 4 · PRISM VAULTS", "· BOSS FLOOR" on boss floors. */
export function floorBanner(floor: number, biome: RiftBiome | string | undefined, bossFloor: boolean): RiftBanner {
  return { text: `FLOOR ${floor} · ${up(biomeName(biome))}${bossFloor ? ' · BOSS FLOOR' : ''}`, kind: 'rift', priority: 4, ms: 2600 };
}

/** One minute before instability (floorSec crosses RIFT_WARN_SEC). */
export function instabilityWarnBanner(): RiftBanner {
  return { text: 'RIFT DESTABILIZING — HUNTERS IN 1:00', kind: 'rift-alert', priority: 3, ms: 2600 };
}

/**
 * The banner for a rift event (null = none). Party events of another party are skipped (v0.3 runs one party).
 * `repeat` = an instability pulse after the first one on this floor (shorter, lower priority).
 */
export function riftBannerFor(ev: RiftGameEvent, ctx: RiftCtx, repeat = false): RiftBanner | null {
  const b = (text: string, kind: RiftBanner['kind'], priority: number, ms = 2200): RiftBanner => ({ text, kind, priority, ms });
  const ours = (team: TeamId | undefined) => team === undefined || team < 0 || team === ctx.party;
  const final = !!ctx.view && isFinalFloor(ctx.view);
  switch (ev.t) {
    case 'roomSeal':
      if (!ours(ev.team)) return null;
      return ev.sec > 0
        ? b(`${roomKindName(ctx, ev.room)} SEALING`, 'rift-alert', 3, Math.max(800, Math.min(1600, ev.sec * 1000)))
        : b(`${roomKindName(ctx, ev.room)} SEALED — CLEAR IT`, 'rift-bad', 3, 2000);
    case 'roomClear': {
      if (!ours(ev.team)) return null;
      const r = ctx.layout?.rooms?.[ev.room];
      if (r?.kind === 'boss') return b('BOSS CHAMBER CLEARED · +2 LIVES', 'rift-good', 4, 2600);
      const chest = !!r && Array.isArray(r.chests) && r.chests.length > 0 && r.kind !== 'treasure';
      return b(`${roomKindName(ctx, ev.room)} CLEARED${chest ? ' · CHEST UNLOCKED' : ''}`, 'rift-good', 3, 2000);
    }
    case 'roomReset':
      return ours(ev.team) ? b('ROOM RESET — REGROUP', 'rift-bad', 3, 2200) : null;
    case 'portalOpen':
      if (!ev.extract) return b('DESCEND PORTAL OPEN', 'rift-good', 3, 2400);
      return final ? b('EXIT OPEN — EXTRACT TO FINISH', 'rift-good', 3, 2800) : b('EXTRACT OPEN — BANK YOUR CACHES', 'rift-good', 3, 2800);
    case 'departing':
      return ours(ev.team) ? b(`DESCENDING IN ${Math.max(0, Math.ceil(ev.sec))}s`, 'rift', 3, 2000) : null;
    case 'lifeLost': {
      if (!ours(ev.team)) return null;
      const left = Math.max(0, int(ev.lives));
      const tail = left > 0 ? `${up(livesLabel(left))} LEFT` : 'NO LIVES LEFT';
      if (ev.playerId === ctx.myPid) return b(`YOU WENT DOWN · ${tail}`, left > 0 ? 'rift-bad' : 'rift-alert', 2, 2000);
      return b(`${up(ctx.name(ev.playerId))} DOWN · ${tail}`, left > 0 ? 'rift' : 'rift-alert', left > 0 ? 1 : 2, 1600);
    }
    case 'outOfLives':
      return ev.playerId === ctx.myPid
        ? b('OUT OF LIVES — YOU REJOIN NEXT FLOOR', 'rift-bad', 3, 2600)
        : b(`${up(ctx.name(ev.playerId))} IS OUT FOR THE FLOOR`, 'rift', 1, 1800);
    case 'extract':
      return ev.playerId === ctx.myPid
        ? b('EXTRACTED — YOUR CACHES ARE BANKED', 'rift-good', 4, 3000)
        : b(`${up(ctx.name(ev.playerId))} EXTRACTED`, 'rift-good', 1, 1800);
    case 'partyWiped':
      return ours(ev.team) ? b('PARTY WIPED', 'rift-alert', 5, 3200) : null;
    case 'instability':
      return repeat ? b('HUNTERS INBOUND', 'rift-alert', 2, 1600) : b('RIFT UNSTABLE — HUNTERS INBOUND', 'rift-alert', 3, 2600);
    case 'bossIntro':
      return b(`${up(bossName(ev.kind))} AWAKENS`, 'boss', 4, 3000);
    case 'bossPhase': {
      const name = bossPhaseName(ev.kind, ev.phase);
      return name ? b(name, 'boss', 4, 2200) : null;
    }
    case 'floorStart':
      return floorBanner(ev.floor, ctx.layout?.biome ?? ctx.view?.biome, !!ctx.layout?.bossFloor);
    default:
      return null; // spawnWarn / telegraph (render), chestOpen (loot banners), riftEnd (results)
  }
}

/** A later instability pulse on the same floor repeats the short banner only after this long. */
export const INSTABILITY_REPEAT_MS = 20000;

const NO_BANNERS: readonly RiftBanner[] = [];

/**
 * Decides which rift banners to raise, once each: the floor banner (the client's floorStart, or the floorStart event,
 * whichever comes first), the one-minute instability warning from the view's floor clock, and every rift event
 * (instability pulses throttled). Pure: no DOM.
 */
export class RiftAnnouncer {
  private announced = new Set<string>();
  private instabilityFloor = -1;
  private instabilityAt = -1e9;

  reset(): void {
    this.announced.clear();
    this.instabilityFloor = -1;
    this.instabilityAt = -1e9;
  }

  private once(key: string, b: RiftBanner | null, out: RiftBanner[]): void {
    if (!b || this.announced.has(key)) return;
    this.announced.add(key);
    out.push(b);
  }

  /** The client swapped to `floor` (floorStart message). Without a layout, the §4.1 rule names the biome. */
  onFloor(floor: number, layout: RiftLayout | null | undefined): readonly RiftBanner[] {
    const out: RiftBanner[] = [];
    const ok = !!layout && layout.floor === floor;
    this.once(`floor:${floor}`, floorBanner(floor, ok ? layout!.biome : defaultBiome(floor), ok ? !!layout!.bossFloor : floor % RIFT_BOSS_EVERY === 0), out);
    return out;
  }

  /** Per frame with the latest view: view-driven banners. */
  observe(view: RiftView): readonly RiftBanner[] {
    let out: RiftBanner[] | null = null;
    const sec = Number.isFinite(view.floorSec) ? view.floorSec : 0;
    if (sec >= RIFT_WARN_SEC && sec < RIFT_SOFT_LIMIT_SEC) this.once(`warn:${view.floor}`, instabilityWarnBanner(), (out ??= []));
    return out ?? NO_BANNERS;
  }

  /** Released events of one frame → banners (non-rift events are ignored). */
  onEvents(events: readonly GameEvent[], ctx: RiftCtx, now: number): readonly RiftBanner[] {
    let out: RiftBanner[] | null = null;
    for (const ev of events) {
      if (!isRiftEvent(ev)) continue;
      if (ev.t === 'floorStart') { this.once(`floor:${ev.floor}`, riftBannerFor(ev, ctx), (out ??= [])); continue; }
      if (ev.t === 'instability') {
        const floor = ctx.view?.floor ?? 0;
        const repeat = this.instabilityFloor === floor;
        if (repeat && now - this.instabilityAt < INSTABILITY_REPEAT_MS) continue;
        this.instabilityFloor = floor;
        this.instabilityAt = now;
        this.announced.add(`warn:${floor}`); // the warning is moot once hunters are here
        const bn = riftBannerFor(ev, ctx, repeat);
        if (bn) (out ??= []).push(bn);
        continue;
      }
      const bn = riftBannerFor(ev, ctx);
      if (bn) (out ??= []).push(bn);
    }
    return out ?? NO_BANNERS;
  }
}

// ------------------------------------------------------------------ waiting overlay / extract ring

export interface OverlayModel { big: string; small: string }

/** Out of lives (or extracted, while YouState still arrives): what the centre overlay says. null = not waiting. */
export function waitingModel(rift: RiftYou | undefined, followName: string): OverlayModel | null {
  if (!rift) return null;
  const watching = followName ? `Watching ${followName}` : 'Watching the party';
  if (rift.extracted) return { big: 'EXTRACTED', small: `Your caches are banked · ${watching}` };
  if (rift.waiting) return { big: 'OUT OF LIVES', small: `${watching} · you rejoin at the next floor` };
  return null;
}

/** Spectating in a rift (no YouState): a pending drop-in or an extracted pilot gets its own line. null = default. */
export function riftSpectateModel(state: { dropIn: boolean; extracted: boolean }, targetName: string): OverlayModel | null {
  const watching = targetName ? `Watching ${targetName}` : 'Watching the party';
  if (state.extracted) return { big: 'EXTRACTED', small: `Your caches are banked · ${watching} · Click / A to cycle` };
  if (state.dropIn) return { big: 'JOINING AT THE NEXT FLOOR', small: `${watching} · Click / A to cycle` };
  return null;
}

/** The dead-with-lives respawn line in a rift. */
export function riftRespawnLine(respawnIn: number, lives: number): string {
  const s = Math.max(0, Number.isFinite(respawnIn) ? respawnIn : 0);
  return `Respawning in ${s.toFixed(1)}s · ${livesLabel(Math.max(0, lives))} left`;
}

export interface ExtractRingModel { frac: number; pct: string; label: string }

/** The extract channel ring (you are in the Extract zone and channelling), null otherwise. */
export function extractRingModel(you: Pick<YouState, 'alive' | 'rift'> | null | undefined, final: boolean): ExtractRingModel | null {
  const r = you?.rift;
  if (!you || !you.alive || !r || r.extracted) return null;
  const frac = clamp01(r.extract);
  if (frac <= 0) return null;
  return { frac, pct: `${Math.floor(frac * 100)}%`, label: final ? 'EXITING' : 'EXTRACTING' };
}

// ------------------------------------------------------------------ portal arrows

export interface PortalTarget { kind: 'descend' | 'extract' | 'exit'; x: number; y: number; label: string }

/** Open portals to point at: Descend (portal ≥ 1) and Extract ("Exit" on the final floor). */
export function portalTargets(view: RiftView | null | undefined, layout: RiftLayout | null | undefined): PortalTarget[] {
  if (!view || !layout || layout.floor !== view.floor) return [];
  const out: PortalTarget[] = [];
  const ok = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0;
  if (view.portal >= 1 && ok(layout.portalX, layout.portalY)) {
    out.push({ kind: 'descend', x: layout.portalX, y: layout.portalY, label: view.portal === 2 ? 'DESCENDING' : 'DESCEND' });
  }
  if (view.extractOpen && ok(layout.extractX, layout.extractY)) {
    const final = isFinalFloor(view);
    out.push({ kind: final ? 'exit' : 'extract', x: layout.extractX, y: layout.extractY, label: final ? 'EXIT' : 'EXTRACT' });
  }
  return out;
}

export interface EdgeInsets { top: number; bottom: number; side: number }
export interface EdgeArrow { x: number; y: number; angle: number }

/**
 * Where to pin an off-screen pointer: (sx, sy) is the target in view px of a w×h view whose top / bottom / sides are
 * covered by `inset`. null when the target is visible (inside the uncovered rect); otherwise the point where the ray
 * from the view centre to the target leaves that rect, and the ray's angle (radians, y down).
 */
export function edgeArrow(sx: number, sy: number, w: number, h: number, inset: EdgeInsets): EdgeArrow | null {
  if (!(w > 0 && h > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  const left = Math.min(w / 2 - 1, Math.max(0, inset.side));
  const right = w - left;
  const top = Math.min(h / 2 - 1, Math.max(0, inset.top));
  const bottom = Math.max(h / 2 + 1, h - Math.max(0, inset.bottom));
  if (sx >= left && sx <= right && sy >= top && sy <= bottom) return null;
  const cx = w / 2, cy = h / 2;
  const dx = sx - cx, dy = sy - cy;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (right - cx) / dx);
  else if (dx < 0) t = Math.min(t, (left - cx) / dx);
  if (dy > 0) t = Math.min(t, (bottom - cy) / dy);
  else if (dy < 0) t = Math.min(t, (top - cy) / dy);
  if (!Number.isFinite(t)) return null;
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) };
}

/** Edge pointers closer than this (view px) merge into one (Extract sits 352 px from Descend: same edge point). */
export const ARROW_MERGE_PX = 56;

export interface PlacedArrow extends EdgeArrow { kind: PortalTarget['kind']; label: string; /** world px from the camera focus */ dist: number }

/**
 * Pointers that would overlap become one: the first keeps its spot and kind, the labels join ("DESCEND · EXTRACT")
 * and the distance is the nearer one. Order is kept.
 */
export function mergeArrows(list: readonly PlacedArrow[], minGap = ARROW_MERGE_PX): PlacedArrow[] {
  const out: PlacedArrow[] = [];
  for (const a of list) {
    const near = out.find((o) => Math.hypot(o.x - a.x, o.y - a.y) < minGap);
    if (near) {
      near.label = `${near.label} · ${a.label}`;
      near.dist = Math.min(near.dist, a.dist);
    } else {
      out.push({ ...a });
    }
  }
  return out;
}

/**
 * World → view px from the renderer's screenToWorld (a linear camera: offset + uniform zoom, no rotation). null when
 * the samples are degenerate (no renderer yet).
 */
export function projectorFrom(screenToWorld: (sx: number, sy: number) => { x: number; y: number }): ((x: number, y: number) => { x: number; y: number }) | null {
  const o = screenToWorld(0, 0);
  const e = screenToWorld(100, 100);
  const kx = e.x - o.x, ky = e.y - o.y;
  if (!(Number.isFinite(kx) && Number.isFinite(ky)) || Math.abs(kx) < 1e-6 || Math.abs(ky) < 1e-6) return null;
  const zx = 100 / kx, zy = 100 / ky;
  return (x, y) => ({ x: (x - o.x) * zx, y: (y - o.y) * zy });
}

// ------------------------------------------------------------------ party roster

export type RosterState = 'alive' | 'dead' | 'waiting' | 'out';

export interface RosterRow { playerId: PlayerId; name: string; state: RosterState; me: boolean; bot: boolean }

export interface RosterMember { playerId: PlayerId; name: string; isBot: boolean }

/**
 * The party list the rift shows instead of the team-score strip: each member and whether they fly, are down, wait
 * for the next floor (out of lives) or are out (extracted). `extracted` = pids seen extracting this run.
 */
export function rosterModel(
  members: readonly RosterMember[], ships: readonly Pick<ShipView, 'playerId' | 'alive'>[], view: Pick<RiftView, 'waiting'> | null | undefined,
  extracted: ReadonlySet<PlayerId>, myPid: PlayerId,
): RosterRow[] {
  const alive = new Map<PlayerId, boolean>();
  for (const s of ships) if (s.playerId) alive.set(s.playerId, (alive.get(s.playerId) ?? false) || s.alive);
  const waiting = new Set(Array.isArray(view?.waiting) ? view!.waiting : []);
  return members.map((m) => {
    const state: RosterState = extracted.has(m.playerId) ? 'out'
      : waiting.has(m.playerId) ? 'waiting'
        : alive.get(m.playerId) ? 'alive' : 'dead';
    return { playerId: m.playerId, name: m.name, state, me: m.playerId === myPid, bot: m.isBot };
  }).sort((a, b) => Number(b.me) - Number(a.me) || Number(a.bot) - Number(b.bot) || a.name.localeCompare(b.name));
}

export const ROSTER_GLYPHS: Readonly<Record<RosterState, string>> = { alive: '●', dead: '✕', waiting: '⌛', out: '⇪' };

// ------------------------------------------------------------------ results

export interface RiftResultModel {
  /** Small line above the title (VICTORY / RUN OVER ...). */
  sub: string;
  /** RIFT CONQUERED · EXTRACTED — F3 · PARTY WIPED — F5 · ABANDONED */
  title: string;
  /** "Floor 3/6 · 9 rooms · 1 boss · 18:40" */
  line: string;
  /** What happened to the viewer ("You extracted on floor 3 — caches banked"). '' = not in the run. */
  you: string;
  good: boolean;
}

export function riftStatusLabel(p: RiftResult['players'][number] | undefined): string {
  if (!p) return '—';
  switch (p.status) {
    case 'extracted': return `Extracted F${Math.max(1, int(p.floor, 1))}`;
    case 'survived': return 'Survived';
    case 'lost': return `Lost F${Math.max(1, int(p.floor, 1))}`;
    case 'left': return 'Left';
    default: return '—';
  }
}

export function riftResultModel(r: RiftResult, me: PlayerId): RiftResultModel {
  const reached = Math.max(1, int(r.floorReached, 1));
  const total = Math.max(1, int(r.floorsTotal, reached));
  const rooms = Math.max(0, int(r.roomsCleared));
  const bosses = Math.max(0, int(r.bossesKilled));
  const line = [
    `Floor ${reached}/${total}`,
    `${rooms} ${rooms === 1 ? 'room' : 'rooms'}`,
    bosses ? `${bosses} ${bosses === 1 ? 'boss' : 'bosses'}` : '',
    r.timeSec > 0 ? fmtMinSec(r.timeSec, false) : '',
  ].filter(Boolean).join(' · ');
  const mine = Array.isArray(r.players) ? r.players.find((p) => p.playerId === me) : undefined;
  let you = '';
  if (mine) {
    if (mine.status === 'extracted') you = `You extracted on floor ${Math.max(1, int(mine.floor, 1))} — caches banked.`;
    else if (mine.status === 'survived') you = 'You made it out — caches banked.';
    else if (mine.status === 'lost') you = 'Your unsecured caches were lost.';
    else if (mine.status === 'left') you = 'You left the run.';
  }
  switch (r.outcome) {
    case 'cleared': return { sub: 'VICTORY', title: 'RIFT CONQUERED', line: `All ${total} floors cleared · ${line}`, you, good: true };
    case 'extracted': return { sub: 'RUN COMPLETE', title: `EXTRACTED — F${reached}`, line, you, good: true };
    case 'wiped': return { sub: 'RUN OVER', title: `PARTY WIPED — F${reached}`, line: `${line} · unsecured loot lost`, you, good: false };
    case 'abandoned': return { sub: 'RUN OVER', title: 'ABANDONED', line: `Run abandoned on floor ${reached} · ${line}`, you, good: false };
    default: return { sub: 'RUN OVER', title: 'RIFT CLOSED', line, you, good: false };
  }
}

/** Status per player id for the results table's rift column. */
export function riftStatusMap(r: RiftResult | undefined): Map<PlayerId, string> {
  const out = new Map<PlayerId, string>();
  if (!r || !Array.isArray(r.players)) return out;
  for (const p of r.players) out.set(p.playerId, riftStatusLabel(p));
  return out;
}

// ------------------------------------------------------------------ lobby

/** Boss / extraction floors of an N-floor run (every RIFT_BOSS_EVERY-th). */
export function bossFloors(floors: number): number[] {
  const out: number[] = [];
  for (let f = RIFT_BOSS_EVERY; f <= Math.max(0, Math.floor(floors)); f += RIFT_BOSS_EVERY) out.push(f);
  return out;
}

/** Room lobby rules line: "▼ One party… 6 floors · the Matriarch waits on floors 3 and 6 · extract after a boss…". */
export function riftRulesLine(floors: number): string {
  const d = SUB_MODES.coop;
  const n = Math.max(1, Math.floor(floors) || 6);
  const bosses = bossFloors(n);
  const where = bosses.length > 1 ? `floors ${bosses.slice(0, -1).join(', ')} and ${bosses[bosses.length - 1]}` : `floor ${bosses[0] ?? n}`;
  return `${d.icon} ${d.blurb} ${n} floors · the Matriarch waits on ${where} · extract after a boss to bank your caches.`;
}

// ------------------------------------------------------------------ misc

/** Ship id → its player's name, for "watching X" (the followed ship's pilot). */
export function shipPilotName(ships: readonly Pick<ShipView, 'id' | 'playerId'>[], id: EntityId, name: (pid: PlayerId) => string): string {
  if (!id) return '';
  const s = ships.find((v) => v.id === id);
  return s ? name(s.playerId) : '';
}
