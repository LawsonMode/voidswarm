// OWNER: ROOM agent. Per-client Snapshot construction (hot path: up to 32 recipients x 20 Hz).
// prepare() builds every view once per snapshot tick; build() filters those shared views per viewer.
import {
  ATTACH_COOLDOWN_SEC, INTEREST_RADIUS, LOOT_BEACON_RARITY, MAX_CARRIED, MAX_CARRIED_DUNGEON, TICK_RATE,
} from '../constants';
import { TALENTS, pathIndex } from '../data/ships';
import { buildRiftView, riftYou } from '../sim/dungeon';
import { carryCap } from '../sim/loot';
import { buildObjectiveView } from '../sim/objectives/index';
import { UPGRADES } from '../sim/pve/upgrades';
import { gameTypeOf, isDungeon, sameTeam, subModeOf } from '../sim/world';
import {
  SHIPFLAG_CLOAKED,
  type CarryView, type DeployableKind, type DeployableView, type EnemyView, type EntityId, type GameEvent, type GemView,
  type LootView, type MatchView, type PlayerId, type ProjectileView, type Rarity, type Ship, type ShipView,
  type Snapshot, type World, type YouState,
  GLOBAL_EVENT_TYPES,
} from '../types';

/** Cloaked opponents are visible within this distance of the viewer. */
export const CLOAK_DETECT_RADIUS = 180;
const EVENT_RADIUS = INTEREST_RADIUS + 200;

interface EvEntry { ev: GameEvent; global: boolean; x: number; y: number }

export interface SnapshotViewer {
  playerId: PlayerId;
  /** Real playing member (has/should have a ship). false = spectator. */
  spectator: boolean;
}

function cdSec(readyTick: number, tick: number): number {
  return readyTick > tick ? (readyTick - tick) / TICK_RATE : 0;
}

function cdFrac(readyTick: number, tick: number, cooldownSec: number): number {
  if (readyTick <= tick) return 0;
  const total = Math.max(1, cooldownSec * TICK_RATE);
  return Math.min(1, (readyTick - tick) / total);
}

export class SnapshotBuilder {
  private world: World | null = null;
  private shipViews: ShipView[] = [];
  private shipRefs: Ship[] = [];
  private enemies: EnemyView[] = [];
  private projectiles: ProjectileView[] = [];
  private gems: GemView[] = [];
  private deployables: DeployableView[] = [];
  /** v0.3 M2: every in-world cache this tick (interest-filtered per viewer; epic+ always sent). */
  private loot: LootView[] = [];
  /** v0.3 M2: every ship carrying caches (per viewer: only ships that viewer can see). */
  private carry: CarryView[] = [];
  /** carryCap(world), once per tick (0 = loot off and nothing carried: omitted from YouState). */
  private carryCap = 0;
  private events: EvEntry[] = [];
  private depCounts = new Map<EntityId, Partial<Record<DeployableKind, number>>>();
  private match!: MatchView;
  /**
   * Spectator camera target per viewer. Mirrors the client's default spectate rule (GameClient
   * buildFrame): keep following a ship while it is alive, else take the first alive, unattached ship in
   * snapshot order. Interest is centred on that ship, so the entities around what the spectator's camera
   * shows are actually sent.
   */
  private specTargets = new Map<PlayerId, EntityId>();
  /**
   * NET-1: the ship each spectator's client says its camera follows (ClientMsg 'spectate'; manual
   * cycling and the client's own fallback). Wins over the default rule while that ship exists and is
   * alive; an unknown or dead id falls back to the default rule (and is forgotten).
   */
  private specRequests = new Map<PlayerId, EntityId>();

  /** Forget spectator camera targets: one viewer's (it got a fresh matchStart / left) or all (new match). */
  resetSpectator(playerId?: PlayerId): void {
    if (playerId === undefined) { this.specTargets.clear(); this.specRequests.clear(); }
    else { this.specTargets.delete(playerId); this.specRequests.delete(playerId); }
  }

  /** A spectator's client camera follows `shipId` (0 = back to the server's default rule, from scratch). */
  setSpectateTarget(playerId: PlayerId, shipId: EntityId): void {
    if (Number.isInteger(shipId) && shipId > 0) this.specRequests.set(playerId, shipId);
    else this.resetSpectator(playerId);
  }

  /** Build all shared views for this tick. `events` = events since the previous snapshot. */
  prepare(world: World, events: GameEvent[]): void {
    this.world = world;
    const tick = world.tick;

    this.shipViews = [];
    this.shipRefs = [];
    for (const s of world.ships.values()) {
      let turretSlot = -1, turretCount = s.turrets.length;
      if (s.attachedTo) {
        const host = world.ships.get(s.attachedTo);
        if (host) { turretSlot = host.turrets.indexOf(s.id); turretCount = host.turrets.length; }
        else turretCount = 0;
      }
      const orb = s.upgrades['orbit'];
      const ss = s.skillState;
      this.shipViews.push({
        id: s.id, playerId: s.playerId, team: s.team, shipClass: s.shipClass,
        x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle,
        energyFrac: s.stats.maxEnergy > 0 ? Math.max(0, Math.min(1, s.energy / s.stats.maxEnergy)) : 0,
        alive: s.alive, attachedTo: s.attachedTo, turretSlot, turretCount,
        flags: s.flags, level: s.level, orbitals: orb ? orb + 1 : 0,
        pathIdx: pathIndex(s.shipClass, s.path),
        beamLen: ss.beamLen ?? 0, beamKind: ss.beamKind ?? 0, resonance: ss.resonance ?? 1,
      });
      this.shipRefs.push(s);
    }

    this.enemies = [];
    for (const e of world.enemies.values()) {
      this.enemies.push({
        id: e.id, kind: e.kind, x: e.x, y: e.y, angle: e.angle,
        hpFrac: e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0, radius: e.radius, elite: e.elite,
      });
    }
    this.projectiles = [];
    for (const p of world.projectiles.values()) {
      this.projectiles.push({
        id: p.id, kind: p.kind, x: p.x, y: p.y, vx: p.vx, vy: p.vy, team: p.ownerTeam, ownerId: p.ownerId, level: p.level,
      });
    }
    this.deployables = [];
    this.depCounts.clear();
    for (const d of world.deployables.values()) {
      const life = d.expireTick - d.spawnTick;
      this.deployables.push({
        id: d.id, kind: d.kind, ownerId: d.ownerId, team: d.team, x: d.x, y: d.y, angle: d.angle,
        hpFrac: d.maxHp > 0 ? Math.max(0, Math.min(1, d.hp / d.maxHp)) : 1, radius: d.radius, length: d.length,
        lifeFrac: life > 0 ? Math.max(0, Math.min(1, (d.expireTick - tick) / life)) : 1,
      });
      let c = this.depCounts.get(d.ownerId);
      if (!c) { c = {}; this.depCounts.set(d.ownerId, c); }
      c[d.kind] = (c[d.kind] ?? 0) + 1;
    }
    this.gems = [];
    for (const g of world.gems.values()) this.gems.push({ id: g.id, x: g.x, y: g.y, value: g.value });

    // v0.3 M2 loot: caches (the item inside is rolled only at grant time — views carry rarity + set only).
    this.loot = [];
    if (world.loot) {
      for (const l of world.loot.values()) {
        const life = l.expireTick - l.spawnTick;
        const forever = !Number.isFinite(l.expireTick) || l.expireTick >= Number.MAX_SAFE_INTEGER || life <= 0;
        this.loot.push({
          id: l.id, x: l.x, y: l.y, rarity: l.token.rarity, set: l.token.set,
          // 0 = anyone may take it right now (the priority window is over).
          reservedFor: l.reservedFor && l.reservedUntilTick > tick ? l.reservedFor : 0,
          lifeFrac: forever ? 1 : Math.max(0, Math.min(1, (l.expireTick - tick) / life)),
        });
      }
    }
    this.carry = [];
    for (const s of this.shipRefs) {
      const c = s.carried;
      if (!c || !c.length) continue;
      let best = 0;
      for (const t of c) if (t.rarity > best) best = t.rarity;
      this.carry.push({ shipId: s.id, n: c.length, best: best as Rarity });
    }
    this.carryCap = 0;
    if ((world.config.lootMult ?? 0) > 0 || this.carry.length) {
      try { this.carryCap = carryCap(world); } catch { this.carryCap = isDungeon(world) ? MAX_CARRIED_DUNGEON : MAX_CARRIED; }
    }

    this.events = [];
    for (const ev of events) {
      if (GLOBAL_EVENT_TYPES.has(ev.t)) { this.events.push({ ev, global: true, x: 0, y: 0 }); continue; }
      let x: number, y: number;
      if (ev.t === 'arc') { x = ev.points[0] ?? 0; y = ev.points[1] ?? 0; }
      else if (ev.t === 'beam') {
        const from = world.ships.get(ev.fromId) ?? world.ships.get(ev.toId);
        if (!from) continue; // both ends gone: nothing to draw
        x = from.x; y = from.y;
      }
      else if ('x' in ev) { x = ev.x; y = ev.y; }
      else { this.events.push({ ev, global: true, x: 0, y: 0 }); continue; }
      this.events.push({ ev, global: false, x, y });
    }

    const m = world.match;
    const timed = m.endTick > 0;
    // One MatchView per snapshot tick, shared by every viewer (the codec memoizes its JSON by identity).
    const match: MatchView = {
      phase: m.phase, mode: world.config.mode, teamCount: world.config.mode === 'teams' ? world.config.teamCount : 0,
      timeLeftSec: timed ? Math.max(0, (m.endTick - tick) / TICK_RATE) : 0, teamScores: m.teamScores.slice(),
      wave: world.pve.wave, winnerTeam: m.winnerTeam, winnerPlayerId: m.winnerPlayerId,
      timed, gameType: gameTypeOf(world.config), subMode: subModeOf(world.config),
    };
    if (world.dungeon) match.dungeon = buildRiftView(world);
    if (world.objective) {
      const ov = buildObjectiveView(world);
      if (ov) match.objective = ov;
    }
    this.match = match;
  }

  /** Per-viewer filtered snapshot. Must be called after prepare(). */
  build(viewer: SnapshotViewer): Snapshot {
    const world = this.world!;
    const tick = world.tick;
    const shipId = viewer.spectator ? 0 : (world.shipsByPlayer.get(viewer.playerId) ?? 0);
    const me = shipId ? world.ships.get(shipId) ?? null : null;
    const you = me ? this.you(me, viewer.playerId, tick) : null;

    let fx: number, fy: number;
    if (me) {
      fx = me.x; fy = me.y;
      // v0.3 rift: a pilot out of lives waits for the next floor with the camera on RiftYou.followId, so interest
      // (enemies, shots, gems, positional events) follows that ship instead of the wreck.
      const fid = !me.alive && you?.rift?.waiting ? you.rift.followId : 0;
      const f = fid ? world.ships.get(fid) : undefined;
      if (f && f.alive) { fx = f.x; fy = f.y; }
    } else {
      const t = this.spectatorTarget(viewer.playerId);
      if (t) { fx = t.x; fy = t.y; } else { fx = world.map.width / 2; fy = world.map.height / 2; }
    }

    // ships: everyone, minus cloaked opponents out of detection range. v0.3 fix #2: a viewer without a
    // ship (spectator, or a pilot waiting to rejoin) gets NO cloaked ship at all, so a second connection
    // can't be used to see where the other side's cloakers are.
    const ships: ShipView[] = [];
    const cloakR2 = CLOAK_DETECT_RADIUS * CLOAK_DETECT_RADIUS;
    /** Ships this viewer does not receive (hidden cloakers): nothing else may give their position away. */
    let hidden: Set<EntityId> | null = null;
    for (let i = 0; i < this.shipViews.length; i++) {
      const v = this.shipViews[i];
      if (v.flags & SHIPFLAG_CLOAKED) {
        if (!me) { (hidden ??= new Set()).add(v.id); continue; }
        if (v.id !== me.id && !sameTeam(me.team, v.team)) {
          const dx = v.x - me.x, dy = v.y - me.y;
          if (dx * dx + dy * dy > cloakR2) { (hidden ??= new Set()).add(v.id); continue; }
        }
      }
      ships.push(v);
    }

    const r2 = INTEREST_RADIUS * INTEREST_RADIUS;
    const enemies: EnemyView[] = [];
    for (const e of this.enemies) { const dx = e.x - fx, dy = e.y - fy; if (dx * dx + dy * dy <= r2) enemies.push(e); }
    const projectiles: ProjectileView[] = [];
    for (const p of this.projectiles) { const dx = p.x - fx, dy = p.y - fy; if (dx * dx + dy * dy <= r2) projectiles.push(p); }
    const gems: GemView[] = [];
    for (const g of this.gems) { const dx = g.x - fx, dy = g.y - fy; if (dx * dx + dy * dy <= r2) gems.push(g); }
    const deployables: DeployableView[] = [];
    for (const d of this.deployables) {
      const pad = INTEREST_RADIUS + d.length * 0.5 + d.radius;
      const dx = d.x - fx, dy = d.y - fy;
      if (dx * dx + dy * dy <= pad * pad) deployables.push(d);
    }
    const er2 = EVENT_RADIUS * EVENT_RADIUS;
    const events: GameEvent[] = [];
    for (const e of this.events) {
      // lootPickup is global (every client hears it) but carries the picker's position: drop it for a hidden cloaker.
      if (hidden && e.ev.t === 'lootPickup' && hidden.has(e.ev.shipId)) continue;
      if (e.global) { events.push(e.ev); continue; }
      const dx = e.x - fx, dy = e.y - fy;
      if (dx * dx + dy * dy <= er2) events.push(e.ev);
    }

    const snap: Snapshot = {
      tick, ackSeq: me ? me.lastInputSeq : 0, you,
      ships, enemies, projectiles, gems, deployables, events, match: this.match,
    };
    // v0.3 M2: caches near the focus, plus every epic+ cache (map-wide radar). Absent = none (like the codec).
    if (this.loot.length) {
      const loot: LootView[] = [];
      for (const l of this.loot) {
        if (l.rarity >= LOOT_BEACON_RARITY) { loot.push(l); continue; }
        const dx = l.x - fx, dy = l.y - fy;
        if (dx * dx + dy * dy <= r2) loot.push(l);
      }
      if (loot.length) snap.loot = loot;
    }
    // Carriers the viewer can see (every ship is sent, except hidden cloakers — whose carry would give them away).
    if (this.carry.length) {
      const hid = hidden;
      const carry = hid ? this.carry.filter((c) => !hid.has(c.shipId)) : this.carry;
      if (carry.length) snap.carry = carry;
    }
    return snap;
  }

  /**
   * The ship a spectating viewer's camera follows, or null when no ship is alive: the client's requested
   * target (specRequests) while it is alive, else the default rule (see specTargets).
   */
  private spectatorTarget(playerId: PlayerId): Ship | null {
    const world = this.world!;
    const req = this.specRequests.get(playerId);
    if (req) {
      const r = world.ships.get(req);
      if (r && r.alive) { this.specTargets.set(playerId, r.id); return r; }
      this.specRequests.delete(playerId); // unknown / dead: the server default takes over
    }
    const cur = this.specTargets.get(playerId);
    const s = cur ? world.ships.get(cur) : undefined;
    if (s && s.alive) return s;
    let next: Ship | null = null;
    for (const r of this.shipRefs) if (r.alive && !r.attachedTo) { next = r; break; }
    this.specTargets.set(playerId, next ? next.id : 0);
    return next;
  }

  private you(s: Ship, playerId: PlayerId, tick: number): YouState {
    const upgrades: YouState['upgrades'] = [];
    const talents: string[] = [];
    for (const id in s.upgrades) {
      const level = s.upgrades[id];
      if (TALENTS[id]) { if (level > 0) talents.push(id); continue; }
      if (id.startsWith('path:')) continue;
      const def = UPGRADES[id];
      upgrades.push(def
        ? { id, name: def.name, icon: def.icon, level, maxLevel: def.maxLevel }
        : { id, name: id, icon: '?', level, maxLevel: Math.max(level, 1) });
    }
    const st = s.stats;
    const you: YouState = {
      playerId, shipId: s.id, alive: s.alive,
      respawnIn: s.alive ? 0 : Math.max(0, (s.respawnTick - tick) / TICK_RATE),
      energy: s.energy, stats: st, xp: s.xp, xpToNext: s.xpToNext, level: s.level,
      offer: s.offers[0] ?? null, offerId: Number.isFinite(s.offerSerial) ? s.offerSerial : 0, queuedOffers: Math.max(0, s.offers.length - 1), upgrades,
      cd: {
        primary: cdFrac(s.gunReadyTick, tick, st.gunCooldown),
        secondary: cdFrac(s.secondaryReadyTick, tick, st.secondaryCooldown),
        mobility: cdFrac(s.mobilityReadyTick, tick, st.mobilityCooldown),
        utility: cdFrac(s.utilityReadyTick, tick, st.utilityCooldown),
        attach: cdFrac(s.attachReadyTick, tick, ATTACH_COOLDOWN_SEC),
      },
      cdSec: {
        secondary: cdSec(s.secondaryReadyTick, tick),
        mobility: cdSec(s.mobilityReadyTick, tick),
        utility: cdSec(s.utilityReadyTick, tick),
      },
      deployables: { ...(this.depCounts.get(s.id) ?? {}) },
      path: s.path, talents,
      bounty: s.bounty, attachedTo: s.attachedTo, turrets: s.turrets.slice(),
      skillActive: s.utilityActiveUntilTick > tick || s.mobilityActiveUntilTick > tick,
    };
    const world = this.world;
    if (world && world.dungeon) you.rift = riftYou(world, s);
    // v0.3 M2: your unsecured caches (rarity desc) and the cap (HUD tray, HOLD FULL). Absent = none / loot off.
    if (s.carried && s.carried.length) {
      you.carried = s.carried.map((t) => ({ rarity: t.rarity, set: t.set })).sort((a, b) => b.rarity - a.rarity);
    }
    if (this.carryCap > 0) you.carryCap = this.carryCap;
    return you;
  }
}
