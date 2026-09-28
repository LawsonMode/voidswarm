// OWNER: SIM agent. Frozen public API (Room depends on it).
import {
  DT, HOST_SPEED_PENALTY_PER_TURRET, MAX_PARTIES, MAX_TEAMS, RIFT_FLOOR_INVULN_SEC, RIFT_FLOOR_OPTIONS, SPAWN_INVULN_SEC,
  TURRET_RECHARGE_MULT,
} from '../constants';
import { isGameType, isLegalCombo, isSubMode } from '../data/gameTypes';
import { SHIP_CLASSES } from '../data/ships';
import { DEFAULT_SETTINGS_BY_TYPE } from '../protocol';
import type {
  CacheToken, EntityId, GameEvent, GameMode, GameType, InputState, PlayerId, Ship, ShipClassId, SimConfig, SubMode,
  TeamId, World,
} from '../types';
import {
  BEAM_NONE, emptyInput, SHIPFLAG_AFTERBURNER, SHIPFLAG_BOT, SHIPFLAG_CHARGING, SHIPFLAG_INVULN, SHIPFLAG_SHIELD,
  SHIPFLAG_THRUSTING,
} from '../types';
import { computeBounty, isCharging, shieldAbsorb } from './combat';
import { killDeployable, stepDeployables } from './deployables';
import { createRiftState, endRift, resetRiftFloor, riftEntrancePoint, riftSpawnPoint, stepRift } from './dungeon';
import { riftTier } from './floorgen';
import { releaseLootFor, spillCarried, stepLoot } from './loot';
import { collideCircle } from './map';
import { buildMatchMap } from './mapgen';
import { stepShipMovement, THRUST_DEADZONE, turnToward } from './movement';
import {
  objectiveEndCheck, objectiveRelease, objectiveSpawnPoint, objectivesInit, objRechargeMult, objSpeedMult,
  stepObjectives,
} from './objectives/index';
import { stepProjectiles } from './projectiles';
import { applyUpgradeChoice, pveInit, pveStep, rebuildOffers, riftFloorInit, xpToNextFor } from './pve/index';
import { computeStats, resolvePath } from './pve/upgrades';
import { boostMult, stepCharge, stepClassSkills } from './skills';
import { side } from './state';
import { stepTalents } from './talents';
import { has } from './targeting';
import { stepTurretKit } from './turretkits';
import { detachAll, detachTurret, hostHasClamp, placeTurret, shakeOffTurrets, tryAttach } from './turrets';
import {
  allocId, createWorld, effectiveTeam, emit, gameTypeOf, isDungeon, rebuildGrid, sameTeam, secToTicks, subModeOf,
} from './world';

/** med_revive: radius around the medic and per-teammate cooldown. */
export const REVIVE_RADIUS = 500;
export const REVIVE_COOLDOWN_SEC = 20;
/** bul_clamp: turrets on a Clamp host recharge this much faster (on top of TURRET_RECHARGE_MULT). */
export const CLAMP_RECHARGE_MULT = 1.5;

export interface AddPlayerOpts {
  playerId: PlayerId;
  name: string;
  /** Real team index (0..teamCount-1) in teams mode; ignored in FFA. */
  team: TeamId;
  shipClass: ShipClassId;
  isBot: boolean;
}

function fin(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** lootMult: a finite number ≥ 0 (anything else = 0 = in-world loot off). */
function sanitizeLootMult(v: unknown): number {
  return Math.max(0, fin(v, 0));
}

/**
 * v0.3 constructor normalization (§8.8). Always returns a config with explicit `gameType` / `subMode`
 * (kept in world.config), `mode` ∈ {teams, ffa} and a `teamCount` that matches it (0 in FFA):
 * - gameType: explicit if valid, else gameTypeOf() (pveIntensity > 0 ? warzone : arena); subMode: explicit
 *   if valid, else subModeOf() (deathmatch; coop in a dungeon).
 * - dungeon: mode 'teams', teamCount clamped to [1, MAX_PARTIES], matchSeconds 0 (untimed), floors ∈
 *   RIFT_FLOOR_OPTIONS (default 6); an illegal combo falls back to coop / teams / 1.
 * - arena / warzone: an illegal combo (isLegalCombo, readiness NOT checked) falls back to 'deathmatch';
 *   teams mode clamps teamCount to 2..MAX_TEAMS exactly as v0.2 did.
 * A v0.2 config (no v0.3 fields) normalizes to the v0.2 behaviour: same map, same teams, same rng stream.
 */
export function normalizeSimConfig(config: SimConfig): SimConfig {
  const cfg: SimConfig = { ...config };
  const rawTeams = Math.floor(fin(cfg.teamCount, 0));
  let mode: GameMode = cfg.mode === 'teams' ? 'teams' : 'ffa';
  const gameType: GameType = isGameType(cfg.gameType) ? cfg.gameType : gameTypeOf({ ...cfg, gameType: undefined });
  let subMode: SubMode = isSubMode(cfg.subMode) ? cfg.subMode : subModeOf({ ...cfg, gameType, subMode: undefined });
  let teamCount: number;
  if (gameType === 'dungeon') {
    mode = 'teams';
    teamCount = clampInt(rawTeams || 1, 1, MAX_PARTIES);
    if (!isLegalCombo(gameType, subMode, mode, teamCount)) { subMode = 'coop'; teamCount = 1; }
    cfg.matchSeconds = 0;
    cfg.floors = RIFT_FLOOR_OPTIONS.includes(fin(cfg.floors, 0)) ? cfg.floors : DEFAULT_SETTINGS_BY_TYPE.dungeon.floors;
  } else {
    if (!isLegalCombo(gameType, subMode, mode, rawTeams)) subMode = 'deathmatch';
    teamCount = mode === 'teams' ? clampInt(rawTeams || 2, 2, MAX_TEAMS) : 0;
  }
  cfg.gameType = gameType;
  cfg.subMode = subMode;
  cfg.mode = mode;
  cfg.teamCount = teamCount;
  // §1.3.A: scoreLimit is a Deathmatch rule; objective sub-modes use objectiveLimit and a rift has neither.
  if (subMode !== 'deathmatch') cfg.scoreLimit = 0;
  if (cfg.lootMult !== undefined) cfg.lootMult = sanitizeLootMult(cfg.lootMult);
  return cfg;
}

/** Transient skillState keys cleared on (re)spawn. Persistent ones (healDone, shotCount, reviveReadyTick…) survive. */
const TRANSIENT_KEYS = [
  'charging', 'chargeDirX', 'chargeDirY', 'hide', 'extShieldUntil', 'extShieldAbsorb', 'boostUntil', 'braceTick',
  'braceAbsorb', 'entropyTick', 'laserAcc', 'laserTarget', 'laserAccTick', 'laserTick', 'laserN', 'beamLen', 'beamKind',
  'resonance', 'droneWait',
];

// ---------------------------------------------------------------------------------------------
// Input buffering (one input per tick). Clients send one InputState per client tick; bursts
// (slow frames, TCP head-of-line stalls, server catch-up ticks) are queued and replayed one per
// sim tick so no press edge is lost and ackSeq advances exactly one input per step.
// ---------------------------------------------------------------------------------------------

/** Max queued inputs per ship. Beyond this, one queued input is dropped (presses are kept). */
export const MAX_INPUT_QUEUE = 8;
/**
 * Latency control: if the queue never ran dry during this many ticks, that standing surplus is
 * drained (only by skipping inputs whose buttons equal the next one's, so no edge is ever lost).
 */
export const INPUT_DRAIN_WINDOW = 30;

const BUTTONS = ['primary', 'secondary', 'mobility', 'utility', 'afterburner', 'attach', 'detach'] as const;

function sameButtons(a: InputState, b: InputState): boolean {
  for (const k of BUTTONS) if (a[k] !== b[k]) return false;
  return true;
}

/** Merge `older` into `newer` (newer keeps its analog state and seq); any button held in either stays held. */
function foldInto(older: InputState, newer: InputState): void {
  if (older.attach && !newer.attach) newer.attachTarget = older.attachTarget;
  for (const k of BUTTONS) newer[k] = newer[k] || older[k];
}

/** Remove one queued input: prefer a lossless skip (next input has the same buttons); else fold the oldest forward. */
function dropOneInput(q: InputState[]): void {
  for (let i = 0; i + 1 < q.length; i++) {
    if (sameButtons(q[i], q[i + 1])) { q.splice(i, 1); return; }
  }
  foldInto(q[0], q[1]);
  q.shift();
}

function sanitizeInput(input: InputState, last: InputState): InputState {
  let mx = fin(input.moveX, 0), my = fin(input.moveY, 0);
  mx = Math.max(-1, Math.min(1, mx)); my = Math.max(-1, Math.min(1, my));
  const m = Math.sqrt(mx * mx + my * my);
  if (m > 1) { mx /= m; my /= m; }
  return {
    seq: fin(input.seq, last.seq),
    moveX: mx, moveY: my,
    aim: fin(input.aim, last.aim),
    aimDist: Math.max(0, Math.min(2000, fin(input.aimDist, 300))),
    primary: !!input.primary,
    secondary: !!input.secondary,
    mobility: !!input.mobility,
    utility: !!input.utility,
    afterburner: !!input.afterburner,
    attach: !!input.attach,
    attachTarget: Math.max(0, Math.floor(fin(input.attachTarget, 0))),
    detach: !!input.detach,
  };
}

interface InputQueue {
  q: InputState[];
  /** Smallest queue length seen after consuming, over the current window. */
  minLen: number;
  win: number;
  /** Surplus inputs still to drain. */
  drain: number;
}

export class Sim {
  readonly world: World;
  /** Afterburner actually engaged this tick, per ship id (scratch). */
  private abOn = new Set<EntityId>();
  /** Pending client inputs per ship id (see MAX_INPUT_QUEUE). */
  private inputQ = new Map<EntityId, InputQueue>();

  /**
   * §5.2 order: normalize the config → buildMatchMap → createWorld → (dungeon: createRiftState) → pveInit →
   * objectivesInit. A rift starts on floor 1: pveInit runs PVE's riftFloorInit for it (Sim.enterFloor for the rest).
   */
  constructor(config: SimConfig) {
    const cfg = normalizeSimConfig(config);
    const map = buildMatchMap({
      seed: cfg.mapSeed, gameType: cfg.gameType!, subMode: cfg.subMode!,
      teamCount: cfg.mode === 'teams' ? cfg.teamCount : 0, floor: cfg.gameType === 'dungeon' ? 1 : 0,
    });
    this.world = createWorld(cfg, map);
    if (cfg.gameType === 'dungeon') this.world.dungeon = createRiftState(this.world);
    pveInit(this.world);
    if (this.world.dungeon) this.world.pve.wave = riftTier(this.world.dungeon.floor); // the tier (PVE sets it too)
    objectivesInit(this.world);
  }

  private shipOf(playerId: PlayerId): Ship | undefined {
    const id = this.world.shipsByPlayer.get(playerId);
    return id ? this.world.ships.get(id) : undefined;
  }

  private sanitizeTeam(team: TeamId): TeamId {
    const w = this.world;
    if (w.config.mode !== 'teams') return effectiveTeam(w, team);
    const n = w.config.teamCount;
    if (Number.isInteger(team) && team >= 0 && team < n) return team;
    // invalid → smallest team
    const counts = new Array(n).fill(0);
    for (const s of w.ships.values()) if (s.team >= 0 && s.team < n) counts[s.team]++;
    let best = 0;
    for (let t = 1; t < n; t++) if (counts[t] < counts[best]) best = t;
    return best;
  }

  /** Create the player's ship and spawn it (with spawn invulnerability). Returns ship id. */
  addPlayer(opts: AddPlayerOpts): EntityId {
    const w = this.world;
    if (w.shipsByPlayer.has(opts.playerId)) this.removePlayer(opts.playerId);
    const shipClass: ShipClassId = SHIP_CLASSES[opts.shipClass] ? opts.shipClass : 'brute';
    const upgrades: Record<string, number> = {};
    const stats = computeStats(shipClass, upgrades);
    const id = allocId(w);
    const ship: Ship = {
      id, playerId: opts.playerId, name: opts.name, team: this.sanitizeTeam(opts.team), shipClass, isBot: opts.isBot,
      x: 0, y: 0, vx: 0, vy: 0, angle: 0,
      alive: false, respawnTick: 0, invulnUntilTick: 0,
      energy: stats.maxEnergy, stats,
      input: emptyInput(), prevInput: emptyInput(), lastInputSeq: 0,
      path: null,
      gunReadyTick: 0, secondaryReadyTick: 0, mobilityReadyTick: 0, utilityReadyTick: 0, attachReadyTick: 0,
      utilityActiveUntilTick: 0, mobilityActiveUntilTick: 0,
      skillState: {},
      attachedTo: 0, turrets: [],
      xp: 0, level: 1, xpToNext: xpToNextFor(1), offers: [], offerSerial: 0, upgrades, autoState: {},
      kills: 0, deaths: 0, score: 0, bounty: 0, killStreak: 0, enemyKills: 0,
      lastDamagedBy: 0, lastDamagedTick: 0,
      flags: opts.isBot ? SHIPFLAG_BOT : 0,
    };
    ship.bounty = computeBounty(ship);
    w.ships.set(id, ship);
    w.shipsByPlayer.set(opts.playerId, id);
    this.spawnShip(ship);
    return id;
  }

  /**
   * Spawn at a spawn point of the ship's team (or at `at`, e.g. Field Revive). With no `at`: the rift
   * respawn point in a dungeon, else the objective override (if non-null), else the default spawn pick.
   */
  private spawnShip(ship: Ship, at?: { x: number; y: number }): void {
    const w = this.world, map = w.map;
    objectiveRelease(w, ship); // a carried flag drops at the pre-teleport position
    let x = map.width / 2, y = map.height / 2;
    const override = at ?? (isDungeon(w) ? riftSpawnPoint(w, ship) : objectiveSpawnPoint(w, ship));
    if (override) { x = override.x; y = override.y; }
    else {
      let pts = map.spawns.filter((s) => s.team === ship.team);
      if (pts.length === 0) pts = map.spawns.filter((s) => s.team === -1);
      if (pts.length === 0) pts = map.spawns;
      if (pts.length) {
        const picks = Math.min(pts.length, w.config.mode === 'teams' ? 3 : 5);
        let bestScore = -1;
        for (let i = 0; i < picks; i++) {
          const p = pts[w.rng.int(0, pts.length - 1)];
          let minD = Infinity;
          for (const o of w.ships.values()) {
            if (o === ship || !o.alive) continue;
            const d = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
            if (w.config.mode === 'teams' && o.team === ship.team) {
              if (d < 50 * 50) minD = Math.min(minD, d); // only avoid stacking on a teammate
              continue;
            }
            minD = Math.min(minD, d);
          }
          if (minD > bestScore) { bestScore = minD; x = p.x; y = p.y; }
        }
      }
    }
    ship.x = x; ship.y = y; ship.vx = 0; ship.vy = 0;
    ship.angle = Math.atan2(map.height / 2 - y, map.width / 2 - x);
    ship.alive = true;
    ship.energy = ship.stats.maxEnergy;
    ship.invulnUntilTick = w.tick + secToTicks(SPAWN_INVULN_SEC);
    ship.attachedTo = 0;
    ship.turrets.length = 0;
    ship.lastDamagedBy = 0;
    ship.gunReadyTick = w.tick;
    this.clearTransient(ship);
    emit(w, { t: 'shipSpawn', shipId: ship.id, playerId: ship.playerId, x, y });
  }

  /** Drop timed skill effects and transient skill state (spawn, in-place class swap). */
  private clearTransient(ship: Ship): void {
    ship.utilityActiveUntilTick = 0;
    ship.mobilityActiveUntilTick = 0;
    for (const k of TRANSIENT_KEYS) delete ship.skillState[k];
    side(this.world).ramHits.delete(ship.id);
  }

  /**
   * Administrative removal (owner left / switched team / switched class): no death effects, so a
   * Salvage sentry or Collapse well can't blast the team being joined or credit the leaving owner.
   */
  private removeOwnedDeployables(ship: Ship): void {
    for (const d of this.world.deployables.values()) if (d.ownerId === ship.id) killDeployable(this.world, d, false);
  }

  /**
   * Remove ship entirely (detaching turrets). Carried flag drops and carried caches spill first (no
   * priority); caches reserved for the leaver (killer priority, personal rift caches) become free.
   */
  removePlayer(playerId: PlayerId): void {
    const w = this.world;
    const ship = this.shipOf(playerId);
    w.shipsByPlayer.delete(playerId);
    if (!ship) return;
    objectiveRelease(w, ship);
    spillCarried(w, ship, 0);
    releaseLootFor(w, playerId);
    detachAll(w, ship);
    this.removeOwnedDeployables(ship);
    w.ships.delete(ship.id);
    this.abOn.delete(ship.id);
    this.inputQ.delete(ship.id);
    side(w).ramHits.delete(ship.id);
    for (const s of w.ships.values()) if (s.lastDamagedBy === ship.id) s.lastDamagedBy = 0;
  }

  /**
   * Change team: respawns the ship at the new team's spawn (no death penalty). A carried flag drops and
   * carried caches spill first (no priority), while the ship is still on its OLD team, so the drop is
   * attributed to the team that held it (spawnShip's own release is then a no-op).
   */
  setPlayerTeam(playerId: PlayerId, team: TeamId): void {
    const ship = this.shipOf(playerId);
    if (!ship) return;
    objectiveRelease(this.world, ship);
    spillCarried(this.world, ship, 0);
    detachAll(this.world, ship);
    this.removeOwnedDeployables(ship);
    ship.team = this.sanitizeTeam(team);
    ship.killStreak = 0;
    ship.bounty = computeBounty(ship);
    this.spawnShip(ship);
  }

  /**
   * Change class (keeps xp / level / upgrades; queued offers are rebuilt for the new class).
   * - v0.3: ALIVE in a running arena / warzone match → IN PLACE: position, velocity, angle and energy
   *   FRACTION kept; no new spawn invulnerability (remaining protection is not extended); turrets
   *   detached; a carried flag dropped; owned deployables removed (no death effects); cooldowns kept
   *   (a swap never resets them). Same class = no-op.
   * - Otherwise (dead, dungeon, match over): respawns with the new class, as v0.2. An extracted (rOut) or
   *   out-of-lives (rWait) rift pilot only changes class and stays down.
   * The sim only offers the capability: WHEN to call it (now, at the next respawn, at the next floor) is
   * the Room's policy.
   */
  setShipClass(playerId: PlayerId, shipClass: ShipClassId): void {
    const w = this.world;
    const ship = this.shipOf(playerId);
    if (!ship || !SHIP_CLASSES[shipClass]) return;
    const changed = ship.shipClass !== shipClass;
    const inPlace = ship.alive && w.match.phase === 'playing' && gameTypeOf(w.config) !== 'dungeon';
    if (inPlace && !changed) return;
    const vx = ship.vx, vy = ship.vy;
    const oldMax = ship.stats.maxEnergy;
    if (inPlace) objectiveRelease(w, ship);
    detachAll(w, ship);
    this.removeOwnedDeployables(ship);
    ship.shipClass = shipClass;
    ship.path = resolvePath(shipClass, ship.upgrades);
    ship.stats = computeStats(shipClass, ship.upgrades);
    if (changed && ship.offers.length) {
      // Queued offers were built for the old class (its path fork, class-only cards): rebuild them, and
      // bump the serial so a click on the old class's cards (already in flight) is ignored.
      rebuildOffers(w, ship);
      ship.offerSerial = (Number.isFinite(ship.offerSerial) ? ship.offerSerial : 0) + 1;
    }
    if (inPlace) {
      const frac = oldMax > 0 ? Math.max(0, Math.min(1, ship.energy / oldMax)) : 1;
      ship.energy = frac * ship.stats.maxEnergy;
      ship.vx = vx; ship.vy = vy; // detaching as a turret pushed us: keep the pre-swap velocity
      // A bigger hull (tech 16 → brute 22) may now overlap a wall: push it out once. In a gap narrower than
      // the new hull some overlap can remain; movement resolves it over the next ticks without tunnelling.
      const c = collideCircle(w.map, ship.x, ship.y, ship.stats.radius);
      if (c.hit) { ship.x = c.x; ship.y = c.y; }
      this.clearTransient(ship); // the old class's timed effects (Iron Hide, Ram Charge, cloak …)
      emit(w, { t: 'shipSpawn', shipId: ship.id, playerId: ship.playerId, x: ship.x, y: ship.y }); // swap FX
      return;
    }
    if (!ship.alive && (ship.skillState.rOut || ship.skillState.rWait)) return;
    this.spawnShip(ship);
  }

  /** v0.3 loot: the Room's anti-farm multiplier (0 = in-world loot off). Updated on human join / leave. */
  setLootMult(mult: number): void {
    this.world.config.lootMult = sanitizeLootMult(mult);
  }

  /** v0.3 loot, match end: returns the player's carried (unsecured) caches and clears them. */
  takeCarried(playerId: PlayerId): CacheToken[] {
    const ship = this.shipOf(playerId);
    if (!ship || !ship.carried || ship.carried.length === 0) return [];
    const out = ship.carried;
    ship.carried = [];
    return out;
  }

  /**
   * v0.3 rift, host /end: outcome 'abandoned' (emits riftEnd; the next stepMatch ends the match, winner −1).
   * Unsecured caches are lost (the Room secures carried caches only on 'cleared'). No-op outside a running rift.
   */
  abandonRift(): void {
    const d = this.world.dungeon;
    if (!d || d.outcome !== 'running') return;
    endRift(this.world, 'abandoned');
  }

  /**
   * Queue one client input (sanitized). Step consumes exactly one queued input per tick (holding the
   * last one when the queue is empty) and sets ship.lastInputSeq to the seq it applied.
   */
  setInput(playerId: PlayerId, input: InputState): void {
    const ship = this.shipOf(playerId);
    if (!ship || !input) return;
    let iq = this.inputQ.get(ship.id);
    if (!iq) { iq = { q: [], minLen: Infinity, win: 0, drain: 0 }; this.inputQ.set(ship.id, iq); }
    const last = iq.q.length ? iq.q[iq.q.length - 1] : ship.input;
    iq.q.push(sanitizeInput(input, last));
    while (iq.q.length > MAX_INPUT_QUEUE) dropOneInput(iq.q);
  }

  /** Inputs queued for the player's ship and not yet applied (diagnostics / tests). */
  pendingInputs(playerId: PlayerId): number {
    const id = this.world.shipsByPlayer.get(playerId);
    return id ? this.inputQ.get(id)?.q.length ?? 0 : 0;
  }

  /** Apply the next queued input of every ship (start of step). */
  private consumeInputs(): void {
    for (const ship of this.world.ships.values()) {
      const iq = this.inputQ.get(ship.id);
      if (!iq) continue;
      const q = iq.q;
      if (q.length) {
        let next = q.shift()!;
        if (iq.drain > 0 && q.length && sameButtons(next, q[0])) { next = q.shift()!; iq.drain--; }
        Object.assign(ship.input, next);
        ship.lastInputSeq = next.seq;
      }
      if (q.length === 0) iq.drain = 0;
      if (q.length < iq.minLen) iq.minLen = q.length;
      if (++iq.win >= INPUT_DRAIN_WINDOW) {
        if (iq.minLen > 0) iq.drain = iq.minLen;
        iq.win = 0;
        iq.minLen = Infinity;
      }
    }
  }

  /**
   * Pick card `index` of the current offer. `offerId` (YouState.offerId echoed by the client) must match
   * ship.offerSerial or the pick is ignored (a double-press must not spend the next queued offer).
   * Undefined offerId (bots) = accept the current offer.
   */
  chooseUpgrade(playerId: PlayerId, index: number, offerId?: number): void {
    const ship = this.shipOf(playerId);
    if (!ship || !Number.isInteger(index)) return;
    if (offerId !== undefined && offerId !== ship.offerSerial) return;
    applyUpgradeChoice(this.world, ship, index);
  }

  /**
   * med_revive: dead teammates near an alive Medic with Field Revive respawn at the medic, now.
   * v0.3 rift: extracted pilots (rOut) are never revived (fix #5); out-of-lives pilots (rWait) are, for free.
   */
  private fieldRevive(): void {
    const w = this.world;
    if (w.config.mode !== 'teams') return;
    const r2 = REVIVE_RADIUS * REVIVE_RADIUS;
    for (const dead of w.ships.values()) {
      if (dead.alive || dead.skillState.rOut || w.tick < (dead.skillState.reviveReadyTick ?? 0)) continue;
      for (const m of w.ships.values()) {
        if (!m.alive || m.id === dead.id || m.shipClass !== 'engineer' || !sameTeam(m.team, dead.team) || !has(m, 'med_revive')) continue;
        const dx = m.x - dead.x, dy = m.y - dead.y;
        if (dx * dx + dy * dy > r2) continue;
        dead.skillState.reviveReadyTick = w.tick + secToTicks(REVIVE_COOLDOWN_SEC);
        delete dead.skillState.rWait;
        this.spawnShip(dead, { x: m.x, y: m.y });
        emit(w, { t: 'ability', shipId: m.id, skill: 'repair', x: m.x, y: m.y, talent: 'med_revive' });
        break;
      }
    }
  }

  /**
   * Advance exactly one tick (DT seconds). Canonical v0.3 order (proposal §9):
   * tick++ → rebuildGrid → consumeInputs → fieldRevive → pass 1 (respawn: rift / objective / default spawn
   * point; movement × objSpeedMult) → pass 2 (turrets) → pass 3 (energy × objRechargeMult, skills, flags) →
   * pveStep → stepDeployables → stepProjectiles → stepObjectives → stepRift → stepLoot → bounty →
   * enterFloor (if pendingFloor) → stepMatch (objective sub-modes: mirror teamPoints + objectiveEndCheck)
   * → prevInput copy.
   * The objective hooks return their neutral values when world.objective is null (deathmatch, rift), the
   * rift hooks (stepRift, riftSpawnPoint, riftOnDeath, enterFloor) do nothing without world.dungeon, and loot
   * (M2) never touches world.rng and does nothing at lootMult 0, so a lootMult-0 deathmatch tick is v0.2's
   * tick exactly.
   */
  step(): void {
    const w = this.world;
    w.tick++;
    rebuildGrid(w);
    const tick = w.tick;

    this.consumeInputs();
    this.fieldRevive();

    // Pass 1: respawn, edges, attach logic, movement of free ships
    for (const ship of w.ships.values()) {
      this.abOn.delete(ship.id);
      const ss = ship.skillState;
      ss.beamLen = 0; ss.beamKind = BEAM_NONE; ss.resonance = 0;
      if (!ship.alive) {
        if (tick >= ship.respawnTick) this.spawnShip(ship);
        else continue;
      }
      const inp = ship.input, prev = ship.prevInput;
      const attachEdge = inp.attach && !prev.attach;
      const detachEdge = inp.detach && !prev.detach;
      if (attachEdge) {
        if (ship.attachedTo) detachTurret(w, ship);
        else if (tryAttach(w, ship) && (ss.charging ?? 0)) { ss.charging = 0; side(w).ramHits.delete(ship.id); }
      }
      if (detachEdge) {
        if (ship.attachedTo) detachTurret(w, ship);
        else if (ship.turrets.length) shakeOffTurrets(w, ship);
      }
      if (ship.attachedTo) {
        const host = w.ships.get(ship.attachedTo);
        if (!host || !host.alive) detachTurret(w, ship);
      }
      if (ship.attachedTo) continue; // placed in pass 2

      if (stepCharge(w, ship)) continue;
      const moving = Math.sqrt(inp.moveX * inp.moveX + inp.moveY * inp.moveY) > THRUST_DEADZONE;
      const abCost = ship.stats.afterburnerCostPerSec * DT;
      const ab = inp.afterburner && moving && ship.energy > abCost;
      let speedMult = ship.turrets.length
        ? Math.max(0.5, 1 - HOST_SPEED_PENALTY_PER_TURRET * ship.turrets.length) : 1;
      speedMult *= boostMult(w, ship);
      speedMult *= objSpeedMult(w, ship);
      stepShipMovement(ship, inp, ship.stats, w.map, DT, ab, speedMult);
      if (ab) { ship.energy -= abCost; this.abOn.add(ship.id); }
    }

    // Pass 2: turrets follow hosts (after hosts moved), turn freely
    for (const ship of w.ships.values()) {
      if (!ship.alive || !ship.attachedTo) continue;
      placeTurret(w, ship);
      turnToward(ship, ship.input.aim, ship.stats.turnRate, DT);
    }

    // Pass 3: energy, skills / turret kit, talents, flags
    for (const ship of w.ships.values()) {
      if (!ship.alive) { ship.flags = ship.isBot ? SHIPFLAG_BOT : 0; continue; }
      const inp = ship.input;
      const ab = this.abOn.has(ship.id);
      if (!ab) {
        let mult = 1;
        if (ship.attachedTo) {
          mult = TURRET_RECHARGE_MULT;
          const host = w.ships.get(ship.attachedTo);
          if (host && hostHasClamp(host)) mult *= CLAMP_RECHARGE_MULT;
        }
        mult *= objRechargeMult(w, ship);
        ship.energy = Math.min(ship.stats.maxEnergy, ship.energy + ship.stats.rechargePerSec * mult * DT);
      }
      if (ship.attachedTo) stepTurretKit(w, ship);
      else stepClassSkills(w, ship);
      if (ship.alive) stepTalents(w, ship);

      let f = 0;
      if (ab) f |= SHIPFLAG_AFTERBURNER;
      if (tick < ship.invulnUntilTick) f |= SHIPFLAG_INVULN;
      if (shieldAbsorb(w, ship) > 0) f |= SHIPFLAG_SHIELD;
      if (isCharging(w, ship)) f |= SHIPFLAG_CHARGING;
      if (!ship.attachedTo && Math.sqrt(inp.moveX * inp.moveX + inp.moveY * inp.moveY) > THRUST_DEADZONE) f |= SHIPFLAG_THRUSTING;
      if (ship.isBot) f |= SHIPFLAG_BOT;
      ship.flags = f;
    }

    pveStep(w, DT);
    stepDeployables(w);
    stepProjectiles(w);
    stepObjectives(w);
    stepRift(w);
    stepLoot(w, DT);

    for (const ship of w.ships.values()) ship.bounty = computeBounty(ship);
    if (w.dungeon && w.dungeon.pendingFloor) this.enterFloor(w.dungeon.pendingFloor);
    this.stepMatch();

    for (const ship of w.ships.values()) Object.assign(ship.prevInput, ship.input);
  }

  /**
   * v0.3 rift floor swap (§4.7; end of step(), before stepMatch), same Sim, ship ids unchanged:
   * 1. world.map = buildMatchMap({…, floor}) (same dimensions, so world.grid and side cells stay valid; map.rev
   *    continues from the old floor's, so a rev-keyed cache can never mistake the new floor for the old one);
   * 2. clear enemies, projectiles, gems, deployables and in-world loot (no death effects) and side ramHits /
   *    pierceMem; carried caches stay on the ships;
   * 3. world.pve: wave = riftTier(f), bossAlive false, mem {}; fresh rift rooms / portals / anchors (resetRiftFloor);
   * 4. every non-extracted ship: detached, rWait and extract progress cleared, respawned on the entrance ring with
   *    RIFT_FLOOR_INVULN_SEC (XP, level, upgrades, path and carried caches kept);
   * 5. PVE riftFloorInit (dormant packs), then emit floorStart {floor}.
   * A stray request (no rift on this map, or the run is over) is only cleared; past the last floor the run is cleared.
   */
  private enterFloor(floor: number): void {
    const w = this.world, d = w.dungeon;
    if (!d) return;
    d.pendingFloor = 0;
    if (gameTypeOf(w.config) !== 'dungeon' || !w.map.dungeon || d.outcome !== 'running') return;
    const f = Math.floor(floor);
    if (!(f >= 1)) return;
    if (f > d.floorsTotal) { endRift(w, 'cleared'); return; }
    const old = w.map;
    const map = buildMatchMap({
      seed: w.config.mapSeed, gameType: 'dungeon', subMode: w.config.subMode!, teamCount: w.config.teamCount, floor: f,
    });
    if (map.cols !== old.cols || map.rows !== old.rows || map.tileSize !== old.tileSize || map.width !== old.width || map.height !== old.height) {
      throw new Error(`enterFloor: floor ${f} map is ${map.cols}×${map.rows}, expected ${old.cols}×${old.rows}`);
    }
    map.rev = (old.rev ?? 0) + 1;
    w.map = map;
    w.enemies.clear();
    w.projectiles.clear();
    w.gems.clear();
    w.deployables.clear();
    w.loot?.clear();
    const sd = side(w);
    sd.ramHits.clear();
    sd.pierceMem.clear();
    w.pve.wave = riftTier(f);
    w.pve.bossAlive = false;
    w.pve.mem = {};
    resetRiftFloor(w, f);
    const slot = new Map<TeamId, number>();
    for (const ship of w.ships.values()) {
      const ss = ship.skillState;
      if (ss.rOut) continue;
      detachAll(w, ship);
      delete ss.rWait;
      delete ss.rExtract;
      delete ss.rExT;
      const i = slot.get(ship.team) ?? 0;
      slot.set(ship.team, i + 1);
      this.spawnShip(ship, riftEntrancePoint(w, ship.team, i));
      ship.invulnUntilTick = w.tick + secToTicks(RIFT_FLOOR_INVULN_SEC);
    }
    riftFloorInit(w);
    emit(w, { t: 'floorStart', floor: f });
  }

  private stepMatch(): void {
    const w = this.world, m = w.match;
    if (m.phase !== 'playing') return;
    if (w.objective) { this.stepObjectiveMatch(); return; }
    if (w.dungeon && gameTypeOf(w.config) === 'dungeon') { this.stepRiftMatch(); return; }
    const teams = w.config.mode === 'teams';
    if (teams) {
      for (let t = 0; t < m.teamScores.length; t++) m.teamScores[t] = 0;
      for (const s of w.ships.values()) if (s.team >= 0 && s.team < m.teamScores.length) m.teamScores[s.team] += s.score;
    }
    let topShip: Ship | null = null, topScore = -Infinity, tie = false;
    for (const s of w.ships.values()) {
      if (s.score > topScore) { topScore = s.score; topShip = s; tie = false; }
      else if (s.score === topScore) tie = true;
    }
    const limit = w.config.scoreLimit;
    let limitHit = false;
    if (limit > 0) {
      if (teams) limitHit = m.teamScores.some((v) => v >= limit);
      else limitHit = topScore >= limit;
    }
    const timeUp = m.endTick > 0 && w.tick >= m.endTick;
    if (!timeUp && !limitHit) return;

    m.phase = 'ended';
    m.winnerPlayerId = topShip && !tie ? topShip.playerId : 0;
    m.winnerTeam = -1;
    if (teams && m.teamScores.length) {
      let best = 0, bestTie = false;
      for (let t = 1; t < m.teamScores.length; t++) {
        if (m.teamScores[t] > m.teamScores[best]) { best = t; bestTie = false; }
        else if (m.teamScores[t] === m.teamScores[best]) bestTie = true;
      }
      m.winnerTeam = bestTie ? -1 : best;
    }
    emit(w, { t: 'matchEnd', winnerTeam: m.winnerTeam, winnerPlayerId: m.winnerPlayerId });
  }

  /**
   * v0.3 objective sub-modes (§5.2): match.teamScores MIRROR objective.teamPoints (never rebuilt from
   * ship.score, so kills never count as points), and ending is delegated entirely to objectiveEndCheck:
   * the target, time-out, overtime / sudden death / tie extensions (which may move match.endTick) and the
   * winner (match.winnerTeam / winnerPlayerId; FFA Hot Point from playerPoints) are its rules, not
   * scoreLimit or the deathmatch tie-break. On 'ended' the Sim closes the match and emits matchEnd once
   * (the hook sets the winner; it need not emit or flip the phase itself).
   */
  private stepObjectiveMatch(): void {
    const w = this.world, m = w.match;
    this.mirrorObjectivePoints();
    if (objectiveEndCheck(w) !== 'ended') return;
    this.mirrorObjectivePoints(); // the check may settle a last point (e.g. sudden death)
    m.phase = 'ended';
    if (!w.events.some((e) => e.t === 'matchEnd')) {
      emit(w, { t: 'matchEnd', winnerTeam: m.winnerTeam, winnerPlayerId: m.winnerPlayerId });
    }
  }

  /**
   * v0.3 rift (§4.7): untimed; teamScores = the party's summed ship scores; the match ends once the run's outcome
   * leaves 'running': winner team 0 for cleared / extracted, −1 for wiped / abandoned (never a winner player).
   */
  private stepRiftMatch(): void {
    const w = this.world, m = w.match, d = w.dungeon!;
    for (let t = 0; t < m.teamScores.length; t++) m.teamScores[t] = 0;
    for (const s of w.ships.values()) if (s.team >= 0 && s.team < m.teamScores.length) m.teamScores[s.team] += s.score;
    if (d.outcome === 'running') return;
    m.phase = 'ended';
    m.winnerTeam = d.outcome === 'cleared' || d.outcome === 'extracted' ? 0 : -1;
    m.winnerPlayerId = 0;
    emit(w, { t: 'matchEnd', winnerTeam: m.winnerTeam, winnerPlayerId: m.winnerPlayerId });
  }

  /** teamScores[t] = objective.teamPoints[t] (0 when missing). FFA: teamScores is [] and stays so. */
  private mirrorObjectivePoints(): void {
    const w = this.world, ts = w.match.teamScores, tp = w.objective?.teamPoints;
    for (let t = 0; t < ts.length; t++) {
      const v = tp ? tp[t] : 0;
      ts[t] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
  }

  /** Returns and clears events accumulated since the last drain. */
  drainEvents(): GameEvent[] {
    const e = this.world.events;
    this.world.events = [];
    return e;
  }

  /** 0 if the player has no ship. */
  shipIdFor(playerId: PlayerId): EntityId {
    return this.world.shipsByPlayer.get(playerId) ?? 0;
  }
}
