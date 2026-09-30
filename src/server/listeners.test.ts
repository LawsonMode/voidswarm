// Listeners and place rules (docs/LAN-EDITION-proposal.md §3.1, §3.2): the Host allowlists (T-LAN-9), the forwarding-header
// refusal on the admin listener (T-NET-1, admin part), isHostPc, and the admin listener's bindings. Ephemeral ports only.
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_REFUSE, FORWARDING_HEADER_RE, GAME_REFUSE, adminLanHosts, adminLoopbackHosts, bindingOf, forwardingHeaders, gameHosts, gameListenerContext,
  gameOriginDecision, hostAllowed, isHostPc, isHostPcOnGamePort, isLoopbackAddress, isLoopbackAddressKey, isRefusal, mainPortAdminContext, parseHostHeader, sessionAddress,
  startAdminListener, tagSocket, type AdminListener, type AdminPlacePolicy, type AdminRequestContext, type GameRequestContext,
} from './listeners';

// ------------------------------------------------------------------------------------------ helpers

interface Reply { status: number; headers: IncomingHttpHeaders; text: string }
function get(port: number, path: string, headers: Record<string, string> = {}, host = '127.0.0.1'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fakeReq(o: { remote?: string; host?: string; headers?: Record<string, string>; binding?: Parameters<typeof tagSocket>[1]; localPort?: number }): IncomingMessage {
  const socket = { remoteAddress: o.remote ?? '127.0.0.1', ...(o.localPort ? { localPort: o.localPort } : {}) } as unknown as Socket;
  if (o.binding) tagSocket(socket, o.binding);
  return { socket, headers: { ...(o.host !== undefined ? { host: o.host } : {}), ...(o.headers ?? {}) } } as unknown as IncomingMessage;
}

async function canBind(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(0, address, () => s.close(() => resolve(true)));
  });
}

const listeners: AdminListener[] = [];
afterEach(async () => { for (const l of listeners.splice(0)) await l.close(); });

// ------------------------------------------------------------------------------------------ pure rules

describe('Host header parsing and the allowlists (T-LAN-9)', () => {
  it('parses host and port, keeps IPv6 brackets, refuses junk', () => {
    expect(parseHostHeader('LocalHost:7778')).toEqual({ host: 'localhost', port: 7778 });
    expect(parseHostHeader('[::1]:7778')).toEqual({ host: '[::1]', port: 7778 });
    expect(parseHostHeader('192.168.1.50')).toEqual({ host: '192.168.1.50', port: null });
    for (const bad of ['', 'a b:1', 'user@localhost:1', 'localhost:99999', 'localhost:0', 'localhost:x', '::1:7778', '[::1', 'x/y:1', undefined]) {
      expect(parseHostHeader(bad), String(bad)).toBeNull();
    }
  });

  it('admin loopback: localhost / 127.0.0.1 / [::1] with :A only', () => {
    const a = adminLoopbackHosts(7778);
    for (const ok of ['localhost:7778', '127.0.0.1:7778', '[::1]:7778', 'LOCALHOST:7778']) expect(hostAllowed(ok, a), ok).toBe(true);
    for (const bad of ['localhost', 'localhost:7777', 'x.trycloudflare.com', 'x.trycloudflare.com:7778', '192.168.1.50:7778', 'localhost.:7778', '127.0.0.2:7778']) {
      expect(hostAllowed(bad, a), bad).toBe(false);
    }
  });

  it('admin LAN: the primary address and IT names with :A', () => {
    const a = adminLanHosts(7778, { primary: '192.168.1.50', names: ['voidswarm.caldwellschools.org'] });
    expect(hostAllowed('192.168.1.50:7778', a)).toBe(true);
    expect(hostAllowed('voidswarm.caldwellschools.org:7778', a)).toBe(true);
    expect(hostAllowed('localhost:7778', a)).toBe(false);
    expect(hostAllowed('192.168.1.50:7777', a)).toBe(false);
    expect(hostAllowed('evil.caldwellschools.org:7778', a)).toBe(false);
  });

  it('game: primary IP, computer name, <name>.local, IT names and loopback, each with :P; default ports only when standard', () => {
    const g = gameHosts(7777, { primary: '192.168.1.50', computerName: 'ROOM136-PC', names: ['voidswarm.caldwellschools.org'] });
    for (const ok of ['192.168.1.50:7777', 'room136-pc:7777', 'room136-pc.local:7777', 'voidswarm.caldwellschools.org:7777', 'localhost:7777', '[::1]:7777']) {
      expect(hostAllowed(ok, g), ok).toBe(true);
    }
    for (const bad of ['192.168.1.50', '192.168.1.51:7777', 'x.trycloudflare.com:7777', 'room136-pc:7778']) expect(hostAllowed(bad, g), bad).toBe(false);
    const std = gameHosts(443, { primary: '192.168.1.50', scheme: 'https' });
    expect(hostAllowed('192.168.1.50', std)).toBe(true);
    expect(hostAllowed('192.168.1.50:443', std)).toBe(true);
  });
});

describe('forwarding headers, loopback, isHostPc', () => {
  it('every forwarding header is recognised', () => {
    for (const h of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'via', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'true-client-ip']) {
      expect(FORWARDING_HEADER_RE.test(h), h).toBe(true);
    }
    for (const h of ['host', 'origin', 'x-requested-with', 'forwarded-for-x', 'viaduct']) expect(FORWARDING_HEADER_RE.test(h), h).toBe(false);
    expect(forwardingHeaders(fakeReq({ headers: { 'cf-connecting-ip': '1.2.3.4', origin: 'x' } }))).toEqual(['cf-connecting-ip']);
  });

  it('loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '[::1]']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ['10.0.0.1', '::2', '::ffff:10.0.0.1', '1::1', '', null, 'localhost']) expect(isLoopbackAddress(a), String(a)).toBe(false);
    expect(sessionAddress('::1')).toBe('loopback');
    expect(sessionAddress('192.168.1.7')).toBe('192.168.1.7');
  });

  it('isHostPc: the admin loopback binding, loopback socket and Host, no forwarding header, no TRUST_PROXY', () => {
    const ok = { remote: '127.0.0.1', host: 'localhost:7778', binding: 'admin-loopback' as const };
    expect(isHostPc(fakeReq(ok), { port: 7778 })).toBe(true);
    expect(isHostPc(fakeReq({ ...ok, remote: '::1', host: '[::1]:7778' }), { port: 7778 })).toBe(true);
    expect(isHostPc(fakeReq(ok), { port: 7778, trustProxy: true })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, binding: 'admin-lan' }), { port: 7778 })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, binding: undefined }), { port: 7778 })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, remote: '192.168.1.7' }), { port: 7778 })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, host: 'x.trycloudflare.com' }), { port: 7778 })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, host: 'localhost:7777' }), { port: 7778 })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, headers: { 'x-forwarded-for': '203.0.113.9' } }), { port: 7778 })).toBe(false);
    expect(isHostPc(fakeReq({ ...ok, headers: { 'cf-connecting-ip': '203.0.113.9' } }), { port: 7778 })).toBe(false);
  });

  it('the game port host-PC rule also needs a same-origin Origin', () => {
    const base = { remote: '127.0.0.1', host: 'localhost:7777', binding: 'game-loopback' as const };
    expect(isHostPcOnGamePort(fakeReq({ ...base, headers: { origin: 'http://localhost:7777' } }), { port: 7777 })).toBe(true);
    expect(isHostPcOnGamePort(fakeReq(base), { port: 7777 })).toBe(false);
    expect(isHostPcOnGamePort(fakeReq({ ...base, headers: { origin: 'https://evil.example' } }), { port: 7777 })).toBe(false);
    expect(isHostPcOnGamePort(fakeReq({ ...base, binding: 'game-lan', headers: { origin: 'http://localhost:7777' } }), { port: 7777 })).toBe(false);
  });

  it('the main port (VPS / npm start): trusted proxy, the operator\'s loopback, or an untrusted tunnel', () => {
    const trust = { enabled: true, extra: [] as string[] };
    const viaProxy = mainPortAdminContext(fakeReq({ remote: '127.0.0.1', host: 'play.caldwellschools.org', headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' } }), { trust });
    expect(viaProxy).toMatchObject({ via: 'proxy', secure: true, trustedTls: true, hostPc: false, address: '203.0.113.9', origin: 'https://play.caldwellschools.org' });
    const off = { trust: { enabled: false, extra: [] as string[] } };
    const direct = mainPortAdminContext(fakeReq({ remote: '127.0.0.1', host: 'localhost:7777', localPort: 7777 }), off);
    expect(direct).toMatchObject({ via: 'direct', hostPc: false, address: 'loopback', origin: 'http://localhost:7777' });
    expect(mainPortAdminContext(fakeReq({ remote: '::1', host: '[::1]:7777', localPort: 7777 }), off)).toMatchObject({ via: 'direct' });
    expect(mainPortAdminContext(fakeReq({ remote: '127.0.0.1', host: '127.0.0.1:8080' }), { ...off, port: 8080 })).toMatchObject({ via: 'direct' });
    // A loopback socket alone proves nothing: DNS rebinding (the attacker's name as Host), another port, no port
    // known, no Host → `proxy`, not secure (sign-in is refused), never `direct`.
    for (const [host, localPort] of [['evil.example:7777', 7777], ['evil.example', 7777], ['localhost:7778', 7777], ['localhost', 7777], ['localhost:7777', undefined], [undefined, 7777]] as const) {
      expect(mainPortAdminContext(fakeReq({ remote: '127.0.0.1', host, localPort }), off), `${host} @${localPort}`).toMatchObject({ via: 'proxy', secure: false, trustedTls: false, hostPc: false });
    }
    const tunnel = mainPortAdminContext(fakeReq({ remote: '127.0.0.1', host: 'x.trycloudflare.com', headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https' } }), { trust: { enabled: false, extra: [] } });
    expect(tunnel).toMatchObject({ via: 'proxy', secure: false, trustedTls: false, hostPc: false });
  });
});

// ------------------------------------------------------------------------------------------ the game port's rules

describe('the game listener\'s place rules (T-NET-1 game part, T-LAN-9 game listener; B13 wires them)', () => {
  const allow = gameHosts(7777, { primary: '192.168.1.50', computerName: 'ROOM136-PC' });
  const ctxOf = (o: Parameters<typeof fakeReq>[0], secure = false) => gameListenerContext(fakeReq(o), { port: 7777, allow, secure });

  it('a Host outside the allowlist gets 421 and no host rights (127.0.0.1 with Host x.trycloudflare.com)', () => {
    expect(ctxOf({ remote: '127.0.0.1', host: 'x.trycloudflare.com', binding: 'game-loopback', headers: { origin: 'http://x.trycloudflare.com' } }))
      .toEqual({ refuse: [421, GAME_REFUSE.host] });
    expect(ctxOf({ remote: '192.168.1.7', host: 'evil.example:7777', binding: 'game-lan' })).toEqual({ refuse: [421, GAME_REFUSE.host] });
    expect(ctxOf({ remote: '192.168.1.7', host: undefined, binding: 'game-lan' })).toEqual({ refuse: [421, GAME_REFUSE.host] });
  });

  it('a loopback socket with CF-Connecting-IP or X-Forwarded-For gets 403 (a tunnel)', () => {
    for (const h of ['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'via', 'x-real-ip', 'true-client-ip']) {
      expect(ctxOf({ remote: '127.0.0.1', host: 'localhost:7777', binding: 'game-loopback', headers: { [h]: '203.0.113.9' } }), h)
        .toEqual({ refuse: [403, GAME_REFUSE.tunnel] });
    }
  });

  it('a LAN socket with Via is served, flagged, and keyed by its own address, never the header\'s', () => {
    const c = ctxOf({ remote: '192.168.1.7', host: '192.168.1.50:7777', binding: 'game-lan', headers: { via: '1.1 proxy.caldwellschools.org', 'x-forwarded-for': '10.9.9.9' } });
    expect(isRefusal(c)).toBe(false);
    expect(c).toMatchObject({ proxied: ['via', 'x-forwarded-for'], address: '192.168.1.7', hostPc: false, origin: 'http://192.168.1.50:7777' });
  });

  it('host-PC rights on the game port: loopback binding, socket and Host, plus a same-origin Origin', () => {
    const base = { remote: '127.0.0.1', host: 'localhost:7777', binding: 'game-loopback' as const };
    expect(ctxOf({ ...base, headers: { origin: 'http://localhost:7777' } })).toMatchObject({ hostPc: true, address: 'loopback', proxied: [] });
    expect(ctxOf(base)).toMatchObject({ hostPc: false });
    expect(ctxOf({ ...base, binding: 'game-lan', headers: { origin: 'http://localhost:7777' } })).toMatchObject({ hostPc: false });
    expect(ctxOf({ ...base, headers: { origin: 'https://localhost:7777' } }, true)).toMatchObject({ hostPc: true, origin: 'https://localhost:7777' });
  });

  it('Origin: POSTs and ws upgrades need the listener\'s own origin; a ws with no Origin only from loopback, never host PC', () => {
    const lanReq = fakeReq({ remote: '192.168.1.7', host: '192.168.1.50:7777', binding: 'game-lan', headers: { origin: 'https://evil.example' } });
    const lanCtx = gameListenerContext(lanReq, { port: 7777, allow, secure: false }) as GameRequestContext;
    expect(gameOriginDecision(lanReq, lanCtx, 'ws')).toEqual({ ok: false, status: 403, error: GAME_REFUSE.origin });
    const same = fakeReq({ remote: '192.168.1.7', host: '192.168.1.50:7777', binding: 'game-lan', headers: { origin: 'http://192.168.1.50:7777' } });
    expect(gameOriginDecision(same, gameListenerContext(same, { port: 7777, allow, secure: false }) as GameRequestContext, 'post')).toEqual({ ok: true, hostPc: false });
    const noOriginLan = fakeReq({ remote: '192.168.1.7', host: '192.168.1.50:7777', binding: 'game-lan' });
    const noOriginLanCtx = gameListenerContext(noOriginLan, { port: 7777, allow, secure: false }) as GameRequestContext;
    expect(gameOriginDecision(noOriginLan, noOriginLanCtx, 'ws')).toMatchObject({ ok: false, status: 403 });
    const tool = fakeReq({ remote: '127.0.0.1', host: 'localhost:7777', binding: 'game-loopback' });
    const toolCtx = gameListenerContext(tool, { port: 7777, allow, secure: false }) as GameRequestContext;
    expect(gameOriginDecision(tool, { ...toolCtx, hostPc: true }, 'ws')).toEqual({ ok: true, hostPc: false });
    expect(gameOriginDecision(tool, toolCtx, 'post')).toMatchObject({ ok: false, status: 403 });
    const hostPc = fakeReq({ remote: '127.0.0.1', host: 'localhost:7777', binding: 'game-loopback', headers: { origin: 'http://localhost:7777' } });
    expect(gameOriginDecision(hostPc, gameListenerContext(hostPc, { port: 7777, allow, secure: false }) as GameRequestContext, 'ws')).toEqual({ ok: true, hostPc: true });
  });

  it('T-LAN-9 on real sockets: a game-port harness using these rules answers 421 to a foreign Host', async () => {
    const server = createHttpServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      const c = gameListenerContext(req, { port, allow: gameHosts(port, {}), secure: false });
      if (isRefusal(c)) { res.writeHead(c.refuse[0]).end(c.refuse[1]); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(c));
    });
    server.on('connection', (s: Socket) => tagSocket(s, 'game-loopback'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      expect((await get(port, '/', { Host: 'x.trycloudflare.com' })).status).toBe(421);
      expect((await get(port, '/', { Host: `localhost:${port}`, 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(403);
      const ok = await get(port, '/', { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toMatchObject({ hostPc: true, binding: 'game-loopback' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ------------------------------------------------------------------------------------------ the admin listener

describe('startAdminListener', () => {
  const policy: AdminPlacePolicy = { remoteAccess: 'off', devicesTrustCert: false };
  const seen: AdminRequestContext[] = [];
  const start = async (over: Partial<Parameters<typeof startAdminListener>[0]> = {}): Promise<AdminListener> => {
    const l = await startAdminListener({
      port: 0,
      policy: () => policy,
      handle: (req, res, ctx) => {
        seen.push(ctx);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, binding: bindingOf(req.socket), hostPc: ctx.hostPc }));
      },
      ...over,
    });
    listeners.push(l);
    return l;
  };

  it('answers the host PC on 127.0.0.1 (and ::1 when present) with isHostPc true', async () => {
    const l = await start();
    const r = await get(l.port, '/', { Host: `localhost:${l.port}` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, binding: 'admin-loopback', hostPc: true });
    expect(seen.at(-1)).toMatchObject({ via: 'local', hostPc: true, address: 'loopback', origin: `http://localhost:${l.port}` });
    const bound = l.bound();
    expect(bound.every((b) => b.binding === 'admin-loopback' && b.port === l.port)).toBe(true);
    if (bound.some((b) => b.address === '::1')) {
      const v6 = await get(l.port, '/', { Host: `[::1]:${l.port}` }, '::1');
      expect(JSON.parse(v6.text)).toMatchObject({ hostPc: true });
    }
    // never on 0.0.0.0
    expect(bound.map((b) => b.address)).not.toContain('0.0.0.0');
  });

  it('T-LAN-9 / T-NET-1: a Host outside the allowlist gets 421 and no host rights', async () => {
    const l = await start();
    seen.length = 0;
    for (const host of ['x.trycloudflare.com', `x.trycloudflare.com:${l.port}`, `localhost:${l.port + 1}`, `192.168.1.50:${l.port}`, 'localhost']) {
      const r = await get(l.port, '/api/admin/me', { Host: host });
      expect(r.status, host).toBe(421);
      expect(JSON.parse(r.text)).toEqual({ error: ADMIN_REFUSE.host });
    }
    expect((await get(l.port, '/', { Host: 'x.trycloudflare.com' })).text).toContain('Misdirected');
    expect(seen).toEqual([]);
  });

  it('T-NET-1: the admin listener refuses any forwarding header (a tunnel or local proxy)', async () => {
    const l = await start();
    seen.length = 0;
    for (const [h, v] of [['X-Forwarded-For', '203.0.113.9'], ['CF-Connecting-IP', '203.0.113.9'], ['Via', '1.1 proxy'], ['Forwarded', 'for=203.0.113.9'], ['X-Real-IP', '203.0.113.9'], ['True-Client-IP', '203.0.113.9'], ['X-Forwarded-Proto', 'https']]) {
      const r = await get(l.port, '/', { Host: `localhost:${l.port}`, [h!]: v! });
      expect(r.status, h).toBe(403);
      expect(r.text).toContain("can't be used through a proxy or tunnel");
    }
    expect(seen).toEqual([]);
  });

  it('refuses WebSocket upgrades', async () => {
    const l = await start();
    const answer = await new Promise<string>((resolve, reject) => {
      const s = connect(l.port, '127.0.0.1', () => {
        s.write(`GET / HTTP/1.1\r\nHost: localhost:${l.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let buf = '';
      s.on('data', (d) => { buf += d.toString(); });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 404/);
  });

  it('a busy port rejects with EADDRINUSE', async () => {
    const l = await start();
    await expect(startAdminListener({ port: l.port, policy: () => policy, handle: () => undefined, loopback: ['127.0.0.1'] }))
      .rejects.toMatchObject({ name: 'AdminListenError', code: 'EADDRINUSE' });
  });

  it('the LAN binding answers only over TLS and only while remote access is on (plain http from the LAN: 403)', async () => {
    if (!(await canBind('127.0.0.2'))) return; // this OS has no 127.0.0.2 (the https path is covered in adminListener.test.ts)
    const l = await start({ loopback: ['127.0.0.1'], lan: { address: '127.0.0.2', tls: null } });
    expect(l.bound().map((b) => [b.address, b.binding, b.secure])).toEqual([['127.0.0.1', 'admin-loopback', false], ['127.0.0.2', 'admin-lan', false]]);
    seen.length = 0;
    policy.remoteAccess = 'full';
    const r = await get(l.port, '/', { Host: `127.0.0.2:${l.port}` }, '127.0.0.2');
    expect(r.status).toBe(403);
    expect(r.text).toContain('needs the secure address');
    expect((await get(l.port, '/', { Host: `localhost:${l.port}` }, '127.0.0.2')).status).toBe(421);
    expect(seen).toEqual([]);
    await l.setLan(null);
    expect(l.bound()).toHaveLength(1);
    policy.remoteAccess = 'off';
  });

  it('onRefuse hears every request refused at the door (status, message, the socket address), never a passing one', async () => {
    const refused: [string, number, string, string][] = [];
    const l = await start({ onRefuse: (req, status, message, address) => { refused.push([String(req.url), status, message, address]); } });
    expect((await get(l.port, '/api/admin/login', { Host: `localhost:${l.port}` })).status).toBe(200);
    expect(refused).toEqual([]);
    await get(l.port, '/api/admin/login', { Host: `localhost:${l.port}`, 'X-Forwarded-For': '203.0.113.9' });
    await get(l.port, '/api/admin/setup', { Host: 'x.trycloudflare.com' });
    expect(refused).toEqual([
      ['/api/admin/login', 403, ADMIN_REFUSE.forwarded, 'loopback'],
      ['/api/admin/setup', 421, ADMIN_REFUSE.host, 'loopback'],
    ]);
    // A hook that throws never breaks the listener.
    const l2 = await start({ onRefuse: () => { throw new Error('boom'); } });
    expect((await get(l2.port, '/', { Host: 'x.trycloudflare.com' })).status).toBe(421);
    expect((await get(l2.port, '/', { Host: `localhost:${l2.port}` })).status).toBe(200);
  });
});

describe('isLoopbackAddressKey (a pilot address key that is the host PC itself)', () => {
  it('127.x, the /64 key of ::1 and `loopback`; nothing else', () => {
    for (const k of ['127.0.0.1', '127.10.0.3', '0:0:0:0::/64', '::/64', 'loopback', '::1', ' 127.0.0.1 ']) expect(isLoopbackAddressKey(k), k).toBe(true);
    for (const k of ['192.168.1.23', '10.0.0.7', 'fe80:0:0:0::/64', '2001:db8:0:0::/64', '', null, undefined, 'tag:1ba1']) expect(isLoopbackAddressKey(k), String(k)).toBe(false);
  });
});
