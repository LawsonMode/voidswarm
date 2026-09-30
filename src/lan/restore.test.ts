// LAN task B5: restoring a backup (T-BAK-1 "restore / recovery", T-BAK-3 "a deleted student stays deleted";
// docs/LAN-EDITION-proposal.md §6.2–§6.5): the panel's staged restore applied by the launcher, `Restore a backup.cmd`,
// and a backup from another install brought in with its recovery file.
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore, MIGRATIONS, SCHEMA_VERSION } from '../server/auth/store';
import { CHANGED_OUTSIDE, openProtectedDb } from '../server/db/guard';
import {
  appendLedger, asideDbBanner, backupsListReply, createBackup, createRecovery, dbFingerprint, dbLineage, decryptRecovery, deleteAccountRecorded, eraseAccount,
  ledgerPath, listAsideDbs, listBackups, MaintService, nativeLineage, pepperIdOf, pruneAsideDbs, purgeRecorded,
  PREVIOUS_PEPPERS_FILE, readBackupFile, readLastRestore, readLedger, readPendingRestore, readPreviousPeppers, rememberPepper, stageRestore, SWAP_JOURNAL_FILE,
  usernameHash, usernameHashKeyId, writeSwapJournal, type RecoveryContents,
} from '../server/maint';
import { addAccount, addAction, addChat, addReport, count, statfsFree } from '../server/maint/testutil';
import { openFileSecrets, type SecretStore } from '../server/secrets';
import { SettingsService } from '../server/settings';
import { lanPaths } from './paths';
import { acquireLock } from './pipe';
import { applyStagedRestore, recoverInterruptedSwap, restoreBackup, runRestoreTool, STAGING_DIR, UNREADABLE_PREFIX, type ToolIo } from './restore';

const GB = 1024 ** 3;
const roots: string[] = [];
afterEach(() => { while (roots.length) { try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* held */ } } });

interface Install { root: string; data: string; db: string; secrets: SecretStore; settings: SettingsService }

async function install(name = 'Room 136'): Promise<Install> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-restore-'));
  roots.push(root);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const secrets = openFileSecrets(data);
  for (const k of ['backup.key', 'pepper.key', 'pipe.key'] as const) secrets.ensureKey(k);
  const settings = SettingsService.open({ dataDir: data, env: {}, lan: true, secrets, log: () => undefined });
  await settings.apply({ serverName: name });
  const db = path.join(data, 'voidswarm.db');
  new AuthStore(db).close();
  return { root, data, db, secrets, settings };
}

const withDb = <T>(file: string, fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  try { return fn(db); } finally { db.close(); }
};

function hostAdmin(db: DatabaseSync, hash: string): void {
  db.prepare("INSERT OR REPLACE INTO host_admins (id, username, username_lower, pass_hash, created_at) VALUES ('ha1', 'teacher', 'teacher', ?, 1)").run(hash);
  db.prepare("INSERT OR REPLACE INTO admin_sessions (token_hash, principal, created_at, last_seen, last_action, reauth_at, expires_at, via) VALUES (?, 'host', 1, 1, 1, 1, 9e15, 'local')").run(`s-${hash}`);
}

const names = (file: string): string[] => withDb(file, (db) => (db.prepare('SELECT username FROM accounts ORDER BY username').all() as { username: string }[]).map((r) => r.username));

function scripted(answers: (string | null)[]): ToolIo & { out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out, asked,
    write: (l) => { out.push(l); },
    ask: async (q) => { asked.push(q); return answers.length ? answers.shift()! : null; },
  };
}

async function backup(i: Install, reason: 'manual' | 'daily' = 'manual', at?: number): Promise<string> {
  const r = await createBackup({ dataDir: i.data, key: i.secrets.read('backup.key')!, reason, now: at, statfs: statfsFree(50 * GB) });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.file;
}

describe('T-BAK-1: restore', () => {
  it('restores the backup, keeps the CURRENT host admin, clears admin sessions, drops the stale WAL, makes a safety backup first', async () => {
    const i = await install();
    withDb(i.db, (db) => {
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
      addChat(db, { accountId: 'acc-nova', name: 'NovaPilot', original: 'before the backup' });
      hostAdmin(db, 'scrypt$old-password');
    });
    const file = await backup(i);
    // After the backup: a new account (left in the WAL), and the host changed the admin password.
    await i.settings.apply({ serverName: 'Renamed later' });
    const live = new DatabaseSync(i.db);
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    addAccount(live, { id: 'acc-late', username: 'LatePilot' });
    hostAdmin(live, 'scrypt$new-password');
    const wal = fs.readFileSync(`${i.db}-wal`);
    live.close();
    expect(names(i.db)).toEqual(['KeepPilot', 'LatePilot', 'NovaPilot']);
    // A WAL left behind (as after a crash). Replayed onto the restored file it would corrupt it or bring LatePilot back.
    fs.writeFileSync(`${i.db}-wal`, wal);

    const r = await restoreBackup({ dataDir: i.data, backupFile: file, restoreConfig: true, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.safetyBackup).toMatch(/_pre-restore\.vsbak$/);
    expect(r).toMatchObject({ fromOtherInstall: false, schemaFrom: 4, schemaTo: 4, adminsKept: 1, configRestored: true });
    expect(r.message).toMatch(/host admin login is unchanged/);

    expect(names(i.db)).toEqual(['KeepPilot', 'NovaPilot']);
    withDb(i.db, (db) => {
      expect(db.prepare('SELECT pass_hash FROM host_admins').all()).toEqual([{ pass_hash: 'scrypt$new-password' }]);
      expect(count(db, 'SELECT COUNT(*) AS n FROM admin_sessions')).toBe(0);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare("SELECT actor_account_id, actor_name, action FROM mod_actions WHERE action = 'restore'").all()).toEqual([{ actor_account_id: 'cli', actor_name: 'cli', action: 'restore' }]);
    });
    expect(fs.readdirSync(i.data).filter((n) => /replaced|staging|\.part$/.test(n))).toEqual([]);
    // The settings came back from the backup, validated; this install keeps its id.
    const before = i.settings.get().installId;
    i.settings.reload();
    expect(i.settings.get().serverName).toBe('Room 136');
    expect(i.settings.get().installId).toBe(before);
    // The safety backup has what was there just before (the WAL included).
    const safety = listBackups(i.data).find((b) => b.name === r.safetyBackup)!;
    const x = await readBackupFile(safety.file, i.secrets.read('backup.key')!, path.join(i.root, 'check'));
    expect(names(x.files.find((f) => f.name === 'voidswarm.db')!.path)).toEqual(['KeepPilot', 'LatePilot', 'NovaPilot']);
    expect(readLastRestore(i.data)).toMatchObject({ ok: true, safetyBackup: r.safetyBackup });
  });

  it('the panel stages it; the launcher applies it at the next start, once, and reports it', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    const staged = stageRestore(i.data, { backup: path.basename(file), restoreConfig: false, by: 'host:teacher' }, { key: i.secrets.read('backup.key') });
    expect(staged.ok).toBe(true);
    const paths = lanPaths(i.root);
    const lines: string[] = [];
    const notes = await applyStagedRestore({ paths, log: { write: (l) => lines.push(l) } }, { statfs: statfsFree(50 * GB) });
    expect(notes[0]).toMatch(/^Restored the backup from .* \(.*_manual\.vsbak\)\. The data from before the restore is in .*_pre-restore\.vsbak\./);
    expect(readPendingRestore(i.data)).toBeNull();
    expect(names(i.db)).toEqual(['NovaPilot']);
    withDb(i.db, (db) => expect(db.prepare("SELECT actor_name FROM mod_actions WHERE action = 'restore'").all()).toEqual([{ actor_name: 'host:teacher' }]));
    expect(await applyStagedRestore({ paths, log: { write: () => undefined } })).toEqual([]);
  });

  it('a staged restore that fails is dropped (never loops), reported, and leaves the data as it was', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    stageRestore(i.data, { backup: path.basename(file), by: 'host:teacher' });
    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file).subarray(0, 200), Buffer.alloc(50)])); // damaged since
    const notes = await applyStagedRestore({ paths: lanPaths(i.root), log: { write: () => undefined } }, { statfs: statfsFree(50 * GB) });
    expect(notes.join(' ')).toMatch(/did not happen/);
    expect(readPendingRestore(i.data)).toBeNull();
    expect(readLastRestore(i.data)).toMatchObject({ ok: false });
    expect(names(i.db)).toEqual(['NovaPilot']);
    expect(fs.existsSync(path.join(i.data, STAGING_DIR))).toBe(false);
  });

  it('refuses a backup whose database was changed outside Voidswarm, or is newer, before changing anything', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const planted = path.join(i.root, 'planted');
    fs.mkdirSync(planted);
    fs.copyFileSync(i.db, path.join(planted, 'voidswarm.db'));
    withDb(path.join(planted, 'voidswarm.db'), (db) => db.exec('CREATE TRIGGER evil AFTER INSERT ON accounts BEGIN DELETE FROM bans; END'));
    const r1 = await createBackup({ dataDir: planted, key: i.secrets.read('backup.key')!, reason: 'manual', ignoreDisk: true });
    if (!r1.ok) throw new Error('backup failed');
    const res = await restoreBackup({ dataDir: i.data, backupFile: r1.file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(res).toMatchObject({ ok: false, code: 'ECHECK' });
    expect(res.ok ? '' : res.message).toContain(CHANGED_OUTSIDE);
    // The data is as it was; only the safety backup, made first (§6.2 step 1), was added.
    expect(names(i.db)).toEqual(['NovaPilot']);
    expect(listBackups(i.data).map((b) => b.cls)).toEqual(['pre-restore']);
    expect(res.ok ? null : res.safetyBackup).toBe(listBackups(i.data)[0]!.name);

    withDb(path.join(planted, 'voidswarm.db'), (db) => { db.exec('DROP TRIGGER evil'); db.exec('PRAGMA user_version = 99'); });
    const r2 = await createBackup({ dataDir: planted, key: i.secrets.read('backup.key')!, reason: 'manual', ignoreDisk: true });
    if (!r2.ok) throw new Error('backup failed');
    const res2 = await restoreBackup({ dataDir: i.data, backupFile: r2.file, by: 'cli' });
    expect(res2.ok ? '' : res2.message).toMatch(/newer version of Voidswarm/);
    expect(names(i.db)).toEqual(['NovaPilot']);
  });

  it('with an unreadable current database: the restore works, first-run setup runs again, the old file is kept aside', async () => {
    const i = await install();
    withDb(i.db, (db) => { addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }); hostAdmin(db, 'scrypt$x'); });
    const file = await backup(i);
    fs.writeFileSync(i.db, 'this is not a database any more'.repeat(200));
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.safetyBackup).toBeNull();
    expect(r.adminsKept).toBe(0);
    expect(r.message).toMatch(/first-run setup/);
    expect(r.notes.join(' ')).toMatch(/could not be read/);
    withDb(i.db, (db) => expect(count(db, 'SELECT COUNT(*) AS n FROM host_admins')).toBe(0)); // never the old password
    expect(names(i.db)).toEqual(['NovaPilot']);
    const asides = (): string[] => fs.readdirSync(i.data).filter((n) => n.startsWith(UNREADABLE_PREFIX)).sort();
    expect(asides()).toHaveLength(1);
    expect(r.notes.join(' ')).toContain(asides()[0]);
    expect(fs.readdirSync(path.join(i.data, asides()[0]!)).some((n) => n.startsWith('voidswarm.db.'))).toBe(true);
    // Another unreadable database restored over later gets a folder of its own: the first one stays (35 days).
    const first = asides()[0]!;
    const firstFiles = fs.readdirSync(path.join(i.data, first));
    fs.writeFileSync(i.db, 'broken again'.repeat(300));
    const r2 = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r2.ok).toBe(true);
    expect(asides()).toHaveLength(2);
    expect(fs.readdirSync(path.join(i.data, first))).toEqual(firstFiles);
  });

  it('refuses when the safety backup cannot be made (low disk), changing nothing', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(1 * GB) });
    expect(r).toMatchObject({ ok: false, code: 'ESAFETY' });
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
  });

  it('an interrupted swap is rolled back at the next start', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-swap-'));
    roots.push(d);
    fs.writeFileSync(path.join(d, 'voidswarm.db.replaced'), 'old');
    fs.writeFileSync(path.join(d, 'voidswarm.db.replaced-wal'), 'old wal');
    expect(recoverInterruptedSwap(d)).toMatch(/interrupted/);
    expect(fs.readFileSync(path.join(d, 'voidswarm.db'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(d, 'voidswarm.db-wal'), 'utf8')).toBe('old wal');
    expect(recoverInterruptedSwap(d)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('a database still held open is not replaced: the swap is rolled back (ESWAP)', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    const held = new DatabaseSync(i.db);
    try {
      const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
      expect(r).toMatchObject({ ok: false, code: 'ESWAP' });
    } finally {
      held.close();
    }
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
    expect(fs.existsSync(`${i.db}.replaced`)).toBe(false);
  });
});

describe('T-BAK-1: Restore a backup.cmd', () => {
  it('lists the backups, asks for a number and a confirmation, and restores', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    await backup(i, 'daily', Date.now() - 3600_000);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    await backup(i, 'manual');
    const io = scripted(['2', 'n', 'YES']);
    const code = await runRestoreTool([], { io, root: i.root, statfs: statfsFree(50 * GB) });
    expect(code).toBe(0);
    expect(io.out.join('\n')).toMatch(/ 1 .* manual[\s\S]* 2 .* daily/);
    expect(io.asked).toEqual([expect.stringMatching(/Which backup/), expect.stringMatching(/settings/), expect.stringMatching(/YES/)]);
    expect(names(i.db)).toEqual(['NovaPilot']);
  });

  it('cancels on an empty answer or anything but YES, and at end of input', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    for (const answers of [[''], ['1', 'n', 'yes please'], ['1'], [] as string[]]) {
      const io = scripted(answers);
      expect(await runRestoreTool([], { io, root: i.root })).toBe(1);
      expect(io.out.join('\n')).toMatch(/Cancelled: nothing was changed/);
    }
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
    expect(await runRestoreTool(['--bogus'], { io: scripted([]), root: i.root })).toBe(4);
  });

  it('refuses while the host runs (it holds the lock)', async () => {
    const i = await install();
    await backup(i);
    const host = await acquireLock({ dataDir: i.data, key: null, handlers: { panelUrl: () => 'http://localhost:7778/' }, unref: true });
    expect(host.ok).toBe(true);
    try {
      const io = scripted(['1', 'n', 'YES']);
      expect(await runRestoreTool([], { io, root: i.root })).toBe(1);
      expect(io.out.join('\n')).toMatch(/Stop the host first/);
      expect(io.asked).toEqual([]);
    } finally {
      if (host.ok) await host.lock.close();
    }
  });
});

describe('T-BAK-1: moving to another PC (a backup plus the recovery file)', () => {
  it('another install\'s backup needs its recovery file; with it, the data and its pepper come across', async () => {
    const a = await install('Room 136');
    withDb(a.db, (db) => { addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }); hostAdmin(db, 'scrypt$old-pc'); });
    await a.secrets.write('smtp.secret', 'smtp-test-secret-55');
    const file = await backup(a);
    const rec = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: a.settings.get().installId, crypto: { log2N: 12 } });
    const recFile = path.join(a.root, rec.fileName);
    fs.writeFileSync(recFile, rec.bytes);

    const b = await install('New PC');
    withDb(b.db, (db) => hostAdmin(db, 'scrypt$new-pc'));
    const bKey = b.secrets.read('backup.key')!;
    // Without the recovery file: refused, with the way to do it.
    const r0 = await restoreBackup({ dataDir: b.data, backupFile: file, by: 'cli' });
    expect(r0).toMatchObject({ ok: false, code: 'EKEY', message: expect.stringContaining('--recovery') });
    // With the wrong recovery file: refused.
    const wrong = await createRecovery({ secrets: b.secrets, serverName: 'New PC', installId: '', crypto: { log2N: 12 } });
    const r1 = await restoreBackup({ dataDir: b.data, backupFile: file, by: 'cli', recovery: await decryptRecovery(wrong.bytes, wrong.words!) });
    expect(r1).toMatchObject({ ok: false, code: 'EKEY', message: expect.stringContaining('belongs to another copy') });

    // The tool with --recovery: the passphrase is asked (hidden), the backup given by path.
    const io = scripted([rec.words!.toUpperCase(), 'y']);
    const code = await runRestoreTool(['--recovery', recFile, '--backup', file], { io, root: b.root, statfs: statfsFree(50 * GB) });
    const out = io.out.join('\n');
    expect(code, out).toBe(1); // no YES given: it asked and cancelled
    const io2 = scripted([rec.words!, 'y', 'YES']);
    expect(await runRestoreTool(['--recovery', recFile, '--backup', file], { io: io2, root: b.root, statfs: statfsFree(50 * GB) })).toBe(0);
    expect(io2.out.join('\n')).toMatch(/from another copy of Voidswarm/);
    expect(io2.out.join('\n')).toMatch(/create a new recovery file/);

    expect(names(b.db)).toEqual(['NovaPilot']);
    const bs = openFileSecrets(b.data);
    expect(bs.read('pepper.key')!.equals(a.secrets.read('pepper.key')!)).toBe(true);
    expect(bs.readText('smtp.secret')).toBe('smtp-test-secret-55');
    expect(bs.read('backup.key')!.equals(bKey)).toBe(true); // this PC keeps its own backup key
    withDb(b.db, (db) => expect(db.prepare('SELECT pass_hash FROM host_admins').all()).toEqual([{ pass_hash: 'scrypt$new-pc' }]));
    // Settings restored from the other install take its install id (the recovery file's), since it is a move.
    b.settings.reload();
    expect(b.settings.get().serverName).toBe('Room 136');
    expect(b.settings.get().installId).toBe(a.settings.get().installId);
  });
});

describe('T-BAK-3: a deleted student stays deleted after a restore', () => {
  it('re-applies the current ledger plus the backup\'s, idempotently, and keeps the union', async () => {
    const i = await install();
    // Deleted BEFORE the backup (so the backup's own ledger has it).
    withDb(i.db, (db) => {
      addAccount(db, { id: 'acc-old', username: 'OldPilot' });
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
      addChat(db, { accountId: 'acc-nova', name: 'NovaPilot', original: 'nova said this' });
      addChat(db, { accountId: null, name: 'NovaPilot', original: 'nova as a guest' });
      addChat(db, { accountId: 'acc-keep', name: 'KeepPilot', original: 'keep said this' });
    });
    // As B23's live delete does it: the ledger entry first (keyed hash + the pepper's id), then the same erase.
    const pepper = i.secrets.read('pepper.key')!;
    const eraseAndLog = async (id: string, username: string, ts: number): Promise<void> => {
      const e = { ts, kind: 'account' as const, accountId: id, usernameHash: usernameHash(username, pepper), hashKey: usernameHashKeyId(pepper), records: 'delete' as const, guestEra: true, label: 'Former player #1', by: 'host:teacher' };
      appendLedger(ledgerPath(i.data), e);
      const db = new DatabaseSync(i.db);
      db.exec('PRAGMA foreign_keys = ON');
      try { await eraseAccount(db, { ...e, pepper, at: ts }); } finally { db.close(); }
    };
    await eraseAndLog('acc-old', 'OldPilot', Date.now() - 2000);
    const file = await backup(i);
    // Deleted AFTER the backup: the backup still has her (and her guest-era line from the same PC).
    await eraseAndLog('acc-nova', 'NovaPilot', Date.now() - 1000);
    expect(names(i.db)).toEqual(['KeepPilot']);
    // Pretend the current ledger lost the older line (a hand-edited or older file): the backup's copy restores it.
    fs.writeFileSync(ledgerPath(i.data), fs.readFileSync(ledgerPath(i.data), 'utf8').split('\n').filter((l) => l.includes('acc-nova')).join('\n') + '\n');

    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ledger).toEqual({ entries: 2, changed: 1 });
    expect(r.message).toMatch(/1 deletion\(s\) made since that backup were applied again/);
    expect(names(i.db)).toEqual(['KeepPilot']);
    withDb(i.db, (db) => {
      expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE original LIKE 'nova%'")).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE account_id = 'acc-keep'")).toBe(1);
    });
    expect(readLedger(ledgerPath(i.data)).entries.map((e) => e.accountId)).toEqual(['acc-old', 'acc-nova']);

    // Again: nothing more to do.
    const again = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(again.ok && again.ledger).toEqual({ entries: 2, changed: 1 }); // the backup has her again; she goes again
    expect(names(i.db)).toEqual(['KeepPilot']);
  });
});

// ------------------------------------------------------------------------------------------
// Verifier round 1: leftovers, free space before unpacking, the pepper on an undo
// ------------------------------------------------------------------------------------------

describe('T-BAK-1: restore leftovers, disk and pepper', () => {
  it('a staging folder left by a killed restore (the database in plain text) is removed at the next start', async () => {
    const i = await install();
    const staging = path.join(i.data, STAGING_DIR);
    fs.mkdirSync(staging);
    fs.copyFileSync(i.db, path.join(staging, 'voidswarm.db'));
    const lines: string[] = [];
    expect(await applyStagedRestore({ paths: lanPaths(i.root), log: { write: (l) => lines.push(l) } })).toEqual([]);
    expect(fs.existsSync(staging)).toBe(false);
    expect(lines.join('\n')).toMatch(/leftover data\\restore\.staging/);
  });

  it('checks the free space against the backup before unpacking it: a full drive is EDISK, never "damaged", and nothing changes', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    // Room for the safety backup (the first look at the drive), then the drive fills up before the unpacking.
    let looks = 0;
    const statfs = async (): Promise<{ bavail: number; bsize: number; blocks: number }> => statfsFree(looks++ === 0 ? 50 * GB : 400 * 1024 ** 2)();
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs });
    expect(r).toMatchObject({ ok: false, code: 'EDISK', message: expect.stringMatching(/free on the data drive.*nothing was changed/) });
    expect(r.ok ? '' : r.message).not.toMatch(/damaged|changed, cut short/);
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
    expect(fs.existsSync(path.join(i.data, STAGING_DIR))).toBe(false);
    expect(listBackups(i.data).map((b) => b.cls).sort()).toEqual(['manual', 'pre-restore']);
    // With too little room for the safety backup itself, it is refused before anything else (ESAFETY).
    const r2 = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(400 * 1024 ** 2) });
    expect(r2).toMatchObject({ ok: false, code: 'ESAFETY' });
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
  });

  it('the safety backup comes before the unpacking (§6.2): just above the 2 GB floor, the unpacked copy never pushes it under', async () => {
    // The verifier's round-3 probe: free space = 2 GB + half the database; the drive's free space is a fixed budget
    // minus what is really under data\.
    const i = await install();
    withDb(i.db, (db) => {
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      db.exec('BEGIN');
      for (let n = 0; n < 4000; n++) addChat(db, { accountId: 'acc-nova', name: 'NovaPilot', original: `line ${n} ${'x'.repeat(200)}`, shown: `line ${n}` });
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
    const file = await backup(i);
    const du = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
      const p = path.join(dir, e.name);
      try { return n + (e.isDirectory() ? du(p) : fs.statSync(p).size); } catch { return n; }
    }, 0);
    const dbBytes = fs.statSync(i.db).size;
    const budget = du(i.data) + 2 * GB + Math.ceil(dbBytes * 0.5);
    const statfs = async (): Promise<{ bavail: number; bsize: number; blocks: number }> => {
      const free = budget - du(i.data);
      return { bavail: Math.floor(free / 4096), bsize: 4096, blocks: Math.floor((budget * 2) / 4096) };
    };
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs });
    expect(r.ok ? 'ok' : `${r.code}: ${r.message}`).toBe('ok');
  });

  it('a restore from another PC replaces the pepper and keeps the old one: the undo puts it back, with or without the old recovery file', async () => {
    const a = await install('Room 136');
    withDb(a.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const pa = a.secrets.read('pepper.key')!;
    const fromA = await createBackup({ dataDir: a.data, key: a.secrets.read('backup.key')!, reason: 'manual', pepperId: pepperIdOf(pa), statfs: statfsFree(50 * GB) });
    if (!fromA.ok) throw new Error('backup failed');
    const recA = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: '', crypto: { log2N: 12 } });

    const b = await install('Room 140');
    withDb(b.db, (db) => addAccount(db, { id: 'acc-beta', username: 'BetaPilot' }));
    const pb = b.secrets.read('pepper.key')!;
    const recB = await createRecovery({ secrets: b.secrets, serverName: 'Room 140', installId: '', crypto: { log2N: 12 } });

    const r = await restoreBackup({ dataDir: b.data, backupFile: fromA.file, by: 'cli', recovery: await decryptRecovery(recA.bytes, recA.words!), statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secretsInstalled).toContain('pepper.key');
    expect(openFileSecrets(b.data).read('pepper.key')!.equals(pa)).toBe(true);
    expect(r.notes.join(' ')).toContain(`It is kept in data\\secrets, so restoring ${r.safetyBackup}`);
    expect(readPreviousPeppers(b.secrets.dir).map((p) => pepperIdOf(p))).toEqual([pepperIdOf(pb)]);
    expect(fs.existsSync(path.join(b.data, SWAP_JOURNAL_FILE))).toBe(false); // the swap finished: no journal left
    expect(names(b.db)).toEqual(['NovaPilot']);
    // The safety backup names the pepper it was made with.
    const safety = listBackups(b.data).find((x) => x.name === r.safetyBackup)!;
    const x = await readBackupFile(safety.file, b.secrets.read('backup.key')!, path.join(b.root, 'check'));
    expect(x.manifest.pepperId).toBe(pepperIdOf(pb));

    // Undo without the old recovery file: the data and B's own pepper come back (the kept one).
    const u0 = await restoreBackup({ dataDir: b.data, backupFile: safety.file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(u0.ok).toBe(true);
    expect(u0.ok ? u0.secretsInstalled : []).toEqual(['pepper.key']);
    expect(openFileSecrets(b.data).read('pepper.key')!.equals(pb)).toBe(true);
    expect(names(b.db)).toEqual(['BetaPilot']);

    // With the kept peppers gone (an older data folder): the undo says what is missing, and the old recovery file
    // puts it back.
    const r2 = await restoreBackup({ dataDir: b.data, backupFile: fromA.file, by: 'cli', recovery: await decryptRecovery(recA.bytes, recA.words!), statfs: statfsFree(50 * GB) });
    expect(r2.ok).toBe(true);
    fs.rmSync(path.join(b.secrets.dir!, PREVIOUS_PEPPERS_FILE));
    const safety2 = listBackups(b.data).find((y) => r2.ok && y.name === r2.safetyBackup)!;
    const u1 = await restoreBackup({ dataDir: b.data, backupFile: safety2.file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(u1.ok ? u1.notes.join(' ') : '').toMatch(/pepper this PC does not have/);
    expect(openFileSecrets(b.data).read('pepper.key')!.equals(pa)).toBe(true);
    const u2 = await restoreBackup({ dataDir: b.data, backupFile: safety2.file, by: 'cli', recovery: await decryptRecovery(recB.bytes, recB.words!), statfs: statfsFree(50 * GB) });
    expect(u2.ok).toBe(true);
    expect(u2.ok ? u2.secretsInstalled : []).toEqual(['pepper.key']);
    expect(u2.ok ? u2.fromOtherInstall : true).toBe(false);
    expect(openFileSecrets(b.data).read('pepper.key')!.equals(pb)).toBe(true);
    expect(names(b.db)).toEqual(['BetaPilot']);
  });

  it('a crash after the new pepper was saved but before the database was swapped in: the next start puts the old pepper back', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const mine = i.secrets.read('pepper.key')!;
    const theirs = Buffer.alloc(32, 0x5a);
    // The state restoreBackup leaves just before the swap: the old pepper kept, the journal, the new pepper in.
    const staged = path.join(i.root, 'staged.db');
    withDb(staged, (db) => db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)'));
    expect(rememberPepper(i.secrets.dir, mine)).toBe(true);
    const journal = { v: 1 as const, at: Date.now(), backup: 'x_manual.vsbak', prevPepperId: pepperIdOf(mine), newPepperId: pepperIdOf(theirs), newDb: dbFingerprint(staged)! };
    writeSwapJournal(i.data, journal);
    i.secrets.write('pepper.key', theirs);
    // Next start (the launcher's staged work, the tool, or MaintService.start): the old database stayed.
    expect(recoverInterruptedSwap(i.data)).toMatch(/interrupted before its database was swapped in/);
    expect(openFileSecrets(i.data).read('pepper.key')!.equals(mine)).toBe(true);
    expect(fs.existsSync(path.join(i.data, SWAP_JOURNAL_FILE))).toBe(false);
    expect(recoverInterruptedSwap(i.data)).toBeNull();
    // The crash came after the swap instead: the restored database is in place, so its (new) pepper stays.
    writeSwapJournal(i.data, journal);
    i.secrets.write('pepper.key', theirs);
    fs.copyFileSync(staged, i.db);
    expect(recoverInterruptedSwap(i.data)).toBeNull();
    expect(openFileSecrets(i.data).read('pepper.key')!.equals(theirs)).toBe(true);
    expect(fs.existsSync(path.join(i.data, SWAP_JOURNAL_FILE))).toBe(false);
  });

  it('deletions recorded with a pepper this PC no longer has are said so; the kept peppers match them', async () => {
    const i = await install();
    withDb(i.db, (db) => { addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }); addChat(db, { accountId: null, name: 'NovaPilot', original: 'nova as a guest' }); });
    const file = await backup(i);
    const other = Buffer.alloc(32, 0x33);
    appendLedger(ledgerPath(i.data), {
      ts: Date.now(), kind: 'account', by: 'host:teacher', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot', other), hashKey: usernameHashKeyId(other),
      records: 'delete', guestEra: true, label: 'Former player #1',
    });
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok ? r.notes.join(' ') : '').toMatch(/1 deletion\(s\) in the ledger were recorded with a pepper this PC does not have/);
    expect(names(i.db)).toEqual([]); // the account itself went again
    rememberPepper(i.secrets.dir, other);
    const r2 = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r2.ok ? r2.notes.join(' ') : 'failed').not.toMatch(/recorded with a pepper/);
  });
});

// ------------------------------------------------------------------------------------------
// Build round 2: Update's --rollback restores the pre-update backup without migrating it
// ------------------------------------------------------------------------------------------

describe('T-BAK-1: restore for a rollback (migrate: false)', () => {
  /** A data folder whose database is exactly what schema v3 (0.5.0) left, with one account. */
  function v3Folder(root: string): string {
    const dir = path.join(root, 'v3');
    fs.mkdirSync(dir);
    withDb(path.join(dir, 'voidswarm.db'), (db) => {
      for (let v = 0; v < 3; v++) { db.exec(MIGRATIONS[v]!); db.exec(`PRAGMA user_version = ${v + 1}`); }
      db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at)
                  VALUES ('acc-old', 'OldPilot', 'oldpilot', 'oldpilot@caldwellschools.org', 'oldpilot@caldwellschools.org', 'scrypt$test$x', 1)`).run();
    });
    return dir;
  }

  it('keeps the backup\'s schema when asked; a pre-v4 backup is refused then (deletions could not be re-applied)', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', migrate: false, statfs: statfsFree(50 * GB) });
    expect(r).toMatchObject({ ok: true, schemaFrom: SCHEMA_VERSION, schemaTo: SCHEMA_VERSION });
    expect(names(i.db)).toEqual(['NovaPilot']);

    const old = v3Folder(i.root);
    const b3 = await createBackup({ dataDir: old, key: i.secrets.read('backup.key')!, reason: 'pre-update', detail: '0.6.0', ignoreDisk: true });
    if (!b3.ok) throw new Error('backup failed');
    const refused = await restoreBackup({ dataDir: i.data, backupFile: b3.file, by: 'cli', migrate: false, statfs: statfsFree(50 * GB) });
    expect(refused).toMatchObject({ ok: false, code: 'ECHECK' });
    expect(refused.ok ? '' : refused.message).toMatch(/schema v3.*deleted students back/);
    expect(names(i.db)).toEqual(['NovaPilot']); // unchanged
    // The default (a restore from the panel or the tool) migrates it to this version's schema.
    const migrated = await restoreBackup({ dataDir: i.data, backupFile: b3.file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(migrated).toMatchObject({ ok: true, schemaFrom: 3, schemaTo: SCHEMA_VERSION });
    expect(names(i.db)).toEqual(['OldPilot']);
  });
});

describe('T-BAK-1: a restore made with the tool supersedes one staged in the panel', () => {
  it('the staged restore is cancelled (it would undo this one at the next start), and the notes say so', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const older = await backup(i, 'daily', Date.now() - 3600_000);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    const newer = await backup(i, 'manual');
    const staged = stageRestore(i.data, { backup: path.basename(older), by: 'host:teacher' }, { key: i.secrets.read('backup.key') });
    expect(staged.ok).toBe(true);
    const r = await restoreBackup({ dataDir: i.data, backupFile: newer, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    expect(r.ok ? r.notes.join(' ') : '').toMatch(/staged in the Host Control Panel was cancelled/);
    expect(readPendingRestore(i.data)).toBeNull();
    expect(await applyStagedRestore({ paths: lanPaths(i.root), log: { write: () => undefined } })).toEqual([]);
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
  });
});

// ------------------------------------------------------------------------------------------
// Verifier round 3: a newer version's ledger lines, a fresh unzip, the leftover of a swap cut short
// ------------------------------------------------------------------------------------------

describe('T-BAK-3: ledger lines this version cannot read survive a restore', () => {
  it("keeps a newer version's entries (and extra fields) when the merged ledger is written, and says they were not applied", async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    const lp = ledgerPath(i.data);
    appendLedger(lp, { ts: 5, kind: 'account', by: 'host:teacher', accountId: 'acc-gone', records: 'delete' });
    const newer = JSON.stringify({ ts: 6, kind: 'guest', by: 'host:teacher', nameKeyHash: 'ab'.repeat(32) });
    const extra = JSON.stringify({ ts: 7, kind: 'purge', by: 'host:teacher', before: 3, scope: 'room', roomUid: 'u1' });
    fs.appendFileSync(lp, `${newer}\n${extra}\nnot json at all\n`);
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = fs.readFileSync(lp, 'utf8').trim().split('\n');
    expect(lines).toContain(newer);
    // An entry this version applies keeps the fields it doesn't know (and now names the data it belongs to).
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } });
    expect(parsed.find((o) => o?.ts === 7)).toEqual({ ...JSON.parse(extra) as object, lineage: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(lines).not.toContain('not json at all'); // a torn fragment: its deletion never ran
    expect(readLedger(lp).entries.map((e) => e.kind)).toEqual(['account', 'purge']);
    expect(r.notes.join(' ')).toMatch(/1 line\(s\) of the deletion ledger were written by a newer version/);
    // A second restore keeps them once (no duplicates).
    await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(fs.readFileSync(lp, 'utf8').trim().split('\n').filter((l) => l === newer)).toHaveLength(1);
  });
});

describe('T-BAK-1: Restore a backup.cmd on a fresh unzip (moving to another PC, §6.3)', () => {
  it('makes the data folder, protects data\\secrets before any secret is written, and brings the data across', async () => {
    const a = await install('Room 136');
    withDb(a.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(a);
    const rec = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: '', crypto: { log2N: 12 } });
    const recFile = path.join(a.root, rec.fileName);
    fs.writeFileSync(recFile, rec.bytes);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-restore-fresh-'));
    roots.push(fresh);
    const data = path.join(fresh, 'data');
    // Without --backup there is nothing to bring in: said so, and no folder is made.
    const io0 = scripted([]);
    expect(await runRestoreTool(['--recovery', recFile], { io: io0, root: fresh })).toBe(1);
    expect(io0.out.join('\n')).toMatch(/--backup <file\.vsbak> --recovery <file\.vsrec>/);
    expect(fs.existsSync(data)).toBe(false);
    // Cancelled at the confirmation: the folder made for it goes again.
    const protectedAt: boolean[] = [];
    const protectSecrets = async (d: string): Promise<string[]> => {
      protectedAt.push(fs.existsSync(path.join(d, 'secrets', 'pepper.key')));
      fs.mkdirSync(path.join(d, 'secrets', 'tls'), { recursive: true });
      return [];
    };
    const io1 = scripted([rec.words!, 'n', 'no']);
    expect(await runRestoreTool(['--recovery', recFile, '--backup', file], { io: io1, root: fresh, protectSecrets })).toBe(1);
    expect(fs.existsSync(data)).toBe(false);
    // Confirmed.
    const io2 = scripted([rec.words!, 'n', 'YES']);
    const code = await runRestoreTool(['--recovery', recFile, '--backup', file], { io: io2, root: fresh, protectSecrets, statfs: statfsFree(50 * GB) });
    expect(code, io2.out.join('\n')).toBe(0);
    expect(protectedAt).toEqual([false]); // protected once, before the pepper was written
    expect(names(path.join(data, 'voidswarm.db'))).toEqual(['NovaPilot']);
    expect(openFileSecrets(data).read('pepper.key')!.equals(a.secrets.read('pepper.key')!)).toBe(true);
    withDb(path.join(data, 'voidswarm.db'), (db) => expect(count(db, 'SELECT COUNT(*) AS n FROM host_admins')).toBe(0)); // setup runs
    expect(io2.out.join('\n')).toMatch(/first-run setup/);
  });
});

describe('T-BAK-1: the keys a restore needs go in before the swap', () => {
  it('a failure saving the pepper changes nothing and says so (never "restored" data with the wrong pepper)', async () => {
    // The verifier's attack 3: the secret write failing after the database had already been replaced.
    const a = await install('Room 136');
    withDb(a.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(a);
    const rec = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: '', crypto: { log2N: 12 } });
    const b = await install('New PC');
    withDb(b.db, (db) => addAccount(db, { id: 'acc-beta', username: 'BetaPilot' }));
    const pepperBefore = b.secrets.read('pepper.key')!;
    const failing = new Proxy(b.secrets, {
      get(target, prop) {
        if (prop === 'write') return () => { throw new Error('ENOSPC (test)'); };
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as SecretStore;
    const r = await restoreBackup({ dataDir: b.data, backupFile: file, secrets: failing, recovery: await decryptRecovery(rec.bytes, rec.words!), by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r).toMatchObject({ ok: false, code: 'ESECRET', message: expect.stringMatching(/nothing was changed/) });
    expect(names(b.db)).toEqual(['BetaPilot']);
    expect(b.secrets.read('pepper.key')!.equals(pepperBefore)).toBe(true);
    expect(readLastRestore(b.data)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(b.data, STAGING_DIR))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('a swap that fails after the pepper went in puts the old pepper back', async () => {
    const a = await install('Room 136');
    withDb(a.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(a);
    const rec = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: '', crypto: { log2N: 12 } });
    const b = await install('New PC');
    withDb(b.db, (db) => addAccount(db, { id: 'acc-beta', username: 'BetaPilot' }));
    const pepperBefore = b.secrets.read('pepper.key')!;
    const held = new DatabaseSync(b.db); // Windows won't rename a file that is open
    try {
      const r = await restoreBackup({ dataDir: b.data, backupFile: file, recovery: await decryptRecovery(rec.bytes, rec.words!), by: 'cli', statfs: statfsFree(50 * GB) });
      expect(r).toMatchObject({ ok: false, code: 'ESWAP' });
    } finally {
      held.close();
    }
    expect(openFileSecrets(b.data).read('pepper.key')!.equals(pepperBefore)).toBe(true);
    expect(openFileSecrets(b.data).has('smtp.secret')).toBe(false);
    expect(names(b.db)).toEqual(['BetaPilot']);
  });
});

describe('T-BAK-1: a swap cut short after the new database was in place', () => {
  it('removes the plaintext voidswarm.db.replaced once the pre-restore backup is there; keeps it aside (35 days, banner) otherwise', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    // No safety backup: the leftover is the only copy of that data. It moves into an aside folder (kept 35 days with
    // the banner), out of the way of the next restore's swap, which would otherwise replace it.
    fs.copyFileSync(i.db, `${i.db}.replaced`);
    fs.writeFileSync(`${i.db}.replaced-wal`, 'old wal');
    fs.writeFileSync(`${i.db}.replaced-shm`, Buffer.alloc(1024));
    const note = recoverInterruptedSwap(i.data);
    expect(note).toMatch(/No safety backup .* kept in data\\unreadable-db-\S+ for 35 days/);
    expect(fs.readdirSync(i.data).filter((n) => n.startsWith('voidswarm.db'))).toEqual(['voidswarm.db']);
    const aside = listAsideDbs(i.data);
    expect(aside).toHaveLength(1);
    expect(note).toContain(aside[0]!.name);
    const kept = fs.readdirSync(aside[0]!.dir).sort();
    expect(kept.map((n) => n.replace(/\.[0-9a-f]{4}/, '.<tag>'))).toEqual(['voidswarm.db.<tag>', 'voidswarm.db.<tag>-wal']);
    expect(fs.readFileSync(path.join(aside[0]!.dir, kept[0]!)).equals(fs.readFileSync(i.db))).toBe(true);
    expect(asideDbBanner(aside)).toMatchObject({ code: 'unreadable-db' });
    // A restore after it leaves that folder as it is.
    const file = await backup(i);
    expect((await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) })).ok).toBe(true);
    expect(fs.readdirSync(aside[0]!.dir).sort()).toEqual(kept);
    fs.rmSync(aside[0]!.dir, { recursive: true });
    // A pre-restore backup made after its last change: it goes (with its -wal), at the launcher's next start.
    fs.copyFileSync(i.db, `${i.db}.replaced`);
    fs.writeFileSync(`${i.db}.replaced-wal`, 'old wal');
    fs.utimesSync(`${i.db}.replaced`, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    fs.utimesSync(`${i.db}.replaced-wal`, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const r = await createBackup({ dataDir: i.data, key: i.secrets.read('backup.key')!, reason: 'pre-restore', statfs: statfsFree(50 * GB), retention: false });
    expect(r.ok).toBe(true);
    const notes = await applyStagedRestore({ paths: lanPaths(i.root), log: { write: () => undefined } });
    expect(notes.join(' ')).toMatch(/leftover copy of the database from before it was removed/);
    expect(fs.existsSync(`${i.db}.replaced`)).toBe(false);
    expect(fs.existsSync(`${i.db}.replaced-wal`)).toBe(false);
    expect(names(i.db)).toEqual(['NovaPilot']);
    expect(recoverInterruptedSwap(i.data)).toBeNull();
    // The server path (no launcher) does the same at MaintService.start.
    fs.copyFileSync(i.db, `${i.db}.replaced`);
    fs.utimesSync(`${i.db}.replaced`, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const logs: string[] = [];
    const svc = await MaintService.start({
      dataDir: i.data, secrets: i.secrets, settings: () => ({ backups: { daily: true, copyTo: '', sizeCapMB: 2048 }, serverName: 'x', installId: '' }),
      runner: null, tickMs: 0, statfs: statfsFree(50 * GB), log: (l) => logs.push(l),
    });
    await svc.stop();
    expect(fs.existsSync(`${i.db}.replaced`)).toBe(false);
    expect(logs.join('\n')).toMatch(/leftover copy/);
  });

  it.runIf(process.platform === 'win32')('a kept voidswarm.db.replaced that cannot be moved aside is never replaced by the next swap', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    withDb(i.db, (db) => addAccount(db, { id: 'acc-late', username: 'LatePilot' }));
    fs.copyFileSync(i.db, `${i.db}.replaced`);
    const held = new DatabaseSync(`${i.db}.replaced`); // Windows won't rename a file that is open
    try {
      const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
      expect(r).toMatchObject({ ok: false, code: 'ESWAP', message: expect.stringMatching(/could not be moved aside.*Nothing was changed/) });
    } finally {
      held.close();
    }
    expect(names(`${i.db}.replaced`)).toEqual(['LatePilot', 'NovaPilot']);
    expect(names(i.db)).toEqual(['LatePilot', 'NovaPilot']);
    expect(listAsideDbs(i.data)).toEqual([]);
    // No safety backup of the CURRENT data was made: the next start must never take one for a backup of that file.
    expect(listBackups(i.data).map((b) => b.cls)).toEqual(['manual']);
    // Free again: the next start keeps it aside (35 days), and the restore goes through.
    const r2 = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r2.ok).toBe(true);
    expect(names(i.db)).toEqual(['NovaPilot']);
    expect(fs.existsSync(`${i.db}.replaced`)).toBe(false);
    expect(listAsideDbs(i.data)).toHaveLength(1);
  });
});

describe('T-BAK-1: nothing crafted or stale comes along with a restore (§6.2, §6.5)', () => {
  const plan = (db: DatabaseSync, q: string): string => (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[]).map((x) => x.detail).join(' | ');
  const BAN_LOOKUP = "SELECT * FROM bans WHERE scope = 'account' AND account_id = 'x'";
  const ROOM_LOG = "SELECT * FROM chat_log WHERE room_uid = 'x' ORDER BY id DESC LIMIT 50";
  const plant = (db: DatabaseSync): void => {
    db.exec('ANALYZE');
    db.exec('DELETE FROM sqlite_stat1');
    // Every index on the two tables "useless" (a million rows per key), the tables themselves tiny.
    const ins = db.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
    for (const x of db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN ('chat_log', 'bans') AND sql IS NOT NULL").all() as { name: string; tbl_name: string }[]) {
      ins.run(x.tbl_name, x.name, '1000000 1000000 1000000 1000000');
    }
    ins.run('chat_log', null, '10');
    ins.run('bans', null, '10');
  };
  const stats = (file: string): unknown[] => withDb(file, (db) => db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_stat%'").all());

  it("drops planner statistics planted in another install's backup (and in its own): the look-ups keep their indexes", async () => {
    const a = await install('Room 136');
    withDb(a.db, (db) => { addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }); plant(db); });
    // The planted rows really steer the planner off the indexes (what a restore must not bring in).
    withDb(a.db, (db) => { expect(plan(db, BAN_LOOKUP)).toMatch(/^SCAN/); expect(plan(db, ROOM_LOG)).toMatch(/^SCAN/); });
    const file = await backup(a);
    const rec = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: a.settings.get().installId, crypto: { log2N: 12 } });

    const b = await install('New PC');
    const r = await restoreBackup({ dataDir: b.data, backupFile: file, by: 'cli', recovery: await decryptRecovery(rec.bytes, rec.words!), statfs: statfsFree(50 * GB) });
    expect(r).toMatchObject({ ok: true, fromOtherInstall: true });
    expect(names(b.db)).toEqual(['NovaPilot']);
    expect(stats(b.db)).toEqual([]);
    withDb(b.db, (db) => {
      expect(plan(db, BAN_LOOKUP)).toMatch(/USING (COVERING )?INDEX bans_account/);
      expect(plan(db, ROOM_LOG)).toMatch(/USING (COVERING )?INDEX chat_log_room/);
    });

    // Its own backup too: every backup is treated as untrusted.
    const r2 = await restoreBackup({ dataDir: a.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r2).toMatchObject({ ok: true, fromOtherInstall: false });
    expect(stats(a.db)).toEqual([]);
  });

  it('a -wal or -journal left with no database beside it is never replayed onto the restored one: it is kept aside', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    // A killed server: 50 accounts committed in the WAL, never checkpointed; then voidswarm.db deleted by hand.
    const live = new DatabaseSync(i.db);
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    for (let k = 0; k < 50; k++) addAccount(live, { id: `acc-w${k}`, username: `WalPilot${k}` });
    const wal = fs.readFileSync(`${i.db}-wal`);
    live.close();
    for (const f of [i.db, `${i.db}-wal`, `${i.db}-shm`]) fs.rmSync(f, { force: true });
    fs.writeFileSync(`${i.db}-wal`, wal);
    fs.writeFileSync(`${i.db}-journal`, 'an old rollback journal'.repeat(40));
    fs.writeFileSync(`${i.db}-shm`, Buffer.alloc(32768));

    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.safetyBackup).toBeNull(); // there was no database to back up
    expect(fs.readdirSync(i.data).filter((n) => n.startsWith('voidswarm.db'))).toEqual(['voidswarm.db']);
    expect(names(i.db)).toEqual(['NovaPilot']);
    withDb(i.db, (db) => expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }));
    const asides = listAsideDbs(i.data);
    expect(asides).toHaveLength(1);
    expect(r.notes.join(' ')).toContain(asides[0]!.name);
    const kept = fs.readdirSync(asides[0]!.dir).sort();
    expect(kept).toHaveLength(2);
    // One tag per restore, so the kept files still pair up (voidswarm.db.<tag>-wal, -journal).
    expect(kept.every((n) => /^voidswarm\.db\.[0-9a-f]{4}-(wal|journal)$/.test(n))).toBe(true);
    expect(fs.readFileSync(path.join(asides[0]!.dir, kept.find((n) => n.endsWith('-wal'))!)).equals(wal)).toBe(true);
  });

  it('with no stale file worth keeping, no aside folder is made', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    for (const f of [i.db, `${i.db}-wal`, `${i.db}-shm`]) fs.rmSync(f, { force: true });
    fs.writeFileSync(`${i.db}-wal`, ''); // empty: nothing to keep
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    expect(listAsideDbs(i.data)).toEqual([]);
    expect(fs.readdirSync(i.data).filter((n) => n.startsWith('voidswarm.db'))).toEqual(['voidswarm.db']);
    expect(names(i.db)).toEqual(['NovaPilot']);
  });
});

describe('T-BAK-2: database files a restore kept aside go after 35 days, with a banner until then (§4.13, §8.1)', () => {
  it('MaintService removes the folders past 35 days at start, keeps the younger ones, and banners them', async () => {
    const i = await install();
    withDb(i.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    const file = await backup(i);
    const DAY = 86_400_000;
    const t0 = Date.now();
    // An unreadable database restored over, 36 days ago: its folder is past the 35 days.
    fs.writeFileSync(i.db, 'this is not a database any more'.repeat(200));
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', now: () => t0 - 36 * DAY, statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    // And another, 2 days ago.
    fs.writeFileSync(i.db, 'broken again'.repeat(300));
    expect((await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', now: () => t0 - 2 * DAY, statfs: statfsFree(50 * GB) })).ok).toBe(true);
    // A folder dated later than the clock (a clock that is behind now) is never removed on that guess.
    const future = path.join(i.data, `${UNREADABLE_PREFIX}2099-01-01_0000`);
    fs.mkdirSync(future);
    fs.writeFileSync(path.join(future, 'voidswarm.db.abcd'), 'x');
    const before = listAsideDbs(i.data, t0);
    expect(before).toHaveLength(3);
    expect(asideDbBanner(before, t0)!.text).toMatch(/3 folders .*plain, unencrypted copy.*The oldest is deleted on/);

    const logs: string[] = [];
    const svc = await MaintService.start({
      dataDir: i.data, secrets: i.secrets, settings: () => ({ backups: { daily: true, copyTo: '', sizeCapMB: 2048 }, serverName: 'x', installId: '' }),
      runner: null, tickMs: 0, statfs: statfsFree(50 * GB), log: (l) => logs.push(l), now: () => t0,
    });
    try {
      const left = listAsideDbs(i.data, t0);
      expect(left.map((a) => a.future)).toEqual([false, true]);
      expect(t0 - left[0]!.at).toBeLessThan(3 * DAY);
      expect(logs.join('\n')).toMatch(/removed 1 folder\(s\) of database files a restore had kept aside/);
      const banner = svc.banners().find((b) => b.code === 'unreadable-db');
      expect(banner).toMatchObject({ level: 'warn' });
      expect(banner!.text).toMatch(/2 folders .*The oldest is deleted on/);
      // The list reply gives the same banners from its one listing.
      const [status, body] = backupsListReply(svc);
      expect(status).toBe(200);
      expect((body.banners as { code: string }[]).map((b) => b.code)).toEqual(svc.banners().map((b) => b.code));
    } finally {
      await svc.stop();
    }
    // Once the last dated one is gone too, only the future-dated folder is left, and the banner says it is kept.
    expect(pruneAsideDbs(i.data, t0 + 40 * DAY)).toHaveLength(1);
    expect(asideDbBanner(listAsideDbs(i.data, t0 + 40 * DAY), t0 + 40 * DAY)!.text).toMatch(/dated later than this PC's clock, so it is kept until you delete it/);
  });
});

// ------------------------------------------------------------------------------------------
// Verifier round 2 (fixer): the deletion ledger is scoped to the data it was recorded on; another install's SMTP
// password never replaces this PC's without its settings
// ------------------------------------------------------------------------------------------

describe('T-BAK-3: a ledger entry applies only to the data it was recorded on (its lineage)', () => {
  const DAY = 86_400_000;
  const chatCount = (file: string): number => withDb(file, (db) => count(db, 'SELECT COUNT(*) AS n FROM chat_log'));
  const recoveryOf = async (i: Install): Promise<RecoveryContents> => {
    const rec = await createRecovery({ secrets: i.secrets, serverName: 'x', installId: '', crypto: { log2N: 12 } });
    return decryptRecovery(rec.bytes, rec.words!);
  };
  const lineageOf = (i: Install): string => nativeLineage(i.secrets.read('backup.key')!);

  for (const stamped of [true, false]) {
    it(`moving PCs: the new PC's own test purge never runs on the data brought across (${stamped ? 'stamped' : 'unstamped'} entry)`, async () => {
      const now = Date.now();
      const old = await install('Room 136');
      withDb(old.db, (db) => {
        addAccount(db, { id: 'acc-o1', username: 'NovaPilot' });
        for (let k = 0; k < 25; k++) addChat(db, { accountId: 'acc-o1', name: 'NovaPilot', ts: now - 3 * DAY + k });
      });
      const file = await backup(old);
      const fresh = await install('New PC');
      withDb(fresh.db, (db) => { addAccount(db, { id: 'acc-t1', username: 'TestPilot' }); addChat(db, { accountId: 'acc-t1', name: 'TestPilot', ts: now - 60_000 }); });
      // The host tried the server first and purged the test chat ("everything before now"), as the panel records it.
      const d = openProtectedDb(fresh.db);
      try {
        await purgeRecorded(d, ledgerPath(fresh.data), { before: now, by: 'host:teacher', ts: now }, stamped ? { lineage: lineageOf(fresh) } : {});
      } finally {
        d.close();
      }
      expect(chatCount(fresh.db)).toBe(0);
      const r = await restoreBackup({ dataDir: fresh.data, backupFile: file, recovery: await recoveryOf(old), by: 'cli', now: () => now + 120_000, statfs: statfsFree(50 * GB) });
      expect(r).toMatchObject({ ok: true, fromOtherInstall: true, ledger: { entries: 0, changed: 0 } });
      expect(r.ok ? r.message : '').not.toMatch(/deletion\(s\) made since that backup/);
      expect(chatCount(fresh.db)).toBe(25);
      // The data came with the old PC's lineage (stamped now); the new PC's purge stays on disk with its own.
      withDb(fresh.db, (db) => expect(dbLineage(db)).toBe(lineageOf(old)));
      expect(readLedger(ledgerPath(fresh.data)).entries.map((e) => [e.kind, e.lineage])).toEqual([['purge', lineageOf(fresh)]]);
    });
  }

  it("undoing a restore from another PC never applies that PC's purge here; restoring that PC's data again still does", async () => {
    const now = Date.now();
    const a = await install('Room 136');
    const b = await install('Room 140');
    // A: its own chat, 20 days old (well within its retention).
    withDb(a.db, (db) => {
      addAccount(db, { id: 'acc-a1', username: 'APilot' });
      for (let k = 0; k < 10; k++) addChat(db, { accountId: 'acc-a1', name: 'APilot', ts: now - 20 * DAY + k });
    });
    // B: lines 10 days old and 1 day old, backed up (bk1); then B's host purges everything before 5 days ago, and
    // backs up again (bk2).
    withDb(b.db, (db) => {
      addAccount(db, { id: 'acc-b1', username: 'BPilot' });
      for (let k = 0; k < 5; k++) addChat(db, { accountId: 'acc-b1', name: 'BPilot', ts: now - 10 * DAY + k });
      for (let k = 0; k < 3; k++) addChat(db, { accountId: 'acc-b1', name: 'BPilot', ts: now - DAY + k });
    });
    const bk1 = await backup(b, 'manual', now - 3 * DAY);
    const d = openProtectedDb(b.db);
    try { await purgeRecorded(d, ledgerPath(b.data), { before: now - 5 * DAY, by: 'host:bteacher', ts: now - 2 * DAY }); } finally { d.close(); }
    expect(chatCount(b.db)).toBe(3);
    const bk2 = await backup(b, 'manual', now - DAY);
    const recB = await recoveryOf(b);

    // A restores B's data (bk2), then undoes it with its own pre-restore safety backup.
    const r1 = await restoreBackup({ dataDir: a.data, backupFile: bk2, recovery: recB, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(chatCount(a.db)).toBe(3);
    const safety = listBackups(a.data).find((x) => x.name === r1.safetyBackup)!;
    const r2 = await restoreBackup({ dataDir: a.data, backupFile: safety.file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r2).toMatchObject({ ok: true, ledger: { changed: 0 } });
    expect(chatCount(a.db)).toBe(10); // A's own chat, untouched by B's purge
    expect(names(a.db)).toEqual(['APilot']);
    // The union stays on disk: B's older backup restored here later still gets B's purge (its lines 10 days old).
    const r3 = await restoreBackup({ dataDir: a.data, backupFile: bk1, recovery: recB, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r3).toMatchObject({ ok: true, ledger: { entries: 1, changed: 1 } });
    expect(chatCount(a.db)).toBe(3);
    expect(readLedger(ledgerPath(a.data)).entries.map((e) => e.lineage)).toEqual([lineageOf(b)]);
  });

  it("another PC's deletion of a same-named account never scrubs a live student's audit and report text", async () => {
    const old = await install('Room 136');
    withDb(old.db, (db) => {
      addAccount(db, { id: 'acc-real', username: 'NovaPilot' });
      addAction(db, { action: 'mute', targetId: 'acc-real', targetName: 'NovaPilot', reason: 'NovaPilot spammed the lobby' });
      addReport(db, { reporterName: 'KeepPilot', targetName: 'NovaPilot', targetId: 'acc-real', reason: 'NovaPilot was rude' });
    });
    const file = await backup(old);
    const fresh = await install('New PC');
    withDb(fresh.db, (db) => addAccount(db, { id: 'acc-test', username: 'NovaPilot' }));
    const d = openProtectedDb(fresh.db);
    try {
      await deleteAccountRecorded(d, ledgerPath(fresh.data), { accountId: 'acc-test', username: 'NovaPilot', by: 'host:teacher', ts: Date.now() + 5_000_000 },
        { pepper: fresh.secrets.read('pepper.key'), lineage: lineageOf(fresh) });
    } finally {
      d.close();
    }
    const r = await restoreBackup({ dataDir: fresh.data, backupFile: file, recovery: await recoveryOf(old), by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r).toMatchObject({ ok: true, ledger: { entries: 0, changed: 0 } });
    withDb(fresh.db, (db) => {
      expect(db.prepare("SELECT username FROM accounts WHERE id = 'acc-real'").get()).toEqual({ username: 'NovaPilot' });
      expect(db.prepare("SELECT reason FROM mod_actions WHERE action = 'mute'").get()).toEqual({ reason: 'NovaPilot spammed the lobby' });
      expect(db.prepare('SELECT reason, target_name FROM reports').get()).toEqual({ reason: 'NovaPilot was rude', target_name: 'NovaPilot' });
    });
  });

  /** backup.key lost and made again (the launcher's ensureKey at the next start); the database stays. */
  const loseBackupKey = (i: Install): SecretStore => {
    i.secrets.remove('backup.key');
    const s = openFileSecrets(i.data);
    s.ensureKey('backup.key');
    return s;
  };

  it('backup.key lost and made again: a deletion and a purge made after it still hold when an older backup is restored with the old recovery file', async () => {
    const now = Date.now();
    const i = await install();
    withDb(i.db, (db) => {
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
      for (let k = 0; k < 4; k++) addChat(db, { accountId: 'acc-keep', name: 'KeepPilot', ts: now - 3 * DAY + k });
    });
    const oldLineage = lineageOf(i);
    const rec = await recoveryOf(i);
    // The first backup stamps the data's lineage (createBackup stampLineage): the data keeps it with a new key.
    const file = await backup(i);
    withDb(i.db, (db) => expect(dbLineage(db)).toBe(oldLineage));
    const secrets = loseBackupKey(i);
    const d = openProtectedDb(i.db);
    try {
      await deleteAccountRecorded(d, ledgerPath(i.data), { accountId: 'acc-nova', username: 'NovaPilot', by: 'host:teacher' },
        { pepper: secrets.read('pepper.key'), lineage: nativeLineage(secrets.read('backup.key')!) });
      await purgeRecorded(d, ledgerPath(i.data), { before: now, by: 'host:teacher', ts: now }, { lineage: nativeLineage(secrets.read('backup.key')!) });
    } finally {
      d.close();
    }
    expect(readLedger(ledgerPath(i.data)).entries.map((e) => e.lineage)).toEqual([oldLineage, oldLineage]);
    // Only the old key opens the backup: the install's own (older) recovery file brings it back.
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, secrets, recovery: rec, by: 'cli', now: () => now + 60_000, statfs: statfsFree(50 * GB) });
    expect(r).toMatchObject({ ok: true, fromOtherInstall: true, ledger: { entries: 2, changed: 2 } });
    expect(names(i.db)).toEqual(['KeepPilot']);
    expect(chatCount(i.db)).toBe(0);
  });

  it("a backup whose database was never stamped (the key lost before its first stamp): the account deletion made since still holds; that lineage's purge stays out", async () => {
    const now = Date.now();
    const i = await install();
    withDb(i.db, (db) => {
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
      for (let k = 0; k < 4; k++) addChat(db, { accountId: 'acc-keep', name: 'KeepPilot', ts: now - 3 * DAY + k });
    });
    const rec = await recoveryOf(i);
    const b = await createBackup({ dataDir: i.data, key: i.secrets.read('backup.key')!, reason: 'manual', statfs: statfsFree(50 * GB), stampLineage: false });
    if (!b.ok) throw new Error(JSON.stringify(b));
    withDb(i.db, (db) => expect(dbLineage(db)).toBeNull());
    const secrets = loseBackupKey(i);
    const newLineage = nativeLineage(secrets.read('backup.key')!);
    const d = openProtectedDb(i.db);
    try {
      await deleteAccountRecorded(d, ledgerPath(i.data), { accountId: 'acc-nova', username: 'NovaPilot', by: 'host:teacher' },
        { pepper: secrets.read('pepper.key'), lineage: newLineage });
      await purgeRecorded(d, ledgerPath(i.data), { before: now, by: 'host:teacher', ts: now }, { lineage: newLineage });
    } finally {
      d.close();
    }
    // The same data now has a second lineage: the backup counts as the old key's, the ledger's entries as the new one's.
    expect(readLedger(ledgerPath(i.data)).entries.map((e) => e.lineage)).toEqual([newLineage, newLineage]);
    const r = await restoreBackup({ dataDir: i.data, backupFile: b.file, secrets, recovery: rec, by: 'cli', now: () => now + 60_000, statfs: statfsFree(50 * GB) });
    // The same account id is the same student: she stays deleted (T-BAK-3). The purge can't be told from another
    // copy's (moving PCs), so it stays out.
    expect(r).toMatchObject({ ok: true, ledger: { entries: 1, changed: 1 } });
    expect(names(i.db)).toEqual(['KeepPilot']);
    expect(chatCount(i.db)).toBe(4);
    expect(readLedger(ledgerPath(i.data)).entries).toHaveLength(2); // the union is kept
  });

  it.runIf(process.platform === 'win32')('a deletion ledger that cannot be saved stops the restore before the swap (ELEDGER): nothing changes', async () => {
    const now = Date.now();
    const a = await install('Room 136');
    withDb(a.db, (db) => {
      addAccount(db, { id: 'acc-a', username: 'APilot' });
      for (let k = 0; k < 10; k++) addChat(db, { accountId: 'acc-a', name: 'APilot', ts: now - 20 * DAY + k });
    });
    const file = await backup(a);
    const recA = await recoveryOf(a);
    const b = await install('Room 140');
    withDb(b.db, (db) => addAccount(db, { id: 'acc-b', username: 'BPilot' }));
    // B's own test purge, with no lineage: beside A's data it would be taken for A's.
    appendLedger(ledgerPath(b.data), { ts: now, kind: 'purge', by: 'host:t', before: now });
    const ledgerBefore = fs.readFileSync(ledgerPath(b.data));
    const dbBefore = fs.readFileSync(b.db);
    const pepperBefore = b.secrets.read('pepper.key')!;
    fs.chmodSync(ledgerPath(b.data), 0o444); // read-only (a sync tool, an attribute): the rename over it fails
    try {
      const r = await restoreBackup({ dataDir: b.data, backupFile: file, recovery: recA, by: 'cli', statfs: statfsFree(50 * GB) });
      expect(r).toMatchObject({ ok: false, code: 'ELEDGER', message: expect.stringMatching(/deletions\.jsonl.*nothing was changed/) });
    } finally {
      fs.chmodSync(ledgerPath(b.data), 0o644);
    }
    expect(fs.readFileSync(b.db).equals(dbBefore)).toBe(true);
    expect(fs.readFileSync(ledgerPath(b.data)).equals(ledgerBefore)).toBe(true);
    expect(openFileSecrets(b.data).read('pepper.key')!.equals(pepperBefore)).toBe(true);
    expect(names(b.db)).toEqual(['BPilot']);
    expect(fs.readdirSync(b.data).filter((n) => n.endsWith('.tmp') || n === STAGING_DIR || n.startsWith('voidswarm.db.'))).toEqual([]);
    expect(readLastRestore(b.data)).toMatchObject({ ok: false, message: expect.stringMatching(/did not happen/) });
  });

  it("a deletion made on the moved data after the move still holds when that data's older backup is restored", async () => {
    const old = await install('Room 136');
    withDb(old.db, (db) => { addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }); addAccount(db, { id: 'acc-keep', username: 'KeepPilot' }); });
    const bk1 = await backup(old);
    const fresh = await install('New PC');
    const recOld = await recoveryOf(old);
    expect((await restoreBackup({ dataDir: fresh.data, backupFile: bk1, recovery: recOld, by: 'cli', statfs: statfsFree(50 * GB) })).ok).toBe(true);
    // On the new PC, NovaPilot is deleted: the entry carries the moved data's lineage (the database now names it).
    const d = openProtectedDb(fresh.db);
    try {
      await deleteAccountRecorded(d, ledgerPath(fresh.data), { accountId: 'acc-nova', username: 'NovaPilot', by: 'host:teacher' },
        { pepper: fresh.secrets.read('pepper.key'), lineage: lineageOf(fresh) });
    } finally {
      d.close();
    }
    expect(readLedger(ledgerPath(fresh.data)).entries.map((e) => e.lineage)).toEqual([lineageOf(old)]);
    // The old PC's backup (from before the deletion) restored again: she stays deleted.
    const r = await restoreBackup({ dataDir: fresh.data, backupFile: bk1, recovery: recOld, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r).toMatchObject({ ok: true, ledger: { entries: 1, changed: 1 } });
    expect(names(fresh.db)).toEqual(['KeepPilot']);
  });
});

describe("T-BAK-1: another install's SMTP password comes only with its settings", () => {
  it("keeps this PC's own password unless the settings are restored too; puts it back if they then aren't", async () => {
    const a = await install('Room 136');
    withDb(a.db, (db) => addAccount(db, { id: 'acc-nova', username: 'NovaPilot' }));
    a.secrets.write('smtp.secret', 'a-smtp-test-secret');
    const file = await backup(a);
    const made = await createRecovery({ secrets: a.secrets, serverName: 'Room 136', installId: a.settings.get().installId, crypto: { log2N: 12 } });
    const recA = await decryptRecovery(made.bytes, made.words!);
    const b = await install('New PC');
    b.secrets.write('smtp.secret', 'b-own-test-secret');
    const smtp = (): string | null => openFileSecrets(b.data).readText('smtp.secret');

    // Without --settings: this PC's mail settings stay, and so does its password.
    const r1 = await restoreBackup({ dataDir: b.data, backupFile: file, recovery: recA, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r1).toMatchObject({ ok: true, configRestored: false });
    expect(r1.ok ? r1.secretsInstalled : []).not.toContain('smtp.secret');
    expect(r1.ok ? r1.notes.join(' ') : '').toMatch(/SMTP password in the recovery file was not installed/);
    expect(smtp()).toBe('b-own-test-secret');

    // The settings asked for, but they can't be restored: this PC's own password goes back.
    const refusing = { get: () => ({ installId: '' }), restore: async () => ({ ok: false, status: 400, error: 'test refusal' }) } as unknown as SettingsService;
    const r2 = await restoreBackup({ dataDir: b.data, backupFile: file, recovery: recA, restoreConfig: true, settings: refusing, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r2).toMatchObject({ ok: true, configRestored: false });
    expect(r2.ok ? r2.secretsInstalled : []).not.toContain('smtp.secret');
    expect(r2.ok ? r2.notes.join(' ') : '').toMatch(/was not kept: the settings did not come with it/);
    expect(smtp()).toBe('b-own-test-secret');

    // With the settings: both come across.
    const r3 = await restoreBackup({ dataDir: b.data, backupFile: file, recovery: recA, restoreConfig: true, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r3).toMatchObject({ ok: true, configRestored: true });
    expect(r3.ok ? r3.secretsInstalled : []).toContain('smtp.secret');
    expect(smtp()).toBe('a-smtp-test-secret');

    // A PC with no password of its own takes it even without the settings (nothing of its own is lost).
    const c = await install('Third PC');
    const r4 = await restoreBackup({ dataDir: c.data, backupFile: file, recovery: recA, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r4.ok ? r4.secretsInstalled : []).toContain('smtp.secret');
    expect(openFileSecrets(c.data).readText('smtp.secret')).toBe('a-smtp-test-secret');
  });

  it("the safety backup's manifest names this install (installId)", async () => {
    const i = await install();
    const file = await backup(i);
    const r = await restoreBackup({ dataDir: i.data, backupFile: file, by: 'cli', statfs: statfsFree(50 * GB) });
    expect(r.ok).toBe(true);
    const safety = listBackups(i.data).find((x) => r.ok && x.name === r.safetyBackup)!;
    const x = await readBackupFile(safety.file, i.secrets.read('backup.key')!, path.join(i.root, 'check-id'));
    expect(x.manifest.installId).toBe(i.settings.get().installId);
    expect(x.manifest.installId).not.toBe('');
  });
});
