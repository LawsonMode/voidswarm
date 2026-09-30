// OWNER: SERVER MODERATION (LAN task B5). The deletion ledger, data\deletions.jsonl (docs/LAN-EDITION-proposal.md
// §6.4): append-only, one JSON object per line, also inside every backup. It records
//   { ts, kind: 'account'|'purge', accountId?, usernameHash?, before?, by }
// plus, for accounts, how the records went (`records`: delete | pseudonymise, `guestEra`, the "Former player #N"
// `label`), so that re-applying it gives the same result as the original deletion, and `hashKey`: the key id of the
// pepper the usernameHash is an HMAC with (erase.ts), so a class roster can't reverse it. It is re-applied
// idempotently after every restore or import (the current ledger plus the backup's), so a deleted student stays
// deleted (T-BAK-3). It holds ids and hashes only, never a name, an address or a line of chat (§8.1).
//
// Lineage (an addition to §6.4): every entry names the DATA it was recorded on (`lineage`, the id in that database's
// mod_meta, which travels inside every backup of it), and a re-apply applies only the entries of the data being
// restored. The ledger on disk keeps the union of every lineage it has seen, so a later restore of either finds its
// own entries. Without it, one install's purges and name scrubs would run on another install's data after a move
// (the new PC's test purge wiping the imported chat log; the undo of a restore from another PC applying that PC's
// purge here; a live student's audit text scrubbed because another install deleted a different "NovaPilot").
// A database that was never stamped (older data, or no deletion recorded on it yet) has the NATIVE lineage of the
// install whose backup key holds it (nativeLineage): the same value whenever and wherever it is computed. Its first
// backup stamps it (backups.ts stampLineage), so a lost and remade backup.key never gives the same data a second one.
// One exception to the scoping: an account deletion recorded on ANY data applies wherever its account is present
// (applicableEntries): account ids are 128 random bits, so the same id is the same student, and a deleted student
// stays deleted even when the lineages disagree (T-BAK-3).
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  accountFootprint, assertEraseSchema, eraseAccount, fallbackFormerLabel, hasherIdOf, nameHasher, nextFormerLabel, noteFormerLabels, purgeChatBefore,
  scrubNamesInText, usernameHash, usernameHashKeyId, type EraseCounts, type EraseOptions, type NameScrub, type PurgeCounts, type RecordsMode,
} from './erase';
import { fsyncBestEffort } from '../durable';

export const LEDGER_FILE = 'deletions.jsonl';
/** A ledger line is ~200 bytes; anything much bigger is not one of ours. */
export const LEDGER_LINE_MAX = 4096;

export type LedgerKind = 'account' | 'purge';

export interface LedgerEntry {
  /** epoch ms of the deletion */
  ts: number;
  kind: LedgerKind;
  /** who did it (an admin principal: 'host:<name>', 'cli', 'self', …; never a student's name) */
  by: string;
  accountId?: string;
  usernameHash?: string;
  /** the key id of the pepper usernameHash was made with (usernameHashKeyId); absent = the unkeyed v1 hash */
  hashKey?: string;
  /** purge: lines with ts < before */
  before?: number;
  records?: RecordsMode;
  guestEra?: boolean;
  label?: string;
  /**
   * The data this deletion was made on (dbLineage of the database, 12 hex digits). Absent on an entry written
   * before entries carried it: a restore then takes it to belong to the data that was live beside its ledger
   * (scopeLedgers), and the worker's ledger.apply to the live data.
   */
  lineage?: string;
}

export const ledgerPath = (dataDir: string): string => path.join(dataDir, LEDGER_FILE);

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;
const LINEAGE_RE = /^[0-9a-f]{12}$/;

// ------------------------------------------------------------------------------------------
// Lineage: which data an entry belongs to
// ------------------------------------------------------------------------------------------

/** The mod_meta key of the database's lineage (an INTEGER, 48 bits; shown and stored in the ledger as 12 hex). */
export const LINEAGE_META_KEY = 'lineage';
const LINEAGE_MAX = 2 ** 48;

export const isLineage = (x: unknown): x is string => typeof x === 'string' && LINEAGE_RE.test(x);

/**
 * The lineage of data native to the install whose backup key this is: what a database that was never stamped
 * counts as (on this install for its own database; in a restore, for the key that opened the backup). Derived, so
 * the same everywhere; it reveals nothing of the key (an HMAC with it).
 */
export function nativeLineage(backupKey: Uint8Array): string {
  const h = createHmac('sha256', backupKey).update('voidswarm/data-lineage/v1').digest().subarray(0, 6).toString('hex');
  return h === '000000000000' ? '000000000001' : h;
}

/** The lineage stamped in this database (mod_meta), or null: none yet, or no mod_meta (an older schema). */
export function dbLineage(db: DatabaseSync): string | null {
  let v: unknown;
  try {
    v = (db.prepare('SELECT v FROM mod_meta WHERE k = ?').get(LINEAGE_META_KEY) as { v?: unknown } | undefined)?.v;
  } catch {
    return null;
  }
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n >= LINEAGE_MAX) return null;
  return n.toString(16).padStart(12, '0');
}

/**
 * The database's lineage, stamping `fallback` first when it has none (or a value that is not one). Needs mod_meta
 * (every v4 database). Returns the lineage now in the database.
 */
export function ensureLineage(db: DatabaseSync, fallback: string): string {
  const cur = dbLineage(db);
  if (cur) return cur;
  if (!isLineage(fallback)) throw new Error('ensureLineage: not a lineage');
  db.prepare('INSERT INTO mod_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(LINEAGE_META_KEY, parseInt(fallback, 16));
  return fallback;
}

/**
 * The lineage a deletion recorded now on `db` carries: the database's own, else `fallback` (nativeLineage of this
 * install's backup key) stamped into it; null when it has none and no fallback was given (the entry then carries
 * none, and the next restore attributes it to the data live beside the ledger, which is `db`).
 */
export function recordingLineage(db: DatabaseSync, fallback?: string | null): string | null {
  const cur = dbLineage(db);
  if (cur) return cur;
  if (!fallback || !isLineage(fallback)) return null;
  try { return ensureLineage(db, fallback); } catch { return null; }
}

/** A checked entry, or null (bad lines are skipped, never fatal). */
export function validateEntry(x: unknown): LedgerEntry | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts < 0) return null;
  if (o.kind !== 'account' && o.kind !== 'purge') return null;
  const by = typeof o.by === 'string' ? o.by.slice(0, 64) : '';
  const e: LedgerEntry = { ts: Math.floor(o.ts), kind: o.kind, by };
  if (o.accountId !== undefined && o.accountId !== null) {
    if (typeof o.accountId !== 'string' || !ID_RE.test(o.accountId)) return null;
    e.accountId = o.accountId;
  }
  if (o.usernameHash !== undefined && o.usernameHash !== null) {
    if (typeof o.usernameHash !== 'string' || !HASH_RE.test(o.usernameHash)) return null;
    e.usernameHash = o.usernameHash;
  }
  if (o.hashKey !== undefined && o.hashKey !== null) {
    if (typeof o.hashKey !== 'string' || !KEY_ID_RE.test(o.hashKey)) return null;
    if (e.usernameHash) e.hashKey = o.hashKey;
  }
  if (o.before !== undefined && o.before !== null) {
    if (typeof o.before !== 'number' || !Number.isFinite(o.before)) return null;
    e.before = Math.floor(o.before);
  }
  if (o.lineage !== undefined && o.lineage !== null) {
    if (!isLineage(o.lineage)) return null;
    e.lineage = o.lineage;
  }
  if (e.kind === 'account') {
    if (!e.accountId) return null;
    if (o.records !== undefined && o.records !== 'delete' && o.records !== 'pseudonymise') return null;
    e.records = o.records === 'pseudonymise' ? 'pseudonymise' : 'delete';
    if (o.guestEra === true) e.guestEra = true;
    if (typeof o.label === 'string' && o.label.trim()) e.label = o.label.trim().slice(0, 40);
  } else if (e.before === undefined) {
    return null;
  }
  return e;
}

/**
 * What makes two entries the same deletion (ts and by don't: the earliest is kept). The same cut on two different
 * data (lineages) is two deletions.
 */
export function entryKey(e: LedgerEntry): string {
  return JSON.stringify([e.kind, e.accountId ?? '', e.usernameHash ?? '', e.hashKey ?? '', e.before ?? '', e.records ?? '', e.guestEra ? 1 : 0, e.label ?? '', e.lineage ?? '']);
}

export interface ParsedLedger {
  entries: LedgerEntry[];
  /** lines skipped: not JSON, too long, or not an entry this version understands */
  bad: number;
  /**
   * The skipped lines that are JSON objects: most likely entries of a NEWER version of Voidswarm (another kind, or a
   * value this version refuses). They are never applied here, but they are kept whenever the ledger is rewritten
   * (writeLedger `keep`), so going back to the newer version still has them.
   */
  unknown: string[];
}

/** The line an entry was read from (so a rewrite keeps fields a newer version added). */
const rawLines = new WeakMap<LedgerEntry, string>();

export function parseLedger(text: string): ParsedLedger {
  const entries: LedgerEntry[] = [];
  const unknown: string[] = [];
  let bad = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > LEDGER_LINE_MAX) { bad++; continue; }
    let v: unknown;
    try { v = JSON.parse(line); } catch { bad++; continue; } // a torn fragment: its deletion never ran (recorded first)
    const e = validateEntry(v);
    if (e) { rawLines.set(e, line); entries.push(e); continue; }
    bad++;
    if (v && typeof v === 'object' && !Array.isArray(v)) unknown.push(line);
  }
  return { entries, bad, unknown };
}

/** The union of the unknown lines of several ledgers (exact text; first seen first). */
export function mergeUnknownLines(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) for (const l of list) if (!seen.has(l)) { seen.add(l); out.push(l); }
  return out;
}

/** The ledger file's entries (none when it doesn't exist). */
export function readLedger(file: string): ParsedLedger {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { entries: [], bad: 0, unknown: [] };
    throw e;
  }
  return parseLedger(text);
}

/**
 * Append one entry (fsynced before it returns: a deletion is recorded before anything is deleted). A torn last line
 * (a power cut mid-append) is closed with a newline first, so the new entry never joins the fragment.
 */
export function appendLedger(file: string, entry: LedgerEntry): LedgerEntry {
  const e = validateEntry(entry);
  if (!e) throw new Error('appendLedger: not a valid ledger entry');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    fs.writeSync(fd, `${lead}${JSON.stringify(e)}\n`);
    fsyncBestEffort(fd);
  } finally {
    fs.closeSync(fd);
  }
  return e;
}

/** The union of several ledgers, oldest first, one entry per deletion (entryKey). */
export function mergeLedgers(...lists: readonly (readonly LedgerEntry[])[]): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  for (const list of lists) {
    for (const e of list) {
      const k = entryKey(e);
      const cur = byKey.get(k);
      if (!cur || e.ts < cur.ts) byKey.set(k, e);
    }
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}

/** `e` with `lineage` (the line it was read from, if any, keeps its other fields: a newer version's too). */
export function withLineage(e: LedgerEntry, lineage: string): LedgerEntry {
  if (e.lineage === lineage) return e;
  const out: LedgerEntry = { ...e, lineage };
  const raw = rawLines.get(e);
  if (raw) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      rawLines.set(out, JSON.stringify({ ...o, lineage }));
    } catch { /* written from the fields */ }
  }
  return out;
}

/**
 * A restore's two ledgers as one, every entry with the lineage of the data it was recorded on. An entry that
 * carries none (LedgerEntry.lineage) was recorded on the data live beside its ledger since that ledger was last
 * scoped: every restore scopes and saves the ledger, so the current ledger's go to the current data, the backup's
 * to the backup's. (The same unstamped cut in both, on two different data, is two deletions: each goes to its own.)
 * The union, oldest first; the restore applies only the restored data's entries (entriesOf) and keeps the rest.
 */
export function scopeLedgers(o: {
  current: readonly LedgerEntry[]; currentLineage: string; backup: readonly LedgerEntry[]; backupLineage: string;
}): LedgerEntry[] {
  const backup = o.backup.map((e) => (e.lineage ? e : withLineage(e, o.backupLineage)));
  const current = o.current.map((e) => (e.lineage ? e : withLineage(e, o.currentLineage)));
  return mergeLedgers(current, backup);
}

/** The entries of one data lineage. */
export const entriesOf = (entries: readonly LedgerEntry[], lineage: string): LedgerEntry[] => entries.filter((e) => e.lineage === lineage);

/**
 * What a re-apply on `db` (whose lineage is `lineage`) runs: its own data's entries (and, with `unscoped`, those that
 * carry no lineage: the worker's ledger.apply, beside the live data), plus every OTHER data's account deletion whose
 * account is present in `db` (accountFootprint). An account id is 128 random bits, so the same id is the same
 * student: the deletion always holds, whichever data it was recorded on (T-BAK-3). Lineages alone can't promise that:
 * the same data gets a second one when its install's backup.key is lost and made again before the database was ever
 * stamped (the old key's recovery file then restores it as "another copy's"). Another data's purges, and the name
 * scrub of an account not in `db` (a different student may have the same name here), stay out.
 */
export function applicableEntries(db: DatabaseSync, entries: readonly LedgerEntry[], lineage: string | null, o: { unscoped?: boolean } = {}): {
  entries: LedgerEntry[]; own: number; crossData: number; otherData: number;
} {
  const out: LedgerEntry[] = [];
  let own = 0;
  let crossData = 0;
  const present = new Map<string, boolean>();
  for (const e of entries) {
    if ((lineage !== null && e.lineage === lineage) || (o.unscoped === true && !e.lineage)) { out.push(e); own++; continue; }
    if (e.kind !== 'account' || !e.accountId) continue;
    let p = present.get(e.accountId);
    if (p === undefined) { p = accountFootprint(db, e.accountId); present.set(e.accountId, p); }
    if (p) { out.push(e); crossData++; }
  }
  return { entries: out, own, crossData, otherData: entries.length - out.length };
}

/**
 * appendLedger for a deletion made on `db`: the entry carries the database's lineage (recordingLineage: `fallback`,
 * nativeLineage of this install's backup key, is stamped first when the database has none). Every live deletion
 * records through this (deleteAccountRecorded, purgeRecorded, writes.ts purgeChat).
 */
export function appendLedgerFor(db: DatabaseSync, file: string, entry: LedgerEntry, opts: { lineage?: string | null } = {}): LedgerEntry {
  const lineage = recordingLineage(db, opts.lineage);
  const { lineage: _given, ...rest } = entry;
  return appendLedger(file, lineage ? { ...rest, lineage } : rest);
}

/**
 * Replace the ledger file atomically with `entries` (used after a merge: a superset of what was there), each as the
 * line it was read from when there is one (a newer version's extra fields survive), then the `keep` lines
 * (ParsedLedger.unknown of the ledgers merged: never dropped).
 */
export function writeLedger(file: string, entries: readonly LedgerEntry[], opts: { keep?: readonly string[] } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = entries.map((e) => rawLines.get(e) ?? JSON.stringify(e));
  const have = new Set(lines);
  for (const l of opts.keep ?? []) {
    const line = String(l).trim();
    if (line && line.length <= LEDGER_LINE_MAX && !/[\r\n]/.test(line) && !have.has(line)) { have.add(line); lines.push(line); }
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, lines.map((l) => `${l}\n`).join(''));
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
}

export interface ApplyLedgerResult {
  entries: number;
  /** entries that changed something (0 on a second run: idempotent) */
  changed: number;
  /** account entries whose hashKey matched none of the peppers given: only their account-id steps ran */
  unmatchedHashKeys: number;
  accounts: EraseCounts;
  purges: PurgeCounts;
}

export interface ApplyLedgerOptions extends EraseOptions {
  /** the peppers the entries' usernameHash may have been made with (this install's; a recovery file's) */
  peppers?: readonly (Uint8Array | null | undefined)[];
}

/**
 * Re-apply `entries` to a (v4) database. Accounts are erased as they were (delete / pseudonymise, guest era, bounded
 * by the entry's time), oldest first; purges delete again whatever of that period is back. Afterwards the "Former
 * player #N" counter is at least every label re-applied (a restore brings back an older counter). Idempotent.
 *
 * Every restore runs this over the whole ledger (a year: ~150 accounts and ~365 daily purges), so the work is shaped
 * to give the same tables as applying the entries one by one, oldest first, without walking every table once per
 * entry (ledger.test.ts checks this on random ledgers):
 *  - an account nothing references any more (accountFootprint) skips the id-keyed steps (all no-ops then);
 *  - the username scrub of audit and report text runs once for all the accounts (scrubNamesInText; it only reads
 *    and writes text, which nothing else touches);
 *  - purges are collapsed, one per cut: the widest global one, and any one account's that reaches further (a purge
 *    of "lines before X" contains every purge of an earlier X). They run at the end, except where an account step
 *    depends on them: before a pseudonymise or a guest era, that account's earlier purge runs, and before a guest
 *    era the earlier global one too (see the loop). Every other account step commutes with a purge.
 * `changed` counts the entries that changed something (a collapsed purge counts once).
 */
export async function applyLedger(db: DatabaseSync, entries: readonly LedgerEntry[], opts: ApplyLedgerOptions = {}): Promise<ApplyLedgerResult> {
  const out: ApplyLedgerResult = {
    entries: entries.length, changed: 0, unmatchedHashKeys: 0,
    accounts: { accounts: 0, chatDeleted: 0, chatPseudonymised: 0, reportsDeleted: 0, reportsUpdated: 0, reportCopies: 0, auditRows: 0, conductRows: 0, bans: 0 },
    purges: { chat: 0, conductRows: 0, reportsUpdated: 0, reportCopies: 0 },
  };
  if (!entries.length) return out;
  assertEraseSchema(db);
  const peppers = new Map<string, Uint8Array>();
  for (const p of opts.peppers ?? []) if (p && p.length) peppers.set(usernameHashKeyId(p), p);
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const scrubs: NameScrub[] = [];
  const scrubOwner = new Map<NameScrub, LedgerEntry>();
  const changedEntries = new Set<LedgerEntry>();
  const eraseOpts: EraseOptions = { ...opts, deferScrub: (s) => { scrubs.push(s); } };

  // The purges not run yet (collapsed: the widest global cut, and per account the widest cut), and what already ran.
  let pendingGlobal = -Infinity;
  let doneGlobal = -Infinity;
  const pendingAccount = new Map<string, number>();
  const runPurge = async (p: { before: number; accountId: string | null }): Promise<void> => {
    const c = await purgeChatBefore(db, p, opts);
    let any = false;
    for (const k of Object.keys(c) as (keyof PurgeCounts)[]) { out.purges[k] += c[k]; if (c[k]) any = true; }
    if (any) out.changed++;
  };
  /**
   * Run the pending global cut now, when it would still remove a chat line. (With none left before the cut, running
   * it later removes the same report copies and counters, which no account step reads: it stays pending.)
   */
  const flushGlobal = async (): Promise<void> => {
    if (!(pendingGlobal > doneGlobal)) return;
    if (!db.prepare('SELECT 1 FROM chat_log WHERE ts < ? LIMIT 1').get(pendingGlobal)) return;
    await runPurge({ before: pendingGlobal, accountId: null });
    doneGlobal = pendingGlobal;
  };
  /** Run one account's pending cut now. */
  const flushAccount = async (accountId: string): Promise<void> => {
    const cut = pendingAccount.get(accountId);
    if (cut === undefined) return;
    pendingAccount.delete(accountId);
    if (cut > doneGlobal) await runPurge({ before: cut, accountId });
  };

  for (const e of sorted) {
    if (e.kind === 'purge' && e.before !== undefined) {
      const cut = effectiveCut({ ts: e.ts, before: e.before }); // never the lines written after the purge
      if (e.accountId) pendingAccount.set(e.accountId, Math.max(pendingAccount.get(e.accountId) ?? -Infinity, cut));
      else pendingGlobal = Math.max(pendingGlobal, cut);
      continue;
    }
    if (e.kind !== 'account' || !e.accountId) continue;
    let usernameHash: string | null = e.usernameHash ?? null;
    let pepper: Uint8Array | null = null;
    if (usernameHash && e.hashKey) {
      pepper = peppers.get(e.hashKey) ?? null;
      if (!pepper) { usernameHash = null; out.unmatchedHashKeys++; }
    }
    const spec = { accountId: e.accountId, usernameHash, pepper, records: e.records, guestEra: e.guestEra, label: e.label, at: e.ts };
    const before = scrubs.length;
    if (!accountFootprint(db, e.accountId)) {
      // Nothing left under this id: only the text scrub (and the label counter) can still matter.
      if (usernameHash && /^[0-9a-f]{64}$/.test(usernameHash)) {
        const label = e.label && e.label.trim() ? e.label.trim().slice(0, 40) : fallbackFormerLabel(e.accountId);
        scrubs.push({ hash: usernameHash, hasherId: hasherIdOf(pepper), hasher: nameHasher(pepper), label, at: e.ts });
      }
      if (e.label) noteFormerLabels(db, [e.label]);
    } else {
      // The earlier purges this step depends on run first, as they did live:
      //  - pseudonymise unlinks the lines (account_id NULL) and their report copies, so this account's own purge
      //    would match nothing afterwards (the purged lines would come back as "Former player #N");
      //  - the guest era reads the addresses on the account's lines and the guest lines themselves, which an
      //    earlier purge (global or this account's) had already removed.
      // Every other order gives the same rows: a purge only removes rows, and what it removes the account step either
      // removes too (a deletion's own lines and copies) or never looks at (another account's, the text, the audit).
      if (e.records === 'pseudonymise' || e.guestEra) await flushAccount(e.accountId);
      if (e.guestEra) await flushGlobal();
      // eraseAccount keeps "Former player #N" (mod_meta.former_seq) at or above the entry's label.
      const c = await eraseAccount(db, spec, eraseOpts);
      for (const k of Object.keys(c) as (keyof EraseCounts)[]) { out.accounts[k] += c[k]; if (c[k]) changedEntries.add(e); }
    }
    for (let i = before; i < scrubs.length; i++) scrubOwner.set(scrubs[i]!, e);
  }

  // The text scrub, once for everyone; an entry whose name was found in some text counts as changed.
  if (scrubs.length) {
    const r = await scrubNamesInText(db, scrubs, opts);
    out.accounts.auditRows += r.auditRows;
    out.accounts.reportsUpdated += r.reportsUpdated;
    for (const s of r.hits.keys()) { const e = scrubOwner.get(s); if (e) changedEntries.add(e); }
  }
  out.changed += changedEntries.size;

  // The purges still pending: the widest global cut, then any account's that reaches further.
  if (pendingGlobal > doneGlobal) {
    await runPurge({ before: pendingGlobal, accountId: null });
    doneGlobal = pendingGlobal;
  }
  for (const accountId of [...pendingAccount.keys()]) await flushAccount(accountId);
  return out;
}

// ------------------------------------------------------------------------------------------
// The live deletions (B23 accounts/delete, B8b purges): the ledger line first, then the same steps a re-apply runs
// ------------------------------------------------------------------------------------------

export interface AccountDeletion {
  accountId: string;
  /** the account's username: only hashed (usernameHash with the pepper), never stored */
  username: string;
  records?: RecordsMode;
  guestEra?: boolean;
  /** the admin principal ('host:<name>', 'cli', 'self', …) */
  by: string;
  /** epoch ms of the deletion (default now) */
  ts?: number;
  /** "Former player #N" (default: nextFormerLabel(db), which takes the next number) */
  label?: string | null;
}

export interface RecordedOptions extends EraseOptions {
  /** data\secrets\pepper.key: the ledger's usernameHash is an HMAC with it (hashKey names it); none = the v1 hash */
  pepper?: Uint8Array | null;
  /**
   * nativeLineage(this install's backup key): stamped into the database first when it has no lineage yet, so the
   * entry names its data (appendLedgerFor). Without it an unstamped database's entry carries none.
   */
  lineage?: string | null;
}

/**
 * Delete (or pseudonymise) an account as the ledger will re-apply it: the entry is appended and fsynced FIRST (a crash
 * mid-delete is finished by the next re-apply), then eraseAccount runs with exactly the entry's values. Idempotent.
 */
export async function deleteAccountRecorded(
  db: DatabaseSync, ledgerFile: string, d: AccountDeletion, opts: RecordedOptions = {},
): Promise<{ entry: LedgerEntry; counts: EraseCounts }> {
  if (!d.accountId) throw new Error('deleteAccountRecorded: accountId is required');
  const pepper = opts.pepper && opts.pepper.length ? opts.pepper : null;
  const ts = Math.floor(d.ts ?? Date.now());
  const label = d.label && d.label.trim() ? d.label.trim().slice(0, 40) : nextFormerLabel(db);
  const entry = appendLedgerFor(db, ledgerFile, {
    ts, kind: 'account', by: d.by, accountId: d.accountId,
    ...(d.username ? { usernameHash: usernameHash(d.username, pepper) } : {}),
    ...(d.username && pepper ? { hashKey: usernameHashKeyId(pepper) } : {}),
    records: d.records === 'pseudonymise' ? 'pseudonymise' : 'delete',
    ...(d.guestEra ? { guestEra: true } : {}),
    label,
  }, { lineage: opts.lineage });
  const counts = await eraseAccount(db, {
    accountId: entry.accountId!, usernameHash: entry.usernameHash ?? null, pepper, records: entry.records, guestEra: entry.guestEra,
    label: entry.label, at: entry.ts,
  }, opts);
  return { entry, counts };
}

export interface PurgeRecord {
  /** lines with ts < before go */
  before: number;
  /** only this account's lines */
  accountId?: string | null;
  by: string;
  ts?: number;
}

/**
 * The cut a purge really made: lines with ts < before, among the lines that existed when it ran (ts ≤ its time).
 * "Purge everything before Friday" chosen on a Tuesday removes only what was there on Tuesday, so a re-apply after a
 * restore must never take the lines written since.
 */
export const effectiveCut = (e: { ts: number; before: number }): number => Math.min(Math.floor(e.before), Math.floor(e.ts) + 1);

/** A purge as the ledger re-applies it: the entry first (fsynced), then purgeChatBefore. Idempotent. */
export async function purgeRecorded(
  db: DatabaseSync, ledgerFile: string, p: PurgeRecord, opts: EraseOptions & { lineage?: string | null } = {},
): Promise<{ entry: LedgerEntry; counts: PurgeCounts }> {
  const ts = Math.floor(p.ts ?? Date.now());
  const entry = appendLedgerFor(db, ledgerFile, {
    ts, kind: 'purge', by: p.by, before: effectiveCut({ ts, before: p.before }), ...(p.accountId ? { accountId: p.accountId } : {}),
  }, { lineage: opts.lineage });
  const counts = await purgeChatBefore(db, { before: entry.before!, accountId: entry.accountId ?? null }, opts);
  return { entry, counts };
}
