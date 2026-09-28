// OWNER: AI agent. Per-world A* budget for bot path searches.
//
// At most NAV_PER_TICK searches per tick per world (each Room's Sim has its own World, so rooms never
// compete for one budget). Requests carry `waitSince`, the tick the requester first asked for its
// current path. Bots are served in Room.players order, so a plain first-come budget would always
// favour the same early bots; instead, when requests were refused on the previous tick, the last slot
// of this tick is reserved for the longest-waiting of them. A refused brain re-asks every tick, and
// since waitSince only ages, every requester reaches the front: no starvation, and the per-tick cap
// stays hard.

export const NAV_PER_TICK = 3;

interface Budget {
  tick: number;
  count: number;
  /** Oldest waitSince refused during `tick` (Infinity = none). */
  oldest: number;
  /** Oldest waitSince refused during the previous tick: that cohort owns the reserved slot now. */
  prevOldest: number;
}

const budgets = new WeakMap<object, Budget>();

/**
 * Ask for one A* search this tick. `key` identifies the world (budget scope); `waitSince` is the tick
 * the caller started waiting for this path (pass `tick` for a fresh request).
 */
export function navBudget(key: object, tick: number, waitSince: number): boolean {
  let b = budgets.get(key);
  if (!b) {
    b = { tick: -1, count: 0, oldest: Infinity, prevOldest: Infinity };
    budgets.set(key, b);
  }
  if (tick !== b.tick) {
    b.prevOldest = tick === b.tick + 1 ? b.oldest : Infinity;
    b.tick = tick;
    b.count = 0;
    b.oldest = Infinity;
  }
  const reserved = b.prevOldest !== Infinity && waitSince > b.prevOldest;
  const cap = reserved ? NAV_PER_TICK - 1 : NAV_PER_TICK;
  if (b.count < cap) {
    b.count++;
    return true;
  }
  if (waitSince < b.oldest) b.oldest = waitSince;
  return false;
}
