import { describe, expect, it } from 'vitest';
import type { UpgradeChoice } from '../../shared/types';
import { NO_TEAM } from '../../shared/constants';
import { DEFAULT_ROOM_SETTINGS, TEAM_UNASSIGNED, type PlayerInfo } from '../../shared/protocol';
import { offerKind, pathForChoice, talentPath } from '../ui/LevelUpCards';
import { dropInMessages } from '../ui/RoomLobby';
import {
  apiBaseFromServerUrl, isInsecureRemote, isLocalOrLan, isSessionExpiredMessage, SESSION_ENDED_MSG, validateNewPassword,
  validateRegistration,
} from './accounts';

describe('apiBaseFromServerUrl', () => {
  it('maps ws→http and wss→https keeping host and port', () => {
    expect(apiBaseFromServerUrl('ws://localhost:7777')).toBe('http://localhost:7777');
    expect(apiBaseFromServerUrl('wss://voidswarm.example.com')).toBe('https://voidswarm.example.com');
    expect(apiBaseFromServerUrl('wss://game.example.com:8443/ws?x=1')).toBe('https://game.example.com:8443');
    expect(apiBaseFromServerUrl('ws://192.168.1.20:7777/')).toBe('http://192.168.1.20:7777');
    expect(apiBaseFromServerUrl('  ws://[::1]:7777  ')).toBe('http://[::1]:7777');
  });
  it('accepts http(s) URLs and rejects junk', () => {
    expect(apiBaseFromServerUrl('https://a.io')).toBe('https://a.io');
    expect(apiBaseFromServerUrl('not a url')).toBeNull();
    expect(apiBaseFromServerUrl('ftp://a.io')).toBeNull();
    expect(apiBaseFromServerUrl('')).toBeNull();
  });
});

describe('insecure connection warning', () => {
  it('flags plain ws:// to public hosts only', () => {
    expect(isInsecureRemote('ws://voidswarm.example.com:7777')).toBe(true);
    expect(isInsecureRemote('ws://8.8.8.8:7777')).toBe(true);
    expect(isInsecureRemote('wss://voidswarm.example.com')).toBe(false);
    expect(isInsecureRemote('ws://localhost:7777')).toBe(false);
    expect(isInsecureRemote('ws://127.0.0.1:7777')).toBe(false);
    expect(isInsecureRemote('ws://192.168.0.5:7777')).toBe(false);
    expect(isInsecureRemote('ws://10.1.2.3:7777')).toBe(false);
    expect(isInsecureRemote('ws://172.20.0.1:7777')).toBe(false);
    expect(isInsecureRemote('ws://BAT-COMPUTER:7777')).toBe(false);
    expect(isInsecureRemote('garbage')).toBe(false);
  });
  it('does not mistake fc*/fd* domains for IPv6 unique-local', () => {
    expect(isLocalOrLan('fcbarcelona.com')).toBe(false);
    expect(isLocalOrLan('fd00::1')).toBe(true);
    expect(isLocalOrLan('172.32.0.1')).toBe(false);
  });
});

describe('registration validation', () => {
  const ok = { username: 'Nova_7', email: 'nova@example.com', password: 'hunter2hunter2', confirm: 'hunter2hunter2' };
  it('accepts a valid form', () => {
    expect(validateRegistration(ok)).toBeNull();
    expect(validateRegistration({ ...ok, username: '  abc  ' })).toBeNull();
  });
  it('rejects bad usernames (USERNAME_RE)', () => {
    expect(validateRegistration({ ...ok, username: 'ab' })).toMatch(/Username/);
    expect(validateRegistration({ ...ok, username: 'a'.repeat(17) })).toMatch(/Username/);
    expect(validateRegistration({ ...ok, username: 'bad name' })).toMatch(/Username/);
    expect(validateRegistration({ ...ok, username: 'bad!' })).toMatch(/Username/);
  });
  it('rejects bad emails', () => {
    expect(validateRegistration({ ...ok, email: 'nope' })).toMatch(/email/);
    expect(validateRegistration({ ...ok, email: 'a@b' })).toMatch(/email/);
  });
  it('enforces PASSWORD_MIN and matching confirmation', () => {
    expect(validateRegistration({ ...ok, password: 'short', confirm: 'short' })).toMatch(/at least 8/);
    expect(validateRegistration({ ...ok, confirm: 'different1' })).toMatch(/match/);
    expect(validateNewPassword('12345678', '12345678')).toBeNull();
  });
  it('recognises the session-expired server message', () => {
    expect(isSessionExpiredMessage('Session expired — please log in again')).toBe(true);
    expect(isSessionExpiredMessage('Room is full')).toBe(false);
    // a revoked session (logout elsewhere / password reset) is just as dead: the stored token is cleared
    expect(isSessionExpiredMessage('Session ended — please log in again')).toBe(true);
    expect(isSessionExpiredMessage(SESSION_ENDED_MSG)).toBe(true);
    expect(isSessionExpiredMessage('Logged in elsewhere')).toBe(false);
  });
});

describe('level-up offer classification', () => {
  const c = (id: string, category: UpgradeChoice['category']): UpgradeChoice =>
    ({ id, name: id, description: '', level: 1, maxLevel: 1, category, icon: '' });
  it('detects path forks and resolves their PathDef', () => {
    const offer = [c('path:ram', 'path'), c('path:barrage', 'path'), c('path:bulwark', 'path')];
    expect(offerKind(offer)).toBe('path');
    expect(pathForChoice(offer[1])?.name).toBe('Barrage');
    expect(pathForChoice(c('heavy', 'weapon'))).toBeNull();
  });
  it('detects talent offers and their path accent', () => {
    const offer = [c('ram_quake', 'talent'), c('ram_momentum', 'talent')];
    expect(offerKind(offer)).toBe('talent');
    expect(talentPath(offer[0])?.id).toBe('ram');
    expect(offerKind([c('heavy', 'weapon'), c('orbit', 'auto')])).toBe('general');
  });
});

describe('room lobby drop-in (F9)', () => {
  const settings = (mode: 'teams' | 'ffa') => ({ ...DEFAULT_ROOM_SETTINGS, mode, teamCount: 2 });
  const p = (playerId: number, team: number, isBot = false): PlayerInfo =>
    ({ playerId, name: 'p' + playerId, team, shipClass: 'brute', isBot, isHost: false, ready: false, ping: 0, inMatch: false });

  it('spectators / unassigned pilots can watch a running match', () => {
    expect(dropInMessages('watch', p(1, TEAM_UNASSIGNED), settings('teams'), [], 1))
      .toEqual([{ type: 'setTeam', team: TEAM_UNASSIGNED }, { type: 'joinMatch' }]);
  });

  it('joining without a team picks one first (so spectating vs unpicked does not matter)', () => {
    const players = [p(1, TEAM_UNASSIGNED), p(2, 0), p(3, 0, true)];
    expect(dropInMessages('join', players[0], settings('teams'), players, 1))
      .toEqual([{ type: 'setTeam', team: 1 }, { type: 'joinMatch' }]);
    expect(dropInMessages('join', p(1, TEAM_UNASSIGNED), settings('ffa'), [], 1))
      .toEqual([{ type: 'setTeam', team: NO_TEAM }, { type: 'joinMatch' }]);
    expect(dropInMessages('join', p(1, 0), settings('teams'), [], 1)).toEqual([{ type: 'joinMatch' }]);
    expect(dropInMessages('join', p(1, NO_TEAM), settings('ffa'), [], 1)).toEqual([{ type: 'joinMatch' }]);
  });
});
