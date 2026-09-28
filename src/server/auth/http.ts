// OWNER: AUTH agent. Small HTTP helpers for the /api/* JSON endpoints (body limit, CORS, client IP).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

export const MAX_BODY_BYTES = 8 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

/** Read + parse a JSON object body (≤ MAX_BODY_BYTES). Throws HttpError 413 / 400 / 415. */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ctype.startsWith('application/json')) {
    return Promise.reject(new HttpError(415, 'Content-Type must be application/json'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume(); // drain; the response carries Connection: close
    return Promise.reject(new HttpError(413, 'Request body too large', { Connection: 'close' }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: HttpError): void => { if (!done) { done = true; reject(e); } };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        fail(new HttpError(413, 'Request body too large', { Connection: 'close' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, 'Invalid request'));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
    req.on('error', () => fail(new HttpError(400, 'Invalid request')));
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) { res.end(); return; }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

/**
 * Rate-limit key for the client. With `trustProxy`, uses the address our (single, trusted) reverse
 * proxy appended — the LAST X-Forwarded-For entry, i.e. one hop in front of us (Express
 * `trust proxy = 1` semantics). Earlier entries are client-controlled and ignored.
 * The result is an IPv4 address or an IPv6 /64 prefix (see rateLimitKey).
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    if (raw) {
      const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return rateLimitKey(last);
    }
  }
  return rateLimitKey(req.socket.remoteAddress ?? 'unknown');
}

/**
 * Normalize an address into the unit rate limits are counted against:
 * - IPv4 (incl. `a.b.c.d:port` and IPv4-mapped IPv6 `::ffff:a.b.c.d` / `::ffff:0102:0304`) → `a.b.c.d`
 * - IPv6 (incl. `[addr]:port` and `%zone`) → its /64 prefix, e.g. `2001:db8:1:2::/64`. One subscriber
 *   (a home line, a VPS) usually gets a whole /64, so keying by the full address would let a single
 *   host rotate through 2^64 source addresses and never hit a limit.
 * - anything else → lowercased and truncated (still a stable key, e.g. 'unknown').
 */
export function rateLimitKey(raw: string): string {
  let s = String(raw).trim().toLowerCase().slice(0, 100);
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1]!;
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4port) s = v4port[1]!;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind === 6) {
    const h = expandIpv6(s);
    if (h) {
      if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
        return `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
      }
      return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
    }
  }
  return s.slice(0, 64);
}

/** A valid (isIP === 6, zone stripped) IPv6 address → its 8 hextets, or null. */
function expandIpv6(s: string): number[] | null {
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toHextets = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) { // embedded IPv4 (last group only, guaranteed by isIP)
        const o = g.split('.').map(Number);
        if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
        out.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
      } else {
        const v = parseInt(g, 16);
        if (!/^[0-9a-f]{1,4}$/.test(g) || !Number.isFinite(v)) return null;
        out.push(v);
      }
    }
    return out;
  };
  const head = toHextets(halves[0]!);
  const tail = halves.length === 2 ? toHextets(halves[1]!) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * Is this Origin allowed to call the API? No Origin (curl, server-to-server) → yes.
 * Same-origin (Origin host == Host header) → yes, so a client served by this very server works.
 */
export function originAllowed(origin: string | undefined, allowed: string[] | '*', req: IncomingMessage): boolean {
  if (!origin) return true;
  if (allowed === '*') return true;
  if (allowed.includes(origin)) return true;
  const host = req.headers.host;
  if (host) {
    try {
      if (new URL(origin).host === host.toLowerCase()) return true;
    } catch { /* malformed Origin → not allowed */ }
  }
  return false;
}

export function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
