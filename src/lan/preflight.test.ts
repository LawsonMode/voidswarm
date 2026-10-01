import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NOTE_MAX_CHARS } from './banner';
import { runPowerShell, type ExecFn } from './paths';
import {
  categoryFor, firewallBlockedConsole, firewallBlockedText, getPreflight, hostProbeScript, inboundVerdict, IT_FIREWALL_FILE, lanServingAllowed,
  parseHostProbe, parseNetshRules, parsePowercfg, preflightFilePath, preflightNotices, readFirewall, readPreflightFile, runPreflight, staleReason,
  volumeLookup, type FirewallProfile, type FirewallRule, type HostProbe, type InboundVerdict, type PreflightReport,
} from './preflight';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-preflight-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const newData = () => {
  const d = path.join(scratch, `data-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const NODE = 'C:\\Users\\NovaPilot\\Voidswarm LAN\\runtime\\node.exe';
const ENV = { USERPROFILE: 'C:\\Users\\NovaPilot', SystemRoot: 'C:\\Windows' };

const POWERCFG = (ac: string, dc: string) =>
  [
    'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
    '  GUID Alias: SCHEME_BALANCED',
    '  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)',
    '    GUID Alias: SUB_SLEEP',
    '    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)',
    '      GUID Alias: STANDBYIDLE',
    '      Minimum Possible Setting: 0x00000000',
    '      Maximum Possible Setting: 0xffffffff',
    '      Possible Settings increment: 0x00000001',
    '      Possible Settings units: Seconds',
    `    Current AC Power Setting Index: ${ac}`,
    `    Current DC Power Setting Index: ${dc}`,
    '',
  ].join('\r\n');

function probeJson(over: Partial<HostProbe> = {}): HostProbe {
  return {
    network: [{ alias: 'Ethernet', index: 12, name: 'Network 2', category: 'Private' }],
    addresses: [{ index: 12, ip: '192.168.1.50' }, { index: 1, ip: '127.0.0.1' }, { index: 30, ip: '100.101.102.103' }],
    rules: [
      // The developer's own Node install: a different program, must not count.
      { program: 'C:\\Program Files\\nodejs\\node.exe', name: 'Node.js JavaScript Runtime', enabled: 'True', direction: 'Inbound', action: 'Block', profile: 'Private' },
    ],
    profiles: [
      { name: 'Domain', enabled: 'True', inbound: 'Block', allowLocal: 'True' },
      { name: 'Private', enabled: 'True', inbound: 'Block', allowLocal: 'NotConfigured' },
      { name: 'Public', enabled: 'True', inbound: 'Block', allowLocal: 'True' },
    ],
    battery: [],
    ...over,
  };
}

function mockExec(opts: { probe?: HostProbe | null; powercfg?: string; netsh?: string; calls?: string[] } = {}): ExecFn {
  return async (file, args, o) => {
    opts.calls?.push(`${path.win32.basename(file)} ${o?.env?.VS_DRIVE ?? ''}`.trim());
    if (/powershell\.exe$/i.test(file)) {
      if (opts.probe === null) return { code: 1, stdout: '', stderr: 'blocked by policy' };
      return { code: 0, stdout: `VSJSON:${JSON.stringify(opts.probe ?? probeJson())}\r\n`, stderr: '' };
    }
    if (/powercfg\.exe$/i.test(file)) return { code: 0, stdout: opts.powercfg ?? POWERCFG('0x00000000', '0x00000000'), stderr: '' };
    if (/netsh\.exe$/i.test(file)) return { code: 0, stdout: opts.netsh ?? '', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${file} ${args.join(' ')}` };
  };
}

const statfs = (free: number) => async () => ({ bavail: free / 4096, bsize: 4096, blocks: 1e9 / 4096 });
const base = (dataDir: string, extra: Partial<Parameters<typeof runPreflight>[0]> = {}) => ({
  dataDir, version: '0.6.0', nodeExe: NODE, primary: '192.168.1.50', platform: 'win32' as const, env: ENV, statfs: statfs(50 * 1024 ** 3), ...extra,
});

describe('parsers', () => {
  it('powercfg: the last two hex values are AC and DC, whatever the language', () => {
    expect(parsePowercfg(POWERCFG('0x00000384', '0x00000708'))).toEqual({ acSleepSec: 900, dcSleepSec: 1800 });
    const german = 'Energieschema-GUID: 381b…\r\n      Mindestwert: 0x00000000\r\n      Höchstwert: 0xffffffff\r\n    Index der aktuellen Wechselstromeinstellung: 0x00000000\r\n    Index der aktuellen Gleichstromeinstellung: 0x0000012c\r\n';
    expect(parsePowercfg(german)).toEqual({ acSleepSec: 0, dcSleepSec: 300 });
    expect(parsePowercfg('Access denied')).toEqual({ acSleepSec: null, dcSleepSec: null });
  });

  it('the PowerShell script is fixed, has no double quotes, and its output parses', () => {
    for (const s of [['network'], ['firewall'], ['battery'], ['volume'], ['network', 'firewall', 'battery', 'volume']] as const) {
      const script = hostProbeScript(s);
      expect(script).not.toContain('"');
      expect(script).toContain("'VSJSON:'");
    }
    expect(hostProbeScript(['firewall'])).toContain('$env:VS_PROGRAM_LEAF');
    expect(parseHostProbe('WARNING: x\r\nVSJSON:{"battery":[2]}\r\n')).toEqual({ battery: [2] });
    expect(parseHostProbe('no json here')).toBeNull();
  });

  it('netsh fallback: only this node.exe, %VAR% paths expanded', () => {
    const text = [
      'Rule Name:                            Node.js JavaScript Runtime',
      '----------------------------------------------------------------------',
      'Enabled:                              Yes',
      'Direction:                            In',
      'Profiles:                             Private,Public',
      'Program:                              %USERPROFILE%\\Voidswarm LAN\\runtime\\node.exe',
      'Action:                               Block',
      '',
      'Rule Name:                            Node.js JavaScript Runtime',
      '----------------------------------------------------------------------',
      'Enabled:                              Yes',
      'Direction:                            In',
      'Profiles:                             Private',
      'Program:                              C:\\program files\\nodejs\\node.exe',
      'Action:                               Allow',
      '',
      'Ok.',
    ].join('\r\n');
    expect(parseNetshRules(text, NODE, ENV)).toEqual([
      { program: '%USERPROFILE%\\Voidswarm LAN\\runtime\\node.exe', name: 'Node.js JavaScript Runtime', enabled: true, direction: 'Inbound', action: 'Block', profiles: 'Private, Public' },
    ]);
    expect(parseNetshRules('Regelname: x\r\n', NODE, ENV)).toBeNull(); // not English: unknown, not "no rules"
  });
});

describe('running the checks', () => {
  it('collects network, firewall, power and disk (mocked Windows)', async () => {
    const r = await runPreflight(base(newData(), { exec: mockExec() }));
    expect(r.network?.profiles).toEqual([{ alias: 'Ethernet', index: 12, name: 'Network 2', category: 'Private', ipv4: ['192.168.1.50'] }]);
    expect(categoryFor(r, '192.168.1.50')).toBe('Private');
    expect(r.firewall?.source).toBe('powershell');
    expect(r.firewall?.rules).toEqual([]); // the other node.exe's Block rule is not ours
    expect(r.power).toMatchObject({ acSleepSec: 0, dcSleepSec: 0, hasBattery: false, onBattery: false });
    expect(r.disk?.freeBytes).toBe(50 * 1024 ** 3);
    expect(lanServingAllowed(r, '192.168.1.50')).toEqual({ allowed: true, category: 'Private' });
    // Private's firewall is on, inbound Block by default, and no rule lets runtime\node.exe in.
    expect(preflightNotices(r).map((x) => x.code)).toEqual(['firewall-blocked']);
  });

  it('Public network → loopback only, with the Private hint', async () => {
    const r = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ network: [{ alias: 'Wi-Fi', index: 12, name: 'Cafe', category: 'Public' }] }) }) }));
    expect(lanServingAllowed(r, '192.168.1.50')).toEqual({ allowed: false, category: 'Public' });
    const notes = preflightNotices(r);
    expect(notes[0]).toMatchObject({ code: 'network-public', level: 'warn' });
    expect(notes[0].text).toMatch(/set this network to Private|Set it to Private/);
  });

  it('Public is not missed when the addresses can\'t be matched (fail closed)', async () => {
    const two = [
      { alias: 'Wi-Fi', index: 12, name: 'Cafe', category: 'Public' },
      { alias: 'vEthernet (WSL)', index: 40, name: 'Unidentified network', category: 'Private' },
    ];
    // Get-NetIPAddress failed, Get-NetConnectionProfile worked: any Public profile counts.
    const noAddr = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ network: two, addresses: undefined, addressesError: 'Access denied' }) }) }));
    expect(noAddr.network?.addressesError).toBe('Access denied');
    expect(lanServingAllowed(noAddr, '192.168.1.50')).toEqual({ allowed: false, category: 'Public' });
    expect(preflightNotices(noAddr).map((x) => x.code)).toContain('network-public');
    // One profile only: it is the network the primary address is on.
    const one = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ network: [two[0]], addresses: [{ index: 99, ip: '10.9.9.9' }] }) }) }));
    expect(lanServingAllowed(one, '192.168.1.50')).toEqual({ allowed: false, category: 'Public' });
    // Addresses known, the primary on none of them, several profiles: unknown (the firewall decides).
    const other = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ network: two, addresses: [{ index: 12, ip: '172.16.0.4' }, { index: 40, ip: '172.30.0.1' }] }) }) }));
    expect(lanServingAllowed(other, '192.168.1.50')).toEqual({ allowed: true, category: null });
  });

  it('a Block rule for our node.exe (a Cancel on the prompt) is named; policy that ignores local rules → IT', async () => {
    const ours = { program: '%USERPROFILE%\\Voidswarm LAN\\runtime\\node.exe', name: 'Node.js JavaScript Runtime', enabled: 'True', direction: 'Inbound', action: 'Block', profile: 'Private, Public' };
    const blocked = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ rules: [ours] }) }) }));
    expect(blocked.firewall?.rules).toHaveLength(1);
    expect(preflightNotices(blocked).map((x) => x.code)).toEqual(['firewall-blocked']);
    expect(preflightNotices(blocked)[0].text).toMatch(/Block rule for Voidswarm/);
    expect(preflightNotices(blocked)[0].text).toContain(`"${IT_FIREWALL_FILE}"`);
    expect(preflightNotices(blocked)[0].text).not.toMatch(/Allow through firewall \(admin\)\.cmd/); // that file doesn't ship

    const gpo = probeJson({ profiles: [{ name: 'Private', enabled: 'True', inbound: 'Block', allowLocal: 'False' }] });
    const policy = await runPreflight(base(newData(), { exec: mockExec({ probe: gpo }) }));
    expect(preflightNotices(policy).map((x) => x.code)).toEqual(['firewall-blocked']);
    expect(preflightNotices(policy)[0].text).toMatch(/ignores local rules.*FOR SCHOOL IT\.txt/);
    expect(preflightNotices(policy)[0].text).not.toContain(IT_FIREWALL_FILE); // a local rule can't help under that policy
  });

  it('falls back to netsh when the firewall cmdlets fail', async () => {
    const netsh = 'Rule Name: Node.js JavaScript Runtime\r\nEnabled: Yes\r\nDirection: In\r\nProfiles: Private\r\nProgram: C:\\Users\\NovaPilot\\Voidswarm LAN\\runtime\\node.exe\r\nAction: Allow\r\n\r\nOk.\r\n';
    const r = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ rules: undefined, rulesError: 'Access is denied' }), netsh }) }));
    expect(r.firewall?.source).toBe('netsh');
    expect(r.firewall?.rules.map((x) => x.action)).toEqual(['Allow']);
    expect(preflightNotices(r)).toEqual([]);
  });

  it('PowerShell blocked entirely: the report says so and nothing is invented', async () => {
    const r = await runPreflight(base(newData(), { exec: mockExec({ probe: null }) }));
    expect(r.network?.error).toBeTruthy();
    expect(r.network?.profiles).toEqual([]);
    expect(lanServingAllowed(r, '192.168.1.50')).toEqual({ allowed: true, category: null });
    expect(r.power?.hasBattery).toBeNull();
    expect(r.firewall).toMatchObject({ source: 'netsh', rulesRead: false });
    expect(preflightNotices(r).map((x) => x.code)).toEqual(['check-failed']);
  });

  it('sleep and battery warnings use the spec\'s words', async () => {
    const exec = mockExec({ powercfg: POWERCFG('0x00000e10', '0x00000384'), probe: probeJson({ battery: [1] }) });
    const r = await runPreflight(base(newData(), { exec }));
    const texts = Object.fromEntries(preflightNotices(r).map((x) => [x.code, x.text]));
    expect(texts['sleep-battery']).toBe("This PC sleeps after 15 minutes on battery. Plug it in and set Sleep to Never while hosting; don't close the lid.");
    expect(texts['sleep-ac']).toBe('This PC sleeps after 60 minutes when plugged in. Set Sleep to Never while hosting.');
    expect(texts['on-battery']).toMatch(/battery/);
  });

  it('low disk: below 2 GB backups are skipped; below 500 MB chat may stop being logged', async () => {
    const low = await runPreflight(base(newData(), { exec: mockExec(), statfs: statfs(1024 ** 3) }));
    expect(preflightNotices(low).find((x) => x.code === 'disk-low')?.text).toMatch(/1\.0 GB free.*2 GB/);
    const crit = await runPreflight(base(newData(), { exec: mockExec(), statfs: statfs(100 * 1024 ** 2) }));
    expect(preflightNotices(crit).find((x) => x.code === 'disk-critical')).toMatchObject({ level: 'error' });
  });

  it('the Domain profile with no rule: likely blocked, IT runs the IT file; the profiles unread: only the prompt hint', async () => {
    const domain = [{ alias: 'Ethernet', index: 12, name: 'caldwellschools.org', category: 'DomainAuthenticated' }];
    const r = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ network: domain }) }) }));
    const n = preflightNotices(r, { preset: 'school' }).find((x) => x.code === 'firewall-blocked');
    expect(n).toMatchObject({ level: 'warn' });
    expect(n?.text).toMatch(/no rule allowing Voidswarm on this network \(the Domain profile\)/);
    // The profiles couldn't be read (is the firewall even on?): no claim, only the old hint.
    const unread = await runPreflight(base(newData(), { exec: mockExec({ probe: probeJson({ network: domain, profiles: undefined, profilesError: 'denied' }) }) }));
    expect(preflightNotices(unread, { preset: 'school' }).map((x) => x.code)).toEqual(['firewall-prompt']);
    expect(preflightNotices(unread, { preset: 'school' })[0].text).toMatch(/IT must add it \("Allow Voidswarm \(for IT\)\.cmd", or FOR SCHOOL IT\.txt\)/);
    expect(preflightNotices(unread, { preset: 'home' })[0].text).toMatch(/Node\.js JavaScript Runtime/);
  });

  it('--this-pc-only: nothing about the firewall (it doesn\'t matter on loopback)', async () => {
    const r = await runPreflight(base(newData(), { exec: mockExec() }));
    expect(preflightNotices(r).map((x) => x.code)).toEqual(['firewall-blocked']);
    expect(preflightNotices(r, { thisPcOnly: true })).toEqual([]);
  });

  it('readFirewall: the firewall section alone (one PowerShell call, VS_PROGRAM_LEAF only); null when it fails; never off Windows', async () => {
    const calls: string[] = [];
    const ours = { program: NODE, name: 'Voidswarm LAN (C:\\Users\\NovaPilot\\Voidswarm LAN)', enabled: 'True', direction: 'Inbound', action: 'Allow', profile: 'Domain, Private' };
    const fw = await readFirewall({ nodeExe: NODE, platform: 'win32', env: ENV, exec: mockExec({ probe: probeJson({ rules: [ours] }), calls }) });
    expect(calls).toEqual(['powershell.exe']);
    expect(fw).toMatchObject({ source: 'powershell', rulesRead: true, rules: [{ action: 'Allow', profiles: 'Domain, Private' }] });
    expect(inboundVerdict(fw, 'Private').inboundLikelyBlocked).toBe(false);
    expect(await readFirewall({ nodeExe: NODE, platform: 'win32', env: ENV, exec: mockExec({ probe: null }) })).toBeNull();
    expect(await readFirewall({ nodeExe: NODE, platform: 'win32', env: ENV, exec: mockExec({ probe: probeJson({ rules: undefined, rulesError: 'Access is denied' }) }) })).toBeNull();
    expect(await readFirewall({ nodeExe: NODE, platform: 'linux', env: ENV, exec: mockExec() })).toBeNull();
  });
});

describe('inboundVerdict: is inbound likely blocked? (pure; no claim without evidence)', () => {
  const rule = (o: Partial<FirewallRule> = {}): FirewallRule => ({ program: NODE, name: 'r', enabled: true, direction: 'Inbound', action: 'Allow', profiles: 'Private', ...o });
  const prof = (name: string, o: Partial<FirewallProfile> = {}): FirewallProfile => ({ name, enabled: true, defaultInbound: 'Block', allowLocalRules: true, ...o });
  const fw = (rules: FirewallRule[], profiles: FirewallProfile[] = [prof('Domain'), prof('Private'), prof('Public')], rulesRead = true): PreflightReport['firewall'] =>
    ({ source: 'powershell', rulesRead, rules, profiles });
  const v = (f: PreflightReport['firewall'], c: string | null) => { const r = inboundVerdict(f, c); return r.inboundLikelyBlocked ? r.reason : null; };

  it('no rule, the profile on with inbound Block (or NotConfigured, which is Block): no-allow-rule', () => {
    expect(inboundVerdict(fw([]), 'Private')).toEqual({ inboundLikelyBlocked: true, reason: 'no-allow-rule', profile: 'Private', noRules: true });
    expect(v(fw([], [prof('Domain', { defaultInbound: 'NotConfigured' })]), 'DomainAuthenticated')).toBe('no-allow-rule');
    // An Allow rule for another profile only doesn't help this one.
    expect(inboundVerdict(fw([rule({ profiles: 'Public' })]), 'Private')).toMatchObject({ reason: 'no-allow-rule', noRules: false });
    // A disabled or outbound Allow doesn't count.
    expect(v(fw([rule({ enabled: false }), rule({ direction: 'Outbound' })]), 'Private')).toBe('no-allow-rule');
  });

  it('an enabled inbound Allow rule covering the profile (Any, a list, the profile itself): not blocked', () => {
    for (const profiles of ['Private', 'Domain, Private', 'Any', '']) expect(v(fw([rule({ profiles })]), 'Private'), profiles).toBeNull();
    expect(v(fw([rule({ profiles: 'Domain, Private' })]), 'DomainAuthenticated')).toBeNull();
  });

  it('an enabled inbound Block rule covering the profile wins over any Allow rule: block-rule', () => {
    expect(v(fw([rule(), rule({ action: 'Block', profiles: 'Private, Public' })]), 'Private')).toBe('block-rule');
    expect(v(fw([rule({ action: 'Block', profiles: 'Any' })]), 'DomainAuthenticated')).toBe('block-rule');
    // A Block rule for Public only, or a disabled one, doesn't block Private.
    expect(v(fw([rule(), rule({ action: 'Block', profiles: 'Public' })]), 'Private')).toBeNull();
    expect(v(fw([rule(), rule({ action: 'Block', enabled: false })]), 'Private')).toBeNull();
    // The profile's state unread: a Block rule is still evidence (the firewall is on by default).
    expect(v(fw([rule({ action: 'Block' })], []), 'Private')).toBe('block-rule');
  });

  it('a policy that ignores local rules (AllowLocalFirewallRules False), with no Allow rule in the active policy: policy-ignores-local', () => {
    expect(v(fw([], [prof('Domain', { allowLocalRules: false })]), 'DomainAuthenticated')).toBe('policy-ignores-local');
    // Even with the default inbound action Allow: local rules can't help, and nothing says the policy allows us.
    expect(v(fw([], [prof('Domain', { allowLocalRules: false, defaultInbound: 'Allow' })]), 'DomainAuthenticated')).toBe('policy-ignores-local');
    // IT pushed an Allow rule by policy (it shows in the active store): believed.
    expect(v(fw([rule({ profiles: 'Domain' })], [prof('Domain', { allowLocalRules: false })]), 'DomainAuthenticated')).toBeNull();
  });

  it('no claim when unknown or unreadable: no report, rules unread, an unknown or Public category, the firewall off, inbound Allow, the profile unread', () => {
    expect(v(null, 'Private')).toBeNull();
    expect(v(fw([], undefined, false), 'Private')).toBeNull();
    expect(v(fw([rule({ action: 'Block' })], undefined, false), 'Private')).toBeNull();
    expect(v(fw([]), null)).toBeNull();
    expect(v(fw([]), 'SomethingNew')).toBeNull();
    expect(v(fw([]), 'Public')).toBeNull(); // the network-public notice covers it (the game stays on this PC)
    expect(v(fw([rule({ action: 'Block' })], [prof('Private', { enabled: false })]), 'Private')).toBeNull();
    expect(v(fw([], [prof('Private', { defaultInbound: 'Allow' })]), 'Private')).toBeNull();
    expect(v(fw([], [prof('Private', { defaultInbound: '' })]), 'Private')).toBeNull();
    expect(v(fw([], []), 'Private')).toBeNull();
    expect(v(fw([], [prof('Domain')]), 'Private')).toBeNull(); // Private's own state wasn't read
  });

  it('the banner and console words: plain, with the IT file or this PC only, never over 500 characters', () => {
    const verdicts: InboundVerdict[] = [];
    for (const reason of ['no-allow-rule', 'block-rule', 'policy-ignores-local'] as const) {
      for (const profile of ['Domain', 'Private', null]) for (const noRules of [true, false]) verdicts.push({ inboundLikelyBlocked: true, reason, profile, noRules });
    }
    for (const x of verdicts) {
      const t = firewallBlockedText(x);
      expect(t.length, t).toBeLessThanOrEqual(500);
      expect(t).toMatch(/^Other devices probably can't connect/);
      expect(t).toMatch(/keep using Voidswarm on this PC only: the host PC can always play and use this panel\.$|choose Allow\.\)$/);
      expect(t).toContain('FOR SCHOOL IT.txt');
      expect(/^[\x20-\x7e]*$/.test(t)).toBe(true);
      const c = firewallBlockedConsole(x);
      expect(c).not.toContain('\n');
      expect(c.length, c).toBeLessThanOrEqual(NOTE_MAX_CHARS); // a console note is cut there
      expect(c).toMatch(/^Firewall: .* or play on this PC\.$/);
      expect(c).toMatch(x.reason === 'policy-ignores-local' ? /FOR SCHOOL IT\.txt/ : /"Allow Voidswarm \(for IT\)\.cmd"/);
    }
    const plain = firewallBlockedText({ inboundLikelyBlocked: true, reason: 'no-allow-rule', profile: 'Domain', noRules: false });
    expect(plain).toBe('Other devices probably can\'t connect: Windows Firewall has no rule allowing Voidswarm on this network (the Domain profile). '
      + 'Adding one needs an administrator, so either ask IT to run "Allow Voidswarm (for IT).cmd" once (it is in the Voidswarm LAN folder; '
      + 'see FOR SCHOOL IT.txt), or keep using Voidswarm on this PC only: the host PC can always play and use this panel.');
    expect(firewallBlockedConsole({ inboundLikelyBlocked: true, reason: 'no-allow-rule', profile: 'Domain', noRules: false }))
      .toBe('Firewall: no rule lets other devices in. Ask IT to run "Allow Voidswarm (for IT).cmd", or play on this PC.');
  });
});

describe('the cache (preflight.json)', () => {
  it('refreshes at first run, after an update, on a network change, and once a day; disk is always fresh', async () => {
    const data = newData();
    const calls: string[] = [];
    let now = 1_800_000_000_000;
    let free = 50 * 1024 ** 3;
    const o = () => base(data, { exec: mockExec({ calls }), now: () => now, statfs: async () => ({ bavail: free / 4096, bsize: 4096, blocks: 1e6 }) });

    const first = await getPreflight(o());
    expect(first).toMatchObject({ ran: true, reason: 'first-run' });
    expect(readPreflightFile(preflightFilePath(data)).report?.at).toBe(now);
    const psRuns = () => calls.filter((c) => c.startsWith('powershell')).length;
    expect(psRuns()).toBe(1);

    now += 60_000;
    free = 3 * 1024 ** 3;
    const cached = await getPreflight(o());
    expect(cached.ran).toBe(false);
    expect(cached.report.disk?.freeBytes).toBe(3 * 1024 ** 3);
    expect(psRuns()).toBe(1);

    expect((await getPreflight({ ...o(), version: '0.6.1' })).reason).toBe('update');
    expect((await getPreflight({ ...o(), version: '0.6.1', primary: '10.20.0.15' })).reason).toBe('network-change');
    expect((await getPreflight({ ...o(), version: '0.6.1', primary: '10.20.0.15', force: 'no-device' })).reason).toBe('no-device');
    now += 25 * 3600_000;
    expect((await getPreflight({ ...o(), version: '0.6.1', primary: '10.20.0.15' })).reason).toBe('expired');
    expect(psRuns()).toBe(5);
  });

  it('staleReason on its own', () => {
    const r = { v: 1, at: 1000, version: '0.6.0', nodeExe: NODE, primary: '192.168.1.50' } as PreflightReport;
    expect(staleReason(null, { version: '0.6.0', nodeExe: NODE, now: 1000 })).toBe('first-run');
    expect(staleReason(r, { version: '0.6.0', nodeExe: NODE.toUpperCase(), primary: '192.168.1.50', now: 2000 })).toBeNull();
    expect(staleReason(r, { version: '0.6.0', nodeExe: 'C:\\other\\node.exe', now: 2000 })).toBe('update');
    expect(staleReason(r, { version: '0.6.0', nodeExe: NODE, primary: null, now: 2000 })).toBe('network-change');
    expect(staleReason(r, { version: '0.6.0', nodeExe: NODE, now: 2000 })).toBeNull(); // primary not given: not compared
  });

  it('caches Get-Volume for the location check', async () => {
    const data = newData();
    const calls: string[] = [];
    const exec = mockExec({ calls, probe: { volume: { fileSystem: 'NTFS', driveType: 'Fixed' } } });
    const look = volumeLookup({ dataDir: data, root: 'C:\\Users\\NovaPilot\\Voidswarm LAN', version: '0.6.0', exec, env: ENV });
    expect(await look('C')).toEqual({ fileSystem: 'NTFS', driveType: 'Fixed' });
    expect(await look('C')).toEqual({ fileSystem: 'NTFS', driveType: 'Fixed' });
    expect(calls).toEqual(['powershell.exe C']);
    const after = volumeLookup({ dataDir: data, root: 'C:\\Users\\NovaPilot\\Voidswarm LAN', version: '0.6.1', exec, env: ENV });
    await after('C');
    expect(calls).toHaveLength(2);
    // A later preflight run keeps the volume entries.
    await getPreflight(base(data, { exec: mockExec() }));
    expect(Object.keys(readPreflightFile(preflightFilePath(data)).volumes)).toHaveLength(1);
  });

  it('a broken preflight.json is treated as no cache', () => {
    const data = newData();
    fs.writeFileSync(path.join(data, 'preflight.json'), '{not json');
    expect(readPreflightFile(path.join(data, 'preflight.json'))).toEqual({ v: 1, report: null, volumes: {} });
  });
});

describe.skipIf(process.platform !== 'win32')('live Windows preflight (read-only)', () => {
  it('runs the real PowerShell, powercfg and statfs checks', async () => {
    const r = await runPreflight({ dataDir: newData(), version: 'test', nodeExe: process.execPath, primary: null });
    expect(Array.isArray(r.network?.profiles)).toBe(true);
    expect(r.firewall).not.toBeNull();
    expect(r.power === null || r.power.acSleepSec === null || typeof r.power.acSleepSec === 'number').toBe(true);
    expect(r.disk?.freeBytes).toBeGreaterThan(0);
    expect(Array.isArray(preflightNotices(r))).toBe(true);
  }, 60_000);

  it('runs without an execution-policy override, and its language constructs work in Constrained Language Mode', async () => {
    const drive = (process.env.SystemDrive ?? 'C:').slice(0, 1);
    const full = parseHostProbe((await runPowerShell(hostProbeScript(['network', 'battery', 'volume']), { VS_DRIVE: drive }, { timeoutMs: 60_000 })).stdout);
    expect(full?.networkError).toBeUndefined();
    expect(full?.volumeError).toBeUndefined();
    expect(Array.isArray(full?.network)).toBe(true);
    // Switching a session to CLM by hand can't load the CDXML network/storage modules (a policy-
    // enforced CLM trusts them as system modules), so only the script's own constructs are tested:
    // the JSON output, VsEsc, [ordered], [pscustomobject] and the CIM battery read.
    const clm = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n" + hostProbeScript(['battery']);
    const probe = parseHostProbe((await runPowerShell(clm, {}, { timeoutMs: 60_000 })).stdout);
    expect(probe).not.toBeNull();
    expect(probe?.batteryError).toBeUndefined();
    expect(Array.isArray(probe?.battery)).toBe(true);
  }, 60_000);

  it('reads the real volume of the system drive', async () => {
    const look = volumeLookup({ dataDir: newData(), root: scratch, version: 'test' });
    const v = await look((process.env.SystemDrive ?? 'C:').slice(0, 1));
    expect(v?.fileSystem).toMatch(/NTFS|ReFS/i);
  }, 60_000);
});
