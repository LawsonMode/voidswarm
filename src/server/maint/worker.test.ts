// LAN task B5: the maintenance worker skeleton (§5.16 "The DB worker"): protocol, streams with backpressure,
// cancellation, the write queue, crash restart; backups made in the worker (T-BAK-1); MaintService's start backup,
// quiet-window scheduling, panel replies and banners (T-BAK-1, T-BAK-4).
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { memorySecrets } from '../secrets';
import { auditActorOf, backupsCreateReply, backupsListReply, backupsRestoreReply, dbCompactReply, maintActorOf, maintAdminHandlers, recoveryCreateReply } from './api';
import { createBackup, listBackups } from './backups';
import { MaintClient } from './client';
import { DB_LARGE_BYTES, dbFileBytes, dbSizeBanner } from './disk';
import { markIndexDirty, usernameHash, usernameHashKeyId } from './erase';
import { readBackupFile } from './format';
import { dbLineage, nativeLineage } from './ledger';
import { MaintError } from './protocol';
import { decryptRecovery } from './recovery';
import { rememberPepper } from './peppers';
import { readPendingRestore } from './restoreStage';
import { dailyBoundary, dailyRetryDelay, dueTasks, isOvernight } from './schedule';
import { MaintService, maintSettingsFrom, migrationBackupProblem, type MaintSettingsView } from './service';
import { defaultSettings } from '../settings';
import { addAccount, addAction, addChat, count, GB, key32, open, statfsFree, tmpData, type TmpData } from './testutil';

const DAY = 86_400_000;
const dirs: TmpData[] = [];
const clients: { close(): Promise<void> }[] = [];
const scratch = (): TmpData => { const t = tmpData('vs-worker-'); dirs.push(t); return t; };
afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => undefined);
  while (dirs.length) dirs.pop()!.cleanup();
});

async function client(t: TmpData, key = key32()): Promise<MaintClient> {
  const c = await MaintClient.start({ dataDir: t.dir, backupKey: key, sizeCapMB: 2048, installId: 'abc', appVersion: '0.6.0' });
  clients.push(c);
  return c;
}

describe('the maintenance worker', () => {
  it('starts, lists its ops, answers calls, and reports unknown ops and op failures without dying', async () => {
    const t = scratch();
    const c = await client(t);
    expect(c.ops).toEqual(expect.arrayContaining(['ping', 'backup.create', 'backup.list', 'db.stats', 'fts.optimize', 'db.compact', 'ledger.apply', 'diag.range']));
    await expect(c.call('ping')).resolves.toMatchObject({ pong: true });
    await expect(c.call('nope.nothing')).rejects.toMatchObject({ code: 'EOP' });
    await expect(c.call('backup.create', { reason: 'not-a-reason' })).rejects.toMatchObject({ code: 'EARGS' });
    await expect(c.call('diag.range')).rejects.toMatchObject({ code: 'EOP' }); // a stream, not a call
    const st = await c.call<{ userVersion: number; chatRows: number; indexTidyPending: boolean }>('db.stats');
    expect(st).toMatchObject({ userVersion: 4, chatRows: 0, indexTidyPending: false });
    await expect(c.call('db.integrity')).resolves.toMatchObject({ ok: true });
  });

  it('makes an encrypted backup off the game thread', async () => {
    const t = scratch();
    const db = open(t.db);
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    for (let i = 0; i < 100; i++) addChat(db, { accountId: 'acc-nova', name: 'NovaPilot' });
    const key = key32();
    const c = await client(t, key);
    const progress: unknown[] = [];
    // The game connection keeps writing while the worker copies.
    const r = await c.call<{ ok: boolean; name: string; file: string }>('backup.create', { reason: 'manual', ignoreDisk: true }, { onProgress: (p) => progress.push(p) });
    for (let i = 0; i < 5; i++) addChat(db, { accountId: 'acc-nova', name: 'NovaPilot' });
    db.close();
    expect(r.ok).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    const x = await readBackupFile(r.file, key, path.join(t.dir, 'o'));
    expect(x.manifest).toMatchObject({ reason: 'manual', installId: 'abc', appVersion: '0.6.0' });
    await expect(c.call('backup.list')).resolves.toHaveLength(1);
    // Without a key the worker refuses rather than writing something unencrypted.
    c.setConfig({ backupKey: null });
    await expect(c.call('backup.create', { reason: 'manual', ignoreDisk: true })).resolves.toMatchObject({ ok: false, code: 'ENOKEY' });
  });

  it('streams pages with backpressure; breaking out cancels the op; the worker carries on', async () => {
    const t = scratch();
    const c = await client(t);
    let rows = 0;
    let pages = 0;
    const s = c.stream<{ i: number }>('diag.range', { n: 1050, pageSize: 100 });
    for await (const page of s) { pages++; rows += page.length; }
    expect([pages, rows]).toEqual([11, 1050]);
    await expect(s.result).resolves.toEqual({ sent: 1050 });

    const s2 = c.stream<{ i: number }>('diag.range', { n: 100_000, pageSize: 10 });
    let got = 0;
    for await (const page of s2) { got += page.length; if (got >= 30) break; }
    await expect(s2.result).rejects.toMatchObject({ code: 'ECANCEL' });
    expect(got).toBe(30);
    await expect(c.call('ping')).resolves.toMatchObject({ pong: true });
    await expect((async () => { for await (const _ of c.stream('ping')) { /* not a stream */ } })()).rejects.toMatchObject({ code: 'EOP' });
  });

  it('cancels by AbortSignal, times out, and queues writes one at a time while reads run at once', async () => {
    const t = scratch();
    const c = await client(t);
    const ac = new AbortController();
    const p = c.call('diag.sleep', { ms: 10_000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ code: 'ECANCEL' });
    expect(Date.now() - t0).toBeLessThan(3000);
    await expect(c.call('diag.sleep', { ms: 5000 }, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'ETIMEOUT' });

    const a = c.call<{ at: number }>('diag.sleepQueued', { ms: 300 });
    const b = c.call<{ at: number }>('diag.sleepQueued', { ms: 300 });
    const pingAt = await c.call('ping').then(() => Date.now());
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.at - ra.at).toBeGreaterThanOrEqual(250);
    expect(pingAt).toBeLessThan(ra.at);
  });

  it('a worker that dies fails its pending calls with EWORKER (never hangs) and is restarted', async () => {
    const t = scratch();
    const logs: string[] = [];
    const c = await MaintClient.start({ dataDir: t.dir, backupKey: key32(), log: (l) => logs.push(l) });
    clients.push(c);
    const pending = c.call('diag.sleep', { ms: 10_000 });
    await c.thread!.terminate();
    await expect(pending).rejects.toBeInstanceOf(MaintError);
    await expect(pending).rejects.toMatchObject({ code: 'EWORKER' });
    // It comes back.
    for (let i = 0; i < 100 && !c.ready; i++) await new Promise((r) => setTimeout(r, 50));
    await expect(c.call('ping')).resolves.toMatchObject({ pong: true });
    expect(logs.join('\n')).toMatch(/restarting/);
  });

  it('runs the index tidy (FTS optimize) and the ledger re-apply', async () => {
    const t = scratch();
    const db = open(t.db);
    markIndexDirty(db, 12);
    db.close();
    const c = await client(t);
    await expect(c.call('db.stats')).resolves.toMatchObject({ indexTidyPending: true, indexDirtyRows: 12 });
    await expect(c.call('fts.optimize')).resolves.toMatchObject({ tidied: 12 });
    await expect(c.call('db.stats')).resolves.toMatchObject({ indexTidyPending: false });
    fs.writeFileSync(path.join(t.dir, 'deletions.jsonl'), `${JSON.stringify({ ts: 1, kind: 'purge', before: Date.now(), by: 'cli' })}\nbad\n`);
    await expect(c.call('ledger.apply')).resolves.toMatchObject({ entries: 1, badLines: 1 });
    await expect(c.call('db.compact')).resolves.toMatchObject({ afterBytes: expect.any(Number) });
  });

  it("ledger.apply: only the live data's entries, and the peppers a restore replaced match too", async () => {
    const t = scratch();
    const key = key32();
    const oldPepper = key32();
    const db = open(t.db);
    addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
    addAction(db, { action: 'mute', targetName: 'NovaPilot', reason: 'NovaPilot spammed the lobby' });
    addChat(db, { accountId: 'acc-keep', name: 'KeepPilot', ts: 1000 });
    db.close();
    const ours = nativeLineage(key);
    const now = Date.now();
    const lines = [
      // NovaPilot, deleted on this data under a pepper a restore has replaced since (kept in pepper.previous.json).
      { ts: now, kind: 'account', by: 'host:teacher', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot', oldPepper), hashKey: usernameHashKeyId(oldPepper), records: 'delete', label: 'Former player #1', lineage: ours },
      // Another copy's purge of its own old chat: never applied to this data.
      { ts: now, kind: 'purge', by: 'host:other', before: 2000, lineage: 'abcdefabcdef' },
    ];
    fs.writeFileSync(path.join(t.dir, 'deletions.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const c1 = await MaintClient.start({ dataDir: t.dir, backupKey: key, pepper: key32() });
    clients.push(c1);
    await expect(c1.call('ledger.apply')).resolves.toMatchObject({ entries: 1, otherData: 1, unmatchedHashKeys: 1, lineage: ours });
    await c1.close();
    const c2 = await MaintClient.start({ dataDir: t.dir, backupKey: key, pepper: key32(), previousPeppers: [oldPepper] });
    clients.push(c2);
    await expect(c2.call('ledger.apply')).resolves.toMatchObject({ entries: 1, otherData: 1, unmatchedHashKeys: 0 });
    await c2.close();
    const after = open(t.db);
    try {
      expect(after.prepare("SELECT reason FROM mod_actions WHERE action = 'mute'").get()).toEqual({ reason: 'Former player #1 spammed the lobby' });
      expect(count(after, 'SELECT COUNT(*) AS n FROM chat_log')).toBe(1); // the other copy's purge did not run
      expect(dbLineage(after)).toBe(ours); // stamped: the data names its lineage from now on
    } finally {
      after.close();
    }
  });

  it("ledger.apply: another data's account deletion holds when its account is here (the same random id), and only then", async () => {
    const t = scratch();
    const key = key32();
    const db = open(t.db);
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
    addChat(db, { accountId: 'acc-keep', name: 'KeepPilot', ts: 1000 });
    db.close();
    const now = Date.now();
    const other = 'abcdefabcdef';
    const lines = [
      { ts: now, kind: 'account', by: 'host:teacher', accountId: 'acc-nova', records: 'delete', lineage: other },
      { ts: now, kind: 'account', by: 'host:teacher', accountId: 'acc-elsewhere', records: 'delete', lineage: other },
      { ts: now, kind: 'purge', by: 'host:other', before: 2000, lineage: other },
    ];
    fs.writeFileSync(path.join(t.dir, 'deletions.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const c = await MaintClient.start({ dataDir: t.dir, backupKey: key, pepper: key32() });
    clients.push(c);
    await expect(c.call('ledger.apply')).resolves.toMatchObject({ entries: 1, changed: 1, crossData: 1, otherData: 2, lineage: nativeLineage(key) });
    await c.close();
    const after = open(t.db);
    try {
      expect((after.prepare('SELECT username FROM accounts ORDER BY username').all() as { username: string }[]).map((r) => r.username)).toEqual(['KeepPilot']);
      expect(count(after, 'SELECT COUNT(*) AS n FROM chat_log')).toBe(1); // that data's purge stays out
    } finally {
      after.close();
    }
  });

  it('MaintService hands the worker the peppers a restore replaced (data\\secrets\\pepper.previous.json)', async () => {
    const t = scratch();
    const secretsDir = path.join(t.dir, 'secrets');
    fs.mkdirSync(secretsDir);
    const oldPepper = key32();
    rememberPepper(secretsDir, oldPepper);
    const base = memorySecrets({ 'backup.key': key32(), 'pepper.key': key32() });
    const secrets = { read: base.read.bind(base), readText: base.readText.bind(base), dir: secretsDir };
    const svc = await MaintService.start({ dataDir: t.dir, secrets, settings: settings(), tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    const db = open(t.db);
    addAction(db, { action: 'mute', targetName: 'NovaPilot', reason: 'NovaPilot spammed the lobby' });
    db.close();
    fs.writeFileSync(path.join(t.dir, 'deletions.jsonl'), `${JSON.stringify({
      ts: Date.now(), kind: 'account', by: 'host:teacher', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot', oldPepper),
      hashKey: usernameHashKeyId(oldPepper), records: 'delete', label: 'Former player #2',
    })}\n`);
    const runner = (svc as unknown as { runner: MaintClient }).runner;
    await expect(runner.call('ledger.apply')).resolves.toMatchObject({ entries: 1, unmatchedHashKeys: 0 });
  });
});

// ------------------------------------------------------------------------------------------
// The scheduler
// ------------------------------------------------------------------------------------------

describe('quiet windows (schedule.ts)', () => {
  const at = (d: number, h: number, m = 0): number => new Date(2026, 8, d, h, m).getTime();
  const base = { startedAt: at(20, 8), dailyEnabled: true, lastDailyAt: at(28, 3, 30), connections: 0, lastBusyAt: null, indexDirty: false, lastDiskAt: at(28, 11, 30) };
  const due = (o: Partial<Parameters<typeof dueTasks>[0]> & { now: number }): string[] => dueTasks({ ...base, lastDiskAt: o.now, ...o });

  it('daily backup: the first quiet moment after 02:00, or after 24 h of uptime even when busy', () => {
    expect(dailyBoundary(at(28, 1, 59))).toBe(at(27, 2));
    expect(dailyBoundary(at(28, 2, 0))).toBe(at(28, 2));
    expect(dueTasks({ ...base, now: at(28, 12) })).toEqual([]);
    // Next day after 02:00: due once nobody has been on for 10 minutes.
    expect(due({ now: at(29, 3), connections: 3, lastBusyAt: at(29, 3) })).toEqual([]);
    expect(due({ now: at(29, 3), connections: 0, lastBusyAt: at(29, 2, 55) })).toEqual([]);
    expect(due({ now: at(29, 3), connections: 0, lastBusyAt: at(29, 2, 49) })).toEqual(['daily-backup']);
    // Busy all the time: after 24 h anyway.
    expect(due({ now: at(29, 3, 20), connections: 5, lastBusyAt: at(29, 3, 20) })).toEqual([]);
    expect(due({ now: at(29, 3, 31), connections: 5, lastBusyAt: at(29, 3, 31) })).toEqual(['daily-backup']);
    // A server that just started (nobody on yet) waits 10 minutes too.
    expect(due({ now: at(29, 8, 5), startedAt: at(29, 8), lastDailyAt: null })).toEqual([]);
    expect(due({ now: at(29, 8, 11), startedAt: at(29, 8), lastDailyAt: null })).toEqual(['daily-backup']);
    expect(due({ now: at(29, 3), dailyEnabled: false })).toEqual([]);
  });

  it('the FTS optimize only overnight with nobody on for 10 minutes; the disk hourly', () => {
    expect(isOvernight(at(28, 23))).toBe(true);
    expect(isOvernight(at(28, 5, 59))).toBe(true);
    expect(isOvernight(at(28, 6))).toBe(false);
    const dirty = { ...base, indexDirty: true, lastBusyAt: at(28, 22) };
    expect(dueTasks({ ...dirty, now: at(28, 21) })).not.toContain('optimize');
    expect(dueTasks({ ...dirty, now: at(28, 22, 5) })).not.toContain('optimize');
    expect(dueTasks({ ...dirty, now: at(28, 22, 11) })).toContain('optimize');
    expect(dueTasks({ ...base, now: at(28, 12, 31) })).toEqual(['disk']);
    expect(dueTasks({ ...base, now: at(28, 12, 29) })).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// MaintService
// ------------------------------------------------------------------------------------------

function settings(over: Partial<MaintSettingsView['backups']> = {}): () => MaintSettingsView {
  return () => ({ backups: { daily: true, copyTo: '', sizeCapMB: 2048, ...over }, serverName: 'Room 136', installId: '00ff', termEnd: null });
}

describe('MaintService', () => {
  it('start backup before the migration; then none within 6 h; "pre-migration" when one is pending', async () => {
    const t = scratch();
    const secrets = memorySecrets({ 'backup.key': key32(), 'pepper.key': key32() });
    let now = new Date(2026, 8, 28, 7, 0).getTime();
    const audit: string[] = [];
    const svc = await MaintService.start({ dataDir: t.dir, secrets, settings: settings(), now: () => now, runner: null, tickMs: 0, audit: (e) => audit.push(`${e.action}:${e.reason}`) });
    clients.push({ close: () => svc.stop() });
    const r1 = await svc.startupBackup();
    expect(r1).toMatchObject({ ok: true, name: '2026-09-28_0700_start.vsbak' });
    now += 3600_000;
    expect(await svc.startupBackup()).toBeNull();
    const r3 = await svc.startupBackup({ migration: { from: 3, to: 4 } });
    expect(r3).toMatchObject({ ok: true, name: '2026-09-28_0800_pre-migration-v3.vsbak' });
    expect(audit).toEqual(['backup:start: 2026-09-28_0700_start.vsbak', 'backup:pre-migration: 2026-09-28_0800_pre-migration-v3.vsbak']);
  });

  it('T-BAK-4: low disk skips the backup with a banner; the hourly check clears it when space is back', async () => {
    const t = scratch();
    const secrets = memorySecrets({ 'backup.key': key32() });
    let free = 1.5 * GB;
    let now = new Date(2026, 8, 28, 12, 0).getTime();
    const svc = await MaintService.start({
      dataDir: t.dir, secrets, settings: settings(), now: () => now, runner: null, tickMs: 0,
      statfs: async () => (await statfsFree(free)()),
    });
    clients.push({ close: () => svc.stop() });
    expect(svc.banners().map((b) => b.code)).toEqual(expect.arrayContaining(['disk-low']));
    const r = await svc.backupNow();
    expect(r).toMatchObject({ ok: false, skipped: 'disk' });
    expect(listBackups(t.dir)).toEqual([]);
    const [status, body] = await backupsCreateReply(svc, {}, 'host:teacher');
    expect(status).toBe(507);
    expect(body.error).toMatch(/2 GB/);
    free = 300 * 1024 * 1024;
    now += 61 * 60_000;
    await svc.tick();
    expect(svc.banners().find((b) => b.code === 'disk-critical')).toMatchObject({ level: 'urgent', text: expect.stringContaining('chat may stop being logged') });
    free = 40 * GB;
    now += 61 * 60_000;
    await svc.tick();
    expect(svc.banners().map((b) => b.code)).not.toEqual(expect.arrayContaining(['disk-low']));
    expect(svc.banners().map((b) => b.code)).not.toEqual(expect.arrayContaining(['disk-critical']));
    expect((await svc.backupNow()).ok).toBe(true);
    expect(svc.banners().map((b) => b.code)).not.toContain('backup-skipped');
  });

  it('the daily backup runs in the worker at the first quiet moment after 02:00 (weekly first), and tells the launcher', async () => {
    const t = scratch();
    const secrets = memorySecrets({ 'backup.key': key32() });
    let now = new Date(2026, 8, 28, 1, 0).getTime();
    let online = 2;
    const copied: string[] = [];
    const svc = await MaintService.start({
      dataDir: t.dir, secrets, settings: settings(), now: () => now, tickMs: 0, connections: () => online,
      onBackup: (b) => copied.push(b.reason), statfs: statfsFree(50 * GB),
    });
    clients.push({ close: () => svc.stop() });
    expect(svc.status().worker.ok).toBe(true);
    expect(await svc.tick()).toEqual([]); // busy, not 02:00 yet (the disk was checked at start)
    now = new Date(2026, 8, 28, 2, 30).getTime();
    expect(await svc.tick()).not.toContain('daily-backup'); // after 02:00 but people are on
    online = 0;
    now += 5 * 60_000;
    expect(await svc.tick()).not.toContain('daily-backup'); // quiet for 5 minutes only
    now += 6 * 60_000;
    expect(await svc.tick()).toContain('daily-backup');
    expect(listBackups(t.dir).map((b) => b.cls)).toEqual(['weekly']);
    now += 3600_000;
    expect(await svc.tick()).toEqual(['disk']);
    now = new Date(2026, 8, 29, 3, 0).getTime();
    expect(await svc.tick()).toContain('daily-backup');
    expect(listBackups(t.dir).map((b) => b.cls)).toEqual(['daily', 'weekly']);
    expect(copied).toEqual(['weekly', 'daily']);
  });

  it('panel replies: list, create, restore needs confirm and stages it, recovery returns the words once', async () => {
    const t = scratch();
    const secrets = memorySecrets({ 'backup.key': key32(), 'pepper.key': key32(), 'smtp.secret': 'smtp-test-9' });
    const svc = await MaintService.start({ dataDir: t.dir, secrets, settings: settings(), tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    const [s1, created] = await backupsCreateReply(svc, {}, 'host:teacher');
    expect(s1).toBe(200);
    const name = (created.backup as { name: string }).name;
    const [, list] = backupsListReply(svc);
    expect(list.backups).toEqual([expect.objectContaining({ name, reason: 'manual', encrypted: true, ownKey: true, needsRecovery: false })]);
    expect(JSON.stringify(list)).not.toContain(t.dir.replace(/\\/g, '\\\\'));
    expect((list.banners as { code: string }[]).map((b) => b.code)).toContain('recovery-missing');

    expect(backupsRestoreReply(svc, { backup: name }, 'host:teacher')).toEqual([409, expect.objectContaining({ needsConfirm: true })]);
    expect(backupsRestoreReply(svc, { backup: '..\\voidswarm.db', confirm: true }, 'host:teacher')[0]).toBe(400);
    expect(backupsRestoreReply(svc, { backup: '2020-01-01_0000_start.vsbak', confirm: true }, 'host:teacher')[0]).toBe(404);
    const [s2, staged] = backupsRestoreReply(svc, { backup: name, restoreConfig: true, confirm: true }, 'host:teacher');
    expect(s2).toBe(200);
    expect(staged.message).toMatch(/Stop the host and start it again/);
    expect(readPendingRestore(t.dir)).toMatchObject({ backup: name, restoreConfig: true, by: 'host:teacher' });
    expect(svc.banners().find((b) => b.code === 'restore-pending')?.text).toContain(name);

    const [s3, rec] = await recoveryCreateReply(svc, {}, 'host:teacher');
    expect(s3).toBe(200);
    expect(rec.words).toMatch(/^[a-z]{5}( [a-z]{5}){3}$/);
    const c = await decryptRecovery(Buffer.from(rec.fileBase64 as string, 'base64'), rec.words as string);
    expect(c).toMatchObject({ serverName: 'Room 136', installId: '00ff', smtpPassword: 'smtp-test-9' });
    expect(svc.banners().map((b) => b.code)).not.toContain('recovery-missing');
    const [s4, weak] = await recoveryCreateReply(svc, { passphrase: 'short' }, 'host:teacher');
    expect([s4, weak.code]).toEqual([400, 'EWEAK']);
  });

  it('tidies the index before listening when purges left entries; compacts only in a quiet window, after a confirm', async () => {
    const t = scratch();
    const db = open(t.db);
    markIndexDirty(db, 5);
    db.close();
    let online = 1;
    let clock = new Date(2026, 8, 29, 15, 0).getTime();
    const svc = await MaintService.start({
      dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), tickMs: 0, connections: () => online, statfs: statfsFree(50 * GB),
      now: () => clock,
    });
    clients.push({ close: () => svc.stop() });
    expect(svc.status().indexTidyPending).toBe(true);
    const notices: string[] = [];
    expect(await svc.startupTidy((x) => notices.push(x))).toMatchObject({ ms: expect.any(Number) });
    expect(notices).toEqual([expect.stringMatching(/^Tidying the chat log index… about \d+ s$/)]);
    expect(svc.status().indexTidyPending).toBe(false);
    expect(await svc.startupTidy()).toBeNull();
    expect(await dbCompactReply(svc, {}, 'host:teacher')).toEqual([409, expect.objectContaining({ needsConfirm: true, estimateSec: expect.any(Number) })]);
    expect(await dbCompactReply(svc, { confirm: true }, 'host:teacher')).toEqual([409, expect.objectContaining({ code: 'EBUSY', error: expect.stringMatching(/1 connected now/) })]);
    // The last pilot just left: VACUUM holds the write lock for its whole run, so it waits for the §5.16 quiet
    // window (nobody for 10 minutes), and says how long is left.
    online = 0;
    clock += 60_000;
    expect(await dbCompactReply(svc, { confirm: true }, 'host:teacher')).toEqual([409, expect.objectContaining({ code: 'EBUSY', quietInMin: 9, error: expect.stringMatching(/try again in 9 min/) })]);
    clock += 4 * 60_000;
    expect(await svc.compactInfo()).toMatchObject({ quiet: false, quietInMin: 5 });
    online = 2; // a class starts joining: the window starts over
    expect(await svc.compactInfo()).toMatchObject({ quiet: false });
    online = 0;
    clock += 9 * 60_000;
    expect(await svc.compactInfo()).toMatchObject({ quiet: false, quietInMin: 1 });
    clock += 60_000;
    expect(await svc.compactInfo()).toMatchObject({ quiet: true, quietInMin: 0 });
    expect((await dbCompactReply(svc, { confirm: true }, 'host:teacher'))[0]).toBe(200);
  });

  it('compact right after a start waits for the quiet window too (counting from the start)', async () => {
    const t = scratch();
    let clock = new Date(2026, 8, 29, 7, 0).getTime();
    const svc = await MaintService.start({
      dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), tickMs: 0, connections: () => 0, statfs: statfsFree(50 * GB),
      now: () => clock,
    });
    clients.push({ close: () => svc.stop() });
    await expect(svc.compact('host:teacher')).rejects.toMatchObject({ code: 'EBUSY', message: expect.stringMatching(/try again in 10 min/) });
    clock += 10 * 60_000;
    await expect(svc.compact('host:teacher')).resolves.toMatchObject({ afterBytes: expect.any(Number) });
  });

  it('retention runs without a backup: at start on a low disk, and hourly with daily backups off (nothing kept past 35 days)', async () => {
    // The verifier's attack1: (a) every backup skipped for low disk; (b) daily off on a server that stays up.
    const t = scratch();
    const key = key32();
    const t0 = new Date(2026, 5, 1, 9, 0).getTime();
    for (const d of [0, 5, 10]) {
      const r = await createBackup({ dataDir: t.dir, key, reason: 'start', now: t0 + d * DAY, ignoreDisk: true, retention: false });
      expect(r.ok).toBe(true);
    }
    const now = t0 + 50 * DAY;
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key }), settings: settings(), now: () => now, runner: null, tickMs: 0, statfs: statfsFree(1.5 * GB) });
    clients.push({ close: () => svc.stop() });
    expect(await svc.startupBackup()).toMatchObject({ ok: false, skipped: 'disk' });
    expect(listBackups(t.dir, { now })).toEqual([]);

    const t2 = scratch();
    let clock = t0;
    const svc2 = await MaintService.start({
      dataDir: t2.dir, secrets: memorySecrets({ 'backup.key': key }), settings: settings({ daily: false }), now: () => clock, tickMs: 0, statfs: statfsFree(50 * GB),
    });
    clients.push({ close: () => svc2.stop() });
    expect(await svc2.startupBackup()).toMatchObject({ ok: true });
    for (let h = 0; h < 40 * 24; h += 6) { clock += 6 * 3600_000; await svc2.tick(); }
    expect(listBackups(t2.dir, { now: clock }).filter((b) => clock - b.createdAt > 35 * DAY)).toEqual([]);
    expect(listBackups(t2.dir, { now: clock })).toEqual([]);
  });

  it('a future-stamped backup (a clock glitch) never stops the start or daily backups', async () => {
    const t = scratch();
    const key = key32();
    let now = new Date(2026, 5, 1, 7, 0).getTime();
    const glitch = await createBackup({ dataDir: t.dir, key, reason: 'daily', now: now + 400 * DAY, ignoreDisk: true, retention: false });
    expect(glitch.ok).toBe(true);
    // Its file was written an hour ago (only the name is wrong: e.g. copied in under another PC's clock).
    if (glitch.ok) fs.utimesSync(glitch.file, new Date(now - 3600_000), new Date(now - 3600_000));
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key }), settings: settings(), now: () => now, runner: null, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    // At start it was renamed to its mtime: it ages out in 35 days like any other.
    const l0 = listBackups(t.dir, { now });
    expect(l0).toEqual([expect.objectContaining({ cls: 'daily', future: false })]);
    expect(Math.abs(l0[0]!.createdAt - (now - 3600_000))).toBeLessThan(60_000);
    expect(await svc.startupBackup()).toBeNull(); // it counts as a backup made an hour ago (the 6 h rule)
    // The schedule carries on: the next quiet moment after 02:00, then the start backup 6 h on (the verifier's
    // attack3 made none in 30 days).
    now = new Date(2026, 5, 2, 3, 0).getTime();
    expect(await svc.tick()).toContain('daily-backup');
    now += 7 * 3600_000;
    expect(await svc.startupBackup()).toMatchObject({ ok: true, name: expect.stringMatching(/_start\.vsbak$/) });
    for (let d = 1; d <= 30; d++) {
      now = new Date(2026, 5, 2 + d, 3, 0).getTime();
      await svc.tick();
    }
    const l1 = listBackups(t.dir, { now });
    expect(l1.filter((b) => b.cls === 'daily' || b.cls === 'weekly').length).toBeGreaterThanOrEqual(7);
    expect(l1.some((b) => b.name === (glitch.ok ? glitch.name : ''))).toBe(false);
  });

  it('a backup whose file is ahead of the clock too is kept as it is (with a banner) and never stops the schedule', async () => {
    const t = scratch();
    const key = key32();
    let now = new Date(2026, 5, 1, 7, 0).getTime();
    const ahead = await createBackup({ dataDir: t.dir, key, reason: 'daily', now: now + 400 * DAY, ignoreDisk: true, retention: false });
    if (!ahead.ok) throw new Error('backup failed');
    fs.utimesSync(ahead.file, new Date(now + 400 * DAY), new Date(now + 400 * DAY));
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key }), settings: settings(), now: () => now, runner: null, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    expect(listBackups(t.dir, { now })).toEqual([expect.objectContaining({ name: ahead.name, future: true })]);
    expect(svc.banners()).toContainEqual(expect.objectContaining({ code: 'clock-behind' }));
    expect(await svc.startupBackup()).toMatchObject({ ok: true, name: expect.stringMatching(/_start\.vsbak$/) });
    for (let d = 1; d <= 40; d++) {
      now = new Date(2026, 5, 1 + d, 3, 0).getTime();
      await svc.tick();
    }
    const l = listBackups(t.dir, { now });
    expect(l.filter((b) => b.cls === 'daily' || b.cls === 'weekly').length).toBeGreaterThanOrEqual(7);
    expect(l.filter((b) => b.name === ahead.name)).toHaveLength(1); // never renamed to a guessed time, never deleted
    expect(l.filter((b) => !b.future && now - b.createdAt > 35 * DAY)).toEqual([]);
  });

  it("another install's backups (copied in to move its data) never stand in for this install's start or daily backup", async () => {
    const t = scratch();
    const mine = key32();
    const theirs = key32();
    let now = new Date(2026, 5, 1, 7, 0).getTime();
    // The old PC's backups from this morning, copied into data\backups to bring its data across (§6.3).
    for (const [cls, at] of [['start', now - 3600_000], ['daily', now - 2 * 3600_000]] as const) {
      const r = await createBackup({ dataDir: t.dir, key: theirs, reason: cls, now: at, ignoreDisk: true, retention: false });
      expect(r.ok).toBe(true);
    }
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': mine }), settings: settings(), now: () => now, runner: null, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    expect(await svc.startupBackup()).toMatchObject({ ok: true, name: expect.stringMatching(/_start\.vsbak$/) });
    now = new Date(2026, 5, 2, 3, 0).getTime();
    expect(await svc.tick()).toContain('daily-backup');
    const own = listBackups(t.dir, { key: mine, now }).filter((b) => b.ownKey === true);
    expect(own.map((b) => b.cls).sort()).toEqual(['start', 'weekly']);
  });

  it('a daily backup that is skipped (low disk) or fails backs off instead of retrying every minute, and logs a repeat once', async () => {
    const t = scratch();
    const logs: string[] = [];
    let now = new Date(2026, 5, 1, 1, 0).getTime();
    const svc = await MaintService.start({
      dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), now: () => now, runner: null, tickMs: 0,
      statfs: statfsFree(1.5 * GB), log: (l) => logs.push(l),
    });
    clients.push({ close: () => svc.stop() });
    let attempts = 0;
    for (let m = 0; m < 3 * 60; m++) {
      now += 60_000;
      if ((await svc.tick()).includes('daily-backup')) attempts++;
    }
    // 02:10 (quiet), then 03:10 (1 h), then back off 2 h: two attempts in the 3 hours, not 171.
    expect(attempts).toBeLessThanOrEqual(3);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(logs.filter((l) => /backup skipped/.test(l))).toHaveLength(1);
    expect(dailyRetryDelay(1)).toBe(3600_000);
    expect(dailyRetryDelay(3)).toBe(4 * 3600_000);
    expect(dailyRetryDelay(99)).toBe(12 * 3600_000);
  });

  it('a pending migration with no backup before it is blocked: the reason for startServer, and a banner', async () => {
    const t = scratch();
    const plan = { from: 3, to: 4 };
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), runner: null, tickMs: 0, statfs: statfsFree(1.5 * GB) });
    clients.push({ close: () => svc.stop() });
    const r = await svc.startupBackup({ migration: plan });
    expect(r).toMatchObject({ ok: false, skipped: 'disk' });
    const why = migrationBackupProblem(r, plan);
    expect(why).toMatch(/must be upgraded \(v3 → v4\).*Nothing was changed/);
    expect(svc.migrationBlocked).toBe(why);
    expect(svc.banners().find((b) => b.code === 'migration-blocked')).toMatchObject({ level: 'urgent' });
    expect(migrationBackupProblem(r, null)).toBeNull();
    const svc2 = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), runner: null, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc2.stop() });
    const ok = await svc2.startupBackup({ migration: plan });
    expect(ok?.ok).toBe(true);
    expect(migrationBackupProblem(ok, plan)).toBeNull();
    expect(svc2.migrationBlocked).toBeNull();
  });

  it('a backup made by another install cannot be staged from the panel (the tool with its recovery file can)', async () => {
    const t = scratch();
    const mine = key32();
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': mine }), settings: settings(), runner: null, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    const foreign = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), runner: null, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => foreign.stop() });
    const r = await foreign.backupNow('manual');
    if (!r.ok) throw new Error('backup failed');
    const [s, body] = backupsRestoreReply(svc, { backup: r.name, confirm: true }, 'host:teacher');
    expect(s).toBe(409);
    expect(body.error).toMatch(/recovery/);
    expect(backupsListReply(svc)[1].backups).toEqual([expect.objectContaining({ needsRecovery: true })]);
  });
});

// ------------------------------------------------------------------------------------------
// The packaged shape: app\maint.mjs beside app\server.mjs, inside the child's --permission sandbox
// ------------------------------------------------------------------------------------------

const req = createRequire(import.meta.url);
const hasEsbuild = ((): boolean => { try { req.resolve('esbuild'); return true; } catch { return false; } })();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe.runIf(hasEsbuild)('the bundled worker (app/maint.mjs) in the sandbox', () => {
  it('is found next to the server bundle, backs up into data/backups, and cannot write outside data/', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-maint-bundle-'));
    dirs.push({ dir: root, db: '', cleanup: () => fs.rmSync(root, { recursive: true, force: true }) });
    const data = path.join(root, 'data');
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(data);
    const entry = path.join(root, 'entry.ts');
    fs.writeFileSync(entry, [
      "import { randomBytes } from 'node:crypto';",
      "import * as fs from 'node:fs';",
      "import { AuthStore } from '@src/server/auth/store';",
      "import { MaintClient } from '@src/server/maint/client';",
      'const [data, outside] = process.argv.slice(2) as [string, string];',
      "new AuthStore(data + '/voidswarm.db').close();",
      'const c = await MaintClient.start({ dataDir: data, backupKey: randomBytes(32) });',
      "const b = await c.call<{ ok: boolean; name: string }>('backup.create', { reason: 'manual', ignoreDisk: true });",
      "let denied = '';",
      "try { fs.writeFileSync(outside + '/escape.txt', 'x'); } catch (e) { denied = String((e as { code?: string }).code); }",
      'await c.close();',
      'console.log(JSON.stringify({ ok: b.ok, name: b.name, denied }));',
    ].join('\n'));
    const esbuild = req('esbuild') as typeof import('esbuild');
    const common = {
      bundle: true, platform: 'node' as const, target: 'node24', format: 'esm' as const, minify: false, logLevel: 'error' as const,
      alias: { '@src': SRC }, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    };
    await esbuild.build({ ...common, entryPoints: [path.join(SRC, 'server', 'maint', 'worker.ts')], outfile: path.join(root, 'app', 'maint.mjs') });
    await esbuild.build({ ...common, entryPoints: [entry], outfile: path.join(root, 'app', 'server.mjs') });
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [
        '--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${data}`, '--allow-worker',
        '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning',
        path.join(root, 'app', 'server.mjs'), data, root,
      ], { cwd: root, timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
    });
    const r = JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; name: string; denied: string };
    expect(r).toMatchObject({ ok: true, denied: 'ERR_ACCESS_DENIED' });
    expect(fs.readdirSync(path.join(data, 'backups'))).toEqual([r.name]);
    expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
  }, 90_000);
});

describe('MaintService: the panel seams (handlers, the DB size banner, the hourly index look)', () => {
  it('maintAdminHandlers answers every backup endpoint and records the admin as host:<name>', async () => {
    const t = scratch();
    const audit: { action: string; actor: string }[] = [];
    const svc = await MaintService.start({
      dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings(), runner: null, tickMs: 0, statfs: statfsFree(50 * GB),
      audit: (e) => audit.push({ action: e.action, actor: e.actor }),
    });
    clients.push({ close: () => svc.stop() });
    const h = maintAdminHandlers(svc);
    expect(Object.keys(h).sort()).toEqual(['backups/cancelRestore', 'backups/copyNow', 'backups/create', 'backups/list', 'backups/restore', 'db/compact', 'recovery/create']);
    const ctx = { actor: { accountId: 'host', name: 'teacher' } } as unknown as Parameters<(typeof h)['backups/create']>[1];
    const created = await h['backups/create']!({}, ctx);
    expect(Array.isArray(created) && created[0]).toBe(200);
    const listed = await h['backups/list']!({}, ctx) as [number, { backups: { name: string }[]; db: { bytes: number } }];
    expect(listed[1].backups).toHaveLength(1);
    expect(listed[1].db.bytes).toBeGreaterThan(0);
    const name = listed[1].backups[0]!.name;
    expect((await h['backups/restore']!({ backup: name, confirm: true }, ctx) as [number, unknown])[0]).toBe(200);
    expect(await h['backups/cancelRestore']!({}, ctx)).toEqual([200, { ok: true, cancelled: true }]);
    expect((await h['backups/copyNow']!({}, ctx) as [number, unknown])[0]).toBe(409); // no copy folder set
    expect(audit).toEqual([
      { action: 'backup', actor: 'host:teacher' }, { action: 'restore', actor: 'host:teacher' }, { action: 'restore', actor: 'host:teacher' },
    ]);
    expect(maintActorOf({ accountId: 'host', name: 'teacher' })).toBe('host:teacher');
    expect(auditActorOf('host:teacher')).toEqual({ accountId: 'host', name: 'teacher' });
    expect(auditActorOf('system')).toEqual({ accountId: 'system', name: 'system' });
  });

  it('shows "DB over 1 GB" only above 1 GB (the file plus its WAL)', () => {
    expect(dbSizeBanner(DB_LARGE_BYTES)).toBeNull();
    expect(dbSizeBanner(DB_LARGE_BYTES + 1)).toMatchObject({ code: 'db-large', level: 'info', text: expect.stringMatching(/over 1 GB.*archive/) });
    const t = scratch();
    expect(dbFileBytes(t.db).dbBytes).toBeGreaterThan(0);
    expect(dbFileBytes(path.join(t.dir, 'none.db'))).toEqual({ dbBytes: 0, walBytes: 0 });
  });

  it('notices index entries left by purges it was not told about, at the hourly check, and tidies them in the next quiet window', async () => {
    const t = scratch();
    let now = new Date(2026, 8, 28, 20, 0).getTime();
    const svc = await MaintService.start({ dataDir: t.dir, secrets: memorySecrets({ 'backup.key': key32() }), settings: settings({ daily: false }), now: () => now, tickMs: 0, statfs: statfsFree(50 * GB) });
    clients.push({ close: () => svc.stop() });
    expect(svc.status().indexTidyPending).toBe(false);
    // Another op (a purge in the worker) marks the index; MaintService was not told.
    const db = open(t.db);
    markIndexDirty(db, 40);
    db.close();
    now += 61 * 60_000; // 21:01: the hourly disk check looks
    expect(await svc.tick()).toEqual(['disk']);
    expect(svc.status().indexTidyPending).toBe(true);
    now = new Date(2026, 8, 28, 22, 30).getTime(); // overnight, nobody on since the start
    expect(await svc.tick()).toContain('optimize');
    expect(svc.status().indexTidyPending).toBe(false);
  });
});

describe('maintSettingsFrom', () => {
  it('maps the settings service\'s HostSettings (backups, name, install id, term end)', () => {
    const s = defaultSettings({ preset: 'school', lan: true });
    const v = maintSettingsFrom({ ...s, installId: 'ab12', chat: { ...s.chat, retention: { ...s.chat.retention, termEnd: '2026-12-18' } } });
    expect(v).toEqual({ backups: { daily: s.backups.daily, copyTo: s.backups.copyTo, sizeCapMB: s.backups.sizeCapMB }, serverName: s.serverName, installId: 'ab12', termEnd: '2026-12-18' });
    expect(v.backups.sizeCapMB).toBe(2048);
  });
});
