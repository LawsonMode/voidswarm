// OWNER: AUTH agent. Exercises the account service through a real http server + fetch.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { sessionTokenHash, type AuthService } from './index';
import {
  hashPassword, LEGACY_P1_SCRYPT_PARAMS, LEGACY_SCRYPT_PARAMS, MAX_CONCURRENT_SCRYPT, needsRehash, paddingParams,
  SCRYPT_MAX_WORKING_SET, SCRYPT_N, SCRYPT_P, SCRYPT_PARAMS, SCRYPT_R, scryptLoad, scryptStats, scryptWork, sha256Hex,
  verifyPassword,
} from './crypto';
import { clientIp, rateLimitKey } from './http';
import type { Mailer, ResetMail } from './mailer';
import { SlidingWindowLimiter, type LimiterSlot } from './ratelimit';
import { createAuthServiceWith, ERR, maskEmail, RESET_TTL_MS, SESSION_TTL_MS, type AuthDeps } from './service';
import { AuthStore, MAX_SESSIONS_PER_ACCOUNT, MIGRATIONS, SCHEMA_VERSION } from './store';

const T0 = 1_780_000_000_000;
const MIN = 60_000;

// Real scrypt at N=2^15, r=8, p=3 on every register/login; a few tests do 20+ of them in a row.
vi.setConfig({ testTimeout: 30_000 });

/** Wait until no scrypt job is running or queued (e.g. a service's startup dummy hash). */
async function scryptIdle(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((scryptLoad().active > 0 || scryptLoad().waiting > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

interface Harness {
  base: string;
  svc: AuthService;
  logs: string[];
  clock: { t: number };
  dir: string;
  dbPath: string;
  server: Server;
  stop(): Promise<void>;
}

const open: Harness[] = [];

async function start(o: {
  env?: AuthDeps['env'];
  corsOrigins?: string[] | '*';
  mailer?: Mailer;
  dir?: string;
  clock?: { t: number };
} = {}): Promise<Harness> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'voidswarm-auth-'));
  const dbPath = join(dir, 'nested', 'auth.db'); // directory must be created by the service
  const logs: string[] = [];
  const clock = o.clock ?? { t: T0 };
  const svc = createAuthServiceWith(
    { dbPath, publicUrl: 'https://void.example.com/', corsOrigins: o.corsOrigins ?? '*', log: (l) => logs.push(l) },
    { now: () => clock.t, env: o.env ?? {}, mailer: o.mailer },
  );
  const server = createServer((req, res) => {
    void svc.handleHttp(req, res).then((handled) => {
      if (!handled) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not api'); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let stopped = false;
  const h: Harness = {
    base: `http://127.0.0.1:${port}`, svc, logs, clock, dir, dbPath, server,
    async stop() {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      svc.close();
    },
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  const dirs = new Set<string>();
  for (const h of open.splice(0)) { await h.stop(); dirs.add(h.dir); }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Res { status: number; body: any; headers: Headers }

async function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(h.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: parsed, headers: r.headers };
}

const PW = 'correct horse battery';
const reg = (h: Harness, username: string, email: string, password = PW, headers?: Record<string, string>) =>
  post(h, '/api/register', { username, email, password }, headers);

/** Minimal plaintext SMTP sink (EHLO/MAIL/RCPT/DATA/QUIT) — enough for nodemailer. */
async function fakeSmtp(): Promise<{ port: number; messages: string[]; rcpts: string[]; close(): Promise<void> }> {
  const messages: string[] = [];
  const rcpts: string[] = [];
  const sockets = new Set<Socket>();
  const srv = createNetServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('utf8');
    sock.write('220 fake ESMTP\r\n');
    let buf = '';
    let inData = false;
    let data = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(data); data = ''; sock.write('250 OK queued\r\n'); }
          else data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'RCPT') { rcpts.push(line.slice(line.indexOf(':') + 1).trim()); sock.write('250 OK\r\n'); }
        else if (cmd === 'MAIL' || cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('502 unsupported\r\n');
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port, messages, rcpts,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  };
}

function lastResetToken(h: Harness): string {
  const line = [...h.logs].reverse().find((l) => l.startsWith('[auth] DEV reset link for '));
  expect(line, 'dev reset link logged').toBeTruthy();
  const url = new URL(line!.split(': ').slice(1).join(': '));
  expect(url.origin + url.pathname).toBe('https://void.example.com/');
  const token = url.searchParams.get('reset');
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return token!;
}

describe('register / me / logout', () => {
  it('registers, resolves the session, and logs out', async () => {
    const h = await start();
    const r = await reg(h, '  Pilot_One ', ' Pilot.One@Example.com ');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.account).toEqual({
      accountId: expect.stringMatching(/^[0-9a-f]{32}$/),
      username: 'Pilot_One',
      emailMasked: 'Pi***@Example.com',
      createdAt: T0,
    });
    const token = r.body.token as string;

    const me = await post(h, '/api/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.account.username).toBe('Pilot_One');
    expect(await h.svc.verifyToken(token)).toEqual(r.body.account);

    expect(h.svc.isRegisteredUsername('pilot_one')).toBe(true);
    expect(h.svc.isRegisteredUsername('PILOT_ONE ')).toBe(true);
    expect(h.svc.isRegisteredUsername('someone_else')).toBe(false);

    const out = await post(h, '/api/logout', { token });
    expect(out).toMatchObject({ status: 200, body: { ok: true } });
    const me2 = await post(h, '/api/me', { token });
    expect(me2.status).toBe(401);
    expect(me2.body.error).toBe(ERR.badSession);
    expect(await h.svc.verifyToken(token)).toBeNull();

    // logout with junk is still ok; me with junk is 401
    expect((await post(h, '/api/logout', { token: 'nope' })).body).toEqual({ ok: true });
    expect((await post(h, '/api/me', {})).status).toBe(401);
    expect(await h.svc.verifyToken('')).toBeNull();
    expect(await h.svc.verifyToken('g'.repeat(64))).toBeNull();
  });

  it('rejects duplicate usernames and emails case-insensitively, with one generic answer (SEC-11)', async () => {
    const h = await start();
    expect((await reg(h, 'Ace', 'ace@example.com')).status).toBe(200);
    const dupName = await reg(h, 'aCE', 'other@example.com');
    expect(dupName).toMatchObject({ status: 409, body: { error: 'Username or email unavailable' } });
    const dupEmail = await reg(h, 'Ace2', 'ACE@Example.COM');
    expect(dupEmail).toMatchObject({ status: 409, body: { error: 'Username or email unavailable' } });
    // Byte-identical bodies: the response never says which of the two is registered.
    expect(dupEmail.body).toEqual(dupName.body);
    expect(JSON.stringify(dupEmail.body)).not.toMatch(/email already|registered|taken/i);
    // Nothing was created by the rejected attempts.
    expect(h.svc.isRegisteredUsername('Ace2')).toBe(false);
    expect((await post(h, '/api/login', { login: 'other@example.com', password: PW })).status).toBe(401);
  });

  it('validates username, email and password', async () => {
    const h = await start();
    const bad = async (u: unknown, e: unknown, p: unknown, err: string) => {
      const r = await post(h, '/api/register', { username: u, email: e, password: p });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(err);
    };
    await bad('ab', 'a@b.co', PW, ERR.badUsername);
    await bad('x'.repeat(17), 'a@b.co', PW, ERR.badUsername);
    await bad('bad name', 'a@b.co', PW, ERR.badUsername);
    await bad(42, 'a@b.co', PW, ERR.badUsername);
    await bad('okname', 'not-an-email', PW, ERR.badEmail);
    await bad('okname', 'a@b', PW, ERR.badEmail);
    await bad('okname', `${'x'.repeat(250)}@b.co`, PW, ERR.badEmail);
    await bad('okname', 'a@b.co', 'short', ERR.shortPassword);
    await bad('okname', 'a@b.co', 'p'.repeat(201), ERR.longPassword);
    await bad('okname', 'a@b.co', undefined, ERR.shortPassword);
    expect((await reg(h, 'okname', 'a@b.co', 'p'.repeat(200))).status).toBe(200);
  });

  it('keeps usernames and sessions across a restart', async () => {
    const h = await start();
    const r = await reg(h, 'Persist', 'persist@example.com');
    await h.stop();
    const h2 = await start({ dir: h.dir, clock: h.clock });
    expect(h2.svc.isRegisteredUsername('persist')).toBe(true);
    expect((await post(h2, '/api/me', { token: r.body.token })).status).toBe(200);
  });
});

describe('login', () => {
  it('logs in by username or email (any case); wrong password is generic', async () => {
    const h = await start();
    const r = await reg(h, 'Maverick', 'mav@example.com');
    const byName = await post(h, '/api/login', { login: ' maverick ', password: PW });
    expect(byName.status).toBe(200);
    expect(byName.body.account.accountId).toBe(r.body.account.accountId);
    expect(byName.body.token).not.toBe(r.body.token);
    const byEmail = await post(h, '/api/login', { login: 'MAV@EXAMPLE.COM', password: PW });
    expect(byEmail.status).toBe(200);
    expect((await post(h, '/api/me', { token: byEmail.body.token })).status).toBe(200);

    const wrong = await post(h, '/api/login', { login: 'Maverick', password: 'wrong password!' });
    const unknown = await post(h, '/api/login', { login: 'Goose', password: PW });
    const unknownEmail = await post(h, '/api/login', { login: 'goose@example.com', password: PW });
    for (const x of [wrong, unknown, unknownEmail]) {
      expect(x.status).toBe(401);
      expect(x.body).toEqual({ error: 'Invalid username/email or password' });
    }
    const malformed = await post(h, '/api/login', { login: 5 });
    expect(malformed.status).toBe(400);
  });

  it('expires sessions after 30 days, with sliding refresh on use', async () => {
    const h = await start();
    const { body } = await reg(h, 'Slider', 'slider@example.com');
    const token = body.token as string;
    h.clock.t += 20 * 24 * 60 * MIN;
    expect(await h.svc.verifyToken(token)).not.toBeNull(); // refreshes to +30d from here
    h.clock.t += 20 * 24 * 60 * MIN;                       // 40 days after creation
    expect((await post(h, '/api/me', { token })).status).toBe(200);
    h.clock.t += SESSION_TTL_MS + 1;                       // idle > 30 days
    expect((await post(h, '/api/me', { token })).status).toBe(401);
    expect(await h.svc.verifyToken(token)).toBeNull();
  });
});

describe('rate limiting', () => {
  const proxied = { TRUST_PROXY: '1' };
  const from = (ip: string) => ({ 'X-Forwarded-For': `6.6.6.6, ${ip}` });

  it('locks a (IP, login) pair after 5 failures, then unlocks after the window', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Target', 'target@example.com', PW, from('10.0.0.1'));
    for (let i = 0; i < 5; i++) {
      expect((await post(h, '/api/login', { login: 'target', password: 'nope-nope' }, from('10.0.0.2'))).status).toBe(401);
    }
    const locked = await post(h, '/api/login', { login: 'TARGET', password: PW }, from('10.0.0.2'));
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: 'Too many attempts — try again later' });
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another IP (last XFF hop) is unaffected; the spoofable first hop is ignored.
    expect((await post(h, '/api/login', { login: 'target', password: PW }, from('10.0.0.3'))).status).toBe(200);
    h.clock.t += 10 * MIN + 1;
    expect((await post(h, '/api/login', { login: 'target', password: PW }, from('10.0.0.2'))).status).toBe(200);
  });

  it('caps login attempts per IP at 10 per 10 minutes', async () => {
    const h = await start({ env: proxied });
    for (let i = 0; i < 10; i++) {
      expect((await post(h, '/api/login', { login: `ghost${i}`, password: 'whatever1' }, from('10.1.0.1'))).status).toBe(401);
    }
    expect((await post(h, '/api/login', { login: 'ghost99', password: 'whatever1' }, from('10.1.0.1'))).status).toBe(429);
    expect((await post(h, '/api/login', { login: 'ghost99', password: 'whatever1' }, from('10.1.0.9'))).status).toBe(401);
  });

  it('caps registration at 5 per hour per IP', async () => {
    const h = await start({ env: proxied });
    for (let i = 0; i < 5; i++) {
      expect((await reg(h, `reg${i}`, `reg${i}@example.com`, PW, from('10.2.0.1'))).status).toBe(200);
    }
    const r = await reg(h, 'reg5', 'reg5@example.com', PW, from('10.2.0.1'));
    expect(r.status).toBe(429);
    h.clock.t += 60 * MIN + 1;
    expect((await reg(h, 'reg5', 'reg5@example.com', PW, from('10.2.0.1'))).status).toBe(200);
  });

  it('caps forgot at 3 per hour per email and 5 per hour per IP', async () => {
    const h = await start({ env: proxied });
    for (let i = 0; i < 3; i++) {
      expect((await post(h, '/api/forgot', { email: 'who@example.com' }, from(`10.3.0.${i}`))).status).toBe(200);
    }
    expect((await post(h, '/api/forgot', { email: 'WHO@example.com' }, from('10.3.0.9'))).status).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await post(h, '/api/forgot', { email: `n${i}@example.com` }, from('10.4.0.1'))).status).toBe(200);
    }
    expect((await post(h, '/api/forgot', { email: 'n9@example.com' }, from('10.4.0.1'))).status).toBe(429);
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY=1', async () => {
    const h = await start({ env: {} });
    for (let i = 0; i < 10; i++) {
      await post(h, '/api/login', { login: `g${i}`, password: 'whatever1' }, { 'X-Forwarded-For': `1.2.3.${i}` });
    }
    const r = await post(h, '/api/login', { login: 'g', password: 'whatever1' }, { 'X-Forwarded-For': '9.9.9.9' });
    expect(r.status).toBe(429);
  });
});

describe('forgot / reset', () => {
  it('always says ok and sends nothing for an unknown email', async () => {
    const sent: ResetMail[] = [];
    const h = await start({ mailer: { smtp: true, async sendReset(m) { sent.push(m); } } });
    const r = await post(h, '/api/forgot', { email: 'nobody@example.com' });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(sent).toHaveLength(0);
    expect((await post(h, '/api/forgot', { email: 'garbage' })).status).toBe(400);

    await reg(h, 'Known', 'known@example.com');
    expect((await post(h, '/api/forgot', { email: 'KNOWN@example.com' })).body).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('known@example.com');
    expect(sent[0]!.username).toBe('Known');
    expect(sent[0]!.url).toMatch(/^https:\/\/void\.example\.com\/\?reset=[0-9a-f]{64}$/);
    // With a real mailer configured, the token never reaches the log.
    const token = new URL(sent[0]!.url).searchParams.get('reset')!;
    expect(h.logs.join('\n')).not.toContain(token);
  });

  it('dev link → reset revokes old sessions, returns a working one, and is single use', async () => {
    const h = await start();
    const r = await reg(h, 'Iceman', 'ice@example.com');
    const other = await post(h, '/api/login', { login: 'iceman', password: PW });
    expect(h.logs.some((l) => l.includes('DEV reset link'))).toBe(false);

    expect((await post(h, '/api/forgot', { email: 'ice@example.com' })).body).toEqual({ ok: true });
    const resetToken = lastResetToken(h);
    expect(h.logs.find((l) => l.includes('DEV reset link'))).toContain('for Iceman:');

    const NEW = 'brand new password';
    const done = await post(h, '/api/reset', { resetToken, password: NEW });
    expect(done.status).toBe(200);
    expect(done.body.account.username).toBe('Iceman');
    expect(done.body.token).toMatch(/^[0-9a-f]{64}$/);

    expect((await post(h, '/api/me', { token: r.body.token })).status).toBe(401);
    expect((await post(h, '/api/me', { token: other.body.token })).status).toBe(401);
    expect((await post(h, '/api/me', { token: done.body.token })).status).toBe(200);

    expect((await post(h, '/api/login', { login: 'iceman', password: PW })).status).toBe(401);
    expect((await post(h, '/api/login', { login: 'iceman', password: NEW })).status).toBe(200);

    const again = await post(h, '/api/reset', { resetToken, password: 'yet another one' });
    expect(again).toMatchObject({ status: 400, body: { error: ERR.badReset } });
  });

  it('expires reset tokens after 30 minutes and invalidates older ones on reissue', async () => {
    const h = await start();
    await reg(h, 'Viper', 'viper@example.com');
    await post(h, '/api/forgot', { email: 'viper@example.com' });
    const first = lastResetToken(h);
    await post(h, '/api/forgot', { email: 'viper@example.com' });
    const second = lastResetToken(h);
    expect(second).not.toBe(first);
    expect((await post(h, '/api/reset', { resetToken: first, password: 'new password 1' })).status).toBe(400);

    h.clock.t += RESET_TTL_MS + 1;
    expect((await post(h, '/api/reset', { resetToken: second, password: 'new password 2' })).status).toBe(400);

    await post(h, '/api/forgot', { email: 'viper@example.com' });
    const third = lastResetToken(h);
    h.clock.t += RESET_TTL_MS - 1000;
    const bad = await post(h, '/api/reset', { resetToken: third, password: 'short' });
    expect(bad).toMatchObject({ status: 400, body: { error: ERR.shortPassword } });
    expect((await post(h, '/api/reset', { resetToken: third, password: 'new password 3' })).status).toBe(200);
    expect((await post(h, '/api/reset', { resetToken: 'z', password: 'new password 4' })).status).toBe(400);
  });

  it('sends the reset link over SMTP (nodemailer) when SMTP_HOST is set', async () => {
    const smtp = await fakeSmtp();
    try {
      const h = await start({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), MAIL_FROM: 'Voidswarm <noreply@void.example.com>' } });
      await reg(h, 'Merlin', 'merlin@example.com');
      expect((await post(h, '/api/forgot', { email: 'merlin@example.com' })).body).toEqual({ ok: true });
      const deadline = Date.now() + 5000;
      while (smtp.messages.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(smtp.messages).toHaveLength(1);
      const msg = smtp.messages[0]!;
      expect(smtp.rcpts).toContain('<merlin@example.com>');
      expect(msg).toContain('Subject: Reset your Voidswarm password');
      expect(msg).toContain('multipart/alternative');
      const decoded = msg.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x: string) => String.fromCharCode(parseInt(x, 16)));
      const m = decoded.match(/https:\/\/void\.example\.com\/\?reset=([0-9a-f]{64})/);
      expect(m).toBeTruthy();
      expect(decoded).toContain('expires in 30 minutes');
      // SMTP configured → no dev link and no token anywhere in the log.
      expect(h.logs.some((l) => l.includes('DEV reset link'))).toBe(false);
      expect(h.logs.join('\n')).not.toContain(m![1]!);
      // …and the emailed token actually works.
      expect((await post(h, '/api/reset', { resetToken: m![1], password: 'wizard password' })).status).toBe(200);
    } finally {
      await smtp.close();
    }
  });

  it('logs mail failures without the token and never surfaces them', async () => {
    const h = await start({ mailer: { smtp: true, sendReset: () => Promise.reject(Object.assign(new Error('boom'), { code: 'EAUTH' })) } });
    await reg(h, 'Jester', 'jester@example.com');
    const r = await post(h, '/api/forgot', { email: 'jester@example.com' });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    await new Promise((res) => setTimeout(res, 10));
    const fail = h.logs.find((l) => l.includes('reset mail'));
    expect(fail).toContain('EAUTH');
    expect(fail).toContain('je***@example.com');
    expect(fail).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('HTTP handling', () => {
  it('answers CORS preflight for allowed origins only', async () => {
    const h = await start({ corsOrigins: ['https://game.example.com'] });
    const ok = await fetch(`${h.base}/api/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://game.example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://game.example.com');
    expect(ok.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(ok.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(ok.headers.get('vary')).toContain('Origin');

    const evil = await fetch(`${h.base}/api/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const evilPost = await post(h, '/api/forgot', { email: 'a@b.co' }, { Origin: 'https://evil.example.com' });
    expect(evilPost.status).toBe(403);

    const goodPost = await post(h, '/api/forgot', { email: 'a@b.co' }, { Origin: 'https://game.example.com' });
    expect(goodPost.status).toBe(200);
    expect(goodPost.headers.get('access-control-allow-origin')).toBe('https://game.example.com');
    // same-origin (client served by this server) is always allowed
    const same = await post(h, '/api/forgot', { email: 'b@b.co' }, { Origin: h.base });
    expect(same.status).toBe(200);
  });

  it("echoes any origin in '*' mode", async () => {
    const h = await start({ corsOrigins: '*' });
    const r = await fetch(`${h.base}/api/me`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('enforces method, content type, JSON, size and routing', async () => {
    const h = await start();
    const get = await fetch(`${h.base}/api/me`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    expect((await post(h, '/api/nope', {})).status).toBe(404);
    expect((await post(h, '/api/me', '{not json')).status).toBe(400);
    expect((await post(h, '/api/me', '[1,2]')).status).toBe(400);
    expect((await post(h, '/api/me', {}, { 'Content-Type': 'text/plain' })).status).toBe(415);

    const big = await post(h, '/api/register', { username: 'bigbody', email: 'big@example.com', password: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('Request body too large');

    const notApi = await fetch(`${h.base}/index.html`);
    expect(notApi.status).toBe(404);
    expect(await notApi.text()).toBe('not api'); // handleHttp returned false → fell through
    expect((await fetch(`${h.base}/apix`)).status).toBe(404);
  });
});

describe('storage', () => {
  it('stores scrypt hashes and token hashes only — never plaintext', async () => {
    const h = await start();
    const SECRET = 'plaintext-Secret-9431';
    const r = await reg(h, 'Hollywood', 'holly@example.com', SECRET);
    const sessionToken = r.body.token as string;
    await post(h, '/api/forgot', { email: 'holly@example.com' });
    const resetToken = lastResetToken(h);
    await h.stop();

    const db = new DatabaseSync(h.dbPath);
    const acct = db.prepare('SELECT * FROM accounts').get() as Record<string, unknown>;
    expect(acct.username_lower).toBe('hollywood');
    expect(acct.profile_json).toBeNull();
    const hash = String(acct.pass_hash);
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    expect(await verifyPassword(SECRET, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    const sess = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(sess.map((s) => s.token_hash)).toEqual([sha256Hex(sessionToken)]);
    const resets = db.prepare('SELECT token_hash FROM resets').all() as { token_hash: string }[];
    expect(resets.map((s) => s.token_hash)).toEqual([sha256Hex(resetToken)]);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    db.close();

    const dbDir = join(h.dir, 'nested');
    const files = readdirSync(dbDir).map((f) => join(dbDir, f)).filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = readFileSync(f).toString('latin1');
      expect(bytes).not.toContain(SECRET);
      expect(bytes).not.toContain(sessionToken);
      expect(bytes).not.toContain(resetToken);
    }
  });

  /** A DB exactly as v0.2 left it: MIGRATIONS[0] only, one account with a live session. */
  async function v1Db(dir: string): Promise<{ dbPath: string; token: string }> {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const dbPath = join(dir, 'nested', 'auth.db');
    const token = '0123456789abcdef'.repeat(4); // TOKEN_RE shape: 64 hex chars
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(MIGRATIONS[0]!);
      db.exec('PRAGMA user_version = 1');
      db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, last_login)
                  VALUES ('veteran-id', 'Veteran', 'veteran', 'vet@example.com', 'vet@example.com', ?, ?, NULL)`)
        .run(await hashPassword(PW), T0 - 1000);
      db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sha256Hex(token), 'veteran-id', T0 - 1000, T0 + SESSION_TTL_MS);
    } finally {
      db.close();
    }
    return { dbPath, token };
  }

  it('migrates an existing v1 (v0.2) DB to the current schema: loot tables added, accounts + sessions intact, profile_json NULL', async () => {
    expect(SCHEMA_VERSION).toBe(4); // v2 = loot tables (v0.3 M2), v3 = moderation tables, v4 = LAN edition (§6.6)
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-auth-'));
    const { dbPath, token } = await v1Db(dir);
    const h = await start({ dir });
    expect(h.dbPath).toBe(dbPath);

    // The v0.2 session and password still work after the migration.
    expect(await h.svc.verifyToken(token)).toMatchObject({ accountId: 'veteran-id', username: 'Veteran' });
    expect((await post(h, '/api/login', { login: 'veteran', password: PW })).status).toBe(200);
    expect((await reg(h, 'Rookie', 'rookie@example.com')).status).toBe(200);
    await h.stop();

    const db = new DatabaseSync(dbPath);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      const accts = db.prepare('SELECT username, profile_json, profile_rev FROM accounts ORDER BY username').all();
      expect(accts).toEqual([
        { username: 'Rookie', profile_json: null, profile_rev: 0 },
        { username: 'Veteran', profile_json: null, profile_rev: 0 },
      ]);
      const cols = (db.prepare("SELECT name FROM pragma_table_info('loot_ledger') ORDER BY cid").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(['account_id', 'grant_key', 'created_at', 'grant_json']);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'loot_ledger_time'").get()).toBeTruthy();
      expect(db.prepare('SELECT COUNT(*) AS n FROM loot_ledger').get()).toEqual({ n: 0 });
      // ON DELETE CASCADE from accounts → loot_ledger.
      db.exec('PRAGMA foreign_keys = ON');
      db.prepare("INSERT INTO loot_ledger VALUES ('veteran-id', 'm#veteran-id#0', ?, '{}')").run(T0);
      db.prepare("DELETE FROM accounts WHERE id = 'veteran-id'").run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM loot_ledger').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a migration that fails part-way is rolled back whole (user_version and columns unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-auth-'));
    try {
      const { dbPath } = await v1Db(dir);
      const db0 = new DatabaseSync(dbPath);
      db0.exec('CREATE TABLE loot_ledger (x INTEGER)'); // collides with MIGRATIONS[1]'s CREATE TABLE
      db0.close();
      expect(() => new AuthStore(dbPath)).toThrow(/loot_ledger/);
      const db = new DatabaseSync(dbPath);
      try {
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
        const cols = (db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as { name: string }[]).map((c) => c.name);
        expect(cols).not.toContain('profile_rev'); // the ALTER TABLE before the failure was rolled back
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a DB whose schema is newer than this server (never downgrades it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-auth-'));
    try {
      const dbPath = join(dir, 'auth.db');
      new AuthStore(dbPath).close();
      const db0 = new DatabaseSync(dbPath);
      db0.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      db0.close();
      expect(() => new AuthStore(dbPath)).toThrow(/newer than this server/);
      const db = new DatabaseSync(dbPath);
      try {
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('units', () => {
  it('masks emails', () => {
    expect(maskEmail('chad@gmail.com')).toBe('ch***@gmail.com');
    expect(maskEmail('ab@x.io')).toBe('a***@x.io');
    expect(maskEmail('a@x.io')).toBe('a***@x.io');
  });

  it('sliding window limiter', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect(l.take('k')).toBe(0);
    t = 500;
    expect(l.take('k')).toBe(0);
    expect(l.take('k')).toBe(500);
    t = 1001;
    expect(l.take('k')).toBe(0);
    t = 5000;
    l.sweep();
    expect(l.size).toBe(0);
  });

  it('limiter evicts the least recently recorded key past maxKeys (SEC-6)', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t, 3);
    l.record('a'); l.record('b'); l.record('c');
    l.record('a');                 // a is now the most recently recorded
    l.record('d');                 // over the cap → b (least recent) goes, a keeps both hits
    expect(l.size).toBe(3);
    expect(l.blockedFor('a')).toBeGreaterThan(0);
    expect(l.blockedFor('b')).toBe(0);
    expect(l.blockedFor('c')).toBe(0);
    expect(l.take('c')).toBe(0);   // c: 2 hits now, most recent → order a, d, c
    l.record('e');                 // evicts a, the least recently recorded (blocked or not)
    expect(l.size).toBe(3);
    expect(l.blockedFor('a')).toBe(0);
    expect(l.take('c')).toBeGreaterThan(0); // c kept its 2 hits
    // blockedFor/take on a blocked key don't record, so they don't refresh its position.
    l.record('f');                 // evicts d
    expect(l.take('c')).toBeGreaterThan(0);
    expect(l.blockedFor('e')).toBe(0);
    l.record('g');                 // evicts c
    expect(l.blockedFor('c')).toBe(0);
  });

  it('limiter reserve(): held slots count at once; commit records, release gives back, reset keeps others (SEC-6)', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(3, 1000, () => t);
    const slot = (x: LimiterSlot | number): LimiterSlot => {
      if (typeof x === 'number') throw new Error(`blocked for ${x} ms`);
      return x;
    };
    const a = slot(l.reserve('k'));
    const b = slot(l.reserve('k'));
    const c = slot(l.reserve('k'));
    expect(l.heldSlots).toBe(3);
    expect(l.reserve('k')).toBe(1000);  // held slots count as hits made now: blocked without any record
    expect(l.take('k')).toBe(1000);     // take() respects them too
    expect(l.blockedFor('other')).toBe(0);
    a.release();
    a.commit();                         // settling twice is a no-op
    expect(l.heldSlots).toBe(2);
    t = 100;
    b.commit();                         // a hit at t=100; c still held
    const d = slot(l.reserve('k'));     // 1 hit + 2 held = 3
    t = 400;
    expect(l.reserve('k')).toBe(700);   // the t=100 hit is the one that has to age out
    l.reset('k');                       // clears the hit, not the slots c and d hold
    expect(l.heldSlots).toBe(2);
    const e = slot(l.reserve('k'));
    expect(l.reserve('k')).toBe(1000);
    c.commit(); d.release(); e.release();
    expect(l.heldSlots).toBe(0);
    expect(l.blockedFor('k')).toBe(0);  // 1 hit left (c)
    t = 1401;
    l.sweep();
    expect(l.size).toBe(0);
  });

  it('limiter stays O(1) per hit when flooded with distinct keys (no full sweep per record)', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(10, 10 * MIN, () => t); // default 50k-key cap
    const started = performance.now();
    for (let i = 0; i < 80_000; i++) { t++; l.record(`k${i}`); }
    expect(performance.now() - started).toBeLessThan(2000); // the old sweep-per-hit took ~30k × 50k steps
    expect(l.size).toBe(50_000);
    expect(l.blockedFor('k79999')).toBe(0);
  });
});

describe('rate-limit keys (SEC-6)', () => {
  it('groups IPv6 by /64 and unwraps IPv4-mapped, ported and bracketed forms', () => {
    const k64 = '2001:db8:1:2::/64';
    expect(rateLimitKey('2001:db8:1:2:3:4:5:6')).toBe(k64);
    expect(rateLimitKey('2001:0DB8:0001:0002:ffff::1')).toBe(k64);
    expect(rateLimitKey('[2001:db8:1:2::abcd]:443')).toBe(k64);
    expect(rateLimitKey('[2001:db8:1:2::abcd]')).toBe(k64);
    expect(rateLimitKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(rateLimitKey('::FFFF:0102:0304')).toBe('1.2.3.4');
    expect(rateLimitKey('1.2.3.4')).toBe('1.2.3.4');
    expect(rateLimitKey(' 1.2.3.4:5678 ')).toBe('1.2.3.4');
    expect(rateLimitKey('unknown')).toBe('unknown');
    expect(rateLimitKey('x'.repeat(500))).toHaveLength(64);
  });

  it('clientIp applies it to the socket address and to the trusted XFF hop', () => {
    const req = (remoteAddress: string, xff?: string) =>
      ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress } }) as unknown as IncomingMessage;
    expect(clientIp(req('2001:db8:aa:bb::7'), false)).toBe('2001:db8:aa:bb::/64');
    expect(clientIp(req('::ffff:10.0.0.5'), false)).toBe('10.0.0.5');
    expect(clientIp(req('127.0.0.1', '9.9.9.9, 2001:db8:cc:dd:1::2'), true)).toBe('2001:db8:cc:dd::/64');
    expect(clientIp(req('127.0.0.1', '2001:db8:cc:dd:1::2'), false)).toBe('127.0.0.1');
  });

  it('rotating source addresses inside one IPv6 /64 does not escape the per-IP login cap', async () => {
    const h = await start({ env: { TRUST_PROXY: '1' } });
    for (let i = 0; i < 10; i++) {
      const r = await post(h, '/api/login', { login: `rot${i}`, password: 'whatever1' }, { 'X-Forwarded-For': `2001:db8:5:6::${(i + 1).toString(16)}` });
      expect(r.status).toBe(401);
    }
    const blocked = await post(h, '/api/login', { login: 'rot99', password: 'whatever1' }, { 'X-Forwarded-For': '2001:db8:5:6:dead:beef:0:1' });
    expect(blocked.status).toBe(429);
    // A different /64 is a different subscriber.
    expect((await post(h, '/api/login', { login: 'rot99', password: 'whatever1' }, { 'X-Forwarded-For': '2001:db8:5:7::1' })).status).toBe(401);
  });
});

describe('per-account login lock (SEC-6)', () => {
  const proxied = { TRUST_PROXY: '1' };
  /** A different IPv6 /64 per n, i.e. a fresh "subscriber" every time. */
  const net = (n: number) => ({ 'X-Forwarded-For': `2001:db8:${n.toString(16)}::1` });
  const failTenTimes = async (h: Harness, login: string | ((i: number) => string), base: number) => {
    for (let i = 0; i < 10; i++) {
      const l = typeof login === 'string' ? login : login(i);
      expect((await post(h, '/api/login', { login: l, password: `wrong guess ${i}` }, net(base + i))).status).toBe(401);
    }
  };

  it('locks an account after 10 failures spread over many addresses, with the generic 429', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Rotated', 'rotated@example.com', PW, net(0xfff));
    await reg(h, 'Bystander', 'bystander@example.com', PW, net(0xfff));
    // Username and email (any case) count against the same account.
    await failTenTimes(h, (i) => (i % 2 ? 'Rotated@Example.com' : 'ROTATED'), 1);
    const locked = await post(h, '/api/login', { login: 'rotated', password: PW }, net(100));
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: ERR.rateLimited });
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post(h, '/api/login', { login: 'rotated@example.com', password: PW }, net(101))).status).toBe(429);
    // Other accounts are unaffected.
    expect((await post(h, '/api/login', { login: 'bystander', password: PW }, net(102))).status).toBe(200);
    // Temporary: it lifts once the failures age out of the 15-minute window.
    h.clock.t += 15 * MIN + 1;
    expect((await post(h, '/api/login', { login: 'rotated', password: PW }, net(103))).status).toBe(200);
  });

  it('locks unknown logins identically, so the lock does not reveal which accounts exist', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Known1', 'known1@example.com', PW, net(0xfff));
    await failTenTimes(h, 'known1', 1);
    await failTenTimes(h, 'nobody1', 21);
    const known = await post(h, '/api/login', { login: 'known1', password: 'another guess' }, net(50));
    const unknown = await post(h, '/api/login', { login: 'nobody1', password: 'another guess' }, net(51));
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.headers.get('retry-after')).toBe(known.headers.get('retry-after'));
  });

  /** 50 wrong-password logins in parallel, each from its own /64. Returns the replies and the scrypt verifies they ran. */
  const burst = async (h: Harness, login: string, base: number, n = 50) => {
    await scryptIdle();
    const before = scryptStats().verifies;
    const res = await Promise.all(Array.from({ length: n }, (_, i) =>
      post(h, '/api/login', { login, password: `parallel guess ${i}` }, net(base + i))));
    const tally: Record<number, number> = {};
    for (const r of res) tally[r.status] = (tally[r.status] ?? 0) + 1;
    return { res, tally, verifies: scryptStats().verifies - before };
  };

  it('50 concurrent wrong logins from 50 addresses: at most the cap are evaluated, the rest get the generic 429', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Swarmed', 'swarmed@example.com', PW, net(0xfff));
    const known = await burst(h, 'swarmed', 1);
    // Check-and-reserve is atomic: exactly the cap (10) pass, every later one is refused before scrypt.
    expect(known.verifies).toBeLessThanOrEqual(10);
    expect(known.verifies).toBe(10);
    expect(known.tally).toEqual({ 401: 10, 429: 40 });
    for (const r of known.res) {
      if (r.status === 401) expect(r.body).toEqual({ error: ERR.badLogin });
      else {
        expect(r.body).toEqual({ error: ERR.rateLimited }); // the IP limiter's 429, byte for byte
        expect(r.headers.get('retry-after')).toBe('900');
      }
    }
    // Locked now, even with the right password (a lock never confirms a guess).
    expect((await post(h, '/api/login', { login: 'SWARMED@example.com', password: PW }, net(200))).status).toBe(429);

    // An unknown login under the same burst behaves identically: same tally, same bodies, same Retry-After.
    const unknown = await burst(h, 'nobody-here', 301);
    expect(unknown.verifies).toBe(10);
    expect(unknown.tally).toEqual(known.tally);
    expect(new Set(unknown.res.map((r) => JSON.stringify([r.status, r.body, r.headers.get('retry-after')]))))
      .toEqual(new Set(known.res.map((r) => JSON.stringify([r.status, r.body, r.headers.get('retry-after')]))));

    // Every reserved slot was settled (none leaked): after the window, 9 failures + the right password
    // still fits under the cap of 10.
    h.clock.t += 15 * MIN + 1;
    expect((await burst(h, 'swarmed', 401, 9)).tally).toEqual({ 401: 9 });
    expect((await post(h, '/api/login', { login: 'swarmed', password: PW }, net(500))).status).toBe(200);
  });

  it('a concurrent burst from ONE address is held to the per-(address, login) cap of 5', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Single', 'single@example.com', PW, net(0xfff));
    await scryptIdle();
    const before = scryptStats().verifies;
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      post(h, '/api/login', { login: 'single', password: `one-address guess ${i}` }, net(7))));
    expect(scryptStats().verifies - before).toBe(5);
    expect(res.filter((r) => r.status === 401)).toHaveLength(5);
    expect(res.filter((r) => r.status === 429 && r.body.error === ERR.rateLimited)).toHaveLength(5);
  });

  it('a success hands its slot back and forgives earlier failures (never counted as one)', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Forgiven', 'forgiven@example.com', PW, net(0xfff));
    expect((await burst(h, 'forgiven', 1, 9)).tally).toEqual({ 401: 9 }); // 9 of 10 used
    expect((await post(h, '/api/login', { login: 'forgiven', password: PW }, net(100))).status).toBe(200);
    // The full cap is available again: had the success been counted (or its slot leaked), fewer would pass.
    const after = await burst(h, 'forgiven', 101);
    expect(after.verifies).toBe(10);
    expect(after.tally).toEqual({ 401: 10, 429: 40 });
  });

  it('a successful password reset lifts the lock', async () => {
    const h = await start({ env: proxied });
    await reg(h, 'Lockedout', 'lockedout@example.com', PW, net(0xfff));
    await failTenTimes(h, 'lockedout', 1);
    expect((await post(h, '/api/login', { login: 'lockedout', password: PW }, net(40))).status).toBe(429);
    await post(h, '/api/forgot', { email: 'lockedout@example.com' }, net(41));
    const NEW = 'fresh password here';
    expect((await post(h, '/api/reset', { resetToken: lastResetToken(h), password: NEW }, net(41))).status).toBe(200);
    expect((await post(h, '/api/login', { login: 'lockedout', password: NEW }, net(42))).status).toBe(200);
  });
});

describe('session revocation events (SEC-10)', () => {
  type Ev = [accountId: string, sessionTokenHash: string | null];

  it('logout reports (accountId, sha256 of that token); unknown or repeated logouts report nothing', async () => {
    const h = await start();
    const events: Ev[] = [];
    h.svc.onSessionsRevoked((a, s) => events.push([a, s]));
    const r = await reg(h, 'Revoker', 'revoker@example.com');
    const other = await post(h, '/api/login', { login: 'revoker', password: PW });
    expect(events).toEqual([]);

    await post(h, '/api/logout', { token: r.body.token });
    expect(events).toEqual([[r.body.account.accountId, sha256Hex(r.body.token)]]);
    expect(events[0]![1]).toBe(sessionTokenHash(r.body.token)); // the helper the ws server uses

    await post(h, '/api/logout', { token: r.body.token }); // already gone
    await post(h, '/api/logout', { token: 'f'.repeat(64) });
    await post(h, '/api/logout', { token: 'junk' });
    expect(events).toHaveLength(1);
    expect(await h.svc.verifyToken(other.body.token)).not.toBeNull(); // only that one session
  });

  it('password reset reports (accountId, null), fired after the old sessions are already gone', async () => {
    const h = await start();
    const r = await reg(h, 'Resetter', 'resetter@example.com');
    const events: Ev[] = [];
    const checks: Promise<unknown>[] = [];
    h.svc.onSessionsRevoked((a, s) => {
      events.push([a, s]);
      checks.push(h.svc.verifyToken(r.body.token)); // resolved synchronously against the DB
    });
    await post(h, '/api/forgot', { email: 'resetter@example.com' });
    const done = await post(h, '/api/reset', { resetToken: lastResetToken(h), password: 'a new password' });
    expect(done.status).toBe(200);
    expect(events).toEqual([[r.body.account.accountId, null]]);
    expect(await Promise.all(checks)).toEqual([null]);
    expect(await h.svc.verifyToken(done.body.token)).not.toBeNull();
  });

  it('a throwing listener is logged and neither breaks the request nor starves other listeners', async () => {
    const h = await start();
    const events: Ev[] = [];
    h.svc.onSessionsRevoked(() => { throw new Error('kick failed'); });
    h.svc.onSessionsRevoked((a, s) => events.push([a, s]));
    const r = await reg(h, 'Sturdy', 'sturdy@example.com');
    expect(await post(h, '/api/logout', { token: r.body.token })).toMatchObject({ status: 200, body: { ok: true } });
    expect(events).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('sessions-revoked listener failed: kick failed'))).toBe(true);
    expect(h.logs.join('\n')).not.toContain(r.body.token);
  });

  it('reports the oldest session when the per-account cap drops it', async () => {
    const h = await start({ env: { TRUST_PROXY: '1' } });
    const events: Ev[] = [];
    h.svc.onSessionsRevoked((a, s) => events.push([a, s]));
    const first = await reg(h, 'Collector', 'collector@example.com');
    for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT - 1; i++) {
      h.clock.t += 1;
      expect((await post(h, '/api/login', { login: 'collector', password: PW }, { 'X-Forwarded-For': `10.9.${i}.1` })).status).toBe(200);
    }
    expect(events).toEqual([]); // exactly at the cap
    h.clock.t += 1;
    await post(h, '/api/login', { login: 'collector', password: PW }, { 'X-Forwarded-For': '10.9.99.1' });
    expect(events).toEqual([[first.body.account.accountId, sha256Hex(first.body.token)]]);
    expect(await h.svc.verifyToken(first.body.token)).toBeNull();
  });

  it('createSession returns the hashes it trimmed (surplus and expired)', () => {
    const store = new AuthStore(':memory:');
    try {
      store.insertAccount({
        id: 'acc1', username: 'U', username_lower: 'u', email: 'u@x.io', email_lower: 'u@x.io',
        pass_hash: 'x', created_at: T0, last_login: null,
      });
      expect(store.createSession('expired', 'acc1', T0, T0 + 50)).toEqual([]);
      for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT - 1; i++) {
        expect(store.createSession(`s${i}`, 'acc1', T0 + 1 + i, T0 + 1e9)).toEqual([]);
      }
      // At T0+100 the first session has expired and is reported; the rest are within the cap.
      expect(store.createSession('late', 'acc1', T0 + 100, T0 + 1e9)).toEqual(['expired']);
      expect(store.createSession('later', 'acc1', T0 + 101, T0 + 1e9)).toEqual(['s0']);
      expect(store.deleteSession('later')).toBe('acc1');
      expect(store.deleteSession('later')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('password hashing params (SEC-12)', () => {
  it('caps concurrent scrypt jobs', async () => {
    await scryptIdle(); // let hashes started by earlier tests' services drain
    const jobs = Array.from({ length: 5 }, (_, i) => hashPassword(`concurrent-${i}`));
    expect(scryptLoad()).toEqual({ active: MAX_CONCURRENT_SCRYPT, waiting: 5 - MAX_CONCURRENT_SCRYPT });
    const hashes = await Promise.all(jobs);
    expect(scryptLoad()).toEqual({ active: 0, waiting: 0 });
    for (const [i, hsh] of hashes.entries()) expect(await verifyPassword(`concurrent-${i}`, hsh)).toBe(true);
  });

  it("current params are OWASP's N=2^15, r=8, p=3: N=2^17-class CPU cost at 32 MiB", async () => {
    expect([SCRYPT_N, SCRYPT_R, SCRYPT_P]).toEqual([1 << 15, 8, 3]);
    expect(128 * SCRYPT_N * SCRYPT_R).toBe(32 * 1024 * 1024); // memory per hash: the lanes share one buffer
    expect(scryptWork(SCRYPT_PARAMS)).toBe(3 * scryptWork(LEGACY_P1_SCRYPT_PARAMS));
    expect(scryptWork(SCRYPT_PARAMS) / scryptWork({ N: 1 << 17, r: 8, p: 1 })).toBeCloseTo(0.75); // same ballpark as N=2^17
    const hash = await hashPassword(PW);
    expect(hash.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(await verifyPassword(PW, hash)).toBe(true);
    expect(needsRehash(hash)).toBe(false);
  });

  it('current params fit the verifier bound, which leaves headroom to raise N later', async () => {
    expect(SCRYPT_N).toBe(1 << 15);
    expect(128 * SCRYPT_N * SCRYPT_R).toBeLessThanOrEqual(SCRYPT_MAX_WORKING_SET);
    // A hash made with a stronger N still verifies (raising SCRYPT_N can't lock anyone out)…
    const stronger = await hashPassword('pw-stronger-1', { N: 1 << 16, r: 8, p: 1, keylen: 64 });
    expect(await verifyPassword('pw-stronger-1', stronger)).toBe(true);
    expect(needsRehash(stronger)).toBe(true); // …and is normalized to the current params
    // …while an absurd (tampered) row is rejected without being run.
    expect(await verifyPassword('pw-stronger-1', stronger.replace(/^scrypt\$65536\$/, `scrypt$${1 << 20}$`))).toBe(false);
    expect(await verifyPassword('pw-stronger-1', stronger.replace(/^scrypt\$65536\$8\$/, 'scrypt$65536$32$'))).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  const legacySets = [
    ['v0.1 N=2^14, p=1', LEGACY_SCRYPT_PARAMS, 'scrypt$16384$8$1$'],
    ['first-pass N=2^15, p=1', LEGACY_P1_SCRYPT_PARAMS, 'scrypt$32768$8$1$'],
  ] as const;

  it.each(legacySets)('verifies legacy %s hashes and flags them for rehash', async (_name, params, prefix) => {
    const legacy = await hashPassword(PW, params);
    expect(legacy.startsWith(prefix)).toBe(true);
    expect(await verifyPassword(PW, legacy)).toBe(true);
    expect(await verifyPassword('nope nope', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(await hashPassword(PW))).toBe(false);
  });

  it('a failed verify costs the current params\' work whatever the stored params (no legacy-account timing tell)', async () => {
    await scryptIdle();
    const work = async (stored: string, pw: string): Promise<number> => {
      const before = scryptStats().work;
      await verifyPassword(pw, stored);
      return scryptStats().work - before;
    };
    const current = await hashPassword(PW);
    const v01 = await hashPassword(PW, LEGACY_SCRYPT_PARAMS);
    const p1 = await hashPassword(PW, LEGACY_P1_SCRYPT_PARAMS);
    const stronger = await hashPassword(PW, { N: 1 << 16, r: 8, p: 2, keylen: 64 });
    const full = scryptWork(SCRYPT_PARAMS);
    // Wrong password: the unknown-login dummy path (current params), both legacy sets and a corrupt row all
    // burn the same work, so response time can't tell a dormant legacy account from a missing one.
    expect(await work(current, 'wrong guess')).toBe(full);
    expect(await work(v01, 'wrong guess')).toBe(full);
    expect(await work(p1, 'wrong guess')).toBe(full);
    expect(await work('garbage', 'wrong guess')).toBe(full);
    // A stronger stored hash already costs more; it is never shortened or padded.
    expect(await work(stronger, 'wrong guess')).toBe(scryptWork({ N: 1 << 16, r: 8, p: 2 }));
    // A success is not padded (the caller rehashes it anyway).
    expect(await work(v01, PW)).toBe(scryptWork(LEGACY_SCRYPT_PARAMS));
    expect(await work(p1, PW)).toBe(scryptWork(LEGACY_P1_SCRYPT_PARAMS));
    // The padding runs are whole scrypt lanes at a sane N.
    expect(paddingParams(full - scryptWork(LEGACY_P1_SCRYPT_PARAMS))).toEqual({ N: 1 << 15, r: 8, p: 2 });
    expect(paddingParams(full - scryptWork(LEGACY_SCRYPT_PARAMS))).toEqual({ N: 1 << 14, r: 8, p: 5 });
    expect(paddingParams(0)).toBeNull();
    expect(paddingParams(-5)).toBeNull();
    expect(paddingParams(full - 2)).toEqual({ N: 1 << 15, r: 8, p: 3 }); // odd remainder rounds to whole lanes
  });

  it.each(legacySets)('transparently rehashes a legacy %s hash to p=3 on successful login (never on a failed one)', async (_name, params) => {
    const h = await start();
    await reg(h, 'Oldtimer', 'oldtimer@example.com');
    await h.stop();
    const legacy = await hashPassword(PW, params);
    const db0 = new DatabaseSync(h.dbPath);
    db0.prepare('UPDATE accounts SET pass_hash = ?').run(legacy);
    db0.close();

    const h2 = await start({ dir: h.dir, clock: h.clock });
    const storedHash = (): string => {
      const db = new DatabaseSync(h2.dbPath);
      try { return String((db.prepare('SELECT pass_hash FROM accounts').get() as { pass_hash: string }).pass_hash); } finally { db.close(); }
    };
    expect((await post(h2, '/api/login', { login: 'oldtimer', password: 'wrong password' })).status).toBe(401);
    expect(storedHash()).toBe(legacy);

    const ok = await post(h2, '/api/login', { login: 'oldtimer', password: PW });
    expect(ok.status).toBe(200);
    const upgraded = storedHash();
    expect(upgraded).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(needsRehash(upgraded)).toBe(false);
    expect(h2.logs).toContain('[auth] upgraded password hash for Oldtimer');

    expect((await post(h2, '/api/login', { login: 'oldtimer@example.com', password: PW })).status).toBe(200);
    expect(storedHash()).toBe(upgraded); // no churn once current
  });

  it('concurrent logins on a legacy hash both succeed (the losing rehash is not a failed login)', async () => {
    const h = await start();
    await reg(h, 'Twin', 'twin@example.com');
    await h.stop();
    const db0 = new DatabaseSync(h.dbPath);
    db0.prepare('UPDATE accounts SET pass_hash = ?').run(await hashPassword(PW, LEGACY_P1_SCRYPT_PARAMS));
    db0.close();
    const h2 = await start({ dir: h.dir, clock: h.clock });
    const [a, b] = await Promise.all([
      post(h2, '/api/login', { login: 'twin', password: PW }),
      post(h2, '/api/login', { login: 'twin', password: PW }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h2.logs.filter((l) => l.includes('upgraded password hash')).length).toBe(1); // one swap won
    expect(await h2.svc.verifyToken(a.body.token)).not.toBeNull();
    expect(await h2.svc.verifyToken(b.body.token)).not.toBeNull();
  });

  it('a password reset that lands mid-login wins: the old password gets no session', async () => {
    const h = await start();
    await reg(h, 'Racer', 'racer@example.com');
    await post(h, '/api/forgot', { email: 'racer@example.com' });
    const resetToken = lastResetToken(h);
    // Start a login with the OLD password; while its scrypt runs, complete a reset.
    const login = post(h, '/api/login', { login: 'racer', password: PW });
    await new Promise((r) => setTimeout(r, 0));
    const reset = await post(h, '/api/reset', { resetToken, password: 'the new password' });
    expect(reset.status).toBe(200);
    const res = await login;
    // Either the login finished before the reset (its session was then revoked), or it was refused.
    if (res.status === 200) expect(await h.svc.verifyToken(res.body.token)).toBeNull();
    else expect(res).toMatchObject({ status: 401, body: { error: ERR.badLogin } });
  });

  it('swapPassHash never overwrites a hash that changed underneath it (e.g. a concurrent reset)', () => {
    const store = new AuthStore(':memory:');
    try {
      store.insertAccount({
        id: 'acc1', username: 'U', username_lower: 'u', email: 'u@x.io', email_lower: 'u@x.io',
        pass_hash: 'reset-hash', created_at: T0, last_login: null,
      });
      expect(store.swapPassHash('acc1', 'hash-the-login-verified', 'rehash-of-old-password')).toBe(false);
      expect(store.accountById('acc1')!.pass_hash).toBe('reset-hash');
      expect(store.swapPassHash('acc1', 'reset-hash', 'upgraded')).toBe(true);
      expect(store.accountById('acc1')!.pass_hash).toBe('upgraded');
    } finally {
      store.close();
    }
  });
});
