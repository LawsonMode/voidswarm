// LAN task B11: app\tool.mjs, the maintenance program behind the .cmd stubs (docs/LAN-EDITION-proposal.md §2.1, §4.10,
// §11.2): Reset admin password.cmd (admin-reset), admin-set, backup, fix-permissions and the moderation CLI on this
// copy's data. Test data only: generated names and long random passwords.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore } from '../server/auth/store';
import { listBackups } from '../server/maint';
import { statfsFree } from '../server/maint/testutil';
import { hostAdminState, setHostAdminCredential, setupCodeHash } from '../server/moderation/hostAdmin';
import { openFileSecrets } from '../server/secrets';
import { SettingsService } from '../server/settings';
import type { AclReport } from './acl';
import { LAN_FOLDER_NAME, lanPaths, type LanPaths } from './paths';
import { acquireLock, type SendOptions } from './pipe';
import type { ToolIo } from './restore';
import { isToolEntry, runTool, takeDataFlag, TOOL_USAGE, type ToolDeps } from './tool';

const GB = 1024 ** 3;
const scratch: string[] = [];
afterEach(() => { while (scratch.length) { try { fs.rmSync(scratch.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* held */ } } });

const ADMIN = `host_${randomBytes(3).toString('hex')}`;
const PASSWORD = randomBytes(18).toString('base64url');

interface Install { root: string; paths: LanPaths }

async function install(opts: { admin?: boolean } = {}): Promise<Install> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-tool-'));
  scratch.push(base);
  const root = path.join(base, LAN_FOLDER_NAME);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'build-info.json'), JSON.stringify({ version: '0.6.0', node: process.version }));
  const paths = lanPaths(root);
  fs.mkdirSync(paths.data);
  const secrets = openFileSecrets(paths.data);
  for (const k of ['backup.key', 'pepper.key', 'pipe.key'] as const) secrets.ensureKey(k);
  const settings = SettingsService.open({ dataDir: paths.data, env: {}, lan: true, secrets, log: () => undefined });
  await settings.apply({ serverName: 'Room 136' });
  new AuthStore(paths.db).close();
  if (opts.admin !== false) {
    const db = new DatabaseSync(paths.db);
    try { await setHostAdminCredential(db, { username: ADMIN, password: PASSWORD, serverName: 'Room 136' }); } finally { db.close(); }
  }
  return { root, paths };
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

const withDb = <T>(file: string, fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
};

const notRunning = async (): Promise<{ ok: false; error: 'not-running' }> => ({ ok: false, error: 'not-running' });

describe('the dispatcher', () => {
  it('help prints the commands (exit 0); no command prints them and exits 4', async () => {
    const io = scripted([]);
    expect(await runTool(['help'], { io })).toBe(0);
    for (const c of ['update', 'restore', 'admin-reset', 'admin-set', 'backup', 'fix-permissions', 'promote <username>', 'purge-log']) expect(io.text()).toContain(c);
    expect(io.text()).not.toContain('npm run mod');
    expect(await runTool([], { io: scripted([]) })).toBe(4);
    expect(TOOL_USAGE).toContain('tool ');
  });

  it('--data is taken by every command', () => {
    expect(takeDataFlag(['--yes', '--data', 'x y'], 'C:\\base')).toEqual({ data: path.resolve('C:\\base', 'x y'), rest: ['--yes'] });
    expect(takeDataFlag(['--data=d'], '/b')).toEqual({ data: path.resolve('/b', 'd'), rest: [] });
    expect(takeDataFlag(['--data'])).toEqual({ error: '--data needs a folder.' });
  });

  it('is the program only as app\\tool.mjs (or tool.ts), never when another bundle includes it', () => {
    const f = path.join(os.tmpdir(), 'Voidswarm LAN', 'app', 'tool.mjs');
    expect(isToolEntry(pathToFileURL(f).href, f)).toBe(true);
    expect(isToolEntry(pathToFileURL(f).href, path.join(path.dirname(f), 'launch.mjs'))).toBe(false);
    expect(isToolEntry(pathToFileURL(path.join(path.dirname(f), 'server.mjs')).href, f)).toBe(false);
    expect(isToolEntry(pathToFileURL(f).href, undefined)).toBe(false);
  });

  it('other commands go to the moderation CLI on this copy\'s database', async () => {
    const i = await install();
    withDb(i.paths.db, (db) => db.prepare("INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at) VALUES ('a1', 'NovaPilot', 'novapilot', 'nova@example.org', 'nova@example.org', 'x', 1)").run());
    const io = scripted([]);
    expect(await runTool(['promote', 'NovaPilot'], { root: i.root, io })).toBe(0);
    const list = scripted([]);
    expect(await runTool(['admins'], { root: i.root, io: list })).toBe(0);
    expect(list.text()).toContain('NovaPilot');
    const bad = scripted([]);
    expect(await runTool(['frobnicate'], { root: i.root, io: bad })).toBe(1);
    expect(bad.text()).toContain('Unknown command "frobnicate"');
  });
});

describe('admin-reset (Reset admin password.cmd, §4.10)', () => {
  it('clears the password, revokes the sessions, prints a working setup code, and audits it; the account row stays', async () => {
    const i = await install();
    withDb(i.paths.db, (db) => db.prepare("INSERT INTO admin_sessions (token_hash, principal, created_at, last_seen, last_action, reauth_at, expires_at, via) VALUES ('t1', ?, 1, 1, 1, 1, 9e15, 'local')").run(`host:${ADMIN}`));
    const sent: SendOptions[] = [];
    const io = scripted(['y']);
    const code = await runTool(['admin-reset'], { root: i.root, io, send: async (o) => { sent.push(o); return notRunning(); } });
    expect(code).toBe(0);
    expect(io.asked).toEqual(['Reset it? [y/N]: ']);
    const m = /New setup code: ([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})/.exec(io.text());
    expect(m).not.toBeNull();
    expect(io.text()).toContain('1 admin session(s) were signed out.');
    expect(io.text()).toMatch(/Start Voidswarm Host\.cmd, then type the setup code in the Host Control Panel \(http:\/\/localhost:\d+\/\)/);
    const pepper = openFileSecrets(i.paths.data).read('pepper.key');
    withDb(i.paths.db, (db) => {
      expect(hostAdminState(db)).toEqual({ setupPending: true, setupKind: 'reset', username: ADMIN });
      expect(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 0 });
      const hashes = (db.prepare('SELECT code_hash FROM host_setup').all() as { code_hash: string }[]).map((r) => r.code_hash);
      expect(hashes).toContain(setupCodeHash(`${m![1]}${m![2]}`, pepper));
      expect(db.prepare("SELECT actor_name, target_name FROM mod_actions WHERE action = 'admin-reset'").all()).toEqual([{ actor_name: 'cli', target_name: ADMIN }]);
    });
    // It told a running host (none here) with the pipe key.
    expect(sent.map((s) => s.cmd)).toEqual(['reload-admin']);
    expect(sent[0]!.key?.equals(openFileSecrets(i.paths.data).read('pipe.key')!)).toBe(true);
  });

  it('a running host is told over the pipe (reload-admin) and its panel address is printed', async () => {
    const i = await install();
    let reloaded = 0;
    const key = openFileSecrets(i.paths.data).read('pipe.key');
    const host = await acquireLock({ dataDir: i.paths.data, key, handlers: { panelUrl: () => 'http://localhost:17778/', reloadAdmin: () => { reloaded++; } } });
    expect(host.ok).toBe(true);
    try {
      const io = scripted([]);
      expect(await runTool(['admin-reset', '--yes'], { root: i.root, io })).toBe(0);
      expect(reloaded).toBe(1);
      expect(io.text()).toContain('Open the Host Control Panel (http://localhost:17778/) on this PC and type the setup code');
    } finally {
      if (host.ok) await host.lock.close();
    }
  });

  it('N (or end of input) changes nothing; no data yet says to start the host', async () => {
    const i = await install();
    for (const a of ['n', null]) {
      const io = scripted([a]);
      expect(await runTool(['admin-reset'], { root: i.root, io, send: notRunning })).toBe(1);
      expect(io.text()).toContain('Cancelled: nothing was changed.');
    }
    withDb(i.paths.db, (db) => expect(hostAdminState(db).setupPending).toBe(false));
    const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-tool-empty-')), LAN_FOLDER_NAME);
    scratch.push(path.dirname(fresh));
    const io = scripted([]);
    expect(await runTool(['admin-reset'], { root: fresh, io, send: notRunning })).toBe(1);
    expect(io.text()).toContain('has not been set up yet');
  });
});

describe('admin-set, backup, fix-permissions', () => {
  it('admin-set --password-stdin creates the login; a password that breaks the rules is refused', async () => {
    const i = await install({ admin: false });
    const deps = (pw: string): ToolDeps => ({ root: i.root, io: scripted([]), stdin: Readable.from([`${pw}\n`]), send: notRunning });
    const d1 = deps(PASSWORD);
    expect(await runTool(['admin-set', ADMIN, '--password-stdin'], d1)).toBe(0);
    expect((d1.io as ReturnType<typeof scripted>).text()).toContain(`Created the host admin login "${ADMIN}".`);
    withDb(i.paths.db, (db) => expect(hostAdminState(db)).toEqual({ setupPending: false, setupKind: null, username: ADMIN }));
    const d2 = deps('short');
    expect(await runTool(['admin-set', ADMIN, '--password-stdin'], d2)).toBe(1);
    expect(await runTool(['admin-set'], deps(PASSWORD))).toBe(4);
  });

  it('admin-set asks twice (hidden) and refuses two different passwords', async () => {
    const i = await install({ admin: false });
    const io = scripted([PASSWORD, `${PASSWORD}x`]);
    expect(await runTool(['admin-set', ADMIN], { root: i.root, io, send: notRunning })).toBe(1);
    expect(io.text()).toContain('The two passwords differ');
    const ok = scripted([PASSWORD, PASSWORD]);
    expect(await runTool(['admin-set', ADMIN], { root: i.root, io: ok, send: notRunning })).toBe(0);
  });

  it('backup makes an encrypted manual backup (also with --data)', async () => {
    const i = await install();
    const io = scripted([]);
    expect(await runTool(['backup'], { root: i.root, io, statfs: statfsFree(50 * GB) })).toBe(0);
    expect(io.text()).toMatch(/Backed up to data\\backups\\\d{4}-\d{2}-\d{2}_\d{4}_manual\.vsbak/);
    expect(listBackups(i.paths.data).map((b) => b.cls)).toEqual(['manual']);
    const other = await install();
    expect(await runTool(['backup', '--data', other.paths.data], { root: i.root, io: scripted([]), statfs: statfsFree(50 * GB) })).toBe(0);
    expect(listBackups(other.paths.data)).toHaveLength(1);
  });

  it('fix-permissions runs the §2.2 fix for this user and this copy\'s preset', async () => {
    const i = await install();
    const seen: unknown[] = [];
    const report = { ok: true, problems: [], errors: [], notes: [], checked: [], scanned: 1, decision: 'ok', message: null, banner: null, fixCommand: null } as AclReport;
    const io = scripted([]);
    expect(await runTool(['fix-permissions'], {
      root: i.root, io, userSid: async () => 'S-1-5-21-1-2-3-1001',
      fixPermissions: async (o) => { seen.push(o); return { report, ran: [], errors: [] }; },
    })).toBe(0);
    expect(seen).toEqual([expect.objectContaining({ root: i.paths.root, dataDir: i.paths.data, userSid: 'S-1-5-21-1-2-3-1001', preset: 'home', checkOwners: true })]);
    expect(io.text()).toContain('The permissions are fixed.');
    const none = scripted([]);
    expect(await runTool(['fix-permissions'], { root: i.root, io: none, userSid: async () => null })).toBe(1);
  });
});
