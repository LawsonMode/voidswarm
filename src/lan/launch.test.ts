import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AclReport } from './acl';
import { formatSetupCode } from './banner';
import { LAUNCHER_ACTOR, SettingsService } from '../server/settings';
import {
  LAUNCH_EXIT, SETUP_CODE_ALPHABET, findImportCandidates, findPrimaryAddress, isEntry, isRfc1918, launch, movedRefusal, newSetupCode,
  openInBrowser, parseLaunchArgs, readSetupState, vpsSettingsRefusal, type LaunchDeps,
} from './launch';
import { DatabaseSync } from 'node:sqlite';
import type { MotwReport } from './motw';
import type { ExecFn } from './paths';
import { ALREADY_RUNNING_MESSAGE, acquireLock, sendCommand } from './pipe';
import { choosePorts, probePort } from './ports';
import type { PreflightReport } from './preflight';
import type { TokenInfo } from './elevation';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-b4b-launch-'));
afterAll(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ } });
let seq = 0;
const makeRoot = (): { root: string; app: string; data: string } => {
  const root = path.join(tmpRoot, `t${seq++}`, "Room 136 (Mr. O'Brien) & Co", 'Voidswarm LAN');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  return { root, app: path.join(root, 'app'), data: path.join(root, 'data') };
};

/**
 * A free pair P, P+1 (never 7777, 7778, 5173 or 5621), checked the way choosePorts checks (connect to 127.0.0.1 and
 * ::1, then an exclusive bind): an admin port held elsewhere (Steam holds 0.0.0.0:27036) would make the launcher move
 * to the next pair, and the test would look at the wrong port.
 */
async function freeBase(): Promise<number> {
  for (;;) {
    const p = 21000 + Math.floor(Math.random() * 17000);
    if ([7777, 7778, 5173, 5621].some((r) => r >= p && r <= p + 1)) continue;
    const [a, b] = await Promise.all([probePort(p), probePort(p + 1)]);
    if (!a.busy && !b.busy) return p;
  }
}

interface FakeMode {
  crashAfterReadyTimes?: number; crashDelay?: number; exitBeforeReady?: number; setupPending?: boolean;
  /** Sent as a {type:'notice'} right after 'ready'. */
  notice?: string;
  /** Exit 0 right after lan:start, before 'ready'. */
  exitZeroBeforeReady?: boolean;
  /** Sent with setupPending. */
  setupKind?: 'first' | 'reset';
  /**
   * First-run setup in the browser: pending until `doneAfter` ms after the first 'ready' (then for good: a marker file
   * in data\), told by {type:'setup-done'} ('message') or only by the status reply ('status').
   */
  setupFlow?: { doneAfter: number; via: 'message' | 'status' };
  /** These starts (1-based) crash 300 ms after 'ready'. */
  crashStarts?: number[];
  /** Sent right after 'ready' on the first start. */
  sendAfterReady?: Record<string, unknown>[];
  /** A confused child: reports setup pending at every start, and 'setup-done' whenever it is on loopback. */
  doneOnLoopback?: boolean;
}
function fakeServer(appDir: string, mode: FakeMode = {}): void {
  fs.writeFileSync(path.join(appDir, 'server.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const MODE = ${JSON.stringify(mode)};
let dataDir = '.';
const setupDone = () => fs.existsSync(path.join(dataDir, 'fake-setup-done'));
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'lan:start') {
    dataDir = m.dataDir;
    const f = path.join(m.dataDir, 'fake-starts.jsonl');
    fs.appendFileSync(f, JSON.stringify({ envKeys: Object.keys(process.env), argv: process.argv, start: m }) + '\\n');
    const count = fs.readFileSync(f, 'utf8').trim().split('\\n').length;
    if (MODE.exitBeforeReady) {
      process.send({ type: 'fatal', code: 'EDB', exitCode: MODE.exitBeforeReady, message: 'Voidswarm could not open its database (fake).' });
      setTimeout(() => process.exit(MODE.exitBeforeReady), 30);
      return;
    }
    if (MODE.exitZeroBeforeReady) { setTimeout(() => process.exit(0), 30); return; }
    const pending = MODE.setupFlow ? !setupDone() : MODE.setupPending;
    process.send({ type: 'ready', port: m.port, bind: m.bind, version: 'fake',
      ...(pending !== undefined ? { setupPending: pending } : {}), ...(MODE.setupKind ? { setupKind: MODE.setupKind } : {}) });
    if (MODE.notice) process.send({ type: 'notice', text: MODE.notice });
    if (count === 1) for (const x of MODE.sendAfterReady ?? []) process.send(x);
    if (MODE.doneOnLoopback && m.bind === '127.0.0.1') setTimeout(() => process.send({ type: 'setup-done' }), 50);
    if (MODE.setupFlow && pending) {
      setTimeout(() => {
        fs.writeFileSync(path.join(dataDir, 'fake-setup-done'), '1');
        if (MODE.setupFlow.via === 'message') process.send({ type: 'setup-done' });
      }, MODE.setupFlow.doneAfter);
    }
    if (MODE.crashAfterReadyTimes && count <= MODE.crashAfterReadyTimes) setTimeout(() => process.exit(1), MODE.crashDelay ?? 40);
    if (MODE.crashStarts && MODE.crashStarts.includes(count)) setTimeout(() => process.exit(1), 300);
  } else if (m.type === 'stop') setTimeout(() => process.exit(0), 20);
  else if (m.type === 'status') {
    process.send({ type: 'status', online: 2, rooms: 5, ...(MODE.setupFlow && MODE.setupFlow.via === 'status' ? { setupPending: !setupDone() } : {}) });
  } else fs.appendFileSync(path.join(dataDir, 'fake-got.jsonl'), JSON.stringify(m) + '\\n');
});
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);
`);
}
const starts = (data: string): { envKeys: string[]; argv: string[]; start: Record<string, any> }[] => {
  const f = path.join(data, 'fake-starts.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

const okAcl: AclReport = { ok: true, problems: [], errors: [], notes: [], checked: [], scanned: 1, decision: 'ok', message: null, banner: null, fixCommand: null };
const noMotw: MotwReport = { files: [], scanned: 0, truncated: false, wholeFolder: false, message: null };
const medium: TokenInfo = { userSid: 'S-1-5-21-1-2-3-1001', userName: 'PC\\novapilot', integrity: 'medium', integritySid: 'S-1-16-8192', groups: [] };
const high: TokenInfo = { ...medium, integrity: 'high', integritySid: 'S-1-16-12288' };
const report = (primary: string | null, category = 'Private'): PreflightReport => ({
  v: 1, at: Date.now(), reason: 'manual', version: 'test', platform: process.platform, nodeExe: process.execPath, primary,
  network: { profiles: [{ alias: 'Ethernet', index: 1, name: 'Home', category, ipv4: primary ? [primary] : [] }] },
  firewall: null, power: null, disk: { path: 'C:\\', freeBytes: 50e9, totalBytes: 100e9 },
});

function harness(root: string, port: number, over: Partial<LaunchDeps> = {}) {
  const out: string[] = [];
  const titles: string[] = [];
  const opened: string[] = [];
  const deps: LaunchDeps = {
    root,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(port), SMTP_PASS: 'not-for-the-child-77' },
    out: { write: (s) => { out.push(s); }, setTitle: (t) => { titles.push(t); } },
    openBrowser: async (u) => { opened.push(u); },
    checkLocation: async () => ({ ok: true, problems: [], warnings: [], suggestion: '', message: null }),
    readToken: async () => medium,
    checkPermissions: async () => okAcl,
    protectDir: async () => null,
    scanMotw: () => noMotw,
    preflight: async (o) => ({ report: report(o.primary ?? null) }),
    primary: () => '192.168.1.50',
    // The real pair choice, but never connect-probing a LAN address from a test.
    choosePorts: (o) => choosePorts({ ...o, primary: null }),
    // The fake child keeps no database, so on a later run the launcher can't tell (null): the child's 'ready' decides.
    // The tests of readSetupState itself set this.
    setupState: () => null,
    processHandlers: false,
    titleIntervalMs: 100,
    ...over,
  };
  return { deps, out, titles, opened, text: () => out.join('') };
}

describe('pure helpers', () => {
  it('flags', () => {
    expect(parseLaunchArgs([], 'C:\\x')).toEqual({ noBrowser: false, data: null, fixPermissions: false, skipLocationCheck: false });
    expect(parseLaunchArgs(['--child', '--no-browser', '--fix-permissions', '--data', 'd2'], process.cwd())).toMatchObject({ noBrowser: true, fixPermissions: true, data: path.resolve('d2') });
    expect(parseLaunchArgs(['--data=d3'], process.cwd())).toMatchObject({ data: path.resolve('d3') });
    expect(parseLaunchArgs(['--this-pc-only'], process.cwd())).toMatchObject({ thisPcOnly: true });
    expect(parseLaunchArgs(['--data'])).toEqual({ error: '--data needs a folder.' });
    expect(parseLaunchArgs(['--yes'])).toEqual({ error: 'Unknown option: --yes' });
  });

  it('the setup code is 8 Crockford base32 characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newSetupCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
    expect(SETUP_CODE_ALPHABET).toHaveLength(32);
  });

  it('refuses the VPS kit\'s settings', () => {
    expect(vpsSettingsRefusal({})).toBeNull();
    expect(vpsSettingsRefusal({ TRUST_PROXY: '1' })).toMatch(/TRUST_PROXY.*VPS kit/);
    expect(vpsSettingsRefusal({ TRUST_PROXY: '0' })).toBeNull();
    expect(vpsSettingsRefusal({ PUBLIC_URL: 'https://voidswarm.example.com' })).toMatch(/PUBLIC_URL.*VPS kit/);
    expect(vpsSettingsRefusal({ PUBLIC_URL: 'http://192.168.1.50:7777' })).toBeNull();
    expect(vpsSettingsRefusal({ PUBLIC_URL: 'http://room136-pc.local:7777' })).toBeNull();
  });

  it('moved data refuses with where and when', () => {
    const d = makeRoot().root;
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'MOVED-TO.json');
    expect(movedRefusal(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ movedTo: 'C:\\Users\\novapilot\\Voidswarm LAN', at: new Date(2026, 9, 3).toISOString() }));
    expect(movedRefusal(f)).toBe('This data was moved to C:\\Users\\novapilot\\Voidswarm LAN on Oct 3 — start that copy.');
    fs.writeFileSync(f, 'garbage');
    expect(movedRefusal(f)).toMatch(/moved to another copy of Voidswarm — start that copy/);
  });

  it('the primary address: RFC 1918 on a real adapter, never 100.64/10, 169.254/16, loopback or a virtual switch', () => {
    expect(isRfc1918('192.168.1.50') && isRfc1918('10.20.31.77') && isRfc1918('172.16.0.1')).toBe(true);
    expect(isRfc1918('100.64.1.2') || isRfc1918('169.254.3.4') || isRfc1918('127.0.0.1') || isRfc1918('172.32.0.1')).toBe(false);
    const a = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
    expect(findPrimaryAddress({
      'vEthernet (WSL)': [a('172.20.0.1')], Tailscale: [a('100.101.1.2')], 'Loopback Pseudo-Interface 1': [a('127.0.0.1', true)],
      'Ethernet 2': [a('172.17.5.5')], 'Wi-Fi': [a('192.168.1.50')],
    })).toBe('192.168.1.50');
    expect(findPrimaryAddress({ Ethernet: [a('169.254.1.1')] })).toBeNull();
  });

  it('readSetupState: the host admin row in data\\voidswarm.db, read-only (no database or no table = first; unreadable = null)', () => {
    const d = path.join(tmpRoot, `setup-${seq++}`);
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, 'voidswarm.db');
    expect(readSetupState(file)).toBe('first');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY)');
    db.close();
    expect(readSetupState(file)).toBe('first'); // a pre-LAN database: the child adds the table, empty
    const db2 = new DatabaseSync(file);
    db2.exec('CREATE TABLE host_admins (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, pass_hash TEXT, created_at INTEGER NOT NULL)');
    db2.close();
    expect(readSetupState(file)).toBe('first');
    const fake = `scrypt$16384$8$1$${Buffer.alloc(16, 3).toString('base64')}$${Buffer.alloc(32, 9).toString('base64')}`; // shape only
    const db3 = new DatabaseSync(file);
    db3.prepare('INSERT INTO host_admins VALUES (?, ?, ?, ?, ?)').run('a1', 'HostAdmin', 'hostadmin', null, 1);
    db3.close();
    expect(readSetupState(file)).toBe('reset'); // a reset leaves the hash NULL
    const db4 = new DatabaseSync(file);
    db4.prepare('UPDATE host_admins SET pass_hash = ?').run(fake);
    db4.close();
    expect(readSetupState(file)).toBe('done');
    // Read-only: nothing was changed, and no connection is left open (the file can be replaced at once).
    fs.rmSync(file);
    fs.writeFileSync(file, 'not a database');
    expect(readSetupState(file)).toBeNull();
    // A crafted file where host_admins is a VIEW (the child can write data\): only a real table counts.
    fs.rmSync(file);
    const db5 = new DatabaseSync(file);
    db5.exec("CREATE TABLE t (x); CREATE VIEW host_admins AS SELECT 'a' AS id, 'u' AS username, NULL AS pass_hash, 1 AS created_at FROM t");
    db5.close();
    expect(['first', null]).toContain(readSetupState(file)); // a view is not the table: never 'done'
  });

  it('only this PC\'s control panel is ever opened, without a shell', async () => {
    const calls: [string, readonly string[]][] = [];
    const exec: ExecFn = async (file, args) => { calls.push([file, args]); return { code: 1, stdout: '', stderr: '' }; };
    await openInBrowser('http://localhost:7778/#setup=K7QP-4MXD', { exec, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
    expect(calls).toEqual([['C:\\Windows\\explorer.exe', ['http://localhost:7778/#setup=K7QP-4MXD']]]);
    await expect(openInBrowser('https://evil.example/', { exec, platform: 'win32' })).rejects.toThrow();
    await expect(openInBrowser('file:///C:/Windows/System32/calc.exe', { exec, platform: 'win32' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('launch (§2.2): first run, banner, browser, secrets over IPC, the pipe, stop', () => {
  it('first run: config + secrets made, the child gets lan:start with the secrets, the browser gets #setup=, a second launch opens the panel', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    const h = harness(root, port);
    const r = await launch([], h.deps);
    expect(r.exitCode).toBeNull();
    const host = r.host!;
    try {
      expect(host.ports).toEqual({ game: port, admin: port + 1 });
      expect(host.setupPending).toBe(true);
      const code = formatSetupCode(host.setupCode);
      // Banner (console): the panel, loopback only until setup, the setup code.
      const text = h.text();
      expect(text).toContain(`Host Control Panel (this PC):  http://localhost:${port + 1}`);
      expect(text).toContain('Players join at:               after setup');
      expect(text).toContain(`First run — setup code:        ${code}`);
      expect(text).not.toContain('192.168.1.50');
      // The browser: the setup code in the fragment (never sent to the server).
      expect(h.opened).toEqual([`http://localhost:${port + 1}/#setup=${code}`]);
      // Config and secrets.
      const cfg = JSON.parse(fs.readFileSync(path.join(data, 'voidswarm.config.json'), 'utf8'));
      expect(cfg.network).toMatchObject({ port, adminPort: port + 1 });
      for (const k of ['pepper.key', 'backup.key', 'pipe.key']) expect(fs.statSync(path.join(data, 'secrets', k)).size).toBe(32);
      // The child: secrets over IPC (never pipe.key), nothing secret in argv or env.
      const [rec] = starts(data);
      const pepper = fs.readFileSync(path.join(data, 'secrets', 'pepper.key')).toString('base64');
      expect(rec.start).toMatchObject({
        type: 'lan:start', dataDir: data, port, adminPort: port + 1, bind: '127.0.0.1', serveLan: false, notServing: 'setup',
        preset: 'home', setupCode: host.setupCode, primary: '192.168.1.50', publicUrl: `http://localhost:${port}`,
      });
      expect(rec.start.secrets.v).toBe(1);
      expect(rec.start.secrets.secrets['pepper.key']).toBe(pepper);
      expect(Object.keys(rec.start.secrets.secrets).sort()).toEqual(['backup.key', 'pepper.key']);
      expect(rec.envKeys).not.toContain('SMTP_PASS');
      expect(rec.envKeys).not.toContain('PORT');
      expect(JSON.stringify(rec.argv)).not.toMatch(/not-for-the-child|K7QP|setup/i);
      expect(rec.start.launcher).toMatchObject({ pid: process.pid, root });
      // The pipe: status needs pipe.key and reaches the child.
      const key = fs.readFileSync(path.join(data, 'secrets', 'pipe.key'));
      const st = await sendCommand({ dataDir: data, key, cmd: 'status' });
      expect(st.ok && st.verified).toBe(true);
      expect(st.ok && (st.body.status as { server: unknown }).server).toMatchObject({ online: 2, rooms: 5 });
      // The window title follows the child's status.
      await new Promise((res) => setTimeout(res, 350));
      expect(h.titles.at(-1)).toBe(`Voidswarm Host · 2 online · 5 rooms · this PC only (:${port})`);
      // T-LAN-2 through the launcher: a second launch opens the running panel and exits 0.
      const h2 = harness(root, port);
      const second = await launch([], h2.deps);
      expect(second).toEqual({ exitCode: 0, host: null });
      expect(h2.opened).toEqual([`http://localhost:${port + 1}/`]);
      expect(h2.text()).toContain(ALREADY_RUNNING_MESSAGE);
      // The host log: launcher lines, never the setup code.
      await host.log.flush();
      const logText = fs.readFileSync(host.log.file, 'utf8');
      expect(logText).toContain('[launcher] Voidswarm LAN');
      expect(logText).not.toContain(host.setupCode);
      expect(logText).not.toContain(code);
    } finally {
      expect(await host.stop('test')).toBe(LAUNCH_EXIT.OK);
    }
    // Stopped: the pipe is free again.
    const again = await acquireLock({ dataDir: data, key: null, handlers: { panelUrl: () => 'http://localhost:1/' } });
    expect(again.ok).toBe(true);
    if (again.ok) await again.lock.close();
    expect(h.text()).toContain('Voidswarm stopped. Bye!');
  }, 30_000);

  it('later runs: the stored ports, LAN serving on the primary address, no setup code, the plain panel URL; --no-browser and openBrowser=false', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    const first = await launch(['--no-browser'], harness(root, port).deps);
    await first.host!.stop();
    // Second run: PORT in the environment no longer matters (the pair is stored).
    const h = harness(root, port + 40);
    const r = await launch([], h.deps);
    const host = r.host!;
    try {
      expect(host.ports).toEqual({ game: port, admin: port + 1 });
      expect(host.setupPending).toBe(false);
      expect(host.serveLan).toBe(true);
      expect(h.opened).toEqual([`http://localhost:${port + 1}/`]);
      expect(h.text()).toContain(`Players join at:               http://192.168.1.50:${port}`);
      expect(h.text()).not.toContain('setup code');
      const recs = starts(data);
      expect(recs.at(-1)!.start).toMatchObject({ bind: '192.168.1.50', serveLan: true, notServing: null, publicUrl: `http://192.168.1.50:${port}` });
    } finally {
      await host.stop();
    }
    // openBrowser = false in the settings.
    const cfgFile = path.join(data, 'voidswarm.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.network.openBrowser = false;
    cfg.rev += 1;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const h3 = harness(root, port);
    const r3 = await launch([], h3.deps);
    expect(h3.opened).toEqual([]);
    await r3.host!.stop();
  }, 30_000);

  it('a child that reports setup pending gets the setup code even on a later run; a Public network keeps it on loopback', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { setupPending: true });
    const port = await freeBase();
    await (await launch(['--no-browser'], harness(root, port).deps)).host!.stop();
    const h = harness(root, port, { preflight: async (o) => ({ report: report(o.primary ?? null, 'Public') }) });
    const host = (await launch([], h.deps)).host!;
    try {
      expect(host.setupPending).toBe(true);
      expect(h.opened[0]).toMatch(/#setup=[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(h.text()).toContain('set to Public');
      expect(starts(data).at(-1)!.start).toMatchObject({ bind: '127.0.0.1', serveLan: false, notServing: 'public-network' });
      expect(starts(data).at(-1)!.start.banners.map((b: { code: string }) => b.code)).toContain('preflight-network-public');
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('setup still pending on a LATER run and the database can\'t tell: the LAN child is replaced by a loopback one; no address is printed', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { setupPending: true });
    const port = await freeBase();
    await (await launch(['--no-browser'], harness(root, port).deps)).host!.stop();
    const h = harness(root, port, { restartDelayMs: 20 });
    const host = (await launch([], h.deps)).host!;
    try {
      const recs = starts(data);
      expect(recs).toHaveLength(3);
      // The later run first asked for the LAN address (the database couldn't tell: setupState null)...
      expect(recs[1].start).toMatchObject({ bind: '192.168.1.50', serveLan: true, notServing: null });
      // ...the child said setup is pending, so it was replaced by one on loopback only (not a crash restart).
      expect(recs[2].start).toMatchObject({ bind: '127.0.0.1', serveLan: false, notServing: 'setup', publicUrl: `http://localhost:${port}`, restart: null });
      expect(recs[2].start.setupCode).toBe(recs[1].start.setupCode);
      expect(host.supervisor.restartCount).toBe(0);
      expect(host.setupPending).toBe(true);
      expect(host.serveLan).toBe(false);
      const text = h.text();
      expect(text).toContain('Players join at:               after setup');
      expect(text).not.toContain('192.168.1.50');
      expect(text).toMatch(/First run — setup code: +[0-9A-Z]{4}-[0-9A-Z]{4}/);
      expect(text).not.toContain('restarted after an error');
      expect(h.opened).toEqual([`http://localhost:${port + 1}/#setup=${formatSetupCode(host.setupCode)}`]);
      await new Promise((res) => setTimeout(res, 350));
      expect(h.titles.at(-1)).toBe(`Voidswarm Host · 2 online · 5 rooms · this PC only (:${port})`);
      await host.log.flush();
      expect(fs.readFileSync(host.log.file, 'utf8')).toContain('first-run setup is still pending');
    } finally {
      expect(await host.stop()).toBe(LAUNCH_EXIT.OK);
    }
  }, 30_000);

  it('setup still pending on a LATER run and the database says so: the FIRST child is already on loopback (never on the LAN before setup)', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { setupPending: true });
    const port = await freeBase();
    await (await launch(['--no-browser'], harness(root, port).deps)).host!.stop();
    const asked: string[] = [];
    const h = harness(root, port, { restartDelayMs: 20, setupState: (db) => { asked.push(db); return 'first'; } });
    const host = (await launch([], h.deps)).host!;
    try {
      expect(asked).toEqual([path.join(data, 'voidswarm.db')]);
      const recs = starts(data);
      // One child for this run, on loopback from the start: no LAN child, no respawn.
      expect(recs).toHaveLength(2);
      expect(recs[1].start).toMatchObject({ bind: '127.0.0.1', serveLan: false, notServing: 'setup', publicUrl: `http://localhost:${port}` });
      expect(host.setupPending).toBe(true);
      expect(host.serveLan).toBe(false);
      const text = h.text();
      expect(text).toContain('Players join at:               after setup');
      expect(text).not.toContain('192.168.1.50');
      expect(h.opened).toEqual([`http://localhost:${port + 1}/#setup=${formatSetupCode(host.setupCode)}`]);
      await host.log.flush();
      const logText = fs.readFileSync(host.log.file, 'utf8');
      expect(logText).toContain('first-run setup, as the database says: first');
      expect(logText).not.toContain('first-run setup is still pending');
    } finally {
      expect(await host.stop()).toBe(LAUNCH_EXIT.OK);
    }
  }, 30_000);

  it('a later run whose database says "done" or "reset" serves the LAN from the first child (a password reset never closes the game)', async () => {
    for (const state of ['done', 'reset'] as const) {
      const { root, app, data } = makeRoot();
      fakeServer(app, state === 'reset' ? { setupPending: true, setupKind: 'reset' } : { setupPending: false });
      const port = await freeBase();
      await (await launch(['--no-browser'], harness(root, port).deps)).host!.stop();
      const before = starts(data).length;
      const host = (await launch(['--no-browser'], harness(root, port, { setupState: () => state }).deps)).host!;
      try {
        const recs = starts(data).slice(before);
        expect(recs, state).toHaveLength(1);
        expect(recs[0].start, state).toMatchObject({ bind: '192.168.1.50', serveLan: true, notServing: null });
        expect(host.serveLan, state).toBe(true);
      } finally {
        await host.stop();
      }
    }
  }, 30_000);

  const waitFor = async (what: () => boolean, ms = 8000): Promise<void> => {
    const end = Date.now() + ms;
    while (!what() && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
    expect(what()).toBe(true);
  };

  it('first run → setup done: the loopback child is replaced by one on the LAN address, one console line says so, and a crash restart keeps it', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { setupFlow: { doneAfter: 600, via: 'message' }, crashStarts: [2] });
    const port = await freeBase();
    const h = harness(root, port, { restartDelayMs: 20 });
    const host = (await launch([], h.deps)).host!;
    try {
      expect(host.setupPending).toBe(true);
      expect(host.serveLan).toBe(false);
      expect(h.text()).toContain('Players join at:               after setup');
      // Setup finished in the browser: the next child listens on the LAN address (a planned respawn, not a crash)...
      await waitFor(() => starts(data).length >= 2);
      const recs = starts(data);
      expect(recs[0].start).toMatchObject({ bind: '127.0.0.1', serveLan: false, notServing: 'setup' });
      expect(recs[1].start).toMatchObject({ bind: '192.168.1.50', serveLan: true, notServing: null, publicUrl: `http://192.168.1.50:${port}`, restart: null });
      await waitFor(() => h.text().includes('players can join'));
      expect(h.out.filter((l) => l.includes('players can join'))).toEqual([expect.stringMatching(new RegExp(`^\\d\\d:\\d\\d Setup is done: players can join at http://192\\.168\\.1\\.50:${port}\\n$`))]);
      // ...and a crash restart after that keeps the LAN address.
      await waitFor(() => starts(data).length >= 3);
      expect(starts(data)[2].start).toMatchObject({ bind: '192.168.1.50', serveLan: true, notServing: null, restart: { count: 1 } });
      await waitFor(() => h.titles.at(-1) === `Voidswarm Host · 2 online · 5 rooms · 192.168.1.50:${port}`);
      expect(host.serveLan).toBe(true);
      expect(host.setupPending).toBe(false);
      expect(host.supervisor.restartCount).toBe(1);
      await host.log.flush();
      const logText = fs.readFileSync(host.log.file, 'utf8');
      expect(logText).toContain('first-run setup is done (the server says so)');
    } finally {
      expect(await host.stop()).toBe(LAUNCH_EXIT.OK);
    }
    // The next launcher run starts on the LAN address at once.
    const h2 = harness(root, port);
    const host2 = (await launch(['--no-browser'], h2.deps)).host!;
    try {
      expect(starts(data).at(-1)!.start).toMatchObject({ bind: '192.168.1.50', serveLan: true });
      expect(host2.serveLan).toBe(true);
    } finally {
      await host2.stop();
    }
  }, 40_000);

  it('the status reply alone (setupPending false) also opens the game to the LAN; a Public network never does', async () => {
    {
      const { root, app, data } = makeRoot();
      fakeServer(app, { setupFlow: { doneAfter: 200, via: 'status' } });
      const port = await freeBase();
      const h = harness(root, port, { restartDelayMs: 20 });
      const host = (await launch(['--no-browser'], h.deps)).host!;
      try {
        await waitFor(() => starts(data).length >= 2 && host.serveLan);
        expect(starts(data)[1].start).toMatchObject({ bind: '192.168.1.50', serveLan: true });
        expect(starts(data)).toHaveLength(2);
      } finally {
        await host.stop();
      }
    }
    {
      const { root, app, data } = makeRoot();
      fakeServer(app, { setupFlow: { doneAfter: 100, via: 'message' } });
      const port = await freeBase();
      const h = harness(root, port, { restartDelayMs: 20, preflight: async (o) => ({ report: report(o.primary ?? null, 'Public') }) });
      const host = (await launch(['--no-browser'], h.deps)).host!;
      try {
        await new Promise((res) => setTimeout(res, 600));
        expect(starts(data)).toHaveLength(1);
        expect(starts(data)[0].start).toMatchObject({ bind: '127.0.0.1', notServing: 'public-network' });
        expect(host.serveLan).toBe(false);
        expect(host.setupPending).toBe(false);
      } finally {
        await host.stop();
      }
    }
  }, 40_000);

  it('a child that keeps flipping between "setup done" and "setup pending" can switch the host at most 3 times, then stays on this PC', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { setupPending: true, doneOnLoopback: true });
    const port = await freeBase();
    const h = harness(root, port, { restartDelayMs: 20 });
    const host = (await launch(['--no-browser'], h.deps)).host!;
    try {
      await waitFor(() => starts(data).length >= 7);
      await new Promise((res) => setTimeout(res, 500));
      const binds = starts(data).map((r) => r.start.bind);
      expect(binds).toEqual(['127.0.0.1', '192.168.1.50', '127.0.0.1', '192.168.1.50', '127.0.0.1', '192.168.1.50', '127.0.0.1']);
      expect(host.serveLan).toBe(false);
      expect(host.supervisor.restartCount).toBe(0);
      await host.log.flush();
      expect(fs.readFileSync(host.log.file, 'utf8')).toContain('already switched 3 times in this run');
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('a password reset (setupKind "reset") is not first-run setup: players keep playing on the LAN address', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    await (await launch(['--no-browser'], harness(root, port).deps)).host!.stop();
    fakeServer(app, { setupPending: true, setupKind: 'reset' });
    const h = harness(root, port, { restartDelayMs: 20 });
    const host = (await launch([], h.deps)).host!;
    try {
      await new Promise((res) => setTimeout(res, 400));
      expect(starts(data)).toHaveLength(2);
      expect(starts(data)[1].start).toMatchObject({ bind: '192.168.1.50', serveLan: true });
      expect(host.serveLan).toBe(true);
      expect(host.setupPending).toBe(true);
      // The setup code is still shown (the new admin login needs it), and so is the address.
      expect(h.text()).toMatch(/setup code: +[0-9A-Z]{4}-[0-9A-Z]{4}/);
      expect(h.text()).toContain(`Players join at:               http://192.168.1.50:${port}`);
    } finally {
      await host.stop();
    }
  }, 30_000);

  // The LAN host is Windows-only (spec section 10): console layout and path wording are checked on Windows.
  it.runIf(process.platform === 'win32')('a setup code the child minted is printed in the console only; bad codes and unknown folders are ignored; open-folder is rate-limited', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, {
      sendAfterReady: [
        { type: 'setup-code', code: 'K7QP4MXD', why: 'void' },
        { type: 'setup-code', code: 'k7qp4mxd' }, { type: 'setup-code', code: '\u001b[2JAAAAAAAA' }, { type: 'setup-code', code: 12345678 },
        { type: 'open-folder', which: 'constructor' }, { type: 'open-folder', which: '__proto__' }, { type: 'open-folder', which: 'toString' },
        { type: 'open-folder', which: 'C:\\Windows' },
        ...Array.from({ length: 5 }, () => ({ type: 'open-folder', which: 'logs' })),
      ],
    });
    const port = await freeBase();
    const opened: string[][] = [];
    const exec: ExecFn = async (file, args) => { opened.push([file, ...args]); return { code: 1, stdout: '', stderr: '' }; };
    const h = harness(root, port, { exec });
    const host = (await launch(['--no-browser'], h.deps)).host!;
    try {
      await waitFor(() => h.text().includes('New setup code'));
      expect(h.out.filter((l) => l.includes('setup code')).at(-1)).toMatch(/^\d\d:\d\d New setup code: K7QP-4MXD \(the old one stopped working after too many wrong tries\)\n$/);
      expect(host.currentSetupCode).toBe('K7QP4MXD');
      expect(host.setupCode).not.toBe('K7QP4MXD');
      expect(h.text()).not.toContain('AAAAAAAA');
      const got = (): Record<string, unknown>[] => {
        const f = path.join(data, 'fake-got.jsonl');
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
      };
      await waitFor(() => got().filter((m) => m.type === 'open-folder:done').length >= 5);
      // Only data\logs, only 3 times in the minute; inherited keys and paths from the child open nothing.
      const explorerCalls = opened.filter(([f]) => /explorer\.exe$|\/open$|xdg-open$/i.test(f));
      expect(explorerCalls.map((c) => c.at(-1))).toEqual([path.join(data, 'logs'), path.join(data, 'logs'), path.join(data, 'logs')]);
      expect(got().filter((m) => m.type === 'open-folder:done').map((m) => m.which)).toEqual(['logs', 'logs', 'logs', 'logs', 'logs']);
      expect(got().filter((m) => m.type === 'open-folder:done').map((m) => m.ok).filter((ok) => ok === false).length).toBeGreaterThanOrEqual(2);
      await host.log.flush();
      const logText = fs.readFileSync(host.log.file, 'utf8');
      expect(logText).not.toContain('K7QP4MXD');
      expect(logText).not.toContain('K7QP-4MXD');
      expect(logText).toContain('a new setup code was shown in the console (the old one void)');
      expect(logText.match(/ignored a malformed setup-code message/g)).toHaveLength(3);
      expect(logText).toContain('open-folder logs: refused (more than 3 a minute)');
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('a notice from the child is printed as one plain line: no escape sequence reaches the console', async () => {
    const { root, app } = makeRoot();
    fakeServer(app, { notice: '\u001b[2J\u001b[H FAKE: Players join at: http://10.9.9.9:80 \u0007\nsecond' });
    const port = await freeBase();
    const h = harness(root, port);
    const host = (await launch(['--no-browser'], h.deps)).host!;
    try {
      const end = Date.now() + 5000;
      while (!h.text().includes('FAKE') && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
      const line = h.out.find((l) => l.includes('FAKE'))!;
      expect(line).toMatch(/^\d\d:\d\d \[2J\[H FAKE: Players join at: http:\/\/10\.9\.9\.9:80 second\n$/);
      for (const l of h.out) expect(l).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('after a crash the child is restarted: one console line, and the new child is told (panel banner)', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { crashAfterReadyTimes: 1, crashDelay: 400 });
    const port = await freeBase();
    const h = harness(root, port, { restartDelayMs: 20 });
    const host = (await launch(['--no-browser'], h.deps)).host!;
    try {
      // A secret saved while the first child ran (the panel's new SMTP password) reaches the restarted one.
      fs.writeFileSync(path.join(data, 'secrets', 'smtp.secret'), 'relay-password-1');
      const end = Date.now() + 5000;
      while (!h.text().includes('restarted after an error') && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
      const lines = h.out.filter((l) => l.includes('restarted after an error'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\d\d:\d\d The server restarted after an error at \d\d:\d\d\.\n$/);
      const recs = starts(data);
      expect(recs).toHaveLength(2);
      expect(recs[1].start.restart).toMatchObject({ count: 1, exitCode: 1 });
      expect(recs[1].start.restart.notice).toMatch(/restarted after an error/);
      expect(recs[1].start.banners.map((b: { code: string }) => b.code)).toContain('restarted');
      expect(recs[1].start.setupCode).toBe(recs[0].start.setupCode);
      expect(recs[0].start.secrets.secrets['smtp.secret']).toBeUndefined();
      expect(Buffer.from(recs[1].start.secrets.secrets['smtp.secret'], 'base64').toString()).toBe('relay-password-1');
    } finally {
      expect(await host.stop()).toBe(0);
    }
  }, 30_000);
});

describe('launch refusals (exit codes)', () => {
  it('bad flags → 4; a refused location → 5 (nothing written, no lock kept)', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    const h0 = harness(root, port);
    expect((await launch(['--frobnicate'], h0.deps)).exitCode).toBe(LAUNCH_EXIT.USAGE);
    expect(h0.text()).toContain('Usage:');
    const msg = "Voidswarm can't run from this folder:\n  - It is inside OneDrive.\nMove the whole \"Voidswarm LAN\" folder to %USERPROFILE%\\Voidswarm LAN";
    const h = harness(root, port, { checkLocation: async () => ({ ok: false, problems: [], warnings: [], suggestion: '', message: msg }) });
    expect((await launch([], h.deps)).exitCode).toBe(LAUNCH_EXIT.REFUSED);
    expect(h.text()).toContain('%USERPROFILE%\\Voidswarm LAN');
    expect(fs.existsSync(data)).toBe(false);
    // --skip-location-check (the T-PKG-5 test flag) starts anyway, and says so.
    const h2 = harness(root, port, { checkLocation: async () => ({ ok: false, problems: [], warnings: [], suggestion: '', message: msg }) });
    const r2 = await launch(['--skip-location-check', '--no-browser'], h2.deps);
    expect(h2.text()).toContain('location check is off');
    await r2.host!.stop();
  }, 30_000);

  it('moved data → 5; TRUST_PROXY → 5; a busy port → 2; the server\'s own fatal (exit 3) → 3 with its message', async () => {
    const port = await freeBase();
    {
      const { root, app, data } = makeRoot();
      fakeServer(app);
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'MOVED-TO.json'), JSON.stringify({ movedTo: 'D:\\New\\Voidswarm LAN', at: Date.now() }));
      const h = harness(root, port);
      expect((await launch([], h.deps)).exitCode).toBe(LAUNCH_EXIT.REFUSED);
      expect(h.text()).toContain('This data was moved to D:\\New\\Voidswarm LAN');
    }
    {
      const { root, app } = makeRoot();
      fakeServer(app);
      const h = harness(root, port);
      h.deps.env = { ...h.deps.env, TRUST_PROXY: '1' };
      expect((await launch([], h.deps)).exitCode).toBe(LAUNCH_EXIT.REFUSED);
      expect(h.text()).toContain('VPS kit');
    }
    {
      const { root, app, data } = makeRoot();
      fakeServer(app);
      const h = harness(root, port, { choosePorts: async () => ({ ok: false, busy: [], message: "Voidswarm can't start: its port is in use.\n  - Port 7777 (game) is in use by node.exe (PID 4242)." }) });
      expect((await launch([], h.deps)).exitCode).toBe(LAUNCH_EXIT.PORT);
      expect(h.text()).toContain('node.exe (PID 4242)');
      expect(starts(data)).toHaveLength(0);
      // The lock was released.
      const l = await acquireLock({ dataDir: data, key: null, handlers: { panelUrl: () => 'http://localhost:1/' } });
      expect(l.ok).toBe(true);
      if (l.ok) await l.lock.close();
    }
    {
      const { root, app } = makeRoot();
      fakeServer(app, { exitBeforeReady: 3 });
      const h = harness(root, port);
      expect((await launch([], h.deps)).exitCode).toBe(LAUNCH_EXIT.DATA);
      expect(h.text()).toContain('could not open its database (fake)');
    }
  }, 30_000);

  it.runIf(process.platform === 'win32')('--data that is, holds, or sits in the program folders → 4 before anything runs (the child could replace app\\launch.mjs)', async () => {
    const { root, app } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    for (const d of [root, path.dirname(root), path.join(root, 'app', 'data'), path.join(root, 'runtime'), path.join(root, 'web', 'd')]) {
      const h = harness(root, port);
      expect((await launch(['--no-browser', '--data', d], h.deps)).exitCode, d).toBe(LAUNCH_EXIT.USAGE);
      expect(h.text()).toMatch(/can't be used: it (is the Voidswarm folder itself|contains the Voidswarm folder|is inside Voidswarm's own \w+\\ folder)/);
    }
    expect(fs.readdirSync(root).sort()).toEqual(['app']);
    expect(fs.readdirSync(app).sort()).toEqual(['server.mjs']);
    // A separate folder is fine.
    const h = harness(root, port);
    const ok = await launch(['--no-browser', '--data', path.join(path.dirname(root), 'VS data')], h.deps);
    expect(ok.exitCode).toBeNull();
    await ok.host!.stop();
  }, 30_000);

  it('a damaged optional secret is left out with a banner; a damaged required key at a crash restart ends the host with exit 3', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { crashAfterReadyTimes: 1, crashDelay: 1000 });
    const port = await freeBase();
    fs.mkdirSync(path.join(data, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(data, 'secrets', 'smtp.secret'), Buffer.alloc(70 * 1024, 65));
    const h = harness(root, port, { restartDelayMs: 20 });
    const r = await launch(['--no-browser'], h.deps);
    expect(r.exitCode).toBeNull();
    const host = r.host!;
    // The pepper key goes bad while the first child runs: the restarted child can't be given one.
    fs.writeFileSync(path.join(data, 'secrets', 'pepper.key'), 'short');
    const [first] = starts(data);
    expect(first.start.secrets.secrets['smtp.secret']).toBeUndefined();
    expect(first.start.secrets.secrets['pepper.key']).toBeDefined();
    expect(first.start.banners.map((b: { code: string }) => b.code)).toContain('secrets-left-out');
    expect(h.text()).toContain('smtp.secret is too big');
    expect(await host.finished).toBe(LAUNCH_EXIT.DATA);
    expect(h.text()).toMatch(/could not be started: data\\secrets\\pepper\.key is damaged/);
    expect(starts(data)).toHaveLength(1);
  }, 30_000);

  it('a child that exits 0 before it was ready is a failed start (exit 1), not "stopped from the control panel"', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app, { exitZeroBeforeReady: true });
    const port = await freeBase();
    const h = harness(root, port, { restartDelayMs: 20 });
    expect((await launch(['--no-browser'], h.deps)).exitCode).toBe(LAUNCH_EXIT.CRASH);
    expect(h.text()).not.toMatch(/control panel\./);
    expect(h.text()).toMatch(/gave up/);
    expect(starts(data)).toHaveLength(4);
  }, 30_000);

  it('isEntry: only the launcher\'s own file runs main(), compared as real paths (a junction to the folder)', () => {
    const { root, app } = makeRoot();
    const file = path.join(app, 'launch.mjs');
    const tool = path.join(app, 'tool.mjs');
    fs.writeFileSync(file, '');
    fs.writeFileSync(tool, '');
    const url = pathToFileURL(file).href;
    expect(isEntry(url, file)).toBe(true);
    expect(isEntry(url, undefined)).toBe(false);
    expect(isEntry(url, tool)).toBe(false);
    // app\tool.mjs bundles launch.ts: import.meta.url is then the tool's own file.
    expect(isEntry(pathToFileURL(tool).href, tool)).toBe(false);
    if (process.platform === 'win32') {
      const link = path.join(tmpRoot, `junction-${seq++}`);
      fs.symlinkSync(root, link, 'junction');
      expect(isEntry(url, path.join(link, 'app', 'launch.mjs'))).toBe(true);
      expect(isEntry(url, path.join(link, 'APP', 'LAUNCH.MJS'))).toBe(true);
    }
  });

  it('a bundle that merely imports the launcher module (app\\tool.mjs) never runs the launcher', async () => {
    const dir = makeRoot().app;
    const out = path.join(dir, 'tool.mjs');
    const { build } = await import('esbuild');
    await build({
      absWorkingDir: repoRoot,
      stdin: { contents: "import { LAUNCH_EXIT } from './src/lan/launch';\nprocess.stdout.write(JSON.stringify(LAUNCH_EXIT));\n", resolveDir: repoRoot, loader: 'ts', sourcefile: 'tool.ts' },
      outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      external: ['bufferutil', 'utf-8-validate'],
      banner: { js: "import { createRequire as __vsCreateRequire } from 'node:module'; const require = __vsCreateRequire(import.meta.url);" },
    });
    const r = await new Promise<{ code: number | null; out: string }>((res) => {
      const p = spawn(process.execPath, [out, 'update', '--frobnicate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let s = '';
      p.stdout.on('data', (d) => { s += d; });
      p.stderr.on('data', (d) => { s += d; });
      p.once('exit', (code) => res({ code, out: s }));
    });
    expect(r.out).toBe(JSON.stringify(LAUNCH_EXIT));
    expect(r.code).toBe(0);
  }, 30_000);

  it('School: an elevated start and a permissions problem refuse; Home starts with the warnings as banners', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    // Home (the first run's preset): elevated + permissions → warnings, the host starts.
    const warnAcl: AclReport = { ...okAcl, ok: false, decision: 'warn', message: 'Other accounts on this PC can change Voidswarm\'s files.', banner: 'Permissions warning: other accounts on this PC can reach Voidswarm\'s folder. Fix permissions →' };
    const h = harness(root, port, { readToken: async () => high, checkPermissions: async () => warnAcl });
    const host = (await launch(['--no-browser'], h.deps)).host!;
    expect(h.text()).toContain('Running as administrator');
    expect(h.text()).toContain('Permissions warning');
    expect(starts(data)[0].start.banners.map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(['elevated', 'permissions']));
    await host.stop();
    // Now School.
    const cfgFile = path.join(data, 'voidswarm.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.preset = 'school';
    cfg.launcher = { elevated: 'refuse', permissions: 'refuse' };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const hs = harness(root, port, { readToken: async () => high });
    expect((await launch([], hs.deps)).exitCode).toBe(LAUNCH_EXIT.REFUSED);
    expect(hs.text()).toContain('School mode never runs that way');
    let asked: string | null = null;
    const hp = harness(root, port, { checkPermissions: async (o) => { asked = o.preset; return { ...okAcl, ok: false, decision: 'refuse', message: "School mode won't start while other accounts on this PC can change Voidswarm's files" }; } });
    expect((await launch([], hp.deps)).exitCode).toBe(LAUNCH_EXIT.REFUSED);
    expect(asked).toBe('school');
    expect(hp.text()).toContain("School mode won't start");
    // --fix-permissions runs the fix first, then starts.
    let fixed = false;
    const hf = harness(root, port, { fixPermissions: async () => { fixed = true; return { report: okAcl, ran: ['icacls …'], errors: [] }; } });
    const r = await launch(['--fix-permissions', '--no-browser'], hf.deps);
    expect(fixed).toBe(true);
    expect(hf.text()).toContain('The folder permissions are fixed.');
    await r.host!.stop();
  }, 30_000);
});

describe('staged work (§2.2 step 8) and the first-run import offer (§2.5, T-LAN-16)', () => {
  const put = (dir: string, files: Record<string, string>, mtimeMs?: number): void => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(dir, f);
      fs.writeFileSync(p, c);
      if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    }
  };

  it('findImportCandidates: Voidswarm LAN*\\data folders next to this copy and in the profile, newest first; never this copy, links, moved or empty ones', () => {
    const base = path.join(tmpRoot, `imp${seq++}`);
    const self = path.join(base, 'Voidswarm LAN');
    const t = Date.now();
    put(path.join(self, 'data'), { 'voidswarm.db': 'self' });
    put(path.join(base, 'Voidswarm LAN (old)', 'data'), { 'voidswarm.db': 'x'.repeat(100) }, t - 86_400_000);
    put(path.join(base, 'voidswarm lan 2', 'data'), { 'voidswarm.config.json': '{}' }, t - 1000);
    put(path.join(base, 'Voidswarm LAN moved', 'data'), { 'voidswarm.db': 'x', 'MOVED-TO.json': '{}' });
    put(path.join(base, 'Voidswarm LAN empty', 'data'), {});
    put(path.join(base, 'Voidswarm LAN no data'), { 'readme.txt': 'x' });
    put(path.join(base, 'Other copy', 'data'), { 'voidswarm.db': 'x' });
    fs.writeFileSync(path.join(base, 'Voidswarm LAN.zip'), 'not a folder');
    fs.symlinkSync(path.join(base, 'Voidswarm LAN (old)'), path.join(base, 'Voidswarm LAN link'), 'junction');
    const home = path.join(tmpRoot, `home${seq++}`);
    put(path.join(home, 'Voidswarm LAN', 'data'), { 'voidswarm.db': 'home' }, t - 5000);
    const env = process.platform === 'win32' ? { USERPROFILE: home } : { HOME: home };
    const found = findImportCandidates(self, path.join(self, 'data'), { env });
    expect(found.map((c) => c.root)).toEqual([
      path.join(base, 'voidswarm lan 2'), path.join(home, 'Voidswarm LAN'), path.join(base, 'Voidswarm LAN (old)'),
    ]);
    expect(found[0]).toMatchObject({ dataDir: path.join(base, 'voidswarm lan 2', 'data'), hasDb: false, dbBytes: 0 });
    expect(found[2]).toMatchObject({ hasDb: true, dbBytes: 100 });
    expect(Math.abs(found[2].modifiedAt! - (t - 86_400_000))).toBeLessThan(2000);
    // The profile folder is this copy's parent: listed once, never this copy itself.
    expect(findImportCandidates(self, path.join(self, 'data'), { env: process.platform === 'win32' ? { USERPROFILE: base } : { HOME: base } })).toHaveLength(2);
    // A folder that doesn't exist, or can't be listed: nothing, never a throw.
    expect(findImportCandidates(path.join(tmpRoot, 'nope', 'x', 'Voidswarm LAN'), path.join(tmpRoot, 'nope', 'd'), { env: {} })).toEqual([]);
  });

  it('the first run offers the other copies to the setup page (lan:start importCandidates) in the browser flow; nothing is asked in the console', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const old = path.join(path.dirname(root), 'Voidswarm LAN (old)');
    put(path.join(old, 'data'), { 'voidswarm.db': 'x', 'voidswarm.config.json': '{}' });
    const port = await freeBase();
    const h = harness(root, port);
    const host = (await launch([], h.deps)).host!;
    try {
      const [rec] = starts(data);
      expect(rec.start.importCandidates).toEqual([expect.objectContaining({ root: old, dataDir: path.join(old, 'data'), hasDb: true })]);
      expect(h.opened).toEqual([`http://localhost:${port + 1}/#setup=${formatSetupCode(host.setupCode)}`]);
      expect(h.text()).not.toMatch(/\[y\/n\]|press any key|bring in data/i);
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('by default a staged restore is applied before the server starts (restore.ts): an unreadable one is dropped with a banner', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    put(data, { 'restore.pending.json': 'garbage' });
    const port = await freeBase();
    const h = harness(root, port);
    const host = (await launch(['--no-browser'], h.deps)).host!;
    try {
      expect(fs.existsSync(path.join(data, 'restore.pending.json'))).toBe(false);
      const [rec] = starts(data);
      expect(rec.start.banners).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'staged', text: expect.stringMatching(/staged restore could not be read and was dropped/) }),
      ]));
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('settings replaced by the staged work are read again (a restore of the config); a failing staged step refuses with exit 3', async () => {
    const { root, app, data } = makeRoot();
    fakeServer(app);
    const port = await freeBase();
    const h = harness(root, port, {
      stagedWork: async ({ paths }) => {
        // What restore.ts does with "restore the settings too": another writer replaces the config file.
        const other = SettingsService.open({ dataDir: paths.data, lan: true, env: {} });
        const r = await other.apply({ network: { openBrowser: false } }, LAUNCHER_ACTOR, { context: 'test restore' });
        await other.close();
        expect(r.ok).toBe(true);
        return ['Restored the backup (test).'];
      },
    });
    const host = (await launch([], h.deps)).host!;
    try {
      expect(h.opened).toEqual([]);
      const cfg = JSON.parse(fs.readFileSync(path.join(data, 'voidswarm.config.json'), 'utf8'));
      // The restored value survived the launcher's own save of the port pair (made with the settings read again).
      expect(cfg.network).toMatchObject({ openBrowser: false, port, adminPort: port + 1 });
      expect(starts(data)[0].start.banners).toEqual(expect.arrayContaining([{ code: 'staged', level: 'info', text: 'Restored the backup (test).' }]));
    } finally {
      await host.stop();
    }
    const h2 = harness(root, port, { stagedWork: async () => { throw new Error('the swap failed (test)'); } });
    expect((await launch(['--no-browser'], h2.deps)).exitCode).toBe(LAUNCH_EXIT.DATA);
    expect(h2.text()).toMatch(/could not finish the work staged for this start \(a restore\): the swap failed \(test\)/);
    expect(starts(data)).toHaveLength(1);
  }, 30_000);
});

// T-LAN-16: the Start stub's `call <nul` gives the launcher an stdin at end-of-input (§0 fact 15). The launcher must
// start anyway and never prompt: everything that needs an answer (setup, bringing in data from another copy) is in
// the browser flow. This runs the bundled app\launch.mjs + app\server.mjs through the real stub (scripts/lan/templates,
// B11) or, until it exists, one that follows the §2.1 contract, from a folder with spaces, parentheses, an apostrophe
// and an ampersand, with cwd elsewhere.
describe.runIf(process.platform === 'win32')('T-LAN-16: the Start stub with stdin from NUL (the bundled app\\ in a real process)', () => {
  const bundleApp = async (app: string): Promise<void> => {
    const { build } = await import('esbuild');
    await build({
      absWorkingDir: repoRoot,
      entryPoints: { launch: 'src/lan/launch.ts', server: 'src/server/index.ts' },
      outdir: app, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false,
      logLevel: 'silent', external: ['bufferutil', 'utf-8-validate'],
      banner: { js: "import { createRequire as __vsCreateRequire } from 'node:module'; const require = __vsCreateRequire(import.meta.url);" },
    });
    fs.cpSync(path.join(repoRoot, 'src', 'server', 'moderation', 'admin'), path.join(app, 'admin'), { recursive: true });
  };
  /**
   * The real Start stub once the packaging task has made it (scripts/lan/templates, B11), with runtime\node.exe (a
   * hard link to this Node); until then a stub that follows the §2.1 contract: re-call itself with stdin from NUL,
   * then run the launcher.
   */
  const template = path.join(repoRoot, 'scripts', 'lan', 'templates', 'Start Voidswarm Host.cmd');
  const writeStub = (root: string): string => {
    const stub = path.join(root, 'Start Voidswarm Host.cmd');
    if (fs.existsSync(template)) {
      fs.writeFileSync(stub, fs.readFileSync(template, 'utf8').replace(/\{\{\s*VERSION\s*\}\}/gi, 'test'));
      const nodeExe = path.join(root, 'runtime', 'node.exe');
      fs.mkdirSync(path.dirname(nodeExe), { recursive: true });
      try { fs.linkSync(process.execPath, nodeExe); } catch { fs.copyFileSync(process.execPath, nodeExe); }
      return stub;
    }
    fs.writeFileSync(stub, [
      '@echo off',
      'if not exist "%~dp0app\\launch.mjs" (echo Unzip the WHOLE folder first & exit /b 1)',
      'if "%~1"=="--child" goto run',
      'call <nul "%~f0" --child %*',
      'exit /b %errorlevel%',
      ':run',
      '"%VS_TEST_NODE%" "%~dp0app\\launch.mjs" %*',
      '',
    ].join('\r\n'));
    return stub;
  };
  const startStub = (stub: string, port: number) => {
    const proc = spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${stub}" --no-browser --skip-location-check"`], {
      cwd: os.tmpdir(),
      env: { ...process.env, PORT: String(port), VS_TEST_NODE: process.execPath, VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined },
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((res) => proc.once('exit', (c) => res(c)));
    /** The launcher is a grandchild (cmd → cmd → node): a failed test must not leave it (and its server) running. */
    const killTree = (): void => {
      if (proc.exitCode !== null || !proc.pid) return;
      const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
      spawnSync(path.join(sysRoot, 'System32', 'taskkill.exe'), ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    };
    const banner = async (): Promise<void> => {
      const end = Date.now() + 45_000;
      while (!out.includes('Stop: Ctrl+C here') && Date.now() < end) {
        if (proc.exitCode !== null) throw new Error(`the launcher exited ${proc.exitCode}:\n${out}`);
        await new Promise((res) => setTimeout(res, 100));
      }
    };
    return { proc, exited, banner, killTree, out: () => out };
  };
  const accepts = (port: number): Promise<boolean> => new Promise((res) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); res(true); });
    c.once('error', () => res(false));
  });

  it('starts, shows the first-run setup code, answers on the pipe, and stops cleanly (exit 0) — no console prompt', async () => {
    const { root, app, data } = makeRoot();
    await bundleApp(app);
    // Another copy next to this one: the first-run page's "Bring in data from another copy" gets it (browser flow).
    const old = path.join(path.dirname(root), 'Voidswarm LAN (old)', 'data');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'voidswarm.db'), 'x');
    const port = await freeBase();
    const run = startStub(writeStub(root), port);
    try {
      await run.banner();
      const out = run.out();
      expect(out).toContain(`Host Control Panel (this PC):  http://localhost:${port + 1}`);
      expect(out).toMatch(/First run — setup code: +[0-9A-Z]{4}-[0-9A-Z]{4}/);
      expect(out).not.toMatch(/\[y\/n\]|press any key|\?\s*$/i);
      expect(await accepts(port)).toBe(true);
      const key = fs.readFileSync(path.join(data, 'secrets', 'pipe.key'));
      const st = await sendCommand({ dataDir: data, key, cmd: 'status' });
      expect(st.ok && st.verified).toBe(true);
      expect(st.ok && (st.body.status as { server: { online: number } }).server.online).toBe(0);
      const stop = await sendCommand({ dataDir: data, key, cmd: 'stop' });
      expect(stop.ok).toBe(true);
      expect(await run.exited).toBe(0);
      expect(run.out()).toContain('Voidswarm stopped. Bye!');
      // The flush-first stop left one checkpointed database.
      expect(fs.existsSync(path.join(data, 'voidswarm.db'))).toBe(true);
      const wal = path.join(data, 'voidswarm.db-wal');
      expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
      // The next start reads the real server's database before its first child: setup was never finished.
      expect(readSetupState(path.join(data, 'voidswarm.db'))).toBe('first');
      expect(await accepts(port)).toBe(false);
      const logs = fs.readdirSync(path.join(data, 'logs')).filter((f) => /^host-\d{4}-\d{2}-\d{2}\.log$/.test(f));
      const logText = logs.map((f) => fs.readFileSync(path.join(data, 'logs', f), 'utf8')).join('');
      expect(logText).toContain('1 other Voidswarm LAN data folder(s) found for "Bring in data from another copy"');
      const code = /First run — setup code: +([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(out)![1];
      expect(logText).not.toContain(code);
      expect(logText).not.toContain(code.replace('-', ''));
    } finally {
      run.killTree();
    }
  }, 90_000);

  it('a hard kill of the launcher takes the server with it: the port and the pipe are free at once (no orphan)', async () => {
    const { root, app, data } = makeRoot();
    await bundleApp(app);
    const port = await freeBase();
    const run = startStub(writeStub(root), port);
    try {
      await run.banner();
      expect(await accepts(port)).toBe(true);
      const ping = await sendCommand({ dataDir: data, key: null, cmd: 'ping' });
      const pid = ping.ok ? Number(ping.body.pid) : 0;
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 'SIGKILL'); // TerminateProcess: no handler runs in the launcher
      const end = Date.now() + 5000;
      while ((await accepts(port)) && Date.now() < end) await new Promise((res) => setTimeout(res, 100));
      expect(await accepts(port)).toBe(false);
      const l = await acquireLock({ dataDir: data, key: null, handlers: { panelUrl: () => 'http://localhost:1/' } });
      expect(l.ok).toBe(true);
      if (l.ok) await l.lock.close();
    } finally {
      run.killTree();
    }
  }, 90_000);
});
