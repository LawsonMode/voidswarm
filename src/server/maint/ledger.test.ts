// LAN task B5: the deletion ledger and the erase / purge steps it re-applies (T-BAK-3; §6.4, §4.13, T-ADM-8/10's
// data rules). The end-to-end "a deleted student stays deleted after a restore" is in src/lan/restore.test.ts.
import * as fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountFootprint, dayOf, eraseAccount, guestEraPreview, hasherIdOf, indexDirtyRows, nameHasher, nextFormerLabel, purgeChatBefore, scrubNamesInText,
  scrubUsername, usernameHash, usernameHashKeyId,
} from './erase';
import {
  appendLedger, appendLedgerFor, applicableEntries, applyLedger, dbLineage, deleteAccountRecorded, effectiveCut, ensureLineage, entriesOf, entryKey, ledgerPath, LINEAGE_META_KEY,
  mergeLedgers, mergeUnknownLines, nativeLineage, parseLedger, purgeRecorded, readLedger, scopeLedgers, validateEntry, withLineage, writeLedger,
  type LedgerEntry,
} from './ledger';
import { nameKey as nameKeyOf } from '../../shared/room/util';
import { addAccount, addAction, addChat, addConduct, addReport, addTag, count, open, tmpData, type TmpData } from './testutil';

const dirs: TmpData[] = [];
const scratch = (): TmpData => { const t = tmpData('vs-ledger-'); dirs.push(t); return t; };
afterEach(() => { while (dirs.length) dirs.pop()!.cleanup(); });

const T0 = 1_760_000_000_000;

/** NovaPilot (to delete) and KeepPilot, with lines, a guest era, reports, counters, tags, bans and audit rows. */
function world(db: DatabaseSync): { nova: number[]; keep: number[]; guest: number[]; otherReport: number } {
  addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
  addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
  const nova = [addChat(db, { ts: T0 + 1, accountId: 'acc-nova', name: 'NovaPilot', original: 'nova line one' }),
    addChat(db, { ts: T0 + 2, accountId: 'acc-nova', name: 'NovaPilot', original: 'nova line two', action: 'mask', shown: 'nova l*** two' })];
  const keep = [addChat(db, { ts: T0 + 3, accountId: 'acc-keep', name: 'KeepPilot', original: 'keep line' })];
  // Before registering, NovaPilot played as a guest with the same callsign (any case).
  const guest = [addChat(db, { ts: T0 - 100, accountId: null, name: 'novapilot', original: 'guest era line' })];
  addTag(db, nova[1]!, 'PROFANITY', 'acc-nova');
  addTag(db, keep[0]!, 'PROFANITY', 'acc-keep');
  addConduct(db, 'acc-nova', dayOf(T0));
  addConduct(db, 'acc-keep', dayOf(T0));
  addConduct(db, 'g:novapilot', dayOf(T0 - 100));
  db.prepare("INSERT INTO flag_reviews (chat_id, status, by, at) VALUES (?, 'ok', 'host', 1)").run(nova[0]!);
  db.prepare("INSERT INTO bans (kind, scope, account_id, username, created_at, reason, by) VALUES ('mute', 'account', 'acc-nova', 'NovaPilot', 1, 'spam', 'host')").run();
  db.prepare("INSERT INTO bans (kind, scope, address_prefix, created_at, reason, by) VALUES ('ban', 'address', '10.0.0.5', 1, 'x', 'host')").run();
  db.prepare("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES ('th-nova', 'acc-nova', 1, 9e15)").run();
  addReport(db, { reporterName: 'NovaPilot', reporterId: 'acc-nova', targetName: 'KeepPilot', targetId: 'acc-keep' });
  addReport(db, { reporterName: 'KeepPilot', reporterId: 'acc-keep', targetName: 'NovaPilot', targetId: 'acc-nova' });
  const otherReport = addReport(db, {
    reporterName: 'KeepPilot', reporterId: 'acc-keep', targetName: 'SomeGuest', reason: 'NovaPilot saw it too',
    copies: [
      { id: nova[0], ts: T0 + 1, name: 'NovaPilot', accountId: 'acc-nova', shown: 'nova line one' },
      { id: keep[0], ts: T0 + 3, name: 'KeepPilot', accountId: 'acc-keep', shown: 'keep line' },
      { id: guest[0], ts: T0 - 100, name: 'novapilot', accountId: null, shown: 'guest era line' },
    ],
  });
  addAction(db, { action: 'mute', targetId: 'acc-nova', targetName: 'NovaPilot', reason: 'muted NovaPilot for spam, see novapilot-2 too' });
  addAction(db, { action: 'kick', targetId: null, targetName: 'NovaPilot', reason: 'guest kick' });
  addAction(db, { actorId: 'acc-nova', actorName: 'NovaPilot', action: 'warn', targetId: 'acc-keep', targetName: 'KeepPilot', reason: 'be nice' });
  return { nova, keep, guest, otherReport };
}

describe('T-BAK-3: the deletion ledger file', () => {
  it('appends one checked JSON line per deletion (ids and hashes only), and skips bad lines when read', () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    const e = appendLedger(file, { ts: T0, kind: 'account', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), by: 'host:teacher', records: 'delete', guestEra: true });
    appendLedger(file, { ts: T0 + 5, kind: 'purge', before: T0, by: 'host:teacher' });
    fs.appendFileSync(file, 'not json\n{"ts":1,"kind":"account"}\n\n');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('NovaPilot');
    expect(text).not.toMatch(/novapilot/i);
    const r = readLedger(file);
    expect(r.entries).toEqual([e, { ts: T0 + 5, kind: 'purge', before: T0, by: 'host:teacher' }]);
    expect(r.bad).toBe(2);
    expect(() => appendLedger(file, { ts: 1, kind: 'account', by: 'x' } as LedgerEntry)).toThrow();
    expect(validateEntry({ ts: 1, kind: 'purge', by: 'x' })).toBeNull();
    expect(validateEntry({ ts: 1, kind: 'account', accountId: '../../x', by: 'x' })).toBeNull();
    expect(readLedger(path.join(t.dir, 'none.jsonl'))).toEqual({ entries: [], bad: 0, unknown: [] });
  });

  it('merges ledgers as a union (one entry per deletion, the earliest kept, oldest first) and writes it atomically', () => {
    const t = scratch();
    const a: LedgerEntry = { ts: 10, kind: 'account', accountId: 'acc-a', by: 'host', records: 'delete' };
    const b: LedgerEntry = { ts: 20, kind: 'purge', before: 5, by: 'host' };
    const a2: LedgerEntry = { ...a, ts: 30, by: 'cli' };
    const m = mergeLedgers([b, a2], [a]);
    expect(m).toEqual([a, b]);
    expect(entryKey(a)).toBe(entryKey(a2));
    writeLedger(ledgerPath(t.dir), m);
    expect(parseLedger(fs.readFileSync(ledgerPath(t.dir), 'utf8')).entries).toEqual(m);
    expect(fs.readdirSync(t.dir).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });
});

describe('T-BAK-3: erase and purge (what the ledger re-applies)', () => {
  it("'delete' removes the lines, reports by and about, report copies, counters, account bans, sessions; anonymises and scrubs the audit", async () => {
    const t = scratch();
    const db = open(t.db);
    const w = world(db);
    const c = await eraseAccount(db, { accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'delete', guestEra: true, label: 'Former player #1' });
    expect(c).toMatchObject({ accounts: 1, chatDeleted: 3, reportsDeleted: 2, bans: 1 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM accounts WHERE id = ?', 'acc-nova')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE account_id = 'acc-nova' OR name_key = 'novapilot'")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log WHERE id = ?', w.keep[0]!)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_tags WHERE account_id = 'acc-nova'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_tags WHERE account_id = 'acc-keep'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM flag_reviews')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM conduct_daily WHERE account_key IN ('acc-nova', 'g:novapilot')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM conduct_daily WHERE account_key = 'acc-keep'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE account_id = 'acc-nova'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM bans WHERE scope = 'address'")).toBe(1); // bans keep their own addresses
    expect(count(db, 'SELECT COUNT(*) AS n FROM reports')).toBe(1);
    const rep = db.prepare('SELECT recent_chat_json, recent_ids, reason FROM reports WHERE id = ?').get(w.otherReport) as Record<string, string>;
    expect(JSON.parse(rep.recent_chat_json)).toEqual([{ id: w.keep[0], ts: T0 + 3, name: 'KeepPilot', accountId: 'acc-keep', shown: 'keep line' }]);
    expect(JSON.parse(rep.recent_ids)).toEqual([w.keep[0]]);
    expect(rep.reason).toBe('Former player #1 saw it too');
    const audit = db.prepare('SELECT actor_account_id, actor_name, target_account_id, target_name, target_address, reason FROM mod_actions ORDER BY id').all();
    expect(audit).toEqual([
      { actor_account_id: 'host', actor_name: 'host', target_account_id: null, target_name: 'Former player #1', target_address: null, reason: 'muted Former player #1 for spam, see novapilot-2 too' },
      { actor_account_id: 'host', actor_name: 'host', target_account_id: null, target_name: 'Former player #1', target_address: null, reason: 'guest kick' },
      { actor_account_id: 'deleted', actor_name: 'Former player #1', target_account_id: 'acc-keep', target_name: 'KeepPilot', target_address: '10.0.0.9', reason: 'be nice' },
    ]);
    expect(indexDirtyRows(db)).toBe(3);
    // Idempotent.
    const again = await eraseAccount(db, { accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'delete', guestEra: true, label: 'Former player #1' });
    expect(Object.values(again).every((x) => x === 0)).toBe(true);
    // FTS no longer finds the deleted text (the index follows the triggers).
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_fts WHERE chat_fts MATCH '\"nova line\"'")).toBe(0);
    db.close();
  });

  it("'pseudonymise' keeps the lines as \"Former player #N\" with the original empty and no address; idempotent", async () => {
    const t = scratch();
    const db = open(t.db);
    const w = world(db);
    const label = nextFormerLabel(db);
    expect(label).toBe('Former player #1');
    expect(nextFormerLabel(db)).toBe('Former player #2');
    await eraseAccount(db, { accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'pseudonymise', guestEra: true, label });
    const rows = db.prepare('SELECT id, name, account_id, address, original, shown FROM chat_log WHERE id IN (?, ?, ?) ORDER BY id').all(w.nova[0]!, w.nova[1]!, w.guest[0]!);
    expect(rows).toEqual([
      { id: w.nova[0], name: label, account_id: null, address: null, original: '', shown: 'nova line one' },
      { id: w.nova[1], name: label, account_id: null, address: null, original: '', shown: 'nova l*** two' },
      { id: w.guest[0], name: label, account_id: null, address: null, original: '', shown: 'guest era line' },
    ].sort((a, b) => a.id! - b.id!));
    expect(count(db, 'SELECT COUNT(*) AS n FROM accounts WHERE id = ?', 'acc-nova')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM reports')).toBe(3);
    const rep = db.prepare("SELECT reporter_name, reporter_account_id, reporter_address FROM reports WHERE reporter_name = ?").get(label);
    expect(rep).toEqual({ reporter_name: label, reporter_account_id: null, reporter_address: null });
    const copies = JSON.parse((db.prepare('SELECT recent_chat_json FROM reports WHERE id = ?').get(w.otherReport) as { recent_chat_json: string }).recent_chat_json) as Record<string, unknown>[];
    expect(copies.map((c) => [c.name, c.accountId])).toEqual([[label, null], ['KeepPilot', 'acc-keep'], [label, null]]);
    // The original text is out of the index too.
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_fts WHERE chat_fts MATCH '\"guest era\"'")).toBe(1); // shown text stays
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE original LIKE '%nova%'")).toBe(0);
    const snap = JSON.stringify(db.prepare('SELECT * FROM chat_log ORDER BY id').all()) + JSON.stringify(db.prepare('SELECT * FROM reports ORDER BY id').all());
    const again = await eraseAccount(db, { accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'pseudonymise', guestEra: true, label });
    expect(Object.values(again).every((x) => x === 0)).toBe(true);
    expect(JSON.stringify(db.prepare('SELECT * FROM chat_log ORDER BY id').all()) + JSON.stringify(db.prepare('SELECT * FROM reports ORDER BY id').all())).toBe(snap);
    db.close();
  });

  it('without guestEra, guest rows under the same name stay', async () => {
    const t = scratch();
    const db = open(t.db);
    const w = world(db);
    await eraseAccount(db, { accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'delete' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log WHERE id = ?', w.guest[0]!)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM conduct_daily WHERE account_key = 'g:novapilot'")).toBe(1);
    db.close();
  });

  it('a purge removes older lines with their tags, reviews, counters and report copies (one account, or everyone)', async () => {
    const t = scratch();
    const db = open(t.db);
    const w = world(db);
    const DAY = 86_400_000;
    addConduct(db, 'acc-keep', dayOf(T0) + 10);
    const r1 = await purgeChatBefore(db, { before: T0 + 3, accountId: 'acc-nova' });
    expect(r1.chat).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log WHERE id = ?', w.guest[0]!)).toBe(1);
    // Counters are per day: a cut in the middle of a day keeps that day's counters (they also count later lines).
    expect(count(db, "SELECT COUNT(*) AS n FROM conduct_daily WHERE account_key = 'acc-nova'")).toBe(1);
    const cut = (dayOf(T0) + 1) * DAY; // the next midnight (UTC days)
    const r2 = await purgeChatBefore(db, { before: cut });
    expect(r2.chat).toBe(2); // the guest line and KeepPilot's
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_tags')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM conduct_daily')).toBe(1); // the day after the cut stays
    const copies = JSON.parse((db.prepare('SELECT recent_chat_json FROM reports WHERE id = ?').get(w.otherReport) as { recent_chat_json: string }).recent_chat_json);
    expect(copies).toEqual([]);
    expect((await purgeChatBefore(db, { before: cut })).chat).toBe(0);
    db.close();
  });

  it('applyLedger re-applies every entry, oldest first; a second run changes nothing', async () => {
    const t = scratch();
    const db = open(t.db);
    world(db);
    const entries: LedgerEntry[] = [
      { ts: T0 + 100, kind: 'purge', before: T0 + 4, by: 'host' },
      { ts: T0 + 50, kind: 'account', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'delete', guestEra: true, label: 'Former player #1', by: 'host' },
    ];
    const r = await applyLedger(db, entries);
    expect(r.entries).toBe(2);
    expect(r.changed).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM accounts')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log')).toBe(0);
    const r2 = await applyLedger(db, entries);
    expect(r2.changed).toBe(0);
    db.close();
  });

  it('scrubUsername replaces only the whole name, in any case', () => {
    const h = usernameHash('NovaPilot');
    expect(scrubUsername('NovaPilot, novapilot! NOVAPILOT NovaPilot2 xNovaPilot', h, '[x]')).toBe('[x], [x]! [x] NovaPilot2 xNovaPilot');
  });
});

// ------------------------------------------------------------------------------------------
// Verifier round 1: torn lines, label counter, guest era by address and time, keyed hashes
// ------------------------------------------------------------------------------------------

describe('T-BAK-3: the ledger survives a torn line; re-applies are bounded and keyed', () => {
  it('an append after a torn last line (a power cut mid-append) starts a new line, so no deletion is lost', () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    appendLedger(file, { ts: 1, kind: 'account', accountId: 'acc-one', by: 'host' });
    fs.appendFileSync(file, '{"ts":2,"kind":"acc'); // the torn fragment
    appendLedger(file, { ts: 3, kind: 'account', accountId: 'acc-three', by: 'host' });
    const r = readLedger(file);
    expect(r.entries.map((e) => e.accountId)).toEqual(['acc-one', 'acc-three']);
    expect(r.bad).toBe(1);
    // A clean file gets no blank lines.
    appendLedger(file, { ts: 4, kind: 'account', accountId: 'acc-four', by: 'host' });
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim())).toEqual(['']); // only the final newline
  });

  it('after a restore brings back an older "Former player" counter, the re-applied labels are never handed out again', async () => {
    const t = scratch();
    const db = open(t.db);
    addAccount(db, { id: 'acc-a', username: 'AlphaPilot' });
    addAccount(db, { id: 'acc-b', username: 'BetaPilot' });
    addChat(db, { accountId: 'acc-a', name: 'AlphaPilot' });
    addChat(db, { accountId: 'acc-b', name: 'BetaPilot' });
    // A was pseudonymised as #1 after the backup; the backup's counter is unset. Re-apply A, then delete B live.
    const r = await applyLedger(db, [{ ts: T0, kind: 'account', accountId: 'acc-a', records: 'pseudonymise', label: 'Former player #1', by: 'host' }]);
    expect(r.changed).toBe(1);
    const labelB = nextFormerLabel(db);
    expect(labelB).toBe('Former player #2');
    await eraseAccount(db, { accountId: 'acc-b', records: 'pseudonymise', label: labelB });
    expect(db.prepare('SELECT name, COUNT(*) AS n FROM chat_log GROUP BY name ORDER BY name').all()).toEqual([
      { name: 'Former player #1', n: 1 }, { name: 'Former player #2', n: 1 },
    ]);
    db.close();
  });

  it('guestEra takes only the guest lines from addresses this account used, and only up to the deletion', async () => {
    const t = scratch();
    const db = open(t.db);
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    addChat(db, { ts: T0, accountId: 'acc-nova', name: 'NovaPilot', address: '10.0.0.5' });
    const hers = addChat(db, { ts: T0 - 5000, accountId: null, name: 'NovaPilot', address: '10.0.0.5', original: 'her guest line' });
    const otherPc = addChat(db, { ts: T0 - 4000, accountId: null, name: 'NovaPilot', address: '192.168.1.77', original: 'someone else, same callsign' });
    const later = addChat(db, { ts: T0 + 60_000, accountId: null, name: 'NovaPilot', address: '10.0.0.5', original: 'a later guest' });
    addConduct(db, 'g:novapilot', dayOf(T0 - 5000));
    addConduct(db, 'g:novapilot', dayOf(T0) + 3); // a day with none of her lines
    addReport(db, {
      reporterName: 'KeepPilot', targetName: 'NovaPilot', ts: T0 - 3000,
      copies: [{ id: hers, ts: T0 - 5000, name: 'NovaPilot', accountId: null, shown: 'her guest line' }, { id: otherPc, ts: T0 - 4000, name: 'NovaPilot', accountId: null, shown: 'x' }],
    });
    const h = usernameHash('NovaPilot');
    // The count preview B23 shows is the same selection.
    expect(guestEraPreview(db, { accountId: 'acc-nova', usernameHash: h, at: T0 + 1000 })).toEqual({ lines: 1, addresses: 1 });
    const c = await eraseAccount(db, { accountId: 'acc-nova', usernameHash: h, records: 'delete', guestEra: true, label: 'Former player #1', at: T0 + 1000 });
    expect(c.chatDeleted).toBe(2); // her account line and her guest line
    const left = (db.prepare('SELECT id FROM chat_log ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    expect(left).toEqual([otherPc, later]);
    expect(count(db, "SELECT COUNT(*) AS n FROM conduct_daily WHERE account_key = 'g:novapilot'")).toBe(1); // the other day stays
    // The report is about the guest callsign, but from an address she never used (10.0.0.8): kept, her copy gone.
    const copies = JSON.parse((db.prepare('SELECT recent_chat_json FROM reports').get() as { recent_chat_json: string }).recent_chat_json) as { id: number }[];
    expect(copies.map((x) => x.id)).toEqual([otherPc]);
    // Stored forms of an address (the tag a minimised guest line keeps) match too.
    const tag = (a: string): string[] => [`tag:${a.split('.').slice(0, 3).join('.')}`];
    const tagged = addChat(db, { ts: T0 - 9000, accountId: null, name: 'NovaPilot', address: 'tag:10.0.0' });
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    addChat(db, { ts: T0, accountId: 'acc-nova', name: 'NovaPilot', address: '10.0.0.5' });
    await eraseAccount(db, { accountId: 'acc-nova', usernameHash: h, records: 'delete', guestEra: true, at: T0 + 1000 }, { addressForms: tag });
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log WHERE id = ?', tagged)).toBe(0);
    db.close();
  });

  it('a re-apply never touches a later student who took the freed username (audit and report text after the deletion)', async () => {
    const t = scratch();
    const db = open(t.db);
    addAccount(db, { id: 'acc-new', username: 'NovaPilot' }); // registered after the old NovaPilot was deleted
    const before = db.prepare("INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, reason) VALUES (?, 'host', 'host', 'mute', 'muted NovaPilot')").run(T0 - 10);
    const after = db.prepare("INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, reason) VALUES (?, 'host', 'host', 'mute', 'muted NovaPilot again')").run(T0 + 10);
    addReport(db, { reporterName: 'KeepPilot', targetName: 'NovaPilot', targetId: 'acc-new', reason: 'NovaPilot was rude', ts: T0 + 20 });
    await applyLedger(db, [{ ts: T0, kind: 'account', accountId: 'acc-old', usernameHash: usernameHash('NovaPilot'), records: 'delete', guestEra: true, label: 'Former player #1', by: 'host' }]);
    const reason = (id: number | bigint): string => (db.prepare('SELECT reason FROM mod_actions WHERE id = ?').get(id) as { reason: string }).reason;
    expect(reason(before.lastInsertRowid)).toBe('muted Former player #1');
    expect(reason(after.lastInsertRowid)).toBe('muted NovaPilot again');
    expect(db.prepare('SELECT reason, target_account_id FROM reports').get()).toEqual({ reason: 'NovaPilot was rude', target_account_id: 'acc-new' });
    expect(count(db, "SELECT COUNT(*) AS n FROM accounts WHERE id = 'acc-new'")).toBe(1);
    db.close();
  });

  it("the username hash is an HMAC with the pepper (hashKey names it): a roster can't reverse it, and a re-apply needs that pepper", async () => {
    const t = scratch();
    const pepper = Buffer.alloc(32, 7);
    const other = Buffer.alloc(32, 9);
    const h = usernameHash('NovaPilot', pepper);
    expect(h).not.toBe(usernameHash('NovaPilot'));
    expect(h).not.toBe(usernameHash('NovaPilot', other));
    expect(usernameHash('novapilot', pepper)).toBe(h); // folded like the name key
    const file = ledgerPath(t.dir);
    appendLedger(file, { ts: T0, kind: 'account', accountId: 'acc-nova', usernameHash: h, hashKey: usernameHashKeyId(pepper), records: 'delete', guestEra: true, by: 'host' });
    const text = fs.readFileSync(file, 'utf8');
    // A dictionary of names hashed the unkeyed way finds nothing.
    for (const n of ['NovaPilot', 'novapilot', 'KeepPilot']) expect(text).not.toContain(usernameHash(n));
    expect(text).not.toContain(pepper.toString('hex'));
    const e = readLedger(file).entries;
    expect(e[0]).toMatchObject({ hashKey: usernameHashKeyId(pepper) });
    expect(validateEntry({ ts: 1, kind: 'account', accountId: 'a', usernameHash: h, hashKey: 'nothex', by: 'x' })).toBeNull();

    const db = open(t.db);
    world(db);
    // Without the pepper: the account-id steps still run; the name-matched guest line stays (and is counted).
    const r0 = await applyLedger(db, e, { peppers: [other] });
    expect(r0.unmatchedHashKeys).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE account_id = 'acc-nova'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE name_key = 'novapilot'")).toBe(1);
    // With it: the guest era goes too (a restore brings the account's lines, and so its addresses, back first).
    const t2 = scratch();
    const db2 = open(t2.db);
    world(db2);
    const r1 = await applyLedger(db2, e, { peppers: [other, pepper] });
    expect(r1.unmatchedHashKeys).toBe(0);
    expect(count(db2, "SELECT COUNT(*) AS n FROM chat_log WHERE name_key = 'novapilot'")).toBe(0);
    expect((db2.prepare('SELECT reason FROM mod_actions ORDER BY id').get() as { reason: string }).reason).toMatch(/^muted Former player #\d+ for spam/);
    expect(scrubUsername('hi NovaPilot', h, '[x]', nameHasher(pepper))).toBe('hi [x]');
    expect(scrubUsername('hi NovaPilot', h, '[x]')).toBe('hi NovaPilot'); // the v1 hasher doesn't match a keyed hash
    db.close();
    db2.close();
  });
});

// ------------------------------------------------------------------------------------------
// Build round 2: the live deletions write the ledger line first, with the values a re-apply uses
// ------------------------------------------------------------------------------------------

describe('T-BAK-3: deleteAccountRecorded / purgeRecorded (for B23 and B8b)', () => {
  it('appends the entry first (keyed hash, label from the counter), then erases exactly as a re-apply would', async () => {
    const t = scratch();
    const pepper = Buffer.alloc(32, 5);
    const file = ledgerPath(t.dir);
    const db = open(t.db);
    world(db);
    const { entry, counts } = await deleteAccountRecorded(db, file, {
      accountId: 'acc-nova', username: 'NovaPilot', records: 'delete', guestEra: true, by: 'host:teacher', ts: T0 + 10,
    }, { pepper });
    expect(entry).toMatchObject({
      ts: T0 + 10, kind: 'account', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot', pepper), hashKey: usernameHashKeyId(pepper),
      records: 'delete', guestEra: true, label: 'Former player #1', by: 'host:teacher',
    });
    expect(counts.accounts).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE name_key = 'novapilot'")).toBe(0);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/NovaPilot|novapilot/i); // ids and hashes only
    expect(readLedger(file).entries).toEqual([entry]);
    // The same entry re-applied later (after a restore) changes nothing more.
    const again = await applyLedger(db, readLedger(file).entries, { peppers: [pepper] });
    expect(again.changed).toBe(0);
    // The next deletion takes the next label.
    const k = await deleteAccountRecorded(db, file, { accountId: 'acc-keep', username: 'KeepPilot', records: 'pseudonymise', by: 'host:teacher' }, { pepper });
    expect(k.entry.label).toBe('Former player #2');
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE name = 'Former player #2'")).toBe(1);
    db.close();
  });

  it('a delete cut short after the ledger line (a crash, a cancel) is finished by the next re-apply', async () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    const db = open(t.db);
    world(db);
    const ac = new AbortController();
    ac.abort();
    await expect(deleteAccountRecorded(db, file, { accountId: 'acc-nova', username: 'NovaPilot', by: 'cli' }, { signal: ac.signal })).rejects.toThrow(/cancelled/);
    expect(readLedger(file).entries).toHaveLength(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM accounts WHERE id = 'acc-nova'")).toBe(1); // not done yet
    const r = await applyLedger(db, readLedger(file).entries);
    expect(r.changed).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM accounts WHERE id = 'acc-nova'")).toBe(0);
    db.close();
  });

  it('purgeRecorded logs { kind: purge, before, accountId? } and purges; the re-apply is a no-op', async () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    const db = open(t.db);
    world(db);
    const { entry, counts } = await purgeRecorded(db, file, { before: T0 + 2, by: 'host:teacher', ts: T0 + 50 });
    expect(entry).toEqual({ ts: T0 + 50, kind: 'purge', by: 'host:teacher', before: T0 + 2 });
    expect(counts.chat).toBe(2); // the guest line and NovaPilot's first
    const one = await purgeRecorded(db, file, { before: T0 + 100, accountId: 'acc-keep', by: 'host:teacher', ts: T0 + 60 });
    expect(one.entry.accountId).toBe('acc-keep');
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE account_id = 'acc-keep'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM chat_log WHERE account_id = 'acc-nova'")).toBe(1);
    expect((await applyLedger(db, readLedger(file).entries)).changed).toBe(0);
    db.close();
  });
});

// ------------------------------------------------------------------------------------------
// Verifier round 3: a year's ledger re-applied on every restore (batched), and lines a newer version wrote
// ------------------------------------------------------------------------------------------

/** Every table a deletion touches, as rows (for comparing two databases). */
function dump(db: DatabaseSync): string {
  const t: [string, string][] = [
    ['accounts', 'id'], ['chat_log', 'id'], ['chat_tags', 'chat_id, tag'], ['conduct_daily', 'account_key, day, tag'], ['reports', 'id'],
    ['mod_actions', 'id'], ['bans', 'id'], ['sessions', 'token_hash'], ['flag_reviews', 'chat_id'], ['wellbeing_acks', 'chat_id'],
  ];
  return JSON.stringify([...t.map(([n, o]) => db.prepare(`SELECT * FROM ${n} ORDER BY ${o}`).all()), db.prepare("SELECT v FROM mod_meta WHERE k = 'former_seq'").all()]);
}

describe('T-BAK-3: applyLedger gives exactly what the entries applied one by one give', () => {
  it('batched text scrub, skipped no-op accounts and collapsed purges: same tables, far less work, idempotent', async () => {
    const t = scratch();
    const db = open(t.db);
    const pepper = Buffer.alloc(32, 7);
    world(db);
    // A name reused: a second "NovaPilot" registered after the first was deleted, and another student, Vega.
    addAccount(db, { id: 'acc-vega', username: 'VegaPilot' });
    addChat(db, { ts: T0 + 30, accountId: 'acc-vega', name: 'VegaPilot', original: 'vega line' });
    addAction(db, { action: 'mute', targetId: 'acc-vega', targetName: 'VegaPilot', reason: 'VegaPilot and NovaPilot argued' });
    addAccount(db, { id: 'acc-nova2', username: 'NovaPilot2x' });
    const h = (u: string): string => usernameHash(u, pepper);
    const hk = usernameHashKeyId(pepper);
    const entries: LedgerEntry[] = [
      { ts: T0 + 10, kind: 'account', accountId: 'acc-nova', usernameHash: h('NovaPilot'), hashKey: hk, records: 'delete', guestEra: true, label: 'Former player #1', by: 'host' },
      { ts: T0 + 40, kind: 'account', accountId: 'acc-vega', usernameHash: h('VegaPilot'), hashKey: hk, records: 'pseudonymise', label: 'Former player #2', by: 'host' },
      { ts: T0 + 45, kind: 'account', accountId: 'acc-gone', usernameHash: h('GonePilot'), hashKey: hk, records: 'delete', label: 'Former player #3', by: 'host' },
      ...Array.from({ length: 30 }, (_, d): LedgerEntry => ({ ts: T0 + 50 + d, kind: 'purge', before: T0 - 200 + d, by: 'system' })),
      { ts: T0 + 90, kind: 'purge', before: T0 + 5, accountId: 'acc-keep', by: 'host' },
    ];
    db.close();
    const copy = path.join(t.dir, 'copy.db');
    fs.copyFileSync(t.db, copy);
    const a = open(t.db);
    for (const e of [...entries].sort((x, y) => x.ts - y.ts)) {
      if (e.kind === 'account') await eraseAccount(a, { accountId: e.accountId!, usernameHash: e.usernameHash, pepper, records: e.records, guestEra: e.guestEra, label: e.label, at: e.ts });
      else await purgeChatBefore(a, { before: e.before!, accountId: e.accountId });
    }
    const b = open(copy);
    const r = await applyLedger(b, entries, { peppers: [pepper] });
    expect(dump(b)).toBe(dump(a));
    expect(r.changed).toBeGreaterThanOrEqual(3);
    expect((await applyLedger(b, entries, { peppers: [pepper] })).changed).toBe(0);
    expect(dump(b)).toBe(dump(a));
    a.close();
    b.close();
  });

  it('scrubNamesInText: one walk for many names; a reused name takes the label of the earliest deletion at or after the row', async () => {
    const t = scratch();
    const db = open(t.db);
    const ids = [addAction(db, { reason: 'first NovaPilot' }), addAction(db, { reason: 'then NovaPilot again' }), addAction(db, { reason: 'NovaPilot later still' })];
    const ts = ids.map((id) => Number((db.prepare('SELECT ts FROM mod_actions WHERE id = ?').get(id) as { ts: number }).ts));
    const hasher = nameHasher(null);
    const s1 = { hash: usernameHash('NovaPilot'), hasherId: hasherIdOf(null), hasher, label: 'Former player #1', at: ts[0]! };
    const s2 = { hash: usernameHash('NovaPilot'), hasherId: hasherIdOf(null), hasher, label: 'Former player #2', at: ts[1]! };
    const r = await scrubNamesInText(db, [s2, s1]);
    expect(r.auditRows).toBe(2);
    expect(r.hits.get(s1)).toBe(1);
    expect(r.hits.get(s2)).toBe(1);
    expect(db.prepare('SELECT reason FROM mod_actions ORDER BY id').all().map((x) => (x as { reason: string }).reason))
      .toEqual(['first Former player #1', 'then Former player #2 again', 'NovaPilot later still']); // after both: untouched
    expect((await scrubNamesInText(db, [s1, s2])).auditRows).toBe(0);
    db.close();
  });

  it('accountFootprint: true while anything names the account id, false once it is fully erased', async () => {
    const t = scratch();
    const db = open(t.db);
    world(db);
    expect(accountFootprint(db, 'acc-nova')).toBe(true);
    expect(accountFootprint(db, 'acc-never')).toBe(false);
    await eraseAccount(db, { accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot'), records: 'delete', guestEra: true, label: 'Former player #1' });
    expect(accountFootprint(db, 'acc-nova')).toBe(false);
    db.close();
  });
});

// ------------------------------------------------------------------------------------------
// Verifier round 4: purges an account step depends on, a moderator's name, and random ledgers
// ------------------------------------------------------------------------------------------

const DAY = 86_400_000;

/** What the live deletions did: every entry on its own, oldest first (a purge with the cut it made). */
async function oneByOne(db: DatabaseSync, entries: readonly LedgerEntry[], pepper: Buffer | null): Promise<void> {
  for (const e of [...entries].sort((x, y) => x.ts - y.ts)) {
    if (e.kind === 'purge') await purgeChatBefore(db, { before: effectiveCut({ ts: e.ts, before: e.before! }), accountId: e.accountId ?? null }, { pause: async () => undefined });
    else await eraseAccount(db, { accountId: e.accountId!, usernameHash: e.usernameHash, pepper, records: e.records, guestEra: e.guestEra, label: e.label, at: e.ts }, { pause: async () => undefined });
  }
}

/** Two copies of `t.db`: (a) the entries one by one, (b) applyLedger. */
async function bothWays(t: TmpData, entries: readonly LedgerEntry[], pepper: Buffer | null): Promise<{ a: DatabaseSync; b: DatabaseSync }> {
  const copy = path.join(t.dir, `copy-${Math.random().toString(16).slice(2)}.db`);
  fs.copyFileSync(t.db, copy);
  const a = open(t.db);
  await oneByOne(a, entries, pepper);
  const b = open(copy);
  await applyLedger(b, entries, { peppers: [pepper], pause: async () => undefined });
  return { a, b };
}

describe('T-BAK-3: the purges an account step depends on run before it', () => {
  it('a student\'s own purge, then pseudonymise: the purged lines and their report copies never come back as "Former player #N"', async () => {
    const t = scratch();
    const db = open(t.db);
    const file = ledgerPath(t.dir);
    const pepper = Buffer.alloc(32, 3);
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    const ids = Array.from({ length: 10 }, (_, i) => addChat(db, { ts: T0 + i * DAY, accountId: 'acc-nova', name: 'NovaPilot', original: `nova line ${i}` }));
    addReport(db, { reporterName: 'KeepPilot', targetName: 'NovaPilot', targetId: 'acc-nova', ts: T0 + 11 * DAY,
      copies: [{ id: ids[3], ts: T0 + 3 * DAY, name: 'NovaPilot', accountId: 'acc-nova', shown: 'nova line 3' }] });
    db.close();
    const backup = path.join(t.dir, 'backup.db');
    fs.copyFileSync(t.db, backup);
    const live = open(t.db);
    await purgeRecorded(live, file, { before: T0 + 5 * DAY, accountId: 'acc-nova', by: 'host:teacher', ts: T0 + 13 * DAY });
    await deleteAccountRecorded(live, file, { accountId: 'acc-nova', username: 'NovaPilot', records: 'pseudonymise', by: 'host:teacher', ts: T0 + 14 * DAY }, { pepper });
    const want = dump(live);
    expect(count(live, 'SELECT COUNT(*) AS n FROM chat_log')).toBe(5);
    live.close();
    // The restore: the backup from before both, with the ledger re-applied.
    const restored = open(backup);
    await applyLedger(restored, readLedger(file).entries, { peppers: [pepper] });
    expect(count(restored, 'SELECT COUNT(*) AS n FROM chat_log WHERE ts < ?', T0 + 5 * DAY)).toBe(0);
    expect(count(restored, "SELECT COUNT(*) AS n FROM reports WHERE recent_chat_json <> '[]'")).toBe(0);
    expect(dump(restored)).toBe(want);
    restored.close();
  });

  it('a global purge, then a guest-era deletion: the addresses on lines the purge had removed take no guest rows', async () => {
    const t = scratch();
    const db = open(t.db);
    const pepper = Buffer.alloc(32, 4);
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    // Her old line from 10.0.0.1 (purged first), her recent one from 10.0.0.2; guest lines under her name from both.
    addChat(db, { ts: T0, accountId: 'acc-nova', name: 'NovaPilot', address: '10.0.0.1' });
    addChat(db, { ts: T0 + 10 * DAY, accountId: 'acc-nova', name: 'NovaPilot', address: '10.0.0.2' });
    addChat(db, { ts: T0 + 6 * DAY, accountId: null, name: 'novapilot', address: '10.0.0.1', original: 'guest from the old address' });
    addChat(db, { ts: T0 + 7 * DAY, accountId: null, name: 'novapilot', address: '10.0.0.2', original: 'guest from the new address' });
    addConduct(db, 'g:novapilot', dayOf(T0 + 6 * DAY));
    db.prepare("INSERT INTO bans (kind, scope, username, address_prefix, created_at, reason, by) VALUES ('mute', 'guest', 'novapilot', '10.0.0.1', ?, 'spam', 'host')").run(T0 + 6 * DAY);
    db.close();
    const entries: LedgerEntry[] = [
      { ts: T0 + 20 * DAY, kind: 'purge', before: T0 + DAY, by: 'system' },
      { ts: T0 + 21 * DAY, kind: 'account', accountId: 'acc-nova', usernameHash: usernameHash('NovaPilot', pepper), hashKey: usernameHashKeyId(pepper), records: 'delete', guestEra: true, label: 'Former player #1', by: 'host' },
    ];
    const { a, b } = await bothWays(t, entries, pepper);
    expect(dump(b)).toBe(dump(a));
    // Only the guest line from the address still on her lines went; the other guest line, its counter and ban stay.
    expect(b.prepare('SELECT original FROM chat_log ORDER BY id').all().map((r) => (r as { original: string }).original)).toEqual(['guest from the old address']);
    expect(count(b, "SELECT COUNT(*) AS n FROM bans WHERE scope = 'guest'")).toBe(1);
    a.close();
    b.close();
  });

  it('random ledgers: applyLedger and the entries one by one give the same tables (and a second run changes nothing)', async () => {
    const t = scratch();
    const template = path.join(t.dir, 'template.db');
    fs.copyFileSync(t.db, template);
    const pepper = Buffer.alloc(32, 9);
    const users = ['NovaPilot', 'KeepPilot', 'AceRunner', 'ZedStar', 'MoxWing'];
    let s = 12345;
    const r = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    const pick = <X>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
    for (let seed = 0; seed < 60; seed++) {
      fs.copyFileSync(template, t.db);
      const db = open(t.db);
      users.forEach((u, i) => addAccount(db, { id: `acc-${i}`, username: u }));
      const lines: { id: number; ts: number; acc: string | null; name: string }[] = [];
      for (let n = 0; n < 40; n++) {
        const ui = Math.floor(r() * users.length);
        const guest = r() < 0.3;
        const ts = T0 + Math.floor(r() * 20 * DAY);
        const acc = guest ? null : `acc-${ui}`;
        const id = addChat(db, { ts, accountId: acc, name: users[ui]!, address: `10.0.0.${1 + Math.floor(r() * 4)}`, original: `o${n} ${users[ui]}`, shown: `s${n}` });
        lines.push({ id, ts, acc, name: users[ui]! });
        if (r() < 0.2) addTag(db, id, 'PROFANITY', acc, ts);
        if (r() < 0.15) db.prepare("INSERT INTO flag_reviews (chat_id, status, by, at, note) VALUES (?, 'ok', ?, ?, ?)").run(id, pick(users), ts + DAY, `checked with ${pick(users)}`);
      }
      for (let n = 0; n < 6; n++) {
        const a = Math.floor(r() * users.length); const tg = Math.floor(r() * users.length);
        const copies = lines.filter(() => r() < 0.1).slice(0, 4).map((c) => ({ id: c.id, ts: c.ts, name: c.name, accountId: c.acc, shown: 'x' }));
        const rid = addReport(db, { reporterName: users[a]!, reporterId: r() < 0.7 ? `acc-${a}` : null, targetName: users[tg]!, targetId: r() < 0.7 ? `acc-${tg}` : null,
          reason: `${users[tg]} was rude to ${users[a]}`, ts: T0 + Math.floor(r() * 20 * DAY), copies });
        if (r() < 0.5) db.prepare("UPDATE reports SET status = 'reviewed', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(pick(users), T0 + Math.floor(r() * 40 * DAY), rid);
      }
      for (let n = 0; n < 6; n++) {
        const tg = Math.floor(r() * users.length);
        const guestBan = r() < 0.4;
        db.prepare(`INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, reason, by) VALUES ('mute', ?, ?, ?, ?, ?, ?, ?)`)
          .run(guestBan ? 'guest' : 'account', guestBan ? null : `acc-${tg}`, users[tg]!, guestBan ? `10.0.0.${1 + Math.floor(r() * 4)}` : null,
            T0 + Math.floor(r() * 30 * DAY), `spam, said ${users[tg]}`, pick(users));
      }
      for (let d = 0; d < 20; d++) if (r() < 0.5) addConduct(db, r() < 0.7 ? `acc-${Math.floor(r() * users.length)}` : `g:${nameKeyOf(pick(users))}`, dayOf(T0 + d * DAY));
      db.close();
      const entries: LedgerEntry[] = [];
      const used = new Set<number>();
      let label = 1;
      const n = 2 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const ts = T0 + Math.floor((20 + r() * 20) * DAY);
        const k = r();
        if (k < 0.45) {
          const ui = Math.floor(r() * users.length);
          if (used.has(ui)) continue;
          used.add(ui);
          entries.push({ ts, kind: 'account', by: 'host:t', accountId: `acc-${ui}`, usernameHash: usernameHash(users[ui]!, pepper), hashKey: usernameHashKeyId(pepper),
            records: r() < 0.5 ? 'pseudonymise' : 'delete', ...(r() < 0.5 ? { guestEra: true } : {}), label: `Former player #${label++}` });
        } else if (k < 0.7) {
          entries.push({ ts, kind: 'purge', by: 'host:t', before: T0 + Math.floor(r() * 20 * DAY) });
        } else {
          entries.push({ ts, kind: 'purge', by: 'host:t', before: T0 + Math.floor(r() * 20 * DAY), accountId: `acc-${Math.floor(r() * users.length)}` });
        }
      }
      const { a, b } = await bothWays(t, entries, pepper);
      const want = dump(a);
      expect({ seed, tables: dump(b) }).toEqual({ seed, tables: want });
      expect((await applyLedger(b, entries, { peppers: [pepper], pause: async () => undefined })).changed).toBe(0);
      expect(dump(b)).toBe(want);
      a.close();
      b.close();
      for (const f of fs.readdirSync(t.dir)) if (f.startsWith('copy-')) fs.rmSync(path.join(t.dir, f), { force: true });
    }
  }, 60_000);
});

describe('T-ADM-10 / T-BAK-3: a deleted moderator\'s name', () => {
  it('goes from the bans they set, the reports they reviewed and their review marks (up to the deletion), live and re-applied', async () => {
    const t = scratch();
    const db = open(t.db);
    const pepper = Buffer.alloc(32, 5);
    addAccount(db, { id: 'acc-mod', username: 'ModPilot' });
    addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
    const line = addChat(db, { ts: T0, accountId: 'acc-keep', name: 'KeepPilot' });
    const line2 = addChat(db, { ts: T0 + 1, accountId: 'acc-keep', name: 'KeepPilot' });
    db.prepare("INSERT INTO bans (kind, scope, account_id, username, created_at, reason, by) VALUES ('mute', 'account', 'acc-keep', 'KeepPilot', ?, 'ModPilot saw spam', 'ModPilot')").run(T0);
    // A later moderator who took the freed name: never touched.
    db.prepare("INSERT INTO bans (kind, scope, address_prefix, created_at, reason, by) VALUES ('ban', 'address', '10.0.0.5', ?, 'x', 'modpilot')").run(T0 + 30 * DAY);
    const rep = addReport(db, { reporterName: 'KeepPilot', reporterId: 'acc-keep', targetName: 'SomeGuest', ts: T0 });
    db.prepare("UPDATE reports SET status = 'reviewed', reviewed_by = 'ModPilot', reviewed_at = ?, note = 'ModPilot: fine' WHERE id = ?").run(T0 + DAY, rep);
    db.prepare("INSERT INTO flag_reviews (chat_id, status, by, at, note) VALUES (?, 'ok', 'ModPilot', ?, 'looked at by ModPilot')").run(line, T0 + DAY);
    db.prepare("INSERT INTO wellbeing_acks (chat_id, acked_at, acked_by, note) VALUES (?, ?, 'ModPilot', NULL)").run(line2, T0 + DAY);
    db.close();
    const backup = path.join(t.dir, 'backup.db');
    fs.copyFileSync(t.db, backup);
    const file = ledgerPath(t.dir);
    const live = open(t.db);
    await deleteAccountRecorded(live, file, { accountId: 'acc-mod', username: 'ModPilot', records: 'delete', by: 'host:teacher', ts: T0 + 10 * DAY, label: 'Former player #7' }, { pepper });
    const names = (d: DatabaseSync): unknown => ({
      bans: d.prepare('SELECT by, reason FROM bans ORDER BY id').all(),
      report: d.prepare('SELECT reviewed_by, note FROM reports').get(),
      flag: d.prepare('SELECT by, note FROM flag_reviews').get(),
      ack: d.prepare('SELECT acked_by FROM wellbeing_acks').get(),
    });
    expect(names(live)).toEqual({
      bans: [{ by: 'Former player #7', reason: 'Former player #7 saw spam' }, { by: 'modpilot', reason: 'x' }],
      report: { reviewed_by: 'Former player #7', note: 'Former player #7: fine' },
      flag: { by: 'Former player #7', note: 'looked at by Former player #7' },
      ack: { acked_by: 'Former player #7' },
    });
    const want = dump(live);
    live.close();
    const restored = open(backup);
    const r = await applyLedger(restored, readLedger(file).entries, { peppers: [pepper] });
    expect(r.changed).toBe(1);
    expect(dump(restored)).toBe(want);
    restored.close();
  });
});

describe('T-BAK-3: a purge re-applied never takes lines written after it', () => {
  it('"everything before Friday" chosen on Tuesday: the ledger records the cut it made, and a re-apply keeps later lines', async () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    const db = open(t.db);
    addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
    addChat(db, { ts: T0 - 5000, accountId: 'acc-nova', name: 'NovaPilot', original: 'old line' });
    const { entry, counts } = await purgeRecorded(db, file, { before: T0 + 7 * 86_400_000, by: 'host:teacher', ts: T0 });
    expect(counts.chat).toBe(1);
    expect(entry.before).toBe(effectiveCut({ ts: T0, before: T0 + 7 * 86_400_000 }));
    expect(entry.before).toBe(T0 + 1);
    addChat(db, { ts: T0 + 1000, accountId: 'acc-nova', name: 'NovaPilot', original: 'said after the purge 1' });
    addChat(db, { ts: T0 + 2 * 86_400_000, accountId: 'acc-nova', name: 'NovaPilot', original: 'said after the purge 2' });
    expect((await applyLedger(db, readLedger(file).entries)).purges.chat).toBe(0);
    // An entry written by hand (or an older version) with the future date is clamped the same way.
    expect((await applyLedger(db, [{ ts: T0, kind: 'purge', before: T0 + 7 * 86_400_000, by: 'host' }])).purges.chat).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chat_log')).toBe(2);
    db.close();
  });
});

describe('T-BAK-3: a rewrite keeps lines it does not understand', () => {
  it('writeLedger writes each entry as it was read (extra fields kept) plus the unknown lines, once', () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    const withExtra = JSON.stringify({ ts: 3, kind: 'account', by: 'host', accountId: 'acc-a', records: 'delete', futureField: { x: 1 } });
    const newer = JSON.stringify({ ts: 4, kind: 'guest', by: 'host' });
    fs.writeFileSync(file, `${withExtra}\n${newer}\n{"ts":`);
    const p = readLedger(file);
    expect(p.entries).toHaveLength(1);
    expect(p.unknown).toEqual([newer]);
    expect(p.bad).toBe(2);
    const made: LedgerEntry = { ts: 9, kind: 'purge', before: 1, by: 'host' };
    writeLedger(file, mergeLedgers(p.entries, [made]), { keep: mergeUnknownLines(p.unknown, [newer]) });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${withExtra}\n${JSON.stringify(made)}\n${newer}\n`);
  });
});

describe('T-BAK-3: lineage (which data an entry belongs to)', () => {
  const k1 = Buffer.alloc(32, 0x11);
  const k2 = Buffer.alloc(32, 0x22);

  it('nativeLineage is derived from the backup key: stable, 12 hex digits, one per key', () => {
    expect(nativeLineage(k1)).toMatch(/^[0-9a-f]{12}$/);
    expect(nativeLineage(k1)).toBe(nativeLineage(Buffer.from(k1)));
    expect(nativeLineage(k2)).not.toBe(nativeLineage(k1));
  });

  it('a database carries its lineage in mod_meta: stamped once, read back exactly (an all-digit one too), a bad value replaced', () => {
    const t = scratch();
    const db = open(t.db);
    try {
      expect(dbLineage(db)).toBeNull();
      expect(ensureLineage(db, '123456789012')).toBe('123456789012');
      expect(dbLineage(db)).toBe('123456789012');
      expect(ensureLineage(db, 'abcdefabcdef')).toBe('123456789012'); // never re-stamped
      db.prepare("UPDATE mod_meta SET v = 'not a lineage' WHERE k = ?").run(LINEAGE_META_KEY);
      expect(dbLineage(db)).toBeNull();
      expect(ensureLineage(db, '00000000abcd')).toBe('00000000abcd');
      expect(dbLineage(db)).toBe('00000000abcd');
      expect(() => ensureLineage(db, 'nope')).not.toThrow(); // already stamped: the fallback is not looked at
    } finally {
      db.close();
    }
  });

  it('the live deletions stamp the database lineage (the fallback stamps an unstamped database first; none without it)', async () => {
    const t = scratch();
    const lp = ledgerPath(t.dir);
    const db = open(t.db);
    try {
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      addAccount(db, { id: 'acc-keep', username: 'KeepPilot' });
      const p0 = await purgeRecorded(db, lp, { before: T0, by: 'host', ts: T0 + 10 });
      expect(p0.entry.lineage).toBeUndefined(); // unstamped database, no fallback: the next restore attributes it
      expect(dbLineage(db)).toBeNull();
      const d = await deleteAccountRecorded(db, lp, { accountId: 'acc-nova', username: 'NovaPilot', by: 'host', ts: T0 + 20 }, { lineage: nativeLineage(k1) });
      expect(d.entry.lineage).toBe(nativeLineage(k1));
      expect(dbLineage(db)).toBe(nativeLineage(k1));
      const p1 = await purgeRecorded(db, lp, { before: T0, by: 'host', ts: T0 + 30 }, { lineage: nativeLineage(k2) });
      expect(p1.entry.lineage).toBe(nativeLineage(k1)); // the database's own, never the fallback over it
      const e = appendLedgerFor(db, lp, { ts: T0 + 40, kind: 'purge', by: 'host', before: T0, lineage: 'abcdefabcdef' });
      expect(e.lineage).toBe(nativeLineage(k1)); // what the caller claims doesn't count
      expect(readLedger(lp).entries.map((x) => x.lineage ?? null)).toEqual([null, nativeLineage(k1), nativeLineage(k1), nativeLineage(k1)]);
    } finally {
      db.close();
    }
  });

  it('a bad lineage makes a line an unknown one (kept, not applied); the same cut on two data is two deletions', () => {
    const base = { ts: 5, kind: 'purge', by: 'host', before: 3 };
    expect(validateEntry({ ...base, lineage: 'abcdefabcdef' })).toMatchObject({ lineage: 'abcdefabcdef' });
    expect(validateEntry({ ...base, lineage: 'ABC' })).toBeNull();
    expect(parseLedger(`${JSON.stringify({ ...base, lineage: 'ABC' })}\n`).unknown).toHaveLength(1);
    const a = validateEntry({ ...base, lineage: 'aaaaaaaaaaaa' })!;
    const b = validateEntry({ ...base, lineage: 'bbbbbbbbbbbb' })!;
    expect(entryKey(a)).not.toBe(entryKey(b));
    expect(mergeLedgers([a], [b])).toHaveLength(2);
  });

  it('scopeLedgers: an entry without one goes to the data beside its ledger; a stamped one keeps its own', () => {
    const cur = 'cccccccccccc';
    const bak = 'bbbbbbbbbbbb';
    const onlyCurrent = validateEntry({ ts: 3, kind: 'purge', by: 'host', before: 3 })!;
    const sameCut = validateEntry({ ts: 1, kind: 'purge', by: 'host', before: 1 })!; // both hosts purged "before day X"
    const stamped = validateEntry({ ts: 2, kind: 'purge', by: 'host', before: 2, lineage: 'aaaaaaaaaaaa' })!;
    const onlyBackup = validateEntry({ ts: 4, kind: 'account', by: 'host', accountId: 'acc-y' })!;
    const merged = scopeLedgers({ current: [sameCut, onlyCurrent, stamped], currentLineage: cur, backup: [sameCut, onlyBackup, stamped], backupLineage: bak });
    expect(merged.map((e) => [e.ts, e.lineage])).toEqual([[1, cur], [1, bak], [2, 'aaaaaaaaaaaa'], [3, cur], [4, bak]]);
    expect(entriesOf(merged, bak).map((e) => e.ts)).toEqual([1, 4]);
    // The same data on both sides (a restore of this install's own backup): one entry each.
    const own = scopeLedgers({ current: [sameCut, onlyCurrent], currentLineage: cur, backup: [sameCut], backupLineage: cur });
    expect(own.map((e) => [e.ts, e.lineage])).toEqual([[1, cur], [3, cur]]);
  });

  it("applicableEntries: this data's entries, plus another data's account deletions whose account is here (never its purges or other names)", () => {
    const t = scratch();
    const db = open(t.db);
    try {
      addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
      addChat(db, { ts: T0 + 1, accountId: 'acc-gone', name: 'GonePilot', original: 'a line of an account row deleted by hand' });
      const own = 'aaaaaaaaaaaa';
      const other = 'bbbbbbbbbbbb';
      const e = (x: Partial<LedgerEntry>): LedgerEntry => validateEntry({ ts: T0, kind: 'account', by: 'host', ...x })!;
      const entries = [
        e({ accountId: 'acc-own', lineage: own }), // this data's, whatever is left of it
        e({ kind: 'purge', before: T0, lineage: own }),
        e({ accountId: 'acc-nova', lineage: other }), // the same student (the same random id), under another lineage
        e({ accountId: 'acc-gone', lineage: other }), // only a chat line left under that id: still present
        e({ accountId: 'acc-else', lineage: other, usernameHash: 'f'.repeat(64) }), // not here: its name scrub stays out
        e({ kind: 'purge', before: T0, lineage: other }),
        e({ accountId: 'acc-unscoped' }), // no lineage (recorded beside the live data since the last restore)
      ];
      const r = applicableEntries(db, entries, own);
      expect(r.entries.map((x) => x.accountId ?? `purge:${x.lineage}`)).toEqual(['acc-own', `purge:${own}`, 'acc-nova', 'acc-gone']);
      expect(r).toMatchObject({ own: 2, crossData: 2, otherData: 3 });
      // The worker's ledger.apply, beside the live data: the unscoped entry is the live data's too.
      expect(applicableEntries(db, entries, own, { unscoped: true }).entries.map((x) => x.accountId ?? 'purge')).toEqual(['acc-own', 'purge', 'acc-nova', 'acc-gone', 'acc-unscoped']);
      // No lineage known (an older database): only the account deletions whose account is here.
      expect(applicableEntries(db, entries, null).entries.map((x) => x.accountId)).toEqual(['acc-nova', 'acc-gone']);
    } finally {
      db.close();
    }
  });

  it('stamping an entry read from a line keeps the fields a newer version added', () => {
    const t = scratch();
    const file = ledgerPath(t.dir);
    const line = JSON.stringify({ ts: 7, kind: 'purge', by: 'host', before: 3, scope: 'room', roomUid: 'u1' });
    fs.writeFileSync(file, `${line}\n`);
    const [e] = readLedger(file).entries;
    writeLedger(file, [withLineage(e!, 'abcdefabcdef')]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...JSON.parse(line) as object, lineage: 'abcdefabcdef' });
  });
});
