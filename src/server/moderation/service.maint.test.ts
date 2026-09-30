// The ModerationService with the real maintenance worker (docs/LAN-EDITION-proposal.md §5.5, §5.15; task B8b): the
// streamed Chat log export through the shared CSV writer (T-CSV-1 for the chat export; what they typed only when
// ticked; wellbeing lines only when ticked; Save on this PC; the 7-day cleanup; audited), the manual purge (409 with
// the count, then the recorded purge; T-ADM-8 through the service), log/stats with retention, the retention run
// against the real database (T-ADM-9 end to end), the wellbeing alerts after a restart, and the same endpoints over
// the admin API. Test data only: generated names and passwords.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatLogEntry } from '../../shared/room/moderation';
import { startAdminListener } from '../listeners';
import type { MaintClient } from '../maint/client';
import { ledgerPath, readLedger } from '../maint/ledger';
import { addAccount, count, open, tmpData, type TmpData } from '../maint/testutil';
import { startWriteWorker } from '../maint/writes.testutil';
import { CSV_BOM } from './csv';
import { DEFAULT_ADMIN_POLICY, HostAdmin, formatSetupCode, newSetupCode, type AdminPolicy } from './hostAdmin';
import { createAdminHttp, createAdminSite } from './http';
import { ModerationService, moderationAdminHandlers, PURGE_NOTE } from './service';

const DAY = 86_400_000;
const FAST = { N: 1 << 10, r: 8, p: 1, keylen: 32 } as const;
const HOST = { accountId: 'host', name: 'NovaHost' };

const temps: TmpData[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) t.cleanup();
});

interface Rig { svc: ModerationService; worker: MaintClient; t: TmpData; clock: { t: number }; backups: string[]; dirty: number[] }

async function rig(o: { clock?: boolean } = {}): Promise<Rig> {
  const t = tmpData('vs-modmaint-');
  temps.push(t);
  const db = open(t.db);
  for (const u of ['NovaPilot', 'VegaPilot']) addAccount(db, { id: `acc-${u.toLowerCase()}`, username: u });
  db.close();
  const clock = { t: Date.UTC(2026, 8, 28, 15, 0, 0) };
  const svc = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, ...(o.clock === false ? {} : { now: () => clock.t }) });
  const worker = await startWriteWorker(t);
  cleanups.push(async () => { svc.close(); await worker.close(); });
  const backups: string[] = [];
  const dirty: number[] = [];
  svc.attachMaint({ client: worker, backup: async (r) => { backups.push(r); return { ok: true }; }, indexDirty: () => { dirty.push(1); } });
  return { svc, worker, t, clock, backups, dirty };
}

let seq = 0;
function entry(over: Partial<ChatLogEntry> = {}): ChatLogEntry {
  seq++;
  return {
    time: Date.UTC(2026, 8, 28, 14, 0, 0) + seq * 1000, roomId: 'r2', roomName: 'Flag Run', roomUid: 'boot1:r2', channel: 'all', team: 0, playerId: 5,
    name: 'NovaPilot', accountId: 'acc-novapilot', address: '10.0.0.5', original: `line ${seq}`, shown: `line ${seq}`, action: 'pass', hits: [], display: 'as-typed', ...over,
  };
}

/** A few lines: a poisoned guest callsign, a substituted line, a wellbeing line, an ordinary one. */
function seed(svc: ModerationService): void {
  const h = svc.hook();
  h.logChat(entry({ name: '=HYPERLINK("http://x.test","x")', accountId: null, playerId: 8, original: '@SUM(A1)', shown: '+cmd|calc' }));
  h.logChat(entry({ original: 'the words they typed', shown: 'GG, pilots!', action: 'block', hits: ['profanity:x'], display: 'substituted' }));
  h.logChat(entry({ original: 'a private sad line', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' }));
  h.logChat(entry({ name: 'VegaPilot', accountId: 'acc-vegapilot', playerId: 6, original: 'nice shot', shown: 'nice shot' }));
  svc.flushAllQuiet();
}

const csvLines = (body: Buffer): string[] => body.toString('utf8').replace(CSV_BOM, '').split('\r\n').filter(Boolean);

describe('the Chat log export (§5.5 ★)', () => {
  it('CSV through the shared writer: BOM, neutralised cells, no typed text or wellbeing line unless ticked; audited with the row count', async () => {
    const { svc } = await rig();
    seed(svc);
    const r = await svc.exportChatLog({ filter: {}, actor: HOST });
    expect(r.ok).toBe(true);
    if (!r.ok || r.saved) return;
    expect(r.rows).toBe(3);
    expect(r.contentType).toBe('text/csv; charset=utf-8');
    expect(r.fileName).toMatch(/^voidswarm-chat-log-\d{4}-\d{2}-\d{2}_\d{6}\.csv$/);
    const text = r.body.toString('utf8');
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).not.toContain('the words they typed');
    expect(text).not.toContain('a private sad line');
    expect(text).not.toContain('what they typed');
    const lines = csvLines(r.body);
    expect(lines[0]).toBe('id,time,room,team,channel,player,account,what others saw,action,display,tags');
    expect(lines[1]).toContain('"\'=HYPERLINK(""http://x.test"",""x"")"');
    expect(lines[1]).toContain('"\'+cmd|calc"');
    expect(lines[2]).toContain('"GG, pilots!",block,substituted,PROFANITY');
    const act = svc.store.listActions({}).actions[0]!;
    expect(act).toMatchObject({ action: 'export', actor: 'NovaHost' });
    expect(act.reason).toMatch(/^chat log export: 3 line\(s\) \(csv, download\); filter: everything$/);

    // ticked: what they typed, and the wellbeing lines
    const all = await svc.exportChatLog({ filter: {}, actor: HOST, includeOriginal: true, includeWellbeing: true, searchOriginal: true });
    if (!all.ok || all.saved) throw new Error('export failed');
    expect(all.rows).toBe(4);
    const t2 = all.body.toString('utf8');
    expect(t2).toContain('what they typed');
    expect(t2).toContain('the words they typed');
    expect(t2).toContain('a private sad line');
    expect(t2).toContain('"\'@SUM(A1)"');
    expect(svc.store.listActions({}).actions[0]!.reason).toMatch(/with unfiltered text, with wellbeing lines/);

    // a filter (one student), JSON
    const one = await svc.exportChatLog({ filter: { accountId: 'acc-vegapilot' }, actor: HOST, format: 'json' });
    if (!one.ok || one.saved) throw new Error('export failed');
    expect(JSON.parse(one.body.toString('utf8'))).toEqual([expect.objectContaining({ player: 'VegaPilot', 'what others saw': 'nice shot', display: 'as-typed' })]);
    expect(svc.store.listActions({}).actions[0]).toMatchObject({ action: 'export', targetAccountId: 'acc-vegapilot' });
    // a text search matches the shown text unless the caller may search originals
    const shownOnly = await svc.exportChatLog({ filter: { q: 'words they' }, actor: HOST });
    expect(shownOnly.ok && shownOnly.rows).toBe(0);
    const bad = await svc.exportChatLog({ filter: { action: 'nonsense' }, actor: HOST });
    expect(bad).toMatchObject({ ok: false, status: 400, code: 'EARGS' });
  });

  it('Save on this PC writes data\\exports\\<file> (and deletes exports older than 7 days); a download stops past its cap', async () => {
    const { svc, t } = await rig({ clock: false });
    seed(svc);
    const dir = path.join(t.dir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'voidswarm-chat-log-2026-09-01_101500.csv');
    fs.writeFileSync(stale, 'old');
    const eightDaysAgo = (Date.now() - 8 * DAY) / 1000;
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
    const keep = path.join(dir, 'notes.txt');
    fs.writeFileSync(keep, 'not an export');
    const r = await svc.exportChatLog({ filter: {}, actor: HOST, saveOnHost: true });
    expect(r).toMatchObject({ ok: true, saved: true, rows: 3 });
    if (!r.ok || !r.saved) return;
    expect(r.savedTo).toBe(path.join('exports', r.fileName));
    const file = path.join(dir, r.fileName);
    expect(fs.readFileSync(file, 'utf8').startsWith(CSV_BOM)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('the words they typed');
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    expect(svc.store.listActions({}).actions[0]!.reason).toMatch(/saved on this PC/);
    const capped = await svc.exportChatLog({ filter: {}, actor: HOST, maxRows: 2 });
    expect(capped).toMatchObject({ ok: false, status: 413, code: 'tooBig' });
  });

  it('two Save on this PC exports in the same second (a double click) get two files; neither deletes the other', async () => {
    const { svc, t } = await rig(); // a fixed clock: both in the same second
    seed(svc);
    const [a, b] = await Promise.all([
      svc.exportChatLog({ filter: {}, actor: HOST, saveOnHost: true }),
      svc.exportChatLog({ filter: {}, actor: HOST, saveOnHost: true }),
    ]);
    expect(a).toMatchObject({ ok: true, saved: true, rows: 3 });
    expect(b).toMatchObject({ ok: true, saved: true, rows: 3 });
    if (!a.ok || !a.saved || !b.ok || !b.saved) return;
    expect(a.fileName).not.toBe(b.fileName);
    expect([a.fileName, b.fileName].filter((n) => /_\d{6}-2\.csv$/.test(n))).toHaveLength(1);
    const dir = path.join(t.dir, 'exports');
    expect(fs.readdirSync(dir).sort()).toEqual([a.fileName, b.fileName].sort());
    for (const f of [a.fileName, b.fileName]) expect(fs.readFileSync(path.join(dir, f), 'utf8').startsWith(CSV_BOM)).toBe(true);
    expect(svc.store.listActions({}).actions.filter((x) => (x.action as string) === 'export')).toHaveLength(2);
    // a cancelled save removes only its own part-written file
    const ac = new AbortController();
    ac.abort();
    const c = await svc.exportChatLog({ filter: {}, actor: HOST, saveOnHost: true, signal: ac.signal });
    expect(c).toMatchObject({ ok: false, status: 499 });
    expect(fs.readdirSync(dir).sort()).toEqual([a.fileName, b.fileName].sort());
  });

  it('without the worker: 503', async () => {
    const { svc } = await rig();
    svc.attachMaint(null);
    expect(await svc.exportChatLog({ filter: {}, actor: HOST })).toMatchObject({ ok: false, status: 503 });
    expect(await svc.purgeLog({ before: Date.now(), actor: HOST })).toMatchObject({ ok: false, status: 503 });
    expect(await svc.logStats()).toMatchObject({ ok: false, status: 503 });
  });
});

describe('the manual purge through the service (T-ADM-8)', () => {
  it('409 with the count first; with it, the lines go (recorded in the ledger), the Live ring forgets them, audited', async () => {
    const { svc, clock, t, dirty } = await rig();
    seed(svc);
    expect(svc.live.page({ includeWellbeing: true }).lines).toHaveLength(4);
    const ask = await svc.purgeLog({ before: clock.t + DAY, actor: HOST }); // a cut in the future means now
    expect(ask).toMatchObject({ ok: false, status: 409, needsConfirm: true, rows: 4, before: clock.t, note: PURGE_NOTE });
    expect(await svc.purgeLog({ before: clock.t, confirmRows: 3, actor: HOST })).toMatchObject({ status: 409, rows: 4 });
    const one = await svc.purgeLog({ before: clock.t, accountId: 'acc-vegapilot', actor: HOST });
    expect(one).toMatchObject({ status: 409, rows: 1 });
    const done = await svc.purgeLog({ before: clock.t, accountId: 'acc-vegapilot', confirmRows: 1, actor: HOST });
    expect(done).toMatchObject({ ok: true, deleted: 1, before: clock.t, note: PURGE_NOTE });
    expect(svc.live.page({ includeWellbeing: true }).lines.map((l) => l.name)).not.toContain('VegaPilot');
    const all = await svc.purgeLog({ before: clock.t, confirmRows: 3, actor: HOST });
    expect(all).toMatchObject({ ok: true, deleted: 3 });
    const db = open(t.db);
    try { expect(count(db, 'SELECT count(*) AS n FROM chat_log')).toBe(0); } finally { db.close(); }
    expect(readLedger(ledgerPath(t.dir)).entries.map((e) => [e.kind, e.accountId ?? null, e.by])).toEqual([
      ['purge', 'acc-vegapilot', 'host:NovaHost'], ['purge', null, 'host:NovaHost'],
    ]);
    expect(svc.store.listActions({}).actions.filter((a) => (a.action as string) === 'purge').map((a) => a.reason)).toEqual([
      expect.stringMatching(/^purged 3 chat line\(s\) before /), expect.stringMatching(/^purged 1 chat line\(s\) before .* \(one student\)$/),
    ]);
    expect(dirty.length).toBe(2);
    expect(svc.live.page({ includeWellbeing: true }).lines).toEqual([]);
    expect(await svc.purgeLog({ before: clock.t, confirmRows: 0, actor: HOST })).toMatchObject({ ok: true, deleted: 0 });
    expect(readLedger(ledgerPath(t.dir)).entries).toHaveLength(2); // nothing to delete: no ledger line
  });
});

describe('a purge that stops part way (§5.5: purges are always audited)', () => {
  it('the worker fails during purge.chat: 500, and an audit row says it stopped', async () => {
    const t = tmpData('vs-modmaint-pf-');
    temps.push(t);
    const clock = { t: Date.UTC(2026, 8, 28, 15, 0, 0) };
    const svc = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, now: () => clock.t });
    cleanups.push(() => svc.close());
    const dirty: number[] = [];
    svc.attachMaint({
      client: {
        call: async <R>(op: string): Promise<R> => {
          if (op === 'purge.count') return { rows: 600 } as R;
          if (op === 'purge.chat') throw Object.assign(new Error('The maintenance worker stopped.'), { code: 'EWORKER' });
          return { lines: [], owed: [] } as R;
        },
        stream: () => { throw new Error('no streams here'); },
      },
      indexDirty: () => { dirty.push(1); },
    });
    const r = await svc.purgeLog({ before: clock.t, confirmRows: 600, actor: HOST });
    expect(r).toMatchObject({ ok: false, status: 500 });
    const audits = svc.store.listActions({}).actions.filter((a) => (a.action as string) === 'purge');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: 'NovaHost' });
    expect(audits[0]!.reason).toMatch(/^purge of 600 chat line\(s\) before .* stopped part way \(The maintenance worker stopped\.\); some lines may already be gone$/);
    expect(dirty).toHaveLength(1);
  });
});

describe('term retention with the real worker: the owed purge survives a restart (T-ADM-9)', () => {
  it("the next date set during the grace: after a restart, on end + 14 the fall term's lines go (after the backup); later lines stay", async () => {
    const { svc, t, worker, clock, backups } = await rig();
    const local = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
    const policy = (termEnd: string): Parameters<ModerationService['setPolicy']>[0] => ({
      tags: {}, tagDefault: { strike: false, autoMuteAfter: null, notify: 'none', dailySummary: true },
      retention: { mode: 'term', days: 90, termEnd, graceDays: 14, recordsDays: 365 }, addressMinimisation: false, tier: 'limited',
      moderatorView: true, moderatorLogSearch: false,
    });
    const h = svc.hook();
    h.logChat(entry({ time: local(2026, 12, 10, 10), original: 'fall line', shown: 'fall line' }));
    h.logChat(entry({ time: local(2026, 12, 18, 10), original: 'last day line', shown: 'last day line' }));
    h.logChat(entry({ time: local(2026, 12, 21, 10), original: 'break line', shown: 'break line' }));
    svc.flushAllQuiet();
    svc.setPolicy(policy('2026-12-18'));
    clock.t = local(2026, 12, 22, 9);
    svc.setPolicy(policy('2027-05-28')); // the host follows the grace banner
    await svc.maintReady();
    expect(await worker.call('retention.term.get', {})).toEqual({ owed: [{ cut: local(2026, 12, 19), purgeAt: local(2027, 1, 2) }] });
    svc.close();

    clock.t = local(2027, 1, 2, 3);
    const again = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, now: () => clock.t });
    cleanups.push(() => again.close());
    again.setPolicy(policy('2027-05-28'));
    again.attachMaint({ client: worker, backup: async (r) => { backups.push(r); return { ok: true }; } });
    const run = await again.runRetention();
    expect(backups).toEqual(['pre-purge']);
    expect(run).toMatchObject({ chat: 2, where: 'worker' });
    const db = open(t.db);
    try { expect(db.prepare('SELECT original FROM chat_log ORDER BY ts').all()).toEqual([{ original: 'break line' }]); } finally { db.close(); }
    expect(await worker.call('retention.term.get', {})).toEqual({ owed: [] });
  });
});

describe('log/stats, retention against the database, and wellbeing after a restart', () => {
  it('log/stats carries retention and the next purge; the nightly run deletes old lines, keeps counters, clears acknowledged wellbeing text', async () => {
    const { svc, clock, t, worker } = await rig();
    const h = svc.hook();
    h.logChat(entry({ time: clock.t - 100 * DAY, original: 'ancient', shown: 'ancient', hits: ['profanity:x'], action: 'mask', display: 'substituted' }));
    h.logChat(entry({ time: clock.t - 40 * DAY, original: 'acked sad line', shown: '', hits: ['selfharm:x'], action: 'block', display: 'withheld' }));
    h.logChat(entry({ time: clock.t - DAY, original: 'recent', shown: 'recent' }));
    svc.flushAllQuiet();
    const st = await svc.logStats({ fresh: true });
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st).toMatchObject({ rows: 3, dropped: 0, pending: 0, retention: { mode: 'days', days: 90, recordsDays: 365, phase: 'days' } });
    expect(st.nextPurgeAt).toBe(svc.nextRetentionRunAt);
    // acknowledge the wellbeing line 35 days ago (the worker op the alert's ack uses)
    const db = open(t.db);
    const sadId = Number((db.prepare("SELECT id FROM chat_log WHERE display = 'withheld'").get() as { id: number }).id);
    db.close();
    expect(await worker.call('wellbeing.ack', { chatId: sadId, by: 'NovaHost', at: clock.t - 35 * DAY })).toMatchObject({ acked: true });
    const run = await svc.runRetention();
    expect(run).toMatchObject({ where: 'worker', phase: 'days', chat: 1, wellbeing: 1 });
    const db2 = open(t.db);
    try {
      expect(count(db2, 'SELECT count(*) AS n FROM chat_log')).toBe(2);
      expect(count(db2, 'SELECT count(*) AS n FROM conduct_daily')).toBe(1); // the ancient line's counter is a record (365 days)
      expect((db2.prepare('SELECT original FROM chat_log WHERE id = ?').get(sadId) as { original: string }).original).toBe('');
    } finally { db2.close(); }
  });

  it('unacknowledged wellbeing lines come back as nameless alerts after a restart; acknowledging one stores it', async () => {
    const { svc, t, worker } = await rig();
    svc.hook().logChat(entry({ original: 'sad words', shown: '', hits: ['selfharm:x'], action: 'block', display: 'withheld' }));
    svc.flushAllQuiet();
    // a new service on the same data (a restart)
    const again = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined });
    cleanups.push(() => again.close());
    again.attachMaint({ client: worker });
    await again.loadPendingWellbeing();
    const a = again.alertsList();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'wellbeing', wellbeing: true, roomName: 'Flag Run' });
    expect(a[0]!.chatId).toEqual(expect.any(Number));
    expect(JSON.stringify(a)).not.toContain('NovaPilot');
    expect(JSON.stringify(a)).not.toContain('sad words');
    expect((await again.ackAlert(a[0]!.id, HOST, 'checked in')).ok).toBe(true);
    const third = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined });
    cleanups.push(() => third.close());
    third.attachMaint({ client: worker });
    await third.maintReady();
    expect(third.alertsList()).toEqual([]);
  });

  it('a burst of wellbeing lines is one alert; acknowledging it stores every line, so none comes back', async () => {
    const { svc, t, worker } = await rig();
    const nova = { playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot', address: '10.0.0.5' };
    for (const text of ['first sad line', 'second sad line']) {
      const e = entry({ original: text, shown: '', hits: ['selfharm:x'], action: 'block', display: 'withheld' });
      svc.hook().logChat(e);
      svc.hook().alert!(nova, 'selfharm', e);
    }
    const [a] = svc.alertsList();
    expect(a).toMatchObject({ kind: 'wellbeing', count: 2 });
    expect((await svc.ackAlert(a!.id, HOST)).ok).toBe(true);
    const db = open(t.db);
    try { expect(count(db, 'SELECT count(*) AS n FROM wellbeing_acks')).toBe(2); } finally { db.close(); }
    const again = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined });
    cleanups.push(() => again.close());
    again.attachMaint({ client: worker });
    await again.maintReady();
    expect(again.alertsList()).toEqual([]);
  });

  it('an alert whose line the student typed 25 more lines after is still found (in the worker) and stored when acknowledged', async () => {
    const { svc, t, worker } = await rig();
    const nova = { playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot', address: '10.0.0.5' };
    const e = entry({ original: 'sad words', shown: '', hits: ['selfharm:x'], action: 'block', display: 'withheld' });
    svc.hook().logChat(e);
    svc.hook().alert!(nova, 'selfharm', e);
    for (let i = 0; i < 25; i++) svc.hook().logChat(entry());
    svc.flushAllQuiet();
    expect(svc.alertsList()[0]!.chatId).toBeNull(); // the quick look (the last 20 lines) can't see it
    await svc.resolveAlerts();
    const [a] = svc.alertsList();
    expect(a!.chatId).toEqual(expect.any(Number));
    expect((await svc.ackAlert(a!.id, HOST, 'checked in')).ok).toBe(true);
    const db = open(t.db);
    try { expect(db.prepare('SELECT chat_id FROM wellbeing_acks').all()).toEqual([{ chat_id: a!.chatId }]); } finally { db.close(); }
    const again = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined });
    cleanups.push(() => again.close());
    again.attachMaint({ client: worker });
    await again.maintReady();
    expect(again.alertsList()).toEqual([]);
  });

  it("an acknowledgement is refused while the alert's line is not in the log yet (DB busy); a purged line needs no ack row", async () => {
    const { svc, t } = await rig();
    const nova = { playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot', address: '10.0.0.5' };
    const lock = open(t.db);
    lock.exec('BEGIN IMMEDIATE'); // another writer holds the database: the chat log can't be written
    const e = entry({ original: 'sad words', shown: '', hits: ['selfharm:x'], action: 'block', display: 'withheld' });
    svc.hook().logChat(e);
    svc.hook().alert!(nova, 'selfharm', e);
    const [a] = svc.alertsList();
    const busy = await svc.ackAlert(a!.id, HOST);
    expect(busy).toMatchObject({ ok: false, status: 503, code: 'notLogged' });
    expect(svc.alertsList()[0]).toMatchObject({ acked: false });
    lock.exec('ROLLBACK');
    lock.close();
    expect((await svc.ackAlert(a!.id, HOST)).ok).toBe(true);
    // a wellbeing line purged before the host acknowledged its alert: nothing to store, nothing comes back
    const e2 = entry({ original: 'more sad words', shown: '', hits: ['selfharm:x'], action: 'block', display: 'withheld', time: Date.UTC(2026, 8, 28, 16) });
    svc.hook().logChat(e2);
    svc.hook().alert!({ ...nova, playerId: 7 }, 'selfharm', e2);
    svc.flushAllQuiet();
    const db = open(t.db);
    try { db.prepare("DELETE FROM chat_log WHERE original = 'more sad words'").run(); } finally { db.close(); }
    const b = svc.alertsList().find((x) => !x.acked)!;
    expect((await svc.ackAlert(b.id, HOST)).ok).toBe(true);
    const db2 = open(t.db);
    try { expect(count(db2, 'SELECT count(*) AS n FROM wellbeing_acks')).toBe(1); } finally { db2.close(); }
  });
});

// ------------------------------------------------------------------------------------------ over the admin API

interface Reply { status: number; text: string; json: Record<string, unknown>; headers: Record<string, unknown>; body: Buffer }

function post(port: number, name: string, body: unknown, token?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, path: `/api/admin/${name}`, method: 'POST', agent: false,
      headers: {
        Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a file */ }
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('log/export, log/purge, log/stats, alerts over the admin API', () => {
  it('a file with X-Row-Count; 409 then the purge; stats; alerts/list nameless and alerts/ack', async () => {
    const { svc, t } = await rig({ clock: false });
    const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY };
    const ha = new HostAdmin({ dbPath: t.db, policy: () => policy, passwordParams: FAST, pepper: randomBytes(32) });
    const api = createAdminHttp({ service: svc, trustProxy: false, log: () => undefined, hostAdmin: ha, policy: () => policy, handlers: moderationAdminHandlers(svc) });
    const listener = await startAdminListener({
      port: 0, policy: () => ({ remoteAccess: policy.remoteAccess, devicesTrustCert: policy.devicesTrustCert }), handle: createAdminSite({ api }),
      loopback: ['127.0.0.1'], lan: null,
    });
    cleanups.push(async () => { await listener.close(); ha.close(); });
    const code = newSetupCode();
    ha.installLaunchCode(code);
    const setup = await post(listener.port, 'setup', {
      setupCode: formatSetupCode(code), username: 'NovaHost', password: `${randomBytes(12).toString('base64url')}-Aa7`, preset: 'home', serverName: 'Den', accountsMode: 'email',
    });
    expect(setup.status, setup.text).toBe(200);
    const token = setup.json.token as string;
    seed(svc);
    const port = listener.port;

    const file = await post(port, 'log/export', { format: 'csv' }, token);
    expect(file.status, file.text).toBe(200);
    expect(file.headers['x-row-count']).toBe('3');
    expect(String(file.headers['content-disposition'])).toMatch(/^attachment; filename="voidswarm-chat-log-.*\.csv"$/);
    expect(file.text).not.toContain('the words they typed');
    const typed = await post(port, 'log/export', { includeOriginal: true, includeWellbeing: true, player: 'NovaPilot' }, token);
    expect(typed.status).toBe(200);
    expect(typed.headers['x-row-count']).toBe('2');
    expect(typed.text).toContain('the words they typed');
    expect((await post(port, 'log/export', { format: 'xml' }, token)).status).toBe(400);
    const saved = await post(port, 'log/export', { saveOnHost: true, all: true }, token);
    expect(saved.json).toMatchObject({ ok: true, rows: 3 });

    // the log reads, in the worker: no original text in a page or the context; reveals and context views audited
    const page = await post(port, 'log', { limit: 10 }, token);
    expect(page.status, page.text).toBe(200);
    const lines = page.json.lines as { id: number; name: string; shown: string; display: string }[];
    expect(lines.map((l) => l.shown)).toEqual(['nice shot', '', 'GG, pilots!', '+cmd|calc']); // newest first; the wellbeing line (host PC) included
    expect(page.text).not.toContain('the words they typed');
    expect(page.text).not.toContain('a private sad line');
    expect(page.json.nextBefore).toBeNull();
    expect((await post(port, 'log', { action: 'nonsense' }, token)).status).toBe(400);
    const found = await post(port, 'log', { q: 'words they typed' }, token); // the host may search the original text…
    expect((found.json.lines as unknown[]).length).toBe(1);
    expect(found.text).not.toContain('the words they typed'); // …but only a reveal shows it
    const substituted = lines.find((l) => l.display === 'substituted')!;
    const ctx = await post(port, 'log/context', { id: substituted.id, before: 5, after: 5 }, token);
    expect(ctx.status, ctx.text).toBe(200);
    expect(ctx.json).toMatchObject({ ok: true, scope: 'room' });
    expect((ctx.json.before as unknown[]).length).toBe(1);
    expect((ctx.json.after as unknown[]).length).toBe(2);
    expect(ctx.text).not.toContain('the words they typed');
    expect((await post(port, 'log/context', { id: 999_999 }, token)).status).toBe(404);
    const rooms = await post(port, 'log/rooms', { since: '7d' }, token);
    expect(rooms.status, rooms.text).toBe(200);
    expect((rooms.json.rooms as { roomUid: string; lines: number }[])[0]).toMatchObject({ roomUid: 'boot1:r2', lines: 4 });
    const reveal = await post(port, 'log/reveal', { ids: [substituted.id] }, token);
    expect(reveal.status, reveal.text).toBe(200);
    expect(reveal.json.originals).toEqual([{ id: substituted.id, original: 'the words they typed' }]);
    expect((await post(port, 'log/reveal', { ids: [] }, token)).status).toBe(400);
    const audit = svc.store.listActions({ limit: 20 }).actions.map((a) => [a.action as string, a.reason]);
    expect(audit).toEqual(expect.arrayContaining([
      ['view', `chat log context of line #${substituted.id}`], ['reveal', `revealed the original text of 1 chat line(s): #${substituted.id}`],
    ]));

    const stats = await post(port, 'log/stats', { fresh: true }, token);
    expect(stats.status, stats.text).toBe(200);
    expect(stats.json).toMatchObject({ ok: true, rows: 4, retention: { mode: 'days' } });

    const ask = await post(port, 'log/purge', { before: '2099-01-01' }, token);
    expect(ask.status).toBe(409);
    expect(ask.json).toMatchObject({ needsConfirm: true, rows: 4 });
    const go = await post(port, 'log/purge', { before: ask.json.before, confirmRows: 4 }, token);
    expect(go.status, go.text).toBe(200);
    expect(go.json).toMatchObject({ ok: true, deleted: 4 });
    expect((await post(port, 'log/purge', { before: 'soon' }, token)).status).toBe(400);

    svc.hook().alert!({ playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot', address: '10.0.0.5' }, 'selfharm');
    const list = await post(port, 'alerts/list', {}, token);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('NovaPilot');
    const alerts = list.json.alerts as { id: number; kind: string }[];
    expect(alerts[0]).toMatchObject({ kind: 'wellbeing' });
    expect(list.json.counts).toEqual({ urgent: 1, banner: 0, wellbeing: 1 });
    const ack = await post(port, 'alerts/ack', { id: alerts[0]!.id, note: 'spoke with them' }, token);
    expect(ack.status, ack.text).toBe(200);
    expect(ack.json.alert).toMatchObject({ acked: true });
    expect((await post(port, 'alerts/ack', { id: 424242 }, token)).status).toBe(404);
  });
});
