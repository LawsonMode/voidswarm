// OWNER: SERVER. Listeners and the per-request place rules (docs/LAN-EDITION-proposal.md §3.1, §3.2, §4.10).
//
// The ADMIN LISTENER (port A = P + 1) is a separate origin from the game, so nothing that runs on the game origin can
// read an admin session:
//  - always on 127.0.0.1 and ::1 over plain http (the host PC);
//  - also on the primary LAN address, over https only, while admin.remoteAccess is not `off` (setLan()).
// Every request passes these rules before it is routed:
//  - Host allowlist, per listener: loopback names with :A (plus the primary address and IT's names with :A on the
//    LAN binding). Anything else gets 421.
//  - Proxies and tunnels: the admin listener refuses ANY forwarding header (Forwarded, X-Forwarded-*, Via, CF-*,
//    X-Real-IP, True-Client-IP) with 403: a loopback socket carrying one is a tunnel or a local reverse proxy.
//  - The LAN binding answers only over TLS, and only while remote access is on (403 otherwise).
//  - No WebSocket upgrades (the admin API is HTTP long-poll).
// isHostPc(req) is true only when the request arrived on the admin listener's loopback binding, the socket is
// loopback, Host is localhost / 127.0.0.1 / [::1] with :A, no forwarding header is present and TRUST_PROXY is off.
// The game port's only host-PC rule uses the same test with :P plus a same-origin Origin (isHostPcOnGamePort).
//
// The game listener's front door (TLS sniffing, socket caps; B13) reuses the Host allowlist (gameHosts), tagSocket()
// and the game port's place rules from here: gameListenerContext (421 Host, 403 tunnel, the LAN proxy flag) and
// gameOriginDecision (same-origin POSTs and ws upgrades; a ws with no Origin only from loopback, never host PC).
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { isIP, type Socket } from 'node:net';
import type { SecureContextOptions } from 'node:tls';
import { rateLimitKey } from './auth/http';
import { REMOTE_OFF, type RemoteAccess } from './moderation/capabilities';
import type { AdminCaller } from './moderation/hostAdmin';
import { isTrustedProxyPeer, lastForwardedHop, type ProxyTrust } from './netguard';

// ------------------------------------------------------------------------------------------
// Addresses and headers
// ------------------------------------------------------------------------------------------

/** Headers that mean a proxy or tunnel is in front of the request (§3.2). */
export const FORWARDING_HEADER_RE = /^(?:forwarded|x-forwarded-[a-z0-9-]*|via|cf-[a-z0-9-]*|x-real-ip|true-client-ip)$/i;

/** The forwarding headers present on a request (lowercase names). */
export function forwardingHeaders(req: Pick<IncomingMessage, 'headers'>): string[] {
  return Object.keys(req.headers).filter((h) => FORWARDING_HEADER_RE.test(h));
}
export const hasForwardingHeader = (req: Pick<IncomingMessage, 'headers'>): boolean => forwardingHeaders(req).length > 0;

/** 127.0.0.0/8, ::1 and IPv4-mapped loopback (::ffff:127.x.y.z). */
export function isLoopbackAddress(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let s = String(raw).trim().toLowerCase();
  const br = /^\[([^\]]+)\]$/.exec(s);
  if (br) s = br[1]!;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (isIP(s) === 4) return s.startsWith('127.');
  if (isIP(s) === 6) return /^(?:0{0,4}:){2,7}0{0,3}1$/.test(s) || s === '::1';
  return false;
}

/**
 * A pilot's address KEY (OnlinePilot.address: a rate-limit key, IPv4 or an IPv6 /64) that is this PC's own loopback:
 * `127.x.x.x`, the /64 key of `::1` (`0:0:0:0::/64`), or `loopback`. An address target never selects that connection
 * (§5.2 "Address bans never match the host PC's own connection").
 */
export function isLoopbackAddressKey(key: string | null | undefined): boolean {
  if (typeof key !== 'string' || !key) return false;
  const s = key.trim().toLowerCase();
  return s === 'loopback' || s === '0:0:0:0::/64' || s === '::/64' || isLoopbackAddress(s);
}

/** The session address of a socket: 'loopback' for any loopback socket (127.0.0.1 and ::1 are one), else rateLimitKey. */
export function sessionAddress(raw: string | null | undefined): string {
  return isLoopbackAddress(raw) ? 'loopback' : rateLimitKey(String(raw ?? 'unknown'));
}

export interface ParsedHost { host: string; port: number | null }

/**
 * A Host header → lowercase host and port, or null when malformed (userinfo, a path, spaces, a bad port, an empty
 * name). IPv6 keeps its brackets ("[::1]").
 */
export function parseHostHeader(raw: string | string[] | undefined): ParsedHost | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 260 || /[\s/\\@?#]/.test(s)) return null;
  let host: string;
  let portStr: string | undefined;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    host = s.slice(0, end + 1);
    const rest = s.slice(end + 1);
    if (rest && !rest.startsWith(':')) return null;
    portStr = rest ? rest.slice(1) : undefined;
    if (isIP(host.slice(1, -1)) !== 6) return null;
  } else {
    const i = s.lastIndexOf(':');
    if (i >= 0 && s.indexOf(':') !== i) return null; // bare IPv6 without brackets
    host = i >= 0 ? s.slice(0, i) : s;
    portStr = i >= 0 ? s.slice(i + 1) : undefined;
    if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  }
  let port: number | null = null;
  if (portStr !== undefined) {
    if (!/^\d{1,5}$/.test(portStr)) return null;
    port = Number(portStr);
    if (port < 1 || port > 65535) return null;
  }
  return { host, port };
}

/** The names a listener answers to, and its port. */
export interface HostAllowlist {
  names: ReadonlySet<string>;
  port: number;
  /** The listener's scheme: a Host without a port is accepted only when `port` is its default (80 / 443). */
  scheme: 'http' | 'https';
}

export const LOOPBACK_NAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

const hostName = (n: string): string | null => {
  const s = String(n ?? '').trim().toLowerCase();
  if (!s) return null;
  if (isIP(s) === 6) return `[${s}]`;
  const p = parseHostHeader(s);
  return p && p.port === null ? p.host : null;
};

export function makeAllowlist(names: readonly (string | null | undefined)[], port: number, scheme: 'http' | 'https'): HostAllowlist {
  const set = new Set<string>();
  for (const n of names) { const h = n ? hostName(n) : null; if (h) set.add(h); }
  return { names: set, port, scheme };
}

/** Admin loopback binding: localhost / 127.0.0.1 / [::1] with :A. */
export const adminLoopbackHosts = (port: number): HostAllowlist => makeAllowlist(LOOPBACK_NAMES, port, 'http');

/** Admin LAN binding: the primary address and IT's extra names (and the own certificate's name) with :A. */
export const adminLanHosts = (port: number, o: { primary: string; names?: readonly string[] }): HostAllowlist =>
  makeAllowlist([o.primary, ...(o.names ?? [])], port, 'https');

/**
 * Game listener (§3.2): the primary IP, the computer name, `<name>.local`, IT's extra names, and the loopback names,
 * each with :P. `scheme` only matters for the standard ports (a Host without a port).
 */
export function gameHosts(port: number, o: { primary?: string | null; computerName?: string | null; names?: readonly string[]; scheme?: 'http' | 'https' } = {}): HostAllowlist {
  const cn = o.computerName ? o.computerName.trim().toLowerCase() : '';
  return makeAllowlist([...LOOPBACK_NAMES, o.primary ?? null, cn || null, cn ? `${cn}.local` : null, ...(o.names ?? [])], port, o.scheme ?? 'http');
}

/** Is this Host header on the allowlist (right name, right port)? */
export function hostAllowed(raw: string | string[] | undefined, allow: HostAllowlist): boolean {
  const h = parseHostHeader(raw);
  if (!h || !allow.names.has(h.host)) return false;
  if (h.port === null) return allow.port === (allow.scheme === 'https' ? 443 : 80);
  return h.port === allow.port;
}

// ------------------------------------------------------------------------------------------
// Socket tags: which binding a connection arrived on
// ------------------------------------------------------------------------------------------

/** Where a socket was accepted. `main` = the non-LAN server's one port (`npm start`, the VPS). */
export type Binding = 'admin-loopback' | 'admin-lan' | 'game-loopback' | 'game-lan' | 'main';

const socketTags = new WeakMap<object, Binding>();
export function tagSocket(socket: object, binding: Binding): void { socketTags.set(socket, binding); }
export function bindingOf(socket: object | null | undefined): Binding | null { return socket ? socketTags.get(socket) ?? null : null; }

export interface HostPcOptions {
  /** The listener's port (A for the admin listener, P for the game port). */
  port: number;
  /** TRUST_PROXY is on: then nothing is ever "the host PC". */
  trustProxy?: boolean;
}

/** The common part of both host-PC tests: loopback socket, a loopback Host with the port, no forwarding header. */
function loopbackRequest(req: IncomingMessage, o: HostPcOptions): boolean {
  if (o.trustProxy) return false;
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (!hostAllowed(req.headers.host, makeAllowlist(LOOPBACK_NAMES, o.port, 'http'))) return false;
  return !hasForwardingHeader(req);
}

/** §3.2 isHostPc: the admin listener's loopback binding, loopback socket and Host, no forwarding header, no TRUST_PROXY. */
export function isHostPc(req: IncomingMessage, o: HostPcOptions): boolean {
  return bindingOf(req.socket) === 'admin-loopback' && loopbackRequest(req, o);
}

/**
 * The game port's host-PC rule (guest play labelled "Host PC" while guests are off): the same test with :P, on the
 * game listener's loopback binding, with a same-origin Origin (`http://<Host>` or `https://<Host>` for TLS).
 */
export function isHostPcOnGamePort(req: IncomingMessage, o: HostPcOptions & { secure?: boolean }): boolean {
  const b = bindingOf(req.socket);
  if (b !== 'game-loopback' && b !== 'main') return false;
  if (!loopbackRequest(req, o)) return false;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim().toLowerCase() : '';
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  return !!origin && origin === `${o.secure ? 'https' : 'http'}://${host}`;
}

// ------------------------------------------------------------------------------------------
// The game listener's place rules (LAN edition; B13's front door calls these per request and per ws upgrade)
// ------------------------------------------------------------------------------------------

export const GAME_REFUSE = {
  host: 'Misdirected request: this address is not one this server answers to.',
  tunnel: "This classroom server can't be used through a tunnel — the VPS kit is for online play.",
  origin: 'Origin not allowed',
} as const;

/** What the game port knows about a request that passed its place rules (§3.2). */
export interface GameRequestContext {
  binding: Binding | null;
  /** The client address: always the socket's own. A forwarding header is never trusted for it on the LAN. */
  address: string;
  /**
   * The forwarding headers a LAN request carried (probably a school proxy). The request is served, and the panel is
   * told ("Requests arrive through a proxy — ask IT to send <ip> DIRECT").
   */
  proxied: string[];
  /** The game port's host-PC rule (isHostPcOnGamePort: loopback binding, socket and Host, same-origin Origin). */
  hostPc: boolean;
  /** This listener's own origin for the Host that was used (POSTs and ws upgrades must carry exactly this). */
  origin: string;
  secure: boolean;
}

/**
 * §3.2 for the LAN game listener (not the non-LAN server's one port, which keeps today's BIND / TRUST_PROXY rules):
 *  - a Host outside the allowlist → 421 (so `127.0.0.1` with Host `x.trycloudflare.com` never gets host rights);
 *  - a LOOPBACK socket carrying any forwarding header is a tunnel or a local reverse proxy → 403;
 *  - a LAN socket carrying one is served but flagged (`proxied`), and keyed by its socket address.
 */
export function gameListenerContext(req: IncomingMessage, o: { port: number; allow: HostAllowlist; secure: boolean }): GameRequestContext | AdminRefusal {
  if (!hostAllowed(req.headers.host, o.allow)) return { refuse: [421, GAME_REFUSE.host] };
  const fwd = forwardingHeaders(req);
  const remote = req.socket?.remoteAddress;
  if (fwd.length && isLoopbackAddress(remote)) return { refuse: [403, GAME_REFUSE.tunnel] };
  const host = String(req.headers.host).trim().toLowerCase();
  return {
    binding: bindingOf(req.socket),
    address: sessionAddress(remote),
    proxied: fwd,
    hostPc: isHostPcOnGamePort(req, { port: o.port, secure: o.secure }),
    origin: `${o.secure ? 'https' : 'http'}://${host}`,
    secure: o.secure,
  };
}

/**
 * §3.2 Origin rule for a POST or a ws upgrade on the game port: the Origin must equal the listener's own origin
 * (403 otherwise; the LAN edition never uses CORS). A ws with no Origin is accepted only from a loopback socket
 * (tools such as the smoke test), and never with host-PC rights.
 */
export function gameOriginDecision(req: IncomingMessage, ctx: Pick<GameRequestContext, 'origin' | 'hostPc'>, kind: 'post' | 'ws'): { ok: true; hostPc: boolean } | { ok: false; status: 403; error: string } {
  const raw = req.headers.origin;
  const origin = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (origin) return origin === ctx.origin.toLowerCase() ? { ok: true, hostPc: ctx.hostPc } : { ok: false, status: 403, error: GAME_REFUSE.origin };
  if (kind === 'ws' && isLoopbackAddress(req.socket?.remoteAddress)) return { ok: true, hostPc: false };
  return { ok: false, status: 403, error: GAME_REFUSE.origin };
}

// ------------------------------------------------------------------------------------------
// The admin request context
// ------------------------------------------------------------------------------------------

/** What moderation/http.ts and hostAdmin.ts know about a request (an AdminCaller plus where it came in). */
export interface AdminRequestContext extends AdminCaller {
  binding: Binding;
  /** This listener's own origin for the Host that was used (POSTs must carry exactly this Origin). */
  origin: string;
}

/** A refusal decided before routing: [status, message]. */
export interface AdminRefusal { refuse: [number, string] }
export const isRefusal = <T extends object>(x: T | AdminRefusal): x is AdminRefusal => 'refuse' in x;

export const ADMIN_REFUSE = {
  host: 'Misdirected request: this address is not one this control panel answers to.',
  forwarded: "The control panel can't be used through a proxy or tunnel. Open it on the host PC.",
  needsHttps: 'The control panel needs the secure address (https://…:port) from other devices.',
  remoteOff: REMOTE_OFF,
} as const;

export interface AdminPlacePolicy {
  remoteAccess: RemoteAccess;
  /** network.devicesTrustCert (or the host's own certificate): the LAN TLS is trusted (remote `full` possible). */
  devicesTrustCert: boolean;
}

/** The admin listener's rules for one request (421 Host, 403 forwarded / plain http / remote off), then its context. */
export function adminListenerContext(req: IncomingMessage, o: { port: number; binding: 'admin-loopback' | 'admin-lan'; secure: boolean; lanHosts?: HostAllowlist | null; policy: AdminPlacePolicy; trustProxy?: boolean }): AdminRequestContext | AdminRefusal {
  const allow = o.binding === 'admin-loopback' ? adminLoopbackHosts(o.port) : o.lanHosts ?? null;
  if (!allow || !hostAllowed(req.headers.host, allow)) return { refuse: [421, ADMIN_REFUSE.host] };
  if (hasForwardingHeader(req)) return { refuse: [403, ADMIN_REFUSE.forwarded] };
  const host = String(req.headers.host).trim().toLowerCase();
  if (o.binding === 'admin-loopback') {
    const hostPc = isHostPc(req, { port: o.port, trustProxy: o.trustProxy });
    return { binding: o.binding, via: 'local', hostPc, secure: false, trustedTls: false, address: sessionAddress(req.socket.remoteAddress), origin: `http://${host}` };
  }
  if (!o.secure) return { refuse: [403, ADMIN_REFUSE.needsHttps] };
  if (o.policy.remoteAccess === 'off') return { refuse: [403, ADMIN_REFUSE.remoteOff] };
  // The LAN binding keys by the real address (a loopback source here is only ever a test on 127.0.0.x).
  return {
    binding: o.binding, via: 'https', hostPc: false, secure: true, trustedTls: !!o.policy.devicesTrustCert,
    address: rateLimitKey(String(req.socket.remoteAddress ?? 'unknown')), origin: `https://${host}`,
  };
}

/**
 * The context of `/admin` and `/api/admin/*` on the non-LAN server's one port (`npm start`, the VPS; §3.1 "there is
 * no admin listener"): never the host PC.
 *  - A trusted proxy peer (TRUST_PROXY): via `proxy`; the client is the proxy's appended hop; https when the proxy
 *    says so (X-Forwarded-Proto). A public certificate behind a trusted proxy counts as trusted TLS.
 *  - A loopback socket with no forwarding header AND a loopback Host (localhost / 127.0.0.1 / [::1], with the port
 *    the socket was accepted on): via `direct` (the operator's own PC). A loopback socket alone proves nothing
 *    (§0 fact 9): a DNS-rebinding page in the operator's browser sends its own name as Host, so without the Host test
 *    it would pass the same-origin check and sign in as `direct`.
 *  - Anything else (a tunnel without TRUST_PROXY, a direct remote client over plain http, a loopback socket with a
 *    foreign Host): via `proxy`, not secure, so sign-in is refused (it needs https).
 * Known gap: a local reverse proxy that adds NO forwarding header and rewrites Host to the upstream loopback address
 * (nginx's defaults) still looks `direct`; any reverse proxy in front of the main port must run with TRUST_PROXY and
 * send X-Forwarded-For (the VPS kit's Caddy does).
 */
export function mainPortAdminContext(req: IncomingMessage, o: { trust: ProxyTrust; port?: number }): AdminRequestContext {
  const peer = req.socket?.remoteAddress;
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  if (isTrustedProxyPeer(peer, o.trust)) {
    const xfp = String(req.headers['x-forwarded-proto'] ?? '').split(',').pop()?.trim().toLowerCase();
    const secure = xfp === 'https';
    const hop = lastForwardedHop(req.headers['x-forwarded-for']);
    return { binding: 'main', via: 'proxy', hostPc: false, secure, trustedTls: secure, address: sessionAddress(hop ?? peer), origin: `${secure ? 'https' : 'http'}://${host}` };
  }
  if (isLoopbackAddress(peer) && !hasForwardingHeader(req) && loopbackHostOn(req, o.port)) {
    return { binding: 'main', via: 'direct', hostPc: false, secure: false, trustedTls: false, address: 'loopback', origin: `http://${host}` };
  }
  return { binding: 'main', via: 'proxy', hostPc: false, secure: false, trustedTls: false, address: sessionAddress(peer), origin: `http://${host}` };
}

/**
 * The Host is a loopback name with this listener's port: `port`, else the port the socket was accepted on (unknown:
 * false). A Host without a port means :80.
 */
function loopbackHostOn(req: IncomingMessage, port?: number): boolean {
  const h = parseHostHeader(req.headers.host);
  if (!h || !LOOPBACK_NAMES.includes(h.host)) return false;
  const want = port ?? (typeof req.socket?.localPort === 'number' && req.socket.localPort > 0 ? req.socket.localPort : null);
  return want !== null && (h.port ?? 80) === want;
}

// ------------------------------------------------------------------------------------------
// The admin listener
// ------------------------------------------------------------------------------------------

export interface AdminLanBinding {
  /** The primary LAN address (IPv4). */
  address: string;
  /** The TLS identity (leaf + issuing CA, or the host's own certificate). null = plain http: every request gets 403. */
  tls: SecureContextOptions | null;
  /** IT's extra names and the own certificate's name, allowed in Host. */
  names?: readonly string[];
}

export type AdminRequestHandler = (req: IncomingMessage, res: ServerResponse, ctx: AdminRequestContext) => void | Promise<void>;

export interface AdminListenerOptions {
  /** A (0 = an ephemeral port; tests). The loopback addresses all use the same port. */
  port: number;
  handle: AdminRequestHandler;
  /** Read on every request (remote access, trusted TLS). */
  policy: () => AdminPlacePolicy;
  /** TRUST_PROXY from the environment (the launcher refuses it; with it nothing is the host PC). */
  trustProxy?: boolean;
  /** The https binding on the primary address (only while remote access is on). */
  lan?: AdminLanBinding | null;
  /** Default ['127.0.0.1', '::1'] (::1 is skipped when the PC has no IPv6 loopback). */
  loopback?: readonly string[];
  log?: (line: string) => void;
  /**
   * A request refused before routing (421 Host; 403 forwarded, plain http, remote access off), told after the answer
   * is sent: startAdminPanel audits the refused sign-in and setup attempts (§4.10 "every failure is audited").
   * `address` is the socket's rate-limit key ('loopback' for a loopback socket). Never throws into the listener.
   */
  onRefuse?: (req: IncomingMessage, status: number, message: string, address: string) => void;
}

export interface BoundAddress { address: string; port: number; binding: 'admin-loopback' | 'admin-lan'; secure: boolean }

export interface AdminListener {
  readonly port: number;
  bound(): BoundAddress[];
  /** Replace the LAN binding (remote access switched, the primary address changed); null removes it. */
  setLan(lan: AdminLanBinding | null): Promise<void>;
  /** A renewed leaf certificate, without dropping connections. */
  setSecureContext(tls: SecureContextOptions): void;
  close(): Promise<void>;
}

/** A listen failure the server turns into its friendly message (EADDRINUSE → exit code 2). */
export class AdminListenError extends Error {
  constructor(readonly code: string, readonly address: string, readonly port: number, message: string) { super(message); this.name = 'AdminListenError'; }
}

const REQUEST_TIMEOUT_MS = 60_000; // chat/live long-polls wait up to 25 s
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_ADMIN_CONNECTIONS = 256;

function refuse(res: ServerResponse, req: IncomingMessage, status: number, message: string): void {
  req.resume();
  const api = (req.url ?? '').startsWith('/api/');
  const body = api ? JSON.stringify({ error: message }) : `${message}\n`;
  res.writeHead(status, {
    'Content-Type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(body);
}

function listen(server: HttpServer | HttpsServer, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => { server.off('listening', onListening); reject(e); };
    const onListening = (): void => {
      server.off('error', onError);
      const a = server.address();
      resolve(a && typeof a === 'object' ? a.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: address, exclusive: true });
  });
}

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

const errCode = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? 'ELISTEN');

/** The control panel's port on the host PC (and on the LAN address over https while remote access is on). */
export async function startAdminListener(opts: AdminListenerOptions): Promise<AdminListener> {
  const log = opts.log ?? (() => { /* silent */ });
  const loopback = opts.loopback ?? ['127.0.0.1', '::1'];
  let port = opts.port;
  let lanHosts: HostAllowlist | null = null;

  const makeHandler = (binding: 'admin-loopback' | 'admin-lan', secure: boolean) => (req: IncomingMessage, res: ServerResponse): void => {
    let ctx: AdminRequestContext | AdminRefusal;
    try {
      ctx = adminListenerContext(req, { port, binding, secure, lanHosts, policy: opts.policy(), trustProxy: opts.trustProxy });
    } catch (e) {
      log(`[admin] request check failed: ${(e as Error)?.message ?? e}`);
      refuse(res, req, 500, 'Server error');
      return;
    }
    if (isRefusal(ctx)) {
      refuse(res, req, ctx.refuse[0], ctx.refuse[1]);
      if (opts.onRefuse) {
        try { opts.onRefuse(req, ctx.refuse[0], ctx.refuse[1], sessionAddress(req.socket?.remoteAddress)); } catch (e) {
          log(`[admin] could not note a refused request: ${(e as Error)?.message ?? e}`);
        }
      }
      return;
    }
    Promise.resolve()
      .then(() => opts.handle(req, res, ctx as AdminRequestContext))
      .catch((e: unknown) => {
        log(`[admin] ${(req.url ?? '').split('?')[0]} failed: ${(e as Error)?.stack ?? e}`);
        if (!res.headersSent) refuse(res, req, 500, 'Server error');
        else res.end();
      });
  };

  const prepare = <S extends HttpServer | HttpsServer>(server: S, binding: 'admin-loopback' | 'admin-lan'): S => {
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = 5000;
    server.maxConnections = MAX_ADMIN_CONNECTIONS;
    server.on(binding === 'admin-lan' ? 'secureConnection' : 'connection', (s: Socket) => tagSocket(s, binding));
    if (binding === 'admin-lan') server.on('connection', (s: Socket) => tagSocket(s, binding));
    // No WebSocket (or any other) upgrade on the admin listener.
    server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    server.on('clientError', (e: NodeJS.ErrnoException, socket: Socket) => {
      // As Node's own handler: answer only a real parse error on a socket that has sent nothing yet. A reset, a
      // timeout, or a kept-alive socket that already carried answers (a browser's preconnect or reused socket) is
      // just closed: a stray 400 there reached the NEXT request's fetch as its answer (seen in Chromium).
      const code = e?.code ?? '';
      const quiet = code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_HTTP_REQUEST_TIMEOUT' || code === 'ERR_HTTP_REQUEST_TIMEOUT_EXCEEDED';
      if (!quiet && socket.writable && socket.bytesWritten === 0) {
        const status = code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } else socket.destroy();
    });
    return server;
  };

  // Loopback: 127.0.0.1 first (it fixes the port when opts.port is 0), then ::1 on the same port.
  const loopServers: { server: HttpServer; address: string }[] = [];
  const bindLoopback = async (): Promise<void> => {
    for (const address of loopback) {
      const server = prepare(createHttpServer(makeHandler('admin-loopback', false)), 'admin-loopback');
      try {
        const got = await listen(server, port, address);
        if (!port) port = got;
        loopServers.push({ server, address });
      } catch (e) {
        const code = errCode(e);
        if (isIP(address) === 6 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EINVAL')) {
          log(`[admin] this PC has no IPv6 loopback (${code}): the control panel listens on 127.0.0.1 only`);
          continue;
        }
        throw new AdminListenError(code, address, port, code === 'EADDRINUSE'
          ? `The control panel port ${port} is already in use on ${address}: another program is using it. Stop it, or change the port in Settings.`
          : `Could not open the control panel port ${port} on ${address}: ${(e as Error)?.message ?? e}`);
      }
    }
    if (!loopServers.length) throw new AdminListenError('ELISTEN', loopback.join(', '), port, `Could not open the control panel port ${port} on this PC.`);
  };

  const ephemeral = !opts.port;
  for (let attempt = 0; ; attempt++) {
    try { await bindLoopback(); break; } catch (e) {
      await Promise.all(loopServers.splice(0).map((l) => closeServer(l.server)));
      // With an ephemeral port, [::1] may already hold the port 127.0.0.1 got: try another one.
      if (ephemeral && e instanceof AdminListenError && e.code === 'EADDRINUSE' && attempt < 5) { port = 0; continue; }
      throw e;
    }
  }

  let lanServer: { server: HttpServer | HttpsServer; address: string; secure: boolean } | null = null;
  const setLan = async (lan: AdminLanBinding | null): Promise<void> => {
    if (lanServer) {
      const old = lanServer;
      lanServer = null;
      await closeServer(old.server);
    }
    lanHosts = null;
    if (!lan) return;
    lanHosts = adminLanHosts(port, { primary: lan.address, names: lan.names });
    const secure = !!lan.tls;
    const server = secure
      ? prepare(createHttpsServer({ ...lan.tls, handshakeTimeout: 10_000 } as SecureContextOptions & { handshakeTimeout: number }, makeHandler('admin-lan', true)), 'admin-lan')
      : prepare(createHttpServer(makeHandler('admin-lan', false)), 'admin-lan');
    try {
      await listen(server, port, lan.address);
      lanServer = { server, address: lan.address, secure };
      log(`[admin] control panel also on ${secure ? 'https' : 'http'}://${lan.address}:${port} (remote access)`);
    } catch (e) {
      lanHosts = null;
      log(`[admin] could not open the control panel on ${lan.address}:${port} (${errCode(e)}): remote access is unavailable`);
    }
  };
  await setLan(opts.lan ?? null);

  return {
    get port() { return port; },
    bound: () => [
      ...loopServers.map((l) => ({ address: l.address, port, binding: 'admin-loopback' as const, secure: false })),
      ...(lanServer ? [{ address: lanServer.address, port, binding: 'admin-lan' as const, secure: lanServer.secure }] : []),
    ],
    setLan,
    setSecureContext(tls) {
      if (lanServer && lanServer.secure) (lanServer.server as HttpsServer).setSecureContext(tls);
    },
    async close() {
      const all = [...loopServers.splice(0).map((l) => l.server), ...(lanServer ? [lanServer.server] : [])];
      lanServer = null;
      await Promise.all(all.map(closeServer));
    },
  };
}
