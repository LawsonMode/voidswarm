import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runPowerShell, type ExecFn } from './paths';
import {
  categoryFor, getPreflight, hostProbeScript, lanServingAllowed, parseHostProbe, parseNetshRules, parsePowercfg, preflightFilePath,
  preflightNotices, readPreflightFile, runPreflight, staleReason, volumeLookup, type HostProbe, type PreflightReport,
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
    expect(preflightNotices(r).map((x) => x.code)).toEqual(['firewall-prompt']);
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
    expect(preflightNotices(blocked).map((x) => x.code)).toEqual(['firewall-block']);
    expect(preflightNotices(blocked)[0].text).toMatch(/Allow through firewall \(admin\)\.cmd/);

    const gpo = probeJson({ profiles: [{ name: 'Private', enabled: 'True', inbound: 'Block', allowLocal: 'False' }] });
    const policy = await runPreflight(base(newData(), { exec: mockExec({ probe: gpo }) }));
    expect(preflightNotices(policy).map((x) => x.code)).toEqual(['firewall-policy']);
    expect(preflightNotices(policy)[0].text).toMatch(/FOR SCHOOL IT\.txt/);
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

  it('School on the Domain profile with no rule: IT must add it', async () => {
    const probe = probeJson({ network: [{ alias: 'Ethernet', index: 12, name: 'caldwellschools.org', category: 'DomainAuthenticated' }] });
    const r = await runPreflight(base(newData(), { exec: mockExec({ probe }) }));
    expect(preflightNotices(r, { preset: 'school' }).find((x) => x.code === 'firewall-prompt')?.text).toMatch(/IT must add it/);
    expect(preflightNotices(r, { preset: 'home' }).find((x) => x.code === 'firewall-prompt')?.text).toMatch(/Node\.js JavaScript Runtime/);
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
