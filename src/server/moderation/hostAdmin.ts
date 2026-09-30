// OWNER: SERVER MODERATION. The HOST ADMIN credential and the admin sessions (docs/LAN-EDITION-proposal.md §4.10, §5.15).
//
// The host admin is NOT a game account (host_admins, one row): no student can become admin through the game, and its
// username is reserved for players (isReservedName). Moderators are player accounts with the moderator flag; they
// sign in to the panel's Moderator view with their game password (role 'moderator'), and their flag, state and bans
// are re-checked on EVERY call, so a demoted, disabled, banned or deleted moderator's next call gets 401 (T-ADM-16).
//
//  - First-run setup (host PC only): the launcher passes the setup code in `lan:start` (installLaunchCode); only its
//    hash is stored (host_setup). 8 Crockford base32 characters, valid 30 minutes. After 5 wrong tries the code is
//    void and setup waits 60 s, doubling up to 15 minutes; a fresh code is minted at once (onSetupCode: the launcher
//    prints it in its console). Restarting the launcher (proof of presence) installs a fresh code and clears the wait.
//    After `Reset admin password.cmd` (resetHostAdmin / resetHostAdminAt) setup runs again in "reset" mode: only a new
//    login. The code the tool printed stays valid beside the next launcher run's own (a reset made while the host was
//    stopped), until it is used, expires or is voided; a running host is told over the pipe (`reload-admin` → reload()).
//  - Passwords: 10–128 characters, not the username or the server name; scrypt with the account parameters
//    (N=2^15, r=8, p=3) in the same `scrypt$N$r$p$salt$hash` format as auth/crypto.ts (so `admin-set` can use
//    hashPassword). Host-PC logins run on their OWN scrypt lane, so a LAN login flood can't delay them.
//  - Sessions: 32 random bytes, stored as sha256 in admin_sessions with address, via, last_action and reauth_at. A
//    session works only from the address and route (`via`) that created it. Idle timeout (admin.idleMinutes, default
//    30), absolute 12 h, at most 5 per principal (a new login ends only sessions on a route no more trusted than its
//    own: a remote login never ends the host PC's); all revoked on a password change (except the caller's) or reset.
//  - Step-up: a ★ capability needs the password within the last admin.stepUpMinutes (default 10) of DELIBERATE
//    activity. Each deliberate call made while fresh keeps the session fresh (reauth_at = now); a gap longer than the
//    window makes it stale until `reauth`. Passive calls (polls) never refresh it.
//  - admin.liveKeepsAlive (host PC only): an open Live view (a keep-alive poll) keeps the session alive for at most
//    3 h after the last deliberate action. It never refreshes step-up freshness.
//  - Login throttle: 5 failures per 10 minutes per address block that address for 15 minutes (429); 30 remote
//    failures per hour pause remote admin sign-in for 1 h (a banner). The host PC is never locked out by LAN
//    attempts; on the host PC itself 5 failures mean a 60 s wait, doubling up to 15 minutes.
//  - Every login, failure, logout, re-auth, setup, password change and reset is audited (mod_actions): each wrong
//    setup code, each wrong password, and refused attempts (throttled, remote paused, remote off, not the host PC,
//    and those refused at the door by the listener or the API: auditRefusedAttempt) coalesced to one row per address
//    and kind per minute with a count (written on the next refusal, once the minute is over, or at close); the
//    remote pause itself gets a row.
//  - A rename of the host admin (setup after a reset, `admin-set`) moves its bans to the new name: they stay host
//    bans (hostAdminNames also knows every earlier name from the audit trail, read once and then incrementally).
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { USERNAME_RE } from '../../shared/protocol';
import { SCRYPT_PARAMS, scryptMaxmem, type ScryptParams } from '../auth/crypto';
import { openProtectedDb } from '../db/guard';
import { parseDomainList, type EmailDomain, type HostSettings } from '../settings/schema';
import {
  REMOTE_OFF, capabilitiesOf, hostPrincipal, type Capability, type ModeratorTier, type Principal, type RemoteAccess, type SessionVia,
} from './capabilities';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------

/** Crockford base32 (no I, L, O, U): the setup code's alphabet (the same as src/lan/launch.ts). */
export const SETUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SETUP_CODE_LENGTH = 8;
export const SETUP_CODE_TTL_MS = 30 * MIN;
export const SETUP_MAX_ATTEMPTS = 5;
export const SETUP_LOCK_BASE_MS = 60 * SEC;
export const SETUP_LOCK_MAX_MS = 15 * MIN;

export const ADMIN_PASSWORD_MIN = 10;
export const ADMIN_PASSWORD_MAX = 128;

export const SESSION_ABSOLUTE_MS = 12 * HOUR;
export const MAX_SESSIONS_PER_PRINCIPAL = 5;
/**
 * How trusted a session's route is. To stay within MAX_SESSIONS_PER_PRINCIPAL a new login ends only sessions on a
 * route no more trusted than its own (least trusted first, then least recently seen): a remote login never ends the
 * host PC's session. With nothing it may end, the login is refused (409 tooManySessions).
 */
export const SESSION_VIA_RANK: Readonly<Record<SessionVia, number>> = Object.freeze({ local: 3, direct: 2, https: 1, proxy: 1 });
/** admin.liveKeepsAlive: at most this long after the last deliberate action. */
export const LIVE_KEEPALIVE_MAX_MS = 3 * HOUR;

export const LOGIN_FAILS_PER_ADDRESS = 5;
export const LOGIN_FAIL_WINDOW_MS = 10 * MIN;
export const LOGIN_ADDRESS_BLOCK_MS = 15 * MIN;
export const REMOTE_FAILS_PER_HOUR = 30;
export const REMOTE_PAUSE_MS = HOUR;
export const HOST_PC_FAILS = 5;
export const HOST_PC_LOCK_BASE_MS = 60 * SEC;
export const HOST_PC_LOCK_MAX_MS = 15 * MIN;
/** Logins waiting for a remote scrypt slot beyond this answer 429 at once. */
export const REMOTE_LANE_QUEUE = 16;
/** Refused sign-ins (throttled, remote off, …) are audited once per address and kind in this window, with a count. */
export const REFUSAL_AUDIT_COALESCE_MS = 60 * SEC;

/** Admin session tokens look like this (game tokens are bare hex, so one is never mistaken for the other). */
export const ADMIN_TOKEN_PREFIX = 'vsadm_';
export const ADMIN_TOKEN_RE = /^vsadm_[0-9a-f]{64}$/;

/** The actor id host-admin actions are audited under (mod_actions.actor_account_id). */
export const HOST_ACTOR_ID = 'host';

/**
 * hostAdminNames' read of the audit rows in (from, to]: a rowid range on mod_actions (`id` is its INTEGER PRIMARY KEY),
 * so only the rows written since the last call are read. Parameters: from, to, from, to.
 */
export const HOST_NAMES_SINCE_SQL = `SELECT lower(trim(actor_name)) AS n FROM mod_actions WHERE id > ? AND id <= ? AND actor_account_id = '${HOST_ACTOR_ID}' AND actor_name IS NOT NULL
  UNION SELECT lower(trim(target_name)) AS n FROM mod_actions WHERE id > ? AND id <= ? AND action IN ('admin-set', 'admin-reset') AND target_name IS NOT NULL`;

export const ADMIN_ERR = {
  notSignedIn: 'Not signed in',
  sessionEnded: 'Your session ended. Sign in again.',
  idle: 'Signed out after a while without activity. Sign in again.',
  expired: 'Your session reached its time limit. Sign in again.',
  elsewhere: 'This session belongs to another device or address. Sign in again.',
  wrongLogin: 'Wrong username or password.',
  wrongPassword: 'That password is not right.',
  moderatorViewOff: 'The moderator view is off on this server. Ask the host.',
  needsHttps: 'The control panel needs the secure address (https).',
  remotePaused: 'Remote sign-in to the control panel is paused for an hour after too many failed attempts. Use the host PC.',
  tooMany: 'Too many failed sign-ins. Try again later.',
  busy: 'The server is busy. Try again in a moment.',
  setupHostPc: 'Setup only works on the host PC.',
  alreadySetUp: 'This server already has a host admin.',
  setupCodeWrong: 'That setup code is not right.',
  setupCodeVoid: 'Too many wrong setup codes. A new code is shown in the Voidswarm window (or restart Voidswarm).',
  setupCodeExpired: 'That setup code has expired. A new code is shown in the Voidswarm window (or restart Voidswarm).',
  noSetupCode: 'There is no setup code yet. Restart Voidswarm to get one.',
  setupBusy: 'Setup is already running.',
  reauth: 'Enter your password again to continue.',
  moderatorPassword: 'Moderators change their password in the game (Account).',
  passwordHere: 'Change the host admin password on the host PC (or over a connection your devices trust).',
  playerName: "That name is a player's username on this server. Pick another one.",
  tooManySessions: 'This login already has the most control-panel sessions open. Sign out of one (on the host PC if need be) and try again.',
  noHostAdmin: 'No host admin yet. On the host PC, finish setup in the control panel; on a VPS run `voidswarm-mod admin-set <name>`.',
} as const;

// ------------------------------------------------------------------------------------------
// Policy (from the settings)
// ------------------------------------------------------------------------------------------

/** The settings the admin sessions follow (read live on every call). */
export interface AdminPolicy {
  remoteAccess: RemoteAccess;
  /** network.devicesTrustCert (IT-pushed root, or the host's own certificate). */
  devicesTrustCert: boolean;
  idleMinutes: number;
  stepUpMinutes: number;
  liveKeepsAlive: boolean;
  /** moderators.view */
  moderatorView: boolean;
  /** moderators.logSearch */
  moderatorLogSearch: boolean;
  moderatorTier: ModeratorTier;
  serverName: string;
}

export const DEFAULT_ADMIN_POLICY: Readonly<AdminPolicy> = Object.freeze({
  remoteAccess: 'off', devicesTrustCert: false, idleMinutes: 30, stepUpMinutes: 10, liveKeepsAlive: true,
  moderatorView: false, moderatorLogSearch: false, moderatorTier: 'limited', serverName: 'Voidswarm',
});

export function adminPolicyOf(s: HostSettings): AdminPolicy {
  return {
    remoteAccess: s.admin.remoteAccess,
    devicesTrustCert: s.network.devicesTrustCert || s.network.ownCertificate,
    idleMinutes: s.admin.idleMinutes,
    stepUpMinutes: s.admin.stepUpMinutes,
    liveKeepsAlive: s.admin.liveKeepsAlive,
    moderatorView: s.moderators.view,
    moderatorLogSearch: s.moderators.logSearch,
    moderatorTier: s.moderators.tier,
    serverName: s.serverName,
  };
}

const clampMin = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// ------------------------------------------------------------------------------------------
// Callers and sessions
// ------------------------------------------------------------------------------------------

/** What the listener knows about a request (listeners.ts AdminRequestContext carries these). */
export interface AdminCaller {
  /** The client address as a rate-limit key; 'loopback' for any loopback socket. */
  address: string;
  via: SessionVia;
  /** isHostPc (listeners.ts). */
  hostPc: boolean;
  /** TLS (or a trusted proxy's https) in front of the request. */
  secure: boolean;
  /** The TLS is one the devices really trust (or a public certificate behind a trusted proxy). */
  trustedTls: boolean;
}

export type AdminKind = 'host' | 'moderator';

export interface AdminSession {
  tokenHash: string;
  /** 'host:<id>' or 'mod:<accountId>' (admin_sessions.principal). */
  principalId: string;
  kind: AdminKind;
  /** The moderator's account id (null for the host admin). */
  accountId: string | null;
  username: string;
  /** Recomputed on every call from `via`, the caller and the settings. */
  principal: Principal;
  /** A remote session over TLS the devices don't really trust (capped to the `limited` set). */
  untrustedTls: boolean;
  via: SessionVia;
  address: string | null;
  createdAt: number;
  lastAction: number;
  lastSeen: number;
  reauthAt: number;
  /** Absolute limit. */
  expiresAt: number;
  /** Step-up freshness at the START of this call (before it counted as activity). */
  fresh: boolean;
}

/** The §5.15 Session object. */
export interface SessionInfo {
  principal: Principal;
  username: string;
  /** When the session ends if nothing else happens (idle or absolute, whichever is first). */
  expiresAt: number;
  idleSec: number;
  /** ★ actions work until then (0 = stale: the panel asks for the password first). */
  freshUntil: number;
  capabilities: Capability[];
}

export type Fail = {
  ok: false; status: number; error: string; retryAfter?: number; attemptsLeft?: number; field?: string; reauth?: boolean; wrongPassword?: boolean;
  /** login: there is no usable host admin yet (setup on the host PC, or `admin-set` on a VPS). */
  needsSetup?: boolean;
};
export type Ok<T> = { ok: true } & T;
export type AdminResult<T> = Ok<T> | Fail;
const fail = (status: number, error: string, extra: Omit<Fail, 'ok' | 'status' | 'error'> = {}): Fail => ({ ok: false, status, error, ...extra });
const retrySec = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

export interface AdminState {
  /** No usable host admin password: the setup page is needed. */
  setupPending: boolean;
  /** 'first' = never set up (players stay off the LAN until done); 'reset' = after Reset admin password. */
  setupKind: 'first' | 'reset' | null;
  username: string | null;
}

export interface SetupInput {
  setupCode?: unknown;
  username?: unknown;
  password?: unknown;
  preset?: unknown;
  serverName?: unknown;
  accountsMode?: unknown;
  /**
   * School only, optional (owner decision 6): the Allowed email domains, as Settings → Accounts takes them (a list of
   * "<domain>" / { domain, subdomains }). Empty or absent = any domain (the preset leaves the list empty).
   */
  domains?: unknown;
}

/** What first-run setup chose (applied by the caller through SettingsService.applyPreset). */
export interface SetupChoices {
  preset: 'home' | 'school';
  serverName: string;
  accountsMode: 'email' | 'roster';
  /** School: the Allowed email domains the host typed (normalized; present only when not empty). */
  domains?: EmailDomain[];
}

/** A domain list in a Home setup: the lock is offered in School setup only (Home sets it in Settings → Accounts). */
export const SETUP_DOMAINS_SCHOOL_ONLY = 'The email domain lock is part of School setup. At home, set it later in Settings → Accounts.';

export interface SetupHooks {
  /** First-run setup only: apply the preset and server name. A failure answers the request; the code stays valid. */
  apply?: (choices: SetupChoices, actor: { accountId: string; name: string }) => Promise<{ ok: true } | { ok: false; status?: number; error: string; field?: string }>;
}

export interface AdminAuditEvent {
  ts: number;
  actorId: string;
  actorName: string;
  action: string;
  targetAccountId?: string | null;
  targetName?: string | null;
  address?: string | null;
  reason: string;
}

/** Moderator checks. Defaults read the accounts / admins / bans tables over the HostAdmin connection. */
export interface ModeratorDirectory {
  /** By username (case-insensitive): the account and its password hash, or null. */
  find(username: string): { accountId: string; username: string; passHash: string; status: string } | null;
  isModerator(accountId: string): boolean;
  /** The account exists and its status is 'active'. */
  isActive(accountId: string): boolean;
  /** An active account ban. */
  isBanned(accountId: string, now: number): boolean;
}

export interface HostAdminOptions {
  /** The auth DB (migrated to v4 by the AuthService first). */
  dbPath: string;
  policy?: () => AdminPolicy;
  now?: () => number;
  log?: (line: string) => void;
  /** data\secrets\pepper.key: setup codes are stored as HMAC(pepper, code) when given (sha256 otherwise). */
  pepper?: Uint8Array | string | null;
  /** A fresh setup code the host must see (the launcher prints it in the console; never log it). */
  onSetupCode?: (code: string, why: 'void' | 'expired') => void;
  /** Setup finished, or an outside reset changed the state (the child tells the launcher). */
  onStateChange?: (s: AdminState) => void;
  /** Default: a row in mod_actions over the HostAdmin connection. */
  audit?: (e: AdminAuditEvent) => void;
  /** Override parts of the moderator checks (tests, or the AuthService's own view). */
  moderators?: Partial<ModeratorDirectory>;
  /** Test only: cheaper scrypt parameters for NEW hashes (stored hashes verify with their own). */
  passwordParams?: Readonly<ScryptParams>;
  /** busy_timeout of the connection (default 250 ms: it shares the game thread). */
  busyTimeoutMs?: number;
}

// ------------------------------------------------------------------------------------------
// Setup codes
// ------------------------------------------------------------------------------------------

/** 8 Crockford base32 characters (40 bits). */
export function newSetupCode(): string {
  let s = '';
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) s += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  return s;
}

/** K7QP4MXD → K7QP-4MXD. */
export const formatSetupCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * What the host typed → the canonical code, or null. Case-insensitive; dashes and spaces ignored; Crockford's
 * look-alikes read as the digits (O → 0, I and L → 1).
 */
export function normalizeSetupCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== SETUP_CODE_LENGTH) return null;
  for (const ch of s) if (!SETUP_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/**
 * The stored form of a setup code: `h1$<hex>` = HMAC-SHA256(pepper, …) when a pepper is given, `s1$<hex>` = SHA-256
 * otherwise. Self-describing, so a code written by a tool without the pepper still verifies in the server.
 */
export function setupCodeHash(code: string, pepper?: Uint8Array | string | null): string {
  const norm = normalizeSetupCode(code);
  if (!norm) throw new Error('not a setup code');
  const msg = `voidswarm-setup\n${norm}`;
  if (pepper && pepper.length) return `h1$${createHmac('sha256', pepper).update(msg, 'utf8').digest('hex')}`;
  return `s1$${createHash('sha256').update(msg, 'utf8').digest('hex')}`;
}

function setupCodeMatches(stored: string, code: string, pepper: Uint8Array | string | null): boolean {
  if (typeof stored !== 'string' || !stored) return false;
  let expected: string;
  try {
    if (stored.startsWith('h1$')) { if (!pepper || !pepper.length) return false; expected = setupCodeHash(code, pepper); }
    else if (stored.startsWith('s1$')) expected = setupCodeHash(code, null);
    else return false;
  } catch { return false; }
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 60 s × 2^(voids − 1), at most 15 minutes. */
export function setupLockMs(voids: number): number {
  if (voids <= 0) return 0;
  return Math.min(SETUP_LOCK_MAX_MS, SETUP_LOCK_BASE_MS * 2 ** Math.min(voids - 1, 20));
}

/** 60 s × 2^level on the host PC, at most 15 minutes. */
export function hostPcLockMs(level: number): number {
  return Math.min(HOST_PC_LOCK_MAX_MS, HOST_PC_LOCK_BASE_MS * 2 ** Math.min(Math.max(0, level), 20));
}

// ------------------------------------------------------------------------------------------
// Passwords (own scrypt lanes)
// ------------------------------------------------------------------------------------------

/** 10–128 characters, not the username or the server name. null = acceptable. */
export function adminPasswordProblem(password: unknown, username: string, serverName: string): string | null {
  if (typeof password !== 'string') return 'Choose a password.';
  if (password.length < ADMIN_PASSWORD_MIN) return `The password needs at least ${ADMIN_PASSWORD_MIN} characters.`;
  if (password.length > ADMIN_PASSWORD_MAX) return `The password can have at most ${ADMIN_PASSWORD_MAX} characters.`;
  const p = password.trim().toLowerCase();
  if (username && p === username.trim().toLowerCase()) return "The password can't be the username.";
  if (serverName && p === serverName.trim().toLowerCase()) return "The password can't be the server name.";
  return null;
}

/** The host admin username: the account rule (3–16 letters, digits, _ or -). */
export function adminUsernameProblem(username: unknown): string | null {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return 'The username needs 3–16 letters, digits, _ or -.';
  return null;
}

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; expected: Buffer }

/** The auth/crypto.ts format and bounds (a tampered row can't ask for absurd CPU or memory). */
function parseHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (128 * N * r > 128 * 1024 * 1024) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return null;
  return { N, r, p, salt, expected };
}

/** A usable stored password hash (a reset leaves NULL). */
export const isUsableHash = (stored: unknown): boolean => parseHash(stored) !== null;

function runScrypt(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N, r, p, maxmem: scryptMaxmem(N, r, p) };
  return new Promise((resolve, reject) => { scrypt(password, salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))); });
}

/** A one-at-a-time scrypt queue (the host PC's and the remote callers' are separate). */
class Lane {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly maxQueue: number) {}
  get full(): boolean { return this.active > 0 && this.waiting.length >= this.maxQueue; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active > 0) await new Promise<void>((r) => this.waiting.push(r));
    else this.active = 1;
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active = 0;
    }
  }
}

/** `scrypt$N$r$p$salt$hash` (16-byte salt), the auth/crypto.ts format. */
export async function hashAdminPassword(password: string, params: Readonly<ScryptParams> = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const key = await runScrypt(password, salt, params.keylen, params.N, params.r, params.p);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time verify; a malformed or missing hash still costs one scrypt at `pad` params (no timing tell). */
async function verifyAdminPassword(password: string, stored: unknown, pad: Readonly<ScryptParams>): Promise<boolean> {
  const h = parseHash(stored);
  if (!h) {
    await runScrypt(password, Buffer.alloc(16), 32, pad.N, pad.r, pad.p).catch(() => undefined);
    return false;
  }
  try {
    const actual = await runScrypt(password, h.salt, h.expected.length, h.N, h.r, h.p);
    return actual.length === h.expected.length && timingSafeEqual(actual, h.expected);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------
// Rows
// ------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0) || 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

interface AdminRow { id: string; username: string; passHash: string | null }
interface SessionRow {
  tokenHash: string; principal: string; createdAt: number; lastSeen: number; lastAction: number; reauthAt: number;
  expiresAt: number; address: string | null; via: string;
}
interface SetupRow { codeHash: string; expiresAt: number; attempts: number; lockedUntil: number }

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const newToken = (): string => `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
const newId = (): string => randomBytes(16).toString('hex');

/** Opens (and checks) the connection every helper below uses. The DB must be schema v4 or newer. */
export function openAdminDb(dbPath: string, busyTimeoutMs = 250): DatabaseSync {
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) {
    throw new Error(`[admin] no database at ${dbPath || '(none)'} — construct the AuthService first (it creates and migrates the file)`);
  }
  const db = openProtectedDb(dbPath, { busyTimeoutMs });
  try {
    const v = num((db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version);
    if (v < 4) throw new Error(`[admin] auth DB schema v${v} has no host admin tables (need v4) — construct the AuthService first`);
    return db;
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
}

function readAdminRow(db: DatabaseSync): AdminRow | null {
  const r = db.prepare('SELECT id, username, pass_hash FROM host_admins ORDER BY created_at, id LIMIT 1').get() as Row | undefined;
  return r ? { id: String(r.id), username: String(r.username), passHash: strOrNull(r.pass_hash) } : null;
}

function upsertSetupRow(db: DatabaseSync, k: string, r: SetupRow): void {
  db.prepare(`INSERT INTO host_setup (k, code_hash, expires_at, attempts, locked_until) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(k) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
              attempts = excluded.attempts, locked_until = excluded.locked_until`)
    .run(k, r.codeHash, Math.floor(r.expiresAt), Math.floor(r.attempts), Math.floor(r.lockedUntil));
}

function readSetupRow(db: DatabaseSync, k: string): SetupRow | null {
  const r = db.prepare('SELECT code_hash, expires_at, attempts, locked_until FROM host_setup WHERE k = ?').get(k) as Row | undefined;
  return r ? { codeHash: String(r.code_hash ?? ''), expiresAt: num(r.expires_at), attempts: num(r.attempts), lockedUntil: num(r.locked_until) } : null;
}

/**
 * The host admin's login changed name (setup after a reset, `admin-set`): its bans follow it (bans.by), so they stay
 * host bans that trusted moderators can't lift (§5.2). Returns how many were moved. Inside the caller's transaction.
 */
function moveHostBans(db: DatabaseSync, from: string, to: string): number {
  if (!from || from.trim().toLowerCase() === to.trim().toLowerCase()) return 0;
  return num(db.prepare('UPDATE bans SET by = ? WHERE lower(trim(by)) = ?').run(to, from.trim().toLowerCase()).changes);
}

function writeAudit(db: DatabaseSync, e: AdminAuditEvent): void {
  db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, target_address,
                duration_sec, expires_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
    .run(Math.floor(e.ts), e.actorId.slice(0, 80), e.actorName.slice(0, 80), e.action.slice(0, 40),
      e.targetAccountId ?? null, e.targetName ? e.targetName.slice(0, 80) : null, e.address ?? null, e.reason.slice(0, 300));
}

/**
 * host_setup row keys: the current code, the last launcher code installed, how many codes were voided, and the code
 * `Reset admin password.cmd` printed. The tool's code stays valid (until it expires or is voided) when the next
 * launcher run installs its own, so a reset made while the host was stopped still works with the printed code.
 */
const K_CODE = 'code';
const K_LAUNCH = 'launch';
const K_VOIDS = 'voids';
const K_TOOL = 'tool';

function installCode(db: DatabaseSync, code: string, pepper: Uint8Array | string | null, now: number, opts: { clearWait: boolean; lockedUntil?: number }): void {
  const lockedUntil = opts.clearWait ? 0 : Math.max(0, opts.lockedUntil ?? 0);
  upsertSetupRow(db, K_CODE, { codeHash: setupCodeHash(code, pepper), expiresAt: Math.max(now, lockedUntil) + SETUP_CODE_TTL_MS, attempts: 0, lockedUntil });
  if (opts.clearWait) upsertSetupRow(db, K_VOIDS, { codeHash: '', expiresAt: 0, attempts: 0, lockedUntil: 0 });
}

// ------------------------------------------------------------------------------------------
// Tool / CLI entry points (Reset admin password.cmd, `npm run mod -- admin-set`)
// ------------------------------------------------------------------------------------------

export interface ResetResult {
  /** The host admin's username before the reset (null: none was ever set up). */
  username: string | null;
  sessionsRevoked: number;
  /** The new setup code (the tool prints it; formatSetupCode for display). */
  setupCode: string;
}

/**
 * `Reset admin password.cmd` / `tool admin-reset` (§4.10), whether or not the host is running: 1. clears the password
 * hash (the row and its audit history stay); 2. revokes the host admin's sessions; installs a new setup code (proof
 * of presence clears the wait). The caller then tells a running host over the pipe (`reload-admin`) and prints the
 * code. Pass the same pepper the server uses (data\secrets\pepper.key) or none: the stored form says which.
 */
export function resetHostAdmin(db: DatabaseSync, opts: { pepper?: Uint8Array | string | null; now?: number; setupCode?: string; actor?: string } = {}): ResetResult {
  const now = opts.now ?? Date.now();
  const code = opts.setupCode ? normalizeSetupCode(opts.setupCode) : newSetupCode();
  if (!code) throw new Error('not a setup code');
  const row = readAdminRow(db);
  let revoked = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (row) db.prepare('UPDATE host_admins SET pass_hash = NULL, pass_changed_at = ? WHERE id = ?').run(now, row.id);
    revoked = num(db.prepare("DELETE FROM admin_sessions WHERE principal LIKE 'host:%'").run().changes);
    installCode(db, code, opts.pepper ?? null, now, { clearWait: true });
    upsertSetupRow(db, K_TOOL, { codeHash: setupCodeHash(code, opts.pepper ?? null), expiresAt: now + SETUP_CODE_TTL_MS, attempts: 0, lockedUntil: 0 });
    writeAudit(db, {
      ts: now, actorId: opts.actor ?? 'cli', actorName: opts.actor ?? 'cli', action: 'admin-reset', targetName: row?.username ?? null,
      reason: `host admin password cleared; ${revoked} session(s) revoked; new setup code issued`,
    });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    throw e;
  }
  return { username: row?.username ?? null, sessionsRevoked: revoked, setupCode: code };
}

/**
 * The whole `Reset admin password.cmd` / `tool admin-reset` step on the DB file (§4.10), for a tool outside the
 * server: open the auth DB on a protected connection (it may be the running host's: a longer busy timeout), reset
 * (resetHostAdmin), close. The caller then tells a running host over the pipe (`reload-admin`, src/lan/pipe.ts
 * sendCommand with data\secrets\pipe.key: the child calls HostAdmin.reload()) and prints
 * formatSetupCode(result.setupCode). The printed code works whether or not the host was running: a launcher started
 * afterwards keeps it valid beside its own code.
 */
export function resetHostAdminAt(dbPath: string, opts: { pepper?: Uint8Array | string | null; now?: number; setupCode?: string; actor?: string; busyTimeoutMs?: number } = {}): ResetResult {
  const db = openAdminDb(dbPath, opts.busyTimeoutMs ?? 5000);
  try {
    return resetHostAdmin(db, opts);
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/**
 * `npm run mod -- admin-set <username>` (the VPS; §4.10 "VPS parity"): create the host admin, or replace its
 * username and password. Revokes its sessions and clears any pending setup. Throws with a plain message on a bad
 * username or password, or a username a player account already has.
 */
export async function setHostAdminCredential(db: DatabaseSync, input: { username: string; password: string; serverName?: string; now?: number; actor?: string; params?: Readonly<ScryptParams> }): Promise<{ created: boolean; sessionsRevoked: number }> {
  const now = input.now ?? Date.now();
  const uProblem = adminUsernameProblem(input.username);
  if (uProblem) throw new Error(uProblem);
  const pProblem = adminPasswordProblem(input.password, input.username, input.serverName ?? '');
  if (pProblem) throw new Error(pProblem);
  // As setup: never a player's username (the Zone would then refuse that player's own name as reserved).
  const isPlayerName = (): boolean => !!db.prepare('SELECT 1 AS x FROM accounts WHERE username_lower = ?').get(input.username.toLowerCase());
  if (isPlayerName()) throw new Error(ADMIN_ERR.playerName);
  const hash = await hashAdminPassword(input.password, input.params ?? SCRYPT_PARAMS);
  const row = readAdminRow(db);
  let revoked = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (isPlayerName()) throw new Error(ADMIN_ERR.playerName); // taken while the password was hashing
    let moved = 0;
    if (row) {
      db.prepare('UPDATE host_admins SET username = ?, username_lower = ?, pass_hash = ?, pass_changed_at = ? WHERE id = ?')
        .run(input.username, input.username.toLowerCase(), hash, now, row.id);
      moved = moveHostBans(db, row.username, input.username);
    } else {
      db.prepare('INSERT INTO host_admins (id, username, username_lower, pass_hash, created_at, last_login, pass_changed_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
        .run(newId(), input.username, input.username.toLowerCase(), hash, now, now);
    }
    revoked = num(db.prepare("DELETE FROM admin_sessions WHERE principal LIKE 'host:%'").run().changes);
    db.prepare('DELETE FROM host_setup').run();
    const renamed = row && row.username.toLowerCase() !== input.username.toLowerCase() ? ` (renamed from ${row.username}; ${moved} host ban(s) moved to the new name)` : '';
    writeAudit(db, { ts: now, actorId: input.actor ?? 'cli', actorName: input.actor ?? 'cli', action: 'admin-set', targetName: input.username, reason: row ? `host admin login replaced${renamed}` : 'host admin created' });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    throw e;
  }
  return { created: !row, sessionsRevoked: revoked };
}

/** The host admin's state without opening a HostAdmin (the tool, the CLI). */
export function hostAdminState(db: DatabaseSync): AdminState {
  const row = readAdminRow(db);
  if (!row) return { setupPending: true, setupKind: 'first', username: null };
  if (!isUsableHash(row.passHash)) return { setupPending: true, setupKind: 'reset', username: row.username };
  return { setupPending: false, setupKind: null, username: row.username };
}

// ------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------

interface Throttle { fails: number[]; pending: number; blockedUntil: number }
interface RefusalNote { at: number; folded: number; reason: string; actorName: string; address: string | null }

export class HostAdmin {
  private readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private readonly policyOf: () => AdminPolicy;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly pepper: Uint8Array | string | null;
  private readonly onSetupCode: HostAdminOptions['onSetupCode'];
  private readonly onStateChange: HostAdminOptions['onStateChange'];
  private readonly auditSink: (e: AdminAuditEvent) => void;
  private readonly mods: ModeratorDirectory;
  private readonly params: Readonly<ScryptParams>;
  /** The host PC's own scrypt lane, and everyone else's. */
  private readonly hostLane = new Lane(64);
  private readonly remoteLane = new Lane(REMOTE_LANE_QUEUE);
  private readonly addrThrottle = new Map<string, Throttle>();
  private remoteFails: number[] = [];
  private remotePausedUntil = 0;
  private hostPc = { fails: 0, pending: 0, level: 0, lockedUntil: 0 };
  /** Coalesced refusal audits: the last row written per address and kind, and how many were folded in since. */
  private readonly refusalNotes = new Map<string, RefusalNote>();
  /** The notes holding a folded count not yet written (flushed after the window, on the next refusal, and at close). */
  private readonly refusalDirty = new Set<string>();
  private refusalTimer: ReturnType<typeof setTimeout> | null = null;
  private setupInFlight = false;
  /** hostAdminNames' cache: every earlier host admin name found in the audit trail, and the newest row read. */
  private readonly knownHostNames = new Set<string>();
  private namesMark: { id: number; ts: number } | null = null;
  private lastState: AdminState;
  private warned = new Set<string>();
  private closed = false;

  constructor(opts: HostAdminOptions) {
    this.db = openAdminDb(opts.dbPath, opts.busyTimeoutMs ?? 250);
    this.policyOf = opts.policy ?? (() => DEFAULT_ADMIN_POLICY);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => { /* silent */ });
    this.pepper = opts.pepper && opts.pepper.length ? opts.pepper : null;
    this.onSetupCode = opts.onSetupCode;
    this.onStateChange = opts.onStateChange;
    this.params = opts.passwordParams ?? SCRYPT_PARAMS;
    const db = this.db;
    const p = (sql: string): StatementSync => db.prepare(sql);
    this.st = {
      session: p('SELECT * FROM admin_sessions WHERE token_hash = ?'),
      insertSession: p(`INSERT INTO admin_sessions (token_hash, principal, created_at, last_seen, last_action, reauth_at, expires_at, address, via)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      touch: p('UPDATE admin_sessions SET last_seen = ?, last_action = ?, reauth_at = ? WHERE token_hash = ?'),
      // activity(): after the handler ran, so never move a value back (a reauth may have landed meanwhile).
      touchForward: p(`UPDATE admin_sessions SET last_seen = max(last_seen, ?), last_action = max(last_action, ?), reauth_at = max(reauth_at, ?)
                       WHERE token_hash = ?`),
      deleteSession: p('DELETE FROM admin_sessions WHERE token_hash = ?'),
      deletePrincipal: p('DELETE FROM admin_sessions WHERE principal = ?'),
      deletePrincipalExcept: p('DELETE FROM admin_sessions WHERE principal = ? AND token_hash <> ?'),
      principalSessions: p('SELECT token_hash, via, last_seen, created_at FROM admin_sessions WHERE principal = ? ORDER BY last_seen DESC, created_at DESC'),
      deleteExpired: p('DELETE FROM admin_sessions WHERE expires_at <= ?'),
      setLastLogin: p('UPDATE host_admins SET last_login = ? WHERE id = ?'),
      account: p('SELECT id, username, pass_hash, status FROM accounts WHERE username_lower = ?'),
      accountStatus: p('SELECT status FROM accounts WHERE id = ?'),
      isMod: p('SELECT 1 AS x FROM admins WHERE account_id = ?'),
      banned: p(`SELECT 1 AS x FROM bans WHERE kind = 'ban' AND scope = 'account' AND account_id = ? AND revoked_at IS NULL
                   AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`),
      playerName: p('SELECT 1 AS x FROM accounts WHERE username_lower = ?'),
      lastAction: p('SELECT id, ts FROM mod_actions ORDER BY id DESC LIMIT 1'),
      actionTs: p('SELECT ts FROM mod_actions WHERE id = ?'),
      hostNamesIn: p(HOST_NAMES_SINCE_SQL),
    };
    const dflt: ModeratorDirectory = {
      find: (username) => {
        const r = this.st.account!.get(username.toLowerCase()) as Row | undefined;
        return r ? { accountId: String(r.id), username: String(r.username), passHash: String(r.pass_hash ?? ''), status: String(r.status ?? 'active') } : null;
      },
      isModerator: (id) => !!this.st.isMod!.get(id),
      isActive: (id) => String((this.st.accountStatus!.get(id) as Row | undefined)?.status ?? '') === 'active',
      isBanned: (id, now) => !!this.st.banned!.get(id, Math.floor(now)),
    };
    this.mods = { ...dflt, ...(opts.moderators ?? {}) };
    this.auditSink = opts.audit ?? ((e) => writeAudit(this.db, e));
    this.lastState = this.state();
    // The whole audit trail is read for earlier host names once, at startup (later calls read only new rows).
    try { this.scanHostNames(); } catch (e) {
      this.warnOnce('host-names', `[admin] could not read the host admin's earlier names: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Construct over `dbPath` (the AuthService must have migrated it to v4). */
  static open(opts: HostAdminOptions): HostAdmin { return new HostAdmin(opts); }

  private policy(): AdminPolicy {
    let p: AdminPolicy;
    try { p = this.policyOf(); } catch { p = DEFAULT_ADMIN_POLICY; }
    return p ?? DEFAULT_ADMIN_POLICY;
  }

  /** The admin policy in force (the settings, read live). */
  currentPolicy(): AdminPolicy { return this.policy(); }
  private idleMs(p = this.policy()): number { return clampMin(p.idleMinutes, 5, 240, 30) * MIN; }
  private stepUpMs(p = this.policy()): number { return clampMin(p.stepUpMinutes, 5, 30, 10) * MIN; }

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(line);
  }

  private audit(e: Omit<AdminAuditEvent, 'ts'>): void {
    try { this.auditSink({ ts: this.now(), ...e }); } catch (err) {
      this.warnOnce('audit', `[admin] could not write the audit trail: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * A refused sign-in attempt (throttled, remote sign-in paused, remote access off, …) as a `login-fail` row: at most
   * one per address and kind per REFUSAL_AUDIT_COALESCE_MS, carrying how many were folded into it since the last one
   * (a flood can't fill the audit trail, and every refusal is still accounted for). A folded count is written on the
   * next refusal of that kind, or once its window has passed (a timer, and any later refusal), or at close().
   */
  private auditRefusal(caller: Pick<AdminCaller, 'address'>, kind: string, reason: string, actorName = '(unknown name)'): void {
    const now = this.now();
    const key = `${caller.address}|${kind}`;
    const address = caller.address === 'loopback' ? null : caller.address;
    const note = this.refusalNotes.get(key);
    if (note && now - note.at < REFUSAL_AUDIT_COALESCE_MS) {
      note.folded++;
      note.reason = reason;
      note.actorName = actorName;
      this.refusalDirty.add(key);
      this.armRefusalFlush();
      return;
    }
    if (this.refusalNotes.size > 10_000) {
      for (const [k, n] of this.refusalNotes) if (now - n.at >= REFUSAL_AUDIT_COALESCE_MS && !n.folded) this.refusalNotes.delete(k);
    }
    const folded = note?.folded ?? 0;
    this.refusalNotes.set(key, { at: now, folded: 0, reason, actorName, address });
    this.refusalDirty.delete(key);
    this.writeRefusal(actorName, address, reason, folded);
    this.flushRefusals(false);
  }

  /**
   * A sign-in or setup attempt refused before it reached this class: the admin listener's place rules (remote access
   * off, plain http, a forwarding header, a foreign Host; listeners.ts onRefuse) or the API's own (Origin, method,
   * Content-Type, host PC only, the body; http.ts). Audited like the other refusals, coalesced per address and kind
   * per minute with a count (§4.10 "every login and every failure is audited"). `address`: a rate-limit key.
   */
  auditRefusedAttempt(address: string, what: 'login' | 'setup', status: number, reason: string): void {
    if (this.closed) return;
    const addr = typeof address === 'string' && address ? address.slice(0, 80) : 'unknown';
    const label = what === 'setup' ? 'setup' : 'sign-in';
    this.auditRefusal({ address: addr }, `door:${what}:${status}`, `${label} refused (${status}): ${String(reason ?? '').slice(0, 160)}`, what === 'setup' ? '(setup)' : '(unknown name)');
  }

  private writeRefusal(actorName: string, address: string | null, reason: string, folded: number): void {
    this.audit({ actorId: 'unknown', actorName, action: 'login-fail', address, reason: `${reason}${folded ? ` (+${folded} more refused since the last note)` : ''}` });
  }

  /** Write the folded counts whose window has passed (all of them with `force`: close). */
  private flushRefusals(force: boolean): void {
    if (!this.refusalDirty.size) return;
    const now = this.now();
    for (const key of [...this.refusalDirty]) {
      const n = this.refusalNotes.get(key);
      if (!n || !n.folded) { this.refusalDirty.delete(key); continue; }
      if (!force && now - n.at < REFUSAL_AUDIT_COALESCE_MS) continue;
      this.writeRefusal(n.actorName, n.address, n.reason, n.folded);
      n.folded = 0;
      n.at = now;
      this.refusalDirty.delete(key);
    }
  }

  private armRefusalFlush(): void {
    if (this.refusalTimer || this.closed) return;
    this.refusalTimer = setTimeout(() => {
      this.refusalTimer = null;
      if (this.closed) return;
      this.flushRefusals(false);
      if (this.refusalDirty.size) this.armRefusalFlush();
    }, REFUSAL_AUDIT_COALESCE_MS);
    this.refusalTimer.unref?.();
  }

  // --- state -------------------------------------------------------------------------------

  state(): AdminState { return hostAdminState(this.db); }
  needsSetup(): boolean { return this.state().setupPending; }
  /** The host admin's username (null before setup). */
  hostUsername(): string | null { return readAdminRow(this.db)?.username ?? null; }

  /**
   * Every username the host admin has had, lower case: the current one, the names it acted under (mod_actions rows
   * with actor 'host') and the names `admin-set` / `admin-reset` wrote. Bans made under any of them are host bans
   * (§5.2 "not host bans"). A rename also moves the host's bans to the new name (moveHostBans), which outlives the
   * audit trail's retention; this is the second line. Fails closed: on a read error only the current name is known.
   */
  hostAdminNames(): Set<string> {
    const out = new Set<string>();
    const cur = this.hostUsername();
    if (cur) out.add(cur.trim().toLowerCase());
    try { this.scanHostNames(); } catch (e) {
      this.warnOnce('host-names', `[admin] could not read the host admin's earlier names: ${(e as Error)?.message ?? e}`);
    }
    for (const n of this.knownHostNames) out.add(n);
    return out;
  }

  private noteHostName(name: string | null | undefined): void {
    const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (n) this.knownHostNames.add(n);
  }

  /**
   * Read only the audit rows written since the last call (a rowid range: `id` is the INTEGER PRIMARY KEY), so
   * hostAdminNames costs next to nothing on the game thread however long the trail is (the whole trail is read once,
   * at construction). Rows are only appended; retention deletes the oldest. If the newest row read is gone or is
   * another row (everything was purged and ids restarted) the trail is read again. Names once known stay known
   * (fails closed: a ban under a name the host once had stays a host ban).
   */
  private scanHostNames(): void {
    const top = this.st.lastAction!.get() as Row | undefined;
    if (!top) { this.namesMark = null; return; }
    const topId = num(top.id);
    let from = 0;
    if (this.namesMark) {
      const at = this.st.actionTs!.get(this.namesMark.id) as Row | undefined;
      if (at && num(at.ts) === this.namesMark.ts && topId >= this.namesMark.id) from = this.namesMark.id;
    }
    if (from === topId) return;
    for (const r of this.st.hostNamesIn!.all(from, topId, from, topId) as Row[]) if (typeof r.n === 'string' && r.n) this.knownHostNames.add(r.n);
    this.namesMark = { id: topId, ts: num(top.ts) };
  }

  /** A ban's `by` names the host (the host admin under any of its names, or the host's CLI): see hostAdminNames. */
  isHostBanBy(by: string): boolean {
    const b = String(by ?? '').trim().toLowerCase();
    return b === 'cli' || b === HOST_ACTOR_ID || this.hostAdminNames().has(b);
  }

  /** Players may not use the host admin's username (accounts and guest callsigns; §4.1). */
  isReservedName(name: string): boolean {
    const u = this.hostUsername();
    return !!u && typeof name === 'string' && name.trim().toLowerCase() === u.toLowerCase();
  }

  /** Re-read after an outside change (the pipe's `reload-admin` after Reset admin password). */
  reload(): AdminState {
    const s = this.state();
    const prev = this.lastState;
    this.lastState = s;
    if (s.setupPending !== prev.setupPending || s.setupKind !== prev.setupKind || s.username !== prev.username) {
      this.log(`[admin] host admin state changed outside this server (${s.setupPending ? `setup pending: ${s.setupKind}` : 'set up'})`);
      try { this.onStateChange?.(s); } catch { /* the listener's problem */ }
    }
    return s;
  }

  private stateChanged(): void {
    const s = this.state();
    this.lastState = s;
    try { this.onStateChange?.(s); } catch { /* the listener's problem */ }
  }

  // --- setup code ----------------------------------------------------------------------------

  /**
   * The launcher's code (lan:start). A child restarted by the same launcher passes the same code again: the stored
   * state (attempts, the wait, a code minted after a void or a tool reset) is kept. A new launcher run installs its
   * fresh code and clears the wait (proof of presence). Nothing is stored once setup is done.
   */
  installLaunchCode(code: string): void {
    const norm = normalizeSetupCode(code);
    if (!norm) { this.warnOnce('launch-code', '[admin] the launcher sent no usable setup code'); return; }
    const launch = readSetupRow(this.db, K_LAUNCH);
    const sameRun = !!launch && setupCodeMatches(launch.codeHash, norm, this.pepper);
    const now = this.now();
    if (!this.needsSetup()) {
      // Nothing to install. The run is remembered, so a later reset (the tool's code) survives a child restart.
      this.db.prepare(`DELETE FROM host_setup WHERE k <> '${K_LAUNCH}'`).run();
      if (!sameRun) upsertSetupRow(this.db, K_LAUNCH, { codeHash: setupCodeHash(norm, this.pepper), expiresAt: now, attempts: 0, lockedUntil: 0 });
      return;
    }
    if (sameRun && readSetupRow(this.db, K_CODE)) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      installCode(this.db, norm, this.pepper, now, { clearWait: true });
      upsertSetupRow(this.db, K_LAUNCH, { codeHash: setupCodeHash(norm, this.pepper), expiresAt: now, attempts: 0, lockedUntil: 0 });
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw e;
    }
  }

  /** A new code after a void or an expiry, told to the launcher (console only). */
  private mint(why: 'void' | 'expired', lockedUntil: number): void {
    const code = newSetupCode();
    installCode(this.db, code, this.pepper, this.now(), { clearWait: false, lockedUntil });
    this.log(why === 'void' ? '[admin] setup code voided after too many wrong tries; a new one is shown in the host console'
      : '[admin] setup code expired; a new one is shown in the host console');
    try { this.onSetupCode?.(code, why); } catch { /* the listener's problem */ }
  }

  /** setup/status (host PC only). */
  setupStatus(caller: AdminCaller): AdminResult<{ needsSetup: boolean; kind: 'first' | 'reset' | null; retryAfter: number; attemptsLeft: number }> {
    if (!caller.hostPc) return fail(403, ADMIN_ERR.setupHostPc);
    const s = this.state();
    if (!s.setupPending) return { ok: true, needsSetup: false, kind: null, retryAfter: 0, attemptsLeft: 0 };
    const row = readSetupRow(this.db, K_CODE);
    const now = this.now();
    const wait = row && row.lockedUntil > now ? row.lockedUntil - now : 0;
    return { ok: true, needsSetup: true, kind: s.setupKind, retryAfter: wait ? retrySec(wait) : 0, attemptsLeft: row ? Math.max(0, SETUP_MAX_ATTEMPTS - row.attempts) : 0 };
  }

  /**
   * setup (host PC only): check the code, create (first run) or replace (after a reset) the host admin, and sign in.
   * 400 attemptsLeft · 429 retryAfter · 404 once set up. Field problems (username, password, preset) are answered
   * before the code is checked and cost no attempt.
   */
  async setup(input: SetupInput, caller: AdminCaller, hooks: SetupHooks = {}): Promise<AdminResult<{ token: string; session: AdminSession; kind: 'first' | 'reset' }>> {
    if (!caller.hostPc) {
      this.auditRefusal(caller, 'setup-place', `setup refused: not on the host PC via=${caller.via}`, '(setup)');
      return fail(403, ADMIN_ERR.setupHostPc);
    }
    const state = this.state();
    if (!state.setupPending) return fail(404, ADMIN_ERR.alreadySetUp);
    if (this.setupInFlight) return fail(409, ADMIN_ERR.setupBusy);
    const kind = state.setupKind ?? 'first';
    const now = this.now();
    let row = readSetupRow(this.db, K_CODE);
    if (!row || !row.codeHash) return fail(403, ADMIN_ERR.noSetupCode);
    if (row.lockedUntil > now) {
      this.auditRefusal(caller, 'setup-wait', 'setup: refused during the wait after a voided setup code', '(setup)');
      return fail(429, ADMIN_ERR.setupCodeVoid, { retryAfter: retrySec(row.lockedUntil - now), attemptsLeft: 0 });
    }
    if (row.expiresAt <= now) {
      this.mint('expired', 0);
      return fail(400, ADMIN_ERR.setupCodeExpired, { attemptsLeft: SETUP_MAX_ATTEMPTS, field: 'setupCode' });
    }

    // Fields first (no attempt used).
    const username = typeof input.username === 'string' ? input.username.trim() : input.username;
    const uProblem = adminUsernameProblem(username);
    if (uProblem) return fail(400, uProblem, { field: 'username' });
    const name = username as string;
    if (this.st.playerName!.get(name.toLowerCase())) return fail(400, ADMIN_ERR.playerName, { field: 'username' });
    let choices: SetupChoices | null = null;
    if (kind === 'first') {
      const preset = input.preset;
      if (preset !== 'home' && preset !== 'school') return fail(400, 'Choose Home or School.', { field: 'preset' });
      const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
      if (!serverName || serverName.length > 60) return fail(400, 'Give the server a name (at most 60 characters).', { field: 'serverName' });
      const accountsMode = input.accountsMode === undefined || input.accountsMode === null ? 'email' : input.accountsMode;
      if (accountsMode !== 'email' && accountsMode !== 'roster') return fail(400, 'Choose Email verification or Class roster.', { field: 'accountsMode' });
      choices = { preset, serverName, accountsMode };
      // Owner decision 6: School setup may also set the Allowed email domains (optional; validated as Settings does).
      if (input.domains !== undefined && input.domains !== null) {
        const d = parseDomainList(input.domains);
        if (!d.ok) return fail(400, d.error, { field: 'domains' });
        if (d.value.length && preset !== 'school') return fail(400, SETUP_DOMAINS_SCHOOL_ONLY, { field: 'domains' });
        if (d.value.length) choices.domains = d.value;
      }
    }
    const pProblem = adminPasswordProblem(input.password, name, choices?.serverName ?? this.policy().serverName);
    if (pProblem) return fail(400, pProblem, { field: 'password' });
    const password = input.password as string;

    // The code: the current one, or the one Reset admin password printed (attempts count on the current one).
    const code = normalizeSetupCode(input.setupCode);
    const tool = readSetupRow(this.db, K_TOOL);
    const matches = !!code && (setupCodeMatches(row.codeHash, code, this.pepper)
      || (!!tool && tool.expiresAt > now && setupCodeMatches(tool.codeHash, code, this.pepper)));
    if (!matches) {
      row = { ...row, attempts: row.attempts + 1 };
      if (row.attempts >= SETUP_MAX_ATTEMPTS) {
        const voids = (readSetupRow(this.db, K_VOIDS)?.attempts ?? 0) + 1;
        const lockedUntil = now + setupLockMs(voids);
        upsertSetupRow(this.db, K_VOIDS, { codeHash: '', expiresAt: 0, attempts: voids, lockedUntil: 0 });
        this.db.prepare('DELETE FROM host_setup WHERE k = ?').run(K_TOOL);
        this.mint('void', lockedUntil);
        this.audit({ actorId: 'unknown', actorName: '(setup)', action: 'login-fail', address: caller.address === 'loopback' ? null : caller.address, reason: `setup code voided after ${SETUP_MAX_ATTEMPTS} wrong tries (wait ${Math.round(setupLockMs(voids) / 1000)} s)` });
        return fail(429, ADMIN_ERR.setupCodeVoid, { retryAfter: retrySec(lockedUntil - now), attemptsLeft: 0, field: 'setupCode' });
      }
      upsertSetupRow(this.db, K_CODE, row);
      const left = SETUP_MAX_ATTEMPTS - row.attempts;
      // Each wrong code is written (at most 5 per code, and a void then waits), never the code that was typed.
      this.audit({ actorId: 'unknown', actorName: '(setup)', action: 'login-fail', address: caller.address === 'loopback' ? null : caller.address, reason: `setup: wrong setup code (${left} ${left === 1 ? 'try' : 'tries'} left)` });
      return fail(400, ADMIN_ERR.setupCodeWrong, { attemptsLeft: left, field: 'setupCode' });
    }

    this.setupInFlight = true;
    try {
      const hash = await this.hostLane.run(() => hashAdminPassword(password, this.params));
      if (this.closed) return fail(503, ADMIN_ERR.busy);
      if (!this.needsSetup()) return fail(404, ADMIN_ERR.alreadySetUp);
      if (choices && hooks.apply) {
        const r = await hooks.apply(choices, { accountId: HOST_ACTOR_ID, name });
        if (!r.ok) return fail(r.status ?? 400, r.error, r.field ? { field: r.field } : {});
      }
      const t = this.now();
      const existing = readAdminRow(this.db);
      let adminId = '';
      let renamed = '';
      let clash = false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Again under the write lock: after a reset players are online and may register the chosen name while the
        // password hashes (as setHostAdminCredential does). Nothing is written, the code is not spent: the host
        // picks another name.
        clash = !!this.st.playerName!.get(name.toLowerCase());
        if (!clash && existing) {
          adminId = existing.id;
          this.db.prepare('UPDATE host_admins SET username = ?, username_lower = ?, pass_hash = ?, pass_changed_at = ?, last_login = ? WHERE id = ?')
            .run(name, name.toLowerCase(), hash, t, t, adminId);
          const moved = moveHostBans(this.db, existing.username, name);
          if (existing.username.toLowerCase() !== name.toLowerCase()) renamed = ` (renamed from ${existing.username}; ${moved} host ban(s) moved to the new name)`;
        } else if (!clash) {
          adminId = newId();
          this.db.prepare('INSERT INTO host_admins (id, username, username_lower, pass_hash, created_at, last_login, pass_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(adminId, name, name.toLowerCase(), hash, t, t, t);
        }
        if (!clash) {
          this.db.prepare("DELETE FROM admin_sessions WHERE principal LIKE 'host:%'").run();
          // The code is spent; the launcher run stays recorded (see installLaunchCode).
          this.db.prepare(`DELETE FROM host_setup WHERE k <> '${K_LAUNCH}'`).run();
        }
        this.db.exec(clash ? 'ROLLBACK' : 'COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
        throw e;
      }
      if (clash) return fail(400, ADMIN_ERR.playerName, { field: 'username' });
      this.hostPc = { fails: 0, pending: 0, level: 0, lockedUntil: 0 };
      this.noteHostName(name);
      const domainNote = choices?.domains ? `, ${choices.domains.length} email domain(s)` : '';
      this.audit({ actorId: HOST_ACTOR_ID, actorName: name, action: 'setup', reason: kind === 'first' ? `first-run setup (${choices!.preset}, ${choices!.accountsMode}${domainNote})` : `new host admin login after a reset${renamed}` });
      // Every host session was just ended, so there is always room.
      const token = this.createSession(`host:${adminId}`, caller, t);
      this.stateChanged();
      if (!token) return fail(409, ADMIN_ERR.tooManySessions);
      const session = this.authenticate(token, caller, { passive: true });
      if (!session.ok) return session;
      return { ok: true, token, session: session.session, kind };
    } finally {
      this.setupInFlight = false;
    }
  }

  // --- login throttle ------------------------------------------------------------------------

  private throttleOf(address: string): Throttle {
    let t = this.addrThrottle.get(address);
    if (!t) {
      if (this.addrThrottle.size > 10_000) this.sweepThrottles();
      t = { fails: [], pending: 0, blockedUntil: 0 };
      this.addrThrottle.set(address, t);
    }
    return t;
  }

  private sweepThrottles(): void {
    const now = this.now();
    for (const [k, t] of this.addrThrottle) {
      t.fails = t.fails.filter((x) => now - x < LOGIN_FAIL_WINDOW_MS);
      if (!t.fails.length && !t.pending && t.blockedUntil <= now) this.addrThrottle.delete(k);
    }
  }

  /** Refuse before any scrypt work: remote pause, address block, host-PC wait. null = go ahead (a slot is held). */
  private beginAttempt(caller: AdminCaller): Fail | null {
    const now = this.now();
    if (caller.hostPc) {
      const h = this.hostPc;
      if (h.lockedUntil > now) return fail(429, ADMIN_ERR.tooMany, { retryAfter: retrySec(h.lockedUntil - now) });
      if (h.fails + h.pending >= HOST_PC_FAILS) return fail(429, ADMIN_ERR.tooMany, { retryAfter: 1 });
      h.pending++;
      return null;
    }
    const remote = caller.via === 'https' || caller.via === 'proxy';
    if (remote && this.remotePausedUntil > now) return fail(429, ADMIN_ERR.remotePaused, { retryAfter: retrySec(this.remotePausedUntil - now) });
    const t = this.throttleOf(caller.address);
    if (t.blockedUntil > now) return fail(429, ADMIN_ERR.tooMany, { retryAfter: retrySec(t.blockedUntil - now) });
    t.fails = t.fails.filter((x) => now - x < LOGIN_FAIL_WINDOW_MS);
    if (t.fails.length + t.pending >= LOGIN_FAILS_PER_ADDRESS) return fail(429, ADMIN_ERR.tooMany, { retryAfter: 1 });
    if (this.remoteLane.full) return fail(429, ADMIN_ERR.busy, { retryAfter: 1 });
    t.pending++;
    return null;
  }

  private endAttempt(caller: AdminCaller, ok: boolean): void {
    const now = this.now();
    if (caller.hostPc) {
      const h = this.hostPc;
      h.pending = Math.max(0, h.pending - 1);
      if (ok) { h.fails = 0; h.level = 0; h.lockedUntil = 0; return; }
      h.fails++;
      if (h.fails >= HOST_PC_FAILS) {
        h.lockedUntil = now + hostPcLockMs(h.level);
        h.level++;
        h.fails = 0;
      }
      return;
    }
    const t = this.throttleOf(caller.address);
    t.pending = Math.max(0, t.pending - 1);
    if (ok) return;
    t.fails.push(now);
    t.fails = t.fails.filter((x) => now - x < LOGIN_FAIL_WINDOW_MS);
    if (t.fails.length >= LOGIN_FAILS_PER_ADDRESS) { t.blockedUntil = now + LOGIN_ADDRESS_BLOCK_MS; t.fails = []; }
    if (caller.via === 'https' || caller.via === 'proxy') {
      this.remoteFails = this.remoteFails.filter((x) => now - x < HOUR);
      this.remoteFails.push(now);
      if (this.remoteFails.length >= REMOTE_FAILS_PER_HOUR) {
        this.remotePausedUntil = now + REMOTE_PAUSE_MS;
        this.remoteFails = [];
        this.log('[admin] remote sign-in to the control panel is paused for 1 h after too many failed attempts');
        this.audit({ actorId: 'system', actorName: 'system', action: 'login-fail', reason: `remote sign-in to the control panel paused for 1 h after ${REMOTE_FAILS_PER_HOUR} failed remote attempts in an hour` });
      }
    }
  }

  private lane(caller: AdminCaller): Lane { return caller.hostPc ? this.hostLane : this.remoteLane; }

  /** Banners for `me` (§5.2): remote sign-in paused. */
  banners(): { code: string; level: 'warn' | 'urgent'; text: string }[] {
    const now = this.now();
    if (this.remotePausedUntil > now) {
      return [{ code: 'remote-login-paused', level: 'warn', text: `Remote sign-in to the control panel is paused until ${new Date(this.remotePausedUntil).toLocaleTimeString()} after too many failed attempts.` }];
    }
    return [];
  }

  // --- login, reauth, logout, password ---------------------------------------------------------

  /** Refusals that don't depend on the credential (remote off, plain http, moderator view off). */
  private placeRefusal(caller: AdminCaller, role: AdminKind): Fail | null {
    const p = this.policy();
    if (!caller.hostPc && (caller.via === 'https' || caller.via === 'proxy')) {
      if (p.remoteAccess === 'off') return fail(403, REMOTE_OFF);
      if (!caller.secure) return fail(403, ADMIN_ERR.needsHttps);
    }
    if (role === 'moderator' && !p.moderatorView) return fail(403, ADMIN_ERR.moderatorViewOff);
    return null;
  }

  /** login { role, username, password } → a session token (§5.15): 401 · 403 · 429. */
  async login(input: { role?: unknown; username?: unknown; password?: unknown }, caller: AdminCaller): Promise<AdminResult<{ token: string; session: AdminSession }>> {
    const role = input.role === undefined ? 'host' : input.role;
    if (role !== 'host' && role !== 'moderator') return fail(400, 'role must be host or moderator');
    if (typeof input.username !== 'string' || typeof input.password !== 'string') return fail(400, 'username and password are required');
    const where0 = `role=${role} via=${caller.via}${caller.hostPc ? ' (host PC)' : ''}`;
    const refused = this.placeRefusal(caller, role);
    if (refused) {
      this.auditRefusal(caller, `place:${refused.error}`, `sign-in refused: ${refused.error} ${where0}`);
      return refused;
    }
    const username = input.username.trim().slice(0, 64);
    const password = input.password.length > ADMIN_PASSWORD_MAX * 4 ? input.password.slice(0, ADMIN_PASSWORD_MAX * 4) : input.password;
    const throttled = this.beginAttempt(caller);
    if (throttled) {
      this.auditRefusal(caller, `throttle:${throttled.error}`, `sign-in refused (${throttled.status}): ${throttled.error} ${where0}`);
      return throttled;
    }
    let principalId: string | null = null;
    let known: string | null = null;
    let accountId: string | null = null;
    let ok = false;
    try {
      if (role === 'host') {
        const row = readAdminRow(this.db);
        const match = row && row.username.toLowerCase() === username.toLowerCase() ? row : null;
        ok = await this.lane(caller).run(() => verifyAdminPassword(password, match?.passHash ?? null, this.params)) && !!match;
        if (match) { known = match.username; principalId = `host:${match.id}`; }
      } else {
        const acc = USERNAME_RE.test(username) ? this.mods.find(username) : null;
        const eligible = !!acc && this.mods.isModerator(acc.accountId) && this.mods.isActive(acc.accountId) && !this.mods.isBanned(acc.accountId, this.now());
        ok = await this.lane(caller).run(() => verifyAdminPassword(password, eligible ? acc!.passHash : null, this.params)) && eligible;
        if (acc) { known = acc.username; accountId = acc.accountId; principalId = `mod:${acc.accountId}`; }
      }
    } finally {
      this.endAttempt(caller, ok);
    }
    const where = where0;
    const addr = caller.address === 'loopback' ? null : caller.address;
    if (!ok || !principalId || this.closed) {
      this.audit({ actorId: 'unknown', actorName: known ?? '(unknown name)', action: 'login-fail', targetAccountId: accountId, address: addr, reason: where });
      if (role === 'host' && this.needsSetup()) return fail(401, ADMIN_ERR.noHostAdmin, { needsSetup: true });
      return fail(401, ADMIN_ERR.wrongLogin);
    }
    const t = this.now();
    if (role === 'host') { try { this.st.setLastLogin!.run(t, principalId.slice(5)); } catch { /* best effort */ } }
    const token = this.createSession(principalId, caller, t);
    if (!token) {
      // The password was right, but every open session is on a more trusted route (the host PC): none is ended.
      this.audit({ actorId: role === 'host' ? HOST_ACTOR_ID : accountId!, actorName: known!, action: 'login-fail', targetAccountId: accountId, address: addr, reason: `sign-in refused: too many open sessions ${where}` });
      return fail(409, ADMIN_ERR.tooManySessions);
    }
    this.audit({ actorId: role === 'host' ? HOST_ACTOR_ID : accountId!, actorName: known!, action: 'login', targetAccountId: accountId, address: addr, reason: where });
    const s = this.authenticate(token, caller, { passive: true });
    if (!s.ok) return s;
    return { ok: true, token, session: s.session };
  }

  /** reauth { password }: step-up freshness again. 400 wrongPassword · 429. */
  async reauth(session: AdminSession, password: unknown, caller: AdminCaller): Promise<AdminResult<{ session: AdminSession }>> {
    if (typeof password !== 'string') return fail(400, 'password is required');
    const throttled = this.beginAttempt(caller);
    if (throttled) {
      this.auditRefusal(caller, `throttle:${throttled.error}`, `reauth refused (${throttled.status}): ${throttled.error} via=${session.via}`, session.username);
      return throttled;
    }
    let ok = false;
    try {
      const stored = this.passHashOf(session);
      ok = await this.lane(caller).run(() => verifyAdminPassword(password.slice(0, ADMIN_PASSWORD_MAX * 4), stored, this.params)) && stored !== null;
    } finally {
      this.endAttempt(caller, ok);
    }
    const addr = caller.address === 'loopback' ? null : caller.address;
    if (!ok) {
      this.audit({ actorId: this.actorIdOf(session), actorName: session.username, action: 'login-fail', address: addr, reason: `reauth via=${session.via}` });
      return fail(400, ADMIN_ERR.wrongPassword, { wrongPassword: true });
    }
    const t = this.now();
    try { this.st.touch!.run(t, t, t, session.tokenHash); } catch (e) { this.warnOnce('touch', `[admin] could not update a session: ${(e as Error)?.message ?? e}`); }
    this.audit({ actorId: this.actorIdOf(session), actorName: session.username, action: 'reauth', address: addr, reason: `via=${session.via}` });
    const r = this.lookup(session.tokenHash);
    if (!r) return fail(401, ADMIN_ERR.sessionEnded);
    return { ok: true, session: { ...session, lastAction: t, lastSeen: t, reauthAt: t, fresh: true } };
  }

  /** logout: ends this session. */
  logout(session: AdminSession, caller: AdminCaller): void {
    try { this.st.deleteSession!.run(session.tokenHash); } catch { /* gone already */ }
    this.audit({ actorId: this.actorIdOf(session), actorName: session.username, action: 'logout', address: caller.address === 'loopback' ? null : caller.address, reason: `via=${session.via}` });
  }

  /**
   * password { current, next } (host admin only): every OTHER session of the host admin is revoked. Not from a remote
   * `limited` session (a click-through a man in the middle may have captured, §4.10): changing the password there would
   * end the host PC's own session and lock the host out.
   */
  async changePassword(session: AdminSession, current: unknown, next: unknown, caller: AdminCaller): Promise<AdminResult<{ revoked: number }>> {
    if (session.kind !== 'host') return fail(403, ADMIN_ERR.moderatorPassword);
    if (session.untrustedTls || (session.principal.kind === 'host' && session.principal.via === 'limited')) return fail(403, ADMIN_ERR.passwordHere);
    if (typeof current !== 'string') return fail(400, 'current is required');
    const problem = adminPasswordProblem(next, session.username, this.policy().serverName);
    if (problem) return fail(400, problem, { field: 'next' });
    const throttled = this.beginAttempt(caller);
    if (throttled) {
      this.auditRefusal(caller, `throttle:${throttled.error}`, `password change refused (${throttled.status}): ${throttled.error} via=${session.via}`, session.username);
      return throttled;
    }
    let ok = false;
    const stored = this.passHashOf(session);
    try {
      ok = await this.lane(caller).run(() => verifyAdminPassword(current.slice(0, ADMIN_PASSWORD_MAX * 4), stored, this.params)) && stored !== null;
    } finally {
      this.endAttempt(caller, ok);
    }
    const addr = caller.address === 'loopback' ? null : caller.address;
    if (!ok) {
      this.audit({ actorId: HOST_ACTOR_ID, actorName: session.username, action: 'login-fail', address: addr, reason: 'password change: wrong current password' });
      return fail(400, ADMIN_ERR.wrongPassword, { wrongPassword: true, field: 'current' });
    }
    const hash = await this.lane(caller).run(() => hashAdminPassword(next as string, this.params));
    const t = this.now();
    const id = session.principalId.slice(5);
    this.db.prepare('UPDATE host_admins SET pass_hash = ?, pass_changed_at = ? WHERE id = ?').run(hash, t, id);
    const revoked = num(this.st.deletePrincipalExcept!.run(session.principalId, session.tokenHash).changes);
    try { this.st.touch!.run(t, t, t, session.tokenHash); } catch { /* best effort */ }
    this.audit({ actorId: HOST_ACTOR_ID, actorName: session.username, action: 'admin-password', address: addr, reason: `host admin password changed; ${revoked} other session(s) revoked` });
    return { ok: true, revoked };
  }

  private passHashOf(s: AdminSession): string | null {
    if (s.kind === 'host') {
      const row = readAdminRow(this.db);
      return row && `host:${row.id}` === s.principalId && isUsableHash(row.passHash) ? row.passHash : null;
    }
    const acc = this.mods.find(s.username);
    return acc && acc.accountId === s.accountId ? acc.passHash : null;
  }

  private actorIdOf(s: AdminSession): string { return s.kind === 'host' ? HOST_ACTOR_ID : s.accountId ?? 'unknown'; }

  // --- sessions ------------------------------------------------------------------------------

  /**
   * A new session, within MAX_SESSIONS_PER_PRINCIPAL: over the cap it ends only sessions on a route no more trusted
   * than the caller's (SESSION_VIA_RANK: least trusted first, then least recently seen), so a remote login never ends
   * the host PC's session. null = the cap is full of more trusted sessions (the caller answers 409 tooManySessions).
   */
  private createSession(principalId: string, caller: AdminCaller, t: number): string | null {
    const token = newToken();
    const hash = sha256Hex(token);
    const rank = (via: unknown): number => SESSION_VIA_RANK[via as SessionVia] ?? 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      try { this.st.deleteExpired!.run(t); } catch { /* housekeeping */ }
      const rows = this.st.principalSessions!.all(principalId) as Row[];
      const over = rows.length - (MAX_SESSIONS_PER_PRINCIPAL - 1);
      if (over > 0) {
        const mine = rank(caller.via);
        const may = rows.filter((r) => rank(r.via) <= mine)
          .sort((a, b) => rank(a.via) - rank(b.via) || num(a.last_seen) - num(b.last_seen) || num(a.created_at) - num(b.created_at));
        if (may.length < over) { this.db.exec('ROLLBACK'); return null; }
        for (const r of may.slice(0, over)) this.st.deleteSession!.run(String(r.token_hash));
      }
      this.st.insertSession!.run(hash, principalId, t, t, t, t, t + SESSION_ABSOLUTE_MS, caller.address, caller.via);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw e;
    }
    return token;
  }

  private lookup(tokenHash: string): SessionRow | null {
    const r = this.st.session!.get(tokenHash) as Row | undefined;
    if (!r) return null;
    return {
      tokenHash: String(r.token_hash), principal: String(r.principal), createdAt: num(r.created_at), lastSeen: num(r.last_seen),
      lastAction: num(r.last_action), reauthAt: num(r.reauth_at), expiresAt: num(r.expires_at), address: strOrNull(r.address), via: String(r.via),
    };
  }

  private drop(tokenHash: string): void {
    try { this.st.deleteSession!.run(tokenHash); } catch { /* gone already */ }
  }

  /**
   * Check a Bearer token for this request and count the call (§4.10):
   *  - `passive`: a poll (it neither counts as deliberate activity nor refreshes step-up freshness);
   *  - `keepAlive`: the Live view's poll; with admin.liveKeepsAlive on the host PC it keeps the session alive for at
   *    most 3 h after the last deliberate action.
   * The admin API calls it with `passive: true` and counts the call with activity() once its checks passed (a refused
   * call must not keep a session alive or fresh).
   * 401 when the session is unknown, from another address or route, idle, too old, or its principal lost its rights
   * (host admin reset; moderator demoted, disabled, banned, deleted; moderator view or remote access switched off).
   */
  authenticate(token: string, caller: AdminCaller, opts: { passive?: boolean; keepAlive?: boolean } = {}): AdminResult<{ session: AdminSession }> {
    if (this.closed) return fail(503, ADMIN_ERR.busy);
    if (this.refusalDirty.size) this.flushRefusals(false);
    if (typeof token !== 'string' || !ADMIN_TOKEN_RE.test(token)) return fail(401, ADMIN_ERR.notSignedIn);
    const hash = sha256Hex(token);
    let row: SessionRow | null;
    try { row = this.lookup(hash); } catch (e) {
      this.warnOnce('lookup', `[admin] could not read the admin sessions: ${(e as Error)?.message ?? e}`);
      return fail(503, ADMIN_ERR.busy);
    }
    if (!row) return fail(401, ADMIN_ERR.sessionEnded);
    if (row.via !== caller.via || (row.address ?? '') !== caller.address) return fail(401, ADMIN_ERR.elsewhere);
    const now = this.now();
    const p = this.policy();
    if (now >= row.expiresAt) { this.drop(hash); return fail(401, ADMIN_ERR.expired); }
    const idle = this.idleMs(p);
    const keepAliveOk = p.liveKeepsAlive && row.via === 'local';
    const alive = now - row.lastAction <= idle
      || (keepAliveOk && now - row.lastSeen <= idle && now - row.lastAction <= LIVE_KEEPALIVE_MAX_MS);
    if (!alive) { this.drop(hash); return fail(401, ADMIN_ERR.idle); }

    let kind: AdminKind;
    let username: string;
    let accountId: string | null = null;
    let principal: Principal;
    const remote = row.via === 'https' || row.via === 'proxy';
    if (row.principal.startsWith('host:')) {
      const admin = readAdminRow(this.db);
      if (!admin || `host:${admin.id}` !== row.principal || !isUsableHash(admin.passHash)) {
        try { this.st.deletePrincipal!.run(row.principal); } catch { /* gone */ }
        return fail(401, ADMIN_ERR.sessionEnded);
      }
      const hp = hostPrincipal({ via: row.via as SessionVia, hostPc: caller.hostPc, remoteAccess: p.remoteAccess, trustedTls: caller.trustedTls });
      if (!hp) { this.drop(hash); return fail(401, REMOTE_OFF); }
      kind = 'host'; username = admin.username; principal = hp;
    } else if (row.principal.startsWith('mod:')) {
      accountId = row.principal.slice(4);
      const acc = this.moderatorAccount(accountId, now);
      if (!acc || !p.moderatorView) {
        // Demoted, disabled, banned, deleted, or the moderator view is off: every session of theirs ends.
        try { this.st.deletePrincipal!.run(row.principal); } catch { /* gone */ }
        return fail(401, ADMIN_ERR.sessionEnded);
      }
      // Remote access switched off ends only the remote sessions (as for the host admin), not one on the host PC.
      if (remote && p.remoteAccess === 'off') { this.drop(hash); return fail(401, REMOTE_OFF); }
      kind = 'moderator'; username = acc; principal = { kind: 'moderator', tier: p.moderatorTier };
    } else {
      this.drop(hash);
      return fail(401, ADMIN_ERR.sessionEnded);
    }

    const stepUp = this.stepUpMs(p);
    const fresh = now - row.reauthAt <= stepUp;
    let { lastSeen, lastAction, reauthAt } = row;
    if (!opts.passive) {
      lastSeen = now; lastAction = now;
      if (fresh) reauthAt = now;
    } else if (opts.keepAlive && keepAliveOk) {
      lastSeen = now;
    }
    if (lastSeen - row.lastSeen >= 1000 || lastAction !== row.lastAction || reauthAt !== row.reauthAt) {
      try { this.st.touch!.run(lastSeen, lastAction, reauthAt, hash); } catch (e) {
        this.warnOnce('touch', `[admin] could not update a session: ${(e as Error)?.message ?? e}`);
      }
    }
    return {
      ok: true,
      session: {
        tokenHash: hash, principalId: row.principal, kind, accountId, username, principal,
        untrustedTls: remote && !caller.trustedTls, via: row.via as SessionVia, address: row.address,
        createdAt: row.createdAt, lastAction, lastSeen, reauthAt, expiresAt: row.expiresAt, fresh,
      },
    };
  }

  /**
   * Count a call that PASSED its checks (§4.10): the API authenticates every call as passive first, and only once the
   * capability, place and step-up checks passed and the handler did not refuse it does the call count. A deliberate
   * call moves last_action (and reauth_at while the session was fresh at the call's start); the Live view's keep-alive
   * poll moves last_seen (admin.liveKeepsAlive, host PC only). A refused call (401, 403) counts for nothing, so a
   * session that only makes refused calls still goes idle and stale. Values only move forward (a reauth or another
   * call may have landed while the handler ran). Returns the session as counted.
   */
  activity(s: AdminSession, opts: { passive?: boolean; keepAlive?: boolean } = {}): AdminSession {
    if (this.closed) return s;
    const now = this.now();
    let { lastSeen, lastAction, reauthAt } = s;
    if (!opts.passive) {
      lastSeen = now; lastAction = now;
      if (s.fresh) reauthAt = now;
    } else if (opts.keepAlive && this.policy().liveKeepsAlive && s.via === 'local') {
      if (now - s.lastSeen < 1000) return s;
      lastSeen = now;
    } else {
      return s;
    }
    try { this.st.touchForward!.run(lastSeen, lastAction, reauthAt, s.tokenHash); } catch (e) {
      this.warnOnce('touch', `[admin] could not update a session: ${(e as Error)?.message ?? e}`);
    }
    return { ...s, lastSeen, lastAction, reauthAt };
  }

  /** The moderator's username while they may use the panel (flag, active, not banned), else null. */
  private moderatorAccount(accountId: string, now: number): string | null {
    try {
      if (!this.mods.isModerator(accountId) || !this.mods.isActive(accountId) || this.mods.isBanned(accountId, now)) return null;
      const r = this.db.prepare('SELECT username FROM accounts WHERE id = ?').get(accountId) as Row | undefined;
      return r ? String(r.username) : null;
    } catch {
      return null;
    }
  }

  /** The §5.15 Session object for responses. */
  sessionInfo(s: AdminSession): SessionInfo {
    const p = this.policy();
    const idle = this.idleMs(p);
    const keepAlive = p.liveKeepsAlive && s.via === 'local';
    const idleEnd = keepAlive ? Math.max(s.lastAction + idle, Math.min(s.lastSeen + idle, s.lastAction + LIVE_KEEPALIVE_MAX_MS)) : s.lastAction + idle;
    const freshUntil = s.reauthAt + this.stepUpMs(p);
    return {
      principal: s.principal,
      username: s.username,
      expiresAt: Math.min(s.expiresAt, idleEnd),
      idleSec: Math.round(idle / 1000),
      freshUntil: freshUntil > this.now() ? freshUntil : 0,
      capabilities: capabilitiesOf(s.principal, { logSearch: p.moderatorLogSearch, untrustedTls: s.untrustedTls }),
    };
  }

  /** End every session of one moderator at once (demote, disable, delete or ban; the per-call re-check covers the rest). */
  revokeModerator(accountId: string): number {
    try { return num(this.st.deletePrincipal!.run(`mod:${accountId}`).changes); } catch { return 0; }
  }

  /**
   * End the sessions a settings change no longer allows (§4.10): every moderator's when moderators.view goes off, and
   * every one not made on the host PC when admin.remoteAccess goes off. Returns how many ended.
   */
  revokeDisallowed(p: Pick<AdminPolicy, 'moderatorView' | 'remoteAccess'>): number {
    let n = 0;
    try {
      if (!p.moderatorView) n += num(this.db.prepare("DELETE FROM admin_sessions WHERE principal LIKE 'mod:%'").run().changes);
      if (p.remoteAccess === 'off') n += num(this.db.prepare("DELETE FROM admin_sessions WHERE via <> 'local'").run().changes);
    } catch { /* closing */ }
    if (n) this.log(`[admin] ended ${n} session(s) the new settings no longer allow`);
    return n;
  }

  /** End every admin session (a restore, New certificate, a reset). */
  revokeAll(): number {
    try { return num(this.db.prepare('DELETE FROM admin_sessions').run().changes); } catch { return 0; }
  }

  close(): void {
    if (this.closed) return;
    if (this.refusalTimer) { clearTimeout(this.refusalTimer); this.refusalTimer = null; }
    // Folded refusal counts are written before the connection goes (none is lost at shutdown).
    try { this.flushRefusals(true); } catch { /* best effort */ }
    this.closed = true;
    try { this.db.close(); } catch { /* already closed */ }
  }
}
