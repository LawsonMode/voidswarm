// OWNER: SERVER MODERATION (LAN task B5). The data-removal steps the deletion ledger re-applies
// (docs/LAN-EDITION-proposal.md §6.4, §4.13, T-ADM-8, T-ADM-10, T-BAK-3), written once so the live delete / purge
// (B23 / B8b) and the re-apply after a restore or import do exactly the same thing:
//  - eraseAccount: 'delete' removes the account's chat lines (their tags, reviews and wellbeing acks cascade), the
//    reports they filed and the reports about them, report copies of their lines, their conduct counters and account
//    bans, anonymises actor and target audit rows, scrubs the username from audit / report text, then deletes the
//    account (sessions, resets, loot, codes and known devices cascade). A moderator's name on the bans they set, the
//    reports they reviewed and their review / wellbeing marks becomes the label too, and is scrubbed from those rows'
//    reasons and notes. 'pseudonymise' keeps the lines as
//    "Former player #N" with `original` empty and no address, and renames them everywhere instead. `guestEra` does
//    the same to the guest rows (lines, reports, audit targets, guest bans) under the account's name FROM ADDRESSES
//    THIS ACCOUNT USED (§4.13): the addresses on
//    its own lines, reports and audit rows (plus their stored forms, EraseOptions.addressForms), matched through the
//    username hash, so the ledger never needs the name or an address itself.
//    Everything matched by NAME (guest rows, the name in audit / report text, moderator names) is bounded by the
//    deletion time `at` (the ledger entry's ts): a later student who takes the freed username is never touched by a
//    re-apply.
//  - purgeChatBefore: chat lines older than a date (optionally one account's), their tags, reviews, wellbeing acks,
//    the conduct counters of the days entirely before it (counters are per day: a cut in the middle of a day keeps
//    that day's counters, which also count later lines), and the report copies of those lines.
// The username hash is HMAC-SHA256 with the install's pepper (v2; LedgerEntry.hashKey names the pepper by its key id),
// so the plaintext ledger can't be reversed with a class roster. Without a pepper it falls back to the unkeyed v1.
// Chat rows go 250 per statement with a pause between chunks (§5.16), so a running server's connection waits at most
// a few ms for the write lock. Every step is idempotent: running it again changes nothing.
// For the re-apply of a whole ledger (ledger.ts applyLedger, at every restore) the per-name text scrub can be handed
// to the caller (EraseOptions.deferScrub → scrubNamesInText, one walk for all names), and an account nothing
// references any more (accountFootprint) needs no id-keyed step at all.
// Needs a v4 database (the chat_tags / conduct_daily tables) with foreign keys on.
import { createHash, createHmac } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { nameKey } from '../../shared/room/util';
import { keyIdOf } from './format';
import { DAY_MS } from './retention';

export const ERASE_CHUNK = 250;
/** The minimum schema these steps work on (chat_tags, conduct_daily, flag_reviews, reports.recent_ids). */
export const ERASE_MIN_SCHEMA = 4;

const HASH_LABEL_V1 = 'voidswarm-username-v1:';
const HASH_LABEL_V2 = 'voidswarm-username-v2:';
/** The label of LedgerEntry.hashKey (the pepper's key id; not secret). */
export const USERNAME_HASH_KEY_LABEL = 'voidswarm username hash key v1';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The username hash of an already-folded name key (chat_log.name_key, 'g:<key>' counters): HMAC-SHA256 with the
 * pepper (v2), or, with no pepper, the unkeyed v1.
 */
export function nameHasher(pepper?: Uint8Array | null): (key: string) => string {
  let raw: (key: string) => string;
  if (pepper && pepper.length) {
    const k = Buffer.from(pepper);
    raw = (key) => createHmac('sha256', k).update(HASH_LABEL_V2 + key, 'utf8').digest('hex');
  } else raw = (key) => sha256(HASH_LABEL_V1 + key);
  // Memoised: a scrub hashes every username-shaped word of every audit row, and the words repeat a lot.
  const memo = new Map<string, string>();
  return (key) => {
    let h = memo.get(key);
    if (h === undefined) {
      h = raw(key);
      if (memo.size >= HASH_MEMO_MAX) memo.clear();
      memo.set(key, h);
    }
    return h;
  };
}
const HASH_MEMO_MAX = 50_000;
/** Which pepper a hasher uses (the grouping key of a batched scrub): usernameHashKeyId, or 'v1' for none. */
export const hasherIdOf = (pepper?: Uint8Array | null): string => (pepper && pepper.length ? usernameHashKeyId(pepper) : 'v1');
export const nameKeyHash = (key: string, pepper?: Uint8Array | null): string => nameHasher(pepper)(key);
/** The ledger's username hash (§6.4 `usernameHash`): of the name key, so guest callsigns under the name match too. */
export const usernameHash = (username: string, pepper?: Uint8Array | null): string => nameKeyHash(nameKey(username), pepper);
/** LedgerEntry.hashKey: which pepper made an entry's usernameHash (a keyed id of it, never the key). */
export const usernameHashKeyId = (pepper: Uint8Array): string => keyIdOf(pepper, USERNAME_HASH_KEY_LABEL);

/** The conduct_daily day of an epoch-ms time (UTC days). The counters and the purges share this definition. */
export const dayOf = (ts: number): number => Math.floor(ts / DAY_MS);

export const FORMER_PREFIX = 'Former player #';
export const formerLabel = (n: number): string => `${FORMER_PREFIX}${n}`;
const FORMER_RE = /^Former player #(\d{1,9})$/;

/** A stable label for an account when the ledger entry carries none (older entries, hand-made ones). */
export function fallbackFormerLabel(accountId: string): string {
  return formerLabel((parseInt(sha256(`former:${accountId}`).slice(0, 8), 16) % 90_000) + 10_000);
}

/** The next "Former player #N" (mod_meta.former_seq; the live delete takes one and stores it in the ledger). */
export function nextFormerLabel(db: DatabaseSync): string {
  db.prepare("INSERT INTO mod_meta (k, v) VALUES ('former_seq', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1").run();
  const n = Number((db.prepare("SELECT v FROM mod_meta WHERE k = 'former_seq'").get() as { v: number }).v);
  return formerLabel(n);
}

/**
 * Keep mod_meta.former_seq at or above every "Former player #N" in `labels` (after a restore brought back an older
 * counter, the re-applied ledger labels would otherwise be handed out again). Returns the counter.
 */
export function noteFormerLabels(db: DatabaseSync, labels: readonly (string | null | undefined)[]): number {
  let max = 0;
  for (const l of labels) {
    const m = typeof l === 'string' ? FORMER_RE.exec(l.trim()) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  if (max > 0) db.prepare("INSERT INTO mod_meta (k, v) VALUES ('former_seq', ?) ON CONFLICT(k) DO UPDATE SET v = max(v, excluded.v)").run(max);
  const r = db.prepare("SELECT v FROM mod_meta WHERE k = 'former_seq'").get() as { v?: number } | undefined;
  return Number(r?.v ?? 0);
}

// ------------------------------------------------------------------------------------------
// The FTS tidy flag (§5.16: deleted rows' index entries go at the next `optimize` in a quiet window)
// ------------------------------------------------------------------------------------------

/** Note `rows` chat lines removed or rewritten since the last FTS optimize (mod_meta.fts_dirty). */
export function markIndexDirty(db: DatabaseSync, rows: number): void {
  if (!(rows > 0)) return;
  db.prepare("INSERT INTO mod_meta (k, v) VALUES ('fts_dirty', ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v").run(Math.floor(rows));
}
/** Lines removed since the last optimize (0 = nothing pending). */
export function indexDirtyRows(db: DatabaseSync): number {
  try {
    const r = db.prepare("SELECT v FROM mod_meta WHERE k = 'fts_dirty'").get() as { v?: number } | undefined;
    return Number(r?.v ?? 0);
  } catch {
    return 0;
  }
}
export function clearIndexDirty(db: DatabaseSync): void {
  db.prepare("DELETE FROM mod_meta WHERE k = 'fts_dirty'").run();
}

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

export interface EraseOptions {
  /** rows per statement (default 250) */
  chunk?: number;
  /** awaited between chunks (the worker yields to the event loop here) */
  pause?: () => Promise<void>;
  signal?: AbortSignal;
  /**
   * The other stored forms of an address (e.g. the address tag a minimised guest line keeps, §6.4), so the guest-era
   * match still finds lines whose raw address is gone. Default: the address itself only.
   */
  addressForms?: (address: string) => readonly string[];
  /**
   * Hand the username scrub of audit and report TEXT to the caller instead of walking every row here (applyLedger
   * collects them and runs scrubNamesInText once for all its entries). The result is the same.
   */
  deferScrub?: (s: NameScrub) => void;
}

/** One username to scrub from audit and report text (eraseAccount's step, batched by scrubNamesInText). */
export interface NameScrub {
  /** usernameHash(username, pepper) */
  hash: string;
  /** hasherIdOf(pepper) */
  hasherId: string;
  hasher: (key: string) => string;
  label: string;
  /** rows after this time are left alone (null: no bound) */
  at: number | null;
}

const defaultPause = (): Promise<void> => new Promise((r) => setImmediate(r));

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error('The job was cancelled.');
    e.name = 'AbortError';
    throw e;
  }
}

/** Run `stmt` (…, LIMIT ?) RETURNING id until it returns fewer than a chunk. Collects the ids. */
async function inChunks(stmt: StatementSync, args: SQLInputValue[], opts: EraseOptions, ids?: Set<number>): Promise<number> {
  const chunk = Math.max(1, Math.floor(opts.chunk ?? ERASE_CHUNK));
  let total = 0;
  for (;;) {
    aborted(opts.signal);
    const rows = stmt.all(...args, chunk) as { id: number | bigint }[];
    total += rows.length;
    if (ids) for (const r of rows) ids.add(Number(r.id));
    if (rows.length < chunk) return total;
    await (opts.pause ?? defaultPause)();
  }
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export function assertEraseSchema(db: DatabaseSync): void {
  const v = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (v < ERASE_MIN_SCHEMA) throw new Error(`The database is at schema v${v}; deletions need v${ERASE_MIN_SCHEMA} (open it with this version of Voidswarm first).`);
  db.exec('PRAGMA foreign_keys = ON');
}

const USERNAME_TOKEN = /[A-Za-z0-9_-]+/g;

/** Replace every username-shaped word of `text` whose username hash is `hash` by `label` (`hasher`: nameHasher(pepper)). */
export function scrubUsername(text: string, hash: string, label: string, hasher: (key: string) => string = nameHasher(null)): string {
  if (!text) return text;
  return text.replace(USERNAME_TOKEN, (tok) => (tok.length >= 3 && tok.length <= 16 && hasher(nameKey(tok)) === hash ? label : tok));
}

/** Run `fn` over `ids` in chunks (a JSON array per statement), pausing between chunks. Returns the total `fn` gave. */
async function idChunks(ids: readonly number[], opts: EraseOptions, fn: (json: string) => number): Promise<number> {
  const chunk = Math.max(1, Math.floor(opts.chunk ?? ERASE_CHUNK));
  let total = 0;
  for (let i = 0; i < ids.length; i += chunk) {
    aborted(opts.signal);
    total += fn(JSON.stringify(ids.slice(i, i + chunk)));
    if (i + chunk < ids.length) await (opts.pause ?? defaultPause)();
  }
  return total;
}

type Copy = Record<string, unknown>;

function parseArray(json: unknown): unknown[] {
  if (typeof json !== 'string') return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface ReportRow {
  id: number;
  ts: number;
  reporter_name: string; reporter_account_id: string | null; reporter_address: string | null;
  target_name: string; target_account_id: string | null; target_address: string | null;
  reason: string; note: string | null;
  recent_chat_json: string; recent_ids: string;
}

/**
 * Walk every report (500 at a time): `decide` returns 'delete', or the new copies / fields. Returns
 * { deleted, updated, copies } where copies = saved lines removed or rewritten.
 */
async function eachReport(
  db: DatabaseSync, opts: EraseOptions,
  decide: (r: ReportRow) => 'delete' | { copies: (c: Copy) => Copy | null; fields?: Partial<Pick<ReportRow, 'reporter_name' | 'reporter_account_id' | 'target_name' | 'target_account_id' | 'reason' | 'note'>> & { clearReporterAddress?: boolean; clearTargetAddress?: boolean }; dropIds?: Set<number> },
): Promise<{ deleted: number; updated: number; copies: number }> {
  const page = db.prepare(`SELECT id, ts, reporter_name, reporter_account_id, reporter_address, target_name, target_account_id, target_address,
                                  reason, note, recent_chat_json, recent_ids
                             FROM reports WHERE id > ? ORDER BY id LIMIT 500`);
  const del = db.prepare('DELETE FROM reports WHERE id = ?');
  const upd = db.prepare(`UPDATE reports SET reporter_name = ?, reporter_account_id = ?, target_name = ?, target_account_id = ?, reason = ?, note = ?,
                                reporter_address = CASE WHEN ? THEN NULL ELSE reporter_address END,
                                target_address = CASE WHEN ? THEN NULL ELSE target_address END,
                                recent_chat_json = ?, recent_ids = ? WHERE id = ?`);
  let after = 0;
  const out = { deleted: 0, updated: 0, copies: 0 };
  for (;;) {
    aborted(opts.signal);
    const rows = page.all(after) as unknown as ReportRow[];
    if (!rows.length) return out;
    tx(db, () => {
      for (const r of rows) {
        after = Number(r.id);
        const d = decide(r);
        if (d === 'delete') { del.run(r.id); out.deleted++; continue; }
        const before = parseArray(r.recent_chat_json);
        const copies: Copy[] = [];
        let changed = 0;
        for (const c of before) {
          if (!c || typeof c !== 'object' || Array.isArray(c)) { changed++; continue; }
          const next = d.copies(c as Copy);
          if (next !== c) changed++;
          if (next) copies.push(next);
        }
        const oldIds = parseArray(r.recent_ids).filter((x): x is number => typeof x === 'number' && Number.isInteger(x));
        const kept = new Set(copies.map((c) => c.id).filter((x): x is number => typeof x === 'number'));
        const removedIds = new Set(before.map((c) => (c as Copy)?.id).filter((x): x is number => typeof x === 'number' && !kept.has(x)));
        const ids = oldIds.filter((x) => !removedIds.has(x) && !(d.dropIds?.has(x)));
        const f = d.fields ?? {};
        const fieldChange = Object.keys(f).some((k) => k !== 'clearReporterAddress' && k !== 'clearTargetAddress' && (f as Record<string, unknown>)[k] !== (r as unknown as Record<string, unknown>)[k])
          || f.clearReporterAddress || f.clearTargetAddress;
        if (!changed && ids.length === oldIds.length && !fieldChange) continue;
        upd.run(
          f.reporter_name ?? r.reporter_name, f.reporter_account_id !== undefined ? f.reporter_account_id : r.reporter_account_id,
          f.target_name ?? r.target_name, f.target_account_id !== undefined ? f.target_account_id : r.target_account_id,
          f.reason ?? r.reason, f.note !== undefined ? f.note : r.note,
          f.clearReporterAddress ? 1 : 0, f.clearTargetAddress ? 1 : 0,
          JSON.stringify(copies), JSON.stringify(ids), r.id,
        );
        out.updated++;
        out.copies += changed || oldIds.length - ids.length;
      }
    });
    await (opts.pause ?? defaultPause)();
  }
}

// ------------------------------------------------------------------------------------------
// Accounts
// ------------------------------------------------------------------------------------------

export type RecordsMode = 'delete' | 'pseudonymise';

export interface EraseAccountSpec {
  accountId: string;
  /** usernameHash(username, pepper): needed for guestEra and for scrubbing the name from audit / report text */
  usernameHash?: string | null;
  /** the pepper `usernameHash` was made with (LedgerEntry.hashKey names it); none = the unkeyed v1 hash */
  pepper?: Uint8Array | null;
  records?: RecordsMode;
  /** also the guest rows under the account's name from addresses the account used (§4.13 guestEra) */
  guestEra?: boolean;
  /** "Former player #N" (nextFormerLabel); a stable fallback otherwise */
  label?: string | null;
  /**
   * The deletion time (the ledger entry's ts). Rows matched by name (guest rows, audit / report text) newer than it
   * are left alone, so a re-apply never touches a later student who took the freed username. Default: no bound.
   */
  at?: number | null;
}

export interface EraseCounts {
  accounts: number;
  chatDeleted: number;
  chatPseudonymised: number;
  reportsDeleted: number;
  reportsUpdated: number;
  reportCopies: number;
  auditRows: number;
  conductRows: number;
  bans: number;
}

const zeroCounts = (): EraseCounts => ({
  accounts: 0, chatDeleted: 0, chatPseudonymised: 0, reportsDeleted: 0, reportsUpdated: 0, reportCopies: 0, auditRows: 0, conductRows: 0, bans: 0,
});

export const changedAnything = (c: Partial<Record<string, number>>): boolean => Object.values(c).some((n) => (n ?? 0) > 0);

/**
 * The addresses this account used (§4.13 "from addresses this account used"): on its own chat lines, the reports it
 * filed or that are about it, and the audit rows that name it as the target, with their other stored forms
 * (EraseOptions.addressForms). Read BEFORE anything is erased or anonymised.
 */
export function accountAddresses(db: DatabaseSync, accountId: string, forms?: EraseOptions['addressForms']): string[] {
  const set = new Set<string>();
  const add = (a: unknown): void => {
    if (typeof a !== 'string' || !a) return;
    set.add(a);
    try { for (const f of forms?.(a) ?? []) if (typeof f === 'string' && f) set.add(f); } catch { /* a form we can't make */ }
  };
  const q = (sql: string): void => { for (const r of db.prepare(sql).all(accountId) as { a: unknown }[]) add(r.a); };
  q('SELECT DISTINCT address AS a FROM chat_log WHERE account_id = ? AND address IS NOT NULL');
  q('SELECT DISTINCT reporter_address AS a FROM reports WHERE reporter_account_id = ? AND reporter_address IS NOT NULL');
  q('SELECT DISTINCT target_address AS a FROM reports WHERE target_account_id = ? AND target_address IS NOT NULL');
  q('SELECT DISTINCT target_address AS a FROM mod_actions WHERE target_account_id = ? AND target_address IS NOT NULL');
  return [...set];
}

interface GuestEra {
  /** the matched guest lines (ids), and per name key the days they were on */
  ids: number[];
  days: Map<string, Set<number>>;
}

/** The guest lines under the username (by hash) from `addresses`, at or before `at`. */
function guestLines(db: DatabaseSync, hash: string, hasher: (key: string) => string, addresses: readonly string[], at: number | null): GuestEra {
  const out: GuestEra = { ids: [], days: new Map() };
  if (!addresses.length) return out;
  const addrs = JSON.stringify(addresses);
  const bound = at ?? Number.MAX_SAFE_INTEGER;
  const keys = (db.prepare(`SELECT DISTINCT name_key FROM chat_log
                             WHERE account_id IS NULL AND ts <= ? AND address IN (SELECT value FROM json_each(?))`).all(bound, addrs) as { name_key: string }[])
    .map((r) => r.name_key).filter((k) => hasher(k) === hash);
  const rows = db.prepare(`SELECT id, ts FROM chat_log
                            WHERE account_id IS NULL AND name_key = ? AND ts <= ? AND address IN (SELECT value FROM json_each(?)) ORDER BY id`);
  for (const k of keys) {
    const days = new Set<number>();
    for (const r of rows.all(k, bound, addrs) as { id: number | bigint; ts: number }[]) {
      out.ids.push(Number(r.id));
      days.add(dayOf(Number(r.ts)));
    }
    if (days.size) out.days.set(k, days);
  }
  return out;
}

/**
 * What a guest-era deletion would take (B23's count preview): the matched guest lines. Same selection as
 * eraseAccount, so the preview and the deletion agree.
 */
export function guestEraPreview(db: DatabaseSync, spec: Pick<EraseAccountSpec, 'accountId' | 'usernameHash' | 'pepper' | 'at'>, opts: Pick<EraseOptions, 'addressForms'> = {}): { lines: number; addresses: number } {
  const hash = spec.usernameHash && /^[0-9a-f]{64}$/.test(spec.usernameHash) ? spec.usernameHash : null;
  if (!hash) return { lines: 0, addresses: 0 };
  const addresses = accountAddresses(db, spec.accountId, opts.addressForms);
  const at = typeof spec.at === 'number' && Number.isFinite(spec.at) ? Math.floor(spec.at) : null;
  return { lines: guestLines(db, hash, nameHasher(spec.pepper ?? null), addresses, at).ids.length, addresses: addresses.length };
}

/** Remove (or pseudonymise) one account everywhere. Idempotent. See the file header. */
export async function eraseAccount(db: DatabaseSync, spec: EraseAccountSpec, opts: EraseOptions = {}): Promise<EraseCounts> {
  assertEraseSchema(db);
  const id = spec.accountId;
  if (!id) throw new Error('eraseAccount: accountId is required');
  const mode: RecordsMode = spec.records === 'pseudonymise' ? 'pseudonymise' : 'delete';
  const givenLabel = spec.label && spec.label.trim() ? spec.label.trim().slice(0, 40) : null;
  const label = givenLabel ?? fallbackFormerLabel(id);
  const labelKey = nameKey(label);
  const hash = spec.usernameHash && /^[0-9a-f]{64}$/.test(spec.usernameHash) ? spec.usernameHash : null;
  const hasher = nameHasher(spec.pepper ?? null);
  const at = typeof spec.at === 'number' && Number.isFinite(spec.at) ? Math.floor(spec.at) : null;
  const inTime = (ts: unknown): boolean => at === null || (typeof ts === 'number' && ts <= at);
  const nameMatches = (s: unknown): boolean => !!hash && typeof s === 'string' && s.length > 0 && hasher(nameKey(s)) === hash;
  // The guest era: only from the addresses this account used, and only up to the deletion.
  const addresses = spec.guestEra && hash ? accountAddresses(db, id, opts.addressForms) : [];
  const addrSet = new Set(addresses);
  const guest: GuestEra = spec.guestEra && hash ? guestLines(db, hash, hasher, addresses, at) : { ids: [], days: new Map() };
  const guestOn = addrSet.size > 0;
  const fromTheirAddress = (a: unknown): boolean => typeof a === 'string' && addrSet.has(a);
  const c = zeroCounts();
  const deletedIds = new Set<number>();
  const guestIds = new Set(guest.ids);
  const defer = opts.deferScrub ?? null;
  const nameScrub: NameScrub | null = hash ? { hash, hasherId: hasherIdOf(spec.pepper ?? null), hasher, label, at } : null;
  if (nameScrub && defer) defer(nameScrub);

  // 1. Chat lines.
  if (mode === 'delete') {
    c.chatDeleted += await inChunks(
      db.prepare('DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE account_id = ? ORDER BY id LIMIT ?) RETURNING id'), [id], opts, deletedIds);
    const g = db.prepare('DELETE FROM chat_log WHERE id IN (SELECT value FROM json_each(?)) AND account_id IS NULL RETURNING id');
    c.chatDeleted += await idChunks(guest.ids, opts, (json) => {
      const rows = g.all(json) as { id: number | bigint }[];
      for (const row of rows) deletedIds.add(Number(row.id));
      return rows.length;
    });
  } else {
    // A pseudonymised line keeps what the others were shown; the original, the address and the link go.
    c.chatPseudonymised += await inChunks(db.prepare(
      `UPDATE chat_log SET name = ?, name_key = ?, account_id = NULL, address = NULL, original = ''
        WHERE id IN (SELECT id FROM chat_log WHERE account_id = ? ORDER BY id LIMIT ?) RETURNING id`), [label, labelKey, id], opts);
    const g = db.prepare(`UPDATE chat_log SET name = ?, name_key = ?, address = NULL, original = ''
                           WHERE id IN (SELECT value FROM json_each(?)) AND account_id IS NULL AND name_key <> ? RETURNING id`);
    c.chatPseudonymised += await idChunks(guest.ids, opts, (json) => (g.all(label, labelKey, json, labelKey) as unknown[]).length);
    db.prepare('UPDATE chat_tags SET account_id = NULL WHERE account_id = ?').run(id);
  }

  // 2. Reports: filed by them / about them, the saved copies of their lines, their name in the text.
  const r = await eachReport(db, opts, (row) => {
    const guestRow = guestOn && inTime(row.ts);
    const byThem = row.reporter_account_id === id
      || (guestRow && row.reporter_account_id == null && nameMatches(row.reporter_name) && fromTheirAddress(row.reporter_address));
    const aboutThem = row.target_account_id === id
      || (guestRow && row.target_account_id == null && nameMatches(row.target_name) && fromTheirAddress(row.target_address));
    if (mode === 'delete' && (byThem || aboutThem)) return 'delete';
    const theirs = (cp: Copy): boolean => cp.accountId === id
      || (typeof cp.id === 'number' && (deletedIds.has(cp.id) || (guestIds.has(cp.id) && cp.accountId == null)));
    return {
      dropIds: deletedIds,
      copies: (cp) => {
        if (!theirs(cp)) return cp;
        if (mode === 'delete') return null;
        return cp.name === label && cp.accountId == null ? cp : { ...cp, name: label, accountId: null };
      },
      fields: {
        ...(byThem ? { reporter_name: label, reporter_account_id: null, clearReporterAddress: true } : {}),
        ...(aboutThem ? { target_name: label, target_account_id: null, clearTargetAddress: true } : {}),
        ...(hash && !defer && inTime(row.ts)
          ? { reason: scrubUsername(row.reason, hash, label, hasher), note: row.note == null ? null : scrubUsername(row.note, hash, label, hasher) }
          : {}),
      },
    };
  });
  c.reportsDeleted += r.deleted;
  c.reportsUpdated += r.updated;
  c.reportCopies += r.copies;

  // 3. The audit trail: anonymised, never deleted (it records what moderators did).
  c.auditRows += Number(db.prepare("UPDATE mod_actions SET actor_account_id = 'deleted', actor_name = ? WHERE actor_account_id = ?").run(label, id).changes);
  c.auditRows += Number(db.prepare('UPDATE mod_actions SET target_account_id = NULL, target_name = ?, target_address = NULL WHERE target_account_id = ?').run(label, id).changes);
  // The guest era's audit targets: under the name, from the addresses this account used (the address index).
  if (guestOn) {
    // (The account-id test is made here, not in SQL, where it would steer the planner onto the target index.)
    const rows = db.prepare(`SELECT id, target_name, target_account_id FROM mod_actions
                              WHERE target_address IN (SELECT value FROM json_each(?)) AND ts <= ?`)
      .all(JSON.stringify(addresses), at ?? Number.MAX_SAFE_INTEGER) as { id: number; target_name: string | null; target_account_id: string | null }[];
    const setTarget = db.prepare('UPDATE mod_actions SET target_name = ?, target_address = NULL WHERE id = ?');
    const hits = rows.filter((a) => a.target_account_id == null && nameMatches(a.target_name)).sort((x, y) => Number(x.id) - Number(y.id));
    for (let i = 0; i < hits.length; i += 1000) {
      aborted(opts.signal);
      tx(db, () => { for (const a of hits.slice(i, i + 1000)) { setTarget.run(label, a.id); c.auditRows++; } });
      if (i + 1000 < hits.length) await (opts.pause ?? defaultPause)();
    }
  }
  // The name in audit reasons (a deferred scrub leaves that to scrubNamesInText, one walk for every name).
  if (hash && !defer) {
    const page = db.prepare('SELECT id, reason FROM mod_actions WHERE id > ? AND ts <= ? ORDER BY id LIMIT 1000');
    const setReason = db.prepare('UPDATE mod_actions SET reason = ? WHERE id = ?');
    let after = 0;
    for (;;) {
      aborted(opts.signal);
      const rows = page.all(after, at ?? Number.MAX_SAFE_INTEGER) as { id: number; reason: string }[];
      if (!rows.length) break;
      tx(db, () => {
        for (const a of rows) {
          after = Number(a.id);
          const reason = scrubUsername(a.reason ?? '', hash, label, hasher);
          if (reason !== a.reason) { setReason.run(reason, a.id); c.auditRows++; }
        }
      });
      await (opts.pause ?? defaultPause)();
    }
  }
  // The moderator side (a deleted moderator's name on the bans they set, the reports they reviewed, their review
  // marks) and the name in those rows' notes. A deferred scrub leaves it to scrubNamesInText, which does the same.
  if (nameScrub && !defer) c.auditRows += await scrubModeratorRecords(db, scrubIndex([nameScrub]), opts, new Map());

  // 4. Conduct counters (the guest era's: the days its matched lines were on), bans (the account's, and the guest
  // era's: under the name, from the addresses this account used, up to the deletion), the account (sessions, resets,
  // loot, codes, devices, admins cascade), and the "Former player #N" counter never behind a used label.
  tx(db, () => {
    c.conductRows += Number(db.prepare('DELETE FROM conduct_daily WHERE account_key = ?').run(id).changes);
    const gk = db.prepare('DELETE FROM conduct_daily WHERE account_key = ? AND day IN (SELECT value FROM json_each(?))');
    for (const [k, days] of guest.days) c.conductRows += Number(gk.run(`g:${k}`, JSON.stringify([...days])).changes);
    c.bans += Number(db.prepare("DELETE FROM bans WHERE scope = 'account' AND account_id = ?").run(id).changes);
    if (guestOn) {
      const guestBans = db.prepare(`SELECT id, username FROM bans WHERE scope = 'guest' AND created_at <= ?
                                      AND address_prefix IN (SELECT value FROM json_each(?))`).all(at ?? Number.MAX_SAFE_INTEGER, JSON.stringify(addresses)) as { id: number; username: unknown }[];
      const del = db.prepare('DELETE FROM bans WHERE id = ?');
      for (const b of guestBans) if (nameMatches(b.username)) c.bans += Number(del.run(b.id).changes);
    }
    if (c.bans) db.prepare("UPDATE mod_meta SET v = v + 1 WHERE k = 'rev'").run();
    c.accounts += Number(db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes);
    markIndexDirty(db, c.chatDeleted + c.chatPseudonymised);
    if (givenLabel) noteFormerLabels(db, [givenLabel]);
  });
  return c;
}

/**
 * Does anything still reference this account id (its row, lines, tags, counters, account bans, reports by or about
 * it, report copies naming it, audit rows naming it)? When nothing does, every id-keyed step of eraseAccount is a
 * no-op, and so is its guest era (whose addresses come only from those rows): a re-apply can skip it, leaving only the
 * username scrub of text (which applyLedger batches). Cheap: indexed lookups and one scan of the reports.
 */
export function accountFootprint(db: DatabaseSync, accountId: string): boolean {
  const any = (sql: string, ...args: SQLInputValue[]): boolean => !!db.prepare(sql).get(...args);
  return any('SELECT 1 FROM accounts WHERE id = ?', accountId)
    || any('SELECT 1 FROM chat_log WHERE account_id = ? LIMIT 1', accountId)
    || any('SELECT 1 FROM chat_tags WHERE account_id = ? LIMIT 1', accountId)
    || any('SELECT 1 FROM conduct_daily WHERE account_key = ? LIMIT 1', accountId)
    || any("SELECT 1 FROM bans WHERE scope = 'account' AND account_id = ? LIMIT 1", accountId)
    || any('SELECT 1 FROM reports WHERE reporter_account_id = ? OR target_account_id = ? LIMIT 1', accountId, accountId)
    // A copy naming the account (as a JSON string anywhere: a false match only means the full walk runs).
    || any('SELECT 1 FROM reports WHERE instr(recent_chat_json, ?) > 0 LIMIT 1', JSON.stringify(accountId))
    || any('SELECT 1 FROM mod_actions WHERE actor_account_id = ? OR target_account_id = ? LIMIT 1', accountId, accountId);
}

/**
 * The username scrub of eraseAccount (audit reasons; report reasons and notes), for many names in ONE walk of each
 * table: every username-shaped word is hashed once per pepper and looked up. A word matching several scrubs (a name
 * reused by successive students) takes the label of the earliest deletion at or after the row's time, as the
 * one-by-one scrubs would. Rows after every scrub's time are never read. Idempotent.
 */
export async function scrubNamesInText(
  db: DatabaseSync, scrubs: readonly NameScrub[], opts: EraseOptions = {},
): Promise<{ auditRows: number; reportsUpdated: number; hits: Map<NameScrub, number> }> {
  /** `hits`: words replaced per scrub (the scrubs that found nothing are absent) */
  const out = { auditRows: 0, reportsUpdated: 0, hits: new Map<NameScrub, number>() };
  if (!scrubs.length) return out;
  const index = scrubIndex(scrubs);
  const scrub = (text: string, ts: number): string => scrubWith(index, text, ts, out.hits);
  const bound = index.maxAt;

  const aPage = db.prepare('SELECT id, ts, reason FROM mod_actions WHERE id > ? AND ts <= ? ORDER BY id LIMIT 1000');
  const setReason = db.prepare('UPDATE mod_actions SET reason = ? WHERE id = ?');
  let after = 0;
  for (;;) {
    aborted(opts.signal);
    const rows = aPage.all(after, bound) as { id: number; ts: number; reason: string | null }[];
    if (!rows.length) break;
    tx(db, () => {
      for (const a of rows) {
        after = Number(a.id);
        const reason = scrub(a.reason ?? '', Number(a.ts));
        if (reason !== (a.reason ?? '')) { setReason.run(reason, a.id); out.auditRows++; }
      }
    });
    await (opts.pause ?? defaultPause)();
  }

  const rPage = db.prepare('SELECT id, ts, reason, note FROM reports WHERE id > ? AND ts <= ? ORDER BY id LIMIT 500');
  const setText = db.prepare('UPDATE reports SET reason = ?, note = ? WHERE id = ?');
  after = 0;
  for (;;) {
    aborted(opts.signal);
    const rows = rPage.all(after, bound) as { id: number; ts: number; reason: string | null; note: string | null }[];
    if (!rows.length) break;
    tx(db, () => {
      for (const r of rows) {
        after = Number(r.id);
        const reason = scrub(r.reason ?? '', Number(r.ts));
        const note = r.note == null ? null : scrub(r.note, Number(r.ts));
        if (reason !== (r.reason ?? '') || note !== r.note) { setText.run(reason, note, r.id); out.reportsUpdated++; }
      }
    });
    await (opts.pause ?? defaultPause)();
  }
  out.auditRows += await scrubModeratorRecords(db, index, opts, out.hits);
  return out;
}

/** The scrubs by name: every scrub whose hash a name key has, earliest bound first (null = no bound, last). */
interface ScrubIndex {
  lookup(key: string): NameScrub[];
  /** the latest bound (rows after it are never read) */
  maxAt: number;
}

function scrubIndex(scrubs: readonly NameScrub[]): ScrubIndex {
  // hasherId → hash → the scrubs of that name.
  const byHasher = new Map<string, { hasher: (key: string) => string; byHash: Map<string, NameScrub[]> }>();
  let maxAt = -Infinity;
  for (const s of scrubs) {
    let g = byHasher.get(s.hasherId);
    if (!g) { g = { hasher: s.hasher, byHash: new Map() }; byHasher.set(s.hasherId, g); }
    const list = g.byHash.get(s.hash) ?? [];
    list.push(s);
    g.byHash.set(s.hash, list);
    maxAt = Math.max(maxAt, s.at ?? Number.MAX_SAFE_INTEGER);
  }
  const byAt = (a: NameScrub, b: NameScrub): number => (a.at ?? Infinity) - (b.at ?? Infinity);
  for (const g of byHasher.values()) for (const list of g.byHash.values()) list.sort(byAt);
  return {
    lookup(key) {
      const found: NameScrub[] = [];
      for (const g of byHasher.values()) { const list = g.byHash.get(g.hasher(key)); if (list) found.push(...list); }
      return byHasher.size > 1 ? found.sort(byAt) : found;
    },
    maxAt: Number.isFinite(maxAt) ? maxAt : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Replace every username-shaped word of `text` that a scrub matches: a word matching several (a name reused by
 * successive students) takes the label of the earliest deletion at or after the row's time `ts`.
 */
function scrubWith(index: ScrubIndex, text: string, ts: number, hits: Map<NameScrub, number>): string {
  if (!text) return text;
  return text.replace(USERNAME_TOKEN, (tok) => {
    if (tok.length < 3 || tok.length > 16) return tok;
    const best = index.lookup(nameKey(tok)).find((s) => s.at === null || ts <= s.at);
    if (!best) return tok;
    hits.set(best, (hits.get(best) ?? 0) + 1);
    return best.label;
  });
}

/**
 * The moderator columns that hold a username (§4.13 "audit rows where they are … the actor get anonymised"; the
 * moderation service writes the acting account's name there), each with the time that bounds a deletion.
 */
const MODERATOR_NAME_COLUMNS = [
  { table: 'bans', col: 'by', time: 'created_at' },
  { table: 'reports', col: 'reviewed_by', time: 'reviewed_at' },
  { table: 'flag_reviews', col: 'by', time: 'at' },
  { table: 'wellbeing_acks', col: 'acked_by', time: 'acked_at' },
] as const;

/** Free text beside them that may name a student (the ban reason, a review's or an acknowledgement's note). */
const MODERATOR_TEXT_COLUMNS = [
  { table: 'bans', key: 'id', col: 'reason', time: 'created_at' },
  { table: 'flag_reviews', key: 'chat_id', col: 'note', time: 'at' },
  { table: 'wellbeing_acks', key: 'chat_id', col: 'note', time: 'acked_at' },
] as const;

/**
 * The moderator side of a deletion, for the names of `index`: the name in bans.by, reports.reviewed_by,
 * flag_reviews.by and wellbeing_acks.acked_by becomes the label (bounded by each row's time, like the audit text), and
 * the name is scrubbed from the ban reasons and the review / acknowledgement notes. Returns the rows changed.
 * Idempotent (a label never matches a username hash).
 */
async function scrubModeratorRecords(db: DatabaseSync, index: ScrubIndex, opts: EraseOptions, hits: Map<NameScrub, number>): Promise<number> {
  let rows = 0;
  for (const f of MODERATOR_NAME_COLUMNS) {
    aborted(opts.signal);
    const values = db.prepare(`SELECT DISTINCT "${f.col}" AS v FROM ${f.table} WHERE "${f.col}" IS NOT NULL AND "${f.col}" <> ''`).all() as { v: unknown }[];
    const set = db.prepare(`UPDATE ${f.table} SET "${f.col}" = ? WHERE "${f.col}" = ? AND COALESCE(${f.time}, 0) <= ?`);
    for (const { v } of values) {
      if (typeof v !== 'string') continue;
      // Earliest deletion first: the rows up to it take its label, the later ones the next deletion's.
      for (const s of index.lookup(nameKey(v))) {
        const n = Number(set.run(s.label, v, s.at ?? Number.MAX_SAFE_INTEGER).changes);
        if (n) { rows += n; hits.set(s, (hits.get(s) ?? 0) + n); }
      }
    }
  }
  for (const f of MODERATOR_TEXT_COLUMNS) {
    const page = db.prepare(`SELECT ${f.key} AS k, ${f.time} AS ts, "${f.col}" AS t FROM ${f.table}
                              WHERE ${f.key} > ? AND ${f.time} <= ? AND "${f.col}" IS NOT NULL AND "${f.col}" <> '' ORDER BY ${f.key} LIMIT 1000`);
    const set = db.prepare(`UPDATE ${f.table} SET "${f.col}" = ? WHERE ${f.key} = ?`);
    let after = -Infinity;
    for (;;) {
      aborted(opts.signal);
      const list = page.all(Number.isFinite(after) ? after : Number.MIN_SAFE_INTEGER, index.maxAt) as { k: number; ts: number; t: string }[];
      if (!list.length) break;
      tx(db, () => {
        for (const r of list) {
          after = Number(r.k);
          const next = scrubWith(index, r.t, Number(r.ts), hits);
          if (next !== r.t) { set.run(next, r.k); rows++; }
        }
      });
      if (list.length < 1000) break;
      await (opts.pause ?? defaultPause)();
    }
  }
  return rows;
}

// ------------------------------------------------------------------------------------------
// Purges
// ------------------------------------------------------------------------------------------

export interface PurgeSpec {
  /** epoch ms: lines with ts < before go */
  before: number;
  /** only this account's lines */
  accountId?: string | null;
}

export interface PurgeCounts { chat: number; conductRows: number; reportsUpdated: number; reportCopies: number }

/** Delete chat lines older than `before` (one account's, or everyone's), with everything that hangs off them. Idempotent. */
export async function purgeChatBefore(db: DatabaseSync, spec: PurgeSpec, opts: EraseOptions = {}): Promise<PurgeCounts> {
  assertEraseSchema(db);
  const before = Math.floor(spec.before);
  if (!Number.isFinite(before)) throw new Error('purgeChatBefore: before must be a time');
  const acc = spec.accountId || null;
  const ids = new Set<number>();
  const chat = await inChunks(
    acc
      ? db.prepare('DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE account_id = ? AND ts < ? ORDER BY id LIMIT ?) RETURNING id')
      : db.prepare('DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE ts < ? ORDER BY id LIMIT ?) RETURNING id'),
    acc ? [acc, before] : [before], opts, ids);
  const day = dayOf(before);
  const conductRows = Number((acc
    ? db.prepare('DELETE FROM conduct_daily WHERE account_key = ? AND day < ?').run(acc, day)
    : db.prepare('DELETE FROM conduct_daily WHERE day < ?').run(day)).changes);
  const r = await eachReport(db, opts, () => ({
    dropIds: ids,
    copies: (cp) => {
      const gone = (typeof cp.id === 'number' && ids.has(cp.id))
        || (typeof cp.ts === 'number' && cp.ts < before && (!acc || cp.accountId === acc));
      return gone ? null : cp;
    },
  }));
  markIndexDirty(db, chat);
  return { chat, conductRows, reportsUpdated: r.updated, reportCopies: r.copies };
}
