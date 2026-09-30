// OWNER: SERVER MODERATION (LAN task B5). The recovery file (docs/LAN-EDITION-proposal.md §6.3, §2.4):
// voidswarm-recovery-<server>-<date>.vsrec holds the pepper, the backup key, the SMTP password and the install id —
// never a certificate key (the root key doesn't exist; the issuing key stays on the PC). With a backup it rebuilds
// the server on another PC ("Bring in data from another copy", `tool restore --recovery`), and it is the only
// source of secrets from elsewhere (§6.5).
//
// Encryption: AES-256-GCM with a key from scrypt (N = 2^17, r = 8, p = 1) of a passphrase. The passphrase is 4
// generated words, shown once ("write it down, keep it apart from the file"), or the host's own of 16 characters or
// more. The words are pronounceable (consonant-vowel-consonant-vowel-consonant), about 16.6 bits each, 66 bits in
// all, and never one the chat filter would catch.
//
// File layout: "VSRC1" | kdf 1 = scrypt | log2 N | r | p | salt (16) | nonce (12) | ciphertext | tag (16); the header
// (everything before the ciphertext) is the GCM AAD.
import { createCipheriv, createDecipheriv, randomBytes, randomInt, scrypt as scryptCb } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { checkName, filterChat } from '../../shared/moderation/filter';
import type { Banner } from './disk';
import { keyIdOf, PEPPER_ID_LABEL } from './format';

export const VSREC_MAGIC = 'VSRC1';
export const VSREC_EXT = '.vsrec';
export const RECOVERY_VERSION = 1;
export const RECOVERY_STATE_FILE = 'recovery.json';
export const PASSPHRASE_MIN_CHARS = 16;
export const GENERATED_WORDS = 4;
export const SCRYPT_LOG2N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = VSREC_MAGIC.length + 4 + SALT_BYTES + NONCE_BYTES;
const MAX_FILE_BYTES = 64 * 1024;
// The state file keeps the pepper's key id with format.ts PEPPER_ID_LABEL (the banner notices a replaced key).

const CONSONANTS = 'bdfghjklmnprstvz';
const VOWELS = 'aeiou';

export type RecoveryErrorCode = 'EFORMAT' | 'EPASS' | 'EWEAK';

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  constructor(code: RecoveryErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

/** What a recovery file holds (base64 for the keys). */
export interface RecoveryContents {
  v: number;
  createdAt: number;
  serverName: string;
  installId: string;
  pepper: string | null;
  backupKey: string | null;
  smtpPassword: string | null;
}

// ------------------------------------------------------------------------------------------
// Passphrases
// ------------------------------------------------------------------------------------------

/** One pronounceable word (CVCVC), e.g. "bakor". */
export function generateWord(rand: (n: number) => number = randomInt): string {
  let w = '';
  for (let i = 0; i < 5; i++) w += i % 2 === 0 ? CONSONANTS[rand(CONSONANTS.length)] : VOWELS[rand(VOWELS.length)];
  return w;
}

const clean = (s: string): boolean => filterChat(s, { custom: null }).action === 'pass' && checkName(s, { custom: null }).ok;

/** Four generated words separated by spaces ("bakor tuvim lesap niror"), none the chat filter would catch. */
export function generatePassphrase(rand: (n: number) => number = randomInt): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const words: string[] = [];
    while (words.length < GENERATED_WORDS) {
      const w = generateWord(rand);
      if (!words.includes(w) && clean(w)) words.push(w);
    }
    const phrase = words.join(' ');
    if (clean(phrase) && clean(words.join(''))) return phrase;
  }
  throw new Error('generatePassphrase: could not find clean words');
}

/**
 * The form a passphrase is used in: NFKC, trimmed, runs of whitespace as one space. Four words of letters (the
 * generated form, typed with spaces or hyphens, any case) become lower case with single spaces.
 */
export function normalizePassphrase(p: string): string {
  const s = String(p ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (/^[A-Za-z]+(?:[ -][A-Za-z]+){3}$/.test(s)) return s.toLowerCase().replace(/-/g, ' ');
  return s;
}

/** null when fine, else why not: 16 characters or more, or the generated words. */
export function passphraseProblem(p: string): string | null {
  const s = normalizePassphrase(p);
  if (!s) return 'Type a passphrase of 16 characters or more, or use the generated words.';
  if ([...s].length < PASSPHRASE_MIN_CHARS) return `The passphrase needs ${PASSPHRASE_MIN_CHARS} characters or more (or use the generated words).`;
  return null;
}

// ------------------------------------------------------------------------------------------
// Encrypt / decrypt
// ------------------------------------------------------------------------------------------

export interface RecoveryCryptoOptions {
  /** log2 of scrypt's N (default 17; tests may lower it; decryption accepts SCRYPT_LOG2N_MIN..SCRYPT_LOG2N_MAX) */
  log2N?: number;
}

/**
 * The scrypt parameters a recovery file may ask for. Only what this version writes (r = 8, p = 1) and N up to 2^18
 * (256 MiB, twice the default), so a crafted file can't make the restore allocate gigabytes or run for minutes.
 */
export const SCRYPT_LOG2N_MIN = 12;
export const SCRYPT_LOG2N_MAX = 18;

const scryptMaxmem = (log2N: number, r: number): number => 128 * r * (2 ** log2N) * 2 + 16 * 1024 * 1024;

function deriveKey(passphrase: string, salt: Buffer, log2N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(Buffer.from(passphrase, 'utf8'), salt, 32, { N: 2 ** log2N, r, p, maxmem: scryptMaxmem(log2N, r) }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Encrypt the contents with the passphrase (checked: 16+ characters). */
export async function encryptRecovery(contents: RecoveryContents, passphrase: string, opts: RecoveryCryptoOptions = {}): Promise<Buffer> {
  const why = passphraseProblem(passphrase);
  if (why) throw new RecoveryError('EWEAK', why);
  const log2N = opts.log2N ?? SCRYPT_LOG2N;
  if (!Number.isInteger(log2N) || log2N < SCRYPT_LOG2N_MIN || log2N > SCRYPT_LOG2N_MAX) throw new RangeError(`encryptRecovery: log2N must be ${SCRYPT_LOG2N_MIN}..${SCRYPT_LOG2N_MAX}`);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([Buffer.from(VSREC_MAGIC, 'latin1'), Buffer.from([1, log2N, SCRYPT_R, SCRYPT_P]), salt, nonce]);
  const key = await deriveKey(normalizePassphrase(passphrase), salt, log2N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...contents, v: RECOVERY_VERSION }), 'utf8'), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** Decrypt a recovery file. Throws RecoveryError EFORMAT (not one) or EPASS (wrong passphrase, or changed). */
export async function decryptRecovery(buf: Uint8Array, passphrase: string): Promise<RecoveryContents> {
  const b = Buffer.from(buf);
  if (b.length < HEADER_BYTES + TAG_BYTES + 2 || b.length > MAX_FILE_BYTES || b.subarray(0, VSREC_MAGIC.length).toString('latin1') !== VSREC_MAGIC) {
    throw new RecoveryError('EFORMAT', 'This is not a Voidswarm recovery file (.vsrec).');
  }
  const [kdf, log2N, r, p] = [b[5]!, b[6]!, b[7]!, b[8]!];
  if (kdf !== 1 || log2N < SCRYPT_LOG2N_MIN || log2N > SCRYPT_LOG2N_MAX || r !== SCRYPT_R || p !== SCRYPT_P) {
    throw new RecoveryError('EFORMAT', 'This recovery file was made by a newer version of Voidswarm, or it is damaged.');
  }
  const header = b.subarray(0, HEADER_BYTES);
  const salt = b.subarray(VSREC_MAGIC.length + 4, VSREC_MAGIC.length + 4 + SALT_BYTES);
  const nonce = b.subarray(VSREC_MAGIC.length + 4 + SALT_BYTES, HEADER_BYTES);
  const tag = b.subarray(b.length - TAG_BYTES);
  const key = await deriveKey(normalizePassphrase(passphrase), Buffer.from(salt), log2N, r, p);
  let json: string;
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(header);
    d.setAuthTag(tag);
    json = Buffer.concat([d.update(b.subarray(HEADER_BYTES, b.length - TAG_BYTES)), d.final()]).toString('utf8');
  } catch {
    throw new RecoveryError('EPASS', 'That passphrase does not open this recovery file (or the file was changed).');
  }
  let o: Record<string, unknown>;
  try { o = JSON.parse(json) as Record<string, unknown>; } catch { throw new RecoveryError('EFORMAT', 'The recovery file contents are damaged.'); }
  const b64 = (v: unknown, bytes?: number): string | null => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
    if (bytes !== undefined && Buffer.from(v, 'base64').length !== bytes) return null;
    return v;
  };
  return {
    v: RECOVERY_VERSION,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    serverName: typeof o.serverName === 'string' ? o.serverName.slice(0, 60) : '',
    installId: typeof o.installId === 'string' && /^[0-9a-f]{0,32}$/.test(o.installId) ? o.installId : '',
    pepper: b64(o.pepper, 32),
    backupKey: b64(o.backupKey, 32),
    smtpPassword: typeof o.smtpPassword === 'string' ? o.smtpPassword.slice(0, 1024) : null,
  };
}

// ------------------------------------------------------------------------------------------
// Making one from this install
// ------------------------------------------------------------------------------------------

/** What a recovery file needs from the secret store (data\secrets). */
export interface RecoverySecretSource {
  read(name: 'pepper.key' | 'backup.key'): Buffer | null;
  readText(name: 'smtp.secret'): string | null;
}

/** "voidswarm-recovery-room-136-2026-09-28.vsrec" (local date). */
export function recoveryFileName(serverName: string, at: number): string {
  const slug = String(serverName ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').toLowerCase().slice(0, 32).replace(/-+$/, '') || 'voidswarm';
  const d = new Date(at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `voidswarm-recovery-${slug}-${date}${VSREC_EXT}`;
}

export interface RecoveryState {
  v: number;
  createdAt: number;
  fileName: string;
  /** key ids when it was made: a replaced key makes the file stale */
  backupKeyId: string | null;
  pepperKeyId: string | null;
  smtp: boolean;
}

export const recoveryStatePath = (dataDir: string): string => path.join(dataDir, RECOVERY_STATE_FILE);

export function readRecoveryState(dataDir: string): RecoveryState | null {
  try {
    const o = JSON.parse(fs.readFileSync(recoveryStatePath(dataDir), 'utf8')) as Record<string, unknown>;
    if (typeof o.createdAt !== 'number') return null;
    const id = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v) ? v : null);
    return {
      v: 1, createdAt: o.createdAt, fileName: typeof o.fileName === 'string' ? o.fileName.slice(0, 120) : '',
      backupKeyId: id(o.backupKeyId), pepperKeyId: id(o.pepperKeyId), smtp: o.smtp === true,
    };
  } catch {
    return null;
  }
}

export function writeRecoveryState(dataDir: string, state: RecoveryState): void {
  const file = recoveryStatePath(dataDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

export interface CreateRecoveryOptions {
  secrets: RecoverySecretSource;
  serverName: string;
  installId: string;
  /** the host's own (16+ characters); omitted = 4 generated words, returned once */
  passphrase?: string | null;
  now?: number;
  crypto?: RecoveryCryptoOptions;
}

export interface CreatedRecovery {
  fileName: string;
  bytes: Buffer;
  /** the generated words (null when the host typed a passphrase): shown once, never stored */
  words: string | null;
  state: RecoveryState;
}

/** Build a recovery file for this install. The caller hands `bytes` to the browser and saves `state`. */
export async function createRecovery(opts: CreateRecoveryOptions): Promise<CreatedRecovery> {
  const now = opts.now ?? Date.now();
  const own = typeof opts.passphrase === 'string' && opts.passphrase.trim() !== '' ? opts.passphrase : null;
  if (own) {
    const why = passphraseProblem(own);
    if (why) throw new RecoveryError('EWEAK', why);
  }
  const words = own ? null : generatePassphrase();
  const pepper = opts.secrets.read('pepper.key');
  const backupKey = opts.secrets.read('backup.key');
  const smtp = opts.secrets.readText('smtp.secret');
  const contents: RecoveryContents = {
    v: RECOVERY_VERSION, createdAt: now, serverName: String(opts.serverName ?? '').slice(0, 60), installId: String(opts.installId ?? ''),
    pepper: pepper ? pepper.toString('base64') : null,
    backupKey: backupKey ? backupKey.toString('base64') : null,
    smtpPassword: smtp || null,
  };
  const bytes = await encryptRecovery(contents, own ?? words!, opts.crypto);
  const fileName = recoveryFileName(contents.serverName, now);
  return {
    fileName, bytes, words,
    state: {
      v: 1, createdAt: now, fileName,
      backupKeyId: backupKey ? keyIdOf(backupKey) : null,
      pepperKeyId: pepper ? keyIdOf(pepper, PEPPER_ID_LABEL) : null,
      smtp: !!smtp,
    },
  };
}

/** The secrets a recovery file brings, as secret-store writes (the caller writes them to data\secrets). */
export function recoverySecrets(c: RecoveryContents): { pepper: Buffer | null; backupKey: Buffer | null; smtpPassword: string | null } {
  return {
    pepper: c.pepper ? Buffer.from(c.pepper, 'base64') : null,
    backupKey: c.backupKey ? Buffer.from(c.backupKey, 'base64') : null,
    smtpPassword: c.smtpPassword,
  };
}

// ------------------------------------------------------------------------------------------
// The banner
// ------------------------------------------------------------------------------------------

export const RECOVERY_YEAR_MS = 365 * 86_400_000;
export const TERM_REMINDER_DAYS = 14;

/** A term end as epoch ms (an ISO date "2026-12-18", a number, or nothing). */
function termEndMs(t: unknown): number | null {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t)) {
    const [y, m, d] = t.slice(0, 10).split('-').map(Number) as [number, number, number];
    const ms = new Date(y, m - 1, d, 23, 59).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * The "No recovery file yet" banner (§6.3): until one exists; again when a key it holds was replaced; a reminder
 * a year after it was made and in the 14 days before a term ends.
 */
export function recoveryBanner(state: RecoveryState | null, opts: {
  now: number; backupKey?: Uint8Array | null; pepper?: Uint8Array | null; termEnd?: string | number | null;
}): Banner | null {
  if (!state) {
    return { code: 'recovery-missing', level: 'warn', text: 'No recovery file yet: create one on the host PC (Server → Backups) and keep it apart from this PC. Without it, backups can\'t be restored on another PC.' };
  }
  const bk = opts.backupKey ? keyIdOf(opts.backupKey) : null;
  const pk = opts.pepper ? keyIdOf(opts.pepper, PEPPER_ID_LABEL) : null;
  if ((bk && state.backupKeyId && bk !== state.backupKeyId) || (pk && state.pepperKeyId && pk !== state.pepperKeyId)) {
    return { code: 'recovery-stale', level: 'warn', text: 'The recovery file is out of date (this PC\'s keys changed): create a new one (Server → Backups).' };
  }
  if (opts.now - state.createdAt > RECOVERY_YEAR_MS) {
    return { code: 'recovery-yearly', level: 'info', text: 'Your recovery file is more than a year old: check you still have it and its passphrase, or create a new one.' };
  }
  const end = termEndMs(opts.termEnd);
  if (end !== null && end >= opts.now && end - opts.now <= TERM_REMINDER_DAYS * 86_400_000) {
    return { code: 'recovery-term', level: 'info', text: 'The term ends soon: check you still have the recovery file and its passphrase before the break.' };
  }
  return null;
}
