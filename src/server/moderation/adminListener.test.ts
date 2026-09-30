// The admin listener end to end (docs/LAN-EDITION-proposal.md §3.2, §4.10, §5.15): HostAdmin + the admin API +
// startAdminListener on ephemeral ports. T-ADM-1, T-ADM-2, T-ADM-3, T-ADM-16, T-ADM-17 over HTTP, T-NET-1 (admin part)
// and T-LAN-9 (admin listener). The LAN binding runs on 127.0.0.2 with a throwaway self-signed certificate made here.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthStore, reportChatCopy } from '../auth/store';
import { startAdminListener, type AdminListener, type AdminPlacePolicy } from '../listeners';
import { ADMIN_ERR, DEFAULT_ADMIN_POLICY, HostAdmin, formatSetupCode, hashAdminPassword, newSetupCode, setHostAdminCredential, type AdminPolicy } from './hostAdmin';
import {
  ADMIN_PAGE_CSP, ADMIN_ROUTES, LOG_SCAN_ROWS, SCRUB_MAX_DEPTH, createAdminHttp, createAdminSite, scrubReply, scrubRulesFor, visibleLogPage, type AdminRouteHandler,
} from './http';
import { ModerationService, type ZoneControl } from './service';
import type { OnlinePilot } from '../../shared/room/moderation';

const MIN = 60_000;
const FAST = { N: 1 << 10, r: 8, p: 1, keylen: 32 } as const;
const PASS = 'Correct-Horse-7Battery'; // generated test password

// ------------------------------------------------------------------------------------------ a throwaway TLS identity

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
/** A minimal self-signed v1 P-256 certificate (CN=127.0.0.2), made in memory for this test only. */
function testIdentity(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const alg = der(0x30, Buffer.from('06082a8648ce3d040302', 'hex')); // ecdsa-with-SHA256
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('127.0.0.2')))));
  const utc = (d: Date): Buffer => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
  const now = Date.now();
  const tbs = der(0x30, der(0x02, Buffer.from([0x01])), alg, name, der(0x30, utc(new Date(now - 86_400_000)), utc(new Date(now + 86_400_000))), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const certDer = der(0x30, tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n');
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n` };
}

// ------------------------------------------------------------------------------------------ HTTP helpers

interface Reply { status: number; headers: IncomingHttpHeaders; text: string; json: Record<string, unknown> }
interface Call { port: number; path: string; method?: string; host?: string; connect?: string; tls?: boolean; headers?: Record<string, string>; body?: unknown; localAddress?: string }

function call(c: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = c.body === undefined ? undefined : typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
    const headers: Record<string, string> = { Host: c.host ?? `localhost:${c.port}`, ...(c.headers ?? {}) };
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const opts = { host: c.connect ?? '127.0.0.1', port: c.port, path: c.path, method: c.method ?? 'POST', headers, agent: false as const, ...(c.localAddress ? { localAddress: c.localAddress } : {}) };
    const done = (res: import('node:http').IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    };
    const req = c.tls ? httpsRequest({ ...opts, rejectUnauthorized: false }, done) : httpRequest(opts, done);
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function canBind(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(0, address, () => s.close(() => resolve(true)));
  });
}

// ------------------------------------------------------------------------------------------ the stack

interface Stack {
  port: number;
  clock: { t: number };
  policy: AdminPolicy;
  ha: HostAdmin;
  listener: AdminListener;
  dbPath: string;
  codes: string[];
  mod: ModerationService;
  /** POST /api/admin/<name> on the host PC (loopback, Host localhost:A, same Origin). */
  local(name: string, body?: unknown, token?: string, extra?: Partial<Call>): Promise<Reply>;
  /** POST over the LAN binding (https on 127.0.0.2). */
  remote(name: string, body?: unknown, token?: string, extra?: Partial<Call>): Promise<Reply>;
  run(sql: string, ...args: (string | number | null)[]): void;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

let lanOk = false;
let identity: { key: string; cert: string };
beforeAll(async () => {
  lanOk = await canBind('127.0.0.2');
  identity = testIdentity();
});

async function stack(o: { policy?: Partial<AdminPolicy>; lan?: 'tls' | 'plain' | null; handlers?: Record<string, AdminRouteHandler>; displayDir?: string; limits?: { calls?: [number, number] } } = {}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'voidswarm-adminl-'));
  const dbPath = join(dir, 'voidswarm.db');
  new AuthStore(dbPath).close();
  const clock = { t: Date.now() };
  const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY, ...(o.policy ?? {}) };
  const codes: string[] = [];
  const ha = new HostAdmin({ dbPath, now: () => clock.t, policy: () => policy, passwordParams: FAST, pepper: randomBytes(32), onSetupCode: (c) => codes.push(c) });
  const mod = new ModerationService({ dbPath, timers: false, log: () => undefined });
  const api = createAdminHttp({ service: mod, trustProxy: false, log: () => undefined, hostAdmin: ha, policy: () => policy, handlers: o.handlers, now: () => clock.t, limits: o.limits });
  const place = (): AdminPlacePolicy => ({ remoteAccess: policy.remoteAccess, devicesTrustCert: policy.devicesTrustCert });
  const lanMode = o.lan === undefined ? 'tls' : o.lan;
  const listener = await startAdminListener({
    port: 0, policy: place, handle: createAdminSite({ api, displayDir: o.displayDir }),
    loopback: ['127.0.0.1'],
    lan: lanOk && lanMode ? { address: '127.0.0.2', tls: lanMode === 'tls' ? identity : null } : null,
  });
  cleanups.push(async () => {
    await listener.close();
    mod.close();
    ha.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
  });
  const port = listener.port;
  const post = (base: Partial<Call>) => (name: string, body: unknown = {}, token?: string, extra: Partial<Call> = {}): Promise<Reply> => call({
    port, path: `/api/admin/${name}`, body,
    ...base, ...extra,
    headers: { 'Content-Type': 'application/json', Origin: base.tls ? `https://127.0.0.2:${port}` : `http://localhost:${port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra.headers ?? {}) },
  });
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    const db = new DatabaseSync(dbPath);
    try { db.prepare(sql).run(...args); } finally { db.close(); }
  };
  return {
    port, clock, policy, ha, listener, dbPath, codes, mod, run,
    local: post({}),
    remote: post({ tls: lanMode === 'tls', connect: '127.0.0.2', host: `127.0.0.2:${port}` }),
  };
}

async function setUp(s: Stack): Promise<string> {
  const code = newSetupCode();
  s.ha.installLaunchCode(code);
  const r = await s.local('setup', { setupCode: formatSetupCode(code), username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den', accountsMode: 'email' });
  expect(r.status, r.text).toBe(200);
  return r.json.token as string;
}

const stub = (body: Record<string, unknown>): AdminRouteHandler => () => [200, { ok: true, ...body }];

// ------------------------------------------------------------------------------------------ tests

describe('T-ADM-1 setup over HTTP', () => {
  it('host PC with the right code: 200; LAN 403; bad Host 421; already set up 404; 5 wrong codes then a 60 s wait, doubling', async () => {
    const s = await stack({ policy: { remoteAccess: 'limited' } });
    const code = newSetupCode();
    s.ha.installLaunchCode(code);
    expect((await s.local('setup/status')).json).toMatchObject({ ok: true, needsSetup: true, kind: 'first' });
    if (lanOk) {
      const lanSetup = await s.remote('setup', { setupCode: code, username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' });
      expect(lanSetup.status).toBe(403);
      expect(lanSetup.json.error).toBe(ADMIN_ERR.setupHostPc);
      expect((await s.remote('setup/status')).status).toBe(403);
    }
    expect((await s.local('setup/status', {}, undefined, { host: 'x.trycloudflare.com' })).status).toBe(421);
    const body = { username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' };
    for (let left = 4; left >= 1; left--) {
      const r = await s.local('setup', { ...body, setupCode: 'ZZZZ-ZZZZ' });
      expect(r.status).toBe(400);
      expect(r.json.attemptsLeft).toBe(left);
    }
    const locked = await s.local('setup', { ...body, setupCode: 'ZZZZ-ZZZZ' });
    expect(locked.status).toBe(429);
    expect(locked.json.retryAfter).toBe(60);
    expect(locked.headers['retry-after']).toBe('60');
    s.clock.t += 61_000;
    for (let i = 0; i < 5; i++) await s.local('setup', { ...body, setupCode: 'ZZZZ-ZZZZ' });
    s.clock.t += 1000;
    expect((await s.local('setup', { ...body, setupCode: s.codes[1]! })).json.retryAfter).toBe(119);
    s.clock.t += 120_000;
    const ok = await s.local('setup', { ...body, setupCode: s.codes[1]! });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.token).toMatch(/^vsadm_/);
    expect(ok.json.session).toMatchObject({ principal: { kind: 'host', via: 'local' }, username: 'NovaPilot', idleSec: 1800 });
    expect((await s.local('setup', { ...body, setupCode: s.codes[1]! })).status).toBe(404);
    expect((await s.local('setup/status')).json).toMatchObject({ needsSetup: false });
  });
});

describe('request rules (§5.15)', () => {
  it('POST + JSON + same Origin only; no CORS; unknown 404; game tokens refused; not-built endpoints 501', async () => {
    const s = await stack({ lan: null });
    const token = await setUp(s);
    expect((await s.local('me', {}, token, { headers: { Origin: '' } })).status).toBe(403);
    expect((await s.local('me', {}, token, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await s.local('me', {}, token, { headers: { Origin: `http://127.0.0.1:${s.port}` } })).status).toBe(403);
    expect((await s.local('me', '{}', token, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    const opts = await s.local('me', undefined, token, { method: 'OPTIONS' });
    expect(opts.status).toBe(405);
    expect(opts.headers['access-control-allow-origin']).toBeUndefined();
    expect((await s.local('me', undefined, token, { method: 'GET' })).status).toBe(405);
    expect((await s.local('nope', {}, token)).status).toBe(404);
    expect((await s.local('me', {}, 'a'.repeat(64))).status).toBe(401); // a bare hex game token
    expect((await s.local('me', {})).status).toBe(401);
    expect((await s.local('conduct/summary', {}, token)).status).toBe(501);
    expect((await s.local('me', { pad: 'x'.repeat(9000) }, token)).status).toBe(413);
    const me = await s.local('me', {}, token);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ ok: true, admin: { username: 'NovaPilot', kind: 'host' } });
    expect(me.json.capabilities).toContain('stop');
    expect(Array.isArray(me.json.banners)).toBe(true);
    // Every route answers: a declared route never 404s (it is 200, 4xx for access, or 501 until built).
    for (const name of Object.keys(ADMIN_ROUTES).filter((n) => n !== 'setup')) {
      const r = await s.local(name, {}, token);
      expect(r.status, name).not.toBe(404);
    }
  }, 60_000);

  it('the route table declares every endpoint the other modules answer (an undeclared handler would be unreachable: 404)', async () => {
    const { moderationAdminHandlers } = await import('./service');
    const { maintAdminHandlers } = await import('../maint/api');
    const names = [...Object.keys(moderationAdminHandlers({} as never)), ...Object.keys(maintAdminHandlers({} as never)), 'home', 'display/state', 'announce'];
    expect(names.filter((n) => !Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, n))).toEqual([]);
    // B5's two additions to §5.15: Cancel of a staged restore, and Compact database (★, host PC).
    expect(ADMIN_ROUTES['backups/cancelRestore']).toMatchObject({ cap: 'backups.restore', hostPcOnly: true });
    expect(ADMIN_ROUTES['db/compact']).toMatchObject({ cap: 'compact', hostPcOnly: true });
    if (!lanOk) return;
    const s = await stack({ policy: { remoteAccess: 'full', devicesTrustCert: true }, handlers: { 'db/compact': stub({ ms: 1 }), 'backups/cancelRestore': stub({ cancelled: false }) } });
    const local = await setUp(s);
    expect((await s.local('db/compact', {}, local)).status).toBe(200);
    const remote = await s.remote('login', { role: 'host', username: 'NovaPilot', password: PASS });
    expect(remote.status, remote.text).toBe(200);
    for (const name of ['db/compact', 'backups/cancelRestore']) {
      const r = await s.remote(name, {}, remote.json.token as string);
      expect(r.status, name).toBe(403);
      expect(r.json.error).toBe('Host PC only');
    }
    // ★: stale after 10 minutes without a deliberate action (host PC too).
    s.clock.t += 11 * MIN;
    const stale = await s.local('db/compact', {}, local);
    expect(stale.status).toBe(401);
    expect(stale.json).toMatchObject({ code: 'reauth' });
  });

  it('the panel is served on / with the strict CSP; /display is host PC only', async () => {
    const displayDir = mkdtempSync(join(tmpdir(), 'voidswarm-display-'));
    writeFileSync(join(displayDir, 'display.html'), '<!doctype html><title>display</title>');
    cleanups.push(() => rmSync(displayDir, { recursive: true, force: true }));
    const s = await stack({ policy: { remoteAccess: 'full' }, displayDir });
    for (const p of ['/', '/admin', '/admin/admin.js', '/admin.css']) {
      const r = await call({ port: s.port, path: p, method: 'GET' });
      expect(r.status, p).toBe(200);
      expect(r.headers['content-security-policy']).toBe(ADMIN_PAGE_CSP);
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
    expect((await call({ port: s.port, path: '/admin.test.ts', method: 'GET' })).status).toBe(404);
    expect((await call({ port: s.port, path: '/display', method: 'GET' })).status).toBe(200);
    if (lanOk) expect((await call({ port: s.port, path: '/display', method: 'GET', tls: true, connect: '127.0.0.2', host: `127.0.0.2:${s.port}` })).status).toBe(403);
  });
});

describe('T-NET-1 (admin listener) and T-LAN-9', () => {
  it('forwarding headers → 403, a foreign Host → 421 with no host rights, on both admin bindings', async () => {
    const s = await stack({ policy: { remoteAccess: 'full' } });
    const token = await setUp(s);
    const fwd = await s.local('me', {}, token, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    expect(fwd.status).toBe(403);
    expect((await s.local('login', { username: 'NovaPilot', password: PASS }, undefined, { headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status).toBe(403);
    const cf = await s.local('me', {}, token, { host: 'x.trycloudflare.com', headers: { Origin: 'https://x.trycloudflare.com' } });
    expect(cf.status).toBe(421);
    if (lanOk) {
      expect((await s.remote('me', {}, token, { host: 'x.trycloudflare.com' })).status).toBe(421);
      expect((await s.remote('me', {}, token, { host: `localhost:${s.port}` })).status).toBe(421);
      expect((await s.remote('login', { username: 'NovaPilot', password: PASS }, undefined, { headers: { Via: '1.1 proxy' } })).status).toBe(403);
    }
  });
});

describe('T-ADM-2 login, throttle and sessions over HTTP', () => {
  it('5 wrong from one LAN address → 429 while localhost works; idle 30 min → 401; 12 h → 401; password change revokes; other route → 401', async () => {
    if (!lanOk) return;
    const s = await stack({ policy: { remoteAccess: 'limited' } });
    await setUp(s);
    for (let i = 0; i < 5; i++) expect((await s.remote('login', { role: 'host', username: 'NovaPilot', password: 'wrong-wrong-wrong' })).status).toBe(401);
    const blocked = await s.remote('login', { role: 'host', username: 'NovaPilot', password: PASS });
    expect(blocked.status).toBe(429);
    const local = await s.local('login', { role: 'host', username: 'NovaPilot', password: PASS });
    expect(local.status).toBe(200);
    const lt = local.json.token as string;
    // The host-PC token is useless on the LAN binding (another address and route).
    expect((await s.remote('me', {}, lt)).status).toBe(401);
    // A LAN token used from another address: 401 (skipped where the OS has no 127.0.0.3 / .4 source addresses).
    const from3 = await s.remote('login', { username: 'NovaPilot', password: PASS }, undefined, { localAddress: '127.0.0.3' }).catch(() => null);
    if (from3) {
      expect(from3.status).toBe(200);
      const t3 = from3.json.token as string;
      expect((await s.remote('me', {}, t3, { localAddress: '127.0.0.3' })).status).toBe(200);
      expect((await s.remote('me', {}, t3, { localAddress: '127.0.0.4' })).json.error).toBe(ADMIN_ERR.elsewhere);
    }
    // idle
    s.clock.t += 31 * MIN;
    expect((await s.local('me', {}, lt)).status).toBe(401);
    // absolute 12 h
    const a = (await s.local('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const b = (await s.local('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    // `bans` is a deliberate call (a poll such as rooms/list would not keep the session alive)
    for (let i = 0; i < 36; i++) { s.clock.t += 20 * MIN; expect((await s.local('bans', {}, a)).status).toBe(i < 35 ? 200 : 401); }
    expect((await s.local('me', {}, a)).status).toBe(401);
    expect((await s.local('me', {}, b)).status).toBe(401); // idle long ago
    // password change revokes the others
    const c1 = (await s.local('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const c2 = (await s.local('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const pw = await s.local('password', { current: PASS, next: 'Another-Pass-42' }, c1);
    expect(pw.json).toEqual({ ok: true, revoked: 1 });
    expect((await s.local('me', {}, c2)).status).toBe(401);
    expect((await s.local('me', {}, c1)).status).toBe(200);
    // logout
    expect((await s.local('logout', {}, c1)).json).toEqual({ ok: true });
    expect((await s.local('me', {}, c1)).status).toBe(401);
  }, 60_000);
});

describe('T-ADM-3 remote access', () => {
  const handlers = {
    'chat/live': stub({ lines: [], next: 0, gap: false }),
    'rooms/list': stub({ rooms: [] }),
    'conduct/summary': stub({ rows: [] }),
  };

  it('off: LAN login 403 (refused at the door)', async () => {
    if (!lanOk) return;
    const s = await stack({ policy: { remoteAccess: 'off' }, handlers });
    await setUp(s);
    const r = await s.remote('login', { username: 'NovaPilot', password: PASS });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/Remote access to the control panel is off/);
  });

  it('limited over TLS: Live and Rooms 200, conduct/* 403; full without devicesTrustCert behaves as limited', async () => {
    if (!lanOk) return;
    for (const remoteAccess of ['limited', 'full'] as const) {
      const s = await stack({ policy: { remoteAccess, devicesTrustCert: false }, handlers });
      await setUp(s);
      const login = await s.remote('login', { username: 'NovaPilot', password: PASS });
      expect(login.status, remoteAccess).toBe(200);
      expect(login.json.session).toMatchObject({ principal: { kind: 'host', via: 'limited' } });
      const t = login.json.token as string;
      expect((await s.remote('chat/live', {}, t)).status).toBe(200);
      expect((await s.remote('rooms/list', {}, t)).status).toBe(200);
      const conduct = await s.remote('conduct/summary', {}, t);
      expect(conduct.status).toBe(403);
      expect(conduct.json.error).toBe('Not allowed for your role');
      expect((await s.remote('settings/get', {}, t)).status).toBe(403);
      // host-PC-only controls never work remotely
      expect((await s.remote('shutdown', { confirm: true }, t)).json.error).toBe('Host PC only');
    }
  }, 60_000);

  it('full with trusted TLS: conduct passes can(); plain http from the LAN is always 403', async () => {
    if (!lanOk) return;
    const s = await stack({ policy: { remoteAccess: 'full', devicesTrustCert: true }, handlers });
    await setUp(s);
    const t = (await s.remote('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    expect((await s.remote('conduct/summary', {}, t)).status).toBe(200);
    expect((await s.remote('recovery/create', {}, t)).json.error).toBe('Host PC only');
    const plain = await stack({ policy: { remoteAccess: 'full', devicesTrustCert: true }, lan: 'plain', handlers });
    await setUp(plain);
    const r = await plain.remote('login', { username: 'NovaPilot', password: PASS });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/secure address/);
  }, 60_000);
});

describe('T-ADM-17 step-up over HTTP', () => {
  it('a ★ call more than 10 minutes after the last deliberate action → 401 reauth; reauth makes it work; Live polls never refresh', async () => {
    const s = await stack({ lan: null, handlers: { 'chat/live': stub({ lines: [] }), 'conduct/summary': stub({ rows: [] }) } });
    const token = await setUp(s);
    expect((await s.local('conduct/summary', {}, token)).status).toBe(200);
    for (let i = 0; i < 11; i++) { s.clock.t += MIN; expect((await s.local('chat/live', {}, token)).status).toBe(200); }
    const stale = await s.local('conduct/summary', {}, token);
    expect(stale.status).toBe(401);
    expect(stale.json).toMatchObject({ reauth: true, code: 'reauth' });
    // The session itself is still good (non-★ calls work), and stays stale until the password.
    expect((await s.local('me', {}, token)).json.session).toMatchObject({ freshUntil: 0 });
    expect((await s.local('reauth', { password: 'not-it-at-all' }, token)).json).toMatchObject({ wrongPassword: true });
    const re = await s.local('reauth', { password: PASS }, token);
    expect(re.status).toBe(200);
    expect((re.json.session as { freshUntil: number }).freshUntil).toBeGreaterThan(s.clock.t);
    expect((await s.local('conduct/summary', {}, token)).status).toBe(200);
  });
});

describe('T-ADM-16 and moderator scrubbing over HTTP', () => {
  const rows = [
    { id: 1, name: 'Kiddo', address: '192.168.1.23', original: 'typed text', shown: 'Great flying, everyone!', hits: ['profanity:x'], email: 'kiddo@caldwellschools.org', display: 'substituted' },
    { id: 2, name: 'Quiet', address: '192.168.1.24', original: 'private', shown: '', hits: [], tags: ['SELF-HARM'], display: 'withheld' },
  ];
  const handlers = { 'chat/live': stub({ lines: rows, next: 2, gap: false }), 'rooms/list': stub({ rooms: [] }) };

  it('a limited moderator never receives an address, email, original, hit labels or a SELF-HARM row; the host PC gets addresses', async () => {
    const s = await stack({ lan: null, policy: { moderatorView: true }, handlers });
    const host = await setUp(s);
    const id = randomBytes(16).toString('hex');
    s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES (?, 'Wingmate', 'wingmate', '', ?, ?, 1, 'active')`,
      id, `#none:${id}`, await hashAdminPassword(PASS, FAST));
    s.run("INSERT INTO admins (account_id, added_at, added_by) VALUES (?, 1, 'test')", id);
    const login = await s.local('login', { role: 'moderator', username: 'Wingmate', password: PASS });
    expect(login.status, login.text).toBe(200);
    const mt = login.json.token as string;
    const me = await s.local('me', {}, mt);
    expect(me.json.capabilities).toEqual(['status.counts', 'live', 'rooms.read', 'reports', 'moderate', 'whois']);
    const live = await s.local('chat/live', {}, mt);
    expect(live.status).toBe(200);
    const lines = live.json.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ id: 1, name: 'Kiddo', addressTag: expect.stringMatching(/^[0-9a-f]{4}$/), shown: 'Great flying, everyone!', tags: ['PROFANITY'], display: 'substituted' });
    expect(live.text).not.toContain('192.168.1');
    expect(live.text).not.toContain('typed text');
    expect(live.text).not.toContain('caldwellschools');
    expect((await s.local('conduct/summary', {}, mt)).status).toBe(403);
    expect((await s.local('actions', {}, mt)).status).toBe(403);
    expect((await s.local('bans/create', { kind: 'ban', address: '192.168.1.23', duration: '1d', reason: 'test' }, mt)).json.error).toBe('Ask the host.');
    expect((await s.local('password', { current: PASS, next: 'Another-Pass-42' }, mt)).status).toBe(403);
    // The host on the host PC: addresses and the SELF-HARM row, but no original text outside the reveal routes.
    const hostLive = await s.local('chat/live', {}, host);
    expect((hostLive.json.lines as unknown[]).length).toBe(2);
    expect(hostLive.text).toContain('192.168.1.23');
    expect(hostLive.text).not.toContain('typed text');
    const acts = await s.local('actions', { limit: 50 }, host);
    expect(acts.status).toBe(200);
    expect((acts.json.actions as { action: string }[]).map((a) => a.action)).toEqual(expect.arrayContaining(['setup', 'login']));
    // Demoted → the next call gets 401.
    s.run('DELETE FROM admins WHERE account_id = ?', id);
    expect((await s.local('chat/live', {}, mt)).status).toBe(401);
  });
});

describe('startAdminPanel (the LAN child) and the main port (VPS / npm start)', () => {
  it('startAdminPanel: the launcher code, setup applies the preset through the settings, onStateChange, settings/* behind ★', async () => {
    const { SettingsService, memoryBackend } = await import('../settings/service');
    const { startAdminPanel } = await import('./http');
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-panel-'));
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const settings = SettingsService.open({ backend: memoryBackend(), lan: true, env: {}, log: () => undefined });
    const states: unknown[] = [];
    const code = newSetupCode();
    const panel = await startAdminPanel({ dbPath, port: 0, service: null, settings, pepper: randomBytes(32), setupCode: code, log: () => undefined, onStateChange: (st) => states.push(st) });
    cleanups.push(async () => { await panel.close(); await settings.close(); rmSync(dir, { recursive: true, force: true }); });
    const post = (name: string, body: unknown, token?: string) => call({
      port: panel.port, path: `/api/admin/${name}`, body,
      headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${panel.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    expect(panel.hostAdmin.state()).toMatchObject({ setupPending: true, setupKind: 'first' });
    const r = await post('setup', { setupCode: code, username: 'NovaPilot', password: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'roster', domains: ['caldwellschools.org'] });
    expect(r.status, r.text).toBe(200);
    expect(states).toEqual([{ setupPending: false, setupKind: null, username: 'NovaPilot' }]);
    expect(settings.get()).toMatchObject({
      preset: 'school', serverName: 'Room 136',
      accounts: { signup: 'rosterOnly', allowGuests: false, domains: [{ domain: 'caldwellschools.org', subdomains: false }] },
    });
    const token = r.json.token as string;
    const got = await post('settings/get', {}, token);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ ok: true, settings: { serverName: 'Room 136' } });
    const upd = await post('settings/update', { rev: got.json.rev, patch: { admin: { idleMinutes: 45 } } }, token);
    expect(upd.status, upd.text).toBe(200);
    expect((await post('me', {}, token)).json.session).toMatchObject({ idleSec: 45 * 60 });
    expect((await post('settings/update', { rev: 1, patch: { admin: { idleMinutes: 50 } } }, token)).status).toBe(409);
  });

  it('startAdminPanel: the LAN https binding follows admin.remoteAccess live (bound while on, gone when off)', async () => {
    if (!lanOk) return; // this PC can't bind 127.0.0.2
    const { SettingsService, memoryBackend, SYSTEM_SETTINGS_ACTOR } = await import('../settings/service');
    const { startAdminPanel } = await import('./http');
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-panel-lan-'));
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const settings = SettingsService.open({ backend: memoryBackend(), lan: true, env: {}, log: () => undefined });
    const code = newSetupCode();
    let reads = 0;
    const panel = await startAdminPanel({
      dbPath, port: 0, service: null, settings, setupCode: code, log: () => undefined,
      lanBinding: () => { reads++; return { address: '127.0.0.2', tls: identity }; },
    });
    cleanups.push(async () => { await panel.close(); await settings.close(); rmSync(dir, { recursive: true, force: true }); });
    const lanBound = (): boolean => panel.listener.bound().some((b) => b.binding === 'admin-lan' && b.secure);
    expect(settings.get().admin.remoteAccess).toBe('off');
    expect(lanBound()).toBe(false);
    expect(reads).toBe(0);
    const on = await settings.apply({ admin: { remoteAccess: 'limited' } }, SYSTEM_SETTINGS_ACTOR);
    expect(on.ok, JSON.stringify(on)).toBe(true);
    await panel.refreshLan();
    expect(lanBound()).toBe(true);
    const r = await call({ port: panel.port, connect: '127.0.0.2', host: `127.0.0.2:${panel.port}`, tls: true, path: '/api/admin/login', body: { username: 'x', password: 'y' },
      headers: { 'Content-Type': 'application/json', Origin: `https://127.0.0.2:${panel.port}` } });
    expect(r.status).toBe(401); // reached the API over TLS (no host admin yet)
    // The same binding again (a refresh with nothing new) is not re-bound.
    const before = panel.listener.bound();
    await panel.refreshLan();
    expect(panel.listener.bound()).toEqual(before);
    const off = await settings.apply({ admin: { remoteAccess: 'off' } }, SYSTEM_SETTINGS_ACTOR);
    expect(off.ok).toBe(true);
    await panel.refreshLan();
    expect(lanBound()).toBe(false);
    await expect(call({ port: panel.port, connect: '127.0.0.2', host: `127.0.0.2:${panel.port}`, tls: true, path: '/', method: 'GET' })).rejects.toThrow();
  });

  it('the main port: a loopback operator is `direct` (never host PC); a tunnel without TRUST_PROXY can\'t sign in', async () => {
    const { createServer } = await import('node:http');
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-main-'));
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const ha = new HostAdmin({ dbPath, passwordParams: FAST });
    const db = new DatabaseSync(dbPath);
    const { setHostAdminCredential } = await import('./hostAdmin');
    await setHostAdminCredential(db, { username: 'Operator', password: PASS, params: FAST });
    db.close();
    const api = createAdminHttp({ service: null, trustProxy: false, log: () => undefined, hostAdmin: ha });
    const server = createServer((req, res) => { void api.handle(req, res).then((h) => { if (!h) res.writeHead(404).end(); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    cleanups.push(async () => { await new Promise<void>((r) => server.close(() => r())); ha.close(); rmSync(dir, { recursive: true, force: true }); });
    const post = (name: string, body: unknown, headers: Record<string, string> = {}) => call({
      port, path: `/api/admin/${name}`, body, headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}`, ...headers },
    });
    const login = await post('login', { username: 'Operator', password: PASS });
    expect(login.status, login.text).toBe(200);
    expect(login.json.session).toMatchObject({ principal: { kind: 'host', via: 'full' } });
    const token = login.json.token as string;
    expect((await post('shutdown', { confirm: true }, { Authorization: `Bearer ${token}` })).json.error).toBe('Host PC only');
    expect((await post('setup/status', {})).status).toBe(403);
    // cloudflared to 127.0.0.1 without TRUST_PROXY: forwarding headers, so not `direct`, and not https.
    const tunnel = await post('login', { username: 'Operator', password: PASS }, { 'CF-Connecting-IP': '203.0.113.9', Origin: `http://x.trycloudflare.com`, Host: 'x.trycloudflare.com' });
    expect(tunnel.status).toBe(403);
    // No host admin yet → login says so (VPS: admin-set).
    const dir2 = mkdtempSync(join(tmpdir(), 'voidswarm-main2-'));
    const db2 = join(dir2, 'voidswarm.db');
    new AuthStore(db2).close();
    const ha2 = new HostAdmin({ dbPath: db2, passwordParams: FAST });
    cleanups.push(() => { ha2.close(); rmSync(dir2, { recursive: true, force: true }); });
    expect(await ha2.login({ username: 'Operator', password: PASS }, { address: 'loopback', via: 'direct', hostPc: false, secure: false, trustedTls: false }))
      .toMatchObject({ status: 401, needsSetup: true, error: ADMIN_ERR.noHostAdmin });
  });
});

// ------------------------------------------------------------------------------------------ fixer round 1 (verifier findings)

describe('SELF-HARM rows (§5.2, §5.4, §5.15): moderators never, a host without `wellbeing` only nameless', () => {
  /** What the Zone logs for a self-harm line, as a report's shown-only copy (auth/store.ts): no tags, empty hits. */
  const withheldCopy = () => reportChatCopy({
    id: 41, ts: 1, roomId: 'r1', roomUid: 'u1', roomName: 'Zone', channel: 'all', team: 0, playerId: 7, name: 'Kiddo',
    accountId: 'acc-kiddo', address: '192.168.1.23', original: '(generated test line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld',
  });
  const passCopy = () => reportChatCopy({
    id: 40, ts: 1, roomId: 'r1', roomUid: 'u1', roomName: 'Zone', channel: 'all', team: 0, playerId: 8, name: 'Gremlin',
    accountId: null, address: '192.168.1.31', original: 'gg', shown: 'gg', action: 'pass', hits: [], display: 'as-typed',
  });

  async function withModerator(tier: 'limited' | 'trusted') {
    const s = await stack({ lan: null, policy: { moderatorView: true, moderatorTier: tier } });
    const host = await setUp(s);
    const id = randomBytes(16).toString('hex');
    s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES (?, 'Wingmate', 'wingmate', '', ?, ?, 1, 'active')`,
      id, `#none:${id}`, await hashAdminPassword(PASS, FAST));
    s.run("INSERT INTO admins (account_id, added_at, added_by) VALUES (?, 1, 'test')", id);
    const login = await s.local('login', { role: 'moderator', username: 'Wingmate', password: PASS });
    expect(login.status, login.text).toBe(200);
    return { s, host, mt: login.json.token as string };
  }

  it('a report holding a withheld line: limited and trusted moderators get the report without that line', async () => {
    for (const tier of ['limited', 'trusted'] as const) {
      const { s, host, mt } = await withModerator(tier);
      expect(withheldCopy()).toMatchObject({ name: 'Kiddo', display: 'withheld', hits: [] });
      s.mod.store.addReport({
        ts: s.clock.t, reporter: { playerId: 9, name: 'Pal', accountId: null, address: '192.168.1.30' },
        target: { playerId: 8, name: 'Gremlin', accountId: null, address: '192.168.1.31' }, reason: 'test', room: 'Zone',
        recentChat: [passCopy() as never, withheldCopy() as never],
      });
      const r = await s.local('reports', { status: 'open' }, mt);
      expect(r.status, `${tier}: ${r.text}`).toBe(200);
      const reports = r.json.reports as { recentChat: Record<string, unknown>[] }[];
      expect(reports).toHaveLength(1);
      expect(reports[0]!.recentChat.map((l) => l.id), tier).toEqual([40]);
      expect(r.text, tier).not.toContain('Kiddo');
      expect(r.text, tier).not.toContain('acc-kiddo');
      expect(r.text, tier).not.toContain('withheld');
      // The host on the host PC (it has `wellbeing`) still gets the line.
      const hr = await s.local('reports', { status: 'open' }, host);
      expect((hr.json.reports as { recentChat: unknown[] }[])[0]!.recentChat).toHaveLength(2);
    }
  });

  it('a withheld line with no tags or hits never reaches a moderator (chat/live, nested values too)', () => {
    for (const tier of ['limited', 'trusted'] as const) {
      const rules = scrubRulesFor({ kind: 'moderator', tier }, ADMIN_ROUTES['chat/live']!);
      const out = scrubReply({ lines: [{ id: 1, name: 'Kiddo', shown: '', display: 'withheld' }, { id: 2, name: 'Pal', shown: 'hi', display: 'as-typed' }], anchor: { name: 'Kiddo', display: 'withheld' } }, rules, () => 'abcd');
      expect(out, tier).toEqual({ lines: [{ id: 2, name: 'Pal', shown: 'hi', display: 'as-typed' }], anchor: null });
    }
  });

  it('a remote `limited` host (no `wellbeing`) gets the nameless "Wellbeing alert" line on a feed, none on a route about one person; the host PC and trusted-TLS `full` get it whole', () => {
    const row = { id: 7, ts: 5, roomName: 'Zone', channel: 'all', playerId: 3, name: 'Kiddo', accountId: 'acc-kiddo', address: '192.168.1.23', shown: '', display: 'withheld', hits: ['selfharm:x'], student: { name: 'Kiddo' } };
    const limited = scrubRulesFor({ kind: 'host', via: 'limited' }, ADMIN_ROUTES['chat/live']!);
    expect(limited).toMatchObject({ selfHarm: false, selfHarmNameless: true });
    const out = scrubReply({ lines: [row], report: { recentChat: [row] }, one: row }, limited, () => 'abcd') as Record<string, unknown>;
    const nameless = { id: 7, ts: 5, roomName: 'Zone', channel: 'all', playerId: null, name: '', accountId: null, shown: '', display: 'withheld', tags: ['SELF-HARM'], student: null, wellbeing: true };
    expect(out).toEqual({ lines: [nameless], report: { recentChat: [nameless] }, one: nameless });
    expect(JSON.stringify(out)).not.toMatch(/Kiddo|acc-kiddo|192\.168|selfharm:/);
    // A route about one person (a player filter, a report about someone, whois): not even the nameless line.
    for (const route of ['log', 'log/context', 'reports', 'reports/review', 'whois', 'actions', 'accounts/get']) {
      const rules = scrubRulesFor({ kind: 'host', via: 'limited' }, ADMIN_ROUTES[route]!);
      expect(rules, route).toMatchObject({ selfHarm: true });
      expect(scrubReply({ lines: [row], report: { recentChat: [row] }, one: row }, rules, () => 'abcd'), route).toEqual({ lines: [], report: { recentChat: [] }, one: null });
    }
    // A click-through `full` is capped to `limited` (untrustedTls): nameless too.
    expect(scrubRulesFor({ kind: 'host', via: 'full' }, ADMIN_ROUTES['chat/live']!, { untrustedTls: true })).toMatchObject({ selfHarmNameless: true });
    expect(scrubRulesFor({ kind: 'host', via: 'full' }, ADMIN_ROUTES.log!, { untrustedTls: true })).toMatchObject({ selfHarm: true });
    for (const via of ['local', 'full'] as const) {
      for (const route of ['log', 'chat/live']) {
        const rules = scrubRulesFor({ kind: 'host', via }, ADMIN_ROUTES[route]!);
        expect(rules, via).toMatchObject({ selfHarm: false, selfHarmNameless: false });
        expect(JSON.stringify(scrubReply({ lines: [row] }, rules, () => 'abcd')), via).toContain('Kiddo');
      }
    }
  });

  it('over HTTP: the remote `limited` host session sees the Live SELF-HARM line nameless', async () => {
    if (!lanOk) return;
    const rows = [
      { id: 1, name: 'Pal', address: '192.168.1.30', shown: 'hi', hits: [], display: 'as-typed' },
      { id: 2, name: 'Quiet', accountId: 'acc-quiet', address: '192.168.1.24', shown: '', hits: [], display: 'withheld' },
    ];
    const s = await stack({ policy: { remoteAccess: 'limited' }, handlers: { 'chat/live': stub({ lines: rows, next: 2, gap: false }) } });
    const host = await setUp(s);
    const t = (await s.remote('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const live = await s.remote('chat/live', {}, t);
    expect(live.status, live.text).toBe(200);
    const lines = live.json.lines as Record<string, unknown>[];
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[1]).toEqual({ id: 2, name: '', accountId: null, shown: '', display: 'withheld', tags: ['SELF-HARM'], wellbeing: true });
    expect(live.text).not.toContain('Quiet');
    expect(live.text).not.toContain('192.168.1.24');
    expect(JSON.stringify((await s.local('chat/live', {}, host)).json)).toContain('Quiet');
  });
});

describe('bans/revoke never fails open (a capped list is not the permission check)', () => {
  async function withFiller(kind: 'ban' | 'mute', tier: 'limited' | 'trusted') {
    const s = await stack({ lan: null, policy: { moderatorView: true, moderatorTier: tier } });
    await setUp(s);
    const modId = randomBytes(16).toString('hex');
    s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES (?, 'Wingmate', 'wingmate', '', ?, ?, 1, 'active')`,
      modId, `#none:${modId}`, await hashAdminPassword(PASS, FAST));
    s.run("INSERT INTO admins (account_id, added_at, added_by) VALUES (?, 1, 'test')", modId);
    s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES ('acc-gremlin', 'Gremlin', 'gremlin', '', '#none:acc-gremlin', 'x', 1, 'active')`);
    const t = s.clock.t;
    s.run(`INSERT INTO bans (kind, scope, account_id, username, created_at, expires_at, reason, by) VALUES ('ban', 'account', 'acc-gremlin', 'Gremlin', ?, NULL, 'host ban', 'NovaPilot')`, t);
    const db = new DatabaseSync(s.dbPath);
    try {
      db.exec('BEGIN');
      const ins = db.prepare(`INSERT INTO bans (kind, scope, account_id, username, created_at, expires_at, reason, by) VALUES (?, 'guest', NULL, ?, ?, ?, 'filler', 'NovaPilot')`);
      for (let i = 0; i < 1000; i++) ins.run(kind, `Guest${i}`, t, t + 3_600_000);
      db.exec('COMMIT');
      const hostBanId = Number((db.prepare("SELECT id FROM bans WHERE reason = 'host ban'").get() as { id: number | bigint }).id);
      const login = await s.local('login', { role: 'moderator', username: 'Wingmate', password: PASS });
      expect(login.status, login.text).toBe(200);
      return { s, mt: login.json.token as string, hostBanId };
    } finally { db.close(); }
  }

  it('by id: a limited moderator cannot lift a host ban behind 1000 newer mutes (403 "Ask the host."); an unknown id is 404', async () => {
    const { s, mt, hostBanId } = await withFiller('mute', 'limited');
    const r = await s.local('bans/revoke', { id: hostBanId }, mt);
    expect(r.status, r.text).toBe(403);
    expect(r.json.error).toBe('Ask the host.');
    expect((await s.local('bans/revoke', { id: 999_999 }, mt)).status).toBe(404);
    expect(s.mod.store.getBan(hostBanId, s.clock.t)?.active).toBe(true);
  }, 60_000);

  it('by target: a trusted moderator (no `ban.host`) cannot lift a host ban behind 1000 newer bans', async () => {
    const { s, mt, hostBanId } = await withFiller('ban', 'trusted');
    const r = await s.local('bans/revoke', { target: 'Gremlin', kind: 'ban' }, mt);
    expect(r.status, r.text).toBe(403);
    expect(r.json.error).toBe('Ask the host.');
    expect((await s.local('bans/revoke', { id: hostBanId }, mt)).status).toBe(403);
    expect(s.mod.store.getBan(hostBanId, s.clock.t)?.active).toBe(true);
  }, 60_000);
});

describe('call budget per session; password not from a click-through; the scrubber fails closed', () => {
  it('one host-PC session spending its budget never 429s another; remote sessions also share a per-principal cap', async () => {
    const s = await stack({ policy: { remoteAccess: 'limited' }, limits: { calls: [10, 60_000] } });
    const first = await setUp(s);
    const second = (await s.local('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    for (let i = 0; i < 10; i++) expect((await s.local('bans', {}, second)).status).toBe(200);
    expect((await s.local('bans', {}, second)).status).toBe(429);
    expect((await s.local('bans', {}, first)).status).toBe(200);
    if (!lanOk) return;
    const remotes: string[] = [];
    for (let i = 0; i < 3; i++) remotes.push((await s.remote('login', { username: 'NovaPilot', password: PASS })).json.token as string);
    for (const t of remotes.slice(0, 2)) for (let i = 0; i < 10; i++) expect((await s.remote('bans', {}, t)).status).toBe(200);
    expect((await s.remote('bans', {}, remotes[2])).status).toBe(429); // 2 x 10 per principal off the host PC
    expect((await s.local('bans', {}, first)).status).toBe(200); // the host PC is never slowed by them
  }, 60_000);

  it('a remote `limited` host session cannot change the host admin password (the host PC session survives)', async () => {
    if (!lanOk) return;
    const s = await stack({ policy: { remoteAccess: 'limited' } });
    const host = await setUp(s);
    const t = (await s.remote('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const r = await s.remote('password', { current: PASS, next: 'Another-Pass-42' }, t);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe(ADMIN_ERR.passwordHere);
    expect((await s.local('me', {}, host)).status).toBe(200);
    expect((await s.local('login', { username: 'NovaPilot', password: PASS })).status).toBe(200);
  });

  it('scrubReply drops what is deeper than its limit instead of passing it through', () => {
    const rules = scrubRulesFor({ kind: 'moderator', tier: 'limited' }, ADMIN_ROUTES['chat/live']!);
    let deep: Record<string, unknown> = { original: 'typed text', address: '192.168.1.23', email: 'kiddo@caldwellschools.org' };
    for (let i = 0; i < SCRUB_MAX_DEPTH + 2; i++) deep = { n: deep };
    const out = JSON.stringify(scrubReply(deep, rules, () => 'abcd'));
    expect(out).not.toMatch(/typed text|192\.168|caldwellschools/);
    // Within the limit the same object is scrubbed normally.
    let shallow: Record<string, unknown> = { original: 'typed text', address: '192.168.1.23', shown: 'ok' };
    for (let i = 0; i < 5; i++) shallow = { n: shallow };
    const kept = JSON.stringify(scrubReply(shallow, rules, () => 'abcd'));
    expect(kept).toContain('"shown":"ok"');
    expect(kept).not.toMatch(/typed text|192\.168/);
  });
});

describe('the main port: a DNS-rebinding page is never `direct`', () => {
  it('Host evil.example with a matching Origin from loopback: sign-in refused (not host `full`)', async () => {
    const { createServer } = await import('node:http');
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-rebind-'));
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    const { setHostAdminCredential } = await import('./hostAdmin');
    await setHostAdminCredential(db, { username: 'Operator', password: PASS, params: FAST });
    db.close();
    const ha = new HostAdmin({ dbPath, passwordParams: FAST });
    const api = createAdminHttp({ service: null, trustProxy: false, log: () => undefined, hostAdmin: ha });
    const server = createServer((req, res) => { void api.handle(req, res).then((h) => { if (!h) res.writeHead(404).end(); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    cleanups.push(async () => { await new Promise<void>((r) => server.close(() => r())); ha.close(); rmSync(dir, { recursive: true, force: true }); });
    const post = (host: string, origin: string) => call({ port, path: '/api/admin/login', host, body: { username: 'Operator', password: PASS },
      headers: { 'Content-Type': 'application/json', Origin: origin } });
    const rebind = await post(`evil.example:${port}`, `http://evil.example:${port}`);
    expect(rebind.status, rebind.text).toBe(403);
    expect(rebind.json.token).toBeUndefined();
    // A Host with another port (and its own Origin): refused as well.
    expect((await post(`localhost:${port + 1}`, `http://localhost:${port + 1}`)).status).toBe(403);
    // The operator's own browser still signs in.
    const ok = await post(`localhost:${port}`, `http://localhost:${port}`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.session).toMatchObject({ principal: { kind: 'host', via: 'full' } });
  });
});

// ------------------------------------------------------------------------------------------ fixer round 2 (verifier findings)

describe('the Chat log never pages past what the caller may see (§5.2, §5.15)', () => {
  const INSERT_CHAT = `INSERT INTO chat_log (id, ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address, original, shown, action, hits)
                       VALUES (?, ?, 'r1', 'Zone lobby', 'all', -1, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`;
  const chat = (s: Stack, id: number, name: string, original: string, shown: string, action: string, hits: string[]): void =>
    s.run(INSERT_CHAT, id, 1_000 + id, id, name, name.toLowerCase(), `192.168.1.${id % 250}`, original, shown, action, JSON.stringify(hits));

  async function withTrusted(policy: Partial<AdminPolicy> = {}) {
    const s = await stack({ policy: { moderatorView: true, moderatorTier: 'trusted', moderatorLogSearch: true, remoteAccess: 'limited', ...policy } });
    const host = await setUp(s);
    const id = randomBytes(16).toString('hex');
    s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES (?, 'Wingmate', 'wingmate', '', ?, ?, 1, 'active')`,
      id, `#none:${id}`, await hashAdminPassword(PASS, FAST));
    s.run("INSERT INTO admins (account_id, added_at, added_by) VALUES (?, 1, 'test')", id);
    const login = await s.local('login', { role: 'moderator', username: 'Wingmate', password: PASS });
    expect(login.status, login.text).toBe(200);
    const remote = lanOk ? (await s.remote('login', { username: 'NovaPilot', password: PASS })).json.token as string : null;
    return { s, host, mt: login.json.token as string, remote };
  }
  const ids = (r: Reply): number[] => (r.json.lines as { id: number }[]).map((l) => l.id);

  it('without `reveal` a search matches the shown text only, and its cursor says nothing about the original text', async () => {
    const { s, host, mt, remote } = await withTrusted();
    chat(s, 1, 'Alpha', 'my locker code is 4417', 'my locker code is ****', 'mask', ['profanity:x']);
    chat(s, 2, 'Beta', 'code 4417 again', 'code **** again', 'mask', ['profanity:x']);
    chat(s, 3, 'Gamma', 'hello all', 'hello all', 'pass', []);
    const callers: [string, (n: string, b: unknown, t?: string) => Promise<Reply>, string][] = [['trusted moderator', s.local, mt]];
    if (remote) callers.push(['remote limited host', s.remote, remote]);
    for (const [who, post, token] of callers) {
      for (const q of [{ grep: '4417', limit: 1 }, { grep: '4417' }, { grep: '9999', limit: 1 }]) {
        const r = await post('log', q, token);
        expect(r.status, `${who} ${r.text}`).toBe(200);
        expect(r.json, `${who} ${JSON.stringify(q)}`).toEqual({ ok: true, lines: [], nextBefore: null });
      }
      // The shown text is searchable, and pages by the rows returned.
      const p1 = await post('log', { grep: '****', limit: 1 }, token);
      expect([ids(p1), p1.json.nextBefore], who).toEqual([[2], 2]);
      const p2 = await post('log', { grep: '****', limit: 1, before: 2 }, token);
      expect([ids(p2), p2.json.nextBefore], who).toEqual([[1], null]);
      expect(p1.text + p2.text, who).not.toContain('4417');
    }
    // The host PC (`reveal`) searches the original text.
    expect(ids(await s.local('log', { grep: '4417' }, host))).toEqual([2, 1]);
  });

  it('SELF-HARM rows are left out before paging: no cursor, gap or person filter names the student', async () => {
    const { s, host, mt, remote } = await withTrusted();
    chat(s, 9, 'Kiddo', 'gg', 'gg', 'pass', []);
    chat(s, 10, 'Kiddo', 'wellbeing placeholder text', '', 'block', ['selfharm:x']);
    chat(s, 11, 'Other', 'nice shot', 'nice shot', 'pass', []);
    const callers: [string, (n: string, b: unknown, t?: string) => Promise<Reply>, string][] = [['trusted moderator', s.local, mt]];
    if (remote) callers.push(['remote limited host', s.remote, remote]);
    for (const [who, post, token] of callers) {
      const kiddo = await post('log', { player: 'Kiddo', limit: 1 }, token);
      expect(kiddo.json, who).toMatchObject({ ok: true, nextBefore: null });
      expect(ids(kiddo), who).toEqual([9]);
      const all = await post('log', { player: 'Kiddo' }, token);
      expect(ids(all), who).toEqual([9]); // not even the nameless "Wellbeing alert" line
      const page = await post('log', { limit: 1 }, token);
      expect([ids(page), page.json.nextBefore], who).toEqual([[11], 11]);
      const next = await post('log', { limit: 1, before: 11 }, token);
      expect([ids(next), next.json.nextBefore], who).toEqual([[9], null]);
      const text = kiddo.text + all.text + page.text + next.text;
      expect(text, who).not.toMatch(/placeholder|"id":10|SELF-HARM|wellbeing/);
    }
    // The host PC (`wellbeing`) gets the line.
    expect(ids(await s.local('log', { player: 'Kiddo' }, host))).toEqual([10, 9]);
  });

  it('a report about a student: the remote `limited` host gets none of their SELF-HARM lines (not even nameless); the host PC does', async () => {
    if (!lanOk) return;
    const { s, host, remote } = await withTrusted();
    const copy = (id: number, shown: string, hits: string[], display: string) => reportChatCopy({
      id, ts: 1, roomId: 'r1', roomUid: 'u1', roomName: 'Zone', channel: 'all', team: 0, playerId: 7, name: 'Kiddo',
      accountId: 'acc-kiddo', address: '192.168.1.23', original: '(generated test line)', shown, action: hits.length ? 'block' : 'pass', hits, display,
    });
    s.mod.store.addReport({
      ts: s.clock.t, reporter: { playerId: 9, name: 'Pal', accountId: null, address: '192.168.1.30' },
      target: { playerId: 7, name: 'Kiddo', accountId: 'acc-kiddo', address: '192.168.1.23' }, reason: 'test', room: 'Zone',
      recentChat: [copy(40, 'gg', [], 'as-typed') as never, copy(41, '', ['selfharm:x'], 'withheld') as never],
    });
    const r = await s.remote('reports', { status: 'open' }, remote!);
    expect(r.status, r.text).toBe(200);
    expect((r.json.reports as { recentChat: { id: number }[] }[])[0]!.recentChat.map((l) => l.id)).toEqual([40]);
    expect(r.text).not.toMatch(/withheld|wellbeing|SELF-HARM/);
    expect((await s.local('reports', { status: 'open' }, host)).json.reports).toMatchObject([{ recentChat: [{ id: 40 }, { id: 41 }] }]);
  });

  it('visibleLogPage: past LOG_SCAN_ROWS the cursor is the lowest scanned row the caller may see, never a hidden one', async () => {
    const s = await stack({ lan: null });
    const top = LOG_SCAN_ROWS + 1002; // ids 1..top; the 5th scanned page ends at id 1003
    const db = new DatabaseSync(s.dbPath);
    try {
      db.exec('BEGIN');
      const ins = db.prepare(INSERT_CHAT);
      for (let id = 1; id <= top; id++) {
        const hidden = id >= 1003 && id <= 1010;
        ins.run(id, id, id, 'Filler', 'filler', '192.168.1.5', id === 1 ? 'the needle here' : 'filler line', id === 1 ? 'the needle here' : 'filler line',
          hidden ? 'block' : 'pass', JSON.stringify(hidden ? ['selfharm:x'] : []));
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    const see = { original: false, selfHarm: false };
    const first = visibleLogPage(s.mod.store, { grep: 'needle', limit: 5 }, see);
    expect(first).toEqual({ lines: [], nextBefore: 1011 }); // not 1003..1010 (hidden), not the store's own cursor
    const second = visibleLogPage(s.mod.store, { grep: 'needle', limit: 5, before: first.nextBefore! }, see);
    expect(second.lines.map((l) => l.id)).toEqual([1]);
    expect(second.nextBefore).toBeNull();
    // With `reveal` and `wellbeing` it is the store's own query.
    expect(visibleLogPage(s.mod.store, { limit: 2 }, { original: true, selfHarm: true })).toMatchObject({ nextBefore: top - 1 });
  }, 60_000);
});

describe('host bans stay host bans after the host admin is renamed (§5.2 "not host bans")', () => {
  async function withBan() {
    const s = await stack({ lan: null, policy: { moderatorView: true, moderatorTier: 'trusted' } });
    await setUp(s);
    const id = randomBytes(16).toString('hex');
    s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES (?, 'Wingmate', 'wingmate', '', ?, ?, 1, 'active')`,
      id, `#none:${id}`, await hashAdminPassword(PASS, FAST));
    s.run("INSERT INTO admins (account_id, added_at, added_by) VALUES (?, 1, 'test')", id);
    const host = (await s.local('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const made = await s.local('bans/create', { kind: 'ban', scope: 'address', address: '192.168.1.77', duration: 'perm', reason: 'host decision' }, host);
    expect(made.status, made.text).toBe(200);
    const banId = (made.json.ban as { id: number }).id;
    const mt = (await s.local('login', { role: 'moderator', username: 'Wingmate', password: PASS })).json.token as string;
    expect((await s.local('bans/revoke', { id: banId }, mt)).status).toBe(403);
    return { s, banId, mt };
  }

  it('admin-set with a new name: a trusted moderator still cannot lift it; the host under its new name can', async () => {
    const { s, banId, mt } = await withBan();
    const db = new DatabaseSync(s.dbPath);
    try { await setHostAdminCredential(db, { username: 'NewHost', password: PASS, params: FAST }); } finally { db.close(); }
    const lift = await s.local('bans/revoke', { id: banId }, mt);
    expect(lift.status, lift.text).toBe(403);
    expect(lift.json.error).toBe('Ask the host.');
    expect((await s.local('bans/revoke', { target: '192.168.1.77', kind: 'ban' }, mt)).status).toBe(403);
    expect(s.mod.store.getBan(banId, s.clock.t)).toMatchObject({ active: true, by: 'NewHost' });
    const host = (await s.local('login', { username: 'NewHost', password: PASS })).json.token as string;
    expect((await s.local('bans/revoke', { id: banId }, host)).json).toMatchObject({ ok: true, revoked: 1 });
  });

  it('a rename that bypassed the tools (the row edited directly): the audit trail still knows the earlier name', async () => {
    const { s, banId, mt } = await withBan();
    s.run("UPDATE host_admins SET username = 'NewHost', username_lower = 'newhost'");
    const lift = await s.local('bans/revoke', { id: banId }, mt);
    expect(lift.status, lift.text).toBe(403);
    expect(s.mod.store.getBan(banId, s.clock.t)?.active).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ fixer round 1 (B6 verifier findings)

/** A Zone stand-in: who is online, who was kicked or told (generated callsigns and addresses). */
class FakeZone implements ZoneControl {
  pilots: OnlinePilot[] = [];
  kicked: number[] = [];
  told: number[] = [];
  add(p: Partial<OnlinePilot> & { playerId: number; name: string }): void {
    this.pilots.push({ accountId: null, username: null, address: null, roomId: null, roomName: null, ...p });
  }
  onlinePilots(): OnlinePilot[] { return this.pilots.slice(); }
  kickPilots(select: (p: OnlinePilot) => boolean): number {
    const out = this.pilots.filter(select);
    this.kicked.push(...out.map((p) => p.playerId));
    this.pilots = this.pilots.filter((p) => !out.includes(p));
    return out.length;
  }
  tellPilot(playerId: number): boolean {
    if (!this.pilots.some((p) => p.playerId === playerId)) return false;
    this.told.push(playerId);
    return true;
  }
}

async function addModerator(s: Stack, username: string): Promise<string> {
  const id = randomBytes(16).toString('hex');
  s.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status) VALUES (?, ?, ?, '', ?, ?, 1, 'active')`,
    id, username, username.toLowerCase(), `#none:${id}`, await hashAdminPassword(PASS, FAST));
  s.run("INSERT INTO admins (account_id, added_at, added_by) VALUES (?, 1, 'test')", id);
  s.mod.reload();
  return id;
}

describe('a network address as `target` (§5.2 "Network addresses", "Nobody below the host can act on a moderator")', () => {
  const NET = '192.168.1.23';
  async function withZone() {
    const s = await stack({ policy: { moderatorView: true, moderatorTier: 'limited', remoteAccess: 'limited' } });
    const host = await setUp(s);
    await addModerator(s, 'Wingmate');
    const other = await addModerator(s, 'OtherMod');
    const zone = new FakeZone();
    zone.add({ playerId: 1, name: 'Kiddo', accountId: 'acc-kiddo', username: 'Kiddo', address: NET });
    zone.add({ playerId: 2, name: 'OtherMod', accountId: other, username: 'OtherMod', address: NET });
    zone.add({ playerId: 3, name: 'HostPlays', address: '127.0.0.1' });
    zone.add({ playerId: 4, name: 'HostPlays6', address: '0:0:0:0::/64' });
    s.mod.attachZone(zone);
    const login = await s.local('login', { role: 'moderator', username: 'Wingmate', password: PASS });
    expect(login.status, login.text).toBe(200);
    return { s, host, zone, mt: login.json.token as string };
  }
  const bansRows = (s: Stack): unknown[] => {
    const db = new DatabaseSync(s.dbPath);
    try { return db.prepare('SELECT id FROM bans').all(); } finally { db.close(); }
  };

  it('a limited moderator: whois, kick, warn, a network mute and a lift by address are all refused, and say nothing about who is there', async () => {
    const { s, zone, mt } = await withZone();
    for (const [route, body] of [
      ['whois', { target: NET }], ['kick', { target: NET, reason: 'test' }], ['warn', { target: NET, reason: 'test' }],
    ] as const) {
      const r = await s.local(route, body, mt);
      expect(r.status, `${route} ${r.text}`).toBe(403);
      expect(r.text, route).not.toMatch(/Kiddo|OtherMod|HostPlays/);
    }
    for (const confirm of [true, false]) {
      const r = await s.local('bans/create', { kind: 'mute', target: NET, duration: '1h', reason: 'test', confirm }, mt);
      expect([r.status, r.json.error], r.text).toEqual([403, 'Ask the host.']);
      expect(r.json.sharing).toBeUndefined(); // the 409 would have counted the pilots on that network
    }
    expect((await s.local('bans/revoke', { target: NET, kind: 'mute' }, mt)).json.error).toBe('Ask the host.');
    expect(bansRows(s)).toEqual([]);
    expect([zone.kicked, zone.told]).toEqual([[], []]);
    // By name they still work (Kiddo is a student), never on a moderator.
    expect((await s.local('warn', { target: 'Kiddo', reason: 'test' }, mt)).json).toMatchObject({ ok: true, warned: 1 });
    expect((await s.local('kick', { target: 'OtherMod', reason: 'test' }, mt)).json.error).toBe('Only the host can act on a moderator.');
    expect(zone.kicked).toEqual([]);
  });

  it('a trusted moderator may look an address up, but a kick or warn that would reach a moderator there is refused', async () => {
    const { s, zone, mt } = await withZone();
    s.policy.moderatorTier = 'trusted';
    const w = await s.local('whois', { target: NET }, mt);
    expect(w.status, w.text).toBe(200);
    expect((w.json.whois as { online: { name: string }[] }).online.map((o) => o.name)).toEqual(['Kiddo', 'OtherMod']);
    for (const route of ['kick', 'warn'] as const) {
      const r = await s.local(route, { target: NET, reason: 'test' }, mt);
      expect([r.status, r.json.error], route).toEqual([403, 'Only the host can act on a moderator.']);
    }
    expect([zone.kicked, zone.told]).toEqual([[], []]);
  });

  it("the host: a kick by address reaches everyone there but never the host PC's own connection", async () => {
    const { s, host, zone } = await withZone();
    for (const addr of ['127.0.0.1', '0:0:0:0::/64']) {
      const r = await s.local('kick', { target: addr, reason: 'test' }, host);
      expect(r.status, `${addr} ${r.text}`).toBe(404);
    }
    expect(zone.kicked).toEqual([]);
    const r = await s.local('kick', { target: NET, reason: 'test' }, host);
    expect(r.json, r.text).toMatchObject({ ok: true, kicked: 2 });
    expect(zone.kicked).toEqual([1, 2]);
    expect(zone.pilots.map((p) => p.playerId)).toEqual([3, 4]);
  });

  it("a remote `limited` host (a click-through: address tags only) can't look an address up either", async () => {
    if (!lanOk) return;
    const { s } = await withZone();
    const t = (await s.remote('login', { username: 'NovaPilot', password: PASS })).json.token as string;
    const r = await s.remote('whois', { target: NET }, t);
    expect(r.status, r.text).toBe(403);
    expect(r.text).not.toMatch(/Kiddo|OtherMod/);
    expect((await s.remote('whois', { target: 'Kiddo' }, t)).status).toBe(200);
  });
});

describe('a refused call never counts as activity (§4.10 idle timeout and step-up)', () => {
  it('a session making only refused calls goes stale and idle; an accepted call still counts; Live still keeps the host PC alive', async () => {
    const s = await stack({ lan: null, policy: { moderatorView: true }, handlers: { 'chat/live': stub({ lines: [] }), 'conduct/summary': stub({ rows: [] }) } });
    await setUp(s);
    await addModerator(s, 'Wingmate');
    const login = async (role: 'host' | 'moderator'): Promise<string> =>
      (await s.local('login', { role, username: role === 'host' ? 'NovaPilot' : 'Wingmate', password: PASS })).json.token as string;
    const mt = await login('moderator');
    const loginAt = s.clock.t;
    for (let i = 1; i <= 3; i++) {
      s.clock.t += 9 * MIN;
      expect((await s.local('conduct/summary', {}, mt)).status).toBe(403); // refused by the route's capability
      const inHandler = await s.local('bans/create', { kind: 'ban', address: '192.168.1.50', duration: '1d', reason: 'x' }, mt);
      expect([inHandler.status, inHandler.json.error]).toEqual([403, 'Ask the host.']); // refused by the handler
      if (i === 1) expect((await s.local('me', {}, mt)).json.session).toMatchObject({ freshUntil: loginAt + 10 * MIN }); // not slid
    }
    s.clock.t += 4 * MIN; // 31 minutes after the last accepted call (the login)
    expect((await s.local('me', {}, mt)).json).toMatchObject({ error: ADMIN_ERR.idle });

    // The host PC: an accepted deliberate call slides step-up and the idle timer; a refused ★ call (401 reauth) neither.
    const h = await login('host');
    s.clock.t += 9 * MIN;
    expect((await s.local('bans', {}, h)).status).toBe(200);
    s.clock.t += 9 * MIN;
    expect((await s.local('conduct/summary', {}, h)).status).toBe(200); // still fresh: slid by the accepted call
    s.clock.t += 11 * MIN;
    expect((await s.local('conduct/summary', {}, h)).json).toMatchObject({ reauth: true });
    s.clock.t += 9 * MIN;
    expect((await s.local('conduct/summary', {}, h)).json).toMatchObject({ reauth: true });
    s.clock.t += 11 * MIN; // 31 minutes after the last accepted call
    expect((await s.local('me', {}, h)).json).toMatchObject({ error: ADMIN_ERR.idle });

    // Live polls keep a host PC session alive (liveKeepsAlive) though they are passive.
    const live = await login('host');
    for (let i = 0; i < 12; i++) { s.clock.t += 5 * MIN; expect((await s.local('chat/live', {}, live)).status).toBe(200); }
    expect((await s.local('me', {}, live)).status).toBe(200);
  });
});

describe('refused sign-in and setup attempts are audited (§4.10 "every failure is audited")', () => {
  it('at the door (forwarded, foreign Host, remote off) and in the API (Origin, setup off the host PC)', async () => {
    const { startAdminPanel } = await import('./http');
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-refused-'));
    const dbPath = join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const clock = { t: Date.now() };
    const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY, remoteAccess: 'off' };
    const panel = await startAdminPanel({
      dbPath, port: 0, service: null, policy: () => policy, now: () => clock.t, log: () => undefined,
      lan: lanOk ? { address: '127.0.0.2', tls: identity } : null,
    });
    let closed = false;
    cleanups.push(async () => { if (!closed) await panel.close(); rmSync(dir, { recursive: true, force: true }); });
    const port = panel.port;
    const json = { 'Content-Type': 'application/json' };
    const body = { username: 'NovaPilot', password: PASS };
    const attempts: [string, () => Promise<Reply>, number][] = [
      ['forwarded', () => call({ port, path: '/api/admin/login', body, headers: { ...json, Origin: `http://localhost:${port}`, 'X-Forwarded-For': '203.0.113.9' } }), 403],
      ['foreign Host', () => call({ port, path: '/api/admin/login', host: `evil.example:${port}`, body, headers: { ...json, Origin: `http://evil.example:${port}` } }), 421],
      ['wrong Origin', () => call({ port, path: '/api/admin/login', body, headers: { ...json, Origin: 'http://evil.example' } }), 403],
    ];
    if (lanOk) {
      const lanCall = (p: string) => () => call({ port, path: p, connect: '127.0.0.2', host: `127.0.0.2:${port}`, tls: true, body, headers: { ...json, Origin: `https://127.0.0.2:${port}` } });
      attempts.push(['remote off', lanCall('/api/admin/login'), 403]);
      attempts.push(['setup off the host PC', () => { policy.remoteAccess = 'limited'; return lanCall('/api/admin/setup')(); }, 403]);
    }
    for (const [what, go, status] of attempts) {
      clock.t += 2 * MIN; // past the coalescing window: one row each
      expect((await go()).status, what).toBe(status);
    }
    // A refused request that is not a sign-in (the panel page with a foreign Host) is no sign-in failure.
    expect((await call({ port, path: '/', method: 'GET', host: `evil.example:${port}` })).status).toBe(421);
    await panel.close();
    closed = true;
    const db = new DatabaseSync(dbPath);
    let rows: { action: string; reason: string }[];
    try { rows = db.prepare('SELECT action, reason FROM mod_actions ORDER BY id').all() as typeof rows; } finally { db.close(); }
    expect(rows.every((r) => r.action === 'login-fail'), JSON.stringify(rows)).toBe(true);
    const reasons = rows.map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/^sign-in refused \(403\): The control panel can't be used through a proxy/),
      expect.stringMatching(/^sign-in refused \(421\): Misdirected request/),
      expect.stringMatching(/^sign-in refused \(403\): Origin not allowed/),
    ]));
    if (lanOk) {
      expect(reasons).toEqual(expect.arrayContaining([
        expect.stringMatching(/^sign-in refused \(403\): Remote access to the control panel is off/),
        expect.stringMatching(/^setup refused \(403\): Setup only works on the host PC/),
      ]));
    }
    expect(rows, JSON.stringify(reasons)).toHaveLength(attempts.length);
  });
});
