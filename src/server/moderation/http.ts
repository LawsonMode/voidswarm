// OWNER: SERVER MODERATION. The admin HTTP API under /api/admin/* (contract: ./adminApi.md) and the dashboard's static
// files under /admin (./admin/*, written by the ADMIN builder). Same rules as the accounts API: POST + JSON only,
// 8 KB bodies, the CORS allowlist, per-address rate limits; plus a Bearer session token whose account must be a
// moderator. Every call is audited in mod_actions.
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountInfo } from '../../shared/protocol';
import { clientIp, corsHeaders, HttpError, originAllowed, readJsonBody, sendJson } from '../auth/http';
import { SlidingWindowLimiter } from '../auth/ratelimit';
import { parseDuration, parseSince } from './durations';
import type { Actor, ModerationService, Target } from './service';
import { CHAT_ACTIONS, REPORT_STATUSES, type BanKind, type BanScope, type LogQuery, type ReportStatus } from './store';

export interface AdminHttpOptions {
  /** null = moderation is unavailable (every call answers 503). */
  service: ModerationService | null;
  /** AuthService.verifyToken (null = accounts disabled). */
  verifyToken: ((token: string) => Promise<AccountInfo | null>) | null;
  corsOrigins: string[] | '*';
  /** TRUST_PROXY: key rate limits by the proxy-appended X-Forwarded-For hop (the server strips it from untrusted peers). */
  trustProxy: boolean;
  log: (line: string) => void;
  now?: () => number;
  /**
   * [max, windowMs]: calls per moderator account (default 240 / min) and failed authorizations per address
   * (default 20 / 10 min; beyond it, further unauthorized calls get 429 — a valid moderator token is never blocked).
   */
  limits?: { calls?: [number, number]; authFailures?: [number, number] };
}

type Body = Record<string, unknown>;
type Handler = (b: Body, actor: Actor, svc: ModerationService) => [number, unknown];

const ERR = {
  notLoggedIn: 'Not logged in',
  notAdmin: 'Not a moderator',
  unavailable: 'Moderation is not available on this server.',
  rateLimited: 'Too many requests — try again later',
  notFound: 'Not found',
  noPlayer: 'No such player',
} as const;

const TOKEN_HDR_RE = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,200})$/;

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const bad = (msg: string): HttpError => new HttpError(400, msg);

/** `target` (name) | `accountId` | `playerId` → a Target, or throws 400 / 404. */
function targetOf(b: Body, svc: ModerationService, required = true): Target | null {
  const pid = int(b.playerId);
  if (pid !== undefined) {
    const t = svc.targetByPlayerId(pid);
    if (!t) throw new HttpError(404, ERR.noPlayer);
    return t;
  }
  const acc = str(b.accountId, 64);
  if (acc) {
    const t = svc.targetByAccountId(acc);
    if (!t) throw new HttpError(404, ERR.noPlayer);
    return t;
  }
  const name = str(b.target, 64);
  if (name) {
    const t = svc.resolveTarget(name);
    if (!t) throw new HttpError(404, ERR.noPlayer);
    return t;
  }
  if (required) throw bad('Say who: target, accountId or playerId');
  return null;
}

const routes: Record<string, Handler> = {
  me: (_b, actor) => [200, { ok: true, admin: { accountId: actor.accountId, username: actor.name } }],

  online: (_b, actor, svc) => {
    svc.auditRead(actor, 'api online');
    return [200, { ok: true, players: svc.online().map((p) => svc.describePilot(p)) }];
  },

  log: (b, actor, svc) => {
    const q: LogQuery = {};
    q.player = str(b.player, 64);
    q.accountId = str(b.accountId, 64);
    q.address = str(b.address, 64)?.toLowerCase();
    q.grep = str(b.grep, 100);
    q.roomId = str(b.roomId, 32);
    if (b.action !== undefined) {
      if (b.action !== 'flagged' && !(CHAT_ACTIONS as readonly unknown[]).includes(b.action)) throw bad('action must be pass, mask, block, spam, muted or flagged');
      q.action = b.action as LogQuery['action'];
    }
    if (b.since !== undefined) {
      q.since = parseSince(b.since, Date.now());
      if (q.since === undefined) throw bad('since must be epoch ms or a duration like 2h');
    }
    if (b.until !== undefined) { q.until = int(b.until); if (q.until === undefined) throw bad('until must be epoch ms'); }
    q.limit = int(b.limit) ?? 100;
    q.before = int(b.before);
    svc.flushAllQuiet();
    const out = svc.store.searchLog(q);
    const desc = ['player', 'accountId', 'address', 'grep', 'action', 'roomId', 'since'].filter((k) => b[k] !== undefined).map((k) => `${k}=${String(b[k]).slice(0, 40)}`).join(' ');
    svc.auditRead(actor, `api log ${desc}`.trim());
    return [200, { ok: true, ...out }];
  },

  reports: (b, actor, svc) => {
    const status = b.status === undefined ? 'open' : b.status;
    if (status !== 'all' && !(REPORT_STATUSES as readonly unknown[]).includes(status)) throw bad('status must be open, reviewed, dismissed or all');
    const out = svc.listReports(status as ReportStatus | 'all', Math.min(200, int(b.limit) ?? 50), int(b.before));
    svc.auditRead(actor, `api reports ${status}`);
    return [200, { ok: true, ...out }];
  },

  'reports/review': (b, actor, svc) => {
    const id = int(b.id);
    if (id === undefined) throw bad('id is required');
    if (!(REPORT_STATUSES as readonly unknown[]).includes(b.status)) throw bad('status must be reviewed, dismissed or open');
    if (b.note !== undefined && typeof b.note !== 'string') throw bad('note must be a string');
    const res = svc.reviewReport(actor, id, b.status as ReportStatus, str(b.note, 500) ?? null);
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, report: res.report }];
  },

  bans: (b, actor, svc) => {
    const kind = b.kind === undefined ? 'all' : b.kind;
    if (kind !== 'all' && kind !== 'ban' && kind !== 'mute') throw bad('kind must be ban, mute or all');
    const bans = svc.store.listBans({ kind: kind as BanKind | 'all', includeInactive: b.includeInactive === true, limit: int(b.limit) ?? 200 }, Date.now());
    svc.auditRead(actor, `api bans ${kind}${b.includeInactive === true ? ' all' : ''}`);
    return [200, { ok: true, bans }];
  },

  'bans/create': (b, actor, svc) => {
    if (b.kind !== 'ban' && b.kind !== 'mute') throw bad('kind must be ban or mute');
    if (b.scope !== undefined && b.scope !== 'account' && b.scope !== 'address' && b.scope !== 'guest') throw bad('scope must be account, address or guest');
    const durationSec = parseDuration(b.duration);
    if (durationSec === undefined) throw bad('duration must be like 10m, 2h, 1d, 7d, perm, or seconds');
    const reason = str(b.reason, 200);
    if (!reason) throw bad('reason is required (1-200 characters)');
    const target = targetOf(b, svc, false);
    const address = str(b.address, 64)?.toLowerCase();
    if (!target && !address) throw bad('Say who: target, accountId, playerId or address');
    const res = svc.createBan(actor, {
      kind: b.kind, target, address: target ? undefined : address, scope: b.scope as BanScope | undefined, durationSec, reason,
      confirm: b.confirm === true,
    });
    if (!res.ok) {
      if (res.needsConfirm) return [409, { error: res.error, needsConfirm: true, sharing: res.sharing ?? 0 }];
      throw new HttpError(res.status, res.error);
    }
    return [200, { ok: true, ban: res.ban, kicked: res.kicked }];
  },

  'bans/revoke': (b, actor, svc) => {
    const id = int(b.id);
    let res;
    if (id !== undefined) res = svc.revoke(actor, { id });
    else {
      if (b.kind !== 'ban' && b.kind !== 'mute') throw bad('Pass an id, or a target and kind (ban or mute)');
      const t = targetOf(b, svc);
      res = svc.revoke(actor, { target: t!, kind: b.kind });
    }
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, revoked: res.revoked }];
  },

  kick: (b, actor, svc) => {
    const t = targetOf(b, svc)!;
    const res = svc.kick(actor, t, str(b.reason, 200) ?? '');
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, kicked: res.kicked }];
  },

  warn: (b, actor, svc) => {
    const t = targetOf(b, svc)!;
    const res = svc.warnPilot(actor, t, str(b.reason, 200) ?? '');
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, warned: res.warned }];
  },

  whois: (b, actor, svc) => {
    const t = targetOf(b, svc)!;
    const whois = svc.whois(t);
    svc.auditRead(actor, `api whois ${t.name}`);
    return [200, { ok: true, whois }];
  },

  actions: (b, actor, svc) => {
    const t = b.target !== undefined || b.accountId !== undefined || b.playerId !== undefined ? targetOf(b, svc) : null;
    const out = svc.store.listActions({
      limit: int(b.limit) ?? 100, before: int(b.before),
      targetAccountId: t?.accountId ?? null, targetName: t && !t.accountId ? t.name : null, targetAddress: t && !t.accountId ? t.address : null,
    });
    svc.auditRead(actor, `api actions${t ? ` ${t.name}` : ''}`);
    return [200, { ok: true, ...out }];
  },
};

/** Paths the admin API answers (tests / docs). */
export const ADMIN_ENDPOINTS: readonly string[] = Object.keys(routes);

export interface AdminHttp {
  /** Handle /api/admin/* (incl. CORS preflight). Returns true if the request was handled. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createAdminHttp(opts: AdminHttpOptions): AdminHttp {
  const now = opts.now ?? Date.now;
  const [callMax, callWin] = opts.limits?.calls ?? [240, 60_000];
  const [failMax, failWin] = opts.limits?.authFailures ?? [20, 10 * 60_000];
  const calls = new SlidingWindowLimiter(callMax, callWin, now);
  const fails = new SlidingWindowLimiter(failMax, failWin, now);
  const sweep = setInterval(() => { calls.sweep(); fails.sweep(); }, 10 * 60_000);
  sweep.unref?.();

  const limited = (waitMs: number): HttpError => new HttpError(429, ERR.rateLimited, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });

  return {
    async handle(req, res) {
      const urlPath = (req.url ?? '').split('?')[0] ?? '';
      if (urlPath !== '/api/admin' && !urlPath.startsWith('/api/admin/')) return false;
      const originHeader = req.headers.origin;
      const origin = typeof originHeader === 'string' ? originHeader : undefined;
      const allowed = originAllowed(origin, opts.corsOrigins, req);
      const cors = allowed ? corsHeaders(origin) : { Vary: 'Origin' };
      try {
        if (req.method === 'OPTIONS') {
          req.resume();
          if (!allowed) { sendJson(res, 403, { error: 'Origin not allowed' }, cors); return true; }
          res.writeHead(204, {
            ...cors,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '600',
            'Cache-Control': 'no-store',
            'Content-Length': '0',
          });
          res.end();
          return true;
        }
        if (req.method !== 'POST') {
          req.resume();
          sendJson(res, 405, { error: 'Method not allowed' }, { ...cors, Allow: 'POST, OPTIONS' });
          return true;
        }
        if (!allowed) { req.resume(); sendJson(res, 403, { error: 'Origin not allowed' }, cors); return true; }
        const ip = clientIp(req, opts.trustProxy);
        const name = urlPath.slice('/api/admin/'.length);
        const handler = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : undefined;
        if (!handler) { req.resume(); throw new HttpError(404, ERR.notFound); }
        const svc = opts.service;
        if (!svc || !opts.verifyToken) { req.resume(); throw new HttpError(503, ERR.unavailable); }
        // Authorization before the body is read: an unauthorized caller costs no parsing. The failure limit is per
        // address but only ever blocks UNauthorized calls, and the call limit is per moderator account: a classroom
        // shares one address, so students hammering the API must not be able to lock the teacher out of it.
        const m = TOKEN_HDR_RE.exec(String(req.headers.authorization ?? '').trim());
        const account = m ? await opts.verifyToken(m[1]!) : null;
        const isMod = !!account && svc.isAdminAccount(account.accountId);
        if (!account || !isMod) {
          req.resume();
          const wait = fails.take(ip);
          if (wait > 0) throw limited(wait);
          if (!account) throw new HttpError(401, ERR.notLoggedIn);
          opts.log(`[mod] admin API refused for ${account.username} (not a moderator)`);
          throw new HttpError(403, ERR.notAdmin);
        }
        const callWait = calls.take(`a:${account.accountId}`);
        if (callWait > 0) { req.resume(); throw limited(callWait); }
        const body = await readJsonBody(req);
        const actor: Actor = { accountId: account.accountId, name: account.username };
        const [status, out] = handler(body, actor, svc);
        sendJson(res, status, out, cors);
      } catch (e) {
        if (e instanceof HttpError) sendJson(res, e.status, { error: e.message }, { ...cors, ...e.headers });
        else {
          opts.log(`[mod] ${urlPath} failed: ${(e as Error)?.stack ?? e}`);
          sendJson(res, 500, { error: 'Server error' }, cors);
        }
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Dashboard files (/admin)
// ---------------------------------------------------------------------------------------------

/** Where the dashboard's files live (the ADMIN builder's folder). */
export const ADMIN_PAGE_DIR = fileURLToPath(new URL('./admin/', import.meta.url));

const PAGE_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/**
 * The dashboard's Content-Security-Policy: same-origin files only, no inline script or style (the page has none:
 * admin.test.ts checks), not frameable. Served only by this Node server — the Vite / GitHub Pages client build never
 * contains /admin (vite root is src/client).
 */
export const ADMIN_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * GET /admin, /admin/ → admin.html; /admin/<file> → that file of `dir` (flat: no sub-folders, whitelisted types).
 * Returns false for any other path.
 */
export function serveAdminPage(req: IncomingMessage, res: ServerResponse, dir = ADMIN_PAGE_DIR): boolean {
  const urlPath = (req.url ?? '').split('?')[0] ?? '';
  if (urlPath !== '/admin' && !urlPath.startsWith('/admin/')) return false;
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': ADMIN_PAGE_CSP,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end(); return true; }
  let file = urlPath === '/admin' || urlPath === '/admin/' ? 'admin.html' : urlPath.slice('/admin/'.length);
  try { file = decodeURIComponent(file); } catch { res.writeHead(400, headers).end(); return true; }
  const type = PAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file) || file.includes('..')) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return true;
  }
  const full = path.join(dir, file);
  let body: Buffer;
  try {
    if (!statSync(full).isFile()) throw new Error('not a file');
    body = readFileSync(full);
  } catch {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': String(body.length) });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
