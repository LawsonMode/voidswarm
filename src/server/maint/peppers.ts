// OWNER: SERVER MODERATION (LAN task B5). The peppers a restore replaced (docs/LAN-EDITION-proposal.md §6.2, §6.3,
// §6.4): data\secrets\pepper.previous.json. A restore from another install (or of an older backup of this one) puts
// the pepper that backup's data was made with into data\secrets\pepper.key; the one it replaces is kept here, so:
//  - restoring this PC's own older backups afterwards (the pre-restore safety backup, to undo it) puts the right
//    pepper back without the old recovery file (the backup's manifest names it by pepperIdOf);
//  - the deletion ledger's username hashes made with it still match at every later re-apply (LedgerEntry.hashKey);
//  - a restore interrupted between saving the new pepper and swapping the database in can put the old one back
//    (restoreStage.ts recoverInterruptedRestore, with the swap journal).
// It sits in data\secrets beside the others (the folder's owner-only ACL / 0700 covers it; the file is 0600), never
// in a backup, a log or the IPC bundle. At most PREVIOUS_PEPPERS_MAX, newest first.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { pepperIdOf } from './format';
import { fsyncBestEffort } from '../durable';

export const PREVIOUS_PEPPERS_FILE = 'pepper.previous.json';
export const PREVIOUS_PEPPERS_MAX = 16;
const PEPPER_BYTES = 32;

interface Stored { v: 1; peppers: { id: string; key: string; replacedAt: number }[] }

/** Where the file is: in the secret store's folder (null for an in-memory store: nothing is kept then). */
export const previousPeppersPath = (secretsDir: string | null | undefined): string | null =>
  secretsDir ? path.join(secretsDir, PREVIOUS_PEPPERS_FILE) : null;

function readStored(file: string): Stored {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { v: 1, peppers: [] }; }
  try {
    const o = JSON.parse(raw) as { peppers?: unknown };
    const list = Array.isArray(o.peppers) ? o.peppers : [];
    const peppers: Stored['peppers'] = [];
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const { key, replacedAt } = p as { key?: unknown; replacedAt?: unknown };
      if (typeof key !== 'string') continue;
      const b = Buffer.from(key, 'base64');
      if (b.length !== PEPPER_BYTES) continue;
      peppers.push({ id: pepperIdOf(b), key: b.toString('base64'), replacedAt: typeof replacedAt === 'number' ? replacedAt : 0 });
    }
    return { v: 1, peppers: peppers.slice(0, PREVIOUS_PEPPERS_MAX) };
  } catch {
    return { v: 1, peppers: [] };
  }
}

/** The peppers kept (newest first). Never throws (a damaged file counts as none). */
export function readPreviousPeppers(secretsDir: string | null | undefined): Buffer[] {
  const file = previousPeppersPath(secretsDir);
  return file ? readStored(file).peppers.map((p) => Buffer.from(p.key, 'base64')) : [];
}

/** The kept pepper with this pepperIdOf, or null. */
export function findPreviousPepper(secretsDir: string | null | undefined, id: string | null | undefined): Buffer | null {
  if (!id) return null;
  return readPreviousPeppers(secretsDir).find((p) => pepperIdOf(p) === id) ?? null;
}

/**
 * Keep `pepper` (it is about to be replaced). Written atomically and fsynced before it returns, so the pepper.key
 * write that follows can always be undone. False for an in-memory store (nothing kept). Throws when it can't be saved.
 */
export function rememberPepper(secretsDir: string | null | undefined, pepper: Uint8Array, now = Date.now()): boolean {
  const file = previousPeppersPath(secretsDir);
  if (!file) return false;
  const b = Buffer.from(pepper);
  if (b.length !== PEPPER_BYTES) throw new Error(`a pepper is ${PEPPER_BYTES} bytes`);
  const id = pepperIdOf(b);
  const cur = readStored(file);
  const peppers = [{ id, key: b.toString('base64'), replacedAt: Math.floor(now) }, ...cur.peppers.filter((p) => p.id !== id)].slice(0, PREVIOUS_PEPPERS_MAX);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${PREVIOUS_PEPPERS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify({ v: 1, peppers } satisfies Stored)}\n`);
    fsyncBestEffort(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw e;
  }
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* the folder is 0700 */ } }
  return true;
}
