// OWNER: AUTH agent. Password hashing (scrypt) + opaque token helpers.
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/**
 * Current hashing parameters: OWASP's equivalent-strength scrypt setting N=2^15, r=8, p=3, which
 * costs about as much CPU as N=2^17, p=1 but needs a quarter of the memory (32 MiB per hash, since the
 * p lanes run one after another over the same buffer). Hashes made with anything else are rehashed
 * on the next successful login.
 */
export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 3;
export const SCRYPT_KEYLEN = 64;
export const SCRYPT_PARAMS: Readonly<ScryptParams> = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN };
/** v0.1 parameters (N=2^14, p=1). Still verified; upgraded to SCRYPT_PARAMS on the next successful login. */
export const LEGACY_SCRYPT_PARAMS: Readonly<ScryptParams> = { N: 1 << 14, r: 8, p: 1, keylen: 64 };
/** First hardening pass (N=2^15, p=1). Still verified; upgraded to SCRYPT_PARAMS on the next successful login. */
export const LEGACY_P1_SCRYPT_PARAMS: Readonly<ScryptParams> = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

/** Relative CPU cost of one scrypt run (BlockMix work is proportional to N·r·p). */
export function scryptWork(params: Pick<ScryptParams, 'N' | 'r' | 'p'>): number {
  return params.N * params.r * params.p;
}
const CURRENT_WORK = scryptWork(SCRYPT_PARAMS);

/**
 * Largest scrypt working set (128·N·r) the verifier accepts from a stored hash: 128 MiB, i.e. up to
 * N=2^17 at r=8 (OWASP's p=1 baseline). Deliberately above the current params so that raising SCRYPT_N
 * later (up to that point) never makes existing or freshly written hashes unverifiable. It also stops a
 * tampered row from asking for absurd memory.
 */
export const SCRYPT_MAX_WORKING_SET = 128 * 1024 * 1024;

/**
 * `maxmem` for one scrypt call. OpenSSL rejects a call when 128·r·(N+2) + 128·r·p > maxmem, so the
 * bound is computed from the call's own params (plus 1 MiB of headroom) rather than being a fixed
 * constant that silently caps N.
 */
export function scryptMaxmem(N: number, r: number, p: number): number {
  return 128 * r * (N + 2 + p) + 1024 * 1024;
}

/**
 * Concurrent scrypt jobs. Each one holds its full working set (32 MiB now; p=3 reuses one buffer for
 * its lanes, so it costs time, not memory) on a libuv pool thread. Capping them bounds peak memory and
 * leaves pool threads free for fs/dns under a login flood.
 */
export const MAX_CONCURRENT_SCRYPT = 2;
let scryptActive = 0;
const scryptWaiters: (() => void)[] = [];

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (scryptActive < MAX_CONCURRENT_SCRYPT) scryptActive++;
  else await new Promise<void>((resolve) => scryptWaiters.push(resolve)); // slot is handed over on release
  try {
    return await fn();
  } finally {
    const next = scryptWaiters.shift();
    if (next) next();
    else scryptActive--;
  }
}

/** Test/diagnostic view of the scrypt limiter. */
export function scryptLoad(): { active: number; waiting: number } {
  return { active: scryptActive, waiting: scryptWaiters.length };
}

/** Cumulative counters since process start (tests/diagnostics). `work` sums scryptWork() of every run. */
const stats = { hashes: 0, verifies: 0, work: 0 };
export function scryptStats(): { hashes: number; verifies: number; work: number } {
  return { ...stats };
}

/** One raw scrypt run. Callers hold a slot (withScryptSlot) around it. */
function runScrypt(password: string, salt: Buffer, keylen: number, params: Pick<ScryptParams, 'N' | 'r' | 'p'>): Promise<Buffer> {
  const { N, r, p } = params;
  const opts: ScryptOptions = { N, r, p, maxmem: scryptMaxmem(N, r, p) };
  stats.work += scryptWork(params);
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Hash a password as `scrypt$N$r$p$saltB64$hashB64` (16-byte random salt). `params` defaults to the
 * current SCRYPT_PARAMS; other values are for tests and migrations only.
 */
export async function hashPassword(password: string, params: Readonly<ScryptParams> = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  stats.hashes++;
  const key = await withScryptSlot(() => runScrypt(password, salt, params.keylen, params));
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const PAD_SALT = Buffer.alloc(SALT_BYTES);

/**
 * Params for the extra work a failed verify does so that its total cost reaches CURRENT_WORK (see
 * verifyPassword). Prefers an exact split (N=2^15,p=1 needs p=2 more at N=2^15; N=2^14,p=1 needs
 * p=5 at N=2^14); anything odd rounds to whole lanes at the current N. null when nothing is owed.
 */
export function paddingParams(deficit: number): Pick<ScryptParams, 'N' | 'r' | 'p'> | null {
  if (!(deficit > 0)) return null;
  for (let N = SCRYPT_N; N >= 1 << 10; N >>= 1) {
    const lane = N * SCRYPT_R;
    if (deficit % lane === 0) return { N, r: SCRYPT_R, p: deficit / lane };
  }
  const p = Math.round(deficit / (SCRYPT_N * SCRYPT_R));
  return p >= 1 ? { N: SCRYPT_N, r: SCRYPT_R, p } : null;
}

interface ParsedHash extends ScryptParams {
  salt: Buffer;
  expected: Buffer;
}

/** Parse + bounds-check a stored hash. null for anything malformed or out of bounds. */
function parseHash(stored: string): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Bounds keep a tampered row from requesting absurd CPU/memory.
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (128 * N * r > SCRYPT_MAX_WORKING_SET) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return null;
  return { N, r, p, keylen: expected.length, salt, expected };
}

/**
 * Constant-time check of `password` against a stored hash (any params within bounds, so legacy
 * N=2^14/p=1, N=2^15/p=1 and current N=2^15/p=3 hashes all verify). Returns false (never throws) for a
 * malformed or out-of-bounds hash string, so a corrupt row can't crash or stall the server.
 *
 * A FAILED verify always costs at least what one against a current-params hash costs: when the stored
 * hash is cheaper (a dormant legacy account, or a malformed row), the difference is burned in the same
 * scrypt slot. Otherwise a wrong password for an account that still has an old hash would answer
 * measurably faster than one for an unknown login (which verifies against a current-params dummy), and
 * the response time would reveal that the account exists. A success is not padded: it gets a session
 * (and, for an old hash, a rehash) anyway.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  stats.verifies++;
  return withScryptSlot(async () => {
    let ok = false;
    if (h) {
      try {
        const actual = await runScrypt(password, h.salt, h.keylen, h);
        ok = actual.length === h.expected.length && timingSafeEqual(actual, h.expected);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      const pad = paddingParams(CURRENT_WORK - (h ? scryptWork(h) : 0));
      if (pad) await runScrypt(password, PAD_SALT, 32, pad).catch(() => undefined);
    }
    return ok;
  });
}

/**
 * Should this (verified) hash be replaced by one made with the current params? True when N, r, p, the
 * key length or the salt length differ from what hashPassword writes today.
 */
export function needsRehash(stored: string): boolean {
  const h = parseHash(stored);
  if (!h) return true;
  return h.N !== SCRYPT_N || h.r !== SCRYPT_R || h.p !== SCRYPT_P || h.keylen !== SCRYPT_KEYLEN || h.salt.length !== SALT_BYTES;
}

/** 32 random bytes as 64 lowercase hex chars. */
export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

/** 16 random bytes as 32 lowercase hex chars (account ids). */
export function randomId(): string {
  return randomBytes(16).toString('hex');
}

export const TOKEN_RE = /^[0-9a-f]{64}$/;

/** sha256 hex — what the DB stores in place of a raw session/reset token. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
