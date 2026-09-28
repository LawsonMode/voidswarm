// OWNER: OBJECTIVES agent. MatchView.objective (docs/v0.3-proposal.md §5.7): dynamic state only (geometry is
// map.features, rebuilt by both hosts). Built once per SnapshotBuilder.prepare() and shared by every viewer,
// so it must stay small (≈ 200–250 B of JSON): integer px, integer seconds, progress as 0..100.
import { TICK_RATE } from '../../constants';
import type { ObjectiveState, ObjectiveView, World } from '../../types';
import { CTF_RETURN_SEC, ZONE_SWARM_BLOCK } from './rules';

function secsLeft(untilTick: number, tick: number): number {
  return Math.max(0, Math.ceil((untilTick - tick) / TICK_RATE));
}

export function buildView(world: World, o: ObjectiveState): ObjectiveView {
  const tick = world.tick;
  const v: ObjectiveView = { mode: o.mode, limit: o.limit, overtime: o.overtime, suddenDeath: o.suddenDeath };
  if (o.mode === 'ctf') {
    const returnTicks = CTF_RETURN_SEC * TICK_RATE;
    v.flags = o.flags.map((f) => ({
      team: f.team,
      s: f.state === 'home' ? 0 : f.state === 'carried' ? 1 : 2,
      x: Math.round(f.x), y: Math.round(f.y),
      carrierId: f.state === 'carried' ? f.carrierId : 0,
      returnIn: f.state === 'dropped' ? secsLeft(f.droppedAtTick + returnTicks, tick) : 0,
    }));
  } else if (o.mode === 'zones' || o.mode === 'hotpoint') {
    v.zones = o.zones.map((z) => ({
      i: z.index, owner: z.owner, ownerPid: z.ownerPlayerId, cap: z.capTeam, capPid: z.capPlayerId,
      p: Math.max(0, Math.min(100, Math.round(z.progress * 100))),
      contested: z.contested, swarm: z.swarm >= ZONE_SWARM_BLOCK, active: z.active,
    }));
    const h = o.hot;
    if (o.mode === 'hotpoint' && h) {
      v.hot = { site: h.site, next: h.nextSite, moveIn: secsLeft(h.moveTick, tick), armIn: secsLeft(h.armTick, tick) };
      if (world.config.mode !== 'teams') {
        const pp: [number, number][] = [];
        for (const [pid, n] of o.playerPoints) if (n > 0) pp.push([pid, Math.round(n)]);
        pp.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        v.playerPoints = pp;
      }
    }
  }
  return v;
}
