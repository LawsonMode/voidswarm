// LAN task B11: the in-place updater and rollback (T-LAN-17; docs/LAN-EDITION-proposal.md §2.5). Fake installs and
// update zips are made in scratch folders: small stand-ins for the bundles and node.exe (the signature check is
// injected, except where the real node.exe is checked), a real database and data\secrets, and real zips from Windows
// tar (the same makeZip / writeSums the package build uses).
// The updater is Windows-only (runtime\node.exe, the .cmd stubs): some flows are checked on win32 only.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appBuildOptions, makeZip, writeSums, zipName } from '../../scripts/build-lan.mjs';
import { AuthStore, SCHEMA_VERSION } from '../server/auth/store';
import { listBackups } from '../server/maint';
import { addAccount, statfsFree } from '../server/maint/testutil';
import { openFileSecrets } from '../server/secrets';
import { SettingsService } from '../server/settings';
import { LAN_FOLDER_NAME, lanPaths, type LanPaths } from './paths';
import { acquireLock } from './pipe';
import type { ToolIo } from './restore';
import { runTool } from './tool';
import {
  applyRollback, applyUpdate, checkNodeSignature, compareVersions, findUpdateZips, parseSha256File, parseSums, parseVersion, planRollback,
  readUpdateInfo, RECOVER_TOOL, recoverInterruptedUpdate, runUpdateTool, RUNTIME_NEXT, toolRoot, SimulatedCrash, UPDATE_JOURNAL, UPDATE_STAGING, updateLeftoverNotes,
  verifyStagedTree, zipInfo, type SignatureCheck, type SwapProbe, type UpdateDeps, type UpdateToolDeps, type UpdateZip,
} from './update';

const GB = 1024 ** 3;
const scratch: string[] = [];
afterEach(() => { while (scratch.length) { try { fs.rmSync(scratch.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* held */ } } });

const OK_SIG = async (): Promise<SignatureCheck> => ({ ok: true, status: 'Valid', subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US' });
const TEMPLATES = path.resolve(__dirname, '..', '..', 'scripts', 'lan', 'templates');
const STUBS = ['Start Voidswarm Host.cmd', 'Update Voidswarm.cmd', 'Reset admin password.cmd', 'Restore a backup.cmd'];
const DOCS = ['START HERE.html', 'FOR SCHOOL IT.txt', 'VERSION.txt', 'THIRD-PARTY-NOTICES.txt'];

function mkScratch(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
}

interface TreeOpts { node?: string; stubText?: string; buildVersion?: string; nodeVersion?: string; tool?: string | Buffer }

/** A "Voidswarm LAN" tree of a version: stand-in bundles, web, runtime, root docs, the stubs, SHA256SUMS.txt. */
function writeTree(root: string, version: string, o: TreeOpts = {}): void {
  const w = (rel: string, text: string | Buffer): void => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  for (const n of ['launch', 'server', 'tool', 'maint']) w(`app/${n}.mjs`, n === 'tool' && o.tool !== undefined ? o.tool : `// ${n} ${version}\n`);
  w('app/admin/admin.html', `<!doctype html><title>admin ${version}</title>`);
  w('app/build-info.json', JSON.stringify({ name: 'voidswarm-lan', version: o.buildVersion ?? version, node: o.nodeVersion ?? 'v24.16.0', platform: 'win-x64', buildDate: '2026-09-29T00:00:00.000Z' }));
  w('web/index.html', `<!doctype html><p>game ${version}</p>`);
  w('web/assets/a.js', `console.log(${JSON.stringify(version)})`);
  w('runtime/node.exe', o.node ?? 'MZ stand-in node.exe A');
  w('runtime/LICENSE', 'Node.js licence');
  for (const d of DOCS) w(d, `${d} for ${version}\r\n`);
  for (const s of STUBS) w(s, o.stubText ?? fs.readFileSync(path.join(TEMPLATES, s), 'utf8').replace(/\r?\n/g, '\r\n'));
  writeSums(root);
}

interface Install { root: string; paths: LanPaths }

async function install(version = '0.6.0', o: TreeOpts = {}): Promise<Install> {
  const root = path.join(mkScratch('vs-update-'), "Room 136 (Mr. O'Brien) & Co", LAN_FOLDER_NAME);
  writeTree(root, version, o);
  const paths = lanPaths(root);
  fs.mkdirSync(paths.data);
  const secrets = openFileSecrets(paths.data);
  for (const k of ['backup.key', 'pepper.key', 'pipe.key'] as const) secrets.ensureKey(k);
  const settings = SettingsService.open({ dataDir: paths.data, env: {}, lan: true, secrets, log: () => undefined });
  await settings.apply({ serverName: 'Room 136' });
  new AuthStore(paths.db).close();
  withDb(paths.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
  return { root, paths };
}

const withDb = <T>(file: string, fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  try { return fn(db); } finally { db.close(); }
};
const names = (file: string): string[] => withDb(file, (db) => (db.prepare('SELECT username FROM accounts ORDER BY username').all() as { username: string }[]).map((r) => r.username));
const userVersion = (file: string): number => withDb(file, (db) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version));
const versionOf = (appDir: string): string => (JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8')) as { version: string }).version;
const read = (f: string): string => fs.readFileSync(f, 'utf8');

/** A stage folder with the package's tree (for the injected extractor, and for zips). */
function stagePackage(version: string, o: TreeOpts = {}, mutate?: (root: string) => void): string {
  const parent = mkScratch('vs-pkg-');
  const root = path.join(parent, LAN_FOLDER_NAME);
  writeTree(root, version, o);
  mutate?.(root);
  return parent;
}

/** A real zip (Windows tar) of the package in `dir`, with its .sha256. */
function packageZip(dir: string, version: string, o: TreeOpts = {}, mutate?: (root: string) => void): string {
  const parent = stagePackage(version, o, mutate);
  const zip = path.join(dir, zipName(version));
  makeZip(parent, zip);
  return zip;
}

function scripted(answers: (string | null)[]): ToolIo & { out: string[]; asked: string[]; text(): string } {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out, asked,
    text: () => out.join('\n'),
    write: (l) => { out.push(l); },
    ask: async (q) => { asked.push(q); return answers.length ? answers.shift()! : null; },
  };
}

const deps = (i: Install, io: ToolIo, extra: Partial<UpdateToolDeps> = {}): UpdateToolDeps => ({
  root: i.root, io, verifySignature: OK_SIG, statfs: statfsFree(50 * GB), ...extra,
});

/** An extractor that copies a staged package instead of unzipping (the zip's own path is ignored). */
const copyFrom = (parent: string) => async (_zip: string, dest: string): Promise<void> => { fs.cpSync(parent, dest, { recursive: true }); };

describe('versions, zips and checksum files', () => {
  it('parses and orders versions (a pre-release before its release)', () => {
    expect(parseVersion('0.6.1')).toEqual({ major: 0, minor: 6, patch: 1, pre: null });
    expect(parseVersion('0.6.1-rc.2')?.pre).toBe('rc.2');
    expect(parseVersion('v0.6.1')).toBeNull();
    expect(compareVersions('0.6.10', '0.6.9')).toBeGreaterThan(0);
    expect(compareVersions('0.7.0', '0.6.99')).toBeGreaterThan(0);
    expect(compareVersions('0.6.1-rc.1', '0.6.1')).toBeLessThan(0);
    expect(compareVersions('0.6.1', '0.6.1')).toBe(0);
    // Semver pre-release order: numeric identifiers as numbers, below alphanumeric ones; a shorter prefix first.
    expect(compareVersions('0.6.1-rc.10', '0.6.1-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('0.6.1-rc.9', '0.6.1-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.6.1-rc.2', '0.6.1-rc.2')).toBe(0);
    expect(compareVersions('0.6.1-1', '0.6.1-rc')).toBeLessThan(0);
    expect(compareVersions('0.6.1-rc', '0.6.1-rc.1')).toBeLessThan(0);
    expect(compareVersions('0.6.1-rc.10.1', '0.6.1-rc.10')).toBeGreaterThan(0);
    expect(compareVersions('0.6.1-alpha', '0.6.1-beta')).toBeLessThan(0);
    expect(compareVersions('0.6.1-rc.99999999999999999999', '0.6.1-rc.99999999999999999998')).toBeGreaterThan(0);
    expect(['0.6.1-rc.9', '0.6.1', '0.6.1-rc.10', '0.6.1-rc.1'].sort(compareVersions)).toEqual(['0.6.1-rc.1', '0.6.1-rc.9', '0.6.1-rc.10', '0.6.1']);
  });

  it.runIf(process.platform === 'win32')('finds update zips in the folder and in updates\\, newest version first; other files are ignored', () => {
    const root = mkScratch('vs-zips-');
    fs.mkdirSync(path.join(root, 'updates'));
    for (const f of ['voidswarm-lan-0.6.1-win-x64.zip', 'updates/voidswarm-lan-0.6.10-win-x64.zip', 'voidswarm-lan-0.6.2-rc.1-win-x64.zip', 'voidswarm-lan-latest.zip', 'notes.zip']) {
      fs.writeFileSync(path.join(root, f), 'x');
    }
    expect(findUpdateZips(root).map((z) => z.version)).toEqual(['0.6.10', '0.6.2-rc.1', '0.6.1']);
    for (const f of ['voidswarm-lan-0.6.11-rc.9-win-x64.zip', 'voidswarm-lan-0.6.11-rc.10-win-x64.zip']) fs.writeFileSync(path.join(root, f), 'x');
    expect(findUpdateZips(root)[0]!.version).toBe('0.6.11-rc.10');
    expect(zipInfo('C:\\x\\voidswarm-lan-0.6.1-win-x64.zip')?.version).toBe('0.6.1');
    expect(zipInfo('voidswarm-lan-0.6.1.zip')).toBeNull();
  });

  it('reads .sha256 files and SHA256SUMS.txt, refusing unsafe paths', () => {
    const hex = 'ab'.repeat(32);
    expect(parseSha256File(`${hex}  voidswarm-lan-0.6.1-win-x64.zip\r\n`, 'voidswarm-lan-0.6.1-win-x64.zip')).toBe(hex);
    expect(parseSha256File(`${hex.toUpperCase()}\n`)).toBe(hex);
    expect(parseSha256File('not a hash')).toBeNull();
    expect(parseSha256File(`${hex}  other.zip`, 'voidswarm-lan-0.6.1-win-x64.zip')).toBeNull();
    const ok = parseSums(`${hex}  app/server.mjs\r\n${'cd'.repeat(32)}  START HERE.html\r\n`);
    expect(ok.errors).toEqual([]);
    expect([...ok.entries.keys()]).toEqual(['app/server.mjs', 'START HERE.html']);
    for (const bad of ['../x', 'app\\x', '/etc/x', 'C:/x', 'app//x', './x']) {
      expect(parseSums(`${hex}  ${bad}`).errors, bad).toHaveLength(1);
    }
    expect(parseSums(`${hex}  a\n${hex}  a`).errors).toHaveLength(1);
  });

  it('verifyStagedTree: a clean package passes; a changed file, an unlisted file, a wrong version or Node fails', async () => {
    const good = path.join(stagePackage('0.6.1'), LAN_FOLDER_NAME);
    expect(await verifyStagedTree(good, '0.6.1')).toEqual([]);
    expect((await verifyStagedTree(good, '0.6.2')).join()).toMatch(/says 0\.6\.2 but its app\\build-info\.json says 0\.6\.1/);
    const changed = path.join(stagePackage('0.6.1', {}, (r) => fs.appendFileSync(path.join(r, 'app', 'server.mjs'), '// tampered')), LAN_FOLDER_NAME);
    expect((await verifyStagedTree(changed, '0.6.1')).join()).toMatch(/app\\server\.mjs does not match SHA256SUMS\.txt/);
    const extra = path.join(stagePackage('0.6.1', {}, (r) => fs.writeFileSync(path.join(r, 'app', 'evil.mjs'), 'x')), LAN_FOLDER_NAME);
    expect((await verifyStagedTree(extra, '0.6.1')).join()).toMatch(/app\\evil\.mjs is not in SHA256SUMS\.txt/);
    const node22 = path.join(stagePackage('0.6.1', { nodeVersion: 'v22.1.0' }), LAN_FOLDER_NAME);
    expect((await verifyStagedTree(node22, '0.6.1')).join()).toMatch(/Node v22\.1\.0; 0\.6\.x needs Node 24/);
    const noTool = path.join(stagePackage('0.6.1', {}, (r) => { fs.rmSync(path.join(r, 'app', 'tool.mjs')); writeSums(r); }), LAN_FOLDER_NAME);
    expect((await verifyStagedTree(noTool, '0.6.1')).join()).toMatch(/has no app\\tool\.mjs/);
  });
});

describe.runIf(process.platform === 'win32')('T-PKG-3 in the updater: the node.exe signature', () => {
  it('the real node.exe is Valid and from the OpenJS Foundation; a stand-in file is refused', async () => {
    const real = await checkNodeSignature(process.execPath);
    expect(real).toMatchObject({ ok: true, status: 'Valid' });
    expect(real.subject).toMatch(/CN=OpenJS Foundation/);
    const fake = path.join(mkScratch('vs-sig-'), 'node.exe');
    fs.writeFileSync(fake, 'MZ not really');
    const r = await checkNodeSignature(fake);
    expect(r.ok).toBe(false);
    expect(r.status).not.toBe('Valid');
  }, 60_000);
});

describe.runIf(process.platform === 'win32')('T-LAN-17: tool update and --rollback (real zips, Windows tar)', () => {
  it('a newer zip: data\\ and the root path stay, app\\ moves to previous\\, a pre-update backup is made, the stubs are never rewritten', async () => {
    const i = await install('0.6.0');
    const dataBefore = fs.readdirSync(i.paths.data).sort();
    const configBefore = read(i.paths.config);
    const stubsBefore = STUBS.map((st) => read(path.join(i.root, st)));
    packageZip(i.root, '0.6.1', { stubText: '@echo off\r\necho a changed stub\r\n' });
    const io = scripted(['y']);
    expect(await runUpdateTool([], deps(i, io))).toBe(0);
    const text = io.text();
    expect(text).toContain('Installed: Voidswarm LAN 0.6.0');
    expect(text).toMatch(/Update: +Voidswarm LAN 0\.6\.1/);
    expect(text).toMatch(/SHA-256: +[0-9a-f]{64}/);
    expect(text).toContain(`matches ${zipName('0.6.1')}.sha256`);
    expect(io.asked[0]).toMatch(/Install Voidswarm LAN 0\.6\.1\?/);
    expect(text).toContain('Updated to Voidswarm LAN 0.6.1');
    // The new version is in, the old one in previous\ (app, web and the root text files).
    expect(versionOf(i.paths.app)).toBe('0.6.1');
    expect(read(path.join(i.paths.web, 'index.html'))).toContain('game 0.6.1');
    expect(versionOf(path.join(i.paths.previous, 'app'))).toBe('0.6.0');
    expect(read(path.join(i.paths.previous, 'web', 'index.html'))).toContain('game 0.6.0');
    expect(read(path.join(i.root, 'START HERE.html'))).toContain('for 0.6.1');
    expect(read(path.join(i.paths.previous, 'root', 'START HERE.html'))).toContain('for 0.6.0');
    // The stubs (one of them is running during an update) are untouched.
    expect(STUBS.map((st) => read(path.join(i.root, st)))).toEqual(stubsBefore);
    expect(read(path.join(i.root, 'Start Voidswarm Host.cmd'))).not.toContain('a changed stub');
    // Same node.exe: no runtime switch.
    expect(fs.existsSync(path.join(i.root, RUNTIME_NEXT))).toBe(false);
    // data\ is as it was, plus the backup.
    expect(names(i.paths.db)).toEqual(['NovaPilot']);
    expect(read(i.paths.config)).toBe(configBefore);
    expect(fs.readdirSync(i.paths.data).sort()).toEqual([...new Set([...dataBefore, 'backups'])].sort());
    const backups = listBackups(i.paths.data);
    expect(backups.map((b) => b.name)).toEqual([expect.stringMatching(/_pre-update-0\.6\.1\.vsbak$/)]);
    const info = readUpdateInfo(i.paths);
    expect(info).toMatchObject({ kind: 'update', from: '0.6.0', to: '0.6.1', backup: backups[0]!.name, schemaBefore: SCHEMA_VERSION, runtimeChanged: false });
    // Nothing left over.
    expect(fs.existsSync(path.join(i.root, UPDATE_STAGING))).toBe(false);
    expect(fs.existsSync(path.join(i.root, UPDATE_JOURNAL))).toBe(false);
    // The same zip again: already installed.
    const again = scripted([]);
    expect(await runUpdateTool([], deps(i, again))).toBe(0);
    expect(again.text()).toContain('Voidswarm LAN 0.6.1 is already installed');
  }, 120_000);

  it('--rollback puts previous\\ back (no restore when the schema did not change); a second --rollback goes forward again', async () => {
    const i = await install('0.6.0');
    packageZip(i.root, '0.6.1');
    expect(await runUpdateTool(['--yes'], deps(i, scripted([])))).toBe(0);
    withDb(i.paths.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    const io = scripted(['y']);
    expect(await runUpdateTool(['--rollback'], deps(i, io))).toBe(0);
    expect(io.asked).toEqual([expect.stringMatching(/Go back to 0\.6\.0\?/)]);
    expect(versionOf(i.paths.app)).toBe('0.6.0');
    expect(versionOf(path.join(i.paths.previous, 'app'))).toBe('0.6.1');
    expect(read(path.join(i.root, 'START HERE.html'))).toContain('for 0.6.0');
    // No database change, so nothing restored: the account made after the update is still there.
    expect(names(i.paths.db)).toEqual(['LatePilot', 'NovaPilot']);
    expect(io.text()).toContain('Voidswarm LAN is back at 0.6.0.');
    // With a backup of the data as 0.6.0 sees it, for the --rollback that goes forward again.
    expect(readUpdateInfo(i.paths)).toMatchObject({ kind: 'rollback', from: '0.6.1', to: '0.6.0', backup: expect.stringMatching(/_pre-update-0\.6\.0\.vsbak$/) });
    // And forward again.
    expect(await runUpdateTool(['--rollback', '--yes'], deps(i, scripted([])))).toBe(0);
    expect(versionOf(i.paths.app)).toBe('0.6.1');
    expect(versionOf(path.join(i.paths.previous, 'app'))).toBe('0.6.0');
    expect(names(i.paths.db)).toEqual(['LatePilot', 'NovaPilot']);
  }, 120_000);

  it('--rollback after the newer version migrated the database restores the pre-update backup (after a YES), unchanged', async () => {
    const i = await install('0.6.0');
    packageZip(i.root, '0.6.1');
    expect(await runUpdateTool(['--yes'], deps(i, scripted([])))).toBe(0);
    // As 0.6.1 would: a migration (user_version up) and new data written with it.
    withDb(i.paths.db, (db) => {
      addAccount(db, { id: 'acc-late', username: 'LatePilot' });
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    });
    const plan = planRollback(i.paths);
    expect(plan).toMatchObject({ from: '0.6.1', to: '0.6.0', schemaNow: SCHEMA_VERSION + 1, refusal: null });
    expect(plan.restore).toMatch(/_pre-update-0\.6\.1\.vsbak$/);
    // Without the YES nothing changes.
    const no = scripted(['y', 'no']);
    expect(await runUpdateTool(['--rollback'], deps(i, no))).toBe(1);
    expect(no.text()).toContain(`changed the database (schema v${SCHEMA_VERSION} → v${SCHEMA_VERSION + 1})`);
    expect(versionOf(i.paths.app)).toBe('0.6.1');
    expect(userVersion(i.paths.db)).toBe(SCHEMA_VERSION + 1);
    const io = scripted(['y', 'YES']);
    expect(await runUpdateTool(['--rollback'], deps(i, io))).toBe(0);
    expect(versionOf(i.paths.app)).toBe('0.6.0');
    expect(userVersion(i.paths.db)).toBe(SCHEMA_VERSION);
    expect(names(i.paths.db)).toEqual(['NovaPilot']);
    expect(io.text()).toMatch(/back at 0\.6\.0, with the data from .*_pre-update-0\.6\.1\.vsbak/);
    // The data from just before the restore is kept (the restore's safety backup).
    // (Plus the rollback's own pre-update backup of the restored data, for going forward again.)
    expect(listBackups(i.paths.data).map((b) => b.cls).sort()).toEqual(['pre-restore', 'pre-update', 'pre-update']);
  }, 120_000);

  it('a running host blocks the update (and the rollback); nothing is changed and no backup is made', async () => {
    const i = await install('0.6.0');
    packageZip(i.root, '0.6.1');
    const key = openFileSecrets(i.paths.data).read('pipe.key');
    const host = await acquireLock({ dataDir: i.paths.data, key, handlers: { panelUrl: () => 'http://localhost:7778/' } });
    expect(host.ok).toBe(true);
    try {
      for (const args of [[], ['--rollback']]) {
        const io = scripted(['y']);
        expect(await runUpdateTool(args, deps(i, io))).toBe(1);
        expect(io.text()).toContain('Voidswarm is running on this data folder. Stop the host first');
        expect(io.asked).toEqual([]);
      }
      expect(versionOf(i.paths.app)).toBe('0.6.0');
      expect(fs.existsSync(i.paths.previous)).toBe(false);
      expect(fs.existsSync(path.join(i.paths.data, 'backups'))).toBe(false);
    } finally {
      if (host.ok) await host.lock.close();
    }
  }, 60_000);

  it('a zip that does not match its .sha256 is refused before anything happens', async () => {
    const i = await install('0.6.0');
    const zip = packageZip(i.root, '0.6.1');
    fs.writeFileSync(`${zip}.sha256`, `${'00'.repeat(32)}  ${path.basename(zip)}\r\n`);
    const io = scripted(['y']);
    expect(await runUpdateTool([], deps(i, io))).toBe(1);
    expect(io.text()).toContain('does NOT match');
    expect(io.asked).toEqual([]);
    expect(versionOf(i.paths.app)).toBe('0.6.0');
    expect(fs.existsSync(path.join(i.paths.data, 'backups'))).toBe(false);
  }, 60_000);

  it('a changed runtime waits in runtime.next\\ for the stub; runtime\\ itself is untouched', async () => {
    const i = await install('0.6.0');
    packageZip(i.root, '0.6.1', { node: 'MZ stand-in node.exe B (a Node security release)' });
    const io = scripted(['y']);
    expect(await runUpdateTool([], deps(i, io))).toBe(0);
    expect(io.text()).toContain('The Node.js runtime changes too');
    expect(read(path.join(i.root, RUNTIME_NEXT, 'node.exe'))).toContain('node.exe B');
    expect(read(i.paths.nodeExe)).toContain('node.exe A');
    expect(readUpdateInfo(i.paths)?.runtimeChanged).toBe(true);
    expect(updateLeftoverNotes(i.root).join()).toMatch(/not switched in yet/);
    // Until the stub has switched it, the tool says so and does nothing else.
    const wait = scripted([]);
    expect(await runUpdateTool(['--rollback'], deps(i, wait))).toBe(0);
    expect(wait.text()).toContain('waiting to be switched in');
    expect(versionOf(i.paths.app)).toBe('0.6.1');
  }, 60_000);

  it('a swap that fails half-way (app\\ held by another process) is undone: the old version stays, nothing is lost', async () => {
    const i = await install('0.6.0');
    packageZip(i.root, '0.6.1');
    // An earlier update's previous\ (it must come back too).
    fs.mkdirSync(path.join(i.paths.previous, 'app'), { recursive: true });
    fs.writeFileSync(path.join(i.paths.previous, 'app', 'build-info.json'), JSON.stringify({ version: '0.5.9' }));
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: i.paths.app, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((res) => setTimeout(res, 300));
      const io = scripted(['y']);
      expect(await runUpdateTool([], deps(i, io))).toBe(1);
      expect(io.text()).toMatch(/Replacing the files failed: .*Nothing was changed/);
    } finally {
      holder.kill();
    }
    expect(versionOf(i.paths.app)).toBe('0.6.0');
    expect(versionOf(path.join(i.paths.previous, 'app'))).toBe('0.5.9');
    expect(read(path.join(i.root, 'START HERE.html'))).toContain('for 0.6.0');
    expect(fs.existsSync(path.join(i.root, UPDATE_JOURNAL))).toBe(false);
    expect(fs.existsSync(path.join(i.root, UPDATE_STAGING))).toBe(false);
  }, 90_000);
});

describe('the update checks and refusals (injected extractor)', () => {
  it('an older zip is refused with the rollback hint; a zip whose build-info disagrees, a bad signature, extra top folders are refused', async () => {
    const i = await install('0.6.1');
    fs.writeFileSync(path.join(i.root, zipName('0.6.0')), 'old');
    const older = scripted(['y']);
    expect(await runUpdateTool([], deps(i, older))).toBe(1);
    expect(older.text()).toContain('is older (0.6.0) than the installed version (0.6.1)');
    expect(older.text()).toContain('--rollback');

    const zip = path.join(i.root, zipName('0.6.2'));
    fs.writeFileSync(zip, 'stand-in');
    const tryWith = async (parent: string, extra: Partial<UpdateToolDeps> = {}): Promise<string> => {
      const io = scripted(['y']);
      expect(await runUpdateTool(['--zip', zip], deps(i, io, { extract: copyFrom(parent), ...extra }))).toBe(1);
      expect(versionOf(i.paths.app)).toBe('0.6.1');
      expect(fs.existsSync(path.join(i.root, UPDATE_STAGING))).toBe(false);
      expect(fs.existsSync(path.join(i.paths.data, 'backups'))).toBe(false);
      return io.text();
    };
    expect(await tryWith(stagePackage('0.6.2', { buildVersion: '0.6.3' }))).toMatch(/says 0\.6\.2 but its app\\build-info\.json says 0\.6\.3/);
    expect(await tryWith(stagePackage('0.6.2'), { verifySignature: async () => ({ ok: false, status: 'NotSigned', subject: null }) }))
      .toMatch(/not the official Node\.js signed by the OpenJS Foundation \(NotSigned\)/);
    const two = stagePackage('0.6.2');
    fs.mkdirSync(path.join(two, 'Other'));
    expect(await tryWith(two)).toContain('The zip must hold one folder, "Voidswarm LAN"');
    expect(await tryWith(stagePackage('0.6.2', {}, (r) => fs.appendFileSync(path.join(r, 'web', 'index.html'), '<script src=x>')))).toMatch(/web\\index\.html does not match/);
  }, 60_000);

  it('with no zip it says where to put one; bad flags give the usage', async () => {
    const i = await install('0.6.0');
    const io = scripted([]);
    expect(await runUpdateTool([], deps(i, io))).toBe(1);
    expect(io.text()).toContain('No update zip was found');
    const bad = scripted([]);
    expect(await runUpdateTool(['--rollback', '--zip', 'x.zip'], deps(i, bad))).toBe(4);
    expect(await runUpdateTool(['--frobnicate'], deps(i, scripted([])))).toBe(4);
  });

  it('cancelling (N, or end of input) changes nothing', async () => {
    const i = await install('0.6.0');
    fs.writeFileSync(path.join(i.root, zipName('0.6.1')), 'stand-in');
    for (const answer of ['n', null]) {
      const io = scripted([answer]);
      expect(await runUpdateTool([], deps(i, io, { extract: copyFrom(stagePackage('0.6.1')) }))).toBe(1);
      expect(io.text()).toContain('Cancelled: nothing was changed.');
    }
    expect(versionOf(i.paths.app)).toBe('0.6.0');
  });

  it.runIf(process.platform === 'win32')('--rollback with nothing to go back to, or when the backup it needs is gone, refuses', async () => {
    const i = await install('0.6.0');
    expect(planRollback(i.paths).refusal).toMatch(/no previous version/);
    const r = await applyUpdate(i.paths, { file: path.join(i.root, zipName('0.6.1')), name: zipName('0.6.1'), version: '0.6.1' },
      { extract: copyFrom(stagePackage('0.6.1')), verifySignature: OK_SIG, statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    withDb(i.paths.db, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    for (const b of listBackups(i.paths.data)) fs.rmSync(b.file);
    const plan = planRollback(i.paths);
    expect(plan.refusal).toMatch(/the backup made before the update .* is gone/);
    const io = scripted(['y']);
    expect(await runUpdateTool(['--rollback'], deps(i, io))).toBe(1);
    expect(versionOf(i.paths.app)).toBe('0.6.1');
  });

  it('an interrupted swap (a crash after some moves) is undone at the next run', async () => {
    const i = await install('0.6.0');
    // Mid-update state: app\ already moved aside, the journal says one move is done.
    fs.mkdirSync(path.join(i.root, UPDATE_STAGING), { recursive: true });
    fs.renameSync(i.paths.app, path.join(i.root, UPDATE_STAGING, 'app-old'));
    fs.writeFileSync(path.join(i.root, UPDATE_JOURNAL), JSON.stringify({
      v: 1, kind: 'update', done: 1, complete: false, at: 1,
      ops: [{ op: 'move', from: 'app', to: path.join(UPDATE_STAGING, 'app-old') }, { op: 'move', from: 'web', to: 'web2' }],
    }));
    expect(updateLeftoverNotes(i.root).join()).toMatch(/interrupted/);
    expect(await recoverInterruptedUpdate(i.root)).toMatch(/interrupted update was undone/);
    expect(versionOf(i.paths.app)).toBe('0.6.0');
    expect(fs.existsSync(path.join(i.root, UPDATE_JOURNAL))).toBe(false);
    expect(fs.existsSync(path.join(i.root, UPDATE_STAGING))).toBe(false);
    expect(await recoverInterruptedUpdate(i.root)).toBeNull();
    // A journal naming paths outside the folder is never acted on.
    fs.writeFileSync(path.join(i.root, UPDATE_JOURNAL), JSON.stringify({ v: 1, kind: 'update', done: 1, complete: false, at: 1, ops: [{ op: 'move', from: '..\\..\\x', to: 'y' }] }));
    expect(await recoverInterruptedUpdate(i.root)).toMatch(/could not be read/);
  });
});

describe('T-LAN-17: a swap interrupted at any step comes back (crash recovery)', () => {
  const zipOf = (i: Install, v: string): UpdateZip => ({ file: path.join(i.root, zipName(v)), name: zipName(v), version: v });
  const upd = (i: Install, v: string, extra: Partial<UpdateDeps> = {}): Promise<unknown> =>
    applyUpdate(i.paths, zipOf(i, v), { extract: copyFrom(stagePackage(v)), verifySignature: OK_SIG, statfs: statfsFree(50 * GB), ...extra });
  /** 0.6.0 updated to 0.6.1: app\ is 0.6.1 and previous\ holds 0.6.0. */
  const twoVersions = async (): Promise<Install> => {
    const i = await install('0.6.0');
    expect(await upd(i, '0.6.1')).toMatchObject({ ok: true });
    return i;
  };
  const expectAt = (i: Install, now: string, prev: string): void => {
    expect(versionOf(i.paths.app)).toBe(now);
    expect(read(path.join(i.paths.web, 'index.html'))).toContain(`game ${now}`);
    for (const d of DOCS) expect(read(path.join(i.root, d)), d).toContain(`for ${now}`);
    expect(fs.existsSync(path.join(i.root, 'SHA256SUMS.txt'))).toBe(true);
    expect(versionOf(path.join(i.paths.previous, 'app'))).toBe(prev);
    expect(read(path.join(i.paths.previous, 'web', 'index.html'))).toContain(`game ${prev}`);
    for (const d of DOCS) expect(read(path.join(i.paths.previous, 'root', d)), d).toContain(`for ${prev}`);
    expect(fs.existsSync(path.join(i.root, UPDATE_JOURNAL))).toBe(false);
    expect(fs.existsSync(path.join(i.root, UPDATE_STAGING))).toBe(false);
    expect(fs.existsSync(path.join(i.root, RECOVER_TOOL))).toBe(false);
    expect(names(i.paths.db)).toEqual(['NovaPilot']);
  };
  const crashAt = (k: number, phase: 'moved' | 'journaled'): SwapProbe => (idx, ph) => {
    if (idx === k && ph === phase) throw new SimulatedCrash(`after op ${k} (${phase})`);
  };
  const opCount = async (run: (probe: SwapProbe) => Promise<unknown>): Promise<number> => {
    let n = 0;
    await run((idx) => { n = Math.max(n, idx + 1); });
    return n;
  };

  it('an update: a crash after any op, before or after its journal write, is undone to the version before', async () => {
    const n = await opCount(async (probe) => upd(await twoVersions(), '0.6.2', { swapProbe: probe }));
    expect(n).toBeGreaterThan(10);
    for (let k = 0; k < n; k++) {
      for (const phase of ['moved', 'journaled'] as const) {
        const i = await twoVersions();
        await expect(upd(i, '0.6.2', { swapProbe: crashAt(k, phase) })).rejects.toBeInstanceOf(SimulatedCrash);
        expect(fs.existsSync(path.join(i.root, UPDATE_JOURNAL)), `op ${k} ${phase}`).toBe(true);
        // The recovery copy is there for the whole swap (the Update stub runs it while app\ is out).
        expect(read(path.join(i.root, RECOVER_TOOL)), `op ${k} ${phase}`).toBe('// tool 0.6.1\n');
        expect(await recoverInterruptedUpdate(i.root), `op ${k} ${phase}`).toMatch(/interrupted update was undone/);
        expectAt(i, '0.6.1', '0.6.0');
        expect(await recoverInterruptedUpdate(i.root)).toBeNull();
        expect(updateLeftoverNotes(i.root)).toEqual([]);
        if (k === n - 1 && phase === 'journaled') {
          // And the tool is not locked out: the same update then goes through.
          expect(await upd(i, '0.6.2')).toMatchObject({ ok: true });
          expect(versionOf(i.paths.app)).toBe('0.6.2');
        }
      }
    }
  }, 600_000);

  it('a rollback: a crash after any op is undone to the version before it', async () => {
    const rb = (i: Install, probe: SwapProbe): Promise<unknown> => applyRollback(i.paths, planRollback(i.paths), { swapProbe: probe, statfs: statfsFree(50 * GB) });
    const n = await opCount(async (probe) => rb(await twoVersions(), probe));
    expect(n).toBeGreaterThan(10);
    for (let k = 0; k < n; k++) {
      for (const phase of ['moved', 'journaled'] as const) {
        const i = await twoVersions();
        await expect(rb(i, crashAt(k, phase))).rejects.toBeInstanceOf(SimulatedCrash);
        expect(read(path.join(i.root, RECOVER_TOOL)), `op ${k} ${phase}`).toBe('// tool 0.6.1\n');
        expect(await recoverInterruptedUpdate(i.root), `op ${k} ${phase}`).toMatch(/interrupted rollback was undone/);
        expectAt(i, '0.6.1', '0.6.0');
      }
    }
  }, 600_000);

  it('an undo that was itself cut short at any step, before or after its journal write, carries on and finishes; nothing is undone twice', async () => {
    const n = await opCount(async (probe) => upd(await twoVersions(), '0.6.2', { swapProbe: probe }));
    for (let m = n - 1; m >= 0; m--) {
      for (const phase of ['moved', 'journaled'] as const) {
        const i = await twoVersions();
        await expect(upd(i, '0.6.2', { swapProbe: crashAt(n - 1, 'journaled') })).rejects.toBeInstanceOf(SimulatedCrash);
        expect((JSON.parse(read(path.join(i.root, UPDATE_JOURNAL))) as { done: number }).done).toBe(n);
        // The first recovery dies after undoing op m (its rename done, its journal write maybe not).
        await expect(recoverInterruptedUpdate(i.root, { probe: crashAt(m, phase) })).rejects.toBeInstanceOf(SimulatedCrash);
        const mid = JSON.parse(read(path.join(i.root, UPDATE_JOURNAL))) as { done: number; undoing?: boolean };
        expect(mid).toMatchObject({ undoing: true, done: phase === 'journaled' ? m : m + 1 });
        expect(await recoverInterruptedUpdate(i.root), `undo op ${m} ${phase}`).toMatch(/interrupted update was undone/);
        expectAt(i, '0.6.1', '0.6.0');
      }
    }
  }, 600_000);

  it('a forward journal whose `done` is out of range is never acted on', async () => {
    const i = await twoVersions();
    fs.writeFileSync(path.join(i.root, UPDATE_JOURNAL), JSON.stringify({ v: 1, kind: 'update', done: 3, complete: false, at: 1, ops: [{ op: 'mkdir', path: 'x' }] }));
    expect(await recoverInterruptedUpdate(i.root)).toMatch(/could not be read/);
    fs.writeFileSync(path.join(i.root, UPDATE_JOURNAL), JSON.stringify({ v: 1, kind: 'update', done: 1, complete: false, at: 1, undoing: 'yes', ops: [{ op: 'mkdir', path: 'x' }] }));
    expect(await recoverInterruptedUpdate(i.root)).toMatch(/could not be read/);
  });

  it('a step that cannot be undone (both sides present) stops there, keeps the journal and says so', async () => {
    const i = await twoVersions();
    await expect(upd(i, '0.6.2', { swapProbe: crashAt(4, 'journaled') })).rejects.toBeInstanceOf(SimulatedCrash);
    const journal = JSON.parse(read(path.join(i.root, UPDATE_JOURNAL))) as { ops: { op: string; from?: string; to?: string }[] };
    const move = journal.ops.slice(0, 5).reverse().find((o) => o.op === 'move')!;
    fs.mkdirSync(path.join(i.root, move.from!), { recursive: true }); // something new where the old files go back
    expect(await recoverInterruptedUpdate(i.root)).toMatch(/could not be fully undone .*both .* exist.*carries on from this step/);
    expect(fs.existsSync(path.join(i.root, UPDATE_JOURNAL))).toBe(true);
    expect(updateLeftoverNotes(i.root).join()).toMatch(/interrupted/);
  }, 60_000);
});

describe.runIf(process.platform === 'win32')('T-LAN-17: an undo held up by a busy folder', () => {
  it('fails at that step, lowers the journal to it, and the next run finishes without re-undoing (no ENOENT)', async () => {
    const i = await install('0.6.0');
    const u = (v: string, extra: Partial<UpdateDeps> = {}): Promise<unknown> => applyUpdate(i.paths, { file: path.join(i.root, zipName(v)), name: zipName(v), version: v },
      { extract: copyFrom(stagePackage(v)), verifySignature: OK_SIG, statfs: statfsFree(50 * GB), ...extra });
    expect(await u('0.6.1')).toMatchObject({ ok: true });
    let n = 0;
    await u('0.6.2', { swapProbe: (idx) => { n = Math.max(n, idx + 1); } });
    // Back to two versions for the real case.
    const j = await install('0.6.0');
    const v = (ver: string, extra: Partial<UpdateDeps> = {}): Promise<unknown> => applyUpdate(j.paths, { file: path.join(j.root, zipName(ver)), name: zipName(ver), version: ver },
      { extract: copyFrom(stagePackage(ver)), verifySignature: OK_SIG, statfs: statfsFree(50 * GB), ...extra });
    expect(await v('0.6.1')).toMatchObject({ ok: true });
    await expect(v('0.6.2', { swapProbe: (idx, ph) => { if (idx === n - 1 && ph === 'journaled') throw new SimulatedCrash('late'); } })).rejects.toBeInstanceOf(SimulatedCrash);
    const before = JSON.parse(read(path.join(j.root, UPDATE_JOURNAL))) as { ops: { op: string; from: string; to: string }[]; done: number };
    const appOp = before.ops.findIndex((o) => o.op === 'move' && o.to === 'app');
    expect(appOp).toBeGreaterThan(0);
    // A process working in the new app\ (it has to move back out): its undo fails after the retries.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: j.paths.app, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((res) => setTimeout(res, 300));
      const first = await recoverInterruptedUpdate(j.root);
      expect(first).toMatch(/could not be fully undone/);
      expect(first).not.toMatch(/ENOENT/);
      const mid = JSON.parse(read(path.join(j.root, UPDATE_JOURNAL))) as { done: number };
      expect(mid.done).toBe(appOp + 1);
    } finally {
      holder.kill();
    }
    await new Promise((res) => setTimeout(res, 800));
    expect(await recoverInterruptedUpdate(j.root)).toMatch(/interrupted update was undone/);
    expect(versionOf(j.paths.app)).toBe('0.6.1');
    expect(versionOf(path.join(j.paths.previous, 'app'))).toBe('0.6.0');
    expect(read(path.join(j.paths.web, 'index.html'))).toContain('game 0.6.1');
    expect(fs.existsSync(path.join(j.root, UPDATE_JOURNAL))).toBe(false);
  }, 120_000);
});

describe('--rollback, forward and back again, keeps a backup for each direction', () => {
  it('the rollback that goes forward makes a pre-update backup, so a later migration can still be rolled back', async () => {
    const i = await install('0.6.0');
    const d = { verifySignature: OK_SIG, statfs: statfsFree(50 * GB) };
    const zip = { file: path.join(i.root, zipName('0.6.1')), name: zipName('0.6.1'), version: '0.6.1' };
    expect(await applyUpdate(i.paths, zip, { ...d, extract: copyFrom(stagePackage('0.6.1')) })).toMatchObject({ ok: true });
    const migrate = (): void => withDb(i.paths.db, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    migrate(); // 0.6.1 starts and migrates
    const back = planRollback(i.paths);
    expect(back.restore).toMatch(/_pre-update-0\.6\.1\.vsbak$/);
    expect(await applyRollback(i.paths, back, d)).toMatchObject({ ok: true, to: '0.6.0' });
    expect(userVersion(i.paths.db)).toBe(SCHEMA_VERSION);
    expect(readUpdateInfo(i.paths)?.backup).toMatch(/_pre-update-0\.6\.0\.vsbak$/);
    // Forward again: a backup of the data as 0.6.1 will first see it.
    const fwd = planRollback(i.paths);
    expect(fwd).toMatchObject({ to: '0.6.1', restore: null, refusal: null });
    expect(await applyRollback(i.paths, fwd, d)).toMatchObject({ ok: true, to: '0.6.1' });
    const info = readUpdateInfo(i.paths)!;
    expect(info).toMatchObject({ kind: 'rollback', from: '0.6.0', to: '0.6.1', schemaBefore: SCHEMA_VERSION });
    expect(info.backup).toMatch(/_pre-update-0\.6\.1(?:_\d+)?\.vsbak$/); // _2 when the same minute already has one
    expect(fs.existsSync(path.join(i.paths.data, 'backups', info.backup!))).toBe(true);
    withDb(i.paths.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    migrate(); // 0.6.1 migrates again at its start
    // The third --rollback is no longer refused: it restores that backup.
    const third = planRollback(i.paths);
    expect(third.refusal).toBeNull();
    expect(third.restore).toBe(info.backup);
    expect(await applyRollback(i.paths, third, d)).toMatchObject({ ok: true, to: '0.6.0', restored: info.backup });
    expect(userVersion(i.paths.db)).toBe(SCHEMA_VERSION);
    expect(names(i.paths.db)).toEqual(['NovaPilot']);
  }, 120_000);
});

describe('T-LAN-17: the swap keeps app\\ out for one rename at a time, and the tool undoes a crash before anything else', () => {
  const zipOf = (i: Install, v: string): UpdateZip => ({ file: path.join(i.root, zipName(v)), name: zipName(v), version: v });
  const upd = (i: Install, v: string, extra: Partial<UpdateDeps> = {}, o: TreeOpts = {}): Promise<unknown> =>
    applyUpdate(i.paths, zipOf(i, v), { extract: copyFrom(stagePackage(v, o)), verifySignature: OK_SIG, statfs: statfsFree(50 * GB), ...extra });
  const twoVersions = async (): Promise<Install> => {
    const i = await install('0.6.0');
    expect(await upd(i, '0.6.1')).toMatchObject({ ok: true });
    return i;
  };
  const crashAt = (k: number, phase: 'moved' | 'journaled'): SwapProbe => (idx, ph) => {
    if (idx === k && ph === phase) throw new SimulatedCrash(`after op ${k} (${phase})`);
  };
  const expectBack = (i: Install): void => {
    expect(versionOf(i.paths.app)).toBe('0.6.1');
    expect(versionOf(path.join(i.paths.previous, 'app'))).toBe('0.6.0');
    expect(read(path.join(i.paths.web, 'index.html'))).toContain('game 0.6.1');
    for (const d of DOCS) expect(read(path.join(i.root, d)), d).toContain('for 0.6.1');
    expect(read(i.paths.nodeExe)).toContain('node.exe A');
    for (const f of [UPDATE_JOURNAL, UPDATE_STAGING, RUNTIME_NEXT, RECOVER_TOOL]) expect(fs.existsSync(path.join(i.root, f)), f).toBe(false);
  };

  it('update and rollback: after every rename at most one of app\\, web\\ is out, never two renames running', async () => {
    const outRuns = (i: Install): SwapProbe & { max: () => number } => {
      let run = 0;
      let max = 0;
      const probe = ((_idx: number, ph: 'moved' | 'journaled') => {
        if (ph !== 'moved') return;
        const out = !fs.existsSync(path.join(i.paths.app, 'tool.mjs')) || !fs.existsSync(path.join(i.paths.web, 'index.html'));
        run = out ? run + 1 : 0;
        max = Math.max(max, run);
      }) as SwapProbe & { max: () => number };
      probe.max = () => max;
      return probe;
    };
    const i = await twoVersions();
    const p1 = outRuns(i);
    expect(await upd(i, '0.6.2', { swapProbe: p1 })).toMatchObject({ ok: true });
    expect(p1.max()).toBe(1);
    const p2 = outRuns(i);
    expect(await applyRollback(i.paths, planRollback(i.paths), { swapProbe: p2, statfs: statfsFree(50 * GB) })).toMatchObject({ ok: true, to: '0.6.1' });
    expect(p2.max()).toBe(1);
    expect(fs.existsSync(path.join(i.root, RECOVER_TOOL))).toBe(false);
  }, 60_000);

  it('no recovery copy, no swap: without app\\tool.mjs the update refuses before the backup and changes nothing', async () => {
    const i = await install('0.6.0');
    fs.rmSync(path.join(i.paths.app, 'tool.mjs'));
    const r = await upd(i, '0.6.1');
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/recovery copy of the tool \(update\.recover\.mjs\) could not be written .*Nothing was changed/) });
    expect(versionOf(i.paths.app)).toBe('0.6.0');
    expect(fs.existsSync(path.join(i.paths.data, 'backups'))).toBe(false);
    for (const f of [UPDATE_JOURNAL, UPDATE_STAGING, RECOVER_TOOL]) expect(fs.existsSync(path.join(i.root, f)), f).toBe(false);
  }, 60_000);

  it.runIf(process.platform === 'win32')('a crash with a new runtime on the way (runtime.next\\): the next tool run undoes it first, so update and rollback still work', async () => {
    const B: TreeOpts = { node: 'MZ stand-in node.exe B (a Node security release)' };
    let n = 0;
    await upd(await twoVersions(), '0.6.2', { swapProbe: (idx) => { n = Math.max(n, idx + 1); } }, B);
    expect(n).toBeGreaterThan(10);
    for (let k = 0; k < n; k++) {
      for (const phase of ['moved', 'journaled'] as const) {
        const i = await twoVersions();
        await expect(upd(i, '0.6.2', { swapProbe: crashAt(k, phase) }, B)).rejects.toBeInstanceOf(SimulatedCrash);
        if (k === n - 1) expect(read(path.join(i.root, RUNTIME_NEXT, 'node.exe'))).toContain('node.exe B');
        const io = scripted([]);
        expect(await runUpdateTool([], deps(i, io)), `op ${k} ${phase}`).toBe(1); // no zip left to install
        expect(io.text(), `op ${k} ${phase}`).toMatch(/interrupted update was undone/);
        expect(io.text()).not.toContain('waiting to be switched in');
        expectBack(i);
      }
    }
    // And after the worst case (the runtime op done, the journal not yet complete) the tool is not locked out.
    const i = await twoVersions();
    await expect(upd(i, '0.6.2', { swapProbe: crashAt(n - 1, 'journaled') }, B)).rejects.toBeInstanceOf(SimulatedCrash);
    fs.writeFileSync(path.join(i.root, zipName('0.6.2')), 'stand-in');
    const io = scripted([]);
    expect(await runUpdateTool(['--yes'], deps(i, io, { extract: copyFrom(stagePackage('0.6.2', B)) }))).toBe(0);
    expect(io.text()).toContain('Updated to Voidswarm LAN 0.6.2');
    expect(read(path.join(i.root, RUNTIME_NEXT, 'node.exe'))).toContain('node.exe B');
  }, 600_000);

  it.runIf(process.platform === 'win32')('a rollback taking a runtime back (previous\\runtime\\ → runtime.next\\), crashed at any op: the next run undoes it', async () => {
    const withOldRuntime = async (): Promise<Install> => {
      const i = await twoVersions();
      fs.mkdirSync(path.join(i.paths.previous, 'runtime'));
      fs.writeFileSync(path.join(i.paths.previous, 'runtime', 'node.exe'), 'MZ stand-in node.exe OLD');
      return i;
    };
    const rb = (i: Install, probe: SwapProbe): Promise<unknown> => applyRollback(i.paths, planRollback(i.paths), { swapProbe: probe, statfs: statfsFree(50 * GB) });
    let n = 0;
    await rb(await withOldRuntime(), (idx) => { n = Math.max(n, idx + 1); });
    for (let k = 0; k < n; k++) {
      const i = await withOldRuntime();
      await expect(rb(i, crashAt(k, 'moved'))).rejects.toBeInstanceOf(SimulatedCrash);
      const io = scripted([]);
      await runUpdateTool([], deps(i, io));
      expect(io.text(), `op ${k}`).toMatch(/interrupted rollback was undone/);
      expectBack(i);
      expect(read(path.join(i.paths.previous, 'runtime', 'node.exe'))).toContain('node.exe OLD');
    }
  }, 600_000);

  it.runIf(process.platform === 'win32')('the recovery copy (update.recover.mjs at the root) finds its root, only undoes, and says to run the update again', async () => {
    expect(toolRoot('C:\\Room 136 & Co\\Voidswarm LAN\\update.recover.mjs', 'win32')).toBe('C:\\Room 136 & Co\\Voidswarm LAN');
    expect(toolRoot('C:\\Room 136 & Co\\Voidswarm LAN\\UPDATE.RECOVER.MJS', 'win32')).toBe('C:\\Room 136 & Co\\Voidswarm LAN');
    expect(toolRoot('C:\\Room 136 & Co\\Voidswarm LAN\\app\\tool.mjs', 'win32')).toBe('C:\\Room 136 & Co\\Voidswarm LAN');
    const i = await twoVersions();
    let appOut = -1;
    await expect(upd(i, '0.6.2', {
      swapProbe: (idx, ph) => {
        if (ph === 'moved' && !fs.existsSync(i.paths.app)) { appOut = idx; throw new SimulatedCrash('app out'); }
      },
    })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(appOut).toBeGreaterThan(0);
    expect(fs.existsSync(i.paths.app)).toBe(false);
    const io = scripted([]);
    // No deps.root: the root comes from the copy's own path.
    expect(await runUpdateTool([], { io, toolFile: path.join(i.root, RECOVER_TOOL), verifySignature: OK_SIG, statfs: statfsFree(50 * GB) })).toBe(0);
    expect(io.text()).toMatch(/interrupted update was undone[\s\S]*Run Update Voidswarm\.cmd again to install the update/);
    expectBack(i);
    // With nothing to undo it says so and changes nothing.
    fs.copyFileSync(path.join(i.paths.app, 'tool.mjs'), path.join(i.root, RECOVER_TOOL));
    const idle = scripted([]);
    expect(await runUpdateTool([], { io: idle, toolFile: path.join(i.root, RECOVER_TOOL) })).toBe(0);
    expect(idle.text()).toContain('There was no interrupted update to finish.');
    // The dispatcher: the copy runs `update` only.
    const other = scripted([]);
    expect(await runTool(['restore'], { io: other, toolFile: path.join(i.root, RECOVER_TOOL) })).toBe(4);
    expect(other.text()).toContain('only finishes an interrupted update');
  }, 60_000);
});

describe.runIf(process.platform === 'win32' && !process.env.VOIDSWARM_SKIP_PACKAGE_E2E)('T-LAN-17 through the real Update stub (bundled tool.mjs, real cmd.exe and node.exe)', () => {
  let bundle: Buffer = Buffer.alloc(0);
  let nodeCache = '';
  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-toolbundle-'));
    try {
      await esbuild.build(appBuildOptions(out, { entryPoints: { tool: 'src/lan/tool.ts' } }));
      bundle = fs.readFileSync(path.join(out, 'tool.mjs'));
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
    nodeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-nodecache-'));
    fs.copyFileSync(process.execPath, path.join(nodeCache, 'node.exe'));
  }, 180_000);
  afterAll(() => { if (nodeCache) fs.rmSync(nodeCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });


  const zipOf = (i: Install, v: string): UpdateZip => ({ file: path.join(i.root, zipName(v)), name: zipName(v), version: v });
  const upd = (i: Install, v: string, extra: Partial<UpdateDeps> = {}): Promise<unknown> =>
    applyUpdate(i.paths, zipOf(i, v), { extract: copyFrom(stagePackage(v, { tool: bundle })), verifySignature: OK_SIG, statfs: statfsFree(50 * GB), ...extra });
  /** 0.6.0 → 0.6.1 with the real tool in every version and a real node.exe (so the package's stand-in one is a new runtime). */
  const twoVersions = async (): Promise<Install> => {
    const i = await install('0.6.0', { tool: bundle });
    fs.rmSync(i.paths.nodeExe);
    try { fs.linkSync(path.join(nodeCache, 'node.exe'), i.paths.nodeExe); } catch { fs.copyFileSync(path.join(nodeCache, 'node.exe'), i.paths.nodeExe); }
    expect(await upd(i, '0.6.1')).toMatchObject({ ok: true, runtimeChanged: true });
    fs.rmSync(path.join(i.root, RUNTIME_NEXT), { recursive: true, force: true }); // not switched: keep the real node
    return i;
  };
  const stub = (i: Install, args = ''): { code: number | null; out: string } => {
    const r = spawnSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${path.join(i.root, 'Update Voidswarm.cmd')}"${args ? ` ${args}` : ''}"`], {
      cwd: os.tmpdir(), windowsVerbatimArguments: true, windowsHide: true, input: '', encoding: 'utf8', timeout: 120_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const expectBack = (i: Install, where: string): void => {
    expect(versionOf(i.paths.app), where).toBe('0.6.1');
    expect(versionOf(path.join(i.paths.previous, 'app')), where).toBe('0.6.0');
    expect(read(path.join(i.paths.web, 'index.html')), where).toContain('game 0.6.1');
    for (const d of DOCS) expect(read(path.join(i.root, d)), `${where} ${d}`).toContain('for 0.6.1');
    expect(fs.statSync(i.paths.nodeExe).size, where).toBe(fs.statSync(process.execPath).size);
    for (const f of [UPDATE_JOURNAL, UPDATE_STAGING, RUNTIME_NEXT, RECOVER_TOOL]) expect(fs.existsSync(path.join(i.root, f)), `${where} ${f}`).toBe(false);
    expect(names(i.paths.db)).toEqual(['NovaPilot']);
  };
  const check = (i: Install, where: string, appWasOut: boolean): void => {
    const r = stub(i);
    expect(r.out, where).toMatch(/interrupted (update|rollback) was undone/);
    expect(r.out, where).not.toContain('Unzip the WHOLE folder');
    expect(r.out, where).not.toContain('runtime was switched');
    if (appWasOut) {
      expect(r.code, where).toBe(0);
      expect(r.out, where).toContain('Run Update Voidswarm.cmd again');
    }
    expectBack(i, where);
  };

  it('an update (new runtime included) crashed after any op, before or after its journal write, comes back when the stub runs', async () => {
    let n = 0;
    await upd(await twoVersions(), '0.6.2', { swapProbe: (idx) => { n = Math.max(n, idx + 1); } });
    expect(n).toBeGreaterThan(10);
    let outCases = 0;
    for (let k = 0; k < n; k++) {
      for (const phase of ['moved', 'journaled'] as const) {
        const i = await twoVersions();
        let appOut = false;
        await expect(upd(i, '0.6.2', {
          swapProbe: (idx, ph) => { if (idx === k && ph === phase) { appOut = !fs.existsSync(i.paths.app); throw new SimulatedCrash(`op ${k}`); } },
        })).rejects.toBeInstanceOf(SimulatedCrash);
        check(i, `update op ${k} ${phase}${appOut ? ' (app out)' : ''}`, appOut);
        if (appOut) outCases++;
      }
    }
    expect(outCases).toBe(2); // the crash right after "app → previous\app", before and after its journal write
  }, 900_000);

  it('a rollback (runtime included) crashed after any op comes back when the stub runs', async () => {
    const withOldRuntime = async (): Promise<Install> => {
      const i = await twoVersions();
      fs.mkdirSync(path.join(i.paths.previous, 'runtime'));
      fs.writeFileSync(path.join(i.paths.previous, 'runtime', 'node.exe'), 'MZ stand-in node.exe OLD');
      return i;
    };
    const rb = (i: Install, probe: SwapProbe): Promise<unknown> => applyRollback(i.paths, planRollback(i.paths), { swapProbe: probe, statfs: statfsFree(50 * GB) });
    let n = 0;
    await rb(await withOldRuntime(), (idx) => { n = Math.max(n, idx + 1); });
    let outCases = 0;
    for (let k = 0; k < n; k++) {
      const i = await withOldRuntime();
      let appOut = false;
      await expect(rb(i, (idx, ph) => { if (idx === k && ph === 'moved') { appOut = !fs.existsSync(i.paths.app); throw new SimulatedCrash(`op ${k}`); } })).rejects.toBeInstanceOf(SimulatedCrash);
      check(i, `rollback op ${k}${appOut ? ' (app out)' : ''}`, appOut);
      if (appOut) outCases++;
      expect(read(path.join(i.paths.previous, 'runtime', 'node.exe'))).toContain('node.exe OLD');
    }
    expect(outCases).toBe(1);
  }, 900_000);
});
