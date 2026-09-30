// OWNER: SERVER MODERATION. The admin HTTP API under /api/admin/* (contract: ./adminApi.md, docs/LAN-EDITION-proposal.md
// §5.15) and the panel's static files.
//
// LAN edition (`hostAdmin` set): the host admin credential and admin sessions (./hostAdmin.ts), one capability table
// (./capabilities.ts), and per-route rules. Each route declares `{ cap, sensitive?, hostPcOnly?, bodyLimit, file? }`:
//  - Auth: `Authorization: Bearer <admin session>`; game tokens are never accepted. Only setup/status, setup, login
//    and display/state need no token.
//  - Place: POST only; `Content-Type: application/json` (415); an Origin equal to the listener's own origin (403;
//    the admin API never uses CORS); host-PC-only routes need isHostPc (403 `Host PC only`).
//  - can(): 403 `Not allowed for your role`; a ★ route with a stale session: 401 `reauth`.
//  - Bodies: 8 KB, imports 512 KB. Handlers are async (long-polls, the worker).
//  - Activity: every call is authenticated as a poll; it counts (idle timeout, step-up freshness) only once it passed
//    its checks and the handler did not answer 401 / 403 (HostAdmin.activity).
//  - Targets: a `target` that is a network address needs `addresses` on every route (a network ban or mute also
//    `ban`); a kick or warn never reaches the host PC's own connection, nor, below the host, a moderator.
//  - Moderator scrubbing: moderator sessions never receive an address (they get an address tag), an email, original
//    text, hit labels, the reporter (limited tier) or a SELF-HARM row. Original text and hit labels reach anyone only
//    from the reveal routes. A host session without `wellbeing` (remote `limited`) gets SELF-HARM rows nameless on
//    the feeds, and none at all on a route about one person (`aboutPerson`: log, reports, whois, …).
//  - The Chat log: rows a caller may not see are left out BEFORE paging, so `nextBefore` never names one; without
//    `reveal` a search matches the shown text only and never reaches the SQL (visibleLogPage).
// Endpoints other modules implement (Live, the log worker, rooms, accounts, conduct, custom terms, backups, TLS, …)
// are declared here with their access rules and plugged in through `handlers`; until then they answer 501.
//
// Legacy mode (no `hostAdmin`): the v0.4/v0.5 behaviour, moderator accounts with their game token and the CORS list.
// It stays only until the server wires the host admin (src/server/app.ts).
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountInfo } from '../../shared/protocol';
import { TAG_SELF_HARM, tagsOf } from '../../shared/room/moderation';
import { clientIp, corsHeaders, HttpError, originAllowed, readJsonBody, sendJson } from '../auth/http';
import { SlidingWindowLimiter } from '../auth/ratelimit';
import {
  isLoopbackAddressKey, isRefusal, mainPortAdminContext, sessionAddress, startAdminListener, type AdminLanBinding, type AdminListener,
  type AdminRefusal, type AdminRequestContext,
} from '../listeners';
import type { ProxyTrust } from '../netguard';
import { networkApproveReply, settingsGetReply, settingsUpdateReply } from '../settings/api';
import type { SettingsService } from '../settings/service';
import {
  ASK_THE_HOST, NOT_ON_A_MODERATOR, can, isSensitive, mayLift, mayMute, type CanContext, type Capability, type Principal,
} from './capabilities';
import { parseDuration, parseSince } from './durations';
import {
  ADMIN_ERR, DEFAULT_ADMIN_POLICY, HOST_ACTOR_ID, HostAdmin, adminPolicyOf, type AdminPolicy, type AdminSession, type AdminState, type SetupChoices,
} from './hostAdmin';
import { isAddressTarget, type Actor, type ModerationService, type Target } from './service';
import {
  CHAT_ACTIONS, REPORT_STATUSES, type BanKind, type BanRow, type BanScope, type ChatLogRow, type LogQuery, type ModStore, type ReportStatus,
} from './store';

// ------------------------------------------------------------------------------------------
// Route table (§5.15)
// ------------------------------------------------------------------------------------------

export const BODY_LIMIT = 8 * 1024;
export const IMPORT_BODY_LIMIT = 512 * 1024;

export interface RouteSpec {
  /** null: no capability (the session endpoints). */
  cap: Capability | null;
  /** 'none': no session (setup/status, setup, login, display/state). Default 'session'. */
  auth?: 'none' | 'session';
  /** ★ (default: the capability's own flag). */
  sensitive?: boolean;
  /** Only from the host PC (isHostPc). */
  hostPcOnly?: boolean;
  /** Default BODY_LIMIT. */
  bodyLimit?: number;
  /** Answers a file (Content-Disposition, X-Row-Count). */
  file?: boolean;
  /** A poll: it doesn't count as deliberate activity (idle timeout, step-up freshness). */
  passive?: boolean;
  /** The Live view's poll: with admin.liveKeepsAlive it keeps a host-PC session alive (at most 3 h). */
  keepAlive?: boolean;
  /** Original text and hit labels may be returned (to a principal with `reveal`). */
  reveals?: boolean;
  /**
   * The reply is about ONE person (a player / account filter, a target, a report about someone): a SELF-HARM row in it
   * would name the student even nameless, so a principal without `wellbeing` gets none at all (§5.4 "no name until
   * opened ★"; the nameless line stays for the feeds without a person filter: Live, alerts).
   */
  aboutPerson?: boolean;
}

const r = (cap: Capability | null, extra: Omit<RouteSpec, 'cap'> = {}): RouteSpec => ({ cap, ...extra });

/** Every §5.15 endpoint and its access rules. */
export const ADMIN_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  // Session, setup and step-up
  'setup/status': r(null, { auth: 'none', hostPcOnly: true, passive: true }),
  setup: r(null, { auth: 'none', hostPcOnly: true }),
  login: r(null, { auth: 'none' }),
  reauth: r(null, { passive: true }),
  logout: r(null, { passive: true }),
  // No capability, but HostAdmin.changePassword refuses a remote `limited` (click-through) session: a captured one
  // must not be able to lock the host out (§4.10).
  password: r(null),
  me: r(null, { passive: true }),
  // Home, display, alerts and checks
  home: r('status.counts', { passive: true }),
  'display/state': r(null, { auth: 'none', hostPcOnly: true, passive: true }),
  // §5.15 "status": host principals only (moderators get no threat alerts in the panel; §5.2 "in game: name only").
  'alerts/list': r('status', { passive: true }),
  'alerts/ack': r('alerts.ack'),
  'wellbeing/open': r('wellbeing', { reveals: true }),
  'wellbeing/ack': r('wellbeing'),
  'checks/list': r('status', { passive: true }),
  'network/approve': r('settings', { hostPcOnly: true }),
  // Live, log and announcements
  'chat/live': r('live', { passive: true, keepAlive: true }),
  log: r('log', { aboutPerson: true }),
  'log/context': r('log', { aboutPerson: true }),
  'log/reveal': r('reveal', { reveals: true }),
  'log/rooms': r('log'),
  'log/stats': r('log.stats'),
  'log/export': r('log.export', { file: true, reveals: true }),
  'log/purge': r('log.purge'),
  announce: r('announce'),
  // Rooms
  'rooms/list': r('rooms.read', { passive: true }),
  'rooms/create': r('rooms.manage'),
  'rooms/close': r('rooms.manage'),
  'rooms/reset': r('rooms.manage'),
  // Accounts
  'accounts/list': r('accounts'),
  'accounts/get': r('accounts', { aboutPerson: true }),
  'accounts/findEmail': r('accounts'),
  'accounts/resetCode': r('accounts'),
  'accounts/unlock': r('accounts'),
  'accounts/approve': r('accounts'),
  'accounts/reject': r('accounts'),
  'accounts/disable': r('accounts'),
  'accounts/setModerator': r('accounts'),
  'accounts/delete': r('accounts.delete'),
  'accounts/export': r('accounts.export', { file: true }),
  'accounts/signOutEverywhere': r('accounts'),
  'accounts/roster/import': r('accounts', { bodyLimit: IMPORT_BODY_LIMIT }),
  'accounts/roster/slips': r('accounts'),
  // Conduct ★
  'conduct/summary': r('conduct'),
  'conduct/student': r('conduct'),
  'conduct/review': r('conduct'),
  'conduct/export': r('conduct', { file: true, reveals: true }),
  // Custom terms ★
  'customTerms/list': r('terms'),
  'customTerms/add': r('terms'),
  'customTerms/update': r('terms'),
  'customTerms/remove': r('terms'),
  'customTerms/import': r('terms', { bodyLimit: IMPORT_BODY_LIMIT }),
  'customTerms/export': r('terms', { file: true }),
  'customTerms/test': r('terms'),
  'customTerms/confirm': r('terms'),
  // Settings, server and backups
  'settings/get': r('settings'),
  'settings/update': r('settings'),
  'smtp/test': r('mail.test'),
  status: r('status.counts', { passive: true }),
  'backups/list': r('backups'),
  'backups/create': r('backups'),
  'backups/restore': r('backups.restore', { hostPcOnly: true }),
  // Additions to §5.15 (B5, maint/api.ts): the Restore… dialog's Cancel, and §5.16's Compact database (★, host PC).
  'backups/cancelRestore': r('backups.restore', { hostPcOnly: true }),
  'recovery/create': r('recovery', { hostPcOnly: true }),
  'backups/copyNow': r('backups'),
  'db/compact': r('compact', { hostPcOnly: true }),
  'cert/status': r('status'),
  'cert/renewLeaf': r('cert.renew'),
  'cert/new': r('cert.new', { hostPcOnly: true }),
  'cert/own': r('cert.own', { hostPcOnly: true, bodyLimit: IMPORT_BODY_LIMIT }),
  'server/openFolder': r('folders.open', { hostPcOnly: true }),
  shutdown: r('stop', { hostPcOnly: true }),
  // Unchanged endpoints, now behind can()
  online: r('rooms.read', { passive: true }),
  // A report's saved lines are the reported player's own (service.fileReport: chatOf(target, 20)).
  reports: r('reports', { aboutPerson: true }),
  'reports/review': r('reports', { aboutPerson: true }),
  bans: r('moderate'),
  'bans/create': r('moderate'),
  'bans/revoke': r('moderate'),
  kick: r('moderate'),
  warn: r('moderate'),
  whois: r('whois', { aboutPerson: true }),
  actions: r('audit', { aboutPerson: true }),
});

/** Paths the admin API answers (the LAN edition's full list). */
export const ADMIN_ENDPOINTS: readonly string[] = Object.keys(ADMIN_ROUTES);

export const routeSensitive = (spec: RouteSpec): boolean => spec.sensitive ?? (spec.cap ? isSensitive(spec.cap) : false);

// ------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------

export const ERR = {
  notLoggedIn: 'Not logged in',
  notAdmin: 'Not a moderator',
  unavailable: 'Moderation is not available on this server.',
  rateLimited: 'Too many requests — try again later',
  notFound: 'Not found',
  noPlayer: 'No such player',
  hostPcOnly: 'Host PC only',
  role: 'Not allowed for your role',
  origin: 'Origin not allowed',
  notBuilt: 'Not available in this version yet',
} as const;

/** A file answer (exports): 200 with Content-Disposition and X-Row-Count. */
export interface AdminFileReply { file: { body: Buffer | string; filename: string; contentType: string; rows?: number } }
export type AdminReply = [number, unknown] | AdminFileReply;

export interface AdminRouteContext {
  /** null on the routes that need no session. */
  session: AdminSession | null;
  principal: Principal | null;
  /** The moderation Actor: `{ accountId: 'host', name }` for the host admin, the account for a moderator. */
  actor: Actor;
  caller: AdminRequestContext;
  req: IncomingMessage;
  canContext: CanContext;
  can(cap: Capability): boolean;
  /** Throws 403 `Not allowed for your role` (or `message`), or 401 `reauth` for a ★ capability on a stale session. */
  require(cap: Capability, message?: string): void;
  service: ModerationService | null;
  settings: SettingsService | null;
  hostAdmin: HostAdmin;
  /** Aborted when the client goes away (long-polls free their waiter). */
  signal: AbortSignal;
  /** The API's clock (AdminHttpOptions.now). */
  now(): number;
}

export type AdminRouteHandler = (body: Record<string, unknown>, ctx: AdminRouteContext) => AdminReply | Promise<AdminReply>;

export interface Banner { code: string; level: 'info' | 'warn' | 'urgent'; text: string }

export interface AdminHttpOptions {
  /** null = moderation is unavailable (its routes answer 503). */
  service: ModerationService | null;
  /** TRUST_PROXY: key rate limits by the proxy-appended X-Forwarded-For hop (the server strips it from untrusted peers). */
  trustProxy: boolean;
  log: (line: string) => void;
  now?: () => number;
  /**
   * [max, windowMs]: calls per session (LAN edition 600 / min; the sessions not on the host PC also share 2 × max per
   * principal) or per moderator account (legacy, 240 / min), and failed authorizations per address (default
   * 20 / 10 min; beyond it further unauthorized calls get 429).
   */
  limits?: { calls?: [number, number]; authFailures?: [number, number] };

  // --- LAN edition ---
  /** The host admin credential and sessions. Set = the LAN-edition API (game tokens refused, no CORS). */
  hostAdmin?: HostAdmin | null;
  /** The settings service (settings/*, network/approve, setup's preset, the admin policy). */
  settings?: SettingsService | null;
  /** The admin policy (default: from `settings`, else the defaults). */
  policy?: () => AdminPolicy;
  /** The main port's request context when handle() is called without one (default: mainPortAdminContext). */
  context?: (req: IncomingMessage) => AdminRequestContext | AdminRefusal;
  /** For mainPortAdminContext (TRUST_PROXY / TRUSTED_PROXIES). */
  proxyTrust?: ProxyTrust;
  /** Endpoints implemented by other modules (Live, the log worker, rooms, accounts, …). They win over built-ins. */
  handlers?: Readonly<Record<string, AdminRouteHandler>>;
  /** Extra banners for `me` (mail failing, chat not logged, low disk, …). */
  banners?: (s: AdminSession) => Banner[];
  /** The key for address tags (default: a random key per process). Pass the pepper for tags that survive restarts. */
  addressTagKey?: Uint8Array | string | null;

  // --- Legacy (v0.4/v0.5; only without hostAdmin) ---
  /** AuthService.verifyToken (null = accounts disabled). */
  verifyToken?: ((token: string) => Promise<AccountInfo | null>) | null;
  corsOrigins?: string[] | '*';
}

const TOKEN_HDR_RE = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,200})$/;

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const bad = (msg: string): HttpError => new HttpError(400, msg);

/** `target` (name) | `accountId` | `playerId` → a Target, or throws 400 / 404. */
function targetOf(b: Record<string, unknown>, svc: ModerationService, required = true): Target | null {
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

/**
 * A `target` that is a network address itself ("192.168.1.23": resolveTarget's last resort), not one pilot. It names
 * everyone on that network, so on any route it needs `addresses` (§5.2 "Network addresses": moderators `limited` none,
 * a remote `limited` host the tag only): without it the lookup alone would say who is at an address. true = it is one
 * (and the caller may use it).
 */
function addressTargetAllowed(t: Target | null, c: AdminRouteContext): boolean {
  if (!t || !isAddressTarget(t)) return false;
  c.require('addresses');
  return true;
}

/**
 * The pilots a kick or warn reaches (§5.2):
 *  - an address target needs `addresses`, and never selects the host PC's own connection (as address bans never
 *    match it);
 *  - "Nobody below the host can act on a moderator": without `moderators.act`, a target that is (or whose connections
 *    include) a moderator is refused, whether it was named or reached through an address.
 */
function actionTarget(b: Record<string, unknown>, c: AdminRouteContext, svc: ModerationService): Target {
  const t = targetOf(b, svc)!;
  const byAddress = addressTargetAllowed(t, c);
  const online = byAddress ? t.online.filter((p) => !isLoopbackAddressKey(p.address)) : t.online;
  if (!c.can('moderators.act') && ((!!t.accountId && svc.isAdminAccount(t.accountId)) || online.some((p) => svc.isAdmin(p)))) {
    throw new HttpError(403, NOT_ON_A_MODERATOR);
  }
  return online === t.online ? t : { ...t, online, playerId: online[0]?.playerId ?? null };
}

function logQueryOf(b: Record<string, unknown>): LogQuery {
  const q: LogQuery = {};
  q.player = str(b.player, 64);
  q.accountId = str(b.accountId, 64);
  q.address = str(b.address, 64)?.toLowerCase();
  q.grep = str(b.grep, 100);
  q.roomId = str(b.roomId, 32);
  if (b.action !== undefined) {
    if (b.action !== 'flagged' && !(CHAT_ACTIONS as readonly unknown[]).includes(b.action)) throw bad('action must be pass, flag, mask, block, spam, muted or flagged');
    q.action = b.action as LogQuery['action'];
  }
  if (b.since !== undefined) {
    q.since = parseSince(b.since, Date.now());
    if (q.since === undefined) throw bad('since must be epoch ms or a duration like 2h');
  }
  if (b.until !== undefined) { q.until = int(b.until); if (q.until === undefined) throw bad('until must be epoch ms'); }
  q.limit = int(b.limit) ?? 100;
  q.before = int(b.before);
  return q;
}

const logDesc = (b: Record<string, unknown>): string => ['player', 'accountId', 'address', 'grep', 'action', 'roomId', 'since']
  .filter((k) => b[k] !== undefined).map((k) => `${k}=${String(b[k]).slice(0, 40)}`).join(' ');

// ------------------------------------------------------------------------------------------
// Scrubbing (what each principal may receive)
// ------------------------------------------------------------------------------------------

export interface ScrubRules {
  /** Drop `original` (and other original-text fields). */
  original: boolean;
  /** Drop hit labels (`hits`: they name the words that were typed), keeping `tags`. */
  hits: boolean;
  /** Replace addresses with address tags. */
  addresses: boolean;
  /** Drop every email field. */
  email: boolean;
  /** Drop who reported (limited moderators). */
  reporter: boolean;
  /** Drop SELF-HARM rows and wellbeing alerts entirely (moderators, §5.2 "leave them out entirely"). */
  selfHarm: boolean;
  /**
   * Keep SELF-HARM rows but as the nameless "Wellbeing alert" line (§5.4: no name or text until opened ★): a host
   * session without `wellbeing` (remote `limited`, a click-through) can't open one, so it never gets who or what.
   */
  selfHarmNameless?: boolean;
}

/** The rules for one principal on one route (§5.15 "Moderator sessions never receive …"). */
export function scrubRulesFor(p: Principal | null, spec: RouteSpec, ctx: CanContext = {}): ScrubRules {
  const reveal = !!spec.reveals && !!p && can(p, 'reveal', ctx);
  if (!p || p.kind === 'moderator') {
    return { original: true, hits: true, addresses: true, email: true, reporter: !p || !can(p, 'reports.reporter', ctx), selfHarm: true, selfHarmNameless: false };
  }
  const wellbeing = can(p, 'wellbeing', ctx);
  return {
    original: !reveal,
    hits: !reveal,
    addresses: !can(p, 'addresses', ctx),
    email: !can(p, 'accounts', ctx),
    reporter: !can(p, 'reports.reporter', ctx),
    // Without `wellbeing`: none on a route about one person (the filter would name the student), nameless elsewhere.
    selfHarm: !wellbeing && !!spec.aboutPerson,
    selfHarmNameless: !wellbeing,
  };
}

const ORIGINAL_KEYS = new Set(['original', 'originalText']);
const ADDRESS_KEYS = new Set(['address', 'targetAddress', 'reporterAddress', 'addressPrefix', 'addresses']);
const REPORTER_KEYS = new Set(['reporter', 'reporterName', 'reporterAccountId', 'reporterPlayerId', 'reporterAddress', 'reportedBy']);
const EMAIL_KEY_RE = /^email/i;

/**
 * A chat row, log line, event or alert about a self-harm statement (never for moderators). `display: 'withheld'` is
 * set only for self-harm lines (§5.8 display table; Zone.ts), and it survives where the hits don't: a report's
 * shown-only copy of a line (auth/store.ts reportChatCopy) has no tags and empty hits.
 */
export function isSelfHarmRow(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.wellbeing === true || o.kind === 'wellbeing' || o.kind === 'selfharm') return true;
  if (o.display === 'withheld') return true;
  if (Array.isArray(o.tags) && o.tags.includes(TAG_SELF_HARM)) return true;
  if (Array.isArray(o.hits) && tagsOf(o.hits).includes(TAG_SELF_HARM)) return true;
  return false;
}

/** What a nameless wellbeing line keeps (scalars only): when, where and how it was handled, never who or what. */
const NAMELESS_KEEP: readonly string[] = [
  'id', 'seq', 'chatId', 'ts', 'at', 'roomId', 'roomUid', 'roomName', 'channel', 'team', 'action', 'display', 'kind', 'severity',
  'level', 'status', 'acked', 'ackedAt', 'online', 'code',
];
/** Who a row is about: blanked (when present) on a nameless wellbeing line. */
const NAMELESS_BLANK: Readonly<Record<string, '' | null>> = {
  name: '', username: '', callsign: '', shown: '', text: '', accountId: null, playerId: null, student: null, target: null,
};

/** §5.4's "Wellbeing alert — needs your attention" line: a whitelist of scalars, the tags, and `wellbeing: true`. */
export function namelessWellbeingRow(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of NAMELESS_KEEP) {
    const val = v[k];
    if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
  }
  const raw: unknown[] = Array.isArray(v.tags) ? v.tags : Array.isArray(v.hits) ? tagsOf(v.hits) : [];
  const tags = raw.filter((t): t is string => typeof t === 'string');
  out.tags = tags.includes(TAG_SELF_HARM) ? tags : [...tags, TAG_SELF_HARM];
  for (const [k, blank] of Object.entries(NAMELESS_BLANK)) if (k in v) out[k] = blank;
  out.wellbeing = true;
  return out;
}

/** Deeper than this a reply is not walked: the value is dropped (never passed through unscrubbed). */
export const SCRUB_MAX_DEPTH = 24;

/** A deep copy of a JSON reply with what the rules forbid removed (depth-limited: deeper objects are dropped). */
export function scrubReply(v: unknown, rules: ScrubRules, tag: (address: string) => string, depth = 0): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (depth > SCRUB_MAX_DEPTH) return null;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const el of v) {
      if (isSelfHarmRow(el)) {
        if (rules.selfHarm) continue;
        if (rules.selfHarmNameless) { out.push(namelessWellbeingRow(el as Record<string, unknown>)); continue; }
      }
      out.push(scrubReply(el, rules, tag, depth + 1));
    }
    return out;
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(src)) {
    if (rules.original && ORIGINAL_KEYS.has(k)) continue;
    if (rules.email && EMAIL_KEY_RE.test(k)) continue;
    if (rules.reporter && REPORTER_KEYS.has(k)) { if (k === 'reporter') out.reporter = null; continue; }
    if (k === 'hits' && rules.hits) {
      if (!('tags' in src)) out.tags = tagsOf(val);
      continue;
    }
    if (rules.addresses && ADDRESS_KEYS.has(k)) {
      const tk = k === 'addresses' ? 'addressTags' : `${k}Tag`;
      if (Array.isArray(val)) out[tk] = val.map((a) => (typeof a === 'string' ? tag(a) : null));
      else out[tk] = typeof val === 'string' ? tag(val) : null;
      continue;
    }
    if (isSelfHarmRow(val) && (rules.selfHarm || rules.selfHarmNameless)) {
      out[k] = rules.selfHarm ? null : namelessWellbeingRow(val as Record<string, unknown>);
      continue;
    }
    out[k] = scrubReply(val, rules, tag, depth + 1);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Body reading (per-route limit)
// ------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, 'Request body too large', { Connection: 'close' }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const failWith = (e: HttpError): void => { if (!done) { done = true; reject(e); } };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { chunks.length = 0; failWith(new HttpError(413, 'Request body too large', { Connection: 'close' })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { reject(new HttpError(400, 'Invalid JSON')); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { reject(new HttpError(400, 'Invalid request')); return; }
      resolve(parsed as Record<string, unknown>);
    });
    req.on('error', () => failWith(new HttpError(400, 'Invalid request')));
  });
}

// ------------------------------------------------------------------------------------------
// Built-in handlers (LAN edition)
// ------------------------------------------------------------------------------------------

function need(svc: ModerationService | null): ModerationService {
  if (!svc) throw new HttpError(503, ERR.unavailable);
  return svc;
}

function failReply(f: { status: number; error: string } & Record<string, unknown>): [number, unknown] {
  const { ok: _ok, status, ...rest } = f as { ok?: unknown; status: number } & Record<string, unknown>;
  return [status, rest];
}

/**
 * A ban made by the host (the host admin under ANY name it has had, or the host's CLI): trusted moderators can't lift
 * it (§5.2). `hostNames` = HostAdmin.hostAdminNames() (lower case), read once per request.
 */
function isHostBan(b: BanRow, hostNames: ReadonlySet<string>): boolean {
  const by = b.by.trim().toLowerCase();
  return by === 'cli' || by === HOST_ACTOR_ID || hostNames.has(by);
}

// ------------------------------------------------------------------------------------------
// The Chat log, as one principal may see it
// ------------------------------------------------------------------------------------------

/** One `log` call scans about this many rows to fill a page when rows the caller may not see are skipped. */
export const LOG_SCAN_ROWS = 5000;
/** …and never more than this hunting for a row the cursor may name (the page then just ends: nextBefore null). */
export const LOG_SCAN_HARD = 100_000;
const LOG_SCAN_PAGE = 1000;

export interface LogVisibility {
  /** `reveal`: a search may match the ORIGINAL text. Otherwise it matches the shown text only, and the SQL never sees it. */
  original: boolean;
  /** `wellbeing`: SELF-HARM rows are returned. Otherwise they are left out entirely, before any person filter. */
  selfHarm: boolean;
}

/**
 * A `log` page holding only the rows this caller may see, with a cursor computed from those rows alone (§5.2, §5.15).
 * Filtering a page after the query and keeping the query's own cursor would point at rows the caller must never learn
 * about: which named student wrote a withheld SELF-HARM line, or which line's original text holds a guessed word.
 *  - Without `reveal` the search is not sent to the SQL (it matches the original there): the scan runs over the filters
 *    the caller may see rows by, and the search is applied to the shown text here.
 *  - Without `wellbeing` SELF-HARM rows are skipped, and never become the cursor.
 *  - `nextBefore` is the last returned row when a further visible row exists; after LOG_SCAN_ROWS scanned rows it is the
 *    lowest scanned row the caller may see (the next call scans on from there). null = nothing more.
 */
export function visibleLogPage(store: Pick<ModStore, 'searchLog'>, q: LogQuery, see: LogVisibility): { lines: ChatLogRow[]; nextBefore: number | null } {
  const limit = Math.min(1000, Math.max(1, Math.floor(Number.isFinite(q.limit) ? q.limit! : 100)));
  if (see.original && see.selfHarm) return store.searchLog({ ...q, limit });
  const needle = !see.original && q.grep ? q.grep.toLowerCase() : null;
  const base: LogQuery = { ...q, grep: see.original ? q.grep : undefined, limit: LOG_SCAN_PAGE };
  const lines: ChatLogRow[] = [];
  let before = q.before;
  let scanned = 0;
  let safe: number | null = null;
  for (;;) {
    const page = store.searchLog({ ...base, before });
    for (const row of page.lines) {
      scanned++;
      if (!see.selfHarm && isSelfHarmRow(row)) continue;
      safe = row.id;
      if (needle && !String(row.shown ?? '').toLowerCase().includes(needle)) continue;
      if (lines.length === limit) return { lines, nextBefore: lines[limit - 1]!.id };
      lines.push(row);
    }
    if (page.nextBefore === null || !page.lines.length) return { lines, nextBefore: null };
    before = page.nextBefore;
    if (scanned >= LOG_SCAN_ROWS && safe !== null) return { lines, nextBefore: safe };
    if (scanned >= LOG_SCAN_HARD) return { lines, nextBefore: null };
  }
}

const BUILTIN: Record<string, AdminRouteHandler> = {
  me: (_b, c) => {
    const s = c.session!;
    const info = c.hostAdmin.sessionInfo(s);
    return [200, {
      ok: true,
      admin: { username: s.username, kind: s.kind, ...(s.accountId ? { accountId: s.accountId } : {}) },
      session: info,
      capabilities: info.capabilities,
      banners: [], // filled in by the pipeline (opts.banners + the host admin's own)
    }];
  },

  logout: (_b, c) => { c.hostAdmin.logout(c.session!, c.caller); return [200, { ok: true }]; },

  reauth: async (b, c) => {
    const res = await c.hostAdmin.reauth(c.session!, b.password, c.caller);
    if (!res.ok) return failReply(res);
    return [200, { ok: true, session: c.hostAdmin.sessionInfo(res.session) }];
  },

  password: async (b, c) => {
    const res = await c.hostAdmin.changePassword(c.session!, b.current, b.next, c.caller);
    if (!res.ok) return failReply(res);
    return [200, { ok: true, revoked: res.revoked }];
  },

  online: (_b, c) => {
    const svc = need(c.service);
    svc.auditRead(c.actor, 'api online');
    return [200, { ok: true, players: svc.online().map((p) => svc.describePilot(p)) }];
  },

  log: (b, c) => {
    const svc = need(c.service);
    const q = logQueryOf(b);
    if (q.address && !c.can('addresses')) throw new HttpError(403, ERR.role);
    svc.flushAllQuiet();
    // Rows the caller may not see are left out BEFORE paging, so the cursor never names one (visibleLogPage).
    const out = visibleLogPage(svc.store, q, { original: c.can('reveal'), selfHarm: c.can('wellbeing') });
    svc.auditRead(c.actor, `api log ${logDesc(b)}`.trim());
    return [200, { ok: true, ...out }];
  },

  reports: (b, c) => {
    const svc = need(c.service);
    const status = b.status === undefined ? 'open' : b.status;
    if (status !== 'all' && !(REPORT_STATUSES as readonly unknown[]).includes(status)) throw bad('status must be open, reviewed, dismissed or all');
    const out = svc.listReports(status as ReportStatus | 'all', Math.min(200, int(b.limit) ?? 50), int(b.before));
    svc.auditRead(c.actor, `api reports ${status}`);
    return [200, { ok: true, ...out }];
  },

  'reports/review': (b, c) => {
    const svc = need(c.service);
    const id = int(b.id);
    if (id === undefined) throw bad('id is required');
    if (!(REPORT_STATUSES as readonly unknown[]).includes(b.status)) throw bad('status must be reviewed, dismissed or open');
    if (b.note !== undefined && typeof b.note !== 'string') throw bad('note must be a string');
    const res = svc.reviewReport(c.actor, id, b.status as ReportStatus, str(b.note, 500) ?? null);
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, report: res.report }];
  },

  bans: (b, c) => {
    const svc = need(c.service);
    const kind = b.kind === undefined ? 'all' : b.kind;
    if (kind !== 'all' && kind !== 'ban' && kind !== 'mute') throw bad('kind must be ban, mute or all');
    const bans = svc.store.listBans({ kind: kind as BanKind | 'all', includeInactive: b.includeInactive === true, limit: int(b.limit) ?? 200 }, c.now());
    svc.auditRead(c.actor, `api bans ${kind}${b.includeInactive === true ? ' all' : ''}`);
    return [200, { ok: true, bans }];
  },

  'bans/create': (b, c) => {
    const svc = need(c.service);
    if (b.kind !== 'ban' && b.kind !== 'mute') throw bad('kind must be ban or mute');
    if (b.scope !== undefined && b.scope !== 'account' && b.scope !== 'address' && b.scope !== 'guest') throw bad('scope must be account, address or guest');
    const durationSec = parseDuration(b.duration);
    if (durationSec === undefined) throw bad('duration must be like 10m, 2h, 1d, 7d, perm, or seconds');
    const reason = str(b.reason, 200);
    if (!reason) throw bad('reason is required (1-200 characters)');
    const target = targetOf(b, svc, false);
    const address = str(b.address, 64)?.toLowerCase();
    if (!target && !address) throw bad('Say who: target, accountId, playerId or address');
    // A network action: an `address`, or a `target` that is an address (service.createBan makes it scope 'address').
    const network = (!!target && isAddressTarget(target)) || (!target && !!address);
    // A ban, a network-wide action or a mute beyond 24 h needs `ban` (limited moderators: "Ask the host"), whatever
    // `kind` or `scope` says; naming a network also needs `addresses` (so the 409 never counts who is on one).
    if (b.kind === 'ban' || b.scope === 'address' || network) c.require('ban', ASK_THE_HOST);
    else if (!mayMute(c.principal!, durationSec, c.canContext)) c.require('ban', ASK_THE_HOST);
    if (network) c.require('addresses');
    if (target?.accountId && svc.isAdminAccount(target.accountId) && !c.can('moderators.act')) throw new HttpError(403, NOT_ON_A_MODERATOR);
    const res = svc.createBan(c.actor, {
      kind: b.kind, target, address: target ? undefined : address, scope: b.scope as BanScope | undefined, durationSec, reason,
      confirm: b.confirm === true,
    });
    if (!res.ok) {
      if (res.needsConfirm) return [409, { error: res.error, needsConfirm: true, sharing: res.sharing ?? 0 }];
      throw new HttpError(res.status, res.error);
    }
    return [200, { ok: true, ban: res.ban, kicked: res.kicked }];
  },

  'bans/revoke': (b, c) => {
    const svc = need(c.service);
    const id = int(b.id);
    const hostNames = c.hostAdmin.hostAdminNames();
    let res;
    if (id !== undefined) {
      // The row itself (never a capped list: the check must not fail open), and the permission check always runs.
      const row = svc.store.getBan(id, c.now());
      if (!row) throw new HttpError(404, 'No such ban.');
      if (!mayLift(c.principal!, { kind: row.kind, by: row.by, hostBan: isHostBan(row, hostNames) }, c.actor.name, c.canContext)) {
        throw new HttpError(403, row.kind === 'ban' || isHostBan(row, hostNames) ? ASK_THE_HOST : ERR.role);
      }
      res = svc.revoke(c.actor, { id });
    } else {
      if (b.kind !== 'ban' && b.kind !== 'mute') throw bad('Pass an id, or a target and kind (ban or mute)');
      c.require('ban', ASK_THE_HOST); // by target: every matching one (limited principals lift their own mutes by id)
      const t = targetOf(b, svc)!;
      addressTargetAllowed(t, c);
      if (!c.can('ban.host')) {
        // Every live one (not a capped list), and fail closed: any host ban of this kind that could be the target's.
        const names = new Set([t.name, t.username, ...t.online.map((o) => o.name)].filter((n): n is string => !!n).map((n) => n.trim().toLowerCase()));
        const touches = (x: BanRow): boolean => (!!t.accountId && x.accountId === t.accountId)
          || (!!x.username && names.has(x.username.trim().toLowerCase()))
          || (!!t.address && !!x.address && x.address === t.address);
        if (svc.store.liveBans(c.now()).some((x) => x.kind === b.kind && isHostBan(x, hostNames) && touches(x))) throw new HttpError(403, ASK_THE_HOST);
      }
      res = svc.revoke(c.actor, { target: t, kind: b.kind });
    }
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, revoked: res.revoked }];
  },

  kick: (b, c) => {
    const svc = need(c.service);
    const t = actionTarget(b, c, svc);
    const res = svc.kick(c.actor, t, str(b.reason, 200) ?? '');
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, kicked: res.kicked }];
  },

  warn: (b, c) => {
    const svc = need(c.service);
    const t = actionTarget(b, c, svc);
    const res = svc.warnPilot(c.actor, t, str(b.reason, 200) ?? '');
    if (!res.ok) throw new HttpError(res.status, res.error);
    return [200, { ok: true, warned: res.warned }];
  },

  whois: (b, c) => {
    const svc = need(c.service);
    const t = targetOf(b, svc)!;
    addressTargetAllowed(t, c); // who is at an address is itself an address lookup
    const w = svc.whois(t);
    svc.auditRead(c.actor, `api whois ${t.name}`);
    const p = c.principal!;
    if (p.kind === 'moderator' && p.tier === 'limited') {
      // §5.2: the current room and any active mute, nothing else.
      const mute = w.activeBans.find((x) => x.kind === 'mute') ?? null;
      return [200, {
        ok: true,
        whois: {
          query: w.query,
          online: w.online.map((o) => ({ playerId: o.playerId, name: o.name, roomName: o.roomName ?? null, muted: o.muted })),
          mute: mute ? { id: mute.id, expiresAt: mute.expiresAt, reason: mute.reason } : null,
        },
      }];
    }
    return [200, { ok: true, whois: w }];
  },

  actions: (b, c) => {
    const svc = need(c.service);
    const t = b.target !== undefined || b.accountId !== undefined || b.playerId !== undefined ? targetOf(b, svc) : null;
    addressTargetAllowed(t, c);
    const out = svc.store.listActions({
      limit: int(b.limit) ?? 100, before: int(b.before),
      targetAccountId: t?.accountId ?? null, targetName: t && !t.accountId ? t.name : null, targetAddress: t && !t.accountId ? t.address : null,
    });
    svc.auditRead(c.actor, `api actions${t ? ` ${t.name}` : ''}`);
    return [200, { ok: true, ...out }];
  },

  'settings/get': (_b, c) => {
    if (!c.settings) throw new HttpError(503, 'Settings are not available on this server.');
    return settingsGetReply(c.settings);
  },

  'settings/update': async (b, c) => {
    if (!c.settings) throw new HttpError(503, 'Settings are not available on this server.');
    return settingsUpdateReply(c.settings, b, c.actor);
  },

  'network/approve': async (b, c) => {
    if (!c.settings) throw new HttpError(503, 'Settings are not available on this server.');
    return networkApproveReply(c.settings, b, c.actor);
  },
};

/** The built-in endpoints (the rest come through AdminHttpOptions.handlers). */
export const BUILTIN_ENDPOINTS: readonly string[] = ['setup/status', 'setup', 'login', ...Object.keys(BUILTIN)];

// ------------------------------------------------------------------------------------------
// The API
// ------------------------------------------------------------------------------------------

export interface AdminHttp {
  /**
   * Handle /api/admin/*. Returns true if the request was handled. `ctx` comes from the admin listener; on the main
   * port it is computed (mainPortAdminContext).
   */
  handle(req: IncomingMessage, res: ServerResponse, ctx?: AdminRequestContext): Promise<boolean>;
}

export function createAdminHttp(opts: AdminHttpOptions): AdminHttp {
  return opts.hostAdmin ? createLanAdminHttp(opts, opts.hostAdmin) : createLegacyAdminHttp(opts);
}

const reauthError = (): HttpError & { reauth?: boolean } => Object.assign(new HttpError(401, ADMIN_ERR.reauth), { reauth: true });
/** A call answered 401 or 403 was refused: it never counts as activity. */
const isRefusalStatus = (status: number): boolean => status === 401 || status === 403;

function createLanAdminHttp(opts: AdminHttpOptions, hostAdmin: HostAdmin): AdminHttp {
  const now = opts.now ?? Date.now;
  const [callMax, callWin] = opts.limits?.calls ?? [600, 60_000];
  const [failMax, failWin] = opts.limits?.authFailures ?? [20, 10 * 60_000];
  // The call budget is per SESSION, so one session (a remote or captured one) can't spend another's; the sessions not
  // on the host PC also share a looser per-principal cap. The host PC is never slowed by calls made elsewhere.
  const calls = new SlidingWindowLimiter(callMax, callWin, now);
  const remoteCalls = new SlidingWindowLimiter(callMax * 2, callWin, now);
  const fails = new SlidingWindowLimiter(failMax, failWin, now);
  const sweep = setInterval(() => { calls.sweep(); remoteCalls.sweep(); fails.sweep(); }, 10 * 60_000);
  sweep.unref?.();
  const settings = opts.settings ?? null;
  const policy = opts.policy ?? (() => hostAdmin.currentPolicy());
  const tagKey = opts.addressTagKey && opts.addressTagKey.length ? opts.addressTagKey : randomBytes(32);
  const tag = (a: string): string => createHmac('sha256', tagKey).update(a.toLowerCase(), 'utf8').digest('hex').slice(0, 4);
  const handlers: Record<string, AdminRouteHandler> = { ...BUILTIN, ...(opts.handlers ?? {}) };
  const contextOf = opts.context ?? ((req: IncomingMessage) => mainPortAdminContext(req, { trust: opts.proxyTrust ?? { enabled: opts.trustProxy, extra: [] } }));
  const limited = (waitMs: number): HttpError => new HttpError(429, ERR.rateLimited, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });

  const applySetup = settings
    ? async (choices: SetupChoices, actor: Actor) => {
      const res = await settings.applyPreset(choices.preset, actor, { accountsMode: choices.accountsMode, serverName: choices.serverName });
      if (!res.ok) return { ok: false as const, status: res.status, error: res.error, field: res.field };
      // School setup's optional Allowed email domains (owner decision 6), as Settings → Accounts would save them.
      if (choices.domains?.length) {
        const d = await settings.apply({ accounts: { domains: choices.domains } }, actor, { context: 'setup' });
        if (!d.ok) return { ok: false as const, status: d.status, error: d.error, field: 'domains' };
      }
      return { ok: true as const };
    }
    : undefined;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    sendJson(res, status, body, { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...headers });
  };

  return {
    async handle(req, res, given) {
      const urlPath = (req.url ?? '').split('?')[0] ?? '';
      if (urlPath !== '/api/admin' && !urlPath.startsWith('/api/admin/')) return false;
      // A sign-in or setup refused before HostAdmin sees it (method, Origin, Content-Type, host PC only, the body) is
      // audited too (§4.10 "every failure is audited"); from `reached` on, HostAdmin audits its own outcomes.
      const attempt = urlPath === '/api/admin/login' ? 'login' as const : urlPath === '/api/admin/setup' ? 'setup' as const : null;
      let reached = false;
      let callerAddress = given?.address ?? null;
      const noteRefused = (status: number, message: string): void => {
        if (!attempt || reached) return;
        try { hostAdmin.auditRefusedAttempt(callerAddress ?? sessionAddress(req.socket?.remoteAddress), attempt, status, message); } catch (e) {
          opts.log(`[admin] could not audit a refused ${attempt}: ${(e as Error)?.message ?? e}`);
        }
      };
      try {
        let ctx: AdminRequestContext;
        if (given) ctx = given;
        else {
          const c = contextOf(req);
          if (isRefusal(c)) { req.resume(); noteRefused(c.refuse[0], c.refuse[1]); send(res, c.refuse[0], { error: c.refuse[1] }); return true; }
          ctx = c;
          callerAddress = c.address;
        }
        if (req.method !== 'POST') {
          req.resume();
          noteRefused(405, 'Method not allowed');
          send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
          return true;
        }
        // Same origin only: the admin API never uses CORS.
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim().toLowerCase() : '';
        if (!origin || origin !== ctx.origin.toLowerCase()) { req.resume(); throw new HttpError(403, ERR.origin); }
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          req.resume();
          throw new HttpError(415, 'Content-Type must be application/json');
        }
        const name = urlPath.slice('/api/admin/'.length);
        const spec = Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, name) ? ADMIN_ROUTES[name] : undefined;
        if (!spec) { req.resume(); throw new HttpError(404, ERR.notFound); }
        if (spec.hostPcOnly && !ctx.hostPc) {
          req.resume();
          throw new HttpError(403, name === 'setup' || name === 'setup/status' ? ADMIN_ERR.setupHostPc : ERR.hostPcOnly);
        }

        // --- the routes without a session ---
        if (spec.auth === 'none') {
          const body = await readBody(req, spec.bodyLimit ?? BODY_LIMIT);
          reached = true;
          if (name === 'setup/status') {
            const st = hostAdmin.setupStatus(ctx);
            if (!st.ok) { send(res, ...failReply(st)); return true; }
            const { ok: _ok, ...rest } = st;
            send(res, 200, { ok: true, ...rest });
            return true;
          }
          if (name === 'setup') {
            const out = await hostAdmin.setup(body, ctx, { apply: applySetup });
            if (!out.ok) {
              const [st, b] = failReply(out);
              send(res, st, b, out.retryAfter ? { 'Retry-After': String(out.retryAfter) } : {});
              return true;
            }
            send(res, 200, { ok: true, token: out.token, session: hostAdmin.sessionInfo(out.session), kind: out.kind });
            return true;
          }
          if (name === 'login') {
            const out = await hostAdmin.login(body, ctx);
            if (!out.ok) {
              const [st, b] = failReply(out);
              send(res, st, b, out.retryAfter ? { 'Retry-After': String(out.retryAfter) } : {});
              return true;
            }
            send(res, 200, { ok: true, token: out.token, session: hostAdmin.sessionInfo(out.session) });
            return true;
          }
          const h = handlers[name];
          if (!h) throw new HttpError(501, ERR.notBuilt);
          const reply = await h(body, makeCtx(null, ctx, req, res));
          deliver(res, reply, spec, null);
          return true;
        }

        // --- a session ---
        // Authenticated as a poll: the call counts as activity (idle timeout, step-up freshness) only once it passed
        // its checks and the handler did not refuse it (HostAdmin.activity, below).
        const m = TOKEN_HDR_RE.exec(String(req.headers.authorization ?? '').trim());
        const auth = m ? hostAdmin.authenticate(m[1]!, ctx, { passive: true }) : null;
        if (!auth || !auth.ok) {
          req.resume();
          const wait = fails.take(`f:${ctx.address}`);
          if (wait > 0) throw limited(wait);
          const status = auth && !auth.ok ? auth.status : 401;
          throw new HttpError(status, auth && !auth.ok ? auth.error : ERR.notLoggedIn);
        }
        const session = auth.session;
        const canCtx: CanContext = { logSearch: policy().moderatorLogSearch, untrustedTls: session.untrustedTls };
        if (spec.cap && !can(session.principal, spec.cap, canCtx)) { req.resume(); throw new HttpError(403, ERR.role); }
        if (routeSensitive(spec) && !session.fresh) { req.resume(); throw reauthError(); }
        const sKey = `s:${session.tokenHash}`;
        const pKey = ctx.hostPc ? null : `p:${session.principalId}`;
        const callWait = Math.max(calls.blockedFor(sKey), pKey ? remoteCalls.blockedFor(pKey) : 0);
        if (callWait > 0) { req.resume(); throw limited(callWait); }
        calls.record(sKey);
        if (pKey) remoteCalls.record(pKey);
        const body = await readBody(req, spec.bodyLimit ?? BODY_LIMIT);
        const h = handlers[name];
        if (!h) throw new HttpError(501, ERR.notBuilt);
        const hctx = makeCtx(session, ctx, req, res, canCtx);
        const counted = { passive: !!spec.passive, keepAlive: !!spec.keepAlive };
        let reply: AdminReply;
        try { reply = await h(body, hctx); } catch (e) {
          if (!(e instanceof HttpError && isRefusalStatus(e.status))) hostAdmin.activity(session, counted);
          throw e;
        }
        if (!(Array.isArray(reply) && isRefusalStatus(reply[0]))) hostAdmin.activity(session, counted);
        if (name === 'me' && Array.isArray(reply) && reply[0] === 200 && reply[1] && typeof reply[1] === 'object') {
          const extra = safeBanners(session);
          reply = [200, { ...(reply[1] as Record<string, unknown>), banners: [...hostAdmin.banners(), ...extra] }];
        }
        deliver(res, reply, spec, session.principal, canCtx);
      } catch (e) {
        if (e instanceof HttpError) {
          noteRefused(e.status, e.message);
          const body: Record<string, unknown> = { error: e.message };
          if ((e as { reauth?: boolean }).reauth) { body.reauth = true; body.code = 'reauth'; }
          send(res, e.status, body, e.headers);
        } else {
          opts.log(`[admin] ${urlPath} failed: ${(e as Error)?.stack ?? e}`);
          send(res, 500, { error: 'Server error' });
        }
      }
      return true;
    },
  };

  function safeBanners(s: AdminSession): Banner[] {
    try { return opts.banners?.(s) ?? []; } catch (e) {
      opts.log(`[admin] banners failed: ${(e as Error)?.message ?? e}`);
      return [];
    }
  }

  function makeCtx(session: AdminSession | null, caller: AdminRequestContext, req: IncomingMessage, res: ServerResponse, canCtx: CanContext = {}): AdminRouteContext {
    const principal = session?.principal ?? null;
    const ac = new AbortController();
    // The response closes when it is sent or when the client goes away (a long-poll then frees its waiter).
    res.once('close', () => { if (!ac.signal.aborted) ac.abort(); });
    const actor: Actor = session
      ? session.kind === 'host' ? { accountId: HOST_ACTOR_ID, name: session.username } : { accountId: session.accountId ?? 'unknown', name: session.username }
      : { accountId: 'anonymous', name: '-' };
    const canFn = (cap: Capability): boolean => !!principal && can(principal, cap, canCtx);
    return {
      session, principal, actor, caller, req, canContext: canCtx,
      can: canFn,
      require(cap, message) {
        if (!canFn(cap)) throw new HttpError(403, message ?? ERR.role);
        if (isSensitive(cap) && !session?.fresh) throw reauthError();
      },
      service: opts.service,
      settings,
      hostAdmin,
      signal: ac.signal,
      now,
    };
  }

  function deliver(res: ServerResponse, reply: AdminReply, spec: RouteSpec, principal: Principal | null, canCtx: CanContext = {}): void {
    if (!Array.isArray(reply)) {
      const f = reply.file;
      const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf8') : f.body;
      const safeName = f.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'export';
      res.writeHead(200, {
        'Content-Type': f.contentType,
        'Content-Length': String(body.length),
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(f.rows !== undefined ? { 'X-Row-Count': String(f.rows) } : {}),
      });
      res.end(body);
      return;
    }
    const [status, body] = reply;
    const rules = scrubRulesFor(principal, spec, canCtx);
    send(res, status, scrubReply(body, rules, tag));
  }
}

// ------------------------------------------------------------------------------------------
// Legacy mode (v0.4/v0.5)
// ------------------------------------------------------------------------------------------

type LegacyHandler = (b: Record<string, unknown>, actor: Actor, svc: ModerationService) => [number, unknown];

const legacyRoutes: Record<string, LegacyHandler> = {
  me: (_b, actor) => [200, { ok: true, admin: { accountId: actor.accountId, username: actor.name } }],
  online: (_b, actor, svc) => {
    svc.auditRead(actor, 'api online');
    return [200, { ok: true, players: svc.online().map((p) => svc.describePilot(p)) }];
  },
  log: (b, actor, svc) => {
    const q = logQueryOf(b);
    svc.flushAllQuiet();
    const out = svc.store.searchLog(q);
    svc.auditRead(actor, `api log ${logDesc(b)}`.trim());
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

/** The v0.4/v0.5 endpoints (legacy mode). */
export const LEGACY_ADMIN_ENDPOINTS: readonly string[] = Object.keys(legacyRoutes);

function createLegacyAdminHttp(opts: AdminHttpOptions): AdminHttp {
  const now = opts.now ?? Date.now;
  const [callMax, callWin] = opts.limits?.calls ?? [240, 60_000];
  const [failMax, failWin] = opts.limits?.authFailures ?? [20, 10 * 60_000];
  const calls = new SlidingWindowLimiter(callMax, callWin, now);
  const fails = new SlidingWindowLimiter(failMax, failWin, now);
  const sweep = setInterval(() => { calls.sweep(); fails.sweep(); }, 10 * 60_000);
  sweep.unref?.();
  const corsOrigins = opts.corsOrigins ?? [];

  const limited = (waitMs: number): HttpError => new HttpError(429, ERR.rateLimited, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });

  return {
    async handle(req, res) {
      const urlPath = (req.url ?? '').split('?')[0] ?? '';
      if (urlPath !== '/api/admin' && !urlPath.startsWith('/api/admin/')) return false;
      const originHeader = req.headers.origin;
      const origin = typeof originHeader === 'string' ? originHeader : undefined;
      const allowed = originAllowed(origin, corsOrigins, req);
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
        const handler = Object.prototype.hasOwnProperty.call(legacyRoutes, name) ? legacyRoutes[name] : undefined;
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

// ------------------------------------------------------------------------------------------
// Panel files
// ------------------------------------------------------------------------------------------

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

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': ADMIN_PAGE_CSP,
};

/** Serve one flat file of `dir` (whitelisted types, no sub-folders). */
function serveFlatFile(req: IncomingMessage, res: ServerResponse, dir: string, rawFile: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); res.writeHead(405, { ...PAGE_HEADERS, Allow: 'GET, HEAD' }).end(); return; }
  let file = rawFile;
  try { file = decodeURIComponent(file); } catch { res.writeHead(400, PAGE_HEADERS).end(); return; }
  const type = PAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file) || file.includes('..')) {
    res.writeHead(404, { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const full = path.join(dir, file);
  let body: Buffer;
  try {
    if (!statSync(full).isFile()) throw new Error('not a file');
    body = readFileSync(full);
  } catch {
    res.writeHead(404, { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  res.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': type, 'Content-Length': String(body.length) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * GET /admin, /admin/ → admin.html; /admin/<file> → that file of `dir` (flat: no sub-folders, whitelisted types).
 * Returns false for any other path.
 */
export function serveAdminPage(req: IncomingMessage, res: ServerResponse, dir = ADMIN_PAGE_DIR): boolean {
  const urlPath = (req.url ?? '').split('?')[0] ?? '';
  if (urlPath !== '/admin' && !urlPath.startsWith('/admin/')) return false;
  serveFlatFile(req, res, dir, urlPath === '/admin' || urlPath === '/admin/' ? 'admin.html' : urlPath.slice('/admin/'.length));
  return true;
}

export interface AdminSiteOptions {
  api: AdminHttp;
  /** The panel's folder (default ADMIN_PAGE_DIR). */
  pageDir?: string;
  /** The projector page's folder (src/lan/display; loopback only, no login). */
  displayDir?: string | null;
}

/**
 * The admin listener's request handler: `/api/admin/*`; `/` (the panel: login, setup, reauth) and its files, also
 * under `/admin/…`; `/display` (the projector page: host PC only). Anything else is 404.
 */
export function createAdminSite(o: AdminSiteOptions): (req: IncomingMessage, res: ServerResponse, ctx: AdminRequestContext) => Promise<void> {
  const pageDir = o.pageDir ?? ADMIN_PAGE_DIR;
  return async (req, res, ctx) => {
    if (await o.api.handle(req, res, ctx)) return;
    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    if (urlPath === '/display' || urlPath.startsWith('/display/')) {
      if (!ctx.hostPc) { req.resume(); res.writeHead(403, { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end(`${ERR.hostPcOnly}\n`); return; }
      if (!o.displayDir) { res.writeHead(404, { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
      serveFlatFile(req, res, o.displayDir, urlPath === '/display' || urlPath === '/display/' ? 'display.html' : urlPath.slice('/display/'.length));
      return;
    }
    if (serveAdminPage(req, res, pageDir)) return;
    if (urlPath === '/' || urlPath === '/index.html') { serveFlatFile(req, res, pageDir, 'admin.html'); return; }
    if (/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(urlPath)) { serveFlatFile(req, res, pageDir, urlPath.slice(1)); return; }
    req.resume();
    res.writeHead(404, { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  };
}

// ------------------------------------------------------------------------------------------
// The whole control panel in one call (the LAN child's startServer)
// ------------------------------------------------------------------------------------------

export interface AdminPanelOptions {
  /** The auth DB (migrated by the AuthService first). */
  dbPath: string;
  /** The admin port A (0 = ephemeral; tests). */
  port: number;
  service: ModerationService | null;
  settings?: SettingsService | null;
  /** Default: from `settings` (adminPolicyOf), else the defaults. */
  policy?: () => AdminPolicy;
  /** data\secrets\pepper.key (setup-code hashes, address tags). */
  pepper?: Uint8Array | string | null;
  /** The launcher's setup code from `lan:start` (installed while setup is pending). */
  setupCode?: string | null;
  pageDir?: string;
  displayDir?: string | null;
  /** A fixed https binding on the primary address (bound whatever admin.remoteAccess says; requests are refused while off). */
  lan?: AdminLanBinding | null;
  /**
   * The https binding on the primary address, read while admin.remoteAccess is not `off` (§3.1): the primary address,
   * the TLS identity and IT's names (B12's primary.ts / tls). It is re-read when remote access or network.extraNames
   * change (through `settings`) and on AdminPanel.refreshLan() (a new primary address or certificate); null = none.
   * Wins over `lan`.
   */
  lanBinding?: (() => AdminLanBinding | null) | null;
  /** TRUST_PROXY (the launcher refuses it; with it nothing is the host PC). */
  trustProxy?: boolean;
  handlers?: Readonly<Record<string, AdminRouteHandler>>;
  banners?: (s: AdminSession) => Banner[];
  log: (line: string) => void;
  now?: () => number;
  /** A fresh setup code for the console (IPC `setup-code`; never log it). */
  onSetupCode?: (code: string, why: 'void' | 'expired') => void;
  /** Setup done, or an outside reset (IPC to the launcher). */
  onStateChange?: (s: AdminState) => void;
}

export interface AdminPanel {
  readonly port: number;
  hostAdmin: HostAdmin;
  api: AdminHttp;
  listener: AdminListener;
  /**
   * Re-read `lanBinding` (and remote access) and apply it: bind, re-bind on a new address or names, unbind when remote
   * access is off; a renewed certificate on the same address is swapped in without dropping connections.
   */
  refreshLan(): Promise<void>;
  /** Stop listening, then close the host admin's DB connection. */
  close(): Promise<void>;
}

// ------------------------------------------------------------------------------------------
// The child's IPC with the launcher for the control panel (src/lan/launch.ts, src/lan/child.ts)
// ------------------------------------------------------------------------------------------

/** Child → launcher messages from the control panel (the launcher rate-limits and validates them). */
export type AdminToLauncher =
  /** A fresh setup code after a void or an expiry: shown in the console only, never logged. */
  | { type: 'setup-code'; code: string; why: 'void' | 'expired' }
  /** The host admin login exists: first-run setup is done, players may join on the LAN (§3.1). */
  | { type: 'setup-done' };

/** startAdminPanel's onSetupCode / onStateChange, told to the launcher through `send` (never throws). */
export function adminIpcHooks(send: (m: AdminToLauncher) => void): Required<Pick<AdminPanelOptions, 'onSetupCode' | 'onStateChange'>> {
  const safe = (m: AdminToLauncher): void => { try { send(m); } catch { /* the launcher is gone */ } };
  return {
    onSetupCode: (code, why) => safe({ type: 'setup-code', code, why }),
    onStateChange: (s) => { if (!s.setupPending) safe({ type: 'setup-done' }); },
  };
}

/** The fields the launcher reads from the child's `ready` and `status` (src/lan/child.ts ChildReady / ChildStatus). */
export function adminReadyFields(panel: Pick<AdminPanel, 'hostAdmin' | 'port'> | null): { setupPending?: boolean; setupKind?: 'first' | 'reset' | null; adminPort?: number } {
  if (!panel) return {};
  try {
    const s = panel.hostAdmin.state();
    return { setupPending: s.setupPending, setupKind: s.setupKind, adminPort: panel.port };
  } catch {
    return { adminPort: panel.port };
  }
}

/**
 * The launcher's messages for the control panel; true when `msg` was one. `reload-admin`: `Reset admin password.cmd`
 * (or `tool admin-reset`) changed the credential on disk and told the launcher over the pipe; the host admin state is
 * re-read (its sessions already fail: authenticate checks the stored password on every call).
 */
export function handleAdminIpcMessage(panel: Pick<AdminPanel, 'hostAdmin'> | null, msg: unknown): boolean {
  if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'reload-admin') return false;
  if (panel) { try { panel.hostAdmin.reload(); } catch { /* stopping: the DB is closed */ } }
  return true;
}

/** HostAdmin + the admin API + the admin listener (loopback, plus the LAN https binding when given). */
export async function startAdminPanel(o: AdminPanelOptions): Promise<AdminPanel> {
  const settings = o.settings ?? null;
  const policy = o.policy ?? (settings ? () => adminPolicyOf(settings.get()) : () => DEFAULT_ADMIN_POLICY);
  const hostAdmin = new HostAdmin({
    dbPath: o.dbPath, policy, pepper: o.pepper ?? null, log: o.log, now: o.now,
    onSetupCode: o.onSetupCode, onStateChange: o.onStateChange,
  });
  try {
    if (o.setupCode) hostAdmin.installLaunchCode(o.setupCode);
    const api = createAdminHttp({
      service: o.service, trustProxy: !!o.trustProxy, log: o.log, now: o.now, hostAdmin, settings, policy,
      handlers: o.handlers, banners: o.banners, addressTagKey: o.pepper ?? null,
    });
    /** The LAN binding wanted now: the fixed one, or lanBinding() while remote access is on. */
    const wantedLan = (): AdminLanBinding | null => {
      if (!o.lanBinding) return o.lan ?? null;
      if (policy().remoteAccess === 'off') return null;
      try { return o.lanBinding(); } catch (e) {
        o.log(`[admin] the remote-access binding could not be read: ${(e as Error)?.message ?? e}`);
        return null;
      }
    };
    const lanKey = (l: AdminLanBinding | null): string => (l ? `${l.address}|${l.tls ? 'tls' : 'plain'}|${(l.names ?? []).join(',')}` : '');
    let current = wantedLan();
    const listener = await startAdminListener({
      port: o.port,
      policy: () => { const p = policy(); return { remoteAccess: p.remoteAccess, devicesTrustCert: p.devicesTrustCert }; },
      handle: createAdminSite({ api, pageDir: o.pageDir, displayDir: o.displayDir ?? null }),
      trustProxy: o.trustProxy,
      lan: current,
      log: o.log,
      // A sign-in or setup refused at the door (remote access off, plain http, a forwarding header, a foreign Host).
      onRefuse: (req, status, message, address) => {
        const p = (req.url ?? '').split('?')[0] ?? '';
        const what = p === '/api/admin/login' ? 'login' : p === '/api/admin/setup' ? 'setup' : null;
        if (what) hostAdmin.auditRefusedAttempt(address, what, status, message);
      },
    });
    let chain: Promise<void> = Promise.resolve();
    let closed = false;
    const refreshLan = (): Promise<void> => {
      chain = chain.then(async () => {
        if (closed) return;
        const next = wantedLan();
        const lanBound = listener.bound().some((b) => b.binding === 'admin-lan');
        // Same binding and it is up (a failed bind, say the address was not ready yet, is tried again).
        if (lanKey(next) === lanKey(current) && (!next || lanBound)) {
          if (next?.tls && current?.tls !== next.tls) listener.setSecureContext(next.tls);
          current = next;
          return;
        }
        current = next;
        await listener.setLan(next);
      }).catch((e: unknown) => { o.log(`[admin] could not update the remote-access binding: ${(e as Error)?.message ?? e}`); });
      return chain;
    };
    const unsubscribe = settings && o.lanBinding
      ? settings.subscribe(() => { void refreshLan(); }, { paths: ['admin.remoteAccess', 'network.extraNames'] })
      : null;
    // Switching remote access or the moderators' view off ends the sessions it allowed (§4.10), at once.
    const unsubscribeSessions = settings
      ? settings.subscribe(() => { hostAdmin.revokeDisallowed(policy()); }, { paths: ['admin.remoteAccess', 'moderators.view'] })
      : null;
    return {
      get port() { return listener.port; },
      hostAdmin, api, listener, refreshLan,
      async close() {
        closed = true;
        unsubscribe?.();
        unsubscribeSessions?.();
        await chain;
        await listener.close();
        hostAdmin.close();
      },
    };
  } catch (e) {
    hostAdmin.close();
    throw e;
  }
}
