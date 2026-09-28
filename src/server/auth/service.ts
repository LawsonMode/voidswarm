// OWNER: AUTH agent. The account service behind the frozen AuthService API (see ./index.ts).
// HTTP contract: "Accounts" block in src/shared/protocol.ts. Never log passwords or tokens
// (sole exception: the dev-mode reset link in mailer.ts when SMTP is not configured).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PASSWORD_MIN, USERNAME_RE, type AccountInfo, type AuthResponse } from '../../shared/protocol';
import { hashPassword, needsRehash, randomId, randomToken, sha256Hex, TOKEN_RE, verifyPassword } from './crypto';
import { clientIp, corsHeaders, HttpError, originAllowed, readJsonBody, sendJson } from './http';
import type { AuthOptions, AuthService } from './index';
import { createMailer, type Env, type Mailer } from './mailer';
import { SlidingWindowLimiter } from './ratelimit';
import { AuthStore, type AccountRow } from './store';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SESSION_TTL_MS = 30 * DAY;
/** Sliding refresh: a verified session is pushed back to a full 30 days at most once per hour. */
export const SESSION_REFRESH_MS = HOUR;
export const RESET_TTL_MS = 30 * MIN;
export const PASSWORD_MAX = 200;
export const EMAIL_MAX = 254;
/** Pragmatic sanity check (one @, no spaces, a dot in the domain) — real validation is the mail. */
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const PRUNE_EVERY_MS = HOUR;

export const ERR = {
  rateLimited: 'Too many attempts — try again later',
  badLogin: 'Invalid username/email or password',
  badUsername: 'Username must be 3–16 characters: letters, numbers, _ or -',
  badEmail: 'Enter a valid email address',
  shortPassword: `Password must be at least ${PASSWORD_MIN} characters`,
  longPassword: `Password must be at most ${PASSWORD_MAX} characters`,
  /** Same text for a taken username and a registered email, so register can't confirm an email exists. */
  unavailable: 'Username or email unavailable',
  badSession: 'Not logged in (session invalid or expired)',
  badReset: 'This reset link is invalid or has expired',
  badRequest: 'Invalid request',
  notFound: 'Not found',
  origin: 'Origin not allowed',
  server: 'Server error',
} as const;

export interface AuthLimits {
  loginPerIp: [max: number, windowMs: number];
  loginFailuresPerIpLogin: [max: number, windowMs: number];
  /** Failed logins against one account from ALL addresses (defeats address rotation). */
  loginFailuresPerAccount: [max: number, windowMs: number];
  registerPerIp: [max: number, windowMs: number];
  forgotPerIp: [max: number, windowMs: number];
  forgotPerEmail: [max: number, windowMs: number];
  resetPerIp: [max: number, windowMs: number];
}

export const DEFAULT_LIMITS: AuthLimits = {
  loginPerIp: [10, 10 * MIN],
  loginFailuresPerIpLogin: [5, 10 * MIN],
  loginFailuresPerAccount: [10, 15 * MIN],
  registerPerIp: [5, HOUR],
  forgotPerIp: [5, HOUR],
  forgotPerEmail: [3, HOUR],
  resetPerIp: [10, 10 * MIN],
};

/** Test/advanced seams. Production code uses `createAuthService(opts)` with all defaults. */
export interface AuthDeps {
  /** Clock (epoch ms). Default Date.now. */
  now?: () => number;
  /** Environment for SMTP_* / TRUST_PROXY. Default process.env. */
  env?: Env;
  /** Mail sender. Default: SMTP via nodemailer if SMTP_HOST is set, else the dev console logger. */
  mailer?: Mailer;
  limits?: Partial<AuthLimits>;
}

type Handler = (body: Record<string, unknown>, ip: string) => Promise<[status: number, body: unknown]>;

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

function toInfo(a: AccountRow): AccountInfo {
  return { accountId: a.id, username: a.username, emailMasked: maskEmail(a.email), createdAt: Number(a.created_at) };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function passwordError(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return ERR.shortPassword;
  if (pw.length > PASSWORD_MAX) return ERR.longPassword;
  return null;
}

function isUniqueViolation(e: unknown, column: string): boolean {
  const msg = String((e as Error)?.message ?? '');
  return msg.includes('UNIQUE') && msg.includes(column);
}

export function createAuthServiceWith(opts: AuthOptions, deps: AuthDeps = {}): AuthService {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const log = opts.log;
  const trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY?.toLowerCase() === 'true';
  const publicUrl = opts.publicUrl.replace(/\/+$/, '');
  const mailer = deps.mailer ?? createMailer(env, log);
  const limits: AuthLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const lim = (k: keyof AuthLimits): SlidingWindowLimiter => new SlidingWindowLimiter(limits[k][0], limits[k][1], now);
  const loginIp = lim('loginPerIp');
  const loginFail = lim('loginFailuresPerIpLogin');
  const loginFailAccount = lim('loginFailuresPerAccount');
  const registerIp = lim('registerPerIp');
  const forgotIp = lim('forgotPerIp');
  const forgotEmail = lim('forgotPerEmail');
  const resetIp = lim('resetPerIp');
  const limiters = [loginIp, loginFail, loginFailAccount, registerIp, forgotIp, forgotEmail, resetIp];

  const store = new AuthStore(opts.dbPath);
  store.prune(now());
  const usernames = new Set(store.allUsernamesLower());
  // Login against unknown users still pays for one scrypt verify (no user-enumeration timing).
  const dummyHash = hashPassword(randomToken());
  dummyHash.catch(() => { /* surfaced on first use */ });
  let closed = false;

  const pruneTimer = setInterval(() => {
    try {
      store.prune(now());
      for (const l of limiters) l.sweep();
    } catch (e) {
      log(`[auth] prune failed: ${(e as Error)?.message ?? e}`);
    }
  }, PRUNE_EVERY_MS);
  pruneTimer.unref?.();

  log(`[auth] ready — ${usernames.size} account(s), mail: ${mailer.smtp ? 'SMTP' : 'DEV console (SMTP_HOST not set)'}${trustProxy ? ', trusting X-Forwarded-For' : ''}`);

  const rateLimited = (waitMs: number): HttpError =>
    new HttpError(429, ERR.rateLimited, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });

  const guard = (l: SlidingWindowLimiter, key: string): void => {
    const wait = l.take(key);
    if (wait > 0) throw rateLimited(wait);
  };

  type RevokeListener = (accountId: string, sessionTokenHash: string | null) => void;
  const revokeListeners: RevokeListener[] = [];
  /** Tell the server a session (hash) or all of an account's sessions (null) are gone. Call after commit. */
  const emitRevoked = (accountId: string, sessionTokenHash: string | null): void => {
    for (const cb of revokeListeners) {
      try {
        cb(accountId, sessionTokenHash);
      } catch (e) {
        log(`[auth] sessions-revoked listener failed: ${(e as Error)?.message ?? e}`);
      }
    }
  };

  /** Per-account failure key. Unknown logins get their own key, so a lock never reveals existence. */
  const accountFailKey = (accountId: string | undefined, loginLower: string): string =>
    accountId ? `id:${accountId}` : `login:${loginLower}`;

  /** New session for an account; returns the raw token (only ever sent to the client). */
  const newSession = (accountId: string): string => {
    const token = randomToken();
    const t = now();
    const dropped = store.createSession(sha256Hex(token), accountId, t, t + SESSION_TTL_MS);
    for (const hash of dropped) emitRevoked(accountId, hash); // oldest sessions beyond the cap
    return token;
  };

  /** Resolve a raw token to its account (sliding refresh). */
  const resolveSession = (token: unknown): AccountRow | null => {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const hash = sha256Hex(token);
    const t = now();
    const row = store.sessionAccount(hash, t);
    if (!row) return null;
    const fresh = t + SESSION_TTL_MS;
    if (fresh - Number(row.s_expires) >= SESSION_REFRESH_MS) store.touchSession(hash, fresh);
    return row;
  };

  const register: Handler = async (body, ip) => {
    const username = str(body.username)?.trim() ?? '';
    const email = str(body.email)?.trim() ?? '';
    const password = str(body.password);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, ERR.badUsername);
    if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw new HttpError(400, ERR.badEmail);
    if (password === null) throw new HttpError(400, ERR.shortPassword);
    const pwErr = passwordError(password);
    if (pwErr) throw new HttpError(400, pwErr);
    // Counted after cheap validation (typos don't burn the budget) but before any lookup, so
    // probing which names/emails exist is capped too.
    guard(registerIp, ip);
    const usernameLower = username.toLowerCase();
    const emailLower = email.toLowerCase();
    // One generic answer for both collisions: register must not say that an email has an account
    // (forgot never does either). Usernames are public anyway (they show in game).
    if (usernames.has(usernameLower) || store.accountByUsername(usernameLower) || store.accountByEmail(emailLower)) {
      throw new HttpError(409, ERR.unavailable);
    }

    const passHash = await hashPassword(password);
    const t = now();
    const account: AccountRow = {
      id: randomId(), username, username_lower: usernameLower, email, email_lower: emailLower,
      pass_hash: passHash, created_at: t, last_login: t,
    };
    try {
      store.insertAccount(account); // UNIQUE constraints catch a concurrent duplicate
    } catch (e) {
      if (isUniqueViolation(e, 'username_lower') || isUniqueViolation(e, 'email_lower')) throw new HttpError(409, ERR.unavailable);
      throw e;
    }
    usernames.add(usernameLower);
    const token = newSession(account.id);
    log(`[auth] registered ${username}`);
    const out: AuthResponse = { token, account: toInfo(account) };
    return [200, out];
  };

  const login: Handler = async (body, ip) => {
    guard(loginIp, ip);
    const loginRaw = str(body.login);
    const password = str(body.password);
    if (loginRaw === null || password === null) throw new HttpError(400, ERR.badLogin);
    const loginLower = loginRaw.trim().toLowerCase();
    // Oversized input can't match any account — reject without spending a hash.
    if (!loginLower || loginLower.length > EMAIL_MAX || password.length > PASSWORD_MAX) throw new HttpError(401, ERR.badLogin);
    const account = loginLower.includes('@') ? store.accountByEmail(loginLower) : store.accountByUsername(loginLower);
    // `ip` is an IPv4 address or an IPv6 /64 prefix (see rateLimitKey in ./http).
    const failKey = `${ip}\n${loginLower}`;
    // Per-account cap across every address (username and email share it). Unknown logins get their own
    // key and are locked the same way, so a locked known account and a locked unknown login look identical.
    const acctKey = accountFailKey(account?.id, loginLower);

    // Failure limits are check-and-reserve: each attempt holds a failure slot on both limiters BEFORE
    // any scrypt runs (synchronously, with no await between the check and the hold), and gives it back
    // only on success. Checking first and recording after the hash would let a parallel burst from many
    // addresses all pass the check before the first failure landed. Blocked → the same generic 429 as
    // every other limiter. Nothing that can throw sits between a reserve and the try/finally that
    // settles it, so a slot can't leak.
    const ipSlot = loginFail.reserve(failKey);
    if (typeof ipSlot === 'number') throw rateLimited(ipSlot);
    const acctSlot = loginFailAccount.reserve(acctKey);
    if (typeof acctSlot === 'number') {
      ipSlot.release(); // nothing was evaluated
      throw rateLimited(acctSlot);
    }

    let passwordOk = false;
    try {
      // Unknown user: verify against the dummy hash anyway so both paths cost one scrypt.
      const matched = await verifyPassword(password, account ? account.pass_hash : await dummyHash);
      if (!account || !matched) throw new HttpError(401, ERR.badLogin);
      passwordOk = true;

      // Transparently upgrade a hash made with older scrypt params (compare-and-swap: see swapPassHash).
      let verifiedHash = account.pass_hash;
      if (needsRehash(verifiedHash)) {
        try {
          const upgraded = await hashPassword(password);
          if (store.swapPassHash(account.id, verifiedHash, upgraded)) {
            verifiedHash = upgraded;
            log(`[auth] upgraded password hash for ${account.username}`);
          }
        } catch (e) {
          log(`[auth] password rehash for ${account.username} failed: ${(e as Error)?.message ?? e}`);
        }
      }
      // The hash may have changed while we were hashing: a concurrent login's rehash (same password) or a
      // password reset (new password). Never mint a session for a password that is no longer current.
      const current = store.accountById(account.id)?.pass_hash;
      if (current !== verifiedHash) {
        const stillValid = !!current && (await verifyPassword(password, current)) && store.accountById(account.id)?.pass_hash === current;
        if (!stillValid) {
          passwordOk = false; // the password is no longer the account's: a failed login
          throw new HttpError(401, ERR.badLogin);
        }
      }
      store.setLastLogin(account.id, now());
      const token = newSession(account.id);
      const out: AuthResponse = { token, account: toInfo(account) };
      return [200, out];
    } finally {
      if (passwordOk) {
        // Success: hand both slots back and forgive earlier failures. Slots that concurrent attempts
        // still hold are untouched (reset only clears settled hits), so they stay counted.
        ipSlot.release();
        acctSlot.release();
        loginFail.reset(failKey);
        loginFailAccount.reset(acctKey);
      } else {
        // Wrong password, or anything that went wrong before the password was proven: it counts.
        ipSlot.commit();
        acctSlot.commit();
      }
    }
  };

  const logout: Handler = async (body) => {
    const token = body.token;
    if (typeof token === 'string' && TOKEN_RE.test(token)) {
      const hash = sha256Hex(token);
      const accountId = store.deleteSession(hash);
      if (accountId) emitRevoked(accountId, hash); // kick live connections on this session
    }
    return [200, { ok: true }];
  };

  const me: Handler = async (body) => {
    const account = resolveSession(body.token);
    if (!account) throw new HttpError(401, ERR.badSession);
    return [200, { account: toInfo(account) }];
  };

  const forgot: Handler = async (body, ip) => {
    const email = str(body.email)?.trim() ?? '';
    if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw new HttpError(400, ERR.badEmail);
    guard(forgotIp, ip);
    const emailLower = email.toLowerCase();
    guard(forgotEmail, emailLower);
    const account = store.accountByEmail(emailLower);
    if (account) {
      const resetToken = randomToken();
      store.replaceReset(sha256Hex(resetToken), account.id, now() + RESET_TTL_MS);
      const url = `${publicUrl}/?reset=${resetToken}`;
      // Fire-and-forget: the response must not depend on (or wait for) mail delivery.
      void mailer.sendReset({ to: account.email, username: account.username, url }).catch((e: unknown) => {
        const err = e as { code?: string; responseCode?: number; message?: string };
        log(`[auth] reset mail to ${maskEmail(account.email)} failed: ${err?.code ?? ''} ${err?.responseCode ?? ''} ${String(err?.message ?? e).split('\n')[0]}`.replace(/\s+/g, ' ').trim());
      });
      log(`[auth] reset issued for ${account.username}`);
    }
    return [200, { ok: true }];
  };

  const reset: Handler = async (body, ip) => {
    guard(resetIp, ip);
    const resetToken = body.resetToken;
    const password = str(body.password);
    if (typeof resetToken !== 'string' || !TOKEN_RE.test(resetToken)) throw new HttpError(400, ERR.badReset);
    if (password === null) throw new HttpError(400, ERR.shortPassword);
    const pwErr = passwordError(password);
    if (pwErr) throw new HttpError(400, pwErr);
    const resetHash = sha256Hex(resetToken);
    if (!store.liveResetAccount(resetHash, now())) throw new HttpError(400, ERR.badReset);

    const passHash = await hashPassword(password);
    const token = randomToken();
    const t = now();
    // Atomic re-check + consume, so two concurrent uses of one token can't both succeed.
    const accountId = store.completeReset(resetHash, passHash, sha256Hex(token), t, t + SESSION_TTL_MS);
    const account = accountId ? store.accountById(accountId) : undefined;
    if (!account) throw new HttpError(400, ERR.badReset);
    loginFailAccount.reset(accountFailKey(account.id, '')); // the owner proved control: lift any lock
    emitRevoked(account.id, null);                           // every older session is gone
    log(`[auth] password reset for ${account.username} (all other sessions revoked)`);
    const out: AuthResponse = { token, account: toInfo(account) };
    return [200, out];
  };

  const routes: Record<string, Handler> = {
    '/api/register': register,
    '/api/login': login,
    '/api/logout': logout,
    '/api/me': me,
    '/api/forgot': forgot,
    '/api/reset': reset,
  };

  return {
    async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (!path.startsWith('/api/')) return false;

      const originHeader = req.headers.origin;
      const origin = typeof originHeader === 'string' ? originHeader : undefined;
      const allowed = originAllowed(origin, opts.corsOrigins, req);
      const cors = allowed ? corsHeaders(origin) : { Vary: 'Origin' };

      try {
        if (req.method === 'OPTIONS') {
          req.resume();
          if (!allowed) { sendJson(res, 403, { error: ERR.origin }, cors); return true; }
          res.writeHead(204, {
            ...cors,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
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
        if (!allowed) { req.resume(); sendJson(res, 403, { error: ERR.origin }, cors); return true; }
        const handler = routes[path];
        if (!handler) { req.resume(); sendJson(res, 404, { error: ERR.notFound }, cors); return true; }
        if (closed) { req.resume(); sendJson(res, 503, { error: ERR.server }, cors); return true; }

        const body = await readJsonBody(req);
        const [status, out] = await handler(body, clientIp(req, trustProxy));
        sendJson(res, status, out, cors);
      } catch (e) {
        if (e instanceof HttpError) {
          sendJson(res, e.status, { error: e.message }, { ...cors, ...e.headers });
        } else {
          // Deliberately no request details here: bodies carry passwords/tokens.
          log(`[auth] ${path} failed: ${(e as Error)?.message ?? e}`);
          sendJson(res, 500, { error: ERR.server }, cors);
        }
      }
      return true;
    },

    async verifyToken(token: string): Promise<AccountInfo | null> {
      if (closed) return null;
      try {
        const account = resolveSession(token);
        return account ? toInfo(account) : null;
      } catch (e) {
        log(`[auth] verifyToken failed: ${(e as Error)?.message ?? e}`);
        return null;
      }
    },

    isRegisteredUsername(name: string): boolean {
      return typeof name === 'string' && usernames.has(name.trim().toLowerCase());
    },

    onSessionsRevoked(cb: RevokeListener): void {
      if (typeof cb === 'function') revokeListeners.push(cb);
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      revokeListeners.length = 0;
      store.close();
    },
  };
}
