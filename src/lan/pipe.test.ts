import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  acquireLock, ALREADY_RUNNING_MESSAGE, ensureSocketDir, isHostRunning, pipeId, pipePath, secondLaunch, sendCommand, socketDir, validatePanelUrl,
  type HostLock,
} from './pipe';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-pipe-'));
let n = 0;
const newData = () => {
  const d = path.join(scratch, `data-${++n}-${randomBytes(3).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const locks: HostLock[] = [];
afterEach(async () => {
  while (locks.length) await locks.pop()!.close();
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PANEL = 'http://localhost:17778/';

async function host(dataDir: string, key: Buffer | null, extra: Record<string, unknown> = {}) {
  const r = await acquireLock({ dataDir, key, handlers: { panelUrl: () => PANEL, version: '0.6.0-test', ...extra } });
  if (!r.ok) throw new Error('lock not acquired');
  locks.push(r.lock);
  return r.lock;
}

describe('pipe name', () => {
  it('is voidswarm-lan-<first 16 hex of sha256(dataPath)>', () => {
    const p = pipePath('C:\\Users\\NovaPilot\\Voidswarm LAN\\data', 'win32');
    expect(p).toMatch(/^\\\\\.\\pipe\\voidswarm-lan-[0-9a-f]{16}$/);
    // Case and trailing separators don't make a second lock for the same folder.
    expect(pipeId('c:\\users\\novapilot\\voidswarm lan\\DATA\\', 'win32')).toBe(pipeId('C:\\Users\\NovaPilot\\Voidswarm LAN\\data', 'win32'));
    expect(pipeId('C:\\Users\\NovaPilot\\Voidswarm LAN 2\\data', 'win32')).not.toBe(pipeId('C:\\Users\\NovaPilot\\Voidswarm LAN\\data', 'win32'));
    // macOS/Linux: a short socket name inside a per-user folder (not loose in the shared temp folder).
    expect(pipePath('/home/nova/Voidswarm LAN/data', 'linux')).toMatch(/\/voidswarm-lan-[^/]+\/[0-9a-f]{16}\.sock$/);
  });

  it('hashes the same folder before and after data\\ is created', () => {
    const d = path.join(scratch, `later-${randomBytes(3).toString('hex')}`, 'data');
    const before = pipeId(d);
    fs.mkdirSync(d, { recursive: true });
    expect(pipeId(d)).toBe(before);
    expect(pipeId(d + path.sep)).toBe(before);
  });

  it('only ever opens a loopback http panel URL', () => {
    expect(validatePanelUrl('http://localhost:7778/')).toBe('http://localhost:7778/');
    expect(validatePanelUrl('http://127.0.0.1:7780/#x')).toBe('http://127.0.0.1:7780/#x');
    expect(validatePanelUrl('http://[::1]:7778/')).toBe('http://[::1]:7778/');
    for (const bad of ['https://evil.example/', 'http://192.168.50.21:7778/', 'file:///C:/x', 'javascript:alert(1)', 'http://user:pw@localhost/', 42]) {
      expect(validatePanelUrl(bad)).toBeNull();
    }
  });
});

describe('T-LAN-2: a second launch opens the running panel and exits 0', () => {
  it('in-process host', async () => {
    const data = newData();
    const key = randomBytes(32);
    await host(data, key);
    const again = await acquireLock({ dataDir: data, key, handlers: { panelUrl: () => 'http://localhost:1/' } });
    expect(again).toMatchObject({ ok: false, running: true, answering: true });

    const opened: string[] = [];
    const r = await secondLaunch({ dataDir: data, key, openBrowser: (u) => void opened.push(u) });
    expect(r).toEqual({ exitCode: 0, message: ALREADY_RUNNING_MESSAGE, url: PANEL });
    expect(opened).toEqual([PANEL]);
    expect(ALREADY_RUNNING_MESSAGE).toBe('Voidswarm is already running — opened the control panel.');
  });

  it('works before pipe.key exists (panel needs no key)', async () => {
    const data = newData();
    await host(data, null);
    const opened: string[] = [];
    const r = await secondLaunch({ dataDir: data, key: null, openBrowser: (u) => void opened.push(u) });
    expect(r.exitCode).toBe(0);
    expect(opened).toEqual([PANEL]);
  });

  it('first run: the lock is taken before pipe.key exists; after setKey a keyed second launch still exits 0', async () => {
    const data = newData();
    const lock = await host(data, null, { status: () => ({ online: 1 }) });
    const key = randomBytes(32); // B2 writes data\secrets\pipe.key after the lock (§2.2 steps 5 → 7)
    lock.setKey(key);
    const opened: string[] = [];
    const r = await secondLaunch({ dataDir: data, key, openBrowser: (u) => void opened.push(u) });
    expect(r).toEqual({ exitCode: 0, message: ALREADY_RUNNING_MESSAGE, url: PANEL });
    expect(opened).toEqual([PANEL]);
    // Signed replies and the privileged commands work from then on.
    expect(await sendCommand({ dataDir: data, key, cmd: 'status' })).toMatchObject({ ok: true, verified: true, body: { status: { online: 1 } } });
    // A keyless client (an older launch) still gets the panel.
    expect(await sendCommand({ dataDir: data, key: null, cmd: 'panel' })).toMatchObject({ ok: true, body: { panelUrl: PANEL } });
    expect(() => lock.setKey(Buffer.alloc(8))).toThrow(/16 bytes/);
  });

  it('prints the URL when the browser can\'t be opened, still exit 0', async () => {
    const data = newData();
    await host(data, null);
    const r = await secondLaunch({ dataDir: data, key: null, openBrowser: () => { throw new Error('no browser'); } });
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain(PANEL);
  });

  it('a program squatting on the pipe name is not trusted (exit 1)', async () => {
    const data = newData();
    const squat = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\n\r\nhello\n'));
    await new Promise<void>((res) => squat.listen(pipePath(data), res));
    try {
      const acq = await acquireLock({ dataDir: data, key: null, handlers: { panelUrl: () => PANEL } });
      expect(acq).toMatchObject({ ok: false, running: true, answering: false });
      const opened: string[] = [];
      const r = await secondLaunch({ dataDir: data, key: randomBytes(32), openBrowser: (u) => void opened.push(u) });
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/Another program/);
      expect(opened).toEqual([]);
    } finally {
      await new Promise<void>((res) => squat.close(() => res()));
    }
  });
});

describe('pipe commands need pipe.key', () => {
  it('status, reload-admin and stop with the key; refused without it; forged replies rejected', async () => {
    const data = newData();
    const key = randomBytes(32);
    let reloaded = 0;
    let stopped = 0;
    await host(data, key, {
      status: () => ({ online: 12, rooms: 3 }),
      reloadAdmin: () => void reloaded++,
      stop: () => void stopped++,
    });

    const st = await sendCommand({ dataDir: data, key, cmd: 'status' });
    expect(st).toMatchObject({ ok: true, verified: true, body: { status: { online: 12, rooms: 3 } } });

    const noKey = await sendCommand({ dataDir: data, key: null, cmd: 'stop' });
    expect(noKey).toMatchObject({ ok: false, error: 'refused', detail: 'unauthorized' });
    // A wrong key: the host refuses, and its signed reply doesn't verify under our key either.
    const wrong = await sendCommand({ dataDir: data, key: randomBytes(32), cmd: 'stop' });
    expect(wrong).toMatchObject({ ok: false, error: 'unverified' });
    expect(stopped).toBe(0);

    expect(await sendCommand({ dataDir: data, key, cmd: 'reload-admin' })).toMatchObject({ ok: true });
    expect(reloaded).toBe(1);
    expect(await sendCommand({ dataDir: data, key, cmd: 'stop' })).toMatchObject({ ok: true, body: { stopping: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(1);

    const ping = await sendCommand({ dataDir: data, key: null, cmd: 'ping' });
    expect(ping).toMatchObject({ ok: true, verified: false, body: { app: 'voidswarm-lan', version: '0.6.0-test' } });
  });

  it('a host without a key refuses privileged commands', async () => {
    const data = newData();
    await host(data, null, { stop: () => { throw new Error('must not run'); } });
    expect(await sendCommand({ dataDir: data, key: randomBytes(32), cmd: 'stop' })).toMatchObject({ ok: false });
  });

  it('isHostRunning, and close() releases the lock', async () => {
    const data = newData();
    expect(await isHostRunning(data)).toBe(false);
    expect(await sendCommand({ dataDir: data, key: null, cmd: 'ping' })).toMatchObject({ ok: false, error: 'not-running' });
    const lock = await host(data, null);
    expect(await isHostRunning(data)).toBe(true);
    await lock.close();
    expect(await isHostRunning(data)).toBe(false);
    await host(data, null);
  });

  it('rejects a short key', async () => {
    await expect(acquireLock({ dataDir: newData(), key: Buffer.alloc(4), handlers: { panelUrl: () => PANEL } })).rejects.toThrow(/16 bytes/);
  });
});

describe.skipIf(process.platform === 'win32')('macOS/Linux socket folder', () => {
  it('is created 0700 and owned by us; a folder with group/other access is tightened', async () => {
    const dir = path.join(scratch, `sockdir-${randomBytes(3).toString('hex')}`);
    ensureSocketDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    ensureSocketDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    expect(() => ensureSocketDir(link)).toThrow(/not a folder/);
    expect(socketDir()).toMatch(/voidswarm-lan-/);
  });
});

// --- T-LAN-14: a crashed (kill -9) parent never blocks the next start -------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function startHolder(dataDir: string, keyHex: string): Promise<ChildProcess> {
  const script = path.join(scratch, `holder-${randomBytes(3).toString('hex')}.mjs`);
  const pipeUrl = pathToFileURL(path.join(REPO, 'src', 'lan', 'pipe.ts')).href;
  fs.writeFileSync(
    script,
    [
      `import { acquireLock } from ${JSON.stringify(pipeUrl)};`,
      'const [dataDir, keyHex] = process.argv.slice(2);',
      `const r = await acquireLock({ dataDir, key: Buffer.from(keyHex, 'hex'), handlers: { panelUrl: () => ${JSON.stringify(PANEL)} } });`,
      "process.stdout.write(r.ok ? 'LOCKED\\n' : 'BUSY\\n');",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script, dataDir, keyHex], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const t = setTimeout(() => reject(new Error(`holder did not start: ${err}`)), 20_000);
    child.stderr!.on('data', (d) => (err += d));
    child.stdout!.on('data', (d) => {
      out += d;
      if (out.includes('LOCKED')) {
        clearTimeout(t);
        resolve(child);
      } else if (out.includes('BUSY')) {
        clearTimeout(t);
        reject(new Error('holder found the lock busy'));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`holder exited ${code}: ${err}`));
    });
  });
}

describe('T-LAN-14: after kill -9 of the parent, the next start acquires the pipe', () => {
  it('another process holds it, dies hard, and the lock is free', async () => {
    const data = newData();
    const key = randomBytes(32);
    const child = await startHolder(data, key.toString('hex'));
    try {
      // While it lives: a second start is refused and opens its panel (cross-process T-LAN-2).
      const busy = await acquireLock({ dataDir: data, key, handlers: { panelUrl: () => PANEL } });
      expect(busy).toMatchObject({ ok: false, running: true, answering: true });
      const opened: string[] = [];
      expect((await secondLaunch({ dataDir: data, key, openBrowser: (u) => void opened.push(u) })).exitCode).toBe(0);
      expect(opened).toEqual([PANEL]);
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await exited;
    }
    // No clean-up ran in the holder. The next start must still get the lock (a stale Unix socket is replaced).
    let got: Awaited<ReturnType<typeof acquireLock>> | null = null;
    for (let i = 0; i < 20 && !(got && got.ok); i++) {
      got = await acquireLock({ dataDir: data, key, handlers: { panelUrl: () => PANEL } });
      if (!got.ok) await new Promise((r) => setTimeout(r, 100));
    }
    expect(got?.ok).toBe(true);
    if (got?.ok) locks.push(got.lock);
  }, 30_000);
});
