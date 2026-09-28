// v0.3 M3 (end to end, offline Zone in-page like LocalTransport): once the integrator flips SUB_MODES.ctf.ready,
// Arena's one-click Quick Play lands in CTF (the "Offline Arena" house room), and Create Game / the room lobby
// default to CTF with its target unit. Before the flip Arena stays on Deathmatch. Real Zone + Room, no Sim ticks
// (the match itself is the OBJECTIVES / SIM gate's business).
import { describe, expect, it } from 'vitest';
import { SUB_MODES } from '../../shared/data/gameTypes';
import type { RoomSettings, ServerMsg } from '../../shared/protocol';
import { houseRooms } from '../../shared/room/houseRooms';
import { Zone } from '../../shared/room/Zone';
import type { SubMode } from '../../shared/types';
import { PROTOCOL_VERSION } from '../../shared/version';
import { createDefaults, roomTitleText, settingsFields } from '../ui/gameTypeInfo';
import { objectiveRulesLine } from '../ui/objectiveInfo';

/** Temporarily mark sub-modes ready (as the M3 integrator will), restoring them afterwards. */
function withReady<T>(subs: SubMode[], fn: () => T): T {
  const before = subs.map((s) => SUB_MODES[s].ready);
  try {
    for (const s of subs) (SUB_MODES[s] as { ready: boolean }).ready = true;
    return fn();
  } finally {
    subs.forEach((s, i) => { (SUB_MODES[s] as { ready: boolean }).ready = before[i]; });
  }
}

/** Offline zone + one pilot; Quick Play Arena; the roomState it lands in. */
function quickPlayArena(): Extract<ServerMsg, { type: 'roomState' }> {
  const zone = new Zone({ snapshotEvery: 1, local: true, motd: '', defaultRooms: houseRooms(true) });
  const msgs: ServerMsg[] = [];
  const conn = zone.connect({ sendMsg: (m) => { msgs.push(m); }, sendSnapshot: () => {} });
  try {
    conn.handle({ type: 'hello', name: 'Solo', protocol: PROTOCOL_VERSION, version: 'e2e' });
    conn.handle({ type: 'quickPlay', gameType: 'arena' });
    const rs = msgs.filter((m): m is Extract<ServerMsg, { type: 'roomState' }> => m.type === 'roomState').pop();
    expect(rs, 'Quick Play put the pilot in a room').toBeTruthy();
    return rs!;
  } finally {
    zone.stop();
  }
}

describe('M3: Arena lands in Capture the Flag once CTF is ready', () => {
  it('offline Quick Play (one click) joins the Offline Arena house room as CTF and starts the countdown', () => {
    withReady(['ctf'], () => {
      const rs = quickPlayArena();
      expect(rs.settings).toMatchObject({ name: 'Offline Arena', gameType: 'arena', subMode: 'ctf', mode: 'teams', teamCount: 2, matchMinutes: 12, objectiveLimit: 0 });
      expect(rs.phase).toBe('countdown');
      expect(roomTitleText(rs.settings)).toBe('Arena · Capture the Flag · 2 teams');
    });
  });

  it('until then Arena Quick Play stays on a ready sub-mode (Deathmatch)', () => {
    if (SUB_MODES.ctf.ready) return; // the integrator already flipped it: covered above
    const rs = quickPlayArena();
    expect(rs.settings.gameType).toBe('arena');
    expect(SUB_MODES[rs.settings.subMode].ready).toBe(true);
    expect(rs.settings.subMode).not.toBe('ctf');
  });

  it('Create Game for Arena defaults to CTF, 12 min, with the target in captures; the lobby states the rules', () => {
    withReady(['ctf', 'zones', 'hotpoint'], () => {
      const s: RoomSettings = createDefaults('arena', "Pilot's Arena");
      expect(s).toMatchObject({ gameType: 'arena', subMode: 'ctf', matchMinutes: 12, objectiveLimit: 0, scoreLimit: 0, pveIntensity: 0 });
      const fields = settingsFields(s, true);
      const target = fields.find((f) => f.key === 'objectiveLimit')!;
      expect(target.options![0].label).toBe('Default (3 captures)');
      expect(target.options!.map((o) => o.value)).toContain('10');
      expect(fields.find((f) => f.key === 'subMode')!.options!.map((o) => o.value)).toEqual(['ctf', 'zones', 'hotpoint', 'deathmatch']);
      expect(fields.some((f) => f.key === 'mode')).toBe(false); // CTF is teams-only
      expect(objectiveRulesLine('ctf', 'teams', 3)).toContain('First to 3 captures.');
      // Hot Point: FFA allowed, its own FFA default target
      const hotFfa = settingsFields({ ...s, subMode: 'hotpoint', mode: 'ffa', matchMinutes: 10 }, true);
      expect(hotFfa.find((f) => f.key === 'objectiveLimit')!.options![0].label).toBe('Default (120 points)');
      expect(hotFfa.some((f) => f.key === 'mode')).toBe(true);
      // Warzone Zones: points target, Swarm row kept
      const wz = settingsFields({ ...createDefaults('warzone', 'W'), subMode: 'zones' }, true);
      expect(wz.find((f) => f.key === 'objectiveLimit')!.options![0].label).toBe('Default (300 points)');
      expect(wz.some((f) => f.key === 'pveIntensity')).toBe(true);
    });
  });
});
