import { describe, expect, it } from 'vitest';
import {
  checkLocation, isUncPath, isUnder, lanPaths, locationMessage, rootFromLauncher, runPowerShell, STUB_FILES, suggestedRoot, systemTool,
  type ExecFn, type LocationProbe, type VolumeInfo,
} from './paths';

// A simulated Windows PC: the teacher "NovaPilot" with OneDrive on, a normal NTFS C: drive.
const HOME = 'C:\\Users\\NovaPilot';
const ENV = {
  USERPROFILE: HOME,
  OneDrive: `${HOME}\\OneDrive`,
  TEMP: `${HOME}\\AppData\\Local\\Temp`,
  TMP: `${HOME}\\AppData\\Local\\Temp`,
  LOCALAPPDATA: `${HOME}\\AppData\\Local`,
  APPDATA: `${HOME}\\AppData\\Roaming`,
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
};

function sim(over: Partial<LocationProbe> & { volumes?: Record<string, VolumeInfo>; real?: Record<string, string>; files?: Record<string, string>; readOnly?: string[] } = {}): Partial<LocationProbe> {
  const volumes = over.volumes ?? { C: { fileSystem: 'NTFS', driveType: 'Fixed' } };
  return {
    platform: 'win32',
    env: ENV,
    homedir: HOME,
    exists: () => true,
    realpath: (p) => over.real?.[p.toLowerCase()] ?? p,
    volume: (d) => volumes[d] ?? null,
    writable: (d) => !(over.readOnly ?? []).some((r) => d.toLowerCase().startsWith(r.toLowerCase())),
    readText: (p) => over.files?.[p.toLowerCase()] ?? null,
    ...over,
  };
}

const SUGGEST = '%USERPROFILE%\\Voidswarm LAN';

async function refused(root: string, probe = sim(), data = `${root}\\data`) {
  const r = await checkLocation(root, data, probe);
  expect(r.ok, `${root} should be refused`).toBe(false);
  expect(r.message).toContain(SUGGEST);
  expect(r.message).toContain(`${HOME}\\Voidswarm LAN`);
  return r;
}

describe('layout (§2.1)', () => {
  it('derives every path from the root', () => {
    const p = lanPaths('C:\\Users\\NovaPilot\\Voidswarm LAN', { platform: 'win32' });
    expect(p.app).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN\\app');
    expect(p.nodeExe).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN\\runtime\\node.exe');
    expect(p.config).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN\\data\\voidswarm.config.json');
    expect(p.pipeKey).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN\\data\\secrets\\pipe.key');
    expect(p.preflight).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN\\data\\preflight.json');
    expect(p.movedTo).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN\\data\\MOVED-TO.json');
    expect(p.stubs).toHaveLength(STUB_FILES.length);
    expect(lanPaths('C:\\x', { platform: 'win32', data: 'D:\\vs-data' }).secrets).toBe('D:\\vs-data\\secrets');
    expect(rootFromLauncher('C:\\Users\\NovaPilot\\Voidswarm LAN\\app\\launch.mjs', 'win32')).toBe('C:\\Users\\NovaPilot\\Voidswarm LAN');
  });

  it('runs system tools by absolute path, never a bare name (cwd hijack)', () => {
    expect(systemTool('icacls', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\icacls.exe');
    expect(systemTool('powershell', { SYSTEMROOT: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('gives PowerShell a fixed script with values in VS_* env vars', async () => {
    const calls: { file: string; args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ file, args, env: opts?.env });
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    await runPowerShell('Get-Volume -DriveLetter $env:VS_DRIVE', { VS_DRIVE: 'C' }, { exec, env: { SystemRoot: 'C:\\Windows' } });
    expect(calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0].args).toContain('-NoProfile');
    expect(calls[0].args).not.toContain('-EncodedCommand');
    // No execution-policy override: an EDR signal, and not needed for -Command text.
    expect(calls[0].args).not.toContain('-ExecutionPolicy');
    expect(calls[0].args.map((a) => a.toLowerCase())).not.toContain('bypass');
    expect(calls[0].args.at(-1)).toBe('Get-Volume -DriveLetter $env:VS_DRIVE');
    expect(calls[0].env?.VS_DRIVE).toBe('C');
    await expect(runPowerShell('Write-Output "x"', {}, { exec })).rejects.toThrow(/double quotes/);
    await expect(runPowerShell('x', { PATH: 'y' }, { exec })).rejects.toThrow(/variable name/);
  });

  it('compares Windows paths case-insensitively and knows UNC paths', () => {
    expect(isUnder('c:\\users\\novapilot\\onedrive\\desktop\\x', 'C:\\Users\\NovaPilot\\OneDrive', 'win32')).toBe(true);
    expect(isUnder('C:\\Users\\NovaPilot\\OneDriveBackup', 'C:\\Users\\NovaPilot\\OneDrive', 'win32')).toBe(false);
    expect(isUncPath('\\\\fileserver\\staff\\x')).toBe(true);
    expect(isUncPath('\\\\?\\UNC\\fileserver\\staff')).toBe(true);
    expect(isUncPath('\\\\?\\C:\\x')).toBe(false);
    expect(isUncPath('C:\\x')).toBe(false);
  });
});

describe('T-LAN-3: install-location refusals', () => {
  it('accepts %USERPROFILE%\\Voidswarm LAN on a fixed NTFS drive', async () => {
    const r = await checkLocation(`${HOME}\\Voidswarm LAN`, `${HOME}\\Voidswarm LAN\\data`, sim());
    expect(r.ok).toBe(true);
    expect(r.message).toBeNull();
    expect(r.suggestion).toBe(`${HOME}\\Voidswarm LAN`);
    expect(suggestedRoot({ platform: 'win32', env: ENV, homedir: HOME })).toBe(`${HOME}\\Voidswarm LAN`);
  });

  it('refuses a simulated %OneDrive% (the owner\'s Desktop)', async () => {
    const r = await refused(`${HOME}\\OneDrive\\Desktop\\Voidswarm LAN`);
    expect(r.problems.map((p) => p.code)).toContain('cloud');
    expect(r.message).toMatch(/OneDrive/);
  });

  it('refuses OneDrive for Business and a Dropbox folder from info.json', async () => {
    const env = { ...ENV, OneDriveCommercial: `${HOME}\\OneDrive - Caldwell School District` };
    await refused(`${HOME}\\OneDrive - Caldwell School District\\Voidswarm LAN`, sim({ env }));
    const info = JSON.stringify({ personal: { path: 'D:\\Sync\\Box of stuff' } });
    const r = await refused('D:\\Sync\\Box of stuff\\Voidswarm LAN', sim({
      files: { [`${HOME}\\AppData\\Local\\Dropbox\\info.json`.toLowerCase()]: info },
      volumes: { D: { fileSystem: 'NTFS', driveType: 'Fixed' } },
    }));
    expect(r.problems[0].detail).toMatch(/Dropbox/);
  });

  it('refuses %TEMP%\\Temp1_x (Explorer\'s zip view) with "extract first"', async () => {
    const r = await refused(`${ENV.TEMP}\\Temp1_voidswarm-lan-0.6.0-win-x64.zip\\Voidswarm LAN`);
    expect(r.problems.map((p) => p.code)).toEqual(['zip-view']);
    expect(r.message).toMatch(/Extract/);
  });

  it('refuses plain %TEMP% and C:\\Windows\\Temp', async () => {
    expect((await refused(`${ENV.TEMP}\\t\\Voidswarm LAN`)).problems[0].code).toBe('temp');
    expect((await refused('C:\\Windows\\Temp\\Voidswarm LAN')).problems[0].code).toBe('temp');
  });

  it('refuses Downloads', async () => {
    expect((await refused(`${HOME}\\Downloads\\Voidswarm LAN`)).problems[0].code).toBe('downloads');
    const redirected = sim({ downloadsDir: 'E:\\Downloads', volumes: { E: { fileSystem: 'NTFS', driveType: 'Fixed' } } });
    expect((await refused('E:\\Downloads\\Voidswarm LAN', redirected)).problems[0].code).toBe('downloads');
  });

  it('refuses a UNC path and a mapped network drive', async () => {
    expect((await refused('\\\\district-fs01\\staff$\\NovaPilot\\Voidswarm LAN')).problems[0].code).toBe('unc');
    const mapped = sim({ real: { 'h:\\voidswarm lan': '\\\\district-fs01\\home\\NovaPilot\\Voidswarm LAN' }, volumes: {} });
    const r = await refused('H:\\Voidswarm LAN', mapped);
    expect(r.problems.map((p) => p.code)).toContain('network-drive');
  });

  it('refuses a FAT32 / exFAT volume and a removable drive', async () => {
    const fat = await refused('E:\\Voidswarm LAN', sim({ volumes: { E: { fileSystem: 'FAT32', driveType: 'Fixed' } } }));
    expect(fat.problems.map((p) => p.code)).toEqual(['fat']);
    expect(fat.message).toMatch(/no file permissions/);
    const usb = await refused('F:\\Voidswarm LAN', sim({ volumes: { F: { fileSystem: 'exFAT', driveType: 'Removable' } } }));
    expect(usb.problems.map((p) => p.code).sort()).toEqual(['fat', 'removable']);
  });

  it('refuses Program Files and a read-only folder', async () => {
    expect((await refused('C:\\Program Files\\Voidswarm LAN')).problems[0].code).toBe('program-files');
    expect((await refused('C:\\Program Files (x86)\\Voidswarm LAN')).problems[0].code).toBe('program-files');
    const ro = await refused('C:\\Games\\Voidswarm LAN', sim({ readOnly: ['C:\\Games'] }));
    expect(ro.problems.map((p) => p.code)).toEqual(['read-only']);
  });

  it('judges where a subst drive or junction really points', async () => {
    const probe = sim({ real: { 's:\\voidswarm lan': `${HOME}\\OneDrive\\Voidswarm LAN` }, volumes: { S: { fileSystem: 'NTFS', driveType: 'Fixed' } } });
    const r = await refused('S:\\Voidswarm LAN', probe);
    expect(r.problems[0].code).toBe('cloud');
  });

  it('checks a --data folder outside the root too', async () => {
    const r = await checkLocation(`${HOME}\\Voidswarm LAN`, `${HOME}\\OneDrive\\vs-data`, sim());
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ which: 'data', code: 'cloud' })]);
    expect(r.message).toContain('Data folder:');
    expect(r.message).toContain(SUGGEST);
  });

  it('warns (without refusing) about a Desktop that is not on OneDrive', async () => {
    const r = await checkLocation(`${HOME}\\Desktop\\Voidswarm LAN`, `${HOME}\\Desktop\\Voidswarm LAN\\data`, sim());
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['desktop']);
  });

  it('lists several problems in one message', () => {
    const msg = locationMessage(
      [
        { code: 'cloud', which: 'root', path: 'x', detail: 'It is inside OneDrive.' },
        { code: 'fat', which: 'root', path: 'x', detail: 'Drive E: uses FAT32.' },
      ],
      `${HOME}\\Voidswarm LAN`,
      'win32',
    );
    expect(msg.split('\n')).toHaveLength(5);
    expect(msg).toContain(SUGGEST);
  });

  it('uses ~/Voidswarm LAN on macOS and Linux', async () => {
    const r = await checkLocation('/Users/nova/Library/CloudStorage/OneDrive-Personal/Voidswarm LAN', '/Users/nova/Library/CloudStorage/OneDrive-Personal/Voidswarm LAN/data', {
      platform: 'darwin', env: { HOME: '/Users/nova' }, homedir: '/Users/nova', exists: () => true, realpath: (p) => p, writable: () => true, readText: () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('~/Voidswarm LAN');
  });
});
