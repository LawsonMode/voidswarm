// Settings service (docs/LAN-EDITION-proposal.md §5.13, §11.4): T-SET-1 … T-SET-7, plus validation, presets, the
// SMTP password's write-only path, subscribers and the bindings. Every test uses its own temp data folder.
// Offensive test inputs are never spelled out: they come from the compiled (ROT13) lists at run time.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compiled } from '../../shared/moderation/engine';
import { clearCustomTerms, setCustomTerms } from '../../shared/moderation/custom';
import { DEFAULT_POSITIVE_LINES, TAG_SELF_HARM } from '../../shared/room/moderation';
import { Zone, type ClientSink } from '../../shared/room/Zone';
import type { ServerMsg } from '../../shared/protocol';
import { PROTOCOL_VERSION } from '../../shared/version';
import { AuthStore } from '../auth/store';
import { ModerationService } from '../moderation/service';
import { memorySecrets, openFileSecrets } from '../secrets';
import {
  CONFIG_FILE, CONFIG_LOCK_SUFFIX, SETTINGS_SPEC, SettingsConflictError, SettingsLoadError, SettingsService, auditToModeration, bindSettings,
  checkRules, createSettings, defaultSettings, diffSettings, envDifferences, mailFingerprint, maskAddress, memoryBackend, moderationConfigOf,
  fileBackend, networkApproveReply, normalizeDomain, parseDomainEntry, presetValues, readConfigFile, realFs, realFsAsync,
  settingsFromRaw, settingsGetReply, settingsUpdateReply, validate, writeFileAtomicSync,
  type AtomicFs, type AtomicFsAsync, type HostSettings, type SettingsActor, type SettingsAuditEvent, type SettingsFail, type SettingsOk,
  type SettingsResult,
} from './index';

const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const HOST: SettingsActor = { accountId: 'host:1', name: 'Mr. O\'Brien' };
const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);

const dirs: string[] = [];
const mods: ModerationService[] = [];
afterEach(() => {
  clearCustomTerms(); // process-wide: never leak a test's custom terms into the next test
  for (const m of mods.splice(0)) { try { m.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows: still open */ } }
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'voidswarm-settings-'));
  dirs.push(d);
  return d;
};

interface Rig { svc: SettingsService; dir: string; logs: string[]; audit: SettingsAuditEvent[] }
function open(dir: string, opts: Partial<Parameters<typeof SettingsService.open>[0]> = {}): Rig {
  const logs: string[] = [];
  const audit: SettingsAuditEvent[] = [];
  const svc = SettingsService.open({ dataDir: dir, env: {}, log: (l) => logs.push(l), audit: (e) => audit.push(e), now: () => T0, ...opts });
  return { svc, dir, logs, audit };
}
const okOf = (r: SettingsResult): SettingsOk => { if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`); return r; };
const failOf = (r: SettingsResult): SettingsFail => { if (r.ok) throw new Error('expected a refusal'); return r; };
const stored = (dir: string): HostSettings => JSON.parse(readFileSync(join(dir, CONFIG_FILE), 'utf8')) as HostSettings;

/** A chat word of a tier, from the compiled lists (never spelled out in this file). */
const termOf = (tier: 'block' | 'mild'): string =>
  compiled().terms.find((t) => t.tier === tier && t.chat && !t.nameOnly && !t.term.includes(' ') && /^[a-z]+$/.test(t.term))!.term;

// ------------------------------------------------------------------------------------------
// T-SET-1: env seeding on the first run; later, one warning per differing variable
// ------------------------------------------------------------------------------------------

describe('T-SET-1 env seeding', () => {
  const seedEnv = {
    CHAT_LOG_RETENTION_DAYS: '30',
    MOD_STRIKE_LIMIT: '5',
    MOD_AUTOMUTE_MIN: '15',
    ACCOUNT_EMAIL_DOMAINS: 'caldwellschools.org,*.caldwellschools.org',
    ALLOW_GUESTS: '0',
    CHAT_FILTER: 'strict',
    MAX_CONN_PER_IP: '96',
    SMTP_HOST: 'smtp-relay.gmail.com',
    SMTP_PORT: '587',
    MAIL_FROM: 'Voidswarm <no-reply@caldwellschools.org>',
  };

  it('seeds a new config from the environment and saves it', () => {
    const dir = tempDir();
    const { svc, logs } = open(dir, { env: seedEnv });
    expect(svc.created).toBe(true);
    const s = svc.get();
    expect(s.chat.retention).toMatchObject({ mode: 'days', days: 30 });
    expect(s.chat.strikes).toEqual({ limit: 5, windowMin: 10, autoMuteMin: 15 });
    expect(s.accounts.domains).toEqual([{ domain: 'caldwellschools.org', subdomains: true }]);
    expect(s.accounts.allowGuests).toBe(false);
    expect(s.rooms.maxConnectionsPerAddress).toBe(96);
    expect(s.mail).toMatchObject({ host: 'smtp-relay.gmail.com', port: 587, preset: 'relay', from: 'Voidswarm <no-reply@caldwellschools.org>' });
    expect([...s.seededFromEnv].sort()).toEqual(Object.keys(seedEnv).sort());
    expect(s.rev).toBe(1);
    expect(s.installId).toMatch(/^[0-9a-f]{32}$/);
    // on disk, the same values
    const disk = stored(dir);
    expect(disk.chat.retention.days).toBe(30);
    expect(disk.rev).toBe(1);
    expect(logs.some((l) => l.includes('created') && l.includes('CHAT_LOG_RETENTION_DAYS'))).toBe(true);
    expect(logs.some((l) => l.includes('ignored'))).toBe(false);
  });

  it('later runs keep the saved settings and warn once per differing variable', async () => {
    const dir = tempDir();
    const first = open(dir, { env: seedEnv });
    // the host changes the retention in the admin console
    okOf(await first.svc.update({ rev: first.svc.rev, patch: { chat: { retention: { days: 90 } } } }, HOST));
    await first.svc.close();

    const env2 = { ...seedEnv, ALLOW_GUESTS: '1', MOD_STRIKE_LIMIT: '5' /* same as saved: no warning */ };
    const second = open(dir, { env: env2 });
    expect(second.svc.created).toBe(false);
    expect(second.svc.get().chat.retention.days).toBe(90); // not re-seeded
    expect(second.svc.get().accounts.allowGuests).toBe(false);
    const ignored = second.logs.filter((l) => l.includes('ignored'));
    expect(ignored).toEqual([
      'CHAT_LOG_RETENTION_DAYS=30 ignored — the admin console setting (90) wins.',
      'ALLOW_GUESTS=1 ignored — the admin console setting (0) wins.',
    ]);
    expect(second.svc.warnings.filter((w) => w.includes('ignored'))).toHaveLength(2);
    // envWarnings: false (the child, when the launcher already logged them)
    const third = open(dir, { env: env2, envWarnings: false });
    expect(third.logs.filter((l) => l.includes('ignored'))).toHaveLength(0);
  });

  it('an invalid value keeps the default with a warning; lookup ignores case', () => {
    const r = createSettings({ lan: true, env: { chat_log_retention_days: '45', MOD_STRIKE_LIMIT: 'lots', MAX_CONNECTIONS: '0' } });
    expect(r.settings.chat.retention.days).toBe(45);
    expect(r.settings.chat.strikes.limit).toBe(3);
    expect(r.settings.rooms.maxConnections).toBe(512);
    expect(r.warnings.some((w) => w.startsWith('WARNING: MOD_STRIKE_LIMIT=lots is not valid'))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('WARNING: MAX_CONNECTIONS=0 is not valid'))).toBe(true);
    expect(r.seeded).toEqual(['CHAT_LOG_RETENTION_DAYS']);
  });

  it('ACCOUNT_EMAIL=required without mail falls back to optional, loudly; with SMTP_HOST it stays', () => {
    const noMail = createSettings({ lan: true, env: { ACCOUNT_EMAIL: 'required' } });
    expect(noMail.settings.accounts.email).toBe('optional');
    expect(noMail.warnings.some((w) => w.startsWith('WARNING: ACCOUNT_EMAIL=required needs working mail'))).toBe(true);
    const withMail = createSettings({ lan: false, env: { ACCOUNT_EMAIL: 'required', SMTP_HOST: 'smtp.caldwellschools.org' } });
    expect(withMail.settings.accounts.email).toBe('required');
    expect(withMail.warnings.some((w) => w.startsWith('NOTICE: ACCOUNT_EMAIL'))).toBe(false);
    // §4.2: a VPS without ACCOUNT_EMAIL gets optional email and a notice (the LAN edition doesn't need one)
    expect(createSettings({ lan: false, env: {} }).warnings.some((w) => w.startsWith('NOTICE: ACCOUNT_EMAIL is not set'))).toBe(true);
    expect(createSettings({ lan: true, env: {} }).warnings).toEqual([]);
    // and later runs say the fallback is still in force
    expect(envDifferences(noMail.settings, { ACCOUNT_EMAIL: 'required' }))
      .toEqual(['ACCOUNT_EMAIL=required ignored — the admin console setting (optional) wins.']);
  });

  it('ADMIN_REMOTE=full needs TRUST_PROXY and an https PUBLIC_URL; VPS moderators keep their tools', () => {
    const lim = createSettings({ lan: false, env: { ADMIN_REMOTE: 'full' } });
    expect(lim.settings.admin.remoteAccess).toBe('limited');
    expect(lim.seeded).toEqual([]); // the fallback is not "seeded": later runs say the variable is ignored
    const proxy = { TRUST_PROXY: '1', PUBLIC_URL: 'https://voidswarm.caldwellschools.org' };
    const full = createSettings({ lan: false, env: { ADMIN_REMOTE: 'full', ...proxy } });
    expect(full.settings.admin.remoteAccess).toBe('full');
    expect(full.seeded).toEqual(['ADMIN_REMOTE']);
    // §4.10 / §5.13: a VPS behind a trusted https proxy starts with remote `full` (the host has no "host PC" there)
    const vpsProxy = createSettings({ lan: false, env: proxy });
    expect(vpsProxy.settings.admin.remoteAccess).toBe('full');
    expect(vpsProxy.warnings.some((w) => w.startsWith('NOTICE: remote admin'))).toBe(false);
    expect(createSettings({ lan: false, env: { ADMIN_REMOTE: 'limited', ...proxy } }).settings.admin.remoteAccess).toBe('limited');
    // without one it stays off, and says so; the LAN edition always starts off
    const vpsBare = createSettings({ lan: false, env: {} });
    expect(vpsBare.settings.admin.remoteAccess).toBe('off');
    expect(vpsBare.warnings.some((w) => w.startsWith('NOTICE: remote admin access is OFF'))).toBe(true);
    expect(createSettings({ lan: true, env: proxy }).settings.admin.remoteAccess).toBe('off');
    const vps = createSettings({ lan: false, env: {}, existingModerators: true });
    expect(vps.settings.moderators).toEqual({ view: true, logSearch: true, tier: 'trusted' });
    const lan = createSettings({ lan: true, env: {}, existingModerators: true });
    expect(lan.settings.moderators).toEqual({ view: false, logSearch: false, tier: 'limited' });
  });

  it('SMTP_HOST is validated before ACCOUNT_EMAIL=required counts; only values in force are listed as seeded', () => {
    // a trailing dot is dropped (the mailer accepts it), and the host is stored in ASCII
    const dot = createSettings({ lan: false, env: { SMTP_HOST: 'smtp.gmail.com.', ACCOUNT_EMAIL: 'required' } });
    expect(dot.settings.mail.host).toBe('smtp.gmail.com');
    expect(dot.settings.accounts.email).toBe('required');
    expect(dot.seeded).toEqual(['SMTP_HOST', 'ACCOUNT_EMAIL']);
    // a host that isn't one: no mail server, so Required falls back to optional, loudly (§4.2)
    for (const host of ['-bad', 'smtp..gmail.com', 'smtp_gmail.com', 'a'.repeat(300)]) {
      const r = createSettings({ lan: false, env: { SMTP_HOST: host, ACCOUNT_EMAIL: 'required' } });
      expect([host.slice(0, 20), r.settings.mail.host, r.settings.accounts.email]).toEqual([host.slice(0, 20), '', 'optional']);
      expect(r.warnings.some((w) => w.startsWith('WARNING: ACCOUNT_EMAIL=required needs working mail'))).toBe(true);
      expect(r.seeded).toEqual([]);
      expect(r.settings.seededFromEnv).toEqual([]);
    }
    // a From address the validation refuses is not "seeded" either
    const from = createSettings({ lan: true, env: { MAIL_FROM: 'not an address', SMTP_HOST: 'smtp-relay.gmail.com' } });
    expect(from.settings.mail.from).toBe('');
    expect(from.seeded).toEqual(['SMTP_HOST']);
  });

  it('a private relay without a login keeps working as "None" (today\'s mailer requires STARTTLS only with a login)', () => {
    const local = createSettings({ lan: false, env: { SMTP_HOST: 'localhost', SMTP_PORT: '25' } });
    expect(local.settings.mail).toMatchObject({ host: 'localhost', port: 25, security: 'none' });
    expect(checkRules(local.settings, null, { lan: false })).toBeNull();
    expect(createSettings({ lan: false, env: { SMTP_HOST: '10.20.0.25', SMTP_SECURE: '0' } }).settings.mail.security).toBe('none');
    // an explicit STARTTLS, a login, or a public relay: STARTTLS stays required
    expect(createSettings({ lan: false, env: { SMTP_HOST: 'localhost', SMTP_SECURE: 'starttls' } }).settings.mail.security).toBe('starttls');
    expect(createSettings({ lan: false, env: { SMTP_HOST: 'localhost', SMTP_USER: 'relay' } }).settings.mail.security).toBe('starttls');
    expect(createSettings({ lan: false, env: { SMTP_HOST: 'localhost', SMTP_PASS: 'relay-pw' } }).settings.mail.security).toBe('starttls');
    expect(createSettings({ lan: false, env: { SMTP_HOST: 'smtp-relay.gmail.com' } }).settings.mail.security).toBe('starttls');
    expect(createSettings({ lan: false, env: { SMTP_HOST: 'localhost', SMTP_SECURE: 'none' } }).settings.mail.security).toBe('none');
    // later runs: SMTP_SECURE=0 ("not implicit TLS") agrees with "None"; no "ignored" line every start
    expect(envDifferences(local.settings, { SMTP_HOST: 'localhost', SMTP_PORT: '25', SMTP_SECURE: '0' })).toEqual([]);
  });

  it('SMTP_PASS is never copied into the config; it still works on a VPS', () => {
    const dir = tempDir();
    const { svc } = open(dir, { env: { SMTP_HOST: 'smtp.caldwellschools.org', SMTP_USER: 'no-reply@caldwellschools.org', SMTP_PASS: 'env-only-Xq7' } });
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).not.toContain('env-only-Xq7');
    expect(svc.get().mail.passwordSet).toBe(true);
    expect(svc.mailPassword()).toBe('env-only-Xq7');
  });
});

// ------------------------------------------------------------------------------------------
// T-SET-2: a stale rev gets 409
// ------------------------------------------------------------------------------------------

describe('T-SET-2 rev', () => {
  it('a stale rev is 409 with the current rev, and nothing changes', async () => {
    const dir = tempDir();
    const { svc } = open(dir);
    const rev0 = svc.rev;
    const a = okOf(await svc.update({ rev: rev0, patch: { rooms: { maxRooms: 10 } } }, HOST));
    expect(a.rev).toBe(rev0 + 1);
    expect(a.changed).toEqual(['rooms.maxRooms']);
    const b = failOf(await svc.update({ rev: rev0, patch: { rooms: { maxRooms: 8 } } }, HOST));
    expect(b).toMatchObject({ status: 409, rev: rev0 + 1 });
    expect(svc.get().rooms.maxRooms).toBe(10);
    expect(stored(dir).rooms.maxRooms).toBe(10);
    expect(failOf(await svc.update({ patch: { rooms: { maxRooms: 8 } } }, HOST))).toMatchObject({ status: 400, field: 'rev' });
    expect(failOf(await svc.update('nope', HOST)).status).toBe(400);
  });

  it('a change saved by another process makes the older copy 409, then it sees the new values', async () => {
    const dir = tempDir();
    const panel = open(dir);
    const cli = open(dir);
    const seen = panel.svc.rev;
    okOf(await cli.svc.update({ rev: cli.svc.rev, patch: { serverName: 'Room 136' } }, { accountId: 'cli', name: 'cli' }));
    const r = failOf(await panel.svc.update({ rev: seen, patch: { rooms: { maxRooms: 9 } } }, HOST));
    expect(r.status).toBe(409);
    expect(r.rev).toBe(seen + 1);
    expect(panel.svc.get().serverName).toBe('Room 136');
    okOf(await panel.svc.update({ rev: r.rev, patch: { rooms: { maxRooms: 9 } } }, HOST));
    expect(stored(dir)).toMatchObject({ serverName: 'Room 136', rooms: { maxRooms: 9 } });
  });

  it('an unchanged patch keeps the rev and writes nothing', async () => {
    const { svc, audit } = open(tempDir());
    const r = okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: svc.get().rooms.maxRooms } } }, HOST));
    expect(r.changed).toEqual([]);
    expect(r.rev).toBe(1);
    expect(audit).toHaveLength(0);
  });

  it('writes are serialized: concurrent updates with the same rev → one wins, one 409', async () => {
    const { svc } = open(tempDir());
    const rev = svc.rev;
    const [a, b] = await Promise.all([
      svc.update({ rev, patch: { rooms: { maxRooms: 7 } } }, HOST),
      svc.update({ rev, patch: { rooms: { maxRooms: 8 } } }, HOST),
    ]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(svc.get().rooms.maxRooms).toBe(7);
  });
});

// ------------------------------------------------------------------------------------------
// T-SET-3: one audit row per changed leaf; the password shows as (changed)
// ------------------------------------------------------------------------------------------

describe('T-SET-3 audit', () => {
  const PASSWORD = 'app-password-Kq3vZ9';

  it('one row per changed leaf, "old → new"; the password is "(changed)" and never stored or shown', async () => {
    const dir = tempDir();
    const secrets = openFileSecrets(dir);
    const { svc, audit } = open(dir, { secrets });
    const r = okOf(await svc.update({
      rev: svc.rev,
      patch: {
        chat: { retention: { days: 30 } },
        rooms: { maxRooms: 10 },
        accounts: { domains: ['caldwellschools.org'] },
        mail: { host: 'smtp.gmail.com', user: 'no-reply@caldwellschools.org', password: PASSWORD },
      },
    }, HOST));
    expect(r.changed).toEqual(['accounts.domains', 'mail.host', 'mail.user', 'chat.retention.days', 'rooms.maxRooms', 'mail.password']);
    expect(audit.map((a) => a.reason)).toEqual([
      'accounts.domains: [] → [{"domain":"caldwellschools.org","subdomains":false}]',
      'mail.host: "" → "smtp.gmail.com"',
      'mail.user: "" → "n…@caldwellschools.org"', // an address is masked in the audit trail
      'chat.retention.days: 90 → 30',
      'rooms.maxRooms: 12 → 10',
      'mail.password: (changed)',
    ]);
    expect(audit.every((a) => a.actor === HOST)).toBe(true);
    // the secret: only in data\secrets\smtp.secret
    expect(secrets.readText('smtp.secret')).toBe(PASSWORD);
    expect(svc.mailPassword()).toBe(PASSWORD);
    expect(svc.get().mail.passwordSet).toBe(true);
    const everywhere = [JSON.stringify(audit), readFileSync(join(dir, CONFIG_FILE), 'utf8'), JSON.stringify(svc.get()), JSON.stringify(r)];
    for (const text of everywhere) expect(text).not.toContain(PASSWORD);
    // changing it again: one row, (changed); the same password again: no change at all
    audit.length = 0;
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { password: 'another-Kq3vZ9' } } }, HOST));
    expect(audit.map((a) => a.reason)).toEqual(['mail.password: (changed)']);
    audit.length = 0;
    const same = okOf(await svc.update({ rev: svc.rev, patch: { mail: { password: 'another-Kq3vZ9' } } }, HOST));
    expect(same.changed).toEqual([]);
    expect(audit).toHaveLength(0);
    // removing it
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { password: null } } }, HOST));
    expect(audit.map((a) => a.reason)).toEqual(['mail.password: (changed)']);
    expect(secrets.has('smtp.secret')).toBe(false);
    expect(svc.get().mail.passwordSet).toBe(false);
  });

  it('email addresses (alert email, mail login, From) are masked in the audit trail, never shown in full', async () => {
    const { svc, audit } = open(tempDir());
    okOf(await svc.update({ rev: svc.rev, patch: { alerts: { email: 'teacher@caldwellschools.org' }, mail: { from: "Mr. O'Brien <room136@caldwellschools.org>" } } }, HOST));
    okOf(await svc.update({ rev: svc.rev, patch: { alerts: { email: 'office@caldwellschools.org' } } }, HOST));
    expect(audit.map((a) => a.reason)).toEqual([
      'mail.from: "" → "r…@caldwellschools.org"',
      'alerts.email: "" → "t…@caldwellschools.org"',
      'alerts.email: "t…@caldwellschools.org" → "o…@caldwellschools.org"',
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/teacher@|office@|room136@/);
    expect(svc.get().alerts.email).toBe('office@caldwellschools.org'); // the setting itself is unchanged
    expect(maskAddress('relay-user')).toBe('r…');
  });

  it('tag policy leaves are audited one by one; a new custom tag starts from tagDefault', async () => {
    const { svc, audit } = open(tempDir());
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { tags: { HATE: { notify: 'urgent', autoMuteAfter: 2 }, bullying: { notify: 'banner' } } } } }, HOST));
    expect(audit.map((a) => a.reason)).toEqual([
      'chat.tags.HATE.autoMuteAfter: 3 → 2',
      'chat.tags.HATE.notify: "banner" → "urgent"',
      'chat.tags.BULLYING.strike: (none) → false',
      'chat.tags.BULLYING.notify: (none) → "banner"',
      'chat.tags.BULLYING.dailySummary: (none) → true',
    ]); // autoMuteAfter stays null: no row
    expect(svc.get().chat.tags.BULLYING).toEqual({ strike: false, autoMuteAfter: null, notify: 'banner', dailySummary: true });
    audit.length = 0;
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { tags: { BULLYING: null } } } }, HOST));
    expect(svc.get().chat.tags.BULLYING).toBeUndefined();
    expect(audit.length).toBe(3); // strike, notify, dailySummary gone (autoMuteAfter was null)
  });

  it('rows land in mod_actions as action "settings" through the moderation service', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const mod = new ModerationService({ dbPath, log: () => {}, timers: false, env: {} });
    mods.push(mod);
    const { svc } = open(dir, { audit: auditToModeration(mod), secrets: memorySecrets() });
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 11 }, mail: { password: 'mod-actions-Pw1' } } }, HOST));
    const rows = mod.store.listActions({ limit: 10 }).actions;
    expect(rows.map((r) => [r.action, r.actorAccountId, r.actor, r.reason]).reverse()).toEqual([
      ['settings', 'host:1', 'Mr. O\'Brien', 'rooms.maxRooms: 12 → 11'],
      ['settings', 'host:1', 'Mr. O\'Brien', 'mail.password: (changed)'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('mod-actions-Pw1');
  });
});

// ------------------------------------------------------------------------------------------
// T-SET-4: `required` without lastTest gets 409 needsMailTest
// ------------------------------------------------------------------------------------------

describe('T-SET-4 required needs a mail test', () => {
  it('409 needsMailTest until a test succeeds with the current mail settings', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    const r = failOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST));
    expect(r).toMatchObject({ status: 409, needsMailTest: true, field: 'accounts.email' });
    expect(svc.get().accounts.email).toBe('optional');
    // no mail server yet: the test can't be recorded
    expect(failOf(await svc.recordMailTest(HOST, { fingerprint: svc.mailFingerprint() })).status).toBe(400);
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp-relay.gmail.com', from: 'no-reply@caldwellschools.org' } } }, HOST));
    expect(svc.mailReady()).toBe(false);
    okOf(await svc.recordMailTest(HOST, { fingerprint: svc.mailFingerprint() }));
    expect(svc.mailReady()).toBe(true);
    expect(svc.get().mail.lastTest).toEqual({ at: T0, fingerprint: mailFingerprint(svc.get().mail) });
    okOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST));
    expect(svc.get().accounts.email).toBe('required');
  });

  it('changing the mail settings (or the password) voids the test; Required already on stays on', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp.gmail.com', user: 'no-reply@caldwellschools.org', password: 'app-pw-1' } } }, HOST));
    okOf(await svc.recordMailTest(HOST, { fingerprint: svc.mailFingerprint() }));
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { password: 'app-pw-2' } } }, HOST));
    expect(svc.mailReady()).toBe(false); // the test was made with the old password
    expect(failOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST)).needsMailTest).toBe(true);
    okOf(await svc.recordMailTest(HOST, { fingerprint: svc.mailFingerprint() }));
    okOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST));
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { port: 465, security: 'tls' } } }, HOST));
    expect(svc.mailReady()).toBe(false);
    expect(svc.get().accounts.email).toBe('required'); // only the switch is locked (the panel shows a banner)
    // switching back and forth needs a fresh test
    okOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'optional' } } }, HOST));
    expect(failOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST)).status).toBe(409);
  });

  it('a test counts only for the settings it was sent with (the mail settings changed while it was on its way)', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp.gmail.com', user: 'no-reply@caldwellschools.org', password: 'app-pw-1' } } }, HOST));
    const before = svc.mailFingerprint(); // smtp/test takes it, then sends
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp.office365.com' } } }, HOST)); // meanwhile
    const r = failOf(await svc.recordMailTest(HOST, { fingerprint: before }));
    expect(r).toMatchObject({ status: 409, field: 'mail' });
    expect(svc.mailReady()).toBe(false);
    expect(failOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST)).needsMailTest).toBe(true);
    expect(failOf(await svc.recordMailTest(HOST, {} as never)).field).toBe('fingerprint');
    okOf(await svc.recordMailTest(HOST, { fingerprint: svc.mailFingerprint(), at: T0 + 5 }));
    expect(svc.get().mail.lastTest?.at).toBe(T0 + 5);
    okOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST));
  });
});

// ------------------------------------------------------------------------------------------
// T-SET-5: lowering maxRooms blocks the next create live; running rooms survive
// ------------------------------------------------------------------------------------------

class FakeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  closedReason: string | null = null;
  sendMsg(m: ServerMsg): void { this.msgs.push(m); }
  sendSnapshot(): void { /* not needed */ }
  close(reason: string): void { this.closedReason = reason; }
  last<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }> | undefined {
    const a = this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
    return a[a.length - 1];
  }
}

describe('T-SET-5 live room limits', () => {
  it('bindSettings pushes a lowered cap to the Zone at once (and only the parts that changed)', async () => {
    const { svc } = open(tempDir());
    const calls: { limits: unknown[]; chat: unknown[] } = { limits: [], chat: [] };
    const zone = {
      setLimits: (l: unknown) => { calls.limits.push(l); },
      setChatOptions: (o: unknown) => { calls.chat.push(o); return { ok: true }; },
    };
    const gate = { limits: { maxTotal: 512, maxPerAddress: 64, burst: 64, perSec: 1 } };
    const modCfg = { strikeLimit: 3, strikeWindowMs: 600_000, autoMuteSec: 600, retentionDays: 90, keepDays: 365, chatFilter: 'strict' as const };
    const off = bindSettings(svc, { zone, gate, moderation: { config: modCfg }, log: () => {} });
    expect(calls.limits).toEqual([{ maxRooms: 12, maxPlayingRooms: 6, maxRoomsPerAddress: 3 }]); // applied at once
    expect(calls.chat).toHaveLength(1);
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 6, maxConnections: 40 } } }, HOST));
    expect(calls.limits[1]).toEqual({ maxRooms: 6, maxPlayingRooms: 6, maxRoomsPerAddress: 3 });
    expect(calls.chat).toHaveLength(1); // chat options unchanged: not re-applied
    expect(gate.limits).toMatchObject({ maxTotal: 40, maxPerAddress: 64, burst: 64 });
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { strikes: { limit: 4 }, retention: { mode: 'forever' } } } }, HOST));
    expect(modCfg).toMatchObject({ strikeLimit: 4, retentionDays: 3650 });
    off();
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 7 } } }, HOST));
    expect(calls.limits).toHaveLength(2);
  });

  it('a Zone without setLimits yet is skipped with one log line', async () => {
    const { svc } = open(tempDir());
    const logs: string[] = [];
    bindSettings(svc, { zone: { setChatOptions: () => ({ ok: true }) }, log: (l) => logs.push(l) });
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 6 } } }, HOST));
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 7 } } }, HOST));
    expect(logs.filter((l) => l.includes('Zone.setLimits'))).toHaveLength(1);
  });

  it('with the real Zone and ModerationService: chat options and strikes apply live, no restart', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const mod = new ModerationService({ dbPath, log: () => {}, timers: false, env: {} });
    mods.push(mod);
    const { svc } = open(dir);
    const zone = new Zone({ snapshotEvery: 3, motd: 'hi', local: false, defaultRooms: [] });
    bindSettings(svc, { zone: zone as never, moderation: mod, log: () => {} });
    expect(zone.chatOptions()).toMatchObject({ substitute: 'sender', strictness: 'strict' });
    const lines = ['GG, pilots!', 'Nice moves!', 'Smooth flying!', 'What a match!', 'Onward, pilots!'];
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { substitute: 'system', positiveLines: lines, strikes: { limit: 5, autoMuteMin: 30 } } } }, HOST));
    expect(zone.chatOptions()).toEqual({ substitute: 'system', positiveLines: lines, strictness: 'strict' });
    expect(mod.config).toMatchObject({ strikeLimit: 5, autoMuteSec: 1800 });
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { strictness: 'standard' } } }, HOST));
    expect(zone.chatOptions().strictness).toBe('standard');
    expect(mod.config.chatFilter).toBe('standard');
    zone.stop();
  });

  const zoneHasLimits = typeof (Zone.prototype as unknown as { setLimits?: unknown }).setLimits === 'function';
  it.skipIf(!zoneHasLimits)('with the real Zone: the next create is refused, the running rooms stay', async () => {
    const { svc } = open(tempDir());
    const zone = new Zone({
      snapshotEvery: 3, motd: 'hi', local: false,
      defaultRooms: Array.from({ length: 6 }, (_, i) => ({ name: `Room ${i + 1}`, gameType: 'arena' as const, subMode: 'deathmatch' as const, botFill: 0 })),
    });
    bindSettings(svc, { zone: zone as never, log: () => {} });
    const c = new FakeClient();
    const conn = zone.connect(c);
    conn.setAccount(null);
    conn.setAddress('10.0.0.5');
    conn.handle({ type: 'hello', name: 'NovaPilot', protocol: PROTOCOL_VERSION, version: 'test' });
    conn.handle({ type: 'createRoom', settings: { name: 'Before' } });
    expect(c.last('roomState')?.roomId).not.toBeNull(); // 7 rooms now
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 6 } } }, HOST));
    const other = new FakeClient();
    const conn2 = zone.connect(other);
    conn2.setAccount(null);
    conn2.setAddress('10.0.0.6');
    conn2.handle({ type: 'hello', name: 'VegaPilot', protocol: PROTOCOL_VERSION, version: 'test' });
    conn2.handle({ type: 'createRoom', settings: { name: 'After' } });
    expect(other.last('error')?.message).toBeTruthy();
    const names = (other.last('roomList')?.rooms ?? []).map((r) => r.name);
    expect(names).toContain('Before'); // running rooms survive a lowered cap
    expect(names).not.toContain('After');
    zone.stop();
  });
});

// ------------------------------------------------------------------------------------------
// T-SET-6: a crash during a write leaves the previous config readable
// ------------------------------------------------------------------------------------------

describe('T-SET-6 atomic writes', () => {
  type Step = 'write' | 'fsync' | 'rename';
  /** An async file system that "crashes" (throws) at a chosen step of the atomic write (what settings/update uses). */
  const crashingAsync = (at: Step): AtomicFsAsync => ({
    ...realFsAsync,
    open: async (file, flags, mode) => {
      const h = await realFsAsync.open(file, flags, mode);
      return {
        writeFile: async (d) => {
          if (at === 'write') { await h.writeFile(d.slice(0, Math.floor(d.length / 2))); throw new Error('power lost while writing'); }
          await h.writeFile(d);
        },
        sync: async () => { if (at === 'fsync') throw new Error('power lost at fsync'); await h.sync(); },
        close: () => h.close(),
      };
    },
    rename: async (a, b) => { if (at === 'rename') throw new Error('power lost before the rename'); await realFsAsync.rename(a, b); },
  });
  /** The same for the synchronous writer (first run). */
  const crashingSync = (at: Step): AtomicFs => ({
    ...realFs,
    writeSync: (fd, data) => {
      if (at === 'write') { realFs.writeSync(fd, data.slice(0, Math.floor(data.length / 2))); throw new Error('power lost while writing'); }
      return realFs.writeSync(fd, data);
    },
    fsyncSync: (fd) => { if (at === 'fsync') throw new Error('power lost at fsync'); realFs.fsyncSync(fd); },
    renameSync: (a, b) => { if (at === 'rename') throw new Error('power lost before the rename'); realFs.renameSync(a, b); },
  });

  for (const at of ['write', 'fsync', 'rename'] as const) {
    it(`a crash at "${at}" during settings/update leaves the previous config readable`, async () => {
      const dir = tempDir();
      const file = join(dir, CONFIG_FILE);
      const { svc } = open(dir);
      okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 136' } }, HOST));
      const before = readFileSync(file, 'utf8');
      // a service on the same file whose next write crashes
      const crashy = SettingsService.open({ env: {}, log: () => {}, backend: { ...fileBackend(file, { fs: crashingAsync(at) }) } });
      const r = failOf(await crashy.update({ rev: crashy.rev, patch: { serverName: 'Room 137' } }, HOST));
      expect(r.status).toBe(500);
      expect(crashy.get().serverName).toBe('Room 136'); // not committed in memory either
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      const again = open(dir);
      expect(again.svc.get().serverName).toBe('Room 136');
    });

    it(`a crash at "${at}" in the synchronous writer leaves the previous file`, () => {
      const dir = tempDir();
      const file = join(dir, CONFIG_FILE);
      writeFileAtomicSync(file, '{"rev": 1}');
      expect(() => writeFileAtomicSync(file, '{"rev": 2, "serverName": "Room 137"}', { fs: crashingSync(at), keepBackup: true })).toThrow(/power lost/);
      expect(readFileSync(file, 'utf8')).toBe('{"rev": 1}');
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
  }

  it('a real process killed in the middle of writing leaves a readable config', async () => {
    const dir = tempDir();
    const file = join(dir, CONFIG_FILE);
    const script = join(dir, 'writer.ts');
    const storeUrl = pathToFileURL(fileURLToPath(new URL('./store.ts', import.meta.url))).href;
    // Rewrites a 100 KB config as fast as it can, until it is killed.
    writeFileSync(script, [
      `import { writeFileAtomicSync } from ${JSON.stringify(storeUrl)};`,
      `const file = ${JSON.stringify(file)};`,
      "const pad = 'x'.repeat(100_000);",
      'for (let rev = 1; ; rev++) {',
      '  writeFileAtomicSync(file, JSON.stringify({ configVersion: 1, rev, serverName: `Room ${rev}`, pad }), { keepBackup: true });',
      "  if (rev === 3) process.stdout.write('ready' + String.fromCharCode(10));",
      '}',
    ].join(String.fromCharCode(10)));
    for (let round = 0; round < 4; round++) {
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the writer never started')), 15_000);
        child.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('ready')) { clearTimeout(t); resolve(); } });
        child.on('exit', (code) => { clearTimeout(t); reject(new Error(`the writer exited (${code})`)); });
      });
      await new Promise((r) => setTimeout(r, 5 + round * 17));
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await exited;
      const got = readConfigFile(file);
      expect(got.source).toBe('main'); // never half-written, never missing
      expect(typeof got.raw?.rev).toBe('number');
      const again = open(dir);
      expect(again.svc.get().serverName).toMatch(/^Room \d+$/);
    }
  }, 60_000);

  it('a half-written temp file from a killed process is ignored and cleaned up', async () => {
    const dir = tempDir();
    const { svc } = open(dir);
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 136' } }, HOST));
    const stale = join(dir, `.${CONFIG_FILE}.4242.deadbeef.tmp`);
    const fresh = join(dir, `.${CONFIG_FILE}.4343.cafebabe.tmp`);
    writeFileSync(stale, '{"serverName": "Room 1');
    writeFileSync(fresh, '{"serverName": "Room 2');
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(stale, old, old);
    const again = open(dir);
    expect(again.svc.get().serverName).toBe('Room 136');
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // maybe another process's write in progress: left alone
  });

  it('a damaged main file falls back to the .bak copy (and is rewritten); both damaged is a clear error', async () => {
    const dir = tempDir();
    const file = join(dir, CONFIG_FILE);
    const { svc } = open(dir);
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 136' } }, HOST));
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 137' } }, HOST)); // .bak = "Room 136"
    writeFileSync(file, '{"serverName": "Room 1'); // truncated by something outside Voidswarm
    const rec = open(dir);
    expect(rec.svc.get().serverName).toBe('Room 136');
    expect(rec.logs.some((l) => l.includes('damaged') && l.includes('backup copy'))).toBe(true);
    expect(stored(dir).serverName).toBe('Room 136');
    // the good .bak was not replaced by the damaged file
    expect((JSON.parse(readFileSync(file + '.bak', 'utf8')) as HostSettings).serverName).toBe('Room 136');
    writeFileSync(file, 'nope');
    writeFileSync(file + '.bak', 'nope');
    expect(() => open(dir)).toThrow(SettingsLoadError);
    let msg = '';
    try { open(dir); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(`${CONFIG_FILE}.bak is damaged too`);
    expect(msg).toContain(`move both ${CONFIG_FILE} and ${CONFIG_FILE}.bak`);
    // only the main file moved away: still an error (never a silent reset to the defaults), and it says "missing"
    rmSync(file);
    try { open(dir); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/is missing, and its backup copy/);
    // following the advice works: both moved away is a first run
    rmSync(file + '.bak');
    expect(open(dir).svc.created).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------
// T-SET-7: the School preset's values; moderators.tier can't be trusted under School
// ------------------------------------------------------------------------------------------

describe('T-SET-7 presets', () => {
  /** §5.13's preset table, row by row. */
  const TABLE: [string, unknown, unknown][] = [
    ['accounts.signInOverHttp', 'warn', 'block'],
    ['accounts.allowGuests', true, false],
    ['accounts.sessionHours', 720, 12],
    ['accounts.sessionStore', 'local', 'session'], // the Public-computer box: unticked / ticked
    ['accounts.selfDelete', true, false],
    ['network.certScope', 'network', 'pc'],
    ['network.newRoot', 'ask', 'never'],
    ['network.portAutoPick', 'firstRun', 'never'],
    ['launcher.elevated', 'warn', 'refuse'],
    ['launcher.permissions', 'warn', 'refuse'],
    ['moderators.tier', 'limited', 'limited'],
    ['accounts.rateLimits', 'normal', 'scaled'],
    ['admin.presentingAtLogin', false, true],
    ['chat.addressMinimisation', false, true],
    ['rooms.maxRoomsPerAddress', 3, 6],
    ['rooms.maxConnectionsPerAddress', 64, 128],
    ['chat.strictness', 'strict', 'strict'],
  ];
  const at = (s: HostSettings, p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], s);

  it('defaults for Home and School follow the table (and the §4.2 / §5.9 defaults)', () => {
    const home = defaultSettings({ preset: 'home' });
    const school = defaultSettings({ preset: 'school' });
    for (const [p, h, sc] of TABLE) {
      expect([p, at(home, p)]).toEqual([p, h]);
      expect([p, at(school, p)]).toEqual([p, sc]);
    }
    for (const s of [home, school]) {
      expect(s.accounts).toMatchObject({ signup: 'open', email: 'optional', domains: [], hostApproval: false, existingAccounts: 'verifyAtNextLogin', emailStorage: 'full' });
      expect(s.chat.retention).toMatchObject({ mode: 'days', days: 90 });
      expect(s.chat.recordsDays).toBe(365);
      expect(s.chat.substitute).toBe('sender');
      expect(s.rooms).toMatchObject({ maxRooms: 12, maxPlayingRooms: 6, maxConnections: 512 });
      expect(s.admin).toMatchObject({ remoteAccess: 'off', idleMinutes: 30, stepUpMinutes: 10, liveKeepsAlive: true });
      expect(s.moderators).toMatchObject({ view: false, logSearch: false });
      expect(s.integrations.hostedModeration.enabled).toBe(false);
    }
    // the VPS / npm start keeps the code defaults for rooms
    expect(defaultSettings({ lan: false }).rooms).toMatchObject({ maxRooms: 24, maxRoomsPerAddress: 6 });
    // School setup: roster → rosterOnly, guests off
    expect(presetValues('school', { accountsMode: 'roster' }).accounts).toMatchObject({ signup: 'rosterOnly', allowGuests: false });
    expect(presetValues('home', { accountsMode: 'roster' }).accounts).toMatchObject({ signup: 'rosterOnly', allowGuests: false });
  });

  it('applyPreset(school) at setup gives the table values, audited as "preset school"', async () => {
    const { svc, audit } = open(tempDir());
    const r = okOf(await svc.applyPreset('school', HOST, { accountsMode: 'roster', serverName: 'Room 136 – Mr. O\'Brien' }));
    const s = svc.get();
    expect(s.preset).toBe('school');
    for (const [p, , sc] of TABLE) expect([p, at(s, p)]).toEqual([p, sc]);
    expect(s.accounts.signup).toBe('rosterOnly');
    expect(s.serverName).toBe('Room 136 – Mr. O\'Brien');
    expect(r.changed).toContain('preset');
    expect(audit.length).toBe(r.changed.length);
    expect(audit.every((a) => a.context === 'preset school' && a.reason.endsWith('(preset school)'))).toBe(true);
    expect(audit.find((a) => a.path === 'accounts.signInOverHttp')?.reason).toBe('accounts.signInOverHttp: "warn" → "block" (preset school)');
  });

  it('moderators.tier cannot be set to trusted under School, nor on the LAN (a VPS Home host can choose it, §5.2)', async () => {
    const lanHome = open(tempDir());
    const refused = failOf(await lanHome.svc.update({ rev: lanHome.svc.rev, patch: { moderators: { tier: 'trusted' } } }, HOST));
    expect(refused).toMatchObject({ status: 400, field: 'moderators.tier' });
    expect(refused.error).toMatch(/only for a server on the internet/);
    const lanWarn: string[] = [];
    expect(settingsFromRaw({ ...defaultSettings(), moderators: { view: true, logSearch: true, tier: 'trusted' } }, { lan: true }, lanWarn).moderators.tier).toBe('limited');
    expect(lanWarn.some((w) => w.includes('trusted is only for a VPS host'))).toBe(true);
    const home = open(tempDir(), { lan: false });
    okOf(await home.svc.update({ rev: home.svc.rev, patch: { moderators: { tier: 'trusted' } } }, HOST));
    expect(home.svc.get().moderators.tier).toBe('trusted');
    // Home → School resets the tier to limited
    okOf(await home.svc.applyPreset('school', HOST));
    expect(home.svc.get().moderators.tier).toBe('limited');
    const r = failOf(await home.svc.update({ rev: home.svc.rev, patch: { moderators: { tier: 'trusted' } } }, HOST));
    expect(r).toMatchObject({ status: 400, field: 'moderators.tier' });
    expect(r.error).toMatch(/fixed to limited in the School preset/);
    expect(home.svc.get().moderators.tier).toBe('limited');
    // a hand-edited School config with trusted is repaired on load
    const warnings: string[] = [];
    const s = settingsFromRaw({ ...defaultSettings({ preset: 'school' }), moderators: { view: true, logSearch: true, tier: 'trusted' } }, { lan: true }, warnings);
    expect(s.moderators.tier).toBe('limited');
    expect(warnings.some((w) => w.includes('fixed to limited'))).toBe(true);
  });

  it('School: "forever" retention needs the district tick (Home allows it)', async () => {
    const home = open(tempDir());
    okOf(await home.svc.update({ rev: home.svc.rev, patch: { chat: { retention: { mode: 'forever' } } } }, HOST));
    const school = open(tempDir(), { preset: 'school' });
    expect(school.svc.get().preset).toBe('school');
    const r = failOf(await school.svc.update({ rev: school.svc.rev, patch: { chat: { retention: { mode: 'forever' } } } }, HOST));
    expect(r).toMatchObject({ status: 400, field: 'chat.retention.districtApproved' });
    okOf(await school.svc.update({ rev: school.svc.rev, patch: { chat: { retention: { mode: 'forever', districtApproved: true } } } }, HOST));
    // Home with forever → School: back to 90 days, with a warning
    const moved = okOf(await home.svc.applyPreset('school', HOST));
    expect(home.svc.get().chat.retention).toMatchObject({ mode: 'days', days: 90 });
    expect(moved.warnings.some((w) => w.includes('district tick'))).toBe(true);
  });

  it('applyPreset keeps what the environment seeded (an operator\'s explicit choice)', async () => {
    const { svc } = open(tempDir(), { env: { ALLOW_GUESTS: '1', MAX_CONN_PER_IP: '200' } });
    okOf(await svc.applyPreset('school', HOST));
    expect(svc.get().accounts.allowGuests).toBe(true);
    expect(svc.get().rooms.maxConnectionsPerAddress).toBe(200);
    expect(svc.get().accounts.signInOverHttp).toBe('block');
  });
});

// ------------------------------------------------------------------------------------------
// Validation, rules and helpers
// ------------------------------------------------------------------------------------------

describe('validation', () => {
  it('unknown, read-only and invalid keys are refused with the field named', async () => {
    const { svc } = open(tempDir());
    const cases: [unknown, string][] = [
      [{ rooms: { maxRoomz: 3 } }, 'rooms.maxRoomz'],
      [{ preset: 'school' }, 'preset'],
      [{ rev: 99 }, 'rev'],
      [{ mail: { lastTest: null } }, 'mail.lastTest'],
      [{ network: { approvedNetworks: [] } }, 'network.approvedNetworks'],
      [{ rooms: { maxRooms: 4 } }, 'rooms.maxRooms'],
      [{ rooms: { maxRooms: 30 } }, 'rooms.maxRooms'],
      [{ rooms: { maxRooms: '12' } }, 'rooms.maxRooms'],
      [{ chat: { retention: { days: 0 } } }, 'chat.retention.days'],
      [{ chat: { retention: { mode: 'term' } } }, 'chat.retention.termEnd'],
      [{ chat: { retention: { mode: 'term', termEnd: '2026-02-30' } } }, 'chat.retention.termEnd'],
      [{ admin: { idleMinutes: 300 } }, 'admin.idleMinutes'],
      [{ admin: { stepUpMinutes: 4 } }, 'admin.stepUpMinutes'],
      [{ chat: { substitute: 'masked' } }, 'chat.substitute'],
      [{ serverName: '' }, 'serverName'],
      [{ serverName: 'Room\n136' }, 'serverName'],
      [{ chat: { notice: 'x'.repeat(201) } }, 'chat.notice'],
      [{ accounts: { domains: ['10.0.0.1'] } }, 'accounts.domains'],
      [{ accounts: { domains: ['caldwellschools.org.'] } }, 'accounts.domains'],
      [{ network: { extraNames: ['*.caldwellschools.org'] } }, 'network.extraNames'],
      [{ network: { adminPort: 7777 } }, 'network.adminPort'],
      [{ mail: { from: 'x@y.org\r\nBcc: z@w.org' } }, 'mail.from'],
      [{ chat: { tags: { [TAG_SELF_HARM]: { strike: true } } } }, `chat.tags.${TAG_SELF_HARM}`],
      [{ chat: { tags: { [TAG_SELF_HARM]: { notify: 'none' } } } }, `chat.tags.${TAG_SELF_HARM}.notify`],
      [{ chat: { tags: { THREAT: null } } }, 'chat.tags.THREAT'],
      [{ chat: { tags: { 'no!pe': {} } } }, 'chat.tags.no!pe'],
      [{ chat: { positiveLines: ['GG!', 'Nice!'] } }, 'chat.positiveLines'],
      [{ integrations: { hostedModeration: { enabled: true } } }, 'integrations.hostedModeration.enabled'],
      [{ chat: { classPeriods: [{ name: 'P1', start: '09:00', end: '08:00' }] } }, 'chat.classPeriods'],
      [[], 'patch'],
    ];
    for (const [patch, field] of cases) {
      const r = failOf(await svc.update({ rev: svc.rev, patch }, HOST));
      expect([JSON.stringify(patch), r.status, r.field]).toEqual([JSON.stringify(patch), 400, field]);
    }
    expect(svc.rev).toBe(1); // nothing was saved
  });

  it('"None" mail security only to a private relay, never with a password', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    expect(failOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp.gmail.com', security: 'none' } } }, HOST)).field).toBe('mail.security');
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: '10.20.0.25', port: 25, security: 'none' } } }, HOST));
    expect(failOf(await svc.update({ rev: svc.rev, patch: { mail: { password: 'pw-for-relay' } } }, HOST)).field).toBe('mail.security');
    expect(failOf(await svc.update({ rev: svc.rev, patch: { mail: { user: 'relay' } } }, HOST)).field).toBe('mail.security');
  });

  it('a mail password needs a secret store; it is write-only text', async () => {
    const { svc } = open(tempDir());
    expect(failOf(await svc.update({ rev: svc.rev, patch: { mail: { password: 'x' } } }, HOST)).field).toBe('mail.password');
    const withStore = open(tempDir(), { secrets: memorySecrets() });
    expect(failOf(await withStore.svc.update({ rev: withStore.svc.rev, patch: { mail: { password: 42 } } }, HOST)).field).toBe('mail.password');
    expect(failOf(await withStore.svc.update({ rev: withStore.svc.rev, patch: { mail: { password: 'x'.repeat(1025) } } }, HOST)).field).toBe('mail.password');
  });

  it('validate() / check() answer exactly as settings/update would, and save nothing', async () => {
    const { svc, dir } = open(tempDir(), { secrets: memorySecrets() });
    const before = readFileSync(join(dir, CONFIG_FILE), 'utf8');
    const refusals: unknown[] = [
      { rooms: { maxRoomz: 3 } }, { preset: 'school' }, { rooms: { maxRooms: 4 } }, { chat: { retention: { mode: 'term' } } },
      { network: { adminPort: 7777 } }, { chat: { tags: { [TAG_SELF_HARM]: { strike: true } } } }, { mail: { password: 42 } },
      { accounts: { email: 'required' } }, { moderators: { tier: 'trusted' } }, [],
    ];
    for (const patch of refusals) {
      const v = svc.check(patch);
      const u = failOf(await svc.update({ rev: svc.rev, patch }, HOST));
      expect(v.ok).toBe(false);
      const f = v as SettingsFail;
      expect([JSON.stringify(patch), f.status, f.field, f.needsMailTest ?? false]).toEqual([JSON.stringify(patch), u.status, u.field, u.needsMailTest ?? false]);
    }
    // A password in the patch counts as saved: "None" security to a relay is then refused, as update refuses it.
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: '10.20.0.25', port: 25, security: 'none' } } }, HOST));
    expect((svc.check({ mail: { password: 'relay-pw-9f3k2' } }) as SettingsFail).field).toBe('mail.security');
    expect((svc.check({ mail: { password: null } })).ok).toBe(true);
    // A good patch comes back merged; nothing moved.
    const rev = svc.rev;
    const stored2 = readFileSync(join(dir, CONFIG_FILE), 'utf8');
    const good = svc.check({ rooms: { maxRooms: 8 }, chat: { retention: { days: 30 } } });
    expect(good.ok && good.settings.rooms.maxRooms).toBe(8);
    expect(good.ok && good.settings.chat.retention.days).toBe(30);
    expect(svc.get().rooms.maxRooms).toBe(12);
    expect(svc.rev).toBe(rev);
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe(stored2);
    expect(stored2).not.toBe(before); // (only the relay change above was saved)
    // The pure function: School's fixed tier, and a VPS Home host may choose trusted (§5.2).
    const school = defaultSettings({ preset: 'school' });
    expect((validate(school, { moderators: { tier: 'trusted' } }, { lan: false }) as SettingsFail).field).toBe('moderators.tier');
    expect(validate(defaultSettings({ lan: false }), { moderators: { tier: 'trusted' } }, { lan: false }).ok).toBe(true);
    // Without a secret store, a password can't be saved (check says so too).
    expect((open(tempDir()).svc.check({ mail: { password: 'x' } }) as SettingsFail).field).toBe('mail.password');
  });

  it('positive lines must pass the filter at the strictness in force', async () => {
    const { svc } = open(tempDir());
    const mild = termOf('mild'); // passes 'standard', starred by 'strict'
    const lines = [...DEFAULT_POSITIVE_LINES.slice(0, 5), `Nice ${mild} flying!`];
    const refused = failOf(await svc.update({ rev: svc.rev, patch: { chat: { positiveLines: lines } } }, HOST));
    expect(refused.field).toBe('chat.positiveLines');
    expect(refused.rejected).toEqual([{ line: `Nice ${mild} flying!`, why: "doesn't pass the chat filter" }]);
    expect(refused.error).not.toContain(mild); // the error never names the word
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { strictness: 'standard', positiveLines: lines } } }, HOST));
    // back to strict with that line still there: refused
    expect(failOf(await svc.update({ rev: svc.rev, patch: { chat: { strictness: 'strict' } } }, HOST)).field).toBe('chat.positiveLines');
    // a blocked word in the notice / server name
    const blocked = termOf('block');
    const n = failOf(await svc.update({ rev: svc.rev, patch: { chat: { notice: `Hello ${blocked}` } } }, HOST));
    expect(n.field).toBe('chat.notice');
    expect(n.error).not.toContain(blocked);
    expect(failOf(await svc.update({ rev: svc.rev, patch: { serverName: `${blocked} room` } }, HOST)).field).toBe('serverName');
  });

  it('domains: §4.3 normalization', () => {
    expect(normalizeDomain('  CaldwellSchools.ORG ')).toEqual({ ok: true, value: 'caldwellschools.org' });
    expect(parseDomainEntry('@caldwellschools.org')).toEqual({ ok: true, value: { domain: 'caldwellschools.org', subdomains: false } });
    expect(parseDomainEntry('*.caldwellschools.org')).toEqual({ ok: true, value: { domain: 'caldwellschools.org', subdomains: true } });
    const idn = normalizeDomain('bücher.example');
    expect(idn.ok && idn.value).toBe('xn--bcher-kva.example');
    for (const bad of ['[10.0.0.1]', '10.0.0.1', 'caldwellschools.org.', 'a..b.org', 'localhost', '', 'caldwell schools.org']) {
      expect([bad, normalizeDomain(bad).ok]).toEqual([bad, false]);
    }
  });

  it('class periods, extra names and custom tags are cleaned up', async () => {
    const { svc } = open(tempDir());
    const r = okOf(await svc.update({
      rev: svc.rev,
      patch: {
        chat: { classPeriods: [{ name: '  Period   1 ', start: '08:05', end: '08:55' }, { name: 'Period 5', start: '12:40', end: '13:30', days: [5, 1, 1] }] },
        network: { extraNames: ['Voidswarm.CaldwellSchools.org', 'voidswarm.caldwellschools.org', '10.20.31.77', 'ROOM136-PC'] },
      },
    }, HOST));
    expect(r.settings.chat.classPeriods).toEqual([
      { name: 'Period 1', start: '08:05', end: '08:55', days: [1, 2, 3, 4, 5] },
      { name: 'Period 5', start: '12:40', end: '13:30', days: [1, 5] },
    ]);
    expect(r.settings.network.extraNames).toEqual(['voidswarm.caldwellschools.org', '10.20.31.77', 'room136-pc']);
  });

  it('warnings: the alias-domain note, remote full without trusted TLS, restart for a port change', async () => {
    const { svc } = open(tempDir());
    const r = okOf(await svc.update({
      rev: svc.rev,
      patch: { accounts: { domains: ['caldwellschools.org', 'students.caldwellschools.org'] }, admin: { remoteAccess: 'full' }, network: { port: 7779, adminPort: 7780 } },
    }, HOST));
    expect(r.warnings.join(' ')).toMatch(/alias domain/);
    expect(r.warnings.join(' ')).toMatch(/until then remote sessions are limited/);
    expect(r.restartNeeded).toBe(true);
  });

  it('load is field by field: a bad leaf falls back to its default, unknown keys are dropped', () => {
    const warnings: string[] = [];
    const s = settingsFromRaw({
      configVersion: 1, rev: 7, preset: 'school', serverName: 'Room 136',
      rooms: { maxRooms: 'lots', maxPlayingRooms: 4 }, chat: { tags: { THREAT: { notify: 'loud' } }, retention: { days: 45 } },
      admin: { remoteAccess: 'full' }, surprise: { x: 1 },
    }, { lan: true }, warnings);
    expect(s.rev).toBe(7);
    expect(s.serverName).toBe('Room 136');
    expect(s.rooms).toMatchObject({ maxRooms: 12, maxPlayingRooms: 4, maxRoomsPerAddress: 6 }); // the School default
    expect(s.chat.tags.THREAT!.notify).toBe('urgent');
    expect(s.chat.retention.days).toBe(45);
    expect(s.admin.remoteAccess).toBe('full');
    expect((s as unknown as Record<string, unknown>).surprise).toBeUndefined();
    expect(warnings.some((w) => w.startsWith('rooms.maxRooms'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('chat.tags.THREAT.notify'))).toBe(true);
    // a newer config version loads with a warning
    const w2: string[] = [];
    settingsFromRaw({ configVersion: 9 }, { lan: true }, w2);
    expect(w2.some((w) => w.includes('newer Voidswarm'))).toBe(true);
  });

  it('every default passes its own rules, and the spec covers every default leaf', () => {
    for (const preset of ['home', 'school'] as const) {
      for (const lan of [true, false]) {
        const s = defaultSettings({ preset, lan });
        expect(checkRules(s, null, { lan })).toBeNull();
        expect(settingsFromRaw(JSON.parse(JSON.stringify(s)) as Record<string, unknown>, { lan }, [])).toMatchObject({ ...s, installId: expect.any(String) });
      }
    }
    const keys = Object.keys(SETTINGS_SPEC.fields).sort();
    expect(keys).toEqual(Object.keys(defaultSettings()).sort());
    expect(diffSettings(defaultSettings(), defaultSettings({ preset: 'school' })).map((c) => c.path)).toContain('accounts.signInOverHttp');
  });

  it('get() is frozen and never exposes secrets', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    const s = svc.get();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.chat.tags.THREAT)).toBe(true);
    expect(() => { (s.rooms as { maxRooms: number }).maxRooms = 1; }).toThrow();
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp.gmail.com', user: 'no-reply@caldwellschools.org', password: 'frozen-secret-9' } } }, HOST));
    expect(JSON.stringify(svc.get())).not.toContain('frozen-secret-9');
    expect('password' in svc.get().mail).toBe(false);
  });
});

describe('subscribers and apply', () => {
  it('subscribe: paths filter, immediate, a failing listener does not stop the others', async () => {
    const { svc, logs } = open(tempDir());
    const seen: string[][] = [];
    const all: string[][] = [];
    svc.subscribe((_n, _p, changed) => { seen.push([...changed]); }, { paths: ['rooms'] });
    svc.subscribe(() => { throw new Error('boom'); });
    svc.subscribe((_n, _p, changed) => { all.push([...changed]); }, { immediate: true });
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { notice: 'Be kind.' } } }, HOST));
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxPlayingRooms: 3 } } }, HOST));
    expect(seen).toEqual([['rooms.maxPlayingRooms']]);
    expect(all).toEqual([['*'], ['chat.notice'], ['rooms.maxPlayingRooms']]);
    expect(logs.filter((l) => l.includes('subscriber failed'))).toHaveLength(2);
  });

  it('apply (server-internal) may set system-managed leaves; approveNetwork records a network', async () => {
    const { svc, audit } = open(tempDir());
    okOf(await svc.apply({ network: { ownCertificate: true, port: 7779, adminPort: 7780 } }, { accountId: 'launcher', name: 'launcher' }));
    expect(svc.get().network).toMatchObject({ ownCertificate: true, port: 7779, adminPort: 7780 });
    okOf(await svc.approveNetwork('10.20.0.0/16', true, HOST));
    okOf(await svc.approveNetwork('10.20.0.0/16', false, HOST));
    expect(svc.get().network.approvedNetworks).toEqual([{ id: '10.20.0.0/16', serve: false, at: T0 }]);
    expect(audit.some((a) => a.path === 'network.approvedNetworks' && a.context === 'network approval')).toBe(true);
    // the retention job's fallback after a term with no next date (§5.5)
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { retention: { mode: 'term', termEnd: '2026-12-19' } } } }, HOST));
    okOf(await svc.apply({ chat: { retention: { mode: 'days', days: 90 } } }, undefined, { context: 'no next term date' }));
    expect(svc.get().chat.retention.mode).toBe('days');
    expect(audit.at(-1)?.reason).toBe('chat.retention.mode: "term" → "days" (no next term date)');
  });

  it('a closed service refuses writes', async () => {
    const { svc } = open(tempDir());
    await svc.close();
    expect(failOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 9 } } }, HOST)).status).toBe(500);
  });

  it('memoryBackend works without a data folder (a VPS test rig)', async () => {
    const backend = memoryBackend();
    const svc = SettingsService.open({ backend, env: { CHAT_LOG_RETENTION_DAYS: '14' }, lan: false, log: () => {} });
    expect(svc.created).toBe(true);
    expect(backend.stored?.chat.retention.days).toBe(14);
    okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 20 } } }, HOST));
    expect(backend.stored?.rooms.maxRooms).toBe(20);
    const again = SettingsService.open({ backend, env: {}, lan: false, log: () => {} });
    expect(again.get().rooms.maxRooms).toBe(20);
  });

  it('restore replaces the whole config (validated field by field), audited; the rev only moves forward', async () => {
    const dir = tempDir();
    const secrets = memorySecrets();
    const { svc, audit } = open(dir, { secrets });
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 136', chat: { tags: { BULLYING: { notify: 'banner' } } } } }, HOST));
    const backup = JSON.parse(JSON.stringify(svc.get())) as Record<string, unknown>;
    const installId = svc.get().installId;
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 137', rooms: { maxRooms: 8 }, chat: { tags: { BULLYING: null, CHEATING: { notify: 'banner' } } } } }, HOST));
    const revBefore = svc.rev;
    audit.length = 0;
    // an older backup, hand-damaged in one leaf, from another install, with Required email and a stale mail test
    const raw = {
      ...backup, rev: 2, installId: 'ab'.repeat(16),
      rooms: { ...(backup.rooms as object), maxPlayingRooms: 99 },
      accounts: { ...(backup.accounts as object), email: 'required' },
      mail: { ...(backup.mail as object), host: 'smtp-relay.gmail.com', passwordSet: true, lastTest: { at: 1, fingerprint: '0123456789abcdef' } },
    };
    const r = okOf(await svc.restore(raw, HOST));
    const s = svc.get();
    expect(s.serverName).toBe('Room 136');
    expect(s.rooms.maxRooms).toBe(12);
    expect(s.rooms.maxPlayingRooms).toBe(6); // the bad leaf took its default
    expect(r.warnings.some((w) => w.startsWith('rooms.maxPlayingRooms'))).toBe(true);
    expect(s.chat.tags.BULLYING).toBeDefined();
    expect(s.chat.tags.CHEATING).toBeUndefined(); // replaced, not merged
    expect(s.accounts.email).toBe('required'); // accepted when it was set
    expect(s.mail.passwordSet).toBe(false); // secrets come only from a recovery file
    expect(s.mail.lastTest).toBeNull();
    expect(s.installId).toBe(installId);
    expect(s.rev).toBe(revBefore + 1);
    expect(stored(dir).rev).toBe(revBefore + 1);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.context === 'restore')).toBe(true);
    // moving PCs: the other install's id comes along
    okOf(await svc.restore({ ...raw, serverName: 'Room 138' }, HOST, { keepInstallId: false }));
    expect(svc.get().installId).toBe('ab'.repeat(16));
    expect(failOf(await svc.restore('nope', HOST)).status).toBe(400);
  });

  it('api replies: get, update ok, 409 { error, rev }, 409 needsMailTest, 400 with the field', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    const [gs, gb] = settingsGetReply(svc);
    expect(gs).toBe(200);
    expect(gb).toMatchObject({ ok: true, rev: 1, mailReady: false, presets: ['home', 'school'] });
    expect((gb.settings as HostSettings).rooms.maxRooms).toBe(12);
    const [us, ub] = await settingsUpdateReply(svc, { rev: 1, patch: { rooms: { maxRooms: 9 } } }, HOST);
    expect([us, ub.ok, ub.rev, ub.changed]).toEqual([200, true, 2, ['rooms.maxRooms']]);
    expect(await settingsUpdateReply(svc, { rev: 1, patch: { rooms: { maxRooms: 8 } } }, HOST))
      .toEqual([409, { error: expect.any(String), rev: 2 }]);
    expect(await settingsUpdateReply(svc, { rev: 2, patch: { accounts: { email: 'required' } } }, HOST))
      .toEqual([409, { error: expect.any(String), field: 'accounts.email', needsMailTest: true }]);
    expect(await settingsUpdateReply(svc, { rev: 2, patch: { rooms: { maxRooms: 99 } } }, HOST))
      .toEqual([400, { error: expect.any(String), field: 'rooms.maxRooms' }]);
    expect(await networkApproveReply(svc, { networkId: '192.168.1.0/24', serve: true }, HOST)).toEqual([200, { ok: true }]);
    expect((await networkApproveReply(svc, { serve: true }, HOST))[0]).toBe(400);
  });

  it('moderationConfigOf maps the settings onto ModerationService.config', () => {
    const s = defaultSettings();
    expect(moderationConfigOf(s)).toEqual({ strikeLimit: 3, strikeWindowMs: 600_000, autoMuteSec: 600, retentionDays: 90, keepDays: 365, chatFilter: 'strict' });
  });
});

// ------------------------------------------------------------------------------------------
// Fixer round 1: regressions for the verifier's findings
// ------------------------------------------------------------------------------------------

describe('host custom terms never block unrelated changes', () => {
  // A neutral word from a default positive line, as a host's (unconfirmed, flag-only) custom term: §5.12 imports land
  // like this. Never a real list: the term is taken from the curated PG lines at run time.
  const line = DEFAULT_POSITIVE_LINES.find((l) => /hustle/i.test(l))!;
  const flagOnly = [{ term: 'hustle', category: 'local', action: 'flag' }];

  it('a custom term that catches a stored positive line: other settings still save (with a warning)', async () => {
    const dir = tempDir();
    const { svc } = open(dir, { secrets: memorySecrets() });
    expect(setCustomTerms(flagOnly).ok).toBe(true);
    expect(svc.failingPositiveLines()).toEqual([line]);
    const r = okOf(await svc.update({ rev: svc.rev, patch: { rooms: { maxRooms: 9 } } }, HOST));
    expect(r.warnings.some((w) => w.startsWith('1 positive line(s) are caught by the chat filter now'))).toBe(true);
    // the §4.7 escape hatch (Required → Optional) always works
    okOf(await svc.update({ rev: svc.rev, patch: { mail: { host: 'smtp-relay.gmail.com' } } }, HOST));
    okOf(await svc.recordMailTest(HOST, { fingerprint: svc.mailFingerprint() }));
    okOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST));
    okOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'optional' } } }, HOST));
    // a block term behaves the same
    expect(setCustomTerms([{ term: 'hustle', category: 'local', action: 'block' }]).ok).toBe(true);
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { retention: { days: 60 } } } }, HOST));
    // applyPreset (the whole tree goes through the merge) too
    okOf(await svc.applyPreset('school', HOST));
    // editing the list itself: the caught line is refused, named in `rejected`
    const edit = failOf(await svc.update({ rev: svc.rev, patch: { chat: { positiveLines: [...svc.get().chat.positiveLines, 'Brand new line!'] } } }, HOST));
    expect(edit).toMatchObject({ status: 400, field: 'chat.positiveLines', rejected: [{ line, why: "doesn't pass the chat filter" }] });
    // ... and so is a strictness change (it re-checks every line)
    expect(failOf(await svc.update({ rev: svc.rev, patch: { chat: { strictness: 'standard' } } }, HOST)).field).toBe('chat.positiveLines');
    okOf(await svc.update({ rev: svc.rev, patch: { chat: { positiveLines: svc.get().chat.positiveLines.filter((l) => l !== line) } } }, HOST));
    expect(svc.failingPositiveLines()).toEqual([]);
  });

  it('loading ignores the custom terms: a restart or a reload never deletes the host\'s lines or name', async () => {
    const dir = tempDir();
    const first = open(dir);
    okOf(await first.svc.update({ rev: first.svc.rev, patch: { serverName: 'Hustle Room', chat: { notice: 'Good hustle today.' } } }, HOST));
    expect(setCustomTerms([{ term: 'hustle', category: 'local', action: 'block' }]).ok).toBe(true);
    const again = open(dir);
    expect(again.svc.get().chat.positiveLines).toContain(line);
    expect(again.svc.get().serverName).toBe('Hustle Room');
    expect(again.svc.get().chat.notice).toBe('Good hustle today.');
    expect(again.logs.some((l) => l.includes('positive'))).toBe(false);
    // another process saves: the reload keeps them too
    okOf(await first.svc.update({ rev: first.svc.rev, patch: { rooms: { maxRooms: 8 } } }, HOST));
    expect(again.svc.reload()).toBe(true);
    expect(again.svc.get()).toMatchObject({ serverName: 'Hustle Room', rooms: { maxRooms: 8 } });
    // but a NEW name or notice must pass with them
    expect(failOf(await again.svc.update({ rev: again.svc.rev, patch: { serverName: 'Hustle Room 2' } }, HOST)).field).toBe('serverName');
    expect(failOf(await again.svc.update({ rev: again.svc.rev, patch: { chat: { notice: 'More hustle.' } } }, HOST)).field).toBe('chat.notice');
    // the built-in lists still repair at load
    const blocked = termOf('block');
    const w: string[] = [];
    const s = settingsFromRaw({ ...defaultSettings(), serverName: `${blocked} room`, chat: { notice: `Hi ${blocked}` } }, { lan: true }, w);
    expect([s.serverName, s.chat.notice]).toEqual(['Voidswarm', '']);
    expect(w.join(' ')).not.toContain(blocked);
  });
});

describe('backups.copyTo', () => {
  it('only a full folder path: a drive, a share or an absolute POSIX path; never relative, .. or a device path', async () => {
    const { svc } = open(tempDir());
    for (const good of ['E:\\Voidswarm backups', 'D:/vs', '\\\\district-fs\\share\\voidswarm', '/media/usb/voidswarm', '']) {
      const r = await svc.update({ rev: svc.rev, patch: { backups: { copyTo: good } } }, HOST);
      expect([good, r.ok]).toEqual([good, true]);
    }
    for (const bad of ['..\\..\\Windows', 'relative\\dir', 'backups', 'E:', 'E:relative', 'E:\\a\\..\\b', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0',
      '\\\\server', '\\\\server\\', 'E:\\x:stream', 'E:\\a*b', '/media/../etc']) {
      const r = await svc.update({ rev: svc.rev, patch: { backups: { copyTo: bad } } }, HOST);
      expect([bad, r.ok, r.ok ? null : r.field]).toEqual([bad, false, 'backups.copyTo']);
    }
  });
});

describe('several processes writing one config', () => {
  it('two writers at the same moment: one saves, the other gets 409 — never a lost change', async () => {
    const dir = tempDir();
    const a = open(dir);
    const b = open(dir);
    const [ra, rb] = await Promise.all([
      a.svc.update({ rev: 1, patch: { serverName: 'From A' } }, HOST),
      b.svc.update({ rev: 1, patch: { rooms: { maxRooms: 9 } } }, HOST),
    ]);
    const oks = [ra, rb].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    const loser = [ra, rb].find((r) => !r.ok) as SettingsFail;
    expect(loser).toMatchObject({ status: 409, rev: 2 });
    const disk = stored(dir);
    expect(disk.rev).toBe(2);
    // whoever won, both copies now agree with the disk
    a.svc.reload();
    b.svc.reload();
    expect(a.svc.get().serverName).toBe(disk.serverName);
    expect(b.svc.get().rooms.maxRooms).toBe(disk.rooms.maxRooms);
    expect(existsSync(join(dir, CONFIG_FILE + CONFIG_LOCK_SUFFIX))).toBe(false);
  });

  it('server-side changes from two processes are both kept (the later one is merged onto the newer copy)', async () => {
    const dir = tempDir();
    const a = open(dir);
    const b = open(dir);
    const [ra, rb] = await Promise.all([
      a.svc.apply({ network: { port: 7790, adminPort: 7791 } }, { accountId: 'launcher', name: 'launcher' }),
      b.svc.approveNetwork('10.20.0.0/16', true, HOST),
    ]);
    expect([ra.ok, rb.ok]).toEqual([true, true]);
    expect(stored(dir)).toMatchObject({ rev: 3, network: { port: 7790, adminPort: 7791, approvedNetworks: [{ id: '10.20.0.0/16', serve: true }] } });
  });

  it('the stored rev is checked under the lock (a save in between is a conflict, not an overwrite)', async () => {
    const dir = tempDir();
    const file = join(dir, CONFIG_FILE);
    const { svc } = open(dir);
    const backend = fileBackend(file);
    const copy = svc.get();
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 136' } }, HOST)); // rev 2 on disk
    await expect(backend.save({ ...copy, rev: 2 }, 1)).rejects.toBeInstanceOf(SettingsConflictError);
    expect(stored(dir).serverName).toBe('Room 136');
    const mem = memoryBackend();
    await mem.save({ ...copy, rev: 5 }, 4);
    await expect(mem.save({ ...copy, rev: 5 }, 4)).rejects.toBeInstanceOf(SettingsConflictError);
  });

  it('a lock left by a killed process is broken after a while; a live one makes the writer wait', async () => {
    const dir = tempDir();
    const { svc } = open(dir);
    const lock = join(dir, CONFIG_FILE + CONFIG_LOCK_SUFFIX);
    writeFileSync(lock, '4242 0\n');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 136' } }, HOST));
    expect(existsSync(lock)).toBe(false);
    // a fresh lock (another writer mid-save) released shortly after: this write waits for it
    writeFileSync(lock, '4343 0\n');
    setTimeout(() => { rmSync(lock, { force: true }); }, 60);
    okOf(await svc.update({ rev: svc.rev, patch: { serverName: 'Room 137' } }, HOST));
    expect(stored(dir).serverName).toBe('Room 137');
  });
});

describe('restore from elsewhere (§6.5: untrusted)', () => {
  it('Required email without a mail server falls back to optional; a mail test from elsewhere never counts', async () => {
    const { svc } = open(tempDir(), { secrets: memorySecrets() });
    const base = JSON.parse(JSON.stringify(svc.get())) as HostSettings;
    const noMail = { ...base, installId: 'cd'.repeat(16), accounts: { ...base.accounts, email: 'required' }, mail: { ...base.mail, host: '' } };
    const r = okOf(await svc.restore(noMail, HOST));
    expect(svc.get().accounts.email).toBe('optional');
    expect(r.warnings.some((w) => w.startsWith('WARNING: the restored settings require email, but they have no mail server'))).toBe(true);
    // a lastTest whose fingerprint was computed by hand (it is not a secret), from elsewhere or with this installId: void
    const mail = { ...base.mail, host: 'smtp.example.org' };
    for (const installId of ['cd'.repeat(16), base.installId]) {
      const forged = { ...base, installId, mail: { ...mail, lastTest: { at: 1, fingerprint: mailFingerprint(mail) } } };
      okOf(await svc.restore(forged, HOST));
      expect(svc.get().mail.lastTest).toBeNull();
      expect(svc.mailReady()).toBe(false);
      expect(failOf(await svc.update({ rev: svc.rev, patch: { accounts: { email: 'required' } } }, HOST)).needsMailTest).toBe(true);
    }
    // Required already on in the restored config stays on (with a mail server); switching it on needs a new test
    const own = { ...base, accounts: { ...base.accounts, email: 'required' }, mail: { ...mail, lastTest: null } };
    okOf(await svc.restore(own, HOST));
    expect(svc.get().accounts.email).toBe('required');
    // this install's first-run record stays its own
    expect(okOf(await svc.restore({ ...base, seededFromEnv: ['ALLOW_GUESTS'] }, HOST)).settings.seededFromEnv).toEqual([]);
  });

  it('a restored config is checked against the host\'s custom terms (repaired, never refused)', async () => {
    const { svc } = open(tempDir());
    const base = JSON.parse(JSON.stringify(svc.get())) as HostSettings;
    expect(setCustomTerms([{ term: 'hustle', category: 'local', action: 'block' }]).ok).toBe(true);
    const r = okOf(await svc.restore({ ...base, serverName: 'Hustle Room', rooms: { ...base.rooms, maxRooms: 10 } }, HOST));
    expect(svc.get().serverName).toBe('Voidswarm');
    expect(svc.get().rooms.maxRooms).toBe(10);
    expect(svc.get().chat.positiveLines.some((l) => /hustle/i.test(l))).toBe(false);
    expect(r.warnings.some((w) => w.startsWith('serverName:'))).toBe(true);
  });
});
