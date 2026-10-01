// OWNER: SETTINGS. Where the host settings live (docs/LAN-EDITION-proposal.md §5.13 "Persistence"):
// data\voidswarm.config.json, with `configVersion` and `rev`, and no secrets.
//  - Writes are atomic: a temp file in the same folder, fsync, then rename over the old file (retried while Windows
//    antivirus or the indexer briefly holds it). The previous good file is kept as voidswarm.config.json.bak, so a
//    crash at any point leaves a readable config (T-SET-6), and a damaged main file falls back to it.
//  - Environment variables seed the config only on its first run (ENV_SEEDS). Later, each variable that differs from
//    the saved setting logs ONE warning, e.g. "CHAT_LOG_RETENTION_DAYS=30 ignored — the admin console setting (90)
//    wins." (T-SET-1).
//  - Several processes may write (the launcher, the server child, the maintenance tool): each save holds
//    voidswarm.config.json.lock and re-checks the stored rev under it (withConfigLock / assertStoredRev), so a writer
//    whose copy is older gets SettingsConflictError instead of overwriting a newer change.
//  - configVersion has its own small migration (migrateConfig).
// Pure file I/O (no SQLite), so the launcher (parent) and the server (child) can both use it.
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import {
  CONFIG_VERSION, coerceSettings, defaultSettings, isHostName, isIPv4, isPlainObject, isPrivateHost, parseDomainList, repairSettings,
  type AccountsMode, type EmailDomain, type HostSettings, type MailSecurity, type Preset, type RemoteAccess,
} from './schema';
import { fsyncBestEffort } from '../durable';

export const CONFIG_FILE = 'voidswarm.config.json';
export const CONFIG_BACKUP_SUFFIX = '.bak';
/** A config file bigger than this is not ours (the real one is a few KB). */
export const CONFIG_MAX_BYTES = 1024 * 1024;

export type Env = Record<string, string | undefined>;

// ------------------------------------------------------------------------------------------
// Atomic file writes
// ------------------------------------------------------------------------------------------

/** The fs calls the atomic writer uses (tests inject faults: a crash between the temp write and the rename). */
export interface AtomicFs {
  openSync: typeof nodeFs.openSync;
  writeSync: (fd: number, data: string) => number;
  fsyncSync: typeof nodeFs.fsyncSync;
  closeSync: typeof nodeFs.closeSync;
  renameSync: typeof nodeFs.renameSync;
  copyFileSync: typeof nodeFs.copyFileSync;
  unlinkSync: typeof nodeFs.unlinkSync;
  existsSync: typeof nodeFs.existsSync;
  mkdirSync: typeof nodeFs.mkdirSync;
}
export const realFs: AtomicFs = {
  openSync: nodeFs.openSync,
  writeSync: (fd, data) => nodeFs.writeSync(fd, data, null, 'utf8'),
  fsyncSync: nodeFs.fsyncSync,
  closeSync: nodeFs.closeSync,
  renameSync: nodeFs.renameSync,
  copyFileSync: nodeFs.copyFileSync,
  unlinkSync: nodeFs.unlinkSync,
  existsSync: nodeFs.existsSync,
  mkdirSync: nodeFs.mkdirSync,
};

const RENAME_RETRIES = 8;
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const isTransient = (e: unknown): boolean => {
  const c = (e as NodeJS.ErrnoException)?.code;
  return c === 'EPERM' || c === 'EACCES' || c === 'EBUSY';
};

/**
 * Write `data` to `file` atomically: temp file in the same folder → fsync → (keep the old file as `.bak`) → rename
 * → fsync the folder (POSIX). A crash leaves either the old or the new file, never a half-written one.
 * On Windows a rename over a file another process has open fails with EPERM / EBUSY for a moment: retried.
 */
export function writeFileAtomicSync(file: string, data: string, opts: { fs?: AtomicFs; mode?: number; keepBackup?: boolean } = {}): void {
  const fs = opts.fs ?? realFs;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', opts.mode ?? 0o600);
    fs.writeSync(fd, data);
    fsyncBestEffort(fd, fs.fsyncSync);
    fs.closeSync(fd);
    fd = null;
    // The .bak is the last GOOD file: a damaged main file (the reason we are rewriting it) never replaces it.
    if (opts.keepBackup && fs.existsSync(file) && parseFile(file).ok) {
      try { fs.copyFileSync(file, file + CONFIG_BACKUP_SUFFIX); } catch { /* best effort: the main file stays */ }
    }
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        if (i >= RENAME_RETRIES || !isTransient(e)) throw e;
        sleepSync(10 * (i + 1));
      }
    }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* left for cleanupTempFiles */ }
    throw e;
  }
  if (process.platform !== 'win32') {
    // The rename itself must reach the disk (POSIX); Windows can't fsync a folder handle.
    try {
      const dfd = nodeFs.openSync(dir, 'r');
      try { fsyncBestEffort(dfd); } finally { nodeFs.closeSync(dfd); }
    } catch { /* not supported on this file system */ }
  }
}

/** The async fs calls writeFileAtomic uses (tests inject faults). */
export interface AtomicFsAsync {
  open(file: string, flags: string, mode: number): Promise<{ writeFile(data: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  mkdir(dir: string): Promise<unknown>;
}
export const realFsAsync: AtomicFsAsync = {
  open: async (file, flags, mode) => {
    const fh = await nodeFs.promises.open(file, flags, mode);
    return { writeFile: (d) => fh.writeFile(d, 'utf8'), sync: () => fh.sync(), close: () => fh.close() };
  },
  rename: (a, b) => nodeFs.promises.rename(a, b),
  copyFile: (a, b) => nodeFs.promises.copyFile(a, b),
  unlink: (f) => nodeFs.promises.unlink(f),
  mkdir: (d) => nodeFs.promises.mkdir(d, { recursive: true }),
};
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
/** A readable JSON object file (the .bak only ever receives one of those). */
async function isGoodJsonFile(file: string): Promise<boolean> {
  try {
    const st = await nodeFs.promises.stat(file);
    if (st.size > CONFIG_MAX_BYTES) return false;
    let text = await nodeFs.promises.readFile(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return isPlainObject(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * writeFileAtomicSync without blocking the event loop (a save measured ~4 ms of fsync on the owner's PC, most of a
 * tick's slack): the same temp file → fsync → .bak → rename (retried) → folder fsync sequence, on the thread pool.
 */
export async function writeFileAtomic(file: string, data: string, opts: { fs?: AtomicFsAsync; mode?: number; keepBackup?: boolean } = {}): Promise<void> {
  const fs = opts.fs ?? realFsAsync;
  const dir = path.dirname(file);
  await fs.mkdir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fh: Awaited<ReturnType<AtomicFsAsync['open']>> | null = null;
  let renamed = false;
  try {
    fh = await fs.open(tmp, 'wx', opts.mode ?? 0o600);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    if (opts.keepBackup && (await isGoodJsonFile(file))) {
      try { await fs.copyFile(file, file + CONFIG_BACKUP_SUFFIX); } catch { /* best effort */ }
    }
    for (let i = 0; ; i++) {
      try {
        await fs.rename(tmp, file);
        renamed = true;
        break;
      } catch (e) {
        if (i >= RENAME_RETRIES || !isTransient(e)) throw e;
        await sleep(10 * (i + 1));
      }
    }
  } finally {
    if (fh) { try { await fh.close(); } catch { /* already closed */ } }
    if (!renamed) { try { await fs.unlink(tmp); } catch { /* never created, or left for cleanupTempFiles */ } }
  }
  if (process.platform !== 'win32') {
    try {
      const dh = await nodeFs.promises.open(dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* not supported on this file system */ }
  }
}

// ------------------------------------------------------------------------------------------
// The writers' lock (several processes on one config)
// ------------------------------------------------------------------------------------------

/**
 * Who may write the config: the launcher (first run: creates it and saves the port pair, before the child starts),
 * the server child (the panel, the retention job, mail tests, network approvals) and the maintenance tool (while
 * the host runs, too). Each takes `voidswarm.config.json.lock` (an exclusive create) around "check the stored rev,
 * write": a writer whose copy is older than the file gets a SettingsConflictError, re-reads, and tries again (an
 * update from the panel then answers 409). A lock left by a killed process is broken after LOCK_STALE_MS.
 * (Only the launcher creates a missing config: two first runs at the same moment are not locked against each other.)
 */
export const CONFIG_LOCK_SUFFIX = '.lock';
/** A lock older than this was left by a killed process (a save holds it for a few milliseconds). */
export const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before giving up (500 "could not save"). */
export const LOCK_WAIT_MS = 3_000;

/** Another process saved a newer config since this one read it. */
export class SettingsConflictError extends Error {
  readonly code = 'ECONFLICT';
  constructor(readonly storedRev: number) {
    super(`the settings file was changed by another program (rev ${storedRev})`);
    this.name = 'SettingsConflictError';
  }
}

const lockBusy = (e: unknown): boolean => {
  const c = (e as NodeJS.ErrnoException)?.code;
  // EPERM / EBUSY / EACCES: Windows, a lock file being deleted by its owner right now.
  return c === 'EEXIST' || c === 'EPERM' || c === 'EBUSY' || c === 'EACCES';
};

function tryLock(lock: string): boolean {
  let fd: number;
  try {
    fd = nodeFs.openSync(lock, 'wx', 0o600);
  } catch (e) {
    if (lockBusy(e)) return false;
    throw e;
  }
  try { nodeFs.writeSync(fd, `${process.pid} ${Date.now()}\n`); } catch { /* the file's existence is the lock */ } finally { nodeFs.closeSync(fd); }
  return true;
}

/** Break a lock older than LOCK_STALE_MS (moved aside first, so two breakers never both delete a fresh one). */
function breakStaleLock(lock: string, now: number): void {
  try {
    if (now - nodeFs.statSync(lock).mtimeMs < LOCK_STALE_MS) return;
    const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
    nodeFs.renameSync(lock, aside);
    nodeFs.unlinkSync(aside);
  } catch { /* released meanwhile, or another writer broke it first */ }
}

const unlock = (lock: string): void => { try { nodeFs.unlinkSync(lock); } catch { /* already gone */ } };
const lockTimeout = (lock: string): Error =>
  new Error(`another program has held ${path.basename(lock)} for too long (delete it if no Voidswarm is running)`);

/** Run `fn` holding the config's writers' lock. */
export async function withConfigLock<T>(file: string, fn: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
  const lock = file + CONFIG_LOCK_SUFFIX;
  nodeFs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (let i = 0; !tryLock(lock); i++) {
    breakStaleLock(lock, Date.now());
    if (Date.now() > deadline) throw lockTimeout(lock);
    await sleep(Math.min(50, 5 * (i + 1)));
  }
  try { return await fn(); } finally { unlock(lock); }
}

/** withConfigLock for the start-up writes in SettingsService.open (synchronous). */
export function withConfigLockSync<T>(file: string, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  const lock = file + CONFIG_LOCK_SUFFIX;
  nodeFs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (let i = 0; !tryLock(lock); i++) {
    breakStaleLock(lock, Date.now());
    if (Date.now() > deadline) throw lockTimeout(lock);
    sleepSync(Math.min(50, 5 * (i + 1)));
  }
  try { return fn(); } finally { unlock(lock); }
}

/** Inside the lock: refuse to overwrite a config another process saved after `expectedRev`. */
export function assertStoredRev(file: string, expectedRev: number | undefined): void {
  if (expectedRev === undefined) return;
  const stored = readStoredRev(file);
  if (stored !== null && stored > expectedRev) throw new SettingsConflictError(stored);
}

/**
 * Leftover temp files of an interrupted write (never read: a temp file may be half-written). Only files older than
 * `minAgeMs` go, so a write in progress in another process (the launcher, the tool CLI) is never cut short.
 * Returns how many were deleted.
 */
export function cleanupTempFiles(file: string, minAgeMs = 60_000, now = Date.now()): number {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  let n = 0;
  try {
    for (const f of nodeFs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.tmp')) continue;
      const p = path.join(dir, f);
      try {
        if (now - nodeFs.statSync(p).mtimeMs < minAgeMs) continue;
        nodeFs.unlinkSync(p);
        n++;
      } catch { /* in use, or already gone */ }
    }
  } catch { /* no folder */ }
  return n;
}

// ------------------------------------------------------------------------------------------
// Reading the config file
// ------------------------------------------------------------------------------------------

/** The config could not be read at all (the file is damaged or missing, and its .bak is damaged). */
export class SettingsLoadError extends Error {
  readonly code = 'ECONFIG';
  readonly file: string;
  constructor(file: string, detail: string) {
    const name = path.basename(file);
    const bak = name + CONFIG_BACKUP_SUFFIX;
    super(`The settings file ${file} ${detail === 'missing' ? 'is missing' : `is damaged (${detail})`}, and its backup copy ${bak} is damaged too. `
      + `Restore a backup ("Restore a backup.cmd"), or move both ${name} and ${bak} out of ${path.dirname(file)} `
      + 'to start again with the default settings.');
    this.name = 'SettingsLoadError';
    this.file = file;
  }
}

export interface RawConfig {
  /** The parsed JSON object, or null when there is no config yet (first run). */
  raw: Record<string, unknown> | null;
  /** Which file it came from. */
  source: 'main' | 'backup' | 'none';
  warnings: string[];
}

function parseFile(file: string): { ok: true; raw: Record<string, unknown> } | { ok: false; missing: boolean; error: string } {
  let text: string;
  try {
    const st = nodeFs.statSync(file);
    if (st.size > CONFIG_MAX_BYTES) return { ok: false, missing: false, error: `it is ${st.size} bytes` };
    text = nodeFs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { ok: false, missing: code === 'ENOENT', error: code ?? String(e) };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a BOM from a hand edit
  try {
    const v: unknown = JSON.parse(text);
    if (!isPlainObject(v)) return { ok: false, missing: false, error: 'not a JSON object' };
    return { ok: true, raw: v };
  } catch (e) {
    return { ok: false, missing: false, error: `not valid JSON: ${(e as Error).message.slice(0, 80)}` };
  }
}

/** Read the config (falling back to the .bak copy). Throws SettingsLoadError when both exist but are damaged. */
export function readConfigFile(file: string): RawConfig {
  const main = parseFile(file);
  if (main.ok) return { raw: main.raw, source: 'main', warnings: [] };
  const bak = parseFile(file + CONFIG_BACKUP_SUFFIX);
  if (bak.ok) {
    return {
      raw: bak.raw,
      source: 'backup',
      warnings: [main.missing
        ? `${path.basename(file)} is missing — using its backup copy`
        : `${path.basename(file)} is damaged (${main.error}) — using its backup copy`],
    };
  }
  if (main.missing && bak.missing) return { raw: null, source: 'none', warnings: [] };
  throw new SettingsLoadError(file, main.missing ? 'missing' : main.error);
}

/** The rev stored in the file right now (null when unreadable): a cheap "did someone else write?" check. */
export function readStoredRev(file: string): number | null {
  const p = parseFile(file);
  if (!p.ok) return null;
  const r = p.raw.rev;
  return typeof r === 'number' && Number.isInteger(r) && r >= 0 ? r : null;
}

// ------------------------------------------------------------------------------------------
// configVersion migration
// ------------------------------------------------------------------------------------------

/**
 * Upgrade an older config object to CONFIG_VERSION (field-level changes only; values are validated afterwards).
 * 1 → 2: `launcher.permissions: 'refuse'` becomes 'warn' (it was only ever the School preset's default, and the check
 * no longer blocks a host by default). A NEWER file (after a rollback) is read as far as this version understands it,
 * with a warning. Returns a new object.
 */
export function migrateConfig(raw: Record<string, unknown>, warnings: string[] = []): Record<string, unknown> {
  const out = { ...raw };
  const v = typeof out.configVersion === 'number' && Number.isInteger(out.configVersion) ? out.configVersion : 1;
  if (v > CONFIG_VERSION) {
    warnings.push(`the settings file is from a newer Voidswarm (config version ${v}); settings this version doesn't know are ignored`);
  }
  if (v < 2 && isPlainObject(out.launcher) && out.launcher.permissions === 'refuse') {
    out.launcher = { ...out.launcher, permissions: 'warn' };
  }
  out.configVersion = CONFIG_VERSION;
  return out;
}

// ------------------------------------------------------------------------------------------
// Environment seeding (first run only)
// ------------------------------------------------------------------------------------------

/** Case-insensitive env lookup (a copied Windows environment loses process.env's case folding). Empty = unset. */
export function envValue(env: Env, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct.trim() ? direct : undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) { const v = env[k]; return v && v.trim() ? v : undefined; }
  }
  return undefined;
}

export interface SeedContext {
  lan: boolean;
  env: Env;
  /** VPS upgrade: the DB already has moderators (§4.10: they keep their tools). */
  existingModerators?: boolean;
}

type SeedParse<T> = { ok: true; value: T } | { ok: false; why: string };

interface EnvSeed<T> {
  name: string;
  parse(raw: string, ctx: SeedContext): SeedParse<T>;
  set(s: HostSettings, v: T, ctx: SeedContext, warnings: string[]): void;
  /** Does the saved setting equal the env value? (No warning then.) */
  same(s: HostSettings, v: T): boolean;
  /** The saved setting, as the warning shows it. */
  show(s: HostSettings): string;
}

const intSeed = (min: number, max: number) => (raw: string): SeedParse<number> => {
  const n = Number(raw.trim());
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max
    ? { ok: true, value: n }
    : { ok: false, why: `not a whole number from ${min} to ${max}` };
};
const boolSeed = (raw: string): SeedParse<boolean> => {
  const t = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return { ok: true, value: true };
  if (['0', 'false', 'no', 'off'].includes(t)) return { ok: true, value: false };
  return { ok: false, why: 'not 1 or 0' };
};
const enumSeed = <T extends string>(map: Record<string, T>) => (raw: string): SeedParse<T> => {
  const t = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const v = map[t];
  return v ? { ok: true, value: v } : { ok: false, why: `not one of ${[...new Set(Object.values(map))].join(', ')}` };
};

function seed<T>(e: EnvSeed<T>): EnvSeed<unknown> { return e as unknown as EnvSeed<unknown>; }

/**
 * SMTP_SECURE: 1/true/tls = implicit TLS; 0/false/starttls = not implicit TLS (STARTTLS; see the private-relay rule
 * in seedFromEnv); none = a private relay without TLS. Unset + port 465 is TLS (the SMTP_PORT seed).
 */
const secureSeed = (raw: string): SeedParse<MailSecurity> => {
  const t = raw.trim().toLowerCase();
  if (t === 'tls' || t === 'ssl') return { ok: true, value: 'tls' };
  if (t === 'starttls') return { ok: true, value: 'starttls' };
  if (t === 'none') return { ok: true, value: 'none' };
  const b = boolSeed(raw);
  return b.ok ? { ok: true, value: b.value ? 'tls' : 'starttls' } : { ok: false, why: 'not 1, 0, tls, starttls or none' };
};

/** The mail server from SMTP_HOST: lower case, one trailing dot dropped, IDN to ASCII; a host name or an IPv4. */
const smtpHostSeed = (raw: string): SeedParse<string> => {
  let h = raw.trim().toLowerCase();
  if (h.endsWith('.') && !h.endsWith('..')) h = h.slice(0, -1);
  const a = h.length <= 253 ? (isIPv4(h) ? h : domainToASCII(h)) : '';
  return a && isHostName(a) ? { ok: true, value: a } : { ok: false, why: 'not a host name or an IPv4 address' };
};

/** §4.2: the loud fallback of a `required` seed without a mail server. */
export const REQUIRED_WITHOUT_MAIL = 'WARNING: ACCOUNT_EMAIL=required needs working mail (SMTP_HOST), and none is configured — '
  + 'accounts use OPTIONAL email until mail works. Set up Mail, send a test email, then switch to Required.';

const retentionShow = (s: HostSettings): string => {
  const r = s.chat.retention;
  return r.mode === 'days' ? String(r.days) : r.mode === 'term' ? `until the term ends on ${r.termEnd}` : 'forever';
};
const domainsShow = (d: EmailDomain[]): string => (d.length ? d.map((x) => (x.subdomains ? `${x.domain} and *.${x.domain}` : x.domain)).join(', ') : 'any');
const sameDomains = (a: EmailDomain[], b: EmailDomain[]): boolean =>
  a.length === b.length && a.every((x) => b.some((y) => y.domain === x.domain && y.subdomains === x.subdomains));

/**
 * Every environment variable that seeds a setting (§4.2, §5.5, §5.13, §4.7, §4.10), in seeding order (mail before
 * ACCOUNT_EMAIL, which needs to know whether mail is configured). SMTP_PASS is not copied: a VPS keeps reading it
 * from the environment (SettingsService.mailPassword), and a password never goes into the config.
 */
export const ENV_SEEDS: readonly EnvSeed<unknown>[] = [
  seed<number>({
    name: 'CHAT_LOG_RETENTION_DAYS', parse: intSeed(1, 3650),
    set: (s, v) => { s.chat.retention.mode = 'days'; s.chat.retention.days = v; },
    same: (s, v) => s.chat.retention.mode === 'days' && s.chat.retention.days === v,
    show: retentionShow,
  }),
  seed<'strict' | 'standard'>({
    name: 'CHAT_FILTER', parse: enumSeed({ strict: 'strict', standard: 'standard' }),
    set: (s, v) => { s.chat.strictness = v; }, same: (s, v) => s.chat.strictness === v, show: (s) => s.chat.strictness,
  }),
  seed<number>({
    name: 'MOD_STRIKE_LIMIT', parse: intSeed(1, 100),
    set: (s, v) => { s.chat.strikes.limit = v; }, same: (s, v) => s.chat.strikes.limit === v, show: (s) => String(s.chat.strikes.limit),
  }),
  seed<number>({
    name: 'MOD_STRIKE_WINDOW_MIN', parse: intSeed(1, 24 * 60),
    set: (s, v) => { s.chat.strikes.windowMin = v; }, same: (s, v) => s.chat.strikes.windowMin === v, show: (s) => String(s.chat.strikes.windowMin),
  }),
  seed<number>({
    name: 'MOD_AUTOMUTE_MIN', parse: intSeed(1, 7 * 24 * 60),
    set: (s, v) => { s.chat.strikes.autoMuteMin = v; }, same: (s, v) => s.chat.strikes.autoMuteMin === v, show: (s) => String(s.chat.strikes.autoMuteMin),
  }),
  seed<number>({
    name: 'MAX_CONNECTIONS', parse: intSeed(1, 4096),
    set: (s, v) => { s.rooms.maxConnections = v; }, same: (s, v) => s.rooms.maxConnections === v, show: (s) => String(s.rooms.maxConnections),
  }),
  seed<number>({
    name: 'MAX_CONN_PER_IP', parse: intSeed(1, 1024),
    set: (s, v) => { s.rooms.maxConnectionsPerAddress = v; }, same: (s, v) => s.rooms.maxConnectionsPerAddress === v,
    show: (s) => String(s.rooms.maxConnectionsPerAddress),
  }),
  seed<string>({
    name: 'SMTP_HOST',
    parse: smtpHostSeed,
    set: (s, v) => {
      s.mail.host = v;
      s.mail.preset = v === 'smtp-relay.gmail.com' ? 'relay' : v === 'smtp.gmail.com' ? 'gmail' : v === 'smtp.office365.com' ? 'm365' : 'generic';
    },
    same: (s, v) => s.mail.host === v, show: (s) => s.mail.host || 'none',
  }),
  seed<number>({
    name: 'SMTP_PORT', parse: intSeed(1, 65535),
    set: (s, v, ctx) => {
      s.mail.port = v;
      if (v === 465 && !envValue(ctx.env, 'SMTP_SECURE')) s.mail.security = 'tls'; // the mailer's rule
    },
    same: (s, v) => s.mail.port === v, show: (s) => String(s.mail.port),
  }),
  seed<MailSecurity>({
    name: 'SMTP_SECURE', parse: secureSeed,
    set: (s, v) => { s.mail.security = v; },
    // 0 / starttls = "not implicit TLS": a private relay's "None" (TLS when offered, the private-relay rule) is that too.
    same: (s, v) => s.mail.security === v || (v === 'starttls' && s.mail.security === 'none'),
    show: (s) => s.mail.security,
  }),
  seed<string>({
    name: 'SMTP_USER',
    parse: (raw) => (raw.trim().length <= 254 && !/[\r\n]/.test(raw) ? { ok: true, value: raw.trim() } : { ok: false, why: 'too long' }),
    set: (s, v) => { s.mail.user = v; }, same: (s, v) => s.mail.user === v, show: (s) => s.mail.user || 'none',
  }),
  seed<string>({
    name: 'MAIL_FROM',
    parse: (raw) => (raw.trim().length <= 320 && !/[\r\n]/.test(raw) ? { ok: true, value: raw.trim() } : { ok: false, why: 'not a From address' }),
    set: (s, v) => { s.mail.from = v; }, same: (s, v) => s.mail.from === v, show: (s) => s.mail.from || 'none',
  }),
  seed<'open' | 'rosterOnly'>({
    name: 'ACCOUNT_SIGNUP', parse: enumSeed({ open: 'open', rosteronly: 'rosterOnly', roster: 'rosterOnly' }),
    set: (s, v) => { s.accounts.signup = v; }, same: (s, v) => s.accounts.signup === v, show: (s) => s.accounts.signup,
  }),
  seed<'optional' | 'required'>({
    name: 'ACCOUNT_EMAIL', parse: enumSeed({ optional: 'optional', required: 'required' }),
    set: (s, v, _ctx, warnings) => {
      if (v === 'required' && !s.mail.host) {
        // §4.2: an env-seeded `required` without working mail falls back to optional, loudly (createSettings checks
        // again after validation, in case the mail server itself was refused there).
        warnings.push(REQUIRED_WITHOUT_MAIL);
        s.accounts.email = 'optional';
        return;
      }
      s.accounts.email = v;
    },
    same: (s, v) => s.accounts.email === v, show: (s) => s.accounts.email,
  }),
  seed<EmailDomain[]>({
    name: 'ACCOUNT_EMAIL_DOMAINS',
    parse: (raw) => {
      const p = parseDomainList(raw.split(',').map((x) => x.trim()).filter(Boolean));
      return p.ok ? { ok: true, value: p.value } : { ok: false, why: p.error };
    },
    set: (s, v) => { s.accounts.domains = v; }, same: (s, v) => sameDomains(s.accounts.domains, v), show: (s) => domainsShow(s.accounts.domains),
  }),
  seed<boolean>({
    name: 'ACCOUNT_APPROVAL', parse: boolSeed,
    set: (s, v) => { s.accounts.hostApproval = v; }, same: (s, v) => s.accounts.hostApproval === v, show: (s) => (s.accounts.hostApproval ? '1' : '0'),
  }),
  seed<boolean>({
    name: 'ALLOW_GUESTS', parse: boolSeed,
    set: (s, v) => { s.accounts.allowGuests = v; }, same: (s, v) => s.accounts.allowGuests === v, show: (s) => (s.accounts.allowGuests ? '1' : '0'),
  }),
  seed<'full' | 'hashOnly'>({
    name: 'EMAIL_STORAGE', parse: enumSeed({ full: 'full', hashonly: 'hashOnly', hash: 'hashOnly' }),
    set: (s, v) => { s.accounts.emailStorage = v; }, same: (s, v) => s.accounts.emailStorage === v, show: (s) => s.accounts.emailStorage,
  }),
  seed<RemoteAccess>({
    name: 'ADMIN_REMOTE', parse: enumSeed({ off: 'off', limited: 'limited', full: 'full' }),
    set: (s, v, ctx, warnings) => {
      // §4.10: `full` only behind a trusted proxy with a public (https) certificate; otherwise `limited`.
      if (v === 'full' && !trustedHttpsProxy(ctx.env)) {
        warnings.push('WARNING: ADMIN_REMOTE=full needs TRUST_PROXY and an https PUBLIC_URL — remote admin is LIMITED.');
        s.admin.remoteAccess = 'limited';
        return;
      }
      s.admin.remoteAccess = v;
    },
    same: (s, v) => s.admin.remoteAccess === v, show: (s) => s.admin.remoteAccess,
  }),
];

function trustedHttpsProxy(env: Env): boolean {
  const tp = envValue(env, 'TRUST_PROXY')?.trim().toLowerCase();
  const url = envValue(env, 'PUBLIC_URL')?.trim().toLowerCase() ?? '';
  return (tp === '1' || tp === 'true') && url.startsWith('https://');
}

const clipEnv = (raw: string): string => {
  const one = raw.replace(/[\r\n\t]+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
};

export interface SeedResult {
  settings: HostSettings;
  /** The variables that seeded a setting. */
  seeded: string[];
  /** Invalid values and fallbacks (already worded for the log). */
  warnings: string[];
}

/** Apply the environment on top of `base` (first run). Mutates and returns base inside the result. */
export function seedFromEnv(base: HostSettings, ctx: SeedContext, names?: readonly string[]): SeedResult {
  const warnings: string[] = [];
  const seeded: string[] = [];
  for (const e of ENV_SEEDS) {
    if (names && !names.includes(e.name)) continue;
    const raw = envValue(ctx.env, e.name);
    if (raw === undefined) continue;
    const p = e.parse(raw, ctx);
    if (!p.ok) {
      warnings.push(`WARNING: ${e.name}=${clipEnv(raw)} is not valid (${p.why}) — using ${e.show(base)}.`);
      continue;
    }
    e.set(base, p.value, ctx, warnings);
    seeded.push(e.name);
  }
  // Today's mailer requires STARTTLS only with a login (auth/mailer.ts): a relay on a private address without one
  // (SMTP_HOST=localhost, SMTP_PORT=25) keeps working as "None" (TLS when the relay offers it, not required).
  // An explicit SMTP_SECURE=starttls keeps STARTTLS required.
  if (!names || names.includes('SMTP_HOST')) {
    const sec = envValue(ctx.env, 'SMTP_SECURE')?.trim().toLowerCase();
    const notForced = sec === undefined || ['0', 'false', 'no', 'off'].includes(sec);
    if (notForced && base.mail.security === 'starttls' && base.mail.host && isPrivateHost(base.mail.host)
      && !base.mail.user && envValue(ctx.env, 'SMTP_PASS') === undefined) {
      base.mail.security = 'none';
    }
  }
  // §4.10 / §5.13 VPS: behind a trusted proxy with a public (https) certificate the host uses the panel remotely,
  // so remote access starts `full`; ADMIN_REMOTE (above) overrides. Without one it stays off, and the log says so.
  if (!ctx.lan && !names && envValue(ctx.env, 'ADMIN_REMOTE') === undefined) {
    if (trustedHttpsProxy(ctx.env)) {
      base.admin.remoteAccess = 'full';
    } else {
      warnings.push('NOTICE: remote admin access is OFF (ADMIN_REMOTE is not set, and TRUST_PROXY with an https PUBLIC_URL '
        + 'is not either). Behind an HTTPS proxy set both (docs/DEPLOY-VPS.md): remote access is then full.');
    }
  }
  // §4.2 VPS: no ACCOUNT_EMAIL means optional email; say so once (docs/DEPLOY-VPS.md: set required with SMTP).
  if (!ctx.lan && !names && envValue(ctx.env, 'ACCOUNT_EMAIL') === undefined) {
    warnings.push('NOTICE: ACCOUNT_EMAIL is not set — accounts use OPTIONAL email. For a public server set '
      + 'ACCOUNT_EMAIL=required together with SMTP_* (docs/DEPLOY-VPS.md), or change it in the admin console.');
  }
  // §4.10 VPS parity: upgraded data with moderators keeps today's moderator tools.
  if (!ctx.lan && ctx.existingModerators && (!names || names.includes('(moderators)'))) {
    base.moderators.view = true;
    base.moderators.logSearch = true;
    base.moderators.tier = 'trusted';
  }
  return { settings: base, seeded, warnings };
}

/**
 * Later runs (T-SET-1): one warning per set variable that differs from the saved setting, e.g.
 * "CHAT_LOG_RETENTION_DAYS=30 ignored — the admin console setting (90) wins."
 */
export function envDifferences(s: HostSettings, env: Env): string[] {
  const out: string[] = [];
  for (const e of ENV_SEEDS) {
    const raw = envValue(env, e.name);
    if (raw === undefined) continue;
    const p = e.parse(raw, { lan: true, env });
    if (p.ok && e.same(s, p.value)) continue;
    out.push(`${e.name}=${clipEnv(raw)} ignored — the admin console setting (${e.show(s)}) wins.`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Building and loading a config
// ------------------------------------------------------------------------------------------

export interface CreateOptions {
  lan: boolean;
  preset?: Preset;
  accountsMode?: AccountsMode;
  env?: Env;
  existingModerators?: boolean;
  now?: number;
}

/** A brand-new config: code defaults → preset → environment (first run), with fresh metadata. */
export function createSettings(opts: CreateOptions): SeedResult {
  const now = opts.now ?? Date.now();
  const base = defaultSettings({ preset: opts.preset ?? 'home', lan: opts.lan, accountsMode: opts.accountsMode });
  const ctx: SeedContext = { lan: opts.lan, env: opts.env ?? {}, existingModerators: opts.existingModerators };
  const r = seedFromEnv(base, ctx);
  // Seeded values go through the same field-by-field validation as a stored file (a bad one keeps its default).
  r.settings = coerceSettings(r.settings, defaultSettings({ preset: opts.preset ?? 'home', lan: opts.lan, accountsMode: opts.accountsMode }), r.warnings);
  r.settings.installId = randomBytes(16).toString('hex');
  r.settings.createdAt = now;
  r.settings.updatedAt = now;
  r.settings.rev = 1;
  repairSettings(r.settings, r.warnings, { lan: opts.lan });
  // §4.2 again, after validation: a mail server the validation refused leaves no mail at all.
  if (r.settings.accounts.email === 'required' && !r.settings.mail.host) {
    r.warnings.push(REQUIRED_WITHOUT_MAIL);
    r.settings.accounts.email = 'optional';
  }
  // Only the variables whose value is in force count as seeded (a fallback or a refused value is not: later runs
  // log the "…ignored" line for it, and applyPreset doesn't re-apply it).
  r.seeded = r.seeded.filter((name) => {
    const e = ENV_SEEDS.find((x) => x.name === name);
    const raw = envValue(ctx.env, name);
    if (!e || raw === undefined) return false;
    const p = e.parse(raw, ctx);
    return p.ok && e.same(r.settings, p.value);
  });
  r.settings.seededFromEnv = [...r.seeded];
  return r;
}

/**
 * A stored (or imported) config object → HostSettings: migrated, then validated field by field against the
 * defaults of its own preset, then repaired (cross-field rules). Never throws.
 */
export function settingsFromRaw(raw: Record<string, unknown>, opts: { lan: boolean }, warnings: string[] = []): HostSettings {
  const migrated = migrateConfig(raw, warnings);
  const preset: Preset = migrated.preset === 'school' ? 'school' : 'home';
  const defaults = defaultSettings({ preset, lan: opts.lan });
  const s = coerceSettings(migrated, defaults, warnings);
  if (!s.installId) s.installId = randomBytes(16).toString('hex');
  return repairSettings(s, warnings, { lan: opts.lan });
}

/** What goes into the file: the settings as they are (no secrets exist in them). */
export const serializeSettings = (s: HostSettings): string => `${JSON.stringify(s, null, 2)}\n`;

/** Where the config file of a data folder is. */
export const configPath = (dataDir: string): string => path.join(dataDir, CONFIG_FILE);
