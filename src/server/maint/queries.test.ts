// OWNER: SERVER MODERATION (LAN task B8a). The chat log's read side (maint/queries.ts): the search planner (FTS5
// trigram, LIKE fallback, windowed partial pages = exact), SELF-HARM exclusion, the context drawer (T-ADM-6), rooms
// in a range, stats, the conduct tally, reveals, and every op through a real maintenance worker (stream included).
// Generated names only; school examples use caldwellschools.org.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { ChatLogEntry } from '../../shared/room/moderation';
import { nameKey } from '../../shared/room/util';
import { ModStore } from '../moderation/store';
import { MaintClient } from './client';
import { markIndexDirty } from './erase';
import {
  CONDUCT_MAX_KEYS, CONDUCT_MAX_TAGS, CONDUCT_REVIEW_PREFIX, chatContext, clearStatsCache, conductTagsOf, conductTally, conductTallyPage, eachChatLogPage, eachChatLogPageSync, firstIdAtOrAfter,
  FOLD_FN, foldText, FTS_MATCH_CHARS, ftsMergeSteps, ftsPhrase, idRangeOf, LEGACY_CONTEXT_MS, logQueryFrom, logStats, planOf, QUERY_OPS, revealOriginals,
  roomsInRange, searchChatLog, SHORT_TEXT_WINDOW_MS, STATS_CACHE_MS, textOf, TS_DISORDER_KEY, tsDisorderOf, type ChatLogRow, type LogQuery,
} from './queries';
import { MaintError } from './protocol';
import { addAccount, open, tmpData, type TmpData } from './testutil';
import { startQueryWorker } from './queries.testutil';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);

let t: TmpData;
let db: DatabaseSync;
let store: ModStore;

beforeEach(() => {
  t = tmpData('vs-queries-');
  store = new ModStore(t.db, { log: () => {} });
  db = open(t.db);
  addAccount(db, { id: 'acc-nova', username: 'NovaPilot' });
  addAccount(db, { id: 'acc-orion', username: 'OrionAce' });
});

afterEach(() => {
  try { store.close(); } catch { /* closed */ }
  try { db.close(); } catch { /* closed */ }
  clearStatsCache();
  t.cleanup();
});

let seq = 0;
/** One chat entry through the real store (tags, counters, FTS triggers). */
function put(e: Partial<ChatLogEntry> & { original: string }): number {
  const entry: ChatLogEntry = {
    time: e.time ?? T0 + (++seq) * 1000, roomId: e.roomId === undefined ? 'r1' : e.roomId, roomName: e.roomName ?? 'Flag Run',
    roomUid: e.roomUid === undefined ? 'bootA:r1' : e.roomUid, channel: e.channel ?? 'all', team: e.team ?? -1,
    playerId: e.playerId ?? 1, name: e.name ?? 'NovaPilot', accountId: e.accountId === undefined ? 'acc-nova' : e.accountId,
    address: e.address === undefined ? '10.0.0.5' : e.address, original: e.original, shown: e.shown ?? e.original,
    action: e.action ?? 'pass', hits: e.hits ?? [], display: e.display ?? 'as-typed',
  };
  store.logChat(entry);
  store.flushAll();
  return Number((db.prepare('SELECT max(id) AS m FROM chat_log').get() as { m: number }).m);
}

/** A row as a v0.5 server wrote it (no room_uid, no display, no tags). */
function putLegacy(c: { ts: number; roomId: string | null; original: string; name?: string; hits?: string[]; action?: string }): number {
  const r = db.prepare(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address, original, shown, action, hits)
                        VALUES (?, ?, ?, 'all', -1, 2, ?, ?, NULL, '10.0.0.9', ?, ?, ?, ?)`)
    .run(c.ts, c.roomId, c.roomId ?? 'Zone', c.name ?? 'Guest7', nameKey(c.name ?? 'Guest7'), c.original, c.original, c.action ?? 'pass', JSON.stringify(c.hits ?? []));
  return Number(r.lastInsertRowid);
}

const ids = (rows: ChatLogRow[]): number[] => rows.map((r) => r.id);

describe('conductTagsOf (the counters the store writes)', () => {
  it('counts enforced tags, review-only ones as review:TAG, never SELF-HARM, never an announcement, no PROFANITY in a name', () => {
    expect(conductTagsOf({ channel: 'all', hits: ['profanity:x', 'slur:y'] })).toEqual(['PROFANITY', 'HATE']);
    // a wellbeing line counts for nothing, not even the other words in it (§5.11; the Zone gives it no strike)
    expect(conductTagsOf({ channel: 'team', hits: ['selfharm:x', 'threat:y'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'all', hits: ['profanity:y', 'selfharm:x'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'all', hits: ['custom:selfharm:x', 'slur:y'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'name', hits: ['slur:y', 'selfharm:x'] })).toEqual([]);
    // withheld as one (e.g. a muted line whose self-harm hit fell past the 20 labels kept): nothing either
    expect(conductTagsOf({ channel: 'all', hits: ['profanity:y'], display: 'withheld' })).toEqual([]);
    // a review-only (unconfirmed) self-harm term on a line shown as typed: the line's other words still count
    expect(conductTagsOf({ channel: 'all', hits: ['flag:selfharm:x', 'profanity:y'], display: 'substituted' })).toEqual(['PROFANITY']);
    expect(conductTagsOf({ channel: 'all', hits: ['flag:selfharm:x'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'all', hits: ['threat:y'], display: 'substituted' })).toEqual(['THREAT']);
    expect(conductTagsOf({ channel: 'all', hits: ['flag:gang:x'] })).toEqual([`${CONDUCT_REVIEW_PREFIX}GANG`]);
    expect(conductTagsOf({ channel: 'all', hits: ['custom:gang:x', 'flag:gang:y'] })).toEqual(['GANG']);
    expect(conductTagsOf({ channel: 'all', hits: ['custom:bullying:x'] })).toEqual(['BULLYING']);
    expect(conductTagsOf({ channel: 'name', hits: ['profanity:x'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'room', hits: ['profanity:x', 'sexual:y'] })).toEqual(['VULGAR']);
    expect(conductTagsOf({ channel: 'announce', hits: ['profanity:x'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'all', hits: ['filter-error'] })).toEqual([]);
    expect(conductTagsOf({ channel: 'all', hits: [] })).toEqual([]);
  });
});

describe('searchChatLog', () => {
  it('text of 3+ characters goes through the FTS5 trigram index: a case-insensitive substring of original or shown', () => {
    const a = put({ original: 'What a Nice Shot, pilot!' });
    put({ original: 'going left' });
    const c = put({ original: 'zorblax zorblax', shown: 'GG, pilots!', action: 'block', hits: ['profanity:zorblax'], display: 'substituted' });
    expect(planOf({ q: 'nice' })).toBe('fts');
    expect(ids(searchChatLog(db, { q: 'NICE SHOT' }).lines)).toEqual([a]);
    expect(ids(searchChatLog(db, { q: 'ice sh' }).lines)).toEqual([a]);
    expect(ids(searchChatLog(db, { q: 'pilot' }).lines)).toEqual([c, a]);
    // the host searches what they typed too; a moderator (searchIn 'shown') only what the others saw
    expect(ids(searchChatLog(db, { q: 'zorbl' }).lines)).toEqual([c]);
    expect(ids(searchChatLog(db, { q: 'zorbl', searchIn: 'shown' }).lines)).toEqual([]);
    expect(ids(searchChatLog(db, { q: 'gg, pil', searchIn: 'shown' }).lines)).toEqual([c]);
    // quotes are literal
    const q = put({ original: 'he said "hold the flag" loudly' });
    expect(ids(searchChatLog(db, { q: '"hold the' }).lines)).toEqual([q]);
    expect(ftsPhrase('a"b', 'shown')).toBe('shown : "a""b"');
  });

  it('1-2 characters use LIKE over at most 7 days, on every plan (the whole log, a person, a room, a tag; §5.5)', async () => {
    const now = T0 + 30 * DAY;
    const tagged = { action: 'mask' as const, hits: ['profanity:x'], display: 'substituted' as const };
    const old = put({ original: 'ok go', time: now - 8 * DAY, ...tagged });
    const recent = put({ original: 'ok then', time: now - DAY, ...tagged });
    const page = searchChatLog(db, { q: 'ok' }, { now });
    expect(page.plan).toBe('scan');
    expect(ids(page.lines)).toEqual([recent]);
    expect(page.shortTextSince).toBe(now - SHORT_TEXT_WINDOW_MS);
    const scoped: LogQuery[] = [{ accountId: 'acc-nova' }, { player: 'NovaPilot' }, { address: '10.0.0.5' }, { roomUid: 'bootA:r1' }, { tag: 'PROFANITY' }];
    for (const s of scoped) {
      for (const opts of [{ now }, { now, maxMs: 35 }, { now, maxMs: 1e-9, windowIds: 1 }]) {
        const got: number[] = [];
        let before: number | undefined;
        let beforeTs: number | undefined;
        let last;
        for (let k = 0; k < 50; k++) {
          last = searchChatLog(db, { ...s, q: 'ok', before, beforeTs }, opts);
          got.push(...ids(last.lines));
          if (last.nextBefore === null) break;
          before = last.nextBefore;
          beforeTs = last.nextBeforeTs ?? undefined;
        }
        const what = `${JSON.stringify(s)} ${JSON.stringify(opts)}`;
        expect(got, what).toEqual([recent]);
        expect(last!.shortTextSince, what).toBe(now - SHORT_TEXT_WINDOW_MS);
      }
      // an older week: the search's own end moves the floor; the export follows the same rule
      expect(ids(searchChatLog(db, { ...s, q: 'ok', until: now - 7 * DAY }, { now }).lines), JSON.stringify(s)).toEqual([old]);
      const exported: number[] = [];
      await eachChatLogPage(db, { ...s, q: 'ok' }, (rows) => { exported.push(...ids(rows)); }, { now });
      expect(exported, JSON.stringify(s)).toEqual([recent]);
      // 3+ characters have no floor
      expect(ids(searchChatLog(db, { ...s, q: 'ok ' }, { now }).lines), JSON.stringify(s)).toEqual([recent, old]);
    }
  });

  it('a 1-2 character search in an older range looks back 7 days from the range\'s own end (not from now)', () => {
    const now = T0 + 60 * DAY;
    const periodStart = T0 + 20 * DAY + 8 * 60 * MIN;
    put({ original: 'ok much earlier', time: periodStart - 9 * DAY });
    const weekBefore = put({ original: 'ok earlier', time: periodStart - 6 * DAY });
    const inPeriod = put({ original: 'ok on it', time: periodStart + 10 * MIN });
    put({ original: 'ok later', time: periodStart + 2 * DAY });
    const q: LogQuery = { q: 'ok', since: periodStart, until: periodStart + 50 * MIN };
    for (const opts of [{ now }, { now, maxMs: 35 }, { now, maxMs: 1e-9, windowIds: 1 }]) {
      const got: number[] = [];
      let before: number | undefined;
      let page;
      for (let k = 0; k < 100; k++) {
        page = searchChatLog(db, { ...q, before }, opts);
        got.push(...ids(page.lines));
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }
      expect(got, JSON.stringify(opts)).toEqual([inPeriod]);
      expect(page!.shortTextSince).toBe(periodStart + 50 * MIN - SHORT_TEXT_WINDOW_MS);
    }
    // only an end: the 7 days before it
    expect(ids(searchChatLog(db, { q: 'ok', until: periodStart + 50 * MIN }, { now }).lines)).toEqual([inPeriod, weekBefore]);
    // an end past now counts from now
    expect(searchChatLog(db, { q: 'ok', until: now + 5 * DAY }, { now }).shortTextSince).toBe(now - SHORT_TEXT_WINDOW_MS);
    const exported: number[] = [];
    eachChatLogPageSync(db, q, (rows) => { exported.push(...ids(rows)); });
    expect(exported).toEqual([inPeriod]);
  });

  it('filters: person, room, channel (lobby), action, display, tag, dates, ranges', () => {
    const lobby = put({ original: 'hi all', roomId: null, roomUid: 'bootA:zone', roomName: 'Zone' });
    const team = put({ original: 'go left', channel: 'team', team: 1 });
    const masked = put({ original: 'darn it', shown: 'Nice moves!', action: 'mask', hits: ['mild:darn'], display: 'substituted' });
    const review = put({ original: 'meet at the spot', action: 'flag', hits: ['flag:gang:spot'], accountId: 'acc-orion', name: 'OrionAce' });
    const name = put({ original: 'Pilot_Ace', channel: 'name', action: 'pass', roomId: null, roomUid: 'bootA:zone', accountId: null, name: 'Guest12' });
    const room2 = put({ original: 'other room line', roomId: 'r2', roomUid: 'bootA:r2', roomName: 'Hot Point' });
    expect(ids(searchChatLog(db, { player: 'OrionAce' }).lines)).toEqual([review]);
    expect(ids(searchChatLog(db, { player: 'guest12' }).lines)).toEqual([name]);
    expect(ids(searchChatLog(db, { roomUid: 'bootA:r2' }).lines)).toEqual([room2]);
    expect(ids(searchChatLog(db, { channel: 'lobby' }).lines)).toEqual([lobby]);
    expect(ids(searchChatLog(db, { channel: 'team' }).lines)).toEqual([team]);
    expect(ids(searchChatLog(db, { action: 'flagged' }).lines)).toEqual([masked]);
    expect(ids(searchChatLog(db, { action: 'flag' }).lines)).toEqual([review]);
    expect(ids(searchChatLog(db, { display: ['substituted', 'system'] }).lines)).toEqual([masked]);
    expect(planOf({ tag: 'GANG' })).toBe('tag');
    expect(ids(searchChatLog(db, { tag: 'GANG' }).lines)).toEqual([review]);
    expect(ids(searchChatLog(db, { tag: 'PROFANITY', q: 'dar' }).lines)).toEqual([masked]);
    const tsOf = (id: number): number => Number((db.prepare('SELECT ts FROM chat_log WHERE id = ?').get(id) as { ts: number }).ts);
    expect(ids(searchChatLog(db, { since: tsOf(masked), until: tsOf(review) }).lines)).toEqual([review, masked]);
    expect(ids(searchChatLog(db, { ranges: [{ since: tsOf(lobby), until: tsOf(lobby) }, { since: tsOf(room2), until: tsOf(room2) + 5 }] }).lines))
      .toEqual([room2, lobby]);
    expect(searchChatLog(db, { ranges: [] }).lines).toEqual([]);
  });

  it('rows carry roomUid, display and tags; withOriginal false blanks what they typed and the hit labels', () => {
    const id = put({ original: 'zorblax', shown: 'GG, pilots!', action: 'block', hits: ['profanity:zorblax', 'flag:gang:x'], display: 'substituted' });
    const row = searchChatLog(db, {}).lines.find((r) => r.id === id)!;
    expect(row).toMatchObject({ roomUid: 'bootA:r1', display: 'substituted', tags: ['PROFANITY', 'GANG'], original: 'zorblax' });
    const bare = searchChatLog(db, {}, { withOriginal: false }).lines.find((r) => r.id === id)!;
    expect(bare).toMatchObject({ original: '', hits: [], tags: ['PROFANITY', 'GANG'], shown: 'GG, pilots!' });
  });

  it('SELF-HARM lines are left out before paging unless includeSelfHarm (display, tags, pre-0.6 hit labels)', () => {
    const ok1 = put({ original: 'fine line one' });
    const withheld = put({ original: '(generated wellbeing line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' });
    const tagged = put({ original: '(generated review line)', action: 'flag', hits: ['flag:selfharm:y'] });
    const legacy = putLegacy({ ts: T0 + 500_000, roomId: 'r1', original: '(generated legacy line)', hits: ['selfharm:z'], action: 'block' });
    const custom = putLegacy({ ts: T0 + 600_000, roomId: 'r1', original: '(generated custom line)', hits: ['custom:selfharm:w'], action: 'block' });
    const lookalike = putLegacy({ ts: T0 + 700_000, roomId: 'r1', original: 'fine custom', hits: ['custom:notselfharm:v'], action: 'block' });
    const ok2 = put({ original: 'fine line two' });
    const all = ids(searchChatLog(db, {}).lines);
    expect(all).toEqual(expect.arrayContaining([withheld, tagged, legacy, custom]));
    const safe = searchChatLog(db, { includeSelfHarm: false, limit: 2 });
    expect(ids(safe.lines)).toEqual([ok2, lookalike]);
    expect(ids(searchChatLog(db, { includeSelfHarm: false, before: safe.nextBefore! }).lines)).toEqual([ok1]);
    // the worker's default is to leave them out
    expect(ids(searchChatLog(db, {}, { includeSelfHarmDefault: false }).lines)).toEqual([ok2, lookalike, ok1]);
    expect(ids(searchChatLog(db, { q: 'generated' }, { includeSelfHarmDefault: false }).lines)).toEqual([]);
  });

  it('exact paging (the store) and windowed partial paging (the worker) return the same rows', () => {
    let r = 7;
    const rnd = (): number => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    const words = ['nice', 'shot', 'left', 'right', 'flag', 'base', 'gg', 'team', 'ok', 'go'];
    for (let i = 0; i < 400; i++) {
      const w = [0, 1, 2].map(() => words[Math.floor(rnd() * words.length)]).join(' ');
      const tagged = rnd() < 0.1;
      put({
        original: w, time: T0 + i * MIN, roomId: `r${1 + (i % 3)}`, roomUid: `boot${i < 200 ? 'A' : 'B'}:r${1 + (i % 3)}`,
        channel: rnd() < 0.2 ? 'team' : 'all', accountId: rnd() < 0.5 ? 'acc-nova' : null, name: rnd() < 0.5 ? 'NovaPilot' : 'Guest3',
        action: tagged ? 'mask' : 'pass', hits: tagged ? ['profanity:x'] : [], display: tagged ? 'substituted' : 'as-typed',
      });
    }
    const queries: LogQuery[] = [
      {}, { q: 'nice' }, { q: 'shot left' }, { q: 'go' }, { roomUid: 'bootA:r2' }, { roomUid: 'bootB:r1', q: 'flag' }, { tag: 'PROFANITY' },
      { channel: 'team', q: 'gg' }, { action: 'flagged' }, { since: T0 + 50 * MIN, until: T0 + 250 * MIN, q: 'base' },
      { player: 'Guest3', q: 'left' }, { until: T0 + 100 * MIN }, { since: T0 + 390 * MIN }, { q: 'nothing here' },
      // a callsign that is also an account username: both indexes, merged
      { player: 'NovaPilot' }, { player: 'NovaPilot', q: 'shot', channel: 'all' }, { accountId: 'acc-nova', tag: 'PROFANITY' },
      { address: '10.0.0.5', q: 'left' }, { tag: 'PROFANITY', since: T0 + 100 * MIN, until: T0 + 300 * MIN },
      { player: 'NovaPilot', since: T0 + 20 * MIN, until: T0 + 200 * MIN },
      // longer than FTS_MATCH_CHARS: matched on its first characters, the rest checked per line
      { q: 'nice shot left' }, { q: 'left right flag' }, { tag: 'PROFANITY', channel: 'team' }, { q: 'shot', channel: 'team', action: 'mask' },
    ];
    const now = T0 + 400 * MIN;
    const partialsOf = new Map<string, number>();
    for (const q of queries) {
      const exact: number[] = [];
      let before: number | undefined;
      for (let k = 0; k < 500; k++) {
        const p = searchChatLog(db, { ...q, limit: 7, before }, { now });
        exact.push(...ids(p.lines));
        if (p.nextBefore === null) break;
        before = p.nextBefore;
      }
      const windowed: number[] = [];
      before = undefined;
      let partials = 0;
      for (let k = 0; k < 5000; k++) {
        const p = searchChatLog(db, { ...q, limit: 7, before }, { now, maxMs: 1e-9, windowIds: 13 });
        if (p.partial) partials++;
        if (!p.partial) expect(p.lines.length === 7 || p.nextBefore === null, JSON.stringify(q)).toBe(true);
        windowed.push(...ids(p.lines));
        if (p.nextBefore === null) break;
        before = p.nextBefore;
      }
      expect(windowed, JSON.stringify(q)).toEqual(exact);
      expect(new Set(exact).size).toBe(exact.length);
      partialsOf.set(JSON.stringify(q), partials);
    }
    // a selective search comes back in partial pages (each call scans one small window / a few text matches) on every
    // plan: whole log (LIKE), room, person, tag, text; a text nobody typed ends at once
    for (const q of [{ q: 'go' }, { roomUid: 'bootB:r1', q: 'flag' }, { player: 'Guest3', q: 'left' }, { tag: 'PROFANITY', channel: 'team' }, { q: 'shot', channel: 'team', action: 'mask' }] as LogQuery[]) {
      expect(partialsOf.get(JSON.stringify(q)), JSON.stringify(q)).toBeGreaterThan(0);
    }
    expect(partialsOf.get(JSON.stringify({ q: 'nothing here' }))).toBe(0);
    // the long texts found exactly the lines that contain them
    expect('nice shot left'.length).toBeGreaterThan(FTS_MATCH_CHARS);
    const all = db.prepare('SELECT id, original, shown FROM chat_log ORDER BY id DESC').all() as { id: number; original: string; shown: string }[];
    for (const text of ['nice shot left', 'left right flag']) {
      const want = all.filter((r) => r.original.includes(text) || r.shown.includes(text)).map((r) => Number(r.id));
      expect(ids(searchChatLog(db, { q: text, limit: 1000 }).lines), text).toEqual(want);
      expect(ids(searchChatLog(db, { q: text.toUpperCase(), limit: 1000 }, { maxMs: 35 }).lines), text).toEqual(want);
    }
  });

  it('date-bounded windowed searches and log.rooms stay exact when the host clock went back (mod_meta.ts_disorder)', () => {
    let r = 11;
    const rnd = (): number => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    const words = ['nice', 'shot', 'left', 'gg', 'flag', 'ok', 'go', 'base'];
    let ts = T0;
    for (let i = 0; i < 500; i++) {
      // the host clock: a minute a line, with ~6% jumps of 30-90 minutes back or forward
      const jump = rnd() < 0.06 ? (rnd() < 0.5 ? -1 : 1) * (30 + Math.floor(rnd() * 60)) * MIN : 0;
      ts += MIN + jump;
      const lobby = rnd() < 0.2;
      const tagged = rnd() < 0.1;
      put({
        original: [0, 1, 2].map(() => words[Math.floor(rnd() * words.length)]).join(' '), time: ts,
        roomId: lobby ? null : `r${1 + (i % 3)}`, roomUid: lobby ? 'bootC:zone' : `bootC:r${1 + (i % 3)}`, channel: rnd() < 0.2 ? 'team' : 'all',
        action: tagged ? 'mask' : 'pass', hits: tagged ? ['profanity:x'] : [], display: tagged ? 'substituted' : 'as-typed',
      });
    }
    const d = tsDisorderOf(db)!;
    expect(d).toBeGreaterThan(30 * MIN);
    const all = (db.prepare('SELECT id, ts, original, shown, channel, room_uid FROM chat_log ORDER BY id DESC').all() as
      { id: number; ts: number; original: string; shown: string; channel: string; room_uid: string | null }[])
      .map((x) => ({ ...x, id: Number(x.id), ts: Number(x.ts) }));
    const inRange = (x: { ts: number }, q: LogQuery): boolean => (q.since === undefined || x.ts >= q.since) && (q.until === undefined || x.ts <= q.until);
    const now = ts + DAY;
    const lo = Math.min(...all.map((x) => x.ts));
    const hi = Math.max(...all.map((x) => x.ts));
    const cuts = [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => Math.floor(lo + f * (hi - lo)));
    const queries: [LogQuery, (x: (typeof all)[number]) => boolean][] = [];
    for (const c of cuts) {
      queries.push([{ until: c }, () => true], [{ since: c }, () => true], [{ since: c - 90 * MIN, until: c + 90 * MIN }, () => true]);
      queries.push([{ since: c - 3 * 60 * MIN, until: c, q: 'go' }, (x) => x.original.includes('go') || x.shown.includes('go')]);
      queries.push([{ since: c - 5 * 60 * MIN, until: c + 60 * MIN, q: 'nice sh' }, (x) => /nice sh/.test(x.original) || /nice sh/.test(x.shown)]);
      queries.push([{ roomUid: 'bootC:r2', since: c - 4 * 60 * MIN, until: c }, (x) => x.room_uid === 'bootC:r2']);
      queries.push([{ channel: 'team', since: c }, (x) => x.channel === 'team']);
    }
    const walk = (q: LogQuery, opts: Parameters<typeof searchChatLog>[2]): number[] => {
      const got: number[] = [];
      let before: number | undefined;
      for (let k = 0; k < 5000; k++) {
        const p = searchChatLog(db, { ...q, limit: 9, before }, opts);
        got.push(...ids(p.lines));
        if (p.nextBefore === null) break;
        before = p.nextBefore;
      }
      return got;
    };
    const check = (): void => {
      for (const [q, match] of queries) {
        const want = all.filter((x) => inRange(x, q) && match(x) && (q.q !== 'go' || x.ts >= Math.min(q.until ?? now, now) - SHORT_TEXT_WINDOW_MS)).map((x) => x.id);
        expect(walk(q, { now }), `exact ${JSON.stringify(q)}`).toEqual(want);
        expect(walk(q, { now, maxMs: 35 }), `worker ${JSON.stringify(q)}`).toEqual(want);
        expect(walk(q, { now, maxMs: 1e-9, windowIds: 17 }), `windows ${JSON.stringify(q)}`).toEqual(want);
      }
      for (const c of cuts) {
        const a = { since: c - 4 * 60 * MIN, until: c };
        const want = new Map<string, number>();
        for (const x of all) if (inRange(x, a)) want.set(String(x.room_uid), (want.get(String(x.room_uid)) ?? 0) + 1);
        const got = new Map(roomsInRange(db, a).map((room) => [String(room.roomUid), room.lines]));
        expect(got, JSON.stringify(a)).toEqual(want);
      }
    };
    check();
    // the id range really is widened by the disorder (with 0 it would miss lines), and an unmeasured database takes
    // the whole log, still exact
    const range = idRangeOf(db, cuts[1]!, cuts[3]!)!;
    const inside = all.filter((x) => x.ts >= cuts[1]! && x.ts <= cuts[3]!).map((x) => x.id);
    expect(Math.min(...inside)).toBeGreaterThanOrEqual(range.lo);
    expect(Math.max(...inside)).toBeLessThan(range.hi);
    const plainHi = firstIdAtOrAfter(db, cuts[3]! + 1);
    expect(plainHi === null || Math.max(...inside) >= plainHi).toBe(true);
    // with the disorder understated (0: plain time-order bounds), windowed date searches would miss lines
    db.prepare('UPDATE mod_meta SET v = 0 WHERE k = ?').run(TS_DISORDER_KEY);
    const short = queries.filter(([q]) => walk(q, { now, maxMs: 1e-9, windowIds: 17 }).length !== walk(q, { now }).length);
    expect(short.length).toBeGreaterThan(0);
    db.prepare('DELETE FROM mod_meta WHERE k = ?').run(TS_DISORDER_KEY);
    expect(idRangeOf(db, cuts[1]!, cuts[3]!)).toEqual({ lo: Math.min(...all.map((x) => x.id)), hi: Math.max(...all.map((x) => x.id)) + 1 });
    check();
  });

  it('a text longer than FTS_MATCH_CHARS is checked whole on each candidate, folded like the index (Unicode case)', () => {
    const a = put({ original: 'Crème BRÛLÉE for the whole team', shown: 'GG, pilots!' });
    const b = put({ original: 'crème brûlée for the whole tea' });
    const c = put({ original: 'nope', shown: 'CRÈME BRÛLÉE FOR THE WHOLE TEAM' });
    put({ original: 'crème brûlée for the WHOLE', shown: 'x' });
    expect(foldText('ÉCLAIR Straße')).toBe('éclair straße');
    for (const opts of [{}, { maxMs: 35 }]) {
      expect(ids(searchChatLog(db, { q: 'crème brûlée for the whole team' }, opts).lines)).toEqual([c, a]);
      expect(ids(searchChatLog(db, { q: 'CRÈME BRÛLÉE FOR THE WHOLE TEA' }, opts).lines)).toEqual([c, b, a]);
      expect(ids(searchChatLog(db, { q: 'crème brûlée for the whole team', searchIn: 'shown' }, opts).lines)).toEqual([c]);
    }
  });

  it('text folds exactly as the index folds on every plan: a person\'s, room\'s or tag\'s lines and 1-2 characters too', async () => {
    // FTS5 folds some letters JavaScript's toLowerCase leaves (µ → μ, ſ → s, ς → σ); foldText is the index's own folding
    expect(foldText('ÉCLAIR µ ſ ς Σ K')).toBe('éclair μ s σ σ k');
    const tagged = { action: 'mask' as const, hits: ['profanity:x'], display: 'substituted' as const };
    const eclair = put({ original: 'ÉCLAIR attack', ...tagged });
    const greek = put({ original: 'the ΜΙΚΡΟΣ laser', ...tagged });
    const kelvin = put({ original: 'KILL the zone', ...tagged });
    const longS = put({ original: 'maſs ſtrike on the flag', ...tagged });
    const micro = put({ original: 'a µ-drone', ...tagged });
    put({ original: 'plain eclair, no accent', ...tagged });
    const odd = put({ original: '100% and x_y', shown: 'ok', ...tagged });
    put({ original: '10 pilots in a zy formation', ...tagged });
    const scopes: LogQuery[] = [{}, { accountId: 'acc-nova' }, { player: 'NovaPilot' }, { address: '10.0.0.5' }, { roomUid: 'bootA:r1' }, { tag: 'PROFANITY' }];
    const expected: [string, number[]][] = [
      ['éclair', [eclair]], ['ÉCLAIR', [eclair]], ['Éclair att', [eclair]],
      ['μικρος', [greek]], ['ΜΙΚΡΟΣ', [greek]], ['μικροσ', [greek]],
      ['kill', [kelvin]], ['KILL THE', [kelvin]],
      ['mass', [longS]], ['strike', [longS]],
      ['µ-dr', [micro]], ['μ-dr', [micro]],
      // 1-2 characters (LIKE's own plan): the same folding
      ['é', [eclair]], ['μι', [greek]], ['µ', [greek, micro]], // the micro sign folds to mu, as in ΜΙΚΡΟΣ
      // LIKE's wildcards are literal ('0%' and '_y' as wildcards would match the "10 pilots in a zy" line too)
      ['0%', [odd]], ['_y', [odd]], ['0% and x_', [odd]],
    ];
    for (const s of scopes) {
      for (const [text, want] of expected) {
        for (const opts of [{}, { maxMs: 35 }]) {
          const got = ids(searchChatLog(db, { ...s, q: text }, opts).lines);
          expect(got, `${JSON.stringify(s)} ${text} ${JSON.stringify(opts)}`).toEqual([...want].reverse());
        }
      }
      // the shown text only (a moderator) folds the same way; the export too
      expect(ids(searchChatLog(db, { ...s, q: 'éclair', searchIn: 'shown' }).lines), JSON.stringify(s)).toEqual([eclair]);
      const exported: number[] = [];
      await eachChatLogPage(db, { ...s, q: 'KILL' }, (rows) => { exported.push(...ids(rows)); });
      expect(exported, JSON.stringify(s)).toEqual([kelvin]);
    }
    // The fold function is direct-only: a view or a trigger can never call it, even on a connection that trusts the
    // schema (every Voidswarm connection has trusted_schema OFF on top: db/guard.ts).
    const raw = new DatabaseSync(t.db);
    try {
      expect(ids(searchChatLog(raw, { accountId: 'acc-nova', q: 'éclair' }).lines)).toEqual([eclair]);
      expect((raw.prepare(`SELECT ${FOLD_FN}('ÉCLAIR µ') AS f`).get() as { f: string }).f).toBe('éclair μ');
      // (a view in the database's own schema: a TEMP one is the application's own SQL, which SQLite allows)
      raw.exec(`CREATE VIEW folded AS SELECT ${FOLD_FN}(original) AS f FROM chat_log`);
      expect(() => raw.prepare('SELECT f FROM folded').all()).toThrow(/unsafe use/);
    } finally { raw.close(); }
  });

  it('person and tag searches page newest first by (ts, id), whatever order the lines were written in (clock jumps)', () => {
    // written in id order, but the PC's clock jumped back and forth: ts is not in id order
    const times = [10, 11, 3, 4, 12, 5, 13, 1, 14, 2, 15, 6].map((m) => T0 + m * MIN);
    const made = times.map((time, i) => put({
      original: `jump ${i}`, time, action: i % 3 ? 'pass' : 'mask', hits: i % 3 ? [] : ['profanity:x'],
      accountId: i % 4 === 0 ? null : 'acc-nova', name: 'NovaPilot', address: i % 2 ? '10.0.0.5' : '10.0.0.6',
    }));
    const tsOf = (id: number): number => times[made.indexOf(id)]!;
    const byKey = (list: number[]): number[] => [...list].sort((x, y) => tsOf(y) - tsOf(x) || y - x);
    const cases: [LogQuery, number[]][] = [
      [{ accountId: 'acc-nova' }, made.filter((_, i) => i % 4 !== 0)],
      [{ player: 'NovaPilot' }, made], // account lines + guest-era lines under the same callsign, merged
      [{ address: '10.0.0.5' }, made.filter((_, i) => i % 2 === 1)],
      [{ tag: 'PROFANITY' }, made.filter((_, i) => i % 3 === 0)],
      [{ player: 'NovaPilot', since: T0 + 4 * MIN, until: T0 + 12 * MIN }, made.filter((_, i) => times[i]! >= T0 + 4 * MIN && times[i]! <= T0 + 12 * MIN)],
    ];
    for (const [q, list] of cases) {
      const want = byKey(list);
      const walk = (opts: Parameters<typeof searchChatLog>[2], withTs: boolean): number[] => {
        const got: number[] = [];
        let before: number | undefined;
        let beforeTs: number | undefined;
        for (let k = 0; k < 200; k++) {
          const p = searchChatLog(db, { ...q, limit: 2, before, beforeTs }, opts);
          got.push(...ids(p.lines));
          if (p.nextBefore === null) break;
          expect(p.nextBeforeTs).not.toBeNull();
          before = p.nextBefore;
          beforeTs = withTs ? p.nextBeforeTs ?? undefined : undefined;
        }
        return got;
      };
      expect(walk({}, false), JSON.stringify(q)).toEqual(want);
      expect(walk({}, true), JSON.stringify(q)).toEqual(want);
      expect(walk({ maxMs: 1e-9, windowIds: 1 }, false), JSON.stringify(q)).toEqual(want);
      expect(walk({ maxMs: 1e-9, windowIds: 3 }, true), JSON.stringify(q)).toEqual(want);
    }
    // the export walks the same order, oldest first
    const out: number[] = [];
    eachChatLogPageSync(db, { player: 'NovaPilot' }, (rows) => { out.push(...ids(rows)); }, 2);
    expect(out).toEqual(byKey(made).reverse());
    // a cursor line purged between two calls: the next page continues from the nearest older line's time
    const page = searchChatLog(db, { accountId: 'acc-nova', limit: 3 });
    db.prepare('DELETE FROM chat_log WHERE id = ?').run(page.nextBefore);
    const rest = ids(searchChatLog(db, { accountId: 'acc-nova', before: page.nextBefore!, limit: 100 }).lines);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.some((id) => ids(page.lines).includes(id))).toBe(false);
  });

  it('control characters never reach the SQL (a NUL ended the FTS5 string); other odd text is literal', () => {
    const a = put({ original: 'abc def' });
    for (const q of ['\u0000abc', 'ab\u0000c', '\u0007abc\u007f']) {
      for (const searchIn of ['both', 'shown'] as const) {
        expect(ids(searchChatLog(db, logQueryFrom({ q, searchIn }), { maxMs: 35 }).lines), JSON.stringify(q)).toEqual([a]);
        expect(ids(searchChatLog(db, logQueryFrom({ q, searchIn })).lines)).toEqual([a]);
      }
    }
    expect(textOf({ q: '\u0000\u0001' })).toBeNull();
    for (const q of ['"', 'a"b"c', 'NEAR(a b)', 'a OR b', '*abc', '^abc', 'col:abc', '(abc', '\\%_', 'x'.repeat(300)]) {
      expect(() => searchChatLog(db, logQueryFrom({ q }), { maxMs: 35 }), q).not.toThrow();
    }
  });

  it('eachChatLogPage streams oldest first, and the export defaults leave out originals only when asked', async () => {
    const a = put({ original: 'one' });
    const b = put({ original: 'two words' });
    const pages: number[][] = [];
    const n = await eachChatLogPage(db, {}, (rows) => { pages.push(ids(rows)); }, { page: 1 });
    expect(n).toBe(2);
    expect(pages).toEqual([[a], [b]]);
    const rows: ChatLogRow[] = [];
    await eachChatLogPage(db, { q: 'wor' }, (r) => { rows.push(...r); }, { withOriginal: false });
    expect(rows.map((r) => [r.id, r.original])).toEqual([[b, '']]);
  });
});

describe('T-ADM-6: the context drawer', () => {
  it('uses the same room_uid: another room, and the same room id after a restart, are left out', () => {
    const lines: number[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(put({ original: `A1 line ${i}`, roomUid: 'bootA:r1', channel: i % 5 === 0 ? 'team' : 'all', team: i % 5 === 0 ? 2 : -1 }));
      put({ original: `A2 line ${i}`, roomId: 'r2', roomUid: 'bootA:r2', roomName: 'Hot Point' });
    }
    // the server restarted: room ids start again at r1, under a new boot id
    const after = put({ original: 'B1 first line', roomUid: 'bootB:r1' });
    const anchor = lines[15]!;
    const ctx = chatContext(db, { id: anchor });
    expect(ctx.scope).toBe('room');
    expect(ctx.anchor!.id).toBe(anchor);
    expect(ids(ctx.before)).toEqual(lines.slice(5, 15));
    expect(ids(ctx.after)).toEqual(lines.slice(16, 26));
    expect(ctx.moreBefore && ctx.moreAfter).toBe(true);
    expect(ctx.before.filter((r) => r.channel === 'team').map((r) => r.team)).toEqual([2, 2]);
    // "load 10 more" at the end: the room's last line, and never the next boot's r1
    const tail = chatContext(db, { id: lines[25]!, before: 0, after: 20 });
    expect(ids(tail.after)).toEqual(lines.slice(26));
    expect(tail.moreAfter).toBe(false);
    expect(ids(tail.after)).not.toContain(after);
    expect(chatContext(db, { id: anchor, before: 500, after: 0 }).before).toHaveLength(15); // capped at 50, 15 exist
  });

  it('lobby lines show lobby context; a zone-wide announcement shows the lobby around it', () => {
    const l1 = put({ original: 'lobby one', roomId: null, roomUid: 'bootA:zone', roomName: 'Zone' });
    put({ original: 'room line', roomUid: 'bootA:r1' });
    const l2 = put({ original: 'lobby two', roomId: null, roomUid: 'bootA:zone', roomName: 'Zone' });
    const ann = put({ original: 'Finish your match', shown: '[Host] Finish your match', channel: 'announce', roomId: null, roomUid: null, roomName: 'All rooms', accountId: null, name: 'Host' });
    const l3 = put({ original: 'lobby three', roomId: null, roomUid: 'bootA:zone', roomName: 'Zone' });
    const c = chatContext(db, { id: l2 });
    expect(c.scope).toBe('lobby');
    expect(ids(c.before)).toEqual([l1]);
    // the lobby saw the zone-wide announcement between its lines
    expect(ids(c.after)).toEqual([ann, l3]);
    const z = chatContext(db, { id: ann });
    expect(z.scope).toBe('zone');
    expect(ids(z.before)).toEqual([l1, l2]);
    expect(ids(z.after)).toEqual([l3]);
  });

  it('room context shows the zone-wide announcements inside the span shown (the room saw them), on top of the line counts', () => {
    const annOf = (text: string): number => put({ original: text, shown: `[Host] ${text}`, channel: 'announce', roomId: null, roomUid: null, roomName: 'All rooms', accountId: null, address: null, name: 'Host' });
    const early = annOf('Before the room opened');
    const r: number[] = [];
    for (let i = 0; i < 6; i++) r.push(put({ original: `room line ${i}`, roomUid: 'bootA:r1' }));
    const mid1 = annOf('Five minutes left');
    const toRoom = put({ original: 'Room only', shown: '[Host] Room only', channel: 'announce', roomUid: 'bootA:r1', accountId: null, address: null, name: 'Host' });
    const other = put({ original: 'another room', roomId: 'r2', roomUid: 'bootA:r2' });
    // a producer that left room_uid out (not an announcement): never shown as one
    put({ original: 'no room uid', roomUid: null });
    for (let i = 6; i < 12; i++) r.push(put({ original: `room line ${i}`, roomUid: 'bootA:r1' }));
    const mid2 = annOf('Two minutes left');
    r.push(put({ original: 'room line 12', roomUid: 'bootA:r1' }));
    const late = annOf('After the room closed');
    const ctx = chatContext(db, { id: r[6]!, before: 5, after: 5 });
    expect(ctx.scope).toBe('room');
    // five room lines (the room's own announcement is one of them) and the zone-wide one among them
    expect(ids(ctx.before)).toEqual([...r.slice(2, 6), mid1, toRoom]);
    expect(ids(ctx.after)).toEqual(r.slice(7, 12));
    expect(ctx.before.find((x) => x.id === mid1)).toMatchObject({ channel: 'announce', roomUid: null, shown: '[Host] Five minutes left' });
    expect(ctx.moreBefore && ctx.moreAfter).toBe(true);
    const wide = chatContext(db, { id: r[6]!, before: 50, after: 50 });
    expect(ids(wide.after)).toEqual([...r.slice(7, 12), mid2, r[12]!]);
    expect(ids(wide.before)).toEqual([...r.slice(0, 6), mid1, toRoom]);
    for (const x of [early, late, other]) expect([...ids(wide.before), ...ids(wide.after)]).not.toContain(x);
    // the anchor at an edge: nothing past it on that side
    expect(ids(chatContext(db, { id: r[12]!, before: 1, after: 10 }).after)).toEqual([]);
    expect(ids(chatContext(db, { id: r[12]!, before: 1, after: 10 }).before)).toEqual([r[11]!, mid2]);
    expect(ids(chatContext(db, { id: r[5]!, before: 0, after: 1, withOriginal: false }).after)).toEqual([mid1, toRoom]);
    expect(chatContext(db, { id: r[5]!, before: 0, after: 1, withOriginal: false }).after[0]!.original).toBe('');
  });

  it('rows from before 0.6.0 fall back to the same room_id within ±10 minutes (lobby: no room)', () => {
    const base = T0 - 3 * 3600_000;
    const far = putLegacy({ ts: base - LEGACY_CONTEXT_MS - MIN, roomId: 'r1', original: 'too early' });
    const near1 = putLegacy({ ts: base - 9 * MIN, roomId: 'r1', original: 'before' });
    const other = putLegacy({ ts: base - 5 * MIN, roomId: 'r2', original: 'another room' });
    const lobby = putLegacy({ ts: base - 4 * MIN, roomId: null, original: 'legacy lobby' });
    const anchor = putLegacy({ ts: base, roomId: 'r1', original: 'anchor' });
    const near2 = putLegacy({ ts: base + 10 * MIN, roomId: 'r1', original: 'after' });
    const late = putLegacy({ ts: base + 11 * MIN, roomId: 'r1', original: 'too late' });
    // a 0.6 line in "r1" at the same time is another server run: not legacy context
    put({ original: 'new run r1', time: base + MIN, roomUid: 'bootC:r1' });
    const ctx = chatContext(db, { id: anchor });
    expect(ctx.scope).toBe('legacy');
    expect(ids(ctx.before)).toEqual([near1]);
    expect(ids(ctx.after)).toEqual([near2]);
    expect([far, other, late].some((x) => ids(ctx.before).includes(x) || ids(ctx.after).includes(x))).toBe(false);
    const lc = chatContext(db, { id: lobby });
    expect(lc.scope).toBe('legacy');
    expect(ids(lc.before)).toEqual([]);
    expect(ids(lc.after)).toEqual([]);
  });

  it('wellbeing lines: hidden (anchor and neighbours) unless includeSelfHarm; withOriginal false blanks', () => {
    const a = put({ original: 'one' });
    const wb = put({ original: '(generated wellbeing line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' });
    const c = put({ original: 'three' });
    expect(chatContext(db, { id: wb }).anchor).toBeNull();
    expect(chatContext(db, { id: wb, includeSelfHarm: true }).anchor!.id).toBe(wb);
    expect(ids(chatContext(db, { id: c }).before)).toEqual([a]);
    expect(ids(chatContext(db, { id: c, includeSelfHarm: true }).before)).toEqual([a, wb]);
    const bare = chatContext(db, { id: c, withOriginal: false });
    expect(bare.anchor!.original).toBe('');
    expect(bare.before[0]!.original).toBe('');
    expect(chatContext(db, { id: 999_999 }).anchor).toBeNull();
  });
});

describe('rooms, stats, conduct, reveal', () => {
  it('log.rooms lists every room with lines in the range (closed rooms too), newest first, with its latest name', () => {
    put({ original: 'a', time: T0, roomUid: 'bootA:r1', roomName: 'Flag Run' });
    put({ original: 'b', time: T0 + 10 * MIN, roomUid: 'bootA:r1', roomName: 'Flag Run 2' });
    put({ original: 'c', time: T0 + 20 * MIN, roomId: null, roomUid: 'bootA:zone', roomName: 'Zone' });
    put({ original: 'd', time: T0 + 30 * MIN, roomUid: 'bootB:r1', roomName: 'Rift' });
    put({ original: 'e', time: T0 + 31 * MIN, channel: 'announce', roomId: null, roomUid: null, roomName: 'All rooms', accountId: null, name: 'Host' });
    putLegacy({ ts: T0 - DAY, roomId: 'r4', original: 'legacy' });
    const all = roomsInRange(db);
    expect(all.map((r) => [r.roomUid, r.name, r.lines, r.lobby, r.legacy])).toEqual([
      ['bootB:r1', 'Rift', 1, false, false],
      ['bootA:zone', 'Zone', 1, true, false],
      ['bootA:r1', 'Flag Run 2', 2, false, false],
      [null, 'r4', 1, false, true],
    ]);
    expect(all[2]).toMatchObject({ roomId: 'r1', firstTs: T0, lastTs: T0 + 10 * MIN });
    expect(roomsInRange(db, { since: T0 + 5 * MIN, until: T0 + 25 * MIN }).map((r) => r.roomUid)).toEqual(['bootA:zone', 'bootA:r1']);
    expect(roomsInRange(db, { since: T0 + 5 * MIN, until: T0 + 25 * MIN })[1]!.lines).toBe(1);
    expect(roomsInRange(db, { since: T0 + 100 * DAY })).toEqual([]);
    expect(roomsInRange(db, { limit: 1 })).toHaveLength(1);
  });

  it('log.stats: rows, range, local days, the index-tidy flag; cached 5 minutes', () => {
    const tz = 300; // UTC-5
    const day0 = Date.UTC(2026, 8, 20, 5, 0, 0); // local midnight
    put({ original: 'a', time: day0 + 3600_000 });
    put({ original: 'b', time: day0 + 23 * 3600_000 });
    put({ original: 'c', time: day0 + 25 * 3600_000 });
    const now = day0 + 2 * DAY;
    const s = logStats(db, t.db, { tzOffsetMin: tz, now, days: 5 });
    expect(s).toMatchObject({ rows: 3, oldest: day0 + 3600_000, newest: day0 + 25 * 3600_000, cached: false, indexTidyPending: false });
    expect(s.perDay.map((d) => [d.start, d.n])).toEqual([[day0, 2], [day0 + DAY, 1]]);
    expect(s.dbBytes).toBeGreaterThan(0);
    put({ original: 'd', time: day0 + 26 * 3600_000 });
    markIndexDirty(db, 3);
    expect(logStats(db, t.db, { tzOffsetMin: tz, now: now + MIN, days: 5 })).toMatchObject({ rows: 3, cached: true });
    expect(logStats(db, t.db, { tzOffsetMin: tz, now: now + MIN, days: 5, fresh: true })).toMatchObject({ rows: 4, cached: false, indexTidyPending: true, indexDirtyRows: 3 });
    expect(logStats(db, t.db, { tzOffsetMin: tz, now: now + MIN + STATS_CACHE_MS, days: 5 }).cached).toBe(false);
  });

  it('conduct.tally sums conduct_daily per student and tag over named day ranges', () => {
    const d0 = Math.floor(T0 / DAY);
    put({ original: 'x', time: T0 - 10 * DAY, action: 'mask', hits: ['profanity:x'] });
    put({ original: 'x', time: T0 - DAY, action: 'mask', hits: ['profanity:x', 'slur:y'] });
    put({ original: 'x', time: T0, action: 'mask', hits: ['profanity:x'] });
    put({ original: 'x', time: T0, action: 'flag', hits: ['flag:gang:z'], accountId: null, name: 'Guest9' });
    put({ original: 'x', time: T0, action: 'block', hits: ['selfharm:w'], display: 'withheld' });
    // a wellbeing line with a swear word in it counts for nothing (§5.11)
    put({ original: 'x', time: T0, action: 'block', hits: ['selfharm:w', 'profanity:x'], display: 'withheld' });
    const rows = conductTally(db, { ranges: { today: { sinceDay: d0 }, week: { sinceDay: d0 - 6 }, all: {} } });
    const by = (k: string, tag: string) => rows.find((r) => r.accountKey === k && r.tag === tag)?.counts;
    expect(by('acc-nova', 'PROFANITY')).toEqual({ today: 1, week: 2, all: 3 });
    expect(by('acc-nova', 'HATE')).toEqual({ today: 0, week: 1, all: 1 });
    expect(by('g:guest9', 'review:GANG')).toEqual({ today: 1, week: 1, all: 1 });
    expect(rows.some((r) => r.tag === 'SELF-HARM')).toBe(false);
    expect(conductTally(db, { ranges: { all: {} }, accountKeys: ['g:guest9'] }).map((r) => r.tag)).toEqual(['review:GANG']);
    expect(() => conductTally(db, { ranges: {} })).toThrow(MaintError);
  });

  it('conduct.tally says when its row cap cut rows (never a silent truncation), and refuses too many keys or tags', () => {
    const ins = db.prepare('INSERT INTO conduct_daily (account_key, day, tag, n) VALUES (?, ?, ?, ?)');
    const d0 = Math.floor(T0 / DAY);
    db.exec('BEGIN');
    for (let i = 0; i < 30; i++) ins.run(`acc-${String(i).padStart(2, '0')}`, d0 - i, 'PROFANITY', 1 + i);
    db.exec('COMMIT');
    const all = conductTallyPage(db, { ranges: { all: {} } });
    expect(all).toMatchObject({ truncated: false });
    expect(all.rows).toHaveLength(30);
    const cut = conductTallyPage(db, { ranges: { all: {} }, limit: 10 });
    expect(cut.truncated).toBe(true);
    // most recent first: the ten students seen last
    expect(cut.rows.map((r) => r.accountKey)).toEqual(all.rows.slice(0, 10).map((r) => r.accountKey));
    expect(cut.rows[0]).toMatchObject({ accountKey: 'acc-00', lastDay: d0, counts: { all: 1 } });
    expect(conductTallyPage(db, { ranges: { all: {} }, limit: 30 }).truncated).toBe(false);
    expect(conductTally(db, { ranges: { all: {} }, limit: 10 })).toEqual(cut.rows);
    expect(() => conductTally(db, { ranges: { all: {} }, accountKeys: Array.from({ length: CONDUCT_MAX_KEYS + 1 }, (_, i) => `acc-${i}`) })).toThrow(/at most/);
    expect(() => conductTally(db, { ranges: { all: {} }, tags: Array.from({ length: CONDUCT_MAX_TAGS + 1 }, (_, i) => `T${i}`) })).toThrow(/at most/);
    expect(conductTally(db, { ranges: { all: {} }, accountKeys: Array.from({ length: CONDUCT_MAX_KEYS }, (_, i) => `acc-${String(i).padStart(2, '0')}`) })).toHaveLength(30);
  });

  it('log.reveal: originals by id (at most 100) or one account in a range; wellbeing lines only when asked', () => {
    const a = put({ original: 'typed one', shown: 'GG, pilots!', action: 'block', hits: ['profanity:x'], display: 'substituted' });
    const wb = put({ original: '(generated wellbeing line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' });
    const o = put({ original: 'orion line', accountId: 'acc-orion', name: 'OrionAce' });
    expect(revealOriginals(db, { ids: [a, wb, o, 1.5 as number] }).originals.map((x) => x.id)).toEqual([o, a]);
    expect(revealOriginals(db, { ids: [wb], includeSelfHarm: true }).originals).toEqual([{ id: wb, original: '(generated wellbeing line)' }]);
    expect(revealOriginals(db, { accountId: 'acc-nova' }).originals).toEqual([{ id: a, original: 'typed one' }]);
    const p = revealOriginals(db, { accountId: 'acc-nova', includeSelfHarm: true, limit: 1 });
    expect(p.originals.map((x) => x.id)).toEqual([wb]);
    expect(revealOriginals(db, { accountId: 'acc-nova', includeSelfHarm: true, before: p.nextBefore! }).originals.map((x) => x.id)).toEqual([a]);
    expect(() => revealOriginals(db, {})).toThrow(MaintError);
  });

  it('firstIdAtOrAfter / logQueryFrom validate and map worker arguments', () => {
    const a = put({ original: 'x', time: T0 });
    expect(firstIdAtOrAfter(db, T0)).toBe(a);
    expect(firstIdAtOrAfter(db, T0 + 1)).toBeNull();
    expect(logQueryFrom({ q: 'nice', channel: 'lobby', display: 'substituted', ranges: [{ since: 1, until: 2 }], includeSelfHarm: true, junk: 1 }))
      .toMatchObject({ q: 'nice', channel: 'lobby', display: ['substituted'], ranges: [{ since: 1, until: 2 }], includeSelfHarm: true });
    expect(() => logQueryFrom({ action: 'nope' })).toThrow(/action must be/);
    expect(() => logQueryFrom({ channel: 'whisper' })).toThrow(/channel must be/);
    expect(() => logQueryFrom({ since: 'yesterday' })).toThrow(/since must be a number/);
    expect(() => logQueryFrom({ ranges: [{ since: 1 }] })).toThrow(/needs since and until/);
    expect(() => logQueryFrom({ searchIn: 'original' })).toThrow(/searchIn/);
    expect(Object.keys(QUERY_OPS).sort()).toEqual(['conduct.tally', 'fts.merge', 'log.context', 'log.export', 'log.reveal', 'log.rooms', 'log.search', 'log.stats', 'wal.checkpoint']);
  });
});

describe('FTS merges in the worker (the game connection with automerge off)', () => {
  it('ftsMergeSteps merges the segments 1-line commits leave, in bounded steps, until nothing is left; searches are unchanged', () => {
    const segments = (): number => Number((db.prepare('SELECT count(DISTINCT segid) AS n FROM chat_fts_idx').get() as { n: number }).n);
    const w = new ModStore(t.db, { log: () => {}, txRows: 1, ftsMerge: 'worker', ftsTunable: true });
    try {
      for (let i = 0; i < 300; i++) w.logChat({
        time: T0 + i * 1000, roomId: 'r1', roomName: 'Flag Run', roomUid: 'bootA:r1', channel: 'all', team: -1, playerId: 1, name: 'NovaPilot',
        accountId: 'acc-nova', address: '10.0.0.5', original: `line ${i} ${i % 7 ? 'go left' : 'nice shot'}`, shown: `line ${i}`, action: 'pass', hits: [], display: 'as-typed',
      });
      w.flushAll();
    } finally { w.close(); }
    // automerge off: every 1-line commit left its own segment (up to crisismerge)
    const grown = segments();
    expect(grown).toBeGreaterThan(40);
    const hits = ids(searchChatLog(db, { q: 'nice shot', limit: 1000 }).lines);
    expect(hits).toHaveLength(43);
    const one = ftsMergeSteps(db, { pages: 4, maxSteps: 1 })!;
    expect(one).toMatchObject({ steps: 1, pending: true });
    let r = ftsMergeSteps(db, { maxMs: 1000 })!;
    for (let k = 0; k < 20 && r.pending; k++) r = ftsMergeSteps(db, { maxMs: 1000 })!;
    expect(r.pending).toBe(false);
    expect(segments()).toBeLessThan(grown / 4);
    expect(ids(searchChatLog(db, { q: 'nice shot', limit: 1000 }).lines)).toEqual(hits);
    // nothing to merge: one step that finds nothing
    expect(ftsMergeSteps(db)).toMatchObject({ steps: 1, pending: false });
  });

  it('the worker merges in wal.checkpoint (the per-second upkeep) unless merge: false, and on its own with fts.merge', async () => {
    const w = new ModStore(t.db, { log: () => {}, txRows: 1, ftsMerge: 'worker', ftsTunable: true });
    for (let i = 0; i < 120; i++) put({ original: `upkeep line ${i}`, time: T0 + i * 1000 });
    w.close();
    const c: MaintClient = await startQueryWorker(t);
    try {
      expect(await c.call('wal.checkpoint', { merge: false })).toMatchObject({ mode: 'passive', merge: null });
      const up = await c.call<{ merge: { steps: number; pending: boolean } }>('wal.checkpoint', { mode: 'passive', mergeMs: 1000 });
      expect(up.merge.steps).toBeGreaterThan(1);
      expect(await c.call('fts.merge', { maxMs: 1000 })).toMatchObject({ pending: false });
      await expect(c.call('fts.merge', { pages: 'many' })).rejects.toMatchObject({ code: 'EARGS' });
    } finally {
      await c.close();
    }
  });
});

describe('the ops in a real maintenance worker', () => {
  it('log.search / context / rooms / stats / reveal / conduct.tally / wal.checkpoint answer, and log.export streams pages', async () => {
    const lines: number[] = [];
    for (let i = 0; i < 2500; i++) lines.push(put({ original: i % 10 === 0 ? `nice shot ${i}` : `line ${i}`, time: T0 + i * 1000 }));
    const wb = put({ original: '(generated wellbeing line)', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld', time: T0 + 2600_000 });
    const c: MaintClient = await startQueryWorker(t);
    try {
      const page = await c.call<{ lines: ChatLogRow[]; nextBefore: number | null; plan: string }>('log.search', { q: 'nice shot', limit: 5 });
      expect(page.plan).toBe('fts');
      expect(ids(page.lines)).toEqual([lines[2490]!, lines[2480]!, lines[2470]!, lines[2460]!, lines[2450]!]);
      expect(page.nextBefore).toBe(lines[2450]);
      // default: no wellbeing line; with includeSelfHarm the host's view
      expect(ids((await c.call<{ lines: ChatLogRow[] }>('log.search', { limit: 1 })).lines)).toEqual([lines[2499]!]);
      expect(ids((await c.call<{ lines: ChatLogRow[] }>('log.search', { limit: 1, includeSelfHarm: true })).lines)).toEqual([wb]);
      // closed by default: no original text or hit labels, the shown text only; the caller opts in
      expect((await c.call<{ lines: ChatLogRow[] }>('log.search', { limit: 1 })).lines[0]!.original).toBe('');
      expect((await c.call<{ lines: ChatLogRow[] }>('log.search', { limit: 1, withOriginal: true })).lines[0]!.original).toBe('line 2499');
      const hidden = put({ original: 'typed zorblax', shown: 'GG, pilots!', action: 'mask', display: 'substituted', time: T0 + 2700_000 });
      expect(ids((await c.call<{ lines: ChatLogRow[] }>('log.search', { q: 'zorblax' })).lines)).toEqual([]);
      const both = await c.call<{ lines: ChatLogRow[] }>('log.search', { q: 'zorblax', searchIn: 'both' });
      expect(both.lines.map((r) => [r.id, r.original, r.hits])).toEqual([[hidden, '', []]]);
      expect((await c.call<{ lines: ChatLogRow[] }>('log.search', { q: 'zorblax', searchIn: 'both', withOriginal: true })).lines[0]!.original).toBe('typed zorblax');
      expect((await c.call<{ anchor: ChatLogRow }>('log.context', { id: hidden })).anchor.original).toBe('');
      expect((await c.call<{ anchor: ChatLogRow }>('log.context', { id: hidden, withOriginal: true })).anchor.original).toBe('typed zorblax');
      const exported: ChatLogRow[] = [];
      for await (const rows of c.stream<ChatLogRow>('log.export', { q: 'zorblax' })) exported.push(...rows);
      expect(exported).toEqual([]);
      db.prepare('DELETE FROM chat_log WHERE id = ?').run(hidden);
      const ctx = await c.call<{ before: ChatLogRow[]; after: ChatLogRow[] }>('log.context', { id: lines[100], before: 2, after: 1, withOriginal: true });
      expect([...ids(ctx.before), ...ids(ctx.after)]).toEqual([lines[98], lines[99], lines[101]]);
      expect((await c.call<{ rooms: unknown[] }>('log.rooms', {})).rooms).toHaveLength(1);
      expect(await c.call('log.stats', { fresh: true })).toMatchObject({ rows: 2501 });
      expect((await c.call<{ originals: unknown[] }>('log.reveal', { ids: [lines[0], wb] })).originals).toEqual([{ id: lines[0], original: 'nice shot 0' }]);
      expect(await c.call('conduct.tally', { ranges: { all: {} } })).toEqual({ rows: [], truncated: false });
      expect(await c.call('wal.checkpoint', { mode: 'passive' })).toMatchObject({ mode: 'passive', merge: { steps: expect.any(Number) } });
      await expect(c.call('log.search', { action: 'nope' })).rejects.toMatchObject({ code: 'EARGS' });
      await expect(c.call('log.context', {})).rejects.toMatchObject({ code: 'EARGS' });
      // the export stream: oldest first, pages of 1000, no originals unless asked, no wellbeing line by default
      const s = c.stream<ChatLogRow>('log.export', {});
      const sizes: number[] = [];
      const got: ChatLogRow[] = [];
      for await (const rows of s) { sizes.push(rows.length); got.push(...rows); }
      expect(sizes).toEqual([1000, 1000, 500]);
      expect(ids(got)).toEqual(lines);
      expect(got.every((r) => r.original === '')).toBe(true);
      expect(await s.result).toEqual({ rows: 2500 });
      const withText: ChatLogRow[] = [];
      for await (const rows of c.stream<ChatLogRow>('log.export', { q: 'nice shot', includeOriginal: true, includeSelfHarm: true, pageSize: 100 })) withText.push(...rows);
      expect(withText.map((r) => r.original)).toEqual(lines.filter((_, i) => i % 10 === 0).map((_, k) => `nice shot ${k * 10}`));
    } finally {
      await c.close();
    }
  }, 60_000);
});
