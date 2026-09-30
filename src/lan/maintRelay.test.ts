// The maintenance process (architect ruling HA at the M1 gate; src/server/maint/ipcTransport.ts, maintRelay.ts): the
// sandboxed server child may start no worker thread, so the launcher runs app\maint.mjs as a second sandboxed child
// and relays. Here: the byte encoding, and the real bundles (server.mjs + maint.mjs) in a sandbox, the relay between
// them, and the Chat log reads (which need the worker) answering through it.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeMaint, encodeMaint } from '../server/maint/ipcTransport';
import { ServerChild } from './child';
import { MaintRelay, maintEntryBeside } from './maintRelay';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-maint-relay-'));
afterAll(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ } });

async function bundle(entry: string, outfile: string): Promise<void> {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry], absWorkingDir: repoRoot, outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    minify: false, logLevel: 'silent', external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __vsCreateRequire } from 'node:module'; const require = __vsCreateRequire(import.meta.url);" },
  });
}

function admin(port: number, name: string, body: unknown, token = ''): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, path: `/api/admin/${name}`, method: 'POST', agent: false,
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('maint IPC encoding', () => {
  it('bytes travel as base64 and come back as Buffers; everything else is unchanged', () => {
    const key = randomBytes(32);
    const m = { t: 'call', id: 3, op: 'x', args: { key, list: [new Uint8Array([1, 2, 3]), 'a', 1, null], nested: { deep: { k: key } } } };
    const wire = JSON.parse(JSON.stringify(encodeMaint(m)));
    expect(JSON.stringify(wire)).not.toContain('"type":"Buffer"');
    const back = decodeMaint(wire) as typeof m;
    expect(Buffer.compare(back.args.key, key)).toBe(0);
    expect([...(back.args.list[0] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(back.args.list.slice(1)).toEqual(['a', 1, null]);
    expect(Buffer.compare(back.args.nested.deep.k, key)).toBe(0);
    expect(decodeMaint({ $u8: 'AQ==', other: 1 })).toEqual({ $u8: 'AQ==', other: 1 }); // only a lone $u8 is bytes
  });
});

describe('the maintenance process in the sandbox (T-LAN-13 holds: no worker thread)', () => {
  it('the server asks, the launcher relays: Chat log reads answer through the maint process; both stop cleanly', async () => {
    const root = path.join(tmpRoot, 'Voidswarm LAN');
    const appDir = path.join(root, 'app');
    const data = path.join(root, 'data');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const serverEntry = path.join(appDir, 'server.mjs');
    await bundle(path.join(repoRoot, 'src', 'server', 'index.ts'), serverEntry);
    await bundle(path.join(repoRoot, 'src', 'server', 'maint', 'worker.ts'), maintEntryBeside(serverEntry));
    fs.cpSync(path.join(repoRoot, 'src', 'server', 'moderation', 'admin'), path.join(appDir, 'admin'), { recursive: true });
    const setupCode = 'K7QP4MXD';
    const output: string[] = [];
    let child: ServerChild | null = null;
    const relay = new MaintRelay({
      entry: maintEntryBeside(serverEntry), root, dataDir: data, dbPath: path.join(data, 'voidswarm.db'),
      send: (m) => { child?.send(m); }, onOutput: (l) => output.push(`[maint] ${l}`),
    });
    child = new ServerChild({
      entry: serverEntry, root, dataDir: data,
      start: {
        type: 'lan:start', dataDir: data, port: 0, bind: '127.0.0.1', publicUrl: 'http://localhost:0', primary: null, preset: 'home',
        adminPort: 0, adminPageDir: path.join(appDir, 'admin'), serveLan: false, notServing: 'setup', setupCode, maint: true, banners: [],
        secrets: { v: 1, secrets: { 'pepper.key': randomBytes(32).toString('base64'), 'backup.key': randomBytes(32).toString('base64') } },
      },
      onOutput: (l) => output.push(l),
      onMessage: (m) => { relay.handle(m); },
    });
    child.on('exit', () => relay.serverGone());
    const ready = await child.ready;
    expect(ready.adminPort, output.join('\n')).toBeGreaterThan(0);
    expect(ready.setupPending).toBe(true);
    const st = await child.status();
    expect(st, output.join('\n')).toMatchObject({ maint: true });
    expect(relay.process?.pid).toBeGreaterThan(0);
    const port = ready.adminPort!;
    const pass = `T3st-${randomBytes(12).toString('base64url')}`;
    const setup = await admin(port, 'setup', { setupCode, username: 'HostTest', password: pass, preset: 'home', serverName: 'Relay Den', accountsMode: 'email' });
    expect(setup.status, setup.text).toBe(200);
    const token = String(setup.json.token);
    // log/stats runs only in the maintenance worker (503 without it).
    const stats = await admin(port, 'log/stats', {}, token);
    expect(stats.status, stats.text).toBe(200);
    const log = await admin(port, 'log', { limit: 10 }, token);
    expect(log.status, log.text).toBe(200);
    const maintProc = relay.process!;
    const maintExit = new Promise<number | null>((r) => { maintProc.once('exit', (c) => r(c)); });
    const exit = await child.stop('test');
    expect(exit.code, output.join('\n')).toBe(0);
    expect(await Promise.race([maintExit, new Promise((r) => { setTimeout(() => r('still running'), 6000); })])).not.toBe('still running');
    await relay.stop();
    // Nothing was written outside data\ (both processes are sandboxed).
    expect(fs.readdirSync(root).sort()).toEqual(['app', 'data']);
    expect(output.join('\n')).not.toMatch(/ERR_ACCESS_DENIED/);
  }, 120_000);
});
