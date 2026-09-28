import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import type { GameEvent, Snapshot } from '../shared/types';
import {
  ConnectionGate, EventCarry, MAX_CARRIED_EVENTS, SessionRegistry, addressKey, clientAddressKey, createFrameCache,
  defaultCorsOrigins, isLocalNetworkAddress, isTrustedProxyPeer, lastForwardedHop, parseProxyTrust, resolveCorsOrigins,
} from './netguard';

describe('addresses & proxy trust (SEC-9)', () => {
  it('normalizes addresses into rate-limit keys', () => {
    expect(addressKey('1.2.3.4')).toBe('1.2.3.4');
    expect(addressKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(addressKey('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(addressKey('[2001:db8:1:2:3:4:5:6]:443')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(addressKey(undefined)).toBe('unknown');
  });

  it('recognizes loopback / private peers', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.20', 'fd00::1', 'fe80::1%eth0']) {
      expect(isLocalNetworkAddress(a)).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'garbage', undefined]) {
      expect(isLocalNetworkAddress(a)).toBe(false);
    }
  });

  it('only believes X-Forwarded-For with TRUST_PROXY and from a local or listed proxy', () => {
    const off = parseProxyTrust({});
    const on = parseProxyTrust({ TRUST_PROXY: '1' });
    const listed = parseProxyTrust({ TRUST_PROXY: 'true', TRUSTED_PROXIES: '203.0.113.7, 198.51.100.1' });
    expect(off.enabled).toBe(false);
    expect(isTrustedProxyPeer('127.0.0.1', off)).toBe(false);
    expect(isTrustedProxyPeer('127.0.0.1', on)).toBe(true);
    expect(isTrustedProxyPeer('8.8.8.8', on)).toBe(false); // a client that reached the port directly
    expect(isTrustedProxyPeer('203.0.113.7', listed)).toBe(true);
    expect(lastForwardedHop('9.9.9.9, 5.6.7.8')).toBe('5.6.7.8');
    expect(lastForwardedHop(['1.1.1.1', '2.2.2.2'])).toBe('2.2.2.2');
    expect(lastForwardedHop(undefined)).toBeNull();
    // forged header from a direct client is ignored; the proxy-appended hop from a local proxy is used
    expect(clientAddressKey('8.8.8.8', '1.2.3.4', on)).toBe('8.8.8.8');
    expect(clientAddressKey('127.0.0.1', 'spoof, 5.6.7.8', on)).toBe('5.6.7.8');
    expect(clientAddressKey('127.0.0.1', '5.6.7.8', off)).toBe('127.0.0.1');
  });
});

describe('ConnectionGate (SEC-5)', () => {
  it('caps concurrent connections per address and in total, and connect rate per address', () => {
    const g = new ConnectionGate({ maxTotal: 5, maxPerAddress: 2, burst: 3, perSec: 1 });
    expect(g.tryAcquire('a', 0)).toBeNull();
    expect(g.tryAcquire('a', 0)).toBeNull();
    expect(g.tryAcquire('a', 0)).toMatch(/Too many connections/);
    g.release('a');
    expect(g.tryAcquire('a', 0)).toBeNull(); // 3rd connect of the burst
    g.release('a');
    expect(g.tryAcquire('a', 0)).toMatch(/too fast/); // burst spent
    expect(g.tryAcquire('a', 1500)).toBeNull(); // refilled
    expect(g.openFor('a')).toBe(2);
    expect(g.tryAcquire('b', 0)).toBeNull();
    expect(g.tryAcquire('c', 0)).toBeNull();
    expect(g.tryAcquire('d', 0)).toBeNull();
    expect(g.connections).toBe(5);
    expect(g.tryAcquire('e', 0)).toMatch(/full/);
    g.release('b'); g.release('b'); // double release is harmless
    expect(g.connections).toBe(4);
  });
});

describe('CORS default (SEC-7)', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as NetworkInterfaceInfo],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false } as NetworkInterfaceInfo,
      { address: 'fe80::1', family: 'IPv6', internal: false } as NetworkInterfaceInfo,
    ],
  };

  it('allows PUBLIC_URL and this machine\'s dev client only — never "*" by default', () => {
    const o = defaultCorsOrigins('https://voidswarm.example.com/some/path', ifaces, ['BAT-COMPUTER', 'bad host!']);
    expect(o).toContain('https://voidswarm.example.com');
    expect(o).toContain('http://localhost:5173');
    expect(o).toContain('http://127.0.0.1:5173');
    expect(o).toContain('http://192.168.1.20:5173');
    expect(o).toContain('http://localhost:4173');
    expect(o).toContain('http://bat-computer:5173');
    expect(o).toContain('http://bat-computer.local:5173');
    expect(o.some((x) => x.includes('bad host'))).toBe(false);
    expect(o).not.toContain('*');
    expect(o.some((x) => x.includes('evil'))).toBe(false);
    expect(defaultCorsOrigins('not a url', {})).not.toContain('not a url');
  });

  it('CORS_ORIGINS overrides; "*" only when set explicitly', () => {
    const fb = () => ['fallback'];
    expect(resolveCorsOrigins(undefined, fb)).toEqual(['fallback']);
    expect(resolveCorsOrigins('  ', fb)).toEqual(['fallback']);
    expect(resolveCorsOrigins('*', fb)).toBe('*');
    expect(resolveCorsOrigins('https://a.io, https://b.io', fb)).toEqual(['https://a.io', 'https://b.io']);
  });
});

describe('SessionRegistry (SEC-10)', () => {
  it('finds the live connections of one revoked session, or of all an account\'s sessions', () => {
    const r = new SessionRegistry<string>();
    const forgetA1 = r.add('acc1', 'h1', 'a1');
    r.add('acc1', 'h2', 'a2');
    r.add('acc1', 'h1', 'a1-tab2'); // same session in two tabs
    r.add('acc2', 'h9', 'b1');
    expect(r.revoke('acc1', 'hX')).toEqual([]);
    expect(r.revoke('acc1', 'h1').sort()).toEqual(['a1', 'a1-tab2']);
    expect(r.count('acc1')).toBe(1);
    forgetA1(); // already revoked: harmless
    expect(r.revoke('acc1', null)).toEqual(['a2']);
    expect(r.count('acc1')).toBe(0);
    expect(r.revoke('nobody', null)).toEqual([]);
    const forgetB = r.add('acc2', 'h8', 'b2');
    forgetB();
    expect(r.revoke('acc2', null)).toEqual(['b1']);
  });
});

describe('EventCarry (NET-5)', () => {
  const snap = (events: GameEvent[]): Snapshot => ({
    tick: 1, ackSeq: 0, you: null, ships: [], enemies: [], projectiles: [], gems: [], deployables: [], events,
    match: { phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 1, teamScores: [0, 0], wave: 1, winnerTeam: -1, winnerPlayerId: 0 },
  });
  const death: GameEvent = { t: 'shipDeath', shipId: 1, playerId: 2, killerPlayerId: 3, cause: 'player', x: 0, y: 0, bounty: 20 };
  const hit: GameEvent = { t: 'hit', x: 1, y: 1, targetKind: 'ship', targetId: 1, amount: 3 };
  const lvl: GameEvent = { t: 'levelUp', playerId: 2, level: 4 };

  it('keeps the global events of a dropped snapshot and delivers them with the next one', () => {
    const c = new EventCarry();
    c.hold(snap([death, hit, lvl]));
    expect(c.size).toBe(2); // positional FX are stale by then
    const next = snap([hit]);
    const merged = c.merge(next);
    expect(merged.events.map((e) => e.t)).toEqual(['shipDeath', 'levelUp', 'hit']);
    expect(next.events).toHaveLength(1); // input not mutated
    expect(c.merge(snap([])).events).toEqual([]);
  });

  it('is bounded and resets on a new match', () => {
    const c = new EventCarry();
    for (let i = 0; i < MAX_CARRIED_EVENTS + 50; i++) c.hold(snap([death]));
    expect(c.size).toBe(MAX_CARRIED_EVENTS);
    c.reset();
    expect(c.size).toBe(0);
  });
});

describe('createFrameCache (SEC-5)', () => {
  it('serializes a broadcast message once for all recipients', () => {
    const frameOf = createFrameCache();
    const m = { type: 'chat', text: 'x' };
    const f1 = frameOf(m);
    expect(frameOf(m)).toBe(f1);
    expect(f1.toString('utf8')).toBe(JSON.stringify(m));
    const f2 = frameOf({ type: 'chat', text: 'x' });
    expect(f2).not.toBe(f1);
    expect(f2.toString('utf8')).toBe(f1.toString('utf8'));
  });
});
