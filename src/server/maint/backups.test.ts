// LAN task B5: encrypted backups (T-BAK-1, format and create/list), age and size caps (T-BAK-2), low disk (T-BAK-4).
// docs/LAN-EDITION-proposal.md §6.1, §5.16.
import * as fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  applyRetention, cleanupBackupTemp, clockBanner, copyBackups, createBackup, ensureOffPcState, lastBackupAt, listBackups, offPcBanner, offPcFolder, pidAlive,
  readOffPcState, stampLineage, startBackupReason, tempFilePid,
} from './backups';
import {
  BACKUP_MIN_FREE_BYTES, backupSpace, CHAT_MIN_FREE_BYTES, CHAT_NOT_LOGGED_TEXT, chatWriteBanner, checkDisk, compactSpace, diskBanners, diskLevel, DiskMonitor,
  isStorageFailure,
} from './disk';
import { BackupError, HEADER_BYTES, keyIdOf, readBackupFile, readBackupHeader, VSBAK_MAGIC, writeBackupFile } from './format';
import { dbLineage, nativeLineage } from './ledger';
import { backupFileName, parseBackupName } from './names';
import { DAY_MS, dailyClass, DEFAULT_RETENTION, planRetention, retentionPolicy, type RetentionItem } from './retention';
import { addAccount, addChat, GB, key32, MB, open, statfsFree, tmpData, type TmpData } from './testutil';

const dirs: TmpData[] = [];
const scratch = (db = true): TmpData => { const t = tmpData('vs-bak-', { db }); dirs.push(t); return t; };
afterEach(() => { while (dirs.length) dirs.pop()!.cleanup(); });

const MARKER = 'zq-marker-line-7781-unique';

function seed(t: TmpData): void {
  const db = open(t.db);
  addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
  for (let i = 0; i < 50; i++) addChat(db, { accountId: 'acc-nova', name: 'NovaPilot', original: `${MARKER} ${i}` });
  db.close();
  fs.writeFileSync(path.join(t.dir, 'voidswarm.config.json'), `${JSON.stringify({ configVersion: 1, serverName: 'Room 136' })}\n`);
  fs.writeFileSync(path.join(t.dir, 'deletions.jsonl'), `${JSON.stringify({ ts: 1, kind: 'purge', before: 5, by: 'cli' })}\n`);
}

describe('T-BAK-1: the encrypted backup file', () => {
  it('writes VSBK1 | key id | nonce, then AES-256-GCM over gzip: no plaintext, and it decrypts to the same files', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const r = await createBackup({ dataDir: t.dir, key, reason: 'manual', appVersion: '0.6.0', installId: 'ab12', ignoreDisk: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}_manual\.vsbak$/);
    const bytes = fs.readFileSync(r.file);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe(VSBAK_MAGIC);
    expect(bytes.subarray(5, 13).toString('hex')).toBe(keyIdOf(key));
    for (const s of [MARKER, 'NovaPilot', 'novapilot@caldwellschools.org', 'Room 136', 'SQLite format']) {
      expect(bytes.includes(Buffer.from(s))).toBe(false);
    }
    // The key id reveals nothing: it is not the key or a prefix of it.
    expect(bytes.includes(key.subarray(0, 8))).toBe(false);

    const out = path.join(t.dir, 'out');
    const x = await readBackupFile(r.file, key, out);
    expect(x.manifest).toMatchObject({ v: 1, reason: 'manual', appVersion: '0.6.0', installId: 'ab12', schemaVersion: 4 });
    expect(x.files.map((f) => f.name).sort()).toEqual(['deletions.jsonl', 'voidswarm.config.json', 'voidswarm.db']);
    expect(fs.readFileSync(path.join(out, 'voidswarm.config.json'), 'utf8')).toContain('Room 136');
    // No .part leftovers, and nothing outside the whitelist.
    expect(fs.readdirSync(out).sort()).toEqual(['deletions.jsonl', 'voidswarm.config.json', 'voidswarm.db']);
    const db = new DatabaseSync(path.join(out, 'voidswarm.db'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_log').get()).toEqual({ n: 50 });
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    db.close();
  });

  it('never includes secrets\\, tls\\, logs\\ or exports\\', async () => {
    const t = scratch();
    seed(t);
    for (const d of ['secrets', 'tls', 'logs', 'exports']) {
      fs.mkdirSync(path.join(t.dir, d));
      fs.writeFileSync(path.join(t.dir, d, 'x.txt'), `${d}-secret-content-9912`);
    }
    const key = key32();
    const r = await createBackup({ dataDir: t.dir, key, reason: 'manual', ignoreDisk: true });
    if (!r.ok) throw new Error('backup failed');
    const x = await readBackupFile(r.file, key, path.join(t.dir, 'out'));
    expect(x.manifest.files.map((f) => f.name)).not.toContain('x.txt');
    expect(fs.readdirSync(path.join(t.dir, 'out'))).toHaveLength(3);
  });

  it('refuses another key (EKEY), and any changed byte, a changed nonce or a cut file (EAUTH), leaving nothing behind', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const r = await createBackup({ dataDir: t.dir, key, reason: 'manual', ignoreDisk: true });
    if (!r.ok) throw new Error('backup failed');
    const out = path.join(t.dir, 'out');
    await expect(readBackupFile(r.file, key32(), out)).rejects.toMatchObject({ code: 'EKEY' });

    const orig = fs.readFileSync(r.file);
    const variants: [string, Buffer][] = [
      ['a body byte', Buffer.from(orig).fill(orig[orig.length >> 1]! ^ 0x55, orig.length >> 1, (orig.length >> 1) + 1)],
      ['the nonce', Buffer.from(orig).fill(orig[HEADER_BYTES - 1]! ^ 1, HEADER_BYTES - 1, HEADER_BYTES)],
      ['the tag', Buffer.from(orig).fill(orig[orig.length - 1]! ^ 1, orig.length - 1)],
      ['a cut file', orig.subarray(0, orig.length - 100)],
    ];
    for (const [what, buf] of variants) {
      const f = path.join(t.dir, `bad-${what.replace(/\W/g, '')}.vsbak`);
      fs.writeFileSync(f, buf);
      const e = await readBackupFile(f, key, out).catch((x: unknown) => x);
      expect(e, what).toBeInstanceOf(BackupError);
      expect((e as BackupError).code, what).toBe('EAUTH');
      expect(fs.existsSync(out) ? fs.readdirSync(out) : [], what).toEqual([]);
    }
    fs.writeFileSync(path.join(t.dir, 'junk.vsbak'), 'not a backup at all, just text');
    expect(() => readBackupHeader(path.join(t.dir, 'junk.vsbak'))).toThrow(BackupError);
  });

  it('streams a file of several MB through without holding it (manifest sizes are exact)', async () => {
    const t = scratch(false);
    const big = path.join(t.dir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(6 * MB, 7));
    const key = key32();
    const dest = path.join(t.dir, 'x.vsbak');
    await writeBackupFile(dest, key, { createdAt: 1, reason: 'manual', detail: null, appVersion: '', schemaVersion: null, installId: '' },
      [{ name: 'voidswarm.db', path: big }, { name: 'deletions.jsonl', data: Buffer.from('') }]);
    expect(fs.statSync(dest).size).toBeLessThan(MB); // gzip of a constant file
    const x = await readBackupFile(dest, key, path.join(t.dir, 'o'));
    expect(x.files.find((f) => f.name === 'voidswarm.db')?.size).toBe(6 * MB);
    expect(fs.statSync(path.join(t.dir, 'o', 'voidswarm.db')).size).toBe(6 * MB);
    expect(fs.statSync(path.join(t.dir, 'o', 'deletions.jsonl')).size).toBe(0);
  });

  it("stamps the live database's data lineage at its first backup (the key's native one), keeps a stamp it has, and only when asked", async () => {
    const t = scratch();
    seed(t);
    const lineageOf = (): string | null => { const db = open(t.db); try { return dbLineage(db); } finally { db.close(); } };
    const key = key32();
    // A restore's safety backup never changes the current database.
    const r0 = await createBackup({ dataDir: t.dir, key, reason: 'pre-restore', ignoreDisk: true, stampLineage: false });
    expect(r0.ok).toBe(true);
    expect(lineageOf()).toBeNull();
    // Every other backup stamps it first (with a server's connection open, as in WAL mode live), so the snapshot has it too.
    const live = open(t.db);
    try {
      const r1 = await createBackup({ dataDir: t.dir, key, reason: 'manual', ignoreDisk: true });
      if (!r1.ok) throw new Error(JSON.stringify(r1));
      expect(dbLineage(live)).toBe(nativeLineage(key));
      const out = path.join(t.dir, 'o1');
      await readBackupFile(r1.file, key, out);
      const snap = new DatabaseSync(path.join(out, 'voidswarm.db'), { readOnly: true });
      try { expect(dbLineage(snap)).toBe(nativeLineage(key)); } finally { snap.close(); }
    } finally {
      live.close();
    }
    // A new backup key (backup.key lost and made again) never re-stamps the data: it keeps its identity.
    const key2 = key32();
    const r2 = await createBackup({ dataDir: t.dir, key: key2, reason: 'manual', ignoreDisk: true });
    expect(r2.ok).toBe(true);
    expect(lineageOf()).toBe(nativeLineage(key));
    // An older schema (the pre-migration backup) is never written to.
    const db = new DatabaseSync(t.db, { readOnly: true });
    try { expect(stampLineage(db, t.db, key2, 3)).toBe(false); } finally { db.close(); }
  });

  it('snapshots a database that is open and being written (WAL), consistently', async () => {
    const t = scratch();
    seed(t);
    const live = open(t.db);
    live.exec('PRAGMA wal_autocheckpoint = 0');
    for (let i = 0; i < 20; i++) addChat(live, { accountId: 'acc-nova', name: 'NovaPilot', original: `late ${i}` });
    expect(fs.statSync(`${t.db}-wal`).size).toBeGreaterThan(0);
    const key = key32();
    const r = await createBackup({ dataDir: t.dir, key, reason: 'manual', ignoreDisk: true });
    live.close();
    if (!r.ok) throw new Error(JSON.stringify(r));
    const x = await readBackupFile(r.file, key, path.join(t.dir, 'o'));
    const db = new DatabaseSync(x.files.find((f) => f.name === 'voidswarm.db')!.path, { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_log').get()).toEqual({ n: 70 });
    db.close();
    // The snapshot temp file is gone.
    expect(fs.readdirSync(path.join(t.dir, 'backups')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('lists the backups newest first with class, size, encrypted and whether this key made them', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const other = key32();
    const now = new Date(2026, 8, 28, 7, 12).getTime();
    await createBackup({ dataDir: t.dir, key, reason: 'start', now: now - 3 * 3600_000, ignoreDisk: true });
    await createBackup({ dataDir: t.dir, key, reason: 'manual', now, ignoreDisk: true });
    await createBackup({ dataDir: t.dir, key: other, reason: 'daily', now: now - 3600_000, ignoreDisk: true, retention: false });
    const list = listBackups(t.dir, { key });
    expect(list.map((b) => [b.name, b.cls, b.ownKey, b.encrypted])).toEqual([
      ['2026-09-28_0712_manual.vsbak', 'manual', true, true],
      ['2026-09-28_0612_daily.vsbak', 'daily', false, true],
      ['2026-09-28_0412_start.vsbak', 'start', true, true],
    ]);
    expect(list.every((b) => b.size > HEADER_BYTES)).toBe(true);
  });

  it('start backups: when a migration is pending, or the last backup is more than 6 h old (and only with a database)', () => {
    const now = 10 * DAY_MS;
    expect(startBackupReason({ migrationPending: true, lastBackupAt: now - 60_000, now, dbExists: true })).toBe('pre-migration');
    expect(startBackupReason({ migrationPending: false, lastBackupAt: now - 5 * 3600_000, now, dbExists: true })).toBe(null);
    expect(startBackupReason({ migrationPending: false, lastBackupAt: now - 7 * 3600_000, now, dbExists: true })).toBe('start');
    expect(startBackupReason({ migrationPending: false, lastBackupAt: null, now, dbExists: true })).toBe('start');
    expect(startBackupReason({ migrationPending: true, lastBackupAt: null, now, dbExists: false })).toBe(null);
  });

  it('copies the encrypted files off the PC (missing ones only), caps the copy the same way, and records it for the banner', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const now = Date.now();
    const a = await createBackup({ dataDir: t.dir, key, reason: 'manual', now, ignoreDisk: true });
    const target = path.join(t.dir, 'usb');
    const folder = offPcFolder(target, keyIdOf(key));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(target, 'teacher-notes.txt'), 'not ours');
    // An old copy of ours (this key), far past 35 days: rotated. The same name without a header: never touched.
    const old = '2020-01-01_0200_daily.vsbak';
    fs.copyFileSync(a.ok ? a.file : '', path.join(folder, old));
    fs.writeFileSync(path.join(folder, '2020-01-02_0200_daily.vsbak'), 'not a backup');
    const r1 = await copyBackups(t.dir, target, { now, key });
    expect(r1.ok).toBe(true);
    expect(r1.folder).toBe(folder);
    expect(r1.copied).toEqual([a.ok ? a.name : '']);
    expect(r1.removed).toEqual([old]);
    expect(fs.existsSync(path.join(target, 'teacher-notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(folder, '2020-01-02_0200_daily.vsbak'))).toBe(true);
    const r2 = await copyBackups(t.dir, target, { now, key });
    expect(r2.copied).toEqual([]);
    expect(readOffPcState(t.dir)).toMatchObject({ at: now, error: null });
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: target, now: now + 29 * DAY_MS, oldestBackupAt: now - 40 * DAY_MS })).toBeNull();
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: target, now: now + 31 * DAY_MS, oldestBackupAt: now - 40 * DAY_MS })?.code).toBe('offpc-none');
    const bad = await copyBackups(t.dir, path.join(t.dir, 'voidswarm.db', 'nope'), { now, key });
    expect(bad.ok).toBe(false);
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: 'E:\\x', now, oldestBackupAt: now })?.code).toBe('offpc-failed');
    // No key given: this install's data\secrets\backup.key is read (none here: a clear error, not a crash).
    expect(await copyBackups(t.dir, target, { now })).toMatchObject({ ok: false, error: expect.stringContaining('backup key') });
  });

  it('a share used by several hosts: each copies into its own folder; same-minute names never collide or get pruned by the other', async () => {
    // The verifier's case (attack2 / attack8): two installs back up in the same minute, same size, one district share.
    const a = scratch();
    const b = scratch();
    seed(a);
    seed(b);
    const ka = key32();
    const kb = key32();
    const now = new Date(2026, 5, 1, 21, 42).getTime(); // in the past, whenever the test runs
    const ra = await createBackup({ dataDir: a.dir, key: ka, reason: 'start', now, ignoreDisk: true });
    const rb = await createBackup({ dataDir: b.dir, key: kb, reason: 'start', now, ignoreDisk: true });
    if (!ra.ok || !rb.ok) throw new Error('backup failed');
    expect(ra.name).toBe(rb.name);
    const share = path.join(a.dir, 'share');
    expect((await copyBackups(b.dir, share, { now, key: kb })).copied).toEqual([rb.name]);
    const ca = await copyBackups(a.dir, share, { now, key: ka });
    expect(ca).toMatchObject({ ok: true, copied: [ra.name], conflicts: [] });
    expect(readBackupHeader(path.join(offPcFolder(share, keyIdOf(ka)), ra.name)).keyId).toBe(keyIdOf(ka));
    expect(readBackupHeader(path.join(offPcFolder(share, keyIdOf(kb)), rb.name)).keyId).toBe(keyIdOf(kb)); // B's copy untouched
    // A's retention on the share (many backups later) never counts or deletes B's.
    for (let i = 1; i <= 8; i++) {
      const r = await createBackup({ dataDir: a.dir, key: ka, reason: 'start', now: now + i * 7 * 3600_000, ignoreDisk: true });
      if (!r.ok) throw new Error('backup failed');
    }
    const later = await copyBackups(a.dir, share, { now: now + 8 * 7 * 3600_000, key: ka });
    expect(later.ok).toBe(true);
    expect(fs.readdirSync(offPcFolder(share, keyIdOf(kb)))).toEqual([rb.name]);
    // Another key's file planted in our own folder under one of our names: never overwritten, and no success recorded.
    const mine = offPcFolder(share, keyIdOf(ka));
    const newest = listBackups(a.dir, { now: now + 9 * 7 * 3600_000 })[0]!;
    fs.rmSync(path.join(mine, newest.name));
    fs.copyFileSync(rb.file, path.join(mine, newest.name));
    const before = readOffPcState(a.dir)!.at;
    const c3 = await copyBackups(a.dir, share, { now: now + 9 * 7 * 3600_000, key: ka });
    expect(c3).toMatchObject({ ok: false, conflicts: [newest.name] });
    expect(readBackupHeader(path.join(mine, newest.name)).keyId).toBe(keyIdOf(kb));
    expect(readOffPcState(a.dir)).toMatchObject({ at: before, error: expect.stringContaining('another copy of Voidswarm') });
  });
});

describe('the off-PC copy banner (§6.1 "no off-PC copy for 30 days")', () => {
  it('shows 30 days after the first start with no copy, although the caps keep every backup younger than that', () => {
    // The verifier's case: 7 dailies + 4 weeklies reach back 28 days at most, so the oldest backup never turns 30.
    const t = scratch(false);
    const t0 = new Date(2026, 8, 1, 8, 0).getTime();
    expect(ensureOffPcState(t.dir, t0)).toMatchObject({ at: 0, since: t0 });
    expect(ensureOffPcState(t.dir, t0 + DAY_MS).since).toBe(t0); // set once
    let items: RetentionItem[] = [];
    let firstDay = -1;
    for (let d = 0; d < 60 && firstDay < 0; d++) {
      const at = t0 + d * DAY_MS;
      items.push({ name: `s${d}`, cls: 'start', at, size: 1 }, { name: `d${d}`, cls: dailyClass(items, at + 18 * 3600_000), at: at + 18 * 3600_000, size: 1 });
      items = planRetention(items, at + 20 * 3600_000).keep;
      const oldest = Math.min(...items.map((i) => i.at));
      expect(at + 20 * 3600_000 - oldest).toBeLessThan(30 * DAY_MS);
      if (offPcBanner({ state: readOffPcState(t.dir), copyTo: '', now: at + 20 * 3600_000, oldestBackupAt: oldest })) firstDay = d;
    }
    expect(firstDay).toBe(30); // the first evening 30 days or more after the first start (08:00 on day 0)
    // Nothing to copy (no backups at all): no banner.
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: '', now: t0 + 90 * DAY_MS, oldestBackupAt: null })).toBeNull();
  });

  it('a copy restarts the 30 days; a failed copy keeps the clock and shows its error', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const t0 = Date.now() - 40 * DAY_MS;
    ensureOffPcState(t.dir, t0);
    const now = Date.now();
    const b = await createBackup({ dataDir: t.dir, key, reason: 'manual', now, ignoreDisk: true });
    if (!b.ok) throw new Error('backup failed');
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: '', now, oldestBackupAt: now })?.code).toBe('offpc-none');
    const ok = await copyBackups(t.dir, path.join(t.dir, 'usb'), { now, key });
    expect(ok.ok).toBe(true);
    expect(readOffPcState(t.dir)).toMatchObject({ at: now, since: t0 });
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: 'E:\\usb', now: now + 29 * DAY_MS, oldestBackupAt: now })).toBeNull();
    expect(offPcBanner({ state: readOffPcState(t.dir), copyTo: 'E:\\usb', now: now + 31 * DAY_MS, oldestBackupAt: now })?.code).toBe('offpc-none');
    const bad = await copyBackups(t.dir, path.join(t.dir, 'voidswarm.db', 'nope'), { now: now + DAY_MS, key });
    expect(bad.ok).toBe(false);
    expect(readOffPcState(t.dir)).toMatchObject({ at: now, since: t0, error: expect.stringContaining('failed') });
  });
});

// ------------------------------------------------------------------------------------------
// T-BAK-2: age and size caps
// ------------------------------------------------------------------------------------------

type Item = RetentionItem;
let n = 0;
const item = (cls: Item['cls'], at: number, size = 10 * MB): Item => ({ name: `b${n++}`, cls, at, size });

/** Run a host over `days`, making backups with `make(day)`, applying retention after each: what is kept at the end. */
function simulate(days: number, make: (day: number, kept: Item[]) => Item[], sizeCapMB?: number): { kept: Item[]; everMaxAgeDays: number } {
  let kept: Item[] = [];
  let everMaxAgeDays = 0;
  for (let d = 0; d < days; d++) {
    const now = d * DAY_MS + 12 * 3600_000;
    kept.push(...make(d, kept));
    kept = planRetention(kept, now, retentionPolicy(sizeCapMB)).keep;
    for (const k of kept) everMaxAgeDays = Math.max(everMaxAgeDays, (now - k.at) / DAY_MS);
  }
  return { kept, everMaxAgeDays };
}

describe('T-BAK-2: backups are capped by age (35 days), per class, and by size', () => {
  it('a host that runs once a week never keeps anything older than 35 days', () => {
    const { kept, everMaxAgeDays } = simulate(7 * 30, (d) => (d % 7 === 0 ? [item('start', d * DAY_MS + 8 * 3600_000)] : []));
    expect(everMaxAgeDays).toBeLessThanOrEqual(35);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(5);
  });

  it('a host that runs every day keeps at most 7 daily, 4 weekly and 5 start backups, all within 35 days', () => {
    const { kept, everMaxAgeDays } = simulate(120, (d, cur) => {
      const at = d * DAY_MS + 2 * 3600_000;
      return [item('start', d * DAY_MS + 8 * 3600_000), item(dailyClass(cur, at), at)];
    });
    const by = (c: string): number => kept.filter((k) => k.cls === c).length;
    expect(by('daily')).toBe(7);
    expect(by('weekly')).toBe(4);
    expect(by('start')).toBe(5);
    expect(everMaxAgeDays).toBeLessThanOrEqual(35);
    // The weekly ones really are a week apart and reach back further than the dailies.
    const weekly = kept.filter((k) => k.cls === 'weekly').map((k) => k.at).sort((a, b) => b - a);
    expect(weekly[0]! - weekly[1]!).toBe(7 * DAY_MS);
  });

  it('pre-migration and pre-update backups go after 30 days; the other classes after 35', () => {
    const now = 100 * DAY_MS;
    const plan = planRetention([
      item('pre-update', now - 29 * DAY_MS), item('pre-update', now - 31 * DAY_MS), item('pre-migration', now - 30.5 * DAY_MS),
      item('manual', now - 34 * DAY_MS), item('manual', now - 36 * DAY_MS),
    ], now);
    expect(plan.keep.map((k) => [k.cls, Math.round((now - k.at) / DAY_MS)])).toEqual([['pre-update', 29], ['manual', 34]]);
    expect(plan.remove.every((r) => r.why === 'age')).toBe(true);
  });

  it('the "before …" safety backups are capped by age only: a series of restores keeps the data from before the FIRST', () => {
    const now = 100 * DAY_MS;
    // A host trying twelve backups in a row: each restore made a pre-restore backup; the oldest is the only copy of the
    // data from before the first try.
    const tries = Array.from({ length: 12 }, (_, i) => item('pre-restore', now - i * DAY_MS));
    const plan = planRetention(tries, now);
    expect(plan.keep).toHaveLength(12);
    expect(plan.keep.at(-1)).toBe(tries[11]);
    // The age cap still holds: 35 days, like every class but pre-migration and pre-update (30).
    const aged = planRetention([...tries, item('pre-restore', now - 33 * DAY_MS), item('pre-restore', now - 36 * DAY_MS)], now);
    expect(aged.keep).toHaveLength(13);
    expect(aged.remove.map((r) => [r.why, Math.round((now - r.item.at) / DAY_MS)])).toEqual([['age', 36]]);
    for (const cls of ['pre-purge', 'pre-update', 'pre-migration', 'pre-cert', 'pre-import'] as const) {
      expect(planRetention(Array.from({ length: 9 }, (_, i) => item(cls, now - i * 3600_000)), now).keep).toHaveLength(9);
    }
    // And so does the size cap (oldest first, the newest 3 exempt).
    const big = planRetention(Array.from({ length: 8 }, (_, i) => item('pre-restore', now - i * 3600_000, 400 * MB)), now, retentionPolicy(2048));
    expect(big.keep).toHaveLength(5);
    expect(big.remove.every((r) => r.why === 'size')).toBe(true);
  });

  it('listBackups reads a file\'s header again when the file under a name is replaced (the key ids are cached per file)', async () => {
    const t = scratch();
    seed(t);
    const k1 = key32();
    const k2 = key32();
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    const r1 = await createBackup({ dataDir: t.dir, key: k1, reason: 'manual', now, ignoreDisk: true, retention: false });
    if (!r1.ok) throw new Error('backup failed');
    expect(listBackups(t.dir, { key: k1, now })).toMatchObject([{ name: r1.name, ownKey: true, keyId: keyIdOf(k1) }]);
    expect(listBackups(t.dir, { key: k1, now })).toMatchObject([{ name: r1.name, ownKey: true }]);
    const r2 = await createBackup({ dataDir: t.dir, key: k2, reason: 'manual', now: now + 60_000, ignoreDisk: true, retention: false });
    if (!r2.ok) throw new Error('backup failed');
    fs.rmSync(r1.file);
    fs.renameSync(r2.file, r1.file);
    expect(listBackups(t.dir, { key: k1, now })).toMatchObject([{ name: r1.name, ownKey: false, keyId: keyIdOf(k2) }]);
    // A file that is not a backup any more under the same name.
    fs.writeFileSync(r1.file, 'no header');
    expect(listBackups(t.dir, { key: k1, now })).toMatchObject([{ name: r1.name, keyId: null, managed: false }]);
  });

  it('above the size cap the oldest go first; the newest 3 are exempt, but only within 35 days', () => {
    const now = 50 * DAY_MS;
    const ten = Array.from({ length: 10 }, (_, i) => item(i % 2 ? 'daily' : 'start', now - i * 3600_000, 300 * MB));
    const plan = planRetention(ten, now, retentionPolicy(2048));
    expect(plan.keptBytes).toBeLessThanOrEqual(2048 * MB);
    expect(plan.keep).toHaveLength(6);
    expect(plan.remove.filter((r) => r.why === 'size').map((r) => r.item.at)).toEqual([...ten].slice(6).map((x) => x.at).reverse().sort((a, b) => a - b));
    // Three huge newest ones stay even though they alone pass the cap.
    const huge = [item('manual', now, GB), item('manual', now - 1000, GB), item('manual', now - 2000, GB), item('start', now - 3000, 10 * MB)];
    const p2 = planRetention(huge, now, retentionPolicy(2048));
    expect(p2.keep.map((k) => k.at)).toEqual([now, now - 1000, now - 2000]);
    // A host last run 40 days ago: nothing is exempt from the age cap.
    expect(planRetention([item('start', now - 40 * DAY_MS)], now).keep).toEqual([]);
  });

  it('names round-trip: class, detail, same-minute counter; files that are not ours are never rotated', async () => {
    const at = new Date(2026, 8, 28, 7, 12).getTime();
    expect(backupFileName('start', at)).toBe('2026-09-28_0712_start.vsbak');
    expect(backupFileName('pre-update', at, { detail: '0.6.1' })).toBe('2026-09-28_0712_pre-update-0.6.1.vsbak');
    expect(backupFileName('manual', at, { taken: (x) => x === '2026-09-28_0712_manual.vsbak' })).toBe('2026-09-28_0712_manual_2.vsbak');
    expect(parseBackupName('2026-09-28_0712_pre-update-0.6.1_3.vsbak')).toMatchObject({ cls: 'pre-update', detail: '0.6.1', seq: 3, at });
    expect(parseBackupName('2026-09-28_0712_pre-migration-v3.vsbak')).toMatchObject({ cls: 'pre-migration', detail: 'v3' });
    expect(parseBackupName('holiday copy.vsbak')).toBeNull();
    expect(parseBackupName('2026-13-28_0712_start.vsbak')).toBeNull();

    const t = scratch(false);
    const dir = path.join(t.dir, 'backups');
    fs.mkdirSync(dir);
    const fake = (name: string): void => fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from('VSBK1'), Buffer.alloc(20 + 40, 1)]));
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    fake('2026-08-01_0200_daily.vsbak'); // 58 days old
    fake('2026-09-27_0200_daily.vsbak');
    fake('my own copy.vsbak');
    fs.writeFileSync(path.join(dir, '2026-09-26_0200_daily.vsbak'), 'no header'); // not a backup: never touched
    const removed = applyRetention(t.dir, { now });
    expect(removed).toEqual(['2026-08-01_0200_daily.vsbak']);
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-09-26_0200_daily.vsbak', '2026-09-27_0200_daily.vsbak', 'my own copy.vsbak']);
    expect(listBackups(t.dir).find((b) => b.name === 'my own copy.vsbak')?.managed).toBe(false);
  });

  it('a new backup applies the caps to the folder (and never removes itself)', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    for (let d = 40; d >= 1; d -= 3) {
      const r = await createBackup({ dataDir: t.dir, key, reason: 'start', now: now - d * DAY_MS, ignoreDisk: true, retention: false });
      expect(r.ok).toBe(true);
    }
    expect(listBackups(t.dir)).toHaveLength(14);
    const r = await createBackup({ dataDir: t.dir, key, reason: 'start', now, ignoreDisk: true });
    if (!r.ok) throw new Error('backup failed');
    const left = listBackups(t.dir);
    expect(left).toHaveLength(DEFAULT_RETENTION.perClass.start);
    expect(left[0]!.name).toBe(r.name);
    expect(r.removed.length).toBe(10);
  });
});

// ------------------------------------------------------------------------------------------
// T-BAK-4: low disk
// ------------------------------------------------------------------------------------------

describe('T-BAK-4: low disk', () => {
  it('below 2 GB free, backups are skipped with a banner; below 500 MB the red "chat may stop being logged" banner', async () => {
    const t = scratch();
    seed(t);
    const low = await checkDisk(t.dir, { statfs: statfsFree(1.5 * GB) });
    expect(low.level).toBe('low');
    expect(diskBanners(low)).toEqual([{ code: 'disk-low', level: 'warn', text: expect.stringContaining('backups are skipped below 2 GB') }]);
    const crit = await checkDisk(t.dir, { statfs: statfsFree(400 * MB) });
    expect(crit.level).toBe('critical');
    expect(diskBanners(crit)).toEqual([{ code: 'disk-critical', level: 'urgent', text: expect.stringContaining('chat may stop being logged') }]);
    expect(diskBanners(await checkDisk(t.dir, { statfs: statfsFree(50 * GB) }))).toEqual([]);

    const r = await createBackup({ dataDir: t.dir, key: key32(), reason: 'daily', statfs: statfsFree(1.5 * GB) });
    expect(r).toMatchObject({ ok: false, skipped: 'disk', text: expect.stringContaining('2 GB') });
    expect(fs.existsSync(path.join(t.dir, 'backups')) ? fs.readdirSync(path.join(t.dir, 'backups')) : []).toEqual([]);
    const ok = await createBackup({ dataDir: t.dir, key: key32(), reason: 'daily', statfs: statfsFree(50 * GB) });
    expect(ok.ok).toBe(true);
  });

  it('a backup that would not fit (the snapshot plus the file, leaving 500 MB) is skipped even above 2 GB', () => {
    const disk = { path: '', freeBytes: 2.5 * GB, totalBytes: 100 * GB, level: diskLevel(2.5 * GB), checkedAt: 0 };
    expect(backupSpace(disk, 100 * MB)).toEqual({ ok: true });
    expect(backupSpace(disk, 1.5 * GB)).toMatchObject({ ok: false, why: 'fit' });
    expect(backupSpace({ ...disk, freeBytes: -1, level: 'unknown' }, 10 * GB)).toEqual({ ok: true }); // unknown: never blocks
    expect(BACKUP_MIN_FREE_BYTES).toBe(2 * GB);
    expect(CHAT_MIN_FREE_BYTES).toBe(500 * MB);
  });

  it('Compact needs twice the database size free', () => {
    const disk = { path: '', freeBytes: 3 * GB, totalBytes: 100 * GB, level: 'ok' as const, checkedAt: 0 };
    expect(compactSpace(disk, 1 * GB)).toEqual({ ok: true });
    expect(compactSpace(disk, 1.4 * GB)).toMatchObject({ ok: false, text: expect.stringContaining('twice the database') });
  });

  it('the disk is checked at start and hourly; a level change is reported', async () => {
    const t = scratch(false);
    let free = 50 * GB;
    const changes: string[] = [];
    const m = new DiskMonitor({ dir: t.dir, statfs: async () => ({ bavail: free / 4096, bsize: 4096, blocks: 1e9 }), intervalMs: 20, onChange: (d) => changes.push(d.level) });
    expect((await m.start()).level).toBe('ok');
    free = 1 * GB;
    await new Promise((r) => setTimeout(r, 120));
    m.stop();
    expect(m.status?.level).toBe('low');
    expect(changes).toEqual(['ok', 'low']);
  });
});

// ------------------------------------------------------------------------------------------
// Retention whether or not a backup is made (verifier round 1)
// ------------------------------------------------------------------------------------------

describe('T-BAK-2 / T-BAK-4: the caps hold when backups are skipped, and a clock problem never stops them', () => {
  it('a backup skipped for low disk still removes the backups past 35 days (that is what frees the space)', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const now = new Date(2026, 5, 20, 9, 0).getTime();
    for (const d of [50, 45, 40, 10]) {
      const r = await createBackup({ dataDir: t.dir, key, reason: 'start', now: now - d * DAY_MS, ignoreDisk: true, retention: false });
      expect(r.ok).toBe(true);
    }
    const r = await createBackup({ dataDir: t.dir, key, reason: 'daily', now, statfs: statfsFree(1.5 * GB) });
    expect(r).toMatchObject({ ok: false, skipped: 'disk' });
    expect(listBackups(t.dir, { now }).map((b) => Math.round((now - b.createdAt) / DAY_MS))).toEqual([10]);
    // With no database at all (nothing to back up) the caps still apply.
    fs.rmSync(t.db);
    await createBackup({ dataDir: t.dir, key, reason: 'daily', now: now + 30 * DAY_MS, ignoreDisk: true });
    expect(listBackups(t.dir, { now: now + 30 * DAY_MS })).toEqual([]);
  });

  it('a future-stamped backup never counts as the last one, and retention renames it to its (sane) mtime so it ages out', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const now = new Date(2026, 5, 20, 9, 0).getTime();
    const glitch = await createBackup({ dataDir: t.dir, key, reason: 'daily', now: now + 400 * DAY_MS, ignoreDisk: true, retention: false });
    if (!glitch.ok) throw new Error('backup failed');
    // Only the name is ahead: the file itself was written two days ago (copied in under another clock's name).
    fs.utimesSync(glitch.file, new Date(now - 2 * DAY_MS), new Date(now - 2 * DAY_MS));
    const l1 = listBackups(t.dir, { now });
    expect(l1).toEqual([expect.objectContaining({ name: glitch.name, future: true })]);
    expect(l1[0]!.createdAt).toBeLessThanOrEqual(now);
    expect(lastBackupAt(l1)).toBeNull(); // so the start backup and the daily one still run
    expect(startBackupReason({ migrationPending: false, lastBackupAt: lastBackupAt(l1), now, dbExists: true })).toBe('start');
    // Within the hour's slack it is an ordinary backup (a DST shift).
    expect(listBackups(t.dir, { now: now + 400 * DAY_MS - 30 * 60_000 })[0]!.future).toBe(false);
    applyRetention(t.dir, { now });
    const l2 = listBackups(t.dir, { now });
    expect(l2).toHaveLength(1);
    expect(l2[0]).toMatchObject({ cls: 'daily', future: false });
    expect(l2[0]!.createdAt).toBeLessThanOrEqual(now);
    expect(Math.abs(l2[0]!.createdAt - (now - 2 * DAY_MS))).toBeLessThan(60_000); // never earlier than its mtime
    expect(l2[0]!.name).not.toBe(glitch.name);
    // … and it goes like any other 35 days after it was written.
    applyRetention(t.dir, { now: now + 32 * DAY_MS });
    expect(listBackups(t.dir, { now: now + 32 * DAY_MS })).toHaveLength(1);
    applyRetention(t.dir, { now: now + 34 * DAY_MS });
    expect(listBackups(t.dir, { now: now + 34 * DAY_MS })).toEqual([]);
  });

  it('a start with the clock far behind (a flat CMOS battery) renames and deletes nothing: when the clock is right again every backup is still there', async () => {
    // The verifier's round-3 probe: 7 dailies, then one retention pass at 2000-01-01, then one at the real time.
    const t = scratch();
    seed(t);
    const key = key32();
    const real = new Date(2026, 8, 29, 8, 0).getTime();
    for (let d = 6; d >= 0; d--) {
      const r = await createBackup({ dataDir: t.dir, key, reason: 'daily', now: real - d * DAY_MS, ignoreDisk: true, retention: false });
      if (!r.ok) throw new Error('backup failed');
      fs.utimesSync(r.file, new Date(real - d * DAY_MS), new Date(real - d * DAY_MS)); // written at that (right) time
    }
    const names = (now: number): string[] => listBackups(t.dir, { now }).map((b) => b.name).sort();
    const before = names(real);
    expect(before).toHaveLength(7);
    const wrong = new Date(2000, 0, 1, 8, 0).getTime();
    expect(applyRetention(t.dir, { now: wrong, key })).toEqual([]);
    const atWrong = listBackups(t.dir, { now: wrong });
    expect(names(wrong)).toEqual(before); // not renamed to the wrong "now"
    expect(atWrong.every((b) => b.future)).toBe(true);
    expect(lastBackupAt(atWrong)).toBeNull(); // so a start backup is still made
    expect(clockBanner(atWrong, wrong)).toMatchObject({ code: 'clock-behind', text: expect.stringContaining('7 backup(s)') });
    // The start backup made at the wrong clock, then the clock syncs.
    const s = await createBackup({ dataDir: t.dir, key, reason: 'start', now: wrong, ignoreDisk: true });
    expect(s).toMatchObject({ ok: true, removed: [] });
    expect(applyRetention(t.dir, { now: real + 3600_000, key })).toEqual([s.ok ? s.name : '']); // only the one stamped 2000
    expect(names(real + 3600_000)).toEqual(before);
    expect(clockBanner(listBackups(t.dir, { now: real + 3600_000 }), real + 3600_000)).toBeNull();
  });

  it('the off-PC copy keeps the same rule: a copy whose file is ahead of the clock too is never pruned on a guess', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const target = path.join(t.dir, 'usb');
    const real = new Date(2026, 8, 29, 8, 0).getTime();
    for (let d = 3; d >= 0; d--) {
      const r = await createBackup({ dataDir: t.dir, key, reason: 'daily', now: real - d * DAY_MS, ignoreDisk: true, retention: false });
      if (!r.ok) throw new Error('backup failed');
    }
    const c1 = await copyBackups(t.dir, target, { now: real, key });
    expect(c1.copied).toHaveLength(4);
    const folder = c1.folder;
    for (const n of fs.readdirSync(folder)) fs.utimesSync(path.join(folder, n), new Date(real), new Date(real));
    // The clock goes back: nothing at the target is removed.
    const c2 = await copyBackups(t.dir, target, { now: new Date(2000, 0, 1).getTime(), key });
    expect(c2.removed).toEqual([]);
    expect(fs.readdirSync(folder).filter((n) => n.endsWith('.vsbak'))).toHaveLength(4);
  });

  it("another install's backups (copied in to move its data) have their own caps: they never push this install's out, nor go first", async () => {
    // The verifier's attack 2: the old PC's 7 dailies copied into data\backups beside this PC's own 7.
    const t = scratch();
    seed(t);
    const mine = key32();
    const theirs = key32();
    const now = new Date(2026, 5, 20, 12, 0).getTime();
    for (let d = 6; d >= 0; d--) {
      for (const [k, h] of [[theirs, 3], [mine, 5]] as const) {
        const r = await createBackup({ dataDir: t.dir, key: k, reason: 'daily', now: now - d * DAY_MS - h * 3600_000, ignoreDisk: true, retention: false });
        expect(r.ok).toBe(true);
      }
    }
    expect(applyRetention(t.dir, { now, key: mine })).toEqual([]);
    expect(applyRetention(t.dir, { now })).toEqual([]); // no key known: each key keeps its own 7
    const by = (k: Uint8Array): number => listBackups(t.dir, { key: k, now }).filter((b) => b.ownKey).length;
    expect([by(mine), by(theirs)]).toEqual([7, 7]);
    // The size cap is this install's budget: over it, only its own oldest go.
    const sizes = listBackups(t.dir, { now }).map((b) => b.size);
    const capMB = (sizes.reduce((s, x) => s + x, 0) / 2) / MB; // about the size of one install's set
    const removed = applyRetention(t.dir, { now, key: mine, sizeCapMB: capMB * 0.5 });
    expect(removed.length).toBeGreaterThan(0);
    expect(by(theirs)).toBe(7);
    // Their age cap still holds: nothing kept past 35 days.
    expect(applyRetention(t.dir, { now: now + 40 * DAY_MS, key: mine }).length).toBe(7 + 7 - removed.length);
    expect(listBackups(t.dir, { now: now + 40 * DAY_MS })).toEqual([]);
  });

  it('the backup a staged restore waits for is never rotated away before the restart', async () => {
    const t = scratch();
    seed(t);
    const key = key32();
    const now = new Date(2026, 5, 20, 9, 0).getTime();
    const old = await createBackup({ dataDir: t.dir, key, reason: 'manual', now: now - 34 * DAY_MS, ignoreDisk: true });
    if (!old.ok) throw new Error('backup failed');
    const { stageRestore } = await import('./restoreStage');
    expect(stageRestore(t.dir, { backup: old.name, by: 'host:teacher', now }, { key }).ok).toBe(true);
    expect(applyRetention(t.dir, { now: now + 2 * DAY_MS })).toEqual([]);
    expect(fs.existsSync(old.file)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------
// Build round 2: plaintext leftovers of a crashed backup; the "Chat is NOT being logged" banner
// ------------------------------------------------------------------------------------------

describe('T-BAK-1 / T-BAK-4: leftovers and a full drive', () => {
  it('a plaintext snapshot left by a process that is gone is removed at once; a live one only after an hour', () => {
    const t = scratch(false);
    const dir = path.join(t.dir, 'backups');
    fs.mkdirSync(dir);
    const dead = 999_999_001;
    const live = 999_999_002;
    const files = [
      `.snapshot-${dead}-ab12cd34.db`, `.snapshot-${dead}-ab12cd34.db-wal`, `.2026-09-28_0712_manual.vsbak.${dead}.ab12cd34.tmp`,
      `.snapshot-${live}-ef56ab78.db`, `.snapshot-${process.pid}-0a0b0c0d.db`,
    ];
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'plaintext');
    expect(tempFilePid(files[0]!)).toBe(dead);
    expect(tempFilePid(files[2]!)).toBe(dead);
    expect(tempFilePid('2026-09-28_0712_manual.vsbak')).toBeNull();
    const alive = (pid: number): boolean => pid !== dead;
    expect(cleanupBackupTemp(t.dir, Date.now(), alive)).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual([`.snapshot-${live}-ef56ab78.db`, `.snapshot-${process.pid}-0a0b0c0d.db`].sort());
    // An hour later even a live process's leftover goes (a hung backup never keeps a plaintext copy for long).
    expect(cleanupBackupTemp(t.dir, Date.now() + 61 * 60_000, alive)).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('a chat write that fails with SQLITE_FULL or an I/O error raises "Chat is NOT being logged"; other errors do not', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA max_page_count = 3; CREATE TABLE t (x TEXT)');
    let full: unknown = null;
    try { for (let i = 0; i < 100; i++) db.prepare('INSERT INTO t VALUES (?)').run('x'.repeat(1000)); } catch (e) { full = e; }
    db.close();
    expect(full).not.toBeNull();
    expect(isStorageFailure(full)).toBe(true);
    expect(chatWriteBanner(full)).toEqual({ code: 'chat-not-logged', level: 'urgent', text: CHAT_NOT_LOGGED_TEXT });
    expect(CHAT_NOT_LOGGED_TEXT).toMatch(/^Chat is NOT being logged/);
    expect(chatWriteBanner({ errcode: 10 | (3 << 8), message: 'disk I/O error' })).not.toBeNull(); // SQLITE_IOERR_WRITE
    expect(chatWriteBanner(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).not.toBeNull();
    expect(chatWriteBanner(new Error('UNIQUE constraint failed: chat_log.id'))).toBeNull();
    expect(chatWriteBanner({ errcode: 19, message: 'constraint failed' })).toBeNull();
    expect(chatWriteBanner(null)).toBeNull();
  });
});
