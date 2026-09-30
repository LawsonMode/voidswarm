// OWNER: AUTH store (LAN task B3). SQLite connection hardening and the untrusted-DB schema check
// (docs/LAN-EDITION-proposal.md §6.5, §0 fact 12).
//
// Why: the LAN child runs under `node --permission`, which fences fs writes and child processes but NOT node:sqlite.
// A connection could still ATTACH (or VACUUM INTO) a file anywhere on disk, and a planted schema object (a trigger or
// view in a DB imported from elsewhere) runs with the schema's trust. So every connection on a Voidswarm DB:
//   - runs with PRAGMA trusted_schema = OFF (schema objects may only use innocuous functions / virtual tables);
//   - keeps SQLite's defensive mode on (no writable_schema tricks; node:sqlite's default, set again here);
//   - gets an authorizer that denies ATTACH / DETACH (and so VACUUM INTO), setting trusted_schema back on,
//     writable_schema / schema_version, the temp/data_store_directory pragmas, and load_extension(). Plain VACUUM (it
//     attaches '' = a private temp DB) and the node:sqlite backup() API are unaffected; the maintenance worker's own
//     ATTACH-based steps use withAttachAllowed().
// And data from elsewhere (an import, a restore of another install's backup) is compared object by object with the
// schema this server builds from its own migrations for that user_version: no extra tables, indexes, triggers or
// views, and matching columns and statement text (triggers and views exactly; tables and indexes after comments and
// SQLite whitespace are dropped), FTS5 shadow tables included; and the FTS5 settings rows must be the ones the
// migrations leave. Otherwise it is refused: "This data folder was changed outside Voidswarm." stageUntrustedDb
// snapshots another copy (file + -wal) into data\, checks the snapshot, and drops its planner statistics, so the
// state that was checked is the state that gets used.
//
// No project imports: the auth store (../auth/store.ts) passes its MIGRATIONS in, so this file stays dependency-free
// and usable from the launcher, the server, the maintenance worker and the tools alike.
import { existsSync, rmSync } from 'node:fs';
import { backup, DatabaseSync, constants as sqliteConstants } from 'node:sqlite';

// ------------------------------------------------------------------------------------------
// Messages and errors
// ------------------------------------------------------------------------------------------

/** The refusal the host sees for a DB whose schema is not what this version of Voidswarm made (§6.5). */
export const CHANGED_OUTSIDE = 'This data folder was changed outside Voidswarm.';

export type DbGuardCode =
  /** user_version is newer than this server understands (never downgraded, never touched). */
  | 'ENEWER'
  /** the schema differs from the one this server's migrations build for that user_version. */
  | 'ECHANGED'
  /** not a readable SQLite database (missing, corrupt, failed integrity_check, wrong file). */
  | 'EUNREADABLE'
  /** this Node.js has no SQLite authorizer (strict protectConnection only). */
  | 'EUNSUPPORTED';

export class DbGuardError extends Error {
  readonly code: DbGuardCode;
  /** Short machine-readable differences ("extra trigger x", "changed table accounts", …); empty for other codes. */
  readonly differences: readonly string[];
  constructor(code: DbGuardCode, message: string, differences: readonly string[] = []) {
    super(message);
    this.name = 'DbGuardError';
    this.code = code;
    this.differences = differences;
  }
}

/** The "newer schema" refusal (the text still contains "newer than this server understands" for older callers). */
export function newerSchemaError(found: number, known: number): DbGuardError {
  return new DbGuardError('ENEWER',
    `This data was saved by a newer version of Voidswarm: its database schema v${found} is newer than this server `
    + `understands (v${known}). Start the newer version again, or restore a backup made by this version.`);
}

/** The ECHANGED refusal: the friendly sentence, then the first few differences for support. */
export function changedOutsideError(differences: readonly string[]): DbGuardError {
  const shown = differences.slice(0, 4).join('; ');
  const more = differences.length > 4 ? `; and ${differences.length - 4} more` : '';
  return new DbGuardError('ECHANGED', `${CHANGED_OUTSIDE} (${shown}${more})`, differences);
}

// ------------------------------------------------------------------------------------------
// Connection protections
// ------------------------------------------------------------------------------------------

/** SQLite's stable C API codes (sqlite3.h); the runtime values are preferred when node:sqlite exposes them. */
const K = sqliteConstants as unknown as Record<string, number | undefined>;
export const SQLITE_OK = K.SQLITE_OK ?? 0;
export const SQLITE_DENY = K.SQLITE_DENY ?? 1;
export const SQLITE_PRAGMA = K.SQLITE_PRAGMA ?? 19;
export const SQLITE_ATTACH = K.SQLITE_ATTACH ?? 24;
export const SQLITE_DETACH = K.SQLITE_DETACH ?? 25;
export const SQLITE_FUNCTION = K.SQLITE_FUNCTION ?? 31;

type AuthorizerFn = (action: number, arg1: string | null, arg2: string | null, dbName: string | null, trigger: string | null) => number;

/** The node:sqlite ≥ 24 methods @types/node 22 doesn't declare. */
interface HardenableDb {
  setAuthorizer?: (cb: AuthorizerFn | null) => void;
  enableDefensive?: (on: boolean) => void;
}

interface GuardState {
  /** exact ATTACH filenames allowed right now (withAttachAllowed), with nesting counts */
  attach: Map<string, number>;
  /** > 0 while inside withAttachAllowed: DETACH allowed */
  detach: number;
  /** false when this Node.js has no setAuthorizer (protections are then only trusted_schema + defensive) */
  authorizer: boolean;
}

const STATE = new WeakMap<DatabaseSync, GuardState>();

const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);

/**
 * Pragmas that are never set from SQL on a protected connection: schema-editing ones, and the (deprecated) ones that
 * point SQLite's own files at another folder, which would be a write outside data\ that --permission can't see.
 */
const DENIED_SET_PRAGMAS: ReadonlySet<string> = new Set(['writable_schema', 'schema_version', 'temp_store_directory', 'data_store_directory']);

/** The decision function installed as the authorizer (exported for tests). */
export function authorize(st: Pick<GuardState, 'attach' | 'detach'>, action: number, arg1: string | null, arg2: string | null): number {
  switch (action) {
    case SQLITE_ATTACH:
      // '' = a private temporary database: that is what a plain VACUUM attaches internally. A bound (non-literal)
      // filename arrives as null and is always denied.
      if (arg1 === '') return SQLITE_OK;
      return arg1 !== null && (st.attach.get(arg1) ?? 0) > 0 ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_DETACH:
      return st.detach > 0 ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_PRAGMA: {
      if (arg2 === null) return SQLITE_OK; // reading a pragma
      const name = (arg1 ?? '').toLowerCase();
      if (name === 'trusted_schema') return OFF_VALUES.has(arg2.trim().toLowerCase()) ? SQLITE_OK : SQLITE_DENY;
      return DENIED_SET_PRAGMAS.has(name) ? SQLITE_DENY : SQLITE_OK;
    }
    case SQLITE_FUNCTION:
      return (arg2 ?? '').toLowerCase() === 'load_extension' ? SQLITE_DENY : SQLITE_OK;
    default:
      return SQLITE_OK;
  }
}

export interface ProtectOptions {
  /** Throw DbGuardError('EUNSUPPORTED') when this Node.js has no SQLite authorizer (the LAN child's runtime has one). */
  strict?: boolean;
}

/**
 * Harden a connection (idempotent): trusted_schema = OFF, defensive mode on, and the authorizer (see the file header).
 * Call it right after `new DatabaseSync(...)`, before any other statement. Returns the same connection.
 */
export function protectConnection(db: DatabaseSync, opts: ProtectOptions = {}): DatabaseSync {
  const existing = STATE.get(db);
  if (existing) {
    if (opts.strict && !existing.authorizer) throw unsupported();
    return db;
  }
  const h = db as unknown as HardenableDb;
  const hasAuthorizer = typeof h.setAuthorizer === 'function';
  if (opts.strict && !hasAuthorizer) throw unsupported();
  if (typeof h.enableDefensive === 'function') h.enableDefensive(true);
  db.exec('PRAGMA trusted_schema = OFF');
  const st: GuardState = { attach: new Map(), detach: 0, authorizer: hasAuthorizer };
  if (hasAuthorizer) h.setAuthorizer!.call(db, (action, arg1, arg2) => authorize(st, action, arg1, arg2));
  STATE.set(db, st);
  return db;
}

function unsupported(): DbGuardError {
  return new DbGuardError('EUNSUPPORTED',
    `This Node.js (${process.version}) has no SQLite authorizer, so Voidswarm can't protect its database. Use Node.js 24.`);
}

/** Protections in place: protectConnection ran with an authorizer, and trusted_schema is still OFF. */
export function isProtected(db: DatabaseSync): boolean {
  const st = STATE.get(db);
  if (!st?.authorizer) return false;
  try {
    return Number((db.prepare('PRAGMA trusted_schema').get() as { trusted_schema?: number } | undefined)?.trusted_schema) === 0;
  } catch {
    return false;
  }
}

/** Whether protectConnection could install the authorizer on this connection (false = unprotected or old Node.js). */
export function hasAuthorizer(db: DatabaseSync): boolean {
  return STATE.get(db)?.authorizer === true;
}

/**
 * Run `fn` with ATTACH of exactly `filename` (as written in the SQL literal, e.g. `ATTACH '<filename>' AS x` or
 * `VACUUM INTO '<filename>'`) and DETACH allowed on this protected connection: for the maintenance worker's own
 * backup / compaction steps only. A bound parameter can't be matched (its filename is not known when the statement is
 * authorized), so use a quoted literal. Statements must be prepared inside `fn`.
 */
export function withAttachAllowed<T>(db: DatabaseSync, filename: string, fn: () => T): T {
  const st = STATE.get(db);
  if (!st) throw new Error('withAttachAllowed: protectConnection(db) first');
  if (!filename) throw new Error('withAttachAllowed: empty filename');
  st.attach.set(filename, (st.attach.get(filename) ?? 0) + 1);
  st.detach++;
  try {
    return fn();
  } finally {
    const n = (st.attach.get(filename) ?? 1) - 1;
    if (n > 0) st.attach.set(filename, n); else st.attach.delete(filename);
    st.detach--;
  }
}

export interface OpenDbOptions {
  /** Open read-only (no WAL switch, no pragmas that write). Default false. */
  readOnly?: boolean;
  /** PRAGMA busy_timeout, set first so the WAL switch waits too. Default 5000. */
  busyTimeoutMs?: number;
  /** PRAGMA foreign_keys = ON. Default true. */
  foreignKeys?: boolean;
  /** PRAGMA secure_delete = ON (deleted rows are overwritten in the file; §6.6 notes). Default true. */
  secureDelete?: boolean;
  /** See ProtectOptions.strict. */
  strict?: boolean;
}

/**
 * Open a protected connection with the project's usual settings (WAL, synchronous NORMAL, foreign_keys ON,
 * secure_delete ON, busy_timeout). The stores and the worker use this in place of `new DatabaseSync(path)`.
 * On any failure the connection is closed before the error is rethrown.
 */
export function openProtectedDb(path: string, opts: OpenDbOptions = {}): DatabaseSync {
  const readOnly = opts.readOnly === true;
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  try {
    protectConnection(db, { strict: opts.strict });
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    if (opts.foreignKeys !== false) db.exec('PRAGMA foreign_keys = ON');
    if (opts.secureDelete !== false && !readOnly) db.exec('PRAGMA secure_delete = ON');
    return db;
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
}

// ------------------------------------------------------------------------------------------
// Schema snapshot and diff
// ------------------------------------------------------------------------------------------

export interface SchemaObject {
  /** sqlite_schema.type: table | index | trigger | view */
  type: string;
  name: string;
  /** sqlite_schema.tbl_name */
  table: string;
  /** Canonical description compared between two snapshots (columns, keys, SQL text, …). */
  shape: string;
}

/** Keyed by `${type} ${name}`. */
export type SchemaSnapshot = ReadonlyMap<string, SchemaObject>;

/**
 * Internal tables SQLite itself may add to a legitimate file (ANALYZE / PRAGMA optimize statistics). They only steer
 * the query planner. Anything else outside the expected schema is refused.
 */
export const ALLOWED_EXTRA: ReadonlySet<string> = new Set(['table sqlite_stat1', 'table sqlite_stat4']);

type Row = Record<string, unknown>;

/**
 * Identifier characters as SQLite's tokenizer sees them: every code unit ≥ 0x80 is one (so a no-break space, U+2028,
 * U+FEFF … are NOT whitespace to SQLite, they are part of a name).
 */
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
/** SQLite's whitespace, exactly (tokenize.c: space, \t, \n, \f, \r; \v is an illegal character there). */
const SQLITE_SPACE = /[ \t\n\f\r]/;

/**
 * SQL text for comparison (sqlite_schema.sql keeps each statement as written, comments included): `--` and `/* *\/`
 * comments dropped, and whitespace kept only as one space where removing it could join two tokens (between two word
 * characters, and before a string literal after a word, since `x 'ab'` is a name then a string but `x'ab'` is a blob);
 * so `( a` and `(a` compare equal. Both only outside string literals and quoted names ('…', "…", `…`, […]), whose text
 * is kept exactly. "Whitespace" and "word character" are SQLite's own classes, so two texts that normalize alike
 * tokenize alike.
 */
export function normalizeSql(sql: unknown): string {
  if (typeof sql !== 'string') return '';
  let out = '';
  let space = false;
  const put = (s: string): void => {
    if (space && out && WORD_CHAR.test(out[out.length - 1]!) && (WORD_CHAR.test(s[0]!) || s[0] === "'")) out += ' ';
    space = false;
    out += s;
  };
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } // '' / "" / `` escapes
          break;
        }
        j++;
      }
      put(sql.slice(i, Math.min(j + 1, n)));
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl < 0 ? n : nl;
      space = true;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      space = true;
    } else if (SQLITE_SPACE.test(c)) {
      space = true;
      i++;
    } else {
      put(c);
      i++;
    }
  }
  return out;
}

const val = (v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v ?? null);
const rowsOf = (rows: Row[], cols: readonly string[]): unknown[][] => rows.map((r) => cols.map((c) => val(r[c])));

function describe(db: DatabaseSync, type: string, name: string, table: string, sql: unknown, kinds: Map<string, Row>): string {
  try {
    // Triggers and views are nothing but their statement, so it is compared exactly: our migrations create them and
    // never ALTER them, so a file they built stores exactly the migration text (every shipped migration's text is
    // unchanged since it shipped).
    if (type === 'trigger' || type === 'view') return JSON.stringify({ table, sql: typeof sql === 'string' ? sql : null });
    if (type === 'index') {
      const list = (db.prepare('SELECT name, "unique", origin, partial FROM pragma_index_list(?)').all(table) as Row[])
        .find((r) => r.name === name);
      const cols = rowsOf(db.prepare('SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo(?)').all(name) as Row[],
        ['seqno', 'cid', 'name', 'desc', 'coll', 'key']);
      return JSON.stringify({ table, sql: normalizeSql(sql), unique: val(list?.unique), origin: val(list?.origin), partial: val(list?.partial), cols });
    }
    if (type === 'table') {
      const k = kinds.get(name);
      const kind = String(k?.type ?? 'table');
      if (kind === 'virtual') return JSON.stringify({ kind, sql: normalizeSql(sql) });
      const cols = rowsOf(db.prepare('SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)').all(name) as Row[],
        ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', 'hidden']);
      const fks = rowsOf(db.prepare('SELECT id, seq, "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(?)').all(name) as Row[],
        ['id', 'seq', 'table', 'from', 'to', 'on_update', 'on_delete', 'match']);
      // The statement text too, for what the pragmas don't show (CHECK constraints, COLLATE, generated-column
      // expressions). A DB built by these migrations stores exactly their text (ALTER TABLE ADD COLUMN appends its
      // column definition as written); checked on real v2 and v3 files made by v0.3–v0.5. Shadow tables included:
      // FTS5 writes a fixed statement for each (e.g. `CREATE TABLE 'x_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`),
      // and the expected schema is built by this same SQLite, so a CHECK or COLLATE planted in one is caught.
      return JSON.stringify({ kind, wr: val(k?.wr), strict: val(k?.strict), cols, fks, sql: normalizeSql(sql) });
    }
    return JSON.stringify({ type, sql: normalizeSql(sql) });
  } catch (e) {
    // A planted object can make its own description fail (an unknown module, a view on nothing): it never matches.
    return `unreadable: ${(e as Error)?.message ?? e}`;
  }
}

/** Describe every object in the connection's main schema (reads sqlite_schema and the schema pragmas only). */
export function snapshotSchema(db: DatabaseSync): SchemaSnapshot {
  const out = new Map<string, SchemaObject>();
  const kinds = new Map<string, Row>();
  for (const r of db.prepare("SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = 'main'").all() as Row[]) {
    kinds.set(String(r.name), r);
  }
  const objects = db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name').all() as Row[];
  for (const r of objects) {
    const type = String(r.type);
    const name = String(r.name);
    const table = String(r.tbl_name ?? '');
    out.set(`${type} ${name}`, { type, name, table, shape: describe(db, type, name, table, r.sql, kinds) });
  }
  return out;
}

/** Differences of `actual` from `expected`, as short strings ("extra trigger t", "missing index i", "changed table a"). */
export function diffSchema(expected: SchemaSnapshot, actual: SchemaSnapshot): string[] {
  const out: string[] = [];
  for (const [key, a] of actual) {
    if (ALLOWED_EXTRA.has(key)) continue;
    const e = expected.get(key);
    if (!e) out.push(`extra ${a.type} ${a.name}`);
    else if (e.shape !== a.shape) out.push(`changed ${a.type} ${a.name}`);
  }
  for (const [key, e] of expected) if (!actual.has(key)) out.push(`missing ${e.type} ${e.name}`);
  return out;
}

/**
 * The settings rows of every FTS5 table (its `<name>_config` shadow table: 'version', and whatever `INSERT INTO
 * x(x, rank) VALUES('secure-delete' | 'automerge' | 'crisismerge' | 'pgsz' | …, n)` stored), keyed by the shadow
 * table's name, each as canonical JSON. Data, not schema, but it steers the engine: an imported copy with
 * secure-delete switched back on makes every purge 30–130× slower (§0 fact 4). So it must be what the migrations set.
 */
export type FtsConfigSnapshot = ReadonlyMap<string, string>;

/**
 * FTS5 merge knobs the server itself tunes at run time (ModStore.setFtsMerge: automerge 0 on the game connection
 * while the maintenance worker merges, back on when it fails). Within their sane ranges they are left out of the
 * comparison (T-PERF-2); a value outside them (an automerge that would stall every commit) still counts as changed.
 */
export const FTS_TUNABLE: Readonly<Record<string, readonly [number, number]>> = Object.freeze({ automerge: [0, 16], crisismerge: [2, 64] });

export function tunableFtsSetting(k: unknown, v: unknown): boolean {
  const range = typeof k === 'string' && Object.prototype.hasOwnProperty.call(FTS_TUNABLE, k) ? FTS_TUNABLE[k] : undefined;
  if (!range) return false;
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= range[0] && n <= range[1];
}

export function ftsConfigSnapshot(db: DatabaseSync): FtsConfigSnapshot {
  const out = new Map<string, string>();
  const list = db.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all() as Row[];
  const virtual = new Set(list.filter((r) => r.type === 'virtual').map((r) => String(r.name)));
  for (const r of list) {
    const name = String(r.name);
    if (r.type !== 'shadow' || !name.endsWith('_config') || !virtual.has(name.slice(0, -'_config'.length))) continue;
    let shape: string;
    try {
      const rows = (db.prepare(`SELECT k, v FROM main."${name.replace(/"/g, '""')}" ORDER BY k`).all() as Row[])
        .filter((row) => !tunableFtsSetting(row.k, row.v));
      shape = JSON.stringify(rowsOf(rows, ['k', 'v']));
    } catch (e) {
      shape = `unreadable: ${(e as Error)?.message ?? e}`;
    }
    out.set(name, shape);
  }
  return out;
}

/** Differences of `actual` FTS5 settings from `expected` ("changed fts settings chat_fts_config", …). */
export function diffFtsConfig(expected: FtsConfigSnapshot, actual: FtsConfigSnapshot): string[] {
  const out: string[] = [];
  for (const [name, a] of actual) if (expected.get(name) !== a) out.push(`changed fts settings ${name}`);
  for (const name of expected.keys()) if (!actual.has(name)) out.push(`missing fts settings ${name}`);
  return out;
}

interface ExpectedBuild { schema: SchemaSnapshot; fts: FtsConfigSnapshot }

const expectedCache = new WeakMap<readonly string[], Map<number, ExpectedBuild>>();

function expectedBuild(migrations: readonly string[], version: number): ExpectedBuild {
  if (!Number.isInteger(version) || version < 0 || version > migrations.length) {
    throw new RangeError(`expectedSchema: no schema v${version} (this server knows v0..v${migrations.length})`);
  }
  let byVersion = expectedCache.get(migrations);
  if (!byVersion) expectedCache.set(migrations, (byVersion = new Map()));
  const hit = byVersion.get(version);
  if (hit) return hit;
  const ref = new DatabaseSync(':memory:');
  try {
    protectConnection(ref);
    for (let v = 0; v < version; v++) ref.exec(migrations[v]!);
    const built: ExpectedBuild = { schema: snapshotSchema(ref), fts: ftsConfigSnapshot(ref) };
    byVersion.set(version, built);
    return built;
  } finally {
    ref.close();
  }
}

/**
 * The schema this server's migrations build for `version` (MIGRATIONS[0 .. version-1] on a fresh in-memory DB).
 * Cached per migrations array and version.
 */
export function expectedSchema(migrations: readonly string[], version: number): SchemaSnapshot {
  return expectedBuild(migrations, version).schema;
}

/** The FTS5 settings rows the migrations leave for `version` (same build and cache as expectedSchema). */
export function expectedFtsConfig(migrations: readonly string[], version: number): FtsConfigSnapshot {
  return expectedBuild(migrations, version).fts;
}

/** PRAGMA user_version of a connection. */
export function userVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
}

/**
 * Compare a connection's schema with the expected one for its user_version (or `version`). Throws ENEWER for a
 * version this server doesn't know; returns the differences (empty = matches).
 */
export function schemaDifferences(db: DatabaseSync, migrations: readonly string[], version = userVersion(db)): string[] {
  if (version > migrations.length) throw newerSchemaError(version, migrations.length);
  if (!Number.isInteger(version) || version < 0) return [`user_version ${version} is not one Voidswarm writes`];
  return diffSchema(expectedSchema(migrations, version), snapshotSchema(db));
}

/** schemaDifferences, throwing the ECHANGED refusal when there are any. */
export function assertSchema(db: DatabaseSync, migrations: readonly string[], version?: number): void {
  const diffs = schemaDifferences(db, migrations, version);
  if (diffs.length) throw changedOutsideError(diffs);
}

// ------------------------------------------------------------------------------------------
// Untrusted files (imports, restores from another install)
// ------------------------------------------------------------------------------------------

/**
 * Tables that never come across from another copy (§6.5): the new copy runs its own first-run setup. `host_setup`
 * (the setup code's hash and backoff) is install-local for the same reason.
 */
export const NEVER_IMPORTED_TABLES: readonly string[] = ['host_admins', 'admin_sessions', 'host_setup'];

export interface UntrustedCheckOptions {
  /** The migrations that define the expected schema (the auth store's MIGRATIONS). */
  migrations: readonly string[];
  /** 'full' = PRAGMA integrity_check (default), 'quick' = quick_check, 'none' = skip (the caller already ran one). */
  integrity?: 'full' | 'quick' | 'none';
}

export interface UntrustedCheckResult {
  /** user_version of the checked file */
  version: number;
  /** true when opening it with this server will run migrations */
  needsMigration: boolean;
}

/**
 * Check a database file from elsewhere before anything else opens it: read-only, protected connection; integrity
 * check; user_version known; schema identical to the one this server builds for that version; FTS5 settings rows
 * (ftsConfigSnapshot) as the migrations left them. Throws DbGuardError (EUNREADABLE / ENEWER / ECHANGED); never
 * writes the database (SQLite may create a -shm beside a WAL file to read it). Planner statistics (sqlite_stat1 /
 * sqlite_stat4, ALLOWED_EXTRA) are allowed here but can be crafted: whoever uses the file drops them first
 * (dropPlannerStats; stageUntrustedDb does it for its snapshot).
 * It checks the file AS SQLITE READS IT, including a -wal beside it; deleting that -wal afterwards changes what was
 * checked. So for another install's data folder use stageUntrustedDb, which snapshots file + WAL into one staged
 * file and checks that; a decrypted backup is a single file already.
 */
export function checkUntrustedDb(path: string, opts: UntrustedCheckOptions): UntrustedCheckResult {
  if (!path || path === ':memory:' || !existsSync(path)) throw new DbGuardError('EUNREADABLE', `No database file at ${path || '(none)'}.`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw unreadable(e);
  }
  try {
    try {
      protectConnection(db);
      db.exec('PRAGMA busy_timeout = 2000');
      const mode = opts.integrity ?? 'full';
      if (mode !== 'none') {
        const rows = db.prepare(mode === 'quick' ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').all() as Row[];
        const msgs = rows.map((r) => String(Object.values(r)[0] ?? ''));
        if (msgs.length !== 1 || msgs[0] !== 'ok') {
          throw new DbGuardError('EUNREADABLE', `The database failed its integrity check (${msgs.slice(0, 3).join('; ')}).`);
        }
      }
    } catch (e) {
      throw e instanceof DbGuardError ? e : unreadable(e);
    }
    try {
      const version = userVersion(db);
      assertSchema(db, opts.migrations, version);
      const fts = diffFtsConfig(expectedFtsConfig(opts.migrations, version), ftsConfigSnapshot(db));
      if (fts.length) throw changedOutsideError(fts);
      return { version, needsMigration: version < opts.migrations.length };
    } catch (e) {
      throw e instanceof DbGuardError ? e : unreadable(e);
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** The planner statistics tables ANALYZE / PRAGMA optimize create (the only extras ALLOWED_EXTRA lets through). */
export const PLANNER_STATS_TABLES: readonly string[] = ['sqlite_stat1', 'sqlite_stat4'];

/**
 * Drop the planner statistics from a (protected, writable) connection to data from elsewhere: crafted rows can steer
 * the query planner into full scans. They only speed up planning; SQLite plans without them, and a later ANALYZE /
 * PRAGMA optimize on this install rebuilds them from real data. Returns the tables dropped (none = nothing written).
 */
export function dropPlannerStats(db: DatabaseSync): string[] {
  const present = (db.prepare(`SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name IN (${PLANNER_STATS_TABLES.map(() => '?').join(', ')})`)
    .all(...PLANNER_STATS_TABLES) as { name: string }[]).map((r) => r.name);
  for (const t of present) db.exec(`DROP TABLE main.${t}`);
  return present;
}

function unreadable(e: unknown): DbGuardError {
  return new DbGuardError('EUNREADABLE', `This is not a readable Voidswarm database (${(e as Error)?.message ?? e}).`);
}

const removeDbFiles = (path: string): void => {
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try { rmSync(f, { force: true }); } catch { /* best effort */ }
  }
};

/**
 * Snapshot another copy's database into `destPath` and check the snapshot (§6.5): the source is opened read-only
 * and protected, and the node:sqlite backup() API (which the authorizer does not gate) copies what SQLite reads,
 * main file plus any -wal, into one self-contained file. Then checkUntrustedDb runs on that file, so the state that
 * was checked is exactly the state that will be used. `destPath` must not exist yet (put it in data\, e.g.
 * data\import.staged.db). A refused or unreadable snapshot is deleted before the error is rethrown. An accepted one
 * then has its planner statistics dropped (dropPlannerStats; removing them can't add anything the check would
 * refuse). Rows of NEVER_IMPORTED_TABLES are still in the snapshot: the caller clears them before using it.
 */
export async function stageUntrustedDb(srcPath: string, destPath: string, opts: UntrustedCheckOptions): Promise<UntrustedCheckResult> {
  if (!srcPath || srcPath === ':memory:' || !existsSync(srcPath)) {
    throw new DbGuardError('EUNREADABLE', `No database file at ${srcPath || '(none)'}.`);
  }
  if (!destPath || destPath === ':memory:') throw new Error('stageUntrustedDb: a staging file path is required');
  if ([destPath, `${destPath}-wal`, `${destPath}-journal`].some((f) => existsSync(f))) {
    throw new Error(`stageUntrustedDb: ${destPath} already exists; remove the old staging copy first`);
  }
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(srcPath, { readOnly: true });
  } catch (e) {
    throw unreadable(e);
  }
  try {
    protectConnection(src);
    src.exec('PRAGMA busy_timeout = 2000');
    await backup(src, destPath);
  } catch (e) {
    removeDbFiles(destPath);
    throw e instanceof DbGuardError ? e : unreadable(e);
  } finally {
    try { src.close(); } catch { /* already closed */ }
  }
  try {
    const result = checkUntrustedDb(destPath, opts);
    const staged = new DatabaseSync(destPath);
    try {
      protectConnection(staged);
      staged.exec('PRAGMA busy_timeout = 2000');
      if (dropPlannerStats(staged).length) staged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      try { staged.close(); } catch { /* already closed */ }
    }
    return result;
  } catch (e) {
    removeDbFiles(destPath);
    throw e instanceof DbGuardError ? e : unreadable(e);
  }
}
