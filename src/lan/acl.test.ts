import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountName, aclDecision, checkPermissions, daclProblems, fixArgs, fixCommandLine, fixPermissions, OWNER_SCRIPT, parseDacl, parseIcaclsSave,
  parseOwnerOutput, protectDir, READ_MASK, rightsMask, SID_AUTHENTICATED_USERS, SID_USERS, WRITE_MASK, type AclTarget, type OwnerReader,
} from './acl';
import { readToken } from './elevation';
import { systemTool } from './paths';

const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1105';
const ROOT_T: AclTarget = { label: 'the folder', path: 'C:\\Users\\NovaPilot\\Voidswarm LAN', access: 'write', dir: true };
const DATA_T: AclTarget = { label: 'data\\', path: 'C:\\Users\\NovaPilot\\Voidswarm LAN\\data', access: 'read', dir: true };

describe('SDDL parsing', () => {
  it('reads icacls /save output (name line, SDDL line)', () => {
    const text = `app\r\nD:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)\r\nStart Voidswarm Host.cmd\r\nD:AI(A;ID;0x1301bf;;;AU)\r\n`;
    expect(parseIcaclsSave(text)).toEqual([
      { name: 'app', sddl: 'D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)' },
      { name: 'Start Voidswarm Host.cmd', sddl: 'D:AI(A;ID;0x1301bf;;;AU)' },
    ]);
  });

  it('decodes rights', () => {
    expect(rightsMask('0x1301bf') & WRITE_MASK).not.toBe(0); // Modify
    expect(rightsMask('0x1200a9') & WRITE_MASK).toBe(0); // Read & execute
    expect(rightsMask('0x1200a9') & READ_MASK).not.toBe(0);
    expect(rightsMask('FA') & WRITE_MASK).not.toBe(0);
    expect(rightsMask('FR') & WRITE_MASK).toBe(0);
    expect(rightsMask('FRFX') & READ_MASK).not.toBe(0);
    expect(rightsMask('GA')).toBe(0x10000000);
    expect(rightsMask('GR') >>> 0).toBe(0x80000000);
  });

  it('parses ACEs: inherited, inherit-only, deny, conditional, a SACL after the DACL', () => {
    const d = parseDacl(`D:PAI(A;OICI;FA;;;${ME})(A;OICIIO;GA;;;CO)(D;OICI;FA;;;BG)(XA;;FA;;;WD;(@User.x == 1))(A;ID;0x1200a9;;;BU)S:AI(AU;SA;FA;;;WD)`);
    expect(d.protected).toBe(true);
    expect(d.aces.map((a) => [a.type, a.sid, a.inherited, a.inheritOnly])).toEqual([
      ['allow', ME, false, false],
      ['allow', 'S-1-3-0', false, true],
      ['deny', 'S-1-5-32-546', false, false],
      ['allow', 'S-1-1-0', false, false],
      ['allow', 'S-1-5-32-545', true, false],
    ]);
    expect(parseDacl('D:NO_ACCESS_CONTROL').nullDacl).toBe(true);
    expect(parseDacl('O:BAG:SY').nullDacl).toBe(true);
  });

  it('names well-known and domain accounts', () => {
    expect(accountName(SID_AUTHENTICATED_USERS)).toBe('Authenticated Users');
    expect(accountName('S-1-5-21-1-2-3-513')).toBe('Domain Users');
    expect(accountName('S-1-5-21-1-2-3-1234')).toMatch(/^another account/);
  });
});

describe('T-LAN-11: the check (pure)', () => {
  const ROOT_AU_M = `D:PAI(A;OICI;0x1301bf;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;

  it('flags Authenticated Users:(M) on the root, and ignores the allowed three', () => {
    const p = daclProblems(parseDacl(ROOT_AU_M), ROOT_T, ME);
    expect(p).toEqual([expect.objectContaining({ sid: SID_AUTHENTICATED_USERS, account: 'Authenticated Users', access: 'write', inherited: false })]);
    expect(daclProblems(parseDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`), ROOT_T, ME)).toEqual([]);
  });

  it('flags read access to data\\ but not a deny or an inherit-only template', () => {
    const d = parseDacl(`D:AI(A;OICIID;0x1200a9;;;BU)(D;;FA;;;WD)(A;OICIIO;FA;;;CO)(A;OICIID;FA;;;${ME})`);
    expect(daclProblems(d, DATA_T, ME).map((x) => x.account)).toEqual(['Users']);
    // Users:(RX) is fine on the root (no write).
    expect(daclProblems(d, ROOT_T, ME)).toEqual([]);
    // No DACL at all means everyone.
    expect(daclProblems(parseDacl('D:NO_ACCESS_CONTROL'), ROOT_T, ME)[0].sid).toBe('S-1-1-0');
  });

  it('School refuses and offers the fix; Home warns', () => {
    const problems = daclProblems(parseDacl(ROOT_AU_M), ROOT_T, ME);
    const school = aclDecision(problems, [], 'school');
    expect(school.decision).toBe('refuse');
    expect(school.message).toMatch(/Authenticated Users can change the folder/);
    expect(school.message).toMatch(/--fix-permissions/);
    const home = aclDecision(problems, [], 'home');
    expect(home.decision).toBe('warn');
    expect(home.banner).toMatch(/Fix permissions/);
    expect(aclDecision([], [], 'school').decision).toBe('ok');
  });

  it('fails closed: School refuses when the permissions couldn\'t be read; Home warns', () => {
    const school = aclDecision([], ['icacls missing'], 'school');
    expect(school.decision).toBe('refuse');
    expect(school.message).toMatch(/couldn't check who can reach its folder \(icacls missing\)/);
    expect(school.message).toMatch(/--fix-permissions/);
    expect(school.message).toMatch(/FOR SCHOOL IT\.txt/);
    expect(aclDecision([], ['icacls missing'], 'home').decision).toBe('warn');
    // A skipped owner check (PowerShell blocked) is a note: it doesn't block School.
    const note = aclDecision([], [], 'school', undefined, ["Voidswarm couldn't check who owns its files (PowerShell: blocked)"]);
    expect(note).toMatchObject({ decision: 'warn', banner: null });
  });

  it('an inherit-only grant on a folder counts (it reaches everything inside); deeper entries report only explicit grants', () => {
    const appT: AclTarget = { label: 'app\\', path: 'C:\\x\\app', access: 'write', dir: true };
    const io = parseDacl(`D:PAI(A;OICIIO;0x1301bf;;;AU)(A;OICI;FA;;;${ME})`);
    expect(daclProblems(io, appT, ME).map((p) => p.account)).toEqual(['Authenticated Users']);
    // On a file an inherit-only ACE means nothing.
    expect(daclProblems(io, { ...appT, dir: false }, ME)).toEqual([]);
    // Deep: an inherited ACE came from the parent (reported there), an explicit one is reported here.
    const inh = parseDacl(`D:AI(A;ID;0x1301bf;;;AU)(A;ID;FA;;;${ME})`);
    const fileT: AclTarget = { label: 'app\\server.mjs', path: 'C:\\x\\app\\server.mjs', access: 'write', dir: false };
    expect(daclProblems(inh, fileT, ME, { deep: true })).toEqual([]);
    expect(daclProblems(inh, fileT, ME)).toHaveLength(1);
    expect(daclProblems(parseDacl(`D:AI(A;;0x1301bf;;;AU)(A;ID;FA;;;${ME})`), fileT, ME, { deep: true })).toEqual([
      expect.objectContaining({ label: 'app\\server.mjs', account: 'Authenticated Users', inherited: false, kind: 'grant' }),
    ]);
  });

  it('describes owners and links', () => {
    const base = { path: 'x', inherited: false };
    const d = aclDecision(
      [
        { ...base, label: 'app\\server.mjs', access: 'write', sid: 'S-1-5-21-1-2-3-1200', account: 'another account (S-1-5-21-1-2-3-1200)', kind: 'owner' },
        { ...base, label: 'app\\jn', access: 'write', sid: 'link', account: 'a link', kind: 'link' },
      ],
      [],
      'school',
    );
    expect(d.decision).toBe('refuse');
    expect(d.message).toMatch(/another account \(S-1-5-21-1-2-3-1200\) owns app\\server\.mjs, so it can change its permissions/);
    expect(d.message).toMatch(/app\\jn is a link to another place/);
  });

  it('parses the owner script\'s output (hex paths, SDDL aliases, errors, the done line)', () => {
    const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const p = 'C:\\Users\\Zoë\\Voidswarm LAN\\app\\server.mjs';
    const out = `VSOWN:S-1-5-21-1-2-3-1200|${hex(p)}\r\nVSOWN:BA|${hex('C:\\x')}\r\nVSDONE:40|0|0\r\n`;
    expect(parseOwnerOutput(out)).toEqual({
      owners: [{ sid: 'S-1-5-21-1-2-3-1200', path: p }, { sid: 'S-1-5-32-544', path: 'C:\\x' }],
      scanned: 40,
      error: undefined,
      done: true,
    });
    expect(parseOwnerOutput(`VSERR:${hex('C:\\y')}\r\nVSDONE:3|1|0\r\n`).error).toMatch(/couldn't be read \(C:\\y\)/);
    expect(parseOwnerOutput(`VSOWN:?|${hex('C:\\z')}\r\nVSDONE:3|0|0\r\n`).error).toMatch(/couldn't be read \(C:\\z\)/);
    expect(parseOwnerOutput('').done).toBe(false);
    expect(OWNER_SCRIPT).not.toContain('"');
  });

  it('builds the spec\'s fix command with SIDs', () => {
    expect(fixCommandLine('C:\\Users\\NovaPilot\\Voidswarm LAN', ME)).toBe(
      `icacls "C:\\Users\\NovaPilot\\Voidswarm LAN" /inheritance:r /grant:r *${ME}:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`,
    );
    expect(fixArgs('C:\\x', ME, [SID_AUTHENTICATED_USERS, 'S-1-5-18', 'S-1-5-21-*-513'])).toEqual([
      'C:\\x', '/inheritance:r', '/grant:r', `*${ME}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/remove:g', '*S-1-5-11',
    ]);
  });
});

const WIN = process.platform === 'win32';

const quote = (p: string) => (/[\s&()'^]/.test(p) ? `"${p}"` : p);

function icacls(...args: string[]): void {
  execFileSync(systemTool('icacls'), args, { windowsHide: true, stdio: 'ignore' });
}

function makeInstall(root: string): void {
  for (const d of [['app'], ['runtime'], ['web', 'assets'], ['data', 'secrets'], ['data', 'backups']]) fs.mkdirSync(path.join(root, ...d), { recursive: true });
  fs.writeFileSync(path.join(root, 'Start Voidswarm Host.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(root, 'runtime', 'node.exe'), 'not really node');
  fs.writeFileSync(path.join(root, 'app', 'server.mjs'), '// server');
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'web', 'assets', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'data', 'voidswarm.db'), 'not really sqlite');
  fs.writeFileSync(path.join(root, 'data', 'secrets', 'pipe.key'), 'k');
}

/** The DACL of one path as icacls /save reports it. */
function daclOf(p: string, tmp: string): ReturnType<typeof parseDacl> {
  const out = path.join(tmp, `dacl-${Math.random().toString(16).slice(2)}.txt`);
  execFileSync(systemTool('icacls'), [p, '/save', out, '/q'], { windowsHide: true, stdio: 'ignore' });
  try {
    return parseDacl(parseIcaclsSave(fs.readFileSync(out).toString('utf16le'))[0].sddl);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

const explicitFor = (d: ReturnType<typeof parseDacl>, sid: string) => d.aces.filter((a) => a.sid === sid && !a.inherited);

// GitHub's Windows runners run as an administrator on a D:\ with broad inherited grants, so a 'safe folder' is
// impossible to set up there; these real-icacls checks are for a normal user profile and run locally.
const CI_RUNNER = process.env.GITHUB_ACTIONS === 'true';
describe.skipIf(!WIN || CI_RUNNER)('T-LAN-11: real icacls on a scratch install', () => {
  let base = '';
  let me = '';
  beforeAll(async () => {
    me = (await readToken()).userSid ?? '';
    expect(me).toMatch(/^S-1-5-/);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acl-'));
  });
  afterAll(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('a root with Authenticated Users:(M): School refuses, Home warns; --fix-permissions makes it pass', async () => {
    const root = path.join(base, "Room 136 (Mr. O'Brien) & Co", 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    const data = path.join(root, 'data');
    const clean = await checkPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(clean.errors).toEqual([]);
    expect(clean.decision).toBe('ok');
    expect(clean.checked.length).toBeGreaterThanOrEqual(6);

    icacls(root, '/grant', `*${SID_AUTHENTICATED_USERS}:(OI)(CI)M`);
    const school = await checkPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(school.decision).toBe('refuse');
    expect(school.problems.some((p) => p.label === 'the folder' && p.sid === SID_AUTHENTICATED_USERS && p.access === 'write')).toBe(true);
    expect(school.problems.some((p) => p.label === 'data\\' && p.access === 'read')).toBe(true);
    expect(school.problems.some((p) => p.label === 'Start Voidswarm Host.cmd')).toBe(true);
    expect(school.fixCommand).toContain('/inheritance:r');
    const home = await checkPermissions({ root, dataDir: data, userSid: me, preset: 'home' });
    expect(home.decision).toBe('warn');

    const fixed = await fixPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(fixed.errors).toEqual([]);
    expect(fixed.ran[0]).toContain('/remove:g *S-1-5-11');
    expect(fixed.report.decision).toBe('ok');
    expect(fixed.report.problems).toEqual([]);
  }, 60_000);

  it('an inherited grant (extracted under a folder everyone can change) is cleared by the fix', async () => {
    const parent = path.join(base, 'shared');
    fs.mkdirSync(parent, { recursive: true });
    icacls(parent, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, `*${SID_AUTHENTICATED_USERS}:(OI)(CI)M`);
    const root = path.join(parent, 'Voidswarm LAN');
    makeInstall(root);
    const before = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(before.decision).toBe('refuse');
    expect(before.problems.every((p) => p.inherited)).toBe(true);
    const fixed = await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(fixed.report.decision).toBe('ok');
  }, 60_000);

  it('explicit grants on a child (app\\ writable, data\\ readable) are removed too', async () => {
    const root = path.join(base, 'child-grants', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    icacls(path.join(root, 'app'), '/grant', `*${SID_AUTHENTICATED_USERS}:(OI)(CI)M`);
    icacls(path.join(root, 'data'), '/grant', '*S-1-5-32-545:(OI)(CI)RX');
    const before = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'home' });
    expect(before.problems.map((p) => `${p.label}:${p.account}:${p.access}`).sort()).toEqual(['app\\:Authenticated Users:write', 'data\\:Users:read']);
    const fixed = await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'home' });
    expect(fixed.ran.some((c) => c.includes('/reset /t /c /q'))).toBe(true);
    expect(fixed.ran.some((c) => c.includes(`/setowner *${me} /t /c /q`))).toBe(true);
    expect(fixed.report.problems).toEqual([]);
    expect(explicitFor(daclOf(path.join(root, 'app'), base), SID_AUTHENTICATED_USERS)).toEqual([]);
  }, 60_000);

  it('deep explicit grants (app\\server.mjs, runtime\\node.exe, data\\voidswarm.db) are found and removed', async () => {
    const root = path.join(base, 'deep', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    const data = path.join(root, 'data');
    icacls(path.join(root, 'app', 'server.mjs'), '/grant', `*${SID_AUTHENTICATED_USERS}:M`);
    icacls(path.join(root, 'runtime', 'node.exe'), '/grant', `*${SID_USERS}:M`);
    icacls(path.join(root, 'data', 'voidswarm.db'), '/grant', `*${SID_USERS}:R`);
    // Read-only for Users on a code file is fine; on data it is not.
    icacls(path.join(root, 'web', 'assets', 'index.js'), '/grant', `*${SID_USERS}:RX`);
    const school = await checkPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(school.decision).toBe('refuse');
    expect(school.problems.map((p) => `${p.kind}:${p.label}:${p.account}:${p.access}`).sort()).toEqual([
      'grant:app\\server.mjs:Authenticated Users:write',
      'grant:data\\voidswarm.db:Users:read',
      'grant:runtime\\node.exe:Users:write',
    ]);
    expect(school.message).toMatch(/Authenticated Users can change app\\server\.mjs/);
    expect(school.message).toMatch(/Users can read data\\voidswarm\.db/);
    expect(school.scanned).toBeGreaterThanOrEqual(14);
    expect(school.notes).toEqual([]); // the real owner check ran

    const fixed = await fixPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(fixed.errors).toEqual([]);
    expect(fixed.report.decision).toBe('ok');
    expect(explicitFor(daclOf(path.join(root, 'app', 'server.mjs'), base), SID_AUTHENTICATED_USERS)).toEqual([]);
    expect(explicitFor(daclOf(path.join(root, 'runtime', 'node.exe'), base), SID_USERS)).toEqual([]);
    expect(explicitFor(daclOf(path.join(root, 'data', 'voidswarm.db'), base), SID_USERS)).toEqual([]);
  }, 60_000);

  it('a readable data\\secrets\\ is refused; the fix re-protects it', async () => {
    const root = path.join(base, 'secrets', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    const secrets = path.join(root, 'data', 'secrets');
    expect(await protectDir(secrets, me)).toBeNull();
    icacls(secrets, '/grant', `*${SID_USERS}:(OI)(CI)R`);
    const before = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(before.decision).toBe('refuse');
    expect(before.problems.map((p) => `${p.label}:${p.account}`)).toEqual(['data\\secrets\\:Users']);
    const fixed = await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(fixed.report.decision).toBe('ok');
    const d = daclOf(secrets, base);
    expect(d.protected).toBe(true); // its own ACL again, not just inherited
    expect(d.aces.map((a) => a.sid).sort()).toEqual([me, 'S-1-5-18', 'S-1-5-32-544'].sort());
    expect(fixed.ran.at(-1)).toContain('secrets');
  }, 60_000);

  it('an inherit-only grant on app\\ (reaches every new file) is found', async () => {
    const root = path.join(base, 'io', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    icacls(path.join(root, 'app'), '/grant', `*${SID_AUTHENTICATED_USERS}:(OI)(CI)(IO)M`);
    const before = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(before.problems.map((p) => p.label)).toEqual(['app\\']);
    expect((await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' })).report.decision).toBe('ok');
  }, 60_000);

  it('a grant set on the root is reported once per top-level item, not once per file', async () => {
    const root = path.join(base, 'once', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    icacls(root, '/grant', `*${SID_AUTHENTICATED_USERS}:(OI)(CI)M`);
    const r = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'home' });
    expect(r.problems.map((p) => p.label).sort()).toEqual(['Start Voidswarm Host.cmd', 'app\\', 'data\\', 'runtime\\', 'the folder', 'web\\'].sort());
  }, 60_000);

  it('another account owning a file (it could re-grant itself access): refused; the fix resets owners', async () => {
    const root = path.join(base, 'owner', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    const student = 'S-1-5-21-1111111111-2222222222-3333333333-1200';
    const server = path.join(root, 'app', 'server.mjs');
    // Taking ownership for another account needs admin rights, so the owner reader is simulated here.
    const reader: OwnerReader = async () => ({ owners: [{ path: server, sid: student }, { path: root, sid: 'S-1-5-32-544' }], scanned: 12 });
    const school = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school', readOwners: reader });
    expect(school.decision).toBe('refuse');
    expect(school.problems).toEqual([expect.objectContaining({ kind: 'owner', label: 'app\\server.mjs', sid: student, access: 'write' })]);
    expect(school.message).toMatch(/owns app\\server\.mjs, so it can change its permissions/);
    const fixed = await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(fixed.ran).toContain(`icacls ${quote(root)} /setowner *${me} /t /c /q`);
    expect(fixed.errors).toEqual([]);
  }, 60_000);

  it('the real owner check: our own files pass, and a blocked PowerShell is only a note', async () => {
    const root = path.join(base, 'owner-real', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    const ok = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(ok).toMatchObject({ decision: 'ok', problems: [], errors: [], notes: [] });
    const blocked: OwnerReader = async () => ({ owners: [], scanned: 0, error: 'PowerShell: blocked by policy' });
    const r = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school', readOwners: blocked });
    expect(r.decision).toBe('warn'); // not refused: icacls ran, and the fix resets owners anyway
    expect(r.notes[0]).toMatch(/couldn't check who owns its files/);
    // A routine start may skip the owner walk (no PowerShell spawn at all).
    let called = 0;
    const counting: OwnerReader = async () => (called++, { owners: [], scanned: 0 });
    const skip = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school', readOwners: counting, checkOwners: false });
    expect(skip).toMatchObject({ decision: 'ok', notes: [] });
    expect(called).toBe(0);
  }, 60_000);

  it('a junction inside the folder is refused, and the fix never follows it', async () => {
    const root = path.join(base, 'link', 'Voidswarm LAN');
    const outside = path.join(base, 'link-target');
    makeInstall(root);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'private.txt'), 'x');
    expect(await protectDir(root, me)).toBeNull();
    icacls(path.join(outside, 'private.txt'), '/grant', `*${SID_USERS}:R`);
    fs.symlinkSync(outside, path.join(root, 'app', 'jn'), 'junction');
    const school = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(school.decision).toBe('refuse');
    expect(school.problems).toEqual([expect.objectContaining({ kind: 'link', label: 'app\\jn' })]);
    expect(school.message).toMatch(/app\\jn is a link to another place/);
    const fixed = await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school' });
    expect(fixed.errors.at(-1)).toMatch(/delete the links themselves/);
    expect(fixed.ran.some((c) => /\/reset|\/setowner/.test(c))).toBe(false);
    // The folder the junction points to is untouched.
    expect(explicitFor(daclOf(path.join(outside, 'private.txt'), base), SID_USERS)).toHaveLength(1);
    fs.rmSync(path.join(root, 'app', 'jn')); // the link only
    expect(fs.existsSync(path.join(outside, 'private.txt'))).toBe(true);
  }, 60_000);

  it('too many files to check: School refuses (fail closed)', async () => {
    const root = path.join(base, 'many', 'Voidswarm LAN');
    makeInstall(root);
    expect(await protectDir(root, me)).toBeNull();
    const r = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: me, preset: 'school', maxEntries: 3 });
    expect(r.decision).toBe('refuse');
    expect(r.errors.join(' ')).toMatch(/more than 3 files and folders/);
  }, 60_000);

  it('a --data folder outside the root is checked and fixed on its own', async () => {
    const root = path.join(base, 'sep', 'Voidswarm LAN');
    const data = path.join(base, 'sep-data');
    makeInstall(root);
    fs.mkdirSync(data, { recursive: true });
    expect(await protectDir(root, me)).toBeNull();
    icacls(data, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, '*S-1-5-32-545:(OI)(CI)RX');
    const before = await checkPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(before.problems).toEqual([expect.objectContaining({ path: data, account: 'Users', access: 'read' })]);
    const fixed = await fixPermissions({ root, dataDir: data, userSid: me, preset: 'school' });
    expect(fixed.report.decision).toBe('ok');
  }, 60_000);
});

describe.skipIf(WIN)('T-LAN-11 on macOS/Linux (mode bits)', () => {
  it('group/other-writable root and a readable data folder: School refuses; the fix passes', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-acl-'));
    try {
      const root = path.join(base, 'Voidswarm LAN');
      makeInstall(root);
      fs.chmodSync(root, 0o777);
      fs.chmodSync(path.join(root, 'data'), 0o755);
      const uid = `uid:${process.getuid?.() ?? 0}`;
      const before = await checkPermissions({ root, dataDir: path.join(root, 'data'), userSid: uid, preset: 'school' });
      expect(before.decision).toBe('refuse');
      const fixed = await fixPermissions({ root, dataDir: path.join(root, 'data'), userSid: uid, preset: 'school' });
      expect(fixed.report.decision).toBe('ok');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
