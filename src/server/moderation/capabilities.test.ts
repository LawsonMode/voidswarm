// The one capability table (docs/LAN-EDITION-proposal.md §5.2): the HTTP routes and the in-game commands share it.
import { describe, expect, it } from 'vitest';
import {
  ASK_THE_HOST, CAPABILITIES, HOST_PC_ONLY_CAPS, SENSITIVE_CAPS, can, capabilitiesOf, commandAllowed, commandPolicy, hostPrincipal,
  mayActOnModerator, mayLift, mayMute, muteLimitSec, type Capability, type Principal,
} from './capabilities';

const hostLocal: Principal = { kind: 'host', via: 'local' };
const hostFull: Principal = { kind: 'host', via: 'full' };
const hostLimited: Principal = { kind: 'host', via: 'limited' };
const modTrusted: Principal = { kind: 'moderator', tier: 'trusted' };
const modLimited: Principal = { kind: 'moderator', tier: 'limited' };

describe('the §5.2 table', () => {
  // [capability, host PC, remote full, remote limited, trusted moderator, limited moderator]
  const rows: [Capability, boolean, boolean, boolean, boolean, boolean][] = [
    ['status', true, true, true, false, false], // moderators: counts only
    ['status.counts', true, true, true, true, true],
    ['live', true, true, true, true, true],
    ['log', true, true, true, false, false], // trusted: only with moderatorLogSearch (below)
    ['reveal', true, true, false, false, false],
    ['log.export', true, true, false, false, false],
    ['log.purge', true, true, false, false, false],
    ['log.stats', true, true, false, false, false],
    ['announce', true, true, true, false, false],
    ['rooms.read', true, true, true, true, true],
    ['rooms.manage', true, true, true, false, false],
    ['accounts', true, true, false, false, false],
    ['accounts.reveal', true, true, false, false, false],
    ['accounts.export', true, true, false, false, false],
    ['accounts.delete', true, true, false, false, false],
    ['conduct', true, true, false, false, false],
    ['wellbeing', true, true, false, false, false],
    ['reports', true, true, true, true, true],
    ['reports.reporter', true, true, true, true, false], // limited: reporter hidden
    ['moderate', true, true, true, true, true],
    ['ban', true, true, true, true, false],
    ['ban.host', true, true, true, false, false], // trusted: not host bans
    ['moderators.act', true, true, true, false, false], // nobody below the host acts on a moderator
    ['addresses', true, true, false, true, false], // remote limited: tag only
    ['alerts.threat', true, true, true, false, false], // trusted moderators: in game, name only
    ['alerts.threat.ingame', true, true, false, true, false],
    ['whois', true, true, true, true, true], // scrubbed per principal
    ['terms', true, true, false, false, false],
    ['settings', true, true, false, false, false],
    ['mail.test', true, true, false, false, false],
    ['backups', true, true, false, false, false],
    ['backups.restore', true, false, false, false, false],
    ['recovery', true, false, false, false, false],
    ['stop', true, false, false, false, false],
    ['cert.new', true, false, false, false, false],
    ['cert.own', true, false, false, false, false],
    ['folders.open', true, false, false, false, false],
    ['update', true, false, false, false, false],
    ['audit', true, true, false, false, false],
    ['setup', true, false, false, false, false],
    ['log.original.ingame', true, true, false, true, false],
  ];
  it.each(rows)('%s', (cap, local, full, limited, trusted, lim) => {
    expect([can(hostLocal, cap), can(hostFull, cap), can(hostLimited, cap), can(modTrusted, cap), can(modLimited, cap)])
      .toEqual([local, full, limited, trusted, lim]);
  });

  it('covers every capability', () => {
    const listed = new Set(rows.map((r) => r[0]));
    const missing = CAPABILITIES.filter((c) => !listed.has(c) && !['cert.renew', 'compact', 'alerts.ack'].includes(c));
    expect(missing).toEqual([]);
  });

  it('trusted moderators search the Chat log only with moderatorLogSearch; limited never', () => {
    expect(can(modTrusted, 'log', { logSearch: true })).toBe(true);
    expect(can(modTrusted, 'log', { logSearch: false })).toBe(false);
    expect(can(modLimited, 'log', { logSearch: true })).toBe(false);
  });

  it('a click-through remote session never gets more than the limited set', () => {
    expect(can(modTrusted, 'addresses', { untrustedTls: true })).toBe(false);
    expect(can(modTrusted, 'live', { untrustedTls: true })).toBe(true);
    expect(can(hostFull, 'conduct', { untrustedTls: true })).toBe(false);
  });

  it('★ capabilities and host-PC-only capabilities', () => {
    for (const c of ['reveal', 'log.export', 'log.purge', 'accounts.reveal', 'accounts.export', 'accounts.delete', 'conduct', 'wellbeing', 'terms', 'settings'] as Capability[]) {
      expect(SENSITIVE_CAPS.has(c), c).toBe(true);
    }
    expect(SENSITIVE_CAPS.has('live')).toBe(false);
    for (const c of HOST_PC_ONLY_CAPS) {
      expect(can(hostLocal, c)).toBe(true);
      expect(can(hostFull, c)).toBe(false);
    }
  });

  it('capabilitiesOf lists what `me` returns: a limited moderator gets Live, Rooms and Reports', () => {
    expect(capabilitiesOf(modLimited)).toEqual(['status.counts', 'live', 'rooms.read', 'reports', 'moderate', 'whois']);
    expect(capabilitiesOf(hostLocal)).toEqual([...CAPABILITIES]);
  });
});

describe('hostPrincipal', () => {
  it('host PC → local; remote → full only with trusted TLS and remoteAccess full; off → none', () => {
    expect(hostPrincipal({ via: 'local', hostPc: true, remoteAccess: 'off', trustedTls: false })).toEqual(hostLocal);
    expect(hostPrincipal({ via: 'direct', hostPc: false, remoteAccess: 'off', trustedTls: false })).toEqual(hostFull);
    expect(hostPrincipal({ via: 'https', hostPc: false, remoteAccess: 'off', trustedTls: true })).toBeNull();
    expect(hostPrincipal({ via: 'https', hostPc: false, remoteAccess: 'limited', trustedTls: true })).toEqual(hostLimited);
    // `full` without devicesTrustCert behaves as `limited` (T-ADM-3)
    expect(hostPrincipal({ via: 'https', hostPc: false, remoteAccess: 'full', trustedTls: false })).toEqual(hostLimited);
    expect(hostPrincipal({ via: 'https', hostPc: false, remoteAccess: 'full', trustedTls: true })).toEqual(hostFull);
    expect(hostPrincipal({ via: 'proxy', hostPc: false, remoteAccess: 'full', trustedTls: true })).toEqual(hostFull);
  });
});

describe('moderation rules and in-game commands', () => {
  it('mutes: ≤ 24 h without `ban`, any length with it', () => {
    expect(muteLimitSec(modLimited)).toBe(24 * 3600);
    expect(muteLimitSec(modTrusted)).toBeNull();
    expect(mayMute(modLimited, 3600)).toBe(true);
    expect(mayMute(modLimited, 24 * 3600 + 1)).toBe(false);
    expect(mayMute(modLimited, null)).toBe(false);
    expect(mayMute(modTrusted, null)).toBe(true);
  });

  it('lifting: bans need `ban`; host bans need `ban.host`; limited moderators lift only their own mutes', () => {
    expect(mayLift(modLimited, { kind: 'ban', by: 'Nova', hostBan: false }, 'Nova')).toBe(false);
    expect(mayLift(modLimited, { kind: 'mute', by: 'Nova', hostBan: false }, 'nova')).toBe(true);
    expect(mayLift(modLimited, { kind: 'mute', by: 'Other', hostBan: false }, 'Nova')).toBe(false);
    expect(mayLift(modTrusted, { kind: 'ban', by: 'Other', hostBan: false }, 'Nova')).toBe(true);
    expect(mayLift(modTrusted, { kind: 'ban', by: 'teacher', hostBan: true }, 'Nova')).toBe(false);
    expect(mayLift(hostLimited, { kind: 'ban', by: 'teacher', hostBan: true }, 'teacher')).toBe(true);
    expect(mayActOnModerator(modTrusted)).toBe(false);
    expect(mayActOnModerator(hostLimited)).toBe(true);
  });

  it('commandAllowed / commandPolicy: limited moderators get "Ask the host" for bans and shown text in /log', () => {
    expect(commandAllowed(modLimited, 'ban')).toEqual({ ok: false, reply: ASK_THE_HOST });
    expect(commandAllowed(modLimited, 'unban')).toEqual({ ok: false, reply: ASK_THE_HOST });
    expect(commandAllowed(modLimited, 'kick')).toEqual({ ok: true });
    expect(commandAllowed(modTrusted, 'ipban')).toEqual({ ok: true });
    expect(commandPolicy(modLimited)).toMatchObject({
      muteMaxSec: 24 * 3600, unmuteOwnOnly: true, canBan: false, logOriginal: false, logMaxLines: 10, showReporter: false,
      whoisFull: false, addresses: false, actOnModerators: false, threatAlerts: false,
    });
    expect(commandPolicy(modTrusted)).toMatchObject({
      muteMaxSec: null, unmuteOwnOnly: false, canBan: true, liftHostBans: false, logOriginal: true, logMaxLines: 50,
      showReporter: true, whoisFull: true, addresses: true, actOnModerators: false, threatAlerts: true,
    });
  });
});
