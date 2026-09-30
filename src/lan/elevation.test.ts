import { describe, expect, it } from 'vitest';
import { checkElevation, decideElevation, integrityFromSid, parseCsvLine, parseWhoami, readToken } from './elevation';
import type { ExecFn } from './paths';

// `whoami /user /groups /fo csv /nh` as a standard user (UAC-filtered admin: Administrators is deny-only).
const USER_LINE = '"caldwell\\novapilot","S-1-5-21-1111111111-2222222222-3333333333-1105"';
const GROUPS = (label: string, sid: string) =>
  [
    '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
    '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
    '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
    '"NT AUTHORITY\\Authenticated Users","Well-known group","S-1-5-11","Mandatory group, Enabled by default, Enabled group"',
    `"Mandatory Label\\${label}","Label","${sid}",""`,
  ].join('\r\n');
const MEDIUM = `${USER_LINE}\r\n\r\n${GROUPS('Medium Mandatory Level', 'S-1-16-8192')}\r\n`;
const HIGH = `${USER_LINE}\r\n\r\n${GROUPS('High Mandatory Level', 'S-1-16-12288')}\r\n`;
// A German Windows: the names change, the SIDs don't.
const HIGH_DE = `"caldwell\\novapilot","S-1-5-21-1111111111-2222222222-3333333333-1105"\r\n\r\n"Verbindliche Beschriftung\\Hohe Verbindlichkeitsstufe","Bezeichnung","S-1-16-12288",""\r\n`;

describe('whoami parsing', () => {
  it('reads the user SID and the mandatory label', () => {
    const t = parseWhoami(MEDIUM);
    expect(t.userSid).toBe('S-1-5-21-1111111111-2222222222-3333333333-1105');
    expect(t.userName).toBe('caldwell\\novapilot');
    expect(t.integrity).toBe('medium');
    expect(t.integritySid).toBe('S-1-16-8192');
    expect(t.groups.map((g) => g.sid)).toContain('S-1-5-32-544');
  });

  it('maps label RIDs', () => {
    expect(integrityFromSid('S-1-16-4096')).toBe('low');
    expect(integrityFromSid('S-1-16-8448')).toBe('medium-plus');
    expect(integrityFromSid('S-1-16-12288')).toBe('high');
    expect(integrityFromSid('S-1-16-16384')).toBe('system');
    expect(integrityFromSid('S-1-5-18')).toBe('unknown');
    expect(integrityFromSid(null)).toBe('unknown');
  });

  it('splits quoted CSV with commas and doubled quotes', () => {
    expect(parseCsvLine('"a","b, c","d""e",""')).toEqual(['a', 'b, c', 'd"e', '']);
  });
});

describe('T-LAN-12: elevated start', () => {
  it('a simulated High-integrity token: School refuses', () => {
    const r = decideElevation(parseWhoami(HIGH), 'school');
    expect(r.elevated).toBe(true);
    expect(r.decision).toBe('refuse');
    expect(r.message).toMatch(/administrator/);
    expect(r.banner).toBeNull();
  });

  it('a simulated High-integrity token: Home starts with a banner', () => {
    const r = decideElevation(parseWhoami(HIGH), 'home');
    expect(r.decision).toBe('warn');
    expect(r.banner).toMatch(/administrator/);
    expect(r.message).toMatch(/User Account Control/);
  });

  it('works on any Windows language (SIDs only)', () => {
    expect(decideElevation(parseWhoami(HIGH_DE), 'school').decision).toBe('refuse');
  });

  it('a normal (Medium) token starts in both presets', () => {
    for (const preset of ['home', 'school'] as const) {
      const r = decideElevation(parseWhoami(MEDIUM), preset);
      expect(r).toMatchObject({ elevated: false, decision: 'ok', message: null, banner: null });
    }
  });

  it('fails closed: a token that can\'t be read refuses School and warns Home', async () => {
    const failing: ExecFn = async () => ({ code: null, stdout: '', stderr: '', error: 'ENOENT' });
    const school = await checkElevation('school', { exec: failing, platform: 'win32' });
    expect(school).toMatchObject({ elevated: false, integrity: 'unknown', decision: 'refuse' });
    expect(school.message).toMatch(/couldn't check how it was started/);
    expect(school.message).toMatch(/ENOENT/);
    expect(school.token.error).toMatch(/whoami/);
    const home = await checkElevation('home', { exec: failing, platform: 'win32' });
    expect(home).toMatchObject({ decision: 'warn' });
    expect(home.banner).toMatch(/Couldn't check/);
    // Output without a mandatory label (garbled or cut short) counts as unknown too.
    const noLabel: ExecFn = async () => ({ code: 0, stdout: `${USER_LINE}\r\n`, stderr: '' });
    expect((await checkElevation('school', { exec: noLabel, platform: 'win32' })).decision).toBe('refuse');
  });

  it('runs whoami by absolute path with /user /groups', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: HIGH, stderr: '' };
    };
    const r = await checkElevation('school', { exec, platform: 'win32' });
    expect(r.decision).toBe('refuse');
    expect(r.token.userSid).toMatch(/^S-1-5-21-/);
    expect(calls[0].file).toMatch(/System32\\whoami\.exe$/i);
    expect(calls[0].args).toEqual(['/user', '/groups', '/fo', 'csv', '/nh']);
  });

  it.skipIf(process.platform !== 'win32')('reads the real token on Windows', async () => {
    const t = await readToken();
    expect(t.userSid).toMatch(/^S-1-5-/);
    expect(t.integrity).not.toBe('unknown');
  });
});
