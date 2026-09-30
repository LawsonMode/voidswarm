// The maintenance worker's chunked writes (docs/LAN-EDITION-proposal.md §5.5, §5.16, §6.4, §5.11): T-ADM-8 (the
// recorded manual purge, through the real worker, down to the FTS index after the next optimize), the automatic
// retention (lines and report copies; counters stay), records retention, address minimisation, and the wellbeing
// clear / pending / acknowledgement. Generated names only; school examples use caldwellschools.org.
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { MaintClient } from './client';
import { dayOf, indexDirtyRows } from './erase';
import { ledgerPath, readLedger } from './ledger';
import { addAccount, addConduct, addReport, count, open, tmpData, type TmpData } from './testutil';
import {
  ackWellbeing, addressTagOf, categoryOnlyLabel, clearWellbeingOriginals, isAddressTag, locateLines, minimiseAddresses, pace, pendingWellbeing, pruneRecords,
  purgeChat, purgeCount, retentionChat, setTermOwed, TERM_OWED_MAX, termOwedOf, WRITE_OPS,
} from './writes';
import { startWriteWorker } from './writes.testutil';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const TOKEN = 'quasarvoxel';
const quick = { pause: async (): Promise<void> => {} };

const temps: TmpData[] = [];
const workers: MaintClient[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) { try { await w.close(); } catch { /* closed */ } }
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) t.cleanup();
});

function fresh(): { t: TmpData; db: DatabaseSync } {
  const t = tmpData('vs-writes-');
  temps.push(t);
  const db = open(t.db);
  dbs.push(db);
  return { t, db };
}

interface LineSpec {
  ts: number; accountId?: string | null; name: string; original?: string; shown?: string; address?: string | null;
  action?: string; hits?: string[]; display?: string; roomUid?: string; tags?: string[];
}

/** One chat line with its tags (as ModStore writes them). */
function line(db: DatabaseSync, l: LineSpec): number {
  const original = l.original ?? `hello from ${l.name}`;
  const r = db.prepare(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address, original, shown, action, hits, room_uid, display)
                        VALUES (?, 'r1', 'Flag Run', 'all', -1, 4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(l.ts, l.name, l.name.toLowerCase(), l.accountId ?? null, l.address === undefined ? '10.0.0.5' : l.address, original, l.shown ?? original,
      l.action ?? 'pass', JSON.stringify(l.hits ?? []), l.roomUid ?? 'boot1:r1', l.display ?? 'as-typed');
  const id = Number(r.lastInsertRowid);
  for (const tag of l.tags ?? []) db.prepare('INSERT INTO chat_tags (chat_id, tag, ts, account_id) VALUES (?, ?, ?, ?)').run(id, tag, l.ts, l.accountId ?? null);
  return id;
}

const matchCount = (db: DatabaseSync, token: string): number => count(db, `SELECT count(*) AS n FROM chat_fts WHERE chat_fts MATCH ?`, `"${token}"`);

describe('T-ADM-8 the manual purge (in the worker)', () => {
  it('purge.count, then purge.chat: the lines, their tags, counters, reviews and report copies go; the ledger has the entry; MATCH finds 0 after optimize', async () => {
    const { t, db } = fresh();
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    addAccount(db, { id: 'acc-vega', username: 'VegaPilot' });
    const old = NOW - 10 * DAY;
    const oldIds = [0, 1, 2].map((i) => line(db, {
      ts: old + i * 1000, accountId: 'acc-nova', name: 'NovaPilot', original: `you ${TOKEN} there ${i}`, shown: 'GG, pilots!', action: 'mask',
      hits: ['profanity:x'], display: 'substituted', tags: ['PROFANITY'],
    }));
    const keptId = line(db, { ts: NOW - DAY, accountId: 'acc-vega', name: 'VegaPilot', original: 'nice shot', tags: [] });
    addConduct(db, 'acc-nova', dayOf(old), 'PROFANITY', 3);
    addConduct(db, 'acc-nova', dayOf(NOW - DAY), 'PROFANITY', 1);
    db.prepare("INSERT INTO flag_reviews (chat_id, status, by, at, note) VALUES (?, 'ok', 'host', ?, 'fine')").run(oldIds[0]!, old + 5000);
    const rep = addReport(db, {
      reporterName: 'VegaPilot', reporterId: 'acc-vega', targetName: 'NovaPilot', targetId: 'acc-nova', ts: NOW - 2 * DAY,
      copies: [{ id: oldIds[1], ts: old + 1000, name: 'NovaPilot', shown: 'GG, pilots!', display: 'substituted', hits: [] }, { id: keptId, ts: NOW - DAY, name: 'VegaPilot', shown: 'nice shot', hits: [] }],
    });
    expect(matchCount(db, TOKEN)).toBe(3);

    const w = await startWriteWorker(t);
    workers.push(w);
    const before = NOW - 5 * DAY;
    expect(await w.call('purge.count', { before })).toMatchObject({ rows: 3, before });
    expect(await w.call('purge.count', { before, accountId: 'acc-vega' })).toMatchObject({ rows: 0 });
    await expect(w.call('purge.count', {})).rejects.toMatchObject({ code: 'EARGS' });
    const r = await w.call<Record<string, unknown>>('purge.chat', { before, by: 'host:NovaHost', ts: NOW });
    expect(r).toMatchObject({ deleted: 3, reportCopies: 1 });

    expect(count(db, 'SELECT count(*) AS n FROM chat_log')).toBe(1);
    expect(count(db, `SELECT count(*) AS n FROM chat_tags WHERE chat_id IN (${oldIds.join(',')})`)).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM flag_reviews')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM conduct_daily WHERE day = ?', dayOf(old))).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM conduct_daily WHERE day = ?', dayOf(NOW - DAY))).toBe(1); // a day after the cut stays
    const rr = db.prepare('SELECT recent_chat_json, recent_ids FROM reports WHERE id = ?').get(rep) as { recent_chat_json: string; recent_ids: string };
    expect(JSON.parse(rr.recent_chat_json).map((c: { id: number }) => c.id)).toEqual([keptId]);
    expect(JSON.parse(rr.recent_ids)).toEqual([keptId]);
    const { entries } = readLedger(ledgerPath(t.dir));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'purge', by: 'host:NovaHost', before, ts: NOW });
    expect(entries[0]!.accountId).toBeUndefined();

    // the index: the deleted rows' entries go at the next optimize (no FTS secure-delete)
    expect(indexDirtyRows(db)).toBe(3);
    await w.call('fts.optimize');
    expect(indexDirtyRows(db)).toBe(0);
    expect(matchCount(db, TOKEN)).toBe(0);
    db.exec("INSERT INTO chat_fts(chat_fts) VALUES('integrity-check')");
    // idempotent: again, nothing more
    expect(await w.call('purge.chat', { before, by: 'host:NovaHost', ts: NOW })).toMatchObject({ deleted: 0 });
  });

  it('one student only: the other students\' lines and counters stay', async () => {
    const { t, db } = fresh();
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    addAccount(db, { id: 'acc-vega', username: 'VegaPilot' });
    const old = NOW - 10 * DAY;
    line(db, { ts: old, accountId: 'acc-nova', name: 'NovaPilot', tags: ['PROFANITY'], hits: ['profanity:x'] });
    line(db, { ts: old + 1, accountId: 'acc-vega', name: 'VegaPilot', tags: ['PROFANITY'], hits: ['profanity:x'] });
    addConduct(db, 'acc-nova', dayOf(old));
    addConduct(db, 'acc-vega', dayOf(old));
    expect(purgeCount(db, { before: NOW, accountId: 'acc-nova' })).toBe(1);
    const r = await purgeChat(db, t.dir, { before: NOW, accountId: 'acc-nova', by: 'host:NovaHost', ts: NOW }, quick);
    expect(r.chat).toBe(1);
    expect(r.entry).toMatchObject({ kind: 'purge', accountId: 'acc-nova' });
    expect(count(db, "SELECT count(*) AS n FROM chat_log WHERE account_id = 'acc-vega'")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM conduct_daily WHERE account_key = 'acc-vega'")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM conduct_daily WHERE account_key = 'acc-nova'")).toBe(0);
  });
});

describe('automatic retention (retention.chat)', () => {
  it('lines older than the cut go with their tags and report copies; conduct counters stay (records); the index is marked for a tidy', async () => {
    const { db } = fresh();
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    const old = NOW - 100 * DAY;
    const oldIds: number[] = [];
    for (let i = 0; i < 7; i++) oldIds.push(line(db, { ts: old + i, accountId: 'acc-nova', name: 'NovaPilot', tags: ['PROFANITY'], hits: ['profanity:x'] }));
    const keep = line(db, { ts: NOW - DAY, accountId: 'acc-nova', name: 'NovaPilot' });
    addConduct(db, 'acc-nova', dayOf(old), 'PROFANITY', 7);
    const rep = addReport(db, {
      reporterName: 'VegaPilot', targetName: 'NovaPilot', targetId: 'acc-nova', ts: NOW - DAY,
      // one copy with an id, one old copy without (an older pruner left it), one current
      copies: [{ id: oldIds[0], ts: old, shown: 'x', hits: [] }, { ts: old + 1, shown: 'y', hits: [] }, { id: keep, ts: NOW - DAY, shown: 'z', hits: [] }],
    });
    const done: number[] = [];
    const r = await retentionChat(db, { before: NOW - 90 * DAY }, { chunk: 3, pause: quick.pause, progress: (n) => done.push(n) });
    expect(r).toEqual({ deleted: 7, reportsUpdated: 1, reportCopies: 2 });
    expect(done).toEqual([3, 6, 7]);
    expect(count(db, 'SELECT count(*) AS n FROM chat_log')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM chat_tags')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM conduct_daily')).toBe(1); // records retention decides
    const rr = db.prepare('SELECT recent_chat_json, recent_ids FROM reports WHERE id = ?').get(rep) as { recent_chat_json: string; recent_ids: string };
    expect(JSON.parse(rr.recent_chat_json)).toHaveLength(1);
    expect(JSON.parse(rr.recent_ids)).toEqual([keep]);
    expect(indexDirtyRows(db)).toBe(7);
    // idempotent, and no ledger entry (a re-apply would delete the counters)
    expect(await retentionChat(db, { before: NOW - 90 * DAY }, quick)).toEqual({ deleted: 0, reportsUpdated: 0, reportCopies: 0 });
  });

  it('records retention: audit, reports, ended bans, conduct counters and device checks past their cut; live bans stay', async () => {
    const { db } = fresh();
    const keepBefore = NOW - 365 * DAY;
    const oldTs = keepBefore - DAY;
    db.prepare("INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, reason) VALUES (?, 'host', 'host', 'note', 'old'), (?, 'host', 'host', 'note', 'new')").run(oldTs, NOW);
    addReport(db, { reporterName: 'a', targetName: 'b', ts: oldTs });
    addReport(db, { reporterName: 'a', targetName: 'b', ts: NOW });
    const ban = db.prepare(`INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, expires_at, reason, by, revoked_at)
                            VALUES (?, 'account', 'acc-x', 'x', NULL, ?, ?, 'r', 'host', ?)`);
    ban.run('mute', oldTs - DAY, oldTs, null); // ended long ago
    ban.run('ban', oldTs - DAY, null, oldTs); // revoked long ago
    ban.run('ban', oldTs - DAY, null, null); // permanent, live
    addConduct(db, 'acc-x', dayOf(oldTs) - 1);
    addConduct(db, 'acc-x', dayOf(NOW));
    db.prepare("INSERT INTO device_checks (ts, browser, results_json) VALUES (?, 'chrome', '{}'), (?, 'chrome', '{}')").run(NOW - 8 * DAY, NOW - DAY);
    const r = await pruneRecords(db, { keepBefore, deviceChecksBefore: NOW - 7 * DAY }, { chunk: 1, pause: quick.pause });
    expect(r).toEqual({ actions: 1, reports: 1, bans: 2, conduct: 1, deviceChecks: 1 });
    expect(count(db, 'SELECT count(*) AS n FROM bans')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM mod_actions')).toBe(1);
    expect(await pruneRecords(db, { keepBefore }, quick)).toEqual({ actions: 0, reports: 0, bans: 0, conduct: 0, deviceChecks: 0 });
  });
});

describe('address minimisation (retention.addresses, §6.4)', () => {
  it('account lines lose the address, guest lines keep only the tag; newer lines, bans and the watermark', async () => {
    const { db } = fresh();
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    const pepper = new Uint8Array(32).fill(7);
    const cut = NOW - 7 * DAY;
    const acc = line(db, { ts: cut - 10, accountId: 'acc-nova', name: 'NovaPilot', address: '10.0.0.5' });
    const guest = line(db, { ts: cut - 5, name: 'GuestVega', address: '10.0.0.6' });
    const recent = line(db, { ts: cut + 5, name: 'GuestVega', address: '10.0.0.6' });
    db.prepare("INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, expires_at, reason, by) VALUES ('ban', 'address', NULL, NULL, '10.0.0.6', ?, NULL, 'r', 'host')").run(cut - DAY);
    const r = await minimiseAddresses(db, { before: cut, pepper }, { chunk: 1, pause: quick.pause });
    expect(r).toEqual({ accountLines: 1, guestLines: 1 });
    const addr = (id: number): unknown => (db.prepare('SELECT address FROM chat_log WHERE id = ?').get(id) as { address: unknown }).address;
    expect(addr(acc)).toBeNull();
    expect(addr(guest)).toBe(addressTagOf('10.0.0.6', pepper));
    expect(isAddressTag(addr(guest))).toBe(true);
    expect(addr(recent)).toBe('10.0.0.6');
    expect((db.prepare('SELECT address_prefix FROM bans').get() as { address_prefix: string }).address_prefix).toBe('10.0.0.6');
    // the tag is keyed: another pepper gives another tag; the unkeyed fallback still hides the address
    expect(addressTagOf('10.0.0.6', new Uint8Array(32).fill(8))).not.toBe(addr(guest));
    expect(addressTagOf('10.0.0.6', null)).toMatch(/^tag:[0-9a-f]{4}$/);
    // the next night: only the lines that crossed the 7 days since
    expect(await minimiseAddresses(db, { before: cut, pepper }, quick)).toEqual({ accountLines: 0, guestLines: 0 });
    expect(await minimiseAddresses(db, { before: cut + 10, pepper }, quick)).toEqual({ accountLines: 0, guestLines: 1 });
    expect(addr(recent)).toBe(addressTagOf('10.0.0.6', pepper));
    // a full rescan changes nothing more (idempotent)
    expect(await minimiseAddresses(db, { before: cut + 10, pepper, full: true }, quick)).toEqual({ accountLines: 0, guestLines: 0 });
  });
});

describe('wellbeing (§5.11)', () => {
  it('pending lines are nameless; an acknowledgement is kept once; 30 days later the words go but the line stays a SELF-HARM line', async () => {
    const { db } = fresh();
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    const ts = NOW - 40 * DAY;
    const id = line(db, {
      ts, accountId: 'acc-nova', name: 'NovaPilot', original: 'a sad test line', shown: '', action: 'block', hits: ['selfharm:x', 'flag:gang:y'],
      display: 'withheld', tags: ['SELF-HARM', 'GANG'],
    });
    const recentId = line(db, { ts: NOW - DAY, accountId: 'acc-nova', name: 'NovaPilot', original: 'another', shown: '', action: 'block', hits: ['selfharm:z'], display: 'withheld', tags: ['SELF-HARM'] });
    expect(pendingWellbeing(db, { now: NOW, since: NOW - 60 * DAY }).map((l) => l.chatId)).toEqual([recentId, id]);
    const p = pendingWellbeing(db, { now: NOW, since: NOW - 60 * DAY })[0]!;
    expect(Object.keys(p).sort()).toEqual(['channel', 'chatId', 'roomName', 'roomUid', 'ts']);
    // not acknowledged: nothing is cleared, however old
    expect(await clearWellbeingOriginals(db, { before: NOW - 30 * DAY }, quick)).toEqual({ cleared: 0 });
    expect(ackWellbeing(db, { chatId: id, by: 'NovaHost', note: 'talked with them', at: ts + DAY })).toEqual({ acked: true, already: false, exists: true });
    expect(ackWellbeing(db, { chatId: id, by: 'NovaHost', at: ts + 2 * DAY })).toEqual({ acked: false, already: true, exists: true });
    expect(ackWellbeing(db, { chatId: 999_999, by: 'NovaHost' })).toEqual({ acked: false, already: false, exists: false });
    expect(pendingWellbeing(db, { now: NOW, since: NOW - 60 * DAY }).map((l) => l.chatId)).toEqual([recentId]);
    ackWellbeing(db, { chatId: recentId, by: 'NovaHost', at: NOW - DAY });
    const r = await clearWellbeingOriginals(db, { before: NOW - 30 * DAY }, quick);
    expect(r).toEqual({ cleared: 1 });
    const row = db.prepare('SELECT original, shown, hits, display FROM chat_log WHERE id = ?').get(id) as Record<string, string>;
    expect(row).toMatchObject({ original: '', shown: '', display: 'withheld' });
    expect(JSON.parse(row.hits!)).toEqual(['selfharm:', 'flag:gang:']);
    expect((db.prepare('SELECT original FROM chat_log WHERE id = ?').get(recentId) as { original: string }).original).toBe('another');
    expect(count(db, "SELECT count(*) AS n FROM chat_tags WHERE chat_id = ? AND tag = 'SELF-HARM'", id)).toBe(1);
    expect(indexDirtyRows(db)).toBe(1);
    expect(await clearWellbeingOriginals(db, { before: NOW - 30 * DAY }, quick)).toEqual({ cleared: 0 });
    expect(categoryOnlyLabel('custom:local:x')).toBe('custom:local:');
    expect(categoryOnlyLabel('filter-error')).toBe('filter-error');
  });
});

describe('the op table', () => {
  it('names every write op, fails closed on bad arguments, and paces between chunks', async () => {
    expect(Object.keys(WRITE_OPS).sort()).toEqual([
      'chat.locate', 'purge.chat', 'purge.count', 'retention.addresses', 'retention.chat', 'retention.records', 'retention.term.get', 'retention.term.set',
      'wellbeing.ack', 'wellbeing.clear', 'wellbeing.pending',
    ]);
    const { t, db } = fresh();
    const w = await startWriteWorker(t);
    workers.push(w);
    for (const op of ['purge.chat', 'retention.chat', 'retention.records', 'retention.addresses', 'wellbeing.clear']) {
      await expect(w.call(op, { before: 'yesterday', keepBefore: 'x' })).rejects.toMatchObject({ code: 'EARGS' });
    }
    await expect(w.call('purge.count', { before: NOW, accountId: 42 })).rejects.toMatchObject({ code: 'EARGS' });
    await expect(w.call('wellbeing.ack', {})).rejects.toMatchObject({ code: 'EARGS' });
    await expect(w.call('chat.locate', { lines: 'x' })).rejects.toMatchObject({ code: 'EARGS' });
    await expect(w.call('chat.locate', { lines: [{ channel: 'all' }] })).rejects.toMatchObject({ code: 'EARGS' });
    await expect(w.call('chat.locate', { lines: Array.from({ length: 101 }, () => ({ ts: 1, channel: 'all' })) })).rejects.toMatchObject({ code: 'EARGS' });
    await expect(w.call('retention.term.set', { owed: [{ cut: 'x', purgeAt: 1 }] })).rejects.toMatchObject({ code: 'EARGS' });
    await expect(w.call('retention.term.set', {})).rejects.toMatchObject({ code: 'EARGS' });
    expect(await w.call('wellbeing.pending', {})).toEqual({ lines: [] });
    expect(await w.call('retention.records', { keepBefore: NOW - 365 * DAY })).toEqual({ actions: 0, reports: 0, bans: 0, conduct: 0, deviceChecks: 0 });
    void db;
    const t0 = performance.now();
    await pace(0);
    await pace(1000);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(20);
    expect(took).toBeLessThan(500);
  });
});

describe("finding an alert's line, and the owed term purges (service support ops)", () => {
  it('chat.locate finds a line by (account or guest name key, ts, player, channel), however many lines came after it', async () => {
    const { t, db } = fresh();
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    const sad = line(db, { ts: NOW, accountId: 'acc-nova', name: 'NovaPilot', original: 'a sad test line', shown: '', display: 'withheld', tags: ['SELF-HARM'] });
    for (let i = 1; i <= 40; i++) line(db, { ts: NOW + i * 1000, accountId: 'acc-nova', name: 'NovaPilot' });
    const guest = line(db, { ts: NOW + 500, accountId: null, name: 'QuasarKid' });
    expect(locateLines(db, [
      { ts: NOW, playerId: 4, channel: 'all', accountId: 'acc-nova' },
      { ts: NOW + 500, playerId: 4, channel: 'all', nameKey: 'quasarkid' },
      { ts: NOW + 500, playerId: 4, channel: 'all', accountId: 'acc-nova' }, // no such line
      { ts: NOW, playerId: 9, channel: 'all', accountId: 'acc-nova' }, // another connection
      { ts: NOW, playerId: 4, channel: 'team', accountId: 'acc-nova' }, // another channel
      { ts: NOW + 500, playerId: 4, channel: 'all', nameKey: 'quasarkid', accountId: null },
      { ts: NOW + 500, playerId: 4, channel: 'all' }, // no key at all
    ])).toEqual([sad, guest, null, null, null, guest, null]);
    const w = await startWriteWorker(t);
    workers.push(w);
    expect(await w.call('chat.locate', { lines: [{ ts: NOW, playerId: 4, channel: 'all', accountId: 'acc-nova' }] })).toEqual({ ids: [sad] });
    expect(await w.call('chat.locate', { lines: [] })).toEqual({ ids: [] });
  });

  it('retention.term.get / set keep the owed term purges in mod_meta (oldest cut first, at most 4), and set replaces them', async () => {
    const { t, db } = fresh();
    expect(termOwedOf(db)).toEqual([]);
    expect(setTermOwed(db, [{ cut: 300, purgeAt: 400 }, { cut: 100, purgeAt: 200 }])).toEqual([{ cut: 100, purgeAt: 200 }, { cut: 300, purgeAt: 400 }]);
    expect(termOwedOf(db)).toEqual([{ cut: 100, purgeAt: 200 }, { cut: 300, purgeAt: 400 }]);
    const many = Array.from({ length: TERM_OWED_MAX + 2 }, (_, i) => ({ cut: 1000 + i, purgeAt: 2000 + i }));
    expect(setTermOwed(db, many)).toHaveLength(TERM_OWED_MAX);
    expect(termOwedOf(db)[0]).toEqual({ cut: 1002, purgeAt: 2002 }); // the newest kept
    // other mod_meta keys are untouched
    expect(count(db, "SELECT count(*) AS n FROM mod_meta WHERE k = 'rev'")).toBe(1);
    const w = await startWriteWorker(t);
    workers.push(w);
    expect(await w.call('retention.term.set', { owed: [{ cut: NOW, purgeAt: NOW + 14 * DAY }] })).toEqual({ owed: [{ cut: NOW, purgeAt: NOW + 14 * DAY }] });
    expect(await w.call('retention.term.get', {})).toEqual({ owed: [{ cut: NOW, purgeAt: NOW + 14 * DAY }] });
    expect(await w.call('retention.term.set', { owed: [] })).toEqual({ owed: [] });
    expect(await w.call('retention.term.get', {})).toEqual({ owed: [] });
    expect(count(db, "SELECT count(*) AS n FROM mod_meta WHERE k GLOB 'term_owed_*'")).toBe(0);
  });
});
