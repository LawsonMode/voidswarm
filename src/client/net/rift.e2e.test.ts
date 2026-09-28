// v0.3 M4 (end to end): once the integrator flips SUB_MODES.coop.ready, the Command Dungeon card opens, offline Quick
// Play lands in the "Offline Descent" house room (one click, countdown at once), Create Game / the room lobby show the
// dungeon rows, a running rift's list row offers "Join · next floor". Real Zone + Room, no Sim ticks. The last block
// drives GameClient with the REAL floorgen (skipped until SIM's generateFloor lands): the client's floors are the
// server's floors tile for tile, sealed doors are mirrored, and floorStart swaps to the next floor's map.
import { describe, expect, it } from 'vitest';
import { SUB_MODES } from '../../shared/data/gameTypes';
import { DEFAULT_SETTINGS_BY_TYPE, type RoomSummary, type ServerMsg } from '../../shared/protocol';
import { houseRooms } from '../../shared/room/houseRooms';
import { clampSettings } from '../../shared/room/util';
import { Zone } from '../../shared/room/Zone';
import { generateFloor } from '../../shared/sim/floorgen';
import { buildMatchMap } from '../../shared/sim/mapgen';
import {
  RIFT_CLEARED, RIFT_DORMANT, RIFT_SEALED, TILE_DOOR, TILE_WALL, type GameMap, type RiftView, type Snapshot, type SubMode,
} from '../../shared/types';
import { PROTOCOL_VERSION } from '../../shared/version';
import {
  createDefaults, defaultCommandType, normalizeDraft, rowActions, settingsFields, statusText, typeOpen,
} from '../ui/gameTypeInfo';
import { dropInLabel } from '../ui/RoomLobby';
import { riftRulesLine } from '../ui/riftInfo';
import { GameClient } from './GameClient';

/** Temporarily mark sub-modes ready (as the M4 integrator will), restoring them afterwards. */
function withReady<T>(subs: SubMode[], fn: () => T): T {
  const before = subs.map((s) => SUB_MODES[s].ready);
  try {
    for (const s of subs) (SUB_MODES[s] as { ready: boolean }).ready = true;
    return fn();
  } finally {
    subs.forEach((s, i) => { (SUB_MODES[s] as { ready: boolean }).ready = before[i]; });
  }
}

describe('M4: the Dungeon Runner card opens once co-op is ready', () => {
  it('offline Quick Play (one click) joins the Offline Descent house room and starts the countdown', () => {
    withReady(['coop'], () => {
      expect(typeOpen('dungeon')).toBe(true);
      expect(defaultCommandType()).toBe('dungeon'); // first card, now open
      const zone = new Zone({ snapshotEvery: 1, local: true, motd: '', defaultRooms: houseRooms(true) });
      const msgs: ServerMsg[] = [];
      const conn = zone.connect({ sendMsg: (m) => { msgs.push(m); }, sendSnapshot: () => {} });
      try {
        conn.handle({ type: 'hello', name: 'Solo', protocol: PROTOCOL_VERSION, version: 'e2e' });
        const list = msgs.filter((m): m is Extract<ServerMsg, { type: 'roomList' }> => m.type === 'roomList').pop();
        expect(list?.rooms.some((r) => r.gameType === 'dungeon' && r.house)).toBe(true);
        conn.handle({ type: 'quickPlay', gameType: 'dungeon' });
        const rs = msgs.filter((m): m is Extract<ServerMsg, { type: 'roomState' }> => m.type === 'roomState').pop();
        expect(rs, 'Quick Play put the pilot in a room').toBeTruthy();
        expect(rs!.settings).toMatchObject({
          name: 'Offline Descent', gameType: 'dungeon', subMode: 'coop', mode: 'teams', teamCount: 1, floors: 6, matchMinutes: 0,
        });
        expect(rs!.settings.maxPlayers).toBeLessThanOrEqual(4);
        expect(rs!.phase).toBe('countdown');
      } finally {
        zone.stop();
      }
    });
  });

  it('Create Game: floors 3/6, Story / Veteran / Nightmare, Reckless — and the preview agrees with the server', () => {
    withReady(['coop'], () => {
      const s = createDefaults('dungeon', "Pilot's Dungeon Run");
      expect(s).toMatchObject({ gameType: 'dungeon', subMode: 'coop', teamCount: 1, mode: 'teams', floors: 6, matchMinutes: 0, pveIntensity: 2 });
      const f = settingsFields(s, true);
      expect(f.find((x) => x.key === 'subMode')!.options!.map((o) => o.value)).toEqual(['coop']);
      expect(f.find((x) => x.key === 'floors')!.options!.map((o) => o.label)).toEqual(['3 floors', '6 floors']);
      expect(f.find((x) => x.key === 'pveIntensity')!.options!.map((o) => o.label)).toEqual(['Story', 'Veteran', 'Nightmare']);
      expect(f.find((x) => x.key === 'friendlyFire')!.label).toBe('Reckless (friendly fire)');
      expect(f.find((x) => x.key === 'gameType')!.options!.find((o) => o.value === 'dungeon')!.disabled).toBeFalsy();
      for (const no of ['matchMinutes', 'mode', 'teamCount', 'objectiveLimit', 'scoreLimit']) expect(f.some((x) => x.key === no)).toBe(false);
      for (const base of [DEFAULT_SETTINGS_BY_TYPE.warzone, DEFAULT_SETTINGS_BY_TYPE.arena]) {
        expect(normalizeDraft(base, { gameType: 'dungeon' })).toEqual(clampSettings(base, { gameType: 'dungeon' }));
      }
      const three = normalizeDraft(s, { floors: 3, pveIntensity: 3, friendlyFire: true });
      expect(three).toEqual(clampSettings(s, { floors: 3, pveIntensity: 3, friendlyFire: true }));
      expect(riftRulesLine(three.floors)).toContain('3 floors · the Matriarch waits on floor 3');
    });
  });

  it('a running rift: list row "Join · next floor" + Watch, status "Floor 3/6 · 12:40 in · 7 lives", lobby button', () => {
    const r: RoomSummary = {
      id: 'd', name: 'The Descent', mode: 'teams', teamCount: 1, phase: 'playing', humans: 1, bots: 3, maxPlayers: 4,
      gameType: 'dungeon', subMode: 'coop', pveIntensity: 2, floors: 6, house: true, hostName: '', spectators: 0, joinable: true,
      watchable: true, startsInSec: 0,
      live: { elapsedSec: 760, timeLeftSec: -1, wave: 0, floor: 3, floorsTotal: 6, lives: 7, scores: [], scoreline: 'Floor 3/6 · 7 lives', leader: '', leaderScore: 0 },
    };
    expect(rowActions(r, false).map((a) => `${a.label}:${a.intent}`)).toEqual(['Join · next floor:play', 'Watch:watch']);
    expect(rowActions(r, true).map((a) => a.label)).toEqual(['Join · next floor']); // no Watch offline
    expect(statusText(r, 0, 0)).toBe('Floor 3/6 · 12:40 in · 7 lives');
    expect(dropInLabel(true, false)).toBe('Join · next floor');
    expect(dropInLabel(false, true)).toBe('Join Match');
    expect(dropInLabel(false, false)).toBe('Join Match (auto team)');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real floorgen (SIM M4). Skipped until buildMatchMap routes dungeons through generateFloor (a rift layout comes back).
const floorgenReady = (() => {
  try {
    generateFloor(1234, 1, 1);
    return !!buildMatchMap({ seed: 1234, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 1 }).dungeon;
  } catch { return false; }
})();

function tilesKey(m: GameMap): string {
  let h = 2166136261;
  for (let i = 0; i < m.tiles.length; i++) { h ^= m.tiles[i]; h = Math.imul(h, 16777619); }
  return `${m.cols}x${m.rows}:${h >>> 0}`;
}

describe.skipIf(!floorgenReady)('M4 client × real floorgen', () => {
  const view = (map: GameMap, states: number[]): RiftView => ({
    floor: map.dungeon!.floor, floorsTotal: 6, biome: map.dungeon!.biome, rooms: states, chests: states.map(() => 0), lives: [10], seen: [1],
    anchors: [0, 0], portal: 0, departIn: 0, extractOpen: false, boss: null, waiting: [], extracting: [], floorSec: 0,
  });
  const snap = (tick: number, dungeon: RiftView): Snapshot => ({
    tick, ackSeq: 0, you: null, ships: [], enemies: [], projectiles: [], gems: [], deployables: [], events: [],
    match: { phase: 'playing', mode: 'teams', teamCount: 1, timeLeftSec: 0, teamScores: [0], wave: 1, winnerTeam: -1, winnerPlayerId: 0, timed: false, gameType: 'dungeon', subMode: 'coop', dungeon },
  });

  it('the client builds the server\'s floors tile for tile, mirrors sealed doors, and swaps floors on floorStart', () => {
    const c = new GameClient(null);
    const inner = c as unknown as { handleMsg(m: ServerMsg): void; handleSnapshot(s: Snapshot): void };
    inner.handleMsg({ type: 'matchStart', mapSeed: 1234, mode: 'teams', teamCount: 1, gameType: 'dungeon', subMode: 'coop', floor: 1, yourShipId: 0, tick: 10, snapshotEvery: 3 });
    const server1 = buildMatchMap({ seed: 1234, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 1 });
    expect(c.map?.dungeon?.floor).toBe(1);
    expect(tilesKey(c.map!)).toBe(tilesKey(server1));
    expect(tilesKey(c.map!)).toBe(tilesKey(generateFloor(1234, 1, 1)));

    // Seal the first sealable room: its door tiles become walls on the client map (and back when cleared).
    const L = c.map!.dungeon!;
    const room = L.rooms.find((r) => r.doors.length > 0)!;
    expect(room).toBeTruthy();
    const states = L.rooms.map(() => RIFT_DORMANT as number);
    states[room.idx] = RIFT_SEALED;
    const rev0 = c.map!.rev ?? 0;
    inner.handleSnapshot(snap(100, view(c.map!, states)));
    for (const d of room.doors) for (const i of d.tiles) expect(c.map!.tiles[i]).toBe(TILE_WALL);
    expect(c.map!.rev ?? 0).toBeGreaterThan(rev0);
    states[room.idx] = RIFT_CLEARED;
    inner.handleSnapshot(snap(103, view(c.map!, states)));
    for (const d of room.doors) for (const i of d.tiles) expect(c.map!.tiles[i]).toBe(TILE_DOOR);

    inner.handleMsg({ type: 'floorStart', floor: 2, tick: 200 });
    expect(c.map?.dungeon?.floor).toBe(2);
    expect(tilesKey(c.map!)).toBe(tilesKey(generateFloor(1234, 2, 1)));
    expect([c.map!.cols, c.map!.rows]).toEqual([server1.cols, server1.rows]); // world.grid stays valid
  });
});
