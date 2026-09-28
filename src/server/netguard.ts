// OWNER: ROOM agent. Network guards used by server/index.ts: client address keys + trusted-proxy handling,
// connection caps, the default CORS allowlist, live-session tracking for revocation, snapshot event
// carry-over under backpressure, and a broadcast serialization cache. No side effects on import (unit-tested).
import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { GLOBAL_EVENT_TYPES, type GameEvent, type Snapshot } from '../shared/types';

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

function ipv6Hextets(s: string): number[] | null {
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (p: string): number[] | null => {
    if (!p) return [];
    const out: number[] = [];
    for (const g of p.split(':')) {
      if (g.includes('.')) {
        const o = g.split('.').map(Number);
        if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * Normalize a socket / forwarded address into the unit connection limits count against:
 * IPv4 (also `a.b.c.d:port` and IPv4-mapped IPv6) → `a.b.c.d`; IPv6 → its /64 (one subscriber usually
 * owns a whole /64); anything else → lowercased, truncated.
 */
export function addressKey(raw: string | null | undefined): string {
  let s = String(raw ?? 'unknown').trim().toLowerCase().slice(0, 100);
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (br) s = br[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4port) s = v4port[1];
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind === 6) {
    const h = ipv6Hextets(s);
    if (h) {
      if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
      return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
    }
  }
  return s.slice(0, 64) || 'unknown';
}

/** Loopback or private IPv4 (127/8, 10/8, 172.16/12, 192.168/16), IPv6 ::1, ULA (fc00::/7) or link-local (fe80::/10). */
export function isLocalNetworkAddress(raw: string | null | undefined): boolean {
  let s = String(raw ?? '').trim().toLowerCase();
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (br) s = br[1];
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let v4 = isIP(s) === 4 ? s : null;
  if (!v4 && isIP(s) === 6) {
    const h = ipv6Hextets(s);
    if (!h) return false;
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) v4 = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
    else {
      if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
      return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80;
    }
  }
  if (!v4) return false;
  const [a, b] = v4.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface ProxyTrust {
  /** TRUST_PROXY=1: honour X-Forwarded-For from trusted peers. */
  enabled: boolean;
  /** Extra peer addresses to trust (TRUSTED_PROXIES), normalized with addressKey. */
  extra: readonly string[];
}

export function parseProxyTrust(env: NodeJS.ProcessEnv): ProxyTrust {
  const enabled = env.TRUST_PROXY === '1' || env.TRUST_PROXY?.toLowerCase() === 'true';
  const extra = (env.TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(addressKey);
  return { enabled, extra };
}

/**
 * Is the TCP peer a reverse proxy whose X-Forwarded-For we may believe? Only with TRUST_PROXY on, and
 * only for peers on loopback / the local network or listed in TRUSTED_PROXIES. A client that reaches
 * the game port directly from the internet can then no longer pick its own address with a forged header.
 */
export function isTrustedProxyPeer(remote: string | null | undefined, trust: ProxyTrust): boolean {
  if (!trust.enabled) return false;
  return isLocalNetworkAddress(remote) || trust.extra.includes(addressKey(remote));
}

/** The address our proxy appended: the LAST X-Forwarded-For hop (earlier hops are client-controlled). */
export function lastForwardedHop(xff: string | string[] | undefined): string | null {
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (!raw) return null;
  const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}

/** Rate-limit key of a request's client (socket address, or the proxy-appended hop from a trusted proxy). */
export function clientAddressKey(remote: string | null | undefined, xff: string | string[] | undefined, trust: ProxyTrust): string {
  if (isTrustedProxyPeer(remote, trust)) {
    const hop = lastForwardedHop(xff);
    if (hop) return addressKey(hop);
  }
  return addressKey(remote);
}

// ---------------------------------------------------------------------------------------------
// Connection caps
// ---------------------------------------------------------------------------------------------

export interface GateLimits {
  /** Concurrent WebSocket connections, all clients. */
  maxTotal: number;
  /** Concurrent connections per client address. */
  maxPerAddress: number;
  /** New connections per address: burst, then refill per second. */
  burst: number;
  perSec: number;
}

/** Concurrent + rate caps on WebSocket connections, per client address and in total. */
export class ConnectionGate {
  private total = 0;
  private open = new Map<string, number>();
  private rate = new Map<string, { tokens: number; at: number }>();

  constructor(readonly limits: GateLimits) {}

  /** Admit a new connection from `key`: null = admitted (call release() when it closes), else the refusal. */
  tryAcquire(key: string, now: number): string | null {
    const l = this.limits;
    if (this.total >= l.maxTotal) return 'Server is full — try again later';
    if ((this.open.get(key) ?? 0) >= l.maxPerAddress) return 'Too many connections from your network';
    let b = this.rate.get(key);
    if (!b) { b = { tokens: l.burst, at: now }; this.rate.set(key, b); }
    b.tokens = Math.min(l.burst, b.tokens + (Math.max(0, now - b.at) / 1000) * l.perSec);
    b.at = Math.max(b.at, now);
    if (b.tokens < 1) return 'Connecting too fast — try again in a moment';
    b.tokens -= 1;
    this.total++;
    this.open.set(key, (this.open.get(key) ?? 0) + 1);
    if (this.rate.size > 10000) this.pruneRate(now);
    return null;
  }

  release(key: string): void {
    const n = this.open.get(key) ?? 0;
    if (n <= 0) return;
    this.total = Math.max(0, this.total - 1);
    if (n === 1) this.open.delete(key); else this.open.set(key, n - 1);
  }

  get connections(): number { return this.total; }
  openFor(key: string): number { return this.open.get(key) ?? 0; }

  /** Forget rate buckets that have refilled completely (bounded memory under address churn). */
  private pruneRate(now: number): void {
    const l = this.limits;
    for (const [k, b] of this.rate) {
      if (b.tokens + (Math.max(0, now - b.at) / 1000) * l.perSec >= l.burst) this.rate.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------------------------

/** Dev client ports whose origins are allowed by default: vite dev and vite preview. */
export const DEV_CLIENT_PORTS: readonly number[] = [5173, 4173];

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

/**
 * Allowlist used when CORS_ORIGINS is unset: PUBLIC_URL's origin plus the dev client (vite on 5173 /
 * preview on 4173) served from this machine — localhost, 127.0.0.1, [::1], its LAN IPv4 addresses and
 * its host name (plain and `.local`). Same-origin requests (a client served by this server) are always
 * allowed by the auth service itself. Any other website's Origin is refused. CORS_ORIGINS='*' restores
 * allow-all explicitly.
 */
export function defaultCorsOrigins(
  publicUrl: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  hostNames: readonly string[] = [],
  ports: readonly number[] = DEV_CLIENT_PORTS,
): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) hosts.add(i.address);
  }
  for (const raw of hostNames) {
    const h = raw.trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h)) continue;
    hosts.add(h);
    if (!h.includes('.')) hosts.add(`${h}.local`);
  }
  const out = new Set<string>();
  const pub = originOf(publicUrl);
  if (pub) out.add(pub);
  for (const h of hosts) for (const p of ports) out.add(`http://${h}:${p}`);
  return [...out];
}

/** CORS_ORIGINS env → the auth service's allowlist ('*' only when set to '*' explicitly). */
export function resolveCorsOrigins(env: string | undefined, fallback: () => string[]): string[] | '*' {
  const v = env?.trim();
  if (!v) return fallback();
  if (v === '*') return '*';
  return v.split(',').map((o) => o.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Live sessions (for revocation)
// ---------------------------------------------------------------------------------------------

/** Live connections authenticated with a session token, by account and token hash (sha256 hex). */
export class SessionRegistry<H> {
  private byAccount = new Map<string, Set<{ hash: string; handle: H }>>();

  /** Track a live connection; returns the function that forgets it (call on disconnect). */
  add(accountId: string, tokenHash: string, handle: H): () => void {
    let set = this.byAccount.get(accountId);
    if (!set) { set = new Set(); this.byAccount.set(accountId, set); }
    const entry = { hash: tokenHash, handle };
    set.add(entry);
    return () => {
      const s = this.byAccount.get(accountId);
      if (!s) return;
      s.delete(entry);
      if (!s.size) this.byAccount.delete(accountId);
    };
  }

  /** Connections using a revoked session: that one session (hash) or all of the account's (null). They are forgotten. */
  revoke(accountId: string, tokenHash: string | null): H[] {
    const set = this.byAccount.get(accountId);
    if (!set) return [];
    const out: H[] = [];
    for (const e of [...set]) {
      if (tokenHash !== null && e.hash !== tokenHash) continue;
      out.push(e.handle);
      set.delete(e);
    }
    if (!set.size) this.byAccount.delete(accountId);
    return out;
  }

  count(accountId: string): number { return this.byAccount.get(accountId)?.size ?? 0; }
}

// ---------------------------------------------------------------------------------------------
// Snapshot events under backpressure
// ---------------------------------------------------------------------------------------------

/** Undelivered global events kept per connection (beyond this the oldest are dropped). */
export const MAX_CARRIED_EVENTS = 256;

/**
 * Snapshots carry events only as a delta, so a snapshot dropped for backpressure would lose its
 * kill-feed / level-up / wave / matchEnd events for good. hold() keeps the dropped snapshot's GLOBAL
 * events; merge() prepends them to the next snapshot that actually goes out. Positional FX are stale
 * by then and are not kept.
 */
export class EventCarry {
  private held: GameEvent[] = [];

  hold(s: Snapshot): void {
    for (const e of s.events) if (GLOBAL_EVENT_TYPES.has(e.t)) this.held.push(e);
    if (this.held.length > MAX_CARRIED_EVENTS) this.held.splice(0, this.held.length - MAX_CARRIED_EVENTS);
  }

  /** `s` with any held events in front (a new object; `s` itself is not modified). */
  merge(s: Snapshot): Snapshot {
    if (!this.held.length) return s;
    const events = this.held.concat(s.events);
    this.held = [];
    return { ...s, events };
  }

  /** Forget held events (a new match started: they belong to the previous one). */
  reset(): void { this.held = []; }

  get size(): number { return this.held.length; }
}

// ---------------------------------------------------------------------------------------------
// Broadcast serialization
// ---------------------------------------------------------------------------------------------

/**
 * JSON text frame (UTF-8 Buffer) with a one-entry identity cache: a zone broadcast hands the same
 * message object to every recipient in a row, so it is serialized once instead of once per recipient.
 * Safe because the zone never mutates a message after sending it (see ClientSink).
 */
export function createFrameCache(): (m: object) => Buffer {
  let last: object | null = null;
  let frame = Buffer.alloc(0);
  return (m) => {
    if (m !== last) { frame = Buffer.from(JSON.stringify(m), 'utf8'); last = m; }
    return frame;
  };
}

/** Error sent to live connections whose session was revoked (logout elsewhere / password reset). */
export const SESSION_ENDED_MSG = 'Session ended — please log in again';
