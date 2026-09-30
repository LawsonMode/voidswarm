// OWNER: SETTINGS. Secrets without DPAPI (docs/LAN-EDITION-proposal.md §2.4): everything secret lives in
// data\secrets\ — pepper.key, backup.key and pipe.key (32 random bytes each), smtp.secret (the SMTP password, text),
// and tls\issuing.key / tls\leaf.key (PEM). Nothing secret is ever in the config file, argv or the environment.
//
// Protection is the folder ACL (owner, SYSTEM, Administrators), checked at every start:
//  - POSIX (Mac / Linux hosts, §10): this module checks and fixes the modes itself (folders 0700, files 0600).
//  - Windows: Node has no ACL API, and the sandboxed server child can't run icacls. The launcher (parent) creates
//    the folders first with prepareSecretsDir(), awaiting src/lan/acl.ts protectDir for each, and checks them
//    (checkSecretsAsync with its async ACL check as `aclCheck`), so the rules live in one place.
// The launcher reads the secrets and hands them to the child over IPC (exportBundle → decodeBundle → memorySecrets),
// so the child never needs argv or the environment for them. The child's writes (a new SMTP password from the panel)
// reach the disk through memorySecrets' onChange: the child may write data\ (--allow-fs-write=<root>\data), so it can
// pass `(n, v) => (v ? file.write(n, v) : file.remove(n))` with file = openFileSecrets(dataDir) (files created in the
// protected folder inherit its ACL), or forward the change to the launcher over IPC.
//
// Writes are atomic (temp file → fsync → rename); a new random key is created with a hard link so two processes
// racing to create it end up with the same key.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fsyncBestEffort } from './durable';

export const SECRETS_DIR = 'secrets';

/** Every secret file, relative to data\secrets\ (forward slashes; the tls\ ones are in a subfolder). */
export type SecretName = 'pepper.key' | 'backup.key' | 'pipe.key' | 'smtp.secret' | 'tls/issuing.key' | 'tls/leaf.key';
export const SECRET_NAMES: readonly SecretName[] = ['pepper.key', 'backup.key', 'pipe.key', 'smtp.secret', 'tls/issuing.key', 'tls/leaf.key'];
/** The random keys (ensureKey creates them). */
export const RANDOM_KEYS: readonly SecretName[] = ['pepper.key', 'backup.key', 'pipe.key'];
/** A random key's length. */
export const KEY_BYTES = 32;
/** No secret file is bigger than this (a PEM key is ~250 B; the SMTP password at most 1 KB). */
export const SECRET_MAX_BYTES = 64 * 1024;
/** What exportBundle / decodeBundle exchange (over IPC): base64 values. */
export const BUNDLE_VERSION = 1;

export const isSecretName = (n: unknown): n is SecretName => typeof n === 'string' && (SECRET_NAMES as readonly string[]).includes(n);

export class SecretError extends Error {
  readonly code: 'ENAME' | 'ESIZE' | 'EDAMAGED' | 'EWRITE';
  constructor(code: SecretError['code'], message: string) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

export interface SecretStore {
  /** The data\secrets folder (null for an in-memory store). */
  readonly dir: string | null;
  has(name: SecretName): boolean;
  /** The raw bytes, or null when the secret doesn't exist. */
  read(name: SecretName): Buffer | null;
  /** UTF-8 text (smtp.secret, PEM keys), or null. */
  readText(name: SecretName): string | null;
  /** Save (atomically). Throws SecretError. */
  write(name: SecretName, value: string | Uint8Array): void;
  /** Delete; false when it didn't exist. */
  remove(name: SecretName): boolean;
  /** A random key: the existing one, or a new KEY_BYTES one. Throws EDAMAGED when the stored key has the wrong size. */
  ensureKey(name: SecretName): Buffer;
  /** The secrets that exist, for the IPC hand-off (or the recovery file). */
  exportBundle(names?: readonly SecretName[]): SecretBundle;
}

/** Secrets in transit (launcher → child over IPC). */
export interface SecretBundle { v: number; secrets: Partial<Record<SecretName, string>> }

function checkName(name: unknown): asserts name is SecretName {
  if (!isSecretName(name)) throw new SecretError('ENAME', `Not a secret this server knows: ${String(name).slice(0, 40)}`);
}
function toBuffer(value: string | Uint8Array): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (b.length > SECRET_MAX_BYTES) throw new SecretError('ESIZE', `A secret can be at most ${SECRET_MAX_BYTES} bytes.`);
  return b;
}
function checkKey(name: SecretName, b: Buffer): Buffer {
  if (b.length !== KEY_BYTES) {
    throw new SecretError('EDAMAGED', `data\\secrets\\${name} is damaged (${b.length} bytes, expected ${KEY_BYTES}). `
      + 'Restore it from the recovery file, or delete it to make a new one (encrypted backups made with the old key then need the recovery file).');
  }
  return b;
}

// ------------------------------------------------------------------------------------------
// File-backed store
// ------------------------------------------------------------------------------------------

export interface FileSecretsOptions {
  platform?: NodeJS.Platform;
  /**
   * Called once for every folder this store creates (data\secrets, data\secrets\tls): the launcher passes acl.ts
   * protectDir (owner, SYSTEM and Administrators only). POSIX folders are made 0700 either way.
   */
  protectDir?: (dir: string) => void;
}

/** The data\secrets folder of a data folder. */
export const secretsDir = (dataDir: string): string => path.join(dataDir, SECRETS_DIR);

export interface PrepareSecretsOptions {
  platform?: NodeJS.Platform;
  /**
   * Protects a folder this call created: the launcher passes `(d) => protectDir(d, userSid)` from src/lan/acl.ts
   * (async icacls; it returns an error text or null). Awaited, so no secret is written before the ACL is in place.
   */
  protectDir?: (dir: string) => Promise<string | null | void> | string | null | void;
}

export interface PrepareSecretsResult {
  /** The folders this call created (data\secrets, data\secrets\tls). */
  created: string[];
  /** Problems protecting them (the launcher shows them; checkSecrets reports the ACL at every start anyway). */
  errors: string[];
}

/**
 * The launcher's start-up step (§2.2 "data\secrets\ always gets that ACL when it is created"): create data\secrets
 * and data\secrets\tls if they are missing and protect each new one BEFORE any secret is written (openFileSecrets'
 * protectDir hook is synchronous, and acl.ts protectDir is not). On Windows the tls\ folder inherits the protected
 * ACL of secrets\ ((OI)(CI) grants); it is protected too when this call creates it, which costs one icacls run.
 * Existing folders are left alone (checkSecrets reports them). POSIX folders are made 0700 either way.
 */
export async function prepareSecretsDir(dataDir: string, opts: PrepareSecretsOptions = {}): Promise<PrepareSecretsResult> {
  const posix = (opts.platform ?? process.platform) !== 'win32';
  const created: string[] = [];
  const errors: string[] = [];
  for (const d of [secretsDir(dataDir), path.join(secretsDir(dataDir), 'tls')]) {
    if (fs.existsSync(d)) continue;
    try {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    } catch (e) {
      errors.push(`Could not create ${path.relative(dataDir, d) || d}: ${(e as Error)?.message ?? e}`);
      break;
    }
    created.push(d);
    if (posix) { try { fs.chmodSync(d, 0o700); } catch (e) { errors.push(`Could not restrict ${path.relative(dataDir, d)}: ${(e as Error)?.message ?? e}`); } }
    if (opts.protectDir) {
      try {
        const err = await opts.protectDir(d);
        if (typeof err === 'string' && err) errors.push(err);
      } catch (e) {
        errors.push(`Could not protect ${path.relative(dataDir, d)}: ${(e as Error)?.message ?? e}`);
      }
    }
  }
  return { created, errors };
}

/** The secret store in `<dataDir>\secrets`. Nothing is created until a secret is written. */
export function openFileSecrets(dataDir: string, opts: FileSecretsOptions = {}): SecretStore {
  const dir = secretsDir(dataDir);
  const posix = (opts.platform ?? process.platform) !== 'win32';
  const fileOf = (name: SecretName): string => path.join(dir, ...name.split('/'));

  const ensureDir = (d: string): void => {
    if (fs.existsSync(d)) return;
    if (d !== dir) ensureDir(dir);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (posix) { try { fs.chmodSync(d, 0o700); } catch { /* checkSecrets reports it */ } }
    opts.protectDir?.(d);
  };

  const writeTemp = (target: string, data: Buffer): string => {
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, data);
      fsyncBestEffort(fd);
    } finally {
      fs.closeSync(fd);
    }
    return tmp;
  };

  const read = (name: SecretName): Buffer | null => {
    checkName(name);
    try {
      const st = fs.statSync(fileOf(name));
      if (st.size > SECRET_MAX_BYTES) throw new SecretError('EDAMAGED', `data\\secrets\\${name} is too big to be a secret.`);
      return fs.readFileSync(fileOf(name));
    } catch (e) {
      if (e instanceof SecretError) throw e;
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  };

  const store: SecretStore = {
    dir,
    has: (name) => { checkName(name); return fs.existsSync(fileOf(name)); },
    read,
    readText: (name) => read(name)?.toString('utf8') ?? null,
    write(name, value) {
      checkName(name);
      const data = toBuffer(value);
      const target = fileOf(name);
      let tmp: string | null = null;
      try {
        ensureDir(path.dirname(target));
        const written = writeTemp(target, data);
        tmp = written;
        for (let i = 0; ; i++) {
          try { fs.renameSync(written, target); tmp = null; break; } catch (e) {
            const c = (e as NodeJS.ErrnoException)?.code;
            if (i >= 8 || (c !== 'EPERM' && c !== 'EBUSY' && c !== 'EACCES')) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (i + 1));
          }
        }
        if (posix) { try { fs.chmodSync(target, 0o600); } catch { /* checkSecrets reports it */ } }
      } catch (e) {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
        if (e instanceof SecretError) throw e;
        throw new SecretError('EWRITE', `Could not save data\\secrets\\${name}: ${(e as Error)?.message ?? e}`);
      }
    },
    remove(name) {
      checkName(name);
      try { fs.unlinkSync(fileOf(name)); return true; } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
        throw new SecretError('EWRITE', `Could not delete data\\secrets\\${name}: ${(e as Error)?.message ?? e}`);
      }
    },
    ensureKey(name) {
      checkName(name);
      if (!RANDOM_KEYS.includes(name)) throw new SecretError('ENAME', `${name} is not a random key.`);
      const existing = read(name);
      if (existing) return checkKey(name, existing);
      const target = fileOf(name);
      ensureDir(path.dirname(target));
      const key = randomBytes(KEY_BYTES);
      const tmp = writeTemp(target, key);
      try {
        // A hard link never replaces an existing file: whoever links first wins, the other reads the winner's key.
        fs.linkSync(tmp, target);
      } catch (e) {
        const c = (e as NodeJS.ErrnoException)?.code;
        if (c !== 'EEXIST') {
          // No hard links on this file system: an exclusive create (a torn write shows up as EDAMAGED next time).
          try { fs.writeFileSync(target, key, { flag: 'wx', mode: 0o600 }); } catch (e2) {
            if ((e2 as NodeJS.ErrnoException)?.code !== 'EEXIST') {
              try { fs.unlinkSync(tmp); } catch { /* gone */ }
              throw new SecretError('EWRITE', `Could not create data\\secrets\\${name}: ${(e2 as Error)?.message ?? e2}`);
            }
          }
        }
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* gone */ }
      }
      if (posix) { try { fs.chmodSync(target, 0o600); } catch { /* checkSecrets reports it */ } }
      return checkKey(name, read(name) ?? key);
    },
    exportBundle: (names) => bundleOf(store, names),
  };
  return store;
}

function bundleOf(store: SecretStore, names: readonly SecretName[] = SECRET_NAMES): SecretBundle {
  const secrets: Partial<Record<SecretName, string>> = {};
  for (const n of names) {
    const b = store.read(n);
    if (b) secrets[n] = b.toString('base64');
  }
  return { v: BUNDLE_VERSION, secrets };
}

// ------------------------------------------------------------------------------------------
// In-memory store (the child, from the launcher's IPC bundle; tests)
// ------------------------------------------------------------------------------------------

export interface MemorySecretsOptions {
  /** Every write / remove is passed on (e.g. to the file store, or to the launcher over IPC). null = removed. */
  onChange?: (name: SecretName, value: Buffer | null) => void;
}

export function memorySecrets(init: SecretBundle | Partial<Record<SecretName, string | Uint8Array>> | null = null, opts: MemorySecretsOptions = {}): SecretStore {
  const map = new Map<SecretName, Buffer>();
  if (init && typeof init === 'object') {
    if ('v' in init && 'secrets' in init) {
      for (const [n, b] of Object.entries(decodeBundle(init).secrets)) map.set(n as SecretName, Buffer.from(b as string, 'base64'));
    } else {
      for (const [n, v] of Object.entries(init)) {
        checkName(n);
        if (v !== undefined) map.set(n, toBuffer(v as string | Uint8Array));
      }
    }
  }
  const store: SecretStore = {
    dir: null,
    has: (name) => { checkName(name); return map.has(name); },
    read: (name) => { checkName(name); const b = map.get(name); return b ? Buffer.from(b) : null; },
    readText: (name) => { checkName(name); return map.get(name)?.toString('utf8') ?? null; },
    write(name, value) {
      checkName(name);
      const b = toBuffer(value);
      opts.onChange?.(name, Buffer.from(b));
      map.set(name, b);
    },
    remove(name) {
      checkName(name);
      if (!map.has(name)) return false;
      opts.onChange?.(name, null);
      map.delete(name);
      return true;
    },
    ensureKey(name) {
      checkName(name);
      if (!RANDOM_KEYS.includes(name)) throw new SecretError('ENAME', `${name} is not a random key.`);
      const b = map.get(name);
      if (b) return checkKey(name, Buffer.from(b));
      const key = randomBytes(KEY_BYTES);
      opts.onChange?.(name, Buffer.from(key));
      map.set(name, key);
      return Buffer.from(key);
    },
    exportBundle: (names) => bundleOf(store, names),
  };
  return store;
}

/** Validate an IPC bundle (untrusted shape): known names, base64, sizes. Throws SecretError. */
export function decodeBundle(m: unknown): SecretBundle {
  if (!m || typeof m !== 'object') throw new SecretError('ENAME', 'The secrets message is not an object.');
  const o = m as { v?: unknown; secrets?: unknown };
  if (o.v !== BUNDLE_VERSION || !o.secrets || typeof o.secrets !== 'object') throw new SecretError('ENAME', 'The secrets message has the wrong version.');
  const out: Partial<Record<SecretName, string>> = {};
  for (const [n, v] of Object.entries(o.secrets as Record<string, unknown>)) {
    checkName(n);
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length > Math.ceil(SECRET_MAX_BYTES / 3) * 4) {
      throw new SecretError('ESIZE', `The secret ${n} in the message is not valid base64.`);
    }
    out[n] = v;
  }
  return { v: BUNDLE_VERSION, secrets: out };
}

// ------------------------------------------------------------------------------------------
// The start-up check
// ------------------------------------------------------------------------------------------

export interface SecretProblem {
  /** The folder or file, relative to the data folder (e.g. "secrets\pepper.key"). */
  what: string;
  why: string;
}

export interface SecretsCheck {
  ok: boolean;
  problems: SecretProblem[];
  /** How it was checked: POSIX modes, the launcher's ACL check, or not at all (Windows without the hook). */
  method: 'mode' | 'acl' | 'unchecked';
  /** The paths looked at. */
  checked: string[];
}

export interface CheckSecretsOptions {
  platform?: NodeJS.Platform;
  /** Windows: the launcher's ACL check of the folder (acl.ts), as problem texts. */
  aclCheck?: (dir: string) => string[];
  /** POSIX: fix the modes (0700 / 0600) before reporting. Default false. */
  fix?: boolean;
}

/**
 * The every-start check of data\secrets (§2.4): nobody but the owner (and SYSTEM / Administrators on Windows) may
 * read it. Also flags a random key of the wrong size (damaged). An absent folder is fine (nothing secret yet).
 */
export function checkSecrets(dataDir: string, opts: CheckSecretsOptions = {}): SecretsCheck {
  const dir = secretsDir(dataDir);
  const posix = (opts.platform ?? process.platform) !== 'win32';
  const problems: SecretProblem[] = [];
  const checked: string[] = [];
  const rel = (p: string): string => path.relative(dataDir, p) || p;
  if (!fs.existsSync(dir)) return { ok: true, problems, method: posix ? 'mode' : opts.aclCheck ? 'acl' : 'unchecked', checked };

  const entries: { p: string; isDir: boolean }[] = [{ p: dir, isDir: true }];
  const tls = path.join(dir, 'tls');
  if (fs.existsSync(tls)) entries.push({ p: tls, isDir: true });
  for (const n of SECRET_NAMES) {
    const p = path.join(dir, ...n.split('/'));
    if (fs.existsSync(p)) entries.push({ p, isDir: false });
  }
  for (const n of RANDOM_KEYS) {
    const p = path.join(dir, n);
    try {
      const size = fs.statSync(p).size;
      if (size !== KEY_BYTES) problems.push({ what: rel(p), why: `damaged: ${size} bytes instead of ${KEY_BYTES}` });
    } catch { /* not created yet */ }
  }

  if (posix) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    for (const e of entries) {
      checked.push(e.p);
      let st: fs.Stats;
      try { st = fs.statSync(e.p); } catch { continue; }
      const want = e.isDir ? 0o700 : 0o600;
      if (opts.fix && (st.mode & 0o077)) {
        try { fs.chmodSync(e.p, want); st = fs.statSync(e.p); } catch { /* reported below */ }
      }
      if (st.mode & 0o077) problems.push({ what: rel(e.p), why: `other users can read it (mode ${(st.mode & 0o777).toString(8)}; it should be ${want.toString(8)})` });
      if (uid >= 0 && st.uid !== uid) problems.push({ what: rel(e.p), why: `it belongs to another user (uid ${st.uid})` });
    }
    return { ok: problems.length === 0, problems, method: 'mode', checked };
  }
  if (opts.aclCheck) {
    checked.push(dir);
    for (const why of opts.aclCheck(dir)) problems.push({ what: rel(dir), why });
    return { ok: problems.length === 0, problems, method: 'acl', checked };
  }
  return { ok: problems.length === 0, problems, method: 'unchecked', checked };
}

export interface CheckSecretsAsyncOptions extends Omit<CheckSecretsOptions, 'aclCheck'> {
  /**
   * Windows: the launcher's ACL check of data\secrets as problem texts; it may be async (src/lan/acl.ts runs icacls:
   * e.g. `async () => (await checkPermissions(o)).problems.filter((p) => isUnder(p.path, dir)).map(describe)`).
   * A check that throws is reported as a problem (the folder's protection is then unknown).
   */
  aclCheck?: (dir: string) => string[] | Promise<string[]>;
}

/** checkSecrets with an async ACL check (the launcher's). POSIX and the damaged-key check are the same. */
export async function checkSecretsAsync(dataDir: string, opts: CheckSecretsAsyncOptions = {}): Promise<SecretsCheck> {
  const posix = (opts.platform ?? process.platform) !== 'win32';
  const { aclCheck, ...rest } = opts;
  const base = checkSecrets(dataDir, rest);
  const dir = secretsDir(dataDir);
  if (posix || !aclCheck) return base;
  if (!fs.existsSync(dir)) return { ...base, method: 'acl' };
  const problems = [...base.problems];
  const what = path.relative(dataDir, dir) || dir;
  try {
    for (const why of await aclCheck(dir)) problems.push({ what, why });
  } catch (e) {
    problems.push({ what, why: `its permissions could not be checked: ${(e as Error)?.message ?? e}` });
  }
  return { ok: problems.length === 0, problems, method: 'acl', checked: [...base.checked, dir] };
}
