// OWNER: ROOM agent. Default ("house") rooms per game type (docs/v0.3-proposal.md §3.3).
// House rooms are created with userCreated = false: RoomSummary.house = true, they never close, and an idle
// one sits in its lobby with bots and no Sim (costs nothing).
import { SUB_MODES, firstReadySubMode } from '../data/gameTypes';
import type { RoomSettings } from '../protocol';

/** Online house rooms. Each is skipped while its sub-mode is not ready. */
const ONLINE: readonly Partial<RoomSettings>[] = [
  { name: 'The Descent', gameType: 'dungeon', subMode: 'coop', floors: 6, botFill: 4 },
  { name: 'Flag Run', gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, maxPlayers: 16, botFill: 10 },
  { name: 'Hot Points', gameType: 'arena', subMode: 'hotpoint', mode: 'teams', teamCount: 2, maxPlayers: 16, botFill: 10 },
  { name: 'Duel Pit', gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', maxPlayers: 8, botFill: 4 },
  { name: 'Warzone Classic', gameType: 'warzone', subMode: 'deathmatch', mode: 'teams', teamCount: 2, maxPlayers: 32, botFill: 12 },
];

/** Offline house rooms, one per game type: a not-ready sub-mode is swapped for the type's first ready one. */
const OFFLINE: readonly Partial<RoomSettings>[] = [
  { name: 'Offline Descent', gameType: 'dungeon', subMode: 'coop', floors: 6, botFill: 4 },
  { name: 'Offline Arena', gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, maxPlayers: 12, botFill: 10 },
  { name: 'Offline Warzone', gameType: 'warzone', subMode: 'deathmatch', mode: 'teams', teamCount: 2, botFill: 12 },
];

/** Online: The Descent / Flag Run / Hot Points / Duel Pit / Warzone Classic; offline: one per type (ready sub-modes only). */
export function houseRooms(local: boolean): Partial<RoomSettings>[] {
  const out: Partial<RoomSettings>[] = [];
  if (!local) {
    for (const r of ONLINE) if (r.subMode && SUB_MODES[r.subMode].ready) out.push({ ...r });
    return out;
  }
  for (const r of OFFLINE) {
    if (!r.gameType || !r.subMode) continue;
    if (SUB_MODES[r.subMode].ready) { out.push({ ...r }); continue; }
    const sub = firstReadySubMode(r.gameType);
    if (!sub) continue; // nothing of this type is playable yet
    const def = SUB_MODES[sub];
    const room: Partial<RoomSettings> = { ...r, subMode: sub, matchMinutes: def.defaultMinutes };
    out.push(room);
  }
  return out;
}
