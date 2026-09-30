// OWNER: AUTH store (LAN task B3). The SQLite guard (docs/LAN-EDITION-proposal.md §6.5): connection protections
// (T-LAN-13, sqlite part: ATTACH and VACUUM INTO are denied by the authorizer, also inside a real `--permission`
// child) and the untrusted-DB schema comparison.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, constants, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_EXTRA, assertSchema, authorize, CHANGED_OUTSIDE, checkUntrustedDb, DbGuardError, diffFtsConfig, diffSchema,
  dropPlannerStats, expectedFtsConfig, expectedSchema, ftsConfigSnapshot, isProtected, NEVER_IMPORTED_TABLES, normalizeSql,
  openProtectedDb, PLANNER_STATS_TABLES, protectConnection, schemaDifferences, snapshotSchema, SQLITE_ATTACH, SQLITE_DENY,
  SQLITE_DETACH, SQLITE_FUNCTION, SQLITE_OK, SQLITE_PRAGMA, stageUntrustedDb, withAttachAllowed,
} from './guard';

const dirs: string[] = [];
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'voidswarm-guard-'));
  dirs.push(d);
  return d;
};
const track = (db: DatabaseSync): DatabaseSync => { open.push(db); return db; };
const sqlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** A small two-step schema in the shape of the real one (tables, indexes, a WITHOUT ROWID table, FTS5 + triggers). */
const TEST_MIGRATIONS: readonly string[] = [
  `CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE, note TEXT);
   CREATE INDEX people_name ON people(name);
   CREATE TABLE lines (id INTEGER PRIMARY KEY, person TEXT REFERENCES people(id) ON DELETE CASCADE, body TEXT NOT NULL);`,
  `ALTER TABLE people ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
   CREATE TABLE tags (line_id INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE, tag TEXT NOT NULL,
     PRIMARY KEY (line_id, tag)) WITHOUT ROWID;
   CREATE VIRTUAL TABLE lines_fts USING fts5(body, content='lines', content_rowid='id', tokenize='trigram');
   CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN INSERT INTO lines_fts(rowid, body) VALUES (new.id, new.body); END;`,
];

function makeDb(path: string, version: number, extra = ''): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    for (let v = 0; v < version; v++) db.exec(TEST_MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${version}`);
    if (extra) db.exec(extra);
  } finally {
    db.close();
  }
}

describe('protectConnection (T-LAN-13, sqlite part)', () => {
  it('uses the SQLite C API codes node:sqlite exposes', () => {
    const k = constants as unknown as Record<string, number>;
    expect([SQLITE_OK, SQLITE_DENY, SQLITE_PRAGMA, SQLITE_ATTACH, SQLITE_DETACH, SQLITE_FUNCTION])
      .toEqual([k.SQLITE_OK ?? 0, k.SQLITE_DENY ?? 1, k.SQLITE_PRAGMA ?? 19, k.SQLITE_ATTACH ?? 24, k.SQLITE_DETACH ?? 25, k.SQLITE_FUNCTION ?? 31]);
  });

  it('denies ATTACH (literal and bound), DETACH and VACUUM INTO; no file is created', () => {
    const dir = tempDir();
    const db = track(protectConnection(new DatabaseSync(join(dir, 'main.db'))));
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    const evil = join(dir, 'outside', 'evil.db');
    mkdirSync(dirname(evil), { recursive: true });
    expect(() => db.exec(`ATTACH ${sqlQuote(evil)} AS evil`)).toThrow(/not authorized/);
    expect(() => db.prepare('ATTACH ? AS evil').run(evil)).toThrow(/not authorized/);
    expect(() => db.exec(`VACUUM INTO ${sqlQuote(join(dir, 'outside', 'copy.db'))}`)).toThrow(/authoriz/);
    expect(() => db.exec('DETACH main')).toThrow(/not authorized/);
    expect(existsSync(evil)).toBe(false);
    expect(existsSync(join(dir, 'outside', 'copy.db'))).toBe(false);
    expect(isProtected(db)).toBe(true);
  });

  it('control: an unprotected connection CAN attach a file anywhere (the gap --permission leaves)', () => {
    const dir = tempDir();
    const db = track(new DatabaseSync(':memory:'));
    const f = join(dir, 'made-by-attach.db');
    db.exec(`ATTACH ${sqlQuote(f)} AS x; CREATE TABLE x.t (a); DETACH x`);
    expect(existsSync(f)).toBe(true);
    expect(isProtected(db)).toBe(false);
  });

  it('keeps trusted_schema OFF and defensive mode on; refuses to switch them back from SQL', () => {
    const db = track(protectConnection(new DatabaseSync(':memory:')));
    expect(db.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 });
    expect(() => db.exec('PRAGMA trusted_schema = ON')).toThrow(/not authorized/);
    expect(() => db.exec('PRAGMA main.trusted_schema = 1')).toThrow(/not authorized/);
    db.exec('PRAGMA trusted_schema = OFF'); // allowed: it's already off
    expect(() => db.exec('PRAGMA writable_schema = ON')).toThrow(/not authorized/);
    expect(() => db.exec('PRAGMA schema_version = 99')).toThrow(/not authorized/);
    expect(() => db.prepare("SELECT load_extension('x')").get()).toThrow(/not authorized/);
    expect(db.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 });
    expect(isProtected(db)).toBe(true);
  });

  it("with trusted_schema OFF a planted trigger can't call an application function (it can with the default)", () => {
    for (const protectedDb of [false, true]) {
      const db = track(new DatabaseSync(':memory:'));
      if (protectedDb) protectConnection(db);
      let calls = 0;
      db.function('app_side_effect', () => { calls++; return 1; }); // not innocuous: fine to call directly
      db.exec('CREATE TABLE t (x); CREATE TABLE log (y)');
      db.exec('CREATE TRIGGER planted AFTER INSERT ON t BEGIN INSERT INTO log VALUES (app_side_effect()); END');
      if (protectedDb) {
        expect(() => db.exec('INSERT INTO t VALUES (1)')).toThrow(/unsafe use of app_side_effect/);
        expect(calls).toBe(0);
        expect(db.prepare('SELECT app_side_effect() AS v').get()).toEqual({ v: 1 }); // direct calls still work
      } else {
        db.exec('INSERT INTO t VALUES (1)');
        expect(calls).toBe(1);
      }
    }
  });

  it('allows everything the stores do: WAL, pragmas, FTS5 triggers, plain VACUUM, wal_checkpoint and backup()', async () => {
    const dir = tempDir();
    const path = join(dir, 'ok.db');
    const db = track(openProtectedDb(path));
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    for (const m of TEST_MIGRATIONS) db.exec(m);
    db.exec("PRAGMA user_version = 2; PRAGMA secure_delete = OFF; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 0; PRAGMA busy_timeout = 5000");
    db.prepare("INSERT INTO people (id, name, name_lower) VALUES ('p1', 'NovaPilot', 'novapilot')").run();
    db.prepare("INSERT INTO lines (person, body) VALUES ('p1', 'good game everyone')").run();
    expect(db.prepare("SELECT rowid FROM lines_fts WHERE lines_fts MATCH 'game'").all()).toEqual([{ rowid: 1 }]);
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const copy = join(dir, 'copy.db');
    await backup(db, copy);
    const c = track(new DatabaseSync(copy, { readOnly: true }));
    expect(c.prepare('SELECT name FROM people').all()).toEqual([{ name: 'NovaPilot' }]);
  });

  it('withAttachAllowed opens ATTACH / VACUUM INTO for exactly one file, only inside the callback', () => {
    const dir = tempDir();
    const db = track(protectConnection(new DatabaseSync(join(dir, 'src.db'))));
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (42)');
    const target = join(dir, "it's-the-backup.db");
    withAttachAllowed(db, target, () => {
      db.exec(`VACUUM INTO ${sqlQuote(target)}`);
      expect(() => db.exec(`VACUUM INTO ${sqlQuote(join(dir, 'other.db'))}`)).toThrow(/authoriz/);
      db.exec(`ATTACH ${sqlQuote(target)} AS b`);
      expect(db.prepare('SELECT x FROM b.t').get()).toEqual({ x: 42 });
      db.exec('DETACH b');
    });
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(dir, 'other.db'))).toBe(false);
    expect(() => db.exec(`ATTACH ${sqlQuote(target)} AS b`)).toThrow(/not authorized/);
    expect(() => withAttachAllowed(track(new DatabaseSync(':memory:')), target, () => 0)).toThrow(/protectConnection/);
  });

  it('the decision table', () => {
    const st = { attach: new Map<string, number>([['ok.db', 1]]), detach: 0 };
    expect(authorize(st, SQLITE_ATTACH, 'ok.db', null)).toBe(SQLITE_OK);
    expect(authorize(st, SQLITE_ATTACH, 'other.db', null)).toBe(SQLITE_DENY);
    expect(authorize(st, SQLITE_ATTACH, null, null)).toBe(SQLITE_DENY);
    expect(authorize(st, SQLITE_ATTACH, '', null)).toBe(SQLITE_OK); // plain VACUUM's private temp DB
    expect(authorize(st, SQLITE_DETACH, 'x', null)).toBe(SQLITE_DENY);
    expect(authorize({ ...st, detach: 1 }, SQLITE_DETACH, 'x', null)).toBe(SQLITE_OK);
    expect(authorize(st, SQLITE_PRAGMA, 'trusted_schema', null)).toBe(SQLITE_OK);
    for (const v of ['OFF', 'off', '0', 'false', 'no']) expect(authorize(st, SQLITE_PRAGMA, 'trusted_schema', v)).toBe(SQLITE_OK);
    for (const v of ['ON', '1', 'yes', 'true']) expect(authorize(st, SQLITE_PRAGMA, 'TRUSTED_SCHEMA', v)).toBe(SQLITE_DENY);
    expect(authorize(st, SQLITE_PRAGMA, 'journal_mode', 'WAL')).toBe(SQLITE_OK);
    expect(authorize(st, SQLITE_PRAGMA, 'user_version', '4')).toBe(SQLITE_OK);
    for (const p of ['writable_schema', 'schema_version', 'temp_store_directory', 'DATA_STORE_DIRECTORY']) {
      expect(authorize(st, SQLITE_PRAGMA, p, 'x')).toBe(SQLITE_DENY);
    }
    expect(authorize(st, SQLITE_PRAGMA, 'schema_version', null)).toBe(SQLITE_OK); // reading is harmless
    expect(authorize(st, SQLITE_FUNCTION, null, 'LOAD_EXTENSION')).toBe(SQLITE_DENY);
    expect(authorize(st, SQLITE_FUNCTION, null, 'lower')).toBe(SQLITE_OK);
  });

  it('inside a real `node --permission` child (the LAN server sandbox): fs writes outside data are refused, and so are ATTACH and VACUUM INTO', () => {
    const dir = tempDir();
    const data = join(dir, 'data');
    const outside = join(dir, 'outside');
    mkdirSync(data);
    mkdirSync(outside);
    const guardPath = fileURLToPath(new URL('./guard.ts', import.meta.url));
    const script = `
      import { writeFileSync, existsSync } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const { protectConnection } = await import(${JSON.stringify(new URL('./guard.ts', import.meta.url).href)});
      const [data, outside] = process.argv.slice(-2);
      const q = (s) => "'" + s.replace(/'/g, "''") + "'";
      const out = {};
      try { writeFileSync(outside + '/x.txt', 'x'); out.fsWrite = 'ok'; } catch (e) { out.fsWrite = e.code; }
      const db = protectConnection(new DatabaseSync(data + '/voidswarm.db'));
      db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
      try { db.exec('ATTACH ' + q(outside + '/evil.db') + ' AS e'); out.attach = 'ok'; } catch (e) { out.attach = e.message; }
      try { db.exec('VACUUM INTO ' + q(outside + '/copy.db')); out.vacuumInto = 'ok'; } catch (e) { out.vacuumInto = e.message; }
      out.files = [existsSync(outside + '/evil.db'), existsSync(outside + '/copy.db'), existsSync(outside + '/x.txt')];
      db.close();
      process.stdout.write(JSON.stringify(out));
    `;
    const r = spawnSync(process.execPath, [
      '--permission', `--allow-fs-read=${dirname(guardPath)}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${data}`,
      '--no-warnings', '--input-type=module', '-e', script, data, outside,
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { fsWrite: string; attach: string; vacuumInto: string; files: boolean[] };
    expect(out.fsWrite).toBe('ERR_ACCESS_DENIED');
    expect(out.attach).toMatch(/not authorized/);
    expect(out.vacuumInto).toMatch(/authoriz/);
    expect(out.files).toEqual([false, false, false]);
  });
});

describe('schema snapshot and diff', () => {
  it('a DB built by the migrations matches the expected schema for its version, at every version', () => {
    const dir = tempDir();
    for (let v = 0; v <= TEST_MIGRATIONS.length; v++) {
      const p = join(dir, `v${v}.db`);
      makeDb(p, v);
      const db = track(protectConnection(new DatabaseSync(p, { readOnly: true })));
      expect(schemaDifferences(db, TEST_MIGRATIONS)).toEqual([]);
      expect(() => assertSchema(db, TEST_MIGRATIONS)).not.toThrow();
    }
    // v1 → v2 by migration equals v2 built fresh (ALTER TABLE ADD COLUMN gives the same shape).
    const up = join(dir, 'up.db');
    makeDb(up, 1);
    const db = track(new DatabaseSync(up));
    db.exec(TEST_MIGRATIONS[1]!);
    db.exec('PRAGMA user_version = 2');
    expect(diffSchema(expectedSchema(TEST_MIGRATIONS, 2), snapshotSchema(db))).toEqual([]);
    expect(expectedSchema(TEST_MIGRATIONS, 2)).toBe(expectedSchema(TEST_MIGRATIONS, 2)); // cached
  });

  it.each([
    ['an extra trigger', 'CREATE TRIGGER sneaky AFTER INSERT ON people BEGIN DELETE FROM lines; END', ['extra trigger sneaky']],
    ['an extra view', 'CREATE VIEW everyone AS SELECT * FROM people', ['extra view everyone']],
    ['an extra table', 'CREATE TABLE stash (x)', ['extra table stash']],
    ['an extra index', 'CREATE INDEX people_note ON people(note)', ['extra index people_note']],
    ['a missing index', 'DROP INDEX people_name', ['missing index people_name']],
    ['an extra column', 'ALTER TABLE people ADD COLUMN extra TEXT', ['changed table people']],
    ['a replaced trigger body', 'DROP TRIGGER lines_ai; CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN DELETE FROM people; END', ['changed trigger lines_ai']],
    ['a trigger with a no-break space for a space',
      'DROP TRIGGER lines_ai; CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN INSERT INTO lines_fts(rowid, body) VALUES (new.id, new.body); END',
      ['changed trigger lines_ai']],
    ['a trigger re-created with the same tokens but other spacing (triggers are compared exactly)',
      'DROP TRIGGER lines_ai; CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN INSERT INTO lines_fts(rowid, body) VALUES (new.id,new.body); END',
      ['changed trigger lines_ai']],
    ['a changed FTS5 virtual table', 'DROP TABLE lines_fts; CREATE VIRTUAL TABLE lines_fts USING fts5(body, content=\'lines\', content_rowid=\'id\')',
      ['changed table lines_fts']],
    ['a table swapped for a view', 'DROP TABLE tags; CREATE VIEW tags AS SELECT 1 AS line_id, 2 AS tag', ['extra view tags', 'missing table tags']],
  ])('refuses %s', (_what, sql, want) => {
    const dir = tempDir();
    const p = join(dir, 'x.db');
    makeDb(p, 2, sql);
    const db = track(protectConnection(new DatabaseSync(p, { readOnly: true })));
    expect(schemaDifferences(db, TEST_MIGRATIONS).sort()).toEqual([...want].sort());
    let err: unknown;
    try { assertSchema(db, TEST_MIGRATIONS); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DbGuardError);
    expect((err as DbGuardError).code).toBe('ECHANGED');
    expect((err as DbGuardError).message.startsWith(CHANGED_OUTSIDE)).toBe(true);
    expect((err as DbGuardError).differences).toEqual(schemaDifferences(db, TEST_MIGRATIONS));
  });

  it('normalizeSql drops comments and collapses whitespace, but only outside literals and quoted names', () => {
    expect(normalizeSql("CREATE TABLE t (\n  a TEXT,   -- a note\n  b /* old */ INT\n)")).toBe('CREATE TABLE t(a TEXT,b INT)');
    expect(normalizeSql('CREATE TABLE t(a TEXT, b INT)')).toBe('CREATE TABLE t(a TEXT,b INT)');
    expect(normalizeSql("DEFAULT 'a  -- not a comment'")).toBe("DEFAULT 'a  -- not a comment'");
    expect(normalizeSql(`"we""ird  name" [x  y] \`q  r\` 'it''s  /* kept */'`)).toBe(`"we""ird  name"[x  y]\`q  r\`'it''s  /* kept */'`);
    expect(normalizeSql('  a\t\tb  ')).toBe('a b');
    expect(normalizeSql('a\r\n\fb')).toBe('a b');
    expect(normalizeSql('x IN (1 , 2)')).toBe(normalizeSql('x IN(1,2)'));
    expect(normalizeSql("x -- trailing")).toBe('x');
    expect(normalizeSql("'unterminated")).toBe("'unterminated");
    expect(normalizeSql(null)).toBe('');
  });

  it("normalizeSql uses SQLite's whitespace, not JavaScript's: a Unicode space is part of a name to SQLite", () => {
    // SQLite's tokenizer treats only space, \t, \n, \f and \r as whitespace; every character >= 0x80 is an identifier
    // character. `new.original,<NBSP>new.shown` names a column "<NBSP>new" (an error at run time), so it must differ.
    for (const ch of [' ', ' ', ' ', '﻿', '　', '​', ' ', '\v']) {
      expect(normalizeSql(`VALUES (new.original,${ch}new.shown)`), JSON.stringify(ch)).not.toBe(normalizeSql('VALUES (new.original, new.shown)'));
      expect(normalizeSql(`UPDATE OF original,${ch}shown`), JSON.stringify(ch)).not.toBe(normalizeSql('UPDATE OF original, shown'));
    }
    // A blob literal is not a name followed by a string.
    expect(normalizeSql("SELECT x 'ab'")).not.toBe(normalizeSql("SELECT x'ab'"));
    expect(normalizeSql("SELECT x   'ab'")).toBe(normalizeSql("SELECT x 'ab'"));
  });

  it('two statements that normalize alike tokenize alike in SQLite (a trigger is also compared exactly)', () => {
    const db = track(protectConnection(new DatabaseSync(':memory:')));
    db.exec('CREATE TABLE t (a, b); CREATE TABLE log (x)');
    // A no-break space where a space was: SQLite reads a column named "<NBSP>b".
    db.exec('CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.a + b); END');
    expect(() => db.exec('INSERT INTO t VALUES (1, 2)')).toThrow(/no such column/);
  });

  it('a changed or dropped CHECK constraint is caught; comments and spacing in the stored text are not a change', () => {
    const migrations = ["CREATE TABLE b (kind TEXT NOT NULL CHECK (kind IN ('ban', 'mute')), note TEXT COLLATE NOCASE)"];
    const dir = tempDir();
    const build = (name: string, sql: string): DatabaseSync => {
      const p = join(dir, name);
      const d = new DatabaseSync(p);
      d.exec(sql);
      d.exec('PRAGMA user_version = 1');
      d.close();
      return track(protectConnection(new DatabaseSync(p, { readOnly: true })));
    };
    expect(schemaDifferences(build('same.db', migrations[0]!), migrations)).toEqual([]);
    expect(schemaDifferences(build('spaced.db', "CREATE TABLE b (\n  kind TEXT NOT NULL CHECK (kind IN ('ban', 'mute')), -- the kind\n  note TEXT COLLATE NOCASE\n)"), migrations)).toEqual([]);
    expect(schemaDifferences(build('widened.db', "CREATE TABLE b (kind TEXT NOT NULL CHECK (kind IN ('ban', 'mute', 'x')), note TEXT COLLATE NOCASE)"), migrations))
      .toEqual(['changed table b']);
    expect(schemaDifferences(build('nocheck.db', 'CREATE TABLE b (kind TEXT NOT NULL, note TEXT COLLATE NOCASE)'), migrations)).toEqual(['changed table b']);
    expect(schemaDifferences(build('collate.db', "CREATE TABLE b (kind TEXT NOT NULL CHECK (kind IN ('ban', 'mute')), note TEXT)"), migrations)).toEqual(['changed table b']);
  });

  it('a column whose type changed is caught even with the same name', () => {
    const dir = tempDir();
    const p = join(dir, 'x.db');
    const db0 = new DatabaseSync(p);
    db0.exec(TEST_MIGRATIONS[0]!.replace('note TEXT', 'note BLOB'));
    db0.exec('PRAGMA user_version = 1');
    db0.close();
    const db = track(protectConnection(new DatabaseSync(p, { readOnly: true })));
    expect(schemaDifferences(db, TEST_MIGRATIONS)).toEqual(['changed table people']);
  });

  it("allows only SQLite's own planner statistics as extras (ANALYZE)", () => {
    const dir = tempDir();
    const p = join(dir, 'x.db');
    makeDb(p, 2, "INSERT INTO people (id, name, name_lower) VALUES ('a', 'A', 'a'); ANALYZE");
    const db = track(protectConnection(new DatabaseSync(p, { readOnly: true })));
    expect(snapshotSchema(db).has('table sqlite_stat1')).toBe(true);
    expect(ALLOWED_EXTRA.has('table sqlite_stat1')).toBe(true);
    expect(schemaDifferences(db, TEST_MIGRATIONS)).toEqual([]);
  });

  it('a version this server does not know is ENEWER; a stray object on a v0 file is ECHANGED', () => {
    const dir = tempDir();
    const p = join(dir, 'x.db');
    makeDb(p, 2, 'PRAGMA user_version = 3');
    const db = track(protectConnection(new DatabaseSync(p, { readOnly: true })));
    expect(() => schemaDifferences(db, TEST_MIGRATIONS)).toThrow(expect.objectContaining({ code: 'ENEWER' }));
    const q = join(dir, 'y.db');
    const d0 = new DatabaseSync(q);
    d0.exec('CREATE TABLE someone_elses (x)');
    d0.close();
    const db2 = track(protectConnection(new DatabaseSync(q, { readOnly: true })));
    expect(schemaDifferences(db2, TEST_MIGRATIONS)).toEqual(['extra table someone_elses']);
  });
});

describe('checkUntrustedDb', () => {
  it('accepts a clean file (read-only: the file is not modified) and says whether it will migrate', () => {
    const dir = tempDir();
    const p = join(dir, 'clean.db');
    makeDb(p, 1, "INSERT INTO people (id, name, name_lower) VALUES ('p1', 'NovaPilot', 'novapilot')");
    const before = readFileSync(p);
    const mtime = statSync(p).mtimeMs;
    expect(checkUntrustedDb(p, { migrations: TEST_MIGRATIONS })).toEqual({ version: 1, needsMigration: true });
    expect(checkUntrustedDb(p, { migrations: TEST_MIGRATIONS, integrity: 'quick' })).toEqual({ version: 1, needsMigration: true });
    expect(readFileSync(p).equals(before)).toBe(true);
    expect(statSync(p).mtimeMs).toBe(mtime);
    const cur = join(dir, 'current.db');
    makeDb(cur, 2);
    expect(checkUntrustedDb(cur, { migrations: TEST_MIGRATIONS, integrity: 'none' })).toEqual({ version: 2, needsMigration: false });
  });

  it('refuses a planted trigger (T-LAN-15 building block), a newer file, a missing file and a non-database', () => {
    const dir = tempDir();
    const planted = join(dir, 'planted.db');
    makeDb(planted, 2, 'CREATE TRIGGER t_evil AFTER INSERT ON lines BEGIN UPDATE people SET note = new.body; END');
    expect(() => checkUntrustedDb(planted, { migrations: TEST_MIGRATIONS }))
      .toThrow(expect.objectContaining({ code: 'ECHANGED', message: expect.stringContaining('extra trigger t_evil') }));
    const newer = join(dir, 'newer.db');
    makeDb(newer, 2, 'PRAGMA user_version = 9');
    expect(() => checkUntrustedDb(newer, { migrations: TEST_MIGRATIONS }))
      .toThrow(expect.objectContaining({ code: 'ENEWER', message: expect.stringMatching(/newer than this server understands/) }));
    expect(() => checkUntrustedDb(join(dir, 'nope.db'), { migrations: TEST_MIGRATIONS })).toThrow(expect.objectContaining({ code: 'EUNREADABLE' }));
    const text = join(dir, 'notes.db');
    writeFileSync(text, 'this is not a database, just some text that is long enough to have a header '.repeat(20));
    expect(() => checkUntrustedDb(text, { migrations: TEST_MIGRATIONS })).toThrow(expect.objectContaining({ code: 'EUNREADABLE' }));
  });

  it('refuses a file that fails its integrity check', () => {
    const dir = tempDir();
    const p = join(dir, 'broken.db');
    const db = new DatabaseSync(p);
    db.exec('PRAGMA page_size = 1024; CREATE TABLE t (x TEXT); CREATE INDEX t_x ON t(x)');
    const ins = db.prepare('INSERT INTO t VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < 400; i++) ins.run(`row ${i} ${'x'.repeat(40)}`);
    db.exec('COMMIT');
    db.close();
    const bytes = readFileSync(p);
    // Scribble over the middle of the file (b-tree pages of the table and its index), keeping the header intact.
    for (let i = 3 * 1024 + 100; i < 3 * 1024 + 900; i++) bytes[i] = 0x5a;
    writeFileSync(p, bytes);
    expect(() => checkUntrustedDb(p, { migrations: ['CREATE TABLE t (x TEXT); CREATE INDEX t_x ON t(x)'] }))
      .toThrow(expect.objectContaining({ code: 'EUNREADABLE' }));
  });

  it('refuses a CHECK or COLLATE planted in an FTS5 shadow table (the pragmas alone would not show it)', () => {
    const dir = tempDir();
    for (const [name, table, edit] of [
      ['check.db', 'lines_fts_docsize', (sql: string) => sql.replace(/\)\s*$/, ', CHECK (id < 3))')],
      ['collate.db', 'lines_fts_config', (sql: string) => sql.replace('k PRIMARY KEY', 'k COLLATE NOCASE PRIMARY KEY')],
    ] as const) {
      const p = join(dir, name);
      makeDb(p, 2);
      const db = new DatabaseSync(p);
      (db as unknown as { enableDefensive(on: boolean): void }).enableDefensive(false);
      const sql = (db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(table) as { sql: string }).sql;
      db.exec('PRAGMA writable_schema = ON');
      db.prepare('UPDATE sqlite_schema SET sql = ? WHERE name = ?').run(edit(sql), table);
      db.exec('PRAGMA writable_schema = OFF');
      db.close();
      expect(() => checkUntrustedDb(p, { migrations: TEST_MIGRATIONS }))
        .toThrow(expect.objectContaining({ code: 'ECHANGED', differences: [`changed table ${table}`] }));
    }
  });

  it("refuses FTS5 settings the migrations didn't make (secure-delete, automerge, pgsz), and compares them per table", () => {
    const dir = tempDir();
    const clean = join(dir, 'clean.db');
    makeDb(clean, 2);
    const db = track(protectConnection(new DatabaseSync(clean, { readOnly: true })));
    expect(ftsConfigSnapshot(db)).toEqual(expectedFtsConfig(TEST_MIGRATIONS, 2));
    expect([...expectedFtsConfig(TEST_MIGRATIONS, 2).keys()]).toEqual(['lines_fts_config']);
    expect(expectedFtsConfig(TEST_MIGRATIONS, 1).size).toBe(0);
    for (const cmd of ["'secure-delete', 1", "'automerge', 40", "'crisismerge', 100", "'pgsz', 64"]) {
      const p = join(dir, `cfg-${cmd.split("'")[1]}.db`);
      makeDb(p, 2, `INSERT INTO lines_fts(lines_fts, rank) VALUES(${cmd})`);
      expect(() => checkUntrustedDb(p, { migrations: TEST_MIGRATIONS }), cmd)
        .toThrow(expect.objectContaining({ code: 'ECHANGED', differences: ['changed fts settings lines_fts_config'] }));
    }
    expect(diffFtsConfig(new Map([['a_config', '[]']]), new Map())).toEqual(['missing fts settings a_config']);
    // The merge knobs the server tunes itself (ModStore.setFtsMerge), within their sane ranges, are not a change (T-PERF-2).
    for (const cmd of ["'automerge', 0", "'automerge', 16", "'crisismerge', 2", "'crisismerge', 64"]) {
      const p = join(dir, `tun-${cmd.replace(/\W+/g, '')}.db`);
      makeDb(p, 2, `INSERT INTO lines_fts(lines_fts, rank) VALUES(${cmd})`);
      expect(() => checkUntrustedDb(p, { migrations: TEST_MIGRATIONS }), cmd).not.toThrow();
    }
  });

  it('lists the tables that never come across from another copy', () => {
    expect(NEVER_IMPORTED_TABLES).toEqual(['host_admins', 'admin_sessions', 'host_setup']);
  });
});

describe('stageUntrustedDb (another copy\'s data folder, -wal included)', () => {
  /**
   * Another install's DB as a crashed or still-running host leaves it: the last commits are only in the -wal (the
   * files are copied while the writer is open, with auto-checkpoints off).
   */
  function walCopy(dir: string, afterBuild: string): string {
    const live = join(dir, 'live');
    mkdirSync(live);
    const w = new DatabaseSync(join(live, 'voidswarm.db'));
    try {
      w.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
      for (const m of TEST_MIGRATIONS) w.exec(m);
      w.exec(`PRAGMA user_version = ${TEST_MIGRATIONS.length}`);
      w.exec(afterBuild);
      const other = join(dir, 'other', 'data');
      mkdirSync(other, { recursive: true });
      copyFileSync(join(live, 'voidswarm.db'), join(other, 'voidswarm.db'));
      copyFileSync(join(live, 'voidswarm.db-wal'), join(other, 'voidswarm.db-wal'));
      return join(other, 'voidswarm.db');
    } finally {
      w.close();
    }
  }

  it('refuses a trigger planted only in the -wal, and deletes the refused snapshot', async () => {
    const dir = tempDir();
    const src = walCopy(dir, 'CREATE TRIGGER t_evil AFTER INSERT ON lines BEGIN DELETE FROM people; END');
    const staged = join(dir, 'data', 'import.staged.db');
    mkdirSync(dirname(staged), { recursive: true });
    await expect(stageUntrustedDb(src, staged, { migrations: TEST_MIGRATIONS }))
      .rejects.toThrow(expect.objectContaining({ code: 'ECHANGED', message: expect.stringContaining('extra trigger t_evil') }));
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${staged}-wal`)).toBe(false);
  });

  it('stages a clean copy with its -wal commits into one checked file; refuses to overwrite a staging file', async () => {
    const dir = tempDir();
    const src = walCopy(dir, "INSERT INTO people (id, name, name_lower) VALUES ('p1', 'NovaPilot', 'novapilot')");
    const staged = join(dir, 'data', 'import.staged.db');
    mkdirSync(dirname(staged), { recursive: true });
    await expect(stageUntrustedDb(src, staged, { migrations: TEST_MIGRATIONS })).resolves.toEqual({ version: 2, needsMigration: false });
    rmSync(`${staged}-wal`, { force: true });
    rmSync(`${staged}-shm`, { force: true });
    const db = track(new DatabaseSync(staged, { readOnly: true }));
    expect(db.prepare('SELECT name FROM people').all()).toEqual([{ name: 'NovaPilot' }]); // the -wal row came across
    await expect(stageUntrustedDb(src, staged, { migrations: TEST_MIGRATIONS })).rejects.toThrow(/already exists/);
    await expect(stageUntrustedDb(join(dir, 'nope.db'), join(dir, 'x.db'), { migrations: TEST_MIGRATIONS }))
      .rejects.toThrow(expect.objectContaining({ code: 'EUNREADABLE' }));
    const text = join(dir, 'notes.db');
    writeFileSync(text, 'not a database '.repeat(100));
    await expect(stageUntrustedDb(text, join(dir, 'y.db'), { migrations: TEST_MIGRATIONS }))
      .rejects.toThrow(expect.objectContaining({ code: 'EUNREADABLE' }));
    expect(existsSync(join(dir, 'y.db'))).toBe(false);
  });

  it('drops the planner statistics from an accepted snapshot (crafted ones would steer the planner)', async () => {
    const dir = tempDir();
    const src = walCopy(dir, "INSERT INTO people (id, name, name_lower) VALUES ('p1', 'NovaPilot', 'novapilot'); ANALYZE; "
      + "DELETE FROM sqlite_stat1; INSERT INTO sqlite_stat1 VALUES ('people', 'people_name', '9000000 1')");
    expect(checkUntrustedDb(src, { migrations: TEST_MIGRATIONS })).toEqual({ version: 2, needsMigration: false }); // allowed extra
    const staged = join(dir, 'data', 'import.staged.db');
    mkdirSync(dirname(staged), { recursive: true });
    await expect(stageUntrustedDb(src, staged, { migrations: TEST_MIGRATIONS })).resolves.toEqual({ version: 2, needsMigration: false });
    const db = track(new DatabaseSync(staged, { readOnly: true }));
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_stat%'").all()).toEqual([]);
    expect(db.prepare('SELECT name FROM people').all()).toEqual([{ name: 'NovaPilot' }]);
    expect(snapshotSchema(db)).toEqual(expectedSchema(TEST_MIGRATIONS, 2)); // exactly the expected schema now
  });

  it('dropPlannerStats: drops only sqlite_stat1 / sqlite_stat4, and writes nothing when there are none', () => {
    const dir = tempDir();
    const p = join(dir, 'x.db');
    makeDb(p, 2, "INSERT INTO people (id, name, name_lower) VALUES ('a', 'A', 'a'); ANALYZE");
    const db = track(openProtectedDb(p));
    expect(PLANNER_STATS_TABLES).toEqual(['sqlite_stat1', 'sqlite_stat4']);
    expect(dropPlannerStats(db)).toEqual(['sqlite_stat1']);
    expect(dropPlannerStats(db)).toEqual([]);
    expect(schemaDifferences(db, TEST_MIGRATIONS)).toEqual([]);
  });

  it('control: checking the main file alone would miss a trigger that lives in the -wal', () => {
    const dir = tempDir();
    const src = walCopy(dir, 'CREATE TRIGGER t_evil AFTER INSERT ON lines BEGIN DELETE FROM people; END');
    const alone = join(dir, 'alone.db');
    copyFileSync(src, alone);
    // Without its -wal the file is still the empty pre-schema snapshot: a different state than the one SQLite reads.
    expect(checkUntrustedDb(alone, { migrations: TEST_MIGRATIONS, integrity: 'none' })).toEqual({ version: 0, needsMigration: true });
    expect(() => checkUntrustedDb(src, { migrations: TEST_MIGRATIONS })).toThrow(expect.objectContaining({ code: 'ECHANGED' }));
  });
});
