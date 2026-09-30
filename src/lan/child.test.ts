import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as app from '../server/app';
import { PROTOCOL_VERSION } from '../shared/version';
import {
  CHILD_EXIT_CRASH, CHILD_EXIT_DATA, CHILD_EXIT_LISTEN, CHILD_EXIT_OK, CHILD_EXIT_USAGE, ServerChild, Supervisor, childEnv,
  dataDirConflict, permissionFlag, sandboxExecArgv, type SupervisorEvent,
} from './child';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-b4b-child-'));
afterAll(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ } });
let seq = 0;
/** An install-like root: <tmp>\t<n>\Room 136 (Mr. O'Brien) & Co\Voidswarm LAN with app\ and data\. */
const makeRoot = (): { root: string; app: string; data: string } => {
  const root = path.join(tmpRoot, `t${seq++}`, "Room 136 (Mr. O'Brien) & Co", 'Voidswarm LAN');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return { root, app: path.join(root, 'app'), data: path.join(root, 'data') };
};

async function bundle(opts: { entry?: string; contents?: string; outfile: string }): Promise<void> {
  const { build } = await import('esbuild');
  await build({
    ...(opts.contents
      ? { stdin: { contents: opts.contents, resolveDir: repoRoot, loader: 'ts' as const, sourcefile: 'probe.ts' } }
      : { entryPoints: [opts.entry!] }),
    absWorkingDir: repoRoot,
    outfile: opts.outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false, logLevel: 'silent',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __vsCreateRequire } from 'node:module'; const require = __vsCreateRequire(import.meta.url);" },
  });
}

interface FakeMode {
  /** Send 'fatal' and exit with this code before 'ready'. */
  exitBeforeReady?: number;
  noReady?: boolean;
  /** The first N starts crash (exit 1) shortly after 'ready'. */
  crashAfterReadyTimes?: number;
  exitZeroAfter?: number;
  /** Exit 0 right after lan:start, before 'ready'. */
  exitZeroBeforeReady?: boolean;
  ignoreStop?: boolean;
  setupPending?: boolean;
  /** Say 'ready' only after this long (ms). */
  readyAfter?: number;
  /** Like src/server/app.ts: the 'stop' handler exists only once it listens, so an earlier stop is lost. */
  stopOnlyAfterReady?: boolean;
  /** Before 'ready': send {type:'progress'} every `every` ms, `count` times (the migration's heartbeat). */
  progress?: { every: number; count: number };
}

/** A stand-in server: speaks the IPC protocol, records every lan:start in <dataDir>\fake-starts.jsonl. */
function fakeServer(dir: string, mode: FakeMode): string {
  const file = path.join(dir, `fake-${seq++}.mjs`);
  fs.writeFileSync(file, `
import fs from 'node:fs';
import path from 'node:path';
const MODE = ${JSON.stringify(mode)};
let listening = false;
let dataDir = '.';
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'lan:start') {
    dataDir = m.dataDir;
    const f = path.join(m.dataDir, 'fake-starts.jsonl');
    fs.appendFileSync(f, JSON.stringify({ pid: process.pid, argv: process.argv, execArgv: process.execArgv, envKeys: Object.keys(process.env), start: m }) + '\\n');
    const count = fs.readFileSync(f, 'utf8').trim().split('\\n').length;
    if (MODE.exitBeforeReady) {
      process.send({ type: 'fatal', code: 'EADDRINUSE', exitCode: MODE.exitBeforeReady, message: 'Port ' + m.port + ' is already in use (fake).' });
      setTimeout(() => process.exit(MODE.exitBeforeReady), 30);
      return;
    }
    if (MODE.noReady) return;
    if (MODE.exitZeroBeforeReady) { setTimeout(() => process.exit(0), 30); return; }
    const sendReady = () => {
      listening = true;
      process.send({ type: 'ready', port: m.port, bind: m.bind, version: 'fake', accounts: true, chatLog: true, profiles: true,
        ...(MODE.setupPending !== undefined ? { setupPending: MODE.setupPending } : {}) });
      if (MODE.crashAfterReadyTimes && count <= MODE.crashAfterReadyTimes) setTimeout(() => process.exit(1), 40);
      if (MODE.exitZeroAfter) setTimeout(() => process.exit(0), MODE.exitZeroAfter);
    };
    if (MODE.progress) {
      let sent = 0;
      const t = setInterval(() => {
        if (sent++ < MODE.progress.count) { process.send({ type: 'progress', text: 'migrating' }); return; }
        clearInterval(t);
        sendReady();
      }, MODE.progress.every);
    } else if (MODE.readyAfter) setTimeout(sendReady, MODE.readyAfter);
    else sendReady();
  } else if (m.type === 'stop') {
    fs.appendFileSync(path.join(dataDir, 'fake-stops.txt'), (listening ? 'heard' : 'lost') + '\\n');
    if (MODE.stopOnlyAfterReady && !listening) return;
    if (!MODE.ignoreStop) setTimeout(() => process.exit(0), 20);
  } else if (m.type === 'status') {
    process.send({ type: 'status', online: 2, rooms: 5 });
  }
});
process.on('disconnect', () => { if (!MODE.ignoreStop) process.exit(0); });
setInterval(() => {}, 1000);
`);
  return file;
}

const starts = (data: string): { pid: number; argv: string[]; execArgv: string[]; envKeys: string[]; start: Record<string, unknown> }[] => {
  const f = path.join(data, 'fake-starts.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

const startMsg = (data: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'lan:start', dataDir: data, port: 0, bind: '127.0.0.1', preset: 'home', secrets: { v: 1, secrets: {} }, setupCode: 'K7QP4MXD', ...extra,
});

describe('exit codes and flags', () => {
  it('the launcher\'s copy of the exit codes matches src/server/app.ts', () => {
    expect([CHILD_EXIT_OK, CHILD_EXIT_CRASH, CHILD_EXIT_LISTEN, CHILD_EXIT_DATA, CHILD_EXIT_USAGE])
      .toEqual([app.EXIT_OK, app.EXIT_CRASH, app.EXIT_LISTEN, app.EXIT_DATA, app.EXIT_USAGE]);
  });

  it('sandbox flags: read the root, write data\\ only, no workers / child processes / addons / WASI', () => {
    const root = "C:\\Users\\x\\Room 136 (Mr. O'Brien) & Co\\Voidswarm LAN";
    const flags = sandboxExecArgv({ root, dataDir: `${root}\\data`, platform: 'win32' });
    expect(flags).toContain('--permission');
    expect(flags).toContain(`--allow-fs-read=${root}`);
    expect(flags).toContain(`--allow-fs-write=${root}\\data`);
    // A worker thread's permissions are not pinned to the child's (Node 24): no --allow-worker, and no silencing of
    // the SecurityWarning a future --allow-* grant would print.
    expect(flags).not.toContain('--allow-worker');
    expect(flags).not.toContain('--disable-warning=SecurityWarning');
    expect(flags.filter((f) => f.startsWith('--allow-fs-read'))).toHaveLength(1);
    for (const f of flags) expect(f).not.toMatch(/--allow[-_](worker|child[-_]process|addons|wasi|inspector)|--allow-fs-write=\*|--allow-fs-read=\*/);
    // A --data folder outside the root is readable too (and still the only writable place).
    const outside = sandboxExecArgv({ root, dataDir: 'D:\\VS data', platform: 'win32' });
    expect(outside).toContain('--allow-fs-read=D:\\VS data');
    expect(outside).toContain('--allow-fs-write=D:\\VS data');
    // Case-insensitive on Windows: data inside the root adds no second read grant.
    expect(sandboxExecArgv({ root, dataDir: `${root.toUpperCase()}\\DATA`, platform: 'win32' }).filter((f) => f.startsWith('--allow-fs-read'))).toHaveLength(1);
  });

  it('a data folder that is, holds, or sits inside the program folders is never granted (the child could replace app\\launch.mjs)', () => {
    const root = "C:\\Users\\x\\Room 136 (Mr. O'Brien) & Co\\Voidswarm LAN";
    const bad: [string, RegExp][] = [
      [root, /the Voidswarm folder itself/],
      [root.toUpperCase(), /the Voidswarm folder itself/],
      ['C:\\Users\\x', /contains the Voidswarm folder/],
      ['C:\\', /contains the Voidswarm folder/],
      [`${root}\\app`, /own app\\ folder/],
      [`${root}\\app\\data`, /own app\\ folder/],
      [`${root}\\runtime\\d`, /own runtime\\ folder/],
      [`${root}\\web`, /own web\\ folder/],
      [`${root}\\previous\\data`, /own previous\\ folder/],
    ];
    for (const [d, why] of bad) {
      expect(dataDirConflict(root, d, 'win32'), d).toMatch(why);
      expect(() => sandboxExecArgv({ root, dataDir: d, platform: 'win32' }), d).toThrow(/can't be used/);
    }
    for (const d of [`${root}\\data`, 'D:\\VS data', `${root}\\data\\sub`, `${root} data`, 'C:\\Users\\x\\Voidswarm LAN2\\data', `${root}\\apps`]) {
      expect(dataDirConflict(root, d, 'win32'), d).toBeNull();
    }
    expect(dataDirConflict('/opt/vs', '/opt', 'linux')).toMatch(/contains/);
    expect(dataDirConflict('/opt/vs', '/opt/vs/data', 'linux')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('…also through a junction to the Voidswarm folder', () => {
    const { root } = makeRoot();
    const link = path.join(tmpRoot, `junction-${seq++}`);
    fs.symlinkSync(root, link, 'junction');
    expect(dataDirConflict(root, link)).toMatch(/itself/);
    expect(dataDirConflict(root, path.join(link, 'app', 'not-yet'))).toMatch(/own app\\ folder/);
    expect(dataDirConflict(root, path.join(link, 'data'))).toBeNull();
  });

  // Skipped on GitHub runners (admin account, runner drive layout); runs on a normal Windows profile.
  it.runIf(process.platform === 'win32' && process.env.GITHUB_ACTIONS !== 'true')('a root reached through a junction is granted by its real path too, and the child starts', async () => {
    const { root, data: realData } = makeRoot();
    const link = path.join(tmpRoot, `junction-${seq++}`);
    fs.symlinkSync(root, link, 'junction');
    const real = fs.realpathSync.native(root);
    const flags = sandboxExecArgv({ root: link, dataDir: path.join(link, 'data') });
    expect(flags).toEqual(expect.arrayContaining([
      `--allow-fs-read=${link}`, `--allow-fs-read=${real}`,
      `--allow-fs-write=${path.join(link, 'data')}`, `--allow-fs-write=${path.join(real, 'data')}`,
    ]));
    // A path that is already real gets a single grant each.
    const plain = sandboxExecArgv({ root: real, dataDir: path.join(real, 'data') });
    expect(plain.filter((f) => f.startsWith('--allow-fs-read'))).toHaveLength(1);
    expect(plain.filter((f) => f.startsWith('--allow-fs-write'))).toHaveLength(1);
    // Before the fix the child died at module load (FileSystemRead on the junction) and was retried 3 times.
    const data = path.join(link, 'data');
    const entry = fakeServer(path.join(link, 'app'), {});
    const child = new ServerChild({ entry, root: link, dataDir: data, start: startMsg(data) });
    const ready = await child.ready;
    expect(ready.type).toBe('ready');
    expect((await child.stop('test')).code).toBe(0);
    expect(fs.existsSync(path.join(realData, 'fake-starts.jsonl'))).toBe(true);
  }, 30_000);

  it('a comma in a granted path silences Node 24\'s "comma-separated list" warning (only then)', () => {
    const plain = sandboxExecArgv({ root: 'C:\\Users\\x\\Voidswarm LAN', dataDir: 'C:\\Users\\x\\Voidswarm LAN\\data', platform: 'win32' });
    expect(plain).not.toContain('--disable-warning=Warning');
    const comma = sandboxExecArgv({ root: 'C:\\Users\\x\\Room 1, 2\\Voidswarm LAN', dataDir: 'C:\\Users\\x\\Room 1, 2\\Voidswarm LAN\\data', platform: 'win32' });
    expect(comma).toContain('--disable-warning=Warning');
    expect(comma).toContain('--allow-fs-write=C:\\Users\\x\\Room 1, 2\\Voidswarm LAN\\data');
  });

  it('the permission switch for older Node releases (the npm path on a Mac / Linux host)', () => {
    expect(permissionFlag('24.16.0')).toBe('--permission');
    expect(permissionFlag('22.13.1')).toBe('--permission');
    expect(permissionFlag('23.5.0')).toBe('--permission');
    expect(permissionFlag('22.12.0')).toBe('--experimental-permission');
    expect(permissionFlag('20.18.0')).toBe('--experimental-permission');
    expect(sandboxExecArgv({ root: '/opt/vs', dataDir: '/opt/vs/data', platform: 'linux', nodeVersion: '22.4.0' })[0]).toBe('--experimental-permission');
  });

  // childEnv() is what the launcher passes. On Windows libuv then adds the variables a process needs (PATH, SYSTEMROOT,
  // LOGONSERVER, …) to the block it hands CreateProcess, so a real child sees those too; none of them is a secret.
  it('the child environment is an allowlist: no secrets, no Node flags, no VPS knobs', () => {
    const env = childEnv({
      SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', USERPROFILE: 'C:\\Users\\x', Path: 'C:\\Windows', SMTP_PASS: 'hunter2hunter2', SMTP_HOST: 'smtp.caldwellschools.org',
      NODE_OPTIONS: '--allow-fs-write=*', NODE_PATH: 'x', TRUST_PROXY: '1', PUBLIC_URL: 'https://x', VITEST: 'true', DB_PATH: 'x', API_TOKEN: 't', TZ: 'America/Boise',
      systemroot_dup: 'no',
    });
    expect(env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', USERPROFILE: 'C:\\Users\\x', TZ: 'America/Boise' });
    expect(childEnv({ systemroot: 'C:\\Windows' })).toEqual({ systemroot: 'C:\\Windows' });
  });
});

describe('ServerChild and the supervisor (§2.2 step 14)', () => {
  it('start message first, ready, status over IPC, then a requested stop exits 0', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), {});
    const env = { ...process.env, SMTP_PASS: 'never-in-the-child-9' };
    const child = new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { secrets: { v: 1, secrets: { 'pepper.key': Buffer.alloc(32, 7).toString('base64') } } }), env });
    const ready = await child.ready;
    expect(ready.bind).toBe('127.0.0.1');
    expect(await child.status()).toMatchObject({ online: 2, rooms: 5 });
    const exit = await child.stop('test');
    expect(exit).toMatchObject({ code: 0, requested: true });
    const [rec] = starts(data);
    // Secrets arrive over IPC, never in argv or the environment.
    expect(rec.start.secrets).toEqual({ v: 1, secrets: { 'pepper.key': Buffer.alloc(32, 7).toString('base64') } });
    expect(rec.envKeys).not.toContain('SMTP_PASS');
    expect(rec.envKeys.some((k) => /^VITEST/i.test(k))).toBe(false);
    expect(JSON.stringify(rec.argv)).not.toContain('never-in-the-child');
    expect(rec.argv.slice(2)).toEqual(['--lan']);
    expect(rec.execArgv).toContain('--permission');
    expect(await child.status()).toBeNull(); // gone
  });

  it('restarts a crashed child, telling the new one when; at most 3 times in 10 minutes, then gives up (exit 1)', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), { crashAfterReadyTimes: 99 });
    const events: SupervisorEvent[] = [];
    const sup = new Supervisor({
      spawn: (restart) => new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { restart }) }),
      restartDelayMs: 10,
      onEvent: (e) => events.push(e),
    });
    await sup.start();
    const result = await sup.finished;
    expect(result.reason).toBe('gave-up');
    expect(result.exitCode).toBe(CHILD_EXIT_CRASH);
    expect(result.message).toMatch(/4 times within 10 minutes/);
    const recs = starts(data);
    expect(recs).toHaveLength(4);
    expect(recs[0].start.restart).toBeNull();
    expect(recs.slice(1).map((r) => (r.start.restart as { count: number }).count)).toEqual([1, 2, 3]);
    expect((recs[1].start.restart as { exitCode: number }).exitCode).toBe(1);
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'crashed').map((e) => (e as { willRestart: boolean }).willRestart)).toEqual([true, true, true, false]);
  }, 20_000);

  it('the restart budget is per 10-minute window', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), { crashAfterReadyTimes: 5 });
    let t = 0;
    const readies: number[] = [];
    const sup = new Supervisor({
      spawn: (restart) => { t += 11 * 60_000; return new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { restart }) }); },
      restartDelayMs: 10,
      now: () => t,
      onEvent: (e) => { if (e.type === 'ready') readies.push(e.restart?.count ?? 0); },
    });
    await sup.start();
    while (readies.length < 6) await new Promise((r) => setTimeout(r, 50));
    expect(readies).toEqual([0, 1, 2, 3, 4, 5]);
    const res = await sup.stop('test');
    expect(res.reason).toBe('requested');
    expect(res.exitCode).toBe(0);
  }, 20_000);

  it('exit 2 / 3 / 4 are not retried: start() rejects with the child\'s own message', async () => {
    for (const code of [CHILD_EXIT_LISTEN, CHILD_EXIT_DATA, CHILD_EXIT_USAGE]) {
      const { root, data } = makeRoot();
      const entry = fakeServer(path.join(root, 'app'), { exitBeforeReady: code });
      const sup = new Supervisor({ spawn: (restart) => new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { restart, port: 4321 }) }), restartDelayMs: 10 });
      const err = await sup.start().then(() => null, (e: Error & { result?: { exitCode: number; reason: string } }) => e);
      expect(err?.result).toMatchObject({ exitCode: code, reason: 'fatal' });
      expect(err?.message).toBe('Port 4321 is already in use (fake).');
      expect(starts(data)).toHaveLength(1);
    }
  }, 20_000);

  it('a child that exits 0 by itself (the panel\'s Stop) ends the host', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), { exitZeroAfter: 50 });
    const sup = new Supervisor({ spawn: () => new ServerChild({ entry, root, dataDir: data, start: startMsg(data) }) });
    await sup.start();
    expect(await sup.finished).toMatchObject({ reason: 'server-stopped', exitCode: 0 });
  });

  it('a child that exits 0 BEFORE it was ready is a failed start (a crash, retried), never "stopped from the control panel"', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), { exitZeroBeforeReady: true });
    const events: SupervisorEvent[] = [];
    const sup = new Supervisor({
      spawn: (restart) => new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { restart }) }),
      restartDelayMs: 10,
      maxRestarts: 1,
      onEvent: (e) => events.push(e),
    });
    const err = await sup.start().then(() => null, (e: Error & { result?: { reason: string; exitCode: number; message: string; exit: { code: number; wasReady: boolean } } }) => e);
    expect(err?.result).toMatchObject({ reason: 'gave-up', exitCode: CHILD_EXIT_CRASH, exit: { code: 0, wasReady: false } });
    expect(err?.result?.message).not.toMatch(/control panel/);
    expect(starts(data)).toHaveLength(2);
    expect(events.filter((e) => e.type === 'crashed')).toHaveLength(2);
  }, 20_000);

  it('a start message that can\'t be built (a damaged secret) ends with ITS exit code, not a crash', async () => {
    const sup = new Supervisor({ spawn: () => { throw Object.assign(new Error('data\\secrets\\pepper.key is damaged.'), { exitCode: CHILD_EXIT_DATA }); } });
    const err = await sup.start().then(() => null, (e: Error & { result?: { reason: string; exitCode: number } }) => e);
    expect(err?.result).toMatchObject({ reason: 'fatal', exitCode: CHILD_EXIT_DATA });
    expect(err?.message).toMatch(/could not be started: data\\secrets\\pepper\.key is damaged/);
    const plain = new Supervisor({ spawn: () => { throw new Error('EACCES'); } });
    await plain.start().catch(() => undefined);
    expect(await plain.finished).toMatchObject({ reason: 'fatal', exitCode: CHILD_EXIT_CRASH });
  });

  it('respawn(): a planned replacement with a fresh start message, outside the restart budget; stop() during it ends the host', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), {});
    const events: SupervisorEvent[] = [];
    let spawns = 0;
    const sup = new Supervisor({
      spawn: (restart) => { spawns++; return new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { restart, bind: spawns === 1 ? '192.168.1.50' : '127.0.0.1' }) }); },
      restartDelayMs: 10,
      maxRestarts: 0,
      onEvent: (e) => events.push(e),
    });
    const first = await sup.start();
    expect(first.bind).toBe('192.168.1.50');
    const firstPid = sup.current!.pid;
    const second = await sup.respawn('first-run setup pending');
    expect(second.bind).toBe('127.0.0.1');
    expect(sup.current!.pid).not.toBe(firstPid);
    expect(sup.restartCount).toBe(0);
    const recs = starts(data);
    expect(recs).toHaveLength(2);
    expect(recs[1].start.restart).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['ready', 'respawning', 'ready']);
    // The old child got its flush-first stop (exit 0, requested), and that was not a crash.
    expect(events.some((e) => e.type === 'crashed')).toBe(false);
    // A respawn cut short by stop(): rejected, the host ends with exit 0, no third child.
    const third = sup.respawn('again');
    expect(await sup.stop('test')).toMatchObject({ reason: 'requested', exitCode: 0 });
    await expect(third).rejects.toThrow();
    await expect(sup.respawn('after stop')).rejects.toThrow(/stopping/);
    await new Promise((r) => setTimeout(r, 100));
    expect(starts(data)).toHaveLength(2);
  }, 20_000);

  it('a child that ignores stop is killed after the grace period; one that never gets ready is killed and counts as a crash', async () => {
    const a = makeRoot();
    const stubborn = new ServerChild({ entry: fakeServer(a.app, { ignoreStop: true }), root: a.root, dataDir: a.data, start: startMsg(a.data) });
    await stubborn.ready;
    const t0 = Date.now();
    const exit = await stubborn.stop('test', 300);
    expect(exit.requested).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);

    const b = makeRoot();
    const sup = new Supervisor({
      spawn: (restart) => new ServerChild({ entry: fakeServer(b.app, { noReady: true }), root: b.root, dataDir: b.data, start: startMsg(b.data, { restart }), readyTimeoutMs: 300 }),
      maxRestarts: 0,
    });
    const err = await sup.start().then(() => null, (e: Error & { result?: { reason: string; exit: { readyTimeout: boolean } } }) => e);
    expect(err?.result?.reason).toBe('gave-up');
    expect(err?.result?.exit.readyTimeout).toBe(true);
  }, 20_000);

  it('a stop asked for while the child is still starting is asked again once it is ready (the server listens for it only then)', async () => {
    const { root, app, data } = makeRoot();
    const child = new ServerChild({ entry: fakeServer(app, { readyAfter: 400, stopOnlyAfterReady: true }), root, dataDir: data, start: startMsg(data) });
    const t0 = Date.now();
    const exit = await child.stop('test', 8000);
    // Its own flush-first stop (exit 0), well before the kill after the grace period.
    expect(exit).toMatchObject({ code: 0, signal: null, requested: true });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(fs.readFileSync(path.join(data, 'fake-stops.txt'), 'utf8').trim().split('\n')).toEqual(['lost', 'heard']);
  }, 20_000);

  it('a child that says it is still working (progress / notice) is not killed by the ready limit; a silent one is', async () => {
    const a = makeRoot();
    const busy = new ServerChild({
      entry: fakeServer(a.app, { progress: { every: 120, count: 8 } }), root: a.root, dataDir: a.data, start: startMsg(a.data), readyTimeoutMs: 400,
    });
    // About 1 s of work in total, more than twice the limit, with a heartbeat every 120 ms.
    expect((await busy.ready).type).toBe('ready');
    expect((await busy.stop('test')).readyTimeout).toBe(false);
    const b = makeRoot();
    const silent = new ServerChild({ entry: fakeServer(b.app, { readyAfter: 1500 }), root: b.root, dataDir: b.data, start: startMsg(b.data), readyTimeoutMs: 400 });
    await expect(silent.ready).rejects.toThrow();
    expect((await silent.exited).readyTimeout).toBe(true);
  }, 20_000);

  it('stop() while waiting to restart ends the host without another child', async () => {
    const { root, data } = makeRoot();
    const entry = fakeServer(path.join(root, 'app'), { crashAfterReadyTimes: 1 });
    let crashed!: () => void;
    const crash = new Promise<void>((r) => { crashed = r; });
    const sup = new Supervisor({
      spawn: (restart) => new ServerChild({ entry, root, dataDir: data, start: startMsg(data, { restart }) }),
      restartDelayMs: 2000,
      onEvent: (e) => { if (e.type === 'restarting') crashed(); },
    });
    await sup.start();
    await crash;
    expect(await sup.stop('test')).toMatchObject({ reason: 'requested', exitCode: 0 });
    expect(starts(data)).toHaveLength(1);
  });
});

describe('T-LAN-13 (sandbox): the child cannot write outside data\\, start programs, or ATTACH', () => {
  it('fs writes outside data\\ → ERR_ACCESS_DENIED, child_process → ERR_ACCESS_DENIED, ATTACH / VACUUM INTO denied', async () => {
    const { root, app: appDir, data } = makeRoot();
    const probe = path.join(appDir, 'probe.mjs');
    const guard = path.join(repoRoot, 'src', 'server', 'db', 'guard.ts');
    await bundle({
      outfile: probe,
      contents: `
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        import cp from 'node:child_process';
        import { Worker } from 'node:worker_threads';
        import { register } from 'node:module';
        import { DatabaseSync } from 'node:sqlite';
        import { protectConnection } from ${JSON.stringify(guard)};
        const res = (f) => { try { f(); return 'ok'; } catch (e) { return String(e && (e.code || e.message)) + (e && e.code === 'ERR_SQLITE_ERROR' ? ': ' + e.message : ''); } };
        const q = (p) => "'" + p.replace(/'/g, "''") + "'";
        process.on('message', async (m) => {
          if (!m || m.type !== 'lan:start') return;
          const root = m.probeRoot, data = m.dataDir, r = {};
          r.writeData = res(() => fs.writeFileSync(path.join(data, 'ok.txt'), 'x'));
          r.mkdirData = res(() => fs.mkdirSync(path.join(data, 'logs', 'deep'), { recursive: true }));
          r.writeRoot = res(() => fs.writeFileSync(path.join(root, 'outside.txt'), 'x'));
          r.writeApp = res(() => fs.writeFileSync(path.join(root, 'app', 'server.mjs'), 'x'));
          r.writeTemp = res(() => fs.writeFileSync(path.join(os.tmpdir(), 'vs-probe-' + process.pid + '.txt'), 'x'));
          r.readRoot = res(() => fs.readdirSync(root));
          r.readOutside = res(() => fs.readdirSync(path.dirname(root)));
          r.spawn = res(() => cp.spawn(process.execPath, ['-e', '1']));
          r.execFileSync = res(() => cp.execFileSync(process.execPath, ['-e', '1']));
          r.fork = res(() => cp.fork(path.join(root, 'app', 'probe.mjs')));
          // No worker threads at all (no --allow-worker): a worker's permissions are not pinned to the child's, so
          // Node must refuse every one, whatever its options, and the module.register hooks thread too.
          const tryWorker = (opts) => new Promise((done) => { try { const w = new Worker('1', { eval: true, ...opts }); w.on('exit', () => done('ok')); w.on('error', (e) => done(String(e.code || e.message))); } catch (e) { done(String(e.code || e.message)); } });
          r.worker = await tryWorker({});
          r.workerEmptyArgv = await tryWorker({ execArgv: [] });
          r.workerEnv = await tryWorker({ env: { NODE_OPTIONS: '--no-warnings' } });
          r.register = (() => { try { register('data:text/javascript,export%20async%20function%20resolve(s%2Cc%2Cn)%7Breturn%20n(s%2Cc)%7D'); return 'ok'; } catch (e) { return String(e.code || e.message); } })();
          // node:sqlite is outside the permission model: a raw connection CAN attach a file anywhere...
          const raw = new DatabaseSync(path.join(data, 'raw.db'));
          r.rawAttach = res(() => raw.exec('ATTACH DATABASE ' + q(path.join(root, 'attached-raw.db')) + ' AS x'));
          raw.close();
          // ...which is why every Voidswarm connection gets the authorizer (src/server/db/guard.ts).
          const db = protectConnection(new DatabaseSync(path.join(data, 'guarded.db')));
          db.exec('CREATE TABLE IF NOT EXISTS t(x)');
          r.attach = res(() => db.exec('ATTACH DATABASE ' + q(path.join(root, 'attached.db')) + ' AS x'));
          r.vacuumInto = res(() => db.exec('VACUUM INTO ' + q(path.join(data, 'copy.db'))));
          r.vacuum = res(() => db.exec('VACUUM'));
          db.close();
          r.execArgv = process.execArgv;
          process.send({ type: 'probe', r }, () => process.exit(0));
        });
      `,
    });
    const child = new ServerChild({ entry: probe, root, dataDir: data, start: startMsg(data, { probeRoot: root }) });
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      child.on('message', (m: Record<string, unknown>) => { if (m.type === 'probe') resolve(m.r as Record<string, unknown>); });
      void child.exited.then((e) => reject(new Error(`probe exited ${e.code}: ${child.tail.join('\n')}`)));
    });
    await child.exited;
    expect(msg.writeData).toBe('ok');
    expect(msg.mkdirData).toBe('ok');
    expect(msg.writeRoot).toBe('ERR_ACCESS_DENIED');
    expect(msg.writeApp).toBe('ERR_ACCESS_DENIED');
    expect(msg.writeTemp).toBe('ERR_ACCESS_DENIED');
    expect(msg.readRoot).toBe('ok');
    expect(msg.readOutside).toBe('ERR_ACCESS_DENIED');
    expect(msg.spawn).toBe('ERR_ACCESS_DENIED');
    expect(msg.execFileSync).toBe('ERR_ACCESS_DENIED');
    expect(msg.fork).toBe('ERR_ACCESS_DENIED');
    expect(msg.worker).toBe('ERR_ACCESS_DENIED');
    expect(msg.workerEmptyArgv).toBe('ERR_ACCESS_DENIED');
    expect(msg.workerEnv).toBe('ERR_ACCESS_DENIED');
    expect(msg.register).toBe('ERR_ACCESS_DENIED');
    expect(msg.rawAttach).toBe('ok'); // fact 12: the permission model does not cover node:sqlite
    expect(String(msg.attach)).toMatch(/not authorized|authorization denied/i);
    expect(String(msg.vacuumInto)).toMatch(/not authorized|authorization denied/i);
    expect(msg.vacuum).toBe('ok');
    expect(fs.existsSync(path.join(root, 'attached.db'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'copy.db'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'app', 'probe.mjs'), 'utf8').length).toBeGreaterThan(100);
    expect(msg.execArgv).toEqual(expect.arrayContaining(['--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${data}`]));
    expect(msg.execArgv).not.toContain('--allow-worker');
  }, 30_000);

  it('the real server (bundled like app\\server.mjs) runs inside the sandbox: ready, a pilot chats, stop → exit 0, one checkpointed DB', async () => {
    const { root, app: appDir, data } = makeRoot();
    const entry = path.join(appDir, 'server.mjs');
    await bundle({ entry: path.join(repoRoot, 'src', 'server', 'index.ts'), outfile: entry });
    fs.cpSync(path.join(repoRoot, 'src', 'server', 'moderation', 'admin'), path.join(appDir, 'admin'), { recursive: true });
    const output: string[] = [];
    const child = new ServerChild({
      entry, root, dataDir: data,
      start: startMsg(data, { adminPageDir: path.join(appDir, 'admin') }),
      onOutput: (l) => output.push(l),
      env: { ...process.env, SMTP_PASS: 'never-in-the-child-9', CHAT_FILTER: 'standard' },
    });
    const ready = await child.ready;
    expect(ready.port).toBeGreaterThan(0);
    expect(ready.chatLog).toBe(true);
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}`);
    const got: { type: string; line?: { text: string; channel: string } }[] = [];
    ws.on('message', (d, bin) => { if (!bin) got.push(JSON.parse(d.toString())); });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ type: 'hello', name: 'NovaPilot', protocol: PROTOCOL_VERSION, version: 'test' }));
    const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
      const end = Date.now() + ms;
      while (!pred()) { if (Date.now() > end) throw new Error(`timeout; got ${got.map((m) => m.type).join(',')}`); await new Promise((r) => setTimeout(r, 20)); }
    };
    await until(() => got.some((m) => m.type === 'chatHistory'));
    ws.send(JSON.stringify({ type: 'chat', channel: 'all', text: 'gg from the sandbox' }));
    await until(() => got.some((m) => m.type === 'chat' && m.line?.text === 'gg from the sandbox'));
    const exit = await child.stop('test');
    ws.terminate();
    expect(exit.code).toBe(0);
    const db = new DatabaseSync(path.join(data, 'voidswarm.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_log WHERE original = ?').get('gg from the sandbox')).toEqual({ n: 1 });
    } finally { db.close(); }
    const wal = path.join(data, 'voidswarm.db-wal');
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
    // Nothing secret reached the child's output.
    expect(output.join('\n')).not.toContain('never-in-the-child');
    // It wrote nothing outside data\ (the only new files are in data\ and the app\ we put there).
    expect(fs.readdirSync(root).sort()).toEqual(['app', 'data']);
  }, 60_000);
});
