// Pure interpolation math (unit-tested). No DOM.
import { TICK_RATE } from '../../shared/constants';
import { lerp, lerpAngle } from '../../shared/util/math';
import type { DeployableView, EnemyView, GemView, LootView, ProjectileView, ShipView, Snapshot } from '../../shared/types';

/**
 * Maps local time onto the fractional server tick shown on screen:
 * renderTick = (estimated latest server tick) - delay. The delay adapts to snapshot arrival jitter.
 * The value never runs backwards, except on a hard resync.
 */
export class RenderClock {
  renderTick = 0;
  private initialized = false;
  private lastTick = -1;
  private lastRecvMs = 0;
  /** EWMA of |arrival interval - expected interval| in ms. */
  jitterMs = 0;

  constructor(
    private snapshotEvery: number,
    /** Minimum delay in ticks (online is about 6 = 100 ms, offline about 1.5). */
    private minDelay: number,
    private maxDelay: number,
  ) {}

  configure(snapshotEvery: number, minDelay: number, maxDelay: number): void {
    this.snapshotEvery = snapshotEvery;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
  }

  reset(): void {
    this.initialized = false;
    this.lastTick = -1;
    this.jitterMs = 0;
  }

  get latestTick(): number { return this.lastTick; }

  onSnapshot(tick: number, nowMs: number): void {
    if (tick <= this.lastTick) return;
    if (this.lastTick >= 0) {
      const expected = ((tick - this.lastTick) * 1000) / TICK_RATE;
      const dev = Math.abs(nowMs - this.lastRecvMs - expected);
      this.jitterMs = this.jitterMs * 0.9 + Math.min(dev, 500) * 0.1;
    }
    this.lastTick = tick;
    this.lastRecvMs = nowMs;
  }

  /** Current interpolation delay in ticks. */
  delayTicks(): number {
    const jitterTicks = (this.jitterMs * TICK_RATE) / 1000;
    const want = Math.max(this.minDelay, this.snapshotEvery * 1.5 + 2 * jitterTicks);
    return Math.min(this.maxDelay, want);
  }

  /** Advance the clock and return renderTick. */
  update(nowMs: number, dtSec: number): number {
    if (this.lastTick < 0) return this.renderTick;
    const since = Math.min(10, ((nowMs - this.lastRecvMs) * TICK_RATE) / 1000);
    const target = this.lastTick + since - this.delayTicks();
    if (!this.initialized || Math.abs(target - this.renderTick) > 30) {
      this.renderTick = target;
      this.initialized = true;
      return this.renderTick;
    }
    const next = this.renderTick + dtSec * TICK_RATE + (target - this.renderTick) * Math.min(1, dtSec * 4);
    this.renderTick = Math.max(this.renderTick, next);
    return this.renderTick;
  }
}

export interface Bracket { a: Snapshot; b: Snapshot; t: number; /** Ticks past b when extrapolating (>= 0). */ extra: number }

/** Takes snapshots sorted ascending by tick and returns the pair around renderTick. */
export function findBracket(buf: readonly Snapshot[], rt: number): Bracket | null {
  const n = buf.length;
  if (n === 0) return null;
  if (rt <= buf[0].tick) return { a: buf[0], b: buf[0], t: 0, extra: 0 };
  const last = buf[n - 1];
  if (rt >= last.tick) return { a: last, b: last, t: 0, extra: rt - last.tick };
  for (let i = n - 1; i > 0; i--) {
    const a = buf[i - 1];
    if (a.tick <= rt) {
      const b = buf[i];
      const span = b.tick - a.tick;
      return { a, b, t: span > 0 ? (rt - a.tick) / span : 0, extra: 0 };
    }
  }
  return { a: buf[0], b: buf[0], t: 0, extra: 0 };
}

/** Inserts in ascending order and ignores duplicate ticks. Trims the buffer to `max`. */
export function insertSnapshot(buf: Snapshot[], s: Snapshot, max = 40): void {
  let i = buf.length;
  while (i > 0 && buf[i - 1].tick > s.tick) i--;
  if (i > 0 && buf[i - 1].tick === s.tick) return;
  buf.splice(i, 0, s);
  if (buf.length > max) buf.splice(0, buf.length - max);
}

function byId<T extends { id: number }>(list: readonly T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const e of list) m.set(e.id, e);
  return m;
}

const MAX_EXTRAP_SHIP = 4;
const MAX_EXTRAP_PROJ = 8;
/**
 * Fastest a ship can really travel (Ram Charge 1500 px/s + knockback, with margin) and a fixed slack.
 * A bigger jump between two snapshots is a teleport (Blink, mid-match respawn on class/team change).
 */
const TELEPORT_SPEED = 2400;
const TELEPORT_SLACK = 40;

/** True when a ship moved farther between snapshots a and b than it could have flown (a teleport). */
export function isTeleport(p: ShipView, s: ShipView, ticks: number): boolean {
  if (p.shipClass !== s.shipClass) return true;
  const dx = s.x - p.x, dy = s.y - p.y;
  const max = TELEPORT_SLACK + (TELEPORT_SPEED * Math.max(1, ticks)) / TICK_RATE;
  return dx * dx + dy * dy > max * max;
}

export function interpShips(br: Bracket): ShipView[] {
  const { a, b, t } = br;
  const prev = a === b ? null : byId(a.ships);
  const ex = Math.min(br.extra, MAX_EXTRAP_SHIP) / TICK_RATE;
  const out: ShipView[] = [];
  for (const s of b.ships) {
    const p = prev?.get(s.id);
    if (p && p.alive === s.alive && p.attachedTo === s.attachedTo && isTeleport(p, s, b.tick - a.tick)) {
      // Don't slide across the map: show the old spot, then the new one, split at the bracket midpoint.
      out.push(t < 0.5 ? { ...p } : { ...s });
    } else if (p && p.alive === s.alive && p.attachedTo === s.attachedTo) {
      out.push({
        ...s, x: lerp(p.x, s.x, t), y: lerp(p.y, s.y, t), vx: lerp(p.vx, s.vx, t), vy: lerp(p.vy, s.vy, t),
        angle: lerpAngle(p.angle, s.angle, t), energyFrac: lerp(p.energyFrac, s.energyFrac, t),
      });
    } else if (ex > 0 && s.alive && s.attachedTo === 0) {
      out.push({ ...s, x: s.x + s.vx * ex, y: s.y + s.vy * ex });
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function interpEnemies(br: Bracket): EnemyView[] {
  const { a, b, t } = br;
  if (a === b) return b.enemies.map((e) => ({ ...e }));
  const prev = byId(a.enemies);
  return b.enemies.map((e) => {
    const p = prev.get(e.id);
    return p ? { ...e, x: lerp(p.x, e.x, t), y: lerp(p.y, e.y, t), angle: lerpAngle(p.angle, e.angle, t) } : { ...e };
  });
}

/** Projectiles lerp when present in both snapshots. Otherwise they are placed by velocity relative to b's tick. */
export function interpProjectiles(br: Bracket, rt: number): ProjectileView[] {
  const { a, b, t } = br;
  const prev = a === b ? null : byId(a.projectiles);
  const out: ProjectileView[] = [];
  for (const pr of b.projectiles) {
    const p = prev?.get(pr.id);
    if (p) {
      out.push({ ...pr, x: lerp(p.x, pr.x, t), y: lerp(p.y, pr.y, t) });
    } else {
      let dtTicks = rt - b.tick;
      if (dtTicks > MAX_EXTRAP_PROJ) dtTicks = MAX_EXTRAP_PROJ;
      if (dtTicks < -MAX_EXTRAP_PROJ) dtTicks = -MAX_EXTRAP_PROJ;
      const d = pr.kind === 'mine' ? 0 : dtTicks / TICK_RATE;
      out.push({ ...pr, x: pr.x + pr.vx * d, y: pr.y + pr.vy * d });
    }
  }
  return out;
}

export function interpGems(br: Bracket): GemView[] {
  const { a, b, t } = br;
  if (a === b) return b.gems.map((g) => ({ ...g }));
  const prev = byId(a.gems);
  return b.gems.map((g) => {
    const p = prev.get(g.id);
    return p ? { ...g, x: lerp(p.x, g.x, t), y: lerp(p.y, g.y, t) } : { ...g };
  });
}

/** Deployables (sentries, walls, wells, drones...) interpolate like enemies. Tolerates a missing array. */
export function interpDeployables(br: Bracket): DeployableView[] {
  const { a, b, t } = br;
  const cur = b.deployables ?? [];
  if (a === b) return cur.map((d) => ({ ...d }));
  const prev = byId(a.deployables ?? []);
  return cur.map((d) => {
    const p = prev.get(d.id);
    return p ? { ...d, x: lerp(p.x, d.x, t), y: lerp(p.y, d.y, t), angle: lerpAngle(p.angle, d.angle, t) } : { ...d };
  });
}

/**
 * v0.3 in-world caches interpolate like gems (spills scatter with friction, then rest). Tolerates a missing
 * array (a v0.2 snapshot / no loot) and caches that appear or vanish between the two snapshots.
 */
export function interpLoot(br: Bracket): LootView[] {
  const { a, b, t } = br;
  const cur = b.loot ?? [];
  if (a === b || !cur.length) return cur.map((l) => ({ ...l }));
  const prev = byId(a.loot ?? []);
  return cur.map((l) => {
    const p = prev.get(l.id);
    return p ? { ...l, x: lerp(p.x, l.x, t), y: lerp(p.y, l.y, t) } : { ...l };
  });
}
