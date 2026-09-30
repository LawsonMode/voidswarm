// OWNER: SERVER MODERATION (LAN task B8a). ModStore v0.6 (docs/LAN-EDITION-proposal.md §5.7, §5.8, §6.4, §6.6):
// room_uid / display on every row, chat_tags and conduct_daily written with the line, the FTS index following the
// log, reports kept as chat ids plus shown-only copies, pruning / purging with their dependants, the bounded point
// queries, and the protected connection. Generated names only; school examples use caldwellschools.org.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { ChatLogEntry } from '../../shared/room/moderation';
import { checkUntrustedAuthDb, MIGRATIONS } from '../auth/store';
import { isProtected } from '../db/guard';
import { dayOf, indexDirtyRows } from '../maint/erase';
import { TS_DISORDER_KEY, tsDisorderOf } from '../maint/queries';
import { addAccount, count, open, tmpData, type TmpData } from '../maint/testutil';
import {
  ACTIONS_NAME_SCAN, ADDRESS_SCAN_ROWS, FTS_MERGE_SETTINGS, ftsMergeTunable, GAME_THREAD_STORE_OPTIONS, INLINE_STORE_OPTIONS, isBusyError,
  MOD_SCHEMA_MIN, ModStore, PRUNE_CHUNK, reportLineOf,
} from './store';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);

let t: TmpData;
let db: DatabaseSync;
let store: ModStore;

beforeEach(() => {
  t = tmpData('vs-modstore-');
  store = new ModStore(t.db, { log: () => {} });
  db = open(t.db);
  addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
});

afterEach(() => {
  try { store.close(); } catch { /* closed */ }
  try { db.close(); } catch { /* closed */ }
  t.cleanup();
});

let seq = 0;
const entry = (e: Partial<ChatLogEntry> & { original: string }): ChatLogEntry => ({
  time: e.time ?? T0 + (++seq) * 1000, roomId: e.roomId === undefined ? 'r1' : e.roomId, roomName: e.roomName ?? 'Flag Run',
  roomUid: e.roomUid === undefined ? 'bootA:r1' : e.roomUid, channel: e.channel ?? 'all', team: e.team ?? -1, playerId: e.playerId ?? 1,
  name: e.name ?? 'NovaPilot', accountId: e.accountId === undefined ? 'acc-nova' : e.accountId, address: e.address === undefined ? '10.0.0.5' : e.address,
  original: e.original, shown: e.shown ?? e.original, action: e.action ?? 'pass', hits: e.hits ?? [], display: e.display,
});
const put = (e: Partial<ChatLogEntry> & { original: string }): number => {
  store.logChat(entry(e));
  store.flushAll();
  return Number((db.prepare('SELECT max(id) AS m FROM chat_log').get() as { m: number }).m);
};
const tagsOf = (id: number): string[] => (db.prepare('SELECT tag FROM chat_tags WHERE chat_id = ? ORDER BY tag').all(id) as { tag: string }[]).map((r) => r.tag);
const conduct = (): [string, number, string, number][] =>
  (db.prepare('SELECT account_key, day, tag, n FROM conduct_daily ORDER BY account_key, day, tag').all() as { account_key: string; day: number; tag: string; n: number }[])
    .map((r) => [r.account_key, Number(r.day), r.tag, Number(r.n)]);
const fts = (text: string): number[] => (db.prepare('SELECT rowid FROM chat_fts WHERE chat_fts MATCH ? ORDER BY rowid').all(`"${text}"`) as { rowid: number }[]).map((r) => Number(r.rowid));

describe('the chat-log insert (v0.6)', () => {
  it('stores room_uid and display, the line\'s tags in chat_tags, and the counted ones in conduct_daily', () => {
    const plain = put({ original: 'hello there' });
    const sub = put({ original: 'zorblax', shown: 'GG, pilots!', action: 'mask', hits: ['profanity:zorblax', 'slur:q'], display: 'substituted' });
    const again = put({ original: 'zorblax again', shown: 'Nice moves!', action: 'mask', hits: ['profanity:zorblax'], display: 'substituted' });
    const wb = put({ original: '(generated wellbeing line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' });
    const review = put({ original: 'meet at the spot', action: 'flag', hits: ['flag:gang:spot'], accountId: null, name: 'Guest_Nine' });
    const nameRow = put({ original: 'RudeName', shown: '', channel: 'name', action: 'block', hits: ['profanity:x'], display: 'hidden', accountId: null, name: 'Guest_Nine' });
    const lobby = put({ original: 'in the lobby', roomId: null, roomUid: 'bootA:zone', roomName: 'Zone' });
    const legacyProducer = put({ original: 'old producer', roomUid: null, display: undefined });
    const rows = db.prepare('SELECT id, room_uid, display FROM chat_log ORDER BY id').all() as { id: number; room_uid: string | null; display: string }[];
    expect(rows.map((r) => [r.room_uid, r.display])).toEqual([
      ['bootA:r1', 'as-typed'], ['bootA:r1', 'substituted'], ['bootA:r1', 'substituted'], ['bootA:r1', 'withheld'], ['bootA:r1', 'as-typed'],
      ['bootA:r1', 'hidden'], ['bootA:zone', 'as-typed'], [null, 'as-typed'],
    ]);
    expect(tagsOf(plain)).toEqual([]);
    expect(tagsOf(sub)).toEqual(['HATE', 'PROFANITY']);
    expect(tagsOf(wb)).toEqual(['SELF-HARM']);
    expect(tagsOf(review)).toEqual(['GANG']);
    expect(tagsOf(nameRow)).toEqual(['PROFANITY']);
    expect(tagsOf(lobby).concat(tagsOf(legacyProducer))).toEqual([]);
    expect((db.prepare('SELECT account_id, ts FROM chat_tags WHERE chat_id = ? LIMIT 1').get(sub) as { account_id: string }).account_id).toBe('acc-nova');
    const day = dayOf(T0);
    // no SELF-HARM counter, "review:" for a review-only hit, a guest by callsign key, no PROFANITY for a name
    expect(conduct()).toEqual([
      ['acc-nova', day, 'HATE', 1], ['acc-nova', day, 'PROFANITY', 2], ['g:guest_nine', day, 'review:GANG', 1],
    ]);
    void again;
  });

  it('a wellbeing line adds nothing to conduct_daily, whatever other words it holds (§5.11); chat_tags keeps its tags', () => {
    // a self-harm statement with a swear word in it (the Zone withholds it: no strike), with a threat, while muted,
    // as a refused name, and one withheld whose self-harm label fell past the labels kept
    const withSwear = put({ original: '(generated wellbeing line 1)', shown: '', action: 'block', hits: ['selfharm:x', 'profanity:y'], display: 'withheld' });
    const withThreat = put({ original: '(generated wellbeing line 2)', shown: '', action: 'block', hits: ['threat:z', 'selfharm:x'], display: 'withheld', channel: 'team', team: 1 });
    put({ original: '(generated wellbeing line 3)', shown: '', action: 'muted', hits: ['selfharm:x', 'slur:q'], display: 'withheld' });
    put({ original: '(generated wellbeing name)', shown: '', channel: 'name', action: 'block', hits: ['slur:q', 'selfharm:x'], display: 'withheld', accountId: null, name: 'Guest_Four' });
    put({ original: '(generated wellbeing line 4)', shown: '', action: 'muted', hits: ['profanity:y'], display: 'withheld' });
    expect(conduct()).toEqual([]);
    expect(tagsOf(withSwear)).toEqual(['PROFANITY', 'SELF-HARM']);
    expect(tagsOf(withThreat)).toEqual(['SELF-HARM', 'THREAT']);
    // a line substituted for its swear word that ALSO matched a review-only self-harm term: its swear word counts
    put({ original: '(generated review line)', shown: 'GG, pilots!', action: 'mask', hits: ['profanity:y', 'flag:selfharm:w'], display: 'substituted' });
    expect(conduct()).toEqual([['acc-nova', dayOf(T0), 'PROFANITY', 1]]);
  });

  it('the FTS index follows inserts, updates and deletes (triggers; no FTS secure-delete)', () => {
    const a = put({ original: 'nice shot pilot' });
    const b = put({ original: 'going left', shown: 'going left' });
    expect(fts('ice sho')).toEqual([a]);
    db.prepare("UPDATE chat_log SET original = 'wide right', shown = 'wide right' WHERE id = ?").run(b);
    expect(fts('left')).toEqual([]);
    expect(fts('de rig')).toEqual([b]);
    db.prepare('DELETE FROM chat_log WHERE id = ?').run(a);
    expect(fts('ice sho')).toEqual([]);
    const cfg = db.prepare('SELECT k, v FROM chat_fts_config ORDER BY k').all() as { k: string }[];
    expect(cfg.map((r) => r.k)).not.toContain('secure-delete');
  });

  it('txRows splits a flush into small transactions; a time budget leaves the rest buffered; flushAll ignores it', () => {
    expect(GAME_THREAD_STORE_OPTIONS).toEqual({ walAutoCheckpoint: 0, txRows: 1, flushBudgetMs: 3, ftsMerge: 'worker' });
    expect(INLINE_STORE_OPTIONS).toEqual({ ftsMerge: 'inline' });
    const s = new ModStore(t.db, { log: () => {}, txRows: 1, flushBudgetMs: 1e-9 });
    try {
      for (let i = 0; i < 5; i++) s.logChat(entry({ original: `line ${i}` }));
      expect(s.flush()).toBe(1);
      expect(s.pending).toBe(4);
      expect(s.flushAll()).toBe(4);
      expect(count(db, 'SELECT count(*) AS n FROM chat_log')).toBe(5);
    } finally { s.close(); }
    const batched = new ModStore(t.db, { log: () => {}, txRows: 50 });
    try {
      for (let i = 0; i < 60; i++) batched.logChat(entry({ original: `b ${i}` }));
      expect(batched.flush()).toBe(50);
      expect(batched.pending).toBe(10);
    } finally { batched.close(); }
    // a writer holding the lock: the line stays buffered, nothing is lost
    const other = new DatabaseSync(t.db);
    store.logChat(entry({ original: 'while busy' }));
    other.exec('BEGIN IMMEDIATE');
    try {
      let err: unknown = null;
      try { store.flush(); } catch (e) { err = e; }
      expect(isBusyError(err)).toBe(true);
      expect(store.busySince).toEqual(expect.any(Number));
      expect(store.pending).toBe(1);
    } finally { other.exec('COMMIT'); other.close(); }
    expect(store.flush()).toBe(1);
    expect(store.busySince).toBeNull();
    expect(isBusyError(new Error('no such table: x'))).toBe(false);
  });

  it('close() waits for another writer\'s lock to write the last lines (the per-tick flush never waits)', async () => {
    const logs: string[] = [];
    const s = new ModStore(t.db, { log: (l) => logs.push(l), busyTimeoutMs: 250 });
    for (let i = 0; i < 10; i++) s.logChat(entry({ original: `last ${i}` }));
    // another thread holds the write lock for ~300 ms (a worker chunk, a merge step, a Stop-time optimize)
    const w = new Worker(`
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      const end = Date.now() + 300; while (Date.now() < end) {}
      db.exec('COMMIT'); db.close();
    `, { eval: true, workerData: t.db });
    const exited = new Promise<void>((r) => w.on('exit', () => r()));
    await new Promise<void>((r) => w.on('message', (m) => { if (m === 'locked') r(); }));
    expect(() => s.flush()).toThrow(/locked/);
    expect(s.pending).toBe(10);
    s.close();
    await exited;
    expect(count(db, "SELECT count(*) AS n FROM chat_log WHERE original LIKE 'last %'")).toBe(10);
    expect(logs.filter((l) => /lines lost/.test(l))).toEqual([]);
  });

  it('addAction never waits for another writer (§5.16): the rows queue in order and the next write, flush or read takes them first', () => {
    const s = new ModStore(t.db, { log: () => {}, busyTimeoutMs: 5000 });
    const act = (reason: string, ts: number) => ({ ts, actorAccountId: 'cli', actorName: 'cli', action: 'kick' as const, targetName: 'Guest7', targetAddress: '10.0.0.9', reason });
    const other = new DatabaseSync(t.db);
    try {
      other.exec('BEGIN IMMEDIATE');
      try {
        const t0 = performance.now();
        expect(s.addAction(act('first', T0))).toBe(0);
        expect(s.addAction(act('second', T0 + 1))).toBe(0);
        // the connection's 5 s busy_timeout was not waited for (a game-thread audit insert must never stall the tick)
        expect(performance.now() - t0).toBeLessThan(500);
        expect(s.pendingActions).toBe(2);
        expect(s.pending).toBe(2);
        expect(s.listActions({}).actions).toEqual([]);
        expect(() => s.flush()).toThrow(/locked/);
        expect(s.pendingActions).toBe(2);
      } finally { other.exec('COMMIT'); }
      // the next flush writes them first (a chat line or none)
      s.logChat(entry({ original: 'after the chunk' }));
      expect(s.flush()).toBe(1);
      expect(s.pending).toBe(0);
      const rows = s.listActions({}).actions;
      expect(rows.map((r) => r.reason)).toEqual(['second', 'first']);
      expect(rows[1]).toMatchObject({ ts: T0, action: 'kick', targetName: 'Guest7', targetAddress: '10.0.0.9', actor: 'cli' });
      // a free lock: written at once, its id returned
      const third = s.addAction(act('third', T0 + 2));
      expect(third).toBeGreaterThan(rows[0]!.id);
      // queued while busy, then a read with the lock free writes the queue before it answers
      other.exec('BEGIN IMMEDIATE');
      try { expect(s.addAction(act('fourth', T0 + 3))).toBe(0); } finally { other.exec('COMMIT'); }
      expect(s.listActions({ targetName: 'Guest7' }).actions.map((r) => r.reason)).toEqual(['fourth', 'third', 'second', 'first']);
      expect(s.pendingActions).toBe(0);
      // queued rows are never lost at close (it waits for the lock like the chat lines)
      other.exec('BEGIN IMMEDIATE');
      try { expect(s.addAction(act('fifth', T0 + 4))).toBe(0); } finally { other.exec('COMMIT'); }
      s.close();
      expect(count(db, "SELECT count(*) AS n FROM mod_actions WHERE reason = 'fifth'")).toBe(1);
      expect(() => s.addAction(act('closed', T0 + 5))).toThrow(/closed/);
    } finally { other.close(); s.close(); }
  });

  it('ban, report and moderator writes take noWait: a game-thread caller fails fast (SQLITE_BUSY) instead of waiting', () => {
    const s = new ModStore(t.db, { log: () => {}, busyTimeoutMs: 3000 });
    const inner = (s as unknown as { db: DatabaseSync }).db;
    const party = { playerId: 3, name: 'Guest7', accountId: null, address: '10.0.0.9' };
    const newBan = { kind: 'mute' as const, scope: 'account' as const, accountId: 'acc-nova', username: 'NovaPilot', address: null, createdAt: T0, expiresAt: null, reason: 'spam', by: 'cli' };
    const other = new DatabaseSync(t.db);
    try {
      const ban = s.addBan(newBan);
      const rep = s.addReport({ ts: T0, reporter: party, target: { ...party, name: 'NovaPilot', accountId: 'acc-nova' }, reason: 'spam', room: 'Flag Run', recentChat: [] });
      const writes: [string, () => unknown][] = [
        ['addBan', () => s.addBan(newBan, T0, { noWait: true })],
        ['revokeBan', () => s.revokeBan(ban.id, T0, { noWait: true })],
        ['addReport', () => s.addReport({ ts: T0, reporter: party, target: party, reason: 'x', room: 'r', recentChat: [] }, { noWait: true })],
        ['reviewReport', () => s.reviewReport(rep.id, 'reviewed', 'cli', T0, null, { noWait: true })],
        ['addAdmin', () => s.addAdmin('acc-nova', 'cli', T0, { noWait: true })],
        ['removeAdmin', () => s.removeAdmin('acc-nova', { noWait: true })],
      ];
      other.exec('BEGIN IMMEDIATE');
      try {
        for (const [name, run] of writes) {
          const t0 = performance.now();
          let err: unknown = null;
          try { run(); } catch (e) { err = e; }
          expect(isBusyError(err), name).toBe(true);
          expect(performance.now() - t0, name).toBeLessThan(500);
        }
      } finally { other.exec('COMMIT'); }
      // the connection's own busy_timeout is back, and the same writes go through once the lock is free
      expect(Number((inner.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout)).toBe(3000);
      expect(s.revokeBan(ban.id, T0 + 1, { noWait: true })).toBe(true);
      expect(s.reviewReport(rep.id, 'reviewed', 'cli', T0, 'ok', { noWait: true })).toMatchObject({ status: 'reviewed', note: 'ok' });
      expect(s.addAdmin('acc-nova', 'cli', T0, { noWait: true })).toBe(true);
      expect(s.removeAdmin('acc-nova', { noWait: true })).toBe(true);
    } finally { other.close(); s.close(); }
  });

  it('a lock busy at open leaves the wanted FTS merge mode pending: the next flush sets it first (never inline for the session)', () => {
    const logs: string[] = [];
    const other = new DatabaseSync(t.db);
    other.exec('BEGIN IMMEDIATE'); // the worker's start-up tidy (an FTS optimize, 1-4 s at 1M lines)
    let s: ModStore;
    try {
      s = new ModStore(t.db, { log: (l) => logs.push(l), busyTimeoutMs: 20, ...GAME_THREAD_STORE_OPTIONS, ftsTunable: true });
      expect(s.ftsMergePending).toBe(true);
      expect(s.ftsMergeMode()).toBe('inline');
      expect(logs.some((l) => /not set yet .*tries again/.test(l))).toBe(true);
      // still busy at the next flush: the line stays buffered, the mode stays pending
      s.logChat(entry({ original: 'during the tidy' }));
      expect(() => s.flush()).toThrow(/locked/);
      expect(s.ftsMergePending).toBe(true);
    } finally { other.exec('COMMIT'); other.close(); }
    try {
      expect(s.flush()).toBe(1);
      expect(s.ftsMergePending).toBe(false);
      expect(s.ftsMergeMode()).toBe('worker');
      expect(logs.some((l) => /'worker' is set now/.test(l))).toBe(true);
      // later switches (the worker stopped) are wanted modes too
      expect(s.setFtsMerge('inline')).toEqual({ ok: true, changed: true });
      expect(s.ftsMergeMode()).toBe('inline');
      // not tunable is final, never retried
      const locked = new ModStore(t.db, { log: () => {}, ftsMerge: 'worker', ftsTunable: false });
      try { expect(locked.ftsMergePending).toBe(false); } finally { locked.close(); }
    } finally { s.close(); }
  });

  it('FTS merges: ftsMerge \'worker\' turns automerge off (the worker merges), \'inline\' restores the defaults; only where the guard allows it', () => {
    const cfg = (): Record<string, number> => Object.fromEntries((db.prepare('SELECT k, v FROM chat_fts_config ORDER BY k').all() as { k: string; v: number }[])
      .map((r) => [r.k, Number(r.v)]));
    const fresh = cfg();
    // Not tunable (what this build's guard says unless it leaves the merge settings out): refused, nothing written.
    const locked = new ModStore(t.db, { log: () => {}, ftsMerge: 'worker', ftsTunable: false });
    try {
      expect(locked.setFtsMerge('worker')).toMatchObject({ ok: false, changed: false, reason: expect.stringMatching(/guard/) });
      expect(locked.ftsMergeMode()).toBe('inline');
      expect(cfg()).toEqual(fresh);
      // 'inline' on a database at FTS5's defaults writes nothing either
      expect(locked.setFtsMerge('inline')).toEqual({ ok: true, changed: false });
    } finally { locked.close(); }
    const w = new ModStore(t.db, { log: () => {}, ...GAME_THREAD_STORE_OPTIONS, ftsTunable: true });
    try {
      expect(w.ftsMergeMode()).toBe('worker');
      expect(cfg()).toMatchObject({ automerge: FTS_MERGE_SETTINGS.worker.automerge, crisismerge: FTS_MERGE_SETTINGS.worker.crisismerge });
      // lines still reach the index (the merges are the worker's), and a second set is a no-op
      w.logChat(entry({ original: 'merge mode line' }));
      w.flushAll();
      expect(count(db, 'SELECT count(*) AS n FROM chat_fts WHERE chat_fts MATCH ?', '"mode lin"')).toBe(1);
      expect(w.setFtsMerge('worker')).toEqual({ ok: true, changed: false });
      expect(w.setFtsMerge('inline')).toEqual({ ok: true, changed: true });
      expect(cfg()).toMatchObject({ automerge: 4, crisismerge: 16 });
      expect(w.ftsMergeMode()).toBe('inline');
    } finally { w.close(); }
    // The probe says what a restore would do with such a database: refused as "changed fts settings" unless tunable.
    const probe = tmpData('vs-modstore-fts-');
    try {
      const m = new ModStore(probe.db, { log: () => {}, ftsMerge: 'worker', ftsTunable: true });
      m.close();
      if (ftsMergeTunable()) expect(() => checkUntrustedAuthDb(probe.db, { integrity: 'quick' })).not.toThrow();
      else expect(() => checkUntrustedAuthDb(probe.db, { integrity: 'quick' })).toThrow(/fts settings/);
    } finally { probe.cleanup(); }
  });

  it('the clock disorder: measured at open when a database has none, raised in the insert\'s transaction when the clock goes back', () => {
    expect(tsDisorderOf(db)).toBe(0);
    store.logChat(entry({ original: 'at noon', time: T0 + 12 * 60 * MIN }));
    store.logChat(entry({ original: 'clock set back 40 min', time: T0 + 12 * 60 * MIN - 40 * MIN }));
    store.logChat(entry({ original: 'back 10 more', time: T0 + 12 * 60 * MIN - 30 * MIN }));
    store.flushAll();
    expect(tsDisorderOf(db)).toBe(40 * MIN);
    // a later, smaller jump does not lower it
    store.logChat(entry({ original: 'forward', time: T0 + 13 * 60 * MIN }));
    store.logChat(entry({ original: 'back 5', time: T0 + 13 * 60 * MIN - 5 * MIN }));
    store.flushAll();
    expect(tsDisorderOf(db)).toBe(40 * MIN);
    // a database without the key (a v0.5 server's lines): measured when a store opens it
    db.prepare('DELETE FROM mod_meta WHERE k = ?').run(TS_DISORDER_KEY);
    db.prepare(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address, original, shown, action, hits)
                VALUES (?, 'r1', 'x', 'all', -1, 2, 'Guest7', 'guest7', NULL, '10.0.0.9', 'legacy', 'legacy', 'pass', '[]')`).run(T0 - 2 * DAY);
    expect(tsDisorderOf(db)).toBeNull();
    const again = new ModStore(t.db, { log: () => {} });
    again.close();
    expect(tsDisorderOf(db)).toBe(13 * 60 * MIN + 2 * DAY);
    // another writer holding the lock at open (the worker's start-up tidy) does not fail the open: the next flush
    // saves the measured value first (never a smaller one from a later jump)
    db.prepare('DELETE FROM mod_meta WHERE k = ?').run(TS_DISORDER_KEY);
    const other = new DatabaseSync(t.db);
    other.exec('BEGIN IMMEDIATE');
    let late: ModStore | null = null;
    try {
      late = new ModStore(t.db, { log: () => {}, busyTimeoutMs: 20 });
    } finally { other.exec('COMMIT'); other.close(); }
    try {
      expect(tsDisorderOf(db)).toBeNull();
      late.logChat(entry({ original: 'after the tidy', time: T0 + 14 * 60 * MIN - MIN }));
      late.flushAll();
      expect(tsDisorderOf(db)).toBe(13 * 60 * MIN + 2 * DAY);
    } finally { late.close(); }
  });

  it('walAutoCheckpoint 0 = this connection never checkpoints; checkpoint() does it on demand; the connection is protected', () => {
    const s = new ModStore(t.db, { log: () => {}, walAutoCheckpoint: 0 });
    const inner = (s as unknown as { db: DatabaseSync }).db;
    try {
      expect(Number((inner.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint)).toBe(0);
      expect(isProtected(inner)).toBe(true);
      expect(Number((inner.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete)).toBe(1);
      expect(Number((inner.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys)).toBe(1);
      expect(() => inner.exec(`ATTACH '${t.dir.replace(/'/g, "''")}/x.db' AS x`)).toThrow();
      s.logChat(entry({ original: 'x' }));
      s.flushAll();
      expect(s.checkpoint()).toMatchObject({ busy: false });
      // the worker stopped: SQLite's own checkpoints again (and back when it runs again)
      expect(s.setWalAutoCheckpoint(1000)).toBe(1000);
      expect(Number((inner.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint)).toBe(1000);
      expect(s.setWalAutoCheckpoint(0)).toBe(0);
      expect(s.setWalAutoCheckpoint(Number.NaN)).toBe(1000);
    } finally { s.close(); }
    const def = (store as unknown as { db: DatabaseSync }).db;
    expect(Number((def.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint)).toBe(1000);
  });

  it('an ill-shaped entry (a producer bug) is written with safe values and never blocks the lines after it', () => {
    const bad = {
      time: Number.NaN, roomId: undefined, roomName: undefined, channel: undefined, team: 'x', playerId: undefined, name: undefined,
      accountId: undefined, address: undefined, original: undefined, shown: undefined, action: undefined, hits: 'not a list',
    } as unknown as ChatLogEntry;
    store.logChat(bad);
    store.logChat(entry({ original: 'the next line' }));
    expect(store.flushAll()).toBe(2);
    expect(store.pending).toBe(0);
    const rows = db.prepare('SELECT ts, room_id, channel, team, player_id, account_id, address, original, action, hits FROM chat_log ORDER BY id').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ room_id: null, channel: 'all', team: -1, player_id: 0, account_id: null, address: null, original: '', action: 'pass', hits: '[]' });
    expect(Number(rows[0]!.ts)).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ original: 'the next line', account_id: 'acc-nova' });
  });

  it('refuses a database that was not upgraded to v4', () => {
    const dir = tmpData('vs-modstore-v3-', { db: false });
    try {
      const raw = new DatabaseSync(dir.db);
      for (let v = 0; v < 3; v++) raw.exec(MIGRATIONS[v]!);
      raw.exec('PRAGMA user_version = 3');
      raw.close();
      expect(MOD_SCHEMA_MIN).toBe(4);
      expect(() => new ModStore(dir.db, { log: () => {} })).toThrow(/v3 has not been upgraded to v4/);
    } finally { dir.cleanup(); }
  });
});

describe('reports keep ids plus shown-only copies (§6.4)', () => {
  it('never stores the original text, an address or hit labels, whatever the caller passes', () => {
    const lines = [];
    for (let i = 0; i < 25; i++) {
      put({ original: `typed ${i}`, shown: i % 2 ? `typed ${i}` : 'GG, pilots!', action: i % 2 ? 'pass' : 'mask', hits: i % 2 ? [] : ['profanity:x'], display: i % 2 ? 'as-typed' : 'substituted' });
    }
    lines.push(...store.recentChat({ accountId: 'acc-nova' }, 25));
    const r = store.addReport({
      ts: T0, reason: 'mean words', room: 'Flag Run', recentChat: lines,
      reporter: { playerId: 2, name: 'OrionAce', accountId: null, address: '10.0.0.7' },
      target: { playerId: 1, name: 'NovaPilot', accountId: 'acc-nova', address: '10.0.0.5' },
    });
    expect(r.recentChat).toHaveLength(20);
    expect(r.recentIds).toEqual(lines.slice(-20).map((l) => l.id));
    expect(r.recentChat.every((l) => l.original === '' && l.address === null && l.hits.length === 0)).toBe(true);
    expect(r.recentChat[0]).toMatchObject({ id: lines[5]!.id, shown: 'typed 5', display: 'as-typed', roomUid: 'bootA:r1' });
    expect(r.recentChat[1]).toMatchObject({ shown: 'GG, pilots!', display: 'substituted', action: 'mask' });
    const raw = String((db.prepare('SELECT recent_chat_json AS j FROM reports WHERE id = ?').get(r.id) as { j: string }).j);
    expect(raw).not.toMatch(/typed 6|10\.0\.0\.5|profanity:/);
    expect(store.listReports({ status: 'open' }).reports[0]!.recentIds).toEqual(r.recentIds);
    expect(reportLineOf('not a line')).toBeNull();
  });

  it('leaves out the SELF-HARM lines a copy could not mark (review-only ones shown as typed, pre-0.6 ones); a withheld one stays', () => {
    const a = put({ original: 'first line' });
    const withheld = put({ original: '(generated wellbeing line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' });
    // a flag-tier (review-only) self-harm hit is shown as typed: its copy would carry no tag, so it must not be kept
    const review = put({ original: '(generated review line)', action: 'flag', hits: ['flag:selfharm:y'], display: 'as-typed' });
    const b = put({ original: 'last line' });
    const lines = store.recentChat({ accountId: 'acc-nova' }, 20);
    expect(lines.map((l) => l.id)).toEqual([a, withheld, review, b]);
    // a caller's own line objects (no tags, only hit labels, or only a display) are recognised the same way
    const legacy = { ...lines[0]!, id: 999_001, tags: undefined, hits: ['selfharm:z'], display: undefined } as unknown as typeof lines[number];
    const shownOnly = { ...lines[0]!, id: 999_002, tags: [], hits: [], display: 'withheld' } as typeof lines[number];
    const r = store.addReport({
      ts: T0, reason: 'mean words', room: 'Flag Run', recentChat: [...lines, legacy, shownOnly],
      reporter: { playerId: 2, name: 'OrionAce', accountId: null, address: '10.0.0.7' },
      target: { playerId: 1, name: 'NovaPilot', accountId: 'acc-nova', address: '10.0.0.5' },
    });
    // the withheld lines keep display 'withheld' in their copy (the admin API hands those to `wellbeing` only)
    expect(r.recentIds).toEqual([a, withheld, b, 999_002]);
    expect(r.recentChat.map((l) => [l.shown, l.display])).toEqual([['first line', 'as-typed'], ['', 'withheld'], ['last line', 'as-typed'], ['first line', 'withheld']]);
    const raw = String((db.prepare('SELECT recent_chat_json AS j FROM reports WHERE id = ?').get(r.id) as { j: string }).j);
    expect(raw).not.toMatch(/generated/);
    expect(r.recentIds).not.toContain(review);
    expect(r.recentIds).not.toContain(999_001);
  });
});

describe('pruning and purging take their dependants with them', () => {
  it('pruneStep: chat lines (tags cascade), conduct days before the records cutoff, the FTS tidy flag; bounded steps', () => {
    for (let i = 0; i < PRUNE_CHUNK + 20; i++) put({ original: `old ${i}`, time: T0 - 100 * DAY + i, action: 'mask', hits: ['profanity:x'], display: 'substituted' });
    const keep = put({ original: 'recent', time: T0, action: 'mask', hits: ['profanity:x'], display: 'substituted' });
    db.prepare("INSERT INTO conduct_daily (account_key, day, tag, n) VALUES ('acc-old', ?, 'HATE', 2)").run(dayOf(T0 - 400 * DAY));
    const cut = { chatBefore: T0 - 90 * DAY, keepBefore: T0 - 365 * DAY };
    const first = store.pruneStep(cut);
    expect(first).toBe(PRUNE_CHUNK + 1); // one chunk of chat lines + the old counter row
    expect(indexDirtyRows(db)).toBe(PRUNE_CHUNK);
    expect(store.pruneAll(cut)).toBe(20);
    expect(count(db, 'SELECT count(*) AS n FROM chat_log')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM chat_tags')).toBe(1);
    expect(tagsOf(keep)).toEqual(['PROFANITY']);
    expect(conduct().map((c) => c[0])).toEqual(['acc-nova', 'acc-nova']); // the lines' own (recent) days stay
    expect(fts('old 1')).toEqual([]);
  });

  it('purgeChat (the CLI): by age and player; tags, conduct days and report copies go too; the index is marked for tidying', () => {
    const a = put({ original: 'old one', time: T0 - 10 * DAY, action: 'mask', hits: ['profanity:x'] });
    const g = put({ original: 'guest old', time: T0 - 10 * DAY, accountId: null, name: 'Guest3', action: 'mask', hits: ['slur:x'] });
    const c = put({ original: 'new one', time: T0, action: 'mask', hits: ['profanity:x'] });
    const report = (who: 'acc-nova' | null, lines: ReturnType<ModStore['recentChat']>) => store.addReport({
      ts: T0, reason: 'r', room: 'Flag Run', recentChat: lines,
      reporter: { playerId: 2, name: 'OrionAce', accountId: null, address: '10.0.0.7' },
      target: { playerId: 1, name: who ? 'NovaPilot' : 'Guest3', accountId: who, address: '10.0.0.5' },
    });
    const r1 = report('acc-nova', store.recentChat({ accountId: 'acc-nova' }, 20));
    const r2 = report(null, store.recentChat({ nameKey: 'guest3' }, 20));
    expect(r1.recentIds).toEqual([a, c]);
    expect(conduct().map((x) => [x[0], x[1], x[2]])).toEqual([
      ['acc-nova', dayOf(T0 - 10 * DAY), 'PROFANITY'], ['acc-nova', dayOf(T0), 'PROFANITY'], ['g:guest3', dayOf(T0 - 10 * DAY), 'HATE'],
    ]);
    expect(store.purgeChat({ before: T0 - DAY, player: 'NovaPilot' })).toBe(1);
    expect(tagsOf(a)).toEqual([]);
    expect(indexDirtyRows(db)).toBe(1);
    expect(store.searchLog({}).lines.map((l) => l.original)).toEqual(['new one', 'guest old']);
    // that student's counters of the purged days, and the report copy of the purged line; nobody else's
    expect(conduct().map((x) => [x[0], x[1]])).toEqual([['acc-nova', dayOf(T0)], ['g:guest3', dayOf(T0 - 10 * DAY)]]);
    expect(store.getReport(r1.id)!.recentIds).toEqual([c]);
    expect(store.getReport(r1.id)!.recentChat.map((l) => l.id)).toEqual([c]);
    expect(store.getReport(r2.id)!.recentIds).toEqual([g]);
    // a guest callsign's purge, then everyone's
    expect(store.purgeChat({ before: T0 - DAY, player: 'Guest3' })).toBe(1);
    expect(conduct().map((x) => x[0])).toEqual(['acc-nova']);
    expect(store.getReport(r2.id)!.recentChat).toEqual([]);
    expect(store.purgeChat({ before: T0 + DAY })).toBe(1);
    expect(store.searchLog({}).lines).toEqual([]);
    expect(conduct()).toEqual([]);
    expect(store.getReport(r1.id)!).toMatchObject({ recentIds: [], recentChat: [] });
    expect(count(db, 'SELECT count(*) AS n FROM chat_tags')).toBe(0);
  });
});

describe('game-thread point queries stay bounded (T-PERF-2 shapes)', () => {
  it('recentChat / lastSeenByName are newest-by-time; addressesOf looks at the newest ADDRESS_SCAN_ROWS lines', () => {
    const ins = db.prepare(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address, original, shown, action, hits, room_uid, display)
                            VALUES (?, 'r1', 'Room', 'all', -1, 1, 'NovaPilot', 'novapilot', 'acc-nova', ?, ?, ?, 'pass', '[]', 'b:r1', 'as-typed')`);
    db.exec('BEGIN');
    ins.run(T0 - DAY, '10.9.9.9', 'very old', 'very old');
    for (let i = 0; i < ADDRESS_SCAN_ROWS + 5; i++) ins.run(T0 + i, i % 2 ? '10.0.0.1' : '10.0.0.2', `m${i}`, `m${i}`);
    db.exec('COMMIT');
    expect(store.recentChat({ accountId: 'acc-nova' }, 2).map((r) => r.original)).toEqual([`m${ADDRESS_SCAN_ROWS + 3}`, `m${ADDRESS_SCAN_ROWS + 4}`]);
    expect(store.lastSeenByName('novapilot')!.original).toBe(`m${ADDRESS_SCAN_ROWS + 4}`);
    expect(store.addressesOf({ accountId: 'acc-nova' }).sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(store.addressesOf({ nameKey: 'novapilot' })).toEqual([]); // guest lookup: account lines are not a guest's
  });

  it('listActions: account and address matches are exact; a name match looks at the newest ACTIONS_NAME_SCAN audit rows', () => {
    const ins = db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, target_address, reason)
                            VALUES (?, 'host', 'host', ?, ?, ?, ?, '')`);
    db.exec('BEGIN');
    ins.run(T0, 'mute', null, 'Guest5', '10.0.0.8');
    ins.run(T0, 'warn', 'acc-nova', 'NovaPilot', null);
    for (let i = 0; i < ACTIONS_NAME_SCAN; i++) ins.run(T0 + i, 'note', null, `Other${i % 50}`, null);
    ins.run(T0 + ACTIONS_NAME_SCAN, 'kick', null, 'guest5', null);
    db.exec('COMMIT');
    expect(store.listActions({ targetName: 'Guest5' }).actions.map((a) => a.action)).toEqual(['kick']);
    expect(store.listActions({ targetName: 'Guest5', targetAddress: '10.0.0.8' }).actions.map((a) => a.action)).toEqual(['kick', 'mute']);
    expect(store.listActions({ targetAccountId: 'acc-nova' }).actions.map((a) => a.action)).toEqual(['warn']);
    void MIN;
  });

  it('listActions pages a target\'s history newest first by (ts, id), in its index order, merging account / name / address', () => {
    const ins = db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, target_address, reason)
                            VALUES (?, 'host', 'host', 'note', ?, ?, ?, ?)`);
    const add = (ts: number, acc: string | null, name: string | null, addr: string | null, reason: string): number =>
      Number(ins.run(ts, acc, name, addr, reason).lastInsertRowid);
    // written out of time order (the host clock went back once), with other targets in between
    const a1 = add(T0 + 5 * MIN, 'acc-nova', 'NovaPilot', null, 'a1');
    add(T0 + 5 * MIN, 'acc-other', 'OtherPilot', null, 'x');
    const a2 = add(T0 + MIN, 'acc-nova', 'NovaPilot', null, 'a2');
    const a3 = add(T0 + 9 * MIN, 'acc-nova', 'NovaPilot', null, 'a3');
    const a4 = add(T0 + 5 * MIN, 'acc-nova', 'NovaPilot', null, 'a4');
    const a5 = add(T0 + 2 * MIN, 'acc-nova', 'NovaPilot', null, 'a5');
    const order = [a3, a4, a1, a5, a2]; // (ts, id) descending
    expect(store.listActions({ targetAccountId: 'acc-nova' }).actions.map((a) => a.id)).toEqual(order);
    const paged: number[] = [];
    let before: number | undefined;
    for (let k = 0; k < 10; k++) {
      const p = store.listActions({ targetAccountId: 'acc-nova', limit: 2, before });
      paged.push(...p.actions.map((a) => a.id));
      if (p.nextBefore === null) break;
      before = p.nextBefore;
    }
    expect(paged).toEqual(order);
    // the cursor's row went meanwhile (a retention prune): nextBeforeTs carries its time; without it, the page
    // continues from the nearest older row's time
    const first = store.listActions({ targetAccountId: 'acc-nova', limit: 2 });
    expect(first).toMatchObject({ nextBefore: a4, nextBeforeTs: T0 + 5 * MIN });
    db.prepare('DELETE FROM mod_actions WHERE id = ?').run(a4);
    expect(store.listActions({ targetAccountId: 'acc-nova', limit: 10, before: a4, beforeTs: first.nextBeforeTs! }).actions.map((a) => a.id)).toEqual([a1, a5, a2]);
    const o1 = add(T0 + MIN, 'acc-orion', 'OrionAce', null, 'o1');
    const o2 = add(T0 + 2 * MIN, 'acc-orion', 'OrionAce', null, 'o2');
    const o3 = add(T0 + 3 * MIN, 'acc-orion', 'OrionAce', null, 'o3');
    expect(store.listActions({ targetAccountId: 'acc-orion', limit: 2 }).nextBefore).toBe(o2);
    db.prepare('DELETE FROM mod_actions WHERE id = ?').run(o2);
    expect(store.listActions({ targetAccountId: 'acc-orion', limit: 2, before: o2 }).actions.map((a) => a.id)).toEqual([o1]);
    // a guest: name and address matches merged, a row matching both listed once
    const g1 = add(T0 + MIN, null, 'Guest5', '10.0.0.8', 'g1');
    const g2 = add(T0 + 3 * MIN, null, 'guest5', null, 'g2');
    const g3 = add(T0 + 2 * MIN, null, 'Guest6', '10.0.0.8', 'g3');
    const guest = (limit: number, b?: number) => store.listActions({ targetName: 'Guest5', targetAddress: '10.0.0.8', limit, before: b });
    expect(guest(10).actions.map((a) => a.id)).toEqual([g2, g3, g1]);
    expect(guest(1)).toMatchObject({ nextBefore: g2 });
    expect(guest(1, g2).actions.map((a) => a.id)).toEqual([g3]);
    expect(guest(5, g3)).toMatchObject({ nextBefore: null });
    expect(guest(5, g3).actions.map((a) => a.id)).toEqual([g1]);
    // the whole trail stays in id order (no ts cursor)
    expect(store.listActions({ limit: 3 })).toMatchObject({ nextBefore: g1, nextBeforeTs: null });
    expect(store.listActions({ limit: 3 }).actions.map((a) => a.id)).toEqual([g3, g2, g1]);
    expect(store.listActions({ limit: 2, before: g1 }).actions.map((a) => a.id)).toEqual([o3, o1]); // o2 was deleted
    // a target's cursor is (ts, id): below a1 come the rows stamped before it, whatever their ids
    expect(store.listActions({ targetAccountId: 'acc-nova', before: a1 }).actions.map((a) => a.id)).toEqual([a5, a2]);
    expect(store.listActions({ targetAccountId: 'acc-nova', before: 0 }).actions).toEqual([]);
  });
});
