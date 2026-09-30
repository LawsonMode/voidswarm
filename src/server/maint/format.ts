// OWNER: SERVER MODERATION (LAN task B5). The encrypted backup file, *.vsbak (docs/LAN-EDITION-proposal.md §6.1).
//
// Layout on disk:
//   header  "VSBK1" (5 bytes) | key id (8 bytes) | nonce (12 bytes)            = 25 bytes, also the GCM AAD
//   body    AES-256-GCM( gzip( container ) ) with data\secrets\backup.key
//   tag     the 16-byte GCM tag
// The container (plaintext, inside the gzip):
//   "VSBKP1" (6 bytes) | manifest length (uint32 BE) | manifest JSON | the files' bytes, in manifest order.
// The key id (a keyed hash of the key, never the key) tells a restore at once whether this install's backup.key made
// the file or whether it needs the recovery file of the install that did (§6.3).
//
// Everything streams (a 1M-line chat log is ~450 MB), so a backup never holds the database in memory. Nothing from
// a decrypted file is trusted until the GCM tag verified at the very end: the extracted files are written as
// `.part` files and only renamed once the whole stream authenticated.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, constants as zlibConstants } from 'node:zlib';
import { fsyncBestEffort } from '../durable';

export const VSBAK_MAGIC = 'VSBK1';
export const CONTAINER_MAGIC = 'VSBKP1';
export const KEY_ID_BYTES = 8;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = VSBAK_MAGIC.length + KEY_ID_BYTES + NONCE_BYTES;
/** A manifest is a few hundred bytes; anything bigger is not ours. */
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MANIFEST_VERSION = 1;

/** The files a backup may hold (§6.1). Never secrets\, tls\, logs\ or exports\. */
export const BACKUP_FILES = ['voidswarm.db', 'voidswarm.config.json', 'deletions.jsonl'] as const;
export type BackupFileName = (typeof BACKUP_FILES)[number];
/** Per-file size limits (the DB has none worth stating; the others are small by design). */
export const BACKUP_FILE_MAX: Readonly<Record<BackupFileName, number>> = {
  'voidswarm.db': 256 * 1024 ** 3,
  'voidswarm.config.json': 1024 * 1024,
  'deletions.jsonl': 256 * 1024 * 1024,
};

export type BackupErrorCode =
  /** not a Voidswarm backup, or damaged beyond the header */
  | 'EFORMAT'
  /** made with another backup key: needs the recovery file of the install that made it */
  | 'EKEY'
  /** the contents failed authentication (changed, truncated or damaged) */
  | 'EAUTH'
  /** a file changed size while it was being backed up */
  | 'ECHANGED'
  /** the key given is not a 32-byte key */
  | 'EBADKEY'
  /** the drive filled up while the backup was written or unpacked */
  | 'ENOSPC';

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BackupError';
    this.code = code;
  }
}

export interface BackupManifest {
  v: number;
  /** epoch ms */
  createdAt: number;
  /** the class: start, daily, weekly, manual, pre-migration, … (names.ts) */
  reason: string;
  detail: string | null;
  /** the Voidswarm version that made it */
  appVersion: string;
  /** PRAGMA user_version of the database copy (null when the backup has no database) */
  schemaVersion: number | null;
  /** settings.installId of the install that made it ('' when unknown) */
  installId: string;
  /**
   * pepperIdOf(the pepper the database's email hashes and address tags were made with), so a restore installs the
   * right one (an undo after a restore from another PC needs this PC's old pepper back); null when unknown.
   */
  pepperId?: string | null;
  files: { name: BackupFileName; size: number }[];
}

export interface BackupHeader {
  keyId: string;
  nonce: Buffer;
  /** the whole file size */
  size: number;
}

const KEY_ID_LABEL = 'voidswarm backup key id v1';
/** The label of a pepper's key id (the recovery state and the backup manifest). */
export const PEPPER_ID_LABEL = 'voidswarm pepper id v1';

function checkKey(key: Uint8Array): Buffer {
  const k = Buffer.from(key);
  if (k.length !== 32) throw new BackupError('EBADKEY', `A backup key is 32 bytes (got ${k.length}).`);
  return k;
}

/** The key id stored in a backup's header: a keyed hash, so it reveals nothing about the key. 16 hex characters. */
export function keyIdOf(key: Uint8Array, label = KEY_ID_LABEL): string {
  return createHmac('sha256', Buffer.from(key)).update(label, 'utf8').digest().subarray(0, KEY_ID_BYTES).toString('hex');
}

/** A pepper's key id (16 hex; reveals nothing about it). */
export const pepperIdOf = (pepper: Uint8Array): string => keyIdOf(pepper, PEPPER_ID_LABEL);

export const isBackupFileName = (n: unknown): n is BackupFileName => typeof n === 'string' && (BACKUP_FILES as readonly string[]).includes(n);

/** Read and check a backup's header (no key needed). Throws BackupError EFORMAT. */
export function readBackupHeader(file: string): BackupHeader {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    throw new BackupError('EFORMAT', `Can't open the backup ${path.basename(file)}: ${(e as Error)?.message ?? e}`, e);
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < HEADER_BYTES + TAG_BYTES + 1) throw new BackupError('EFORMAT', `${path.basename(file)} is too short to be a Voidswarm backup.`);
    const h = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, h, 0, HEADER_BYTES, 0);
    if (h.subarray(0, VSBAK_MAGIC.length).toString('latin1') !== VSBAK_MAGIC) {
      throw new BackupError('EFORMAT', `${path.basename(file)} is not a Voidswarm backup.`);
    }
    const keyId = h.subarray(VSBAK_MAGIC.length, VSBAK_MAGIC.length + KEY_ID_BYTES).toString('hex');
    const nonce = Buffer.from(h.subarray(VSBAK_MAGIC.length + KEY_ID_BYTES));
    return { keyId, nonce, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Validate a manifest read from a decrypted container (untrusted until the tag verifies; checked anyway). */
export function parseManifest(json: string): BackupManifest {
  let m: unknown;
  try { m = JSON.parse(json); } catch { throw new BackupError('EFORMAT', 'The backup manifest is not readable.'); }
  if (!m || typeof m !== 'object') throw new BackupError('EFORMAT', 'The backup manifest is not an object.');
  const o = m as Record<string, unknown>;
  if (o.v !== MANIFEST_VERSION) throw new BackupError('EFORMAT', `The backup manifest has version ${String(o.v)}; this Voidswarm reads version ${MANIFEST_VERSION}.`);
  if (!Array.isArray(o.files) || o.files.length > BACKUP_FILES.length) throw new BackupError('EFORMAT', 'The backup manifest lists no files.');
  const seen = new Set<string>();
  const files: BackupManifest['files'] = [];
  for (const f of o.files as unknown[]) {
    const r = f as { name?: unknown; size?: unknown };
    if (!r || !isBackupFileName(r.name) || seen.has(r.name)) throw new BackupError('EFORMAT', 'The backup manifest lists an unexpected file.');
    if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0 || r.size > BACKUP_FILE_MAX[r.name]) {
      throw new BackupError('EFORMAT', `The backup manifest gives a bad size for ${r.name}.`);
    }
    seen.add(r.name);
    files.push({ name: r.name, size: r.size });
  }
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    v: MANIFEST_VERSION,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0,
    reason: str(o.reason, 40),
    detail: typeof o.detail === 'string' ? o.detail.slice(0, 40) : null,
    appVersion: str(o.appVersion, 40),
    schemaVersion: typeof o.schemaVersion === 'number' && Number.isInteger(o.schemaVersion) ? o.schemaVersion : null,
    installId: str(o.installId, 64),
    pepperId: typeof o.pepperId === 'string' && /^[0-9a-f]{16}$/.test(o.pepperId) ? o.pepperId : null,
    files,
  };
}

export interface SourceFile {
  name: BackupFileName;
  /** a file on disk (streamed; its size must not change while it is read) … */
  path?: string;
  /** … or its bytes (small files: the config and the ledger) */
  data?: Uint8Array;
}

export interface WriteBackupOptions {
  /** gzip level (default 6) */
  level?: number;
  signal?: AbortSignal;
  /** fsync the file before the rename (default true) */
  fsync?: boolean;
}

/**
 * Write an encrypted backup to `dest` (atomically: a temp file beside it, fsync, rename). The manifest's `files`
 * are filled in from `files`. Returns the file size.
 */
export async function writeBackupFile(
  dest: string, key: Uint8Array, manifest: Omit<BackupManifest, 'files' | 'v'>, files: readonly SourceFile[], opts: WriteBackupOptions = {},
): Promise<number> {
  const k = checkKey(key);
  const entries: { name: BackupFileName; size: number; path?: string; data?: Buffer }[] = [];
  for (const f of files) {
    if (!isBackupFileName(f.name)) throw new Error(`writeBackupFile: ${String(f.name)} can't go in a backup`);
    if (entries.some((e) => e.name === f.name)) throw new Error(`writeBackupFile: ${f.name} twice`);
    if (f.data) entries.push({ name: f.name, size: f.data.byteLength, data: Buffer.from(f.data) });
    else if (f.path) entries.push({ name: f.name, size: fs.statSync(f.path).size, path: f.path });
    else throw new Error(`writeBackupFile: ${f.name} has no path or data`);
  }
  const full: BackupManifest = { ...manifest, v: MANIFEST_VERSION, files: entries.map((e) => ({ name: e.name, size: e.size })) };
  const manifestBytes = Buffer.from(JSON.stringify(full), 'utf8');
  if (manifestBytes.length > MANIFEST_MAX_BYTES) throw new Error('writeBackupFile: manifest too big');

  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([Buffer.from(VSBAK_MAGIC, 'latin1'), Buffer.from(keyIdOf(k), 'hex'), nonce]);
  const cipher = createCipheriv('aes-256-gcm', k, nonce);
  cipher.setAAD(header);

  async function* container(): AsyncGenerator<Buffer> {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(manifestBytes.length, 0);
    yield Buffer.concat([Buffer.from(CONTAINER_MAGIC, 'latin1'), len, manifestBytes]);
    for (const e of entries) {
      if (e.data) { if (e.data.length) yield e.data; continue; }
      let n = 0;
      for await (const chunk of fs.createReadStream(e.path!, { highWaterMark: 1 << 20, end: e.size > 0 ? e.size - 1 : undefined, start: 0 })) {
        const b = chunk as Buffer;
        n += b.length;
        yield b;
      }
      if (n !== e.size) throw new BackupError('ECHANGED', `${e.name} changed while it was being backed up (${n} of ${e.size} bytes).`);
    }
  }

  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(
      Readable.from(container()),
      createGzip({ level: opts.level ?? zlibConstants.Z_DEFAULT_COMPRESSION }),
      cipher,
      async function* (src: AsyncIterable<Buffer>) {
        yield header;
        for await (const c of src) yield c;
        yield cipher.getAuthTag();
      },
      out,
      { signal: opts.signal },
    );
    if (opts.fsync !== false) {
      const fd = fs.openSync(tmp, 'r+');
      try { fsyncBestEffort(fd); } finally { fs.closeSync(fd); }
    }
    fs.renameSync(tmp, dest);
    return fs.statSync(dest).size;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    if (isNoSpace(e)) throw noSpaceError(`writing the backup ${path.basename(dest)}`, e);
    throw e;
  }
}

export interface ExtractedFile { name: BackupFileName; path: string; size: number }
export interface ExtractResult { manifest: BackupManifest; header: BackupHeader; files: ExtractedFile[] }

export interface ReadBackupOptions {
  signal?: AbortSignal;
  /** Only these files are written (the rest are read and discarded). Default: all. */
  only?: readonly BackupFileName[];
  /**
   * Called with the manifest before any file is written (e.g. a free-space check against the sizes it lists; it is
   * not authenticated yet, so only use it to refuse early). Throwing stops the unpack, leaving nothing behind.
   */
  onManifest?: (m: BackupManifest) => void | Promise<void>;
}

/** "The data drive is full" for an ENOSPC from writing `what`. */
export const noSpaceError = (what: string, cause?: unknown): BackupError =>
  new BackupError('ENOSPC', `The drive ran out of space while ${what}: free some space and try again.`, cause);
const isNoSpace = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOSPC';

/**
 * Decrypt and unpack a backup into `destDir` (created if missing). The files appear under their own names only after
 * the whole file authenticated; on any failure nothing is left behind. Existing files of the same name in `destDir`
 * are replaced. Throws BackupError: EFORMAT, EKEY (another install's key: use its recovery file), EAUTH.
 */
export async function readBackupFile(file: string, key: Uint8Array, destDir: string, opts: ReadBackupOptions = {}): Promise<ExtractResult> {
  const k = checkKey(key);
  const header = readBackupHeader(file);
  const want = keyIdOf(k);
  if (!timingSafeEqual(Buffer.from(header.keyId, 'hex'), Buffer.from(want, 'hex'))) {
    throw new BackupError('EKEY', `${path.basename(file)} was made by another copy of Voidswarm (another backup key). `
      + 'Restore it with the recovery file of that copy ("Restore a backup.cmd --recovery <file>").');
  }
  const tag = Buffer.alloc(TAG_BYTES);
  {
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, tag, 0, TAG_BYTES, header.size - TAG_BYTES); } finally { fs.closeSync(fd); }
  }
  const headerBytes = Buffer.concat([Buffer.from(VSBAK_MAGIC, 'latin1'), Buffer.from(header.keyId, 'hex'), header.nonce]);
  const decipher = createDecipheriv('aes-256-gcm', k, header.nonce);
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(tag);

  fs.mkdirSync(destDir, { recursive: true });
  const parts: string[] = [];
  let manifest: BackupManifest | null = null;
  const written: ExtractedFile[] = [];

  const unpack = async (src: AsyncIterable<Buffer>): Promise<void> => {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stage: 'magic' | 'files' = 'magic';
    let index = 0;
    let left = 0;
    let fh: fs.promises.FileHandle | null = null;
    const openNext = async (): Promise<void> => {
      while (manifest && index < manifest.files.length) {
        const f = manifest.files[index]!;
        left = f.size;
        const keep = !opts.only || opts.only.includes(f.name);
        if (keep) {
          const part = path.join(destDir, `${f.name}.part`);
          parts.push(part);
          fh = await fs.promises.open(part, 'w', 0o600);
          written.push({ name: f.name, path: path.join(destDir, f.name), size: f.size });
        } else fh = null;
        if (left > 0) return;
        if (fh) { await (fh as fs.promises.FileHandle).close(); fh = null; }
        index++;
      }
      stage = 'files';
      left = -1; // all files done: nothing more may follow
    };
    try {
      for await (const chunk of src) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (stage === 'magic') {
          const head = CONTAINER_MAGIC.length + 4;
          if (buf.length < head) continue;
          if (buf.subarray(0, CONTAINER_MAGIC.length).toString('latin1') !== CONTAINER_MAGIC) throw new BackupError('EFORMAT', 'The backup contents are not in the expected format.');
          const len = buf.readUInt32BE(CONTAINER_MAGIC.length);
          if (len > MANIFEST_MAX_BYTES) throw new BackupError('EFORMAT', 'The backup manifest is too big.');
          if (buf.length < head + len) continue;
          manifest = parseManifest(buf.subarray(head, head + len).toString('utf8'));
          if (opts.onManifest) await opts.onManifest(manifest);
          buf = buf.subarray(head + len);
          stage = 'files';
          await openNext();
        }
        while (buf.length) {
          if (left < 0) throw new BackupError('EFORMAT', 'The backup has extra data after its files.');
          const take = Math.min(left, buf.length);
          if (fh) await (fh as fs.promises.FileHandle).write(buf.subarray(0, take));
          buf = buf.subarray(take);
          left -= take;
          if (left === 0) {
            if (fh) { await (fh as fs.promises.FileHandle).close(); fh = null; }
            index++;
            await openNext();
          }
        }
      }
      if (!manifest) throw new BackupError('EFORMAT', 'The backup is empty.');
      if (left > 0) throw new BackupError('EFORMAT', 'The backup ends early.');
    } finally {
      if (fh) { try { await (fh as fs.promises.FileHandle).close(); } catch { /* closed */ } }
    }
  };

  try {
    await pipeline(
      fs.createReadStream(file, { start: HEADER_BYTES, end: header.size - TAG_BYTES - 1, highWaterMark: 1 << 20 }),
      decipher,
      createGunzip(),
      unpack,
      { signal: opts.signal },
    );
  } catch (e) {
    for (const p of parts) { try { fs.rmSync(p, { force: true }); } catch { /* gone */ } }
    if (e instanceof BackupError) throw e;
    if (isNoSpace(e)) throw noSpaceError(`unpacking ${path.basename(file)}`, e);
    const msg = String((e as Error)?.message ?? e);
    if (/unable to authenticate|auth/i.test(msg)) {
      throw new BackupError('EAUTH', `${path.basename(file)} failed its integrity check: it was changed, cut short or damaged.`, e);
    }
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new BackupError('EAUTH', `${path.basename(file)} could not be read: it was changed, cut short or damaged (${msg}).`, e);
  }
  for (const f of written) {
    fs.rmSync(f.path, { force: true });
    fs.renameSync(`${f.path}.part`, f.path);
  }
  return { manifest: manifest!, header, files: written };
}

/** Decrypt a backup just to check it (every byte authenticated; nothing written). Returns its manifest. */
export async function verifyBackupFile(file: string, key: Uint8Array, tmpDir: string): Promise<BackupManifest> {
  const r = await readBackupFile(file, key, tmpDir, { only: [] });
  return r.manifest;
}
