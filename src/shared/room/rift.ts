// OWNER: ROOM agent. v0.3 M4 rift glue for the Room (docs/v0.3-proposal.md §4.8 "Room layer"): MatchResult.rift
// (RiftResult with per-pilot status), the rift awards (Delver, Treasure Hunter), the PvE result lines (fix #23), the
// rift event chat lines, and the bot class complement. Pure reads of World / RiftState: nothing here mutates the sim
// or touches world.rng.
import { RIFT_BOSS_EVERY, TICK_RATE } from '../constants';
import { SHIP_CLASSES } from '../data/ships';
import type { MatchResult, PlayerScore, RiftResult } from '../protocol';
import type { GameEvent, PlayerId, RiftBiome, RiftOutcome, RiftState, ShipClassId, TeamId, World } from '../types';
import { leastUsedClass } from './util';

/** Display names of the rift biomes (floors 1–3 / 4–6): "Floor 4 — Prism Vaults". */
export const RIFT_BIOME_NAMES: Readonly<Record<RiftBiome, string>> = { hive: 'Hive Warrens', prism: 'Prism Vaults' };

/** A class change during a run waits for the next floor start (§4.8). */
export const RIFT_CLASS_QUEUED_MSG = 'Class change applies at the next floor.';
/** An extracted pilot watches the rest of the run (their ship stays on the scoreboard). */
export const RIFT_EXTRACTED_MSG = "You extracted — you're watching the rest of the run.";
/** A rift drop-in when the party has no free seat at the floor start. */
export const RIFT_PARTY_FULL_MSG = 'The party is full — you keep watching. You join when a seat frees up at a floor start.';
/** A drop-in on the final floor: no floor start is coming. */
export const RIFT_FINAL_FLOOR_MSG = "This is the final floor — you can watch; you're in for the next run.";

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Biome of floor `f` (floors 1–3 hive, 4–6 prism): the map's own layout first. */
export function riftBiomeOf(world: World, floor: number): RiftBiome {
  const b = world.map.dungeon?.biome;
  if (b && world.map.dungeon!.floor === floor) return b;
  return floor <= 3 ? 'hive' : 'prism';
}

/** "Floor 4 — Prism Vaults" (the floorStart chat line). */
export function floorLine(world: World, floor: number): string {
  const name = RIFT_BIOME_NAMES[riftBiomeOf(world, floor)] ?? 'the Rift';
  const d = world.dungeon;
  const last = d && floor >= d.floorsTotal ? ' · final floor' : floor % RIFT_BOSS_EVERY === 0 ? ' · the Matriarch waits' : '';
  return `Floor ${floor} — ${name}${last}`;
}

/** "X extracted from floor 3 with 5 caches" / "... with 1 cache" / "X extracted from floor 3." */
export function extractLine(name: string, floor: number, caches: number): string {
  return caches > 0 ? `${name} extracted from floor ${floor} with ${plural(caches, 'cache')}` : `${name} extracted from floor ${floor}.`;
}

/**
 * The run's outcome for the result. A run the Room ends while the sim still says 'running' (the host's /end, whose
 * abandonRift() may land on the next step) counts as abandoned.
 */
export function riftOutcomeOf(d: RiftState): Exclude<RiftOutcome, 'running'> {
  return d.outcome === 'running' ? 'abandoned' : d.outcome;
}

/** Winner of a rift: the party (team 0) on a clear or an extraction; nobody on a wipe or an abandon (§4.7). */
export function riftWinner(outcome: Exclude<RiftOutcome, 'running'>): TeamId {
  return outcome === 'cleared' || outcome === 'extracted' ? 0 : -1;
}

/** Deepest floor any pilot reached: the current floor, or a party's recorded deepest (whichever is larger). */
export function riftFloorReached(d: RiftState): number {
  let f = Math.max(1, finite(d.floor));
  for (const p of d.parties) f = Math.max(f, finite(p.deepestFloor));
  return Math.min(f, Math.max(1, finite(d.floorsTotal) || f));
}

/** A pilot who left the run (leave room / go to spectate) — kept for RiftResult ('left'). */
export interface RiftLeaver { floor: number; deaths: number }

/**
 * MatchResult.rift (undefined outside a rift). Per pilot (every ship still in the world, bots included, then the
 * humans who left): extracted = banked at a portal (wins over everything, a leave after extracting too);
 * left = quit the run; survived = in the rift at a 'cleared' end; lost = anything else (wiped / abandoned, or left
 * behind when everyone else extracted). `order` = the result's score rows (best first) for the player order.
 */
export function buildRiftResult(
  world: World, leavers: ReadonlyMap<PlayerId, RiftLeaver>, order: readonly PlayerScore[] = [],
): RiftResult | undefined {
  const d = world.dungeon;
  if (!d) return undefined;
  const outcome = riftOutcomeOf(d);
  const extracted = new Map<PlayerId, number>();
  for (const e of d.extracted) if (!extracted.has(e.playerId)) extracted.set(e.playerId, finite(e.floor));
  const players: RiftResult['players'] = [];
  const seen = new Set<PlayerId>();
  const add = (pid: PlayerId, status: RiftResult['players'][number]['status'], floor: number, deaths: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    players.push({ playerId: pid, status, floor: Math.max(1, Math.round(floor)), deaths: Math.max(0, Math.round(deaths)) });
  };
  const here = new Map<PlayerId, { deaths: number }>();
  for (const s of world.ships.values()) here.set(s.playerId, { deaths: finite(s.deaths) });
  const pids = [...order.map((r) => r.playerId), ...here.keys()];
  for (const pid of pids) {
    const s = here.get(pid);
    if (!s) continue;
    const prior = leavers.get(pid)?.deaths ?? 0; // left once, came back at a later floor start
    const ex = extracted.get(pid);
    if (ex !== undefined) add(pid, 'extracted', ex, s.deaths + prior);
    else add(pid, outcome === 'cleared' ? 'survived' : 'lost', d.floor, s.deaths + prior);
  }
  for (const [pid, l] of leavers) {
    if (seen.has(pid)) continue;
    const ex = extracted.get(pid);
    add(pid, ex !== undefined ? 'extracted' : 'left', ex ?? l.floor, l.deaths);
  }
  let roomsCleared = 0, bossesKilled = 0;
  for (const p of d.parties) { roomsCleared += finite(p.roomsCleared); bossesKilled += finite(p.bossesKilled); }
  return {
    outcome, floorsTotal: finite(d.floorsTotal), floorReached: riftFloorReached(d), roomsCleared, bossesKilled,
    timeSec: Math.max(0, Math.round((world.tick - world.match.startTick) / TICK_RATE)), players,
  };
}

/**
 * The PvE result chat line (fix #23): "RIFT CONQUERED — all 6 floors cleared!", "Everyone extracted on floor 3.",
 * "Party wiped on floor 5 — unsecured loot lost.", "Run abandoned on floor 2."
 */
export function riftResultLine(r: RiftResult, floor: number): string {
  switch (r.outcome) {
    case 'cleared': return `RIFT CONQUERED — all ${r.floorsTotal} floors cleared!`;
    case 'extracted': return `Everyone extracted on floor ${floor}.`;
    case 'wiped': return `Party wiped on floor ${floor} — unsecured loot lost.`;
    case 'abandoned': return `Run abandoned on floor ${floor}.`;
  }
  return `Run over on floor ${floor}.`;
}

/**
 * The rift-only awards, in §4.8 order (the Room adds Exterminator, Field Medic and Battle Station after them):
 * Delver — the deepest floor reached (ties: the higher scorer; the extraction floor for extracted pilots);
 * Treasure Hunter — most chests opened (`chests`: chestOpen events per pilot this run).
 */
export function riftAwards(
  rift: RiftResult | undefined, scores: readonly PlayerScore[], chests: ReadonlyMap<PlayerId, number>,
): MatchResult['awards'] {
  const out: MatchResult['awards'] = [];
  if (!rift) return out;
  const rank = new Map<PlayerId, number>();
  scores.forEach((s, i) => rank.set(s.playerId, i));
  const r = (pid: PlayerId): number => rank.get(pid) ?? 1e9;
  let deep: RiftResult['players'][number] | null = null;
  for (const p of rift.players) {
    if (p.status === 'left' || !rank.has(p.playerId)) continue;
    if (!deep || p.floor > deep.floor || (p.floor === deep.floor && r(p.playerId) < r(deep.playerId))) deep = p;
  }
  if (deep) {
    const how = deep.status === 'extracted' ? ` (extracted)` : rift.outcome === 'cleared' ? ' (full clear)' : '';
    out.push({ title: 'Delver', playerId: deep.playerId, value: `floor ${deep.floor}${how}` });
  }
  let th: [PlayerId, number] | null = null;
  for (const [pid, n] of chests) {
    if (!(n > 0)) continue;
    if (!th || n > th[1] || (n === th[1] && r(pid) < r(th[0]))) th = [pid, n];
  }
  if (th) out.push({ title: 'Treasure Hunter', playerId: th[0], value: plural(th[1], 'chest') });
  return out;
}

/**
 * Class for a rift fill bot (§4.8): an Artificer if the party has none, otherwise the party's least-used class
 * (ties broken with `r`, but `prefer` — the bot's current class — wins a tie, so re-complementing doesn't reshuffle).
 * `party` = the classes already flying (humans and bots).
 */
export function riftBotClass(party: readonly ShipClassId[], r: () => number, prefer?: ShipClassId): ShipClassId {
  const support: ShipClassId = 'engineer';
  if (SHIP_CLASSES[support] && !party.includes(support)) return support;
  if (prefer && SHIP_CLASSES[prefer]) {
    let min = Infinity;
    const counts = new Map<ShipClassId, number>();
    for (const c of Object.keys(SHIP_CLASSES) as ShipClassId[]) counts.set(c, 0);
    for (const c of party) counts.set(c, (counts.get(c) ?? 0) + 1);
    for (const v of counts.values()) min = Math.min(min, v);
    if (counts.get(prefer) === min) return prefer;
  }
  return leastUsedClass(party, r);
}

/**
 * Rift event chat lines, rate-limited per floor (reset() at each match start): "The Hive Matriarch awakens!" once
 * per boss, "Rift unstable — hunters inbound" once per floor. Floor starts and extractions are announced by the
 * Room itself (they also move pilots).
 */
export class RiftAnnouncer {
  private said = new Set<string>();

  reset(): void { this.said.clear(); }

  private once(key: string): boolean {
    if (this.said.has(key)) return false;
    this.said.add(key);
    return true;
  }

  line(world: World, ev: GameEvent): string | null {
    const floor = world.dungeon?.floor ?? 0;
    switch (ev.t) {
      case 'bossIntro':
        if (ev.kind !== 'matriarch' || !this.once(`boss:${ev.id}`)) return null;
        return 'The Hive Matriarch awakens!';
      case 'instability':
        // Once per floor (whatever `sec` carries): the hunter packs that follow every 25 s stay HUD-only, and the
        // 360 s warning is the HUD's (RiftView.floorSec).
        return this.once(`unstable:${floor}`) ? 'Rift unstable — hunters inbound' : null;
      default:
        return null;
    }
  }
}
