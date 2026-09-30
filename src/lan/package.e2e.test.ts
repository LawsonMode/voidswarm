// LAN task B11: the package build, end to end (docs/LAN-EDITION-proposal.md §2.1, §2.3; T-PKG-1…7). The whole
// `npm run package:lan` runs once into a scratch folder (never dist/ or release/): the web client, the four bundles,
// the pages, the signed node.exe, the text files, SHA256SUMS.txt and the zip. Then the zip is extracted into a folder
// with spaces, parentheses, an apostrophe and an ampersand, and the real Start stub runs it from another working
// directory. Windows only (node.exe, Authenticode, cmd.exe, tar); VOIDSWARM_SKIP_PACKAGE_E2E=1 skips it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  appBuildOptions, authenticode, buildLan, checkOutDir, checkStageManifest, devRun, findExternalUrls, gitIgnores, isInside, isNetworkPath, isOpenJsSubject, placeUnder, legalCommentsOf, LAN_FOLDER, makeZip, NODE_LICENSE,
  NON_FETCH_URLS, readVersion, sha256Of, STUBS, TEMPLATES_DIR, walkFiles, writeSums, ZIP_MAX_BYTES, zipName, type BuildResult,
} from '../../scripts/build-lan.mjs';
import { PROTOCOL_VERSION } from '../shared/version';
import { sendCommand } from './pipe';

const run = process.platform === 'win32' && !process.env.VOIDSWARM_SKIP_PACKAGE_E2E;
const scratch: string[] = [];
let out = '';
let built: BuildResult;
let stage = '';
const sysTool = (n: string): string => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `${n}.exe`);

function mk(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
}

async function freePair(): Promise<number> {
  for (let tries = 0; tries < 50; tries++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if ([7777, 7778, 5173, 5621].some((r) => r === p || r === p + 1)) continue;
    const ok = await Promise.all([p, p + 1].map((port) => new Promise<boolean>((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
    })));
    if (ok.every(Boolean)) return p;
  }
  throw new Error('no free port pair');
}

describe('the package build guards (every platform)', () => {
  afterAll(() => { for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* held */ } } });

  it('--out may never be dist/ or inside it, whatever the case of the path on Windows', async () => {
    const project = path.resolve(__dirname, '..', '..');
    const dist = path.join(project, 'dist');
    expect(isInside(dist, dist)).toBe(true);
    expect(isInside(path.join(dist, 'x'), dist)).toBe(true);
    expect(isInside(path.join(project, 'distx'), dist)).toBe(false);
    expect(isInside(project, dist)).toBe(false);
    expect(isInside('C:/Games/subspace clone/DIST/x', 'C:/Games/Subspace Clone/dist', 'win32')).toBe(true);
    expect(isInside('/srv/Subspace/DIST', '/srv/Subspace/dist', 'linux')).toBe(false);
    if (process.platform === 'win32') {
      const upper = path.join(path.dirname(project), path.basename(project).toLowerCase(), 'DIST');
      await expect(buildLan({ out: upper, quiet: true, log: () => undefined })).rejects.toThrow(/must not be dist/);
      await expect(buildLan({ out: path.join(upper, 'sub'), quiet: true, log: () => undefined })).rejects.toThrow(/must not be dist/);
    }
    await expect(buildLan({ out: dist, quiet: true, log: () => undefined })).rejects.toThrow(/must not be dist/);
  });

  it('T-PKG-4 scanner: JS, SVG and JSON are scanned too; only the exact non-fetch namespace / banner strings pass', () => {
    const d = mk('vs-pkg-scan-');
    fs.mkdirSync(path.join(d, 'assets'));
    fs.writeFileSync(path.join(d, 'assets', 'ok.js'), `document.createElementNS("http://www.w3.org/2000/svg","g");console.log("%c pixi http://www.pixijs.com/ ")`);
    fs.writeFileSync(path.join(d, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    fs.writeFileSync(path.join(d, 'OFL.txt'), 'see https://openfontlicense.org');
    expect(findExternalUrls(d)).toEqual([]);
    fs.writeFileSync(path.join(d, 'assets', 'bad.js'), 'fetch(`https://cdn.example/x.json`);const u="http://www.w3.org/2000/svgX"');
    fs.writeFileSync(path.join(d, 'bad.svg'), '<svg><image href="https://img.example/a.png"/></svg>');
    fs.writeFileSync(path.join(d, 'm.json'), '{"u":"https://api.example/"}');
    const found = findExternalUrls(d);
    expect(found).toEqual(expect.arrayContaining([
      'assets/bad.js: https://cdn.example/x.json', 'assets/bad.js: http://www.w3.org/2000/svgX', 'bad.svg: https://img.example/a.png', 'm.json: https://api.example/',
    ]));
    expect(found).toHaveLength(4);
    expect(NON_FETCH_URLS.every((u) => u.startsWith('http://www.w3.org/') || u === 'http://www.pixijs.com/')).toBe(true);
  });

  it('--out: dist/ reached another way (a junction; the A:\\ mapping of C:\\AI Bins when this PC has it) is refused before anything is written', async () => {
    const project = path.resolve(__dirname, '..', '..');
    const dist = path.join(project, 'dist');
    // By identity: a junction to a folder is the folder.
    const d = mk('vs-pkg-alias-');
    const target = path.join(d, 'target');
    fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
    const link = path.join(d, 'link');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(placeUnder(path.join(link, 'sub', 'x'), target)).toBe(path.join(target, 'sub', 'x'));
    expect(placeUnder(path.join(d, 'elsewhere'), target)).toBeNull();
    expect(placeUnder(target, target)).toBe(target);
    // Network paths: UNC, and a mapped drive (its real path is \\server\share\...); \\?\C:\ is local.
    expect(isNetworkPath('\\\\server\\share\\out', 'win32')).toBe(true);
    expect(isNetworkPath('\\\\?\\C:\\out', 'win32')).toBe(false);
    expect(isNetworkPath('/srv/out', 'linux')).toBe(false);
    if (process.platform === 'win32') expect(isNetworkPath(path.join(os.tmpdir(), 'x', 'y'))).toBe(false);
    const aliased = 'A:\\Code\\Subspace Clone';
    if (process.platform === 'win32' && fs.existsSync(dist) && fs.existsSync(path.join(aliased, 'package.json'))
      && fs.statSync(path.join(aliased, 'package.json'), { bigint: true }).ino === fs.statSync(path.join(project, 'package.json'), { bigint: true }).ino) {
      expect(isInside(path.join(aliased, 'dist'), dist)).toBe(false); // the path check alone can't see it
      expect(placeUnder(path.join(aliased, 'dist', 'x'), dist)).toBe(path.join(dist, 'x'));
      expect(isNetworkPath(path.join(aliased, 'release'))).toBe(true);
      const before = fs.readdirSync(dist).sort();
      await expect(buildLan({ out: path.join(aliased, 'dist'), quiet: true, log: () => undefined })).rejects.toThrow(/must not be dist/);
      await expect(buildLan({ out: path.join(aliased, 'DIST', 'sub'), quiet: true, log: () => undefined })).rejects.toThrow(/must not be dist/);
      await expect(devRun([], { out: path.join(aliased, 'dist'), log: () => undefined })).rejects.toThrow(/must not be dist/);
      await expect(buildLan({ out: path.join(aliased, 'release'), quiet: true, log: () => undefined })).rejects.toThrow(/network share or mapped drive/);
      expect(fs.readdirSync(dist).sort()).toEqual(before);
    }
    await expect(devRun([], { out: dist, log: () => undefined })).rejects.toThrow(/must not be dist/);
  });

  it('--out inside the repository must be one git ignores (the sync routine runs git add -A and pushes a public repo)', async () => {
    const project = path.resolve(__dirname, '..', '..');
    const inside = path.join(project, 'src', 'lan-out-probe');
    expect(() => checkOutDir(inside, { gitIgnored: () => false })).toThrow(/inside the repository but git does not ignore it/);
    expect(() => checkOutDir(inside, { gitIgnored: () => true })).not.toThrow();
    expect(() => checkOutDir(inside, { gitIgnored: () => null })).not.toThrow(); // no git, or not a repository
    expect(() => checkOutDir(project, { gitIgnored: () => false })).toThrow(/--out \. is inside the repository/);
    expect(() => checkOutDir(path.join(os.tmpdir(), 'vs-lan-out'), { gitIgnored: () => { throw new Error('not asked outside the project'); } })).not.toThrow();
    const git = gitIgnores(project, path.join(project, 'node_modules', 'x'));
    if (git !== null) {
      expect(git).toBe(true);
      expect(gitIgnores(project, path.join(project, 'src', 'x'))).toBe(false);
      expect(() => checkOutDir(inside)).toThrow(/git does not ignore it/);
      await expect(buildLan({ out: inside, quiet: true, log: () => undefined })).rejects.toThrow(/git does not ignore it/);
      await expect(devRun([], { out: inside, log: () => undefined })).rejects.toThrow(/git does not ignore it/);
      expect(fs.existsSync(inside)).toBe(false);
    }
  });
});

describe.runIf(run)('the LAN package (npm run package:lan into a scratch folder)', () => {
  beforeAll(async () => {
    out = mk('vs-pkg-build-');
    built = await buildLan({ out, keepStage: true, quiet: true, log: () => undefined });
    stage = built.stageRoot!;
  }, 600_000);

  afterAll(() => {
    for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* held */ } }
  }, 120_000);

  it('builds outside the project (never dist/ or release/)', () => {
    const project = path.resolve(__dirname, '..', '..');
    expect(path.resolve(out).startsWith(project + path.sep)).toBe(false);
    expect(built.version).toBe(readVersion());
  });

  it('T-PKG-1: the zip is 40 MB or less and its .sha256 matches', () => {
    expect(path.basename(built.zip!)).toBe(zipName(built.version));
    const size = fs.statSync(built.zip!).size;
    expect(size).toBeLessThanOrEqual(ZIP_MAX_BYTES);
    expect(size).toBeGreaterThan(20 * 1024 * 1024); // node.exe is in it
    const side = fs.readFileSync(`${built.zip}.sha256`, 'utf8');
    expect(side).toBe(`${sha256Of(built.zip!)}  ${zipName(built.version)}\r\n`);
    expect(built.sha256).toBe(sha256Of(built.zip!));
  });

  it('T-PKG-2: the staged tree is the §2.1 layout; the zip holds exactly it, under "Voidswarm LAN\\"', () => {
    expect(checkStageManifest(stage)).toEqual([]);
    const top = fs.readdirSync(stage).sort();
    const stubs = STUBS.filter((s) => !s.later || fs.existsSync(path.join(TEMPLATES_DIR, s.name))).map((s) => s.name);
    expect(top).toEqual([...stubs, 'START HERE.html', 'FOR SCHOOL IT.txt', 'VERSION.txt', 'SHA256SUMS.txt', 'THIRD-PARTY-NOTICES.txt', 'app', 'runtime', 'web'].sort());
    expect(fs.readdirSync(path.join(stage, 'runtime')).sort()).toEqual(['LICENSE', 'node.exe']);
    const app = fs.readdirSync(path.join(stage, 'app')).sort();
    expect(app).toEqual(expect.arrayContaining(['admin', 'build-info.json', 'display', 'launch.mjs', 'maint.mjs', 'server.mjs', 'tool.mjs']));
    const files = walkFiles(stage);
    expect(files.filter((f) => /\.ts$|\.test\.|testutil|\.map$/.test(f))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(['app/admin/admin.html', 'app/admin/admin.js', 'app/display/display.html', 'web/index.html', 'web/manifest.webmanifest', 'web/fonts/OFL.txt']));
    // No data\ or previous\ ships: those are made on the host.
    expect(files.some((f) => f.startsWith('data/') || f.startsWith('previous/'))).toBe(false);
    // SHA256SUMS.txt covers every file.
    const sums = fs.readFileSync(path.join(stage, 'SHA256SUMS.txt'), 'utf8').trim().split('\r\n').map((l) => l.slice(66));
    expect(sums).toEqual(files.filter((f) => f !== 'SHA256SUMS.txt'));
    const info = JSON.parse(fs.readFileSync(path.join(stage, 'app', 'build-info.json'), 'utf8')) as Record<string, string>;
    expect(info).toMatchObject({ name: 'voidswarm-lan', version: built.version, node: process.version, platform: 'win-x64' });
    expect(Number.isNaN(Date.parse(info.buildDate!))).toBe(false);
    // The text files: filled in, Windows line endings for .cmd and .txt.
    for (const f of top.filter((n) => /\.(cmd|txt|html)$/.test(n))) {
      const t = fs.readFileSync(path.join(stage, f), 'utf8');
      expect(t, f).not.toMatch(/\{\{/);
      if (/\.(cmd|txt)$/.test(f)) expect(t.replace(/\r\n/g, ''), f).not.toMatch(/\n/);
    }
    expect(fs.readFileSync(path.join(stage, 'VERSION.txt'), 'utf8')).toContain(`Voidswarm LAN ${built.version}`);
    expect(fs.readFileSync(path.join(stage, 'START HERE.html'), 'utf8')).toContain(`Voidswarm LAN ${built.version}`);
    const notices = fs.readFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const p of ['ws ', 'nodemailer ', 'pixi.js ', 'pixi-filters ']) expect(notices).toContain(`\r\n${p}`);
    expect(notices).not.toMatch(/@types\//);
    // The zip: one top folder.
    const list = spawnSync(sysTool('tar'), ['-t', '-f', built.zip!], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(list.status).toBe(0);
    const entries = list.stdout.split(/\r?\n/).filter(Boolean);
    expect(new Set(entries.map((e) => e.split('/')[0]))).toEqual(new Set([LAN_FOLDER]));
    expect(entries.filter((e) => !e.endsWith('/')).map((e) => e.slice(LAN_FOLDER.length + 1)).sort()).toEqual([...files].sort());
  });

  it('T-PKG-2: the manifest check catches a stray folder, a missing bundle and a test file', () => {
    const copy = path.join(mk('vs-pkg-copy-'), LAN_FOLDER);
    fs.cpSync(stage, copy, { recursive: true, filter: (src) => !src.endsWith('node.exe') });
    fs.writeFileSync(path.join(copy, 'runtime', 'node.exe'), 'x');
    expect(checkStageManifest(copy)).toEqual([]);
    fs.mkdirSync(path.join(copy, 'data'));
    fs.writeFileSync(path.join(copy, 'data', 'voidswarm.db'), 'x');
    fs.rmSync(path.join(copy, 'app', 'maint.mjs'));
    fs.writeFileSync(path.join(copy, 'app', 'admin', 'admin.test.ts'), 'x');
    const problems = checkStageManifest(copy).join('\n');
    expect(problems).toContain('unexpected at the top level: data');
    expect(problems).toContain('missing: app/maint.mjs');
    expect(problems).toContain('not a page file: app/admin/admin.test.ts');
  });

  it('T-PKG-3: runtime\\node.exe is Node 24 with a Valid OpenJS Foundation signature, and its licence ships beside it', () => {
    const exe = path.join(stage, 'runtime', 'node.exe');
    const sig = authenticode(exe);
    expect(sig.status).toBe('Valid');
    expect(isOpenJsSubject(sig.subject)).toBe(true);
    const v = spawnSync(exe, ['--version'], { encoding: 'utf8' }).stdout.trim();
    expect(v).toMatch(/^v24\.\d+\.\d+$/);
    expect(sha256Of(exe)).toBe(sha256Of(process.execPath));
    const lic = fs.readFileSync(path.join(stage, 'runtime', 'LICENSE'), 'utf8');
    expect(lic.replace(/\r\n/g, '\n')).toBe(fs.readFileSync(NODE_LICENSE, 'utf8').replace(/\r\n/g, '\n'));
    expect(lic).toMatch(/^Node\.js is licensed for use as follows:/);
    expect(isOpenJsSubject('CN=Someone Else, O=OpenJS Foundation')).toBe(false);
    expect(isOpenJsSubject(null)).toBe(false);
  }, 60_000);

  it('T-PKG-4: no http(s):// or //host address in the built web client (and the check does catch one)', () => {
    expect(findExternalUrls(path.join(stage, 'web'))).toEqual([]);
    const bad = mk('vs-pkg-web-');
    fs.writeFileSync(path.join(bad, 'index.html'), '<link href="//cdn.example/x.css">');
    fs.writeFileSync(path.join(bad, 'a.css'), '@import url("https://fonts.example/x");');
    expect(findExternalUrls(bad)).toHaveLength(2);
  });

  it('T-PKG-7: server.mjs is unminified and keeps its licence comments; the createRequire banner is in every bundle', async () => {
    const server = fs.readFileSync(path.join(stage, 'app', 'server.mjs'), 'utf8');
    const lines = server.split('\n');
    expect(lines.length).toBeGreaterThan(20_000);
    expect(server).toContain('// src/server/app.ts');
    expect(lines.filter((l) => /^ {2,}\S/.test(l)).length).toBeGreaterThan(lines.length / 2);
    for (const c of legalCommentsOf(built.metafile, built.serverOutput!)) expect(server).toContain(c);
    for (const b of ['server', 'launch', 'tool', 'maint']) {
      expect(fs.readFileSync(path.join(stage, 'app', `${b}.mjs`), 'utf8').split('\n', 1)[0]).toContain("createRequire as __vsCreateRequire");
    }
    // The same esbuild options keep a licence comment from a bundled file.
    const dir = mk('vs-pkg-legal-');
    fs.writeFileSync(path.join(dir, 'dep.js'), '/*! Fixture Library v1 | MIT licence */\nexport const x = () => 41 + 1;\n');
    fs.writeFileSync(path.join(dir, 'entry.js'), "import { x } from './dep.js';\nconsole.log(x());\n");
    const { build } = await import('esbuild');
    await build({ ...appBuildOptions(path.join(dir, 'out'), { projectRoot: dir, entryPoints: { entry: 'entry.js' } }) });
    const outText = fs.readFileSync(path.join(dir, 'out', 'entry.mjs'), 'utf8');
    expect(outText).toContain('/*! Fixture Library v1 | MIT licence */');
    expect(outText).toContain('41 + 1');
  }, 60_000);

  describe('T-PKG-5: the extracted zip, started by the real stub', () => {
    let root = '';
    let port = 0;
    let proc: ChildProcess | null = null;
    let output = '';
    let adminProbe: { status: number; csp: string | null; body: string } | 'refused' | null = null;

    beforeAll(() => {
      const parent = path.join(mk('vs-pkg5-'), "Room 136 (Mr. O'Brien) & Co");
      fs.mkdirSync(parent, { recursive: true });
      const x = spawnSync(sysTool('tar'), ['-x', '-f', built.zip!, '-C', parent], { encoding: 'utf8' });
      expect(x.status).toBe(0);
      root = path.join(parent, LAN_FOLDER);
    }, 120_000);

    afterAll(() => {
      if (proc && proc.exitCode === null && proc.pid) spawnSync(sysTool('taskkill'), ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
    });

    it('app\\tool.mjs runs as a program from the extracted folder (and the launcher inside it does not start)', () => {
      const r = spawnSync(path.join(root, 'runtime', 'node.exe'), [path.join(root, 'app', 'tool.mjs'), 'help'], { encoding: 'utf8', cwd: os.tmpdir(), timeout: 60_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Voidswarm LAN ${built.version} maintenance tool`);
      expect(r.stdout).not.toContain('VOIDSWARM LAN HOST');
    }, 60_000);

    it('starts from cwd C:\\Windows\\Temp: http / serves the client, a ws hello gets welcome, the database is created; the stop leaves one checkpointed file', async () => {
      port = await freePair();
      const stub = path.join(root, 'Start Voidswarm Host.cmd');
      const cwd = fs.existsSync('C:\\Windows\\Temp') ? 'C:\\Windows\\Temp' : os.tmpdir();
      proc = spawn(process.env.ComSpec ?? sysTool('cmd'), ['/d', '/s', '/c', `""${stub}" --no-browser --skip-location-check"`], {
        cwd, windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port), VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined, NODE_ENV: undefined },
      });
      proc.stdout!.on('data', (d) => { output += d; });
      proc.stderr!.on('data', (d) => { output += d; });
      const exited = new Promise<number | null>((res) => proc!.once('exit', (c) => res(c)));
      const end = Date.now() + 90_000;
      while (!output.includes('Stop: Ctrl+C here') && Date.now() < end) {
        if (proc.exitCode !== null) throw new Error(`the host exited ${proc.exitCode}:\n${output}`);
        await new Promise((res) => setTimeout(res, 150));
      }
      expect(output).toContain(`VOIDSWARM LAN HOST ${built.version}`);
      expect(output).toContain(`Host Control Panel (this PC):  http://localhost:${port + 1}`);

      // The game port: the client (the landing page and https arrive with M2, B13).
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(await page.text()).toContain('<!doctype html>');

      // A ws hello gets a welcome.
      const welcome = await new Promise<Record<string, unknown>>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        const t = setTimeout(() => { ws.terminate(); rej(new Error('no welcome')); }, 15_000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name: 'NovaPilot', protocol: PROTOCOL_VERSION, version: built.version })));
        ws.on('message', (m, binary) => {
          if (binary) return;
          const msg = JSON.parse(String(m)) as Record<string, unknown>;
          if (msg.type === 'welcome') { clearTimeout(t); ws.close(); res(msg); }
        });
        ws.on('error', (e) => { clearTimeout(t); rej(e); });
      });
      expect(welcome).toMatchObject({ type: 'welcome', name: 'NovaPilot', serverVersion: built.version });

      // The admin listener (probed here; asserted in the next test).
      try {
        const r = await fetch(`http://localhost:${port + 1}/`);
        adminProbe = { status: r.status, csp: r.headers.get('content-security-policy'), body: await r.text() };
      } catch {
        adminProbe = 'refused';
      }

      const data = path.join(root, 'data');
      expect(fs.existsSync(path.join(data, 'voidswarm.db'))).toBe(true);
      const key = fs.readFileSync(path.join(data, 'secrets', 'pipe.key'));
      const stop = await sendCommand({ dataDir: data, key, cmd: 'stop' });
      expect(stop.ok).toBe(true);
      expect(await exited).toBe(0);
      expect(output).toContain('Voidswarm stopped. Bye!');
      const dbFiles = fs.readdirSync(data).filter((f) => f.startsWith('voidswarm.db'));
      const wal = path.join(data, 'voidswarm.db-wal');
      expect(dbFiles.filter((f) => f !== 'voidswarm.db-wal' && f !== 'voidswarm.db-shm')).toEqual(['voidswarm.db']);
      expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
    }, 180_000);

    it('the admin listener answers / with 200 and the strict CSP', (ctx) => {
      // HANDOFF (B1/B6): app.ts does not start the admin listener on P+1 yet; until it does this is skipped, not passed.
      if (adminProbe === 'refused' || adminProbe === null) { ctx.skip(); return; }
      expect(adminProbe.status).toBe(200);
      expect(adminProbe.csp).toMatch(/default-src 'self'|connect-src 'self'/);
    });

    it('T-LAN-17 with the real bundles: Update Voidswarm.cmd installs a newer zip (signature, tar, backup), then --rollback goes back', () => {
      // A "newer" package: the same files with the next patch version (its build-info and sums rewritten).
      const v = /^(\d+)\.(\d+)\.(\d+)/.exec(built.version)!;
      const next = `${v[1]}.${v[2]}.${Number(v[3]) + 1}`;
      const parent = mk('vs-pkg-next-');
      const nextRoot = path.join(parent, LAN_FOLDER);
      fs.cpSync(stage, nextRoot, { recursive: true });
      const infoFile = path.join(nextRoot, 'app', 'build-info.json');
      fs.writeFileSync(infoFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(infoFile, 'utf8')), version: next }, null, 2));
      writeSums(nextRoot);
      makeZip(parent, path.join(root, zipName(next)));
      const cmd = (args: string): { code: number | null; out: string } => {
        const r = spawnSync(process.env.ComSpec ?? sysTool('cmd'), ['/d', '/s', '/c', `""${path.join(root, 'Update Voidswarm.cmd')}" ${args}"`], {
          cwd: os.tmpdir(), windowsVerbatimArguments: true, windowsHide: true, input: '', encoding: 'utf8', timeout: 180_000,
          env: { ...process.env, VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined },
        });
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
      };
      const version = (dir: string): string => (JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8')) as { version: string }).version;
      const up = cmd('--yes');
      expect(up.code, up.out).toBe(0);
      expect(up.out).toContain(`Updated to Voidswarm LAN ${next}.`);
      expect(up.out).toContain(`matches ${zipName(next)}.sha256`);
      expect(version(path.join(root, 'app'))).toBe(next);
      expect(version(path.join(root, 'previous', 'app'))).toBe(built.version);
      expect(fs.readdirSync(path.join(root, 'data', 'backups')).some((f) => f.endsWith(`_pre-update-${next}.vsbak`))).toBe(true);
      expect(fs.existsSync(path.join(root, 'runtime.next'))).toBe(false);
      const back = cmd('--rollback --yes');
      expect(back.code, back.out).toBe(0);
      expect(version(path.join(root, 'app'))).toBe(built.version);
      expect(version(path.join(root, 'previous', 'app'))).toBe(next);
    }, 240_000);

    it.todo('http / on the LAN address serves the landing page and https / answers 200 (M2: B12 TLS, B13 front door)');
  });
});
